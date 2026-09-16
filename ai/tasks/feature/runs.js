#!/usr/bin/env node
'use strict';
/*
 * ai/tasks/feature/runs.js — state store for /feature workflow progress.
 *
 *   start <id>
 *   status [id]
 *   set <phase> <status> [note]
 *   set-role <analysis|reviews> <role> <status> [executor] [note]
 *   approve [id]
 *   close
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const ACTIVE = path.join(RUNS, '_active');
const PHASES = ['request', 'requirements', 'acceptance-criteria', 'definition-of-done', 'inspection', 'analysis', 'plan', 'approval', 'implementation', 'build-test', 'reviews', 'fixes', 'verification'];
const ROLE_GROUPS = ['analysis', 'reviews'];
const STATUSES = ['pending', 'in_progress', 'pass', 'fail', 'blocked', 'skipped'];
const ICONS = { pass: '✓', fail: '✗', blocked: '⛔', skipped: '~', in_progress: '▸', pending: '·' };

const [cmd, ...rest] = process.argv.slice(2);
const usage = () => {
  console.error('usage: runs.js start <id> | status [id] | set <phase> <status> [note] | set-role <analysis|reviews> <role> <status> [executor] [note] | approve [id] | close');
  process.exit(1);
};
const activeId = () => { try { const id = fs.readFileSync(ACTIVE, 'utf8').trim(); return id && fs.existsSync(path.join(RUNS, id)) ? id : null; } catch { return null; } };
const stateFile = id => path.join(RUNS, id, 'state.json');
const load = id => { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { return null; } };
const save = (id, state) => {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(stateFile(id), JSON.stringify(state, null, 2) + '\n');
};
const safeId = id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id || '');
const safeRole = role => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(role || '');

function ensureShape(state, id) {
  const value = state || { id, status: 'active', startedAt: new Date().toISOString() };
  value.phases ||= {};
  value.roles ||= {};
  return value;
}

function render(id, state) {
  console.log(`${id} — /feature run (${state.status})${fs.existsSync(path.join(RUNS, id, 'plan.approved')) ? ' · plan approved' : ' · plan NOT approved (edits outside ai/runs are denied)'}`);
  for (const phase of PHASES) {
    const entry = state.phases?.[phase] || { status: 'pending' };
    console.log(`  ${ICONS[entry.status] || '·'} ${phase.padEnd(19)} ${entry.status.padEnd(12)}${entry.note ? ` — ${entry.note}` : ''}`);
    for (const [role, roleState] of Object.entries(state.roles?.[phase] || {})) {
      console.log(`      ${ICONS[roleState.status] || '·'} ${role.padEnd(18)} ${String(roleState.status).padEnd(12)}${roleState.executor ? ` · ${roleState.executor}` : ''}${roleState.note ? ` — ${roleState.note}` : ''}`);
    }
  }
  const next = PHASES.find(phase => !state.phases?.[phase] || ['pending', 'in_progress', 'fail', 'blocked'].includes(state.phases[phase].status));
  console.log(`\n→ resume at: ${next || 'done'}`);
}

switch (cmd) {
  case 'start': {
    const id = rest[0];
    if (!safeId(id)) usage();
    fs.mkdirSync(path.join(RUNS, id, '05-analysis'), { recursive: true });
    fs.mkdirSync(path.join(RUNS, id, '09-reviews'), { recursive: true });
    let state = load(id);
    if (!state) {
      state = ensureShape(null, id);
      save(id, state);
      console.log(`created ai/runs/${id}/`);
    } else {
      state = ensureShape(state, id);
      console.log(`ai/runs/${id}/ exists — resuming`);
    }
    fs.writeFileSync(ACTIVE, `${id}\n`);
    render(id, state);
    break;
  }
  case 'status': {
    const id = rest[0] || activeId();
    if (!id) { console.log('no active /feature run'); break; }
    const state = load(id);
    if (!state) { console.log(`no state for ${id}`); break; }
    render(id, ensureShape(state, id));
    break;
  }
  case 'set': {
    const [phase, status] = rest;
    const note = rest.slice(2).join(' ');
    const id = activeId();
    if (!id) { console.error('no active run — runs.js start <id> first'); process.exit(1); }
    if (!PHASES.includes(phase)) { console.error(`unknown phase "${phase}" — one of: ${PHASES.join(', ')}`); process.exit(1); }
    if (!STATUSES.includes(status)) { console.error(`unknown status "${status}" — one of: ${STATUSES.join(', ')}`); process.exit(1); }
    const state = ensureShape(load(id), id);
    state.phases[phase] = { status, updatedAt: new Date().toISOString(), ...(note ? { note } : {}) };
    save(id, state);
    console.log(`${id} ${phase} → ${status}${note ? ` (${note})` : ''}`);
    break;
  }
  case 'set-role': {
    const [group, role, status, executor] = rest;
    const note = rest.slice(4).join(' ');
    const id = activeId();
    if (!id) { console.error('no active run — runs.js start <id> first'); process.exit(1); }
    if (!ROLE_GROUPS.includes(group)) { console.error(`unknown role group "${group}" — one of: ${ROLE_GROUPS.join(', ')}`); process.exit(1); }
    if (!safeRole(role)) { console.error('invalid role name'); process.exit(1); }
    if (!STATUSES.includes(status)) { console.error(`unknown status "${status}" — one of: ${STATUSES.join(', ')}`); process.exit(1); }
    const state = ensureShape(load(id), id);
    state.roles[group] ||= {};
    state.roles[group][role] = {
      status,
      updatedAt: new Date().toISOString(),
      ...(executor && executor !== '-' ? { executor } : {}),
      ...(note ? { note } : {}),
    };
    save(id, state);
    console.log(`${id} ${group}/${role} → ${status}${executor && executor !== '-' ? ` · ${executor}` : ''}${note ? ` (${note})` : ''}`);
    break;
  }
  case 'approve': {
    const id = rest[0] || activeId();
    if (!safeId(id) || !fs.existsSync(path.join(RUNS, id))) { console.error('unknown run'); process.exit(1); }
    const plan = path.join(RUNS, id, '06-plan.md');
    if (!fs.existsSync(plan) || fs.statSync(plan).size < 200) { console.error(`ai/runs/${id}/06-plan.md is missing or empty — nothing to approve`); process.exit(1); }
    fs.writeFileSync(path.join(RUNS, id, 'plan.approved'), `approved: ${new Date().toISOString()}\n`);
    const state = ensureShape(load(id), id);
    state.phases.approval = { status: 'pass', updatedAt: new Date().toISOString(), note: 'approved via runs.js' };
    save(id, state);
    console.log(`${id}: plan approved — edits outside ai/runs are allowed again`);
    break;
  }
  case 'close': {
    const id = activeId();
    if (!id) { console.log('no active run'); break; }
    const state = ensureShape(load(id), id);
    state.status = 'done';
    state.closedAt = new Date().toISOString();
    save(id, state);
    fs.unlinkSync(ACTIVE);
    console.log(`${id}: closed — no active /feature run`);
    break;
  }
  default:
    usage();
}
