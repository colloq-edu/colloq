import './_env.mts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'

test('production broker advertises competition execution unavailable before work is submitted',async()=>{
 const present=existsSync(new URL('../server/src/competitions/capabilities.ts',import.meta.url));assert(present,'runtime capability service must exist');
 const {evaluateCapabilities}=await import('../server/src/competitions/capabilities.js');
 const c=evaluateCapabilities({backend:'broker'});assert.equal(c.execution.available,false);assert.equal(c.preparation.available,false);assert(c.execution.reason);
});
test('old Docker can execute isolated notebooks but cannot prepare packages without isolated gateway support',async()=>{
 const {evaluateCapabilities}=await import('../server/src/competitions/capabilities.js');
 const c=evaluateCapabilities({backend:'docker',dockerVersion:'27.5.1',imageAvailable:true,storageAvailable:true});assert.equal(c.execution.available,true);assert.equal(c.preparation.available,false);
 const next=evaluateCapabilities({backend:'docker',dockerVersion:'28.3.0',imageAvailable:true,storageAvailable:true});assert.equal(next.preparation.available,true);
 assert.equal(evaluateCapabilities({backend:'docker',dockerVersion:null}).execution.available,false);
 assert.equal(evaluateCapabilities({backend:'docker',dockerVersion:'28.3.0',imageAvailable:false}).execution.available,false);
});

test('malformed Docker versions fail package preparation closed', async () => {
 const {evaluateCapabilities}=await import('../server/src/competitions/capabilities.js')
 for(const dockerVersion of ['unknown','v28','28','28.bad.1','999999999999999999999.0.0']) {
  assert.equal(evaluateCapabilities({backend:'docker',dockerVersion}).preparation.available,false,dockerVersion)
 }
})

test('broker readiness requires broker report, catalog binding and writable storage',async()=>{
 const {createCapabilityReader}=await import('../server/src/competitions/capabilities.js')
 const ready={execution:{available:true,code:'available',reason:null},preparation:{available:true,code:'available',reason:null}}
 let image=true
 const read=createCapabilityReader({backend:()=> 'broker',brokerCapabilities:async()=>ready,catalogAvailable:()=>image,storageAvailable:()=>true,
  run:async()=>{throw new Error('broker readiness must not invoke Docker')}})
 assert.equal((await read('base','registry/base@sha256:'+'a'.repeat(64))).execution.available,true)
 image=false
 assert.equal((await read('base','sha256:'+'a'.repeat(64))).execution.code,'image_unavailable')
 const missing=createCapabilityReader({backend:()=> 'broker',brokerCapabilities:async()=>null,catalogAvailable:()=>true,storageAvailable:()=>true})
 assert.equal((await missing('base')).preparation.available,false)
 const split=createCapabilityReader({backend:()=> 'broker',brokerCapabilities:async()=>({...ready,execution:{available:false,code:'notebook_unavailable',reason:'Exporter unavailable'}}),catalogAvailable:()=>true,storageAvailable:()=>true})
 const separate=await split('base')
 assert.equal(separate.execution.available,false)
 assert.equal(separate.preparation.available,true)
})

test('image probes coalesce and expired negative results recover', async () => {
 const module=await import('../server/src/competitions/capabilities.js')
 assert.equal(typeof module.createCapabilityReader,'function')
 let now=0, healthy=false
 const calls:string[][]=[]
 const read=module.createCapabilityReader({backend:()=> 'docker',clock:()=>now,storageAvailable:()=>true,
  run:async(args:string[])=>{calls.push(args);if(args[0]==='version')return '28.3.0';if(!healthy)throw new Error('missing');return 'sha256:'+'a'.repeat(64)} })
 const results=await Promise.all(Array.from({length:12},()=>read('base')))
 assert.ok(results.every((x:any)=>x.execution.code==='image_unavailable'))
 assert.equal(calls.filter(a=>a[0]==='image').length,1)
 healthy=true
 assert.equal((await read('base')).execution.available,false)
 now=5001
 assert.equal((await read('base')).execution.available,true)
 assert.equal(calls.filter(a=>a[0]==='image').length,2)
})

/*
 * A competition whose notebook wants a video card, on an executor that has
 * none for submissions: refused at the door with its own code, never queued
 * for a card nobody gave, never failed "in the metric" by a broker that
 * cannot place it. Preparation needs no card and keeps its own verdict.
 */
test('a GPU competition without a card for submissions: gpu_unavailable on docker, in the owner\'s words', async () => {
 const {evaluateCapabilities}=await import('../server/src/competitions/capabilities.js')
 const docker={backend:'docker' as const,dockerVersion:'28.3.0',imageAvailable:true,storageAvailable:true}
 const none=evaluateCapabilities({...docker,gpu:true,runnerGpus:false})
 assert.equal(none.execution.available,false);assert.equal(none.execution.code,'gpu_unavailable')
 assert.match(none.execution.reason!,/«Ресурсы»/)
 assert.equal(none.preparation.available,true)
 assert.equal(evaluateCapabilities({...docker,gpu:true,runnerGpus:true}).execution.available,true)
 // A competition on the CPU never asks, whatever the machine has.
 assert.equal(evaluateCapabilities({...docker,gpu:false,runnerGpus:false}).execution.available,true)
 assert.equal(evaluateCapabilities(docker).execution.available,true)
 // The more basic trouble is said first.
 assert.equal(evaluateCapabilities({backend:'docker',dockerVersion:null,gpu:true,runnerGpus:false}).execution.code,'docker_unavailable')
 assert.equal(evaluateCapabilities({...docker,imageAvailable:false,gpu:true,runnerGpus:false}).execution.code,'image_unavailable')
 // The test stand-in follows the same rule, so queue tests can give it cards.
 assert.equal(evaluateCapabilities({backend:'test',gpu:true,runnerGpus:false}).execution.code,'gpu_unavailable')
 assert.equal(evaluateCapabilities({backend:'test',gpu:true,runnerGpus:true}).execution.available,true)
})

test('under the broker a GPU competition needs the broker\'s own GPU capability, and a broker that reports none has none', async () => {
 const {evaluateCapabilities}=await import('../server/src/competitions/capabilities.js')
 const ready={available:true,code:'available',reason:null}
 const broker={backend:'broker' as const,imageAvailable:true,storageAvailable:true}
 // An older broker says nothing about cards: read as "none", with the cluster's words.
 const silent=evaluateCapabilities({...broker,brokerCapabilities:{execution:ready,preparation:ready},gpu:true})
 assert.equal(silent.execution.code,'gpu_unavailable')
 // A participant reads this when the upload is refused: no setting to tell them
 // about, which might be set anyway on a broker older than the app; their way is
 // the administrator, as for every other executor trouble.
 const {getLocale,setLocaleResolver}=await import('../shared/i18n.js')
 const before=getLocale()
 try {
  for (const language of ['ru','en'] as const) {
   setLocaleResolver(()=>language)
   const reason=evaluateCapabilities({...broker,brokerCapabilities:{execution:ready,preparation:ready},gpu:true}).execution.reason!
   assert.doesNotMatch(reason,/RUNTIME_|gpu\.competitions|Helm/,language)
   assert.match(reason,language==='ru'?/Обратитесь к администратору/:/Contact the administrator/)
  }
 } finally { setLocaleResolver(()=>before) }
 assert.equal(silent.preparation.available,true)
 const off=evaluateCapabilities({...broker,brokerCapabilities:{execution:ready,preparation:ready,gpu:{available:false,code:'gpu_disabled',reason:'off'}},gpu:true})
 assert.equal(off.execution.code,'gpu_unavailable')
 const on=evaluateCapabilities({...broker,brokerCapabilities:{execution:ready,preparation:ready,gpu:ready},gpu:true})
 assert.equal(on.execution.available,true)
 // The runner cards of this machine mean nothing to the cluster.
 assert.equal(evaluateCapabilities({...broker,brokerCapabilities:{execution:ready,preparation:ready},gpu:true,runnerGpus:true}).execution.code,'gpu_unavailable')
 assert.equal(evaluateCapabilities({...broker,brokerCapabilities:{execution:ready,preparation:ready},gpu:false}).execution.available,true)
})

test('the image probe is shared by a GPU and a CPU competition, the verdict is not, and a card given later is seen at once', async () => {
 const {createCapabilityReader}=await import('../server/src/competitions/capabilities.js')
 const calls:string[][]=[]
 let cards=false
 const read=createCapabilityReader({backend:()=> 'docker',clock:()=>0,storageAvailable:()=>true,runnerGpus:()=>cards,
  run:async(args:string[])=>{calls.push(args);return args[0]==='version'?'28.3.0':'sha256:'+'b'.repeat(64)}})
 assert.equal((await read('base-gpu',undefined,{gpu:true})).execution.code,'gpu_unavailable')
 assert.equal((await read('base-gpu')).execution.available,true)
 assert.equal((await read('base-gpu',undefined,{gpu:false})).execution.available,true)
 assert.equal(calls.filter(a=>a[0]==='image').length,1)
 cards=true
 assert.equal((await read('base-gpu',undefined,{gpu:true})).execution.available,true)
 const broker=createCapabilityReader({backend:()=> 'broker',storageAvailable:()=>true,catalogAvailable:()=>true,
  brokerCapabilities:async()=>({execution:{available:true,code:'available',reason:null},preparation:{available:true,code:'available',reason:null}})})
 assert.equal((await broker('base-gpu',undefined,{gpu:true})).execution.code,'gpu_unavailable')
 assert.equal((await broker('base-gpu')).execution.available,true)
})
