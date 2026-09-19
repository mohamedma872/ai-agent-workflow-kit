#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildAttestation,
  validateAttestation,
  sha256,
  hashPath,
  gitSha,
  workspaceFingerprint,
  loadSessions,
} = require('./evidence-attestation');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const runId = `__EVIDENCE-SELFTEST-${process.pid}`;
const run = path.join(ROOT, 'ai', 'runs', runId);
const device = path.join(run, 'device');
const shots = path.join(device, 'screenshots');
const buildDir = path.join(run, 'build');
const iosApp = path.join(buildDir, 'Test.app');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(iosApp, { recursive: true });

try {
  const startedMs = Date.now() - 100;
  const startedIso = new Date(startedMs + 10).toISOString();
  const endedIso = new Date(startedMs + 50).toISOString();
  const manifest = path.join(device, 'mobile-device-qc.md');
  const sessions = path.join(device, 'appium-sessions.json');
  const androidShot = path.join(shots, 'android-01-launch.png');
  const iosShot = path.join(shots, 'ios-01-launch.png');
  const apk = path.join(buildDir, 'app-debug.apk');
  const iosBinary = path.join(iosApp, 'Test');

  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(manifest, '# QC\n\n## Android\nPASS\n\n## iOS\nPASS\n\n## Verdict\nPASS\n');
  fs.writeFileSync(androidShot, 'android-fresh-screenshot');
  fs.writeFileSync(iosShot, 'ios-fresh-screenshot');
  fs.writeFileSync(apk, 'android-build-v1');
  fs.writeFileSync(iosBinary, 'ios-build-v1');
  fs.writeFileSync(path.join(iosApp, 'Info.plist'), 'plist-v1');

  const sessionPayload = {
    attemptId: 'ATTEMPT-1',
    platforms: [
      {
        platform: 'android',
        sessionId: 'session-android-123',
        deviceId: 'emulator-5554',
        appId: 'com.example.test',
        appVersion: '1.2.3',
        buildNumber: '42',
        buildArtifact: path.relative(ROOT, apk),
        environment: 'test',
        sessionStartedAt: startedIso,
        sessionEndedAt: endedIso,
      },
      {
        platform: 'ios',
        sessionId: 'session-ios-123',
        deviceId: 'SIM-UDID',
        appId: 'com.example.test',
        appVersion: '1.2.3',
        buildNumber: '43',
        buildArtifact: path.relative(ROOT, iosApp),
        scheme: 'Test',
        environment: 'test',
        sessionStartedAt: startedIso,
        sessionEndedAt: endedIso,
      },
    ],
  };
  fs.writeFileSync(sessions, JSON.stringify(sessionPayload, null, 2));

  const parsed = loadSessions(sessions, 'ATTEMPT-1', ['android', 'ios'], startedMs);
  assert.strictEqual(parsed.platforms[0].sessionId, 'session-android-123');
  assert.strictEqual(sha256(androidShot).length, 64);
  assert.strictEqual(hashPath(apk).length, 64);
  assert.strictEqual(hashPath(iosApp).length, 64);

  const result = buildAttestation({
    runId,
    attemptId: 'ATTEMPT-1',
    platforms: ['android', 'ios'],
    startedMs,
    deviceDir: device,
    screenshotDir: shots,
    manifestFile: manifest,
    sessionsFile: sessions,
  });
  assert.ok(fs.existsSync(result.output));
  assert.strictEqual(result.evidence.generatedBy, 'ai-agent-workflow-runtime');
  assert.strictEqual(result.evidence.platforms.length, 2);
  assert.strictEqual(result.evidence.platforms[0].buildArtifact.sha256.length, 64);
  assert.strictEqual(result.evidence.platforms[1].buildArtifact.kind, 'directory');
  assert.strictEqual(result.evidence.platforms[0].appId, 'com.example.test');

  const expected = {
    runId,
    attemptId: 'ATTEMPT-1',
    platforms: ['android', 'ios'],
    gitSha: gitSha(),
    workspaceFingerprint: workspaceFingerprint(),
  };
  assert.deepStrictEqual(validateAttestation(result.output, expected), []);

  // A copied/tampered screenshot cannot keep a passing attestation.
  fs.writeFileSync(androidShot, 'tampered-screenshot');
  assert.ok(validateAttestation(result.output, expected).some(e => /screenshot|hash mismatch/i.test(e)));
  fs.writeFileSync(androidShot, 'android-fresh-screenshot');

  // A different tested binary cannot satisfy the recorded build hash.
  fs.writeFileSync(apk, 'android-build-v2');
  assert.ok(validateAttestation(result.output, expected).some(e => /build artifact hash mismatch/.test(e)));
  fs.writeFileSync(apk, 'android-build-v1');

  // Manifest changes are also detected.
  fs.appendFileSync(manifest, '\nchanged\n');
  assert.ok(validateAttestation(result.output, expected).some(e => /mobile-device-qc\.md hash mismatch/.test(e)));

  // Wrong attempt/platform/commit/workspace identities are rejected.
  assert.ok(validateAttestation(result.output, { ...expected, attemptId: 'ATTEMPT-2' }).includes('attemptId mismatch'));
  assert.ok(validateAttestation(result.output, { ...expected, gitSha: '0'.repeat(40) }).includes('gitSha mismatch'));
  assert.ok(validateAttestation(result.output, { ...expected, platforms: ['android', 'ios', 'windows'] }).some(e => /missing windows attestation/.test(e)));

  // Session metadata is mandatory and must be current-attempt evidence.
  const missingBuild = JSON.parse(JSON.stringify(sessionPayload));
  delete missingBuild.platforms[0].buildArtifact;
  fs.writeFileSync(sessions, JSON.stringify(missingBuild));
  assert.throws(() => loadSessions(sessions, 'ATTEMPT-1', ['android'], startedMs), /buildArtifact is missing/);

  fs.writeFileSync(sessions, JSON.stringify({ ...sessionPayload, attemptId: 'WRONG' }));
  assert.throws(() => loadSessions(sessions, 'ATTEMPT-1', ['android'], startedMs), /attemptId mismatch/);

  fs.writeFileSync(sessions, JSON.stringify(sessionPayload));
  const old = new Date(startedMs - 5000);
  fs.utimesSync(sessions, old, old);
  assert.throws(() => loadSessions(sessions, 'ATTEMPT-1', ['android'], startedMs), /not created\/updated by this attempt/);

  console.log('evidence attestation selftest OK — exact Android/iOS builds, sessions, screenshots, manifest, commit, workspace and stale evidence covered');
} finally {
  fs.rmSync(run, { recursive: true, force: true });
}
