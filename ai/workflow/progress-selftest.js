#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  PHASES,
  deriveRoleGroupStatus,
  effectiveStatus,
  consistencyIssues,
  currentWork,
  percentComplete,
  buildSummary,
  renderTerminal,
  renderMarkdown,
} = require('./progress');

function staleApprovedState() {
  return {
    status: 'active',
    phases: {
      request: { status: 'pass' },
      requirements: { status: 'pass' },
      'acceptance-criteria': { status: 'pass' },
      'definition-of-done': { status: 'pass' },
      inspection: { status: 'pass' },
      analysis: { status: 'in_progress' },
      plan: { status: 'in_progress' },
      approval: { status: 'pass' },
    },
    roles: {
      analysis: {
        architect: { status: 'pass', executor: 'claude' },
        security: { status: 'pass', executor: 'claude' },
        'qa-plan': { status: 'pass', executor: 'claude' },
      },
    },
  };
}

{
  const state = staleApprovedState();
  assert.strictEqual(deriveRoleGroupStatus(state, 'analysis'), 'pass');
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'pass');
  assert.strictEqual(effectiveStatus(state, 'plan'), 'pass');
  assert.strictEqual(currentWork(state), 'Waiting for Implementation');
  assert.ok(consistencyIssues(state).length >= 2);
  assert.strictEqual(percentComplete(state), Math.round((8 / PHASES.length) * 100), 'eight finished stages');
}

{
  const state = {
    status: 'active',
    phases: { analysis: { status: 'in_progress' } },
    selectedRoles: { analysis: ['architect', 'security'] },
    roles: {
      analysis: {
        architect: { status: 'pass', executor: 'claude' },
        security: { status: 'pending', executor: 'claude' },
      },
    },
  };
  assert.strictEqual(deriveRoleGroupStatus(state, 'analysis'), 'in_progress');
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'in_progress');
  assert.strictEqual(currentWork(state), 'Specialist Analysis');
  // Parallel roles: every running role is named, not just the first.
  state.roles.analysis.architect.status = 'in_progress';
  state.roles.analysis.security.status = 'in_progress';
  assert.strictEqual(currentWork(state), 'Specialist Analysis → architect, security');
  // A sibling that already failed does not turn a running stage red: the
  // stage stays in_progress, and the running role is still named.
  state.roles.analysis.architect.status = 'fail';
  assert.strictEqual(deriveRoleGroupStatus(state, 'analysis'), 'in_progress');
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'in_progress');
  assert.strictEqual(currentWork(state), 'Specialist Analysis → security');
  // Once nothing runs any more, the failure shows.
  state.roles.analysis.security.status = 'pass';
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'fail');
  state.roles.analysis.architect.status = 'blocked';
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'blocked');
}

{
  const state = {
    status: 'active',
    phases: { analysis: { status: 'in_progress' } },
    selectedRoles: { analysis: ['architect', 'security'] },
    roles: {
      analysis: {
        architect: { status: 'pass', executor: 'claude' },
        security: { status: 'pass', executor: 'claude' },
      },
    },
  };
  assert.strictEqual(deriveRoleGroupStatus(state, 'analysis'), 'pass');
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'pass');
  assert.strictEqual(currentWork(state), 'Waiting for Request');
}

{
  const state = {
    status: 'active',
    phases: {
      analysis: { status: 'in_progress' },
      plan: { status: 'in_progress' },
    },
    roles: {
      analysis: {
        security: { status: 'in_progress', executor: 'claude' },
      },
    },
  };
  assert.strictEqual(currentWork(state), 'Implementation Plan');
  assert.ok(consistencyIssues(state).some(message => message.includes('Multiple stored phases')));
}

// The pull-request stage comes after final verification.
{
  const verified = () => ({ status: 'active', phases: Object.fromEntries(PHASES.filter(p => p !== 'pull-request').map(p => [p, { status: 'pass' }])), roles: {} });
  assert.strictEqual(PHASES[PHASES.length - 1], 'pull-request');
  const waiting = verified();
  assert.strictEqual(currentWork(waiting), 'Waiting for Pull Request');
  assert.strictEqual(percentComplete(waiting), Math.round(((PHASES.length - 1) / PHASES.length) * 100));
  assert.strictEqual(buildSummary('FEAT-1', waiting).pullRequestHint, null, 'no hint while the stage is still to run');

  // Skipped (opt-in disabled): complete, with the command that opens it.
  const previous = process.env.AI_AGENTIC_CLI;
  process.env.AI_AGENTIC_CLI = '1';
  const skipped = verified();
  skipped.phases['pull-request'] = { status: 'skipped', note: 'pull_request.enabled is not true' };
  assert.strictEqual(percentComplete(skipped), 100);
  assert.strictEqual(currentWork(skipped), 'Done');
  const skippedSummary = buildSummary('FEAT-1', skipped);
  assert.strictEqual(skippedSummary.pullRequestHint, 'agentic pr FEAT-1');
  assert.match(renderTerminal(skippedSummary), /Pull request: not opened — run: agentic pr FEAT-1/);
  assert.match(renderMarkdown(skippedSummary), /\*\*Pull request:\*\* not opened — run `agentic pr FEAT-1`/);
  if (previous === undefined) delete process.env.AI_AGENTIC_CLI; else process.env.AI_AGENTIC_CLI = previous;

  // Blocked: named as the current stop.
  const blocked = verified();
  blocked.phases['pull-request'] = { status: 'blocked', note: 'missing credentials' };
  assert.strictEqual(currentWork(blocked), 'Pull Request (blocked)');

  // Opened: the number and URL near the top, whitelisted fields only.
  const opened = verified();
  opened.phases['pull-request'] = { status: 'pass' };
  opened.pullRequest = { provider: 'bitbucket', number: 7762, url: 'https://bitbucket.org/ws/app/pull-requests/7762', status: 'open', branch: 'ai/FEAT-1', base: 'master', draft: false, commit: 'abc', preCommitSha: 'def', reason: 'internal' };
  const summary = buildSummary('FEAT-1', opened);
  assert.deepStrictEqual(Object.keys(summary.pullRequest).sort(), ['base', 'branch', 'draft', 'number', 'provider', 'status', 'url']);
  const terminal = renderTerminal(summary).split('\n');
  const prRow = terminal.findIndex(line => line.includes('Pull request: #7762 https://bitbucket.org/ws/app/pull-requests/7762'));
  assert.ok(prRow > 0 && prRow < terminal.findIndex(line => line.includes('Request ')), 'the PR line sits above the stage list');
  assert.match(renderMarkdown(summary), /\*\*Pull request:\*\* \[#7762\]\(https:\/\/bitbucket\.org\/ws\/app\/pull-requests\/7762\)/);

  // A run closed before the stage existed is finished, not stuck at 93%.
  const closed = verified();
  closed.status = 'done';
  assert.strictEqual(effectiveStatus(closed, 'pull-request'), 'skipped');
  assert.strictEqual(percentComplete(closed), 100);
  // It shows no "agentic pr" hint (its PR may have been opened by hand), and no
  // "(stored: pending)" next to a status the view derived itself.
  const closedSummary = buildSummary('FEAT-OLD', closed);
  assert.strictEqual(closedSummary.pullRequestHint, null, 'no hint for a run closed before the stage existed');
  assert.strictEqual(closedSummary.phases.find(p => p.id === 'pull-request').rawStatus, undefined);
  assert.ok(!/stored: pending/.test(renderTerminal(closedSummary)), renderTerminal(closedSummary));
  assert.ok(!/Pull request: not opened/.test(renderTerminal(closedSummary)));

  // An abandoned run never reached the stage: it is not counted as done.
  const abandoned = { status: 'done', abandoned: true, roles: {}, phases: Object.fromEntries(PHASES.slice(0, 6).map(p => [p, { status: 'pass' }])) };
  const before = { ...abandoned, status: 'active', abandoned: undefined };
  assert.strictEqual(effectiveStatus(abandoned, 'pull-request'), 'pending');
  assert.strictEqual(percentComplete(abandoned), Math.round((6 / (PHASES.length - 1)) * 100), 'the stage it never reached is left out of the percent');
  assert.ok(percentComplete(abandoned) < 100 && percentComplete(abandoned) >= percentComplete(before));
  assert.strictEqual(buildSummary('FEAT-GAVEUP', abandoned).pullRequestHint, null);
  // A closed run that has the stage gets the hint with --reopen.
  const closedSkipped = verified();
  closedSkipped.status = 'done';
  closedSkipped.phases['pull-request'] = { status: 'skipped', note: 'pull_request.enabled is not true' };
  assert.match(buildSummary('FEAT-2', closedSkipped).pullRequestHint, / pr FEAT-2 --reopen$/);
}

console.log('progress-selftest OK');
