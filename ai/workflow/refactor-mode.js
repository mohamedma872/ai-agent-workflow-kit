#!/usr/bin/env node
'use strict';

const assert = require('assert');

const REFRACTOR = /\b(refactor|refactoring|extract|move\s+(?:the\s+)?(?:logic|code|business logic)|clean\s*up|cleanup|remove\s+duplication|deduplicat|architecture\s+(?:cleanup|improvement)|restructure|reorganize|simplify\s+(?:implementation|code)|behavior[- ]preserving)\b/i;
const BEHAVIOR_CHANGE = /\b(change behavior|new behavior|new feature|add feature|redesign behavior|change requirements)\b/i;
const WHOLE_APP = /\b(?:whole|entire|complete|full|all)\s+(?:mobile\s+)?(?:app|application|codebase|repository|system)\b|\b(?:app|application|codebase|repository|system)[- ]wide\b/i;

function normalizeRefactorScope(explicitScope) {
  if (!explicitScope) return null;
  const value = String(explicitScope).toLowerCase();
  if (['app', 'whole-app', 'whole_app', 'application', 'system'].includes(value)) return 'whole_app';
  if (['local', 'partial', 'module', 'feature'].includes(value)) return 'local';
  throw new Error('invalid --refactor-scope; use app or local');
}

function detectRefactorMode(text, explicitMode, explicitScope) {
  const requestedScope = normalizeRefactorScope(explicitScope);
  let mode;
  let reason;

  if (explicitMode) {
    const value = String(explicitMode).toLowerCase();
    if (['refactor', 'behavior_preserving_refactor'].includes(value)) {
      mode = 'behavior_preserving_refactor';
      reason = 'explicit override';
    } else if (['feature', 'normal'].includes(value)) {
      mode = 'feature';
      reason = 'explicit override';
    } else {
      throw new Error('invalid --mode; use feature or refactor');
    }
  } else {
    const source = String(text || '');
    if (REFRACTOR.test(source) && !BEHAVIOR_CHANGE.test(source)) {
      mode = 'behavior_preserving_refactor';
      reason = 'refactor intent detected';
    } else {
      mode = 'feature';
      reason = 'normal feature intent';
    }
  }

  if (mode !== 'behavior_preserving_refactor') {
    if (requestedScope) throw new Error('--refactor-scope requires refactor mode');
    return { mode, reason, refactorScope: null };
  }

  const source = String(text || '');
  const refactorScope = requestedScope || (WHOLE_APP.test(source) ? 'whole_app' : 'local');
  return {
    mode,
    reason,
    refactorScope,
    scopeReason: requestedScope ? 'explicit refactor scope' : refactorScope === 'whole_app' ? 'whole-app refactor intent detected' : 'local refactor intent',
  };
}

function selftest() {
  assert.equal(detectRefactorMode('Refactor login screen without changing behavior').mode, 'behavior_preserving_refactor');
  assert.equal(detectRefactorMode('Extract business logic into a use case').refactorScope, 'local');
  assert.equal(detectRefactorMode('Refactor the entire application without changing behavior').refactorScope, 'whole_app');
  assert.equal(detectRefactorMode('Refactor the repository without changing behavior', 'refactor', 'app').refactorScope, 'whole_app');
  assert.equal(detectRefactorMode('Add a new checkout feature').mode, 'feature');
  assert.equal(detectRefactorMode('Refactor and change behavior for a new feature').mode, 'feature');
  assert.equal(detectRefactorMode('anything', 'refactor').mode, 'behavior_preserving_refactor');
  assert.throws(() => detectRefactorMode('anything', 'feature', 'app'), /requires refactor mode/);
  console.log('refactor-mode selftest OK');
}

if (require.main === module && process.argv.includes('--selftest')) selftest();

module.exports = { detectRefactorMode, normalizeRefactorScope };
