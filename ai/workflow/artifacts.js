#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMAS = path.join(__dirname, 'schemas');

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function schemaFile(name) {
  const file = path.join(SCHEMAS, `${name}.schema.json`);
  if (!fs.existsSync(file)) throw new Error(`unknown artifact schema "${name}"`);
  return file;
}

function schemaContract(name) {
  return JSON.stringify(load(schemaFile(name)), null, 2);
}

function checkSchemaDefinition(name, schema) {
  const problems = [];
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') problems.push('$schema must use draft 2020-12');
  if (!schema.$id) problems.push('$id is required');
  if (schema.type !== 'object') problems.push('root type must be object');
  if (!Array.isArray(schema.required) || !schema.required.includes('schemaVersion')) problems.push('schemaVersion must be required');
  if (!schema.properties || !schema.properties.schemaVersion || schema.properties.schemaVersion.const !== 1) problems.push('schemaVersion must be const 1');
  return problems.map(p => `${name}: ${p}`);
}

function typeOk(value, type) {
  if (Array.isArray(type)) return type.some(t => typeOk(value, t));
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateNode(value, schema, at, errors) {
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: expected constant ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: expected one of ${schema.enum.join(', ')}`);
  if (schema.type && !typeOk(value, schema.type)) {
    errors.push(`${at}: expected type ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}`);
    return;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength) errors.push(`${at}: string is shorter than ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((item, i) => validateNode(item, schema.items, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}.${key}: required`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) validateNode(value[key], child, `${at}.${key}`, errors);
  }
}

function validate(name, data) {
  const schema = load(schemaFile(name));
  const errors = [];
  validateNode(data, schema, '$', errors);
  return errors;
}

function semanticProblems(name, data) {
  const errors = [];
  if (name === 'build-test' && data.status !== 'pass') errors.push('$.status: build/test artifact must be pass before the stage can complete');
  if (name === 'refactor-invariants') {
    const unapproved=(data.intentionalExceptions||[]).filter(x=>x.approved!==true);
    if(unapproved.length) errors.push(`$.intentionalExceptions: ${unapproved.length} exception(s) are not approved`);
  }
  if (name === 'architecture-options') {
    const ids = new Set((data.options || []).map(x => x.id));
    if (!ids.has(data.recommendation?.optionId)) errors.push('$.recommendation.optionId: must reference one of the proposed options');
    const criteria = new Set((data.options?.[0]?.criterionScores || []).map(x => x.criterionId));
    for (const option of data.options || []) {
      const optionCriteria = new Set((option.criterionScores || []).map(x => x.criterionId));
      if (criteria.size && optionCriteria.size !== criteria.size) errors.push(`$.options[${option.id}].criterionScores: all options must score the same criteria`);
    }
  }
  if (name === 'c4-model' && !/workspace\s*\{/i.test(data.structurizrDsl || '')) errors.push('$.structurizrDsl: expected a Structurizr DSL workspace');
  if (name === 'subagent-findings' && data.status !== 'pass') errors.push('$.status: subagent findings artifact must be pass before the role can complete');
  if (name === 'review') {
    if (data.status !== 'pass') errors.push('$.status: review must be pass before the review role can complete');
    const unresolvedHigh = (data.findings || []).filter(f => f && f.resolved === false && ['critical', 'high'].includes(f.severity));
    if (unresolvedHigh.length) errors.push(`$.findings: ${unresolvedHigh.length} unresolved critical/high finding(s)`);
  }
  if (name === 'behavior-equivalence') {
    if (data.status !== 'pass') errors.push('$.status: behavior equivalence must pass');
    if ((data.unexpectedChanges||[]).length) errors.push(`$.unexpectedChanges: ${data.unexpectedChanges.length} unexpected behavior change(s)`);
    if (data.fullyVerified === true && (data.unverifiedScenarios||[]).length) errors.push('$.fullyVerified: cannot be true while unverifiedScenarios is non-empty');
  }
  if (name === 'verification') {
    if (data.status !== 'pass') errors.push('$.status: verification artifact must be pass');
    for (const ac of data.acceptanceCriteria || []) {
      if (!['pass', 'not-applicable'].includes(ac.status)) errors.push(`$.acceptanceCriteria[${ac.id || '?'}]: status=${ac.status}`);
      if (ac.status === 'pass' && (!Array.isArray(ac.evidence) || !ac.evidence.length)) errors.push(`$.acceptanceCriteria[${ac.id || '?'}]: passing AC needs evidence`);
    }
    for (const item of data.definitionOfDone || []) if (!['pass', 'not-applicable'].includes(item.status)) errors.push(`$.definitionOfDone[${item.item || '?'}]: status=${item.status}`);
  }
  return errors;
}

function parseJsonText(text) {
  let value = String(text || '').trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();
  return JSON.parse(value);
}

function sidecarForMarkdown(file) {
  if (!String(file).endsWith('.md')) throw new Error(`structured artifact markdown path must end in .md: ${file}`);
  return String(file).replace(/\.md$/, '.json');
}

function renderMarkdown(name, data) {
  const pushList = (lines, title, items) => {
    lines.push('', `## ${title}`, '');
    if (!(items || []).length) lines.push('- None');
    else for (const item of items || []) lines.push('- ' + item);
  };
  if (name === 'architecture-assessment') {
    const lines=['# Architecture assessment','',data.currentArchitecture,''];
    pushList(lines,'Business drivers',data.businessDrivers);
    pushList(lines,'Constraints',data.constraints);
    lines.push('','## Quality attributes','', '| attribute | priority | rationale |', '|---|---|---|');
    for(const q of data.qualityAttributes||[]) lines.push(`| ${q.name} | ${q.priority} | ${String(q.rationale||'').replace(/\|/g,'\\|')} |`);
    pushList(lines,'Team and ownership',data.teamAndOwnership);
    pushList(lines,'Delivery and operations',data.deliveryAndOperations);
    pushList(lines,'Security and compliance',data.securityAndCompliance);
    pushList(lines,'Data and integrations',data.dataAndIntegrations);
    pushList(lines,'Testing and quality',data.testingAndQuality);
    pushList(lines,'Migration constraints',data.migrationConstraints);
    pushList(lines,'Cost constraints',data.costConstraints);
    pushList(lines,'Risks',data.risks);
    pushList(lines,'Unknowns and assumptions',data.unknowns);
    lines.push('','## Decision criteria','', '| id | criterion | weight | rationale |','|---|---|---:|---|');
    for(const x of data.decisionCriteria||[]) lines.push(`| ${x.id} | ${x.name} | ${x.weight} | ${String(x.rationale||'').replace(/\|/g,'\\|')} |`);
    return lines.join('\n').trim()+'\n';
  }
  if (name === 'architecture-options') {
    const lines=['# Architecture options and trade-offs',''];
    for(const option of data.options||[]){
      lines.push(`## ${option.id} — ${option.name}`,'',`Style: **${option.style}**`,'',option.summary||'');
      pushList(lines,'Benefits',option.benefits);
      pushList(lines,'Trade-offs',option.tradeoffs);
      pushList(lines,'Risks',option.risks);
      lines.push('','### Migration','',`- Effort: ${option.migration?.effort}`,`- Complexity: ${option.migration?.complexity}`,`- Reversibility: ${option.migration?.reversibility}`,`- Rollback: ${option.migration?.rollback}`);
      pushList(lines,'Team impact',option.teamImpact);
      pushList(lines,'Delivery impact',option.deliveryImpact);
      pushList(lines,'Operations impact',option.operationsImpact);
      pushList(lines,'Security impact',option.securityImpact);
      pushList(lines,'Performance impact',option.performanceImpact);
      pushList(lines,'Testability impact',option.testabilityImpact);
      lines.push('','### Decision scores','', '| criterion | score / 5 | evidence |','|---|---:|---|');
      for(const s of option.criterionScores||[]) lines.push(`| ${s.criterionId} | ${s.score} | ${String(s.evidence||'').replace(/\|/g,'\\|')} |`);
      lines.push('','### C4 preview','');
      pushList(lines,'System context',option.c4Preview?.systemContext);
      pushList(lines,'Containers',option.c4Preview?.containers);
      pushList(lines,'Components',option.c4Preview?.components);
      pushList(lines,'Dynamic flows',option.c4Preview?.dynamicFlows);
      pushList(lines,'Deployment',option.c4Preview?.deployment);
    }
    lines.push('','## Agent recommendation','',`Recommended option: **${data.recommendation?.optionId||''}**`,'',data.recommendation?.rationale||'');
    pushList(lines,'Recommendation caveats',data.recommendation?.caveats);
    pushList(lines,'Human decision notes',data.decisionNotes);
    lines.push('','> The recommendation is advisory. The workflow cannot continue until a human explicitly selects an architecture.');
    return lines.join('\n').trim()+'\n';
  }
  if (name === 'target-architecture') {
    const lines=['# Target architecture contract','',`Selected option: **${data.selectedOptionId}**`,'',data.decisionSummary||''];
    pushList(lines,'Architecture principles',data.principles);
    pushList(lines,'Boundaries',data.boundaries);
    lines.push('','## Dependency rules','','### Allowed',''); for(const x of data.dependencyRules?.allowed||[]) lines.push('- '+x);
    lines.push('','### Forbidden',''); for(const x of data.dependencyRules?.forbidden||[]) lines.push('- '+x);
    lines.push('','## Modules','', '| module | responsibility | dependencies |','|---|---|---|');
    for(const m of data.modules||[]) lines.push(`| ${m.name} | ${String(m.responsibility||'').replace(/\|/g,'\\|')} | ${(m.dependsOn||[]).join(', ')} |`);
    pushList(lines,'Data ownership',data.dataOwnership);
    pushList(lines,'State management',data.stateManagement);
    pushList(lines,'Navigation',data.navigation);
    pushList(lines,'Integration contracts',data.integrationContracts);
    pushList(lines,'Security controls',data.securityControls);
    pushList(lines,'Observability',data.observability);
    pushList(lines,'Testing strategy',data.testingStrategy);
    pushList(lines,'Performance budgets',data.performanceBudgets);
    pushList(lines,'Migration guardrails',data.migrationGuardrails);
    lines.push('','## Architecture fitness functions','', '| id | rule | verification |','|---|---|---|');
    for(const x of data.fitnessFunctions||[]) lines.push(`| ${x.id} | ${String(x.rule||'').replace(/\|/g,'\\|')} | ${String(x.verification||'').replace(/\|/g,'\\|')} |`);
    return lines.join('\n').trim()+'\n';
  }
  if (name === 'c4-model') {
    const lines=['# C4 architecture model','',`System: **${data.systemContext?.system||''}**`];
    pushList(lines,'People',data.systemContext?.people);
    pushList(lines,'External systems',data.systemContext?.externalSystems);
    pushList(lines,'System relationships',data.systemContext?.relationships);
    lines.push('','## Containers','', '| container | responsibility | technology |','|---|---|---|');
    for(const x of data.containers||[]) lines.push(`| ${x.name} | ${String(x.responsibility||'').replace(/\|/g,'\\|')} | ${x.technology||''} |`);
    lines.push('','## Components','');
    for(const group of data.components||[]){lines.push(`### ${group.container}`,'');for(const x of group.components||[])lines.push('- '+x);}
    pushList(lines,'Dynamic views',data.dynamicViews);
    pushList(lines,'Deployment views',data.deploymentViews);
    lines.push('','## Structurizr DSL','','```structurizr',data.structurizrDsl||'','```');
    pushList(lines,'Assumptions',data.assumptions);
    return lines.join('\n').trim()+'\n';
  }
  if (name === 'architecture-migration') {
    const lines=['# Architecture migration waves',''];
    lines.push('## Domains','', '| id | domain | risk | depends on |','|---|---|---|---|');
    for(const x of data.domains||[]) lines.push(`| ${x.id} | ${x.name} | ${x.risk} | ${(x.dependsOn||[]).join(', ')} |`);
    lines.push('','## Waves','');
    for(const w of data.waves||[]){lines.push(`### ${w.id}`,'',w.goal||'', '',`Domains: ${(w.domains||[]).join(', ')}`,'',`Verification: ${(w.verification||[]).join('; ')}`,'',`Rollback point: ${w.rollbackPoint||'n/a'}`,'');}
    pushList(lines,'Integration checkpoints',data.integrationCheckpoints);
    pushList(lines,'Rollback strategy',data.rollbackStrategy);
    pushList(lines,'Completion criteria',data.completionCriteria);
    return lines.join('\n').trim()+'\n';
  }
  if (name === 'behavior-baseline') {
    const lines=['# Behavior baseline','', '## Observable behaviors',''];
    for(const b of data.observableBehaviors||[]) lines.push(`- **${b.id}** [${b.criticality}] ${b.description} — coverage: ${b.coverage.status}${(b.coverage.evidence||[]).length ? ' ('+b.coverage.evidence.join(', ')+')':''}`);
    const sections=[['Public APIs',data.publicApis],['State transitions',data.stateTransitions],['Side effects',data.sideEffects],['API calls',data.apiCalls],['Storage contracts',data.storageContracts],['Navigation contracts',data.navigationContracts],['Analytics events',data.analyticsEvents],['Error behavior',data.errorBehavior],['Concurrency behavior',data.concurrencyBehavior],['Lifecycle behavior',data.lifecycleBehavior],['Known unverified areas',data.knownUnverifiedAreas]];
    for(const [title,items] of sections){lines.push('',`## ${title}`,'');for(const item of items||[])lines.push('- '+item);}
    return lines.join('\n').trim()+'\n';
  }
  if (name === 'refactor-invariants') {
    const lines=['# Refactor preservation invariants','', '## Must preserve',''];
    for(const [k,v] of Object.entries(data.mustPreserve||{})) lines.push(`- [${v?'x':' '}] ${k}`);
    lines.push('','## Intentional exceptions','');
    if(!(data.intentionalExceptions||[]).length) lines.push('- None');
    for(const x of data.intentionalExceptions||[]) lines.push(`- ${x.invariant}: ${x.reason} — approved=${x.approved?'yes':'no'}`);
    return lines.join('\n').trim()+'\n';
  }
  if (name === 'acceptance-criteria') {
    const lines = ['# Acceptance criteria', ''];
    for (const item of data.criteria || []) {
      lines.push(`## ${item.id}`, '', item.statement || '', '');
      if (item.verification) lines.push(`Verification: ${item.verification}`, '');
      if (Array.isArray(item.platforms) && item.platforms.length) lines.push(`Platforms: ${item.platforms.join(', ')}`, '');
    }
    return lines.join('\n').trim() + '\n';
  }
  if (name === 'plan') {
    const lines = ['# Implementation plan', '', data.summary, '', '## Steps', ''];
    for (const step of data.steps || []) {
      lines.push(`${step.id}. ${step.description}`);
      if (Array.isArray(step.files) && step.files.length) lines.push(`   Files: ${step.files.join(', ')}`);
    }
    lines.push('', '## Acceptance criteria', '');
    for (const ac of data.acceptanceCriteria || []) lines.push(`- ${ac}`);
    if (Array.isArray(data.refactorIncrements) && data.refactorIncrements.length) {
      lines.push('', '## Refactor increments', '');
      for (const inc of data.refactorIncrements) {
        lines.push(`### ${inc.id}`, '', inc.description || '', '');
        if (Array.isArray(inc.files) && inc.files.length) lines.push(`Files: ${inc.files.join(', ')}`, '');
        if (Array.isArray(inc.verification) && inc.verification.length) lines.push(`Verification: ${inc.verification.join('; ')}`, '');
      }
    }
    if (Array.isArray(data.risks) && data.risks.length) {
      lines.push('', '## Risks', '');
      for (const risk of data.risks) lines.push(`- ${risk}`);
    }
    return lines.join('\n').trim() + '\n';
  }
  if (name === 'build-test') {
    const lines = ['# Build + test', '', `Status: **${data.status.toUpperCase()}**`, '', '| command | status | exit | duration ms |', '|---|---|---:|---:|'];
    for (const item of data.commands || []) lines.push(`| ${String(item.command).replace(/\|/g, '\\|')} | ${item.status} | ${item.exitCode ?? ''} | ${item.durationMs ?? ''} |`);
    if (data.tests) lines.push('', `Tests: ${data.tests.passed || 0} passed, ${data.tests.failed || 0} failed, ${data.tests.skipped || 0} skipped.`);
    return lines.join('\n').trim() + '\n';
  }
  if (name === 'review') {
    const lines = [`# Review — ${data.reviewer}`, '', `Status: **${data.status.toUpperCase()}**`, '', '| id | severity | resolved | finding | file |', '|---|---|---|---|---|'];
    for (const f of data.findings || []) lines.push(`| ${f.id} | ${f.severity} | ${f.resolved === true ? 'yes' : f.resolved === false ? 'no' : ''} | ${String(f.summary || '').replace(/\|/g, '\\|')} | ${f.file || ''} |`);
    return lines.join('\n').trim() + '\n';
  }
  if (name === 'behavior-equivalence') {
    const lines=['# Behavior equivalence verification','',`Status: **${data.status.toUpperCase()}**`,'',`Fully verified: **${data.fullyVerified?'yes':'no'}**`,'','## Verified behaviors',''];
    for(const x of data.verifiedBehaviors||[])lines.push('- '+x);
    lines.push('','## Intentional changes','');for(const x of data.intentionalChanges||[])lines.push('- '+x);
    lines.push('','## Unexpected changes','');for(const x of data.unexpectedChanges||[])lines.push('- '+x);
    lines.push('','## Contract changes','');for(const x of data.contractChanges||[])lines.push('- '+x);
    lines.push('','## Test layers','');for(const x of data.testLayers||[])lines.push(`- ${x.layer}: ${x.status} — ${(x.evidence||[]).join('; ')}`);
    lines.push('','## Unverified scenarios','');if(!(data.unverifiedScenarios||[]).length)lines.push('- None');else for(const x of data.unverifiedScenarios)lines.push('- '+x);
    return lines.join('\n').trim()+'\n';
  }
  if (name === 'subagent-findings') {
    const lines = [`# Subagent findings — ${data.agent}`, '', `Status: **${data.status.toUpperCase()}**`, '', '| id | severity | uncertainty | confidence | finding | evidence |', '|---|---|---|---:|---|---|'];
    for (const f of Array.isArray(data.findings) ? data.findings : []) {
      const evidence = (Array.isArray(f.evidence) ? f.evidence : []).map(e => `${e.source}${e.line ? ':' + e.line : ''} — ${e.detail}`).join('<br>').replace(/\|/g, '\\|');
      lines.push(`| ${f.id} | ${f.severity} | ${f.uncertainty} | ${f.confidence} | ${String(f.title || '').replace(/\|/g, '\\|')} | ${evidence} |`);
    }
    return lines.join('\n').trim() + '\n';
  }
  if (name === 'verification') {
    const lines = ['# Final verification', '', `Status: **${data.status.toUpperCase()}**`, '', '## Acceptance criteria', '', '| AC | status | evidence |', '|---|---|---|'];
    for (const ac of data.acceptanceCriteria || []) lines.push(`| ${ac.id} | ${ac.status} | ${(ac.evidence || []).join('<br>')} |`);
    lines.push('', '## Definition of Done', '');
    for (const item of data.definitionOfDone || []) lines.push(`- [${item.status === 'pass' || item.status === 'not-applicable' ? 'x' : ' '}] ${item.item} — ${item.status}`);
    if (data.mobileEvidence) lines.push('', '## Mobile evidence', '', `Attestation: ${data.mobileEvidence.attestation || data.mobileEvidence.path || 'recorded'}`);
    return lines.join('\n').trim() + '\n';
  }
  throw new Error(`no Markdown renderer for schema ${name}`);
}

function validateArtifactData(name, data, expectedRunId, options = {}) {
  const errors = validate(name, data);
  if (expectedRunId && data.runId !== expectedRunId) errors.push(`$.runId: expected ${expectedRunId}, got ${data.runId || '(missing)'}`);
  if (options.semantic !== false) {
    const semantic = semanticProblems(name, data);
    if (!Array.isArray(semantic)) throw new Error(`${name}: semanticProblems must return an array of error strings, got ${typeof semantic}`);
    errors.push(...semantic);
  }
  return errors;
}

function validateArtifactFile(name, file, expectedRunId, options = {}) {
  if (!fs.existsSync(file)) return [`${file}: missing structured artifact`];
  let data;
  try { data = load(file); } catch (e) { return [`${file}: invalid JSON (${e.message})`]; }
  return validateArtifactData(name, data, expectedRunId, options);
}

function materialize(name, rawText, jsonFile, markdownFile, expectedRunId) {
  let data;
  try { data = parseJsonText(rawText); } catch (e) { throw new Error(`${name} output is not valid JSON: ${e.message}`); }
  const errors = validateArtifactData(name, data, expectedRunId);
  if (errors.length) throw new Error(`${name} structured artifact rejected:\n- ${errors.join('\n- ')}`);
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
  fs.mkdirSync(path.dirname(markdownFile), { recursive: true });
  fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(markdownFile, renderMarkdown(name, data));
  return data;
}

function checkAllSchemas() {
  const files = fs.readdirSync(SCHEMAS).filter(f => f.endsWith('.schema.json')).sort();
  const problems = [];
  for (const file of files) {
    const name = file.replace(/\.schema\.json$/, '');
    try { problems.push(...checkSchemaDefinition(name, load(path.join(SCHEMAS, file)))); }
    catch (e) { problems.push(`${name}: ${e.message}`); }
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    return 1;
  }
  console.log(`✓ ${files.length} workflow artifact schema(s) valid`);
  return 0;
}

function selftest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-artifacts-'));
  const json = path.join(temp, '06-plan.json');
  const md = path.join(temp, '06-plan.md');
  const plan = { schemaVersion: 1, runId: 'TEST', summary: 'Implement safely', steps: [{ id: '1', description: 'Change one file', files: ['src/a.js'] }], acceptanceCriteria: ['AC-1'] };
  materialize('plan', JSON.stringify(plan), json, md, 'TEST');
  assert.ok(fs.existsSync(json));
  assert.ok(fs.readFileSync(md, 'utf8').includes('Implement safely'));
  assert.deepStrictEqual(validateArtifactFile('plan', json, 'TEST'), []);
  assert.throws(() => materialize('plan', JSON.stringify({ ...plan, runId: 'OTHER' }), json, md, 'TEST'), /runId/);
  const verification = { schemaVersion: 1, runId: 'TEST', status: 'pass', acceptanceCriteria: [{ id: 'AC-1', status: 'pass', evidence: ['test output'] }], definitionOfDone: [{ item: 'tests', status: 'pass' }] };
  assert.deepStrictEqual(validateArtifactData('verification', verification, 'TEST'), []);
  assert.ok(validateArtifactData('verification', { ...verification, acceptanceCriteria: [{ id: 'AC-1', status: 'blocked', evidence: [] }] }, 'TEST').length > 0);

  const findingsJson = path.join(temp, '05-analysis', 'security.json');
  const findingsMd = path.join(temp, '05-analysis', 'security.md');
  const findings = { schemaVersion: 1, runId: 'TEST', agent: 'security', status: 'pass', findings: [{ id: 'F-1', title: 'Example finding', severity: 'low', uncertainty: 'confirmed', confidence: 0.9, evidence: [{ source: 'src/a.js', line: 3, detail: 'example' }], recommendation: 'fix it' }] };
  materialize('subagent-findings', JSON.stringify(findings), findingsJson, findingsMd, 'TEST');
  assert.deepStrictEqual(validateArtifactData('subagent-findings', findings, 'TEST'), []);
  assert.ok(fs.readFileSync(findingsMd, 'utf8').includes('Example finding'));

  fs.rmSync(temp, { recursive: true, force: true });
  console.log('structured artifact selftest OK');
}

function cli() {
  const [cmd, name, file] = process.argv.slice(2);
  try {
    if (cmd === 'check-schemas') process.exitCode = checkAllSchemas();
    else if (cmd === 'selftest') selftest();
    else if (cmd === 'validate') {
      if (!name || !file) throw new Error('usage: artifacts.js validate <schema-name> <json-file>');
      const errors = validateArtifactFile(name, path.resolve(file), null, { semantic: false });
      if (errors.length) { errors.forEach(e => console.error(`✗ ${e}`)); process.exitCode = 1; }
      else console.log(`✓ ${file} matches ${name}.schema.json`);
    } else throw new Error('usage: artifacts.js check-schemas | selftest | validate <schema-name> <json-file>');
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) cli();
module.exports = { validate, validateArtifactData, validateArtifactFile, materialize, renderMarkdown, sidecarForMarkdown, schemaContract, semanticProblems, checkSchemaDefinition, checkAllSchemas };
