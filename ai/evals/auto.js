#!/usr/bin/env node
'use strict';
/*
 * ai/evals/auto.js — the exam on autopilot (nothing here changes the fence).
 *
 *   node ai/evals/auto.js check                     free health gate: engine --check + --selftest, oracle + null
 *                                                   self-check of every case of every task (seconds, $0)
 *   node ai/evals/auto.js live [options]            the live exam: clean git worktree OFF iCloud, cases × agents,
 *                                                   cost + time cap, report in ai/evals/results/nightly/, notification
 *   node ai/evals/auto.js nightly [options]         check, then live (live is skipped when check fails) — the scheduled job
 *   node ai/evals/auto.js schedule install [--at 02:30] [--weekday 0-6] [--label X] [live options]
 *   node ai/evals/auto.js schedule status | run-now | uninstall [--label X]
 *   node ai/evals/auto.js report                    print the latest report
 *
 * live options
 *   --tasks coding[,feature]      tasks to run (default: coding — feature costs ~$10/case, add it weekly)
 *   --agents claude[,codex]       agents (default: every agent in ai/agents.yaml that is on PATH)
 *   --cases a,b                   only these cases
 *   --reps N                      repetitions per case (default 1)
 *   --budget USD                  per-trial budget passed to run.js (default: the task's own)
 *   --cap USD                     stop launching trials once this much was spent in this run (default 10)
 *   --max-minutes M               stop launching trials after M minutes (default 120)
 *   --worktree DIR                the eval checkout (default ~/.ai-evals/<repo>/worktree — never on iCloud)
 *   --branch NAME                 its branch, reset to the main checkout's HEAD every run (default ai-evals)
 *   --dry-run                     prepare the worktree and print the exact commands, run nothing
 *
 * Why a worktree: run.js refuses a dirty tree and trials edit + restore files in place. The main checkout is
 * usually dirty and sits on iCloud (git can hang there), so the exam runs in its own checkout, with the
 * gitignored kit (ai/, .claude, AGENTS.md, CLAUDE.md, .codex, scripts/device-qc — never credentials) copied in and
 * ai/evals/results linked back to the main checkout, so the ledger stays in ONE place.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, listTasks, loadTask, loadAgents, resultsDirFor, readRows, parseArgs } = require('./grade.js');

const HOME = os.homedir();
const REPO = path.basename(ROOT);                                   // names the eval checkout and the launchd job
const AUTO = path.join(ROOT, 'ai', 'evals', 'auto.js');
const NIGHTLY = path.join(ROOT, 'ai', 'evals', 'results', 'nightly');
const RESULTS = path.join(ROOT, 'ai', 'evals', 'results');
const DEFAULTS = {
  tasks: 'coding', reps: 1, cap: 10, maxMinutes: 120,
  worktree: path.join(HOME, '.ai-evals', REPO, 'worktree'), branch: 'ai-evals',
  at: '02:30', label: `com.ai-evals.${REPO}`,
};
const GIT_TIMEOUT_MS = 120 * 1000;
const KIT = ['ai', '.claude', 'AGENTS.md', 'CLAUDE.md', '.codex', 'scripts/device-qc'];
const KIT_SKIP = [ // never copied into the eval checkout
  /^ai\/evals\/results(\/|$)/, /^ai\/runs(\/|$)/, /^scripts\/qc\/env\.js$/, /^\.claude\/settings\.local\.json$/,
  /^CLAUDE\.local\.md$/, /^\.mcp\.json$/, /^device-qc-reports(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.DS_Store$/,
];

// ---------------------------------------------------------------- helpers

function sh(cmd, args, o = {}) {
  const timeout = o.timeout || GIT_TIMEOUT_MS;
  const res = spawnSync(cmd, args, {
    cwd: o.cwd || ROOT, env: o.env || process.env, encoding: 'utf8', timeout,
    maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error && res.error.code === 'ETIMEDOUT') {
    throw new Error(`"${cmd} ${args.slice(0, 3).join(' ')}" hung for ${Math.round(timeout / 1000)}s${cmd === 'git' ? ' — iCloud may have evicted .git objects (see ai/README.md · icloud)' : ''}`);
  }
  if (res.error) {throw new Error(`"${cmd}" could not start: ${res.error.message}`);}
  return res;
}
function git(cwd, ...args) {
  const r = sh('git', args, { cwd });
  if (r.status !== 0) {throw new Error(`git ${args.join(' ')} (in ${cwd}) failed: ${(r.stderr || r.stdout || '').trim()}`);}
  return (r.stdout || '').trim();
}
function which(bin) { const r = sh('which', [bin]); return r.status === 0 ? (r.stdout || '').trim() : null; }
const pad = n => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; }
const money = v => (typeof v === 'number' ? `$${v.toFixed(2)}` : '–');
const mins = v => (typeof v === 'number' ? `${v.toFixed(1)}` : '–');
function isSymlink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function logger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  const log = (msg = '') => { console.log(msg); lines.push(msg); fs.appendFileSync(file, msg + '\n'); };
  log.lines = lines;
  log.file = file;
  return log;
}

function notify(title, message) {
  if (process.platform !== 'darwin') {return;}
  try { spawnSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], { timeout: 10000 }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- check (free)

function check() {
  const t0 = Date.now();
  const lines = [];
  let failed = 0;
  const step = (label, args) => {
    const r = sh('node', args, { timeout: 10 * 60 * 1000 });
    const ok = r.status === 0;
    if (!ok) {failed++;}
    const tail = ok ? '' : '\n' + (r.stdout + r.stderr).trim().split('\n').slice(-8).map(l => '      ' + l).join('\n');
    lines.push(`${ok ? '✓' : '✗'} ${label}${tail}`);
    return ok;
  };
  step('fence rule files are valid (engine --check)', ['ai/guard/engine.js', '--check']);
  step('fence behaves as expected (engine --selftest)', ['ai/guard/engine.js', '--selftest']);
  let cases = 0;
  for (const name of listTasks()) {
    let task;
    try { task = loadTask(name); } catch (e) { failed++; lines.push(`✗ ${name}: ${e.message}`); continue; }
    for (const c of task.cases) {
      cases++;
      step(`${name}/${c.case_id} · oracle self-check`, ['ai/evals/grade.js', name, c.case_id, '--oracle', '--no-write']);
      step(`${name}/${c.case_id} · null self-check`, ['ai/evals/grade.js', name, c.case_id, '--null', '--no-write']);
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const verdict = failed ? `✗ ${failed} check(s) FAILED` : '✓ all checks passed';
  const text = `${lines.join('\n')}\n\n${verdict} · ${listTasks().length} tasks · ${cases} cases · ${secs}s`;
  return { ok: failed === 0, failed, cases, text };
}

// ---------------------------------------------------------------- the eval checkout

function copyKit(wt, log) {
  const resultsWt = path.join(wt, 'ai', 'evals', 'results');
  if (isSymlink(resultsWt)) {fs.unlinkSync(resultsWt);}          // never let rmSync near the ledger through the link
  let n = 0;
  for (const rel of KIT) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) {continue;}
    const to = path.join(wt, rel);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: src => !KIT_SKIP.some(re => re.test(path.relative(ROOT, src))) });
    n++;
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.rmSync(resultsWt, { recursive: true, force: true });
  fs.symlinkSync(RESULTS, resultsWt, 'dir');                       // ONE ledger: the main checkout's
  fs.mkdirSync(path.join(wt, 'ai', 'runs'), { recursive: true });
  // node_modules: a REAL directory of links, one per package — a single symlink is a file to git and
  // ".gitignore"'s "node_modules/" (directory pattern) would not cover it; a directory is ignored as usual.
  const nm = path.join(wt, 'node_modules');
  const nmSrc = path.join(ROOT, 'node_modules');
  if (isSymlink(nm)) {fs.unlinkSync(nm);}
  if (!fs.existsSync(nm) && fs.existsSync(nmSrc)) {
    fs.mkdirSync(nm);
    for (const entry of fs.readdirSync(nmSrc)) {fs.symlinkSync(path.join(nmSrc, entry), path.join(nm, entry));}
  }
  if (!fs.existsSync(RESULTS)) {throw new Error('the results ledger disappeared during the kit copy — stop');}
  log(`kit copied into the eval checkout (${n} entries, credential files skipped) · results → ${path.relative(ROOT, RESULTS)} · node_modules linked package by package`);
}

function prepareWorktree(opts, log) {
  const wt = path.resolve(opts.worktree);
  if (wt.startsWith(ROOT + path.sep) || wt === ROOT) {throw new Error('--worktree must be outside the main checkout');}
  const head = git(ROOT, 'rev-parse', 'HEAD');
  git(ROOT, 'worktree', 'prune');
  const registered = git(ROOT, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${wt}`);
  if (!registered) {
    if (fs.existsSync(wt)) {throw new Error(`${wt} exists but is not a worktree of this repo — remove it or pass --worktree DIR`);}
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(ROOT, 'worktree', 'add', '-B', opts.branch, wt, head);
    log(`eval checkout created: ${wt} (branch ${opts.branch})`);
  }
  git(wt, 'checkout', '-q', '-B', opts.branch, head);
  git(wt, 'reset', '-q', '--hard', head);
  git(wt, 'clean', '-qfd');
  copyKit(wt, log);
  const dirty = git(wt, 'status', '--porcelain');
  if (dirty) {throw new Error(`eval checkout not clean after the kit copy — the .gitignore at HEAD must ignore ai/, .claude/, AGENTS.md, CLAUDE.md, .codex/, scripts/device-qc/:\n${dirty}`);}
  log(`eval checkout ready at ${head.slice(0, 8)} (${git(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD')} of the main checkout)`);
  return { wt, head };
}

function resetWorktree(wt, head) {
  fs.rmSync(path.join(wt, 'ai', 'runs', '_active'), { force: true });
  git(wt, 'reset', '-q', '--hard', head);
  git(wt, 'clean', '-qfd');
}

// ---------------------------------------------------------------- the live exam

function rowsSince(task, sinceIso) {
  const dir = resultsDirFor(task);
  const at = r => r.graded_at || r.at || '';
  return [...readRows(path.join(dir, 'results.jsonl')), ...readRows(path.join(dir, 'errors.jsonl'))].filter(r => at(r) >= sinceIso);
}
function passed(row) {
  return row.status === 'graded' && row.verdict_ok !== false && (row.recall === null || row.recall === undefined || row.recall === 1) && !(row.phantoms || []).length;
}
function judge(row) {
  if (!row) {return { icon: '⚠', word: 'no ledger row' };}
  if (row.status === 'error') {return { icon: '⚠', word: `error (${row.error_class || 'nothing gradable'})` };}
  if (row.status === 'incomplete') {return { icon: '⚠', word: 'incomplete' };}
  if (passed(row)) {return { icon: '✓', word: 'PASS' };}
  const why = [];
  if (row.verdict_ok === false) {why.push(`verdict ${row.verdict}`);}
  if (typeof row.recall === 'number' && row.recall < 1) {why.push(`recall ${row.recall}`);}
  if ((row.phantoms || []).length) {why.push(`${row.phantoms.length} phantom(s)`);}
  return { icon: '✗', word: `FAIL (${why.join(', ') || 'see row'})` };
}

function liveOptions(args) {
  return {
    tasks: String(args.tasks || DEFAULTS.tasks), agents: args.agents ? String(args.agents) : null, cases: args.cases ? String(args.cases).split(',') : null,
    reps: Number(args.reps) || DEFAULTS.reps, budget: args.budget ? Number(args.budget) : null,
    cap: args.cap !== undefined ? Number(args.cap) : DEFAULTS.cap, maxMinutes: Number(args['max-minutes']) || DEFAULTS.maxMinutes,
    worktree: String(args.worktree || DEFAULTS.worktree), branch: String(args.branch || DEFAULTS.branch), dryRun: !!args['dry-run'],
  };
}

function live(opts, preface) {
  const start = new Date();
  const startIso = start.toISOString();
  const id = stamp(start);
  fs.mkdirSync(NIGHTLY, { recursive: true });
  const lock = path.join(NIGHTLY, '.lock');
  if (fs.existsSync(lock)) {
    const prev = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (pidAlive(prev.pid)) {throw new Error(`another live run is in progress (pid ${prev.pid}, since ${prev.since}) — ${path.relative(ROOT, lock)}`);}
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: startIso }));
  const log = logger(path.join(NIGHTLY, `${id}.log`));
  const env = { ...process.env, AI_AUTO: '1' };
  delete env.CLAUDECODE; delete env.CLAUDE_PROJECT_DIR;                 // the runner refuses nested Claude sessions

  const agentsYaml = loadAgents();
  const wanted = opts.agents ? opts.agents.split(',') : Object.keys(agentsYaml);
  const missing = wanted.filter(a => !agentsYaml[a] || !which(String(agentsYaml[a].command[0])));
  const available = wanted.filter(a => !missing.includes(a));
  const plan = [];
  for (const t of opts.tasks.split(',').map(s => s.trim()).filter(Boolean)) {
    const task = loadTask(t);
    const agents = available.filter(a => !Array.isArray(task.adapter.agents) || task.adapter.agents.includes(a));
    const cases = task.cases.filter(c => c.kind !== 'replay' && (!opts.cases || opts.cases.includes(c.case_id)));
    for (const a of agents) {for (const c of cases) {plan.push({ task, agent: a, c });}}
  }
  log(`# AI exam · ${id}${opts.dryRun ? ' · DRY RUN' : ''}`);
  log(`tasks ${opts.tasks} · agents ${available.join(', ') || '(none)'}${missing.length ? ` · skipped: ${missing.join(', ')} (not on PATH / unknown)` : ''} · ${plan.length} trial(s) × ${opts.reps} rep(s) · cap ${money(opts.cap)} · max ${opts.maxMinutes} min`);
  if (!plan.length) {throw new Error('nothing to run — check --tasks / --agents / --cases');}

  const results = [];
  let stopped = null;
  let error = null;
  let wtInfo = null;
  try {
    wtInfo = prepareWorktree(opts, log);
    for (const p of plan) {
      const elapsed = (Date.now() - start) / 60000;
      const spent = [...new Set(plan.map(x => x.task))].reduce((s, t) => s + rowsSince(t, startIso).reduce((a, r) => a + (r.cost_usd || 0), 0), 0);
      if (elapsed > opts.maxMinutes) { stopped = `time cap reached (${opts.maxMinutes} min)`; break; }
      if (spent >= opts.cap) { stopped = `cost cap reached (${money(spent)} of ${money(opts.cap)})`; break; }
      resetWorktree(wtInfo.wt, wtInfo.head);
      const args = ['ai/evals/run.js', p.task.name, 'run', '--case', p.c.case_id, '--agent', p.agent, '--reps', String(opts.reps)];
      if (opts.budget) {args.push('--budget', String(opts.budget));}
      if (opts.dryRun) {args.push('--dry-run');}
      const t0 = Date.now();
      const r = sh('node', args, { cwd: wtInfo.wt, env, timeout: (opts.maxMinutes + 10) * 60 * 1000 });
      fs.appendFileSync(log.file, `\n$ (cd ${wtInfo.wt} && node ${args.join(' ')})\n${r.stdout || ''}${r.stderr || ''}\n`);
      if (opts.dryRun) {
        const cmd = (r.stdout || '').split('\n').find(l => /claude|codex/.test(l) && /-p|exec/.test(l)) || (r.stdout || '').trim().split('\n').pop();
        log(`· ${p.task.name}/${p.c.case_id} [${p.agent}] → ${r.status === 0 ? (cmd || '').trim() : 'FAILED: ' + (r.stderr || r.stdout || '').trim().split('\n').pop()}`);
        continue;
      }
      const mine = rowsSince(p.task, new Date(t0).toISOString()).filter(x => x.case_id === p.c.case_id);
      const row = mine[mine.length - 1] || null;
      const j = judge(row);
      results.push({ ...p, row, ok: j.icon === '✓', word: j.word });
      log(`${j.icon} ${p.task.name}/${p.c.case_id} [${p.agent}] ${j.word} · ${money(row && row.cost_usd)} · ${mins(row && (row.duration_min || row.minutes))} min${r.status !== 0 && !row ? ` · run.js exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}` : ''}`);
    }
  } catch (e) {
    error = e.message;
    log(`✗ ${e.message}`);
  } finally {
    try { if (wtInfo) {resetWorktree(wtInfo.wt, wtInfo.head);} } catch (e) { log(`⚠ could not reset the eval checkout: ${e.message}`); }
    fs.rmSync(lock, { force: true });
  }

  // ---- report
  const graded = results.filter(r => r.row && r.row.status === 'graded');
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => r.row && !r.ok && r.row.status === 'graded').length;
  const errs = results.length - pass - fail;
  const cost = results.reduce((s, r) => s + ((r.row && r.row.cost_usd) || 0), 0);
  const wall = (Date.now() - start) / 60000;
  const noise = graded.length ? `±${Math.round(100 / Math.sqrt(graded.length))} points (n=${graded.length})` : 'n/a';
  const headline = opts.dryRun ? 'DRY RUN' : error ? 'ERROR' : fail ? 'FAIL' : errs ? 'INCOMPLETE' : 'PASS';
  const lines = [];
  lines.push(`# AI exam — ${id}${opts.dryRun ? ' (dry run)' : ''}`, '');
  lines.push(`**${headline}** · ${results.length} trial(s) · ${pass} pass · ${fail} fail · ${errs} error/incomplete · ${money(cost)} · ${wall.toFixed(1)} min · noise floor ${noise}`);
  if (stopped) {lines.push('', `stopped early: ${stopped}`);}
  if (error) {lines.push('', `error: ${error}`);}
  if (missing.length) {lines.push('', `agents skipped: ${missing.join(', ')} (not on PATH or not in ai/agents.yaml)`);}
  lines.push('', `main checkout ${wtInfo ? wtInfo.head.slice(0, 8) : '?'} · eval checkout ${opts.worktree} · log ${path.relative(ROOT, log.file)}`);
  if (preface) {lines.push('', '## check (free)', '', '```', preface.trim(), '```');}
  if (results.length) {
    lines.push('', '## trials', '', '| task | case | agent | result | verdict | recall | phantoms | cost | min |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of results) {
      const row = r.row || {};
      lines.push(`| ${r.task.name} | ${r.c.case_id} | ${r.agent} | ${r.ok ? '✓' : '✗'} ${r.word} | ${row.verdict || '–'} | ${row.recall === null || row.recall === undefined ? '–' : row.recall} | ${(row.phantoms || []).length} | ${money(row.cost_usd)} | ${mins(row.duration_min || row.minutes)} |`);
    }
  }
  if (!opts.dryRun) {
    for (const t of [...new Set(plan.map(p => p.task.name))]) {
      const s = sh('node', ['ai/evals/run.js', t, 'summary'], { cwd: ROOT, timeout: 60000 });
      lines.push('', `## all-time summary · ${t}`, '', '```', (s.stdout || s.stderr || '').trim(), '```');
    }
  }
  lines.push('');
  const report = lines.join('\n');
  const file = path.join(NIGHTLY, `${id}.md`);
  fs.writeFileSync(file, report);
  fs.writeFileSync(path.join(NIGHTLY, 'latest.md'), report);
  const oneLine = s => String(s).replace(/\s*\n\s*/g, ' | ');
  if (!opts.dryRun) {fs.appendFileSync(path.join(NIGHTLY, 'history.log'), `${startIso} ${headline} trials=${results.length} pass=${pass} fail=${fail} err=${errs} cost=${cost.toFixed(2)} min=${wall.toFixed(1)}${stopped ? ` stopped="${oneLine(stopped)}"` : ''}${error ? ` error="${oneLine(error)}"` : ''}\n`);}
  log('');
  log(`${headline} · ${pass}/${results.length} pass · ${money(cost)} · ${wall.toFixed(1)} min → ${path.relative(ROOT, file)}`);
  if (!opts.dryRun) {notify(`AI exam · ${REPO}`, `${headline} · ${pass}/${results.length} pass · ${money(cost)} · ${Math.round(wall)} min`);}
  return { headline, pass, fail, errs, error, file };
}

// ---------------------------------------------------------------- schedule (launchd)

function plistXml({ label, args, cwd, env, hour, minute, weekday, out }) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cal = [`      <key>Hour</key><integer>${hour}</integer>`, `      <key>Minute</key><integer>${minute}</integer>`];
  if (weekday !== undefined && weekday !== null) {cal.push(`      <key>Weekday</key><integer>${weekday}</integer>`);}
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`).join('\n')}
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
${cal.join('\n')}
  </dict>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(out)}</string>
  <key>StandardErrorPath</key><string>${esc(out)}</string>
</dict>
</plist>
`;
}

function schedule(sub, args, liveArgs) {
  const label = String(args.label || DEFAULTS.label);
  const plist = path.join(HOME, 'Library', 'LaunchAgents', `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  switch (sub) {
    case 'install': {
      const [hh, mm] = String(args.at || DEFAULTS.at).split(':').map(Number);
      if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) {throw new Error('--at must be HH:MM');}
      const claude = which('claude');
      const codex = which('codex');
      if (!claude) {throw new Error('`claude` is not on PATH — install / log in first');}
      const PATH = [...new Set([path.dirname(process.execPath), path.dirname(claude), codex && path.dirname(codex), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(':');
      const argv = [process.execPath, AUTO, 'nightly', ...liveArgs];
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.mkdirSync(NIGHTLY, { recursive: true });
      sh('launchctl', ['bootout', target]);                       // ignore "not loaded"
      fs.writeFileSync(plist, plistXml({ label, args: argv, cwd: ROOT, env: { PATH, HOME, LANG: 'en_US.UTF-8' }, hour: hh, minute: mm, weekday: args.weekday !== undefined ? Number(args.weekday) : undefined, out: path.join(NIGHTLY, 'launchd.log') }));
      const r = sh('launchctl', ['bootstrap', domain, plist]);
      if (r.status !== 0) {throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout || '').trim()}`);}
      console.log(`installed ${label}`);
      console.log(`  when:    every ${args.weekday !== undefined ? `weekday ${args.weekday}` : 'day'} at ${pad(hh)}:${pad(mm)} (missed while asleep → runs at wake; skipped while powered off)`);
      console.log(`  command: ${argv.join(' ')}`);
      console.log(`  plist:   ${plist}`);
      console.log(`  log:     ${path.relative(ROOT, path.join(NIGHTLY, 'launchd.log'))}`);
      console.log(`  report:  ${path.relative(ROOT, path.join(NIGHTLY, 'latest.md'))}`);
      console.log('  re-run install after a node / claude upgrade so the paths stay current');
      break;
    }
    case 'uninstall': {
      sh('launchctl', ['bootout', target]);
      fs.rmSync(plist, { force: true });
      console.log(`removed ${label}`);
      break;
    }
    case 'run-now': {
      const r = sh('launchctl', ['kickstart', '-k', target]);
      if (r.status !== 0) {throw new Error(`launchctl kickstart failed: ${(r.stderr || r.stdout || '').trim()} — is it installed? (schedule status)`);}
      console.log(`${label} started by launchd — follow ${path.relative(ROOT, path.join(NIGHTLY, 'launchd.log'))}; the report lands in ${path.relative(ROOT, path.join(NIGHTLY, 'latest.md'))}`);
      break;
    }
    case 'status':
    default: {
      const r = sh('launchctl', ['print', target]);
      if (r.status !== 0) { console.log(`${label}: not installed (node ai/evals/auto.js schedule install --at HH:MM)`); break; }
      const grab = re => { const m = (r.stdout || '').match(re); return m ? m[1].trim() : '?'; };
      console.log(`${label}: installed · state ${grab(/state = (.+)/)} · last exit ${grab(/last exit code = (.+)/)} · pid ${grab(/\bpid = (\d+)/)}`);
      if (fs.existsSync(plist)) {
        const x = fs.readFileSync(plist, 'utf8');
        const g = re => { const m = x.match(re); return m ? m[1] : '?'; };
        const weekday = g(/Weekday<\/key><integer>(\d)/);
        const argv = ((x.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/) || [])[1] || '').match(/<string>[^<]*<\/string>/g) || [];
        console.log(`  when:    ${weekday !== '?' ? `weekday ${weekday} ` : 'daily '}at ${pad(g(/Hour<\/key><integer>(\d+)/))}:${pad(g(/Minute<\/key><integer>(\d+)/))}`);
        console.log(`  command: ${argv.map(s => s.slice(8, -9)).join(' ')}`);
      }
      const hist = path.join(NIGHTLY, 'history.log');
      if (fs.existsSync(hist)) {
        const last = fs.readFileSync(hist, 'utf8').trim().split('\n').slice(-3);
        console.log('  recent:'); for (const l of last) {console.log(`    ${l}`);}
      } else {console.log('  recent:  no run yet');}
      break;
    }
  }
}

// ---------------------------------------------------------------- cli

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, sub] = args._;
  // "schedule install --at 02:30 --label X <live options>" → the live options alone go into the job's command line
  const liveArgs = [];
  for (let i = 4; i < process.argv.length; i++) {
    if (['--at', '--weekday', '--label'].includes(process.argv[i])) { i++; continue; }
    liveArgs.push(process.argv[i]);
  }
  try {
    switch (cmd) {
      case 'check': {
        const c = check();
        console.log(c.text);
        process.exit(c.ok ? 0 : 2);
        break;
      }
      case 'live': {
        const r = live(liveOptions(args));
        process.exit(r.error ? 2 : r.fail ? 1 : 0);
        break;
      }
      case 'nightly': {
        const c = check();
        console.log(c.text);
        if (!c.ok) {
          fs.mkdirSync(NIGHTLY, { recursive: true });
          const id = stamp();
          const report = `# AI exam — ${id}\n\n**ERROR** · the free health check failed, the live exam was not started\n\n\`\`\`\n${c.text}\n\`\`\`\n`;
          fs.writeFileSync(path.join(NIGHTLY, `${id}.md`), report);
          fs.writeFileSync(path.join(NIGHTLY, 'latest.md'), report);
          fs.appendFileSync(path.join(NIGHTLY, 'history.log'), `${new Date().toISOString()} ERROR check failed (${c.failed})\n`);
          notify(`AI exam · ${REPO}`, `ERROR · ${c.failed} health check(s) failed · live exam skipped`);
          process.exit(2);
        }
        const r = live(liveOptions(args), c.text);
        process.exit(r.error ? 2 : r.fail ? 1 : 0);
        break;
      }
      case 'schedule':
        schedule(sub || 'status', args, liveArgs);
        break;
      case 'report': {
        const f = path.join(NIGHTLY, 'latest.md');
        console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 'no report yet — node ai/evals/auto.js live');
        break;
      }
      default:
        console.error('usage: auto.js check | live [options] | nightly [options] | schedule install [--at HH:MM] [--weekday N] [--label X] [options] | schedule status|run-now|uninstall | report');
        console.error('options: --tasks coding[,feature] --agents claude[,codex] --cases a,b --reps N --budget USD --cap USD --max-minutes M --worktree DIR --branch NAME --dry-run');
        process.exit(1);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
}

module.exports = { check, live, liveOptions, prepareWorktree, schedule };
