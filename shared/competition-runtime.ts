/** Private app → runtime broker contract. IDs select known PVC subdirectories;
 * callers never send a Kubernetes Pod, mount path or arbitrary command. */
export type CompetitionJobKind = 'notebook' | 'metric' | 'inventory' | 'resolve' | 'verify'
export interface CompetitionJobLimits {
  wallSeconds: number
  memoryMb: number
  cpus: number
  pids: number
  tmpfsMb: number
  targetBytes: number
}
export interface CompetitionJobIntent {
  schemaVersion: 1
  jobId: string
  kind: CompetitionJobKind
  environment: string
  revision: string
  competitionId?: string
  submissionId?: string
  attemptId?: string
  preparationId?: string
  bundleId?: string
  limits: CompetitionJobLimits
}
export interface CompetitionJobProgress { phase: 'dependencies' | 'notebook' | 'score' | 'resolve' | 'verify'; cell: number; cells: number; outputBytes: number }
export interface CompetitionJobStatus {
  jobId: string
  kind: CompetitionJobKind
  phase: 'queued' | 'running' | 'exporting' | 'complete' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt: number | null
  exitCode: number | null
  oomKilled: boolean
  progress: CompetitionJobProgress | null
  error: string | null
  failure?: { code: 'unschedulable' | 'image_unavailable' | 'runtime_unavailable' | 'export_failed'; resource?: 'memory' | 'cpu' | 'storage' | 'other' }
}
export interface CompetitionJobCollection { files: {name:string;bytes:number;sha256:string}[]; totalBytes:number }
export const COMPETITION_JOB_ID = /^[a-f0-9]{32}$/
export const COMPETITION_ATTEMPT_ID = /^[a-f0-9]{32}$/
export const COMPETITION_ROW_ID = /^[a-z2-9]{8}$/
export const COMPETITION_REVISION = /^sha256:[a-f0-9]{64}$/
const kinds: ReadonlySet<CompetitionJobKind> = new Set(['notebook','metric','inventory','resolve','verify'])
const integer=(v:unknown,min:number,max:number):v is number => Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max
export function parseCompetitionJobIntent(value:unknown):CompetitionJobIntent {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid competition job')
 const v=value as Record<string,unknown>
 if(Object.keys(v).some(key=>!['schemaVersion','jobId','kind','environment','revision','competitionId','submissionId','attemptId','preparationId','bundleId','limits'].includes(key))||v.schemaVersion!==1||typeof v.kind!=='string'||!kinds.has(v.kind as CompetitionJobKind)||typeof v.jobId!=='string'||!COMPETITION_JOB_ID.test(v.jobId)||typeof v.environment!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/.test(v.environment)||typeof v.revision!=='string'||!COMPETITION_REVISION.test(v.revision))throw new Error('Invalid competition job identity')
 const present=(key:string,re:RegExp):boolean=>typeof v[key]==='string'&&re.test(v[key] as string)
 if((v.kind==='notebook'||v.kind==='metric')&&(!present('competitionId',COMPETITION_ROW_ID)||!present('submissionId',COMPETITION_ROW_ID)||!present('attemptId',COMPETITION_ATTEMPT_ID)))throw new Error('Invalid submission job identity')
 if((v.kind==='resolve'||v.kind==='verify')&&!present('preparationId',COMPETITION_ATTEMPT_ID))throw new Error('Invalid preparation job identity')
 for(const key of ['competitionId','submissionId','attemptId','preparationId','bundleId'])if(v[key]!==undefined&&!present(key,key==='competitionId'||key==='submissionId'?COMPETITION_ROW_ID:COMPETITION_ATTEMPT_ID))throw new Error('Invalid competition job reference')
 const limits=v.limits
 if(!limits||typeof limits!=='object'||Array.isArray(limits))throw new Error('Invalid competition job limits')
 const n=limits as Record<string,unknown>
 if(Object.keys(n).some(key=>!['wallSeconds','memoryMb','cpus','pids','tmpfsMb','targetBytes'].includes(key))||!integer(n.wallSeconds,1,14400)||!integer(n.memoryMb,128,65536)||!integer(n.cpus,1,32)||!integer(n.pids,16,2048)||!integer(n.tmpfsMb,16,4096)||!integer(n.targetBytes,1,512*1024*1024))throw new Error('Invalid competition job limits')
 if(v.kind==='notebook'||v.kind==='metric'){
  if(v.preparationId!==undefined||v.kind==='metric'&&v.bundleId!==undefined)throw new Error('Unexpected job reference')
 }else if(v.kind==='resolve'||v.kind==='verify'){
  if(v.competitionId!==undefined||v.submissionId!==undefined||v.attemptId!==undefined||v.bundleId!==undefined)throw new Error('Unexpected submission reference')
 }else if(v.competitionId!==undefined||v.submissionId!==undefined||v.attemptId!==undefined||v.preparationId!==undefined||v.bundleId!==undefined)throw new Error('Unexpected inventory reference')
 return v as unknown as CompetitionJobIntent
}

const phases: ReadonlySet<CompetitionJobStatus['phase']> = new Set(['queued','running','exporting','complete','failed','cancelled'])
const progressPhases: ReadonlySet<CompetitionJobProgress['phase']> = new Set(['dependencies','notebook','score','resolve','verify'])
export function parseCompetitionJobStatus(value:unknown):CompetitionJobStatus {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid competition job status')
 const v=value as Record<string,unknown>
 if(Object.keys(v).some(k=>!['jobId','kind','phase','startedAt','finishedAt','exitCode','oomKilled','progress','error','failure'].includes(k))||typeof v.jobId!=='string'||!COMPETITION_JOB_ID.test(v.jobId)||typeof v.kind!=='string'||!kinds.has(v.kind as CompetitionJobKind)||typeof v.phase!=='string'||!phases.has(v.phase as CompetitionJobStatus['phase'])||!integer(v.startedAt,0,Number.MAX_SAFE_INTEGER)||v.finishedAt!==null&&!integer(v.finishedAt,0,Number.MAX_SAFE_INTEGER)||v.exitCode!==null&&!integer(v.exitCode,0,255)||typeof v.oomKilled!=='boolean'||v.error!==null&&(typeof v.error!=='string'||v.error.length>500))throw new Error('Invalid competition job status')
 if(v.failure!==undefined){
  const f=v.failure
  if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).some(k=>!['code','resource'].includes(k))||!['unschedulable','image_unavailable','runtime_unavailable','export_failed'].includes((f as Record<string,unknown>).code as string)||((f as Record<string,unknown>).resource!==undefined&&!['memory','cpu','storage','other'].includes((f as Record<string,unknown>).resource as string)))throw new Error('Invalid competition job failure')
 }
 if(v.progress!==null){
  if(!v.progress||typeof v.progress!=='object'||Array.isArray(v.progress))throw new Error('Invalid competition job progress')
  const p=v.progress as Record<string,unknown>
  if(Object.keys(p).some(k=>!['phase','cell','cells','outputBytes'].includes(k))||typeof p.phase!=='string'||!progressPhases.has(p.phase as CompetitionJobProgress['phase'])||!integer(p.cell,-1,100000)||!integer(p.cells,0,100000)||!integer(p.outputBytes,0,Number.MAX_SAFE_INTEGER))throw new Error('Invalid competition job progress')
 }
 return v as unknown as CompetitionJobStatus
}
export function parseCompetitionJobCollection(value:unknown):CompetitionJobCollection {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid competition job collection')
 const v=value as Record<string,unknown>,files=v.files
 if(Object.keys(v).some(k=>!['files','totalBytes'].includes(k))||!Array.isArray(files)||files.length>260||!integer(v.totalBytes,0,512*1024*1024))throw new Error('Invalid competition job collection')
 let bytes=0
 const seen=new Set<string>()
 for(const item of files){
  if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Invalid competition job file')
  const f=item as Record<string,unknown>
  if(Object.keys(f).some(k=>!['name','bytes','sha256'].includes(k))||typeof f.name!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(f.name)||/^wheels\/[A-Za-z0-9][A-Za-z0-9_.+!-]{0,230}\.whl$/.test(f.name))||seen.has(f.name)||!integer(f.bytes,0,512*1024*1024)||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))throw new Error('Invalid competition job file')
  seen.add(f.name);bytes+=f.bytes
 }
 if(bytes!==v.totalBytes)throw new Error('Invalid competition job byte count')
 return v as unknown as CompetitionJobCollection
}
