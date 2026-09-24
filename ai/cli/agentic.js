#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { appiumLaunchPlan, launcherSpecFor, toolchainEnv } = require('../workflow/toolchain');

const RUNTIME_ROOT = path.resolve(__dirname, '..', '..');
const ENGINE = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'engine.js');
const RUNS = path.join(RUNTIME_ROOT, 'ai', 'tasks', 'feature', 'runs.js');
const DOCTOR = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'doctor.js');
const PROGRESS = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'progress.js');
const DASHBOARD = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'dashboard.js');
const RUNS_INDEX = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'runs-index.js');
const REFACTOR = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'refactor-cli.js');
const REPORT = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'refactor-report.js');
const RAG = path.join(RUNTIME_ROOT, 'ai', 'rag', 'hybrid-rag.js');
const VERSION = path.join(RUNTIME_ROOT, 'ai', 'workflow', 'version.js');
const GUARD_RUNNER = path.join(RUNTIME_ROOT, 'ai', 'guard', 'runner.js');
const CODEX_MCP = path.join(RUNTIME_ROOT, 'ai', 'mcp', 'codex-delegate.mjs');
const UPDATE = path.join(RUNTIME_ROOT, 'ai', 'cli', 'update.js');

function fail(message, code = 1) {
  console.error('✗ ' + message);
  process.exit(code);
}

function parse(argv) {
  const out = { _: [], project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') { out.project = argv[++i]; continue; }
    out._.push(a);
  }
  return out;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); }
  catch { return resolved; }
}

function gitRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10000 });
  return r.status === 0 && String(r.stdout || '').trim() ? canonicalPath(String(r.stdout).trim()) : null;
}

function resolveProject(explicit, cwd = process.cwd()) {
  if (explicit) return canonicalPath(explicit);
  if (process.env.AI_WORKFLOW_PROJECT_ROOT) return canonicalPath(process.env.AI_WORKFLOW_PROJECT_ROOT);
  return gitRoot(cwd) || canonicalPath(cwd);
}

function stateRoot(project) { return path.join(project, '.agentic-runs'); }

function runtimeEnv(project, extra = {}) {
  return {
    ...process.env,
    AI_AGENTIC_CLI: '1',
    AI_WORKFLOW_RUNTIME_ROOT: RUNTIME_ROOT,
    AI_WORKFLOW_PROJECT_ROOT: project,
    AI_WORKFLOW_STATE_ROOT: stateRoot(project),
    ...extra,
  };
}

function runNode(file, args, project, options = {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    cwd: options.cwd || project,
    env: runtimeEnv(project, { ...toolchainEnv(), ...(options.env || {}) }),
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeout || 0,
  });
  if (r.error) throw r.error;
  if (options.capture) return r;
  if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);
  return r;
}

// `agentic mcp appium`: stdio MCP entry point that runs appium-mcp on a Node 22+
// install even when the default Node is older. Only appium-mcp writes to stdout.
function runAppiumMcp(argv, project) {
  const plan = appiumLaunchPlan(argv);
  if (plan.error) fail(plan.error);
  const child = spawn(plan.command, plan.args, {
    cwd: project,
    env: { ...plan.env, ...toolchainEnv(plan.env) },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', e => fail(`appium-mcp failed to start with Node ${plan.node.version}: ${e.message}`));
  child.on('exit', code => { process.exitCode = code == null ? 1 : code; });
}

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  ensureDir(file);
  fs.writeFileSync(file, content);
  return true;
}

function appendGitignore(project, entries) {
  const file = path.join(project, '.gitignore');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const existing = new Set(text.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
  let changed = false;
  for (const entry of entries) {
    if (!existing.has(entry)) {
      if (text && !text.endsWith('\n')) text += '\n';
      text += entry + '\n';
      existing.add(entry);
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, text);
  return changed;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`cannot merge ${path.relative(process.cwd(), file)}: invalid JSON (${e.message})`); }
}

function addHook(file, entry) {
  const data = loadJson(file);
  data.hooks ||= {};
  data.hooks.PreToolUse ||= [];
  const command = entry.hooks?.[0]?.command;
  const exists = data.hooks.PreToolUse.some(x => x?.hooks?.some(h => h?.command === command));
  if (!exists) data.hooks.PreToolUse.push(entry);
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return !exists;
}

function hasAnyMcpServer(data, names) {
  const configured = new Set(Object.keys(data.mcpServers || {}).map(x => String(x).toLowerCase()));
  return names.some(name => configured.has(String(name).toLowerCase()));
}

function ensureMcpConfig(project, stacks) {
  const file = path.join(project, '.mcp.json');
  const data = loadJson(file);
  data.mcpServers ||= {};

  if (!data.mcpServers['codex-delegate']) {
    data.mcpServers['codex-delegate'] = { command: 'agentic', args: ['mcp', 'codex-delegate'] };
  }
  if (!data.mcpServers.context7) {
    data.mcpServers.context7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
  }

  // appium-mcp needs Node 22+; the agentic launcher finds one even when the
  // default Node is older. Existing standard `npx appium-mcp` entries migrate.
  const mobile = ['android', 'ios', 'flutter', 'react-native'].some(stack => stacks.includes(stack));
  const appiumKey = Object.keys(data.mcpServers).find(k => ['appium', 'appium-mcp', 'mcp-appium'].includes(k.toLowerCase()));
  if (mobile && !appiumKey) {
    data.mcpServers['appium-mcp'] = {
      type: 'stdio',
      command: 'agentic',
      args: ['mcp', 'appium'],
      timeout: 100,
    };
  } else if (appiumKey) {
    const migrated = launcherSpecFor(data.mcpServers[appiumKey]);
    if (migrated) {
      data.mcpServers[appiumKey] = migrated;
      console.log(`Updated MCP server "${appiumKey}" to run via the agentic Node 22+ launcher (agentic mcp appium)`);
    }
  }

  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return data;
}

function detectProject(project) {
  const exists = x => fs.existsSync(path.join(project, x));
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')); } catch {}
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const stacks = [];
  if (exists('android') || exists('build.gradle') || exists('build.gradle.kts')) stacks.push('android');
  if (exists('ios') || exists('Podfile') || fs.readdirSync(project).some(x => /\.xcodeproj$/.test(x))) stacks.push('ios');
  if (exists('pubspec.yaml')) stacks.push('flutter');
  if (deps['react-native']) stacks.push('react-native');
  if (!deps['react-native'] && (deps.react || deps.next || deps.vue || deps.vite || deps['@angular/core'] || deps.svelte)) stacks.push('frontend');
  if (deps.express || deps.fastify || deps.koa || deps['@nestjs/core'] || exists('manage.py') || exists('requirements.txt') || exists('pyproject.toml') || exists('backend') || exists('server') || exists('api')) stacks.push('backend');
  if (exists('pom.xml')) stacks.push('java');
  if (exists('go.mod')) stacks.push('go');
  if (fs.readdirSync(project).some(x => /\.sln$|\.csproj$/.test(x))) stacks.push('dotnet');
  return [...new Set(stacks)];
}

function initProject(project) {
  const git = gitRoot(project);
  if (!git || canonicalPath(git) !== canonicalPath(project)) throw new Error('agentic init must run at a Git repository root (or use --project <repo>)');

  const stacks = detectProject(project);
  const agentic = path.join(project, '.agentic');
  fs.mkdirSync(agentic, { recursive: true });

  const name = path.basename(project);
  writeIfMissing(path.join(agentic, 'config.yaml'), `version: 1

# Informational only — a project fingerprint for humans. Not read by the runtime;
# changing these values has no effect.
project:
  name: ${name}
  root: .
  detected_stacks: [${stacks.join(', ')}]

# Informational only. Not read by the runtime — the state/worktree directory names
# are fixed (.agentic-runs/, .ai-worktrees/); changing these values here has no effect.
runtime:
  state_dir: .agentic-runs
  worktree_dir: .ai-worktrees

# NOT enforced by this file. The plan-approval and architecture-selection human gates
# are core, always-on guarantees of the runtime (ai/workflows/feature.yaml) and cannot
# be turned off from project-level config — that would let an ordinary file edit bypass
# the fence. These two lines record intent only; to change gate structure itself, edit
# ai/workflows/feature.yaml (a protected file — only the user changes it).
workflow:
  require_plan_approval: true
  require_architecture_selection: true

# Enforced — read on every retrieval call by ai/rag/hybrid-rag.js and
# ai/workflow/subagent-context.js for this project.
rag:
  enabled: true          # false disables Hybrid RAG context for every specialist role
  mode: hybrid           # hybrid | off (any other value behaves like off)
  top_k: 8               # max chunks returned per retrieval query
  context_budget: 24000  # max characters of retrieved context per role
`);

  writeIfMissing(path.join(agentic, 'knowledge.yaml'), `version: 1
# Enforced — read by ai/rag/hybrid-rag.js on every retrieval call for this project.
# Paths are relative to the project root; "**" matches any depth. Glob syntax only
# (no negation, no regex). File-extension/name filtering in hybrid-rag.js still
# applies on top of these lists.

# If non-empty, ONLY files matching one of these globs are retrieval candidates —
# this narrows scope, it does not add file types outside hybrid-rag.js's own list.
include:
  - src/**
  - app/**
  - lib/**
  - android/**
  - ios/**
  - docs/**
  - tests/**
  - test/**
  - api/**

# Chunks whose source path matches one of these get a small relevance boost, so they
# rank above equally-relevant results (architecture decisions, API schemas, etc.).
prioritize:
  - docs/adr/**
  - docs/architecture/**
  - openapi/**
  - graphql/**

# Extra exclusions on top of hybrid-rag.js's own built-in ignore list
# (node_modules, build, dist, .git, .agentic-runs, .ai-worktrees, .dart_tool, etc.).
exclude:
  - node_modules/**
  - build/**
  - dist/**
  - .git/**
  - .ai-worktrees/**
  - .agentic-runs/**
  - .env*
  - secrets/**
`);

  writeIfMissing(path.join(agentic, 'guardrails.yaml'), `version: 1
# NOT currently enforced. There is no loader that reads this file into the guard
# engine (ai/guard/engine.js only loads rule packs from ai/tasks/*/guard.yaml).
# This is a declared record of project policy intent, not active configuration —
# ai/guard.yaml is the only file that actually gates tool calls today.
project:
  production_write_requires_plan_approval: true
  destructive_operations_require_confirmation: true
  outward_writes_require_confirmation: true
`);

  writeIfMissing(path.join(agentic, 'README.md'), [
    '# Agentic project configuration',
    '',
    'This directory contains development-time configuration for the standalone Agentic Workflow CLI.',
    '',
    'It is not imported by application code and must not be packaged into production artifacts.',
    '',
    'Runtime state is stored in .agentic-runs/ and isolated worktrees in .ai-worktrees/; both are gitignored.',
    '',
  ].join('\\n'));

  ensureMcpConfig(project, stacks);

  appendGitignore(project, ['.agentic-runs/', '.ai-worktrees/', '.mcp.json']);

  addHook(path.join(project, '.codex', 'hooks.json'), {
    matcher: '',
    hooks: [{ type: 'command', command: 'agentic guard-hook --agent codex', statusMessage: 'agentic: applying workflow guardrails' }],
  });

  console.log('Agentic project initialized');
  console.log('Project: ' + project);
  console.log('Detected: ' + (stacks.join(', ') || 'generic Git repository'));
  console.log('Created/verified: .agentic/, local MCP config, .agentic-runs/.ai-worktrees ignores, Codex guard hook adapter');
  console.log('');
  console.log('Next:');
  console.log('  agentic doctor');
  console.log('  agentic feature FEAT-001 --request "Describe the change"');
}

function help() {
  console.log(`Agentic Workflow CLI

Usage:
  agentic init [--project <repo>]
  agentic doctor [--scope auto|mobile|frontend|backend|all]
  agentic feature <run-id> --request "..."
  agentic resume <run-id>
  agentic approve <run-id>
  agentic retry <run-id> [role...] Reset failed/blocked role(s) (or the stuck phase) to pending and resume
  agentic progress                 Terminal dashboard for in-progress features
  agentic progress <run-id> [--watch|--json|--markdown]
  agentic dashboard [--all] [--run <id>]
  agentic runs [--all] [--json]    List features and which one is active
  agentic switch <run-id>          Make a feature the active run
  agentic refactor <run-id> --request "..."
  agentic refactor-app <run-id> --request "..."
  agentic architecture <run-id> <option-id> [note]
  agentic report <run-id> [--json]
  agentic rag --query "..." [--role security] [--json]
  agentic worktree <run-id>
  agentic cleanup <run-id> [--force]
  agentic version
  agentic update [--check] [--json]
  agentic mcp codex-delegate   # internal MCP entry point
  agentic mcp appium           # Appium MCP on Node 22+ (internal MCP entry point)

Global:
  --project <repo>   Target an existing repository without changing directory.

The CLI/runtime is development tooling. Runtime state lives in .agentic-runs/ and product changes occur only in isolated .ai-worktrees/.
`);
}

function selftest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: temp });
  fs.writeFileSync(path.join(temp, 'settings.gradle.kts'), 'rootProject.name = "demo"\n');
  fs.mkdirSync(path.join(temp, 'android'), { recursive: true });
  initProject(temp);
  assert(fs.existsSync(path.join(temp, '.agentic', 'config.yaml')));
  assert(fs.readFileSync(path.join(temp, '.gitignore'), 'utf8').includes('.agentic-runs/'));
  assert(fs.readFileSync(path.join(temp, '.gitignore'), 'utf8').includes('.mcp.json'));
  const mcp = loadJson(path.join(temp, '.mcp.json'));
  assert.strictEqual(mcp.mcpServers['codex-delegate'].command, 'agentic');
  assert.strictEqual(mcp.mcpServers['appium-mcp'].command, 'agentic');
  assert.deepStrictEqual(mcp.mcpServers['appium-mcp'].args, ['mcp', 'appium']);

  // Re-running init migrates a standard npx entry and keeps its other fields.
  mcp.mcpServers['appium-mcp'] = { type: 'stdio', command: 'npx', args: ['-y', 'appium-mcp@latest'], timeout: 100, env: { APPIUM_HOME: '/x' } };
  fs.writeFileSync(path.join(temp, '.mcp.json'), JSON.stringify(mcp));
  initProject(temp);
  const migrated = loadJson(path.join(temp, '.mcp.json')).mcpServers['appium-mcp'];
  assert.deepStrictEqual(migrated, { type: 'stdio', command: 'agentic', args: ['mcp', 'appium'], timeout: 100, env: { APPIUM_HOME: '/x' } });
  const custom = { command: '/opt/custom/appium-wrapper', args: [] };
  fs.writeFileSync(path.join(temp, '.mcp.json'), JSON.stringify({ mcpServers: { appium: custom } }));
  initProject(temp);
  assert.deepStrictEqual(loadJson(path.join(temp, '.mcp.json')).mcpServers.appium, custom, 'custom Appium commands are left alone');
  assert(fs.existsSync(path.join(RUNTIME_ROOT, 'ai', 'cli', 'claude-settings.json')));
  const codex = loadJson(path.join(temp, '.codex', 'hooks.json'));
  assert(codex.hooks.PreToolUse.some(x => x.hooks.some(h => h.command.includes('--agent codex'))));
  assert(detectProject(temp).includes('android'));
  assert.strictEqual(stateRoot(temp), path.join(temp, '.agentic-runs'));

  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-cli-symlink-'));
  const realProject = path.join(symlinkRoot, 'real-project');
  const aliasProject = path.join(symlinkRoot, 'alias-project');
  fs.mkdirSync(realProject, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: realProject });
  fs.symlinkSync(realProject, aliasProject, process.platform === 'win32' ? 'junction' : 'dir');
  initProject(aliasProject);
  assert.strictEqual(gitRoot(aliasProject), canonicalPath(realProject));
  fs.rmSync(symlinkRoot, { recursive: true, force: true });

  fs.rmSync(temp, { recursive: true, force: true });
  console.log('standalone CLI selftest OK');
}

function main() {
  const parsed = parse(process.argv.slice(2));
  const args = parsed._;
  const command = args[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'selftest') return selftest();

  const project = resolveProject(parsed.project);

  if (command === 'guard-hook') {
    const rest = args.slice(1);
    const r = spawnSync(process.execPath, [GUARD_RUNNER, ...rest], {
      cwd: project,
      env: runtimeEnv(project, {
        AI_WORKFLOW_PRODUCT_ROOT: process.env.AI_WORKFLOW_PRODUCT_ROOT || project,
      }),
      stdio: 'inherit',
    });
    if (r.error) throw r.error;
    process.exitCode = r.status == null ? 1 : r.status;
    return;
  }

  if (command === 'mcp') {
    if (args[1] === 'appium') return runAppiumMcp(args.slice(2), project);
    if (args[1] !== 'codex-delegate') throw new Error('mcp requires: codex-delegate | appium');
    return runNode(CODEX_MCP, args.slice(2), project);
  }

  if (command === 'init') return initProject(project);
  if (command === 'doctor') return runNode(DOCTOR, args.slice(1), project);
  if (command === 'version') return runNode(VERSION, ['version', ...args.slice(1)], project);
  if (command === 'update') return runNode(UPDATE, args.slice(1), project, { cwd: RUNTIME_ROOT });
  if (command === 'feature') {
    if (!args[1]) throw new Error('feature requires a run id');
    return runNode(ENGINE, ['start', ...args.slice(1)], project);
  }
  if (command === 'resume') {
    if (!args[1]) throw new Error('resume requires a run id');
    return runNode(ENGINE, ['resume', args[1], ...args.slice(2)], project);
  }
  if (command === 'approve') {
    if (!args[1]) throw new Error('approve requires a run id');
    runNode(RUNS, ['approve', args[1]], project);
    return runNode(ENGINE, ['resume', args[1]], project);
  }
  if (command === 'retry') {
    if (!args[1]) throw new Error('retry requires a run id (see: agentic runs)');
    runNode(RUNS, ['retry', ...args.slice(1)], project);
    return runNode(ENGINE, ['resume', args[1]], project);
  }
  // `agentic progress` with no run id opens the dashboard on the active run;
  // a run id, or any output flag, keeps the single-run renderer.
  if (command === 'progress' || command === 'status') {
    const rest = args.slice(1);
    const runId = rest.find(arg => !arg.startsWith('--')) || null;
    const textOutput = rest.some(arg => ['--json', '--markdown', '--watch'].includes(arg));
    if (!runId && !textOutput) return runNode(DASHBOARD, rest, project);
    if (!runId) return runNode(PROGRESS, rest, project);
    return runNode(PROGRESS, ['--run', runId, ...rest.filter(arg => arg !== runId)], project);
  }
  if (command === 'dashboard' || command === 'ui') return runNode(DASHBOARD, args.slice(1), project);
  if (command === 'runs' || command === 'features') return runNode(RUNS_INDEX, args.slice(1), project);
  if (command === 'switch' || command === 'use') {
    if (!args[1]) throw new Error('switch requires a run id (see: agentic runs)');
    return runNode(RUNS_INDEX, ['--switch', args[1]], project);
  }
  if (command === 'refactor') {
    if (!args[1]) throw new Error('refactor requires a run id');
    return runNode(REFACTOR, ['run', ...args.slice(1)], project);
  }
  if (command === 'refactor-app') {
    if (!args[1]) throw new Error('refactor-app requires a run id');
    return runNode(REFACTOR, ['app', ...args.slice(1)], project);
  }
  if (command === 'architecture') {
    if (!args[1] || !args[2]) throw new Error('architecture requires <run-id> <option-id>');
    return runNode(REFACTOR, ['architecture', ...args.slice(1)], project);
  }
  if (command === 'report') {
    if (!args[1]) throw new Error('report requires a run id');
    return runNode(REPORT, [args[1], ...args.slice(2)], project);
  }
  if (command === 'rag') return runNode(RAG, ['--root', project, ...args.slice(1)], project);
  if (command === 'worktree') {
    if (!args[1]) throw new Error('worktree requires a run id');
    return runNode(ENGINE, ['worktree', args[1]], project);
  }
  if (command === 'cleanup') {
    if (!args[1]) throw new Error('cleanup requires a run id');
    return runNode(ENGINE, ['cleanup', ...args.slice(1)], project);
  }
  throw new Error('unknown command "' + command + '". Run: agentic help');
}

if (require.main === module) {
  try { main(); }
  catch (e) { fail(e.message); }
}

module.exports = {
  parse,
  canonicalPath,
  gitRoot,
  resolveProject,
  stateRoot,
  runtimeEnv,
  detectProject,
  appendGitignore,
  addHook,
  hasAnyMcpServer,
  ensureMcpConfig,
  initProject,
};
