import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { TEST_ROOT } from './_env.mts'
import { prepareBrokerDependencies } from '../server/src/dependencies/broker-preparation.js'

test('broker resolve and offline verify publish only staged, hashed wheel metadata',async()=>{
  const catalogFile=path.join(TEST_ROOT,'runtime-catalog.json')
  fs.writeFileSync(catalogFile,JSON.stringify({schemaVersion:1,release:'test',defaultEnvironment:'base',environments:[{name:'base',image:`registry/base@sha256:${'b'.repeat(64)}`,gpu:false,current:true}]}))
  process.env.KERNEL_CATALOG_FILE=catalogFile
  const workDir=path.join(TEST_ROOT,'data','dependencies','staging','a'.repeat(32))
  const wheel='example-1.0-py3-none-any.whl', body=Buffer.from('fixture wheel')
  const sha256=createHash('sha256').update(body).digest('hex')
  const kinds:string[]=[]
  const client={
    async startCompetitionJob(intent:any){kinds.push(intent.kind);return {jobId:intent.jobId,kind:intent.kind,phase:'complete',startedAt:1,finishedAt:2,exitCode:0,oomKilled:false,progress:null,error:null}},
    async competitionJob(){throw new Error('already complete')},
    async collectCompetitionJob(){
      if(kinds.at(-1)==='resolve'){
        fs.mkdirSync(path.join(workDir,'wheels'),{recursive:true})
        fs.writeFileSync(path.join(workDir,'wheels',wheel),body)
        fs.writeFileSync(path.join(workDir,'resolved.json'),JSON.stringify({normalizedRequirements:['example==1.0'],packages:[{name:'example',version:'1.0',fileName:wheel,sha256,bytes:body.length}],downloadBytes:body.length}))
        const manifest=fs.readFileSync(path.join(workDir,'resolved.json'))
        return {files:[{name:'resolved.json',bytes:manifest.length,sha256:createHash('sha256').update(manifest).digest('hex')},{name:`wheels/${wheel}`,bytes:body.length,sha256}],totalBytes:manifest.length+body.length}
      }
      fs.writeFileSync(path.join(workDir,'verified.json'),JSON.stringify({installedBytes:123,lock:`example==1.0 --hash=sha256:${sha256}\n`}))
      const manifest=fs.readFileSync(path.join(workDir,'verified.json'))
      return {files:[{name:'verified.json',bytes:manifest.length,sha256:createHash('sha256').update(manifest).digest('hex')}],totalBytes:manifest.length}
    },
    async cancelCompetitionJob(){},
  }
  const result=await prepareBrokerDependencies({id:'a'.repeat(32),imageDigest:`registry/base@sha256:${'b'.repeat(64)}`,requirementsText:'example==1.0',basePackages:[],workDir,maxDownloadBytes:1024,maxInstalledBytes:1024,signal:new AbortController().signal},client as any)
  assert.deepEqual(kinds,['resolve','verify'])
  assert.equal(result.downloadBytes,body.length)
  assert.equal(result.installedBytes,123)
  assert.equal(result.packages[0].sha256,sha256)
  assert.match(result.contentHash,/^[a-f0-9]{64}$/)
})

test('failed resolver exports structured requirement error before cleanup',async()=>{
  const workDir=path.join(TEST_ROOT,'data','dependencies','staging','e'.repeat(32))
  const catalogFile=path.join(TEST_ROOT,'runtime-catalog-failure.json')
  fs.writeFileSync(catalogFile,JSON.stringify({schemaVersion:1,release:'test',defaultEnvironment:'base',environments:[{name:'base',image:`registry/base@sha256:${'b'.repeat(64)}`,gpu:false,current:true}]}))
  process.env.KERNEL_CATALOG_FILE=catalogFile
  let cancelled=0,collected=0
  const client={
    async startCompetitionJob(intent:any){return {jobId:intent.jobId,kind:'resolve',phase:'failed',startedAt:1,finishedAt:2,exitCode:2,oomKilled:false,progress:null,error:null}},
    async competitionJob(){throw new Error('terminal already')},
    async collectCompetitionJob(){collected++;fs.writeFileSync(path.join(workDir,'progress.ndjson'),JSON.stringify({error:{code:'package_not_found',message:'No wheel found.',line:2}})+'\n');return {files:[{name:'progress.ndjson',bytes:1,sha256:'a'.repeat(64)}],totalBytes:1}},
    async cancelCompetitionJob(){cancelled++},
  }
  await assert.rejects(()=>prepareBrokerDependencies({id:'e'.repeat(32),imageDigest:`registry/base@sha256:${'b'.repeat(64)}`,requirementsText:'example==1.0',basePackages:[],workDir,maxDownloadBytes:1024,maxInstalledBytes:1024,signal:new AbortController().signal},client as any),{code:'package_not_found',line:2})
  assert.equal(collected,1)
  assert.equal(cancelled,1)
})
