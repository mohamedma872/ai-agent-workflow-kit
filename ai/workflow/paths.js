'use strict';

const path = require('path');

const DEFAULT_RUNTIME_ROOT = path.resolve(__dirname, '..', '..');

function runtimeRoot() {
  return path.resolve(process.env.AI_WORKFLOW_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT);
}

function projectRoot() {
  if (process.env.AI_WORKFLOW_PROJECT_ROOT) return path.resolve(process.env.AI_WORKFLOW_PROJECT_ROOT);
  if (process.env.AI_WORKFLOW_PRODUCT_ROOT) return path.resolve(process.env.AI_WORKFLOW_PRODUCT_ROOT);
  return runtimeRoot();
}

function stateRoot() {
  if (process.env.AI_WORKFLOW_STATE_ROOT) return path.resolve(process.env.AI_WORKFLOW_STATE_ROOT);
  const explicitProject = !!(process.env.AI_WORKFLOW_PROJECT_ROOT || process.env.AI_WORKFLOW_PRODUCT_ROOT);
  return explicitProject ? path.join(projectRoot(), '.agentic-runs') : path.join(runtimeRoot(), 'ai', 'runs');
}

function runtimePath(...parts) { return path.join(runtimeRoot(), ...parts); }
function projectPath(...parts) { return path.join(projectRoot(), ...parts); }
function statePath(...parts) { return path.join(stateRoot(), ...parts); }

function relativeStatePath(...parts) {
  const root = projectRoot();
  const full = statePath(...parts);
  const rel = path.relative(root, full);
  return rel && !rel.startsWith('..') ? rel.replaceAll('\\', '/') : full;
}

module.exports = {
  DEFAULT_RUNTIME_ROOT,
  runtimeRoot,
  projectRoot,
  stateRoot,
  runtimePath,
  projectPath,
  statePath,
  relativeStatePath,
};
