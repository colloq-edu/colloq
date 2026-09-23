import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { imageRevision, kernelRuntimeClient, loadRuntimeCatalog, type RuntimeClient } from '../kernel/runtime-client.js'
import { resolveRuntimeEnvironment } from '@shared/runtime'
import { parseCompetitionJobIntent, type CompetitionJobIntent, type CompetitionJobStatus } from '@shared/competition-runtime'
import { competitionsFs, attemptDir } from './storage.js'
import { DEFAULT_ID_COLUMN, verdictOfRun } from './docker-runner.js'
import { brokerHarnessDir } from './harness.js'
import { registerCompetitionRunner, type Capacity, type CompetitionRunner, type RunOutcome, type RunRequest, type ScoreOutcome, type ScoreRequest } from './runner-port.js'

const sleep = (ms:number) => new Promise<void>(resolve => setTimeout(resolve,ms))
const number = (value:unknown):number|null => typeof value==='number' && Number.isFinite(value) ? value : null
const scoreVerdicts=new Set(['ok','participant_error','metric_error','target_unreadable','target_too_large','no-submission','exit','timeout','out-of-memory'])
function reportAllowed(status:CompetitionJobStatus,reportStatus:unknown):boolean {
  if(status.failure||status.oomKilled||status.error==='Wall time limit exceeded')return false
  if(status.phase==='complete')return status.exitCode===0
  return status.phase==='failed'&&status.exitCode!==null&&status.exitCode!==0&&reportStatus!=='ok'
}
function report(file:string):Record<string,unknown>|null {
  try {
    if (competitionsFs.statSync(file).size > 1024*1024) return null
    const parsed:unknown=JSON.parse((competitionsFs.readFileSync(file) as Buffer).toString('utf8'))
    return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed as Record<string,unknown> : null
  } catch { return null }
}
const terminal = (phase:CompetitionJobStatus['phase']) => ['complete','failed','cancelled'].includes(phase)
export interface BrokerRunnerOptions { catalog?: typeof loadRuntimeCatalog; pollMs?: number }
export class CompetitionResourcePending extends Error {
  constructor(readonly resource:'memory'|'cpu'|'storage'|'other'='other',readonly kind:'notebook'|'metric'='notebook') {
    super('Competition resources are unavailable; the job will retry from the queue.')
    this.name='CompetitionResourcePending'
  }
}

/** The broker alone maps these typed IDs to PVC subPaths and owns Pods. */
export class BrokerCompetitionRunner implements CompetitionRunner {
  readonly backend='broker' as const
  private readonly jobs=new Map<string,string>()
  constructor(private readonly client:Pick<RuntimeClient,'startCompetitionJob'|'competitionJob'|'collectCompetitionJob'|'cancelCompetitionJob'|'competitionJobs'> = kernelRuntimeClient(), private readonly options:BrokerRunnerOptions={}) {}

  private revision(environment:string, image:string|undefined):string {
    if (!image || !image.includes('@')) throw new Error('Competition broker requires a pinned catalog image')
    const revision=imageRevision(image)
    const selected=resolveRuntimeEnvironment((this.options.catalog??loadRuntimeCatalog)(),environment,revision)
    if (selected.image!==image) throw new Error('Competition image is not in the runtime catalog')
    return revision
  }
  private async execute(container:string,intent:CompetitionJobIntent,signal?:AbortSignal,onProgress?:(status:CompetitionJobStatus)=>void):Promise<CompetitionJobStatus> {
    const job=parseCompetitionJobIntent(intent)
    if (signal?.aborted) throw signal.reason ?? new Error('Competition job cancelled')
    this.jobs.set(container,job.jobId)
    const abort=()=>{void this.client.cancelCompetitionJob(job.jobId).catch(()=>undefined)}
    signal?.addEventListener('abort',abort,{once:true})
    try {
      let status=await this.client.startCompetitionJob(job)
      const deadline=Date.now()+job.limits.wallSeconds*1000+60_000
      let collected=false
      while(!terminal(status.phase)) {
        if (signal?.aborted) throw signal.reason ?? new Error('Competition job cancelled')
        if (Date.now()>deadline) { await this.client.cancelCompetitionJob(job.jobId); throw new Error('Competition job exceeded its deadline') }
        if(status.phase==='exporting') { await this.client.collectCompetitionJob(job.jobId);collected=true;status=await this.client.competitionJob(job.jobId);continue }
        onProgress?.(status)
        await sleep(this.options.pollMs??500)
        status=await this.client.competitionJob(job.jobId)
      }
      if (signal?.aborted) throw signal.reason ?? new Error('Competition job cancelled')
      if(status.failure?.code==='unschedulable')throw new CompetitionResourcePending(status.failure.resource??'other',job.kind==='metric'?'metric':'notebook')
      if (status.phase==='complete'&&!collected) await this.client.collectCompetitionJob(job.jobId)
      return status
    } finally {
      signal?.removeEventListener('abort',abort)
      try { await this.client.cancelCompetitionJob(job.jobId) } finally { this.jobs.delete(container) }
    }
  }
  async run(request:RunRequest):Promise<RunOutcome> {
    const started=Date.now()
    if (!request.attemptId) throw new Error('Competition broker requires an attempt ID')
    const revision=this.revision(request.competition.environment,request.imageDigest)
    brokerHarnessDir()
    competitionsFs.mkdirSync(request.resultDir,{recursive:true})
    competitionsFs.chmodSync(request.resultDir,0o700)
    const bundleId=request.dependenciesDir ? path.basename(request.dependenciesDir) : undefined
    const jobId=randomUUID().replaceAll('-','')
    const intent:CompetitionJobIntent={schemaVersion:1,jobId,kind:'notebook',environment:request.competition.environment,revision,
      competitionId:request.competition.id,submissionId:request.submissionId,attemptId:request.attemptId,...(bundleId?{bundleId}:{}),
      limits:{wallSeconds:request.limits.wallSeconds,memoryMb:request.limits.memoryMb,cpus:request.limits.cpus,pids:request.limits.pids,tmpfsMb:request.limits.tmpfsMb,targetBytes:request.limits.targetBytes}}
    let progress:CompetitionJobStatus['progress']=null
    const status=await this.execute(request.container,intent,request.signal,s=>{
      if (!s.progress || s.progress.phase==='score') return
      const next=s.progress
      if (JSON.stringify(progress)===JSON.stringify(next)) return
      progress=next
      request.onProgress?.({phase:next.phase==='dependencies'?'dependencies':'notebook',cell:next.cell,cells:next.cells,outputBytes:next.outputBytes})
    })
    const observed=report(path.join(request.resultDir,'run.json'))
    const run=observed?.attemptId===request.attemptId&&reportAllowed(status,observed.status)?observed:null
    const answer=path.join(request.resultDir,'submission.csv')
    const produced=!!run&&competitionsFs.existsSync(answer)
    const rawStatus=status.exitCode!==0&&run?.status==='ok'?'exit':typeof run?.status==='string'?run.status:status.phase==='failed'?'harness_error':status.phase==='cancelled'?'exit':null
    const killedBy=status.error==='Wall time limit exceeded'?'wall':null
    const verdict=verdictOfRun({oom:status.oomKilled,killedBy,status:rawStatus,produced})
    const beat=progress as CompetitionJobStatus['progress']
    return {status:verdict,cell:number(run?.cell)??beat?.cell??-1,cells:number(run?.cells)??beat?.cells??0,
      wall:Date.now()-started,submission:verdict==='ok'&&produced?answer:null,
      detail:typeof run?.detail==='string'?run.detail:'',log:status.error??'',
      diagnostics:{exit:status.exitCode,oomKilled:status.oomKilled,backend:this.backend,peakBytes:number(run?.peakBytes)}}
  }
  async score(request:ScoreRequest):Promise<ScoreOutcome> {
    const started=Date.now()
    if (!request.attemptId) throw new Error('Competition broker requires an attempt ID')
    const revision=this.revision(request.competition.environment,request.imageDigest)
    brokerHarnessDir()
    competitionsFs.mkdirSync(request.outDir,{recursive:true})
    competitionsFs.chmodSync(request.outDir,0o700)
    const config=attemptDir(request.competition.id,request.submissionId,request.attemptId,'score-config')
    competitionsFs.chmodSync(config,0o700)
    competitionsFs.writeFileSync(path.join(config,'request.json'),JSON.stringify({idColumn:DEFAULT_ID_COLUMN,publicPercent:request.competition.publicPercent,splitSeed:request.competition.splitSeed}),{mode:0o600})
    const intent:CompetitionJobIntent={schemaVersion:1,jobId:randomUUID().replaceAll('-',''),kind:'metric',environment:request.competition.environment,revision,
      competitionId:request.competition.id,submissionId:request.submissionId,attemptId:request.attemptId,
      limits:{wallSeconds:request.limits.wallSeconds,memoryMb:request.limits.memoryMb,cpus:request.limits.cpus,pids:request.limits.pids,tmpfsMb:request.limits.tmpfsMb,targetBytes:request.limits.targetBytes}}
    const status=await this.execute(request.container,intent,request.signal)
    const raw=report(path.join(request.outDir,'score.json'))
    const score=raw?.attemptId===request.attemptId?raw:null
    const valid=!!score && reportAllowed(status,score.status)
    const metricStatus=valid&&typeof score.status==='string'&&scoreVerdicts.has(score.status)?score.status:'metric_error'
    return {status:metricStatus as ScoreOutcome['status'],public:valid?number(score?.public):null,private:valid?number(score?.private):null,
      message:valid?(typeof score?.message==='string'?score.message:typeof score?.code==='string'?JSON.stringify({code:score.code,params:score.params??{}}):null):null,
      teacherOnly:valid&&typeof score?.teacherOnly==='string'?score.teacherOnly:status.error??(valid?null:'No score.json from broker scorer'),
      wall:Date.now()-started,diagnostics:{exit:status.exitCode,oomKilled:status.oomKilled,backend:this.backend}}
  }
  async kill(container:string):Promise<void> { const id=this.jobs.get(container); if (id) await this.client.cancelCompetitionJob(id) }
  async sweep():Promise<number> {
    let count=0
    for (const job of await this.client.competitionJobs()) {
      if ([...this.jobs.values()].includes(job.jobId)) continue
      await this.client.cancelCompetitionJob(job.jobId);count++
    }
    return count
  }
  async capacity():Promise<Capacity> { return {availableMb:null} }
}

registerCompetitionRunner('broker',()=>new BrokerCompetitionRunner())
