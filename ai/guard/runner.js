#!/usr/bin/env node
'use strict';

/* Supervises ai/guard/engine.js and fails closed for risky operations if policy evaluation breaks. */
const { spawnSync } = require('child_process');
const path = require('path');
const { capabilityDecision } = require('./subagent-capabilities');

const ENGINE = path.join(__dirname, 'engine.js');
const SECRET_PATH_RE = /(^|\/)(?:\.env(?:\.[^/]*)?|\.mcp\.json|\.npmrc|\.netrc|\.pypirc|\.git-credentials|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision|kdbx|tfvars)|service[-_]?account[^/]*\.json|credentials?(?:\.[^/]*)?)$/i;
const MUTATING_SHELL_RE = /(?:^|[;&|]\s*)(?:rm|mv|cp|touch|mkdir|rmdir|install|ln|dd|patch|truncate|tee|chmod|chown|sudo|npm\s+publish|yarn\s+(?:npm\s+)?publish|pnpm\s+publish|git\s+(?:commit|push|reset|clean|restore|checkout\s+--|merge|rebase|tag|cherry-pick)|kubectl\s+(?:apply|delete)|terraform\s+(?:apply|destroy)|docker\s+(?:push|rm|rmi)|adb\s+(?:uninstall|shell\s+rm|pm\s+clear)|xcrun\s+simctl\s+(?:erase|delete))\b|(?:>>|>)(?!=)|\bsed\s+-[^;&|]*i\b|\bperl\s+(?:-[^\s]*i[^\s]*|-pi|-ip)\b|\b(?:python3?|ruby|node)\b[^;&|]*(?:write|open\s*\([^)]*,\s*['\"][wax+]|unlink|rename|remove|mkdir|copy)/i;
const READ_MCP_RE = /(?:^|_)(?:get|list|search|read|fetch|find|describe|lookup|parse|validate|autocomplete|whoami|auth_status|count|suggest|check|retrieve|query|status)(?:_|$)/i;

function fileTarget(payload) {
  const input = payload?.tool_input || {};
  return String(input.file_path || input.notebook_path || input.path || '');
}

function clearlyReadOnlyShell(command) {
  const cmd = String(command || '').trim();
  if (!cmd || MUTATING_SHELL_RE.test(cmd)) return false;
  if (/^(?:pwd|whoami)(?:\s|$)/i.test(cmd)) return true;
  if (/^(?:ls|grep|rg)\b/i.test(cmd)) return true;
  if (/^git\s+(?:status|diff|log|show|rev-parse|branch\s+--show-current)\b/i.test(cmd)) return true;
  if (/^(?:node|npm)\s+--version\b/i.test(cmd)) return true;
  if (/^cat\s+/i.test(cmd) && !SECRET_PATH_RE.test(cmd.replace(/^cat\s+/i, '').replace(/^['"]|['"]$/g, ''))) return true;
  if (/^find\s+/i.test(cmd) && !/\s-(?:delete|exec|execdir)\b/.test(cmd)) return true;
  if (/^echo\s+/i.test(cmd) && !/[<>]/.test(cmd)) return true;
  return false;
}

function riskClass(payload) {
  const tool = String(payload?.tool_name || '');
  const input = payload?.tool_input || {};
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent'].includes(tool) || /^apply_patch$/i.test(tool)) return 'protected-write';
  if (tool === 'Read') return SECRET_PATH_RE.test(fileTarget(payload)) ? 'secret-read' : 'read-only';
  if (tool === 'Bash' || tool === 'Shell') {
    const command = String(input.command || '');
    if (MUTATING_SHELL_RE.test(command)) return 'shell-mutation';
    if (clearlyReadOnlyShell(command)) return 'read-only';
    return 'unknown-shell';
  }
  if (tool.startsWith('mcp__')) return READ_MCP_RE.test(tool) ? 'read-only' : 'external-write';
  return 'unknown';
}

function shouldFailClosed(payload) {
  const risk = riskClass(payload);
  const failOpenReads = process.env.AI_GUARD_FAIL_OPEN_READ_ONLY !== '0';
  if (risk === 'read-only') return !failOpenReads;
  return true;
}

function engineFailure(stderr, status) {
  const text = String(stderr || '');
  return status !== 0 || /ai-guard:\s+(?:internal error|pack .* rule error)/i.test(text);
}

function denyEnvelope(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[ai-guard] guard-engine failure: ${reason}` } }) + '\n';
}

function supervise(payload, result) {
  if (!engineFailure(result.stderr, result.status)) return { failClosed: false, output: result.stdout || '', risk: riskClass(payload) };
  const risk = riskClass(payload);
  if (!shouldFailClosed(payload)) return { failClosed: false, output: result.stdout || '', risk };
  return { failClosed: true, output: denyEnvelope(`${risk} action denied because policy evaluation failed; retry after fixing the guard or use a clearly read-only diagnostic`), risk };
}

function selftest() {
  const assert = require('assert');
  const failed = { status: 0, stdout: '', stderr: 'ai-guard: internal error, allowing (boom)' };
  assert.strictEqual(supervise({ tool_name: 'Write', tool_input: { file_path: 'src/x.js' } }, failed).failClosed, true);
  assert.strictEqual(supervise({ tool_name: 'Read', tool_input: { file_path: '.env' } }, failed).failClosed, true);
  assert.strictEqual(supervise({ tool_name: 'Bash', tool_input: { command: 'rm -rf src' } }, failed).failClosed, true);
  assert.strictEqual(supervise({ tool_name: 'Bash', tool_input: { command: 'git status --short' } }, failed).failClosed, false);
  assert.strictEqual(supervise({ tool_name: 'Bash', tool_input: { command: 'git diff -- src/index.js' } }, failed).failClosed, false);
  assert.strictEqual(supervise({ tool_name: 'Read', tool_input: { file_path: 'src/index.js' } }, failed).failClosed, false);
  assert.strictEqual(supervise({ tool_name: 'mcp__jira__jira_add_comment', tool_input: {} }, failed).failClosed, true);
  assert.strictEqual(supervise({ tool_name: 'mcp__jira__jira_get_issue', tool_input: {} }, failed).failClosed, false);
  const pack = { status: 0, stdout: '', stderr: 'ai-guard: pack "feature" rule error, ignoring (boom)' };
  assert.strictEqual(supervise({ tool_name: 'Edit', tool_input: { file_path: 'src/x.js' } }, pack).failClosed, true);
  const saved = process.env.AI_GUARD_FAIL_OPEN_READ_ONLY;
  process.env.AI_GUARD_FAIL_OPEN_READ_ONLY = '0';
  assert.strictEqual(supervise({ tool_name: 'Read', tool_input: { file_path: 'src/index.js' } }, failed).failClosed, true);
  if (saved === undefined) delete process.env.AI_GUARD_FAIL_OPEN_READ_ONLY; else process.env.AI_GUARD_FAIL_OPEN_READ_ONLY = saved;
  console.log('guard fail-closed supervisor selftest OK');
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => {
    let payload;
    try { payload = JSON.parse(raw || '{}'); }
    catch { process.stdout.write(denyEnvelope('invalid hook payload; cannot safely classify operation')); return; }
    const args = process.argv.slice(2).filter(x => x !== '--selftest');
    const capability = capabilityDecision(payload, process.env);
    if (!capability.allow) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[ai-guard] subagent capability: ${capability.reason}` } }) + '\n');
      return;
    }
    const child = spawnSync(process.execPath, [ENGINE, ...args], { input: raw, encoding: 'utf8', env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 20000 });
    if (child.stderr) process.stderr.write(child.stderr);
    const result = supervise(payload, { status: child.status, stdout: child.stdout, stderr: child.stderr || (child.error ? child.error.message : '') });
    process.stdout.write(result.output || '');
  });
}

if (require.main === module) main();
module.exports = { riskClass, clearlyReadOnlyShell, shouldFailClosed, engineFailure, supervise, denyEnvelope };
