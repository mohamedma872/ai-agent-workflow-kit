'use strict';
const fs=require('fs'); const path=require('path'); const crypto=require('crypto'); const {spawnSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..','..','..'); const ROUTER=path.join(ROOT,'ai','workflow','router.js'); const WORKFLOW=path.join(ROOT,'ai','workflows','feature.yaml');
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
// The role's specialist instructions (.claude/agents/<claude_subagent>.md, frontmatter stripped) go into the
// eval prompt, so a case measures the prompt /feature actually delegates with. The router path alone never
// loads these files. AI_EVAL_AGENT_NAME + AI_EVAL_AGENT_PROMPT_FILE swap in a candidate prompt for that one
// subagent (ai/evals/hillclimb.js) without touching .claude/agents.
function subagentFor(role){try{const w=require('js-yaml').load(fs.readFileSync(WORKFLOW,'utf8'))||{};return ((w.roles||{})[role]||{}).claude_subagent||null;}catch{return null;}}
function specialist(role){
 const name=subagentFor(role); if(!name)return null;
 const override=process.env.AI_EVAL_AGENT_NAME===name&&process.env.AI_EVAL_AGENT_PROMPT_FILE?path.resolve(ROOT,process.env.AI_EVAL_AGENT_PROMPT_FILE):null;
 const file=override||path.join(ROOT,'.claude','agents',name+'.md');
 if(!fs.existsSync(file))throw new Error('specialist prompt missing: '+path.relative(ROOT,file));
 const body=fs.readFileSync(file,'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();
 return {name,file:path.relative(ROOT,file),override:!!override,sha:crypto.createHash('sha256').update(body).digest('hex').slice(0,12),body};
}
module.exports={
 name:'subagent',
 description:'Isolated specialist subagent evals routed through the deterministic workflow router',
 entry:'ai/workflow/router.js exec feature <role>',
 resultsDir:'ai/evals/results/subagent',
 agents:['claude'],
 defaults:{agent:'claude',budget:3,timeoutMin:12,permissionMode:'bypassPermissions'},
 preflight(opts){if(spawnSync('which',['claude']).status!==0)throw new Error('claude is not on PATH');},
 describe(c){return `${c.role} / ${c.case_id}`;},
 execute(c,runDir,opts){
   const fixture=path.resolve(ROOT,c.fixture||''); if(!fs.existsSync(fixture))throw new Error('fixture missing: '+c.fixture);
   const promptFile=path.join(runDir,'prompt.md'), outputFile=path.join(runDir,'subagent-output.json');
   const spec=specialist(c.role);
   const prompt=`# Subagent eval\n\nRole: ${c.role}\nFixture: ${c.fixture}\n\n${spec?`## Specialist instructions (${spec.name})\n\n${spec.body}\n\n## Task\n\n`:''}Inspect only the seeded fixture plus repository configuration needed to interpret it. ${c.prompt||''}\n\nReturn ONLY JSON with this shape:\n{"schemaVersion":1,"runId":"EVAL","agent":"${c.role}","status":"pass","findings":[{"id":"...","title":"...","severity":"high|medium|low|info|critical","uncertainty":"confirmed|likely|possible|unknown","confidence":0.0,"evidence":[{"source":"${c.fixture}","line":1,"detail":"..."}],"recommendation":"...","tags":[]}]}\nDo not invent findings. Empty findings is valid when the fixture is safe.\n`;
   fs.mkdirSync(runDir,{recursive:true}); fs.writeFileSync(promptFile,prompt);
   const specMeta=spec?{name:spec.name,file:spec.file,sha:spec.sha,override:spec.override}:null;
   if(opts.dryRun)return {role:c.role,fixture:c.fixture,prompt:promptFile,specialist:specMeta};
   const t0=Date.now();
   const res=spawnSync(process.execPath,[ROUTER,'exec','feature',c.role,'--agent','claude','--prompt-file',promptFile,'--output-file',outputFile,'--timeout-min',String(opts.timeoutMin||12)],{cwd:ROOT,env:{...process.env,AI_EVAL:'1',FEATURE_RUN_ID:'EVAL'},encoding:'utf8',timeout:(opts.timeoutMin||12)*60000,maxBuffer:64*1024*1024});
   fs.writeFileSync(path.join(runDir,'stderr.log'),res.stderr||'');
   fs.writeFileSync(path.join(runDir,'run-meta.json'),JSON.stringify({status:res.status,duration_min:+((Date.now()-t0)/60000).toFixed(2),role:c.role,fixture:c.fixture,specialist:specMeta},null,2));
   return {status:res.status};
 },
 collect(runDir,c){
   const out=readJson(path.join(runDir,'subagent-output.json')); const meta=readJson(path.join(runDir,'run-meta.json'))||{};
   if(!out)return null;
   const findings=Array.isArray(out.findings)?out.findings:[]; const violations=[];
   for(const pat of c.forbidden_findings||[]){const re=new RegExp(pat,'i');if(findings.some(f=>re.test(JSON.stringify(f))))violations.push('forbidden finding matched '+pat);}
   const outputs=findings.map(f=>({kind:'finding',text:JSON.stringify(f)}));
   const expectedSeverity=Object.fromEntries((c.must_report||[]).map(x=>[x.name,x.severity||'medium']));
   return {outputs,complete:meta.status===0,verdict:violations.length?'FAIL':'PASS',duration_min:meta.duration_min??null,cost_usd:null,models:[],extra:{role:c.role,fixture:c.fixture,findings:findings.length,violations,expectedSeverity,specialist:meta.specialist||null}};
 },
 specialist,
 matches(output,expected){const text=String(output.text||'').toLowerCase();return (expected.match||[]).some(group=>group.every(k=>text.includes(String(k).toLowerCase())));}
};
