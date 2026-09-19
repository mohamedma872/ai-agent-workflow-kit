#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'ai', 'workflow', 'engine.js');
const RUNS = path.join(ROOT, 'ai', 'tasks', 'feature', 'runs.js');
const PROGRESS = path.join(ROOT, 'ai', 'workflow', 'progress.js');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function execNode(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function stripMode(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

const [command, id, ...rest] = process.argv.slice(2);

if (!command || command === '--help' || command === 'help') {
  console.log(`Simple refactor workflow

Start or continue:
  npm run refactor -- RF-001 --request "Refactor login without changing behavior" --scope mobile

Approve and continue:
  npm run refactor:approve -- RF-001

Check status:
  npm run refactor:status -- RF-001

Final report:
  npm run refactor:report -- RF-001
`);
  process.exit(0);
}

if (!id) fail('A run id is required, for example RF-001.');

const stateFile = path.join(ROOT, 'ai', 'runs', id, 'state.json');

if (command === 'run') {
  if (!fs.existsSync(stateFile)) {
    const args = stripMode(rest);
    const hasRequest = args.includes('--request') || args.includes('--request-file');
    if (!hasRequest) {
      fail('New refactor runs require --request "..." or --request-file FILE.');
    }
    execNode(ENGINE, ['start', id, ...args, '--mode', 'refactor']);
  }
  execNode(ENGINE, ['run', id]);
} else if (command === 'approve') {
  execNode(RUNS, ['approve', id]);
  execNode(ENGINE, ['resume', id]);
} else if (command === 'status') {
  execNode(PROGRESS, ['--run', id]);
} else {
  fail('Unknown command. Use: run, approve, status.');
}
