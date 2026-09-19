#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION_FILE = path.join(ROOT, 'ai', 'runtime-version.json');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const LOCK_FILE = path.join(ROOT, 'package-lock.json');
const WORKFLOW_FILE = path.join(ROOT, 'ai', 'workflows', 'feature.yaml');
const SCHEMA_DIR = path.join(ROOT, 'ai', 'workflow', 'schemas');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function runtimeVersion() { return readJson(VERSION_FILE); }
function semverOk(value) { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(value || '')); }
function workflowVersion() {
  const text = fs.readFileSync(WORKFLOW_FILE, 'utf8');
  const match = text.match(/^version:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}
function artifactSchemaVersions() {
  const versions = new Set();
  if (!fs.existsSync(SCHEMA_DIR)) return versions;
  for (const name of fs.readdirSync(SCHEMA_DIR).filter(n => n.endsWith('.schema.json'))) {
    const data = readJson(path.join(SCHEMA_DIR, name));
    if (data?.properties?.schemaVersion?.const !== undefined) versions.add(Number(data.properties.schemaVersion.const));
  }
  return versions;
}
function check() {
  const meta = runtimeVersion();
  const pkg = readJson(PACKAGE_FILE);
  const lock = readJson(LOCK_FILE);
  const problems = [];
  if (!semverOk(meta.runtimeVersion)) problems.push(`runtimeVersion is not valid SemVer: ${meta.runtimeVersion}`);
  if (pkg.name !== 'ai-agent-workflow-runtime') problems.push(`package.json name ${pkg.name} != ai-agent-workflow-runtime`);
  if (pkg.version !== meta.runtimeVersion) problems.push(`package.json version ${pkg.version} != runtimeVersion ${meta.runtimeVersion}`);
  if (lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name) problems.push('package-lock.json package name is out of sync');
  if (lock.version !== meta.runtimeVersion || lock.packages?.['']?.version !== meta.runtimeVersion) problems.push('package-lock.json runtime version is out of sync');
  const wf = workflowVersion();
  if (wf !== Number(meta.workflowFormatVersion)) problems.push(`feature workflow format version ${wf} != ${meta.workflowFormatVersion}`);
  for (const value of artifactSchemaVersions()) if (value !== Number(meta.artifactSchemaVersion)) problems.push(`artifact schema version ${value} != ${meta.artifactSchemaVersion}`);
  const changelog = fs.readFileSync(CHANGELOG_FILE, 'utf8');
  if (!new RegExp(`^## ${String(meta.runtimeVersion).replace(/\./g, '\\.')}\\b`, 'm').test(changelog)) problems.push(`CHANGELOG.md has no ${meta.runtimeVersion} release section`);
  if (!['stable', 'prerelease'].includes(meta.releaseChannel)) problems.push('releaseChannel must be stable or prerelease');
  if (problems.length) { problems.forEach(p => console.error(`✗ ${p}`)); return 1; }
  console.log(`✓ runtime ${meta.runtimeVersion} · workflow format ${meta.workflowFormatVersion} · artifact schema ${meta.artifactSchemaVersion} · ${meta.releaseChannel}`);
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const [cmd] = argv;
  try {
    const meta = runtimeVersion();
    if (cmd === 'check') process.exitCode = check();
    else if (cmd === '--json' || cmd === 'json') console.log(JSON.stringify(meta, null, 2));
    else if (!cmd || cmd === '--version' || cmd === 'version') console.log(meta.runtimeVersion);
    else { console.error('usage: version.js [version|--version|--json|check]'); process.exitCode = 1; }
  } catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 1; }
}

if (require.main === module) main();
module.exports = { runtimeVersion, check, semverOk, workflowVersion, artifactSchemaVersions, main };
