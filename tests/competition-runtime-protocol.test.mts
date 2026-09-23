import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCompetitionJobIntent } from '../shared/competition-runtime.js'

const job = {
 schemaVersion:1,jobId:'a'.repeat(32),kind:'notebook',environment:'kaggle-base',revision:'sha256:'+'b'.repeat(64),
 competitionId:'x77h25nx',submissionId:'ab2cd3ef',attemptId:'c'.repeat(32),
 limits:{wallSeconds:600,memoryMb:4096,cpus:2,pids:256,tmpfsMb:512,targetBytes:64*1024*1024},
} as const

test('only a catalog revision and bounded typed IDs can select notebook data',()=>{
 assert.deepEqual(parseCompetitionJobIntent(job),job)
 for(const patch of [{image:'evil'}, {competitionId:'../secret'}, {revision:'colloq-kernel:base'}, {limits:{...job.limits,memoryMb:1e12}}, {bundleId:'../wheel'}])
  assert.throws(()=>parseCompetitionJobIntent({...job,...patch}),/Invalid|Unexpected/)
})
test('scorer cannot be given participant wheel bundle; prep cannot name competition data',()=>{
 assert.throws(()=>parseCompetitionJobIntent({...job,kind:'metric',bundleId:'d'.repeat(32)}),/Unexpected/)
 assert.throws(()=>parseCompetitionJobIntent({...job,kind:'resolve',preparationId:'e'.repeat(32)}),/Unexpected/)
 const prep={schemaVersion:1,jobId:'f'.repeat(32),kind:'resolve',environment:'kaggle-base',revision:job.revision,preparationId:'e'.repeat(32),limits:job.limits}
 assert.deepEqual(parseCompetitionJobIntent(prep),prep)
})

test('status and collection responses contain only bounded public metadata',async()=>{
 const {parseCompetitionJobStatus,parseCompetitionJobCollection}=await import('../shared/competition-runtime.js')
 const status={jobId:'a'.repeat(32),kind:'notebook',phase:'running',startedAt:1,finishedAt:null,exitCode:null,oomKilled:false,progress:{phase:'notebook',cell:2,cells:3,outputBytes:1024},error:null}
 assert.deepEqual(parseCompetitionJobStatus(status),status)
 assert.throws(()=>parseCompetitionJobStatus({...status,error:'private'.repeat(200)}),/Invalid/)
 assert.throws(()=>parseCompetitionJobStatus({...status,progress:{...status.progress,outputBytes:Infinity}}),/Invalid/)
 const files=[{name:'run.json',bytes:2,sha256:'a'.repeat(64)}]
 assert.deepEqual(parseCompetitionJobCollection({files,totalBytes:2}),{files,totalBytes:2})
 assert.throws(()=>parseCompetitionJobCollection({files:[{...files[0],name:'../solution.csv'}],totalBytes:2}),/Invalid/)
 assert.throws(()=>parseCompetitionJobCollection({files,totalBytes:3}),/Invalid/)
})

test('collection accepts bounded wheel exports but rejects every other nested path',async()=>{
 const {parseCompetitionJobCollection}=await import('../shared/competition-runtime.js')
 const wheels=Array.from({length:256},(_,i)=>({name:`wheels/pkg_${i}-1-py3-none-any.whl`,bytes:1,sha256:'a'.repeat(64)}))
 assert.equal(parseCompetitionJobCollection({files:wheels,totalBytes:256}).files.length,256)
 for(const name of ['wheels/../solution.csv','other/a.whl','wheels/deeper/a.whl','/wheels/a.whl','wheels/'])
  assert.throws(()=>parseCompetitionJobCollection({files:[{name,bytes:1,sha256:'a'.repeat(64)}],totalBytes:1}),/Invalid/)
})

test('broker accepts the full existing competition limit range',()=>{
 const high={...job,limits:{...job.limits,wallSeconds:14400,memoryMb:65536,cpus:32}}
 assert.deepEqual(parseCompetitionJobIntent(high),high)
 for(const patch of [{wallSeconds:14401},{memoryMb:65537},{cpus:33}])
  assert.throws(()=>parseCompetitionJobIntent({...job,limits:{...job.limits,...patch}}),/Invalid/)
})

test('broker reports scheduling refusal separately from a participant failure',async()=>{
 const {parseCompetitionJobStatus}=await import('../shared/competition-runtime.js')
 const status={jobId:'a'.repeat(32),kind:'notebook',phase:'failed',startedAt:1,finishedAt:2,exitCode:null,oomKilled:false,progress:null,error:'Competition resources are unavailable',failure:{code:'unschedulable',resource:'memory'}}
 assert.deepEqual(parseCompetitionJobStatus(status),status)
 assert.throws(()=>parseCompetitionJobStatus({...status,failure:{code:'unschedulable',resource:'../../hidden'}}),/Invalid/)
})
