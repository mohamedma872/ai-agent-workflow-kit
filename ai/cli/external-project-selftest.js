#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNTIME_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_TOOL = path.join(RUNTIME_ROOT, 'ai', 'tasks', 'feature', 'runs.js');
const { ensure, inspect, cleanup } = require('../workflow/worktree');

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(String(r.stderr || r.error?.message || 'git failed'));
  return String(r.stdout || '').trim();
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); }
  catch { return resolved; }
}

function isInside(parent, child) {
  const base = canonicalPath(parent);
  const target = canonicalPath(child);
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-external-'));
  const project = path.join(temp, 'android-project');
  fs.mkdirSync(project, { recursive: true });
  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'test@example.com']);
  git(project, ['config', 'user.name', 'Agentic Test']);
  fs.writeFileSync(path.join(project, 'settings.gradle.kts'), 'rootProject.name = "demo"\n');
  fs.mkdirSync(path.join(project, 'app'), { recursive: true });
  fs.writeFileSync(path.join(project, 'app', 'build.gradle.kts'), 'plugins {}\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.ai-worktrees/\n.agentic-runs/\n');
  git(project, ['add', '.']);
  git(project, ['commit', '-qm', 'initial']);

  const aliasProject = path.join(temp, 'android-project-alias');
  fs.symlinkSync(project, aliasProject, process.platform === 'win32' ? 'junction' : 'dir');
  assert.strictEqual(canonicalPath(aliasProject), canonicalPath(project));

  const projectInput = aliasProject;
  const state = path.join(projectInput, '.agentic-runs');
  const env = {
    ...process.env,
    AI_AGENTIC_CLI: '1',
    AI_WORKFLOW_RUNTIME_ROOT: RUNTIME_ROOT,
    AI_WORKFLOW_PROJECT_ROOT: projectInput,
    AI_WORKFLOW_STATE_ROOT: state,
  };
  const previous = {
    runtime: process.env.AI_WORKFLOW_RUNTIME_ROOT,
    project: process.env.AI_WORKFLOW_PROJECT_ROOT,
    state: process.env.AI_WORKFLOW_STATE_ROOT,
  };
  Object.assign(process.env, {
    AI_WORKFLOW_RUNTIME_ROOT: RUNTIME_ROOT,
    AI_WORKFLOW_PROJECT_ROOT: projectInput,
    AI_WORKFLOW_STATE_ROOT: state,
  });

  try {
    const start = spawnSync(process.execPath, [RUNS_TOOL, 'start', 'EXT-001'], { cwd: projectInput, env, encoding: 'utf8' });
    assert.strictEqual(start.status, 0, start.stderr);
    assert(fs.existsSync(path.join(state, 'EXT-001', 'state.json')));
    assert(!fs.existsSync(path.join(RUNTIME_ROOT, 'ai', 'runs', 'EXT-001', 'state.json')));

    const wt = ensure(RUNTIME_ROOT, 'EXT-001', { sourceRoot: projectInput });
    assert(isInside(path.join(projectInput, '.ai-worktrees'), wt.path));
    assert(fs.existsSync(path.join(state, 'EXT-001', 'engine', 'worktree.json')));
    assert.strictEqual(canonicalPath(inspect(RUNTIME_ROOT, 'EXT-001').sourceRoot), canonicalPath(projectInput));

    fs.writeFileSync(path.join(wt.path, 'app', 'Demo.kt'), 'class Demo\n');
    assert.strictEqual(inspect(RUNTIME_ROOT, 'EXT-001').dirty, true);
    fs.unlinkSync(path.join(wt.path, 'app', 'Demo.kt'));
    cleanup(RUNTIME_ROOT, 'EXT-001', { force: true });
  } finally {
    if (previous.runtime === undefined) delete process.env.AI_WORKFLOW_RUNTIME_ROOT; else process.env.AI_WORKFLOW_RUNTIME_ROOT = previous.runtime;
    if (previous.project === undefined) delete process.env.AI_WORKFLOW_PROJECT_ROOT; else process.env.AI_WORKFLOW_PROJECT_ROOT = previous.project;
    if (previous.state === undefined) delete process.env.AI_WORKFLOW_STATE_ROOT; else process.env.AI_WORKFLOW_STATE_ROOT = previous.state;
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log('external project runtime selftest OK');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('✗ ' + e.message); process.exitCode = 1; }
}
