#!/usr/bin/env node
'use strict';

// Starts the workflow engine for a run in the background: the one code path
// behind the dashboard's R / T / A keys and `agentic approve <id>`.
//
//   node ai/workflow/engine-launch.js <resume|retry|approve> <id>
//
// `retry` runs `runs.js retry <id>` first and `approve` runs `runs.js approve
// <id>` first (their own guards decide; nothing here writes run state), then
// `engine.js resume <id>` is spawned detached, with no shell, its output
// appended to <run>/engine/background.log. Refuses while an engine for the run
// is alive, and never starts one that would change nothing (a stopped stage
// that needs a retry, a gate that waits for a human).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { liveEngine, describe: describeEngine } = require('./engine-owner');
const { projectRoot } = require('./paths');

const RUNS_CLI = path.join(__dirname, '..', 'tasks', 'feature', 'runs.js');
const ENGINE = path.join(__dirname, 'engine.js');
const BACKGROUND_LOG = 'background.log';
const MODES = new Set(['resume', 'retry', 'approve']);

// `run` is a runs-index.js entry (id, dir, inProgress, needsYou). Every
// dependency can be replaced for the selftests.
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
  const verb = MODES.has(mode) ? mode : 'resume';
  if (!run || !run.dir) return { ok: false, message: `✗ nothing to ${verb}` };
  if (!run.inProgress) return { ok: false, message: `✗ ${run.id} is closed; nothing to ${verb}` };
  // A verified run whose pull-request stage is skipped has nothing left for a
  // resume to do: say so instead of starting an engine that only prints "complete".
  if (verb === 'resume' && run.current === 'Done' && !run.needsYou) return { ok: false, message: `✗ ${run.id} is complete — press c to close it${run.pullRequestHint ? `, or open its pull request: ${run.pullRequestHint}` : ''}` };
  // A on a run that is not at the gate never touches state.
  if (verb === 'approve' && run.needsYou?.stage !== 'approval') return { ok: false, message: `✗ ${run.id}: nothing waits for approval` };
  const owner = live(run.dir);
  if (owner) return { ok: false, message: `✗ ${run.id} is already running (${describeEngine(owner)}); not starting a second engine` };
  // A plain resume of a stopped stage gets nowhere (the engine leaves a stage
  // whose attempts are spent as it is) and a gate returns at once: say so here
  // instead of starting an engine that changes nothing.
  const attention = verb === 'resume' ? run.needsYou : null;
  if (attention?.kind === 'waiting') return { ok: false, message: attention.conflicts ? `✗ ${run.id}: ${attention.headline} — run: ${attention.command}` : `✗ ${run.id} waits for you — run: ${attention.command}` };
  if ((attention?.kind === 'fail' || attention?.kind === 'blocked') && attention.stage !== 'pull-request') {
    return { ok: false, message: `✗ ${run.id}: ${attention.label} needs a retry first — press T (or run: ${attention.command})` };
  }
  // runs.js' own guards are the gate's guards: a plan that is missing or not
  // passed, or an analysis that is not done, fails there with its message.
  if (verb === 'retry' || verb === 'approve') {
    const step = spawnSyncFn(process.execPath, [runsCli, verb, run.id], { encoding: 'utf8', timeout: 20000, env, cwd });
    if (step.error || step.status !== 0) {
      const why = `${step.stdout || ''}${step.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).pop() || step.error?.message || 'unknown error';
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
  const doing = { resume: `resuming ${run.id}`, retry: `retrying ${run.id}`, approve: `approved ${run.id} · resuming` }[verb];
  return { ok: true, pid: child.pid, log, message: `▸ ${doing}… engine pid ${child.pid ?? '?'} · log ${shown && !shown.startsWith('..') ? shown : log}` };
}

function main(argv) {
  const [mode, id] = argv;
  if (!MODES.has(mode) || !id || id.startsWith('--')) throw new Error('usage: engine-launch.js <resume|retry|approve> <run-id>');
  const run = require('./runs-index').runEntry(id);
  if (!run) throw new Error(`unknown run "${id}"`);
  const result = startEngine(run, mode);
  console.log(result.message);
  if (!result.ok) { process.exitCode = 1; return; }
  const shown = path.relative(projectRoot(), result.log);
  console.log(`  follow: tail -f ${shown && !shown.startsWith('..') ? shown : result.log} · watch: ${process.env.AI_AGENTIC_CLI === '1' ? 'agentic progress' : 'node ai/workflow/dashboard.js'}`);
}

function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-launch-'));
  try {
    const runDir = path.join(root, 'FEAT-R');
    fs.mkdirSync(path.join(runDir, 'engine'), { recursive: true });
    const target = { id: 'FEAT-R', dir: runDir, inProgress: true };
    const calls = [];
    const fakeSpawn = (file, args, opts) => { calls.push({ file, args, opts }); return { pid: 31337, on() {}, unref() {} }; };
    // Approve: runs.js approve first, then the resume; refused when nothing waits.
    const gate = { ...target, needsYou: { kind: 'waiting', stage: 'approval', label: 'Human Approval', command: 'agentic approve FEAT-R' } };
    const syncCalls = [];
    const approved = startEngine(gate, 'approve', { spawnFn: fakeSpawn, live: () => null, cwd: root, runsCli: '/runtime/runs.js', engine: '/runtime/engine.js', spawnSyncFn: (file, args) => { syncCalls.push(args); return { status: 0, stdout: 'FEAT-R: plan approved\n', stderr: '' }; } });
    assert.strictEqual(approved.ok, true, approved.message);
    assert.match(approved.message, /^▸ approved FEAT-R · resuming… engine pid 31337 · log FEAT-R\/engine\/background\.log$/);
    assert.deepStrictEqual(syncCalls, [['/runtime/runs.js', 'approve', 'FEAT-R']]);
    assert.deepStrictEqual([calls.length, calls[0].args], [1, ['/runtime/engine.js', 'resume', 'FEAT-R']]);
    assert.match(fs.readFileSync(path.join(runDir, 'engine', 'background.log'), 'utf8'), /approve started from agentic progress/);
    const refusedByRuns = startEngine(gate, 'approve', { spawnFn: fakeSpawn, live: () => null, cwd: root, spawnSyncFn: () => ({ status: 1, stdout: '', stderr: '✗ plan is in_progress — the engine must complete the plan stage before approval\n' }) });
    assert.deepStrictEqual([refusedByRuns.ok, refusedByRuns.message], [false, '✗ FEAT-R: plan is in_progress — the engine must complete the plan stage before approval']);
    assert.strictEqual(calls.length, 1, 'a refused approve starts nothing');
    assert.deepStrictEqual(startEngine({ ...target, needsYou: { kind: 'fail', stage: 'build-test', label: 'Build + Tests' } }, 'approve', { spawnFn: fakeSpawn, live: () => null }), { ok: false, message: '✗ FEAT-R: nothing waits for approval' });
    assert.deepStrictEqual(startEngine(target, 'approve', { spawnFn: fakeSpawn, live: () => null }), { ok: false, message: '✗ FEAT-R: nothing waits for approval' });
    assert.match(startEngine(gate, 'approve', { spawnFn: fakeSpawn, live: () => ({ pid: 777, kind: 'engine', command: 'resume' }) }).message, /already running/);
    assert.strictEqual(calls.length, 1);

    // For real: a stand-in engine runs detached and writes to the log; a live
    // engine.pid (this process) makes the default liveness check refuse.
    const stubEngine = path.join(root, 'stub-engine.js');
    fs.writeFileSync(stubEngine, "require('fs').writeFileSync(process.argv[3] + '.ran', process.argv.slice(2).join(' ')); console.log('stub engine output');\n");
    const real = startEngine({ ...target, id: path.join(root, 'marker') }, 'resume', { engine: stubEngine, cwd: root, live: () => null });
    assert.strictEqual(real.ok, true, real.message);
    for (const until = Date.now() + 5000; !fs.existsSync(path.join(root, 'marker.ran')) && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    assert.strictEqual(fs.readFileSync(path.join(root, 'marker.ran'), 'utf8'), `resume ${path.join(root, 'marker')}`, 'the stand-in engine ran with the resume arguments');
    for (const until = Date.now() + 5000; !/stub engine output/.test(fs.readFileSync(real.log, 'utf8')) && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    assert.match(fs.readFileSync(real.log, 'utf8'), /stub engine output/, 'its output lands in the log');
    fs.writeFileSync(path.join(runDir, 'engine', 'engine.pid'), JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'resume', startedAt: new Date().toISOString() }));
    const alive = startEngine(target, 'resume', { engine: stubEngine, cwd: root });
    assert.strictEqual(alive.ok, false);
    assert.match(alive.message, new RegExp(`already running \\(engine pid ${process.pid} \\(resume\\)`));
    fs.unlinkSync(path.join(runDir, 'engine', 'engine.pid'));

    // The command line: a refusal prints ✗ and exits 1, and touches nothing.
    const states = path.join(root, 'states');
    const write = (id, state) => { fs.mkdirSync(path.join(states, id), { recursive: true }); fs.writeFileSync(path.join(states, id, 'state.json'), JSON.stringify(state)); };
    write('FEAT-STUCK', { id: 'FEAT-STUCK', status: 'active', phases: { 'build-test': { status: 'fail', note: 'red', updatedAt: 't' } } });
    write('FEAT-DONE', { id: 'FEAT-DONE', status: 'done', phases: { verification: { status: 'pass' } } });
    const cli = argv => spawnSync(process.execPath, [__filename, ...argv], { env: { ...process.env, AI_WORKFLOW_STATE_ROOT: states, AI_WORKFLOW_PROJECT_ROOT: root }, encoding: 'utf8' });
    const notGated = cli(['approve', 'FEAT-STUCK']);
    assert.deepStrictEqual([notGated.status, notGated.stdout.trim()], [1, '✗ FEAT-STUCK: nothing waits for approval']);
    const closed = cli(['resume', 'FEAT-DONE']);
    assert.deepStrictEqual([closed.status, closed.stdout.trim()], [1, '✗ FEAT-DONE is closed; nothing to resume']);
    assert.ok(!fs.existsSync(path.join(states, 'FEAT-STUCK', 'engine')), 'nothing written for a refused start');
    assert.notStrictEqual(cli(['approve']).status, 0);
    assert.notStrictEqual(cli(['bogus', 'FEAT-STUCK']).status, 0);
    assert.match(cli(['resume', 'NOPE']).stderr, /unknown run "NOPE"/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('engine-launch selftest OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    try { main(process.argv.slice(2)); }
    catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 1; }
  }
}

module.exports = { startEngine, BACKGROUND_LOG, RUNS_CLI, ENGINE, selftest };
