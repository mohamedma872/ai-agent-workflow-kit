#!/usr/bin/env node
'use strict';
const fs=require('fs'); const os=require('os'); const path=require('path'); const assert=require('assert'); const {buildRoleContext}=require('./subagent-context');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'subagent-context-')); const run=path.join(root,'run'); const product=path.join(root,'product'); fs.mkdirSync(run,{recursive:true}); fs.mkdirSync(product,{recursive:true});
fs.writeFileSync(path.join(run,'00-request.md'),'REQUEST ONLY'); fs.writeFileSync(path.join(run,'02-acceptance-criteria.md'),'AC ONLY'); fs.writeFileSync(path.join(run,'06-plan.md'),'SECRET PLAN SHOULD NOT LEAK'); fs.writeFileSync(path.join(product,'package.json'),'{"dependencies":{"react":"1.0.0"}}');
const ctx=buildRoleContext({runDir:run,productRoot:product,contract:{inputs:['request','acceptance_criteria']},excludeArtifact:null});
assert(ctx.includes('REQUEST ONLY')); assert(ctx.includes('AC ONLY')); assert(!ctx.includes('SECRET PLAN SHOULD NOT LEAK'));
const dep=buildRoleContext({runDir:run,productRoot:product,contract:{inputs:['dependency_versions']},excludeArtifact:null}); assert(dep.includes('package.json')); assert(dep.includes('react'));
fs.rmSync(root,{recursive:true,force:true}); console.log('subagent-context selftest OK');
