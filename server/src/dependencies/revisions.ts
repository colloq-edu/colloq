import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { ENVIRONMENT_NAME } from '@shared/admin'
import type { Competition } from '@shared/competitions'
import type { EnvironmentRevision, InstalledPackage } from '@shared/dependencies'
import { getCompetition } from '../competitions/store.js'
import { competitionRevision, getBinding, putRevision, selectRevision, bindSubmission, revisions } from './store.js'
import { db } from '../db.js'
const execute=promisify(execFile)
const snapshots=new Map<string,Promise<EnvironmentRevision>>()
const PROBE=`import json,platform,sysconfig,importlib.metadata as m
print(json.dumps({'python':platform.python_version(),'abi':sysconfig.get_config_var('SOABI'),'packages':[{'name':d.metadata['Name'],'version':d.version} for d in m.distributions()]}))`
async function docker(args:string[],timeout=20000):Promise<string>{return (await execute('docker',args,{timeout,maxBuffer:2*1024*1024})).stdout.trim()}
export async function captureRevision(environmentName:string):Promise<EnvironmentRevision>{
  if(!ENVIRONMENT_NAME.test(environmentName))throw new Error('Invalid environment name')
  const info=JSON.parse(await docker(['image','inspect',`colloq-kernel:${environmentName}`]))[0] as {Id:string;Os:string;Architecture:string}
  if(!/^sha256:[a-f0-9]{64}$/.test(info.Id))throw new Error('Environment image is not available')
  const key=environmentName+info.Id
  const inFlight=snapshots.get(key);if(inFlight)return inFlight
  const existing=revisions().find(r=>r.environmentName===environmentName&&r.imageDigest===info.Id)
  if(existing){
    await docker(['tag',info.Id,`colloq-revision:${existing.id}`])
    return existing
  }
  const pending=(async()=>{
    const name='colloq-revision-probe-'+createHash('sha256').update(key).digest('hex').slice(0,20)
    let raw:string
    try {raw=await docker(['run','--rm','--pull=never','--name',name,'--network=none','--read-only','--user=1000:1000','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=256m','--cpus=0.5','--entrypoint','python',info.Id,'-c',PROBE])}
    finally{await docker(['rm','-f',name],5000).catch(()=>undefined)}
    const data=JSON.parse(raw) as {python:string;abi:string;packages:InstalledPackage[]}
    if(!/^\d+\.\d+\.\d+/.test(data.python)||typeof data.abi!=='string'||!Array.isArray(data.packages)||!data.packages.length)throw new Error('Invalid base inventory')
    const packages=data.packages.map(p=>{
      if(!p||typeof p.name!=='string'||typeof p.version!=='string'||!/^\w[\w.-]*$/.test(p.name)||!/^\w[\w.+!-]*$/.test(p.version))throw new Error('Invalid base package')
      return {name:p.name,version:p.version}
    }).sort((a,b)=>a.name.toLowerCase().localeCompare(b.name.toLowerCase(),'en'))
    const result=putRevision({environmentName,imageDigest:info.Id,pythonVersion:data.python,pythonAbi:data.abi,platform:`${info.Os}/${info.Architecture}`,packages,baseConstraintsHash:createHash('sha256').update(JSON.stringify(packages)).digest('hex')})
    // Preserve a reference independently of the mutable environment alias.
    await docker(['tag',info.Id,`colloq-revision:${result.id}`])
    return result
  })()
  snapshots.set(key,pending)
  try{return await pending}finally{snapshots.delete(key)}
}
export async function ensureCompetitionRevision(c:Competition,refresh=false):Promise<EnvironmentRevision>{
  const old=competitionRevision(c.id)
  if(old&&old.environmentName===c.environment&&!refresh)return old
  const captured=await captureRevision(c.environment)
  const fresh=getCompetition(c.id)
  if(!fresh||fresh.environment!==c.environment)throw new Error('Competition environment changed during inspection')
  const raced=competitionRevision(c.id)
  if(!refresh&&raced&&raced.environmentName===c.environment)return raced
  selectRevision(c.id,captured.id)
  return captured
}
/** Existing history cannot prove its original tag value: mark observations as legacy. */
export async function pinLegacySubmissions():Promise<void>{
 const rows=db.prepare(`SELECT s.id,c.environment FROM submissions s JOIN competitions c ON c.id=s.competition_id
 LEFT JOIN submission_environments b ON b.submission_id=s.id WHERE b.submission_id IS NULL`).all() as {id:string;environment:string}[]
 const found=new Map<string,EnvironmentRevision|null>()
 for(const row of rows){
  if(!found.has(row.environment))found.set(row.environment,await captureRevision(row.environment).catch(()=>null))
  if(!getBinding(row.id))bindSubmission(row.id,found.get(row.environment)?.id??null,null,true)
 }
}
