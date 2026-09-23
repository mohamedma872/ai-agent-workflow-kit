#!/usr/bin/env node
'use strict';

// Enumerates /feature runs in the state root so the CLI and the dashboard can
// list features, tell which are still in progress, and switch the active one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateRoot } = require('./paths');
const { buildSummary } = require('./progress');

const ACTIVE_FILE = '_active';

function runsRoot(root) { return path.resolve(root || stateRoot()); }
function runDir(id, root) { return path.join(runsRoot(root), id); }
function activeFile(root) { return path.join(runsRoot(root), ACTIVE_FILE); }

function activeId(root) {
  try {
    const id = fs.readFileSync(activeFile(root), 'utf8').trim();
    return id && fs.existsSync(runDir(id, root)) ? id : null;
  } catch { return null; }
}

// The active run is what `agentic resume/approve/progress` default to.
function setActive(id, root) {
  if (!id || !fs.existsSync(path.join(runDir(id, root), 'state.json'))) throw new Error(`unknown run "${id}"`);
  fs.writeFileSync(activeFile(root), `${id}\n`);
  return id;
}

function loadState(id, root) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir(id, root), 'state.json'), 'utf8')); }
  catch { return null; }
}

// First heading/line of the run request, for a human-readable label.
function runTitle(id, root, limit = 48) {
  let text = '';
  try { text = fs.readFileSync(path.join(runDir(id, root), '00-request.md'), 'utf8'); }
  catch { return null; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim();
    if (!line || /^`{3}/.test(line)) continue;
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }
  return null;
}

function runIds(root) {
  const dir = runsRoot(root);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .filter(id => fs.existsSync(path.join(dir, id, 'state.json')));
}

function runEntry(id, root, active = activeId(root)) {
  const state = loadState(id, root);
  if (!state) return null;
  const summary = buildSummary(id, state, { root: runsRoot(root) });
  return {
    ...summary,
    title: runTitle(id, root),
    inProgress: (state.status || 'active') !== 'done',
    active: id === active,
    dir: runDir(id, root),
  };
}

function timeOf(entry) {
  const value = new Date(entry.updatedAt || entry.startedAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

// In-progress runs first, then most recently updated.
function listRuns(options = {}) {
  const root = options.root;
  const active = activeId(root);
  const runs = runIds(root).map(id => runEntry(id, root, active)).filter(Boolean);
  const visible = options.all ? runs : runs.filter(run => run.inProgress);
  return visible.sort((a, b) => (b.inProgress - a.inProgress) || (timeOf(b) - timeOf(a)));
}

// What the dashboard opens on: an explicit run, else the active one, else the
// most recently updated in-progress run.
function focusIndex(runs, preferred) {
  if (!runs.length) return -1;
  const explicit = preferred ? runs.findIndex(run => run.id === preferred) : -1;
  if (explicit >= 0) return explicit;
  const active = runs.findIndex(run => run.active);
  return active >= 0 ? active : 0;
}

function ago(iso, nowMs = Date.now()) {
  const value = new Date(iso || 0).getTime();
  if (!Number.isFinite(value) || !value) return '—';
  const seconds = Math.max(0, Math.round((nowMs - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function renderList(runs, options = {}) {
  if (!runs.length) {
    return options.all
      ? 'No /feature runs found. Start one with: agentic feature <run-id> --request "..."'
      : 'No features in progress. Start one with: agentic feature <run-id> --request "..."\nSee finished runs with: agentic runs --all';
  }
  const idWidth = Math.max(6, ...runs.map(run => String(run.id).length));
  const lines = [`${'  '}${'RUN'.padEnd(idWidth)}  ${'PROG'.padStart(4)}  ${'STATE'.padEnd(9)}  ${'CURRENT'.padEnd(30)}  UPDATED`];
  for (const run of runs) {
    const marker = run.active ? '▸ ' : '  ';
    const state = run.inProgress ? (run.planApproved ? 'approved' : 'plan-gate') : 'done';
    const current = String(run.current || '').slice(0, 30);
    lines.push(`${marker}${String(run.id).padEnd(idWidth)}  ${String(run.percent).padStart(3)}%  ${state.padEnd(9)}  ${current.padEnd(30)}  ${ago(run.updatedAt)}`);
  }
  lines.push('');
  lines.push(`${runs.filter(r => r.inProgress).length} in progress · ▸ = active run · open the GUI with: agentic progress`);
  return lines.join('\n');
}

function selftest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-index-'));
  const write = (id, state, extra = {}) => {
    fs.mkdirSync(path.join(temp, id), { recursive: true });
    fs.writeFileSync(path.join(temp, id, 'state.json'), JSON.stringify(state));
    if (extra.request) fs.writeFileSync(path.join(temp, id, '00-request.md'), extra.request);
    if (extra.approved) fs.writeFileSync(path.join(temp, id, 'plan.approved'), 'x');
  };
  const at = iso => ({ status: 'pass', updatedAt: iso });

  write('FEAT-1', { id: 'FEAT-1', status: 'active', updatedAt: '2026-09-01T10:00:00.000Z', phases: { request: at('2026-09-01T10:00:00.000Z') } }, { request: '# Payments retry\n\nbody' });
  write('FEAT-2', { id: 'FEAT-2', status: 'active', updatedAt: '2026-09-02T10:00:00.000Z', phases: { request: at('2026-09-02T10:00:00.000Z'), analysis: { status: 'in_progress' } } }, { approved: true });
  write('FEAT-DONE', { id: 'FEAT-DONE', status: 'done', updatedAt: '2026-09-03T10:00:00.000Z', phases: { request: at('2026-09-03T10:00:00.000Z') } });
  fs.mkdirSync(path.join(temp, '_scratch'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'NO-STATE'), { recursive: true });

  assert.deepStrictEqual(runIds(temp).sort(), ['FEAT-1', 'FEAT-2', 'FEAT-DONE'], 'only run directories with state.json count');

  const inProgress = listRuns({ root: temp });
  assert.deepStrictEqual(inProgress.map(r => r.id), ['FEAT-2', 'FEAT-1'], 'in-progress runs, newest first');
  assert.deepStrictEqual(listRuns({ root: temp, all: true }).map(r => r.id), ['FEAT-2', 'FEAT-1', 'FEAT-DONE'], 'done runs sort last');
  assert.strictEqual(inProgress[1].title, 'Payments retry');
  assert.strictEqual(inProgress[0].title, null, 'a run without a request file has no title');
  assert.strictEqual(inProgress[0].planApproved, true, 'plan.approved is read from the run directory, not the runtime');
  assert.strictEqual(inProgress[1].planApproved, false);

  assert.strictEqual(activeId(temp), null);
  assert.strictEqual(focusIndex(inProgress), 0, 'with no active run the newest is focused');
  setActive('FEAT-1', temp);
  assert.strictEqual(activeId(temp), 'FEAT-1');
  const afterActive = listRuns({ root: temp });
  assert.strictEqual(focusIndex(afterActive), afterActive.findIndex(r => r.id === 'FEAT-1'), 'the active run is focused');
  assert.strictEqual(focusIndex(afterActive, 'FEAT-2'), afterActive.findIndex(r => r.id === 'FEAT-2'), 'an explicit run wins');
  assert.throws(() => setActive('NOPE', temp), /unknown run/);
  assert.throws(() => setActive('NO-STATE', temp), /unknown run/);

  fs.rmSync(path.join(temp, 'FEAT-1', 'state.json'));
  assert.strictEqual(activeId(temp), 'FEAT-1', 'a stale pointer survives until the directory goes');
  fs.rmSync(path.join(temp, 'FEAT-1'), { recursive: true });
  assert.strictEqual(activeId(temp), null, 'a pointer to a deleted run resolves to nothing');

  assert.match(renderList([], {}), /No features in progress/);
  const table = renderList(listRuns({ root: temp }), {});
  assert.match(table, /FEAT-2/);
  assert.match(table, /in progress/);
  assert.strictEqual(ago(new Date(Date.now() - 120000).toISOString()), '2m ago');
  assert.strictEqual(ago(null), '—');

  fs.rmSync(temp, { recursive: true, force: true });
  console.log('runs index selftest OK');
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const switchIndex = argv.indexOf('--switch');
  if (switchIndex >= 0) {
    const id = setActive(argv[switchIndex + 1]);
    const run = runEntry(id);
    console.log(`▸ active run is now ${id}${run?.title ? ` · ${run.title}` : ''} (${run?.percent ?? 0}% · ${run?.current || 'unknown'})`);
    console.log('  agentic progress · agentic resume · agentic approve now default to it');
    return;
  }
  const all = argv.includes('--all');
  const runs = listRuns({ all });
  if (argv.includes('--json')) { console.log(JSON.stringify({ root: runsRoot(), active: activeId(), runs }, null, 2)); return; }
  console.log(renderList(runs, { all }));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 1; }
}

module.exports = { runsRoot, activeId, setActive, runIds, runTitle, runEntry, listRuns, focusIndex, ago, renderList };
