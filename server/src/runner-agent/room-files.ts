/**
 * A class folder's copy on the machine, and the files on their way between it
 * and home («занятия на машинах», docs/architecture/remote-classes.md §8). One
 * copy a class, `<state>/rooms/<id>/`, mounted by every container of the class
 * on this machine; home's own folder stays the truth (D16).
 *
 * WHAT BOTH SIDES AGREED IS WRITTEN DOWN. The baseline
 * (`<state>/rooms/<id>.baseline.json`, written whole) maps every path both
 * sides last agreed on to its sha256 and length, or to REMOTE_DIR_BASE for a
 * folder: a push applied moves its paths in, a change home accepted moves the
 * change in, a file home took with «Привезти» moves in at the version its PUT
 * sent, a refused one leaves it as it was. It is every report's `base`,
 * and it outlives a restart of either side: after the agent's, it is what home
 * last agreed; after home's, home rebuilds from a full report that carries it
 * (§8.4). It also keeps the gens of the placements the copy serves, and the
 * last push applied whole: the ack, `files.pushSeq` of every held placement of
 * the class, which rides the next sync, sent at once.
 *
 * HOME'S PUSHES, IN THEIR ORDER (§8.2): moves, then removes, then puts, a full
 * push removing what both sides agreed and it no longer lists. Every write
 * goes to a name of home's TEMP_FILE shape beside its target and is renamed
 * over it; a folder is made 2775 and a file 0664, owned by the kernels' uid
 * 1000 when the agent is root, as home's sessionDir makes them. Content rides
 * inline or comes as a blob down the agent's one stream (Cache.blob), paced at
 * the reply's class rate — a push a run waits on at the promoted one, and
 * ahead of a lease's blob — and is copied out of the CAS, never linked. A path
 * the machine changed and home did not is left for its report. A machine's
 * version a push overwrites or removes is kept aside when home has never seen
 * it, and reported with its old base, so that home keeps it as a conflict copy
 * or says the delete won (§8.4) instead of losing it unseen; one home has seen
 * already is never said again (home would keep a second copy), only its bytes
 * kept for the pull home may still make of them.
 *
 * SCANS (§8.3). At home's word after every cell or attempt, which skips the
 * quiet rule (the writer is done), and by themselves: every CLASS_SCAN_BUSY_MS
 * while a kernel of the class was busy within the last minute (the census's
 * word, kernels.ts · busyAt), every CLASS_SCAN_IDLE_MS otherwise, the pace
 * read anew at every beat. A walk reads stats only, a slice at a time between
 * the tunnel's frames. A file is hashed once it has kept its stats (its ctime
 * among them) for CLASS_FILE_QUIET_MS on the agent's own clock, so a
 * checkpoint is not caught half written; a file that changed again while it
 * waited is looked at by the class's own pace, never at every quiet time. A
 * new folder at the top is said only once no new path has appeared in it for
 * as long, and newFolderMs after it appeared at most, so a `pip install -t .`
 * or a `tar x` is not sent half done while a log a cell keeps writing holds
 * back nothing beside it for long. Hashes are booked by the stats (HashBook):
 * a file unchanged since is never read again, this life or the next.
 *
 * WHAT A KERNEL WROTE IS PARTICIPANT DATA (§8.6). Every walk, read and write
 * goes through the anchored filesystem (secure-files.ts): no link is ever
 * followed, a link and a special file never travel, and a kernel's `ln -s
 * /var/lib/colloq-runner/runner.json x.csv` is a name the walk passes by. A
 * file goes home only from the agent's own staging, copied there through a
 * descriptor opened without following and hashed as it is copied, so the
 * bytes that go are the bytes that were hashed; a file with several hard
 * links travels as its content. Hidden names, `__pycache__` and paths that
 * shared/paths.ts refuses never travel; a file over machineFileMb (unless
 * both sides agreed on it as it is: home pushed it, or brought it), past the
 * room limit or past CLASS_SYNC_FILES_MAX entries stays «на машине»
 * (`skipped`), and so does every path a `*.dist-info/RECORD` or an
 * `.egg-info/installed-files.txt` lists, one entry for each folder a package
 * owns whole. Nothing past machineFileMb is ever read to be kept aside or
 * staged (a kernel's 16 TiB of holes would be hours of zeros), and no byte
 * count it says reaches a report past Number.MAX_SAFE_INTEGER (home's strict
 * parser would refuse the machine's whole block).
 *
 * REPORTS, VERDICTS, PULLS. A sync carries at most one report a class, their
 * paths within REMOTE_REPORT_PATHS_MAX together, shared fairly among the
 * classes, their inline files within CLASS_INLINE_REPORT_BYTES. A change goes
 * out once and waits for its verdict; a newer version of the same path waits
 * behind it, and a change with no verdict is said again after a minute. A
 * sync the agent cut short itself was taken in by home as it arrived: what it
 * carried counts as said (reportsCut). A full report goes in pages from a
 * walk taken whole, one page a sync and nothing else of the class meanwhile,
 * a page sent again under its own seq.
 * Pulls go up REMOTE_CLASS_UPLOADS at once, gzipped and paced, the version the
 * report named or none; a version gone before its PUT (rewritten, removed) is
 * waited on no more, and what is there now is said instead.
 *
 * ONE COPY SERVES THE CLASS HERE (§8.1), as home keeps one copy of a class on
 * a machine for as long as any slot of it lives there. A copy home names at
 * gens it never served (a slot stopped and placed again, the room moved off
 * while a personal kernel came) is kept; whether home's copy is still the one
 * it agreed with, home's next push says, and until then no ack is said for it
 * (lag). A copy home no longer names at all is fenced (§8.8, §11.3): its
 * changes since its baseline — at most CLASS_LATE_MAX of them — are said as
 * `late` once the containers of its gens are gone, and the copy goes once a
 * reply to a sync that held none of the class's containers still names it
 * nowhere: home has no copy of it here by then.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createGzip } from 'node:zlib'
import {
  CLASS_BULK_IDLE_MBPS,
  CLASS_BULK_PROMOTED_MBPS,
  CLASS_FILE_QUIET_MS,
  CLASS_INLINE_BYTES,
  CLASS_INLINE_REPORT_BYTES,
  CLASS_LATE_MAX,
  CLASS_MACHINE_FILE_MB,
  CLASS_PACE_BURST_BYTES,
  CLASS_ROOM_MB,
  CLASS_SCAN_BUSY_MS,
  CLASS_SCAN_IDLE_MS,
  CLASS_SYNC_FILES_MAX,
  MACHINE_PACE_MBPS,
  REMOTE_CLASS_UPLOADS,
  REMOTE_DIR_BASE,
  REMOTE_PLACEMENTS_MAX,
  REMOTE_REPORT_PATHS_MAX,
  REMOTE_SESSION_ID,
  parseRemotePlacementKey,
  remoteClassPaths,
  type RemoteFilesLag,
  type RemoteFilesPush,
  type RemoteFilesPut,
  type RemoteFilesReport,
  type RemoteKernelRole,
  type RemoteKernelsReply,
  type RemoteSkipReason,
  type RemoteVerdictReason,
} from '@shared/remote-kernels'
import {
  REMOTE_API_BASE,
  REMOTE_BYTES_HEADER,
  REMOTE_ERRORS,
  REMOTE_MARKER_HEADER,
  REMOTE_REASON_CHARS,
  REMOTE_SHA256,
  REMOTE_SHA256_HEADER,
  parseRemoteErrorReply,
  remoteText,
  remoteTransient,
  type RemoteErrorCode,
} from '@shared/remote-runner'
import { isInside, normalizePath, parentOf } from '@shared/paths'
import { createAnchoredFilesystem } from '../secure-files.js'
import { HashBook, Pacer, pause } from './cache.js'
import { Backoff, retryAfter } from './client.js'
import { readJson, writeWhole, type StateLayout } from './state.js'

/* ----------------------------------------------------------------- numbers */

/** How the copy keeps time: the defaults, which tests shorten or drive by hand (beatMs 0: no timer of its own). */
export interface RoomFileTimings {
  /** The beat that starts the scans, pushes, fences and uploads due. */
  beatMs: number
  /** A class's own scan while a kernel of it was busy within `busyWindowMs`, and otherwise (§8.3). */
  busyMs: number
  idleMs: number
  busyWindowMs: number
  /** A changed file is hashed once its stats held this long, a new top folder once no new path appeared in it for as long. */
  quietMs: number
  /** A new top folder holds its files back at most this long after the copy first saw it: past it, each goes by its own quiet time. */
  newFolderMs: number
  /** A change said and not answered is said again after this (a reply lost, a home restarted), counted from its pull's last move. */
  verdictMs: number
  /** A fenced copy waits this long at most for the containers of its gens to go, before it is read for its late list. */
  fenceWaitMs: number
  /** A push that could not be applied whole is tried again after this, doubling up to `last`. */
  retryMs: { first: number; last: number }
  /** An upload that moved no byte for this long is given up, and tried again while home asks. */
  uploadStallMs: number
}

export const ROOM_FILE_TIMINGS: Readonly<RoomFileTimings> = Object.freeze({
  beatMs: 1_000,
  busyMs: CLASS_SCAN_BUSY_MS,
  idleMs: CLASS_SCAN_IDLE_MS,
  busyWindowMs: 60_000,
  quietMs: CLASS_FILE_QUIET_MS,
  newFolderMs: 30_000,
  verdictMs: 60_000,
  fenceWaitMs: 60_000,
  retryMs: Object.freeze({ first: 2_000, last: 30_000 }),
  uploadStallMs: 60_000,
})

/** The uid the kernels run as (the image's `runner`), as home's rooms are owned: what the agent, as root, gives what it makes. */
export const KERNEL_UID = 1000

const MIB = 1024 * 1024
/** A package's RECORD read at most this far: a forged one of a gigabyte is no package. */
const RECORD_BYTES = 8 * MIB
const RECORD_LINES = 200_000
/** Folders a package shares with others (`pip install -t .` puts scripts in bin/): only the files it lists are its. */
const SHARED_DIRS: ReadonlySet<string> = new Set(['bin', 'include', 'share', 'lib', 'lib64', 'etc', 'man', 'Scripts', 'scripts', 'doc', 'docs', 'data'])
/** Entries past the walk's ceiling named one by one, at most. */
const OVER_NAMED = 100
/** Reports a class remembers after they were answered, for verdicts that come later (a pulled file's). */
const SAID_KEPT = 64
/** Tries of one pull through transient answers before it waits for home to ask again. */
const UPLOAD_TRIES = 8
/** Entries a walk looks at between two turns of the event loop: the tunnel's frames of every class go between. */
const WALK_SLICE = 256
/** A temporary name of home's TEMP_FILE shape (workspace.ts), the agent's own writes' among them: never a file of the class. */
const TEMP_FILE = /^\..+\.(?:uploading|saving)-[0-9a-z][0-9a-z-]{5,}$/i

/** A byte count a kernel controls (a forged RECORD, files of holes), as far as a report may carry one. */
const clampBytes = (bytes: number): number => (bytes > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : bytes)
const addBytes = (a: number, b: number): number => clampBytes(a + b)
const statBytes = (stat: fs.BigIntStats): number => (stat.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(stat.size))

/** One turn of the event loop. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/* ------------------------------------------------------------------- paths */

/** The class folder's copy (§8.1). */
export function roomFolder(layout: StateLayout, sessionId: string): string {
  if (!REMOTE_SESSION_ID.test(sessionId)) throw new Error('Invalid class id')
  return path.join(layout.roomsDir, sessionId)
}

/** What both sides last agreed on, beside the copy and never inside it. */
export function roomBaselineFile(layout: StateLayout, sessionId: string): string {
  return `${roomFolder(layout, sessionId)}.baseline.json`
}

/** The agent's own copies of what goes home, beside the copy: no container mounts it. */
function roomStaging(layout: StateLayout, sessionId: string): string {
  return `${roomFolder(layout, sessionId)}.staging`
}

/**
 * The class folder's copy, made when missing (§8.1): 2775 and the kernels'
 * uid, as home's sessionDir makes a room's folder, so that the class's
 * containers write where the agent writes. Its files come with their pushes.
 * Owned first, then its mode: a chown clears a setgid bit on some systems.
 */
export function ensureRoomFolder(layout: StateLayout, sessionId: string): string {
  fs.mkdirSync(layout.roomsDir, { recursive: true, mode: 0o700 })
  const dir = roomFolder(layout, sessionId)
  if (fs.existsSync(dir)) return dir
  fs.mkdirSync(dir, { mode: 0o2775 })
  if (process.platform !== 'win32') {
    try {
      if (process.getuid?.() === 0) fs.chownSync(dir, KERNEL_UID, KERNEL_UID)
      fs.chmodSync(dir, 0o2775)
    } catch { /* the first write in it says so, as at home */ }
  }
  return dir
}

/* ------------------------------------------------------------ the baseline */

/** One agreed path: its content's sha256 and length, or REMOTE_DIR_BASE for a folder (length 0). */
interface Agreed {
  base: string
  bytes: number
}

interface Baseline {
  /** The gens of the placements the copy serves, by slot. */
  gens: Partial<Record<RemoteKernelRole, number>>
  /** The last push applied whole: the ack. */
  pushSeq: number
  /**
   * Home named the class here only at gens the copy never served: whether
   * home's copy is the one this one agreed with is unknown until home's next
   * push lands (or home rebuilds from a full report), and no ack is said
   * meanwhile — a home whose copy is new would take an old ack for its first
   * push (lag).
   */
  doubt: boolean
  /** The last report's seq, carried into the next life (reports' seqs never repeat). */
  reportSeq: number
  files: Map<string, Agreed>
}

const ROLES: readonly RemoteKernelRole[] = ['room', 'own', 'council']

/** A baseline as written; null — none, or not one this code wrote (the copy is then served as agreeing on nothing). */
function readBaseline(file: string): Baseline | null {
  const value = readJson(file, 64 * MIB) as { v?: unknown; gens?: unknown; pushSeq?: unknown; doubt?: unknown; reportSeq?: unknown; files?: unknown } | null
  if (!value || value.v !== 1 || !Array.isArray(value.files) || !Number.isSafeInteger(value.pushSeq) || !Number.isSafeInteger(value.reportSeq)) return null
  const gens: Baseline['gens'] = {}
  const said = value.gens && typeof value.gens === 'object' ? (value.gens as Record<string, unknown>) : {}
  for (const role of ROLES) if (Number.isSafeInteger(said[role]) && (said[role] as number) > 0) gens[role] = said[role] as number
  const files = new Map<string, Agreed>()
  for (const entry of value.files as unknown[]) {
    if (!Array.isArray(entry)) return null
    const [at, base, bytes] = entry as unknown[]
    if (typeof at !== 'string' || at === '' || normalizePath(at) !== at) return null
    if (base === REMOTE_DIR_BASE) files.set(at, { base, bytes: 0 })
    else if (typeof base === 'string' && REMOTE_SHA256.test(base) && Number.isSafeInteger(bytes) && (bytes as number) >= 0) files.set(at, { base, bytes: bytes as number })
    else return null
  }
  return { gens, pushSeq: value.pushSeq as number, doubt: value.doubt === true, reportSeq: value.reportSeq as number, files }
}

function writeBaseline(file: string, baseline: Baseline): void {
  const files = [...baseline.files].map(([at, agreed]) => (agreed.base === REMOTE_DIR_BASE ? [at, agreed.base] : [at, agreed.base, agreed.bytes]))
  writeWhole(file, JSON.stringify({ v: 1, gens: baseline.gens, pushSeq: baseline.pushSeq, ...(baseline.doubt ? { doubt: true } : {}), reportSeq: baseline.reportSeq, files }), { mode: 0o600, durable: true })
}

/** Every agreed path at or under `at`. */
function under(files: ReadonlyMap<string, Agreed>, at: string): Array<[string, Agreed]> {
  return [...files].filter(([entry]) => isInside(entry, at))
}

/* ---------------------------------------------------------- package trees */

/**
 * The paths a package lists as its own, with their lengths: a
 * `*.dist-info/RECORD` (CSV, `path,hash,size`, a path in quotes when it holds
 * a comma) or an `.egg-info/installed-files.txt` (a path a line, its length
 * unknown). Paths are as written, relative to the folder that holds the
 * metadata (RECORD) or to the metadata folder itself (installed-files.txt).
 */
export function packagePaths(text: string, kind: 'record' | 'installed'): Array<{ path: string; bytes: number }> {
  const found: Array<{ path: string; bytes: number }> = []
  const lines = text.split(/\r?\n/)
  for (const raw of lines.slice(0, RECORD_LINES)) {
    const line = raw.trim()
    if (!line) continue
    if (kind === 'installed') {
      found.push({ path: line, bytes: 0 })
      continue
    }
    let name: string
    let rest: string
    if (line.startsWith('"')) {
      // A quoted field, `""` a quote inside it, as Python's csv writes one.
      let at = 1
      name = ''
      for (;;) {
        const quote = line.indexOf('"', at)
        if (quote < 0) return found
        name += line.slice(at, quote)
        if (line[quote + 1] === '"') {
          name += '"'
          at = quote + 2
          continue
        }
        rest = line.slice(quote + 1)
        break
      }
    } else {
      const comma = line.indexOf(',')
      name = comma < 0 ? line : line.slice(0, comma)
      rest = comma < 0 ? '' : line.slice(comma)
    }
    const size = rest.slice(rest.lastIndexOf(',') + 1)
    found.push({ path: name, bytes: /^\d{1,15}$/.test(size) ? Number(size) : 0 })
  }
  return found
}

/** A package's path made the class folder's: `base` joined with what the metadata says, or null outside the folder or past its rules. */
function packagePath(base: string, listed: string): string | null {
  if (listed.startsWith('/') || listed.includes('\\') || listed.includes('\u0000')) return null
  const joined = path.posix.normalize(base ? `${base}/${listed}` : listed)
  if (joined === '.' || joined.startsWith('../') || joined === '..' || joined.startsWith('/')) return null
  return normalizePath(joined) === joined ? joined : null
}

/* ----------------------------------------------------------------- the walk */

type Anchored = ReturnType<typeof createAnchoredFilesystem>

interface Walk {
  /** Every regular file that may travel, by path, with its stats (the walk's lstat). */
  files: Map<string, fs.BigIntStats>
  /** Every folder found, listed or not. */
  dirs: Set<string>
  /** Folders every entry of which was looked at: an agreed path under one and not found is gone. */
  listed: Set<string>
  /** What packages own: their folders owned whole (never walked) and the single files they list, with their lengths. */
  packages: Map<string, number>
  /** Entries past the walk's ceiling. */
  over: Set<string>
  /** Temporary names of home's TEMP_FILE shape found, when asked for (what a crash left mid-write). */
  temps: string[]
}

/** A package's metadata as last read, by its stats: a RECORD of 15,000 lines is read again only once it changed. */
type Records = Map<string, { stamp: string; entries: Array<{ path: string; bytes: number }> }>

/** The stats that say a file has not changed: its inode, its length and both its times (a copy that keeps the mtime moves the ctime). */
const stampOf = (stat: fs.BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`

/** Whether two stats are of the same file, unchanged: its ctime too, which a write with the old mtime put back still moves. */
const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

function lstatOf(afs: Anchored, at: string): fs.BigIntStats | null {
  try {
    return afs.lstatSync(at, { bigint: true }) as unknown as fs.BigIntStats
  } catch {
    return null
  }
}

/** The first segment of a path: its top folder, or the file itself at the top. */
const topOf = (at: string): string => {
  const slash = at.indexOf('/')
  return slash < 0 ? at : at.slice(0, slash)
}

/**
 * A walk of the copy (§8.3), by stats alone and never through a link: what
 * may travel, what packages own, and how far the walk went. Names in each
 * folder in order, so that two walks of one tree see it alike; a slice of
 * WALK_SLICE entries at a time, the event loop's between them.
 */
async function walkCopy(afs: Anchored, root: string, agreed: ReadonlyMap<string, Agreed>, max: number, records: Records, temps: boolean): Promise<Walk> {
  const walk: Walk = { files: new Map(), dirs: new Set(), listed: new Set(), packages: new Map(), over: new Set(), temps: [] }
  /** Single files the packages found so far list: what a walk deeper (bin/) must leave on the machine. */
  const owned = new Map<string, number>()
  const read = new Set<string>()
  let count = 0
  let slice = 0
  const stack: string[] = ['']
  while (stack.length > 0) {
    const rel = stack.pop()!
    let names: string[]
    try {
      names = (afs.readdirSync(rel ? path.join(root, rel) : root) as string[]).slice().sort()
    } catch {
      continue
    }
    const whole = packagesIn(afs, root, rel, names, agreed, owned, records, read)
    let complete = true
    const below: string[] = []
    for (const name of names) {
      if (++slice >= WALK_SLICE) {
        slice = 0
        await turn()
      }
      const at = rel ? `${rel}/${name}` : name
      if (name.startsWith('.') || name === '__pycache__') {
        if (temps && TEMP_FILE.test(name)) walk.temps.push(at)
        continue
      }
      if (normalizePath(at) !== at) continue
      if (count >= max) {
        complete = false
        if (walk.over.size < OVER_NAMED) walk.over.add(at)
        continue
      }
      const stat = lstatOf(afs, path.join(root, at))
      if (stat === null) continue
      if (stat.isDirectory()) {
        count++
        walk.dirs.add(at)
        const bytes = whole.get(at)
        if (bytes !== undefined) walk.packages.set(at, bytes)
        else below.push(at)
      } else if (stat.isFile()) {
        count++
        const bytes = owned.get(at)
        if (bytes !== undefined) walk.packages.set(at, statBytes(stat))
        else walk.files.set(at, stat)
      }
      // A link or a special file never travels, and nothing is ever read through one.
    }
    if (complete) walk.listed.add(rel)
    for (let i = below.length - 1; i >= 0; i--) stack.push(below[i]!)
  }
  // Folders the ceiling kept the walk out of: left on the machine, as their files are.
  for (const rel of stack) if (walk.over.size < OVER_NAMED) walk.over.add(rel)
  // What no package lists any more is forgotten.
  for (const key of [...records.keys()]) if (!read.has(key)) records.delete(key)
  return walk
}

/**
 * The packages whose metadata lies in folder `rel` (§8.5): the folders they
 * own whole, with the lengths their records give (a new top folder that is
 * no folder packages share and that both sides never agreed on, and the
 * metadata folder itself), and into `owned` the single files they list
 * elsewhere (bin/, a folder the class had before). Each record read once
 * for as long as its stats hold (`records`).
 */
function packagesIn(afs: Anchored, root: string, rel: string, names: readonly string[], agreed: ReadonlyMap<string, Agreed>, owned: Map<string, number>, records: Records, read: Set<string>): Map<string, number> {
  const whole = new Map<string, number>()
  let here: Set<string> | null = null
  for (const name of names) {
    const record = name.endsWith('.dist-info') ? 'RECORD' : name.endsWith('.egg-info') ? 'installed-files.txt' : null
    if (record === null) continue
    const meta = rel ? `${rel}/${name}` : name
    if (normalizePath(meta) !== meta) continue
    const entries = recordOf(afs, path.join(root, meta, record), `${meta}/${record}`, record === 'RECORD' ? 'record' : 'installed', records, read)
    if (entries === null) continue
    here ??= new Set(names)
    whole.set(meta, whole.get(meta) ?? 0)
    for (const entry of entries) {
      const target = packagePath(record === 'RECORD' ? rel : meta, entry.path)
      if (target === null) continue
      if (isInside(target, meta)) {
        whole.set(meta, addBytes(whole.get(meta) ?? 0, entry.bytes))
        continue
      }
      // The folder of `rel` the path lies in: owned whole when packages alone put it there.
      const inner = rel ? (isInside(target, rel) && target !== rel ? target.slice(rel.length + 1) : null) : target
      const first = inner !== null && inner.includes('/') ? inner.slice(0, inner.indexOf('/')) : null
      const top = first !== null ? (rel ? `${rel}/${first}` : first) : null
      if (top !== null && first !== null && !SHARED_DIRS.has(first) && !agreed.has(top) && here.has(first)) {
        whole.set(top, addBytes(whole.get(top) ?? 0, entry.bytes))
      } else owned.set(target, clampBytes(entry.bytes))
    }
  }
  return whole
}

/** A package's list of paths, read again only when its stats moved; null — none there, or not a regular file the size of one. */
function recordOf(afs: Anchored, file: string, key: string, kind: 'record' | 'installed', records: Records, read: Set<string>): Array<{ path: string; bytes: number }> | null {
  const stat = lstatOf(afs, file)
  if (!stat?.isFile() || stat.size > BigInt(RECORD_BYTES)) return null
  read.add(key)
  const stamp = stampOf(stat)
  const known = records.get(key)
  if (known?.stamp === stamp) return known.entries
  const text = readSmall(afs, file, RECORD_BYTES)
  if (text === null) {
    records.delete(key)
    return null
  }
  const entries = packagePaths(text.toString('utf8'), kind)
  records.set(key, { stamp, entries })
  return entries
}

/** A small regular file's bytes, read through a descriptor that follows no link; null — none, a special file, or longer than `max`. */
function readSmall(afs: Anchored, file: string, max: number): Buffer | null {
  let fd: number
  try {
    fd = afs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > max) return null
    const buffer = Buffer.alloc(stat.size)
    let read = 0
    while (read < buffer.length) {
      const got = fs.readSync(fd, buffer, read, buffer.length - read, read)
      if (got === 0) break
      read += got
    }
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** One read of a descriptor, without holding the loop: a 200 MB file is hashed between the tunnel's frames, not instead of them. */
function readAt(fd: number, buffer: Buffer): Promise<number> {
  return new Promise((resolve, reject) => fs.read(fd, buffer, 0, buffer.length, null, (error, read) => (error ? reject(error) : resolve(read))))
}

/**
 * A regular file of the copy hashed whole through a descriptor the anchored
 * filesystem opened without following, and copied into `copyTo` as it is
 * read when one is given (copy before hash: the bytes that travel are the
 * bytes that were hashed). Null — no regular file there, not the file the
 * walk saw (`expect`), changed while it was read (not quiet after all), or
 * `signal` gave up first.
 */
async function hashAt(afs: Anchored, file: string, expect: fs.BigIntStats | null, copyTo?: string, signal?: AbortSignal): Promise<{ sha: string; bytes: number; stat: fs.BigIntStats } | null> {
  let fd: number
  try {
    fd = afs.openSync(file, 'r')
  } catch {
    return null
  }
  let out: fs.promises.FileHandle | null = null
  let whole = false
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || (expect !== null && !sameFile(before, expect))) return null
    if (copyTo) out = await fs.promises.open(copyTo, 'wx', 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(MIB)
    let bytes = 0
    for (;;) {
      if (signal?.aborted) return null
      const read = await readAt(fd, buffer)
      if (read === 0) break
      const chunk = buffer.subarray(0, read)
      hash.update(chunk)
      if (out) await out.write(chunk)
      bytes += read
    }
    if (!sameFile(fs.fstatSync(fd, { bigint: true }), before) || BigInt(bytes) !== before.size) return null
    whole = true
    return { sha: hash.digest('hex'), bytes, stat: before }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
    if (out) await out.close().catch(() => undefined)
    if (copyTo && !whole) fs.rmSync(copyTo, { force: true })
  }
}

/* ---------------------------------------------------------------- uploads */

/** One file on its way home (PUT rooms/:sessionId/files): its gzip, paced, and what it is uncompressed. */
export interface RoomUpload {
  sessionId: string
  gen: number
  path: string
  sha256: string
  bytes: number
  body: ReadableStream<Uint8Array>
  signal: AbortSignal
}

/** Home's answer, as the agent's client reads every answer (client.ts · CallResult). */
export type RoomUploadAnswer =
  | { kind: 'ok' }
  | { kind: 'refused'; status: number; error: RemoteErrorCode; detail: string }
  | { kind: 'transient'; reason: string; retryAfterMs: number | null }

export type RoomUploader = (upload: RoomUpload) => Promise<RoomUploadAnswer>

/**
 * The upload door of home (§15: PUT rooms/:sessionId/files?path=&gen=), as the
 * agent's client calls home: the credential in the Authorization header and
 * nowhere else, no redirect followed, a reply without home's marker or a 429
 * or a 5xx transient, any other refusal home's by its code. The body streams
 * as it is paced (`duplex: 'half'`): its length is said by X-Colloq-Bytes of
 * the file uncompressed, as for a run's results.
 */
export function homeUploader(input: { home: string; credential: () => string | null; fetch?: typeof fetch }): RoomUploader {
  const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis)
  return async (upload) => {
    const credential = input.credential()
    if (!credential) return { kind: 'transient', reason: 'not joined yet', retryAfterMs: null }
    let response: Response
    try {
      response = await fetchImpl(`${input.home}${REMOTE_API_BASE}/${remoteClassPaths.roomFile(upload.sessionId, upload.path, upload.gen)}`, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'gzip',
          [REMOTE_SHA256_HEADER]: upload.sha256,
          [REMOTE_BYTES_HEADER]: String(upload.bytes),
        },
        body: upload.body,
        redirect: 'manual',
        signal: upload.signal,
        duplex: 'half',
      } as RequestInit)
    } catch (error) {
      return { kind: 'transient', reason: upload.signal.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error), retryAfterMs: null }
    }
    try {
      if (remoteTransient(response.status, response.headers.get(REMOTE_MARKER_HEADER))) {
        await response.body?.cancel().catch(() => undefined)
        return { kind: 'transient', reason: `home answered ${response.status}`, retryAfterMs: retryAfter(response.headers.get('Retry-After')) }
      }
      const text = await cappedText(response, 64 * 1024)
      if (response.status < 400) return { kind: 'ok' }
      try {
        const reply = parseRemoteErrorReply(JSON.parse(text))
        return { kind: 'refused', status: response.status, error: reply.error, detail: reply.detail ?? '' }
      } catch {
        const error = (Object.keys(REMOTE_ERRORS) as RemoteErrorCode[]).find((code) => REMOTE_ERRORS[code] === response.status) ?? 'invalid'
        return { kind: 'refused', status: response.status, error, detail: remoteText(text.trim(), REMOTE_REASON_CHARS, 'start') }
      }
    } catch (error) {
      return { kind: 'transient', reason: error instanceof Error ? error.message : String(error), retryAfterMs: null }
    }
  }
}

/* ---------------------------------------------------------------- the copy */

/** What the machine has at a path that both sides do not agree on: a file of other content, or nothing. */
type Change = { kind: 'changed'; sha: string; bytes: number } | { kind: 'removed'; base: string }

/** A change said, and when: until its verdict, or until it is said again. */
interface Said {
  seq: number
  at: number
  /** The state said: the content's sha256, or null for a removal. */
  state: string | null
  /** Its bytes rode in the report: home has them, and pulls none. */
  inline: boolean
}

/** A machine's version a push overwrote or removed (§8.4) before home ever saw it, reported once with the base it had, for home's conflict copy or its note. */
interface Conflict {
  sha: string
  bytes: number
  base: string | null
  /** Its bytes in the staging (for inline or a pull); null — a removal's, said for the note alone. */
  staged: string | null
  said: Said | null
}

/** A machine's version home has seen and may still pull (its conflict copy, a change it takes), staged before a push replaced it here. */
interface Kept {
  sha: string
  bytes: number
  file: string
  /** Let go after this unless home asks for it meanwhile (each pull of it moves it on). */
  until: number
}

/** A full walk, frozen whole, said in pages. */
interface FullWalk {
  items: FullItem[]
  next: number
  page: number
  /** The seq of the page under way: the same page sent again carries the same seq, for home to know it again. */
  pageSeq: number | null
}

type FullItem =
  | { kind: 'changed'; path: string; sha: string; bytes: number; base: string | null }
  | { kind: 'removed'; path: string; base: string }
  | { kind: 'skipped'; path: string; bytes: number; why: RemoteSkipReason }

/** What a report built took, so that its sync's answer moves it on (reportsSaid) and a verdict finds what it said. */
interface Built {
  walk: FullWalk | null
  items: number
  /** Each change said: its state (the content's sha256, or null for a removal), its length, and whether its bytes rode inline. */
  changes: Map<string, { state: string | null; bytes: number; inline: boolean }>
  conflicts: Set<string>
  skipped: Map<string, string>
  released: string[]
  late: boolean
}

interface Fence {
  at: number
  /** The gens the copy served: the gen its late list is said under. */
  gens: Partial<Record<RemoteKernelRole, number>>
  /** The paths changed since the baseline; null — not read yet. */
  late: string[] | null
  /** The late list went in a sync home took (or there was none to say). */
  said: boolean
  /** The last sync home took held no container of the class: its reply naming none of it means home keeps no copy of it here. */
  clear: boolean
  /** What the sync being built says of the fence: whether its late list rides it, and whether it holds no container of the class. */
  carried: { late: boolean; clear: boolean } | null
  /** When it is looked at again while its containers go. */
  nextAt: number
}

/** How often a fenced copy looks whether the containers of its gens are gone. */
const FENCE_LOOK_MS = 1_000

interface Applying {
  push: RemoteFilesPush
  digest: string
  ops: Op[]
  next: number
  /** A full push came after it: it stops at its next step, never acked. */
  abandoned: boolean
}

type Op = { kind: 'move'; from: string; to: string } | { kind: 'remove'; path: string } | { kind: 'put'; put: RemoteFilesPut }

interface Seen {
  stamp: string
  /** Since when it has kept this stamp (the quiet rule). */
  since: number
  sha: string | null
  bytes: number
  /** It waited out the quiet rule at the end of the walk. */
  waiting: boolean
}

interface Room {
  sessionId: string
  dir: string
  base: Baseline
  /** The gens home names the class at here, by slot. */
  wanted: Partial<Record<RemoteKernelRole, number>>
  /** What the last walk found, by path. */
  seen: Map<string, Seen>
  /** New top folders (nothing in them agreed): when the copy first saw each, and when a path it had not seen last appeared in it. */
  tops: Map<string, { first: number; last: number }>
  records: Records
  changes: Map<string, Change>
  inflight: Map<string, Said>
  /** Reports answered, by seq: what each said, for verdicts that come in later replies. */
  said: Map<number, Built>
  /** Reports built for the sync under way, by seq. */
  sent: Map<number, Built>
  /** What home refused, by path, and why: not said again while the machine holds the same; `pull` — home keeps a copy of it, not inline yet. */
  refused: Map<string, { state: string | null; why: RemoteVerdictReason; pull: boolean }>
  conflicts: Map<string, Conflict>
  kept: Map<string, Kept>
  /** Files said and gone before home took them, never agreed: said removed with the sha said, so that home lets its pull go. */
  retract: Map<string, string>
  /**
   * Files sent home with «Привезти» (a pull of the file as it is), by path:
   * the version each PUT sent, until home's verdict on the path. The report
   * that named such a file named it as left here (`skipped`), never as a
   * change, so only this says what an acceptance agreed on.
   */
  fetched: Map<string, { sha: string; bytes: number }>
  skipped: Map<string, { bytes: number; why: RemoteSkipReason }>
  /** Skipped paths as last said (`bytes:why`). */
  skippedSaid: Map<string, string>
  queue: RemoteFilesPush[]
  applying: Applying | null
  lastPush: string | null
  promoted: boolean
  retryAt: number
  retryMs: number
  /** When the class's last own scan began: the next is due a pace later, the pace read when it is looked at. */
  scannedAt: number
  /** The earliest a file waiting out the quiet rule may be hashed. */
  quietAt: number | null
  asked: boolean
  fullAsked: boolean
  full: FullWalk | null
  fence: Fence | null
  /** Walked at least once in this life: its stats are known, and the book may forget what no copy has. */
  walked: boolean
  seq: number
  work: Promise<void> | null
  abort: AbortController
  afs: Anchored | null
}

interface Upload {
  room: Room
  gen: number
  path: string
  /** The version home asked for; null — the file as it is now («Привезти»). */
  sha: string | null
  tries: number
  notBefore: number
  task: Promise<void> | null
  doneAt: number | null
  abort: AbortController
}

export interface RoomFilesOptions {
  layout: StateLayout
  /**
   * A blob of home's, by hash, through the agent's Cache (its one stream),
   * paced, and ahead of a lease's while `urgent` (a run waits on its push):
   * the path of the verified blob in the CAS.
   */
  blob: (sha: string, bytes: number, options: { signal: AbortSignal; pace: () => number; urgent: () => boolean }) => Promise<string>
  /** A blob copied into its folder, let go (Cache.release). */
  release?: (sha: string) => void
  /** A class's push was promoted while its blob may wait behind a lease's (Cache.hurry). */
  hurry?: () => void
  upload: RoomUploader
  /** The gens of the class the kernel host still holds containers of (kernels.ts · heldGens): a fenced copy waits for them to go. */
  held: (sessionId: string) => Array<{ role: RemoteKernelRole; gen: number }>
  /** When a kernel of the class was last busy in the census (kernels.ts · busyAt); 0 — never. */
  busyAt: (sessionId: string) => number
  /** Something a sync reports changed; `urgent` — an ack, a report, a late list: the held sync is cut short for it. */
  onChange: (urgent: boolean) => void
  /** Home answered an upload 401: the machine is revoked (sync.ts finds out by its own sync). */
  onUnauthorized?: () => void
  log: (line: string) => void
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  timings?: Partial<RoomFileTimings>
  /** The uid what the agent makes is given; null — none (an agent not root). By default KERNEL_UID when the agent is root. */
  uid?: number | null
  random?: () => number
}

/** The gen a class's reports carry: one of its placements here, the room's first. */
const genOf = (gens: Partial<Record<RemoteKernelRole, number>>): number | null => gens.room ?? gens.own ?? gens.council ?? null

/** A change's state as a verdict and a refusal speak of it: its sha256, or null for a removal. */
const stateOf = (change: Change): string | null => (change.kind === 'changed' ? change.sha : null)

const sameGens = (a: Partial<Record<RemoteKernelRole, number>>, b: Partial<Record<RemoteKernelRole, number>>): boolean => ROLES.every((role) => a[role] === b[role])

const depth = (at: string): number => at.split('/').length

/** A name of home's TEMP_FILE shape (workspace.ts), short whatever the target's: what a crash leaves is a hidden temp, swept at the copy's first walk of the next life. */
const tempName = (): string => `.colloq.saving-${randomBytes(6).toString('hex')}`

export class RoomFiles {
  private readonly options: RoomFilesOptions
  private readonly layout: StateLayout
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly timings: RoomFileTimings
  private readonly uid: number | null
  /** The class folders' own book of hashes, by stats and the ctime among them (cache.ts · HashBook). */
  private readonly book: HashBook
  /** The bucket of the class files going home, one for the machine's two upload slots together (a pushed blob's is the Cache's). */
  private readonly upPacer: Pacer
  private readonly rooms = new Map<string, Room>()
  private readonly uploads = new Map<string, Upload>()
  private rates: RemoteKernelsReply['rates'] = { classBulkMBps: CLASS_BULK_IDLE_MBPS, machinePaceMBps: MACHINE_PACE_MBPS }
  private caps: NonNullable<RemoteKernelsReply['caps']> = { machineFileMb: CLASS_MACHINE_FILE_MB, roomMb: CLASS_ROOM_MB }
  /** Home has spoken of classes in this life: a copy it does not name is fenced. */
  private activated = false
  /** Everything is being removed (clear), until a reply speaks of classes again. */
  private cleared = false
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  /** Reports are offered to the classes in turn, a different one first at every sync. */
  private turn = 0
  private pruned = false

  constructor(options: RoomFilesOptions) {
    this.options = options
    this.layout = options.layout
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? pause
    this.timings = { ...ROOM_FILE_TIMINGS, ...options.timings }
    this.uid = options.uid !== undefined ? options.uid : process.getuid?.() === 0 ? KERNEL_UID : null
    this.book = new HashBook(path.join(this.layout.booksDir, 'room-hashes.json'), options.log, { ctime: true })
    this.upPacer = new Pacer(this.now, CLASS_PACE_BURST_BYTES)
  }

  /* ----------------------------------------------------------- the agent's */

  /**
   * At the agent's start: the copies an earlier life left, each with its
   * baseline, held until home's first block says whose they are; the
   * staging of an earlier life goes (its reports went with it).
   */
  load(): void {
    this.book.load()
    let names: string[] = []
    try {
      names = fs.readdirSync(this.layout.roomsDir)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(this.layout.roomsDir, name)
      if (name.endsWith('.staging')) {
        fs.rmSync(full, { recursive: true, force: true })
        continue
      }
      const id = name.endsWith('.baseline.json') ? name.slice(0, -'.baseline.json'.length) : name
      if (!REMOTE_SESSION_ID.test(id) || this.rooms.has(id)) continue
      if (id === name) {
        try {
          if (!fs.lstatSync(full).isDirectory()) continue
        } catch {
          continue
        }
      }
      this.open(id)
    }
  }

  /**
   * A reply's block: which classes are here at which gens (a copy home names
   * nowhere is fenced, one named again lifted, one home has no copy of any
   * more removed), the rates and caps, the verdicts on what was said, the
   * scans home asks for, the pushes and the pulls.
   */
  reconcile(kernels: RemoteKernelsReply): void {
    if (this.stopped) return
    this.cleared = false
    this.activated = true
    this.rates = kernels.rates
    this.caps = kernels.caps ?? { machineFileMb: CLASS_MACHINE_FILE_MB, roomMb: CLASS_ROOM_MB }
    const wanted = new Map<string, Partial<Record<RemoteKernelRole, number>>>()
    for (const intent of kernels.placements) {
      const slot = parseRemotePlacementKey(intent.key)
      if (!slot) continue
      const gens = wanted.get(slot.sessionId) ?? {}
      gens[slot.role] = intent.gen
      wanted.set(slot.sessionId, gens)
    }
    for (const room of [...this.rooms.values()]) {
      const named = wanted.has(room.sessionId)
      if (room.fence) {
        // Named here again before it went (a slot stopped and placed again): home's copy may well be the one this one agreed with.
        if (named) this.lift(room)
        // The answer to a sync that held none of the class's containers, its late list said, and the class still named nowhere here:
        // home keeps no copy of it on this machine now (kernel/remote/files.ts · copiesOn), and neither does the machine.
        else if (room.fence.said && room.fence.clear) this.wipe(room)
        continue
      }
      if (!named) this.fence(room)
    }
    for (const [sessionId, gens] of wanted) {
      const room = this.rooms.get(sessionId) ?? this.open(sessionId)
      room.wanted = gens
      if (sameGens(room.base.gens, gens)) continue
      const recorded = ROLES.some((role) => room.base.gens[role] !== undefined)
      // Named only at gens it never served: home keeps one copy of a class on a machine while any slot of it lives there, and
      // whether that is still the one this copy agreed with, home's next push says. No ack until then (lag).
      if (recorded && room.base.pushSeq > 0 && !ROLES.some((role) => room.base.gens[role] !== undefined && room.base.gens[role] === gens[role])) {
        if (!room.base.doubt) this.options.log(`[runner] class ${sessionId}: home names it here at gens its copy never served; the copy stays, and its ack waits for home's next push`)
        room.base.doubt = true
      }
      room.base.gens = { ...gens }
      this.persist(room)
    }
    for (const verdict of kernels.verdicts) {
      const room = this.rooms.get(verdict.sessionId)
      if (room && !room.fence) this.verdict(room, verdict)
    }
    for (const ask of kernels.scan) {
      const room = this.rooms.get(ask.sessionId)
      if (!room || room.fence) continue
      room.asked = true
      if (ask.full) {
        // A new walk for a full report drops the one being paged (§15); and home rebuilds its copy from it: this copy is home's.
        room.fullAsked = true
        room.full = null
        this.confirm(room)
      }
    }
    for (const push of kernels.pushes) {
      const room = this.rooms.get(push.sessionId)
      if (room && !room.fence) this.enqueue(room, push)
    }
    for (const pull of kernels.pulls) {
      const room = this.rooms.get(pull.sessionId)
      if (room && !room.fence) for (const entry of pull.paths) this.pull(room, pull.gen, entry)
    }
    this.ensureTicking()
    void this.tick()
  }

  /**
   * The reports of the next sync (§8.3): at most one a class, a fenced copy's
   * late list, a page of a full walk, or what changed since the baseline,
   * their paths and inline bytes within the sync's budgets, offered to the
   * classes in turn.
   */
  reportsNow(): RemoteFilesReport[] {
    for (const room of this.rooms.values()) {
      room.sent.clear()
      if (room.fence) room.fence.carried = null
    }
    if (this.cleared) return []
    const out: RemoteFilesReport[] = []
    let paths = REMOTE_REPORT_PATHS_MAX
    const inline = { left: CLASS_INLINE_REPORT_BYTES }
    const add = (room: Room, made: { report: RemoteFilesReport; built: Built } | null): boolean => {
      if (!made) return false
      out.push(made.report)
      room.sent.set(made.report.seq, made.built)
      paths -= made.built.items
      return true
    }
    // A late list first and whole (fifty paths at most), and what this sync says of the fenced copy's containers, for its removal.
    for (const room of this.rooms.values()) {
      const fence = room.fence
      if (!fence || fence.late === null) continue
      const late = !fence.said && fence.late.length > 0 && out.length < REMOTE_PLACEMENTS_MAX && add(room, this.lateReport(room, paths))
      fence.carried = { late, clear: this.options.held(room.sessionId).length === 0 }
    }
    const rooms = [...this.rooms.values()].filter((room) => !room.fence && genOf(room.wanted) !== null)
    if (rooms.length === 0) return out
    const start = this.turn++ % rooms.length
    const turned = [...rooms.slice(start), ...rooms.slice(0, start)]
    // What changed goes first, each class within its share; the full walks, which would take every path, share what is left.
    const order = [...turned.filter((room) => !room.full), ...turned.filter((room) => room.full)]
    for (let i = 0; i < order.length && out.length < REMOTE_PLACEMENTS_MAX && paths > 0; i++) {
      add(order[i]!, this.reportOf(order[i]!, Math.ceil(paths / (order.length - i)), inline))
    }
    return out
  }

  /** The sync that carried these reports was answered: what they said is said, a fenced copy's late list among it. */
  reportsSaid(reports: readonly RemoteFilesReport[]): void {
    this.noteSaid(reports, false)
  }

  /**
   * The sync that carried these reports was cut short by the agent itself
   * (for news, sync.ts · poke) while home held it: home took its block in as
   * it arrived and only then held its answer, so what it said counts as
   * said — a change waits for its verdict (said again after a minute if none
   * comes), a conflict is not said twice (home would keep a second copy), a
   * late list is not said again. What home takes as often as it comes is
   * said again: what stays on the machine, and the page of a full report
   * under way, with its seq (home takes a repeat of the page it collected
   * last as that page, kernel/remote/files.ts · collectPage, and the page if
   * the cut came before it arrived).
   */
  reportsCut(reports: readonly RemoteFilesReport[]): void {
    this.noteSaid(reports, true)
  }

  /** How far the copy is from home (RemoteFilesLag): said in every held placement of the class once it has anything to say. */
  lag(sessionId: string): RemoteFilesLag | null {
    const room = this.rooms.get(sessionId)
    if (!room || room.fence) return null
    let pending = 0
    let pendingBytes = 0
    for (const [at, change] of room.changes) {
      if (room.refused.get(at)?.state === stateOf(change)) continue
      pending++
      if (change.kind === 'changed') pendingBytes = addBytes(pendingBytes, change.bytes)
    }
    for (const conflict of room.conflicts.values()) {
      pending++
      pendingBytes = addBytes(pendingBytes, conflict.bytes)
    }
    let heldOnly = 0
    let heldOnlyBytes = 0
    for (const skip of room.skipped.values()) {
      heldOnly++
      heldOnlyBytes = addBytes(heldOnlyBytes, skip.bytes)
    }
    // A file home turned away for a cap stays here as surely as one never sent.
    for (const [at, refusal] of room.refused) {
      if (refusal.why !== 'cap' || refusal.state === null || room.skipped.has(at)) continue
      heldOnly++
      heldOnlyBytes = addBytes(heldOnlyBytes, room.seen.get(at)?.bytes ?? 0)
    }
    // A copy in doubt says no push applied: an old ack would be taken by a home whose copy is new for the push it has not applied.
    const ack = room.base.doubt ? 0 : room.base.pushSeq
    if (ack === 0 && pending === 0 && heldOnly === 0) return null
    return { pushSeq: ack, pending, pendingBytes, heldOnly, heldOnlyBytes }
  }

  /** When the class's own next scan is due on the copy's clock (the busy or idle pace, or a file's quiet time); null — no copy of it here. */
  due(sessionId: string): number | null {
    const room = this.rooms.get(sessionId)
    if (!room || room.fence) return null
    return this.dueOf(room)
  }

  /**
   * One beat: for each copy one piece of work at a time — a fence moving on,
   * a push applied, a scan due — and the uploads due, two at once.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped || this.cleared || !this.activated) return
    this.ticking = true
    try {
      const now = this.now()
      for (const room of this.rooms.values()) {
        this.expireKept(room, now)
        if (room.work) continue
        if (room.fence) {
          if (room.fence.late === null && now >= room.fence.nextAt) this.run(room, () => this.advanceFence(room))
          continue
        }
        if (genOf(room.wanted) === null) continue
        if (room.queue.length > 0 && now >= room.retryAt) {
          this.run(room, () => this.applyPushes(room))
          continue
        }
        if (room.asked || room.fullAsked || now >= this.dueOf(room)) this.run(room, () => this.scan(room))
      }
      this.pump()
    } finally {
      this.ticking = false
    }
  }

  /** Settled once nothing is under way: no scan, push, fence or upload. */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...[...this.rooms.values()].map((room) => room.work), ...[...this.uploads.values()].map((upload) => upload.task)].filter((task): task is Promise<void> => task !== null)
      if (busy.length === 0) return
      await Promise.allSettled(busy)
    }
  }

  /**
   * Every copy let go before the folders go (a revocation, a leave, a move to
   * another home, kernels.ts · removeAll): what is under way stops and ends,
   * and nothing is written into the class folders until a reply of a new
   * identity speaks of classes.
   */
  async clear(): Promise<void> {
    this.cleared = true
    for (const room of this.rooms.values()) room.abort.abort()
    for (const upload of this.uploads.values()) upload.abort.abort()
    await this.idle()
    for (const room of this.rooms.values()) this.close(room)
    this.rooms.clear()
    this.uploads.clear()
  }

  /** The agent stops: the timer goes and what is under way ends; the copies and their baselines stay for the next life. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const room of this.rooms.values()) room.abort.abort()
    for (const upload of this.uploads.values()) upload.abort.abort()
    this.book.flush()
  }

  /* --------------------------------------------------------------- the beat */

  private ensureTicking(): void {
    if (this.timer || this.stopped || this.timings.beatMs <= 0) return
    this.timer = setInterval(() => void this.tick(), this.timings.beatMs)
    this.timer.unref?.()
  }

  /** One piece of a copy's work; the next is looked for when it ends. */
  private run(room: Room, work: () => Promise<void>): void {
    room.work = work()
      .catch((error: unknown) => this.options.log(`[runner] class files of ${room.sessionId}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
      .finally(() => {
        room.work = null
        void this.tick()
      })
  }

  private open(sessionId: string): Room {
    const base = readBaseline(roomBaselineFile(this.layout, sessionId)) ?? { gens: {}, pushSeq: 0, doubt: false, reportSeq: 0, files: new Map() }
    const room: Room = {
      sessionId,
      dir: roomFolder(this.layout, sessionId),
      base,
      wanted: {},
      seen: new Map(),
      tops: new Map(),
      records: new Map(),
      changes: new Map(),
      inflight: new Map(),
      said: new Map(),
      sent: new Map(),
      refused: new Map(),
      conflicts: new Map(),
      kept: new Map(),
      retract: new Map(),
      fetched: new Map(),
      skipped: new Map(),
      skippedSaid: new Map(),
      queue: [],
      applying: null,
      lastPush: null,
      promoted: false,
      retryAt: 0,
      retryMs: 0,
      scannedAt: 0,
      quietAt: null,
      asked: false,
      fullAsked: false,
      full: null,
      fence: null,
      walked: false,
      // A report's seq outgrows every earlier life's: the last one written down, or the clock, whichever is further.
      seq: Math.max(base.reportSeq, this.now()),
      work: null,
      abort: new AbortController(),
      afs: null,
    }
    this.rooms.set(sessionId, room)
    return room
  }

  /** The copy's anchored filesystem, once the folder is there; null — no folder (nothing pushed, nothing written yet). */
  private fsOf(room: Room): Anchored | null {
    if (room.afs) return room.afs
    try {
      if (!fs.lstatSync(room.dir).isDirectory()) return null
    } catch {
      return null
    }
    room.afs = createAnchoredFilesystem(room.dir)
    return room.afs
  }

  private close(room: Room): void {
    room.afs?.close()
    room.afs = null
  }

  private persist(room: Room): void {
    room.base.reportSeq = Math.max(room.base.reportSeq, room.seq)
    try {
      writeBaseline(roomBaselineFile(this.layout, room.sessionId), room.base)
    } catch (error) {
      this.options.log(`[runner] the baseline of class ${room.sessionId} could not be written down: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Whether a copy's work must stop: aborted, fenced, or no longer the copy of its class. */
  private away(room: Room, signal: AbortSignal): boolean {
    return signal.aborted || room.fence !== null || this.rooms.get(room.sessionId) !== room
  }

  private abs(room: Room, at: string): string {
    return at ? path.join(room.dir, at) : room.dir
  }

  private stagingFile(room: Room): string {
    const dir = roomStaging(this.layout, room.sessionId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return path.join(dir, `${randomBytes(8).toString('hex')}.part`)
  }

  /** «Файл с машины — до» in bytes: past it, nothing of a kernel's goes home, nor is read to be kept aside. */
  private fileCap(): number {
    return this.caps.machineFileMb * MIB
  }

  /** Bytes a second for a class's blobs: its rate, the promoted one while a run waits on its push. */
  private downRate(room: Room): number {
    return (room.promoted ? Math.max(this.rates.classBulkMBps, CLASS_BULK_PROMOTED_MBPS) : this.rates.classBulkMBps) * MIB
  }

  /** The class's own next scan: a pace after the last one began, read now (a class that turned busy is looked at sooner), or a file's quiet time. */
  private dueOf(room: Room): number {
    const paced = room.scannedAt + this.cadence(room)
    return room.quietAt === null ? paced : Math.min(paced, room.quietAt)
  }

  /** The copy is home's after all: its ack is said again (home's push landed here, or home rebuilds from its full report). */
  private confirm(room: Room): void {
    if (!room.base.doubt) return
    room.base.doubt = false
    this.persist(room)
    this.options.onChange(true)
  }

  /* --------------------------------------------------------------- pushes */

  /**
   * A push into the class's queue. The same push again (a reply repeated
   * before home heard the ack) is taken once, by its whole content, never by
   * its seq alone: a home restarted may number its pushes anew — and the one
   * applied last, sent again, says that home's copy is the one this copy
   * agreed with. A full push makes those not begun moot, and the one under
   * way stops at its next step.
   */
  private enqueue(room: Room, push: RemoteFilesPush): void {
    const digest = digestOf(push)
    if (push.promoted && !room.promoted) {
      room.promoted = true
      // Its blob may be waiting behind a lease's: a run waits on it now.
      this.options.hurry?.()
    }
    if (digest === room.lastPush) {
      this.confirm(room)
      return
    }
    if (room.applying?.digest === digest || room.queue.some((queued) => digestOf(queued) === digest)) return
    if (push.full) {
      room.queue = []
      if (room.applying) room.applying.abandoned = true
    }
    room.queue.push(push)
    room.retryAt = 0
  }

  /** The class's pushes in order, each acked once it is applied whole; one that cannot be is tried again later from where it stopped. */
  private async applyPushes(room: Room): Promise<void> {
    // Tried again later, should anything here fail before the end: a push that throws is not begun again at once.
    room.retryMs = room.retryMs > 0 ? Math.min(this.timings.retryMs.last, room.retryMs * 2) : this.timings.retryMs.first
    room.retryAt = this.now() + room.retryMs
    ensureRoomFolder(this.layout, room.sessionId)
    const afs = this.fsOf(room)
    if (!afs) return
    while (room.queue.length > 0 && !room.fence && !room.abort.signal.aborted) {
      const push = room.queue[0]!
      if (!room.applying || room.applying.push !== push) room.applying = { push, digest: digestOf(push), ops: this.opsOf(room, push), next: 0, abandoned: false }
      const applying = room.applying
      const done = await this.applyOps(room, afs, applying)
      if (applying.abandoned) {
        room.applying = null
        if (room.queue[0] === push) room.queue.shift()
        continue
      }
      if (!done) {
        // The wait set above holds: tried again from this step then.
        this.persist(room)
        return
      }
      room.applying = null
      if (room.queue[0] === push) room.queue.shift()
      room.lastPush = applying.digest
      room.base.pushSeq = push.seq
      // Home's push landed: home's copy is the one this copy agrees with now.
      room.base.doubt = false
      room.retryMs = 0
      room.retryAt = 0
      this.persist(room)
      this.options.log(`[runner] class ${room.sessionId}: push ${push.seq} applied (${push.move.length} moved, ${push.remove.length} removed, ${push.put.length} put${push.full ? ', the whole folder' : ''})`)
      // The ack rides the next sync, sent at once (§8.2).
      this.options.onChange(true)
    }
    if (room.queue.length === 0) room.promoted = false
  }

  /**
   * A push's steps in its order (§8.2): moves, removes, then — for a full
   * push — what both sides agreed and it no longer lists, then puts.
   */
  private opsOf(room: Room, push: RemoteFilesPush): Op[] {
    const ops: Op[] = [
      ...push.move.map((move): Op => ({ kind: 'move', from: move.from, to: move.to })),
      ...push.remove.map((at): Op => ({ kind: 'remove', path: at })),
    ]
    if (push.full) {
      // Kept: every path the push lists, and every folder above one (a put names its file, and its folders are there with it).
      const kept = new Set<string>()
      for (const put of push.put) for (let at = put.path; at !== '' && !kept.has(at); at = parentOf(at)) kept.add(at)
      let last: string | null = null
      for (const at of [...room.base.files.keys()].sort()) {
        if (kept.has(at) || (last !== null && isInside(at, last))) continue
        ops.push({ kind: 'remove', path: at })
        last = at
      }
    }
    ops.push(...push.put.map((put): Op => ({ kind: 'put', put })))
    return ops
  }

  /** The steps from where the last try stopped; false — one could not be taken now, and no later push takes its place. */
  private async applyOps(room: Room, afs: Anchored, applying: Applying): Promise<boolean> {
    let since = this.now()
    for (; applying.next < applying.ops.length; applying.next++) {
      if (applying.abandoned || room.fence || room.abort.signal.aborted) return false
      const op = applying.ops[applying.next]!
      try {
        if (op.kind === 'move') await this.move(room, afs, op.from, op.to)
        else if (op.kind === 'remove') await this.remove(room, afs, op.path)
        else await this.put(room, afs, op.put)
      } catch (error) {
        const at = op.kind === 'move' ? op.to : op.kind === 'remove' ? op.path : op.put.path
        // A later push of the same path says what home has now: this step is moot.
        if (room.queue.slice(1).some((later) => touches(later, at))) {
          this.options.log(`[runner] class ${room.sessionId}: ${at} of push ${applying.push.seq} is left to a later push (${error instanceof Error ? error.message : String(error)})`)
          continue
        }
        this.options.log(`[runner] class ${room.sessionId}: push ${applying.push.seq} stopped at ${at} (${error instanceof Error ? error.message : String(error)}); tried again`)
        return false
      }
      // A long push writes down what it has done as it goes: a restart halfway re-reads none of it as the machine's own change.
      if (this.now() - since >= 2_000) {
        this.persist(room)
        since = this.now()
      }
    }
    return true
  }

  /** A path moved at home: renamed here, what both sides agreed under it with it; a source the machine no longer has comes back by its content. */
  private async move(room: Room, afs: Anchored, from: string, to: string): Promise<void> {
    const source = lstatOf(afs, this.abs(room, from))
    if (!source || !(source.isFile() || source.isDirectory())) {
      // Gone here (or a link now), never mind the move: home's files at their new place, by what both sides agreed they were.
      // Each put is one a retry takes again as it is; the old names go only once every one has landed.
      const agreed = under(room.base.files, from)
      for (const [at, entry] of agreed) {
        const target = `${to}${at.slice(from.length)}`
        if (entry.base === REMOTE_DIR_BASE) await this.put(room, afs, { path: target, dir: true })
        else await this.put(room, afs, { path: target, sha256: entry.base, bytes: entry.bytes })
      }
      for (const [at] of agreed) if (!isInside(at, to)) room.base.files.delete(at)
      return
    }
    await this.clearPlace(room, afs, to)
    await this.parents(room, afs, to)
    afs.renameSync(this.abs(room, from), this.abs(room, to))
    rekey(room.base.files, from, to)
    rekey(room.seen, from, to)
    rekey(room.refused, from, to)
    rekey(room.fetched, from, to)
    // What the scan found under the old name and has not said is the same change under the new one.
    for (const [at, change] of [...room.changes]) {
      if (!isInside(at, from) || room.inflight.has(at)) continue
      room.changes.delete(at)
      room.changes.set(`${to}${at.slice(from.length)}`, change)
    }
  }

  /** A path removed at home: removed here, whatever the machine made of it (the delete holds, §8.4), a change home never saw kept aside for its note. */
  private async remove(room: Room, afs: Anchored, at: string): Promise<void> {
    const stat = lstatOf(afs, this.abs(room, at))
    if (stat?.isFile()) await this.keepAside(room, afs, at, stat, this.book.known(stat), false)
    if (stat) afs.rmSync(this.abs(room, at), { recursive: true, force: true })
    for (const [entry] of under(room.base.files, at)) room.base.files.delete(entry)
    for (const map of [room.seen, room.changes, room.refused, room.retract, room.fetched] as Array<Map<string, unknown>>) for (const entry of [...map.keys()]) if (isInside(entry, at)) map.delete(entry)
  }

  /**
   * A path put at home. A folder is made. One home did not change since both
   * sides agreed is the machine's change, left for its report — unless home
   * refused that change, which this put now overwrites. A file the machine
   * already holds as home has it is only agreed. Otherwise home's version is
   * written, a machine's version that differs kept aside first (keepAside).
   */
  private async put(room: Room, afs: Anchored, put: RemoteFilesPut): Promise<void> {
    const at = put.path
    const full = this.abs(room, at)
    const signal = room.abort.signal
    if (put.dir) {
      await this.parents(room, afs, at)
      const stat = lstatOf(afs, full)
      if (!stat?.isDirectory()) {
        if (stat?.isFile()) await this.keepAside(room, afs, at, stat, this.book.known(stat), true)
        if (stat) afs.rmSync(full, { recursive: true, force: true })
        this.mkdir(afs, full)
      }
      room.base.files.set(at, { base: REMOTE_DIR_BASE, bytes: 0 })
      room.changes.delete(at)
      return
    }
    const agreed = room.base.files.get(at)
    if (agreed?.base === put.sha256 && !room.refused.has(at)) return
    const stat = lstatOf(afs, full)
    if (stat?.isFile()) {
      const bytes = statBytes(stat)
      // From the book, or read — but no file past the cap is read unless it may be home's very version (by its length).
      const current = this.book.known(stat) ?? (bytes <= this.fileCap() || bytes === put.bytes ? (await hashAt(afs, full, stat, undefined, signal))?.sha ?? null : null)
      if (signal.aborted) throw new Error('the class stopped meanwhile')
      if (current === put.sha256) {
        this.book.noteStat(stat, put.sha256)
        this.agree(room, at, put.sha256, put.bytes)
        return
      }
      if (current === null || current !== agreed?.base) await this.keepAside(room, afs, at, stat, current, true)
    }
    await this.parents(room, afs, at)
    let blob: string | null = null
    const content = put.inline !== undefined
      ? Buffer.from(put.inline, 'base64')
      : (blob = await this.options.blob(put.sha256, put.bytes, { signal, pace: () => this.downRate(room), urgent: () => room.promoted }))
    if (signal.aborted) throw new Error('the class stopped meanwhile')
    const written = await this.write(afs, full, content, put.sha256, put.bytes)
    this.book.noteStat(written, put.sha256)
    this.agree(room, at, put.sha256, put.bytes)
    room.seen.set(at, { stamp: stampOf(written), since: this.now(), sha: put.sha256, bytes: put.bytes, waiting: false })
    if (blob !== null && !this.blobNeeded(put.sha256, room)) this.options.release?.(put.sha256)
  }

  /**
   * Whether a step not yet taken, of this class or another, still copies this
   * blob into its folder: the steps after the caller's current one, every
   * other class's from its current one (its put of the same blob may be under
   * way), queued pushes, and the content agreed under a move's source (a move
   * whose source is gone puts it back by its hash).
   */
  private blobNeeded(sha: string, caller: Room): boolean {
    for (const room of this.rooms.values()) {
      const applying = room.applying
      const later = applying ? applying.ops.slice(applying.next + (room === caller ? 1 : 0)) : []
      const queued = room.queue.filter((push) => push !== applying?.push).flatMap((push) => this.opsOf(room, push))
      for (const op of [...later, ...queued]) {
        if (op.kind === 'put' && op.put.sha256 === sha && op.put.inline === undefined) return true
        if (op.kind === 'move' && under(room.base.files, op.from).some(([, agreed]) => agreed.base === sha)) return true
      }
    }
    return false
  }

  private agree(room: Room, at: string, sha: string, bytes: number): void {
    room.base.files.set(at, { base: sha, bytes })
    room.refused.delete(at)
    room.changes.delete(at)
    room.retract.delete(at)
    room.fetched.delete(at)
  }

  /**
   * What home was told of the machine's version `sha` of a path: 'pull' — it
   * was said, its bytes not inline, and home may still pull them (its verdict
   * to come, or a conflict copy it keeps); 'had' — home has its bytes or wants
   * none, or they are kept aside already; null — never said.
   */
  private told(room: Room, at: string, sha: string): 'pull' | 'had' | null {
    const flight = room.inflight.get(at)
    if (flight?.state === sha) return flight.inline ? 'had' : 'pull'
    const refused = room.refused.get(at)
    if (refused?.state === sha) return refused.pull ? 'pull' : 'had'
    if (room.conflicts.get(at)?.sha === sha || room.kept.get(at)?.sha === sha) return 'had'
    return null
  }

  /**
   * The machine's version of a path, before home's push replaces it (`stage`)
   * or removes it (§8.4). Nothing of a version both sides agreed on, nor of
   * one past machineFileMb (never read: it could never be home's copy). One
   * home has seen is not said again — home would keep a second copy — its
   * bytes only staged while home may still pull them (`kept`). One home never
   * saw is a conflict: copied to the staging and hashed as it is copied, or
   * only hashed for a removal's note.
   */
  private async keepAside(room: Room, afs: Anchored, at: string, stat: fs.BigIntStats, known: string | null, stage: boolean): Promise<void> {
    const base = room.base.files.get(at)?.base ?? null
    if (known !== null && known === base) return
    const bytes = statBytes(stat)
    if (bytes > this.fileCap()) {
      this.options.log(`[runner] class ${room.sessionId}: ${at} changed here too, ${bytes} bytes, over the cap: home's version takes its place, and the machine's is not kept`)
      return
    }
    const signal = room.abort.signal
    // A removal reads no more than it must: the hash, for its note, unless home may still pull the version.
    const sha = known ?? (stage ? null : (await hashAt(afs, this.abs(room, at), stat, undefined, signal))?.sha ?? null)
    if (sha !== null) {
      if (sha === base) return
      const told = this.told(room, at, sha)
      if (told === 'had') return
      // Home never saw what the machine had where home's delete holds: its note needs no bytes.
      if (told === null && !stage) {
        this.setConflict(room, at, { sha, bytes, base, staged: null, said: null })
        return
      }
    } else if (!stage) return
    const staged = this.stagingFile(room)
    const copy = await hashAt(afs, this.abs(room, at), stat, staged, signal)
    if (!copy) return
    const told = copy.sha === base ? 'had' : this.told(room, at, copy.sha)
    if (told === 'had' || (told === null && !stage)) {
      fs.rmSync(staged, { force: true })
      return
    }
    if (told === 'pull') {
      this.keep(room, at, copy.sha, copy.bytes, staged)
      return
    }
    this.setConflict(room, at, { sha: copy.sha, bytes: copy.bytes, base, staged, said: null })
    this.options.log(`[runner] class ${room.sessionId}: ${at} changed here and at home; the machine's version goes home for its conflict copy`)
  }

  private setConflict(room: Room, at: string, conflict: Conflict): void {
    const old = room.conflicts.get(at)
    if (old?.staged) {
      // An older version said and not yet decided: kept for the pull home may still make of it.
      if (old.said && !old.said.inline) this.keep(room, at, old.sha, old.bytes, old.staged)
      else fs.rmSync(old.staged, { force: true })
    }
    room.conflicts.set(at, conflict)
    room.changes.delete(at)
  }

  /** A machine's version home has seen, staged for the pull home may make of it: one a path, the newest. */
  private keep(room: Room, at: string, sha: string, bytes: number, file: string): void {
    const old = room.kept.get(at)
    if (old && old.file !== file) fs.rmSync(old.file, { force: true })
    room.kept.set(at, { sha, bytes, file, until: this.now() + this.timings.verdictMs })
  }

  private dropKept(room: Room, at: string, which?: Kept): void {
    const kept = room.kept.get(at)
    if (!kept || (which !== undefined && kept !== which)) return
    room.kept.delete(at)
    fs.rmSync(kept.file, { force: true })
  }

  /** Kept versions home has not asked for in their time, let go: none is under way. */
  private expireKept(room: Room, now: number): void {
    for (const [at, kept] of [...room.kept]) {
      if (now < kept.until) continue
      const upload = this.uploads.get(`${room.sessionId}\u0000${at}`)
      if (upload?.task) continue
      this.dropKept(room, at, kept)
    }
  }

  /** Every folder above `at`, made where it is missing; a file, a link or a special file in the way goes, a file kept aside first. */
  private async parents(room: Room, afs: Anchored, at: string): Promise<void> {
    const parts = at.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const stat = lstatOf(afs, this.abs(room, dir))
      if (stat?.isDirectory()) continue
      if (stat?.isFile()) await this.keepAside(room, afs, dir, stat, this.book.known(stat), true)
      if (stat) afs.rmSync(this.abs(room, dir), { force: true })
      this.mkdir(afs, this.abs(room, dir))
      if (!room.base.files.has(dir)) room.base.files.set(dir, { base: REMOTE_DIR_BASE, bytes: 0 })
    }
  }

  /** What a place must be free of before a move lands there: a machine's file kept aside, then whatever is there removed. */
  private async clearPlace(room: Room, afs: Anchored, at: string): Promise<void> {
    const stat = lstatOf(afs, this.abs(room, at))
    if (!stat) return
    if (stat.isFile()) await this.keepAside(room, afs, at, stat, this.book.known(stat), true)
    afs.rmSync(this.abs(room, at), { recursive: true, force: true })
    for (const [entry] of under(room.base.files, at)) room.base.files.delete(entry)
  }

  /** A folder as home's sessionDir makes one: the kernels' uid when the agent is root, then 2775 (a chown clears a setgid bit on some systems). */
  private mkdir(afs: Anchored, dir: string): void {
    try {
      afs.mkdirSync(dir, { mode: 0o2775 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const fd = afs.openSync(dir, 'r')
    try {
      if (this.uid !== null) fs.fchownSync(fd, this.uid, this.uid)
      fs.fchmodSync(fd, 0o2775)
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * A file of home's into the copy: a temp of home's TEMP_FILE shape beside
   * it, opened through the anchored filesystem, its content checked by its
   * hash as it is written (`content`: the bytes, or a verified blob of the
   * CAS to copy, never to link), flushed, the kernels' uid and 0664, then
   * renamed over the target. Its stats after the rename, for the book.
   */
  private async write(afs: Anchored, target: string, content: Buffer | string, sha: string, bytes: number): Promise<fs.BigIntStats> {
    const temporary = path.join(path.dirname(target), tempName())
    const fd = afs.openSync(temporary, 'wx', 0o664)
    let open = true
    let renamed = false
    try {
      const hash = createHash('sha256')
      let written = 0
      const put = async (chunk: Buffer): Promise<void> => {
        hash.update(chunk)
        for (let at = 0; at < chunk.length;) {
          at += await new Promise<number>((resolve, reject) => fs.write(fd, chunk, at, chunk.length - at, null, (error, count) => (error ? reject(error) : resolve(count))))
        }
        written += chunk.length
      }
      if (typeof content === 'string') {
        const source = await fs.promises.open(content, 'r')
        try {
          const buffer = Buffer.allocUnsafe(MIB)
          for (;;) {
            const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
            if (bytesRead === 0) break
            await put(buffer.subarray(0, bytesRead))
          }
        } finally {
          await source.close()
        }
      } else await put(content)
      if (written !== bytes || hash.digest('hex') !== sha) throw new Error(`the content is not the ${bytes} bytes of ${sha.slice(0, 12)} home named`)
      fs.fsyncSync(fd)
      if (this.uid !== null) fs.fchownSync(fd, this.uid, this.uid)
      fs.fchmodSync(fd, 0o664)
      open = false
      fs.closeSync(fd)
      const there = lstatOf(afs, target)
      if (there && !there.isFile()) afs.rmSync(target, { recursive: true, force: true })
      afs.renameSync(temporary, target)
      renamed = true
      const stat = lstatOf(afs, target)
      if (!stat) throw new Error('the file went right after it was written')
      return stat
    } finally {
      // Closed once and never again: a number closed twice may by then be another file's.
      if (open) fs.closeSync(fd)
      if (!renamed) {
        try {
          afs.rmSync(temporary, { force: true })
        } catch { /* swept at the copy's first walk of the next life */ }
      }
    }
  }

  /* ---------------------------------------------------------------- scans */

  /**
   * A scan (§8.3): the walk, the quiet rule (unless home asked), the caps,
   * the hashes of what is quiet and not booked, and the copy's changes since
   * its baseline. A full one freezes the walk for its pages. The first of a
   * life sweeps the temps a crash left.
   */
  private async scan(room: Room): Promise<void> {
    const asked = room.asked
    const full = room.fullAsked
    room.asked = false
    room.fullAsked = false
    const now = this.now()
    // The next is due a pace from now, before anything here can fail: a scan that throws is not begun again at once.
    room.scannedAt = now
    room.quietAt = null
    const afs = this.fsOf(room)
    if (!afs) {
      if (full) room.full = { items: [], next: 0, page: 0, pageSeq: null }
      return
    }
    const signal = room.abort.signal
    const first = !room.walked
    const walk = await walkCopy(afs, room.dir, room.base.files, CLASS_SYNC_FILES_MAX, room.records, first)
    if (this.away(room, signal)) return
    // What a crash of an earlier life left mid-write: a hidden temp beside its target, never a file of the class.
    if (first) {
      for (const at of walk.temps) {
        try {
          afs.rmSync(this.abs(room, at), { force: true })
        } catch { /* the next life's walk */ }
      }
    }
    const seen: Room['seen'] = new Map()
    const skipped: Room['skipped'] = new Map()
    for (const [at, bytes] of walk.packages) skipped.set(at, { bytes, why: 'package' })
    for (const at of walk.over) skipped.set(at, { bytes: 0, why: 'count' })
    const fileCap = this.fileCap()
    // The top folders something in which both sides agreed: none of them new.
    const agreedTops = new Set<string>()
    for (const at of room.base.files.keys()) agreedTops.add(topOf(at))
    const tops: Room['tops'] = new Map()
    for (const [at, stat] of walk.files) {
      const stamp = stampOf(stat)
      const before = room.seen.get(at)
      const same = before !== undefined && before.stamp === stamp
      seen.set(at, { stamp, since: same ? before.since : now, sha: same && before.sha !== null ? before.sha : this.book.known(stat), bytes: statBytes(stat), waiting: false })
      if (!at.includes('/')) continue
      const top = topOf(at)
      if (agreedTops.has(top)) continue
      const hold = tops.get(top) ?? { ...(room.tops.get(top) ?? { first: now, last: now }) }
      // A path the last walk did not see: the folder is still being filled (an install, an archive coming apart).
      if (before === undefined) hold.last = now
      tops.set(top, hold)
    }
    room.tops = tops
    let waiting: number | null = null
    for (const [at, stat] of walk.files) {
      const entry = seen.get(at)!
      if (entry.bytes > fileCap) {
        // Nothing past «Файл с машины — до» is read. One both sides agreed on and unchanged since, its hash booked by these very
        // stats (home's push of it, or its «Привезти»), is home's as much as the machine's: no change, and nothing left only here.
        if (entry.sha === null || room.base.files.get(at)?.base !== entry.sha) skipped.set(at, { bytes: entry.bytes, why: 'size' })
        continue
      }
      if (entry.sha !== null) continue
      const hold = at.includes('/') ? tops.get(topOf(at)) : undefined
      const settles = hold ? Math.min(hold.last + this.timings.quietMs, hold.first + this.timings.newFolderMs) : 0
      const quietAt = Math.max(entry.since + this.timings.quietMs, settles)
      if (!asked && now < quietAt) {
        const before = room.seen.get(at)
        entry.waiting = true
        // Looked at again at its quiet time when it begins to wait; one that changed again while it waited, at the class's pace.
        if (!before?.waiting || before.stamp === entry.stamp) waiting = Math.min(waiting ?? Infinity, quietAt)
        continue
      }
      const read = await hashAt(afs, path.join(room.dir, at), stat, undefined, signal)
      if (this.away(room, signal)) return
      if (read === null) {
        // It moved under the read: not quiet after all.
        entry.since = this.now()
        entry.waiting = true
        waiting = Math.min(waiting ?? Infinity, entry.since + this.timings.quietMs)
        continue
      }
      entry.sha = read.sha
      this.book.noteStat(read.stat, read.sha)
    }
    // The room limit: what both sides agreed first, then the changes in the walk's order.
    const roomCap = this.caps.roomMb * MIB
    let total = 0
    for (const [at, entry] of seen) if (!skipped.has(at) && entry.sha !== null && room.base.files.get(at)?.base === entry.sha) total = addBytes(total, entry.bytes)
    for (const [at, entry] of seen) {
      if (skipped.has(at) || entry.sha === null || room.base.files.get(at)?.base === entry.sha) continue
      if (total + entry.bytes > roomCap) skipped.set(at, { bytes: entry.bytes, why: 'room' })
      else total = addBytes(total, entry.bytes)
    }
    const changes = new Map<string, Change>()
    for (const [at, entry] of seen) {
      if (skipped.has(at)) continue
      if (entry.sha === null) {
        // Not hashed yet: what was found of it before stands until it is.
        const before = room.changes.get(at)
        if (before) changes.set(at, before)
        continue
      }
      if (room.base.files.get(at)?.base !== entry.sha) changes.set(at, { kind: 'changed', sha: entry.sha, bytes: entry.bytes })
    }
    /** Under a folder left on the machine (a package's, past the ceiling): not gone, only not walked. */
    const heldUnder = (at: string): boolean => {
      for (let dir = parentOf(at); dir !== ''; dir = parentOf(dir)) if (skipped.has(dir)) return true
      return false
    }
    for (const [at, agreed] of room.base.files) {
      if (seen.has(at) || skipped.has(at) || heldUnder(at)) continue
      if (agreed.base === REMOTE_DIR_BASE && walk.dirs.has(at)) continue
      if (!gone(walk, at)) continue
      changes.set(at, { kind: 'removed', base: agreed.base })
    }
    // A file said and gone before home took it, never agreed: said removed as the version said, so that home lets its pull go.
    for (const [at, sha] of [...room.retract]) {
      if (seen.has(at) || skipped.has(at) || room.base.files.has(at)) room.retract.delete(at)
      else if (gone(walk, at)) changes.set(at, { kind: 'removed', base: sha })
    }
    room.seen = seen
    room.changes = changes
    room.skipped = skipped
    room.quietAt = waiting
    room.walked = true
    if (full) room.full = this.freeze(room, seen, skipped)
    this.prune()
    if (full || this.anythingToSay(room)) this.options.onChange(true)
  }

  /** The class's own scan's pace: busy while a kernel of it computed within the minute (§8.3), idle otherwise. */
  private cadence(room: Room): number {
    return this.now() - this.options.busyAt(room.sessionId) < this.timings.busyWindowMs ? this.timings.busyMs : this.timings.idleMs
  }

  /** Once every copy has been walked in this life, what the book knew of files no longer here goes. */
  private prune(): void {
    if (this.pruned || [...this.rooms.values()].some((room) => !room.fence && !room.walked)) return
    this.pruned = true
    this.book.prune()
    this.book.save()
  }

  /** A full walk's items (§8.4): every file of the copy with its base, every agreed path gone, every file left on the machine. */
  private freeze(room: Room, seen: Room['seen'], skipped: Room['skipped']): FullWalk {
    const items: FullItem[] = []
    for (const [at, entry] of seen) {
      if (skipped.has(at) || entry.sha === null) continue
      items.push({ kind: 'changed', path: at, sha: entry.sha, bytes: entry.bytes, base: room.base.files.get(at)?.base ?? null })
    }
    for (const [at, change] of room.changes) if (change.kind === 'removed') items.push({ kind: 'removed', path: at, base: change.base })
    for (const [at, skip] of skipped) items.push({ kind: 'skipped', path: at, bytes: skip.bytes, why: skip.why })
    items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { items, next: 0, page: 0, pageSeq: null }
  }

  /** Whether the next report of the class would say anything. */
  private anythingToSay(room: Room): boolean {
    const now = this.now()
    for (const [at, change] of room.changes) if (this.sayable(room, at, stateOf(change), now)) return true
    for (const conflict of room.conflicts.values()) if (!conflict.said || now - conflict.said.at >= this.timings.verdictMs) return true
    for (const [at, skip] of room.skipped) if (room.skippedSaid.get(at) !== `${skip.bytes}:${skip.why}`) return true
    for (const at of room.skippedSaid.keys()) if (!room.skipped.has(at)) return true
    return false
  }

  /** Whether a change may be said now: not one waiting for its verdict, not one home refused as it is. */
  private sayable(room: Room, at: string, state: string | null, now: number): boolean {
    const flight = room.inflight.get(at)
    if (flight && now - flight.at < this.timings.verdictMs) return false
    const refused = room.refused.get(at)
    if (refused && refused.state === state) return false
    const conflict = room.conflicts.get(at)
    return !conflict
  }

  /* -------------------------------------------------------------- reports */

  /** A fenced copy's late list (§8.8), whole or not at all, under a gen of the placements it served. */
  private lateReport(room: Room, share: number): { report: RemoteFilesReport; built: Built } | null {
    const fence = room.fence!
    const gen = genOf(fence.gens)
    if (gen === null || fence.late === null || fence.late.length === 0 || share < fence.late.length) return null
    const built: Built = { walk: null, items: fence.late.length, changes: new Map(), conflicts: new Set(), skipped: new Map(), released: [], late: true }
    return { report: { sessionId: room.sessionId, gen, seq: ++room.seq, changed: [], removed: [], skipped: [], late: [...fence.late] }, built }
  }

  private reportOf(room: Room, share: number, inline: { left: number }): { report: RemoteFilesReport; built: Built } | null {
    const built: Built = { walk: null, items: 0, changes: new Map(), conflicts: new Set(), skipped: new Map(), released: [], late: false }
    const gen = genOf(room.wanted)
    if (gen === null) return null
    if (room.full) {
      const walk = room.full
      const page = walk.items.slice(walk.next, walk.next + Math.max(share, 0))
      if (page.length === 0 && walk.items.length > walk.next) return null
      // The page under way, sent again (its sync went unanswered), carries its seq again: home knows it for the same page.
      walk.pageSeq ??= ++room.seq
      const report: RemoteFilesReport = { sessionId: room.sessionId, gen, seq: walk.pageSeq, changed: [], removed: [], skipped: [] }
      for (const item of page) {
        if (item.kind === 'skipped') {
          report.skipped.push({ path: item.path, bytes: item.bytes, why: item.why })
          built.skipped.set(item.path, `${item.bytes}:${item.why}`)
        } else if (item.kind === 'removed') {
          report.removed.push({ path: item.path, base: item.base })
          built.changes.set(item.path, { state: null, bytes: 0, inline: false })
        } else {
          const entry: RemoteFilesReport['changed'][number] = { path: item.path, sha256: item.sha, bytes: item.bytes, base: item.base }
          // A file as both sides agreed it is listed for home's rebuild; only one that differs is a change to answer.
          if (item.sha !== item.base) {
            this.inlineOf(room, entry, null, inline)
            built.changes.set(item.path, { state: item.sha, bytes: item.bytes, inline: entry.inline !== undefined })
          }
          report.changed.push(entry)
        }
      }
      report.full = true
      report.page = { index: walk.page, last: walk.next + page.length >= walk.items.length }
      built.walk = walk
      built.items = page.length
      return { report, built }
    }
    const report: RemoteFilesReport = { sessionId: room.sessionId, gen, seq: ++room.seq, changed: [], removed: [], skipped: [] }
    const now = this.now()
    let left = share
    const take = (): boolean => left-- > 0
    for (const [at, conflict] of room.conflicts) {
      if (conflict.said && now - conflict.said.at < this.timings.verdictMs) continue
      if (!take()) break
      const entry: RemoteFilesReport['changed'][number] = { path: at, sha256: conflict.sha, bytes: conflict.bytes, base: conflict.base }
      this.inlineOf(room, entry, conflict.staged, inline)
      report.changed.push(entry)
      built.changes.set(at, { state: conflict.sha, bytes: conflict.bytes, inline: entry.inline !== undefined })
      built.conflicts.add(at)
    }
    // Removals deepest first: a folder is emptied before it goes.
    const removals = [...room.changes].filter((entry): entry is [string, Extract<Change, { kind: 'removed' }>] => entry[1].kind === 'removed').sort((a, b) => depth(b[0]) - depth(a[0]))
    for (const [at, change] of removals) {
      if (!this.sayable(room, at, null, now) || built.changes.has(at)) continue
      if (!take()) break
      report.removed.push({ path: at, base: change.base })
      built.changes.set(at, { state: null, bytes: 0, inline: false })
    }
    for (const [at, change] of room.changes) {
      if (change.kind !== 'changed' || built.changes.has(at) || !this.sayable(room, at, change.sha, now)) continue
      if (!take()) break
      const entry: RemoteFilesReport['changed'][number] = { path: at, sha256: change.sha, bytes: change.bytes, base: room.base.files.get(at)?.base ?? null }
      this.inlineOf(room, entry, null, inline)
      report.changed.push(entry)
      built.changes.set(at, { state: change.sha, bytes: change.bytes, inline: entry.inline !== undefined })
    }
    for (const [at, skip] of room.skipped) {
      const signature = `${skip.bytes}:${skip.why}`
      if (room.skippedSaid.get(at) === signature || built.changes.has(at)) continue
      if (!take()) break
      report.skipped.push({ path: at, bytes: skip.bytes, why: skip.why })
      built.skipped.set(at, signature)
    }
    for (const at of room.skippedSaid.keys()) {
      if (room.skipped.has(at)) continue
      if (!take()) break
      built.released.push(at)
    }
    if (built.released.length > 0) report.released = [...built.released]
    built.items = built.changes.size + built.skipped.size + built.released.length
    if (built.items === 0) {
      room.seq--
      return null
    }
    return { report, built }
  }

  /**
   * A changed file's content in its report when it is small and the sync's
   * budget allows: read from the staging (a conflict's copy) or through a
   * descriptor that follows no link, and only if it is still the version said.
   */
  private inlineOf(room: Room, entry: RemoteFilesReport['changed'][number], staged: string | null, inline: { left: number }): void {
    if (entry.bytes > CLASS_INLINE_BYTES || entry.bytes > inline.left) return
    let body: Buffer | null = null
    if (staged) {
      try {
        body = fs.readFileSync(staged)
      } catch {
        body = null
      }
    } else {
      const afs = this.fsOf(room)
      body = afs ? readSmall(afs, this.abs(room, entry.path), CLASS_INLINE_BYTES) : null
    }
    if (body === null || body.length !== entry.bytes || createHash('sha256').update(body).digest('hex') !== entry.sha256) return
    entry.inline = body.toString('base64')
    inline.left -= entry.bytes
  }

  /** What a sync carried, said: answered (reportsSaid), or cut short by the agent itself (reportsCut: what stays on the machine and a page go again). */
  private noteSaid(reports: readonly RemoteFilesReport[], cut: boolean): void {
    const now = this.now()
    for (const room of this.rooms.values()) {
      const fence = room.fence
      if (!fence?.carried) continue
      // Its late list went only if the sync carried it (one left out of a sync goes in the next).
      const went = fence.carried.late && reports.some((report) => report.sessionId === room.sessionId && report.late !== undefined)
      if (went || fence.late?.length === 0) fence.said = true
      fence.clear = fence.carried.clear
      fence.carried = null
    }
    for (const report of reports) {
      const room = this.rooms.get(report.sessionId)
      const built = room?.sent.get(report.seq)
      if (!room || !built) continue
      room.sent.delete(report.seq)
      if (built.late) continue
      if (built.walk && room.full === built.walk && !cut) {
        room.full.next += built.items
        room.full.page++
        room.full.pageSeq = null
        if (room.full.next >= room.full.items.length) room.full = null
      }
      for (const [at, change] of built.changes) {
        const said: Said = { seq: report.seq, at: now, state: change.state, inline: change.inline }
        const conflict = built.conflicts.has(at) ? room.conflicts.get(at) : undefined
        if (conflict) conflict.said = said
        else room.inflight.set(at, said)
      }
      if (!cut) {
        for (const [at, signature] of built.skipped) room.skippedSaid.set(at, signature)
        for (const at of built.released) room.skippedSaid.delete(at)
      }
      room.said.set(report.seq, built)
      for (const seq of [...room.said.keys()].slice(0, Math.max(0, room.said.size - SAID_KEPT))) room.said.delete(seq)
    }
    void this.tick()
  }

  /* ------------------------------------------------------------- verdicts */

  /**
   * Home's verdict on a report (§8.3): an accepted path moves into the
   * baseline, a refused one stays home's (its next push overwrites it here).
   * A conflict's version is let go once decided — or staged on, while home
   * may still pull it for its conflict copy (or to take it after all). A
   * file brought with «Привезти» comes under the report that named it as
   * left here, perhaps long forgotten: what home took is the version its
   * PUT sent.
   */
  private verdict(room: Room, verdict: RemoteKernelsReply['verdicts'][number]): void {
    const built = room.said.get(verdict.seq)
    let changed = false
    for (const at of verdict.accepted) {
      const brought = room.fetched.get(at)
      if (!brought || built?.changes.has(at)) continue
      room.fetched.delete(at)
      room.base.files.set(at, { base: brought.sha, bytes: brought.bytes })
      room.refused.delete(at)
      room.retract.delete(at)
      changed = true
    }
    for (const refusal of verdict.refused) if (!built?.changes.has(refusal.path)) room.fetched.delete(refusal.path)
    if (!built) {
      if (changed) this.persist(room)
      return
    }
    for (const at of verdict.accepted) {
      const said = built.changes.get(at)
      if (!said) continue
      const { state } = said
      if (built.conflicts.has(at)) {
        // Home's file was back at the base: it takes the machine's version after all, and its next push brings it here.
        this.settleConflict(room, at, state, !said.inline)
        continue
      }
      if (state === null) for (const [entry] of under(room.base.files, at)) room.base.files.delete(entry)
      else room.base.files.set(at, { base: state, bytes: said.bytes })
      changed = true
      room.refused.delete(at)
      room.retract.delete(at)
      const flight = room.inflight.get(at)
      if (flight && (flight.seq === verdict.seq || flight.state === state)) room.inflight.delete(at)
      const live = room.changes.get(at)
      if (live && stateOf(live) === state) room.changes.delete(at)
    }
    for (const refusal of verdict.refused) {
      const said = built.changes.get(refusal.path)
      if (!said) continue
      const { state } = said
      const flight = room.inflight.get(refusal.path)
      if (flight && flight.seq === verdict.seq) room.inflight.delete(refusal.path)
      // Home keeps the machine's version as its conflict copy: it pulls the bytes unless they came inline.
      const pull = refusal.copy !== undefined && !said.inline && state !== null
      if (built.conflicts.has(refusal.path)) {
        this.settleConflict(room, refusal.path, state, pull)
        continue
      }
      room.retract.delete(refusal.path)
      room.refused.set(refusal.path, { state, why: refusal.why, pull })
    }
    if (changed) this.persist(room)
  }

  /** A conflict home decided on: its staged bytes kept for the pull home makes of them, or let go. */
  private settleConflict(room: Room, at: string, state: string | null, pull: boolean): void {
    const conflict = room.conflicts.get(at)
    if (!conflict || conflict.sha !== state) return
    room.conflicts.delete(at)
    if (!conflict.staged) return
    if (pull) this.keep(room, at, conflict.sha, conflict.bytes, conflict.staged)
    else fs.rmSync(conflict.staged, { force: true })
  }

  /* --------------------------------------------------------------- pulls */

  /** A file home wants (§8.3): sent once, the version the report named (or the file as it is, «Привезти»), unless it is on its way already. */
  private pull(room: Room, gen: number, entry: { path: string; sha256?: string }): void {
    const key = `${room.sessionId}\u0000${entry.path}`
    const sha = entry.sha256 ?? null
    const known = this.uploads.get(key)
    const now = this.now()
    // Home still asks: what it asks for is not said again meanwhile, and a version kept for it is kept on.
    const flight = room.inflight.get(entry.path)
    if (flight && flight.state === sha) flight.at = now
    const kept = room.kept.get(entry.path)
    if (kept && kept.sha === sha) kept.until = now + this.timings.verdictMs
    if (known && known.sha === sha && (known.doneAt === null || now - known.doneAt < this.timings.verdictMs)) return
    known?.abort.abort()
    this.uploads.set(key, { room, gen, path: entry.path, sha, tries: 0, notBefore: 0, task: null, doneAt: null, abort: new AbortController() })
  }

  /** The uploads due, REMOTE_CLASS_UPLOADS at once (home keeps as many slots for a machine's classes). */
  private pump(): void {
    const now = this.now()
    let running = [...this.uploads.values()].filter((upload) => upload.task !== null).length
    for (const upload of this.uploads.values()) {
      if (running >= REMOTE_CLASS_UPLOADS) break
      if (upload.task !== null || upload.doneAt !== null || upload.notBefore > now) continue
      running++
      upload.task = this.send(upload)
        .catch((error: unknown) => {
          this.options.log(`[runner] class ${upload.room.sessionId}: ${upload.path} did not go home: ${error instanceof Error ? error.message : String(error)}`)
          upload.doneAt = this.now()
        })
        .finally(() => {
          upload.task = null
          void this.tick()
        })
    }
    // What was sent and answered long enough ago is forgotten: home asks again for what it still wants.
    for (const [key, upload] of this.uploads) if (upload.doneAt !== null && now - upload.doneAt >= this.timings.verdictMs) this.uploads.delete(key)
  }

  /**
   * One pull: the file copied to the agent's own staging through a
   * descriptor that follows no link, hashed as it is copied — the version
   * home asked for, or none — then PUT gzipped at the class's rate. A version
   * home has seen and a push replaced here comes from where it was kept. A
   * stall of uploadStallMs gives it up; a transient answer tries again, a
   * refusal is home's word.
   */
  private async send(upload: Upload): Promise<void> {
    const { room } = upload
    const signal = AbortSignal.any([upload.abort.signal, room.abort.signal])
    const done = (): void => {
      upload.doneAt = this.now()
    }
    let staged: string | null = null
    let own = false
    let body: { stream: ReadableStream<Uint8Array>; close: () => void } | null = null
    try {
      let sha: string
      let bytes: number
      // A version kept aside goes when home names it; «Привезти» (none named) is the file as it is now.
      const kept = room.kept.get(upload.path)
      const conflict = room.conflicts.get(upload.path)
      let from: Kept | null = null
      if (kept && upload.sha === kept.sha) {
        from = kept
        staged = kept.file
        sha = kept.sha
        bytes = kept.bytes
      } else if (conflict?.staged && upload.sha === conflict.sha) {
        staged = conflict.staged
        sha = conflict.sha
        bytes = conflict.bytes
      } else {
        const afs = this.fsOf(room)
        const stat = afs ? lstatOf(afs, this.abs(room, upload.path)) : null
        if (!afs || !stat?.isFile()) {
          this.lost(room, upload)
          return done()
        }
        // The version a report named is within «Файл с машины — до»; «Привезти» within the room's limit: nothing past either is copied.
        const cap = upload.sha === null ? this.caps.roomMb * MIB : this.fileCap()
        if (statBytes(stat) > cap) {
          this.options.log(`[runner] class ${room.sessionId}: ${upload.path} is ${statBytes(stat)} bytes, over its cap: not sent`)
          return done()
        }
        const booked = this.book.known(stat)
        if (upload.sha !== null && booked !== null && booked !== upload.sha) {
          this.lost(room, upload)
          return done()
        }
        staged = this.stagingFile(room)
        own = true
        const copy = await hashAt(afs, this.abs(room, upload.path), stat, staged, signal)
        if (signal.aborted) return done()
        if (!copy) return this.later(upload, 'it moved while it was read')
        if (upload.sha !== null && copy.sha !== upload.sha) {
          this.lost(room, upload)
          return done()
        }
        sha = copy.sha
        bytes = copy.bytes
        this.book.noteStat(copy.stat, copy.sha)
      }
      if (signal.aborted) return done()
      // «Привезти»: the version this PUT sends is what home's acceptance agrees on. Written down before it goes, since the reply
      // carrying the verdict may come before the PUT's own answer.
      if (upload.sha === null) room.fetched.set(upload.path, { sha, bytes })
      const stall = new AbortController()
      let timer = setTimeout(() => stall.abort(), this.timings.uploadStallMs)
      timer.unref?.()
      const moved = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => stall.abort(), this.timings.uploadStallMs)
        timer.unref?.()
      }
      let answer: RoomUploadAnswer
      try {
        const cut = AbortSignal.any([signal, stall.signal])
        body = this.pacedGzip(staged, cut, moved)
        answer = await this.options.upload({ sessionId: room.sessionId, gen: upload.gen, path: upload.path, sha256: sha, bytes, body: body.stream, signal: cut })
      } finally {
        clearTimeout(timer)
      }
      if (signal.aborted) return done()
      if (answer.kind === 'ok') {
        const flight = room.inflight.get(upload.path)
        if (flight && flight.state === sha) flight.at = this.now()
        if (from) this.dropKept(room, upload.path, from)
        done()
        // Home has it, and answers the held sync with its verdict as it queues it. Cutting that sync short here would race the
        // reply on its way, and a verdict is said once: the change would wait a minute to be said again, a «Привезти» for good.
        this.options.onChange(false)
        return
      }
      if (answer.kind === 'refused') {
        if (answer.error === 'unauthorized') this.options.onUnauthorized?.()
        else if (from) this.dropKept(room, upload.path, from)
        if (upload.sha === null) room.fetched.delete(upload.path)
        this.options.log(`[runner] class ${room.sessionId}: home refused ${upload.path} (${answer.error}${answer.detail ? `: ${answer.detail}` : ''})`)
        return done()
      }
      return this.later(upload, stall.signal.aborted ? `no byte moved for ${Math.round(this.timings.uploadStallMs / 1000)} s` : answer.reason, answer.retryAfterMs)
    } finally {
      // The body's file goes with it, whatever the fetch made of the stream: a cut upload holds no descriptor of a staged copy.
      body?.close()
      if (own && staged) fs.rmSync(staged, { force: true })
    }
  }

  /**
   * The version home asked for is no longer here (rewritten, or gone): its
   * change is waited on no more, and what is there now is said instead — a
   * newer version as a change, which home takes in its pull's place, and a
   * file gone that both sides never agreed on as removed with the version
   * said, which home lets its pull go for (§8.3). Home would otherwise ask
   * for a version that never comes, every reply, and wait on it for good.
   */
  private lost(room: Room, upload: Upload): void {
    if (upload.sha === null) return
    const flight = room.inflight.get(upload.path)
    if (flight?.state === upload.sha) room.inflight.delete(upload.path)
    // Nor does the change found of it stand while the file waits out its quiet time: it is not that version any more.
    const change = room.changes.get(upload.path)
    if (change && stateOf(change) === upload.sha) room.changes.delete(upload.path)
    const afs = this.fsOf(room)
    const stat = afs ? lstatOf(afs, this.abs(room, upload.path)) : null
    if (!stat?.isFile() && !room.base.files.has(upload.path)) room.retract.set(upload.path, upload.sha)
    // The class's own scan, due now: what is there is said once it is quiet.
    room.scannedAt = 0
    this.options.log(`[runner] class ${room.sessionId}: ${upload.path} is not the version home asked for any more; what is there now is said instead`)
  }

  /** A pull tried again later, a few times through hiccups, then left for home to ask again. */
  private later(upload: Upload, why: string, retryAfterMs: number | null = null): void {
    upload.tries++
    if (upload.tries >= UPLOAD_TRIES) {
      this.options.log(`[runner] class ${upload.room.sessionId}: ${upload.path} did not go home (${why}); sent again when home asks`)
      upload.doneAt = this.now()
      return
    }
    const wait = new Backoff(this.options.random ?? Math.random, this.timings.retryMs.first, this.timings.retryMs.last)
    for (let i = 1; i < upload.tries; i++) wait.next()
    upload.notBefore = this.now() + wait.next(retryAfterMs)
  }

  /**
   * A staged file gzipped and paced at the class's rate, through a bucket of
   * CLASS_PACE_BURST_BYTES: the body of its PUT. Its file and its gzip are
   * let go as soon as `signal` gives up or `close` is called, whatever the
   * fetch made of the stream (an errored stream is never cancelled).
   */
  private pacedGzip(file: string, signal: AbortSignal, moved: () => void): { stream: ReadableStream<Uint8Array>; close: () => void } {
    const source = fs.createReadStream(file, { highWaterMark: 64 * 1024 })
    const gzip = source.pipe(createGzip())
    // pipe() passes no error on: a staged copy that cannot be read ends the body, not a wait for the stall.
    source.once('error', (error) => gzip.destroy(error))
    const release = (): void => {
      source.destroy()
      gzip.destroy()
    }
    signal.addEventListener('abort', release, { once: true })
    const close = (): void => {
      signal.removeEventListener('abort', release)
      release()
    }
    const iterator = gzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled')
          const next = await iterator.next()
          if (next.done) {
            controller.close()
            return
          }
          const delay = this.upPacer.delay(next.value.length, this.rates.classBulkMBps * MIB)
          if (delay > 0) await this.sleep(delay, signal)
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled')
          moved()
          controller.enqueue(new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength))
        } catch (error) {
          close()
          controller.error(error)
        }
      },
      cancel: close,
    })
    return { stream, close }
  }

  /* --------------------------------------------------------------- fences */

  /**
   * A copy home names nowhere here (§8.8): nothing more of it moves, and it
   * waits for the containers of its gens to go. Its own work begins anew
   * (the late list's read) on a signal of its own.
   */
  private fence(room: Room): void {
    room.fence = { at: this.now(), gens: { ...room.base.gens }, late: null, said: false, clear: false, carried: null, nextAt: 0 }
    room.abort.abort()
    room.abort = new AbortController()
    for (const [key, upload] of this.uploads) {
      if (upload.room !== room) continue
      upload.abort.abort()
      this.uploads.delete(key)
    }
    room.queue = []
    room.applying = null
    room.full = null
    this.options.log(`[runner] class ${room.sessionId}: home no longer names it here; what changed in its copy since home last agreed is said, then the copy goes`)
  }

  /** A fenced copy named here again before it went: it serves again, its files as they are, whatever home's copy turns out to be (reconcile, lag). */
  private lift(room: Room): void {
    room.fence = null
    this.options.log(`[runner] class ${room.sessionId}: home names it here again; its copy stays`)
  }

  /** A fenced copy, one step on: once its gens' containers are gone (or have had fenceWaitMs), its late list read, for the next sync. */
  private async advanceFence(room: Room): Promise<void> {
    const fence = room.fence!
    fence.nextAt = this.now() + FENCE_LOOK_MS
    const held = this.options.held(room.sessionId).some(({ role, gen }) => fence.gens[role] === gen)
    if (held && this.now() - fence.at < this.timings.fenceWaitMs) return
    const late = await this.lateList(room)
    if (this.rooms.get(room.sessionId) !== room || room.fence !== fence) return
    if (late.length > 0 && genOf(fence.gens) === null) {
      // A copy with no gen written down (no baseline to read): home agreed nothing with it, and there is no gen to say it under.
      this.options.log(`[runner] class ${room.sessionId}: ${late.length} path(s) of a copy home never agreed on go with it: ${late.slice(0, 5).join(', ')}${late.length > 5 ? ', …' : ''}`)
      fence.late = []
    } else fence.late = late
    if (fence.late.length > 0) this.options.log(`[runner] class ${room.sessionId}: ${fence.late.length} path(s) changed here after home moved the class: ${fence.late.slice(0, 5).join(', ')}${fence.late.length > 5 ? ', …' : ''}`)
    // The next sync says it, or says no container of the class is left: the copy goes once home's answer names the class nowhere.
    this.options.onChange(true)
  }

  /** The paths of the copy that are not what both sides agreed (§8.8): at most CLASS_LATE_MAX, in order; nothing past the cap read to tell. */
  private async lateList(room: Room): Promise<string[]> {
    const afs = this.fsOf(room)
    if (!afs) return []
    const signal = room.abort.signal
    const walk = await walkCopy(afs, room.dir, room.base.files, CLASS_SYNC_FILES_MAX, room.records, false)
    const late: string[] = []
    for (const [at, stat] of walk.files) {
      if (late.length >= CLASS_LATE_MAX || signal.aborted) break
      const agreed = room.base.files.get(at)
      if (!agreed || agreed.base === REMOTE_DIR_BASE || statBytes(stat) !== agreed.bytes) {
        late.push(at)
        continue
      }
      const sha = this.book.known(stat) ?? (statBytes(stat) <= this.fileCap() ? (await hashAt(afs, path.join(room.dir, at), stat, undefined, signal))?.sha ?? null : null)
      if (sha !== agreed.base) late.push(at)
    }
    for (const [at, agreed] of room.base.files) {
      if (late.length >= CLASS_LATE_MAX) break
      if (walk.files.has(at) || (agreed.base === REMOTE_DIR_BASE && walk.dirs.has(at)) || walk.packages.has(at)) continue
      if (gone(walk, at)) late.push(at)
    }
    return late.sort().slice(0, CLASS_LATE_MAX)
  }

  /** The fenced copy gone, through the anchored filesystem (no link a kernel left is followed), with its baseline and staging. */
  private wipe(room: Room): void {
    room.abort.abort()
    const afs = this.fsOf(room)
    let names: string[] = []
    try {
      names = afs ? (afs.readdirSync(room.dir) as string[]) : []
    } catch { /* gone already */ }
    for (const name of names) {
      // One entry that will not go is no reason to keep the others.
      try {
        afs!.rmSync(path.join(room.dir, name), { recursive: true, force: true })
      } catch (error) {
        this.options.log(`[runner] class ${room.sessionId}: ${name} of its old copy would not go (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    this.close(room)
    try {
      fs.rmdirSync(room.dir)
    } catch { /* not empty: an entry would not go; the next wipe or the removal of everything tries again */ }
    fs.rmSync(roomBaselineFile(this.layout, room.sessionId), { force: true })
    fs.rmSync(roomStaging(this.layout, room.sessionId), { recursive: true, force: true })
    this.rooms.delete(room.sessionId)
    this.options.log(`[runner] class ${room.sessionId}: the copy of its old placements is removed`)
  }
}

/* ---------------------------------------------------------------- helpers */

/** Whether a path agreed on is no longer in the copy: the nearest folder above it that is there was listed whole, and it was not in it. */
function gone(walk: Walk, at: string): boolean {
  let dir = parentOf(at)
  while (dir !== '' && !walk.dirs.has(dir)) dir = parentOf(dir)
  return walk.listed.has(dir)
}

/** Every key at or under `from`, moved under `to`. */
function rekey<T>(map: Map<string, T>, from: string, to: string): void {
  const moved: Array<[string, T]> = []
  for (const [key, value] of map) {
    if (!isInside(key, from)) continue
    moved.push([`${to}${key.slice(from.length)}`, value])
    map.delete(key)
  }
  for (const [key, value] of moved) map.set(key, value)
}

/** A push by its whole content. */
const digestOf = (push: RemoteFilesPush): string => createHash('sha256').update(JSON.stringify(push)).digest('hex')

/** A reply's body as text, read this far at most (and the rest let go). */
async function cappedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Whether a push does anything at, above or under a path. */
function touches(push: RemoteFilesPush, at: string): boolean {
  const near = (other: string): boolean => isInside(other, at) || isInside(at, other)
  return push.full || push.put.some((put) => near(put.path)) || push.remove.some(near) || push.move.some((move) => near(move.from) || near(move.to))
}
