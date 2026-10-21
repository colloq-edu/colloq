/**
 * Classes on machines («занятия на машинах») end to end, without Docker
 * (docs/architecture/remote-classes.md §17.2): the home app of this process
 * with its tunnel door (tests/_remote-e2e-home.mts), machines' agents as
 * processes of their own (tests/_remote-e2e-agent.mts) on the fake docker
 * (tests/_remote-e2e-docker.mjs), whose class containers are fake Jupyters
 * (tests/_fake-jupyter.mjs), and a fault proxy between them
 * (tests/_tunnel-fault.mts) where relay2 stands.
 *
 * THE HARNESS. The scenarios of §17.2 run in files of their own on it:
 * classes-e2e-a (A.1–A.3), classes-e2e-b (B.4–B.8) and classes-e2e-d
 * (D.14–D.24). What runs here proves the pieces those scenarios stand on,
 * each against the real thing it stands in for: the
 * proxy's faults on plain sockets and on the agent's own requests, the fake
 * docker's class containers under home's argv and under the agent's real
 * kernel host (kernels.ts) — every docker question it asks, answered — the
 * fake Jupyter's sessions, reports and knobs, its process's end with its
 * container and with the test, and a cell run from home's kernel client
 * through home's tunnel door, the proxy and an agent's tunnel end into a
 * class container's Jupyter, the home's own clock, probe, hooks and images.
 * Nothing here waits on a production timeout: the clocks that matter are
 * moved by hand (the proxy's, the home's), and what is waited for is an event
 * (a socket's close, a process's exit, a state).
 */
import './_remote-e2e-home.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { JupyterKernel, jupyterSessionPath, type ExecuteHandlers } from '../server/src/kernel/jupyter.js'
import { kernelMachineOf, onKernelMachineChange } from '../server/src/kernel/index.js'
import { writePlacement } from '../server/src/kernel/remote/placement-store.js'
import { captureRevision } from '../server/src/dependencies/revisions.js'
import { CELLS_KEY } from '../shared/notebook.js'
import { GUARD_REPORT_EXPR } from '../server/src/kernel/danger.js'
import { INSPECT_REPORT_EXPR } from '../server/src/kernel/inspect-static.js'
import { COUNCIL_REPORT_EXPR } from '../server/src/kernel/council-isolation.js'
import { classHashSeed, machineRoomRunArgs, type MachineRoomSpec } from '../server/src/kernel/room-spec.js'
import { machinePerimeter, networkCreateArgs, profileFor } from '../server/src/kernel/perimeter-core.js'
import { parseCgroup, parseReading, readingArgs } from '../server/src/kernel/postmortem-core.js'
import { KernelHost, MACHINE_ROOM_SUBNET } from '../server/src/runner-agent/kernels.js'
import { revisionImage } from '../server/src/runner-agent/images.js'
import { stateLayout } from '../server/src/runner-agent/state.js'
import { AgentTunnel } from '../server/src/runner-agent/tunnel.js'
import { classPlacements } from '../server/src/kernel/remote/placement.js'
import { heardAddress } from '../server/src/competitions/remote/heard.js'
import { getRunner, joinRunner, mintRemoteCode } from '../server/src/competitions/remote/store.js'
import { remotePlacementKey, remoteRevisionDigest, type RemoteKernelsReply, type RemotePlacementIntent } from '../shared/remote-kernels.js'
import { REMOTE_MARKER, REMOTE_MARKER_HEADER, type RemoteFacts } from '../shared/remote-runner.js'
import { TUNNEL_DEAD_MS, tunnelUrl, type TunnelClock } from '../shared/remote-tunnel.js'
import { startFakeJupyter } from './_fake-jupyter.mjs'
import { guardAnswer } from './_guard.mts'
import { Agent, RUNNER_IMAGE, createFleet, killAgents, removeClassContainers, type Fleet } from './_remote-e2e-agent.mts'
import { Home, HomeClock, NO_DOCKER, kernelRevision, until } from './_remote-e2e-home.mts'
import { TunnelFault } from './_tunnel-fault.mts'

const home = new Home({ liveness: 'manual' })
let fleet: Fleet
const proxies = new Set<TunnelFault>()

before(async () => {
  fleet = createFleet()
  await home.start()
})

after(async () => {
  for (const proxy of proxies) await proxy.close()
  await killAgents()
  await removeClassContainers()
  await home.close()
})

/* ---------------------------------------------------------------- helpers */

/** A clock of the test's own: its timers run when it is moved, the earliest first, and never by themselves. */
class ManualClock implements TunnelClock {
  t = 1_000_000
  private seq = 0
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  now = (): number => this.t
  setTimeout = (run: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + Math.max(0, ms), run })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let next: [number, { at: number; run: () => void }] | null = null
      for (const entry of this.timers) if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) next = entry
      if (next === null) break
      this.timers.delete(next[0])
      this.t = Math.max(this.t, next[1].at)
      next[1].run()
    }
    this.t = end
  }
}

/** A TCP end on 127.0.0.1 for the proxy to stand before: every connection it took, what came on each, which closed. */
async function tcpEnd(): Promise<{ port: number; sockets: net.Socket[]; text(socket: net.Socket): string; bytes(socket: net.Socket): number; closed: Set<net.Socket>; close(): Promise<void> }> {
  const sockets: net.Socket[] = []
  const received = new Map<net.Socket, Buffer[]>()
  const counted = new Map<net.Socket, number>()
  const closed = new Set<net.Socket>()
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket)
    received.set(socket, [])
    counted.set(socket, 0)
    socket.on('data', (chunk: Buffer) => {
      received.get(socket)!.push(chunk)
      counted.set(socket, counted.get(socket)! + chunk.length)
    })
    socket.on('error', () => undefined)
    socket.on('close', () => closed.add(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    sockets,
    text: (socket) => Buffer.concat(received.get(socket) ?? []).toString('latin1'),
    bytes: (socket) => counted.get(socket) ?? 0,
    closed,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** A client of the proxy: what it received, whether it closed, and the error it closed with. */
async function tcpClient(port: number): Promise<{ socket: net.Socket; text(): string; closed(): boolean; error(): string | null }> {
  const socket = net.connect(port, '127.0.0.1')
  const chunks: Buffer[] = []
  let ended = false
  let failed: string | null = null
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  socket.on('error', (error: NodeJS.ErrnoException) => (failed = error.code ?? error.message))
  socket.on('close', () => (ended = true))
  await new Promise<void>((resolve) => {
    socket.once('connect', resolve)
    socket.once('close', resolve)
  })
  return { socket, text: () => Buffer.concat(chunks).toString('latin1'), closed: () => ended, error: () => failed }
}

/** A connection through the proxy to the TCP end, its first bytes across: the agent's side and home's. */
async function through(proxy: TunnelFault, end: Awaited<ReturnType<typeof tcpEnd>>): Promise<{ client: Awaited<ReturnType<typeof tcpClient>>; far: net.Socket }> {
  const client = await tcpClient(proxy.port)
  const known = end.sockets.length
  client.socket.write('hi')
  const far = await until('the connection to reach home', () => end.sockets[known])
  await until('its bytes', () => end.text(far) === 'hi')
  return { client, far }
}

/** What a machine says of itself when it joins (shared/remote-runner.ts · RemoteFacts). */
const FACTS: RemoteFacts = { version: '0.25.0', hostname: 'classes-e2e', platform: 'linux/amd64', cpus: 16, memoryMb: 65_536, diskMb: 200_000, docker: '28.3.1', storage: 'overlay2', driver: null }

/** A machine enrolled straight in the store, with no agent behind it: one that stands, for what asks whether any does. */
function enrolled(): string {
  const minted = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, createdBy: 'classes-e2e' })
  const joined = joinRunner({ code: minted.code, joinId: randomBytes(16).toString('hex'), build: 'dev', facts: FACTS, address: null }, Date.now())
  assert.ok(joined.ok)
  return joined.runner.id
}

async function proxyFor(port: number, options: { forwardedFor?: string; clock?: TunnelClock } = {}): Promise<TunnelFault> {
  const proxy = await TunnelFault.start({ target: port, ...options })
  proxies.add(proxy)
  return proxy
}

/** Let the event loop turn: what would happen at once, has. */
async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve))
}

function handlers(seen: string[] = [], errors: Array<[string, string]> = []): ExecuteHandlers {
  return {
    onExecuteInput: () => {},
    onStream: (_name, text) => seen.push(text),
    onData: () => {},
    onError: (ename, evalue) => errors.push([ename, evalue]),
    onClear: () => {},
  }
}

/** One cell through a kernel client: its printed lines and its errors. */
async function cell(kernel: JupyterKernel, code: string): Promise<{ status: string; seen: string[]; errors: Array<[string, string]> }> {
  const seen: string[] = []
  const errors: Array<[string, string]> = []
  const status = await kernel.execute(code, handlers(seen, errors))
  return { status, seen, errors }
}

/** A silent service run's report, key `colloq`: what the guard, the help and the council read. */
async function report(kernel: JupyterKernel, code: string, expression: string): Promise<{ status?: string; data?: Record<string, string>; ename?: string } | undefined> {
  let raw: unknown
  await kernel.execute(code, { ...handlers(), onUserExpressions: (values) => (raw = values.colloq) }, { silent: true, storeHistory: false, userExpressions: { colloq: expression } })
  return raw as { status?: string; data?: Record<string, string>; ename?: string } | undefined
}

/** A machine's tree and fake docker, its agent not started: what a test drives itself. */
let machines = 0
function machine(options: { classes?: boolean; join?: string } = {}): Agent {
  machines += 1
  return new Agent(fleet, `m${machines}-${randomBytes(2).toString('hex')}`, { join: options.join ?? `http://127.0.0.1:9#${'0'.repeat(32)}`, classes: options.classes ?? true })
}

/** A class revision on a machine: in the fleet's registry, pulled there and tagged as the agent's images tag it (images.ts · revisionImage). */
async function revisionOn(agent: Agent): Promise<ReturnType<typeof kernelRevision>> {
  const kernel = kernelRevision(fleet)
  for (const argv of [['pull', kernel.registryRef], ['tag', kernel.registryRef, revisionImage(kernel.revisionId)]]) {
    const done = await agent.docker(argv)
    assert.equal(done.code, 0, `docker ${argv.join(' ')}: ${done.out}`)
  }
  return kernel
}

/** The spec of a class container as the agent lays it out (kernels.ts · start), for a slot of `sessionId`. */
function spec(agent: Agent, sessionId: string, role: MachineRoomSpec['role'], image: string, token: string): MachineRoomSpec {
  return {
    role, sessionId, environment: 'base', image, mount: path.join(agent.root, 'rooms', sessionId), extraMounts: [], gpu: null,
    memoryMb: 2048, cpus: 2, pids: 512, mode: 'blocked', profile: profileFor('blocked'), token, hashSeed: classHashSeed(sessionId), shm: '1g',
  }
}

/** Whether a process runs, by its pid. */
function alive(pid: number | null): boolean {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const token = (): string => randomBytes(20).toString('hex')
const classId = (): string => `cls${randomBytes(4).toString('hex')}`

/* ---------------------------------------------- a manual home, from its start */

// First in the file: before any class machine's sync loads the class placements behind the classes' clock.
test('a manual home runs the classes\' clock from its start, and its probe proves the path through whatever stands before it', async () => {
  // The classes' pass of the clock runs at the first tick, no class machine having called yet (heard.ts · loadClassPort).
  const placements = home.placements!
  let ticks = 0
  const classTick = placements.classTick.bind(placements)
  placements.classTick = (now: number): void => {
    ticks++
    classTick(now)
  }
  try {
    home.tick()
  } finally {
    delete (placements as { classTick?: unknown }).classTick
  }
  assert.equal(ticks, 1, 'the class tick of the home\'s own placements ran')

  // The probe of the home's own path, which proves something only while a machine stands, answers through the relay's
  // stand-in, and fails with the path.
  enrolled()
  assert.equal(await home.probe(), true, 'the home answers its own probe')
  const relay = await proxyFor(home.port)
  assert.equal(await home.probe(relay), true, 'through the fault proxy, where relay2 stands')
  const refused = relay.stats().refused
  relay.cut()
  assert.equal(await home.probe(relay), false, 'a cut path proves nothing')
  assert.ok(relay.stats().refused > refused, 'the probe went the way it was sent')
  relay.heal()
})

/* ------------------------------------------------------- the fault proxy */

test('the fault proxy passes bytes both ways, and black-holes, delays and throttles each direction on its own clock until healed', async () => {
  const end = await tcpEnd()
  const clock = new ManualClock()
  const proxy = await proxyFor(end.port, { clock })
  const client = await tcpClient(proxy.port)
  client.socket.write('hello')
  const far = await until('the connection to reach home', () => end.sockets[0])
  await until('the bytes up', () => end.text(far) === 'hello')
  far.write('world')
  await until('the bytes down', () => client.text() === 'world')

  // A black hole up holds the agent's bytes, not home's; healed, they arrive in order.
  proxy.blackhole({ direction: 'up' })
  client.socket.write('held')
  await until('the proxy to hold the bytes up', () => proxy.stats().held.up === 4)
  far.write('+down')
  await until('home\'s bytes to pass', () => client.text() === 'world+down')
  assert.equal(end.text(far), 'hello', 'nothing up crossed the black hole')
  proxy.heal({ direction: 'up' })
  await until('the held bytes to arrive', () => end.text(far) === 'helloheld')

  // The mirror: home's bytes held, the agent's through.
  proxy.blackhole({ direction: 'down' })
  far.write('+back')
  await until('the proxy to hold the bytes down', () => proxy.stats().held.down === 5)
  client.socket.write('+up')
  await until('the agent\'s bytes to pass', () => end.text(far) === 'helloheld+up')
  assert.equal(client.text(), 'world+down')
  proxy.heal()
  await until('the held bytes down to arrive', () => client.text() === 'world+down+back')

  // A delay, on the proxy's clock: not a millisecond early, and on time.
  proxy.delay(500, { direction: 'up' })
  client.socket.write('+late')
  await until('the late bytes in the proxy', () => proxy.stats().held.up === 5)
  clock.advance(499)
  await turns()
  assert.equal(end.text(far), 'helloheld+up', 'a delayed byte came early')
  clock.advance(1)
  await until('the late bytes to arrive', () => end.text(far) === 'helloheld+up+late')
  proxy.heal()

  // A throttle down at 16 KiB a second: 48 KiB take at least two more seconds of the clock after the first piece.
  proxy.throttle(16 * 1024, { direction: 'down' })
  const before = client.text().length
  far.write(Buffer.alloc(48 * 1024, 'x'))
  await until('the bytes in the proxy or through it', () => proxy.stats().held.down + (client.text().length - before) === 48 * 1024)
  await turns()
  assert.ok(client.text().length - before <= 16 * 1024, `the throttle let ${client.text().length - before} bytes through at once`)
  let seconds = 0
  while (client.text().length - before < 48 * 1024) {
    clock.advance(1000)
    seconds++
    await turns()
    assert.ok(seconds <= 10, 'the throttled bytes never all came')
  }
  assert.ok(seconds >= 2, `48 KiB at 16 KiB/s came in ${seconds} s of the clock`)
  proxy.heal()
  assert.deepEqual(proxy.stats().held, { up: 0, down: 0 })

  // A close in good order travels both ways, each side's end after its bytes, and the pair goes with the second.
  client.socket.end()
  far.end()
  await until('the connection to close in good order, and the pair with it', () => end.closed.has(far) && client.closed() && proxy.stats().live.http + proxy.stats().live.unknown === 0)
  await end.close()
})

test('a cut resets the side its direction reaches, turns new connections away while it lasts, and heals for new ones', async () => {
  const end = await tcpEnd()
  const proxy = await proxyFor(end.port)
  const open = (): ReturnType<typeof through> => through(proxy, end)

  // Both ways: both ends hear it at once, and a new connection is reset on arrival.
  const both = await open()
  proxy.cut()
  await until('the agent\'s side to close', () => both.client.closed())
  await until('home\'s side to close', () => end.closed.has(both.far))
  const turned = await tcpClient(proxy.port)
  await until('a new connection to be reset', () => turned.closed())
  assert.equal(proxy.stats().refused, 1)
  proxy.heal()
  const second = await open()

  // `up`: home's side is reset, the agent's left open and silent — a half-open connection the agent must time out.
  proxy.cut({ direction: 'up' })
  await until('home\'s side to close', () => end.closed.has(second.far))
  await turns()
  assert.equal(second.client.closed(), false, 'the agent heard a cut that only reached home')
  second.client.socket.write('into the void')
  const sockets = end.sockets.length
  const silent = await tcpClient(proxy.port)
  silent.socket.write('nobody hears this')
  await turns()
  assert.equal(end.sockets.length, sockets, 'a connection under a cut of `up` reached home')
  assert.equal(silent.closed(), false, 'a connection under a cut of `up` was told')
  second.client.socket.destroy()
  silent.socket.destroy()
  proxy.heal()

  // `down`: the agent's side is reset, home's left open and silent.
  const third = await open()
  proxy.cut({ direction: 'down' })
  await until('the agent\'s side to close', () => third.client.closed())
  await turns()
  assert.equal(end.closed.has(third.far), false, 'home heard a cut that only reached the agent')
  const refused = await tcpClient(proxy.port)
  await until('a new connection to be reset under a cut of `down`', () => refused.closed())
  third.far.destroy()
  proxy.heal()
  await until('every pair to go', () => proxy.stats().live.http + proxy.stats().live.unknown === 0)
  await end.close()
})

test('a black hole carries no close either: the other side stays open and silent, and the heal brings the bytes, then the end', async () => {
  const end = await tcpEnd()
  const proxy = await proxyFor(end.port)

  // Home ends its side with nothing after the last byte: the agent hears no FIN through a black hole, then hears it.
  const ended = await through(proxy, end)
  proxy.blackhole({ direction: 'down' })
  ended.far.end()
  await until('the end held', () => proxy.stats().closing.down === 1)
  await turns()
  assert.equal(ended.client.closed(), false, 'an end crossed the black hole')
  proxy.heal()
  await until('the end at the heal', () => ended.client.closed())
  assert.equal(ended.client.error(), null, 'a FIN, not a reset')

  // Home resets its side, both directions black-holed: the agent's side stays open until the heal, and is reset then.
  const reset = await through(proxy, end)
  proxy.blackhole()
  reset.far.resetAndDestroy()
  await until('the reset held', () => proxy.stats().closing.down === 1)
  await turns()
  assert.equal(reset.client.closed(), false, 'a reset crossed the black hole')
  proxy.heal()
  await until('the reset at the heal', () => reset.client.closed())
  assert.equal(reset.client.error(), 'ECONNRESET')

  // The mirror: the agent goes without a word, its direction black-holed, and home hears it only at the heal.
  const gone = await through(proxy, end)
  proxy.blackhole({ direction: 'up' })
  gone.client.socket.resetAndDestroy()
  await until('its reset held', () => proxy.stats().closing.up === 1)
  await turns()
  assert.equal(end.closed.has(gone.far), false, 'home heard a reset through the black hole')
  proxy.heal()
  await until('home to hear it at the heal', () => end.closed.has(gone.far))
  await until('every pair to go', () => proxy.stats().live.http + proxy.stats().live.unknown === 0)
  await end.close()
})

test('a delay holds bytes back, never their sender: a path\'s worth of them is on its way at once', async () => {
  const end = await tcpEnd()
  const clock = new ManualClock()
  const proxy = await proxyFor(end.port, { clock })
  const { client, far } = await through(proxy, end)
  proxy.delay(200, { direction: 'up' })
  const bulk = 4 * 1024 * 1024
  client.socket.write(Buffer.alloc(bulk, 'y'))
  // Every byte read from the agent before the clock moves: a sender paused at a black hole's buffer would stop at a sixteenth.
  await until('every byte on its way', () => proxy.stats().held.up === bulk)
  assert.equal(end.bytes(far), 2, 'a delayed byte came early')
  clock.advance(200)
  await until('every byte through', () => end.bytes(far) === 2 + bulk)
  client.socket.destroy()
  await end.close()
})

test('the fault proxy reads the agent\'s requests: X-Forwarded-For on every one, bodies untouched, and the tunnel told from the rest', { timeout: 20_000 }, async () => {
  const seen: Array<{ method: string; url: string; forwarded: string | undefined; body: string }> = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, forwarded: req.headers['x-forwarded-for'] as string | undefined, body })
      res.end('ok')
    })
  })
  const upgrades: string[] = []
  const upgraded: net.Socket[] = []
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    upgrades.push(`${req.url} ${req.headers['x-forwarded-for']}`)
    upgraded.push(socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    // An echo after the upgrade: the bytes of a tunnel, raw.
    socket.on('data', (chunk: Buffer) => socket.write(chunk))
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const proxy = await proxyFor((server.address() as net.AddressInfo).port, { forwardedFor: '198.51.100.7' })

  // Three requests on one kept-alive connection: a GET, a body by Content-Length, a chunked one.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const ask = (method: string, at: string, write?: (req: http.ClientRequest) => void): Promise<string> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method, path: at, agent }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (text += chunk))
      res.on('end', () => resolve(text))
    })
    req.on('error', reject)
    if (write) write(req)
    req.end()
  })
  assert.equal(await ask('GET', '/a'), 'ok')
  assert.equal(await ask('POST', '/b', (req) => {
    req.setHeader('content-length', 11)
    req.write('hello world')
  }), 'ok')
  assert.equal(await ask('POST', '/c', (req) => {
    req.write('chunk one, ')
    req.write('chunk two')
  }), 'ok')
  assert.deepEqual(seen, [
    { method: 'GET', url: '/a', forwarded: '198.51.100.7', body: '' },
    { method: 'POST', url: '/b', forwarded: '198.51.100.7', body: 'hello world' },
    { method: 'POST', url: '/c', forwarded: '198.51.100.7', body: 'chunk one, chunk two' },
  ])
  assert.equal(proxy.stats().accepted, 1, 'the three requests rode one connection')
  assert.equal(proxy.stats().requests, 3)

  // The tunnel's upgrade: told apart, and a fault of its kind leaves the rest alone.
  const tunnel = await tcpClient(proxy.port)
  tunnel.socket.write('GET /api/runners/v1/tunnel HTTP/1.1\r\nHost: home\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  await until('the 101', () => tunnel.text().startsWith('HTTP/1.1 101'))
  assert.deepEqual(upgrades, ['/api/runners/v1/tunnel 198.51.100.7'])
  assert.equal(proxy.stats().tunnels, 1)
  assert.equal(proxy.stats().live.tunnel, 1)
  const greeting = tunnel.text().length
  proxy.blackhole({ only: 'tunnel' })
  tunnel.socket.write('frame')
  await until('the tunnel\'s bytes held', () => proxy.stats().held.up === 5)
  assert.equal(await ask('GET', '/d'), 'ok', 'a request beside a black-holed tunnel went through')
  proxy.heal({ only: 'tunnel' })
  await until('the tunnel\'s bytes echoed', () => tunnel.text().slice(greeting) === 'frame')

  tunnel.socket.destroy()
  agent.destroy()
  // An upgraded socket is the server's no more: closeAllConnections() does not reach it, and close() waits for it.
  for (const socket of upgraded) socket.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/* ------------------------------------------------- the fake docker's classes */

test('a class container on the fake docker is a fake Jupyter of its own under home\'s argv, and docker answers every question about it as docker would', { timeout: 60_000 }, async () => {
  const m = machine()
  const kernel = await revisionOn(m)
  const scope = machinePerimeter(m.instanceLabel)
  const sessionId = classId()
  const secret = token()
  const image = revisionImage(kernel.revisionId)

  // The class bridge: missing, made, read back with its subnet; listed by its label, never as a home's rooms' network.
  const subnets = ['network', 'inspect', scope.network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}']
  assert.match((await m.docker(subnets)).out, /network .* not found/)
  const bridge = await m.docker(networkCreateArgs(MACHINE_ROOM_SUBNET, scope))
  assert.equal(bridge.code, 0, bridge.out)
  assert.equal((await m.docker(subnets)).out, MACHINE_ROOM_SUBNET)
  assert.equal((await m.docker(['network', 'ls', '-q', '--filter', 'label=colloq.kind=class-network'])).out, bridge.out.slice(0, 12), 'the bridge made, and it alone')
  assert.equal((await m.docker(['network', 'ls', '-q', '--filter', 'label=colloq.kind=room-network'])).out, '')

  // Started with the argv the agent lays out (room-spec.ts · machineRoomRunArgs): a container id, a port on the loopback.
  fs.mkdirSync(path.join(m.root, 'rooms', sessionId), { recursive: true })
  const ran = await m.docker(machineRoomRunArgs(spec(m, sessionId, 'room', image, secret), { instanceLabel: m.instanceLabel, gen: 1 }))
  assert.equal(ran.code, 0, ran.out)
  const id = ran.out
  assert.match(id, /^[a-f0-9]{64}$/)
  const name = m.classContainer(sessionId, 'room')!.name
  const published = (await m.docker(['port', id, '8888/tcp'])).out
  assert.match(published, /^127\.0\.0\.1:\d+$/)
  const url = `http://${published}`
  assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: `token ${secret}` } })).status, 200, 'its Jupyter answers with the run\'s token')
  assert.equal((await fetch(`${url}/api/status`)).status, 403, 'and only with it')

  // The kernel host's questions (kernels.ts · byName, listed, the census): in docker's own --format, a missing name said so.
  const byName = await m.docker(['inspect', '--type', 'container', '--format', '{{.Id}}\t{{.State.Status}}\t{{index .Config.Labels "colloq.placement"}}\t{{index .Config.Labels "colloq.profile"}}', name])
  assert.equal(byName.out, `${id}\trunning\t${sessionId}:room:1\t${profileFor('blocked')}`)
  const listed = await m.docker(['ps', '-a', '--no-trunc', '--filter', 'label=colloq.kind=class-kernel', '--filter', `label=${m.instanceLabel}`, '--format', '{{.ID}}\t{{.State}}\t{{.Label "colloq.placement"}}'])
  assert.equal(listed.out, `${id}\trunning\t${sessionId}:room:1`)
  assert.equal((await m.docker(['ps', '-aq', '--filter', 'label=colloq.kind=room-kernel'])).out, '', 'a class container is never a home\'s room')
  const census = await m.docker(['inspect', '--format', '{{.Name}}\t{{.State.Status}}\t{{.HostConfig.Memory}}\t{{.HostConfig.NanoCpus}}', name, `${name}-gone`])
  assert.equal(census.code, 1)
  assert.match(census.out, new RegExp(`^/${name}\\trunning\\t${2048 * 1024 * 1024}\\t2000000000$`, 'm'))
  assert.match(census.out, new RegExp(`No such object: ${name}-gone`))

  // What docker refuses, or this fake cannot read, is refused, exit 1: a misspelt field, a function nobody defines, one docker
  // has and this fake has not, a construct it does not do, a filter other than by label. A map's missing key is no error.
  const refused = async (argv: string[], words: RegExp): Promise<void> => {
    const asked = await m.docker(argv)
    assert.equal(asked.code, 1, `docker ${argv.join(' ')}: ${asked.out}`)
    assert.match(asked.out, words)
  }
  await refused(['inspect', '--format', '{{.State.Runing}}', name], /map has no entry for key "Runing"/)
  await refused(['inspect', '--format', '{{nosuch .Name}}', name], /function "nosuch" not defined/)
  await refused(['inspect', '--format', '{{upper .Name}}', name], /"upper" is not in this fake/)
  await refused(['inspect', '--format', '{{if .State.Running}}yes{{end}}', name], /is not in this fake/)
  await refused(['ps', '-a', '--format', '{{.Nmes}}'], /can't evaluate field Nmes/)
  await refused(['ps', '-a', '--filter', 'status=running'], /--filter status=running is not in this fake/)
  await refused(['network', 'ls', '--filter', 'nosuch=x'], /invalid filter 'nosuch'/)
  assert.equal((await m.docker(['inspect', '--format', '{{index .Config.Labels "colloq.none"}}|{{.Config.Labels.none}}', name])).out, '|<no value>')
  const usage = '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
  assert.equal((await m.docker(['stats', '--no-stream', '--format', usage, name])).out, `${name}\t120MiB / 2048MiB\t0.30%`)
  m.classStats(name, { usedMb: 900, cpuPercent: 87.5 })
  assert.equal((await m.docker(['stats', '--no-stream', '--format', usage, name])).out, `${name}\t900MiB / 2048MiB\t87.50%`)

  // Its Jupyter works in the class folder; the OOM killer's kernel is counted by the cgroup and said in the log.
  const room = await JupyterKernel.connect(sessionId, { url, token: secret })
  assert.deepEqual((await cell(room, 'x = 5\nWRITE out.txt hi\nprint(x)\nCOUNT')).seen, ['5\n', '1\n'])
  assert.equal(fs.readFileSync(path.join(m.root, 'rooms', sessionId, 'out.txt'), 'utf8'), 'hi')
  void room.execute('OOM', handlers())
  const ask = readingArgs(name)
  const killed = await until('the cgroup to count the kill', async () => {
    const counted = parseCgroup(await m.docker(ask.cgroup))
    return counted.kills === 1 ? counted : null
  })
  assert.equal(killed.limit, 2048 * 1024 * 1024)
  assert.equal(killed.peak, killed.limit, 'a cgroup that killed for memory peaked at its limit')
  const reading = parseReading({ inspect: await m.docker(ask.inspect), cgroup: await m.docker(ask.cgroup), logs: await m.docker(ask.logs) })
  assert.equal(reading.status, 'running', 'the container lives on: only its kernel was killed')
  assert.match(reading.tail.join('\n'), /restarting kernel/)
  room.detach()

  // Resized live; then killed under its kernels, and started again with a fresh Python and the folder kept.
  assert.equal((await m.docker(['update', '--memory=3072m', '--memory-swap=3072m', '--cpus=3', id])).code, 0)
  assert.equal((await m.docker(['inspect', '--format', '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}', id])).out, `${3072 * 1024 * 1024} 3000000000`)
  m.dockerKnobs({ update: 'refuse' })
  assert.equal((await m.docker(['update', '--memory=1024m', '--memory-swap=1024m', '--cpus=1', id])).code, 1, 'the knob keeps the limits')
  m.dockerKnobs({ update: 'ok' })
  const first = m.classContainer(sessionId, 'room')!
  await m.killClassContainer(name, { oom: true })
  assert.equal(alive(first.pid), false, 'its Jupyter died with it')
  assert.equal((await m.docker(ask.inspect)).out, `exited 137 true ${3072 * 1024 * 1024}`)
  assert.equal((await m.docker(['ps', '-q', '--filter', `label=${m.instanceLabel}`])).out, '', 'ps lists the running ones')
  assert.equal((await m.docker(['ps', '-aq', '--filter', `label=${m.instanceLabel}`])).out, id.slice(0, 12), 'ps -a every one')
  assert.equal((await m.docker(['port', id, '8888/tcp'])).code, 1, 'an exited container publishes nothing')
  assert.equal((await m.docker(['start', id])).code, 0)
  const again = m.classContainer(sessionId, 'room')!
  assert.equal(again.restarts, 1)
  assert.notEqual(again.pid, first.pid)
  const fresh = await JupyterKernel.connect(sessionId, { url: `http://${(await m.docker(['port', id, '8888/tcp'])).out}`, token: secret })
  const forgotten = await cell(fresh, 'print(x)')
  assert.deepEqual(forgotten.errors, [['NameError', 'name \'x\' is not defined']], 'a fresh Python')
  assert.deepEqual((await cell(fresh, 'READ out.txt\nCOUNT')).seen, ['hi', '1\n'], 'the folder kept, the count anew')
  fresh.detach()

  // `cp` both ways: the class folder through its mount, anything else from the container's own filesystem.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'classes-e2e-cp-'))
  assert.equal((await m.docker(['cp', `${name}:/workspace/${sessionId}/out.txt`, out])).code, 0)
  assert.equal(fs.readFileSync(path.join(out, 'out.txt'), 'utf8'), 'hi')
  fs.mkdirSync(path.join(out, 'epoch'))
  fs.writeFileSync(path.join(out, 'epoch', 'manifest.json'), '{}')
  assert.match((await m.docker(['cp', path.join(out, 'epoch', 'manifest.json'), `${name}:/tmp/colloq-epoch/1/`])).out, /does not exist/, 'a folder named with a slash must be there')
  assert.equal((await m.docker(['cp', path.join(out, 'epoch'), `${name}:/tmp/colloq-epoch`])).code, 0)
  assert.equal((await m.docker(['cp', `${name}:/tmp/colloq-epoch/manifest.json`, path.join(out, 'back.json')])).code, 0)
  assert.equal(fs.readFileSync(path.join(out, 'back.json'), 'utf8'), '{}')
  fs.rmSync(out, { recursive: true, force: true })

  // The council's container sees the class folder read-only (D10): its kernels read it and cannot write it.
  const councilSecret = token()
  assert.equal((await m.docker(machineRoomRunArgs(spec(m, sessionId, 'council', image, councilSecret), { instanceLabel: m.instanceLabel, gen: 1 }))).code, 0)
  const council = m.classContainer(sessionId, 'council')!
  const worker = await JupyterKernel.connect(sessionId, { url: m.jupyterOf(council).url, token: councilSecret }, 'w1')
  assert.deepEqual((await cell(worker, 'READ out.txt')).seen, ['hi'])
  assert.equal((await cell(worker, 'WRITE mine.txt no')).errors[0]?.[0], 'OSError')
  worker.detach()

  // Removed: gone from every list, their processes ended, nothing of them left on the machine but the folder.
  const pids = m.classContainers().map((c) => c.pid)
  assert.equal((await m.docker(['rm', '-f', id, council.id])).code, 0)
  assert.equal((await m.docker(['ps', '-aq', '--filter', 'label=colloq.kind=class-kernel'])).out, '')
  assert.deepEqual(pids.map(alive), [false, false])
  assert.equal(m.classContainers().length, 0)
  assert.ok(fs.existsSync(path.join(m.root, 'rooms', sessionId, 'out.txt')))
})

/** What the agent hands its kernel host (sync.ts · the Agent's constructor), on this machine's fake docker, with the clock's beats the test's. */
function hostOptions(m: Agent, kernel: ReturnType<typeof kernelRevision>, lines: string[], own: { container: string | null; image: string | null } = { container: null, image: RUNNER_IMAGE }): ConstructorParameters<typeof KernelHost>[0] {
  return {
    layout: stateLayout(m.root),
    docker: (argv: string[]) => m.docker(argv),
    images: { verify: async (revision: { id: string }) => revisionImage(revision.id), isReady: () => true, problemWith: () => null, readyIds: () => [kernel.revisionId] },
    ...own,
    env: {},
    instanceLabel: m.instanceLabel,
    cards: () => [],
    cardRuns: () => [],
    heldGpus: () => ({}),
    diskFreeMb: () => 100_000,
    diskFloorMb: 1_000,
    heardAt: () => Date.now(),
    onChange: () => {},
    log: (line: string) => lines.push(line),
    // The census, the counters and the perimeter's minute when the test says (tick), never by themselves.
    timings: { readyPollMs: 50, censusMs: 3_600_000, countersMs: 0 },
  }
}

/** Home's intent for a class's room slot on a machine, at gen 1 (shared/remote-kernels.ts · RemotePlacementIntent). */
function roomIntent(sessionId: string, kernel: ReturnType<typeof kernelRevision>): RemotePlacementIntent {
  return {
    key: remotePlacementKey(sessionId, 'room'), gen: 1, environment: 'base',
    revision: { id: kernel.revisionId, ref: kernel.registryRef, layers: kernel.layers },
    memoryMb: 2048, cpus: 2, pids: 512, gpu: false, network: 'blocked', blockedCidrs: [], token: token(), hashSeed: classHashSeed(sessionId), shm: '1g',
  }
}

/** A reply's kernels block naming the whole wanted set, and nothing else. */
function kernelsReply(placements: RemotePlacementIntent[]): RemoteKernelsReply {
  return { placements, pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [], rates: { classBulkMBps: 4, machinePaceMBps: 6 }, tunnel: 'open' }
}

test('the agent\'s kernel host drives the fake docker as it drives docker: start behind the perimeter and the canary, census, resize, adoption, a death started again, removal', { timeout: 120_000 }, async () => {
  const m = machine()
  const kernel = await revisionOn(m)
  const lines: string[] = []
  const options = hostOptions(m, kernel, lines)
  const sessionId = classId()
  const intent = roomIntent(sessionId, kernel)
  const reply = kernelsReply
  const log = (): string => lines.slice(-30).join('\n')
  const ready = (host: KernelHost, what: string): Promise<{ container?: string; revision?: string }> =>
    until(what, () => {
      const held = host.held().find((entry) => entry.key === intent.key)
      return held?.phase === 'ready' ? held : null
    }, 60_000, log)

  // The start of §7.2: the facts, the bridge, the helper, the canary, then the container, its port and its Jupyter's answer.
  const host = new KernelHost(options)
  host.reconcile(reply([intent]))
  const held = await ready(host, 'the class kernel to be ready')
  assert.deepEqual(host.facts(), { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false })
  const calls = m.dockerCalls().map((call) => call.args)
  assert.ok(calls.some((args) => args[0] === 'network' && args[1] === 'create'), 'the class bridge was made')
  assert.ok(calls.some((args) => args[0] === 'run' && args.includes('--privileged') && args.includes('colloq.kind=room-perimeter')), 'the perimeter\'s helper ran')
  assert.ok(calls.some((args) => args[0] === 'run' && args.some((arg) => arg.startsWith('colloq-runner-canary-'))), 'the canary ran')
  const container = m.classContainer(sessionId, 'room')!
  assert.equal(held.container, container.id)
  assert.equal(held.revision, remoteRevisionDigest(kernel.registryRef), 'the ready echo names the revision it started from')
  const resolved = host.resolve(intent.key, 1)
  assert.ok('port' in resolved, JSON.stringify(resolved))
  assert.equal(resolved.port, container.port, 'the tunnel reaches the port docker publishes, and no other')
  assert.equal((await fetch(`http://127.0.0.1:${resolved.port}/api/status`, { headers: { Authorization: `token ${intent.token}` } })).status, 200)
  assert.deepEqual(host.resolve(intent.key, 2), { refused: 'starting' })

  // The census: one inspect and one stats, the cgroup's counters.
  m.classStats(container.name, { usedMb: 640, cpuPercent: 12 })
  await host.tick()
  const usage = host.held().find((entry) => entry.key === intent.key)?.usage
  assert.deepEqual(usage && { usedMb: usage.usedMb, limitMb: usage.limitMb, cpus: usage.cpus, cpuPercent: usage.cpuPercent, oomKills: usage.oomKills }, { usedMb: 640, limitMb: 2048, cpus: 2, cpuPercent: 12, oomKills: 0 })

  // A resize is `docker update`, live, and said for the numbers asked.
  const bigger = { ...intent, memoryMb: 3072 }
  host.reconcile(reply([bigger]))
  await until('the resize to be said', () => host.held().find((entry) => entry.key === intent.key)?.resized === 'applied', 30_000, log)
  assert.equal(m.classContainer(sessionId, 'room')!.memoryMb, 3072)

  // The agent restarts (§7.3): the container ran on, and the next life adopts it as it is, its port with it.
  host.stop()
  await host.idle()
  const next = new KernelHost(options)
  await next.adopt()
  const adopted = await ready(next, 'the adopted kernel')
  assert.equal(adopted.container, container.id)
  assert.equal(m.classContainer(sessionId, 'room')!.pid, container.pid, 'the same process: the class kept its variables')
  next.reconcile(reply([bigger]))

  // Its container dies: the census finds it, reads it for home, and starts it again — the same container, a fresh Python.
  await m.killClassContainer(container.name)
  await next.tick()
  await ready(next, 'the kernel started again')
  const restarted = m.classContainer(sessionId, 'room')!
  assert.equal(restarted.id, container.id)
  assert.equal(restarted.restarts, 1)
  assert.ok(m.dockerCalls().some((call) => call.args[0] === 'start' && call.args[1] === container.id), 'docker start, not a new container')

  // Home no longer names it: removed, its record with it; and removeAll leaves nothing docker lists.
  next.reconcile(reply([]))
  await until('the container to go', () => m.classContainer(sessionId, 'room') === null && next.held().length === 0, 30_000, log)
  assert.equal(alive(restarted.pid), false)
  next.reconcile(reply([{ ...bigger, gen: 2 }]))
  await until('the next gen to be ready', () => next.held().find((entry) => entry.key === intent.key && entry.gen === 2)?.phase === 'ready', 60_000, log)
  assert.equal(await next.removeAll('the test is over'), 0)
  assert.equal(m.classContainers().length, 0)
  next.stop()
})

test('an agent whose own container is off the host\'s network takes no class: its helper runs, its canary does not', { timeout: 60_000 }, async () => {
  const m = new Agent(fleet, `bridged-${randomBytes(2).toString('hex')}`, { join: `http://127.0.0.1:9#${'0'.repeat(32)}`, container: { network: 'bridge' } })
  const kernel = await revisionOn(m)
  const lines: string[] = []
  const host = new KernelHost(hostOptions(m, kernel, lines, { container: m.ownContainer, image: null }))
  const intent = roomIntent(classId(), kernel)
  host.reconcile(kernelsReply([intent]))
  const failed = await until('the start to be refused', () => host.held().find((entry) => entry.key === intent.key && entry.phase === 'failed'), 30_000, () => lines.join('\n'))
  assert.match(failed.failure?.detail ?? '', /host's network/)
  assert.equal(host.facts().hostNetwork, false, 'read off the agent\'s own container (HostConfig.NetworkMode)')
  assert.equal(host.facts().perimeter, 'ok', 'the helper ran from the image of the agent\'s own container')
  assert.equal(m.classContainers().length, 0)
  host.stop()
  await host.idle()
})

/* --------------------------------------------- home, the tunnel, a machine */

/** An upgrade to home's tunnel door, by hand: the status line home answers with, and its headers. */
async function upgradeAt(port: number, headers: Record<string, string> = {}): Promise<string> {
  const socket = net.connect(port, '127.0.0.1')
  let text = ''
  socket.on('data', (chunk: Buffer) => (text += chunk.toString('latin1')))
  socket.on('error', () => undefined)
  await new Promise((resolve) => socket.once('connect', resolve))
  const lines = ['GET /api/runners/v1/tunnel HTTP/1.1', 'Host: home', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)]
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  await until('home\'s answer to the upgrade', () => text.includes('\r\n\r\n'))
  socket.destroy()
  return text
}

test('home\'s tunnel door through the fault proxy: a class machine\'s agent joins, its tunnel carries a cell into a class container\'s Jupyter, and the home\'s clock ends a black-holed tunnel', { timeout: 120_000 }, async () => {
  // The door is the process's own handler: it answers a stranger with its marked refusal, before the browsers' doors.
  const refused = await upgradeAt(home.port)
  assert.match(refused, /^HTTP\/1\.1 401 /)
  assert.match(refused, new RegExp(`${REMOTE_MARKER_HEADER}: ${REMOTE_MARKER}`, 'i'))
  assert.equal(home.requests.at(-1)?.upgrade, true)
  assert.equal(home.requests.at(-1)?.status, 401, 'the upgrade is written down with its answer')

  // A class machine joins through the proxy, from the address the relay names (X-Forwarded-For).
  const proxy = await proxyFor(home.port, { forwardedFor: '198.51.100.7' })
  const agent = new Agent(fleet, `tunnel-${randomBytes(2).toString('hex')}`, { join: proxy.joinTarget(await home.mintCode({ classes: true })), classes: true })
  agent.start()
  const runnerId = await until('the machine to join', () => agent.identity()?.runnerId, 30_000, () => agent.log())
  assert.equal(getRunner(runnerId)?.classes, true, 'the code made it a class machine')
  await until('a sync of it to be answered', () => home.requestsOf(runnerId).some((one) => one.path.endsWith('/sync') && one.status === 200), 30_000, () => agent.log())
  assert.equal(heardAddress(runnerId), '198.51.100.7', 'home heard it from the address the proxy said')
  // Its agent stops (its containers would outlive it): the machine's tunnel end below is the test's, with its credential, and
  // never fights one the agent dials itself once home's sync asks it to.
  await agent.kill()
  await until('no tunnel of the machine\'s own up', () => !home.tunnels!.isUp(runnerId), 30_000, () => home.tunnelLines.join('\n'))

  // A class container on its fake docker, as its kernel host starts one.
  const kernel = await revisionOn(agent)
  const sessionId = classId()
  const secret = token()
  assert.equal((await agent.docker(networkCreateArgs(MACHINE_ROOM_SUBNET, machinePerimeter(agent.instanceLabel)))).code, 0)
  fs.mkdirSync(path.join(agent.root, 'rooms', sessionId), { recursive: true })
  const ran = await agent.docker(machineRoomRunArgs(spec(agent, sessionId, 'room', revisionImage(kernel.revisionId), secret), { instanceLabel: agent.instanceLabel, gen: 1 }))
  assert.equal(ran.code, 0, ran.out)
  const container = agent.classContainer(sessionId, 'room')!
  const key = remotePlacementKey(sessionId, 'room')

  // The machine's end of the tunnel with its own credential: the agent's own module, in this process.
  const dialled = proxy.stats().tunnels
  const heard: string[] = []
  const end = new AgentTunnel({
    url: tunnelUrl(proxy.url),
    authorization: agent.authorization(),
    build: 'dev',
    resolve: (asked, gen) => (asked === key && gen === 1 ? { port: container.port! } : { refused: 'gone' }),
    paceMBps: () => 1000,
    log: (event) => heard.push(event),
    relayState: async () => 'unknown',
  })
  try {
    end.want('open')
    const tunnels = home.tunnels!
    await until('the tunnel up at home', () => tunnels.isUp(runnerId), 30_000, () => home.tunnelLines.join('\n'))
    assert.ok(proxy.stats().tunnels > dialled, 'the proxy told the tunnel from the syncs')
    assert.ok(home.tunnelLines.some((line) => line.includes(`machine ${runnerId} up from 198.51.100.7`)), home.tunnelLines.join('\n'))

    // Home's kernel client, through a placement's listener, the tunnel, the proxy and the agent's end, into the container's Jupyter.
    const listener = await tunnels.listen(runnerId, key, 1)
    const link = tunnels.link(runnerId, key, 1)
    assert.equal(link.up, true)
    const room = await JupyterKernel.connect(sessionId, { url: `http://127.0.0.1:${listener.port}`, token: secret, link, identity: `machine:${runnerId}:${container.id}:1` })
    assert.deepEqual((await cell(room, 'x = 41\nprint("through the tunnel")')).seen, ['through the tunnel\n'])
    const door = agent.jupyterOf(container)
    assert.ok((await door.kernels()).some((one) => one.path === jupyterSessionPath(sessionId, CELLS_KEY)), 'the session is the container\'s, by its path')

    // The tunnel black-holed: home's clock, moved past the dead timer, ends it at once, and the machine's other calls go on beside it.
    proxy.blackhole({ only: 'tunnel' })
    home.clock.advance(TUNNEL_DEAD_MS + 1)
    await until('home to end the silent tunnel', () => !tunnels.isUp(runnerId) && !link.up)
    assert.equal((await fetch(`${proxy.url}/api/readyz`)).status, 200, 'a plain call crosses the proxy beside the black-holed tunnel')
    // A dead leg carries no close: the machine's end hears nothing of the end until the heal (or its own dead timer).
    assert.ok(!heard.includes('tunnel-down'), `the machine heard its tunnel end through the black hole: ${heard.join(', ')}`)

    // Healed: the end reaches the machine, its end dials again, the link comes back, and the kernel goes on where it was — no
    // cell run twice.
    proxy.heal({ only: 'tunnel' })
    await until('the machine\'s end to hear its tunnel end', () => heard.includes('tunnel-down'))
    await until('the tunnel back up', () => tunnels.isUp(runnerId) && link.up, 60_000, () => home.tunnelLines.join('\n'))
    assert.deepEqual((await cell(room, 'print(x)\nCOUNT')).seen, ['41\n', '1\n'])
    assert.equal((await door.calls()).filter((call) => call.kind === 'count').length, 1)
    room.detach()
    listener.close()
  } finally {
    await end.close()
  }
  assert.ok(alive(container.pid), 'the container outlives its tunnel, as it outlives its agent')
})

test('a home crash cuts its tunnels without a close frame and closes the placements\' listeners; the home started again greets them as a new life', { timeout: 120_000 }, async () => {
  const agent = new Agent(fleet, `crash-${randomBytes(2).toString('hex')}`, { join: home.joinTarget(await home.mintCode({ classes: true })), classes: true })
  agent.start()
  const runnerId = await until('the machine to join', () => agent.identity()?.runnerId, 30_000, () => agent.log())
  // The tunnel end is the test's own, as above: the agent goes once it has joined.
  await agent.kill()
  await until('no tunnel of the machine\'s own up', () => !home.tunnels!.isUp(runnerId), 30_000, () => home.tunnelLines.join('\n'))
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = []
  const end = new AgentTunnel({
    url: tunnelUrl(home.url),
    authorization: agent.authorization(),
    build: 'dev',
    resolve: () => ({ refused: 'gone' }),
    paceMBps: () => 1000,
    log: (event, detail) => events.push({ event, detail }),
    relayState: async () => 'unknown',
  })
  try {
    end.want('open')
    const before = home.tunnels!
    const placementsBefore = home.placements
    assert.equal(classPlacements(), placementsBefore, 'the home\'s class placements are the process\'s')
    await until('the tunnel up', () => before.isUp(runnerId), 30_000, () => home.tunnelLines.join('\n'))
    const listener = await before.listen(runnerId, remotePlacementKey(classId(), 'room'), 1)
    await home.restart()
    const down = await until('the agent\'s end to hear the home go', () => events.find((one) => one.event === 'tunnel-down'))
    assert.equal(down.detail?.code, 1006, 'no close frame leaves a home that died')
    assert.notEqual(home.tunnels, before, 'the new life has tunnels of its own')
    assert.notEqual(home.placements, placementsBefore, 'and class placements of its own, nothing of the old life\'s in memory')
    assert.equal(classPlacements(), home.placements)
    const answer = await new Promise<string>((resolve) => {
      const socket = net.connect(listener.port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve('connected')
      })
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
    })
    assert.equal(answer, 'ECONNREFUSED', 'the old life\'s listener went with it')
    await until('the tunnel up again on the new life', () => home.tunnels?.isUp(runnerId) === true, 60_000, () => home.tunnelLines.join('\n'))
  } finally {
    await end.close()
  }
})

test('the kernel hooks hear each life\'s class placements: a slot read through them, and its loss heard, after a restart too', { timeout: 60_000 }, async () => {
  const lost: string[] = []
  onKernelMachineChange((sessionId) => lost.push(sessionId))
  const runnerId = enrolled()
  const kernel = kernelRevision(fleet)
  // A room slot on the machine, as a placement's ready report leaves its row; then the machine revoked (§11.5): it fails over first.
  const placeAndLose = (): string => {
    const sessionId = classId()
    const at = home.clock.now()
    writePlacement({
      sessionId, role: 'room', runnerId, state: 'ready', environment: 'base', revision: { id: kernel.revisionId, ref: kernel.registryRef, layers: kernel.layers },
      memoryMb: 2048, cpus: 2, gpu: null, workers: null, container: null, readyAt: at, endedAt: null, reason: null, createdAt: at,
    })
    assert.equal(kernelMachineOf(sessionId, 'room')?.state, 'ready', 'the hooks read the slot through the placement module')
    assert.equal(home.placements!.failoverRunner(runnerId, 'revoked', home.clock.now()), 1)
    return sessionId
  }
  const before = placeAndLose()
  assert.deepEqual(lost.filter((one) => one === before), [before], 'the hooks heard the loss')
  await home.restart()
  const after = placeAndLose()
  assert.deepEqual(lost.filter((one) => one === after), [after], 'and the next life\'s, from its own placements')
})

/* ---------------------------------------------------- the fake Jupyter */

test('the fake Jupyter answers each hidden module\'s report by its module, and turns the knobs a test in another process sets', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classes-e2e-jupyter-'))
  const kills = path.join(dir, 'kills')
  const fake = await startFakeJupyter({ interpreter: true, buffer: true, guardAnswer, cwd: path.join(dir, 'one'), oomFile: kills })
  const other = await startFakeJupyter({ interpreter: true, buffer: true, guardAnswer, cwd: path.join(dir, 'workspace'), perSession: true })
  const sessionId = classId()
  const at = jupyterSessionPath(sessionId, CELLS_KEY)
  try {
    fs.mkdirSync(path.join(dir, 'one'))
    fs.mkdirSync(path.join(dir, 'workspace'))
    const kernel = await JupyterKernel.connect(sessionId, { url: fake.url, token: 'fake' })
    await cell(kernel, 'x = 5')

    // The guard's report is the guard's alone; the help and the council read their own, as the server parses them.
    assert.equal((await report(kernel, 'pass', GUARD_REPORT_EXPR))?.ename, 'KeyError', 'a process without the guard cannot evaluate its report')
    const brief = await report(kernel, `__import__('sys').modules['_colloq_inspect'].brief(globals(), 'df')`, INSPECT_REPORT_EXPR)
    assert.deepEqual(JSON.parse(brief!.data!['text/plain']!), { found: true, brief: { type: 'DataFrame', dims: '1460 × 81' } })
    const entry = await report(kernel, `__import__('sys').modules["_colloq_council"].enter(globals(), 1, {})`, COUNCIL_REPORT_EXPR)
    assert.equal(JSON.parse(entry!.data!['text/plain']!).copied, 1)
    const exported = await report(kernel, `__import__('sys').modules["_colloq_council"].export(globals(), "/tmp/colloq-epoch/1", 1, {})`, COUNCIL_REPORT_EXPR)
    assert.deepEqual(JSON.parse(exported!.data!['text/plain']!).carried, ['x'], 'the export placeholder carries the kernel\'s bindings')
    const loaded = await report(kernel, `__import__('sys').modules["_colloq_council"].load(globals(), "manifest", "body", {})`, COUNCIL_REPORT_EXPR)
    assert.equal(JSON.parse(loaded!.data!['text/plain']!).oomScoreAdj, 1000)

    // The knobs, over HTTP as a test in another process turns them: an interrupt held and let go, a slow comeback.
    const knobs = async (asked: Record<string, unknown>): Promise<Record<string, unknown>> =>
      (await (await fetch(`${fake.url}/_fake/knobs`, { method: 'POST', body: JSON.stringify(asked) })).json()) as Record<string, unknown>
    const id = fake.kernelAt(at)!
    assert.equal((await knobs({ holdInterrupts: true })).holdInterrupts, true)
    let answered = false
    const interrupt = fetch(`${fake.url}/api/kernels/${id}/interrupt`, { method: 'POST', headers: { Authorization: 'token fake' } }).then((answer) => {
      answered = true
      return answer.status
    })
    await until('the interrupt to be held', () => fake.pendingInterrupts.length === 1)
    assert.equal(answered, false)
    await knobs({ holdInterrupts: false })
    assert.equal(await interrupt, 204)
    await knobs({ slowRevival: true })
    void kernel.execute('OOM', handlers())
    await until('the kill to be counted', () => fs.existsSync(kills) && fs.readFileSync(kills, 'utf8').split('\n').filter(Boolean).length === 1)
    const state = async (): Promise<string> => ((await (await fetch(`${fake.url}/api/kernels/${id}`)).json()) as { execution_state: string }).execution_state
    assert.equal(await state(), 'starting', 'a slow comeback')
    await knobs({ slowRevival: false })
    assert.equal(await state(), 'idle')
    assert.equal((await knobs({ holdKernelInfo: true })).holdKernelInfo, true)
    assert.equal((await knobs({ holdKernelInfo: false })).holdKernelInfo, false)
    const requests = (await (await fetch(`${fake.url}/_fake/requests`)).json()) as Array<{ code: string }>
    assert.ok(requests.some((one) => one.code === 'x = 5'))
    kernel.detach()

    // Each process has kernel ids of its own (a container started again knows none of its earlier life's), and a home's
    // Jupyter works in each session's folder under its root — its terminals too, once terminal.ts's greeting has them `cd`
    // to /workspace/<id>.
    const there = await JupyterKernel.connect(sessionId, { url: other.url, token: 'fake' })
    assert.notEqual(other.kernelAt(at), fake.kernelAt(at))
    await cell(there, 'WRITE out.txt mine')
    assert.equal(fs.readFileSync(path.join(dir, 'workspace', sessionId, 'out.txt'), 'utf8'), 'mine')
    there.detach()
    const pty = (await (await fetch(`${other.url}/api/terminals`, { method: 'POST' })).json()) as { name: string }
    const shell = new WebSocket(`${other.url.replace('http:', 'ws:')}/terminals/websocket/${pty.name}`)
    let printed = ''
    shell.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as [string, string]
      if (frame[0] === 'stdout') printed += frame[1]
    })
    await new Promise((resolve) => shell.once('open', resolve))
    shell.send(JSON.stringify(['stdin', `cd /workspace/${sessionId} && cat out.txt\r`]))
    await until('the shell to print the session\'s file', () => /\r\nmine\$ $/.test(printed), 5_000, () => JSON.stringify(printed))
    shell.terminate()
  } finally {
    await fake.close()
    await other.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a class container\'s Jupyter ends when its container\'s state no longer names it, and when the test that started it is gone', { timeout: 60_000 }, async (t) => {
  const entry = fileURLToPath(new URL('./_fake-jupyter.mjs', import.meta.url))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classes-e2e-life-'))
  const children: Array<ReturnType<typeof spawn>> = []
  t.after(() => {
    // Only the processes this test started, by their own handles.
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const start = async (extra: string[]): Promise<{ child: ReturnType<typeof spawn>; port: number; exited: Promise<unknown> }> => {
    const child = spawn(process.execPath, [entry, '--port', '0', '--cwd', dir, ...extra], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(child)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''
      child.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('\n')) resolve(Number(out.split('\n')[0]))
      })
      child.once('exit', () => reject(new Error('the fake ended before it said its port')))
    })
    return { child, port, exited }
  }

  // Named by its container's state, it serves; the state removed (a `docker rm` it was not told of), it ends.
  const file = path.join(dir, 'container.json')
  const id = randomBytes(32).toString('hex')
  const named = await start(['--container-file', file, '--container-id', id])
  fs.writeFileSync(file, JSON.stringify({ id, pid: named.child.pid, status: 'running' }))
  const life = async (): Promise<{ named: boolean } | null> => (await (await fetch(`http://127.0.0.1:${named.port}/_fake/life`)).json()) as { named: boolean } | null
  await until('the process to know its container', async () => (await life())?.named === true)
  assert.equal((await fetch(`http://127.0.0.1:${named.port}/api/status`)).status, 200)
  fs.rmSync(file)
  await named.exited

  // Its owner gone — the test's process, killed however — it ends too.
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(owner)
  const watched = await start(['--owner', String(owner.pid)])
  assert.equal((await fetch(`http://127.0.0.1:${watched.port}/api/status`)).status, 200)
  owner.kill('SIGKILL')
  await watched.exited
})

/* -------------------------------------------------------- the home's own */

test('the home\'s clock moves on by hand, each timer at its own time, and its own Jupyter serves the rooms it keeps', { timeout: 60_000 }, async () => {
  // What falls due runs at the move, the earliest first, and what that sets due too; a cleared timer never.
  const clock = new HomeClock()
  const fired: string[] = []
  clock.setTimeout(() => fired.push('sixty'), 60_000)
  const cancelled = clock.setTimeout(() => fired.push('never'), 30_000)
  clock.setTimeout(() => {
    fired.push('thirty')
    clock.setTimeout(() => fired.push('chained'), 0)
  }, 30_000)
  clock.clearTimeout(cancelled)
  const begun = clock.now()
  clock.advance(30_000)
  assert.deepEqual(fired, ['thirty', 'chained'])
  clock.advance(30_000)
  assert.deepEqual(fired, ['thirty', 'chained', 'sixty'])
  assert.ok(clock.now() - begun >= 60_000)

  // Each runs reading its own time, so one that sets itself again (a tunnel's ping) runs once a period across a long move.
  const beats: number[] = []
  let next: unknown = null
  const beat = (): void => {
    beats.push(clock.now())
    next = clock.setTimeout(beat, 10_000)
  }
  next = clock.setTimeout(beat, 10_000)
  clock.advance(60_000)
  clock.clearTimeout(next)
  assert.deepEqual(beats.map((at) => at - beats[0]!), [0, 10_000, 20_000, 30_000, 40_000, 50_000])

  // A timer the move left still to come is due as much sooner on the wall: a second on the clock, 900 ms of it moved, comes
  // before half a second of the wall.
  const order: string[] = []
  clock.setTimeout(() => order.push('the clock\'s'), 1_000)
  clock.advance(900)
  setTimeout(() => order.push('the wall\'s'), 500)
  await until('both timers', () => order.length === 2)
  assert.deepEqual(order, ['the clock\'s', 'the wall\'s'])

  // The rooms the test backend keeps at home reach the home's own fake Jupyter, each kernel in its room's folder.
  const jupyter = await home.homeJupyter()
  assert.equal(await home.homeJupyter(), jupyter, 'one for the home')
  const { defaultEndpoint } = await import('../server/src/kernel/jupyter.js')
  const sessionId = classId()
  const kernel = await JupyterKernel.connect(sessionId, defaultEndpoint())
  await cell(kernel, 'WRITE out.txt at home')
  assert.equal(fs.readFileSync(path.join(process.env.WORKSPACE_DIR!, sessionId, 'out.txt'), 'utf8'), 'at home')
  kernel.detach()
})

test('the home\'s class placements find a class\'s image as the test noted it, and nothing of this process reaches a docker', async () => {
  const kernel = kernelRevision(fleet, 'e2e-classes')
  const found = await home.placements!.classRevision('e2e-classes')
  assert.equal(found?.id, kernel.revisionId)
  assert.equal(found?.registryRef, kernel.registryRef, 'a revision machines can pull')
  // What would have asked the developer's daemon (Colima, Docker Desktop) for the home's own image hears there is none.
  await assert.rejects(captureRevision('base'), new RegExp(NO_DOCKER))
})
