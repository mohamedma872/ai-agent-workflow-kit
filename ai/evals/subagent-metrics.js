#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path'); const assert=require('assert');
function score(rows){
 const by={};
 for(const r of rows||[]){const a=r.extra?.role||r.agent||'unknown', version=r.runtimeVersion||r.agentVersion||r.extra?.runtimeVersion||'current', key=a+'@'+version;const x=by[key]||={agent:a,version,tp:0,fp:0,fn:0,severityMiss:0,cases:0};x.cases++;
   const tp=r.truePositive!==undefined?Number(r.truePositive||0):Array.isArray(r.matched)?r.matched.length:0;
   const fp=r.falsePositive!==undefined?Number(r.falsePositive||0):Array.isArray(r.phantoms)?r.phantoms.length:0;
   const fn=r.falseNegative!==undefined?Number(r.falseNegative||0):Array.isArray(r.missed)?r.missed.length:0;
   const weights={critical:5,high:4,medium:3,low:2,info:1};
   const severityMap=r.extra?.expectedSeverity||{};
   const weighted=Array.isArray(r.missed)?r.missed.reduce((n,id)=>n+(weights[severityMap[id]]||1),0):fn;
   x.tp+=tp;x.fp+=fp;x.fn+=fn;x.severityMiss+=Number(r.severityWeightedMiss!==undefined?r.severityWeightedMiss:weighted);}
 return Object.values(by).map(x=>({...x,precision:(x.tp+x.fp)?x.tp/(x.tp+x.fp):1,recall:(x.tp+x.fn)?x.tp/(x.tp+x.fn):1,falsePositiveRate:(x.tp+x.fp)?x.fp/(x.tp+x.fp):0}));
}
function compare(current,baseline){const b=new Map(score(baseline).map(x=>[x.agent+'@'+x.version,x]));return score(current).map(x=>{const prev=b.get(x.agent+'@'+x.version);return {...x,deltaPrecision:prev?x.precision-prev.precision:null,deltaRecall:prev?x.recall-prev.recall:null};});}
function selftest(){
 const s=score([{agent:'claude',extra:{role:'security',expectedSeverity:{'finding-1':'high'}},matched:['a','b','c'],phantoms:['x'],missed:['finding-1']}])[0];
 assert.equal(s.agent,'security');assert.equal(s.precision,.75);assert.equal(s.recall,.75);assert.equal(s.severityMiss,4);
 console.log('subagent-metrics selftest OK');
}
function readRows(file){return fs.readFileSync(path.resolve(file),'utf8').split('\n').filter(Boolean).map(JSON.parse);}
function cli(argv){
 if(argv.includes('--selftest')) return selftest();
 const positional=argv.filter(x=>!x.startsWith('--') && !/^\d+(?:\.\d+)?$/.test(x)); const file=positional[0]; if(!file)throw new Error('usage: subagent-metrics.js results.jsonl [--baseline baseline.jsonl] [--min-precision N] [--min-recall N]');
 const val=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:null;}; const current=readRows(file), baselineFile=val('--baseline'), report=baselineFile?compare(current,readRows(baselineFile)):score(current);
 console.log(JSON.stringify(report,null,2));
 const minP=val('--min-precision')!==null?Number(val('--min-precision')):null, minR=val('--min-recall')!==null?Number(val('--min-recall')):null;
 const failures=[]; for(const r of report){if(minP!==null&&r.precision<minP)failures.push(`${r.agent}: precision ${r.precision.toFixed(3)} < ${minP}`);if(minR!==null&&r.recall<minR)failures.push(`${r.agent}: recall ${r.recall.toFixed(3)} < ${minR}`);}
 if(failures.length){failures.forEach(x=>console.error('✗ '+x));process.exitCode=1;}
}
if(require.main===module){try{cli(process.argv.slice(2));}catch(e){console.error('✗ '+e.message);process.exitCode=1;}}
module.exports={score,compare,readRows};
