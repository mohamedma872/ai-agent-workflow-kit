#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { stateRoot } = require('./paths');

const RUNS = stateRoot();

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function build(runId) {
  const dir = path.join(RUNS, runId);
  const engine = path.join(dir, 'engine');
  const mode = read(path.join(engine, 'mode.json')) || {};
  const architecture = {
    assessment: read(path.join(dir, '05-architecture-assessment.json')),
    options: read(path.join(dir, '05-architecture-options.json')),
    selection: read(path.join(dir, '05-architecture-selection.json')),
    target: read(path.join(dir, '05-target-architecture.json')),
    c4: read(path.join(dir, '05-c4-model.json')),
    migration: read(path.join(dir, '05-architecture-migration.json')),
    compliance: read(path.join(dir, '09-reviews', 'architecture-compliance-reviewer.json')),
  };
  return {
    schemaVersion: 1,
    runId,
    mode: mode.mode || 'feature',
    refactorScope: mode.refactorScope || null,
    baseline: read(path.join(dir, '04-behavior-baseline.json')) || {},
    equivalence: read(path.join(dir, '10-behavior-equivalence.json')) || {},
    telemetry: read(path.join(engine, 'refactor-telemetry.json')) || {},
    contractDiff: read(path.join(engine, 'refactor-contract-diff.json')) || {},
    checkpoints: read(path.join(engine, 'refactor-checkpoints.json')) || { checkpoints: {} },
    matrix: read(path.join(engine, 'refactor-verification-matrix.json')) || {},
    architecture,
  };
}

function markdown(r) {
  const t = r.telemetry || {};
  const e = r.equivalence || {};
  const lines = [
    '# Refactor verification report',
    '',
    `Run: ${r.runId}`,
    '',
    `Mode: ${r.mode}${r.refactorScope ? ` (${r.refactorScope})` : ''}`,
    '',
    `Behavior verification: **${e.fullyVerified ? 'FULL' : 'PARTIAL'}**`,
    '',
  ];

  if (r.refactorScope === 'whole_app') {
    const a = r.architecture || {};
    lines.push('## Architecture decision', '');
    if (a.selection) {
      lines.push(`- Selected: **${a.selection.selectedOptionId} — ${a.selection.selectedOptionName}**`);
      lines.push(`- Selected by: ${a.selection.selectedBy || 'human'}`);
    } else {
      lines.push('- Selected: not recorded');
    }
    lines.push(`- Architecture compliance: **${a.compliance?.status ? String(a.compliance.status).toUpperCase() : 'NOT VERIFIED'}**`);
    lines.push(`- Target principles: ${a.target?.principles?.length || 0}`);
    lines.push(`- Fitness functions: ${a.target?.fitnessFunctions?.length || 0}`);
    lines.push(`- C4 containers: ${a.c4?.containers?.length || 0}`);
    lines.push(`- Migration waves: ${a.migration?.waves?.length || 0}`, '');

    if (a.options?.recommendation) {
      lines.push('### Agent recommendation vs human choice', '');
      lines.push(`- Agent recommendation: ${a.options.recommendation.optionId}`);
      lines.push(`- Human selection: ${a.selection?.selectedOptionId || 'not selected'}`);
      lines.push('- The human selection is authoritative.', '');
    }

    if ((a.compliance?.findings || []).length) {
      lines.push('### Architecture compliance findings', '');
      for (const finding of a.compliance.findings) {
        lines.push(`- [${finding.severity}] ${finding.summary || finding.id} — resolved=${finding.resolved === true ? 'yes' : 'no'}`);
      }
      lines.push('');
    }
  }

  lines.push(
    '## Coverage', '',
    `- Baseline behaviors: ${t.behaviorCount ?? 0}`,
    `- Covered: ${t.coveredBehaviors ?? 0}`,
    `- Waived: ${t.waivedBehaviors ?? 0}`,
    `- Uncovered: ${t.uncoveredBehaviors ?? 0}`,
    '',
    '## Changes', '',
    `- Intentional behavior changes: ${t.intentionalChanges ?? 0}`,
    `- Unexpected behavior changes: ${t.unexpectedChanges ?? 0}`,
    '',
    '## Incremental verification', '',
    `- Verified increments: ${t.verifiedIncrements ?? 0}`,
    '',
    '## Test layers', ''
  );
  for (const x of t.testLayers || []) lines.push('- ' + x);

  lines.push('', '## Unverified scenarios', '');
  if (!(e.unverifiedScenarios || []).length) lines.push('- None');
  else for (const x of e.unverifiedScenarios) lines.push('- ' + x);

  lines.push('', '## Contract diff', '');
  const changes = r.contractDiff?.changes || {};
  if (!Object.keys(changes).length) lines.push('- No observable contract changes detected');
  else {
    for (const [k, v] of Object.entries(changes)) {
      lines.push(`- ${k}: removed [${(v.removed || []).join(', ')}], added [${(v.added || []).join(', ')}]`);
    }
  }

  if ((r.contractDiff?.violations || []).length) {
    lines.push('', '## Invariant violations', '');
    for (const x of r.contractDiff.violations) lines.push('- ' + x);
  }

  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const runId = args.find(x => !x.startsWith('--'));
  if (!runId) {
    console.error('usage: refactor-report.js <run-id> [--json]');
    process.exitCode = 1;
  } else {
    const report = build(runId);
    process.stdout.write(args.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : markdown(report));
  }
}

module.exports = { build, markdown };
