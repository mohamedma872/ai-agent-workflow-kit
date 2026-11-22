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
  // A usage limit, exhausted credits or a billing stop means this executor
  // cannot run at all right now, however well-formed the work is. Classifying
  // it as deterministic strands the role on an executor that has nothing left
  // and makes the configured fallback unreachable in the one case it exists
  // for, so the run stops with "exited 1" instead of switching agents.
  if (/usage limit|usage_limit_exceeded|insufficient_quota|quota exceeded|out of credits|credit balance|billing/i.test(text)) return 'unavailable';
  if (/\b(429|502|503|504)\b|rate limit|temporar(?:y|ily)|ECONNRESET|EAI_AGAIN|socket hang up|network.*unavailable|service unavailable/i.test(text)) return 'transient';
  return 'deterministic';
}

function executorForAttempt(policy, attemptNumber) {
  const index = Math.max(0, Math.min(policy.candidates.length - 1, attemptNumber - 1));
  return policy.candidates[index];
}
function canRetry(policy, exitType, attemptsUsed) { return attemptsUsed < policy.maxAttempts && policy.retryOn.includes(exitType); }

// An executor that could not run at all (usage limit, not installed, wrote
// nothing) did no work, so its attempt is free: it hands the role to the next
// candidate without spending the budget. Before, codex out of quota spent
// attempt 1 of 2 on every codex-first role, the fallback got a single try, and
// one transient error from it stopped the run until a human typed retry — on
// every stage, in every parallel run. Each executor is skipped for the rest of
// the role once it was unavailable, so free attempts are bounded by the
// candidate list. `policy.limited` (executors another run found out of quota)
// is skipped too, unless that would leave nothing to try.
function attemptPlan(policy, attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const spent = list.filter(a => a.exitType !== 'unavailable');
  const failedHere = new Set(list.filter(a => a.exitType === 'unavailable').map(a => a.executor));
  const open = policy.candidates.filter(c => !failedHere.has(c));
  const limited = policy.limited instanceof Set ? policy.limited : new Set(policy.limited || []);
  const preferred = open.filter(c => !limited.has(c));
  const usable = preferred.length ? preferred : open;
  return { spent: spent.length, usable, executor: usable.length ? usable[Math.min(spent.length, usable.length - 1)] : null };
}
function resumeDecision(policy, attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) return { allowed: true, nextAttempt: 1, reason: 'no previous attempt' };
  const last = list[list.length - 1];
  if (last.status === 'pass' || last.exitType === 'success') return { allowed: false, complete: true, reason: 'role already completed successfully' };
  const plan = attemptPlan(policy, list);
  if (plan.spent >= policy.maxAttempts) return { allowed: false, exhausted: true, reason: `max attempts exhausted (${plan.spent}/${policy.maxAttempts})` };
  if (!policy.retryOn.includes(last.exitType)) return { allowed: false, deterministic: true, reason: `last failure type ${last.exitType} is not retryable` };
  if (!plan.executor) return { allowed: false, exhausted: true, reason: `no executor left to try: ${last.reason || 'every candidate was unavailable'}` };
  return { allowed: true, nextAttempt: list.length + 1, reason: `resume retry after ${last.exitType}` };
}

// Usage limits are shared by every run on this machine, so the first run that
// meets one records it under the state root and the other runs go straight to
// the fallback until the reset time the executor printed (or an hour).
const USAGE_LIMIT = /usage limit|usage_limit_exceeded|insufficient_quota|quota exceeded|out of credits|credit balance/i;
function limitResetAt(text, now = new Date()) {
  const m = String(text || '').match(/try again (?:at|after)\s+(\d{1,2})(?::(\d{2}))?\s*([AP]M)?/i);
  if (!m) return new Date(now.getTime() + 60 * 60 * 1000);
  let hour = Number(m[1]) % 24;
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const at = new Date(now); at.setHours(hour, Number(m[2] || 0), 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}
function limitsFile(dir) { return path.join(dir, '_executor-limits.json'); }
function readExecutorLimits(dir, now = new Date()) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(limitsFile(dir), 'utf8')) || {}; } catch { return {}; }
  const live = {};
  for (const [executor, entry] of Object.entries(all)) if (entry && Date.parse(entry.until) > now.getTime()) live[executor] = entry;
  return live;
}
function recordExecutorLimit(dir, executor, text, now = new Date()) {
  if (!executor || !USAGE_LIMIT.test(String(text || ''))) return null;
  const line = String(text).split(/\r?\n/).map(s => s.trim()).find(s => USAGE_LIMIT.test(s)) || 'usage limit';
  const entry = { until: limitResetAt(text, now).toISOString(), reason: line.slice(0, 300), at: now.toISOString() };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const next = { ...readExecutorLimits(dir, now), [executor]: entry };
    const tmp = `${limitsFile(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, limitsFile(dir));
  } catch { /* best effort: the next attempt finds the limit again */ }
  return entry;
}
function sleep(ms) { if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function executeWithPolicy(policy, previousAttempts, runAttempt, onRecord = () => {}, sleepFn = sleep) {
  const previous = Array.isArray(previousAttempts) ? previousAttempts : [];
  const decision = resumeDecision(policy, previous);
  if (!decision.allowed) return { ok: !!decision.complete, skipped: !!decision.complete, reason: decision.reason, attempts: [] };
  const newAttempts = [];
  for (let attemptNumber = decision.nextAttempt; ; attemptNumber++) {
    const plan = attemptPlan(policy, [...previous, ...newAttempts]);
    if (plan.spent >= policy.maxAttempts) break;
    const executor = plan.executor;
    if (!executor) return { ok: false, reason: `no executor left to try: ${newAttempts.at(-1)?.reason || 'every candidate was unavailable'}`, exitType: 'unavailable', attempts: newAttempts };
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
    const attemptsUsed = attemptPlan(policy, [...previous, ...newAttempts]).spent;
    if (!policy.retryOn.includes(exitType)) return { ok: false, reason: outcome.reason || `${exitType} failure`, exitType, attempts: newAttempts };
    if (exitType !== 'unavailable' && !canRetry(policy, exitType, attemptsUsed)) return { ok: false, reason: outcome.reason || `${exitType} failure`, exitType, attempts: newAttempts };
    if (exitType !== 'unavailable') sleepFn(policy.backoffMs);
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
  // A real codex exhaustion, as the router now surfaces it: retryable, so the
  // configured fallback executor is reached instead of the run stopping.
  assert.strictEqual(classifyFailure({ status: 1, stderr: "codex: usage_limit_exceeded: You've hit your usage limit." }), 'unavailable');
  assert.strictEqual(classifyFailure({ status: 1, stderr: 'claude: Credit balance is too low' }), 'unavailable');
  assert.strictEqual(classifyFailure({ status: 1, stderr: 'flutter test: 1 test failed' }), 'deterministic');
  const limited = { execution_defaults: { timeout: '20m', max_attempts: 2, retry_on: ['timeout', 'transient', 'unavailable'], backoff: '1s' }, roles: { implementation: { executor: 'codex', fallback: ['claude'] } } };
  const limitedPolicy = resolveExecutionPolicy(limited, { id: 'implementation' }, 'implementation');
  assert.strictEqual(canRetry(limitedPolicy, 'unavailable', 1), true);
  const switched = [];
  const afterLimit = executeWithPolicy(limitedPolicy, [], ({ executor, attemptNumber }) => { switched.push(executor); return attemptNumber === 1 ? { ok: false, exitType: 'unavailable', reason: 'usage limit', attemptId: 'u1' } : { ok: true, value: executor, attemptId: 'u2' }; }, () => {}, () => {});
  assert.strictEqual(afterLimit.ok, true);
  assert.deepStrictEqual(switched, ['codex', 'claude'], 'an exhausted executor hands the work to its fallback');
  // An executor that could not run does not spend the budget: codex out of
  // quota, then one transient failure from claude, still leaves claude a try.
  const budget = [];
  const freeAttempt = executeWithPolicy(limitedPolicy, [], ({ executor }) => {
    budget.push(executor);
    if (executor === 'codex') return { ok: false, exitType: 'unavailable', reason: 'usage limit' };
    return budget.length === 2 ? { ok: false, exitType: 'transient', reason: '529 overloaded' } : { ok: true, value: executor };
  }, () => {}, () => {});
  assert.strictEqual(freeAttempt.ok, true, 'a quota failure must not use up the fallback\'s retry');
  assert.deepStrictEqual(budget, ['codex', 'claude', 'claude']);
  // Resuming after that pair is allowed, and goes to claude, not back to codex.
  const afterPair = [{ executor: 'codex', status: 'fail', exitType: 'unavailable' }, { executor: 'claude', status: 'fail', exitType: 'transient' }];
  assert.strictEqual(resumeDecision(limitedPolicy, afterPair).allowed, true);
  assert.strictEqual(attemptPlan(limitedPolicy, afterPair).executor, 'claude');
  // Two real failures still exhaust it.
  assert.strictEqual(resumeDecision(limitedPolicy, [...afterPair, { executor: 'claude', status: 'fail', exitType: 'transient' }]).exhausted, true);
  // Every candidate unavailable ends the role with the reason, without looping.
  const none = executeWithPolicy(limitedPolicy, [], ({ executor }) => ({ ok: false, exitType: 'unavailable', reason: `${executor} usage limit` }), () => {}, () => {});
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.attempts.length, 2);
  assert.match(none.reason, /no executor left to try: claude usage limit/);
  // A limit another run recorded sends this run straight to the fallback,
  // unless that leaves nothing to try.
  assert.strictEqual(attemptPlan({ ...limitedPolicy, limited: new Set(['codex']) }, []).executor, 'claude');
  assert.strictEqual(attemptPlan({ ...limitedPolicy, limited: new Set(['codex', 'claude']) }, []).executor, 'codex');
  // Reset time: the executor's own "try again at", else an hour.
  const noon = new Date(2026, 10, 21, 12, 0, 0);
  assert.strictEqual(limitResetAt('try again at 4:40 PM.', noon).getTime(), new Date(2026, 10, 21, 16, 40).getTime());
  assert.strictEqual(limitResetAt('try again at 9:15 AM', noon).getTime(), new Date(2026, 10, 22, 9, 15).getTime());
  assert.strictEqual(limitResetAt('quota exceeded', noon).getTime(), noon.getTime() + 3600000);
  const os = require('os');
  const limitsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-limits-'));
  assert.strictEqual(recordExecutorLimit(limitsDir, 'codex', 'flutter test: 1 test failed', noon), null, 'only a usage limit is recorded');
  const rec = recordExecutorLimit(limitsDir, 'codex', "boot\ncodex: You've hit your usage limit. try again at 4:40 PM.", noon);
  assert.match(rec.reason, /^codex: You've hit your usage limit/);
  assert.deepStrictEqual(Object.keys(readExecutorLimits(limitsDir, noon)), ['codex']);
  assert.deepStrictEqual(readExecutorLimits(limitsDir, new Date(2026, 10, 21, 16, 41)), {}, 'an expired limit is ignored');
  fs.rmSync(limitsDir, { recursive: true, force: true });
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

module.exports = { EXIT_TYPES, RETRYABLE, parseDuration, resolveExecutionPolicy, classifyFailure, executorForAttempt, canRetry, attemptPlan, resumeDecision, executeWithPolicy, validateExecutionConfig, limitResetAt, readExecutorLimits, recordExecutorLimit };
