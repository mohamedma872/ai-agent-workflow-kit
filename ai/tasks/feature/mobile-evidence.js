#!/usr/bin/env node
'use strict';

/*
 * Execute the feature workflow's mobile-evidence role before final verification.
 *
 * Usage:
 *   node ai/tasks/feature/mobile-evidence.js run [run-id] [--platforms android,ios]
 *   node ai/tasks/feature/mobile-evidence.js run [run-id] --dry-run
 *   node ai/tasks/feature/mobile-evidence.js selftest
 *
 * For evidence-required runs this script:
 *   1. derives the Android/iOS targets,
 *   2. marks the evidence attempt in state.json,
 *   3. writes a focused prompt under ai/runs/<id>/device/,
 *   4. executes the routed `mobile-evidence` role through router.js,
 *   5. accepts only fresh Appium evidence from this attempt,
 *   6. requires device/mobile-device-qc.md + device/screenshots/*.png.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const ACTIVE = path.join(RUNS, '_active');
const ROUTER = path.join(ROOT, 'ai', 'workflow', 'router.js');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function fail(message, code = 1) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function activeId() {
  try {
    const id = fs.readFileSync(ACTIVE, 'utf8').trim();
    return id && fs.existsSync(path.join(RUNS, id)) ? id : null;
  } catch {
    return null;
  }
}

function runDir(id) { return path.join(RUNS, id); }
function stateFile(id) { return path.join(runDir(id), 'state.json'); }
function deviceDir(id) { return path.join(runDir(id), 'device'); }
function screenshotDir(id) { return path.join(deviceDir(id), 'screenshots'); }
function manifestFile(id) { return path.join(deviceDir(id), 'mobile-device-qc.md'); }
function contextFile(id) { return path.join(deviceDir(id), 'mobile-evidence-context.md'); }
function agentOutputFile(id) { return path.join(deviceDir(id), 'mobile-evidence-agent.md'); }

function loadState(id) {
  try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); }
  catch { return null; }
}

function saveState(id, state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(stateFile(id), JSON.stringify(state, null, 2) + '\n');
}

function evidenceState(state) {
  state.evidence ||= {};
  state.evidence.mobileScreenshots ||= { requirement: 'unclassified' };
  return state.evidence.mobileScreenshots;
}

function phaseStatus(state, phase) {
  return state.phases?.[phase]?.status || 'pending';
}

function assertReadyForEvidence(state) {
  const requirements = [
    ['implementation', new Set(['pass'])],
    ['build-test', new Set(['pass'])],
    ['reviews', new Set(['pass', 'skipped'])],
    ['fixes', new Set(['pass', 'skipped'])],
  ];
  const problems = requirements
    .filter(([phase, allowed]) => !allowed.has(phaseStatus(state, phase)))
    .map(([phase]) => `${phase}=${phaseStatus(state, phase)}`);
  if (problems.length) throw new Error(`mobile evidence cannot run before the post-fix build is ready: ${problems.join(', ')}`);
}

function normalizePlatforms(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  const platforms = [];
  for (const raw of items) {
    const p = String(raw).trim().toLowerCase();
    if (!p) continue;
    if (!['android', 'ios'].includes(p)) throw new Error(`unsupported mobile evidence platform "${p}"; use android and/or ios`);
    if (!platforms.includes(p)) platforms.push(p);
  }
  return platforms;
}

function targetPlatforms(state, override) {
  const explicit = normalizePlatforms(override || state.evidence?.mobileScreenshots?.platforms || []);
  if (explicit.length) return explicit;

  const selected = state.selectedRoles?.analysis || [];
  const fromRoles = ['android', 'ios'].filter(platform => selected.includes(platform));
  if (fromRoles.length) return fromRoles;

  const fromRepo = [];
  if (fs.existsSync(path.join(ROOT, 'android'))) fromRepo.push('android');
  if (fs.existsSync(path.join(ROOT, 'ios'))) fromRepo.push('ios');
  return fromRepo;
}

function listImages(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(name => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

function freshFiles(dir, startedMs) {
  return listImages(dir).filter(name => {
    try { return fs.statSync(path.join(dir, name)).mtimeMs >= startedMs - 1000; }
    catch { return false; }
  });
}

function freshFile(file, startedMs) {
  try { return fs.statSync(file).mtimeMs >= startedMs - 1000; }
  catch { return false; }
}

function validateEvidence(id, platforms, startedMs) {
  const screenshots = freshFiles(screenshotDir(id), startedMs);
  const manifest = manifestFile(id);
  const errors = [];

  if (!freshFile(manifest, startedMs)) {
    errors.push(`ai/runs/${id}/device/mobile-device-qc.md was not created/updated by this attempt`);
  }
  if (!screenshots.length) {
    errors.push(`ai/runs/${id}/device/screenshots/ has no fresh screenshot from this attempt`);
  }

  let text = '';
  if (fs.existsSync(manifest)) {
    text = fs.readFileSync(manifest, 'utf8');
    if (!/##\s+Verdict[\s\S]{0,120}\bPASS\b/i.test(text)) {
      errors.push('mobile-device-qc.md does not contain a PASS verdict');
    }
  }

  for (const platform of platforms) {
    const label = platform === 'ios' ? 'iOS' : 'Android';
    const hasPlatformScreenshot = screenshots.some(name => name.toLowerCase().startsWith(`${platform}-`));
    if (!hasPlatformScreenshot) {
      errors.push(`no fresh ${label} screenshot found; name evidence ${platform}-NN-<checkpoint>.png`);
    }
    if (text && !new RegExp(`\\b${platform === 'ios' ? 'iOS' : 'Android'}\\b`, 'i').test(text)) {
      errors.push(`mobile-device-qc.md does not document ${label}`);
    }
  }

  return { ok: errors.length === 0, errors, screenshots, manifest };
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return '(not available)'; }
}

function buildPrompt(id, platforms) {
  const dir = runDir(id);
  const platformText = platforms.map(p => p === 'ios' ? 'iOS' : 'Android').join(' + ');
  return `# Mobile evidence execution — ${id}\n\n` +
`This is an EXECUTION step, not an analysis step. You MUST use the configured Appium MCP to run the finished post-fix app. Do not replace Appium with shell screenshots, mocked evidence, descriptions, or assumptions.\n\n` +
`Read and follow .claude/skills/mobile-device-qc/SKILL.md.\n\n` +
`Target platform(s): ${platformText}\n\n` +
`Required outputs for THIS run:\n` +
`- ai/runs/${id}/device/mobile-device-qc.md\n` +
`- ai/runs/${id}/device/screenshots/*.png\n` +
`- screenshot names MUST start with the platform: android-01-..., ios-01-...\n` +
`- the manifest MUST document every target platform and end with ## Verdict = PASS only when every required platform/device flow passed\n\n` +
`Rules:\n` +
`1. Create/select an Appium session for each target platform.\n` +
`2. Use the final post-fix build, not an earlier build.\n` +
`3. Execute the device-relevant acceptance criteria.\n` +
`4. Capture fresh screenshots with Appium after important successful checkpoints and required negative states.\n` +
`5. Save/copy only screenshots produced by this attempt into ai/runs/${id}/device/screenshots/.\n` +
`6. If Appium, a simulator/emulator/device, the app build, credentials, or required data are unavailable, write a BLOCKED manifest when possible and return failure. Never fabricate PASS evidence.\n` +
`7. Do not edit product source, commit, push, deploy, or change workflow/guard files.\n` +
`8. Close/detach every Appium session when finished.\n\n` +
`## Acceptance criteria\n${readIfExists(path.join(dir, '02-acceptance-criteria.md'))}\n\n` +
`## Definition of Done\n${readIfExists(path.join(dir, '03-definition-of-done.md'))}\n\n` +
`## Build/test evidence\n${readIfExists(path.join(dir, '08-build-test.md'))}\n\n` +
`## Final fixes\n${readIfExists(path.join(dir, '10-fixes.md'))}\n`;
}

function markExecution(id, state, patch) {
  const evidence = evidenceState(state);
  evidence.execution = {
    ...(evidence.execution || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveState(id, state);
}

function runEvidence(id, args) {
  const state = loadState(id);
  if (!state) throw new Error(`no state.json for run ${id}`);
  const evidence = evidenceState(state);

  if (evidence.requirement === 'not-required') {
    markExecution(id, state, { status: 'skipped', reason: evidence.reason || 'explicitly not required' });
    console.log(`✓ ${id}: mobile evidence skipped — ${evidence.reason || 'not required'}`);
    return 0;
  }
  if (evidence.requirement !== 'required') {
    throw new Error(`mobile evidence is ${evidence.requirement || 'unclassified'}; classify it before verification`);
  }

  assertReadyForEvidence(state);
  const platforms = targetPlatforms(state, args.platforms);
  if (!platforms.length) {
    throw new Error('mobile evidence is required but no Android/iOS target could be derived; use --platforms android,ios (or one platform)');
  }

  fs.mkdirSync(screenshotDir(id), { recursive: true });
  const started = new Date();
  const startedMs = started.getTime();
  const attemptId = `${id}-${started.toISOString().replace(/[:.]/g, '-')}`;
  evidence.platforms = platforms;
  markExecution(id, state, {
    attemptId,
    status: args['dry-run'] ? 'dry-run' : 'in_progress',
    startedAt: started.toISOString(),
    platforms,
    role: 'mobile-evidence',
    executor: 'claude',
  });

  const prompt = buildPrompt(id, platforms);
  fs.writeFileSync(contextFile(id), prompt);

  if (args['dry-run']) {
    console.log(`mobile-evidence dry run for ${id}`);
    console.log(`platforms: ${platforms.join(', ')}`);
    console.log(`prompt: ${path.relative(ROOT, contextFile(id))}`);
    console.log(`required manifest: ai/runs/${id}/device/mobile-device-qc.md`);
    console.log(`required screenshots: ai/runs/${id}/device/screenshots/*.png`);
    return 0;
  }

  const child = spawnSync(process.execPath, [
    ROUTER,
    'exec', 'feature', 'mobile-evidence',
    '--prompt-file', contextFile(id),
    '--output-file', agentOutputFile(id),
    '--timeout-min', String(Number(args['timeout-min']) || 30),
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      AI_AGENTIC_WORKFLOW: '1',
      AI_WORKFLOW: 'feature',
      AI_WORKFLOW_ROLE: 'mobile-evidence',
      FEATURE_RUN_ID: id,
    },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });

  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);

  if (child.error || child.status !== 0) {
    markExecution(id, state, {
      status: 'blocked',
      completedAt: new Date().toISOString(),
      exitStatus: typeof child.status === 'number' ? child.status : null,
      error: child.error ? child.error.message : 'mobile-evidence role exited non-zero',
    });
    throw new Error(child.error ? child.error.message : `mobile-evidence role failed with exit ${child.status}`);
  }

  const result = validateEvidence(id, platforms, startedMs);
  if (!result.ok) {
    markExecution(id, state, {
      status: 'blocked',
      completedAt: new Date().toISOString(),
      exitStatus: 0,
      validationErrors: result.errors,
      freshScreenshots: result.screenshots,
    });
    throw new Error(`Appium execution returned, but evidence validation failed:\n- ${result.errors.join('\n- ')}`);
  }

  markExecution(id, state, {
    status: 'pass',
    completedAt: new Date().toISOString(),
    exitStatus: 0,
    manifest: `ai/runs/${id}/device/mobile-device-qc.md`,
    screenshots: result.screenshots.map(name => `ai/runs/${id}/device/screenshots/${name}`),
  });

  console.log(`✓ ${id}: Appium mobile evidence passed for ${platforms.join(', ')}`);
  console.log(`  manifest: ai/runs/${id}/device/mobile-device-qc.md`);
  for (const name of result.screenshots) console.log(`  screenshot: ai/runs/${id}/device/screenshots/${name}`);
  return 0;
}

function selftest() {
  const roleState = { selectedRoles: { analysis: ['architect', 'android'] }, evidence: { mobileScreenshots: {} } };
  assert.deepStrictEqual(targetPlatforms(roleState), ['android']);
  assert.deepStrictEqual(normalizePlatforms('android,ios'), ['android', 'ios']);
  assert.throws(() => normalizePlatforms('windows'), /unsupported/);
  assert.throws(() => assertReadyForEvidence({ phases: {} }), /implementation=pending/);
  assert.doesNotThrow(() => assertReadyForEvidence({ phases: {
    implementation: { status: 'pass' },
    'build-test': { status: 'pass' },
    reviews: { status: 'pass' },
    fixes: { status: 'skipped' },
  } }));
  console.log('mobile-evidence.js selftest OK');
}

const args = parseArgs(process.argv.slice(2));
const [cmd, idArg] = args._;

try {
  if (cmd === 'selftest') {
    selftest();
  } else if (cmd === 'run') {
    const id = idArg || activeId();
    if (!id) throw new Error('no run id and no active /feature run');
    process.exitCode = runEvidence(id, args);
  } else {
    fail('usage: mobile-evidence.js run [run-id] [--platforms android,ios] [--timeout-min 30] [--dry-run] | selftest');
  }
} catch (error) {
  fail(error.message);
}
