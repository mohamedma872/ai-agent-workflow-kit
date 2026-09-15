#!/usr/bin/env node
'use strict';
/*
 * ai/tasks/feature/runs.js — run folders for the /feature workflow.
 *
 *   node ai/tasks/feature/runs.js start <id>        create ai/runs/<id>/ (or print its state) and mark it active
 *   node ai/tasks/feature/runs.js status            active run + phase statuses
 *   node ai/tasks/feature/runs.js set <phase> <status> [note]   pending | in_progress | pass | fail | blocked | skipped
 *   node ai/tasks/feature/runs.js approve <id>      THE HUMAN's act: writes plan.approved and lifts the plan gate
 *   node ai/tasks/feature/runs.js close             mark done, stop being active (the gate no longer applies)
 *
 * Artifacts per run (written by the orchestrator, one per step):
 *   00-request.md · 01-requirements.md · 02-acceptance-criteria.md · 03-definition-of-done.md
 *   04-inspection.md · 05-analysis/<subagent>.md · 06-plan.md · plan.approved · 07-implementation.md
 *   08-build-test.md · 09-reviews/<subagent>.md · 10-fixes.md · 11-verification.md · state.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const ACTIVE = path.join(RUNS, '_active');
const PHASES = ['request', 'requirements', 'acceptance-criteria', 'definition-of-done', 'inspection', 'analysis', 'plan', 'approval', 'implementation', 'build-test', 'reviews', 'fixes', 'verification'];
const STATUSES = ['pending', 'in_progress', 'pass', 'fail', 'blocked', 'skipped'];
const ICONS = { pass: '✓', fail: '✗', blocked: '⛔', skipped: '~', in_progress: '▸', pending: '·' };

const [cmd, ...rest] = process.argv.slice(2);
const usage = () => { console.error('usage: runs.js start <id> | status | set <phase> <status> [note] | approve <id> | close'); process.exit(1); };
const activeId = () => { try { const id = fs.readFileSync(ACTIVE, 'utf8').trim(); return id && fs.existsSync(path.join(RUNS, id)) ? id : null; } catch { return null; } };
const stateFile = id => path.join(RUNS, id, 'state.json');
const load = id => { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { return null; } };
const save = (id, s) => fs.writeFileSync(stateFile(id), JSON.stringify(s, null, 2) + '\n');
const safeId = id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id || '');

function render(id, s) {
  console.log(`${id} — /feature run (${s.status})${fs.existsSync(path.join(RUNS, id, 'plan.approved')) ? ' · plan approved' : ' · plan NOT approved (edits outside ai/runs are denied)'}`);
  for (const p of PHASES) {
    const e = s.phases[p] || { status: 'pending' };
    console.log(`  ${ICONS[e.status] || '·'} ${p.padEnd(19)} ${e.status.padEnd(12)}${e.note ? ` — ${e.note}` : ''}`);
  }
  const next = PHASES.find(p => !s.phases[p] || ['pending', 'in_progress', 'fail'].includes(s.phases[p].status));
  console.log(`\n→ resume at: ${next || 'done'}`);
}

switch (cmd) {
  case 'start': {
    const id = rest[0];
    if (!safeId(id)) {usage();}
    fs.mkdirSync(path.join(RUNS, id, '05-analysis'), { recursive: true });
    fs.mkdirSync(path.join(RUNS, id, '09-reviews'), { recursive: true });
    let s = load(id);
    if (!s) { s = { id, status: 'active', startedAt: new Date().toISOString(), phases: {} }; save(id, s); console.log(`created ai/runs/${id}/`); }
    else {console.log(`ai/runs/${id}/ exists — resuming`);}
    fs.writeFileSync(ACTIVE, `${id}\n`);
    render(id, s);
    break;
  }
  case 'status': {
    const id = rest[0] || activeId();
    if (!id) { console.log('no active /feature run'); break; }
    const s = load(id);
    if (!s) { console.log(`no state for ${id}`); break; }
    render(id, s);
    break;
  }
  case 'set': {
    const [phase, status] = rest;
    const note = rest.slice(2).join(' ');
    const id = activeId();
    if (!id) { console.error('no active run — runs.js start <id> first'); process.exit(1); }
    if (!PHASES.includes(phase)) { console.error(`unknown phase "${phase}" — one of: ${PHASES.join(', ')}`); process.exit(1); }
    if (!STATUSES.includes(status)) { console.error(`unknown status "${status}" — one of: ${STATUSES.join(', ')}`); process.exit(1); }
    const s = load(id) || { id, status: 'active', phases: {} };
    s.phases[phase] = { status, updatedAt: new Date().toISOString(), ...(note ? { note } : {}) };
    save(id, s);
    console.log(`${id} ${phase} → ${status}${note ? ` (${note})` : ''}`);
    break;
  }
  case 'approve': {
    const id = rest[0] || activeId();
    if (!safeId(id) || !fs.existsSync(path.join(RUNS, id))) { console.error('unknown run'); process.exit(1); }
    const plan = path.join(RUNS, id, '06-plan.md');
    if (!fs.existsSync(plan) || fs.statSync(plan).size < 200) { console.error(`ai/runs/${id}/06-plan.md is missing or empty — nothing to approve`); process.exit(1); }
    fs.writeFileSync(path.join(RUNS, id, 'plan.approved'), `approved: ${new Date().toISOString()}\n`);
    const s = load(id) || { id, status: 'active', phases: {} };
    s.phases.approval = { status: 'pass', updatedAt: new Date().toISOString(), note: 'approved via runs.js' };
    save(id, s);
    console.log(`${id}: plan approved — edits outside ai/runs are allowed again`);
    break;
  }
  case 'close': {
    const id = activeId();
    if (!id) { console.log('no active run'); break; }
    const s = load(id) || { id, phases: {} };
    s.status = 'done';
    s.closedAt = new Date().toISOString();
    save(id, s);
    fs.unlinkSync(ACTIVE);
    console.log(`${id}: closed — no active /feature run`);
    break;
  }
  default:
    usage();
}
