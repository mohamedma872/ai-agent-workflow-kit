'use strict';
/*
 * Eval adapter for the <name> task — how the generic runner and grader in
 * ai/evals/ talk to it. Fill the ADAPT blocks; everything else (isolation,
 * mutations, timeouts, ledger, metrics, agent selection) is generic.
 *
 *   execute(c, runDir, opts, ctx)  run ONE trial for case `c`; leave gradable artifacts in runDir
 *   collect(runDir, c)             read what a run left behind (null if nothing usable)
 *   matches(output, expected)      does one output satisfy one expected item
 *   replayDir(c)                   (optional) where "replay" cases find existing artifacts
 *   preflight(opts)                (optional) throw if the environment is not ready
 *   agents                         (optional) which agents from ai/agents.yaml this task supports
 *
 * opts.agent is the entry from ai/agents.yaml chosen with --agent:
 *   { name, command: [argv with {prompt} {budget} {cwd} {last_message_file}], result, cost, duration }
 * Look at ai/tasks/coding/adapter.js for a complete agent-neutral example.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function readJSON(f) { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } }
function fill(t, vars) { return String(t).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)); }

module.exports = {
  name: '<name>',
  description: '<one line>',
  entry: '<ai/agents.yaml → any | node scripts/<name>/run.js | POST /api/…>',
  // resultsDir: '<dir>',                        // default: ai/evals/results/<name>
  // agents: ['claude', 'codex'],                // omit = any
  defaults: { agent: 'claude', budget: 5, timeoutMin: 30, permissionMode: 'bypassPermissions' },

  // ADAPT 1 — run the real entry point and leave artifacts in runDir.
  // Return meta: { timed_out, exit_status, command, ...anything worth keeping }.
  execute(c, runDir, opts) {
    // Example A — the chosen agent CLI, headless (same prompt for every agent):
    const lastMessageFile = path.join(runDir, 'last-message.txt');
    const argv = opts.agent.command.map(a => fill(a, { prompt: c.prompt || c.target, budget: opts.budget, cwd: ROOT, last_message_file: lastMessageFile }));
    const meta = { agent: opts.agent.name, command: argv.join(' ') };
    if (opts.dryRun) {return meta;}
    const res = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, env: { ...process.env, AI_EVAL: '1' }, encoding: 'utf8', timeout: opts.timeoutMin * 60 * 1000, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(path.join(runDir, 'agent-stderr.log'), res.stderr || '');
    fs.writeFileSync(path.join(runDir, 'agent-stdout.txt'), res.stdout || '');
    // ADAPT: capture the END STATE your task cares about into runDir/output.json:
    //   { items: [{ text, kind? }], done: true, verdict: 'PASS'|'FAIL'|…, cost_usd?, duration_min? }
    meta.timed_out = !!(res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGTERM';
    meta.exit_status = res.status;
    return meta;

    // Example B — an API feature: call your module, write output.json yourself:
    //   const out = await require('../../../src/ai/classify').run(c.target);
    //   fs.writeFileSync(path.join(runDir, 'output.json'), JSON.stringify({ items: out.labels.map(l => ({ text: l })), done: true, verdict: out.risk, cost_usd: out.usage.cost }));
  },

  // ADAPT 2 — what did the run leave behind?
  //   outputs:  the items you grade, as [{ text, kind?, ... }]
  //   complete: did the run reach its end (false → "incomplete", never a failure)
  //   verdict:  the run's own headline (PASS/FAIL, a label, a number) or null
  //   cost_usd / duration_min / models: from the harness or the agent's JSON — never estimated
  collect(runDir) {
    const out = readJSON(path.join(runDir, 'output.json'));
    if (!out) {return null;}
    return { outputs: out.items || [], complete: !!out.done, verdict: out.verdict ?? null, cost_usd: out.cost_usd ?? null, duration_min: out.duration_min ?? null, models: out.models || [] };
  },

  // ADAPT 3 — does one output satisfy one expected item?
  // Default: every keyword of ANY group appears in the text, case-insensitive;
  // `in:` on the expected item restricts to outputs of that kind.
  matches(output, expected) {
    if (expected.in && output.kind !== expected.in) {return false;}
    const t = String(output.text || '').toLowerCase();
    return (expected.match || []).some(g => g.every(k => t.includes(String(k).toLowerCase())));
  },
};
