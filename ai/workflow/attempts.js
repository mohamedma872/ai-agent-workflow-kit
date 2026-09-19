#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stateFile(root, runId) { return path.join(root, 'ai', 'runs', runId, 'state.json'); }

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function loadState(root, runId) {
  return JSON.parse(fs.readFileSync(stateFile(root, runId), 'utf8'));
}

function attemptsFor(state, phase, role) {
  return state.executionAttempts?.[phase]?.[role] || [];
}

function recordAttempt(root, runId, phase, role, entry) {
  const file = stateFile(root, runId);
  if (!fs.existsSync(file)) throw new Error(`state missing for run ${runId}`);
  const state = loadState(root, runId);
  state.executionAttempts ||= {};
  state.executionAttempts[phase] ||= {};
  state.executionAttempts[phase][role] ||= [];
  if (state.executionAttempts[phase][role].some(x => x.attemptId === entry.attemptId)) throw new Error(`duplicate attemptId ${entry.attemptId}`);
  state.executionAttempts[phase][role].push({ ...entry });
  state.history ||= [];
  state.history.push({
    at: entry.completedAt || new Date().toISOString(),
    actor: 'workflow-engine',
    kind: 'execution-attempt',
    phase,
    role,
    attemptId: entry.attemptId,
    executor: entry.executor,
    status: entry.status,
    exitType: entry.exitType,
    reason: entry.reason || null,
  });
  state.updatedAt = new Date().toISOString();
  atomicWrite(file, state);
  return state.executionAttempts[phase][role];
}

function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-attempts-'));
  const runId = 'TEST';
  const file = stateFile(root, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: runId, history: [] }));
  const first = { attemptId: 'a1', attemptNumber: 1, executor: 'codex', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:10Z', status: 'fail', exitType: 'timeout', reason: 'timeout' };
  recordAttempt(root, runId, 'implementation', 'implementation', first);
  let state = loadState(root, runId);
  assert.strictEqual(attemptsFor(state, 'implementation', 'implementation').length, 1);
  assert.strictEqual(attemptsFor(state, 'implementation', 'implementation')[0].executor, 'codex');
  assert.throws(() => recordAttempt(root, runId, 'implementation', 'implementation', first), /duplicate/);
  const second = { ...first, attemptId: 'a2', attemptNumber: 2, executor: 'claude', status: 'pass', exitType: 'success' };
  recordAttempt(root, runId, 'implementation', 'implementation', second);
  state = loadState(root, runId);
  assert.strictEqual(attemptsFor(state, 'implementation', 'implementation').length, 2);
  assert.strictEqual(state.history.filter(x => x.kind === 'execution-attempt').length, 2);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('workflow attempts selftest OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else { console.error('usage: attempts.js --selftest'); process.exitCode = 1; }
}

module.exports = { stateFile, atomicWrite, loadState, attemptsFor, recordAttempt };
