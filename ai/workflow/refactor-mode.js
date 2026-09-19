#!/usr/bin/env node
'use strict';
const assert=require('assert');
const REFRACTOR=/\b(refactor|refactoring|extract|move\s+(?:the\s+)?(?:logic|code|business logic)|clean\s*up|cleanup|remove\s+duplication|deduplicat|architecture\s+(?:cleanup|improvement)|restructure|reorganize|simplify\s+(?:implementation|code)|behavior[- ]preserving)\b/i;
const BEHAVIOR_CHANGE=/\b(change behavior|new behavior|new feature|add feature|redesign behavior|change requirements)\b/i;
function detectRefactorMode(text,explicit){
 if(explicit){
   const v=String(explicit).toLowerCase();
   if(['refactor','behavior_preserving_refactor'].includes(v)) return {mode:'behavior_preserving_refactor',reason:'explicit override'};
   if(['feature','normal'].includes(v)) return {mode:'feature',reason:'explicit override'};
   throw new Error('invalid --mode; use feature or refactor');
 }
 const s=String(text||'');
 return REFRACTOR.test(s)&&!BEHAVIOR_CHANGE.test(s)
   ?{mode:'behavior_preserving_refactor',reason:'refactor intent detected'}
   :{mode:'feature',reason:'normal feature intent'};
}
function selftest(){
 assert.equal(detectRefactorMode('Refactor login screen without changing behavior').mode,'behavior_preserving_refactor');
 assert.equal(detectRefactorMode('Extract business logic into a use case').mode,'behavior_preserving_refactor');
 assert.equal(detectRefactorMode('Add a new checkout feature').mode,'feature');
 assert.equal(detectRefactorMode('Refactor and change behavior for a new feature').mode,'feature');
 assert.equal(detectRefactorMode('anything','refactor').mode,'behavior_preserving_refactor');
 console.log('refactor-mode selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={detectRefactorMode};
