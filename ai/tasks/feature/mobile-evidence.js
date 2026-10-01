#!/usr/bin/env node
'use strict';

/* Execute Appium evidence and bind it to a fresh runtime-owned attestation. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildAttestation } = require('./evidence-attestation');
const { runtimeRoot, projectRoot, stateRoot, relativeStatePath } = require('../../workflow/paths');
const { loadWorkflow } = require('../../workflow/router');
const { resolveExecutionPolicy, classifyFailure, executeWithPolicy } = require('../../workflow/execution-policy');

const ROOT = runtimeRoot();
const PROJECT_ROOT = projectRoot();
const PRODUCT_ROOT = process.env.AI_WORKFLOW_PRODUCT_ROOT ? path.resolve(process.env.AI_WORKFLOW_PRODUCT_ROOT) : PROJECT_ROOT;
const RUNS = stateRoot();
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
    `You do NOT write any evidence file yourself, and you have no permission to. The runtime writes all of them:\n` +
    `- screenshots: run this for every capture, which writes ${screenshotDir(id)}/<platform>-<name>.png for you:\n` +
    `    node ${__filename} capture ${id} --platform <android|ios> --name <NN-checkpoint> [--udid <device>]\n` +
    `- your QC report: return it as your response. The runtime saves it as ${manifestFile(id)}.\n` +
    `- session identity: include it as a single fenced \`\`\`json block in that response. The runtime saves it as ${sessionsFile(id)}.\n\n` +
    `appium-sessions.json MUST be JSON with {"attemptId":"${attemptId}","platforms":[...]}. Each platform entry MUST contain:\n` +
    `- platform: android or ios\n- the actual Appium sessionId\n- deviceId\n- appId (Android package / iOS bundle id)\n- appVersion\n- buildNumber\n- buildArtifact (existing APK/AAB/IPA/.app path for the exact build tested, resolved from ${PRODUCT_ROOT})\n- sessionStartedAt and sessionEndedAt ISO timestamps\n- flavor, scheme, environment when applicable\n\n` +
    `The runtime, not you, computes git/workspace identity from the product worktree, hashes the exact build artifact, manifest, and screenshots, and generates evidence.json after you return. Missing build/session identity BLOCKS verification.\n\n` +
    `Rules:\n1. Create/select an Appium session for each target platform and record its real session id.\n2. Use the final post-fix build from the product worktree and record the exact artifact path used to install/launch it.\n3. Execute the device-relevant acceptance criteria.\n4. Capture fresh screenshots by running the capture command above once per checkpoint, after driving the app there with Appium. Name them NN-checkpoint, e.g. 01-launch.\n5. Never fabricate a session id, build identity, screenshot, or PASS result.\n6. If Appium, the device, or the build is unavailable, return a report whose Verdict section says BLOCKED and explains why. The runtime records it; do not try to write it yourself.\n7. You may build the app under test (flutter build, gradlew, xcodebuild) because device QC needs an installable artifact. Do not edit product source, commit, push, deploy, or change workflow/guard files.\n8. Close/detach Appium sessions when finished and record the end timestamp.\n\n` +
    `## Acceptance criteria\n${readIfExists(path.join(dir, '02-acceptance-criteria.md'))}\n\n## Definition of Done\n${readIfExists(path.join(dir, '03-definition-of-done.md'))}\n\n## Build/test evidence\n${readIfExists(path.join(dir, '08-build-test.md'))}\n\n## Final fixes\n${readIfExists(path.join(dir, '10-fixes.md'))}\n`;
}
// The mobile-evidence role is read_only, so it cannot write a single byte of
// its own evidence: the guard denies Write for any role without product_write,
// and there is no carve-out for the run's own state directory. The role whose
// declared output IS device_evidence could therefore never produce it, and the
// validation below failed every attempt. The runtime owns the writes instead —
// the agent drives the app and asks for a capture, and nothing it returns can
// put a file on disk by itself.
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/i;
function screenshotPath(id, platform, name) {
  if (!['android', 'ios'].includes(platform)) throw new Error(`unsupported capture platform "${platform}"; use android or ios`);
  if (!SAFE_NAME.test(String(name || ''))) throw new Error(`invalid capture name "${name}"; use letters, digits and dashes, e.g. 01-launch`);
  const file = path.join(screenshotDir(id), `${platform}-${name}.png`);
  // A name that escapes the run's own screenshot directory is a write outside
  // the evidence boundary, which is the thing this design exists to prevent.
  if (path.dirname(path.resolve(file)) !== path.resolve(screenshotDir(id))) throw new Error('capture would write outside the run evidence directory');
  return file;
}
function captureScreenshot(id, args) {
  const state = loadState(id);
  if (!state) throw new Error(`no state.json for run ${id}`);
  const execution = state.evidence?.mobileScreenshots?.execution;
  if (execution?.status !== 'in_progress') throw new Error('capture is only allowed while a mobile-evidence attempt is in progress');
  const platform = String(args.platform || '').trim().toLowerCase();
  const file = screenshotPath(id, platform, args.name);
  fs.mkdirSync(screenshotDir(id), { recursive: true });
  let res;
  if (platform === 'android') {
    const device = args.device || args.udid;
    res = spawnSync('adb', [...(device ? ['-s', String(device)] : []), 'exec-out', 'screencap', '-p'], { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });
    if (res.error || res.status !== 0) throw new Error(`adb screencap failed: ${res.error ? res.error.message : String(res.stderr || '').trim() || `exit ${res.status}`}`);
    if (!res.stdout || !res.stdout.length) throw new Error('adb screencap produced no image');
    fs.writeFileSync(file, res.stdout);
  } else {
    const udid = args.udid || args.device || 'booted';
    res = spawnSync('xcrun', ['simctl', 'io', String(udid), 'screenshot', file], { encoding: 'utf8' });
    if (res.error || res.status !== 0) throw new Error(`simctl screenshot failed: ${res.error ? res.error.message : String(res.stderr || '').trim() || `exit ${res.status}`}`);
  }
  const bytes = fs.statSync(file).size;
  if (!bytes) throw new Error(`capture wrote an empty file: ${file}`);
  console.log(`✓ captured ${path.relative(PROJECT_ROOT, file)} (${bytes} bytes)`);
  return 0;
}
// The agent returns its QC report as its response, the way every other
// read_only role returns an artifact; the runtime is what puts it on disk.
function extractSessions(text) {
  const fenced = String(text || '').match(/```json\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const braced = String(text || '').match(/\{[\s\S]*"platforms"[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  for (const candidate of candidates) {
    try { const parsed = JSON.parse(candidate.trim()); if (parsed && typeof parsed === 'object') return parsed; } catch { /* try the next shape */ }
  }
  return null;
}
function writeAgentEvidence(id, attemptId, platforms) {
  const text = readIfExists(agentOutputFile(id));
  if (!text || text === '(not available)') throw new Error('the mobile-evidence role returned no report to record');
  fs.mkdirSync(deviceDir(id), { recursive: true });
  fs.writeFileSync(manifestFile(id), text.endsWith('\n') ? text : `${text}\n`);
  const sessions = extractSessions(text);
  if (sessions) fs.writeFileSync(sessionsFile(id), JSON.stringify({ attemptId, platforms, ...sessions }, null, 2) + '\n');
  return !!sessions;
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
  let started = new Date();
  let startedMs = started.getTime();
  let attemptId = `${id}-${started.toISOString().replace(/[:.]/g, '-')}`;
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

  // This stage used to spawn the role directly, so the retry/timeout/fallback
  // policy declared for mobile-evidence in the workflow was never applied: a
  // 30-minute timeout — explicitly listed in its retry_on — went straight to
  // blocked instead of taking its second attempt, and the timeout came from a
  // hardcoded default here rather than from the workflow at all.
  const { data: workflow } = loadWorkflow('feature');
  const stageDef = (workflow.stages || []).find(x => x.id === 'mobile-evidence') || { id: 'mobile-evidence' };
  const policy = resolveExecutionPolicy(workflow, stageDef, 'mobile-evidence');
  const overrideMin = Number(args['timeout-min']) || null;
  const outcome = executeWithPolicy(policy, [], ({ executor, attemptNumber, timeoutMs }) => {
    // Each attempt is its own evidence attempt: freshness and the attestation
    // are measured from when THIS attempt started, never an earlier one.
    if (attemptNumber > 1) {
      started = new Date(); startedMs = started.getTime();
      attemptId = `${id}-${started.toISOString().replace(/[:.]/g, '-')}`;
      markExecution(id, state, { attemptId, status: 'in_progress', startedAt: started.toISOString(), platforms, role: 'mobile-evidence', executor, productRoot: PRODUCT_ROOT });
      fs.writeFileSync(contextFile(id), buildPrompt(id, platforms, attemptId));
    }
    const minutes = overrideMin || Math.max(1, Math.ceil(timeoutMs / 60000));
    const child = spawnSync(process.execPath, [ROUTER, 'exec', 'feature', 'mobile-evidence', '--agent', executor, '--prompt-file', contextFile(id), '--output-file', agentOutputFile(id), '--cwd', PRODUCT_ROOT, '--timeout-min', String(minutes)], {
      cwd: ROOT,
      env: { ...process.env, AI_AGENTIC_WORKFLOW: '1', AI_WORKFLOW: 'feature', AI_WORKFLOW_ROLE: 'mobile-evidence', FEATURE_RUN_ID: id, FEATURE_EVIDENCE_ATTEMPT_ID: attemptId, AI_WORKFLOW_PRODUCT_ROOT: PRODUCT_ROOT, AI_WORKFLOW_PROJECT_ROOT: PROJECT_ROOT, AI_WORKFLOW_STATE_ROOT: RUNS, AI_WORKFLOW_RUNTIME_ROOT: ROOT },
      encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error || child.status !== 0) {
      const exitType = classifyFailure(child);
      const reason = child.error ? child.error.message : `mobile-evidence role exited ${child.status}`;
      return { ok: false, exitType, reason: `${exitType}: ${reason}`, attemptId };
    }
    return { ok: true, value: { executor }, attemptId };
  }, () => {});
  if (!outcome.ok) {
    const last = outcome.attempts?.[outcome.attempts.length - 1];
    markExecution(id, state, { status: 'blocked', completedAt: new Date().toISOString(), exitStatus: 1, attempts: outcome.attempts?.length || 1, error: outcome.reason || last?.reason || 'mobile-evidence role exited non-zero' });
    throw new Error(`mobile-evidence failed after ${outcome.attempts?.length || 1} attempt(s): ${outcome.reason || last?.reason || 'unknown'}`);
  }

  try { writeAgentEvidence(id, attemptId, platforms); }
  catch (e) {
    markExecution(id, state, { status: 'blocked', completedAt: new Date().toISOString(), exitStatus: 0, error: e.message });
    throw new Error(`mobile-evidence returned, but its report could not be recorded: ${e.message}`);
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
    manifest: relativeStatePath(id, 'device', 'mobile-device-qc.md'), sessions: relativeStatePath(id, 'device', 'appium-sessions.json'), attestation: relativeStatePath(id, 'device', 'evidence.json'),
    gitSha: attestation.evidence.gitSha, workspaceFingerprint: attestation.evidence.workspaceFingerprint,
    builds: attestation.evidence.platforms.map(p => ({ platform: p.platform, appId: p.appId, appVersion: p.appVersion, buildNumber: p.buildNumber, path: p.buildArtifact.path, sha256: p.buildArtifact.sha256 })),
    screenshots: result.screenshots.map(name => relativeStatePath(id, 'device', 'screenshots', name)), productRoot: PRODUCT_ROOT,
  });
  console.log(`✓ ${id}: Appium mobile evidence attested for ${platforms.join(', ')}`);
  console.log(`  evidence: ${relativeStatePath(id, 'device', 'evidence.json')}`);
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
  assert.match(prompt, /You do NOT write any evidence file yourself/);
  assert.match(prompt, /capture TEST --platform/);
  assert.match(prompt, /buildArtifact/);
  assert.match(prompt, /sessionStartedAt/);
  // The role is read_only, so a name that walks out of the evidence directory
  // must be refused rather than becoming a write anywhere on disk.
  assert.throws(() => screenshotPath('TEST', 'android', '../../escape'), /invalid capture name/);
  assert.throws(() => screenshotPath('TEST', 'android', 'a/b'), /invalid capture name/);
  assert.throws(() => screenshotPath('TEST', 'windows', '01-launch'), /unsupported capture platform/);
  assert.strictEqual(path.basename(screenshotPath('TEST', 'ios', '01-launch')), 'ios-01-launch.png');
  // Session identity is lifted out of the agent's report, not written by it.
  const report = '# QC\n\n## Verdict\n\nPASS on Android.\n\n```json\n{"platforms":[{"platform":"android","sessionId":"s1"}]}\n```\n';
  assert.strictEqual(extractSessions(report).platforms[0].sessionId, 's1');
  assert.strictEqual(extractSessions('no json here'), null);
  // The stage must honour the retry/timeout policy the workflow declares for
  // it. It used to spawn the role directly, so a timeout — which mobile-evidence
  // lists in retry_on — went straight to blocked with no second attempt.
  const { loadWorkflow: lw } = require('../../workflow/router');
  const { resolveExecutionPolicy: rep, canRetry } = require('../../workflow/execution-policy');
  const { data: wf } = lw('feature');
  const stageDef = (wf.stages || []).find(x => x.id === 'mobile-evidence') || { id: 'mobile-evidence' };
  const policy = rep(wf, stageDef, 'mobile-evidence');
  assert.ok(policy.maxAttempts >= 2, 'mobile-evidence keeps more than one attempt');
  assert.ok(policy.retryOn.includes('timeout'), 'a timed-out device run is retryable');
  assert.strictEqual(canRetry(policy, 'timeout', 1), true, 'the second attempt must be allowed after a timeout');
  assert.ok(policy.timeoutMs >= 60000, 'the timeout comes from the workflow, not a hardcoded default');
  console.log('mobile-evidence.js selftest OK');
}

const args = parseArgs(process.argv.slice(2));
const [cmd, idArg] = args._;
try {
  if (cmd === 'selftest') selftest();
  else if (cmd === 'run') { const id = args.run || idArg || process.env.FEATURE_RUN_ID || activeId(); if (!id) throw new Error('no run id; use run <id> or --run <id>'); process.exitCode = runEvidence(id, args); }
  else if (cmd === 'capture') { const id = args.run || idArg || process.env.FEATURE_RUN_ID || activeId(); if (!id) throw new Error('no run id; use capture <id> --platform <android|ios> --name <NN-checkpoint>'); process.exitCode = captureScreenshot(id, args); }
  else fail('usage: mobile-evidence.js run [run-id] [--run id] [--platforms android,ios] [--timeout-min 30] [--dry-run] | capture <run-id> --platform android|ios --name NN-checkpoint [--udid ID] | selftest');
} catch (error) { fail(error.message); }
