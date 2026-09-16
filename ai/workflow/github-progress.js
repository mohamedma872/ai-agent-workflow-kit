#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const {
  activeId,
  loadState,
  demoState,
  buildSummary,
  renderMarkdown,
} = require('./progress');

const MARKER = '<!-- ai-agent-workflow-progress -->';

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw new Error(`gh CLI is unavailable: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `gh ${args.join(' ')} failed with exit ${result.status}`);
  }
  return (result.stdout || '').trim();
}

function parseArgs(argv) {
  const args = { run: null, pr: null, repo: null, dryRun: false, demo: false, watch: false, interval: 5000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') args.run = argv[++i];
    else if (arg === '--pr') args.pr = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--demo') args.demo = true;
    else if (arg === '--watch') args.watch = true;
    else if (arg === '--interval') args.interval = Math.max(2000, Number(argv[++i]) || 5000);
  }
  return args;
}

function resolveRepo(explicit) {
  if (explicit) return explicit;
  return runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
}

function resolvePr(explicit) {
  if (explicit) return String(explicit);
  return runGh(['pr', 'view', '--json', 'number', '--jq', '.number']);
}

function commentBody(summary) {
  return `${MARKER}\n${renderMarkdown(summary)}\n\n> Safe status summary only. Local run artifacts, prompts, notes, and secrets are not published.`;
}

function findExistingComment(repo, pr) {
  const output = runGh([
    'api',
    `repos/${repo}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    `.[] | select(.body | contains("${MARKER}")) | .id`,
  ]);
  return output.split(/\s+/).filter(Boolean)[0] || null;
}

function syncComment(repo, pr, body) {
  const existing = findExistingComment(repo, pr);
  if (existing) {
    runGh(['api', `repos/${repo}/issues/comments/${existing}`, '-X', 'PATCH', '-f', `body=${body}`]);
    return { action: 'updated', commentId: existing };
  }
  const id = runGh([
    'api',
    `repos/${repo}/issues/${pr}/comments`,
    '-X',
    'POST',
    '-f',
    `body=${body}`,
    '--jq',
    '.id',
  ]);
  return { action: 'created', commentId: id };
}

function stateFor(args) {
  const id = args.demo ? 'DEMO-123' : (args.run || activeId());
  if (!id) throw new Error('No active /feature run. Use --run <id> or start a run first.');
  const state = args.demo ? demoState() : loadState(id);
  if (!state) throw new Error(`No state.json found for run ${id}`);
  return { id, state };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let repo;
  let pr;

  const publishOnce = previousBody => {
    const { id, state } = stateFor(args);
    const summary = buildSummary(id, state, { demo: args.demo });
    const body = commentBody(summary);

    if (args.dryRun) {
      if (body !== previousBody) console.log(body);
      return body;
    }

    if (body === previousBody) return previousBody;
    repo ||= resolveRepo(args.repo);
    pr ||= resolvePr(args.pr);
    const result = syncComment(repo, pr, body);
    console.log(`${result.action} workflow progress comment on ${repo}#${pr} (${result.commentId})`);
    return body;
  };

  try {
    let previousBody = publishOnce(null);
    if (!args.watch) return;

    console.log(`watching workflow state every ${args.interval}ms — Ctrl+C to stop`);
    const timer = setInterval(() => {
      try {
        previousBody = publishOnce(previousBody);
      } catch (error) {
        console.error(`GitHub progress sync failed: ${error.message}`);
      }
    }, args.interval);

    const stop = () => { clearInterval(timer); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(`GitHub progress sync failed: ${error.message}`);
    console.error('Requirements for publishing: GitHub CLI (`gh`) installed and authenticated, and a PR for the current branch (or pass --pr <number>).');
    process.exit(1);
  }
}

module.exports = { MARKER, commentBody, syncComment };

if (require.main === module) main();
