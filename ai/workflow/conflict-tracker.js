#!/usr/bin/env node
'use strict';
const assert=require('assert');const fs=require('fs');const path=require('path');
function detectConflicts(findings){
 const byTopic=new Map();
 for(const f of findings||[]){for(const tag of f.tags||[]){const k=String(tag).toLowerCase();if(!byTopic.has(k))byTopic.set(k,[]);byTopic.get(k).push(f);}}
 // One disagreement per pair of findings: two findings that share several tags
 // are still the same disagreement, and a human should decide it once.
 const seen=new Map();
 for(const [topic,list] of byTopic){
   for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
     const a=list[i],b=list[j]; const explicit=(a.conflictsWith||[]).includes(b.id)||(b.conflictsWith||[]).includes(a.id);
     if(!explicit) continue;
     const key=[a.id,b.id].sort().join('|');
     const existing=seen.get(key);
     if(existing){ if(!existing.topics.includes(topic)) existing.topics.push(topic); continue; }
     seen.set(key,{topic,topics:[topic],findings:[a.id,b.id],status:'unresolved',resolution:null});
   }
 }
 let n=1;
 return [...seen.values()].map(c=>({id:'CONFLICT-'+String(n++).padStart(3,'0'),...c,topic:c.topics.join(', ')}));
}
function unresolvedBlocking(conflicts){return (conflicts||[]).filter(c=>c.status!=='resolved');}
// The open conflicts a run's 05-analysis/conflicts.json records: the file the
// engine wrote on its last plan attempt and the one `agentic resolve` edits.
function openConflicts(runDir){try{return unresolvedBlocking(JSON.parse(fs.readFileSync(path.join(runDir,'05-analysis','conflicts.json'),'utf8')).conflicts||[]);}catch{return [];}}
function selftest(){
 const x=detectConflicts([{id:'A',tags:['storage'],conflictsWith:['B']},{id:'B',tags:['storage']}]);
 assert.equal(x.length,1);assert.equal(unresolvedBlocking(x).length,1);
 // The same pair sharing two tags is one disagreement, not two.
 const dup=detectConflicts([{id:'A',tags:['dependencies','offline'],conflictsWith:['B']},{id:'B',tags:['dependencies','offline']}]);
 assert.equal(dup.length,1,'a finding pair produces one conflict however many tags they share');
 assert.deepEqual(dup[0].topics.sort(),['dependencies','offline']);
 assert.match(dup[0].topic,/dependencies/);
 // Distinct pairs stay distinct, and ids stay sequential.
 const many=detectConflicts([{id:'A',tags:['t'],conflictsWith:['B','C']},{id:'B',tags:['t']},{id:'C',tags:['t']}]);
 assert.equal(many.length,2);assert.deepEqual(many.map(c=>c.id),['CONFLICT-001','CONFLICT-002']);
 assert.equal(detectConflicts([{id:'A',tags:['t']},{id:'B',tags:['t']}]).length,0,'no explicit conflictsWith, no conflict');
 // openConflicts reads the run's conflicts.json; missing or malformed means none.
 const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'conflict-tracker-'));
 try{
  assert.deepEqual(openConflicts(path.join(tmp,'missing')),[]);
  fs.mkdirSync(path.join(tmp,'05-analysis'));fs.writeFileSync(path.join(tmp,'05-analysis','conflicts.json'),'{not json');
  assert.deepEqual(openConflicts(tmp),[]);
  const mixed=[{id:'CONFLICT-001',status:'resolved'},{id:'CONFLICT-002',status:'unresolved'},{id:'CONFLICT-003'}];
  fs.writeFileSync(path.join(tmp,'05-analysis','conflicts.json'),JSON.stringify({conflicts:mixed}));
  assert.deepEqual(openConflicts(tmp),unresolvedBlocking(mixed));assert.deepEqual(openConflicts(tmp).map(c=>c.id),['CONFLICT-002','CONFLICT-003']);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
 console.log('conflict-tracker selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={detectConflicts,unresolvedBlocking,openConflicts};
