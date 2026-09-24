import { authorizeSocket, type SocketCredentials } from '../socket-authorization.js'
import { tr } from '@shared/i18n'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { Awareness } from 'y-protocols/awareness'
import { WebSocket, type RawData } from 'ws'
import type { YCell } from '@shared/notebook'
import {
  allCellArrays,
  clearStaleExecution,
  createTerminalLine,
  ensureInitialNotebook,
  getCells,
  getChat,
  getMeta,
  getTerminal,
} from '@shared/notebook'
import type { AwarenessUser, GateRule, ParticipantRole } from '@shared/protocol'
import { getRules, getSession, isFinished, renameSession } from '../db.js'
import { seldom, tally } from '../log.js'
import { classify, MAX_SYNC_STEP2_BYTES, permits } from './gate.js'
import { forgetSession, onCarets, rememberDeleted, resetRetyped, settleFresh } from './ops.js'
import { shelveRoomImages } from '../notebook-images.js'
import {
  bindPersistence,
  flushPersistence,
  discardPersistence,
  flushAllPersistence,
  invalidateSnapshot,
} from './persistence.js'
import {
  RESTORE_ORIGIN,
  beginHistory,
  discardBurst,
  flushAllHistory,
  forgetHistory,
  record,
} from './history.js'
import { flushAllFiles, forgetFiles } from './files.js'
import { watchBooks } from './books.js'
import { forgetUndo } from '../ai/agent.js'
import { abortSession } from '../ai/index.js'
import { appendActivity } from '../activity.js'

/**
 * The origin for a write the server makes on someone's behalf.
 *
 * `onBehalfOf(id)` in a transaction — and the version in the history is signed
 * by that person, not by "the room". Only code on the server can compose such a
 * string: an update from a client arrives with its socket as the origin.
 */
const BEHALF_PREFIX = 'on-behalf:'

/**
 * Write into the room's document on behalf of a person, not of the server.
 *
 * A nested `doc.transact` joins the outer one, and the origin stays the outer
 * one — so the wrapper works even around code that opens its own transaction
 * (and `acceptPatch` is exactly that).
 */
export function applyOnBehalf(sessionId: string, participantId: string, write: () => void): void {
  const { doc } = getSessionDoc(sessionId)
  doc.transact(write, `${BEHALF_PREFIX}${participantId}`)
}

/**
 * The server side of the collaborative document.
 *
 * This speaks the y-websocket wire protocol (the browser uses the stock
 * `WebsocketProvider`), but it is not a dumb relay: the server holds the
 * authoritative Y.Doc in memory and is a first-class writer. The kernel runtime
 * appends execution output straight into that doc, which is how results reach
 * everyone — including whoever opens the link two minutes later.
 */

/** y-websocket's own frame tags. The numbers are the protocol, not a choice. */
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/*
 * Under the thirty seconds that proxies and load balancers commonly use as an
 * idle timeout. A seminar has long silences — nobody types while the teacher
 * talks — and a socket dropped for being quiet looks to the room like the
 * server going away.
 */
const PING_INTERVAL_MS = 25_000
/** A socket that ignores this many consecutive pings is a closed laptop lid. */
const MAX_MISSED_PONGS = 2

export interface SessionDoc {
  sessionId: string
  doc: Y.Doc
  awareness: Awareness
}

/** Marks a write as the server's own, so its observers do not chase themselves. */
const ORIGIN = 'server'

/**
 * Did this transaction create this cell?
 *
 * That is how Yjs itself asks: a structure that appeared in a transaction has a
 * clock no lower than the one its client stood at before the start. Needed
 * where, of two identical names, the one that arrived must be chosen, not the
 * one that already lived in the notebook.
 */
function madeIn(transaction: Y.Transaction, cell: YCell): boolean {
  const item = cell._item
  if (!item) return false
  return item.id.clock >= (transaction.beforeState.get(item.id.client) ?? 0)
}

/**
 * Cells that have cursors in them right now — by presence.
 *
 * Needed by cell rearrangement: a clone takes away the keystrokes that went
 * into the old `Y.Text` one round trip before the server, and choosing whom to
 * recreate is better done knowing who stands where. It reaches `ops.ts` by
 * registration, not by import, so that module stays free of sockets and the
 * database; a version restore (`history.ts · reorder`) rebuilds the whole sheet
 * with clones and has the right to ask the same.
 */
export function cellsWithCarets(doc: Y.Doc): ReadonlySet<string> {
  const busy = new Set<string>()
  for (const entry of docs.values()) {
    if (entry.doc !== doc) continue
    for (const state of entry.awareness.getStates().values()) {
      const user = (state as { user?: AwarenessUser } | null)?.user
      const id = user?.activeCellId
      if (typeof id === 'string' && id) busy.add(id)
    }
    break
  }
  return busy
}

onCarets(cellsWithCarets)

interface ConnState {
  /**
   * Who is on the other end.
   *
   * The history needs an author for every change, and the update bytes cannot
   * give one: an insertion carries the Yjs client that made it, but a deletion
   * carries the client whose text was deleted — the victim, not the author. The
   * socket knows, because the token said so when it connected.
   */
  participantId: string | null
  /** Awareness clientIDs this socket introduced, so we can retract exactly those. */
  clientIds: Set<number>
  /** How many pings in a row went unanswered; the heartbeat is per room. */
  missedPongs: number
  /**
   * The role the token carried. The document is shared and every field in it is
   * writable by anyone connected — that is what a CRDT is — so this is not an
   * access list. It is here for the one field the interface already promises is
   * the host's: the seminar's name.
   */
  role: ParticipantRole
  /**
   * When this socket opened.
   *
   * The room knows about itself "how many people right now", but not "since
   * when what is going on has been going on": the seminar row remembers only
   * its creation time, and a seminar is created a week before the class and
   * reused for the next one. Because of that the panel said "Running now ·
   * started 6 days ago" about a class that started twenty minutes ago. The
   * class clock is the oldest of the sockets open right now (see liveSince),
   * and the server has no other.
   */
  openedAt: number
  /** Shared across one person's overlapping tabs; survives closing their first tab. */
  presenceStartedAt: number
}

interface DocEntry extends SessionDoc {
  conns: Map<WebSocket, ConnState>
  /** Stop watching the notebooks and release the disk binding, flushing it first. */
  dispose: () => void
  /** Only stop watching notebooks — for seminar deletion, when there is nowhere to write. */
  unwatch: () => void
  /**
   * Frames not yet sent to the room — see `scheduleFlush` and `scheduleFaces`.
   *
   * Edits are coalesced per tick, presence per window (`FACES_WINDOW_MS`), and
   * so they have different queues. A presence frame goes to everyone, the
   * sender included — for why, see `sendAwareness`.
   */
  outbox: {
    updates: Uint8Array[]
    queued: boolean
    faces: Set<number>
    facesTimer: NodeJS.Timeout | null
  }
  /**
   * The answer to a COLD tab — the whole document in one frame, built once.
   *
   * The bytes are the same for every cold tab (`encodeStateAsUpdate` from an
   * empty state vector), and they cost a megabyte of encoding for each one.
   * Five hundred tabs come back within a second after a server restart — that
   * is one and the same snapshot built five hundred times. Reset by any edit of
   * the document.
   */
  coldFrame: Uint8Array | null
  /** The full list of faces for a newcomer — also one for all while nobody moves. */
  welcomeFaces: Uint8Array | null
  /** The whole room's heartbeat: one timer for the sockets, not a timer per socket. */
  pingTimer: NodeJS.Timeout | null
  /** Since when the room has had no sockets at all; 0 means it has some. */
  emptySince: number
  /**
   * How many sockets were closed for lagging since the last log line.
   *
   * A lagging socket is closed, the browser reconnects, lags again — and so on
   * in a circle: in a live room's log this was the same line once a minute,
   * from which one could see neither that it was about DIFFERENT sockets nor
   * how many of them there were. We count and say it as a number.
   */
  lagDrops: number
}

const docs = new Map<string, DocEntry>()

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data)
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
  }
  const buf = data as Buffer
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/**
 * How many bytes may wait to be sent on one socket before it stops being sent
 * cursors — and how many before it is considered hopeless.
 *
 * `ws.send` does not ask whether the network keeps up: it puts the frame into
 * the socket's queue and returns. `plt.imshow` at dpi=200 is a megabyte or two
 * in one update, and with five hundred listeners on a lecture-hall uplink that
 * is a gigabyte the server holds in memory, a copy per socket, while the image
 * crawls to a phone at the edge of the network. Every following keystroke in
 * the room queues up BEHIND the image — for everyone.
 *
 * Hence two lines. Beyond the first, presence frames stop going out: a cursor
 * is the only thing that can be left undelivered without consequences (the
 * next movement will announce the position anew). Beyond the second, the
 * socket is closed: it gets yesterday's room anyway, and the browser will
 * reconnect in a second and rebuild the state in one sync step — cheaper than
 * megabytes in the server's memory.
 */
const AWARENESS_STALL_BYTES = 1024 * 1024
/** How rarely a room complains about lagging sockets. It counts them all the while. */
const LAG_QUIET_MS = 10 * 60_000
const HOPELESS_BYTES = 8 * 1024 * 1024

/**
 * The frame size above which compression does not pay off.
 *
 * `perMessageDeflate` (server/src/index.ts) works PER SOCKET: ws has its own
 * `PerMessageDeflate` per connection, so one two-megabyte output frame is five
 * hundred independent zlib jobs of two megabytes each through a shared limiter
 * of ten threads, that is, seconds of CPU time and five hundred compressed
 * copies in memory for one image.
 *
 * `threshold` in the server settings does not cure this: it is the LOWER bound
 * ("smaller — do not compress"), and raising it means no longer compressing
 * exactly what compression was set up for — the first sync steps of tens of
 * kilobytes. The upper bound lives here, where the frame size is visible.
 *
 * A quarter of a megabyte: text output and a tree of that size compress several
 * times and cost milliseconds, while everything larger is data output (an
 * image, a PDF) in base64, that is, already compressed bytes, from which
 * deflate will win back a quarter of the volume at a much higher price.
 */
const MAX_DEFLATE_BYTES = 256 * 1024

/**
 * A frame carrying the WHOLE document is an exception to the ceiling.
 *
 * The ceiling is written about kernel output: an image in base64 is already
 * compressed, and deflate pays seconds of CPU for it to win a quarter of the
 * volume. The first sync is the opposite — Yjs structures and cell text, that
 * is, the most compressible bytes there are on this wire. Measured in a live
 * class: the answer to a cold tab was 1 065 985 B, the same answer through the
 * server's deflate (level 4, windowBits 13) 360 985 B, three times smaller.
 *
 * Without this mark the ceiling cancelled compression exactly where it pays
 * off: five hundred tabs coming back after a restart are half a gigabyte into
 * the lecture-hall uplink instead of a hundred and eighty megabytes.
 */
function send(
  entry: DocEntry,
  conn: WebSocket,
  message: Uint8Array,
  /**
   * Presence can be skipped; edits cannot, they are the document.
   * `state` is a frame of the whole document or the whole presence: always
   * compress.
   */
  kind: 'sync' | 'state' | 'awareness' = 'sync',
): void {
  if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
    closeConn(entry, conn)
    return
  }
  const waiting = conn.bufferedAmount
  if (waiting > HOPELESS_BYTES) {
    /*
     * The log line is about the CIRCLE, not the socket.
     *
     * The socket is closed here once and never comes back: the browser comes
     * back, and if the room's document does not fit through the channel at
     * all, it comes back every few seconds. In a live room's log this looked
     * like one and the same line once a minute — from which one could read
     * neither that the sockets are different nor how many there are. Hence
     * once every ten minutes and as a number: "the 87th closed" reads as "the
     * room does not get through", not as "the network blinked".
     */
    entry.lagDrops += 1
    if (seldom(`collab-backpressure-${entry.sessionId}`, LAG_QUIET_MS)) {
      const again = entry.lagDrops > 1 ? ` (such drops in the last minutes: ${entry.lagDrops})` : ''
      console.warn(
        `[collab ${entry.sessionId}] socket fell ${Math.round(waiting / 1024)} KB behind — closed, ` +
          `the browser will rebuild the document${again}`,
      )
      entry.lagDrops = 0
    }
    closeConn(entry, conn)
    return
  }
  if (kind === 'awareness' && waiting > AWARENESS_STALL_BYTES) return
  try {
    const compress = kind === 'state' || message.byteLength <= MAX_DEFLATE_BYTES
    conn.send(message, { compress }, (err) => {
      if (err) closeConn(entry, conn)
    })
  } catch {
    closeConn(entry, conn)
  }
}

function closeConn(entry: DocEntry, conn: WebSocket): void {
  const state = entry.conns.get(conn)
  if (!state) return
  entry.conns.delete(conn)
  if (state.participantId && !Array.from(entry.conns.values()).some(other => other.participantId === state.participantId)) {
    appendActivity(entry.sessionId, state.participantId, 'presence.left', {
      reason: 'disconnected', durationMs: Math.max(0, Date.now() - state.presenceStartedAt),
    }, state.role)
  }
  // The last one left — from this second the room is empty, and the countdown
  // to eviction (see `sweepIdleRooms`) starts from here.
  if (entry.conns.size === 0) {
    entry.emptySince = Date.now()
    stopHeartbeat(entry)
  }
  // Without this the People panel keeps showing whoever just walked out.
  awarenessProtocol.removeAwarenessStates(entry.awareness, Array.from(state.clientIds), null)
  try {
    conn.close()
  } catch {
    /* already gone */
  }
}

/**
 * The heartbeat — one per room, not per socket.
 *
 * A timer per socket looked honest: everyone has their own phase, everyone for
 * themselves. But five hundred `setInterval`s are five hundred entries in
 * Node's timer heap, five hundred closures and five hundred scattered event
 * loop wake-ups every twenty-five seconds; with ten classes running, five
 * thousand. One walk over the socket map does exactly the same and wakes up
 * once per room.
 *
 * What stays the same here to the letter: the frequency (`PING_INTERVAL_MS`),
 * the missed-answer counter of EACH socket and closing on the second miss. One
 * thing changes — the phase: a newcomer gets their first ping together with
 * the room, not twenty-five seconds after joining.
 */
function startHeartbeat(entry: DocEntry): void {
  if (entry.pingTimer) return
  entry.pingTimer = setInterval(() => {
    // A snapshot: `closeConn` inside the loop takes the socket out of that very map.
    for (const [conn, state] of Array.from(entry.conns)) {
      if (state.missedPongs >= MAX_MISSED_PONGS) {
        closeConn(entry, conn)
        conn.terminate()
        continue
      }
      state.missedPongs++
      try {
        conn.ping()
      } catch {
        closeConn(entry, conn)
        conn.terminate()
      }
    }
  }, PING_INTERVAL_MS)
}

function stopHeartbeat(entry: DocEntry): void {
  if (entry.pingTimer) clearInterval(entry.pingTimer)
  entry.pingTimer = null
}

function syncFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

/**
 * Broadcasting edits to the room — one frame per event loop tick, not a frame
 * per keystroke. Presence goes its own way, see `scheduleFaces`.
 *
 * Count it like this. One keystroke is one document update AND one presence
 * frame (`yCollab` announces the cursor position on every selection move).
 * Without coalescing, a room of five hundred people gets two thousand
 * `ws.send`s for it, each with its own `deflate`; twenty people typing five
 * keystrokes a second make two hundred thousand sends a second, and the event
 * loop is busy with nothing else.
 *
 * `setImmediate` was not chosen "by eye": it fires after Node has parsed ALL
 * the frames that arrived in the current socket poll cycle. That is, the delay
 * is exactly zero for a lone keystroke (the tick is ending now anyway), and it
 * coalesces more the greater the load — which is exactly what is needed.
 */
function scheduleFlush(entry: DocEntry): void {
  if (entry.outbox.queued) return
  entry.outbox.queued = true
  setImmediate(() => {
    /*
     * Its own exception — only for its own room.
     *
     * This is `setImmediate`, not a socket handler: nobody catches what is
     * thrown from here, and one broadcast that failed to assemble would take
     * down the process along with all the other rooms.
     */
    try {
      flushRoom(entry)
    } catch (err) {
      console.error(`[collab] could not deliver a frame to ${entry.sessionId}`, err)
      entry.outbox.updates = []
    }
  })
}

/**
 * The presence window: a quarter of a second per room, not a tick per movement.
 *
 * Presence is the only stream that flows in a SILENT room. `y-protocols`
 * announces the state anew every fifteen seconds (`outdatedTimeout / 2`), even
 * if the person is just looking at the screen: otherwise the neighbours would
 * strike them out after thirty. Five hundred tabs are thirty-three
 * announcements a second, and per tick each becomes five hundred sends: a
 * test-harness measurement gave 16 578 frames/s and 2.3 MB/s in a room where
 * nobody does anything.
 *
 * The window does not cancel this, it coalesces: over 200 ms all the faces
 * that moved accumulate, and ONE frame per recipient goes out. The keep-alive
 * is not lost — the thirty-second limit of `y-protocols` is a hundred and fifty
 * times the window — and cursor movement lags by the same 200 ms, which the
 * eye does not see.
 */
export const FACES_WINDOW_MS = 200

function scheduleFaces(entry: DocEntry): void {
  if (entry.outbox.facesTimer) return
  const timer = setTimeout(() => {
    entry.outbox.facesTimer = null
    /* Its own exception — only for its own room; see `scheduleFlush`. */
    try {
      flushFaces(entry)
    } catch (err) {
      console.error(`[collab] could not deliver presence to ${entry.sessionId}`, err)
      entry.outbox.faces.clear()
    }
  }, FACES_WINDOW_MS)
  // Cursors are no reason to keep the process alive: this module is imported
  // by tests and by one-off scripts.
  timer.unref?.()
  entry.outbox.facesTimer = timer
}

/** Close the window without broadcasting anything: the room is leaving memory. */
function stopFaces(entry: DocEntry): void {
  if (entry.outbox.facesTimer) clearTimeout(entry.outbox.facesTimer)
  entry.outbox.facesTimer = null
  entry.outbox.faces.clear()
}

function flushRoom(entry: DocEntry): void {
  entry.outbox.queued = false
  /*
   * Nobody to send to — so nothing to encode. The kernel appends output even
   * into a room everyone has left (they will come back for the result), and
   * assembling a frame for zero listeners is a `mergeUpdates` of a whole burst
   * for nothing.
   */
  if (entry.conns.size === 0) {
    entry.outbox.updates = []
    return
  }
  const batch = entry.outbox.updates
  if (batch.length > 0) {
    entry.outbox.updates = []
    sendUpdates(entry, batch)
  }
}

function flushFaces(entry: DocEntry): void {
  const faces = entry.outbox.faces
  entry.outbox.faces = new Set()
  if (entry.conns.size === 0 || faces.size === 0) return
  sendAwareness(entry, [...faces])
}

const mergeOf = (batch: Uint8Array[]): Uint8Array =>
  batch.length === 1 ? batch[0] : Y.mergeUpdates(batch)

function sendUpdates(entry: DocEntry, batch: Uint8Array[]): void {
  let merged: Uint8Array
  try {
    merged = mergeOf(batch)
  } catch (err) {
    /*
     * Coalescing is a speed-up, not the protocol. If `mergeUpdates` failed for
     * some reason, the room must still get its edits, even one by one:
     * otherwise the optimization turns into a silence nobody will notice.
     */
    console.error(`[collab] could not merge updates for ${entry.sessionId}`, err)
    for (const item of batch) {
      const frame = syncFrame(item)
      for (const conn of entry.conns.keys()) send(entry, conn, frame)
    }
    return
  }
  /*
   * One frame for the whole room — authors included.
   *
   * The author used to have their own edits subtracted: for every sending
   * socket the batch was merged anew (`mergeUpdates` over the whole burst minus
   * their edits). This looked careful but cost a square. A test-harness
   * measurement (tests/collab-fanout): one author — 0.01 ms per broadcast, a
   * hundred — 15.75 ms, five hundred — 1403 ms. That is, in a second when half
   * the course types at once, the event loop is busy with merging, not with the
   * room. And this is paid for bytes the recipient already has.
   *
   * Sending one's own back is safe, and that is a property of the protocol, not
   * a hope. Applying an update all of whose structures are already in place is
   * a no-op in Yjs: the transaction changes neither the document nor the
   * delete set, and no `update` event comes out of it. And `WebsocketProvider`
   * relays only updates whose origin is not itself, so the echo does not come
   * back to the server even in theory.
   */
  const whole = syncFrame(merged)
  for (const conn of entry.conns.keys()) send(entry, conn, whole)
}

function sendAwareness(entry: DocEntry, clients: number[]): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(entry.awareness, clients),
  )
  const message = encoding.toUint8Array(encoder)
  /*
   * One frame for everyone — the sender included, and this is not
   * carelessness.
   *
   * A client tab (`WebsocketProvider`) closes the socket itself if it has not
   * received a single message from the server for thirty seconds: protocol
   * pings are invisible to the browser, and the only thing it can count on in a
   * silent room is the echo of its own "I am still here", which presence sends
   * every fifteen seconds. While the echo was subtracted (12 Sep 2026, "one's
   * own face does not travel back"), a lonely tab tore down and brought up the
   * connection every thirty seconds — "[room …] opened" in the log went like a
   * metronome, and "Reconnecting" blinked in the header. Fifty bytes every
   * fifteen seconds are cheaper: `applyAwarenessUpdate` skips a state with its
   * own clock.
   */
  for (const conn of entry.conns.keys()) send(entry, conn, message, 'awareness')
}

/**
 * The document for a session, created on first use.
 *
 * Seeding happens here rather than in the browser: this runs once, under a
 * single writer, before anyone can connect. Two students tapping the link at
 * the same instant would otherwise each seed the starter cells into their own
 * copy and the merge would show both.
 */
export function getSessionDoc(sessionId: string, title?: string): SessionDoc {
  return getEntry(sessionId, title)
}

/**
 * The room's document if it is already open — and `null` if not.
 *
 * It differs from `getSessionDoc` exactly in that it does NOT create it. The
 * difference turned out to be not cosmetic: deferred work that arrived after
 * the room was closed — writing a notebook file, cleaning up after a deleted
 * file — called `getSessionDoc`, which honestly built the room again from the
 * snapshot, the new room set up timers for itself, and the next deferred work
 * built it again. The process stopped exiting, and a deleted room came back
 * into memory.
 *
 * The rule is simple: only what a person does has the right to create a
 * document. Everything that arrives by itself must ask this way.
 */
export function peekSessionDoc(sessionId: string): SessionDoc | null {
  return docs.get(sessionId) ?? null
}

function getEntry(sessionId: string, title?: string): DocEntry {
  const existing = docs.get(sessionId)
  if (existing) return existing

  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  // The server is a writer, not a person in the room.
  awareness.setLocalState(null)

  const entry: DocEntry = {
    sessionId,
    doc,
    awareness,
    conns: new Map(),
    dispose: bindPersistence(sessionId, doc),
    unwatch: () => {},
    outbox: { updates: [], queued: false, faces: new Set(), facesTimer: null },
    coldFrame: null,
    welcomeFaces: null,
    pingTimer: null,
    // A room is created not only by a person (the kernel, the oracle, the
    // history route), and it is empty from this second: the countdown to
    // eviction starts from birth.
    emptySince: Date.now(),
    lagDrops: 0,
  }
  docs.set(sessionId, entry)
  if (dropPending(sessionId, doc)) invalidateSnapshot(sessionId)
  /*
   * Notebook files — right after the document got into the registry, and
   * before seeding: the watcher must see the seeding as an ordinary edit, and
   * `watchBooks` calls `getSessionDoc` from inside and would find a half-built
   * room if it stood a line higher.
   */
  const unwatchBooks = watchBooks(sessionId, doc)
  const closeBinding = entry.dispose
  entry.unwatch = unwatchBooks
  entry.dispose = () => {
    unwatchBooks()
    closeBinding()
  }

  /*
   * Seed, then put it on disk before returning. A room that has just been
   * created is at its most vulnerable: the snapshot is debounced by seconds and
   * the room is reachable immediately, so a crash in between leaves a seminar
   * with a row and no document. On the way back the server would find nothing
   * stored, conclude the room is new and seed it again — and the students, who
   * still hold the real notebook, would merge it in underneath a second copy of
   * the starter cells. Encoding a two-cell document costs less than the
   * scheduling does.
   */
  if (ensureInitialNotebook(doc, title ?? getSession(sessionId)?.name)) {
    flushPersistence(sessionId)
  }

  /*
   * Whatever the snapshot says was running, was not running by the time this
   * process existed. Cleared here rather than by the kernel, because a room can
   * be reopened without a kernel ever being asked for one — the notebook has to
   * be honest before anybody presses anything.
   */
  if (clearStaleExecution(doc) > 0) {
    doc.transact(() => {
      getTerminal(doc).push([
        createTerminalLine({
          kind: 'system',
          text: tr("server.theServerRestartedCellsThatWereRunning.025fda"),
        }),
      ])
    }, ORIGIN)
  }

  /*
   * History starts AFTER seeding, and that is not a trifle of ordering.
   *
   * It used to stand earlier — with a comment promising exactly the opposite:
   * "a new room records its starter cells as its first version". It did not.
   * The cast was taken from an empty document (two bytes), the seeding
   * happened right after and never got into the history — the
   * `doc.on('update')` observer is hung even lower. After that every row was a
   * delta to a document the history had never seen: Yjs put them into pending,
   * and ANY version unfolded into an empty notebook. Silently — the "History"
   * tab showed zero cells and did not complain.
   *
   * Checked on a live database: for a seminar with twenty-one rows, all
   * twenty-one gave zero cells.
   *
   * And AFTER cleaning up a stale run — for the same reason, from the other
   * end. Between the baseline and the `record()` subscription a line below, the
   * document must stand still: `clearStaleExecution` writes into it with its
   * own clocks (the queue, `runningCell`, `startedAt`, `stdin` — and writes
   * even when there is nothing to reset), and those clocks got into neither the
   * database nor the deltas. After that any server write — an accepted oracle
   * patch, a cell rearrangement — referred, when a version was parsed, to a
   * clock that is not in the history, and went into pending forever: accepting
   * a patch did not show in the feed, and "restore the version" wiped the
   * cell's text for the whole room.
   */
  /*
   * Note images go to the shelf, and before `beginHistory`.
   *
   * Rooms created before the shelf for notes appeared carry problem statements
   * as base64 strings in the cell text: a measurement on a live room — 9.4 MB
   * of a 10.5 MB document, which goes whole to everyone who joins. From now on
   * the import puts them on the shelf itself (server/src/notebook-images.ts),
   * and those already there are offloaded here, once when the room is brought
   * up.
   *
   * A line ABOVE, not below, exactly by the argument of the neighbouring
   * paragraph: an edit made after the baseline would look to the room like
   * someone else's version in the history feed — and would come there from
   * "the server", which wrote nothing. Before the baseline it becomes part of
   * the document the history starts from.
   */
  shelveRoomImages(sessionId, doc)

  beginHistory(sessionId, doc)

  /*
   * A cell id appears once.
   *
   * Y.Array has no move, so the editor moves a cell by cloning it and deleting
   * the original. Two people nudging the same cell at the same moment merge
   * into two deletes — which collapse into one — and two inserts, which do not:
   * the notebook ends up holding the same cell twice, under one id. Everything
   * downstream is keyed by that id — running it, attributing it, asking the
   * oracle about it — so a duplicate is not a cosmetic problem.
   *
   * Repaired here rather than in the editor for the reason the title is: there
   * is exactly one server, and it cannot be a stale client racing another.
   *
   * Which of the two stays is not a matter of indifference — and it used to be
   * treated as one. A name match can be legitimate: someone brought a deleted
   * cell back from the history — a restore recreates it with the PREVIOUS name
   * — while whoever deleted it pressed Ctrl+Z, and Yjs undid the deletion with
   * a copy. The live cell stays, the copy brought by this transaction goes;
   * among copies that arrived at once (two merged rearrangements), the first
   * one stays.
   */
  /*
   * An observer on the whole document, not on one cell array: a room has
   * several notebooks, they appear on the fly, and subscribing to each as it
   * appears is one more place where one can forget to unsubscribe.
   */
  doc.on('afterTransaction', (transaction: Y.Transaction) => {
    if (transaction.origin === ORIGIN) return
    // Only an insertion creates a duplicate, and only in a cell array.
    let touched = false
    transaction.changed.forEach((_keys, type) => {
      if (type instanceof Y.Array) touched = true
    })
    if (!touched) return

    /*
     * The copy that goes is the one THIS transaction created, not the one
     * standing further down the list. The difference shows where a name match
     * is legitimate: someone brought a deleted cell back from the history — a
     * restore recreates it with the PREVIOUS name — while whoever deleted it
     * pressed Ctrl+Z, and Yjs undid the deletion with a copy. It is the copy
     * that has to be thrown out: otherwise the new one, standing higher in the
     * list, would push out the live cell together with its output, and swapping
     * someone else's cell for your own would take one name coincidence.
     *
     * Names are compared across ALL notebooks at once, not within each: a cell
     * is found by name without knowing its notebook (see `findCell`), and two
     * identical names in different notebooks mean that "Run" sometimes runs
     * the wrong one.
     */
    const seen = new Map<string, { cells: Y.Array<YCell>; index: number; fresh: boolean }>()
    const doomed = new Map<Y.Array<YCell>, number[]>()
    const drop = (cells: Y.Array<YCell>, index: number): void => {
      const list = doomed.get(cells)
      if (list) list.push(index)
      else doomed.set(cells, [index])
    }
    for (const cells of allCellArrays(doc)) {
      cells.forEach((cell: YCell, index: number) => {
        const id = cell.get('id')
        if (typeof id !== 'string') return
        const fresh = madeIn(transaction, cell)
        const first = seen.get(id)
        if (!first) {
          seen.set(id, { cells, index, fresh })
          return
        }
        if (first.fresh && !fresh) {
          drop(first.cells, first.index)
          seen.set(id, { cells, index, fresh })
        } else {
          drop(cells, index)
        }
      })
    }
    if (doomed.size === 0) return
    doc.transact(() => {
      // Back to front, so the earlier indices stay valid as they go.
      for (const [cells, indices] of doomed) {
        for (const index of indices.sort((a, b) => b - a)) cells.delete(index, 1)
      }
    }, ORIGIN)
  })

  /*
   * The room's title is the seminar's name, and the admin list reads it from the
   * sessions row. Mirror one into the other so a rename — from the header or
   * from the panel — is one name and not two.
   *
   * Observed rather than written by whoever renamed: there is exactly one
   * writer this way, and it is the server, which cannot be a stale client.
   */
  const meta = getMeta(doc)
  meta.observe((event: Y.YMapEvent<unknown>) => {
    if (!event.keysChanged.has('title')) return
    if (event.transaction.origin === ORIGIN) return

    /*
     * The header lets only the host rename the room, and this mirrors the name
     * into the row the admin list reads — so a rename written straight into the
     * shared document by anyone else would reach further than the interface it
     * came from. Put it back rather than pass it on.
     *
     * This is the one field defended this way. Everything else in the document
     * is writable by everyone by construction, which the README says out loud.
     */
    const from = event.transaction.origin
    const writer = from instanceof WebSocket ? entry.conns.get(from) : undefined
    if (writer && writer.role !== 'host') {
      const previous = event.changes.keys.get('title')?.oldValue
      doc.transact(() => {
        if (typeof previous === 'string') meta.set('title', previous)
        else meta.delete('title')
      }, ORIGIN)
      return
    }

    const title = meta.get('title')
    if (typeof title !== 'string' || !title.trim()) return
    if (getSession(sessionId)?.name === title) return
    renameSession(sessionId, title)
  })

  doc.on('update', (update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
    entry.outbox.updates.push(update)
    // The answer to a cold tab is built from the document, and the document
    // has just changed: the next newcomer must get a frame, not yesterday's
    // snapshot.
    entry.coldFrame = null
    scheduleFlush(entry)
    /*
     * The author comes from the origin, which for anything a person did is the
     * socket it arrived on. The server's own writes — seeding a new room,
     * importing from GitHub, the kernel writing an output — have no author, and
     * that is honest: nobody in the room typed them.
     *
     * A restore is skipped here and recorded by the restore itself, under the
     * name of whoever pressed the button.
     */
    if (origin === RESTORE_ORIGIN) return
    /*
     * The author is taken from the update's origin.
     *
     * Usually that is the socket it arrived on. But the server itself sometimes
     * writes into the document on someone's behalf — that is how an oracle
     * proposal is applied now: the server makes the decision so that two tabs
     * do not write the patch twice, and without this branch the version in the
     * history ended up belonging to nobody. The line "accepted by Pyotr" turned
     * into "the room", and Pyotr's own Ctrl+Z no longer reached his own edit.
     *
     * The form is `on-behalf:<participantId>`: a string only code on the server
     * can compose, because a client update arrives with its socket as the
     * origin and never with a string.
     */
    const author =
      origin instanceof WebSocket
        ? (entry.conns.get(origin)?.participantId ?? null)
        : typeof origin === 'string' && origin.startsWith(BEHALF_PREFIX)
          ? origin.slice(BEHALF_PREFIX.length)
          : null
    const direct = origin instanceof WebSocket ? entry.conns.get(origin) : undefined
    record(sessionId, doc, update, author, tr, direct?.participantId
      ? { participantId: direct.participantId, role: direct.role } : undefined)
  })

  awareness.on(
    'update',
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const state = origin instanceof WebSocket ? entry.conns.get(origin) : undefined
      if (state) {
        for (const id of changes.added) state.clientIds.add(id)
        for (const id of changes.removed) state.clientIds.delete(id)
        /*
         * Before the relay, not after. Awareness is whatever the client says
         * it is — that is the point of it, and why a caret can carry a colour.
         * But `role` is not a preference: the People panel draws a Host badge
         * from it, and one edit to localStorage put a second teacher in front
         * of the room. The server knows the real role for this socket, so it
         * corrects the state and then broadcasts the corrected one. The forger
         * still lies to their own screen; nobody else hears it.
         */
        pinRole(entry, state, changes.added.concat(changes.updated))
      }
      /*
       * A face goes into the window by clientID, not by frame: several
       * keep-alives from one tab may arrive within a window, and presence is
       * encoded from the current state anyway — so a repeat within the window
       * adds nothing, and a set is enough.
       */
      for (const id of changes.added) entry.outbox.faces.add(id)
      for (const id of changes.updated) entry.outbox.faces.add(id)
      for (const id of changes.removed) entry.outbox.faces.add(id)
      // The face list for a newcomer is built from a state that has just
      // changed: rebuild it. After `pinRole` — it edits the state silently.
      entry.welcomeFaces = null
      scheduleFaces(entry)
    },
  )

  return entry
}

/**
 * Subtypes of the sync protocol. The numbers are the protocol itself, not a
 * choice.
 *
 * `1` (step2) and `2` (update) are checked the same way. Checking only `2` is a
 * hole one reconnection wide: the server sends step1 on every connection, the
 * browser answers with step2 containing everything the server lacks, and any
 * refusal gets laundered by rejoining.
 */
const SYNC_STEP1 = 0
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

/**
 * The state vector of an empty tab — exactly one byte, zero clients.
 *
 * That is what step1 looks like from a tab that has nothing: a clean browser,
 * incognito mode, a wiped IndexedDB — and the answer to it is the same down to
 * the byte, because it is built from the document, not from its frame.
 */
function coldTab(stateVector: Uint8Array): boolean {
  return stateVector.byteLength === 1 && stateVector[0] === 0
}

/**
 * The whole document in one frame — built once per room.
 *
 * A measurement in a live class: 1 065 985 B and tens of milliseconds of
 * encoding. Five hundred tabs joining after a server restart are five hundred
 * identical snapshots, and the difference between "build once" and "build five
 * hundred times" here is seconds of busy event loop. Reset in the
 * `doc.on('update')` handler: as long as the document has not changed, the
 * bytes of the cold answer are the same.
 */
function coldFrame(entry: DocEntry): Uint8Array {
  if (entry.coldFrame) return entry.coldFrame
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep2(encoder, entry.doc)
  entry.coldFrame = encoding.toUint8Array(encoder)
  return entry.coldFrame
}

/**
 * Refuse this connection's frame.
 *
 * Closing, not silence. Nothing in the sync protocol can take away from a
 * client a structure it already has: a CRDT merge is a union, and neither
 * `encodeStateAsUpdate` nor a full step1/step2 round will remove the refused
 * text from the screen of whoever typed it. So a client that got 4403 rebuilds
 * the document from scratch — and the new clientID also cures the gap in
 * clocks because of which the next allowed keystroke would otherwise land in
 * `pendingStructs` behind a clock the server did not accept.
 */
function refuse(
  entry: DocEntry,
  conn: WebSocket,
  refusal: {
    rule: GateRule
    message: string
    /**
     * What exactly failed to parse — in the gate's words, with the path. For
     * the log, not for the person: with one generic phrase about the cache, two
     * evenings went into looking for a cause that was called "frame too large
     * to parse (cells#…)".
     */
    detail?: string
    /**
     * A refusal of a first sync, not of an edit. By this word in the close
     * frame the tab tells "your cache is older than the server" from "this edit
     * was not accepted": the control socket with the refusal text travels over
     * a different wire and may arrive after the close.
     */
    stale?: boolean
  },
): void {
  const state = entry.conns.get(conn)
  if (state?.participantId && refusalListener) {
    refusalListener(entry.sessionId, state.participantId, refusal)
  }
  tally('gate')
  /*
   * The reason in words, but not on every refusal.
   *
   * A gate refusal in the log is needed: it shows that the room hit a rule, not
   * that it broke. But a whole frame is refused, and after 4403 the browser
   * rebuilds the document and tries again — in a cohort that is an avalanche of
   * identical lines. The first one per minute per room and rule is said, the
   * rest are visible as a number in the summary. Neither the participant's name
   * nor the edit's text: only the rule and the reason the gate itself put into
   * words.
   */
  if (seldom(`gate:${entry.sessionId}:${refusal.rule}`)) {
    const detail = refusal.detail ? ` · ${refusal.detail}` : ''
    console.warn(`[gate ${entry.sessionId}] ${refusal.rule} refused — ${refusal.message}${detail}`)
  }
  try {
    conn.close(4403, refusal.stale ? 'stale' : refusal.rule)
  } catch {
    /* socket already closed — the refusal stands anyway: the frame was not applied */
  }
}

/**
 * Throw out of the document what never got into it.
 *
 * `pendingStructs` are keystrokes for which Yjs is waiting for the previous
 * clock of the same client. There is nothing to wait for: the gate refused that
 * frame, and the clock will never come. And what is stuck does not lie quietly
 * — `encodeStateAsUpdate` puts it into the snapshot and into every step2 to
 * every tab, the tab returns it in its own step2, and the gate judges the same
 * keystrokes on every entry — in a closed room with a refusal. Measured on a
 * live room: 140 KB of stuck keystrokes from six clients after one morning.
 *
 * Now the gate does not let such a frame through (gate.ts · checkContiguity),
 * so this is cleaning up after the past: snapshots written before it. Tabs
 * that still have the garbage in their cache will get a refusal on their very
 * first entry and rebuild cleanly.
 *
 * Returns whether there was anything to throw out.
 */
function dropPending(sessionId: string, doc: Y.Doc): boolean {
  const store = doc.store as unknown as {
    pendingStructs: { update: Uint8Array } | null
    pendingDs: Uint8Array | null
  }
  if (!store.pendingStructs && !store.pendingDs) return false
  const bytes = (store.pendingStructs?.update.byteLength ?? 0) + (store.pendingDs?.byteLength ?? 0)
  console.warn(`[room ${sessionId}] dropped ${bytes} bytes of pending structs that could never integrate`)
  store.pendingStructs = null
  store.pendingDs = null
  return true
}

type RefusalListener = (
  sessionId: string,
  participantId: string,
  refusal: { rule: GateRule; message: string },
) => void

let refusalListener: RefusalListener | null = null

/**
 * Whom to tell about a refusal in words. Registered by `control.ts`: the message
 * goes over the control socket, and importing it from here would close a loop.
 */
export function onRefusal(listener: RefusalListener): void {
  refusalListener = listener
}

type RemovedListener = (sessionId: string, cellIds: string[]) => void

let removedListener: RemovedListener | null = null

/**
 * Which cells are no longer in the room. Registered by `control.ts`.
 *
 * A cell the kernel is computing right now or holds in its queue can be deleted
 * too: the document does not forbid it, and it should not — the person sees the
 * cell and has the right to remove it. What diverges is something else: the
 * kernel keeps spinning its loop for a cell that is gone, and
 * `meta.runningCell` names a vanished name.
 *
 * Through registration, like `onRefusal`: it is the kernel that takes the cell
 * off execution, and importing the kernel from here would tie the modules into
 * a loop — the kernel itself takes the document through `getSessionDoc`.
 */
export function onCellsRemoved(listener: RemovedListener): void {
  removedListener = listener
}

/**
 * How many faces one connection may create in a room.
 *
 * One per tab is the norm; a second one happens when switching providers on
 * reconnect. Four is a ceiling with a margin, and without a ceiling one socket
 * fills the People panel with made-up participants, each with a name, a colour
 * and a cursor in someone else's cell.
 */
const MAX_AWARENESS_CLIENTS = 4

/**
 * Faces the room has already seen — including those gone along with their
 * socket.
 *
 * `y-websocket` forwards into the socket EVERY presence update it has applied —
 * including one that came over BroadcastChannel from a neighbouring tab of the
 * same seminar. While the neighbour is connected, the echo is fended off
 * because its face is already in the room. But once the neighbour drops,
 * `closeConn` removes its face — and the echo gets through: tab A takes over
 * tab B's clientID, the frames of the reconnected B are silently discarded, and
 * A's leaving takes B out of the People panel.
 *
 * So a name the room has already heard goes only to a socket that has not
 * brought anyone yet: the reconnected B comes in with its previous clientID in
 * its very first frame, while A already has its own face.
 *
 * By the presence document, not by the room entry: the file editor's sockets
 * (collab/files.ts), which have their own, live by this same check.
 */
const introduced = new WeakMap<Awareness, Map<number, number>>()

/**
 * How long the room remembers a face that left.
 *
 * By time, not by count. There used to be a ceiling of 256 names with the
 * caption "nobody opens that many tabs during a class" — untrue exactly at the
 * scale the product was made for: in a room of five hundred people there are
 * certainly more live clientIDs, and with reconnections over a class there are
 * thousands. The memory overflowed, forgot departed names one by one — and the
 * echo protection stopped working exactly where it is needed: the echo of a
 * neighbouring tab took over the clientID of a participant who left, that
 * participant vanished from the People panel, and their frames were silently
 * discarded.
 *
 * Half an hour is certainly longer than an echo lives in a neighbouring tab's
 * `BroadcastChannel` (it arrives in the same second), and certainly shorter
 * than a class. The memory price is one number per face: a room of five
 * hundred people with reconnections remembers thousands of names and costs
 * tens of kilobytes.
 */
const REMEMBER_FACE_MS = 30 * 60 * 1000

/**
 * How many names we keep before it is time to forget them.
 *
 * Not a room measure but a fuse against unbounded growth: only someone who
 * opens tabs faster than half an hour expires runs into it.
 */
const MAX_REMEMBERED_CLIENTS = 8192

/** Forget faces the room has not seen for longer than `REMEMBER_FACE_MS`. */
function forgetOldFaces(known: Map<number, number>, now: number): void {
  for (const [clientId, at] of known) {
    if (now - at < REMEMBER_FACE_MS) continue
    known.delete(clientId)
  }
  // Did not help — so names pour in faster than they expire: the oldest go,
  // and Map insertion order keeps them first.
  while (known.size > MAX_REMEMBERED_CLIENTS) {
    const oldest = known.keys().next()
    if (oldest.done) break
    known.delete(oldest.value)
  }
}

/**
 * Everything the check below needs from a document: its sockets and its
 * presence.
 *
 * Not `Pick<DocEntry, …>`: the same parsing serves file documents, and their
 * `ConnState` is their own (collab/files.ts) and does not have to match ours.
 * While their fields happened to coincide, `Pick` worked; the very first field
 * needed only by the room broke the build in someone else's file. What is
 * really required is named.
 */
export interface AwarenessOwner {
  conns: Map<WebSocket, { clientIds: Set<number> }>
  awareness: Awareness
}

/**
 * A presence frame — only about oneself.
 *
 * `applyAwarenessUpdate` accepts the state of ANY clientID as long as the clock
 * is higher: that is, one participant could remove everyone else from the
 * People panel for the whole room or rewrite someone else's cursor together
 * with the name and role. The socket knows whom it has brought
 * (`state.clientIds`) — and everything else is rejected.
 *
 * The frame is rejected whole, not face by face: a presence packet has no way
 * to throw one entry out of the middle, and taking it apart would mean
 * rebuilding its own protocol.
 */
export function ownAwareness(entry: AwarenessOwner, conn: WebSocket, payload: Uint8Array): boolean {
  const state = entry.conns.get(conn)
  if (!state) return false
  const decoder = decoding.createDecoder(payload)
  const count = decoding.readVarUint(decoder)
  const now = Date.now()
  for (let i = 0; i < count; i += 1) {
    const clientId = decoding.readVarUint(decoder)
    decoding.readVarUint(decoder) // the clock is none of our business
    /*
     * The state is SKIPPED, not read.
     *
     * `readVarString` is parsing UTF-8 into a new string, that is, a copy of
     * the whole presence JSON. And `y-websocket` returns to the server every
     * frame it applied — including someone else's that came from the server
     * itself (see load.mts): in a room of five hundred tabs that is five
     * hundred copies of someone else's cursor on every keystroke, and all of
     * them are certainly rejected a line below. On the wire the string lies as
     * a length plus bytes, so walking past it is an addition.
     *
     * The length on its own line, and that is not a matter of taste.
     * `decoder.pos += readVarUint(decoder)` in JS takes the OLD `pos` first, and
     * the bytes of the length varint itself get lost: on a frame with one face
     * it is invisible (nobody reads further), but from the second face on the
     * decoder drifts, and the client turns out to be a random byte of someone
     * else's JSON — that is, the ownership check starts letting through
     * someone else's presence as the second face in a frame.
     */
    const bytes = decoding.readVarUint(decoder)
    decoder.pos += bytes
    if (state.clientIds.has(clientId)) continue
    // A new face of this socket — allowed while there are not too many.
    if (state.clientIds.size + 1 > MAX_AWARENESS_CLIENTS) return false
    if (entry.awareness.getStates().has(clientId)) return false
    let known = introduced.get(entry.awareness)
    if (!known) introduced.set(entry.awareness, (known = new Map()))
    // Someone else's face that has already left the room is a neighbouring tab's echo.
    if (known.has(clientId) && state.clientIds.size > 0) return false
    state.clientIds.add(clientId)
    known.set(clientId, now)
    if (known.size > MAX_REMEMBERED_CLIENTS) forgetOldFaces(known, now)
  }
  return true
}

function handleMessage(entry: DocEntry, conn: WebSocket, data: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(data)
    const encoder = encoding.createEncoder()
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        /*
         * The check comes before applying, and there is nowhere later to put
         * it: the relay, the history write and the disk write hang
         * synchronously inside `applyUpdate` inside `readSyncMessage`. The
         * subtype is read from a copy of the decoder so that the real one stays
         * untouched if the frame is accepted.
         */
        const peek = decoding.clone(decoder)
        const subtype = decoding.readVarUint(peek)
        /*
         * A cold tab takes the short road. Its step1 carries nothing that needs
         * checking (it is a request, not an edit), and the room already has the
         * answer to it built: exactly the same snapshot as for the previous
         * newcomer.
         */
        if (subtype === SYNC_STEP1 && coldTab(decoding.readVarUint8Array(peek))) {
          send(entry, conn, coldFrame(entry), 'state')
          break
        }
        let accepted: { retyped: string[]; created: string[]; removed: string[] } | null = null
        /*
         * What this branch costs when the hall comes back — as a number, not
         * by eye.
         *
         * A returning tab's step2 is not "a delta of a couple dozen bytes": it
         * carries the room's whole delete set, and the server's answer to a
         * synced client, `encodeStateAsUpdate(doc, sv)`, is the same set back.
         * Measured on a semester room (400 cells, 160 thousand typed
         * characters, 22.8 thousand deletions, a 750 KB document;
         * tests/sync-storm-cost.test.mts):
         *
         *   step2 of a returning tab ................... 87 KB
         *   `classify` of this frame ................... 5.6 ms
         *   `encodeStateAsUpdate(doc, sv)` in reply .... 87 KB, 1.3 ms
         *
         * Five hundred tabs come back within a second or two after a server
         * restart or a relay blink — that is ≈2.8 s of busy event loop on
         * parsing alone and ≈44 MB outgoing. The frame ceiling
         * (`MAX_SYNC_STEP2_BYTES`, 8 MB) still has ×90 headroom: it is not the
         * ceiling that gives out but the event loop.
         */
        if (subtype === SYNC_STEP2 || subtype === SYNC_UPDATE) {
          const state = entry.conns.get(conn)
          const stale = subtype === SYNC_STEP2
          const judgement = classify(
            entry.doc,
            decoding.readVarUint8Array(peek),
            stale ? MAX_SYNC_STEP2_BYTES : undefined,
          )
          if (!judgement.ok) {
            // The room's floor: not a right, but what the server writes itself.
            return refuse(entry, conn, {
              rule: 'edit',
              message: stale ? STALE_SYNC() : floorMessage(judgement.why),
              detail: `${judgement.why} (${judgement.path})`,
              stale,
            })
          }
          /*
           * The end of the class travels separately from the rules, although
           * it tightens those very rules. `getRules` already returns the
           * teacher's rules, so the refusal will happen even without this flag;
           * but by the rules alone the gate cannot tell a finished class from a
           * room where the notebook is closed anyway, and their phrases differ.
           */
          const verdict = permits(
            judgement.verdicts,
            getRules(entry.sessionId),
            state?.role ?? 'participant',
            isFinished(entry.sessionId),
            /*
             * Who sent the frame — for personal notebooks: only by this name
             * can one see whether the notebook in front of the person is their
             * own or someone else's (shared/rules.ts · BookRule.owner). A socket
             * without a name is certainly not the author, and it is the one
             * that gets the refusal, not the neighbouring personal notebook.
             */
            state?.participantId ?? null,
          )
          if (!verdict.ok) return refuse(entry, conn, verdict)
          /*
           * Remember BEFORE applying: after it there is nothing left to read,
           * and without this Ctrl+Z would bring back a cell without output —
           * Yjs undoes a deletion with a copy, and the output in the copy would
           * have to be taken from the browser, which the floor does not allow.
           */
          rememberDeleted(entry.sessionId, entry.doc, judgement.removed)
          accepted = judgement
          // An accepted frame is the only measure that people in the room are
          // really working. Only a number, once a minute: there are tens of
          // thousands of them.
          tally('frames')
        }
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, conn)
        /*
         * An accepted frame must go in whole: gaps are refused by the gate. If
         * something got stuck anyway, that is a bug in the gate, and one must
         * not keep quiet about it, but must not leave garbage in the document
         * either: see dropPending.
         */
        if (accepted && dropPending(entry.sessionId, entry.doc)) {
          console.error(`[collab] accepted frame left pending structs in ${entry.sessionId}`)
          invalidateSnapshot(entry.sessionId)
        }
        if (accepted) {
          const { retyped, created, removed } = accepted
          if (retyped.length > 0 || created.length > 0) {
            entry.doc.transact(() => {
              resetRetyped(entry.doc, retyped)
              settleFresh(entry.sessionId, entry.doc, created)
            }, ORIGIN)
          }
          // After applying: the kernel is told about cells no longer in the notebook.
          if (removed.length > 0) removedListener?.(entry.sessionId, removed)
        }
        /*
         * A bare message type and nothing after it means there is nothing to
         * say. Anything non-empty here is step2 in response to step1, that is,
         * the whole document: it is worth compressing at any size (`send` ·
         * state).
         */
        if (encoding.length(encoder) > 1) {
          send(entry, conn, encoding.toUint8Array(encoder), 'state')
        }
        break
      }
      case MESSAGE_AWARENESS: {
        const payload = decoding.readVarUint8Array(decoder)
        if (!ownAwareness(entry, conn, payload)) break
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, payload, conn)
        break
      }
    }
  } catch (err) {
    /*
     * A refusal, not swallowing.
     *
     * There used to be "one malformed frame should cost the socket a message,
     * not the seminar" here — and that is true exactly until a check appears:
     * swallowing a sync frame means going silently mute forever, because the
     * client considers it delivered and will never repeat it. A check that
     * fell apart must refuse, otherwise what it could not read is executed
     * after it stopped looking.
     */
    console.error(`[collab] bad message in ${entry.sessionId}`, err)
    refuse(entry, conn, {
      rule: 'edit',
      message: tr("server.theEditCouldNotBeReadAnd.fab4ce"),
    })
  }
}

/**
 * The words for a refusal by the room's floor — that is, not by a rule but by
 * what the server writes itself. The person has no need to know about paths
 * inside the document.
 */
function floorMessage(why: string): string {
  return tr("server.thisEditWasNotAccepted.540727", { p0: why })
}

/**
 * Separate words for refusing a FIRST-sync frame.
 *
 * `step2` is not anyone's edit but the tab's whole cache, which the browser
 * offers the server on every connection. The cause of a refusal here is
 * usually not the person: the server was killed hard (OOM, power) or the
 * database was restored from a backup, its snapshot lagged a few seconds
 * behind, and the tab's cache holds outputs and kernel state written by the
 * PREVIOUS server. Answering that with "this field is written by the server,
 * not the browser" means blaming the person for someone else's trouble — and
 * the tab will rebuild anyway, because the protocol has nothing to remove
 * those structures from it with.
 */
const STALE_SYNC =
  () => tr("server.someOfThisTabSCachedChanges.47f300")

/**
 * Force this connection's awareness role back to what the socket was opened
 * with. Cheap: one map lookup per awareness frame, and awareness frames are
 * already the chattiest thing on this wire.
 */
function pinRole(entry: DocEntry, state: ConnState, clientIds: number[]): void {
  if (!state.participantId) return
  for (const clientId of clientIds) {
    const local = entry.awareness.getStates().get(clientId) as
      | { user?: { id?: string; role?: ParticipantRole } }
      | undefined
    const user = local?.user
    if (!user) continue
    if (user.id === state.participantId && user.role === state.role) continue
    entry.awareness.states.set(clientId, {
      ...local,
      user: { ...user, id: state.participantId, role: state.role },
    })
  }
}

export function handleCollabSocket(
  ws: WebSocket,
  sessionId: string,
  role: ParticipantRole = 'participant',
  participantId: string | null = null,
  credentials?: SocketCredentials,
): void {
  const authorized = authorizeSocket(ws, credentials)
  const entry = getEntry(sessionId)
  /*
   * The room opened — by the first socket, not by a row in the database.
   *
   * A seminar is created in advance, sometimes a week ahead; a class begins
   * when someone enters the room. The same line will repeat after a server
   * restart, and that is right: from the log's point of view the room then
   * opens anew.
   */
  const wasEmpty = entry.conns.size === 0
  entry.emptySince = 0
  ws.binaryType = 'arraybuffer'

  const existingPresence = participantId ? Array.from(entry.conns.values()).find(other => other.participantId === participantId) : undefined

  const state: ConnState = {
    role,
    participantId,
    openedAt: Date.now(),
    presenceStartedAt: existingPresence?.presenceStartedAt ?? Date.now(),
    clientIds: new Set<number>(),
    missedPongs: 0,
  }
  entry.conns.set(ws, state)
  startHeartbeat(entry)
  if (participantId && !existingPresence) appendActivity(sessionId, participantId, 'presence.joined', {}, role)
  if (wasEmpty) console.log(`[room ${sessionId}] opened`)

  ws.on('pong', () => {
    state.missedPongs = 0
  })
  ws.on('message', (data: RawData) => {
    if (authorized()) handleMessage(entry, ws, toUint8Array(data))
  })
  ws.on('close', () => closeConn(entry, ws))
  ws.on('error', () => closeConn(entry, ws))

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, entry.doc)
  send(entry, ws, encoding.toUint8Array(encoder), 'state')

  const welcome = welcomeFaces(entry)
  if (welcome) send(entry, ws, welcome, 'state')
}

/**
 * The room's full list of faces for a newcomer — one frame for everyone while
 * nobody moves.
 *
 * Measured on a room of five hundred people: 75 KB and 5.46 ms per newcomer.
 * The hall coming back after a relay blink is five hundred entries in a row,
 * that is, 413 ms of CPU and 37 MB of garbage for one and the same presence.
 * The frame is reset by any change of presence (the `awareness.on('update')`
 * handler, after `pinRole`), so it cannot go stale.
 */
function welcomeFaces(entry: DocEntry): Uint8Array | null {
  if (entry.welcomeFaces) return entry.welcomeFaces
  const states = entry.awareness.getStates()
  if (states.size === 0) return null
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(entry.awareness, Array.from(states.keys())),
  )
  entry.welcomeFaces = encoding.toUint8Array(encoder)
  return entry.welcomeFaces
}

/** Open sockets, not distinct people — a second tab counts twice. */
export function onlineCount(sessionId: string): number {
  return docs.get(sessionId)?.conns.size ?? 0
}

/**
 * Since when there is someone in the room — or null if there is nobody now.
 *
 * The oldest of the open sockets, not the first in the room's whole history:
 * the class that is going on is those who are in it now. A room that emptied
 * and filled again starts its clock anew, and that is the truth about it: a
 * break between classes differs from the end of a class in nothing else.
 *
 * A server restart resets this clock together with the sockets — just as it
 * resets the log's "[room …] opened", and for the same reason.
 */
export function liveSince(sessionId: string): number | null {
  const entry = docs.get(sessionId)
  if (!entry || entry.conns.size === 0) return null
  let oldest = Infinity
  for (const state of entry.conns.values()) oldest = Math.min(oldest, state.openedAt)
  return Number.isFinite(oldest) ? oldest : null
}

/**
 * How many rooms are alive now and how many people are in them — for the
 * per-minute summary.
 *
 * A live room is one with at least one socket: the document outlives the
 * departure of the last one (it is still being written to disk), but the class
 * does not, and counting such a room as running would mean lying in every line
 * until a restart. People are counted by participants, not sockets — the same
 * number the room sees in its own People panel.
 */
export function roomCensus(): { rooms: number; people: number } {
  let rooms = 0
  let people = 0
  for (const [sessionId, entry] of docs) {
    if (entry.conns.size === 0) continue
    rooms += 1
    people += onlineParticipantIds(sessionId).length
  }
  return { rooms, people }
}

/**
 * The participant ids actually present right now, deduplicated.
 *
 * Not the same as onlineCount, which counts sockets: one person with the
 * seminar open in two tabs is two connections and one participant. And not the
 * same as the participants table either, which is every name that ever joined —
 * the join screen said "148 people are already inside" about a room holding one,
 * because that table never forgets.
 */
export function onlineParticipantIds(sessionId: string): string[] {
  const entry = docs.get(sessionId)
  if (!entry) return []
  const ids = new Set<string>()
  for (const state of entry.awareness.getStates().values()) {
    /*
     * Typed against the shared contract on purpose. This read used to be a
     * hand-written `{ user?: { participantId?: unknown } }`, and the field the
     * browser actually publishes is `id` — so every real page was invisible
     * here and the room's online list came back empty for everybody, while the
     * test client, which happened to send `participantId`, showed thirty. An
     * inline cast asserts what you meant; the shared type is what is true.
     *
     * One person can hold several of these — two tabs, or a reconnect whose old
     * socket has not timed out — so the set is by participant, not by socket.
     */
    const user = (state as { user?: Partial<AwarenessUser> } | undefined)?.user
    if (typeof user?.id === 'string' && user.id) ids.add(user.id)
  }
  return Array.from(ids)
}

/**
 * Remove one person from the room's document without touching the room.
 *
 * The neighbour `dropSessionDoc` tears down the document whole, because a
 * seminar is being torn down. Here it is the other way round: the class goes
 * on, and exactly the one who was banned must leave — the other nineteen must
 * notice nothing.
 *
 * Through the same `closeConn` as an ordinary leave: it removes the presence,
 * and the departed person's cursor disappears for everyone at once instead of
 * hanging in someone else's cell until a timeout. This socket will not be able
 * to come back — the handshake checks the ban before the upgrade; a clean
 * browser still will, and that is said out loud everywhere bans are talked
 * about at all.
 */
export function dropParticipant(sessionId: string, participantId: string): void {
  const entry = docs.get(sessionId)
  if (!entry) return
  // A copy: closeConn edits the same map the loop walks over.
  for (const [conn, state] of [...entry.conns]) {
    if (state.participantId !== participantId) continue
    closeConn(entry, conn)
  }
}

/* ------------------------------------------------- evicting idle rooms */

/**
 * How long an empty room still lives in memory.
 *
 * Ten minutes is "the teacher closed the tab to open it from another laptop",
 * not "the class is over". Less — and a break would cost everyone a rebuild of
 * the document from the snapshot; more — and a semester instance accumulates
 * rooms faster than it releases them.
 *
 * A room holds not only the `Y.Doc` (the full CRDT together with the delete set
 * — for a long-lived room that is hundreds of kilobytes and only growing) but
 * also the history baseline (a SECOND full copy of the document), the texts of
 * all cells, presence faces and the snapshot binding. On a notebook with images
 * that is ten megabytes per abandoned room, and it used to be released only by
 * deleting the seminar or restarting the server: a university instance
 * accumulated hundreds of these over a semester — until an OOM that takes down
 * ALL rooms at once.
 *
 * One can come back to an evicted room as always: it will be brought up from
 * the snapshot, exactly as after a server restart.
 */
const IDLE_ROOM_MS = 10 * 60 * 1000

/**
 * And this long — under any circumstances.
 *
 * Ordinary eviction waits until nothing is happening in the room: the kernel
 * may be computing a cell when everyone has closed their laptops, and tearing
 * the document out from under it would mean throwing away a result its owner
 * will come back for. But the "something is happening" flag is read from the
 * document itself, and it can get stuck: an oracle answer whose process was
 * killed mid-stream stays `streaming` forever — and one such entry would keep
 * the room in memory until a restart, that is, exactly the leak eviction was
 * written against.
 *
 * Three hours is certainly later than the kernel tears down an idle room's
 * container by itself (two hours, kernel/index.ts · IDLE_KERNEL_MS): by that
 * time there is nobody left to write into the document.
 */
const MAX_IDLE_ROOM_MS = 3 * 60 * 60 * 1000

/** How often we look. A walk over the room map costs less than one edit frame. */
const ROOM_SWEEP_MS = 60 * 1000

/** Rooms someone keeps in memory on purpose, and how many holders. */
const holds = new Map<string, number>()

/**
 * Do not evict this room while it is held.
 *
 * For whoever has taken the `Y.Doc` in hand and works with it for longer than
 * one call: eviction destroys the document, and nobody sees a write into a
 * destroyed one — silently. Anything that takes the document through
 * `getSessionDoc` on every access must hold nothing: such a write will bring
 * the room up again.
 *
 * Returns "release". Calling it twice is safe.
 */
export function holdRoom(sessionId: string): () => void {
  holds.set(sessionId, (holds.get(sessionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (holds.get(sessionId) ?? 1) - 1
    if (left > 0) holds.set(sessionId, left)
    else holds.delete(sessionId)
  }
}

/**
 * Whether something is happening in the room that needs THIS document.
 *
 * Asked of the document itself, not of the kernel: importing the kernel from
 * here would tie the modules into a loop (the kernel takes the document here).
 * Everything listed is what the kernel writes into the document — the room
 * draws that it is busy by these same fields.
 */
function atWork(doc: Y.Doc): boolean {
  const meta = getMeta(doc)
  if (meta.get('runningCell') != null) return true
  const status = meta.get('kernelStatus')
  if (status === 'busy' || status === 'restarting') return true
  const queue = meta.get('queue')
  if (queue instanceof Y.Array && queue.length > 0) return true
  // A running oracle answer is written into the chat feed with the same clocks.
  return getChat(doc)
    .toArray()
    .some((turn) => turn.get('state') === 'streaming')
}

/**
 * Release empty rooms. Returns who was evicted — tests call it this way too.
 */
export function sweepIdleRooms(now: number = Date.now()): string[] {
  const gone: string[] = []
  for (const entry of [...docs.values()]) {
    if (entry.conns.size > 0 || entry.emptySince === 0) continue
    const empty = now - entry.emptySince
    if (empty < IDLE_ROOM_MS) continue
    if (empty < MAX_IDLE_ROOM_MS && (holds.has(entry.sessionId) || atWork(entry.doc))) continue
    evictRoom(entry)
    gone.push(entry.sessionId)
  }
  return gone
}

/**
 * Remove a room from memory without losing anything that was written.
 *
 * The order here is the whole point: first the open history row is written out
 * (it is somebody's work), then the document snapshot goes to disk, and only
 * after that is the document destroyed together with its observers and
 * presence.
 */
function evictRoom(entry: DocEntry): void {
  docs.delete(entry.sessionId)
  forgetHistory(entry.sessionId)
  // An unclosed presence window would outlive the document and fire into the
  // destroyed `awareness` a quarter of a second after the eviction.
  stopHeartbeat(entry)
  stopFaces(entry)
  entry.dispose()
  // And what the server remembered about cells deleted in it for Ctrl+Z: after
  // ten minutes of an empty room there is nobody left to undo.
  forgetSession(entry.sessionId)
  // And what the oracle remembered for undo: after ten minutes of an empty room
  // there is nobody left to restore for.
  forgetUndo(entry.sessionId)
  entry.doc.destroy()
  console.log(`[room ${entry.sessionId}] released from memory`)
}

/*
 * `unref`: cleanup must not keep the process alive — this module is imported
 * by tests and by one-off scripts.
 */
setInterval(() => sweepIdleRooms(), ROOM_SWEEP_MS).unref?.()

/**
 * Release a room's document without closing anything in it.
 *
 * The same exit as the idle cleanup, only on demand: it is used by a notebook
 * visitor (routes/doc-visit.ts) that brought up an empty room's document for
 * one line — a rename in the panel, reading the feed, a publication. There is
 * no point in waiting ten minutes of emptiness for such a notebook: it was not
 * anybody's for a single second.
 *
 * `dropSessionDoc` is broader than needed for this: it was written for a
 * torn-down seminar and closes its sockets and files. File sockets live in
 * their own map (collab/files.ts) and do not bring up the room's document, so a
 * `.py` open in the editor survives both the idle cleanup and a visit — while
 * `forgetFiles` would slam it with code 1001 "the room is closed" in the middle
 * of a live seminar.
 *
 * A room with someone in it is not evicted: its document is held by sockets,
 * and for them this would be the same as a teardown. Returns whether it was
 * released: `false` means either the document was not in memory or there are
 * people in the room.
 */
export function releaseSessionDoc(sessionId: string): boolean {
  const entry = docs.get(sessionId)
  if (!entry || entry.conns.size > 0) return false
  evictRoom(entry)
  return true
}

/**
 * Evict a session's document for good: used when the seminar itself is deleted.
 *
 * Everything here is about making the deletion stick. The binding is discarded
 * rather than disposed, because disposing flushes and the flush would write a
 * snapshot row back for a room that has just been removed; the sockets are
 * closed so a browser still standing in the room cannot keep editing a document
 * nobody will ever load again; and the doc is destroyed so its observers go with
 * it. Called before the rows are dropped, so nothing can write between the two.
 *
 * Letting go of a room nobody is in is a different door: `releaseSessionDoc`
 * above, which closes nothing. So every step added here may assume the seminar
 * is going away — that assumption is what the two doors buy.
 */
export function dropSessionDoc(sessionId: string): void {
  // The open files of this room are its own too: they must be written out and
  // closed before the folder disappears, otherwise the last save would create
  // it again.
  forgetFiles(sessionId)
  // And what the oracle remembered about it for undo: there is nowhere left to restore to.
  forgetUndo(sessionId)
  // And the oracle's running answers: there is nowhere to write them anymore,
  // and the stream itself would notice only on its next frame — no point in
  // paying for an answer to a torn-down room.
  abortSession(sessionId)
  const entry = docs.get(sessionId)
  if (!entry) return
  docs.delete(sessionId)
  // The notebook watcher is also a binding to this document, and its
  // projection timer would outlive the deletion: `dispose` does not fit here,
  // since it writes out a snapshot of a room that no longer exists.
  entry.unwatch()
  discardPersistence(sessionId)
  // The room is gone; an open burst describing it would be a version of nothing.
  discardBurst(sessionId)
  // And what the server remembered about cells deleted in it: nowhere to bring them back.
  forgetSession(sessionId)
  stopHeartbeat(entry)
  stopFaces(entry)
  for (const conn of Array.from(entry.conns.keys())) {
    entry.conns.delete(conn)
    try {
      conn.close(1001, tr("server.thisSeminarWasDeleted.daaaad"))
    } catch {
      /* already gone */
    }
  }
  entry.doc.destroy()
}

export function shutdownCollab(): void {
  for (const entry of docs.values()) {
    const people = new Map(Array.from(entry.conns.values()).filter(state => state.participantId).map(state => [state.participantId!, state]))
    for (const [id, state] of people) appendActivity(entry.sessionId, id, 'presence.left', {
      reason: 'server_shutdown', durationMs: Math.max(0, Date.now() - state.presenceStartedAt),
    }, state.role)
    stopHeartbeat(entry)
    stopFaces(entry)
    for (const conn of Array.from(entry.conns.keys())) {
      entry.conns.delete(conn)
      try {
        conn.close(1001, tr("server.serverShuttingDown.0df697"))
      } catch {
        /* already gone */
      }
    }
    entry.dispose()
  }
  docs.clear()
  flushAllPersistence()
  // The same for files: what was typed in the last half second is work, and
  // stopping the process is no reason to lose it.
  flushAllFiles()
  // Whatever somebody was typing when the process was told to stop is still a
  // thing they did, and the seminar may be reopened tomorrow.
  flushAllHistory()
}
