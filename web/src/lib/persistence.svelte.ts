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
import { forgetSessionInfo } from './session-cache'
export { recallSessionInfo, rememberSessionInfo, forgetSessionInfo } from './session-cache'

export interface LocalStore {
  /** Resolves when the stored document has been replayed into the Y.Doc. */
  whenSynced: Promise<void>
  /** Identifies updates replayed or merged by this IndexedDB binding. */
  isReplay(origin: unknown): boolean
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
  return { whenSynced: DONE, isReplay: () => false, destroy() {}, clear: () => DONE }
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
    isReplay: (origin) => origin === store,
    destroy() {
      if (closed) return
      closed = true
      // Updates are written as they happen, so there is nothing to flush here
      // and no keystroke to lose.
      store.destroy().catch(() => {})
    },
    clear() {
      closed = true
      return deadline(wipe(store, dbName(sessionId)), REPLAY_DEADLINE)
    },
  }
}

/**
 * Стереть кэш комнаты так, чтобы следующая загрузка ничего не переиграла.
 *
 * Не `clearData()` библиотеки. Та удаляет базу целиком, а удаление базы ждёт,
 * пока её закроет КАЖДАЯ вкладка: соседняя вкладка того же семинара держит её
 * открытой, и обещание не исполняется никогда — кэш переигрывается, сервер
 * отказывает снова, и на второй перезагрузке вкладка сдаётся. Вдобавок
 * библиотека не ждёт и своего удаления: страница перезагружалась, пока запрос
 * ещё стоял в очереди. Очистка хранилищ ВНУТРИ базы не ждёт никого и
 * заканчивается до того, как отсюда вернутся.
 */
async function wipe(store: IndexeddbPersistence, name: string): Promise<void> {
  await store.destroy().catch(() => {})
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(name)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      // Базы не было — заводить пустую нельзя: библиотека открывает без версии
      // и хранилищ в такой не создаст, а без них не сможет ни читать, ни писать.
      request.transaction?.abort()
      resolve(null)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  if (!db) return
  try {
    const names = Array.from(db.objectStoreNames)
    if (names.length === 0) return
    await new Promise<void>((resolve) => {
      const tx = db.transaction(names, 'readwrite')
      for (const store of names) tx.objectStore(store).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } finally {
    db.close()
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
