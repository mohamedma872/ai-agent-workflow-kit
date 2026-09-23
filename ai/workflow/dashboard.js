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
const { spawnSync } = require('child_process');
const { PHASES, ICONS, buildSummary, demoState } = require('./progress');
const { listRuns, focusIndex, setActive, ago, runsRoot } = require('./runs-index');

// Every dashboard icon must be an unambiguous two-column emoji: ⏭ and similar
// text-presentation symbols render one column in some terminals and two in
// others, which would drift the box borders by a character.
const DASH_ICONS = { ...ICONS, skipped: '➖' };

const RUNS_CLI = path.join(__dirname, '..', 'tasks', 'feature', 'runs.js');
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

function pad(text, size) {
  const value = truncate(text, size);
  return value + ' '.repeat(Math.max(0, size - width(value)));
}

const COLORS = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', invert: '\x1b[7m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
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
    return `${marker} ${run.id}${flag ? ` ${flag}` : ''}|${String(run.percent).padStart(3)}%`;
  });
}

// Phase/role detail, compacted when the terminal is short: roles go first, then
// stages that have not started.
function detailLines(run, rows, color) {
  if (!run) return ['No feature selected.'];
  const head = [
    paint(run.id, COLORS.bold, color) + (run.title ? paint(` · ${run.title}`, COLORS.dim, color) : ''),
    `${bar(run.percent, 24)} ${String(run.percent).padStart(3)}%`,
    `${run.planApproved ? '✅ plan approved' : '🔒 plan gate: waiting for human approval'}${run.inProgress ? '' : run.abandoned ? '  · abandoned' : '  · closed'}`,
    '',
  ];
  const foot = [
    '',
    `Current: ${run.current}`,
    `Updated: ${ago(run.updatedAt)}`,
    ...(run.warnings || []).slice(0, 2).map(w => paint(`⚠ ${w}`, COLORS.yellow, color)),
  ];

  const ACTIVE_PHASE = new Set(['in_progress', 'fail', 'blocked']);
  const build = ({ roles = 'all', onlyTouched = false } = {}) => {
    const out = [];
    for (const phase of run.phases) {
      if (onlyTouched && phase.status === 'pending') continue;
      out.push(`${DASH_ICONS[phase.status] || '•'} ${pad(phase.label, 24)} ${paint(phase.status, statusColor(phase.status), color)}`);
      if (roles === 'none' || (roles === 'active' && !ACTIVE_PHASE.has(phase.status))) continue;
      for (const role of phase.roles) {
        out.push(`   ${DASH_ICONS[role.status] || '•'} ${pad(role.role, 20)} ${paint(role.status, statusColor(role.status), color)}${role.executor ? paint(` · ${role.executor}`, COLORS.dim, color) : ''}`);
      }
    }
    return out;
  };

  // Tightest fit that still says the most: all roles, then only the roles of the
  // stages that are running or stuck, then stages alone.
  const budget = Math.max(1, rows - head.length - foot.length);
  const variants = [
    build(),
    build({ roles: 'active' }),
    build({ roles: 'active', onlyTouched: true }),
    build({ roles: 'none' }),
    build({ roles: 'none', onlyTouched: true }),
  ];
  for (const body of variants) {
    if (body.length <= budget) return [...head, ...body, ...foot];
  }
  return [...head, ...variants[variants.length - 1].slice(0, budget), ...foot];
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
    const listWidth = Math.min(LIST_MAX, Math.max(LIST_MIN, Math.max(...runs.map(r => width(r.id)), 8) + 9));
    const detailWidth = cols - listWidth - 7; // │ list │ detail │
    const left = listLines(runs, index, bodyRows).map(line => {
      const [labelPart, percentPart = ''] = line.split('|');
      const selected = labelPart.startsWith('▸');
      const text = pad(labelPart, listWidth - width(percentPart) - 1) + percentPart;
      return selected ? paint(pad(text, listWidth), color ? COLORS.bold + COLORS.cyan : '', color) : text;
    });
    const right = detailLines(run, bodyRows, color);
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
    for (const line of detailLines(run, bodyRows - listRows - 1, color)) lines.push(`│ ${pad(line, inner - 2)} │`);
    lines.push(`╰${'─'.repeat(inner)}╯`);
  }

  const hint = view.confirm
    ? paint(confirmPrompt(run), isVerified(run) ? COLORS.yellow : COLORS.red, color)
    : view.notice
      ? paint(view.notice, view.notice.startsWith('✗') ? COLORS.red : COLORS.green, color)
      : paint(`↑↓ select · enter set active · c close · a ${view.all ? 'in-progress only' : 'all runs'} · r refresh · q quit`, COLORS.dim, color);
  lines.push(` ${hint}`);
  if (!runs.length) lines.push(paint(` No ${view.all ? 'runs' : 'features in progress'}. Start one: agentic feature <run-id> --request "..."`, COLORS.dim, color));
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

function demoRuns() {
  const base = demoState();
  const make = (id, title, overrides) => ({
    ...buildSummary(id, { ...base, ...overrides }, { demo: true }),
    title,
    inProgress: true,
    active: id === 'FEAT-002',
    dir: '',
  });
  return [
    make('FEAT-002', 'Payments retry on timeout', {}),
    make('FEAT-007', 'Offline queue for uploads', { phases: { request: { status: 'pass' }, requirements: { status: 'in_progress' } }, roles: {}, selectedRoles: {} }),
    make('FEAT-011', 'Arabic RTL layout fixes', { phases: Object.fromEntries(PHASES.slice(0, 11).map(p => [p, { status: 'pass' }])), roles: {}, selectedRoles: {} }),
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

  let view = { all: !!options.all, index: 0, notice: null, confirm: false };
  let runs = load({ demo: options.demo, all: view.all });
  view.index = Math.max(0, focusIndex(runs, options.run));
  let focusedId = runs[view.index]?.id || null;

  const frame = () => renderFrame({
    runs,
    index: view.index,
    all: view.all,
    demo: options.demo,
    notice: view.notice,
    confirm: view.confirm,
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
  // Keep the highlight on the same feature when the list reorders under it.
  const reload = () => {
    runs = load({ demo: options.demo, all: view.all });
    const keep = runs.findIndex(r => r.id === focusedId);
    view.index = keep >= 0 ? keep : Math.max(0, Math.min(view.index, runs.length - 1));
    focusedId = runs[view.index]?.id || null;
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

  const flash = message => {
    view.notice = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { view.notice = null; draw(); }, 4000);
  };

  process.stdin.on('keypress', (_str, key) => {
    const result = handleKey({ ...view, count: runs.length }, key || {});
    view = { ...view, index: result.view.index, all: result.view.all, confirm: result.view.confirm };
    focusedId = runs[view.index]?.id || focusedId;
    if (result.action === 'quit') return quit(0);
    if (result.action === 'reload') return reload();
    if (result.action === 'close-request') { view.notice = null; return draw(); }
    if (result.action === 'close-cancel') { flash('close cancelled'); return draw(); }
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
  assert(lines.some(l => l.includes('enter set active')), 'key hints are shown');
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

  console.log('dashboard selftest OK');
}

function parseArgs(argv) {
  const options = { all: false, demo: false, once: false, run: null, interval: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--demo') options.demo = true;
    else if (arg === '--once') options.once = true;
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

module.exports = { width, pad, truncate, bar, listLines, detailLines, renderFrame, handleKey, isVerified, closeCommand, confirmPrompt, closeRun, demoRuns, run, parseArgs };
