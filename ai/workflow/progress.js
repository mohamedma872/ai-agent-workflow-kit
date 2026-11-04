#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { stateRoot, relativeStatePath, runtimeRoot } = require('./paths');
const { unresolvedBlocking } = require('./conflict-tracker');
const { liveEngine, describe: describeEngine } = require('./engine-owner');
const { activityFile, latestActivity, describeRole, stageRole, ago: elapsed } = require('./role-activity');

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

// A run closed (or abandoned) before 1.9.31 has no pull-request phase. A
// verified, closed run is finished, so the stage shows as skipped. An abandoned
// run, or one closed unverified, never reached the stage: it is left out of the
// percent instead of counting as done.
function legacyPullRequest(state) {
  if (state?.phases?.['pull-request'] || state?.status !== 'done') return null;
  return !state.abandoned && rawStatusOf(state, 'verification') === 'pass' ? 'skipped' : 'excluded';
}

function effectiveStatus(state, phase) {
  if (phase === 'analysis' || phase === 'reviews') {
    const derived = deriveRoleGroupStatus(state, phase);
    if (derived) return derived;
  }

  const raw = rawStatusOf(state, phase);
  // A run closed before 1.9.31 never had a pull-request stage; it is finished,
  // not waiting on one.
  if (phase === 'pull-request' && legacyPullRequest(state) === 'skipped') return 'skipped';
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
  // been opened by hand, and following the hint could open a second one.
  if (!state?.phases?.['pull-request']) return null;
  if (!['skipped', 'blocked', 'fail'].includes(effectiveStatus(state, 'pull-request'))) return null;
  const command = process.env.AI_AGENTIC_CLI === '1' ? `agentic pr ${id}` : `node ai/workflow/engine.js pr ${id}`;
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

// Stage order from the workflow, so refactor-only stages sort where they run.
let workflowOrder = null;
function stageOrder() {
  if (workflowOrder) return workflowOrder;
  try { workflowOrder = (yaml.load(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'feature.yaml'), 'utf8')).stages || []).map(stage => stage.id); }
  catch { workflowOrder = PHASES; }
  return workflowOrder;
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
// The command a human types next, as this install spells it.
function commandFor(action, id, cli = process.env.AI_AGENTIC_CLI === '1') {
  const engine = `node ai/workflow/engine.js resume ${id}`;
  switch (action) {
    case 'retry': return cli ? `agentic retry ${id}` : `node ai/tasks/feature/runs.js retry ${id} && ${engine}`;
    case 'resume': return cli ? `agentic resume ${id}` : engine;
    case 'approve': return cli ? `agentic approve ${id}` : `node ai/tasks/feature/runs.js approve ${id} && ${engine}`;
    case 'architecture': return cli ? `agentic architecture ${id} <option-id>` : `npm run refactor:architecture -- ${id} <option-id>`;
    case 'conflicts': return cli ? `agentic conflicts ${id}` : `node ai/workflow/conflicts.js list ${id}`;
    case 'pr': return cli ? `agentic pr ${id}` : `node ai/workflow/engine.js pr ${id}`;
    default: throw new Error(`unknown action ${action}`);
  }
}

// ---------------------------------------------------------------- why it stopped
// When a stage fails because the agent's own structured report was rejected
// (its status was not pass), the engine keeps that report at
// engine/<stage>-<role>.rejected. It says why in the agent's words: what
// passed, what failed, what its tools changed. The note in state is cut to 180
// characters, so the views read the report itself.
function readJsonFile(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function rejectedReport(root, id, phase, roleNames) {
  for (const role of roleNames) {
    const file = path.join(root, id, 'engine', `${phase}-${role}.rejected`);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { role, file, data: data && typeof data === 'object' ? data : null, text };
  }
  return null;
}
function reportDetails(report, root, id, phase) {
  const data = report.data || {};
  const failed = (Array.isArray(data.commands) ? data.commands : [])
    .filter(entry => entry && ['fail', 'blocked', 'error'].includes(entry.status))
    .map(entry => `${oneLine(entry.command, 90)} — ${entry.status}${entry.note ? `: ${oneLine(entry.note, 160)}` : ''}`);
  for (const finding of Array.isArray(data.findings) ? data.findings : []) {
    if (finding && ['critical', 'high'].includes(finding.severity)) failed.push(`${oneLine(finding.id || 'finding', 20)} [${finding.severity}] ${oneLine(finding.title, 160)}`);
  }
  const acceptance = Object.entries(data.acceptanceCoverage && typeof data.acceptanceCoverage === 'object' ? data.acceptanceCoverage : {})
    .filter(([, value]) => /^fail/i.test(String(value))).map(([ac, value]) => `${oneLine(ac, 20)}: ${oneLine(value, 160)}`);
  const sideEffects = (Array.isArray(data.sideEffects) ? data.sideEffects : [])
    .filter(entry => entry && entry.file).map(entry => ({ file: oneLine(entry.file, 120), change: oneLine(entry.change || '', 160) }));
  const restored = (readJsonFile(path.join(root, id, 'engine', `${phase}-${report.role}.restored.json`))?.restored || []).map(entry => oneLine(entry.path, 120));
  const tests = data.tests && typeof data.tests === 'object' ? data.tests : null;
  return {
    role: report.role,
    report: process.env.AI_AGENTIC_CLI === '1' ? relativeStatePath(id, 'engine', path.basename(report.file)) : `ai/runs/${id}/engine/${path.basename(report.file)}`,
    summary: oneLine(data.summary || (report.data ? '' : report.text), 600),
    tests: tests && ['passed', 'failed'].some(key => typeof tests[key] === 'number') ? `${tests.passed ?? '?'} passed, ${tests.failed ?? '?'} failed${typeof tests.skipped === 'number' ? `, ${tests.skipped} skipped` : ''}` : null,
    failed,
    acceptance,
    sideEffects,
    restored,
    notRun: (Array.isArray(data.notRun) ? data.notRun : []).map(item => oneLine(item, 160)),
  };
}
// What the human can do about a stopped stage, most useful first. The plain
// retry stays last: on its own it repeats the attempt that just failed.
function stopOptions(id, attention, details, cli) {
  const options = [];
  const pending = details ? details.sideEffects.filter(entry => !details.restored.includes(entry.file)) : [];
  if (pending.length) {
    const meta = readJsonFile(require('./worktree').metadataFile(runtimeRoot(), id));
    const files = pending.map(entry => entry.file).join(' ');
    options.push({ label: 'Revert what its tools changed (if still changed)', command: `git ${meta?.path ? `-C ${JSON.stringify(meta.path)} ` : ''}checkout -- ${files}` });
  }
  if (details) options.push({ label: 'Read the full report', command: cli ? `agentic why ${id}` : `node ai/workflow/progress.js --run ${id} --why` });
  options.push({ label: 'Leave a note the retry will read (evidence, a decision)', command: `edit ${cli ? relativeStatePath(id, 'notes', `${attention.stage}.md`) : `ai/runs/${id}/notes/${attention.stage}.md`}` });
  options.push({ label: 'Retry the stage', command: attention.command });
  return options;
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
  const artifact = file => (cli ? relativeStatePath(id, file) : `ai/runs/${id}/${file}`);

  const stuck = [];
  for (const phase of new Set([...order, ...PHASES, ...Object.keys(state.phases || {})])) {
    const value = status(phase);
    if (value !== 'fail' && value !== 'blocked') continue;
    const entry = state.phases?.[phase] || {};
    const roles = roleEntries(state, phase).filter(([, role]) => role.status === 'fail' || role.status === 'blocked');
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
    const stuckRoles = roleEntries(state, top.phase).filter(([, role]) => role.status === 'fail' || role.status === 'blocked').map(([name]) => name);
    const report = top.role ? null : rejectedReport(root, id, top.phase, stuckRoles.length ? stuckRoles : [stageRole(top.phase)].filter(Boolean));
    const details = report ? reportDetails(report, root, id, top.phase) : null;
    const attention = {
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
      details,
    };
    attention.options = stopOptions(id, attention, details, cli);
    return attention;
  }

  const waiting = (stage, headline, reason, command, at) => ({ kind: 'waiting', stage, role: null, label: labelOf(stage), headline, reason, command, repeated: 0, key: `${id}|${stage}|waiting|${at || ''}` });
  // Verified, and no pull request recorded: a run verified before 1.9.31 never
  // reached the stage, and nothing moves it until someone opens (or records) the PR.
  if (status('verification') === 'pass' && status('pull-request') === 'pending' && !state.pullRequest?.url) {
    return waiting('pull-request', 'Verified — no pull request recorded yet', 'Open it, or record the one you opened by hand: an open PR from the run branch is reused, never duplicated. Try --dry-run first; it names the base it would use.', commandFor('pr', id, cli), state.phases?.verification?.updatedAt);
  }
  if (status('architecture-options') === 'pass' && !DONE.has(status('architecture-selection')) && !fs.existsSync(path.join(root, id, 'architecture.selected'))) {
    return waiting('architecture-selection', 'Architecture selection waits for you', `Review ${artifact('05-architecture-assessment.md')} and ${artifact('05-architecture-options.md')}, then choose an option.`, commandFor('architecture', id, cli), state.phases?.['architecture-options']?.updatedAt);
  }
  if (status('plan') === 'pass' && rawStatusOf(state, 'approval') !== 'pass' && !planApproved(id, root)) {
    return waiting('approval', 'The plan waits for your approval', `Review ${artifact('06-plan.md')}; approving lets implementation start.`, commandFor('approve', id, cli), state.phases?.plan?.updatedAt);
  }
  if (!DONE.has(status('plan')) && DONE.has(status('analysis'))) {
    let conflicts = [];
    try { conflicts = unresolvedBlocking(JSON.parse(fs.readFileSync(path.join(root, id, '05-analysis', 'conflicts.json'), 'utf8')).conflicts || []); } catch { conflicts = []; }
    if (conflicts.length) {
      const ids = conflicts.map(conflict => conflict.id).sort();
      return waiting('plan', 'Specialist conflicts block the plan', `${ids.length} unresolved conflict(s): ${ids.join(', ')}. Decide each with ${cli ? 'agentic resolve' : 'node ai/workflow/conflicts.js resolve'} <run-id> <conflict-id> --decision "..." --rationale "...", then resume.`, commandFor('conflicts', id, cli), ids.join(','));
    }
  }
  return null;
}

// When the run completed, and the key its "complete" event uses. A run that
// completes again after rework has a new time, so it is told again.
function completedAt(state) {
  return state?.phases?.['pull-request']?.updatedAt || state?.phases?.verification?.updatedAt || '';
}
function completeKey(id, at) { return `${id}|run|complete${at ? `|${at}` : ''}`; }

function needsYouLines(attention) {
  if (!attention) return [];
  const lines = [`⚠ Needs you: ${attention.headline}`];
  const details = attention.details;
  if (details) {
    if (details.summary) lines.push(`  ${oneLine(details.summary, 400)}`);
    if (details.tests) lines.push(`  Tests: ${details.tests}`);
    for (const item of details.failed.slice(0, 4)) lines.push(`  ✗ ${item}`);
    for (const item of details.acceptance.slice(0, 3)) lines.push(`  ✗ ${item}`);
    for (const entry of details.sideEffects) lines.push(`  ! changed by its tools: ${entry.file}${details.restored.includes(entry.file) ? ' (restored by the runtime)' : ''}`);
    lines.push(`  Report: ${details.report}`);
  } else lines.push(`  ${attention.reason}`);
  // The other things to do, then the stage's own command, last as before.
  for (const option of attention.options || []) if (option.command !== attention.command) lines.push(`  · ${option.label}: ${option.command}`);
  lines.push(`  → run: ${attention.command}`);
  return lines;
}

// `agentic why <id>`: everything the run knows about why it stopped.
function whyLines(id, state, options = {}) {
  const attention = needsYou(id, state, options);
  if (!attention) return [`${id}: nothing is waiting on you.${state?.status === 'done' ? ' The run is closed.' : ''}`];
  const lines = [`${id} · ${attention.headline}`, '', `Reason: ${oneLine(state?.phases?.[attention.stage]?.note || attention.reason, 2000)}`];
  const details = attention.details;
  if (details) {
    lines.push(`Report (${details.role}): ${details.report}`, '');
    if (details.summary) lines.push('What the agent said:', `  ${details.summary}`, '');
    if (details.tests) lines.push(`Tests: ${details.tests}`, '');
    if (details.failed.length) lines.push('Failed checks:', ...details.failed.map(item => `  ✗ ${item}`), '');
    if (details.acceptance.length) lines.push('Acceptance criteria not met:', ...details.acceptance.map(item => `  ✗ ${item}`), '');
    if (details.sideEffects.length) lines.push('Changed by its tools:', ...details.sideEffects.map(entry => `  ! ${entry.file}${entry.change ? ` — ${entry.change}` : ''}${details.restored.includes(entry.file) ? ' (restored by the runtime)' : ''}`), '');
    if (details.notRun.length) lines.push('Not run:', ...details.notRun.map(item => `  - ${item}`), '');
  }
  lines.push('What you can do:');
  (attention.options || [{ label: 'Run', command: attention.command }]).filter(option => !/\bwhy\b/.test(option.command)).forEach((option, i) => lines.push(`  ${i + 1}. ${option.label}`, `     ${option.command}`));
  return lines;
}


function buildSummary(id, state, options = {}) {
  const percent = percentComplete(state);
  return {
    id,
    status: state.status || 'active',
    percent,
    current: currentWork(state),
    planApproved: options.demo ? false : planApproved(id, options.root || RUNS),
    startedAt: state.startedAt || null,
    updatedAt: lastUpdated(state),
    warnings: consistencyIssues(state),
    pullRequest: pullRequestSummary(state),
    pullRequestHint: pullRequestHint(id, state),
    needsYou: needsYou(id, state, { root: options.root || RUNS }),
    completedAt: completedAt(state),
    // The engine driving the run right now (engine-owner.js): while it works,
    // a block in the state is what it is re-running, not something to act on.
    engine: options.demo ? null : liveEngine(path.join(options.root || RUNS, id)),
    phases: PHASES.map(phase => {
      const rawStatus = rawStatusOf(state, phase);
      const status = effectiveStatus(state, phase);
      const role = stageRole(phase);
      return {
        id: phase,
        label: LABELS[phase],
        status,
        ...(status !== rawStatus && !(phase === 'pull-request' && legacyPullRequest(state)) ? { rawStatus } : {}),
        note: state?.phases?.[phase]?.note || null,
        // The role a single-role stage runs, and what it does, in one line.
        role,
        description: role ? describeRole(role) : null,
        startedAt: status === 'in_progress' ? state?.phases?.[phase]?.updatedAt || null : null,
        roles: [
          ...roleEntries(state, phase).map(([role, entry]) => ({
            role,
            status: entry.status || 'pending',
            executor: entry.executor || null,
            note: entry.note || null,
            description: describeRole(role),
            startedAt: entry.status === 'in_progress' ? entry.updatedAt || null : null,
          })),
          // A conditional role (verification's mobile-evidence) runs before its
          // stage begins; shown under the stage while it runs or once it ran.
          ...Object.entries(state?.conditionals?.[phase] || {}).filter(([, entry]) => entry && entry.status && entry.status !== 'pending').map(([role, entry]) => ({
            role,
            status: entry.status,
            executor: entry.executor || null,
            note: entry.reason || null,
            description: describeRole(role),
            startedAt: entry.status === 'in_progress' ? entry.updatedAt || entry.startedAt || null : null,
            conditional: true,
          })),
        ],
      };
    }),
  };
}

// The latest action of every running role (and running single-role stage),
// from its activity file. For local views only: a published summary (the
// GitHub progress comment) never carries it.
function withActivity(summary, runDir) {
  if (!summary || !runDir) return summary;
  return {
    ...summary,
    phases: summary.phases.map(phase => ({
      ...phase,
      ...(phase.status === 'in_progress' && phase.role && !phase.roles.length ? { activity: latestActivity(activityFile(runDir, phase.id, phase.role)) } : {}),
      roles: phase.roles.map(role => (role.status === 'in_progress' ? { ...role, activity: latestActivity(activityFile(runDir, phase.id, role.role)) } : role)),
    })),
  };
}
// "↳ Read lib/a.dart · 4s ago", or how long the role has run when it has said nothing yet.
function activityText(item) {
  if (item.activity) return `↳ ${oneLine(item.activity.text, 200)} · ${elapsed(item.activity.t)} ago`;
  return item.startedAt ? `↳ working · ${elapsed(item.startedAt)}` : null;
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
  } else if (summary.needsYou) {
    lines.push('');
    for (const line of needsYouLines(summary.needsYou)) lines.push(` ${line}`);
  }
  lines.push('');

  for (const phase of summary.phases) {
    const icon = ICONS[phase.status] || '•';
    const reconciled = phase.rawStatus ? ` (stored: ${phase.rawStatus})` : '';
    lines.push(` ${icon} ${phase.label.padEnd(24)} ${phase.status}${reconciled}`);
    if (phase.status === 'in_progress' && !phase.roles.length) {
      if (phase.description) lines.push(`      ${oneLine(phase.description, 100)}`);
      const doing = activityText(phase);
      if (doing) lines.push(`      ${doing}`);
    }
    for (const role of phase.roles) {
      const roleIcon = ICONS[role.status] || '•';
      const executor = role.executor ? ` · ${role.executor}` : '';
      lines.push(`      ${roleIcon} ${role.role.padEnd(20)} ${role.status}${executor}`);
      if (role.status !== 'in_progress') continue;
      if (role.description) lines.push(`         ${oneLine(role.description, 100)}`);
      const doing = activityText(role);
      if (doing) lines.push(`         ${doing}`);
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

  // A published comment never names the engine's host or command.
  const attention = summary.engine
    ? `\n> ● **Engine running**${options.published ? '' : `: ${describeEngine(summary.engine)}`}`
    : summary.needsYou
      ? `\n> ⚠ **Needs you:** ${summary.needsYou.headline}  \n${options.published ? '' : `> ${summary.needsYou.reason}  \n`}> Run: \`${summary.needsYou.command}\``
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
  const args = { watch: false, json: false, markdown: false, demo: false, why: false, interval: 1000, run: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--watch') args.watch = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--markdown') args.markdown = true;
    else if (arg === '--demo') args.demo = true;
    else if (arg === '--why') args.why = true;
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
  if (args.why) { console.log(whyLines(resolved.id, resolved.state).join('\n')); return; }
  const built = buildSummary(resolved.id, resolved.state, { demo: resolved.demo });
  // Markdown is what gets published; only the local views show live activity.
  const summary = args.markdown || resolved.demo ? built : withActivity(built, path.join(RUNS, resolved.id));
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
  withActivity,
  activityText,
  needsYou,
  needsYouLines,
  whyLines,
  commandFor,
  completedAt,
  completeKey,
  oneLine,
  printable,
  labelOf,
  pullRequestLine,
  renderTerminal,
  renderMarkdown,
  parseArgs,
};

if (require.main === module) main();
