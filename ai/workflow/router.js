#!/usr/bin/env node
'use strict';

/*
 * ai/workflow/router.js
 *
 * Provider-independent role router for agentic workflows.
 *
 * The workflow owns the stages and roles (ai/workflows/*.yaml).
 * ai/agents.yaml owns how each executor is launched (Claude, Codex, future agents).
 * This router joins the two without putting provider-specific commands in the workflow.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(ROOT, 'ai', 'workflows');
const AGENTS_FILE = path.join(ROOT, 'ai', 'agents.yaml');

function fail(message, code = 1) { console.error(`✗ ${message}`); process.exit(code); }
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}
function safeRunId(id) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id || ''); }
function readYaml(file) { try { return yaml.load(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { throw new Error(`${path.relative(ROOT, file)}: ${e.message}`); } }
function workflowFile(name) { return path.join(WORKFLOWS_DIR, `${name}.yaml`); }
function listWorkflows() {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).map(f => f.replace(/\.ya?ml$/, '')).sort();
}
function loadWorkflow(name) {
  const file = workflowFile(name);
  if (!fs.existsSync(file)) throw new Error(`unknown workflow "${name}" — known: ${listWorkflows().join(', ') || '(none)'}`);
  const data = readYaml(file); data.name = data.name || name; data.roles = data.roles || {}; data.stages = data.stages || [];
  return { file, data };
}
function loadAgents() { if (!fs.existsSync(AGENTS_FILE)) throw new Error('ai/agents.yaml is missing'); return readYaml(AGENTS_FILE); }
function stageFor(workflow, id) { return workflow.stages.find(s => s && s.id === id) || null; }
function roleCandidates(role, override) {
  if (override) return [override];
  const out = []; if (role.executor) out.push(role.executor); for (const x of role.fallback || []) if (!out.includes(x)) out.push(x); return out;
}
function onPath(bin) { return !!bin && spawnSync('which', [String(bin)], { stdio: 'ignore' }).status === 0; }
function resolveRole(workflow, agents, roleName, override) {
  const role = workflow.roles[roleName];
  if (!role) throw new Error(`workflow "${workflow.name}" has no role "${roleName}"`);
  const candidates = roleCandidates(role, override);
  if (!candidates.length) throw new Error(`role "${roleName}" has no executor`);
  const known = candidates.filter(name => agents[name]);
  if (!known.length) throw new Error(`role "${roleName}" references unknown executor(s): ${candidates.join(', ')}`);
  const selected = known.find(name => Array.isArray(agents[name].command) && onPath(agents[name].command[0])) || known[0];
  return { roleName, role, agentName: selected, agent: agents[selected], candidates };
}
function fill(template, vars) { return String(template).replace(/\{(\w+)\}/g, (m, key) => Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m); }
function buildPrompt(workflow, resolved, taskPrompt) {
  const lines = [
    `You are the ${resolved.roleName} role in the "${workflow.name}" agentic workflow.`, '',
    `Role purpose: ${resolved.role.purpose || 'Complete the assigned workflow responsibility.'}`,
    `Mode: ${resolved.role.read_only ? 'READ-ONLY analysis/review. Do not modify product files.' : 'May edit product files only within the approved workflow scope.'}`,
  ];
  if (resolved.role.artifact) lines.push(`Expected workflow artifact: ${resolved.role.artifact}`);
  lines.push('', 'Shared safety contract:', '- Follow AGENTS.md and the repository guardrails.', '- Never weaken or bypass ai/guard.yaml, hooks, workflow gates, or eval rules.', '- Do not commit, push, deploy, publish, or write to external systems unless the workflow explicitly allows it and the guard approves it.', '- Return a concise, evidence-based final result. Do not claim checks you did not run.', '', 'Task context:', taskPrompt.trim());
  return lines.join('\n');
}
function finalAnswer(agent, stdout, lastMessageFile) {
  const spec = agent.result || {}; let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* event stream or plain text */ }
  if (spec.json_field && parsed && typeof parsed[spec.json_field] === 'string') return parsed[spec.json_field];
  if (spec.file && fs.existsSync(lastMessageFile)) return fs.readFileSync(lastMessageFile, 'utf8');
  if (parsed && typeof parsed.result === 'string') return parsed.result;
  return String(stdout || '').trim();
}
function validateWorkflow(name, workflow, agents) {
  const problems = [];
  if (workflow.version !== 1) problems.push(`${name}: version must be 1`);
  if (!workflow.name) problems.push(`${name}: missing name`);
  if (!workflow.orchestrator || !workflow.orchestrator.executor) problems.push(`${name}: orchestrator.executor is required`);
  else if (!agents[workflow.orchestrator.executor]) problems.push(`${name}: unknown orchestrator executor "${workflow.orchestrator.executor}"`);
  const ids = new Set();
  for (const stage of workflow.stages || []) {
    if (!stage || !stage.id) { problems.push(`${name}: every stage needs id`); continue; }
    if (ids.has(stage.id)) problems.push(`${name}: duplicate stage "${stage.id}"`); ids.add(stage.id);
    if (stage.role && !workflow.roles[stage.role]) problems.push(`${name}/${stage.id}: unknown role "${stage.role}"`);
    for (const r of stage.roles || []) if (!workflow.roles[r]) problems.push(`${name}/${stage.id}: unknown role "${r}"`);
  }
  for (const stage of workflow.stages || []) for (const dep of stage.needs || []) if (!ids.has(dep)) problems.push(`${name}/${stage.id}: unknown dependency "${dep}"`);
  for (const [roleName, role] of Object.entries(workflow.roles || {})) {
    const candidates = roleCandidates(role); if (!candidates.length) problems.push(`${name}/${roleName}: no executor`);
    for (const a of candidates) if (!agents[a]) problems.push(`${name}/${roleName}: unknown executor "${a}"`);
  }
  return problems;
}
function printWorkflow(workflow) {
  console.log(`${workflow.name} — ${workflow.description || ''}`); console.log(`orchestrator: ${workflow.orchestrator && workflow.orchestrator.executor || '–'}`); console.log('\nstages:');
  for (const stage of workflow.stages) {
    const who = stage.type === 'human_gate' ? 'human gate' : stage.role ? `${stage.role} → ${(workflow.roles[stage.role] || {}).executor || '–'}` : Array.isArray(stage.roles) ? `${stage.strategy || 'parallel'}: ${stage.roles.map(r => `${r}→${(workflow.roles[r] || {}).executor || '–'}`).join(', ')}` : `orchestrator → ${workflow.orchestrator && workflow.orchestrator.executor || '–'}`;
    console.log(`  ${stage.id.padEnd(21)} ${who}${stage.needs && stage.needs.length ? `  after ${stage.needs.join(', ')}` : ''}`);
  }
}
function execute(workflow, agents, roleName, args) {
  const resolved = resolveRole(workflow, agents, roleName, args.agent || null);
  if (!args['prompt-file']) throw new Error('exec requires --prompt-file FILE');
  if (args.run && !safeRunId(String(args.run))) throw new Error(`invalid --run id "${args.run}"`);
  const runId = args.run || process.env.FEATURE_RUN_ID || null;
  const promptFile = path.resolve(args['prompt-file']);
  if (!fs.existsSync(promptFile)) throw new Error(`prompt file not found: ${promptFile}`);
  const taskPrompt = fs.readFileSync(promptFile, 'utf8');
  const prompt = buildPrompt(workflow, resolved, taskPrompt);
  const cwd = args.cwd ? path.resolve(args.cwd) : ROOT;
  const budget = Number(args.budget) || 20;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-workflow-${workflow.name}-${roleName}-`));
  const lastMessageFile = path.join(tempDir, 'last-message.txt');
  const argv = (resolved.agent.command || []).map(a => fill(a, { prompt, budget, cwd, last_message_file: lastMessageFile }));
  if (process.env.AI_AGENTIC_CLI === '1' && resolved.agentName === 'claude') argv.push('--settings', path.join(ROOT, 'ai', 'cli', 'claude-settings.json'));
  if (!argv.length) throw new Error(`executor "${resolved.agentName}" has no command`);
  const summary = { workflow: workflow.name, role: roleName, executor: resolved.agentName, runId, command: argv.map(a => /\s/.test(a) ? JSON.stringify(a.length > 120 ? `${a.slice(0, 117)}…` : a) : a).join(' ') };
  if (args['dry-run']) { console.log(args.json ? JSON.stringify(summary, null, 2) : `${workflow.name}/${roleName} → ${resolved.agentName}${runId ? ` [run ${runId}]` : ''}\n${summary.command}`); return 0; }
  if (!onPath(argv[0])) throw new Error(`executor "${resolved.agentName}": "${argv[0]}" is not on PATH`);
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: { ...process.env, AI_AGENTIC_WORKFLOW: '1', AI_WORKFLOW: workflow.name, AI_WORKFLOW_ROLE: roleName, ...(runId ? { FEATURE_RUN_ID: String(runId) } : {}) },
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: (Number(args['timeout-min']) || 60) * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const answer = finalAnswer(resolved.agent, res.stdout || '', lastMessageFile);
  if (args['output-file']) { const output = path.resolve(args['output-file']); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, answer.endsWith('\n') ? answer : `${answer}\n`); }
  if (res.stderr) process.stderr.write(res.stderr);
  if (!args['output-file'] || args.print) process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
  if (res.error) throw res.error;
  return typeof res.status === 'number' ? res.status : 1;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2)); const [cmd, workflowName, roleOrStage] = args._; let agents;
  try { agents = loadAgents(); } catch (e) { fail(e.message); }
  try {
    switch (cmd) {
      case 'list': for (const name of listWorkflows()) { const { data } = loadWorkflow(name); console.log(`${name.padEnd(16)} ${(data.stages || []).length} stages · ${Object.keys(data.roles || {}).length} roles · orchestrator ${data.orchestrator && data.orchestrator.executor || '–'}`); } break;
      case 'show': { if (!workflowName) fail('usage: router.js show <workflow> [--json]'); const { data } = loadWorkflow(workflowName); if (args.json) console.log(JSON.stringify(data, null, 2)); else printWorkflow(data); break; }
      case 'resolve': {
        if (!workflowName || !roleOrStage) fail('usage: router.js resolve <workflow> <role|stage> [--agent NAME] [--json]');
        const { data } = loadWorkflow(workflowName); let roleName = roleOrStage; const stage = stageFor(data, roleOrStage);
        if (stage) { if (stage.role) roleName = stage.role; else fail(`stage "${roleOrStage}" is ${stage.type === 'human_gate' ? 'a human gate' : 'owned by the orchestrator or multiple roles'}; resolve a concrete role instead`); }
        const r = resolveRole(data, agents, roleName, args.agent || null); const out = { workflow: data.name, role: roleName, executor: r.agentName, candidates: r.candidates, purpose: r.role.purpose || '', read_only: !!r.role.read_only, artifact: r.role.artifact || null };
        console.log(args.json ? JSON.stringify(out, null, 2) : `${out.workflow}/${out.role} → ${out.executor}${out.candidates.length > 1 ? ` (fallbacks: ${out.candidates.slice(1).join(', ')})` : ''}`); break;
      }
      case 'exec': {
        if (!workflowName || !roleOrStage) fail('usage: router.js exec <workflow> <role|stage> --prompt-file FILE [--run ID] [--agent NAME] [--output-file FILE] [--dry-run]');
        const { data } = loadWorkflow(workflowName); let roleName = roleOrStage; const stage = stageFor(data, roleOrStage);
        if (stage) { if (!stage.role) fail(`stage "${roleOrStage}" cannot be executed as one role; choose one of: ${(stage.roles || []).join(', ') || 'orchestrator/human'}`); roleName = stage.role; }
        process.exitCode = execute(data, agents, roleName, args); break;
      }
      case 'check': {
        const all = []; for (const name of listWorkflows()) { try { const { data } = loadWorkflow(name); all.push(...validateWorkflow(name, data, agents)); } catch (e) { all.push(e.message); } }
        if (all.length) { for (const p of all) console.error(`✗ ${p}`); process.exitCode = 1; } else console.log(`✓ ${listWorkflows().length} workflow(s) valid · executors: ${Object.keys(agents).join(', ')}`); break;
      }
      default: console.error('usage: router.js list | show <workflow> [--json] | resolve <workflow> <role|stage> [--agent NAME] [--json] | exec <workflow> <role|stage> --prompt-file FILE [--run ID] [--agent NAME] [--output-file FILE] [--budget USD] [--timeout-min M] [--cwd DIR] [--dry-run] | check'); process.exitCode = 1;
    }
  } catch (e) { fail(e.message); }
}

module.exports = { listWorkflows, loadWorkflow, loadAgents, resolveRole, validateWorkflow, buildPrompt, safeRunId };
