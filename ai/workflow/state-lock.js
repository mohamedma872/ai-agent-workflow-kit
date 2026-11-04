#!/usr/bin/env node
'use strict';

/*
 * Cross-process exclusive lock for a run's state.json.
 *
 * Every writer of state.json (runs.js, attempts.js, the engine, mobile-evidence)
 * is its own short-lived process doing load -> modify -> atomic rename. The
 * rename keeps the file whole, but two writers that overlap still lose one
 * update: both load the same version and the second rename wins. Once roles of
 * a parallel stage run at the same time that overlap is routine, so every
 * read-modify-write goes through withStateLock().
 *
 * The lock is a directory `<state.json>.lock` (mkdir is atomic) holding an
 * owner.json with pid, host, time and a random token. Waiters poll with a short
 * synchronous sleep. A lock is stale when its holder pid is dead on this host,
 * or when it is older than the stale bound (a live holder never needs that
 * long: a state transition takes milliseconds). Breaking a stale lock is itself
 * serialized by a second `<lock>.break` directory, so two waiters cannot both
 * break it and one of them delete the other's fresh lock.
 *
 * Nested calls for the same file in the same process just run: the engine is
 * synchronous, so a nested call can only come from inside the outer one.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 90 * 1000;
const DEFAULT_STALE_MS = 60 * 1000;
const OWNERLESS_GRACE_MS = 10 * 1000; // holder died between mkdir and writing owner.json
const BREAK_STALE_MS = 10 * 1000;

const held = new Map(); // lock dir -> { token, depth }
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) { Atomics.wait(SLEEP_CELL, 0, 0, Math.max(1, Math.floor(ms))); }
function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function lockPathFor(file) { return `${path.resolve(file)}.lock`; }
function ownerFile(lockDir) { return path.join(lockDir, 'owner.json'); }
function readOwner(lockDir) { try { return JSON.parse(fs.readFileSync(ownerFile(lockDir), 'utf8')); } catch { return null; } }
function ageMs(lockDir, owner) {
  const at = owner && Date.parse(owner.acquiredAt);
  if (Number.isFinite(at)) return Date.now() - at;
  try { return Date.now() - fs.statSync(lockDir).mtimeMs; } catch { return 0; }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Why the lock at lockDir may be broken, or null while it is legitimately held.
function staleReason(lockDir, staleMs) {
  const owner = readOwner(lockDir);
  const age = ageMs(lockDir, owner);
  if (!owner) return age > OWNERLESS_GRACE_MS ? `lock has no owner record and is ${Math.round(age / 1000)}s old` : null;
  if (owner.host === os.hostname() && !pidAlive(owner.pid)) return `holder pid ${owner.pid} is not running`;
  if (age > staleMs) return `lock held by pid ${owner.pid} for ${Math.round(age / 1000)}s (stale bound ${Math.round(staleMs / 1000)}s)`;
  return null;
}

// Removes lockDir only if it is still the same stale lock, under the break lock.
function breakStale(lockDir, staleMs) {
  const breaker = `${lockDir}.break`;
  try { fs.mkdirSync(breaker); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // A breaker that died mid-break must not wedge every waiter.
    try { if (Date.now() - fs.statSync(breaker).mtimeMs > BREAK_STALE_MS) fs.rmSync(breaker, { recursive: true, force: true }); } catch { /* raced */ }
    return false;
  }
  try {
    const reason = staleReason(lockDir, staleMs);
    if (!reason) return false;
    const graveyard = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(lockDir, graveyard); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    fs.rmSync(graveyard, { recursive: true, force: true });
    process.stderr.write(`state-lock: took over stale lock ${lockDir} (${reason})\n`);
    return true;
  } finally { try { fs.rmdirSync(breaker); } catch { /* best effort */ } }
}

function acquire(lockDir, { timeoutMs, staleMs }) {
  const token = crypto.randomBytes(12).toString('hex');
  const deadline = Date.now() + timeoutMs;
  let delay = 5;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile(lockDir), JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token }) + '\n');
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (staleReason(lockDir, staleMs) && breakStale(lockDir, staleMs)) continue;
    if (Date.now() >= deadline) {
      const owner = readOwner(lockDir);
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for state lock ${lockDir}${owner ? ` held by pid ${owner.pid} since ${owner.acquiredAt}` : ''}; if no workflow process is running, remove that directory`);
    }
    sleepSync(delay + Math.random() * delay);
    delay = Math.min(delay * 2, 50);
  }
}

function release(lockDir, token) {
  const owner = readOwner(lockDir);
  // Taken over as stale while we held it: the lock is someone else's now.
  if (owner && owner.token !== token) { process.stderr.write(`state-lock: ${lockDir} was taken over while held by pid ${process.pid}; not removing it\n`); return; }
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function withStateLock(file, fn, options = {}) {
  const lockDir = lockPathFor(file);
  const mine = held.get(lockDir);
  if (mine) {
    mine.depth++;
    try { return fn(); } finally { mine.depth--; }
  }
  const timeoutMs = options.timeoutMs || envMs('AI_WORKFLOW_STATE_LOCK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const staleMs = options.staleMs || envMs('AI_WORKFLOW_STATE_LOCK_STALE_MS', DEFAULT_STALE_MS);
  // The run directory normally exists; when it does not (a command aimed at an
  // unknown run), create it for the lock and remove it again if nothing else
  // was written there, so a failed command does not leave a phantom run behind.
  const parent = path.dirname(lockDir);
  let createdParent = false;
  if (!fs.existsSync(parent)) { fs.mkdirSync(parent, { recursive: true }); createdParent = true; }
  const token = acquire(lockDir, { timeoutMs, staleMs });
  held.set(lockDir, { token, depth: 1 });
  try { return fn(); }
  finally {
    held.delete(lockDir);
    release(lockDir, token);
    if (createdParent) { try { fs.rmdirSync(parent); } catch { /* now holds the new run */ } }
  }
}

// process.exit() inside a locked section skips `finally`; do not leave the lock behind.
process.on('exit', () => { for (const [lockDir, { token }] of held) release(lockDir, token); held.clear(); });

// Load -> modify -> atomic rename, all under the lock. `mutate` gets the parsed
// state (or null) and returns the state to write, or undefined to write nothing.
function updateJsonLocked(file, mutate, options = {}) {
  return withStateLock(file, () => {
    let current = null;
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { current = null; }
    const next = mutate(current);
    if (next !== undefined) writeJsonAtomic(file, next);
    return next;
  }, options);
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-lock-'));
  const file = path.join(root, 'RUN', 'state.json');
  try {
    // 1. Concurrent writers from separate processes lose no update.
    writeJsonAtomic(file, { count: 0 });
    const workers = 6, perWorker = 60;
    const child = `
      const { updateJsonLocked } = require(${JSON.stringify(__filename)});
      for (let i = 0; i < ${perWorker}; i++) updateJsonLocked(${JSON.stringify(file)}, s => { s.count++; (s.by ||= {})[process.pid] = ((s.by[process.pid]) || 0) + 1; return s; });
    `;
    const codes = await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', child], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', d => { err += d; });
      p.on('error', reject);
      p.on('close', code => (code === 0 ? resolve(code) : reject(new Error(`worker exited ${code}: ${err}`))));
    })));
    assert.deepStrictEqual(codes, Array(workers).fill(0));
    const final = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(final.count, workers * perWorker, `every locked increment survives (got ${final.count})`);
    assert.strictEqual(Object.keys(final.by).length, workers);
    assert.ok(!fs.existsSync(lockPathFor(file)), 'lock released after the last writer');

    // 2. A lock whose holder pid is dead is taken over at once.
    const lockDir = lockPathFor(file);
    const dead = spawn(process.execPath, ['-e', '0']);
    const deadPid = await new Promise(resolve => dead.on('close', () => resolve(dead.pid)));
    fs.mkdirSync(lockDir);
    fs.writeFileSync(ownerFile(lockDir), JSON.stringify({ pid: deadPid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'dead' }));
    let started = Date.now();
    assert.strictEqual(withStateLock(file, () => 'ran', { timeoutMs: 5000 }), 'ran');
    assert.ok(Date.now() - started < 3000, 'dead-holder lock is broken without waiting for the stale bound');
    assert.ok(!fs.existsSync(lockDir));

    // 3. A lock older than the stale bound is taken over even if its pid looks alive.
    fs.mkdirSync(lockDir);
    fs.writeFileSync(ownerFile(lockDir), JSON.stringify({ pid: process.ppid || 1, host: os.hostname(), acquiredAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), token: 'old' }));
    assert.strictEqual(withStateLock(file, () => 'ran-old', { timeoutMs: 5000, staleMs: 60 * 1000 }), 'ran-old');

    // 4. A live, fresh holder makes a waiter time out with a clear error.
    fs.mkdirSync(lockDir);
    fs.writeFileSync(ownerFile(lockDir), JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'live' }));
    started = Date.now();
    assert.throws(() => withStateLock(file, () => 'never', { timeoutMs: 400, staleMs: 60 * 1000 }), /timed out after .* waiting for state lock .* held by pid/);
    assert.ok(Date.now() - started >= 350, 'waited for the timeout');
    assert.ok(fs.existsSync(lockDir), 'a live holder keeps its lock');
    fs.rmSync(lockDir, { recursive: true, force: true });

    // 5. Re-entrant in one process; released after an exception.
    const nested = withStateLock(file, () => withStateLock(file, () => withStateLock(file, () => 'deep')));
    assert.strictEqual(nested, 'deep');
    assert.throws(() => withStateLock(file, () => { throw new Error('boom'); }), /boom/);
    assert.ok(!fs.existsSync(lockDir), 'lock released after an exception');
    assert.strictEqual(withStateLock(file, () => 'again', { timeoutMs: 500 }), 'again');

    // 6. Locking a file in a missing directory leaves no empty directory behind.
    const ghost = path.join(root, 'NO-SUCH-RUN', 'state.json');
    assert.strictEqual(withStateLock(ghost, () => 'ghost'), 'ghost');
    assert.ok(!fs.existsSync(path.dirname(ghost)), 'a failed command does not create a phantom run directory');
    const born = path.join(root, 'NEW-RUN', 'state.json');
    withStateLock(born, () => writeJsonAtomic(born, { id: 'NEW-RUN' }));
    assert.ok(fs.existsSync(born), 'a directory that received state is kept');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('state-lock selftest OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest().catch(e => { console.error(`✗ ${e.stack || e.message}`); process.exitCode = 1; });
  else { console.error('usage: state-lock.js --selftest'); process.exitCode = 1; }
}

module.exports = { withStateLock, updateJsonLocked, writeJsonAtomic, lockPathFor, staleReason };
