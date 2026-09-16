'use strict';
/*
 * feature — THE PLAN GATE, enforced by the fence.
 *
 * While a /feature run is active (ai/runs/_active) and ai/runs/<id>/plan.approved
 * does not exist:
 *   - Edit / Write / MultiEdit / NotebookEdit / apply_patch outside ai/runs/ → deny
 *   - git commit → deny
 * Writing plan.approved (or `runs.js approve`) is the human's act → ask, except
 * in eval mode (AI_EVAL=1) where nobody is there: the gate opens once
 * 06-plan.md exists and is non-trivial.
 *
 * Direct shell mutation of plan.approved / _active is denied. This matters in a
 * multi-executor workflow: an implementation agent must not be able to open or
 * close the gate by touching workflow state directly.
 * Values (protected paths) come from guard.yaml next to this file.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');

function cfg() {
  try { return require('js-yaml').load(fs.readFileSync(path.join(__dirname, 'guard.yaml'), 'utf8')) || {}; } catch { return {}; }
}
function activeRun() {
  try { const id = fs.readFileSync(path.join(RUNS, '_active'), 'utf8').trim(); return id && fs.existsSync(path.join(RUNS, id)) ? id : null; } catch { return null; }
}
const evalMode = () => process.env.AI_EVAL === '1';
function gateOpen(id) {
  const dir = path.join(RUNS, id);
  if (fs.existsSync(path.join(dir, 'plan.approved'))) {return true;}
  if (evalMode()) { const p = path.join(dir, '06-plan.md'); return fs.existsSync(p) && fs.statSync(p).size >= 200; }
  return false;
}

function mutatesWorkflowMarker(cmd) {
  if (!/(?:plan\.approved|ai\/runs\/_active)/.test(cmd)) {return false;}
  return /(?:^|[;&|]\s*)(?:touch|rm|mv|cp|tee|truncate|install|ln|dd|python3?|node\s+-e|ruby|perl|sed\s+-i)\b|(?:>|>>)|(?:writeFile|appendFile|unlink|rename)Sync?\s*\(/.test(cmd);
}

module.exports = {
  rules(payload, ctx, { deny, ask }) {
    const id = activeRun();
    if (!id) {return;}
    const tool = payload.tool_name || '';
    const input = payload.tool_input || {};
    const rel = p => ctx.rel(String(p || ''));
    const gate = (cfg().plan_gate || {});
    const runPrefix = 'ai/runs/';
    const target = rel(input.file_path || input.notebook_path || '');
    const cmd = String(input.command || '');
    const shell = tool === 'Bash' || tool === 'Shell';

    // Approval is a human action. The official helper asks; direct shell
    // mutation is never accepted because it would make the marker forgeable.
    const isMarker = /(^|\/)ai\/runs\/[^/]+\/plan\.approved$/.test(target);
    const isApproveCmd = shell && /ai\/tasks\/feature\/runs\.js\s+approve\b/.test(cmd);
    if (shell && mutatesWorkflowMarker(cmd) && !isApproveCmd) {
      deny('plan gate: workflow state markers (plan.approved / ai/runs/_active) cannot be modified directly; use ai/tasks/feature/runs.js');
      return;
    }
    if ((isMarker && ['Write', 'Edit'].includes(tool)) || isApproveCmd) {
      if (!evalMode()) {ask(`plan gate: approving the plan for run "${id}" — allow only if you have read and approved ai/runs/${id}/06-plan.md`);}
      return;
    }
    if (gateOpen(id)) {return;}

    const message = gate.message || `plan gate: run "${id}" has no approved plan yet — finish ai/runs/${id}/06-plan.md, get approval (AskUserQuestion, then plan.approved), then edit`;
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && !target.startsWith(runPrefix)) {deny(`${message} (${target || 'file'})`);}
    if (/^apply_patch$/i.test(tool)) {deny(message);}
    if (shell && /\bgit\s+commit\b/.test(cmd)) {deny(`plan gate: no commits before the plan for run "${id}" is approved`);}
  },
};
