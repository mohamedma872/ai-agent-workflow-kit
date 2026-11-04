#!/usr/bin/env node
'use strict';

/*
 * Notifications for the moments a run needs a human: a stage blocked or failed,
 * a gate waiting (plan approval, architecture selection, specialist conflicts),
 * the run complete, a pull request opened.
 *
 * The ENGINE sends them, on its own transitions, so they arrive while the
 * progress terminal is closed. The progress terminal only rings its bell and
 * highlights the run (dashboard.js); it never pops a desktop notification, so
 * an event is shown once. Each event has a key (run, stage, status and the
 * moment of that transition); the key is recorded in state.notifications.sent
 * under the state lock before anything is shown, so a resume that finds the
 * same block, or two engines racing, do not send it twice.
 *
 * Channels are local only, never the network: macOS `osascript` (the title and
 * body are passed as argv to an `on run argv` handler, never spliced into the
 * script, and no shell is involved), Linux `notify-send` when it is on PATH,
 * otherwise none. On macOS the command to run is also the notification's
 * subtitle, so the popup shows it even when the body is cut to two lines.
 *
 * Text is redacted before it is shortened, never after: the pull-request
 * module's redaction (its named token variables, URL userinfo), the value of
 * every environment variable whose name says it is a secret, and the token
 * shapes CI and package tools print (GitHub, Anthropic/OpenAI, Slack, AWS, npm,
 * Atlassian, JWTs, Bearer headers, token=/password= pairs). Then it is
 * flattened to one line without control characters. The command a body ends
 * with is never cut; only the reason is shortened to fit.
 *
 * Config, from .agentic/config.yaml in the main checkout (where pull_request is
 * read): notifications: { desktop: true, bell: true }, both on by default.
 * Eval mode (AI_EVAL=1 / QC_EVAL=1) never notifies. Selftests set
 * AI_WORKFLOW_SELFTEST=1, which turns the desktop channel off; with
 * AI_WORKFLOW_TEST_NOTIFY_LOG=<file> as well, events are appended to that file
 * instead, so engine-level tests can count them.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const { evalMode, redact } = require('./pull-request');
const { withStateLock, writeJsonAtomic } = require('./state-lock');
const { labelOf, commandFor, completedAt, completeKey } = require('./progress');

const DEFAULTS = Object.freeze({ desktop: true, bell: true });
const KEEP_SENT = 200;
const TITLE_MAX = 80;
const BODY_MAX = 300;
const REASON_MAX = 160;
// YAML 1.2 (js-yaml 4) reads `off` and `no` as strings; they still mean false.
const SWITCH_WORDS = new Map([['true', true], ['yes', true], ['on', true], ['false', false], ['no', false], ['off', false]]);

function loadConfig(root) {
  const out = { ...DEFAULTS, problems: [] };
  const file = path.join(root, '.agentic', 'config.yaml');
  if (!fs.existsSync(file)) return out;
  let data;
  try { data = yaml.load(fs.readFileSync(file, 'utf8')); }
  catch { out.problems.push('.agentic/config.yaml is not valid YAML; notifications use their defaults'); return out; }
  const block = data && typeof data === 'object' ? data.notifications : undefined;
  if (block === undefined || block === null) return out;
  if (typeof block !== 'object' || Array.isArray(block)) { out.problems.push('notifications must be a mapping'); return out; }
  for (const key of ['desktop', 'bell']) {
    if (!(key in block)) continue;
    const value = block[key];
    const word = typeof value === 'string' ? value.trim().toLowerCase() : null;
    if (typeof value === 'boolean') out[key] = value;
    else if (word !== null && SWITCH_WORDS.has(word)) out[key] = SWITCH_WORDS.get(word);
    else out.problems.push(`notifications.${key} must be true or false (got ${JSON.stringify(value)}); using ${out[key]}`);
  }
  return out;
}

// Config problems are said once per process, where the engine or the progress
// terminal can be seen, instead of being dropped.
const warned = new Set();
function warnConfig(settings, warn = message => console.warn(message)) {
  for (const problem of settings?.problems || []) {
    if (warned.has(problem)) continue;
    warned.add(problem);
    warn(`⚠ .agentic/config.yaml: ${problem}`);
  }
}

// ---------------------------------------------------------------- redaction

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|_KEY|CREDENTIALS?|_PAT|_AUTH)$/i;
const TOKEN_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bAT(?:BB|ATT|CTT)[A-Za-z0-9_=+/-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];
// The text with every secret it may carry replaced by ***.
function redactSecrets(text, env = process.env) {
  let out = redact(String(text == null ? '' : text), env);
  const values = Object.entries(env || {})
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join('***');
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, '***');
  return out
    .replace(/\b(Bearer|Basic|token)\s+(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/(--(?:token|password|passwd|secret|api-key|auth-token))(=|\s+)(?!\*\*\*)\S+/gi, '$1$2***')
    .replace(/\b([\w.-]*(?:token|password|passwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|authorization))(["']?\s*[=:]\s*["']?)(?!\*\*\*)[^\s"'&,;)]+/gi, '$1$2***');
}

// One line, no control characters, no secrets, bounded. Redaction runs on the
// whole text first, so a cut can never leave half a secret behind.
function clean(text, max = BODY_MAX, env = process.env) {
  const value = redactSecrets(text, env)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return trimTo(value, max);
}
function trimTo(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return max >= 2 ? `${value.slice(0, max - 1)}…` : '';
}
// "<lead><reason><tail>": the tail (the command) is kept whole and the reason
// gets what is left of BODY_MAX, up to REASON_MAX; too little left, no reason.
function fitBody(lead, reason, tail, fallbackLead) {
  const room = Math.min(REASON_MAX, BODY_MAX - lead.length - tail.length);
  return room >= 20 && reason ? `${lead}${trimTo(reason, room)}${tail}` : `${fallbackLead}${tail}`;
}

function which(bin, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, bin);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}

// The desktop command for this platform, as argv (spawned without a shell), or null.
const APPLESCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)', 'end run'];
// The app a click on the notification brings forward: the one the engine was
// started from. macOS gives every process it launches from an app that app's
// bundle id (__CFBundleIdentifier: Terminal, iTerm, VS Code, Ghostty…);
// AGENTIC_NOTIFY_ACTIVATE overrides it. Only a well-formed bundle id is used.
const TERM_APPS = { Apple_Terminal: 'com.apple.Terminal', 'iTerm.app': 'com.googlecode.iterm2', vscode: 'com.microsoft.VSCode', WezTerm: 'com.github.wez.wezterm', ghostty: 'com.mitchellh.ghostty', WarpTerminal: 'dev.warp.Warp-Stable' };
function activateApp(env = process.env) {
  const id = env.AGENTIC_NOTIFY_ACTIVATE || env.__CFBundleIdentifier || TERM_APPS[env.TERM_PROGRAM] || 'com.apple.Terminal';
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(String(id)) ? String(id) : 'com.apple.Terminal';
}
// macOS: terminal-notifier when installed, so a click brings the terminal
// forward. A notification sent with osascript belongs to Script Editor, and
// clicking it opens Script Editor; that stays the fallback.
function desktopCommand(title, body, { platform = process.platform, find = which, subtitle = '', env = process.env } = {}) {
  if (platform === 'darwin') {
    const notifier = find('terminal-notifier', env);
    if (notifier) return { bin: notifier, args: ['-title', title, '-message', body, ...(subtitle ? ['-subtitle', subtitle] : []), '-group', 'agentic', '-activate', activateApp(env)] };
    return { bin: 'osascript', args: [...APPLESCRIPT.flatMap(line => ['-e', line]), title, body, subtitle || ''] };
  }
  if (platform === 'linux') {
    const bin = find('notify-send');
    // `--` ends the options, so a title or body starting with "-" stays text.
    return bin ? { bin, args: ['--app-name=agentic', '--', title, body] } : null;
  }
  return null;
}

function createNotifier({ env = process.env, platform = process.platform, spawnFn = spawn, find = which } = {}) {
  return {
    desktop(title, body, event = {}) {
      if (env.AI_WORKFLOW_SELFTEST === '1') {
        if (!env.AI_WORKFLOW_TEST_NOTIFY_LOG) return { channel: 'none' };
        fs.appendFileSync(env.AI_WORKFLOW_TEST_NOTIFY_LOG, JSON.stringify({ key: event.key || null, kind: event.kind || null, title, body, ...(event.subtitle ? { subtitle: event.subtitle } : {}) }) + '\n');
        return { channel: 'log' };
      }
      const command = desktopCommand(title, body, { platform, find, env, subtitle: event.subtitle || '' });
      if (!command) return { channel: 'none' };
      try {
        const child = spawnFn(command.bin, command.args, { stdio: 'ignore', shell: false });
        child.on?.('error', () => { /* best effort: a missing notifier never stops a run */ });
        child.unref?.();
      } catch { return { channel: 'none' }; }
      return { channel: path.basename(command.bin) };
    },
  };
}

// ---------------------------------------------------------------- events

// `attention` is progress.js needsYou(); the engine asks it for the whole
// reason (reasonMax: Infinity), so redaction sees every character before any cut.
function attentionEvent(id, attention, env = process.env) {
  const headline = clean(attention.headline, 120, env);
  const command = clean(attention.command, Infinity, env);
  const lead = attention.repeated ? `${headline}. ${clean(attention.label, 40, env)}: ` : `${headline}: `;
  const body = fitBody(lead, clean(attention.reason, Infinity, env), ` — run: ${command}`, headline);
  return { key: attention.key, kind: attention.kind, title: clean(`agentic · ${id} needs you`, TITLE_MAX, env), subtitle: `run: ${command}`, body };
}
// An engine error the state does not record (an unknown condition, a missing
// dependency): still a stop, still worth telling.
function errorEvent(id, stageId, message, state, { cli, env = process.env } = {}) {
  const command = clean(commandFor(stageId === 'pull-request' ? 'resume' : 'retry', id, cli), Infinity, env);
  const label = clean(labelOf(stageId), 40, env);
  const body = fitBody(`${label} stopped: `, clean(message, Infinity, env), ` — run: ${command}`, `${label} stopped`);
  return { key: `${id}|${stageId}|error|${state?.updatedAt || ''}`, kind: 'error', title: clean(`agentic · ${id} needs you`, TITLE_MAX, env), subtitle: `run: ${command}`, body };
}
// The key carries the moment the run completed, so a run that completes again
// after rework is told again; the progress terminal's bell uses the same key.
function completeEvent(id, state, { cli = process.env.AI_AGENTIC_CLI === '1', env = process.env } = {}) {
  const pr = state?.pullRequest;
  const body = pr?.url
    ? `Pull request ${pr.number != null ? `#${pr.number} ` : ''}${pr.url}`
    : state?.phases?.['pull-request']?.status === 'skipped'
      ? `Verification passed. Open the pull request with: ${cli ? `agentic pr ${id}` : `node ai/workflow/engine.js pr ${id}`}`
      : 'Verification passed.';
  return { key: completeKey(id, completedAt(state)), kind: 'complete', title: clean(`agentic · ${id} complete`, TITLE_MAX, env), body: clean(body, BODY_MAX, env) };
}
function prOpenedEvent(id, pr, env = process.env) {
  return { key: `${id}|pull-request|opened|${pr.url}`, kind: 'pr-opened', title: clean(`agentic · ${id} pull request ${pr.reused ? 'found' : 'opened'}`, TITLE_MAX, env), body: clean(`${pr.number != null ? `#${pr.number} ` : ''}${pr.url}`, BODY_MAX, env) };
}

// Records the event's key, then shows it, once. Returns { sent, channel?, reason? }.
function deliver(stateFile, event, { root, env = process.env, notifier, config } = {}) {
  if (!event || !event.key) return { sent: false, reason: 'no event' };
  if (evalMode(env)) return { sent: false, reason: 'eval mode' };
  const settings = config || loadConfig(root || process.cwd());
  warnConfig(settings);
  let fresh = false;
  withStateLock(stateFile, () => {
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return; }
    state.notifications ||= {};
    const sent = Array.isArray(state.notifications.sent) ? state.notifications.sent : [];
    if (sent.includes(event.key)) return;
    state.notifications.sent = [...sent, event.key].slice(-KEEP_SENT);
    writeJsonAtomic(stateFile, state);
    fresh = true;
  });
  if (!fresh) return { sent: false, reason: 'already sent' };
  if (!settings.desktop) return { sent: false, reason: 'notifications.desktop is false' };
  return { sent: true, ...(notifier || createNotifier({ env })).desktop(event.title, event.body, event) };
}

// ---------------------------------------------------------------- selftest

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  try {
    // Config: on by default, off per channel; off/no/on/yes are understood;
    // anything else falls back to the default and is reported.
    assert.deepStrictEqual(loadConfig(path.join(tmp, 'nowhere')), { desktop: true, bell: true, problems: [] });
    fs.mkdirSync(path.join(tmp, '.agentic'));
    const cfg = text => { fs.writeFileSync(path.join(tmp, '.agentic', 'config.yaml'), text); return loadConfig(tmp); };
    assert.deepStrictEqual(cfg('version: 1\n# notifications:\n#   desktop: true\n'), { desktop: true, bell: true, problems: [] }, 'a commented-out block keeps the defaults');
    assert.deepStrictEqual(cfg('notifications:\n  desktop: false\n'), { desktop: false, bell: true, problems: [] });
    assert.deepStrictEqual(cfg('notifications:\n  bell: false\n  desktop: true\n'), { desktop: true, bell: false, problems: [] });
    assert.deepStrictEqual(cfg('notifications:\n  desktop: off\n  bell: no\n'), { desktop: false, bell: false, problems: [] }, 'YAML 1.2 reads off/no as strings; they still mean false');
    assert.deepStrictEqual(cfg('notifications:\n  desktop: "On"\n'), { desktop: true, bell: true, problems: [] });
    assert.deepStrictEqual(cfg('notifications:\n  desktop: maybe\n').problems, ['notifications.desktop must be true or false (got "maybe"); using true']);
    assert.strictEqual(cfg('notifications:\n  desktop: maybe\n').desktop, true);
    assert.deepStrictEqual(cfg('notifications:\n  bell: 0\n').problems, ['notifications.bell must be true or false (got 0); using true']);
    const said = [];
    warnConfig({ problems: ['p1', 'p1', 'p2'] }, message => said.push(message));
    warnConfig({ problems: ['p1'] }, message => said.push(message));
    assert.deepStrictEqual(said, ['⚠ .agentic/config.yaml: p1', '⚠ .agentic/config.yaml: p2'], 'each problem is said once per process');
    assert.deepStrictEqual(cfg('notifications: [1]\n').problems, ['notifications must be a mapping']);

    // macOS: a constant script; the text travels as argv, untouched by AppleScript parsing.
    const nasty = 'He said "hi" \\ then " & do shell script "touch /tmp/pwned" & "\nsecond line';
    const noNotifier = () => null;
    const mac = desktopCommand('agentic · FEAT-1 needs you', clean(nasty), { platform: 'darwin', find: noNotifier });
    assert.strictEqual(mac.bin, 'osascript');
    assert.deepStrictEqual(mac.args.slice(0, 6), ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)', '-e', 'end run']);
    assert.ok(mac.args.slice(0, 6).every(arg => !arg.includes('FEAT-1') && !arg.includes('pwned')), 'no event text inside the script');
    assert.strictEqual(mac.args[6], 'agentic · FEAT-1 needs you');
    assert.strictEqual(mac.args[7], 'He said "hi" \\ then " & do shell script "touch /tmp/pwned" & " second line', 'quotes and backslashes pass verbatim; the newline is flattened');
    assert.strictEqual(mac.args[8], '', 'no subtitle, an empty third item');
    assert.strictEqual(desktopCommand('t', 'b', { platform: 'darwin', find: noNotifier, subtitle: 'run: agentic retry X' }).args[8], 'run: agentic retry X');
    // With terminal-notifier, a click brings forward the app the engine runs in.
    const tn = desktopCommand('agentic · FEAT-1 needs you', '-starts with a dash', { platform: 'darwin', find: bin => (bin === 'terminal-notifier' ? '/opt/homebrew/bin/terminal-notifier' : null), subtitle: 'run: agentic retry FEAT-1', env: { __CFBundleIdentifier: 'com.microsoft.VSCode' } });
    assert.deepStrictEqual(tn, { bin: '/opt/homebrew/bin/terminal-notifier', args: ['-title', 'agentic · FEAT-1 needs you', '-message', '-starts with a dash', '-subtitle', 'run: agentic retry FEAT-1', '-group', 'agentic', '-activate', 'com.microsoft.VSCode'] });
    assert.strictEqual(activateApp({ TERM_PROGRAM: 'iTerm.app' }), 'com.googlecode.iterm2');
    assert.strictEqual(activateApp({ __CFBundleIdentifier: 'com.apple.Terminal', AGENTIC_NOTIFY_ACTIVATE: 'com.mitchellh.ghostty' }), 'com.mitchellh.ghostty', 'the override wins');
    assert.strictEqual(activateApp({ __CFBundleIdentifier: 'evil"; rm -rf ~' }), 'com.apple.Terminal', 'only a well-formed bundle id');
    assert.strictEqual(activateApp({}), 'com.apple.Terminal');
    assert.ok(!/\x1b|\x07/.test(clean('a \x1b]52;c;ZXZpbA==\x07 b \x1b[1A\x1b[2K c \u009b d')), 'escape sequences and C1 controls are gone');
    assert.ok(!/[\n\r]/.test(clean('a\nb\r\nc\td')), 'no control characters survive');
    // Linux: notify-send when it is on PATH, else nothing.
    assert.deepStrictEqual(desktopCommand('t', '-b', { platform: 'linux', find: () => '/usr/bin/notify-send' }), { bin: '/usr/bin/notify-send', args: ['--app-name=agentic', '--', 't', '-b'] });
    assert.strictEqual(desktopCommand('t', 'b', { platform: 'linux', find: () => null }), null);
    assert.strictEqual(desktopCommand('t', 'b', { platform: 'win32' }), null);
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'notify-send'), '#!/bin/sh\n', { mode: 0o755 });
    assert.strictEqual(which('notify-send', { PATH: bin }), path.join(bin, 'notify-send'));
    assert.strictEqual(which('notify-send', { PATH: path.join(tmp, 'none') }), null);

    // The notifier spawns without a shell; a stub stands in for osascript.
    const calls = [];
    const stubSpawn = (file, args, opts) => { calls.push({ file, args, opts }); return { on() {}, unref() {} }; };
    const live = createNotifier({ env: {}, platform: 'darwin', spawnFn: stubSpawn });
    assert.deepStrictEqual(live.desktop('agentic · X', 'body', { subtitle: 'run: agentic resume X' }), { channel: 'osascript' });
    assert.strictEqual(calls[0].opts.shell, false);
    assert.strictEqual(calls[0].file, 'osascript');
    assert.strictEqual(calls[0].args.at(-1), 'run: agentic resume X', 'the command rides as the subtitle');
    assert.deepStrictEqual(createNotifier({ env: {}, platform: 'linux', spawnFn: stubSpawn, find: () => null }).desktop('t', 'b'), { channel: 'none' }, 'no notify-send, no channel');
    assert.deepStrictEqual(createNotifier({ env: { AI_WORKFLOW_SELFTEST: '1' }, platform: 'darwin', spawnFn: stubSpawn }).desktop('t', 'b'), { channel: 'none' }, 'selftests never pop a real notification');
    assert.strictEqual(calls.length, 1);

    // Secrets never reach the text.
    const env = { GH_TOKEN: 'ghp_supersecretvalue123', PATH: '' };
    const leaky = attentionEvent('FEAT-1', { kind: 'blocked', key: 'k', label: 'Pull Request', headline: 'Pull Request blocked', reason: 'push to https://user:pw@github.com/o/r.git failed with ghp_supersecretvalue123', command: 'agentic resume FEAT-1', repeated: 0 }, env);
    assert.ok(!leaky.body.includes('ghp_supersecretvalue123') && !leaky.body.includes('user:pw'), leaky.body);
    assert.match(leaky.body, /^Pull Request blocked: .* — run: agentic resume FEAT-1$/);
    // Redaction runs on the whole text before any cut: a secret or a URL with
    // credentials that straddles the 160 (body) or 220 (needs-you) character
    // cut leaves no part of itself behind.
    const tokenEnv = { GH_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUV123456', PATH: '' };
    for (const at of [140, 150, 155, 159, 200, 215, 219]) {
      const reason = `${'x'.repeat(at)} push failed ghp_ABCDEFGHIJKLMNOPQRSTUV123456 and https://bob:hunter2pass@github.com/o/r.git`;
      const attention = { kind: 'blocked', key: 'k', label: 'Pull Request', headline: 'Pull Request blocked', reason, command: 'agentic resume F', repeated: 0 };
      for (const body of [attentionEvent('F', attention, tokenEnv).body, errorEvent('F', 'pull-request', reason, {}, { cli: true, env: tokenEnv }).body]) {
        assert.ok(!/ghp_A|hunter|bob:/.test(body), `cut at ${at}: ${body}`);
      }
      // What progress.js needsYou() hands the engine when asked for the whole reason.
      const { needsYou } = require('./progress');
      const viaState = needsYou('F', { phases: { 'pull-request': { status: 'blocked', note: reason, updatedAt: 't' } } }, { cli: true, reasonMax: Infinity });
      assert.strictEqual(viaState.reason, reason.replace(/\s+/g, ' '), 'needsYou can give the whole reason');
      assert.ok(!/ghp_A|hunter|bob:/.test(attentionEvent('F', viaState, tokenEnv).body), `needsYou at ${at}`);
    }
    // Secrets that are not in the five named variables: other *_TOKEN/*_KEY
    // variables, and the shapes build and package tools print.
    const otherEnv = { PATH: '', ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop', BB_PASSWORD: 'hunter2hunter2', MY_SERVICE_TOKEN: 'svc-0123456789abcdef', SHORT_TOKEN: 'abc' };
    const noisy = [
      "Could not GET 'https://repo.example.com/x?token=abc123secret&x=1'",
      'npm ERR! //registry.npmjs.org/:_authToken=npm_ABCDEFGHIJKLMNOPQRSTUVWX',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlX2hlcmU',
      'curl -H "Authorization: token ghs_abcdefghijklmnopqrstuvwxyz0123"',
      'used key AKIAIOSFODNN7EXAMPLE and xoxb-1234567890-abcdefghij',
      'password=hunter2hunter2 api_key: zz9plural --token s3cr3tvalue',
      'env had sk-ant-api03-abcdefghijklmnop and svc-0123456789abcdef',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    ];
    for (const line of noisy) {
      const out = clean(line, Infinity, otherEnv);
      assert.ok(!/abc123secret|npm_ABCD|eyJzdWIi|ghs_abc|AKIAIOSF|xoxb-1234|hunter2|zz9plural|s3cr3tvalue|sk-ant-api03|svc-0123|github_pat_11/.test(out), `${line} → ${out}`);
      assert.ok(out.includes('***'), out);
    }
    assert.strictEqual(clean('tests failed: 3 failing in test/a_test.dart (abc)', Infinity, otherEnv), 'tests failed: 3 failing in test/a_test.dart (abc)', 'ordinary text and short values are left alone');
    // The command is never cut; only the reason is shortened to make room.
    const longReason = `mobile-evidence: ${'Appium execution returned, but evidence validation failed: no screenshots '.repeat(3)}`.slice(0, 200);
    const nonCli = commandFor('retry', 'FEAT-2738-master-refactor', false);
    for (const repeatedCount of [0, 2]) {
      const event = attentionEvent('FEAT-2738-master-refactor', { kind: 'blocked', key: 'k', label: 'Final Verification', headline: repeatedCount ? 'Same failure as last time — this needs a fix outside Final Verification' : 'Final Verification (mobile-evidence) blocked', reason: longReason, command: nonCli, repeated: repeatedCount }, { PATH: '' });
      assert.ok(event.body.endsWith(` — run: ${nonCli}`), event.body);
      assert.ok(event.body.length <= BODY_MAX, `${event.body.length}`);
      assert.match(event.body, /…/, 'the reason was shortened');
      assert.strictEqual(event.subtitle, `run: ${nonCli}`);
    }
    const stopped = errorEvent('FEAT-2738-master-refactor', 'build-test', longReason.repeat(2), {}, { cli: false, env: { PATH: '' } });
    assert.ok(stopped.body.endsWith(` — run: ${nonCli}`), stopped.body);
    assert.ok(stopped.body.length <= BODY_MAX);
    const repeated = attentionEvent('FEAT-1', { kind: 'blocked', key: 'k2', label: 'Final Verification', headline: 'Same failure as last time — this needs a fix outside Final Verification', reason: 'mobile-evidence: no booted emulator', command: 'agentic retry FEAT-1', repeated: 3 });
    assert.match(repeated.body, /^Same failure as last time — this needs a fix outside Final Verification\. Final Verification: mobile-evidence: no booted emulator — run: agentic retry FEAT-1$/);
    assert.strictEqual(completeEvent('FEAT-1', { pullRequest: { number: 12, url: 'https://github.com/o/r/pull/12' } }).body, 'Pull request #12 https://github.com/o/r/pull/12');
    assert.match(completeEvent('FEAT-1', { phases: { 'pull-request': { status: 'skipped' } } }, { cli: true }).body, /agentic pr FEAT-1$/);
    // A run that completes again after rework is a new event.
    const firstDone = completeEvent('FEAT-1', { phases: { verification: { status: 'pass', updatedAt: 't1' }, 'pull-request': { status: 'skipped', updatedAt: 't2' } } }).key;
    const againDone = completeEvent('FEAT-1', { phases: { verification: { status: 'pass', updatedAt: 't3' }, 'pull-request': { status: 'skipped', updatedAt: 't4' } } }).key;
    assert.deepStrictEqual([firstDone, againDone], ['FEAT-1|run|complete|t2', 'FEAT-1|run|complete|t4']);
    assert.strictEqual(completeEvent('FEAT-1', { phases: { verification: { status: 'pass', updatedAt: 't1' } } }).key, 'FEAT-1|run|complete|t1');
    assert.strictEqual(prOpenedEvent('FEAT-1', { number: 3, url: 'https://x/pr/3' }).key, 'FEAT-1|pull-request|opened|https://x/pr/3');

    // Delivery: the key is recorded first, so the same event shows once.
    const stateFile = path.join(tmp, 'runs', 'FEAT-1', 'state.json');
    writeJsonAtomic(stateFile, { id: 'FEAT-1', phases: {}, updatedAt: 'then' });
    const shown = [];
    const stub = { desktop: (title, body, event) => { shown.push({ title, body, key: event.key }); return { channel: 'stub' }; } };
    const on = { desktop: true, bell: true, problems: [] };
    const event = { key: 'FEAT-1|build-test|fail|t1', kind: 'fail', title: 't', body: 'b' };
    assert.deepStrictEqual(deliver(stateFile, event, { config: on, notifier: stub, env: {} }), { sent: true, channel: 'stub' });
    assert.deepStrictEqual(deliver(stateFile, event, { config: on, notifier: stub, env: {} }), { sent: false, reason: 'already sent' });
    assert.strictEqual(shown.length, 1, 'deduped by key');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepStrictEqual(saved.notifications.sent, ['FEAT-1|build-test|fail|t1']);
    assert.strictEqual(saved.updatedAt, 'then', 'recording a notification is not run progress');
    // A new transition of the same stage is a new event.
    assert.strictEqual(deliver(stateFile, { ...event, key: 'FEAT-1|build-test|fail|t2' }, { config: on, notifier: stub, env: {} }).sent, true);
    // Eval mode: nothing recorded, nothing shown.
    assert.deepStrictEqual(deliver(stateFile, { ...event, key: 'eval' }, { config: on, notifier: stub, env: { AI_EVAL: '1' } }), { sent: false, reason: 'eval mode' });
    assert.deepStrictEqual(deliver(stateFile, { ...event, key: 'qc' }, { config: on, notifier: stub, env: { QC_EVAL: '1' } }).reason, 'eval mode');
    // Desktop off: recorded (the event happened) but not shown.
    assert.deepStrictEqual(deliver(stateFile, { ...event, key: 'off' }, { config: { ...on, desktop: false }, notifier: stub, env: {} }), { sent: false, reason: 'notifications.desktop is false' });
    assert.strictEqual(shown.length, 2);
    assert.ok(!JSON.parse(fs.readFileSync(stateFile, 'utf8')).notifications.sent.includes('eval'));
    // The sent list stays bounded.
    for (let i = 0; i < KEEP_SENT + 5; i++) deliver(stateFile, { ...event, key: `bulk-${i}` }, { config: { ...on, desktop: false }, env: {} });
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).notifications.sent.length, KEEP_SENT);
    // The selftest log channel, used by the engine-level tests.
    const log = path.join(tmp, 'notify.log');
    const logged = createNotifier({ env: { AI_WORKFLOW_SELFTEST: '1', AI_WORKFLOW_TEST_NOTIFY_LOG: log } }).desktop('t', 'b', { key: 'k', kind: 'fail' });
    assert.deepStrictEqual(logged, { channel: 'log' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(log, 'utf8')), { key: 'k', kind: 'fail', title: 't', body: 'b' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('notify selftest OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else { console.error('usage: notify.js --selftest'); process.exitCode = 1; }
}

module.exports = { DEFAULTS, BODY_MAX, loadConfig, warnConfig, redactSecrets, clean, which, activateApp, desktopCommand, createNotifier, attentionEvent, errorEvent, completeEvent, prOpenedEvent, deliver };
