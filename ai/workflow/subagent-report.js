#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path'); const {fromState,summarize}=require('./subagent-telemetry'); const {score}=require('../evals/subagent-metrics');
function readJson(file){return JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));}
function readJsonl(file){return fs.readFileSync(path.resolve(file),'utf8').split('\n').filter(Boolean).map(JSON.parse);}
function findingStats(runDir){
 const map=new Map();const row=a=>{const k=a||'unknown';if(!map.has(k))map.set(k,{agent:k,produced:0,retained:0,reviewFindings:0,resolvedReviewFindings:0});return map.get(k);};
 const analysis=path.join(runDir||'','05-analysis');
 try{for(const file of fs.readdirSync(analysis).filter(x=>x.endsWith('.json')&&!['synthesis.json','conflicts.json'].includes(x))){const d=readJson(path.join(analysis,file));if(d&&Array.isArray(d.findings))row(d.agent||file.replace(/\.json$/,'')).produced+=d.findings.length;}}catch{}
 try{const syn=readJson(path.join(analysis,'synthesis.json'));for(const finding of syn.findings||[])for(const agent of finding.provenance||[])row(agent).retained++;}catch{}
 const reviews=path.join(runDir||'','09-reviews');
 try{for(const file of fs.readdirSync(reviews).filter(x=>x.endsWith('.json'))){const d=readJson(path.join(reviews,file));if(!d)continue;const r=row(d.reviewer||file.replace(/\.json$/,''));r.reviewFindings+=(d.findings||[]).length;r.resolvedReviewFindings+=(d.findings||[]).filter(x=>x.resolved===true).length;}}catch{}
 return [...map.values()].map(x=>({...x,notRetained:Math.max(0,x.produced-x.retained),unresolvedReviewFindings:Math.max(0,x.reviewFindings-x.resolvedReviewFindings)}));
}
function operationalComparison(telemetry,quality){
 const q=new Map((quality||[]).map(x=>[x.agent,x])); return (telemetry||[]).map(t=>({...t,precision:q.get(t.role)?.precision??null,recall:q.get(t.role)?.recall??null,falsePositiveRate:q.get(t.role)?.falsePositiveRate??null}))
   .sort((a,b)=>(b.recall??-1)-(a.recall??-1)||(b.precision??-1)-(a.precision??-1)||(a.avgDurationMs??Number.MAX_SAFE_INTEGER)-(b.avgDurationMs??Number.MAX_SAFE_INTEGER));
}
function build({stateFile,resultsFile}){const state=stateFile?readJson(stateFile):{};const telemetry=summarize(fromState(state));const quality=resultsFile?score(readJsonl(resultsFile)):[];const runDir=stateFile?path.dirname(path.resolve(stateFile)):null;return {version:1,runId:state.id||state.runId||null,telemetry,quality,findings:findingStats(runDir),comparison:operationalComparison(telemetry,quality)};}
function markdown(r){const lines=['# Subagent quality report',''];if(r.runId)lines.push(`Run: ${r.runId}`,'');lines.push('## Runtime telemetry','','| Role | Attempts | Passes | Failures | Avg duration ms | Retries | Cost USD |','|---|---:|---:|---:|---:|---:|---:|');for(const x of [...r.telemetry].sort((a,b)=>a.role.localeCompare(b.role)))lines.push(`| ${x.role} | ${x.attempts} | ${x.passes} | ${x.failures} | ${x.avgDurationMs??'–'} | ${x.retries} | ${x.costSamples?x.costUsd.toFixed(4):'–'} |`);lines.push('','## Eval quality','','| Agent | Precision | Recall | False positives | Severity miss | Cases |','|---|---:|---:|---:|---:|---:|');for(const x of [...r.quality].sort((a,b)=>a.agent.localeCompare(b.agent)))lines.push(`| ${x.agent} | ${x.precision.toFixed(3)} | ${x.recall.toFixed(3)} | ${x.fp} | ${x.severityMiss} | ${x.cases} |`);lines.push('','## Finding telemetry','','| Agent | Produced | Retained | Not retained | Review findings | Resolved | Unresolved |','|---|---:|---:|---:|---:|---:|---:|');
for(const x of [...(r.findings||[])].sort((a,b)=>a.agent.localeCompare(b.agent)))lines.push(`| ${x.agent} | ${x.produced} | ${x.retained} | ${x.notRetained} | ${x.reviewFindings} | ${x.resolvedReviewFindings} | ${x.unresolvedReviewFindings} |`);
lines.push('','## Operational comparison','','Advisory only; this comparison never overrides workflow gates or human decisions.','','| Role | Recall | Precision | Avg duration ms | Retries | Cost USD |','|---|---:|---:|---:|---:|---:|');
for(const x of r.comparison||[])lines.push(`| ${x.role} | ${x.recall===null?'–':x.recall.toFixed(3)} | ${x.precision===null?'–':x.precision.toFixed(3)} | ${x.avgDurationMs??'–'} | ${x.retries} | ${x.costSamples?x.costUsd.toFixed(4):'–'} |`);
return lines.join('\n')+'\n';}
if(require.main===module){const args=process.argv.slice(2);const get=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};const r=build({stateFile:get('--state'),resultsFile:get('--results')});process.stdout.write(args.includes('--json')?JSON.stringify(r,null,2)+'\n':markdown(r));}
module.exports={build,markdown,findingStats,operationalComparison};
