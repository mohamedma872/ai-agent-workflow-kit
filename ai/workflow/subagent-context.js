"use strict";
const fs=require('fs'); const path=require('path'); const {spawnSync}=require('child_process');
const {retrieve,formatContext,loadRagConfig}=require('../rag/hybrid-rag');
const {specsSettings,specsContext}=require('./specs');

const INPUT_FILES={
 request:['00-request.md'], acceptance_criteria:['02-acceptance-criteria.md'], definition_of_done:['03-definition-of-done.md'],
 inspection:['04-inspection.md'], approved_plan:['06-plan.md'], implementation:['07-implementation.md'], build_test:['08-build-test.md'], fixes:['10-fixes.md']
};

function read(file){try{return fs.readFileSync(file,'utf8');}catch{return null;}}
function changedFiles(productRoot){const r=spawnSync('git',['diff','--name-only','HEAD'],{cwd:productRoot,encoding:'utf8'});return r.status===0?String(r.stdout||'').trim().split('\n').filter(Boolean):[];}
function dependencyVersions(productRoot){const out=[];for(const name of ['package.json','pubspec.yaml','gradle.properties','build.gradle','build.gradle.kts','Podfile']){const t=read(path.join(productRoot,name));if(t)out.push(`## ${name}\n${t.slice(0,12000)}`);}return out.join('\n\n');}
function reviewArtifacts(runDir){const d=path.join(runDir,'09-reviews');try{return fs.readdirSync(d).filter(f=>f.endsWith('.md')).sort().map(f=>`## 09-reviews/${f}\n${read(path.join(d,f)).slice(0,12000)}`).join('\n\n');}catch{return '';}}
// Every specialist finding, with the ids the arbitration role must quote back.
// Specialists never see each other, so this is the only place in the workflow
// where one agent can compare two of them and say they disagree.
function specialistFindings(runDir){
 const dir=path.join(runDir,'05-analysis'); let files=[];
 try{files=fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!['conflicts.json','synthesis.json','arbitration.json'].includes(f)).sort();}catch{return '';}
 const lines=[];
 for(const f of files){
  let d=null; try{d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));}catch{continue;}
  if(!Array.isArray(d.findings)||!d.findings.length) continue;
  lines.push(`### ${d.agent||f.replace(/\.json$/,'')}`);
  for(const x of d.findings) lines.push(`- ${x.id} [${x.severity}] ${String(x.title||'').slice(0,200)}\n  tags: ${(x.tags||[]).join(', ')||'(none)'}\n  recommendation: ${String(x.recommendation||'').slice(0,400)}`);
 }
 return lines.length?`## Specialist findings\n${lines.join('\n')}`:'';
}
function broadArtifacts(runDir,exclude){try{return fs.readdirSync(runDir).filter(f=>/^\d\d-.*\.md$/.test(f)&&f!==exclude).sort().map(f=>`## ${f}\n${read(path.join(runDir,f)).slice(0,12000)}`).join('\n\n');}catch{return '';}}

// Precedence: contract's per-role `retrieval:` (if a role ever sets one) wins over
// the project's `.agentic/config.yaml` rag: section, which wins over contracts.yaml's
// global `defaults.retrieval`. `projectRag` keys already match contract key names
// (see hybrid-rag.js loadRagConfig), so the three merge without translation.
function retrievalSettings(contract,projectRag){
 const specific=contract?.retrieval;
 if(specific===false||specific==='none'||(projectRag&&projectRag.enabled===false))return {mode:'off',topK:8,maxContextChars:24000,maxExcerptChars:4200,maxPerFile:2};
 const defaults=contract?.defaults?.retrieval||{};
 const cfg={...defaults,...(projectRag||{}),...(typeof specific==='object'?specific:{})};
 return {mode:String(cfg.mode||'off').toLowerCase(),topK:Number(cfg.top_k||cfg.topK||8),maxContextChars:Number(cfg.max_context_chars||cfg.maxContextChars||24000),maxExcerptChars:Number(cfg.max_excerpt_chars||cfg.maxExcerptChars||4200),maxPerFile:Number(cfg.max_per_file||cfg.maxPerFile||2)};
}
function retrievalQuery(runDir,roleName,productRoot){
 const parts=[`workflow role: ${roleName||'unknown'}`];
 for(const f of ['00-request.md','01-requirements.md','02-acceptance-criteria.md','03-definition-of-done.md','04-inspection.md']){const t=read(path.join(runDir,f));if(t)parts.push(t.slice(0,7000));}
 const changed=productRoot?changedFiles(productRoot):[];if(changed.length)parts.push('changed files:\n'+changed.join('\n'));
 return parts.join('\n\n');
}
function safeName(v){return String(v||'role').replace(/[^A-Za-z0-9._-]+/g,'-').slice(0,100);}
function hybridRagContext({runDir,productRoot,contract,roleName,stageId}){
 const projectRag=productRoot?loadRagConfig(productRoot):null;
 const cfg=retrievalSettings(contract,projectRag);
 if(!['hybrid','hybrid_rag','hybrid-rag'].includes(cfg.mode))return '';
 if(!Array.isArray(contract?.tools)||!contract.tools.includes('repository_read')||!productRoot||!fs.existsSync(productRoot))return '';
 const pack=retrieve({root:productRoot,query:retrievalQuery(runDir,roleName,productRoot),role:roleName,topK:cfg.topK,maxContextChars:cfg.maxContextChars,maxExcerptChars:cfg.maxExcerptChars,maxPerFile:cfg.maxPerFile});
 const outDir=path.join(runDir,'engine','rag-context');fs.mkdirSync(outDir,{recursive:true});
 fs.writeFileSync(path.join(outDir,`${safeName(stageId||'stage')}-${safeName(roleName||'role')}.json`),JSON.stringify(pack,null,2)+'\n');
 return formatContext(pack);
}
// Why the previous attempt failed, and why any later stage is blocked. Without
// this a retried or reworked role runs blind: it never learns that its output
// was rejected, or that the tests it wrote hang, so it repeats the same mistake.
function failureFeedback(runDir,stageId,roleName){
 let state=null; try{state=JSON.parse(fs.readFileSync(path.join(runDir,'state.json'),'utf8'));}catch{return '';}
 const lines=[];
 const own=(state.executionAttempts?.[stageId]?.[roleName]||[]).filter(a=>a&&a.ok===false||a?.reason);
 for(const attempt of own.slice(-2)) if(attempt.reason) lines.push(`- this role, attempt ${attempt.attempt||''}: ${String(attempt.reason).slice(0,600)}`);
 // Failures survive a retry/rework as lastFailures, because clearing the spent
 // attempts is what lets the work run again.
 for(const [phase,roles] of Object.entries(state.lastFailures||{})){
  for(const [role,info] of Object.entries(roles||{})) if(info?.reason) lines.push(`- previous ${phase}/${role} failure: ${String(info.reason).slice(0,600)}`);
 }
 const order=Object.keys(state.phases||{});
 for(const phase of order){
  if(phase===stageId) continue;
  const entry=state.phases[phase];
  const failed=entry&&['fail','blocked'].includes(entry.status);
  if(failed&&entry.note) lines.push(`- stage ${phase} is ${entry.status}: ${String(entry.note).slice(0,600)}`);
  for(const [role,rs] of Object.entries(state.roles?.[phase]||{})){
   if(!rs?.note) continue;
   if(!failed&&!['fail','blocked'].includes(rs.status)) continue;
   lines.push(`- ${phase}/${role} (${rs.status}): ${String(rs.note).slice(0,600)}`);
  }
  // Not every stage has roles in state (only parallel groups do), so rejected
  // outputs are found on disk rather than through the role map.
  let engineFiles=[]; try{engineFiles=fs.readdirSync(path.join(runDir,'engine'));}catch{engineFiles=[];}
  for(const file of engineFiles){
   if(!file.startsWith(`${phase}-`)||!file.endsWith('.rejected')) continue;
   const rejected=read(path.join(runDir,'engine',file));
   if(rejected) lines.push(`- ${file} (rejected output excerpt):\n\`\`\`\n${rejected.slice(0,1500)}\n\`\`\``);
  }
 }
 if(!lines.length) return '';
 return `## Previous failures to address\n\nThese are recorded failures from this run. Fix the cause named here rather than re-doing the same work.\n\n${lines.join('\n')}`;
}

function buildRoleContext({runDir,productRoot,contract,excludeArtifact,roleName,stageId}){
 const sections=[];
 const failures=failureFeedback(runDir,stageId,roleName);if(failures)sections.push(failures);
 for(const input of contract.inputs||[]){
   if(INPUT_FILES[input]) for(const f of INPUT_FILES[input]){const t=read(path.join(runDir,f));if(t)sections.push(`## ${f}\n${t.slice(0,16000)}`);}
   else if(input==='changed_files') sections.push('## Changed files\n'+(changedFiles(productRoot).join('\n')||'(none)'));
   else if(input==='existing_specs'){const cfg=specsSettings(productRoot);if(cfg.enabled){const t=specsContext(productRoot,cfg.dir);if(t)sections.push(t);}}
   else if(input==='specialist_findings'){const t=specialistFindings(runDir);if(t)sections.push(t);}
   else if(input==='validated_review_findings'){const t=reviewArtifacts(runDir);if(t)sections.push(t);}
   else if(input==='dependency_versions'){const t=dependencyVersions(productRoot);if(t)sections.push(t);}
   else if(input==='refactor_verification_matrix'){const t=read(path.join(runDir,'engine','refactor-verification-matrix.json'));if(t)sections.push('## Refactor verification matrix\n'+t);}
   else if(input==='run_artifacts'||input==='repository_evidence'){const t=broadArtifacts(runDir,excludeArtifact);if(t)sections.push(t);}
 }
 const rag=hybridRagContext({runDir,productRoot,contract,roleName,stageId});if(rag)sections.push(rag);
 return sections.join('\n\n');
}
module.exports={specialistFindings,failureFeedback,buildRoleContext,changedFiles,dependencyVersions,retrievalSettings,retrievalQuery,hybridRagContext};
