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
fs.rmSync(root,{recursive:true,force:true}); console.log('subagent-context selftest OK');
