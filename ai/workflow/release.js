#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runtimeVersion, check: versionCheck } = require('./version');

const ROOT = path.resolve(__dirname, '..', '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const MIGRATIONS = path.join(ROOT, 'docs', 'migrations');

function run(bin, args, options = {}) {
  const res = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: options.timeout || 10 * 60 * 1000, maxBuffer: 128 * 1024 * 1024 });
  if (options.allowFailure) return res;
  if (res.error || res.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed: ${res.error?.message || String(res.stderr || res.stdout || '').trim()}`);
  return String(res.stdout || '').trim();
}
function git(...args) { return run('git', args); }
function releaseSection(version) {
  const lines = fs.readFileSync(CHANGELOG, 'utf8').split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`## ${version}`));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  const section = lines.slice(start + 1, end).join('\n').trim();
  return section || null;
}
function migrationFile(version) { return path.join(MIGRATIONS, `${version}.md`); }
function notes(version) {
  const section = releaseSection(version);
  if (!section) throw new Error(`CHANGELOG.md has no release section for ${version}`);
  const migration = fs.existsSync(migrationFile(version)) ? fs.readFileSync(migrationFile(version), 'utf8').trim() : null;
  return [`# AI Agent Workflow Runtime ${version}`, '', section, migration ? `\n## Migration notes\n\n${migration}` : ''].filter(Boolean).join('\n');
}
function checkRelease() {
  if (versionCheck() !== 0) return 1;
  const meta = runtimeVersion();
  const version = meta.runtimeVersion;
  const problems = [];
  if (!releaseSection(version)) problems.push(`CHANGELOG.md has no ${version} release section`);
  if (!fs.existsSync(migrationFile(version))) problems.push(`docs/migrations/${version}.md is missing`);
  const tag = `v${version}`;
  const existing = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFailure: true });
  if (existing.status === 0 && !String(existing.stdout || '').trim()) problems.push(`${tag} exists but cannot be resolved`);
  if (problems.length) { problems.forEach(p => console.error(`✗ ${p}`)); return 1; }
  console.log(`✓ release ${version} metadata is ready (${tag})`);
  return 0;
}
function createTag(options = {}) {
  if (checkRelease() !== 0) throw new Error('release checks failed');
  const version = runtimeVersion().runtimeVersion;
  const tag = `v${version}`;
  const branch = git('branch', '--show-current');
  const status = git('status', '--porcelain');
  if (branch !== 'main' && !options.dryRun) throw new Error(`release tags must be created from main (current: ${branch || 'detached'})`);
  if (status && !options.dryRun) throw new Error('working tree must be clean before creating a release tag');
  const existing = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFailure: true });
  if (existing.status === 0) {
    const target = git('rev-list', '-n', '1', tag);
    const head = git('rev-parse', 'HEAD');
    if (target !== head) throw new Error(`${tag} already points to ${target}, not current HEAD ${head}`);
    console.log(`✓ ${tag} already points to current HEAD`);
  } else if (options.dryRun) {
    console.log(`[dry-run] git tag -a ${tag} -m "AI Agent Workflow Runtime ${version}"`);
  } else {
    git('tag', '-a', tag, '-m', `AI Agent Workflow Runtime ${version}`);
    console.log(`✓ created ${tag}`);
  }
  if (options.push) {
    if (options.dryRun) console.log(`[dry-run] git push origin ${tag}`);
    else { git('push', 'origin', tag); console.log(`✓ pushed ${tag}`); }
  }
  return tag;
}

const args = process.argv.slice(2);
const cmd = args[0] || 'check';
try {
  if (cmd === 'check') process.exitCode = checkRelease();
  else if (cmd === 'notes') process.stdout.write(notes(runtimeVersion().runtimeVersion) + '\n');
  else if (cmd === 'tag') createTag({ dryRun: args.includes('--dry-run'), push: args.includes('--push') });
  else throw new Error('usage: release.js check | notes | tag [--dry-run] [--push]');
} catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }

module.exports = { releaseSection, notes, checkRelease, createTag };
