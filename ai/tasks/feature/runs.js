#!/usr/bin/env node
'use strict';
/*
 * State store and transition gate for the feature workflow.
 * Normal execution uses controlled phase/role transitions. `set` and `set-role`
 * remain debug/admin-only compatibility commands.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { validateAttestation } = require('./evidence-attestation');
const { validateArtifactFile, sidecarForMarkdown } = require('../../workflow/artifacts');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const ACTIVE = path.join(RUNS, '_active');
const WORKFLOW_FILE = path.join(ROOT, 'ai', 'workflows', 'feature.yaml');
const RUNTIME_VERSION_FILE = path.join(ROOT, 'ai', 'runtime-version.json');
const WORKFLOW = yaml.load(fs.readFileSync(WORKFLOW_FILE, 'utf8')) || {};
const STAGES = WORKFLOW.stages || [];
const PHASES = STAGES.map(s => s.id);
const STAGE_BY_ID = new Map(STAGES.map(s => [s.id, s]));
const ROLE_GROUPS = STAGES.filter(s => s.strategy === 'parallel').map(s => s.id);
const STATUSES = ['pending', 'in_progress', 'pass', 'fail', 'blocked', 'skipped'];
const TERMINAL_OK = new Set(['pass', 'skipped']);
const TERMINAL_ROLE_STATUSES = new Set(['pass', 'fail', 'blocked', 'skipped']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ICONS = { pass: '✓', fail: '✗', blocked: '⛔', skipped: '~', in_progress: '▸', pending: '·' };

const [cmd, ...rest] = process.argv.slice(2);
const usage = () => {
  console.error('usage: runs.js start <id> | status [id] | begin|complete|fail|block|skip <phase> [executor] [reason] | select-roles <analysis|reviews> <role...> | role-begin|role-complete|role-fail|role-block|role-skip <group> <role> [executor] [reason] | evidence <required|not-required> [reason] | conditional <phase> <role> <pass|fail|blocked|skipped> [reason] | reconcile [id] | approve [id] | close [id] | set/set-role (admin only) | selftest');
  process.exit(1);
};

const now = () => new Date().toISOString();
const safeId = id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id || '');
const safeRole = role => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(role || '');
const activeId = () => { try { const id = fs.readFileSync(ACTIVE, 'utf8').trim(); return id && fs.existsSync(path.join(RUNS, id)) ? id : null; } catch { return null; } };
const resolveId = explicit => explicit || process.env.FEATURE_RUN_ID || activeId();
const stateFile = id => path.join(RUNS, id, 'state.json');
const load = id => { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { return null; } };
const phaseStatus = (state, phase) => state.phases?.[phase]?.status || 'pending';
const deviceDir = id => path.join(RUNS, id, 'device');
const screenshotDir = id => path.join(deviceDir(id), 'screenshots');
const deviceManifest = id => path.join(deviceDir(id), 'mobile-device-qc.md');
const evidenceFile = id => path.join(deviceDir(id), 'evidence.json');

function runtimeMetadata() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_VERSION_FILE, 'utf8')); }
  catch { return { runtimeVersion: null, workflowFormatVersion: WORKFLOW.version || null, artifactSchemaVersion: null }; }
}

function atomicSave(id, state) {
  state.updatedAt = now();
  const file = stateFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temp, file);
}

function ensureShape(state, id) {
  const meta = runtimeMetadata();
  const value = state || {
    id,
    status: 'active',
    startedAt: now(),
    runtime: {
      runtimeVersion: meta.runtimeVersion,
      workflowFormatVersion: meta.workflowFormatVersion,
      artifactSchemaVersion: meta.artifactSchemaVersion,
    },
  };
  value.phases ||= {};
  value.roles ||= {};
  value.selectedRoles ||= {};
  value.conditionals ||= {};
  value.history ||= [];
  value.evidence ||= {};
  value.evidence.mobileScreenshots ||= { requirement: 'unclassified' };
  value.runtime ||= {
    runtimeVersion: meta.runtimeVersion,
    workflowFormatVersion: meta.workflowFormatVersion,
    artifactSchemaVersion: meta.artifactSchemaVersion,
  };
  return value;
}

function actor() {
  if (process.env.AI_WORKFLOW_ACTOR) return process.env.AI_WORKFLOW_ACTOR;
  if (process.env.AI_WORKFLOW_ENGINE === '1') return 'workflow-engine';
  return 'human-or-cli';
}

function record(state, entry) {
  state.history ||= [];
  state.history.push({ at: now(), actor: actor(), attemptId: process.env.AI_WORKFLOW_ATTEMPT_ID || null, ...entry });
  if (state.history.length > 1000) state.history = state.history.slice(-1000);
}

function stage(phase) {
  const value = STAGE_BY_ID.get(phase);
  if (!value) throw new Error(`unknown phase "${phase}" — one of: ${PHASES.join(', ')}`);
  return value;
}

function dependencyProblems(phase, state) {
  const s = stage(phase);
  return (s.needs || [])
    .filter(dep => !TERMINAL_OK.has(phaseStatus(state, dep)))
    .map(dep => `${dep}=${phaseStatus(state, dep)}`);
}

function selectedRoleNames(state, group) {
  const explicit = state.selectedRoles?.[group];
  if (Array.isArray(explicit) && explicit.length) return explicit;
  return Object.keys(state.roles?.[group] || {});
}

function deriveRoleGroupStatus(state, group, { allowLegacy = false } = {}) {
  const explicit = Array.isArray(state.selectedRoles?.[group]) && state.selectedRoles[group].length > 0;
  if (!explicit && !allowLegacy) return null;
  const names = selectedRoleNames(state, group);
  if (!names.length) return null;
  const statuses = names.map(role => state.roles?.[group]?.[role]?.status || 'pending');
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.some(status => status === 'pending' || status === 'in_progress')) return 'in_progress';
  if (statuses.every(status => status === 'skipped')) return 'skipped';
  if (statuses.every(status => status === 'pass' || status === 'skipped')) return 'pass';
  return 'in_progress';
}

function downstreamStarted(state, phase) {
  const index = PHASES.indexOf(phase);
  return PHASES.slice(index + 1).some(next => phaseStatus(state, next) !== 'pending');
}

function setDerivedPhase(state, phase, status, note) {
  const current = state.phases?.[phase] || {};
  if (current.status === status) return false;
  const previous = current.status || 'pending';
  state.phases[phase] = { ...current, status, updatedAt: now(), ...(note ? { reconciliationNote: note } : {}) };
  record(state, { kind: 'phase', phase, from: previous, to: status, derived: true, reason: note || null });
  return true;
}

function reconcileState(id, state) {
  let changed = false;
  const approvalMarker = id && fs.existsSync(path.join(RUNS, id, 'plan.approved'));
  if (approvalMarker && phaseStatus(state, 'approval') !== 'pass') {
    changed = setDerivedPhase(state, 'approval', 'pass', 'plan.approved marker is authoritative') || changed;
  }
  for (const group of ROLE_GROUPS) {
    const hasExplicitSelection = Array.isArray(state.selectedRoles?.[group]) && state.selectedRoles[group].length > 0;
    const tracked = Object.values(state.roles?.[group] || {});
    const legacyCanClose = !hasExplicitSelection && tracked.length > 0 && tracked.every(entry => TERMINAL_ROLE_STATUSES.has(entry.status)) && downstreamStarted(state, group);
    const derived = deriveRoleGroupStatus(state, group, { allowLegacy: legacyCanClose });
    if (derived) changed = setDerivedPhase(state, group, derived, hasExplicitSelection ? 'derived from selected role states' : 'reconciled legacy role states') || changed;
  }
  return changed;
}

function screenshotFiles(id) {
  try { return fs.readdirSync(screenshotDir(id)).filter(name => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())).sort(); }
  catch { return []; }
}

function gitHead() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return res.status === 0 ? String(res.stdout).trim() : null;
}

function mobileEvidenceSummary(id, state) {
  const evidence = state.evidence?.mobileScreenshots || { requirement: 'unclassified' };
  return {
    requirement: evidence.requirement || 'unclassified',
    reason: evidence.reason || null,
    screenshotCount: screenshotFiles(id).length,
    manifest: fs.existsSync(deviceManifest(id)),
    attestation: fs.existsSync(evidenceFile(id)),
    execution: evidence.execution || null,
    platforms: evidence.platforms || evidence.execution?.platforms || [],
  };
}

function verificationEvidenceProblem(id, state, options = {}) {
  if (options.evalMode || process.env.AI_EVAL === '1') return null;
  const evidence = mobileEvidenceSummary(id, state);
  if (evidence.requirement === 'unclassified') return 'mobile screenshot evidence is unclassified — classify it as required or not-required';
  if (evidence.requirement === 'not-required') {
    if (!evidence.reason) return 'mobile screenshot evidence is not-required but no reason is recorded';
    return null;
  }
  if (evidence.requirement !== 'required') return `unknown mobile evidence requirement: ${evidence.requirement}`;
  if (!evidence.execution || evidence.execution.status !== 'pass') return `mobile evidence execution is ${evidence.execution?.status || 'missing'}; current Appium attempt must pass`;
  if (!evidence.execution.attemptId) return 'mobile evidence execution has no attemptId';
  const platforms = evidence.execution.platforms || evidence.platforms || [];
  if (!Array.isArray(platforms) || !platforms.length) return 'mobile evidence execution has no required platforms';
  if (evidence.screenshotCount < 1) return `mobile screenshot evidence is required but ai/runs/${id}/device/screenshots/ contains no screenshots`;
  if (!evidence.manifest) return `mobile screenshot evidence is required but ai/runs/${id}/device/mobile-device-qc.md is missing`;
  if (!evidence.attestation) return `mobile screenshot evidence is required but ai/runs/${id}/device/evidence.json is missing`;
  const attestationErrors = validateAttestation(evidenceFile(id), {
    runId: id,
    attemptId: evidence.execution.attemptId,
    platforms,
    gitSha: gitHead(),
  });
  if (attestationErrors.length) return `mobile evidence attestation invalid: ${attestationErrors.join('; ')}`;
  return null;
}

function structuredArtifactSpecForPhase(phase) {
  const s = stage(phase);
  const roleSpec = s.role ? WORKFLOW.roles?.[s.role] : null;
  const schema = s.artifact_schema || roleSpec?.artifact_schema || null;
  const artifact = s.artifact || roleSpec?.artifact || null;
  return schema && artifact ? { schema, artifact } : null;
}

function structuredArtifactSpecForRole(role) {
  const spec = WORKFLOW.roles?.[role];
  return spec?.artifact_schema && spec?.artifact ? { schema: spec.artifact_schema, artifact: spec.artifact } : null;
}

function phaseArtifactProblem(id, phase) {
  const spec = structuredArtifactSpecForPhase(phase);
  if (!spec) return null;
  const file = path.join(RUNS, id, sidecarForMarkdown(spec.artifact));
  const errors = validateArtifactFile(spec.schema, file, id);
  return errors.length ? `${phase} structured artifact invalid: ${errors.join('; ')}` : null;
}

function roleArtifactProblem(id, group, role) {
  const spec = structuredArtifactSpecForRole(role);
  if (!spec) return null;
  const file = path.join(RUNS, id, sidecarForMarkdown(spec.artifact));
  const errors = validateArtifactFile(spec.schema, file, id);
  return errors.length ? `${group}/${role} structured artifact invalid: ${errors.join('; ')}` : null;
}

function transitionProblem(state, phase, action, reason) {
  const s = stage(phase);
  const current = phaseStatus(state, phase);
  if (phase === 'approval') return 'approval is a human gate; use runs.js approve <id>';
  if (action === 'begin') {
    const deps = dependencyProblems(phase, state);
    if (deps.length) return `dependencies are incomplete: ${deps.join(', ')}`;
    if (!['pending', 'fail', 'blocked'].includes(current)) return `cannot begin ${phase} from ${current}`;
    return null;
  }
  if (action === 'complete') {
    if (current !== 'in_progress') return `cannot complete ${phase} from ${current}; begin it first`;
    if (s.strategy === 'parallel') {
      const derived = deriveRoleGroupStatus(state, phase);
      if (!['pass', 'skipped'].includes(derived)) return `${phase} selected roles are not complete (${derived || 'unselected'})`;
    }
    return null;
  }
  if (action === 'fail' || action === 'block') {
    if (current !== 'in_progress') return `cannot ${action} ${phase} from ${current}; begin it first`;
    if (!reason) return `${action} requires a reason`;
    return null;
  }
  if (action === 'skip') {
    const deps = dependencyProblems(phase, state);
    if (deps.length) return `dependencies are incomplete: ${deps.join(', ')}`;
    if (!['pending', 'in_progress'].includes(current)) return `cannot skip ${phase} from ${current}`;
    if (!reason) return 'skip requires a reason';
    return null;
  }
  return `unsupported action ${action}`;
}

function transitionPhase(id, state, phase, action, executor, reason) {
  reconcileState(id, state);
  const problem = transitionProblem(state, phase, action, reason);
  if (problem) throw new Error(`${phase}: ${problem}`);
  const from = phaseStatus(state, phase);
  let to;
  if (action === 'begin') to = 'in_progress';
  else if (action === 'complete') to = 'pass';
  else if (action === 'fail') to = 'fail';
  else if (action === 'block') to = 'blocked';
  else to = 'skipped';
  if (to === 'pass') {
    const artifactProblem = phaseArtifactProblem(id, phase);
    if (artifactProblem) throw new Error(artifactProblem);
  }
  if (phase === 'verification' && to === 'pass') {
    const evidenceProblem = verificationEvidenceProblem(id, state);
    if (evidenceProblem) throw new Error(`verification cannot pass: ${evidenceProblem}`);
  }
  state.phases[phase] = {
    ...(state.phases[phase] || {}),
    status: to,
    updatedAt: now(),
    ...(executor && executor !== '-' ? { executor } : {}),
    ...(reason ? { note: reason } : {}),
  };
  record(state, { kind: 'phase', phase, action, from, to, executor: executor && executor !== '-' ? executor : null, reason: reason || null });
  reconcileState(id, state);
  return to;
}

function roleTransitionProblem(state, group, role, action, reason) {
  if (!ROLE_GROUPS.includes(group)) return `unknown role group ${group}`;
  const deps = dependencyProblems(group, state);
  if (deps.length) return `dependencies are incomplete: ${deps.join(', ')}`;
  const selected = state.selectedRoles?.[group] || [];
  if (!selected.includes(role)) return `role ${role} was not selected for ${group}`;
  const current = state.roles?.[group]?.[role]?.status || 'pending';
  if (action === 'begin' && !['pending', 'fail', 'blocked'].includes(current)) return `cannot begin from ${current}`;
  if (action === 'complete' && current !== 'in_progress') return `cannot complete from ${current}`;
  if ((action === 'fail' || action === 'block') && current !== 'in_progress') return `cannot ${action} from ${current}`;
  if ((action === 'fail' || action === 'block' || action === 'skip') && !reason) return `${action} requires a reason`;
  if (action === 'skip' && !['pending', 'in_progress'].includes(current)) return `cannot skip from ${current}`;
  return null;
}

function transitionRole(id, state, group, role, action, executor, reason) {
  const problem = roleTransitionProblem(state, group, role, action, reason);
  if (problem) throw new Error(`${group}/${role}: ${problem}`);
  if (action === 'complete') {
    const artifactProblem = roleArtifactProblem(id, group, role);
    if (artifactProblem) throw new Error(artifactProblem);
  }
  state.roles[group] ||= {};
  const from = state.roles[group][role]?.status || 'pending';
  const to = action === 'begin' ? 'in_progress' : action === 'complete' ? 'pass' : action === 'fail' ? 'fail' : action === 'block' ? 'blocked' : 'skipped';
  state.roles[group][role] = { ...(state.roles[group][role] || {}), status: to, updatedAt: now(), ...(executor && executor !== '-' ? { executor } : {}), ...(reason ? { note: reason } : {}) };
  record(state, { kind: 'role', group, role, action, from, to, executor: executor && executor !== '-' ? executor : null, reason: reason || null });
  reconcileState(id, state);
  return to;
}

function render(id, state) {
  reconcileState(id, state);
  console.log(`${id} — /feature run (${state.status})${fs.existsSync(path.join(RUNS, id, 'plan.approved')) ? ' · plan approved' : ' · plan NOT approved (edits outside ai/runs are denied)'}`);
  if (state.runtime?.runtimeVersion) console.log(`  runtime ${state.runtime.runtimeVersion} · workflow format ${state.runtime.workflowFormatVersion ?? '–'} · artifact schema ${state.runtime.artifactSchemaVersion ?? '–'}`);
  for (const phase of PHASES) {
    const entry = state.phases?.[phase] || { status: 'pending' };
    console.log(`  ${ICONS[entry.status] || '·'} ${phase.padEnd(19)} ${entry.status.padEnd(12)}${entry.note ? ` — ${entry.note}` : ''}`);
    for (const [role, roleState] of Object.entries(state.roles?.[phase] || {})) console.log(`      ${ICONS[roleState.status] || '·'} ${role.padEnd(18)} ${String(roleState.status).padEnd(12)}${roleState.executor ? ` · ${roleState.executor}` : ''}${roleState.note ? ` — ${roleState.note}` : ''}`);
  }
  const evidence = mobileEvidenceSummary(id, state);
  console.log(`\n  📸 mobile screenshots   ${evidence.requirement.padEnd(14)}${evidence.requirement === 'required' ? ` · ${evidence.screenshotCount} file(s) · execution ${evidence.execution?.status || 'missing'} · attestation ${evidence.attestation ? 'yes' : 'no'}` : evidence.reason ? ` · ${evidence.reason}` : ''}`);
  const next = PHASES.find(phase => !state.phases?.[phase] || ['pending', 'in_progress', 'fail', 'blocked'].includes(state.phases[phase].status));
  console.log(`\n→ resume at: ${next || 'done'}`);
}

function requireAdmin() {
  if (process.env.AI_WORKFLOW_ADMIN !== '1' && process.env.AI_EVAL !== '1') throw new Error('legacy set/set-role is debug/admin-only; use controlled begin/complete/fail/block/skip commands');
}

function selftest() {
  const base = ensureShape({ phases: { request: { status: 'pass' } }, roles: {}, selectedRoles: {} }, 'TEST');
  assert.deepStrictEqual(dependencyProblems('requirements', base), []);
  assert.deepStrictEqual(dependencyProblems('implementation', base), ['approval=pending']);
  assert.throws(() => transitionPhase('TEST', base, 'implementation', 'begin', 'codex', ''), /dependencies/);
  assert.strictEqual(transitionPhase('TEST', base, 'requirements', 'begin', 'claude', 'test'), 'in_progress');
  assert.strictEqual(transitionPhase('TEST', base, 'requirements', 'complete', 'claude', 'done'), 'pass');
  assert.throws(() => transitionPhase('TEST', base, 'requirements', 'complete', 'claude', ''), /cannot complete/);
  assert.ok(phaseArtifactProblem('MISSING-TEST', 'plan').includes('missing structured artifact'));
  assert.ok(roleArtifactProblem('MISSING-TEST', 'reviews', 'code-review').includes('missing structured artifact'));

  const selected = ensureShape({ phases: { inspection: { status: 'pass' }, analysis: { status: 'in_progress' } }, roles: {}, selectedRoles: { analysis: ['architect', 'security'] } }, 'TEST');
  selected.roles.analysis = { architect: { status: 'pass' }, security: { status: 'pending' } };
  assert.strictEqual(deriveRoleGroupStatus(selected, 'analysis'), 'in_progress');
  selected.roles.analysis.security.status = 'pass';
  assert.strictEqual(deriveRoleGroupStatus(selected, 'analysis'), 'pass');

  const evidence = ensureShape({}, 'TEST');
  assert.ok(verificationEvidenceProblem('TEST', evidence, { evalMode: false }).includes('unclassified'));
  evidence.evidence.mobileScreenshots = { requirement: 'not-required', reason: 'backend-only' };
  assert.strictEqual(verificationEvidenceProblem('TEST', evidence, { evalMode: false }), null);
  evidence.evidence.mobileScreenshots = { requirement: 'required', execution: { status: 'blocked', attemptId: 'x', platforms: ['android'] } };
  assert.ok(verificationEvidenceProblem('TEST', evidence, { evalMode: false }).includes('blocked'));
  assert.strictEqual(verificationEvidenceProblem('TEST', evidence, { evalMode: true }), null);
  console.log('runs.js selftest OK');
}

try {
  switch (cmd) {
    case 'start': {
      const id = rest[0];
      if (!safeId(id)) usage();
      fs.mkdirSync(path.join(RUNS, id, '05-analysis'), { recursive: true });
      fs.mkdirSync(path.join(RUNS, id, '09-reviews'), { recursive: true });
      fs.mkdirSync(screenshotDir(id), { recursive: true });
      let state = load(id);
      if (!state) { state = ensureShape(null, id); atomicSave(id, state); console.log(`created ai/runs/${id}/`); }
      else { state = ensureShape(state, id); if (reconcileState(id, state)) atomicSave(id, state); console.log(`ai/runs/${id}/ exists — resuming`); }
      fs.writeFileSync(ACTIVE, `${id}\n`);
      render(id, state);
      break;
    }
    case 'status': {
      const id = resolveId(rest[0]);
      if (!id) { console.log('no active /feature run'); break; }
      const state = load(id);
      if (!state) throw new Error(`no state for ${id}`);
      render(id, ensureShape(state, id));
      break;
    }
    case 'begin':
    case 'complete':
    case 'fail':
    case 'block':
    case 'skip': {
      const [phase, executor] = rest;
      const reason = rest.slice(2).join(' ');
      const id = resolveId();
      if (!id) throw new Error('no run id; start a run or set FEATURE_RUN_ID');
      const state = ensureShape(load(id), id);
      const to = transitionPhase(id, state, phase, cmd, executor || '-', reason);
      atomicSave(id, state);
      console.log(`${id} ${phase} → ${to}${reason ? ` (${reason})` : ''}`);
      break;
    }
    case 'select-roles': {
      const [group, ...roles] = rest;
      const id = resolveId();
      if (!id) throw new Error('no run id');
      if (!ROLE_GROUPS.includes(group)) throw new Error(`unknown role group "${group}" — one of: ${ROLE_GROUPS.join(', ')}`);
      if (!roles.length || roles.some(role => !safeRole(role))) throw new Error('select-roles requires valid role names');
      const state = ensureShape(load(id), id);
      const deps = dependencyProblems(group, state);
      if (deps.length) throw new Error(`${group}: dependencies are incomplete: ${deps.join(', ')}`);
      if (!['pending', 'in_progress', 'fail', 'blocked'].includes(phaseStatus(state, group))) throw new Error(`${group}: cannot select roles while phase is ${phaseStatus(state, group)}`);
      const unique = [...new Set(roles)];
      state.selectedRoles[group] = unique;
      state.roles[group] ||= {};
      for (const role of unique) state.roles[group][role] ||= { status: 'pending', updatedAt: now() };
      const from = phaseStatus(state, group);
      state.phases[group] = { ...(state.phases[group] || {}), status: 'in_progress', updatedAt: now() };
      record(state, { kind: 'phase', phase: group, action: 'begin', from, to: 'in_progress', reason: `selected roles: ${unique.join(', ')}` });
      atomicSave(id, state);
      console.log(`${id} ${group} selected roles → ${unique.join(', ')}`);
      break;
    }
    case 'role-begin':
    case 'role-complete':
    case 'role-fail':
    case 'role-block':
    case 'role-skip': {
      const [group, role, executor] = rest;
      const reason = rest.slice(3).join(' ');
      const action = cmd.replace('role-', '');
      const id = resolveId();
      if (!id) throw new Error('no run id');
      const state = ensureShape(load(id), id);
      const to = transitionRole(id, state, group, role, action, executor || '-', reason);
      atomicSave(id, state);
      console.log(`${id} ${group}/${role} → ${to}`);
      break;
    }
    case 'evidence': {
      const [requirement] = rest;
      const reason = rest.slice(1).join(' ');
      const id = resolveId();
      if (!id) throw new Error('no run id');
      if (!['required', 'not-required'].includes(requirement)) throw new Error('evidence requirement must be required or not-required');
      if (requirement === 'not-required' && !reason) throw new Error('not-required evidence classification needs a reason');
      const state = ensureShape(load(id), id);
      const previous = state.evidence.mobileScreenshots?.requirement || 'unclassified';
      state.evidence.mobileScreenshots = { requirement, updatedAt: now(), ...(reason ? { reason } : {}) };
      record(state, { kind: 'evidence', from: previous, to: requirement, reason: reason || null });
      fs.mkdirSync(screenshotDir(id), { recursive: true });
      atomicSave(id, state);
      console.log(`${id}: mobile screenshot evidence → ${requirement}${reason ? ` (${reason})` : ''}`);
      break;
    }
    case 'conditional': {
      const [phase, role, status] = rest;
      const reason = rest.slice(3).join(' ');
      const id = resolveId();
      if (!id) throw new Error('no run id');
      if (!safeRole(role) || !['pass', 'fail', 'blocked', 'skipped'].includes(status)) throw new Error('conditional requires <phase> <role> <pass|fail|blocked|skipped>');
      const state = ensureShape(load(id), id);
      state.conditionals[phase] ||= {};
      state.conditionals[phase][role] = { status, updatedAt: now(), ...(reason ? { reason } : {}) };
      record(state, { kind: 'conditional-role', phase, role, to: status, reason: reason || null });
      atomicSave(id, state);
      console.log(`${id} conditional ${phase}/${role} → ${status}`);
      break;
    }
    case 'reconcile': {
      const id = resolveId(rest[0]);
      if (!id || !safeId(id)) throw new Error('no valid run to reconcile');
      const state = ensureShape(load(id), id);
      const changed = reconcileState(id, state);
      if (changed) atomicSave(id, state);
      console.log(`${id}: ${changed ? 'state reconciled' : 'state already consistent'}`);
      render(id, state);
      break;
    }
    case 'approve': {
      const id = resolveId(rest[0]);
      if (!safeId(id) || !fs.existsSync(path.join(RUNS, id))) throw new Error('unknown run');
      const plan = path.join(RUNS, id, '06-plan.md');
      if (!fs.existsSync(plan) || fs.statSync(plan).size < 80) throw new Error(`ai/runs/${id}/06-plan.md is missing or empty — nothing to approve`);
      const planProblem = phaseArtifactProblem(id, 'plan');
      if (planProblem) throw new Error(`cannot approve plan: ${planProblem}`);
      const state = ensureShape(load(id), id);
      reconcileState(id, state);
      if (phaseStatus(state, 'plan') !== 'pass') throw new Error(`plan is ${phaseStatus(state, 'plan')} — the engine must complete the plan stage before approval`);
      if (!['pass', 'skipped'].includes(phaseStatus(state, 'analysis'))) throw new Error(`analysis is ${phaseStatus(state, 'analysis')} — complete selected analysis roles before approval`);
      const marker = path.join(RUNS, id, 'plan.approved');
      fs.writeFileSync(marker, `approved: ${now()}\n`);
      const from = phaseStatus(state, 'approval');
      state.phases.approval = { status: 'pass', updatedAt: now(), note: 'approved via runs.js' };
      record(state, { kind: 'phase', phase: 'approval', action: 'approve', from, to: 'pass', executor: 'human', reason: 'human plan approval' });
      atomicSave(id, state);
      console.log(`${id}: plan approved — approval → pass; edits outside ai/runs are allowed`);
      break;
    }
    case 'close': {
      const id = resolveId(rest[0]);
      if (!id) { console.log('no active run'); break; }
      const state = ensureShape(load(id), id);
      reconcileState(id, state);
      if (phaseStatus(state, 'verification') !== 'pass' && process.env.AI_WORKFLOW_ADMIN !== '1') throw new Error(`cannot close ${id}: verification=${phaseStatus(state, 'verification')}`);
      state.status = 'done';
      state.closedAt = now();
      record(state, { kind: 'run', action: 'close', to: 'done' });
      atomicSave(id, state);
      if (activeId() === id && fs.existsSync(ACTIVE)) fs.unlinkSync(ACTIVE);
      console.log(`${id}: closed`);
      break;
    }
    case 'set': {
      requireAdmin();
      const [phase, status] = rest;
      const note = rest.slice(2).join(' ');
      const id = resolveId();
      if (!id || !PHASES.includes(phase) || !STATUSES.includes(status)) usage();
      const state = ensureShape(load(id), id);
      const from = phaseStatus(state, phase);
      state.phases[phase] = { status, updatedAt: now(), ...(note ? { note } : {}) };
      record(state, { kind: 'admin-phase-set', phase, from, to: status, reason: note || null });
      atomicSave(id, state);
      console.log(`${id} ${phase} → ${status} (admin)`);
      break;
    }
    case 'set-role': {
      requireAdmin();
      const [group, role, status, executor] = rest;
      const note = rest.slice(4).join(' ');
      const id = resolveId();
      if (!id || !ROLE_GROUPS.includes(group) || !safeRole(role) || !STATUSES.includes(status)) usage();
      const state = ensureShape(load(id), id);
      state.roles[group] ||= {};
      const from = state.roles[group][role]?.status || 'pending';
      state.roles[group][role] = { status, updatedAt: now(), ...(executor && executor !== '-' ? { executor } : {}), ...(note ? { note } : {}) };
      record(state, { kind: 'admin-role-set', group, role, from, to: status, executor: executor || null, reason: note || null });
      reconcileState(id, state);
      atomicSave(id, state);
      console.log(`${id} ${group}/${role} → ${status} (admin)`);
      break;
    }
    case 'selftest': selftest(); break;
    default: usage();
  }
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}

module.exports = {
  ensureShape,
  dependencyProblems,
  transitionProblem,
  transitionPhase,
  roleTransitionProblem,
  transitionRole,
  deriveRoleGroupStatus,
  verificationEvidenceProblem,
  phaseArtifactProblem,
  roleArtifactProblem,
  reconcileState,
  atomicSave,
};
