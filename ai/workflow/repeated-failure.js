#!/usr/bin/env node
'use strict';

/*
 * Repeated-failure detection for stages, roles and conditional roles.
 *
 * A stage that fails or blocks with the same reason as its previous failure
 * will not pass by retrying it again: the cause is somewhere else (a missing
 * device, a red test the stage does not own, a config value). Each state entry
 * that fails keeps a normalised signature of its reason in `lastFailure`; the
 * next failure with the same signature counts up, and from the second one on
 * the entry carries `repeatedFailure: n`. The progress views, `status` and the
 * engine's notification then say so. Nothing here stops a human from retrying.
 *
 * The comparison ignores what changes between attempts of the same failure:
 * timestamps, file paths, attempt ids, hashes, pids and durations. Reasons that
 * say nothing about the cause (an agent exiting non-zero, a timeout, an
 * interrupt) are not compared at all: two of those in a row are not evidence
 * that the stage cannot fix it.
 */

const assert = require('assert');

const UNINFORMATIVE = [
  // An exit status or a signal name says nothing about why.
  /^([\w./-]+: )*[\w-]+ exited (\d+|null|undefined|SIG[A-Z0-9]+)$/,
  /^([\w./-]+: )*[\w-]+ (timed out|was killed)\b/,
  // Node's own spawnSync errors: "spawnSync /path/to/node ETIMEDOUT" (a timeout),
  // ENOBUFS (too much output), EPIPE.
  /^([\w./-]+: )*spawnSync \S+ E[A-Z]+$/,
  /^([\w./-]+: )*interrupted: /,
  /^([\w./-]+: )*(run-role|parallel role runner) (exit|exited|signal|was interrupted)\b/,
  // engine.js command(): "<bin> <args> failed with exit N", the child's own reason elsewhere.
  /^([\w./-]+: )*[\w.-]+ \S.* failed with exit (\d+|null)$/,
];

// The normalised reason, or null when the reason is empty or uninformative.
function signature(reason) {
  const text = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
  if (!text || UNINFORMATIVE.some(re => re.test(text))) return null;
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    // Attempt ids: <run>-<stage>-<role>-<n>-<epoch ms>.
    .replace(/\b[\w.-]+-\d+-\d{12,}\b/g, '<attempt>')
    // Absolute, home-relative and relative paths with a directory part.
    .replace(/(^|[\s('"`=])(?:~|\.{1,2})?(?:\/[^\s'"`),;]+|[\w.-]+\/[^\s'"`),;]*[^\s'"`),;:])/g, '$1<path>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\b\d{10,}\b/g, '<n>')
    .replace(/\b(pid|attempt|run|#)\s*\d+\b/gi, '$1 <n>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|minutes)\b/gi, '<duration>')
    .toLowerCase();
}

// Called on the entry (phase, role or conditional) as it fails or blocks.
// Returns the count of consecutive identical failures (1 for a new one).
function recordFailure(entry, reason) {
  const sig = signature(reason);
  if (!sig) { delete entry.lastFailure; delete entry.repeatedFailure; return 0; }
  const count = entry.lastFailure?.signature === sig ? (Number(entry.lastFailure.count) || 1) + 1 : 1;
  entry.lastFailure = { signature: sig, count };
  if (count >= 2) entry.repeatedFailure = count; else delete entry.repeatedFailure;
  return count;
}

// A pass ends the streak: a later failure is not "the same as last time".
function clearFailure(entry) {
  if (!entry) return;
  delete entry.lastFailure;
  delete entry.repeatedFailure;
}

// The fields a reset (retry, rework) keeps, so the next failure can be compared.
function carried(entry) {
  const out = {};
  if (entry?.lastFailure) out.lastFailure = entry.lastFailure;
  if (entry?.repeatedFailure) out.repeatedFailure = entry.repeatedFailure;
  return out;
}

function selftest() {
  // Timestamps, paths, attempt ids, hashes and durations do not make two failures different.
  const a = signature('verification/mobile-evidence: no booted Android emulator at 2026-11-03T10:00:01.123Z — log kept at .agentic-runs/FEAT-1/engine/verification-mobile-evidence.rejected (attempt FEAT-1-verification-mobile-evidence-2-1762164000123)');
  const b = signature('verification/mobile-evidence:  no booted Android emulator at 2026-11-04T08:12:44Z — log kept at /Users/x/p/.agentic-runs/FEAT-1/engine/other.rejected (attempt FEAT-1-verification-mobile-evidence-3-1762244000999)');
  assert.ok(a, 'an informative reason has a signature');
  assert.strictEqual(a, b);
  assert.strictEqual(signature('commit abc1234 failed after 12s'), signature('commit 9f8e7d6 failed after 3 s'));
  assert.notStrictEqual(signature('tests failed: 3 failing'), signature('lint failed: 3 problems'), 'different causes stay different');
  // Exit codes are causes, not noise.
  assert.notStrictEqual(signature('build exited with code 1: gradle'), signature('build exited with code 137: gradle'));
  // Reasons that say nothing about the cause are not compared.
  for (const vague of ['', null, 'node /Users/x/kit/ai/tasks/feature/mobile-evidence.js run FEAT-1 failed with exit 1', 'implementation/implementation: claude exited 1', 'codex exited 2', 'analysis/security: interrupted: SIGINT', 'claude timed out after 65 min', 'run-role exit 1', 'implementation/implementation: spawnSync /opt/homebrew/Cellar/node/26.11.1/bin/node ETIMEDOUT', 'spawnSync /usr/bin/node ENOBUFS', 'mobile-evidence exited SIGTERM', 'verification/mobile-evidence: mobile-evidence exited SIGKILL']) {
    assert.strictEqual(signature(vague), null, `uninformative: ${vague}`);
  }

  const entry = { status: 'blocked' };
  assert.strictEqual(recordFailure(entry, 'mobile-evidence: Appium server not reachable on 127.0.0.1:4723'), 1);
  assert.strictEqual(entry.repeatedFailure, undefined, 'one failure is not a repeat');
  assert.strictEqual(recordFailure(entry, 'mobile-evidence: Appium server not reachable on 127.0.0.1:4723'), 2);
  assert.strictEqual(entry.repeatedFailure, 2);
  assert.strictEqual(recordFailure(entry, 'mobile-evidence: Appium server not reachable on 127.0.0.1:4723'), 3);
  assert.deepStrictEqual(carried(entry), { lastFailure: entry.lastFailure, repeatedFailure: 3 }, 'a reset keeps the streak');
  assert.strictEqual(recordFailure(entry, 'mobile-evidence: no screenshots were captured'), 1, 'a new reason restarts the count');
  assert.strictEqual(entry.repeatedFailure, undefined);
  recordFailure(entry, 'mobile-evidence: no screenshots were captured');
  clearFailure(entry);
  assert.deepStrictEqual(entry, { status: 'blocked' }, 'a pass clears it');
  recordFailure(entry, 'x failed for a real reason');
  assert.strictEqual(recordFailure(entry, 'claude exited 1'), 0, 'an uninformative failure breaks the streak');
  assert.deepStrictEqual(carried(entry), {});
  console.log('repeated-failure selftest OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else { console.error('usage: repeated-failure.js --selftest'); process.exitCode = 1; }
}

module.exports = { signature, recordFailure, clearFailure, carried };
