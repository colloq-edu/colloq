import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { createSession } from '../server/src/db.js'
import { isolationAvailable, useDockerForLimits } from '../server/src/kernel/pool.js'
import { forgetResources, machineResources, useDockerInfo } from '../server/src/kernel/resources.js'

function dockerBoundary(run: (args: string[]) => { code: number; out: string }) {
  const oldSpawn = cp.spawn
  cp.spawn = ((command: string, args: string[]) => {
    const child: any = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    const result = command === 'nvidia-smi' ? { code: 1, out: '' } : (assert.equal(command, 'docker'), run(args))
    process.nextTick(() => { child.stdout.emit('data', Buffer.from(result.out)); child.emit('close', result.code) })
    return child
  }) as typeof cp.spawn
  syncBuiltinESMExports()
  return () => { cp.spawn = oldSpawn; syncBuiltinESMExports() }
}
function dockerEnvironment() {
  const old = { ...process.env }, exists = fs.existsSync
  Object.assign(process.env, { KERNEL_BACKEND: 'docker', KERNEL_ISOLATION: 'required', KERNEL_NETWORK: 'recovery-network' })
  fs.existsSync = ((p: any) => p === '/.dockerenv' || exists(p)) as typeof fs.existsSync
  return () => {
    fs.existsSync = exists
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
    Object.assign(process.env, old)
  }
}

test('a failed Docker probe is coalesced, backs off, and recovers without a process restart', async (t) => {
  const restoreEnv = dockerEnvironment()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  let ready = false, probes = 0
  const restore = dockerBoundary((args) => {
    if (args[0] === 'network') return { code: 0, out: 'network-id' }
    assert.equal(args[0], 'version'); probes++
    return { code: ready ? 0 : 1, out: ready ? '28.0.0' : 'unavailable' }
  })
  try {
    assert.deepEqual(await Promise.all([isolationAvailable(), isolationAvailable()]), [false, false])
    assert.equal(probes, 1)
    ready = true
    assert.equal(await isolationAvailable(), false, 'negative cache prevents a hot retry loop')
    t.mock.timers.tick(60000)
    assert.deepEqual(await Promise.all([isolationAvailable(), isolationAvailable()]), [true, true])
    assert.equal(probes, 2)
  } finally { restore(); restoreEnv() }
})

test('a failed named network is retried and a changed network never inherits a cached success', async (t) => {
  const restoreEnv = dockerEnvironment()
  process.env.KERNEL_NETWORK = 'network-that-recovers'
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120000 })
  let ready = false, probes = 0
  const restore = dockerBoundary((args) => {
    if (args[0] === 'version') return { code: 0, out: '28.0.0' }
    assert.equal(args[0], 'network'); probes++
    return { code: ready && args[2] === 'network-that-recovers' ? 0 : 1, out: 'network-id' }
  })
  try {
    assert.equal(await isolationAvailable(), false)
    ready = true
    t.mock.timers.tick(60000)
    assert.equal(await isolationAvailable(), true)
    assert.equal(probes, 2)
    process.env.KERNEL_NETWORK = 'different-missing-network'
    assert.equal(await isolationAvailable(), false)
  } finally { restore(); restoreEnv() }
})

test('memory accounting includes each running own container without charging stopped containers', async () => {
  const restoreEnv = dockerEnvironment()
  const restore = dockerBoundary((args) => {
    if (args[0] === 'version' || args[0] === 'network') return { code: 0, out: 'ready' }
    assert.equal(args[0], 'ps')
    return { code: 0, out: 'both\t\trunning\troom\nboth\t\trunning\town\nown-only\t\texited\troom\nown-only\t\trunning\town\nstoppedown\t\trunning\troom\nstoppedown\t\texited\town' }
  })
  useDockerInfo(async () => ({ code: 0, out: `${10000 * 1024 ** 2} 8` }))
  useDockerForLimits(async (args) => ({ code: 0, out: `${(args[1].endsWith('-own') ? 128 : 64) * 1024 ** 2} 1000000000` }))
  try {
    for (const id of ['both', 'own-only', 'stoppedown']) createSession(id, id)
    forgetResources()
    const resources = await machineResources()
    assert.equal(resources.memory.availableMb, 8592, '10000 - 1024 - 64 - 128 - 128 - 64')
    assert.equal(resources.rooms.find((room) => room.id === 'both')?.own?.memoryMb, 128)
  } finally { restore(); restoreEnv(); useDockerInfo(null); useDockerForLimits(null); forgetResources() }
})
