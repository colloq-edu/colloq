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

test('broker gives a package set the room the app sized, and reads a full room as the set not fitting',async()=>{
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  fs.mkdirSync(resultDir,{recursive:true})
  const bundleId='e'.repeat(32)
  let sent:CompetitionJobIntent|null=null,collected=false,jobId=''
  const client={
    async startCompetitionJob(intent:CompetitionJobIntent){sent=intent;jobId=intent.jobId;return {...status(intent,'running'),exitCode:null}},
    async competitionJob(){return {jobId,kind:'notebook',phase:collected?'failed':'exporting',startedAt:1,finishedAt:2,exitCode:1,oomKilled:false,progress:null,error:null}},
    async collectCompetitionJob(){
      collected=true
      fs.writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({attemptId,status:'dependency_error',reason:'no_space',roomBytes:379*1024*1024,cell:-1,cells:0,detail:'[Errno 28] No space left on device'}))
      return {files:[],totalBytes:0}
    },
    async cancelCompetitionJob(){},async competitionJobs(){return []},
  }
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  const outcome=await runner.run({competition,submissionId,attemptId,container:'colloq-comp-packages',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits,
    dependenciesDir:path.join(TEST_ROOT,'data','dependencies','bundles',bundleId),packagesMb:379})
  assert.equal(sent!.bundleId,bundleId)
  assert.equal(sent!.limits.packagesMb,379)
  assert.equal(outcome.status,'dependency_error')
  assert.deepEqual(outcome.dependencyFailure,{reason:'no_space',roomBytes:379*1024*1024})
})

test('a notebook asks the broker for a card only when the queue gave its attempt one, and the metric never asks',async()=>{
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  const outDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'score-out')
  fs.mkdirSync(resultDir,{recursive:true})
  fs.mkdirSync(outDir,{recursive:true})
  const gpuImage=`registry.example/colloq/kaggle-gpu@${digest}`
  const sent:CompetitionJobIntent[]=[]
  const client=fakeClient(intent=>{
    sent.push(intent)
    if(intent.kind==='metric')fs.writeFileSync(path.join(outDir,'score.json'),JSON.stringify({attemptId,status:'ok',public:0.5,private:0.5}))
    else fs.writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({attemptId,status:'ok',cell:0,cells:1}))
  })
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[
    {name:'kaggle-base',image,gpu:false,current:true},{name:'kaggle-gpu',image:gpuImage,gpu:true,current:true}]}),pollMs:1})
  const onGpu={...competition,environment:'kaggle-gpu'}
  const run=(extra:object)=>runner.run({submissionId,attemptId,container:'colloq-comp-gpu',dataDir:'ignored',inputDir:'ignored',resultDir,limits,...extra} as any)
  // The queue gave this attempt a card: the broker gets the bare flag, never a device, a size or a count.
  await run({competition:onGpu,imageDigest:gpuImage,gpu:{device:'cluster',sliceMb:null,perDevice:1}})
  // A GPU environment without a card, and a CPU one: not a word, so an older broker still takes them.
  await run({competition:onGpu,imageDigest:gpuImage})
  await run({competition,imageDigest:image})
  assert.deepEqual(sent.map(intent=>intent.gpu),[true,undefined,undefined])
  assert.deepEqual(sent.map(intent=>'gpu' in intent),[true,false,false])
  // The metric holds the hidden answers: it runs on the CPU, whatever the notebook had.
  await runner.score({competition:onGpu,submissionId,attemptId,container:'colloq-comp-gpu-score',imageDigest:gpuImage,secretDir:'ignored',submissionDir:'ignored',outDir,limits})
  assert.equal(sent.at(-1)!.kind,'metric')
  assert.equal('gpu' in sent.at(-1)!,false)
})

test('a GPU notebook that found no free card goes back to the queue as a gpu shortage',async()=>{
  const client={
    async startCompetitionJob(intent:CompetitionJobIntent){return {jobId:intent.jobId,kind:'notebook',phase:'failed',startedAt:1,finishedAt:2,exitCode:null,oomKilled:false,progress:null,error:'Competition resources are unavailable',failure:{code:'unschedulable',resource:'gpu'}}},
    async competitionJob(){throw new Error('terminal already')},async collectCompetitionJob(){throw new Error('must not collect')},
    async cancelCompetitionJob(){},async competitionJobs(){return []},
  }
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:true,current:true}]}),pollMs:1})
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  await assert.rejects(()=>runner.run({competition,submissionId,attemptId,container:'colloq-comp-no-card',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits,gpu:{device:'cluster',sliceMb:null,perDevice:1}}),
    error=>error instanceof CompetitionResourcePending&&error.resource==='gpu'&&error.kind==='notebook')
})

test('broker sends no package room without a set',async()=>{
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  fs.mkdirSync(resultDir,{recursive:true})
  let sent:CompetitionJobIntent|null=null
  const client=fakeClient(intent=>{sent=intent;fs.writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({attemptId,status:'ok',cell:0,cells:1}))})
  const runner=new BrokerCompetitionRunner(client as any,{catalog:()=>({schemaVersion:1,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:false,current:true}]}),pollMs:1})
  await runner.run({competition,submissionId,attemptId,container:'colloq-comp-no-set',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits,packagesMb:379})
  assert.equal(sent!.limits.packagesMb,undefined)
})

/*
 * The API server refused a GPU notebook's Pod (a quota, a RuntimeClass, an
 * admission policy): the broker says which in `error`, and the teacher reads
 * it while the job waits in the queue, where before there was only
 * "unschedulable (gpu)" — or, before the broker deferred these, "Forbidden".
 */
test('a GPU notebook refused at admission waits with the broker\'s words for the teacher; a scheduler refusal keeps the short note',async()=>{
  const words="Kubernetes refused the GPU notebook's Pod: the namespace's resource quota is used up (requests.nvidia.com/gpu)"
  const refused=(error:string)=>({
    async startCompetitionJob(intent:CompetitionJobIntent){return {jobId:intent.jobId,kind:'notebook' as const,phase:'failed' as const,startedAt:1,finishedAt:1,exitCode:null,oomKilled:false,progress:null,error,failure:{code:'unschedulable' as const,resource:'gpu' as const}}},
    async competitionJob(){throw new Error('terminal already')},async collectCompetitionJob(){throw new Error('must not collect')},
    async cancelCompetitionJob(){},async competitionJobs(){return []},
  })
  const catalog=()=>({schemaVersion:1 as const,release:'r',defaultEnvironment:'kaggle-base',environments:[{name:'kaggle-base',image,gpu:true,current:true}]})
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  const run=(error:string)=>new BrokerCompetitionRunner(refused(error) as any,{catalog,pollMs:1})
    .run({competition,submissionId,attemptId,container:'colloq-comp-refused',imageDigest:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits,gpu:{device:'',sliceMb:null,perDevice:1}})
  await assert.rejects(()=>run(words),(error:any)=>error instanceof CompetitionResourcePending&&error.resource==='gpu'&&error.detail===words&&
    error.teacherReason===`Competition Pod unschedulable (gpu): ${words}; retrying automatically.`)
  await assert.rejects(()=>run('Competition resources are unavailable'),(error:any)=>error instanceof CompetitionResourcePending&&error.detail===null&&
    error.teacherReason==='Competition Pod unschedulable (gpu); retrying automatically.')
})

/*
 * A GPU environment's image may be pulled onto the node first (10 to 13 GB),
 * and the broker allows for it. The app's own wait counted the pull against
 * the job's limit and cancelled a notebook that trained to its limit after a
 * long pull; for such an image it now counts from the moment the job runs.
 */
test('the wait for a GPU image\'s job counts from its start, not from the call; a CPU image keeps its deadline',async()=>{
  const resultDir=path.join(TEST_ROOT,'data','competitions',competitionId,'s',submissionId,'attempts',attemptId,'result')
  fs.mkdirSync(resultDir,{recursive:true})
  const wall=60
  // Each poll is ten seconds on this clock: queued for five minutes (the pull), then running for the limit.
  const timeline=(clock:{now:number},queuedFor:number,runFor:number)=>{
    let jobId='',polls=0,cancelled=false
    const phase=():CompetitionJobStatus['phase']=>{
      const at=polls*10
      return at<queuedFor?'queued':at<queuedFor+runFor?'running':'complete'
    }
    const at=(intent?:CompetitionJobIntent)=>{
      if(intent)jobId=intent.jobId
      return {jobId,kind:'notebook' as const,phase:phase(),startedAt:1,finishedAt:null,exitCode:phase()==='complete'?0:null,oomKilled:false,progress:null,error:null}
    }
    return {get cancelled(){return cancelled},client:{
      async startCompetitionJob(intent:CompetitionJobIntent){return at(intent)},
      async competitionJob(){polls++;clock.now+=10_000;return at()},
      async collectCompetitionJob(){fs.writeFileSync(path.join(resultDir,'run.json'),JSON.stringify({attemptId,status:'ok',cell:0,cells:1}));return {files:[],totalBytes:0}},
      async cancelCompetitionJob(){if(phase()!=='complete')cancelled=true},async competitionJobs(){return []},
    }}
  }
  const gpuImage=`registry.example/colloq/kaggle-gpu@${digest}`
  const catalog=()=>({schemaVersion:1 as const,release:'r',defaultEnvironment:'kaggle-base',environments:[
    {name:'kaggle-base',image,gpu:false,current:true},{name:'kaggle-gpu',image:gpuImage,gpu:true,current:true}]})
  const run=(gpu:boolean,queuedFor:number,runFor:number)=>{
    const clock={now:1_000_000}
    const job=timeline(clock,queuedFor,runFor)
    const runner=new BrokerCompetitionRunner(job.client as any,{catalog,pollMs:0,now:()=>clock.now})
    return {job,outcome:runner.run({competition:gpu?{...competition,environment:'kaggle-gpu'}:competition,submissionId,attemptId,container:'colloq-comp-pull',
      imageDigest:gpu?gpuImage:image,dataDir:'ignored',inputDir:'ignored',resultDir,limits:{...limits,wallSeconds:wall}})}
  }
  // Five minutes pulling, then the whole limit: the GPU image's job is not given up on.
  const pulled=run(true,300,wall)
  assert.equal((await pulled.outcome).status,'ok')
  assert.equal(pulled.job.cancelled,false)
  // Once it runs, its own limit and a minute to export, as for any job.
  const overran=run(true,300,wall+80)
  await assert.rejects(overran.outcome,/exceeded its deadline/)
  assert.equal(overran.job.cancelled,true)
  // A CPU image's job keeps the deadline from the call: the same five minutes in the queue end it.
  const cpu=run(false,300,wall)
  await assert.rejects(cpu.outcome,/exceeded its deadline/)
  assert.equal(cpu.job.cancelled,true)
  // ...and within it, it runs as before.
  assert.equal((await run(false,20,wall).outcome).status,'ok')
})
