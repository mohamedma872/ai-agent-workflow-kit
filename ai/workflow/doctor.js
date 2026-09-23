#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { runtimeRoot, projectRoot } = require('./paths');
const { discoverMcps, hasMcp } = require('./mcp-discovery');
const { APPIUM_MIN_NODE, appiumRuntime, findNode, isAppiumLauncher, launcherSpecFor, resolveFlutter, resolveXcode } = require('./toolchain');

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

function run(command, args = [], timeout = 5000, env = process.env) {
  try {
    const res = spawnSync(command, args, { encoding: 'utf8', timeout, env });
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

// A web app directory only counts with its own package.json: Flutter's web/ is a
// build target, not a JavaScript app.
const WEB_APP_DIRS = ['frontend', 'web', path.join('apps', 'web')];
function hasWebAppDir(root) {
  return WEB_APP_DIRS.some(dir => fs.existsSync(path.join(root, dir, 'package.json')));
}

function detectStacks(root = PROJECT_ROOT) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const stacks = [];
  if (fs.existsSync(path.join(root, 'android'))) stacks.push('android');
  if (fs.existsSync(path.join(root, 'ios'))) stacks.push('ios');
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) stacks.push('flutter');
  if (deps['react-native']) stacks.push('react-native');
  // React Native apps depend on react too; like engine.js, only a web dependency
  // outside React Native (or a web app directory) makes the repo a frontend.
  const frontendDeps = ['react', 'next', 'vite', 'vue', '@angular/core', 'svelte'];
  if ((!deps['react-native'] && frontendDeps.some(d => deps[d])) || hasWebAppDir(root)) stacks.push('frontend');
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

function tildify(p) { const h = os.homedir(); return p && p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p; }

// Xcode tools are resolved through the same developer directory agentic exports
// to its runs, so a full Xcode that is installed but not selected still counts.
function iosChecks(xcodeRequired) {
  const checks = [];
  if (process.platform !== 'darwin') {
    checks.push(result('ios:xcodebuild', 'mobile', xcodeRequired, false, 'iOS tooling requires macOS', 'Run iOS build/device stages on macOS'));
    return checks;
  }
  const xcode = resolveXcode();
  if (!xcode.developerDir || !xcode.valid) {
    const detail = xcode.source === 'DEVELOPER_DIR'
      ? `DEVELOPER_DIR=${xcode.developerDir} is not a full Xcode developer directory`
      : `no full Xcode found (xcode-select points to ${xcode.selected || 'nothing'})`;
    checks.push(result('ios:xcodebuild', 'mobile', xcodeRequired, false, detail, xcode.source === 'DEVELOPER_DIR' ? 'Point DEVELOPER_DIR at <Xcode.app>/Contents/Developer or unset it' : 'Install Xcode from the App Store or developer.apple.com'));
    return checks;
  }
  const env = { ...process.env, DEVELOPER_DIR: xcode.developerDir };
  const where = tildify(xcode.app);
  const version = run('xcodebuild', ['-version'], 15000, env);
  const versionText = version.ok ? firstLine(version.stdout).replace(/\s+/g, ' ') : null;
  checks.push(result('ios:xcodebuild', 'mobile', xcodeRequired, version.ok, version.ok ? `${versionText} at ${where}` : `xcodebuild failed: ${firstLine(version.stderr) || 'no output'}`, 'Open Xcode once to finish installing components, then accept the license (sudo xcodebuild -license accept)'));
  if (xcode.source === 'discovered') {
    checks.push(incompatible('ios:xcode-select', 'mobile', false, `xcode-select points to ${xcode.selected || 'nothing'}; agentic runs use DEVELOPER_DIR=${tildify(xcode.developerDir)}, but Xcode tools run outside agentic will fail`, `sudo xcode-select -s "${xcode.developerDir}"`));
  }
  const simctl = run('xcrun', ['--find', 'simctl'], 10000, env);
  checks.push(result('ios:simctl', 'mobile', false, simctl.ok, simctl.ok ? 'xcrun/simctl available' : `simctl not found: ${firstLine(simctl.stderr) || 'xcrun failed'}`, 'Install Xcode (simctl ships with Xcode, not the Command Line Tools)'));
  if (simctl.ok) {
    const sims = run('xcrun', ['simctl', 'list', 'devices', 'available'], 30000, env);
    const count = sims.ok ? sims.stdout.split(/\r?\n/).filter(l => /\([0-9A-F-]{8,}\).*\((?:Booted|Shutdown)\)/i.test(l)).length : 0;
    checks.push(result('ios:simulator', 'mobile', false, sims.ok && count > 0, sims.ok ? `${count} available simulator device(s)` : `could not enumerate simulators: ${firstLine(sims.stderr) || 'simctl timed out'}`, 'Install an iOS Simulator runtime (Xcode → Settings → Components)'));
  }
  return checks;
}

// A Flutter SDK unpacked into a home directory counts as installed: agentic puts
// it on PATH for its own runs and says how to make the shell find it too.
function flutterChecks(required) {
  const flutter = resolveFlutter();
  if (!flutter) return [result('flutter', 'mobile', required, false, 'flutter not found on PATH or in the usual SDK locations', 'Install the Flutter SDK (flutter.dev/docs/get-started/install) and add its bin directory to PATH')];
  const label = flutter.version ? `Flutter ${flutter.version}` : 'flutter available';
  const checks = [result('flutter', 'mobile', required, true, `${label} at ${tildify(path.dirname(flutter.binDir))}`)];
  if (flutter.source === 'discovered') {
    checks.push(incompatible('flutter:path', 'mobile', false, `${flutter.binDir.includes(os.homedir()) ? tildify(flutter.binDir) : flutter.binDir} is not on PATH; agentic adds it for its own runs, but flutter commands you run yourself will fail`, `export PATH="${flutter.binDir}:$PATH"  # add to ~/.zshrc`));
  }
  return checks;
}

// Checks the Node that will actually execute appium-mcp for the configured
// entry, not the Node that happens to run doctor.
function appiumNodeCheck(entry, required) {
  const runtime = appiumRuntime(entry?.spec);
  const node = runtime.node;
  if (node && node.major >= APPIUM_MIN_NODE) {
    const how = runtime.via === 'launcher' ? `via agentic launcher (${node.source === 'installed' ? tildify(node.binDir) : node.source})` : `via ${runtime.label}`;
    return result('appium:node', 'mobile', required, true, `appium-mcp runs on Node ${node.version} ${how}`);
  }
  const installed = findNode({ minMajor: APPIUM_MIN_NODE, requireNpx: true });
  const current = runtime.via === 'launcher'
    ? `agentic launcher found no Node ${APPIUM_MIN_NODE}+`
    : `appium-mcp starts via "${runtime.label}" on ${node ? `Node ${node.version}` : 'an unknown Node'}`;
  if (!installed) return incompatible('appium:node', 'mobile', required, `${current}; appium-mcp requires Node ${APPIUM_MIN_NODE}+ and none is installed`, `Install Node ${APPIUM_MIN_NODE}+ (e.g. nvm install ${APPIUM_MIN_NODE}); the agentic launcher picks it up without changing your default Node`);
  const fixable = entry && !isAppiumLauncher(entry.spec) && launcherSpecFor(entry.spec);
  return incompatible('appium:node', 'mobile', required, `${current}; Node ${installed.version} is installed at ${tildify(installed.binDir)} but not used`, fixable
    ? 'Run agentic init to switch appium-mcp to the agentic launcher (agentic mcp appium), which runs it on the installed Node 22+'
    : `Point the ${entry?.name || 'appium'} MCP entry at "agentic" with args ["mcp", "appium"], or at ${tildify(path.join(installed.binDir, 'npx'))}`);
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
    if (stacks.includes('flutter')) checks.push(...flutterChecks(mobileRequired));
    if (iosRelevant) checks.push(...iosChecks(mobileRequired && stacks.includes('ios')));
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
    if (appiumConfigured || appiumInstalled) checks.push(appiumNodeCheck(discoveredMcps.specs.get('appium'), mobileRequired));
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

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-stacks-'));
  const writePkg = deps => fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ dependencies: deps }));
  fs.mkdirSync(path.join(temp, 'ios'));
  writePkg({ react: '19.0.0', 'react-native': '0.80.0' });
  assert(!detectStacks(temp).includes('frontend'), 'a React Native app is not a web frontend');
  assert(detectStacks(temp).includes('react-native'));
  fs.mkdirSync(path.join(temp, 'web'));
  fs.writeFileSync(path.join(temp, 'web', 'index.html'), '<html></html>');
  assert(!detectStacks(temp).includes('frontend'), "Flutter's web/ build target is not a JavaScript frontend");
  fs.writeFileSync(path.join(temp, 'web', 'package.json'), '{}');
  assert(detectStacks(temp).includes('frontend'), 'a web/ app with its own package.json is a frontend');
  fs.rmSync(path.join(temp, 'web'), { recursive: true });
  writePkg({ react: '19.0.0', 'react-dom': '19.0.0' });
  assert(detectStacks(temp).includes('frontend'), 'a React web app is a frontend');
  fs.rmSync(temp, { recursive: true, force: true });

  const launcher = appiumNodeCheck({ name: 'appium-mcp', spec: { command: 'agentic', args: ['mcp', 'appium'] } }, true);
  if (findNode({ minMajor: APPIUM_MIN_NODE, requireNpx: true })) assert.strictEqual(launcher.status, 'available', 'launcher entry passes when any Node 22+ is installed');
  else assert.strictEqual(launcher.status, 'incompatible');
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
