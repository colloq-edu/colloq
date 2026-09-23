import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { TEST_ROOT } from './_env.mts'
import { createSession, db } from '../server/src/db.js'
import { forgetResources, machineResources, useDockerInfo } from '../server/src/kernel/resources.js'

test('all 51 broker allocations survive both UI pagination and 201 newer inactive sessions', async () => {
  const old = { ...process.env }, oldFetch = globalThis.fetch
  const catalog = path.join(TEST_ROOT, 'census-catalog.json')
  fs.writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'base', environments: [
    { name: 'base', image: `registry.example/base@sha256:${'a'.repeat(64)}`, gpu: false }] }))
  Object.assign(process.env, { KERNEL_BACKEND: 'broker', KERNEL_ISOLATION: 'required', KERNEL_RUNTIME_URL: 'http://127.0.0.1:1', KERNEL_RUNTIME_TOKEN: 't'.repeat(64), KERNEL_CATALOG_FILE: catalog })
  const census = Array.from({ length: 51 }, (_, i) => ({ sessionId: `census-${i}`, instanceId: `uid-${i}`, environment: 'base', revision: `sha256:${'a'.repeat(64)}`, phase: 'ready', memoryMb: 64, cpus: 1 }))
  globalThis.fetch = (async (url: any) => {
    const route = new URL(String(url)).pathname
    assert.ok(['/v1/health', '/v1/rooms'].includes(route))
    return new Response(JSON.stringify(route === '/v1/rooms' ? { rooms: census } : { ok: true, reason: null, defaultCpus: 2, defaultMemoryMb: 2048, maxMemoryMb: 8192 }), { status: 200 })
  }) as typeof fetch
  useDockerInfo(async () => ({ code: 0, out: `${10000 * 1024 ** 2} 8` }))
  try {
    for (const room of census) createSession(room.sessionId, room.sessionId)
    forgetResources()
    const first = await machineResources()
    assert.equal(first.rooms.length, 50)
    assert.equal(first.memory.availableMb, 5712, '10000 - 1024 reserve - 51 × 64')
    for (let i = 0; i < 201; i++) {
      const id = `inactive-${i}`
      createSession(id, id)
      db.prepare('UPDATE sessions SET created_at=? WHERE id=?').run(Date.now() + i + 10000, id)
    }
    forgetResources()
    const second = await machineResources()
    assert.equal(second.memory.availableMb, 5712)
    assert.equal(second.rooms.length, 50, 'older live rooms remain visible before page truncation')
    census.push({ ...census[0], sessionId: 'unknown-live-room', instanceId: 'unknown-uid' })
    forgetResources()
    assert.equal((await machineResources()).memory.availableMb, 5648, 'an active Pod without a DB row is still allocated')
  } finally {
    globalThis.fetch = oldFetch
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
    Object.assign(process.env, old)
    useDockerInfo(null)
    forgetResources()
  }
})
