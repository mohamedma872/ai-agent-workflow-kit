#!/usr/bin/env node
'use strict';
function refactorTelemetry({baseline={},equivalence={},checkpoints={},verificationMatrix={}}={}){
 const behaviors=baseline.observableBehaviors||[], covered=behaviors.filter(x=>x.coverage?.status==='covered').length, waived=behaviors.filter(x=>x.coverage?.status==='waived').length;
 return {schemaVersion:1,behaviorCount:behaviors.length,coveredBehaviors:covered,waivedBehaviors:waived,uncoveredBehaviors:behaviors.length-covered-waived,
 intentionalChanges:(equivalence.intentionalChanges||[]).length,unexpectedChanges:(equivalence.unexpectedChanges||[]).length,unverifiedScenarios:(equivalence.unverifiedScenarios||[]).length,
 verifiedIncrements:Object.values(checkpoints||{}).filter(x=>x.status==='pass').length,testLayers:verificationMatrix.layers||[]};
}
function selftest(){
 const assert=require('assert');
 const x=refactorTelemetry({
   baseline:{observableBehaviors:[{coverage:{status:'covered'}},{coverage:{status:'waived'}},{coverage:{status:'uncovered'}}]},
   equivalence:{intentionalChanges:['x'],unexpectedChanges:[],unverifiedScenarios:['y']},
   checkpoints:{R1:{status:'pass'}},
   verificationMatrix:{layers:['unit']}
 });
 assert.equal(x.behaviorCount,3);assert.equal(x.coveredBehaviors,1);assert.equal(x.waivedBehaviors,1);assert.equal(x.unverifiedScenarios,1);assert.equal(x.verifiedIncrements,1);
 console.log('refactor telemetry selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest'))selftest();
module.exports={refactorTelemetry};
