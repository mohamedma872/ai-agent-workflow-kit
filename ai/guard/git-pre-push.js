#!/usr/bin/env node
'use strict';
/*
 * ai/guard/git-pre-push.js — refuses non-fast-forward (force) pushes, for
 * EVERY agent and human. Runs from .husky/pre-push; git passes one line per
 * ref on stdin: "<local ref> <local sha> <remote ref> <remote sha>".
 * A push where the remote commit is not an ancestor of what is being pushed
 * rewrites shared history → exit 1. Bypass is the user's call: git push --no-verify.
 */
const { spawnSync } = require('child_process');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  const zero = /^0+$/;
  const problems = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(' ');
    if (!remoteSha || zero.test(remoteSha) || zero.test(localSha)) {continue;}   // new branch or deletion
    const ok = spawnSync('git', ['merge-base', '--is-ancestor', remoteSha, localSha]).status === 0;
    if (!ok) {problems.push(`${remoteRef} (${remoteSha.slice(0, 8)}) is not an ancestor of ${localRef} (${localSha.slice(0, 8)}) — this push rewrites history`);}
  }
  if (problems.length) {
    console.error('\n✗ ai-guard (pre-push): push refused\n' + problems.map(p => `  · ${p}`).join('\n') + '\n  Fetch and rebase/merge instead; if a rewrite is intended: git push --no-verify\n');
    process.exit(1);
  }
  process.exit(0);
});
