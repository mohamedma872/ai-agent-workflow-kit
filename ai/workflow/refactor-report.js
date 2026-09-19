#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path');
const ROOT=path.resolve(__dirname,'..','..');
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function build(runId){
 const dir=path.join(ROOT,'ai','runs',runId), engine=path.join(dir,'engine');
 const baseline=read(path.join(dir,'04-behavior-baseline.json'))||{};
 const equivalence=read(path.join(dir,'10-behavior-equivalence.json'))||{};
 const telemetry=read(path.join(engine,'refactor-telemetry.json'))||{};
 const contractDiff=read(path.join(engine,'refactor-contract-diff.json'))||{};
 const checkpoints=read(path.join(engine,'refactor-checkpoints.json'))||{checkpoints:{}};
 const matrix=read(path.join(engine,'refactor-verification-matrix.json'))||{};
 return {schemaVersion:1,runId,mode:read(path.join(engine,'mode.json'))?.mode||'feature',baseline,equivalence,telemetry,contractDiff,checkpoints,matrix};
}
function markdown(r){
 const t=r.telemetry||{}, e=r.equivalence||{};
 const lines=['# Refactor verification report','',`Run: ${r.runId}`,'',`Mode: ${r.mode}`,'',`Behavior verification: **${e.fullyVerified?'FULL':'PARTIAL'}**`,''];
 lines.push('## Coverage','',`- Baseline behaviors: ${t.behaviorCount??0}`,`- Covered: ${t.coveredBehaviors??0}`,`- Waived: ${t.waivedBehaviors??0}`,`- Uncovered: ${t.uncoveredBehaviors??0}`,'');
 lines.push('## Changes','',`- Intentional behavior changes: ${t.intentionalChanges??0}`,`- Unexpected behavior changes: ${t.unexpectedChanges??0}`,'');
 lines.push('## Incremental verification','',`- Verified increments: ${t.verifiedIncrements??0}`,'', '## Test layers','');
 for(const x of t.testLayers||[])lines.push('- '+x);
 lines.push('','## Unverified scenarios','');
 if(!(e.unverifiedScenarios||[]).length)lines.push('- None');else for(const x of e.unverifiedScenarios)lines.push('- '+x);
 lines.push('','## Contract diff','');
 const changes=r.contractDiff?.changes||{};if(!Object.keys(changes).length)lines.push('- No observable contract changes detected');else for(const [k,v] of Object.entries(changes))lines.push(`- ${k}: removed [${(v.removed||[]).join(', ')}], added [${(v.added||[]).join(', ')}]`);
 if((r.contractDiff?.violations||[]).length){lines.push('','## Invariant violations','');for(const x of r.contractDiff.violations)lines.push('- '+x);}
 return lines.join('\n')+'\n';
}
if(require.main===module){const args=process.argv.slice(2), runId=args.find(x=>!x.startsWith('--'));if(!runId){console.error('usage: refactor-report.js <run-id> [--json]');process.exitCode=1;}else{const r=build(runId);process.stdout.write(args.includes('--json')?JSON.stringify(r,null,2)+'\n':markdown(r));}}
module.exports={build,markdown};
