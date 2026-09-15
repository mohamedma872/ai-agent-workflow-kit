#!/usr/bin/env node
'use strict';
/*
 * ai/evals/grade.js — generic end-state grader for every AI task in this repo, for ANY agent.
 *
 *   node ai/evals/grade.js <task> <case_id> [--dir <run dir>] [--rep N] [--run-id ID]
 *                                [--oracle | --null] [--no-write] [--json]
 *
 * A task = ai/tasks/<task>/{adapter.js, cases.jsonl}. The adapter says
 * how to read what a run left behind (collect) and what counts as a match
 * (matches); this file turns that into metrics and a ledger row:
 *
 *   recall      expected items the run produced / expected items (null if none expected)
 *   phantoms    outputs matching an item expected in ANOTHER case (clean-run check)
 *   verdict_ok  the run's verdict equals expect_verdict (null if the case sets none)
 *   cost_usd, duration_min, models — from the harness, never estimated
 *
 * Status: graded | incomplete (run stopped early — shown, never averaged as a
 * failure) | error (no artifacts → errors.jsonl). "No answer" ≠ "negative answer".
 *
 * --oracle feeds the case's own expected items as outputs (recall must be 1.0),
 * --null feeds nothing (recall must be 0). Run both before trusting a case or a
 * grader change.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_DIR = path.join(__dirname, '..');
const TASKS_DIR = path.join(AI_DIR, 'tasks');

// ---------------------------------------------------------------- tasks

function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) {return [];}
  return fs.readdirSync(TASKS_DIR).filter(d => !d.startsWith('_') && !d.startsWith('.') && fs.existsSync(path.join(TASKS_DIR, d, 'adapter.js')));
}

// Cases are written by humans in cases.yaml. The PLAIN vocabulary:
//   name · ask · may_change ([] = must change nothing) · max_files
//   diff_must_contain / answer_must_contain / files_must_include   ("a + b" = both; a list = any of them)
//   artifacts_must_exist · artifacts_must_contain [{file, text}]
//   must_report [{name, severity?, any_of: ["a + b", …]}]          (agents that write findings)
//   must_not_contain (regexes) · check (shell commands) · undo_fix (commit to revert for the run)
//   expect_verdict · run / run_ticket / run_dir / replay · why · note
// The internal shape (case_id · kind · target · constraints · expected[{id, in, match}] ·
// verify · mutation · source) is still accepted, so older files keep working.
const one = s => String(s).split(/\s\+\s/).map(x => x.trim()).filter(Boolean);       // "a + b" → [a, b]
const textReq = entry => (Array.isArray(entry) ? entry.map(one) : [one(entry)]);      // list = any of

function normaliseCase(c, file, i) {
  if (!c || typeof c !== 'object') {throw new Error(`${path.relative(ROOT, file)} entry ${i + 1}: not an object`);}
  const where = `${path.relative(ROOT, file)} entry ${i + 1}`;
  const out = { ...c };
  out.case_id = c.case_id || c.id || c.name;
  if (!out.case_id) {throw new Error(`${where}: missing name`);}
  if (c.ask && !c.prompt) {out.prompt = c.ask;}
  out.target = c.target || c.run || out.case_id;
  if (c.why && !c.source) {out.source = c.why;}
  if (c.note && !c.notes) {out.notes = c.note;}
  if (c.check && !c.verify) {out.verify = c.check;}
  if (c.undo_fix && !c.mutation) {out.mutation = { type: 'revert', sha: String(c.undo_fix) };}

  const cons = { ...(c.constraints || {}) };
  if (Array.isArray(c.may_change)) { if (c.may_change.length) {cons.allowed_files = c.may_change;} else {cons.max_changed_files = 0;} }
  if (typeof c.max_files === 'number') {cons.max_changed_files = c.max_files;}
  if (Array.isArray(c.must_not_contain)) {cons.must_not_contain = c.must_not_contain;}
  if (Array.isArray(c.artifacts_must_exist)) {cons.required_artifacts = c.artifacts_must_exist;}
  if (Object.keys(cons).length) {out.constraints = cons;}

  const expected = (c.expected || []).map((e, j) => {
    if (!e.id) {throw new Error(`${where}: expected[${j}] has no id`);}
    return { ...e, match: (e.match || e.any_of || []).map(g => (Array.isArray(g) ? g : [g])) };
  });
  const add = (kind, entries, prefix) => (entries || []).forEach((e, j) => expected.push({ id: `${prefix}-${j + 1}`, in: kind, match: textReq(e) }));
  add('diff', c.diff_must_contain, 'diff');
  add('answer', c.answer_must_contain, 'answer');
  add('files', c.files_must_include, 'files');
  (c.artifacts_must_contain || []).forEach((e, j) => {
    const alts = Array.isArray(e.text) ? e.text : [e.text];
    expected.push({ id: `artifact-${j + 1}`, in: 'artifact', match: alts.map(t => [e.file, ...one(t)]) });
  });
  (c.must_report || []).forEach((e, j) => expected.push({ id: e.name || `report-${j + 1}`, severity: e.severity, match: textReq(e.any_of || e.text || []) }));
  out.expected = expected;

  const plain = ['may_change', 'diff_must_contain', 'answer_must_contain', 'artifacts_must_exist', 'artifacts_must_contain', 'files_must_include'].some(k => k in c);
  if (!out.expect_verdict && plain) {out.expect_verdict = 'PASS';}
  out.kind = c.kind || (c.replay || c.run_ticket || c.run_dir ? 'replay' : (cons.max_changed_files === 0 ? 'clean' : 'seeded'));
  return out;
}

function loadCases(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let items;
  if (file.endsWith('.yaml') || file.endsWith('.yml')) {
    const y = require('js-yaml');
    items = y.load(raw) || [];
    if (!Array.isArray(items)) {throw new Error(`${path.relative(ROOT, file)}: expected a list of cases`);}
  } else {
    items = [];
    raw.split('\n').forEach((line, i) => {
      const l = line.trim();
      if (!l || l.startsWith('#')) {return;}
      try { items.push(JSON.parse(l)); } catch (e) { throw new Error(`${path.relative(ROOT, file)} line ${i + 1}: ${e.message}`); }
    });
  }
  return items.map((c, i) => normaliseCase(c, file, i));
}

function casesFileFor(dir) {
  for (const f of ['cases.yaml', 'cases.yml', 'cases.jsonl']) {if (fs.existsSync(path.join(dir, f))) {return path.join(dir, f);}}
  return null;
}

function loadTask(name) {
  const dir = path.join(TASKS_DIR, name);
  const adapterFile = path.join(dir, 'adapter.js');
  if (!fs.existsSync(adapterFile)) {throw new Error(`unknown task "${name}" — known: ${listTasks().join(', ') || '(none)'}; each task is a folder under ai/tasks/ with adapter.js + cases.yaml`);}
  const casesFile = casesFileFor(dir);
  return { name, dir, adapter: require(adapterFile), casesFile, cases: casesFile ? loadCases(casesFile) : [] };
}

function resultsDirFor(task) {
  return path.resolve(ROOT, task.adapter.resultsDir || path.join('ai', 'evals', 'results', task.name));
}

// Every expected signature across the task's cases, deduped by id — used to
// count phantoms: items reported where they were not expected.
function catalog(task) {
  const byId = new Map();
  for (const c of task.cases) {for (const e of c.expected || []) {if (!byId.has(e.id)) {byId.set(e.id, e);}}}
  return [...byId.values()];
}

// ---------------------------------------------------------------- grading

function gradeCase(task, c, opts) {
  const dir = opts.dir
    || (typeof task.adapter.replayDir === 'function' && c.kind === 'replay' ? task.adapter.replayDir(c) : null)
    || (c.run_dir ? path.resolve(ROOT, c.run_dir) : null);
  const row = {
    task: task.name, case_id: c.case_id, kind: c.kind, tags: c.tags || [],
    run_id: opts.runId || null, rep: opts.rep || 1, agent: opts.agent || null,
    graded_at: new Date().toISOString(),
    run_dir: dir ? path.relative(ROOT, dir) : null,
  };
  const expected = c.expected || [];

  let got;
  if (opts.oracle) {
    row.mode = 'oracle';
    got = { outputs: expected.map(e => ({ text: `[oracle] ${((e.match || [])[0] || []).join(' ')}`, severity: e.severity, kind: e.in || undefined })), complete: true, verdict: c.expect_verdict || null };
  } else if (opts.null) {
    row.mode = 'null';
    got = { outputs: [], complete: true, verdict: c.expect_verdict || null };
  } else {
    row.mode = 'run';
    if (!dir) {return { ...row, status: 'error', error_class: 'harness', error: 'no run dir — pass --dir, or give the case a run_dir / the adapter a replayDir()' };}
    got = task.adapter.collect(dir, c);
    if (!got) {return { ...row, status: 'error', error_class: 'harness', error: `nothing gradable in ${row.run_dir} — the run never started or its artifacts were not collected` };}
  }

  const outputs = got.outputs || [];
  const matched = [];
  const missed = [];
  for (const e of expected) {(outputs.some(o => task.adapter.matches(o, e)) ? matched : missed).push(e.id);}
  row.expected = expected.length;
  row.matched = matched;
  row.missed = missed;
  row.recall = expected.length ? matched.length / expected.length : null;

  const forbidden = (opts.catalog || []).filter(e => !expected.some(x => x.id === e.id));
  row.phantoms = outputs.filter(o => forbidden.some(e => task.adapter.matches(o, e))).map(o => String(o.text).slice(0, 90));

  row.verdict = got.verdict ?? null;
  row.expect_verdict = c.expect_verdict || null;
  row.verdict_ok = c.expect_verdict ? row.verdict === c.expect_verdict : null;

  row.outputs_total = outputs.length;
  row.cost_usd = typeof got.cost_usd === 'number' ? got.cost_usd : null;
  row.duration_min = typeof got.duration_min === 'number' ? got.duration_min : null;
  row.models = got.models || [];
  if (got.extra) {row.extra = got.extra;}
  if (got.unresolved) {row.unresolved = got.unresolved;}

  row.status = row.mode !== 'run' ? 'selfcheck' : (got.complete ? 'graded' : 'incomplete');
  return row;
}

function fmt(r) {
  if (r.status === 'error') {return `✗ ${r.task}/${r.case_id} [error/${r.error_class}] ${r.error}`;}
  const rec = r.recall === null ? 'recall –' : `recall ${r.matched.length}/${r.expected}${r.missed.length ? ` (missed: ${r.missed.join(', ')})` : ''}`;
  const v = r.expect_verdict ? `verdict ${r.verdict} (expected ${r.expect_verdict} ${r.verdict_ok ? '✓' : '✗'})` : `verdict ${r.verdict ?? '–'}`;
  const cost = typeof r.cost_usd === 'number' ? `$${r.cost_usd.toFixed(2)}` : '$–';
  const dur = typeof r.duration_min === 'number' ? `${Math.round(r.duration_min)} min` : '– min';
  const tail = r.unresolved && r.unresolved.length ? ` · unresolved: ${r.unresolved.join(', ')}` : '';
  return `${r.status === 'graded' ? '●' : '◐'} ${r.task}/${r.case_id}${r.agent ? ` [${r.agent}]` : ''} [${r.mode}${r.status !== 'graded' ? '/' + r.status : ''}] ${rec} · phantoms ${r.phantoms.length} · ${v} · ${r.outputs_total} outputs · ${cost} · ${dur}${tail}`;
}

function appendRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function readRows(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { o[a.slice(2)] = next; i++; } else { o[a.slice(2)] = true; }
    } else {o._.push(a);}
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const [taskName, caseId] = args._;
  if (!taskName || !caseId) {
    console.error('usage: grade.js <task> <case_id> [--dir D] [--rep N] [--run-id ID] [--oracle|--null] [--no-write] [--json]');
    console.error(`tasks: ${listTasks().join(', ') || '(none under ai/tasks/)'}`);
    process.exit(1);
  }
  let task;
  try { task = loadTask(taskName); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  const c = task.cases.find(x => x.case_id === caseId);
  if (!c) { console.error(`unknown case "${caseId}" — known: ${task.cases.map(x => x.case_id).join(', ')}`); process.exit(1); }
  const row = gradeCase(task, c, {
    dir: args.dir ? path.resolve(ROOT, args.dir) : null,
    rep: Number(args.rep) || 1,
    runId: args['run-id'] || null,
    oracle: !!args.oracle,
    null: !!args.null,
    catalog: catalog(task),
  });
  if (!args['no-write'] && row.mode === 'run') {
    appendRow(path.join(resultsDirFor(task), row.status === 'error' ? 'errors.jsonl' : 'results.jsonl'), row);
  }
  console.log(args.json ? JSON.stringify(row, null, 2) : fmt(row));
  if (row.mode === 'oracle' || row.mode === 'null') {
    const ok = row.mode === 'oracle'
      ? (row.recall === null || row.recall === 1) && row.phantoms.length === 0
      : (row.recall === null || row.recall === 0) && row.phantoms.length === 0;
    console.log(`${ok ? '✓' : '✗'} ${row.mode} self-check ${ok ? 'passed' : 'FAILED'} — ${row.mode === 'oracle' ? 'every expected item must match its own signature' : 'an empty output list must match nothing'}`);
    process.exit(ok ? 0 : 2);
  }
  process.exit(row.status === 'error' ? 2 : 0);
}

// ai/agents.yaml → { name: { command: [...], result, cost, duration, ... } }
function loadAgents() {
  const f = path.join(AI_DIR, 'agents.yaml');
  if (!fs.existsSync(f)) {return {};}
  const data = require('js-yaml').load(fs.readFileSync(f, 'utf8')) || {};
  const out = {};
  for (const [name, spec] of Object.entries(data)) {if (spec && Array.isArray(spec.command)) {out[name] = spec;}}
  return out;
}

module.exports = { ROOT, AI_DIR, TASKS_DIR, listTasks, loadTask, loadAgents, resultsDirFor, catalog, gradeCase, fmt, appendRow, readRows, parseArgs };
