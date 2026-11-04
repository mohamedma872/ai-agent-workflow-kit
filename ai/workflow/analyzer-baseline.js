#!/usr/bin/env node
'use strict';

// "No new analyzer issues" needs the issues before the change, and a read-only
// role cannot check out the base to look: a real build-test passed 80 of 80
// tests and still failed, on 12 lints it could not prove were pre-existing.
// The runtime does it instead, before build-test and verification. It
// extracts the changed Dart files' directories (lib/, test/ and the pubspec and
// analysis options) at the run's base commit into a temporary directory with
// `git archive` (nothing is checked out, the repository is not touched), gives
// it the worktree's package resolution and ignored generated files so no
// `pub get` runs, and analyzes the changed files in both trees with
// `dart analyze --format=machine`. Issues are compared per file and diagnostic
// code, which line moves do not disturb. The result lands in
// engine/analyzer-baseline.json and .md, which the build-test role reads.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const trackedFiles = require('./tracked-files');

const ARCHIVED = ['lib', 'test', 'pubspec.yaml', 'analysis_options.yaml'];
const PACKAGE_FILES = ['package_config.json', 'package_graph.json'];
const TIMEOUT_MS = 10 * 60 * 1000;

function git(cwd, args, options = {}) { return spawnSync('git', args, { cwd, encoding: options.encoding === undefined ? 'utf8' : options.encoding, maxBuffer: 512 * 1024 * 1024, input: options.input }); }

// SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE, one issue per line.
// Paths are relative to `root`, which may be reached through a symlink (macOS
// /var is /private/var): the analyzer reports the real path.
function parseMachine(text, root) {
  const issues = [];
  const roots = [root];
  try { const real = fs.realpathSync(root); if (real !== root) roots.push(real); } catch { /* as given */ }
  const relative = file => {
    for (const dir of roots) { const rel = path.relative(dir, file); if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel; }
    return file;
  };
  for (const line of String(text || '').split('\n')) {
    const parts = line.split('|');
    if (parts.length < 8 || !/^(INFO|WARNING|ERROR)$/.test(parts[0])) continue;
    const file = relative(parts[3]).split(path.sep).join('/');
    issues.push({ severity: parts[0].toLowerCase(), code: parts[2].toLowerCase(), file, line: Number(parts[4]), message: parts.slice(7).join('|').replace(/\\(.)/g, '$1') });
  }
  return issues;
}

function analyze(dart, root, files) {
  if (!files.length) return { ok: true, issues: [] };
  const res = spawnSync(dart, ['analyze', '--format=machine', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: TIMEOUT_MS });
  // Exit 0–3 mean "analyzed" (no issues … errors); anything else did not run.
  if (res.error || res.status === null || res.status > 3) return { ok: false, reason: res.error?.message || `dart analyze exited ${res.status ?? res.signal}: ${String(res.stderr || '').trim().split('\n').pop() || ''}` };
  return { ok: true, issues: parseMachine(`${res.stdout}\n${res.stderr}`, root) };
}

function countBy(issues) {
  const counts = new Map();
  for (const issue of issues) {
    const key = `${issue.file}\u0000${issue.code}`;
    const entry = counts.get(key) || { file: issue.file, code: issue.code, severity: issue.severity, count: 0, lines: [] };
    entry.count += 1;
    entry.lines.push(issue.line);
    counts.set(key, entry);
  }
  return counts;
}
// Per file and code: what grew (new issues) and what shrank.
function compare(baseIssues, runIssues) {
  const base = countBy(baseIssues);
  const run = countBy(runIssues);
  const grew = [];
  const shrank = [];
  for (const [key, entry] of run) {
    const before = base.get(key)?.count || 0;
    if (entry.count > before) grew.push({ file: entry.file, code: entry.code, severity: entry.severity, before, after: entry.count, lines: entry.lines });
  }
  for (const [key, entry] of base) {
    const after = run.get(key)?.count || 0;
    if (after < entry.count) shrank.push({ file: entry.file, code: entry.code, severity: entry.severity, before: entry.count, after });
  }
  const sort = list => list.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code));
  return { grew: sort(grew), shrank: sort(shrank) };
}

// The base tree: the archived paths at `baseSha`, plus what makes it analyzable
// without `pub get` — the worktree's package resolution and its ignored files
// under lib/ (generated localizations, env.g.dart and the like).
function extractBase(productRoot, baseSha, dir) {
  const present = ARCHIVED.filter(entry => git(productRoot, ['cat-file', '-e', `${baseSha}:${entry}`]).status === 0);
  if (!present.length) throw new Error(`nothing to analyze at ${baseSha.slice(0, 12)}`);
  const archive = git(productRoot, ['archive', '--format=tar', baseSha, '--', ...present], { encoding: 'buffer' });
  if (archive.status !== 0) throw new Error(`git archive failed: ${String(archive.stderr || '').trim()}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, maxBuffer: 512 * 1024 * 1024 });
  if (untar.status !== 0) throw new Error(`tar failed: ${String(untar.stderr || '').trim()}`);
  fs.mkdirSync(path.join(dir, '.dart_tool'), { recursive: true });
  for (const name of PACKAGE_FILES) {
    const from = path.join(productRoot, '.dart_tool', name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, '.dart_tool', name));
  }
  if (!fs.existsSync(path.join(dir, '.dart_tool', 'package_config.json'))) throw new Error('the worktree has no .dart_tool/package_config.json (run pub get once on the pinned SDK)');
  const ignored = git(productRoot, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', 'lib']);
  for (const rel of String(ignored.stdout || '').split('\0').filter(Boolean)) {
    const target = path.join(dir, rel);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(productRoot, rel), target);
  }
}

// Runs the comparison and writes it to `outDir`. Never throws: an analysis
// that cannot run is recorded as unavailable, with the reason.
function computeBaseline({ productRoot, baseSha, files, dart, outDir, now = () => new Date() }) {
  const result = { schemaVersion: 1, at: now().toISOString(), baseSha, files, status: 'unavailable', reason: null, totals: null, grew: [], shrank: [] };
  let tmp = null;
  try {
    if (!baseSha) throw new Error('the run has no base commit');
    if (!dart) throw new Error('no dart executable (Flutter SDK not found)');
    const dartFiles = files.filter(file => /\.dart$/.test(file) && fs.existsSync(path.join(productRoot, file)));
    result.files = dartFiles;
    if (!dartFiles.length) { result.status = 'skipped'; result.reason = 'no changed Dart files'; return write(result, outDir); }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-analyzer-base-'));
    extractBase(productRoot, baseSha, tmp);
    const atBase = dartFiles.filter(file => fs.existsSync(path.join(tmp, file)));
    const base = analyze(dart, tmp, atBase);
    if (!base.ok) throw new Error(`base analysis: ${base.reason}`);
    // `dart analyze` on a newer SDK migrates analysis_options.yaml in place:
    // whatever it changes in the worktree is put back.
    const before = trackedFiles.snapshot(productRoot);
    let run;
    try { run = analyze(dart, productRoot, dartFiles); }
    finally { result.restored = trackedFiles.restore(before).map(entry => entry.path); }
    if (!run.ok) throw new Error(`worktree analysis: ${run.reason}`);
    const { grew, shrank } = compare(base.issues, run.issues);
    const errors = issues => issues.filter(issue => issue.severity === 'error').length;
    Object.assign(result, {
      status: 'ok',
      newFiles: dartFiles.filter(file => !atBase.includes(file)),
      totals: { base: base.issues.length, run: run.issues.length, baseErrors: errors(base.issues), runErrors: errors(run.issues) },
      grew,
      shrank,
    });
  } catch (error) {
    result.status = 'unavailable';
    result.reason = error.message;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return write(result, outDir);
}

function markdown(result) {
  const lines = ['# Analyzer comparison against the run base (runtime)', ''];
  lines.push(`Computed by the runtime at ${result.at}: the changed Dart files, analyzed with \`dart analyze\` at the base commit ${String(result.baseSha || '?').slice(0, 12)} and in the worktree, compared per file and diagnostic code (line moves do not count).`, '');
  if (result.status !== 'ok') {
    lines.push(`**Not available:** ${result.reason}. Judge new issues another way and say how.`);
    return lines.join('\n');
  }
  lines.push(`| | base | worktree |`, `|---|---|---|`, `| issues in the ${result.files.length} changed file(s) | ${result.totals.base} | ${result.totals.run} |`, `| errors | ${result.totals.baseErrors} | ${result.totals.runErrors} |`, '');
  if (result.newFiles.length) lines.push(`New files (every issue in them is new): ${result.newFiles.join(', ')}`, '');
  if (!result.grew.length) lines.push('**New issues: none.** No diagnostic code grew in any changed file, so every issue on a changed line was already there at the base. The "no new analyzer issues" gate is met by this evidence; do not fail the stage over pre-existing issues.');
  else {
    lines.push(`**New issues: ${result.grew.reduce((sum, entry) => sum + entry.after - entry.before, 0)}.** These codes grew, so the change introduced them:`, '');
    for (const entry of result.grew) lines.push(`- ${entry.file} \`${entry.code}\` (${entry.severity}): ${entry.before} → ${entry.after}, now at line(s) ${entry.lines.slice(0, 12).join(', ')}`);
  }
  if (result.shrank.length) lines.push('', `Fixed by the change: ${result.shrank.map(entry => `${entry.file} \`${entry.code}\` ${entry.before} → ${entry.after}`).join('; ')}.`);
  return lines.join('\n');
}
function write(result, outDir) {
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'analyzer-baseline.json'), `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'analyzer-baseline.md'), `${markdown(result)}\n`);
  }
  return result;
}

function selftest() {
  const root = '/w';
  const parsed = parseMachine([
    'INFO|LINT|UNAWAITED_FUTURES|/w/lib/a.dart|978|5|30|Missing an \'await\'',
    'WARNING|STATIC_WARNING|DEAD_CODE|/w/lib/b.dart|581|48|5|Dead code.',
    'Analyzing 2 files...',
    'ERROR|COMPILE_TIME_ERROR|URI_DOES_NOT_EXIST|/w/lib/a.dart|1|8|20|Target of URI doesn\\|t exist',
  ].join('\n'), root);
  assert.deepStrictEqual(parsed.map(i => [i.severity, i.code, i.file, i.line]), [['info', 'unawaited_futures', 'lib/a.dart', 978], ['warning', 'dead_code', 'lib/b.dart', 581], ['error', 'uri_does_not_exist', 'lib/a.dart', 1]]);
  const issue = (file, code, line, severity = 'info') => ({ file, code, line, severity });
  const { grew, shrank } = compare(
    [issue('lib/a.dart', 'require_trailing_commas', 10), issue('lib/a.dart', 'require_trailing_commas', 20), issue('lib/b.dart', 'dead_code', 5, 'warning'), issue('lib/b.dart', 'dead_code', 9, 'warning')],
    [issue('lib/a.dart', 'require_trailing_commas', 12), issue('lib/a.dart', 'require_trailing_commas', 22), issue('lib/a.dart', 'unawaited_futures', 978), issue('lib/b.dart', 'dead_code', 6, 'warning')],
  );
  assert.deepStrictEqual(grew, [{ file: 'lib/a.dart', code: 'unawaited_futures', severity: 'info', before: 0, after: 1, lines: [978] }], 'moved lines are not new; a new code is');
  assert.deepStrictEqual(shrank, [{ file: 'lib/b.dart', code: 'dead_code', severity: 'warning', before: 2, after: 1 }]);

  // End to end with a stand-in `dart` that reports per-tree issues, on a real
  // git repository: archive, package files, ignored generated files, outputs.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-baseline-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
    const run = args => { const r = git(repo, args); assert.strictEqual(r.status, 0, r.stderr); return r.stdout.trim(); };
    run(['init', '-q']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.dart_tool/\nlib/gen/\n');
    fs.writeFileSync(path.join(repo, 'pubspec.yaml'), 'name: demo\n');
    fs.writeFileSync(path.join(repo, 'lib', 'a.dart'), 'void main() {}\n');
    run(['add', '-A']); run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    const baseSha = run(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'lib', 'a.dart'), 'void main() { f(); }\n');
    fs.writeFileSync(path.join(repo, 'lib', 'new.dart'), 'int x = 1;\n');
    fs.mkdirSync(path.join(repo, '.dart_tool')); fs.writeFileSync(path.join(repo, '.dart_tool', 'package_config.json'), '{}');
    fs.mkdirSync(path.join(repo, 'lib', 'gen')); fs.writeFileSync(path.join(repo, 'lib', 'gen', 'l10n.dart'), '// generated\n');
    const dart = path.join(tmp, 'dart');
    // The stand-in reports an unawaited future where a.dart calls f(), and
    // fails if the base tree lacks the package config or generated file.
    fs.writeFileSync(dart, `#!${process.execPath}\nconst fs=require('fs');const path=require('path');\nif(fs.existsSync('.git'))fs.appendFileSync('pubspec.yaml','# migrated\\n');\nif(!fs.existsSync('.dart_tool/package_config.json')||!fs.existsSync('lib/gen/l10n.dart')){console.error('not resolved');process.exit(64);}\nfor(const f of process.argv.slice(4)){const t=fs.readFileSync(f,'utf8');console.log('INFO|LINT|PREFER_FINAL|'+path.resolve(f)+'|1|1|1|x');if(t.includes('f()'))console.log('INFO|LINT|UNAWAITED_FUTURES|'+path.resolve(f)+'|1|15|3|Missing await');}\nprocess.exit(1);\n`, { mode: 0o755 });
    const out = path.join(tmp, 'engine');
    const result = computeBaseline({ productRoot: repo, baseSha, files: ['lib/a.dart', 'lib/new.dart', 'lib/removed.dart', 'README.md'], dart, outDir: out });
    assert.strictEqual(result.status, 'ok', result.reason);
    assert.deepStrictEqual(result.files, ['lib/a.dart', 'lib/new.dart'], 'only changed Dart files that exist');
    assert.deepStrictEqual(result.newFiles, ['lib/new.dart']);
    assert.deepStrictEqual(result.grew.map(e => `${e.file}:${e.code}`), ['lib/a.dart:unawaited_futures', 'lib/new.dart:prefer_final']);
    assert.deepStrictEqual(result.totals, { base: 1, run: 3, baseErrors: 0, runErrors: 0 });
    assert.match(fs.readFileSync(path.join(out, 'analyzer-baseline.md'), 'utf8'), /New issues: 2\.\*\*[\s\S]*lib\/a\.dart `unawaited_futures`/);
    assert.strictEqual(run(['status', '--porcelain', '--', 'lib/a.dart']), 'M lib/a.dart', 'the worktree is untouched');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'pubspec.yaml'), 'utf8'), 'name: demo\n', 'what the analyzer rewrote in the worktree is put back');
    assert.deepStrictEqual(result.restored, ['pubspec.yaml']);
    // Nothing new: the gate is met by the evidence.
    fs.writeFileSync(path.join(repo, 'lib', 'a.dart'), 'void main() {  }\n');
    const clean = computeBaseline({ productRoot: repo, baseSha, files: ['lib/a.dart'], dart, outDir: out });
    assert.deepStrictEqual([clean.status, clean.grew], ['ok', []]);
    assert.match(fs.readFileSync(path.join(out, 'analyzer-baseline.md'), 'utf8'), /New issues: none\./);
    // What cannot run is recorded, never thrown.
    assert.match(computeBaseline({ productRoot: repo, baseSha, files: ['lib/a.dart'], dart: null, outDir: out }).reason, /no dart executable/);
    assert.strictEqual(computeBaseline({ productRoot: repo, baseSha, files: ['README.md'], dart, outDir: out }).status, 'skipped');
    fs.rmSync(path.join(repo, '.dart_tool'), { recursive: true });
    assert.match(computeBaseline({ productRoot: repo, baseSha, files: ['lib/a.dart'], dart, outDir: out }).reason, /no \.dart_tool\/package_config\.json/);
    assert.match(fs.readFileSync(path.join(out, 'analyzer-baseline.md'), 'utf8'), /Not available:/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('analyzer-baseline selftest OK');
}

module.exports = { parseMachine, compare, computeBaseline, markdown };

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else { console.error('usage: analyzer-baseline.js --selftest'); process.exitCode = 1; }
}
