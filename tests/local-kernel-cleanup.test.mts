import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { db, createSession, getSession } from '../server/src/db.ts'
import { retireDatabaseKernels, stopsLocalKernelsOnExit } from '../server/src/local/kernel-cleanup.ts'

test('foreground session ends kernels while development reload and deployments preserve them', () => {
  assert.equal(stopsLocalKernelsOnExit({COLLOQ_LOCAL_SESSION:'1',COLLOQ_STOP_KERNELS_ON_EXIT:'1'}),true)
  assert.equal(stopsLocalKernelsOnExit({COLLOQ_LOCAL_SESSION:'1',COLLOQ_STOP_KERNELS_ON_EXIT:'0'}),false)
  assert.equal(stopsLocalKernelsOnExit({COLLOQ_STOP_KERNELS_ON_EXIT:'1'}),false)
  assert.equal(stopsLocalKernelsOnExit({}),false)
})

test('cleanup only retires sessions in its database, continues after failure and preserves session records', async () => {
  createSession('cleanup-one','One')
  createSession('cleanup-two','Two')
  const retired:string[]=[]
  await assert.rejects(retireDatabaseKernels(db,async id=>{
    retired.push(id)
    if(id==='cleanup-one') throw new Error('docker unavailable')
  }), /Could not retire/)
  assert.deepEqual(retired.sort(),['cleanup-one','cleanup-two'])
  assert.ok(getSession('cleanup-one'))
  assert.ok(getSession('cleanup-two'))
})

test('final cleanup removes only database-owned Docker containers and keeps files',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path')
 const {spawnSync}=await import('node:child_process')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colloq-cleanup-docker-'))
 try {
  const bin=path.join(dir,'bin');fs.mkdirSync(bin)
  const log=path.join(dir,'docker-calls.jsonl')
  fs.writeFileSync(path.join(bin,'docker'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.FAKE_DOCKER_LOG,JSON.stringify(process.argv.slice(2))+'\\n')\n`,{mode:0o755})
  const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'notebook.ipynb'),'preserved')
  const env={...process.env,DATA_DIR:path.join(dir,'data'),WORKSPACE_DIR:workspace,KERNEL_BACKEND:'docker',PATH:`${bin}:${process.env.PATH}`,FAKE_DOCKER_LOG:log}
  const seed=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {createSession,closeDatabase} from './server/src/db.ts';createSession('my-room','Mine');closeDatabase()"],{env,encoding:'utf8'})
  assert.equal(seed.status,0,seed.stderr)
  const cleanup=spawnSync(process.execPath,['--import','tsx','server/src/ops/local-cleanup.ts'],{env,encoding:'utf8',timeout:10000})
  assert.equal(cleanup.status,0,cleanup.stderr)
  // Both of the room's containers: its own and the container for its
  // students' personal notebooks. Stopping the instance must take the second
  // one too, otherwise it lives on until `make down` with no server left that
  // would know about it.
  assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l)),[['rm','-f','colloq-room-my-room'],['rm','-f','colloq-room-my-room-own']])
  const late=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import assert from 'node:assert/strict';import {dropLocalRoomKernel,endpointForSession} from './server/src/kernel/pool.ts';import {closeDatabase} from './server/src/db.ts';await dropLocalRoomKernel('my-room');await assert.rejects(endpointForSession('my-room',null),/stopping|останов/);closeDatabase()"],{env:{...env,KERNEL_ISOLATION:'on'},encoding:'utf8',timeout:10000})
  assert.equal(late.status,0,late.stderr)
  assert.equal(fs.readFileSync(path.join(workspace,'notebook.ipynb'),'utf8'),'preserved')
  assert.ok(fs.existsSync(path.join(dir,'data','colloq.db')))
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
