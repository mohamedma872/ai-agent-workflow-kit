#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { selectAnalysis, selectReviews } = require('./subagent-selector');
const { synthesize } = require('./finding-synthesis');
const { detectConflicts, unresolvedBlocking } = require('./conflict-tracker');
const { roleContract, assertRequiredMcps } = require('./subagent-contracts');
const { buildRoleContext, prTemplate, changedFiles, resolvedConflicts } = require('./subagent-context');
const { detectRefactorMode } = require('./refactor-mode');
const { canImplement, loadWaivers } = require('./refactor-coverage');
const { problems: refactorCheckpointProblems } = require('./refactor-checkpoints');
const { verificationMatrix } = require('./refactor-verification-matrix');
const { contractDiff, invariantProblems } = require('./refactor-contract-diff');
const { refactorTelemetry } = require('./refactor-telemetry');
const yaml = require('js-yaml');
const { materialize, sidecarForMarkdown, schemaContract, validateArtifactFile } = require('./artifacts');
const { resolveExecutionPolicy, classifyFailure, executeWithPolicy, resumeDecision } = require('./execution-policy');
const { attemptsFor, recordAttempt } = require('./attempts');
const { ensure: ensureWorktree, inspect: inspectWorktree, refresh: refreshWorktree, cleanup: cleanupWorktree, metadataFile: worktreeMetadataFile } = require('./worktree');
const { runtimeRoot, projectRoot, stateRoot, relativeStatePath } = require('./paths');
const { withStateLock, writeJsonAtomic } = require('./state-lock');
const { stopGroupsSync, RUNNER_ENV } = require('./parallel-roles');
const pullRequest = require('./pull-request');
const notify = require('./notify');
const engineOwner = require('./engine-owner');
const { needsYou, needsYouLines, commandFor } = require('./progress');
const { workspaceFingerprint, gitSha } = require('../tasks/feature/evidence-attestation');

const RUNTIME_ROOT = runtimeRoot();
const PROJECT_ROOT = projectRoot();
const RUNS = stateRoot();
const RUNS_TOOL = path.join(RUNTIME_ROOT, 'ai', 'tasks', 'feature', 'runs.js');
const ROUTER = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'router.js');
const DOCTOR = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'doctor.js');
const MOBILE_EVIDENCE = path.join(RUNTIME_ROOT, 'ai', 'tasks', 'feature', 'mobile-evidence.js');
const PARALLEL_ROLES = path.join(__dirname, 'parallel-roles.js');
const DEFAULT_MAX_PARALLEL = 4;
const WORKFLOW_FILE = path.join(RUNTIME_ROOT, 'ai', 'workflows', 'feature.yaml');
const TERMINAL_OK = new Set(['pass', 'skipped']);
const VALID_SCOPES = new Set(['auto', 'mobile', 'frontend', 'backend', 'all']);
const SUPPORTED_CONDITIONS = new Set(['mobile_or_ui_feature', 'behavior_preserving_refactor', 'whole_app_refactor', 'changed_since_build_test']);
const PR_STAGE = 'pull-request';
const PR_ROLE = 'pr-description';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
function workflow() { return yaml.load(fs.readFileSync(WORKFLOW_FILE, 'utf8')); }
function runDir(id) { return path.join(RUNS, id); }
function stateFile(id) { return path.join(runDir(id), 'state.json'); }
function engineDir(id) { return path.join(runDir(id), 'engine'); }
function scopeFile(id) { return path.join(engineDir(id), 'scope.json'); }
function preflightFile(id) { return path.join(engineDir(id), 'preflight.json'); }
function modeFile(id) { return path.join(engineDir(id), 'mode.json'); }
function loadState(id) { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { return null; } }
function phaseStatus(state, id) { return state?.phases?.[id]?.status || 'pending'; }
function depsSatisfied(stage, state) { return (stage.needs || []).every(dep => TERMINAL_OK.has(phaseStatus(state, dep))); }
function productRoot(id) {
  if (process.env.AI_WORKFLOW_PRODUCT_ROOT) return path.resolve(process.env.AI_WORKFLOW_PRODUCT_ROOT);
  const wt = id ? inspectWorktree(RUNTIME_ROOT, id) : null;
  return wt?.exists ? wt.path : PROJECT_ROOT;
}

function nextEligibleStage(wf, state) {
  for (const stage of wf.stages || []) {
    const status = phaseStatus(state, stage.id);
    if (TERMINAL_OK.has(status)) continue;
    if (['in_progress', 'fail', 'blocked'].includes(status)) return stage;
    if (status === 'pending' && depsSatisfied(stage, state)) return stage;
  }
  return null;
}

function spawnRaw(bin, args, options = {}) {
  const res = spawnSync(bin, args, {
    cwd: options.cwd || PROJECT_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: options.timeout || 65 * 60 * 1000,
  });
  if (options.print !== false) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  return res;
}
function command(bin, args, options = {}) {
  const res = spawnRaw(bin, args, options);
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${path.basename(bin)} ${args.join(' ')} failed with exit ${res.status}`);
  return res;
}
function runs(id, args, options = {}) {
  return command(process.execPath, [RUNS_TOOL, ...args], {
    ...options,
    env: { FEATURE_RUN_ID: id, AI_WORKFLOW_ENGINE: '1', AI_WORKFLOW_ACTOR: 'workflow-engine', ...(options.env || {}) },
  });
}
function ensureRun(id) { runs(id, ['start', id], { print: false }); }
function phase(id, action, phaseName, executor = '-', note = '') { return runs(id, [action, phaseName, executor, ...(note ? [note] : [])], { print: false }); }
function role(id, action, group, roleName, executor = '-', note = '') { return runs(id, [`role-${action}`, group, roleName, executor, ...(note ? [note] : [])], { print: false }); }
function selectRoles(id, group, roles) { return runs(id, ['select-roles', group, ...roles], { print: false }); }
function conditionalState(id, phaseName, roleName, status, reason) { return runs(id, ['conditional', phaseName, roleName, status, ...(reason ? [reason] : [])], { print: false }); }

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function detectStacks(root = PROJECT_ROOT) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return {
    android: fs.existsSync(path.join(root, 'android')),
    ios: fs.existsSync(path.join(root, 'ios')),
    flutter: fs.existsSync(path.join(root, 'pubspec.yaml')),
    reactNative: !!deps['react-native'],
    frontend: !!(deps.next || deps.react || deps.vite || deps.vue || deps['@angular/core'] || deps.svelte) && !deps['react-native'],
    backend: !!(deps.express || deps.fastify || deps.koa || deps['@nestjs/core']) || fs.existsSync(path.join(root, 'backend')) || fs.existsSync(path.join(root, 'server')) || fs.existsSync(path.join(root, 'api')) || fs.existsSync(path.join(root, 'manage.py')),
    docs: fs.existsSync(path.join(root, 'package.json')) || fs.existsSync(path.join(root, 'pubspec.yaml')),
  };
}

function inferScope(requestText, explicit) {
  if (explicit) {
    const scope = String(explicit).toLowerCase();
    if (!VALID_SCOPES.has(scope)) throw new Error(`invalid workflow scope "${scope}"; use auto, mobile, frontend, backend, or all`);
    return scope;
  }
  const text = String(requestText || '').toLowerCase();
  const matches = [];
  if (/\b(android|ios|flutter|react native|react-native|mobile|app screen|deep link|biometric)\b/.test(text)) matches.push('mobile');
  if (/\b(frontend|front-end|web app|browser|next\.js|nextjs|react web)\b/.test(text)) matches.push('frontend');
  if (/\b(backend|back-end|server|database|queue|microservice|django|fastapi|nestjs|api endpoint)\b/.test(text)) matches.push('backend');
  return matches.length === 1 ? matches[0] : 'auto';
}
function saveScope(id, scope) { fs.mkdirSync(engineDir(id), { recursive: true }); fs.writeFileSync(scopeFile(id), JSON.stringify({ scope }, null, 2) + '\n'); }
function readScope(id) { const data = readJson(scopeFile(id)); return data?.scope && VALID_SCOPES.has(data.scope) ? data.scope : 'auto'; }
function saveMode(id, mode) {
  fs.mkdirSync(engineDir(id), { recursive: true });
  const payload = { mode: mode.mode, reason: mode.reason, refactorScope: mode.refactorScope || null, scopeReason: mode.scopeReason || null, detectedAt: new Date().toISOString() };
  fs.writeFileSync(modeFile(id), JSON.stringify(payload, null, 2) + '\n');
  withStateLock(stateFile(id), () => {
    const state = loadState(id); if (!state) return;
    state.workflowMode = payload;
    state.history ||= [];
    state.history.push({ at: payload.detectedAt, actor: 'workflow-engine', kind: 'workflow-mode', to: payload.mode, reason: payload.reason });
    state.updatedAt = payload.detectedAt;
    writeJsonAtomic(stateFile(id), state);
  });
}
function readMode(id) {
  const state = loadState(id); if (state?.workflowMode?.mode) return state.workflowMode.mode;
  return readJson(modeFile(id))?.mode || 'feature';
}
function readRefactorScope(id) {
  const state = loadState(id); if (state?.workflowMode?.refactorScope) return state.workflowMode.refactorScope;
  return readJson(modeFile(id))?.refactorScope || null;
}

function doctorReport(scope) {
  const res = spawnSync(process.execPath, [DOCTOR, '--json', '--scope', scope], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30 * 1000 });
  let report = null;
  try { report = JSON.parse(res.stdout || '{}'); } catch { /* show human result below */ }
  if (res.error || res.status !== 0 || !report) {
    const human = spawnSync(process.execPath, [DOCTOR, '--scope', scope], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: 30 * 1000 });
    if (human.stdout) process.stdout.write(human.stdout);
    if (human.stderr) process.stderr.write(human.stderr);
    throw new Error(`workflow preflight failed for scope=${scope}; fix required prerequisites before workflow work starts`);
  }
  return report;
}
function preflight(id, scope, persist = true) {
  console.log(`Preflight: workflow doctor (scope=${scope})`);
  const report = doctorReport(scope);
  if (persist && id) { fs.mkdirSync(engineDir(id), { recursive: true }); fs.writeFileSync(preflightFile(id), JSON.stringify(report, null, 2) + '\n'); }
  console.log('Preflight: READY');
  return report;
}

function requestText(id) { try { return fs.readFileSync(path.join(runDir(id), '00-request.md'), 'utf8'); } catch { return ''; } }
// The commit the run's worktree was created from, read from its metadata (no
// git call). Changed-file lists diff against it, not HEAD: once the
// pull-request stage has committed, `git diff HEAD` is empty, and a rework
// after it would select too few reviewers or find "no changes".
function runBaseSha(id) {
  if (!id) return null;
  const meta = readJson(worktreeMetadataFile(RUNTIME_ROOT, id));
  return meta && !meta.removed && meta.baseSha ? meta.baseSha : null;
}
function changedFileList(root, baseSha = null) { return changedFiles(root, baseSha); }

// A role declared `requires_changes` has not done its job if the worktree is
// untouched, however the agent exited. Returns the reason, or null when fine.
function noopFailure(wf, roleName, worktree, baseSha = null) {
  if (!wf || !wf.roles || !wf.roles[roleName] || !wf.roles[roleName].requires_changes) return null;
  return changedFileList(worktree, baseSha).length ? null : `${roleName} reported success but changed no files in the worktree`;
}

// The tree a build/test run saw: HEAD plus the uncommitted diff and untracked files. null when git cannot say.
function treeFingerprint(root) { try { return `${gitSha(root)}:${workspaceFingerprint(root)}`; } catch { return null; } }
function testsTree(stage) { return stage.id === 'build-test' || stage.repeats === 'build-test'; }
// Build + Tests passed on this tree; a later change to it is tested again before verification.
function recordTestedTree(id, stageId, fingerprint, dirtied) { withStateLock(stateFile(id), () => { const state = loadState(id); if (!state) return; const at = new Date().toISOString(); state.testedWorkspace = { stage: stageId, fingerprint, at, ...(dirtied ? { dirtied: true } : {}) }; (state.history ||= []).push({ at, actor: 'workflow-engine', kind: 'tested-workspace', phase: stageId, fingerprint, dirtied: !!dirtied }); state.updatedAt = at; writeJsonAtomic(stateFile(id), state); }); }

function promoteArchitectureAsCode(id) {
  const source = runDir(id);
  const root = productRoot(id);
  const target = path.join(root, 'docs', 'architecture');
  const decisions = path.join(target, 'decisions', id);
  fs.mkdirSync(decisions, { recursive: true });

  const copy = (from, to) => {
    const sourceFile = path.join(source, from);
    if (!fs.existsSync(sourceFile)) throw new Error(`architecture promotion missing ${from}`);
    const targetFile = path.join(target, to);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(sourceFile, targetFile);
  };

  copy('05-architecture-assessment.md', path.join('decisions', id, 'assessment.md'));
  copy('05-architecture-assessment.json', path.join('decisions', id, 'assessment.json'));
  copy('05-architecture-options.md', path.join('decisions', id, 'options.md'));
  copy('05-architecture-options.json', path.join('decisions', id, 'options.json'));
  copy('05-architecture-selection.md', path.join('decisions', id, 'selection.md'));
  copy('05-architecture-selection.json', path.join('decisions', id, 'selection.json'));
  copy('05-target-architecture.md', 'target-architecture.md');
  copy('05-target-architecture.json', 'target-architecture.json');
  copy('05-c4-model.md', 'c4-model.md');
  copy('05-c4-model.json', 'c4-model.json');
  copy('05-architecture-migration.md', 'migration-plan.md');
  copy('05-architecture-migration.json', 'migration-plan.json');

  const c4 = readJson(path.join(source, '05-c4-model.json'));
  if (!c4?.structurizrDsl) throw new Error('architecture promotion requires Structurizr DSL');
  fs.writeFileSync(path.join(target, 'workspace.dsl'), c4.structurizrDsl.trim() + '\n');

  const index = [
    '# Architecture as code',
    '',
    `Generated from whole-app refactor run **${id}** after explicit human architecture selection.`,
    '',
    '- `target-architecture.md` — selected architecture contract and fitness functions',
    '- `c4-model.md` / `c4-model.json` — C4 model',
    '- `workspace.dsl` — Structurizr DSL source model',
    '- `migration-plan.md` — dependency/risk-aware migration waves',
    `- decisions/${id}/ — assessment, alternatives/trade-offs, and human decision evidence`,
    '',
    'The generated model is part of the implementation diff and should be reviewed/updated when architecture changes.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(target, 'README.md'), index);
}
function analysisRoles(wf, state, scope = 'auto', root = PROJECT_ROOT, id = null) {
  const existing = state?.selectedRoles?.analysis;
  if (Array.isArray(existing) && existing.length) return existing;
  const stage = wf.stages.find(x => x.id === 'analysis') || {};
  const selected = selectAnalysis({ allowedRoles: stage.roles || [], request: id ? requestText(id) : '', root, scope });
  if (id) { fs.mkdirSync(engineDir(id), { recursive: true }); fs.writeFileSync(path.join(engineDir(id), 'subagent-selection-analysis.json'), JSON.stringify(selected, null, 2) + '\n'); }
  return selected.roles;
}
function reviewRoles(wf, state, root = PROJECT_ROOT, id = null) {
  const existing = state?.selectedRoles?.reviews;
  if (Array.isArray(existing) && existing.length) return existing;
  const stage = wf.stages.find(x => x.id === 'reviews') || {};
  const candidates = [...new Set([...(stage.roles || []), ...(stage.selectable_roles || [])])].filter(r => wf.roles?.[r]);
  const selected = selectReviews({ allowedRoles: candidates, changedFiles: changedFileList(root, runBaseSha(id)), root });
  if (id && readMode(id)==='behavior_preserving_refactor' && candidates.includes('behavior-regression-review') && !selected.roles.includes('behavior-regression-review')) {
    selected.roles.push('behavior-regression-review');
    selected.reasons['behavior-regression-review']='behavior-preserving refactor requires independent before/after regression review';
  }
  if (id) { fs.mkdirSync(engineDir(id), { recursive: true }); fs.writeFileSync(path.join(engineDir(id), 'subagent-selection-reviews.json'), JSON.stringify(selected, null, 2) + '\n'); }
  return selected.roles;
}
function loadFindingArtifacts(id) {
  const dir = path.join(runDir(id), '05-analysis'); const out = [];
  try {
    for (const file of fs.readdirSync(dir).filter(x => x.endsWith('.json') && !/^synthesis|conflicts/.test(x)).sort()) {
      try { const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); if (Array.isArray(data.findings)) out.push({ agent: data.agent || file.replace(/\.json$/, ''), findings: data.findings }); } catch { /* non-finding artifact */ }
    }
  } catch { /* no analysis directory */ }
  return out;
}
// The conflicts the arbitration role declared, keyed to the specialists' own
// finding ids. Nothing else in the workflow can produce these: specialists run
// independently and never see each other's findings, so conflictsWith was
// always empty and detectConflicts could never fire on a real run.
function declaredConflicts(id) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir(id), '05-analysis', 'arbitration.json'), 'utf8')).conflicts || []; }
  catch { return []; }
}
function synthesizeAnalysis(id) {
  const sources = loadFindingArtifacts(id); if (!sources.length) return { findings: [], conflicts: [] };
  const findings = synthesize(sources);
  // Detection runs over the raw specialist findings, because those are the ids
  // the arbitration role quotes and the ids `agentic conflicts` resolves back to
  // a title and a recommendation.
  const raw = sources.flatMap(x => (x.findings || []).map(f => ({ ...f, agent: x.agent })));
  const byId = new Map(raw.map(f => [f.id, f]));
  for (const pair of declaredConflicts(id)) {
    const a = byId.get(pair.findingA), b = byId.get(pair.findingB);
    if (!a || !b || a === b) continue;
    const topic = String(pair.topic || 'disputed').toLowerCase();
    a.tags = [...new Set([...(a.tags || []), topic])];
    b.tags = [...new Set([...(b.tags || []), topic])];
    a.conflictsWith = [...new Set([...(a.conflictsWith || []), b.id])];
  }
  let conflicts = detectConflicts(raw);
  const dir = path.join(runDir(id), '05-analysis'); fs.mkdirSync(dir, { recursive: true });
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(dir, 'conflicts.json'), 'utf8')).conflicts || [];
    const resolved = new Map(previous.filter(x => x.status === 'resolved' && x.resolution).map(x => [x.findings.slice().sort().join('|'), x]));
    // Carry the decision, never the old id: ids are renumbered here, and an old
    // id on a carried decision can name a different, still open, pair.
    conflicts = conflicts.map(x => { const prev = resolved.get(x.findings.slice().sort().join('|')); return prev ? { ...x, status: 'resolved', resolution: prev.resolution } : x; });
  } catch { /* first synthesis */ }
  fs.writeFileSync(path.join(dir, 'synthesis.json'), JSON.stringify({ version: 1, findings }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'conflicts.json'), JSON.stringify({ schemaVersion: 1, conflicts }, null, 2) + '\n');
  return { findings, conflicts };
}

function classifyMobileEvidence(id) {
  const state = loadState(id);
  const requirement = state?.evidence?.mobileScreenshots?.requirement || 'unclassified';
  if (requirement !== 'unclassified') return;
  const s = detectStacks(productRoot(id));
  const scope = readScope(id);
  const mobileStack = s.android || s.ios || s.flutter || s.reactNative;
  const mobile = scope === 'mobile' || ((scope === 'auto' || scope === 'all') && mobileStack);
  runs(id, ['evidence', mobile ? 'required' : 'not-required', mobile ? `engine: mobile scope/stack detected (${scope})` : `engine: workflow scope=${scope} does not require mobile evidence`], { print: false });
}
function evaluateCondition(name, id, state) {
  if (!SUPPORTED_CONDITIONS.has(name)) return { known: false, value: false, reason: `unknown condition ${name}` };
  if (name === 'behavior_preserving_refactor') {
    const value = readMode(id) === 'behavior_preserving_refactor';
    return { known: true, value, reason: value ? 'behavior-preserving refactor mode' : 'normal feature mode' };
  }
  if (name === 'whole_app_refactor') {
    const value = readMode(id) === 'behavior_preserving_refactor' && readRefactorScope(id) === 'whole_app';
    return { known: true, value, reason: value ? 'whole-app behavior-preserving refactor' : 'not a whole-app refactor' };
  }
  if (name === 'changed_since_build_test') {
    // Legacy only (the rule progress.js uses): a run verified before this stage existed.
    // A stage that exists (reset by a rework of fixes) compares the tree.
    if (!state?.phases?.['post-fix-build-test'] && TERMINAL_OK.has(phaseStatus(state, 'verification'))) return { known: true, value: false, reason: 'verification passed before the post-fix re-run existed' };
    const tested = state?.testedWorkspace?.fingerprint, current = treeFingerprint(productRoot(id));
    if (!tested || !current) return { known: true, value: true, reason: tested ? 'the worktree fingerprint cannot be read' : 'no record of the tree Build + Tests passed on' };
    return current === tested ? { known: true, value: false, reason: `fixes changed no files since ${state.testedWorkspace.stage} passed` } : { known: true, value: true, reason: `the worktree changed after ${state.testedWorkspace.stage} passed` };
  }
  if (name === 'mobile_or_ui_feature') {
    const requirement = state?.evidence?.mobileScreenshots?.requirement || 'unclassified';
    if (requirement === 'required') return { known: true, value: true, reason: 'mobile evidence explicitly required' };
    if (requirement === 'not-required') return { known: true, value: false, reason: state.evidence.mobileScreenshots.reason || 'mobile evidence explicitly not required' };
    const s = detectStacks(productRoot(id));
    const scope = readScope(id);
    const mobileStack = s.android || s.ios || s.flutter || s.reactNative;
    const value = scope === 'mobile' || ((scope === 'auto' || scope === 'all') && mobileStack);
    return { known: true, value, reason: value ? `scope=${scope} with mobile stack` : `scope=${scope} without mobile requirement` };
  }
  return { known: false, value: false, reason: `unsupported condition ${name}` };
}

function artifactContext(id, stage) {
  const dir = runDir(id);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d\d-.*\.md$/.test(f)).sort() : [];
  const sections = [];
  for (const file of files) {
    if (file === stage.artifact) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    sections.push(`## ${file}\n${text.slice(0, 16000)}`);
  }
  return sections.join('\n\n');
}
// Selftest hook: with AI_WORKFLOW_SELFTEST=1, AI_WORKFLOW_TEST_EXECUTOR names a
// script that stands in for router.js (same arguments), so the engine selftest
// can drive real stages without an agent. Ignored unless both are set.
function executorScript(env = process.env) {
  return env.AI_WORKFLOW_SELFTEST === '1' && env.AI_WORKFLOW_TEST_EXECUTOR ? path.resolve(env.AI_WORKFLOW_TEST_EXECUTOR) : ROUTER;
}
function promptFile(id, stageId, roleName) { const dir = engineDir(id); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, `${stageId}-${roleName}.md`); }
function structuredSchema(wf, stage, roleName) { return stage.artifact_schema || wf.roles?.[roleName]?.artifact_schema || null; }

function executeRole(id, wf, stage, roleName, output) {
  assertRequiredMcps(roleName);
  const prompt = promptFile(id, stage.id, roleName);
  const schemaName = structuredSchema(wf, stage, roleName);
  if (schemaName && !output) throw new Error(`${stage.id}/${roleName}: structured artifact schema ${schemaName} requires an artifact path`);
  const structuredInstruction = schemaName ? `\nThis stage is machine-gated. Return ONLY one JSON object, with no Markdown fence or prose. It MUST match this JSON Schema exactly enough for validation and MUST use runId "${id}". The runtime will validate it, save the .json sidecar, and render the human-readable Markdown.\n\nJSON Schema:\n${schemaContract(schemaName)}\n` : '';
  const refactorInstruction = readMode(id)==='behavior_preserving_refactor' && roleName==='implementation'
    ? `\nRefactor mode is active. Execute the approved refactorIncrements strictly in order. After each logical increment, run its required verification and record evidence with:\nnode ${path.join(RUNTIME_ROOT,'ai','workflow','refactor-checkpoints.js')} record ${id} <increment-id> --diff "<git diff reference or summary>" --test "<verification command/result>"\nDo not combine business/UI redesign with mechanical restructuring and do not continue to the next increment until the current checkpoint is recorded.\n`
    : '';
  const body = `# Deterministic workflow assignment\n\nRun: ${id}\nStage: ${stage.id}\nRole: ${roleName}\nScope: ${readScope(id)}\nProduct worktree: ${productRoot(id)}\n\nThe workflow engine owns state. Perform only this stage responsibility. Do not advance stages or approve gates.\n${output ? schemaName ? `Return the structured artifact for ${output}.` : `Write your final stage artifact as the response; the engine stores it at ${output}.` : ''}${structuredInstruction}${refactorInstruction}\n${buildRoleContext({ runDir: runDir(id), productRoot: productRoot(id), contract: roleContract(roleName), excludeArtifact: output, roleName, stageId: stage.id, baseSha: runBaseSha(id) })}\n`;
  fs.writeFileSync(prompt, body);

  const policy = resolveExecutionPolicy(wf, stage, roleName);
  const state = loadState(id) || {};
  const previous = attemptsFor(state, stage.id, roleName);
  const worktree = productRoot(id);
  const result = executeWithPolicy(policy, previous, ({ executor, attemptNumber, timeoutMs }) => {
    const attemptId = `${id}-${stage.id}-${roleName}-${attemptNumber}-${Date.now()}`;
    const rawOutput = output ? path.join(engineDir(id), `${stage.id}-${roleName}-${attemptNumber}.raw`) : null;
    let artifactStatus = null;
    if (rawOutput) { try { fs.unlinkSync(rawOutput); } catch { /* clean prior temp */ } }
    const args = [executorScript(), 'exec', 'feature', roleName, '--agent', executor, '--prompt-file', prompt, '--cwd', worktree, '--timeout-min', String(Math.max(1, Math.ceil(timeoutMs / 60000)))];
    if (rawOutput) args.push('--output-file', rawOutput);
    const child = spawnRaw(process.execPath, args, {
      env: { FEATURE_RUN_ID: id, AI_WORKFLOW_ENGINE: '1', AI_WORKFLOW_SCOPE: readScope(id), AI_WORKFLOW_ATTEMPT_ID: attemptId, AI_WORKFLOW_PRODUCT_ROOT: worktree, AI_WORKFLOW_RUNTIME_ROOT: RUNTIME_ROOT, AI_WORKFLOW_PROJECT_ROOT: PROJECT_ROOT, AI_WORKFLOW_STATE_ROOT: RUNS },
      timeout: timeoutMs + 15000,
    });
    if (child.error || child.status !== 0) {
      const exitType = classifyFailure(child);
      if (rawOutput) { try { fs.unlinkSync(rawOutput); } catch { /* no output */ } }
      // A timeout says so in words: Node's own "spawnSync <node> ETIMEDOUT" names
      // neither the agent nor the cause, and repeated-failure.js does not compare it.
      const reason = exitType === 'timeout' ? `${executor} timed out after ${Math.max(1, Math.ceil(timeoutMs / 60000))} min`
        : child.error?.message || `${executor} exited ${child.status ?? child.signal}`;
      return { ok: false, exitType, reason, attemptId };
    }
    try {
      if (output) {
        if (!rawOutput || !fs.existsSync(rawOutput)) throw new Error(`${executor} produced no artifact output`);
        const markdownFile = path.join(runDir(id), output);
        if (schemaName) {
          // The plan must cite every resolved conflict. Checked inside the attempt, so a
          // miss is a deterministic attempt failure whose reason `retry` hands back.
          materialize(schemaName, fs.readFileSync(rawOutput, 'utf8'), sidecarForMarkdown(markdownFile), markdownFile, id, stage.id === 'plan' ? { conflictIds: resolvedConflicts(runDir(id)).map(c => c.id) } : {});
          try { artifactStatus = JSON.parse(fs.readFileSync(sidecarForMarkdown(markdownFile), 'utf8')).status || null; } catch { artifactStatus = null; }
        }
        else { fs.mkdirSync(path.dirname(markdownFile), { recursive: true }); fs.copyFileSync(rawOutput, markdownFile); }
      }
      // An agent that exits 0 having written nothing has not done the work, and
      // reporting success is the worst failure mode here: the configured fallback
      // never engages, and the run only breaks at a later gate with a confusing
      // message. Seen for real when codex could not run Flutter under its sandbox
      // and correctly refused to edit code — while the role still recorded a pass.
      // Classified unavailable, which is retryable, so the next candidate executor
      // gets the work.
      const noop = noopFailure(wf, roleName, worktree, runBaseSha(id));
      if (noop) return { ok: false, exitType: 'unavailable', reason: noop, attemptId };
      refreshWorktree(RUNTIME_ROOT, id);
      return { ok: true, value: { executor, attemptId, artifactStatus }, attemptId };
    } catch (error) {
      // Keep what the agent actually produced. Without it a rejected artifact is
      // undiagnosable: you cannot tell a failing build from malformed output.
      let kept = null;
      if (rawOutput && fs.existsSync(rawOutput)) {
        const target = path.join(engineDir(id), `${stage.id}-${roleName}.rejected`);
        try { fs.copyFileSync(rawOutput, target); kept = target; } catch { kept = null; }
      }
      const where = kept ? ` — agent output kept at ${path.relative(PROJECT_ROOT, kept)}` : '';
      return { ok: false, exitType: 'deterministic', reason: `artifact/worktree validation failed: ${error.message}${where}`, attemptId };
    } finally { if (rawOutput) { try { fs.unlinkSync(rawOutput); } catch { /* best effort */ } } }
  }, entry => recordAttempt(RUNTIME_ROOT, id, stage.id, roleName, entry));

  if (!result.ok) throw new Error(`${stage.id}/${roleName}: ${result.reason}`);
  if (result.skipped) {
    const all = attemptsFor(loadState(id) || {}, stage.id, roleName);
    return { executor: all.at(-1)?.executor || policy.candidates[0], resumed: true };
  }
  return result.value || { executor: result.attempts.at(-1)?.executor || policy.candidates[0] };
}

// A stopped stage or role whose recorded attempts the execution policy will not
// extend (a deterministic failure, attempts used up) gets nowhere on a plain
// resume: beginning it again only swaps its real reason for "max attempts
// exhausted" and tells the human a second time. It stays as it is, with its
// reason, until `retry` resets it. Returns why, or null when it may run.
function spentAttempts(wf, stage, roleName, state) {
  const decision = resumeDecision(resolveExecutionPolicy(wf, stage, roleName), attemptsFor(state || {}, stage.id, roleName));
  return !decision.allowed && !decision.complete ? decision.reason : null;
}
function retryHint(id) { return commandFor('retry', id, process.env.AI_AGENTIC_CLI === '1'); }

// One role of a parallel stage: begin, execute, then complete, block or fail.
// The sequential loop and each `run-role` child of a concurrent stage both run
// exactly this, so the two paths cannot drift apart.
function runRole(id, wf, stage, roleName) {
  const status = loadState(id)?.roles?.[stage.id]?.[roleName]?.status || 'pending';
  if (TERMINAL_OK.has(status)) return status;
  const preferredExecutor = (wf.roles[roleName] || {}).executor || '-';
  role(id, 'begin', stage.id, roleName, preferredExecutor, 'engine execution');
  try {
    const execution = executeRole(id, wf, stage, roleName, (wf.roles[roleName] || {}).artifact);
    // A specialist that reports blockers has done its job: its artifact is kept
    // and the role is marked blocked, so the findings survive for the human
    // instead of being discarded as an invalid artifact.
    if (execution.artifactStatus === 'blocked') { role(id, 'block', stage.id, roleName, execution.executor || preferredExecutor, 'specialist reported blockers — see its findings'); return 'blocked'; }
    role(id, 'complete', stage.id, roleName, execution.executor || preferredExecutor, 'engine completed role');
    return 'pass';
  } catch (e) {
    role(id, 'fail', stage.id, roleName, preferredExecutor, e.message.slice(0, 180));
    throw e;
  }
}

// How many roles of a parallel stage may run at once: the stage's optional
// `max_parallel`, else AI_WORKFLOW_MAX_PARALLEL, else 4. A value that is not a
// whole number >= 1 falls back to 1 (the old one-at-a-time behaviour), loudly.
function parallelCap(stage, env = process.env, warn = message => console.warn(message)) {
  const fromStage = stage?.max_parallel !== undefined && stage.max_parallel !== null;
  const raw = fromStage ? stage.max_parallel : env.AI_WORKFLOW_MAX_PARALLEL;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_PARALLEL;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1) return value;
  warn(`⚠ ${fromStage ? `${stage.id}.max_parallel` : 'AI_WORKFLOW_MAX_PARALLEL'}=${JSON.stringify(raw)} is not a whole number >= 1; running ${stage?.id || 'stage'} roles one at a time`);
  return 1;
}

// Roles that read what their siblings in the same stage produced cannot run
// beside them: behavior-regression-review takes validated_review_findings, the
// other reviews' artifacts. Any role whose contract declares such an input runs
// after the concurrent batch, one at a time, in selection order.
const SIBLING_INPUTS = new Set(['validated_review_findings']);
function readsSiblingOutputs(roleName, contractFor = roleContract) {
  let contract;
  try { contract = contractFor(roleName); } catch { return false; }
  return (contract?.inputs || []).some(input => SIBLING_INPUTS.has(input));
}
function splitSequentialTail(roles, contractFor = roleContract) {
  const tail = roles.filter(roleName => readsSiblingOutputs(roleName, contractFor));
  return { batch: roles.filter(roleName => !tail.includes(roleName)), tail };
}

// While the helper runs it holds its pid here; `runs.js retry` reads it and
// refuses to reset roles of this stage that a live pool is still running.
function parallelPidFile(id, stageId) { return path.join(engineDir(id), `${stageId}-parallel.pid`); }
// Beside it, the process group of every role the helper started.
function parallelPgidFile(id, stageId) { return path.join(engineDir(id), `${stageId}-parallel.pgids`); }

// Runs `pending` roles as concurrent `engine.js run-role` children through the
// async helper, at most `cap` at once, and returns its per-role summary.
function runRolesConcurrently(id, wf, stage, pending, cap) {
  const summaryFile = path.join(engineDir(id), `${stage.id}-parallel-summary.json`);
  const pidFile = parallelPidFile(id, stage.id);
  const pgidFile = parallelPgidFile(id, stage.id);
  fs.mkdirSync(engineDir(id), { recursive: true });
  for (const file of [summaryFile, pgidFile]) { try { fs.unlinkSync(file); } catch { /* first run */ } }
  const res = spawnSync(process.execPath, [PARALLEL_ROLES, 'run', id, stage.id, '--cap', String(cap), '--summary-file', summaryFile, '--pid-file', pidFile, '--pgid-file', pgidFile, ...pending], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, FEATURE_RUN_ID: id, AI_WORKFLOW_ENGINE: '1', AI_WORKFLOW_PRODUCT_ROOT: productRoot(id), AI_WORKFLOW_RUNTIME_ROOT: RUNTIME_ROOT, AI_WORKFLOW_PROJECT_ROOT: PROJECT_ROOT, AI_WORKFLOW_STATE_ROOT: RUNS },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const summary = readJson(summaryFile);
  const complete = summary && Array.isArray(summary.results);
  // No summary: the helper was killed outright (SIGKILL, OOM) and could not stop
  // its roles. Their groups — run-role, router.js, the agent — would otherwise
  // run on unattended, so stop them here before recording the roles as failed.
  if (!complete) {
    const left = stopGroupsSync(readJson(pgidFile) || []);
    if (left.length) console.error(`⚠ ${stage.id}: role process group(s) ${left.join(', ')} did not exit after SIGKILL`);
  }
  for (const file of [pidFile, pgidFile]) { try { fs.unlinkSync(file); } catch { /* the helper removed it */ } }
  const interrupted = res.error ? `could not run roles in parallel: ${res.error.message}`
    : !complete ? `parallel role runner exited ${res.status ?? res.signal} without a summary`
    : res.status !== 0 ? `parallel role runner was interrupted (${summary.interrupted || `exit ${res.status}`}); resume the run to continue`
    : null;
  if (interrupted) {
    // A role still in_progress here was stopped mid-run and nothing recorded it
    // (the helper itself was killed). Fail it, so `resume` can begin it again
    // and `retry` resets it, instead of the stage looking busy forever.
    const why = complete && summary.interrupted ? summary.interrupted : res.signal || (res.error ? 'runner error' : `runner exit ${res.status}`);
    const state = loadState(id);
    for (const roleName of pending) {
      if (state?.roles?.[stage.id]?.[roleName]?.status !== 'in_progress') continue;
      try { role(id, 'fail', stage.id, roleName, (wf.roles[roleName] || {}).executor || '-', `interrupted: ${why}`); } catch { /* keep the original failure */ }
    }
    throw new Error(`${stage.id}: ${interrupted}`);
  }
  return summary;
}

function executeParallel(id, wf, stage) {
  let state = loadState(id);
  const scope = readScope(id);
  const roles = stage.id === 'analysis' ? analysisRoles(wf, state, scope, productRoot(id), id) : stage.id === 'reviews' ? reviewRoles(wf, state, productRoot(id), id) : (state?.selectedRoles?.[stage.id] || stage.roles || []);
  if (!roles.length) throw new Error(`${stage.id}: no roles selected`);
  if (!Array.isArray(state?.selectedRoles?.[stage.id]) || !state.selectedRoles[stage.id].length) selectRoles(id, stage.id, roles);
  state = loadState(id);
  const roleStatus = (s, roleName) => s?.roles?.[stage.id]?.[roleName]?.status || 'pending';
  const { batch, tail } = splitSequentialTail(roles);
  const spent = batch.filter(roleName => ['fail', 'blocked'].includes(roleStatus(state, roleName)) && spentAttempts(wf, stage, roleName, state));
  const pending = batch.filter(roleName => !TERMINAL_OK.has(roleStatus(state, roleName)) && !spent.includes(roleName));
  const cap = pending.length > 1 ? parallelCap(stage) : 1;
  if (cap <= 1 || pending.length <= 1) {
    for (const roleName of batch) if (!spent.includes(roleName)) runRole(id, wf, stage, roleName);
  } else {
    const summary = runRolesConcurrently(id, wf, stage, pending, cap);
    state = loadState(id);
    const failed = [];
    for (const result of summary.results.filter(r => !r.ok)) {
      const how = result.signal ? `signal ${result.signal}` : result.error ? result.error : `exit ${result.exitCode}`;
      // A child that died before recording its own failure leaves the role
      // in_progress; record it, so the run shows why and `retry` resets it.
      if (roleStatus(state, result.role) === 'in_progress') {
        try { role(id, 'fail', stage.id, result.role, (wf.roles[result.role] || {}).executor || '-', `run-role ${how}`); } catch { /* keep the original failure */ }
      }
      failed.push(`${result.role} (${String(loadState(id)?.roles?.[stage.id]?.[result.role]?.note || how).replace(/\s+/g, ' ').slice(0, 180)})`);
    }
    if (failed.length) throw new Error(`${stage.id}: ${failed.length} of ${pending.length} role(s) failed: ${failed.join('; ')}`);
  }
  // A role left as it was: the error keeps each one's own reason and says how to reset it.
  const notReattempted = names => {
    state = loadState(id);
    const notes = names.map(roleName => `${roleName} (${String(state?.roles?.[stage.id]?.[roleName]?.note || roleStatus(state, roleName)).replace(/\s+/g, ' ').slice(0, 180)})`);
    return new Error(`${stage.id}: ${notes.join('; ')} — not re-attempted on resume (${spentAttempts(wf, stage, names[0], state)}); reset with: ${retryHint(id)}`);
  };
  if (spent.length) throw notReattempted(spent);
  // Only once every sibling has passed: these roles read the siblings' artifacts.
  if (tail.length) {
    state = loadState(id);
    const unfinished = batch.filter(roleName => !TERMINAL_OK.has(roleStatus(state, roleName)));
    if (unfinished.length) throw new Error(`${stage.id}: ${unfinished.map(r => `${r}=${roleStatus(state, r)}`).join(', ')}; ${tail.join(', ')} waits until they pass`);
    // The same rule as the batch: a tail role whose attempts are spent is not
    // begun again (that would swap its reason for "max attempts exhausted").
    const spentTail = tail.filter(roleName => ['fail', 'blocked'].includes(roleStatus(state, roleName)) && spentAttempts(wf, stage, roleName, state));
    for (const roleName of tail) if (!spentTail.includes(roleName)) runRole(id, wf, stage, roleName);
    if (spentTail.length) throw notReattempted(spentTail);
  }
  state = loadState(id);
  if (!TERMINAL_OK.has(phaseStatus(state, stage.id))) throw new Error(`${stage.id}: selected roles did not reach a successful terminal state`);
  if (stage.id === 'analysis') synthesizeAnalysis(id);
}

// `engine.js run-role <id> <stage> <role>`: one role of a parallel stage, run
// as its own process by parallel-roles.js. Internal; not a user command.
function runRoleCommand(id, stageId, roleName) {
  const wf = workflow();
  const stage = (wf.stages || []).find(x => x.id === stageId);
  if (!stage || stage.strategy !== 'parallel') throw new Error(`run-role: ${stageId} is not a parallel stage`);
  const state = loadState(id);
  if (!state) throw new Error(`run ${id} does not exist`);
  if (!(state.selectedRoles?.[stageId] || []).includes(roleName)) throw new Error(`run-role: ${roleName} was not selected for ${stageId}`);
  const watcher = watchRunner();
  try {
    const result = runRole(id, wf, stage, roleName);
    console.log(`${id} ${stageId}/${roleName} → ${result}`);
  } finally { try { watcher?.kill('SIGKILL'); } catch { /* already gone */ } }
}
// run-role blocks in spawnSync, so it cannot watch its parent itself. When the
// parallel helper started it (as the leader of its own process group), it starts
// `parallel-roles.js watch` inside that group: if the helper is killed outright,
// the watcher stops this role, router.js and the agent instead of leaving them
// running unattended.
function watchRunner(env = process.env) {
  if (env[RUNNER_ENV] !== String(process.ppid)) return null;
  const watcher = spawn(process.execPath, [PARALLEL_ROLES, 'watch', String(process.ppid), String(process.pid)], { stdio: 'ignore' });
  watcher.on('error', () => { /* best effort: the engine still stops the group */ });
  watcher.unref();
  return watcher;
}

// Why a runtime tool failed, in its own words: the last "✗ ..." it printed and
// the lines after it. Its exit status alone says nothing, and the same
// "failed with exit 1" every time would read as a repeated failure.
function toolFailure(res, name) {
  const lines = String(res.stderr || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const at = lines.map(line => line.startsWith('✗ ')).lastIndexOf(true);
  return at >= 0 ? lines.slice(at).join(' ').slice(2, 400) : `${name} exited ${res.error ? res.error.message : res.status ?? res.signal}`;
}

function executeConditional(id, wf, stage) {
  if (!stage.conditional_role) return 'none';
  const state = loadState(id);
  const roleName = stage.conditional_role;
  const existing = state?.conditionals?.[stage.id]?.[roleName]?.status;
  if (existing === 'pass' || existing === 'skipped') return existing;
  const result = evaluateCondition(stage.condition, id, state);
  if (!result.known) { conditionalState(id, stage.id, roleName, 'blocked', result.reason); throw new Error(`${stage.id}: ${result.reason}`); }
  if (!result.value) { conditionalState(id, stage.id, roleName, 'skipped', result.reason); return 'skipped'; }
  try {
    if (roleName === 'mobile-evidence') {
      classifyMobileEvidence(id);
      const fresh = loadState(id);
      if (fresh?.evidence?.mobileScreenshots?.requirement !== 'required') throw new Error('mobile condition is true but evidence is not classified as required');
      if (fresh?.evidence?.mobileScreenshots?.execution?.status !== 'pass') {
        const worktree = productRoot(id);
        const res = spawnRaw(process.execPath, [MOBILE_EVIDENCE, 'run', id], { env: { FEATURE_RUN_ID: id, AI_WORKFLOW_SCOPE: readScope(id), AI_WORKFLOW_ENGINE: '1', AI_WORKFLOW_PRODUCT_ROOT: worktree, AI_WORKFLOW_RUNTIME_ROOT: RUNTIME_ROOT, AI_WORKFLOW_PROJECT_ROOT: PROJECT_ROOT, AI_WORKFLOW_STATE_ROOT: RUNS } });
        if (res.error || res.status !== 0) throw new Error(toolFailure(res, 'mobile-evidence'));
      }
    } else executeRole(id, wf, stage, roleName, (wf.roles[roleName] || {}).artifact);
    conditionalState(id, stage.id, roleName, 'pass', result.reason);
    return 'pass';
  } catch (e) { conditionalState(id, stage.id, roleName, 'blocked', e.message.slice(0, 180)); throw e; }
}

// ---------------------------------------------------------------- pull request
// The last stage. pr-description (an agent, read-only) writes the title and
// body; everything that leaves the machine is pull-request.js. It is opt-in:
// with pull_request.enabled not true in the project's .agentic/config.yaml the
// stage is skipped and says how to open the PR by hand. `when:` cannot express
// that, because a false `when` skips before anything else runs and `agentic pr`
// could then never override it.
function prHint(id) { return process.env.AI_AGENTIC_CLI === '1' ? `agentic pr ${id}` : `node ai/workflow/engine.js pr ${id}`; }
function prOptionsFor(state, extra) {
  return pullRequest.effectiveOptions(pullRequest.loadConfig(PROJECT_ROOT), { ...(state?.pullRequestOptions || {}), ...(extra || {}) });
}
// The existing worktree, or null. Unlike ensureRunWorktree this never creates
// one: a cleaned-up run has nothing left to commit.
function prWorktree(id) {
  const wt = inspectWorktree(RUNTIME_ROOT, id);
  return wt && wt.exists && !wt.removed ? wt : null;
}
function recordPullRequest(id, patch, entry) {
  withStateLock(stateFile(id), () => {
    const state = loadState(id); if (!state) return;
    const at = new Date().toISOString();
    if (patch) {
      const previous = state.pullRequest && state.pullRequest.branch === patch.branch ? state.pullRequest : null;
      state.pullRequest = { ...(previous || {}), ...patch, createdAt: previous?.createdAt || at, updatedAt: at };
    }
    state.history ||= [];
    state.history.push({ at, actor: 'workflow-engine', kind: 'pull-request', ...entry });
    state.updatedAt = at;
    writeJsonAtomic(stateFile(id), state);
  });
}
function clearRoleAttempts(id, stageId, roleName) {
  withStateLock(stateFile(id), () => {
    const state = loadState(id);
    if (!state?.executionAttempts?.[stageId]?.[roleName]) return;
    delete state.executionAttempts[stageId][roleName];
    if (!Object.keys(state.executionAttempts[stageId]).length) delete state.executionAttempts[stageId];
    writeJsonAtomic(stateFile(id), state);
  });
}
function prDescriptionFile(id, wf) { return sidecarForMarkdown(path.join(runDir(id), wf.roles[PR_ROLE].artifact)); }
function validPrDescription(id, wf) {
  const file = prDescriptionFile(id, wf);
  return validateArtifactFile('pull-request', file, id).length ? null : readJson(file);
}
// A description that is already written and valid is reused, so a resume after
// a failed push or API call does not pay for, or change, the text again. To
// have it rewritten, delete 12-pull-request.json and run `agentic pr <id>`.
function prDescription(id, wf, stage, worktree) {
  const template = prTemplate(worktree);
  const fits = data => data && (!template || data.template);
  let data = validPrDescription(id, wf);
  if (fits(data)) return data;
  // A passing attempt on record would make the execution policy skip the role.
  clearRoleAttempts(id, stage.id, PR_ROLE);
  executeRole(id, wf, stage, PR_ROLE, wf.roles[PR_ROLE].artifact);
  data = validPrDescription(id, wf);
  if (!data) throw new Error(`pr-description wrote no valid ${path.basename(prDescriptionFile(id, wf))}`);
  if (!fits(data)) throw new Error(`the description does not fill the repository's PR template ${template.path}; resume to have it written again`);
  return data;
}
function executePullRequest(id, wf, stage) {
  const state = loadState(id);
  const status = phaseStatus(state, stage.id);
  const skip = reason => {
    if (['blocked', 'fail'].includes(status)) phase(id, 'begin', stage.id, 'workflow-engine', 'reconsidering the pull request');
    phase(id, 'skip', stage.id, 'workflow-engine', reason);
    console.log(`${id}: pull request skipped — ${reason}`);
    return 'skipped';
  };
  if (pullRequest.evalMode()) return skip('eval mode (AI_EVAL=1): the runtime never commits, pushes or opens a pull request');
  const options = prOptionsFor(state);
  // A closed run is finished. Resuming it must not open a PR on its own (for a
  // run closed before 1.9.31 a human may well have opened one by hand); only
  // `agentic pr <id> --reopen` does that.
  if (state?.status === 'done' && !options.manual) return skip(`the run is closed — open its pull request on request with: ${prHint(id)} --reopen`);
  if (!options.enabled) return skip(`pull_request.enabled is not true in .agentic/config.yaml${options.problems.length ? ` (${options.problems.join('; ')})` : ''} — open it by hand with: ${prHint(id)}`);
  const executor = (wf.roles[PR_ROLE] || {}).executor || '-';
  // in_progress means an engine stopped mid-stage (killed, crashed). Every step
  // of the stage can be repeated, so it carries on instead of failing to begin.
  if (status === 'in_progress') console.log(`${id}: carrying on with an interrupted pull-request stage`);
  else phase(id, 'begin', stage.id, executor, options.manual ? 'opening the pull request (requested with agentic pr)' : 'opening the pull request');
  try {
    if (phaseStatus(state, 'verification') !== 'pass') throw new Error(`verification is ${phaseStatus(state, 'verification')}; a pull request opens only after it passes`);
    if (options.problems.length) throw new Error(`.agentic/config.yaml: ${options.problems.join('; ')}`);
    const wt = prWorktree(id);
    if (!wt) throw new Error('the run worktree no longer exists (cleaned up?), so there is nothing to commit; nothing was pushed');
    const ctx = { id, worktree: wt.path, meta: wt, options, runtimeRoot: RUNTIME_ROOT, bodyFile: path.join(engineDir(id), 'pull-request-body.md'), record: (patch, entry) => recordPullRequest(id, patch, entry), log: message => console.log(message) };
    // Cheap checks first: no agent is paid for when the remote, the base or the
    // credentials would stop the PR anyway.
    const ready = pullRequest.preflight(ctx);
    if (!ready.ok) throw new Error(ready.reason);
    ctx.description = prDescription(id, wf, stage, wt.path);
    const result = pullRequest.deliver(ctx);
    if (result.status !== 'pass') throw new Error(result.reason);
    refreshWorktree(RUNTIME_ROOT, id);
    const pr = result.pullRequest;
    const line = `pull request ${pr.number ? `#${pr.number} ` : ''}${pr.url}${pr.reused ? ' (already open)' : ''}${(pr.warnings || []).length ? ` — warning: ${pr.warnings.join('; ')}` : ''}`;
    phase(id, 'complete', stage.id, executor, line);
    console.log(`${id}: ${line}`);
    return 'pass';
  } catch (e) {
    const reason = pullRequest.redact(e.message);
    try { recordPullRequest(id, null, { action: 'block', reason: reason.slice(0, 300) }); } catch { /* keep the original error */ }
    try { phase(id, 'block', stage.id, 'workflow-engine', reason.slice(0, 300)); } catch { /* keep the original error */ }
    throw new Error(`${stage.id}: ${reason}`);
  }
}
// `agentic pr <id> [--base B] [--branch N] [--draft] [--dry-run]`: the stage on
// a human's request. It works while the config block is disabled, and stores
// the overrides in the run state (runs.js pull-request-options) so a later
// resume opens the same PR. Stacked PRs pass another PR's branch as --base.
const PR_FLAGS = ['base', 'branch', 'draft', 'dry-run', 'reopen'];
const PR_USAGE = 'usage: agentic pr <id> [--base <branch>] [--branch <name>] [--draft] [--dry-run] [--reopen]';
// A mistyped flag must not fall through to the real thing: `--dryrun` meant
// as a preview would otherwise commit, push and open the PR.
function prArgsProblem(args) {
  const extra = (args._ || []).slice(2);
  if (extra.length) return `unexpected argument ${JSON.stringify(extra[0])}${extra[0].startsWith('-') ? ' (options start with --)' : ' (the base is passed as --base <branch>)'}`;
  for (const key of Object.keys(args)) {
    if (key === '_' || PR_FLAGS.includes(key)) continue;
    const plain = key.split('=')[0].toLowerCase().replace(/[_\s]/g, '-');
    const near = PR_FLAGS.find(f => f === plain || f.replace(/-/g, '') === plain.replace(/-/g, ''));
    return `unknown option --${key}${near ? ` (did you mean --${near}${key.includes('=') ? ' without "="' : ''}?)` : ''}`;
  }
  if (args.reopen !== undefined && args.reopen !== true) return '--reopen takes no value';
  if (args['dry-run'] !== undefined && args['dry-run'] !== true) return '--dry-run takes no value';
  return null;
}
function pullRequestCommand(id, args = {}) {
  const problem = prArgsProblem(args);
  if (problem) throw new Error(`${problem}\n${PR_USAGE}`);
  const state = loadState(id);
  if (!state) throw new Error(`run ${id} does not exist`);
  if (state.status === 'done' && !args.reopen && !args['dry-run']) throw new Error(`run ${id} is closed${state.abandoned ? ' (abandoned)' : ''}; a pull request may already exist for it (opened by hand). Check first, then open one anyway with: ${prHint(id)} --reopen`);
  const wf = workflow();
  const stage = (wf.stages || []).find(s => s.id === PR_STAGE);
  if (!stage) throw new Error(`the workflow has no ${PR_STAGE} stage`);
  const overrides = {};
  if (args.base !== undefined) { if (typeof args.base !== 'string' || !pullRequest.validRef(args.base)) throw new Error('--base needs a branch name'); overrides.base = args.base; }
  if (args.branch !== undefined) { if (typeof args.branch !== 'string' || !pullRequest.validRef(pullRequest.branchFor(args.branch, id))) throw new Error('--branch needs a branch name (it may use {id})'); overrides.branch = args.branch; }
  if (args.draft !== undefined) {
    if (args.draft === true || args.draft === 'true') overrides.draft = true;
    else if (args.draft === 'false') overrides.draft = false;
    else throw new Error('--draft takes no value (or true/false)');
  }
  if (args['dry-run']) {
    const wt = prWorktree(id);
    if (!wt) throw new Error(`run ${id} has no worktree, so there is nothing to commit`);
    const out = pullRequest.plan({ id, worktree: wt.path, meta: wt, options: prOptionsFor(state, { ...overrides, manual: true }), description: validPrDescription(id, wf), runtimeRoot: RUNTIME_ROOT });
    if (phaseStatus(state, 'verification') !== 'pass') out.lines.splice(1, 0, `  ! verification is ${phaseStatus(state, 'verification')}: the pull request opens only after it passes`);
    if (pullRequest.evalMode()) out.lines.splice(1, 0, '  ! eval mode (AI_EVAL=1): the stage would be skipped');
    console.log(out.lines.join('\n'));
    return 'dry-run';
  }
  if (pullRequest.evalMode()) throw new Error('eval mode (AI_EVAL=1) never opens a pull request');
  if (phaseStatus(state, 'verification') !== 'pass') throw new Error(`verification is ${phaseStatus(state, 'verification')}; a pull request opens only after it passes — finish the run first: ${process.env.AI_AGENTIC_CLI === '1' ? 'agentic resume' : 'node ai/workflow/engine.js resume'} ${id}`);
  const flags = [...(overrides.base ? ['--base', overrides.base] : []), ...(overrides.branch ? ['--branch', overrides.branch] : []), ...(overrides.draft !== undefined ? ['--draft', String(overrides.draft)] : [])];
  claimRun(id, 'pr');
  runs(id, ['pull-request-options', id, ...flags], { print: false, env: { AI_WORKFLOW_ACTOR: 'human-or-cli' } });
  let result;
  try { result = executeStage(id, wf, stage, {}); }
  catch (e) { notifyRun(id, { stageId: stage.id, error: e }); throw e; }
  if (result === 'pass') notifyPullRequest(id);
  return result;
}

function executeStage(id, wf, stage, args = {}) {
  const state = loadState(id);
  if (!depsSatisfied(stage, state)) throw new Error(`${stage.id}: dependencies are not complete: ${(stage.needs || []).map(d => `${d}=${phaseStatus(state, d)}`).join(', ')}`);
  if (args['dry-run']) { console.log(`${id}: next=${stage.id}`); return 'dry-run'; }
  if (stage.when) {
    const condition = evaluateCondition(stage.when, id, state);
    if (!condition.known) throw new Error(`${stage.id}: unknown condition ${stage.when}`);
    if (!condition.value) {
      // A stopped stage can only be skipped once begun again (runs.js skips from pending or in_progress).
      if (['fail', 'blocked'].includes(phaseStatus(state, stage.id))) phase(id, 'begin', stage.id, 'workflow-engine', `reconsidering: ${condition.reason}`);
      phase(id, 'skip', stage.id, 'workflow-engine', condition.reason);
      return 'skipped';
    }
  }
  if (stage.id === PR_STAGE) return executePullRequest(id, wf, stage);
  if (stage.id === 'refactor-coverage') {
    phase(id, 'begin', stage.id, 'workflow-engine', 'checking characterization coverage');
    try {
      const baseline=readJson(path.join(runDir(id),'04-behavior-baseline.json'));
      if(!baseline) throw new Error('missing 04-behavior-baseline.json');
      const result=canImplement(baseline,loadWaivers(id));
      if(!result.ok) throw new Error('characterization coverage blocked: '+result.problems.join('; '));
      phase(id,'complete',stage.id,'workflow-engine','critical/high baseline behavior is covered or explicitly waived');
      return 'pass';
    } catch(e) {
      try { phase(id,'block',stage.id,'workflow-engine',e.message.slice(0,180)); } catch {}
      throw e;
    }
  }
  if (stage.id === 'request') throw new Error('request must be initialized by workflow:start');
  if (stage.type === 'human_gate') {
    const marker = path.join(runDir(id), stage.marker || 'plan.approved');
    if (!fs.existsSync(marker) || phaseStatus(loadState(id), stage.id) !== 'pass') {
      // Point at the run's real location and the command this install actually
      // uses: a standalone project keeps runs in .agentic-runs/ and drives them
      // with `agentic`, not the runtime's own paths and npm scripts.
      const cli = process.env.AI_AGENTIC_CLI === '1';
      const artifact = file => (cli ? relativeStatePath(id, file) : `ai/runs/${id}/${file}`);
      if (stage.id === 'architecture-selection') {
        const command = cli ? `agentic architecture ${id} <option-id>` : `npm run refactor:architecture -- ${id} <option-id>`;
        console.log(`${id}: waiting for architecture selection — review ${artifact('05-architecture-assessment.md')} and ${artifact('05-architecture-options.md')} then run: ${command}`);
      } else {
        // The same block the views show: the plan digest and the exact command.
        const lines = needsYouLines(needsYou(id, loadState(id), { root: RUNS, cli, reasonMax: 2000 }));
        console.log([`${id}: waiting for human approval`, ...(lines.length ? lines : [`  review ${artifact('06-plan.md')} then run: ${commandFor('approve', id, cli)}`])].join('\n'));
      }
      return 'waiting';
    }
    return 'pass';
  }
  if (stage.id === 'plan') {
    const unresolved = unresolvedBlocking(synthesizeAnalysis(id).conflicts);
    // A human decision, like the gates above: say what waits and how to continue, then wait.
    if (unresolved.length) { console.log([`${id}: the plan waits on ${unresolved.length} unresolved conflict(s): ${unresolved.map(x => x.id).join(', ')}`, ...needsYouLines(needsYou(id, loadState(id), { root: RUNS, cli: process.env.AI_AGENTIC_CLI === '1', reasonMax: 2000 }))].join('\n')); return 'waiting'; }
  }
  if (stage.strategy === 'parallel') { executeParallel(id, wf, stage); return 'pass'; }
  if (testsTree(stage) && readMode(id)==='behavior_preserving_refactor') {
    const baseline=readJson(path.join(runDir(id),'04-behavior-baseline.json'))||{};
    const matrix=verificationMatrix({files:changedFileList(productRoot(id),runBaseSha(id)),baseline});
    fs.mkdirSync(engineDir(id),{recursive:true});
    fs.writeFileSync(path.join(engineDir(id),'refactor-verification-matrix.json'),JSON.stringify(matrix,null,2)+'\n');
  }
  executeConditional(id, wf, stage);
  const roleName = stage.role || (stage.owner === 'orchestrator' ? 'orchestration' : null);
  if (!roleName) throw new Error(`${stage.id}: no executable role`);
  const preferredExecutor = (wf.roles[roleName] || {}).executor || wf.orchestrator?.executor || '-';
  const before = loadState(id);
  const stopped = phaseStatus(before, stage.id);
  const spent = ['fail', 'blocked'].includes(stopped) ? spentAttempts(wf, stage, roleName, before) : null;
  if (spent) {
    console.log(`${id}: ${stage.id} stays ${stopped} — ${before.phases?.[stage.id]?.note || 'no reason recorded'} (not re-attempted on resume: ${spent}); reset it with: ${retryHint(id)}`);
    return stopped;
  }
  phase(id, 'begin', stage.id, preferredExecutor, `engine executing ${roleName}`);
  const treeBefore = testsTree(stage) ? treeFingerprint(productRoot(id)) : null;
  try {
    const artifact = stage.artifact || (wf.roles[roleName] || {}).artifact;
    const execution = executeRole(id, wf, stage, roleName, artifact);
    if (stage.id === 'plan' && readMode(id) === 'behavior_preserving_refactor') {
      const plan=readJson(path.join(runDir(id),'06-plan.json'));
      if(!Array.isArray(plan?.refactorIncrements)||!plan.refactorIncrements.length) throw new Error('refactor plan must define non-empty refactorIncrements');
    }
    if (stage.id === 'implementation' && readMode(id) === 'behavior_preserving_refactor') {
      const p=refactorCheckpointProblems(id);
      if(p.length) throw new Error('refactor implementation missing verified checkpoint(s): '+p.join('; '));
    }
    if (stage.id === 'architecture-migration' && readRefactorScope(id) === 'whole_app') {
      promoteArchitectureAsCode(id);
    }
    if (stage.id === 'behavior-equivalence' && readMode(id) === 'behavior_preserving_refactor') {
      const baseline=readJson(path.join(runDir(id),'04-behavior-baseline.json'))||{};
      const invariants=readJson(path.join(runDir(id),'04-refactor-invariants.json'))||{};
      const equivalence=readJson(path.join(runDir(id),'10-behavior-equivalence.json'))||{};
      const changes=contractDiff(baseline,equivalence.observedFinalContracts||{});
      const violations=invariantProblems(changes,invariants);
      fs.mkdirSync(engineDir(id),{recursive:true});
      fs.writeFileSync(path.join(engineDir(id),'refactor-contract-diff.json'),JSON.stringify({schemaVersion:1,changes,violations},null,2)+'\n');
      if(violations.length) throw new Error('undeclared behavior contract change(s): '+violations.join('; '));
      const checkpoints=readJson(path.join(engineDir(id),'refactor-checkpoints.json'))?.checkpoints||{};
      const matrix=readJson(path.join(engineDir(id),'refactor-verification-matrix.json'))||{};
      const telemetry=refactorTelemetry({baseline,equivalence,checkpoints,verificationMatrix:matrix});
      fs.writeFileSync(path.join(engineDir(id),'refactor-telemetry.json'),JSON.stringify(telemetry,null,2)+'\n');
    }
    // conflicts.json follows the arbitration just written, so the views and
    // `agentic conflicts` never show pairs it no longer declares.
    if (stage.id === 'conflict-arbitration') synthesizeAnalysis(id);
    phase(id, 'complete', stage.id, execution.executor || preferredExecutor, `engine completed ${roleName}`);
    // The tree it passed on, taken after the run, so its own pod install, pub get or codegen never re-trigger it.
    if (testsTree(stage)) {
      const after = treeFingerprint(productRoot(id)), dirtied = !!(treeBefore && after && treeBefore !== after);
      try { recordTestedTree(id, stage.id, after, dirtied); } catch (err) { console.warn(`⚠ ${id}: the tree ${stage.id} passed on was not recorded (${err.message}); the post-fix re-run will run`); }
      if (dirtied) console.warn(`⚠ ${id}: ${stage.id} changed the worktree (qa-execute is read-only); the tree it passed on is recorded`);
    }
  } catch (e) {
    try { phase(id, 'fail', stage.id, preferredExecutor, e.message.slice(0, 180)); } catch { /* preserve original */ }
    throw e;
  }
  return 'pass';
}

// ---------------------------------------------------------------- ownership
// One engine per run. The claim lives in <run>/engine/engine.pid until this
// process exits; another engine (a second terminal, the progress terminal's R
// key) refuses instead of running the same stages beside it.
const claimed = new Set();
function claimRun(id, command) {
  if (!id || claimed.has(id) || !loadState(id)) return;
  const result = engineOwner.claim(runDir(id), command);
  if (!result.ok) throw new Error(engineOwner.refusal(id, runDir(id), result.owner));
  if (!claimed.size) process.on('exit', () => { for (const runId of claimed) engineOwner.release(runDir(runId)); });
  claimed.add(id);
}

// ---------------------------------------------------------------- notifications
// The engine tells the human itself, so it reaches them with the progress
// terminal closed: what the run now needs (progress.js needsYou, the same text
// the views show), else the error that stopped it, else completion. notify.js
// dedupes by event key in state.notifications.sent, so a resume that stops on
// the same block does not tell them again. A notification never fails a run.
function notifyRun(id, { stageId = null, error = null, complete = false } = {}) {
  try {
    const state = loadState(id);
    if (!state) return null;
    const cli = process.env.AI_AGENTIC_CLI === '1';
    // The whole reason: notify.js redacts it before it cuts it, so a cut never
    // lands inside a secret and leaves half of it in the notification.
    const attention = needsYou(id, state, { root: RUNS, cli, reasonMax: Infinity });
    const event = attention ? notify.attentionEvent(id, attention)
      : error && stageId ? notify.errorEvent(id, stageId, error.message, state, { cli })
        : complete ? notify.completeEvent(id, state, { cli })
          : null;
    return event ? notify.deliver(stateFile(id), event, { root: PROJECT_ROOT }) : null;
  } catch (e) {
    console.warn(`⚠ notification not sent: ${e.message}`);
    return null;
  }
}
function notifyPullRequest(id) {
  try {
    const pr = loadState(id)?.pullRequest;
    return pr?.url ? notify.deliver(stateFile(id), notify.prOpenedEvent(id, pr), { root: PROJECT_ROOT }) : null;
  } catch (e) { console.warn(`⚠ notification not sent: ${e.message}`); return null; }
}

function ensureRunWorktree(id) {
  const wt = ensureWorktree(RUNTIME_ROOT, id, { sourceRoot: PROJECT_ROOT });
  process.env.AI_WORKFLOW_PRODUCT_ROOT = wt.path;
  process.env.AI_WORKFLOW_RUNTIME_ROOT = RUNTIME_ROOT;
  process.env.AI_WORKFLOW_PROJECT_ROOT = PROJECT_ROOT;
  process.env.AI_WORKFLOW_STATE_ROOT = RUNS;
  return wt;
}
function start(id, requestText, explicitScope, explicitMode, explicitRefactorScope) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id || '')) throw new Error('invalid run id');
  if (!requestText) throw new Error('workflow:start requires --request "..." or --request-file FILE');
  const scope = inferScope(requestText, explicitScope);
  const mode = detectRefactorMode(requestText, explicitMode, explicitRefactorScope);
  const report = preflight(null, scope, false);
  ensureRun(id);
  const wt = ensureRunWorktree(id);
  saveScope(id, scope);
  saveMode(id, mode);
  fs.mkdirSync(engineDir(id), { recursive: true });
  fs.writeFileSync(preflightFile(id), JSON.stringify(report, null, 2) + '\n');
  const file = path.join(runDir(id), '00-request.md');
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# Request\n\n${requestText.trim()}\n`);
  const state = loadState(id);
  if (phaseStatus(state, 'request') === 'pending') {
    phase(id, 'begin', 'request', 'workflow-engine', `initialized; scope=${scope}; worktree=${wt.path}`);
    phase(id, 'complete', 'request', 'workflow-engine', `request captured; branch=${wt.branch}; base=${wt.baseSha}`);
  }
  classifyMobileEvidence(id);
  console.log(`${id}: started (scope=${scope}, mode=${mode.mode}, worktree=${wt.path})`);
}
function preflightExisting(id, explicitScope) {
  if (!loadState(id)) throw new Error(`run ${id} does not exist`);
  ensureRunWorktree(id);
  const scope = explicitScope ? inferScope('', explicitScope) : readScope(id);
  saveScope(id, scope);
  preflight(id, scope, true);
}
function runLoop(id, opts = {}) {
  const wf = workflow();
  if (!opts['dry-run']) claimRun(id, opts.command || 'resume');
  let iterations = 0;
  while (iterations++ < 50) {
    const state = loadState(id);
    if (!state) throw new Error(`run ${id} does not exist`);
    const stage = nextEligibleStage(wf, state);
    if (!stage) {
      console.log(`${id}: workflow complete`);
      refreshWorktree(RUNTIME_ROOT, id);
      notifyRun(id, { complete: true });
      return 'complete';
    }
    console.log(`${id}: ${stage.id} (${phaseStatus(state, stage.id)})`);
    let result;
    try { result = executeStage(id, wf, stage, opts); }
    catch (e) { if (!opts['dry-run']) notifyRun(id, { stageId: stage.id, error: e }); throw e; }
    if (result === 'dry-run') return result;
    if (result === 'waiting') { notifyRun(id); return result; }
    const updated = loadState(id);
    if (['fail', 'blocked'].includes(phaseStatus(updated, stage.id))) { notifyRun(id, { stageId: stage.id, error: new Error(updated.phases?.[stage.id]?.note || phaseStatus(updated, stage.id)) }); return phaseStatus(updated, stage.id); }
    if (opts.once) return result;
  }
  throw new Error('workflow exceeded 50 engine iterations');
}

// End to end through the concurrent branch: real run state, real `run-role`
// children, real state transitions and attempt records; only the agent is a
// stub (AI_WORKFLOW_TEST_EXECUTOR) that sleeps and writes a valid artifact.
// Forcing the stage back to one role at a time fails this test.
function parallelStageSelftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-parallel-'));
  const states = path.join(tmp, 'runs');
  const product = path.join(tmp, 'product');
  const log = path.join(tmp, 'executor.log');
  try {
    spawnSync('git', ['init', '-q', product]);
    fs.writeFileSync(path.join(product, 'a.txt'), 'one\n');
    spawnSync('git', ['add', '-A'], { cwd: product });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: product });
    const baseSha = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: product, encoding: 'utf8' }).stdout).trim();
    const stub = path.join(tmp, 'stub-executor.js');
    fs.writeFileSync(stub, `
      const fs = require('fs');
      const args = process.argv.slice(2);
      const role = args[2], out = args[args.indexOf('--output-file') + 1];
      const note = (event, extra = {}) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, event, at: Date.now(), ...extra }) + '\\n');
      note('start', { pid: process.pid, runRole: process.ppid });
      // STUB_HANG: start an agent-like grandchild and never finish.
      if (process.env.STUB_HANG === '1') {
        const agent = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        note('agent', { pid: agent.pid });
        setTimeout(() => {}, 60000);
        return;
      }
      setTimeout(() => {
        note('end');
        if (role === process.env.STUB_FAIL_ROLE) { console.error('stub executor: ' + role + ' fails on purpose'); process.exit(1); }
        const runId = process.env.FEATURE_RUN_ID;
        const evidence = [{ source: 'a.txt', line: 1, detail: 'stub evidence' }];
        const blocked = role === process.env.STUB_BLOCK_ROLE;
        fs.writeFileSync(out, JSON.stringify(role.endsWith('-review')
          ? { schemaVersion: 1, runId, reviewer: role, status: blocked ? 'blocked' : 'pass', findings: [{ id: 'R-1', severity: blocked ? 'high' : 'info', summary: blocked ? 'stub blocker' : 'stub review', uncertainty: 'confirmed', confidence: 1, evidence, recommendation: blocked ? 'fix it' : 'none needed', resolved: !blocked }] }
          : { schemaVersion: 1, runId, agent: role, status: 'pass', findings: [{ id: 'F-1', title: 'stub finding', severity: 'info', uncertainty: 'confirmed', confidence: 1, evidence, recommendation: 'none needed' }] }));
      }, 300);
    `);
    // A bare PATH and HOME keep MCP discovery away from the real claude CLI and
    // the user's config: the roles here need no MCP, and probing costs seconds.
    fs.mkdirSync(path.join(tmp, 'home'));
    const env = { ...process.env, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: path.join(tmp, 'home'), AI_WORKFLOW_STATE_ROOT: states, AI_WORKFLOW_PRODUCT_ROOT: product, AI_WORKFLOW_PROJECT_ROOT: product, AI_WORKFLOW_SELFTEST: '1', AI_WORKFLOW_TEST_EXECUTOR: stub, AI_WORKFLOW_MAX_PARALLEL: '3', STUB_FAIL_ROLE: 'performance' };
    // A run whose stage `stageId` is next: its one dependency is done and its roles are selected.
    const prepare = (id, stageId, dependency, roles) => {
      const started = spawnSync(process.execPath, [RUNS_TOOL, 'start', id], { env, encoding: 'utf8' });
      assert.strictEqual(started.status, 0, started.stderr);
      const file = path.join(states, id, 'state.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.phases[dependency] = { status: 'pass' };
      state.selectedRoles[stageId] = roles;
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
      fs.mkdirSync(path.join(states, id, 'engine'), { recursive: true });
      fs.writeFileSync(path.join(states, id, 'engine', 'worktree.json'), JSON.stringify({ runId: id, path: product, branch: 'test', baseSha, currentSha: baseSha, createdAt: new Date().toISOString(), sourceRoot: product }));
    };
    const drive = (id, stageId, extraEnv = {}, during = () => null) => {
      try { fs.unlinkSync(log); } catch { /* first stage */ }
      const driver = `
        const engine = require(${JSON.stringify(__filename)});
        const wf = engine.workflow();
        try { engine.executeParallel(${JSON.stringify(id)}, wf, wf.stages.find(s => s.id === ${JSON.stringify(stageId)})); console.log('RESULT ok'); }
        catch (e) { console.log('RESULT ' + e.message); }
      `;
      const sidecar = during();
      let res;
      try { res = spawnSync(process.execPath, ['-e', driver], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60 * 1000 }); }
      finally { try { sidecar?.kill('SIGKILL'); } catch { /* done */ } }
      assert.strictEqual(res.status, 0, res.stderr);
      const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const at = (role, event) => events.find(e => e.role === role && e.event === event)?.at;
      return { result: (res.stdout.match(/^RESULT (.*)$/m) || [])[1], state: JSON.parse(fs.readFileSync(path.join(states, id, 'state.json'), 'utf8')), summary: readJson(path.join(states, id, 'engine', `${stageId}-parallel-summary.json`)), at, events, stdout: res.stdout };
    };
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const overlaps = (a, b) => Date.parse(a.startedAt) < Date.parse(b.finishedAt) && Date.parse(b.startedAt) < Date.parse(a.finishedAt);

    // analysis: four roles, at most three at once, one of them fails.
    const roles = ['security', 'qa-plan', 'performance', 'api-contract'];
    prepare('E2E-ANALYSIS', 'analysis', 'refactor-coverage', roles);
    const analysis = drive('E2E-ANALYSIS', 'analysis');
    assert.ok(analysis.summary, `the concurrent branch ran and left its summary: ${analysis.result}`);
    assert.strictEqual(analysis.summary.cap, 3);
    assert.strictEqual(analysis.summary.maxRunning, 3, 'three roles ran at the same time');
    const results = analysis.summary.results;
    assert.deepStrictEqual(results.map(r => r.role), roles);
    assert.ok(results.some((a, i) => results.some((b, j) => i !== j && overlaps(a, b))), 'role time intervals overlap');
    assert.match(analysis.result || '', /^analysis: 1 of 4 role\(s\) failed: performance \(analysis\/performance: .*exited 1/, analysis.result);
    for (const r of roles) {
      const entry = analysis.state.roles.analysis[r];
      assert.strictEqual(entry.status, r === 'performance' ? 'fail' : 'pass', `${r} ended ${entry.status}`);
      const attempts = analysis.state.executionAttempts?.analysis?.[r] || [];
      assert.strictEqual(attempts.length, 1, `${r} recorded its attempt`);
      assert.strictEqual(attempts[0].status === 'pass' || attempts[0].exitType === 'success', r !== 'performance', `${r} attempt outcome`);
    }
    assert.match(analysis.state.roles.analysis.performance.note, /exited 1/, 'the failing role keeps its reason');
    assert.strictEqual(analysis.state.phases.analysis.status, 'fail', 'stage fails once every role has finished');
    assert.ok(!fs.existsSync(path.join(states, 'E2E-ANALYSIS', 'state.json.lock')), 'no state lock left behind');
    assert.ok(!fs.existsSync(parallelPidFile('E2E-ANALYSIS', 'analysis').replace(RUNS, states)), 'no pid file left behind');
    assert.match(analysis.stdout, /^\[qa-plan\] /m, 'role output carries its prefix');

    // reviews: behavior-regression-review reads the other reviews, so it runs after them.
    prepare('E2E-REVIEWS', 'reviews', 'build-test', ['code-review', 'behavior-regression-review', 'security-review']);
    const reviews = drive('E2E-REVIEWS', 'reviews');
    assert.strictEqual(reviews.result, 'ok');
    assert.deepStrictEqual(reviews.summary.results.map(r => r.role), ['code-review', 'security-review'], 'only the independent reviews run concurrently');
    assert.ok(overlaps(...reviews.summary.results), 'independent reviews overlap');
    assert.ok(reviews.at('behavior-regression-review', 'start') >= Math.max(reviews.at('code-review', 'end'), reviews.at('security-review', 'end')), 'behavior-regression-review starts after its siblings finished');
    for (const r of ['code-review', 'behavior-regression-review', 'security-review']) assert.strictEqual(reviews.state.roles.reviews[r].status, 'pass', r);
    assert.strictEqual(reviews.state.phases.reviews.status, 'pass');

    // reviews, one concurrent review returns status "blocked": behavior-regression-review
    // must not start, and the stage error names the review that holds it back.
    // The review gate (artifacts.js) keeps a blocked review's findings but fails
    // the role, so the stage reports it as failed rather than waiting on it.
    prepare('E2E-REVIEWS-BLOCKED', 'reviews', 'build-test', ['code-review', 'behavior-regression-review', 'security-review']);
    const blocked = drive('E2E-REVIEWS-BLOCKED', 'reviews', { STUB_BLOCK_ROLE: 'security-review' });
    assert.ok(blocked.summary, `the concurrent branch ran: ${blocked.result}`);
    assert.deepStrictEqual(blocked.summary.results.map(r => r.role), ['code-review', 'security-review']);
    assert.ok(!blocked.at('behavior-regression-review', 'start'), 'behavior-regression-review never started');
    assert.strictEqual(blocked.state.roles.reviews['behavior-regression-review']?.status || 'pending', 'pending', 'the sequential tail was not begun');
    assert.strictEqual(blocked.state.roles.reviews['code-review'].status, 'pass');
    assert.strictEqual(blocked.state.roles.reviews['security-review'].status, 'fail', 'the blocked review fails its role');
    assert.match(blocked.result || '', /^reviews: 1 of 2 role\(s\) failed: security-review \(.*review reports unresolved findings/, blocked.result);
    assert.ok(fs.existsSync(path.join(states, 'E2E-REVIEWS-BLOCKED', '09-reviews', 'security-reviewer.md')), 'the blocked review\'s findings are kept');
    assert.notStrictEqual(blocked.state.phases.reviews.status, 'pass', 'the stage did not pass');

    // The helper killed outright (SIGKILL, as the OOM killer would) while the
    // engine lives: it writes no summary and stops nothing. The engine must stop
    // every role group itself — run-role, the router stand-in and the agent under
    // it — mark the roles failed and remove the pid and pgid files.
    prepare('E2E-KILLED', 'analysis', 'refactor-coverage', ['security', 'qa-plan']);
    const engineFiles = path.join(states, 'E2E-KILLED', 'engine');
    const savedPgids = path.join(tmp, 'killed.pgids');
    const killed = drive('E2E-KILLED', 'analysis', { STUB_HANG: '1' }, () => spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const [log, pidFile, pgidFile, saved] = process.argv.slice(1);
      const until = Date.now() + 30000;
      const tick = () => {
        if (Date.now() > until) process.exit(2);
        let agents = 0, pid = 0;
        try { agents = fs.readFileSync(log, 'utf8').split('\\n').filter(line => line.includes('"event":"agent"')).length; } catch { /* not yet */ }
        try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* not yet */ }
        if (agents < 2 || !pid || !fs.existsSync(pgidFile)) return setTimeout(tick, 50);
        fs.copyFileSync(pgidFile, saved);
        process.kill(pid, 'SIGKILL');
      };
      tick();
    `, log, path.join(engineFiles, 'analysis-parallel.pid'), path.join(engineFiles, 'analysis-parallel.pgids'), savedPgids], { stdio: 'ignore' }));
    const pids = killed.events.filter(e => e.event === 'start' || e.event === 'agent').flatMap(e => [e.pid, e.runRole].filter(Boolean));
    assert.match(killed.result || '', /^analysis: parallel role runner exited SIGKILL without a summary/, killed.result);
    assert.deepStrictEqual(readJson(savedPgids).sort(), [...new Set(killed.events.filter(e => e.event === 'start').map(e => e.runRole))].sort(), 'the pgid file named every run-role group');
    const until = Date.now() + 2000;
    while (pids.some(alive) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.deepStrictEqual(pids.filter(alive), [], 'no run-role, router stand-in or agent survives the helper');
    for (const r of ['security', 'qa-plan']) {
      assert.strictEqual(killed.state.roles.analysis[r].status, 'fail', `${r} marked failed`);
      assert.match(killed.state.roles.analysis[r].note, /interrupted: SIGKILL/);
    }
    assert.ok(!fs.existsSync(path.join(engineFiles, 'analysis-parallel.pid')), 'pid file removed');
    assert.ok(!fs.existsSync(path.join(engineFiles, 'analysis-parallel.pgids')), 'pgid file removed');
  } finally {
    // A failed assertion must not leave the hanging stubs of the last stage behind.
    let events = [];
    try { events = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { /* no log */ }
    for (const pid of events.flatMap(e => [e.pid, e.runRole]).filter(Boolean)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The engine's own notifications, through the real run loop, runs.js and the
// state lock; only the agent (AI_WORKFLOW_TEST_EXECUTOR) and the desktop
// (AI_WORKFLOW_TEST_NOTIFY_LOG) are stand-ins. A blocked stage tells the human
// once; a resume that finds the same block does not tell them again; a retry
// that fails the same way says it is the same failure.
function notificationSelftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-notify-'));
  const states = path.join(tmp, 'runs');
  const product = path.join(tmp, 'product');
  const log = path.join(tmp, 'notify.log');
  try {
    spawnSync('git', ['init', '-q', product]);
    fs.writeFileSync(path.join(product, 'a.txt'), 'one\n');
    spawnSync('git', ['add', '-A'], { cwd: product });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: product });
    const baseSha = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: product, encoding: 'utf8' }).stdout).trim();
    // An agent whose acceptance criteria never validate: the same, informative,
    // deterministic failure every time.
    const stub = path.join(tmp, 'stub-executor.js');
    fs.writeFileSync(stub, `
      const fs = require('fs');
      const args = process.argv.slice(2);
      fs.writeFileSync(args[args.indexOf('--output-file') + 1], 'not json at ' + new Date().toISOString());
    `);
    fs.mkdirSync(path.join(tmp, 'home'));
    const env = { ...process.env, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: path.join(tmp, 'home'), AI_WORKFLOW_STATE_ROOT: states, AI_WORKFLOW_PRODUCT_ROOT: product, AI_WORKFLOW_PROJECT_ROOT: product, AI_WORKFLOW_SELFTEST: '1', AI_WORKFLOW_TEST_EXECUTOR: stub, AI_WORKFLOW_TEST_NOTIFY_LOG: log, AI_WORKFLOW_AVAILABLE_MCPS: '' };
    delete env.AI_AGENTIC_CLI; delete env.AI_EVAL; delete env.QC_EVAL;
    const stateOf = id => JSON.parse(fs.readFileSync(path.join(states, id, 'state.json'), 'utf8'));
    const prepare = (id, donePhases) => {
      const started = spawnSync(process.execPath, [RUNS_TOOL, 'start', id], { env, encoding: 'utf8' });
      assert.strictEqual(started.status, 0, started.stderr);
      const file = path.join(states, id, 'state.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const phaseId of donePhases) state.phases[phaseId] = { status: (workflow().stages.find(st => st.id === phaseId) || {}).when ? 'skipped' : 'pass' };
      state.evidence.mobileScreenshots = { requirement: 'not-required', reason: 'selftest' };
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
      fs.mkdirSync(path.join(states, id, 'engine'), { recursive: true });
      fs.writeFileSync(path.join(states, id, 'engine', 'worktree.json'), JSON.stringify({ runId: id, path: product, branch: 'test', baseSha, currentSha: baseSha, createdAt: new Date().toISOString(), sourceRoot: product }));
    };
    const resume = (id, extraEnv = {}) => {
      const driver = `const engine = require(${JSON.stringify(__filename)}); try { console.log('RESULT ' + engine.runLoop(${JSON.stringify(id)}, {})); } catch (e) { console.log('RESULT ERROR ' + e.message); }`;
      const res = spawnSync(process.execPath, ['-e', driver], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60 * 1000 });
      assert.strictEqual(res.status, 0, res.stderr);
      return { result: (res.stdout.match(/^RESULT (.*)$/m) || [])[1], stdout: res.stdout };
    };
    const events = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
    const retry = id => { const r = spawnSync(process.execPath, [RUNS_TOOL, 'retry', id], { env, encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); };
    const stages = workflow().stages.map(st => st.id);

    // 1. A failing stage notifies exactly once.
    prepare('N-FAIL', ['request', 'requirements']);
    const first = resume('N-FAIL');
    assert.match(first.result || '', /^ERROR acceptance-criteria\/orchestration: artifact\/worktree validation failed/, first.stdout);
    let sent = events();
    assert.strictEqual(sent.length, 1, JSON.stringify(sent));
    const failed = stateOf('N-FAIL');
    assert.strictEqual(failed.phases['acceptance-criteria'].status, 'fail');
    assert.strictEqual(sent[0].key, `N-FAIL|acceptance-criteria|fail|${failed.phases['acceptance-criteria'].updatedAt}`);
    assert.strictEqual(sent[0].title, 'agentic · N-FAIL needs you');
    assert.match(sent[0].body, /^Acceptance Criteria failed: acceptance-criteria\/orchestration: artifact\/worktree validation failed.* — run: node ai\/tasks\/feature\/runs\.js retry N-FAIL && node ai\/workflow\/engine\.js resume N-FAIL$/, sent[0].body);
    assert.deepStrictEqual(failed.notifications.sent, [sent[0].key], 'the key is recorded in the run state');
    assert.ok(!fs.existsSync(path.join(states, 'N-FAIL', 'engine', 'engine.pid')), 'the engine released the run when it exited');

    // 2. A resume finds the same block: the stage is not begun again (its
    // reason stays), and nothing is sent again.
    const note = failed.phases['acceptance-criteria'].note;
    const again = resume('N-FAIL');
    assert.strictEqual(again.result, 'fail', again.stdout);
    assert.match(again.stdout, /acceptance-criteria stays fail — .*not re-attempted on resume: .*reset it with: node ai\/tasks\/feature\/runs\.js retry N-FAIL/);
    assert.strictEqual(stateOf('N-FAIL').phases['acceptance-criteria'].note, note, 'the real reason is kept, not "max attempts exhausted"');
    assert.strictEqual(events().length, 1, 'a resume does not re-send the same block');

    // 3. retry, then the same failure again: a new event that says so.
    retry('N-FAIL');
    resume('N-FAIL');
    const repeated = stateOf('N-FAIL').phases['acceptance-criteria'];
    assert.strictEqual(repeated.status, 'fail');
    assert.strictEqual(repeated.repeatedFailure, 2, 'the same reason twice in a row is recorded');
    sent = events();
    assert.strictEqual(sent.length, 2);
    assert.match(sent[1].body, /^Same failure as last time — this needs a fix outside Acceptance Criteria\. Acceptance Criteria: acceptance-criteria\/orchestration: artifact\/worktree validation failed/);

    // 4. Eval mode never notifies.
    retry('N-FAIL');
    resume('N-FAIL', { AI_EVAL: '1' });
    assert.strictEqual(stateOf('N-FAIL').phases['acceptance-criteria'].repeatedFailure, 3);
    assert.strictEqual(events().length, 2, 'eval mode sends nothing');

    // 5. A second engine for the same run refuses to start.
    fs.writeFileSync(path.join(states, 'N-FAIL', 'engine', 'engine.pid'), JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'resume', startedAt: new Date().toISOString() }));
    const second = resume('N-FAIL');
    assert.match(second.result || '', new RegExp(`^ERROR run N-FAIL is already being driven by engine pid ${process.pid} \\(resume\\)`), second.stdout);
    fs.unlinkSync(path.join(states, 'N-FAIL', 'engine', 'engine.pid'));

    // 6. The plan gate: two resumes, one "waits for your approval". The terminal
    // gets the plan digest and the exact command; the notification never
    // carries the plan.
    prepare('N-GATE', stages.slice(0, stages.indexOf('approval')));
    fs.writeFileSync(path.join(states, 'N-GATE', '06-plan.json'), JSON.stringify({ schemaVersion: 1, runId: 'N-GATE', summary: 'Add the setting and its tests.', steps: [{ id: 'S1', description: 'x' }], acceptanceCriteria: ['AC-1', 'AC-2'], risks: [] }));
    fs.writeFileSync(path.join(states, 'N-GATE', '06-plan.md'), '# Implementation plan\n\nAdd the setting and its tests.\n');
    for (let i = 0; i < 2; i++) {
      const held = resume('N-GATE');
      assert.strictEqual(held.result, 'waiting');
      assert.match(held.stdout, /N-GATE: waiting for human approval\n⚠ Needs you: The plan waits for your approval\n/, held.stdout);
      assert.match(held.stdout, /\n {2}Plan: 1 steps · 2 acceptance criteria · 0 risks\n {4}│ Add the setting and its tests\.\n/, held.stdout);
      assert.ok(held.stdout.includes(`→ run: ${commandFor('approve', 'N-GATE', false)}`), held.stdout);
    }
    const gate = events().filter(e => e.key.startsWith('N-GATE|'));
    assert.strictEqual(gate.length, 1, JSON.stringify(gate));
    assert.strictEqual(gate[0].kind, 'waiting');
    assert.match(gate[0].body, /^The plan waits for your approval: Review ai\/runs\/N-GATE\/06-plan\.md.* — run: node ai\/tasks\/feature\/runs\.js approve N-GATE && node ai\/workflow\/engine\.js resume N-GATE$/);

    // 6b. Open specialist conflicts: the plan waits for a human decision like
    // the gates (never a failure), says how many and what to run, and is told
    // once across resumes. Once decided, the plan runs (the stub fails it).
    prepare('N-CONF', stages.slice(0, stages.indexOf('plan')));
    const analysisDir = path.join(states, 'N-CONF', '05-analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, 'security-reviewer.json'), JSON.stringify({ agent: 'security-reviewer', findings: [{ id: 'SEC-1', title: 't', severity: 'high' }] }));
    fs.writeFileSync(path.join(analysisDir, 'mobile-architect.json'), JSON.stringify({ agent: 'mobile-architect', findings: [{ id: 'ARCH-2', title: 'u', severity: 'medium' }] }));
    fs.writeFileSync(path.join(analysisDir, 'arbitration.json'), JSON.stringify({ conflicts: [{ findingA: 'SEC-1', findingB: 'ARCH-2', topic: 'storage' }] }));
    for (let i = 0; i < 2; i++) {
      const held = resume('N-CONF');
      assert.strictEqual(held.result, 'waiting', held.stdout);
      assert.match(held.stdout, /⚠ Needs you: 1 conflict needs your decision/);
      assert.match(held.stdout, /→ run: node ai\/workflow\/conflicts\.js list N-CONF/);
      assert.strictEqual(stateOf('N-CONF').phases.plan?.status || 'pending', 'pending');
    }
    const conf = events().filter(e => e.key.startsWith('N-CONF|'));
    assert.strictEqual(conf.length, 1, JSON.stringify(conf));
    assert.ok(conf[0].key.startsWith('N-CONF|plan|waiting|CONFLICT-001=ARCH-2+SEC-1'), conf[0].key);
    assert.strictEqual(conf[0].kind, 'waiting');
    assert.match(conf[0].body, /^1 conflict needs your decision: CONFLICT-001 \(storage\)/);
    const conflictsJson = path.join(analysisDir, 'conflicts.json');
    const decided = JSON.parse(fs.readFileSync(conflictsJson, 'utf8'));
    decided.conflicts[0].status = 'resolved';
    decided.conflicts[0].resolution = { decision: 'secure storage', rationale: 'PII', owner: 'human', resolvedAt: new Date().toISOString() };
    fs.writeFileSync(conflictsJson, JSON.stringify(decided));
    const planned = resume('N-CONF');
    assert.notStrictEqual(planned.result, 'waiting', planned.stdout);
    assert.ok(!planned.stdout.includes('Needs you: 1 conflict'), planned.stdout);
    assert.match(planned.result || '', /^ERROR plan\/orchestration: /, 'the plan was attempted');

    // 7. A complete run: once, with how to open the pull request it skipped.
    prepare('N-DONE', stages.filter(st => st !== 'pull-request'));
    const doneFile = path.join(states, 'N-DONE', 'state.json');
    const doneState = JSON.parse(fs.readFileSync(doneFile, 'utf8'));
    doneState.phases['pull-request'] = { status: 'skipped', note: 'pull_request.enabled is not true' };
    fs.writeFileSync(doneFile, JSON.stringify(doneState));
    for (let i = 0; i < 2; i++) assert.strictEqual(resume('N-DONE').result, 'complete');
    const done = events().filter(e => e.key.startsWith('N-DONE|'));
    assert.deepStrictEqual(done.map(e => [e.key, e.kind, e.title]), [['N-DONE|run|complete', 'complete', 'agentic · N-DONE complete']]);
    assert.match(done[0].body, /Open the pull request with: node ai\/workflow\/engine\.js pr N-DONE$/);

    // 8. The case that hurt: verification's conditional mobile-evidence blocks
    // for a reason outside verification (here: no Android/iOS target). The
    // stage still reads pending, so retry used to find "nothing to retry".
    // Now the reason is mobile-evidence's own, retry resets the conditional,
    // and the second identical block says it needs a fix elsewhere.
    prepare('N-MOBILE', stages.slice(0, stages.indexOf('verification')));
    const mobileFile = path.join(states, 'N-MOBILE', 'state.json');
    const mobile = JSON.parse(fs.readFileSync(mobileFile, 'utf8'));
    mobile.evidence.mobileScreenshots = { requirement: 'required', reason: 'selftest' };
    fs.writeFileSync(mobileFile, JSON.stringify(mobile));
    const blocked = resume('N-MOBILE');
    assert.match(blocked.result || '', /^ERROR mobile evidence is required but no Android\/iOS target could be derived/, blocked.stdout);
    const conditional = () => stateOf('N-MOBILE').conditionals.verification['mobile-evidence'];
    assert.strictEqual(conditional().status, 'blocked');
    assert.match(conditional().reason, /^mobile evidence is required but no Android\/iOS target/, 'the tool\'s own reason, not its exit status');
    assert.strictEqual(stateOf('N-MOBILE').phases.verification?.status || 'pending', 'pending');
    let mobileEvents = events().filter(e => e.key.startsWith('N-MOBILE|'));
    assert.strictEqual(mobileEvents.length, 1);
    assert.match(mobileEvents[0].body, /^Final Verification \(mobile-evidence\) blocked: mobile-evidence: mobile evidence is required but no Android\/iOS target .* — run: node ai\/tasks\/feature\/runs\.js retry N-MOBILE/);
    retry('N-MOBILE');
    assert.strictEqual(conditional().status, 'pending', 'retry resets a blocked conditional');
    resume('N-MOBILE');
    assert.strictEqual(conditional().repeatedFailure, 2);
    mobileEvents = events().filter(e => e.key.startsWith('N-MOBILE|'));
    assert.strictEqual(mobileEvents.length, 2);
    assert.match(mobileEvents[1].body, /^Same failure as last time — this needs a fix outside Final Verification\. Final Verification: mobile-evidence: mobile evidence is required/);

    // 9. Parallel stages: a role that failed deterministically is not begun
    // again on a plain resume, in the concurrent batch or in the sequential
    // tail (behavior-regression-review reads its siblings, so it runs after
    // them). Its reason stays, the other roles keep their pass, the error says
    // how to reset it, and the human is told once.
    const passStub = path.join(tmp, 'pass-or-fail-executor.js');
    fs.writeFileSync(passStub, `
      const fs = require('fs');
      const args = process.argv.slice(2);
      const role = args[2], out = args[args.indexOf('--output-file') + 1];
      if (role === process.env.STUB_FAIL_ROLE) { console.error('stub executor: ' + role + ' fails on purpose'); process.exit(1); }
      const runId = process.env.FEATURE_RUN_ID;
      const evidence = [{ source: 'a.txt', line: 1, detail: 'stub evidence' }];
      fs.writeFileSync(out, JSON.stringify(role.endsWith('-review')
        ? { schemaVersion: 1, runId, reviewer: role, status: 'pass', findings: [{ id: 'R-1', severity: 'info', summary: 'stub review', uncertainty: 'confirmed', confidence: 1, evidence, recommendation: 'none needed', resolved: true }] }
        : { schemaVersion: 1, runId, agent: role, status: 'pass', findings: [{ id: 'F-1', title: 'stub finding', severity: 'info', uncertainty: 'confirmed', confidence: 1, evidence, recommendation: 'none needed' }] }));
    `);
    const parallelCase = (id, stageId, roles, failing) => {
      prepare(id, stages.slice(0, stages.indexOf(stageId)));
      const file = path.join(states, id, 'state.json');
      const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
      seeded.selectedRoles[stageId] = roles;
      fs.writeFileSync(file, JSON.stringify(seeded, null, 2) + '\n');
      const stub = { AI_WORKFLOW_TEST_EXECUTOR: passStub, STUB_FAIL_ROLE: failing, AI_WORKFLOW_MAX_PARALLEL: '3' };
      const first = resume(id, stub);
      const after = stateOf(id);
      const entry = after.roles[stageId][failing];
      assert.strictEqual(entry.status, 'fail', `${failing}: ${first.result}`);
      for (const other of roles.filter(r => r !== failing)) assert.strictEqual(after.roles[stageId][other].status, 'pass', `${other} passed`);
      const own = events().filter(e => e.key.startsWith(`${id}|`));
      assert.strictEqual(own.length, 1, JSON.stringify(own));
      for (let i = 0; i < 2; i++) {
        const again = resume(id, stub);
        assert.match(again.result || '', new RegExp(`^ERROR ${stageId}: ${failing} \\(.*\\) — not re-attempted on resume \\(.*\\); reset with: node ai/tasks/feature/runs\\.js retry ${id}`), again.stdout);
        const now = stateOf(id);
        assert.deepStrictEqual([now.roles[stageId][failing].note, now.roles[stageId][failing].updatedAt], [entry.note, entry.updatedAt], 'the role keeps its own reason, not "max attempts exhausted"');
        assert.strictEqual(now.roles[stageId][failing].repeatedFailure, undefined, 'nothing was retried, so nothing repeated');
        for (const other of roles.filter(r => r !== failing)) assert.strictEqual(now.roles[stageId][other].status, 'pass');
        assert.strictEqual(events().filter(e => e.key.startsWith(`${id}|`)).length, 1, 'a resume does not tell the human again');
      }
      assert.doesNotMatch(entry.note, /max attempts exhausted/);
    };
    parallelCase('N-PAR', 'analysis', ['security', 'qa-plan', 'performance'], 'performance');
    parallelCase('N-TAIL', 'reviews', ['code-review', 'behavior-regression-review', 'security-review'], 'behavior-regression-review');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// The run-loop harness of notificationSelftest for the selftests below: a temp
// state root, a product git repo, runs.js prepare/retry and an engine driver.
function engineHarness(prefix) {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const states = path.join(tmp, 'runs');
  const product = path.join(tmp, 'product');
  const log = path.join(tmp, 'notify.log');
  spawnSync('git', ['init', '-q', product]);
  fs.writeFileSync(path.join(product, 'a.txt'), 'one\n');
  spawnSync('git', ['add', '-A'], { cwd: product });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: product });
  const baseSha = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: product, encoding: 'utf8' }).stdout).trim();
  fs.mkdirSync(path.join(tmp, 'home'));
  const env = { ...process.env, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: path.join(tmp, 'home'), AI_WORKFLOW_STATE_ROOT: states, AI_WORKFLOW_PRODUCT_ROOT: product, AI_WORKFLOW_PROJECT_ROOT: product, AI_WORKFLOW_SELFTEST: '1', AI_WORKFLOW_TEST_NOTIFY_LOG: log, AI_WORKFLOW_AVAILABLE_MCPS: '' };
  delete env.AI_AGENTIC_CLI; delete env.AI_EVAL; delete env.QC_EVAL;
  const stateOf = id => JSON.parse(fs.readFileSync(path.join(states, id, 'state.json'), 'utf8'));
  const writeState = (id, state) => fs.writeFileSync(path.join(states, id, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  const prepare = (id, donePhases) => {
    const started = spawnSync(process.execPath, [RUNS_TOOL, 'start', id], { env, encoding: 'utf8' });
    assert.strictEqual(started.status, 0, started.stderr);
    const state = stateOf(id);
    for (const phaseId of donePhases) state.phases[phaseId] = { status: (workflow().stages.find(st => st.id === phaseId) || {}).when ? 'skipped' : 'pass' };
    state.evidence.mobileScreenshots = { requirement: 'not-required', reason: 'selftest' };
    writeState(id, state);
    fs.mkdirSync(path.join(states, id, 'engine'), { recursive: true });
    fs.writeFileSync(path.join(states, id, 'engine', 'worktree.json'), JSON.stringify({ runId: id, path: product, branch: 'test', baseSha, currentSha: baseSha, createdAt: new Date().toISOString(), sourceRoot: product }));
  };
  const resume = (id, extraEnv = {}, opts = {}) => {
    const driver = `const engine = require(${JSON.stringify(__filename)}); try { console.log('RESULT ' + engine.runLoop(${JSON.stringify(id)}, ${JSON.stringify(opts)})); } catch (e) { console.log('RESULT ERROR ' + e.message); }`;
    const res = spawnSync(process.execPath, ['-e', driver], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60 * 1000 });
    assert.strictEqual(res.status, 0, res.stderr);
    return { result: (res.stdout.match(/^RESULT (.*)$/m) || [])[1], stdout: res.stdout, stderr: res.stderr };
  };
  const retry = (id, ...names) => { const r = spawnSync(process.execPath, [RUNS_TOOL, 'retry', id, ...names], { env, encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); return r.stdout; };
  const events = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { tmp, states, product, env, stateOf, writeState, prepare, resume, retry, events, stages: workflow().stages.map(st => st.id), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

// Resolved conflict decisions reach the plan prompt, and an engine-run plan
// that leaves one out is rejected inside the attempt, so `retry` hands the
// missing ids to the regenerated plan.
function conflictDecisionSelftest() {
  const h = engineHarness('engine-conflict-decisions-');
  try {
    const stub = path.join(h.tmp, 'plan-executor.js');
    fs.writeFileSync(stub, `
      const fs = require('fs');
      const args = process.argv.slice(2);
      const cites = (process.env.STUB_PLAN_CITES || '').split(',').filter(Boolean);
      fs.writeFileSync(args[args.indexOf('--output-file') + 1], JSON.stringify({ schemaVersion: 1, runId: process.env.FEATURE_RUN_ID, summary: 'stub plan', steps: [{ id: '1', description: 'do it' }], acceptanceCriteria: ['AC-1'], conflictDecisions: cites.map(id => ({ conflictId: id, applied: 'applied in step 1', steps: ['1'] })) }));
    `);
    const before = h.stages.slice(0, h.stages.indexOf('plan'));
    h.prepare('N-CONFLICT', before);
    const analysis = path.join(h.states, 'N-CONFLICT', '05-analysis');
    fs.mkdirSync(analysis, { recursive: true });
    fs.writeFileSync(path.join(analysis, 'security-reviewer.json'), JSON.stringify({ agent: 'security-reviewer', findings: [{ id: 'SEC-1', title: 'Use secure storage', severity: 'high' }] }));
    fs.writeFileSync(path.join(analysis, 'mobile-architect.json'), JSON.stringify({ agent: 'mobile-architect', findings: [{ id: 'ARCH-2', title: 'Plain prefs', severity: 'medium' }, { id: 'ARCH-3', title: 'No cache', severity: 'low' }] }));
    fs.writeFileSync(path.join(analysis, 'arbitration.json'), JSON.stringify({ conflicts: [{ findingA: 'SEC-1', findingB: 'ARCH-2', topic: 'storage' }, { findingA: 'SEC-1', findingB: 'ARCH-3', topic: 'caching' }] }));
    const resolution = decision => ({ decision, rationale: 'selftest', owner: 'human', resolvedAt: '2026-11-04T00:00:00Z' });
    fs.writeFileSync(path.join(analysis, 'conflicts.json'), JSON.stringify({ schemaVersion: 1, conflicts: [
      { id: 'CONFLICT-001', topic: 'storage', findings: ['SEC-1', 'ARCH-2'], status: 'resolved', resolution: resolution('KEEP SECURE STORAGE') },
      { id: 'CONFLICT-002', topic: 'caching', findings: ['SEC-1', 'ARCH-3'], status: 'resolved', resolution: resolution('CACHE FOR ONE HOUR ONLY') },
    ] }));
    const stubEnv = cites => ({ AI_WORKFLOW_TEST_EXECUTOR: stub, STUB_PLAN_CITES: cites });
    const runFile = file => path.join(h.states, 'N-CONFLICT', file);
    // (a) The plan cites one of two decisions: rejected, never written.
    const first = h.resume('N-CONFLICT', stubEnv('CONFLICT-001'));
    assert.match(first.stdout, /^RESULT ERROR plan\/orchestration: artifact\/worktree validation failed: [^]*?missing CONFLICT-002/m, first.stdout);
    assert.match(h.stateOf('N-CONFLICT').phases.plan.note, /missing CONFLICT-002/, 'the missing id survives the phase note cut');
    assert.strictEqual(h.stateOf('N-CONFLICT').phases.plan.status, 'fail');
    assert.ok(!fs.existsSync(runFile('06-plan.md')), 'a plan that drops a decision is not written');
    assert.ok(fs.existsSync(runFile('engine/plan-orchestration.rejected')), 'the rejected plan is kept');
    const prompt = fs.readFileSync(runFile('engine/plan-orchestration.md'), 'utf8');
    assert.ok(prompt.includes('## Binding conflict decisions') && prompt.includes('CACHE FOR ONE HOUR ONLY'), 'the decisions are in the plan prompt');
    // (b) retry, then a plan that cites both: through to the approval gate.
    h.retry('N-CONFLICT');
    const second = h.resume('N-CONFLICT', stubEnv('CONFLICT-001,CONFLICT-002'));
    assert.strictEqual(second.result, 'waiting', second.stdout);
    const plan = fs.readFileSync(runFile('06-plan.md'), 'utf8');
    for (const part of ['Conflict decisions applied', 'CONFLICT-001', 'CONFLICT-002']) assert.ok(plan.includes(part), part);
    assert.match(fs.readFileSync(runFile('engine/plan-orchestration.md'), 'utf8'), /previous plan\/orchestration failure: [^\n]*\n- \$\.conflictDecisions: missing CONFLICT-002/, 'retry tells the regenerated plan what it missed');
    // (c) No conflicts: no section, and nothing to cite.
    h.prepare('N-NOCONFLICT', before);
    assert.strictEqual(h.resume('N-NOCONFLICT', stubEnv('')).result, 'waiting');
    assert.ok(!fs.readFileSync(path.join(h.states, 'N-NOCONFLICT', 'engine', 'plan-orchestration.md'), 'utf8').includes('## Binding conflict decisions'), 'no section (the schema description names it, the section is absent)');
    // (d) Re-arbitration adds a pair that sorts ahead of a decided one: ids stay
    // unique, the banner's exact resolve command decides the open pair (not the
    // decided one), and both decisions reach the plan.
    h.prepare('N-RENUM', before);
    const renum = path.join(h.states, 'N-RENUM', '05-analysis');
    fs.mkdirSync(renum, { recursive: true });
    for (const f of ['security-reviewer.json', 'mobile-architect.json']) fs.copyFileSync(path.join(analysis, f), path.join(renum, f));
    const arbitrate = pairs => fs.writeFileSync(path.join(renum, 'arbitration.json'), JSON.stringify({ conflicts: pairs }));
    const conflictsNow = () => JSON.parse(fs.readFileSync(path.join(renum, 'conflicts.json'), 'utf8')).conflicts;
    const resolveCli = (cid, decision) => spawnSync(process.execPath, [path.join(__dirname, 'conflicts.js'), 'resolve', 'N-RENUM', cid, '--decision', decision, '--rationale', 'selftest'], { env: h.env, encoding: 'utf8' });
    arbitrate([{ findingA: 'SEC-1', findingB: 'ARCH-3', topic: 'caching' }]);
    assert.strictEqual(h.resume('N-RENUM', stubEnv('')).result, 'waiting');
    assert.strictEqual(resolveCli(conflictsNow()[0].id, 'CACHE ONE HOUR').status, 0);
    arbitrate([{ findingA: 'SEC-1', findingB: 'ARCH-3', topic: 'caching' }, { findingA: 'SEC-1', findingB: 'ARCH-2', topic: 'storage' }]);
    const held = h.resume('N-RENUM', stubEnv(''));
    assert.strictEqual(held.result, 'waiting', held.stdout);
    const ids = conflictsNow().map(c => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, `ids are unique: ${ids}`);
    const told = (held.stdout.match(/conflicts\.js resolve N-RENUM (CONFLICT-\d+) /) || [])[1];
    assert.strictEqual(told, conflictsNow().find(c => c.status !== 'resolved').id, held.stdout);
    assert.strictEqual(resolveCli(told, 'SECURE STORAGE').status, 0);
    assert.ok(conflictsNow().every(c => c.status === 'resolved'), 'the printed command decided the open pair');
    assert.strictEqual(h.resume('N-RENUM', stubEnv(ids.join(','))).result, 'waiting', 'through to the approval gate');
    const renumPrompt = fs.readFileSync(path.join(h.states, 'N-RENUM', 'engine', 'plan-orchestration.md'), 'utf8');
    for (const part of ['CACHE ONE HOUR', 'SECURE STORAGE']) assert.ok(renumPrompt.includes(part), part);
  } finally { h.cleanup(); }
}

// Fixes edit code after Build + Tests passed: the post-fix re-run tests the
// tree again only when it differs from the one a build/test pass saw.
function postFixBuildTestSelftest() {
  const h = engineHarness('engine-post-fix-');
  try {
    const calls = path.join(h.tmp, 'calls.log');
    const stub = path.join(h.tmp, 'qa-executor.js');
    fs.writeFileSync(stub, `
      const fs = require('fs'), path = require('path');
      const args = process.argv.slice(2), role = args[2], out = args[args.indexOf('--output-file') + 1];
      fs.appendFileSync(${JSON.stringify(calls)}, role + '\\n');
      const product = process.env.AI_WORKFLOW_PRODUCT_ROOT;
      if (process.env.STUB_DIRTY === '1') fs.writeFileSync(path.join(product, 'generated.lock'), 'codegen\\n');
      if (role === 'fixes') { fs.writeFileSync(out, '# Fixes\\n\\nNothing to change.\\n'); return; }
      const status = process.env.STUB_BUILD || 'pass';
      fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, runId: process.env.FEATURE_RUN_ID, status, commands: [{ command: 'flutter test', status, exitCode: status === 'pass' ? 0 : 1 }] }));
    `);
    const calledTimes = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
    const stubEnv = extra => ({ AI_WORKFLOW_TEST_EXECUTOR: stub, ...extra });
    const STAGE = 'post-fix-build-test';
    const upTo = h.stages.slice(0, h.stages.indexOf(STAGE));
    const fixesAttempts = [{ attempt: 1, ok: true, executor: 'codex', exitType: 'ok' }];
    const seed = (id, done = upTo, extra = {}) => { h.prepare(id, done); const st = h.stateOf(id); st.executionAttempts = { fixes: { fixes: fixesAttempts } }; Object.assign(st, extra); h.writeState(id, st); fs.writeFileSync(path.join(h.states, id, '10-fixes.md'), '# Fixes\n\nRenamed a helper.\n'); };
    const edit = text => fs.writeFileSync(path.join(h.product, 'a.txt'), text);
    const once = (id, extra = {}) => h.resume(id, stubEnv(extra), { once: true });

    // P1. Fixes changed nothing since Build + Tests passed: skipped, no agent.
    seed('P-SAME', upTo, { testedWorkspace: { stage: 'build-test', fingerprint: treeFingerprint(h.product) } });
    assert.strictEqual(once('P-SAME').result, 'skipped');
    let st = h.stateOf('P-SAME');
    assert.strictEqual(st.phases[STAGE].status, 'skipped');
    assert.match(st.phases[STAGE].note, /fixes changed no files since build-test passed/);
    assert.strictEqual(st.executionAttempts[STAGE], undefined);
    assert.strictEqual(calledTimes(), 0, 'no agent for an unchanged tree');

    // P2. Fixes edited a file: qa-execute runs again, into its own artifact and attempts.
    seed('P-RUN', upTo, { testedWorkspace: { stage: 'build-test', fingerprint: treeFingerprint(h.product) } });
    edit('two\n');
    assert.strictEqual(once('P-RUN', { STUB_BUILD: 'pass' }).result, 'pass');
    st = h.stateOf('P-RUN');
    assert.strictEqual(st.phases[STAGE].status, 'pass');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h.states, 'P-RUN', '10-post-fix-build-test.json'), 'utf8')).status, 'pass');
    assert.ok(!fs.existsSync(path.join(h.states, 'P-RUN', '08-build-test.json')), 'Build + Tests keeps its own artifact');
    assert.strictEqual(st.executionAttempts[STAGE]['qa-execute'].length, 1);
    assert.deepStrictEqual(st.executionAttempts.fixes, { fixes: fixesAttempts }, 'fixes keeps its attempts');
    assert.deepStrictEqual([st.testedWorkspace.stage, st.testedWorkspace.fingerprint], [STAGE, treeFingerprint(h.product)]);
    assert.ok(st.history.some(e => e.kind === 'phase' && e.phase === STAGE && e.action === 'complete'));
    assert.ok(st.history.some(e => e.kind === 'tested-workspace' && e.phase === STAGE));
    assert.ok(fs.readFileSync(path.join(h.states, 'P-RUN', 'engine', `${STAGE}-qa-execute.md`), 'utf8').includes('## 10-fixes.md'), 'the re-run sees what fixes did');
    assert.strictEqual(nextEligibleStage(workflow(), st).id, 'architecture-compliance');

    // P4. A rework of fixes resets the re-run that passed; unchanged fixes then skip it.
    const reworked = h.retry('P-RUN', 'fixes');
    assert.match(reworked, /post-fix-build-test \(downstream of fixes\)/);
    st = h.stateOf('P-RUN');
    assert.deepStrictEqual([st.phases.fixes.status, st.phases[STAGE].status], ['pending', 'pending']);
    assert.ok(st.history.some(e => e.action === 'rework-downstream' && e.phase === STAGE));
    assert.strictEqual(once('P-RUN').result, 'pass', 'fixes runs again');
    assert.strictEqual(once('P-RUN').result, 'skipped');
    assert.strictEqual(h.stateOf('P-RUN').phases[STAGE].status, 'skipped');

    // P3. A red re-run fails like Build + Tests, is told once, and is bounded.
    seed('P-FAIL', upTo, { testedWorkspace: { stage: 'build-test', fingerprint: treeFingerprint(h.product) } });
    edit('three\n');
    const failed = h.resume('P-FAIL', stubEnv({ STUB_BUILD: 'fail' }));
    assert.match(failed.stdout, /^RESULT ERROR post-fix-build-test\/qa-execute: artifact\/worktree validation failed[^]*must be pass/m, failed.stdout);
    st = h.stateOf('P-FAIL');
    assert.deepStrictEqual([st.phases[STAGE].status, st.phases.fixes.status, st.phases.verification?.status || 'pending'], ['fail', 'pass', 'pending']);
    let own = h.events().filter(e => e.key.startsWith('P-FAIL|'));
    assert.strictEqual(own.length, 1, JSON.stringify(own));
    assert.match(own[0].body, /^Post-fix Build \+ Tests failed: /);
    const before = calledTimes();
    const again = h.resume('P-FAIL', stubEnv({ STUB_BUILD: 'fail' }));
    assert.strictEqual(again.result, 'fail', again.stdout);
    assert.match(again.stdout, /post-fix-build-test stays fail — [^]*not re-attempted on resume/);
    assert.strictEqual(calledTimes(), before, 'not attempted again');
    assert.strictEqual(h.events().filter(e => e.key.startsWith('P-FAIL|')).length, 1);
    const retried = h.retry('P-FAIL');
    assert.match(retried, /post-fix-build-test/);
    assert.doesNotMatch(retried, /\bfixes\b(?! \()/, 'a plain retry leaves fixes alone');
    st = h.stateOf('P-FAIL');
    assert.deepStrictEqual([st.phases.fixes.status, st.executionAttempts.fixes], ['pass', { fixes: fixesAttempts }]);
    h.resume('P-FAIL', stubEnv({ STUB_BUILD: 'fail' }));
    assert.strictEqual(h.stateOf('P-FAIL').phases[STAGE].repeatedFailure, 2);
    own = h.events().filter(e => e.key.startsWith('P-FAIL|'));
    assert.strictEqual(own.length, 2);
    assert.match(own[1].body, /^Same failure as last time — this needs a fix outside Post-fix Build \+ Tests\./);
    // A failed re-run whose tree is back to the tested one is begun, then skipped.
    edit('two\n');
    assert.strictEqual(once('P-FAIL').result, 'skipped');
    assert.strictEqual(h.stateOf('P-FAIL').phases[STAGE].status, 'skipped');

    // P5. Build + Tests itself dirtied the tree (codegen): the tree after it is
    // the tested one, so the post-fix re-run does not fire for it.
    seed('P-DIRTY', h.stages.slice(0, h.stages.indexOf('build-test')));
    const dirty = once('P-DIRTY', { STUB_BUILD: 'pass', STUB_DIRTY: '1' });
    assert.strictEqual(dirty.result, 'pass', dirty.stdout);
    assert.match(dirty.stderr, /build-test changed the worktree/);
    st = h.stateOf('P-DIRTY');
    assert.deepStrictEqual([st.testedWorkspace.stage, st.testedWorkspace.dirtied, st.testedWorkspace.fingerprint], ['build-test', true, treeFingerprint(h.product)]);
    st.phases.reviews = { status: 'pass' }; st.phases.fixes = { status: 'pass' };
    h.writeState('P-DIRTY', st);
    assert.strictEqual(once('P-DIRTY').result, 'skipped');

    // P6. Legacy runs: no recorded tree runs the re-run; a verified run skips it.
    seed('P-LEGACY');
    assert.strictEqual(once('P-LEGACY', { STUB_BUILD: 'pass' }).result, 'pass');
    assert.strictEqual(h.stateOf('P-LEGACY').phases[STAGE].status, 'pass');
    seed('P-VERIFIED', h.stages.filter(x => x !== STAGE && x !== 'pull-request'));
    assert.strictEqual(once('P-VERIFIED').result, 'skipped');
    assert.match(h.stateOf('P-VERIFIED').phases[STAGE].note, /verification passed before/);

    // P7. A verified run whose fixes are reworked: the re-run exists (reset to
    // pending), so the tree is compared, not the legacy verification shortcut.
    seed('P-REWORK', h.stages.filter(x => x !== 'pull-request'), { testedWorkspace: { stage: STAGE, fingerprint: treeFingerprint(h.product) } });
    h.retry('P-REWORK', 'fixes');
    st = h.stateOf('P-REWORK');
    assert.deepStrictEqual([st.phases.fixes.status, st.phases[STAGE].status, st.phases.verification.status], ['pending', 'pending', 'pass']);
    edit('four\n');
    assert.strictEqual(once('P-REWORK').result, 'pass', 'fixes runs again');
    assert.strictEqual(once('P-REWORK', { STUB_BUILD: 'pass' }).result, 'pass', 'the changed tree is tested again');
    assert.doesNotMatch(h.stateOf('P-REWORK').phases[STAGE].note || '', /verification passed before/);
    // The same rework on a run verified before the stage existed creates it, so it runs too.
    seed('P-OLDREWORK', h.stages.filter(x => x !== STAGE && x !== 'pull-request'));
    assert.match(h.retry('P-OLDREWORK', 'fixes'), /post-fix-build-test \(downstream of fixes\)/);
    assert.strictEqual(h.stateOf('P-OLDREWORK').phases[STAGE].status, 'pending');
    assert.strictEqual(once('P-OLDREWORK').result, 'pass');
    assert.strictEqual(once('P-OLDREWORK', { STUB_BUILD: 'pass' }).result, 'pass', 'no recorded tree: tested again');
  } finally { h.cleanup(); }
}

function selftest() {
  {
    const assert = require('assert');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noop-'));
    spawnSync('git', ['init', '-q', tmp]);
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\n');
    spawnSync('git', ['add', '-A'], { cwd: tmp });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: tmp });
    const wf = { roles: { implementation: { requires_changes: true }, fixes: {} } };
    // Clean worktree: a role that must change code has not done its job.
    assert.match(noopFailure(wf, 'implementation', tmp) || '', /changed no files/);
    // A role without the flag may legitimately change nothing.
    assert.strictEqual(noopFailure(wf, 'fixes', tmp), null);
    // A tracked edit counts.
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'two\n');
    assert.strictEqual(noopFailure(wf, 'implementation', tmp), null);
    // So does a brand new untracked file, which is how most implementations start.
    spawnSync('git', ['checkout', '--', 'a.txt'], { cwd: tmp });
    assert.match(noopFailure(wf, 'implementation', tmp) || '', /changed no files/);
    fs.writeFileSync(path.join(tmp, 'new.dart'), 'class A {}\n');
    assert.strictEqual(noopFailure(wf, 'implementation', tmp), null);
    // Once the pull-request stage has committed, the run's changes are in HEAD.
    // Against the run's base they still count; against HEAD they vanish.
    const runBase = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).stdout).trim();
    spawnSync('git', ['add', '-A'], { cwd: tmp });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'runtime commit'], { cwd: tmp });
    assert.match(noopFailure(wf, 'implementation', tmp) || '', /changed no files/, 'HEAD sees nothing after the commit');
    assert.strictEqual(noopFailure(wf, 'implementation', tmp, runBase), null, 'the run base still sees the committed change');
    assert.deepStrictEqual(changedFileList(tmp, runBase), ['new.dart']);
    assert.deepStrictEqual(require('./subagent-context').changedFiles(tmp, runBase), ['new.dart'], 'the role context lists it too');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    // The tree a build/test pass saw: HEAD, the diff and untracked files, not ignored ones.
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
    const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: tmp });
    spawnSync('git', ['init', '-q', tmp]);
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(tmp, '.gitignore'), 'build/\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const clean = treeFingerprint(tmp);
    assert.ok(clean && clean === treeFingerprint(tmp), 'stable across calls');
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'two\n');
    assert.notStrictEqual(treeFingerprint(tmp), clean, 'a tracked edit');
    git('checkout', '--', 'a.txt');
    assert.strictEqual(treeFingerprint(tmp), clean);
    fs.mkdirSync(path.join(tmp, 'build')); fs.writeFileSync(path.join(tmp, 'build', 'out.bin'), 'x');
    assert.strictEqual(treeFingerprint(tmp), clean, 'gitignored files do not count');
    fs.writeFileSync(path.join(tmp, 'new.dart'), 'class A {}\n');
    const untracked = treeFingerprint(tmp);
    assert.notStrictEqual(untracked, clean, 'a new untracked file');
    git('add', '-A'); git('commit', '-qm', 'second');
    assert.ok(![clean, untracked].includes(treeFingerprint(tmp)), 'HEAD is part of it');
    fs.rmSync(tmp, { recursive: true, force: true });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    assert.strictEqual(treeFingerprint(plain), null, 'no git, no fingerprint');
    fs.rmSync(plain, { recursive: true, force: true });
    assert.strictEqual(testsTree({ id: 'build-test' }), true);
    assert.strictEqual(testsTree(workflow().stages.find(x => x.id === 'post-fix-build-test')), true);
    assert.strictEqual(testsTree({ id: 'fixes' }), false);
    assert.strictEqual(SUPPORTED_CONDITIONS.has('changed_since_build_test'), true);
  }
  const wf = { stages: [{ id: 'a' }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['b'] }] };
  assert.strictEqual(nextEligibleStage(wf, { phases: {} }).id, 'a');
  assert.strictEqual(nextEligibleStage(wf, { phases: { a: { status: 'pass' } } }).id, 'b');
  assert.strictEqual(nextEligibleStage(wf, { phases: { a: { status: 'pass' }, b: { status: 'blocked' } } }).id, 'b');
  assert.strictEqual(nextEligibleStage(wf, { phases: { a: { status: 'pass' }, b: { status: 'pass' }, c: { status: 'pass' } } }), null);
  assert.strictEqual(depsSatisfied({ needs: ['a'] }, { phases: { a: { status: 'pass' } } }), true);
  assert.strictEqual(inferScope('Add a Flutter settings screen'), 'mobile');
  assert.strictEqual(inferScope('Add a backend database queue'), 'backend');
  assert.strictEqual(SUPPORTED_CONDITIONS.has('mobile_or_ui_feature'), true);
  assert.strictEqual(SUPPORTED_CONDITIONS.has('behavior_preserving_refactor'), true);
  assert.strictEqual(detectRefactorMode('Refactor this repository without changing behavior').mode, 'behavior_preserving_refactor');
  assert.strictEqual(detectRefactorMode('Refactor the entire application without changing behavior').refactorScope, 'whole_app');
  assert.strictEqual(SUPPORTED_CONDITIONS.has('whole_app_refactor'), true);
  {
    // Concurrency cap: stage max_parallel, else the env var, else 4; bad values run one at a time.
    const warnings = [];
    const warn = m => warnings.push(m);
    assert.strictEqual(parallelCap({ id: 'analysis' }, {}, warn), DEFAULT_MAX_PARALLEL);
    assert.strictEqual(parallelCap({ id: 'analysis' }, { AI_WORKFLOW_MAX_PARALLEL: '' }, warn), DEFAULT_MAX_PARALLEL);
    assert.strictEqual(parallelCap({ id: 'analysis' }, { AI_WORKFLOW_MAX_PARALLEL: '6' }, warn), 6);
    assert.strictEqual(parallelCap({ id: 'analysis', max_parallel: 2 }, { AI_WORKFLOW_MAX_PARALLEL: '6' }, warn), 2, 'the stage setting wins');
    assert.strictEqual(warnings.length, 0);
    for (const bad of ['0', '-3', '2.5', 'many']) assert.strictEqual(parallelCap({ id: 'reviews' }, { AI_WORKFLOW_MAX_PARALLEL: bad }, warn), 1, bad);
    assert.strictEqual(parallelCap({ id: 'reviews', max_parallel: 0 }, {}, warn), 1);
    assert.strictEqual(warnings.length, 5);
    assert.match(warnings[0], /AI_WORKFLOW_MAX_PARALLEL="0".*one at a time/);
    assert.match(warnings[4], /reviews\.max_parallel=0/);
  }
  {
    // Roles that read their siblings' outputs leave the concurrent batch and run
    // after it, in selection order; every other role stays in the batch.
    const reviews = ['behavior-regression-review', 'code-review', 'security-review', 'flutter-review'];
    assert.deepStrictEqual(splitSequentialTail(reviews), { batch: ['code-review', 'security-review', 'flutter-review'], tail: ['behavior-regression-review'] });
    const analysisStage = workflow().stages.find(x => x.id === 'analysis');
    assert.deepStrictEqual(splitSequentialTail(analysisStage.roles).tail, [], 'analysis specialists are all independent');
    const fake = name => ({ inputs: name.startsWith('late') ? ['validated_review_findings'] : ['changed_files'] });
    assert.deepStrictEqual(splitSequentialTail(['late-1', 'a', 'late-2', 'b'], fake), { batch: ['a', 'b'], tail: ['late-1', 'late-2'] });
    assert.deepStrictEqual(splitSequentialTail(['no-such-role'], () => { throw new Error('unknown'); }), { batch: ['no-such-role'], tail: [] });
    assert.strictEqual(executorScript({}), ROUTER, 'the stub executor needs the selftest switch');
    // A runtime tool's failure in its own words, else its exit status.
    assert.strictEqual(toolFailure({ status: 1, stderr: 'noise\n✗ Appium execution returned, but evidence validation failed:\n- no screenshots\n- stale build\n' }, 'mobile-evidence'), 'Appium execution returned, but evidence validation failed: - no screenshots - stale build');
    assert.strictEqual(toolFailure({ status: 1, stderr: '' }, 'mobile-evidence'), 'mobile-evidence exited 1');
    assert.strictEqual(toolFailure({ status: null, signal: 'SIGTERM', stderr: 'x' }, 'mobile-evidence'), 'mobile-evidence exited SIGTERM');
    assert.strictEqual(executorScript({ AI_WORKFLOW_TEST_EXECUTOR: '/tmp/x.js' }), ROUTER);
  }
  parallelStageSelftest();
  notificationSelftest();
  conflictDecisionSelftest();
  postFixBuildTestSelftest();
  console.log('workflow engine selftest OK');
}

// The selftest loads this file to drive a stage in a child process; only a
// direct run is the CLI.
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, idArg] = args._;
  try {
    if (cmd === 'selftest') selftest();
    else if (cmd === 'start') {
      let request = args.request || null;
      if (!request && args['request-file']) request = fs.readFileSync(path.resolve(args['request-file']), 'utf8');
      start(idArg, request, args.scope, args.mode, args['refactor-scope']);
      if (!args['no-run']) runLoop(idArg, { command: 'start' });
    } else if (cmd === 'next') {
      const state = loadState(idArg);
      if (!state) throw new Error(`run ${idArg} does not exist`);
      console.log(nextEligibleStage(workflow(), state)?.id || 'done');
    } else if (cmd === 'run-next') { if (!args['dry-run']) claimRun(idArg, 'run-next'); preflightExisting(idArg, args.scope); runLoop(idArg, { once: true, 'dry-run': !!args['dry-run'], command: 'run-next' }); }
    else if (cmd === 'resume' || cmd === 'run') { claimRun(idArg, cmd); preflightExisting(idArg, args.scope); runLoop(idArg, { command: cmd }); }
    else if (cmd === 'worktree') { const wt = inspectWorktree(RUNTIME_ROOT, idArg); if (!wt) throw new Error(`run ${idArg} has no worktree metadata`); console.log(JSON.stringify(wt, null, 2)); }
    else if (cmd === 'cleanup') console.log(JSON.stringify(cleanupWorktree(RUNTIME_ROOT, idArg, { force: !!args.force }), null, 2));
    else if (cmd === 'run-role') runRoleCommand(idArg, args._[2], args._[3]);
    else if (cmd === 'pr') pullRequestCommand(idArg, args);
    else throw new Error('usage: engine.js start <id> --request TEXT [--scope ...] [--mode feature|refactor] [--refactor-scope local|app] | next <id> | run-next <id> | resume <id> | run <id> | pr <id> [--base <branch>] [--branch <name>] [--draft] [--dry-run] [--reopen] | worktree <id> | cleanup <id> [--force] | selftest (internal: run-role <id> <stage> <role>)');
  } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}

module.exports = { workflow, executeStage, treeFingerprint, testsTree, recordTestedTree, runLoop, toolFailure, claimRun, notifyRun, pullRequestCommand, executeParallel, splitSequentialTail, parallelPidFile, parallelPgidFile, parallelCap, runRole, noopFailure, nextEligibleStage, depsSatisfied, analysisRoles, reviewRoles, detectStacks, inferScope, evaluateCondition, structuredSchema, productRoot, changedFileList, synthesizeAnalysis, readMode, readRefactorScope, promoteArchitectureAsCode };
