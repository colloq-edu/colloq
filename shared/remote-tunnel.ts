/**
 * The tunnel of classes on machines (docs/architecture/remote-classes.md §4):
 * the frames of the one WebSocket a machine dials to home, their codec, and
 * the numbers both ends must agree on.
 *
 * BYTES, NO VERBS. Home opens a TCP connection to a placement's loopback port
 * on the machine as a stream of this tunnel, and the tunnel carries that
 * connection's bytes both ways and nothing else (D1): placements, files and
 * epochs are the sync's business (shared/remote-kernels.ts). Only home opens
 * streams, and only to the placement an OPEN names by its key and gen; the
 * agent connects to the port it read itself, so home never names a host or a
 * port and nothing else on the machine is reachable.
 *
 * ONE FRAME, ONE BINARY MESSAGE, a header of sixteen bytes in network order
 * and then the payload:
 *
 *   u8  kind      TUNNEL_KINDS, from 1: a zeroed header is no frame
 *   u8  flags     bit 0 FIN, on DATA only; every other bit zero
 *   u8  lane      0 control (the tunnel's own frames), 1 interactive (room, own), 2 council
 *   u8  reserved  zero
 *   u32 stream    0 is the tunnel itself; streams are numbered from 1 by home
 *   u64 offset    DATA: where its payload starts in the stream; ACK: bytes delivered;
 *                 END: the stream's whole length; PING, PONG: the ping's id; else 0
 *   payload       DATA up to TUNNEL_FRAME_MAX bytes; JSON up to TUNNEL_JSON_MAX for
 *                 HELLO, WELCOME, OPEN and REFUSED; nothing for the rest
 *
 * A frame of a stream carries the stream's lane, the one its OPEN named, and
 * its ACK, END and RESET as well: how a sender orders its frames is its own
 * (§4.4), but the receiver can tell a stream's frames apart by nothing else.
 * And the lane an OPEN names is its placement's, by the role in its key
 * (tunnelLaneOf): a council stream on the interactive lane would put
 * attempts' bytes ahead of the room's keystrokes (D12), and the codec is the
 * one place both ends read every OPEN through.
 *
 * EACH SIDE KNOWS WHAT THE OTHER MAY SEND (TUNNEL_SENDERS). The agent says
 * HELLO and answers an OPEN with OPENED or REFUSED; home says WELCOME and
 * OPEN. A frame of a kind its sender may not send is a protocol violation
 * that closes the tunnel, an OPEN from the agent first among them: an agent
 * that could open streams into home would be a door home never meant.
 *
 * THE RULES OF THE CONTRACT IT EXTENDS (shared/remote-runner.ts). The JSON
 * payloads home reads from the agent (HELLO, REFUSED) are refused for an
 * unknown key; those the agent reads from home (WELCOME, OPEN) drop what it
 * does not know. A HELLO or a WELCOME of another TUNNEL_PROTOCOL is refused
 * with the code `protocol` before its keys are read, as a request of another
 * REMOTE_PROTOCOL is. Everything else wrong is `invalid`, and a payload over
 * its cap `too_large`. Every refusal is a RemoteProtocolError, and the
 * encoder refuses whatever the decoder would: a frame that cannot be read
 * never leaves its side.
 *
 * ONE END FOR BOTH SIDES (TunnelEnd, below): the greeting, the sender with
 * its lanes, windows and pace, the receiver with its ACKs, and the pings,
 * over a socket, a clock and local connections its owner hands in —
 * server/src/kernel/remote/tunnel.ts at home, server/src/runner-agent/tunnel.ts
 * on the machine. Two copies of the rules would drift apart on the one socket
 * every class of a machine shares.
 *
 * PURE, FOR BOTH ENDS. Uint8Array and DataView only, no node: module and
 * nothing done at import time: the agent's bundle carries it whole.
 */
import { REMOTE_API_BASE, REMOTE_BUILD, RemoteProtocolError, fields, integer, known, matching, refuse } from './remote-runner.js'
import { parseRemotePlacementKey, type RemoteKernelRole } from './remote-kernels.js'

/* ------------------------------------------------------------------ the door */

/**
 * The tunnel's version, apart from REMOTE_PROTOCOL: the frames can change
 * without the sync changing, and the other way round. The upgrade carries it
 * in TUNNEL_PROTOCOL_HEADER, and HELLO and WELCOME carry it again.
 */
export const TUNNEL_PROTOCOL = 1
export const TUNNEL_PROTOCOL_HEADER = 'X-Colloq-Tunnel-Protocol'

/** The upgrade's path under REMOTE_API_BASE: `GET tunnel` with `Authorization: Bearer cr1.…` (§4.2). */
export const TUNNEL_PATH = 'tunnel'

/**
 * Upgrades one machine may make from one address in a window: past them 429
 * (net/too-often.ts). Per address as well as per machine, so that a second
 * holder of a machine's secret cannot spend the machine's own tries and keep
 * it from taking its tunnel back, which is what the takeover alert counts.
 */
export const TUNNEL_UPGRADES = { count: 12, windowMs: 60_000 } as const

/**
 * The close codes of a tunnel, each side's, all of them application codes. A
 * dead link is terminated without one (TUNNEL_DEAD_MS): there is nobody to
 * read it.
 */
export const TUNNEL_CLOSE = {
  /** A frame this codec refuses, or one its sender may not send. */
  violation: 4400,
  /** The machine's credential was revoked. */
  unauthorized: 4401,
  /** The machine may no longer hold a tunnel: its classes were turned off. */
  forbidden: 4403,
  /** A newer tunnel of the same machine took this one's place (§4.2). */
  replaced: 4409,
  /** The peer's HELLO or WELCOME names another TUNNEL_PROTOCOL. */
  protocol: 4426,
} as const

/** An end's own failure, not the peer's: WebSocket's standard 1011, and a reconnect is the cure. */
export const TUNNEL_INTERNAL_CLOSE = 1011

/**
 * The door's refusals, before the upgrade (§4.2): a marked JSON reply
 * `{ error, detail? }` with this status, the way the 0.23 doors answer
 * (competitions/remote/routes.ts · refuse). `unauthorized`, `protocol` and
 * `too_often` mean what REMOTE_ERRORS says; `forbidden` is the tunnel's own:
 * a machine that may call home but holds no tunnel, its classes off.
 */
export const TUNNEL_REFUSALS = { unauthorized: 401, forbidden: 403, protocol: 426, too_often: 429 } as const
export type TunnelDoorRefusal = keyof typeof TUNNEL_REFUSALS

/**
 * The tunnel's address on a home: `wss://` for an `https://` home, `ws://`
 * for an `http://` one (make dev, the tests), under REMOTE_API_BASE.
 */
export function tunnelUrl(home: string): string {
  const url = new URL(home)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') refuse('A home address is http(s)')
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${REMOTE_API_BASE}/${TUNNEL_PATH}`
}

/* ---------------------------------------------------------------- numbers */

/** Each side pings this often: the relay cuts idle connections at 30 s (§4.7). */
export const TUNNEL_PING_MS = 10_000
/** A side that heard no frame for this long terminates the socket, with no close handshake on a dead link. */
export const TUNNEL_DEAD_MS = 25_000
/** A frame's header. */
export const TUNNEL_HEADER_BYTES = 16
/** A DATA frame's payload at most: one deficit round-robin turn, so a 6 MiB figure interleaves with another kernel's print (§4.4). */
export const TUNNEL_FRAME_MAX = 16 * 1024
/** A JSON payload at most (HELLO, WELCOME, OPEN, REFUSED). */
export const TUNNEL_JSON_MAX = 4 * 1024
/** The WebSocket's maxPayload at both ends: well over the largest frame (§4.2). */
export const TUNNEL_MESSAGE_MAX = 64 * 1024
/**
 * A sender may be this far past what its peer has ACKed: per stream by its
 * lane, and per machine in all (§4.4). Measured through relay2 (K0, 16 Oct
 * 2026): one stream moved 2.6 MiB/s with a window of 1 MiB, bound by the
 * window at an effective round trip of 0.4 s, and one 2 MB figure did not
 * fit in it. So an interactive stream holds 4 MiB, a figure in one window,
 * and a council stream 1 MiB; the machine's 16 MiB stay.
 */
export const TUNNEL_WINDOW = { interactive: 4 * 1024 * 1024, council: 1024 * 1024, machine: 16 * 1024 * 1024 } as const
/**
 * The council lane's share of the machine's window: all of it but one
 * interactive stream's, so that the room's lane can always send a whole
 * window however many attempts' streams are full (D12, strict lanes).
 */
export const TUNNEL_COUNCIL_SHARE = TUNNEL_WINDOW.machine - TUNNEL_WINDOW.interactive
/** A frame goes to the socket only while it buffers at most this; the rest waits in the streams' queues, where the lanes still apply. */
export const TUNNEL_SEND_LOWAT = 64 * 1024
/** A receiver ACKs this often, or after this many bytes, as its local socket drains. */
export const TUNNEL_ACK_MS = 50
export const TUNNEL_ACK_BYTES = 64 * 1024
/**
 * The bytes a stream's queue holds before its local connection is paused:
 * past them the bytes wait in the connection's own buffers, never in the
 * end's memory, whatever the window would still allow (§4.4).
 */
export const TUNNEL_QUEUE_BYTES = 64 * 1024
/** Streams one tunnel holds at once. */
export const TUNNEL_STREAMS_MAX = 512
/** The highest stream number: u32. Home numbers its streams upwards from 1, never back. */
export const TUNNEL_STREAM_MAX = 0xffff_ffff
/** The HELLO (at home) or the WELCOME (on the agent) comes within this, or the socket is terminated. */
export const TUNNEL_GREETING_MS = 10_000
/**
 * The frames an end may have waiting to go ahead of every stream's bytes:
 * its OPENs, ENDs, RESETs and ACKs (one per stream at most) and its PONGs.
 * Past it the peer is sending PINGs it never reads the answers to, and the
 * tunnel closes rather than hold them.
 */
export const TUNNEL_CONTROL_MAX = 4096
/** The round trips a tunnel's p95 is taken over, and the weight of each new one in its average (§4.5). */
export const TUNNEL_RTT_WINDOW_MS = 5 * 60_000
export const TUNNEL_RTT_WEIGHT = 0.25
/**
 * More than `count` replacements of one machine's tunnel within `windowMs`,
 * each from an address other than the tunnel it replaced, raise the owner's
 * banner: two hosts holding one machine's secret look exactly like that (§4.2).
 */
export const TUNNEL_REPLACEMENTS_ALERT = { count: 3, windowMs: 10 * 60_000 } as const
/**
 * A machine replacing its own tunnel from the address it already had (a cut
 * its old socket had not noticed yet) writes at most `count` lines of it to
 * its log within `windowMs`: enough to show a flapping path, and never so
 * many that they push its takeovers and its other history out of the
 * panel's page. A takeover from another address is always written.
 */
export const TUNNEL_SELF_REPLACEMENTS_LOGGED = { count: 6, windowMs: 60 * 60_000 } as const

/** A tunnel session: random per agent life (HELLO) and per home life (WELCOME), 128 bits. */
export const TUNNEL_SESSION = /^[a-f0-9]{32}$/

/* ------------------------------------------------------------------ frames */

export const TUNNEL_KINDS = ['HELLO', 'WELCOME', 'OPEN', 'OPENED', 'REFUSED', 'DATA', 'ACK', 'END', 'RESET', 'PING', 'PONG'] as const
export type TunnelKind = (typeof TUNNEL_KINDS)[number]

/** A kind's byte: its place in TUNNEL_KINDS, from 1. */
export const tunnelKindByte = (kind: TunnelKind): number => TUNNEL_KINDS.indexOf(kind) + 1

export const TUNNEL_LANE = { control: 0, interactive: 1, council: 2 } as const
export type TunnelLane = (typeof TUNNEL_LANE)[keyof typeof TUNNEL_LANE]
/** The lanes a stream may have: the tunnel's own frames alone ride the control lane. */
export type TunnelStreamLane = typeof TUNNEL_LANE.interactive | typeof TUNNEL_LANE.council

/** The lane of a placement's streams: a council worker's behind the room's and the personal notebooks' (§4.4). */
export function tunnelLaneOf(role: RemoteKernelRole): TunnelStreamLane {
  return role === 'council' ? TUNNEL_LANE.council : TUNNEL_LANE.interactive
}

/** How far past its peer's ACK a stream of this lane may send. */
export function tunnelWindow(lane: TunnelStreamLane): number {
  return lane === TUNNEL_LANE.council ? TUNNEL_WINDOW.council : TUNNEL_WINDOW.interactive
}

/** FIN, flags bit 0: a DATA frame that is its stream's last. */
export const TUNNEL_FIN = 0x01

/** Who dialled and who was dialled: the agent dials, home answers. */
export type TunnelSide = 'home' | 'agent'

/** Which side may send each kind; `both` for a stream's bytes and the pings. */
export const TUNNEL_SENDERS: Readonly<Record<TunnelKind, TunnelSide | 'both'>> = {
  HELLO: 'agent', WELCOME: 'home', OPEN: 'home', OPENED: 'agent', REFUSED: 'agent',
  DATA: 'both', ACK: 'both', END: 'both', RESET: 'both', PING: 'both', PONG: 'both',
}

/** What opens a tunnel session: HELLO the agent's, WELCOME home's, each with its own build and session. */
export interface TunnelHello {
  protocol: typeof TUNNEL_PROTOCOL
  build: string
  session: string
}

/** A stream home opens: to the placement of this key at this gen, never another. */
export interface TunnelOpen {
  key: string
  gen: number
}

/**
 * Why the agent will not open a stream: `gone`, it holds no such placement;
 * `stale`, it holds it at another gen; `starting`, its container is not
 * ready yet.
 */
export type TunnelRefusal = 'gone' | 'stale' | 'starting'
export interface TunnelRefused {
  code: TunnelRefusal
}

/** One frame, as the codec reads and writes it. A DATA frame's payload is a view of the message it came in, not a copy. */
export type TunnelFrame =
  | { kind: 'HELLO'; hello: TunnelHello }
  | { kind: 'WELCOME'; welcome: TunnelHello }
  | { kind: 'OPEN'; stream: number; lane: TunnelStreamLane; open: TunnelOpen }
  | { kind: 'OPENED'; stream: number; lane: TunnelStreamLane }
  | { kind: 'REFUSED'; stream: number; lane: TunnelStreamLane; refused: TunnelRefused }
  | { kind: 'DATA'; stream: number; lane: TunnelStreamLane; offset: number; payload: Uint8Array; fin: boolean }
  | { kind: 'ACK'; stream: number; lane: TunnelStreamLane; offset: number }
  | { kind: 'END'; stream: number; lane: TunnelStreamLane; offset: number }
  | { kind: 'RESET'; stream: number; lane: TunnelStreamLane }
  | { kind: 'PING'; id: number }
  | { kind: 'PONG'; id: number }

/* ------------------------------------------------------------------- codec */

/** The tunnel's own frames: stream 0, the control lane. */
const OWN: ReadonlySet<TunnelKind> = new Set<TunnelKind>(['HELLO', 'WELCOME', 'PING', 'PONG'])
/** The frames whose payload is JSON. */
const JSON_KINDS: ReadonlySet<TunnelKind> = new Set<TunnelKind>(['HELLO', 'WELCOME', 'OPEN', 'REFUSED'])
/** The frames whose offset says something. */
const COUNTED: ReadonlySet<TunnelKind> = new Set<TunnelKind>(['DATA', 'ACK', 'END', 'PING', 'PONG'])
const REFUSALS: ReadonlySet<string> = new Set<TunnelRefusal>(['gone', 'stale', 'starting'])

/** One frame as the WebSocket sends it: the encoder refuses what the decoder would refuse. */
export function encodeTunnelFrame(frame: TunnelFrame): Uint8Array {
  if (!frame || typeof frame !== 'object' || !(TUNNEL_KINDS as readonly string[]).includes(frame.kind)) refuse('Unknown tunnel frame kind')
  let payload: Uint8Array = EMPTY
  // A payload goes out with the contract's keys and no other, each checked as its reader will check it.
  if (frame.kind === 'HELLO') payload = jsonOf(helloOf(frame.hello, 'strict', frame.kind))
  else if (frame.kind === 'WELCOME') payload = jsonOf(helloOf(frame.welcome, 'strict', frame.kind))
  else if (frame.kind === 'OPEN') payload = jsonOf(openOf(frame.open, 'strict', frame.lane))
  else if (frame.kind === 'REFUSED') payload = jsonOf(refusedOf(frame.refused, 'strict'))
  else if (frame.kind === 'DATA') {
    if (!(frame.payload instanceof Uint8Array)) refuse('Invalid tunnel data')
    payload = frame.payload
  }
  const own = OWN.has(frame.kind)
  const stream = own ? 0 : (frame as { stream: unknown }).stream
  const lane = own ? TUNNEL_LANE.control : (frame as { lane: unknown }).lane
  const offset = frame.kind === 'PING' || frame.kind === 'PONG' ? frame.id : COUNTED.has(frame.kind) ? (frame as { offset: unknown }).offset : 0
  const fin = frame.kind === 'DATA' && frame.fin === true
  if (frame.kind === 'DATA' && typeof frame.fin !== 'boolean') refuse('Invalid tunnel data')
  header(frame.kind, fin ? TUNNEL_FIN : 0, lane, stream, offset, payload.byteLength)
  const bytes = new Uint8Array(TUNNEL_HEADER_BYTES + payload.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, tunnelKindByte(frame.kind))
  view.setUint8(1, fin ? TUNNEL_FIN : 0)
  view.setUint8(2, lane as number)
  view.setUint8(3, 0)
  view.setUint32(4, stream as number)
  view.setUint32(8, Math.floor((offset as number) / 2 ** 32))
  view.setUint32(12, (offset as number) % 2 ** 32)
  bytes.set(payload, TUNNEL_HEADER_BYTES)
  return bytes
}

/**
 * One frame as it came from `from`, the side that sent it: home decodes the
 * agent's frames and the agent home's. Everything the header and the payload
 * hold is checked before anything is returned.
 */
export function decodeTunnelFrame(message: Uint8Array | ArrayBuffer, from: TunnelSide): TunnelFrame {
  const bytes = message instanceof Uint8Array ? message : message instanceof ArrayBuffer ? new Uint8Array(message) : null
  if (bytes === null || (from !== 'home' && from !== 'agent')) refuse('Invalid tunnel message')
  if (bytes.byteLength < TUNNEL_HEADER_BYTES) refuse('Tunnel frame shorter than its header')
  if (bytes.byteLength > TUNNEL_HEADER_BYTES + TUNNEL_FRAME_MAX) refuse('Tunnel frame over its cap', 'too_large')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind: TunnelKind | undefined = TUNNEL_KINDS[view.getUint8(0) - 1]
  if (kind === undefined) refuse('Unknown tunnel frame kind')
  const sender = TUNNEL_SENDERS[kind]
  // Only home opens streams; an OPEN from the agent is a door into home, and the tunnel closes on it.
  if (sender !== 'both' && sender !== from) refuse(`Unexpected ${kind} from the ${from}`)
  const flags = view.getUint8(1)
  const lane = view.getUint8(2)
  const stream = view.getUint32(4)
  const high = view.getUint32(8)
  // Past 2^53 a JavaScript number no longer counts bytes one by one: no stream, and no ping, gets that far.
  if (high > 0x1f_ffff) refuse('Tunnel offset out of range')
  const offset = high * 2 ** 32 + view.getUint32(12)
  if (view.getUint8(3) !== 0) refuse('Invalid tunnel frame: reserved byte')
  const payload = bytes.subarray(TUNNEL_HEADER_BYTES)
  header(kind, flags, lane, stream, offset, payload.byteLength)
  // Strict where home reads the agent, tolerant where the agent reads home (remote-runner.ts · HOME IS STRICT).
  const mode = from === 'agent' ? 'strict' : 'tolerant'
  switch (kind) {
    case 'HELLO':
      return { kind, hello: helloOf(jsonIn(payload), mode, kind) }
    case 'WELCOME':
      return { kind, welcome: helloOf(jsonIn(payload), mode, kind) }
    case 'OPEN':
      return { kind, stream, lane: lane as TunnelStreamLane, open: openOf(jsonIn(payload), mode, lane) }
    case 'OPENED':
      return { kind, stream, lane: lane as TunnelStreamLane }
    case 'REFUSED':
      return { kind, stream, lane: lane as TunnelStreamLane, refused: refusedOf(jsonIn(payload), mode) }
    case 'DATA':
      return { kind, stream, lane: lane as TunnelStreamLane, offset, payload, fin: (flags & TUNNEL_FIN) !== 0 }
    case 'ACK':
    case 'END':
      return { kind, stream, lane: lane as TunnelStreamLane, offset }
    case 'RESET':
      return { kind, stream, lane: lane as TunnelStreamLane }
    case 'PING':
    case 'PONG':
      return { kind, id: offset }
  }
}

/**
 * The header's rules, the same for both directions: the tunnel's own frames
 * on stream 0 and the control lane, a stream's on its own number and lane,
 * FIN on DATA alone, an offset only where one says something, and each
 * payload within its cap.
 */
function header(kind: TunnelKind, flags: unknown, lane: unknown, stream: unknown, offset: unknown, size: number): void {
  if (OWN.has(kind) ? stream !== 0 || lane !== TUNNEL_LANE.control : !integer(stream, 1, TUNNEL_STREAM_MAX) || (lane !== TUNNEL_LANE.interactive && lane !== TUNNEL_LANE.council)) {
    refuse(`Invalid ${kind} frame: lane or stream`)
  }
  if (flags !== 0 && !(kind === 'DATA' && flags === TUNNEL_FIN)) refuse(`Invalid ${kind} frame: flags`)
  if (COUNTED.has(kind) ? !integer(offset, 0, Number.MAX_SAFE_INTEGER) : offset !== 0) refuse(`Invalid ${kind} frame: offset`)
  if (kind === 'DATA') {
    if (size > TUNNEL_FRAME_MAX) refuse('Tunnel data over its cap', 'too_large')
    // An empty DATA says nothing unless it ends its stream.
    if (size === 0 && flags !== TUNNEL_FIN) refuse('Empty tunnel data')
  } else if (JSON_KINDS.has(kind)) {
    if (size > TUNNEL_JSON_MAX) refuse(`${kind} payload over its cap`, 'too_large')
    if (size === 0) refuse(`${kind} without its payload`)
  } else if (size !== 0) refuse(`Unexpected payload of a ${kind} frame`)
}

/**
 * How a payload is read: `strict` refuses a key it does not know, as home
 * reads the agent's (HELLO, REFUSED) and as the encoder checks its own;
 * `tolerant` drops it, as the agent reads home's (WELCOME, OPEN).
 */
type Reading = 'strict' | 'tolerant'
const keysOf = (value: unknown, what: string, keys: readonly string[], mode: Reading): Record<string, unknown> =>
  mode === 'strict' ? fields(value, what, keys) : known(value, what, keys)

/** HELLO or WELCOME: its protocol is read before its keys, as a request's is (remote-runner.ts · spoken). */
function helloOf(value: unknown, mode: Reading, kind: 'HELLO' | 'WELCOME'): TunnelHello {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`Invalid ${kind}`)
  if ((value as Record<string, unknown>).protocol !== TUNNEL_PROTOCOL) refuse(`Unexpected protocol in ${kind}`, 'protocol')
  const v = keysOf(value, kind, ['protocol', 'build', 'session'], mode)
  if (!matching(v.build, REMOTE_BUILD) || !matching(v.session, TUNNEL_SESSION)) refuse(`Invalid ${kind}`)
  return { protocol: TUNNEL_PROTOCOL, build: v.build, session: v.session }
}

/** OPEN: a placement's key and its gen, on the lane of the placement's role. */
function openOf(value: unknown, mode: Reading, lane: unknown): TunnelOpen {
  const v = keysOf(value, 'OPEN', ['key', 'gen'], mode)
  const slot = parseRemotePlacementKey(v.key)
  if (slot === null || !integer(v.gen, 1, Number.MAX_SAFE_INTEGER)) refuse('Invalid OPEN')
  if (lane !== tunnelLaneOf(slot.role)) refuse('Invalid OPEN frame: lane of another role')
  return { key: v.key as string, gen: v.gen }
}

/** REFUSED: one of its words. */
function refusedOf(value: unknown, mode: Reading): TunnelRefused {
  const v = keysOf(value, 'REFUSED', ['code'], mode)
  if (typeof v.code !== 'string' || !REFUSALS.has(v.code)) refuse('Invalid REFUSED')
  return { code: v.code as TunnelRefusal }
}

const EMPTY = new Uint8Array(0)
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function jsonOf(value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value))
  if (bytes.byteLength > TUNNEL_JSON_MAX) refuse('Tunnel JSON over its cap', 'too_large')
  return bytes
}

function jsonIn(payload: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(payload))
  } catch {
    return refuse('Tunnel JSON that does not parse')
  }
}

/* -------------------------------------------------------------------- ends */

/**
 * The clock and the timers an end runs on: the process's at home and on the
 * agent, a test's own in the tests, which count events and never wait for
 * milliseconds. A handle is whatever `setTimeout` gave, handed back to
 * `clearTimeout` and nowhere else.
 */
export interface TunnelClock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/**
 * What an end needs of its WebSocket: binary messages, each with a callback
 * once it is written out, and the bytes it holds unwritten (ws's
 * `bufferedAmount`: its sender's and its TCP socket's). Closing it is its
 * owner's (TunnelHooks.end).
 */
export interface TunnelSocket {
  readonly bufferedAmount: number
  send(frame: Uint8Array, done: (error?: Error) => void): void
}

/**
 * A stream's local connection: the TCP connection home accepted on a
 * placement's listener, or the one the agent made to the placement's
 * Jupyter. The end writes the peer's bytes into it, ends or drops it, and
 * stops and starts reading it.
 */
export interface TunnelLocal {
  /** The peer's next bytes, in order; `taken` once the connection has them, which is when they count as delivered and are ACKed. */
  write(payload: Uint8Array, taken: () => void): void
  /** The peer sent its last byte: half-close, after what was written. */
  end(): void
  /** The stream is over without an end (a RESET, a refusal, the tunnel gone): drop the connection at once. */
  destroy(): void
  /** Stop and start reading it: its stream is out of window, or its queue is full. */
  pause(): void
  resume(): void
}

/** Where a stream is: its OPEN sent (home) or read (the agent), answered with OPENED, or over. */
export type TunnelStreamState = 'opening' | 'open' | 'closed'

/**
 * One stream: one TCP connection's bytes both ways, numbered by home. The
 * counters are the end's and read-only to everyone else, each kept on its
 * own so that resumable streams (§4.8) can keep `sent - acked` for a while
 * and send again from the peer's `received`:
 * - towards the peer, `sent` (the next DATA's offset), `acked` (the peer's
 *   cumulative ACK) and `queued`, the bytes still waiting in its queue;
 * - from the peer, `received` (the next DATA's offset), `delivered` (what the
 *   local connection has taken) and `ackedOut` (the last ACK said).
 */
export class TunnelStream {
  state: TunnelStreamState = 'opening'
  local: TunnelLocal | null = null
  sent = 0
  acked = 0
  queued = 0
  received = 0
  delivered = 0
  ackedOut = 0
  /** The local connection ended: END goes once the queue is out. */
  ending = false
  endSent = false
  peerEnded = false
  /** The local connection is paused: out of window, or its queue full. */
  paused = false
  /** The end's own: the bytes waiting, and where in the first of them the next frame starts. */
  queue: Uint8Array[] = []
  head = 0
  /** The end's own, deficit round robin: what this turn may still send, whether the stream is in its turn, whether it is in its lane's ring. */
  deficit = 0
  turn = false
  ringed = false
  /** The end's own: its ACK waits among the control frames (one at most), and the timer of the next one. */
  ackQueued = false
  ackTimer: unknown = null

  constructor(
    readonly id: number,
    readonly lane: TunnelStreamLane,
    /** The placement its OPEN named, by its key and gen. */
    readonly key: string,
    readonly gen: number,
  ) {}

  /** How far past the peer's ACK it may send: its lane's (TUNNEL_WINDOW). */
  get window(): number {
    return tunnelWindow(this.lane)
  }
}

/**
 * A tunnel's round trips, from its PONGs: their average, each new one
 * weighing TUNNEL_RTT_WEIGHT, and their 95th percentile over the last
 * TUNNEL_RTT_WINDOW_MS, which home's chooser, the help pads and the panel
 * read (§4.5, §5.6).
 */
export class TunnelRtt {
  private readonly samples: Array<{ at: number; ms: number }> = []
  private average: number | null = null

  add(ms: number, at: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    this.average = this.average === null ? ms : this.average + TUNNEL_RTT_WEIGHT * (ms - this.average)
    this.samples.push({ at, ms })
    this.prune(at)
  }

  get ewmaMs(): number | null {
    return this.average
  }

  p95Ms(now: number): number | null {
    this.prune(now)
    if (this.samples.length === 0) return null
    const sorted = this.samples.map((sample) => sample.ms).sort((a, b) => a - b)
    return sorted[Math.ceil(sorted.length * 0.95) - 1]
  }

  private prune(now: number): void {
    // A PING every ten seconds is thirty in the window; the cap is for a clock that jumped.
    while (this.samples.length > 0 && (now - this.samples[0].at >= TUNNEL_RTT_WINDOW_MS || this.samples.length > 1024)) this.samples.shift()
  }
}

/**
 * The pace of a machine's streams towards home (§4.4, D18): a token bucket
 * of `burst` bytes, refilled at `rate()` bytes a second continuously on its
 * clock, so that bytes leave smoothly and never a second's worth at once.
 * K0 measured why: through relay2, 4 MiB/s sent as one-second bursts raised
 * the shared leg's p99 to 1.2 s, the same rate paced left it as it was. One
 * figure fits in the burst and goes at once; thirty attempts' plots wait
 * their turn on the machine, not in the leg every student shares.
 */
export class TunnelPace {
  private tokens: number
  private stamp: number

  constructor(
    private readonly clock: TunnelClock,
    /** Bytes a second, read at every frame: home's reply may change it (RemoteKernelsReply.rates). */
    private readonly rate: () => number,
    private readonly burst: number,
  ) {
    this.tokens = burst
    this.stamp = clock.now()
  }

  /** How long until `bytes` may go: 0, and they are spent, when they may go now. */
  take(bytes: number): number {
    const now = this.clock.now()
    const rate = this.rate()
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.stamp) * rate) / 1000)
    this.stamp = now
    const wanted = Math.min(bytes, this.burst)
    if (this.tokens >= wanted) {
      this.tokens -= wanted
      return 0
    }
    return Math.max(1, Math.ceil(((wanted - this.tokens) * 1000) / rate))
  }
}

/** What an end tells its owner, and asks it. */
export interface TunnelHooks {
  /** Home: the agent's HELLO. `null` WELCOMEs it; a code and a reason refuse it, and the tunnel closes with them. */
  hello?(hello: TunnelHello): { code: number; reason: string } | null
  /** The tunnel is open: home has sent its WELCOME, or the agent has read it. */
  up?(peer: TunnelHello): void
  /** The agent: home OPENs a stream. It is answered with `accept` and `opened`, or with `refuse`, now or later. */
  open?(stream: TunnelStream, open: TunnelOpen): void
  /** Home: the agent's answer to an OPEN, `null` for OPENED. */
  answered?(stream: TunnelStream, refused: TunnelRefusal | null): void
  /** A frame came in, before it is read: home counts it as the machine heard (heard.ts · noteCall). */
  heard?(): void
  /** A PING of this end's came back after `ms`. */
  rtt?(ms: number): void
  /** The tunnel is over: close the socket with `code`, or terminate it with no handshake when `code` is null (a dead link reads none). */
  end(code: number | null, reason: string): void
}

export interface TunnelEndOptions {
  side: TunnelSide
  socket: TunnelSocket
  clock: TunnelClock
  /** What this end says of itself in its HELLO or WELCOME. */
  build: string
  session: string
  hooks: TunnelHooks
  /** The agent's: its DATA towards home passes it. Home sends unpaced (§4.9). */
  pace?: TunnelPace | null
}

const LANES: readonly TunnelStreamLane[] = [TUNNEL_LANE.interactive, TUNNEL_LANE.council]

/**
 * One end of a tunnel, the same at home and on the agent (§4.3–4.7): the
 * greeting, the streams, the sender, the ACKs and the pings. Its owner wires
 * it to a WebSocket (TunnelSocket) and to TCP connections (TunnelLocal);
 * nothing here knows of either.
 *
 * THE SENDER. A frame goes to the socket only while the socket holds at most
 * TUNNEL_SEND_LOWAT unwritten, so the queue a keystroke waits behind stays in
 * the end, where order can still be chosen. The tunnel's own frames go first
 * (the greeting, OPENs and their answers, ACKs, ENDs, RESETs, PINGs and
 * PONGs, all small), then the interactive lane, then the council lane, each
 * strictly before the next. Within a lane the streams take deficit
 * round-robin turns of TUNNEL_FRAME_MAX: a 6 MiB figure of one kernel goes a
 * frame at a time between another kernel's prints. A stream sends at most
 * its window past the peer's ACK, and all of them together at most the
 * machine's (TUNNEL_WINDOW), the council lane's an interactive window less
 * (TUNNEL_COUNCIL_SHARE); one out of window, or with TUNNEL_QUEUE_BYTES
 * waiting, has its local connection paused, so a flooding cell waits in
 * jupyter_server's buffers and behind its rate limit, never in this memory.
 * On the agent DATA passes the machine's pace (TunnelPace).
 *
 * THE RECEIVER writes each DATA into its stream's local connection, and ACKs
 * what the connection has taken, every TUNNEL_ACK_BYTES at once or after
 * TUNNEL_ACK_MS: as that connection drains, not as bytes arrive, so the
 * window holds back a sender whose reader is slow. A peer past a window, out
 * of order, past its END, or with a stream it never opened, is a violation
 * and the tunnel closes (TUNNEL_CLOSE.violation): the codec has checked each
 * frame's shape, this checks what the frames say together.
 *
 * LIVENESS. Each end PINGs every TUNNEL_PING_MS once open, and ends the
 * tunnel with no close handshake after TUNNEL_DEAD_MS without a frame, or
 * after TUNNEL_GREETING_MS without its greeting.
 */
export class TunnelEnd {
  readonly side: TunnelSide
  private readonly from: TunnelSide
  private readonly socket: TunnelSocket
  private readonly clock: TunnelClock
  private readonly hooks: TunnelHooks
  private readonly pace: TunnelPace | null
  private readonly build: string
  private readonly session: string
  private phase: 'greeting' | 'open' | 'closed' = 'greeting'
  private readonly streams = new Map<number, TunnelStream>()
  /** Home: the number of the next stream it opens. The agent: one past the last home opened. */
  private nextStream = 1
  /** The tunnel's own frames, before any DATA; a stream stands for its ACK, read when it goes. */
  private readonly control: Array<TunnelFrame | TunnelStream> = []
  private readonly rings: Record<TunnelStreamLane, TunnelStream[]> = { 1: [], 2: [] }
  private readonly cursor: Record<TunnelStreamLane, number> = { 1: 0, 2: 0 }
  /** Bytes sent and not yet ACKed, every stream's: against the machine's window. */
  private outbound = 0
  /** Bytes received and not yet ACKed, every stream's: what the peer may have in flight. */
  private inbound = 0
  private pumping = false
  private wake: unknown = null
  private wakeAt = 0
  private timer: unknown = null
  private readonly startedAt: number
  private heardAt: number
  private nextPingAt = 0
  private pingId = 0
  private readonly pings = new Map<number, number>()
  private readonly afterSend = (error?: Error): void => {
    if (!error) this.pump()
  }

  constructor(options: TunnelEndOptions) {
    this.side = options.side
    this.from = options.side === 'home' ? 'agent' : 'home'
    this.socket = options.socket
    this.clock = options.clock
    this.hooks = options.hooks
    this.pace = options.pace ?? null
    this.build = options.build
    this.session = options.session
    this.startedAt = this.heardAt = this.clock.now()
  }

  /** Open: greeted both ways and not over. */
  get up(): boolean {
    return this.phase === 'open'
  }

  get closed(): boolean {
    return this.phase === 'closed'
  }

  /** The streams it holds now. */
  get count(): number {
    return this.streams.size
  }

  /** The socket is open: the agent says HELLO, and both start their clocks. */
  start(): void {
    if (this.phase !== 'greeting') return
    if (this.side === 'agent') this.queueControl({ kind: 'HELLO', hello: { protocol: TUNNEL_PROTOCOL, build: this.build, session: this.session } })
    this.reschedule()
  }

  /** A message of the socket's, as ws gives it. */
  receive(message: unknown, binary: boolean): void {
    if (this.phase === 'closed') return
    this.heardAt = this.clock.now()
    try {
      this.hooks.heard?.()
      const bytes = bytesOf(message)
      if (!binary || bytes === null) return this.fail(TUNNEL_CLOSE.violation, 'A text message on the tunnel')
      let frame: TunnelFrame
      try {
        frame = decodeTunnelFrame(bytes, this.from)
      } catch (error) {
        const protocol = error instanceof RemoteProtocolError && error.code === 'protocol'
        return this.fail(protocol ? TUNNEL_CLOSE.protocol : TUNNEL_CLOSE.violation, messageOf(error))
      }
      this.read(frame)
    } catch (error) {
      // An owner's hook that threw costs this tunnel, never the process.
      this.fail(TUNNEL_INTERNAL_CLOSE, messageOf(error))
    }
  }

  /** Home: a stream to the placement `key` at `gen`, its bytes those of `local`; null — the tunnel is not open, or holds TUNNEL_STREAMS_MAX. */
  open(key: string, gen: number, local: TunnelLocal): TunnelStream | null {
    if (this.side !== 'home' || this.phase !== 'open' || this.streams.size >= TUNNEL_STREAMS_MAX || this.nextStream > TUNNEL_STREAM_MAX) return null
    const slot = parseRemotePlacementKey(key)
    if (slot === null || !integer(gen, 1, Number.MAX_SAFE_INTEGER)) return null
    const stream = new TunnelStream(this.nextStream++, tunnelLaneOf(slot.role), key, gen)
    stream.local = local
    this.streams.set(stream.id, stream)
    this.queueControl({ kind: 'OPEN', stream: stream.id, lane: stream.lane, open: { key, gen } })
    return stream
  }

  /** The agent: the local connection an OPEN's stream will carry, while it connects. Dropped if the stream is reset meanwhile. */
  accept(stream: TunnelStream, local: TunnelLocal): void {
    if (this.side !== 'agent' || stream.state !== 'opening') return
    stream.local = local
  }

  /** The agent: the local connection is up; OPENED, ahead of the stream's first bytes. */
  opened(stream: TunnelStream): void {
    if (this.side !== 'agent' || stream.state !== 'opening' || this.phase !== 'open') return
    stream.state = 'open'
    this.queueControl({ kind: 'OPENED', stream: stream.id, lane: stream.lane })
    this.flow(stream)
    this.ring(stream)
    this.maybeEnd(stream)
    this.pump()
  }

  /** The agent: no stream for this OPEN, and why. */
  refuse(stream: TunnelStream, code: TunnelRefusal): void {
    if (this.side !== 'agent' || stream.state !== 'opening') return
    this.queueControl({ kind: 'REFUSED', stream: stream.id, lane: stream.lane, refused: { code } })
    this.forget(stream, true)
  }

  /** Bytes the local connection sent. */
  write(stream: TunnelStream, chunk: Uint8Array): void {
    if (stream.state === 'closed' || stream.ending || chunk.byteLength === 0) return
    stream.queue.push(chunk)
    stream.queued += chunk.byteLength
    this.flow(stream)
    if (stream.state === 'open') {
      this.ring(stream)
      this.pump()
    }
  }

  /** The local connection ended its side: END once what it sent is out. */
  finish(stream: TunnelStream): void {
    if (stream.state === 'closed' || stream.ending) return
    stream.ending = true
    this.maybeEnd(stream)
  }

  /** The local connection broke: RESET, and the stream is over. */
  reset(stream: TunnelStream): void {
    if (stream.state === 'closed') return
    this.queueControl({ kind: 'RESET', stream: stream.id, lane: stream.lane })
    this.forget(stream, true)
  }

  /** The socket is gone, or going: every stream is dropped with it, and nothing more is sent. */
  close(): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    if (this.wake !== null) this.clock.clearTimeout(this.wake)
    this.timer = this.wake = null
    for (const stream of [...this.streams.values()]) this.forget(stream, true)
    this.control.length = 0
  }

  /* ----------------------------------------------------------- reading */

  private read(frame: TunnelFrame): void {
    if (this.phase === 'greeting') {
      const first = this.side === 'home' ? 'HELLO' : 'WELCOME'
      if (frame.kind !== first) return this.fail(TUNNEL_CLOSE.violation, `${frame.kind} before ${first}`)
    }
    switch (frame.kind) {
      case 'HELLO':
        return this.greeted(frame.hello)
      case 'WELCOME':
        return this.welcomed(frame.welcome)
      case 'OPEN':
        return this.opening(frame.stream, frame.lane, frame.open)
      case 'OPENED':
        return this.answer(frame.stream, null)
      case 'REFUSED':
        return this.answer(frame.stream, frame.refused.code)
      case 'DATA':
        return this.data(frame.stream, frame.offset, frame.payload, frame.fin)
      case 'ACK':
        return this.ack(frame.stream, frame.offset)
      case 'END':
        return this.ended(frame.stream, frame.offset)
      case 'RESET':
        return this.resetBy(frame.stream)
      case 'PING':
        return this.queueControl({ kind: 'PONG', id: frame.id })
      case 'PONG':
        return this.pong(frame.id)
    }
  }

  private greeted(hello: TunnelHello): void {
    if (this.phase !== 'greeting') return this.fail(TUNNEL_CLOSE.violation, 'A second HELLO')
    const refusal = this.hooks.hello?.(hello) ?? null
    if (refusal) return this.fail(refusal.code, refusal.reason)
    if (this.phase !== 'greeting') return
    this.queueControl({ kind: 'WELCOME', welcome: { protocol: TUNNEL_PROTOCOL, build: this.build, session: this.session } })
    this.becomeOpen(hello)
  }

  private welcomed(welcome: TunnelHello): void {
    if (this.phase !== 'greeting') return this.fail(TUNNEL_CLOSE.violation, 'A second WELCOME')
    this.becomeOpen(welcome)
  }

  private becomeOpen(peer: TunnelHello): void {
    this.phase = 'open'
    // The first PING goes now: the chooser and the help pads want a round trip before the first ten seconds are out.
    this.nextPingAt = this.clock.now()
    this.reschedule()
    this.hooks.up?.(peer)
  }

  /** The agent: home OPENs a stream, numbered upwards. */
  private opening(id: number, lane: TunnelStreamLane, open: TunnelOpen): void {
    if (id < this.nextStream) return this.fail(TUNNEL_CLOSE.violation, `OPEN of stream ${id}, a number already used`)
    if (this.streams.size >= TUNNEL_STREAMS_MAX) return this.fail(TUNNEL_CLOSE.violation, `OPEN past ${TUNNEL_STREAMS_MAX} streams`)
    this.nextStream = id + 1
    const stream = new TunnelStream(id, lane, open.key, open.gen)
    this.streams.set(id, stream)
    if (this.hooks.open) this.hooks.open(stream, open)
    else this.refuse(stream, 'gone')
  }

  /** Home: OPENED or REFUSED. */
  private answer(id: number, refused: TunnelRefusal | null): void {
    const stream = this.known(id)
    if (!stream) return
    if (stream.state !== 'opening') return this.fail(TUNNEL_CLOSE.violation, `A second answer to the OPEN of stream ${id}`)
    this.hooks.answered?.(stream, refused)
    if (refused !== null) return this.forget(stream, true)
    stream.state = 'open'
    this.flow(stream)
    this.ring(stream)
    this.maybeEnd(stream)
    this.pump()
  }

  private data(id: number, offset: number, payload: Uint8Array, fin: boolean): void {
    const stream = this.known(id)
    if (!stream) return
    if (stream.state !== 'open') return this.fail(TUNNEL_CLOSE.violation, `DATA of stream ${id} before it opened`)
    if (stream.peerEnded) return this.fail(TUNNEL_CLOSE.violation, `DATA of stream ${id} after its end`)
    if (offset !== stream.received) return this.fail(TUNNEL_CLOSE.violation, `DATA of stream ${id} at ${offset}, expected ${stream.received}`)
    const size = payload.byteLength
    stream.received += size
    this.inbound += size
    if (stream.received - stream.ackedOut > stream.window) return this.fail(TUNNEL_CLOSE.violation, `Stream ${id} past its window`)
    if (this.inbound > TUNNEL_WINDOW.machine) return this.fail(TUNNEL_CLOSE.violation, 'The tunnel past its window')
    if (size > 0) stream.local?.write(payload, () => this.delivered(stream, size))
    if (fin) this.peerEnd(stream)
  }

  private ack(id: number, offset: number): void {
    const stream = this.known(id)
    if (!stream) return
    if (offset > stream.sent) return this.fail(TUNNEL_CLOSE.violation, `ACK of stream ${id} past the ${stream.sent} bytes sent`)
    if (offset <= stream.acked) return
    this.outbound -= offset - stream.acked
    stream.acked = offset
    this.flow(stream)
    this.ring(stream)
    this.pump()
  }

  private ended(id: number, offset: number): void {
    const stream = this.known(id)
    if (!stream) return
    if (stream.state !== 'open') return this.fail(TUNNEL_CLOSE.violation, `END of stream ${id} before it opened`)
    if (stream.peerEnded) return this.fail(TUNNEL_CLOSE.violation, `A second END of stream ${id}`)
    if (offset !== stream.received) return this.fail(TUNNEL_CLOSE.violation, `END of stream ${id} at ${offset} after ${stream.received} bytes`)
    this.peerEnd(stream)
  }

  private resetBy(id: number): void {
    const stream = this.known(id)
    if (stream) this.forget(stream, true)
  }

  private pong(id: number): void {
    const at = this.pings.get(id)
    if (at === undefined) return
    this.pings.delete(id)
    this.hooks.rtt?.(this.clock.now() - at)
  }

  /**
   * The stream a frame names. A number this tunnel used and let go of is
   * the tail of a stream either side reset, still on the wire: dropped. A
   * number never used is a violation.
   */
  private known(id: number): TunnelStream | null {
    const stream = this.streams.get(id)
    if (stream) return stream
    if (id >= this.nextStream) this.fail(TUNNEL_CLOSE.violation, `A frame of stream ${id}, never opened`)
    return null
  }

  private peerEnd(stream: TunnelStream): void {
    stream.peerEnded = true
    stream.local?.end()
    // The last ACK goes as soon as the connection has everything, not TUNNEL_ACK_MS later.
    if (stream.delivered === stream.received) this.ackNow(stream)
    if (stream.endSent) this.forget(stream, false)
  }

  private delivered(stream: TunnelStream, bytes: number): void {
    if (stream.state === 'closed') return
    stream.delivered += bytes
    if (stream.delivered - stream.ackedOut >= TUNNEL_ACK_BYTES || (stream.peerEnded && stream.delivered === stream.received)) this.ackNow(stream)
    else if (stream.ackTimer === null) {
      stream.ackTimer = this.clock.setTimeout(() => {
        stream.ackTimer = null
        this.ackNow(stream)
      }, TUNNEL_ACK_MS)
    }
  }

  private ackNow(stream: TunnelStream): void {
    if (stream.ackTimer !== null) {
      this.clock.clearTimeout(stream.ackTimer)
      stream.ackTimer = null
    }
    if (stream.state === 'closed' || stream.delivered === stream.ackedOut) return
    this.inbound -= stream.delivered - stream.ackedOut
    stream.ackedOut = stream.delivered
    // One ACK per stream waits at most; it says the offset as of when it goes.
    if (stream.ackQueued) return
    stream.ackQueued = true
    this.queueControl(stream)
  }

  /* ----------------------------------------------------------- sending */

  private queueControl(frame: TunnelFrame | TunnelStream): void {
    if (this.phase === 'closed') return
    if (this.control.length >= TUNNEL_CONTROL_MAX) return this.fail(TUNNEL_CLOSE.violation, `Over ${TUNNEL_CONTROL_MAX} frames waiting to go`)
    this.control.push(frame)
    this.pump()
  }

  private pump(): void {
    if (this.pumping || this.phase === 'closed') return
    this.pumping = true
    try {
      // A send may end the tunnel under the loop (a socket that fails at once): `closed` is read again each time.
      while (!this.closed && this.socket.bufferedAmount <= TUNNEL_SEND_LOWAT) {
        const frame = this.nextControl() ?? (this.up ? this.nextData() : null)
        if (frame === null) break
        this.socket.send(frame, this.afterSend)
      }
    } catch (error) {
      this.pumping = false
      return this.fail(TUNNEL_INTERNAL_CLOSE, messageOf(error))
    }
    this.pumping = false
  }

  private nextControl(): Uint8Array | null {
    while (this.control.length > 0) {
      const item = this.control.shift()!
      if (!(item instanceof TunnelStream)) return encodeTunnelFrame(item)
      item.ackQueued = false
      if (item.state !== 'closed') return encodeTunnelFrame({ kind: 'ACK', stream: item.id, lane: item.lane, offset: item.ackedOut })
    }
    return null
  }

  /**
   * The next DATA frame: the interactive lane strictly before the council
   * lane, and within a lane deficit round robin. A stream's turn adds
   * TUNNEL_FRAME_MAX to its deficit and lasts while the deficit covers its
   * next frame; since no frame is larger, a new turn always sends one, so a
   * stream alone in its lane goes on frame after frame rather than waiting
   * for the socket's next callback. A stream with nothing it may send
   * leaves the ring, and comes back with its next bytes or ACK.
   */
  private nextData(): Uint8Array | null {
    if (this.outbound >= TUNNEL_WINDOW.machine) return null
    for (const lane of LANES) {
      // A lane past its share of the machine's window is passed over whole, its streams left in their ring: dropped from it,
      // one with nothing in flight would wait for an ACK of its own that never comes.
      if (lane === TUNNEL_LANE.council && this.outbound >= TUNNEL_COUNCIL_SHARE) continue
      const ring = this.rings[lane]
      while (ring.length > 0) {
        if (this.cursor[lane] >= ring.length) this.cursor[lane] = 0
        const stream = ring[this.cursor[lane]]
        const size = this.frameSize(stream)
        if (size === 0) {
          this.unring(stream)
          continue
        }
        if (!stream.turn) {
          stream.turn = true
          stream.deficit += TUNNEL_FRAME_MAX
        }
        if (size > stream.deficit) {
          stream.turn = false
          this.cursor[lane] = (this.cursor[lane] + 1) % ring.length
          continue
        }
        if (this.pace) {
          const wait = this.pace.take(size)
          if (wait > 0) {
            this.wakeIn(wait)
            return null
          }
        }
        stream.deficit -= size
        return this.dataFrame(stream, size)
      }
    }
    return null
  }

  /**
   * The size of a stream's next DATA now: 0 when it has nothing it may send
   * by itself (its queue empty, its own window spent). The council lane stops
   * an interactive window short of the machine's: the attempts' streams
   * together never hold the room's lane back by an RTT.
   */
  private frameSize(stream: TunnelStream): number {
    if (stream.state !== 'open' || stream.queued === 0) return 0
    const machine = stream.lane === TUNNEL_LANE.council ? TUNNEL_COUNCIL_SHARE : TUNNEL_WINDOW.machine
    const room = Math.min(stream.window - (stream.sent - stream.acked), machine - this.outbound)
    return Math.max(0, Math.min(stream.queued, TUNNEL_FRAME_MAX, room))
  }

  private dataFrame(stream: TunnelStream, size: number): Uint8Array {
    const first = stream.queue[0]
    let payload: Uint8Array
    if (first.byteLength - stream.head >= size) {
      payload = first.subarray(stream.head, stream.head + size)
      stream.head += size
      if (stream.head === first.byteLength) {
        stream.queue.shift()
        stream.head = 0
      }
    } else {
      payload = new Uint8Array(size)
      for (let filled = 0; filled < size;) {
        const chunk = stream.queue[0]
        const take = Math.min(chunk.byteLength - stream.head, size - filled)
        payload.set(chunk.subarray(stream.head, stream.head + take), filled)
        filled += take
        stream.head += take
        if (stream.head === chunk.byteLength) {
          stream.queue.shift()
          stream.head = 0
        }
      }
    }
    stream.queued -= size
    // The last bytes of a stream whose connection already ended carry FIN, and no END follows.
    const fin = stream.ending && stream.queued === 0
    const frame = encodeTunnelFrame({ kind: 'DATA', stream: stream.id, lane: stream.lane, offset: stream.sent, payload, fin })
    stream.sent += size
    this.outbound += size
    this.flow(stream)
    if (fin) {
      stream.endSent = true
      if (stream.peerEnded) this.forget(stream, false)
    }
    return frame
  }

  /** END, once the connection ended and its bytes are out; a stream ended both ways is over. */
  private maybeEnd(stream: TunnelStream): void {
    if (!stream.ending || stream.endSent || stream.queued > 0 || stream.state !== 'open') return
    stream.endSent = true
    this.queueControl({ kind: 'END', stream: stream.id, lane: stream.lane, offset: stream.sent })
    if (stream.peerEnded) this.forget(stream, false)
  }

  /** Pause or resume a stream's local connection: paused while its queue is full or its window spent. */
  private flow(stream: TunnelStream): void {
    if (stream.state === 'closed' || stream.local === null) return
    const full = stream.queued >= TUNNEL_QUEUE_BYTES || stream.sent - stream.acked + stream.queued >= stream.window
    if (full === stream.paused) return
    stream.paused = full
    if (full) stream.local.pause()
    else stream.local.resume()
  }

  private ring(stream: TunnelStream): void {
    if (stream.ringed || stream.state !== 'open' || stream.queued === 0) return
    stream.ringed = true
    this.rings[stream.lane].push(stream)
  }

  private unring(stream: TunnelStream): void {
    if (!stream.ringed) return
    stream.ringed = false
    stream.turn = false
    stream.deficit = 0
    const ring = this.rings[stream.lane]
    const at = ring.indexOf(stream)
    if (at < 0) return
    ring.splice(at, 1)
    if (at < this.cursor[stream.lane]) this.cursor[stream.lane]--
  }

  /** A stream is over: `destroy` drops its local connection; one that ended both ways is left to finish writing. */
  private forget(stream: TunnelStream, destroy: boolean): void {
    if (stream.state === 'closed') return
    stream.state = 'closed'
    this.streams.delete(stream.id)
    this.unring(stream)
    this.outbound -= stream.sent - stream.acked
    this.inbound -= stream.received - stream.ackedOut
    if (stream.ackTimer !== null) this.clock.clearTimeout(stream.ackTimer)
    stream.ackTimer = null
    stream.queue = []
    stream.queued = 0
    stream.head = 0
    const local = stream.local
    stream.local = null
    if (destroy) local?.destroy()
    // What it held of the machine's window is free for the others.
    this.pump()
  }

  private wakeIn(ms: number): void {
    const at = this.clock.now() + ms
    if (this.wake !== null && this.wakeAt <= at) return
    if (this.wake !== null) this.clock.clearTimeout(this.wake)
    this.wakeAt = at
    this.wake = this.clock.setTimeout(() => {
      this.wake = null
      this.pump()
    }, ms)
  }

  /* ---------------------------------------------------------- liveness */

  private ping(): void {
    const id = ++this.pingId
    this.pings.set(id, this.clock.now())
    // A PONG that never came is not waited for past a few more PINGs.
    for (const old of this.pings.keys()) {
      if (this.pings.size <= 8) break
      this.pings.delete(old)
    }
    this.queueControl({ kind: 'PING', id })
  }

  private tick(): void {
    this.timer = null
    if (this.phase === 'closed') return
    const now = this.clock.now()
    if (now - this.heardAt >= TUNNEL_DEAD_MS) return this.fail(null, `No frame for ${TUNNEL_DEAD_MS / 1000} s`)
    if (this.phase === 'greeting' && now - this.startedAt >= TUNNEL_GREETING_MS) {
      return this.fail(null, `No ${this.side === 'home' ? 'HELLO' : 'WELCOME'} in ${TUNNEL_GREETING_MS / 1000} s`)
    }
    if (this.phase === 'open' && now >= this.nextPingAt) {
      this.nextPingAt = now + TUNNEL_PING_MS
      this.ping()
    }
    this.reschedule()
  }

  /** The clock's next look: the dead line, and the greeting's or the next PING's. */
  private reschedule(): void {
    if (this.phase === 'closed') return
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    const at = Math.min(this.heardAt + TUNNEL_DEAD_MS, this.phase === 'greeting' ? this.startedAt + TUNNEL_GREETING_MS : this.nextPingAt)
    this.timer = this.clock.setTimeout(() => this.tick(), Math.max(0, at - this.clock.now()))
  }

  private fail(code: number | null, reason: string): void {
    if (this.phase === 'closed') return
    this.close()
    this.hooks.end(code, reason)
  }
}

/* ---------------------------------------------------------------- wiring */

/**
 * The process's own clock and timers, the ones both ends run on outside
 * the tests. Unref'd where the runtime has it: a tunnel's ping must not keep
 * a process up that has nothing else to do.
 */
export const processClock: TunnelClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms) as unknown as { unref?: () => void }
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
}

/** What an end uses of a ws WebSocket. */
interface WebSocketLike {
  readonly bufferedAmount: number
  send(data: Uint8Array, options: { binary: boolean }, done: (error?: Error) => void): void
}

/** A ws WebSocket as an end's socket: every frame one binary message. */
export function tunnelSocketOf(ws: WebSocketLike): TunnelSocket {
  return {
    get bufferedAmount() {
      return ws.bufferedAmount
    },
    send: (frame, done) => ws.send(frame, { binary: true }, done),
  }
}

/** What a stream uses of a node:net Socket. */
interface TcpLike {
  readonly destroyed: boolean
  readonly connecting?: boolean
  write(data: Uint8Array, done: (error?: Error | null) => void): boolean
  end(): void
  destroy(): void
  resetAndDestroy?(): void
  pause(): void
  resume(): void
}

/**
 * A TCP connection as a stream's local connection. A dropped one is reset
 * (RST), not closed: the client on it, home's kernel client or the
 * placement's Jupyter, reads ECONNRESET at once rather than an orderly end
 * it would take for an answer.
 */
export function tunnelLocalOf(socket: TcpLike): TunnelLocal {
  return {
    write: (payload, taken) => {
      if (socket.destroyed) return
      socket.write(payload, (error) => {
        if (!error) taken()
      })
    },
    end: () => {
      if (!socket.destroyed) socket.end()
    },
    destroy: () => resetTcp(socket),
    pause: () => socket.pause(),
    resume: () => socket.resume(),
  }
}

/** What a stream's wiring hears of a node:net Socket. */
interface TcpEvents extends TcpLike {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'close', listener: (hadError: boolean) => void): unknown
}

/**
 * A TCP connection's bytes, end and break into its stream, the same at both
 * ends. Its bytes are the stream's; its orderly end (FIN) is the stream's
 * END once the bytes queued before it are out; its close is a RESET only
 * when it broke, or closed without an end. A connection half-open as TCP
 * allows closes once both of its sides are done, and that is often before
 * its stream has sent everything it read: the pace or the window still hold
 * the tail of an answer whose Jupyter has already hung up, and a RESET then
 * would drop exactly that tail. `broke` is what a break does, a RESET by
 * default.
 */
export function pipeTcp(end: TunnelEnd, stream: TunnelStream, socket: TcpEvents, broke: () => void = () => end.reset(stream)): void {
  let ended = false
  socket.on('data', (chunk) => end.write(stream, chunk))
  socket.on('end', () => {
    ended = true
    end.finish(stream)
  })
  socket.on('close', (hadError) => {
    if (hadError || !ended) broke()
  })
}

/**
 * Drop a TCP connection with an RST. One still connecting is destroyed
 * plainly, now: an RST would wait for a connect that may never come.
 */
export function resetTcp(socket: TcpLike): void {
  if (socket.destroyed) return
  try {
    if (socket.resetAndDestroy && !socket.connecting) socket.resetAndDestroy()
    else socket.destroy()
  } catch {
    socket.destroy()
  }
}

/** A WebSocket message as bytes: ws gives a Buffer, an ArrayBuffer or, in fragments, a list of them. */
function bytesOf(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  if (!Array.isArray(message) || !message.every((part) => part instanceof Uint8Array)) return null
  const parts = message as Uint8Array[]
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  return bytes
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
