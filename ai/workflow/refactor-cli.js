#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runtimeRoot, projectRoot, stateRoot } = require('./paths');

const ROOT = runtimeRoot();
const PROJECT_ROOT = projectRoot();
const STATE_ROOT = stateRoot();
const ENGINE = path.join(ROOT, 'ai', 'workflow', 'engine.js');
const RUNS = path.join(ROOT, 'ai', 'tasks', 'feature', 'runs.js');
const PROGRESS = path.join(ROOT, 'ai', 'workflow', 'progress.js');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function execNode(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function cleanStartArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (['--mode', '--refactor-scope'].includes(args[i])) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

function requireRequest(args) {
  if (!args.includes('--request') && !args.includes('--request-file')) {
    fail('New refactor runs require --request "..." or --request-file FILE.');
  }
}

const [command, id, ...rest] = process.argv.slice(2);

if (!command || command === '--help' || command === 'help') {
  console.log(`Simple refactor workflow

Local/module refactor:
  npm run refactor -- RF-001 --request "Refactor login without changing behavior" --scope mobile
  npm run refactor:approve -- RF-001
  npm run refactor:report -- RF-001

Whole-app refactor:
  npm run refactor:app -- APP-RF-001 --request "Refactor the entire app without changing behavior" --scope mobile
  npm run refactor:architecture -- APP-RF-001 <option-id>
  npm run refactor:approve -- APP-RF-001
  npm run refactor:report -- APP-RF-001

Status:
  npm run refactor:status -- <run-id>
`);
  process.exit(0);
}

if (!id) fail('A run id is required, for example RF-001 or APP-RF-001.');

const stateFile = path.join(STATE_ROOT, id, 'state.json');

if (command === 'run' || command === 'app') {
  if (!fs.existsSync(stateFile)) {
    const args = cleanStartArgs(rest);
    requireRequest(args);
    const startArgs = ['start', id, ...args, '--mode', 'refactor'];
    if (command === 'app') startArgs.push('--refactor-scope', 'app');
    startArgs.push('--no-run');
    execNode(ENGINE, startArgs);
  }
  execNode(ENGINE, ['run', id]);
} else if (command === 'architecture') {
  const optionId = rest[0];
  if (!optionId) fail('Choose an architecture option id, for example: npm run refactor:architecture -- APP-RF-001 A');
  execNode(RUNS, ['architecture-select', id, optionId, ...rest.slice(1)]);
  execNode(ENGINE, ['resume', id]);
} else if (command === 'approve') {
  execNode(RUNS, ['approve', id]);
  execNode(ENGINE, ['resume', id]);
} else if (command === 'status') {
  execNode(PROGRESS, ['--run', id]);
} else {
  fail('Unknown command. Use: run, app, architecture, approve, status.');
}
