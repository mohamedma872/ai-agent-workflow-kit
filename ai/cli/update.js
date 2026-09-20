#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const VERSION_REL = path.join('ai', 'runtime-version.json');

function command(name) {
  return process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name;
}

function run(root, bin, args, options = {}) {
  const result = spawnSync(command(bin), args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 120000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env || {}) },
  });
  if (options.allowFailure) return result;
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${bin} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function git(root, args, options = {}) {
  return run(root, 'git', args, options);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const av = parseVersion(a), bv = parseVersion(b);
  if (!av || !bv) throw new Error(`stable SemVer required: "${a}" vs "${b}"`);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] < bv[i] ? -1 : 1;
  }
  return 0;
}

function runtimeVersion(root = DEFAULT_ROOT) {
  return readJson(path.join(root, VERSION_REL)).runtimeVersion;
}

function gitState(root = DEFAULT_ROOT) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    throw new Error('agentic update requires a Git clone installation');
  }
  const top = path.resolve(git(root, ['rev-parse', '--show-toplevel']));
  if (top !== path.resolve(root)) throw new Error(`runtime root is not the Git repository root: ${root}`);
  const sha = git(root, ['rev-parse', 'HEAD']);
  const branch = git(root, ['branch', '--show-current']);
  const dirty = git(root, ['status', '--porcelain']);
  const origin = git(root, ['remote', 'get-url', 'origin'], { allowFailure: true });
  if (origin.status !== 0 || !String(origin.stdout || '').trim()) throw new Error('runtime clone has no origin remote');
  return {
    root: path.resolve(root),
    sha,
    branch: branch || null,
    dirty,
    origin: String(origin.stdout).trim(),
    version: runtimeVersion(root),
  };
}

function assertClean(state) {
  if (!state.dirty) return true;
  const preview = state.dirty.split(/\r?\n/).filter(Boolean).slice(0, 10).join('\n');
  throw new Error(`runtime installation has local changes; update stopped to avoid overwriting them:\n${preview}\nCommit, stash, or remove these changes first.`);
}

function fetchLatest(root = DEFAULT_ROOT) {
  git(root, ['fetch', '--quiet', '--tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: 120000 });
  const targetSha = git(root, ['rev-parse', 'refs/remotes/origin/main']);
  const raw = git(root, ['show', `${targetSha}:${VERSION_REL.replaceAll(path.sep, '/')}`]);
  let meta;
  try { meta = JSON.parse(raw); } catch (e) { throw new Error(`origin/main has invalid runtime metadata: ${e.message}`); }
  if (!parseVersion(meta.runtimeVersion)) throw new Error(`origin/main runtimeVersion is not a stable SemVer: ${meta.runtimeVersion}`);
  if (meta.releaseChannel !== 'stable') throw new Error(`origin/main is not a stable runtime release: ${meta.releaseChannel}`);
  return { sha: targetSha, version: meta.runtimeVersion, releaseChannel: meta.releaseChannel };
}

function updateStatus(root = DEFAULT_ROOT) {
  const current = gitState(root);
  const latest = fetchLatest(root);
  const versionComparison = compareVersions(current.version, latest.version);
  return {
    current,
    latest,
    updateAvailable: versionComparison < 0,
    versionUpdateAvailable: versionComparison < 0,
    sourceDiffers: current.sha !== latest.sha,
  };
}

function applyGitTarget(root, state, latest) {
  if (state.sha === latest.sha) return { mode: 'none' };
  if (state.branch && state.branch !== 'main') {
    throw new Error(`runtime is on branch "${state.branch}". Switch the runtime clone to main before updating; custom/contributor branches are never changed automatically.`);
  }
  if (state.branch === 'main') {
    const ancestor = git(root, ['merge-base', '--is-ancestor', state.sha, latest.sha], { allowFailure: true });
    if (ancestor.status !== 0) {
      throw new Error('local main is not a fast-forward ancestor of origin/main; update refused to protect local commits/history');
    }
    git(root, ['merge', '--ff-only', latest.sha]);
    return { mode: 'fast-forward' };
  }
  git(root, ['checkout', '--detach', latest.sha]);
  return { mode: 'detached' };
}

function verifyInstallation(root) {
  run(root, process.execPath, [path.join(root, 'ai', 'workflow', 'version.js'), 'check'], { inherit: true, timeout: 120000 });
  run(root, process.execPath, [path.join(root, 'ai', 'cli', 'agentic.js'), 'selftest'], { inherit: true, timeout: 120000 });
  run(root, process.execPath, [path.join(root, 'ai', 'cli', 'external-project-selftest.js')], { inherit: true, timeout: 120000 });
}

function installDependencies(root) {
  run(root, 'npm', ['ci'], { inherit: true, timeout: 10 * 60 * 1000 });
  run(root, 'npm', ['link'], { inherit: true, timeout: 5 * 60 * 1000 });
}

function rollback(root, state) {
  try {
    if (state.branch === 'main') git(root, ['reset', '--hard', state.sha]);
    else git(root, ['checkout', '--detach', state.sha]);
    try { installDependencies(root); } catch { /* preserve original Git state even if relink fails */ }
    return true;
  } catch {
    return false;
  }
}

function performUpdate(root = DEFAULT_ROOT, options = {}) {
  const status = updateStatus(root);
  if (options.checkOnly) return { ...status, changed: false };
  assertClean(status.current);

  if (!status.updateAvailable) return { ...status, changed: false, alreadyCurrent: true };

  const before = status.current;
  let applied = false;
  try {
    applyGitTarget(root, before, status.latest);
    applied = true;
    if (options.install !== false) {
      installDependencies(root);
      verifyInstallation(root);
    }
    const after = gitState(root);
    if (after.sha !== status.latest.sha) throw new Error('post-update SHA does not match origin/main');
    if (after.version !== status.latest.version) throw new Error(`post-update version mismatch: expected ${status.latest.version}, got ${after.version}`);
    return { ...status, changed: true, after };
  } catch (error) {
    const restored = applied ? rollback(root, before) : true;
    const suffix = applied ? (restored ? ' Previous runtime restored.' : ' Automatic rollback failed; inspect the runtime clone manually.') : '';
    throw new Error(`${error.message}${suffix}`);
  }
}

function printStatus(result, options = {}) {
  if (options.json) {
    console.log(JSON.stringify({
      currentVersion: result.current.version,
      currentSha: result.current.sha,
      latestVersion: result.latest.version,
      latestSha: result.latest.sha,
      updateAvailable: result.updateAvailable,
      sourceDiffers: !!result.sourceDiffers,
      changed: !!result.changed,
    }, null, 2));
    return;
  }

  console.log(`Current: ${result.current.version}  ${result.current.sha.slice(0, 10)}`);
  console.log(`Latest:  ${result.latest.version}  ${result.latest.sha.slice(0, 10)}`);

  if (result.changed) {
    console.log('');
    console.log(`✓ Agentic updated to ${result.after.version}`);
    return;
  }
  if (result.updateAvailable) {
    console.log('');
    console.log('Update available. Run:');
    console.log('  agentic update');
    return;
  }
  console.log('');
  console.log('✓ Agentic is up to date');
}

function selftest() {
  assert.strictEqual(compareVersions('1.4.1', '1.4.2'), -1);
  assert.strictEqual(compareVersions('1.5.0', '1.4.9'), 1);
  assert.strictEqual(compareVersions('v1.4.1', '1.4.1'), 0);
  assert.throws(() => compareVersions('1.4.1-beta.1', '1.4.1'), /stable SemVer/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-update-'));
  const source = path.join(temp, 'source');
  const bare = path.join(temp, 'origin.git');
  const install = path.join(temp, 'install');
  fs.mkdirSync(path.join(source, 'ai'), { recursive: true });
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.email', 'test@example.com']);
  git(source, ['config', 'user.name', 'Agentic Test']);
  fs.writeFileSync(path.join(source, VERSION_REL), JSON.stringify({ runtimeVersion: '1.0.0', releaseChannel: 'stable' }) + '\n');
  fs.writeFileSync(path.join(source, 'README.md'), 'v1\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'v1']);
  run(temp, 'git', ['clone', '--bare', source, bare]);
  run(temp, 'git', ['clone', '-q', bare, install]);

  git(source, ['remote', 'add', 'origin', bare]);
  fs.writeFileSync(path.join(source, VERSION_REL), JSON.stringify({ runtimeVersion: '1.1.0', releaseChannel: 'stable' }) + '\n');
  fs.writeFileSync(path.join(source, 'README.md'), 'v2\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'v2']);
  git(source, ['push', '-q', 'origin', 'main']);

  const status = updateStatus(install);
  assert.strictEqual(status.current.version, '1.0.0');
  assert.strictEqual(status.latest.version, '1.1.0');
  assert.strictEqual(status.updateAvailable, true);

  fs.writeFileSync(path.join(install, 'local.txt'), 'dirty\n');
  assert.throws(() => assertClean(gitState(install)), /local changes/);
  fs.unlinkSync(path.join(install, 'local.txt'));

  const before = gitState(install);
  applyGitTarget(install, before, status.latest);
  const after = gitState(install);
  assert.strictEqual(after.version, '1.1.0');
  assert.strictEqual(after.sha, status.latest.sha);

  fs.writeFileSync(path.join(source, 'README.md'), 'docs-only\n');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-qm', 'docs only']);
  git(source, ['push', '-q', 'origin', 'main']);
  const sameVersionStatus = updateStatus(install);
  assert.strictEqual(sameVersionStatus.current.version, '1.1.0');
  assert.strictEqual(sameVersionStatus.latest.version, '1.1.0');
  assert.strictEqual(sameVersionStatus.sourceDiffers, true);
  assert.strictEqual(sameVersionStatus.updateAvailable, false);

  fs.rmSync(temp, { recursive: true, force: true });
  console.log('agentic update selftest OK');
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--selftest')) return selftest();
  const checkOnly = argv.includes('--check');
  const json = argv.includes('--json');
  const result = performUpdate(DEFAULT_ROOT, { checkOnly });
  printStatus(result, { json });
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error('✗ ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  parseVersion,
  compareVersions,
  runtimeVersion,
  gitState,
  assertClean,
  fetchLatest,
  updateStatus,
  applyGitTarget,
  performUpdate,
  printStatus,
  selftest,
};
