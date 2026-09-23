import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DEPENDENCY_LIMITS, requirementLineCount, type DependencyPackage } from '@shared/dependencies'
import { imageRevision, kernelRuntimeClient, loadRuntimeCatalog, type RuntimeClient } from '../kernel/runtime-client.js'
import { resolveRuntimeEnvironment } from '@shared/runtime'
import type { CompetitionJobCollection, CompetitionJobIntent, CompetitionJobKind } from '@shared/competition-runtime'
import { DependencyPreparationError } from './preparation-contract.js'
import type { PreparationRequest, PreparationResult } from './preparation-contract.js'
import { dependencyBrokerHarnessDir } from './broker-harness.js'

type JobClient=Pick<RuntimeClient,'startCompetitionJob'|'competitionJob'|'collectCompetitionJob'|'cancelCompetitionJob'>
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
function readJson(file:string,max=1024*1024):unknown {
  const stat=fs.lstatSync(file)
  if(!stat.isFile()||stat.size>max)throw new DependencyPreparationError('invalid_output','Package preparation returned an invalid manifest.')
  return JSON.parse(fs.readFileSync(file,'utf8'))
}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DependencyPreparationError('invalid_output','Package preparation returned an invalid manifest.')
  return value as Record<string,unknown>
}
function resolvedReport(file:string,maxDownloadBytes:number):Pick<PreparationResult,'normalizedRequirements'|'packages'|'downloadBytes'> {
  const raw=object(readJson(file))
  if(!Array.isArray(raw.normalizedRequirements)||raw.normalizedRequirements.length>DEPENDENCY_LIMITS.lines||
    !raw.normalizedRequirements.every(x=>typeof x==='string'&&x.length<=1024)||
    !Array.isArray(raw.packages)||raw.packages.length>256||!Number.isSafeInteger(raw.downloadBytes)||Number(raw.downloadBytes)<0||Number(raw.downloadBytes)>maxDownloadBytes)
    throw new DependencyPreparationError('invalid_output','Package resolution returned an invalid manifest.')
  const names=new Set<string>(),wheels=new Set<string>()
  for(const pkg of raw.packages) {
    const p=object(pkg)
    if(typeof p.name!=='string'||!/^[-a-z0-9_.]{1,230}$/.test(p.name)||names.has(p.name)||
      typeof p.version!=='string'||!/^\w[\w.+!-]*$/.test(p.version)||
      typeof p.fileName!=='string'||!/^[A-Za-z0-9_.+!\-]+\.whl$/.test(p.fileName)||wheels.has(p.fileName)||
      typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256)||!Number.isSafeInteger(p.bytes)||Number(p.bytes)<0||Number(p.bytes)>maxDownloadBytes)
      throw new DependencyPreparationError('invalid_output','Package resolution returned an invalid wheel manifest.')
    names.add(p.name);wheels.add(p.fileName)
  }
  return raw as unknown as Pick<PreparationResult,'normalizedRequirements'|'packages'|'downloadBytes'>
}
function verifiedReport(file:string,maxInstalledBytes:number):Pick<PreparationResult,'installedBytes'|'lock'> {
  const raw=object(readJson(file))
  if(!Number.isSafeInteger(raw.installedBytes)||Number(raw.installedBytes)<0||Number(raw.installedBytes)>maxInstalledBytes||typeof raw.lock!=='string'||raw.lock.length>1024*1024)
    throw new DependencyPreparationError('invalid_output','Offline verification returned an invalid manifest.')
  return raw as unknown as Pick<PreparationResult,'installedBytes'|'lock'>
}
function workerError(workDir:string):DependencyPreparationError|null {
  try {
    const file=path.join(workDir,'progress.ndjson'),stat=fs.lstatSync(file)
    if(!stat.isFile()||stat.size>128*1024)return null
    const lines=fs.readFileSync(file,'utf8').trim().split('\n').slice(-8)
    for(const line of lines.reverse()) {
      const error=object(JSON.parse(line)).error
      if(!error)continue
      const row=object(error)
      if(typeof row.code==='string'&&/^[a-z_]{1,50}$/.test(row.code)&&typeof row.message==='string'&&row.message.length<=500)
        return new DependencyPreparationError(row.code,row.message,Number.isSafeInteger(row.line)?Number(row.line):undefined)
    }
  }catch{ /* Missing or malformed progress is not a trusted error. */ }
  return null
}

export async function prepareBrokerDependencies(request:PreparationRequest,client:JobClient=kernelRuntimeClient()):Promise<PreparationResult> {
  if(request.signal.aborted)throw new DependencyPreparationError('cancelled','Package preparation was cancelled.')
  if(!request.imageDigest.includes('@'))throw new DependencyPreparationError('image_unpinned','Package preparation requires a catalog image.')
  const revision=imageRevision(request.imageDigest)
  const catalog=loadRuntimeCatalog()
  const entry=catalog.environments.find(e=>e.image===request.imageDigest)
  if(!entry||resolveRuntimeEnvironment(catalog,entry.name,revision).image!==request.imageDigest)throw new DependencyPreparationError('image_unpinned','Package preparation requires a catalog image.')
  if(Buffer.byteLength(request.requirementsText,'utf8')>DEPENDENCY_LIMITS.requestBytes||requirementLineCount(request.requirementsText)>DEPENDENCY_LIMITS.lines)
    throw new DependencyPreparationError('requirements_limit','Requirements exceed their size limit.')
  if(!Number.isSafeInteger(request.maxDownloadBytes)||request.maxDownloadBytes<1||request.maxDownloadBytes>DEPENDENCY_LIMITS.downloadBytes||
    !Number.isSafeInteger(request.maxInstalledBytes)||request.maxInstalledBytes<1||request.maxInstalledBytes>DEPENDENCY_LIMITS.installedBytes)
    throw new DependencyPreparationError('invalid_limits','Invalid package preparation limits.')
  if(!/^[a-f0-9]{32}$/.test(request.id))throw new DependencyPreparationError('invalid_output','Invalid package preparation identity.')
  dependencyBrokerHarnessDir()
  fs.mkdirSync(request.workDir,{recursive:true,mode:0o755})
  if(!fs.lstatSync(request.workDir).isDirectory())throw new DependencyPreparationError('storage_unavailable','Invalid preparation staging directory.')
  fs.chmodSync(request.workDir,0o700)
  const input=path.join(request.workDir,'input'),wheels=path.join(request.workDir,'wheels')
  fs.mkdirSync(input,{mode:0o700});fs.mkdirSync(wheels,{mode:0o700});fs.chmodSync(wheels,0o700)
  const job={requirementsText:request.requirementsText,basePackages:request.basePackages,maxDownloadBytes:request.maxDownloadBytes,maxInstalledBytes:request.maxInstalledBytes}
  const writeInput=(value:object)=>fs.writeFileSync(path.join(input,'request.json'),JSON.stringify(value),{mode:0o600})
  writeInput(job)
  const seconds=Math.min(DEPENDENCY_LIMITS.wallSeconds,Math.max(1,request.wallSeconds??DEPENDENCY_LIMITS.wallSeconds))
  const run=async(kind:Extract<CompetitionJobKind,'resolve'|'verify'>):Promise<CompetitionJobCollection>=>{
    const jobId=randomUUID().replaceAll('-','')
    const intent:CompetitionJobIntent={schemaVersion:1,jobId,kind,environment:entry.name,revision,preparationId:request.id,
      limits:{wallSeconds:seconds,memoryMb:2048,cpus:1,pids:128,tmpfsMb:1024,targetBytes:kind==='resolve'?Math.min(512*1024*1024,request.maxDownloadBytes+2*1024*1024):1024*1024}}
    const cancel=()=>{void client.cancelCompetitionJob(jobId).catch(()=>undefined)}
    request.signal.addEventListener('abort',cancel,{once:true})
    let finished=false
    try{
      let status=await client.startCompetitionJob(intent)
      const deadline=Date.now()+seconds*1000+60_000
      let collection:CompetitionJobCollection|null=null
      let lastBytes=-1
      while(!['complete','failed','cancelled'].includes(status.phase)){
        if(request.signal.aborted)throw new DependencyPreparationError('cancelled','Package preparation was cancelled.')
        if(Date.now()>deadline)throw new DependencyPreparationError('timeout','Package preparation exceeded its time limit.')
        if(status.phase==='exporting'){collection=await client.collectCompetitionJob(jobId);status=await client.competitionJob(jobId);continue}
        if(kind==='resolve'&&status.progress?.phase==='resolve'&&status.progress.outputBytes!==lastBytes){
          lastBytes=status.progress.outputBytes
          request.onProgress?.({state:'downloading',downloadBytes:lastBytes})
        }
        await pause(500)
        status=await client.competitionJob(jobId)
      }
      if(request.signal.aborted)throw new DependencyPreparationError('cancelled','Package preparation was cancelled.')
      if(status.phase==='failed'&&status.exitCode!==null&&!collection)collection=await client.collectCompetitionJob(jobId)
      if(status.phase!=='complete'||status.exitCode!==0)throw workerError(request.workDir)??new DependencyPreparationError('preparation_failed',status.error??'Isolated package preparation failed.')
      const result=collection??await client.collectCompetitionJob(jobId)
      finished=true
      return result
    }finally{
      request.signal.removeEventListener('abort',cancel)
      try{await client.cancelCompetitionJob(jobId)}
      catch{if(finished)throw new DependencyPreparationError('cleanup_failed','The isolated package job could not be cleaned up.')}
    }
  }
  request.onProgress?.({state:'resolving',log:'Starting isolated package preparation.'})
  const resolveCollection=await run('resolve')
  const resolved=resolvedReport(path.join(request.workDir,'resolved.json'),request.maxDownloadBytes)
  if(!resolveCollection.files.some(file=>file.name==='resolved.json'))throw new DependencyPreparationError('invalid_output','The broker did not export a resolution manifest.')
  const exportedWheels=resolveCollection.files.filter(file=>file.name.startsWith('wheels/'))
  if(exportedWheels.length!==resolved.packages.length||resolved.packages.some(item=>{
    const exported=exportedWheels.find(file=>file.name===`wheels/${item.fileName}`)
    return !exported||exported.bytes!==item.bytes||exported.sha256!==item.sha256
  }))throw new DependencyPreparationError('invalid_output','The broker wheel manifest does not match the resolved packages.')
  writeInput({...job,resolved})
  request.onProgress?.({state:'verifying',downloadBytes:resolved.downloadBytes,log:'Verifying package wheels without network access.'})
  const verifyCollection=await run('verify')
  if(!verifyCollection.files.some(file=>file.name==='verified.json'))throw new DependencyPreparationError('invalid_output','The broker did not export a verification manifest.')
  const verified=verifiedReport(path.join(request.workDir,'verified.json'),request.maxInstalledBytes)
  const listed=fs.readdirSync(wheels)
  if(listed.length!==resolved.packages.length)throw new DependencyPreparationError('invalid_wheel','The wheel bundle contains unexpected files.')
  let bytes=0
  for(const item of resolved.packages as DependencyPackage[]){
    if(!listed.includes(item.fileName))throw new DependencyPreparationError('invalid_wheel','The wheel bundle is incomplete.')
    const file=path.join(wheels,item.fileName),stat=fs.lstatSync(file)
    if(!stat.isFile()||stat.size!==item.bytes)throw new DependencyPreparationError('invalid_wheel','A wheel has an invalid file type or size.')
    bytes+=stat.size
    if(bytes>request.maxDownloadBytes)throw new DependencyPreparationError('download_limit','The wheel downloads exceed the configured size limit.')
    const digest=createHash('sha256')
    for await(const chunk of fs.createReadStream(file))digest.update(chunk)
    const hash=digest.digest('hex')
    if(hash!==item.sha256)throw new DependencyPreparationError('hash_mismatch','A wheel failed its SHA-256 integrity check.')
    fs.chmodSync(file,0o444)
  }
  if(bytes!==resolved.downloadBytes)throw new DependencyPreparationError('invalid_output','The wheel sizes disagree with the manifest.')
  if(request.signal.aborted)throw new DependencyPreparationError('cancelled','Package preparation was cancelled.')
  const contentHash=createHash('sha256').update(JSON.stringify({imageDigest:request.imageDigest,normalizedRequirements:resolved.normalizedRequirements,packages:resolved.packages})).digest('hex')
  request.onProgress?.({state:'verifying',downloadBytes:bytes,installedBytes:verified.installedBytes,log:'Offline package verification passed.'})
  return {...resolved,...verified,contentHash}
}
