#!/usr/bin/env node
'use strict';

/* Execute Appium evidence and bind it to a fresh runtime-owned attestation. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildAttestation } = require('./evidence-attestation');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PRODUCT_ROOT = process.env.AI_WORKFLOW_PRODUCT_ROOT ? path.resolve(process.env.AI_WORKFLOW_PRODUCT_ROOT) : ROOT;
const RUNS = path.join(ROOT, 'ai', 'runs');
const ACTIVE = path.join(RUNS, '_active');
const ROUTER = path.join(ROOT, 'ai', 'workflow', 'router.js');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function fail(message, code = 1) { console.error(`✗ ${message}`); process.exit(code); }
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
function activeId() { try { const id = fs.readFileSync(ACTIVE, 'utf8').trim(); return id && fs.existsSync(path.join(RUNS, id)) ? id : null; } catch { return null; } }
function runDir(id) { return path.join(RUNS, id); }
function stateFile(id) { return path.join(runDir(id), 'state.json'); }
function deviceDir(id) { return path.join(runDir(id), 'device'); }
function screenshotDir(id) { return path.join(deviceDir(id), 'screenshots'); }
function manifestFile(id) { return path.join(deviceDir(id), 'mobile-device-qc.md'); }
function sessionsFile(id) { return path.join(deviceDir(id), 'appium-sessions.json'); }
function contextFile(id) { return path.join(deviceDir(id), 'mobile-evidence-context.md'); }
function agentOutputFile(id) { return path.join(deviceDir(id), 'mobile-evidence-agent.md'); }
function loadState(id) { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { return null; } }
function saveState(id, state) { state.updatedAt = new Date().toISOString(); fs.writeFileSync(stateFile(id), JSON.stringify(state, null, 2) + '\n'); }
function evidenceState(state) { state.evidence ||= {}; state.evidence.mobileScreenshots ||= { requirement: 'unclassified' }; return state.evidence.mobileScreenshots; }
function phaseStatus(state, phase) { return state.phases?.[phase]?.status || 'pending'; }

function assertReadyForEvidence(state) {
  const requirements = [['implementation', new Set(['pass'])], ['build-test', new Set(['pass'])], ['reviews', new Set(['pass', 'skipped'])], ['fixes', new Set(['pass', 'skipped'])]];
  const problems = requirements.filter(([phase, allowed]) => !allowed.has(phaseStatus(state, phase))).map(([phase]) => `${phase}=${phaseStatus(state, phase)}`);
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
  if (fs.existsSync(path.join(PRODUCT_ROOT, 'android'))) fromRepo.push('android');
  if (fs.existsSync(path.join(PRODUCT_ROOT, 'ios'))) fromRepo.push('ios');
  return fromRepo;
}
function listImages(dir) { try { return fs.readdirSync(dir).filter(name => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())).sort(); } catch { return []; } }
function freshFiles(dir, startedMs) { return listImages(dir).filter(name => { try { return fs.statSync(path.join(dir, name)).mtimeMs >= startedMs - 1000; } catch { return false; } }); }
function freshFile(file, startedMs) { try { return fs.statSync(file).mtimeMs >= startedMs - 1000; } catch { return false; } }
function validateEvidence(id, platforms, startedMs) {
  const screenshots = freshFiles(screenshotDir(id), startedMs);
  const manifest = manifestFile(id);
  const errors = [];
  if (!freshFile(manifest, startedMs)) errors.push(`${manifest} was not created/updated by this attempt`);
  if (!screenshots.length) errors.push(`${screenshotDir(id)} has no fresh screenshot from this attempt`);
  let text = '';
  if (fs.existsSync(manifest)) {
    text = fs.readFileSync(manifest, 'utf8');
    if (!/##\s+Verdict[\s\S]{0,120}\bPASS\b/i.test(text)) errors.push('mobile-device-qc.md does not contain a PASS verdict');
  }
  for (const platform of platforms) {
    const label = platform === 'ios' ? 'iOS' : 'Android';
    if (!screenshots.some(name => name.toLowerCase().startsWith(`${platform}-`))) errors.push(`no fresh ${label} screenshot found; name evidence ${platform}-NN-<checkpoint>.png`);
    if (text && !new RegExp(`\\b${label}\\b`, 'i').test(text)) errors.push(`mobile-device-qc.md does not document ${label}`);
  }
  return { ok: errors.length === 0, errors, screenshots, manifest };
}
function readIfExists(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return '(not available)'; } }
function buildPrompt(id, platforms, attemptId) {
  const dir = runDir(id);
  const platformText = platforms.map(p => p === 'ios' ? 'iOS' : 'Android').join(' + ');
  return `# Mobile evidence execution — ${id}\n\nAttempt id: ${attemptId}\nProduct worktree: ${PRODUCT_ROOT}\n\n` +
    `This is an EXECUTION step. You MUST use the configured Appium MCP. Do not replace Appium with shell screenshots, mocked evidence, descriptions, or assumptions.\n\n` +
    `Target platform(s): ${platformText}\n\n` +
    `Required agent-produced outputs for THIS attempt (use these ABSOLUTE paths because product execution occurs in an isolated worktree):\n- ${manifestFile(id)}\n- ${sessionsFile(id)}\n- ${screenshotDir(id)}/*.png\n\n` +
    `appium-sessions.json MUST be JSON with {"attemptId":"${attemptId}","platforms":[...]}. Each platform entry MUST contain:\n` +
    `- platform: android or ios\n- the actual Appium sessionId\n- deviceId\n- appId (Android package / iOS bundle id)\n- appVersion\n- buildNumber\n- buildArtifact (existing APK/AAB/IPA/.app path for the exact build tested, resolved from ${PRODUCT_ROOT})\n- sessionStartedAt and sessionEndedAt ISO timestamps\n- flavor, scheme, environment when applicable\n\n` +
    `The runtime, not you, computes git/workspace identity from the product worktree, hashes the exact build artifact, manifest, and screenshots, and generates evidence.json after you return. Missing build/session identity BLOCKS verification.\n\n` +
    `Rules:\n1. Create/select an Appium session for each target platform and record its real session id.\n2. Use the final post-fix build from the product worktree and record the exact artifact path used to install/launch it.\n3. Execute the device-relevant acceptance criteria.\n4. Capture fresh screenshots with Appium directly into ${screenshotDir(id)} and prefix names with android- or ios-.\n5. Never fabricate a session id, build identity, screenshot, or PASS result.\n6. If Appium/device/build/data is unavailable, write BLOCKED evidence when possible and return failure.\n7. Do not edit product source, commit, push, deploy, or change workflow/guard files.\n8. Close/detach Appium sessions when finished and record the end timestamp.\n\n` +
    `## Acceptance criteria\n${readIfExists(path.join(dir, '02-acceptance-criteria.md'))}\n\n## Definition of Done\n${readIfExists(path.join(dir, '03-definition-of-done.md'))}\n\n## Build/test evidence\n${readIfExists(path.join(dir, '08-build-test.md'))}\n\n## Final fixes\n${readIfExists(path.join(dir, '10-fixes.md'))}\n`;
}
function markExecution(id, state, patch) { const evidence = evidenceState(state); evidence.execution = { ...(evidence.execution || {}), ...patch, updatedAt: new Date().toISOString() }; saveState(id, state); }

function runEvidence(id, args) {
  const state = loadState(id);
  if (!state) throw new Error(`no state.json for run ${id}`);
  const evidence = evidenceState(state);
  if (evidence.requirement === 'not-required') { markExecution(id, state, { status: 'skipped', reason: evidence.reason || 'explicitly not required' }); console.log(`✓ ${id}: mobile evidence skipped — ${evidence.reason || 'not required'}`); return 0; }
  if (evidence.requirement !== 'required') throw new Error(`mobile evidence is ${evidence.requirement || 'unclassified'}; classify it before verification`);
  assertReadyForEvidence(state);
  const platforms = targetPlatforms(state, args.platforms);
  if (!platforms.length) throw new Error('mobile evidence is required but no Android/iOS target could be derived; use --platforms android,ios (or one platform)');

  fs.mkdirSync(screenshotDir(id), { recursive: true });
  const started = new Date();
  const startedMs = started.getTime();
  const attemptId = `${id}-${started.toISOString().replace(/[:.]/g, '-')}`;
  evidence.platforms = platforms;
  markExecution(id, state, { attemptId, status: args['dry-run'] ? 'dry-run' : 'in_progress', startedAt: started.toISOString(), platforms, role: 'mobile-evidence', executor: 'claude', productRoot: PRODUCT_ROOT });
  fs.writeFileSync(contextFile(id), buildPrompt(id, platforms, attemptId));

  if (args['dry-run']) {
    console.log(`mobile-evidence dry run for ${id}`);
    console.log(`attempt: ${attemptId}`);
    console.log(`platforms: ${platforms.join(', ')}`);
    console.log(`product worktree: ${PRODUCT_ROOT}`);
    console.log(`required sessions: ${sessionsFile(id)}`);
    console.log(`runtime attestation: ${path.join(deviceDir(id), 'evidence.json')}`);
    return 0;
  }

  const child = spawnSync(process.execPath, [ROUTER, 'exec', 'feature', 'mobile-evidence', '--prompt-file', contextFile(id), '--output-file', agentOutputFile(id), '--cwd', PRODUCT_ROOT, '--timeout-min', String(Number(args['timeout-min']) || 30)], {
    cwd: ROOT,
    env: { ...process.env, AI_AGENTIC_WORKFLOW: '1', AI_WORKFLOW: 'feature', AI_WORKFLOW_ROLE: 'mobile-evidence', FEATURE_RUN_ID: id, FEATURE_EVIDENCE_ATTEMPT_ID: attemptId, AI_WORKFLOW_PRODUCT_ROOT: PRODUCT_ROOT, AI_WORKFLOW_RUNTIME_ROOT: ROOT },
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error || child.status !== 0) {
    markExecution(id, state, { status: 'blocked', completedAt: new Date().toISOString(), exitStatus: typeof child.status === 'number' ? child.status : null, error: child.error ? child.error.message : 'mobile-evidence role exited non-zero' });
    throw new Error(child.error ? child.error.message : `mobile-evidence role failed with exit ${child.status}`);
  }

  const result = validateEvidence(id, platforms, startedMs);
  if (!result.ok) {
    markExecution(id, state, { status: 'blocked', completedAt: new Date().toISOString(), exitStatus: 0, validationErrors: result.errors, freshScreenshots: result.screenshots });
    throw new Error(`Appium execution returned, but evidence validation failed:\n- ${result.errors.join('\n- ')}`);
  }

  let attestation;
  try { attestation = buildAttestation({ runId: id, attemptId, platforms, startedMs, deviceDir: deviceDir(id), screenshotDir: screenshotDir(id), manifestFile: manifestFile(id), sessionsFile: sessionsFile(id) }); }
  catch (e) {
    markExecution(id, state, { status: 'blocked', completedAt: new Date().toISOString(), exitStatus: 0, attestationError: e.message });
    throw new Error(`Appium evidence exists but attestation failed: ${e.message}`);
  }

  markExecution(id, state, {
    status: 'pass', completedAt: new Date().toISOString(), exitStatus: 0,
    manifest: `ai/runs/${id}/device/mobile-device-qc.md`, sessions: `ai/runs/${id}/device/appium-sessions.json`, attestation: `ai/runs/${id}/device/evidence.json`,
    gitSha: attestation.evidence.gitSha, workspaceFingerprint: attestation.evidence.workspaceFingerprint,
    builds: attestation.evidence.platforms.map(p => ({ platform: p.platform, appId: p.appId, appVersion: p.appVersion, buildNumber: p.buildNumber, path: p.buildArtifact.path, sha256: p.buildArtifact.sha256 })),
    screenshots: result.screenshots.map(name => `ai/runs/${id}/device/screenshots/${name}`), productRoot: PRODUCT_ROOT,
  });
  console.log(`✓ ${id}: Appium mobile evidence attested for ${platforms.join(', ')}`);
  console.log(`  evidence: ai/runs/${id}/device/evidence.json`);
  return 0;
}

function selftest() {
  const roleState = { selectedRoles: { analysis: ['architect', 'android'] }, evidence: { mobileScreenshots: {} } };
  assert.deepStrictEqual(targetPlatforms(roleState), ['android']);
  assert.deepStrictEqual(normalizePlatforms('android,ios'), ['android', 'ios']);
  assert.throws(() => normalizePlatforms('windows'), /unsupported/);
  assert.throws(() => assertReadyForEvidence({ phases: {} }), /implementation=pending/);
  assert.doesNotThrow(() => assertReadyForEvidence({ phases: { implementation: { status: 'pass' }, 'build-test': { status: 'pass' }, reviews: { status: 'pass' }, fixes: { status: 'skipped' } } }));
  const prompt = buildPrompt('TEST', ['android'], 'ATTEMPT');
  assert.match(prompt, /ABSOLUTE paths/);
  assert.match(prompt, /buildArtifact/);
  assert.match(prompt, /sessionStartedAt/);
  console.log('mobile-evidence.js selftest OK');
}

const args = parseArgs(process.argv.slice(2));
const [cmd, idArg] = args._;
try {
  if (cmd === 'selftest') selftest();
  else if (cmd === 'run') { const id = args.run || idArg || process.env.FEATURE_RUN_ID || activeId(); if (!id) throw new Error('no run id; use run <id> or --run <id>'); process.exitCode = runEvidence(id, args); }
  else fail('usage: mobile-evidence.js run [run-id] [--run id] [--platforms android,ios] [--timeout-min 30] [--dry-run] | selftest');
} catch (error) { fail(error.message); }
