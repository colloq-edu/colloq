/**
 * A room's memory on k3s — from the form to the Pod.
 *
 * On 18 Sep 2026 it turned out that under the broker (production,
 * KERNEL_BACKEND=broker) the memory field in the class form did nothing: the
 * broker accepted only the environment, the revision and the cores, every
 * room Pod got RUNTIME_KERNEL_MEMORY (2Gi), `docker update` under the broker
 * silently returned "waiting for start", and the form labelled the field with
 * the docker path's defaults — 4 GB, 16 on GPU — which the Pod never saw.
 *
 * This pins down the whole web-side path against a fake broker: the number
 * rides in ensure, a change to a live room is a PATCH to the broker, a reset
 * is `null`, and the form is labelled with the broker's own default and
 * ceiling. The broker itself is checked against real Kubernetes in
 * runtime-lifecycle (a fake API) and live on k3s.
 */
import './_env.mts'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { TEST_ROOT } from './_env.mts'
import { STAFF_COOKIE, type InstanceResources } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner, rotateLinkKey } from '../server/src/admin/store.js'
import { app } from '../server/src/app.js'
import { sessionMemoryMb } from '../server/src/db.js'
import { endpointForSession } from '../server/src/kernel/pool.js'
import { forgetResources, machineResources, memoryBounds } from '../server/src/kernel/resources.js'

const digest = 'a'.repeat(64)
const revision = `sha256:${digest}`
const catalog = {
  schemaVersion: 1,
  release: 'v1',
  defaultEnvironment: 'base',
  environments: [
    { name: 'base', image: `registry.example/base@sha256:${digest}`, gpu: false },
    { name: 'gpu', image: `registry.example/gpu@sha256:${digest}`, gpu: true },
  ],
}

/** What the broker heard — method, path and body. */
const heard: Array<{ method: string; url: string; body: any }> = []
let census: Array<Record<string, unknown>> = []
let broker: http.Server
let server: http.Server
let base = ''
let cookie = ''
const saved = { ...process.env }

function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  broker = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    heard.push({ method: req.method ?? '', url: req.url ?? '', body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/health')
      return res.end(
        JSON.stringify({ ok: true, reason: null, defaultCpus: 2, defaultMemoryMb: 2048, maxMemoryMb: 8192 }),
      )
    if (req.url === '/v1/rooms') return res.end(JSON.stringify({ rooms: census }))
    if (req.method === 'PATCH')
      return res.end(JSON.stringify({ outcome: 'applied', memoryMb: body.memoryMb ?? 2048 }))
    if (req.method === 'POST') {
      const id = decodeURIComponent((req.url ?? '').split('/').pop() ?? '')
      return res.end(
        JSON.stringify({
          url: `http://colloq-room-${id}.colloq.svc:8888`,
          token: 't'.repeat(64),
          instanceId: `pod-${id}`,
          environment: body.environment,
          revision,
        }),
      )
    }
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((r) => broker.listen(0, '127.0.0.1', r))
  const token = path.join(TEST_ROOT, 'broker-memory-token')
  fs.writeFileSync(token, 'k'.repeat(64))
  const catalogFile = path.join(TEST_ROOT, 'broker-memory-catalog.json')
  fs.writeFileSync(catalogFile, JSON.stringify(catalog))
  Object.assign(process.env, {
    KERNEL_BACKEND: 'broker',
    KERNEL_ISOLATION: 'required',
    KERNEL_RUNTIME_URL: `http://127.0.0.1:${(broker.address() as { port: number }).port}`,
    KERNEL_RUNTIME_TOKEN_FILE: token,
    KERNEL_CATALOG_FILE: catalogFile,
    // The docker path's defaults are different on purpose: if the form shows
    // them, the test will see it.
    KERNEL_MEM: '4g',
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const owner = oldestOwner() ?? createTeacher({ name: 'Владелец', email: 'broker.mem@example.edu', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  cookie = mintCookie(owner)
})

after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  server?.closeAllConnections()
  broker?.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  await new Promise<void>((r) => broker.close(() => r()))
})

function call(method: string, url: string, body?: unknown): Promise<globalThis.Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function createRoom(body: Record<string, unknown>): Promise<string> {
  const res = await call('POST', '/api/admin/seminars', { name: 'Зрение на k3s', ...body })
  assert.equal(res.status, 201, await res.clone().text())
  return ((await res.json()) as { id: string }).id
}

/** The panel answers without waiting for the PATCH to the broker — so wait for it here. */
async function heardPatch(id: string): Promise<{ body: any } | undefined> {
  for (let i = 0; i < 100; i++) {
    const found = heard.find((h) => h.method === 'PATCH' && h.url === `/v1/rooms/${id}`)
    if (found) return found
    await new Promise((r) => setTimeout(r, 10))
  }
  return undefined
}

test("under the broker the form shows the broker's default and ceiling, not the docker path's", async () => {
  forgetResources()
  const res = await call('GET', '/api/instance/resources')
  assert.equal(res.status, 200)
  const body = (await res.json()) as InstanceResources
  // The Pod gets the broker's RUNTIME_KERNEL_MEMORY — one number for all
  // environments.
  assert.equal(body.kernel.defaultMemoryMb, 2048)
  assert.equal(body.kernel.gpuDefaultMemoryMb, 2048, 'on GPU the broker gives no more, and the form must not promise 16')
  assert.equal(body.kernel.perEnvironment.base?.memoryMb, 2048)
  assert.equal(body.kernel.perEnvironment.gpu?.memoryMb, 2048)
  // The broker's ceiling is stricter than the machine's memory — and that is
  // what the field's bound names.
  assert.equal(body.limits.max, Math.min(8192, body.memory.totalMb - 1024))
  assert.equal(memoryBounds().max, body.limits.max)
})

test('a live room on k3s is shown with the memory its Pod has, and "free" as what is not yet promised', async () => {
  const id = await createRoom({ memoryMb: 6144 })
  census = [{ sessionId: id, instanceId: 'pod', phase: 'ready', environment: 'base', revision, cpus: 2, memoryMb: 3072 }]
  forgetResources()
  const body = await machineResources()
  const listed = body.rooms.find((r) => r.id === id)
  assert.equal(listed?.alive, true)
  // 6 GB is recorded, but kubelet set 3 (the change is deferred): the truth is
  // three.
  assert.equal(listed?.memoryMb, 3072)
  // requests = limits: the scheduler counts what was promised to a Pod as
  // taken, however much Python actually touches. Free is no more than what is
  // not yet promised.
  assert.ok(body.memory.availableMb !== null)
  assert.ok(body.memory.availableMb! <= body.memory.totalMb - 1024 - 3072)
  census = []
  forgetResources()
})

test('a memory change in the panel reaches the broker as a PATCH, a reset as null, above the ceiling a refusal', async () => {
  const id = await createRoom({})
  heard.length = 0
  const raised = await call('PATCH', `/api/admin/seminars/${id}`, { memoryMb: 4096 })
  assert.equal(raised.status, 200)
  assert.deepEqual((await heardPatch(id))?.body, { memoryMb: 4096 })
  assert.equal(sessionMemoryMb(id), 4096)

  heard.length = 0
  const reset = await call('PATCH', `/api/admin/seminars/${id}`, { memoryMb: null })
  assert.equal(reset.status, 200)
  // A reset used to go nowhere: the live Pod stayed on the old number.
  assert.deepEqual((await heardPatch(id))?.body, { memoryMb: null })

  heard.length = 0
  await call('GET', '/api/instance/resources')
  const refused = await call('PATCH', `/api/admin/seminars/${id}`, { memoryMb: 16384 })
  assert.equal(refused.status, 400, 'a number above the broker ceiling was accepted into the seminar row')
  assert.equal(await heardPatch(id), undefined)
  assert.equal(sessionMemoryMb(id), null)
})

test('a kernel start under the broker carries the room memory, and without it the broker default', async () => {
  const id = await createRoom({ memoryMb: 6144 })
  heard.length = 0
  await endpointForSession(id, 'base')
  const ensure = heard.find((h) => h.method === 'POST' && h.url === `/v1/rooms/${id}`)
  assert.equal(ensure?.body.memoryMb, 6144, 'the Pod would have got 2Gi with 6 GB in the form')

  const plain = await createRoom({})
  heard.length = 0
  await endpointForSession(plain, 'base')
  const bare = heard.find((h) => h.method === 'POST' && h.url === `/v1/rooms/${plain}`)
  assert.equal('memoryMb' in (bare?.body ?? {}), false)
})
