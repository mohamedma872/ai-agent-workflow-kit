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
function ensure(runtimeRoot, id, options = {}) {
  safeRunId(id);
  const sourceRoot = repoTop(options.sourceRoot || runtimeRoot);
  const existing = inspect(runtimeRoot, id);
  if (existing?.exists) {
    const updated = { ...existing, currentSha: currentSha(existing.path), resumedAt: new Date().toISOString() };
    delete updated.dirty; delete updated.upstream; delete updated.ahead; delete updated.unpublished; delete updated.exists;
    atomicJson(metadataFile(runtimeRoot, id), updated);
    return { ...updated, exists: true };
  }
  const baseSha = options.baseSha || git(sourceRoot, ['rev-parse', 'HEAD']);
  const branch = options.branch || branchName(id);
  const target = path.join(worktreesRoot(sourceRoot), id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`worktree path already exists and is not empty: ${target}`);
  const branchExists = git(sourceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status === 0;
  if (branchExists) git(sourceRoot, ['worktree', 'add', target, branch]);
  else git(sourceRoot, ['worktree', 'add', '-b', branch, target, baseSha]);
  const meta = { runId: id, path: target, branch, baseSha, currentSha: currentSha(target), createdAt: new Date().toISOString(), sourceRoot, gitCommonDir: repoCommonDir(sourceRoot) };
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
  assert.notStrictEqual(a.path, b.path); assert.notStrictEqual(a.branch, b.branch);
  fs.writeFileSync(path.join(a.path, 'a.txt'), 'a');
  assert.strictEqual(fs.existsSync(path.join(b.path, 'a.txt')), false);
  assert.strictEqual(fs.existsSync(path.join(repo, 'a.txt')), false);
  assert.strictEqual(status(repo), mainBefore);
  assert.throws(() => cleanup(repo, 'RUN-A'), /uncommitted/);
  cleanup(repo, 'RUN-A', { force: true });
  const clean = cleanup(repo, 'RUN-B');
  assert.strictEqual(clean.removed, true);
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
module.exports = { ensure, inspect, refresh, cleanup, branchName, worktreesRoot, metadataFile };
