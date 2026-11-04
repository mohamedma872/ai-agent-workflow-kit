'use strict';
const fs=require('fs'); const path=require('path'); const yaml=require('js-yaml');
function loadContracts(root){try{return yaml.load(fs.readFileSync(path.join(root,'ai','subagents','contracts.yaml'),'utf8'))||{};}catch{return {};}}
function mcpName(tool){const m=String(tool||'').match(/^mcp__([^_]+(?:_[^_]+)*)__/);return m?m[1].toLowerCase():null;}
function declaredMcps(c){return new Set([...(c.mcps_required||[]),...(c.mcps_optional||[])].map(x=>String(x).toLowerCase()));}
// Publishing is the runtime's job, never an agent's. The pull-request stage
// commits, pushes and opens the PR from Node (ai/workflow/pull-request.js),
// which does not pass through this hook, so these denials hold for every role,
// including those that may write product files, without touching the runtime.
//
// git and gh take global options between the binary and the subcommand
// (`git -C . push`, `git -c core.hooksPath=/dev/null push`, `gh -R o/r pr
// create`), so a regex anchored on "git push" let them through. The command is
// split into words instead and every git/gh invocation in it is parsed the way
// the tool reads its own argv: options (with their values) are skipped, and the
// first word after them is the subcommand. No backtracking regex is involved,
// so an adversarial command line cannot stall the hook either.
const GIT_VALUE_OPTS=new Set(['-c','--git-dir','--work-tree','--namespace','--exec-path','--super-prefix','--config-env','--attr-source','--list-cmds']);
const GH_VALUE_OPTS=new Set(['-r','--repo','--hostname']);
function words(cmd){return String(cmd||'').split(/[\s;&|()`'"<>{}$\\]+/).filter(Boolean);}
function skipOptions(w,j,valueOpts){
 while(j<w.length&&w[j].startsWith('-')){const flag=w[j].toLowerCase();j+=valueOpts.has(flag)?2:1;}
 return j;
}
// Every git subcommand the line runs: `git [global options] <sub>` and the
// dashed `git-<sub>` form (git-send-pack and friends live on the exec path).
function gitSubcommands(cmd){
 const w=words(cmd), out=[];
 for(let i=0;i<w.length;i++){
   const base=w[i].split('/').pop().toLowerCase();
   if(base==='git'){const j=skipOptions(w,i+1,GIT_VALUE_OPTS);if(j<w.length)out.push(w[j].toLowerCase());}
   else if(/^git-[a-z-]+$/.test(base)) out.push(base.slice(4));
 }
 return out;
}
// Every `gh [options] <command> [options] <subcommand>` pair the line runs, plus
// the words after it (for `gh api …/pulls`).
function ghCommands(cmd){
 const w=words(cmd), out=[];
 for(let i=0;i<w.length;i++){
   if(w[i].split('/').pop().toLowerCase()!=='gh') continue;
   const j=skipOptions(w,i+1,GH_VALUE_OPTS); if(j>=w.length) continue;
   const k=skipOptions(w,j+1,GH_VALUE_OPTS);
   out.push({command:w[j].toLowerCase(),sub:k<w.length?w[k].toLowerCase():null,rest:w.slice(j+1)});
 }
 return out;
}
const GH_PR_WRITES=new Set(['create','new','merge','ready','edit','reopen']);
const DELIVERY=[
 [cmd=>gitSubcommands(cmd).some(s=>s==='push'||s==='send-pack'),'git push'],
 [/\bgit\s+push\b/i,'git push'],
 [cmd=>ghCommands(cmd).some(c=>c.command==='pr'&&GH_PR_WRITES.has(c.sub)),'gh pr create/merge'],
 [/\bgh\b[^\n|;&]*\bpr\s+(?:create|new|merge|ready|edit|reopen)\b/i,'gh pr create/merge'],
 [cmd=>ghCommands(cmd).some(c=>c.command==='api'&&c.rest.some(x=>/\/pulls\b/i.test(x))),'gh api …/pulls'],
 [/\bgh\s+api\b[^\n]*\/pulls\b/i,'gh api …/pulls'],
 [/\bagentic\s+pr\b/i,'agentic pr'],
 [/\bengine\.js\s+pr\b/i,'engine.js pr'],
 [/\bpull-request(?:\.js|-options)\b/i,'the pull-request runtime'],
 [/\bapi\.bitbucket\.org\b[^\n]*\/pullrequests\b/i,'the Bitbucket pull request API'],
 [/\bapi\.github\.com\b[^\n]*\/pulls\b/i,'the GitHub pull request API'],
];
const GIT_MUTATING=new Set(['commit','push','send-pack','reset','clean','checkout','merge','rebase']);
const GIT_MUTATION={test:cmd=>gitSubcommands(cmd).some(s=>GIT_MUTATING.has(s))||/\bgit\s+(?:commit|push|reset|clean|checkout|merge|rebase)\b/i.test(cmd)};
function deliveryDenial(role,cmd){
 const hit=DELIVERY.find(([rule])=>typeof rule==='function'?rule(cmd):rule.test(cmd));
 return hit?{allow:false,reason:`role "${role}" may not publish (${hit[1]}): the runtime pushes and opens the pull request after verification`}:null;
}
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
   const delivery=deliveryDenial(role,cmd); if(delivery) return delivery;
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
   const mutInline=GIT_MUTATION.test(cmdForMut)||/\bsed\s+-i\b|\bperl\s+-p?i\b|(?:>>|>)(?!=)|\b(?:writeFile|appendFile|copyFile|rename|unlink)(?:Sync)?\s*\(|\b(?:npm|yarn|pnpm|bundle|gem|pip3?|brew|pod)\s+(?:install|add|ci)\b/i.test(cmdForMut);
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
 // No agent publishes, not even one that may write product files: the runtime
 // pushes and opens the pull request itself.
 for(const role of ['implementation','fixes','orchestration','pr-description','code-review'])
   for(const c of ['git push','git push -u origin HEAD:refs/heads/ai/X','gh pr create --fill','gh pr merge 3',
     // Global options before the subcommand, and the plumbing behind push.
     'git -C . push origin HEAD:refs/heads/x','git -c core.hooksPath=/dev/null push','git -c a=b push','git --no-pager push','git --git-dir=.git push','git --git-dir .git --work-tree . push','git -C. push','git send-pack origin HEAD:refs/heads/x','git-send-pack origin HEAD:refs/heads/x',
     'gh -R o/r pr create --fill','gh --repo o/r pr create -t x -b y','gh --repo=o/r pr merge 3','gh pr -R o/r create --fill','gh --hostname h pr ready 3','gh -R o/r api repos/o/r/pulls -f title=x','agentic pr FEAT-1 --base main','node /k/ai/workflow/engine.js pr FEAT-1','node /k/ai/tasks/feature/runs.js pull-request-options FEAT-1','node /k/ai/workflow/pull-request.js --http','curl -X POST https://api.bitbucket.org/2.0/repositories/ws/app/pullrequests','gh api repos/o/r/pulls -f title=x'])
     assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:c}},{...env,AI_WORKFLOW_ROLE:role}).allow,false,`${role}: ${c} must be denied`);
 assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:'git status && git log -1'}},impl).allow,true,'reading git state is fine');
 for(const c of ['git -C . status','git --no-pager log -1','git -c core.pager=cat diff HEAD','gh pr view 3','gh -R o/r pr list','gh pr checks 3','grep -rn "git push" docs'])
   if(c.startsWith('grep')) assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:c}},impl).allow,false,'a search for the text is still caught; harmless, and safer than a gap');
   else assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:c}},impl).allow,true,`${c} only reads`);
 // A read-only role may not mutate git state through global options either.
 for(const c of ['git -C . commit -m x','git -c a=b reset --hard','git --no-pager checkout main'])
   assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:c}},env).allow,false,`${c} must be denied to a read-only role`);
 assert.strictEqual(capabilityDecision({tool_name:'Bash',tool_input:{command:'git push'}},{AI_WORKFLOW_RUNTIME_ROOT:env.AI_WORKFLOW_RUNTIME_ROOT}).allow,true,'outside an agentic role the hook does not apply');
 console.log('subagent-capabilities selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest')) selftest();
module.exports={capabilityDecision,mcpName,loadContracts,gitSubcommands,ghCommands};
