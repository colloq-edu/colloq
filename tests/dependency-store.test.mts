import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompetition, createEntrant, acceptSubmission, setCompetitionState } from '../server/src/competitions/store.js'
import { putRevision, selectRevision, setPolicy, draftOf, saveDraft, createBundle, getBundle, updateProgress, completeBundle, bindSubmission, submissionEnvironment, listBundles, cancelBundle, recoverPreparations, unusedBundles, preparationQuota, DependencyStoreError } from '../server/src/dependencies/store.js'
import { dependencyRefusal } from '../server/src/dependencies/messages.js'
import { DEPENDENCY_LIMITS } from '../shared/dependencies.js'

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

test('the hour\'s preparations are counted ahead, and the refusal says when the next one is possible',()=>{
 const {c,e,r}=setup(),start=Date.UTC(2026,8,29,10),minute=60000
 assert.deepEqual(preparationQuota(e.id,start),{left:DEPENDENCY_LIMITS.perHour,nextAt:null})
 // Ten preparations a minute apart; failed and cancelled ones count like the rest.
 for(let i=0;i<DEPENDENCY_LIMITS.perHour;i++){const b=createBundle(c.id,e.id,r.id,`package${i}`,start+i*minute);cancelBundle(b.id)}
 assert.deepEqual(preparationQuota(e.id,start+3*minute),{left:0,nextAt:start+60*minute})
 let refusal:unknown
 try{createBundle(c.id,e.id,r.id,'eleventh',start+48*minute+1)}catch(error){refusal=error}
 assert.ok(refusal instanceof DependencyStoreError)
 assert.equal(refusal.code,'dependency_quota')
 assert.equal(refusal.status,429)
 assert.deepEqual(refusal.detail,{params:{waitMinutes:12}})
 assert.equal(dependencyRefusal(refusal.code,refusal.detail),'Достигнут лимит: 10 подготовок в час. Следующая подготовка — через 12 мин.')
 // The last seconds read as a minute, never as "in 0 min".
 try{createBundle(c.id,e.id,r.id,'eleventh',start+60*minute-5000)}catch(error){refusal=error}
 assert.deepEqual((refusal as DependencyStoreError).detail,{params:{waitMinutes:1}})
 // The oldest one leaves the hour and frees exactly one place.
 assert.deepEqual(preparationQuota(e.id,start+60*minute),{left:1,nextAt:null})
 assert.ok(createBundle(c.id,e.id,r.id,'eleventh',start+60*minute))
 assert.deepEqual(preparationQuota(e.id,start+60*minute),{left:0,nextAt:start+61*minute})
})

test('a URL, a path or a pip option is refused before it becomes a preparation, and stays in a draft',()=>{
 const {c,e,r}=setup()
 const text='# models\nnumpy\ntorch --index-url https://download.pytorch.org/whl/cpu'
 let refusal:unknown
 try{createBundle(c.id,e.id,r.id,text)}catch(error){refusal=error}
 assert.ok(refusal instanceof DependencyStoreError)
 assert.equal(refusal.code,'unsupported_source')
 assert.equal(refusal.status,400)
 assert.deepEqual(refusal.detail,{line:3})
 assert.equal(dependencyRefusal(refusal.code,refusal.detail),'Строка 3: Разрешены только имена пакетов PyPI и версии. URL, пути, хеши (--hash) и другие параметры pip не поддерживаются.')
 assert.equal(listBundles(c.id,e.id).length,0,'the refusal took a preparation')
 assert.equal(preparationQuota(e.id).left,DEPENDENCY_LIMITS.perHour)
 // The draft is the entrant's scratch: it keeps the line to be fixed.
 assert.equal(saveDraft(c.id,e.id,{requirementsText:text}).requirementsText,text)
})

test('a note after a requirement is pip\'s comment: the set is taken, and stored without the note',()=>{
 const {c,e,r}=setup()
 // A URL or an option inside the note is only words; a comment line of its own stays.
 const b=createBundle(c.id,e.id,r.id,'# models\ngeopy==2.4.1  # geocoding\ntorch\t# no --index-url https://download.pytorch.org/whl/cpu needed')
 assert.equal(b.requirementsText,'# models\ngeopy==2.4.1\ntorch')
 assert.equal(draftOf(c.id,e.id).requirementsText,b.requirementsText)
 // The same set with another note is the same set, not a second preparation.
 assert.equal(createBundle(c.id,e.id,r.id,'# models\ngeopy==2.4.1 # maps\ntorch').id,b.id)
 // A `#` inside a word is no comment: the fragment leaves the URL a URL.
 assert.throws(()=>createBundle(c.id,e.id,r.id,'git+https://github.com/geopy/geopy.git#egg=geopy'),{code:'unsupported_source'})
})
