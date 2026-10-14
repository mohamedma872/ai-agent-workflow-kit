#!/usr/bin/env node
'use strict';

// Deterministic ground truth for a branch impact analysis.
//
// Compares a head ref with its merge base (and, optionally, a production branch
// such as master) and writes the numbers every impact specialist shares:
// rename-aware change classification, source/generated/test sizes, stack
// pattern counts, dependency-lock changes, and the production commits the
// branch does not contain (with the files they touch that no longer exist at
// head — fixes at risk of being silently lost at merge).
//
// Output: <state>/<run-id>/impact/{baseline.json,baseline.md,namestatus.txt}
// plus read-only worktrees <state>/<run-id>/impact/worktrees/{base,head}.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { stateRoot, projectRoot } = require('./paths');

const GENERATED = /\.(g|freezed|config|gr|mocks|pb|pbenum|pbjson|pbserver)\.dart$|\.generated\.(ts|js)$|\.d\.ts$/;
const TEST_FILE = /(_test\.dart|\.(test|spec)\.[jt]sx?|Test\.kt|Tests?\.swift|Test\.java)$/;
const SOURCE_EXT = /\.(dart|kt|kts|java|swift|m|mm|ts|tsx|js|jsx)$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', '.dart_tool', 'Pods', '.gradle', 'dist', '.agentic-runs', '.ai-worktrees', 'ephemeral']);

// File-count patterns per stack. Counts are files containing the pattern in
// non-generated source, base vs head — signals for the specialists, not verdicts.
const PATTERNS = {
  flutter: [
    ['Provider / context.watch', /Provider\.of|context\.read|context\.watch|Consumer</],
    ['ChangeNotifier', /ChangeNotifier/],
    ['Bloc / Cubit classes', /extends (Cubit|Bloc)</],
    ['Bloc widgets', /BlocBuilder|BlocProvider|BlocListener|BlocConsumer|BlocSelector/],
    ['Service locator (get_it)', /GetIt|getIt|locator</],
    ['setState', /setState\(/],
    ['Navigator.*', /Navigator\.(push|of|pop)/],
    ['GoRouter', /GoRouter|GoRoute\(|context\.go\(|context\.push\(/],
    ['Raw http', /http\.(get|post|put|delete)\(|http\.Client/],
    ['Dio', /Dio\(/],
    ['SharedPreferences', /SharedPreferences/],
    ['Hive', /Hive\.|HiveInterface|Box</],
    ['MethodChannel / EventChannel', /MethodChannel|EventChannel/],
    ['catch blocks', /catch \(/],
    ['print / debugPrint', /\bprint\(|debugPrint\(/],
    ['dynamic', /\bdynamic\b/],
    ['TODO / FIXME', /TODO|FIXME/],
  ],
  'react-native': [
    ['useState', /useState\(/],
    ['Redux / Zustand', /useSelector|useDispatch|create\(\(set/],
    ['fetch / axios', /fetch\(|axios\./],
    ['AsyncStorage', /AsyncStorage/],
    ['navigation.navigate', /navigation\.navigate|router\.push/],
    ['NativeModules', /NativeModules|TurboModuleRegistry/],
    ['console.log', /console\.log/],
    ['any', /:\s*any\b/],
    ['catch blocks', /catch \(/],
  ],
  android: [
    ['GlobalScope / runBlocking', /GlobalScope|runBlocking/],
    ['catch (e: Exception)', /catch \(\w+: Exception\)/],
    ['MethodChannel', /MethodChannel|EventChannel/],
    ['Log.*', /Log\.[dewiv]\(/],
  ],
  ios: [
    ['strong self in closures', /\{\s*\[?\s*self\b|self\.\w+\s*=\s*\{/],
    ['force unwrap / cast', /as!|!\./],
    ['FlutterMethodChannel', /FlutterMethodChannel|FlutterEventChannel/],
    ['print / NSLog', /\bprint\(|NSLog\(/],
  ],
};

function git(repo, args, opts = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function detectStacks(root) {
  const stacks = [];
  const pkg = path.join(root, 'package.json');
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) stacks.push('flutter');
  if (fs.existsSync(pkg) && /"react-native"/.test(fs.readFileSync(pkg, 'utf8'))) stacks.push('react-native');
  if (fs.existsSync(path.join(root, 'android'))) stacks.push('android');
  if (fs.existsSync(path.join(root, 'ios'))) stacks.push('ios');
  return stacks;
}

function sourceRoots(root, stacks) {
  const roots = [];
  if (stacks.includes('flutter')) roots.push('lib');
  if (stacks.includes('react-native')) roots.push('src', 'app');
  if (!roots.length) roots.push('src', 'lib', 'app');
  return roots.filter(r => fs.existsSync(path.join(root, r)));
}

function countLines(file) {
  try {
    const buf = fs.readFileSync(file);
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return n;
  } catch { return 0; }
}

function snapshot(root, stacks) {
  const files = sourceRoots(root, stacks).flatMap(r => walk(path.join(root, r))).filter(f => SOURCE_EXT.test(f));
  const generated = files.filter(f => GENERATED.test(f));
  const handwritten = files.filter(f => !GENERATED.test(f) && !TEST_FILE.test(f));
  const tests = walk(root).filter(f => TEST_FILE.test(f) && !/node_modules/.test(f));
  const patterns = {};
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const appTexts = handwritten.map(read);
  // Native stacks are scanned in their own folders; app stacks in the app source roots.
  const NATIVE = { android: /\.(kt|kts|java)$/, ios: /\.(swift|m|mm)$/ };
  for (const stack of stacks) {
    const texts = NATIVE[stack]
      ? walk(path.join(root, stack)).filter(f => NATIVE[stack].test(f) && !GENERATED.test(f)).map(read)
      : appTexts;
    for (const [name, rx] of PATTERNS[stack] || []) {
      patterns[`${stack}: ${name}`] = texts.reduce((n, t) => n + (rx.test(t) ? 1 : 0), 0);
    }
  }
  const topDirs = {};
  for (const r of sourceRoots(root, stacks)) {
    for (const f of handwritten.filter(x => x.startsWith(path.join(root, r) + path.sep))) {
      const rel = path.relative(path.join(root, r), f).split(path.sep);
      const key = `${r}/${rel.length > 1 ? rel[0] : '(root)'}`;
      topDirs[key] = (topDirs[key] || 0) + 1;
    }
  }
  return {
    sourceFiles: files.length,
    handwrittenFiles: handwritten.length,
    handwrittenLoc: handwritten.reduce((n, f) => n + countLines(f), 0),
    generatedFiles: generated.length,
    generatedLoc: generated.reduce((n, f) => n + countLines(f), 0),
    testFiles: tests.length,
    patterns,
    topDirs,
  };
}

function parseLock(root) {
  const pub = path.join(root, 'pubspec.lock');
  const npm = path.join(root, 'package-lock.json');
  const pkgs = {};
  if (fs.existsSync(pub)) {
    const text = fs.readFileSync(pub, 'utf8');
    const rx = /^ {2}([a-z0-9_]+):\n(?:(?: {4}.*)\n)*? {4}version: "([^"]+)"/gm;
    let m;
    while ((m = rx.exec(text))) pkgs[m[1]] = m[2];
    return { file: 'pubspec.lock', pkgs };
  }
  if (fs.existsSync(npm)) {
    try {
      const j = JSON.parse(fs.readFileSync(npm, 'utf8'));
      for (const [k, v] of Object.entries(j.packages || {})) if (k) pkgs[k.replace(/^.*node_modules\//, '')] = v.version;
    } catch { /* unreadable lock */ }
    return { file: 'package-lock.json', pkgs };
  }
  return { file: null, pkgs };
}

function lockDiff(baseRoot, headRoot) {
  const a = parseLock(baseRoot), b = parseLock(headRoot);
  const added = [], removed = [], changed = [];
  for (const [k, v] of Object.entries(b.pkgs)) {
    if (!(k in a.pkgs)) added.push(`${k} ${v}`);
    else if (a.pkgs[k] !== v) changed.push(`${k} ${a.pkgs[k]} -> ${v}`);
  }
  for (const k of Object.keys(a.pkgs)) if (!(k in b.pkgs)) removed.push(k);
  return { file: b.file || a.file, before: Object.keys(a.pkgs).length, after: Object.keys(b.pkgs).length, added, removed, changed };
}

function classify(repo, base, head) {
  const raw = git(repo, ['-c', 'diff.renameLimit=20000', 'diff', '-M', '--name-status', base, head]);
  const lines = raw ? raw.split('\n') : [];
  const counts = { A: 0, D: 0, M: 0, R: 0, other: 0 };
  const byExt = {};
  for (const line of lines) {
    const [status, ...paths] = line.split('\t');
    const k = status[0];
    if (k in counts) counts[k]++; else counts.other++;
    const file = paths[paths.length - 1] || '';
    const ext = (file.match(/\.([a-z0-9]+)$/i) || [, '(none)'])[1];
    byExt[ext] = (byExt[ext] || 0) + 1;
  }
  const short = git(repo, ['diff', '--shortstat', base, head]);
  return { lines, counts, byExt, shortstat: short };
}

// Production commits the head does not contain, and which of their files no
// longer exist at head (moved/renamed/deleted): those fixes must be ported by hand.
function productionDrift(repo, mergeBase, head, prod) {
  if (!prod) return null;
  const shas = git(repo, ['rev-list', '--no-merges', `${head}..${prod}`, '--not', mergeBase], { allowFail: true }).split('\n').filter(Boolean);
  const commits = [];
  for (const sha of shas) {
    const subject = git(repo, ['log', '-1', '--format=%s', sha]);
    const files = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean);
    const missing = files.filter(f => spawnSync('git', ['-C', repo, 'cat-file', '-e', `${head}:${f}`]).status !== 0);
    commits.push({ sha: sha.slice(0, 9), subject, files: files.length, missingAtHead: missing });
  }
  return { prod, commits: commits.length, atRisk: commits.filter(c => c.missingAtHead.length), all: commits };
}

function ensureWorktree(repo, dir, ref) {
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, ['worktree', 'add', '--force', '--detach', dir, ref]);
  return dir;
}

function build({ repo, base, head, prod, outDir, worktrees = true }) {
  const headSha = git(repo, ['rev-parse', head]);
  const mergeBase = git(repo, ['merge-base', base, head]);
  const ahead = Number(git(repo, ['rev-list', '--count', `${mergeBase}..${headSha}`]));
  const behind = prod ? Number(git(repo, ['rev-list', '--count', `${headSha}..${prod}`], { allowFail: true }) || 0) : null;
  const diff = classify(repo, mergeBase, headSha);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'namestatus.txt'), diff.lines.join('\n') + '\n');
  let baseRoot = null, headRoot = null;
  if (worktrees) {
    baseRoot = ensureWorktree(repo, path.join(outDir, 'worktrees', 'base'), mergeBase);
    headRoot = ensureWorktree(repo, path.join(outDir, 'worktrees', 'head'), headSha);
  }
  const stacks = detectStacks(headRoot || repo);
  const data = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo,
    refs: { base, head, prod: prod || null, headSha, mergeBase, ahead, behindProduction: behind },
    worktrees: { base: baseRoot, head: headRoot },
    stacks,
    changes: { counts: diff.counts, byExtension: diff.byExt, shortstat: diff.shortstat },
    snapshot: worktrees ? { base: snapshot(baseRoot, stacks), head: snapshot(headRoot, stacks) } : null,
    dependencies: worktrees ? lockDiff(baseRoot, headRoot) : null,
    productionDrift: productionDrift(repo, mergeBase, headSha, prod),
  };
  fs.writeFileSync(path.join(outDir, 'baseline.json'), JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'baseline.md'), markdown(data));
  return data;
}

function fmt(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? '–'); }

function markdown(d) {
  const L = [];
  L.push('# Impact analysis baseline', '');
  L.push(`- Head: \`${d.refs.head}\` @ \`${d.refs.headSha.slice(0, 9)}\``);
  L.push(`- Merge base: \`${d.refs.mergeBase.slice(0, 9)}\` (head is ${d.refs.ahead} commits ahead)`);
  if (d.refs.prod) L.push(`- Production branch: \`${d.refs.prod}\` — head is ${d.refs.behindProduction} commits behind it`);
  L.push(`- Stacks: ${d.stacks.join(', ') || 'unknown'}`);
  if (d.worktrees.base) L.push(`- Worktrees: BASE=\`${d.worktrees.base}\`, HEAD=\`${d.worktrees.head}\` (read-only; never edit)`);
  L.push('', '## Changes', '', `${d.changes.shortstat}`, '');
  const c = d.changes.counts;
  L.push(`Added ${fmt(c.A)}, deleted ${fmt(c.D)}, renamed ${fmt(c.R)}, modified in place ${fmt(c.M)}. Full list: \`namestatus.txt\`.`);
  if (d.snapshot) {
    const a = d.snapshot.base, b = d.snapshot.head;
    L.push('', '## Size', '', '| Measure | Base | Head |', '|---|---:|---:|');
    for (const [k, label] of [['sourceFiles', 'Source files'], ['handwrittenLoc', 'Hand-written LOC'], ['generatedFiles', 'Generated files'], ['generatedLoc', 'Generated LOC'], ['testFiles', 'Test files']]) {
      L.push(`| ${label} | ${fmt(a[k])} | ${fmt(b[k])} |`);
    }
    L.push('', '## Pattern counts (files containing, non-generated)', '', '| Pattern | Base | Head |', '|---|---:|---:|');
    for (const k of Object.keys(b.patterns)) L.push(`| ${k} | ${fmt(a.patterns[k])} | ${fmt(b.patterns[k])} |`);
  }
  if (d.dependencies && d.dependencies.file) {
    const dep = d.dependencies;
    L.push('', `## Dependencies (${dep.file})`, '', `${dep.before} → ${dep.after} packages. Added ${dep.added.length}, removed ${dep.removed.length}, changed ${dep.changed.length}.`);
    if (dep.added.length) L.push('', `Added: ${dep.added.slice(0, 60).join(', ')}${dep.added.length > 60 ? ', …' : ''}`);
    if (dep.changed.length) L.push('', `Changed: ${dep.changed.slice(0, 60).join(', ')}${dep.changed.length > 60 ? ', …' : ''}`);
  }
  if (d.productionDrift) {
    const p = d.productionDrift;
    L.push('', `## Production drift (${p.prod})`, '', `${p.commits} production commits are not in the head. ${p.atRisk.length} touch files that no longer exist at head, so their fixes will not merge automatically and can be silently lost:`, '');
    for (const x of p.atRisk.slice(0, 200)) L.push(`- \`${x.sha}\` ${x.subject} — missing at head: ${x.missingAtHead.slice(0, 5).map(f => '`' + f + '`').join(', ')}${x.missingAtHead.length > 5 ? ', …' : ''}`);
  }
  L.push('');
  return L.join('\n');
}

function parseArgs(argv) {
  const o = { worktrees: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--head') o.head = argv[++i];
    else if (a === '--prod') o.prod = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--output') o.output = argv[++i];
    else if (a === '--no-worktrees') o.worktrees = false;
    else if (a === '--json') o.json = true;
    else if (!a.startsWith('--') && !o.runId) o.runId = a;
  }
  return o;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-baseline-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
    const g = (...a) => git(repo, a);
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'pubspec.yaml'), 'name: x\n');
    fs.writeFileSync(path.join(repo, 'pubspec.lock'), 'packages:\n  http:\n    dependency: direct\n    version: "1.0.0"\n');
    fs.writeFileSync(path.join(repo, 'lib', 'cart.dart'), 'import "package:http/http.dart" as http;\nvoid a(){ http.get(Uri()); setState(() {}); }\n');
    fs.writeFileSync(path.join(repo, 'lib', 'order.dart'), 'class Order {}\n');
    g('add', '.'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'revamp');
    fs.mkdirSync(path.join(repo, 'lib', 'features', 'cart'), { recursive: true });
    g('mv', 'lib/cart.dart', 'lib/features/cart/cart_page.dart');
    fs.writeFileSync(path.join(repo, 'lib', 'features', 'cart', 'cart_cubit.dart'), 'class CartCubit extends Cubit<int> { CartCubit(): super(0); }\n');
    fs.writeFileSync(path.join(repo, 'lib', 'features', 'cart', 'cart.g.dart'), '// generated\n');
    fs.writeFileSync(path.join(repo, 'pubspec.lock'), 'packages:\n  http:\n    dependency: direct\n    version: "1.0.0"\n  flutter_bloc:\n    dependency: direct\n    version: "9.1.1"\n');
    g('add', '.'); g('commit', '-qm', 'revamp');
    g('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'lib', 'cart.dart'), 'void a(){ /* MAVS-1 fix */ }\n');
    g('commit', '-qam', 'MAVS-1 fix cart');
    const out = path.join(tmp, 'out');
    const d = build({ repo, base: 'main', head: 'revamp', prod: 'main', outDir: out });
    assert.equal(d.changes.counts.R, 1, 'rename detected');
    assert.equal(d.changes.counts.A, 2, 'two added files');
    assert.ok(d.stacks.includes('flutter'));
    assert.equal(d.snapshot.head.generatedFiles, 1);
    assert.equal(d.snapshot.base.patterns['flutter: Raw http'], 1);
    assert.equal(d.snapshot.head.patterns['flutter: Bloc / Cubit classes'], 1);
    assert.deepEqual(d.dependencies.added, ['flutter_bloc 9.1.1']);
    assert.equal(d.refs.behindProduction, 1);
    assert.equal(d.productionDrift.atRisk.length, 1, 'fix on a moved file is at risk');
    assert.deepEqual(d.productionDrift.atRisk[0].missingAtHead, ['lib/cart.dart']);
    assert.ok(fs.readFileSync(path.join(out, 'baseline.md'), 'utf8').includes('can be silently lost'));
    git(repo, ['worktree', 'remove', '--force', path.join(out, 'worktrees', 'base')]);
    git(repo, ['worktree', 'remove', '--force', path.join(out, 'worktrees', 'head')]);
    console.log('impact-baseline selftest OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();
  const o = parseArgs(argv);
  if (!o.runId || !o.base || !o.head) {
    throw new Error('usage: impact-baseline.js <run-id> --base <ref> --head <ref> [--prod <ref>] [--repo <path>] [--output <dir>] [--no-worktrees] [--json]');
  }
  const repo = path.resolve(o.repo || projectRoot());
  const outDir = path.resolve(o.output || path.join(stateRoot(), o.runId, 'impact'));
  const data = build({ repo, base: o.base, head: o.head, prod: o.prod, outDir, worktrees: o.worktrees });
  if (o.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(markdown(data) + `\nWritten: ${path.join(outDir, 'baseline.md')}\n`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { build, markdown, snapshot, lockDiff, productionDrift };
