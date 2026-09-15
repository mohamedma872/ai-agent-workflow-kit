#!/usr/bin/env node
'use strict';
// PostToolUse hook: after Claude edits or writes a source file under src/,
// run Prettier on it (the same formatter lint-staged applies at commit time),
// so diffs stay formatting-free. Silent on success; never blocks; skips
// anything outside src/ or not a ts/tsx/js/jsx/json file.
const path = require('path');
const { spawnSync } = require('child_process');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let p;
  try { p = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const root = process.env.CLAUDE_PROJECT_DIR || p.cwd || process.cwd();
  const file = (p.tool_input && (p.tool_input.file_path || p.tool_input.notebook_path)) || '';
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
  if (!rel || !rel.startsWith('src/') || !/\.(ts|tsx|js|jsx|json)$/.test(rel)) {process.exit(0);}
  spawnSync('npx', ['--no-install', 'prettier', '--write', '--log-level', 'silent', rel], { cwd: root, stdio: 'ignore', timeout: 20000 });
  process.exit(0);
});
