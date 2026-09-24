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
import {createSession,sessionEnvironment,sessionKernelRevision,setSessionCpus} from '../server/src/db.js'
import {endpointForSession,isolationAvailable,dropRoomKernel} from '../server/src/kernel/pool.js'
import {listEnvironments,environmentAbilities,setActiveName,activeName,writeSource,removeEnvironment,startBuild} from '../server/src/environments.js'
import {endpointIdentity} from '../server/src/kernel/jupyter.js'
import {forgetResources,machineResources} from '../server/src/kernel/resources.js'

const image=(c:string)=>`registry.example/colloq/kernel@sha256:${c.repeat(64)}`
const rev=(c:string)=>`sha256:${c.repeat(64)}`

test('room image pins survive catalog/default updates and missing revisions fail closed',async()=>{
 const old={...process.env};const file=path.join(TEST_ROOT,'catalog.json'),tokenFile=path.join(TEST_ROOT,'broker-token')
 const requests:any[]=[]
 const runtime=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const input=body?JSON.parse(body):{};requests.push({path:req.url,...input});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/v1/health'?{ok:true,reason:null,defaultCpus:1.5}:req.url==='/v1/rooms'?{rooms:[{sessionId:'pin-old',instanceId:'pod-1',phase:'ready',environment:'base',revision:rev('a'),cpus:4}]}:{url:'http://room.colloq.svc:8888',token:'r'.repeat(64),instanceId:'pod-1',environment:input.environment,revision:input.revision}))})
 await new Promise<void>(r=>runtime.listen(0,'127.0.0.1',r));const port=(runtime.address() as {port:number}).port
 let entries:any[]=[{name:'base',image:image('a'),gpu:false},{name:'cv',image:image('c'),gpu:false}]
 const write=()=>fs.writeFileSync(file,JSON.stringify({schemaVersion:1,release:'v0.2.0',defaultEnvironment:'base',environments:entries}))
 write();fs.writeFileSync(tokenFile,'t'.repeat(64));
 createSession('legacy-default','Legacy')
 assert.equal(sessionEnvironment('legacy-default'),null)
 Object.assign(process.env,{KERNEL_BACKEND:'broker',KERNEL_ISOLATION:'required',KERNEL_CATALOG_FILE:file,KERNEL_RUNTIME_URL:`http://127.0.0.1:${port}`,KERNEL_RUNTIME_TOKEN_FILE:tokenFile,PATH:'/no-docker-here'})
 try {
  await endpointForSession('legacy-default',null)
  /*
   * On the broker a personal notebook has no kernel of its own — and a refusal
   * is more honest than a substitute.
   *
   * The broker starts one pod per class; a second one, without a GPU, would
   * mean changing its protocol, its controller and its permissions in the
   * cluster. Running the personal notebook in the lecture kernel instead of
   * refusing is not allowed: that is exactly the trouble the second container
   * exists to prevent — the class's GPU in a student's hands and an OOM killer
   * that picks the teacher's kernel.
   */
  await assert.rejects(endpointForSession('legacy-default',null,'own'),/personal notebooks|личные тетради/)
  assert.equal(sessionEnvironment('legacy-default'),'base')
  assert.equal(sessionKernelRevision('legacy-default'),rev('a'))
  createSession('pin-old','Old','base');assert.equal(sessionKernelRevision('pin-old'),rev('a'))
  entries=[{name:'base',image:image('a'),gpu:false,current:false},{name:'base',image:image('b'),gpu:false,current:true},{name:'cv',image:image('c'),gpu:false}];write()
  createSession('pin-new','New','base');assert.equal(sessionKernelRevision('pin-new'),rev('b'))
  assert.equal((await endpointForSession('pin-old','base')).instanceId,'pod-1')
  assert.equal(requests.at(-1).revision,rev('a'))
  setSessionCpus('pin-old', 6)
  await endpointForSession('pin-old','base')
  assert.equal(requests.at(-1).cpus, 6, 'persisted room cores must reach the broker')
  forgetResources()
  const resources = await machineResources()
  assert.equal(resources.kernel.defaultCpus, 1.5, 'defaults come from the broker rather than the app environment')
  assert.equal(resources.rooms.find(room => room.id === 'pin-old')?.cpus, 4, 'show the running quota while a new quota awaits restart')
  setSessionCpus('pin-old', null)
  await endpointForSession('pin-old','base')
  assert.equal('cpus' in requests.at(-1), false, 'reset must use the broker default')
  assert.equal((await environmentAbilities()).canBuild,false)
  assert.equal((await environmentAbilities()).canSetDefault,true)
  assert.equal((await listEnvironments()).find(e=>e.name==='base')?.image,image('b'))
  assert.equal(await isolationAvailable(),true)
  setActiveName('cv');assert.equal(activeName(),'cv');createSession('pin-default','Default')
  assert.equal(sessionEnvironment('pin-default'),'cv');assert.equal(sessionKernelRevision('pin-default'),rev('c'))
  await endpointForSession('legacy-default',null)
  assert.equal(requests.at(-1).environment,'base','legacy environment is pinned along with its digest')
  assert.equal(requests.at(-1).revision,rev('a'))
  await endpointForSession('pin-old','cv')
  assert.equal(requests.at(-1).environment,'base','caller cannot change persisted room choice')
  assert.throws(()=>writeSource('base','evil'),/catalog|outside|published/i)
  assert.throws(()=>removeEnvironment('base'),/catalog|outside|published/i)
  await assert.rejects(()=>startBuild('base'),/catalog|outside|published/i)
  entries=entries.filter(e=>e.image!==image('a'));write();const count=requests.length
  await assert.rejects(()=>endpointForSession('pin-old','base'),/revision|catalog|published/i)
  assert.equal(requests.length,count,'no substitute image is requested')
 }finally{
  for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key]
  Object.assign(process.env,old)
  await new Promise<void>(r=>runtime.close(()=>r()))
 }
})

test('an endpoint incarnation distinguishes replacement pods behind stable Service DNS',()=>{
 const endpoint={url:'http://one.colloq.svc:8888',token:'secret',instanceId:'pod-a'}
 assert.notEqual(endpointIdentity(endpoint),endpointIdentity({...endpoint,instanceId:'pod-b'}))
 assert.equal(endpointIdentity({...endpoint,token:'rotated'}),endpointIdentity(endpoint))
 assert.equal(endpointIdentity({url:endpoint.url,token:'legacy'}),endpoint.url,'retain legacy Docker PTY fingerprint compatibility')
})

test('stop drains a pending ensure and prevents concurrent or late kernel attachment',async()=>{
 const old={...process.env};const file=path.join(TEST_ROOT,'retire-catalog.json'),tokenFile=path.join(TEST_ROOT,'retire-token')
 let started!:()=>void,finish!:()=>void
 const accepted=new Promise<void>(r=>started=r),pending=new Promise<void>(r=>finish=r)
 const methods:string[]=[]
 const server=http.createServer(async(req,res)=>{
  methods.push(req.method??'');let raw='';for await(const chunk of req)raw+=chunk
  res.setHeader('content-type','application/json')
  if(req.method==='POST'){started();await pending;const input=JSON.parse(raw);res.end(JSON.stringify({url:'http://room.colloq.svc:8888',token:'r'.repeat(64),instanceId:'pod-late',...input}))}
  else res.end(JSON.stringify({ok:true}))
 })
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 fs.writeFileSync(file,JSON.stringify({schemaVersion:1,release:'v0.2.0',defaultEnvironment:'base',environments:[{name:'base',image:image('a'),gpu:false}]}));fs.writeFileSync(tokenFile,'t'.repeat(64))
 Object.assign(process.env,{KERNEL_BACKEND:'broker',KERNEL_ISOLATION:'required',KERNEL_CATALOG_FILE:file,KERNEL_RUNTIME_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}`,KERNEL_RUNTIME_TOKEN_FILE:tokenFile})
 try{
  createSession('retire-pending','Pending','base')
  const starting=assert.rejects(endpointForSession('retire-pending','base'),/stopping/)
  await accepted
  const stopping=dropRoomKernel('retire-pending')
  await assert.rejects(endpointForSession('retire-pending','base'),/stopping/)
  assert.deepEqual(methods,['POST'],'DELETE must wait for accepted ensure')
  finish();await Promise.all([starting,stopping])
  assert.deepEqual(methods,['POST','DELETE'])
  await endpointForSession('retire-pending','base')
  assert.deepEqual(methods,['POST','DELETE','POST'],'idle retirement allows a later intentional restart')
 }finally{finish();for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);await new Promise<void>(r=>server.close(()=>r()))}
})
