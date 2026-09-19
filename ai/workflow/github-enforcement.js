#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');

const REQUIRED_CONTEXTS = ['validate', 'agentic-workflow-verification'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
function repoSlug(value) {
  const text = String(value || '').trim().replace(/\.git$/, '');
  const m = text.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) return text;
  return null;
}
function gh(args, options = {}) {
  const res = spawnSync('gh', args, { encoding: 'utf8', input: options.input || undefined, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (res.error || res.status !== 0) throw new Error(res.error?.message || String(res.stderr || res.stdout || '').trim() || `gh exited ${res.status}`);
  return String(res.stdout || '').trim();
}
function detectRepo(explicit) {
  const fromArgs = repoSlug(explicit || process.env.AI_WORKFLOW_GITHUB_REPO || process.env.GITHUB_REPOSITORY);
  if (fromArgs) return fromArgs;
  try { return repoSlug(gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])); } catch { return null; }
}
function protectionPayload() {
  return {
    required_status_checks: { strict: true, contexts: [...REQUIRED_CONTEXTS] },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
    },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: true,
  };
}
function contextsFromProtection(data) {
  const required = data?.required_status_checks || {};
  const contexts = new Set(required.contexts || []);
  for (const check of required.checks || []) if (check?.context) contexts.add(check.context);
  return [...contexts];
}
function inspectProtection(data) {
  const contexts = contextsFromProtection(data);
  const missing = REQUIRED_CONTEXTS.filter(c => !contexts.includes(c));
  const problems = [];
  if (!data || typeof data !== 'object') problems.push('branch protection response missing');
  if (data?.required_status_checks?.strict !== true) problems.push('required status checks are not strict/up-to-date');
  if (missing.length) problems.push(`missing required status context(s): ${missing.join(', ')}`);
  if (data?.required_conversation_resolution?.enabled !== true) problems.push('required conversation resolution is not enabled');
  if (data?.allow_force_pushes?.enabled === true) problems.push('force pushes are allowed');
  if (data?.allow_deletions?.enabled === true) problems.push('branch deletion is allowed');
  return { ok: problems.length === 0, contexts, missing, problems };
}
function readProtection(repo, branch) {
  const raw = gh(['api', `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`]);
  return JSON.parse(raw || '{}');
}
function check(repo, branch) {
  const data = readProtection(repo, branch);
  const result = inspectProtection(data);
  if (!result.ok) {
    result.problems.forEach(p => console.error(`✗ ${p}`));
    return 1;
  }
  console.log(`✓ ${repo}:${branch} requires ${REQUIRED_CONTEXTS.join(' + ')} with strict status checks and conversation resolution`);
  return 0;
}
function apply(repo, branch, options = {}) {
  const payload = protectionPayload();
  if (options.dryRun) {
    console.log(JSON.stringify({ repo, branch, endpoint: `repos/${repo}/branches/${branch}/protection`, payload }, null, 2));
    return 0;
  }
  gh(['api', '--method', 'PUT', `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`, '--input', '-'], { input: JSON.stringify(payload) });
  return check(repo, branch);
}
function explainBlockedMerge() {
  console.log('A PR head is mergeable only after both required contexts are success:');
  for (const context of REQUIRED_CONTEXTS) console.log(`- ${context}`);
  console.log('`agentic-workflow-verification` is published for the exact PR head SHA, so a new commit makes the previous workflow result stale for merge purposes.');
}
function selftest() {
  const good = {
    required_status_checks: { strict: true, contexts: ['validate'], checks: [{ context: 'agentic-workflow-verification' }] },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
  assert.strictEqual(inspectProtection(good).ok, true);
  const absent = JSON.parse(JSON.stringify(good)); absent.required_status_checks.checks = [];
  assert.strictEqual(inspectProtection(absent).ok, false);
  assert(inspectProtection(absent).missing.includes('agentic-workflow-verification'));
  const loose = JSON.parse(JSON.stringify(good)); loose.required_status_checks.strict = false;
  assert(inspectProtection(loose).problems.some(p => /strict/.test(p)));
  const payload = protectionPayload();
  assert.deepStrictEqual(payload.required_status_checks.contexts, REQUIRED_CONTEXTS);
  assert.strictEqual(payload.required_conversation_resolution, true);
  console.log('GitHub merge enforcement selftest OK');
}

const args = parseArgs(process.argv.slice(2));
const [cmd] = args._;
try {
  if (cmd === 'selftest' || cmd === '--selftest') selftest();
  else if (cmd === 'explain') explainBlockedMerge();
  else {
    const repo = detectRepo(args.repo);
    const branch = String(args.branch || 'main');
    if (!repo) throw new Error('cannot determine repository; pass --repo owner/name');
    if (cmd === 'check') process.exitCode = check(repo, branch);
    else if (cmd === 'apply') process.exitCode = apply(repo, branch, { dryRun: !!args['dry-run'] });
    else throw new Error('usage: github-enforcement.js check|apply|explain [--repo owner/name] [--branch main] [--dry-run] | selftest');
  }
} catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }

module.exports = { REQUIRED_CONTEXTS, protectionPayload, contextsFromProtection, inspectProtection };
