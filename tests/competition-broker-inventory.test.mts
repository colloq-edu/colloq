import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { TEST_ROOT } from './_env.mts'
import { captureRevision, ensureCompetitionRevision } from '../server/src/dependencies/revisions.js'
import { createCompetition } from '../server/src/competitions/store.js'
import { putRevision, selectRevision, competitionRevision } from '../server/src/dependencies/store.js'

test('broker inventory stores full pinned catalog image and installed package list',async()=>{
  const image=`registry.test/colloq/base@sha256:${'b'.repeat(64)}`
  const catalog=path.join(TEST_ROOT,'catalog-inventory.json')
  fs.writeFileSync(catalog,JSON.stringify({schemaVersion:1,release:'r',defaultEnvironment:'base',environments:[{name:'base',image,gpu:false,current:true}]}))
  const old={COMPETITION_BACKEND:process.env.COMPETITION_BACKEND,KERNEL_BACKEND:process.env.KERNEL_BACKEND,KERNEL_ISOLATION:process.env.KERNEL_ISOLATION,KERNEL_RUNTIME_URL:process.env.KERNEL_RUNTIME_URL,KERNEL_RUNTIME_TOKEN:process.env.KERNEL_RUNTIME_TOKEN,KERNEL_CATALOG_FILE:process.env.KERNEL_CATALOG_FILE}
  let collected=false,started=false
  const server=http.createServer((req,res)=>{
    const id=req.url?.split('/')[3]??''
    res.setHeader('content-type','application/json')
    if(req.method==='POST'&&req.url?.endsWith('/collect')){
      collected=true
      const target=path.join(TEST_ROOT,'data','dependencies','inventory',id)
      fs.writeFileSync(path.join(target,'inventory.json'),JSON.stringify({python:'3.12.1',abi:'cpython-312-x86_64-linux-gnu',platform:'linux/x86_64',packages:[{name:'pip',version:'25.0'},{name:'numpy',version:'2.0'}]}))
      res.end(JSON.stringify({files:[],totalBytes:0}));return
    }
    if(req.method==='POST')started=true
    if(req.method==='DELETE'){res.end(JSON.stringify({ok:true}));return}
    res.end(JSON.stringify({jobId:id,kind:'inventory',phase:collected?'complete':started?'exporting':'queued',startedAt:1,finishedAt:collected?2:null,exitCode:0,oomKilled:false,progress:null,error:null}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=(server.address() as {port:number}).port
  Object.assign(process.env,{COMPETITION_BACKEND:'broker',KERNEL_BACKEND:'broker',KERNEL_ISOLATION:'on',KERNEL_RUNTIME_URL:`http://127.0.0.1:${port}`,KERNEL_RUNTIME_TOKEN:'a'.repeat(64),KERNEL_CATALOG_FILE:catalog})
  try{
    const revision=await captureRevision('base')
    assert.equal(revision.imageDigest,image)
    assert.equal(revision.pythonVersion,'3.12.1')
    assert.deepEqual(revision.packages.map(p=>p.name),['numpy','pip'])
    assert(collected)
  }finally{
    for(const [key,value] of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value}
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

test('broker selects current catalog revision when competition retained a local Docker digest',async()=>{
  const image=`registry.test/colloq/base@sha256:${'c'.repeat(64)}`
  const catalog=path.join(TEST_ROOT,'catalog-refresh.json')
  fs.writeFileSync(catalog,JSON.stringify({schemaVersion:1,release:'r',defaultEnvironment:'base',environments:[{name:'base',image,gpu:false,current:true}]}))
  const oldBackend=process.env.COMPETITION_BACKEND,oldCatalog=process.env.KERNEL_CATALOG_FILE
  process.env.COMPETITION_BACKEND='broker';process.env.KERNEL_CATALOG_FILE=catalog
  try {
    const competition=createCompetition({slug:'refresh-'+Math.random().toString(36).slice(2),title:'Refresh'})!
    const base={environmentName:'base',pythonVersion:'3.12.1',pythonAbi:'cp312',platform:'linux/x86_64',packages:[{name:'pip',version:'25'}],baseConstraintsHash:'x'}
    const local=putRevision({...base,imageDigest:`sha256:${'d'.repeat(64)}`})
    const current=putRevision({...base,imageDigest:image})
    selectRevision(competition.id,local.id)
    assert.equal((await ensureCompetitionRevision(competition)).id,current.id)
    assert.equal(competitionRevision(competition.id)?.id,current.id)
  } finally {
    if(oldBackend===undefined)delete process.env.COMPETITION_BACKEND;else process.env.COMPETITION_BACKEND=oldBackend
    if(oldCatalog===undefined)delete process.env.KERNEL_CATALOG_FILE;else process.env.KERNEL_CATALOG_FILE=oldCatalog
  }
})
