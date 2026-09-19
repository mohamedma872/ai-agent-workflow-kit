'use strict';
/*
 * feature — THE PLAN GATE, enforced by the fence.
 *
 * While a /feature run is active (ai/runs/_active) and ai/runs/<id>/plan.approved
 * does not exist:
 *   - structured edits outside ai/runs/ are denied;
 *   - apply_patch is denied;
 *   - shell commands that can mutate files are denied unless they are scoped to
 *     ai/runs/ or an approved workflow helper;
 *   - git commit is denied.
 *
 * Approval is a human action. Direct mutation of plan.approved / _active is
 * denied; use runs.js approve so the guard can ask the user.
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
  if (fs.existsSync(path.join(dir, 'plan.approved'))) return true;
  if (evalMode()) {
    const p = path.join(dir, '06-plan.md');
    return fs.existsSync(p) && fs.statSync(p).size >= 200;
  }
  return false;
}

const WORKFLOW_HELPER_RE = /\bnode\s+ai\/tasks\/feature\/runs\.js\s+(?:start|status|set|select-roles|set-role|evidence|reconcile|approve|close|selftest)\b/;
const RUN_PATH_RE = /(?:^|[\s'"=])(?:\.\/)?ai\/runs\//;
const SHELL_WRITE_RE = new RegExp([
  String.raw`(?:^|[;&|]\s*)(?:touch|rm|mv|cp|tee|truncate|install|ln|dd|mkdir|rmdir|patch)\b`,
  String.raw`\bsed\s+-[^;&|]*i\b`,
  String.raw`\bperl\s+(?:-[^\s]*i[^\s]*|-pi|-ip)\b`,
  String.raw`(?:^|[^<])(?:>>|>)(?!=)`,
  String.raw`\bpython3?\b.*(?:open\s*\([^)]*,\s*['"][wax+]|write_text\s*\(|write_bytes\s*\(|shutil\.(?:copy|move)|os\.(?:remove|rename|replace|mkdir|makedirs))`,
  String.raw`\bnode\b[^;&|]*(?:-e\s+)?[^;&|]*(?:writeFile|appendFile|copyFile|rename|unlink|rm|mkdir)(?:Sync)?\s*\(`,
  String.raw`\bruby\b[^;&|]*(?:File\.(?:write|open|rename|delete)|IO\.write)`,
].join('|'));

function mutatesWorkflowMarker(cmd) {
  if (!/(?:plan\.approved|ai\/runs\/_active)/.test(cmd)) return false;
  return SHELL_WRITE_RE.test(cmd) || /(?:writeFile|appendFile|unlink|rename)Sync?\s*\(/.test(cmd);
}

function isRunScopedWrite(cmd) {
  if (!SHELL_WRITE_RE.test(cmd)) return false;
  if (!RUN_PATH_RE.test(cmd)) return false;

  const repoPaths = String(cmd).match(/(?:\.\/)?(?:ai|src|app|lib|android|ios|packages|apps|docs|\.github|\.claude|\.codex)\/[A-Za-z0-9_./-]+/g) || [];
  return repoPaths.length > 0 && repoPaths.every(p => p.replace(/^\.\//, '').startsWith('ai/runs/'));
}

function shellMutationProblem(cmd) {
  if (!SHELL_WRITE_RE.test(cmd)) return null;
  if (WORKFLOW_HELPER_RE.test(cmd)) return null;
  if (isRunScopedWrite(cmd)) return null;
  return 'plan gate: shell command can mutate repository files before plan approval; write only under ai/runs/ or wait for approval';
}

module.exports = {
  rules(payload, ctx, { deny, ask }) {
    const id = activeRun();
    if (!id) return;
    const tool = payload.tool_name || '';
    const input = payload.tool_input || {};
    const rel = p => ctx.rel(String(p || ''));
    const gate = cfg().plan_gate || {};
    const runPrefix = 'ai/runs/';
    const target = rel(input.file_path || input.notebook_path || '');
    const cmd = String(input.command || '');
    const shell = tool === 'Bash' || tool === 'Shell';

    const isMarker = /(^|\/)ai\/runs\/[^/]+\/plan\.approved$/.test(target);
    const isApproveCmd = shell && /ai\/tasks\/feature\/runs\.js\s+approve\b/.test(cmd);
    if (shell && mutatesWorkflowMarker(cmd) && !isApproveCmd) {
      deny('plan gate: workflow state markers (plan.approved / ai/runs/_active) cannot be modified directly; use ai/tasks/feature/runs.js');
      return;
    }
    if ((isMarker && ['Write', 'Edit'].includes(tool)) || isApproveCmd) {
      if (!evalMode()) ask(`plan gate: approving the plan for run "${id}" — allow only if you have read and approved ai/runs/${id}/06-plan.md`);
      return;
    }
    if (gateOpen(id)) return;

    const message = gate.message || `plan gate: run "${id}" has no approved plan yet — finish ai/runs/${id}/06-plan.md, get approval, then edit`;
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && !target.startsWith(runPrefix)) {
      deny(`${message} (${target || 'file'})`);
      return;
    }
    if (/^apply_patch$/i.test(tool)) {
      deny(message);
      return;
    }
    if (shell && /\bgit\s+commit\b/.test(cmd)) {
      deny(`plan gate: no commits before the plan for run "${id}" is approved`);
      return;
    }
    if (shell) {
      const problem = shellMutationProblem(cmd);
      if (problem) deny(problem);
    }
  },
  _test: { SHELL_WRITE_RE, isRunScopedWrite, shellMutationProblem },
};
