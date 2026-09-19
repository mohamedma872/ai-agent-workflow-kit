#!/usr/bin/env node
'use strict';
const assert=require('assert');
const SEV={critical:5,high:4,medium:3,low:2,info:1};
function key(f){const sources=(f.evidence||[]).map(e=>String(e.source||'').toLowerCase()).sort().join('|'); const title=String(f.title||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); return sources+'::'+title;}
function synthesize(agentFindings){
 const groups=new Map();
 for(const item of agentFindings||[]){
   for(const f of item.findings||[]){
     const k=key(f); if(!groups.has(k)) groups.set(k,[]);
     groups.get(k).push({...f,agent:item.agent});
   }
 }
 return [...groups.values()].map(list=>{
   const first=list[0], severity=list.reduce((a,b)=>SEV[b.severity]>SEV[a]?b.severity:a,first.severity);
   const confidence=Math.max(...list.map(x=>Number(x.confidence)||0));
   return {id:first.id,title:first.title,severity,uncertainty:first.uncertainty,confidence,
     evidence:[...new Map(list.flatMap(x=>x.evidence||[]).map(e=>[JSON.stringify(e),e])).values()],
     recommendation:first.recommendation,tags:[...new Set(list.flatMap(x=>x.tags||[]))],conflictsWith:[...new Set(list.flatMap(x=>x.conflictsWith||[]))],provenance:[...new Set(list.map(x=>x.agent))]};
 });
}
function selftest(){const base={id:'F-1',title:'Unsafe token storage',severity:'high',uncertainty:'confirmed',confidence:.9,evidence:[{source:'a.ts',detail:'token persisted'}],recommendation:'use secure storage'};const out=synthesize([{agent:'security',findings:[base]},{agent:'rn',findings:[{...base,confidence:.8}]}]);assert.equal(out.length,1);assert.deepStrictEqual(out[0].provenance,['security','rn']);console.log('finding-synthesis selftest OK');}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={synthesize};
