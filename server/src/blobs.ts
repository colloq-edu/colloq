/**
 * Output images — next to the room, not inside its document.
 *
 * The room's document goes out WHOLE to everyone who joins, and is rewritten
 * whole into every snapshot and every history keyframe. While a matplotlib
 * chart sat in it as a base64 string, one two-hundred-kilobyte image cost:
 * 270 KB in the document (base64 is +33%), the same in every sync frame to EACH
 * of five hundred viewers, the same in a snapshot every five seconds while
 * people type in the room, and the same in a history keyframe. Measured in a
 * real class: 100 MB outgoing and 2.2 seconds of zlib for one image in a hall
 * of five hundred.
 *
 * Here the bytes are stored once, by the hash of their contents, and the
 * document keeps a link of about a hundred and fifty bytes
 * (`shared/notebook.ts · OutputBlob`). `routes/blobs.ts` serves them with a
 * permanent cache: the hash is the version, so the browser does not come back
 * for the same image a second time.
 *
 * Why files and not SQLite rows (as with publications): a publication snapshot
 * is assembled once a semester, while output is written in the middle of a
 * class — a blob in the database would mean two hundred kilobytes in the WAL
 * for every chart, exactly the price we were moving away from. A file goes
 * past the database and is served by a system call.
 *
 * Cleanup is per room: `deleteRoomBlobs` is called when a seminar is deleted,
 * and `sweepOrphans` sweeps up after deletion paths that do not know about this
 * store (and after those that will appear). Inside a live room the bytes are
 * not collected: an old image is looked at not only by the current notebook
 * but by every history version in which that cell has not been rerun yet.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { db } from './db.js'

/** The link as it is put into the document: hash, type and size. */
export interface StoredBlob {
  sha: string
  bytes: number
}

/** The room id goes into a path on disk, so its characters are checked. */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/
/** sha256 in hex — and nothing else. */
const SHA_OK = /^[0-9a-f]{64}$/

function roomDir(sessionId: string): string | null {
  if (!ID_OK.test(sessionId)) return null
  return path.join(config.dataDir, 'blobs', sessionId)
}

/**
 * The content type — by its first bytes, not by what the caller said.
 *
 * The response header is built from this, and the header is what the browser
 * uses to decide whether to show the bytes as an image or execute them as a
 * document on the instance's origin. The kernel sends the mime itself, and
 * there is no reason to trust it here: `display_data` is produced by a library
 * running in the student's code. A file signature leaves no such choice —
 * `text/html` will never come out of it.
 */
export function sniffMime(body: Uint8Array): string {
  const at = (i: number) => body[i]
  if (body.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return 'image/png'
  }
  if (body.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (body.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif'
  if (
    body.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp'
  }
  /*
   * A plotly figure is the only non-pixel thing put here (shared/publish ·
   * SPILL_MIMES), and it is stored as JSON text. It has to be judged by the
   * first character: JSON has no signature.
   *
   * This does not weaken the argument for sniffing here at all. What was
   * dangerous was `text/html` — a document on the instance's origin, that is,
   * someone else's script with the cookie of whoever opened the link.
   * `application/json` does not become a document under any header, let alone
   * with `nosniff` — and an image will not pretend to be a figure: none of the
   * formats above starts with a curly brace.
   */
  if (at(0) === 0x7b) return 'application/json'
  return 'application/octet-stream'
}

/**
 * Store the bytes and name them by their hash.
 *
 * The contents address themselves: the same image drawn twice (rerunning a cell
 * without changes is common in a seminar) is stored once and looks like the
 * same link in the document. `null` means it was not stored: the caller then
 * writes the output as before, straight into the document.
 */
export function putBlob(sessionId: string, body: Uint8Array): StoredBlob | null {
  const dir = roomDir(sessionId)
  if (!dir || body.length === 0) return null
  const sha = createHash('sha256').update(body).digest('hex')
  const file = path.join(dir, sha)
  try {
    // An existing file is not rewritten: the same bytes gave the same hash, and
    // an extra write in the middle of a class is an extra fsync under someone
    // else's typing.
    if (fs.existsSync(file)) return { sha, bytes: body.length }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    /*
     * Through a temporary file: a reader comes for the image the moment it
     * appears in the document — and a half-written file would reach them as a
     * broken image with a permanent cache, that is, forever.
     */
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, file)
    sweepSometimes()
    return { sha, bytes: body.length }
  } catch (err) {
    console.error(`[blobs] could not write output for room ${sessionId}`, err)
    return null
  }
}

/** The bytes by link — or `null` if there is no such entry. */
export function readBlob(sessionId: string, sha: string): Buffer | null {
  const dir = roomDir(sessionId)
  if (!dir || !SHA_OK.test(sha)) return null
  try {
    return fs.readFileSync(path.join(dir, sha))
  } catch {
    return null
  }
}

/** How much an entry weighs, without reading it. `null` means there is no entry. */
export function blobBytes(sessionId: string, sha: string): number | null {
  const dir = roomDir(sessionId)
  if (!dir || !SHA_OK.test(sha)) return null
  try {
    return fs.statSync(path.join(dir, sha)).size
  } catch {
    return null
  }
}

/** Remove everything the room has drawn. Returns how many entries it took. */
export function deleteRoomBlobs(sessionId: string): number {
  const dir = roomDir(sessionId)
  if (!dir) return 0
  let count = 0
  try {
    count = fs.readdirSync(dir).length
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    return 0
  }
  return count
}

/* ------------------------------------------------- whose document this is */

/**
 * Which room this `Y.Doc` belongs to.
 *
 * A link in the output is addressed by hash, while the shelf is addressed by
 * room, and whoever reads a notebook does not always know the room:
 * `pageOfDoc` for a publication gets a single document and nothing else. Asking
 * for it as a second parameter through five levels of calls would mean
 * dragging the id to where it is needed for nothing else — and the room's
 * document is born in one single place where the name is known anyway: the
 * binding to disk (`collab/persistence.ts · bindPersistence`).
 *
 * `WeakMap`: the entry goes away together with an evicted document, holding
 * nothing back.
 */
const docRooms = new WeakMap<object, string>()

export function noteRoomDoc(sessionId: string, doc: object): void {
  docRooms.set(doc, sessionId)
}

export function roomOfDoc(doc: object): string | null {
  return docRooms.get(doc) ?? null
}

/* --------------------------------------------------------------- cleanup */

/**
 * Sweep up after deleted rooms.
 *
 * Deleting a seminar calls `deleteRoomBlobs` itself, and that is enough exactly
 * until the first new deletion path that will not know about this store. The
 * cost of a mistake is asymmetric: a forgotten folder is images of a deleted
 * class lying on disk indefinitely. Hence a second line: once an hour, on a
 * write, we check folder names against the seminar rows.
 *
 * The row is asked for with an honest SELECT past the room cache for the same
 * reason persistence.ts does it: a cache miss costs one primary-key lookup an
 * hour, while a mistake the other way would erase the images of a live class.
 */
const SWEEP_EVERY_MS = 60 * 60_000
const selectSessionRow = db.prepare('SELECT 1 FROM sessions WHERE id = ?')
let sweptAt = 0

function sweepSometimes(): void {
  const now = Date.now()
  if (now - sweptAt < SWEEP_EVERY_MS) return
  sweptAt = now
  sweepOrphans()
}

/** The same, but now and out loud: how many rooms were removed. */
export function sweepOrphans(): number {
  const root = path.join(config.dataDir, 'blobs')
  let rooms: string[]
  try {
    rooms = fs.readdirSync(root)
  } catch {
    return 0
  }
  let dropped = 0
  for (const room of rooms) {
    if (selectSessionRow.get(room) !== undefined) continue
    deleteRoomBlobs(room)
    dropped++
  }
  return dropped
}
