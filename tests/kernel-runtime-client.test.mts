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
  /*
   * Тестовый сервер БЕЗ явного выбора не берёт docker: уборщик простоя ходит
   * по меткам контейнеров через `docker ps -a` и видит комнаты чужого живого
   * сервера на той же машине. 20.09.2026 так поднятый стенд оказался рядом с
   * идущим занятием — цена ошибки — сброшенные переменные у всего класса.
   */
  assert.equal(selectKernelBackend({NODE_ENV:'test'}),'test')
  // А разработка по-прежнему берёт docker, и явный выбор под NODE_ENV=test уважается.
  assert.equal(selectKernelBackend({NODE_ENV:'development'}),'docker')
  assert.equal(selectKernelBackend({NODE_ENV:'test',KERNEL_BACKEND:'docker'}),'docker')
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

test('room memory rides the ensure intent and a live resize is a PATCH of memory alone', async()=>{
  // 18.09: форма обещала память, а брокеру она не доезжала вовсе.
  const seen:Array<{method?:string;url?:string;body:string}>=[]
  let reply:unknown=endpoint
  const remote=await fixture(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    seen.push({method:req.method,url:req.url,body})
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply))
  })
  try{
    const client=new RuntimeClient({url:remote.url,token:'a'.repeat(64)})
    await client.ensure('seminar_1','base',revision,null,6144)
    assert.deepEqual(JSON.parse(seen[0].body),{environment:'base',revision,memoryMb:6144})
    await client.ensure('seminar_1','base',revision,4,null)
    assert.deepEqual(JSON.parse(seen[1].body),{environment:'base',revision,cpus:4},'no number means the broker default')
    reply={outcome:'applied',memoryMb:8192}
    assert.deepEqual(await client.resize('seminar_1',{memoryMb:8192}),{outcome:'applied',memoryMb:8192})
    assert.equal(seen[2].method,'PATCH'); assert.equal(seen[2].url,'/v1/rooms/seminar_1')
    assert.deepEqual(JSON.parse(seen[2].body),{memoryMb:8192})
    reply={outcome:'absent'}
    assert.deepEqual(await client.resize('seminar_1',{memoryMb:null}),{outcome:'absent'})
    assert.deepEqual(JSON.parse(seen[3].body),{memoryMb:null})
    for (const bad of [{outcome:'maybe'},{outcome:'applied',memoryMb:1.5},{outcome:'applied',memoryMb:'8Gi'}]) {
      reply=bad
      await assert.rejects(()=>client.resize('seminar_1',{memoryMb:8192}),/runtime response/i)
    }
    await assert.rejects(()=>client.resize('seminar_1',{memoryMb:1.5}),/memory/i)
    assert.equal(seen.length,7,'an invalid number must not reach the broker')
  }finally{await remote.close()}
})

test('a live CPU change is a PATCH of cores alone, and the broker answer is checked', async()=>{
  // До 18.09 ядра на k3s в живую комнату не ехали вовсе: пул отвечал pending,
  // а Pod сносился на следующем подъёме вместе с переменными семинара.
  const seen:Array<{method?:string;url?:string;body:string}>=[]
  let reply:unknown={outcome:'applied',cpus:6}
  const remote=await fixture(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    seen.push({method:req.method,url:req.url,body})
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply))
  })
  try{
    const client=new RuntimeClient({url:remote.url,token:'a'.repeat(64)})
    assert.deepEqual(await client.resize('seminar_1',{cpus:6}),{outcome:'applied',cpus:6})
    assert.equal(seen[0].method,'PATCH'); assert.equal(seen[0].url,'/v1/rooms/seminar_1')
    assert.deepEqual(JSON.parse(seen[0].body),{cpus:6},'memory that was not asked for is not sent')
    // Умолчание брокера может быть дробным (RUNTIME_KERNEL_CPU=1500m).
    reply={outcome:'applied',cpus:1.5}
    assert.deepEqual(await client.resize('seminar_1',{cpus:null}),{outcome:'applied',cpus:1.5})
    assert.deepEqual(JSON.parse(seen[1].body),{cpus:null})
    for (const bad of [{outcome:'applied',cpus:'6'},{outcome:'applied',cpus:0},{outcome:'pending',cpus:65}]) {
      reply=bad
      await assert.rejects(()=>client.resize('seminar_1',{cpus:6}),/runtime response/i)
    }
    for (const change of [{cpus:1.5},{cpus:0},{cpus:65},{}])
      await assert.rejects(()=>client.resize('seminar_1',change),/CPU|cpus|requires/i)
    assert.equal(seen.length,5,'an invalid number must not reach the broker')
  }finally{await remote.close()}
})

test('broker health carries its memory default and ceiling, and garbage there is not believed', async()=>{
  let reply:unknown={ok:true,reason:null,defaultCpus:2,defaultMemoryMb:2048,maxMemoryMb:71680}
  const remote=await fixture((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(reply))})
  try{
    const client=new RuntimeClient({url:remote.url,token:'a'.repeat(64)})
    assert.deepEqual(await client.health(),{ok:true,reason:null,defaultCpus:2,defaultMemoryMb:2048,maxMemoryMb:71680})
    reply={ok:true,reason:null,defaultMemoryMb:-1}
    assert.equal((await client.health()).ok,false)
    reply={rooms:[{sessionId:'r1',instanceId:'u',phase:'ready',environment:'base',revision,memoryMb:4096}]}
    assert.equal((await client.rooms())[0].memoryMb,4096)
    reply={rooms:[{sessionId:'r1',instanceId:'u',phase:'ready',environment:'base',revision,memoryMb:'4Gi'}]}
    await assert.rejects(()=>client.rooms(),/room list/i)
  }finally{await remote.close()}
})

test('an unschedulable room reaches the app as a word and numbers, and the room reads a short note instead of the broker text', async()=>{
  let reply:unknown={error:'Room Pod cannot be scheduled: node lacks allocatable memory',unschedulable:'memory',memoryMb:6144,cpus:2}
  const remote=await fixture((_req,res)=>{res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify(reply))})
  try{
    const client=new RuntimeClient({url:remote.url,token:'a'.repeat(64)})
    await assert.rejects(()=>client.ensure('r1','base',revision),(err:any)=>{
      assert.equal(err.status,503)
      assert.deepEqual(err.failure,{unschedulable:'memory',memoryMb:6144,cpus:2})
      // Это текст для всей комнаты: без устройства сервера и без слов брокера.
      assert.match(err.message,/teacher can see why/)
      assert.doesNotMatch(err.message,/allocatable|Pod|memory/i)
      return true
    })
    // Не то слово или не те числа — не отказ планировщика, а обычная ошибка брокера.
    reply={error:'Room startup timed out: Pending',unschedulable:'disk',memoryMb:6144}
    await assert.rejects(()=>client.ensure('r1','base',revision),(err:any)=>
      err.failure===undefined && /timed out/.test(err.message))
    reply={error:'x',unschedulable:'memory',memoryMb:'6Gi',cpus:-1}
    await assert.rejects(()=>client.ensure('r1','base',revision),(err:any)=>
      JSON.stringify(err.failure)===JSON.stringify({unschedulable:'memory'}))
  }finally{await remote.close()}
})
