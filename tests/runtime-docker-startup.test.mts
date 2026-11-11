import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { fakeDocker } from './_fake-docker.mts'
import { createSession } from '../server/src/db.js'
import { endpointForSession, dropOwnKernel, dropRoomKernel } from '../server/src/kernel/pool.js'
import { forgetResources, useDockerInfo } from '../server/src/kernel/resources.js'
import { pauseKernelStarts } from '../server/src/kernel/retirement.js'
import { setLocaleResolver } from '../shared/i18n.js'

async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('did not reach the controlled Docker boundary')
}
for (const role of ['room', 'own'] as const) test(`owner stop waits for delayed ${role} creation and refuses its endpoint`, async () => {
  const id = `runtime-stop-${role}`
  createSession(id, id)
  const docker = fakeDocker()
  const spawn = cp.spawn, fetchBefore = globalThis.fetch
  let child: any, release: (() => void) | undefined
  let fetched = 0, stopped = false
  useDockerInfo(async () => ({ code: 0, out: `${32768 * 1024 ** 2} 8` }))
  forgetResources()
  cp.spawn = ((command: string, args: string[], options: any) => {
    if (command !== 'docker' || args[0] !== 'run' || !args.includes('--name')) return spawn(command, args, options)
    child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    return child
  }) as typeof cp.spawn
  syncBuiltinESMExports()
  globalThis.fetch = (async () => { fetched++; return new Response('{}') }) as typeof fetch
  try {
    const pending = endpointForSession(id, 'base', role)
    const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }))
    await until(() => !!child)
    release = pauseKernelStarts(id, role === 'room' ? ['room', 'own'] : ['own'])
    const stop = (role === 'room' ? dropRoomKernel(id, false, { owner: true }) : dropOwnKernel(id, { owner: true })).then(() => { stopped = true })
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false, 'stop cannot claim memory is free while create is outstanding')
    docker.add(id, role)
    child.stdout.emit('data', Buffer.from('created')); child.emit('close', 0)
    await stop
    const result = await outcome
    assert.ok(result.error, 'a canceled start never publishes an endpoint')
    assert.equal(result.value, null)
    assert.equal(fetched, 0, 'cancellation is checked immediately after create, before readiness')
    assert.equal(docker.containers.size, 0, 'stop waits for confirmed final removal')
  } finally {
    child?.emit('close', 1)
    release?.(); globalThis.fetch = fetchBefore; docker.restore(); useDockerInfo(null); forgetResources()
  }
})
for (const oom of [false, true]) test(`failed Jupyter startup reports bounded sanitized ${oom ? 'OOM' : 'exit'} diagnostics promptly`, async (t) => {
  setLocaleResolver(() => 'en')
  const id = `runtime-start-${oom}`
  createSession(id, id)
  const docker = fakeDocker(), fetchBefore = globalThis.fetch
  let created = false, token = '', polls = 0, logs = 0
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  useDockerInfo(async () => ({ code: 0, out: `${32768 * 1024 ** 2} 8` }))
  forgetResources()
  docker.intercept = args => {
    if (args[0] === 'run' && args.includes('--name')) {
      created = true
      token = args.find(arg => arg.startsWith('JUPYTER_TOKEN='))!.slice('JUPYTER_TOKEN='.length)
    }
    if (created && args[0] === 'inspect' && args.at(-1)!.includes('State')) return {
      code: 0, out: JSON.stringify({ Status: 'exited', Running: false, ExitCode: oom ? 137 : 1, OOMKilled: oom, Error: `token=${token}` }),
    }
    if (args[0] === 'logs') {
      logs++
      assert.ok(args.includes('--tail'), 'Docker logs requests only the tail')
      return { code: 0, out: 'x'.repeat(500000) + `\nJUPYTER_TOKEN=${token}\nhttp://kernel/?token=other-secret\nAuthorization: Bearer third-secret\nOSError: [Errno 28] No space left on device\n` }
    }
  }
  globalThis.fetch = (async () => { polls++; t.mock.timers.tick(30000); throw new TypeError('fetch failed') }) as typeof fetch
  try {
    const started = Date.now()
    await assert.rejects(endpointForSession(id, 'base'), (error: Error) => {
      assert.match(error.message, oom ? /out of memory/i : /exit.*1/i)
      assert.match(error.message, /No space left on device/)
      assert.ok(error.message.length <= 5000, 'log output cannot bloat the error')
      assert.ok(!error.message.includes(token), 'the actual deterministic room token is removed')
      assert.doesNotMatch(error.message, /other-secret|third-secret/)
      return true
    })
    assert.equal(polls, 1, 'an exited container is not polled for the full 90 seconds')
    assert.equal(logs, 1)
    assert.ok(Date.now() - started < 90000)
  } finally { globalThis.fetch = fetchBefore; docker.restore(); useDockerInfo(null); forgetResources() }
})
test('native-host startup explains an exited container before its port is published', async () => {
  setLocaleResolver(() => 'en')
  const id = 'runtime-start-native-exit'
  createSession(id, id)
  const docker = fakeDocker(), exists = fs.existsSync, fetchBefore = globalThis.fetch
  let created = false, logs = 0, polls = 0
  fs.existsSync = ((file) => file === '/.dockerenv' ? false : exists(file)) as typeof fs.existsSync
  syncBuiltinESMExports()
  useDockerInfo(async () => ({ code: 0, out: `${32768 * 1024 ** 2} 8` }))
  forgetResources()
  docker.intercept = args => {
    if (args[0] === 'run' && args.includes('--name')) created = true
    if (args[0] === 'port') return { code: 1, out: 'No public port 8888/tcp published' }
    if (created && args[0] === 'inspect' && args.at(-1)!.includes('State')) return {
      code: 0, out: JSON.stringify({ Status: 'exited', ExitCode: 1, OOMKilled: false }),
    }
    if (args[0] === 'logs') { logs++; return { code: 0, out: 'OSError: [Errno 28] No space left on device' } }
  }
  globalThis.fetch = (async () => { polls++; throw new TypeError('fetch failed') }) as typeof fetch
  try {
    await assert.rejects(endpointForSession(id, 'base'), /exit.*1[\s\S]*No space left on device/i)
    assert.equal(logs, 1)
    assert.equal(polls, 0, 'the failed container never had a published endpoint')
  } finally { globalThis.fetch = fetchBefore; docker.restore(); useDockerInfo(null); forgetResources() }
})
test('ordinary room deletion remains prompt and a late create cleans up without returning an endpoint', async () => {
  const id = 'runtime-delete-delayed'
  createSession(id, id)
  const docker = fakeDocker(), spawn = cp.spawn, fetchBefore = globalThis.fetch
  let child: any, polls = 0
  useDockerInfo(async () => ({ code: 0, out: `${32768 * 1024 ** 2} 8` }))
  forgetResources()
  cp.spawn = ((command: string, args: string[], options: any) => {
    if (command !== 'docker' || args[0] !== 'run' || !args.includes('--name')) return spawn(command, args, options)
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    return child
  }) as typeof cp.spawn
  syncBuiltinESMExports()
  globalThis.fetch = (async () => { polls++; return new Response('{}') }) as typeof fetch
  try {
    const pending = endpointForSession(id, 'base').then(() => null, error => error)
    await until(() => !!child)
    await dropRoomKernel(id)
    docker.add(id)
    child.emit('close', 0)
    assert.ok(await pending, 'a deleted start is refused even without an owner pause gate')
    assert.equal(polls, 0)
    assert.equal(docker.containers.size, 0)
  } finally { child?.emit('close', 1); globalThis.fetch = fetchBefore; docker.restore(); useDockerInfo(null); forgetResources() }
})
test('owner stop reports failed final removal instead of claiming success', async () => {
  const id = 'runtime-stop-refused'
  createSession(id, id)
  const docker = fakeDocker()
  docker.add(id)
  docker.intercept = args => args[0] === 'rm' ? { code: 1, out: 'daemon could not remove container' } : undefined
  const release = pauseKernelStarts(id, ['room', 'own'])
  try {
    await assert.rejects(dropRoomKernel(id, false, { owner: true }), /daemon could not remove container/)
    assert.equal(docker.containers.size, 1)
  } finally { release(); docker.restore() }
})
test('cancellation during readiness is checked before an endpoint is cached', async () => {
  const id = 'runtime-stop-ready'
  createSession(id, id)
  const docker = fakeDocker(), fetchBefore = globalThis.fetch
  let ready: (() => void) | undefined, release: (() => void) | undefined
  useDockerInfo(async () => ({ code: 0, out: `${32768 * 1024 ** 2} 8` }))
  forgetResources()
  globalThis.fetch = (async () => {
    await new Promise<void>(resolve => { ready = resolve })
    return new Response('{}')
  }) as typeof fetch
  try {
    const pending = endpointForSession(id, 'base').then(() => null, error => error)
    await until(() => !!ready)
    release = pauseKernelStarts(id, ['room', 'own'])
    const stop = dropRoomKernel(id, false, { owner: true })
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
    release(); release = undefined
    ready!()
    assert.ok(await pending, 'the cancellation survives the temporary gate being released')
    await stop
    assert.equal(docker.containers.size, 0)
    globalThis.fetch = (async () => new Response('{}')) as typeof fetch
    await endpointForSession(id, 'base')
    assert.equal(docker.containers.size, 1, 'the next genuine start recreates rather than returns a stale cached endpoint')
    await dropRoomKernel(id)
  } finally { ready?.(); release?.(); globalThis.fetch = fetchBefore; docker.restore(); useDockerInfo(null); forgetResources() }
})
test('cancellation while memory admission waits never dispatches Docker create', async () => {
  const id = 'runtime-stop-admission'
  createSession(id, id)
  const docker = fakeDocker()
  let admit: (() => void) | undefined, creates = 0, release: (() => void) | undefined
  useDockerInfo(async () => {
    await new Promise<void>(resolve => { admit = resolve })
    return { code: 0, out: `${32768 * 1024 ** 2} 8` }
  })
  forgetResources()
  docker.intercept = args => { if (args[0] === 'run' && args.includes('--name')) creates++ }
  try {
    const pending = endpointForSession(id, 'base').then(() => null, error => error)
    await until(() => !!admit)
    release = pauseKernelStarts(id, ['room', 'own'])
    const stop = dropRoomKernel(id, false, { owner: true })
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
    // Only the first census is delayed; cleanup has to be able to read it too.
    useDockerInfo(async () => ({ code: 0, out: `${32768 * 1024 ** 2} 8` }))
    admit!()
    assert.ok(await pending)
    await stop
    assert.equal(creates, 0, 'a canceled, not-yet-issued create should never reach Docker')
    assert.equal(docker.containers.size, 0)
  } finally { admit?.(); release?.(); docker.restore(); useDockerInfo(null); forgetResources() }
})
test('overlapping owner stops do not leave a cancellation mark on the next start', async () => {
  const id = 'runtime-stop-overlap'
  createSession(id, id)
  const docker = fakeDocker(), fetchBefore = globalThis.fetch, spawn = cp.spawn
  let ready: (() => void) | undefined, rmChild: any, heldRemoval = false
  let release: (() => void) | undefined
  useDockerInfo(async () => ({ code: 0, out: `${32768 * 1024 ** 2} 8` }))
  forgetResources()
  cp.spawn = ((command: string, args: string[], options: any) => {
    if (command !== 'docker' || args[0] !== 'rm' || heldRemoval) return spawn(command, args, options)
    heldRemoval = true
    rmChild = new EventEmitter(); rmChild.stdout = new PassThrough(); rmChild.stderr = new PassThrough(); rmChild.kill = () => true
    return rmChild
  }) as typeof cp.spawn
  syncBuiltinESMExports()
  globalThis.fetch = (async () => {
    await new Promise<void>(resolve => { ready = resolve })
    return new Response('{}')
  }) as typeof fetch
  try {
    const pending = endpointForSession(id, 'base').then(() => null, error => error)
    await until(() => !!ready)
    release = pauseKernelStarts(id, ['room', 'own'])
    const first = dropRoomKernel(id, false, { owner: true })
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
    ready!()
    await until(() => !!rmChild)
    const second = dropRoomKernel(id, false, { owner: true })
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
    docker.containers.clear()
    rmChild.emit('close', 0)
    assert.ok(await pending)
    await Promise.all([first, second])
    release(); release = undefined
    globalThis.fetch = (async () => new Response('{}')) as typeof fetch
    await endpointForSession(id, 'base')
    assert.equal(docker.containers.size, 1, 'an old overlapping stop must not remove the next legitimate container')
    await dropRoomKernel(id)
  } finally { ready?.(); rmChild?.emit('close', 1); release?.(); globalThis.fetch = fetchBefore; docker.restore(); useDockerInfo(null); forgetResources() }
})
