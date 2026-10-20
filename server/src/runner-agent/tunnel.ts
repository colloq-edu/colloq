/**
 * The machine's end of its tunnel to home («занятия на машинах»,
 * docs/architecture/remote-classes.md §4.6): the one WebSocket the agent
 * dials while home says it holds placements here, and the streams home opens
 * on it, each connected to a placement's Jupyter on this machine's loopback.
 *
 * DIALLED WHILE HOME WANTS IT. The sync loop hands every reply's
 * `kernels.tunnel` to `want`: `open` dials and keeps the tunnel up,
 * `reconnect` is home seeing no tunnel of this machine's (a socket the path
 * dropped without a word is ended and dialled again), `closed` hangs up. The
 * loop says `state().up` back as `kernels.tunnel`. Control stays on the sync
 * (D1): no verb rides here, only bytes.
 *
 * THE STREAMS ARE HOME'S, THE PORTS ARE THE AGENT'S. Home OPENs a stream by a
 * placement's key and gen, never by an address. The kernel host's own record
 * says whether that placement is held at that gen and on which loopback port
 * its Jupyter listens (`resolve`), and the stream connects to 127.0.0.1 on
 * that port and nowhere else: nothing on this machine but the placements'
 * Jupyters is reachable through the tunnel, whatever home sends (§12). An
 * older gen is refused `stale`, an unknown placement `gone`, one not ready
 * `starting`.
 *
 * RECONNECTS. Five quick tries, 0.5 to 5 s, then the 0.23 backoff, 1 to 30 s
 * with jitter (client.ts · Backoff); a refusal of home's own (a marked 401,
 * 403 or 426, a close of the tunnel's own codes) goes straight to the slow
 * one, and a 429's Retry-After is its least. Between tries the relay is asked
 * whether home is offline (client.ts · relayState), for the log only. A
 * tunnel that stayed up TUNNEL_PING_MS starts the count again.
 *
 * THE PROXY IS THE PROCESS'S: HTTPS_PROXY, HTTP_PROXY and NO_PROXY as the
 * agent's other calls read them (outbound.ts). ws knows nothing of undici's
 * dispatcher that installOutboundProxy sets for fetch, so the tunnel CONNECTs
 * through the same proxy by itself, and a home NO_PROXY names, or one on a
 * local address, is dialled directly.
 *
 * PACED TOWARDS HOME. Every DATA frame passes the machine's bucket
 * (TunnelPace) at the reply's `machinePaceMBps` with a burst of
 * MACHINE_PACE_BURST_BYTES: one figure goes at once, thirty attempts' plots
 * wait here rather than in the relay's leg every student shares (D18).
 */
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import { REMOTE_BACKOFF_MAX_MS, REMOTE_BACKOFF_MIN_MS, REMOTE_MARKER, REMOTE_MARKER_HEADER, REMOTE_REASON_CHARS, remoteText, remoteTransient } from '@shared/remote-runner'
import { MACHINE_PACE_BURST_BYTES, MACHINE_PACE_MBPS, type RemoteKernelsReply } from '@shared/remote-kernels'
import {
  TUNNEL_CLOSE,
  TUNNEL_MESSAGE_MAX,
  TUNNEL_PING_MS,
  TUNNEL_PROTOCOL,
  TUNNEL_PROTOCOL_HEADER,
  TunnelEnd,
  TunnelPace,
  TunnelRtt,
  pipeTcp,
  processClock,
  tunnelLocalOf,
  tunnelSocketOf,
  type TunnelClock,
  type TunnelOpen,
  type TunnelRefusal,
  type TunnelStream,
} from '@shared/remote-tunnel'
import { bypassesProxy, parseNoProxy, proxySettings } from '../outbound.js'
import { Backoff, RemoteClient, retryAfter } from './client.js'

/** The port of a placement's Jupyter on this machine, or why there is no stream to it (§4.6, §6.9). */
export type TunnelResolve = (key: string, gen: number) => { port: number } | { refused: TunnelRefusal }

/** What home's reply says of the tunnel (RemoteKernelsReply.tunnel). */
export type TunnelWant = RemoteKernelsReply['tunnel']

/** A WebSocket to home's tunnel door, with these headers: at once, or once its module is loaded (dialTunnel). */
export type TunnelDial = (url: string, headers: Record<string, string>) => WebSocket | Promise<WebSocket>

export interface AgentTunnelOptions {
  /** The door: `wss://<home>/api/runners/v1/tunnel` (shared/remote-tunnel.ts · tunnelUrl). */
  url: string
  /** The machine's credential as the Authorization header carries it, `Bearer cr1.<id>.<secret>`; a bare `cr1.…` gets its `Bearer`. */
  authorization: string
  /** This agent's build, in its HELLO. Home does not refuse another: the placements an outdated machine holds still need their tunnel, and only new ones wait for home's build. */
  build: string
  /** The kernel host's records: a placement's loopback port at a gen, or the refusal. */
  resolve: TunnelResolve
  /** MiB a second towards home, read at every frame (RemoteKernelsReply.rates.machinePaceMBps); MACHINE_PACE_MBPS by default. */
  paceMBps?: () => number
  log: (event: string, detail?: Record<string, unknown>) => void
  /** Tests: the WebSocket (dialTunnel by default), the clock, the backoff's jitter, the relay's word, the environment's proxy. */
  dial?: TunnelDial
  clock?: TunnelClock
  random?: () => number
  relayState?: () => Promise<string>
  env?: NodeJS.ProcessEnv
}

/** Quick tries after the tunnel drops, and their bounds, before the 0.23 backoff takes over (§4.6). */
const QUICK_TRIES = 5
const QUICK_MIN_MS = 500
const QUICK_MAX_MS = 5_000
/** The handshake, through the relay and maybe a proxy. */
const DIAL_MS = 30_000
/** A placement's Jupyter on this machine's loopback answers a connect within this, or the stream is refused. */
const LOCAL_CONNECT_MS = 10_000
/** A close handshake waits this long before the socket is terminated. */
const CLOSE_MS = 2_000
/** ws's readyState of an open socket (WebSocket.OPEN): the module itself loads only with the first dial. */
const WS_OPEN = 1
/** A refusal's body is read this far, and for this long. */
const REFUSAL_BYTES = 4 * 1024
const REFUSAL_MS = 5_000
/** The relay is asked whether home is offline at the first failure in a row and every fifth after it, as the sync loop asks (sync.ts · hiccup). */
const RELAY_EVERY = 5

/** Why a dial ended: home's own refusal, or the path's hiccup. */
type Failure =
  | { kind: 'refused'; status: number; error: string; detail: string }
  | { kind: 'transient'; reason: string; retryAfterMs: number | null }

/** One dial, from the WebSocket to its close. */
interface Dial {
  readonly ws: WebSocket
  end: TunnelEnd | null
  /** When home's WELCOME came; null — it never did. */
  upAt: number | null
  /** What ended it, when known before the socket closed: a refusal, a 101 that was not home's. */
  failure: Failure | null
}

/** The close codes that are home's word about this machine, not a hiccup: tried again only slowly. */
const REFUSING_CLOSES: ReadonlyMap<number, string> = new Map([
  [TUNNEL_CLOSE.violation, 'violation'],
  [TUNNEL_CLOSE.unauthorized, 'unauthorized'],
  [TUNNEL_CLOSE.forbidden, 'forbidden'],
  [TUNNEL_CLOSE.replaced, 'replaced'],
  [TUNNEL_CLOSE.protocol, 'protocol'],
])

/**
 * The agent's tunnel to home. One per agent life: its session, in every
 * HELLO, tells home a reconnect of this agent from a new one.
 */
export class AgentTunnel {
  private readonly options: AgentTunnelOptions
  private readonly clock: TunnelClock
  private readonly dialer: TunnelDial
  private readonly relay: () => Promise<string>
  private readonly authorization: string
  private readonly quick: Backoff
  private readonly slow: Backoff
  private readonly pace: TunnelPace
  private readonly rtt = new TunnelRtt()
  private readonly session = randomBytes(16).toString('hex')
  private wanted: 'open' | 'closed' = 'closed'
  private current: Dial | null = null
  /** A dial whose WebSocket is still being made (its module loading, the proxy's CONNECT). */
  private dialling = false
  private retry: unknown = null
  /** Dials in a row that did not stay up. */
  private failures = 0
  /** Failures of the path in a row: when the relay is asked again. */
  private transients = 0
  private up = false
  private changedAt: number
  /** What the log last said of a refusal, and of the relay: each is said again only when it changes. */
  private refusalSaid: string | null = null
  private relaySaid: string | null = null

  constructor(options: AgentTunnelOptions) {
    this.options = options
    this.clock = options.clock ?? processClock
    this.changedAt = this.clock.now()
    this.authorization = /^bearer[ \t]/i.test(options.authorization) ? options.authorization : `Bearer ${options.authorization}`
    this.dialer = options.dial ?? ((url, headers) => dialTunnel(url, headers, options.env ?? process.env))
    const home = new URL(options.url.replace(/^ws/i, 'http')).origin
    this.relay = options.relayState ?? (() => new RemoteClient({ home, build: options.build, credential: () => null }).relayState())
    const random = options.random ?? Math.random
    this.quick = new Backoff(random, QUICK_MIN_MS, QUICK_MAX_MS)
    this.slow = new Backoff(random, REMOTE_BACKOFF_MIN_MS, REMOTE_BACKOFF_MAX_MS)
    this.pace = new TunnelPace(this.clock, () => paceBytes(options.paceMBps?.()), MACHINE_PACE_BURST_BYTES)
  }

  /** Home's reply's word (RemoteKernelsReply.tunnel). */
  want(mode: TunnelWant): void {
    if (mode === 'closed') {
      this.wanted = 'closed'
      this.cancelRetry()
      if (this.current) this.hangUp(this.current, 1000, 'Home holds no placement here')
      return
    }
    this.wanted = 'open'
    const dial = this.current
    // Home sees no tunnel of this machine's, while this one has been up long enough to have reached it: dropped on the way without a word.
    if (mode === 'reconnect' && dial?.upAt != null && this.clock.now() - dial.upAt >= TUNNEL_PING_MS) {
      this.options.log('tunnel-stale', { upMs: this.clock.now() - dial.upAt })
      dial.end?.close()
      dial.ws.terminate()
      return
    }
    if (!dial && !this.dialling && this.retry === null) this.dial()
  }

  /** What the sync says of the tunnel: up, its round trip (the average of its PINGs) and when `up` last changed. */
  state(): { up: boolean; rttMs: number | null; since: number } {
    return { up: this.up, rttMs: this.rtt.ewmaMs, since: this.changedAt }
  }

  /** Hang up for good: the agent stops. Its streams' connections are dropped. */
  async close(): Promise<void> {
    this.wanted = 'closed'
    this.cancelRetry()
    const dial = this.current
    if (!dial) return
    await new Promise<void>((resolve) => {
      const guard = this.clock.setTimeout(() => dial.ws.terminate(), CLOSE_MS)
      dial.ws.once('close', () => {
        this.clock.clearTimeout(guard)
        resolve()
      })
      this.hangUp(dial, 1000, 'The agent is stopping')
    })
  }

  /* ------------------------------------------------------------- dialling */

  private dial(): void {
    this.retry = null
    if (this.wanted !== 'open' || this.current || this.dialling) return
    this.dialling = true
    const headers = { Authorization: this.authorization, [TUNNEL_PROTOCOL_HEADER]: String(TUNNEL_PROTOCOL) }
    void Promise.resolve().then(() => this.dialer(this.options.url, headers)).then(
      (ws) => {
        this.dialling = false
        this.attach(ws)
      },
      (error: unknown) => {
        this.dialling = false
        this.again({ kind: 'transient', reason: messageOf(error), retryAfterMs: null })
      },
    )
  }

  /** The dial's WebSocket, as soon as there is one: its events are the tunnel's. */
  private attach(ws: WebSocket): void {
    // Hung up while it was being made: it goes at once (ws says an aborted handshake as an error, heard here).
    if (this.wanted !== 'open' || this.current) {
      ws.on('error', () => undefined)
      return ws.terminate()
    }
    const dial: Dial = { ws, end: null, upAt: null, failure: null }
    this.current = dial
    ws.on('upgrade', (response) => {
      // A 101 without the marker is not home's door: a proxy's or a relay's, and nothing is said to it.
      if (headerOf(response, REMOTE_MARKER_HEADER) !== REMOTE_MARKER) {
        dial.failure = { kind: 'transient', reason: `a 101 without ${REMOTE_MARKER_HEADER}: not home's`, retryAfterMs: null }
        return ws.terminate()
      }
      // TCP_NODELAY on the machine's side of the leg, as on home's (§4.2); through TLS it reaches the TCP socket below.
      response.socket?.setNoDelay(true)
    })
    ws.on('unexpected-response', (_request, response) => this.unexpected(dial, response))
    ws.on('open', () => this.opened(dial))
    ws.on('message', (data, binary) => dial.end?.receive(data, binary))
    ws.on('error', (error) => {
      // 'close' follows; a failure known before it says more.
      dial.failure ??= { kind: 'transient', reason: error.message, retryAfterMs: null }
    })
    ws.on('close', (code, reason) => this.dropped(dial, code, reason.toString('utf8')))
  }

  /** The door answered without an upgrade: home's refusal when it is marked, the path's hiccup otherwise (remoteTransient). */
  private unexpected(dial: Dial, response: IncomingMessage): void {
    const status = response.statusCode ?? 0
    const marker = headerOf(response, REMOTE_MARKER_HEADER)
    const wait = retryAfter(headerOf(response, 'Retry-After'))
    let body = ''
    let guard: unknown = null
    const done = (): void => {
      if (dial.failure) return
      if (guard !== null) this.clock.clearTimeout(guard)
      dial.failure = remoteTransient(status, marker)
        ? { kind: 'transient', reason: marker === REMOTE_MARKER ? `home answered ${status}` : `a reply without ${REMOTE_MARKER_HEADER} (${status}): not home's`, retryAfterMs: wait }
        : { kind: 'refused', status, ...refusalOf(body, status) }
      response.destroy()
      dial.ws.terminate()
    }
    guard = this.clock.setTimeout(done, REFUSAL_MS)
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      body += chunk
      if (body.length > REFUSAL_BYTES) done()
    })
    response.on('end', done)
    response.on('error', done)
  }

  private opened(dial: Dial): void {
    if (this.current !== dial || this.wanted !== 'open') return this.hangUp(dial, 1000, 'Not wanted any more')
    const end: TunnelEnd = new TunnelEnd({
      side: 'agent',
      socket: tunnelSocketOf(dial.ws),
      clock: this.clock,
      build: this.options.build,
      session: this.session,
      pace: this.pace,
      hooks: {
        up: () => this.welcomed(dial),
        open: (stream, open) => this.connect(end, stream, open),
        rtt: (ms) => this.rtt.add(ms, this.clock.now()),
        end: (code, reason) => {
          dial.failure ??= code === null ? { kind: 'transient', reason, retryAfterMs: null } : closed(code, reason)
          if (code === null) dial.ws.terminate()
          else dial.ws.close(code, closeReason(reason))
        },
      },
    })
    dial.end = end
    end.start()
  }

  private welcomed(dial: Dial): void {
    dial.upAt = this.clock.now()
    this.transients = 0
    this.refusalSaid = this.relaySaid = null
    this.set(true)
    this.options.log('tunnel-up', { tries: this.failures + 1 })
  }

  private dropped(dial: Dial, code: number, reason: string): void {
    dial.end?.close()
    if (this.current !== dial) return
    this.current = null
    this.set(false)
    const upMs = dial.upAt === null ? null : this.clock.now() - dial.upAt
    if (upMs !== null) {
      this.options.log('tunnel-down', { code, reason: reason || null, upMs })
      // Up long enough to count as working: the next drop starts the quick tries again.
      if (upMs >= TUNNEL_PING_MS) {
        this.failures = 0
        this.quick.reset()
        this.slow.reset()
      }
    }
    this.again(dial.failure ?? closed(code, reason))
  }

  /** The next try, after the wait this failure earns. */
  private again(failure: Failure): void {
    if (this.wanted !== 'open' || this.retry !== null || this.current || this.dialling) return
    const floor = failure.kind === 'transient' ? failure.retryAfterMs : null
    const slow = failure.kind === 'refused' || floor !== null || this.failures >= QUICK_TRIES
    const waitMs = slow ? this.slow.next(floor) : this.quick.next()
    this.failures++
    if (failure.kind === 'refused') {
      const said = `${failure.status} ${failure.error}`
      if (said !== this.refusalSaid) {
        this.refusalSaid = said
        this.options.log('tunnel-refused', { status: failure.status, error: failure.error, detail: failure.detail || null, retryMs: waitMs })
      }
    } else if (this.transients++ % RELAY_EVERY === 0) {
      void this.relay().then((path) => {
        if (path === this.relaySaid || this.up) return
        this.relaySaid = path
        this.options.log('tunnel-unreachable', { reason: failure.reason, relay: path, retryMs: waitMs })
      }, () => undefined)
    }
    this.retry = this.clock.setTimeout(() => this.dial(), waitMs)
  }

  private cancelRetry(): void {
    if (this.retry === null) return
    this.clock.clearTimeout(this.retry)
    this.retry = null
  }

  private hangUp(dial: Dial, code: number, reason: string): void {
    dial.end?.close()
    if (dial.ws.readyState === WS_OPEN) dial.ws.close(code, reason)
    else dial.ws.terminate()
  }

  private set(up: boolean): void {
    if (this.up === up) return
    this.up = up
    this.changedAt = this.clock.now()
  }

  /* -------------------------------------------------------------- streams */

  /** Home OPENs a stream: the placement's own loopback port, or the refusal its record gives. */
  private connect(end: TunnelEnd, stream: TunnelStream, open: TunnelOpen): void {
    let target: ReturnType<TunnelResolve>
    try {
      target = this.options.resolve(open.key, open.gen)
    } catch (error) {
      this.options.log('tunnel-resolve-failed', { key: open.key, gen: open.gen, error: messageOf(error) })
      return end.refuse(stream, 'gone')
    }
    if ('refused' in target) return end.refuse(stream, target.refused)
    if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65_535) return end.refuse(stream, 'starting')
    // 127.0.0.1 and the record's port: home names neither, and nothing else here is reachable through the tunnel.
    const socket = net.connect({ host: '127.0.0.1', port: target.port, allowHalfOpen: true })
    socket.setNoDelay(true)
    end.accept(stream, tunnelLocalOf(socket))
    let connected = false
    const timer = this.clock.setTimeout(() => socket.destroy(), LOCAL_CONNECT_MS)
    socket.once('connect', () => {
      connected = true
      this.clock.clearTimeout(timer)
      end.opened(stream)
    })
    socket.on('error', () => undefined)
    socket.on('close', () => this.clock.clearTimeout(timer))
    // A Jupyter that is not listening (yet, or any more) is a placement not ready: the census says the rest.
    pipeTcp(end, stream, socket, () => (connected ? end.reset(stream) : end.refuse(stream, 'starting')))
  }
}

/** The pace towards home in bytes a second: the reply's, or MACHINE_PACE_MBPS when it says none a bucket can use. */
function paceBytes(mbps: number | undefined): number {
  const value = mbps !== undefined && Number.isFinite(mbps) && mbps > 0 ? mbps : MACHINE_PACE_MBPS
  return value * 1024 * 1024
}

/** A dial home closed, by its code: the tunnel's own codes are home's word, the rest the path's. */
function closed(code: number, reason: string): Failure {
  const word = REFUSING_CLOSES.get(code)
  if (word) return { kind: 'refused', status: code, error: word, detail: reason }
  return { kind: 'transient', reason: code === 1006 ? 'the connection dropped' : `closed with ${code}${reason ? `: ${reason}` : ''}`, retryAfterMs: null }
}

/** A marked refusal's body, `{ error, detail? }` (TUNNEL_REFUSALS); one that does not say is named by its status. */
function refusalOf(body: string, status: number): { error: string; detail: string } {
  try {
    const value = JSON.parse(body) as { error?: unknown; detail?: unknown }
    const error = typeof value.error === 'string' && /^[a-z_]{1,32}$/.test(value.error) ? value.error : String(status)
    const detail = typeof value.detail === 'string' ? remoteText(value.detail, REMOTE_REASON_CHARS, 'start') : ''
    return { error, detail }
  } catch {
    return { error: String(status), detail: '' }
  }
}

function headerOf(response: IncomingMessage, name: string): string | null {
  const value = response.headers[name.toLowerCase()]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? null
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A close frame's reason within its 123 bytes. */
const closeReason = (reason: string): string => Buffer.from(reason, 'utf8').subarray(0, 120).toString('utf8').replace(/�+$/, '')

/* ------------------------------------------------------------------ the dial */

/**
 * The WebSocket to home's tunnel door, as the agent dials it: no
 * permessage-deflate and frames of TUNNEL_MESSAGE_MAX at most (§4.2), no
 * redirect followed (a redirect is not home's answer), TCP_NODELAY (ws sets
 * it on its socket, and the CONNECT below on its own), and through the
 * proxy `env` names unless NO_PROXY or a local address says direct.
 *
 * ws loads with the first dial, not with the agent: a machine that never
 * takes classes never needs it, and the agent's bundle runs from a folder
 * with no packages at all (tests/runner-import-graph.test.mts).
 */
export async function dialTunnel(url: string, headers: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Promise<WebSocket> {
  const { WebSocket } = await import('ws')
  const target = new URL(url)
  const agent = proxyAgent(target, env)
  return new WebSocket(target, {
    headers,
    perMessageDeflate: false,
    maxPayload: TUNNEL_MESSAGE_MAX,
    followRedirects: false,
    handshakeTimeout: DIAL_MS,
    ...(agent ? { agent } : {}),
  })
}

/** The agent that CONNECTs through the proxy for this address, or null — direct (outbound.ts · bypassesProxy). */
function proxyAgent(target: URL, env: NodeJS.ProcessEnv): http.Agent | null {
  const settings = proxySettings(env)
  const secure = target.protocol === 'wss:' || target.protocol === 'https:'
  const proxy = secure ? settings.https : settings.http
  if (!proxy) return null
  // NO_PROXY's ports are http's: wss is https on the wire.
  const asHttp = new URL(target.href.replace(/^ws/i, 'http'))
  if (bypassesProxy(asHttp, parseNoProxy(settings.noProxy))) return null
  return secure ? new ProxiedHttpsAgent(new URL(proxy)) : new ProxiedHttpAgent(new URL(proxy))
}

/** The host an agent's connection is for, as http's options name it. */
const hostOf = (options: http.ClientRequestArgs): string => String(options.hostname ?? options.host ?? 'localhost').replace(/^\[|\]$/g, '')

/** wss through an HTTP proxy: CONNECT, then TLS to home inside the tunnel the proxy opened. */
class ProxiedHttpsAgent extends https.Agent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: false })
  }

  override createConnection(options: https.RequestOptions, done?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
    const host = hostOf(options)
    connectThrough(this.proxy, host, Number(options.port) || 443).then(
      (raw) => done?.(null, tls.connect({ socket: raw, host, servername: options.servername ?? (net.isIP(host) ? undefined : host) })),
      (error: Error) => done?.(error, undefined as unknown as Duplex),
    )
    return undefined
  }
}

/** ws through an HTTP proxy (make dev, the tests): CONNECT, and the bytes go plain inside it. */
class ProxiedHttpAgent extends http.Agent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: false })
  }

  override createConnection(options: http.ClientRequestArgs, done?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
    connectThrough(this.proxy, hostOf(options), Number(options.port) || 80).then(
      (raw) => done?.(null, raw),
      (error: Error) => done?.(error, undefined as unknown as Duplex),
    )
    return undefined
  }
}

/** A TCP tunnel to `host:port` through the proxy (CONNECT), with TCP_NODELAY on the leg to the proxy. */
function connectThrough(proxy: URL, host: string, port: number): Promise<net.Socket> {
  const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
  const credentials = proxy.username || proxy.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
    : null
  return new Promise((resolve, reject) => {
    const secure = proxy.protocol === 'https:'
    const request = (secure ? https : http).request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.port) || (secure ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      agent: false,
      timeout: DIAL_MS,
      headers: { Host: authority, ...(credentials ? { 'Proxy-Authorization': credentials } : {}) },
    })
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        return reject(new Error(`The proxy refused CONNECT ${authority}: ${response.statusCode}`))
      }
      if (head.length > 0) socket.unshift(head)
      socket.setNoDelay(true)
      resolve(socket)
    })
    request.once('timeout', () => request.destroy(new Error(`The proxy did not answer CONNECT ${authority} in ${DIAL_MS / 1000} s`)))
    request.once('error', reject)
    request.end()
  })
}
