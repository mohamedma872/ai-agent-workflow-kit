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
const { liveEngine } = require('./engine-owner');

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

// The engine writes 00-request.md as a generic "# Request" heading followed by
// the actual text, so a boilerplate heading is skipped in favour of real content.
const BOILERPLATE_TITLE = /^(request|feature|feature request|task|description|summary)$/i;

function runTitle(id, root, limit = 48) {
  let text = '';
  try { text = fs.readFileSync(path.join(runDir(id, root), '00-request.md'), 'utf8'); }
  catch { return null; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim();
    if (!line || /^`{3}/.test(line) || BOILERPLATE_TITLE.test(line.replace(/[:.]$/, ''))) continue;
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
    abandoned: !!state.abandoned,
    active: id === active,
    dir: runDir(id, root),
    // The engine process driving the run right now, if any (engine-owner.js);
    // buildSummary has already looked, in the same run directory.
    engine: summary.engine !== undefined ? summary.engine : liveEngine(runDir(id, root)),
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
  const featureWidth = Math.min(40, Math.max(7, ...runs.map(run => String(run.title || '—').length)));
  const lines = [`${'  '}${'RUN'.padEnd(idWidth)}  ${'FEATURE'.padEnd(featureWidth)}  ${'PROG'.padStart(4)}  ${'STATE'.padEnd(9)}  ${'CURRENT'.padEnd(30)}  UPDATED`];
  for (const run of runs) {
    const marker = run.active ? '▸ ' : '  ';
    const state = run.inProgress ? (run.engine ? 'running' : run.needsYou ? 'needs-you' : run.planApproved ? 'approved' : 'plan-gate') : run.abandoned ? 'abandoned' : 'done';
    const current = String(run.current || '').slice(0, 30);
    const feature = String(run.title || '—').slice(0, featureWidth);
    lines.push(`${marker}${String(run.id).padEnd(idWidth)}  ${feature.padEnd(featureWidth)}  ${String(run.percent).padStart(3)}%  ${state.padEnd(9)}  ${current.padEnd(30)}  ${ago(run.updatedAt)}`);
  }
  lines.push('');
  // Each run that waits on a human, or whose engine died mid-stage, with its
  // headline, its command and the recovery block.
  const waiting = runs.filter(r => r.inProgress && (r.needsYou || r.stalled) && !r.engine);
  for (const run of waiting) {
    const attention = run.needsYou || run.stalled;
    lines.push(`⚠ ${run.id}: ${attention.headline} — run: ${attention.command}`);
    for (const line of run.recovery?.lines || []) lines.push(`    ${line}`);
  }
  if (waiting.length) lines.push('');
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
  // The engine's own "# Request" boilerplate must not become the title.
  write('FEAT-ENGINE', { id: 'FEAT-ENGINE', status: 'active', updatedAt: '2026-09-05T10:00:00.000Z', phases: { request: at('2026-09-05T10:00:00.000Z') } }, { request: '# Request\n\nAdd a Settings screen with a dark mode toggle\n' });
  assert.strictEqual(runEntry('FEAT-ENGINE', temp).title, 'Add a Settings screen with a dark mode toggle');
  write('FEAT-EMPTY', { id: 'FEAT-EMPTY', status: 'active', phases: {} }, { request: '# Request\n' });
  assert.strictEqual(runEntry('FEAT-EMPTY', temp).title, null, 'boilerplate alone leaves no title');
  assert.strictEqual(inProgress[0].title, null, 'a run without a request file has no title');
  assert.strictEqual(inProgress[0].planApproved, true, 'plan.approved is read from the run directory, not the runtime');
  assert.strictEqual(inProgress[1].planApproved, false);
  const withTitlesTable = renderList(inProgress, {});
  assert.match(withTitlesTable, /FEATURE/, 'the listing has a FEATURE column header');
  assert.match(withTitlesTable, /Payments retry/, 'the FEATURE column shows the real run title');
  assert.match(withTitlesTable, /—/, 'a run without a title falls back to a placeholder');

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

  write('FEAT-GAVEUP', { id: 'FEAT-GAVEUP', status: 'done', abandoned: true, updatedAt: '2026-09-04T10:00:00.000Z', phases: { request: at('2026-09-04T10:00:00.000Z') } });
  const withAbandoned = listRuns({ root: temp, all: true });
  assert.strictEqual(withAbandoned.find(r => r.id === 'FEAT-GAVEUP').abandoned, true);
  assert.strictEqual(withAbandoned.find(r => r.id === 'FEAT-DONE').abandoned, false);
  assert.match(renderList(withAbandoned, { all: true }), /abandoned/, 'an abandoned run does not read as done');

  write('FEAT-PR', { id: 'FEAT-PR', status: 'active', updatedAt: '2026-09-06T10:00:00.000Z', phases: { verification: { status: 'pass' }, 'pull-request': { status: 'pass' } }, pullRequest: { provider: 'github', number: 12, url: 'https://github.com/o/r/pull/12', status: 'open', branch: 'ai/FEAT-PR', base: 'main', commit: 'abc' } });
  assert.deepStrictEqual(runEntry('FEAT-PR', temp).pullRequest, { provider: 'github', number: 12, url: 'https://github.com/o/r/pull/12', status: 'open', branch: 'ai/FEAT-PR', base: 'main', draft: false }, 'the opened PR reaches the dashboard');
  // A verified run with no pull-request phase and the stage disabled is
  // complete, not waiting for a pull request. The skip is derived from the
  // project's .agentic/config.yaml, so the project root is pinned here: an
  // empty directory, then one that enables the stage.
  const { PHASES } = require('./progress');
  write('FEAT-VERIFIED', { id: 'FEAT-VERIFIED', status: 'active', updatedAt: '2026-09-06T11:00:00.000Z', phases: Object.fromEntries(PHASES.filter(p => p !== 'pull-request').map(p => [p, at('2026-09-06T11:00:00.000Z')])) }, { approved: true });
  const previousProject = process.env.AI_WORKFLOW_PROJECT_ROOT;
  const project = path.join(temp, '_project');
  fs.mkdirSync(path.join(project, '.agentic'), { recursive: true });
  process.env.AI_WORKFLOW_PROJECT_ROOT = project;
  try {
    const verifiedEntry = runEntry('FEAT-VERIFIED', temp);
    assert.deepStrictEqual([verifiedEntry.percent, verifiedEntry.current, verifiedEntry.needsYou, verifiedEntry.stalled], [100, 'Done', null, null]);
    const verifiedTable = renderList([verifiedEntry], {});
    assert.match(verifiedTable, /FEAT-VERIFIED .*100% .*Done/, verifiedTable);
    assert.ok(!/⚠/.test(verifiedTable), verifiedTable);
    fs.writeFileSync(path.join(project, '.agentic', 'config.yaml'), 'pull_request:\n  enabled: true\n');
    assert.deepStrictEqual([runEntry('FEAT-VERIFIED', temp).percent, runEntry('FEAT-VERIFIED', temp).current], [93, 'Waiting for Pull Request'], 'enabled: the stage waits');
  } finally { if (previousProject === undefined) delete process.env.AI_WORKFLOW_PROJECT_ROOT; else process.env.AI_WORKFLOW_PROJECT_ROOT = previousProject; }
  fs.rmSync(path.join(temp, 'FEAT-VERIFIED'), { recursive: true });
  fs.rmSync(project, { recursive: true });

  // A run that needs the human says so in the list, with its command; one
  // whose engine is running says that instead.
  write('FEAT-STUCK', { id: 'FEAT-STUCK', status: 'active', updatedAt: '2026-09-07T10:00:00.000Z', phases: { 'build-test': { status: 'fail', note: 'flutter test: 2 failing', updatedAt: '2026-09-07T10:00:00.000Z' } } });
  const stuck = runEntry('FEAT-STUCK', temp);
  assert.strictEqual(stuck.needsYou.headline, 'Build + Tests failed');
  assert.strictEqual(stuck.engine, null);
  const stuckTable = renderList([stuck], {});
  assert.match(stuckTable, /needs-you/);
  assert.match(stuckTable, /⚠ FEAT-STUCK: Build \+ Tests failed — run: /);
  // The recovery block follows, indented, with the status command as this install spells it.
  assert.match(stuckTable, /\n {4}Commands:\n {6}retry\s+/);
  assert.match(stuckTable, /\n {6}status\s+(agentic status FEAT-STUCK|node ai\/workflow\/progress\.js --run FEAT-STUCK)\n/);
  assert.ok(stuckTable.trim().endsWith('open the GUI with: agentic progress'), 'the count line stays last');
  // A record left by a dead engine: the stopped stage still wins (needs-you).
  fs.mkdirSync(path.join(temp, 'FEAT-STUCK', 'engine'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'FEAT-STUCK', 'engine', 'engine.pid'), JSON.stringify({ pid: 999999, host: os.hostname(), command: 'resume', startedAt: new Date().toISOString() }));
  const deadStuck = runEntry('FEAT-STUCK', temp);
  assert.deepStrictEqual([deadStuck.engine, deadStuck.stalled, deadStuck.needsYou.headline], [null, null, 'Build + Tests failed']);
  assert.match(renderList([deadStuck], {}), /⚠ FEAT-STUCK: Build \+ Tests failed — run: /);
  fs.writeFileSync(path.join(temp, 'FEAT-STUCK', 'engine', 'engine.pid'), JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'resume', startedAt: new Date().toISOString() }));
  const runningEntry = runEntry('FEAT-STUCK', temp);
  assert.strictEqual(runningEntry.engine.pid, process.pid, 'a live engine is detected');
  assert.match(renderList([runningEntry], {}), /running/);
  assert.ok(!/⚠ FEAT-STUCK/.test(renderList([runningEntry], {})));
  fs.rmSync(path.join(temp, 'FEAT-STUCK'), { recursive: true });
  // A stage left in progress by an engine that is gone: listed with its block
  // and the record; a run with no record (FEAT-2, driven by hand) is not.
  write('FEAT-DEAD', { id: 'FEAT-DEAD', status: 'active', updatedAt: '2026-09-07T11:00:00.000Z', phases: { request: at('2026-09-07T11:00:00.000Z'), implementation: { status: 'in_progress' } } }, { approved: true });
  fs.mkdirSync(path.join(temp, 'FEAT-DEAD', 'engine'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'FEAT-DEAD', 'engine', 'engine.pid'), JSON.stringify({ pid: 999999, host: os.hostname(), command: 'resume', startedAt: '2026-09-07T11:00:00.000Z' }));
  const dead = runEntry('FEAT-DEAD', temp);
  assert.deepStrictEqual([dead.needsYou, dead.engine, dead.stalled.kind], [null, null, 'stalled']);
  const deadTable = renderList([dead, runEntry('FEAT-2', temp)], {});
  assert.match(deadTable, /⚠ FEAT-DEAD: Implementation is in progress but its engine \(pid 999999\) is gone — run: /);
  assert.match(deadTable, /\n {6}owner\s+\S+FEAT-DEAD\/engine\/engine\.pid\n/);
  assert.ok(!/⚠ FEAT-2/.test(deadTable), 'no record, no stall');
  assert.match(deadTable, /FEAT-DEAD .*approved/, 'the STATE column is unchanged');
  fs.rmSync(path.join(temp, 'FEAT-DEAD'), { recursive: true });

  // Open specialist conflicts: the plan waits for a decision, and CURRENT says so.
  write('FEAT-CONF', { id: 'FEAT-CONF', status: 'active', updatedAt: '2026-09-08T10:00:00.000Z', phases: { analysis: { status: 'pass' }, 'conflict-arbitration': { status: 'pass' } } });
  fs.mkdirSync(path.join(temp, 'FEAT-CONF', '05-analysis'));
  fs.writeFileSync(path.join(temp, 'FEAT-CONF', '05-analysis', 'conflicts.json'), JSON.stringify({ conflicts: [{ id: 'CONFLICT-001', topic: 'storage', findings: ['A', 'B'], status: 'unresolved' }] }));
  const disputedTable = renderList([runEntry('FEAT-CONF', temp)], {});
  assert.match(disputedTable, /needs-you {2}Waiting for conflict decisions {2}/);
  assert.match(disputedTable, /⚠ FEAT-CONF: 1 conflict needs your decision — run: /);
  fs.rmSync(path.join(temp, 'FEAT-CONF'), { recursive: true });

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
