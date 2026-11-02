import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { noteRoomDoc } from '../blobs.js'
import { config } from '../config.js'
import { db, loadDocSnapshot, saveDocSnapshot } from '../db.js'

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
 *
 * THE TAIL. A full copy every five seconds is the price of this simplicity, and
 * whoever has a big notebook pays it: as long as the room keeps typing, a
 * two-megabyte document went into the WAL twelve times a minute, that is
 * twenty-six megabytes a minute for a few kilobytes of real edits (the WAL is
 * checkpointed once every five minutes). So between full copies we write a
 * TAIL — the difference from the last snapshot, as a file next to the database
 * (`<DATA_DIR>/doc-tail/<room>.bin`), bypassing the WAL and any garbage
 * collection. A full copy is written no more than once per FULL_EVERY_MS, and
 * also on a lull, on an explicit flush and on exit.
 *
 * The promise stays exactly the same, and that is the main thing here:
 * snapshot plus tail is the document, and the tail is written on the old
 * deadline. The loss window on `kill -9` has not grown by a millisecond; only
 * the distance between full copies has.
 */

/**
 * Hard ceiling on how old the oldest unsaved edit may get.
 *
 * Five seconds, not fifteen: this is the loss window on `kill -9`, OOM or a
 * power cut — regular exits (SIGINT/SIGTERM/uncaughtException) flush on their
 * own. Fifteen seconds of silent loss is a paragraph typed in front of the
 * whole room, and a server that comes back and forces the tabs to reload, only
 * to erase it.
 *
 * The cost is measured (encode + write to SQLite, better-sqlite3): a 22 KB
 * notebook takes 0.5 ms, 292 KB — 2.4 ms, 2.3 MB — 6.8 ms. The ceiling only
 * hits big notebooks (small ones are written on snapshotIntervalMs), so it is
 * precisely the owner of the megabyte who pays three times as often: 6.8 ms
 * every five seconds is 0.14% of the event loop. What costs more is something
 * else, and it is deliberate: while such a notebook is typed in nonstop, three
 * times as many bytes go into the WAL (2.3 MB every five seconds), and the WAL
 * is checkpointed only once every five minutes.
 */
const MAX_DEFER_MS = 5_000

/**
 * How often the document goes to disk WHOLE while the room is typing.
 *
 * Thirty seconds is about space and the WAL, not about durability: between
 * full copies the disk holds the tail (see the header), and it is written on
 * the old five-second deadline. The reasoning goes like this: a full copy has
 * to be rare enough that its cost does not depend on whether the room is
 * typing, and frequent enough that the tail does not grow to the size of the
 * document itself. Over half a minute of continuous typing the tail is tens of
 * kilobytes against the document's megabytes.
 */
const FULL_EVERY_MS = 30_000

/**
 * How much silence counts as a lull: after it the document is written whole.
 *
 * A room that has stopped typing is the cheapest moment for a full copy, and
 * the most correct one: there is no tail after it at all, and the one to load
 * such a room will be whoever enters it tomorrow. Longer than the debounce
 * window and noticeably shorter than half a minute: that is exactly the pause
 * between exercises.
 */
const SETTLE_MS = 10_000

/** Marks our own writes back into the doc so they don't schedule a re-save. */
const ORIGIN = 'persistence'

/** Below this the encode is too cheap to be worth deferring. */
const BACKOFF_FROM_BYTES = 128 * 1024

/**
 * Pause before retrying a failed write.
 *
 * The disk will not free up in a millisecond, and there is no hurry: the edits
 * in memory are intact and can be retried as often as needed. Without a pause
 * the retry would fire at once — the deadline passed long ago — and a full
 * disk would produce a hot loop.
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
  /** Lull timer: a full copy once the room stops typing. */
  settleTimer: NodeJS.Timeout | null
  /** Timestamp of the oldest unsaved edit; 0 means the doc is clean. */
  dirtySince: number
  /** State of what is durable — snapshot plus tail — and how big the snapshot was. */
  savedVector: Uint8Array | null
  savedBytes: number
  /**
   * What is in the snapshot row itself, and when it was written there.
   *
   * Separate from `savedVector`: the tail is computed as the difference from
   * THAT, not from whatever is durable in general. Without this split a second
   * tail in a row would describe the difference from the first tail — and
   * recovery after a crash would depend on which of them made it to disk.
   */
  snapshotVector: Uint8Array | null
  snapshotAt: number
  /** Which snapshot row that is — the name every tail written now carries (see `TAIL_MAGIC`). */
  snapshotDigest: Uint8Array
  /** Whether a tail is currently on disk. */
  tailed: boolean
  /** Transactions that deleted something, here and as of the last snapshot. */
  deletions: number
  savedDeletions: number
}

const bindings = new Map<string, Binding>()

/** Process-lifetime counters; never retain a room identifier or exception. */
let saveFailures = 0
let lastFailureAt: number | null = null

function recordSaveFailure(): void {
  saveFailures = Math.min(Number.MAX_SAFE_INTEGER, saveFailures + 1)
  lastFailureAt = Date.now()
}

export interface PersistenceDiagnostics {
  documents: number
  dirtyDocuments: number
  oldestUnsavedMs: number
  saveFailures: number
  lastFailureAt: number | null
}

/** Aggregate pending durability, suitable for operator status without document data. */
export function persistenceDiagnostics(): PersistenceDiagnostics {
  const now = Date.now()
  let dirtyDocuments = 0
  let oldestUnsavedMs = 0
  for (const binding of bindings.values()) {
    if (binding.dirtySince === 0) continue
    dirtyDocuments += 1
    oldestUnsavedMs = Math.max(oldestUnsavedMs, now - binding.dirtySince)
  }
  return { documents: bindings.size, dirtyDocuments, oldestUnsavedMs, saveFailures, lastFailureAt }
}

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

/**
 * Whether the seminar row exists — by an honest SELECT, bypassing the room
 * cache.
 *
 * `getSession` now answers from memory (db.ts · roomCache), and on the
 * handshake that is right: five hundred tabs ask the same thing within a
 * second. Here the same question stands differently — this is the last barrier
 * before a snapshot of a deleted seminar, and the cost of a mistake is
 * asymmetric. A cache miss costs one primary-key SELECT every few seconds per
 * room — nothing at all; a forgotten invalidation in a new deletion path would
 * put the class's notebook back on disk, and no door leads any more to a
 * snapshot without a seminar row: it can be neither opened nor deleted. Let
 * this check hold on its own, rather than by every writer remembering
 * `forgetRoom`.
 *
 * This module still cannot write to `sessions`: there is one door for writes,
 * and it is in db.ts.
 */
const selectSessionRow = db.prepare('SELECT 1 FROM sessions WHERE id = ?')

function sessionRowExists(sessionId: string): boolean {
  try {
    return selectSessionRow.get(sessionId) !== undefined
  } catch {
    // A database that cannot even be read cannot say the room is gone, and a
    // wrong "gone" throws away its edits. Whatever then gets written for a room
    // deleted after all is an orphan the startup sweep removes (sweepOrphanTails).
    return true
  }
}

/* ------------------------------------------------------------------- tail */

/**
 * The difference from the last full snapshot — a file next to the database.
 *
 * A file, not an SQLite row: a row would mean a write to the WAL, which is
 * exactly the cost the tail exists to avoid. The name is the room; the content
 * is an ordinary Yjs update that only has to be applied on top of the
 * snapshot.
 *
 * Written through a temporary file: recovery after a crash reads it first
 * thing, and a half-written tail is not "we lost five seconds" but "the room
 * does not come up".
 */
const TAIL_DIR = 'doc-tail'
const ROOM_OK = /^[A-Za-z0-9_-]{1,64}$/

function tailPath(sessionId: string): string | null {
  if (!ROOM_OK.test(sessionId)) return null
  return path.join(config.dataDir, TAIL_DIR, `${sessionId}.bin`)
}

/*
 * A tail names the snapshot it is the difference from.
 *
 * A tail on its own is only half of a document, and it used to be applied to
 * whatever snapshot row it found. That is right as long as the two were
 * written by one process one after the other, and wrong the moment the
 * database is swapped under them: an older database restored from a backup
 * picked up the tail of the newer one and opened as "the backup plus edits
 * made after it" — and a deletion in that tail erased exactly the text the
 * restore was for. A database copied a second apart from the tails pairs a
 * snapshot with a tail of a different one just the same, and then Yjs parks
 * whatever the tail builds on in pending and the notebook opens short,
 * silently.
 *
 * So the file starts with a mark and the digest of the snapshot row it was
 * computed against, and a tail is applied only to that row. A mismatch is not
 * an error to recover from: either the snapshot is newer (the process died
 * between writing it and removing the tail — the snapshot already holds
 * everything) or it is a different timeline altogether (a restore) — in both
 * cases applying it would be the mistake. A file without the mark was written
 * before this rule and is applied as before, once.
 *
 * The mark cannot be mistaken for a bare update: a Yjs update starts with the
 * count of clients it carries, and 0xFF 0x43 … reads as tens of thousands.
 */
const TAIL_MAGIC = Buffer.from([0xff, 0x43, 0x51, 0x54, 0x41, 0x49, 0x4c, 0x31]) // \xffCQTAIL1
const DIGEST_BYTES = 16
/** The name of "no snapshot row": a tail written for a room the database has never held. */
const NO_SNAPSHOT = new Uint8Array(DIGEST_BYTES)

function digestOf(snapshot: Uint8Array | null): Uint8Array {
  if (!snapshot) return NO_SNAPSHOT
  return new Uint8Array(createHash('sha256').update(snapshot).digest().subarray(0, DIGEST_BYTES))
}

function writeTail(sessionId: string, base: Uint8Array, update: Uint8Array): boolean {
  const file = tailPath(sessionId)
  if (!file) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, Buffer.concat([TAIL_MAGIC, base, update]), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    console.error(`[persistence] tail write failed for ${sessionId}`, err)
    return false
  }
}

/** The tail on disk and the snapshot it names; `base` is null for a tail from before the mark. */
function readTail(sessionId: string): { base: Uint8Array | null; update: Uint8Array } | null {
  const file = tailPath(sessionId)
  if (!file) return null
  let body: Buffer
  try {
    body = fs.readFileSync(file)
  } catch {
    return null
  }
  const head = TAIL_MAGIC.length + DIGEST_BYTES
  if (body.length >= head && body.subarray(0, TAIL_MAGIC.length).equals(TAIL_MAGIC)) {
    const update = body.subarray(head)
    if (update.length === 0) return null
    return {
      base: new Uint8Array(body.subarray(TAIL_MAGIC.length, head)),
      update: new Uint8Array(update),
    }
  }
  return body.length > 0 ? { base: null, update: new Uint8Array(body) } : null
}

/**
 * What the next open will load for a room: its snapshot row and the tail that
 * belongs to it — the same pair `bindPersistence` applies, for code (and
 * tests) that has to read a room's durable state without opening it.
 */
export function readPersisted(sessionId: string): { snapshot: Uint8Array | null; tail: Uint8Array | null } {
  const snapshot = loadDocSnapshot(sessionId)
  const tail = readTail(sessionId)
  const belongs = tail && (!tail.base || sameBytes(tail.base, digestOf(snapshot)))
  return { snapshot, tail: belongs ? tail.update : null }
}

/**
 * Remove the tail — always AFTER the full copy has been written.
 *
 * The order here is the durability promise itself: the process may die
 * between writing the snapshot and removing the tail, and then the old tail is
 * applied on top of the new snapshot. That spoils nothing — it describes what
 * the snapshot already has, and applying an update a second time does nothing
 * in Yjs. The reverse order would leave a window in which the disk holds
 * neither.
 */
function dropTail(sessionId: string): void {
  const file = tailPath(sessionId)
  if (!file) return
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* a tail that was not removed is applied once more and changes nothing */
  }
}

/**
 * The whole document as one row, after which there is no tail.
 *
 * Order: the snapshot row first, then removing the tail (why exactly this way,
 * see `dropTail`). Returns how much the copy weighed.
 */
function full(binding: Binding, vector: Uint8Array): number {
  const update = Y.encodeStateAsUpdate(binding.doc)
  saveDocSnapshot(binding.sessionId, update)
  binding.snapshotDigest = digestOf(update)
  if (binding.tailed) {
    dropTail(binding.sessionId)
    binding.tailed = false
  }
  binding.dirtySince = 0
  binding.savedVector = vector
  binding.savedDeletions = binding.deletions
  binding.savedBytes = update.byteLength
  binding.snapshotVector = vector
  binding.snapshotAt = Date.now()
  if (binding.settleTimer) {
    clearTimeout(binding.settleTimer)
    binding.settleTimer = null
  }
  return update.byteLength
}

/**
 * Everything the snapshot row lacks, as a tail — when the row itself cannot
 * be written.
 *
 * The last resort of a room that is leaving memory or a process that is
 * exiting while the database refuses writes (a full disk, a read-only file,
 * an I/O error): the tail goes to a plain file next to the database, past
 * SQLite, so a database that is the thing failing does not take the room's
 * last edits with it. Snapshot plus tail is the document, so this is as
 * durable as a full copy — only bigger to load next time, and the first full
 * copy after that folds it in. Returns whether the document is on disk now.
 */
function spill(binding: Binding): boolean {
  if (!sessionRowExists(binding.sessionId)) return true
  const vector = Y.encodeStateVector(binding.doc)
  const tail = Y.encodeStateAsUpdate(binding.doc, binding.snapshotVector ?? undefined)
  if (!writeTail(binding.sessionId, binding.snapshotDigest, tail)) return false
  binding.tailed = true
  binding.dirtySince = 0
  binding.savedVector = vector
  binding.savedDeletions = binding.deletions
  return true
}

/** Write the room whole once people stop typing in it. */
function settle(binding: Binding): void {
  if (binding.settleTimer) clearTimeout(binding.settleTimer)
  binding.settleTimer = setTimeout(() => {
    binding.settleTimer = null
    if (bindings.get(binding.sessionId) !== binding) return
    // A dirty document will be written in due course by the ordinary write —
    // which by now has either already happened or is about to, on its deadline.
    if (binding.dirtySince !== 0 || !binding.tailed) return
    if (!sessionRowExists(binding.sessionId)) return
    try {
      full(binding, Y.encodeStateVector(binding.doc))
    } catch (err) {
      recordSaveFailure()
      console.error(`[persistence] snapshot on settle failed for ${binding.sessionId}`, err)
    }
  }, SETTLE_MS)
  binding.settleTimer.unref?.()
}

/**
 * Bring the disk up to the document. Returns whether it is there now — written
 * just now, already there, or nothing to write for a room that no longer
 * exists; `false` means the edits are only in memory, and a retry is set.
 */
function write(binding: Binding, force = false): boolean {
  if (binding.timer) {
    clearTimeout(binding.timer)
    binding.timer = null
  }
  if (binding.dirtySince === 0) {
    // A clean document with a tail on disk is a room that has stopped typing:
    // the cheapest moment to write it whole and remove the tail.
    if (force && binding.tailed && sessionRowExists(binding.sessionId)) {
      try {
        full(binding, Y.encodeStateVector(binding.doc))
      } catch (err) {
        recordSaveFailure()
        console.error(`[persistence] snapshot failed for ${binding.sessionId}`, err)
      }
    }
    // Clean means snapshot plus tail already is the document: a full copy
    // that did not happen is a missed tidy-up, not a loss.
    return true
  }

  // The last word on a deleted seminar. Anything still holding this document —
  // a kernel shutting down, a socket that has not noticed yet — would otherwise
  // put the room back on disk seconds after the owner destroyed it, and a
  // snapshot with no session row is a file nobody can reach or remove.
  if (!sessionRowExists(binding.sessionId)) {
    binding.dirtySince = 0
    if (binding.tailed) {
      dropTail(binding.sessionId)
      binding.tailed = false
    }
    return true
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
    return true
  }

  /*
   * As a tail or whole — depending on how long ago the full copy was written.
   *
   * A room's first write is always full: there is nothing to diff against.
   * After that, while the room is typing, tails go out, and every half minute
   * a full copy, after which the tail starts over and so does not grow.
   */
  const now = Date.now()
  const canTail =
    !force && binding.snapshotVector !== null && now - binding.snapshotAt < FULL_EVERY_MS

  try {
    const began = process.hrtime.bigint()
    if (canTail) {
      const tail = Y.encodeStateAsUpdate(binding.doc, binding.snapshotVector!)
      if (!writeTail(binding.sessionId, binding.snapshotDigest, tail)) throw new Error('tail write failed')
      binding.tailed = true
      binding.dirtySince = 0
      binding.savedVector = vector
      binding.savedDeletions = binding.deletions
      /*
       * A full copy — once people stop typing.
       *
       * Without it a room that fell silent in the middle of a tail would stay a
       * half-hour-old snapshot plus a file next to it: that loads correctly,
       * but the extra file would outlive both the end of the class and a
       * restart. The timer is cleared by the very next write.
       */
      settle(binding)
      if (DEBUG) {
        const ms = Number(process.hrtime.bigint() - began) / 1e6
        console.debug(
          `[persistence] ${binding.sessionId} tail ${tail.byteLength}B in ${ms.toFixed(1)}ms`,
        )
      }
    } else {
      /*
       * A document is made clean by a successful write, not by an attempt.
       *
       * This used to sit above, before the write — and an sqlite error (disk
       * full, I/O, a busy database) silently left the room "saved": neither the
       * timer nor the flush on exit ever came back to it, because they all bail
       * out on `dirtySince === 0`. A class in which nobody typed another
       * character after the failure reached `make down` without its last
       * edits.
       */
      const bytes = full(binding, vector)
      if (DEBUG) {
        const ms = Number(process.hrtime.bigint() - began) / 1e6
        console.debug(
          `[persistence] ${binding.sessionId} snapshot ${bytes}B in ${ms.toFixed(1)}ms`,
        )
      }
    }
  } catch (err) {
    // Tail writes return false to this same boundary: count the failed save
    // once, regardless of whether persistence selected a snapshot or a tail.
    recordSaveFailure()
    // Losing a snapshot must not take the live session down with it.
    console.error(`[persistence] snapshot failed for ${binding.sessionId}`, err)
    // The document stayed dirty, so there will be a retry. Only while the
    // binding is alive: for a released one (the room was closed and opened
    // again) the document is no longer the same one, and writing over the
    // fresh snapshot would be a rollback.
    binding.timer = setTimeout(() => {
      if (bindings.get(binding.sessionId) === binding) write(binding)
    }, RETRY_MS)
    binding.timer.unref?.()
    return false
  }
  return true
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
 * Returns a disposer that flushes synchronously and stops observing — and says
 * whether it could: `false` leaves the binding in place (see the disposer).
 */
export function bindPersistence(sessionId: string, doc: Y.Doc): () => boolean {
  const previous = bindings.get(sessionId)
  if (previous) {
    if (!write(previous) && !spill(previous)) {
      console.error(`[persistence] ${sessionId} was bound again before its last edits reached the disk; they are lost`)
    }
    if (previous.timer) clearTimeout(previous.timer)
    if (previous.settleTimer) clearTimeout(previous.settleTimer)
    previous.doc.off('update', previous.onUpdate)
    bindings.delete(sessionId)
  }

  const binding: Binding = {
    sessionId,
    doc,
    onUpdate: () => {},
    timer: null,
    settleTimer: null,
    dirtySince: 0,
    savedVector: null,
    savedBytes: 0,
    snapshotVector: null,
    snapshotAt: 0,
    snapshotDigest: NO_SNAPSHOT,
    tailed: false,
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
    binding.snapshotVector = binding.savedVector
    binding.snapshotAt = Date.now()
  }
  binding.snapshotDigest = digestOf(snapshot)
  /*
   * And the tail — whatever the room managed to write after the last full copy.
   *
   * It is always read, not only when a snapshot was found: there may be no
   * snapshot at all (the first full copy has not been written yet), and then
   * the tail is all that is left of the room. It is applied AFTER the snapshot
   * because it describes the difference from it; Yjs will apply an extra,
   * already counted tail and change nothing.
   *
   * Only the tail of THIS snapshot (see `TAIL_MAGIC`). The tail of another one
   * is either already inside it or from another timeline, and the file goes:
   * left in place it would only make the next open ask the same question.
   */
  const tail = readTail(sessionId)
  if (tail?.base && !sameBytes(tail.base, binding.snapshotDigest)) {
    console.warn(
      `[persistence] the tail of ${sessionId} was written against another snapshot ` +
        `(a newer full copy, or a database restored under it) — not applied`,
    )
    dropTail(sessionId)
  } else if (tail) {
    try {
      Y.applyUpdate(doc, tail.update, ORIGIN)
      binding.tailed = true
      binding.savedVector = Y.encodeStateVector(doc)
    } catch (err) {
      // A corrupted tail means lost seconds, not a lost room: the snapshot is
      // already applied, and we carry on from it.
      console.error(`[persistence] cannot read the tail of ${sessionId}`, err)
      dropTail(sessionId)
    }
  }
  /*
   * The document now knows whose room it belongs to: this is the only place
   * EVERY notebook passes through, live or loaded for a minute. It is read by
   * `publish/build.ts` when it puts extracted images back into a publication
   * (server/src/blobs.ts · roomOfDoc).
   */
  noteRoomDoc(sessionId, doc)

  doc.on('update', binding.onUpdate)
  bindings.set(sessionId, binding)

  return () => {
    if (bindings.get(sessionId) !== binding) return true
    if (binding.settleTimer) {
      clearTimeout(binding.settleTimer)
      binding.settleTimer = null
    }
    /*
     * The write comes first, while the binding is still registered, and it
     * decides whether the room may leave at all.
     *
     * It used to be the other way round: the binding was removed, then the
     * last write tried — and a write that failed (a full disk, a read-only
     * database, an I/O error) set its retry for a binding that was no longer
     * there, so the retry did nothing, the caller destroyed the document, and
     * the room's last edits existed nowhere any more. The diagnostics said
     * "nothing dirty", because there was nothing left to be dirty.
     *
     * Now a failed full copy falls back to a tail file (`spill` — past
     * SQLite, which is usually the thing failing), and when even that fails
     * the binding stays, its retry stays, and `false` tells the caller to keep
     * the document in memory: collab/index.ts · evictRoom tries again on the
     * next sweep.
     *
     * Whole when it can: the room is leaving memory and may be loaded a week
     * from now, and a snapshot without a file next to it is the cheaper thing
     * to load.
     */
    if (!write(binding, true) && !spill(binding)) return false
    if (binding.timer) {
      clearTimeout(binding.timer)
      binding.timer = null
    }
    bindings.delete(sessionId)
    doc.off('update', binding.onUpdate)
    return true
  }
}

/**
 * Stop persisting a session and write nothing — the opposite of the disposer
 * above, which flushes on its way out. The only caller is a seminar being
 * deleted: flushing there would write a snapshot row for a room that no longer
 * exists, which is exactly the state the delete was for.
 */
export function discardPersistence(sessionId: string): void {
  // The tail is a record of the room too, and it goes along with the room. It
  // is removed even without a binding: the deletion removes the snapshot row
  // by its own hand, and the file next to it would remain the only trace of
  // the deleted seminar on disk.
  dropTail(sessionId)
  const binding = bindings.get(sessionId)
  if (!binding) return
  bindings.delete(sessionId)
  if (binding.timer) clearTimeout(binding.timer)
  if (binding.settleTimer) clearTimeout(binding.settleTimer)
  binding.tailed = false
  binding.doc.off('update', binding.onUpdate)
}

/**
 * Forget that the snapshot on disk matches the document — and rewrite it.
 *
 * `write()` does not write while the state vector and the number of deletions
 * are the same as those written: that is right for edits, since there is no
 * edit that changes neither. But resetting stuck structures
 * (collab/index.ts · getEntry) changes neither the vector nor the deletions —
 * it only changes what `encodeStateAsUpdate` puts into the bytes — and without
 * this handle a clean document would reach disk only with the next keystroke
 * in the room, and until then every restart would load the garbage again.
 */
export function invalidateSnapshot(sessionId: string): void {
  const binding = bindings.get(sessionId)
  if (!binding) return
  binding.savedVector = null
  /*
   * And a tail will not do here.
   *
   * A tail is the difference from the written snapshot, while resetting stuck
   * structures changes not the difference but the snapshot ITSELF: the same
   * clocks, the same deletions, different bytes. As long as the old full copy
   * lies on disk, the garbage stays in it however many tails follow — so the
   * next write has to be a full one.
   */
  binding.snapshotVector = null
  schedule(binding)
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
  // Whole, not as a tail: "write it now" is asked for in places where the disk
  // must hold the room, not the room plus a file next to it — a new room
  // before the first visit, a visit to someone else's notebook, the end of a
  // class.
  if (binding) write(binding, true)
}

/**
 * Last-chance save for every live document, called on shutdown. Returns the
 * rooms whose edits could not be written even as a tail — the caller says so
 * out loud, since after the exit there is no retry.
 */
export function flushAllPersistence(): string[] {
  const unsaved: string[] = []
  for (const binding of bindings.values()) {
    if (!write(binding, true) && !spill(binding)) unsaved.push(binding.sessionId)
  }
  return unsaved
}

/**
 * Remove what is left in the tail folder by rooms that no longer exist —
 * once, as the server starts.
 *
 * A deletion removes the room's tail itself (`discardPersistence`), but only
 * when it gets there: a server killed in the middle of one, or a tail spilled
 * for a room whose database could not say it was gone (`sessionRowExists`),
 * leave a file nobody will ever read — the only trace of a deleted class on
 * disk. And a temporary file is a write some earlier process never renamed:
 * this one has written nothing yet.
 */
export function sweepOrphanTails(): number {
  const dir = path.join(config.dataDir, TAIL_DIR)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const room = /^([A-Za-z0-9_-]{1,64})\.bin$/.exec(name)?.[1]
    const stale = name.endsWith('.tmp') && !name.endsWith(`.${process.pid}.tmp`)
    if (!stale && (!room || sessionRowExists(room))) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed++
    } catch {
      /* tried again on the next start */
    }
  }
  if (removed > 0) console.log(`[persistence] removed ${removed} tail file(s) of rooms that no longer exist`)
  return removed
}
