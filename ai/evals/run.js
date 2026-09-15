#!/usr/bin/env node
'use strict';
/*
 * ai/evals/run.js — generic eval runner for every AI task in this repo, for ANY agent.
 *
 *   node ai/evals/run.js                                          # list tasks
 *   node ai/evals/run.js <task> list
 *   node ai/evals/run.js <task> plan [--case ID]
 *   node ai/evals/run.js <task> run (--case ID | --all) [--agent NAME] [--reps N] [--budget USD]
 *                                  [--timeout-min M] [--permission-mode M] [--force] [--dry-run]
 *   node ai/evals/run.js <task> grade --case ID [--dir D]        # replay: grade existing artifacts
 *   node ai/evals/run.js <task> summary
 *
 * A task = ai/tasks/<task>/{adapter.js, cases.yaml}. The adapter runs one
 * trial and reads its end state; this file owns everything generic: which
 * agent (ai/agents.yaml, --agent), one run dir per trial, mutations (revert a
 * merged fix for the run), timeouts, restoring the tree, the results ledger,
 * and the summary with its noise floor.
 *
 * Live runs happen from a plain terminal (not inside an agent session when the
 * entry point is that same agent), on a clean git tree.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { ROOT, AI_DIR, listTasks, loadTask, resultsDirFor, catalog, gradeCase, fmt, appendRow, readRows, parseArgs, loadAgents } = require('./grade.js');

function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }
function fixOnHead(sha) { return spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: ROOT }).status === 0; }
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

// ---------------------------------------------------------------- mutations (generic)

function decideMutation(c) {
  const m = c.mutation;
  if (!m) {return { kind: 'none', note: 'no mutation — outcome expected natively on HEAD' };}
  if (m.type === 'revert') {
    if (!fixOnHead(m.sha)) {return { kind: 'skip', note: `fix ${m.sha} is not on HEAD, the defect is still native — covered by a native case (--force runs it anyway)` };}
    return { kind: 'revert', sha: m.sha, note: `will revert ${m.sha} (uncommitted) for the duration of the run` };
  }
  if (m.type === 'edit') {return { kind: 'edit', file: m.file, note: `will edit ${m.file} for the duration of the run` };}
  return { kind: 'skip', note: `unknown mutation type "${m.type}"` };
}

function applyMutation(c, decision) {
  if (decision.kind === 'revert') {
    git('revert', '--no-commit', '--no-edit', decision.sha);
    return { applied: true, kind: 'revert', sha: decision.sha, files: git('diff', '--name-only', '--cached').split('\n').filter(Boolean) };
  }
  if (decision.kind === 'edit') {
    const m = c.mutation;
    const f = path.join(ROOT, m.file);
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes(m.find)) {throw new Error(`mutation: "${m.find}" not found in ${m.file}`);}
    fs.writeFileSync(f, src.replace(m.find, m.replace));
    return { applied: true, kind: 'edit', files: [m.file] };
  }
  return { applied: false };
}

function restoreMutation(mut) {
  if (!mut.applied) {return;}
  git('reset', '-q', 'HEAD', '--', ...mut.files);
  git('checkout', '--', ...mut.files);
  const dirty = git('status', '--porcelain', '--', ...mut.files);
  if (dirty) {throw new Error(`tree not clean after restoring the mutation:\n${dirty}`);}
}

// ---------------------------------------------------------------- one trial

function runOne(task, c, rep, opts) {
  const resultsDir = resultsDirFor(task);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const agentName = opts.agent ? opts.agent.name : 'default';
  const runId = `${c.case_id}-${agentName}-r${rep}-${stamp}`;
  const runDir = path.join(resultsDir, 'runs', runId);
  const decision = decideMutation(c);
  if (decision.kind === 'skip' && !opts.force) {
    console.log(`↷ ${c.case_id} r${rep}: skipped — ${decision.note}`);
    return;
  }
  const describe = typeof task.adapter.describe === 'function' ? task.adapter.describe(c) : c.target;
  if (opts.dryRun) {
    const meta = task.adapter.execute(c, runDir, { ...opts, dryRun: true }, { ROOT, runId, git }) || {};
    console.log(`▸ ${task.name}/${c.case_id} [${agentName}] r${rep} → ${describe}\n    ${decision.note}\n    ${meta.command || task.adapter.entry || '(adapter.execute)'}\n    artifacts → ${path.relative(ROOT, runDir)}/`);
    return;
  }
  fs.mkdirSync(runDir, { recursive: true });
  const meta = {
    run_id: runId, task: task.name, case_id: c.case_id, agent: agentName, rep, target: c.target,
    head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    mutation: decision, budget_usd: opts.budget, timeout_min: opts.timeoutMin, permission_mode: opts.permissionMode,
    started_at: new Date().toISOString(),
  };
  console.log(`▶ ${task.name}/${c.case_id} [${agentName}] r${rep} → ${describe} — ${decision.note}`);
  let mut = { applied: false };
  try {
    mut = applyMutation(c, decision);
    Object.assign(meta, task.adapter.execute(c, runDir, opts, { ROOT, runId, git }) || {});
  } catch (e) {
    meta.execute_error = e.message;
    console.log(`  ✗ execute: ${e.message}`);
  } finally {
    try { restoreMutation(mut); } catch (e) { meta.restore_error = e.message; }
    meta.head_after = git('rev-parse', 'HEAD');
    meta.head_moved = meta.head_after !== meta.head;
    meta.tree_dirty_after = git('status', '--porcelain') || null;
    meta.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta, null, 2));
  }
  if (meta.timed_out) {
    appendRow(path.join(resultsDir, 'errors.jsonl'), { task: task.name, case_id: c.case_id, agent: agentName, run_id: runId, rep, status: 'error', error_class: 'timeout', minutes: meta.wall_min, artifacts: path.relative(ROOT, runDir), at: meta.finished_at });
  }
  if (meta.head_moved || meta.tree_dirty_after) {
    console.log(`⚠ ${runId}: ${meta.head_moved ? 'HEAD moved during the run (a commit slipped past the guard). ' : ''}${meta.tree_dirty_after ? 'tree left dirty:\n' + meta.tree_dirty_after : ''}`);
  }
  const row = gradeCase(task, c, { dir: runDir, rep, runId, agent: agentName, catalog: catalog(task) });
  appendRow(path.join(resultsDir, row.status === 'error' ? 'errors.jsonl' : 'results.jsonl'), row);
  console.log(fmt(row));
}

// ---------------------------------------------------------------- summary

function summary(task) {
  const resultsDir = resultsDirFor(task);
  const rows = readRows(path.join(resultsDir, 'results.jsonl'));
  const errs = readRows(path.join(resultsDir, 'errors.jsonl'));
  if (!rows.length && !errs.length) {
    console.log(`no results for ${task.name} yet — start with: node ai/evals/run.js ${task.name} run --case <id> --agent claude --dry-run`);
    return;
  }
  const by = new Map();
  for (const r of rows) { const k = `${r.agent || 'default'} · ${r.case_id}`; if (!by.has(k)) {by.set(k, []);} by.get(k).push(r); }
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pct = x => (x === null ? '–' : `${Math.round(x * 100)}%`);
  const num = (x, d) => (x === null || x === undefined ? '–' : x.toFixed(d));
  console.log(`## ${task.name} — ${path.relative(ROOT, resultsDir)}\n`);
  console.log('| agent · case | rows | graded | recall | phantoms | verdict ok | $ / run | min / run |');
  console.log('|---|---|---|---|---|---|---|---|');
  let graded = 0;
  for (const [key, rs] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const g = rs.filter(r => r.status === 'graded');
    graded += g.length;
    const recall = mean(g.map(r => r.recall).filter(x => x !== null));
    const ph = g.reduce((a, r) => a + (r.phantoms ? r.phantoms.length : 0), 0);
    const vo = g.filter(r => r.verdict_ok !== null);
    const voRate = vo.length ? vo.filter(r => r.verdict_ok).length / vo.length : null;
    console.log(`| ${key} | ${rs.length} | ${g.length} | ${pct(recall)} | ${ph} | ${pct(voRate)} | ${num(mean(g.map(r => r.cost_usd).filter(x => typeof x === 'number')), 2)} | ${num(mean(g.map(r => r.duration_min).filter(x => typeof x === 'number')), 1)} |`);
  }
  const incomplete = rows.filter(r => r.status === 'incomplete').length;
  console.log(`\n${graded} graded · ${incomplete} incomplete (stopped early) · ${errs.length} errors (no artifacts / timeout) — incomplete and error rows are listed, never averaged in as failures.`);
  if (graded) {console.log(`noise floor ≈ ±${Math.round(100 / Math.sqrt(graded))} points on any rate above (1/√n, n=${graded} graded trials) — smaller differences are not real.`);}
  for (const e of errs) {console.log(`  ✗ ${e.run_id || e.case_id}: ${e.error_class} ${e.error || ''}`);}
}

// ---------------------------------------------------------------- cli

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const [taskName, cmd] = args._;
  if (!taskName) {
    const tasks = listTasks();
    if (!tasks.length) { console.log('no AI tasks yet — copy ai/tasks/_template to ai/tasks/<name>'); process.exit(0); }
    for (const t of tasks) {
      const task = loadTask(t);
      console.log(`${t.padEnd(12)} ${String(task.cases.length).padStart(2)} cases · agents: ${(task.adapter.agents || ['(any)']).join('/')} · ${task.adapter.description || ''}`);
    }
    process.exit(0);
  }
  let task;
  try { task = loadTask(taskName); } catch (e) { fail(e.message); }
  const d = task.adapter.defaults || {};
  const agents = loadAgents();
  const agentName = args.agent || d.agent || null;
  let agent = null;
  if (agentName) {
    if (!agents[agentName]) {fail(`unknown agent "${agentName}" — known: ${Object.keys(agents).join(', ')} (ai/agents.yaml)`);}
    if (Array.isArray(task.adapter.agents) && !task.adapter.agents.includes(agentName)) {fail(`task "${task.name}" supports only: ${task.adapter.agents.join(', ')}`);}
    agent = { name: agentName, ...agents[agentName] };
  }
  const opts = {
    agent,
    reps: Number(args.reps) || 1,
    budget: Number(args.budget) || d.budget || 20,
    timeoutMin: Number(args['timeout-min']) || d.timeoutMin || 60,
    permissionMode: args['permission-mode'] || d.permissionMode || 'bypassPermissions',
    dryRun: !!args['dry-run'],
    force: !!args.force,
  };
  const pick = () => {
    if (args.case) {
      const c = task.cases.find(x => x.case_id === args.case);
      if (!c) {fail(`unknown case "${args.case}" — known: ${task.cases.map(x => x.case_id).join(', ')}`);}
      return [c];
    }
    if (args.all) {return task.cases.filter(c => c.kind !== 'replay');}
    return fail('pass --case ID or --all');
  };
  switch (cmd) {
    case 'list':
      for (const c of task.cases) {console.log(`${c.case_id.padEnd(28)} ${String(c.kind).padEnd(7)} → ${String(c.target).padEnd(30)} ${(c.expected || []).length} expected · verdict ${c.expect_verdict || '–'}${c.notes ? ` · ${c.notes}` : ''}`);}
      break;
    case 'plan':
      for (const c of (args.case ? pick() : task.cases)) {
        const dec = c.kind === 'replay' ? { note: 'offline replay — grade only (run.js <task> grade --case …)' } : decideMutation(c);
        console.log(`${c.case_id.padEnd(28)} ${String(c.target).padEnd(30)} ${dec.note}`);
      }
      break;
    case 'run': {
      if (!opts.dryRun) {
        if (agent && process.env.CLAUDECODE && agent.name === 'claude') {fail('run live Claude evals from a plain terminal, not from inside a Claude Code session (nested sessions are refused)');}
        if (git('status', '--porcelain')) {fail('working tree must be clean (trials edit and restore the tree in place)');}
        if (typeof task.adapter.preflight === 'function') { try { task.adapter.preflight(opts); } catch (e) { fail(e.message); } }
      }
      const list = pick();
      if (list.some(c => c.kind === 'replay')) {fail('replay cases are graded with `run.js <task> grade --case …`, not run');}
      for (const c of list) {for (let rep = 1; rep <= opts.reps; rep++) {runOne(task, c, rep, opts);}}
      if (!opts.dryRun) {summary(task);}
      break;
    }
    case 'grade': {
      const c = pick()[0];
      const row = gradeCase(task, c, { dir: args.dir ? path.resolve(ROOT, args.dir) : null, runId: `replay-${Date.now()}`, agent: agentName, catalog: catalog(task) });
      if (!args['no-write'] && row.mode === 'run') {appendRow(path.join(resultsDirFor(task), row.status === 'error' ? 'errors.jsonl' : 'results.jsonl'), row);}
      console.log(args.json ? JSON.stringify(row, null, 2) : fmt(row));
      process.exit(row.status === 'error' ? 2 : 0);
      break;
    }
    case 'summary':
      summary(task);
      break;
    default:
      console.error('usage: run.js <task> list | plan [--case ID] | run (--case ID|--all) [--agent NAME] [--reps N] [--budget USD] [--timeout-min M] [--permission-mode M] [--force] [--dry-run] | grade --case ID [--dir D] [--no-write] | summary');
      console.error(`agents (${path.relative(ROOT, path.join(AI_DIR, 'agents.yaml'))}): ${Object.keys(agents).join(', ') || '(none)'}`);
      process.exit(1);
  }
}
