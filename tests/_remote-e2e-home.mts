/**
 * The home of tests/remote-e2e.test.mts: the REAL app (server/src/app.ts) in
 * the test's own process, on an ephemeral port of 127.0.0.1, with the
 * temporary DATA_DIR of tests/_env.mts and the stand-in runner
 * (competitions/fake-runner.ts) for this server's own jobs — so the metric
 * lane scores what the machines ran without a Docker here.
 *
 * STARTED AS index.ts STARTS THE SERVER, in its order: listen, then the
 * machines' boot pass and clock (remote/liveness.ts · startRemoteRunners:
 * offers of a previous life withdrawn, outcomes left `applying` driven
 * again), then the queue's reclaim and its pump. A restart is that again
 * after a crash: the port closed and every connection cut (the machines see
 * the home go away mid-call), the clock and the pump stopped, then a new life
 * (heard.ts · resetHeard, the boot grace counted anew) on the same DATA_DIR
 * and the same port, which is all a machine knows its home by. The database
 * stays the same file, as it does across a real restart; it is never reopened
 * here, because db.ts opens it once, when it loads.
 *
 * EVERY REQUEST IS WRITTEN DOWN as it arrives (method, path, which machine's
 * credential), so a test can say what a machine never asked for — the hidden
 * test's blobs above all — and `stall` holds chosen requests back from the app.
 *
 * WHAT THE PARTICIPANT SEES is read through the participant's own doors
 * (/api/k/…, signed in by the cookie the join door gives), what the owner sees
 * through the owner's (/api/admin/…, a staff cookie minted as the panel's
 * tests mint one), and the rest from the database by the store's own reads.
 *
 * THE UPGRADES ARE THE PROCESS'S TOO (classes on machines,
 * remote-classes.md §17.2): the server's `upgrade` event goes to the very
 * handler index.ts attaches (upgrade.ts · handleUpgrade), so the machines'
 * tunnel door answers here as it does in production, before the browsers'
 * doors, which answer too. Each life of the home has tunnels of its own
 * (MachineTunnels, a new session in every WELCOME) and class placements of
 * its own (ClassPlacements: what the placements hold in memory — links,
 * usage, gates — starts empty, the rows stay in the database) on the home's
 * clock (HomeClock), handed to the kernel hooks as the server's boot hands
 * them the placement module (kernel/index.ts · useClassPlacements), so the
 * pump's gate, the room's notes and the refusals hear that life's news on
 * that clock. A class's image is the one the test noted (kernelRevision),
 * never a daemon's: this process has no docker (useDockerForRevisions). A
 * crash cuts every upgraded socket without a close frame, as a process that
 * dies does, and closes the placements' listeners with it.
 * With `liveness: 'manual'` the machines' clock passes (liveness.ts ·
 * remoteTick, and the class tick it calls) run only when a test asks
 * (`tick`, `probe`), on that clock.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { parseRemoteAuthorization } from '../shared/remote-runner.js'
import type { EntrantSubmissions, SubmissionAccepted } from '../shared/competitions-entrant.js'
import { app } from '../server/src/app.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { parseInboundPolicy, useInboundPolicy } from '../server/src/net/inbound.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { reclaimCompetitionQueue, startCompetitionPump, stopCompetitionPump, wakeCompetitionPump } from '../server/src/competitions/runner.js'
import { createCompetition, putFile, queueRows, leaveQueue, setCompetitionState, setQueuePaused } from '../server/src/competitions/store.js'
import { putOpenFile, putSealedFile, putSecretFile } from '../server/src/competitions/storage.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { noteRevisionImage, putRevision, revisions, selectRevision } from '../server/src/dependencies/store.js'
import { useDockerForRevisions } from '../server/src/dependencies/revisions.js'
import type { EnvironmentRevision } from '../shared/dependencies.js'
import { bootRemoteRunners, probeOwnPath, remoteTick, startRemoteRunners, stopRemoteRunners } from '../server/src/competitions/remote/liveness.js'
import { loadClassPort, resetHeard, useRemoteClock } from '../server/src/competitions/remote/heard.js'
import { forgetWantScope, resetBlobBucket } from '../server/src/competitions/remote/blobs.js'
import { listRunners, mintRemoteCode } from '../server/src/competitions/remote/store.js'
import { forgetStock } from '../server/src/competitions/remote/want.js'
import { handleUpgrade } from '../server/src/upgrade.js'
import { MachineTunnels, useMachineTunnels } from '../server/src/kernel/remote/tunnel.js'
import * as placementModule from '../server/src/kernel/remote/placement.js'
import { ClassPlacements, usePlacements } from '../server/src/kernel/remote/placement.js'
import { useClassPlacements } from '../server/src/kernel/index.js'
import { useDefaultEndpointForTest } from '../server/src/kernel/jupyter.js'
import type { TunnelClock } from '../shared/remote-tunnel.js'
import { startFakeJupyter } from './_fake-jupyter.mjs'
import { guardAnswer } from './_guard.mts'
import { publishKernel, type Fleet } from './_remote-e2e-agent.mts'

/*
 * Every machine and every participant of these tests calls from 127.0.0.1,
 * and the router's one per-address limit (ten joins in ten minutes) and the
 * participant doors' would refuse a suite's worth of them: the address many
 * people share, as an operator names a campus NAT (net/inbound.ts).
 */
useInboundPolicy(parseInboundPolicy({ ...process.env, SHARED_ADDRESSES: '127.0.0.1' }))

/** What revisions.ts's docker says in this process: there is none, and never the developer's (Colima, Docker Desktop) instead. */
export const NO_DOCKER = 'there is no docker daemon in the e2e'

useDockerForRevisions(async () => {
  throw new Error(NO_DOCKER)
})

/**
 * The e2e's stand-in for this server's own image of an environment
 * (revisions.ts · captureRevision, which asks the daemon): the newest
 * revision of it noted with an image machines can pull, as kernelRevision()
 * notes one. Null — none is noted.
 */
export async function notedRevision(environment: string): Promise<EnvironmentRevision | null> {
  const noted = revisions().filter((revision) => revision.environmentName === environment && revision.registryRef !== null && revision.layers !== null)
  return noted.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
}

/** This server's own runner: the notebooks it runs itself (when it does) and every metric. */
export const homeRunner = new FakeCompetitionRunner()
useCompetitionRunner(homeRunner)

export const sha256 = (body: string | Uint8Array): string => createHash('sha256').update(body).digest('hex')
export const enc = (text: string): Buffer => Buffer.from(text, 'utf8')

/* ------------------------------------------------------------------ the home */

export interface LoggedRequest {
  at: number
  method: string
  path: string
  /** The machine whose credential the request carried; null — none. */
  runnerId: string | null
  /** The status home answered with: an upgrade's 101 or its refusal, read off the first line it wrote. */
  status: number | null
  /** A WebSocket upgrade (the tunnel's door, a browser's socket), not a plain request. */
  upgrade?: boolean
}

/**
 * Home's clock in the e2e: the wall clock, and a hand that moves it on.
 *
 * What runs on it: the home's tunnels (MachineTunnels — their liveness, the
 * links, the replacement alert), its class placements and the kernel hooks'
 * timers, and, with `liveness: 'manual'`, the machines' clock passes.
 * `advance(ms)` moves it on: every timer due by then runs, the earliest
 * first, each reading its own due time on the clock — so one that sets itself
 * again (a ping, a liveness check) runs once a period, as it would have — and
 * every timer still to come is due as much sooner on the wall. A scenario
 * lives through a tunnel's dead timer, or a class's failover minute, without
 * waiting for it. What a timer sets off asynchronously runs after the move,
 * on the clock as the move left it. Time moved on is this clock's alone:
 * home's routes read the wall clock (routes.ts · noteCall), so a test moves
 * only what reads this clock.
 */
export class HomeClock implements TunnelClock {
  private offset = 0
  /** While a move runs its timers: the due time of the one running, which is what the clock reads meanwhile. */
  private frozen: number | null = null
  private seq = 0
  private readonly timers = new Map<number, { due: number; run: () => void; handle: NodeJS.Timeout | null }>()

  now(): number {
    return this.frozen ?? Date.now() + this.offset
  }

  setTimeout(run: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { due: this.now() + Math.max(0, ms), run, handle: null })
    this.arm(id)
    return id
  }

  clearTimeout(handle: unknown): void {
    const timer = this.timers.get(handle as number)
    if (!timer) return
    if (timer.handle) clearTimeout(timer.handle)
    this.timers.delete(handle as number)
  }

  /**
   * Move the clock on by `ms`: what falls due by then runs now, the earliest
   * first, each at its own time. While a machine's tunnel is to stay healthy,
   * a scenario moves it in steps of 5 s or less with turns of the event loop
   * between, so that the pings and pongs a step sets off come and go within
   * it: one jump of TUNNEL_QUIET_MS (12 s) or more makes a healthy tunnel
   * quiet until its next frame, and the room hears «Нет связи с машиной»,
   * then that the link came back.
   */
  advance(ms: number): void {
    const end = this.now() + Math.max(0, ms)
    this.frozen = this.now()
    let still = 0
    try {
      for (;;) {
        let next: [number, { due: number }] | null = null
        for (const entry of this.timers) if (entry[1].due <= end && (next === null || entry[1].due < next[1].due)) next = entry
        if (next === null) break
        const at = Math.max(this.frozen, next[1].due)
        // A timer that keeps setting itself at no delay would never let a moved clock rest: past this many, it is a bug of its own.
        still = at === this.frozen ? still + 1 : 0
        if (still > 10_000) throw new Error('the home clock was moved on, and a timer keeps setting itself again at no delay')
        this.frozen = at
        this.fire(next[0])
      }
    } finally {
      this.frozen = null
      this.offset += Math.max(0, ms)
      // What is still to come is due as much sooner on the wall as the clock moved.
      for (const id of this.timers.keys()) this.arm(id)
    }
  }

  /** The wall's timer of one of this clock's, for the time left until it is due. */
  private arm(id: number): void {
    const timer = this.timers.get(id)
    if (!timer) return
    if (timer.handle) clearTimeout(timer.handle)
    // Unref'd, as the process's clock is (shared/remote-tunnel.ts · processClock): a tunnel's ping keeps no test alive.
    timer.handle = setTimeout(() => this.fire(id), Math.max(0, timer.due - this.now()))
    timer.handle.unref()
  }

  private fire(id: number): void {
    const timer = this.timers.get(id)
    if (!timer) return
    this.timers.delete(id)
    if (timer.handle) clearTimeout(timer.handle)
    timer.run()
  }
}

/** The status line home answered an upgrade with, read off the first bytes it writes on the socket: a 101, or the refusal it ended it with. */
function noteStatus(socket: Duplex, entry: LoggedRequest): void {
  const write = socket.write
  const end = socket.end
  const seen = (chunk: unknown): void => {
    socket.write = write
    socket.end = end
    const text = typeof chunk === 'string' ? chunk.slice(0, 16) : chunk instanceof Uint8Array ? Buffer.from(chunk.subarray(0, 16)).toString('latin1') : ''
    const line = /^HTTP\/1\.1 (\d{3})/.exec(text)
    if (line) entry.status = Number(line[1])
  }
  socket.write = function (this: Duplex, ...rest: unknown[]): boolean {
    seen(rest[0])
    return (write as (...args: unknown[]) => boolean).apply(this, rest)
  } as typeof socket.write
  socket.end = function (this: Duplex, ...rest: unknown[]): Duplex {
    if (rest[0] !== undefined && typeof rest[0] !== 'function') seen(rest[0])
    return (end as (...args: unknown[]) => Duplex).apply(this, rest)
  } as typeof socket.end
}

export interface HomeOptions {
  /** The home's clock (a fresh one, at the wall's time, by default). */
  clock?: HomeClock
  /**
   * `auto`: the machines' clock and probe run as index.ts starts them
   * (liveness.ts · startRemoteRunners, on the wall clock). `manual`: only the
   * boot pass runs at each start, and a test runs the clock's passes itself
   * (`tick`, `probe`), on the home's clock.
   */
  liveness?: 'auto' | 'manual'
  /**
   * A class environment's revision as this server's own image of it, which
   * the class placements place on machines (ClassPlacements · revisionOf):
   * the one the test noted (notedRevision) by default.
   */
  revisionOf?: (environment: string) => Promise<EnvironmentRevision | null>
}

/** The token of home's own fake Jupyter (`homeJupyter`), the one the test backend's rooms reach. */
export const HOME_JUPYTER_TOKEN = 'home-fake-jupyter'

/**
 * The public name the home's probe goes by (liveness.ts · probeOwnPath),
 * reserved never to resolve (RFC 2606): no loopback, which the probe refuses,
 * and never a real instance's. Its requests go where `probe` sends them.
 */
const PROBE_URL = 'http://home.e2e.invalid'

export class Home {
  port = 0
  url = ''
  readonly requests: LoggedRequest[] = []
  readonly clock: HomeClock
  /** What this home's tunnels said (MachineTunnels' log), oldest first: for a red test's message, never printed. */
  readonly tunnelLines: string[] = []
  /** What this home's class placements said (ClassPlacements' log), the same way. */
  readonly classLines: string[] = []
  /** Requests to keep from the app: `true` — never handed to it (a path that swallows them), a number — handed to it after that many ms. Upgrades too. */
  stall: ((req: http.IncomingMessage) => boolean | number) | null = null
  private server: http.Server | null = null
  private ownerCookie: string | null = null
  private readonly liveness: 'auto' | 'manual'
  private readonly revisionOf: (environment: string) => Promise<EnvironmentRevision | null>
  /** The sockets upgraded in this life (tunnels, browsers' sockets): the server no longer tracks them, and a crash cuts them. */
  private readonly upgraded = new Set<Duplex>()
  private life: MachineTunnels | null = null
  private classes: ClassPlacements | null = null
  private jupyter: Awaited<ReturnType<typeof startFakeJupyter>> | null = null

  constructor(options: HomeOptions = {}) {
    this.clock = options.clock ?? new HomeClock()
    this.liveness = options.liveness ?? 'auto'
    this.revisionOf = options.revisionOf ?? notedRevision
  }

  /** Whether it listens: a scenario that crashed it and failed before the restart leaves it down. */
  get up(): boolean {
    return this.server !== null
  }

  /** This life's tunnels (the door, the placements' listeners and links); null while the home is down. */
  get tunnels(): MachineTunnels | null {
    return this.life
  }

  /** This life's class placements (kernel/remote/placement.ts), on the home's clock; null while the home is down. */
  get placements(): ClassPlacements | null {
    return this.classes
  }

  async start(port = 0): Promise<void> {
    // A life's own tunnels and placements: a session of their own in every WELCOME, the home's clock, nothing of an earlier life's in memory.
    this.life = new MachineTunnels({ clock: this.clock, log: (line) => this.tunnelLines.push(line) })
    useMachineTunnels(this.life)
    this.classes = new ClassPlacements({ clock: this.clock, revisionOf: this.revisionOf, log: (line) => this.classLines.push(line) })
    usePlacements(this.classes)
    // The kernel hooks get the placement module, on the home's clock, as the server's boot hands it to them: anew in every
    // life, since what they subscribe to is the placements of the moment (placement.ts · onPlacementChange).
    useClassPlacements(placementModule, this.clock)
    // And the machines are heard on that clock (heard.ts · remoteNow): a machine that keeps syncing while a test moves the
    // clock on is heard at the moved time, never silent for a minute it was not. Nothing changes until the clock is moved.
    useRemoteClock(this.clock)
    const server = http.createServer((req, res) => {
      const entry: LoggedRequest = {
        at: Date.now(),
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0]!,
        runnerId: parseRemoteAuthorization(req.headers.authorization)?.runnerId ?? null,
        status: null,
      }
      this.requests.push(entry)
      res.once('finish', () => (entry.status = res.statusCode))
      const stalled = this.stall?.(req) ?? false
      if (stalled === true) return
      if (typeof stalled === 'number' && stalled > 0) {
        // A call its machine gave up on meanwhile (an agent cuts a held sync short on news) never reaches the app: nobody waits for it.
        setTimeout(() => {
          if (!req.destroyed && !res.destroyed) app(req, res)
        }, stalled)
        return
      }
      app(req, res)
    })
    // index.ts's own timeouts: the machines' connections are reused as they are against the real server.
    server.keepAliveTimeout = 130_000
    server.headersTimeout = 135_000
    // index.ts · server.on('upgrade'): the machines' tunnel first, then the browsers' three doors.
    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        // index.ts, in the listen callback: the machines' boot pass and clock first.
        if (this.liveness === 'auto') startRemoteRunners()
        resolve()
      })
    })
    this.port = (server.address() as AddressInfo).port
    this.url = `http://127.0.0.1:${this.port}`
    if (this.liveness === 'manual') {
      // The boot pass alone, on the home's clock: the clock's passes are the test's (`tick`, `probe`).
      await bootRemoteRunners(this.clock.now())
      // And the class placements behind the classes' clock from the start, as startRemoteRunners loads them: not at a class machine's first sync.
      await loadClassPort()
    }
    // Then the queue (index.ts · workerStartup.startExecution): what a previous life cut short, then the pump.
    await reclaimCompetitionQueue()
    startCompetitionPump()
  }

  /** An upgrade, written down as a request is, and held back by `stall` as one is; then the process's own handler. */
  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const entry: LoggedRequest = {
      at: Date.now(),
      method: req.method ?? '',
      path: (req.url ?? '').split('?')[0]!,
      runnerId: parseRemoteAuthorization(req.headers.authorization)?.runnerId ?? null,
      status: null,
      upgrade: true,
    }
    this.requests.push(entry)
    this.upgraded.add(socket)
    socket.once('close', () => this.upgraded.delete(socket))
    noteStatus(socket, entry)
    const stalled = this.stall?.(req) ?? false
    if (stalled === true) return
    if (typeof stalled === 'number' && stalled > 0) {
      setTimeout(() => {
        if (!socket.destroyed && this.server) handleUpgrade(req, socket, head)
      }, stalled)
      return
    }
    handleUpgrade(req, socket, head)
  }

  /**
   * The process dies, as far as the machines can tell: nothing listens on the
   * port, every open connection — a held sync, an upload, a tunnel — is cut,
   * the placements' listeners go, the clock and the pump stop. Synchronous up
   * to the pump, so it can be called from inside a request this very moment
   * (the crash in the middle of an apply).
   *
   * NOT YET THE ROOMS' SIDE OF IT: the runtimes of kernel/index.ts (their
   * kernel clients, pumps, queues and gates) and the documents collab/
   * holds in memory live on into the next life, since neither module has a
   * way to forget them as a dead process would (no Yjs write, no DELETE, no
   * flush). A machine sees a crash; a room does not, so a scenario of a home
   * crash mid-cell (§17.2 D20) waits for those two.
   */
  crash(): Promise<void> {
    const server = this.server
    this.server = null
    server?.close()
    server?.closeAllConnections()
    // Cut, not closed: no close frame leaves a process that died, and the machines' ends hear the socket go.
    for (const socket of this.upgraded) socket.destroy()
    this.upgraded.clear()
    this.life?.shutdown()
    this.life = null
    useMachineTunnels(null)
    // What the placements held in memory dies with the process (its gates and waits let go); their rows stay. The hooks
    // hear nothing of a dead life's placements.
    useClassPlacements(null)
    usePlacements(null)
    this.classes = null
    if (this.liveness === 'auto') stopRemoteRunners()
    return stopCompetitionPump()
  }

  /**
   * A new life on the same DATA_DIR and port. Everything the machines' code
   * keeps in memory, and only that, is what a new process starts without: what
   * was heard of each machine (heard.ts, the boot grace counted from now), the
   * blobs each machine's last reply put in its scope (blobs.ts), the bucket,
   * the stock, the tunnels (a new session: the agents' ends see another home
   * life). What is on disk is as the crash left it.
   */
  async restart(): Promise<void> {
    if (this.server) await this.crash()
    resetHeard(this.clock.now())
    for (const runner of listRunners()) forgetWantScope(runner.id)
    resetBlobBucket()
    forgetStock()
    await this.start(this.port)
  }

  async close(): Promise<void> {
    await this.crash()
    // The machines are heard on the process's clock again: the next file's home brings its own.
    useRemoteClock(null)
    if (this.jupyter) {
      useDefaultEndpointForTest(null)
      await this.jupyter.close()
      this.jupyter = null
    }
  }

  /** One pass of the machines' clock (liveness.ts · remoteTick, the class tick within it), on the home's clock. */
  tick(): ReturnType<typeof remoteTick> {
    return remoteTick(this.clock.now())
  }

  /**
   * The home's probe of its own path through the relay (liveness.ts ·
   * probeOwnPath), on the home's clock, as the relay would carry it: by a
   * public name that leaves the host (PROBE_URL), its requests sent to
   * `through` — a TunnelFault before the home, where relay2 stands, so a
   * scenario cuts or black-holes the path the probe proves — or straight to
   * the home's port. Never the address config.ts would give it, the
   * PUBLIC_URL of a developer's .env, which outranks the test's and names a
   * real instance. Whether the path answered, which is what the classes'
   * liveness then counts as evidence.
   */
  probe(through?: { port: number }): Promise<boolean> {
    const port = through?.port ?? this.port
    const relayed = ((input: string | URL | Request, init?: RequestInit) => {
      const asked = new URL(input instanceof Request ? input.url : String(input))
      return fetch(`http://127.0.0.1:${port}${asked.pathname}${asked.search}`, init)
    }) as typeof fetch
    return probeOwnPath(this.clock.now(), relayed, PROBE_URL, async () => true)
  }

  /**
   * This server's own kernels: a fake Jupyter in this process (interpreted
   * cells, buffering, sessions by path, each in its room's folder under the
   * workspace), made the endpoint of every room the test backend runs at
   * home (KERNEL_BACKEND=test · defaultEndpoint): a class whose slots stay
   * here, or come back here at a failover. Started once; closed with the home.
   */
  async homeJupyter(): Promise<Awaited<ReturnType<typeof startFakeJupyter>>> {
    if (this.jupyter) return this.jupyter
    const workspace = process.env.WORKSPACE_DIR!
    fs.mkdirSync(workspace, { recursive: true })
    const jupyter = await startFakeJupyter({ interpreter: true, buffer: true, deletes: true, perSession: true, cwd: workspace, token: HOME_JUPYTER_TOKEN, guardAnswer })
    this.jupyter = jupyter
    useDefaultEndpointForTest({ url: jupyter.url, token: HOME_JUPYTER_TOKEN })
    return jupyter
  }

  /** The machine join target for a code: COLLOQ_RUNNER_JOIN. */
  joinTarget(code: string): string {
    return `${this.url}#${code}`
  }

  /* -------------------------------------------------------------- the owner */

  private owner(): string {
    if (this.ownerCookie) return this.ownerCookie
    const made = createTeacher({ name: 'Владелица машин e2e', email: `owner.e2e.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
    rotateLinkKey(made.id)
    let value = ''
    issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
    this.ownerCookie = `${STAFF_COOKIE}=${value}`
    return this.ownerCookie
  }

  /** A call through the owner's door. */
  async admin<T>(method: string, at: string, body?: unknown): Promise<{ status: number; body: T }> {
    const answer = await fetch(`${this.url}${at}`, {
      method,
      headers: { cookie: this.owner(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await answer.text()
    return { status: answer.status, body: (text ? JSON.parse(text) : null) as T }
  }

  /**
   * A code minted by the owner in «Подключить машину» (POST
   * /api/admin/runners/codes). One for class machines («Принимать занятия»,
   * D2) is minted as the instance's console mints it (`colloq-host
   * runner-code --classes`, ops/runner-code.ts · mintRemoteCode), until the
   * panel's door takes `classes`.
   */
  async mintCode(options: { trusted?: boolean; approvedSlots?: number | null; machines?: number; classes?: boolean } = {}): Promise<string> {
    if (options.classes) {
      return mintRemoteCode({
        machines: options.machines ?? 1, hours: 1, trusted: false, approvedSlots: options.approvedSlots ?? null, classes: true, createdBy: 'colloq-host',
      }).code
    }
    const minted = await this.admin<{ code: string }>('POST', '/api/admin/runners/codes', {
      machines: options.machines ?? 1, hours: 1, trusted: options.trusted ?? false, approvedSlots: options.approvedSlots ?? null,
    })
    if (minted.status !== 200) throw new Error(`the owner could not mint a code: ${minted.status} ${JSON.stringify(minted.body)}`)
    return minted.body.code
  }

  /** The requests a machine made, by path. */
  requestsOf(runnerId: string): LoggedRequest[] {
    return this.requests.filter((entry) => entry.runnerId === runnerId)
  }
}

/* ---------------------------------------------------------- the competitions */

export interface E2eCompetition {
  id: string
  slug: string
  revisionId: string
  registryRef: string
  /** The open data's files by name, with their sha256. */
  open: Record<string, string>
  /** The hidden test's, when there is one. */
  sealed: Record<string, string>
  solutionSha: string
}

let made = 0

export const SAMPLE = 'id,target\n1,0\n2,0\n'
export const HIDDEN = 'id,feature\n101,hidden-row\n'

/**
 * A live competition the way a teacher leaves one before class: open data
 * (and a hidden test), the answer key, and its environment pinned to a kernel
 * in the fleet's registry — a revision machines may run, its layers the ones
 * a pull of its ref brings. The metric is this server's stand-in's.
 */
export function competition(fleet: Fleet, options: { sealed?: boolean; wallSeconds?: number; perDay?: number; bigFileBytes?: number } = {}): E2eCompetition {
  made += 1
  const tag = `${process.pid}-${made}-${randomBytes(3).toString('hex')}`
  const created = createCompetition({
    slug: `machines-e2e-${made}-${randomBytes(2).toString('hex')}`,
    title: `Машины e2e ${made}`,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    limits: { wallSeconds: options.wallSeconds ?? 600, memoryMb: 512, cpus: 1, perDay: options.perDay ?? 0 },
    environment: 'base',
  })
  if (!created) throw new Error('the competition could not be created')
  setCompetitionState(created.id, 'live')
  const open: Record<string, string> = {}
  const files: Array<[string, Buffer]> = [['train.csv', enc(`id,feature\n1,0.5\n2,0.7\n# ${tag}\n`)], ['sample_submission.csv', enc(SAMPLE)]]
  // A file that takes a while to fetch at the owner's least «Скорость раздачи»: its rows, then filler up to the size asked.
  if (options.bigFileBytes) files.push(['big.csv', Buffer.concat([enc(`id,blob\n# ${tag}\n`), Buffer.alloc(options.bigFileBytes, 'x')])])
  for (const [name, body] of files) {
    const stored = putOpenFile(created.id, name, body)
    putFile({ competitionId: created.id, name, bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
    open[name] = stored.sha256
  }
  const solution = enc(`id,target\n1,1\n2,2\n# ${tag}\n`)
  putSecretFile(created.id, 'solution.csv', solution)
  putFile({ competitionId: created.id, name: 'solution.csv', bytes: solution.length, visibility: 'hidden' })
  const sealed: Record<string, string> = {}
  if (options.sealed) {
    const hidden = putSealedFile(created.id, 'test.csv', enc(`${HIDDEN}# ${tag}\n`))
    putFile({ competitionId: created.id, name: 'test.csv', bytes: hidden.bytes, visibility: 'sealed', sha256: hidden.sha256 })
    sealed['test.csv'] = hidden.sha256
  }
  const kernel = kernelRevision(fleet, 'base', tag)
  selectRevision(created.id, kernel.revisionId)
  forgetStock()
  return { id: created.id, slug: created.slug, revisionId: kernel.revisionId, registryRef: kernel.registryRef, open, sealed, solutionSha: sha256(solution) }
}

/**
 * A kernel revision machines can run: its image in the fleet's registry
 * (what a pull of its ref brings, its layers), noted at home with that pin —
 * a portable revision (want.ts · portableRevision), as a competition's
 * notebooks and a class's kernels on machines start from one.
 */
export function kernelRevision(fleet: Fleet, environment = 'base', tag = `${process.pid}-${randomBytes(4).toString('hex')}`): { revisionId: string; registryRef: string; layers: string } {
  const diffIds = [`sha256:${sha256(`layer one ${tag}`)}`, `sha256:${sha256(`layer two ${tag}`)}`]
  const kernel = publishKernel(fleet, `ghcr.io/colloq-edu/colloq-kernel@sha256:${sha256(`kernel ${tag}`)}`, diffIds)
  const revision = putRevision({
    environmentName: environment, imageDigest: `sha256:${sha256(`image ${tag}`)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/amd64', packages: [{ name: 'numpy', version: '2.4.6' }], baseConstraintsHash: 'hash',
  })
  if (!noteRevisionImage(revision.id, { registryRef: kernel.ref, layers: kernel.layers })) throw new Error('the revision\'s image could not be noted')
  return { revisionId: revision.id, registryRef: kernel.ref, layers: kernel.layers }
}

/** A notebook of `cells` code cells, the first one carrying the runners' directive (fake-runner.ts · DIRECTIVE). */
export function notebook(directive: Record<string, unknown> | null, cells = 2): Buffer {
  const sources = Array.from({ length: cells }, (_, index) => (index === 0 && directive ? `# colloq-test: ${JSON.stringify(directive)}\nx = 1` : `y${index} = ${index}`))
  return enc(JSON.stringify({
    cells: sources.map((source) => ({ cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null })),
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }))
}

/** This server runs notebooks itself, or only scores («Тетради на этом сервере»). */
export function homeNotebooks(on: boolean): void {
  saveCompetitionSettings({ homeNotebooks: on })
  wakeCompetitionPump()
}

/** An empty queue, running, and only the machines running notebooks. */
export function quietQueue(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  homeNotebooks(false)
}

/* ------------------------------------------------------------ a participant */

/** A participant, through the participant's own doors only. */
export class Entrant {
  cookie = ''
  readonly name: string

  constructor(readonly home: Home, readonly competition: E2eCompetition, name?: string) {
    this.name = name ?? `@e2e_${randomBytes(4).toString('hex')}`
  }

  private async call<T>(method: string, at: string, init: { json?: unknown; form?: FormData } = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const answer = await fetch(`${this.home.url}${at}`, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
    })
    const text = await answer.text()
    return { status: answer.status, body: (text ? JSON.parse(text) : null) as T, headers: answer.headers }
  }

  /** «Участвовать»: a newcomer gets a key and a cookie. */
  async join(): Promise<this> {
    const joined = await this.call<{ entrant: { id: string } | null }>('POST', `/api/k/competitions/${this.competition.slug}/join`, { json: { name: this.name } })
    if (joined.status !== 200) throw new Error(`the join door refused ${this.name}: ${joined.status} ${JSON.stringify(joined.body)}`)
    const cookie = joined.headers.getSetCookie().map((line) => line.split(';')[0]!).find(Boolean)
    if (!cookie) throw new Error('the join door set no cookie')
    this.cookie = cookie
    return this
  }

  /** Send a notebook as the page does (multipart, field `file`). */
  async submit(body: Buffer): Promise<SubmissionAccepted['submission']> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(body)], { type: 'application/x-ipynb+json' }), 'solution.ipynb')
    const sent = await this.call<SubmissionAccepted>('POST', `/api/k/competitions/${this.competition.slug}/submissions`, { form })
    if (sent.status !== 200) throw new Error(`the upload door refused ${this.name}: ${sent.status} ${JSON.stringify(sent.body)}`)
    return sent.body.submission
  }

  async submissions(): Promise<EntrantSubmissions> {
    const listed = await this.call<EntrantSubmissions>('GET', `/api/k/competitions/${this.competition.slug}/submissions`)
    if (listed.status !== 200) throw new Error(`the list door refused ${this.name}: ${listed.status}`)
    return listed.body
  }

  async submission(id: string): Promise<EntrantSubmissions['submissions'][number]> {
    const found = (await this.submissions()).submissions.find((one) => one.id === id)
    if (!found) throw new Error(`${this.name} does not see submission ${id}`)
    return found
  }

  async cancel(id: string): Promise<number> {
    return (await this.call('POST', `/api/k/competitions/${this.competition.slug}/submissions/${id}/cancel`)).status
  }
}

/* ----------------------------------------------------------------- waiting */

/** Poll until `check` gives a value, or fail with `what` (and `detail` for the reader of a red test). */
export async function until<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 15_000, detail: () => string = () => ''): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${detail() ? `\n${detail()}` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

