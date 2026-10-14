#!/usr/bin/env node
'use strict';

// Builds the verified impact register from specialist findings and
// adversarial verifier votes written by the /impact command.
//
// Input  (<state>/<run-id>/impact/):
//   findings/<group>.json  {group, scopeCovered, notCovered, findings:[{id?, severity, area, title,
//                           baseRef, headRef, whatChanged, effect, fix, confidence, productionChecked}]}
//   verdicts/<id>.<lens>.json {findingId, lens, refuted, productionHasSame, reachable,
//                           correctedSeverity: high|medium|low|drop, correctedEvidence, reason}
// Output (<state>/<run-id>/impact/report/):
//   impact-register.json, impact-register.md, impact-register.csv (opens in Excel)
//
// Survival rule: one verifier must not refute; two or more need a refuting
// minority. A finding with no verdict is "unverified", never silently kept.
// Final severity is the median of the verifiers' corrected severities.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateRoot } = require('./paths');

const SEV = { critical: 4, high: 3, medium: 2, low: 1 };
const SEV_NAME = { 4: 'critical', 3: 'high', 2: 'medium', 1: 'low' };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({ file: f, data: readJson(path.join(dir, f)) })).filter(x => x.data);
  } catch { return []; }
}

function normSev(v) {
  const s = String(v || '').toLowerCase().trim();
  if (s === 'h') return 'high';
  if (s === 'm') return 'medium';
  if (s === 'l') return 'low';
  return SEV[s] ? s : s === 'drop' ? 'drop' : 'medium';
}

function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// First file:line in a reference string, used to merge duplicates.
function anchor(ref) {
  const m = String(ref || '').match(/([\w./-]+\.\w+):(\d+)/);
  return m ? `${m[1].split('/').slice(-2).join('/')}:${m[2]}` : null;
}

function loadFindings(impactDir) {
  const out = [];
  const coverage = [];
  for (const { file, data } of listJson(path.join(impactDir, 'findings'))) {
    const group = data.group || file.replace(/\.json$/, '');
    coverage.push({ group, covered: data.scopeCovered || '', notCovered: data.notCovered || '' });
    (data.findings || []).forEach((f, i) => {
      out.push({
        id: f.id || `${group}#${i + 1}`,
        group,
        severity: normSev(f.severity),
        area: f.area || '',
        title: f.title || '',
        baseRef: f.baseRef || f.base_ref || '',
        headRef: f.headRef || f.head_ref || f.revamp_ref || '',
        whatChanged: f.whatChanged || f.what_changed || '',
        effect: f.effect || '',
        fix: f.fix || '',
        confidence: f.confidence || '',
        productionChecked: !!(f.productionChecked ?? f.master_checked),
      });
    });
  }
  return { findings: out, coverage };
}

function loadVerdicts(impactDir) {
  const by = new Map();
  for (const { data } of listJson(path.join(impactDir, 'verdicts'))) {
    const list = Array.isArray(data) ? data : [data];
    for (const v of list) {
      if (!v || !v.findingId) continue;
      if (!by.has(v.findingId)) by.set(v.findingId, []);
      by.get(v.findingId).push({
        lens: v.lens || 'all',
        refuted: !!v.refuted,
        productionHasSame: !!v.productionHasSame,
        reachable: v.reachable !== false,
        correctedSeverity: normSev(v.correctedSeverity),
        correctedEvidence: v.correctedEvidence || '',
        reason: v.reason || '',
      });
    }
  }
  return by;
}

function judge(finding, votes) {
  if (!votes || !votes.length) return { state: 'unverified', severity: finding.severity, votes: [] };
  const refutes = votes.filter(v => v.refuted || v.productionHasSame || !v.reachable || v.correctedSeverity === 'drop').length;
  const survives = votes.length === 1 ? refutes === 0 : refutes * 2 < votes.length;
  const sevs = votes.filter(v => v.correctedSeverity !== 'drop').map(v => SEV[v.correctedSeverity]).sort((a, b) => a - b);
  const severity = sevs.length ? SEV_NAME[sevs[Math.floor((sevs.length - 1) / 2)]] : finding.severity;
  return { state: survives ? 'kept' : 'refuted', severity, votes };
}

function dedupe(items) {
  const seen = new Map();
  const kept = [];
  for (const f of items) {
    const keys = [slug(f.title)];
    const a = anchor(f.reportedHeadRef || f.headRef);
    if (a) keys.push(`${a}|${slug(f.area)}`);
    const hit = keys.map(k => seen.get(k)).find(Boolean);
    if (hit) {
      hit.duplicates.push(f.id);
      if (SEV[f.severity] > SEV[hit.severity]) hit.severity = f.severity;
      continue;
    }
    const entry = { ...f, duplicates: [] };
    keys.forEach(k => seen.set(k, entry));
    kept.push(entry);
  }
  return kept;
}

function build(impactDir) {
  const { findings, coverage } = loadFindings(impactDir);
  const verdicts = loadVerdicts(impactDir);
  const judged = findings.map(f => {
    const j = judge(f, verdicts.get(f.id));
    const evidence = (j.votes.find(v => v.correctedEvidence) || {}).correctedEvidence;
    return { ...f, originalSeverity: f.severity, severity: j.severity, state: j.state, reportedHeadRef: f.headRef, headRef: evidence || f.headRef, votes: j.votes };
  });
  const kept = dedupe(judged.filter(f => f.state === 'kept'))
    .sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.id.localeCompare(b.id));
  const baseline = readJson(path.join(impactDir, 'baseline.json'));
  const synthesis = readJson(path.join(impactDir, 'synthesis.json'));
  const count = s => kept.filter(f => f.severity === s).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    refs: baseline ? baseline.refs : null,
    summary: {
      kept: kept.length,
      critical: count('critical'), high: count('high'), medium: count('medium'), low: count('low'),
      refuted: judged.filter(f => f.state === 'refuted').length,
      unverified: judged.filter(f => f.state === 'unverified').length,
      reported: findings.length,
    },
    synthesis,
    coverage,
    findings: kept,
    refuted: judged.filter(f => f.state === 'refuted'),
    unverified: judged.filter(f => f.state === 'unverified'),
  };
}

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function markdown(r) {
  const s = r.summary;
  const L = ['# Impact register', ''];
  if (r.refs) L.push(`Head \`${r.refs.head}\` @ \`${String(r.refs.headSha).slice(0, 9)}\` vs merge base \`${String(r.refs.mergeBase).slice(0, 9)}\`${r.refs.prod ? `, production \`${r.refs.prod}\`` : ''}.`, '');
  if (r.synthesis && r.synthesis.releaseDecision) L.push(`**Decision:** ${r.synthesis.releaseDecision}`, '');
  L.push(`${s.reported} findings reported; **${s.kept} kept** (${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low), ${s.refuted} refuted by verifiers, ${s.unverified} unverified.`, '');
  const sevBlock = (name) => {
    const items = r.findings.filter(f => f.severity === name);
    if (!items.length) return;
    L.push(`## ${name[0].toUpperCase() + name.slice(1)} (${items.length})`, '', '| ID | Area | Finding | Effect | Fix | Where | Votes |', '|---|---|---|---|---|---|---|');
    for (const f of items) {
      const votes = f.votes.map(v => `${v.lens}:${v.refuted || v.productionHasSame || !v.reachable ? '✗' : '✓'}`).join(' ');
      const was = f.originalSeverity !== f.severity ? ` (was ${f.originalSeverity})` : '';
      L.push(`| ${f.id}${was} | ${cell(f.area)} | ${cell(f.title)} | ${cell(f.effect)} | ${cell(f.fix)} | ${cell(f.headRef)} | ${votes} |`);
    }
    L.push('');
  };
  ['critical', 'high', 'medium', 'low'].forEach(sevBlock);
  if (r.synthesis && Array.isArray(r.synthesis.rootCauses) && r.synthesis.rootCauses.length) {
    L.push('## Root causes', '');
    for (const c of r.synthesis.rootCauses) L.push(`- **${cell(c.cause)}** (${(c.findings || []).join(', ')}): ${cell(c.systemicFix)}`);
    L.push('');
  }
  if (r.unverified.length) {
    L.push(`## Unverified (${r.unverified.length})`, '', 'No verifier returned a verdict. Re-run verification before relying on these.', '');
    for (const f of r.unverified) L.push(`- ${f.id} [${f.severity}] ${cell(f.title)}`);
    L.push('');
  }
  if (r.refuted.length) {
    L.push(`## Refuted (${r.refuted.length})`, '', 'Reported by a specialist but did not survive verification.', '');
    for (const f of r.refuted) L.push(`- ${f.id} ${cell(f.title)} — ${cell((f.votes.find(v => v.reason) || {}).reason)}`);
    L.push('');
  }
  L.push('## Coverage', '');
  for (const c of r.coverage) L.push(`- **${c.group}**: covered ${cell(c.covered).slice(0, 300)}${c.notCovered ? `; not covered: ${cell(c.notCovered).slice(0, 200)}` : ''}`);
  L.push('');
  return L.join('\n');
}

function csv(r) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['ID', 'State', 'Severity', 'Original severity', 'Area', 'Title', 'What changed', 'Effect', 'Fix', 'Where (head)', 'Base reference', 'Verifier votes', 'Verifier reason', 'Duplicates', 'Group', 'Status', 'Owner'];
  const rows = [head.map(q).join(',')];
  const add = f => rows.push([f.id, f.state, f.severity, f.originalSeverity, f.area, f.title, f.whatChanged, f.effect, f.fix, f.headRef, f.baseRef,
    f.votes.map(v => `${v.lens}:${v.refuted || v.productionHasSame || !v.reachable ? 'refuted' : 'kept'}`).join(' '),
    (f.votes.find(v => v.reason) || {}).reason, (f.duplicates || []).join(' '), f.group, f.state === 'kept' ? 'Open' : '', ''].map(q).join(','));
  r.findings.forEach(add); r.unverified.forEach(add); r.refuted.forEach(add);
  return '﻿' + rows.join('\r\n') + '\r\n';
}

function write(r, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    json: path.join(outDir, 'impact-register.json'),
    markdown: path.join(outDir, 'impact-register.md'),
    csv: path.join(outDir, 'impact-register.csv'),
  };
  fs.writeFileSync(files.json, JSON.stringify(r, null, 2) + '\n');
  fs.writeFileSync(files.markdown, markdown(r));
  fs.writeFileSync(files.csv, csv(r));
  return files;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-register-'));
  try {
    const dir = path.join(tmp, 'impact');
    fs.mkdirSync(path.join(dir, 'findings'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'verdicts'), { recursive: true });
    const w = (p, d) => fs.writeFileSync(path.join(dir, p), JSON.stringify(d));
    w('findings/checkout.json', { group: 'checkout', scopeCovered: 'checkout pages', notCovered: '', findings: [
      { id: 'F-1', severity: 'high', area: 'Payments', title: 'No-3DS payment opens empty webview', headRef: 'lib/pay.dart:539', effect: 'stuck', fix: 'guard' },
      { id: 'F-2', severity: 'high', area: 'Cart', title: 'Inverted dimming', headRef: 'lib/cart.dart:10' },
      { id: 'F-3', severity: 'medium', area: 'Orders', title: 'Spinner never stops', headRef: 'lib/orders.dart:5' },
      { id: 'F-4', severity: 'low', area: 'Payments', title: 'Duplicate of F-1 wording', headRef: 'lib/pay.dart:539' },
      { id: 'F-5', severity: 'medium', area: 'Search', title: 'Never verified' },
    ] });
    w('verdicts/F-1.code.json', { findingId: 'F-1', lens: 'code', refuted: false, correctedSeverity: 'high' });
    w('verdicts/F-1.provenance.json', { findingId: 'F-1', lens: 'provenance', refuted: false, correctedSeverity: 'high', correctedEvidence: 'lib/pay.dart:540' });
    w('verdicts/F-1.impact.json', { findingId: 'F-1', lens: 'impact', refuted: false, correctedSeverity: 'medium' });
    w('verdicts/F-2.all.json', [
      { findingId: 'F-2', lens: 'code', refuted: false, correctedSeverity: 'high' },
      { findingId: 'F-2', lens: 'provenance', refuted: true, productionHasSame: true, correctedSeverity: 'drop', reason: 'production has the same code' },
      { findingId: 'F-2', lens: 'impact', refuted: true, correctedSeverity: 'drop', reason: 'same on production' },
    ]);
    w('verdicts/F-3.all.json', { findingId: 'F-3', lens: 'all', refuted: false, correctedSeverity: 'low' });
    w('verdicts/F-4.all.json', { findingId: 'F-4', lens: 'all', refuted: false, correctedSeverity: 'low' });
    const r = build(dir);
    assert.equal(r.summary.reported, 5);
    assert.equal(r.summary.refuted, 1, 'majority refute drops F-2');
    assert.equal(r.summary.unverified, 1, 'no verdict is unverified, not kept');
    const f1 = r.findings.find(f => f.id === 'F-1');
    assert.equal(f1.severity, 'high', 'median of high, high, medium');
    assert.equal(f1.headRef, 'lib/pay.dart:540', 'verifier evidence replaces the original');
    assert.deepEqual(f1.duplicates, ['F-4'], 'same reported file:line and area merges, even after evidence correction');
    const f3 = r.findings.find(f => f.id === 'F-3');
    assert.equal(f3.severity, 'low');
    assert.equal(f3.originalSeverity, 'medium');
    const files = write(r, path.join(dir, 'report'));
    const md = fs.readFileSync(files.markdown, 'utf8');
    assert.ok(md.includes('## Refuted (1)') && md.includes('## Unverified (1)'));
    assert.ok(fs.readFileSync(files.csv, 'utf8').startsWith('﻿"ID"'));
    // Duplicate by title merges and keeps the higher severity.
    const d = dedupe([{ id: 'a', title: 'Same bug', area: 'x', severity: 'low', headRef: '' }, { id: 'b', title: 'same  bug', area: 'y', severity: 'high', headRef: '' }]);
    assert.equal(d.length, 1); assert.equal(d[0].severity, 'high'); assert.deepEqual(d[0].duplicates, ['b']);
    console.log('impact-register selftest OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  const target = args.find(x => !x.startsWith('--'));
  if (!target) throw new Error('usage: impact-register.js <run-id|impact-dir> [--json] [--output <dir>]');
  const impactDir = fs.existsSync(path.join(target, 'findings')) ? path.resolve(target) : path.join(stateRoot(), target, 'impact');
  if (!fs.existsSync(path.join(impactDir, 'findings'))) throw new Error(`no findings/ under ${impactDir}; run /impact first`);
  const outAt = args.indexOf('--output');
  const outDir = outAt >= 0 ? path.resolve(args[outAt + 1]) : path.join(impactDir, 'report');
  const r = build(impactDir);
  const files = write(r, outDir);
  if (args.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(markdown(r) + `\nExported: ${files.markdown}\nCSV (Excel): ${files.csv}\nJSON: ${files.json}\n`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { build, judge, dedupe, markdown, csv };
