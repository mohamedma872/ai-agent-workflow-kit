#!/usr/bin/env node
'use strict';
/*
 * ai/evals/hillclimb.js — improve one specialist prompt (.claude/agents/<agent>.md) against the
 * subagent eval (ai/tasks/subagent) without fooling yourself.
 *
 *   node ai/evals/hillclimb.js status                        cases per specialist; which ones can be climbed
 *   node ai/evals/hillclimb.js init <agent> [--reps 3] [--test-fraction 0.34] [--seed S]
 *                                                            train/test split + v0 = the current prompt
 *   node ai/evals/hillclimb.js new <agent> [--from vN]        next version: copy the prompt + change.md to fill in
 *   node ai/evals/hillclimb.js run <agent> <vN> [--split train|test|all]            dry run (no model call)
 *   node ai/evals/hillclimb.js run <agent> <vN> --live --max-usd X [--split …]       live; refuses if the
 *                                                            worst case (trials × per-trial cap) exceeds X
 *   node ai/evals/hillclimb.js compare <agent>               train/test per version, deltas vs v0, noise floor
 *   node ai/evals/hillclimb.js promote <agent> <vN>          prints the diff to apply by hand; never writes
 *
 * State lives in ai/evals/results/hillclimb/<agent>/ (gitignored): _state.json, vN/prompt.md,
 * vN/change.md, vN/results.jsonl, vN/summary.json. A version's trials run through the normal
 * runner (ai/evals/run.js subagent run … --judge) with AI_EVAL_RESULTS_DIR=vN and the candidate
 * prompt swapped in via AI_EVAL_AGENT_NAME / AI_EVAL_AGENT_PROMPT_FILE, so a trial is graded exactly
 * like any other eval. Resume is per (case, rep): rerunning a version only runs missing trials.
 *
 * Discipline (ai/README.md rules): read failures on TRAIN only; the headline is the TEST delta vs v0;
 * a delta inside the noise floor (±100/√n points) is not a result; the candidate prompt is never
 * written into .claude/agents by this tool — a human applies it after reading the diff.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ROOT, loadTask, readRows, parseArgs } = require('./grade.js');

const STATE_ROOT = path.join(ROOT, 'ai', 'evals', 'results', 'hillclimb');
const RUNNER = path.join(__dirname, 'run.js');
const MIN_CASES = 4; // at least 3 train + 1 test

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
const agentDir = agent => path.join(STATE_ROOT, agent);
const versionDir = (agent, v) => path.join(agentDir(agent), v);
const readState = agent => {
  const f = path.join(agentDir(agent), '_state.json');
  if (!fs.existsSync(f)) {fail(`no hillclimb for "${agent}" — start with: node ai/evals/hillclimb.js init ${agent}`);}
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};
const writeState = s => fs.writeFileSync(path.join(agentDir(s.agent), '_state.json'), `${JSON.stringify(s, null, 2)}\n`);

// subagent cases grouped by the specialist their role delegates to
function casesByAgent() {
  const task = loadTask('subagent');
  const map = new Map();
  for (const c of task.cases) {
    const spec = task.adapter.specialist(c.role);
    if (!spec) {continue;}
    if (!map.has(spec.name)) {map.set(spec.name, []);}
    map.get(spec.name).push(c);
  }
  return { task, map };
}

// deterministic split: sort by hash(seed + id), first ⌈fraction·n⌉ are test
function split(ids, fraction, seed) {
  const h = id => crypto.createHash('sha256').update(`${seed}:${id}`).digest('hex');
  const sorted = [...ids].sort((a, b) => h(a).localeCompare(h(b)));
  const nTest = Math.max(1, Math.ceil(fraction * sorted.length));
  return { test: sorted.slice(0, nTest).sort(), train: sorted.slice(nTest).sort() };
}

// ---------------------------------------------------------------- scoring

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = x => (x === null ? '–' : `${Math.round(x * 100)}%`);

function score(rows, ids) {
  const g = rows.filter(r => ids.includes(r.case_id) && r.status === 'graded');
  const judged = g.map(r => (typeof r.judge_recall === 'number' ? r.judge_recall : null)).filter(x => x !== null);
  return {
    graded: g.length,
    recall: mean(g.map(r => r.recall).filter(x => x !== null)),
    judge_recall: mean(judged),
    judge_rows: judged.length,
    phantoms: g.reduce((a, r) => a + (r.phantoms ? r.phantoms.length : 0), 0),
    verdict_ok: (() => { const v = g.filter(r => r.verdict_ok !== null); return v.length ? v.filter(r => r.verdict_ok).length / v.length : null; })(),
    cost_usd: +g.reduce((a, r) => a + (r.cost_usd || 0) + (r.judge_cost_usd || 0), 0).toFixed(2),
    noise_pts: g.length ? Math.round(100 / Math.sqrt(g.length)) : null,
  };
}

function summarize(state, v) {
  const dir = versionDir(state.agent, v);
  const rows = readRows(path.join(dir, 'results.jsonl'));
  const errors = readRows(path.join(dir, 'errors.jsonl'));
  const summary = { version: v, train: score(rows, state.cases.train), test: score(rows, state.cases.test), errors: errors.length, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

// ---------------------------------------------------------------- commands

function status() {
  const { map } = casesByAgent();
  console.log('specialist                       cases  climbable');
  for (const [agent, cs] of [...map.entries()].sort()) {
    console.log(`${agent.padEnd(32)} ${String(cs.length).padStart(5)}  ${cs.length >= MIN_CASES ? 'yes' : `no — needs ≥${MIN_CASES} cases (add fixtures to ai/tasks/subagent/cases.yaml)`}`);
  }
  if (fs.existsSync(STATE_ROOT)) {for (const a of fs.readdirSync(STATE_ROOT)) {console.log(`\nin progress: ${a} (node ai/evals/hillclimb.js compare ${a})`);}}
}

function init(agent, args) {
  const { map } = casesByAgent();
  const cs = map.get(agent) || [];
  if (!fs.existsSync(path.join(ROOT, '.claude', 'agents', `${agent}.md`))) {fail(`.claude/agents/${agent}.md not found`);}
  if (cs.length < MIN_CASES) {fail(`"${agent}" has ${cs.length} subagent case(s); a train/test split needs ≥${MIN_CASES}. Add cases + fixtures for its role(s) to ai/tasks/subagent/cases.yaml first.`);}
  if (fs.existsSync(path.join(agentDir(agent), '_state.json')) && !args.force) {fail(`hillclimb for "${agent}" already exists (--force to reset it)`);}
  const reps = Number(args.reps) || 3;
  const seed = typeof args.seed === 'string' ? args.seed : 'hillclimb-v1';
  const { train, test } = split(cs.map(c => c.case_id), Number(args['test-fraction']) || 0.34, seed);
  fs.mkdirSync(versionDir(agent, 'v0'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.claude', 'agents', `${agent}.md`), path.join(versionDir(agent, 'v0'), 'prompt.md'));
  fs.writeFileSync(path.join(versionDir(agent, 'v0'), 'change.md'), '# v0 — baseline (the committed prompt)\n');
  const state = {
    agent, created_at: new Date().toISOString(), seed, reps,
    cases: { train, test },
    goal: { target: 'judge_recall', direction: 'higher', hold: ['phantoms', 'verdict_ok'] },
    harness_paths: ['ai/evals/run.js', 'ai/evals/grade.js', 'ai/evals/judge.js', 'ai/evals/judge.yaml', 'ai/tasks/subagent/adapter.js', 'ai/tasks/subagent/cases.yaml'],
    versions: ['v0'],
  };
  writeState(state);
  const floor = Math.round(100 / Math.sqrt(test.length * reps));
  console.log(`✓ ${agent}: ${train.length} train · ${test.length} test · ${reps} reps → test noise floor ≈ ±${floor} points`);
  console.log(`  train: ${train.join(', ')}\n  test:  ${test.join(', ')}  (never read these failures while iterating)`);
  if (floor >= 30) {console.log(`  ⚠ a ±${floor}-point floor can only show very large wins — add cases or reps before spending on rounds`);}
  console.log(`next: node ai/evals/hillclimb.js run ${agent} v0            (dry run: shows the ${(train.length + test.length) * reps} trials)`);
}

function newVersion(agent, args) {
  const state = readState(agent);
  const from = typeof args.from === 'string' ? args.from : state.versions[state.versions.length - 1];
  if (!state.versions.includes(from)) {fail(`unknown version ${from} — have ${state.versions.join(', ')}`);}
  const v = `v${state.versions.length}`;
  fs.mkdirSync(versionDir(agent, v), { recursive: true });
  fs.copyFileSync(path.join(versionDir(agent, from), 'prompt.md'), path.join(versionDir(agent, v), 'prompt.md'));
  fs.writeFileSync(path.join(versionDir(agent, v), 'change.md'), `# ${v} (from ${from})\n\n## Train failures read\n\n## Hypothesis\n\n## Change made to prompt.md\n`);
  state.versions.push(v);
  writeState(state);
  console.log(`✓ ${v}: edit ${path.relative(ROOT, path.join(versionDir(agent, v), 'prompt.md'))} (one change), fill in change.md, then: node ai/evals/hillclimb.js run ${agent} ${v}`);
}

function run(agent, v, args) {
  const state = readState(agent);
  if (!state.versions.includes(v)) {fail(`unknown version ${v} — have ${state.versions.join(', ')}`);}
  const which = args.split || 'all';
  const ids = which === 'train' ? state.cases.train : which === 'test' ? state.cases.test : [...state.cases.train, ...state.cases.test];
  const dir = versionDir(agent, v);
  const done = readRows(path.join(dir, 'results.jsonl'));
  const plan = ids.map(id => ({ id, missing: Math.max(0, state.reps - done.filter(r => r.case_id === id).length) })).filter(p => p.missing > 0);
  const trials = plan.reduce((a, p) => a + p.missing, 0);
  const { task } = casesByAgent();
  const perTrial = (task.adapter.defaults || {}).budget || 3;
  const judgeCfg = require('./judge.js').loadConfig();
  const worst = trials * (perTrial + judgeCfg.budget_usd);
  console.log(`${agent} ${v} · ${which}: ${trials} trial(s) to run (${ids.length} cases × ${state.reps} reps, ${done.length} already done) · worst case $${worst.toFixed(2)} (per-trial cap $${perTrial} + judge cap $${judgeCfg.budget_usd})`);
  if (!trials) { console.log(JSON.stringify(summarize(state, v))); return; }
  const live = !!args.live;
  if (live) {
    if (process.env.CLAUDECODE) {fail('run live evals from a plain terminal, not inside a Claude Code session');}
    const max = Number(args['max-usd']);
    if (!(max > 0)) {fail('--live needs --max-usd <dollars> — the ceiling you approved for this run');}
    if (worst > max) {fail(`worst case $${worst.toFixed(2)} exceeds --max-usd $${max} — lower reps, run --split train first, or raise the ceiling`);}
  }
  const env = { ...process.env, AI_EVAL_RESULTS_DIR: path.relative(ROOT, dir), AI_EVAL_AGENT_NAME: agent, AI_EVAL_AGENT_PROMPT_FILE: path.relative(ROOT, path.join(dir, 'prompt.md')) };
  for (const p of plan) {
    const argv = [RUNNER, 'subagent', 'run', '--case', p.id, '--agent', 'claude', '--reps', String(p.missing), '--judge', ...(live ? [] : ['--dry-run'])];
    const r = spawnSync(process.execPath, argv, { cwd: ROOT, env, stdio: 'inherit' });
    if (r.status !== 0) {fail(`runner failed on ${p.id} (exit ${r.status}) — rerun the same command to resume`);}
  }
  if (live) { const s = summarize(state, v); console.log(`\ntrain judge recall ${pct(s.train.judge_recall)} · test ${pct(s.test.judge_recall)} (±${s.test.noise_pts ?? '–'}) · $${(s.train.cost_usd + s.test.cost_usd).toFixed(2)} · errors ${s.errors}`); }
  else {console.log(`\n(dry run — nothing was sent to a model; add --live --max-usd ${Math.ceil(worst)} to run)`);}
}

function compare(agent) {
  const state = readState(agent);
  const base = fs.existsSync(path.join(versionDir(agent, 'v0'), 'results.jsonl')) ? summarize(state, 'v0') : null;
  console.log(`## ${agent} — goal: ${state.goal.direction} ${state.goal.target} (hold ${state.goal.hold.join(', ')})\n`);
  console.log('| version | train judge recall | test judge recall | Δ test vs v0 | test n | test floor | phantoms | verdict ok | $ |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const v of state.versions) {
    if (!fs.existsSync(path.join(versionDir(agent, v), 'results.jsonl'))) { console.log(`| ${v} | not run | | | | | | | |`); continue; }
    const s = summarize(state, v);
    const d = base && base.test.judge_recall !== null && s.test.judge_recall !== null ? Math.round((s.test.judge_recall - base.test.judge_recall) * 100) : null;
    const within = d !== null && s.test.noise_pts !== null && Math.abs(d) <= s.test.noise_pts;
    console.log(`| ${v} | ${pct(s.train.judge_recall)} | ${pct(s.test.judge_recall)} | ${d === null || v === 'v0' ? '–' : `${d > 0 ? '+' : ''}${d} pts${within ? ' (within noise)' : ''}`} | ${s.test.graded} | ±${s.test.noise_pts ?? '–'} | ${s.train.phantoms + s.test.phantoms} | ${pct(s.test.verdict_ok)} | ${(s.train.cost_usd + s.test.cost_usd).toFixed(2)} |`);
  }
  console.log('\nThe headline is the test column. Train is where you read failures; a train-only gain is tuning, not a result.');
}

function promote(agent, v, args) {
  const state = readState(agent);
  if (!state.versions.includes(v) || v === 'v0') {fail(`pick a candidate version (have ${state.versions.join(', ')})`);}
  const base = summarize(state, 'v0');
  const cand = summarize(state, v);
  const d = base.test.judge_recall !== null && cand.test.judge_recall !== null ? Math.round((cand.test.judge_recall - base.test.judge_recall) * 100) : null;
  if (d === null) {fail('both v0 and the candidate need graded test trials with judge verdicts');}
  if (d <= (cand.test.noise_pts || 0) && !args.force) {fail(`test delta ${d} pts is inside the ±${cand.test.noise_pts} noise floor — not a result (--force prints the diff anyway)`);}
  if (cand.test.phantoms + cand.train.phantoms > base.test.phantoms + base.train.phantoms) {console.log('⚠ the candidate reports more phantom findings than v0 — check before applying');}
  console.log(`${agent} ${v}: test judge recall ${pct(base.test.judge_recall)} → ${pct(cand.test.judge_recall)} (${d > 0 ? '+' : ''}${d} pts, floor ±${cand.test.noise_pts}).\nApply by hand after reading the diff (this tool never writes .claude/agents):\n`);
  spawnSync('diff', ['-u', path.join('.claude', 'agents', `${agent}.md`), path.relative(ROOT, path.join(versionDir(agent, v), 'prompt.md'))], { cwd: ROOT, stdio: 'inherit' });
}

// ---------------------------------------------------------------- selftest (offline)

function selftest() {
  const assert = require('assert');
  const a = split(['a', 'b', 'c', 'd', 'e', 'f'], 0.34, 's');
  const b = split(['f', 'e', 'd', 'c', 'b', 'a'], 0.34, 's');
  assert.deepStrictEqual(a, b, 'split must not depend on input order');
  assert.strictEqual(a.test.length, 3);
  assert.strictEqual(a.train.length + a.test.length, 6);
  assert.notDeepStrictEqual(split(['a', 'b', 'c', 'd', 'e', 'f'], 0.34, 'other').test, undefined);
  const rows = [
    { case_id: 'x', status: 'graded', recall: 0, judge_recall: 1, phantoms: [], verdict_ok: true, cost_usd: 1, judge_cost_usd: 0.1 },
    { case_id: 'x', status: 'graded', recall: 0, judge_recall: 0, phantoms: ['p'], verdict_ok: false, cost_usd: 1 },
    { case_id: 'y', status: 'incomplete', recall: 1, judge_recall: 1 },
    { case_id: 'z', status: 'graded', recall: 1, judge_recall: null, judge_errors: [{}], phantoms: [], verdict_ok: true },
  ];
  const s = score(rows, ['x', 'y']);
  assert.strictEqual(s.graded, 2);
  assert.strictEqual(s.judge_recall, 0.5);
  assert.strictEqual(s.phantoms, 1);
  assert.strictEqual(s.cost_usd, 2.1);
  assert.strictEqual(score(rows, ['z']).judge_recall, null, 'judge errors are left out, never scored as 0');
  const { task, map } = casesByAgent();
  assert(map.size >= 5, 'every subagent case should map to a specialist');
  for (const c of task.cases) {assert(fs.existsSync(path.join(ROOT, c.fixture || '')), `subagent case ${c.case_id}: fixture missing (${c.fixture})`);}
  assert(task.cases.every(c => task.adapter.specialist(c.role)), 'every subagent case role must delegate to a .claude/agents specialist');
  console.log('hillclimb selftest OK (offline — no model called)');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, agent, v] = args._;
  if (args.selftest || cmd === 'selftest') {selftest();}
  else if (!cmd || cmd === 'status') {status();}
  else if (!agent) {fail('usage: hillclimb.js status | init <agent> | new <agent> | run <agent> <vN> [--live --max-usd X] | compare <agent> | promote <agent> <vN>');}
  else if (cmd === 'init') {init(agent, args);}
  else if (cmd === 'new') {newVersion(agent, args);}
  else if (cmd === 'run') {run(agent, v || fail('run needs a version, e.g. v0'), args);}
  else if (cmd === 'compare') {compare(agent);}
  else if (cmd === 'promote') {promote(agent, v || fail('promote needs a version'), args);}
  else {fail(`unknown command "${cmd}"`);}
}

module.exports = { split, score };
