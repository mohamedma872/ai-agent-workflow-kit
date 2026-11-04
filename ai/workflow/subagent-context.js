"use strict";
const fs=require('fs'); const path=require('path'); const {spawnSync}=require('child_process');
const {retrieve,formatContext,loadRagConfig}=require('../rag/hybrid-rag');

const INPUT_FILES={
 request:['00-request.md'], acceptance_criteria:['02-acceptance-criteria.md'], definition_of_done:['03-definition-of-done.md'],
 inspection:['04-inspection.md'], approved_plan:['06-plan.md'], implementation:['07-implementation.md'], build_test:['08-build-test.md'], fixes:['10-fixes.md'],
 device_evidence:['device/mobile-device-qc.md']
};
// Where repositories keep their pull request template, in the order they are used.
const PR_TEMPLATES=['.github/pull_request_template.md','.github/PULL_REQUEST_TEMPLATE.md','.bitbucket/pull_request_template.md','docs/pull_request_template.md'];

function read(file){try{return fs.readFileSync(file,'utf8');}catch{return null;}}
// What the run changed: tracked changes against the run's base commit (so files
// the pull-request stage already committed still count) plus untracked files.
// `git diff HEAD` saw nothing once the runtime had committed, and never listed
// a brand-new file. Without a usable base it falls back to HEAD.
function changedFiles(productRoot,baseSha){
 if(!productRoot) return [];
 const base=baseSha&&/^[0-9a-f]{7,64}$/i.test(String(baseSha))&&spawnSync('git',['cat-file','-e',`${baseSha}^{commit}`],{cwd:productRoot,encoding:'utf8'}).status===0?String(baseSha):'HEAD';
 const r=spawnSync('git',['diff','--name-only','--no-renames',base,'--'],{cwd:productRoot,encoding:'utf8'});
 const u=spawnSync('git',['ls-files','--others','--exclude-standard'],{cwd:productRoot,encoding:'utf8'});
 const lines=[...(r.status===0?String(r.stdout||'').split('\n'):[]),...(u.status===0?String(u.stdout||'').split('\n'):[])];
 return [...new Set(lines.map(x=>x.trim()).filter(Boolean))];
}
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
// The human's conflict decisions (05-analysis/conflicts.json, written by
// `agentic resolve`). Raw conflicts.json is not given to roles: it holds
// unresolved entries, no finding titles and no size bound.
function resolvedConflicts(runDir){
 let d=null; try{d=JSON.parse(fs.readFileSync(path.join(runDir,'05-analysis','conflicts.json'),'utf8'));}catch{return [];}
 const seen=new Set();
 return (d?.conflicts||[]).filter(c=>c&&c.status==='resolved'&&c.resolution&&/^CONFLICT-\d+$/.test(String(c.id))&&!seen.has(c.id)&&seen.add(c.id));
}
function findingTitles(runDir){
 const dir=path.join(runDir,'05-analysis'), out=new Map(); let files=[];
 try{files=fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!['conflicts.json','synthesis.json','arbitration.json'].includes(f));}catch{return out;}
 for(const f of files){try{const d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));for(const x of d.findings||[])out.set(x.id,{agent:d.agent||f.replace(/\.json$/,''),severity:x.severity,title:x.title});}catch{}}
 return out;
}
// Binding for the plan (which must cite each id) and for every role after it.
function conflictDecisions(runDir,stageId){
 const list=resolvedConflicts(runDir); if(!list.length) return '';
 const titles=findingTitles(runDir), lines=[];
 const finding=id=>{const t=titles.get(id);return t?`${id} (${t.agent}, ${t.severity}: ${String(t.title||'').slice(0,120)})`:String(id);};
 for(const c of list){const r=c.resolution;lines.push(`### ${c.id} · ${String(c.topic||'disputed').slice(0,120)}\n- findings: ${(c.findings||[]).map(finding).join(' vs ')}\n- decision: ${String(r.decision||'').slice(0,1200)}\n- rationale: ${String(r.rationale||'').slice(0,400)}\n- owner: ${r.owner||'human'} (${String(r.resolvedAt||'').slice(0,10)})`);}
 const how=stageId==='plan'
  ?'Apply every decision in the steps and cite each conflict id in "conflictDecisions" (rendered as "Conflict decisions applied"): one entry per id saying how and in which steps it is applied. The engine rejects a plan that leaves out any id below.'
  :'The approved plan applies these under "Conflict decisions applied". Where the plan, AC or DoD still contradicts a decision, follow the decision and say so.';
 return `## Binding conflict decisions (05-analysis/conflicts.json)\nA human resolved these specialist disagreements. Each decision is binding: it overrides any specialist recommendation, and any acceptance-criteria, definition-of-done or plan wording, that it contradicts.\n${how}\n\n${lines.join('\n\n')}`.slice(0,12000);
}
function prTemplate(productRoot){if(!productRoot)return null;for(const rel of PR_TEMPLATES){const t=read(path.join(productRoot,rel));if(t&&t.trim())return {path:rel,text:t};}return null;}
function prTemplateSection(productRoot){
 const t=prTemplate(productRoot);
 if(!t) return `## Pull request template\nThis repository has no pull request template (looked for ${PR_TEMPLATES.join(', ')}). Use these sections: Summary, Changes, How it was tested, Definition of Done, Left for a human to run. Set "template" to null.`;
 return `## Pull request template (${t.path})\nFill every section of this template in "body", keeping its headings and checkboxes. Set "template" to "${t.path}".\n\n${t.text.slice(0,12000)}`;
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
function retrievalQuery(runDir,roleName,productRoot,baseSha){
 const parts=[`workflow role: ${roleName||'unknown'}`];
 for(const f of ['00-request.md','01-requirements.md','02-acceptance-criteria.md','03-definition-of-done.md','04-inspection.md']){const t=read(path.join(runDir,f));if(t)parts.push(t.slice(0,7000));}
 const changed=productRoot?changedFiles(productRoot,baseSha):[];if(changed.length)parts.push('changed files:\n'+changed.join('\n'));
 return parts.join('\n\n');
}
function safeName(v){return String(v||'role').replace(/[^A-Za-z0-9._-]+/g,'-').slice(0,100);}
function hybridRagContext({runDir,productRoot,contract,roleName,stageId,baseSha}){
 const projectRag=productRoot?loadRagConfig(productRoot):null;
 const cfg=retrievalSettings(contract,projectRag);
 if(!['hybrid','hybrid_rag','hybrid-rag'].includes(cfg.mode))return '';
 if(!Array.isArray(contract?.tools)||!contract.tools.includes('repository_read')||!productRoot||!fs.existsSync(productRoot))return '';
 const pack=retrieve({root:productRoot,query:retrievalQuery(runDir,roleName,productRoot,baseSha),role:roleName,topK:cfg.topK,maxContextChars:cfg.maxContextChars,maxExcerptChars:cfg.maxExcerptChars,maxPerFile:cfg.maxPerFile});
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

function buildRoleContext({runDir,productRoot,contract,excludeArtifact,roleName,stageId,baseSha}){
 const sections=[];
 const failures=failureFeedback(runDir,stageId,roleName);if(failures)sections.push(failures);
 for(const input of contract.inputs||[]){
   if(INPUT_FILES[input]) for(const f of INPUT_FILES[input]){const t=read(path.join(runDir,f));if(t)sections.push(`## ${f}\n${t.slice(0,16000)}`);}
   else if(input==='changed_files') sections.push('## Changed files\n'+(changedFiles(productRoot,baseSha).join('\n')||'(none)'));
   else if(input==='specialist_findings'){const t=specialistFindings(runDir);if(t)sections.push(t);}
   else if(input==='conflict_decisions'){const t=conflictDecisions(runDir,stageId);if(t)sections.push(t);}
   else if(input==='validated_review_findings'){const t=reviewArtifacts(runDir);if(t)sections.push(t);}
   else if(input==='dependency_versions'){const t=dependencyVersions(productRoot);if(t)sections.push(t);}
   else if(input==='pr_template') sections.push(prTemplateSection(productRoot));
   else if(input==='refactor_verification_matrix'){const t=read(path.join(runDir,'engine','refactor-verification-matrix.json'));if(t)sections.push('## Refactor verification matrix\n'+t);}
   else if(input==='run_artifacts'||input==='repository_evidence'){const t=broadArtifacts(runDir,excludeArtifact);if(t)sections.push(t);}
 }
 const rag=hybridRagContext({runDir,productRoot,contract,roleName,stageId,baseSha});if(rag)sections.push(rag);
 return sections.join('\n\n');
}
module.exports={PR_TEMPLATES,prTemplate,specialistFindings,resolvedConflicts,conflictDecisions,failureFeedback,buildRoleContext,changedFiles,dependencyVersions,retrievalSettings,retrievalQuery,hybridRagContext};
