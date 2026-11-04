#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function git(root, args, options = {}) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: options.timeout || 30000 });
  if (options.allowFailure) return res;
  if (res.error || res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.error?.message || String(res.stderr || '').trim()}`);
  return String(res.stdout || '').trim();
}
function safeRunId(id) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id || '')) throw new Error(`invalid run id: ${id}`); return id; }
function repoCommonDir(root) { return path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])); }
function repoTop(root) { return path.resolve(root, git(root, ['rev-parse', '--show-toplevel'])); }
function worktreesRoot(root) { return path.join(repoTop(root), '.ai-worktrees'); }
function metadataFile(runtimeRoot, id) {
  const runs = process.env.AI_WORKFLOW_STATE_ROOT ? path.resolve(process.env.AI_WORKFLOW_STATE_ROOT) : path.join(runtimeRoot, 'ai', 'runs');
  return path.join(runs, id, 'engine', 'worktree.json');
}
function branchName(id) { return `ai/run/${safeRunId(id).replace(/[^A-Za-z0-9._-]/g, '-')}`; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.tmp-${process.pid}-${Date.now()}`; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(temp, file); }
function currentSha(worktree) { return git(worktree, ['rev-parse', 'HEAD']); }
function status(worktree) { return git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']); }
function upstreamStatus(worktree) {
  const upstream = git(worktree, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true });
  if (upstream.status !== 0) return { upstream: null, ahead: null, unpublished: null };
  const name = String(upstream.stdout).trim();
  const count = git(worktree, ['rev-list', '--count', `${name}..HEAD`]);
  return { upstream: name, ahead: Number(count), unpublished: Number(count) > 0 };
}
function inspect(runtimeRoot, id) {
  const meta = readJson(metadataFile(runtimeRoot, id));
  if (!meta) return null;
  const exists = fs.existsSync(meta.path);
  if (!exists) return { ...meta, exists: false, currentSha: meta.currentSha || null, dirty: false, upstream: null, ahead: null, unpublished: false };
  const current = currentSha(meta.path);
  const upstream = upstreamStatus(meta.path);
  const unpublished = upstream.unpublished === null ? current !== meta.baseSha : upstream.unpublished;
  return { ...meta, exists: true, currentSha: current, dirty: status(meta.path) !== '', upstream: upstream.upstream, ahead: upstream.ahead, unpublished };
}
// A run created before 1.9.31 on a branch made beforehand recorded the main
// checkout's HEAD as its base, a commit that is not even in the run's history.
// Diffs against it carry another branch's commits: false analyzer issues, a
// pull request base guessed wrong. A recorded base that is not an ancestor of
// the worktree's HEAD is replaced by where HEAD leaves its upstream (the branch
// the run branch was cut from), or HEAD itself when it has none. The old value
// is kept in baseRepaired.
function repairBase(meta) {
  if (!meta?.baseSha || !meta.path || !fs.existsSync(meta.path)) return meta;
  if (git(meta.path, ['merge-base', '--is-ancestor', meta.baseSha, 'HEAD'], { allowFailure: true }).status === 0) return meta;
  const upstream = git(meta.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
  const via = upstream.status === 0 ? String(upstream.stdout).trim() : null;
  const fork = via ? git(meta.path, ['merge-base', 'HEAD', via], { allowFailure: true }) : null;
  const to = fork && fork.status === 0 && String(fork.stdout).trim() ? String(fork.stdout).trim() : currentSha(meta.path);
  return { ...meta, baseSha: to, baseRepaired: { from: meta.baseSha, to, via: via || 'HEAD', at: new Date().toISOString(), reason: 'the recorded base is not an ancestor of the run\'s HEAD' } };
}

function ensure(runtimeRoot, id, options = {}) {
  safeRunId(id);
  const sourceRoot = repoTop(options.sourceRoot || runtimeRoot);
  const existing = inspect(runtimeRoot, id);
  if (existing?.exists) {
    const updated = { ...repairBase(existing), currentSha: currentSha(existing.path), resumedAt: new Date().toISOString() };
    delete updated.dirty; delete updated.upstream; delete updated.ahead; delete updated.unpublished; delete updated.exists;
    atomicJson(metadataFile(runtimeRoot, id), updated);
    return { ...updated, exists: true };
  }
  const branch = options.branch || branchName(id);
  const target = path.join(worktreesRoot(sourceRoot), id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`worktree path already exists and is not empty: ${target}`);
  const branchExists = git(sourceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status === 0;
  let baseSha;
  let baseBranch = null;
  if (branchExists) {
    // A branch created beforehand (how a human picks another base for a run)
    // starts wherever that human put it, not at the main checkout's HEAD. Its
    // tip is where this run's own work starts, and the main checkout's branch
    // says nothing about its base, so none is recorded: the pull-request stage
    // then checks the fallback base, or asks for --base.
    git(sourceRoot, ['worktree', 'add', target, branch]);
    baseSha = currentSha(target);
    baseBranch = options.baseBranch || null;
  } else {
    baseSha = options.baseSha || git(sourceRoot, ['rev-parse', 'HEAD']);
    git(sourceRoot, ['worktree', 'add', '-b', branch, target, baseSha]);
    // The branch the run started from is the pull request's default base. A
    // detached checkout has none, and the pull-request stage then asks for --base.
    const symbolic = git(sourceRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true });
    baseBranch = options.baseBranch || (symbolic.status === 0 ? String(symbolic.stdout).trim() || null : null);
  }
  const meta = { runId: id, path: target, branch, baseSha, baseBranch, branchPreexisted: branchExists, currentSha: currentSha(target), createdAt: new Date().toISOString(), sourceRoot, gitCommonDir: repoCommonDir(sourceRoot) };
  atomicJson(metadataFile(runtimeRoot, id), meta);
  return { ...meta, exists: true };
}
function refresh(runtimeRoot, id) {
  const info = inspect(runtimeRoot, id);
  if (!info?.exists) throw new Error(`run ${id} has no worktree`);
  const meta = { ...info, currentSha: currentSha(info.path), updatedAt: new Date().toISOString() };
  delete meta.dirty; delete meta.upstream; delete meta.ahead; delete meta.unpublished; delete meta.exists;
  atomicJson(metadataFile(runtimeRoot, id), meta);
  return meta;
}
function cleanup(runtimeRoot, id, options = {}) {
  const info = inspect(runtimeRoot, id);
  if (!info) return { removed: false, reason: 'no worktree metadata' };
  if (!info.exists) return { removed: false, reason: 'worktree already absent' };
  if (!options.force && info.dirty) throw new Error(`refusing cleanup for ${id}: worktree has uncommitted changes`);
  if (!options.force && info.unpublished) throw new Error(`refusing cleanup for ${id}: branch has unpublished commits`);
  git(info.sourceRoot || runtimeRoot, ['worktree', 'remove', ...(options.force ? ['--force'] : []), info.path]);
  const meta = { ...info, removedAt: new Date().toISOString(), removed: true };
  delete meta.dirty; delete meta.exists;
  atomicJson(metadataFile(runtimeRoot, id), meta);
  return { removed: true, path: info.path, branch: info.branch };
}

function selftest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-worktree-'));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.ai-worktrees/\nai/runs/\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']);
  fs.mkdirSync(path.join(repo, 'ai', 'runs'), { recursive: true });
  const mainBefore = status(repo);
  const a = ensure(repo, 'RUN-A');
  const b = ensure(repo, 'RUN-B');
  assert.strictEqual(a.baseBranch, git(repo, ['symbolic-ref', '--short', 'HEAD']), 'the base branch is recorded');
  assert.strictEqual(a.branchPreexisted, false);
  assert.notStrictEqual(a.path, b.path); assert.notStrictEqual(a.branch, b.branch);
  // A run branch created beforehand from another base: its tip is the run's
  // start, and the main checkout's branch is not recorded as its base.
  const mainBranch = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'revamp']);
  fs.writeFileSync(path.join(repo, 'revamp.txt'), 'revamp\n');
  git(repo, ['add', 'revamp.txt']); git(repo, ['commit', '-qm', 'revamp work']);
  const revampTip = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['branch', branchName('RUN-PRE')]);
  git(repo, ['checkout', '-q', mainBranch]);
  const pre = ensure(repo, 'RUN-PRE');
  assert.deepStrictEqual([pre.branchPreexisted, pre.baseBranch, pre.baseSha], [true, null, revampTip], 'a pre-created branch keeps its own start and records no base');
  cleanup(repo, 'RUN-PRE', { force: true });
  fs.writeFileSync(path.join(a.path, 'a.txt'), 'a');
  assert.strictEqual(fs.existsSync(path.join(b.path, 'a.txt')), false);
  assert.strictEqual(fs.existsSync(path.join(repo, 'a.txt')), false);
  assert.strictEqual(status(repo), mainBefore);
  assert.throws(() => cleanup(repo, 'RUN-A'), /uncommitted/);
  cleanup(repo, 'RUN-A', { force: true });
  const clean = cleanup(repo, 'RUN-B');
  assert.strictEqual(clean.removed, true);
  // A base that is not in the run's history (a run from before 1.9.31) is
  // repaired on resume: to the fork point from the upstream, else to HEAD.
  {
    git(repo, ['branch', 'trunk']);
    git(repo, ['checkout', '-q', '-b', 'side']);
    fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'side work']);
    const sideTip = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', 'trunk']);
    const trunkTip = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['branch', '--track', 'ai/run/RUN-LEGACY', 'trunk']);
    const legacy = ensure(repo, 'RUN-LEGACY');
    const file = metadataFile(repo, 'RUN-LEGACY');
    atomicJson(file, { ...readJson(file), baseSha: sideTip, baseBranch: undefined, branchPreexisted: undefined });
    const resumed = ensure(repo, 'RUN-LEGACY');
    assert.strictEqual(resumed.baseSha, trunkTip, 'repaired to where the run leaves its upstream');
    assert.deepStrictEqual([resumed.baseRepaired.from, resumed.baseRepaired.via], [sideTip, 'trunk']);
    assert.strictEqual(readJson(file).baseSha, trunkTip, 'and saved');
    assert.strictEqual(ensure(repo, 'RUN-LEGACY').baseRepaired.from, sideTip, 'a valid base is left alone');
    assert.strictEqual(repairBase({ ...legacy, baseSha: trunkTip }).baseRepaired, undefined);
    cleanup(repo, 'RUN-LEGACY', { force: true });
  }
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('worktree isolation selftest OK');
}

if (require.main === module) {
  const [cmd, id] = process.argv.slice(2);
  const root = process.env.AI_WORKFLOW_RUNTIME_ROOT || path.resolve(__dirname, '..', '..');
  try {
    if (cmd === '--selftest' || cmd === 'selftest') selftest();
    else if (cmd === 'ensure') console.log(JSON.stringify(ensure(root, id), null, 2));
    else if (cmd === 'show') console.log(JSON.stringify(inspect(root, id), null, 2));
    else if (cmd === 'refresh') console.log(JSON.stringify(refresh(root, id), null, 2));
    else if (cmd === 'cleanup') console.log(JSON.stringify(cleanup(root, id, { force: process.argv.includes('--force') }), null, 2));
    else throw new Error('usage: worktree.js ensure|show|refresh|cleanup <run-id> [--force] | selftest');
  } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}
module.exports = { ensure, repairBase, inspect, refresh, cleanup, branchName, worktreesRoot, metadataFile };
