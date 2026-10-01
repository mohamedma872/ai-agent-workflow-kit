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
   // `2>&1` duplicates a file descriptor, it does not write a file, but it
   // contains ">" and so read every read-only role's most ordinary way of
   // capturing output as a mutation: `flutter test 2>&1 | tail -5` was denied
   // while plain `flutter test` was allowed. That is why the verification stage
   // could not independently re-run the tests its own definition of done asked
   // for. Descriptor duplication is removed before deciding.
   const cmdForMut=cmd.replace(/\d*>&\d+/g,' ');
   // A verb only mutates when it is the command being run. Matching it anywhere
   // in the string meant ordinary ARGUMENT text was read as shell syntax: the
   // screenshot checkpoint `--name 01-fresh-install-login` matched \binstall\b
   // (a hyphen is a word boundary) and `02-rename-flow` matched \brename\b, so
   // the runtime's own capture command was refused and the device evidence
   // stage could not produce a single screenshot.
   const MUTATING_VERB=/^(?:sudo\s+)?(?:rm|mv|cp|ln|touch|mkdir|install|patch|dd|tee)\b/i;
   const segments=cmdForMut.split(/\|\||&&|[;|]/);
   const mutVerb=segments.some(seg=>MUTATING_VERB.test(seg.trim()));
   // These stay matched anywhere, because they are unambiguous as written: an
   // fs call needs its parenthesis, and a package install names its manager.
   const mutInline=/\bsed\s+-i\b|\bperl\s+-p?i\b|\bgit\s+(?:commit|push|reset|clean|checkout|merge|rebase)\b|(?:>>|>)(?!=)|\b(?:writeFile|appendFile|copyFile|rename|unlink)(?:Sync)?\s*\(|\b(?:npm|yarn|pnpm|bundle|gem|pip3?|brew|pod)\s+(?:install|add|ci)\b/i.test(cmdForMut);
   const mut=mutVerb||mutInline;
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
 // `2>&1` duplicates a descriptor, it does not write a file. Denying it stopped
 // read-only roles capturing command output at all, which is why verification
 // could not re-run the tests its definition of done required.
 const orch={...env,AI_WORKFLOW_ROLE:'orchestration'};
 assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:'flutter test 2>&1'}},orch).allow,true);
 assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:'flutter analyze 2>&1 | tail -5'}},orch).allow,true);
 // A real file write is still a write.
 assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:'flutter test > out.txt'}},orch).allow,false);
 assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:'echo x >> lib/main.dart'}},orch).allow,false);
 assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:'rm -rf lib'}},orch).allow,false);
 // Argument text is not shell syntax. A screenshot checkpoint named
 // 01-fresh-install-login matched \binstall\b (a hyphen is a word boundary) and
 // 02-rename-flow matched \brename\b, so the runtime's own capture command was
 // refused and the device evidence stage produced no screenshots at all.
 const eve={...env,AI_WORKFLOW_ROLE:'mobile-evidence'};
 const cap=n=>({tool_name:'Bash',tool_input:{command:`node /k/mobile-evidence.js capture C --platform ios --name ${n}`}});
 for(const n of ['01-fresh-install-login','02-rename-flow','03-remove-account','04-launch'])
   assert.strictEqual(capabilityDecision(cap(n),eve).allow,true,`checkpoint name ${n} must not read as a mutation`);
 assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:'grep -rn "install" lib 2>&1'}},env).allow,true);
 // A verb in command position still mutates, wherever in the pipeline it sits.
 for(const c of ['rm -rf lib','sudo rm -rf /','mv a b','cp a b','mkdir -p x','touch f','ls && rm -rf build','cat a | tee lib/main.dart'])
   assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:c}},env).allow,false,`${c} must be denied`);
 // And so do package installs, git history rewrites and fs calls.
 for(const c of ['npm install left-pad','pod install','git commit -m x','git push',"node -e \"require('fs').writeFileSync('a','b')\""])
   assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:c}},env).allow,false,`${c} must be denied`);
 const impl={...env,AI_WORKFLOW_ROLE:'implementation'};
 assert.strictEqual(capabilityDecision({tool_name:'Write',tool_input:{file_path:'src/a.js'}},impl).allow,true);
 console.log('subagent-capabilities selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={capabilityDecision,mcpName,loadContracts};
