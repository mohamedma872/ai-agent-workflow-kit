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

function statusOf(state, phase) {
  return state?.phases?.[phase]?.status || 'pending';
}

function roleEntries(state, group) {
  return Object.entries(state?.roles?.[group] || {});
}

function unitProgress(status) {
  if (DONE.has(status)) return 1;
  if (RUNNING.has(status)) return 0.5;
  return 0;
}

function phaseProgress(state, phase) {
  const roles = roleEntries(state, phase);
  if ((phase === 'analysis' || phase === 'reviews') && roles.length) {
    const value = roles.reduce((sum, [, entry]) => sum + unitProgress(entry.status || 'pending'), 0);
    return value / roles.length;
  }
  return unitProgress(statusOf(state, phase));
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
  for (const group of ['analysis', 'reviews']) {
    const running = roleEntries(state, group).find(([, entry]) => entry.status === 'in_progress');
    if (running) return `${LABELS[group]} → ${running[0]}`;
  }
  const runningPhase = PHASES.find(phase => statusOf(state, phase) === 'in_progress');
  if (runningPhase) return LABELS[runningPhase];
  const blocked = PHASES.find(phase => ['blocked', 'fail'].includes(statusOf(state, phase)));
  if (blocked) return `${LABELS[blocked]} (${statusOf(state, blocked)})`;
  const pending = PHASES.find(phase => statusOf(state, phase) === 'pending');
  return pending ? `Waiting for ${LABELS[pending]}` : 'Done';
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
    phases: PHASES.map(phase => ({
      id: phase,
      label: LABELS[phase],
      status: statusOf(state, phase),
      note: state?.phases?.[phase]?.note || null,
      roles: roleEntries(state, phase).map(([role, entry]) => ({
        role,
        status: entry.status || 'pending',
        executor: entry.executor || null,
        note: entry.note || null,
      })),
    })),
  };
}

function renderTerminal(summary) {
  const lines = [];
  lines.push('');
  lines.push(`╭────────────────────────────────────────────────────────────╮`);
  lines.push(`│  FEATURE: ${String(summary.id).padEnd(35)} ${String(summary.percent).padStart(3)}%  │`);
  lines.push(`╰────────────────────────────────────────────────────────────╯`);
  lines.push(`   ${progressBar(summary.percent)}  ${summary.percent}%`);
  lines.push('');

  for (const phase of summary.phases) {
    const icon = ICONS[phase.status] || '•';
    lines.push(` ${icon} ${phase.label.padEnd(24)} ${phase.status}`);
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
  lines.push('');
  return lines.join('\n');
}

function renderMarkdown(summary) {
  const rows = summary.phases.map(phase => {
    const icon = ICONS[phase.status] || '•';
    return `| ${phase.label} | ${icon} ${phase.status} |`;
  });

  const detailSections = summary.phases
    .filter(phase => phase.roles.length)
    .map(phase => {
      const rowsForRoles = phase.roles.map(role => `| ${role.role} | ${ICONS[role.status] || '•'} ${role.status} | ${role.executor || '—'} |`);
      return `\n### ${phase.label}\n\n| Role | Status | Executor |\n|---|---|---|\n${rowsForRoles.join('\n')}`;
    })
    .join('\n');

  return [
    '## 🤖 Agentic Workflow Progress',
    '',
    `**Run:** \`${summary.id}\`  `,
    `**Progress:** \`${progressBar(summary.percent, 20)}\` **${summary.percent}%**  `,
    `**Current:** ${summary.current}  `,
    `**Plan gate:** ${summary.planApproved ? '✅ Approved' : '🔒 Waiting for human approval'}`,
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
  buildSummary,
  renderTerminal,
  renderMarkdown,
  parseArgs,
};

if (require.main === module) main();
