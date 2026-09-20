#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { runtimeRoot, projectRoot } = require('./paths');
const { discoverMcps, hasMcp } = require('./mcp-discovery');

const ROOT = runtimeRoot();
const PROJECT_ROOT = projectRoot();
const VALID_SCOPES = new Set(['auto', 'mobile', 'frontend', 'backend', 'all']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

function commandExists(command) {
  if (!command) return false;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(finder, [command], { stdio: 'ignore', timeout: 3000 }).status === 0;
}

function run(command, args = [], timeout = 5000) {
  try {
    const res = spawnSync(command, args, { encoding: 'utf8', timeout, env: process.env });
    return { ok: !res.error && res.status === 0, status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), error: res.error || null };
  } catch (error) { return { ok: false, status: null, stdout: '', stderr: '', error }; }
}

function firstLine(text) { return String(text || '').trim().split(/\r?\n/)[0] || ''; }
function commandOutput(command, args) { const r = run(command, args); return r.ok ? firstLine(r.stdout || r.stderr) || null : null; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readYaml(file) { try { return yaml.load(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }

function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch { return '<configured URL>'; }
}

function majorFrom(text) {
  const m = String(text || '').match(/(?:^|\s|v)(\d+)(?:\.\d+){1,2}/);
  return m ? Number(m[1]) : null;
}

function detectStacks(root = PROJECT_ROOT) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const stacks = [];
  if (fs.existsSync(path.join(root, 'android'))) stacks.push('android');
  if (fs.existsSync(path.join(root, 'ios'))) stacks.push('ios');
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) stacks.push('flutter');
  if (deps['react-native']) stacks.push('react-native');
  const frontendDeps = ['react', 'next', 'vite', 'vue', '@angular/core', 'svelte'];
  const frontendDirs = ['frontend', 'web', path.join('apps', 'web')];
  if (frontendDeps.some(d => deps[d]) || frontendDirs.some(d => fs.existsSync(path.join(root, d)))) stacks.push('frontend');
  const nodeBackendDeps = ['express', 'fastify', 'koa', '@nestjs/core', 'hapi'];
  const backendDirs = ['backend', 'server', 'api', path.join('apps', 'api')];
  const pythonBackend = ['requirements.txt', 'pyproject.toml', 'manage.py'].some(f => fs.existsSync(path.join(root, f)));
  if (nodeBackendDeps.some(d => deps[d]) || backendDirs.some(d => fs.existsSync(path.join(root, d))) || pythonBackend) stacks.push('backend');
  if (pythonBackend) stacks.push('backend-python');
  if (nodeBackendDeps.some(d => deps[d])) stacks.push('backend-node');
  return [...new Set(stacks)];
}

function mcpConfig() {
  const projectActual = path.join(PROJECT_ROOT, '.mcp.json');
  const runtimeActual = path.join(ROOT, '.mcp.json');
  const example = path.join(ROOT, '.mcp.json.example');
  const file = fs.existsSync(projectActual) ? projectActual : fs.existsSync(runtimeActual) ? runtimeActual : example;
  return { file, data: readJson(file) || { mcpServers: {} }, usingExample: file === example };
}

function result(id, category, required, ok, detail, remediation, statusOverride) {
  const status = statusOverride || (ok ? 'available' : 'missing');
  return { id, category, required, status, detail, ...(remediation ? { remediation } : {}) };
}
function incompatible(id, category, required, detail, remediation) { return result(id, category, required, false, detail, remediation, 'incompatible'); }
function notApplicable(id, category, detail) { return result(id, category, false, true, detail, null, 'not_applicable'); }
function hasMobile(stacks) { return ['android', 'ios', 'flutter', 'react-native'].some(s => stacks.includes(s)); }
function requiredForArea(scope, area, stacks) {
  if (scope === 'all') { if (area === 'mobile') return hasMobile(stacks); return stacks.includes(area); }
  if (scope === area) return true;
  if (scope === 'auto') return area === 'mobile' && hasMobile(stacks);
  return false;
}
function packageManager(root = PROJECT_ROOT) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function httpConnectivity(url) {
  if (!url || !commandExists('curl')) return { checked: false, ok: false, detail: commandExists('curl') ? 'URL missing' : 'curl unavailable' };
  const r = run('curl', ['-sS', '-L', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '3', '--max-time', '5', url], 7000);
  const code = Number(String(r.stdout || '').trim());
  return { checked: true, ok: r.status === 0 && code >= 100 && code < 600, code: Number.isFinite(code) ? code : 0, detail: code ? `HTTP ${code}` : 'no HTTP response' };
}

function agentChecks(name, command, required) {
  const checks = [];
  const exists = commandExists(command);
  checks.push(result(`agent:${name}`, 'agent', required, exists, exists ? `${command} on PATH` : `${command} not found`, `Install/configure ${name} CLI`));
  if (!exists) return checks;
  const versionResult = run(command, ['--version']);
  checks.push(result(`agent:${name}:version`, 'agent', required, versionResult.ok, versionResult.ok ? firstLine(versionResult.stdout || versionResult.stderr) : 'version command failed', `Upgrade/reinstall ${name} CLI`));
  const authCandidates = name === 'codex' ? [['login', 'status']] : name === 'claude' ? [['auth', 'status']] : [];
  for (const args of authCandidates) {
    const auth = run(command, args, 5000);
    const combined = `${auth.stdout}\n${auth.stderr}`.toLowerCase();
    const explicitAuthFailure = /not logged|not authenticated|login required|authentication required|unauthorized/.test(combined);
    const unsupported = /unknown command|unrecognized|usage:/.test(combined) && !auth.ok;
    if (unsupported) checks.push(result(`agent:${name}:auth`, 'agent', false, false, 'auth-status command unsupported by this CLI version', `Verify ${name} authentication manually`, 'missing'));
    else checks.push(result(`agent:${name}:auth`, 'agent', required && explicitAuthFailure, auth.ok && !explicitAuthFailure, auth.ok ? 'authenticated/status check passed' : explicitAuthFailure ? 'not authenticated' : 'auth status could not be confirmed', `Authenticate ${name} CLI`));
    break;
  }
  return checks;
}

function runChecks(options = {}) {
  const scope = String(options.scope || 'auto').toLowerCase();
  if (!VALID_SCOPES.has(scope)) throw new Error(`invalid doctor scope "${scope}"; use auto, mobile, frontend, backend, or all`);
  const checks = [];
  const stacks = detectStacks(PROJECT_ROOT);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) checks.push(incompatible('node', 'runtime', true, `Node ${process.versions.node}`, 'Install Node.js 20+'));
  else checks.push(result('node', 'runtime', true, true, `Node ${process.versions.node}`));
  const gitOk = commandExists('git');
  checks.push(result('git', 'runtime', true, gitOk, gitOk ? commandOutput('git', ['--version']) || 'git available' : 'git not found', 'Install git'));

  const agents = readYaml(path.join(ROOT, 'ai', 'agents.yaml'));
  for (const [name, spec] of Object.entries(agents)) {
    const cmd = Array.isArray(spec.command) ? spec.command[0] : null;
    if (cmd) checks.push(...agentChecks(name, cmd, name === 'claude' || name === 'codex'));
  }

  const mcp = mcpConfig();
  const discoveredMcps = discoverMcps({ projectRoot: PROJECT_ROOT, runtimeRoot: ROOT });
  checks.push(result('mcp-config', 'mcp', true, !mcp.usingExample, mcp.usingExample ? 'using .mcp.json.example only' : '.mcp.json present', 'Copy .mcp.json.example to .mcp.json and configure required servers'));
  for (const [name, spec] of Object.entries(mcp.data.mcpServers || {})) {
    const required = name === 'codex-delegate';
    if (spec.command) {
      const ok = commandExists(spec.command);
      checks.push(result(`mcp:${name}`, 'mcp', required, ok, ok ? `${spec.command} command available` : `${spec.command} not found`, `Install command required by MCP server ${name}`));
    } else if (spec.url) {
      const safe = sanitizeUrl(spec.url);
      const connection = httpConnectivity(spec.url);
      checks.push(result(`mcp:${name}`, 'mcp', required, connection.checked ? connection.ok : true, connection.checked ? `${safe} · ${connection.detail}` : `${safe} · connectivity not checked`, connection.checked && !connection.ok ? `Check network/auth/configuration for MCP ${name}` : null));
      if (connection.checked && [401, 403].includes(connection.code)) checks.push(result(`mcp:${name}:auth`, 'mcp', false, false, `${safe} reachable but returned HTTP ${connection.code}; credentials may be required`, `Authenticate/configure ${name}`));
    } else checks.push(result(`mcp:${name}`, 'mcp', required, false, 'MCP has neither command nor URL', `Fix MCP configuration for ${name}`));
  }

  const mobileRequired = requiredForArea(scope, 'mobile', stacks);
  if (hasMobile(stacks) || scope === 'mobile' || scope === 'all') {
    const androidRelevant = stacks.includes('android') || stacks.includes('react-native') || stacks.includes('flutter');
    const iosRelevant = stacks.includes('ios') || stacks.includes('react-native') || stacks.includes('flutter');
    if (androidRelevant) {
      const adb = commandExists('adb');
      checks.push(result('android:adb', 'mobile', mobileRequired && (stacks.includes('android') || scope === 'mobile'), adb, adb ? commandOutput('adb', ['version']) || 'adb available' : 'adb not found', 'Install Android platform-tools and add adb to PATH'));
      const sdk = !!(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT);
      checks.push(result('android:sdk', 'mobile', mobileRequired && stacks.includes('android'), sdk, sdk ? 'Android SDK environment configured' : 'ANDROID_HOME/ANDROID_SDK_ROOT not set', 'Configure Android SDK environment'));
      if (adb) {
        const devices = run('adb', ['devices']);
        const count = devices.ok ? devices.stdout.split(/\r?\n/).filter(l => /\tdevice$/.test(l)).length : 0;
        checks.push(result('android:device', 'mobile', false, count > 0, count ? `${count} connected/ready Android device(s)` : 'no ready Android device currently connected', 'Start/connect an emulator/device before mobile evidence'));
      }
    }
    if (stacks.includes('flutter')) {
      const flutter = commandExists('flutter');
      checks.push(result('flutter', 'mobile', mobileRequired, flutter, flutter ? commandOutput('flutter', ['--version']) || 'flutter available' : 'flutter not found', 'Install Flutter SDK and add flutter to PATH'));
    }
    if (iosRelevant) {
      const isMac = process.platform === 'darwin';
      const xcode = isMac && commandExists('xcodebuild');
      checks.push(result('ios:xcodebuild', 'mobile', mobileRequired && stacks.includes('ios'), xcode, xcode ? commandOutput('xcodebuild', ['-version']) || 'xcodebuild available' : isMac ? 'xcodebuild not found' : 'iOS tooling requires macOS', isMac ? 'Install Xcode command-line tools' : 'Run iOS build/device stages on macOS'));
      const simctl = isMac && commandExists('xcrun');
      checks.push(result('ios:simctl', 'mobile', false, simctl, simctl ? 'xcrun/simctl available' : 'xcrun unavailable', 'Install Xcode command-line tools'));
      if (simctl) {
        const sims = run('xcrun', ['simctl', 'list', 'devices', 'available']);
        const count = sims.ok ? sims.stdout.split(/\r?\n/).filter(l => /\([0-9A-F-]{8,}\).*\((?:Booted|Shutdown)\)/i.test(l)).length : 0;
        checks.push(result('ios:simulator', 'mobile', false, sims.ok && count > 0, sims.ok ? `${count} available simulator device(s)` : 'could not enumerate simulators', 'Install an iOS Simulator runtime'));
      }
    }
    const appiumConfigured = hasMcp(discoveredMcps, 'appium');
    const appiumInstalled = discoveredMcps.installed.appiumMcp;
    const appiumDetail = appiumConfigured
      ? 'Appium MCP configured (project or global provider configuration)'
      : appiumInstalled
        ? 'appium-mcp is installed globally but is not configured as an MCP server for this project/provider'
        : 'Appium MCP is not configured';
    const appiumRemediation = appiumInstalled
      ? 'Run agentic init again to add the project MCP entry, or configure appium-mcp in Claude/Codex'
      : 'Run agentic init to add Appium MCP for this mobile project';
    checks.push(result('mcp:appium', 'mobile', mobileRequired, appiumConfigured, appiumDetail, appiumRemediation));
    if ((appiumConfigured || appiumInstalled) && nodeMajor < 22) checks.push(incompatible('appium:node', 'mobile', mobileRequired, `current Node ${process.versions.node}; appium-mcp requires Node 22+`, 'Use a Node 22+ environment for Appium MCP execution'));
  } else checks.push(notApplicable('mobile:project', 'mobile', 'no mobile stack detected'));

  const pkg = readJson(path.join(PROJECT_ROOT, 'package.json')) || {};
  const frontendDetected = stacks.includes('frontend');
  const frontendRequired = requiredForArea(scope, 'frontend', stacks);
  if (frontendDetected || scope === 'frontend' || scope === 'all') {
    const pm = packageManager(PROJECT_ROOT);
    const pmOk = commandExists(pm);
    checks.push(result('frontend:package-manager', 'frontend', frontendRequired, pmOk, `${pm}${pmOk ? ' available' : ' not found'}`, `Install ${pm} or use the repository's configured package manager`));
    const build = !!pkg.scripts?.build;
    checks.push(result('frontend:build-script', 'frontend', frontendRequired && frontendDetected, build, build ? `build command: ${pkg.scripts.build}` : 'no frontend build script detected', 'Add/document the frontend build command'));
    checks.push(result('frontend:test-script', 'frontend', false, !!pkg.scripts?.test, pkg.scripts?.test ? `test command: ${pkg.scripts.test}` : 'no frontend test script detected', 'Add/document frontend tests'));
  } else checks.push(notApplicable('frontend:project', 'frontend', 'no frontend stack detected; frontend prerequisites are optional'));

  const backendDetected = stacks.includes('backend');
  const backendRequired = requiredForArea(scope, 'backend', stacks);
  if (backendDetected || scope === 'backend' || scope === 'all') {
    if (stacks.includes('backend-python') || (scope === 'backend' && !stacks.includes('backend-node'))) {
      const python = commandExists('python3') ? 'python3' : commandExists('python') ? 'python' : null;
      checks.push(result('backend:python', 'backend', backendRequired && stacks.includes('backend-python'), !!python, python ? commandOutput(python, ['--version']) || `${python} available` : 'Python not found', 'Install the Python version required by the backend'));
    }
    if (stacks.includes('backend-node')) {
      const pm = packageManager();
      const ok = commandExists(pm);
      checks.push(result('backend:package-manager', 'backend', backendRequired, ok, `${pm}${ok ? ' available' : ' not found'}`, `Install ${pm} or use the repository's configured package manager`));
    }
    checks.push(result('backend:build-or-test', 'backend', false, !!(pkg.scripts?.build || pkg.scripts?.test), pkg.scripts?.build || pkg.scripts?.test ? 'backend build/test script available' : 'no root backend build/test script detected', 'Document the backend verification command'));
    if (!backendDetected) checks.push(notApplicable('backend:project', 'backend', 'no backend project detected; explicit backend scope cannot infer a project'));
  } else checks.push(notApplicable('backend:project', 'backend', 'no backend stack detected; backend prerequisites are optional'));

  return { generatedAt: new Date().toISOString(), root: PROJECT_ROOT, runtimeRoot: ROOT, scope, stacks, checks };
}

function blockingChecks(report) { return report.checks.filter(c => c.required && c.status !== 'available'); }
function printHuman(report) {
  console.log(`Workflow doctor — scope=${report.scope} — ${report.stacks.length ? report.stacks.join(', ') : 'generic repository'}`);
  for (const check of report.checks) {
    const icon = check.status === 'available' ? '✓' : check.status === 'not_applicable' ? '·' : check.required ? '✗' : '!';
    const req = check.required ? 'required' : 'optional';
    console.log(`${icon} ${check.id.padEnd(28)} ${req.padEnd(8)} ${check.status.padEnd(14)} ${check.detail}`);
    if (['missing', 'incompatible'].includes(check.status) && check.remediation) console.log(`  → ${check.remediation}`);
  }
  const missing = blockingChecks(report);
  console.log(`\n${missing.length ? `BLOCKED: ${missing.length} required capability/capabilities missing or incompatible` : 'READY: required capabilities available'}`);
  return missing.length ? 1 : 0;
}

function selftest() {
  assert.strictEqual(requiredForArea('auto', 'frontend', ['frontend']), false);
  assert.strictEqual(requiredForArea('auto', 'backend', ['backend']), false);
  assert.strictEqual(requiredForArea('auto', 'mobile', ['android']), true);
  assert.strictEqual(requiredForArea('mobile', 'frontend', ['frontend']), false);
  assert.strictEqual(requiredForArea('mobile', 'mobile', []), true);
  assert.strictEqual(requiredForArea('frontend', 'frontend', []), true);
  assert.strictEqual(majorFrom('v22.14.0'), 22);
  assert.strictEqual(sanitizeUrl('https://user:secret@example.com/mcp?token=abc#x'), 'https://example.com/mcp');
  assert.throws(() => runChecks({ scope: 'desktop' }), /invalid doctor scope/);
  console.log('workflow doctor selftest OK');
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.selftest) selftest();
  else {
    const report = runChecks({ scope: args.scope || 'auto' });
    if (args.json) { console.log(JSON.stringify(report, null, 2)); process.exitCode = blockingChecks(report).length ? 1 : 0; }
    else process.exitCode = printHuman(report);
  }
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}

module.exports = { runChecks, detectStacks, requiredForArea, blockingChecks, sanitizeUrl, httpConnectivity, majorFrom };
