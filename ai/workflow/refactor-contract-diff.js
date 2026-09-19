#!/usr/bin/env node
'use strict';
const assert=require('assert');

function diffSet(before=[],after=[]){
  const b=new Set(before),a=new Set(after);
  return {removed:[...b].filter(x=>!a.has(x)),added:[...a].filter(x=>!b.has(x))};
}
function contractDiff(before={},after={}){
  const fields=['publicApis','apiCalls','storageContracts','navigationContracts','analyticsEvents','errorBehavior','concurrencyBehavior','lifecycleBehavior'];
  const changes={};
  for(const field of fields){
    const d=diffSet(before[field]||[],after[field]||[]);
    if(d.removed.length||d.added.length)changes[field]=d;
  }
  return changes;
}
function invariantProblems(changes,invariants){
  const map={
    publicApis:['publicApi'],
    apiCalls:['apiContracts'],
    storageContracts:['storageFormat','storageKeys'],
    navigationContracts:['navigation'],
    analyticsEvents:['analyticsEvents'],
    errorBehavior:['errorSemantics'],
    concurrencyBehavior:['concurrencyBehavior'],
    lifecycleBehavior:['lifecycleBehavior']
  };
  const allowed=new Set((invariants?.intentionalExceptions||[]).filter(x=>x.approved).map(x=>x.invariant));
  const problems=[];
  for(const [field,d] of Object.entries(changes||{})){
    for(const invariant of map[field]||[]){
      if(invariants?.mustPreserve?.[invariant]!==false && !allowed.has(invariant)){
        problems.push(field+'/'+invariant+': removed=['+d.removed.join(', ')+'] added=['+d.added.join(', ')+']');
      }
    }
  }
  return problems;
}
function selftest(){
  const changes=contractDiff(
    {publicApis:['a'],storageContracts:['key:session']},
    {publicApis:['b'],storageContracts:['key:session-v2']}
  );
  assert(changes.publicApis);
  const problems=invariantProblems(changes,{mustPreserve:{publicApi:true,storageFormat:true,storageKeys:true},intentionalExceptions:[]});
  assert.equal(problems.length,3);
  assert(problems.some(x=>x.includes('storageKeys')));
  console.log('refactor contract diff selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest'))selftest();
module.exports={contractDiff,invariantProblems};
