/**
 * Database snapshots: consistent copies of colloq.db in <DATA_DIR>/snapshots.
 *
 * In a customer's Kubernetes the backup is a volume snapshot taken whenever
 * the platform decides, and a volume snapshot of a live WAL database is a
 * crash image. So the server writes finished copies into the volume itself:
 * every DB_SNAPSHOT_HOURS (keeping DB_SNAPSHOT_KEEP), and always right before
 * a migration raises the data schema, the way back from an upgrade nobody
 * took a backup for.
 *
 * What is checked is what a restore depends on: the copy is whole and
 * consistent even while the class writes, it is readable only by the server,
 * a half-written copy never carries a final name, the schedule survives
 * restarts, retention never eats the pre-upgrade copy, and a failure never
 * takes the class down.
 */
import './_env.mts'
import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import {
  databaseSnapshotStatus,
  listSnapshots,
  pruneSnapshots,
  snapshotBeforeSchemaRaise,
  snapshotSettings,
  snapshotStamp,
  startDatabaseSnapshots,
  stopDatabaseSnapshots,
  takeSnapshot,
} from '../server/src/db-snapshots.ts'
import { ALLOW_SCHEMA_DOWNGRADE, DATA_SCHEMA_VERSION } from '../server/src/data-schema.ts'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dirs: string[] = []
const handles: Database.Database[] = []

after(() => {
  for (const handle of handles) {
    try {
      handle.close()
    } catch {
      /* already closed by the test */
    }
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => stopDatabaseSnapshots())

function scratch(prefix = 'colloq-snapshots-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A data directory with a WAL database holding `rows` notes, stamped with schema 1. */
function instance(rows = 50): { dataDir: string; db: Database.Database } {
  const dataDir = scratch()
  const db = new Database(path.join(dataDir, 'colloq.db'))
  handles.push(db)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO notes (body) VALUES (?)')
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`note ${i} ${'x'.repeat(200)}`)
  })()
  db.pragma('user_version = 1')
  return { dataDir, db }
}

const mode = (file: string) => fs.statSync(file).mode & 0o777

/**
 * What a restore would find in a copy. Read from a scratch copy of the copy:
 * opening a snapshot in place would grow -wal and -shm beside it and change
 * the folder under test.
 */
function inspect(file: string, { inPlace = false } = {}): { rows: number; version: number; integrity: string; tables: string[] } {
  let probe = file
  if (!inPlace) {
    probe = path.join(scratch('colloq-snapshot-probe-'), 'probe.db')
    fs.copyFileSync(file, probe)
  }
  const copy = new Database(probe)
  try {
    const tables = (copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name)
    const rows = tables.includes('notes')
      ? (copy.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n
      : (copy.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    return {
      rows,
      version: Number(copy.pragma('user_version', { simple: true })),
      integrity: String(copy.pragma('integrity_check', { simple: true })),
      tables,
    }
  } finally {
    copy.close()
  }
}

async function waitFor(condition: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function capture(method: 'log' | 'warn'): { lines: string[]; restore: () => void } {
  const original = console[method]
  const lines: string[] = []
  console[method] = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console[method] = original) }
}

/* --------------------------------------------------------------- settings */

test('DB_SNAPSHOT_HOURS and DB_SNAPSHOT_KEEP: off and seven by default; a value that cannot be read is named and read safely', () => {
  assert.deepEqual(snapshotSettings({}), { everyMs: 0, keep: 7, problems: [] })
  assert.equal(snapshotSettings({ DB_SNAPSHOT_HOURS: '24' }).everyMs, 86_400_000)
  assert.equal(snapshotSettings({ DB_SNAPSHOT_HOURS: ' 0.5 ' }).everyMs, 1_800_000)
  assert.deepEqual(snapshotSettings({ DB_SNAPSHOT_HOURS: '0' }), { everyMs: 0, keep: 7, problems: [] })
  for (const bad of ['24h', '-1', 'daily', 'Infinity']) {
    const read = snapshotSettings({ DB_SNAPSHOT_HOURS: bad })
    assert.equal(read.everyMs, 0, bad)
    assert.match(read.problems[0] ?? '', new RegExp(`DB_SNAPSHOT_HOURS=${bad}.*stay off`))
  }
  const tiny = snapshotSettings({ DB_SNAPSHOT_HOURS: '0.0001' })
  assert.equal(tiny.everyMs, 60_000, 'a snapshot loop is not a schedule')
  assert.equal(tiny.problems.length, 1)
  assert.equal(snapshotSettings({ DB_SNAPSHOT_KEEP: '3' }).keep, 3)
  for (const bad of ['0', '2.5', 'x', '-4']) {
    const read = snapshotSettings({ DB_SNAPSHOT_KEEP: bad })
    assert.equal(read.keep, 7, bad)
    assert.match(read.problems[0] ?? '', /DB_SNAPSHOT_KEEP/)
  }
})

test('the schedule stays off without DB_SNAPSHOT_HOURS, and says so when the value cannot be read', () => {
  const { dataDir, db } = instance()
  const warned = capture('warn')
  try {
    assert.equal(startDatabaseSnapshots(db, dataDir, snapshotSettings({})), null)
    assert.equal(startDatabaseSnapshots(db, dataDir, snapshotSettings({ DB_SNAPSHOT_HOURS: '24h' })), null)
  } finally {
    warned.restore()
  }
  assert.deepEqual(warned.lines, ['[db] DB_SNAPSHOT_HOURS=24h is not a number of hours; periodic database snapshots stay off'])
  assert.ok(!fs.existsSync(path.join(dataDir, 'snapshots')), 'an unasked-for folder')
})

test('the stamp is UTC to the second, the shape the backup archives use', () => {
  assert.equal(snapshotStamp(new Date('2026-09-30T10:15:00.987Z')), '20260930T101500Z')
})

/* ------------------------------------------------------------ one snapshot */

test('a snapshot is a complete, consistent copy: 0600 in a 0700 folder, named by when it was taken', async () => {
  const { dataDir, db } = instance()
  const logged = capture('log')
  let outcome
  try {
    outcome = await takeSnapshot(db, dataDir, { keep: 7 })
  } finally {
    logged.restore()
  }
  assert.ok(outcome.ok, JSON.stringify(outcome))
  assert.match(outcome.name, /^colloq-\d{8}T\d{6}Z\.db$/)
  const dir = path.join(dataDir, 'snapshots')
  const file = path.join(dir, outcome.name)
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(file), 0o600)
  assert.deepEqual(fs.readdirSync(dir), [outcome.name])
  assert.equal(outcome.bytes, fs.statSync(file).size)
  assert.deepEqual(inspect(file), { rows: 50, version: 1, integrity: 'ok', tables: ['notes'] })
  // Logged with its size and how long it took.
  assert.match(logged.lines.join('\n'), new RegExp(`\\[db\\] snapshot ${outcome.name.replace(/\./g, '\\.')}: \\d+ KB in \\d+ ms`))
})

test('while copying, only a .partial exists; a write made meanwhile lands in the copy, which stays consistent', async () => {
  const { dataDir, db } = instance(3000)
  const dir = path.join(dataDir, 'snapshots')
  const seen = new Set<string>()
  let copying = true
  let wrote = false
  const watch = () => {
    if (!copying) return
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) seen.add(name)
    if (!wrote && [...seen].some((name) => name.endsWith('.partial'))) {
      db.prepare('INSERT INTO notes (body) VALUES (?)').run('written while the copy was being made')
      wrote = true
    }
    setImmediate(watch)
  }
  setImmediate(watch)
  const logged = capture('log')
  let outcome
  try {
    // One page per step: the copy takes many turns of the event loop, and the
    // watcher gets one between each two of them.
    outcome = await takeSnapshot(db, dataDir, { keep: 7, pagesPerStep: 1 })
  } finally {
    copying = false
    logged.restore()
  }
  assert.ok(outcome.ok, JSON.stringify(outcome))
  // The copy and SQLite's rollback journal for it, both under the temporary name.
  assert.ok(seen.has(`${outcome.name}.partial`))
  for (const name of seen) assert.ok(name.startsWith(`${outcome.name}.partial`), `seen while copying: ${name}`)
  assert.ok(!seen.has(outcome.name), 'the final name appeared before the copy was whole')
  assert.ok(wrote, 'the watcher never saw the copy in progress')
  const copy = inspect(path.join(dir, outcome.name))
  assert.equal(copy.rows, 3001)
  assert.equal(copy.integrity, 'ok')
  assert.deepEqual(fs.readdirSync(dir), [outcome.name])
})

test('never two at once: a second snapshot while one copies answers busy and writes nothing', async () => {
  const { dataDir, db } = instance(3000)
  const logged = capture('log')
  try {
    const first = takeSnapshot(db, dataDir, { keep: 7, pagesPerStep: 1 })
    assert.equal(databaseSnapshotStatus(dataDir).running, true)
    const second = await takeSnapshot(db, dataDir, { keep: 7, now: () => new Date(Date.now() + 3_600_000) })
    assert.deepEqual(second, { ok: false, reason: 'busy' })
    assert.ok((await first).ok)
  } finally {
    logged.restore()
  }
  assert.equal(listSnapshots(dataDir).length, 1)
  assert.equal(databaseSnapshotStatus(dataDir).running, false)
})

test('retention keeps the newest DB_SNAPSHOT_KEEP periodic copies, and never touches a pre-upgrade copy or a foreign file', async () => {
  const { dataDir, db } = instance()
  const dir = path.join(dataDir, 'snapshots')
  fs.mkdirSync(dir, { mode: 0o700 })
  for (const day of ['01', '02', '03', '04']) fs.writeFileSync(path.join(dir, `colloq-202609${day}T000000Z.db`), 'old', { mode: 0o600 })
  // Opened once with the sqlite3 shell: its journal leaves with it.
  fs.writeFileSync(path.join(dir, 'colloq-20260901T000000Z.db-wal'), 'wal')
  fs.writeFileSync(path.join(dir, 'pre-schema-1-to-2-20260801T000000Z.db'), 'before an upgrade', { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'notes-by-the-operator.txt'), 'keep me')
  // What a volume mounted with an fsGroup does to every file at each mount.
  fs.chmodSync(path.join(dir, 'colloq-20260904T000000Z.db'), 0o660)
  fs.chmodSync(path.join(dir, 'pre-schema-1-to-2-20260801T000000Z.db'), 0o660)
  fs.chmodSync(path.join(dir, 'notes-by-the-operator.txt'), 0o644)
  // A copy cut short by a killed process.
  fs.writeFileSync(path.join(dir, 'colloq-20260905T000000Z.db.partial'), 'half')
  fs.writeFileSync(path.join(dir, 'colloq-20260905T000000Z.db.partial-journal'), 'half')

  const logged = capture('log')
  let outcome
  try {
    outcome = await takeSnapshot(db, dataDir, { keep: 3, now: () => new Date('2026-09-10T00:00:00Z') })
  } finally {
    logged.restore()
  }
  assert.ok(outcome.ok, JSON.stringify(outcome))
  assert.equal(outcome.name, 'colloq-20260910T000000Z.db')
  assert.deepEqual(outcome.removed.sort(), ['colloq-20260901T000000Z.db', 'colloq-20260902T000000Z.db'])
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'colloq-20260903T000000Z.db',
    'colloq-20260904T000000Z.db',
    'colloq-20260910T000000Z.db',
    'notes-by-the-operator.txt',
    'pre-schema-1-to-2-20260801T000000Z.db',
  ])
  assert.match(logged.lines.join('\n'), /removed 2 older, keeping 3/)
  // Every kept copy is back to 0600; a file that is not a snapshot is not ours to change.
  assert.equal(mode(path.join(dir, 'colloq-20260904T000000Z.db')), 0o600)
  assert.equal(mode(path.join(dir, 'pre-schema-1-to-2-20260801T000000Z.db')), 0o600)
  assert.equal(mode(path.join(dir, 'notes-by-the-operator.txt')), 0o644)

  assert.deepEqual(pruneSnapshots(dataDir, 1).sort(), ['colloq-20260903T000000Z.db', 'colloq-20260904T000000Z.db'])
  assert.deepEqual(
    listSnapshots(dataDir).map((file) => [file.name, file.kind]),
    [
      ['colloq-20260910T000000Z.db', 'periodic'],
      ['pre-schema-1-to-2-20260801T000000Z.db', 'pre-schema'],
    ],
  )
})

test('a snapshot that cannot be written is a warning and a counter, never a crash, and leaves nothing behind', async () => {
  const { dataDir, db } = instance()
  const before = databaseSnapshotStatus(dataDir).failures
  const warned = capture('warn')
  try {
    // A file where the folder should be.
    fs.writeFileSync(path.join(dataDir, 'snapshots'), 'not a folder')
    const blocked = await takeSnapshot(db, dataDir, { keep: 7 })
    assert.equal(blocked.ok, false)
    assert.equal(!blocked.ok && blocked.reason, 'failed')
    fs.rmSync(path.join(dataDir, 'snapshots'))

    // The copy itself fails (the database went away): the partial goes too.
    const gone = new Database(path.join(dataDir, 'gone.db'))
    gone.close()
    const failed = await takeSnapshot(gone, dataDir, { keep: 7 })
    assert.equal(failed.ok, false)
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'snapshots')), [], 'a partial was left behind')
  } finally {
    warned.restore()
  }
  assert.equal(warned.lines.length, 2)
  for (const line of warned.lines) assert.match(line, /^\[db\] WARNING: snapshot colloq-\d{8}T\d{6}Z\.db failed: .+ The database itself is untouched/)
  const status = databaseSnapshotStatus(dataDir)
  assert.equal(status.failures, before + 2)
  assert.ok(status.lastFailureAt !== null && Date.now() - status.lastFailureAt < 5000)
})

test('stopping abandons a copy in progress at its next step and removes its partial file', async () => {
  const { dataDir, db } = instance(3000)
  const logged = capture('log')
  let outcome
  try {
    const running = takeSnapshot(db, dataDir, { keep: 7, pagesPerStep: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    await stopDatabaseSnapshots()
    outcome = await running
  } finally {
    logged.restore()
  }
  assert.deepEqual(outcome, { ok: false, reason: 'stopped' })
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'snapshots')), [])
  assert.match(logged.lines.join('\n'), /abandoned: the server is stopping/)
})

/* ---------------------------------------------------------------- schedule */

test('the schedule takes one every interval, keeps DB_SNAPSHOT_KEEP of them, and stops when told', async () => {
  const { dataDir, db } = instance()
  let taken = 0
  // A clock an hour apart per snapshot: names are to the second.
  const now = () => new Date(Date.UTC(2026, 8, 1) + ++taken * 3_600_000)
  const logged = capture('log')
  try {
    const nextAt = startDatabaseSnapshots(db, dataDir, { everyMs: 50, keep: 2, problems: [] }, { firstDelayMs: 0, now })
    assert.equal(typeof nextAt, 'number')
    assert.match(logged.lines[0] ?? '', /^\[db\] snapshots of colloq\.db every 50 ms into .+snapshots, keeping 2; the next at \d{4}-/)
    await waitFor(() => taken >= 4 && !databaseSnapshotStatus(dataDir).running, 'four snapshots')
    assert.equal(typeof databaseSnapshotStatus(dataDir).nextAt, 'number')
    await stopDatabaseSnapshots()
  } finally {
    logged.restore()
  }
  const after = taken
  const kept = listSnapshots(dataDir)
  assert.deepEqual(
    kept.map((file) => file.name),
    [after, after - 1].map((n) => `colloq-${snapshotStamp(new Date(Date.UTC(2026, 8, 1) + n * 3_600_000))}.db`),
  )
  assert.equal(databaseSnapshotStatus(dataDir).nextAt, null)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(taken, after, 'a snapshot was taken after the schedule stopped')
})

test('after a restart the next snapshot is counted from the newest one on disk, not from the start', async () => {
  const { dataDir, db } = instance()
  const dir = path.join(dataDir, 'snapshots')
  fs.mkdirSync(dir, { mode: 0o700 })
  const hour = 3_600_000
  const logged = capture('log')
  try {
    // Nothing on disk: the first one a minute after the start.
    let nextAt = startDatabaseSnapshots(db, dataDir, { everyMs: hour, keep: 7, problems: [] })!
    assert.ok(Math.abs(nextAt - (Date.now() + 60_000)) < 2000, `${nextAt - Date.now()} ms`)

    // Taken ten minutes ago: the next one fifty minutes from now.
    const recent = new Date(Date.now() - 10 * 60_000)
    fs.writeFileSync(path.join(dir, `colloq-${snapshotStamp(recent)}.db`), 'recent', { mode: 0o600 })
    nextAt = startDatabaseSnapshots(db, dataDir, { everyMs: hour, keep: 7, problems: [] })!
    const stamped = Math.floor(recent.getTime() / 1000) * 1000
    assert.equal(nextAt, stamped + hour)

    // Overdue by an hour: only the minute a start needs.
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name))
    fs.writeFileSync(path.join(dir, `colloq-${snapshotStamp(new Date(Date.now() - 2 * hour))}.db`), 'old', { mode: 0o600 })
    nextAt = startDatabaseSnapshots(db, dataDir, { everyMs: hour, keep: 7, problems: [] })!
    assert.ok(Math.abs(nextAt - (Date.now() + 60_000)) < 2000, `${nextAt - Date.now()} ms`)
  } finally {
    logged.restore()
    await stopDatabaseSnapshots()
  }
})

/* ----------------------------------------------------- before a schema raise */

test('before a schema raise: a copy of the database as it was, 0600, named by both versions', () => {
  const { dataDir, db } = instance()
  // The partial of a start that was killed while copying.
  fs.mkdirSync(path.join(dataDir, 'snapshots'), { mode: 0o700 })
  fs.writeFileSync(path.join(dataDir, 'snapshots', 'pre-schema-1-to-2-20261001T075500Z.db.partial'), 'half')
  const logged = capture('log')
  let taken
  try {
    taken = snapshotBeforeSchemaRaise(db, dataDir, 1, 2, new Date('2026-10-01T08:00:00Z'))
  } finally {
    logged.restore()
  }
  assert.ok(taken)
  assert.equal(taken.name, 'pre-schema-1-to-2-20261001T080000Z.db')
  assert.equal(taken.kind, 'pre-schema')
  const file = path.join(dataDir, 'snapshots', taken.name)
  assert.equal(mode(file), 0o600)
  assert.equal(mode(path.join(dataDir, 'snapshots')), 0o700)
  assert.deepEqual(inspect(file), { rows: 50, version: 1, integrity: 'ok', tables: ['notes'] })
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'snapshots')), [taken.name])
  assert.match(logged.lines.join('\n'), /\[db\] snapshot before raising the data schema 1 → 2: pre-schema-1-to-2-20261001T080000Z\.db, \d+ KB in \d+ ms/)
})

test('no pre-schema copy when the schema is not raised, nor of a new empty file', () => {
  const { dataDir, db } = instance()
  const logged = capture('log')
  try {
    assert.equal(snapshotBeforeSchemaRaise(db, dataDir, 2, 2), null)
    assert.equal(snapshotBeforeSchemaRaise(db, dataDir, 3, 2), null)
    // 0 reads as 1 (data-schema.ts): 0 → 1 raises the number, not the schema.
    assert.equal(snapshotBeforeSchemaRaise(db, dataDir, 0, 1), null)
    assert.ok(!fs.existsSync(path.join(dataDir, 'snapshots')))
    // 0 → 2 is a real raise, from schema 1.
    assert.match(snapshotBeforeSchemaRaise(db, dataDir, 0, 2)?.name ?? '', /^pre-schema-1-to-2-\d{8}T\d{6}Z\.db$/)
    const empty = new Database(path.join(dataDir, 'fresh.db'))
    handles.push(empty)
    const elsewhere = path.join(dataDir, 'fresh-data')
    assert.equal(snapshotBeforeSchemaRaise(empty, elsewhere, 0, DATA_SCHEMA_VERSION + 1), null)
    assert.ok(!fs.existsSync(elsewhere))
  } finally {
    logged.restore()
  }
})

test('a pre-schema copy that cannot be written warns and lets the update go on', () => {
  const { dataDir, db } = instance()
  fs.writeFileSync(path.join(dataDir, 'snapshots'), 'not a folder')
  const warned = capture('warn')
  let taken
  try {
    taken = snapshotBeforeSchemaRaise(db, dataDir, 1, 2)
  } finally {
    warned.restore()
  }
  assert.equal(taken, null)
  assert.equal(warned.lines.length, 1)
  assert.match(warned.lines[0], /^\[db\] WARNING: could not take the snapshot before raising the data schema 1 → 2: .+The update goes on/)
})

/**
 * Through db.ts itself, with DATA_SCHEMA_VERSION raised by a loader hook: the
 * only honest way to show the copy is taken BEFORE the first migration runs.
 * The legacy file has only its `sessions` table; db.ts creates
 * `participants` among its first migrations, so a copy that has it was
 * taken too late.
 */
function openWithSchema(root: string, target: number | null): { status: number | null; out: string } {
  const hook = path.join(root, 'schema-hook.mjs')
  fs.writeFileSync(
    hook,
    `export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (!/\\/server\\/src\\/data-schema\\.ts(?:\\?.*)?$/.test(url)) return loaded
  const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source)
  return { ...loaded, source: source.replace(/DATA_SCHEMA_VERSION = \\d+/, 'DATA_SCHEMA_VERSION = ${target}') }
}
`,
  )
  const probe = path.join(root, 'probe.mts')
  fs.writeFileSync(
    probe,
    `${target === null ? '' : `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hook).href)})\n`}` +
      `const { db } = await import(${JSON.stringify(path.join(repo, 'server/src/db.ts'))})
console.log('stamp=' + db.pragma('user_version', { simple: true }))
process.exit(0)
`,
  )
  const r = spawnSync(process.execPath, ['--import', 'tsx', probe], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      DATA_DIR: path.join(root, 'data'),
      WORKSPACE_DIR: path.join(root, 'workspace'),
      SESSION_SECRET: 'test-secret-not-random-on-purpose',
      [ALLOW_SCHEMA_DOWNGRADE]: '',
      LOG_FORMAT: '',
    },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

function legacyRoot(version: number): string {
  const root = scratch('colloq-schema-raise-')
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 })
  fs.mkdirSync(path.join(root, 'workspace'))
  const legacy = new Database(path.join(root, 'data', 'colloq.db'))
  legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL); INSERT INTO sessions VALUES ('s1', 'kept', 1)")
  legacy.pragma(`user_version = ${version}`)
  legacy.close()
  return root
}

test('db.ts copies the database before the first migration when it raises the schema, once', () => {
  const target = DATA_SCHEMA_VERSION + 1
  const root = legacyRoot(DATA_SCHEMA_VERSION)
  const first = openWithSchema(root, target)
  assert.equal(first.status, 0, first.out)
  assert.match(first.out, new RegExp(`stamp=${target}\\b`))
  assert.match(first.out, new RegExp(`\\[db\\] snapshot before raising the data schema ${DATA_SCHEMA_VERSION} → ${target}: `))

  const dir = path.join(root, 'data', 'snapshots')
  const names = fs.readdirSync(dir)
  assert.equal(names.length, 1, names.join(', '))
  assert.match(names[0], new RegExp(`^pre-schema-${DATA_SCHEMA_VERSION}-to-${target}-\\d{8}T\\d{6}Z\\.db$`))
  assert.equal(mode(path.join(dir, names[0])), 0o600)
  const copy = inspect(path.join(dir, names[0]))
  assert.equal(copy.version, DATA_SCHEMA_VERSION, 'the copy carries the old stamp')
  assert.deepEqual(copy.tables, ['sessions'], 'the copy was taken after a migration had run')
  assert.equal(copy.rows, 1)
  assert.equal(copy.integrity, 'ok')

  // The live database went on: new stamp, migrated. Read in place: the probe
  // exited without closing it, so the migrations are still in its WAL.
  const live = inspect(path.join(root, 'data', 'colloq.db'), { inPlace: true })
  assert.equal(live.version, target)
  assert.ok(live.tables.includes('participants'))

  // The stamp is raised now; the next start copies nothing.
  const second = openWithSchema(root, target)
  assert.equal(second.status, 0, second.out)
  assert.deepEqual(fs.readdirSync(dir), names)
})

test('an ordinary start takes no snapshot: a new database, and one from before the stamp', () => {
  for (const root of [scratch('colloq-schema-fresh-'), legacyRoot(0)]) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true, mode: 0o700 })
    const r = openWithSchema(root, null)
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`stamp=${DATA_SCHEMA_VERSION}\\b`))
    assert.ok(!fs.existsSync(path.join(root, 'data', 'snapshots')), `a snapshot folder in ${root}`)
    assert.doesNotMatch(r.out, /snapshot/)
  }
})
