#!/usr/bin/env node
'use strict';

// Resolves developer toolchains that are often installed but not active in the
// default shell: a full Xcode when xcode-select points at the Command Line Tools,
// and a Node 22+ install for Appium MCP when the default Node is older.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APPIUM_MIN_NODE = 22;
const APPIUM_PACKAGE = 'appium-mcp@latest';
const IS_WIN = process.platform === 'win32';
const NODE_BIN = IS_WIN ? 'node.exe' : 'node';
const NPX_BIN = IS_WIN ? 'npx.cmd' : 'npx';

function run(command, args, options = {}) {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout || 5000, env: options.env || process.env });
    return { ok: !r.error && r.status === 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
  } catch { return { ok: false, stdout: '', stderr: '' }; }
}

function firstLine(text) { return String(text || '').trim().split(/\r?\n/)[0] || ''; }

function parseVersion(text) {
  const m = String(text || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? { version: `${m[1]}.${m[2]}.${m[3]}`, parts: [Number(m[1]), Number(m[2]), Number(m[3])], major: Number(m[1]) } : null;
}

function compareParts(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => path.join(dir, e.name)); }
  catch { return []; }
}

function whichIn(command, envPath) {
  for (const dir of String(envPath || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Node

const nodeVersionCache = new Map();
function nodeInfo(nodePath, source) {
  if (!nodePath) return null;
  if (!nodeVersionCache.has(nodePath)) {
    const r = fs.existsSync(nodePath) ? run(nodePath, ['-v'], { timeout: 4000 }) : { ok: false };
    nodeVersionCache.set(nodePath, r.ok ? parseVersion(r.stdout) : null);
  }
  const v = nodeVersionCache.get(nodePath);
  return v ? { path: nodePath, binDir: path.dirname(nodePath), version: v.version, parts: v.parts, major: v.major, source } : null;
}

const SYSTEM_PREFIXES = ['/opt/homebrew', '/usr/local'];

function installedNodeBinDirs(env = process.env, home = os.homedir(), systemPrefixes = SYSTEM_PREFIXES) {
  const dirs = [];
  const nvmDirs = [env.NVM_DIR, path.join(home, '.nvm')].filter(Boolean);
  for (const nvm of new Set(nvmDirs)) dirs.push(...listDirs(path.join(nvm, 'versions', 'node')).map(d => path.join(d, 'bin')));
  if (env.NVM_HOME) dirs.push(...listDirs(env.NVM_HOME));
  const fnmDirs = [env.FNM_DIR, path.join(home, '.local', 'share', 'fnm'), path.join(home, 'Library', 'Application Support', 'fnm'), path.join(home, '.fnm')].filter(Boolean);
  for (const fnm of new Set(fnmDirs)) dirs.push(...listDirs(path.join(fnm, 'node-versions')).map(d => path.join(d, 'installation', 'bin')));
  dirs.push(...listDirs(path.join(env.VOLTA_HOME || path.join(home, '.volta'), 'tools', 'image', 'node')).map(d => path.join(d, 'bin')));
  dirs.push(...listDirs(path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'installs', 'nodejs')).map(d => path.join(d, 'bin')));
  for (const prefix of new Set([env.N_PREFIX, ...systemPrefixes].filter(Boolean))) dirs.push(...listDirs(path.join(prefix, 'n', 'versions', 'node')).map(d => path.join(d, 'bin')));
  for (const brew of systemPrefixes) {
    dirs.push(path.join(brew, 'bin'));
    dirs.push(...listDirs(path.join(brew, 'opt')).filter(d => /^node(@\d+)?$/.test(path.basename(d))).map(d => path.join(d, 'bin')));
  }
  if (IS_WIN && env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, 'nodejs'));
  return [...new Set(dirs)];
}

// Picks the Node that should run Node-22+ tools such as appium-mcp, preferring
// what is already active: an explicit override, this process, the PATH node,
// then the newest qualifying installed version.
function findNode(options = {}) {
  const minMajor = options.minMajor || APPIUM_MIN_NODE;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const hasNpx = info => !options.requireNpx || fs.existsSync(path.join(info.binDir, NPX_BIN));
  const ok = info => info && info.major >= minMajor && hasNpx(info) ? info : null;

  const override = env.AGENTIC_APPIUM_NODE;
  if (override) {
    const candidate = fs.existsSync(path.join(override, NODE_BIN)) ? path.join(override, NODE_BIN) : override;
    const info = ok(nodeInfo(candidate, 'AGENTIC_APPIUM_NODE'));
    if (info) return info;
  }
  if (options.includeCurrent !== false) {
    const current = parseVersion(process.version);
    const info = current && ok({ path: process.execPath, binDir: path.dirname(process.execPath), version: current.version, parts: current.parts, major: current.major, source: 'current process' });
    if (info) return info;
  }
  const onPath = ok(nodeInfo(whichIn(NODE_BIN, env.PATH), 'PATH'));
  if (onPath) return onPath;

  let best = null;
  for (const dir of installedNodeBinDirs(env, home, options.systemPrefixes)) {
    const info = ok(nodeInfo(path.join(dir, NODE_BIN), 'installed'));
    if (info && (!best || compareParts(info.parts, best.parts) > 0)) best = info;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Appium MCP

function isAppiumLauncher(spec) {
  if (!spec || typeof spec !== 'object') return false;
  const cmd = path.basename(String(spec.command || '')).replace(/\.(cmd|exe)$/i, '');
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  return cmd === 'agentic' && args[0] === 'mcp' && args[1] === 'appium';
}

function appiumPackageIndex(args) {
  return (args || []).findIndex(a => /^appium-mcp(@.+)?$/.test(String(a)));
}

// Returns the launcher form of an `npx appium-mcp` entry, or null when the entry
// is not the standard npx form (custom commands are left untouched).
function launcherSpecFor(spec) {
  if (!spec || isAppiumLauncher(spec)) return null;
  const cmd = path.basename(String(spec.command || '')).replace(/\.(cmd|exe)$/i, '');
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const idx = appiumPackageIndex(args);
  if (cmd !== 'npx' || idx < 0) return null;
  const pkg = args[idx];
  const launcherArgs = ['mcp', 'appium'];
  if (pkg !== 'appium-mcp' && pkg !== APPIUM_PACKAGE) launcherArgs.push('--package', pkg);
  const rest = args.slice(idx + 1);
  if (rest.length) launcherArgs.push('--', ...rest);
  return { ...spec, command: 'agentic', args: launcherArgs };
}

// Which Node will actually execute appium-mcp for a given MCP server entry.
function appiumRuntime(spec, options = {}) {
  const env = options.env || process.env;
  if (isAppiumLauncher(spec)) {
    const node = findNode({ ...options, minMajor: APPIUM_MIN_NODE, requireNpx: true });
    return { via: 'launcher', label: 'agentic mcp appium', node };
  }
  const command = String(spec?.command || 'npx');
  const envPath = spec?.env?.PATH || env.PATH;
  let nodePath = null;
  if (path.isAbsolute(command)) {
    const sibling = path.join(path.dirname(command), NODE_BIN);
    nodePath = fs.existsSync(sibling) ? sibling : whichIn(NODE_BIN, envPath);
  } else nodePath = whichIn(NODE_BIN, envPath);
  return { via: 'command', label: command, node: nodeInfo(nodePath, 'PATH') };
}

function parseLauncherArgs(argv) {
  const out = { pkg: APPIUM_PACKAGE, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { out.passthrough.push(...argv.slice(i + 1)); break; }
    if (argv[i] === '--package') { out.pkg = argv[++i] || APPIUM_PACKAGE; continue; }
    out.passthrough.push(argv[i]);
  }
  return out;
}

// Plan for `agentic mcp appium`: run `npx -y <pkg>` from a Node 22+ bin dir,
// with that bin dir first on PATH so npx and appium-mcp both use it. Peer deps
// are forced on because React Native projects often set legacy-peer-deps in
// .npmrc, which leaves the Appium drivers without their `appium` peer.
function appiumLaunchPlan(argv, options = {}) {
  const env = options.env || process.env;
  const node = findNode({ ...options, env, minMajor: APPIUM_MIN_NODE, requireNpx: true });
  if (!node) return { error: `appium-mcp requires Node ${APPIUM_MIN_NODE}+ and none was found (current ${process.version}). Install one (e.g. \`nvm install ${APPIUM_MIN_NODE}\`) or set AGENTIC_APPIUM_NODE to a Node ${APPIUM_MIN_NODE}+ binary.` };
  const { pkg, passthrough } = parseLauncherArgs(argv);
  return {
    node,
    command: path.join(node.binDir, NPX_BIN),
    args: ['-y', pkg, ...passthrough],
    env: { ...env, PATH: [node.binDir, env.PATH].filter(Boolean).join(path.delimiter), npm_config_legacy_peer_deps: 'false' },
  };
}

// ---------------------------------------------------------------------------
// Flutter

function flutterBin(binDir) {
  const bin = path.join(binDir, IS_WIN ? 'flutter.bat' : 'flutter');
  return fs.existsSync(bin) ? bin : null;
}

const flutterVersionCache = new Map();
// Only the doctor needs this: `flutter --version` can compile the tool on first
// run, so it is far too slow for the per-command environment setup.
function flutterVersion(bin) {
  if (!flutterVersionCache.has(bin)) {
    const r = run(bin, ['--version', '--suppress-analytics'], { timeout: 90000 });
    const m = `${r.stdout}${r.stderr}`.match(/Flutter\s+(\d+\.\d+\.\d+)/);
    flutterVersionCache.set(bin, r.ok && m ? m[1] : null);
  }
  return flutterVersionCache.get(bin);
}

function flutterCandidates(env, home) {
  const dirs = [];
  if (env.FLUTTER_ROOT) dirs.push(path.join(env.FLUTTER_ROOT, 'bin'));
  for (const base of ['develop/flutter', 'flutter', 'sdk/flutter', 'Development/flutter', 'src/flutter',
    'fvm/default', 'Library/flutter', 'Applications/flutter', 'tools/flutter']) {
    dirs.push(path.join(home, ...base.split('/'), 'bin'));
  }
  dirs.push(...listDirs(path.join(home, '.puro', 'envs')).map(d => path.join(d, 'flutter', 'bin')));
  dirs.push(...listDirs(path.join(home, 'fvm', 'versions')).map(d => path.join(d, 'bin')));
  for (const prefix of ['/opt/homebrew', '/usr/local', '/opt']) dirs.push(path.join(prefix, 'flutter', 'bin'));
  return [...new Set(dirs)];
}

// Flutter is commonly unpacked into a home directory and never added to PATH.
// `source` is PATH when the user's own shell finds it, otherwise discovered.
// Filesystem only, so it is cheap enough to run for every command.
function locateFlutter(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const onPath = whichIn(IS_WIN ? 'flutter.bat' : 'flutter', env.PATH);
  // PATH may be one agentic injected itself; the user's shell still cannot find it.
  if (onPath) return { bin: onPath, binDir: path.dirname(onPath), source: env.AGENTIC_FLUTTER_DISCOVERED === '1' ? 'discovered' : 'PATH' };
  for (const dir of flutterCandidates(env, home)) {
    const bin = flutterBin(dir);
    if (bin) return { bin, binDir: dir, source: 'discovered' };
  }
  return null;
}

function resolveFlutter(options = {}) {
  const found = locateFlutter(options);
  return found ? { ...found, version: flutterVersion(found.bin) } : null;
}

// ---------------------------------------------------------------------------
// Xcode

function isFullXcodeDeveloperDir(dir) {
  return !!dir && /\.app[\\/]Contents[\\/]Developer[\\/]?$/.test(dir) && fs.existsSync(path.join(dir, 'usr', 'bin', 'xcodebuild'));
}

function xcodeAppVersion(app) {
  const r = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')], { timeout: 3000 });
  return r.ok ? firstLine(r.stdout) : null;
}

function candidateXcodeApps(home) {
  const apps = new Set();
  const found = run('mdfind', ["kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"], { timeout: 5000 });
  if (found.ok) for (const line of found.stdout.split(/\r?\n/)) if (line.trim()) apps.add(line.trim());
  for (const dir of ['/Applications', path.join(home, 'Applications'), path.join(home, 'Desktop'), path.join(home, 'Downloads')]) {
    for (const entry of listDirs(dir)) if (/^Xcode.*\.app$/.test(path.basename(entry))) apps.add(entry);
  }
  return [...apps].filter(app => !/[\\/]\.Trash[\\/]/.test(app));
}

let xcodeCache;
// Where Xcode tools should come from. `source` is DEVELOPER_DIR, xcode-select or
// discovered (a full Xcode exists but xcode-select points somewhere unusable).
function resolveXcode(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return null;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const useCache = !options.env && !options.home;
  if (useCache && xcodeCache !== undefined) return xcodeCache;

  let result = null;
  // xcode-select -p echoes DEVELOPER_DIR when set; ask for the system selection.
  const systemEnv = { ...process.env };
  delete systemEnv.DEVELOPER_DIR;
  const selectedRun = run('xcode-select', ['-p'], { timeout: 3000, env: systemEnv });
  const selected = selectedRun.ok ? firstLine(selectedRun.stdout) : null;
  // A DEVELOPER_DIR that agentic itself injected still counts as discovered.
  if (env.DEVELOPER_DIR && env.AGENTIC_XCODE_DISCOVERED === '1') result = { developerDir: env.DEVELOPER_DIR, source: 'discovered', selected, valid: isFullXcodeDeveloperDir(env.DEVELOPER_DIR) };
  else if (env.DEVELOPER_DIR) result = { developerDir: env.DEVELOPER_DIR, source: 'DEVELOPER_DIR', selected, valid: isFullXcodeDeveloperDir(env.DEVELOPER_DIR) };
  else if (isFullXcodeDeveloperDir(selected)) result = { developerDir: selected, source: 'xcode-select', selected, valid: true };
  else {
    const apps = candidateXcodeApps(home)
      .filter(app => isFullXcodeDeveloperDir(path.join(app, 'Contents', 'Developer')))
      .map(app => ({ app, version: xcodeAppVersion(app) || '0' }))
      .sort((a, b) => (b.app === '/Applications/Xcode.app') - (a.app === '/Applications/Xcode.app') || compareParts(b.version.split('.').map(Number), a.version.split('.').map(Number)));
    if (apps.length) result = { developerDir: path.join(apps[0].app, 'Contents', 'Developer'), source: 'discovered', selected, valid: true };
    else result = { developerDir: null, source: 'none', selected, valid: false };
  }
  if (result.developerDir) result.app = result.developerDir.replace(/[\\/]Contents[\\/]Developer[\\/]?$/, '');
  if (useCache) xcodeCache = result;
  return result;
}

// Extra environment for runtime subprocesses so Xcode tools work when a full
// Xcode is installed but not selected. Never overrides an explicit DEVELOPER_DIR.
function toolchainEnv(env = process.env, options = {}) {
  const extra = {};
  if (!env.DEVELOPER_DIR && process.platform === 'darwin') {
    const xcode = resolveXcode();
    if (xcode && xcode.source === 'discovered') {
      extra.DEVELOPER_DIR = xcode.developerDir;
      extra.AGENTIC_XCODE_DISCOVERED = '1';
    }
  }
  // An installed but unlisted Flutter SDK is put on PATH for agentic's own runs.
  const flutter = locateFlutter({ env, home: options.home });
  if (flutter && flutter.source === 'discovered') {
    extra.PATH = [flutter.binDir, env.PATH].filter(Boolean).join(path.delimiter);
    extra.AGENTIC_FLUTTER_DISCOVERED = '1';
  }
  return extra;
}

// ---------------------------------------------------------------------------

function selftest() {
  assert.deepStrictEqual(parseVersion('v22.22.0').parts, [22, 22, 0]);
  assert.strictEqual(parseVersion('garbage'), null);
  assert(compareParts([22, 1, 0], [20, 19, 4]) > 0);

  const standard = { type: 'stdio', command: 'npx', args: ['-y', 'appium-mcp@latest'], timeout: 100, env: { A: '1' } };
  const migrated = launcherSpecFor(standard);
  assert.deepStrictEqual(migrated, { type: 'stdio', command: 'agentic', args: ['mcp', 'appium'], timeout: 100, env: { A: '1' } });
  assert.strictEqual(isAppiumLauncher(migrated), true);
  assert.strictEqual(launcherSpecFor(migrated), null, 'launcher entries are already migrated');
  assert.deepStrictEqual(launcherSpecFor({ command: 'npx', args: ['-y', 'appium-mcp@1.2.3', '--log', 'x'] }).args, ['mcp', 'appium', '--package', 'appium-mcp@1.2.3', '--', '--log', 'x']);
  assert.strictEqual(launcherSpecFor({ command: '/custom/appium-wrapper' }), null, 'custom commands are left alone');
  assert.deepStrictEqual(parseLauncherArgs(['--package', 'appium-mcp@1.2.3', '--', '--log', 'x']), { pkg: 'appium-mcp@1.2.3', passthrough: ['--log', 'x'] });
  assert.deepStrictEqual(parseLauncherArgs([]), { pkg: APPIUM_PACKAGE, passthrough: [] });

  // Fake nvm tree: an old default Node on PATH and a Node 22 install elsewhere.
  if (!IS_WIN) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-toolchain-'));
    const fakeNode = (dir, version) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh\necho v${version}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'npx'), '#!/bin/sh\n', { mode: 0o755 });
    };
    const oldBin = path.join(temp, '.nvm', 'versions', 'node', 'v20.19.4', 'bin');
    const newBin = path.join(temp, '.nvm', 'versions', 'node', 'v22.22.0', 'bin');
    const midBin = path.join(temp, '.nvm', 'versions', 'node', 'v22.21.1', 'bin');
    const noNpxBin = path.join(temp, '.nvm', 'versions', 'node', 'v23.0.0', 'bin');
    fakeNode(oldBin, '20.19.4'); fakeNode(newBin, '22.22.0'); fakeNode(midBin, '22.21.1'); fakeNode(noNpxBin, '23.0.0');
    fs.rmSync(path.join(noNpxBin, 'npx'));
    const env = { PATH: `${oldBin}${path.delimiter}/usr/bin${path.delimiter}/bin`, NVM_DIR: path.join(temp, '.nvm') };
    const opts = { env, home: temp, includeCurrent: false, systemPrefixes: [] };

    assert.strictEqual(findNode(opts).version, '23.0.0', 'newest installed Node 22+ wins when PATH node is too old');
    assert.strictEqual(findNode({ ...opts, requireNpx: true }).version, '22.22.0', 'installs without npx are skipped for launchers');
    const direct = appiumRuntime(standard, opts);
    assert.strictEqual(direct.node.version, '20.19.4', 'raw npx entry runs on the PATH node');
    const launched = appiumRuntime(migrated, opts);
    assert.strictEqual(launched.node.version, '22.22.0', 'launcher entry runs on Node 22+');
    const plan = appiumLaunchPlan([], opts);
    assert.strictEqual(plan.command, path.join(newBin, 'npx'));
    assert.deepStrictEqual(plan.args, ['-y', APPIUM_PACKAGE]);
    assert(plan.env.PATH.startsWith(newBin + path.delimiter), 'Node 22 bin dir is first on PATH for appium-mcp');
    assert.strictEqual(plan.env.npm_config_legacy_peer_deps, 'false', 'project legacy-peer-deps must not strip the appium peer');

    const onlyOld = { env: { PATH: oldBin, NVM_DIR: path.join(temp, 'none') }, home: path.join(temp, 'none'), includeCurrent: false, systemPrefixes: [] };
    assert.strictEqual(findNode(onlyOld), null);
    assert.match(appiumLaunchPlan([], onlyOld).error, /requires Node 22\+/);
    fs.rmSync(temp, { recursive: true, force: true });
  }

  assert.strictEqual(resolveXcode({ platform: 'linux' }), null);
  if (process.platform === 'darwin') {
    const explicit = resolveXcode({ env: { DEVELOPER_DIR: '/nonexistent/Xcode.app/Contents/Developer' }, home: os.tmpdir() });
    assert.strictEqual(explicit.source, 'DEVELOPER_DIR');
    assert.strictEqual(explicit.valid, false);
    const injected = resolveXcode({ env: { DEVELOPER_DIR: '/nonexistent/Xcode.app/Contents/Developer', AGENTIC_XCODE_DISCOVERED: '1' }, home: os.tmpdir() });
    assert.strictEqual(injected.source, 'discovered', 'a DEVELOPER_DIR injected by agentic keeps the xcode-select warning');
  }
  // Flutter: a fake SDK in a home directory is found without being on PATH.
  if (!IS_WIN) {
    const fhome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-flutter-'));
    const sdkBin = path.join(fhome, 'develop', 'flutter', 'bin');
    fs.mkdirSync(sdkBin, { recursive: true });
    fs.writeFileSync(path.join(sdkBin, 'flutter'), '#!/bin/sh\necho "Flutter 3.47.5 • channel stable"\n', { mode: 0o755 });
    const bare = { PATH: '/nonexistent-bin' };
    const found = resolveFlutter({ env: bare, home: fhome });
    assert.strictEqual(found.version, '3.47.5');
    assert.strictEqual(found.source, 'discovered');
    assert.strictEqual(found.binDir, sdkBin);
    const env = toolchainEnv(bare, { home: fhome });
    assert.strictEqual(resolveFlutter({ env: { PATH: sdkBin }, home: fhome }).source, 'PATH', 'an SDK already on PATH is left alone');
    assert.strictEqual(resolveFlutter({ env: { PATH: sdkBin, AGENTIC_FLUTTER_DISCOVERED: '1' }, home: fhome }).source, 'discovered', 'a PATH agentic injected keeps the warning');
    assert.strictEqual(env.PATH.split(path.delimiter)[0], sdkBin, 'the discovered SDK leads PATH for agentic runs');
    assert.strictEqual(env.AGENTIC_FLUTTER_DISCOVERED, '1');
    assert.strictEqual(resolveFlutter({ env: bare, home: path.join(fhome, 'empty') }), null, 'no SDK, no result');
    fs.rmSync(fhome, { recursive: true, force: true });
    assert.ok(env, 'toolchainEnv tolerates a home without an SDK');
  }

  const explicitXcode = toolchainEnv({ DEVELOPER_DIR: '/x', PATH: process.env.PATH });
  assert.strictEqual(explicitXcode.DEVELOPER_DIR, undefined, 'explicit DEVELOPER_DIR is never overridden');
  console.log('toolchain selftest OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else console.log(JSON.stringify({ xcode: resolveXcode(), node22: findNode(), toolchainEnv: toolchainEnv() }, null, 2));
}

module.exports = {
  APPIUM_MIN_NODE,
  APPIUM_PACKAGE,
  parseVersion,
  findNode,
  isAppiumLauncher,
  launcherSpecFor,
  appiumRuntime,
  appiumLaunchPlan,
  resolveXcode,
  locateFlutter,
  resolveFlutter,
  toolchainEnv,
};
