#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { selectAnalysis, selectReviews } = require('./subagent-selector');
const { synthesize } = require('./finding-synthesis');
const { detectConflicts, unresolvedBlocking } = require('./conflict-tracker');
const { roleContract, assertRequiredMcps } = require('./subagent-contracts');
const { buildRoleContext } = require('./subagent-context');
const { detectRefactorMode } = require('./refactor-mode');
const { canImplement, loadWaivers } = require('./refactor-coverage');
const { problems: refactorCheckpointProblems } = require('./refactor-checkpoints');
const { verificationMatrix } = require('./refactor-verification-matrix');
const { contractDiff, invariantProblems } = require('./refactor-contract-diff');
const { refactorTelemetry } = require('./refactor-telemetry');
const yaml = require('js-yaml');
const { materialize, sidecarForMarkdown, schemaContract } = require('./artifacts');
const { resolveExecutionPolicy, classifyFailure, executeWithPolicy } = require('./execution-policy');
const { attemptsFor, recordAttempt } = require('./attempts');
const { ensure: ensureWorktree, inspect: inspectWorktree, refresh: refreshWorktree, cleanup: cleanupWorktree } = require('./worktree');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const RUNS_TOOL = path.join(ROOT, 'ai', 'tasks', 'feature', 'runs.js');
const ROUTER = path.join(ROOT, 'ai', 'workflow', 'router.js');
const DOCTOR = path.join(ROOT, 'ai', 'workflow', 'doctor.js');
const MOBILE_EVIDENCE = path.join(ROOT, 'ai', 'tasks', 'feature', 'mobile-evidence.js');
const WORKFLOW_FILE = path.join(ROOT, 'ai', 'workflows', 'feature.yaml');
const TERMINAL_OK = new Set(['pass', 'skipped']);
const VALID_SCOPES = new Set(['auto', 'mobile', 'frontend', 'backend', 'all']);
const SUPPORTED_CONDITIONS = new Set(['mobile_or_ui_feature', 'behavior_preserving_refactor', 'whole_app_refactor']);

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
  const wt = id ? inspectWorktree(ROOT, id) : null;
  return wt?.exists ? wt.path : ROOT;
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
    cwd: options.cwd || ROOT,
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
function detectStacks(root = ROOT) {
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
  const state = loadState(id); if (state) {
    state.workflowMode = payload;
    state.history ||= [];
    state.history.push({ at: payload.detectedAt, actor: 'workflow-engine', kind: 'workflow-mode', to: payload.mode, reason: payload.reason });
    state.updatedAt = payload.detectedAt;
    const target=stateFile(id), tmp=target+'.tmp-'+process.pid+'-'+Date.now();
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n'); fs.renameSync(tmp,target);
  }
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
  const res = spawnSync(process.execPath, [DOCTOR, '--json', '--scope', scope], { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30 * 1000 });
  let report = null;
  try { report = JSON.parse(res.stdout || '{}'); } catch { /* show human result below */ }
  if (res.error || res.status !== 0 || !report) {
    const human = spawnSync(process.execPath, [DOCTOR, '--scope', scope], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 30 * 1000 });
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
function changedFileList(root) {
  const tracked = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return [...new Set([...(tracked.status === 0 ? String(tracked.stdout || '').split('\n') : []), ...(untracked.status === 0 ? String(untracked.stdout || '').split('\n') : [])].map(x => x.trim()).filter(Boolean))];
}

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
function analysisRoles(wf, state, scope = 'auto', root = ROOT, id = null) {
  const existing = state?.selectedRoles?.analysis;
  if (Array.isArray(existing) && existing.length) return existing;
  const stage = wf.stages.find(x => x.id === 'analysis') || {};
  const selected = selectAnalysis({ allowedRoles: stage.roles || [], request: id ? requestText(id) : '', root, scope });
  if (id) { fs.mkdirSync(engineDir(id), { recursive: true }); fs.writeFileSync(path.join(engineDir(id), 'subagent-selection-analysis.json'), JSON.stringify(selected, null, 2) + '\n'); }
  return selected.roles;
}
function reviewRoles(wf, state, root = ROOT, id = null) {
  const existing = state?.selectedRoles?.reviews;
  if (Array.isArray(existing) && existing.length) return existing;
  const stage = wf.stages.find(x => x.id === 'reviews') || {};
  const candidates = [...new Set([...(stage.roles || []), ...(stage.selectable_roles || [])])].filter(r => wf.roles?.[r]);
  const selected = selectReviews({ allowedRoles: candidates, changedFiles: changedFileList(root), root });
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
function synthesizeAnalysis(id) {
  const sources = loadFindingArtifacts(id); if (!sources.length) return { findings: [], conflicts: [] };
  const findings = synthesize(sources); let conflicts = detectConflicts(findings);
  const dir = path.join(runDir(id), '05-analysis'); fs.mkdirSync(dir, { recursive: true });
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(dir, 'conflicts.json'), 'utf8')).conflicts || [];
    const resolved = new Map(previous.filter(x => x.status === 'resolved' && x.resolution).map(x => [x.findings.slice().sort().join('|'), x]));
    conflicts = conflicts.map(x => resolved.get(x.findings.slice().sort().join('|')) || x);
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
function promptFile(id, stageId, roleName) { const dir = engineDir(id); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, `${stageId}-${roleName}.md`); }
function structuredSchema(wf, stage, roleName) { return stage.artifact_schema || wf.roles?.[roleName]?.artifact_schema || null; }

function executeRole(id, wf, stage, roleName, output) {
  assertRequiredMcps(roleName);
  const prompt = promptFile(id, stage.id, roleName);
  const schemaName = structuredSchema(wf, stage, roleName);
  if (schemaName && !output) throw new Error(`${stage.id}/${roleName}: structured artifact schema ${schemaName} requires an artifact path`);
  const structuredInstruction = schemaName ? `\nThis stage is machine-gated. Return ONLY one JSON object, with no Markdown fence or prose. It MUST match this JSON Schema exactly enough for validation and MUST use runId "${id}". The runtime will validate it, save the .json sidecar, and render the human-readable Markdown.\n\nJSON Schema:\n${schemaContract(schemaName)}\n` : '';
  const refactorInstruction = readMode(id)==='behavior_preserving_refactor' && roleName==='implementation'
    ? `\nRefactor mode is active. Execute the approved refactorIncrements strictly in order. After each logical increment, run its required verification and record evidence with:\nnode ${path.join(ROOT,'ai','workflow','refactor-checkpoints.js')} record ${id} <increment-id> --diff "<git diff reference or summary>" --test "<verification command/result>"\nDo not combine business/UI redesign with mechanical restructuring and do not continue to the next increment until the current checkpoint is recorded.\n`
    : '';
  const body = `# Deterministic workflow assignment\n\nRun: ${id}\nStage: ${stage.id}\nRole: ${roleName}\nScope: ${readScope(id)}\nProduct worktree: ${productRoot(id)}\n\nThe workflow engine owns state. Perform only this stage responsibility. Do not advance stages or approve gates.\n${output ? schemaName ? `Return the structured artifact for ${output}.` : `Write your final stage artifact as the response; the engine stores it at ${output}.` : ''}${structuredInstruction}${refactorInstruction}\n${buildRoleContext({ runDir: runDir(id), productRoot: productRoot(id), contract: roleContract(roleName), excludeArtifact: output })}\n`;
  fs.writeFileSync(prompt, body);

  const policy = resolveExecutionPolicy(wf, stage, roleName);
  const state = loadState(id) || {};
  const previous = attemptsFor(state, stage.id, roleName);
  const worktree = productRoot(id);
  const result = executeWithPolicy(policy, previous, ({ executor, attemptNumber, timeoutMs }) => {
    const attemptId = `${id}-${stage.id}-${roleName}-${attemptNumber}-${Date.now()}`;
    const rawOutput = output ? path.join(engineDir(id), `${stage.id}-${roleName}-${attemptNumber}.raw`) : null;
    if (rawOutput) { try { fs.unlinkSync(rawOutput); } catch { /* clean prior temp */ } }
    const args = [ROUTER, 'exec', 'feature', roleName, '--agent', executor, '--prompt-file', prompt, '--cwd', worktree, '--timeout-min', String(Math.max(1, Math.ceil(timeoutMs / 60000)))];
    if (rawOutput) args.push('--output-file', rawOutput);
    const child = spawnRaw(process.execPath, args, {
      env: { FEATURE_RUN_ID: id, AI_WORKFLOW_ENGINE: '1', AI_WORKFLOW_SCOPE: readScope(id), AI_WORKFLOW_ATTEMPT_ID: attemptId, AI_WORKFLOW_PRODUCT_ROOT: worktree, AI_WORKFLOW_RUNTIME_ROOT: ROOT },
      timeout: timeoutMs + 15000,
    });
    if (child.error || child.status !== 0) {
      const exitType = classifyFailure(child);
      if (rawOutput) { try { fs.unlinkSync(rawOutput); } catch { /* no output */ } }
      return { ok: false, exitType, reason: child.error?.message || `${executor} exited ${child.status}`, attemptId };
    }
    try {
      if (output) {
        if (!rawOutput || !fs.existsSync(rawOutput)) throw new Error(`${executor} produced no artifact output`);
        const markdownFile = path.join(runDir(id), output);
        if (schemaName) materialize(schemaName, fs.readFileSync(rawOutput, 'utf8'), sidecarForMarkdown(markdownFile), markdownFile, id);
        else { fs.mkdirSync(path.dirname(markdownFile), { recursive: true }); fs.copyFileSync(rawOutput, markdownFile); }
      }
      refreshWorktree(ROOT, id);
      return { ok: true, value: { executor, attemptId }, attemptId };
    } catch (error) {
      return { ok: false, exitType: 'deterministic', reason: `artifact/worktree validation failed: ${error.message}`, attemptId };
    } finally { if (rawOutput) { try { fs.unlinkSync(rawOutput); } catch { /* best effort */ } } }
  }, entry => recordAttempt(ROOT, id, stage.id, roleName, entry));

  if (!result.ok) throw new Error(`${stage.id}/${roleName}: ${result.reason}`);
  if (result.skipped) {
    const all = attemptsFor(loadState(id) || {}, stage.id, roleName);
    return { executor: all.at(-1)?.executor || policy.candidates[0], resumed: true };
  }
  return result.value || { executor: result.attempts.at(-1)?.executor || policy.candidates[0] };
}

function executeParallel(id, wf, stage) {
  let state = loadState(id);
  const scope = readScope(id);
  const roles = stage.id === 'analysis' ? analysisRoles(wf, state, scope, productRoot(id), id) : stage.id === 'reviews' ? reviewRoles(wf, state, productRoot(id), id) : (state?.selectedRoles?.[stage.id] || stage.roles || []);
  if (!roles.length) throw new Error(`${stage.id}: no roles selected`);
  if (!Array.isArray(state?.selectedRoles?.[stage.id]) || !state.selectedRoles[stage.id].length) selectRoles(id, stage.id, roles);
  for (const roleName of roles) {
    state = loadState(id);
    const status = state?.roles?.[stage.id]?.[roleName]?.status || 'pending';
    if (TERMINAL_OK.has(status)) continue;
    const preferredExecutor = (wf.roles[roleName] || {}).executor || '-';
    role(id, 'begin', stage.id, roleName, preferredExecutor, 'engine execution');
    try {
      const execution = executeRole(id, wf, stage, roleName, (wf.roles[roleName] || {}).artifact);
      role(id, 'complete', stage.id, roleName, execution.executor || preferredExecutor, 'engine completed role');
    } catch (e) {
      role(id, 'fail', stage.id, roleName, preferredExecutor, e.message.slice(0, 180));
      throw e;
    }
  }
  state = loadState(id);
  if (!TERMINAL_OK.has(phaseStatus(state, stage.id))) throw new Error(`${stage.id}: selected roles did not reach a successful terminal state`);
  if (stage.id === 'analysis') synthesizeAnalysis(id);
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
        command(process.execPath, [MOBILE_EVIDENCE, 'run', id], { env: { FEATURE_RUN_ID: id, AI_WORKFLOW_SCOPE: readScope(id), AI_WORKFLOW_ENGINE: '1', AI_WORKFLOW_PRODUCT_ROOT: worktree, AI_WORKFLOW_RUNTIME_ROOT: ROOT } });
      }
    } else executeRole(id, wf, stage, roleName, (wf.roles[roleName] || {}).artifact);
    conditionalState(id, stage.id, roleName, 'pass', result.reason);
    return 'pass';
  } catch (e) { conditionalState(id, stage.id, roleName, 'blocked', e.message.slice(0, 180)); throw e; }
}

function executeStage(id, wf, stage, args = {}) {
  const state = loadState(id);
  if (!depsSatisfied(stage, state)) throw new Error(`${stage.id}: dependencies are not complete: ${(stage.needs || []).map(d => `${d}=${phaseStatus(state, d)}`).join(', ')}`);
  if (args['dry-run']) { console.log(`${id}: next=${stage.id}`); return 'dry-run'; }
  if (stage.when) {
    const condition = evaluateCondition(stage.when, id, state);
    if (!condition.known) throw new Error(`${stage.id}: unknown condition ${stage.when}`);
    if (!condition.value) {
      phase(id, 'skip', stage.id, 'workflow-engine', condition.reason);
      return 'skipped';
    }
  }
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
      if (stage.id === 'architecture-selection') {
        console.log(`${id}: waiting for architecture selection — review ai/runs/${id}/05-architecture-assessment.md and 05-architecture-options.md then run: npm run refactor:architecture -- ${id} <option-id>`);
      } else {
        console.log(`${id}: waiting for human approval — review ai/runs/${id}/06-plan.md then run: node ai/tasks/feature/runs.js approve ${id}`);
      }
      return 'waiting';
    }
    return 'pass';
  }
  if (stage.id === 'plan') {
    const synthesis = synthesizeAnalysis(id);
    const unresolved = unresolvedBlocking(synthesis.conflicts);
    if (unresolved.length) throw new Error(`plan blocked by unresolved subagent conflict(s): ${unresolved.map(x => x.id).join(', ')}`);
  }
  if (stage.strategy === 'parallel') { executeParallel(id, wf, stage); return 'pass'; }
  if (stage.id === 'build-test' && readMode(id)==='behavior_preserving_refactor') {
    const baseline=readJson(path.join(runDir(id),'04-behavior-baseline.json'))||{};
    const matrix=verificationMatrix({files:changedFileList(productRoot(id)),baseline});
    fs.mkdirSync(engineDir(id),{recursive:true});
    fs.writeFileSync(path.join(engineDir(id),'refactor-verification-matrix.json'),JSON.stringify(matrix,null,2)+'\n');
  }
  executeConditional(id, wf, stage);
  const roleName = stage.role || (stage.owner === 'orchestrator' ? 'orchestration' : null);
  if (!roleName) throw new Error(`${stage.id}: no executable role`);
  const preferredExecutor = (wf.roles[roleName] || {}).executor || wf.orchestrator?.executor || '-';
  phase(id, 'begin', stage.id, preferredExecutor, `engine executing ${roleName}`);
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
    phase(id, 'complete', stage.id, execution.executor || preferredExecutor, `engine completed ${roleName}`);
  } catch (e) {
    try { phase(id, 'fail', stage.id, preferredExecutor, e.message.slice(0, 180)); } catch { /* preserve original */ }
    throw e;
  }
  return 'pass';
}

function ensureRunWorktree(id) {
  const wt = ensureWorktree(ROOT, id, { sourceRoot: ROOT });
  process.env.AI_WORKFLOW_PRODUCT_ROOT = wt.path;
  process.env.AI_WORKFLOW_RUNTIME_ROOT = ROOT;
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
  let iterations = 0;
  while (iterations++ < 50) {
    const state = loadState(id);
    if (!state) throw new Error(`run ${id} does not exist`);
    const stage = nextEligibleStage(wf, state);
    if (!stage) { console.log(`${id}: workflow complete`); refreshWorktree(ROOT, id); return 'complete'; }
    console.log(`${id}: ${stage.id} (${phaseStatus(state, stage.id)})`);
    const result = executeStage(id, wf, stage, opts);
    if (result === 'waiting' || result === 'dry-run') return result;
    const updated = loadState(id);
    if (['fail', 'blocked'].includes(phaseStatus(updated, stage.id))) return phaseStatus(updated, stage.id);
    if (opts.once) return result;
  }
  throw new Error('workflow exceeded 50 engine iterations');
}

function selftest() {
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
  console.log('workflow engine selftest OK');
}

const args = parseArgs(process.argv.slice(2));
const [cmd, idArg] = args._;
try {
  if (cmd === 'selftest') selftest();
  else if (cmd === 'start') {
    let request = args.request || null;
    if (!request && args['request-file']) request = fs.readFileSync(path.resolve(args['request-file']), 'utf8');
    start(idArg, request, args.scope, args.mode, args['refactor-scope']);
    if (!args['no-run']) runLoop(idArg, {});
  } else if (cmd === 'next') {
    const state = loadState(idArg);
    if (!state) throw new Error(`run ${idArg} does not exist`);
    console.log(nextEligibleStage(workflow(), state)?.id || 'done');
  } else if (cmd === 'run-next') { preflightExisting(idArg, args.scope); runLoop(idArg, { once: true, 'dry-run': !!args['dry-run'] }); }
  else if (cmd === 'resume' || cmd === 'run') { preflightExisting(idArg, args.scope); runLoop(idArg, {}); }
  else if (cmd === 'worktree') { const wt = inspectWorktree(ROOT, idArg); if (!wt) throw new Error(`run ${idArg} has no worktree metadata`); console.log(JSON.stringify(wt, null, 2)); }
  else if (cmd === 'cleanup') console.log(JSON.stringify(cleanupWorktree(ROOT, idArg, { force: !!args.force }), null, 2));
  else throw new Error('usage: engine.js start <id> --request TEXT [--scope ...] [--mode feature|refactor] [--refactor-scope local|app] | next <id> | run-next <id> | resume <id> | run <id> | worktree <id> | cleanup <id> [--force] | selftest');
} catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }

module.exports = { nextEligibleStage, depsSatisfied, analysisRoles, reviewRoles, detectStacks, inferScope, evaluateCondition, structuredSchema, productRoot, changedFileList, synthesizeAnalysis, readMode, readRefactorScope, promoteArchitectureAsCode };
