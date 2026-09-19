#!/usr/bin/env node
'use strict';
const assert=require('assert');
function detectConflicts(findings){
 const byTopic=new Map();
 for(const f of findings||[]){for(const tag of f.tags||[]){const k=String(tag).toLowerCase();if(!byTopic.has(k))byTopic.set(k,[]);byTopic.get(k).push(f);}}
 const out=[]; let n=1;
 for(const [topic,list] of byTopic){
   for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
     const a=list[i],b=list[j]; const explicit=(a.conflictsWith||[]).includes(b.id)||(b.conflictsWith||[]).includes(a.id);
     if(explicit) out.push({id:'CONFLICT-'+String(n++).padStart(3,'0'),topic,findings:[a.id,b.id],status:'unresolved',resolution:null});
   }
 }
 return out;
}
function unresolvedBlocking(conflicts){return (conflicts||[]).filter(c=>c.status!=='resolved');}
function selftest(){const x=detectConflicts([{id:'A',tags:['storage'],conflictsWith:['B']},{id:'B',tags:['storage']}]);assert.equal(x.length,1);assert.equal(unresolvedBlocking(x).length,1);console.log('conflict-tracker selftest OK');}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={detectConflicts,unresolvedBlocking};
