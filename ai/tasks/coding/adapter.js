'use strict';
/*
 * Eval adapter for the `coding` task — ANY coding agent doing plain repo tasks.
 *
 * execute() runs the agent named by --agent (ai/agents.yaml) with the case
 * prompt, in the repo root, with AI_EVAL=1 (the fence denies commits and
 * outward writes). When the agent exits, the END STATE is captured: the list
 * of changed files, the diff, the agent's final answer, and the results of the
 * case's verify commands. Then the tree is restored. collect() turns those
 * artifacts into outputs; the verdict is PASS when every constraint holds and
 * every verify command passed.
 *
 * Artifacts per run dir: agent-output.json · diff.patch · changed-files.json · verify.json
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { globToRegex } = require(path.join(ROOT, 'ai', 'guard', 'engine.js'));
const RESULTS_REL = 'ai/evals/results';

function git(...a) { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
function readJSON(f) { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } }

// tracked + untracked (non-ignored) changes, excluding the eval ledger itself.
// Pass the ignored-file snapshot taken before the trial to also catch files the agent
// wrote into IGNORED paths (this repo ignores __tests__/ and *.test.*): git status never
// shows them, so without the snapshot they would be neither graded nor cleaned up.
function changedFiles(ignoredBefore) {
  const rows = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map(l => ({ status: l.slice(0, 2).trim(), file: l.slice(3).replace(/^"|"$/g, '') }))
    .filter(e => !e.file.startsWith(`${RESULTS_REL}/`));
  if (ignoredBefore) {
    for (const f of ignoredFiles()) {if (!ignoredBefore.has(f)) {rows.push({ status: '!!', file: f });}}
  }
  return rows;
}

// ignored files, minus the heavy build folders and the AI audit trail (ai/runs is meant to stay)
const IGNORED_SKIP = ['node_modules', 'ai', 'ios/Pods', 'ios/build', 'android/build', 'android/app/build', '.git'];
function ignoredFiles() {
  return new Set(git('ls-files', '--others', '--ignored', '--exclude-standard', '--', '.', ...IGNORED_SKIP.map(d => `:!${d}`)).split('\n').filter(Boolean));
}

const isNew = c => c.status === '??' || c.status === '!!';

function fullDiff(changes) {
  let out = '';
  try { out += git('diff', 'HEAD', '--'); } catch { /* no tracked changes */ }
  for (const c of changes.filter(isNew)) {
    const f = path.join(ROOT, c.file);
    try {
      if (fs.statSync(f).isDirectory()) {continue;}
      const body = fs.readFileSync(f, 'utf8').slice(0, 200 * 1024);
      out += `diff --git a/${c.file} b/${c.file}\nnew file mode 100644\n--- /dev/null\n+++ b/${c.file}\n${body.split('\n').map(l => `+${l}`).join('\n')}\n`;
    } catch { /* binary or unreadable */ }
  }
  return out;
}

function restore(changes) {
  const tracked = changes.filter(c => !isNew(c)).map(c => c.file);
  if (tracked.length) {git('checkout', '--', ...tracked);}
  for (const c of changes.filter(isNew)) {
    try { fs.rmSync(path.join(ROOT, c.file), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function fill(template, vars) { return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)); }

function answerFrom(agent, stdout, lastMessageFile) {
  const spec = agent.result || {};
  let json = null;
  try { json = JSON.parse(stdout); } catch { /* not a single JSON document */ }
  // event streams (codex --json prints JSON lines): keep the last event carrying token usage —
  // Codex reports tokens, not dollars, so this is what the ledger can record for it
  let usage = null;
  if (!json) {
    for (const line of String(stdout || '').split('\n')) {
      try { const ev = JSON.parse(line); if (ev && ev.usage && typeof ev.usage === 'object') {usage = ev.usage;} } catch { /* not JSON */ }
    }
  }
  if (spec.json_field && json && typeof json[spec.json_field] === 'string') {return { answer: json[spec.json_field], json, usage };}
  if (spec.file && fs.existsSync(lastMessageFile)) {return { answer: fs.readFileSync(lastMessageFile, 'utf8'), json, usage };}
  if (json && typeof json.result === 'string') {return { answer: json.result, json, usage };}
  return { answer: String(stdout || '').slice(-4000), json, usage };
}

module.exports = {
  name: 'coding',
  description: 'Any coding agent (claude / codex) doing plain repo tasks — graded by end state: files changed, diff, answer, verify commands',
  entry: 'ai/agents.yaml → claude -p | codex exec',
  resultsDir: RESULTS_REL + '/coding',
  agents: ['claude', 'codex'],
  defaults: { agent: 'claude', budget: 5, timeoutMin: 20, permissionMode: 'bypassPermissions' },

  preflight(opts) {
    if (!opts.agent) {throw new Error('pass --agent claude|codex (see ai/agents.yaml)');}
    const bin = String(opts.agent.command[0]);
    if (spawnSync('which', [bin]).status !== 0) {throw new Error(`agent "${opts.agent.name}": "${bin}" is not on PATH${opts.agent.note ? ` — ${opts.agent.note}` : ''}`);}
  },

  describe(c) { return `${c.target || c.case_id}`; },

  execute(c, runDir, opts) {
    const agent = opts.agent;
    const lastMessageFile = path.join(runDir, 'last-message.txt');
    const prompt = String(c.prompt || c.target || '').trim();
    const argv = agent.command.map(a => fill(a, { prompt, budget: opts.budget, cwd: ROOT, last_message_file: lastMessageFile }));
    const meta = { agent: agent.name, command: argv.map(a => (/\s/.test(a) ? JSON.stringify(a.length > 80 ? `${a.slice(0, 77)}…` : a) : a)).join(' ') };
    if (opts.dryRun) {return meta;}
    const before = changedFiles();
    if (before.length) {throw new Error(`working tree not clean before the trial: ${before.map(b => b.file).join(', ')}`);}
    const ignoredBefore = ignoredFiles();
    const t0 = Date.now();
    const res = spawnSync(argv[0], argv.slice(1), {
      cwd: ROOT,
      env: { ...process.env, AI_EVAL: '1' },
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
    const { answer, json, usage } = answerFrom(agent, res.stdout || '', lastMessageFile);
    const cost = agent.cost && json && typeof json[agent.cost.json_field] === 'number' ? json[agent.cost.json_field] : null;
    const duration = agent.duration && json && typeof json[agent.duration.json_field] === 'number' ? json[agent.duration.json_field] / 60000 : meta.wall_min;
    fs.writeFileSync(path.join(runDir, 'agent-output.json'), JSON.stringify({ agent: agent.name, answer, cost_usd: cost, usage, duration_min: duration, exit_status: res.status, raw: json || (res.stdout || '').slice(-20000) }, null, 2));
    // end state (incl. files written into ignored paths — status "!!")
    const changes = changedFiles(ignoredBefore);
    fs.writeFileSync(path.join(runDir, 'changed-files.json'), JSON.stringify(changes, null, 2));
    fs.writeFileSync(path.join(runDir, 'diff.patch'), fullDiff(changes));
    const verify = (c.verify || []).map(cmd => {
      const v = spawnSync('sh', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
      return { cmd, status: v.status, timed_out: v.signal === 'SIGTERM', tail: `${v.stdout || ''}${v.stderr || ''}`.slice(-2000) };
    });
    fs.writeFileSync(path.join(runDir, 'verify.json'), JSON.stringify(verify, null, 2));
    try { restore(changes); } catch (e) { meta.restore_error = e.message; }
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
    const cons = c.constraints || {};
    const violations = [];
    const files = changes.map(x => x.file);
    if (typeof cons.max_changed_files === 'number' && files.length > cons.max_changed_files) {violations.push(`${files.length} files changed, max ${cons.max_changed_files}: ${files.join(', ')}`);}
    if (Array.isArray(cons.allowed_files) && cons.allowed_files.length) {
      const allowed = cons.allowed_files.map(g => globToRegex(g));
      for (const f of files) {if (!allowed.some(re => re.test(f))) {violations.push(`changed a file outside allowed_files: ${f}`);}}
    }
    for (const pat of cons.must_not_contain || []) {
      const re = new RegExp(pat);
      if (re.test(diff)) {violations.push(`diff contains forbidden pattern ${pat}`);}
      if (re.test(answer)) {violations.push(`answer contains forbidden pattern ${pat}`);}
    }
    for (const v of verify) {if (v.status !== 0) {violations.push(`verify failed: ${v.cmd}`);}}
    const outputs = [
      { kind: 'diff', text: diff },
      { kind: 'files', text: files.join('\n') },
      { kind: 'answer', text: answer },
      ...verify.map(v => ({ kind: 'verify', text: `${v.cmd} → ${v.status === 0 ? 'pass' : 'fail'}` })),
    ];
    // a non-zero exit (not signed in, crashed, refused to start) is plumbing, not a model result
    const ran = !meta.timed_out && !meta.spawn_error && (out.exit_status === 0 || out.exit_status === null);
    if (!ran) {violations.push(`agent did not complete (exit ${out.exit_status}${meta.timed_out ? ', timed out' : ''}) — see agent-output.json / agent-stderr.log`);}
    return {
      outputs,
      complete: ran,
      verdict: violations.length ? 'FAIL' : 'PASS',
      cost_usd: typeof out.cost_usd === 'number' ? out.cost_usd : null,
      duration_min: typeof out.duration_min === 'number' ? out.duration_min : (meta.wall_min ?? null),
      models: [],
      extra: { agent: out.agent, usage: out.usage || null, changed_files: files, violations, verify: verify.map(v => ({ cmd: v.cmd, status: v.status })) },
    };
  },

  // an expected item matches when its keyword groups hit an output of the right kind
  matches(output, expected) {
    if (expected.in && output.kind !== expected.in) {return false;}
    const text = String(output.text || '').toLowerCase();
    return (expected.match || []).some(group => group.every(k => text.includes(String(k).toLowerCase())));
  },
};

// shared with other agent-driven tasks (e.g. ai/tasks/feature)
module.exports.helpers = { changedFiles, ignoredFiles, fullDiff, restore, fill, answerFrom, RESULTS_REL };
