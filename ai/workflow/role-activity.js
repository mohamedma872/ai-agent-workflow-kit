#!/usr/bin/env node
'use strict';

// What each role is doing right now. router.js streams the agent's own event
// output (claude --output-format stream-json, codex --json) through a writer
// that keeps one short line per action in <run>/engine/<stage>-<role>.activity.jsonl:
// the tool it called and on what, the command it ran, what it said. The
// dashboard, `agentic progress` and `agentic activity` read the tail of that
// file. Only the summary is kept, never tool results or file contents, and
// every line is redacted (notify.js) and flattened before it is written.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// notify.js (redaction) is loaded where it is used: it requires progress.js,
// which requires this module for the read side.
const clean = (...args) => require('./notify').clean(...args);

const TEXT_MAX = 240;
const TAIL_BYTES = 64 * 1024;
const ROTATE_BYTES = 512 * 1024;
const SUFFIX = '.activity.jsonl';

function activityFile(runDir, stageId, roleName) { return path.join(runDir, 'engine', `${stageId}-${roleName}${SUFFIX}`); }

// ---------------------------------------------------------------- summarizing

// `cwd` may be one directory or several spellings of it (see createWriter).
function shortPath(file, cwd) {
  const value = String(file || '');
  if (!value || !cwd || !path.isAbsolute(value)) return value;
  for (const dir of [].concat(cwd)) {
    const rel = path.relative(dir, value);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return value;
}
function quote(text, max = 60) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return `"${value.length > max ? `${value.slice(0, max - 1)}…` : value}"`;
}
function hostOf(url) { try { return new URL(url).host || url; } catch { return url; } }
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}
function commandText(command) { return Array.isArray(command) ? command.join(' ') : String(command || ''); }
// `bash -lc "<script>"`, as codex reports its shell calls, reads better as the script.
function unwrapShell(command) {
  const parts = Array.isArray(command) ? command : null;
  if (parts && parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts[2];
  return commandText(command);
}

// One tool call as a human reads it: what was used, on what.
function toolLine(name, input, cwd) {
  const args = parseArgs(input);
  const file = shortPath(args.file_path || args.notebook_path || args.path || '', cwd);
  switch (name) {
    case 'Read': return { kind: 'tool', text: `Read ${file}` };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { kind: 'edit', text: `Edit ${file}` };
    case 'Write': return { kind: 'edit', text: `Write ${file}` };
    case 'Bash': case 'shell': case 'exec_command': return { kind: 'run', text: `$ ${unwrapShell(args.command ?? args.cmd)}` };
    case 'Grep': return { kind: 'tool', text: `Grep ${quote(args.pattern)}${file ? ` in ${file}` : ''}` };
    case 'Glob': return { kind: 'tool', text: `Glob ${args.pattern || ''}${file ? ` in ${file}` : ''}` };
    case 'LS': return { kind: 'tool', text: `List ${file}` };
    case 'WebFetch': return { kind: 'tool', text: `Fetch ${hostOf(args.url || '')}` };
    case 'WebSearch': return { kind: 'tool', text: `Search ${quote(args.query)}` };
    case 'Task': case 'Agent': return { kind: 'tool', text: `Agent: ${args.description || args.subagent_type || 'subtask'}` };
    case 'TodoWrite': {
      const current = (args.todos || []).find(todo => todo && todo.status === 'in_progress');
      return { kind: 'plan', text: current ? `Todo: ${current.activeForm || current.content}` : `Todo list (${(args.todos || []).length} items)` };
    }
    case 'apply_patch': return { kind: 'edit', text: 'Edit (patch)' };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
      if (mcp) return { kind: 'tool', text: `MCP ${mcp[1]}/${mcp[2]}` };
      return { kind: 'tool', text: String(name || 'tool') };
    }
  }
}

function say(text) {
  const value = String(text || '').trim();
  return value ? { kind: 'say', text: value } : null;
}

// Every claude stream-json line (system init, assistant turns, the result
// envelope) and every codex --json line (rollout `event_msg`/`response_item`
// and the newer `item.*` events) the activity cares about, as zero or more
// { kind, text } entries. Anything else, including tool results, gives none.
function summarizeEvent(event, cwd) {
  if (!event || typeof event !== 'object') return [];
  // claude
  if (event.type === 'system' && event.subtype === 'init') return [{ kind: 'start', text: `session started${event.model ? ` · ${event.model}` : ''}` }];
  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    const sub = event.parent_tool_use_id ? '(subagent) ' : '';
    const out = [];
    for (const block of event.message.content) {
      if (block?.type === 'tool_use') { const line = toolLine(block.name, block.input, cwd); out.push({ ...line, text: sub + line.text }); }
      else if (block?.type === 'text') { const line = say(block.text); if (line) out.push({ ...line, text: sub + line.text }); }
    }
    return out;
  }
  if (event.type === 'result') {
    const parts = [event.is_error ? 'stopped with an error' : 'finished'];
    if (typeof event.num_turns === 'number') parts.push(`${event.num_turns} turns`);
    if (typeof event.total_cost_usd === 'number') parts.push(`$${event.total_cost_usd.toFixed(2)}`);
    return [{ kind: event.is_error ? 'error' : 'done', text: parts.join(' · ') }];
  }
  // codex rollout events
  const payload = event.payload;
  if (event.type === 'event_msg' && payload) {
    switch (payload.type) {
      case 'exec_command_begin': return [{ kind: 'run', text: `$ ${unwrapShell(payload.command)}` }];
      case 'patch_apply_begin': return [{ kind: 'edit', text: `Edit ${Object.keys(payload.changes || {}).map(file => shortPath(file, cwd)).join(', ') || '(patch)'}` }];
      case 'mcp_tool_call_begin': return [{ kind: 'tool', text: `MCP ${payload.invocation?.server || '?'}/${payload.invocation?.tool || '?'}` }];
      case 'web_search_begin': return [{ kind: 'tool', text: `Search${payload.query ? ` ${quote(payload.query)}` : ''}` }];
      case 'agent_message': { const line = say(payload.message); return line ? [line] : []; }
      case 'task_complete': return payload.error ? [{ kind: 'error', text: `stopped: ${payload.error.message || 'error'}` }] : [{ kind: 'done', text: 'finished' }];
      default: return [];
    }
  }
  if (event.type === 'response_item' && payload) {
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      if (['shell', 'exec_command', 'apply_patch'].includes(payload.name)) return [];
      return [toolLine(payload.name, payload.arguments ?? payload.input, cwd)];
    }
    return [];
  }
  // codex `item.*` events
  if ((event.type === 'item.started' || event.type === 'item.completed') && event.item) {
    const item = event.item;
    if (event.type === 'item.started' && item.type === 'command_execution') return [{ kind: 'run', text: `$ ${unwrapShell(item.command)}` }];
    if (event.type === 'item.completed') {
      if (item.type === 'agent_message') { const line = say(item.text); return line ? [line] : []; }
      if (item.type === 'file_change') return [{ kind: 'edit', text: `Edit ${(item.changes || []).map(change => shortPath(change.path, cwd)).join(', ') || '(patch)'}` }];
      if (item.type === 'mcp_tool_call') return [{ kind: 'tool', text: `MCP ${item.server || '?'}/${item.tool || '?'}` }];
      if (item.type === 'web_search') return [{ kind: 'tool', text: `Search ${quote(item.query)}` }];
    }
    return [];
  }
  if (event.type === 'turn.failed') return [{ kind: 'error', text: `stopped: ${event.error?.message || 'error'}` }];
  return [];
}

// ---------------------------------------------------------------- writing

// Line-buffers an agent's stdout and appends one redacted, one-line entry per
// action. A file grown past ROTATE_BYTES is moved aside first, so a long run
// keeps its previous attempt and the file stays small. Writing never throws:
// losing the activity must not fail the role.
function createWriter(file, options = {}) {
  const { env = process.env, now = () => new Date() } = options;
  // Agents report real paths: on macOS /var/… comes back as /private/var/….
  let cwd = options.cwd || null;
  if (cwd) { try { const real = fs.realpathSync(cwd); if (real !== cwd) cwd = [cwd, real]; } catch { /* keep as given */ } }
  let pending = '';
  let ok = true;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, file.replace(/\.jsonl$/, '.prev.jsonl')); } catch { /* no file yet */ }
  } catch { ok = false; }
  const append = entry => {
    if (!ok || !entry) return;
    const text = clean(entry.text, TEXT_MAX, env);
    if (!text) return;
    try { fs.appendFileSync(file, `${JSON.stringify({ t: now().toISOString(), kind: entry.kind, text })}\n`); } catch { ok = false; }
  };
  const line = raw => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed[0] !== '{') return;
    let event;
    try { event = JSON.parse(trimmed); } catch { return; }
    for (const entry of summarizeEvent(event, cwd)) append(entry);
  };
  return {
    note: (kind, text) => append({ kind, text }),
    push(chunk) {
      pending += String(chunk);
      let at;
      while ((at = pending.indexOf('\n')) >= 0) { line(pending.slice(0, at)); pending = pending.slice(at + 1); }
    },
    end() { if (pending) line(pending); pending = ''; },
  };
}

// ---------------------------------------------------------------- reading

// The last `limit` entries of an activity file, oldest first. Reads only the
// tail, so a long log costs the same as a short one.
function readActivity(file, limit = 20) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();
    const entries = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try { const entry = JSON.parse(raw); if (entry && typeof entry.text === 'string') entries.push(entry); } catch { /* partial line */ }
    }
    return entries.slice(-limit);
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function latestActivity(file) { return readActivity(file, 1)[0] || null; }

// Every role with an activity file in the run, newest first.
function activityFiles(runDir) {
  const dir = path.join(runDir, 'engine');
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith(SUFFIX)); } catch { return []; }
  return names.map(name => {
    const file = path.join(dir, name);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* gone */ }
    return { key: name.slice(0, -SUFFIX.length), file, mtime };
  }).sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------- descriptions

// What each workflow role does, in one line: the role's optional `summary`,
// else the first sentence of its `purpose`. Stage → role for single-role stages.
let catalog = null;
function roleCatalog() {
  if (catalog) return catalog;
  catalog = { roles: {}, stageRole: {}, stages: [] };
  try {
    const yaml = require('js-yaml');
    const wf = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'feature.yaml'), 'utf8')) || {};
    for (const [name, role] of Object.entries(wf.roles || {})) {
      const text = role?.summary || String(role?.purpose || '').split(/(?<=[.;])\s/)[0];
      catalog.roles[name] = String(text || '').replace(/\s+/g, ' ').replace(/[.;]$/, '').trim();
    }
    for (const stage of wf.stages || []) {
      if (stage?.id) catalog.stages.push(stage.id);
      if (stage?.role) catalog.stageRole[stage.id] = stage.role;
      else if (stage?.owner === 'orchestrator') catalog.stageRole[stage.id] = 'orchestration';
    }
  } catch { /* no descriptions */ }
  return catalog;
}
function describeRole(roleName) { return roleCatalog().roles[roleName] || null; }
function stageRole(stageId) { return roleCatalog().stageRole[stageId] || null; }
// "<stage>-<role>" back into its parts; stage ids and role names both contain dashes.
function splitKey(key) {
  const stage = roleCatalog().stages.filter(id => key.startsWith(`${id}-`)).sort((a, b) => b.length - a.length)[0];
  return stage ? { stage, role: key.slice(stage.length + 1) } : { stage: null, role: key };
}

// ---------------------------------------------------------------- CLI

function ago(iso, nowMs = Date.now()) {
  const ms = nowMs - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
function clock(iso) { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 8) : '--:--:--'; }
function formatEntry(entry) { return `${clock(entry.t)}  ${entry.text}`; }

// `agentic activity <run-id> [role|stage-role] [--follow] [--lines N] [--json]`.
// With no role: every role that is running now, else the most recent one.
function cli(argv) {
  const { stateRoot } = require('./paths');
  const args = { run: null, role: null, follow: false, lines: 30, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--follow' || arg === '-f') args.follow = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--lines' || arg === '-n') args.lines = Math.max(1, Number(argv[++i]) || 30);
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (!args.run) args.run = arg;
    else if (!args.role) args.role = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!args.run) throw new Error('usage: agentic activity <run-id> [role] [--follow] [--lines N] [--json]');
  const runDir = path.join(stateRoot(), args.run);
  if (!fs.existsSync(path.join(runDir, 'state.json'))) throw new Error(`no run ${args.run}`);
  const pick = () => {
    const files = activityFiles(runDir);
    if (args.role) return files.filter(entry => entry.key === args.role || entry.key.endsWith(`-${args.role}`));
    let state = {};
    try { state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')); } catch { /* none */ }
    const running = new Set();
    for (const [stage, group] of Object.entries(state.roles || {})) for (const [role, entry] of Object.entries(group || {})) if (entry?.status === 'in_progress') running.add(`${stage}-${role}`);
    for (const [stage, entry] of Object.entries(state.phases || {})) if (entry?.status === 'in_progress' && stageRole(stage)) running.add(`${stage}-${stageRole(stage)}`);
    for (const [stage, group] of Object.entries(state.conditionals || {})) for (const [role, entry] of Object.entries(group || {})) if (entry?.status === 'in_progress') running.add(`${stage}-${role}`);
    const live = files.filter(entry => running.has(entry.key));
    return live.length ? live : files.slice(0, 1);
  };
  const files = pick();
  if (!files.length) {
    console.log(args.role ? `No activity recorded for ${args.role} in ${args.run}.` : `No activity recorded in ${args.run} yet.`);
    return;
  }
  if (args.json) {
    console.log(JSON.stringify(files.map(entry => ({ role: entry.key, description: describeRole(splitKey(entry.key).role), entries: readActivity(entry.file, args.lines) })), null, 2));
    return;
  }
  const multi = files.length > 1;
  const seen = new Map();
  for (const entry of files) {
    const entries = readActivity(entry.file, args.lines);
    if (!multi) console.log(`── ${entry.key} ──`);
    for (const item of entries) console.log(multi ? `[${entry.key}] ${formatEntry(item)}` : formatEntry(item));
    seen.set(entry.file, entries.length ? entries[entries.length - 1].t + entries[entries.length - 1].text : '');
  }
  if (!args.follow) return;
  // Follow: print what is new in each followed file, once a second.
  const timer = setInterval(() => {
    for (const entry of pick()) {
      const recent = readActivity(entry.file, 200);
      const marker = seen.get(entry.file);
      const from = marker === undefined ? Math.max(0, recent.length - args.lines) : recent.findIndex(item => item.t + item.text === marker) + 1;
      for (const item of recent.slice(from)) console.log(multi || !seen.has(entry.file) ? `[${entry.key}] ${formatEntry(item)}` : formatEntry(item));
      if (recent.length) seen.set(entry.file, recent[recent.length - 1].t + recent[recent.length - 1].text);
    }
  }, 1000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ---------------------------------------------------------------- selftest

function selftest() {
  const cwd = '/work/app';
  const claude = event => summarizeEvent(event, cwd);
  assert.deepStrictEqual(claude({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }), [{ kind: 'start', text: 'session started · claude-opus-5-5' }]);
  assert.deepStrictEqual(claude({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'secret plan' },
    { type: 'text', text: 'Checking the login flow.' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/work/app/lib/login.dart' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'flutter test test/login_test.dart' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'token', path: '/work/app/lib' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/elsewhere/x.dart' } },
    { type: 'tool_use', name: 'mcp__context7__query-docs', input: {} },
    { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'Fix b', activeForm: 'Fixing b', status: 'in_progress' }] } },
  ] } }), [
    { kind: 'say', text: 'Checking the login flow.' },
    { kind: 'tool', text: 'Read lib/login.dart' },
    { kind: 'run', text: '$ flutter test test/login_test.dart' },
    { kind: 'tool', text: 'Grep "token" in lib' },
    { kind: 'edit', text: 'Edit /elsewhere/x.dart' },
    { kind: 'tool', text: 'MCP context7/query-docs' },
    { kind: 'plan', text: 'Todo: Fixing b' },
  ], 'thinking is never shown; paths inside the worktree are relative');
  assert.deepStrictEqual(claude({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/work/app/a' } }] } }), [{ kind: 'tool', text: '(subagent) Read a' }]);
  assert.deepStrictEqual(claude({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file body with password=hunter2' }] } }), [], 'tool results are never kept');
  assert.deepStrictEqual(claude({ type: 'result', is_error: false, num_turns: 7, total_cost_usd: 0.4212 }), [{ kind: 'done', text: 'finished · 7 turns · $0.42' }]);
  // codex, both event formats
  assert.deepStrictEqual(claude({ type: 'event_msg', payload: { type: 'exec_command_begin', command: ['bash', '-lc', 'dart analyze lib'] } }), [{ kind: 'run', text: '$ dart analyze lib' }]);
  assert.deepStrictEqual(claude({ type: 'event_msg', payload: { type: 'patch_apply_begin', changes: { '/work/app/lib/a.dart': {} } } }), [{ kind: 'edit', text: 'Edit lib/a.dart' }]);
  assert.deepStrictEqual(claude({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'hidden' } }), []);
  assert.deepStrictEqual(claude({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}' } }), [], 'shell calls are told once, by exec_command_begin');
  assert.deepStrictEqual(claude({ type: 'item.started', item: { type: 'command_execution', command: 'bash -lc "ls"' } }), [{ kind: 'run', text: '$ bash -lc "ls"' }]);
  assert.deepStrictEqual(claude({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/work/app/b.dart', kind: 'update' }] } }), [{ kind: 'edit', text: 'Edit b.dart' }]);
  assert.deepStrictEqual(claude({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'usage limit' } } }), [{ kind: 'error', text: 'stopped: usage limit' }]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'role-activity-'));
  try {
    const run = path.join(tmp, 'RUN-1');
    const file = activityFile(run, 'analysis', 'security');
    assert.strictEqual(file, path.join(run, 'engine', 'analysis-security.activity.jsonl'));
    const env = { MY_API_TOKEN: 'abcd1234efgh5678' };
    let tick = 0;
    const writer = createWriter(file, { cwd, env, now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, tick++)) });
    writer.note('start', 'claude started');
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcd1234efgh5678" https://x\n\x1b]52;c;ZXZpbA==\x07' } }] } });
    // Split mid-line: the writer must buffer until the newline.
    writer.push(line.slice(0, 40));
    writer.push(`${line.slice(40)}\nnot json\n`);
    writer.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(500) }] } }));
    writer.end();
    const entries = readActivity(file);
    assert.strictEqual(entries.length, 3);
    assert.deepStrictEqual(entries.map(e => e.kind), ['start', 'run', 'say']);
    assert.ok(!entries[1].text.includes('abcd1234efgh5678'), 'secrets are redacted before they are written');
    assert.ok(!/[\u0000-\u001f]/.test(entries[1].text), 'control characters and escapes are removed');
    assert.ok(entries[2].text.length <= TEXT_MAX, 'lines are bounded');
    assert.strictEqual(latestActivity(file).kind, 'say');
    assert.strictEqual(readActivity(file, 2).length, 2);
    assert.deepStrictEqual(readActivity(path.join(tmp, 'missing.jsonl')), []);
    // Tail reading over a long file still returns whole entries.
    for (let i = 0; i < 2000; i += 1) fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), kind: 'tool', text: `Read file-${i}.dart` })}\n`);
    assert.strictEqual(latestActivity(file).text, 'Read file-1999.dart');
    assert.strictEqual(readActivity(file, 5)[0].text, 'Read file-1995.dart');
    // A large file is moved aside when the next attempt starts.
    fs.appendFileSync(file, 'x'.repeat(ROTATE_BYTES));
    createWriter(file, { env }).note('start', 'codex started');
    assert.ok(fs.existsSync(file.replace(/\.jsonl$/, '.prev.jsonl')));
    assert.deepStrictEqual(readActivity(file).map(e => e.text), ['codex started']);
    assert.deepStrictEqual(activityFiles(run).map(e => e.key), ['analysis-security']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  assert.match(describeRole('security'), /^Threat-model auth/);
  assert.ok(!/[.;]$/.test(describeRole('architect')), 'one sentence, no trailing period');
  assert.strictEqual(describeRole('no-such-role'), null);
  assert.strictEqual(stageRole('implementation'), 'implementation');
  assert.deepStrictEqual(splitKey('acceptance-criteria-orchestration'), { stage: 'acceptance-criteria', role: 'orchestration' });
  assert.deepStrictEqual(splitKey('reviews-security-review'), { stage: 'reviews', role: 'security-review' });
  assert.strictEqual(ago(new Date(Date.now() - 75000).toISOString()), '1m15s');
  console.log('role-activity selftest OK');
}

module.exports = { activityFile, summarizeEvent, toolLine, createWriter, readActivity, latestActivity, activityFiles, describeRole, stageRole, splitKey, ago, formatEntry, cli };

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    try { cli(process.argv.slice(2)); }
    catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 1; }
  }
}
