#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path'); const assert=require('assert'); const yaml=require('js-yaml');
const FILE=path.join(__dirname,'cases.yaml');
function load(){const d=yaml.load(fs.readFileSync(FILE,'utf8'))||{};return d.cases||[];}
function validate(cases=load()){const p=[],ids=new Set();for(const c of cases){if(!c.id||ids.has(c.id))p.push('missing/duplicate id '+c.id);ids.add(c.id);if(!c.agent)p.push(c.id+': agent required');if(!Array.isArray(c.expected))p.push(c.id+': expected[] required');for(const e of c.expected||[]){if(!e.finding)p.push(c.id+': expected finding id required');if(!['critical','high','medium','low','info'].includes(e.severity))p.push(c.id+': invalid severity '+e.severity);}}return p;}
function oracleRows(cases=load()){return cases.map(c=>({caseId:c.id,agent:c.agent,truePositive:(c.expected||[]).length,falsePositive:0,falseNegative:0,severityWeightedMiss:0}));}
function nullRows(cases=load()){const w={critical:5,high:4,medium:3,low:2,info:1};return cases.map(c=>({caseId:c.id,agent:c.agent,truePositive:0,falsePositive:0,falseNegative:(c.expected||[]).length,severityWeightedMiss:(c.expected||[]).reduce((n,e)=>n+(w[e.severity]||0),0)}));}
function selftest(){const c=load();assert(c.length>=8);assert.deepStrictEqual(validate(c),[]);assert(oracleRows(c).every(r=>r.falseNegative===0));assert(nullRows(c).some(r=>r.falseNegative>0));console.log('subagent eval catalog selftest OK');}
if(require.main===module){const p=validate();if(process.argv.includes('--selftest'))selftest();else if(p.length){p.forEach(x=>console.error('✗ '+x));process.exitCode=1;}else console.log('subagent eval catalog OK');}
module.exports={load,validate,oracleRows,nullRows};
