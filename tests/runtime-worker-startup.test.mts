import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import type { CompetitionCapabilities } from '../shared/capabilities.js'
const capability=(available:boolean):CompetitionCapabilities=>({execution:{available,code:available?'available':'docker_unavailable',reason:null},preparation:{available,code:available?'available':'docker_unavailable',reason:null}})

test('startup automatically retries temporary runtime outages and starts each worker once', async t => {
 assert.ok(existsSync(new URL('../server/src/competitions/worker-startup.ts',import.meta.url)), 'startup recovery scheduler must exist')
 const {createWorkerStartup}=await import('../server/src/competitions/worker-startup.js')
 t.mock.timers.enable({apis:['setInterval']})
 let available=false, execution=0, preparation=0
 const startup=createWorkerStartup({capabilities:async()=>capability(available),startExecution:async()=>{execution++},startPreparation:async()=>{preparation++;return true},onError:()=>{}})
 try {
  await startup.start();assert.equal(execution,0);assert.equal(preparation,0)
  available=true;t.mock.timers.tick(5000);await startup.wake()
  assert.equal(execution,1);assert.equal(preparation,1)
  t.mock.timers.tick(15000);await startup.wake()
  assert.equal(execution,1);assert.equal(preparation,1)
 } finally {await startup.stop();t.mock.timers.reset()}
})

test('concurrent startup wakes coalesce and a failed worker does not block the other', async t => {
 assert.ok(existsSync(new URL('../server/src/competitions/worker-startup.ts',import.meta.url)), 'startup recovery scheduler must exist')
 const {createWorkerStartup}=await import('../server/src/competitions/worker-startup.js')
 t.mock.timers.enable({apis:['setInterval']})
 let execution=0,preparation=0,fail=true
 const startup=createWorkerStartup({capabilities:async()=>capability(true),startExecution:async()=>{execution++;if(fail)throw new Error('temporary')},startPreparation:async()=>{preparation++;return true},onError:()=>{}})
 try {
  await Promise.all([startup.start(),startup.start(),startup.wake()])
  assert.equal(execution,1);assert.equal(preparation,1)
  fail=false;t.mock.timers.tick(5000);await startup.wake()
  assert.equal(execution,2);assert.equal(preparation,1)
  await startup.stop();t.mock.timers.tick(10000);await startup.wake();assert.equal(execution,2)
 } finally {await startup.stop();t.mock.timers.reset()}
})
