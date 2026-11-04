#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { stateRoot, projectRoot, relativeStatePath } = require('./paths');
const { openConflicts } = require('./conflict-tracker');
const { liveEngine, readOwner, describe: describeEngine } = require('./engine-owner');
const pullRequest = require('./pull-request');

const RUNS = stateRoot();
const ACTIVE = path.join(RUNS, '_active');

const PHASES = [
  'request',
  'requirements',
  'acceptance-criteria',
  'definition-of-done',
  'inspection',
  'analysis',
  'plan',
  'approval',
  'implementation',
  'build-test',
  'reviews',
  'fixes',
  'post-fix-build-test',
  'verification',
  'pull-request',
];

const LABELS = {
  request: 'Request',
  requirements: 'Requirements',
  'acceptance-criteria': 'Acceptance Criteria',
  'definition-of-done': 'Definition of Done',
  inspection: 'Repository Inspection',
  analysis: 'Specialist Analysis',
  plan: 'Implementation Plan',
  approval: 'Human Approval',
  implementation: 'Implementation',
  'build-test': 'Build + Tests',
  reviews: 'Independent Reviews',
  fixes: 'Validated Fixes',
  'post-fix-build-test': 'Post-fix Build + Tests',
  verification: 'Final Verification',
  'pull-request': 'Pull Request',
};

const ICONS = {
  pass: '✅',
  fail: '❌',
  blocked: '⛔',
  skipped: '⏭',
  in_progress: '🔄',
  pending: '⏳',
};

const DONE = new Set(['pass', 'skipped']);
const RUNNING = new Set(['in_progress']);
const TERMINAL_ROLE_STATUSES = new Set(['pass', 'fail', 'blocked', 'skipped']);

function activeId() {
  try {
    const id = fs.readFileSync(ACTIVE, 'utf8').trim();
    return id && fs.existsSync(path.join(RUNS, id)) ? id : null;
  } catch {
    return null;
  }
}

function loadState(id) {
  if (!id) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS, id, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function demoState() {
  return {
    id: 'DEMO-123',
    status: 'active',
    startedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    phases: {
      request: { status: 'pass' },
      requirements: { status: 'pass' },
      'acceptance-criteria': { status: 'pass' },
      'definition-of-done': { status: 'pass' },
      inspection: { status: 'pass' },
      analysis: { status: 'in_progress' },
    },
    selectedRoles: {
      analysis: ['docs', 'architect', 'qa-plan', 'security', 'performance', 'android', 'ios'],
    },
    roles: {
      analysis: {
        docs: { status: 'pass', executor: 'claude' },
        architect: { status: 'pass', executor: 'claude' },
        'qa-plan': { status: 'pass', executor: 'claude' },
        security: { status: 'in_progress', executor: 'claude' },
        performance: { status: 'pass', executor: 'claude' },
        android: { status: 'pending', executor: 'claude' },
        ios: { status: 'skipped', executor: 'claude' },
      },
    },
  };
}

function rawStatusOf(state, phase) {
  return state?.phases?.[phase]?.status || 'pending';
}

function roleEntries(state, group) {
  return Object.entries(state?.roles?.[group] || {});
}

function selectedRoleNames(state, group) {
  const explicit = state?.selectedRoles?.[group];
  if (Array.isArray(explicit) && explicit.length) return explicit;
  return roleEntries(state, group).map(([role]) => role);
}

function downstreamStarted(state, phase) {
  const index = PHASES.indexOf(phase);
  return PHASES.slice(index + 1).some(next => rawStatusOf(state, next) !== 'pending');
}

function deriveRoleGroupStatus(state, group) {
  const entries = roleEntries(state, group);
  const explicitSelection = Array.isArray(state?.selectedRoles?.[group]) && state.selectedRoles[group].length > 0;
  const legacyCanClose = !explicitSelection
    && entries.length > 0
    && entries.every(([, entry]) => TERMINAL_ROLE_STATUSES.has(entry.status))
    && downstreamStarted(state, group);

  if (!explicitSelection && !legacyCanClose) return null;
  const names = selectedRoleNames(state, group);
  if (!names.length) return null;
  const statuses = names.map(role => state?.roles?.[group]?.[role]?.status || 'pending');

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

// A run closed (or abandoned) before 1.9.31 has no pull-request phase, and one
// closed with the stage disabled still stores it as pending (the skip was
// derived, never written): the same. A verified, closed run is finished, so
// the stage shows as skipped. An abandoned run, or one closed unverified,
// never reached the stage: it is left out of the percent instead of counting
// as done.
function legacyPullRequest(state) {
  if (state?.status !== 'done' || rawStatusOf(state, 'pull-request') !== 'pending') return null;
  return !state.abandoned && rawStatusOf(state, 'verification') === 'pass' ? 'skipped' : 'excluded';
}

// The project's pull_request block, read once per root and config.yaml
// mtime: the dashboard asks every second, and a selftest rewrites the file
// between asserts.
let prConfig = null;
function pullRequestConfig(root = projectRoot()) {
  let mtime = 0;
  try { mtime = fs.statSync(path.join(root, '.agentic', 'config.yaml')).mtimeMs; } catch { /* no file: disabled */ }
  if (!prConfig || prConfig.root !== root || prConfig.mtime !== mtime) prConfig = { root, mtime, config: pullRequest.loadConfig(root) };
  return prConfig.config;
}
// The pull-request stage is opt-in (pull-request.js). With pull_request.enabled
// not true and no `agentic pr` request, a verified run has nothing left to do,
// whether the engine recorded the skip or the run was verified before 1.9.31
// and has no phase at all: derived here, never written. Only a raw pending
// (missing or stored) qualifies; in_progress, blocked and fail keep their
// meaning, and a closed run is legacyPullRequest's. A block that does not
// parse (`enabled: "yes"`, broken YAML) is not a disabled one: the stage keeps
// waiting and the problems go into the summary's warnings, so a typo never
// reads as "complete".
function pullRequestOptions(state) { return pullRequest.effectiveOptions(pullRequestConfig(), state?.pullRequestOptions); }
function disabledPullRequest(state) {
  if (state?.status === 'done' || rawStatusOf(state, 'pull-request') !== 'pending' || rawStatusOf(state, 'verification') !== 'pass') return false;
  const options = pullRequestOptions(state);
  return !options.enabled && !options.problems.length;
}
// What is wrong with the block, while the stage is still to run on an open run.
function pullRequestProblems(state) {
  return state?.status !== 'done' && rawStatusOf(state, 'pull-request') === 'pending' ? pullRequestOptions(state).problems : [];
}
// The one wording for a recorded and a derived skip.
function pullRequestSkipNote(id, cli = process.env.AI_AGENTIC_CLI === '1') { return `pull_request disabled (open one with: ${commandFor('pr', id, cli)})`; }

function effectiveStatus(state, phase) {
  if (phase === 'analysis' || phase === 'reviews') {
    const derived = deriveRoleGroupStatus(state, phase);
    if (derived) return derived;
  }

  const raw = rawStatusOf(state, phase);
  // A run closed before 1.9.31 never had a pull-request stage, and an active
  // run with the stage disabled has nothing to do there: finished, not waiting.
  if (phase === 'pull-request' && (legacyPullRequest(state) === 'skipped' || disabledPullRequest(state))) return 'skipped';
  // A run verified before the post-fix re-run existed never needs it.
  if (phase === 'post-fix-build-test' && !state?.phases?.[phase] && DONE.has(rawStatusOf(state, 'verification'))) return 'skipped';
  if (phase === 'plan' && rawStatusOf(state, 'approval') === 'pass' && ['pending', 'in_progress'].includes(raw)) {
    return 'pass';
  }
  return raw;
}

function unitProgress(status) {
  if (DONE.has(status)) return 1;
  if (RUNNING.has(status)) return 0.5;
  return 0;
}

function phaseProgress(state, phase) {
  const roles = roleEntries(state, phase);
  if ((phase === 'analysis' || phase === 'reviews') && roles.length) {
    const selected = selectedRoleNames(state, phase);
    const considered = selected.length ? selected : roles.map(([role]) => role);
    const value = considered.reduce((sum, role) => sum + unitProgress(state?.roles?.[phase]?.[role]?.status || 'pending'), 0);
    return value / considered.length;
  }
  return unitProgress(effectiveStatus(state, phase));
}

function percentComplete(state) {
  const counted = legacyPullRequest(state) === 'excluded' ? PHASES.filter(phase => phase !== 'pull-request') : PHASES;
  const total = counted.reduce((sum, phase) => sum + phaseProgress(state, phase), 0);
  return Math.round((total / counted.length) * 100);
}

function lastUpdated(state) {
  const times = [state?.updatedAt, state?.startedAt, state?.closedAt];
  for (const phase of Object.values(state?.phases || {})) times.push(phase?.updatedAt);
  for (const group of Object.values(state?.roles || {})) {
    for (const role of Object.values(group || {})) times.push(role?.updatedAt);
  }
  const valid = times.filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  return valid.length ? new Date(Math.max(...valid)).toISOString() : null;
}

function currentWork(state) {
  // Prefer the furthest downstream blocked/failed stage: it is the actionable stop.
  for (const phase of [...PHASES].reverse()) {
    const status = effectiveStatus(state, phase);
    if (status === 'blocked' || status === 'fail') return `${LABELS[phase]} (${status})`;
  }

  // If stale earlier phases remain in_progress, the furthest downstream active phase wins.
  for (const phase of [...PHASES].reverse()) {
    if (effectiveStatus(state, phase) !== 'in_progress') continue;
    if (phase === 'analysis' || phase === 'reviews') {
      // Roles of a parallel stage run at the same time, so name all of them.
      const running = roleEntries(state, phase).filter(([, entry]) => entry.status === 'in_progress').map(([name]) => name);
      if (running.length) return `${LABELS[phase]} → ${running.join(', ')}`;
    }
    return LABELS[phase];
  }

  const pending = PHASES.find(phase => effectiveStatus(state, phase) === 'pending');
  return pending ? `Waiting for ${LABELS[pending]}` : 'Done';
}

function consistencyIssues(state) {
  const issues = [];

  for (const group of ['analysis', 'reviews']) {
    const derived = deriveRoleGroupStatus(state, group);
    const raw = rawStatusOf(state, group);
    if (derived && raw !== derived) {
      issues.push(`${LABELS[group]} stored as ${raw}, but role states imply ${derived}.`);
    }
  }

  const rawPlan = rawStatusOf(state, 'plan');
  if (rawStatusOf(state, 'approval') === 'pass' && ['pending', 'in_progress'].includes(rawPlan)) {
    issues.push(`Human Approval is pass, so Implementation Plan is treated as pass instead of stale ${rawPlan}.`);
  }

  const rawRunning = PHASES.filter(phase => rawStatusOf(state, phase) === 'in_progress');
  if (rawRunning.length > 1) {
    issues.push(`Multiple stored phases are in_progress (${rawRunning.join(', ')}); Current uses the furthest downstream active stage.`);
  }

  return issues;
}

function progressBar(percent, width = 28) {
  const filled = Math.round((percent / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function planApproved(id, root = RUNS) {
  return id !== 'DEMO-123' && fs.existsSync(path.join(root, id, 'plan.approved'));
}

// The PR line: whitelisted fields of state.pullRequest (never the whole
// object), or, when the stage was skipped or is stuck, the command that opens it.
function pullRequestSummary(state) {
  const pr = state?.pullRequest;
  if (!pr || !pr.url) return null;
  return { provider: pr.provider || null, number: pr.number ?? null, url: pr.url, status: pr.status || null, branch: pr.branch || null, base: pr.base || null, draft: !!pr.draft };
}
function pullRequestHint(id, state) {
  if (pullRequestSummary(state)) return null;
  // A run closed before the stage existed gets no hint: its PR may well have
  // been opened by hand, and following the hint could open a second one. An
  // active run whose stage is disabled gets it (the stage reads as skipped).
  if (!state?.phases?.['pull-request'] && !disabledPullRequest(state)) return null;
  if (!['skipped', 'blocked', 'fail'].includes(effectiveStatus(state, 'pull-request'))) return null;
  const command = commandFor('pr', id);
  // A closed run opens one only when asked for explicitly.
  return state.status === 'done' ? `${command} --reopen` : command;
}
function pullRequestLine(summary) {
  if (summary.pullRequest) return `Pull request: ${summary.pullRequest.number != null ? `#${summary.pullRequest.number} ` : ''}${summary.pullRequest.url}${summary.pullRequest.draft ? ' (draft)' : ''}`;
  if (summary.pullRequestHint) return `Pull request: not opened — run: ${summary.pullRequestHint}`;
  return null;
}

// ---------------------------------------------------------------- needs you
// What the run is waiting on a human for, derived from state alone, so the
// dashboard, `agentic status`, the Markdown view and the engine's notification
// say the same thing: a stage (or a stage's conditional role) that failed or
// blocked, with its reason and the command that continues; the plan approval
// or architecture selection gate; or unresolved specialist conflicts that hold
// the plan back. Returns null when nothing waits on a human.

// The workflow: stage order (so refactor-only stages sort where they run),
// each stage's spec and the role specs, for the artifact a stopped stage wrote.
let workflowSpec = null;
function loadWorkflow() {
  if (workflowSpec) return workflowSpec;
  try {
    const wf = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'feature.yaml'), 'utf8')) || {};
    workflowSpec = { order: (wf.stages || []).map(stage => stage.id), stages: new Map((wf.stages || []).map(stage => [stage.id, stage])), roles: wf.roles || {} };
  } catch { workflowSpec = { order: PHASES, stages: new Map(), roles: {} }; }
  return workflowSpec;
}
function stageOrder() { return loadWorkflow().order; }
// A run file as this install spells it: relative to the project with `agentic`, ai/runs/<id>/… otherwise.
function runFile(id, file, cli) { return cli ? relativeStatePath(id, file) : `ai/runs/${id}/${file}`; }
// The roles of a parallel stage that failed or blocked, plus the conditional role when one did.
function stoppedEntries(state, phase) { return roleEntries(state, phase).filter(([, role]) => role.status === 'fail' || role.status === 'blocked'); }
// A role name as runs.js' safeRole accepts it. Role keys come straight from
// state.json; one that fails this never becomes a `retry <role>` command (which
// runs.js would refuse anyway), a path under the run directory, or terminal text.
const SAFE_ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
function stoppedRoles(state, phase, role) { return [...stoppedEntries(state, phase).map(([name]) => name), ...(role ? [role] : [])].filter(name => SAFE_ROLE.test(name)); }
// The files a stopped stage leaves behind, from the workflow: the stage's or
// its role's artifact, the artifact of each stopped role, and the rejected
// agent output the engine keeps (engine/<stage>-<role>.rejected). A stage the
// workflow does not know yields nothing, so a stage id taken from state.json
// never becomes a path. The caller keeps the ones that exist.
function stageFiles(stage, role, state) {
  const { stages, roles } = loadWorkflow();
  const spec = stages.get(stage);
  if (!spec) return [];
  const stopped = stoppedRoles(state, stage, role);
  const names = spec.role ? [spec.role] : stopped.length ? stopped : spec.owner === 'orchestrator' ? ['orchestration'] : [];
  return [...new Set([spec.artifact, roles[spec.role]?.artifact, ...stopped.map(name => roles[name]?.artifact), ...names.map(name => `engine/${stage}-${name}.rejected`)].filter(Boolean))];
}
function labelOf(phase) { return LABELS[phase] || oneLine(String(phase).split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '), 60); }
// Escape sequences (CSI, OSC such as the OSC 52 clipboard write, any other ESC)
// and C0/C1 control characters. Notes come from agent and tool output, or are
// written straight into state.json; on a terminal they could move the cursor
// and rewrite the command a human is told to type.
const TERMINAL_UNSAFE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\u0000-\u001f\u007f-\u009f]/g;
function printable(text) { return String(text == null ? '' : text).replace(TERMINAL_UNSAFE, ' '); }
// One printable line, at most `max` characters.
function oneLine(text, max = 220) {
  const value = printable(text).replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
// The command a human types next, as this install spells it. `target` is the
// conflict a resolve names (a placeholder when there are several), or the role
// or stage a retry-role reworks.
function commandFor(action, id, cli = process.env.AI_AGENTIC_CLI === '1', target = '<conflict-id>') {
  const engine = `node ai/workflow/engine.js resume ${id}`;
  switch (action) {
    case 'retry': return cli ? `agentic retry ${id}` : `node ai/tasks/feature/runs.js retry ${id} && ${engine}`;
    case 'retry-role': return cli ? `agentic retry ${id} ${target}` : `node ai/tasks/feature/runs.js retry ${id} ${target} && ${engine}`;
    case 'resume': return cli ? `agentic resume ${id}` : engine;
    case 'approve': return cli ? `agentic approve ${id}` : `node ai/tasks/feature/runs.js approve ${id} && ${engine}`;
    case 'architecture': return cli ? `agentic architecture ${id} <option-id>` : `npm run refactor:architecture -- ${id} <option-id>`;
    case 'conflicts': return cli ? `agentic conflicts ${id}` : `node ai/workflow/conflicts.js list ${id}`;
    case 'resolve': return `${cli ? 'agentic resolve' : 'node ai/workflow/conflicts.js resolve'} ${id} ${target} --decision "..." --rationale "..."`;
    case 'status': return cli ? `agentic status ${id}` : `node ai/workflow/progress.js --run ${id}`;
    case 'doctor': return cli ? 'agentic doctor' : 'node ai/workflow/doctor.js';
    case 'pr': return cli ? `agentic pr ${id}` : `node ai/workflow/engine.js pr ${id}`;
    default: throw new Error(`unknown action ${action}`);
  }
}

function needsYou(id, state, options = {}) {
  if (!state || state.status === 'done') return null;
  const cli = options.cli !== undefined ? options.cli : process.env.AI_AGENTIC_CLI === '1';
  const root = options.root || RUNS;
  // The views show 220 characters; the engine's notification asks for all of
  // it, so notify.js can redact before it shortens.
  const reasonMax = options.reasonMax || 220;
  const order = stageOrder();
  const status = phase => effectiveStatus(state, phase);
  const artifact = file => runFile(id, file, cli);

  const stuck = [];
  for (const phase of new Set([...order, ...PHASES, ...Object.keys(state.phases || {})])) {
    const value = status(phase);
    if (value !== 'fail' && value !== 'blocked') continue;
    const entry = state.phases?.[phase] || {};
    const roles = stoppedEntries(state, phase);
    stuck.push({
      phase,
      status: value,
      reason: roles.length ? roles.map(([name, role]) => `${name}: ${role.note || role.status}`).join('; ') : entry.note || `${value}, with no reason recorded`,
      repeated: Math.max(Number(entry.repeatedFailure) || 0, ...roles.map(([, role]) => Number(role.repeatedFailure) || 0)),
      at: roles.length ? roles.map(([, role]) => role.updatedAt || '').sort().pop() : entry.updatedAt,
    });
  }
  // A conditional role (verification's mobile-evidence) blocks before its
  // stage begins, so the stage itself still reads pending.
  for (const [phase, group] of Object.entries(state.conditionals || {})) {
    if (DONE.has(status(phase))) continue;
    for (const [role, entry] of Object.entries(group || {})) {
      if (entry?.status !== 'fail' && entry?.status !== 'blocked') continue;
      stuck.push({ phase, role, status: entry.status, reason: `${role}: ${entry.reason || entry.status}`, repeated: Number(entry.repeatedFailure) || 0, at: entry.updatedAt });
    }
  }
  if (stuck.length) {
    // The furthest downstream stop is the actionable one (as in currentWork).
    const top = stuck.sort((a, b) => order.indexOf(b.phase) - order.indexOf(a.phase))[0];
    const label = labelOf(top.phase);
    const repeated = top.repeated >= 2 ? top.repeated : 0;
    return {
      kind: top.status,
      stage: top.phase,
      role: top.role || null,
      label,
      headline: repeated ? `Same failure as last time — this needs a fix outside ${label}` : `${label}${top.role ? ` (${oneLine(top.role, 60)})` : ''} ${top.status === 'fail' ? 'failed' : 'blocked'}`,
      reason: oneLine(top.reason, reasonMax),
      // Every pull-request step can be repeated, so a resume continues it; any
      // other stopped stage needs its spent attempts cleared first.
      command: commandFor(top.phase === 'pull-request' ? 'resume' : 'retry', id, cli),
      repeated,
      key: `${id}|${top.phase}${top.role ? `/${top.role}` : ''}|${top.status}|${top.at || ''}`,
    };
  }

  const waiting = (stage, headline, reason, command, at) => ({ kind: 'waiting', stage, role: null, label: labelOf(stage), headline, reason, command, repeated: 0, key: `${id}|${stage}|waiting|${at || ''}` });
  if (status('architecture-options') === 'pass' && !DONE.has(status('architecture-selection')) && !fs.existsSync(path.join(root, id, 'architecture.selected'))) {
    return waiting('architecture-selection', 'Architecture selection waits for you', `Review ${artifact('05-architecture-assessment.md')} and ${artifact('05-architecture-options.md')}, then choose an option.`, commandFor('architecture', id, cli), state.phases?.['architecture-options']?.updatedAt);
  }
  if (status('plan') === 'pass' && rawStatusOf(state, 'approval') !== 'pass' && !planApproved(id, root)) {
    // The digest rides along; headline, reason, command and key stay as they are.
    return { ...waiting('approval', 'The plan waits for your approval', `Review ${artifact('06-plan.md')}; approving lets implementation start.`, commandFor('approve', id, cli), state.phases?.plan?.updatedAt), plan: planDigest(id, root, cli) };
  }
  // Open conflicts hold the plan back once it could run (feature.yaml: plan
  // needs conflict-arbitration). Before arbitration is done again, the file
  // still holds the previous set.
  if (!DONE.has(status('plan')) && DONE.has(status('analysis')) && (!state.phases?.['conflict-arbitration'] || DONE.has(status('conflict-arbitration')))) {
    const open = openConflicts(path.join(root, id)).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (open.length) {
      const ids = open.map(c => oneLine(c.id, 40)), n = ids.length;
      // Topics only (the arbitration tag), never finding titles or recommendations.
      const named = open.map(c => `${oneLine(c.id, 40)} (${oneLine(c.topic || 'disputed', 40)})`);
      let tail = `Decide each with: ${commandFor('resolve', id, cli, n === 1 ? ids[0] : '<conflict-id>')}, then: ${commandFor('resume', id, cli)}`;
      const list = k => `${named.slice(0, k).join(', ')}${k < n ? ` +${n - k} more` : ''}`;
      // Never cut a command: past the budget, keep only the resume (the list command is `command`).
      if (`${list(1)}. ${tail}`.length > reasonMax) tail = `Decide each, then: ${commandFor('resume', id, cli)}`;
      let shown = n; while (shown > 1 && `${list(shown)}. ${tail}`.length > reasonMax) shown--;
      // The key names each conflict's finding pair: ids are renumbered on every synthesis.
      const key = open.map(c => `${oneLine(c.id, 40)}=${(c.findings || []).map(f => oneLine(f, 40)).sort().join('+')}`).join(',');
      return { ...waiting('plan', `${n} conflict${n === 1 ? ' needs' : 's need'} your decision`, oneLine(`${list(shown)}. ${tail}`, reasonMax), commandFor('conflicts', id, cli), key), conflicts: ids };
    }
  }
  return null;
}

// ---------------------------------------------------------------- plan digest
// What the approval gate shows of the plan, so the reviewer sees what waits
// without opening the file: the counts from 06-plan.json, the head of the
// summary (secrets redacted, printable text only, at most PLAN_LINES lines and
// PLAN_CHARS characters), and the file. Step, criterion and risk text is never
// printed. Null when the run has no plan file at all.
const PLAN_LINES = 6;
const PLAN_CHARS = 600;
function planDigest(id, root = RUNS, cli = process.env.AI_AGENTIC_CLI === '1') {
  const json = path.join(root, id, '06-plan.json'), file = path.join(root, id, '06-plan.md');
  if (!fs.existsSync(json) && !fs.existsSync(file)) return null;
  let plan = null;
  try { plan = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { plan = null; }
  const count = value => (Array.isArray(value) ? value.length : null);
  let text = plan && typeof plan.summary === 'string' ? plan.summary : null;
  // No usable JSON: the Markdown body after its "# Implementation plan" heading.
  if (text === null) { try { text = fs.readFileSync(file, 'utf8').replace(/^#[^\n]*\n?/, ''); } catch { text = ''; } }
  // notify.js requires progress.js at load; this call happens at run time, so there is no cycle.
  const scrub = value => require('./notify').redactSecrets(value);
  const summary = [];
  let used = 0;
  for (const raw of scrub(text).split('\n')) {
    const line = printable(raw).trim();
    if (!line) continue;
    if (summary.length >= PLAN_LINES) break;
    const room = PLAN_CHARS - used;
    if (line.length > room) { if (room > 1) summary.push(`${line.slice(0, room - 1)}…`); break; }
    summary.push(line);
    used += line.length;
  }
  return { path: runFile(id, '06-plan.md', cli), file, summary, steps: count(plan?.steps), acceptanceCriteria: count(plan?.acceptanceCriteria), risks: count(plan?.risks), amendments: /REVIEW AMENDMENTS/i.test(text) };
}
function planDigestLines(plan) {
  if (!plan) return [];
  const counts = plan.steps === null && plan.acceptanceCriteria === null && plan.risks === null
    ? 'counts unavailable (06-plan.json missing or invalid)'
    : `${plan.steps ?? '?'} steps · ${plan.acceptanceCriteria ?? '?'} acceptance criteria · ${plan.risks ?? '?'} risks`;
  return [`Plan: ${counts}${plan.amendments ? ' · REVIEW AMENDMENTS present' : ''}`, ...plan.summary.map(line => `  │ ${line}`), `  Full plan: ${plan.path}`];
}

// When the run completed, and the key its "complete" event uses. A run that
// completes again after rework has a new time, so it is told again.
function completedAt(state) {
  return state?.phases?.['pull-request']?.updatedAt || state?.phases?.verification?.updatedAt || '';
}
function completeKey(id, at) { return `${id}|run|complete${at ? `|${at}` : ''}`; }

// The needs-you block: headline, reason, the plan digest at the approval gate,
// the command, and the recovery commands when the caller has them.
function needsYouLines(attention, recovery = null) {
  if (!attention) return [];
  return [`⚠ Needs you: ${attention.headline}`, `  ${attention.reason}`, ...planDigestLines(attention.plan).map(line => `  ${line}`), `  → run: ${attention.command}`, ...(recovery ? recovery.lines.map(line => `  ${line}`) : [])];
}

// ---------------------------------------------------------------- recovery
// The "Commands:" block under a needs-you: every command that moves the run on
// from this stop, spelled as this install does (commandFor), with the engine
// log and the stopped stage's artifact when those files exist. One function
// feeds the dashboard banner, `agentic status`/`agentic runs`, the engine's
// stop message and the desktop notification, so they cannot disagree.
function recoveryCommands(id, attention, options = {}) {
  if (!attention) return null;
  const cli = options.cli !== undefined ? options.cli : process.env.AI_AGENTIC_CLI === '1';
  const root = options.root || RUNS, state = options.state || null;
  const exists = options.exists || (file => fs.existsSync(path.join(root, id, file)));
  const items = []; // [{ label, text }], in display order
  const add = (label, text) => { if (text && !items.some(item => item.text === text)) items.push({ label, text }); };
  const file = (label, rel) => { if (exists(rel)) add(label, runFile(id, rel, cli)); };
  const pr = attention.stage === 'pull-request';
  switch (attention.kind) {
    case 'fail': case 'blocked': case 'error': case 'stalled':
      add(pr ? 'resume' : 'retry', commandFor(pr ? 'resume' : 'retry', id, cli));
      for (const role of stoppedRoles(state, attention.stage, attention.role)) add(`retry ${role}`, commandFor('retry-role', id, cli, role));
      if (pr) add('pr', commandFor('pr', id, cli));
      break;
    case 'waiting':
      if (attention.conflicts) { add('conflicts', commandFor('conflicts', id, cli)); add('resolve', commandFor('resolve', id, cli, attention.conflicts.length === 1 ? attention.conflicts[0] : '<conflict-id>')); add('resume', commandFor('resume', id, cli)); }
      else if (attention.stage === 'architecture-selection') add('select', commandFor('architecture', id, cli));
      else { add('approve', commandFor('approve', id, cli)); add('rework plan', commandFor('retry-role', id, cli, 'plan')); }
      break;
    default: break;
  }
  add('status', commandFor('status', id, cli));
  add('doctor', commandFor('doctor', id, cli));
  file('log', 'engine/background.log');
  if (attention.kind === 'stalled') file('owner', 'engine/engine.pid');
  // The gates' own files, then what the stopped stage left behind.
  const gateFiles = attention.conflicts ? ['05-analysis/conflicts.json', '05-analysis/arbitration.md'] : attention.stage === 'approval' ? ['06-plan.md'] : attention.stage === 'architecture-selection' ? ['05-architecture-assessment.md', '05-architecture-options.md'] : [];
  for (const rel of [...gateFiles, ...stageFiles(attention.stage, attention.role, state)]) file(rel.endsWith('.rejected') ? 'rejected' : 'artifact', rel);
  const primary = attention.command;
  const width = Math.max(...items.map(item => item.label.length));
  const lines = ['Commands:', ...items.map(item => `  ${item.label.padEnd(width)}  ${item.text}`)];
  // The notification's short form: everything but the primary command (which it already carries), status first.
  const short = items.filter(item => item.text !== primary).map(item => `${item.label}: ${item.text}`);
  return { items, lines, short };
}

// A stage left in_progress by an engine that is gone: its engine.pid record is
// still there (a normal exit removes it, engine-owner.js) but nothing alive
// holds it. Not a needs-you kind (needsYou stays as it is); shaped like one so
// the same views and block serve it. A run driven by hand never writes the
// record, so it is never called stalled. No time heuristic. A record from
// another host cannot be checked from here (engine-owner.js only ages it out),
// so it is never called gone either. `options.engine` is the liveEngine()
// result the caller already has, so the stall check runs `ps` no second time.
function stalledAttention(id, state, root = RUNS, cli = process.env.AI_AGENTIC_CLI === '1', options = {}) {
  if (!state || state.status === 'done') return null;
  const stage = [...new Set([...stageOrder(), ...PHASES])].reverse().find(phase => effectiveStatus(state, phase) === 'in_progress');
  if (!stage) return null;
  const dir = path.join(root, id);
  const owner = readOwner(dir);
  if (!owner || (owner.host && owner.host !== os.hostname())) return null;
  if (options.engine !== undefined ? options.engine : liveEngine(dir)) return null;
  const label = labelOf(stage), at = oneLine(owner.startedAt, 40);
  return {
    kind: 'stalled',
    stage,
    role: null,
    label,
    headline: `${label} is in progress but its engine (pid ${owner.pid}) is gone`,
    reason: `no engine has claimed ${id} since ${at || 'its last start'}; retry resets the stage`,
    command: commandFor(stage === 'pull-request' ? 'resume' : 'retry', id, cli),
    repeated: 0,
    key: `${id}|${stage}|stalled|${at}`,
  };
}

function buildSummary(id, state, options = {}) {
  const percent = percentComplete(state);
  const root = options.root || RUNS;
  const attention = needsYou(id, state, { root });
  // One liveness check per summary: the dashboard asks every second.
  const engine = options.demo ? null : liveEngine(path.join(root, id));
  const stalled = options.demo ? null : stalledAttention(id, state, root, undefined, { engine });
  return {
    id,
    status: state.status || 'active',
    percent,
    // Open conflicts hold the plan back: say so rather than "Waiting for Implementation Plan".
    current: attention?.conflicts ? 'Waiting for conflict decisions' : currentWork(state),
    planApproved: options.demo ? false : planApproved(id, root),
    startedAt: state.startedAt || null,
    updatedAt: lastUpdated(state),
    warnings: [...consistencyIssues(state), ...pullRequestProblems(state).map(problem => (problem.startsWith('.agentic/config.yaml') ? problem : `.agentic/config.yaml: ${problem}`))],
    pullRequest: pullRequestSummary(state),
    pullRequestHint: pullRequestHint(id, state),
    needsYou: attention,
    stalled,
    recovery: recoveryCommands(id, attention || stalled, { root, state }),
    completedAt: completedAt(state),
    // The engine driving the run right now (engine-owner.js): while it works,
    // a block in the state is what it is re-running, not something to act on.
    engine,
    phases: PHASES.map(phase => {
      const rawStatus = rawStatusOf(state, phase);
      const status = effectiveStatus(state, phase);
      return {
        id: phase,
        label: LABELS[phase],
        status,
        ...(status !== rawStatus && !(phase === 'pull-request' && (legacyPullRequest(state) || disabledPullRequest(state))) && !(phase === 'post-fix-build-test' && !state?.phases?.[phase]) ? { rawStatus } : {}),
        note: state?.phases?.[phase]?.note || (phase === 'pull-request' && disabledPullRequest(state) ? pullRequestSkipNote(id) : null),
        roles: roleEntries(state, phase).map(([role, entry]) => ({
          role,
          status: entry.status || 'pending',
          executor: entry.executor || null,
          note: entry.note || null,
        })),
      };
    }),
  };
}

function renderTerminal(summary) {
  const lines = [];
  lines.push('');
  lines.push('╭────────────────────────────────────────────────────────────╮');
  lines.push(`│  FEATURE: ${String(summary.id).padEnd(35)} ${String(summary.percent).padStart(3)}%  │`);
  lines.push('╰────────────────────────────────────────────────────────────╯');
  lines.push(`   ${progressBar(summary.percent)}  ${summary.percent}%`);
  const prLine = pullRequestLine(summary);
  if (prLine) lines.push(` 🔗 ${prLine}`);
  if (summary.engine) {
    lines.push('');
    lines.push(` ● engine running: ${describeEngine(summary.engine)}`);
  } else if (summary.needsYou || summary.stalled) {
    lines.push('');
    for (const line of needsYouLines(summary.needsYou || summary.stalled, summary.recovery)) lines.push(` ${line}`);
  }
  lines.push('');

  for (const phase of summary.phases) {
    const icon = ICONS[phase.status] || '•';
    const reconciled = phase.rawStatus ? ` (stored: ${phase.rawStatus})` : '';
    lines.push(` ${icon} ${phase.label.padEnd(24)} ${phase.status}${reconciled}`);
    for (const role of phase.roles) {
      const roleIcon = ICONS[role.status] || '•';
      const executor = role.executor ? ` · ${role.executor}` : '';
      lines.push(`      ${roleIcon} ${role.role.padEnd(20)} ${role.status}${executor}`);
    }
  }

  lines.push('');
  lines.push(` Current: ${summary.current}`);
  lines.push(` Plan gate: ${summary.planApproved ? '✅ approved' : '🔒 waiting for human approval'}`);
  if (summary.updatedAt) lines.push(` Last update: ${summary.updatedAt}`);
  if (summary.warnings.length) {
    lines.push('');
    lines.push(' ⚠ State reconciliation:');
    for (const warning of summary.warnings) lines.push(`   - ${warning}`);
  }
  lines.push('');
  return lines.join('\n');
}

// `published: true` is the GitHub progress comment, which never carries run
// notes: the needs-you line keeps its headline and command but not the reason.
function renderMarkdown(summary, options = {}) {
  const rows = summary.phases.map(phase => {
    const icon = ICONS[phase.status] || '•';
    const reconciled = phase.rawStatus ? ` _(stored: ${phase.rawStatus})_` : '';
    return `| ${phase.label} | ${icon} ${phase.status}${reconciled} |`;
  });

  const detailSections = summary.phases
    .filter(phase => phase.roles.length)
    .map(phase => {
      const rowsForRoles = phase.roles.map(role => `| ${role.role} | ${ICONS[role.status] || '•'} ${role.status} | ${role.executor || '—'} |`);
      return `\n### ${phase.label}\n\n| Role | Status | Executor |\n|---|---|---|\n${rowsForRoles.join('\n')}`;
    })
    .join('\n');

  // A published comment never names the engine's host or command, and never
  // carries the plan text, the recovery block or its paths.
  const needs = summary.needsYou || summary.stalled || null;
  const recovery = !options.published && summary.recovery ? `  \n> Commands:  \n${summary.recovery.items.map(item => `> ${item.label}: \`${item.text}\`  `).join('\n')}` : '';
  const attention = summary.engine
    ? `\n> ● **Engine running**${options.published ? '' : `: ${describeEngine(summary.engine)}`}`
    : needs
      // The plan digest's counts line, never its text, and never in the published comment.
      ? `\n> ⚠ **Needs you:** ${needs.headline}  \n${options.published ? '' : `> ${needs.reason}  \n${needs.plan ? `> ${planDigestLines(needs.plan)[0]}  \n` : ''}`}> Run: \`${needs.command}\`${recovery}`
      : '';

  const warnings = summary.warnings.length
    ? `\n> ⚠ **State reconciliation**\n> ${summary.warnings.map(warning => oneLine(warning, 400)).join('\n> ')}`
    : '';

  // The empty line before the stage table survives the filter: after a block
  // quote without it, the table is a lazy continuation of the quote and does
  // not render as a table.
  const head = [
    '## 🤖 Agentic Workflow Progress',
    '',
    `**Run:** \`${summary.id}\`  `,
    `**Progress:** \`${progressBar(summary.percent, 20)}\` **${summary.percent}%**  `,
    `**Current:** ${summary.current}  `,
    summary.pullRequest ? `**Pull request:** [${summary.pullRequest.number != null ? `#${summary.pullRequest.number}` : 'open'}](${summary.pullRequest.url})${summary.pullRequest.draft ? ' (draft)' : ''}  ` : '',
    !summary.pullRequest && summary.pullRequestHint ? `**Pull request:** not opened — run \`${summary.pullRequestHint}\`  ` : '',
    `**Plan gate:** ${summary.planApproved ? '✅ Approved' : '🔒 Waiting for human approval'}`,
    attention,
    warnings,
  ].filter(Boolean);
  return [
    ...head,
    '',
    ...[
      '| Stage | Status |',
      '|---|---|',
      ...rows,
      detailSections,
      '',
      summary.updatedAt ? `_Last update: ${summary.updatedAt}_` : '',
    ].filter(Boolean),
  ].join('\n');
}

function parseArgs(argv) {
  const args = { watch: false, json: false, markdown: false, demo: false, interval: 1000, run: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--watch') args.watch = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--markdown') args.markdown = true;
    else if (arg === '--demo') args.demo = true;
    else if (arg === '--run') args.run = argv[++i];
    else if (arg === '--interval') args.interval = Math.max(250, Number(argv[++i]) || 1000);
  }
  return args;
}

function resolveRun(args) {
  if (args.demo) return { id: 'DEMO-123', state: demoState(), demo: true };
  const id = args.run || activeId();
  if (!id) return { error: 'No active /feature run. Start one with: node ai/tasks/feature/runs.js start <id>' };
  const state = loadState(id);
  if (!state) return { error: `No state.json found for run ${id}` };
  return { id, state, demo: false };
}

function output(args) {
  const resolved = resolveRun(args);
  if (resolved.error) {
    console.error(resolved.error);
    process.exitCode = 1;
    return;
  }
  const summary = buildSummary(resolved.id, resolved.state, { demo: resolved.demo });
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else if (args.markdown) console.log(renderMarkdown(summary));
  else console.log(renderTerminal(summary));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.watch) return output(args);

  const draw = () => {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
    output(args);
  };

  draw();
  const timer = setInterval(draw, args.interval);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = {
  PHASES,
  LABELS,
  ICONS,
  activeId,
  loadState,
  demoState,
  rawStatusOf,
  roleEntries,
  deriveRoleGroupStatus,
  effectiveStatus,
  consistencyIssues,
  percentComplete,
  currentWork,
  buildSummary,
  needsYou,
  needsYouLines,
  recoveryCommands,
  stalledAttention,
  planDigest,
  planDigestLines,
  commandFor,
  completedAt,
  completeKey,
  oneLine,
  printable,
  labelOf,
  pullRequestLine,
  disabledPullRequest,
  pullRequestSkipNote,
  renderTerminal,
  renderMarkdown,
  parseArgs,
};

if (require.main === module) main();
