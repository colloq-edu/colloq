/**
 * The bytes of class-page materials: one file per content hash, on disk.
 *
 * Not in SQLite: a room folder is 6–28 MB, mostly PDFs and data, and every
 * VACUUM INTO snapshot would carry all of it while it holds the loop
 * (db-snapshots.ts). Not per page either: the dataset of a course is reused
 * in a dozen classes and is stored once.
 *
 * The order of writes is what keeps this honest without a lock:
 *   1. the file lands under its final name (tmp, fsync, rename), then
 *   2. its `page_files` row is inserted (INSERT OR IGNORE), then
 *   3. the page's transaction references it (publish/store.ts).
 * A crash after 1 leaves a file without a row, and the startup sweep removes
 * it; a crash after 2 leaves a row nothing references, and the next GC
 * removes both. A referenced hash is never deleted, so a reader never finds
 * a row without bytes.
 *
 * GC runs right after the writes that can orphan a file (a page write, a
 * removed material, a deleted page), synchronously with them: a build puts
 * its files and commits its page without yielding in between
 * (publish/materials.ts), so no GC can run between its steps 2 and 3.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { config } from '../config.js'
import { db } from '../db.js'

export function pageFilesDir(): string {
  return path.join(config.dataDir, 'page-files')
}

export function pageFilePath(hash: string): string {
  return path.join(pageFilesDir(), hash.slice(0, 2), hash)
}

const HASH_RE = /^[0-9a-f]{64}$/

/* ------------------------------------------------------------------- crc32 */

let table: Uint32Array | null = null

function crcTable(): Uint32Array {
  if (table) return table
  table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

/** The table form, for runtimes before zlib.crc32 (Node < 22.2). */
export function crc32Table(body: Uint8Array, seed = 0): number {
  const t = crcTable()
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < body.length; i++) c = t[(c ^ body[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const nativeCrc = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number })
  .crc32

/** CRC-32 as ZIP wants it. */
export function crc32(body: Uint8Array): number {
  return nativeCrc ? nativeCrc(body) >>> 0 : crc32Table(body)
}

/* ------------------------------------------------------------------- store */

export interface PageFile {
  hash: string
  mime: string
  bytes: number
  crc32: number
  at: number
}

const insertRow = db.prepare(
  'INSERT OR IGNORE INTO page_files (hash, mime, bytes, crc32, at) VALUES (?, ?, ?, ?, ?)',
)
const selectRow = db.prepare('SELECT hash, mime, bytes, crc32, at FROM page_files WHERE hash = ?')
const selectOrphans = db.prepare(`
  SELECT hash FROM page_files f
  WHERE NOT EXISTS (SELECT 1 FROM publication_materials m WHERE m.hash = f.hash)
`)
const deleteRow = db.prepare('DELETE FROM page_files WHERE hash = ?')
const selectAll = db.prepare('SELECT hash FROM page_files')

export function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

/**
 * Put bytes into the store and return their row.
 *
 * Idempotent: the same bytes are one file and one row, whoever put them
 * first. Written alongside and renamed, with an fsync before the rename, so a
 * power cut leaves either the old state or the whole file under its name,
 * never half of one.
 */
export function putPageFile(body: Buffer, mime: string): PageFile {
  const hash = sha256(body)
  const target = pageFilePath(hash)
  if (!fileHolds(target, body.length)) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try {
      fs.writeSync(fd, body, 0, body.length, 0)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.renameSync(tmp, target)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }
  }
  insertRow.run(hash, mime, body.length, crc32(body), Date.now())
  return pageFileInfo(hash)!
}

function fileHolds(file: string, bytes: number): boolean {
  try {
    return fs.statSync(file).size === bytes
  } catch {
    return false
  }
}

export function pageFileInfo(hash: string): PageFile | null {
  if (!HASH_RE.test(hash)) return null
  const row = selectRow.get(hash) as PageFile | undefined
  return row ?? null
}

/** The bytes, whole. For notebooks and README-sized things; files are streamed from the path. */
export function readPageFile(hash: string): Buffer | null {
  if (!pageFileInfo(hash)) return null
  try {
    return fs.readFileSync(pageFilePath(hash))
  } catch {
    return null
  }
}

function unlinkQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch (err) {
    console.error(`[pages] could not remove ${file}:`, err instanceof Error ? err.message : err)
  }
}

/** Remove every stored file no material refers to. Returns how many went. */
export function gcPageFiles(): number {
  const orphans = (selectOrphans.all() as { hash: string }[]).map((row) => row.hash)
  if (orphans.length === 0) return 0
  db.transaction(() => {
    for (const hash of orphans) deleteRow.run(hash)
  })()
  for (const hash of orphans) unlinkQuietly(pageFilePath(hash))
  return orphans.length
}

/**
 * At startup: the GC above, then files on disk without a row (a crash
 * between the copy and the insert) and leftover temporary names.
 */
export function sweepPageFiles(): { rows: number; files: number } {
  const rows = gcPageFiles()
  const known = new Set((selectAll.all() as { hash: string }[]).map((row) => row.hash))
  let files = 0
  let shards: string[]
  try {
    shards = fs.readdirSync(pageFilesDir())
  } catch {
    return { rows, files }
  }
  for (const shard of shards) {
    const dir = path.join(pageFilesDir(), shard)
    let names: string[]
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (HASH_RE.test(name) && known.has(name)) continue
      unlinkQuietly(path.join(dir, name))
      files++
    }
  }
  return { rows, files }
}
