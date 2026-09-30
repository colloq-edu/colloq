/**
 * Personal notebooks on the broker, from the app's side (server/src/kernel/pool.ts).
 *
 * Until 0.10 `endpointForSession(id, env, 'own')` refused on the broker, and
 * every personal-notebook path of the pool (their numbers, their live limits,
 * dropping their container, the census) was docker-only. Against a fake
 * broker this pins down the same behaviour the docker path has: the
 * personal notebooks' own numbers, following the room's while they have none,
 * a Pod that goes when its last kernel does, and a census that counts the
 * second Pod on its own and never as the room.
 */
import './_env.mts'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { TEST_ROOT } from './_env.mts'
import { createSession, setRules, setSessionCpus, setSessionMemoryMb, storedRules } from '../server/src/db.js'
import {
  applyCpuLimit,
  applyMemoryLimit,
  applyOwnLimits,
  dropOwnKernel,
  dropRoomKernel,
  endpointForSession,
  listRoomKernels,
  runningKernelLimits,
} from '../server/src/kernel/pool.js'
import { forgetResources, machineResources } from '../server/src/kernel/resources.js'
import { updateResourceSettings } from '../server/src/admin/resource-settings.js'

const digest = 'a'.repeat(64)
const revision = `sha256:${digest}`
const machine = { memory: { min: 512, max: 65_536 }, cpus: { min: 1, max: 16 } }
const heard: Array<{ method: string; url: string; body: any }> = []
let census: Array<Record<string, unknown>> = []
let patchReply: { status: number; body: unknown } = { status: 200, body: { outcome: 'applied' } }
let holdOwn: Promise<void> | null = null
let broker: http.Server
const saved = { ...process.env }

before(async () => {
  broker = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    heard.push({ method: req.method ?? '', url: req.url ?? '', body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/health')
      return res.end(JSON.stringify({ ok: true, reason: null, defaultCpus: 2, defaultMemoryMb: 2048, maxMemoryMb: 8192, inPlaceResize: true }))
    if (req.url === '/v1/rooms') return res.end(JSON.stringify({ rooms: census }))
    if (req.method === 'PATCH') {
      res.statusCode = patchReply.status
      return res.end(JSON.stringify(patchReply.body))
    }
    if (req.method === 'POST') {
      if (req.url?.endsWith('/own') && holdOwn) await holdOwn
      return res.end(JSON.stringify({
        url: 'http://colloq-room-x.colloq.svc:8888',
        token: 't'.repeat(64),
        instanceId: `pod-${req.url}`,
        environment: body.environment,
        revision,
      }))
    }
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
  const token = path.join(TEST_ROOT, 'own-broker-token')
  fs.writeFileSync(token, 'k'.repeat(64))
  const catalogFile = path.join(TEST_ROOT, 'own-broker-catalog.json')
  fs.writeFileSync(catalogFile, JSON.stringify({
    schemaVersion: 1, release: 'v1', defaultEnvironment: 'base',
    environments: [{ name: 'base', image: `registry.example/base@sha256:${digest}`, gpu: false }],
  }))
  delete process.env.KERNEL_ISOLATION
  Object.assign(process.env, {
    KERNEL_BACKEND: 'broker',
    KERNEL_ISOLATION: 'required',
    KERNEL_RUNTIME_URL: `http://127.0.0.1:${(broker.address() as { port: number }).port}`,
    KERNEL_RUNTIME_TOKEN_FILE: token,
    KERNEL_CATALOG_FILE: catalogFile,
  })
})

after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  broker?.closeAllConnections()
  await new Promise<void>((resolve) => broker.close(() => resolve()))
})

beforeEach(() => {
  heard.length = 0
  census = []
  patchReply = { status: 200, body: { outcome: 'applied' } }
  holdOwn = null
})

const posts = (id: string) => heard.filter((h) => h.method === 'POST' && h.url.startsWith(`/v1/rooms/${id}`))

test('a personal notebook starts its own Pod with the personal numbers: the class rule, the instance default, else the room\'s', async () => {
  const id = 'own-limits'
  createSession(id, 'Личные числа', 'base')
  setSessionMemoryMb(id, 6144)
  setSessionCpus(id, 4)
  await endpointForSession(id, 'base', 'own')
  assert.deepEqual(posts(id).map((h) => [h.url, h.body]), [
    // Nothing of their own anywhere: exactly the room's numbers, as on docker.
    [`/v1/rooms/${id}/own`, { environment: 'base', revision, cpus: 4, memoryMb: 6144 }],
  ])
  try {
    updateResourceSettings({ ownMemoryMb: 3072 }, machine)
    heard.length = 0
    await endpointForSession(id, 'base', 'own')
    assert.deepEqual(posts(id)[0].body, { environment: 'base', revision, cpus: 4, memoryMb: 3072 }, 'the instance default for personal notebooks')
    setRules(id, { ...storedRules(id), ownMemoryMb: 1024, ownCpus: 1 })
    heard.length = 0
    await endpointForSession(id, 'base', 'own')
    assert.deepEqual(posts(id)[0].body, { environment: 'base', revision, cpus: 1, memoryMb: 1024 }, "the class's own rule")
    // The class's Pod is untouched by any of it.
    heard.length = 0
    await endpointForSession(id, 'base')
    assert.deepEqual(posts(id).map((h) => [h.url, h.body]), [[`/v1/rooms/${id}`, { environment: 'base', revision, cpus: 4, memoryMb: 6144 }]])
  } finally {
    updateResourceSettings({ ownMemoryMb: null }, machine)
  }
})

test("the class's memory and cores reach the personal Pod only while it follows the room's number", async () => {
  const id = 'own-follows'
  createSession(id, 'Следом', 'base')
  assert.equal(await applyMemoryLimit(id, 4096), 'applied')
  assert.deepEqual(heard.map((h) => [h.method, h.url, h.body]), [
    ['PATCH', `/v1/rooms/${id}`, { memoryMb: 4096 }],
    ['PATCH', `/v1/rooms/${id}/own`, { memoryMb: 4096 }],
  ])
  setRules(id, { ...storedRules(id), ownMemoryMb: 2048 })
  heard.length = 0
  assert.equal(await applyMemoryLimit(id, 8192), 'applied')
  assert.deepEqual(heard.map((h) => h.url), [`/v1/rooms/${id}`], 'a number of their own is not the room\'s to change')
  heard.length = 0
  assert.equal(await applyCpuLimit(id, 3), 'applied')
  assert.deepEqual(heard.map((h) => [h.url, h.body]), [[`/v1/rooms/${id}`, { cpus: 3 }], [`/v1/rooms/${id}/own`, { cpus: 3 }]])
  // A rule change sends the personal numbers to their Pod, and only there.
  heard.length = 0
  patchReply = { status: 200, body: { outcome: 'absent' } }
  assert.equal(await applyOwnLimits(id), 'pending', 'no personal Pod: the next start takes the numbers')
  assert.deepEqual(heard.map((h) => [h.method, h.url, h.body]), [['PATCH', `/v1/rooms/${id}/own`, { memoryMb: 2048, cpus: null }]])
})

test('a cluster that resizes no live Pod leaves the number for the next Pod: pending, not failed', async () => {
  const id = 'own-no-resize'
  createSession(id, 'Без resize', 'base')
  patchReply = { status: 501, body: { error: 'In-place Pod resize is disabled on this runtime (RUNTIME_IN_PLACE_RESIZE=0)' } }
  assert.equal(await applyCpuLimit(id, 4), 'pending')
  assert.equal(await applyMemoryLimit(id, 4096), 'pending')
  assert.equal(await applyOwnLimits(id), 'pending')
  // Any other refusal is still a failure the log names.
  patchReply = { status: 409, body: { error: 'Room resize is infeasible on this node' } }
  assert.equal(await applyCpuLimit(id, 64), 'failed')
})

test('the personal Pod goes when its last kernel does, but never under a personal start in flight', async () => {
  const id = 'own-drop'
  createSession(id, 'Уход', 'base')
  await dropOwnKernel(id)
  assert.deepEqual(heard.map((h) => [h.method, h.url]), [['DELETE', `/v1/rooms/${id}/own`]])
  let release!: () => void
  holdOwn = new Promise<void>((resolve) => (release = resolve))
  const starting = endpointForSession(id, 'base', 'own')
  while (!heard.some((h) => h.method === 'POST')) await new Promise((resolve) => setTimeout(resolve, 5))
  heard.length = 0
  await dropOwnKernel(id)
  assert.deepEqual(heard, [], 'a student is starting a personal kernel right now')
  // The room's own DELETE waits for that start, then takes both Pods at once.
  const stopping = dropRoomKernel(id)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(heard.filter((h) => h.method === 'DELETE'), [], 'DELETE must wait for the accepted personal ensure')
  release()
  await starting.catch(() => {})
  await stopping
  assert.deepEqual(heard.filter((h) => h.method === 'DELETE').map((h) => h.url), [`/v1/rooms/${id}`])
})

test('the census folds both Pods per class, counts the personal one on its own, and never shows it as the room', async () => {
  const id = 'own-census'
  createSession(id, 'Перепись', 'base')
  createSession('own-only', 'Только личные', 'base')
  census = [
    { sessionId: id, instanceId: 'pod-room', phase: 'ready', environment: 'base', revision, cpus: 2, memoryMb: 4096 },
    { sessionId: id, instanceId: 'pod-own', phase: 'ready', environment: 'base', revision, cpus: 1, memoryMb: 1024, role: 'own' },
    { sessionId: 'own-only', instanceId: 'pod-own-2', phase: 'pending', environment: 'base', revision, cpus: 1, memoryMb: 1536, role: 'own' },
  ]
  const rooms = await listRoomKernels()
  assert.deepEqual(rooms.find((room) => room.session === id), { session: id, running: true, own: true })
  assert.deepEqual(rooms.find((room) => room.session === 'own-only'), { session: 'own-only', running: true, own: true })
  assert.equal(rooms.length, 2)
  const kernels = await runningKernelLimits()
  assert.deepEqual(kernels.filter((k) => k.session === id).map((k) => [k.role, k.memoryMb, k.cpus]), [['room', 4096, 2], ['own', 1024, 1]])
  forgetResources()
  const resources = await machineResources()
  const row = resources.rooms.find((room) => room.id === id)!
  assert.equal(row.memoryMb, 4096, 'the personal Pod must not stand in for the room')
  assert.deepEqual(row.own, { memoryMb: 1024, cpus: 1 })
  const personalOnly = resources.rooms.find((room) => room.id === 'own-only')!
  assert.deepEqual(personalOnly.own, { memoryMb: 1536, cpus: 1 })
  forgetResources()
})

test('a personal Pod that no kernel of this process lives in goes after the personal idle time; the class stays', async () => {
  // After an app restart the scopes are gone, and nothing would ever drop the
  // Pod while the class stays busy: on Kubernetes it holds its memory reserved.
  const { sweepIdleKernels } = await import('../server/src/kernel/index.js')
  const id = 'own-untracked'
  createSession(id, 'Без хозяина', 'base')
  census = [
    { sessionId: id, instanceId: 'pod-room', phase: 'ready', environment: 'base', revision },
    { sessionId: id, instanceId: 'pod-own', phase: 'ready', environment: 'base', revision, role: 'own' },
  ]
  const start = Date.now()
  const deletes = () => heard.filter((h) => h.method === 'DELETE').map((h) => h.url)
  await sweepIdleKernels(start)
  await sweepIdleKernels(start + 29 * 60_000)
  assert.deepEqual(deletes(), [], 'a student back within the idle time re-attaches')
  await sweepIdleKernels(start + 31 * 60_000)
  assert.deepEqual(deletes(), [`/v1/rooms/${id}/own`], 'only the personal Pod; the class keeps its Python')
})
