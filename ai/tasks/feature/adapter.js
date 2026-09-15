'use strict';
/*
 * Eval adapter for the `feature` task — the /feature agentic workflow.
 *
 * Claude Code only (the workflow uses .claude/agents subagents). execute()
 * runs `claude -p "/feature <prompt>"` with AI_EVAL=1 and FEATURE_RUN_ID set,
 * waits, then captures: the run folder ai/runs/<id>/ (copied to
 * runDir/artifacts/), the diff, the final answer, verify results; restores
 * the tree and closes the run. collect() checks constraints incl.
 * required_artifacts and exposes each artifact as an output of kind
 * "artifact" whose text starts with its relative name.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const { helpers } = require(path.join(ROOT, 'ai', 'tasks', 'coding', 'adapter.js'));
const { globToRegex } = require(path.join(ROOT, 'ai', 'guard', 'engine.js'));
const { changedFiles, fullDiff, restore, fill, answerFrom } = helpers;

function readJSON(f) { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } }

function listFiles(dir, base = '') {
  if (!fs.existsSync(dir)) {return [];}
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {out.push(...listFiles(path.join(dir, e.name), rel));} else {out.push(rel);}
  }
  return out;
}

module.exports = {
  name: 'feature',
  description: 'The /feature agentic workflow (orchestrator + subagents): requirements → AC → DoD → analyses → plan gate → implementation → tests → reviews → verification; graded on artifacts + end state',
  entry: 'claude -p "/feature <prompt>"',
  resultsDir: 'ai/evals/results/feature',
  agents: ['claude'],
  defaults: { agent: 'claude', budget: 12, timeoutMin: 45, permissionMode: 'bypassPermissions' },

  preflight(opts) {
    if (!opts.agent || opts.agent.name !== 'claude') {throw new Error('the feature workflow runs on Claude Code only (subagents in .claude/agents)');}
    if (spawnSync('which', ['claude']).status !== 0) {throw new Error('`claude` is not on PATH');}
    if (fs.existsSync(path.join(RUNS, '_active'))) {throw new Error('a /feature run is still active (ai/runs/_active) — close it first: node ai/tasks/feature/runs.js close');}
  },

  describe(c) { return `${c.target || c.case_id}`; },

  execute(c, runDir, opts, ctx) {
    const runId = `eval-${c.case_id}-${(ctx && ctx.runId ? ctx.runId.split('-').pop() : Date.now())}`;
    const prompt = `/feature ${String(c.prompt || '').trim()}`;
    const lastMessageFile = path.join(runDir, 'last-message.txt');
    const argv = opts.agent.command.map(a => fill(a, { prompt, budget: opts.budget, cwd: ROOT, last_message_file: lastMessageFile }));
    const meta = { agent: opts.agent.name, feature_run_id: runId, command: argv.map(a => (/\s/.test(a) ? JSON.stringify(a.length > 80 ? `${a.slice(0, 77)}…` : a) : a)).join(' ') };
    if (opts.dryRun) {return meta;}
    const before = changedFiles();
    if (before.length) {throw new Error(`working tree not clean before the trial: ${before.map(b => b.file).join(', ')}`);}
    const t0 = Date.now();
    const res = spawnSync(argv[0], argv.slice(1), {
      cwd: ROOT,
      env: { ...process.env, AI_EVAL: '1', FEATURE_RUN_ID: runId },
      encoding: 'utf8',
      timeout: opts.timeoutMin * 60 * 1000,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    meta.wall_min = +((Date.now() - t0) / 60000).toFixed(2);
    meta.exit_status = res.status;
    meta.timed_out = !!(res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGTERM';
    if (res.error && !meta.timed_out) {meta.spawn_error = res.error.message;}
    fs.writeFileSync(path.join(runDir, 'agent-stderr.log'), res.stderr || '');
    const { answer, json } = answerFrom(opts.agent, res.stdout || '', lastMessageFile);
    const cost = json && typeof json.total_cost_usd === 'number' ? json.total_cost_usd : null;
    fs.writeFileSync(path.join(runDir, 'agent-output.json'), JSON.stringify({ agent: opts.agent.name, answer, cost_usd: cost, duration_min: meta.wall_min, exit_status: res.status, raw: json || (res.stdout || '').slice(-20000) }, null, 2));
    // run folder → artifacts/
    const src = path.join(RUNS, runId);
    if (fs.existsSync(src)) {fs.cpSync(src, path.join(runDir, 'artifacts'), { recursive: true });}
    // end state
    const changes = changedFiles();
    fs.writeFileSync(path.join(runDir, 'changed-files.json'), JSON.stringify(changes, null, 2));
    fs.writeFileSync(path.join(runDir, 'diff.patch'), fullDiff(changes));
    const verify = (c.verify || []).map(cmd => {
      const v = spawnSync('sh', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
      return { cmd, status: v.status, timed_out: v.signal === 'SIGTERM', tail: `${v.stdout || ''}${v.stderr || ''}`.slice(-2000) };
    });
    fs.writeFileSync(path.join(runDir, 'verify.json'), JSON.stringify(verify, null, 2));
    try { restore(changes); } catch (e) { meta.restore_error = e.message; }
    try { const active = path.join(RUNS, '_active'); if (fs.existsSync(active) && fs.readFileSync(active, 'utf8').trim() === runId) {fs.unlinkSync(active);} } catch { /* ignore */ }
    meta.changed_files = changes.length;
    return meta;
  },

  collect(runDir, c) {
    const out = readJSON(path.join(runDir, 'agent-output.json'));
    if (!out) {return null;}
    const meta = readJSON(path.join(runDir, 'run.json')) || {};
    const changes = readJSON(path.join(runDir, 'changed-files.json')) || [];
    const verify = readJSON(path.join(runDir, 'verify.json')) || [];
    const diff = fs.existsSync(path.join(runDir, 'diff.patch')) ? fs.readFileSync(path.join(runDir, 'diff.patch'), 'utf8') : '';
    const answer = String(out.answer || '');
    const artDir = path.join(runDir, 'artifacts');
    const artifacts = listFiles(artDir).filter(f => f !== 'state.json');
    const cons = c.constraints || {};
    const violations = [];
    const files = changes.map(x => x.file);
    if (typeof cons.max_changed_files === 'number' && files.length > cons.max_changed_files) {violations.push(`${files.length} files changed, max ${cons.max_changed_files}: ${files.join(', ')}`);}
    if (Array.isArray(cons.allowed_files) && cons.allowed_files.length) {
      const allowed = cons.allowed_files.map(g => globToRegex(g));
      for (const f of files) {if (!allowed.some(re => re.test(f))) {violations.push(`changed a file outside allowed_files: ${f}`);}}
    }
    for (const req of cons.required_artifacts || []) {
      const f = path.join(artDir, req);
      if (!fs.existsSync(f) || fs.statSync(f).size < 80) {violations.push(`missing or empty artifact: ${req}`);}
    }
    for (const pat of cons.must_not_contain || []) {
      const re = new RegExp(pat);
      if (re.test(diff)) {violations.push(`diff contains forbidden pattern ${pat}`);}
      if (re.test(answer)) {violations.push(`answer contains forbidden pattern ${pat}`);}
    }
    for (const v of verify) {if (v.status !== 0) {violations.push(`verify failed: ${v.cmd}`);}}
    const outputs = [
      ...artifacts.map(f => ({ kind: 'artifact', text: `${f}\n${fs.readFileSync(path.join(artDir, f), 'utf8').slice(0, 200 * 1024)}` })),
      { kind: 'diff', text: diff },
      { kind: 'files', text: files.join('\n') },
      { kind: 'answer', text: answer },
      ...verify.map(v => ({ kind: 'verify', text: `${v.cmd} → ${v.status === 0 ? 'pass' : 'fail'}` })),
    ];
    const ran = !meta.timed_out && !meta.spawn_error && (out.exit_status === 0 || out.exit_status === null);
    if (!ran) {violations.push(`agent did not complete (exit ${out.exit_status}${meta.timed_out ? ', timed out' : ''}) — see agent-output.json / agent-stderr.log`);}
    return {
      outputs,
      complete: ran,
      verdict: violations.length ? 'FAIL' : 'PASS',
      cost_usd: typeof out.cost_usd === 'number' ? out.cost_usd : null,
      duration_min: typeof out.duration_min === 'number' ? out.duration_min : (meta.wall_min ?? null),
      models: [],
      extra: { agent: out.agent, feature_run_id: meta.feature_run_id, artifacts, changed_files: files, violations },
    };
  },

  // artifact outputs start with their file name, so [file, keyword] groups pin a keyword to one artifact
  matches(output, expected) {
    if (expected.in && output.kind !== expected.in) {return false;}
    const text = String(output.text || '').toLowerCase();
    return (expected.match || []).some(group => group.every(k => text.includes(String(k).toLowerCase())));
  },
};
