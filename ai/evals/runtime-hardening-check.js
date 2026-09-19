#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CHECKS = [
  ['controlled state/DAG transitions', ['ai/tasks/feature/runs.js', 'selftest']],
  ['deterministic engine', ['ai/workflow/engine.js', 'selftest']],
  ['retry/timeout/fallback/resume', ['ai/workflow/execution-policy.js', '--selftest']],
  ['attempt-history persistence', ['ai/workflow/attempts.js', '--selftest']],
  ['parallel worktree isolation', ['ai/workflow/worktree.js', 'selftest']],
  ['Appium session/build/stale-evidence attestation', ['ai/tasks/feature/evidence-attestation-selftest.js']],
  ['mobile evidence runner contract', ['ai/tasks/feature/mobile-evidence.js', 'selftest']],
  ['shell-write/plan-gate adversarial guard', ['ai/tasks/feature/guard-selftest.js']],
  ['GitHub commit verification summary', ['ai/workflow/github-verification.js', 'selftest']],
  ['behavior-preserving refactor adversarial gates', ['ai/evals/refactor-safety-check.js']],
];

function run() {
  let failed = 0;
  for (const [label, args] of CHECKS) {
    const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 128 * 1024 * 1024 });
    const ok = !res.error && res.status === 0;
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) {
      failed++;
      const tail = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
      if (tail) console.error(tail);
    }
  }
  if (failed) {
    console.error(`\n✗ ${failed}/${CHECKS.length} runtime hardening regression(s) failed`);
    return 1;
  }
  console.log(`\n✓ ${CHECKS.length}/${CHECKS.length} runtime hardening regressions passed`);
  return 0;
}

if (require.main === module) process.exitCode = run();
module.exports = { CHECKS, run };
