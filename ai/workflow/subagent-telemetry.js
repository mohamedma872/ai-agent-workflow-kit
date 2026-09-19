#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path'); const assert=require('assert');
function fromState(state){
 const rows=[];
 for(const [stage,roles] of Object.entries(state?.executionAttempts||{}))for(const [role,attempts] of Object.entries(roles||{}))for(const a of attempts||[]){
   rows.push({runId:state.id||state.runId||null,stage,role,attemptId:a.attemptId||null,executor:a.executor||null,status:a.status||null,exitType:a.exitType||null,
     startedAt:a.startedAt||null,completedAt:a.completedAt||null,durationMs:a.durationMs??duration(a.startedAt,a.completedAt),costUsd:a.costUsd??null,retry:Math.max(0,Number(a.attemptNumber||1)-1)});
 }
 return rows;
}
function duration(a,b){const x=Date.parse(a||''),y=Date.parse(b||'');return Number.isFinite(x)&&Number.isFinite(y)?Math.max(0,y-x):null;}
function summarize(rows){const m=new Map();for(const r of rows||[]){const x=m.get(r.role)||{role:r.role,attempts:0,passes:0,failures:0,totalDurationMs:0,durationSamples:0,retries:0,costUsd:0,costSamples:0};x.attempts++;if(r.status==='pass'||r.status==='success')x.passes++;else if(r.status==='fail'||r.status==='blocked')x.failures++;if(Number.isFinite(r.durationMs)){x.totalDurationMs+=r.durationMs;x.durationSamples++;}x.retries+=Number(r.retry||0);if(Number.isFinite(r.costUsd)){x.costUsd+=r.costUsd;x.costSamples++;}m.set(r.role,x);}return [...m.values()].map(x=>({...x,avgDurationMs:x.durationSamples?Math.round(x.totalDurationMs/x.durationSamples):null}));}
function selftest(){const rows=fromState({id:'X',executionAttempts:{analysis:{security:[{attemptId:'a',executor:'claude',status:'pass',attemptNumber:1,startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:00:02Z'}]}}});assert.equal(rows[0].durationMs,2000);assert.equal(summarize(rows)[0].passes,1);console.log('subagent-telemetry selftest OK');}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={fromState,summarize};
