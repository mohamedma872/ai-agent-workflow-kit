#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path'); const assert=require('assert'); const yaml=require('js-yaml');
const {runtimeRoot,projectRoot}=require('./paths');
const {discoverMcps,normalizeMcpName}=require('./mcp-discovery');
const ROOT=runtimeRoot(); const PROJECT_ROOT=projectRoot(); const CONTRACTS=path.join(ROOT,'ai','subagents','contracts.yaml'); const WORKFLOW=path.join(ROOT,'ai','workflows','feature.yaml');
function load(file){return yaml.load(fs.readFileSync(file,'utf8'))||{};}
function validate(){
 const c=load(CONTRACTS), w=load(WORKFLOW), problems=[];
 if(c.version!==1) problems.push('contracts.version must be 1');
 for(const [name,role] of Object.entries(w.roles||{})){
   const x=c.roles?.[name];
   if(!x){problems.push('missing contract for role '+name); continue;}
   const expected=role.read_only===false?'workspace_write':'read_only';
   if(x.mode!==expected) problems.push(name+': contract mode '+x.mode+' does not match workflow '+expected);
   if(!Array.isArray(x.inputs)||!x.inputs.length) problems.push(name+': inputs required');
   if(!Array.isArray(x.outputs)||!x.outputs.length) problems.push(name+': outputs required');
   if(!Array.isArray(x.tools)||!x.tools.length) problems.push(name+': tools required');
 }
 return problems;
}
function roleContract(name){const c=load(CONTRACTS); if(!c.roles?.[name]) throw new Error('unknown subagent contract '+name); return {version:c.version,defaults:c.defaults||{},role:name,...c.roles[name]};}
let MCP_CACHE=null;
function availableMcps(){
 if(MCP_CACHE) return new Set(MCP_CACHE);
 const discovered=discoverMcps({projectRoot:PROJECT_ROOT,runtimeRoot:ROOT});
 const set=new Set([...discovered.names].map(normalizeMcpName));
 MCP_CACHE=[...set];
 return new Set(MCP_CACHE);
}
function assertRequiredMcps(name){
 const c=roleContract(name), available=availableMcps(), missing=(c.mcps_required||[]).filter(x=>!available.has(normalizeMcpName(x)));
 if(missing.length) throw new Error(`role "${name}" requires unavailable MCP(s): ${missing.join(', ')}; configure them or set AI_WORKFLOW_AVAILABLE_MCPS`);
 return true;
}
function selftest(){assert.deepStrictEqual(validate(),[]); const x=roleContract('security-review'); assert.equal(x.mode,'read_only'); assert(x.inputs.includes('changed_files')); assert.strictEqual(assertRequiredMcps('security-review'),true); console.log('subagent-contracts selftest OK');}
if(require.main===module){const cmd=process.argv[2]||'check'; try{if(cmd==='selftest') selftest(); else if(cmd==='show'){console.log(JSON.stringify(roleContract(process.argv[3]),null,2));} else {const p=validate(); if(p.length){p.forEach(x=>console.error('✗ '+x));process.exitCode=1;}else console.log('subagent contracts OK');}}catch(e){console.error('✗ '+e.message);process.exitCode=1;}}
module.exports={validate,roleContract,availableMcps,assertRequiredMcps};
