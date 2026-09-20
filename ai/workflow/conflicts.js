#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path');
const {stateRoot}=require('./paths'); const RUNS=stateRoot();
function file(id){return path.join(RUNS,id,'05-analysis','conflicts.json');}
function load(id){return JSON.parse(fs.readFileSync(file(id),'utf8'));}
function resolveData(d,conflictId,{decision,rationale,owner}){
 if(!decision||!rationale||!owner) throw new Error('resolve requires --decision, --rationale and --owner');
 const c=(d.conflicts||[]).find(x=>x.id===conflictId); if(!c) throw new Error('unknown conflict '+conflictId);
 c.status='resolved';c.resolution={decision,rationale,owner,resolvedAt:new Date().toISOString()}; return c;
}
function resolve(id,conflictId,opts){
 const d=load(id), c=resolveData(d,conflictId,opts);
 fs.writeFileSync(file(id),JSON.stringify(d,null,2)+'\n'); return c;
}
function selftest(){
 const assert=require('assert');const d={conflicts:[{id:'CONFLICT-001',status:'unresolved',findings:['A','B']}]};
 const c=resolveData(d,'CONFLICT-001',{decision:'secure storage',rationale:'PII requirement',owner:'human'});
 assert.equal(c.status,'resolved');assert.equal(c.resolution.owner,'human');assert.throws(()=>resolveData(d,'NOPE',{decision:'x',rationale:'y',owner:'z'}),/unknown/);
 console.log('conflicts resolution selftest OK');
}
function args(argv){const o={_:[]};for(let i=0;i<argv.length;i++){const a=argv[i];if(a.startsWith('--')){o[a.slice(2)]=argv[++i];}else o._.push(a);}return o;}
if(require.main===module){try{if(process.argv.includes('--selftest'))selftest();else{const a=args(process.argv.slice(2));const [cmd,id,cid]=a._;if(cmd!=='resolve')throw new Error('usage: conflicts.js resolve <run> <conflict-id> --decision TEXT --rationale TEXT --owner NAME');console.log(JSON.stringify(resolve(id,cid,a),null,2));}}catch(e){console.error('✗ '+e.message);process.exitCode=1;}}
module.exports={resolve,resolveData};
