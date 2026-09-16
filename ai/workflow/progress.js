#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
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

  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.some(status => status === 'pending' || status === 'in_progress')) return 'in_progress';
  if (statuses.every(status => status === 'skipped')) return 'skipped';
  if (statuses.every(status => status === 'pass' || status === 'skipped')) return 'pass';
  return 'in_progress';
}

function effectiveStatus(state, phase) {
  if (phase === 'analysis' || phase === 'reviews') {
    const derived = deriveRoleGroupStatus(state, phase);
    if (derived) return derived;
  }

  const raw = rawStatusOf(state, phase);
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
  const total = PHASES.reduce((sum, phase) => sum + phaseProgress(state, phase), 0);
  return Math.round((total / PHASES.length) * 100);
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
      const running = roleEntries(state, phase).find(([, entry]) => entry.status === 'in_progress');
      if (running) return `${LABELS[phase]} → ${running[0]}`;
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

function planApproved(id) {
  return id !== 'DEMO-123' && fs.existsSync(path.join(RUNS, id, 'plan.approved'));
}

function buildSummary(id, state, options = {}) {
  const percent = percentComplete(state);
  return {
    id,
    status: state.status || 'active',
    percent,
    current: currentWork(state),
    planApproved: options.demo ? false : planApproved(id),
    startedAt: state.startedAt || null,
    updatedAt: lastUpdated(state),
    warnings: consistencyIssues(state),
    phases: PHASES.map(phase => {
      const rawStatus = rawStatusOf(state, phase);
      const status = effectiveStatus(state, phase);
      return {
        id: phase,
        label: LABELS[phase],
        status,
        ...(status !== rawStatus ? { rawStatus } : {}),
        note: state?.phases?.[phase]?.note || null,
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

function renderMarkdown(summary) {
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

  const warnings = summary.warnings.length
    ? `\n> ⚠ **State reconciliation**\n> ${summary.warnings.join('\n> ')}`
    : '';

  return [
    '## 🤖 Agentic Workflow Progress',
    '',
    `**Run:** \`${summary.id}\`  `,
    `**Progress:** \`${progressBar(summary.percent, 20)}\` **${summary.percent}%**  `,
    `**Current:** ${summary.current}  `,
    `**Plan gate:** ${summary.planApproved ? '✅ Approved' : '🔒 Waiting for human approval'}`,
    warnings,
    '',
    '| Stage | Status |',
    '|---|---|',
    ...rows,
    detailSections,
    '',
    summary.updatedAt ? `_Last update: ${summary.updatedAt}_` : '',
  ].filter(Boolean).join('\n');
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
  renderTerminal,
  renderMarkdown,
  parseArgs,
};

if (require.main === module) main();
