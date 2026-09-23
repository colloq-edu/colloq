/** Staff-only operational picture: counters and capabilities, never credentials,
 * file paths, participant names, notebook contents or raw container output. */
import {db} from '../db.js'
import {competitionExecutionDiagnostics} from '../competitions/runner.js'
import {competitionCapabilities} from '../competitions/capabilities.js'
import {workBudgetSnapshot} from './work-budget.js'
import {persistenceDiagnostics} from '../collab/persistence.js'
import {kernelRecoveryDiagnostics} from '../kernel/pool.js'
import {freeDependencyBytes} from '../dependencies/files.js'
import {dependencyPreparationDiagnostics} from '../dependencies/service.js'

function queue(table:'competition_queue'|'dependency_bundles',timestamp:'enqueued_at'|'created_at',waiting:'waiting'|'queued',active:string[]){
 const rows=db.prepare(`SELECT state,COUNT(*) AS count,MIN(${timestamp}) AS oldest FROM ${table} GROUP BY state`).all() as {state:string;count:number;oldest:number}[]
 const oldest=rows.find(r=>r.state===waiting)?.oldest
 return {waiting:rows.find(r=>r.state===waiting)?.count??0,running:rows.filter(r=>active.includes(r.state)).reduce((sum,r)=>sum+r.count,0),oldestWaitingMs:oldest?Math.max(0,Date.now()-oldest):0,states:Object.fromEntries(rows.map(r=>[r.state,r.count]))}
}
export async function operationalStatus(){
 const reservations=workBudgetSnapshot()
 let freeBytes:number|null=null
 try{freeBytes=freeDependencyBytes()}catch{/* an unavailable storage is a state, not an endpoint failure */}
 const artifacts=db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count FROM dependency_artifacts').get() as {bytes:number;count:number}
 const orphan=db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM dependency_artifacts a WHERE NOT EXISTS(SELECT 1 FROM dependency_bundle_artifacts b WHERE b.sha256=a.sha256)').get() as {bytes:number}
 const retries=db.prepare('SELECT COALESCE(SUM(MAX(attempts-1,0)),0) AS retries FROM competition_queue').get() as {retries:number}
 return {
  checkedAt:Date.now(),capabilities:await competitionCapabilities(),reservations,
  storage:{available:freeBytes!==null&&freeBytes>reservations.diskBytes,freeBytes,reservedBytes:reservations.diskBytes,dependencyArtifactBytes:artifacts.bytes,dependencyArtifactCount:artifacts.count,unreferencedArtifactBytes:orphan.bytes},
  queues:{competitions:{...queue('competition_queue','enqueued_at','waiting',['running']),retries:retries.retries,execution:competitionExecutionDiagnostics()},preparations:queue('dependency_bundles','created_at','queued',['resolving','downloading','verifying'])},
  preparation:dependencyPreparationDiagnostics(),persistence:persistenceDiagnostics(),runtimeRecovery:kernelRecoveryDiagnostics(),
 }
}
