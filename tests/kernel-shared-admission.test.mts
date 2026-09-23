import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { createSession, setSessionMemoryMb, setRules, storedRules } from '../server/src/db.js'
import { applyMemoryLimit, applyOwnLimits, dropRoomKernel, endpointForSession } from '../server/src/kernel/pool.js'
import { forgetResources, machineResources, useDockerInfo } from '../server/src/kernel/resources.js'
import { reserveWork, workBudgetSnapshot } from '../server/src/ops/work-budget.js'
import '../server/src/competitions/docker-runner.js'
import { competitionRunner, forgetCompetitionRunner } from '../server/src/competitions/runner-port.js'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
type Reply = { code: number; out: string }
function fakeDocker() {
  const old = { ...process.env }, oldSpawn = cp.spawn, oldFetch = globalThis.fetch, exists = fs.existsSync
  Object.assign(process.env, { KERNEL_BACKEND: 'docker', COMPETITION_BACKEND: 'docker', KERNEL_ISOLATION: 'required', KERNEL_NETWORK: 'admission-network', COLLOQ_ROOM_NETWORK: 'open' })
  fs.existsSync = ((p: any) => p === '/.dockerenv' || exists(p)) as typeof fs.existsSync
  forgetCompetitionRunner()
  const containers = new Map<string, number>(), stopped = new Set<string>(), calls: string[][] = []
  let intercept: ((args: string[]) => Promise<Reply> | undefined) | undefined
  const answer = async (args: string[]): Promise<Reply> => {
    calls.push(args)
    const delayed = intercept?.(args); if (delayed) return delayed
    if (args[0] === 'network' && args.at(-1)?.includes('Subnet')) return { code: 0, out: '10.213.0.0/22' }
    if (args[0] === 'version' || args[0] === 'network' || args[0] === 'image') return { code: 0, out: 'ready' }
    if (args[0] === 'ps') return { code: 0, out: [...containers].map(([name]) => {
      const own = name.endsWith('-own'); return `${name.slice('colloq-room-'.length).replace(/-own$/, '')}\t\t${stopped.has(name) ? 'exited' : 'running'}\t${own ? 'own' : 'room'}`
    }).join('\n') }
    if (args[0] === 'inspect') {
      if (!containers.has(args[1])) return { code: 1, out: 'No such container' }
      const format = args.at(-1)!
      if (format.includes('HostConfig.Memory')) return { code: 0, out: `${containers.get(args[1])! * 1024 ** 2} 1000000000` }
      if (format.includes('State')) return { code: 0, out: stopped.has(args[1]) ? 'exited' : 'running' }
      if (format.includes('.Image')) return { code: 0, out: 'ready' }
      if (format.includes('profile')) return { code: 0, out: '1' }
      if (format.includes('NetworkMode')) return { code: 0, out: 'admission-network' }
      return { code: 0, out: '' }
    }
    if (args[0] === 'run') {
      if (!args.includes('--name')) return { code: 0, out: 'colloq-perimeter: ok' }
      const name = args[args.indexOf('--name') + 1]
      containers.set(name, Number(args.find(a => a.startsWith('--memory='))!.match(/\d+/)![0]))
      return { code: 0, out: name }
    }
    if (args[0] === 'update') {
      if (!containers.has(args.at(-1)!)) return { code: 1, out: 'No such container' }
      containers.set(args.at(-1)!, Number(args.find(a => a.startsWith('--memory='))!.match(/\d+/)![0]))
      return { code: 0, out: '' }
    }
    if (args[0] === 'start') { stopped.delete(args[1]); return { code: 0, out: args[1] } }
    if (args[0] === 'rm') { containers.delete(args.at(-1)!); stopped.delete(args.at(-1)!); return { code: 0, out: '' } }
    throw new Error(`Unexpected docker: ${args.join(' ')}`)
  }
  cp.spawn = ((command: string, args: string[]) => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    void (command === 'nvidia-smi' ? Promise.resolve({ code: 1, out: '' }) : (assert.equal(command, 'docker'), answer(args))).then(result => {
      child.stdout.emit('data', Buffer.from(result.out)); child.emit('close', result.code)
    })
    return child
  }) as typeof cp.spawn
  syncBuiltinESMExports()
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
  useDockerInfo(async () => ({ code: 0, out: `${9216 * 1024 ** 2} 8` })); forgetResources()
  return { containers, stopped, calls, intercept(fn: typeof intercept) { intercept = fn }, async restore() {
    intercept = undefined
    for (const name of [...containers.keys()]) await dropRoomKernel(name.slice('colloq-room-'.length).replace(/-own$/, ''))
    cp.spawn = oldSpawn; globalThis.fetch = oldFetch; fs.existsSync = exists; syncBuiltinESMExports()
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
    Object.assign(process.env, old); forgetCompetitionRunner(); useDockerInfo(null); forgetResources()
  } }
}
function room(id: string, memory = 4096) { createSession(id, id); setSessionMemoryMb(id, memory); return id }

test('resource display immediately includes background promises; runner admission subtracts them exactly once', async () => {
  const docker = fakeDocker(); let release: (() => void) | null = null
  try {
    assert.equal((await machineResources()).memory.availableMb, 8192)
    release = reserveWork({ id: 'display-background', kind: 'preparation', memoryMb: 1664, diskBytes: 0 }, { availableMemoryMb: 8192 }); assert(release)
    assert.equal((await machineResources()).memory.availableMb, 6528, 'cached UI census must still include current holds')
    const raw = await competitionRunner().capacity()
    const second = reserveWork({ id: 'display-competition', kind: 'competition', memoryMb: 6400, diskBytes: 0 }, { availableMemoryMb: raw.availableMb })
    assert(second, 'raw capacity must not deduct the existing preparation twice'); second()
    release(); release = null
    assert.equal((await machineResources()).memory.availableMb, 8192)
  } finally { release?.(); await docker.restore() }
})

test('room and own startup honor already admitted competition and preparation memory', async () => {
  const docker = fakeDocker(); const release = reserveWork({ id: 'busy-background', kind: 'competition', memoryMb: 5000, diskBytes: 0 }, {})!
  try {
    const id = room('admission-room')
    for (const role of ['room', 'own'] as const) await assert.rejects(endpointForSession(id, 'base', role), /memory|памят/i)
    assert.equal(docker.calls.filter(args => args[0] === 'run' && args.includes('--name')).length, 0)
  } finally { release(); await docker.restore() }
})

test('concurrent room and own launches reserve before Docker census can see either container', async () => {
  const docker = fakeDocker(), entered = deferred<void>(), finish = deferred<Reply>()
  const id = room('admission-racing', 5000)
  docker.intercept(args => { if (args[0] === 'run' && args.includes('--name') && !args.includes(`colloq-room-${id}-own`)) { entered.resolve(); return finish.promise } })
  const first = endpointForSession(id, 'base'); void first.catch(() => {})
  try {
    await entered.promise
    await assert.rejects(endpointForSession(id, 'base', 'own'), /memory|памят/i)
    const capacity = await competitionRunner().capacity()
    const background = reserveWork({ id: 'race-preparation', kind: 'preparation', memoryMb: 4000, diskBytes: 0 }, { availableMemoryMb: capacity.availableMb })
    background?.(); assert.equal(background, null, 'background admission must see the in-flight room')
    docker.containers.set(`colloq-room-${id}`, 5000)
    finish.resolve({ code: 0, out: 'created' }); await first
    assert.equal((await machineResources({ fresh: true })).memory.availableMb, 3192, 'stable census replaces the temporary hold exactly once')
    assert.equal(workBudgetSnapshot().jobs, 0)
  } finally { finish.resolve({ code: 1, out: 'injected launch failure' }); await first.catch(() => {}); await docker.restore() }
})

test('room and own positive resize honor background promises and failed launch releases its hold', async () => {
  const docker = fakeDocker(), id = room('admission-resize', 1024)
  docker.containers.set(`colloq-room-${id}`, 1024); docker.containers.set(`colloq-room-${id}-own`, 1024)
  const release = reserveWork({ id: 'resize-background', kind: 'preparation', memoryMb: 5000, diskBytes: 0 }, {})!
  try {
    setSessionMemoryMb(id, 4096)
    assert.equal(await applyMemoryLimit(id, 4096), 'failed')
    setRules(id, { ...storedRules(id), ownMemoryMb: 4096 })
    assert.equal(await applyOwnLimits(id), 'failed')
    assert.equal(docker.calls.filter(args => args[0] === 'update').length, 0)
    release()
    const bad = room('admission-failed', 2048)
    docker.intercept(args => args[0] === 'run' ? Promise.resolve({ code: 1, out: 'injected launch failure' }) : undefined)
    await assert.rejects(endpointForSession(bad, 'base'), /injected launch failure/)
    assert.equal(workBudgetSnapshot().jobs, 0)
    assert.equal((await machineResources({ fresh: true })).memory.availableMb, 6144)
  } finally { release(); await docker.restore() }
})

test('successful startup stays reserved until a delayed census observes it, and deletion releases the promise', async () => {
  const docker = fakeDocker(), id = room('admission-delayed', 5000)
  let visible = false
  docker.intercept(args => args[0] === 'ps' && !visible ? Promise.resolve({ code: 0, out: '' }) : undefined)
  try {
    await endpointForSession(id, 'base')
    assert.equal(workBudgetSnapshot().byKind.kernel, 1)
    assert.equal((await machineResources({ fresh: true })).memory.availableMb, 3192)
    visible = true
    assert.equal((await machineResources({ fresh: true })).memory.availableMb, 3192)
    assert.equal(workBudgetSnapshot().jobs, 0, 'census has replaced the temporary promise')
    await dropRoomKernel(id)
    assert.equal((await machineResources()).memory.availableMb, 8192)

    const unseen = room('admission-unseen-delete', 5000); visible = false
    await endpointForSession(unseen, 'base')
    assert.equal(workBudgetSnapshot().byKind.kernel, 1)
    await dropRoomKernel(unseen)
    assert.equal(workBudgetSnapshot().jobs, 0)
    assert.equal((await machineResources()).memory.availableMb, 8192)
  } finally { await docker.restore() }
})

test('concurrent positive resizes and background starts share the unobserved growth budget', async () => {
  const docker = fakeDocker(), entered = deferred<void>(), finish = deferred<Reply>()
  const a = room('admission-resize-a', 1024), b = room('admission-resize-b', 1024)
  docker.containers.set(`colloq-room-${a}`, 1024); docker.containers.set(`colloq-room-${b}`, 1024)
  docker.intercept(args => { if (args[0] === 'update' && args.at(-1) === `colloq-room-${a}`) { entered.resolve(); return finish.promise } })
  const first = applyMemoryLimit(a, 5000)
  try {
    await entered.promise
    assert.equal(await applyMemoryLimit(b, 5000), 'failed')
    const capacity = await competitionRunner().capacity()
    const background = reserveWork({ id: 'resize-race-competition', kind: 'competition', memoryMb: 3000, diskBytes: 0 }, { availableMemoryMb: capacity.availableMb })
    background?.(); assert.equal(background, null)
    docker.containers.set(`colloq-room-${a}`, 5000)
    finish.resolve({ code: 0, out: '' }); assert.equal(await first, 'applied')
    assert.equal((await machineResources({ fresh: true })).memory.availableMb, 2168)
    assert.equal(workBudgetSnapshot().jobs, 0)
    docker.intercept(undefined)
    const busy = reserveWork({ id: 'shrink-background', kind: 'preparation', memoryMb: 2168, diskBytes: 0 }, {})!
    try { assert.equal(await applyMemoryLimit(a, 1024), 'applied', 'shrinking memory does not need spare capacity') } finally { busy() }
  } finally { finish.resolve({ code: 1, out: 'injected resize failure' }); await first; await docker.restore() }
})

test('an unavailable allocation census cannot admit more Docker memory', async () => {
  const docker = fakeDocker(), existing = room('admission-census-existing', 7000)
  docker.containers.set(`colloq-room-${existing}`, 7000)
  docker.intercept(args => args[0] === 'ps' ? Promise.resolve({ code: 1, out: 'daemon census unavailable' }) : undefined)
  try {
    await assert.rejects(endpointForSession(room('admission-census-new', 2048), 'base'), /memory|памят/i)
    assert.equal(await applyMemoryLimit(existing, 8192), 'failed', 'an unknown live container cannot be treated as stopped for resize')
  }
  finally { await docker.restore() }
})

test('a successful Docker launch that exits before its first running census releases admission and can restart', async () => {
  const docker = fakeDocker()
  try {
    for (const role of ['room', 'own'] as const) {
      const id = room(`admission-exits-${role}`, 4096)
      const name = `colloq-room-${id}${role === 'own' ? '-own' : ''}`
      docker.intercept(args => {
        if (args[0] !== 'run' || !args.includes('--name')) return undefined
        docker.containers.set(name, 4096); docker.stopped.add(name)
        return Promise.resolve({ code: 0, out: name })
      })
      // Reject readiness so the public launch fails, without waiting 90 seconds.
      globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch
      await assert.rejects(endpointForSession(id, 'base', role))
      assert.equal(workBudgetSnapshot().byKind.kernel, 0, 'a confirmed exited container must not keep its successful-start promise')
      assert.equal((await machineResources({ fresh: true })).memory.availableMb, 8192)
      docker.intercept(undefined)
      globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
      await endpointForSession(id, 'base', role)
      assert.equal(docker.stopped.has(name), false, 'the same slot can start again')
      assert.equal((await machineResources({ fresh: true })).memory.availableMb, 4096)
      assert.equal(workBudgetSnapshot().jobs, 0)
      await dropRoomKernel(id)
    }
  } finally { await docker.restore() }
})

test('a stopped census begun before Docker start completes cannot release its new reservation', async () => {
  const docker = fakeDocker(), id = room('admission-old-stopped', 5000), name = `colloq-room-${id}`
  docker.containers.set(name, 5000); docker.stopped.add(name)
  const starting = deferred<void>(), finishStart = deferred<Reply>(), scanning = deferred<void>(), finishCensus = deferred<Reply>()
  let delayCensus = false
  docker.intercept(args => {
    if (args[0] === 'start') { starting.resolve(); return finishStart.promise }
    if (args[0] === 'ps' && delayCensus) { scanning.resolve(); return finishCensus.promise }
    return undefined
  })
  const launch = endpointForSession(id, 'base'); void launch.catch(() => {})
  try {
    await starting.promise
    delayCensus = true
    const oldCensus = machineResources({ fresh: true })
    await scanning.promise
    docker.stopped.delete(name)
    finishStart.resolve({ code: 0, out: name })
    // Let the start callback finish and join the outstanding resource census.
    await new Promise<void>(resolve => setImmediate(resolve))
    finishCensus.resolve({ code: 0, out: `${id}\t\texited\troom` })
    await Promise.all([oldCensus, launch])
    assert.equal(workBudgetSnapshot().byKind.kernel, 1, 'the old stopped row is not evidence that the new process exited')
    assert.equal((await machineResources()).memory.availableMb, 3192)
    delayCensus = false
    assert.equal((await machineResources({ fresh: true })).memory.availableMb, 3192)
    assert.equal(workBudgetSnapshot().jobs, 0)
  } finally {
    delayCensus = false; finishStart.resolve({ code: 1, out: 'injected failure' }); finishCensus.resolve({ code: 0, out: '' })
    await launch.catch(() => {}); await docker.restore()
  }
})
