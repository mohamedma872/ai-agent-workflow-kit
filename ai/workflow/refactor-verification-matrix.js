#!/usr/bin/env node
'use strict';
const assert=require('assert');
function verificationMatrix({files=[],baseline={}}={}){
 const f=files.map(x=>String(x).toLowerCase()), layers=new Set(), reasons=[];
 const add=(x,r)=>{layers.add(x);reasons.push({layer:x,reason:r});};
 add('characterization','refactor mode requires behavior baseline protection');
 if(f.some(x=>/repository|dao|api|client|service|graphql|openapi/.test(x))){add('integration','data/service boundary changed');add('api-contract','API/data boundary changed');}
 if(f.some(x=>/navigation|route|router|deeplink|deep-link/.test(x))||(baseline.navigationContracts||[]).length)add('e2e-navigation','navigation behavior is in scope');
 if(f.some(x=>/storage|database|realm|sqlite|room|coredata|userdefaults|asyncstorage/.test(x))||(baseline.storageContracts||[]).length)add('persistence-compatibility','persistence behavior is in scope');
 if(f.some(x=>/viewmodel|reducer|screen|view|component|tsx$|swift$|kt$|dart$/.test(x)))add('unit-state','UI/state logic changed');
 if(f.some(x=>/android|ios|native|bridge|turbomodule|methodchannel/.test(x))){add('native-integration','native bridge/platform code changed');add('device-e2e','device behavior must be verified');}
 if(layers.size===1)add('unit','minimum executable behavior check');
 return {layers:[...layers],reasons};
}
function selftest(){
 let x=verificationMatrix({files:['src/repository/UserRepository.kt']});assert(x.layers.includes('integration'));assert(x.layers.includes('api-contract'));
 x=verificationMatrix({files:['src/navigation/router.ts']});assert(x.layers.includes('e2e-navigation'));
 console.log('refactor verification matrix selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest'))selftest();
module.exports={verificationMatrix};
