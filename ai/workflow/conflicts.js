#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path');
const {stateRoot}=require('./paths'); const RUNS=stateRoot();
const {unresolvedBlocking}=require('./conflict-tracker'); const {commandFor}=require('./progress');
function file(id){return path.join(RUNS,id,'05-analysis','conflicts.json');}
function load(id){return JSON.parse(fs.readFileSync(file(id),'utf8'));}
// Conflicts only reference finding ids, which say nothing on their own. The
// titles/recommendations come from the specialist artifacts beside them so a
// human can see what is actually in dispute.
function findingIndex(id){
 const dir=path.join(RUNS,id,'05-analysis'); const out=new Map();
 let files=[]; try{files=fs.readdirSync(dir);}catch{return out;}
 for(const f of files){
  if(!f.endsWith('.json')||f==='conflicts.json'||f==='synthesis.json') continue;
  try{
   const d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
   for(const item of d.findings||[]) out.set(item.id,{agent:d.agent||path.basename(f,'.json'),title:item.title,severity:item.severity,recommendation:item.recommendation});
  }catch{}
 }
 return out;
}
function list(id){
 const d=load(id), idx=findingIndex(id);
 return (d.conflicts||[]).map(c=>({...c,positions:(c.findings||[]).map(fid=>({id:fid,...(idx.get(fid)||{})}))}));
}
// With the run id the last line names the exact resolve and resume commands.
function renderList(items,{id,cli}={}){
 if(!items.length) return 'No specialist conflicts recorded for this run.';
 const lines=[];
 for(const c of items){
  lines.push(`${c.status==='resolved'?'✓':'✗'} ${c.id}  topic: ${c.topic||'—'}  (${c.status})`);
  for(const p of c.positions) lines.push(`    ${p.id} · ${p.agent||'?'} · ${p.severity||'?'} — ${p.title||'(finding not found in artifacts)'}${p.recommendation?`\n        → ${p.recommendation}`:''}`);
  if(c.resolution) lines.push(`    decided: ${c.resolution.decision} (${c.resolution.owner}) — ${c.resolution.rationale}`);
  lines.push('');
 }
 const pending=unresolvedBlocking(items), open=pending.length;
 if(id) lines.push(open?`${open} unresolved conflict(s) block the plan. Decide each with:\n  ${commandFor('resolve',id,cli,open===1?pending[0].id:'<conflict-id>')}\nthen: ${commandFor('resume',id,cli)}`:`All conflicts resolved — the plan stage can run: ${commandFor('resume',id,cli)}`);
 else lines.push(open?`${open} unresolved conflict(s) block the plan. Resolve with:\n  agentic resolve <run-id> <conflict-id> --decision "..." --rationale "..."`:'All conflicts resolved — the plan stage can run.');
 return lines.join('\n');
}
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
 // The listing must name what is in dispute, and say how to unblock the plan.
 const open=renderList([{id:'CONFLICT-001',topic:'storage',status:'unresolved',positions:[{id:'SEC-1',agent:'security-reviewer',severity:'high',title:'Use secure storage',recommendation:'flutter_secure_storage'},{id:'ARCH-2',agent:'mobile-architect',severity:'medium',title:'Plain preferences are enough'}]}]);
 assert.match(open,/CONFLICT-001/);assert.match(open,/security-reviewer/);assert.match(open,/Use secure storage/);assert.match(open,/agentic resolve/);
 const done=renderList([{id:'CONFLICT-001',topic:'storage',status:'resolved',positions:[],resolution:{decision:'plain preferences',rationale:'no PII stored',owner:'human',resolvedAt:'now'}}]);
 assert.match(done,/All conflicts resolved/);assert.match(done,/no PII stored/);
 assert.match(renderList([]),/No specialist conflicts/);
 // With the run id: the exact resolve and resume commands, as this install spells them.
 const openItems=[{id:'CONFLICT-001',topic:'storage',status:'unresolved',positions:[]}];
 const cliList=renderList(openItems,{id:'FEAT-1',cli:true});
 assert.match(cliList,/agentic resolve FEAT-1 CONFLICT-001 --decision/);assert.match(cliList,/then: agentic resume FEAT-1/);
 const nodeList=renderList(openItems,{id:'FEAT-1',cli:false});
 assert.match(nodeList,/node ai\/workflow\/conflicts\.js resolve FEAT-1/);assert.match(nodeList,/node ai\/workflow\/engine\.js resume FEAT-1/);
 assert.match(renderList([...openItems,{id:'CONFLICT-002',status:'unresolved',positions:[]}],{id:'FEAT-1',cli:true}),/^2 unresolved .*\n  agentic resolve FEAT-1 <conflict-id> --decision/m);
 assert.match(renderList([{...openItems[0],status:'resolved'}],{id:'FEAT-1',cli:true}),/All conflicts resolved — the plan stage can run: agentic resume FEAT-1/);
 console.log('conflicts resolution selftest OK');
}
function args(argv){const o={_:[]};for(let i=0;i<argv.length;i++){const a=argv[i];if(a.startsWith('--')){o[a.slice(2)]=argv[++i];}else o._.push(a);}return o;}
if(require.main===module){try{
 if(process.argv.includes('--selftest'))selftest();
 else{
  const a=args(process.argv.slice(2));const [cmd,id,cid]=a._;
  if(cmd==='list'){const items=list(id);console.log(a.json?JSON.stringify(items,null,2):renderList(items,{id,cli:process.env.AI_AGENTIC_CLI==='1'}));}
  else if(cmd==='resolve')console.log(JSON.stringify(resolve(id,cid,{...a,owner:a.owner||'human'}),null,2));
  else throw new Error('usage: conflicts.js list <run> [--json] | resolve <run> <conflict-id> --decision TEXT --rationale TEXT [--owner NAME]');
 }
}catch(e){console.error('✗ '+e.message);process.exitCode=1;}}
module.exports={resolve,resolveData,list,renderList,findingIndex};
