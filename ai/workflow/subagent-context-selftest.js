#!/usr/bin/env node
'use strict';
const fs=require('fs'); const os=require('os'); const path=require('path'); const assert=require('assert'); const {buildRoleContext}=require('./subagent-context');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'subagent-context-')); const run=path.join(root,'run'); const product=path.join(root,'product'); fs.mkdirSync(run,{recursive:true}); fs.mkdirSync(product,{recursive:true});
fs.writeFileSync(path.join(run,'00-request.md'),'Refactor authentication token storage without behavior changes');
fs.writeFileSync(path.join(run,'01-requirements.md'),'Authentication owns session state');
fs.writeFileSync(path.join(run,'02-acceptance-criteria.md'),'AC ONLY');
fs.writeFileSync(path.join(run,'06-plan.md'),'SECRET PLAN SHOULD NOT LEAK');
fs.writeFileSync(path.join(product,'package.json'),'{"dependencies":{"react":"1.0.0"}}');
fs.mkdirSync(path.join(product,'docs'),{recursive:true});fs.writeFileSync(path.join(product,'docs','ADR-auth.md'),'Authentication tokens use secure storage and the auth module owns session state.');
fs.mkdirSync(path.join(product,'src'),{recursive:true});fs.writeFileSync(path.join(product,'src','AuthRepository.js'),'function refreshToken(){ return SecureStorage.get("refresh_token"); }');
const ctx=buildRoleContext({runDir:run,productRoot:product,contract:{inputs:['request','acceptance_criteria'],tools:['repository_read']},excludeArtifact:null,roleName:'security',stageId:'analysis'});
assert(ctx.includes('Refactor authentication token storage'));assert(ctx.includes('AC ONLY'));assert(!ctx.includes('SECRET PLAN SHOULD NOT LEAK'));
const dep=buildRoleContext({runDir:run,productRoot:product,contract:{inputs:['dependency_versions'],tools:['repository_read']},excludeArtifact:null,roleName:'docs',stageId:'analysis'});assert(dep.includes('package.json'));assert(dep.includes('react'));
const rag=buildRoleContext({runDir:run,productRoot:product,contract:{inputs:['request'],tools:['repository_read'],defaults:{retrieval:{mode:'hybrid_rag',top_k:4}}},excludeArtifact:null,roleName:'security',stageId:'analysis'});
assert(rag.includes('Hybrid RAG retrieved evidence'));assert(rag.includes('ADR-auth.md')||rag.includes('AuthRepository.js'));assert(fs.existsSync(path.join(run,'engine','rag-context','analysis-security.json')));

// .agentic/config.yaml rag: settings override contracts.yaml defaults, and rag.enabled:false is a hard kill switch.
fs.mkdirSync(path.join(product,'.agentic'),{recursive:true});
fs.writeFileSync(path.join(product,'.agentic','config.yaml'),'version: 1\nrag:\n  top_k: 1\n');
assert.strictEqual(require('./subagent-context').retrievalSettings({defaults:{retrieval:{mode:'hybrid_rag',top_k:4}}},require('../rag/hybrid-rag').loadRagConfig(product)).topK,1,'project rag.top_k overrides the contract default');
fs.writeFileSync(path.join(product,'.agentic','config.yaml'),'version: 1\nrag:\n  enabled: false\n');
const disabledRag=buildRoleContext({runDir:run,productRoot:product,contract:{inputs:['request'],tools:['repository_read'],defaults:{retrieval:{mode:'hybrid_rag',top_k:4}}},excludeArtifact:null,roleName:'security',stageId:'analysis'});
assert(!disabledRag.includes('Hybrid RAG retrieved evidence'),'rag.enabled: false disables retrieval regardless of the contract default');
fs.rmSync(path.join(product,'.agentic'),{recursive:true,force:true});

// A retried or reworked role is told why the previous attempt and any later
// stage failed, so it fixes the cause instead of repeating the work.
const {failureFeedback}=require('./subagent-context');
assert.strictEqual(failureFeedback(run,'implementation','implementation'),'','a clean run carries no failure feedback');
fs.writeFileSync(path.join(run,'state.json'),JSON.stringify({
 id:'TEST',
 phases:{implementation:{status:'pending'},'build-test':{status:'fail',note:'qa-execute: 6 of 7 widget tests never complete'}},
 roles:{'build-test':{'qa-execute':{status:'fail',note:'tests await real dart:io inside fake-async'}}},
 executionAttempts:{implementation:{implementation:[{attempt:1,ok:false,reason:'artifact/worktree validation failed: plan step missing'}]}},
}));
fs.mkdirSync(path.join(run,'engine'),{recursive:true});
fs.writeFileSync(path.join(run,'engine','build-test-qa-execute.rejected'),'{"status":"fail","blockers":["tests hang"]}');
const feedback=failureFeedback(run,'implementation','implementation');
assert.match(feedback,/Previous failures to address/);
assert.match(feedback,/plan step missing/,'its own failed attempt is reported');
assert.match(feedback,/never complete/,'the downstream blocker is reported');
assert.match(feedback,/await real dart:io/,'the failing role note is reported');
assert.match(feedback,/tests hang/,'the rejected output excerpt is included');
// A non-parallel stage keeps no roles in state, so its rejected output must be
// found on disk or the feedback silently drops the most useful part.
fs.writeFileSync(path.join(run,'state.json'),JSON.stringify({
 id:'TEST',
 phases:{implementation:{status:'pending'},'build-test':{status:'in_progress'}},
 roles:{},
}));
assert.match(failureFeedback(run,'implementation','implementation'),/tests hang/,'a roleless stage still surfaces its rejected output');
const reworkContext=buildRoleContext({runDir:run,productRoot:product,contract:{inputs:['request']},excludeArtifact:null,roleName:'implementation',stageId:'implementation'});
assert(reworkContext.startsWith('## Previous failures to address'),'failures lead the prompt');

fs.rmSync(root,{recursive:true,force:true}); console.log('subagent-context selftest OK');
