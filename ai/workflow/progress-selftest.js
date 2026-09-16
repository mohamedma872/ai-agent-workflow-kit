#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  deriveRoleGroupStatus,
  effectiveStatus,
  consistencyIssues,
  currentWork,
  percentComplete,
} = require('./progress');

function staleApprovedState() {
  return {
    status: 'active',
    phases: {
      request: { status: 'pass' },
      requirements: { status: 'pass' },
      'acceptance-criteria': { status: 'pass' },
      'definition-of-done': { status: 'pass' },
      inspection: { status: 'pass' },
      analysis: { status: 'in_progress' },
      plan: { status: 'in_progress' },
      approval: { status: 'pass' },
    },
    roles: {
      analysis: {
        architect: { status: 'pass', executor: 'claude' },
        security: { status: 'pass', executor: 'claude' },
        'qa-plan': { status: 'pass', executor: 'claude' },
      },
    },
  };
}

{
  const state = staleApprovedState();
  assert.strictEqual(deriveRoleGroupStatus(state, 'analysis'), 'pass');
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'pass');
  assert.strictEqual(effectiveStatus(state, 'plan'), 'pass');
  assert.strictEqual(currentWork(state), 'Waiting for Implementation');
  assert.ok(consistencyIssues(state).length >= 2);
  assert.ok(percentComplete(state) > 58);
}

{
  const state = {
    status: 'active',
    phases: { analysis: { status: 'in_progress' } },
    selectedRoles: { analysis: ['architect', 'security'] },
    roles: {
      analysis: {
        architect: { status: 'pass', executor: 'claude' },
        security: { status: 'pending', executor: 'claude' },
      },
    },
  };
  assert.strictEqual(deriveRoleGroupStatus(state, 'analysis'), 'in_progress');
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'in_progress');
  assert.strictEqual(currentWork(state), 'Specialist Analysis');
}

{
  const state = {
    status: 'active',
    phases: { analysis: { status: 'in_progress' } },
    selectedRoles: { analysis: ['architect', 'security'] },
    roles: {
      analysis: {
        architect: { status: 'pass', executor: 'claude' },
        security: { status: 'pass', executor: 'claude' },
      },
    },
  };
  assert.strictEqual(deriveRoleGroupStatus(state, 'analysis'), 'pass');
  assert.strictEqual(effectiveStatus(state, 'analysis'), 'pass');
  assert.strictEqual(currentWork(state), 'Waiting for Request');
}

{
  const state = {
    status: 'active',
    phases: {
      analysis: { status: 'in_progress' },
      plan: { status: 'in_progress' },
    },
    roles: {
      analysis: {
        security: { status: 'in_progress', executor: 'claude' },
      },
    },
  };
  assert.strictEqual(currentWork(state), 'Implementation Plan');
  assert.ok(consistencyIssues(state).some(message => message.includes('Multiple stored phases')));
}

console.log('progress-selftest OK');
