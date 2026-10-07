#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateRoot } = require('./paths');

const GROUPS = [
  { id: 'feature-boundaries', title: 'Feature Boundaries & Dependency Management' },
  { id: 'domain-business', title: 'Domain & Business Rules' },
  { id: 'data-state', title: 'Data & State Management' },
  { id: 'concurrency-sync', title: 'Concurrency & Synchronization' },
  { id: 'api-errors', title: 'API & Error Handling' },
  { id: 'navigation', title: 'Navigation' },
  { id: 'security-privacy', title: 'Security & Privacy' },
  { id: 'observability', title: 'Observability' },
  { id: 'performance-scalability', title: 'Performance & Scalability' },
  { id: 'testing-quality', title: 'Testing & Quality' },
  { id: 'architecture-enforcement', title: 'Architecture Enforcement' },
  { id: 'maintainability', title: 'Maintainability' },
  { id: 'ecommerce', title: 'E-Commerce Architecture' },
];

const GROUP_BY_ID = new Map(GROUPS.map(x => [x.id, x]));
const SEVERITY_ORDER = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const PRIORITY_ORDER = { P0: 3, P1: 2, P2: 1 };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listJson(dir, excluded = new Set()) {
  try {
    return fs.readdirSync(dir)
      .filter(x => x.endsWith('.json') && !excluded.has(x))
      .sort()
      .map(file => ({ file, data: readJson(path.join(dir, file)) }))
      .filter(x => x.data);
  } catch { return []; }
}

function normalizeGroup(value) {
  const v = String(value || '').trim().toLowerCase();
  if (GROUP_BY_ID.has(v)) return v;
  const exact = GROUPS.find(x => x.title.toLowerCase() === v);
  return exact ? exact.id : null;
}

function inferGroup(finding, owner) {
  const explicit = normalizeGroup(finding.group);
  if (explicit) return explicit;

  const hay = [
    finding.title,
    finding.summary,
    finding.recommendation,
    finding.why,
    finding.impact,
    finding.principle,
    ...(finding.tags || []),
    owner,
  ].filter(Boolean).join(' ').toLowerCase();

  const rules = [
    ['security-privacy', /security|privacy|auth|token|secret|credential|pii|encrypt|permission|webview|tls|certificate/],
    ['performance-scalability', /performance|latency|startup|render|rebuild|memory|cpu|network calls?|scalab|throughput|bundle/],
    ['testing-quality', /\btest|coverage|e2e|integration|widget test|contract test|regression|qa\b/],
    ['navigation', /navigation|router|route|deep link|deeplink|back stack|guard/],
    ['concurrency-sync', /concurr|race|debounce|throttle|retry|idempot|synchron|sync|mutex|lock|queue/],
    ['api-errors', /\bapi\b|graphql|openapi|http|failure|error handling|timeout|status code|contract/],
    ['observability', /observability|logging|telemetry|metric|trace|crash|monitor/],
    ['architecture-enforcement', /fitness function|lint|import boundary|architecture test|enforce|adr|dependency check/],
    ['ecommerce', /e-?commerce|cart|checkout|inventory|price|pricing|promotion|payment|order|catalog/],
    ['data-state', /repository|datasource|data source|cache|storage|database|state management|source of truth|persistence/],
    ['domain-business', /domain|business rule|invariant|entity|use case|business failure/],
    ['feature-boundaries', /feature boundary|cross-feature|dependency|composition root|dependency injection|\bdi\b|module boundary|core ownership|coupling/],
  ];
  for (const [id, rx] of rules) if (rx.test(hay)) return id;
  return 'maintainability';
}

function defaultPriority(severity) {
  if (severity === 'critical') return 'P0';
  if (severity === 'high') return 'P1';
  return 'P2';
}

function evidenceText(evidence) {
  return (evidence || []).map(e => {
    const line = e.line ? ':' + e.line : '';
    return `${e.source || 'unknown'}${line} — ${e.detail || ''}`;
  }).join('; ');
}

function normalizeFinding(finding, meta) {
  const severity = finding.severity || 'info';
  const owner = meta.owner || 'unknown';
  return {
    id: finding.id || `${owner}-finding`,
    group: inferGroup(finding, owner),
    severity,
    issue: finding.title || finding.summary || 'Untitled finding',
    currentDesign: finding.currentDesign || (finding.evidence?.[0]?.detail || 'See evidence.'),
    evidence: finding.evidence || [],
    recommendation: finding.recommendation || 'No recommendation supplied.',
    why: finding.why || 'Not stated by the specialist.',
    impact: finding.impact || 'Not stated by the specialist.',
    priority: finding.priority || defaultPriority(severity),
    ownerDomain: finding.ownerDomain || owner,
    confidence: Number.isFinite(Number(finding.confidence)) ? Number(finding.confidence) : null,
    uncertainty: finding.uncertainty || 'unknown',
    principle: finding.principle || 'Not stated.',
    sourceType: meta.sourceType,
    sourceArtifact: meta.sourceArtifact,
    provenance: finding.provenance || [owner],
    resolved: meta.sourceType === 'review' ? finding.resolved === true : null,
  };
}

function analysisFindings(runDir) {
  const dir = path.join(runDir, '05-analysis');
  const synthesis = readJson(path.join(dir, 'synthesis.json'));
  if (synthesis && Array.isArray(synthesis.findings)) {
    return synthesis.findings.map(f => normalizeFinding(f, {
      owner: (f.provenance || []).join(', ') || 'analysis',
      sourceType: 'analysis',
      sourceArtifact: '05-analysis/synthesis.json',
    }));
  }
  return listJson(dir, new Set(['synthesis.json', 'conflicts.json', 'arbitration.json']))
    .flatMap(({ file, data }) => (data.findings || []).map(f => normalizeFinding(f, {
      owner: data.agent || file.replace(/\.json$/, ''),
      sourceType: 'analysis',
      sourceArtifact: `05-analysis/${file}`,
    })));
}

function reviewFindings(runDir) {
  const dir = path.join(runDir, '09-reviews');
  return listJson(dir).flatMap(({ file, data }) => (data.findings || []).map(f => normalizeFinding(f, {
    owner: data.reviewer || file.replace(/\.json$/, ''),
    sourceType: 'review',
    sourceArtifact: `09-reviews/${file}`,
  })));
}

function sourceRoles(runDir) {
  const roles = new Set();
  for (const { file, data } of listJson(path.join(runDir, '05-analysis'), new Set(['synthesis.json', 'conflicts.json', 'arbitration.json']))) {
    roles.add(String(data.agent || file.replace(/\.json$/, '')).toLowerCase());
  }
  for (const { file, data } of listJson(path.join(runDir, '09-reviews'))) {
    roles.add(String(data.reviewer || file.replace(/\.json$/, '')).toLowerCase());
  }
  return [...roles];
}

function architectureCoverage(runDir, findings) {
  const analysis = listJson(path.join(runDir, '05-analysis'), new Set(['synthesis.json', 'conflicts.json', 'arbitration.json']));
  const architect = analysis.find(x => /architect/i.test(String(x.data.agent || x.file)));
  const declared = new Map();
  for (const item of architect?.data?.coverage || []) {
    const id = normalizeGroup(item.area);
    if (id) declared.set(id, item);
  }

  const request = (() => {
    try { return fs.readFileSync(path.join(runDir, '00-request.md'), 'utf8'); } catch { return ''; }
  })();
  const ecommerceDetected = /\b(cart|checkout|inventory|pricing?|promotion|payment|order|catalog|e-?commerce)\b/i.test(request) ||
    findings.some(f => f.group === 'ecommerce');

  return GROUPS.map(group => {
    const item = declared.get(group.id);
    const groupFindings = findings.filter(f => f.group === group.id);
    if (item) {
      return {
        area: group.id,
        title: group.title,
        status: item.status,
        evidence: item.evidence || [],
        findingIds: item.findingIds || groupFindings.map(f => f.id),
        notes: item.notes || '',
        source: 'architect-declared',
      };
    }
    if (group.id === 'ecommerce' && !ecommerceDetected) {
      return { area: group.id, title: group.title, status: 'not-applicable', evidence: [], findingIds: [], notes: 'No e-commerce context detected.', source: 'runtime' };
    }
    if (groupFindings.length) {
      return { area: group.id, title: group.title, status: 'finding', evidence: [], findingIds: groupFindings.map(f => f.id), notes: 'Finding evidence exists but explicit architect coverage was not declared.', source: 'inferred' };
    }
    return { area: group.id, title: group.title, status: 'not-reviewed', evidence: [], findingIds: [], notes: 'No explicit architect coverage evidence.', source: 'runtime' };
  });
}

function decisionFor(findings, artifacts) {
  const blockedArtifact = artifacts.some(x => x.status === 'blocked');
  const blockingReview = findings.some(f => f.sourceType === 'review' && f.resolved !== true && ['critical', 'high'].includes(f.severity));
  const critical = findings.some(f => f.severity === 'critical' && f.resolved !== true);
  if (blockedArtifact || blockingReview || critical) return 'BLOCKED';
  if (findings.some(f => ['high', 'medium'].includes(f.severity) && f.resolved !== true)) return 'CONDITIONAL';
  return 'PASS';
}

function artifactStatuses(runDir) {
  const out = [];
  for (const { file, data } of listJson(path.join(runDir, '05-analysis'), new Set(['synthesis.json', 'conflicts.json', 'arbitration.json']))) {
    out.push({ phase: 'analysis', role: data.agent || file.replace(/\.json$/, ''), status: data.status || 'unknown', artifact: `05-analysis/${file}` });
  }
  for (const { file, data } of listJson(path.join(runDir, '09-reviews'))) {
    out.push({ phase: 'review', role: data.reviewer || file.replace(/\.json$/, ''), status: data.status || 'unknown', artifact: `09-reviews/${file}` });
  }
  return out;
}

function build(runId) {
  const runDir = path.join(stateRoot(), runId);
  if (!fs.existsSync(runDir)) throw new Error(`run not found: ${runId} under ${stateRoot()}`);

  const findings = [...analysisFindings(runDir), ...reviewFindings(runDir)]
    .sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0) ||
      (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0) ||
      a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
  const artifacts = artifactStatuses(runDir);
  const coverage = architectureCoverage(runDir, findings);
  const counts = {
    critical: findings.filter(x => x.severity === 'critical').length,
    high: findings.filter(x => x.severity === 'high').length,
    medium: findings.filter(x => x.severity === 'medium').length,
    low: findings.filter(x => x.severity === 'low').length,
    info: findings.filter(x => x.severity === 'info').length,
    P0: findings.filter(x => x.priority === 'P0').length,
    P1: findings.filter(x => x.priority === 'P1').length,
    P2: findings.filter(x => x.priority === 'P2').length,
  };
  const groups = GROUPS.map(group => ({
    id: group.id,
    title: group.title,
    findings: findings.filter(f => f.group === group.id),
  }));

  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    decision: decisionFor(findings, artifacts),
    counts,
    coverage,
    coverageComplete: coverage.every(x => ['pass', 'finding', 'not-applicable'].includes(x.status)),
    coverageGaps: coverage.filter(x => x.status === 'not-reviewed').map(x => x.area),
    sourceRoles: sourceRoles(runDir),
    sourceArtifacts: artifacts,
    groups,
    findings,
  };
}

function esc(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function markdown(report) {
  const lines = [
    `# Architecture Review — ${report.runId}`,
    '',
    'Rules: `ai/standards/engineering-rulebook.md`',
    '',
    `Overall decision: **${report.decision}**`,
    '',
    '> This report aggregates evidence produced by the workflow. Its decision is advisory and does not replace deterministic workflow gates or human approval.',
    '',
    '## Executive summary',
    '',
    `Critical: **${report.counts.critical}** · High: **${report.counts.high}** · Medium: **${report.counts.medium}** · Low: **${report.counts.low}** · Info: **${report.counts.info}**`,
    '',
    `P0: **${report.counts.P0}** · P1: **${report.counts.P1}** · P2: **${report.counts.P2}**`,
    '',
    `Coverage complete: **${report.coverageComplete ? 'yes' : 'no'}**`,
    '',
    '## Coverage matrix',
    '',
    '| Area | Reviewed | Result | Evidence / notes |',
    '|---|---|---|---|',
  ];

  for (const c of report.coverage) {
    const reviewed = ['pass', 'finding', 'not-applicable'].includes(c.status) ? 'yes' : 'no';
    const ev = [...(c.evidence || []), c.notes].filter(Boolean).join('; ');
    lines.push(`| ${esc(c.title)} | ${reviewed} | ${c.status} | ${esc(ev || '—')} |`);
  }

  const strengths = report.coverage.filter(x => x.status === 'pass');
  lines.push('', '## Architecture strengths', '');
  if (!strengths.length) lines.push('- No explicitly evidenced pass areas were declared.');
  else for (const s of strengths) lines.push(`- **${s.title}** — ${(s.evidence || []).join('; ') || s.notes || 'reviewed with no finding'}`);

  lines.push('', '## Key architecture issues', '');
  if (!report.findings.length) lines.push('No findings were reported by the selected specialists/reviewers.');

  for (const group of report.groups) {
    if (!group.findings.length) continue;
    lines.push('', `### ${group.title}`, '');
    lines.push('| Severity | Issue | Current design | Evidence | Recommendation | Why | Impact | Priority | Owner | Confidence | Principle |');
    lines.push('|---|---|---|---|---|---|---|---|---|---:|---|');
    for (const f of group.findings) {
      lines.push(`| ${f.severity} | ${esc(f.issue)} | ${esc(f.currentDesign)} | ${esc(evidenceText(f.evidence))} | ${esc(f.recommendation)} | ${esc(f.why)} | ${esc(f.impact)} | ${f.priority} | ${esc(f.ownerDomain)} | ${f.confidence === null ? '—' : f.confidence} | ${esc(f.principle)} |`);
    }
  }

  lines.push('', '## Priority grouping', '');
  for (const priority of ['P0', 'P1', 'P2']) {
    lines.push(`### ${priority}`, '');
    const items = report.findings.filter(x => x.priority === priority && x.resolved !== true);
    if (!items.length) lines.push('- None');
    else for (const f of items) lines.push(`- **[${f.severity}] ${f.issue}** — ${f.recommendation}`);
    lines.push('');
  }

  lines.push('## Coverage gaps', '');
  if (!report.coverageGaps.length) lines.push('- None.');
  else for (const id of report.coverageGaps) lines.push(`- ${GROUP_BY_ID.get(id)?.title || id}: not explicitly reviewed. A clean report must not treat this as a pass.`);

  lines.push('', '## Architecture decision principle', '', 'Every architecture rule/finding should answer **WHAT → WHY → HOW → EXCEPTION**, and every pass/finding should be backed by repository evidence.', '');
  return lines.join('\n');
}

function outputDirFor(runId, custom) {
  return custom ? path.resolve(custom) : path.join(stateRoot(), runId, 'reports');
}

function writeReport(report, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const json = path.join(outputDir, 'architecture-review.json');
  const md = path.join(outputDir, 'architecture-review.md');
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(md, markdown(report) + '\n');
  return { json, markdown: md };
}

function selftest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-review-'));
  const old = process.env.AI_WORKFLOW_STATE_ROOT;
  process.env.AI_WORKFLOW_STATE_ROOT = temp;
  try {
    const run = path.join(temp, 'ARCH-TEST');
    fs.mkdirSync(path.join(run, '05-analysis'), { recursive: true });
    fs.mkdirSync(path.join(run, '09-reviews'), { recursive: true });
    fs.writeFileSync(path.join(run, '00-request.md'), 'Review a Flutter e-commerce cart.\n');
    const coverage = GROUPS.map(g => ({
      area: g.id,
      status: g.id === 'feature-boundaries' ? 'finding' : 'pass',
      evidence: [`repo:${g.id}`],
      findingIds: g.id === 'feature-boundaries' ? ['ARCH-1'] : [],
    }));
    fs.writeFileSync(path.join(run, '05-analysis', 'mobile-architect.json'), JSON.stringify({
      schemaVersion: 1, runId: 'ARCH-TEST', agent: 'mobile-architect', status: 'pass', coverage,
      findings: [{
        id: 'ARCH-1', title: 'Cross-feature presentation dependency', severity: 'critical',
        uncertainty: 'confirmed', confidence: 0.98,
        evidence: [{ source: 'lib/features/catalog/widget.dart', line: 42, detail: 'imports CartBloc' }],
        recommendation: 'Compose the features outside their presentation layers.',
        group: 'feature-boundaries', currentDesign: 'Catalog presentation dispatches CartBloc.',
        why: 'Feature presentation layers become tightly coupled.', impact: 'Independent change and testing become harder.',
        priority: 'P0', ownerDomain: 'architecture', principle: 'Feature isolation',
      }],
    }, null, 2));
    fs.writeFileSync(path.join(run, '05-analysis', 'synthesis.json'), JSON.stringify({
      findings: [{
        id: 'ARCH-1', title: 'Cross-feature presentation dependency', severity: 'critical',
        uncertainty: 'confirmed', confidence: 0.98,
        evidence: [{ source: 'lib/features/catalog/widget.dart', line: 42, detail: 'imports CartBloc' }],
        recommendation: 'Compose the features outside their presentation layers.',
        group: 'feature-boundaries', currentDesign: 'Catalog presentation dispatches CartBloc.',
        why: 'Feature presentation layers become tightly coupled.', impact: 'Independent change and testing become harder.',
        priority: 'P0', ownerDomain: 'architecture', principle: 'Feature isolation', provenance: ['mobile-architect'],
      }],
    }, null, 2));

    const report = build('ARCH-TEST');
    assert.strictEqual(report.decision, 'BLOCKED');
    assert.strictEqual(report.coverageComplete, true);
    assert.strictEqual(report.groups.find(x => x.id === 'feature-boundaries').findings.length, 1);
    assert(markdown(report).includes('Why'));
    const files = writeReport(report, path.join(run, 'reports'));
    assert(fs.existsSync(files.json) && fs.existsSync(files.markdown));
    console.log('architecture-review-report selftest OK');
  } finally {
    if (old === undefined) delete process.env.AI_WORKFLOW_STATE_ROOT; else process.env.AI_WORKFLOW_STATE_ROOT = old;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  const runId = args.find(x => !x.startsWith('--') && x !== 'build');
  if (!runId) throw new Error('usage: architecture-review-report.js <run-id> [--json] [--output <dir>]');
  const outAt = args.indexOf('--output');
  const custom = outAt >= 0 ? args[outAt + 1] : null;
  if (outAt >= 0 && !custom) throw new Error('--output requires a directory');
  const report = build(runId);
  const files = writeReport(report, outputDirFor(runId, custom));
  if (args.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(markdown(report) + `\nExported: ${files.markdown}\nJSON: ${files.json}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('✗ ' + error.message); process.exitCode = 1; }
}

module.exports = { GROUPS, build, markdown, writeReport, inferGroup, decisionFor };
