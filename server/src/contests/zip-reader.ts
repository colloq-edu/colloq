/**
 * A small ZIP reader for the teacher's archives of tests — stored and
 * deflated entries, zip64, and nothing else (APPNOTE.TXT 6.3).
 *
 * OUR OWN, ON node:zlib, because the server takes no new packages, and
 * because what is needed here is narrow: list the names, inflate the ones
 * that are tests. The competitions write zips (publish/zip-send.ts) and never
 * read one.
 *
 * WHAT MAKES IT SAFE TO POINT AT A STRANGER'S FILE. An archive is read from a
 * Buffer the door already capped (CONTEST_LIMITS.archiveBytes), and:
 *  - NOTHING IS EVER EXTRACTED BY ITS PATH. A name is a string matched
 *    against patterns (tests-import.ts) and shown back in the «skipped» list;
 *    the bytes go wherever the caller writes them. `../../colloq.db` is a name
 *    like any other, and maps to no test.
 *  - The caps are on what comes OUT: the number of entries, every file's
 *    size and the sum of them, checked first against the sizes the central
 *    directory claims and then against what inflation actually yields
 *    (zlib's maxOutputLength), so a «42 KB» deflate stream that inflates to
 *    four gigabytes stops at the cap without the memory for it. Two entries
 *    sharing their bytes (the overlapping kind of zip bomb) are refused as a
 *    malformed archive.
 *  - Encrypted entries, methods other than stored and deflate, archives split
 *    over disks are refused with a word the teacher can act on; a CRC that
 *    does not match is a broken file, not a test.
 *  - Directories, `__MACOSX/`, dotfiles (`.DS_Store`, `._01`) are not entries
 *    at all, and symlinks are named as skipped: their bytes are a path.
 */
import zlib from 'node:zlib'

export type ZipRefusalWhy =
  /** Not a zip, or a broken one: no end record, an entry outside the file, sizes that lie. */
  | 'malformed'
  | 'encrypted'
  /** An entry compressed with a method other than stored or deflate (deflate64, bzip2, LZMA…). */
  | 'method'
  /** The archive spans several disks (a split archive). */
  | 'multidisk'
  | 'tooManyEntries'
  | 'fileTooBig'
  | 'totalTooBig'
  /** An entry's bytes do not match its CRC: the file is damaged. */
  | 'checksum'

export class ZipRefused extends Error {
  constructor(readonly why: ZipRefusalWhy, readonly entry: string | null = null) {
    super(`ZIP refused: ${why}${entry ? ` (${entry})` : ''}`)
  }
}

export interface ZipLimits {
  /** Every record of the central directory counts, directories and skipped names too. */
  maxEntries: number
  /** One file, uncompressed. */
  maxFileBytes: number
  /** All files together, uncompressed. */
  maxTotalBytes: number
}

export interface ZipEntry {
  /** The name as written, `/`-separated (a Windows `\` is read as one). */
  name: string
  size: number
  compressedSize: number
  method: 0 | 8
  crc32: number
  localOffset: number
}

export interface ZipArchive {
  /** Regular files, in the central directory's order. */
  entries: ZipEntry[]
  /** Names that are not files we read: symlinks. Directories and dotfiles are not named at all. */
  ignored: string[]
  /** One entry's bytes, inflated and checked. */
  read(entry: ZipEntry): Buffer
}

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
const U16 = 0xffff
const U32 = 0xffffffff

/* ------------------------------------------------------------- crc32 */

/** zlib's own when this Node has it (22.2 and later), a table otherwise. */
const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32

let table: Uint32Array | null = null
function crc32(data: Uint8Array): number {
  if (nativeCrc32) return nativeCrc32(data) >>> 0
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/* ------------------------------------------------------------ reading */

function u16(buffer: Buffer, at: number): number {
  if (at < 0 || at + 2 > buffer.length) throw new ZipRefused('malformed')
  return buffer.readUInt16LE(at)
}

function u32(buffer: Buffer, at: number): number {
  if (at < 0 || at + 4 > buffer.length) throw new ZipRefused('malformed')
  return buffer.readUInt32LE(at)
}

function u64(buffer: Buffer, at: number): number {
  if (at < 0 || at + 8 > buffer.length) throw new ZipRefused('malformed')
  const value = buffer.readBigUInt64LE(at)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipRefused('malformed')
  return Number(value)
}

/** The end-of-central-directory record: the last one in the file whose comment ends exactly at the end. */
function findEndRecord(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT)
  for (let at = buffer.length - EOCD_SIZE; at >= lowest; at--) {
    if (buffer.readUInt32LE(at) !== SIG_EOCD) continue
    // The comment's length must reach the end exactly: a signature inside a
    // comment or inside the data is not the record.
    if (at + EOCD_SIZE + buffer.readUInt16LE(at + 20) === buffer.length) return at
  }
  throw new ZipRefused('malformed')
}

interface Directory {
  entries: number
  size: number
  offset: number
}

function readDirectory(buffer: Buffer, end: number): Directory {
  const disk = u16(buffer, end + 4)
  const directoryDisk = u16(buffer, end + 6)
  let entries = u16(buffer, end + 10)
  let size = u32(buffer, end + 12)
  let offset = u32(buffer, end + 16)
  if (disk !== 0 || directoryDisk !== 0 || u16(buffer, end + 8) !== entries) throw new ZipRefused('multidisk')
  // A field at its maximum means «look in the zip64 record»; so does a locator
  // a writer put there anyway.
  const locator = end - 20
  const hasLocator = locator >= 0 && buffer.readUInt32LE(locator) === SIG_ZIP64_LOCATOR
  if (entries === U16 || size === U32 || offset === U32 || hasLocator) {
    if (!hasLocator) throw new ZipRefused('malformed')
    if (u32(buffer, locator + 16) > 1 || u32(buffer, locator + 4) !== 0) throw new ZipRefused('multidisk')
    const record = u64(buffer, locator + 8)
    if (u32(buffer, record) !== SIG_ZIP64_EOCD) throw new ZipRefused('malformed')
    if (u32(buffer, record + 16) !== 0 || u32(buffer, record + 20) !== 0) throw new ZipRefused('multidisk')
    entries = u64(buffer, record + 32)
    if (u64(buffer, record + 24) !== entries) throw new ZipRefused('multidisk')
    size = u64(buffer, record + 40)
    offset = u64(buffer, record + 48)
  }
  if (offset + size > buffer.length) throw new ZipRefused('malformed')
  return { entries, size, offset }
}

/** The name's bytes: UTF-8 when the flag says so or when they read as UTF-8, Latin-1 otherwise. */
function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  const text = bytes.toString('utf8')
  if (utf8Flag || !text.includes('�')) return text
  return bytes.toString('latin1')
}

/** Names that are not entries at all: directories, macOS's resource forks, dotfiles anywhere on the path. */
function invisible(name: string): boolean {
  if (name.endsWith('/')) return true
  const parts = name.split('/').filter(Boolean)
  if (parts.length === 0) return true
  if (parts[0] === '__MACOSX') return true
  return parts.some((part) => part.startsWith('.'))
}

/**
 * Open an archive held in memory: read its central directory and check every
 * claim against the limits. Throws ZipRefused; reads no entry's bytes yet.
 */
export function openZip(buffer: Buffer, limits: ZipLimits): ZipArchive {
  if (buffer.length < EOCD_SIZE) throw new ZipRefused('malformed')
  const end = findEndRecord(buffer)
  const directory = readDirectory(buffer, end)
  if (directory.entries > limits.maxEntries) throw new ZipRefused('tooManyEntries')

  const entries: ZipEntry[] = []
  const ignored: string[] = []
  const offsets = new Set<number>()
  let declared = 0
  let at = directory.offset
  const directoryEnd = directory.offset + directory.size
  for (let index = 0; index < directory.entries; index++) {
    if (u32(buffer, at) !== SIG_CENTRAL) throw new ZipRefused('malformed')
    const madeBy = u16(buffer, at + 4)
    const flags = u16(buffer, at + 8)
    const method = u16(buffer, at + 10)
    const crc = u32(buffer, at + 16)
    let compressedSize = u32(buffer, at + 20)
    let size = u32(buffer, at + 24)
    const nameLength = u16(buffer, at + 28)
    const extraLength = u16(buffer, at + 30)
    const commentLength = u16(buffer, at + 32)
    let diskStart = u16(buffer, at + 34)
    const external = u32(buffer, at + 38)
    let localOffset = u32(buffer, at + 42)
    const nameStart = at + 46
    const extraStart = nameStart + nameLength
    const next = extraStart + extraLength + commentLength
    if (next > directoryEnd) throw new ZipRefused('malformed')
    const name = decodeName(buffer.subarray(nameStart, extraStart), (flags & 0x800) !== 0).replace(/\\/g, '/')

    // The zip64 extra field holds, in this order, exactly the fields that are at their maximum above.
    if (size === U32 || compressedSize === U32 || localOffset === U32 || diskStart === U16) {
      let field = extraStart
      let found = false
      while (field + 4 <= extraStart + extraLength) {
        const id = u16(buffer, field)
        const length = u16(buffer, field + 2)
        const body = field + 4
        if (body + length > extraStart + extraLength) throw new ZipRefused('malformed')
        if (id === 0x0001) {
          let cursor = body
          const take = (): number => {
            if (cursor + 8 > body + length) throw new ZipRefused('malformed')
            const value = u64(buffer, cursor)
            cursor += 8
            return value
          }
          if (size === U32) size = take()
          if (compressedSize === U32) compressedSize = take()
          if (localOffset === U32) localOffset = take()
          if (diskStart === U16) {
            if (cursor + 4 > body + length) throw new ZipRefused('malformed')
            diskStart = u32(buffer, cursor)
          }
          found = true
          break
        }
        field = body + length
      }
      if (!found) throw new ZipRefused('malformed')
    }
    at = next
    if (diskStart !== 0) throw new ZipRefused('multidisk')
    if (invisible(name)) continue

    // A Unix symlink: its "bytes" are a path, not a test.
    if (madeBy >> 8 === 3 && ((external >>> 16) & 0o170000) === 0o120000) {
      ignored.push(name)
      continue
    }
    // Bit 0 — encrypted; bit 6 — strong encryption; method 99 — AES.
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0 || method === 99) throw new ZipRefused('encrypted', name)
    if (method !== 0 && method !== 8) throw new ZipRefused('method', name)
    if (method === 0 && compressedSize !== size) throw new ZipRefused('malformed', name)
    if (size > limits.maxFileBytes) throw new ZipRefused('fileTooBig', name)
    declared += size
    if (declared > limits.maxTotalBytes) throw new ZipRefused('totalTooBig', name)
    if (offsets.has(localOffset)) throw new ZipRefused('malformed', name)
    offsets.add(localOffset)
    if (localOffset + 30 > directory.offset) throw new ZipRefused('malformed', name)
    entries.push({ name, size, compressedSize, method: method as 0 | 8, crc32: crc, localOffset })
  }

  return {
    entries,
    ignored,
    read(entry: ZipEntry): Buffer {
      if (u32(buffer, entry.localOffset) !== SIG_LOCAL) throw new ZipRefused('malformed', entry.name)
      const start = entry.localOffset + 30 + u16(buffer, entry.localOffset + 26) + u16(buffer, entry.localOffset + 28)
      const stop = start + entry.compressedSize
      // An entry's bytes lie before the central directory, and nowhere else.
      if (stop > directory.offset || start > stop) throw new ZipRefused('malformed', entry.name)
      const raw = buffer.subarray(start, stop)
      let bytes: Buffer
      if (entry.method === 0) {
        bytes = Buffer.from(raw)
      } else {
        try {
          // The claim is the cap: a stream that would inflate past what the
          // directory said stops here, without the memory for the rest.
          bytes = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) })
        } catch {
          throw new ZipRefused('malformed', entry.name)
        }
      }
      if (bytes.length !== entry.size) throw new ZipRefused('malformed', entry.name)
      if (crc32(bytes) !== entry.crc32) throw new ZipRefused('checksum', entry.name)
      return bytes
    },
  }
}
