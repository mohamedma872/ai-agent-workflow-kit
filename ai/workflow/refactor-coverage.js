#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path'); const assert=require('assert');
const {stateRoot}=require('./paths'); const RUNS=stateRoot();
function waiverFile(runId){return path.join(RUNS,runId,'engine','refactor-waivers.json');}
function loadWaivers(runId){try{return JSON.parse(fs.readFileSync(waiverFile(runId),'utf8'));}catch{return {schemaVersion:1,runId,waivers:[]};}}
function saveWaivers(runId,data){const file=waiverFile(runId);fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+process.pid+'-'+Date.now();fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n');fs.renameSync(tmp,file);}
function coverageProblems(baseline,waivers={waivers:[]}){
 const approved=new Map((waivers.waivers||[]).map(x=>[x.behaviorId,x])); const problems=[];
 for(const b of baseline?.observableBehaviors||[]){
   if(!['critical','high'].includes(b.criticality)) continue;
   const c=b.coverage||{};
   if(c.status==='covered' && (!Array.isArray(c.evidence)||!c.evidence.length)) problems.push(`${b.id}: covered behavior has no evidence`);
   if(c.status==='uncovered') problems.push(`${b.id}: ${b.criticality} behavior is uncovered`);
   if(c.status==='waived'){
     const w=approved.get(b.id);
     if(!w||!w.reason||!w.owner) problems.push(`${b.id}: waiver is not explicitly recorded by owner/reason`);
   }
 }
 return problems;
}
function canImplement(baseline,waivers){const p=coverageProblems(baseline,waivers);return {ok:p.length===0,problems:p};}
function recordWaiver(runId,behaviorId,{reason,owner}){
 if(!runId||!behaviorId||!reason||!owner)throw new Error('waive requires run, behavior id, --reason and --owner');
 const data=loadWaivers(runId);data.waivers=data.waivers.filter(x=>x.behaviorId!==behaviorId);data.waivers.push({behaviorId,reason,owner,recordedAt:new Date().toISOString(),actor:'human-risk-waiver'});saveWaivers(runId,data);return data;
}
function args(argv){const o={_:[]};for(let i=0;i<argv.length;i++){if(argv[i].startsWith('--'))o[argv[i].slice(2)]=argv[++i];else o._.push(argv[i]);}return o;}
function selftest(){
 const base={observableBehaviors:[{id:'B1',criticality:'critical',coverage:{status:'uncovered',evidence:[]}}]};
 assert.equal(canImplement(base,{waivers:[]}).ok,false);
 base.observableBehaviors[0].coverage={status:'covered',evidence:['test/login.spec.ts']};assert.equal(canImplement(base,{waivers:[]}).ok,true);
 base.observableBehaviors[0].coverage={status:'waived',evidence:[]};assert.equal(canImplement(base,{waivers:[]}).ok,false);
 assert.equal(canImplement(base,{waivers:[{behaviorId:'B1',reason:'device-only',owner:'Mohamed'}]}).ok,true);
 console.log('refactor characterization gate selftest OK');
}
if(require.main===module){try{const a=args(process.argv.slice(2));if(a._[0]==='waive')console.log(JSON.stringify(recordWaiver(a._[1],a._[2],a),null,2));else if(a._[0]==='selftest'||process.argv.includes('--selftest'))selftest();else throw new Error('usage: refactor-coverage.js waive <run> <behavior-id> --reason TEXT --owner NAME | --selftest');}catch(e){console.error('✗ '+e.message);process.exitCode=1;}}
module.exports={coverageProblems,canImplement,loadWaivers,recordWaiver};