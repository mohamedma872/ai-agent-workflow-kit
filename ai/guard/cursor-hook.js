#!/usr/bin/env node
'use strict';
/*
 * ai/guard/cursor-hook.js — Cursor adapter for the fence.
 *
 * Wired in .cursor/hooks.json for beforeShellExecution, beforeReadFile,
 * beforeMCPExecution and preToolUse. Cursor pipes its own payload on stdin;
 * this file maps it to the engine's native shape, runs the same rules as
 * Claude Code / Codex, and prints Cursor's response:
 *   {"permission": "allow"|"deny"|"ask", "user_message": "…", "agent_message": "…"}
 * Exit code is always 0; the JSON carries the decision.
 */
const path = require('path');
const { evaluate } = require(path.join(__dirname, 'engine.js'));

function toNative(p) {
  const cwd = p.cwd || p.workspace_roots?.[0] || process.cwd();
  const base = { cwd, session_id: p.conversation_id || p.session_id || 'cursor', scratchpad_dir: undefined, transcript_path: undefined };
  if (typeof p.command === 'string' && p.command && !p.tool_name) {return { ...base, tool_name: 'Bash', tool_input: { command: p.command } };}          // beforeShellExecution
  if (p.file_path && !p.tool_name && !p.edits) {return { ...base, tool_name: 'Read', tool_input: { file_path: p.file_path } };}                            // beforeReadFile
  if (p.mcp_server_name && p.tool_name) {return { ...base, tool_name: `mcp__${p.mcp_server_name}__${p.tool_name}`, tool_input: p.tool_input || {} };}     // beforeMCPExecution
  if (p.tool_name) {                                                                                                                                       // preToolUse (Cursor's own tools)
    const input = p.tool_input || {};
    const name = String(p.tool_name);
    if (typeof input.command === 'string') {return { ...base, tool_name: 'Bash', tool_input: { command: input.command } };}
    const file = input.file_path || input.path || input.target_file || input.relative_workspace_path;
    if (file) {
      const isRead = /read|view|open|cat|list|search|grep/i.test(name) && !/edit|write|create|replace|delete/i.test(name);
      return { ...base, tool_name: isRead ? 'Read' : 'Write', tool_input: { file_path: file, content: input.content || input.contents || input.code_edit || input.new_string || '' } };
    }
    return { ...base, tool_name: name, tool_input: input };
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  let p;
  try { p = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const native = toNative(p);
  if (!native) {process.exit(0);}
  const r = await evaluate(native);
  if (r.decision === 'allow') { process.stdout.write('{"permission":"allow"}\n'); process.exit(0); }
  const reason = `[ai-guard] ${r.reasons.join(' | ')}`;
  process.stdout.write(`${JSON.stringify({ permission: r.decision, user_message: reason, agent_message: reason })}\n`);
  process.exit(0);
});
