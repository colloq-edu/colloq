/**
 * Resumable streams on the machines' tunnel (docs/architecture/remote-classes.md
 * §4.8, §17.1 «K3b resume», §17.2 scenario 6): what an end keeps across a cut,
 * how the next socket's greeting takes it up again, and when it cannot.
 *
 * Why it was built: through relay2 a cut of a minute lost the bytes in flight
 * both ways, and a restart of the relay cuts every tunnel at once (K0, 16 Oct
 * 2026). Each rule below fails quietly. A sender that sent again from where
 * it stood, rather than from what its peer received, doubles or drops a
 * kernel's output in the middle of a figure; one that let a stream go before
 * its peer knew loses the tail of an answer to a cut in between; an end that
 * took a restarted agent for the one it knew would splice two lives' bytes
 * into one connection; and one that kept everything for ever, or whatever a
 * local connection wrote, would hold a dead machine's megabytes in home's
 * memory.
 *
 * The property test runs both ends of the shared engine on a clock and a
 * network of its own, seeded: cuts, black holes in either direction, outages,
 * reconnects, restarts of the agent and of home, slow readers and a
 * connection that will not stop writing, across many streams on both lanes.
 * Every stream delivers exactly the bytes sent, once and in order, or
 * resets, and a reset needs a reason the design gives. The targeted cases
 * run home's and the agent's real ends over real sockets on 127.0.0.1, where
 * a deadline only guards against a hang.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http, { type IncomingMessage } from 'node:http'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { remoteCredential, type RemoteFacts } from '../shared/remote-runner.js'
import {
  TUNNEL_CLOSE,
  TUNNEL_DEAD_MS,
  TUNNEL_FRAME_MAX,
  TUNNEL_GREETING_MS,
  TUNNEL_QUEUE_BYTES,
  TUNNEL_RESUME_LIST_MAX,
  TUNNEL_RESUME_MS,
  TUNNEL_RETAIN_BYTES,
  TUNNEL_WINDOW,
  TunnelEnd,
  TunnelPace,
  decodeTunnelFrame,
  encodeTunnelFrame,
  tunnelHelloOf,
  tunnelUrl,
  type TunnelClock,
  type TunnelFrame,
  type TunnelLocal,
  type TunnelResumed,
  type TunnelSide,
  type TunnelSocket,
  type TunnelStream,
} from '../shared/remote-tunnel.js'
import { MachineTunnels } from '../server/src/kernel/remote/tunnel.js'
import { AgentTunnel, dialTunnel, type TunnelDial } from '../server/src/runner-agent/tunnel.js'
import { joinRunner, mintRemoteCode, runnerEvents, setRunnerClasses } from '../server/src/competitions/remote/store.js'

const KiB = 1024
const MiB = 1024 * 1024
const ROOM = 'resume_room:room'
const COUNCIL = 'resume_room:council'
const quiet = (): void => undefined

/* ============================================================ the engine's world */

/** A clock of the test's own: timers run when it is moved, in order, each at its own moment. */
class Clock implements TunnelClock {
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
    const until = this.t + ms
    for (;;) {
      let next: [number, { at: number; run: () => void }] | null = null
      for (const entry of this.timers) if (entry[1].at <= until && (next === null || entry[1].at < next[1].at)) next = entry
      if (next === null) break
      this.timers.delete(next[0])
      this.t = Math.max(this.t, next[1].at)
      next[1].run()
    }
    this.t = until
  }

  /** Timers waiting now: what an end left behind. */
  get pending(): number {
    return this.timers.size
  }
}

/** A seeded generator: the same run every time for a seed (xorshift32). */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

/** The byte at `at` of a direction of a stream, tagged `tag`: a copy, a gap, a swap or another stream's byte all read wrong. */
const pattern = (tag: number, at: number): number => Math.imul(at ^ Math.imul(tag, 0x9e3779b9), 0x85ebca6b) >>> 24

function chunkOf(tag: number, from: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = pattern(tag, from + i)
  return bytes
}

/**
 * One side of a stream's TCP connection, as an end sees it: what it is given
 * is checked byte by byte against the peer's pattern and taken when the test
 * says (a slow reader); what it writes the test writes for it, and an honest
 * one writes nothing while it is paused.
 */
class SimLocal implements TunnelLocal {
  got = 0
  /** The first thing it was given wrong: a byte off its pattern, bytes after the end, a second end. */
  wrong: string | null = null
  ended = false
  destroyed = false
  paused = false
  wrote = 0
  finished = false
  /** Takes what it is given at once, rather than when the test says. */
  taking = false
  readonly takes: Array<() => void> = []

  constructor(
    readonly readTag: number,
    readonly writeTag: number,
  ) {}

  write(payload: Uint8Array, taken: () => void): void {
    if (this.ended) this.wrong ??= `bytes after the end, at ${this.got}`
    for (let i = 0; i < payload.byteLength; i++) {
      if (payload[i] !== pattern(this.readTag, this.got + i)) {
        this.wrong ??= `byte ${this.got + i} is not the one sent there`
        break
      }
    }
    this.got += payload.byteLength
    if (this.taking) taken()
    else this.takes.push(taken)
  }

  end(): void {
    if (this.ended) this.wrong ??= 'a second end'
    this.ended = true
  }

  destroy(): void {
    this.destroyed = true
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  take(count = Number.POSITIVE_INFINITY): void {
    for (; count > 0 && this.takes.length > 0; count--) this.takes.shift()!()
  }
}

type Side = TunnelSide
const other = (side: Side): Side => (side === 'home' ? 'agent' : 'home')
/** Whether a stream is over, read afresh: a call into its end may have ended it. */
const gone = (stream: TunnelStream): boolean => stream.state === 'closed'

interface Flight {
  frame: Uint8Array
  done: (error?: Error) => void
}

/**
 * One socket pair between the two ends. A frame a side sends waits in its
 * direction's queue until the test delivers it, in order; in a black hole it
 * waits for ever, as bytes do behind a dead path (and the socket's buffer
 * fills, as a real one does). A side's socket that closes loses what it had
 * on the way.
 */
class Link {
  readonly flights: Record<Side, Flight[]> = { home: [], agent: [] }
  readonly buffered: Record<Side, number> = { home: 0, agent: 0 }
  readonly hole: Record<Side, boolean> = { home: false, agent: false }
  readonly gone: Record<Side, boolean> = { home: false, agent: false }
  /** Home's door has read the HELLO: what comes after is the end's. */
  greeted = false
  readonly sockets: Record<Side, TunnelSocket>

  constructor() {
    const socketOf = (side: Side): TunnelSocket => {
      const link = this
      return {
        get bufferedAmount() {
          return link.buffered[side]
        },
        send(frame, done) {
          if (link.gone[side]) return done(new Error('closed'))
          link.flights[side].push({ frame, done })
          link.buffered[side] += frame.byteLength
        },
      }
    }
    this.sockets = { home: socketOf('home'), agent: socketOf('agent') }
  }

  /** The frames a side had on the way, lost with its socket. */
  drop(side: Side): void {
    this.buffered[side] = 0
    for (const flight of this.flights[side].splice(0)) flight.done(new Error('closed'))
  }
}

/** One stream as the test follows it: its two ends' streams and connections, and why it may have reset. */
interface Followed {
  n: number
  lane: 1 | 2
  homeEnd: TunnelEnd
  home: TunnelStream
  homeLocal: SimLocal
  agentEnd: TunnelEnd | null
  agent: TunnelStream | null
  agentLocal: SimLocal | null
  /** The agent's connection to its Jupyter is still being made: opened by the test later. */
  connecting: boolean
  /** Its Jupyter goes on writing while it is told to pause, as long as the tunnel is cut. */
  rude: boolean
  /** Why a reset is no fault: the first reason the design gives that befell it. */
  excuse: string | null
}

interface SimCounts {
  steps: number
  cuts: number
  holes: number
  outages: number
  agentRestarts: number
  homeRestarts: number
  resumes: number
  streams: number
  resets: number
  overflows: number
  bytes: number
  /** Bytes sent and not ACKed on the streams of a socket when it went: what resumes had to send again. */
  unacked: number
  /** Streams home took up again over a new socket, summed over its resumes. */
  carried: number
}

/**
 * Home's end and the agent's end of one machine, the network between them,
 * and owners that do what MachineTunnels and AgentTunnel do with them: the
 * agent dials again after a cut, home's door reads the HELLO and gives the
 * socket to its end, a newer socket takes the older's place.
 */
class Sim {
  readonly clock = new Clock()
  readonly random: () => number
  homeEnd: TunnelEnd
  agentEnd: TunnelEnd
  /** The link each end is on now; null — cut. */
  readonly on: Record<Side, Link | null> = { home: null, agent: null }
  /** Whether each end is up, as its hooks said. */
  private readonly upNow: Record<Side, boolean> = { home: false, agent: false }
  /** When each end was cut from an open socket, and the streams it held then: past TUNNEL_RESUME_MS they may reset. */
  private readonly cutAt: Record<Side, { at: number; alive: Followed[] } | null> = { home: null, agent: null }
  readonly streams: Followed[] = []
  /** Home's streams of its current numbering, by number: what an OPEN the agent reads is. */
  private byId = new Map<number, Followed>()
  readonly failures: string[] = []
  private nextDialAt: number
  private outageUntil = 0
  private readonly holes: Array<{ link: Link; side: Side; until: number }> = []
  private detaches = 0
  private life = 0
  readonly counts: SimCounts = { steps: 0, cuts: 0, holes: 0, outages: 0, agentRestarts: 0, homeRestarts: 0, resumes: 0, streams: 0, resets: 0, overflows: 0, bytes: 0, unacked: 0, carried: 0 }

  constructor(seed: number) {
    this.random = seeded(seed)
    this.homeEnd = this.makeHome()
    this.agentEnd = this.makeAgent()
    this.nextDialAt = this.clock.now()
  }

  private session(): string {
    return (++this.life).toString(16).padStart(32, '0')
  }

  private makeHome(): TunnelEnd {
    const end: TunnelEnd = new TunnelEnd({
      side: 'home', clock: this.clock, build: 'dev', session: this.session(),
      hooks: {
        up: (_peer, resumed) => this.up('home', end, resumed),
        overflow: () => this.failures.push('home overflowed a stream: its connections are honest'),
        end: (code, reason) => this.ended('home', end, code, reason),
      },
    })
    return end
  }

  private makeAgent(): TunnelEnd {
    // The machine's pace, on the test's clock: its waits are timers of their own.
    const pace = new TunnelPace(this.clock, () => 6 * MiB, 2 * MiB)
    const end: TunnelEnd = new TunnelEnd({
      side: 'agent', clock: this.clock, build: 'dev', session: this.session(), pace,
      hooks: {
        up: (_peer, resumed) => this.up('agent', end, resumed),
        open: (stream) => this.opening(end, stream),
        overflow: (stream) => {
          this.counts.overflows++
          const followed = this.streams.find((one) => one.agent === stream)
          if (!followed?.rude) this.failures.push(`stream ${followed?.n} overflowed, and its connection was honest`)
          if (followed) followed.excuse ??= 'overflow'
        },
        end: (code, reason) => this.ended('agent', end, code, reason),
      },
    })
    return end
  }

  private endOf(side: Side): TunnelEnd {
    return side === 'home' ? this.homeEnd : this.agentEnd
  }

  /* ------------------------------------------------------------- what the ends say */

  private up(side: Side, end: TunnelEnd, resumed: TunnelResumed): void {
    if (end !== this.endOf(side)) return
    this.upNow[side] = true
    if (resumed.resumed) this.counts.resumes++
    if (side === 'home') this.counts.carried += resumed.streams
    // A cut past TUNNEL_RESUME_MS: what the end kept then may have reset.
    const cut = this.cutAt[side]
    if (cut && this.clock.now() - cut.at >= TUNNEL_RESUME_MS) for (const followed of cut.alive) followed.excuse ??= `${side} cut ${Math.round((this.clock.now() - cut.at) / 1000)} s`
    this.cutAt[side] = null
    // Home greeted a new life of the agent's: it numbers its streams from 1 again.
    if (side === 'home' && !resumed.resumed) this.byId = new Map()
  }

  /** An end gave up its socket (a dead link, a greeting that never came) or broke off (any code): its socket closes. */
  private ended(side: Side, end: TunnelEnd, code: number | null, reason: string): void {
    if (code !== null) this.failures.push(`${side} closed the tunnel with ${code}: ${reason}`)
    if (end !== this.endOf(side)) return
    const link = this.on[side]
    this.detached(side)
    this.on[side] = null
    if (link) this.closeSocket(link, side, false)
  }

  /** An end is off its socket: from open, the clock of what it keeps starts. */
  private detached(side: Side): void {
    this.detaches++
    if (side === 'agent') this.nextDialAt = this.clock.now() + this.backoff()
    if (!this.upNow[side]) return
    this.upNow[side] = false
    const alive = this.streams.filter((one) => (side === 'home' ? one.home : one.agent)?.state === 'open')
    // What was sent and not ACKed when the socket went: the bytes a resume must send again.
    for (const one of alive) this.counts.unacked += side === 'home' ? one.home.sent - one.home.acked : one.agent!.sent - one.agent!.acked
    this.cutAt[side] ??= { at: this.clock.now(), alive }
  }

  /**
   * A side's socket on `link` closes: what it had on the way is lost, its end
   * (if it is still on this link) is cut, and the other side hears the close
   * unless the way to it is a black hole, as an RST would.
   */
  private closeSocket(link: Link, side: Side, cutEnd = true): void {
    if (link.gone[side]) return
    link.gone[side] = true
    link.drop(side)
    if (cutEnd && this.on[side] === link) {
      this.detached(side)
      this.on[side] = null
      this.endOf(side).cut()
    }
    if (!link.hole[side]) this.closeSocket(link, other(side))
  }

  /** The agent: home OPENs a stream. Its Jupyter answers at once, later, or not at all. */
  private opening(end: TunnelEnd, stream: TunnelStream): void {
    if (end !== this.agentEnd) return void this.failures.push('an OPEN reached an agent that is gone')
    const followed = this.byId.get(stream.id)
    if (!followed || followed.agent !== null || followed.lane !== stream.lane) return void this.failures.push(`an OPEN of stream ${stream.id} the test cannot place`)
    followed.agentEnd = end
    followed.agent = stream
    followed.agentLocal = new SimLocal(followed.n * 2, followed.n * 2 + 1)
    end.accept(stream, followed.agentLocal)
    const roll = this.random()
    if (roll < 0.04) {
      followed.excuse ??= 'refused'
      end.refuse(stream, 'starting')
    } else if (roll < 0.3) followed.connecting = true
    else end.opened(stream)
  }

  /* ------------------------------------------------------------------ the network */

  private dial(): void {
    const link = new Link()
    this.on.agent = link
    this.agentEnd.attach(link.sockets.agent)
  }

  /** Home's door: the first frame of a socket is its HELLO, and the socket goes to home's end, in the place of the one it had. */
  private door(link: Link, frame: Uint8Array): void {
    const read = tunnelHelloOf(frame, true)
    if (!('hello' in read)) return void this.failures.push(`home's door refused a socket: ${read.reason}`)
    link.greeted = true
    const older = this.on.home
    if (older && older !== link) {
      // Replaced: the end leaves the older socket for this one by itself (attach), and the older closes (4409).
      this.detached('home')
      older.gone.home = true
      older.drop('home')
    }
    this.on.home = link
    this.homeEnd.attach(link.sockets.home, read.hello)
  }

  /** Up to `count` frames from `side`, in order, unless they fall into a black hole. */
  private deliver(link: Link, side: Side, count: number): void {
    const to = other(side)
    for (; count > 0 && !link.hole[side] && link.flights[side].length > 0; count--) {
      const flight = link.flights[side].shift()!
      link.buffered[side] -= flight.frame.byteLength
      flight.done()
      if (link.gone[to]) continue
      if (to === 'home' && !link.greeted) this.door(link, flight.frame)
      else if (this.on[to] === link) this.endOf(to).receive(flight.frame, true)
    }
  }

  private links(): Link[] {
    return [...new Set([this.on.home, this.on.agent].filter((link): link is Link => link !== null))]
  }

  private backoff(): number {
    return this.random() < 0.8 ? 500 + Math.floor(this.random() * 4500) : 1000 + Math.floor(this.random() * 29_000)
  }

  /* ------------------------------------------------------------------ one step */

  /** Watches the streams still opening around something that may cut a socket: a cut resets them, by the rule. */
  private guarded(action: () => void): void {
    const opening = this.streams.filter((one) => one.home.state === 'opening' || one.agent?.state === 'opening' || one.connecting)
    const before = this.detaches
    action()
    if (this.detaches !== before) for (const one of opening) one.excuse ??= 'opening at a cut'
  }

  step(faults: boolean): void {
    this.counts.steps++
    const r = this.random
    // Time: mostly moments, now and then seconds, or minutes; the network goes on carrying what it can meanwhile.
    const roll = r()
    const ms = roll < 0.92 ? Math.floor(r() * 400) : roll < 0.99 ? 1_000 + Math.floor(r() * 20_000) : 20_000 + Math.floor(r() * 140_000)
    for (let left = ms; left > 0;) {
      const slice = Math.min(left, 2_000)
      this.guarded(() => this.clock.advance(slice))
      left -= slice
      if (left > 0) for (const link of this.links()) for (const side of ['home', 'agent'] as const) this.guarded(() => this.deliver(link, side, Number.POSITIVE_INFINITY))
    }
    const now = this.clock.now()
    for (const hole of [...this.holes]) {
      if (hole.until > now) continue
      this.holes.splice(this.holes.indexOf(hole), 1)
      hole.link.hole[hole.side] = false
    }
    // The agent dials while it holds no socket, once its backoff is out and the path is there.
    if (this.on.agent === null && now >= this.nextDialAt) {
      if (now < this.outageUntil) this.nextDialAt = now + this.backoff()
      else this.guarded(() => this.dial())
    }
    // Frames on their way: a few, or all there are.
    for (const link of this.links()) {
      for (const side of ['home', 'agent'] as const) this.guarded(() => this.deliver(link, side, r() < 0.3 ? Number.POSITIVE_INFINITY : Math.floor(r() * 12)))
    }
    if (faults) this.fault()
    // Home opens a stream while it is up (as far as it knows): a kernel's channels, a REST call, a council worker's.
    if (this.homeEnd.up && this.homeEnd.count < 24 && this.streams.length < 64 && r() < 0.1) this.openStream()
    for (const one of this.streams) this.work(one)
    this.check()
  }

  private openStream(): void {
    const n = this.streams.length + 1
    const council = this.random() < 0.3
    const local = new SimLocal(n * 2 + 1, n * 2)
    const stream = this.homeEnd.open(council ? COUNCIL : ROOM, 1, local)
    if (!stream) return
    const followed: Followed = {
      n, lane: council ? 2 : 1, homeEnd: this.homeEnd, home: stream, homeLocal: local,
      agentEnd: null, agent: null, agentLocal: null, connecting: false, rude: this.random() < 0.06, excuse: null,
    }
    this.streams.push(followed)
    this.byId.set(stream.id, followed)
    this.counts.streams++
  }

  /** A stream's two connections: they write, read slowly, end, and now and then break. */
  private work(one: Followed): void {
    const r = this.random
    if (one.connecting && one.agent && r() < 0.4) {
      one.connecting = false
      if (one.agent.state === 'opening' && one.agentEnd === this.agentEnd) this.guarded(() => one.agentEnd!.opened(one.agent!))
    }
    for (const side of ['home', 'agent'] as const) {
      const end = side === 'home' ? one.homeEnd : one.agentEnd
      const stream = side === 'home' ? one.home : one.agent
      const local = side === 'home' ? one.homeLocal : one.agentLocal
      if (!end || !stream || !local || stream.state === 'closed') continue
      // Reading: some of what it was given, or all of it.
      if (local.takes.length > 0 && r() < 0.5) local.take(r() < 0.3 ? Number.POSITIVE_INFINITY : 1 + Math.floor(r() * 8))
      // A Jupyter that goes on writing into a cut tunnel, told to pause or not.
      const rude = side === 'agent' && one.rude && !this.agentEnd.up && !local.finished
      if (!local.finished && (rude || (!local.paused && r() < 0.35))) {
        const size = rude ? 256 * KiB : r() < 0.9 ? 1 + Math.floor(r() * 24 * KiB) : 64 * KiB
        end.write(stream, chunkOf(local.writeTag, local.wrote, size))
        local.wrote += size
        this.counts.bytes += size
      }
      // A write may have reset it (an overflow).
      if (gone(stream)) continue
      if (!local.finished && r() < 0.012) {
        local.finished = true
        end.finish(stream)
      }
      if (r() < 0.0003) {
        // Its socket broke: the wiring resets the stream (pipeTcp).
        one.excuse ??= 'a connection broke'
        end.reset(stream)
      }
    }
  }

  private fault(): void {
    const r = this.random
    const roll = r()
    const link = this.on.home ?? this.on.agent
    if (roll < 0.022) {
      if (!link) return
      if (roll < 0.012) {
        // A relay restart: both sockets close at once, and what was on the way is lost.
        this.counts.cuts++
        return this.guarded(() => {
          this.closeSocket(link, 'home')
          this.closeSocket(link, 'agent')
        })
      }
      // A black hole, one way or both, for a few seconds or past the dead timer: nobody is told.
      this.counts.holes++
      const until = this.clock.now() + (r() < 0.5 ? 1_000 + Math.floor(r() * 15_000) : 20_000 + Math.floor(r() * 60_000))
      for (const side of r() < 0.5 ? (['home', 'agent'] as const) : ([r() < 0.5 ? 'home' : 'agent'] as const)) {
        link.hole[side] = true
        this.holes.push({ link, side, until })
      }
    } else if (roll < 0.025) {
      // An outage of the machine's path: holes both ways and no dial gets through, mostly for less than TUNNEL_RESUME_MS.
      this.counts.outages++
      const until = this.clock.now() + (r() < 0.8 ? 5_000 + Math.floor(r() * 70_000) : 100_000 + Math.floor(r() * 100_000))
      this.outageUntil = Math.max(this.outageUntil, until)
      for (const one of this.links()) {
        for (const side of ['home', 'agent'] as const) {
          one.hole[side] = true
          this.holes.push({ link: one, side, until })
        }
      }
    } else if (roll < 0.026) this.restartAgent()
    else if (roll < 0.0266) this.restartHome()
  }

  /** The agent's process dies (kill -9, an update): its connections go with it, and a new life dials with a new session. */
  private restartAgent(): void {
    this.counts.agentRestarts++
    for (const one of this.streams) if (one.agent?.state !== 'closed' || one.home.state !== 'closed') one.excuse ??= 'the agent restarted'
    const link = this.on.agent
    this.guarded(() => {
      this.agentEnd.close()
      this.upNow.agent = false
      this.cutAt.agent = null
      this.on.agent = null
      this.agentEnd = this.makeAgent()
      this.nextDialAt = this.clock.now() + this.backoff()
      if (link) this.closeSocket(link, 'agent', false)
    })
  }

  /** Home's process restarts: its connections go, and its next greeting is of a new life. */
  private restartHome(): void {
    this.counts.homeRestarts++
    for (const one of this.streams) if (one.agent?.state !== 'closed' || one.home.state !== 'closed') one.excuse ??= 'home restarted'
    const link = this.on.home
    this.guarded(() => {
      this.homeEnd.close()
      this.upNow.home = false
      this.cutAt.home = null
      this.on.home = null
      this.homeEnd = this.makeHome()
      this.byId = new Map()
      if (link) this.closeSocket(link, 'home', false)
    })
  }

  /** What every step holds to: the windows, every byte a stream holds accounted for, kept or queued, and no timer piling up. */
  private check(): void {
    // Each end: its socket's clock, its pace's wake, what it keeps since a cut, and at most an ACK's clock per stream.
    const live = this.homeEnd.count + this.agentEnd.count
    if (this.clock.pending > 6 + live) this.failures.push(`${this.clock.pending} timers wait for ${live} streams`)
    for (const end of [this.homeEnd, this.agentEnd]) {
      let outbound = 0
      for (const one of this.streams) {
        const stream = end === this.homeEnd ? one.home : one.agent
        if (!stream || stream.state === 'closed' || (end === this.homeEnd ? one.homeEnd : one.agentEnd) !== end) continue
        const kept = stream.retained.reduce((sum, chunk) => sum + chunk.byteLength, 0) - stream.retainedHead
        const queued = stream.queue.reduce((sum, chunk) => sum + chunk.byteLength, 0) - stream.head
        if (kept !== stream.sent - stream.acked) this.failures.push(`stream ${one.n} keeps ${kept} B for ${stream.sent - stream.acked} unACKed`)
        if (queued !== stream.queued) this.failures.push(`stream ${one.n} queues ${queued} B, counted ${stream.queued}`)
        if (stream.sent - stream.acked > Math.min(stream.window, TUNNEL_RETAIN_BYTES)) this.failures.push(`stream ${one.n} past its window`)
        // An honest connection's bytes wait in its own buffers once paused: a window wound back plus a queue's worth at most.
        if (!one.rude && stream.queued > stream.window + 2 * TUNNEL_QUEUE_BYTES) this.failures.push(`stream ${one.n} queues ${stream.queued} B`)
        if (stream.queued > TUNNEL_RETAIN_BYTES + stream.window + 256 * KiB) this.failures.push(`stream ${one.n} holds ${stream.queued} B of a connection that would not stop`)
        outbound += stream.sent - stream.acked
      }
      if (outbound > TUNNEL_WINDOW.machine) this.failures.push(`${end.side} past the machine's window: ${outbound} B`)
    }
  }

  /** The path heals and stays healed: everything on its way arrives, every reader takes what it was given, until nothing moves. */
  settle(): boolean {
    this.outageUntil = 0
    for (const hole of this.holes.splice(0)) hole.link.hole[hole.side] = false
    for (let round = 0; round < 4000; round++) {
      this.guarded(() => this.clock.advance(round % 20 === 0 ? 1_000 : 60))
      if (this.on.agent === null && this.clock.now() >= this.nextDialAt) this.guarded(() => this.dial())
      for (const link of this.links()) for (const side of ['home', 'agent'] as const) this.guarded(() => this.deliver(link, side, Number.POSITIVE_INFINITY))
      for (const one of this.streams) {
        if (one.connecting && one.agent && one.agentEnd === this.agentEnd) {
          one.connecting = false
          if (one.agent.state === 'opening') this.guarded(() => one.agentEnd!.opened(one.agent!))
        }
        one.homeLocal.take()
        one.agentLocal?.take()
      }
      this.check()
      if (this.still()) return true
    }
    return false
  }

  /** Both ends up on one link, nothing on its way, nothing untaken, and every byte sent ACKed. */
  private still(): boolean {
    const link = this.on.home
    if (!link || link !== this.on.agent || !this.homeEnd.up || !this.agentEnd.up) return false
    if (link.flights.home.length > 0 || link.flights.agent.length > 0) return false
    for (const one of this.streams) {
      for (const [stream, local] of [[one.home, one.homeLocal], [one.agent, one.agentLocal]] as const) {
        if (!stream || stream.state === 'closed') continue
        if (local && local.takes.length > 0) return false
        if (stream.queued > 0 || stream.sent !== stream.acked || stream.received !== stream.ackedOut || stream.ackQueued) return false
      }
      if (one.connecting) return false
    }
    return true
  }

  /** Every stream: exactly the bytes sent, once and in order, or a reset with a reason. */
  verdict(): string[] {
    const faults = [...this.failures]
    for (const one of this.streams) {
      for (const local of [one.homeLocal, one.agentLocal]) if (local?.wrong) faults.push(`stream ${one.n}: ${local.wrong}`)
      const reset = one.homeLocal.destroyed || one.agentLocal?.destroyed === true || one.agentLocal === null
      if (reset) {
        this.counts.resets++
        if (!one.excuse) faults.push(`stream ${one.n} reset with no reason: home ${one.home.state} ${one.homeLocal.destroyed ? 'dropped' : ''}, agent ${one.agent?.state ?? 'never opened'} ${one.agentLocal?.destroyed ? 'dropped' : ''}`)
        if (one.home.state !== 'closed' || (one.agent && one.agent.state !== 'closed')) faults.push(`stream ${one.n} reset at one end, held at the other`)
        continue
      }
      const agentLocal = one.agentLocal!
      if (agentLocal.got !== one.homeLocal.wrote) faults.push(`stream ${one.n}: the agent got ${agentLocal.got} of home's ${one.homeLocal.wrote} B`)
      if (one.homeLocal.got !== agentLocal.wrote) faults.push(`stream ${one.n}: home got ${one.homeLocal.got} of the agent's ${agentLocal.wrote} B`)
      if (one.homeLocal.finished !== agentLocal.ended) faults.push(`stream ${one.n}: home's end ${one.homeLocal.finished ? 'never came' : 'came unsent'}`)
      if (agentLocal.finished !== one.homeLocal.ended) faults.push(`stream ${one.n}: the agent's end ${agentLocal.finished ? 'never came' : 'came unsent'}`)
      // Ended both ways and known so: let go of at both ends, its connections left to finish.
      if (one.homeLocal.finished && agentLocal.finished && (one.home.state !== 'closed' || one.agent!.state !== 'closed')) faults.push(`stream ${one.n} ended both ways and still held`)
    }
    return faults
  }

  /** Both ends stop: nothing they started may be left waiting on the clock. */
  stop(): number {
    this.homeEnd.close()
    this.agentEnd.close()
    return this.clock.pending
  }
}

test('the property: random cuts, black holes, outages, reconnects and restarts deliver every stream\'s bytes once and in order, or reset it for a reason', () => {
  const total: SimCounts = { steps: 0, cuts: 0, holes: 0, outages: 0, agentRestarts: 0, homeRestarts: 0, resumes: 0, streams: 0, resets: 0, overflows: 0, bytes: 0, unacked: 0, carried: 0 }
  for (let seed = 1; seed <= 24; seed++) {
    const sim = new Sim(0x5eed_0000 + seed)
    for (let i = 0; i < 700; i++) sim.step(true)
    assert.ok(sim.settle(), `seed ${seed}: the healed tunnel never came to rest`)
    const faults = sim.verdict()
    assert.deepEqual(faults, [], `seed ${seed}: ${faults.slice(0, 8).join('; ')}`)
    assert.equal(sim.stop(), 0, `seed ${seed}: timers left behind`)
    for (const key of Object.keys(total) as Array<keyof SimCounts>) total[key] += sim.counts[key]
  }
  // The property says something only if the world was rough, and most streams lived through it: count what happened.
  const counted = JSON.stringify(total)
  assert.ok(total.cuts >= 50 && total.holes >= 50 && total.outages >= 10, counted)
  assert.ok(total.agentRestarts >= 5 && total.homeRestarts >= 3 && total.overflows >= 1, counted)
  assert.ok(total.resumes >= 100 && total.streams >= 400 && total.carried >= 500 && total.unacked >= 16 * MiB, counted)
  assert.ok(total.resets < total.streams / 2, `most streams outlive their cuts: ${counted}`)
})

/* ======================================================== the rules, one by one */

/** One end of each side over a Link of the test's own, its frames delivered when the test says, its sockets cut and dialled again. */
class Duo {
  readonly clock = new Clock()
  home: TunnelEnd
  agent: TunnelEnd
  link = new Link()
  readonly ups: Array<{ side: Side; resumed: TunnelResumed }> = []
  readonly ended: Array<{ side: Side; code: number | null }> = []
  readonly overflows: TunnelStream[] = []
  /** The agent's side of each stream, by number: its stream and its connection to the Jupyter. */
  readonly agents = new Map<number, { stream: TunnelStream; local: SimLocal }>()
  /** Whether the agent's Jupyter answers an OPEN at once. */
  answering = true
  private sessions = 0

  constructor() {
    this.home = this.makeHome()
    this.agent = this.makeAgent()
    this.dial()
    this.deliver()
  }

  private session(): string {
    return (0xd0000 + ++this.sessions).toString(16).padStart(32, '0')
  }

  makeHome(): TunnelEnd {
    const end: TunnelEnd = new TunnelEnd({
      side: 'home', clock: this.clock, build: 'dev', session: this.session(),
      hooks: {
        up: (_peer, resumed) => this.ups.push({ side: 'home', resumed }),
        end: (code) => this.ended.push({ side: 'home', code }),
      },
    })
    return end
  }

  makeAgent(): TunnelEnd {
    const end: TunnelEnd = new TunnelEnd({
      side: 'agent', clock: this.clock, build: 'dev', session: this.session(),
      hooks: {
        up: (_peer, resumed) => this.ups.push({ side: 'agent', resumed }),
        open: (stream) => {
          const local = new SimLocal(stream.id * 2, stream.id * 2 + 1)
          local.taking = true
          this.agents.set(stream.id, { stream, local })
          end.accept(stream, local)
          if (this.answering) end.opened(stream)
        },
        overflow: (stream) => this.overflows.push(stream),
        end: (code) => this.ended.push({ side: 'agent', code }),
      },
    })
    return end
  }

  /** A new socket pair: the agent greets, and home's door gives the socket to home's end once the HELLO comes. */
  dial(): void {
    this.link = new Link()
    this.agent.attach(this.link.sockets.agent)
  }

  /** Every frame both ways, until neither side has more to say; `until` stops before a frame of the side's that it matches. */
  deliver(stop?: (from: Side, frame: TunnelFrame) => boolean): void {
    const link = this.link
    for (let moved = true; moved;) {
      moved = false
      for (const side of ['agent', 'home'] as const) {
        while (link.flights[side].length > 0 && !link.gone[other(side)]) {
          const flight = link.flights[side][0]
          if (stop?.(side, decodeTunnelFrame(flight.frame, side))) return
          this.pass(side)
          moved = true
        }
      }
    }
  }

  /** The frames one side has on the way, and only those: the other side's wait. */
  deliverFrom(side: Side): void {
    while (this.link.flights[side].length > 0 && !this.link.gone[other(side)]) this.pass(side)
  }

  /** One side's next frame to the other; a socket's first, from the agent, through home's door. */
  private pass(side: Side): void {
    const link = this.link
    const flight = link.flights[side].shift()!
    link.buffered[side] -= flight.frame.byteLength
    flight.done()
    if (side === 'agent' && !link.greeted) {
      const read = tunnelHelloOf(flight.frame, true)
      assert.ok('hello' in read, 'the first frame is a HELLO')
      link.greeted = true
      this.home.attach(link.sockets.home, read.hello)
    } else (side === 'agent' ? this.home : this.agent).receive(flight.frame, true)
  }

  /** Both sockets close at once, with what they had on the way. */
  cut(): void {
    for (const side of ['home', 'agent'] as const) {
      this.link.gone[side] = true
      this.link.drop(side)
    }
    this.home.cut()
    this.agent.cut()
  }

  /** A stream home opens, with what it says to it and what it hears; its OPEN delivered, and the answer, unless told not to. */
  open(key = ROOM, delivered = true): { home: TunnelStream; homeLocal: SimLocal; agent: () => { stream: TunnelStream; local: SimLocal } } {
    const homeLocal = new SimLocal(0, 0)
    homeLocal.taking = true
    const home = this.home.open(key, 1, homeLocal)
    assert.ok(home, 'home opens the stream')
    // Its patterns are its number's, as the agent's side of it reads and writes them.
    Object.assign(homeLocal, { readTag: home.id * 2 + 1, writeTag: home.id * 2 })
    if (delivered) this.deliver()
    return { home, homeLocal, agent: () => this.agents.get(home.id)! }
  }

  write(end: TunnelEnd, stream: TunnelStream, local: SimLocal, size: number): void {
    end.write(stream, chunkOf(local.writeTag, local.wrote, size))
    local.wrote += size
  }
}

test('a connection that will not stop writing into a cut tunnel overflows: its stream alone resets, and the others go on', () => {
  const d = new Duo()
  const rude = d.open()
  const honest = d.open(COUNCIL)
  d.write(d.home, honest.home, honest.homeLocal, 40 * KiB)
  d.deliver()
  d.cut()
  // Meanwhile the honest Jupyter writes until it is told to pause; the other goes on regardless.
  const kept = honest.agent()
  while (!kept.local.paused) d.write(d.agent, kept.stream, kept.local, 16 * KiB)
  const wild = rude.agent()
  let most = 0
  for (let i = 0; i < 64 && wild.stream.state !== 'closed'; i++) {
    d.write(d.agent, wild.stream, wild.local, 256 * KiB)
    most = Math.max(most, wild.stream.queued)
  }
  assert.equal(wild.stream.state, 'closed', 'the stream overflowed')
  assert.ok(wild.local.destroyed, 'its connection is dropped')
  assert.deepEqual(d.overflows, [wild.stream])
  assert.ok(wild.local.wrote > TUNNEL_RETAIN_BYTES && most <= TUNNEL_RETAIN_BYTES + TUNNEL_QUEUE_BYTES + 256 * KiB, `held at most ${most} B for it`)
  assert.equal(kept.stream.state, 'open', 'the honest one is kept')
  d.dial()
  d.deliver()
  for (const local of [kept.local, honest.homeLocal]) local.take()
  d.deliver()
  // Home found the rude stream gone at the agent and dropped it; the honest one went on, every byte once.
  assert.ok(rude.homeLocal.destroyed && rude.home.state === 'closed')
  assert.equal(kept.local.got, honest.homeLocal.wrote)
  assert.equal(honest.homeLocal.got, kept.local.wrote)
  assert.equal(kept.local.wrong ?? honest.homeLocal.wrong, null)
  assert.ok(!kept.local.destroyed && !honest.homeLocal.destroyed)
  assert.deepEqual(d.ups.at(-1), { side: 'agent', resumed: { resumed: true, streams: 1, reset: 0 } })
  assert.deepEqual(d.ups.at(-2), { side: 'home', resumed: { resumed: true, streams: 1, reset: 1 } })
})

test('a stream ended both ways is let go of only once its peer knows it, and a cut that ate the last word lets it go quietly at the next greeting', () => {
  for (const first of ['agent', 'home'] as const) {
    const lingering = other(first)
    const d = new Duo()
    const s = d.open()
    const agentSide = s.agent()
    const sides = { home: { end: d.home, stream: s.home, local: s.homeLocal }, agent: { end: d.agent, ...agentSide } }
    // `first` says all it has and ends; then the other side does. `first` has the other's every byte and end, and the
    // other's word that its own came: it lets go, and its last ACK (FIN) is the word the other side waits for.
    for (const [side, bytes] of [[first, 30 * KiB], [lingering, 50 * KiB]] as const) {
      d.write(sides[side].end, sides[side].stream, sides[side].local, bytes)
      sides[side].end.finish(sides[side].stream)
      d.deliverFrom(side)
    }
    assert.equal(sides[first].stream.state, 'closed', `${first} let go once it had the peer's word`)
    const waiting = sides[lingering].stream
    assert.equal(waiting.state, 'open', `${lingering} waits for the last word`)
    // It still holds what it sent and has no ACK for: a cut now must not lose the tail (the K3a end let go of it here).
    assert.ok(waiting.endSent && !waiting.endAcked && waiting.sent - waiting.acked === 50 * KiB && waiting.retained.length > 0)
    d.cut()
    d.dial()
    d.deliver()
    assert.equal(waiting.state, 'closed', 'unlisted at the next greeting, it is let go of')
    assert.deepEqual(d.ups.slice(-2).map((up) => up.resumed), [{ resumed: true, streams: 0, reset: 0 }, { resumed: true, streams: 0, reset: 0 }], 'and that cost nothing')
    for (const local of [s.homeLocal, agentSide.local]) {
      assert.ok(!local.destroyed, 'quietly: its connection, done both ways, is left to finish')
      assert.ok(local.ended && local.wrong === null)
    }
    assert.equal(sides[lingering].local.got, 30 * KiB)
    assert.equal(sides[first].local.got, 50 * KiB)
    assert.equal(d.home.count + d.agent.count, 0)
  }
})

test('more than TUNNEL_RESUME_MS cut resets what both ends kept, the next greeting is a new life\'s, and nothing is left on the clock', () => {
  const d = new Duo()
  const s = d.open()
  const agentSide = s.agent()
  d.write(d.home, s.home, s.homeLocal, 100 * KiB)
  d.write(d.agent, agentSide.stream, agentSide.local, 100 * KiB)
  d.deliver()
  d.cut()
  d.clock.advance(TUNNEL_RESUME_MS - 1)
  assert.ok(!s.homeLocal.destroyed && !agentSide.local.destroyed, 'kept until the last moment')
  assert.equal(d.clock.pending, 2, 'one clock at each end: what it keeps')
  d.clock.advance(1)
  assert.ok(s.homeLocal.destroyed && agentSide.local.destroyed, 'then reset at both ends')
  assert.equal(d.home.count + d.agent.count, 0)
  assert.equal(d.clock.pending, 0, 'and nothing waits any more')
  d.dial()
  d.deliver()
  // A new life at both ends, each counting the stream its clock reset.
  assert.deepEqual(d.ups.slice(-2).map((up) => up.resumed), [{ resumed: false, streams: 0, reset: 1 }, { resumed: false, streams: 0, reset: 1 }])
  // The new life numbers its streams from 1, and they work.
  const next = d.open()
  assert.equal(next.home.id, 1)
  d.write(d.home, next.home, next.homeLocal, 10 * KiB)
  d.deliver()
  next.agent().local.take()
  assert.equal(next.agent().local.got, 10 * KiB)
  d.home.close()
  d.agent.close()
  assert.equal(d.clock.pending, 0)
})

test('a home of another life (it restarted) resets every stream the agent kept, and one of the same life resumes them', () => {
  const d = new Duo()
  const a = d.open()
  const b = d.open()
  d.write(d.home, a.home, a.homeLocal, 20 * KiB)
  d.deliver()
  d.cut()
  // The same home: both streams go on.
  d.dial()
  d.deliver()
  assert.deepEqual(d.ups.at(-1), { side: 'agent', resumed: { resumed: true, streams: 2, reset: 0 } })
  d.cut()
  // Home's process restarted: its connections went with it, and its WELCOME is of a new life.
  d.home.close()
  d.home = d.makeHome()
  d.dial()
  d.deliver()
  assert.deepEqual(d.ups.at(-1), { side: 'agent', resumed: { resumed: false, streams: 0, reset: 2 } })
  assert.ok(a.agent().local.destroyed && b.agent().local.destroyed, 'the agent dropped its connections to the Jupyter')
  assert.equal(d.agent.count, 0)
  // Numbered from 1 again, as the new home numbers them.
  const c = d.open()
  assert.equal(c.home.id, 1)
  assert.equal(c.agent().stream.state, 'open')
})

test('home resumes only for the session of the agent\'s life: a HELLO of another, listing the very streams, resets them all', () => {
  const d = new Duo()
  const s = d.open()
  d.write(d.home, s.home, s.homeLocal, 20 * KiB)
  d.deliver()
  d.cut()
  // Whoever holds the machine's secret but not its agent's session (it never leaves the tunnel) cannot take the streams up.
  d.link = new Link()
  const forged = encodeTunnelFrame({ kind: 'HELLO', hello: { protocol: 1, build: 'dev', session: 'f'.repeat(32), resume: [{ stream: s.home.id, rx: 0 }] } })
  const read = tunnelHelloOf(forged, true)
  assert.ok('hello' in read)
  d.link.greeted = true
  d.home.attach(d.link.sockets.home, read.hello)
  assert.ok(s.homeLocal.destroyed && s.home.state === 'closed', 'reset, not spliced into another life')
  assert.deepEqual(d.ups.at(-1), { side: 'home', resumed: { resumed: false, streams: 0, reset: 1 } })
  const sent = d.link.flights.home.map((flight) => decodeTunnelFrame(flight.frame, 'home'))
  assert.deepEqual(sent.map((frame) => frame.kind), ['WELCOME'], 'nothing of the stream went to it')
  const welcome = sent[0]
  assert.ok(welcome.kind === 'WELCOME' && welcome.welcome.resumed === undefined && welcome.welcome.streams === undefined)
})

test('the agent resumes only with the home of the life it knew: a WELCOME of another that says it resumed resets everything', () => {
  const d = new Duo()
  const s = d.open()
  d.write(d.agent, s.agent().stream, s.agent().local, 20 * KiB)
  d.deliver()
  d.cut()
  d.dial()
  // The agent offers its stream; the answer comes from a home of another session that claims to resume it.
  const hello = decodeTunnelFrame(d.link.flights.agent[0].frame, 'agent')
  assert.ok(hello.kind === 'HELLO' && hello.hello.resume?.length === 1)
  d.link.flights.agent.length = 0
  d.agent.receive(encodeTunnelFrame({ kind: 'WELCOME', welcome: { protocol: 1, build: 'dev', session: 'e'.repeat(32), resumed: true, streams: [{ stream: s.home.id, rx: 0 }] } }), true)
  assert.ok(s.agent().local.destroyed && s.agent().stream.state === 'closed', 'reset, not spliced into another home')
  assert.deepEqual(d.ups.at(-1), { side: 'agent', resumed: { resumed: false, streams: 0, reset: 1 } })
  // That home is told the stream is gone, and nothing of it goes there.
  const sent = d.link.flights.agent.map((flight) => decodeTunnelFrame(flight.frame, 'agent'))
  assert.deepEqual(sent.filter((frame) => frame.kind !== 'PING').map((frame) => [frame.kind, 'stream' in frame ? frame.stream : null]), [['RESET', s.home.id]])
})

test('a new life is resumable only once the agent answers from it: a HELLO repeated after a WELCOME it never got is greeted anew', () => {
  const d = new Duo()
  const a = d.open()
  const b = d.open()
  d.write(d.agent, a.agent().stream, a.agent().local, 10 * KiB)
  d.deliver()
  // Home's socket dies first; the agent's only after its dead timer, so home's kept streams run out first.
  d.link.gone.home = true
  d.link.drop('home')
  d.home.cut()
  d.clock.advance(TUNNEL_RESUME_MS)
  assert.ok(a.homeLocal.destroyed && b.homeLocal.destroyed, 'home let go of the life')
  assert.equal(d.agent.count, 2, 'the agent still keeps its streams')
  // The agent dials: home greets a new life, and that WELCOME is lost with the socket.
  d.dial()
  d.deliverFrom('agent')
  assert.ok(d.link.flights.home.some((flight) => decodeTunnelFrame(flight.frame, 'home').kind === 'WELCOME'))
  d.cut()
  // The agent dials again with the same streams, numbered as before: home has not seen it take the new life, and greets it anew.
  d.dial()
  d.deliver()
  assert.deepEqual(d.ended.filter((end) => end.code !== null), [], 'no violation')
  assert.deepEqual(d.ups.slice(-2).map((up) => [up.side, up.resumed.resumed]), [['home', false], ['agent', false]])
  assert.ok(a.agent().local.destroyed && b.agent().local.destroyed)
  assert.equal(d.agent.count as number, 0)
  const c = d.open()
  assert.equal(c.agent().stream.state, 'open', 'and the life goes on')
})

test('a stream still opening at a cut resets at both ends: its OPEN, or its answer, may be lost with the socket', () => {
  const d = new Duo()
  d.answering = false
  const s = d.open()
  assert.equal(s.home.state, 'opening')
  assert.equal(s.agent().stream.state, 'opening', 'the Jupyter still connecting')
  d.cut()
  assert.ok(s.homeLocal.destroyed && s.agent().local.destroyed)
  // Answered at the agent but not yet heard at home: the agent offers it, home holds no such stream, and it is dropped.
  d.answering = true
  d.dial()
  d.deliver()
  assert.deepEqual(d.ups.slice(-2).map((up) => up.resumed.reset), [1, 1], 'each end counts the stream the cut cost it')
  const t = d.open(ROOM, false)
  d.deliver((from, frame) => from === 'agent' && frame.kind === 'OPENED')
  assert.equal(t.home.state, 'opening')
  assert.equal(t.agent().stream.state, 'open')
  d.cut()
  assert.ok(t.homeLocal.destroyed)
  d.dial()
  d.deliver()
  assert.ok(t.agent().local.destroyed && t.agent().stream.state === 'closed')
  assert.equal(d.home.count + d.agent.count, 0)
})

test('the ACK of what a receiver took goes again at a resume: a sender whose window filled while those ACKs were lost carries on', () => {
  const d = new Duo()
  const s = d.open()
  const agentSide = s.agent()
  // The agent fills its window towards home, home takes every byte, and its ACKs of them are still on their way at the cut.
  d.write(d.agent, agentSide.stream, agentSide.local, TUNNEL_WINDOW.interactive)
  d.deliverFrom('agent')
  assert.equal(s.homeLocal.got, TUNNEL_WINDOW.interactive)
  assert.equal(agentSide.stream.acked, 0, 'out of window: no ACK of home\'s reached the agent')
  d.cut()
  d.dial()
  d.deliver()
  // Home has nothing new to ACK, and says its last ACK again: the agent's window opens, and the stream goes on.
  assert.equal(agentSide.stream.acked, TUNNEL_WINDOW.interactive)
  d.write(d.agent, agentSide.stream, agentSide.local, 64 * KiB)
  d.deliver()
  assert.equal(s.homeLocal.got, TUNNEL_WINDOW.interactive + 64 * KiB)
  assert.equal(s.homeLocal.wrong, null)
})

test('a cut with more streams than one greeting lists resumes the oldest TUNNEL_RESUME_LIST_MAX and resets the rest, with no close', () => {
  const d = new Duo()
  const extra = 44
  const opened = Array.from({ length: TUNNEL_RESUME_LIST_MAX + extra }, () => d.open())
  d.cut()
  d.dial()
  d.deliver()
  assert.deepEqual(d.ended, [], 'no end closed: the HELLO kept within its cap')
  // Each end counts the streams the cut cost it: the agent reset those past its HELLO's list, home those the HELLO left out.
  assert.deepEqual(d.ups.slice(-2), [
    { side: 'home', resumed: { resumed: true, streams: TUNNEL_RESUME_LIST_MAX, reset: extra } },
    { side: 'agent', resumed: { resumed: true, streams: TUNNEL_RESUME_LIST_MAX, reset: extra } },
  ])
  for (const [i, s] of opened.entries()) {
    const kept = i < TUNNEL_RESUME_LIST_MAX
    assert.equal(s.home.state, kept ? 'open' : 'closed', `stream ${s.home.id}`)
    assert.equal(s.homeLocal.destroyed, !kept)
    assert.equal(s.agent().local.destroyed, !kept)
  }
})

test('greetings that fail after a cut do not restart its clock: what both ends kept resets TUNNEL_RESUME_MS after the cut itself', () => {
  const d = new Duo()
  const s = d.open()
  const agentSide = s.agent()
  d.write(d.home, s.home, s.homeLocal, 10 * KiB)
  d.deliver()
  d.cut()
  // Two dials in the next ninety seconds, and neither greets: one socket dies under its HELLO, the other's WELCOME never comes.
  d.clock.advance(40_000)
  d.dial()
  d.cut()
  d.clock.advance(40_000)
  d.dial()
  d.clock.advance(TUNNEL_GREETING_MS)
  assert.deepEqual(d.ended.at(-1), { side: 'agent', code: null }, 'the second greeting timed out: a cut, not the end')
  d.clock.advance(TUNNEL_RESUME_MS - 90_000 - 1)
  assert.ok(!s.homeLocal.destroyed && !agentSide.local.destroyed, 'kept until TUNNEL_RESUME_MS after the cut')
  d.clock.advance(1)
  assert.ok(s.homeLocal.destroyed && agentSide.local.destroyed, 'and not a moment longer at either end, however many greetings failed')
  assert.equal(d.home.count + d.agent.count, 0)
})

/* =========================================================== the real ends */

const FACTS: RemoteFacts = {
  version: '0.25.0', hostname: 'resume-test', platform: 'linux/amd64', cpus: 16, memoryMb: 65536, diskMb: 200_000,
  docker: '28.3.1', storage: 'overlay2', driver: null,
}

/** A machine joined with a code of its own, taking classes. */
function machine(): { id: string; credential: string } {
  const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, namePrefix: null, createdBy: 'tests' }).code
  const joined = joinRunner({ code, joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: FACTS, address: '127.0.0.1' }, Date.now())
  assert.ok(joined.ok)
  assert.ok('runner' in setRunnerClasses(joined.runner.id, true))
  return { id: joined.runner.id, credential: remoteCredential(joined.runner.id, joined.secret) }
}

const open = new Set<{ close(): unknown }>()
after(async () => {
  for (const thing of [...open].reverse()) await thing.close()
})

/** An HTTP server on 127.0.0.1 whose upgrades are a MachineTunnels' door; closed after the file. */
async function tunnelsServer(tunnels: MachineTunnels): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  server.on('upgrade', (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (!tunnels.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.add({
    close: () => new Promise<void>((resolve) => {
      tunnels.shutdown()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  })
  return (server.address() as net.AddressInfo).port
}

/** One TCP connection as either end of a stream sees it from outside: what it got, checked against the peer's pattern, and whether it ever closed. */
class Peer {
  got = 0
  wrong: string | null = null
  wrote = 0
  closed = false
  ended = false
  error: string | null = null

  constructor(
    readonly socket: net.Socket,
    readonly readTag: number,
    readonly writeTag: number,
  ) {
    socket.on('data', (chunk: Buffer) => {
      for (let i = 0; i < chunk.byteLength; i++) {
        if (chunk[i] !== pattern(readTag, this.got + i)) {
          this.wrong ??= `byte ${this.got + i}`
          break
        }
      }
      this.got += chunk.byteLength
    })
    socket.on('end', () => (this.ended = true))
    socket.on('error', (error: NodeJS.ErrnoException) => (this.error ??= error.code ?? error.message))
    socket.on('close', () => (this.closed = true))
  }

  send(bytes: number): void {
    this.socket.write(chunkOf(this.writeTag, this.wrote, bytes))
    this.wrote += bytes
  }
}

/** A placement's Jupyter as the agent's streams reach it: every connection it accepts, as a Peer. */
async function jupyter(): Promise<{ port: number; peers: Peer[] }> {
  const peers: Peer[] = []
  const server = net.createServer({ allowHalfOpen: true }, (socket) => peers.push(new Peer(socket, 0x51, 0x52)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.add({
    close: () => new Promise<void>((resolve) => {
      for (const peer of peers) peer.socket.destroy()
      server.close(() => resolve())
    }),
  })
  return { port: (server.address() as net.AddressInfo).port, peers }
}

/** Home's kernel client on a placement's listener: one connection, as a Peer. */
async function client(port: number): Promise<Peer> {
  const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  open.add({ close: () => socket.destroy() })
  return new Peer(socket, 0x52, 0x51)
}

/** Until `check` holds, or a hang guard of ten seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`never: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Moves a test clock a second at a time until `check` holds, letting the sockets work in between; a hang guard counts the seconds. */
async function advanceUntil(clock: Clock, check: () => boolean, what: string, seconds = 90): Promise<void> {
  for (let s = 0; !check(); s++) {
    if (s >= seconds) assert.fail(`never, in ${seconds} s of the test's clock: ${what}`)
    clock.advance(1_000)
    for (let turns = 0; turns < 20 && !check(); turns++) await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const homeClock = (): Clock => {
  const clock = new Clock()
  clock.t = Date.now()
  return clock
}

test('a 60 s cut with resume loses nothing, and the connections inside never close (§17.2 scenario 6)', async () => {
  const atHome = homeClock()
  const atAgent = homeClock()
  const lines: string[] = []
  const tunnels = new MachineTunnels({ clock: atHome, log: (line) => lines.push(line) })
  const port = await tunnelsServer(tunnels)
  const target = await jupyter()
  const m = machine()
  // The machine's path: while it is down, no dial gets through.
  let down = false
  let current: WebSocket | null = null
  let dials = 0
  const dial: TunnelDial = async (url, headers) => {
    dials++
    if (down) throw new Error('the path is down')
    current = await dialTunnel(url, headers, {})
    return current
  }
  const events: Array<[string, Record<string, unknown> | undefined]> = []
  const agent = new AgentTunnel({
    url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev', resolve: () => ({ port: target.port }),
    log: (event, detail) => events.push([event, detail]), dial, clock: atAgent, random: () => 0.5, relayState: async () => 'home_offline', paceMBps: () => 64,
  })
  open.add(agent)
  agent.want('open')
  await until(() => tunnels.isUp(m.id) && agent.state().up, 'the tunnel up')
  const listener = await tunnels.listen(m.id, ROOM, 1)
  open.add(listener)
  const link = tunnels.link(m.id, ROOM, 1)
  const kernel = await client(listener.port)
  await until(() => target.peers.length === 1, 'the stream reached the Jupyter')
  const jupyterSide = target.peers[0]
  kernel.send(200 * KiB)
  jupyterSide.send(300 * KiB)
  await until(() => jupyterSide.got === 200 * KiB && kernel.got === 300 * KiB, 'both ways before the cut')

  // The cut: the agent's socket goes at once, and the path stays down for a minute.
  down = true
  current!.terminate()
  await until(() => !tunnels.isUp(m.id) && !agent.state().up, 'down at both ends')
  assert.equal(link.up, false, 'the placement\'s link is down for the cut')
  // Both go on writing meanwhile: the kernel client a request, the Jupyter its output. It waits in the ends and behind them.
  kernel.send(150 * KiB)
  jupyterSide.send(MiB)
  // A minute on both clocks: every retry of the agent's fails, and the ends keep what they hold.
  for (let s = 0; s < 60; s++) {
    atAgent.advance(1_000)
    for (let turns = 0; turns < 4; turns++) await new Promise((resolve) => setImmediate(resolve))
  }
  atHome.advance(60_000)
  assert.ok(dials >= 4, `the agent kept trying: ${dials} dials`)
  assert.ok(!kernel.closed && !jupyterSide.closed, 'nothing inside closed')
  assert.ok(jupyterSide.got === 200 * KiB && kernel.got === 300 * KiB, 'nothing came through the cut')

  // The path heals: the next try gets through, the HELLO lists the stream, and both ends send again from what the other got.
  down = false
  const back = link.next(30_000)
  await advanceUntil(atAgent, () => agent.state().up, 'the agent back')
  assert.equal(await back, 'up')
  await until(() => jupyterSide.got === 350 * KiB && kernel.got === 300 * KiB + MiB, 'every byte of the cut, after it')
  assert.equal(kernel.wrong ?? jupyterSide.wrong, null, 'once and in order')
  assert.ok(!kernel.closed && !jupyterSide.closed && kernel.error === null && jupyterSide.error === null, 'no connection inside ever closed')
  assert.equal(target.peers.length, 1, 'no new connection to the Jupyter: the old one went on')
  assert.ok(link.up && tunnels.isUp(m.id))
  assert.ok(events.some(([event, detail]) => event === 'tunnel-up' && detail?.resumed === 1), JSON.stringify(events.filter(([event]) => event === 'tunnel-up')))
  assert.ok(lines.some((line) => line.includes('1 streams resumed')), lines.join('\n'))
  await agent.close()
})

test('a restarted agent resets every stream it had: home finds a new life in its HELLO', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const target = await jupyter()
  const m = machine()
  const options = { url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev', resolve: () => ({ port: target.port }), log: quiet, relayState: async () => 'home_offline' }
  const first = new AgentTunnel(options)
  open.add(first)
  first.want('open')
  await until(() => tunnels.isUp(m.id), 'the first life up')
  const listener = await tunnels.listen(m.id, ROOM, 1)
  open.add(listener)
  const kernels = await Promise.all([client(listener.port), client(listener.port)])
  await until(() => target.peers.length === 2, 'both streams reached the Jupyter')
  for (const kernel of kernels) kernel.send(10 * KiB)
  await until(() => target.peers.every((peer) => peer.got === 10 * KiB), 'bytes through the first life')
  // The agent stops (as a kill or an update stops it): its connections to the Jupyter go with it.
  await first.close()
  await until(() => !tunnels.isUp(m.id) && target.peers.every((peer) => peer.closed), 'the first life gone')
  assert.ok(kernels.every((kernel) => !kernel.closed), 'home keeps them for a resume, for now')
  // Its next life dials with a session of its own: home resets everything it kept.
  const second = new AgentTunnel(options)
  open.add(second)
  second.want('open')
  await until(() => tunnels.isUp(m.id), 'the second life up')
  await until(() => kernels.every((kernel) => kernel.closed), 'home reset what the first life had')
  assert.ok(kernels.every((kernel) => kernel.error === 'ECONNRESET' && kernel.got === 0), JSON.stringify(kernels.map((kernel) => kernel.error)))
  // And the new life carries new connections.
  const fresh = await client(listener.port)
  await until(() => target.peers.length === 3, 'a new stream')
  fresh.send(5 * KiB)
  target.peers[2].send(7 * KiB)
  await until(() => target.peers[2].got === 5 * KiB && fresh.got === 7 * KiB, 'through the new life')
  await second.close()
})

/** A TCP relay in front of home's door that can hold every connection it carries: nothing more passes either way, and nobody is told. */
async function holdingRelay(port: number): Promise<{ port: number; hold(): void }> {
  const pairs: Array<[net.Socket, net.Socket]> = []
  let holding: Array<[net.Socket, net.Socket]> = []
  const server = net.createServer((downstream) => {
    const upstream = net.connect(port, '127.0.0.1')
    pairs.push([downstream, upstream])
    for (const socket of [downstream, upstream]) socket.on('error', () => undefined)
    downstream.pipe(upstream)
    upstream.pipe(downstream)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.add({
    close: () => new Promise<void>((resolve) => {
      for (const [a, b] of [...pairs, ...holding]) {
        a.destroy()
        b.destroy()
      }
      server.close(() => resolve())
    }),
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    hold() {
      for (const [downstream, upstream] of pairs.splice(0)) {
        downstream.unpipe(upstream)
        upstream.unpipe(downstream)
        downstream.pause()
        upstream.pause()
        holding.push([downstream, upstream])
      }
    },
  }
}

test('a newer tunnel in the place of one home has not seen die goes on with its streams over it', async () => {
  // Home's clock stands still: it never notices the old socket died, and the newer one replaces it.
  const atHome = homeClock()
  const atAgent = homeClock()
  const tunnels = new MachineTunnels({ clock: atHome, log: quiet })
  const port = await tunnelsServer(tunnels)
  const relay = await holdingRelay(port)
  const target = await jupyter()
  const m = machine()
  const agent = new AgentTunnel({
    url: `ws://127.0.0.1:${relay.port}/api/runners/v1/tunnel`, authorization: m.credential, build: 'dev', resolve: () => ({ port: target.port }),
    log: quiet, clock: atAgent, random: () => 0.5, relayState: async () => 'home_offline', paceMBps: () => 64,
  })
  open.add(agent)
  agent.want('open')
  await until(() => tunnels.isUp(m.id) && agent.state().up, 'the tunnel up')
  const listener = await tunnels.listen(m.id, COUNCIL, 1)
  open.add(listener)
  const kernel = await client(listener.port)
  await until(() => target.peers.length === 1, 'the stream reached the Jupyter')
  const jupyterSide = target.peers[0]
  kernel.send(64 * KiB)
  jupyterSide.send(64 * KiB)
  await until(() => jupyterSide.got === 64 * KiB && kernel.got === 64 * KiB, 'both ways')
  // The path goes silent both ways with nothing said: the agent ends its socket after TUNNEL_DEAD_MS; home's stays.
  relay.hold()
  kernel.send(32 * KiB)
  jupyterSide.send(96 * KiB)
  atAgent.advance(TUNNEL_DEAD_MS)
  await until(() => !agent.state().up, 'the agent gave up its socket')
  assert.ok(tunnels.isUp(m.id), 'home has not noticed')
  await advanceUntil(atAgent, () => agent.state().up, 'the agent back through a new connection')
  await until(() => jupyterSide.got === 96 * KiB && kernel.got === 160 * KiB, 'what the silence held, after it')
  assert.equal(kernel.wrong ?? jupyterSide.wrong, null)
  assert.ok(!kernel.closed && !jupyterSide.closed && target.peers.length === 1, 'the same connections, open')
  const replaced = runnerEvents(m.id).filter((event) => (event.kind as string) === 'tunnel_replaced')
  assert.equal(replaced.length, 1, 'the newer tunnel took the older\'s place')
  await agent.close()
})

test('nothing is kept for a machine shut out or a tunnel home holds no placement for: a revoke resets home\'s streams, `closed` the agent\'s', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const target = await jupyter()
  const m = machine()
  const options = { url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev', resolve: () => ({ port: target.port }), log: quiet, relayState: async () => 'home_offline' }
  const agent = new AgentTunnel(options)
  open.add(agent)
  agent.want('open')
  await until(() => tunnels.isUp(m.id), 'up')
  const listener = await tunnels.listen(m.id, ROOM, 1)
  open.add(listener)
  const kernel = await client(listener.port)
  await until(() => target.peers.length === 1, 'the stream')
  // Home says it holds no placement here: the agent drops its connections to the Jupyter at once, rather than keep them.
  agent.want('closed')
  await until(() => target.peers[0].closed, 'the agent\'s connection dropped')
  await until(() => !tunnels.isUp(m.id), 'down')
  // Home kept its side for a resume, until the machine is shut out: then it goes at once.
  assert.equal(kernel.closed, false)
  agent.want('open')
  await until(() => tunnels.isUp(m.id), 'up again')
  const second = await client(listener.port)
  await until(() => target.peers.length === 2, 'a stream of the new tunnel')
  tunnels.close(m.id, TUNNEL_CLOSE.unauthorized, 'revoked')
  await until(() => second.closed, 'home dropped its side at once')
  assert.equal(second.error, 'ECONNRESET')
  await agent.close()
})

/** The streams a machine's two ends hold, open or kept: the ends' own counts, which nothing outside the tunnel modules reads. */
function held(tunnels: MachineTunnels, runnerId: string, agent: AgentTunnel): number {
  const home = (tunnels as unknown as { ends: Map<string, TunnelEnd> }).ends.get(runnerId)
  return (home?.count ?? 0) + (agent as unknown as { end: TunnelEnd }).end.count
}

test('a connection reset from outside after its own end (its listener closed) resets its stream at both ends, the peer still answering', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const target = await jupyter()
  const m = machine()
  const agent = new AgentTunnel({
    url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev', resolve: () => ({ port: target.port }),
    log: quiet, relayState: async () => 'home_online', paceMBps: () => 64,
  })
  open.add(agent)
  agent.want('open')
  await until(() => tunnels.isUp(m.id) && agent.state().up, 'the tunnel up')
  const listener = await tunnels.listen(m.id, ROOM, 1)
  const kernel = await client(listener.port)
  await until(() => target.peers.length === 1, 'the stream reached the Jupyter')
  const jupyterSide = target.peers[0]
  // The kernel client sends its request and its end, and the Jupyter has both.
  kernel.send(KiB)
  kernel.socket.end()
  await until(() => jupyterSide.got === KiB && jupyterSide.ended, 'the request and its end at the Jupyter')
  // The listener closes (a stop, a failover, a new gen) and drops the connection, its end already read; the Jupyter answers regardless.
  listener.close()
  jupyterSide.send(200 * KiB)
  jupyterSide.socket.end()
  // Nothing waits for bytes that connection can no longer take: the stream is reset at both ends, and its window is free.
  await until(() => held(tunnels, m.id, agent) === 0, 'the stream let go of at both ends')
  assert.ok(tunnels.isUp(m.id), 'the tunnel itself goes on')
  await agent.close()
})

/** A TCP relay in front of home's door that goes away as a proxy speaking WebSocket does when it reloads (Caddy on the relay): a close of 1001 to the agent, and its connection to home dropped. */
async function reloadingRelay(port: number): Promise<{ port: number; reload(): void }> {
  const sockets = new Set<net.Socket>()
  let pairs: Array<[net.Socket, net.Socket]> = []
  const server = net.createServer((downstream) => {
    const upstream = net.connect(port, '127.0.0.1')
    pairs.push([downstream, upstream])
    for (const socket of [downstream, upstream]) {
      sockets.add(socket)
      socket.on('error', () => undefined)
      socket.on('close', () => sockets.delete(socket))
    }
    downstream.pipe(upstream)
    upstream.pipe(downstream)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.add({
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    reload() {
      for (const [downstream, upstream] of pairs) {
        downstream.unpipe(upstream)
        upstream.unpipe(downstream)
        upstream.destroy()
        // A server's close frame, unmasked: FIN and opcode 8, a payload of two bytes, the code 1001 (going away). What the
        // agent answers is read and dropped, so that its end is read too and the connection closes.
        downstream.resume()
        downstream.end(Buffer.from([0x88, 0x02, 0x03, 0xe9]))
      }
      pairs = []
    },
  }
}

test('a proxy\'s 1001 is a cut the streams outlive, while a close of home\'s own drops the agent\'s side of them at once', async () => {
  // Both clocks stand still: no PING and no late ACK is on its way when the relay reloads, and the agent dials only when told.
  const atHome = homeClock()
  const atAgent = homeClock()
  const tunnels = new MachineTunnels({ clock: atHome, log: quiet })
  const port = await tunnelsServer(tunnels)
  const relay = await reloadingRelay(port)
  const target = await jupyter()
  const m = machine()
  const events: Array<[string, Record<string, unknown> | undefined]> = []
  const agent = new AgentTunnel({
    url: `ws://127.0.0.1:${relay.port}/api/runners/v1/tunnel`, authorization: m.credential, build: 'dev', resolve: () => ({ port: target.port }),
    log: (event, detail) => events.push([event, detail]), clock: atAgent, random: () => 0.5, relayState: async () => 'home_online', paceMBps: () => 64,
  })
  open.add(agent)
  agent.want('open')
  await until(() => tunnels.isUp(m.id) && agent.state().up, 'the tunnel up')
  const listener = await tunnels.listen(m.id, ROOM, 1)
  open.add(listener)
  const kernel = await client(listener.port)
  await until(() => target.peers.length === 1, 'the stream reached the Jupyter')
  const jupyterSide = target.peers[0]
  kernel.send(20 * KiB)
  jupyterSide.send(30 * KiB)
  await until(() => jupyterSide.got === 20 * KiB && kernel.got === 30 * KiB, 'both ways')
  await new Promise((resolve) => setTimeout(resolve, 20))
  relay.reload()
  await until(() => !agent.state().up, 'the agent heard the proxy go away')
  assert.ok(events.some(([event, detail]) => event === 'tunnel-down' && detail?.code === 1001), JSON.stringify(events))
  // No word of home's: the agent dials again, and the stream goes on over the next tunnel.
  await advanceUntil(atAgent, () => agent.state().up && tunnels.isUp(m.id), 'back through the relay')
  assert.ok(events.some(([event, detail]) => event === 'tunnel-up' && detail?.resumed === 1), JSON.stringify(events))
  kernel.send(10 * KiB)
  jupyterSide.send(10 * KiB)
  await until(() => jupyterSide.got === 30 * KiB && kernel.got === 40 * KiB, 'both ways after it')
  assert.ok(!kernel.closed && !jupyterSide.closed && kernel.wrong === null && jupyterSide.wrong === null)
  // Home's own close says its end is over, its side dropped: the agent drops its connection to the Jupyter at once, with no dial
  // in between, so that jupyter_server buffers what the kernel says next for the client's replay.
  tunnels.close(m.id, TUNNEL_CLOSE.forbidden, 'classes turned off')
  await until(() => kernel.closed, 'home dropped its side')
  await until(() => jupyterSide.closed, 'the agent dropped its connection to the Jupyter')
  await agent.close()
})
