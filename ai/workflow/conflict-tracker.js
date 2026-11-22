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
// A conflict the run's own binding criteria already decide is not a question
// for a human. The arbitration role says so with settledBy (criterion ids such
// as AC-12, DoD-13, D9) and prevails (the winning finding). It is resolved here,
// owner "criteria", only when every cited id appears in the binding text (the
// run's 00-request … 04-inspection artifacts) and prevails is one of the pair,
// so an invented id never skips the human. A human decision is never replaced.
// Before, the arbitrator wrote "the binding criteria side with ARCH-008" and the
// plan still stopped until someone typed the same decision back.
const CRITERION=/^[A-Za-z]{1,6}-?\d{1,4}[a-z]?$/;
function settleByCriteria(conflicts,declared,bindingText,now=new Date()){
 // Whole ids only (AC-1 is not AC-12): the text's tokens, never a pattern built from an id.
 const tokens=new Set(String(bindingText||'').split(/[^A-Za-z0-9-]+/).map(t=>t.replace(/^-+|-+$/g,'')).filter(Boolean));
 const cited=id=>CRITERION.test(id)&&tokens.has(id);
 const byPair=new Map((declared||[]).map(d=>[[d.findingA,d.findingB].sort().join('|'),d]));
 return (conflicts||[]).map(c=>{
  if(c.status==='resolved')return c;
  const d=byPair.get((c.findings||[]).slice().sort().join('|'));
  const ids=Array.isArray(d?.settledBy)?[...new Set(d.settledBy.map(String))]:[];
  if(!ids.length||!(c.findings||[]).includes(d.prevails)||!ids.every(cited))return c;
  const other=c.findings.find(f=>f!==d.prevails);
  return {...c,status:'resolved',resolution:{decision:`Follow ${d.prevails}${other?` over ${other}`:''}: settled by ${ids.join(', ')}`,rationale:String(d.reason||''),owner:'criteria',settledBy:ids,resolvedAt:now.toISOString()}};
 });
}
// The open conflicts a run's 05-analysis/conflicts.json records: the file the
// engine wrote on its last plan attempt and the one `agentic resolve` edits.
// Older than arbitration.json, it holds the previous arbitration's pairs (the
// engine re-derives them before the plan), so it reports none.
function stale(dir){try{return fs.statSync(path.join(dir,'arbitration.json')).mtimeMs>fs.statSync(path.join(dir,'conflicts.json')).mtimeMs;}catch{return false;}}
function openConflicts(runDir){const dir=path.join(runDir,'05-analysis');if(stale(dir))return [];try{return unresolvedBlocking(JSON.parse(fs.readFileSync(path.join(dir,'conflicts.json'),'utf8')).conflicts||[]);}catch{return [];}}
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
  // A newer arbitration.json makes the file stale (re-arbitrated after a rework); an older one does not.
  const at=(f,s)=>fs.utimesSync(path.join(tmp,'05-analysis',f),s,s);
  fs.writeFileSync(path.join(tmp,'05-analysis','arbitration.json'),'{}');at('conflicts.json',1000);at('arbitration.json',2000);
  assert.deepEqual(openConflicts(tmp),[],'stale conflicts.json reports none');
  at('conflicts.json',3000);assert.deepEqual(openConflicts(tmp).map(c=>c.id),['CONFLICT-002','CONFLICT-003']);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
 // Settled by the run's own criteria: resolved without a human, but only on ids
 // that exist in the binding text, a prevails from the pair, and never over a human decision.
 const binding='AC-12 package.json must not change.\nDoD-13: package.json unchanged. Decision D9 keeps the catch-all.';
 const pair=detectConflicts([{id:'DOC-2',tags:['pkg'],conflictsWith:['ARCH-8']},{id:'ARCH-8',tags:['pkg']}]);
 const ok=settleByCriteria(pair,[{findingA:'DOC-2',findingB:'ARCH-8',reason:'AC-12 forbids it',settledBy:['AC-12','DoD-13'],prevails:'ARCH-8'}],binding);
 assert.equal(ok[0].status,'resolved');assert.equal(ok[0].resolution.owner,'criteria');
 assert.match(ok[0].resolution.decision,/^Follow ARCH-8 over DOC-2: settled by AC-12, DoD-13$/);assert.equal(unresolvedBlocking(ok).length,0);
 const decl=x=>[{findingA:'DOC-2',findingB:'ARCH-8',reason:'r',settledBy:['AC-12'],prevails:'ARCH-8',...x}];
 assert.equal(settleByCriteria(pair,decl({settledBy:['AC-99']}),binding)[0].status,'unresolved','an id the criteria do not contain');
 assert.equal(settleByCriteria(pair,decl({settledBy:['AC-1']}),binding)[0].status,'unresolved','AC-1 is not AC-12');
 assert.equal(settleByCriteria(pair,decl({settledBy:['D9','AC-77']}),binding)[0].status,'unresolved','every cited id must exist');
 assert.equal(settleByCriteria(pair,decl({prevails:'SEC-1'}),binding)[0].status,'unresolved','prevails must be one of the pair');
 assert.equal(settleByCriteria(pair,decl({settledBy:[]}),binding)[0].status,'unresolved','no settledBy is a human question');
 assert.equal(settleByCriteria(pair,decl({settledBy:['.*']}),binding)[0].status,'unresolved','not a criterion id');
 const human=[{...pair[0],status:'resolved',resolution:{decision:'human call',owner:'human'}}];
 assert.equal(settleByCriteria(human,decl({}),binding)[0].resolution.decision,'human call','a human decision is kept');
 console.log('conflict-tracker selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={detectConflicts,unresolvedBlocking,openConflicts,settleByCriteria};
