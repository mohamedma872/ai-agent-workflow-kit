'use strict';
const fs=require('fs'); const path=require('path'); const yaml=require('js-yaml');
function loadContracts(root){try{return yaml.load(fs.readFileSync(path.join(root,'ai','subagents','contracts.yaml'),'utf8'))||{};}catch{return {};}}
function mcpName(tool){const m=String(tool||'').match(/^mcp__([^_]+(?:_[^_]+)*)__/);return m?m[1].toLowerCase():null;}
function declaredMcps(c){return new Set([...(c.mcps_required||[]),...(c.mcps_optional||[])].map(x=>String(x).toLowerCase()));}
function capabilityDecision(payload,env=process.env){
 const role=env.AI_WORKFLOW_ROLE; if(!role) return {allow:true,reason:'no workflow role'};
 const root=env.AI_WORKFLOW_RUNTIME_ROOT||env.CLAUDE_PROJECT_DIR||process.cwd();
 const all=loadContracts(root), c=all.roles?.[role]; if(!c) return {allow:false,reason:`role "${role}" has no subagent contract`};
 const tool=String(payload?.tool_name||''), input=payload?.tool_input||{}, tools=new Set(c.tools||[]);
 if(tool.startsWith('mcp__')){
   const server=mcpName(tool); const allowed=declaredMcps(c);
   const match=[...allowed].some(x=>server===x||server?.includes(x)||x.includes(server||''));
   return match?{allow:true,reason:`MCP ${server} declared`}:{allow:false,reason:`role "${role}" may not use undeclared MCP "${server||tool}"`};
 }
 if(['Write','Edit','MultiEdit','NotebookEdit','apply_patch'].includes(tool))
   return tools.has('product_write')?{allow:true,reason:'product_write declared'}:{allow:false,reason:`role "${role}" is not allowed to write product files`};
 if(tool==='Agent') return {allow:false,reason:`role "${role}" may not spawn nested agents`};
 if(tool==='Bash'||tool==='Shell'){
   const cmd=String(input.command||'');
   const mut=/\b(?:rm|mv|cp|touch|mkdir|install|patch|sed\s+-i|perl\s+-pi|git\s+(?:commit|push|reset|clean|checkout|merge|rebase))\b|(?:>>|>)(?!=)|writeFile|appendFile|rename|unlink|copyFile/i.test(cmd);
   if(!mut) return tools.has('repository_read')||tools.has('test_execute')||tools.has('device_execute')?{allow:true,reason:'read/execute capability declared'}:{allow:false,reason:`role "${role}" has no shell capability`};
   if(tools.has('product_write')) return {allow:true,reason:'product_write declared'};
   if(tools.has('test_execute') && /\b(?:npm|yarn|pnpm|gradle|gradlew|xcodebuild|flutter|pytest|jest|vitest|detox|appium)\b/i.test(cmd)) return {allow:true,reason:'test_execute declared'};
   if(tools.has('device_execute') && /\b(?:adb|xcrun|appium|simctl)\b/i.test(cmd)) return {allow:true,reason:'device_execute declared'};
   return {allow:false,reason:`role "${role}" may not run mutating shell commands`};
 }
 return {allow:true,reason:'tool not capability-scoped'};
}

function selftest(){
 const assert=require('assert'); const env={AI_WORKFLOW_ROLE:'security-review',AI_WORKFLOW_RUNTIME_ROOT:path.resolve(__dirname,'..','..')};
 assert.strictEqual(capabilityDecision({tool_name:'Write',tool_input:{file_path:'src/a.js'}},env).allow,false);
 assert.strictEqual(capabilityDecision({tool_name:'Read',tool_input:{file_path:'src/a.js'}},env).allow,true);
 assert.strictEqual(capabilityDecision({tool_name:'mcp__context7__get_library_docs',tool_input:{}},env).allow,true);
 assert.strictEqual(capabilityDecision({tool_name:'mcp__appium__create_session',tool_input:{}},env).allow,false);
 const impl={...env,AI_WORKFLOW_ROLE:'implementation'};
 assert.strictEqual(capabilityDecision({tool_name:'Write',tool_input:{file_path:'src/a.js'}},impl).allow,true);
 console.log('subagent-capabilities selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={capabilityDecision,mcpName,loadContracts};
