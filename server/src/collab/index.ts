import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { Awareness } from 'y-protocols/awareness'
import { WebSocket, type RawData } from 'ws'
import { ensureInitialNotebook } from '@shared/notebook'
import { getSession } from '../db.js'
import { bindPersistence, discardPersistence, flushAllPersistence } from './persistence.js'

/**
 * The server side of the collaborative document.
 *
 * This speaks the y-websocket wire protocol (the browser uses the stock
 * `WebsocketProvider`), but it is not a dumb relay: the server holds the
 * authoritative Y.Doc in memory and is a first-class writer. The kernel runtime
 * appends execution output straight into that doc, which is how results reach
 * everyone — including whoever opens the link two minutes later.
 */

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const PING_INTERVAL_MS = 25_000
/** A socket that ignores this many consecutive pings is a closed laptop lid. */
const MAX_MISSED_PONGS = 2

export interface SessionDoc {
  sessionId: string
  doc: Y.Doc
  awareness: Awareness
}

interface ConnState {
  /** Awareness clientIDs this socket introduced, so we can retract exactly those. */
  clientIds: Set<number>
  missedPongs: number
  pingTimer: NodeJS.Timeout
}

interface DocEntry extends SessionDoc {
  conns: Map<WebSocket, ConnState>
  dispose: () => void
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

function send(entry: DocEntry, conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
    closeConn(entry, conn)
    return
  }
  try {
    conn.send(message, (err) => {
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
  clearInterval(state.pingTimer)
  // Without this the People panel keeps showing whoever just walked out.
  awarenessProtocol.removeAwarenessStates(entry.awareness, Array.from(state.clientIds), null)
  try {
    conn.close()
  } catch {
    /* already gone */
  }
}

function broadcastDocUpdate(entry: DocEntry, update: Uint8Array, origin: unknown): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)
  for (const conn of entry.conns.keys()) {
    // Origin is a connection only for edits that arrived on it; server-side
    // writes (kernel output, AI edits) carry another origin and go to everyone.
    if (conn === origin) continue
    send(entry, conn, message)
  }
}

function broadcastAwareness(entry: DocEntry, clients: number[]): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(entry.awareness, clients),
  )
  const message = encoding.toUint8Array(encoder)
  for (const conn of entry.conns.keys()) send(entry, conn, message)
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
  }
  docs.set(sessionId, entry)

  ensureInitialNotebook(doc, title ?? getSession(sessionId)?.name)

  doc.on('update', (update: Uint8Array, origin: unknown) =>
    broadcastDocUpdate(entry, update, origin),
  )

  awareness.on(
    'update',
    (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const state = origin instanceof WebSocket ? entry.conns.get(origin) : undefined
      if (state) {
        for (const id of changes.added) state.clientIds.add(id)
        for (const id of changes.removed) state.clientIds.delete(id)
      }
      broadcastAwareness(entry, changes.added.concat(changes.updated, changes.removed))
    },
  )

  return entry
}

function handleMessage(entry: DocEntry, conn: WebSocket, data: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(data)
    const encoder = encoding.createEncoder()
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, conn)
        // A bare message type and nothing after it means there is nothing to say.
        if (encoding.length(encoder) > 1) send(entry, conn, encoding.toUint8Array(encoder))
        break
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          entry.awareness,
          decoding.readVarUint8Array(decoder),
          conn,
        )
        break
      }
    }
  } catch (err) {
    // One malformed frame should cost that socket its message, not the seminar.
    console.error(`[collab] bad message in ${entry.sessionId}`, err)
  }
}

export function handleCollabSocket(ws: WebSocket, sessionId: string): void {
  const entry = getEntry(sessionId)
  ws.binaryType = 'arraybuffer'

  const state: ConnState = {
    clientIds: new Set<number>(),
    missedPongs: 0,
    pingTimer: setInterval(() => {
      if (state.missedPongs >= MAX_MISSED_PONGS) {
        closeConn(entry, ws)
        ws.terminate()
        return
      }
      state.missedPongs++
      try {
        ws.ping()
      } catch {
        closeConn(entry, ws)
        ws.terminate()
      }
    }, PING_INTERVAL_MS),
  }
  entry.conns.set(ws, state)

  ws.on('pong', () => {
    state.missedPongs = 0
  })
  ws.on('message', (data: RawData) => handleMessage(entry, ws, toUint8Array(data)))
  ws.on('close', () => closeConn(entry, ws))
  ws.on('error', () => closeConn(entry, ws))

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, entry.doc)
  send(entry, ws, encoding.toUint8Array(encoder))

  const states = entry.awareness.getStates()
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(entry.awareness, Array.from(states.keys())),
    )
    send(entry, ws, encoding.toUint8Array(awarenessEncoder))
  }
}

/** Open sockets, not distinct people — a second tab counts twice. */
export function onlineCount(sessionId: string): number {
  return docs.get(sessionId)?.conns.size ?? 0
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
 */
export function dropSessionDoc(sessionId: string): void {
  const entry = docs.get(sessionId)
  if (!entry) return
  docs.delete(sessionId)
  discardPersistence(sessionId)
  for (const conn of Array.from(entry.conns.keys())) {
    const state = entry.conns.get(conn)
    if (state) clearInterval(state.pingTimer)
    entry.conns.delete(conn)
    try {
      conn.close(1001, 'this seminar was deleted')
    } catch {
      /* already gone */
    }
  }
  entry.doc.destroy()
}

export function shutdownCollab(): void {
  for (const entry of docs.values()) {
    for (const conn of Array.from(entry.conns.keys())) {
      const state = entry.conns.get(conn)
      if (state) clearInterval(state.pingTimer)
      entry.conns.delete(conn)
      try {
        conn.close(1001, 'server shutting down')
      } catch {
        /* already gone */
      }
    }
    entry.dispose()
  }
  docs.clear()
  flushAllPersistence()
}
