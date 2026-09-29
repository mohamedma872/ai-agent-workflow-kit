#!/usr/bin/env node
'use strict';
const assert=require('assert');

// The before and after contracts are written by two different agents at two
// different stages, in prose. Comparing those strings exactly made the gate
// meaningless: "void main() at lib/main.dart:L3-L5 calls runApp(const MyApp())"
// and "void main() => runApp(const MyApp()) (unchanged)" are the same API, but
// a set difference reported one removed and one added — so any refactor that
// shifted a line (which is what refactors do) failed behavior-equivalence, and
// a genuine removal was indistinguishable from that noise.
const NONE=/^(?:none|n\/a|no\b)/i;
const NOT_A_CALL=new Set(['if','for','while','switch','catch','return','await','new']);
const MAX_IDENTITY_WORDS=6;
function isNote(key){return String(key).trim().split(/\s+/).length>MAX_IDENTITY_WORDS;}
function normalizeEntry(text){
  let s=String(text==null?'':text).trim();
  if(!s||NONE.test(s)) return '';
  s=s.replace(/^\s*(?:NEW|ADDED|REMOVED|CHANGED|UNCHANGED)\s*:\s*/i,'');
  s=s.replace(/\s+(?:at|in)\s+[^\s,(]+:L\d+(?:-L?\d+)?/gi,' ');
  s=s.replace(/\((?:imported|exported|used|called|referenced)\s+by[^)]*\)/gi,' ');
  s=s.replace(/\((?:unchanged|new|added|same|preserved)\)/gi,' ');
  // A declaration's identity is its symbol, not the prose written around it.
  // A declared type is capitalised in every language this runtime targets, which
  // is what separates "class MyApp extends ..." from the prose "A class is
  // generated for each feature module", whose next word is `is`.
  const decl=s.match(/\b(?:class|enum|mixin|extension|typedef|interface|struct|protocol)\s+([A-Z_$][\w$]*)/);
  if(decl) return decl[1];
  // Everything below mines an identity OUT of the text, so it must only run on
  // text that IS an identity. Running it on a sentence invented one: "the private
  // constructor (...)" became `private`, which then looked short enough to pass
  // the prose filter and was reported as a removed public API. Prose is
  // recognised before extraction, not after it.
  if(isNote(s)) return '';
  const fn=s.match(/\b([A-Za-z_$][\w$]*)\s*\(/);
  // The identifier alone, with no parens: the same type appears as "class MyApp"
  // on one side and as a constructor "MyApp({...})" on the other, and those must
  // be the same key or every declaration looks both removed and added.
  if(fn&&!NOT_A_CALL.has(fn[1])) return fn[1];
  return s.replace(/[\s{};,]+/g,' ').trim().toLowerCase();
}
function normalizeSet(list){const out=new Set();for(const x of list||[]){const k=normalizeEntry(x);if(k)out.add(k);}return out;}
function sequence(list){const out=[];for(const x of list||[]){const k=normalizeEntry(x);if(k&&!isNote(k)&&!out.includes(k))out.push(k);}return out;}
function diffSet(before=[],after=[]){
  const b=normalizeSet(before),a=normalizeSet(after);
  return {removed:[...b].filter(x=>!a.has(x)),added:[...a].filter(x=>!b.has(x))};
}
// Every contract field can carry a real identity, so every field can block:
// errorBehavior holds "missing displayName -> empty string", navigationContracts
// holds "order/:id -> auth fallback", concurrencyBehavior holds "single-submit".
// What is NOT comparable is prose: the baseline agent and the equivalence agent
// describe the same behaviour in different sentences every time ("everything runs
// synchronously on the UI isolate ..." vs "synchronous single-isolate UI-thread
// mutation inside setState ..."). So the split is per ENTRY, not per field.
// An identity field holds identities: a symbol, a storage key, an event name,
// an endpoint, a route. A sentence that happens to sit in the list
// ("_MyHomePageState and _incrementCounter are library-private, so they are not
// public API ...") is a note about the contract, not a member of it, and must
// not read as one being removed. Identities are short; notes are sentences.
function identityOnly(keys){return keys.filter(k=>!isNote(k));}
function contractDiff(before={},after={}){
  const fields=['publicApis','apiCalls','storageContracts','navigationContracts','analyticsEvents','errorBehavior','concurrencyBehavior','lifecycleBehavior'];
  const changes={};
  for(const field of fields){
    const d=diffSet(before[field]||[],after[field]||[]);
    {
      d.removed=identityOnly(d.removed);d.added=identityOnly(d.added);
      // Membership alone misses a reordering, and for a behaviour-preserving
      // refactor the ORDER of calls is part of the contract: validate-then-charge
      // and charge-then-validate use exactly the same set of endpoints.
      const bSeq=sequence(before[field]),aSeq=sequence(after[field]);
      if(!d.removed.length&&!d.added.length&&bSeq.length&&bSeq.join('\u0000')!==aSeq.join('\u0000')) d.reordered={before:bSeq,after:aSeq};
    }
    if(d.removed.length||d.added.length||d.reordered)changes[field]=d;
  }
  return changes;
}
function invariantProblems(changes,invariants){
  const map={
    publicApis:['publicApi'],
    apiCalls:['apiContracts'],
    storageContracts:['storageFormat','storageKeys'],
    navigationContracts:['navigation'],
    analyticsEvents:['analyticsEvents'],
    errorBehavior:['errorSemantics'],
    concurrencyBehavior:['concurrencyBehavior'],
    lifecycleBehavior:['lifecycleBehavior']
  };
  const allowed=new Set((invariants?.intentionalExceptions||[]).filter(x=>x.approved).map(x=>x.invariant));
  const problems=[];
  for(const [field,d] of Object.entries(changes||{})){
    for(const invariant of map[field]||[]){
      // "mustPreserve" is about what existed still existing. A refactor that
      // adds a new public class removes nothing, so a pure addition is not a
      // preservation violation — flagging it failed correct refactors whose
      // plan explicitly introduced the new type.
      if(!d.removed.length&&!d.reordered) continue;
      if(invariants?.mustPreserve?.[invariant]!==false && !allowed.has(invariant)){
        problems.push(field+'/'+invariant+(d.reordered
          ? ': order changed ['+d.reordered.before.join(' -> ')+'] became ['+d.reordered.after.join(' -> ')+']'
          : ': removed=['+d.removed.join(', ')+'] added=['+d.added.join(', ')+']'));
      }
    }
  }
  return problems;
}
function selftest(){
  const changes=contractDiff(
    {publicApis:['a'],storageContracts:['key:session']},
    {publicApis:['b'],storageContracts:['key:session-v2']}
  );
  assert(changes.publicApis);
  const problems=invariantProblems(changes,{mustPreserve:{publicApi:true,storageFormat:true,storageKeys:true},intentionalExceptions:[]});
  assert.equal(problems.length,3);
  assert(problems.some(x=>x.includes('storageKeys')));

  // The exact strings REF-001 produced on a real Flutter refactor. The same
  // three APIs, described by two different agents; none of them was removed.
  const beforeReal=[
    'void main() at lib/main.dart:L3-L5 calls runApp(const MyApp())',
    'class MyApp extends StatelessWidget, const MyApp({super.key}) at lib/main.dart:L7-L8 (imported by test/widget_test.dart:L11 via package:my_app/main.dart)',
    'class MyHomePage extends StatefulWidget, const MyHomePage({super.key, required this.title}), final String title, createState() => _MyHomePageState() at lib/main.dart:L38-L54',
  ];
  const afterReal=[
    'void main() => runApp(const MyApp()) (unchanged)',
    'class MyApp extends StatelessWidget { const MyApp({super.key}) } (unchanged)',
    'class MyHomePage extends StatefulWidget { const MyHomePage({super.key, required this.title}); final String title; createState() => _MyHomePageState() } (unchanged)',
    'NEW: class CounterController { int get value; void increment(); } in package:my_app/counter_controller.dart',
  ];
  const real=contractDiff({publicApis:beforeReal},{publicApis:afterReal});
  assert.deepStrictEqual(real.publicApis&&real.publicApis.removed||[],[],'a line shift must not look like a removed public API');
  assert.deepStrictEqual(real.publicApis&&real.publicApis.added||[],['CounterController'],'the genuinely new type is the only addition');
  const keep={mustPreserve:{publicApi:true},intentionalExceptions:[]};
  assert.deepStrictEqual(invariantProblems(real,keep),[],'adding a new public type is not a preservation violation');

  // A real removal must still fail, and must not be masked by an addition.
  const broke=contractDiff({publicApis:beforeReal},{publicApis:afterReal.filter(x=>!/MyHomePage/.test(x))});
  assert.deepStrictEqual(broke.publicApis.removed,['MyHomePage']);
  assert.strictEqual(invariantProblems(broke,keep).length,1,'a removed public API is still a violation');

  // A prose "there are none" sentence is not an API entry.
  const none=contractDiff({apiCalls:['None: there are no network or HTTP calls in lib/main.dart']},{apiCalls:[]});
  assert.deepStrictEqual(none.apiCalls&&none.apiCalls.removed||[],[],'"none" prose must not count as a removed contract');
  // Two agents describing the same behaviour in different sentences must not
  // read as a change. These are the exact strings REF-001 produced.
  const prose=contractDiff(
    {concurrencyBehavior:['Everything runs synchronously on the UI isolate, there is no async code, futures, streams or isolates in lib/main.dart']},
    {concurrencyBehavior:['Synchronous single-isolate UI-thread mutation inside setState, there is no async future, stream or timer. This is the same as the baseline.']}
  );
  assert.deepStrictEqual(
    invariantProblems(prose,{mustPreserve:{concurrencyBehavior:true},intentionalExceptions:[]}),
    [],'prose descriptions of the same behaviour must not block');
  // But a short, identity-like concurrency change in the same field still blocks.
  const race=contractDiff({concurrencyBehavior:['single-submit']},{concurrencyBehavior:['parallel-submit']});
  assert.strictEqual(
    invariantProblems(race,{mustPreserve:{concurrencyBehavior:true},intentionalExceptions:[]}).length,1,
    'a real concurrency change still blocks');
  // A note sitting in an identity list is not a removed API.
  const noteOnly=contractDiff(
    {publicApis:['class Foo','_myState and _bar are library-private so they are not public API']},
    {publicApis:['class Foo']}
  );
  assert.strictEqual(noteOnly.publicApis,undefined,'a prose note is not an identity');
  // Prose must never be mined for a fake identity. ARCH-001 produced exactly
  // these keys before this was fixed: private, class, initialiser, initState.
  const prosey=contractDiff(
    {publicApis:['The private constructor is only reachable from the factory (see the migration plan)'],
     lifecycleBehavior:['State is seeded from the widget initialiser rather than a late field, which keeps the first frame correct']},
    {publicApis:['A class is generated for each feature module, as described in the target architecture document'],
     lifecycleBehavior:['initState seeds the controller once per State object, matching the baseline exactly']}
  );
  assert.strictEqual(prosey.publicApis,undefined,'a sentence is not a removed public API');
  assert.strictEqual(prosey.lifecycleBehavior,undefined,'a sentence is not a lifecycle change');
  // A real declaration is still an identity however long its description is.
  const longDecl=contractDiff(
    {publicApis:['class MyHomePage extends StatefulWidget, final String title, createState() => _MyHomePageState() at lib/main.dart:L38-L54']},
    {publicApis:['class MyHomePage extends StatefulWidget { final String title; createState() => _MyHomePageState() } (unchanged)']}
  );
  assert.strictEqual(longDecl.publicApis,undefined,'a long declaration still matches itself');
  // Identities that are not code symbols must still be compared.
  const keys=contractDiff({storageContracts:['key:session']},{storageContracts:['key:session-v2']});
  assert.deepStrictEqual(keys.storageContracts.removed,['key:session']);
  assert.deepStrictEqual(keys.storageContracts.added,['key:session-v2']);
  // A genuinely removed symbol still blocks.
  const gone=contractDiff({publicApis:['class Foo','class Bar']},{publicApis:['class Foo']});
  assert.deepStrictEqual(gone.publicApis.removed,['Bar']);
  assert.strictEqual(invariantProblems(gone,{mustPreserve:{publicApi:true},intentionalExceptions:[]}).length,1);
  // A reordering with identical membership is a real behaviour change:
  // validate-then-charge and charge-then-validate call the same endpoints.
  const reordered=contractDiff({apiCalls:['validate','charge']},{apiCalls:['charge','validate']});
  assert(reordered.apiCalls&&reordered.apiCalls.reordered,'a call-order change is detected');
  const ordProblems=invariantProblems(reordered,{mustPreserve:{apiContracts:true},intentionalExceptions:[]});
  assert.strictEqual(ordProblems.length,1,'a call-order change blocks');
  assert(/order changed/.test(ordProblems[0]),'the problem says the order changed');
  // Identical order is not a change.
  const sameOrder=contractDiff({apiCalls:['validate','charge']},{apiCalls:['validate','charge']});
  assert.strictEqual(sameOrder.apiCalls,undefined,'an unchanged contract reports nothing');
  console.log('refactor contract diff selftest OK');
}
if(require.main===module&&process.argv.includes('--selftest'))selftest();
module.exports={contractDiff,invariantProblems};
