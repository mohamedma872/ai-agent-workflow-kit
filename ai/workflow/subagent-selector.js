#!/usr/bin/env node
'use strict';
const assert=require('assert'); const fs=require('fs'); const path=require('path');

function detectStacks(root){
 const exists=p=>fs.existsSync(path.join(root,p));
 let pkg={}; try{pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));}catch{}
 const deps={...(pkg.dependencies||{}),...(pkg.devDependencies||{})};
 return {
   reactNative: !!deps['react-native'] || exists('android')&&exists('ios')&&exists('index.js'),
   flutter: exists('pubspec.yaml'),
   android: exists('android') || exists('build.gradle') || exists('build.gradle.kts'),
   ios: exists('ios') || exists('Podfile'),
   frontend: !!(deps.react||deps.next||deps.vue||deps['@angular/core']),
   backend: exists('manage.py')||exists('server')||exists('backend')||exists('api')||!!(deps.express||deps.fastify||deps['@nestjs/core'])
 };
}
function normalizeFiles(files){return (files||[]).map(x=>String(x).replaceAll('\\','/').toLowerCase());}
function hasAny(files,res){return res.some(re=>files.some(f=>re.test(f)));}
function selectAnalysis({allowedRoles=[],request='',root=process.cwd(),scope='auto'}={}){
 const allowed=new Set(allowedRoles), stacks=detectStacks(root), text=String(request).toLowerCase(), roles=[], reasons={};
 const add=(r,why)=>{if(allowed.has(r)&&!roles.includes(r)){roles.push(r);reasons[r]=why;}};
 add('architect','architecture impact is always assessed');
 add('qa-plan','acceptance criteria require test planning');
 add('security','security risk screening is always assessed');
 add('performance','performance risk screening is always assessed');
 if(allowed.has('docs')) add('docs','version-sensitive repository dependencies may require current docs');
 if(stacks.reactNative) add('react-native','React Native stack detected');
 if(stacks.flutter) add('flutter','Flutter stack detected');
 if(stacks.android&&(scope==='auto'||scope==='all'||scope==='mobile')) add('android','Android stack detected');
 if(stacks.ios&&(scope==='auto'||scope==='all'||scope==='mobile')) add('ios','iOS stack detected');
 if(stacks.frontend&&(scope==='auto'||scope==='all'||scope==='frontend')) add('frontend','frontend stack detected');
 if(stacks.backend&&(scope==='auto'||scope==='all'||scope==='backend')) add('backend','backend stack detected');
 if(/\b(api|graphql|openapi|schema|endpoint|contract|pagination|idempotent|idempotency)\b/.test(text)) add('api-contract','request changes an API/contract boundary');
 if(/\b(upgrade|update dependency|migration|migrate|sdk|react native 0\.|flutter 3|xcode|gradle|kotlin|swift)\b/.test(text)) add('dependency-migration','request includes dependency/framework migration');
 return {roles,reasons,stacks};
}
function selectReviews({allowedRoles=[],changedFiles=[],root=process.cwd()}={}){
 const allowed=new Set(allowedRoles), files=normalizeFiles(changedFiles), stacks=detectStacks(root), roles=[], reasons={};
 const add=(r,why)=>{if(allowed.has(r)&&!roles.includes(r)){roles.push(r);reasons[r]=why;}};
 add('code-review','baseline correctness review');
 add('security-review','baseline security review');
 add('performance-review','baseline performance review');
 if(stacks.reactNative && hasAny(files,[/\.tsx?$/, /android\//, /ios\//])) add('react-native-review','React Native/native files changed');
 if(hasAny(files,[/^android\//,/\.kt$/,/\.java$/,/androidmanifest\.xml$/])) add('android-review','Android files changed');
 if(hasAny(files,[/^ios\//,/\.swift$/,/\.m$/,/\.mm$/,/podfile/])) add('ios-review','iOS files changed');
 if(stacks.flutter && hasAny(files,[/\.dart$/,/pubspec\.yaml$/])) add('flutter-review','Flutter files changed');
 if(stacks.frontend && hasAny(files,[/\.tsx?$/,/\.jsx?$/,/\.vue$/])) add('frontend-review','frontend files changed');
 if(stacks.backend && hasAny(files,[/\.py$/,/server\//,/backend\//,/api\//])) add('backend-review','backend files changed');
 if(hasAny(files,[/openapi/,/graphql/,/schema/,/api\//,/client.*model/])) add('api-contract-review','API contract-related files changed');
 return {roles,reasons,stacks};
}
function selftest(){
 const os=require('os'); const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'subagent-selector-'));
 const mk=(name,files,pkg)=>{const r=path.join(tmp,name);fs.mkdirSync(r,{recursive:true});if(pkg)fs.writeFileSync(path.join(r,'package.json'),JSON.stringify(pkg));for(const file of files||[]){const p=path.join(r,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'x');}return r;};
 const rn=mk('rn',['android/x','ios/x'],{dependencies:{'react-native':'0.81.0',react:'19.0.0'}});
 const flutter=mk('flutter',['pubspec.yaml','android/x','ios/x']);
 const web=mk('web',[],{dependencies:{react:'19.0.0',next:'16.0.0'}});
 const back=mk('back',['backend/app.py']);
 let a=selectAnalysis({allowedRoles:['architect','qa-plan','security','performance','docs','react-native','api-contract','dependency-migration'],request:'Upgrade SDK and change GraphQL pagination',root:rn,scope:'mobile'});
 assert(a.roles.includes('react-native'));assert(a.roles.includes('api-contract'));assert(a.roles.includes('dependency-migration'));
 a=selectAnalysis({allowedRoles:['architect','qa-plan','security','performance','flutter'],request:'Add settings screen',root:flutter,scope:'mobile'});assert(a.roles.includes('flutter'));
 a=selectAnalysis({allowedRoles:['architect','qa-plan','security','performance','frontend'],request:'Add form',root:web,scope:'frontend'});assert(a.roles.includes('frontend'));
 a=selectAnalysis({allowedRoles:['architect','qa-plan','security','performance','backend'],request:'Add queue',root:back,scope:'backend'});assert(a.roles.includes('backend'));
 const r=selectReviews({allowedRoles:['code-review','security-review','performance-review','android-review','react-native-review'],changedFiles:['android/app/src/main/Foo.kt'],root:rn});
 assert(r.roles.includes('android-review'));assert(r.roles.includes('react-native-review'));
 fs.rmSync(tmp,{recursive:true,force:true});console.log('subagent-selector selftest OK');
}
if(require.main===module){if(process.argv.includes('--selftest')) selftest();}
module.exports={detectStacks,selectAnalysis,selectReviews};
