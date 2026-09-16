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

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`gh CLI is unavailable: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `gh ${args.join(' ')} failed with exit ${result.status}`);
  }
  return (result.stdout || '').trim();
}

function parseArgs(argv) {
  const args = { run: null, pr: null, repo: null, dryRun: false, demo: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') args.run = argv[++i];
    else if (arg === '--pr') args.pr = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--demo') args.demo = true;
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
  return `${MARKER}\n${renderMarkdown(summary)}\n\n> This comment is updated by \`npm run workflow:progress:github\`. It publishes status only — no run artifacts, prompts, notes, or secrets.`;
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const id = args.demo ? 'DEMO-123' : (args.run || activeId());
  if (!id) {
    console.error('No active /feature run. Use --run <id> or start a run first.');
    process.exit(1);
  }
  const state = args.demo ? demoState() : loadState(id);
  if (!state) {
    console.error(`No state.json found for run ${id}`);
    process.exit(1);
  }

  const summary = buildSummary(id, state, { demo: args.demo });
  const body = commentBody(summary);

  if (args.dryRun) {
    console.log(body);
    return;
  }

  let repo;
  let pr;
  try {
    repo = resolveRepo(args.repo);
    pr = resolvePr(args.pr);
    const result = syncComment(repo, pr, body);
    console.log(`${result.action} workflow progress comment on ${repo}#${pr} (${result.commentId})`);
  } catch (error) {
    console.error(`GitHub progress sync failed: ${error.message}`);
    console.error('Requirements: GitHub CLI (`gh`) installed and authenticated, and a PR available for the current branch (or pass --pr <number>).');
    process.exit(1);
  }
}

module.exports = { MARKER, commentBody, syncComment };

if (require.main === module) main();
