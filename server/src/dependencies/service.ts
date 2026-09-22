import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { db } from '../db.js'
import { submissionsOpen, type Competition, type Submission } from '@shared/competitions'
import { DEPENDENCY_LIMITS, dependencyActive, type AdminDependencyOverview, type DependencyBundle, type DependencyOverview, type EnvironmentRevision } from '@shared/dependencies'
import { getCompetition, getEntrant, joinedAt, listEntrantSubmissions, acceptSubmission, inFlightCount, leftToday } from '../competitions/store.js'
import { competitionBackend } from '../competitions/runner-port.js'
import { prepareDependencies, cleanupPreparationResources } from './preparation.js'
import { DependencyPreparationError } from './preparation-contract.js'
import type { PreparationRequest, PreparationResult } from './preparation-contract.js'
import { ensureCompetitionRevision } from './revisions.js'
import { dependencyMessage } from './messages.js'
import * as store from './store.js'
import * as files from './files.js'

const events=new EventEmitter()
events.setMaxListeners(0)
const controllers=new Map<string,AbortController>()
let timer:ReturnType<typeof setInterval>|null=null
let active:Promise<void>|null=null
let starting:Promise<void>|null=null
let stopping=false
let lastGC=0
const emit=(id:string):void=>{events.emit(id)}
export function watchBundle(id:string,callback:()=>void):()=>void { events.on(id,callback);return()=>events.off(id,callback) }
export function hasJoined(c:string,e:string):boolean { return joinedAt(c,e)!==null||listEntrantSubmissions(c,e).length>0 }
export async function executionRevision(c:Competition):Promise<EnvironmentRevision|null>{
 if(competitionBackend()==='test')return store.competitionRevision(c.id)
 return ensureCompetitionRevision(c)
}
export async function dependencyOverview(c:Competition,eid:string):Promise<DependencyOverview>{
 const revision=await executionRevision(c).catch(()=>null)
 return {policy:store.policyOf(c.id),revision,draft:store.draftOf(c.id,eid),bundles:store.listBundles(c.id,eid),joined:hasJoined(c.id,eid)}
}
export async function adminDependencyOverview(c:Competition):Promise<AdminDependencyOverview>{
 const revision=await executionRevision(c).catch(()=>null)
 return {policy:store.policyOf(c.id),revision,bundles:store.listBundles(c.id).map(b=>({...b,entrantName:getEntrant(b.entrantId)?.name??'—'}))}
}
export function ownBundle(c:string,eid:string,bid:string):DependencyBundle{
 const b=store.getBundle(bid)
 if(!b||b.competitionId!==c||b.entrantId!==eid)throw new store.DependencyStoreError('dependency_owner',404)
 return b
}
export async function prepareBundle(c:Competition,eid:string,text:string):Promise<DependencyBundle>{
 if(!hasJoined(c.id,eid))throw new store.DependencyStoreError('dependency_join',403)
 if(!store.policyOf(c.id).enabled)throw new store.DependencyStoreError('dependency_disabled',403)
 store.checkRequirements(text)
 const revision=await executionRevision(c)
 if(!revision)throw new store.DependencyStoreError('dependency_image',503)
 if(competitionBackend()!=='test')await startDependencyPump()
 const free=files.freeDependencyBytes()
 if(free!==null&&free<store.policyOf(c.id).maxDownloadBytes+256*1024*1024)throw new store.DependencyStoreError('disk_full',507)
 const b=store.createBundle(c.id,eid,revision.id,text)
 wakeDependencyPump()
 return b
}
export async function cancelPreparation(id:string):Promise<DependencyBundle|null>{
 const result=store.cancelBundle(id)
 controllers.get(id)?.abort()
 emit(id)
 return result
}
export function publicExecution(submission:Submission,environmentName:string):Submission {
 return {...submission,execution:store.submissionEnvironment(submission.id,environmentName)}
}
/** SQL acceptance and the environment binding either both commit, or neither does. */
export const acceptPinnedSubmission=db.transaction((c:Competition,eid:string,fileName:string,bytes:number,revision:EnvironmentRevision|null,bundleId:string|null,baseline=false):Submission=>{
 const current=getCompetition(c.id)
 if(!current||current.environment!==c.environment)throw new store.DependencyStoreError('dependency_revision')
 if(!baseline){
  if(submissionsOpen(current,Date.now())!=='open')throw new store.DependencyStoreError('dependency_closed',403)
  if(inFlightCount(c.id,eid)>0)throw new store.DependencyStoreError('dependency_submission_active')
  const left=leftToday(current,eid);if(left!==null&&left<=0)throw new store.DependencyStoreError('dependency_submission_quota',429)
 }
 if(revision&&store.competitionRevision(c.id)?.id!==revision.id)throw new store.DependencyStoreError('dependency_revision')
 store.assertUsableBundle(c.id,eid,revision?.id??'',bundleId)
 const submission=acceptSubmission({competitionId:c.id,entrantId:eid,fileName,bytes})
 store.bindSubmission(submission.id,revision?.id??null,bundleId,revision===null)
 return publicExecution(submission,c.environment)
})
function sanitizedLog(line:string,stage:string):string {
 return line.split(stage).join('[work]').replace(/https?:\/\/\S+/g,'[registry URL]').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(0,1000)
}
export async function processNextPreparation(prepare:(request:PreparationRequest)=>Promise<PreparationResult>=prepareDependencies):Promise<boolean>{
 const bundle=store.claimNextBundle();if(!bundle)return false
 const controller=new AbortController();controllers.set(bundle.id,controller)
 let stage:string|null=null
 try{
  const revision=store.getRevision(bundle.revisionId)
  if(!revision)throw new store.DependencyStoreError('dependency_image',503)
  const free=files.freeDependencyBytes(),limits=store.bundleLimits(bundle.id)
  if(free!==null&&free<limits.maxDownloadBytes+256*1024*1024)throw new store.DependencyStoreError('disk_full',507)
  stage=files.freshStaging(bundle.id)
  const result=await prepare({id:bundle.id,imageDigest:revision.imageDigest,requirementsText:bundle.requirementsText,basePackages:revision.packages,workDir:stage,...limits,wallSeconds:DEPENDENCY_LIMITS.wallSeconds,signal:controller.signal,onProgress(update){
   store.updateProgress(bundle.id,{...update,...(update.log?{log:sanitizedLog(update.log,stage!)}:{})});emit(bundle.id)
  }})
  if(controller.signal.aborted||!dependencyActive(store.getBundle(bundle.id)?.state??'cancelled'))return true
  if(result.downloadBytes>limits.maxDownloadBytes||result.installedBytes>limits.maxInstalledBytes)throw new DependencyPreparationError('installed_limit','Package set exceeds its stored limits')
  await files.publishBundle(bundle.id,result)
  if(!store.completeBundle(bundle.id,result))files.removeBundleFiles(bundle.id)
 }catch(error){
  const errno=error&&typeof error==='object'&&'code' in error?String(error.code):''
  const code=stopping?'worker_restarted':error instanceof store.DependencyStoreError||error instanceof DependencyPreparationError?error.code:['ENOSPC','EDQUOT'].includes(errno)?'disk_full':'preparation_failed'
  const message=dependencyMessage(code)
  if(error instanceof Error&&stage)store.updateProgress(bundle.id,{state:'verifying',log:sanitizedLog(error.message,stage)})
  store.failBundle(bundle.id,code,message,error instanceof DependencyPreparationError?error.line:undefined)
 }finally{
  controllers.delete(bundle.id)
  if(stage)try{files.removeStaging(bundle.id)}catch(error){console.error('[dependencies] staging cleanup failed',error)}
  emit(bundle.id)
 }
 return true
}
function collect():void{
 if(Date.now()-lastGC<3600000)return
 lastGC=Date.now()
 for(const key of store.unusedBundles(Date.now()-DEPENDENCY_LIMITS.retainedUnusedDays*86400000)){
  if(store.removeUnusedBundle(key))files.removeBundleFiles(key)
 }
 for(const hash of store.orphanArtifacts()){files.removeArtifactFile(hash);store.removeOrphanArtifact(hash)}
 files.reconcileArtifacts(store.knownArtifactHashes())
 // Old partial staging is not a durable bundle and is never mounted for execution.
 const root=path.join(files.dependencyRoot,'staging')
 for(const key of fs.readdirSync(root)){
  if(!/^[a-f0-9]{32}$/.test(key))continue
  const b=store.getBundle(key)
  if(b&&dependencyActive(b.state))continue
  if(fs.lstatSync(path.join(root,key)).mtimeMs<Date.now()-86400000)files.removeStaging(key)
 }
}
export function wakeDependencyPump():void{
 if(!timer||active||stopping)return
 active=processNextPreparation().then(()=>undefined).catch(error=>console.error('[dependencies] preparation failed',error)).finally(()=>{active=null;if(!stopping)try{collect()}catch(error){console.error('[dependencies] cleanup failed',error)}})
}
export async function startDependencyPump():Promise<void>{
 if(timer)return
 if(starting)return starting
 starting=(async()=>{
  stopping=false
  await cleanupPreparationResources()
  if(stopping)return
  store.recoverPreparations()
  files.ensureDependencyStorage()
  timer=setInterval(wakeDependencyPump,1000)
  timer.unref()
  wakeDependencyPump()
 })()
 try{await starting}finally{starting=null}
}
export async function stopDependencyPump():Promise<void>{
 stopping=true
 if(timer)clearInterval(timer)
 timer=null
 for(const controller of controllers.values())controller.abort()
 await starting?.catch(()=>undefined)
 await active
}
