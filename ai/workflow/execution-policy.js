#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const EXIT_TYPES = new Set(['success', 'timeout', 'transient', 'deterministic', 'policy', 'unavailable']);
const RETRYABLE = new Set(['timeout', 'transient', 'unavailable']);

function parseDuration(value, fallbackMs = 60 * 60 * 1000) {
  if (value === undefined || value === null || value === '') return fallbackMs;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) throw new Error(`invalid duration "${value}"; use ms, s, m, or h`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
  return Math.round(amount * factor);
}

function resolveExecutionPolicy(workflow, stage, roleName) {
  const role = workflow.roles?.[roleName] || {};
  const merged = { timeout: '60m', max_attempts: 1, retry_on: [], backoff: '0s', ...(workflow.execution_defaults || {}), ...(role.execution || {}), ...(stage.execution || {}) };
  const maxAttempts = Number(merged.max_attempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error(`${stage.id}/${roleName}: max_attempts must be an integer from 1 to 10`);
  const retryOn = Array.isArray(merged.retry_on) ? [...new Set(merged.retry_on.map(String))] : [];
  for (const type of retryOn) if (!RETRYABLE.has(type)) throw new Error(`${stage.id}/${roleName}: retry_on contains unsupported exit type ${type}`);
  const candidates = [role.executor, ...(role.fallback || [])].filter(Boolean);
  if (!candidates.length) throw new Error(`${stage.id}/${roleName}: no executor candidate`);
  return { timeoutMs: parseDuration(merged.timeout), maxAttempts, retryOn, backoffMs: parseDuration(merged.backoff, 0), candidates: [...new Set(candidates)] };
}

function classifyFailure(result) {
  const error = result?.error;
  const stderr = String(result?.stderr || '');
  const stdout = String(result?.stdout || '');
  const text = `${stderr}\n${stdout}`;
  if (error && (error.code === 'ETIMEDOUT' || /timed?\s*out/i.test(error.message || ''))) return 'timeout';
  if (result?.signal === 'SIGTERM' && /timeout/i.test(text)) return 'timeout';
  if (/guard-engine failure|\[ai-guard\]|permissionDecision.*deny|policy denial|plan gate:/i.test(text)) return 'policy';
  if (/not on PATH|command not found|ENOENT|unknown executor|no executor/i.test(text)) return 'unavailable';
  if (/\b(429|502|503|504)\b|rate limit|temporar(?:y|ily)|ECONNRESET|EAI_AGAIN|socket hang up|network.*unavailable|service unavailable/i.test(text)) return 'transient';
  return 'deterministic';
}

function executorForAttempt(policy, attemptNumber) {
  const index = Math.max(0, Math.min(policy.candidates.length - 1, attemptNumber - 1));
  return policy.candidates[index];
}
function canRetry(policy, exitType, attemptsUsed) { return attemptsUsed < policy.maxAttempts && policy.retryOn.includes(exitType); }
function resumeDecision(policy, attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) return { allowed: true, nextAttempt: 1, reason: 'no previous attempt' };
  const last = list[list.length - 1];
  if (last.status === 'pass' || last.exitType === 'success') return { allowed: false, complete: true, reason: 'role already completed successfully' };
  if (list.length >= policy.maxAttempts) return { allowed: false, exhausted: true, reason: `max attempts exhausted (${list.length}/${policy.maxAttempts})` };
  if (!policy.retryOn.includes(last.exitType)) return { allowed: false, deterministic: true, reason: `last failure type ${last.exitType} is not retryable` };
  return { allowed: true, nextAttempt: list.length + 1, reason: `resume retry after ${last.exitType}` };
}
function sleep(ms) { if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function executeWithPolicy(policy, previousAttempts, runAttempt, onRecord = () => {}, sleepFn = sleep) {
  const previous = Array.isArray(previousAttempts) ? previousAttempts : [];
  const decision = resumeDecision(policy, previous);
  if (!decision.allowed) return { ok: !!decision.complete, skipped: !!decision.complete, reason: decision.reason, attempts: [] };
  const newAttempts = [];
  for (let attemptNumber = decision.nextAttempt; attemptNumber <= policy.maxAttempts; attemptNumber++) {
    const executor = executorForAttempt(policy, attemptNumber);
    const startedAt = new Date().toISOString();
    let outcome;
    try { outcome = runAttempt({ executor, attemptNumber, timeoutMs: policy.timeoutMs }); }
    catch (error) { outcome = { ok: false, exitType: 'deterministic', reason: error.message, error }; }
    if (!outcome || typeof outcome.ok !== 'boolean') throw new Error('runAttempt must return {ok,...}');
    const exitType = outcome.ok ? 'success' : String(outcome.exitType || 'deterministic');
    if (!EXIT_TYPES.has(exitType)) throw new Error(`runAttempt returned unknown exit type ${exitType}`);
    const entry = {
      attemptId: outcome.attemptId || `attempt-${attemptNumber}-${Date.now()}`,
      attemptNumber,
      executor,
      startedAt: outcome.startedAt || startedAt,
      completedAt: outcome.completedAt || new Date().toISOString(),
      status: outcome.ok ? 'pass' : 'fail',
      exitType,
      reason: outcome.reason || null,
    };
    newAttempts.push(entry);
    onRecord(entry, outcome);
    if (outcome.ok) return { ok: true, value: outcome.value, attempts: newAttempts };
    const attemptsUsed = previous.length + newAttempts.length;
    if (!canRetry(policy, exitType, attemptsUsed)) return { ok: false, reason: outcome.reason || `${exitType} failure`, exitType, attempts: newAttempts };
    sleepFn(policy.backoffMs);
  }
  return { ok: false, reason: 'max attempts exhausted', exitType: newAttempts.at(-1)?.exitType || 'deterministic', attempts: newAttempts };
}

function validateExecutionConfig(workflow) {
  const errors = [];
  const validate = (where, config) => {
    if (!config) return;
    try { parseDuration(config.timeout); } catch (e) { errors.push(`${where}: ${e.message}`); }
    try { parseDuration(config.backoff, 0); } catch (e) { errors.push(`${where}: ${e.message}`); }
    if (config.max_attempts !== undefined && (!Number.isInteger(Number(config.max_attempts)) || Number(config.max_attempts) < 1 || Number(config.max_attempts) > 10)) errors.push(`${where}: max_attempts must be an integer from 1 to 10`);
    if (config.retry_on !== undefined) {
      if (!Array.isArray(config.retry_on)) errors.push(`${where}: retry_on must be an array`);
      else for (const type of config.retry_on) if (!RETRYABLE.has(String(type))) errors.push(`${where}: unsupported retry_on value ${type}`);
    }
  };
  validate('execution_defaults', workflow.execution_defaults);
  for (const [name, role] of Object.entries(workflow.roles || {})) validate(`role ${name}.execution`, role.execution);
  for (const stage of workflow.stages || []) validate(`stage ${stage.id}.execution`, stage.execution);
  return errors;
}
function checkFile(file) {
  let workflow;
  try { workflow = yaml.load(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { console.error(`✗ ${file}: ${e.message}`); return 1; }
  const errors = validateExecutionConfig(workflow);
  if (errors.length) { errors.forEach(e => console.error(`✗ ${e}`)); return 1; }
  console.log('✓ workflow execution retry/timeout/fallback policy valid');
  return 0;
}

function selftest() {
  assert.strictEqual(parseDuration('20m'), 1200000);
  assert.strictEqual(parseDuration('5s'), 5000);
  assert.throws(() => parseDuration('five minutes'), /invalid duration/);
  const wf = { execution_defaults: { timeout: '20m', max_attempts: 2, retry_on: ['timeout', 'transient'], backoff: '1s' }, roles: { implementation: { executor: 'codex', fallback: ['claude'] } } };
  const policy = resolveExecutionPolicy(wf, { id: 'implementation' }, 'implementation');
  assert.deepStrictEqual(policy.candidates, ['codex', 'claude']);
  assert.strictEqual(executorForAttempt(policy, 1), 'codex');
  assert.strictEqual(executorForAttempt(policy, 2), 'claude');
  assert.strictEqual(canRetry(policy, 'timeout', 1), true);
  assert.strictEqual(canRetry(policy, 'deterministic', 1), false);
  assert.strictEqual(resumeDecision(policy, [{ status: 'fail', exitType: 'timeout' }]).nextAttempt, 2);
  assert.strictEqual(resumeDecision(policy, [{ status: 'fail', exitType: 'deterministic' }]).allowed, false);
  assert.strictEqual(classifyFailure({ status: 1, stderr: 'HTTP 503 service unavailable' }), 'transient');
  assert.strictEqual(classifyFailure({ status: 1, stderr: '[ai-guard] plan gate: denied' }), 'policy');
  const seen = [];
  const fallback = executeWithPolicy(policy, [], ({ executor, attemptNumber }) => { seen.push(executor); return attemptNumber === 1 ? { ok: false, exitType: 'timeout', reason: 'timed out', attemptId: 'a1' } : { ok: true, value: 'done', attemptId: 'a2' }; }, () => {}, () => {});
  assert.strictEqual(fallback.ok, true);
  assert.deepStrictEqual(seen, ['codex', 'claude']);
  assert.deepStrictEqual(fallback.attempts.map(x => x.attemptId), ['a1', 'a2']);
  const deterministic = executeWithPolicy(policy, [], () => ({ ok: false, exitType: 'deterministic', reason: 'bad test' }), () => {}, () => {});
  assert.strictEqual(deterministic.attempts.length, 1);
  const exhausted = executeWithPolicy(policy, [], () => ({ ok: false, exitType: 'transient', reason: '503' }), () => {}, () => {});
  assert.strictEqual(exhausted.attempts.length, 2);
  const resumed = executeWithPolicy(policy, [{ status: 'fail', exitType: 'timeout' }], ({ executor }) => ({ ok: true, value: executor }), () => {}, () => {});
  assert.strictEqual(resumed.value, 'claude');
  const completed = executeWithPolicy(policy, [{ status: 'pass', exitType: 'success' }], () => { throw new Error('must not rerun'); });
  assert.strictEqual(completed.skipped, true);
  assert.deepStrictEqual(validateExecutionConfig(wf), []);
  console.log('execution policy selftest OK');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) selftest();
  else if (args[0] === 'check') process.exitCode = checkFile(path.resolve(args[1] || path.join(__dirname, '..', 'workflows', 'feature.yaml')));
  else { console.error('usage: execution-policy.js --selftest | check [workflow.yaml]'); process.exitCode = 1; }
}

module.exports = { EXIT_TYPES, RETRYABLE, parseDuration, resolveExecutionPolicy, classifyFailure, executorForAttempt, canRetry, resumeDecision, executeWithPolicy, validateExecutionConfig };
