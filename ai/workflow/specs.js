#!/usr/bin/env node
'use strict';

/*
 * ai/workflow/specs.js
 *
 * Run artifacts live in .agentic-runs/<id>/ and are gitignored, so every run
 * re-derives the requirements, acceptance criteria and definition of done from
 * scratch and nothing accumulates. This publishes the spec of a completed run
 * into the product repository, where it is committed with the change, and reads
 * the published specs back so later runs build on them instead of starting over.
 *
 * Publishing happens after verification passes, never before: writing into the
 * worktree earlier would land in the run's own diff and make "did the agent
 * change anything?" answer yes for a run that wrote no product code.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SPEC_FILES = [
  { from: '01-requirements.md', to: 'requirements.md' },
  { from: '02-acceptance-criteria.md', to: 'acceptance-criteria.md' },
  { from: '03-definition-of-done.md', to: 'definition-of-done.md' },
];
const DEFAULT_DIR = 'specs';

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

// `specs:` in .agentic/config.yaml. Off unless a project asks for it, because
// publishing writes files into that project's repository.
function specsSettings(projectRoot) {
  const file = path.join(projectRoot, '.agentic', 'config.yaml');
  if (!fs.existsSync(file)) return { enabled: false, dir: DEFAULT_DIR };
  let data = null;
  try { data = yaml.load(fs.readFileSync(file, 'utf8')) || {}; } catch { return { enabled: false, dir: DEFAULT_DIR }; }
  const spec = data.specs;
  if (!spec || typeof spec !== 'object') return { enabled: false, dir: DEFAULT_DIR };
  return { enabled: spec.enabled === true, dir: String(spec.dir || DEFAULT_DIR).replace(/^\/+|\/+$/g, '') || DEFAULT_DIR };
}

function safeId(id) {
  const value = String(id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value)) throw new Error(`invalid spec id "${id}"`);
  return value;
}

function specDir(root, dir, id) {
  const target = path.join(root, dir, safeId(id));
  // A spec is written into the project, so it must stay inside the configured
  // directory whatever the id looks like.
  if (path.relative(path.join(root, dir), target).startsWith('..')) throw new Error('spec path escapes the specs directory');
  return target;
}

function firstHeading(text, fallback) {
  const line = String(text || '').split('\n').find(l => /^#\s+/.test(l));
  if (!line) return fallback;
  // Requirements artifacts title themselves with their own filename
  // ("# 01-requirements.md: FEAT-001, persist the counter"), which is noise in a
  // published spec index.
  return line.replace(/^#\s+/, '').replace(/^\d\d-[a-z-]+\.md\s*[:\u2014\u2013-]\s*/i, '').trim() || fallback;
}

// The spec of one completed run, written where it can be committed and read again.
function publishSpec({ runDir, projectRoot, targetRoot, id, dir = DEFAULT_DIR, request = null, runtimeVersion = null, now = new Date() }) {
  const root = targetRoot || projectRoot;
  const out = specDir(root, dir, id);
  const written = [];
  fs.mkdirSync(out, { recursive: true });
  let title = safeId(id);
  for (const file of SPEC_FILES) {
    const text = read(path.join(runDir, file.from));
    if (!text) continue;
    if (file.from === '01-requirements.md') title = firstHeading(text, title);
    fs.writeFileSync(path.join(out, file.to), text.endsWith('\n') ? text : `${text}\n`);
    written.push(path.join(dir, safeId(id), file.to));
  }
  if (!written.length) throw new Error(`run ${id} has no spec artifacts to publish`);
  const index = [
    `# ${title}`,
    '',
    `- id: ${safeId(id)}`,
    `- published: ${now.toISOString()}`,
    runtimeVersion ? `- runtime: ${runtimeVersion}` : null,
    '',
    request ? `## Request\n\n${String(request).trim()}\n` : null,
    '## Contents',
    '',
    ...written.map(w => `- [${path.basename(w)}](${path.basename(w)})`),
    '',
    'Published by the agentic workflow after verification passed. Later runs read',
    'these files as existing specification context, so a change to this capability',
    'starts from what was already agreed rather than re-deriving it.',
    '',
  ].filter(x => x !== null).join('\n');
  fs.writeFileSync(path.join(out, 'README.md'), index);
  written.unshift(path.join(dir, safeId(id), 'README.md'));
  return { dir: path.join(dir, safeId(id)), files: written, title };
}

function listSpecs(root, dir = DEFAULT_DIR) {
  const base = path.join(root, dir);
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; }
  return entries.map(id => {
    const readme = read(path.join(base, id, 'README.md'));
    return {
      id,
      title: firstHeading(readme, id),
      files: SPEC_FILES.map(f => f.to).filter(f => fs.existsSync(path.join(base, id, f))),
    };
  }).filter(s => s.files.length);
}

// What a role sees: every published spec, trimmed, so it can build on an agreed
// specification instead of inventing a new one for the same capability.
function specsContext(root, dir = DEFAULT_DIR, { maxPerFile = 8000 } = {}) {
  const specs = listSpecs(root, dir);
  if (!specs.length) return '';
  const sections = [`## Existing specifications (${dir}/)`, '', 'These are committed specs from earlier runs. Reuse and extend them; do not', 'restate or contradict an agreed acceptance criterion without saying why.', ''];
  for (const spec of specs) {
    sections.push(`### ${spec.id} — ${spec.title}`);
    for (const file of spec.files) {
      const text = read(path.join(root, dir, spec.id, file));
      if (text) sections.push(`#### ${spec.id}/${file}`, text.slice(0, maxPerFile).trim(), '');
    }
  }
  return sections.join('\n');
}

function selftest() {
  const assert = require('assert');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specs-'));
  const runDir = path.join(tmp, 'run');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(project, '.agentic'), { recursive: true });

  // Off unless the project asks for it.
  assert.strictEqual(specsSettings(project).enabled, false, 'publishing is opt-in');
  fs.writeFileSync(path.join(project, '.agentic', 'config.yaml'), 'version: 1\nspecs:\n  enabled: true\n');
  assert.deepStrictEqual(specsSettings(project), { enabled: true, dir: 'specs' });
  fs.writeFileSync(path.join(project, '.agentic', 'config.yaml'), 'version: 1\nspecs:\n  enabled: true\n  dir: docs/specs\n');
  assert.strictEqual(specsSettings(project).dir, 'docs/specs');

  fs.writeFileSync(path.join(runDir, '01-requirements.md'), '# 01-requirements.md: FEAT-001, persist the counter\n\n- FR-1 store it\n');
  fs.writeFileSync(path.join(runDir, '02-acceptance-criteria.md'), '# Acceptance criteria\n\n## AC-1\n\nIt persists.\n');
  fs.writeFileSync(path.join(runDir, '03-definition-of-done.md'), '# Definition of done\n\n- D1 tests pass\n');

  const published = publishSpec({ runDir, projectRoot: project, id: 'FEAT-001', request: 'persist the counter' });
  assert.strictEqual(published.title, 'FEAT-001, persist the counter', 'the artifact filename is stripped from the spec title');
  // Artifacts title themselves with a colon or a dash; both are noise.
  assert.strictEqual(firstHeading('# 01-requirements.md \u2014 ARCH-001', 'x'), 'ARCH-001');
  assert.strictEqual(firstHeading('# 03-definition-of-done.md: REF-001 done', 'x'), 'REF-001 done');
  assert.strictEqual(firstHeading('# A real title', 'x'), 'A real title', 'an ordinary heading is untouched');
  assert.ok(fs.existsSync(path.join(project, 'specs', 'FEAT-001', 'requirements.md')));
  assert.ok(fs.existsSync(path.join(project, 'specs', 'FEAT-001', 'acceptance-criteria.md')));
  assert.ok(fs.existsSync(path.join(project, 'specs', 'FEAT-001', 'definition-of-done.md')));
  assert.match(read(path.join(project, 'specs', 'FEAT-001', 'README.md')), /persist the counter/);

  // Read back.
  const listed = listSpecs(project);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].id, 'FEAT-001');
  assert.strictEqual(listed[0].files.length, 3);
  const ctx = specsContext(project);
  assert.match(ctx, /Existing specifications/);
  assert.match(ctx, /AC-1/, 'the acceptance criteria reach the role context');
  assert.strictEqual(specsContext(path.join(tmp, 'empty-project')), '', 'no specs means no context section');

  // A run with nothing to publish is an error, not a silent empty spec.
  const bare = path.join(tmp, 'bare');
  fs.mkdirSync(bare, { recursive: true });
  assert.throws(() => publishSpec({ runDir: bare, projectRoot: project, id: 'FEAT-002' }), /no spec artifacts/);
  // Ids are constrained, so a spec cannot be written outside the specs directory.
  assert.throws(() => publishSpec({ runDir, projectRoot: project, id: '../escape' }), /invalid spec id/);
  assert.throws(() => publishSpec({ runDir, projectRoot: project, id: 'a/b' }), /invalid spec id/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('specs selftest OK');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) selftest();
  else { console.error('usage: specs.js --selftest'); process.exitCode = 1; }
}

module.exports = { specsSettings, publishSpec, listSpecs, specsContext, SPEC_FILES, DEFAULT_DIR };
