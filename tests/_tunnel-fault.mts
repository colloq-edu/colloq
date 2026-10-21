/**
 * The fault proxy of the classes e2e (docs/architecture/remote-classes.md
 * §17.2): a TCP proxy on 127.0.0.1 between a machine's agent and its home,
 * where relay2 stands in production, that cuts, black-holes, delays and
 * throttles what crosses it, each direction on its own, and heals.
 *
 * EVERYTHING A MACHINE SAYS GOES THROUGH IT. The agent joins with the
 * proxy's address (`joinTarget`), so its syncs, its blob fetches and uploads
 * and its tunnel all cross it, as they all cross the relay. `up` is the
 * agent's bytes towards home, `down` home's towards the agent; a fault names
 * one of them or `both` (the default).
 *
 * WHAT EACH FAULT IS, AS THE PATH WOULD DO IT.
 *   blackhole   bytes are held, never lost, and delivered in order once it is
 *               healed: a dead leg TCP rides out (K0: a 10 s cut was a 10.6 s
 *               stall with nothing lost). Past HOLD_BYTES the sender is read
 *               no more, as its socket's buffer would fill. A close is held
 *               with them, since a dead leg carries no FIN and no RST either:
 *               a side that ends or resets its connection leaves the other
 *               open and silent, and the heal brings it the bytes and then
 *               the end. So the connections stay open: only the ends' own
 *               timers (the tunnel's TUNNEL_DEAD_MS) end them.
 *   cut         the connections are reset now, and every new one on arrival
 *               while it lasts: a relay restart. A cut of one direction
 *               resets the side that direction reaches and leaves the other
 *               open and silent, a half-open connection its owner must time
 *               out: `up` resets home's side and the agent learns nothing,
 *               `down` resets the agent's and home learns nothing. A new
 *               connection under a cut of `up` alone is taken and never
 *               reaches home.
 *   delay(ms)   every byte arrives that much later, in order, and a close
 *               after them. Up to DELAYED_BYTES are on their way at once, a
 *               path's bandwidth times its delay, so a delay slows nothing it
 *               carries.
 *   throttle(B) at most B bytes a second, in pieces of PIECE_BYTES, shared by
 *               every connection the fault covers: the machine's leg.
 * Faults add up. heal() lifts those it names (all, by default), and what a
 * blackhole held goes on at once, a close it held after the bytes; a
 * connection a one-sided cut left open stays dead, as TCP would keep it: a
 * heal lets new connections through and mends none.
 *
 * THE TUNNEL IS TOLD FROM THE REST. The proxy reads the head of every request
 * the agent sends — HTTP/1.1 with keep-alive, bodies by Content-Length or
 * chunked, the stream raw after an upgrade — and a connection whose first
 * request upgrades to the tunnel's path is `tunnel`, any other `http`; a
 * fault may cover only one kind (`only`). And as the relay does, it says
 * where the machine calls from: `forwardedFor` goes into the X-Forwarded-For
 * of every request, which home believes from a loopback peer
 * (net/inbound.ts · TRUSTED_PROXIES), so two machines, or a machine and a
 * thief of its secret, call home from addresses of their own.
 *
 * ITS CLOCK IS INJECTABLE: delays and throttles run on a TunnelClock, which a
 * test moves instead of waiting. close() resets every connection and stops
 * every timer: nothing of it outlives the test.
 */
import net from 'node:net'
import { REMOTE_API_ROOT } from '../shared/remote-runner.ts'
import { TUNNEL_PATH, type TunnelClock } from '../shared/remote-tunnel.ts'

export type FaultDirection = 'up' | 'down' | 'both'
export type FaultScope = 'all' | 'tunnel' | 'http'

/** What a fault covers: a direction (both by default) and a kind of connection (all by default). */
export interface FaultTarget {
  direction?: FaultDirection
  only?: FaultScope
}

export interface FaultStats {
  /** Connections the agent opened through the proxy. */
  accepted: number
  /** Of them, reset on arrival by a cut. */
  refused: number
  /** Of them, told to be the tunnel by their first request. */
  tunnels: number
  /** The request heads read, of every connection there has been. */
  requests: number
  /** Connections open now, by kind (`unknown`: no request head read yet). */
  live: { tunnel: number; http: number; unknown: number }
  /** Bytes delivered, by direction. */
  bytes: { up: number; down: number }
  /** Bytes waiting in the proxy now (held by a blackhole, or due later), by direction. */
  held: { up: number; down: number }
  /** Closes waiting in the proxy now (a FIN or a reset, behind a blackhole or a delay), by direction. */
  closing: { up: number; down: number }
}

type Lane = 'up' | 'down'
type Kind = 'tunnel' | 'http'
type Side = 'client' | 'upstream'

interface Fault {
  readonly kind: 'blackhole' | 'cut' | 'delay' | 'throttle'
  readonly lane: Lane
  readonly only: FaultScope
  /** A delay's milliseconds, a throttle's bytes a second. */
  readonly value: number
  /** A throttle's leg: when it is free for the next piece, on the clock. */
  freeAt: number
}

/** The pieces a throttle paces by: a figure's frame and a keystroke's take turns at this grain. */
const PIECE_BYTES = 16 * 1024

/** What a lane holds behind a blackhole or a throttle before its sender is read no more: a socket's buffer. */
const HOLD_BYTES = 256 * 1024

/**
 * What a lane holds of bytes that are only delayed before its sender is read
 * no more: a path's bandwidth times its delay (relay2 carried 35 MiB/s in K0,
 * so 8 MiB is a 200 ms delay's worth), or a delay would throttle too.
 */
const DELAYED_BYTES = 8 * 1024 * 1024

/** A request head longer than this is no head: the connection goes on raw. */
const HEAD_MAX = 64 * 1024

/** The tunnel's door, in every version of the machines' router (kernel/remote/tunnel.ts · TUNNEL_ROUTE). */
const TUNNEL_ROUTE = new RegExp(`^${REMOTE_API_ROOT}/v[0-9]{1,6}/${TUNNEL_PATH}/?$`)

/** The process's clock, its timers unref'd: a proxy left idle keeps no test alive. */
const wallClock: TunnelClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms)
    handle.unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** A reset, not a close: the peer hears RST, as from a relay that went away (shared/remote-tunnel.ts · resetTcp). */
function reset(socket: net.Socket | null): void {
  if (!socket || socket.destroyed) return
  try {
    if (!socket.connecting) socket.resetAndDestroy()
    else socket.destroy()
  } catch {
    socket.destroy()
  }
}

const lanesOf = (direction: FaultDirection = 'both'): Lane[] => (direction === 'both' ? ['up', 'down'] : [direction])

/* ------------------------------------------------------- the agent's heads */

/**
 * The agent's requests on one connection, as HTTP/1.1 frames them: each head
 * rewritten (X-Forwarded-For), every body byte passed on as it came, and the
 * rest raw after an upgrade. What does not read as a request goes on raw and
 * untouched: the proxy never breaks what it cannot parse.
 */
class RequestHeads {
  private mode: 'head' | 'fixed' | 'size' | 'data' | 'crlf' | 'trailers' | 'raw' = 'head'
  private pending: Buffer = Buffer.alloc(0)
  private left = 0
  /** The first request's line: what tells the tunnel from the rest. */
  first: { method: string; path: string; upgrade: boolean } | null = null
  /** How many heads were read. */
  heads = 0

  constructor(private readonly forwardedFor: string | null) {}

  /** Whether the stream is past every head it will have (an upgrade, or no HTTP at all). */
  get raw(): boolean {
    return this.mode === 'raw'
  }

  /** The bytes to send on for `chunk`, the heads in it rewritten; a head not whole yet waits for the next chunk. */
  push(chunk: Buffer): Buffer[] {
    const out: Buffer[] = []
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)
    while (data.length > 0) {
      if (this.mode === 'raw') {
        out.push(data)
        break
      }
      if (this.mode === 'head' && this.heads === 0) {
        // A stream that does not open with a request line's method is no HTTP: it goes on raw, as it came.
        const prefix = data.subarray(0, 12).toString('latin1')
        if (!/^[A-Z]{1,10} /.test(prefix) && !/^[A-Z]{0,10}$/.test(prefix)) {
          this.mode = 'raw'
          continue
        }
      }
      if (this.mode === 'head' || this.mode === 'size' || this.mode === 'trailers') {
        const mark = this.mode === 'head' ? '\r\n\r\n' : '\r\n'
        const end = data.indexOf(mark)
        if (end < 0) {
          if (data.length > HEAD_MAX) this.mode = 'raw'
          else {
            this.pending = data
            break
          }
          continue
        }
        const piece = data.subarray(0, end + mark.length)
        data = data.subarray(end + mark.length)
        if (this.mode === 'head') out.push(this.head(piece))
        else if (this.mode === 'size') {
          out.push(piece)
          const size = Number.parseInt(piece.toString('latin1').split(';')[0]!.trim(), 16)
          if (!Number.isSafeInteger(size) || size < 0) this.mode = 'raw'
          else if (size === 0) this.mode = 'trailers'
          else {
            this.mode = 'data'
            this.left = size
          }
        } else {
          out.push(piece)
          // The empty line after the trailers ends the request.
          if (end === 0) this.mode = 'head'
        }
        continue
      }
      // 'fixed', 'data', 'crlf': a counted run of bytes.
      const taken = Math.min(this.left, data.length)
      out.push(data.subarray(0, taken))
      data = data.subarray(taken)
      this.left -= taken
      if (this.left > 0) continue
      if (this.mode === 'data') {
        this.mode = 'crlf'
        this.left = 2
      } else this.mode = this.mode === 'crlf' ? 'size' : 'head'
    }
    return out
  }

  private head(raw: Buffer): Buffer {
    this.heads++
    const lines = raw.toString('latin1').slice(0, -4).split('\r\n')
    const [method = '', target = ''] = (lines[0] ?? '').split(' ')
    const headers = lines.slice(1)
    const value = (name: string): string | undefined => {
      const line = headers.find((entry) => entry.toLowerCase().startsWith(`${name}:`))
      return line?.slice(name.length + 1).trim()
    }
    const upgrade = /\bupgrade\b/i.test(value('connection') ?? '') && value('upgrade') !== undefined
    const length = Number(value('content-length') ?? '0')
    this.first ??= { method, path: target.split('?')[0] ?? '', upgrade }
    if (upgrade) this.mode = 'raw'
    else if (/\bchunked\b/i.test(value('transfer-encoding') ?? '')) this.mode = 'size'
    else if (Number.isSafeInteger(length) && length > 0) {
      this.mode = 'fixed'
      this.left = length
    } else this.mode = 'head'
    if (!this.forwardedFor) return raw
    // Added to what the agent said, as a proxy adds itself; the agent says nothing there.
    const at = headers.findIndex((entry) => /^x-forwarded-for\s*:/i.test(entry))
    if (at >= 0) headers[at] = `${headers[at]}, ${this.forwardedFor}`
    else headers.push(`X-Forwarded-For: ${this.forwardedFor}`)
    return Buffer.from(`${[lines[0], ...headers].join('\r\n')}\r\n\r\n`, 'latin1')
  }
}

/* ------------------------------------------------------------ connections */

interface LaneState {
  /** Bytes on their way, oldest first, each with when it arrived on the clock. */
  queue: Array<{ chunk: Buffer; at: number }>
  bytes: number
  timer: unknown
  /** When the sender's FIN came, on the clock: its receiver is ended once what came before it is through. */
  fin: number | null
  /** The receiver was ended. */
  finSent: boolean
  /** When the sender went without a word (a reset, an error, a close before it heard our end): its receiver is reset once what came before is through. */
  reset: number | null
  /** The receiver's buffer is full: the next write waits for its `drain`. */
  draining: boolean
}

/** One agent connection and its leg to home. `up` delivers to `upstream`, `down` to `client`. */
interface Pair {
  readonly client: net.Socket
  upstream: net.Socket | null
  kind: Kind | null
  readonly heads: RequestHeads
  readonly lanes: Record<Lane, LaneState>
  /** The side a one-sided cut left open: read and dropped, written no more, until its owner closes it. */
  orphan: Side | null
  done: boolean
}

const laneState = (): LaneState => ({ queue: [], bytes: 0, timer: null, fin: null, finSent: false, reset: null, draining: false })

export class TunnelFault {
  readonly port: number
  readonly url: string
  private readonly faults: Fault[] = []
  private readonly pairs = new Set<Pair>()
  private readonly counts = { accepted: 0, refused: 0, tunnels: 0, up: 0, down: 0 }
  /** The request heads of the connections that are gone, still counted. */
  private headsGone = 0
  private closed = false

  private constructor(
    private readonly server: net.Server,
    private readonly target: { host: string; port: number },
    private readonly forwardedFor: string | null,
    private readonly clock: TunnelClock,
  ) {
    this.port = (server.address() as net.AddressInfo).port
    this.url = `http://127.0.0.1:${this.port}`
  }

  /**
   * A proxy on a port of its own in front of `target` (home's port).
   * `forwardedFor` — the address the machine calls home from, as the relay
   * would say it; none, home sees the loopback.
   */
  static async start(options: { target: number; host?: string; forwardedFor?: string | null; clock?: TunnelClock }): Promise<TunnelFault> {
    const server = net.createServer({ allowHalfOpen: true })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const proxy = new TunnelFault(server, { host: options.host ?? '127.0.0.1', port: options.target }, options.forwardedFor ?? null, options.clock ?? wallClock)
    server.on('connection', (socket) => proxy.accept(socket))
    return proxy
  }

  /** COLLOQ_RUNNER_JOIN for a machine that calls home through this proxy. */
  joinTarget(code: string): string {
    return `${this.url}#${code}`
  }

  /* ------------------------------------------------------------- faults */

  cut(target: FaultTarget = {}): void {
    const lanes = this.add('cut', target, 0)
    for (const pair of [...this.pairs]) if (this.covers(target.only ?? 'all', pair.kind)) this.cutPair(pair, lanes)
  }

  blackhole(target: FaultTarget = {}): void {
    this.add('blackhole', target, 0)
  }

  delay(ms: number, target: FaultTarget = {}): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`not a delay: ${ms}`)
    this.add('delay', target, ms)
  }

  throttle(bytesPerSecond: number, target: FaultTarget = {}): void {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) throw new Error(`not a rate: ${bytesPerSecond}`)
    this.add('throttle', target, bytesPerSecond)
  }

  /** Lift the faults `target` names: those of its directions, of its kind of connection (of every kind, by default). */
  heal(target: FaultTarget = {}): void {
    const lanes = new Set(lanesOf(target.direction))
    const only = target.only ?? 'all'
    for (let i = this.faults.length - 1; i >= 0; i--) {
      const fault = this.faults[i]!
      if (lanes.has(fault.lane) && (only === 'all' || fault.only === only)) this.faults.splice(i, 1)
    }
    // A held reset ends its pair as it goes: the pairs are walked as they were.
    for (const pair of [...this.pairs]) {
      this.pump(pair, 'up')
      this.pump(pair, 'down')
    }
  }

  stats(): FaultStats {
    const live = { tunnel: 0, http: 0, unknown: 0 }
    const held = { up: 0, down: 0 }
    const closing = { up: 0, down: 0 }
    let requests = this.headsGone
    for (const pair of this.pairs) {
      live[pair.kind ?? 'unknown']++
      for (const lane of ['up', 'down'] as const) {
        const state = pair.lanes[lane]
        held[lane] += state.bytes
        if (state.reset !== null || (state.fin !== null && !state.finSent)) closing[lane]++
      }
      requests += pair.heads.heads
    }
    return { accepted: this.counts.accepted, refused: this.counts.refused, tunnels: this.counts.tunnels, requests, live, bytes: { up: this.counts.up, down: this.counts.down }, held, closing }
  }

  /** Every connection reset, the port closed, every timer stopped. */
  async close(): Promise<void> {
    this.closed = true
    for (const pair of [...this.pairs]) this.drop(pair)
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private add(kind: Fault['kind'], target: FaultTarget, value: number): Lane[] {
    const lanes = lanesOf(target.direction)
    for (const one of lanes) this.faults.push({ kind, lane: one, only: target.only ?? 'all', value, freeAt: 0 })
    return lanes
  }

  /** Whether a fault of scope `only` covers a connection of this kind; one whose first request is not read yet only `all` covers. */
  private covers(only: FaultScope, kind: Kind | null): boolean {
    return only === 'all' || only === kind
  }

  /** The faults on one lane of a connection now. */
  private faultsOn(pair: Pair, lane: Lane): Fault[] {
    return this.faults.filter((fault) => fault.lane === lane && this.covers(fault.only, pair.kind))
  }

  /** When what came at `at` is due at the far end: its delays added, and after the pieces a throttle still paces. */
  private dueOf(at: number, faults: readonly Fault[]): number {
    let due = at
    for (const fault of faults) if (fault.kind === 'delay') due += fault.value
    for (const fault of faults) if (fault.kind === 'throttle') due = Math.max(due, fault.freeAt)
    return due
  }

  /* -------------------------------------------------------- the traffic */

  private accept(client: net.Socket): void {
    this.counts.accepted++
    client.setNoDelay(true)
    client.on('error', () => undefined)
    if (this.closed) return reset(client)
    const pair: Pair = { client, upstream: null, kind: null, heads: new RequestHeads(this.forwardedFor), lanes: { up: laneState(), down: laneState() }, orphan: null, done: false }
    this.pairs.add(pair)
    client.on('data', (chunk: Buffer) => this.fromClient(pair, chunk))
    client.on('end', () => {
      if (pair.done) return
      // The open side of a one-sided cut, closed by its owner at last: it is ended too, and the pair goes with its close.
      if (pair.orphan === 'client') return void client.end()
      // A connection that ends before it said where to go has nowhere to go.
      if (pair.upstream === null) return this.drop(pair)
      pair.lanes.up.fin = this.clock.now()
      this.pump(pair, 'up')
    })
    client.on('close', () => this.closedSide(pair, 'client'))
    // A cut of every kind decides now; one of a kind, once the first request says which.
    this.arrives(pair)
  }

  /**
   * A connection under a cut, as it arrives (at once for a cut of every
   * kind, at its first request for one of its kind): reset on arrival when
   * the cut reaches the agent's side, taken and kept from home when it
   * reaches home's alone. False — it goes no further.
   */
  private arrives(pair: Pair): boolean {
    const cuts = this.faults.filter((fault) => fault.kind === 'cut' && this.covers(fault.only, pair.kind))
    if (cuts.length === 0) return true
    if (cuts.some((fault) => fault.lane === 'down')) {
      this.counts.refused++
      this.drop(pair)
    } else pair.orphan = 'client'
    return false
  }

  private fromClient(pair: Pair, chunk: Buffer): void {
    if (pair.done || pair.orphan === 'client') return
    const pieces = pair.heads.push(chunk)
    if (pair.kind === null) {
      // The first request says which kind it is; bytes that are no request at all go on to home as plain HTTP.
      const first = pair.heads.first
      if (!first && !pair.heads.raw) return
      pair.kind = first?.upgrade && TUNNEL_ROUTE.test(first.path) ? 'tunnel' : 'http'
      if (pair.kind === 'tunnel') this.counts.tunnels++
      if (!this.arrives(pair)) return
      this.connect(pair)
    }
    this.enqueue(pair, 'up', pieces)
  }

  private connect(pair: Pair): void {
    const upstream = net.connect({ host: this.target.host, port: this.target.port, allowHalfOpen: true })
    pair.upstream = upstream
    upstream.setNoDelay(true)
    upstream.on('error', () => undefined)
    upstream.on('connect', () => this.pump(pair, 'up'))
    upstream.on('data', (chunk: Buffer) => {
      if (!pair.done && pair.orphan === null) this.enqueue(pair, 'down', [chunk])
    })
    upstream.on('end', () => {
      if (pair.done) return
      if (pair.orphan === 'upstream') return void upstream.end()
      pair.lanes.down.fin = this.clock.now()
      this.pump(pair, 'down')
    })
    upstream.on('close', () => this.closedSide(pair, 'upstream'))
  }

  private enqueue(pair: Pair, lane: Lane, chunks: Buffer[]): void {
    const state = pair.lanes[lane]
    const at = this.clock.now()
    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.length; offset += PIECE_BYTES) {
        const piece = chunk.subarray(offset, offset + PIECE_BYTES)
        state.queue.push({ chunk: piece, at })
        state.bytes += piece.length
      }
    }
    this.pump(pair, lane)
  }

  /**
   * Send what is due on one lane and no more: a blackhole holds, a delay or a
   * throttle sets a timer, a full receiver waits for its drain. The sender's
   * close goes after its bytes the same way, as late as a delay makes it and
   * never through a blackhole: a FIN ends the receiver, a reset ends the pair.
   */
  private pump(pair: Pair, lane: Lane): void {
    if (pair.done || pair.orphan !== null) return
    const state = pair.lanes[lane]
    const receiver = lane === 'up' ? pair.upstream : pair.client
    if (!receiver || receiver.connecting || receiver.destroyed || state.draining) return this.flow(pair, lane)
    if (state.timer !== null) {
      this.clock.clearTimeout(state.timer)
      state.timer = null
    }
    const faults = this.faultsOn(pair, lane)
    if (faults.some((fault) => fault.kind === 'blackhole')) return this.flow(pair, lane)
    const throttles = faults.filter((fault) => fault.kind === 'throttle')
    while (state.queue.length > 0) {
      const next = state.queue[0]!
      const now = this.clock.now()
      const due = this.dueOf(next.at, faults)
      if (due > now) return this.later(pair, lane, due - now)
      state.queue.shift()
      state.bytes -= next.chunk.length
      for (const fault of throttles) fault.freeAt = Math.max(now, fault.freeAt) + (next.chunk.length * 1000) / fault.value
      this.counts[lane] += next.chunk.length
      if (!receiver.write(next.chunk)) {
        state.draining = true
        receiver.once('drain', () => {
          state.draining = false
          this.pump(pair, lane)
        })
        return this.flow(pair, lane)
      }
    }
    const end = state.reset ?? (state.finSent ? null : state.fin)
    if (end !== null) {
      const now = this.clock.now()
      const due = this.dueOf(end, faults)
      if (due > now) return this.later(pair, lane, due - now)
      // A reset reaches the receiver as the relay passes one on: the pair goes, its other side gone already.
      if (state.reset !== null) return this.drop(pair)
      state.finSent = true
      receiver.end()
    }
    this.flow(pair, lane)
  }

  /** The lane pumped again in `ms` on the proxy's clock. */
  private later(pair: Pair, lane: Lane, ms: number): void {
    const state = pair.lanes[lane]
    state.timer = this.clock.setTimeout(() => {
      state.timer = null
      this.pump(pair, lane)
    }, ms)
    this.flow(pair, lane)
  }

  /**
   * A lane's sender read again once the lane is short enough, and read no
   * more while it holds too much or its receiver is full: a socket's buffer
   * behind a blackhole or a throttle, a path's worth of bytes behind a delay.
   */
  private flow(pair: Pair, lane: Lane): void {
    const state = pair.lanes[lane]
    const sender = lane === 'up' ? pair.client : pair.upstream
    if (!sender || sender.destroyed) return
    const narrow = this.faultsOn(pair, lane).some((fault) => fault.kind === 'blackhole' || fault.kind === 'throttle')
    if (state.bytes > (narrow ? HOLD_BYTES : DELAYED_BYTES) || state.draining) sender.pause()
    else sender.resume()
  }

  /** A cut reaching an open connection: both sides reset, or the one its direction reaches, the other left open and silent. */
  private cutPair(pair: Pair, lanes: Lane[]): void {
    if (pair.done) return
    if (lanes.length === 2) return this.drop(pair)
    // `up` reaches home: its side is reset, and the agent's stays open; `down` the mirror.
    const resetSide: Side = lanes[0] === 'up' ? 'upstream' : 'client'
    pair.orphan = resetSide === 'upstream' ? 'client' : 'upstream'
    this.empty(pair)
    reset(resetSide === 'upstream' ? pair.upstream : pair.client)
    // What the open side sends is read and dropped, so it never stalls on a full socket.
    ;(pair.orphan === 'client' ? pair.client : pair.upstream)?.resume()
  }

  /**
   * One side closed. Closed in good order (its FIN came, and it was ended
   * after what it was sent), what it sent still goes on and the other side is
   * ended after it. Gone without a word (a reset, an error, a close before it
   * heard our end), the other side hears a reset: after what it was sent, as
   * late as the path makes it, and never through a blackhole, which leaves it
   * open and silent until the heal. An orphan's close is the end of the pair.
   */
  private closedSide(pair: Pair, side: Side): void {
    if (pair.done) return
    if (pair.orphan !== null) {
      if (pair.orphan === side) this.drop(pair)
      return
    }
    const other = side === 'client' ? pair.upstream : pair.client
    if (!other || other.destroyed) return this.drop(pair)
    const lane: Lane = side === 'client' ? 'up' : 'down'
    const sent = pair.lanes[lane]
    const received = pair.lanes[lane === 'up' ? 'down' : 'up']
    if (sent.fin !== null && received.finSent) return
    sent.reset ??= this.clock.now()
    this.pump(pair, lane)
  }

  private empty(pair: Pair): void {
    for (const state of [pair.lanes.up, pair.lanes.down]) {
      if (state.timer !== null) this.clock.clearTimeout(state.timer)
      state.timer = null
      state.queue = []
      state.bytes = 0
    }
  }

  private drop(pair: Pair): void {
    if (pair.done) return
    pair.done = true
    this.headsGone += pair.heads.heads
    this.pairs.delete(pair)
    this.empty(pair)
    reset(pair.client)
    reset(pair.upstream)
  }
}
