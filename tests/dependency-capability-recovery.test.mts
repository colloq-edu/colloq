import './_env.mts'
import '../server/src/competitions/fake-runner.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from '../server/src/config.js'
import { db } from '../server/src/db.js'
import { createCompetition, createEntrant, getCompetition, setCompetitionState } from '../server/src/competitions/store.js'
import * as store from '../server/src/dependencies/store.js'
import * as service from '../server/src/dependencies/service.js'
import { requirementLineCount } from '../shared/dependencies.js'

function fixture() {
 const c = createCompetition({ slug: 'review-' + randomUUID(), title: 'Review' })!
 const e = createEntrant('Review').entrant
 setCompetitionState(c.id, 'live')
 const revision = (letter: string) => store.putRevision({ environmentName: 'base', imageDigest: 'sha256:' + letter.repeat(64), pythonVersion: '3.11.1', pythonAbi: 'cp311', platform: 'linux/amd64', packages: [{ name: 'pip', version: '1' }], baseConstraintsHash: letter })
 const first = revision('a'), next = revision('b')
 store.selectRevision(c.id, first.id)
 return { c: getCompetition(c.id)!, e, first, next }
}
async function broker(task: (log: string) => Promise<void>) {
 const previous = { path: process.env.PATH, backend: process.env.KERNEL_BACKEND, competition: process.env.COMPETITION_BACKEND }
 const dir = path.join(config.dataDir, 'fake-docker-' + randomUUID())
 fs.mkdirSync(dir, { recursive: true })
 const log = path.join(dir, 'calls')
 fs.writeFileSync(path.join(dir, 'docker'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n')\n`, { mode: 0o755 })
 process.env.PATH = dir + path.delimiter + process.env.PATH
 process.env.KERNEL_BACKEND = 'broker'; process.env.COMPETITION_BACKEND = 'docker'
 try { await task(log) } finally {
  await service.stopDependencyPump()
  for (const [key,value] of [['PATH',previous.path],['KERNEL_BACKEND',previous.backend],['COMPETITION_BACKEND',previous.competition]] as const) { if(value===undefined)delete process.env[key];else process.env[key]=value }
 }
}

test('unsupported broker revision capture refuses before Docker and overview retains known metadata', async () => {
 const { c, e, first } = fixture()
 await broker(async log => {
  await assert.rejects(service.executionRevision(c), { code: 'unsupported_backend' })
  const overview = await service.dependencyOverview(c, e.id)
  assert.equal(overview.revision?.id, first.id)
  assert.equal(overview.capabilities?.preparation.available, false)
  const admin = await service.adminDependencyOverview(c)
  assert.equal(admin.revision?.id, first.id)
  const unpinned = createCompetition({ slug: 'unpinned-' + randomUUID(), title: 'Unpinned' })!
  assert.equal((await service.adminDependencyOverview(unpinned)).revision, null)
  assert.equal(fs.existsSync(log), false)
 })
})

test('unsupported broker startup performs no Docker cleanup', async () => {
 await broker(async log => {
  await service.startDependencyPump()
  await service.stopDependencyPump()
  assert.equal(fs.existsSync(log), false)
  assert.equal(service.dependencyPreparationDiagnostics().running, false)
 })
})

test('changing retained base and invalidating baseline is one durable transaction', () => {
 const { c, first, next } = fixture()
 db.exec(`CREATE TRIGGER reject_revision_invalidation BEFORE UPDATE OF input_revision ON competitions WHEN NEW.id = '${c.id}' BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`)
 try {
  assert.throws(() => store.selectRevision(c.id, next.id), /injected persistence failure/)
  assert.equal(store.competitionRevision(c.id)?.id, first.id)
 } finally { db.exec('DROP TRIGGER reject_revision_invalidation') }
})

test('all Python splitlines separators count before preparation quota and normalize consistently', () => {
 for (const separator of ['\n','\r\n','\r','\v','\f','\x1c','\x1d','\x1e','\x85','\u2028','\u2029']) {
  assert.equal(requirementLineCount(['numpy', '# note', 'pip'].join(separator)), 2, JSON.stringify(separator))
  assert.equal(store.checkRequirements(['numpy', '# note', 'pip'].join(separator)), 'numpy\n# note\npip')
  assert.throws(() => store.checkRequirements(Array(33).fill('numpy').join(separator)), { code: 'dependency_limits' })
 }
})

test('unsupported broker leaves durable preparation work queued and unclaimed', async () => {
 const { c, e, first } = fixture()
 store.setPolicy(c.id, { enabled: true })
 const bundle = store.createBundle(c.id, e.id, first.id, 'example')
 await broker(async log => {
  let invoked = 0
  assert.equal(await service.processNextPreparation(async () => { invoked++; throw new Error('must not execute') }), false)
  assert.equal(invoked, 0)
  assert.equal(store.getBundle(bundle.id)?.state, 'queued')
  assert.equal(fs.existsSync(log), false)
 })
})

test('admin refresh-base refuses unsupported runtime before revision capture', async () => {
 const { c } = fixture()
 const { default: express } = await import('express')
 const { dependencyRoutes } = await import('../server/src/dependencies/routes.js')
 const { createTeacher } = await import('../server/src/admin/store.js')
 const { issueStaffCookie } = await import('../server/src/admin/auth.js')
 const teacher = createTeacher({ name: 'Review', email: randomUUID()+'@test.local', role: 'owner' })!
 let cookie = ''
 issueStaffCookie({cookie:(name:string,value:string)=>{cookie=`${name}=${value}`}} as any, teacher)
 await broker(async log => {
  const app = express();app.use(dependencyRoutes())
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(done=>server.on('listening',done))
  try {
   const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
   const response=await fetch(`${origin}/api/admin/competitions/${c.id}/dependencies/refresh-base`,{method:'POST',headers:{cookie}})
   assert.equal(response.status,503)
   assert.equal((await response.json()).reason,'unsupported_backend')
   assert.equal(fs.existsSync(log),false)
  } finally {server.closeAllConnections();server.close()}
 })
})
