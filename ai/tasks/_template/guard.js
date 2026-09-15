'use strict';
// <name> — OPTIONAL. Only for checks that must read run state or compute
// something (a gate that reads a status file, a budget that reads a cost
// file). Everything declarative goes in guard.yaml next to this file; keep
// the VALUES these checks use in that YAML too so they stay readable.
//
//   payload: { tool_name, tool_input, cwd, session_id, transcript_path, ... }
//   ctx:     { root, rel(path), isSecretPath(p), isGuardedPath(p), secretValues, packs }
//   deny(reason) blocks the call; ask(reason) prompts the user.
//   Reasons must never contain the secret itself.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function myYaml() { try { return require('js-yaml').load(fs.readFileSync(path.join(__dirname, 'guard.yaml'), 'utf8')) || {}; } catch { return {}; } }

module.exports = {
  // exact secret values that must never appear in outgoing content (read, never print)
  secrets() {
    const cfg = myYaml().secrets;
    if (!cfg || !cfg.file) {return [];}
    const data = readJSON(path.join(ROOT, cfg.file)) || {};
    return (cfg.fields || []).map(f => data[f]).filter(v => typeof v === 'string' && v.length >= 6);
  },

  rules(payload, ctx, { deny, ask }) {
    const cfg = myYaml();
    const tool = payload.tool_name || '';
    const input = payload.tool_input || {};

    // (a) publish gate: an outward write only after a recorded state says it is ready
    // if (cfg.publish_gate && /^mcp__linear[\w-]*__create_issue$/.test(tool)) {
    //   const state = readJSON(path.join(ROOT, cfg.publish_gate.requires_state_file));
    //   if (!state || state[cfg.publish_gate.requires_field] !== cfg.publish_gate.requires_value) {deny('publish gate: not ready');}
    // }

    // (b) per-run budget: ask once the run's own cost passes the cap
    // if (cfg.run_budget && tool === 'Bash' && (cfg.run_budget.trigger_commands || []).some(c => String(input.command || '').includes(c))) {
    //   const cost = readJSON(path.join(ROOT, '<name>-runs', 'cost.json'));
    //   const cap = Number(process.env.<NAME>_BUDGET_USD) || cfg.run_budget.usd;
    //   if (cost && cost.usd > cap) {ask(`run budget: $${cost.usd.toFixed(2)} of $${cap} spent — continue?`);}
    // }

    void tool; void input; void ctx; void deny; void ask; void cfg;
  },
};
