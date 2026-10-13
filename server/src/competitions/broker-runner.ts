import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { imageRevision, kernelRuntimeClient, loadRuntimeCatalog, type RuntimeClient } from '../kernel/runtime-client.js'
import { resolveRuntimeEnvironment } from '@shared/runtime'
import { COMPETITION_GPU_PULL_SECONDS_MAX, COMPETITION_RESOURCES_UNAVAILABLE, parseCompetitionJobIntent, type CompetitionJobIntent, type CompetitionJobStatus } from '@shared/competition-runtime'
import { competitionsFs, attemptDir, attemptPath } from './storage.js'
import { DEFAULT_ID_COLUMN, dependencyFailureOf, verdictOfRun } from './docker-runner.js'
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
/** `now`: the clock the job deadlines are read on, for tests. */
export interface BrokerRunnerOptions { catalog?: typeof loadRuntimeCatalog; pollMs?: number; now?: () => number }
/**
 * `gpu`: no node had a free unit of the cluster's GPU resource for a notebook
 * given a card, or the API server refused its Pod (a quota, a RuntimeClass, an
 * admission policy).
 *
 * `detail`: the broker's own words for why, when it has more to say than that
 * resources are unavailable (shared/competition-runtime.ts ·
 * COMPETITION_RESOURCES_UNAVAILABLE) — the teacher reads them while the job
 * waits in the queue, so that a quota used up or a RuntimeClass missing on the
 * cluster is not a mystery behind "unschedulable".
 */
export class CompetitionResourcePending extends Error {
  constructor(readonly resource:'memory'|'cpu'|'storage'|'gpu'|'other'='other',readonly kind:'notebook'|'metric'='notebook',readonly detail:string|null=null) {
    super('Competition resources are unavailable; the job will retry from the queue.')
    this.name='CompetitionResourcePending'
  }
  /** What the teacher reads while the job waits (runner.ts · runJob). */
  get teacherReason():string {
    return `Competition Pod unschedulable (${this.resource})${this.detail?`: ${this.detail}`:''}; retrying automatically.`
  }
}

/** The broker alone maps these typed IDs to PVC subPaths and owns Pods. */
export class BrokerCompetitionRunner implements CompetitionRunner {
  readonly backend='broker' as const
  private readonly jobs=new Map<string,string>()
  constructor(private readonly client:Pick<RuntimeClient,'startCompetitionJob'|'competitionJob'|'collectCompetitionJob'|'cancelCompetitionJob'|'competitionJobs'> = kernelRuntimeClient(), private readonly options:BrokerRunnerOptions={}) {}

  /** The catalog revision of a pinned image, and whether its environment is a GPU one. */
  private environment(environment:string, image:string|undefined):{revision:string;gpu:boolean} {
    if (!image || !image.includes('@')) throw new Error('Competition broker requires a pinned catalog image')
    const revision=imageRevision(image)
    const selected=resolveRuntimeEnvironment((this.options.catalog??loadRuntimeCatalog)(),environment,revision)
    if (selected.image!==image) throw new Error('Competition image is not in the runtime catalog')
    return {revision,gpu:selected.gpu}
  }
  private async execute(container:string,intent:CompetitionJobIntent,gpuImage:boolean,signal?:AbortSignal,onProgress?:(status:CompetitionJobStatus)=>void):Promise<CompetitionJobStatus> {
    const job=parseCompetitionJobIntent(intent)
    const now=this.options.now??Date.now
    if (signal?.aborted) throw signal.reason ?? new Error('Competition job cancelled')
    this.jobs.set(container,job.jobId)
    const abort=()=>{void this.client.cancelCompetitionJob(job.jobId).catch(()=>undefined)}
    signal?.addEventListener('abort',abort,{once:true})
    try {
      let status=await this.client.startCompetitionJob(job)
      /*
       * How long the job may take before the broker is given up on: its limit
       * and a minute to export, from the moment the start came back.
       *
       * A GPU environment's image (10 to 13 GB) may first be pulled onto a
       * node that never ran it, and the broker gives it time for that before
       * the job's own clock starts (RUNTIME_COMPETITION_GPU_PULL_SECONDS,
       * competition-jobs.ts · pullSeconds). Counted from the start call, the
       * pull came out of the notebook's own time here too, and a notebook
       * that trained to its limit was cancelled as late. So for such an image
       * the limit counts from the moment `main` is seen started, as the
       * broker's and the harness's do (run_notebook.py · stop_at), and while
       * it is still queued the most any broker may allow for the pull
       * (COMPETITION_GPU_PULL_SECONDS_MAX) and its 30 seconds of startup come
       * on top: the broker says when a pull took too long, not this loop. A
       * CPU image keeps the one deadline it always had.
       */
      const limit=job.limits.wallSeconds*1000+60_000
      let deadline=now()+limit+(gpuImage?(30+COMPETITION_GPU_PULL_SECONDS_MAX)*1000:0)
      let started=!gpuImage
      let collected=false
      while(!terminal(status.phase)) {
        if (signal?.aborted) throw signal.reason ?? new Error('Competition job cancelled')
        if (!started&&status.phase!=='queued') { started=true;deadline=now()+limit }
        if (now()>deadline) { await this.client.cancelCompetitionJob(job.jobId); throw new Error('Competition job exceeded its deadline') }
        if(status.phase==='exporting') { await this.client.collectCompetitionJob(job.jobId);collected=true;status=await this.client.competitionJob(job.jobId);continue }
        onProgress?.(status)
        await sleep(this.options.pollMs??500)
        status=await this.client.competitionJob(job.jobId)
      }
      if (signal?.aborted) throw signal.reason ?? new Error('Competition job cancelled')
      if(status.failure?.code==='unschedulable')throw new CompetitionResourcePending(status.failure.resource??'other',job.kind==='metric'?'metric':'notebook',
        status.error&&status.error!==COMPETITION_RESOURCES_UNAVAILABLE?status.error:null)
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
    const {revision,gpu:gpuImage}=this.environment(request.competition.environment,request.imageDigest)
    brokerHarnessDir()
    competitionsFs.mkdirSync(request.resultDir,{recursive:true})
    competitionsFs.chmodSync(request.resultDir,0o700)
    const bundleId=request.dependenciesDir ? path.basename(request.dependenciesDir) : undefined
    // The set's own memory-backed room, sized for it (runner-port.ts · RunRequest.packagesMb).
    const packagesMb=bundleId&&request.packagesMb ? Math.max(1,Math.ceil(request.packagesMb)) : undefined
    // The broker mounts the attempt's inputs folder by its typed IDs; a data
    // folder handed over as anything else would be read by nobody, and the run
    // would quietly score the open example instead of the hidden test.
    if (request.sealedInputs && path.resolve(request.dataDir)!==path.resolve(attemptPath(request.competition.id,request.submissionId,request.attemptId,'inputs'))) {
      throw new Error('Competition broker: sealed inputs must be the attempt inputs folder')
    }
    const jobId=randomUUID().replaceAll('-','')
    /*
     * A card only when the queue gave this attempt one (runner-port.ts ·
     * RunRequest.gpu), and then as a bare flag: which resource and how many
     * units are the cluster's to say (RUNTIME_COMPETITION_GPU_*). Never for a
     * notebook without one: a broker older than GPU jobs refuses the unknown
     * key, and every CPU submission would fail with it.
     */
    const intent:CompetitionJobIntent={schemaVersion:1,jobId,kind:'notebook',environment:request.competition.environment,revision,
      competitionId:request.competition.id,submissionId:request.submissionId,attemptId:request.attemptId,...(bundleId?{bundleId}:{}),
      ...(request.sealedInputs?{sealedInputs:true as const}:{}),
      ...(request.gpu?{gpu:true as const}:{}),
      limits:{wallSeconds:request.limits.wallSeconds,memoryMb:request.limits.memoryMb,cpus:request.limits.cpus,pids:request.limits.pids,tmpfsMb:request.limits.tmpfsMb,targetBytes:request.limits.targetBytes,
        ...(packagesMb?{packagesMb}:{})}}
    let progress:CompetitionJobStatus['progress']=null
    const status=await this.execute(request.container,intent,gpuImage,request.signal,s=>{
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
      ...dependencyFailureOf(verdict,run,packagesMb??request.limits.tmpfsMb),
      diagnostics:{exit:status.exitCode,oomKilled:status.oomKilled,backend:this.backend,peakBytes:number(run?.peakBytes)}}
  }
  async score(request:ScoreRequest):Promise<ScoreOutcome> {
    const started=Date.now()
    if (!request.attemptId) throw new Error('Competition broker requires an attempt ID')
    const {revision,gpu:gpuImage}=this.environment(request.competition.environment,request.imageDigest)
    brokerHarnessDir()
    competitionsFs.mkdirSync(request.outDir,{recursive:true})
    competitionsFs.chmodSync(request.outDir,0o700)
    const config=attemptDir(request.competition.id,request.submissionId,request.attemptId,'score-config')
    competitionsFs.chmodSync(config,0o700)
    competitionsFs.writeFileSync(path.join(config,'request.json'),JSON.stringify({idColumn:DEFAULT_ID_COLUMN,publicPercent:request.competition.publicPercent,splitSeed:request.competition.splitSeed}),{mode:0o600})
    // Never a card for the metric, whatever the notebook had: it holds the hidden answers.
    const intent:CompetitionJobIntent={schemaVersion:1,jobId:randomUUID().replaceAll('-',''),kind:'metric',environment:request.competition.environment,revision,
      competitionId:request.competition.id,submissionId:request.submissionId,attemptId:request.attemptId,
      limits:{wallSeconds:request.limits.wallSeconds,memoryMb:request.limits.memoryMb,cpus:request.limits.cpus,pids:request.limits.pids,tmpfsMb:request.limits.tmpfsMb,targetBytes:request.limits.targetBytes}}
    const status=await this.execute(request.container,intent,gpuImage,request.signal)
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
