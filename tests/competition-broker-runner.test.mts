import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { TEST_ROOT } from './_env.mts'
import { BrokerCompetitionRunner, CompetitionResourcePending } from '../server/src/competitions/broker-runner.js'
import type { CompetitionJobIntent, CompetitionJobStatus } from '../shared/competition-runtime.js'

const digest=`sha256:${'a'.repeat(64)}`
const image=`registry.example/colloq/kaggle-base@${digest}`
const attemptId='a'.repeat(32)
const competitionId='abcdefgh'
const submissionId='bcdefghi'
const limits={wallSeconds:600,memoryMb:4096,cpus:2,pids:256,fsizeBytes:1024,tmpfsMb:512,targetBytes:64*1024*1024,outputBytes:100,outputKillBytes:1000}
const competition={id:competitionId,environment:'kaggle-base',publicPercent:30,splitSeed:'seed'} as any
function fakeClient(hook:(intent:CompetitionJobIntent)=>void, phase:'complete'|'running'='complete') {
  const cancelled:string[]=[]
  let current:CompetitionJobIntent
  return {cancelled,
    async startCompetitionJob(intent:CompetitionJobIntent) { current=intent;hook(intent);return status(intent,phase) },
    async competitionJob() { return status(current,phase) },
    async collectCompetitionJob() { return {files:[],totalBytes:0} },
    async cancelCompetitionJob(jobId:string) { cancelled.push(jobId) },
    async competitionJobs() { return [status(current,phase)] },
  }
}
function status(intent:CompetitionJobIntent,phase:'complete'|'running'):CompetitionJobStatus {
  return {jobId:intent.jobId,kind:intent.kind,phase,startedAt:1,finishedAt:phase==='complete'?2:null,exitCode:phase==='complete'?0:null,oomKilled:false,progress:null,error:null}
}

test('broker notebook uses catalog digest, collects owned report and cancels completed job',async()=>{
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  fs.mkdirSync(resultDir,{recursive:true})
  const client=fakeClient(intent=>{
    assert.equal(intent.revision,digest)
    assert.equal(intent.kind,'notebook')
    assert.equal(intent.attemptId,attemptId)
    fs.writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({attemptId,status:'ok',cell:0,cells:1,detail:''}))
    fs.writeFileSync(path.join(resultDir,'submission.csv'),'id,target\n1,2\n')
  })
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const outcome=await runner.run({competition,submissionId,attemptId,container:'colloq-comp-test',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits})
  assert.equal(outcome.status,'ok')
  assert.equal(outcome.submission,path.join(resultDir,'submission.csv'))
  assert.equal(outcome.diagnostics.backend,'broker')
  assert.equal(client.cancelled.length,1)
})

test('broker rejects a local Docker digest without matching catalog image',async()=>{
  const client=fakeClient(()=>{throw new Error('must not start')})
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  await assert.rejects(()=>runner.run({competition,submissionId,attemptId,container:'colloq-comp-test',imageDigest:digest,dataDir:'ignored',inputDir:'ignored',resultDir:'ignored',limits}),/catalog|image|revision/i)
})

test('broker collects during exporting before treating the job as complete',async()=>{
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  fs.mkdirSync(resultDir,{recursive:true})
  const events:string[]=[]
  let collected=false
  let jobId=''
  const client={
    async startCompetitionJob(intent:CompetitionJobIntent){jobId=intent.jobId;events.push('start');return status(intent,'running')},
    async competitionJob(){events.push('status');return {jobId,kind:'notebook',phase:collected?'complete':'exporting',startedAt:1,finishedAt:2,exitCode:0,oomKilled:false,progress:null,error:null}},
    async collectCompetitionJob(){events.push('collect');collected=true;fs.writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({attemptId,status:'ok',cell:0,cells:1}));fs.writeFileSync(path.join(resultDir,'submission.csv'),'id,target\n1,2\n');return {files:[],totalBytes:0}},
    async cancelCompetitionJob(){events.push('delete')},async competitionJobs(){return []},
  }
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const outcome=await runner.run({competition,submissionId,attemptId,container:'colloq-comp-export',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits})
  assert.equal(outcome.status,'ok')
  assert.deepEqual(events,['start','status','collect','status','delete'])
})

test('broker sweep cancels only instance-owned jobs returned by broker',async()=>{
  const client=fakeClient(()=>{})
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  await client.startCompetitionJob({schemaVersion:1,jobId:'f'.repeat(32),kind:'inventory',environment:'kaggle-base',revision:digest,limits:{wallSeconds:30,memoryMb:256,cpus:1,pids:64,tmpfsMb:32,targetBytes:1024}})
  assert.equal(await runner.sweep(),1)
  assert.deepEqual(client.cancelled,['f'.repeat(32)])
})

test('broker scorer writes fixed split config and keeps teacher diagnostics private',async()=>{
  const outDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'score-out')
  fs.mkdirSync(outDir,{recursive:true})
  const client=fakeClient(intent=>{
    assert.equal(intent.kind,'metric')
    assert.equal(intent.bundleId,undefined)
    const config=JSON.parse(fs.readFileSync(path.join(path.dirname(outDir),'score-config','request.json'),'utf8'))
    assert.deepEqual(config,{idColumn:'id',publicPercent:30,splitSeed:'seed'})
    fs.writeFileSync(path.join(outDir,'score.json'),JSON.stringify({attemptId,status:'ok',public:0.42,private:0.31,teacherOnly:'secret traceback'}))
  })
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const outcome=await runner.score({competition,submissionId,attemptId,container:'colloq-comp-score',imageDigest:image,secretDir:'ignored',submissionDir:'ignored',outDir,limits})
  assert.equal(outcome.status,'ok')
  assert.equal(outcome.public,0.42)
  assert.equal(outcome.message,null)
  assert.equal(outcome.teacherOnly,'secret traceback')
})

test('abort cancels the active broker job and never accepts its late report',async()=>{
  const controller=new AbortController()
  const client=fakeClient(()=>{},'running')
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  const pending=runner.run({competition,submissionId,attemptId,container:'colloq-comp-cancel',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits,signal:controller.signal})
  setTimeout(()=>controller.abort(),5)
  await assert.rejects(pending)
  assert.ok(client.cancelled.length>=1)
})

test('scorer preserves teacher report after nonzero metric exit',async()=>{
  const outDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'score-out')
  fs.mkdirSync(outDir,{recursive:true})
  let collected=false,jobId=''
  const client={
    async startCompetitionJob(intent:CompetitionJobIntent){jobId=intent.jobId;return {...status(intent,'running'),exitCode:null}},
    async competitionJob(){return {jobId,kind:'metric',phase:collected?'failed':'exporting',startedAt:1,finishedAt:2,exitCode:1,oomKilled:false,progress:null,error:null}},
    async collectCompetitionJob(){collected=true;fs.writeFileSync(path.join(outDir,'score.json'),JSON.stringify({attemptId,status:'metric_error',teacherOnly:'metric traceback'}));return {files:[],totalBytes:0}},
    async cancelCompetitionJob(){},async competitionJobs(){return []},
  }
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const outcome=await runner.score({competition,submissionId,attemptId,container:'colloq-comp-score-error',imageDigest:image,secretDir:'ignored',submissionDir:'ignored',outDir,limits})
  assert.equal(outcome.status,'metric_error')
  assert.equal(outcome.teacherOnly,'metric traceback')
  assert.equal(outcome.message,null)
})

test('participant error remains visible when scorer exits nonzero after writing its report',async()=>{
  const outDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'score-out')
  fs.mkdirSync(outDir,{recursive:true})
  let collected=false,jobId=''
  const client={
    async startCompetitionJob(intent:CompetitionJobIntent){jobId=intent.jobId;return status(intent,'running')},
    async competitionJob(){return {jobId,kind:'metric',phase:collected?'failed':'exporting',startedAt:1,finishedAt:2,exitCode:1,oomKilled:false,progress:null,error:null}},
    async collectCompetitionJob(){collected=true;fs.writeFileSync(path.join(outDir,'score.json'),JSON.stringify({attemptId,status:'participant_error',message:'Submission rows do not match.'}));return {files:[],totalBytes:0}},
    async cancelCompetitionJob(){},async competitionJobs(){return []},
  }
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const outcome=await runner.score({competition,submissionId,attemptId,container:'colloq-comp-score-participant',imageDigest:image,secretDir:'ignored',submissionDir:'ignored',outDir,limits})
  assert.equal(outcome.status,'participant_error')
  assert.equal(outcome.message,'Submission rows do not match.')
  assert.equal(outcome.teacherOnly,null)
})

test('only typed unschedulable broker failure requests a queue retry after Pod deletion',async()=>{
  const cancelled:string[]=[]
  const client={
    async startCompetitionJob(intent:CompetitionJobIntent){return {jobId:intent.jobId,kind:'notebook',phase:'failed',startedAt:1,finishedAt:2,exitCode:null,oomKilled:false,progress:null,error:'Competition resources are unavailable',failure:{code:'unschedulable',resource:'memory'}}},
    async competitionJob(){throw new Error('terminal already')},async collectCompetitionJob(){throw new Error('must not collect')},
    async cancelCompetitionJob(jobId:string){cancelled.push(jobId)},async competitionJobs(){return []},
  }
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  await assert.rejects(()=>runner.run({competition,submissionId,attemptId,container:'colloq-comp-unschedulable',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits}),error=>error instanceof CompetitionResourcePending&&error.resource==='memory')
  assert.equal(cancelled.length,1)
})

test('collected notebook is not accepted when broker cannot confirm Pod cleanup',async()=>{
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  fs.mkdirSync(resultDir,{recursive:true})
  const client=fakeClient(()=>{
    fs.writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({attemptId,status:'ok',cell:0,cells:1}))
    fs.writeFileSync(path.join(resultDir,'submission.csv'),'id,target\n1,2\n')
  })
  client.cancelCompetitionJob=async()=>{throw new Error('Pod cleanup not confirmed')}
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  await assert.rejects(()=>runner.run({competition,submissionId,attemptId,container:'colloq-comp-cleanup',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits}),/cleanup not confirmed/)
})

test('failed notebook export cannot reuse a matching stale report and answer',async()=>{
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  fs.mkdirSync(resultDir,{recursive:true})
  fs.writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({attemptId,status:'ok',cell:4,cells:5,detail:'stale'}))
  fs.writeFileSync(path.join(resultDir,'submission.csv'),'id,target\n1,2\n')
  const client={
    async startCompetitionJob(intent:CompetitionJobIntent){return {...status(intent,'complete'),phase:'failed',failure:{code:'export_failed'},error:'Export failed'}},
    async competitionJob(){throw new Error('terminal already')},async collectCompetitionJob(){throw new Error('must not collect')},
    async cancelCompetitionJob(){},async competitionJobs(){return []},
  }
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const outcome=await runner.run({competition,submissionId,attemptId,container:'colloq-comp-stale-run',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits})
  assert.equal(outcome.status,'harness_error')
  assert.equal(outcome.submission,null)
  assert.equal(outcome.detail,'')
})

test('failed scorer export cannot reuse a matching stale score',async()=>{
  const outDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'score-out')
  fs.mkdirSync(outDir,{recursive:true})
  fs.writeFileSync(path.join(outDir,'score.json'),JSON.stringify({attemptId,status:'participant_error',message:'stale',public:0.9,private:0.8}))
  const client={
    async startCompetitionJob(intent:CompetitionJobIntent){return {...status(intent,'complete'),phase:'failed',exitCode:1,failure:{code:'export_failed'},error:'Export failed'}},
    async competitionJob(){throw new Error('terminal already')},async collectCompetitionJob(){throw new Error('must not collect')},
    async cancelCompetitionJob(){},async competitionJobs(){return []},
  }
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const outcome=await runner.score({competition,submissionId,attemptId,container:'colloq-comp-stale-score',imageDigest:image,secretDir:'ignored',submissionDir:'ignored',outDir,limits})
  assert.equal(outcome.status,'metric_error')
  assert.equal(outcome.public,null)
  assert.equal(outcome.private,null)
  assert.equal(outcome.message,null)
})
