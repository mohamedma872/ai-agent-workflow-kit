#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { inspect: inspectWorktree } = require('./worktree');
const { runtimeRoot, projectRoot, stateRoot } = require('./paths');

const ROOT = runtimeRoot();
const PROJECT_ROOT = projectRoot();
const RUNS = stateRoot();
const WORKFLOW_FILE = path.join(ROOT, 'ai', 'workflows', 'feature.yaml');
const CONTEXT = 'agentic-workflow-verification';
const TERMINAL_OK = new Set(['pass', 'skipped']);

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
function safeId(id) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id || ''); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function workflow() { return yaml.load(fs.readFileSync(WORKFLOW_FILE, 'utf8')) || {}; }
function runDir(id) { return path.join(RUNS, id); }
function stateFile(id) { return path.join(runDir(id), 'state.json'); }
function evidenceFile(id) { return path.join(runDir(id), 'device', 'evidence.json'); }
function summaryFile(id) { return path.join(runDir(id), 'engine', 'github-verification.json'); }
function equivalenceFile(id) { return path.join(runDir(id), '10-behavior-equivalence.json'); }
function git(root, args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
  if (res.error || res.status !== 0) return null;
  return String(res.stdout || '').trim();
}
function currentSha(id) {
  const wt = inspectWorktree(ROOT, id);
  if (wt?.currentSha) return { sha: wt.currentSha, productRoot: wt.path || wt.sourceRoot || PROJECT_ROOT, branch: wt.branch || null };
  return { sha: git(PROJECT_ROOT, ['rev-parse', 'HEAD']), productRoot: PROJECT_ROOT, branch: git(PROJECT_ROOT, ['branch', '--show-current']) || null };
}
function parseRepoSlug(value) {
  if (!value) return null;
  const text = String(value).trim().replace(/\.git$/, '');
  const m = text.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) return text;
  return null;
}
function detectRepo(productRoot, explicit) {
  const direct = parseRepoSlug(explicit || process.env.AI_WORKFLOW_GITHUB_REPO || process.env.GITHUB_REPOSITORY);
  if (direct) return direct;
  return parseRepoSlug(git(productRoot, ['remote', 'get-url', 'origin']));
}

function evaluateRun(id, state, options = {}) {
  const wf = options.workflow || workflow();
  const stages = (wf.stages || []).map(s => s.id);
  const phases = {};
  const problems = [];
  for (const stage of stages) {
    const status = state?.phases?.[stage]?.status || 'pending';
    phases[stage] = status;
    if (!TERMINAL_OK.has(status)) problems.push(`${stage}=${status}`);
  }
  if (phases.verification !== 'pass') problems.push(`final verification must be pass (got ${phases.verification || 'pending'})`);

  const identity = options.identity || currentSha(id);
  const expectedSha = options.expectedSha || null;
  if (!identity.sha) problems.push('unable to resolve run commit SHA');
  if (expectedSha && identity.sha !== expectedSha) problems.push(`commit SHA mismatch: run=${identity.sha} expected=${expectedSha}`);

  const mobile = state?.evidence?.mobileScreenshots || { requirement: 'unclassified' };
  const evidence = {
    requirement: mobile.requirement || 'unclassified',
    requiredPlatforms: mobile.execution?.platforms || mobile.platforms || [],
    executionStatus: mobile.execution?.status || null,
    attemptId: mobile.execution?.attemptId || null,
  };
  if (evidence.requirement === 'unclassified') problems.push('mobile evidence requirement is unclassified');
  if (evidence.requirement === 'not-required' && !mobile.reason) problems.push('mobile evidence marked not-required without a reason');
  if (evidence.requirement === 'required') {
    if (evidence.executionStatus !== 'pass') problems.push(`mobile evidence execution=${evidence.executionStatus || 'missing'}`);
    const att = options.attestation !== undefined ? options.attestation : readJson(evidenceFile(id));
    if (!att) problems.push('device/evidence.json is missing or invalid');
    else {
      if (att.runId !== id) problems.push('device/evidence.json runId mismatch');
      if (att.status !== 'pass') problems.push(`device/evidence.json status=${att.status || 'missing'}`);
      if (att.gitSha !== identity.sha) problems.push(`device/evidence.json gitSha mismatch: ${att.gitSha || 'missing'}`);
      if (evidence.attemptId && att.attemptId !== evidence.attemptId) problems.push('device/evidence.json attemptId mismatch');
      for (const platform of evidence.requiredPlatforms) {
        if (!(att.platforms || []).some(p => p?.platform === platform)) problems.push(`device/evidence.json missing ${platform} platform attestation`);
      }
    }
  }

  const refactorMode=state?.workflowMode?.mode==='behavior_preserving_refactor';
  const equivalence=refactorMode?(options.equivalence!==undefined?options.equivalence:readJson(equivalenceFile(id))):null;
  let refactor={mode:refactorMode?'behavior_preserving_refactor':'feature',verificationLevel:'not-applicable',unverifiedScenarioCount:0,unexpectedChangeCount:0};
  if(refactorMode){
    if(!equivalence) problems.push('behavior equivalence artifact is missing or invalid');
    else {
      refactor.verificationLevel=equivalence.fullyVerified===true?'full':'partial';
      refactor.unverifiedScenarioCount=(equivalence.unverifiedScenarios||[]).length;
      refactor.unexpectedChangeCount=(equivalence.unexpectedChanges||[]).length;
      if(equivalence.status!=='pass') problems.push(`behavior equivalence status=${equivalence.status||'missing'}`);
      if(refactor.unexpectedChangeCount) problems.push(`behavior equivalence has ${refactor.unexpectedChangeCount} unexpected change(s)`);
      if(equivalence.fullyVerified===true&&refactor.unverifiedScenarioCount) problems.push('behavior equivalence claims full verification with unverified scenarios');
    }
  }
  const success = problems.length === 0;
  return {
    success,
    problems,
    summary: {
      schemaVersion: 1,
      context: CONTEXT,
      runId: id,
      commitSha: identity.sha || null,
      branch: identity.branch || null,
      runtimeVersion: state?.runtime?.runtimeVersion || null,
      workflowFormatVersion: state?.runtime?.workflowFormatVersion ?? wf.version ?? null,
      artifactSchemaVersion: state?.runtime?.artifactSchemaVersion ?? null,
      status: success ? 'success' : 'failure',
      completedStages: stages.filter(stage => TERMINAL_OK.has(phases[stage])),
      phases,
      evidence,
      refactor,
      verifiedAt: new Date().toISOString(),
    },
    productRoot: identity.productRoot || PROJECT_ROOT,
  };
}

function writeSummary(id, summary) {
  const file = summaryFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
  return file;
}
function gh(args, options = {}) {
  const res = spawnSync('gh', args, { cwd: options.cwd || PROJECT_ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (res.error || res.status !== 0) throw new Error(res.error?.message || String(res.stderr || res.stdout || '').trim() || `gh exited ${res.status}`);
  return String(res.stdout || '').trim();
}
function latestContextStatus(repo, sha, productRoot) {
  try {
    const raw = gh(['api', `repos/${repo}/commits/${sha}/status`], { cwd: productRoot });
    const data = JSON.parse(raw || '{}');
    return (data.statuses || []).find(s => s.context === CONTEXT) || null;
  } catch { return null; }
}
function publish(id, options = {}) {
  if (!safeId(id)) throw new Error('invalid run id');
  const state = readJson(stateFile(id));
  if (!state) throw new Error(`run ${id} has no state.json`);
  const evaluated = evaluateRun(id, state, { expectedSha: options.sha || null });
  const file = writeSummary(id, evaluated.summary);
  const repo = detectRepo(evaluated.productRoot, options.repo);
  if (!repo) throw new Error('cannot determine GitHub repository; pass --repo owner/name');
  const sha = evaluated.summary.commitSha;
  if (!sha) throw new Error('cannot publish without a commit SHA');
  const stateName = evaluated.success ? 'success' : 'failure';
  const description = evaluated.success ? (evaluated.summary.refactor?.verificationLevel==='partial' ? `workflow ${id} verified; refactor behavior coverage partial` : `workflow ${id} verified`) : `workflow ${id} incomplete/invalid`;
  const payload = { repo, sha, context: CONTEXT, state: stateName, description, summaryFile: path.relative(PROJECT_ROOT, file) };
  if (options.dryRun) return { ...payload, published: false, dryRun: true, problems: evaluated.problems };
  if (spawnSync('which', ['gh'], { stdio: 'ignore' }).status !== 0) throw new Error('`gh` is not on PATH; install/authenticate GitHub CLI before publishing');
  const prior = latestContextStatus(repo, sha, evaluated.productRoot);
  if (prior && prior.state === stateName && prior.description === description) return { ...payload, published: false, unchanged: true, problems: evaluated.problems };
  const args = ['api', '--method', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${stateName}`, '-f', `context=${CONTEXT}`, '-f', `description=${description}`];
  if (options['target-url']) args.push('-f', `target_url=${options['target-url']}`);
  gh(args, { cwd: evaluated.productRoot });
  return { ...payload, published: true, problems: evaluated.problems };
}

function selftest() {
  const wf = { version: 1, stages: [{ id: 'request' }, { id: 'verification' }] };
  const base = {
    runtime: { runtimeVersion: '1.2.3', workflowFormatVersion: 1, artifactSchemaVersion: 1 },
    phases: { request: { status: 'pass' }, verification: { status: 'pass' } },
    evidence: { mobileScreenshots: { requirement: 'not-required', reason: 'backend-only' } },
  };
  const ok = evaluateRun('TEST', base, { workflow: wf, identity: { sha: 'abc123', productRoot: ROOT, branch: 'ai/run/TEST' }, expectedSha: 'abc123' });
  assert.strictEqual(ok.success, true);
  assert.deepStrictEqual(Object.keys(ok.summary).sort(), ['artifactSchemaVersion','branch','commitSha','completedStages','context','evidence','phases','refactor','runId','runtimeVersion','schemaVersion','status','verifiedAt','workflowFormatVersion'].sort());
  const stale = evaluateRun('TEST', base, { workflow: wf, identity: { sha: 'abc123', productRoot: ROOT }, expectedSha: 'other' });
  assert.strictEqual(stale.success, false);
  const mobile = JSON.parse(JSON.stringify(base));
  mobile.evidence.mobileScreenshots = { requirement: 'required', execution: { status: 'pass', attemptId: 'ATT', platforms: ['android', 'ios'] } };
  const missing = evaluateRun('TEST', mobile, { workflow: wf, identity: { sha: 'abc123', productRoot: ROOT }, attestation: { runId: 'TEST', attemptId: 'ATT', status: 'pass', gitSha: 'abc123', platforms: [{ platform: 'android' }] } });
  assert.strictEqual(missing.success, false);
  assert(missing.problems.some(p => p.includes('ios')));
  const refactorState=JSON.parse(JSON.stringify(base));refactorState.workflowMode={mode:'behavior_preserving_refactor'};
  const partial=evaluateRun('TEST',refactorState,{workflow:wf,identity:{sha:'abc123',productRoot:ROOT},equivalence:{status:'pass',fullyVerified:false,unverifiedScenarios:['cold start'],unexpectedChanges:[]}});
  assert.strictEqual(partial.success,true);assert.strictEqual(partial.summary.refactor.verificationLevel,'partial');
  const bad=evaluateRun('TEST',refactorState,{workflow:wf,identity:{sha:'abc123',productRoot:ROOT},equivalence:{status:'pass',fullyVerified:true,unverifiedScenarios:['cold start'],unexpectedChanges:[]}});
  assert.strictEqual(bad.success,false);
  assert.strictEqual(parseRepoSlug('git@github.com:owner/repo.git'), 'owner/repo');
  assert.strictEqual(parseRepoSlug('https://github.com/owner/repo.git'), 'owner/repo');
  console.log('github verification selftest OK');
}

const args = parseArgs(process.argv.slice(2));
const [cmd, id] = args._;
try {
  if (cmd === 'selftest' || cmd === '--selftest') selftest();
  else if (cmd === 'build') {
    if (!safeId(id)) throw new Error('usage: github-verification.js build <run-id> [--sha SHA]');
    const state = readJson(stateFile(id)); if (!state) throw new Error(`run ${id} has no state.json`);
    const result = evaluateRun(id, state, { expectedSha: args.sha || null });
    writeSummary(id, result.summary);
    console.log(JSON.stringify({ ...result.summary, problems: result.problems }, null, 2));
    if (!result.success) process.exitCode = 1;
  } else if (cmd === 'publish') {
    const result = publish(id, { repo: args.repo, sha: args.sha, dryRun: !!args['dry-run'], 'target-url': args['target-url'] });
    console.log(JSON.stringify(result, null, 2));
    if (result.state !== 'success') process.exitCode = 1;
  } else throw new Error('usage: github-verification.js build <run-id> [--sha SHA] | publish <run-id> [--repo owner/name] [--sha SHA] [--target-url URL] [--dry-run] | selftest');
} catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }

module.exports = { CONTEXT, evaluateRun, parseRepoSlug, detectRepo, publish };
