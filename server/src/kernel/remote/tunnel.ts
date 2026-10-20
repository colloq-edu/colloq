/**
 * Home's end of the machines' tunnels («занятия на машинах»,
 * docs/architecture/remote-classes.md §4.2, §4.5): the door a machine dials,
 * one tunnel per machine, a loopback listener per placement whose
 * connections become streams of that machine's tunnel, and the link each
 * placement's kernel client reads.
 *
 * HOME STAYS THE JUPYTER CLIENT. JupyterKernel and the terminal talk to a
 * placement as to any Jupyter, at `http://127.0.0.1:<port>`: every TCP
 * connection accepted there is OPENed on the machine's tunnel, and the agent
 * connects it to the placement's own loopback port, the one it read itself.
 * The tunnel carries bytes and nothing else (D1); the frames and their rules
 * are shared/remote-tunnel.ts's, the same at both ends (TunnelEnd).
 *
 * THE DOOR is `GET /api/runners/v1/tunnel` with Upgrade, matched by the
 * upgrade handler before the browsers' Origin rule (upgrade.ts): a machine
 * sends no Origin and no cookie. It takes nothing but a machine's
 * credential, `Authorization: Bearer cr1.<id>.<secret>` in a header no
 * browser can set (store.ts · authenticateRunner), of a machine that may
 * still call and takes classes, in this tunnel protocol, at most
 * TUNNEL_UPGRADES a minute from one address. Every refusal comes before the
 * upgrade, as marked JSON the way the machines' other doors answer
 * (TUNNEL_REFUSALS), so the agent can tell home's word from the relay's
 * page. The browsers' doors keep refusing this credential
 * (socket-authorization.ts · upgradeToken). The HELLO reads the machine
 * again, and so does an open tunnel's traffic every TUNNEL_PING_MS.
 *
 * NOT THE DOOR'S: the class quarantine and the build. Both hold back new
 * placements only (§6.3, §11.6, D32; for leases routes.ts · syncReply), and
 * a quarantined or outdated machine keeps serving the placements it holds.
 * Its tunnel is how they are reached, across every reconnect that a relay
 * restart, a home update or a blip brings: refusing it would fail those
 * classes over once the tunnel is stuck (§11.1) and lose their variables,
 * for a rule about the next placement.
 *
 * ONE TUNNEL PER MACHINE. A newer tunnel's HELLO closes the one it replaces
 * with TUNNEL_CLOSE.replaced, and the machine's log gets `tunnel_replaced`
 * with both addresses: a machine reconnecting through a cut its old socket
 * has not noticed yet replaces itself from its own address (a few lines an
 * hour of that, TUNNEL_SELF_REPLACEMENTS_LOGGED), while two hosts holding
 * one secret take it over from each other's, every time written, and more
 * than TUNNEL_REPLACEMENTS_ALERT of those raise the owner's banner
 * (tunnelReplacementAlert, counted from the log).
 *
 * WHILE A MACHINE'S TUNNEL IS DOWN its placements' listeners stay, and every
 * connection to them is reset at once: a fast ECONNRESET, never a hang, for
 * the kernel client's liveness question (jupyter.ts · confirmAlive) and its
 * reconnects, which wait on the link (KernelLink.next) instead of spending
 * their attempts.
 */
import http, { type IncomingMessage } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  REMOTE_API_ROOT,
  REMOTE_MARKER,
  REMOTE_MARKER_HEADER,
  REMOTE_PROTOCOL,
  REMOTE_PROTOCOL_HEADER,
  REMOTE_REASON_CHARS,
  parseRemoteAuthorization,
  remoteText,
} from '@shared/remote-runner'
import { parseRemotePlacementKey } from '@shared/remote-kernels'
import {
  TUNNEL_CLOSE,
  TUNNEL_MESSAGE_MAX,
  TUNNEL_PATH,
  TUNNEL_PING_MS,
  TUNNEL_PROTOCOL,
  TUNNEL_PROTOCOL_HEADER,
  TUNNEL_REFUSALS,
  TUNNEL_REPLACEMENTS_ALERT,
  TUNNEL_SELF_REPLACEMENTS_LOGGED,
  TUNNEL_UPGRADES,
  TunnelEnd,
  TunnelRtt,
  pipeTcp,
  processClock,
  resetTcp,
  tunnelLocalOf,
  tunnelSocketOf,
  type TunnelClock,
  type TunnelDoorRefusal,
  type TunnelHello,
} from '@shared/remote-tunnel'
import type { KernelLink } from '../jupyter.js'
import { clientAddress } from '../../net/inbound.js'
import { tooOften } from '../../net/too-often.js'
import { noteCall } from '../../competitions/remote/heard.js'
import { callCounts } from '../../competitions/remote/routes.js'
import { authenticateRunner, getRunner, homeRunnerBuild, remoteEvent, runnerEventsOf, runnerStanding, type RunnerRow } from '../../competitions/remote/store.js'

/* ---------------------------------------------------------------- the door */

/** `/api/runners/v<n>/tunnel`: the tunnel's path in every version of the machines' router. */
const TUNNEL_ROUTE = new RegExp(`^${REMOTE_API_ROOT}/v([0-9]{1,6})/${TUNNEL_PATH}/?$`)

/** The version of the machines' router a request's path names for the tunnel; null — not the tunnel's path. */
function tunnelVersion(url: string | undefined): number | null {
  const match = TUNNEL_ROUTE.exec((url ?? '').split('?')[0] ?? '')
  return match ? Number(match[1]) : null
}

/** Why a machine that may call home holds no tunnel: its classes are off. Null — it may hold one. */
function classesRefusal(runner: RunnerRow): string | null {
  return runner.classes ? null : 'This machine does not take classes: its owner has them off'
}

/**
 * Why a machine may hold no tunnel now, by its row as it is: revoked or
 * gone, or its classes off (the HELLO's check, and an open tunnel's). Null —
 * it may.
 */
function standingRefusal(runnerId: string): { code: number; reason: string } | null {
  const runner = getRunner(runnerId)
  if (!runner || !runnerStanding(runner)) return { code: TUNNEL_CLOSE.unauthorized, reason: 'The machine may no longer call home' }
  const refused = classesRefusal(runner)
  return refused ? { code: TUNNEL_CLOSE.forbidden, reason: refused } : null
}

/** The marked JSON refusal of an upgrade (TUNNEL_REFUSALS), written on the raw socket before anything was upgraded. */
function refuseUpgrade(socket: Duplex, error: TunnelDoorRefusal | 'failed', detail?: string, retryAfterS?: number): void {
  const status = error === 'failed' ? 500 : TUNNEL_REFUSALS[error]
  const body = JSON.stringify({ error, ...(detail ? { detail: remoteText(detail, REMOTE_REASON_CHARS, 'start') } : {}) })
  const head = [
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    `${REMOTE_MARKER_HEADER}: ${REMOTE_MARKER}`,
    `${REMOTE_PROTOCOL_HEADER}: ${REMOTE_PROTOCOL}`,
    `${TUNNEL_PROTOCOL_HEADER}: ${TUNNEL_PROTOCOL}`,
    ...(retryAfterS !== undefined ? [`Retry-After: ${retryAfterS}`] : []),
  ]
  socket.once('finish', () => socket.destroy())
  socket.end(`${head.join('\r\n')}\r\n\r\n${body}`)
}

/** A close frame's reason within its 123 bytes. */
const closeReason = (reason: string): string => Buffer.from(reason, 'utf8').subarray(0, 120).toString('utf8').replace(/�+$/, '')

/* ----------------------------------------------------------------- tunnels */

/** One machine's tunnel at home. */
interface HomeTunnel {
  readonly runnerId: string
  /** Where it came from, as the replacement's log line names it (net/inbound.ts · clientAddress). */
  readonly address: string | null
  readonly ws: WebSocket
  readonly end: TunnelEnd
  /** The agent's session, from its HELLO: one per agent life (§4.3). */
  session: string | null
  /** When its machine's row was last read for it: at the door, at the HELLO, then as its frames come (recheck). */
  checkedAt: number
}

/** A placement's listener on 127.0.0.1. */
interface Listener {
  readonly id: string
  readonly runnerId: string
  readonly key: string
  readonly gen: number
  readonly server: net.Server
  readonly sockets: Set<net.Socket>
  readonly ready: Promise<{ port: number; close(): void }>
  closed: boolean
}

type LinkAnswer = 'up' | 'lost' | 'timeout'

/** The placements whose loss is remembered for their links: far more than live at once, and each a few bytes. */
const LOST_KEPT = 4096

/** One placement at one gen, as the listeners, links and waiters key it. */
const placementId = (runnerId: string, key: string, gen: number): string => `${runnerId}\0${key}\0${gen}`

/** A machine's upgrades from one address, as the door counts them (TUNNEL_UPGRADES). */
const upgradesOf = (runnerId: string, address: string | null): string => `${runnerId}\0${address ?? ''}`

export interface MachineTunnelsOptions {
  /** The clock of the tunnels' liveness, links and alert; the process's by default. */
  clock?: TunnelClock
  log?: (line: string) => void
}

/**
 * The tunnels of this home: the door, one tunnel per machine, the
 * placements' listeners and links. One per process (machineTunnels); tests
 * make their own, each with its own door to attach.
 */
export class MachineTunnels {
  private readonly clock: TunnelClock
  private readonly log: (line: string) => void
  private readonly server = new WebSocketServer({
    noServer: true,
    // Outputs are mostly images and JSON that are compressed already, and a frame is small (§4.2).
    perMessageDeflate: false,
    maxPayload: TUNNEL_MESSAGE_MAX,
    clientTracking: false,
  })
  /** This home life's session, in every WELCOME. */
  private readonly session = randomBytes(16).toString('hex')
  /** Each machine's tunnel, from its HELLO on. */
  private readonly current = new Map<string, HomeTunnel>()
  /** Tunnels upgraded and not yet greeted. */
  private readonly pending = new Set<HomeTunnel>()
  private readonly listeners = new Map<string, Listener>()
  private readonly links = new Map<string, PlacementLink>()
  private readonly lostAt = new Map<string, number>()
  private readonly waiters = new Map<string, { runnerId: string; wake: Set<(answer: LinkAnswer) => void> }>()
  /** Whether each machine's tunnel is up, and since when. */
  private readonly states = new Map<string, { up: boolean; since: number }>()
  private readonly rtts = new Map<string, TunnelRtt>()
  /** Upgrades by machine and address (upgradesOf), and each machine's lines of replacing itself (TUNNEL_SELF_REPLACEMENTS_LOGGED). */
  private readonly upgrades = new Map<string, number[]>()
  private readonly selfReplaced = new Map<string, number[]>()
  private readonly changes = new Set<(runnerId: string, up: boolean) => void>()
  private readonly startedAt: number

  constructor(options: MachineTunnelsOptions = {}) {
    this.clock = options.clock ?? processClock
    this.log = options.log ?? ((line) => console.log(line))
    this.startedAt = this.clock.now()
    // The 101 says it is home's, as every refusal of the door does: the agent checks it before its HELLO.
    this.server.on('headers', (headers) => {
      headers.push(`${REMOTE_MARKER_HEADER}: ${REMOTE_MARKER}`, `${TUNNEL_PROTOCOL_HEADER}: ${TUNNEL_PROTOCOL}`)
    })
  }

  /**
   * The upgrade handler's first look (upgrade.ts): true when the request is
   * for the tunnel's path, which it then answers whatever the answer, with
   * a refusal or the tunnel; false — not the tunnel's, and untouched.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const version = tunnelVersion(req.url)
    if (version === null) return false
    try {
      this.door(req, socket, head, version)
    } catch (error) {
      this.log(`[tunnel] an upgrade failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      if (!socket.destroyed) refuseUpgrade(socket, 'failed')
    }
    return true
  }

  private door(req: IncomingMessage, socket: Duplex, head: Buffer, version: number): void {
    // Another version of the router: the machine needs the release home runs (routes.ts · remoteOtherVersions).
    if (version !== REMOTE_PROTOCOL) {
      return refuseUpgrade(socket, 'protocol', `This home speaks protocol ${REMOTE_PROTOCOL} of the machines' router; the machine needs the release home runs`)
    }
    const credential = parseRemoteAuthorization(req.headers.authorization)
    const runner = credential ? authenticateRunner(credential.runnerId, credential.secret) : null
    if (!runner) {
      // Counted with the machines' other doors (routes.ts · machine): guessing at this one shows on the same counter.
      callCounts.unauthorized++
      return refuseUpgrade(socket, 'unauthorized')
    }
    const address = clientAddress(req)
    // By machine and address: a holder of the secret elsewhere spends its own tries, never the machine's (TUNNEL_UPGRADES).
    const bucket = upgradesOf(runner.id, address)
    if (tooOften(this.upgrades, bucket, TUNNEL_UPGRADES.windowMs, TUNNEL_UPGRADES.count)) {
      const oldest = this.upgrades.get(bucket)?.[0] ?? Date.now()
      return refuseUpgrade(socket, 'too_often', undefined, Math.max(1, Math.ceil((oldest + TUNNEL_UPGRADES.windowMs - Date.now()) / 1000)))
    }
    if (req.headers[TUNNEL_PROTOCOL_HEADER.toLowerCase()] !== String(TUNNEL_PROTOCOL)) {
      return refuseUpgrade(socket, 'protocol', `This home speaks tunnel protocol ${TUNNEL_PROTOCOL} (${TUNNEL_PROTOCOL_HEADER})`)
    }
    const refused = classesRefusal(runner)
    if (refused) return refuseUpgrade(socket, 'forbidden', refused)
    // TCP_NODELAY on home's side of the leg: a keystroke's frame never waits for the next one (§4.2).
    if (socket instanceof net.Socket) socket.setNoDelay(true)
    this.server.handleUpgrade(req, socket, head, (ws) => this.adopt(ws, runner.id, address))
  }

  private adopt(ws: WebSocket, runnerId: string, address: string | null): void {
    const end: TunnelEnd = new TunnelEnd({
      side: 'home',
      socket: tunnelSocketOf(ws),
      clock: this.clock,
      build: homeRunnerBuild(),
      session: this.session,
      hooks: {
        hello: (hello) => this.greet(tunnel, hello),
        up: () => this.opened(tunnel),
        // Every frame is the machine heard, and the path to it working (§4.7).
        heard: () => noteCall(runnerId, this.clock.now(), address),
        rtt: (ms) => this.rttOf(runnerId).add(ms, this.clock.now()),
        end: (code, reason) => (code === null ? ws.terminate() : ws.close(code, closeReason(reason))),
      },
    })
    const tunnel: HomeTunnel = { runnerId, address, ws, end, session: null, checkedAt: this.clock.now() }
    this.pending.add(tunnel)
    ws.on('message', (data, binary) => {
      this.recheck(tunnel)
      end.receive(data, binary)
    })
    // 'close' follows every error.
    ws.on('error', () => undefined)
    ws.on('close', (code) => this.dropped(tunnel, code))
    end.start()
  }

  /**
   * The agent's HELLO: the machine as it is now, then the tunnel takes its
   * machine's place. The build it names is not refused, whatever it is
   * (NOT THE DOOR'S, above); the frames it may send are TUNNEL_PROTOCOL's,
   * which its HELLO's codec has checked.
   */
  private greet(tunnel: HomeTunnel, hello: TunnelHello): { code: number; reason: string } | null {
    const refused = standingRefusal(tunnel.runnerId)
    if (refused) return refused
    tunnel.checkedAt = this.clock.now()
    tunnel.session = hello.session
    this.pending.delete(tunnel)
    const older = this.current.get(tunnel.runnerId)
    this.current.set(tunnel.runnerId, tunnel)
    if (older) this.replace(older, tunnel)
    return null
  }

  /**
   * An open tunnel's machine read again, at most every TUNNEL_PING_MS as its
   * frames come, before the next one is taken: revoked, it closes with
   * TUNNEL_CLOSE.unauthorized, its classes off with forbidden. Revoke and
   * unclass close it at once themselves (close, §11.5); this is the
   * backstop for a path that did not, so that a machine no longer allowed is
   * not heard through its tunnel for long. A silent tunnel needs none: it is
   * dead in TUNNEL_DEAD_MS.
   */
  private recheck(tunnel: HomeTunnel): void {
    const now = this.clock.now()
    if (now - tunnel.checkedAt < TUNNEL_PING_MS || tunnel.end.closed) return
    tunnel.checkedAt = now
    const refused = standingRefusal(tunnel.runnerId)
    if (!refused) return
    this.log(`[tunnel] machine ${tunnel.runnerId}: ${refused.reason}; its tunnel is closed`)
    tunnel.end.close()
    tunnel.ws.close(refused.code, closeReason(refused.reason))
  }

  private replace(older: HomeTunnel, newer: HomeTunnel): void {
    const now = this.clock.now()
    // Every takeover from another address is written: it is the evidence the alert counts. A machine replacing itself from
    // the address it had is its own doing, as often as it likes, and a few lines of it are enough (TUNNEL_SELF_REPLACEMENTS_LOGGED).
    const takeover = newer.address !== older.address
    const { count, windowMs } = TUNNEL_SELF_REPLACEMENTS_LOGGED
    if (takeover || !tooOften(this.selfReplaced, newer.runnerId, windowMs, count)) {
      remoteEvent(newer.runnerId, 'tunnel_replaced', { address: newer.address, detail: older.address }, now)
      const same = newer.session === older.session ? 'the same agent' : 'another agent life'
      this.log(`[tunnel] machine ${newer.runnerId}: a newer tunnel from ${newer.address ?? 'an unknown address'} (${same}) replaces the one from ${older.address ?? 'an unknown address'}`)
    }
    older.end.close()
    older.ws.close(TUNNEL_CLOSE.replaced, 'Replaced by a newer tunnel of this machine')
  }

  private opened(tunnel: HomeTunnel): void {
    if (this.current.get(tunnel.runnerId) !== tunnel) return
    if (this.states.get(tunnel.runnerId)?.up !== true) this.log(`[tunnel] machine ${tunnel.runnerId} up from ${tunnel.address ?? 'an unknown address'}`)
    this.changed(tunnel.runnerId, true)
  }

  private dropped(tunnel: HomeTunnel, code: number): void {
    tunnel.end.close()
    this.pending.delete(tunnel)
    if (this.current.get(tunnel.runnerId) !== tunnel) return
    this.current.delete(tunnel.runnerId)
    this.log(`[tunnel] machine ${tunnel.runnerId} down (${code})`)
    this.changed(tunnel.runnerId, false)
  }

  private changed(runnerId: string, up: boolean): void {
    if (this.states.get(runnerId)?.up === up) return
    this.states.set(runnerId, { up, since: this.clock.now() })
    for (const listener of [...this.changes]) {
      try {
        listener(runnerId, up)
      } catch (error) {
        this.log(`[tunnel] a listener of machine ${runnerId}'s tunnel failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!up) return
    for (const [id, waiting] of [...this.waiters]) {
      if (waiting.runnerId !== runnerId) continue
      for (const wake of [...waiting.wake]) wake(this.lostAt.has(id) ? 'lost' : 'up')
    }
  }

  /** Whether a machine's tunnel is open now. */
  isUp(runnerId: string): boolean {
    return this.current.get(runnerId)?.end.up === true
  }

  /** When a machine's tunnel last went up or down; this home life's start, if never. */
  since(runnerId: string): number {
    return this.states.get(runnerId)?.since ?? this.startedAt
  }

  /** A machine's round trip through its tunnel: the average of its PONGs and their p95 over five minutes (§4.5). */
  rtt(runnerId: string): { ewmaMs: number | null; p95Ms: number | null } {
    const rtt = this.rtts.get(runnerId)
    return { ewmaMs: rtt?.ewmaMs ?? null, p95Ms: rtt?.p95Ms(this.clock.now()) ?? null }
  }

  private rttOf(runnerId: string): TunnelRtt {
    let rtt = this.rtts.get(runnerId)
    if (!rtt) {
      rtt = new TunnelRtt()
      this.rtts.set(runnerId, rtt)
    }
    return rtt
  }

  /** Called with every machine whose tunnel goes up or down; returns what stops it. */
  onChange(listener: (runnerId: string, up: boolean) => void): () => void {
    this.changes.add(listener)
    return () => this.changes.delete(listener)
  }

  /** Close a machine's tunnel, open or greeting, with `code`: a revoke (TUNNEL_CLOSE.unauthorized), its classes turned off (forbidden). */
  close(runnerId: string, code: number, reason: string): void {
    const tunnels = [...this.pending].filter((tunnel) => tunnel.runnerId === runnerId)
    const current = this.current.get(runnerId)
    if (current) tunnels.push(current)
    for (const tunnel of tunnels) {
      tunnel.end.close()
      tunnel.ws.close(code, closeReason(reason))
    }
  }

  /**
   * Whether a machine's tunnel was taken over more than
   * TUNNEL_REPLACEMENTS_ALERT.count times within its window, each from an
   * address other than the one it took over from: the owner's banner (§4.2).
   * Counted from the machine's log, where every such takeover is written
   * with both addresses, so that a restart of this home forgets none of
   * them (store.ts · runnerEventsOf).
   */
  tunnelReplacementAlert(runnerId: string): boolean {
    const { count, windowMs } = TUNNEL_REPLACEMENTS_ALERT
    // Within the window, as a sliding window counts: a line exactly windowMs old is out of it.
    const lines = runnerEventsOf(runnerId, ['tunnel_replaced'], this.clock.now() - windowMs + 1)
    return lines.filter((line) => line.address !== line.detail).length > count
  }

  /* ---------------------------------------------------------- listeners */

  /**
   * The listener of a placement: 127.0.0.1 on a port of the system's
   * choosing, whose every connection is a stream to that placement through
   * its machine's tunnel. One per placement: asked again, the same. `close`
   * stops it and resets the connections it still carries.
   */
  listen(runnerId: string, key: string, gen: number): Promise<{ port: number; close(): void }> {
    const id = placementId(runnerId, key, gen)
    const existing = this.listeners.get(id)
    if (existing && !existing.closed) return existing.ready
    if (parseRemotePlacementKey(key) === null || !Number.isSafeInteger(gen) || gen < 1) return Promise.reject(new Error(`Not a placement: ${key} at gen ${gen}`))
    // Half-open as TCP is: a client's end is the stream's END, and the answer still comes back after it.
    const server = net.createServer({ allowHalfOpen: true })
    const ready = new Promise<{ port: number; close(): void }>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', (error) => this.log(`[tunnel] the listener of ${key} at gen ${gen} failed: ${error.message}`))
        const address = server.address()
        resolve({ port: typeof address === 'object' && address ? address.port : 0, close: () => this.unlisten(listener) })
      })
    })
    const listener: Listener = { id, runnerId, key, gen, server, sockets: new Set(), ready, closed: false }
    server.on('connection', (socket) => this.accept(listener, socket))
    this.listeners.set(id, listener)
    ready.catch(() => {
      if (this.listeners.get(id) === listener) this.listeners.delete(id)
    })
    return ready
  }

  private unlisten(listener: Listener): void {
    if (listener.closed) return
    listener.closed = true
    if (this.listeners.get(listener.id) === listener) this.listeners.delete(listener.id)
    // Its link's view may go: a holder keeps the one it has, and a loss is remembered apart (lostAt).
    this.links.delete(listener.id)
    listener.server.close()
    for (const socket of listener.sockets) resetTcp(socket)
    listener.sockets.clear()
  }

  /** A connection to a placement's listener: a stream on its machine's tunnel, or a reset at once while there is none. */
  private accept(listener: Listener, socket: net.Socket): void {
    socket.on('error', () => undefined)
    socket.setNoDelay(true)
    const tunnel = this.current.get(listener.runnerId)
    const open = !listener.closed && !this.lostAt.has(listener.id) && tunnel?.end.up === true
    const stream = open ? tunnel.end.open(listener.key, listener.gen, tunnelLocalOf(socket)) : null
    if (!tunnel || !stream) return resetTcp(socket)
    listener.sockets.add(socket)
    socket.on('close', () => listener.sockets.delete(socket))
    pipeTcp(tunnel.end, stream, socket)
  }

  /* -------------------------------------------------------------- links */

  /** What a placement's kernel client reads of its machine's tunnel (KernelEndpoint.link). */
  link(runnerId: string, key: string, gen: number): KernelLink {
    const id = placementId(runnerId, key, gen)
    let found = this.links.get(id)
    if (!found) {
      found = new PlacementLink(this, id, runnerId)
      this.links.set(id, found)
    }
    return found
  }

  /** Home declared the placement lost (failover, §11.2): its link answers `lost` from now on, and its listener takes no more connections. */
  lost(runnerId: string, key: string, gen: number): void {
    const id = placementId(runnerId, key, gen)
    if (this.lostAt.has(id)) return
    this.lostAt.set(id, this.clock.now())
    for (const old of this.lostAt.keys()) {
      if (this.lostAt.size <= LOST_KEPT) break
      this.lostAt.delete(old)
    }
    for (const wake of [...(this.waiters.get(id)?.wake ?? [])]) wake('lost')
  }

  /** For the links: when the placement was declared lost; null — it was not. */
  lostSince(id: string): number | null {
    return this.lostAt.get(id) ?? null
  }

  /** For the links: the next of `up` and `lost` for one placement, or `timeout`. */
  wait(id: string, runnerId: string, timeoutMs: number): Promise<LinkAnswer> {
    return new Promise((resolve) => {
      let waiting = this.waiters.get(id)
      if (!waiting) {
        waiting = { runnerId, wake: new Set() }
        this.waiters.set(id, waiting)
      }
      const entry = waiting
      let timer: unknown = null
      const wake = (answer: LinkAnswer): void => {
        if (timer !== null) this.clock.clearTimeout(timer)
        entry.wake.delete(wake)
        if (entry.wake.size === 0 && this.waiters.get(id) === entry) this.waiters.delete(id)
        resolve(answer)
      }
      entry.wake.add(wake)
      timer = this.clock.setTimeout(() => wake('timeout'), Math.max(0, timeoutMs))
    })
  }

  /** This home stops: every tunnel closes as a server going away, and every listener with it. */
  shutdown(): void {
    for (const listener of [...this.listeners.values()]) this.unlisten(listener)
    for (const tunnel of [...this.pending, ...this.current.values()]) {
      tunnel.end.close()
      tunnel.ws.close(1001, 'Home is shutting down')
    }
  }
}

/**
 * A placement's link: a view of its machine's tunnel and of the
 * placement's loss, read when asked. Its `next` answers at once when the
 * link is up or lost already, so a caller that read `up` false a moment ago
 * cannot miss the tunnel coming back in between.
 */
class PlacementLink implements KernelLink {
  constructor(
    private readonly owner: MachineTunnels,
    private readonly id: string,
    private readonly runnerId: string,
  ) {}

  get up(): boolean {
    return this.owner.lostSince(this.id) === null && this.owner.isUp(this.runnerId)
  }

  get rttMs(): number | null {
    return this.owner.rtt(this.runnerId).ewmaMs
  }

  get since(): number {
    return this.owner.lostSince(this.id) ?? this.owner.since(this.runnerId)
  }

  next(timeoutMs: number): Promise<LinkAnswer> {
    if (this.owner.lostSince(this.id) !== null) return Promise.resolve('lost')
    if (this.owner.isUp(this.runnerId)) return Promise.resolve('up')
    return this.owner.wait(this.id, this.runnerId, timeoutMs)
  }
}

let tunnels: MachineTunnels | null = null

/** This process's tunnels: the upgrade handler's door, the placements' listeners and links, the panel's alert. */
export function machineTunnels(): MachineTunnels {
  tunnels ??= new MachineTunnels()
  return tunnels
}

/** For tests: the process's tunnels become these (an e2e home's, on its own clock); null — a fresh default at the next use. */
export function useMachineTunnels(next: MachineTunnels | null): void {
  tunnels = next
}

/** Whether a machine's tunnel was taken over often enough, from other addresses, to warn its owner (§4.2). */
export function tunnelReplacementAlert(runnerId: string): boolean {
  return machineTunnels().tunnelReplacementAlert(runnerId)
}
