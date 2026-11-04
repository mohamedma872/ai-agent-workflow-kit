#!/usr/bin/env node
'use strict';

// A read-only role must leave the worktree as it found it, but its tools do
// not always agree: `flutter test` runs an implicit `pub get` that re-resolves
// pubspec.lock (and migrates analysis_options.yaml) when the local SDK differs
// from the pinned one, and `flutter build ios` rewrites project.pbxproj. The
// role itself may not revert them (the guard denies mutating commands), so it
// failed its stage over a change it did not want. The engine now snapshots
// every tracked file that differs from HEAD before a read-only role runs and,
// after it, puts back each tracked file whose content changed: from HEAD when
// it was clean before, from the saved copy when it already carried the run's
// own change. Untracked and ignored files (build/, .dart_tool/) are left alone.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FILE_MAX = 8 * 1024 * 1024;
const TOTAL_MAX = 64 * 1024 * 1024;
const DELETED = null;

function git(worktree, args, options = {}) {
  return spawnSync('git', args, { cwd: worktree, encoding: options.encoding === undefined ? 'utf8' : options.encoding, maxBuffer: 256 * 1024 * 1024 });
}
// Tracked paths whose worktree content differs from HEAD (staged or not).
function changedVsHead(worktree) {
  const res = git(worktree, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']);
  if (res.status !== 0) return null;
  return String(res.stdout || '').split('\0').filter(Boolean);
}
function readOrDeleted(file) {
  try { return fs.readFileSync(file); } catch (error) { return error.code === 'ENOENT' ? DELETED : undefined; }
}

// What to restore to. Returns null when the worktree is not a git checkout or
// holds more changed content than can be kept, in which case nothing is restored.
function snapshot(worktree) {
  const changed = changedVsHead(worktree);
  if (!changed) return null;
  const saved = new Map();
  let total = 0;
  for (const rel of changed) {
    const content = readOrDeleted(path.join(worktree, rel));
    if (content === undefined) return null;
    if (content && content.length > FILE_MAX) return null;
    total += content ? content.length : 0;
    if (total > TOTAL_MAX) return null;
    saved.set(rel, content);
  }
  return { worktree, saved };
}

function same(a, b) { return a === b || (a !== null && b !== null && a !== undefined && b !== undefined && a.equals(b)); }

// Puts back every tracked file that changed since the snapshot. Returns
// [{ path, from: 'HEAD' | 'snapshot' }] for what it restored.
function restore(snap) {
  if (!snap) return [];
  const { worktree, saved } = snap;
  const now = changedVsHead(worktree);
  if (!now) return [];
  const restored = [];
  const fromHead = [];
  for (const rel of new Set([...now, ...saved.keys()])) {
    const file = path.join(worktree, rel);
    if (saved.has(rel)) {
      const before = saved.get(rel);
      const current = readOrDeleted(file);
      if (same(before, current)) continue;
      if (before === DELETED) fs.rmSync(file, { force: true });
      else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, before); }
      restored.push({ path: rel, from: 'snapshot' });
    } else fromHead.push(rel);
  }
  if (fromHead.length) {
    // Clean before the role: the index still matches HEAD, so checking the
    // path out of the index restores it, including a deleted file.
    const res = git(worktree, ['checkout', '--', ...fromHead]);
    if (res.status === 0) for (const rel of fromHead) restored.push({ path: rel, from: 'HEAD' });
  }
  return restored;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-files-'));
  const run = args => { const r = git(tmp, args); assert.strictEqual(r.status, 0, r.stderr); return r.stdout; };
  try {
    run(['init', '-q']);
    fs.writeFileSync(path.join(tmp, 'pubspec.lock'), 'vector_math: 2.2.0\n');
    fs.writeFileSync(path.join(tmp, 'analysis_options.yaml'), 'analyzer:\n');
    fs.writeFileSync(path.join(tmp, 'feature.dart'), 'old\n');
    fs.writeFileSync(path.join(tmp, 'gone.dart'), 'kept\n');
    run(['add', '-A']);
    run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    // The run's own change, which the read-only role must not lose.
    fs.writeFileSync(path.join(tmp, 'feature.dart'), 'the run change\n');
    const snap = snapshot(tmp);
    assert.deepStrictEqual([...snap.saved.keys()], ['feature.dart']);
    // What the tools of a read-only role did.
    fs.writeFileSync(path.join(tmp, 'pubspec.lock'), 'vector_math: 2.4.4\n');
    fs.appendFileSync(path.join(tmp, 'analysis_options.yaml'), '  exclude: [build/**]\n');
    fs.writeFileSync(path.join(tmp, 'feature.dart'), 'formatted by a tool\n');
    fs.rmSync(path.join(tmp, 'gone.dart'));
    fs.mkdirSync(path.join(tmp, 'build'));
    fs.writeFileSync(path.join(tmp, 'build', 'out.txt'), 'untracked\n');
    const restored = restore(snap);
    assert.deepStrictEqual(restored.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'analysis_options.yaml', from: 'HEAD' },
      { path: 'feature.dart', from: 'snapshot' },
      { path: 'gone.dart', from: 'HEAD' },
      { path: 'pubspec.lock', from: 'HEAD' },
    ]);
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'pubspec.lock'), 'utf8'), 'vector_math: 2.2.0\n');
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'feature.dart'), 'utf8'), 'the run change\n', 'the run change survives');
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'gone.dart'), 'utf8'), 'kept\n');
    assert.ok(fs.existsSync(path.join(tmp, 'build', 'out.txt')), 'untracked output is left alone');
    assert.deepStrictEqual(changedVsHead(tmp), ['feature.dart']);
    assert.deepStrictEqual(restore(snapshot(tmp)), [], 'nothing changed, nothing restored');
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    try { assert.strictEqual(snapshot(plain), null, 'not a checkout: nothing to restore'); }
    finally { fs.rmSync(plain, { recursive: true, force: true }); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('tracked-files selftest OK');
}

module.exports = { snapshot, restore, changedVsHead };

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else { console.error('usage: tracked-files.js --selftest'); process.exitCode = 1; }
}
