/**
 * The tunnel's frames (shared/remote-tunnel.ts, docs/architecture/remote-classes.md
 * §4.3): every kind round-trips, the header is what both ends read, and the
 * codec refuses what neither end may send or read.
 *
 * What is checked is what breaks on the one socket every class of a machine
 * shares. A decoder that took an OPEN from the agent would let a machine open
 * streams into home; one that took a lane it does not know would queue bytes
 * nowhere; one that read past a payload's cap would let one peer make the
 * other hold megabytes per frame. A greeting's list of streams to resume read
 * loosely (a stream twice, a count that is no count) would send a stream
 * again from bytes it never had. And an encoder that wrote a frame its peer
 * refuses closes the tunnel of every class on the machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TUNNEL_ACK_BYTES,
  TUNNEL_ACK_MS,
  TUNNEL_CLOSE,
  TUNNEL_DEAD_MS,
  TUNNEL_FIN,
  TUNNEL_FRAME_MAX,
  TUNNEL_GREETING_MAX,
  TUNNEL_HEADER_BYTES,
  TUNNEL_JSON_MAX,
  TUNNEL_KINDS,
  TUNNEL_LANE,
  TUNNEL_MESSAGE_MAX,
  TUNNEL_PATH,
  TUNNEL_PING_MS,
  TUNNEL_PROTOCOL,
  TUNNEL_PROTOCOL_HEADER,
  TUNNEL_RESUME_LIST_MAX,
  TUNNEL_RESUME_MS,
  TUNNEL_RETAIN_BYTES,
  TUNNEL_SEND_LOWAT,
  TUNNEL_SENDERS,
  TUNNEL_STREAMS_MAX,
  TUNNEL_STREAM_MAX,
  TUNNEL_UPGRADES,
  TUNNEL_WINDOW,
  decodeTunnelFrame,
  encodeTunnelFrame,
  tunnelKindByte,
  tunnelLaneOf,
  tunnelWindow,
  type TunnelFrame,
  type TunnelKind,
  type TunnelSide,
} from '../shared/remote-tunnel.js'
import { REMOTE_PROTOCOL, RemoteProtocolError } from '../shared/remote-runner.js'
import { CLASS_TUNNEL_STUCK_MS } from '../shared/remote-kernels.js'

/* ---------------------------------------------------------------- fixtures */

const BUILD = 'b'.repeat(64)
const SESSION = 'a1'.repeat(16)
const KEY = 'seminar_1:room'

function refused(run: () => unknown, message: RegExp = /./, code: RemoteProtocolError['code'] = 'invalid'): void {
  assert.throws(run, (error: unknown) => error instanceof RemoteProtocolError && error.code === code && message.test(error.message), String(message))
}

/** A frame's bytes with one header byte, or the payload, set by hand: what an encoder of ours would never write. */
function raw(kind: number, flags: number, lane: number, stream: number, offset: number, payload: Uint8Array = new Uint8Array(0), reserved = 0): Uint8Array {
  const bytes = new Uint8Array(TUNNEL_HEADER_BYTES + payload.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, kind)
  view.setUint8(1, flags)
  view.setUint8(2, lane)
  view.setUint8(3, reserved)
  view.setUint32(4, stream)
  view.setUint32(8, Math.floor(offset / 2 ** 32))
  view.setUint32(12, offset % 2 ** 32)
  bytes.set(payload, TUNNEL_HEADER_BYTES)
  return bytes
}

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
const byte = (kind: TunnelKind): number => tunnelKindByte(kind)

/** Every kind once, as its sender sends it. */
const FRAMES: Array<{ frame: TunnelFrame; from: TunnelSide }> = [
  { frame: { kind: 'HELLO', hello: { protocol: 1, build: BUILD, session: SESSION } }, from: 'agent' },
  // After a cut: the streams the agent kept, and home's answer of those it resumes.
  { frame: { kind: 'HELLO', hello: { protocol: 1, build: BUILD, session: SESSION, resume: [{ stream: 1, rx: 0 }, { stream: TUNNEL_STREAM_MAX, rx: Number.MAX_SAFE_INTEGER, fin: true }] } }, from: 'agent' },
  { frame: { kind: 'WELCOME', welcome: { protocol: 1, build: 'dev', session: 'f'.repeat(32) } }, from: 'home' },
  { frame: { kind: 'WELCOME', welcome: { protocol: 1, build: 'dev', session: 'f'.repeat(32), resumed: true, streams: [{ stream: 7, rx: 12_345, fin: true }] } }, from: 'home' },
  { frame: { kind: 'WELCOME', welcome: { protocol: 1, build: 'dev', session: 'f'.repeat(32), resumed: true, streams: [] } }, from: 'home' },
  { frame: { kind: 'OPEN', stream: 1, lane: 1, open: { key: KEY, gen: 3 } }, from: 'home' },
  { frame: { kind: 'OPEN', stream: TUNNEL_STREAM_MAX, lane: 2, open: { key: 'seminar_1:council', gen: Number.MAX_SAFE_INTEGER } }, from: 'home' },
  { frame: { kind: 'OPENED', stream: 1, lane: 1 }, from: 'agent' },
  { frame: { kind: 'REFUSED', stream: 2, lane: 1, refused: { code: 'stale' } }, from: 'agent' },
  { frame: { kind: 'REFUSED', stream: 3, lane: 2, refused: { code: 'gone' } }, from: 'agent' },
  { frame: { kind: 'REFUSED', stream: 4, lane: 1, refused: { code: 'starting' } }, from: 'agent' },
  { frame: { kind: 'DATA', stream: 1, lane: 1, offset: 0, payload: new Uint8Array([1, 2, 3]), fin: false }, from: 'home' },
  { frame: { kind: 'DATA', stream: 1, lane: 1, offset: 2 ** 40 + 7, payload: new Uint8Array(TUNNEL_FRAME_MAX).fill(9), fin: false }, from: 'agent' },
  { frame: { kind: 'DATA', stream: 9, lane: 2, offset: Number.MAX_SAFE_INTEGER, payload: new Uint8Array([7]), fin: true }, from: 'agent' },
  // An empty DATA says one thing: the stream ends here.
  { frame: { kind: 'DATA', stream: 9, lane: 2, offset: 12, payload: new Uint8Array(0), fin: true }, from: 'home' },
  { frame: { kind: 'ACK', stream: 1, lane: 1, offset: 65_536 }, from: 'home' },
  { frame: { kind: 'ACK', stream: 1, lane: 1, offset: 0 }, from: 'agent' },
  // The last ACK of a stream: every byte, and the end after them.
  { frame: { kind: 'ACK', stream: 3, lane: 2, offset: 4096, fin: true }, from: 'agent' },
  { frame: { kind: 'END', stream: 1, lane: 1, offset: 1_234_567 }, from: 'agent' },
  { frame: { kind: 'RESET', stream: 5, lane: 2 }, from: 'home' },
  { frame: { kind: 'RESET', stream: 5, lane: 1 }, from: 'agent' },
  { frame: { kind: 'PING', id: 0 }, from: 'home' },
  { frame: { kind: 'PING', id: Number.MAX_SAFE_INTEGER }, from: 'agent' },
  { frame: { kind: 'PONG', id: 41 }, from: 'home' },
]

/* ------------------------------------------------------------------- frames */

test('every kind round-trips through the codec as its sender sends it', () => {
  assert.deepEqual(new Set(FRAMES.map(({ frame }) => frame.kind)), new Set(TUNNEL_KINDS))
  for (const { frame, from } of FRAMES) {
    const bytes = encodeTunnelFrame(frame)
    assert.ok(bytes.byteLength <= TUNNEL_HEADER_BYTES + TUNNEL_FRAME_MAX && bytes.byteLength <= TUNNEL_MESSAGE_MAX, frame.kind)
    const read = decodeTunnelFrame(bytes, from)
    assert.deepEqual(read, frame, `${frame.kind} from the ${from}`)
    // The same frame read from an ArrayBuffer, as a browser-style socket hands one over.
    assert.deepEqual(decodeTunnelFrame(bytes.slice().buffer, from), frame)
    // Canonical: what was read writes back to the very same bytes.
    assert.deepEqual(encodeTunnelFrame(read), bytes)
  }
})

test('the header is sixteen bytes in network order: kind, flags, lane, reserved, stream, offset', () => {
  const bytes = encodeTunnelFrame({ kind: 'DATA', stream: 0x01020304, lane: 2, offset: 0x0a0b0c0d0e0f, payload: new Uint8Array([0xee]), fin: true })
  assert.deepEqual([...bytes], [
    byte('DATA'), TUNNEL_FIN, 2, 0,
    0x01, 0x02, 0x03, 0x04,
    0x00, 0x00, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0xee,
  ])
  // Kinds count from one, in TUNNEL_KINDS's order: a zeroed header is no frame.
  assert.deepEqual(TUNNEL_KINDS.map(byte), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.deepEqual([...encodeTunnelFrame({ kind: 'PING', id: 1 })], [byte('PING'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
  // JSON payloads are UTF-8 JSON of the contract's keys, in its order.
  const hello = encodeTunnelFrame({ kind: 'HELLO', hello: { protocol: 1, build: BUILD, session: SESSION } })
  assert.equal(new TextDecoder().decode(hello.subarray(TUNNEL_HEADER_BYTES)), JSON.stringify({ protocol: 1, build: BUILD, session: SESSION }))
})

test('a frame read from a slice of a pooled buffer is read at its own offset', () => {
  // ws hands over Buffers that are views into a larger pool: the header is at byteOffset, not at 0.
  const frame: TunnelFrame = { kind: 'DATA', stream: 77, lane: 1, offset: 1000, payload: new Uint8Array([5, 6, 7, 8]), fin: false }
  const bytes = encodeTunnelFrame(frame)
  const pool = Buffer.alloc(bytes.byteLength + 13, 0xff)
  pool.set(bytes, 13)
  const slice = pool.subarray(13)
  const read = decodeTunnelFrame(slice, 'agent')
  assert.ok(read.kind === 'DATA')
  assert.deepEqual({ ...read, payload: [...read.payload] }, { ...frame, payload: [5, 6, 7, 8] })
  // The payload is a view of the message, not a copy.
  assert.equal(read.payload.buffer, pool.buffer)
  assert.equal(read.payload.byteOffset, slice.byteOffset + TUNNEL_HEADER_BYTES)
})

/* ----------------------------------------------------------------- refusals */

test('unknown kinds are refused', () => {
  for (const kind of [0, TUNNEL_KINDS.length + 1, 12, 127, 255]) {
    refused(() => decodeTunnelFrame(raw(kind, 0, 0, 0, 0), 'home'), /Unknown tunnel frame kind/)
    refused(() => decodeTunnelFrame(raw(kind, 0, 1, 1, 0), 'agent'), /Unknown tunnel frame kind/)
  }
  refused(() => encodeTunnelFrame({ kind: 'CLOSE' } as unknown as TunnelFrame), /Unknown tunnel frame kind/)
  refused(() => encodeTunnelFrame(null as unknown as TunnelFrame), /Unknown tunnel frame kind/)
})

test('oversized payloads are refused as too large, whichever end finds them', () => {
  const big = new Uint8Array(TUNNEL_FRAME_MAX + 1)
  refused(() => encodeTunnelFrame({ kind: 'DATA', stream: 1, lane: 1, offset: 0, payload: big, fin: false }), /over its cap/, 'too_large')
  refused(() => decodeTunnelFrame(raw(byte('DATA'), 0, 1, 1, 0, big), 'home'), /over its cap/, 'too_large')
  // Anything past the largest frame is refused before its header is read.
  refused(() => decodeTunnelFrame(new Uint8Array(TUNNEL_HEADER_BYTES + TUNNEL_FRAME_MAX + 1), 'home'), /over its cap/, 'too_large')
  // A greeting has a whole frame, for its list of streams to resume; an OPEN its own, far smaller cap.
  assert.equal(TUNNEL_GREETING_MAX, TUNNEL_FRAME_MAX)
  const padded = json({ protocol: 1, build: BUILD, session: SESSION, pad: 'x'.repeat(TUNNEL_GREETING_MAX) })
  refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, padded), 'agent'), /over its cap/, 'too_large')
  refused(() => decodeTunnelFrame(raw(byte('OPEN'), 0, 1, 1, 0, json({ key: KEY, gen: 1, pad: 'x'.repeat(TUNNEL_JSON_MAX) })), 'home'), /over its cap/, 'too_large')
  refused(() => decodeTunnelFrame(raw(byte('REFUSED'), 0, 1, 1, 0, json({ code: 'gone', pad: 'x'.repeat(TUNNEL_JSON_MAX) })), 'agent'), /over its cap/, 'too_large')
  // A greeting past an OPEN's cap is still a greeting: the list of a machine with many streams.
  const resume = Array.from({ length: TUNNEL_RESUME_LIST_MAX }, (_, i) => ({ stream: TUNNEL_STREAM_MAX - i, rx: Number.MAX_SAFE_INTEGER - i, fin: true as const }))
  const long = json({ protocol: 1, build: BUILD, session: SESSION, resume })
  assert.ok(long.byteLength > TUNNEL_JSON_MAX && long.byteLength <= TUNNEL_GREETING_MAX, `${long.byteLength} B`)
  assert.equal((decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, long), 'agent') as Extract<TunnelFrame, { kind: 'HELLO' }>).hello.resume?.length, TUNNEL_RESUME_LIST_MAX)
  // At its caps a payload is still a frame.
  assert.doesNotThrow(() => decodeTunnelFrame(raw(byte('DATA'), 0, 1, 1, 0, new Uint8Array(TUNNEL_FRAME_MAX)), 'home'))
  const atCap = json({ key: KEY, gen: 1, pad: '' })
  const filled = json({ key: KEY, gen: 1, pad: 'x'.repeat(TUNNEL_JSON_MAX - atCap.byteLength) })
  assert.equal(filled.byteLength, TUNNEL_JSON_MAX)
  assert.deepEqual(decodeTunnelFrame(raw(byte('OPEN'), 0, 1, 1, 0, filled), 'home'), { kind: 'OPEN', stream: 1, lane: 1, open: { key: KEY, gen: 1 } })
  // Frames with nothing to carry carry nothing.
  for (const kind of ['OPENED', 'ACK', 'END', 'RESET'] as const) refused(() => decodeTunnelFrame(raw(byte(kind), 0, 1, 1, 0, new Uint8Array([1])), 'agent'), /payload/)
  for (const kind of ['PING', 'PONG'] as const) refused(() => decodeTunnelFrame(raw(byte(kind), 0, 0, 0, 0, new Uint8Array([1])), 'agent'), /payload/)
  for (const kind of ['HELLO', 'REFUSED'] as const) refused(() => decodeTunnelFrame(raw(byte(kind), 0, kind === 'HELLO' ? 0 : 1, kind === 'HELLO' ? 0 : 1, 0), 'agent'), /without its payload/)
  refused(() => decodeTunnelFrame(new Uint8Array(TUNNEL_HEADER_BYTES - 1), 'home'), /shorter than its header/)
})

test('bad lanes are refused, and a stream\'s frames never ride the control lane', () => {
  for (const lane of [3, 4, 128, 255]) {
    refused(() => decodeTunnelFrame(raw(byte('DATA'), 0, lane, 1, 0, new Uint8Array([1])), 'home'), /lane/)
    refused(() => decodeTunnelFrame(raw(byte('ACK'), 0, lane, 1, 0), 'agent'), /lane/)
    refused(() => encodeTunnelFrame({ kind: 'DATA', stream: 1, lane: lane as 1, offset: 0, payload: new Uint8Array([1]), fin: false }), /lane/)
  }
  // A stream's bytes are interactive or council, never control.
  for (const kind of ['OPENED', 'ACK', 'END', 'RESET'] as const) refused(() => decodeTunnelFrame(raw(byte(kind), 0, 0, 1, 0), kind === 'OPENED' ? 'agent' : 'home'), /lane/)
  refused(() => decodeTunnelFrame(raw(byte('DATA'), 0, 0, 1, 0, new Uint8Array([1])), 'home'), /lane/)
  refused(() => decodeTunnelFrame(raw(byte('OPEN'), 0, 0, 1, 0, json({ key: KEY, gen: 1 })), 'home'), /lane/)
  // The tunnel's own frames ride the control lane of stream 0, and nothing else does.
  refused(() => decodeTunnelFrame(raw(byte('PING'), 0, 1, 0, 0), 'home'), /lane/)
  refused(() => decodeTunnelFrame(raw(byte('PONG'), 0, 0, 3, 0), 'home'), /stream/)
  refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 2, 0, 0, json({ protocol: 1, build: BUILD, session: SESSION })), 'agent'), /lane/)
  // Stream 0 is the tunnel itself: no stream is numbered so.
  refused(() => decodeTunnelFrame(raw(byte('DATA'), 0, 1, 0, 0, new Uint8Array([1])), 'agent'), /stream/)
  refused(() => encodeTunnelFrame({ kind: 'RESET', stream: 0, lane: 1 }), /stream/)
  refused(() => encodeTunnelFrame({ kind: 'ACK', stream: 1.5, lane: 1, offset: 0 }), /stream/)
  refused(() => encodeTunnelFrame({ kind: 'ACK', stream: TUNNEL_STREAM_MAX + 1, lane: 1, offset: 0 }), /stream/)
  // How the role of a placement maps to its lane, and each lane to its window.
  assert.equal(tunnelLaneOf('room'), TUNNEL_LANE.interactive)
  assert.equal(tunnelLaneOf('own'), TUNNEL_LANE.interactive)
  assert.equal(tunnelLaneOf('council'), TUNNEL_LANE.council)
  assert.equal(tunnelWindow(TUNNEL_LANE.interactive), TUNNEL_WINDOW.interactive)
  assert.equal(tunnelWindow(TUNNEL_LANE.council), TUNNEL_WINDOW.council)
})

test('an OPEN rides the lane of its placement\'s role, whichever end checks it', () => {
  // A council stream on the interactive lane would put attempts' bytes ahead of the room's keystrokes (D12), and a room's behind them.
  for (const [key, lane] of [['seminar_1:council', 1], ['seminar_1:room', 2], ['seminar_1:own', 2]] as const) {
    refused(() => encodeTunnelFrame({ kind: 'OPEN', stream: 1, lane, open: { key, gen: 1 } }), /lane/)
    refused(() => decodeTunnelFrame(raw(byte('OPEN'), 0, lane, 1, 0, json({ key, gen: 1 })), 'home'), /lane/)
  }
  for (const role of ['room', 'own', 'council'] as const) {
    const frame: TunnelFrame = { kind: 'OPEN', stream: 7, lane: tunnelLaneOf(role), open: { key: `seminar_1:${role}`, gen: 2 } }
    assert.deepEqual(decodeTunnelFrame(encodeTunnelFrame(frame), 'home'), frame)
  }
})

test('flags, the reserved byte and the offset hold only what they may', () => {
  // FIN belongs to DATA (its last bytes) and to ACK (the end came too); every other bit is unused.
  assert.deepEqual(decodeTunnelFrame(raw(byte('ACK'), TUNNEL_FIN, 1, 1, 10), 'home'), { kind: 'ACK', stream: 1, lane: 1, offset: 10, fin: true })
  refused(() => decodeTunnelFrame(raw(byte('END'), TUNNEL_FIN, 1, 1, 10), 'home'), /flags/)
  for (const kind of ['OPENED', 'RESET'] as const) refused(() => decodeTunnelFrame(raw(byte(kind), TUNNEL_FIN, 1, 1, 0), 'agent'), /flags/)
  for (const flags of [0x02, 0x80, 0x03, 0xff]) {
    refused(() => decodeTunnelFrame(raw(byte('DATA'), flags, 1, 1, 0, new Uint8Array([1])), 'home'), /flags/)
    refused(() => decodeTunnelFrame(raw(byte('ACK'), flags, 1, 1, 0), 'home'), /flags/)
  }
  refused(() => encodeTunnelFrame({ kind: 'ACK', stream: 1, lane: 1, offset: 0, fin: false as unknown as true }), /ACK/)
  refused(() => decodeTunnelFrame(raw(byte('DATA'), 0, 1, 1, 0, new Uint8Array([1]), 1), 'home'), /reserved/)
  // An empty DATA without FIN says nothing at all.
  refused(() => decodeTunnelFrame(raw(byte('DATA'), 0, 1, 1, 0), 'home'), /Empty tunnel data/)
  refused(() => encodeTunnelFrame({ kind: 'DATA', stream: 1, lane: 1, offset: 0, payload: new Uint8Array(0), fin: false }), /Empty tunnel data/)
  // An offset only where one says something.
  refused(() => decodeTunnelFrame(raw(byte('OPENED'), 0, 1, 1, 5), 'agent'), /offset/)
  refused(() => decodeTunnelFrame(raw(byte('RESET'), 0, 1, 1, 1), 'agent'), /offset/)
  refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 1, json({ protocol: 1, build: BUILD, session: SESSION })), 'agent'), /offset/)
  // Past 2^53 a number stops counting bytes one by one.
  const past = raw(byte('ACK'), 0, 1, 1, 0)
  new DataView(past.buffer).setUint32(8, 0x0020_0000)
  refused(() => decodeTunnelFrame(past, 'home'), /offset/)
  refused(() => encodeTunnelFrame({ kind: 'ACK', stream: 1, lane: 1, offset: 2 ** 53 }), /offset/)
  refused(() => encodeTunnelFrame({ kind: 'ACK', stream: 1, lane: 1, offset: -1 }), /offset/)
  refused(() => encodeTunnelFrame({ kind: 'PING', id: 0.5 }), /offset/)
  refused(() => encodeTunnelFrame({ kind: 'DATA', stream: 1, lane: 1, offset: 0, payload: new Uint8Array([1]), fin: 'yes' as unknown as boolean }), /data/)
  refused(() => encodeTunnelFrame({ kind: 'DATA', stream: 1, lane: 1, offset: 0, payload: [1, 2] as unknown as Uint8Array, fin: false }), /data/)
})

test('each side sends only its own kinds: an OPEN from the agent is refused', () => {
  const sent: Record<TunnelKind, Uint8Array> = {
    HELLO: encodeTunnelFrame({ kind: 'HELLO', hello: { protocol: 1, build: BUILD, session: SESSION } }),
    WELCOME: encodeTunnelFrame({ kind: 'WELCOME', welcome: { protocol: 1, build: BUILD, session: SESSION } }),
    OPEN: encodeTunnelFrame({ kind: 'OPEN', stream: 1, lane: 1, open: { key: KEY, gen: 1 } }),
    OPENED: encodeTunnelFrame({ kind: 'OPENED', stream: 1, lane: 1 }),
    REFUSED: encodeTunnelFrame({ kind: 'REFUSED', stream: 1, lane: 1, refused: { code: 'gone' } }),
    DATA: encodeTunnelFrame({ kind: 'DATA', stream: 1, lane: 1, offset: 0, payload: new Uint8Array([1]), fin: false }),
    ACK: encodeTunnelFrame({ kind: 'ACK', stream: 1, lane: 1, offset: 1 }),
    END: encodeTunnelFrame({ kind: 'END', stream: 1, lane: 1, offset: 1 }),
    RESET: encodeTunnelFrame({ kind: 'RESET', stream: 1, lane: 1 }),
    PING: encodeTunnelFrame({ kind: 'PING', id: 1 }),
    PONG: encodeTunnelFrame({ kind: 'PONG', id: 1 }),
  }
  assert.deepEqual(TUNNEL_SENDERS, {
    HELLO: 'agent', WELCOME: 'home', OPEN: 'home', OPENED: 'agent', REFUSED: 'agent',
    DATA: 'both', ACK: 'both', END: 'both', RESET: 'both', PING: 'both', PONG: 'both',
  })
  for (const kind of TUNNEL_KINDS) {
    for (const from of ['home', 'agent'] as const) {
      const may = TUNNEL_SENDERS[kind] === 'both' || TUNNEL_SENDERS[kind] === from
      if (may) assert.equal(decodeTunnelFrame(sent[kind], from).kind, kind, `${kind} from the ${from}`)
      else refused(() => decodeTunnelFrame(sent[kind], from), new RegExp(`Unexpected ${kind} from the ${from}`))
    }
  }
  refused(() => decodeTunnelFrame(sent.PING, 'relay' as TunnelSide), /Invalid tunnel message/)
  refused(() => decodeTunnelFrame('frame' as unknown as Uint8Array, 'home'), /Invalid tunnel message/)
})

test('JSON payloads: strict where home reads the agent, tolerant where the agent reads home, the protocol first', () => {
  const hello = { protocol: 1, build: BUILD, session: SESSION }
  // Home refuses a key it does not know in the agent's HELLO, its resume list and its REFUSED.
  refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, json({ ...hello, resumed: true })), 'agent'), /Unexpected key "resumed" in HELLO/)
  refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, json({ ...hello, resume: [{ stream: 1, rx: 0, lane: 1 }] })), 'agent'), /Unexpected key "lane" in HELLO resume/)
  refused(() => decodeTunnelFrame(raw(byte('REFUSED'), 0, 1, 1, 0, json({ code: 'gone', why: 'x' })), 'agent'), /Unexpected key "why" in REFUSED/)
  // A resume list holds each stream once, by its number, with what was received of it and FIN only as true, and no more than one greeting carries.
  const resumeEntry = (entry: unknown) => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, json({ ...hello, resume: [entry] })), 'agent')
  for (const bad of [{ stream: 0, rx: 0 }, { stream: 2 ** 32, rx: 0 }, { stream: 1, rx: -1 }, { stream: 1, rx: 0.5 }, { stream: 1 }, { stream: 1, rx: 0, fin: false }, { stream: 1, rx: 0, fin: 1 }, 7]) {
    refused(() => resumeEntry(bad), /Invalid HELLO resume/)
  }
  refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, json({ ...hello, resume: [{ stream: 3, rx: 0 }, { stream: 3, rx: 9 }] })), 'agent'), /Invalid HELLO resume/)
  refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, json({ ...hello, resume: { stream: 3, rx: 0 } })), 'agent'), /Invalid HELLO resume list/)
  const many = Array.from({ length: TUNNEL_RESUME_LIST_MAX + 1 }, (_, i) => ({ stream: i + 1, rx: 0 }))
  refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, json({ ...hello, resume: many })), 'agent'), /Invalid HELLO resume list/)
  refused(() => encodeTunnelFrame({ kind: 'HELLO', hello: { ...hello, protocol: 1, resume: many } }), /Invalid HELLO resume list/)
  // The agent drops what it does not know in home's WELCOME and OPEN, and keeps nothing of it.
  const welcome = decodeTunnelFrame(raw(byte('WELCOME'), 0, 0, 0, 0, json({ ...hello, sealed: true, __proto__: { polluted: true } })), 'home')
  assert.deepEqual(welcome, { kind: 'WELCOME', welcome: hello })
  const resumed = decodeTunnelFrame(raw(byte('WELCOME'), 0, 0, 0, 0, json({ ...hello, resumed: true, streams: [{ stream: 2, rx: 10, fin: false, lane: 2 }] })), 'home')
  assert.deepEqual(resumed, { kind: 'WELCOME', welcome: { ...hello, resumed: true, streams: [{ stream: 2, rx: 10 }] } }, 'a false FIN says none, an unknown key goes')
  // Tolerant both ways round: `resumed: false` is no resume, a list without `resumed` is no list, `resumed` without a list resumes none.
  assert.deepEqual(decodeTunnelFrame(raw(byte('WELCOME'), 0, 0, 0, 0, json({ ...hello, resumed: false, streams: [{ stream: 2, rx: 10 }] })), 'home'), { kind: 'WELCOME', welcome: hello })
  assert.deepEqual(decodeTunnelFrame(raw(byte('WELCOME'), 0, 0, 0, 0, json({ ...hello, resumed: true })), 'home'), { kind: 'WELCOME', welcome: { ...hello, resumed: true, streams: [] } })
  refused(() => decodeTunnelFrame(raw(byte('WELCOME'), 0, 0, 0, 0, json({ ...hello, resumed: 'yes' })), 'home'), /Invalid WELCOME/)
  refused(() => decodeTunnelFrame(raw(byte('WELCOME'), 0, 0, 0, 0, json({ ...hello, resumed: true, streams: [{ stream: 1, rx: 'x' }] })), 'home'), /Invalid WELCOME resume/)
  const open = decodeTunnelFrame(raw(byte('OPEN'), 0, 2, 4, 0, json({ key: 'seminar_1:council', gen: 2, host: '10.0.0.1', port: 22 })), 'home')
  assert.deepEqual(open, { kind: 'OPEN', stream: 4, lane: 2, open: { key: 'seminar_1:council', gen: 2 } })
  assert.equal(JSON.stringify(open).includes('10.0.0.1'), false, 'home never names a host or a port')
  // Another tunnel protocol is told so, before its keys are looked at, both ways.
  for (const protocol of [2, 0, '1', undefined]) {
    refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, json({ ...hello, protocol, resume: [] })), 'agent'), /protocol/, 'protocol')
    refused(() => decodeTunnelFrame(raw(byte('WELCOME'), 0, 0, 0, 0, json({ ...hello, protocol })), 'home'), /protocol/, 'protocol')
  }
  refused(() => encodeTunnelFrame({ kind: 'HELLO', hello: { ...hello, protocol: 2 as 1 } }), /protocol/, 'protocol')
  // Every field in its pattern.
  for (const bad of [{ ...hello, build: 'b'.repeat(63) }, { ...hello, session: 'A1'.repeat(16) }, { ...hello, session: 'a'.repeat(31) }, { protocol: 1, build: BUILD }]) {
    refused(() => decodeTunnelFrame(raw(byte('HELLO'), 0, 0, 0, 0, json(bad)), 'agent'), /Invalid HELLO/)
    refused(() => decodeTunnelFrame(raw(byte('WELCOME'), 0, 0, 0, 0, json(bad)), 'home'), /Invalid WELCOME/)
  }
  for (const bad of [{ key: 'seminar_1:lecture', gen: 1 }, { key: '../x:room', gen: 1 }, { key: KEY, gen: 0 }, { key: KEY, gen: 1.5 }, { key: KEY, gen: '1' }, { key: KEY }]) {
    refused(() => decodeTunnelFrame(raw(byte('OPEN'), 0, 1, 1, 0, json(bad)), 'home'), /Invalid OPEN/)
  }
  for (const code of ['busy', '', 1, null]) refused(() => decodeTunnelFrame(raw(byte('REFUSED'), 0, 1, 1, 0, json({ code })), 'agent'), /Invalid REFUSED/)
  // What is not JSON of an object is no payload.
  for (const payload of [new Uint8Array([0xff, 0xfe]), new TextEncoder().encode('{"key":'), json([KEY, 1]), json('x'), json(null)]) {
    refused(() => decodeTunnelFrame(raw(byte('OPEN'), 0, 1, 1, 0, payload), 'home'), /OPEN|JSON/)
  }
  // The encoder sends the contract's keys and no other, checked as strictly as home checks a HELLO: both of `resumed` and its list, or neither.
  refused(() => encodeTunnelFrame({ kind: 'WELCOME', welcome: { ...hello, sealed: true } as never }), /Unexpected key "sealed" in WELCOME/)
  refused(() => encodeTunnelFrame({ kind: 'WELCOME', welcome: { ...hello, resumed: true } as never }), /Invalid WELCOME resume list/)
  refused(() => encodeTunnelFrame({ kind: 'WELCOME', welcome: { ...hello, streams: [] } as never }), /Invalid WELCOME: resumed/)
  refused(() => encodeTunnelFrame({ kind: 'WELCOME', welcome: { ...hello, resumed: false, streams: [] } as never }), /Invalid WELCOME: resumed/)
  refused(() => encodeTunnelFrame({ kind: 'OPEN', stream: 1, lane: 1, open: { key: KEY, gen: 1, port: 22 } as never }), /Unexpected key "port" in OPEN/)
  refused(() => encodeTunnelFrame({ kind: 'REFUSED', stream: 1, lane: 1, refused: { code: 'busy' as 'gone' } }), /Invalid REFUSED/)
})

test('a frame either decodes into one that writes back to itself, or is refused as a protocol error', () => {
  let seed = 20261016
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const valid = FRAMES.map(({ frame, from }) => ({ bytes: encodeTunnelFrame(frame), from }))
  let read = 0
  for (let round = 0; round < 5000; round++) {
    const { bytes, from } = valid[Math.floor(random() * valid.length)]!
    const mutated = bytes.slice(0, random() < 0.1 ? Math.floor(random() * bytes.byteLength) : bytes.byteLength)
    for (let flips = 1 + Math.floor(random() * 3); flips > 0 && mutated.byteLength > 0; flips--) {
      // Mostly the header, where a bit means the most.
      const at = random() < 0.8 ? Math.floor(random() * Math.min(TUNNEL_HEADER_BYTES, mutated.byteLength)) : Math.floor(random() * mutated.byteLength)
      mutated[at] = random() < 0.5 ? Math.floor(random() * 256) : mutated[at]! ^ (1 << Math.floor(random() * 8))
    }
    const side: TunnelSide = random() < 0.8 ? from : from === 'home' ? 'agent' : 'home'
    let frame: TunnelFrame
    try {
      frame = decodeTunnelFrame(mutated, side)
    } catch (error) {
      assert.ok(error instanceof RemoteProtocolError, `${String(error)} for ${[...mutated.subarray(0, 16)]}`)
      continue
    }
    read++
    const again = encodeTunnelFrame(frame)
    if (frame.kind === 'HELLO' || frame.kind === 'WELCOME' || frame.kind === 'OPEN' || frame.kind === 'REFUSED') {
      // JSON is canonical once written by us: the frame it stands for is the same one.
      assert.deepEqual(decodeTunnelFrame(again, side), frame)
    } else {
      assert.deepEqual(again, mutated, `${frame.kind} written back`)
    }
  }
  assert.ok(read > 500, `only ${read} of the mutated frames decoded: the property says little`)
})

/* -------------------------------------------------------------- the numbers */

test('one tunnel protocol and its header, and the numbers of §15', () => {
  assert.equal(TUNNEL_PROTOCOL, 1)
  assert.equal(TUNNEL_PROTOCOL_HEADER, 'X-Colloq-Tunnel-Protocol')
  assert.equal(TUNNEL_PATH, 'tunnel')
  // The tunnel's version is its own: the sync's stays where it was.
  assert.equal(REMOTE_PROTOCOL, 1)
  assert.equal(TUNNEL_PING_MS, 10_000)
  assert.equal(TUNNEL_DEAD_MS, 25_000)
  assert.equal(TUNNEL_FRAME_MAX, 16 * 1024)
  assert.equal(TUNNEL_JSON_MAX, 4 * 1024)
  assert.equal(TUNNEL_HEADER_BYTES, 16)
  assert.deepEqual(TUNNEL_WINDOW, { interactive: 4 * 1024 * 1024, council: 1024 * 1024, machine: 16 * 1024 * 1024 })
  assert.equal(TUNNEL_SEND_LOWAT, 64 * 1024)
  assert.equal(TUNNEL_ACK_MS, 50)
  assert.equal(TUNNEL_ACK_BYTES, 64 * 1024)
  assert.equal(TUNNEL_STREAMS_MAX, 512)
  assert.deepEqual(TUNNEL_UPGRADES, { count: 12, windowMs: 60_000 })
  // §4.8 and §15: what is kept across a cut, and for how long.
  assert.equal(TUNNEL_RESUME_MS, 120_000)
  assert.equal(TUNNEL_RETAIN_BYTES, 4 * 1024 * 1024)
  assert.equal(TUNNEL_RESUME_LIST_MAX, 256)
  assert.equal(TUNNEL_CLOSE.replaced, 4409)
  assert.equal(new Set(Object.values(TUNNEL_CLOSE)).size, Object.values(TUNNEL_CLOSE).length, 'one code, one meaning')
  for (const code of Object.values(TUNNEL_CLOSE)) assert.ok(code >= 4000 && code <= 4999, 'an application close code')
})

test('the clocks and sizes agree with each other and with the relay', () => {
  // The relay cuts an idle connection at 30 s: two pings fit in front of it, and a dead link is let go before it.
  assert.ok(2 * TUNNEL_PING_MS < 30_000)
  assert.ok(TUNNEL_PING_MS < TUNNEL_DEAD_MS && TUNNEL_DEAD_MS < 30_000)
  // The largest frame fits the WebSocket's maxPayload, and the send buffer holds a few of them.
  assert.ok(TUNNEL_HEADER_BYTES + TUNNEL_FRAME_MAX <= TUNNEL_MESSAGE_MAX)
  assert.ok(TUNNEL_SEND_LOWAT >= TUNNEL_HEADER_BYTES + TUNNEL_FRAME_MAX)
  // A window holds whole frames, and a machine's holds an interactive stream's window several times over (K0 raised it to 4 MiB).
  assert.ok(TUNNEL_WINDOW.council >= 4 * TUNNEL_FRAME_MAX && TUNNEL_WINDOW.council <= TUNNEL_WINDOW.interactive)
  assert.ok(TUNNEL_WINDOW.machine >= 4 * TUNNEL_WINDOW.interactive)
  // An ACK comes before a window runs out.
  assert.ok(TUNNEL_ACK_BYTES < TUNNEL_WINDOW.council)
  assert.ok(TUNNEL_STREAMS_MAX < TUNNEL_STREAM_MAX)
  // Every byte a window lets out is kept until it is ACKed: no stream sends what a cut would make it unable to send again.
  assert.ok(TUNNEL_WINDOW.interactive <= TUNNEL_RETAIN_BYTES && TUNNEL_WINDOW.council <= TUNNEL_RETAIN_BYTES)
  // A resume outlives the dead timer and the agent's slowest retry, and waits no longer than a stuck tunnel does before its classes fail over (§11.1).
  assert.ok(TUNNEL_RESUME_MS > TUNNEL_DEAD_MS + 30_000 && TUNNEL_RESUME_MS <= CLASS_TUNNEL_STUCK_MS)
  // The longest list one greeting may carry, of the widest entries, fits in a frame.
  const widest = encodeTunnelFrame({
    kind: 'WELCOME',
    welcome: {
      protocol: 1, build: 'b'.repeat(64), session: 'a'.repeat(32), resumed: true,
      streams: Array.from({ length: TUNNEL_RESUME_LIST_MAX }, (_, i) => ({ stream: TUNNEL_STREAM_MAX - i, rx: Number.MAX_SAFE_INTEGER - i, fin: true as const })),
    },
  })
  assert.ok(widest.byteLength <= TUNNEL_HEADER_BYTES + TUNNEL_GREETING_MAX && TUNNEL_GREETING_MAX <= TUNNEL_FRAME_MAX, `${widest.byteLength} B`)
})
