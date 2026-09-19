#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(ROOT, 'ai', 'workflows');
const SUPPORTED_CONDITIONS = new Set(['mobile_or_ui_feature']);

function validateWorkflowConditions(name, workflow) {
  const problems = [];
  const roles = workflow.roles || {};
  for (const stage of workflow.stages || []) {
    if (stage.conditional_role) {
      if (!roles[stage.conditional_role]) problems.push(`${name}/${stage.id}: unknown conditional_role "${stage.conditional_role}"`);
      if (!stage.condition) problems.push(`${name}/${stage.id}: conditional_role requires condition`);
      else if (!SUPPORTED_CONDITIONS.has(stage.condition)) problems.push(`${name}/${stage.id}: unsupported condition "${stage.condition}"`);
    } else if (stage.condition) {
      problems.push(`${name}/${stage.id}: condition requires conditional_role`);
    }
  }
  return problems;
}

function checkAll() {
  const files = fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).sort();
  const problems = [];
  for (const file of files) {
    try {
      const workflow = yaml.load(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8')) || {};
      problems.push(...validateWorkflowConditions(file.replace(/\.ya?ml$/, ''), workflow));
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
    }
  }
  if (problems.length) {
    problems.forEach(p => console.error(`✗ ${p}`));
    return 1;
  }
  console.log(`✓ workflow conditions valid · supported: ${[...SUPPORTED_CONDITIONS].join(', ')}`);
  return 0;
}

if (require.main === module) {
  const [cmd = 'check'] = process.argv.slice(2);
  if (cmd !== 'check') {
    console.error('usage: conditions.js check');
    process.exitCode = 1;
  } else process.exitCode = checkAll();
}

module.exports = { SUPPORTED_CONDITIONS, validateWorkflowConditions, checkAll };
