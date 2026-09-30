/**
 * COLLOQ_ROOM_NETWORK=none through the room start itself (kernel/pool.ts with
 * kernel/perimeter.ts), with a docker that only answers.
 *
 * The rules follow the rooms subnet, so they reach every container at once.
 * The resolver setting that closes the daemon's own DNS road is a `docker run`
 * flag, so it needs the container itself: a stopped container from the other
 * setting is recreated, a live one keeps its variables until it stops. And
 * with the server in a container, the privileged helper runs from the
 * server's own image, never from the room's.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { createSession } from '../server/src/db.js'
import { dropRoomKernel, endpointForSession } from '../server/src/kernel/pool.js'
import { forgetPerimeter } from '../server/src/kernel/perimeter.js'
import { forgetResources, useDockerInfo } from '../server/src/kernel/resources.js'

const SERVER_IMAGE = `sha256:${'9'.repeat(64)}`
type Reply = { code: number; out: string }

/** The server in a container on `room-net`, one room container with the given state and profile label. */
function fakeDocker(container: { name: string; state: 'exited' | 'running'; profile: string }) {
  const old = { ...process.env }, oldSpawn = cp.spawn, oldFetch = globalThis.fetch, exists = fs.existsSync
  Object.assign(process.env, { KERNEL_BACKEND: 'docker', KERNEL_ISOLATION: 'required', KERNEL_NETWORK: 'room-net', COLLOQ_ROOM_NETWORK: 'none', COLLOQ_CONTAINER: 'colloq-app' })
  fs.existsSync = ((p: any) => p === '/.dockerenv' || exists(p)) as typeof fs.existsSync
  const live = new Map([[container.name, { ...container }]])
  const calls: string[][] = []
  const answer = (args: string[]): Reply => {
    calls.push(args)
    if (args[0] === 'network') return { code: 0, out: args.at(-1)!.includes('Subnet') ? '10.213.0.0/22' : 'ready' }
    if (args[0] === 'version' || args[0] === 'image') return { code: 0, out: 'ready' }
    if (args[0] === 'ps') return { code: 0, out: '' }
    if (args[0] === 'inspect' && args[1] === '--type') {
      return args.at(-1) === 'colloq-app' ? { code: 0, out: SERVER_IMAGE } : { code: 1, out: 'No such container' }
    }
    if (args[0] === 'inspect') {
      const found = live.get(args[1]!)
      if (!found) return { code: 1, out: 'No such container' }
      const format = args.at(-1)!
      if (format.includes('HostConfig.Memory')) return { code: 0, out: `${4096 * 1024 ** 2} 2000000000` }
      if (format.includes('State')) return { code: 0, out: found.state }
      if (format.includes('.Image')) return { code: 0, out: 'ready' }
      if (format.includes('profile')) return { code: 0, out: found.profile }
      if (format.includes('NetworkMode')) return { code: 0, out: 'room-net' }
      return { code: 0, out: '' }
    }
    if (args[0] === 'run') {
      if (args.includes('--privileged')) return { code: 0, out: 'colloq-perimeter: ok' }
      const name = args[args.indexOf('--name') + 1]!
      const label = args.find((arg) => arg.startsWith('colloq.profile='))!
      live.set(name, { name, state: 'running', profile: label.slice('colloq.profile='.length) })
      return { code: 0, out: name }
    }
    if (args[0] === 'start') { live.get(args[1]!)!.state = 'running'; return { code: 0, out: args[1]! } }
    if (args[0] === 'rm') { live.delete(args.at(-1)!); return { code: 0, out: '' } }
    if (args[0] === 'update') return { code: 0, out: '' }
    throw new Error(`Unexpected docker: ${args.join(' ')}`)
  }
  cp.spawn = ((command: string, args: string[]) => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    const result = command === 'docker' ? answer(args) : { code: 1, out: '' }
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(result.out)); child.emit('close', result.code) })
    return child
  }) as typeof cp.spawn
  syncBuiltinESMExports()
  // Jupyter inside the room answers at once.
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
  useDockerInfo(async () => ({ code: 0, out: `${16384 * 1024 ** 2} 8` })); forgetResources(); forgetPerimeter()
  return { calls, live, async restore(id: string) {
    await dropRoomKernel(id).catch(() => {})
    cp.spawn = oldSpawn; globalThis.fetch = oldFetch; fs.existsSync = exists; syncBuiltinESMExports()
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
    Object.assign(process.env, old); useDockerInfo(null); forgetResources(); forgetPerimeter()
  } }
}

test('a stopped container from the previous setting is recreated with the blackhole resolver; the helper runs from the server image', async () => {
  const id = 'netchange-stopped'
  createSession(id, id)
  const docker = fakeDocker({ name: `colloq-room-${id}`, state: 'exited', profile: '1' })
  try {
    await endpointForSession(id, 'base')
    const removed = docker.calls.findIndex((args) => args[0] === 'rm' && args.at(-1) === `colloq-room-${id}`)
    assert.ok(removed >= 0, 'the old container was started as it was')
    const created = docker.calls.find((args) => args[0] === 'run' && args.includes('--name'))!
    assert.ok(created.includes('--dns=192.0.2.1'), JSON.stringify(created))
    assert.ok(created.includes('colloq.profile=1-none'), JSON.stringify(created))
    // The block went up before the container, from the server's own image, with no DNS exception.
    const helper = docker.calls.find((args) => args[0] === 'run' && args.includes('--privileged'))!
    assert.equal(helper[helper.indexOf('--entrypoint=sh') + 1], SERVER_IMAGE)
    assert.ok(!/--dport 53/.test(helper.at(-1)!), 'none let DNS out')
    assert.match(helper.at(-1)!, /-A COLLOQ-ROOMS-FWD -s 10\.213\.0\.0\/22 -j COLLOQ-ROOMS-DENY/)
    assert.ok(docker.calls.indexOf(helper) < docker.calls.indexOf(created), 'the room ran before its block')
    assert.ok(!docker.calls.some((args) => args.includes('colloq-kernel:base') && args.includes('--privileged')))
  } finally { await docker.restore(id) }
})

test('a live container from the previous setting keeps its variables: it is not recreated, the rules already apply', async () => {
  const id = 'netchange-live'
  createSession(id, id)
  const docker = fakeDocker({ name: `colloq-room-${id}`, state: 'running', profile: '1' })
  try {
    await endpointForSession(id, 'base')
    assert.ok(!docker.calls.some((args) => args[0] === 'rm'), 'a live room lost its kernel')
    assert.ok(!docker.calls.some((args) => args[0] === 'run' && args.includes('--name')))
    assert.equal(docker.live.get(`colloq-room-${id}`)!.profile, '1')
  } finally { await docker.restore(id) }
})
