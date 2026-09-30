/**
 * Consistent copies of colloq.db inside the data volume.
 *
 * In a customer's Kubernetes the backup is a snapshot of the volume (Velero,
 * CSI), taken whenever the platform's schedule says, in the middle of a class
 * as likely as at night. A volume snapshot of a live SQLite database in WAL
 * mode is a crash image: the database file says yesterday, the journal next
 * to it holds today, and whether the two were caught at one instant depends
 * on the storage. Restoring such a copy usually works, which is exactly the
 * kind of backup nobody should have to rely on. So the server itself writes a
 * finished, consistent file into `<DATA_DIR>/snapshots/` every
 * DB_SNAPSHOT_HOURS, and whatever copies the volume copies those too.
 *
 * And one more, always: right before a migration raises the data schema
 * (data-schema.ts). An upgrade through GitOps is a new image tag in a
 * repository; nobody runs `colloq-host backup` first, and a Helm upgrade
 * without a backup hook would otherwise have no way back to the release
 * before it.
 *
 * Files are 0600 in a 0700 directory, like the database itself: they hold
 * the teachers' sign-in keys and the model key. A copy is written under a
 * temporary name and renamed when it is whole, so every `colloq-*.db` in the
 * folder is a complete database; a process killed halfway leaves a
 * `.partial`, swept away before the next snapshot.
 *
 * No imports from db.ts: db.ts calls into this module while it is still
 * opening the database, so the handle comes as an argument.
 */
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { logWith } from './log-fields.js'

export const SNAPSHOT_DIR = 'snapshots'
const DEFAULT_KEEP = 7
/** Anything shorter is a snapshot loop, not a schedule. */
const MIN_EVERY_MS = 60_000
/**
 * The first periodic snapshot waits this long after the start: the start of
 * a server is when a class that was waiting for it reconnects all at once.
 */
const FIRST_DELAY_MS = 60_000
/**
 * Pages copied per step of the backup, a megabyte with SQLite's default page.
 *
 * The backup API copies in steps and better-sqlite3 hands the event loop
 * back between them, so a large database is copied without stopping the
 * class: every step is a millisecond or so, and every socket gets its turn in
 * between. `VACUUM INTO`, used by `make backup`, holds the loop for the whole
 * copy, which in a separate process is fine and in this one is seconds of a
 * frozen room.
 */
const PAGES_PER_STEP = 256
/** setTimeout cannot wait longer than this; a longer interval is waited in pieces. */
const MAX_TIMER_MS = 2 ** 31 - 1

const STAMP = String.raw`\d{8}T\d{6}Z`
const PERIODIC = new RegExp(`^colloq-(${STAMP})\\.db$`)
const PRE_SCHEMA = new RegExp(`^pre-schema-(\\d+)-to-(\\d+)-(${STAMP})\\.db$`)
const PARTIAL = new RegExp(`^(?:colloq|pre-schema-\\d+-to-\\d+)-${STAMP}\\.db\\.partial(?:-journal|-wal|-shm)?$`)

export interface SnapshotSettings {
  /** 0 means periodic snapshots are off (DB_SNAPSHOT_HOURS unset or 0). */
  everyMs: number
  keep: number
  /** Values that could not be used, in words for the log. */
  problems: string[]
}

/**
 * DB_SNAPSHOT_HOURS and DB_SNAPSHOT_KEEP.
 *
 * Off unless asked for: the teacher's laptop and the single VM have their own
 * backups (`colloq backup`, `colloq-host backup`), and a copy of the database
 * every day inside the same folder is disk they did not ask to spend. The
 * Helm chart turns it on.
 *
 * A value that cannot be read is said out loud and replaced by the safe
 * reading, never guessed at: "24h" for hours is a typo worth a line in the
 * log, not a crash of the class, and not a snapshot every 24 milliseconds.
 */
export function snapshotSettings(env: NodeJS.ProcessEnv = process.env): SnapshotSettings {
  const problems: string[] = []
  let everyMs = 0
  const hours = env.DB_SNAPSHOT_HOURS?.trim()
  if (hours) {
    const value = Number(hours)
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`DB_SNAPSHOT_HOURS=${hours} is not a number of hours; periodic database snapshots stay off`)
    } else if (value > 0) {
      everyMs = Math.round(value * 3_600_000)
      if (everyMs < MIN_EVERY_MS) {
        problems.push(`DB_SNAPSHOT_HOURS=${hours} is under a minute; taking a snapshot every minute instead`)
        everyMs = MIN_EVERY_MS
      }
    }
  }
  let keep = DEFAULT_KEEP
  const kept = env.DB_SNAPSHOT_KEEP?.trim()
  if (kept) {
    const value = Number(kept)
    if (!Number.isInteger(value) || value < 1) {
      problems.push(`DB_SNAPSHOT_KEEP=${kept} is not a whole number from 1; keeping ${DEFAULT_KEEP}`)
    } else {
      keep = value
    }
  }
  return { everyMs, keep, problems }
}

/** 20260930T101500Z: UTC, sorts as text, and the same shape as the backup archives' names. */
export function snapshotStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function stampTime(stamp: string): number {
  const [, y, mo, d, h, mi, s] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)!
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
}

/** The folder, created 0700 and brought back to 0700: the same rule as config.ensureDataDir. */
export function snapshotDirectory(dataDir: string): string {
  const dir = path.join(dataDir, SNAPSHOT_DIR)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* not our folder: the files inside are 0600 anyway */
  }
  return dir
}

export interface SnapshotFile {
  name: string
  kind: 'periodic' | 'pre-schema'
  /** When it was taken, by the stamp in its name (ms). A copy made with `cp` keeps its name, not its mtime. */
  at: number
  bytes: number
}

/** The snapshots on disk, newest first. Temporary and foreign files are not snapshots. */
export function listSnapshots(dataDir: string): SnapshotFile[] {
  const dir = path.join(dataDir, SNAPSHOT_DIR)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const found: SnapshotFile[] = []
  for (const name of names) {
    const periodic = PERIODIC.exec(name)
    const stamp = periodic?.[1] ?? PRE_SCHEMA.exec(name)?.[3]
    if (!stamp) continue
    try {
      const info = fs.statSync(path.join(dir, name))
      if (!info.isFile()) continue
      found.push({ name, kind: periodic ? 'periodic' : 'pre-schema', at: stampTime(stamp), bytes: info.size })
    } catch {
      /* removed between the listing and the stat */
    }
  }
  return found.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
}

/**
 * Keep the newest `keep` periodic snapshots and remove the rest.
 *
 * The snapshots taken before a schema raise are never removed here. Each is
 * the only way back from one particular upgrade, they come once a schema
 * version, and deleting one because a week of daily copies came after it
 * would be exactly backwards. They go when an operator removes them.
 *
 * A snapshot opened with the sqlite3 shell grows a -wal and -shm next to it
 * (the copy keeps the database's WAL mark); they leave with it.
 */
export function pruneSnapshots(dataDir: string, keep: number): string[] {
  const dir = path.join(dataDir, SNAPSHOT_DIR)
  const periodic = listSnapshots(dataDir).filter((file) => file.kind === 'periodic')
  const removed: string[] = []
  for (const old of periodic.slice(Math.max(1, keep))) {
    try {
      fs.rmSync(path.join(dir, old.name), { force: true })
    } catch {
      continue
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        fs.rmSync(path.join(dir, old.name + suffix), { force: true })
      } catch {
        /* a leftover beside a removed copy is untidy, not dangerous */
      }
    }
    removed.push(old.name)
  }
  return removed
}

/* ------------------------------------------------------------ one snapshot */

let inFlight: Promise<SnapshotOutcome> | null = null
/** Set by stop: the copy in progress gives up at its next step. */
let abandoning = false
let lastTaken: { name: string; at: number; bytes: number; durationMs: number } | null = null
let failures = 0
let lastFailureAt: number | null = null

class Abandoned extends Error {}

export type SnapshotOutcome =
  | { ok: true; name: string; bytes: number; durationMs: number; removed: string[] }
  | { ok: false; reason: 'busy' | 'stopped' | 'failed'; error?: string }

/**
 * Take one periodic snapshot: `snapshots/colloq-<stamp>.db`.
 *
 * Never two at once: a second call while one is running answers `busy` and
 * does nothing. A copy of the database is the one job here that can take
 * long enough to overlap with the next timer, and two copies of the same file
 * into the same folder only double the disk traffic of a busy class.
 *
 * Never throws. A snapshot that failed is a warning in the log and a counter
 * in /metrics: the database it failed to copy is still there and still
 * serving, and a crash would turn a missed copy into a missed class.
 */
export function takeSnapshot(
  db: Database.Database,
  dataDir: string,
  options: { keep: number; now?: () => Date; pagesPerStep?: number },
): Promise<SnapshotOutcome> {
  if (inFlight) return Promise.resolve({ ok: false, reason: 'busy' })
  const run = snapshotOnce(db, dataDir, options).finally(() => {
    inFlight = null
  })
  inFlight = run
  return run
}

async function snapshotOnce(
  db: Database.Database,
  dataDir: string,
  { keep, now = () => new Date(), pagesPerStep = PAGES_PER_STEP }: { keep: number; now?: () => Date; pagesPerStep?: number },
): Promise<SnapshotOutcome> {
  const started = performance.now()
  const at = now()
  const name = `colloq-${snapshotStamp(at)}.db`
  let partial: string | null = null
  try {
    const dir = snapshotDirectory(dataDir)
    // Only one snapshot runs at a time, so a .partial found now belongs to a
    // process that died mid-copy.
    sweepPartials(dir)
    const final = path.join(dir, name)
    if (fs.existsSync(final)) throw new Error(`${name} already exists`)
    partial = `${final}.partial`
    createPrivate(partial)
    await db.backup(partial, {
      progress: () => {
        if (abandoning) throw new Abandoned()
        return pagesPerStep
      },
    })
    fs.chmodSync(partial, 0o600)
    fs.renameSync(partial, final)
    partial = null
    syncDirectory(dir)
    const bytes = fs.statSync(final).size
    const durationMs = performance.now() - started
    const removed = pruneSnapshots(dataDir, keep)
    tightenSnapshots(dir)
    lastTaken = { name, at: at.getTime(), bytes, durationMs }
    logWith(
      'log',
      { snapshot: name, bytes, durationMs: Math.round(durationMs), removed: removed.length },
      `[db] snapshot ${name}: ${sizeText(bytes)} in ${durationText(durationMs)}` +
        (removed.length > 0 ? ` · removed ${removed.length} older, keeping ${keep}` : ''),
    )
    return { ok: true, name, bytes, durationMs, removed }
  } catch (err) {
    if (partial) removePartial(partial)
    if (err instanceof Abandoned) {
      console.log(`[db] snapshot ${name} abandoned: the server is stopping`)
      return { ok: false, reason: 'stopped' }
    }
    failures += 1
    lastFailureAt = Date.now()
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[db] WARNING: snapshot ${name} failed: ${message}. The database itself is untouched; the next attempt comes at the next interval.`)
    return { ok: false, reason: 'failed', error: message }
  }
}

/* ------------------------------------------------- before a schema raise */

/**
 * The copy taken before a migration raises the data schema, synchronously.
 *
 * Called by db.ts at the one moment it raises the stamp, before any
 * migration has touched the file (db.ts · stampDataSchema). Synchronous
 * because the migrations are: they run as modules load, and the backup API
 * answers with a promise nobody there could wait for. `VACUUM INTO` gives the
 * same consistent file in one call, and holding the event loop costs nothing
 * yet: the server is not listening.
 *
 * A database from before the stamp existed carries 0, which reads as 1
 * (data-schema.ts): opening it with this release raises the number but not
 * the schema, and a copy of it would be a full database of disk for nothing.
 * A new, empty file has nothing to go back to either.
 *
 * A failure is a warning, not a refusal to start, the same as for the
 * periodic snapshots. The likeliest cause is a full disk, which the operator
 * learns about from this line, and a server that will not start is a class
 * that does not happen. The way back is then the backup taken before the
 * update, as it was before this copy existed.
 */
export function snapshotBeforeSchemaRaise(
  db: Database.Database,
  dataDir: string,
  found: number,
  target: number,
  at: Date = new Date(),
): SnapshotFile | null {
  const from = found === 0 ? 1 : found
  if (from >= target) return null
  const tables = (db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number }).n
  if (tables === 0) return null
  const started = performance.now()
  const name = `pre-schema-${from}-to-${target}-${snapshotStamp(at)}.db`
  let partial: string | null = null
  try {
    const dir = snapshotDirectory(dataDir)
    // A start killed mid-copy (a liveness probe that ran out of patience with
    // a large database) leaves a partial, and the stamp still unraised: this
    // start copies again, and nothing else may ever come to sweep it, since
    // periodic snapshots are off by default.
    sweepPartials(dir)
    const final = path.join(dir, name)
    if (fs.existsSync(final)) throw new Error(`${name} already exists`)
    partial = `${final}.partial`
    createPrivate(partial)
    // An existing EMPTY file is what VACUUM INTO accepts besides no file, and
    // an empty file created 0600 is how the copy is never readable by others.
    db.exec(`VACUUM INTO ${sqlString(partial)}`)
    fs.chmodSync(partial, 0o600)
    fs.renameSync(partial, final)
    partial = null
    syncDirectory(dir)
    const bytes = fs.statSync(final).size
    const durationMs = performance.now() - started
    lastTaken = { name, at: at.getTime(), bytes, durationMs }
    logWith(
      'log',
      { snapshot: name, bytes, durationMs: Math.round(durationMs), fromSchema: from, toSchema: target },
      `[db] snapshot before raising the data schema ${from} → ${target}: ${name}, ${sizeText(bytes)} in ${durationText(durationMs)}`,
    )
    return { name, kind: 'pre-schema', at: at.getTime(), bytes }
  } catch (err) {
    if (partial) removePartial(partial)
    failures += 1
    lastFailureAt = Date.now()
    const message = err instanceof Error ? err.message : String(err)
    console.warn(
      `[db] WARNING: could not take the snapshot before raising the data schema ${from} → ${target}: ${message}. ` +
        'The update goes on; the way back is a backup taken before it.',
    )
    return null
  }
}

/* ----------------------------------------------------------------- schedule */

interface Schedule {
  db: Database.Database
  dataDir: string
  everyMs: number
  keep: number
  nextAt: number
  now?: () => Date
}

let schedule: Schedule | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Turn the periodic snapshots on; `index.ts` calls it once the server is up.
 *
 * The next one is counted from the newest snapshot on disk, not from this
 * start. A deployment restarts the app for every settings change, a node
 * drain, a new release; an interval counted from each start would, on a busy
 * week, never come round at all. A snapshot already overdue waits only the
 * minute a start needs to settle.
 *
 * Returns when the next snapshot is due, or null when they are off.
 */
export function startDatabaseSnapshots(
  db: Database.Database,
  dataDir: string,
  settings: SnapshotSettings = snapshotSettings(),
  options: { firstDelayMs?: number; now?: () => Date } = {},
): number | null {
  for (const problem of settings.problems) console.warn(`[db] ${problem}`)
  clearTimer()
  schedule = null
  if (settings.everyMs <= 0) return null
  const newest = listSnapshots(dataDir)[0]
  const earliest = Date.now() + (options.firstDelayMs ?? FIRST_DELAY_MS)
  const nextAt = Math.max(earliest, newest ? newest.at + settings.everyMs : earliest)
  schedule = { db, dataDir, everyMs: settings.everyMs, keep: settings.keep, nextAt, now: options.now }
  abandoning = false
  arm()
  console.log(
    `[db] snapshots of colloq.db every ${durationText(settings.everyMs)} into ${path.join(dataDir, SNAPSHOT_DIR)}, ` +
      `keeping ${settings.keep}; the next at ${new Date(nextAt).toISOString()}`,
  )
  return nextAt
}

function arm(): void {
  if (!schedule) return
  const wait = Math.min(MAX_TIMER_MS, Math.max(0, schedule.nextAt - Date.now()))
  timer = setTimeout(() => void tick(), wait)
  // A snapshot is no reason to keep the process alive: tests and `make
  // backup` start the server for seconds.
  timer.unref?.()
}

async function tick(): Promise<void> {
  timer = null
  const plan = schedule
  if (!plan) return
  if (Date.now() < plan.nextAt) return arm()
  await takeSnapshot(plan.db, plan.dataDir, { keep: plan.keep, now: plan.now })
  // Stopped, or started anew, while this one was copying.
  if (schedule !== plan) return
  plan.nextAt = Date.now() + plan.everyMs
  arm()
}

function clearTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/**
 * Stop the schedule, at shutdown, before the database is closed.
 *
 * A copy in progress is abandoned rather than waited for: it gives up at its
 * next step, a millisecond away, and removes its partial file. Waiting for a
 * large database to finish copying would spend the shutdown grace the room
 * snapshots need, and closing the database under a running backup would
 * leave the partial file for the next start to sweep.
 */
export async function stopDatabaseSnapshots(): Promise<void> {
  schedule = null
  clearTimer()
  const running = inFlight
  if (!running) return
  abandoning = true
  try {
    await running
  } finally {
    abandoning = false
  }
}

/**
 * What /api/instance/operations and /metrics say about the snapshots.
 *
 * Read from the folder, not remembered: after a restart the newest copy is
 * still the newest copy, and an alert on "no snapshot for two days" must not
 * reset every time the pod does. No paths: only file names, which say when
 * and which kind.
 */
export function databaseSnapshotStatus(dataDir: string) {
  const settings = snapshotSettings()
  const files = listSnapshots(dataDir)
  const newest = files[0] ?? null
  return {
    everyHours: settings.everyMs / 3_600_000,
    keep: settings.keep,
    running: inFlight !== null,
    nextAt: schedule?.nextAt ?? null,
    count: files.length,
    last: newest ? { name: newest.name, kind: newest.kind, at: newest.at, bytes: newest.bytes } : null,
    lastDurationMs: lastTaken ? Math.round(lastTaken.durationMs) : null,
    failures,
    lastFailureAt,
  }
}

/* ------------------------------------------------------------------- files */

/** Created empty and 0600 before anything is written into it: never a moment when it is readable. */
function createPrivate(file: string): void {
  fs.closeSync(fs.openSync(file, 'wx', 0o600))
}

function removePartial(partial: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.rmSync(partial + suffix, { force: true })
    } catch {
      /* swept before the next snapshot */
    }
  }
}

/**
 * Every kept snapshot back to 0600, as db.ts does with the database files at
 * each start. A Kubernetes volume mounted with an fsGroup gets group read and
 * write added to every file on it, at every mount; a copy written 0600 a week
 * ago is 0660 after the next pod restart unless something puts it back.
 */
function tightenSnapshots(dir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    // The snapshot just written stands; a failure here must not report it failed.
    return
  }
  for (const name of names) {
    if (!PERIODIC.test(name) && !PRE_SCHEMA.test(name)) continue
    try {
      fs.chmodSync(path.join(dir, name), 0o600)
    } catch {
      /* not ours to change; it stays as it is */
    }
  }
}

function sweepPartials(dir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!PARTIAL.test(name)) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* tried again next time */
    }
  }
}

/**
 * The rename is durable only once the directory is written out: a power cut
 * right after it could otherwise bring back the folder without the new name.
 */
function syncDirectory(dir: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    /* not every filesystem syncs a directory; the rename has happened either way */
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** SQLite takes no parameter in VACUUM INTO, so the path is quoted by hand (as db.ts · backupTo does). */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 2 * 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${Number((ms / 3_600_000).toFixed(2))} h`
}
