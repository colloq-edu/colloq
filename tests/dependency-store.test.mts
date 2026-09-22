import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompetition, createEntrant, acceptSubmission, setCompetitionState } from '../server/src/competitions/store.js'
import { putRevision, selectRevision, setPolicy, draftOf, saveDraft, createBundle, getBundle, updateProgress, completeBundle, bindSubmission, submissionEnvironment, listBundles, cancelBundle, recoverPreparations, unusedBundles } from '../server/src/dependencies/store.js'

const revision = (name = 'base', digest = 'a') => putRevision({environmentName:name,imageDigest:`sha256:${digest.repeat(64)}`,pythonVersion:'3.11.16',pythonAbi:'cp311',platform:'linux/arm64',packages:[{name:'numpy',version:'2.4.6'}],baseConstraintsHash:'hash'})
let seq = 0
function setup() {
 const c=createCompetition({slug:`dependency-${++seq}`,title:'Packages',environment:'base'})!
 setCompetitionState(c.id,'live')
 const e=createEntrant('Dependency tester '+seq).entrant
 const r=revision();selectRevision(c.id,r.id);setPolicy(c.id,{enabled:true});return {c,e,r}
}
const result={normalizedRequirements:['geopy==2.4.1'],packages:[],downloadBytes:0,installedBytes:0,contentHash:'0'.repeat(64),lock:''}

test('a concurrent identical preparation shares one active set; a different request is refused',()=>{
 const {c,e,r}=setup();const a=createBundle(c.id,e.id,r.id,'geopy==2.4.1');const b=createBundle(c.id,e.id,r.id,'geopy==2.4.1');assert.equal(a.id,b.id);assert.equal(listBundles(c.id,e.id).length,1)
 assert.throws(()=>createBundle(c.id,e.id,r.id,'holidays'),/active/)
})

test('selection requires ownership, ready state and current revision',()=>{
 const {c,e,r}=setup();const b=createBundle(c.id,e.id,r.id,'geopy');
 assert.throws(()=>saveDraft(c.id,e.id,{requirementsText:'geopy',selectedBundleId:b.id}),/ready/)
 updateProgress(b.id,{state:'verifying'});completeBundle(b.id,result)
 saveDraft(c.id,e.id,{requirementsText:'geopy',selectedBundleId:b.id});assert.equal(draftOf(c.id,e.id).selectedBundleId,b.id)
 const other=createEntrant('Other dependency tester').entrant
 assert.throws(()=>saveDraft(c.id,other.id,{requirementsText:'',selectedBundleId:b.id}),/owner/)
 selectRevision(c.id,revision('base','b').id)
 assert.throws(()=>saveDraft(c.id,e.id,{requirementsText:'',selectedBundleId:b.id}),/revision/)
})

test('submitted binding survives a different current revision and is not garbage collected',()=>{
 const {c,e,r}=setup();const b=createBundle(c.id,e.id,r.id,'geopy');completeBundle(b.id,result)
 const s=acceptSubmission({competitionId:c.id,entrantId:e.id,fileName:'test.ipynb',bytes:42});bindSubmission(s.id,r.id,b.id)
 selectRevision(c.id,revision('base','c').id)
 assert.equal(submissionEnvironment(s.id,c.environment).revisionId,r.id)
 assert.equal(submissionEnvironment(s.id,c.environment).bundleNumber,1)
 assert(!unusedBundles(Date.now()+40*86400000).includes(b.id))
 assert.throws(()=>bindSubmission(s.id,revision('base','c').id,null),/immutable/)
})

test('cancelled work cannot publish ready; restart fails partial work without changing ready sets',()=>{
 const {c,e,r}=setup();const cancelled=createBundle(c.id,e.id,r.id,'geopy');cancelBundle(cancelled.id)
 assert.equal(completeBundle(cancelled.id,result),false);assert.equal(getBundle(cancelled.id)?.state,'cancelled')
 const active=createBundle(c.id,e.id,r.id,'holidays');updateProgress(active.id,{state:'downloading'})
 recoverPreparations();assert.equal(getBundle(active.id)?.state,'failed')
 const ready=createBundle(c.id,e.id,r.id,'geopy');completeBundle(ready.id,result);recoverPreparations();assert.equal(getBundle(ready.id)?.state,'ready')
})

test('disabled policy rejects new work but leaves old ready sets selectable; quotas are persistent',()=>{
 const {c,e,r}=setup();const ready=createBundle(c.id,e.id,r.id,'geopy');completeBundle(ready.id,result)
 setPolicy(c.id,{enabled:false});assert.throws(()=>createBundle(c.id,e.id,r.id,'holidays'),/disabled/)
 saveDraft(c.id,e.id,{requirementsText:'',selectedBundleId:ready.id})
 setPolicy(c.id,{enabled:true});for(let i=1;i<10;i++){const b=createBundle(c.id,e.id,r.id,`package${i}`);cancelBundle(b.id)}
 assert.throws(()=>createBundle(c.id,e.id,r.id,'eleventh'),/quota/)
})
