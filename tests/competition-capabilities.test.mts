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
