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
   // An uncovered behavior blocks unless a human has explicitly waived it.
   // Previously the waiver map was consulted only when the BASELINE already
   // said "waived", but the baseline is written by the analysis agent and the
   // waive command does not edit it — so recording a waiver could never clear
   // an uncovered behavior, and a blocked refactor had no way forward at all.
   if(c.status==='uncovered'){
     const w=approved.get(b.id);
     if(!w||!w.reason||!w.owner) problems.push(`${b.id}: ${b.criticality} behavior is uncovered and has no recorded waiver (reason + owner)`);
   }
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
 // The real path a user hits: the baseline reports "uncovered" and the human
 // records a waiver. This must unblock, or `refactor-coverage waive` is a no-op
 // and the run is stuck forever.
 const real={observableBehaviors:[{id:'B-3',criticality:'high',coverage:{status:'uncovered',evidence:[]}}]};
 assert.equal(canImplement(real,{waivers:[]}).ok,false);
 assert.match(canImplement(real,{waivers:[]}).problems[0],/no recorded waiver/);
 assert.equal(canImplement(real,{waivers:[{behaviorId:'B-3',reason:'accepted risk',owner:'Mohamed'}]}).ok,true);
 // A waiver without an owner or a reason is not a waiver.
 assert.equal(canImplement(real,{waivers:[{behaviorId:'B-3',reason:'accepted risk'}]}).ok,false);
 assert.equal(canImplement(real,{waivers:[{behaviorId:'B-3',owner:'Mohamed'}]}).ok,false);
 // A waiver for a different behavior must not unblock this one.
 assert.equal(canImplement(real,{waivers:[{behaviorId:'B-9',reason:'x',owner:'y'}]}).ok,false);
 console.log('refactor characterization gate selftest OK');
}
if(require.main===module){try{const a=args(process.argv.slice(2));if(a._[0]==='waive')console.log(JSON.stringify(recordWaiver(a._[1],a._[2],a),null,2));else if(a._[0]==='selftest'||process.argv.includes('--selftest'))selftest();else throw new Error('usage: refactor-coverage.js waive <run> <behavior-id> --reason TEXT --owner NAME | --selftest');}catch(e){console.error('✗ '+e.message);process.exitCode=1;}}
module.exports={coverageProblems,canImplement,loadWaivers,recordWaiver};