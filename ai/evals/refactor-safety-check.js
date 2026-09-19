#!/usr/bin/env node
'use strict';
const assert=require('assert');
const {validateArtifactData}=require('../workflow/artifacts');
const {contractDiff,invariantProblems}=require('../workflow/refactor-contract-diff');

function eq(overrides={}){
 return {
  schemaVersion:1,runId:'TEST',status:'pass',verifiedBehaviors:['baseline'],
  intentionalChanges:[],unexpectedChanges:[],contractChanges:[],
  testLayers:[{layer:'unit',status:'pass',evidence:['test output']}],
  unverifiedScenarios:[],fullyVerified:true,
  observedFinalContracts:{publicApis:[],apiCalls:[],storageContracts:[],navigationContracts:[],analyticsEvents:[],errorBehavior:[],concurrencyBehavior:[],lifecycleBehavior:[]},
  ...overrides
 };
}
function invariants(){
 return {mustPreserve:{publicApi:true,apiContracts:true,navigation:true,storageFormat:true,storageKeys:true,analyticsEvents:true,errorSemantics:true,backwardCompatibility:true,concurrencyBehavior:true,lifecycleBehavior:true},intentionalExceptions:[]};
}
function rejectedContract(before,after,label){
 const p=invariantProblems(contractDiff(before,after),invariants());
 assert(p.length>0,label+' must be rejected');
 return p;
}
function run(){
 const badLogin=eq({unexpectedChanges:['invalid password now stores token']});
 assert(validateArtifactData('behavior-equivalence',badLogin,'TEST').some(x=>x.includes('unexpectedChanges')),'login semantic change must fail equivalence');

 rejectedContract({storageContracts:['key:session','format:v1']},{storageContracts:['key:session-v2','format:v2']},'storage key/schema change');
 rejectedContract({apiCalls:['validate','charge'],concurrencyBehavior:['validate-before-charge','single-submit']},{apiCalls:['charge','validate'],concurrencyBehavior:['parallel-submit']},'async ordering/race change');
 rejectedContract({navigationContracts:['order/:id -> auth fallback']},{navigationContracts:['order/:id -> direct open']},'navigation/deep-link change');
 rejectedContract({analyticsEvents:['checkout_started:v1','checkout_completed:v1']},{analyticsEvents:['checkout_started:v1']},'analytics event removal');
 rejectedContract({errorBehavior:['missing displayName -> empty string']},{errorBehavior:['missing displayName -> throw']},'null/default/error behavior change');

 const partial=eq({fullyVerified:false,unverifiedScenarios:['push cold start']});
 assert.deepStrictEqual(validateArtifactData('behavior-equivalence',partial,'TEST'),[],'partial verification may be honest/pass');
 const dishonest=eq({fullyVerified:true,unverifiedScenarios:['push cold start']});
 assert(validateArtifactData('behavior-equivalence',dishonest,'TEST').some(x=>x.includes('fullyVerified')),'full claim with unverified scenario must fail');

 console.log('refactor adversarial safety checks OK');
}
if(require.main===module){try{run();}catch(e){console.error('✗ '+e.message);process.exitCode=1;}}
module.exports={run};
