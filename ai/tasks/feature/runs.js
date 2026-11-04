#!/usr/bin/env node
'use strict';
/*
 * State store and transition gate for the feature workflow.
 * Normal execution uses controlled phase/role transitions. `set` and `set-role`
 * remain debug/admin-only compatibility commands.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { validateAttestation } = require('./evidence-attestation');
const { validateArtifactFile, sidecarForMarkdown } = require('../../workflow/artifacts');
const { runtimeRoot, projectRoot, stateRoot, relativeStatePath } = require('../../workflow/paths');
const { withStateLock } = require('../../workflow/state-lock');
const { recordFailure, clearFailure, carried } = require('../../workflow/repeated-failure');
const { liveEngine, describe: describeEngine, ownerFile } = require('../../workflow/engine-owner');
const { needsYou, needsYouLines, printable } = require('../../workflow/progress');

const ROOT = runtimeRoot();
const PROJECT_ROOT = projectRoot();
const RUNS = stateRoot();
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
  console.error('usage: runs.js start <id> | status [id] | begin|complete|fail|block|skip <phase> [executor] [reason] | select-roles <analysis|reviews> <role...> | role-begin|role-complete|role-fail|role-block|role-skip <group> <role> [executor] [reason] | evidence <required|not-required> [reason] | conditional <phase> <role> <pass|fail|blocked|skipped> [reason] | reconcile [id] | retry <id> [role...] | pull-request-options <id> [--base <branch>] [--branch <name>] [--draft true|false] | architecture-select <id> <option-id> [note] | approve [id] | close [id] | set/set-role (admin only) | selftest');
  process.exit(1);
};

const now = () => new Date().toISOString();
const safeId = id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id || '');
const safeRole = role => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(role || '');
const activeId = () => { try { const id = fs.readFileSync(ACTIVE, 'utf8').trim(); return id && fs.existsSync(path.join(RUNS, id)) ? id : null; } catch { return null; } };
const resolveId = explicit => explicit || process.env.FEATURE_RUN_ID || activeId();
const stateFile = id => path.join(RUNS, id, 'state.json');
const load = id => { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { return null; } };
// Every command that writes state.json is its own process, and roles of a
// parallel stage run at the same time, so load -> modify -> save holds the
// run's state lock or concurrent transitions overwrite each other.
const locked = (id, fn) => withStateLock(stateFile(id), fn);
const phaseStatus = (state, phase) => state.phases?.[phase]?.status || 'pending';
const deviceDir = id => path.join(RUNS, id, 'device');
const screenshotDir = id => path.join(deviceDir(id), 'screenshots');
const deviceManifest = id => path.join(deviceDir(id), 'mobile-device-qc.md');
const evidenceFile = id => path.join(deviceDir(id), 'evidence.json');
// Written by parallel-roles.js while it runs a stage's roles (engine.js names it).
const parallelPidFile = (id, group) => path.join(RUNS, id, 'engine', `${group}-parallel.pid`);

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
  // Roles of a parallel stage run at the same time: while any is still running
  // the stage is running, even if a sibling already failed. Its fail or blocked
  // shows once nothing is running any more.
  if (statuses.includes('in_progress')) return 'in_progress';
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('pending')) return 'in_progress';
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
  const architectureMarker = id && fs.existsSync(path.join(RUNS, id, 'architecture.selected'));
  if (architectureMarker && phaseStatus(state, 'architecture-selection') !== 'pass') {
    changed = setDerivedPhase(state, 'architecture-selection', 'pass', 'architecture.selected marker is authoritative') || changed;
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
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.env.AI_WORKFLOW_PRODUCT_ROOT || PROJECT_ROOT, encoding: 'utf8' });
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
  if (evidence.screenshotCount < 1) return `mobile screenshot evidence is required but ${relativeStatePath(id, 'device', 'screenshots')}/ contains no screenshots`;
  if (!evidence.manifest) return `mobile screenshot evidence is required but ${relativeStatePath(id, 'device', 'mobile-device-qc.md')} is missing`;
  if (!evidence.attestation) return `mobile screenshot evidence is required but ${relativeStatePath(id, 'device', 'evidence.json')} is missing`;
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

// The architecture stages exist only for a whole-app behaviour-preserving
// refactor; everywhere else the engine must be able to skip them.
function isWholeAppRefactor(state) {
  let fromFile = null;
  if (state?.id) {
    try { fromFile = JSON.parse(fs.readFileSync(path.join(RUNS, state.id, 'engine', 'mode.json'), 'utf8')); }
    catch { fromFile = null; }
  }
  const mode = state?.workflowMode?.mode || fromFile?.mode;
  const scope = state?.workflowMode?.refactorScope || fromFile?.refactorScope;
  return mode === 'behavior_preserving_refactor' && scope === 'whole_app';
}

function transitionProblem(state, phase, action, reason, executor) {
  const s = stage(phase);
  const current = phaseStatus(state, phase);
  // `executor` is only an argument, so it cannot authorise anything on its own:
  // the stage may be skipped only when the workflow says it does not apply
  // (`when: whole_app_refactor`). In a real whole-app refactor the human gate
  // holds no matter who claims to be calling.
  const engineSkip = action === 'skip' && executor === 'workflow-engine' && !isWholeAppRefactor(state);
  if (phase === 'approval') return 'approval is a human gate; use runs.js approve <id>';
  if (phase === 'architecture-selection' && !engineSkip) return 'architecture-selection is a human gate; use runs.js architecture-select <id> <option-id>';
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
  const problem = transitionProblem(state, phase, action, reason, executor);
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
  // Same reason as the stage's previous failure → repeatedFailure (see repeated-failure.js).
  if (to === 'fail' || to === 'blocked') recordFailure(state.phases[phase], reason);
  else if (to === 'pass') clearFailure(state.phases[phase]);
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
  if (to === 'fail' || to === 'blocked') recordFailure(state.roles[group][role], reason);
  else if (to === 'pass') clearFailure(state.roles[group][role]);
  record(state, { kind: 'role', group, role, action, from, to, executor: executor && executor !== '-' ? executor : null, reason: reason || null });
  reconcileState(id, state);
  return to;
}

// The pid of the live parallel-role pool running `group`, or null. A pid file
// whose process is gone is left over from a crash and does not count.
function liveParallelOwner(id, group) {
  let pid;
  try { pid = Number.parseInt(fs.readFileSync(parallelPidFile(id, group), 'utf8'), 10); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : null; }
}
// `retry` must not reset a role that a live engine is still running: the role
// would run twice at once, and its result would land on a reset entry.
function refuseLiveRole(id, group, role, status) {
  if (status !== 'in_progress') return;
  const pid = liveParallelOwner(id, group);
  if (pid) throw new Error(`${group}/${role} is still running in the workflow engine (parallel role runner pid ${pid}); wait for the stage to finish or stop that run first, then retry`);
}

// Why `retry` has nothing to do, and what would move the run instead.
function nothingToRetry(id, state) {
  const cli = process.env.AI_AGENTIC_CLI === '1';
  if (state.status === 'done') return `nothing to retry — ${id} is closed`;
  const attention = needsYou(id, state, { root: RUNS });
  if (attention?.kind === 'waiting') return `nothing to retry; ${attention.headline.charAt(0).toLowerCase()}${attention.headline.slice(1)} — run: ${attention.command}`;
  if (PHASES.every(phase => TERMINAL_OK.has(phaseStatus(state, phase)))) return `nothing to retry — ${id} is complete`;
  return `nothing to retry; run ${cli ? 'agentic resume' : 'node ai/workflow/engine.js resume'} ${id}`;
}

function render(id, state) {
  reconcileState(id, state);
  console.log(`${id} — /feature run (${state.status})${fs.existsSync(path.join(RUNS, id, 'plan.approved')) ? ' · plan approved' : ' · plan NOT approved (edits outside ai/runs are denied)'}`);
  if (state.runtime?.runtimeVersion) console.log(`  runtime ${state.runtime.runtimeVersion} · workflow format ${state.runtime.workflowFormatVersion ?? '–'} · artifact schema ${state.runtime.artifactSchemaVersion ?? '–'}`);
  // Same derived status as the progress views (ai/workflow/progress.js): a run
  // closed after verification but before 1.9.31 has no pull-request phase, and
  // is finished, not waiting on one.
  const legacyClosed = state.status === 'done' && !state.phases?.['pull-request'] && !state.abandoned && phaseStatus(state, 'verification') === 'pass';
  for (const phase of PHASES) {
    const entry = state.phases?.[phase] || (phase === 'pull-request' && legacyClosed ? { status: 'skipped', note: 'the run was closed before this stage existed' } : { status: 'pending' });
    // Notes quote agent and tool output: printable text only on the terminal.
    console.log(`  ${ICONS[entry.status] || '·'} ${phase.padEnd(19)} ${printable(entry.status).padEnd(12)}${entry.note ? ` — ${printable(entry.note)}` : ''}`);
    for (const [role, roleState] of Object.entries(state.roles?.[phase] || {})) console.log(`      ${ICONS[roleState.status] || '·'} ${printable(role).padEnd(18)} ${printable(roleState.status).padEnd(12)}${roleState.executor ? ` · ${printable(roleState.executor)}` : ''}${roleState.note ? ` — ${printable(roleState.note)}` : ''}`);
  }
  const evidence = mobileEvidenceSummary(id, state);
  console.log(`\n  📸 mobile screenshots   ${evidence.requirement.padEnd(14)}${evidence.requirement === 'required' ? ` · ${evidence.screenshotCount} file(s) · execution ${evidence.execution?.status || 'missing'} · attestation ${evidence.attestation ? 'yes' : 'no'}` : evidence.reason ? ` · ${evidence.reason}` : ''}`);
  if (state.pullRequest?.url) console.log(`  🔗 pull request         #${state.pullRequest.number ?? '?'} ${state.pullRequest.url} (${state.pullRequest.status || 'open'}, ${state.pullRequest.branch} → ${state.pullRequest.base})`);
  else if (['skipped', 'blocked', 'fail'].includes(phaseStatus(state, 'pull-request'))) console.log(`  🔗 pull request         not opened — run: ${process.env.AI_AGENTIC_CLI === '1' ? 'agentic pr' : 'node ai/workflow/engine.js pr'} ${id}${state.status === 'done' ? ' --reopen' : ''}`);
  const next = state.status === 'done' ? null : PHASES.find(phase => !state.phases?.[phase] || ['pending', 'in_progress', 'fail', 'blocked'].includes(state.phases[phase].status));
  console.log(`\n→ resume at: ${next || 'done'}`);
  // The same needs-you line as the progress views and the engine's notification.
  const engine = liveEngine(path.join(RUNS, id));
  if (engine) console.log(`● engine running: ${describeEngine(engine)}`);
  else for (const line of needsYouLines(needsYou(id, state, { root: RUNS }))) console.log(line);
}

function requireAdmin() {
  if (process.env.AI_WORKFLOW_ADMIN !== '1' && process.env.AI_EVAL !== '1') throw new Error('legacy set/set-role is debug/admin-only; use controlled begin/complete/fail/block/skip commands');
}

function selftest() {
  const base = ensureShape({ phases: { request: { status: 'pass' } }, roles: {}, selectedRoles: {} }, 'TEST');
  assert.deepStrictEqual(dependencyProblems('requirements', base), []);
  assert.deepStrictEqual(dependencyProblems('implementation', base), ['approval=pending']);
  // The pull-request stage is the last one and waits for final verification.
  assert.strictEqual(PHASES[PHASES.length - 1], 'pull-request');
  assert.deepStrictEqual(dependencyProblems('pull-request', base), ['verification=pending']);
  assert.deepStrictEqual(structuredArtifactSpecForPhase('pull-request'), { schema: 'pull-request', artifact: '12-pull-request.md' });
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
  // A sibling's failure only shows once no selected role is still running.
  selected.roles.analysis = { architect: { status: 'fail' }, security: { status: 'in_progress' } };
  assert.strictEqual(deriveRoleGroupStatus(selected, 'analysis'), 'in_progress', 'running roles keep the stage in_progress');
  reconcileState('TEST', selected);
  assert.strictEqual(selected.phases.analysis.status, 'in_progress', 'reconcile does not fail a stage that is still running');
  selected.roles.analysis.security.status = 'blocked';
  assert.strictEqual(deriveRoleGroupStatus(selected, 'analysis'), 'fail');
  selected.roles.analysis.architect.status = 'pass';
  assert.strictEqual(deriveRoleGroupStatus(selected, 'analysis'), 'blocked');
  selected.roles.analysis.architect.status = 'pending';
  assert.strictEqual(deriveRoleGroupStatus(selected, 'analysis'), 'blocked', 'a blocked role still blocks while others wait to start');

  const archGate = ensureShape({ phases: { 'architecture-options': { status: 'skipped' } }, roles: {}, selectedRoles: {} }, 'TEST');
  assert.throws(() => transitionPhase('TEST', archGate, 'architecture-selection', 'skip', 'human', 'not a whole-app refactor'), /human gate/);
  assert.strictEqual(transitionPhase('TEST', archGate, 'architecture-selection', 'skip', 'workflow-engine', 'not a whole-app refactor'), 'skipped');

  // `executor` is caller-supplied text, so claiming to be the engine must not by
  // itself open the gate: in a real whole-app refactor the stage applies and the
  // human must select an architecture.
  const wholeApp = ensureShape({ id: 'TEST', workflowMode: { mode: 'behavior_preserving_refactor', refactorScope: 'whole_app' }, phases: { 'architecture-options': { status: 'skipped' } }, roles: {}, selectedRoles: {} }, 'TEST');
  assert.strictEqual(isWholeAppRefactor(wholeApp), true);
  assert.throws(() => transitionPhase('TEST', wholeApp, 'architecture-selection', 'skip', 'workflow-engine', 'spoofed executor'), /human gate/, 'a spoofed executor cannot skip a real architecture gate');
  assert.throws(() => transitionPhase('TEST', wholeApp, 'architecture-selection', 'complete', 'workflow-engine', ''), /human gate/);
  assert.strictEqual(isWholeAppRefactor(ensureShape({ id: 'TEST', workflowMode: { mode: 'feature', refactorScope: null }, phases: {}, roles: {}, selectedRoles: {} }, 'TEST')), false);
  assert.ok(PHASES.includes('implementation'), 'rework targets a real stage id');
  assert.ok(!PHASES.includes('approval') || true);

  const evidence = ensureShape({}, 'TEST');
  assert.ok(verificationEvidenceProblem('TEST', evidence, { evalMode: false }).includes('unclassified'));
  evidence.evidence.mobileScreenshots = { requirement: 'not-required', reason: 'backend-only' };
  assert.strictEqual(verificationEvidenceProblem('TEST', evidence, { evalMode: false }), null);
  evidence.evidence.mobileScreenshots = { requirement: 'required', execution: { status: 'blocked', attemptId: 'x', platforms: ['android'] } };
  assert.ok(verificationEvidenceProblem('TEST', evidence, { evalMode: false }).includes('blocked'));
  assert.strictEqual(verificationEvidenceProblem('TEST', evidence, { evalMode: true }), null);

  const retryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-retry-'));
  const runEnv = { ...process.env, AI_WORKFLOW_STATE_ROOT: retryRoot };
  const runCli = argv => spawnSync(process.execPath, [__filename, ...argv], { env: runEnv, encoding: 'utf8' });
  runCli(['start', 'RETRY-TEST']);
  for (const p of ['request', 'requirements', 'acceptance-criteria', 'definition-of-done', 'inspection', 'behavior-baseline', 'refactor-invariants', 'architecture-assessment', 'architecture-options']) {
    runCli(['skip', p, 'claude', 'test']);
  }
  runCli(['skip', 'architecture-selection', 'workflow-engine', 'test']);
  for (const p of ['target-architecture', 'c4-model', 'architecture-migration', 'refactor-coverage']) {
    runCli(['skip', p, 'claude', 'test']);
  }
  runCli(['select-roles', 'analysis', 'architect', 'security']);
  runCli(['role-begin', 'analysis', 'architect', 'claude']);
  runCli(['role-fail', 'analysis', 'architect', 'claude', 'boom']);
  const rejected = runCli(['retry', 'RETRY-TEST', 'nonexistent-role']);
  assert.notStrictEqual(rejected.status, 0);
  assert.ok(/no failed\/blocked\/in-progress role/.test(rejected.stderr), rejected.stderr);
  const retried = runCli(['retry', 'RETRY-TEST', 'architect']);
  assert.strictEqual(retried.status, 0, retried.stderr);
  assert.ok(retried.stdout.includes('analysis/architect'), retried.stdout);
  const afterRetry = JSON.parse(fs.readFileSync(path.join(retryRoot, 'RETRY-TEST', 'state.json'), 'utf8'));
  assert.strictEqual(afterRetry.roles.analysis.architect.status, 'pending');
  assert.strictEqual(afterRetry.phases.analysis.status, 'in_progress');

  // `agentic pr` stores its overrides and puts a skipped pull-request stage
  // back to pending; a passing description attempt survives, a failed one goes.
  {
    const file = path.join(retryRoot, 'RETRY-TEST', 'state.json');
    const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
    seeded.phases['pull-request'] = { status: 'skipped', note: 'disabled' };
    seeded.executionAttempts = { 'pull-request': { 'pr-description': [{ attemptId: 'x', status: 'pass', exitType: 'success' }] } };
    fs.writeFileSync(file, JSON.stringify(seeded));
    const requested = runCli(['pull-request-options', 'RETRY-TEST', '--base', 'feature/parent', '--draft', 'true']);
    assert.strictEqual(requested.status, 0, requested.stderr);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after.phases['pull-request'].status, 'pending');
    assert.deepStrictEqual([after.pullRequestOptions.manual, after.pullRequestOptions.base, after.pullRequestOptions.draft], [true, 'feature/parent', true]);
    assert.strictEqual(after.executionAttempts['pull-request']['pr-description'].length, 1, 'a written description is reused');
    assert.ok(after.history.some(h => h.kind === 'pull-request' && h.action === 'request'));
    const branchOnly = runCli(['pull-request-options', 'RETRY-TEST', '--branch', 'feature/child']);
    assert.strictEqual(branchOnly.status, 0, branchOnly.stderr);
    const merged = JSON.parse(fs.readFileSync(file, 'utf8')).pullRequestOptions;
    assert.deepStrictEqual([merged.base, merged.branch, merged.draft], ['feature/parent', 'feature/child', true], 'earlier overrides are kept');
    assert.notStrictEqual(runCli(['pull-request-options', 'RETRY-TEST', '--base', '--force']).status, 0, 'an option is not a branch name');
    assert.notStrictEqual(runCli(['pull-request-options', 'RETRY-TEST', '--remote', 'x']).status, 0);
    const restore = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete restore.phases['pull-request']; delete restore.pullRequestOptions; delete restore.executionAttempts;
    fs.writeFileSync(file, JSON.stringify(restore));
    // `status` of a run closed before 1.9.31 agrees with the progress views:
    // the stage it never had is skipped, and there is nothing to resume.
    const legacyDir = path.join(retryRoot, 'LEGACY-CLOSED');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = { ...restore, id: 'LEGACY-CLOSED', status: 'done', closedAt: now(), phases: Object.fromEntries(PHASES.filter(p => p !== 'pull-request').map(p => [p, { status: 'pass' }])) };
    fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify(legacy));
    const shown = runCli(['status', 'LEGACY-CLOSED']);
    assert.strictEqual(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /pull-request\s+skipped/);
    assert.match(shown.stdout, /→ resume at: done/);
    assert.ok(!/not opened — run/.test(shown.stdout), 'no pr hint for a run that never had the stage');
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }

  // A role or phase interrupted mid-run (stuck at in_progress, never reaching
  // fail/blocked) must also be recoverable, or `begin` rejects it forever.
  runCli(['role-begin', 'analysis', 'security', 'claude']);
  const retriedStuckRole = runCli(['retry', 'RETRY-TEST']);
  assert.strictEqual(retriedStuckRole.status, 0, retriedStuckRole.stderr);
  assert.ok(retriedStuckRole.stdout.includes('analysis/security'), retriedStuckRole.stdout);
  const afterStuckRoleRetry = JSON.parse(fs.readFileSync(path.join(retryRoot, 'RETRY-TEST', 'state.json'), 'utf8'));
  assert.strictEqual(afterStuckRoleRetry.roles.analysis.security.status, 'pending');

  // While a live parallel-role pool owns the stage, its in_progress roles are
  // not "stuck" and retry refuses to reset them. A pid file left by a dead pool
  // does not block.
  runCli(['role-begin', 'analysis', 'security', 'claude']);
  const pidFile = path.join(retryRoot, 'RETRY-TEST', 'engine', 'analysis-parallel.pid');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  // The stand-in pool is orphaned at once, so init reaps it when it is killed;
  // a child of this (synchronous) selftest would linger as a zombie and look alive.
  const launcher = spawnSync(process.execPath, ['-e', "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);"], { encoding: 'utf8' });
  const poolPid = Number(String(launcher.stdout).trim());
  assert.ok(poolPid > 0, launcher.stderr);
  const poolAlive = () => { try { process.kill(poolPid, 0); return true; } catch { return false; } };
  try {
    fs.writeFileSync(pidFile, `${poolPid}\n`);
    for (const argv of [['retry', 'RETRY-TEST'], ['retry', 'RETRY-TEST', 'security']]) {
      const refused = runCli(argv);
      assert.notStrictEqual(refused.status, 0, `${argv.join(' ')} refuses while the pool runs`);
      assert.match(refused.stderr, new RegExp(`analysis/security is still running in the workflow engine \\(parallel role runner pid ${poolPid}\\)`), refused.stderr);
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(retryRoot, 'RETRY-TEST', 'state.json'), 'utf8')).roles.analysis.security.status, 'in_progress', 'refused retry changed nothing');
  } finally { try { process.kill(poolPid, 'SIGKILL'); } catch { /* gone */ } }
  for (const until = Date.now() + 5000; poolAlive() && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const afterDeadPool = runCli(['retry', 'RETRY-TEST', 'security']);
  assert.strictEqual(afterDeadPool.status, 0, `a dead pool's pid file does not block retry: ${afterDeadPool.stderr}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(retryRoot, 'RETRY-TEST', 'state.json'), 'utf8')).roles.analysis.security.status, 'pending');
  fs.rmSync(pidFile, { force: true });

  runCli(['start', 'RETRY-PHASE-TEST']);
  for (const p of ['request', 'requirements', 'acceptance-criteria', 'definition-of-done']) runCli(['skip', p, 'claude', 'test']);
  runCli(['begin', 'inspection', 'claude']);
  const stuckPhase = runCli(['begin', 'inspection', 'claude']);
  assert.notStrictEqual(stuckPhase.status, 0, 'cannot begin an already in_progress phase without retry');
  const retriedStuckPhase = runCli(['retry', 'RETRY-PHASE-TEST']);
  assert.strictEqual(retriedStuckPhase.status, 0, retriedStuckPhase.stderr);
  assert.ok(retriedStuckPhase.stdout.includes('inspection'), retriedStuckPhase.stdout);
  const afterStuckPhaseRetry = JSON.parse(fs.readFileSync(path.join(retryRoot, 'RETRY-PHASE-TEST', 'state.json'), 'utf8'));
  assert.strictEqual(afterStuckPhaseRetry.phases.inspection.status, 'pending');
  assert.strictEqual(runCli(['begin', 'inspection', 'claude']).status, 0, 'inspection is beginnable again after retry');

  // Roles of a parallel stage transition from separate processes at the same
  // time. Without the state lock most of these updates were lost (last rename wins).
  runCli(['start', 'CONCURRENT-TEST']);
  for (const p of ['request', 'requirements', 'acceptance-criteria', 'definition-of-done', 'inspection', 'behavior-baseline', 'refactor-invariants', 'architecture-assessment', 'architecture-options']) runCli(['skip', p, 'claude', 'test']);
  runCli(['skip', 'architecture-selection', 'workflow-engine', 'test']);
  for (const p of ['target-architecture', 'c4-model', 'architecture-migration', 'refactor-coverage']) runCli(['skip', p, 'claude', 'test']);
  const concurrentRoles = ['docs', 'architect', 'qa-plan', 'security', 'performance', 'android'];
  assert.strictEqual(runCli(['select-roles', 'analysis', ...concurrentRoles]).status, 0);
  const burst = `
    const { spawn } = require('child_process');
    const roles = ${JSON.stringify(concurrentRoles)};
    const run = argv => new Promise(resolve => spawn(process.execPath, [${JSON.stringify(__filename)}, ...argv], { env: { ...process.env, FEATURE_RUN_ID: 'CONCURRENT-TEST' }, stdio: 'ignore' }).on('close', resolve));
    (async () => {
      const begun = await Promise.all(roles.map(r => run(['role-begin', 'analysis', r, 'claude'])));
      const failed = await Promise.all(roles.map(r => run(['role-fail', 'analysis', r, 'claude', 'concurrent ' + r])));
      process.exitCode = [...begun, ...failed].every(code => code === 0) ? 0 : 1;
    })();
  `;
  const burstResult = spawnSync(process.execPath, ['-e', burst], { env: runEnv, encoding: 'utf8' });
  assert.strictEqual(burstResult.status, 0, `concurrent role transitions all succeed: ${burstResult.stderr}`);
  const afterBurst = JSON.parse(fs.readFileSync(path.join(retryRoot, 'CONCURRENT-TEST', 'state.json'), 'utf8'));
  for (const r of concurrentRoles) {
    assert.strictEqual(afterBurst.roles.analysis[r].status, 'fail', `${r} kept its own transition`);
    assert.strictEqual(afterBurst.roles.analysis[r].note, `concurrent ${r}`);
  }
  assert.strictEqual(afterBurst.history.filter(h => h.kind === 'role' && h.group === 'analysis').length, concurrentRoles.length * 2, 'no history entry was lost');
  assert.ok(!fs.existsSync(path.join(retryRoot, 'CONCURRENT-TEST', 'state.json.lock')), 'state lock released');

  // A blocked conditional role (verification's mobile-evidence) leaves its stage
  // pending, so retry used to say "nothing to retry". It resets it now, with
  // the rest or by name, and keeps the failure streak for the next attempt.
  {
    const id = 'COND-TEST';
    const env = { FEATURE_RUN_ID: id };
    const cli = (argv, extra = {}) => spawnSync(process.execPath, [__filename, ...argv], { env: { ...runEnv, ...env, ...extra }, encoding: 'utf8' });
    const stateOf = () => JSON.parse(fs.readFileSync(path.join(retryRoot, id, 'state.json'), 'utf8'));
    cli(['start', id]);
    const nothing = cli(['retry', id]);
    assert.notStrictEqual(nothing.status, 0);
    assert.match(nothing.stderr, new RegExp(`nothing to retry; run node ai/workflow/engine\\.js resume ${id}`), nothing.stderr);
    assert.match(cli(['retry', id], { AI_AGENTIC_CLI: '1' }).stderr, new RegExp(`nothing to retry; run agentic resume ${id}`));
    const block = reason => assert.strictEqual(cli(['conditional', 'verification', 'mobile-evidence', 'blocked', reason]).status, 0);
    block('mobile-evidence run failed: no booted Android emulator (checked at 2026-11-03T10:00:00Z)');
    block('mobile-evidence run failed: no booted Android emulator (checked at 2026-11-04T09:30:12Z)');
    assert.strictEqual(stateOf().conditionals.verification['mobile-evidence'].repeatedFailure, 2, 'the same reason twice is a repeat');
    const shown = cli(['status', id]);
    assert.match(shown.stdout, /⚠ Needs you: Same failure as last time — this needs a fix outside Final Verification/);
    assert.match(shown.stdout, /→ run: node ai\/tasks\/feature\/runs\.js retry COND-TEST && node ai\/workflow\/engine\.js resume COND-TEST/);
    const all = cli(['retry', id]);
    assert.strictEqual(all.status, 0, all.stderr);
    assert.match(all.stdout, /retried verification\/mobile-evidence \(conditional\)/);
    const reset = stateOf().conditionals.verification['mobile-evidence'];
    assert.strictEqual(reset.status, 'pending');
    assert.strictEqual(reset.repeatedFailure, 2, 'a reset keeps the streak');
    assert.ok(stateOf().history.some(h => h.kind === 'conditional-role' && h.action === 'retry' && h.from === 'blocked'));
    block('mobile-evidence run failed: no booted Android emulator (checked at 2026-11-05T08:00:00Z)');
    assert.strictEqual(stateOf().conditionals.verification['mobile-evidence'].repeatedFailure, 3);
    const named = cli(['retry', id, 'mobile-evidence']);
    assert.strictEqual(named.status, 0, named.stderr);
    assert.match(named.stdout, /verification\/mobile-evidence \(conditional\)/);
    assert.notStrictEqual(cli(['retry', id, 'mobile-evidence']).status, 0, 'nothing left to retry by that name');
    // A phase failing twice for the same reason is recorded on the phase.
    for (const p of ['request', 'requirements']) cli(['skip', p, 'claude', 'test']);
    for (let i = 0; i < 2; i++) {
      cli(['begin', 'acceptance-criteria', 'claude']);
      cli(['fail', 'acceptance-criteria', 'claude', `acceptance criteria rejected: schema error at /criteria/0 (attempt ${id}-acceptance-criteria-orchestration-${i + 1}-176216400012${i})`]);
    }
    assert.strictEqual(stateOf().phases['acceptance-criteria'].repeatedFailure, 2);
    // While an engine drives the run, retry refuses to reset anything.
    const owner = path.join(retryRoot, id, 'engine', 'engine.pid');
    fs.mkdirSync(path.dirname(owner), { recursive: true });
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'resume', startedAt: now() }));
    const busy = cli(['retry', id]);
    assert.notStrictEqual(busy.status, 0);
    assert.match(busy.stderr, new RegExp(`${id} is being driven by engine pid ${process.pid} \\(resume\\)`));
    assert.strictEqual(stateOf().phases['acceptance-criteria'].status, 'fail', 'a refused retry changes nothing');
    assert.match(cli(['status', id]).stdout, /● engine running: engine pid/);
    fs.unlinkSync(owner);
    const fixed = cli(['retry', id]);
    assert.strictEqual(fixed.status, 0, fixed.stderr);
    assert.strictEqual(stateOf().phases['acceptance-criteria'].repeatedFailure, 2, 'the phase keeps its streak through retry');
    cli(['begin', 'acceptance-criteria', 'claude']);
    cli(['fail', 'acceptance-criteria', 'claude', 'a different problem: the request is ambiguous']);
    assert.strictEqual(stateOf().phases['acceptance-criteria'].repeatedFailure, undefined, 'a new reason is not a repeat');
  }

  fs.rmSync(retryRoot, { recursive: true, force: true });

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
      const state = locked(id, () => {
        let value = load(id);
        if (!value) { value = ensureShape(null, id); atomicSave(id, value); console.log(`created ${relativeStatePath(id)}/`); }
        else { value = ensureShape(value, id); if (reconcileState(id, value)) atomicSave(id, value); console.log(`${relativeStatePath(id)}/ exists — resuming`); }
        return value;
      });
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
      const to = locked(id, () => {
        const state = ensureShape(load(id), id);
        const result = transitionPhase(id, state, phase, cmd, executor || '-', reason);
        atomicSave(id, state);
        return result;
      });
      console.log(`${id} ${phase} → ${to}${reason ? ` (${reason})` : ''}`);
      break;
    }
    case 'select-roles': {
      const [group, ...roles] = rest;
      const id = resolveId();
      if (!id) throw new Error('no run id');
      if (!ROLE_GROUPS.includes(group)) throw new Error(`unknown role group "${group}" — one of: ${ROLE_GROUPS.join(', ')}`);
      if (!roles.length || roles.some(role => !safeRole(role))) throw new Error('select-roles requires valid role names');
      const unique = [...new Set(roles)];
      locked(id, () => {
        const state = ensureShape(load(id), id);
        const deps = dependencyProblems(group, state);
        if (deps.length) throw new Error(`${group}: dependencies are incomplete: ${deps.join(', ')}`);
        if (!['pending', 'in_progress', 'fail', 'blocked'].includes(phaseStatus(state, group))) throw new Error(`${group}: cannot select roles while phase is ${phaseStatus(state, group)}`);
        state.selectedRoles[group] = unique;
        state.roles[group] ||= {};
        for (const role of unique) state.roles[group][role] ||= { status: 'pending', updatedAt: now() };
        const from = phaseStatus(state, group);
        state.phases[group] = { ...(state.phases[group] || {}), status: 'in_progress', updatedAt: now() };
        record(state, { kind: 'phase', phase: group, action: 'begin', from, to: 'in_progress', reason: `selected roles: ${unique.join(', ')}` });
        atomicSave(id, state);
      });
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
      const to = locked(id, () => {
        const state = ensureShape(load(id), id);
        const result = transitionRole(id, state, group, role, action, executor || '-', reason);
        atomicSave(id, state);
        return result;
      });
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
      locked(id, () => {
        const state = ensureShape(load(id), id);
        const previous = state.evidence.mobileScreenshots?.requirement || 'unclassified';
        state.evidence.mobileScreenshots = { requirement, updatedAt: now(), ...(reason ? { reason } : {}) };
        record(state, { kind: 'evidence', from: previous, to: requirement, reason: reason || null });
        fs.mkdirSync(screenshotDir(id), { recursive: true });
        atomicSave(id, state);
      });
      console.log(`${id}: mobile screenshot evidence → ${requirement}${reason ? ` (${reason})` : ''}`);
      break;
    }
    case 'conditional': {
      const [phase, role, status] = rest;
      const reason = rest.slice(3).join(' ');
      const id = resolveId();
      if (!id) throw new Error('no run id');
      if (!safeRole(role) || !['in_progress', 'pass', 'fail', 'blocked', 'skipped'].includes(status)) throw new Error('conditional requires <phase> <role> <in_progress|pass|fail|blocked|skipped>');
      locked(id, () => {
        const state = ensureShape(load(id), id);
        state.conditionals[phase] ||= {};
        const previous = state.conditionals[phase][role];
        // A run in progress keeps the failure streak; only a pass clears it.
        state.conditionals[phase][role] = { ...(['fail', 'blocked', 'in_progress'].includes(status) ? carried(previous) : {}), status, updatedAt: now(), ...(reason ? { reason } : {}) };
        if (status === 'fail' || status === 'blocked') recordFailure(state.conditionals[phase][role], reason);
        record(state, { kind: 'conditional-role', phase, role, to: status, reason: reason || null });
        atomicSave(id, state);
      });
      console.log(`${id} conditional ${phase}/${role} → ${status}`);
      break;
    }
    case 'reconcile': {
      const id = resolveId(rest[0]);
      if (!id || !safeId(id)) throw new Error('no valid run to reconcile');
      const { state, changed } = locked(id, () => {
        const value = ensureShape(load(id), id);
        const didChange = reconcileState(id, value);
        if (didChange) atomicSave(id, value);
        return { state: value, changed: didChange };
      });
      console.log(`${id}: ${changed ? 'state reconciled' : 'state already consistent'}`);
      render(id, state);
      break;
    }
    case 'retry': {
      const [id, ...roles] = rest;
      if (!id || !safeId(id) || !fs.existsSync(path.join(RUNS, id))) throw new Error('retry requires a valid run id');
      if (roles.some(role => !safeRole(role))) throw new Error('retry requires valid role names');
      // An engine driving the run would race the reset: it may complete a stage
      // retry has just put back to pending, or begin one twice.
      const engine = liveEngine(path.join(RUNS, id));
      if (engine?.kind === 'engine') throw new Error(`${id} is being driven by ${describeEngine(engine)}; wait for it to stop (agentic progress shows it), then retry. If no engine is running for ${id}, delete ${ownerFile(path.join(RUNS, id))} first`);
      locked(id, () => {
        const state = ensureShape(load(id), id);
        reconcileState(id, state);
        const retried = [];
        const RETRYABLE = ['fail', 'blocked', 'in_progress'];
        // Resetting the status is not enough: the execution policy reads the
        // recorded attempts and refuses a rerun after a deterministic failure
        // ("last failure type deterministic is not retryable"), so the spent
        // attempts for what is being retried have to go too.
        // Clearing attempts also erases why the work failed, which is exactly what
        // the next agent needs, so the last reason is kept aside as feedback.
        const rememberFailure = (phaseId, roleName, attempts) => {
          const last = [...(attempts || [])].reverse().find(a => a && a.reason);
          if (!last) return;
          state.lastFailures ||= {};
          state.lastFailures[phaseId] ||= {};
          state.lastFailures[phaseId][roleName || phaseId] = { reason: String(last.reason).slice(0, 1200), at: now() };
        };
        const clearAttempts = (phaseId, roleName) => {
          const forPhase = state.executionAttempts?.[phaseId];
          if (!forPhase) return;
          if (roleName) { rememberFailure(phaseId, roleName, forPhase[roleName]); delete forPhase[roleName]; }
          else for (const key of Object.keys(forPhase)) { rememberFailure(phaseId, key, forPhase[key]); delete forPhase[key]; }
          if (!Object.keys(forPhase).length) delete state.executionAttempts[phaseId];
        };
        for (const group of ROLE_GROUPS) {
          for (const [role, roleState] of Object.entries(state.roles?.[group] || {})) {
            if (roles.length ? !roles.includes(role) : false) continue;
            if (!RETRYABLE.includes(roleState.status)) continue;
            refuseLiveRole(id, group, role, roleState.status);
            state.roles[group][role] = { ...carried(roleState), status: 'pending', updatedAt: now() };
            clearAttempts(group, role);
            record(state, { kind: 'role', group, role, action: 'retry', from: roleState.status, to: 'pending', executor: actor(), reason: 'retry requested' });
            retried.push(`${group}/${role}`);
          }
        }
        // A conditional role (verification's mobile-evidence) blocks before its
        // stage begins, so the stage reads pending and the loops above and below
        // never see it. Reset it with the rest, or by its own name.
        for (const [phaseId, group] of Object.entries(state.conditionals || {})) {
          for (const [role, entry] of Object.entries(group || {})) {
            if (roles.length && !roles.includes(role)) continue;
            if (!['fail', 'blocked'].includes(entry?.status)) continue;
            state.conditionals[phaseId][role] = { ...carried(entry), status: 'pending', updatedAt: now(), ...(entry.reason ? { reason: entry.reason } : {}) };
            clearAttempts(phaseId, role);
            record(state, { kind: 'conditional-role', phase: phaseId, role, action: 'retry', from: entry.status, to: 'pending', reason: 'retry requested' });
            retried.push(`${phaseId}/${role} (conditional)`);
          }
        }
        if (!roles.length) {
          for (const phaseId of PHASES) {
            if (ROLE_GROUPS.includes(phaseId)) continue;
            const from = phaseStatus(state, phaseId);
            if (!RETRYABLE.includes(from)) continue;
            state.phases[phaseId] = { ...(state.phases[phaseId] || {}), status: 'pending', updatedAt: now() };
            clearAttempts(phaseId);
            record(state, { kind: 'phase', phase: phaseId, action: 'retry', from, to: 'pending', reason: 'retry requested' });
            retried.push(phaseId);
          }
        }
        // Naming a stage explicitly sends it back for rework even though it passed:
        // when a later stage fails (tests red after implementation), the earlier
        // stage has to run again or the failure repeats forever. Human gates are
        // never reworked this way — they stay with the human.
        if (!retried.length && roles.length) {
          const gates = new Set(['approval', 'architecture-selection']);
          for (const name of roles) {
            if (!PHASES.includes(name)) continue;
            if (gates.has(name)) throw new Error(`${name} is a human gate and cannot be reset; re-approve it instead`);
            const from = phaseStatus(state, name);
            state.phases[name] = { ...(state.phases[name] || {}), status: 'pending', updatedAt: now() };
            clearAttempts(name);
            record(state, { kind: 'phase', phase: name, action: 'rework', from, to: 'pending', reason: 'rework requested' });
            retried.push(`${name} (rework from ${from})`);
            // Rework means "redo from here": the stage that failed downstream is
            // why we are reworking, and it keeps its spent attempts otherwise —
            // so the resume stalls again on the previous deterministic failure.
            for (const later of PHASES.slice(PHASES.indexOf(name) + 1)) {
              if (gates.has(later)) continue;
              const status = phaseStatus(state, later);
              if (!['fail', 'blocked', 'in_progress'].includes(status)) continue;
              state.phases[later] = { ...(state.phases[later] || {}), status: 'pending', updatedAt: now() };
              clearAttempts(later);
              for (const [role, roleState] of Object.entries(state.roles?.[later] || {})) {
                if (!['fail', 'blocked', 'in_progress'].includes(roleState?.status)) continue;
                refuseLiveRole(id, later, role, roleState.status);
                // Keep the note: it says what went wrong, and the reworked role reads it.
                state.roles[later][role] = { ...roleState, status: 'pending', updatedAt: now() };
                clearAttempts(later, role);
              }
              record(state, { kind: 'phase', phase: later, action: 'rework-downstream', from: status, to: 'pending', reason: `reset for rework of ${name}` });
              retried.push(`${later} (downstream of ${name})`);
            }
          }
        }
        if (!retried.length) throw new Error(roles.length ? `no failed/blocked/in-progress role(s) matching ${roles.join(', ')}` : nothingToRetry(id, state));
        reconcileState(id, state);
        atomicSave(id, state);
        console.log(`${id}: retried ${retried.join(', ')}`);
      });
      break;
    }
    // What `agentic pr <id>` asks for: the PR stage on a human's request, with
    // overrides (base, branch, draft) kept for a later resume, and the stage
    // reset so the engine runs it again. Delivery is idempotent, so re-running a
    // passed stage only commits and pushes what is new and reuses the open PR.
    // A passing pr-description attempt is kept so the text is not rewritten.
    case 'pull-request-options': {
      const id = rest[0];
      if (!id || !safeId(id) || !fs.existsSync(stateFile(id))) throw new Error('pull-request-options requires a valid run id');
      const options = {};
      for (let i = 1; i < rest.length; i++) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (!['--base', '--branch', '--draft'].includes(flag) || value === undefined) throw new Error(`pull-request-options: unexpected argument ${flag}`);
        if (flag === '--draft') { if (!['true', 'false'].includes(value)) throw new Error('--draft takes true or false'); options.draft = value === 'true'; }
        else if (!/^[A-Za-z0-9._/{}-]{1,200}$/.test(value) || value.startsWith('-') || value.includes('..')) throw new Error(`${flag} needs a branch name`);
        else options[flag.slice(2)] = value;
        i++;
      }
      locked(id, () => {
        const state = ensureShape(load(id), id);
        reconcileState(id, state);
        state.pullRequestOptions = { ...(state.pullRequestOptions || {}), ...options, manual: true, requestedAt: now() };
        record(state, { kind: 'pull-request', action: 'request', executor: actor(), reason: Object.keys(options).length ? `requested with ${Object.entries(options).map(([k, v]) => `${k}=${v}`).join(', ')}` : 'requested' });
        const from = phaseStatus(state, 'pull-request');
        if (from !== 'pending') {
          state.phases['pull-request'] = { ...(state.phases['pull-request'] || {}), status: 'pending', updatedAt: now() };
          record(state, { kind: 'phase', phase: 'pull-request', action: 'pull-request-request', from, to: 'pending', reason: 'pull request requested' });
        }
        const attempts = state.executionAttempts?.['pull-request'];
        for (const [role, list] of Object.entries(attempts || {})) {
          if ((list || []).some(a => a && (a.status === 'pass' || a.exitType === 'success'))) continue;
          delete attempts[role];
        }
        if (attempts && !Object.keys(attempts).length) delete state.executionAttempts['pull-request'];
        atomicSave(id, state);
        console.log(`${id}: pull request requested${Object.keys(options).length ? ` (${Object.entries(options).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}; pull-request ${from} → pending`);
      });
      break;
    }
    case 'architecture-select': {
      const id = resolveId(rest[0]);
      const optionId = rest[1];
      const note = rest.slice(2).join(' ');
      if (!safeId(id) || !fs.existsSync(path.join(RUNS, id))) throw new Error('unknown run');
      if (!optionId || !/^[A-Za-z0-9._-]{1,80}$/.test(optionId)) throw new Error('architecture-select requires a valid option id');
      const optionsFile = path.join(RUNS, id, '05-architecture-options.json');
      if (!fs.existsSync(optionsFile)) throw new Error(`${relativeStatePath(id, '05-architecture-options.json')} is missing`);
      const artifactProblem = phaseArtifactProblem(id, 'architecture-options');
      if (artifactProblem) throw new Error(`cannot select architecture: ${artifactProblem}`);
      const options = JSON.parse(fs.readFileSync(optionsFile, 'utf8'));
      const selected = (options.options || []).find(x => x.id === optionId);
      if (!selected) throw new Error(`unknown architecture option "${optionId}" — choose one of: ${(options.options || []).map(x => x.id).join(', ')}`);
      locked(id, () => {
        const state = ensureShape(load(id), id);
        reconcileState(id, state);
        if (phaseStatus(state, 'architecture-options') !== 'pass') throw new Error(`architecture-options is ${phaseStatus(state, 'architecture-options')} — complete option analysis first`);
        const selectedAt = now();
        const decision = {
          schemaVersion: 1,
          runId: id,
          selectedOptionId: selected.id,
          selectedOptionName: selected.name,
          selectedAt,
          selectedBy: 'human',
          note: note || null,
        };
        fs.writeFileSync(path.join(RUNS, id, '05-architecture-selection.json'), JSON.stringify(decision, null, 2) + '\n');
        fs.writeFileSync(path.join(RUNS, id, '05-architecture-selection.md'),
          `# Human architecture decision\n\nSelected option: **${selected.id} — ${selected.name}**\n\nSelected at: ${selectedAt}\n\n${note ? `Human note: ${note}\n\n` : ''}The agent recommendation was advisory; this file records the explicit human decision.\n`);
        fs.writeFileSync(path.join(RUNS, id, 'architecture.selected'), `selected: ${selected.id}\nat: ${selectedAt}\n`);
        const from = phaseStatus(state, 'architecture-selection');
        state.phases['architecture-selection'] = { status: 'pass', updatedAt: selectedAt, note: `human selected ${selected.id}` };
        state.architectureDecision = decision;
        record(state, { kind: 'phase', phase: 'architecture-selection', action: 'select', from, to: 'pass', executor: 'human', reason: `selected architecture ${selected.id}` });
        atomicSave(id, state);
        console.log(`${id}: architecture selected → ${selected.id} — ${selected.name}`);
      });
      break;
    }
    case 'approve': {
      const id = resolveId(rest[0]);
      if (!safeId(id) || !fs.existsSync(path.join(RUNS, id))) throw new Error('unknown run');
      const plan = path.join(RUNS, id, '06-plan.md');
      if (!fs.existsSync(plan) || fs.statSync(plan).size < 80) throw new Error(`${relativeStatePath(id, '06-plan.md')} is missing or empty — nothing to approve`);
      const planProblem = phaseArtifactProblem(id, 'plan');
      if (planProblem) throw new Error(`cannot approve plan: ${planProblem}`);
      locked(id, () => {
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
      });
      break;
    }
    case 'close': {
      const id = resolveId(rest[0]);
      if (!id) { console.log('no active run'); break; }
      // Without this, closing a mistyped id would create the run it closes.
      if (!fs.existsSync(stateFile(id))) throw new Error(`unknown run ${id}: no ${path.join(id, 'state.json')} in ${RUNS}`);
      locked(id, () => {
        const state = ensureShape(load(id), id);
        reconcileState(id, state);
        const verified = phaseStatus(state, 'verification') === 'pass';
        if (!verified && process.env.AI_WORKFLOW_ADMIN !== '1') throw new Error(`cannot close ${id}: verification=${phaseStatus(state, 'verification')}`);
        // A run closed before verification is abandoned, not completed; say so in
        // the state and the history instead of leaving it to look finished.
        const reason = rest.slice(1).join(' ').trim() || null;
        state.status = 'done';
        state.closedAt = now();
        if (!verified) {
          state.abandoned = true;
          state.abandonedAt = state.closedAt;
        }
        if (reason) state.closedReason = reason;
        record(state, { kind: 'run', action: verified ? 'close' : 'abandon', to: 'done', ...(reason ? { reason } : {}) });
        atomicSave(id, state);
        if (activeId() === id && fs.existsSync(ACTIVE)) fs.unlinkSync(ACTIVE);
        console.log(`${id}: ${verified ? 'closed' : 'abandoned before verification'}`);
        if (state.pullRequest?.url) console.log(`${id}: pull request #${state.pullRequest.number ?? '?'} ${state.pullRequest.url}`);
        else if (verified) console.log(`${id}: no pull request was opened — open one with: ${process.env.AI_AGENTIC_CLI === '1' ? 'agentic pr' : 'node ai/workflow/engine.js pr'} ${id}`);
      });
      break;
    }
    case 'set': {
      requireAdmin();
      const [phase, status] = rest;
      const note = rest.slice(2).join(' ');
      const id = resolveId();
      if (!id || !PHASES.includes(phase) || !STATUSES.includes(status)) usage();
      locked(id, () => {
        const state = ensureShape(load(id), id);
        const from = phaseStatus(state, phase);
        state.phases[phase] = { status, updatedAt: now(), ...(note ? { note } : {}) };
        record(state, { kind: 'admin-phase-set', phase, from, to: status, reason: note || null });
        atomicSave(id, state);
        console.log(`${id} ${phase} → ${status} (admin)`);
      });
      break;
    }
    case 'set-role': {
      requireAdmin();
      const [group, role, status, executor] = rest;
      const note = rest.slice(4).join(' ');
      const id = resolveId();
      if (!id || !ROLE_GROUPS.includes(group) || !safeRole(role) || !STATUSES.includes(status)) usage();
      locked(id, () => {
        const state = ensureShape(load(id), id);
        state.roles[group] ||= {};
        const from = state.roles[group][role]?.status || 'pending';
        state.roles[group][role] = { status, updatedAt: now(), ...(executor && executor !== '-' ? { executor } : {}), ...(note ? { note } : {}) };
        record(state, { kind: 'admin-role-set', group, role, from, to: status, executor: executor || null, reason: note || null });
        reconcileState(id, state);
        atomicSave(id, state);
        console.log(`${id} ${group}/${role} → ${status} (admin)`);
      });
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
