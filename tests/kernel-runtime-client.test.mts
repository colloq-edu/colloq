import './_env.mts'
import { beforeEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
// Existing diagnostic expectations intentionally exercise English; bilingual behavior has its own tests.
beforeEach(() => setLocaleResolver(() => 'en'))
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { TEST_ROOT } from './_env.mts'
import { RuntimeClient, selectKernelBackend, requireKernelIsolation } from '../server/src/kernel/runtime-client.js'

const revision = `sha256:${'a'.repeat(64)}`
const endpoint = {url:'http://colloq-kernel-demo.colloq.svc:8888',token:'r'.repeat(64),instanceId:'pod-one',environment:'base',revision}
async function fixture(handler: http.RequestListener) {
  const server=http.createServer(handler)
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address() as {port:number}
  return {url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))}
}

test('production requires the broker and cannot select development/test execution',()=>{
  assert.equal(selectKernelBackend({NODE_ENV:'production'}),'broker')
  assert.throws(()=>selectKernelBackend({NODE_ENV:'production',KERNEL_BACKEND:'docker'}),/production/i)
  assert.throws(()=>selectKernelBackend({NODE_ENV:'production',KERNEL_BACKEND:'test'}),/test/i)
  assert.throws(()=>selectKernelBackend({KERNEL_BACKEND:'mystery'}),/backend/i)
  assert.equal(selectKernelBackend({NODE_ENV:'test',KERNEL_BACKEND:'test'}),'test')
  assert.throws(()=>requireKernelIsolation({NODE_ENV:'production',KERNEL_ISOLATION:'off'}),/isolation/i)
  assert.throws(()=>requireKernelIsolation({NODE_ENV:'development',KERNEL_BACKEND:'docker',KERNEL_ISOLATION:'off'}),/isolation/i)
})

test('the client sends only room intent and reads a rotated credential for every request',async()=>{
  const seen:Array<{url?:string;auth?:string;body:string}>=[]
  const remote=await fixture(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    seen.push({url:req.url,auth:req.headers.authorization,body})
    res.setHeader('content-type','application/json');res.end(JSON.stringify(endpoint))
  })
  const tokenFile=path.join(TEST_ROOT,'runtime-token');fs.writeFileSync(tokenFile,'a'.repeat(64))
  try{
    const client=new RuntimeClient({url:remote.url,tokenFile})
    assert.deepEqual(await client.ensure('seminar_1','base',revision),endpoint)
    fs.writeFileSync(tokenFile,'b'.repeat(64))
    await client.ensure('seminar_1','base',revision)
    assert.equal(seen[0].url,'/v1/rooms/seminar_1')
    assert.deepEqual(JSON.parse(seen[0].body),{environment:'base',revision})
    assert.equal(seen[0].auth,`Bearer ${'a'.repeat(64)}`)
    assert.equal(seen[1].auth,`Bearer ${'b'.repeat(64)}`)
    await assert.rejects(()=>client.ensure('../other','base'),/session/i)
    assert.equal(seen.length,2,'invalid room must not cause a network request')
  }finally{await remote.close()}
})

test('missing incarnation or a substituted revision is rejected before Jupyter is used',async()=>{
  let value:unknown={...endpoint,instanceId:''}
  const remote=await fixture((_req,res)=>res.end(JSON.stringify(value)))
  try{
    const client=new RuntimeClient({url:remote.url,token:'a'.repeat(64)})
    await assert.rejects(()=>client.ensure('r1','base',revision),/endpoint|instance/i)
    value={...endpoint,revision:`sha256:${'b'.repeat(64)}`}
    await assert.rejects(()=>client.ensure('r1','base',revision),/revision/i)
  }finally{await remote.close()}
})

test('runtime failure makes readiness fail and never produces a shared endpoint',async()=>{
  const remote=await fixture((_req,res)=>{res.statusCode=503;res.end(JSON.stringify({error:'Scheduler unavailable'}))})
  try{
    const client=new RuntimeClient({url:remote.url,token:'a'.repeat(64)})
    assert.deepEqual(await client.health(),{ok:false,reason:'Scheduler unavailable'})
    await assert.rejects(()=>client.ensure('r1','base',revision),/Scheduler unavailable/)
  }finally{await remote.close()}
})

test('redirects are not followed and public cleartext runtime URLs are refused',async()=>{
  let stolen=0
  const receiver=await fixture((_req,res)=>{stolen++;res.end('{}')})
  const redirect=await fixture((_req,res)=>{res.statusCode=307;res.setHeader('location',receiver.url);res.end()})
  try{
    const client=new RuntimeClient({url:redirect.url,token:'a'.repeat(64)})
    await assert.rejects(()=>client.ensure('r1','base'),/runtime|redirect|fetch/i)
    assert.equal(stolen,0)
    assert.throws(()=>new RuntimeClient({url:'http://example.com',token:'a'.repeat(64)}),/HTTPS|cleartext/i)
    assert.throws(()=>new RuntimeClient({url:'http://u:p@localhost:8787',token:'a'.repeat(64)}),/URL/i)
  }finally{await redirect.close();await receiver.close()}
})


test('permanent retirement is explicit; idle stop remains reopenable', async()=>{
  const seen:string[]=[]
  const remote=await fixture((req,res)=>{seen.push(req.url??'');res.end(JSON.stringify({ok:true}))})
  try{
    const client=new RuntimeClient({url:remote.url,token:'a'.repeat(64)})
    await client.stop('one')
    await client.stop('one',true)
    assert.deepEqual(seen,['/v1/rooms/one','/v1/rooms/one?retire=true'])
  }finally{await remote.close()}
})
