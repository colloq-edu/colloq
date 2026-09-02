import * as Y from 'yjs'
import { config } from '../config.js'
import { getSession, loadDocSnapshot, saveDocSnapshot } from '../db.js'

/**
 * Durability for session documents.
 *
 * We store one whole-document snapshot per session rather than an update log:
 * a seminar notebook is small, and a single row makes recovery trivial — the
 * process can be restarted mid-class and every notebook comes back intact.
 *
 * Writes are debounced because typing emits an update per keystroke, and the
 * debounce is capped because a lecturer who types for a solid minute must still
 * never have more than MAX_DEFER_MS of work exposed to a crash.
 *
 * A snapshot is also what makes a late joiner fast, so the cap is a promise:
 * everything below only decides *when* inside that window to spend the encode,
 * never whether the promise holds.
 */

/**
 * Hard ceiling on how old the oldest unsaved edit may get.
 *
 * Пять секунд, а не пятнадцать: это и есть окно потери при `kill -9`, OOM или
 * обесточивании — штатные выходы (SIGINT/SIGTERM/uncaughtException) флашат сами.
 * Пятнадцать секунд молчаливой потери — это абзац, набранный при всей комнате,
 * и вернувшийся сервер, который заставляет перезагрузить вкладки, чтобы его
 * стереть.
 *
 * Цена названа замером (encode + запись в SQLite, better-sqlite3): тетрадь на
 * 22 КБ — 0.5 мс, на 292 КБ — 2.4 мс, на 2.3 МБ — 6.8 мс. Потолок бьёт только
 * по большим тетрадям (маленькие пишутся по snapshotIntervalMs), так что
 * втрое чаще платит именно тот, у кого мегабайт: 6.8 мс раз в пять секунд —
 * 0.14% цикла событий. Дороже другое, и это осознанно: пока в такой тетради
 * печатают не переставая, в WAL уходит втрое больше байтов (2.3 МБ каждые пять
 * секунд), а сводится он раз в пять минут.
 */
const MAX_DEFER_MS = 5_000

/** Marks our own writes back into the doc so they don't schedule a re-save. */
const ORIGIN = 'persistence'

/** Below this the encode is too cheap to be worth deferring. */
const BACKOFF_FROM_BYTES = 128 * 1024

/**
 * Пауза перед повтором неудачной записи.
 *
 * Диск не освободится за миллисекунду, а спешить некуда: правки в памяти целы,
 * и повторять их можно сколько угодно. Без паузы повтор пошёл бы сразу —
 * дедлайн-то давно прошёл, — и переполненный диск дал бы горячий цикл.
 */
const RETRY_MS = 5_000

/** Snapshot timings, for the seminar that has quietly grown a 4 MB notebook. */
const DEBUG =
  (process.env.DEBUG ?? '').includes('colloq') || (process.env.LOG_LEVEL ?? '') === 'debug'

interface Binding {
  sessionId: string
  doc: Y.Doc
  onUpdate: (update: Uint8Array, origin: unknown, doc: Y.Doc, tr: Y.Transaction) => void
  timer: NodeJS.Timeout | null
  /** Timestamp of the oldest unsaved edit; 0 means the doc is clean. */
  dirtySince: number
  /** State of the stored snapshot: what was in it, and how big it was. */
  savedVector: Uint8Array | null
  savedBytes: number
  /** Transactions that deleted something, here and as of the last snapshot. */
  deletions: number
  savedDeletions: number
}

const bindings = new Map<string, Binding>()

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * How long an idle-but-dirty doc may wait. Encoding a large notebook is
 * milliseconds of event loop that every keystroke in the room queues behind, so
 * a big doc drifts toward the ceiling instead of paying that every few seconds.
 */
function intervalFor(bytes: number): number {
  if (bytes <= BACKOFF_FROM_BYTES) return config.snapshotIntervalMs
  return Math.min(Math.round(config.snapshotIntervalMs * (bytes / BACKOFF_FROM_BYTES)), MAX_DEFER_MS)
}

function write(binding: Binding): void {
  if (binding.timer) {
    clearTimeout(binding.timer)
    binding.timer = null
  }
  if (binding.dirtySince === 0) return

  // The last word on a deleted seminar. Anything still holding this document —
  // a kernel shutting down, a socket that has not noticed yet — would otherwise
  // put the room back on disk seconds after the owner destroyed it, and a
  // snapshot with no session row is a file nobody can reach or remove.
  if (!getSession(binding.sessionId)) {
    binding.dirtySince = 0
    return
  }

  // Two questions, because Yjs answers "what changed?" in two places: inserts
  // advance a client's clock and show up in the state vector, deletions never
  // do — they only add ranges to the delete set. Skipping on the vector alone
  // would silently drop a deleted cell from the snapshot.
  const vector = Y.encodeStateVector(binding.doc)
  if (
    binding.savedVector &&
    binding.deletions === binding.savedDeletions &&
    sameBytes(vector, binding.savedVector)
  ) {
    binding.dirtySince = 0
    return
  }

  try {
    const began = process.hrtime.bigint()
    const update = Y.encodeStateAsUpdate(binding.doc)
    saveDocSnapshot(binding.sessionId, update)
    /*
     * Чистым документ делает удачная запись, а не попытка.
     *
     * Стояло выше, до записи, — и ошибка sqlite (диск полон, ввод-вывод,
     * занятая база) молча оставляла комнату «сохранённой»: ни таймер, ни flush
     * на выходе к ней больше не возвращались, потому что все они выходят на
     * `dirtySince === 0`. Класс, в котором после сбоя никто больше не
     * напечатал ни символа, доезжал до `make down` без последних правок.
     */
    binding.dirtySince = 0
    binding.savedVector = vector
    binding.savedDeletions = binding.deletions
    binding.savedBytes = update.byteLength
    if (DEBUG) {
      const ms = Number(process.hrtime.bigint() - began) / 1e6
      console.debug(
        `[persistence] ${binding.sessionId} snapshot ${update.byteLength}B in ${ms.toFixed(1)}ms`,
      )
    }
  } catch (err) {
    // Losing a snapshot must not take the live session down with it.
    console.error(`[persistence] snapshot failed for ${binding.sessionId}`, err)
    // Документ остался грязным — значит, будет и повтор. Только пока привязка
    // жива: у отпущенной (комнату закрыли и открыли заново) документ уже не
    // тот, и запись поверх свежего снимка была бы откатом.
    binding.timer = setTimeout(() => {
      if (bindings.get(binding.sessionId) === binding) write(binding)
    }, RETRY_MS)
    binding.timer.unref?.()
  }
}

function schedule(binding: Binding): void {
  const now = Date.now()
  if (binding.dirtySince === 0) binding.dirtySince = now
  const deadline = binding.dirtySince + MAX_DEFER_MS
  // The deadline is measured from the oldest unsaved edit and clamps the
  // backoff, so a bigger notebook waits longer but never past the ceiling.
  const delay = Math.max(0, Math.min(intervalFor(binding.savedBytes), deadline - now))
  if (binding.timer) clearTimeout(binding.timer)
  /*
   * unref: a pending snapshot must not be the reason a process stays alive. The
   * server is kept up by its listening socket and shutdownCollab() flushes on
   * the way out, so nothing is lost — while without it any script that so much
   * as reads a document hangs for the length of the interval, which is exactly
   * how the unit suite came to take three minutes to print anything.
   */
  binding.timer = setTimeout(() => write(binding), delay)
  binding.timer.unref?.()
}

/**
 * Hydrate `doc` from its stored snapshot and keep writing it back as it changes.
 * Returns a disposer that flushes synchronously and stops observing.
 */
export function bindPersistence(sessionId: string, doc: Y.Doc): () => void {
  const previous = bindings.get(sessionId)
  if (previous) {
    write(previous)
    previous.doc.off('update', previous.onUpdate)
    bindings.delete(sessionId)
  }

  const binding: Binding = {
    sessionId,
    doc,
    onUpdate: () => {},
    timer: null,
    dirtySince: 0,
    savedVector: null,
    savedBytes: 0,
    deletions: 0,
    savedDeletions: 0,
  }
  binding.onUpdate = (_update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
    if (origin === ORIGIN) return
    if (tr.deleteSet.clients.size > 0) binding.deletions++
    schedule(binding)
  }

  const snapshot = loadDocSnapshot(sessionId)
  if (snapshot) {
    Y.applyUpdate(doc, snapshot, ORIGIN)
    // Read the vector out of the stored bytes, not out of the doc: this has to
    // describe what is on disk. If the doc were handed to us with content the
    // snapshot never had, the two differ and the next edit writes, as it must.
    binding.savedVector = Y.encodeStateVectorFromUpdate(snapshot)
    binding.savedBytes = snapshot.byteLength
  }

  doc.on('update', binding.onUpdate)
  bindings.set(sessionId, binding)

  return () => {
    if (bindings.get(sessionId) !== binding) return
    bindings.delete(sessionId)
    doc.off('update', binding.onUpdate)
    write(binding)
  }
}

/**
 * Stop persisting a session and write nothing — the opposite of the disposer
 * above, which flushes on its way out. The only caller is a seminar being
 * deleted: flushing there would write a snapshot row for a room that no longer
 * exists, which is exactly the state the delete was for.
 */
export function discardPersistence(sessionId: string): void {
  const binding = bindings.get(sessionId)
  if (!binding) return
  bindings.delete(sessionId)
  if (binding.timer) clearTimeout(binding.timer)
  binding.doc.off('update', binding.onUpdate)
}

/**
 * Write one document's snapshot now, without waiting for the debounce.
 *
 * The debounce exists for typing, where a snapshot per keystroke would be
 * absurd. A brand-new room is the opposite case: it holds two starter cells and
 * nothing else, the encode is under a millisecond, and until those bytes are on
 * disk the room does not exist as far as a crash is concerned — the server
 * comes back, finds no snapshot, decides the room is new and seeds the starter
 * cells a second time. The returning clients then merge their real notebook in
 * on top and the room opens with two Welcome cells.
 */
export function flushPersistence(sessionId: string): void {
  const binding = bindings.get(sessionId)
  if (binding) write(binding)
}

/** Last-chance save for every live document, called on shutdown. */
export function flushAllPersistence(): void {
  for (const binding of bindings.values()) write(binding)
}
