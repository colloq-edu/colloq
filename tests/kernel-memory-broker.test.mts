/**
 * Память комнаты на k3s — от формы до Pod.
 *
 * 18.09 выяснилось, что под брокером (прод, KERNEL_BACKEND=broker) поле памяти
 * в форме занятия не делало ничего: брокер принимал только окружение, ревизию
 * и ядра, каждый Pod комнаты получал RUNTIME_KERNEL_MEMORY (2Gi), `docker
 * update` под брокером молча возвращал «ждёт пуска», а форма подписывала поле
 * умолчаниями docker-пути — 4 ГБ, на GPU 16, — которых Pod не видел никогда.
 *
 * Здесь закреплён весь путь веб-стороны против подделки брокера: число едет в
 * ensure, изменение живой комнате — PATCH брокеру, сброс — `null`, а форма
 * подписана умолчанием и потолком самого брокера. Сам брокер против настоящего
 * Kubernetes проверяется в runtime-lifecycle (подделка API) и вживую на k3s.
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

/** Что брокер услышал — метод, путь и тело. */
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
    // Умолчания docker-пути нарочно другие: если форма покажет их, тест это увидит.
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

/** PATCH брокеру уходит без ожидания ответа панели — подождать его. */
async function heardPatch(id: string): Promise<{ body: any } | undefined> {
  for (let i = 0; i < 100; i++) {
    const found = heard.find((h) => h.method === 'PATCH' && h.url === `/v1/rooms/${id}`)
    if (found) return found
    await new Promise((r) => setTimeout(r, 10))
  }
  return undefined
}

test('форма под брокером подписана умолчанием и потолком брокера, а не docker-пути', async () => {
  forgetResources()
  const res = await call('GET', '/api/instance/resources')
  assert.equal(res.status, 200)
  const body = (await res.json()) as InstanceResources
  // Pod получает RUNTIME_KERNEL_MEMORY брокера — одно число на все окружения.
  assert.equal(body.kernel.defaultMemoryMb, 2048)
  assert.equal(body.kernel.gpuDefaultMemoryMb, 2048, 'на GPU брокер не даёт больше, и форма не должна обещать 16')
  assert.equal(body.kernel.perEnvironment.base?.memoryMb, 2048)
  assert.equal(body.kernel.perEnvironment.gpu?.memoryMb, 2048)
  // Потолок брокера строже памяти машины — граница поля его и называет.
  assert.equal(body.limits.max, Math.min(8192, body.memory.totalMb - 1024))
  assert.equal(memoryBounds().max, body.limits.max)
})

test('живая комната на k3s показана той памятью, что у Pod есть, а «свободно» — необещанным', async () => {
  const id = await createRoom({ memoryMb: 6144 })
  census = [{ sessionId: id, instanceId: 'pod', phase: 'ready', environment: 'base', revision, cpus: 2, memoryMb: 3072 }]
  forgetResources()
  const body = await machineResources()
  const listed = body.rooms.find((r) => r.id === id)
  assert.equal(listed?.alive, true)
  // Записано 6 ГБ, а kubelet выставил 3 (изменение отложено): правда — три.
  assert.equal(listed?.memoryMb, 3072)
  // requests = limits: обещанное Pod планировщик считает занятым, сколько бы
  // Python ни трогал. Свободно не больше, чем ещё не обещано.
  assert.ok(body.memory.availableMb !== null)
  assert.ok(body.memory.availableMb! <= body.memory.totalMb - 1024 - 3072)
  census = []
  forgetResources()
})

test('изменение памяти в панели доезжает до брокера PATCH-ем, сброс — null, выше потолка — отказ', async () => {
  const id = await createRoom({})
  heard.length = 0
  const raised = await call('PATCH', `/api/admin/seminars/${id}`, { memoryMb: 4096 })
  assert.equal(raised.status, 200)
  assert.deepEqual((await heardPatch(id))?.body, { memoryMb: 4096 })
  assert.equal(sessionMemoryMb(id), 4096)

  heard.length = 0
  const reset = await call('PATCH', `/api/admin/seminars/${id}`, { memoryMb: null })
  assert.equal(reset.status, 200)
  // Раньше сброс не уезжал никуда: живой Pod оставался на старом числе.
  assert.deepEqual((await heardPatch(id))?.body, { memoryMb: null })

  heard.length = 0
  await call('GET', '/api/instance/resources')
  const refused = await call('PATCH', `/api/admin/seminars/${id}`, { memoryMb: 16384 })
  assert.equal(refused.status, 400, 'число выше потолка брокера принято в строку семинара')
  assert.equal(await heardPatch(id), undefined)
  assert.equal(sessionMemoryMb(id), null)
})

test('подъём ядра под брокером несёт число комнаты, а без числа — умолчание брокера', async () => {
  const id = await createRoom({ memoryMb: 6144 })
  heard.length = 0
  await endpointForSession(id, 'base')
  const ensure = heard.find((h) => h.method === 'POST' && h.url === `/v1/rooms/${id}`)
  assert.equal(ensure?.body.memoryMb, 6144, 'Pod получил бы 2Gi при 6 ГБ в форме')

  const plain = await createRoom({})
  heard.length = 0
  await endpointForSession(plain, 'base')
  const bare = heard.find((h) => h.method === 'POST' && h.url === `/v1/rooms/${plain}`)
  assert.equal('memoryMb' in (bare?.body ?? {}), false)
})
