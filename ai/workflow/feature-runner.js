#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const ACTIVE = path.join(RUNS, '_active');
const WORKFLOW_FILE = path.join(ROOT, 'ai', 'workflows', 'feature.yaml');
const ROUTER = path.join(ROOT, 'ai', 'workflow', 'router.js');

function parseArgs(argv) {
  const args = { _: [], dryRun: false, run: null, budget: 10, timeoutMin: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--run') args.run = argv[++i];
    else if (arg === '--budget') args.budget = Number(argv[++i]) || 10;
    else if (arg === '--timeout-min') args.timeoutMin = Number(argv[++i]) || 30;
    else args._.push(arg);
  }
  return args;
}

function activeId() {
  try {
    const id = fs.readFileSync(ACTIVE, 'utf8').trim();
    return id && fs.existsSync(path.join(RUNS, id)) ? id : null;
  } catch {
    return null;
  }
}

function loadState(id) {
  return JSON.parse(fs.readFileSync(path.join(RUNS, id, 'state.json'), 'utf8'));
}

function saveState(id, state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(RUNS, id, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

function workflow() {
  return yaml.load(fs.readFileSync(WORKFLOW_FILE, 'utf8')) || {};
}

function verificationStage(definition) {
  return (definition.stages || []).find(stage => stage && stage.id === 'verification') || null;
}

function evidencePaths(id) {
  const device = path.join(RUNS, id, 'device');
  return {
    device,
    manifest: path.join(device, 'mobile-device-qc.md'),
    screenshots: path.join(device, 'screenshots'),
    prompt: path.join(device, 'mobile-evidence-context.md'),
    agentOutput: path.join(device, 'mobile-evidence-agent.md'),
  };
}

function pngFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(name => name.toLowerCase().endsWith('.png'))
      .map(name => path.join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function manifestVerdict(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/##\s+Verdict\s*\n+\s*(PASS|FAIL|BLOCKED)\b/i);
    return match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

function validateEvidence(id, startedAtMs = null) {
  const paths = evidencePaths(id);
  const screenshots = pngFiles(paths.screenshots);
  const problems = [];

  if (!fs.existsSync(paths.manifest)) {
    problems.push(`missing ai/runs/${id}/device/mobile-device-qc.md`);
  }
  if (!screenshots.length) {
    problems.push(`missing ai/runs/${id}/device/screenshots/*.png`);
  }

  const verdict = manifestVerdict(paths.manifest);
  if (fs.existsSync(paths.manifest) && verdict !== 'PASS') {
    problems.push(`device/mobile-device-qc.md verdict is ${verdict || 'missing'}; expected PASS`);
  }

  if (startedAtMs != null) {
    const toleranceMs = 2000;
    const minMtime = startedAtMs - toleranceMs;
    if (fs.existsSync(paths.manifest) && fs.statSync(paths.manifest).mtimeMs < minMtime) {
      problems.push('device/mobile-device-qc.md is stale; it predates this mobile-evidence execution');
    }
    if (screenshots.length && !screenshots.some(file => fs.statSync(file).mtimeMs >= minMtime)) {
      problems.push('device/screenshots/*.png are stale; no PNG was produced by this mobile-evidence execution');
    }
  }

  return { ok: problems.length === 0, problems, screenshots, verdict, paths };
}

function phaseStatus(state, phase) {
  return state.phases?.[phase]?.status || 'pending';
}

function evidenceRequirement(state) {
  return state.evidence?.mobileScreenshots?.requirement || 'unclassified';
}

function setExecution(id, state, status, details = {}) {
  state.evidence ||= {};
  state.evidence.mobileScreenshots ||= { requirement: 'unclassified' };
  state.evidence.mobileScreenshots.execution = {
    ...(state.evidence.mobileScreenshots.execution || {}),
    status,
    role: 'mobile-evidence',
    ...details,
  };
  saveState(id, state);
}

function buildPrompt(id) {
  return `# Final mobile evidence for ${id}\n\n` +
    `This is an executable workflow step, not a planning task. Use the Appium MCP and actually drive the final post-fix mobile application.\n\n` +
    `Read these run artifacts when present:\n` +
    `- ai/runs/${id}/02-acceptance-criteria.md\n` +
    `- ai/runs/${id}/03-definition-of-done.md\n` +
    `- ai/runs/${id}/08-build-test.md\n` +
    `- ai/runs/${id}/10-fixes.md\n\n` +
    `Required output contract:\n` +
    `1. Create/update ai/runs/${id}/device/mobile-device-qc.md.\n` +
    `2. Save fresh Appium screenshots as PNG files under ai/runs/${id}/device/screenshots/*.png.\n` +
    `3. Map device-relevant acceptance criteria to screenshot paths in the manifest.\n` +
    `4. The manifest must end with a '## Verdict' section whose value is PASS, FAIL, or BLOCKED.\n` +
    `5. Only use PASS when the final post-fix feature was actually exercised successfully.\n` +
    `6. Use Android UiAutomator2 or iOS XCUITest as appropriate. Flutter/React Native apps are tested through their built Android/iOS app.\n` +
    `7. Prefer NO_UI/headless mode where supported and close the Appium session at the end.\n` +
    `8. If Appium, the build, simulator/emulator/device, credentials, or test data are unavailable, write BLOCKED in the manifest and explain the exact blocker. Do not fabricate screenshots.\n`;
}

function runVerification(args) {
  const id = args.run || activeId();
  if (!id) throw new Error('no active /feature run; use --run <id> or runs.js start <id>');

  const stateFile = path.join(RUNS, id, 'state.json');
  if (!fs.existsSync(stateFile)) throw new Error(`missing ai/runs/${id}/state.json`);
  const state = loadState(id);
  const requirement = evidenceRequirement(state);
  const definition = workflow();
  const stage = verificationStage(definition);
  if (!stage || stage.conditional_role !== 'mobile-evidence') {
    throw new Error('feature workflow verification stage is not wired to conditional_role: mobile-evidence');
  }

  if (requirement === 'unclassified') {
    throw new Error('mobile evidence is unclassified; classify it with runs.js evidence required|not-required <reason>');
  }
  if (requirement === 'not-required') {
    console.log(`${id}: mobile evidence not required — ${state.evidence?.mobileScreenshots?.reason || 'no reason recorded'}`);
    return 0;
  }

  if (!['pass', 'skipped'].includes(phaseStatus(state, 'fixes'))) {
    throw new Error(`cannot execute final mobile evidence before fixes completes; fixes is ${phaseStatus(state, 'fixes')}`);
  }

  const paths = evidencePaths(id);
  fs.mkdirSync(paths.screenshots, { recursive: true });
  const prompt = buildPrompt(id);

  if (args.dryRun) {
    console.log(`would execute feature/mobile-evidence for ${id}`);
    console.log(`required manifest: ai/runs/${id}/device/mobile-device-qc.md`);
    console.log(`required screenshots: ai/runs/${id}/device/screenshots/*.png`);
    console.log(`router: node ai/workflow/router.js exec feature mobile-evidence --prompt-file ${path.relative(ROOT, paths.prompt)}`);
    return 0;
  }

  fs.writeFileSync(paths.prompt, prompt);
  const startedAt = new Date();
  setExecution(id, state, 'in_progress', {
    startedAt: startedAt.toISOString(),
    executor: 'workflow-runner',
  });

  const res = spawnSync(process.execPath, [
    ROUTER,
    'exec', 'feature', 'mobile-evidence',
    '--prompt-file', paths.prompt,
    '--output-file', paths.agentOutput,
    '--cwd', ROOT,
    '--budget', String(args.budget),
    '--timeout-min', String(args.timeoutMin),
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      AI_WORKFLOW_RUN_ID: id,
      AI_MOBILE_EVIDENCE: '1',
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);

  const refreshed = loadState(id);
  if (res.error || res.status !== 0) {
    setExecution(id, refreshed, 'blocked', {
      completedAt: new Date().toISOString(),
      exitStatus: typeof res.status === 'number' ? res.status : null,
      error: res.error ? res.error.message : 'mobile-evidence role exited non-zero',
    });
    throw new Error('mobile-evidence execution failed; ensure Appium MCP is available to the headless Claude session and a runnable Android/iOS target exists');
  }

  const evidence = validateEvidence(id, startedAt.getTime());
  if (!evidence.ok) {
    setExecution(id, refreshed, 'blocked', {
      completedAt: new Date().toISOString(),
      exitStatus: res.status,
      problems: evidence.problems,
    });
    throw new Error(`mobile evidence incomplete: ${evidence.problems.join('; ')}`);
  }

  setExecution(id, refreshed, 'pass', {
    completedAt: new Date().toISOString(),
    exitStatus: res.status,
    manifest: `ai/runs/${id}/device/mobile-device-qc.md`,
    screenshots: evidence.screenshots.map(file => path.relative(ROOT, file)),
  });
  console.log(`${id}: mobile evidence PASS · ${evidence.screenshots.length} PNG screenshot(s)`);
  return 0;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-runner-'));
  const run = path.join(tmp, 'HM-TEST');
  const device = path.join(run, 'device');
  const screenshots = path.join(device, 'screenshots');
  fs.mkdirSync(screenshots, { recursive: true });

  const localValidate = () => {
    const manifest = path.join(device, 'mobile-device-qc.md');
    const pngs = fs.readdirSync(screenshots).filter(name => name.endsWith('.png'));
    return fs.existsSync(manifest) && pngs.length > 0 && manifestVerdict(manifest) === 'PASS';
  };

  assert.strictEqual(localValidate(), false);
  fs.writeFileSync(path.join(device, 'mobile-device-qc.md'), '# QC\n\n## Verdict\nPASS\n');
  assert.strictEqual(localValidate(), false);
  fs.writeFileSync(path.join(screenshots, '01-feature.png'), 'png');
  assert.strictEqual(localValidate(), true);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('feature-runner selftest OK');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === 'verification' || command === 'mobile-evidence') {
      process.exitCode = runVerification(args);
    } else if (command === 'selftest') {
      selftest();
    } else {
      console.error('usage: feature-runner.js verification [--run ID] [--dry-run] [--budget USD] [--timeout-min M] | selftest');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
