/**
 * Everything this browser keeps about a seminar between visits.
 *
 * The seminar document itself lives in IndexedDB, so reopening a room replays
 * the real notebook from disk in a few milliseconds instead of waiting on a
 * websocket to open, handshake and sync. The network is no longer what stands
 * between a student and their cells — it only merges into what is already
 * on screen.
 *
 * Nothing here is ever a gate. Storage can be missing (private windows),
 * blocked (enterprise policy) or simply silent (a permission prompt nobody
 * answered), and in every one of those cases Colloq must still open.
 */
import { clearDocument, IndexeddbPersistence } from 'y-indexeddb'
import type * as Y from 'yjs'
import type { SessionInfo } from '@shared/protocol'

export interface LocalStore {
  /** Resolves when the stored document has been replayed into the Y.Doc. */
  whenSynced: Promise<void>
  destroy(): void
  clear(): Promise<void>
}

/** One database per seminar, so forgetting one room never touches another. */
function dbName(sessionId: string): string {
  return `colloq.session.${sessionId}`
}

/**
 * A browser that never answers is worse than one that says no: an unanswered
 * storage prompt would otherwise leave every waiter pending forever.
 */
const REPLAY_DEADLINE = 3000

const DONE: Promise<void> = Promise.resolve()

function noopStore(): LocalStore {
  return { whenSynced: DONE, destroy() {}, clear: () => DONE }
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    // Sandboxed iframes throw on the property access itself, not on use.
    return false
  }
}

/** Bounds a promise that a hostile storage stack may never settle. */
function deadline<T>(promise: Promise<T>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    const settle = () => {
      clearTimeout(timer)
      resolve()
    }
    promise.then(settle, settle)
  })
}

/**
 * Mirror `doc` into IndexedDB and replay whatever is already there.
 *
 * Call this before opening the network provider: both write into the same
 * CRDT, and whichever answers first is what the student sees.
 */
export function bindLocalStore(sessionId: string, doc: Y.Doc): LocalStore {
  if (!hasIndexedDb()) return noopStore()

  let store: IndexeddbPersistence
  try {
    store = new IndexeddbPersistence(dbName(sessionId), doc)
  } catch {
    return noopStore()
  }

  // y-indexeddb leaves a failed open on an internal promise it never catches,
  // which would surface as an unhandled rejection on every load in a browser
  // with storage switched off.
  store._db.catch(() => {})

  const whenSynced = deadline(store.whenSynced, REPLAY_DEADLINE)
  let closed = false

  return {
    whenSynced,
    destroy() {
      if (closed) return
      closed = true
      // Updates are written as they happen, so there is nothing to flush here
      // and no keystroke to lose.
      store.destroy().catch(() => {})
    },
    clear() {
      closed = true
      return store.clearData().catch(() => {})
    },
  }
}

/**
 * Drop every local trace of a seminar. Used when the server says the room is
 * gone: a cache must never strand somebody in a room that no longer exists.
 */
export async function forgetLocalStore(sessionId: string): Promise<void> {
  forgetSessionInfo(sessionId)
  if (!hasIndexedDb()) return
  try {
    // deleteDatabase stays blocked while another tab still holds the room open.
    await deadline(clearDocument(dbName(sessionId)), REPLAY_DEADLINE)
  } catch {
    /* nothing left to forget */
  }
}

/* ------------------------------------------------------------- room card */

/**
 * The seminar's identity card, remembered so a return visit can mount the room
 * before the network confirms it exists. Small, so localStorage is the right
 * shape: it is readable synchronously, during the first render.
 *
 * This is a cache, never a source of truth — the name shown in the header comes
 * from the CRDT the moment the document replays.
 */
const ROOM_KEY = 'colloq.room.v1'

type RoomMap = Record<string, SessionInfo>

function readRooms(): RoomMap {
  try {
    const raw = localStorage.getItem(ROOM_KEY)
    return raw ? (JSON.parse(raw) as RoomMap) : {}
  } catch {
    return {}
  }
}

function writeRooms(rooms: RoomMap): void {
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify(rooms))
  } catch {
    /* private browsing; the next visit just waits for the fetch again */
  }
}

export function recallSessionInfo(sessionId: string): SessionInfo | null {
  const room = readRooms()[sessionId]
  return room && room.id === sessionId ? room : null
}

export function rememberSessionInfo(session: SessionInfo): void {
  const rooms = readRooms()
  const known = rooms[session.id]
  if (known && known.name === session.name && known.createdAt === session.createdAt) return
  rooms[session.id] = session
  writeRooms(rooms)
}

export function forgetSessionInfo(sessionId: string): void {
  const rooms = readRooms()
  if (!(sessionId in rooms)) return
  delete rooms[sessionId]
  writeRooms(rooms)
}
