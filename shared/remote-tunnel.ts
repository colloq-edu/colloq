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
 * PURE, FOR BOTH ENDS. Uint8Array and DataView only, no node: module and
 * nothing done at import time: the agent's bundle carries it whole.
 */
import { REMOTE_BUILD, fields, integer, known, matching, refuse } from './remote-runner.js'
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

/** Upgrades one machine may make in a window: past them 429 (net/too-often.ts). */
export const TUNNEL_UPGRADES = { count: 12, windowMs: 60_000 } as const

/**
 * The close codes of a tunnel, each side's. A dead link is terminated without
 * one (TUNNEL_DEAD_MS): there is nobody to read it.
 */
export const TUNNEL_CLOSE = {
  /** A frame this codec refuses, or one its sender may not send. */
  violation: 4400,
  /** The machine's credential was revoked. */
  unauthorized: 4401,
  /** The machine may no longer hold a tunnel: its classes were turned off or quarantined. */
  forbidden: 4403,
  /** A newer tunnel of the same machine took this one's place (§4.2). */
  replaced: 4409,
  /** The peer's HELLO or WELCOME names another TUNNEL_PROTOCOL. */
  protocol: 4426,
} as const

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
/** A sender may be this far past what its peer has ACKed: per stream by its lane, and per machine in all (§4.4). */
export const TUNNEL_WINDOW = { interactive: 1024 * 1024, council: 512 * 1024, machine: 16 * 1024 * 1024 } as const
/** A frame goes to the socket only while it buffers at most this; the rest waits in the streams' queues, where the lanes still apply. */
export const TUNNEL_SEND_LOWAT = 64 * 1024
/** A receiver ACKs this often, or after this many bytes, as its local socket drains. */
export const TUNNEL_ACK_MS = 50
export const TUNNEL_ACK_BYTES = 64 * 1024
/** Streams one tunnel holds at once. */
export const TUNNEL_STREAMS_MAX = 512
/** The highest stream number: u32. Home numbers its streams upwards from 1, never back. */
export const TUNNEL_STREAM_MAX = 0xffff_ffff

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
