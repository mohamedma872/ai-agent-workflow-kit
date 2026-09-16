#!/usr/bin/env node
'use strict';
/*
 * ai/tasks/feature/runs.js — state store for /feature workflow progress.
 *
 *   start <id>
 *   status [id]
 *   set <phase> <status> [note]
 *   select-roles <analysis|reviews> <role...>
 *   set-role <analysis|reviews> <role> <status> [executor] [note]
 *   reconcile [id]
 *   approve [id]
 *   close
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const ACTIVE = path.join(RUNS, '_active');
const PHASES = ['request', 'requirements', 'acceptance-criteria', 'definition-of-done', 'inspection', 'analysis', 'plan', 'approval', 'implementation', 'build-test', 'reviews', 'fixes', 'verification'];
const ROLE_GROUPS = ['analysis', 'reviews'];
const STATUSES = ['pending', 'in_progress', 'pass', 'fail', 'blocked', 'skipped'];
const TERMINAL_ROLE_STATUSES = new Set(['pass', 'fail', 'blocked', 'skipped']);
const ICONS = { pass: '✓', fail: '✗', blocked: '⛔', skipped: '~', in_progress: '▸', pending: '·' };

const [cmd, ...rest] = process.argv.slice(2);
const usage = () => {
  console.error('usage: runs.js start <id> | status [id] | set <phase> <status> [note] | select-roles <analysis|reviews> <role...> | set-role <analysis|reviews> <role> <status> [executor] [note] | reconcile [id] | approve [id] | close | selftest');
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
const phaseStatus = (state, phase) => state.phases?.[phase]?.status || 'pending';

function ensureShape(state, id) {
  const value = state || { id, status: 'active', startedAt: new Date().toISOString() };
  value.phases ||= {};
  value.roles ||= {};
  value.selectedRoles ||= {};
  return value;
}

function selectedRoleNames(state, group) {
  const explicit = state.selectedRoles?.[group];
  if (Array.isArray(explicit) && explicit.length) return explicit;
  return Object.keys(state.roles?.[group] || {});
}

function deriveRoleGroupStatus(state, group, { allowLegacy = false } = {}) {
  const explicit = Array.isArray(state.selectedRoles?.[group]) && state.selectedRoles[group].length > 0;
  if (!explicit && !allowLegacy) return null;

  const names = selectedRoleNames(state, group);
  if (!names.length) return null;
  const statuses = names.map(role => state.roles?.[group]?.[role]?.status || 'pending');

  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.some(status => status === 'pending' || status === 'in_progress')) return 'in_progress';
  if (statuses.every(status => status === 'skipped')) return 'skipped';
  if (statuses.every(status => status === 'pass' || status === 'skipped')) return 'pass';
  return 'in_progress';
}

function downstreamStarted(state, phase) {
  const index = PHASES.indexOf(phase);
  return PHASES.slice(index + 1).some(next => phaseStatus(state, next) !== 'pending');
}

function setDerivedPhase(state, phase, status, note) {
  const current = state.phases?.[phase] || {};
  if (current.status === status) return false;
  state.phases[phase] = {
    ...current,
    status,
    updatedAt: new Date().toISOString(),
    ...(note ? { reconciliationNote: note } : {}),
  };
  return true;
}

function reconcileState(id, state) {
  let changed = false;

  // Human approval is authoritative evidence that the plan is complete.
  const approvalMarker = id && fs.existsSync(path.join(RUNS, id, 'plan.approved'));
  if ((approvalMarker || phaseStatus(state, 'approval') === 'pass') && ['pending', 'in_progress'].includes(phaseStatus(state, 'plan'))) {
    changed = setDerivedPhase(state, 'plan', 'pass', 'approval implies completed plan') || changed;
  }
  if (approvalMarker && phaseStatus(state, 'approval') !== 'pass') {
    changed = setDerivedPhase(state, 'approval', 'pass', 'plan.approved marker is authoritative') || changed;
  }

  for (const group of ROLE_GROUPS) {
    const hasExplicitSelection = Array.isArray(state.selectedRoles?.[group]) && state.selectedRoles[group].length > 0;
    const tracked = Object.values(state.roles?.[group] || {});
    const legacyCanClose = !hasExplicitSelection
      && tracked.length > 0
      && tracked.every(entry => TERMINAL_ROLE_STATUSES.has(entry.status))
      && downstreamStarted(state, group);
    const derived = deriveRoleGroupStatus(state, group, { allowLegacy: legacyCanClose });
    if (derived) {
      changed = setDerivedPhase(state, group, derived, hasExplicitSelection ? 'derived from selected role states' : 'reconciled legacy role states after downstream progress') || changed;
    }
  }

  return changed;
}

function render(id, state) {
  reconcileState(id, state);
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

function selftest() {
  const selected = ensureShape({ phases: { analysis: { status: 'in_progress' } }, roles: {}, selectedRoles: {} }, 'TEST');
  selected.selectedRoles.analysis = ['architect', 'security'];
  selected.roles.analysis = {
    architect: { status: 'pass' },
    security: { status: 'pending' },
  };
  assert.strictEqual(deriveRoleGroupStatus(selected, 'analysis'), 'in_progress');
  selected.roles.analysis.security.status = 'pass';
  assert.strictEqual(deriveRoleGroupStatus(selected, 'analysis'), 'pass');

  const legacy = ensureShape({
    phases: { analysis: { status: 'in_progress' }, plan: { status: 'in_progress' }, approval: { status: 'pass' } },
    roles: { analysis: { architect: { status: 'pass' }, security: { status: 'pass' } } },
  }, 'TEST');
  assert.strictEqual(downstreamStarted(legacy, 'analysis'), true);
  const legacyDerived = deriveRoleGroupStatus(legacy, 'analysis', { allowLegacy: true });
  assert.strictEqual(legacyDerived, 'pass');

  console.log('runs.js selftest OK');
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
      if (reconcileState(id, state)) save(id, state);
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
    reconcileState(id, state);
    save(id, state);
    console.log(`${id} ${phase} → ${state.phases[phase].status}${note ? ` (${note})` : ''}`);
    break;
  }
  case 'select-roles': {
    const [group, ...roles] = rest;
    const id = activeId();
    if (!id) { console.error('no active run — runs.js start <id> first'); process.exit(1); }
    if (!ROLE_GROUPS.includes(group)) { console.error(`unknown role group "${group}" — one of: ${ROLE_GROUPS.join(', ')}`); process.exit(1); }
    if (!roles.length || roles.some(role => !safeRole(role))) { console.error('select-roles requires one or more valid role names'); process.exit(1); }
    const state = ensureShape(load(id), id);
    const unique = [...new Set(roles)];
    state.selectedRoles[group] = unique;
    state.roles[group] ||= {};
    const now = new Date().toISOString();
    for (const role of unique) {
      state.roles[group][role] ||= { status: 'pending', updatedAt: now };
    }
    state.phases[group] = { ...(state.phases[group] || {}), status: 'in_progress', updatedAt: now };
    reconcileState(id, state);
    save(id, state);
    console.log(`${id} ${group} selected roles → ${unique.join(', ')}`);
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
    const selected = state.selectedRoles[group];
    if (Array.isArray(selected) && selected.length && !selected.includes(role)) {
      console.error(`role "${role}" was not selected for ${group}; selected: ${selected.join(', ')}`);
      process.exit(1);
    }
    state.roles[group] ||= {};
    state.roles[group][role] = {
      status,
      updatedAt: new Date().toISOString(),
      ...(executor && executor !== '-' ? { executor } : {}),
      ...(note ? { note } : {}),
    };
    reconcileState(id, state);
    save(id, state);
    console.log(`${id} ${group}/${role} → ${status}${executor && executor !== '-' ? ` · ${executor}` : ''}${note ? ` (${note})` : ''}; ${group} → ${state.phases[group]?.status || 'pending'}`);
    break;
  }
  case 'reconcile': {
    const id = rest[0] || activeId();
    if (!id || !safeId(id)) { console.error('no valid run to reconcile'); process.exit(1); }
    const state = load(id);
    if (!state) { console.error(`no state for ${id}`); process.exit(1); }
    const shaped = ensureShape(state, id);
    const changed = reconcileState(id, shaped);
    if (changed) save(id, shaped);
    console.log(`${id}: ${changed ? 'state reconciled' : 'state already consistent'}`);
    render(id, shaped);
    break;
  }
  case 'approve': {
    const id = rest[0] || activeId();
    if (!safeId(id) || !fs.existsSync(path.join(RUNS, id))) { console.error('unknown run'); process.exit(1); }
    const plan = path.join(RUNS, id, '06-plan.md');
    if (!fs.existsSync(plan) || fs.statSync(plan).size < 200) { console.error(`ai/runs/${id}/06-plan.md is missing or empty — nothing to approve`); process.exit(1); }
    const state = ensureShape(load(id), id);
    reconcileState(id, state);
    if (!['pass', 'skipped'].includes(phaseStatus(state, 'analysis'))) {
      console.error(`analysis is ${phaseStatus(state, 'analysis')} — complete selected analysis roles before approval`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(RUNS, id, 'plan.approved'), `approved: ${new Date().toISOString()}\n`);
    state.phases.plan = { ...(state.phases.plan || {}), status: 'pass', updatedAt: new Date().toISOString(), reconciliationNote: 'plan completed by human approval' };
    state.phases.approval = { status: 'pass', updatedAt: new Date().toISOString(), note: 'approved via runs.js' };
    reconcileState(id, state);
    save(id, state);
    console.log(`${id}: plan approved — plan → pass, approval → pass; edits outside ai/runs are allowed again`);
    break;
  }
  case 'close': {
    const id = activeId();
    if (!id) { console.log('no active run'); break; }
    const state = ensureShape(load(id), id);
    reconcileState(id, state);
    state.status = 'done';
    state.closedAt = new Date().toISOString();
    save(id, state);
    fs.unlinkSync(ACTIVE);
    console.log(`${id}: closed — no active /feature run`);
    break;
  }
  case 'selftest':
    selftest();
    break;
  default:
    usage();
}
