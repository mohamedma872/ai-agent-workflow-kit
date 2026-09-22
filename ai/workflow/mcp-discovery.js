#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ALIASES = new Map([
  ['appium', 'appium'],
  ['appium-mcp', 'appium'],
  ['mcp-appium', 'appium'],
  ['context7', 'context7'],
  ['codex-delegate', 'codex-delegate'],
]);

function normalizeMcpName(name) {
  const raw = String(name || '').trim().toLowerCase();
  return ALIASES.get(raw) || raw;
}

function addName(set, name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return;
  set.add(raw);
  set.add(normalizeMcpName(raw));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function namesFromJsonConfig(file) {
  const data = readJson(file);
  const names = new Set();
  if (!data) return names;

  const seen = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.mcpServers && typeof value.mcpServers === 'object') {
      for (const name of Object.keys(value.mcpServers)) addName(names, name);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(data);
  return names;
}

// Server entries by logical name, so callers can see how a server is launched.
// Claude's precedence: local (per-project in ~/.claude.json) > project .mcp.json > user.
function specsFromJsonFiles(projectRoot, runtimeRoot, home) {
  const specs = new Map();
  const add = (servers, source) => {
    for (const [name, spec] of Object.entries(servers || {})) {
      const key = normalizeMcpName(name);
      if (!specs.has(key) && spec && typeof spec === 'object') specs.set(key, { name, spec, source });
    }
  };
  const userConfig = path.join(home, '.claude.json');
  const user = readJson(userConfig) || {};
  add(user.projects?.[projectRoot]?.mcpServers, `${userConfig} (local)`);
  add(readJson(path.join(projectRoot, '.mcp.json'))?.mcpServers, path.join(projectRoot, '.mcp.json'));
  add(user.mcpServers, userConfig);
  if (runtimeRoot) add(readJson(path.join(runtimeRoot, '.mcp.json'))?.mcpServers, path.join(runtimeRoot, '.mcp.json'));
  return specs;
}

function namesFromCodexToml(file) {
  const names = new Set();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return names; }
  const re = /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]\s*$/gm;
  for (const match of text.matchAll(re)) addName(names, match[1] || match[2] || match[3]);
  return names;
}

function commandExists(command) {
  if (!command) return false;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(finder, [command], { stdio: 'ignore', timeout: 2500 }).status === 0;
}

function safeCommand(command, args, timeout = 3500) {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout, env: process.env });
    return {
      ok: !r.error && r.status === 0,
      stdout: String(r.stdout || ''),
      stderr: String(r.stderr || ''),
    };
  } catch {
    return { ok: false, stdout: '', stderr: '' };
  }
}

function namesFromClaudeCli() {
  const names = new Set();
  if (!commandExists('claude')) return names;
  const r = safeCommand('claude', ['mcp', 'list'], 3500);
  if (!r.ok) return names;
  const text = r.stdout + '\n' + r.stderr;
  for (const alias of ALIASES.keys()) {
    if (new RegExp(`(^|[^A-Za-z0-9_-])${alias.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`, 'i').test(text)) addName(names, alias);
  }
  return names;
}

function globalPackageInstalled(packageName) {
  if (!packageName) return false;
  if (packageName === 'appium-mcp' && commandExists('appium-mcp')) return true;
  if (!commandExists('npm')) return false;
  const root = safeCommand('npm', ['root', '-g'], 3000);
  if (!root.ok) return false;
  const dir = String(root.stdout || '').trim();
  return !!dir && fs.existsSync(path.join(dir, packageName, 'package.json'));
}

function discoverMcps(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const runtimeRoot = options.runtimeRoot ? path.resolve(options.runtimeRoot) : null;
  const home = options.home ? path.resolve(options.home) : os.homedir();
  const names = new Set();
  const sources = [];

  for (const explicit of String(process.env.AI_WORKFLOW_AVAILABLE_MCPS || '').split(',').map(x => x.trim()).filter(Boolean)) {
    addName(names, explicit);
    sources.push({ type: 'env', name: explicit });
  }

  const jsonFiles = [
    path.join(projectRoot, '.mcp.json'),
    runtimeRoot ? path.join(runtimeRoot, '.mcp.json') : null,
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
  ].filter(Boolean);

  for (const file of jsonFiles) {
    const found = namesFromJsonConfig(file);
    if (found.size) {
      for (const name of found) names.add(name);
      sources.push({ type: 'json', file, names: [...found] });
    }
  }

  const codexFile = path.join(home, '.codex', 'config.toml');
  const codexNames = namesFromCodexToml(codexFile);
  if (codexNames.size) {
    for (const name of codexNames) names.add(name);
    sources.push({ type: 'codex', file: codexFile, names: [...codexNames] });
  }

  if (options.providerCli !== false) {
    const claudeNames = namesFromClaudeCli();
    if (claudeNames.size) {
      for (const name of claudeNames) names.add(name);
      sources.push({ type: 'claude-cli', names: [...claudeNames] });
    }
  }

  return {
    names,
    sources,
    specs: specsFromJsonFiles(projectRoot, runtimeRoot, home),
    installed: {
      appiumMcp: globalPackageInstalled('appium-mcp'),
    },
  };
}

function hasMcp(discovery, name) {
  return discovery.names.has(normalizeMcpName(name)) || discovery.names.has(String(name || '').toLowerCase());
}

function selftest() {
  assert.strictEqual(normalizeMcpName('appium-mcp'), 'appium');
  assert.strictEqual(normalizeMcpName('appium'), 'appium');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-discovery-'));
  const project = path.join(temp, 'project');
  const home = path.join(temp, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'appium-mcp': { command: 'npx' } } }));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.context7]\ncommand = "npx"\n');
  const d = discoverMcps({ projectRoot: project, home, providerCli: false });
  assert.strictEqual(hasMcp(d, 'appium'), true);
  assert.strictEqual(hasMcp(d, 'appium-mcp'), true);
  assert.strictEqual(hasMcp(d, 'context7'), true);
  assert.strictEqual(d.specs.get('appium').spec.command, 'npx');
  assert.strictEqual(d.specs.get('appium').name, 'appium-mcp');
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('MCP discovery selftest OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    const d = discoverMcps();
    const launchers = Object.fromEntries([...d.specs].map(([key, v]) => [key, { command: v.spec.command || null, source: v.source }]));
    console.log(JSON.stringify({ names: [...d.names].sort(), sources: d.sources, launchers, installed: d.installed }, null, 2));
  }
}

module.exports = {
  normalizeMcpName,
  namesFromJsonConfig,
  namesFromCodexToml,
  discoverMcps,
  hasMcp,
  globalPackageInstalled,
};
