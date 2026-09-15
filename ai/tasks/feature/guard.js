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

    // approval is the human's act
    const isMarker = /(^|\/)ai\/runs\/[^/]+\/plan\.approved$/.test(target);
    const isApproveCmd = tool === 'Bash' && /ai\/tasks\/feature\/runs\.js\s+approve\b/.test(String(input.command || ''));
    if ((isMarker && ['Write', 'Edit'].includes(tool)) || isApproveCmd) {
      if (!evalMode()) {ask(`plan gate: approving the plan for run "${id}" — allow only if you have read and approved ai/runs/${id}/06-plan.md`);}
      return;
    }
    if (gateOpen(id)) {return;}

    const message = gate.message || `plan gate: run "${id}" has no approved plan yet — finish ai/runs/${id}/06-plan.md, get approval (AskUserQuestion, then plan.approved), then edit`;
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && !target.startsWith(runPrefix)) {deny(`${message} (${target || 'file'})`);}
    if (/^apply_patch$/i.test(tool)) {deny(message);}
    if (tool === 'Bash' && /\bgit\s+commit\b/.test(String(input.command || ''))) {deny(`plan gate: no commits before the plan for run "${id}" is approved`);}
  },
};
