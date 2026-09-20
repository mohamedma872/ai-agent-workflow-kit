#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path'); const assert=require('assert');
const {stateRoot}=require('./paths'); const RUNS=stateRoot();
function file(runId){return path.join(RUNS,runId,'engine','refactor-checkpoints.json');}
function planFile(runId){return path.join(RUNS,runId,'06-plan.json');}
function load(filePath,fallback){try{return JSON.parse(fs.readFileSync(filePath,'utf8'));}catch{return fallback;}}
function nextCheckpoint(plan,state={}){
 const list=plan?.refactorIncrements||[]; for(const inc of list){const s=state[inc.id]?.status||'pending';if(s!=='pass')return inc;} return null;
}
function completeCheckpoint(plan,state,id,evidence){
 const inc=(plan?.refactorIncrements||[]).find(x=>x.id===id);if(!inc)throw new Error('unknown refactor increment '+id);
 const expected=nextCheckpoint(plan,state);if(!expected||expected.id!==id)throw new Error(`increment ${id} is out of order`);
 if(!evidence?.diff||!Array.isArray(evidence.tests)||!evidence.tests.length)throw new Error('checkpoint requires diff and test evidence');
 return {...state,[id]:{status:'pass',verifiedAt:new Date().toISOString(),evidence}};
}
function record(runId,id,{diff,test}){
 const plan=load(planFile(runId),null);if(!plan)throw new Error('missing structured plan for '+runId);
 const doc=load(file(runId),{schemaVersion:1,runId,checkpoints:{}});
 const tests=Array.isArray(test)?test:String(test||'').split(',').map(x=>x.trim()).filter(Boolean);
 doc.checkpoints=completeCheckpoint(plan,doc.checkpoints,id,{diff,tests});
 fs.mkdirSync(path.dirname(file(runId)),{recursive:true});const tmp=file(runId)+'.tmp-'+process.pid+'-'+Date.now();fs.writeFileSync(tmp,JSON.stringify(doc,null,2)+'\n');fs.renameSync(tmp,file(runId));return doc;
}
function problems(runId){
 const plan=load(planFile(runId),{}), doc=load(file(runId),{checkpoints:{}}), p=[];
 for(const inc of plan.refactorIncrements||[])if(doc.checkpoints?.[inc.id]?.status!=='pass')p.push(`${inc.id}: increment not verified`);
 return p;
}
function selftest(){
 const p={refactorIncrements:[{id:'R1'},{id:'R2'}]};let st={};assert.equal(nextCheckpoint(p,st).id,'R1');
 assert.throws(()=>completeCheckpoint(p,st,'R2',{diff:'x',tests:['t']}),/out of order/);
 st=completeCheckpoint(p,st,'R1',{diff:'a.patch',tests:['unit']});assert.equal(nextCheckpoint(p,st).id,'R2');
 console.log('refactor checkpoints selftest OK');
}
function args(argv){const o={_:[],test:[]};for(let i=0;i<argv.length;i++){if(argv[i].startsWith('--')){const k=argv[i].slice(2),v=argv[++i];if(k==='test')o.test.push(v);else o[k]=v;}else o._.push(argv[i]);}return o;}
if(require.main===module){try{const a=args(process.argv.slice(2));if(a._[0]==='record')console.log(JSON.stringify(record(a._[1],a._[2],a),null,2));else if(a._[0]==='selftest'||process.argv.includes('--selftest'))selftest();else throw new Error('usage: refactor-checkpoints.js record <run> <increment> --diff REF --test TEST [--test TEST] | --selftest');}catch(e){console.error('✗ '+e.message);process.exitCode=1;}}
module.exports={nextCheckpoint,completeCheckpoint,record,problems};