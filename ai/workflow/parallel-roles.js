#!/usr/bin/env node
'use strict';

/*
 * Runs the roles of a parallel stage at the same time, at most `cap` at once.
 *
 * The engine is synchronous (spawnSync everywhere), so it cannot wait on
 * several children itself. It launches this helper with spawnSync instead; the
 * helper starts one `engine.js run-role <id> <stage> <role>` child per role,
 * streams their output with a `[role]` prefix, waits for all of them and writes
 * a JSON summary (role, exit code, signal, duration) to --summary-file for the
 * engine to read back. A failing role never stops its siblings: the engine
 * reports every failure once all of them have finished.
 *
 * Each role runs in its own process group. A signal to this helper is passed
 * to every group, so router.js and the agent under it stop too. Because the
 * engine is blocked in spawnSync and cannot pass signals on, the helper also
 * watches its parent and stops the same way if the engine dies. Once stopping,
 * the helper stays until every group it started is gone, and SIGKILLs any group
 * still alive after KILL_GRACE_MS. Roles it stops are recorded as failed
 * (`interrupted: <signal|parent-exit>`). While the pool runs, --pid-file holds
 * this helper's pid, so `runs.js retry` can refuse to reset roles that are
 * still running, and --pgid-file lists the role process groups, so the engine
 * can stop them if this helper is killed outright.
 *
 * The reverse case, this helper killed while the engine lives, is covered by
 * `watch`: each `engine.js run-role` starts it inside its own group, and it
 * stops that group (router.js and the agent too) once this helper is gone.
 *
 *   parallel-roles.js run <id> <stage> --cap N --summary-file FILE [--pid-file FILE] [--pgid-file FILE] <role...>
 *   parallel-roles.js watch <runner-pid> <group>   (internal, started by engine.js run-role)
 *   parallel-roles.js --selftest
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ENGINE = path.join(__dirname, 'engine.js');
const RUNS_TOOL = path.join(__dirname, '..', 'tasks', 'feature', 'runs.js');
const PARENT_POLL_MS = 1000;
const KILL_GRACE_MS = 10 * 1000;
const GROUP_POLL_MS = 100;
// After SIGKILL a group can still take a moment to be reaped; past this, stop waiting.
const REAP_LIMIT_MS = 5 * 1000;
// Set on each role child: the pid of the helper that started it (see `watch`).
const RUNNER_ENV = 'AI_WORKFLOW_PARALLEL_RUNNER';
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function prefixLines(stream, label, sink) {
  if (!stream) return;
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    let at;
    while ((at = pending.indexOf('\n')) >= 0) { sink.write(`[${label}] ${pending.slice(0, at)}\n`); pending = pending.slice(at + 1); }
  });
  stream.on('end', () => { if (pending) sink.write(`[${label}] ${pending}\n`); pending = ''; });
}

// Starts spawnItem(name) for each item, never more than `cap` alive at once.
// Resolves with one result per item, in item order, once every child has exited.
function runPool({ items, cap, spawnItem, stdout = process.stdout, stderr = process.stderr, shouldStop = () => false, onExit = () => {} }) {
  const limit = Math.max(1, Math.floor(cap) || 1);
  const results = new Array(items.length);
  let next = 0, running = 0, maxRunning = 0;
  return new Promise(resolve => {
    const pump = () => {
      while (running < limit && next < items.length && !shouldStop()) {
        const index = next++;
        const name = items[index];
        const startedAt = Date.now();
        running++;
        maxRunning = Math.max(maxRunning, running);
        let done = false;
        const finish = (exitCode, signal, error) => {
          if (done) return;
          done = true;
          running--;
          const finishedAt = Date.now();
          results[index] = { role: name, exitCode, signal: signal || null, error: error || null, ok: exitCode === 0 && !signal && !error, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(), durationMs: finishedAt - startedAt };
          onExit(results[index]);
          setImmediate(pump);
        };
        let child;
        try { child = spawnItem(name); }
        catch (e) { finish(null, null, e.message); continue; }
        prefixLines(child.stdout, name, stdout);
        prefixLines(child.stderr, name, stderr);
        child.on('error', e => finish(null, null, e.message));
        child.on('close', (code, signal) => finish(code, signal, null));
      }
      if (running === 0 && (next >= items.length || shouldStop())) {
        for (let i = 0; i < items.length; i++) results[i] ||= { role: items[i], exitCode: null, signal: null, error: 'not started: interrupted', ok: false, startedAt: null, finishedAt: null, durationMs: 0 };
        resolve({ maxRunning, results });
      }
    };
    pump();
  });
}

function parseCli(argv) {
  const [cmd, id, stage, ...rest] = argv;
  const out = { cmd, id, stage, cap: null, summaryFile: null, pidFile: null, pgidFile: null, roles: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--cap') out.cap = Number(rest[++i]);
    else if (rest[i] === '--summary-file') out.summaryFile = rest[++i];
    else if (rest[i] === '--pid-file') out.pidFile = rest[++i];
    else if (rest[i] === '--pgid-file') out.pgidFile = rest[++i];
    else out.roles.push(rest[i]);
  }
  return out;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Each role runs detached, as the leader of its own process group (pgid = the
// role's pid), so a signal sent to the group also reaches router.js and the
// claude/codex session under it, even after the role itself has exited.
function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}
function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
// True unless `pgrep` shows this process is the group's only member. If pgrep
// cannot answer, assume others remain, so the full grace is kept.
function groupHasOthers(pgid) {
  const r = spawnSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8', timeout: 2000 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return true;
  return String(r.stdout || '').split(/\s+/).filter(Boolean).some(pid => Number(pid) !== process.pid);
}

// Waits until every group is gone. A group still alive `graceMs` after `since`
// gets SIGKILL; one that outlives that by REAP_LIMIT_MS is given up on and
// returned. The engine uses the synchronous twin below.
async function reapGroups(pgids, { since = Date.now(), graceMs = KILL_GRACE_MS, pollMs = GROUP_POLL_MS } = {}) {
  let killed = false;
  for (;;) {
    const alive = [...pgids].filter(groupAlive);
    if (!alive.length) return [];
    const waited = Date.now() - since;
    if (waited >= graceMs && !killed) { for (const pgid of alive) signalGroup(pgid, 'SIGKILL'); killed = true; }
    if (waited >= graceMs + REAP_LIMIT_MS) return alive;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
// For the engine, which is synchronous: SIGTERM every group, wait up to graceMs
// for them to go, SIGKILL what is left. Returns the groups that never went.
function stopGroupsSync(pgids, { graceMs = KILL_GRACE_MS, pollMs = GROUP_POLL_MS } = {}) {
  const groups = [...new Set(pgids)].filter(pgid => Number.isInteger(pgid) && pgid > 1);
  for (const pgid of groups) signalGroup(pgid, 'SIGTERM');
  const since = Date.now();
  let killed = false;
  for (;;) {
    const alive = groups.filter(groupAlive);
    if (!alive.length) return [];
    const waited = Date.now() - since;
    if (waited >= graceMs && !killed) { for (const pgid of alive) signalGroup(pgid, 'SIGKILL'); killed = true; }
    if (waited >= graceMs + REAP_LIMIT_MS) return alive;
    Atomics.wait(SLEEP_CELL, 0, 0, pollMs);
  }
}

// `parallel-roles.js watch <runner-pid> <group>`: started by `engine.js run-role`
// inside its own process group. The helper watches the engine; this watches the
// helper. If the helper is killed outright (SIGKILL, OOM) while the engine lives,
// nothing else would stop the role, so this stops the whole group — run-role,
// router.js and the agent — with SIGTERM, then SIGKILL once the grace is over or
// it is the group's last member, and exits non-zero. It exits quietly once run-role
// (its parent) is gone, and leaves with the group when the helper stops it.
function watchRunner(runnerPid, group, { pollMs = PARENT_POLL_MS, graceMs = KILL_GRACE_MS } = {}) {
  const owner = process.ppid;
  let stopping = false;
  // A SIGTERM to the group is the helper stopping it, or this watcher's own
  // signal; only the first means leave now.
  process.on('SIGTERM', () => { if (!stopping) process.exit(0); });
  const watch = setInterval(() => {
    if (process.ppid !== owner) process.exit(0);
    if (pidAlive(runnerPid)) return;
    clearInterval(watch);
    stopping = true;
    signalGroup(group, 'SIGTERM');
    const until = Date.now() + graceMs;
    // Give every member (run-role, router.js, the agent) the grace to exit on
    // SIGTERM; leave early only once this watcher is the group's last member.
    // run-role exiting is not the end: the agent under it may still be cleaning up.
    const finish = setInterval(() => {
      if (Date.now() < until && groupHasOthers(group)) return;
      clearInterval(finish);
      signalGroup(group, 'SIGKILL');
      process.exit(1);
    }, GROUP_POLL_MS);
  }, pollMs);
}

// A role left in_progress by a child that was stopped is recorded as failed, so
// the run says why and `resume`/`retry` start it again. Only a role that is
// still in_progress changes: runs.js refuses `role-fail` from any other status.
function markInterrupted(id, stage, roles, reason) {
  for (const role of roles) {
    spawnSync(process.execPath, [RUNS_TOOL, 'role-fail', stage, role, '-', `interrupted: ${reason}`], {
      env: { ...process.env, FEATURE_RUN_ID: id, AI_WORKFLOW_ENGINE: '1', AI_WORKFLOW_ACTOR: 'workflow-engine' },
      stdio: 'ignore',
      timeout: 30 * 1000,
    });
  }
}

// `roleArgv` and `markFailed` exist only for the selftest; the CLI never
// passes them. The executable is always this Node binary, never a parameter.
async function main(argv, { roleArgv, markFailed = markInterrupted, parentPollMs = PARENT_POLL_MS, killGraceMs = KILL_GRACE_MS } = {}) {
  const opts = parseCli(argv);
  if (opts.cmd === 'watch' && /^\d+$/.test(opts.id || '') && /^\d+$/.test(opts.stage || '') && Number(opts.id) > 1 && Number(opts.stage) > 1 && !opts.roles.length) {
    watchRunner(Number(opts.id), Number(opts.stage));
    return new Promise(() => {}); // runs until it exits
  }
  if (opts.cmd !== 'run' || !SAFE.test(opts.id || '') || !SAFE.test(opts.stage || '') || !opts.summaryFile || !opts.roles.length || opts.roles.some(r => !SAFE.test(r)) || !(opts.cap >= 1)) {
    throw new Error('usage: parallel-roles.js run <id> <stage> --cap N --summary-file FILE [--pid-file FILE] [--pgid-file FILE] <role...>');
  }
  const argvFor = roleArgv || (role => [ENGINE, 'run-role', opts.id, opts.stage, role]);
  // Every group ever started. A role exiting does not remove it: the agent
  // under the role can outlive it, and a stop must still reach that agent.
  const groups = new Set();
  let interrupted = null, interruptedAt = null, escalation = null;
  const interrupt = (reason, signal) => {
    interrupted ||= reason;
    interruptedAt ??= Date.now();
    for (const pgid of groups) signalGroup(pgid, signal);
    // A role or agent that ignores the signal must not keep the stage alive
    // forever. Deliberately not unref'd: the helper stays until this fires or
    // reapGroups below has seen every group go.
    escalation ||= setTimeout(() => { for (const pgid of groups) signalGroup(pgid, 'SIGKILL'); }, killGraceMs);
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => interrupt(signal, signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  // The engine waits for this helper with spawnSync, so it cannot forward a
  // signal; if it dies (killed, or its terminal closed), stop on our own.
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (!interrupted && (process.ppid !== parent || !pidAlive(parent))) interrupt('parent-exit', 'SIGTERM');
  }, parentPollMs);
  watch.unref();
  if (opts.pidFile) {
    fs.mkdirSync(path.dirname(path.resolve(opts.pidFile)), { recursive: true });
    fs.writeFileSync(opts.pidFile, `${process.pid}\n`);
  }
  const removePidFile = () => { for (const file of [opts.pidFile, opts.pgidFile]) if (file) { try { fs.unlinkSync(file); } catch { /* gone */ } } };
  const recordGroups = () => {
    if (!opts.pgidFile) return;
    const tmp = `${opts.pgidFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify([...groups]) + '\n');
    fs.renameSync(tmp, opts.pgidFile);
  };
  process.once('exit', removePidFile);
  try {
    const started = Date.now();
    console.log(`parallel: ${opts.stage} — ${opts.roles.length} role(s), at most ${opts.cap} at a time: ${opts.roles.join(', ')}`);
    const { maxRunning, results } = await runPool({
      items: opts.roles,
      cap: opts.cap,
      shouldStop: () => !!interrupted,
      spawnItem: role => {
        // Checked again here, at the spawn: only a plain role name is ever passed
        // on, as one argv entry, with no shell.
        if (!SAFE.test(role)) throw new Error(`invalid role name: ${JSON.stringify(role)}`);
        const child = spawn(process.execPath, argvFor(role), {
          shell: false,
          cwd: process.cwd(),
          env: { ...process.env, FEATURE_RUN_ID: opts.id, [RUNNER_ENV]: String(process.pid) },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        if (child.pid) { groups.add(child.pid); recordGroups(); }
        return child;
      },
      onExit: r => console.log(`parallel: ${r.role} ${r.ok ? 'finished' : 'FAILED'} (${r.signal ? `signal ${r.signal}` : r.error ? r.error : `exit ${r.exitCode}`}) in ${Math.round(r.durationMs / 1000)}s`),
    });
    if (interrupted) {
      // Every role has exited, but an agent under one may not have: wait for
      // every group to go (SIGKILL at the grace deadline) before reporting.
      const left = await reapGroups(groups, { since: interruptedAt, graceMs: killGraceMs });
      if (left.length) console.error(`parallel: process group(s) ${left.join(', ')} did not exit after SIGKILL`);
      const stopped = results.filter(r => !r.ok && r.startedAt).map(r => r.role);
      if (stopped.length) markFailed(opts.id, opts.stage, stopped, interrupted);
    }
    const summary = { schemaVersion: 1, runId: opts.id, stage: opts.stage, cap: opts.cap, maxRunning, interrupted, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started, results };
    fs.mkdirSync(path.dirname(path.resolve(opts.summaryFile)), { recursive: true });
    fs.writeFileSync(opts.summaryFile, JSON.stringify(summary, null, 2) + '\n');
    console.log(`parallel: ${opts.stage} done in ${Math.round(summary.durationMs / 1000)}s — ${results.filter(r => r.ok).length}/${results.length} role(s) succeeded${interrupted ? ` (interrupted: ${interrupted})` : ''}`);
    return interrupted ? 130 : 0;
  } finally {
    clearInterval(watch);
    clearTimeout(escalation);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    removePidFile();
    process.removeListener('exit', removePidFile);
  }
}

async function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-roles-'));
  const running = path.join(dir, 'running');
  fs.mkdirSync(running);
  // Fake role: marks itself running, records how many roles run with it, sleeps,
  // and exits with the code its name asks for. Only this selftest can inject it.
  const fake = `
    const fs = require('fs'), path = require('path');
    const [dir, name] = process.argv.slice(1);
    const mine = path.join(dir, 'running', name);
    fs.writeFileSync(mine, '');
    const seen = fs.readdirSync(path.join(dir, 'running')).length;
    fs.writeFileSync(path.join(dir, name + '.seen'), String(seen));
    console.log('working on ' + name);
    setTimeout(() => {
      fs.rmSync(mine);
      fs.writeFileSync(path.join(dir, name + '.done'), '');
      if (name.startsWith('fail')) { console.error('boom in ' + name); process.exit(3); }
    }, 400);
  `;
  const sink = () => { const lines = []; return { lines, write: s => lines.push(s) }; };
  const spawnFake = name => spawn(process.execPath, ['-e', fake, dir, name], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const roles = ['docs', 'architect', 'fail-security', 'performance', 'android', 'ios', 'flutter'];
    const out = sink(), err = sink();
    const started = Date.now();
    const { maxRunning, results } = await runPool({ items: roles, cap: 3, spawnItem: spawnFake, stdout: out, stderr: err });
    const elapsed = Date.now() - started;
    assert.ok(maxRunning <= 3, `cap respected by the pool (max ${maxRunning})`);
    assert.strictEqual(maxRunning, 3, 'the pool actually runs roles at the same time');
    for (const role of roles) {
      assert.ok(fs.existsSync(path.join(dir, `${role}.done`)), `${role} ran to the end`);
      assert.ok(Number(fs.readFileSync(path.join(dir, `${role}.seen`), 'utf8')) <= 3, `${role} never saw more than 3 roles running`);
    }
    assert.ok(elapsed < roles.length * 400, `concurrent run is faster than sequential (${elapsed}ms)`);
    assert.deepStrictEqual(results.map(r => r.role), roles, 'one result per role, in order');
    const failed = results.filter(r => !r.ok);
    assert.deepStrictEqual(failed.map(r => r.role), ['fail-security'], 'the failing role is reported, the others are not');
    assert.strictEqual(failed[0].exitCode, 3);
    assert.ok(results.every(r => r.durationMs >= 0 && r.startedAt && r.finishedAt));
    assert.ok(out.lines.includes('[docs] working on docs\n'), 'stdout lines carry the role prefix');
    assert.ok(err.lines.includes('[fail-security] boom in fail-security\n'), 'stderr lines carry the role prefix');

    // cap 1 runs strictly one at a time; a role whose command cannot start is
    // reported as failed and does not stop the others.
    const one = await runPool({
      items: ['a', 'missing', 'b'], cap: 1, stdout: sink(), stderr: sink(),
      spawnItem: name => (name === 'missing' ? spawn(path.join(dir, 'no-such-binary'), [], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawnFake(name)),
    });
    assert.strictEqual(one.maxRunning, 1);
    assert.deepStrictEqual(one.results.map(r => r.ok), [true, false, true]);
    assert.ok(one.results[1].error, 'spawn failure is recorded as an error');
    assert.ok(fs.existsSync(path.join(dir, 'b.done')), 'the role after a spawn failure still ran');

    // An interrupted pool starts nothing new and reports what never started.
    let stop = false;
    const cut = await runPool({ items: ['c', 'd', 'e'], cap: 1, stdout: sink(), stderr: sink(), spawnItem: spawnFake, shouldStop: () => stop, onExit: () => { stop = true; } });
    assert.deepStrictEqual(cut.results.map(r => r.ok), [true, false, false]);
    assert.match(cut.results[2].error, /interrupted/);

    // Stopping the pool: a signal, or the engine (our parent) dying, ends every
    // running role's whole process group — the role, and the agent it started —
    // records the stopped roles as failed and starts nothing new.
    // Fake role: starts a grandchild in its own group (as router.js starts
    // claude), writes both pids, then sleeps far longer than the test.
    const longRole = `
      const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
      const [dir, name] = process.argv.slice(1);
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(dir, name + '.pids'), JSON.stringify([process.pid, grandchild.pid]));
      setTimeout(() => {}, 60000);
    `;
    // Runs main() with the fake role and a recorder in place of runs.js.
    const runner = `
      const fs = require('fs'), path = require('path');
      const { main } = require(${JSON.stringify(__filename)});
      const [dir, tag, longRole, killGraceMs] = process.argv.slice(1);
      main(['run', 'RUN-1', 'analysis', '--cap', '2', '--summary-file', path.join(dir, tag + '.summary.json'), '--pid-file', path.join(dir, tag + '.pid'), '--pgid-file', path.join(dir, tag + '.pgids'), tag + '-a', tag + '-b', tag + '-c'], {
        roleArgv: role => ['-e', longRole, dir, role],
        markFailed: (id, stage, roles, reason) => fs.writeFileSync(path.join(dir, tag + '.marked.json'), JSON.stringify({ id, stage, roles, reason })),
        parentPollMs: 100,
        killGraceMs: Number(killGraceMs) || undefined,
      }).then(code => { process.exitCode = code; });
    `;
    const waitFor = async (what, test, ms = 8000) => {
      const until = Date.now() + ms;
      while (!test()) { if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 25)); }
    };
    const pidsOf = tag => [`${tag}-a`, `${tag}-b`].flatMap(role => JSON.parse(fs.readFileSync(path.join(dir, `${role}.pids`), 'utf8')));
    const running = tag => [`${tag}-a`, `${tag}-b`].every(role => fs.existsSync(path.join(dir, `${role}.pids`)));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const assertStopped = async (tag, reason) => {
      const summary = JSON.parse(fs.readFileSync(path.join(dir, `${tag}.summary.json`), 'utf8'));
      assert.strictEqual(summary.interrupted, reason);
      assert.deepStrictEqual(summary.results.map(r => r.ok), [false, false, false]);
      assert.deepStrictEqual(summary.results.slice(0, 2).map(r => r.signal), ['SIGTERM', 'SIGTERM'], 'running roles were stopped by the signal');
      assert.match(summary.results[2].error, /not started: interrupted/, 'nothing new starts once stopped');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${tag}.marked.json`), 'utf8')), { id: 'RUN-1', stage: 'analysis', roles: [`${tag}-a`, `${tag}-b`], reason }, 'only the stopped roles are recorded as failed');
      await waitFor(`${tag} role and agent processes to exit`, () => pidsOf(tag).every(pid => !alive(pid)), 3000);
      assert.ok(!fs.existsSync(path.join(dir, `${tag}.pid`)), 'pid file removed when the pool stops');
      assert.ok(!fs.existsSync(path.join(dir, `${tag}.pgids`)), 'pgid file removed when the pool stops');
    };

    const signalled = spawn(process.execPath, ['-e', runner, dir, 'sig', longRole], { stdio: ['ignore', 'pipe', 'pipe'] });
    const signalledExit = new Promise(resolve => signalled.on('close', code => resolve(code)));
    await waitFor('signalled roles to start', () => running('sig'));
    assert.strictEqual(Number(fs.readFileSync(path.join(dir, 'sig.pid'), 'utf8')), signalled.pid, 'pid file names the helper while it runs');
    signalled.kill('SIGTERM');
    assert.strictEqual(await signalledExit, 130);
    await assertStopped('sig', 'SIGTERM');

    // A role and the agent under it that both ignore SIGTERM: the helper must
    // not exit before them (an exited role's group stays on its list) and must
    // SIGKILL them once the grace is over. Before 1.9.30's fix the helper left
    // at once, with the agent still running, and the SIGKILL timer was unref'd.
    const stubbornRole = `
      const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
      const [dir, name] = process.argv.slice(1);
      process.on('SIGTERM', () => {});
      const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], ''); setTimeout(() => {}, 60000)", path.join(dir, name + '.agent-ready')], { stdio: 'ignore' });
      fs.writeFileSync(path.join(dir, name + '.pids'), JSON.stringify([process.pid, grandchild.pid]));
      setTimeout(() => {}, 60000);
    `;
    const grace = 600;
    const stubborn = spawn(process.execPath, ['-e', runner, dir, 'stub', stubbornRole, String(grace)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stubbornExit = new Promise(resolve => stubborn.on('close', code => resolve(code)));
    await waitFor('stubborn roles and agents to start', () => running('stub') && ['stub-a', 'stub-b'].every(r => fs.existsSync(path.join(dir, `${r}.agent-ready`))));
    const stubbornPids = pidsOf('stub');
    const termAt = Date.now();
    stubborn.kill('SIGTERM');
    assert.strictEqual(await stubbornExit, 130);
    const took = Date.now() - termAt;
    assert.ok(took >= grace, `the helper waited out the grace before SIGKILL (${took}ms)`);
    assert.ok(took < grace + 3000, `the helper stopped within grace + margin (${took}ms)`);
    await waitFor('stubborn roles and agents to be reaped', () => stubbornPids.every(pid => !alive(pid)), 1000);
    const stubbornSummary = JSON.parse(fs.readFileSync(path.join(dir, 'stub.summary.json'), 'utf8'));
    assert.deepStrictEqual(stubbornSummary.results.slice(0, 2).map(r => r.signal), ['SIGKILL', 'SIGKILL'], 'roles that ignored SIGTERM were killed');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stub.marked.json'), 'utf8')).roles, ['stub-a', 'stub-b'], 'stubborn roles recorded as failed');

    // Parent death: an intermediate process stands in for the engine and is
    // killed outright, as an engine killed with SIGKILL would be.
    const engineStandIn = spawn(process.execPath, ['-e', `
      const { spawn } = require('child_process');
      spawn(process.execPath, process.argv.slice(1), { stdio: 'ignore' });
      setTimeout(() => {}, 60000);
    `, '--', '-e', runner, dir, 'orphan', longRole], { stdio: 'ignore' });
    await waitFor('orphaned roles to start', () => running('orphan'));
    const helperPid = Number(fs.readFileSync(path.join(dir, 'orphan.pid'), 'utf8'));
    engineStandIn.kill('SIGKILL');
    await waitFor('the orphaned pool to stop', () => fs.existsSync(path.join(dir, 'orphan.summary.json')) && !alive(helperPid));
    await assertStopped('orphan', 'parent-exit');

    // The helper killed outright while the engine lives: nothing can catch a
    // SIGKILL, so each role's own watcher (what engine.js run-role starts) must
    // stop its group. A stand-in helper starts one detached role the way the real
    // helper does; the role starts the watcher and an agent, then sleeps.
    const watchedRole = `
      const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
      const [dir, tool] = process.argv.slice(1);
      const watcher = spawn(process.execPath, [tool, 'watch', String(process.ppid), String(process.pid)], { stdio: 'ignore' });
      const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(dir, 'watched.pids'), JSON.stringify([process.pid, agent.pid, watcher.pid]));
      setTimeout(() => {}, 60000);
    `;
    const helperStandIn = spawn(process.execPath, ['-e', `
      const { spawn } = require('child_process');
      spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], { stdio: 'ignore', detached: true });
      setTimeout(() => {}, 60000);
    `, watchedRole, dir, __filename], { stdio: 'ignore' });
    await waitFor('the watched role to start', () => fs.existsSync(path.join(dir, 'watched.pids')));
    const watchedPids = JSON.parse(fs.readFileSync(path.join(dir, 'watched.pids'), 'utf8'));
    await new Promise(r => setTimeout(r, 300)); // let the watcher get going
    assert.ok(watchedPids.every(alive), 'role, agent and watcher run while the helper lives');
    helperStandIn.kill('SIGKILL');
    await waitFor('the watcher to stop the orphaned role group', () => watchedPids.every(pid => !alive(pid)), PARENT_POLL_MS + 3000);

    // Same, but the agent traps SIGTERM and needs about 1 s to clean up. The role
    // dies on the SIGTERM at once; the watcher must still give the agent its
    // grace rather than SIGKILL the group as soon as the role is gone.
    const slowAgent = "const fs = require('fs'); const done = process.argv[1]; process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(done, ''); process.exit(0); }, 1000)); setTimeout(() => {}, 60000)";
    const cleanRole = watchedRole.replace("['-e', 'setTimeout(() => {}, 60000)']", `['-e', ${JSON.stringify(slowAgent)}, path.join(dir, 'clean.done')]`).replace("'watched.pids'", "'clean.pids'");
    assert.ok(cleanRole.includes('clean.done') && cleanRole.includes('clean.pids'), 'slow-agent role built from the watched role');
    const cleanStandIn = spawn(process.execPath, ['-e', `
      const { spawn } = require('child_process');
      spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], { stdio: 'ignore', detached: true });
      setTimeout(() => {}, 60000);
    `, cleanRole, dir, __filename], { stdio: 'ignore' });
    await waitFor('the slow-agent role to start', () => fs.existsSync(path.join(dir, 'clean.pids')));
    const cleanPids = JSON.parse(fs.readFileSync(path.join(dir, 'clean.pids'), 'utf8'));
    await new Promise(r => setTimeout(r, 300));
    cleanStandIn.kill('SIGKILL');
    await waitFor('the watcher to stop the slow-agent role group', () => cleanPids.every(pid => !alive(pid)), PARENT_POLL_MS + 5000);
    assert.ok(fs.existsSync(path.join(dir, 'clean.done')), 'an agent that traps SIGTERM finishes its cleanup within the grace');

    // No roles: resolves at once.
    assert.deepStrictEqual((await runPool({ items: [], cap: 4, spawnItem: spawnFake })).results, []);

    // The CLI refuses anything but role names: it never runs a caller-supplied command.
    await assert.rejects(() => main(['run', 'RUN-1', 'analysis', '--cap', '2', '--summary-file', path.join(dir, 's.json'), '../../evil']), /usage/);
    await assert.rejects(() => main(['run', 'RUN-1', 'analysis', '--cap', '0', '--summary-file', path.join(dir, 's.json'), 'docs']), /usage/);
  } finally {
    // A failed assertion must not leave the 60 s fake roles behind.
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.pids'))) {
      for (const pid of JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('parallel-roles selftest OK');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const job = argv.includes('--selftest') ? selftest().then(() => 0) : main(argv);
  job.then(code => { process.exitCode = code; }, e => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
}

module.exports = { runPool, parseCli, main, stopGroupsSync, RUNNER_ENV, KILL_GRACE_MS };
