#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { _test } = require('./guard');

const denied = [
  'sed -i "s/a/b/" src/app.js',
  'echo hello > src/out.txt',
  'echo hello >> README.md',
  'tee src/config.json < /tmp/config.json',
  'cp /tmp/file src/file',
  'mv /tmp/file app/file',
  'touch lib/new.js',
  'rm src/old.js',
  'mkdir src/generated',
  'install /tmp/generated src/generated',
  'dd if=/tmp/generated of=src/generated.bin',
  'patch src/app.js < /tmp/change.patch',
  'python3 -c "open(\'src/x.txt\', \'w\').write(\'x\')"',
  'python -c "from pathlib import Path; Path(\'src/x\').write_text(\'x\')"',
  'python3 -c "import shutil; shutil.copy(\'/tmp/x\', \'src/x\')"',
  'node -e "require(\'fs\').writeFileSync(\'src/x\',\'x\')"',
  'node -e "require(\'fs\').appendFileSync(\'src/x\',\'x\')"',
  'node -e "require(\'fs\').copyFileSync(\'/tmp/x\',\'src/x\')"',
  'node -e "require(\'fs\').renameSync(\'src/a\',\'src/b\')"',
  'node -e "require(\'fs\').unlinkSync(\'src/x\')"',
  'ruby -e "File.write(\'src/x\', \'x\')"',
  'ruby -e "IO.write(\'src/x\', \'x\')"',
  'perl -pi -e "s/a/b/" app/file',
];
for (const cmd of denied) {
  assert.ok(_test.shellMutationProblem(cmd), `expected deny: ${cmd}`);
}

const allowed = [
  'cat src/app.js',
  'grep -R "thing" src',
  'git status --short',
  'git diff -- src/app.js',
  'node ai/tasks/feature/runs.js status',
  'mkdir -p ai/runs/HM-1/05-analysis',
  'echo hello > ai/runs/HM-1/note.md',
  'tee ai/runs/HM-1/06-plan.md < /tmp/plan.md',
];
for (const cmd of allowed) {
  assert.strictEqual(_test.shellMutationProblem(cmd), null, `expected allow: ${cmd}`);
}

assert.strictEqual(_test.isRunScopedWrite('echo x > ai/runs/HM-1/a.md'), true);
assert.strictEqual(_test.isRunScopedWrite('cp src/a ai/runs/HM-1/a'), false);

// The gate follows the agent's own run, not whichever run is active: two runs
// at once, the active one unapproved, must not block the approved run's roles.
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-runs-'));
  try {
    fs.mkdirSync(path.join(runs, 'RUN-APPROVED'));
    fs.writeFileSync(path.join(runs, 'RUN-APPROVED', 'plan.approved'), 'ok\n');
    fs.mkdirSync(path.join(runs, 'RUN-OTHER'));
    fs.writeFileSync(path.join(runs, '_active'), 'RUN-OTHER\n');
    assert.strictEqual(_test.gatedRun({ FEATURE_RUN_ID: 'RUN-APPROVED' }, runs), 'RUN-APPROVED', 'an engine role is gated by its own run');
    assert.strictEqual(_test.gateOpen(_test.gatedRun({ FEATURE_RUN_ID: 'RUN-APPROVED' }, runs), runs), true, 'whose approved plan opens the gate');
    assert.strictEqual(_test.gatedRun({}, runs), 'RUN-OTHER', 'an interactive session is gated by the active run');
    assert.strictEqual(_test.gateOpen('RUN-OTHER', runs), false);
    assert.strictEqual(_test.gatedRun({ FEATURE_RUN_ID: 'RUN-OTHER' }, runs), 'RUN-OTHER', 'an unapproved own run stays gated even when another is approved');
    assert.strictEqual(_test.gatedRun({ FEATURE_RUN_ID: 'NO-SUCH-RUN' }, runs), 'RUN-OTHER', 'an unknown run id falls back to the active run');
    assert.strictEqual(_test.gatedRun({ FEATURE_RUN_ID: '../RUN-APPROVED' }, runs), 'RUN-OTHER', 'a path is not a run id');
  } finally { fs.rmSync(runs, { recursive: true, force: true }); }
}

console.log(`feature guard shell-write selftest OK (${denied.length} denied bypass patterns, ${allowed.length} allowed read/run-scoped patterns)`);
