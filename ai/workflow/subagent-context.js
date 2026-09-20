"use strict";
const fs=require('fs'); const path=require('path'); const {spawnSync}=require('child_process');
const {retrieve,formatContext}=require('../rag/hybrid-rag');

const INPUT_FILES={
 request:['00-request.md'], acceptance_criteria:['02-acceptance-criteria.md'], definition_of_done:['03-definition-of-done.md'],
 inspection:['04-inspection.md'], approved_plan:['06-plan.md'], implementation:['07-implementation.md'], build_test:['08-build-test.md'], fixes:['10-fixes.md']
};

function read(file){try{return fs.readFileSync(file,'utf8');}catch{return null;}}
function changedFiles(productRoot){const r=spawnSync('git',['diff','--name-only','HEAD'],{cwd:productRoot,encoding:'utf8'});return r.status===0?String(r.stdout||'').trim().split('\n').filter(Boolean):[];}
function dependencyVersions(productRoot){const out=[];for(const name of ['package.json','pubspec.yaml','gradle.properties','build.gradle','build.gradle.kts','Podfile']){const t=read(path.join(productRoot,name));if(t)out.push(`## ${name}\n${t.slice(0,12000)}`);}return out.join('\n\n');}
function reviewArtifacts(runDir){const d=path.join(runDir,'09-reviews');try{return fs.readdirSync(d).filter(f=>f.endsWith('.md')).sort().map(f=>`## 09-reviews/${f}\n${read(path.join(d,f)).slice(0,12000)}`).join('\n\n');}catch{return '';}}
function broadArtifacts(runDir,exclude){try{return fs.readdirSync(runDir).filter(f=>/^\d\d-.*\.md$/.test(f)&&f!==exclude).sort().map(f=>`## ${f}\n${read(path.join(runDir,f)).slice(0,12000)}`).join('\n\n');}catch{return '';}}

function retrievalSettings(contract){
 const specific=contract?.retrieval, defaults=contract?.defaults?.retrieval;
 const cfg=specific===false||specific==='none'?{mode:'off'}:(specific||defaults||{});
 return {mode:String(cfg.mode||'off').toLowerCase(),topK:Number(cfg.top_k||cfg.topK||8),maxContextChars:Number(cfg.max_context_chars||cfg.maxContextChars||24000),maxExcerptChars:Number(cfg.max_excerpt_chars||cfg.maxExcerptChars||4200),maxPerFile:Number(cfg.max_per_file||cfg.maxPerFile||2)};
}
function retrievalQuery(runDir,roleName){
 const parts=[`workflow role: ${roleName||'unknown'}`];
 for(const f of ['00-request.md','01-requirements.md','02-acceptance-criteria.md','03-definition-of-done.md','04-inspection.md']){const t=read(path.join(runDir,f));if(t)parts.push(t.slice(0,7000));}
 return parts.join('\n\n');
}
function safeName(v){return String(v||'role').replace(/[^A-Za-z0-9._-]+/g,'-').slice(0,100);}
function hybridRagContext({runDir,productRoot,contract,roleName,stageId}){
 const cfg=retrievalSettings(contract);
 if(!['hybrid','hybrid_rag','hybrid-rag'].includes(cfg.mode))return '';
 if(!Array.isArray(contract?.tools)||!contract.tools.includes('repository_read')||!productRoot||!fs.existsSync(productRoot))return '';
 const pack=retrieve({root:productRoot,query:retrievalQuery(runDir,roleName),role:roleName,topK:cfg.topK,maxContextChars:cfg.maxContextChars,maxExcerptChars:cfg.maxExcerptChars,maxPerFile:cfg.maxPerFile});
 const outDir=path.join(runDir,'engine','rag-context');fs.mkdirSync(outDir,{recursive:true});
 fs.writeFileSync(path.join(outDir,`${safeName(stageId||'stage')}-${safeName(roleName||'role')}.json`),JSON.stringify(pack,null,2)+'\n');
 return formatContext(pack);
}
function buildRoleContext({runDir,productRoot,contract,excludeArtifact,roleName,stageId}){
 const sections=[];
 for(const input of contract.inputs||[]){
   if(INPUT_FILES[input]) for(const f of INPUT_FILES[input]){const t=read(path.join(runDir,f));if(t)sections.push(`## ${f}\n${t.slice(0,16000)}`);}
   else if(input==='changed_files') sections.push('## Changed files\n'+(changedFiles(productRoot).join('\n')||'(none)'));
   else if(input==='validated_review_findings'){const t=reviewArtifacts(runDir);if(t)sections.push(t);}
   else if(input==='dependency_versions'){const t=dependencyVersions(productRoot);if(t)sections.push(t);}
   else if(input==='refactor_verification_matrix'){const t=read(path.join(runDir,'engine','refactor-verification-matrix.json'));if(t)sections.push('## Refactor verification matrix\n'+t);}
   else if(input==='run_artifacts'||input==='repository_evidence'){const t=broadArtifacts(runDir,excludeArtifact);if(t)sections.push(t);}
 }
 const rag=hybridRagContext({runDir,productRoot,contract,roleName,stageId});if(rag)sections.push(rag);
 return sections.join('\n\n');
}
module.exports={buildRoleContext,changedFiles,dependencyVersions,retrievalSettings,retrievalQuery,hybridRagContext};
