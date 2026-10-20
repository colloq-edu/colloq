/**
 * The machines' tunnel of classes on machines, both ends and its door
 * (docs/architecture/remote-classes.md §4, §17.1): the one end both sides
 * run (shared/remote-tunnel.ts · TunnelEnd), home's door, tunnels, listeners
 * and links (server/src/kernel/remote/tunnel.ts), the agent's dialler and
 * streams (server/src/runner-agent/tunnel.ts), and the upgrade handler that
 * puts the door ahead of the browsers' Origin rule (server/src/upgrade.ts).
 *
 * What is checked is what breaks on the one socket every class of a machine
 * shares, and each of it fails quietly. A sender that let a council stream
 * go ahead of a room's, or a 6 MiB figure ahead of a print, makes a lecture
 * wait for attempts' plots; one past its window, or one that buffered in
 * the socket rather than in its queues, makes a keystroke wait behind
 * megabytes; a bucket that released a second's worth at once is the burst
 * K0 measured raising the relay's p99 to a second. A door that took a room
 * token, or a cookie riding with the credential, or let the Origin rule fall
 * for the browsers' paths, opens a machine's kernels to a page; an agent that
 * connected where home said would make every machine a proxy into its own
 * network. A door that refused a quarantined or outdated machine would fail
 * the classes it still holds over at their next reconnect; one that let a
 * second holder of the secret spend the machine's tries, or its log fill
 * with a machine replacing itself, would hide the takeover its owner is
 * warned of. And an agent that redialled at once for ever, after a refusal,
 * would hammer home exactly when it said no.
 *
 * The engine's tests run on stub sockets and a clock of their own, and count
 * frames, never milliseconds. The door's, the listeners' and the end-to-end
 * ones use real sockets on 127.0.0.1, where a deadline only guards against a
 * hang.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http, { type IncomingMessage } from 'node:http'
import net from 'node:net'
import { EventEmitter, once } from 'node:events'
import { Readable } from 'node:stream'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { REMOTE_MARKER, REMOTE_MARKER_HEADER, remoteCredential, type RemoteFacts } from '../shared/remote-runner.js'
import {
  TUNNEL_ACK_BYTES,
  TUNNEL_CLOSE,
  TUNNEL_COUNCIL_SHARE,
  TUNNEL_DEAD_MS,
  TUNNEL_FRAME_MAX,
  TUNNEL_GREETING_MS,
  TUNNEL_HEADER_BYTES,
  TUNNEL_PING_MS,
  TUNNEL_PROTOCOL_HEADER,
  TUNNEL_SELF_REPLACEMENTS_LOGGED,
  TUNNEL_SEND_LOWAT,
  TUNNEL_STREAMS_MAX,
  TUNNEL_UPGRADES,
  TUNNEL_WINDOW,
  TunnelEnd,
  TunnelPace,
  decodeTunnelFrame,
  encodeTunnelFrame,
  pipeTcp,
  tunnelKindByte,
  tunnelLocalOf,
  tunnelUrl,
  type TunnelClock,
  type TunnelFrame,
  type TunnelLocal,
  type TunnelSide,
  type TunnelSocket,
  type TunnelStream,
} from '../shared/remote-tunnel.js'
import { MachineTunnels, machineTunnels, tunnelReplacementAlert, useMachineTunnels } from '../server/src/kernel/remote/tunnel.js'
import { AgentTunnel, type TunnelDial } from '../server/src/runner-agent/tunnel.js'
import { handleUpgrade } from '../server/src/upgrade.js'
import { joinRunner, mintRemoteCode, runnerEvents, setRunnerClasses, updateRunner, useHomeRunnerBuild } from '../server/src/competitions/remote/store.js'
import { heardAt } from '../server/src/competitions/remote/heard.js'
import { callCounts } from '../server/src/competitions/remote/routes.js'
import { signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'

const MiB = 1024 * 1024
const KiB = 1024
const ROOM = 'tunnel_room:room'
const COUNCIL = 'tunnel_room:council'
const quiet = (): void => undefined

/* ===================================================== the engine, on stubs */

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

  /** How long until each timer waiting now runs. */
  waits(): number[] {
    return [...this.timers.values()].map((timer) => timer.at - this.t).sort((a, b) => a - b)
  }
}

/**
 * A WebSocket as an end sees it. `instant` writes every frame out at once;
 * `held` keeps them in its buffer (bufferedAmount) until `flush`; `never`
 * neither buffers nor calls back, as a socket whose callbacks a real one
 * would hide.
 */
class Wire implements TunnelSocket {
  bufferedAmount = 0
  /** Frames sent and not yet taken by the test. */
  readonly frames: Uint8Array[] = []
  /** bufferedAmount at each send. */
  readonly bufferedAtSend: number[] = []
  private readonly held: Array<{ size: number; done: (error?: Error) => void }> = []

  constructor(private readonly mode: 'instant' | 'held' | 'never' = 'instant') {}

  send(frame: Uint8Array, done: (error?: Error) => void): void {
    this.bufferedAtSend.push(this.bufferedAmount)
    this.frames.push(frame)
    if (this.mode === 'instant') return done()
    if (this.mode === 'never') return
    this.bufferedAmount += frame.byteLength
    this.held.push({ size: frame.byteLength, done })
  }

  /** Write out `count` held frames, oldest first, each with its callback. */
  flush(count = Number.POSITIVE_INFINITY): void {
    for (; count > 0 && this.held.length > 0; count--) {
      const next = this.held.shift()!
      this.bufferedAmount -= next.size
      next.done()
    }
  }

  take(): Uint8Array[] {
    return this.frames.splice(0)
  }
}

/** A stream's local connection that writes down what it is given, takes it at once or when told, and remembers being paused, ended or dropped. */
class Local implements TunnelLocal {
  readonly chunks: Uint8Array[] = []
  ended = false
  destroyed = false
  paused = false
  private readonly held: Array<() => void> = []

  constructor(private readonly taking = true) {}

  write(payload: Uint8Array, taken: () => void): void {
    this.chunks.push(payload.slice())
    if (this.taking) taken()
    else this.held.push(taken)
  }

  take(count = Number.POSITIVE_INFINITY): void {
    for (; count > 0 && this.held.length > 0; count--) this.held.shift()!()
  }

  end(): void {
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

  get bytes(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  }
}

const decodeAll = (frames: Uint8Array[], from: TunnelSide): TunnelFrame[] => frames.map((frame) => decodeTunnelFrame(frame, from))
const dataOf = (frames: TunnelFrame[]) => frames.filter((frame): frame is Extract<TunnelFrame, { kind: 'DATA' }> => frame.kind === 'DATA')
const dataBytes = (frames: TunnelFrame[]): number => dataOf(frames).reduce((sum, frame) => sum + frame.payload.byteLength, 0)
const filled = (size: number, byte = 0x5a): Uint8Array => new Uint8Array(size).fill(byte)

interface Pair {
  clock: Clock
  home: TunnelEnd
  agent: TunnelEnd
  homeWire: Wire
  agentWire: Wire
  /** The agent's local connections, by stream. */
  agentLocals: Map<number, Local>
  agentStreams: Map<number, TunnelStream>
  ended: Array<{ side: TunnelSide; code: number | null; reason: string }>
  rtts: number[]
  /** Every frame sent so far reaches the other end, until neither has more to say. */
  deliver(): void
}

/** A home end and an agent end greeted over two wires; the agent opens every stream at once into a Local of its own. */
function pair(options: { homeWire?: Wire; agentWire?: Wire; pace?: TunnelPace | null; clock?: Clock; agentTaking?: boolean } = {}): Pair {
  const clock = options.clock ?? new Clock()
  const homeWire = options.homeWire ?? new Wire()
  const agentWire = options.agentWire ?? new Wire()
  const ended: Pair['ended'] = []
  const rtts: number[] = []
  const agentLocals = new Map<number, Local>()
  const agentStreams = new Map<number, TunnelStream>()
  const home: TunnelEnd = new TunnelEnd({
    side: 'home', socket: homeWire, clock, build: 'dev', session: 'a'.repeat(32),
    hooks: { end: (code, reason) => ended.push({ side: 'home', code, reason }), rtt: (ms) => rtts.push(ms) },
  })
  const agent: TunnelEnd = new TunnelEnd({
    side: 'agent', socket: agentWire, clock, build: 'dev', session: 'b'.repeat(32), pace: options.pace ?? null,
    hooks: {
      open: (stream) => {
        const local = new Local(options.agentTaking ?? true)
        agentLocals.set(stream.id, local)
        agentStreams.set(stream.id, stream)
        agent.accept(stream, local)
        agent.opened(stream)
      },
      end: (code, reason) => ended.push({ side: 'agent', code, reason }),
    },
  })
  const deliver = (): void => {
    for (let moved = true; moved;) {
      moved = false
      for (const frame of homeWire.take()) {
        agent.receive(frame, true)
        moved = true
      }
      for (const frame of agentWire.take()) {
        home.receive(frame, true)
        moved = true
      }
    }
  }
  home.start()
  agent.start()
  deliver()
  assert.ok(home.up && agent.up, 'greeted both ways')
  return { clock, home, agent, homeWire, agentWire, agentLocals, agentStreams, ended, rtts, deliver }
}

/** A stream home opens and the agent answers. */
function openStream(p: Pair, key = ROOM, local = new Local()): { stream: TunnelStream; local: Local } {
  const stream = p.home.open(key, 1, local)
  assert.ok(stream, 'the stream opens')
  p.deliver()
  assert.equal(stream.state, 'open')
  return { stream, local }
}

test('a stream alone in its lane sends frame after frame, never one frame per callback of the socket', () => {
  // The round robin's edge K0 met on its own sender: a lone stream whose turn ran out had to wait for the next write callback.
  const p = pair({ homeWire: new Wire('never') })
  const { stream } = openStream(p)
  p.homeWire.take()
  p.home.write(stream, filled(MiB))
  const data = dataOf(decodeAll(p.homeWire.take(), 'home'))
  assert.equal(data.length, MiB / TUNNEL_FRAME_MAX)
  assert.ok(data.every((frame) => frame.payload.byteLength === TUNNEL_FRAME_MAX))
  assert.deepEqual(data.map((frame) => frame.offset), data.map((_, i) => i * TUNNEL_FRAME_MAX))
})

test('lanes are strict: the interactive lane goes first, the council lane after it', () => {
  const p = pair({ homeWire: new Wire('held') })
  const council = openStream(p, COUNCIL)
  const room = openStream(p, ROOM)
  p.homeWire.flush()
  p.homeWire.take()
  // The council fills the socket first; what both lanes queue after waits in the end, where the lanes still apply.
  p.home.write(council.stream, filled(80 * KiB))
  const before = dataOf(decodeAll(p.homeWire.take(), 'home'))
  assert.ok(before.length > 0 && p.homeWire.bufferedAmount > TUNNEL_SEND_LOWAT)
  p.home.write(council.stream, filled(128 * KiB))
  p.home.write(room.stream, filled(128 * KiB))
  const order: number[] = []
  for (let rounds = 0; rounds < 200 && order.length < 17; rounds++) {
    p.homeWire.flush(1)
    order.push(...dataOf(decodeAll(p.homeWire.take(), 'home')).map((frame) => frame.stream))
  }
  const lastRoom = order.lastIndexOf(room.stream.id)
  const firstCouncil = order.indexOf(council.stream.id)
  assert.equal(order.filter((id) => id === room.stream.id).length, 8)
  assert.ok(lastRoom < firstCouncil, `every room frame before the council's: ${order.join(' ')}`)
})

test('deficit round robin within a lane: a 6 MiB figure lets every print through before its next frame', () => {
  const p = pair({ homeWire: new Wire('held') })
  const figure = openStream(p)
  const prints = Array.from({ length: 10 }, () => openStream(p))
  p.homeWire.flush()
  p.homeWire.take()
  p.home.write(figure.stream, filled(6 * MiB))
  dataOf(decodeAll(p.homeWire.take(), 'home'))
  for (const print of prints) p.home.write(print.stream, filled(120))
  const order: number[] = []
  for (let rounds = 0; rounds < 100 && order.length < 20; rounds++) {
    p.homeWire.flush(1)
    order.push(...dataOf(decodeAll(p.homeWire.take(), 'home')).map((frame) => frame.stream))
  }
  assert.deepEqual(order.slice(0, 10), prints.map((print) => print.stream.id), `the prints first, one turn each: ${order.join(' ')}`)
  assert.ok(order.slice(10).every((id) => id === figure.stream.id), 'then the figure again')
})

test('a frame goes to the socket only while it holds at most TUNNEL_SEND_LOWAT unwritten', () => {
  const p = pair({ homeWire: new Wire('held') })
  const { stream } = openStream(p)
  p.homeWire.flush()
  p.homeWire.take()
  p.homeWire.bufferedAtSend.length = 0
  p.home.write(stream, filled(MiB))
  const first = dataOf(decodeAll(p.homeWire.take(), 'home')).length
  assert.equal(first, Math.ceil((TUNNEL_SEND_LOWAT + 1) / (TUNNEL_FRAME_MAX + TUNNEL_HEADER_BYTES)), 'the socket fills just past the mark, then nothing more goes')
  p.homeWire.flush(1)
  assert.equal(dataOf(decodeAll(p.homeWire.take(), 'home')).length, 1, 'one written out, one more in')
  for (let rounds = 0; rounds < 1000 && p.homeWire.bufferedAmount > 0; rounds++) p.homeWire.flush(1)
  assert.ok(p.homeWire.bufferedAtSend.every((buffered) => buffered <= TUNNEL_SEND_LOWAT), 'no frame was sent past the mark')
})

test('windows are never exceeded: 4 MiB per interactive stream, 1 MiB per council stream, 16 MiB per machine', () => {
  assert.deepEqual(TUNNEL_WINDOW, { interactive: 4 * MiB, council: MiB, machine: 16 * MiB })
  const p = pair({ agentTaking: false })
  const room = openStream(p, ROOM)
  const council = openStream(p, COUNCIL)
  p.home.write(room.stream, filled(6 * MiB))
  p.home.write(council.stream, filled(2 * MiB))
  p.deliver()
  // Nobody took a byte on the agent's side: no ACK, so each stream stops at its window and its connection is paused.
  assert.equal(p.agentLocals.get(room.stream.id)!.bytes, 4 * MiB)
  assert.equal(p.agentLocals.get(council.stream.id)!.bytes, MiB)
  assert.equal(room.stream.sent - room.stream.acked, 4 * MiB)
  assert.ok(room.local.paused && council.local.paused, 'the senders\' connections are paused')
  // The reader takes 64 KiB: one ACK, and exactly as much more goes.
  p.agentLocals.get(room.stream.id)!.take(TUNNEL_ACK_BYTES / TUNNEL_FRAME_MAX)
  p.deliver()
  assert.equal(room.stream.acked, TUNNEL_ACK_BYTES)
  assert.equal(p.agentLocals.get(room.stream.id)!.bytes, 4 * MiB + TUNNEL_ACK_BYTES)
  assert.equal(room.stream.sent - room.stream.acked, 4 * MiB)

  // Five interactive streams would hold 20 MiB; the machine's window stops them all at 16.
  const many = pair({ agentTaking: false })
  const streams = Array.from({ length: 5 }, () => openStream(many, ROOM).stream)
  for (const stream of streams) many.home.write(stream, filled(5 * MiB))
  many.deliver()
  const inFlight = streams.reduce((sum, stream) => sum + stream.sent - stream.acked, 0)
  assert.equal(inFlight, 16 * MiB)
  assert.equal([...many.agentLocals.values()].reduce((sum, local) => sum + local.bytes, 0), 16 * MiB)
  assert.deepEqual(many.ended, [])

  // Twenty full council streams hold 12 MiB, never the whole machine: a room's stream still sends a window behind them.
  const busy = pair({ agentTaking: false })
  const attempts = Array.from({ length: 20 }, () => openStream(busy, COUNCIL).stream)
  for (const stream of attempts) busy.home.write(stream, filled(2 * MiB))
  busy.deliver()
  assert.equal(attempts.reduce((sum, stream) => sum + stream.sent - stream.acked, 0), TUNNEL_COUNCIL_SHARE)
  assert.equal(TUNNEL_COUNCIL_SHARE, 12 * MiB)
  const lecture = openStream(busy, ROOM).stream
  busy.home.write(lecture, filled(5 * MiB))
  busy.deliver()
  assert.equal(lecture.sent, 4 * MiB, 'the room\'s lane has its whole window')
})

test('a council stream that found the lane\'s share full sends once the room\'s ACKs free it, with nothing of its own in flight', () => {
  const p = pair({ agentTaking: false })
  const room = openStream(p, ROOM).stream
  const attempts = Array.from({ length: 8 }, () => openStream(p, COUNCIL).stream)
  p.home.write(room, filled(4 * MiB))
  for (const stream of attempts) p.home.write(stream, filled(MiB))
  p.deliver()
  // 4 MiB of the room's and 8 of the attempts' are in flight: the council lane's 12 MiB are spent.
  const late = openStream(p, COUNCIL).stream
  p.home.write(late, filled(100 * KiB))
  p.deliver()
  assert.equal(late.sent, 0, 'the lane\'s share is spent')
  // The lecture's reader takes everything: its ACKs free the share, and the late stream goes though no ACK of its own will come.
  p.agentLocals.get(room.id)!.take()
  p.deliver()
  assert.equal(late.sent, 100 * KiB)
  assert.equal(p.agentLocals.get(late.id)!.bytes, 100 * KiB)
})

test('a peer past its window is a violation, and so is DATA out of order or of a stream never opened', () => {
  const p = pair({ agentTaking: false })
  const { stream } = openStream(p)
  const frames = (from: number, count: number) => Array.from({ length: count }, (_, i) => encodeTunnelFrame({
    kind: 'DATA', stream: stream.id, lane: 1, offset: (from + i) * TUNNEL_FRAME_MAX, payload: filled(TUNNEL_FRAME_MAX), fin: false,
  }))
  for (const frame of frames(0, TUNNEL_WINDOW.interactive / TUNNEL_FRAME_MAX)) p.agent.receive(frame, true)
  assert.equal(p.ended.length, 0, 'a whole window is the peer\'s right')
  p.agent.receive(frames(TUNNEL_WINDOW.interactive / TUNNEL_FRAME_MAX, 1)[0], true)
  assert.equal(p.ended.at(-1)?.code, TUNNEL_CLOSE.violation)
  assert.match(p.ended.at(-1)!.reason, /past its window/)

  const q = pair()
  const opened = openStream(q).stream
  q.agent.receive(encodeTunnelFrame({ kind: 'DATA', stream: opened.id, lane: 1, offset: 5, payload: filled(10), fin: false }), true)
  assert.equal(q.ended.at(-1)?.code, TUNNEL_CLOSE.violation)

  const r = pair()
  r.home.receive(encodeTunnelFrame({ kind: 'DATA', stream: 7, lane: 1, offset: 0, payload: filled(10), fin: false }), true)
  assert.equal(r.ended.at(-1)?.code, TUNNEL_CLOSE.violation)
  assert.match(r.ended.at(-1)!.reason, /never opened/)

  const s = pair()
  const sent = openStream(s).stream
  s.home.write(sent, filled(100))
  s.homeWire.take()
  s.home.receive(encodeTunnelFrame({ kind: 'ACK', stream: sent.id, lane: 1, offset: 101 }), true)
  assert.equal(s.ended.at(-1)?.code, TUNNEL_CLOSE.violation, 'an ACK of bytes never sent')
})

test('a receiver ACKs as its connection drains: at once after 64 KiB, else 50 ms after the first byte', () => {
  const p = pair()
  const { stream } = openStream(p)
  p.homeWire.take()
  p.agentWire.take()
  const acks = (): Array<Extract<TunnelFrame, { kind: 'ACK' }>> => decodeAll(p.agentWire.take(), 'agent').filter((frame): frame is Extract<TunnelFrame, { kind: 'ACK' }> => frame.kind === 'ACK')
  p.home.write(stream, filled(1000))
  for (const frame of p.homeWire.take()) p.agent.receive(frame, true)
  assert.deepEqual(acks(), [], 'not yet')
  p.clock.advance(49)
  assert.deepEqual(acks(), [], 'not before 50 ms')
  p.clock.advance(1)
  assert.deepEqual(acks().map((ack) => ack.offset), [1000])
  p.home.write(stream, filled(TUNNEL_ACK_BYTES))
  for (const frame of p.homeWire.take()) p.agent.receive(frame, true)
  assert.deepEqual(acks().map((ack) => ack.offset), [1000 + TUNNEL_ACK_BYTES], 'at once, with no clock')
})

test('an OPEN from the agent closes the tunnel: only home opens streams', () => {
  const p = pair()
  p.home.receive(encodeTunnelFrame({ kind: 'OPEN', stream: 1, lane: 1, open: { key: ROOM, gen: 1 } }), true)
  assert.equal(p.ended.at(-1)?.side, 'home')
  assert.equal(p.ended.at(-1)?.code, TUNNEL_CLOSE.violation)
  assert.ok(p.home.closed)
})

/** A HELLO of tunnel protocol 2, as no encoder of this build writes one. */
function otherProtocolHello(): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ protocol: 2, build: 'dev', session: 'b'.repeat(32) }))
  const hello = new Uint8Array(TUNNEL_HEADER_BYTES + json.byteLength)
  hello[0] = tunnelKindByte('HELLO')
  hello.set(json, TUNNEL_HEADER_BYTES)
  return hello
}

test('a HELLO of another tunnel protocol is refused with 4426, a text message and frames before the greeting with 4400', () => {
  // The engine's own greeting, for an end that reads its first frame itself; home's door reads it before any end (below).
  const ended: Array<number | null> = []
  const end = () => new TunnelEnd({ side: 'home', socket: new Wire(), clock: new Clock(), build: 'dev', session: 'a'.repeat(32), hooks: { end: (code) => ended.push(code) } })
  end().receive(otherProtocolHello(), true)
  end().receive(new TextEncoder().encode('hello'), false)
  end().receive(encodeTunnelFrame({ kind: 'PING', id: 1 }), true)
  assert.deepEqual(ended, [TUNNEL_CLOSE.protocol, TUNNEL_CLOSE.violation, TUNNEL_CLOSE.violation])
})

test('home opens at most TUNNEL_STREAMS_MAX streams on one tunnel', () => {
  const p = pair()
  for (let i = 0; i < TUNNEL_STREAMS_MAX; i++) assert.ok(p.home.open(ROOM, 1, new Local()))
  assert.equal(p.home.open(ROOM, 1, new Local()), null)
  assert.equal(p.home.count, TUNNEL_STREAMS_MAX)
})

test('a stream ends both ways in order, with FIN or END, and is let go of once both sides ended', () => {
  const p = pair()
  const { stream, local } = openStream(p)
  p.home.write(stream, filled(40 * KiB, 1))
  p.home.finish(stream)
  p.deliver()
  const agentLocal = p.agentLocals.get(stream.id)!
  assert.equal(agentLocal.bytes, 40 * KiB)
  assert.ok(agentLocal.ended, 'the agent\'s connection half-closed after the bytes')
  const agentStream = p.agentStreams.get(stream.id)!
  p.agent.write(agentStream, filled(10, 2))
  p.agent.finish(agentStream)
  p.deliver()
  assert.equal(local.bytes, 10)
  assert.ok(local.ended)
  assert.equal(p.home.count, 0)
  assert.equal(p.agent.count, 0)
  assert.ok(!local.destroyed && !agentLocal.destroyed, 'an orderly end drops nothing')
})

/** A node:net Socket as the wiring hears it: events the test emits, writes it keeps. */
class FakeTcp extends EventEmitter {
  destroyed = false
  connecting = false
  ended = false
  readonly writes: Uint8Array[] = []

  write(data: Uint8Array, done: (error?: Error | null) => void): boolean {
    this.writes.push(data.slice())
    done()
    return true
  }

  end(): void {
    this.ended = true
  }

  destroy(): void {
    this.destroyed = true
  }

  pause(): void {}

  resume(): void {}
}

test('a connection that ended in order and closed keeps its stream until the bytes it queued, and its END, are out', () => {
  const p = pair({ homeWire: new Wire('held') })
  const socket = new FakeTcp()
  const stream = p.home.open(ROOM, 1, tunnelLocalOf(socket))!
  pipeTcp(p.home, stream, socket)
  p.deliver()
  p.homeWire.flush()
  p.homeWire.take()
  // The answer's far side has already hung up: the agent's END is in.
  p.agent.finish(p.agentStreams.get(stream.id)!)
  for (const frame of p.agentWire.take()) p.home.receive(frame, true)
  assert.ok(socket.ended, 'the peer\'s END half-closed the connection')
  // The client sends its last 200 KiB and its FIN, and closes: the socket holds most of the bytes back (TUNNEL_SEND_LOWAT).
  socket.emit('data', filled(200 * KiB))
  socket.emit('end')
  socket.emit('close', false)
  assert.ok(stream.queued > 0, 'bytes are still queued when the connection closes')
  assert.equal(decodeAll(p.homeWire.frames, 'home').filter((frame) => frame.kind === 'RESET').length, 0, 'an orderly close is no RESET')
  p.homeWire.flush()
  for (let rounds = 0; rounds < 100 && p.homeWire.bufferedAmount > 0; rounds++) p.homeWire.flush()
  p.deliver()
  const agentLocal = p.agentLocals.get(stream.id)!
  assert.equal(agentLocal.bytes, 200 * KiB, 'every byte reached the far side')
  assert.ok(agentLocal.ended, 'and its end after them')
  assert.equal(stream.state, 'closed')
  assert.ok(!socket.destroyed)

  // A connection that broke resets its stream at once.
  const broken = new FakeTcp()
  const second = p.home.open(ROOM, 1, tunnelLocalOf(broken))!
  pipeTcp(p.home, second, broken)
  p.deliver()
  broken.emit('close', true)
  assert.equal(second.state, 'closed')
  assert.equal(decodeAll(p.homeWire.take(), 'home').filter((frame) => frame.kind === 'RESET').length, 1)
})

test('PING every 10 s from each side, an RTT from each PONG, and the end after 25 s without a frame', () => {
  const p = pair()
  const pings = (wire: Wire, from: TunnelSide) => decodeAll(wire.take(), from).filter((frame) => frame.kind === 'PING').length
  p.clock.advance(0)
  assert.equal(pings(p.homeWire, 'home'), 1, 'the first PING goes as the tunnel opens')
  p.clock.advance(TUNNEL_PING_MS - 1)
  assert.equal(pings(p.homeWire, 'home'), 0)
  p.clock.advance(1)
  // Its PONG comes back 120 ms later.
  const sent = p.homeWire.take()
  assert.equal(decodeAll(sent, 'home').filter((frame) => frame.kind === 'PING').length, 1)
  p.clock.advance(120)
  for (const frame of sent) p.agent.receive(frame, true)
  for (const frame of p.agentWire.take()) p.home.receive(frame, true)
  assert.ok(p.rtts.includes(120), `an RTT of 120 ms: ${p.rtts.join(', ')}`)
  // From now on the agent says nothing: home ends the socket with no handshake once 25 s pass without a frame.
  p.agentWire.take()
  p.clock.advance(TUNNEL_DEAD_MS - 1)
  assert.equal(p.ended.filter((end) => end.side === 'home').length, 0)
  p.clock.advance(1)
  const ended = p.ended.find((end) => end.side === 'home')
  assert.equal(ended?.code, null, 'terminated, no close frame on a dead link')
  // A cut, not the end: the end waits for the next socket with what it kept (§4.8), and pings no more meanwhile.
  assert.ok(!p.home.up && !p.home.attached && !p.home.closed)
  p.homeWire.take()
  p.clock.advance(3 * TUNNEL_PING_MS)
  assert.equal(pings(p.homeWire, 'home'), 0)
  assert.equal(p.ended.filter((end) => end.side === 'home').length, 1)
})

test('the machine\'s pace: a 2 MiB burst, then 6 MiB/s refilled smoothly on its clock, never a second\'s worth at once', () => {
  const clock = new Clock()
  const pace = new TunnelPace(clock, () => 6 * MiB, 2 * MiB)
  const p = pair({ clock, pace })
  const { stream } = openStream(p)
  const agentStream = p.agentStreams.get(stream.id)!
  const start = clock.now()
  p.agent.write(agentStream, filled(8 * MiB))
  let sent = 0
  let most = 0
  const timeline: Array<[number, number]> = []
  for (let step = 0; step < 3000 && sent < 8 * MiB; step++) {
    const frames = p.agentWire.take()
    const bytes = dataBytes(decodeAll(frames, 'agent'))
    sent += bytes
    if (clock.now() > start) most = Math.max(most, bytes)
    timeline.push([clock.now() - start, sent])
    for (const frame of frames) p.home.receive(frame, true)
    for (const frame of p.homeWire.take()) p.agent.receive(frame, true)
    clock.advance(1)
  }
  assert.equal(sent, 8 * MiB)
  for (const [ms, bytes] of timeline) {
    assert.ok(bytes <= 2 * MiB + (6 * MiB * ms) / 1000 + TUNNEL_FRAME_MAX, `at ${ms} ms ${bytes} B: over the bucket`)
  }
  // It keeps the pace: 8 MiB is the burst and one second more, give or take a frame per millisecond of rounding.
  const done = timeline.find(([, bytes]) => bytes === 8 * MiB)![0]
  assert.ok(done >= 1000 - 5 && done <= 1000 + 50, `the last byte at ${done} ms`)
  assert.ok(most <= 2 * TUNNEL_FRAME_MAX, `after the burst at most ${most} B in a millisecond`)
})

/* ============================================================ the real sockets */

const FACTS: RemoteFacts = {
  version: '0.25.0', hostname: 'tunnel-test', platform: 'linux/amd64', cpus: 16, memoryMb: 65536, diskMb: 200_000,
  docker: '28.3.1', storage: 'overlay2', driver: null,
}

interface Machine {
  id: string
  credential: string
}

/** A machine joined with a code of its own; it takes classes unless told otherwise. */
function machine(options: { classes?: boolean } = {}): Machine {
  const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, namePrefix: null, createdBy: 'tests' }).code
  const joined = joinRunner({ code, joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: FACTS, address: '127.0.0.1' }, Date.now())
  assert.ok(joined.ok)
  if (options.classes !== false) assert.ok('runner' in setRunnerClasses(joined.runner.id, true))
  return { id: joined.runner.id, credential: remoteCredential(joined.runner.id, joined.secret) }
}

const open = new Set<{ close(): unknown }>()
const sockets = new Set<WebSocket>()
after(async () => {
  for (const ws of sockets) ws.terminate()
  for (const thing of open) await thing.close()
  machineTunnels().shutdown()
})

/** An HTTP server on 127.0.0.1 whose upgrades go to `onUpgrade`; closed after the file. */
async function serve(onUpgrade: (req: IncomingMessage, socket: net.Socket, head: Buffer) => void): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  server.on('upgrade', onUpgrade)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.add({
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  })
  return (server.address() as net.AddressInfo).port
}

/** A server with this module's own door in front, as the process has it (upgrade.ts · handleUpgrade). */
let doorPort = 0
async function door(): Promise<number> {
  doorPort ||= await serve((req, socket, head) => handleUpgrade(req, socket, head))
  return doorPort
}

/** A server whose only upgrades are a MachineTunnels' door of the test's own. */
async function tunnelsServer(tunnels: MachineTunnels): Promise<number> {
  open.add({ close: () => tunnels.shutdown() })
  return serve((req, socket, head) => {
    if (!tunnels.handleUpgrade(req, socket, head)) socket.destroy()
  })
}

interface Knock {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
  ws: WebSocket | null
}

/** One upgrade: the refusal as it came, or the socket it opened. */
function knock(port: number, path: string, headers: Record<string, string> = {}): Promise<Knock> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, perMessageDeflate: false })
    sockets.add(ws)
    let upgraded: http.IncomingHttpHeaders = {}
    ws.on('upgrade', (response) => (upgraded = response.headers))
    ws.on('open', () => resolve({ status: 101, headers: upgraded, body: '', ws }))
    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, ws: null })
        ws.terminate()
      })
    })
    ws.on('error', () => undefined)
  })
}

const TUNNEL = '/api/runners/v1/tunnel'
const machineHeaders = (m: Machine, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${m.credential}`, [TUNNEL_PROTOCOL_HEADER]: '1', ...extra,
})

/** A marked refusal: its status, its marker, its error word. */
function refused(knocked: Knock, status: number, error: string): void {
  assert.equal(knocked.status, status, knocked.body)
  assert.equal(knocked.headers[REMOTE_MARKER_HEADER.toLowerCase()], REMOTE_MARKER, 'every refusal of the door is marked')
  assert.equal((JSON.parse(knocked.body) as { error: string }).error, error)
}

/** A raw agent: an upgraded socket whose frames the test writes itself. */
async function rawAgent(port: number, m: Machine, extra: Record<string, string> = {}) {
  const knocked = await knock(port, TUNNEL, machineHeaders(m, extra))
  assert.equal(knocked.status, 101, knocked.body)
  const ws = knocked.ws!
  const frames: TunnelFrame[] = []
  ws.on('message', (data: Buffer) => frames.push(decodeTunnelFrame(data, 'home')))
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  return { ws, frames, closed, headers: knocked.headers }
}

const helloFrame = (build = 'dev', session = randomBytes(16).toString('hex')) => encodeTunnelFrame({ kind: 'HELLO', hello: { protocol: 1, build, session } })

/** Until `check` holds, or a hang guard of ten seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`never: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The code a raw agent's socket closed with, within the hang guard: a tunnel that stays open fails, never hangs. */
async function closedCode(agent: { closed: Promise<{ code: number }> }, what: string): Promise<number> {
  let code: number | null = null
  void agent.closed.then((closed) => (code = closed.code))
  await until(() => code !== null, what)
  return code!
}

test('only a machine\'s credential, in its header, opens the tunnel; a browser\'s token, a query or a wrong secret do not', async () => {
  const port = await door()
  const m = machine()
  createSession('tunnel-door-room', 'Tunnel', null)
  const roomToken = signToken({ sessionId: 'tunnel-door-room', participantId: 'p_tunnel', role: 'participant' })
  const unauthorized = callCounts.unauthorized
  refused(await knock(port, TUNNEL, { [TUNNEL_PROTOCOL_HEADER]: '1' }), 401, 'unauthorized')
  refused(await knock(port, TUNNEL, { authorization: `Bearer ${roomToken}`, [TUNNEL_PROTOCOL_HEADER]: '1' }), 401, 'unauthorized')
  refused(await knock(port, `${TUNNEL}?token=${m.credential}`, { [TUNNEL_PROTOCOL_HEADER]: '1' }), 401, 'unauthorized')
  refused(await knock(port, TUNNEL, machineHeaders({ id: m.id, credential: remoteCredential(m.id, 'f'.repeat(64)) })), 401, 'unauthorized')
  assert.equal(callCounts.unauthorized - unauthorized, 4, 'counted with the machines\' other doors (colloq_runner_unauthorized_total)')
  const opened = await knock(port, TUNNEL, machineHeaders(m))
  assert.equal(opened.status, 101)
  assert.equal(opened.headers[REMOTE_MARKER_HEADER.toLowerCase()], REMOTE_MARKER, 'the 101 is home\'s, as its refusals are')
  opened.ws!.terminate()
})

test('the browsers\' Origin rule is not the tunnel\'s, and only the tunnel\'s path gets past it', async () => {
  const port = await door()
  const m = machine()
  createSession('tunnel-origin-room', 'Origin', null)
  upsertParticipant({ id: 'p_origin', sessionId: 'tunnel-origin-room', name: 'Студент', avatar: null, role: 'participant' })
  const token = signToken({ sessionId: 'tunnel-origin-room', participantId: 'p_origin', role: 'participant' })
  const evil = { origin: 'https://evil.example' }
  // The machine's door is reached with a foreign Origin: refused for the credential, then opened with it.
  refused(await knock(port, TUNNEL, { ...evil, [TUNNEL_PROTOCOL_HEADER]: '1' }), 401, 'unauthorized')
  const opened = await knock(port, TUNNEL, machineHeaders(m, evil))
  assert.equal(opened.status, 101)
  opened.ws!.terminate()
  // A browser's door with the same Origin is refused before its token is read.
  const collab = await knock(port, `/collab/tunnel-origin-room?token=${token}`, evil)
  assert.equal(collab.status, 403)
  assert.equal((JSON.parse(collab.body) as { reason: string }).reason, 'forbidden')
  assert.equal(collab.headers[REMOTE_MARKER_HEADER.toLowerCase()], undefined, 'the browsers\' doors are not the machines\'')
  // And a browser's door still refuses a machine's credential riding next to a valid room token.
  const control = await knock(port, `/control/tunnel-origin-room?token=${token}`, { authorization: `Bearer ${m.credential}` })
  assert.equal(control.status, 401)
})

test('the door refuses before the upgrade: 403 without classes, 426 for another protocol, 401 once revoked; a class quarantine and another build are not its to refuse', async () => {
  const port = await door()
  refused(await knock(port, TUNNEL, machineHeaders(machine({ classes: false }))), 403, 'forbidden')
  // Both hold back new placements only (§6.3, §11.6): the placements a machine holds are reached through this door, at every reconnect.
  const quarantined = machine()
  updateRunner(quarantined.id, { classesQuarantinedAt: Date.now() })
  const kept = await knock(port, TUNNEL, machineHeaders(quarantined))
  assert.equal(kept.status, 101, 'a quarantined machine keeps the tunnel of the classes it holds')
  kept.ws!.terminate()
  const m = machine()
  useHomeRunnerBuild('c'.repeat(64))
  try {
    const outdated = await knock(port, TUNNEL, machineHeaders(m))
    assert.equal(outdated.status, 101, 'an outdated machine keeps the tunnel of the classes it holds')
    outdated.ws!.terminate()
  } finally {
    useHomeRunnerBuild(null)
  }
  refused(await knock(port, TUNNEL, { authorization: `Bearer ${m.credential}` }), 426, 'protocol')
  refused(await knock(port, TUNNEL, machineHeaders(m, { [TUNNEL_PROTOCOL_HEADER]: '2' })), 426, 'protocol')
  refused(await knock(port, '/api/runners/v2/tunnel', machineHeaders(m)), 426, 'protocol')
  updateRunner(m.id, { state: 'revoked' })
  refused(await knock(port, TUNNEL, machineHeaders(m)), 401, 'unauthorized')
})

test('at most twelve upgrades a minute per machine and address, then 429 with Retry-After: another holder of the secret cannot spend the machine\'s own', async () => {
  const port = await door()
  const m = machine()
  const thief = { 'x-forwarded-for': '198.51.100.66' }
  for (let i = 0; i < TUNNEL_UPGRADES.count; i++) {
    const opened = await knock(port, TUNNEL, machineHeaders(m, thief))
    assert.equal(opened.status, 101, `upgrade ${i + 1}`)
    opened.ws!.terminate()
  }
  const thirteenth = await knock(port, TUNNEL, machineHeaders(m, thief))
  refused(thirteenth, 429, 'too_often')
  assert.ok(Number(thirteenth.headers['retry-after']) >= 1)
  const own = await knock(port, TUNNEL, machineHeaders(m, { 'x-forwarded-for': '203.0.113.1' }))
  assert.equal(own.status, 101, 'the machine from its own address takes its tunnel back, and the takeovers are counted')
  own.ws!.terminate()
  const other = await knock(port, TUNNEL, machineHeaders(machine(), thief))
  assert.equal(other.status, 101, 'another machine behind the same address has its own')
  other.ws!.terminate()
})

test('a newer tunnel replaces the older with 4409, and the machine\'s log names both addresses', async () => {
  const port = await door()
  const m = machine()
  const first = await rawAgent(port, m, { 'x-forwarded-for': '203.0.113.10' })
  first.ws.send(helloFrame())
  await until(() => first.frames.some((frame) => frame.kind === 'WELCOME'), 'the first WELCOME')
  assert.ok(machineTunnels().isUp(m.id))
  assert.ok((heardAt(m.id) ?? 0) > 0, 'a frame is the machine heard')
  const second = await rawAgent(port, m, { 'x-forwarded-for': '203.0.113.20' })
  second.ws.send(helloFrame())
  assert.equal((await first.closed).code, TUNNEL_CLOSE.replaced)
  await until(() => second.frames.some((frame) => frame.kind === 'WELCOME'), 'the second WELCOME')
  assert.ok(machineTunnels().isUp(m.id), 'still up: the newer tunnel took its place')
  const line = runnerEvents(m.id).find((event) => (event.kind as string) === 'tunnel_replaced')
  assert.ok(line, 'tunnel_replaced is written')
  assert.equal(line.address, '203.0.113.20')
  assert.equal(line.detail, '203.0.113.10')
  second.ws.terminate()
  await until(() => !machineTunnels().isUp(m.id), 'down once the tunnel is gone')
})

test('more than three takeovers from other addresses within ten minutes raise the alert, read from the log; a machine replacing itself does not, and writes a few lines of it', async () => {
  const clock = new Clock()
  clock.t = Date.now()
  const tunnels = new MachineTunnels({ clock, log: quiet })
  const port = await tunnelsServer(tunnels)
  const greet = async (m: Machine, address: string) => {
    const agent = await rawAgent(port, m, { 'x-forwarded-for': address })
    agent.ws.send(helloFrame())
    await until(() => agent.frames.some((frame) => frame.kind === 'WELCOME'), `WELCOME to ${address}`)
    return agent
  }
  const replaced = (m: Machine) => runnerEvents(m.id).filter((event) => (event.kind as string) === 'tunnel_replaced')
  const fought = machine()
  for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.1', '198.51.100.2']) await greet(fought, address)
  assert.equal(tunnels.tunnelReplacementAlert(fought.id), false, 'three takeovers are not yet more than three')
  const last = await greet(fought, '198.51.100.1')
  assert.equal(tunnels.tunnelReplacementAlert(fought.id), true)
  const restarted = new MachineTunnels({ clock, log: quiet })
  assert.equal(restarted.tunnelReplacementAlert(fought.id), true, 'a restarted home reads the takeovers from the log')
  restarted.shutdown()
  assert.equal(tunnelReplacementAlert(fought.id), true, 'and so do the process\'s own tunnels')
  clock.advance(10 * 60_000)
  assert.equal(tunnels.tunnelReplacementAlert(fought.id), false, 'ten minutes later the window holds none of them')
  last.ws.terminate()
  const alone = machine()
  const replacements = TUNNEL_SELF_REPLACEMENTS_LOGGED.count + 2
  for (let i = 0; i <= replacements; i++) await greet(alone, '198.51.100.9')
  assert.equal(tunnels.tunnelReplacementAlert(alone.id), false)
  assert.equal(replaced(alone).length, TUNNEL_SELF_REPLACEMENTS_LOGGED.count, `${replacements} replacements from its own address, ${TUNNEL_SELF_REPLACEMENTS_LOGGED.count} lines`)
  assert.equal(replaced(fought).length, 4, 'every takeover from another address is written')
})

test('the process\'s tunnels may be a test\'s own, on its clock: the upgrade handler opens its door', async () => {
  const port = await door()
  const clock = new Clock()
  clock.t = Date.now()
  const own = new MachineTunnels({ clock, log: quiet })
  useMachineTunnels(own)
  try {
    assert.equal(machineTunnels(), own)
    const m = machine()
    const agent = await rawAgent(port, m)
    agent.ws.send(helloFrame())
    await until(() => own.isUp(m.id), 'up in the test\'s own tunnels')
    clock.advance(TUNNEL_DEAD_MS)
    assert.equal((await agent.closed).code, 1006, 'its liveness runs on the test\'s clock: silent 25 s, terminated')
  } finally {
    useMachineTunnels(null)
    own.shutdown()
  }
  assert.notEqual(machineTunnels(), own)
})

test('TCP_NODELAY on the tunnel\'s socket at both ends', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const m = machine()
  const calls: Array<{ local: number | undefined; remote: number | undefined; enable: boolean | undefined }> = []
  const original = net.Socket.prototype.setNoDelay
  net.Socket.prototype.setNoDelay = function setNoDelay(this: net.Socket, enable?: boolean) {
    calls.push({ local: this.localPort, remote: this.remotePort, enable })
    return original.call(this, enable)
  }
  const agent = new AgentTunnel({ url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev', resolve: () => ({ refused: 'gone' }), log: quiet })
  open.add(agent)
  try {
    agent.want('open')
    await until(() => tunnels.isUp(m.id), 'the tunnel up')
  } finally {
    net.Socket.prototype.setNoDelay = original
  }
  assert.ok(calls.some((call) => call.local === port && call.enable === true), 'home\'s side of the tunnel')
  assert.ok(calls.some((call) => call.remote === port && call.enable === true), 'the agent\'s side of the tunnel')
  await agent.close()
})

test('a frame of the agent\'s that only home may send closes the tunnel with 4400', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const m = machine()
  const agent = await rawAgent(port, m)
  agent.ws.send(helloFrame())
  await until(() => agent.frames.some((frame) => frame.kind === 'WELCOME'), 'WELCOME')
  agent.ws.send(encodeTunnelFrame({ kind: 'OPEN', stream: 1, lane: 1, open: { key: ROOM, gen: 1 } }))
  assert.equal((await agent.closed).code, TUNNEL_CLOSE.violation)
  await until(() => !tunnels.isUp(m.id), 'down after the violation')
})

test('the door reads a socket\'s first frame itself: another protocol\'s HELLO closes it with 4426, a text message or another frame with 4400', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const m = machine()
  const firsts: Array<[string, Uint8Array | string, number]> = [
    ['a HELLO of protocol 2', otherProtocolHello(), TUNNEL_CLOSE.protocol],
    ['a text message', 'hello', TUNNEL_CLOSE.violation],
    ['a PING before the HELLO', encodeTunnelFrame({ kind: 'PING', id: 1 }), TUNNEL_CLOSE.violation],
  ]
  for (const [what, first, code] of firsts) {
    const agent = await rawAgent(port, m)
    agent.ws.send(first)
    assert.equal(await closedCode(agent, `${what} refused`), code, what)
    assert.equal(agent.frames.length, 0, `${what}: no WELCOME`)
  }
  assert.equal(tunnels.isUp(m.id), false, 'no tunnel came up')
})

test('the HELLO reads the machine again: revoked since its upgrade 4401, classes off 4403, a quarantine or another build WELCOMEd; close() ends a tunnel still greeting', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const revoked = machine()
  const a = await rawAgent(port, revoked)
  updateRunner(revoked.id, { state: 'revoked' })
  a.ws.send(helloFrame())
  assert.equal(await closedCode(a, 'the revoked machine\'s HELLO refused'), TUNNEL_CLOSE.unauthorized)
  const unclassed = machine()
  const b = await rawAgent(port, unclassed)
  assert.ok('runner' in setRunnerClasses(unclassed.id, false))
  b.ws.send(helloFrame())
  assert.equal(await closedCode(b, 'the unclassed machine\'s HELLO refused'), TUNNEL_CLOSE.forbidden)
  const kept = machine()
  const c = await rawAgent(port, kept)
  updateRunner(kept.id, { classesQuarantinedAt: Date.now() })
  c.ws.send(helloFrame('c'.repeat(64)))
  await until(() => c.frames.some((frame) => frame.kind === 'WELCOME'), 'WELCOME to a quarantined machine of another build')
  assert.ok(tunnels.isUp(kept.id))
  c.ws.terminate()
  const greeting = machine()
  const d = await rawAgent(port, greeting)
  tunnels.close(greeting.id, TUNNEL_CLOSE.forbidden, 'Classes turned off')
  assert.equal(await closedCode(d, 'the greeting tunnel closed'), TUNNEL_CLOSE.forbidden)
})

test('a socket that never says HELLO is terminated after TUNNEL_GREETING_MS, and takes no tunnel\'s place', async () => {
  const clock = new Clock()
  clock.t = Date.now()
  const tunnels = new MachineTunnels({ clock, log: quiet })
  const port = await tunnelsServer(tunnels)
  const m = machine()
  const working = await rawAgent(port, m)
  working.ws.send(helloFrame())
  await until(() => working.frames.some((frame) => frame.kind === 'WELCOME'), 'WELCOME')
  // The door reads the HELLO before the socket goes to the machine's end: one that never says it is not the machine's tunnel.
  const silent = await rawAgent(port, m)
  let closed: number | null = null
  void silent.closed.then((close) => (closed = close.code))
  clock.advance(TUNNEL_GREETING_MS - 1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(closed, null, 'not before its time')
  clock.advance(1)
  assert.equal(await closedCode(silent, 'the silent socket terminated'), 1006)
  assert.ok(tunnels.isUp(m.id) && working.ws.readyState === WebSocket.OPEN, 'the working tunnel is untouched')
  working.ws.terminate()
})

/** A TCP relay in front of a door whose agent-to-home direction can be held back, then let go of: frames that arrive late, in order. */
async function lateRelay(port: number): Promise<{ port: number; hold(): void; release(): void }> {
  const pairs: Array<{ down: net.Socket; up: net.Socket }> = []
  let held = false
  const waiting: Buffer[] = []
  const server = net.createServer((down) => {
    const up = net.connect(port, '127.0.0.1')
    const pair = { down, up }
    pairs.push(pair)
    for (const socket of [down, up]) socket.on('error', () => undefined)
    down.on('data', (chunk: Buffer) => (held ? waiting.push(chunk) : up.write(chunk)))
    up.pipe(down)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.add({ close: () => new Promise<void>((resolve) => {
    for (const { down, up } of pairs) {
      down.destroy()
      up.destroy()
    }
    server.close(() => resolve())
  }) })
  return {
    port: (server.address() as net.AddressInfo).port,
    hold: () => (held = true),
    release: () => {
      held = false
      for (const chunk of waiting.splice(0)) pairs[0].up.write(chunk)
    },
  }
}

test('the frames a replaced socket still sends are lost as in a cut, never taken for the newer socket\'s', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const relay = await lateRelay(port)
  const m = machine()
  const older = await rawAgent(relay.port, m)
  older.ws.send(helloFrame())
  await until(() => older.frames.some((frame) => frame.kind === 'WELCOME'), 'the older WELCOME')
  // The older socket's next frame is on its way, and late: a newer tunnel takes its place meanwhile.
  relay.hold()
  older.ws.send(encodeTunnelFrame({ kind: 'PING', id: 777 }))
  const newer = await rawAgent(port, m)
  newer.ws.send(helloFrame())
  await until(() => newer.frames.some((frame) => frame.kind === 'WELCOME'), 'the newer WELCOME')
  relay.release()
  newer.ws.send(encodeTunnelFrame({ kind: 'PING', id: 778 }))
  await until(() => newer.frames.some((frame) => frame.kind === 'PONG' && frame.id === 778), 'the newer socket\'s own PONG')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(newer.frames.filter((frame) => frame.kind === 'PONG').map((frame) => (frame as { id: number }).id), [778], 'no answer to the older socket\'s frame')
  newer.ws.terminate()
})

test('an open tunnel whose machine was revoked or unclassed without a word closes at its first frame ten seconds on; a quarantine leaves it open', async () => {
  const clock = new Clock()
  clock.t = Date.now()
  const tunnels = new MachineTunnels({ clock, log: quiet })
  const port = await tunnelsServer(tunnels)
  const up = async (m: Machine) => {
    const agent = await rawAgent(port, m)
    agent.ws.send(helloFrame())
    await until(() => agent.frames.some((frame) => frame.kind === 'WELCOME'), 'WELCOME')
    return agent
  }
  const revoked = machine()
  const unclassed = machine()
  const quarantined = machine()
  const a = await up(revoked)
  const b = await up(unclassed)
  const c = await up(quarantined)
  // A stream on the revoked machine's tunnel, open at home: the raw agent answers its OPEN and sends it a byte or two.
  const listener = await tunnels.listen(revoked.id, ROOM, 1)
  open.add(listener)
  const kernel = net.connect({ host: '127.0.0.1', port: listener.port })
  const seen = { got: 0, error: null as string | null, closed: false }
  kernel.on('data', (chunk: Buffer) => (seen.got += chunk.byteLength))
  kernel.on('error', (error: NodeJS.ErrnoException) => (seen.error ??= error.code ?? error.message))
  kernel.on('close', () => (seen.closed = true))
  open.add({ close: () => kernel.destroy() })
  await until(() => a.frames.some((frame) => frame.kind === 'OPEN'), 'the OPEN of the stream')
  const opening = a.frames.find((frame) => frame.kind === 'OPEN') as Extract<TunnelFrame, { kind: 'OPEN' }>
  a.ws.send(encodeTunnelFrame({ kind: 'OPENED', stream: opening.stream, lane: opening.lane }))
  a.ws.send(encodeTunnelFrame({ kind: 'DATA', stream: opening.stream, lane: opening.lane, offset: 0, payload: filled(10), fin: false }))
  await until(() => seen.got === 10, 'the stream open at home')
  updateRunner(revoked.id, { state: 'revoked' })
  assert.ok('runner' in setRunnerClasses(unclassed.id, false))
  updateRunner(quarantined.id, { classesQuarantinedAt: Date.now() })
  clock.advance(TUNNEL_PING_MS)
  for (const agent of [a, b, c]) agent.ws.send(encodeTunnelFrame({ kind: 'PING', id: 1 }))
  assert.equal(await closedCode(a, 'the revoked machine\'s tunnel closed'), TUNNEL_CLOSE.unauthorized)
  // Its streams go with it, not kept for a resume: a machine no longer allowed is not waited for.
  await until(() => seen.closed, 'the revoked machine\'s stream dropped at home')
  assert.equal(seen.error, 'ECONNRESET')
  assert.equal(await closedCode(b, 'the unclassed machine\'s tunnel closed'), TUNNEL_CLOSE.forbidden)
  await until(() => c.frames.some((frame) => frame.kind === 'PONG'), 'the quarantined machine\'s PONG')
  assert.ok(tunnels.isUp(quarantined.id), 'a quarantine holds back new placements only')
  assert.ok(!tunnels.isUp(revoked.id) && !tunnels.isUp(unclassed.id))
  c.ws.terminate()
})

/* ----------------------------------------------- listeners, links, the pipe */

/** A TCP echo on 127.0.0.1: what comes in goes back, and its end too. */
async function echo(): Promise<{ port: number; connections: () => number }> {
  let count = 0
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    count++
    socket.on('error', () => undefined)
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.add({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
  return { port: (server.address() as net.AddressInfo).port, connections: () => count }
}

/** Bytes through a connection to `port`: written whole, half-closed, and what came back until its end. */
function roundTrip(port: number, payload: Buffer): Promise<{ back: Buffer; error: string | null }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true })
    const chunks: Buffer[] = []
    let error: string | null = null
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', (failure: NodeJS.ErrnoException) => (error = failure.code ?? failure.message))
    socket.on('close', () => resolve({ back: Buffer.concat(chunks), error }))
    socket.on('connect', () => {
      socket.write(payload)
      socket.end()
    })
  })
}

/** A seeded generator of the payloads: the same bytes on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

test('one listener per placement, and a fast ECONNRESET there while its machine\'s tunnel is down', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const m = machine()
  const a = await tunnels.listen(m.id, ROOM, 1)
  const again = await tunnels.listen(m.id, ROOM, 1)
  const next = await tunnels.listen(m.id, ROOM, 2)
  open.add(a)
  open.add(next)
  assert.equal(again.port, a.port, 'the same placement, the same listener')
  assert.notEqual(next.port, a.port, 'another gen is another placement')
  await assert.rejects(tunnels.listen(m.id, 'not a key', 1))
  const down = await roundTrip(a.port, Buffer.from('GET /api/status HTTP/1.1\r\n\r\n'))
  assert.equal(down.error, 'ECONNRESET')
  assert.equal(down.back.length, 0)
  a.close()
  next.close()
})

test('bytes both ways through a real tunnel: many streams at once on both lanes, each exactly what it sent', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const target = await echo()
  const m = machine()
  const changes: Array<[string, boolean]> = []
  tunnels.onChange((runnerId, up) => {
    if (runnerId === m.id) changes.push([runnerId, up])
  })
  const resolved: Array<[string, number]> = []
  const agent = new AgentTunnel({
    url: tunnelUrl(`http://127.0.0.1:${port}`),
    authorization: m.credential,
    build: 'dev',
    resolve: (key, gen) => {
      resolved.push([key, gen])
      return gen === 1 ? { port: target.port } : { refused: 'stale' }
    },
    paceMBps: () => 1000,
    log: quiet,
  })
  open.add(agent)
  const link = tunnels.link(m.id, ROOM, 1)
  assert.equal(link.up, false)
  const came = link.next(30_000)
  agent.want('open')
  assert.equal(await came, 'up')
  assert.equal(link.up, true)
  await until(() => agent.state().up, 'the agent\'s word on it')
  const room = await tunnels.listen(m.id, ROOM, 1)
  const council = await tunnels.listen(m.id, COUNCIL, 1)
  open.add(room)
  open.add(council)
  const random = seeded(42)
  const sizes = Array.from({ length: 40 }, (_, i) => (i % 8 === 0 ? 1 + Math.floor(random() * 2 * MiB) : 1 + Math.floor(random() * 64 * KiB)))
  const payloads = sizes.map((size) => randomBytes(size))
  const trips = await Promise.all(payloads.map((payload, i) => roundTrip(i % 3 === 0 ? council.port : room.port, payload)))
  for (const [i, trip] of trips.entries()) {
    assert.equal(trip.error, null, `stream ${i}: ${trip.error}`)
    assert.equal(createHash('sha256').update(trip.back).digest('hex'), createHash('sha256').update(payloads[i]).digest('hex'), `stream ${i} of ${sizes[i]} B`)
  }
  assert.equal(target.connections(), payloads.length, 'one connection to the placement\'s port per stream')
  assert.ok(resolved.every(([key, gen]) => (key === ROOM || key === COUNCIL) && gen === 1))

  // OPEN only for the current gen: the agent's record holds gen 1, so a listener of gen 2 is refused `stale` and reset.
  const stale = await tunnels.listen(m.id, ROOM, 2)
  open.add(stale)
  const refusedTrip = await roundTrip(stale.port, Buffer.from('x'))
  assert.equal(refusedTrip.error, 'ECONNRESET')
  assert.equal(target.connections(), payloads.length, 'a stale gen reaches no Jupyter')

  // Home declared the placement lost: its link says so for good, and its listener takes nothing more.
  tunnels.lost(m.id, ROOM, 1)
  assert.equal(link.up, false)
  assert.equal(await link.next(10), 'lost')
  assert.equal((await roundTrip(room.port, Buffer.from('y'))).error, 'ECONNRESET')

  await agent.close()
  await until(() => !tunnels.isUp(m.id), 'down once the agent hung up')
  assert.equal(agent.state().up, false)
  assert.deepEqual(changes, [[m.id, true], [m.id, false]])
  assert.equal(await tunnels.link(m.id, COUNCIL, 1).next(10), 'timeout', 'a link of a machine that is down waits, then times out')
})

test('no generic forwarding: whatever an OPEN carries, the agent connects to 127.0.0.1 on its own record\'s port alone', async () => {
  const target = await echo()
  const elsewhere = await echo()
  // A home of the test's own, which says what it likes in its OPENs.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: false })
  wss.on('headers', (headers) => headers.push(`${REMOTE_MARKER_HEADER}: ${REMOTE_MARKER}`))
  open.add({ close: () => new Promise<void>((resolve) => {
    for (const client of wss.clients) client.terminate()
    wss.close(() => resolve())
  }) })
  await once(wss, 'listening')
  const homePort = (wss.address() as net.AddressInfo).port
  const fromAgent: TunnelFrame[] = []
  let opens: (() => void) | null = null
  wss.on('connection', (ws) => {
    ws.on('message', (data: Buffer) => {
      const frame = decodeTunnelFrame(data, 'agent')
      fromAgent.push(frame)
      if (frame.kind !== 'HELLO') return
      ws.send(encodeTunnelFrame({ kind: 'WELCOME', welcome: { protocol: 1, build: 'dev', session: 'c'.repeat(32) } }))
      // An OPEN that names a host, a port and a URL of its own, as no home of ours writes one.
      const json = new TextEncoder().encode(JSON.stringify({ key: ROOM, gen: 1, host: '127.0.0.1', port: elsewhere.port, url: `http://127.0.0.1:${elsewhere.port}` }))
      const forged = new Uint8Array(TUNNEL_HEADER_BYTES + json.byteLength)
      forged[0] = tunnelKindByte('OPEN')
      forged[2] = 1
      new DataView(forged.buffer).setUint32(4, 1)
      forged.set(json, TUNNEL_HEADER_BYTES)
      opens = () => {
        ws.send(forged)
        ws.send(encodeTunnelFrame({ kind: 'OPEN', stream: 2, lane: 1, open: { key: 'other_room:room', gen: 1 } }))
      }
    })
  })
  const resolved: Array<[string, number]> = []
  const agent = new AgentTunnel({
    url: `ws://127.0.0.1:${homePort}/api/runners/v1/tunnel`,
    authorization: 'cr1.abcdefgh.' + 'a'.repeat(64),
    build: 'dev',
    resolve: (key, gen) => {
      resolved.push([key, gen])
      return key === ROOM ? { port: target.port } : { refused: 'gone' }
    },
    log: quiet,
  })
  open.add(agent)
  agent.want('open')
  await until(() => agent.state().up && opens !== null, 'greeted')
  // Every TCP connection the process makes from here on is written down: the streams' alone.
  const connects: Array<{ host: unknown; port: unknown }> = []
  const original = net.connect
  ;(net as { connect: typeof net.connect }).connect = ((...args: Parameters<typeof net.connect>) => {
    const options = (typeof args[0] === 'object' ? args[0] : {}) as { host?: string; port?: number }
    connects.push({ host: options.host, port: options.port })
    return original(...args)
  }) as typeof net.connect
  try {
    opens!()
    await until(() => fromAgent.some((frame) => frame.kind === 'OPENED') && fromAgent.some((frame) => frame.kind === 'REFUSED'), 'the answers to both OPENs')
  } finally {
    ;(net as { connect: typeof net.connect }).connect = original
  }
  assert.deepEqual(resolved, [[ROOM, 1], ['other_room:room', 1]], 'the record is asked by key and gen, nothing else')
  assert.deepEqual(connects, [{ host: '127.0.0.1', port: target.port }])
  assert.equal(elsewhere.connections(), 0)
  const refusedFrame = fromAgent.find((frame) => frame.kind === 'REFUSED') as Extract<TunnelFrame, { kind: 'REFUSED' }>
  assert.equal(refusedFrame.refused.code, 'gone')
  await agent.close()
})

test('the agent honours HTTPS_PROXY and HTTP_PROXY with a CONNECT, and dials a local address directly', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const connects: string[] = []
  const proxy = http.createServer((_req, res) => {
    res.statusCode = 405
    res.end()
  })
  proxy.on('connect', (req: IncomingMessage, client: net.Socket, head: Buffer) => {
    connects.push(req.url ?? '')
    // The proxy resolves the test's name of home to this machine.
    const upstream = net.connect(Number((req.url ?? '').split(':').pop()), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  open.add({ close: () => new Promise<void>((resolve) => {
    proxy.closeAllConnections()
    proxy.close(() => resolve())
  }) })
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
  const m = machine()
  const proxied = new AgentTunnel({
    url: `ws://home.colloq.test:${port}/api/runners/v1/tunnel`, authorization: `Bearer ${m.credential}`, build: 'dev',
    resolve: () => ({ refused: 'gone' }), log: quiet, env: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl },
  })
  open.add(proxied)
  proxied.want('open')
  await until(() => tunnels.isUp(m.id), 'up through the proxy')
  assert.deepEqual(connects, [`home.colloq.test:${port}`])
  await proxied.close()
  await until(() => !tunnels.isUp(m.id), 'down')
  const direct = new AgentTunnel({
    url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev',
    resolve: () => ({ refused: 'gone' }), log: quiet, env: { HTTP_PROXY: proxyUrl },
  })
  open.add(direct)
  direct.want('open')
  await until(() => tunnels.isUp(m.id), 'up directly')
  assert.equal(connects.length, 1, 'a loopback home is never sent through the proxy')
  await direct.close()
})

test('reconnect: a tunnel home does not see after ten seconds up is dialled again, its streams going on; one younger than that is kept', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const target = await echo()
  const m = machine()
  const clock = new Clock()
  clock.t = Date.now()
  const events: string[] = []
  const agent = new AgentTunnel({
    url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev',
    resolve: () => ({ port: target.port }), log: (event) => events.push(event), clock,
  })
  open.add(agent)
  agent.want('open')
  await until(() => agent.state().up && tunnels.isUp(m.id), 'up')
  // A stream open across the word: a dial again is a cut, and its connections outlive it (§4.8).
  const listener = await tunnels.listen(m.id, ROOM, 1)
  open.add(listener)
  const kernel = net.connect({ host: '127.0.0.1', port: listener.port })
  const seen = { got: 0, closed: false }
  kernel.on('data', (chunk: Buffer) => (seen.got += chunk.byteLength))
  kernel.on('error', () => undefined)
  kernel.on('close', () => (seen.closed = true))
  open.add({ close: () => kernel.destroy() })
  kernel.write(filled(10 * KiB))
  await until(() => seen.got === 10 * KiB, 'echoed before the word')
  const since = agent.state().since
  agent.want('reconnect')
  assert.equal(agent.state().up, true, 'a tunnel up for less than ten seconds may be newer than home\'s word')
  clock.t += TUNNEL_PING_MS
  agent.want('reconnect')
  await until(() => !agent.state().up, 'the stale tunnel ended')
  assert.ok(events.includes('tunnel-stale'))
  clock.advance(5_000)
  await until(() => agent.state().up && tunnels.isUp(m.id), 'dialled again')
  assert.ok(agent.state().since > since)
  kernel.write(filled(10 * KiB))
  await until(() => seen.got === 20 * KiB, 'echoed after it')
  assert.ok(!seen.closed && target.connections() === 1, 'over the same connections, never reset')
  agent.want('closed')
  await until(() => !tunnels.isUp(m.id), 'closed when home holds nothing here')
  clock.advance(60_000)
  assert.equal(agent.state().up, false, 'and not dialled again')
  await agent.close()
})

test('a dial hung up while its WebSocket was being made goes at once, and quietly', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const m = machine()
  const agent = new AgentTunnel({ url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev', resolve: () => ({ refused: 'gone' }), log: quiet })
  open.add(agent)
  agent.want('open')
  agent.want('closed')
  // ws says an aborted handshake as an error on the next tick: unheard, it would end the process.
  for (let turns = 0; turns < 20; turns++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(agent.state().up, false)
  assert.equal(tunnels.isUp(m.id), false)
})

test('the agent\'s own failure is tried again quickly; home\'s word slowly', async () => {
  const tunnels = new MachineTunnels({ log: quiet })
  const port = await tunnelsServer(tunnels)
  const m = machine()
  const clock = new Clock()
  clock.t = Date.now()
  let throwing = true
  let threw = 0
  const agent = new AgentTunnel({
    url: tunnelUrl(`http://127.0.0.1:${port}`), authorization: m.credential, build: 'dev', resolve: () => ({ refused: 'gone' }), clock, random: () => 0.5,
    // A log that fails as the tunnel comes up: the agent's end closes it with its own code (TUNNEL_CLOSE.internal).
    log: (event) => {
      if (event !== 'tunnel-up' || !throwing) return
      threw++
      throw new Error('the log is full')
    },
  })
  open.add(agent)
  agent.want('open')
  // After the failure: before it, the one timer waiting may be the greeting's own (TUNNEL_GREETING_MS), not a retry.
  await until(() => threw === 1 && clock.waits().length === 1, 'the retry after the agent\'s own failure')
  assert.deepEqual(clock.waits(), [750], 'the first quick try (0.5 to 5 s), not the slow one')
  throwing = false
  clock.advance(750)
  await until(() => tunnels.isUp(m.id), 'up on the next try')
  // Home's word: classes off, the tunnel closed with 4403, and the next try waits as the slow backoff says.
  setRunnerClasses(m.id, false)
  tunnels.close(m.id, TUNNEL_CLOSE.forbidden, 'classes are off')
  await until(() => clock.waits().includes(1500), 'the retry after home\'s word')
  await agent.close()
})

/* ---------------------------------------------- the agent's backoff, on stubs */

/** A WebSocket that never reaches a network: each dial plays the next of `answers`. */
class FakeWs extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  bufferedAmount = 0

  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    queueMicrotask(() => this.emit('close', 1006, Buffer.alloc(0)))
  }

  close(): void {
    this.terminate()
  }

  send(): void {}
}

/** A reply of the door's that is no upgrade: its status, its headers, its body. */
function reply(status: number, headers: Record<string, string>, body = ''): IncomingMessage {
  const response = Readable.from(body ? [body] : []) as unknown as IncomingMessage
  Object.assign(response, { statusCode: status, headers })
  return response
}

const marked = { [REMOTE_MARKER_HEADER.toLowerCase()]: REMOTE_MARKER }

/** An agent whose every dial gets `answer`, on a clock of the test's; the waits it chose, and the relay's questions. */
function dialling(answer: (dial: number) => IncomingMessage) {
  const clock = new Clock()
  const dials: FakeWs[] = []
  const events: Array<[string, Record<string, unknown> | undefined]> = []
  let relayAsked = 0
  const dial: TunnelDial = () => {
    const ws = new FakeWs()
    dials.push(ws)
    const response = answer(dials.length)
    // After the dial's own promise has handed the socket over: the agent listens from then on.
    setImmediate(() => ws.emit('unexpected-response', {}, response))
    return ws as unknown as WebSocket
  }
  const agent = new AgentTunnel({
    url: 'wss://home.colloq.test/api/runners/v1/tunnel', authorization: 'Bearer cr1.abcdefgh.' + 'a'.repeat(64), build: 'dev',
    resolve: () => ({ refused: 'gone' }), log: (event, detail) => events.push([event, detail]), clock, dial, random: () => 0.5,
    relayState: async () => {
      relayAsked++
      return 'home_offline'
    },
  })
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  /** Let the last dial answer and close, then take the one wait it chose, and run it out. */
  const next = async (): Promise<number> => {
    for (let turns = 0; turns < 200 && !(dials.at(-1)?.readyState === WebSocket.CLOSED && clock.waits().length === 1); turns++) await settle()
    const waits = clock.waits()
    assert.equal(waits.length, 1, `one retry waits: ${waits.join(', ')}`)
    clock.advance(waits[0])
    return waits[0]
  }
  return { agent, clock, dials, events, next, settle, relayAsked: () => relayAsked }
}

test('backoff: five quick tries of 0.5 to 5 s, then the 0.23 backoff of 1 to 30 s, with the relay asked every fifth failure', async () => {
  const run = dialling(() => reply(502, {}, 'Bad Gateway'))
  run.agent.want('open')
  const waits: number[] = []
  for (let i = 0; i < 12; i++) waits.push(await run.next())
  assert.ok(waits.slice(0, 5).every((ms) => ms >= 500 && ms <= 5_000), `quick: ${waits.slice(0, 5).join(', ')}`)
  assert.ok(waits.slice(5).every((ms) => ms >= 1_000 && ms <= 30_000), `slow: ${waits.slice(5).join(', ')}`)
  assert.ok(waits[4] >= waits[3] && waits[3] >= waits[0], 'the quick ones grow')
  assert.ok(waits[11] > waits[6], 'the slow ones grow')
  assert.equal(run.dials.length, 13)
  assert.equal(run.relayAsked(), 3, 'at the first, the sixth and the eleventh failure in a row')
  await run.settle()
  assert.ok(run.events.some(([event, detail]) => event === 'tunnel-unreachable' && detail?.relay === 'home_offline'))
  run.agent.want('closed')
  for (let turns = 0; turns < 200 && run.clock.waits().length > 0; turns++) await run.settle()
  assert.deepEqual(run.clock.waits(), [], 'closed: no retry waits')
})

test('a marked refusal is home\'s word: tried again slowly from the first, said once, and the relay is not asked', async () => {
  const run = dialling(() => reply(403, { ...marked, 'content-type': 'application/json' }, JSON.stringify({ error: 'forbidden', detail: 'classes are off' })))
  run.agent.want('open')
  const first = await run.next()
  const second = await run.next()
  assert.ok(first >= 1_000 && second >= first, `slow from the first: ${first}, ${second}`)
  assert.equal(run.relayAsked(), 0)
  const said = run.events.filter(([event]) => event === 'tunnel-refused')
  assert.equal(said.length, 1, 'the same refusal is said once')
  assert.equal(said[0][1]?.error, 'forbidden')
  assert.equal(said[0][1]?.status, 403)
  await run.agent.close()
})

test('a 429\'s Retry-After is the least wait; an unmarked 401 is the relay\'s page and only a hiccup', async () => {
  const limited = dialling(() => reply(429, { ...marked, 'retry-after': '20' }, JSON.stringify({ error: 'too_often' })))
  limited.agent.want('open')
  assert.ok((await limited.next()) >= 20_000)
  await limited.agent.close()
  const relayPage = dialling(() => reply(401, {}, '<html>401</html>'))
  relayPage.agent.want('open')
  assert.ok((await relayPage.next()) <= 5_000, 'quick: not home\'s refusal')
  assert.equal(relayPage.events.filter(([event]) => event === 'tunnel-refused').length, 0)
  await relayPage.agent.close()
})
