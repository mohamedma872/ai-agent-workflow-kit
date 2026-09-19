#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNTIME_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRODUCT_ROOT = process.env.AI_WORKFLOW_PRODUCT_ROOT ? path.resolve(process.env.AI_WORKFLOW_PRODUCT_ROOT) : RUNTIME_ROOT;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const REQUIRED_SESSION_FIELDS = ['sessionId', 'deviceId', 'appId', 'appVersion', 'buildNumber', 'buildArtifact', 'sessionStartedAt', 'sessionEndedAt'];

function hashBytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function sha256(file) { return hashBytes(fs.readFileSync(file)); }
function hashPath(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return sha256(target);
  if (!stat.isDirectory()) throw new Error(`unsupported build artifact type: ${target}`);
  const parts = [];
  function walk(dir, rel = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const childRel = path.posix.join(rel.split(path.sep).join('/'), name);
      const s = fs.lstatSync(abs);
      if (s.isDirectory()) walk(abs, childRel);
      else if (s.isFile()) parts.push(`${childRel}\0${sha256(abs)}\n`);
      else if (s.isSymbolicLink()) parts.push(`${childRel}\0symlink:${fs.readlinkSync(abs)}\n`);
    }
  }
  walk(target);
  return hashBytes(parts.join(''));
}
function git(command) {
  const res = spawnSync('git', command, { cwd: PRODUCT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`git ${command.join(' ')} failed while building evidence attestation`);
  return String(res.stdout || '');
}
function gitSha() { return git(['rev-parse', 'HEAD']).trim(); }
function workspaceFingerprint() {
  const status = git(['status', '--porcelain=v1', '-z']);
  const diff = git(['diff', '--binary', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const chunks = [`status\0${status}`, `diff\0${diff}`];
  for (const rel of untracked) {
    const abs = path.join(PRODUCT_ROOT, rel);
    try { if (fs.statSync(abs).isFile()) chunks.push(`untracked\0${rel}\0${sha256(abs)}`); } catch { /* disappeared */ }
  }
  return hashBytes(chunks.join('\n'));
}
function fresh(file, startedMs) { try { return fs.statSync(file).mtimeMs >= startedMs - 1000; } catch { return false; } }
function parseIso(value, label) {
  const time = Date.parse(value);
  if (!value || Number.isNaN(time)) throw new Error(`${label} must be an ISO timestamp`);
  return time;
}
function resolveBuildArtifact(value) {
  if (!value) throw new Error('buildArtifact is missing');
  const abs = path.isAbsolute(value) ? value : path.resolve(PRODUCT_ROOT, value);
  if (!fs.existsSync(abs)) throw new Error(`buildArtifact does not exist: ${value}`);
  return abs;
}
function displayBuildPath(abs) {
  const rel = path.relative(PRODUCT_ROOT, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}
function validateSessionMetadata(session, platform, attemptStartedMs) {
  for (const field of REQUIRED_SESSION_FIELDS) {
    const value = session[field];
    if (value === undefined || value === null || String(value).trim() === '') throw new Error(`${platform} ${field} is missing`);
  }
  if (String(session.sessionId).trim().length < 4) throw new Error(`${platform} sessionId is invalid`);
  const started = parseIso(session.sessionStartedAt, `${platform} sessionStartedAt`);
  const ended = parseIso(session.sessionEndedAt, `${platform} sessionEndedAt`);
  if (started > ended) throw new Error(`${platform} Appium session timestamps are reversed`);
  if (ended < attemptStartedMs - 1000) throw new Error(`${platform} Appium session ended before the current evidence attempt`);
  resolveBuildArtifact(session.buildArtifact);
}
function loadSessions(file, attemptId, platforms, startedMs) {
  if (!fresh(file, startedMs)) throw new Error('device/appium-sessions.json was not created/updated by this attempt');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`invalid device/appium-sessions.json: ${e.message}`); }
  if (data.attemptId !== attemptId) throw new Error(`appium-sessions.json attemptId mismatch: expected ${attemptId}`);
  if (!Array.isArray(data.platforms)) throw new Error('appium-sessions.json platforms must be an array');
  for (const platform of platforms) {
    const p = data.platforms.find(x => x && String(x.platform).toLowerCase() === platform);
    if (!p) throw new Error(`appium-sessions.json missing ${platform} session`);
    validateSessionMetadata(p, platform, startedMs);
  }
  return data;
}
function screenshotFiles(dir, startedMs) {
  try { return fs.readdirSync(dir).filter(name => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())).filter(name => fresh(path.join(dir, name), startedMs)).sort(); }
  catch { return []; }
}
function buildAttestation({ runId, attemptId, platforms, startedMs, deviceDir, screenshotDir, manifestFile, sessionsFile }) {
  const sessions = loadSessions(sessionsFile, attemptId, platforms, startedMs);
  if (!fresh(manifestFile, startedMs)) throw new Error('mobile-device-qc.md is not fresh for this attempt');
  const screenshots = screenshotFiles(screenshotDir, startedMs);
  if (!screenshots.length) throw new Error('no fresh screenshots found for attestation');
  const head = gitSha();
  const workspace = workspaceFingerprint();
  const platformEntries = platforms.map(platform => {
    const session = sessions.platforms.find(x => String(x.platform).toLowerCase() === platform);
    const files = screenshots.filter(name => name.toLowerCase().startsWith(`${platform}-`));
    if (!files.length) throw new Error(`no ${platform}-prefixed screenshot found for attestation`);
    const buildAbs = resolveBuildArtifact(session.buildArtifact);
    return {
      platform, sessionId: String(session.sessionId), sessionStartedAt: session.sessionStartedAt, sessionEndedAt: session.sessionEndedAt,
      deviceId: String(session.deviceId), appId: String(session.appId), appVersion: String(session.appVersion), buildNumber: String(session.buildNumber),
      flavor: session.flavor || null, scheme: session.scheme || null, environment: session.environment || null,
      gitSha: head, workspaceFingerprint: workspace,
      buildArtifact: { path: displayBuildPath(buildAbs), sha256: hashPath(buildAbs), kind: fs.statSync(buildAbs).isDirectory() ? 'directory' : 'file' },
      screenshots: files.map(name => ({ path: `ai/runs/${runId}/device/screenshots/${name}`, sha256: sha256(path.join(screenshotDir, name)) })),
    };
  });
  const evidence = {
    schemaVersion: 1, generatedBy: 'ai-agent-workflow-runtime', generatedAt: new Date().toISOString(), runId, attemptId, status: 'pass',
    gitSha: head, workspaceFingerprint: workspace, productRoot: PRODUCT_ROOT,
    manifest: { path: `ai/runs/${runId}/device/mobile-device-qc.md`, sha256: sha256(manifestFile) }, platforms: platformEntries,
  };
  const output = path.join(deviceDir, 'evidence.json');
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  return { output, evidence };
}
function resolveEvidencePath(storedPath, evidenceFilePath) {
  if (path.isAbsolute(storedPath)) return storedPath;
  for (const root of [PRODUCT_ROOT, RUNTIME_ROOT]) {
    const candidate = path.resolve(root, storedPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(path.dirname(evidenceFilePath), storedPath);
}
function validateAttestation(file, expected = {}) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return [`invalid evidence.json: ${e.message}`]; }
  const errors = [];
  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (data.generatedBy !== 'ai-agent-workflow-runtime') errors.push('generatedBy must be ai-agent-workflow-runtime');
  if (expected.runId && data.runId !== expected.runId) errors.push('runId mismatch');
  if (expected.attemptId && data.attemptId !== expected.attemptId) errors.push('attemptId mismatch');
  if (expected.gitSha && data.gitSha !== expected.gitSha) errors.push('gitSha mismatch');
  if (expected.workspaceFingerprint && data.workspaceFingerprint !== expected.workspaceFingerprint) errors.push('workspaceFingerprint mismatch');
  if (data.status !== 'pass') errors.push('status must be pass');
  if (!data.manifest?.path || !data.manifest?.sha256) errors.push('manifest attestation missing');
  else {
    const manifestAbs = resolveEvidencePath(data.manifest.path, file);
    if (!fs.existsSync(manifestAbs)) errors.push(`${data.manifest.path} missing`);
    else if (sha256(manifestAbs) !== data.manifest.sha256) errors.push(`${data.manifest.path} hash mismatch`);
  }
  if (!Array.isArray(data.platforms) || !data.platforms.length) errors.push('platforms missing');
  for (const platform of expected.platforms || []) {
    const p = (data.platforms || []).find(x => x.platform === platform);
    if (!p) { errors.push(`missing ${platform} attestation`); continue; }
    for (const field of ['sessionId', 'sessionStartedAt', 'sessionEndedAt', 'deviceId', 'appId', 'appVersion', 'buildNumber', 'gitSha', 'workspaceFingerprint']) if (p[field] === undefined || p[field] === null || String(p[field]).trim() === '') errors.push(`${platform} ${field} missing`);
    if (expected.gitSha && p.gitSha !== expected.gitSha) errors.push(`${platform} gitSha mismatch`);
    if (expected.workspaceFingerprint && p.workspaceFingerprint !== expected.workspaceFingerprint) errors.push(`${platform} workspaceFingerprint mismatch`);
    if (!p.buildArtifact?.path || !p.buildArtifact?.sha256) errors.push(`${platform} buildArtifact attestation missing`);
    else {
      const buildAbs = resolveEvidencePath(p.buildArtifact.path, file);
      if (!fs.existsSync(buildAbs)) errors.push(`${platform} build artifact missing: ${p.buildArtifact.path}`);
      else { try { if (hashPath(buildAbs) !== p.buildArtifact.sha256) errors.push(`${platform} build artifact hash mismatch`); } catch (e) { errors.push(`${platform} build artifact cannot be hashed: ${e.message}`); } }
    }
    if (!Array.isArray(p.screenshots) || !p.screenshots.length) errors.push(`${platform} screenshots missing`);
    for (const shot of p.screenshots || []) {
      const abs = resolveEvidencePath(shot.path, file);
      if (!fs.existsSync(abs)) errors.push(`${shot.path} missing`);
      else if (sha256(abs) !== shot.sha256) errors.push(`${shot.path} hash mismatch`);
    }
  }
  return errors;
}

module.exports = { buildAttestation, validateAttestation, sha256, hashPath, gitSha, workspaceFingerprint, loadSessions, validateSessionMetadata, resolveBuildArtifact, PRODUCT_ROOT };

if (require.main === module) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'validate' && file) {
    const errors = validateAttestation(path.resolve(file));
    if (errors.length) { errors.forEach(e => console.error(`✗ ${e}`)); process.exitCode = 1; }
    else console.log('✓ evidence attestation valid');
  } else { console.error('usage: evidence-attestation.js validate <evidence.json>'); process.exitCode = 1; }
}
