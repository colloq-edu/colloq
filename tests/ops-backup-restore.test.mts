/**
 * The way back: `make backup` → `scripts/restore.sh`.
 *
 * The only path by which a semester comes back on a new machine, and until
 * now it was checked only on a live machine — that is, exactly where the cost
 * of a mistake is highest. Here it runs end to end in a temporary directory:
 * the `backup` recipe is taken from the real Makefile, and the real
 * scripts/restore.sh unpacks it.
 *
 * What is pinned down:
 *
 *  - the backup carries the package lists (they are created from the panel
 *    right on the machine, and there is nowhere else to get them), the
 *    seminar files and both keys;
 *  - the WAL journal leaves together with the database it describes rather
 *    than staying next to the new one: otherwise sqlite would apply someone
 *    else's pages to it;
 *  - restoring over a non-empty machine requires an explicit REPLACE=1. This
 *    guards against exactly the case where a silent /api/health declared the
 *    machine "empty": a stopped service is not an empty machine, and a
 *    repeated vast-up rolled the class back to yesterday's copy;
 *  - the 0600 permissions on the signing key survive unpacking.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A port known to have nobody on it: restore.sh asks about a live server. */
const DEAD_PORT = 39997

interface Machine {
  dir: string
  /** Run a recipe from the real Makefile. */
  make(target: string): string
  /** Run the real restore.sh. Returns the code and both streams. */
  restore(args: string[], env?: Record<string, string>): { status: number | null; out: string }
}

/**
 * A machine in miniature: the real Makefile and scripts/, its own data/ and
 * workspace/.
 *
 * The script does `cd "$(dirname "$0")/.."`, so the copy in <tmp>/scripts/
 * works inside the temporary directory and cannot reach the real data/ and
 * workspace/ — one such run would otherwise have eaten a working instance
 * one day.
 */
/** This file's machines — and cleanup after them: each carries its own data/ and workspace/. */
const built: string[] = []
after(() => {
  for (const dir of built.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function machine(): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-restore-'))
  built.push(dir)
  fs.mkdirSync(path.join(dir, 'scripts'))
  // backup-local.sh is that very backup recipe: it moved from the Makefile
  // into scripts/ because scripts go into the pip wheel and the Makefile does
  // not. The backup-legacy target is now a wrapper around it, and without the
  // file the miniature machine has nothing to take a backup with.
  for (const f of ['backup-local.sh', 'restore.sh', 'lib.sh']) {
    fs.copyFileSync(path.join(repo, 'scripts', f), path.join(dir, 'scripts', f))
  }
  fs.copyFileSync(path.join(repo, 'Makefile'), path.join(dir, 'Makefile'))
  fs.writeFileSync(path.join(dir, '.env'), `PORT=${DEAD_PORT}\nKERNEL_ENV=base\n`)

  fs.mkdirSync(path.join(dir, 'data'))
  fs.mkdirSync(path.join(dir, 'workspace/s-one'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'kernel/environments'), { recursive: true })
  return {
    dir,
    make: (target) =>
      execFileSync('make', ['--no-print-directory', '-C', dir, target === 'backup' ? 'backup-legacy' : target], {
        encoding: 'utf8',
        env: { ...process.env, COLLOQ_HOME: '', ENV_FILE: path.join(dir, '.env') },
      }),
    restore: (args, env = {}) => {
      const r = spawnSync('bash', [path.join(dir, 'scripts/restore.sh'), ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, COLLOQ_HOME: '', ENV_FILE: path.join(dir, '.env'), ...env },
      })
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    },
  }
}

/** A database with one table and an unclosed WAL journal — as on a live machine. */
function seedDb(dir: string, mark: string): void {
  execFileSync('sqlite3', [
    path.join(dir, 'data/colloq.db'),
    'pragma journal_mode=wal;',
    'create table if not exists seminars (id text primary key, name text);',
    `insert into seminars values ('s-one', '${mark}');`,
  ])
}

/** What is written in the database — it shows which one survived. */
function markOf(file: string): string {
  return execFileSync('sqlite3', [file, 'select name from seminars']).toString().trim()
}

const wheelBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x0a])
const wheelHash = createHash('sha256').update(wheelBytes).digest('hex')
const lockText = `demo==1.0 --hash=sha256:${wheelHash}\n`
const bundlePath = 'data/dependencies/bundles/bundle-one'

function seedFiles(dir: string): void {
  fs.writeFileSync(path.join(dir, 'workspace/s-one/notes.csv'), 'a,b\n1,2\n')
  fs.writeFileSync(path.join(dir, 'data/session-secret'), 'signing-key\n', { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'data/setup-token'), 'setup\n', { mode: 0o600 })
  // Competition inputs and immutable bundle files live outside workspace/.
  for (const folder of ['data/competitions/c-one/open', 'data/competitions/c-one/secret', `${bundlePath}/wheels`, 'data/dependencies/artifacts']) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(path.join(dir, 'data/competitions/c-one/open/train.csv'), 'feature\n42\n')
  fs.writeFileSync(path.join(dir, 'data/competitions/c-one/secret/solution.csv'), 'target\n1\n', { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'data/dependencies/artifacts', wheelHash), wheelBytes, { mode: 0o444 })
  fs.linkSync(path.join(dir, 'data/dependencies/artifacts', wheelHash), path.join(dir, bundlePath, 'wheels/demo-1.0-py3-none-any.whl'))
  fs.writeFileSync(path.join(dir, bundlePath, 'requirements.lock'), lockText, { mode: 0o444 })
  fs.writeFileSync(path.join(dir, bundlePath, 'manifest.json'), JSON.stringify({ packages: [{ sha256: wheelHash }] }), { mode: 0o444 })
  // A package list created on this machine from the panel: it is not in the
  // repository.
  fs.writeFileSync(path.join(dir, 'kernel/environments/nlp.txt'), '# из панели\nspacy\n')
}

/** The "database + archive" pair from backups/, as `make backup` leaves it. */
function backupPair(dir: string): { db: string; files: string } {
  const names = fs.readdirSync(path.join(dir, 'backups'))
  const db = names.find((n) => n.endsWith('.db'))
  const files = names.find((n) => n.endsWith('-files.tar.gz'))
  assert.ok(db, 'the database copy did not appear')
  assert.ok(files, 'the file archive did not appear')
  return { db: `backups/${db}`, files: `backups/${files}` }
}

test('make backup keeps the class and competition files, the keys and the built wheel bundles', () => {
  const m = machine()
  seedDb(m.dir, 'первая пара')
  seedFiles(m.dir)

  m.make('backup')
  const { files } = backupPair(m.dir)

  const listed = execFileSync('tar', ['-tzf', path.join(m.dir, files)], { encoding: 'utf8' })
  assert.match(listed, /workspace\/s-one\/notes\.csv/)
  assert.match(listed, /data\/session-secret/)
  assert.match(listed, /data\/setup-token/)
  assert.match(listed, /data\/competitions\/c-one\/secret\/solution\.csv/)
  assert.ok(listed.includes(`data/dependencies/artifacts/${wheelHash}`))
  assert.ok(listed.includes(`${bundlePath}/requirements.lock`))
  assert.ok(listed.includes(`${bundlePath}/manifest.json`))
  assert.ok(listed.includes(`${bundlePath}/wheels/demo-1.0-py3-none-any.whl`))
  // This line is what the change was made for: an environment created from
  // the panel on a rented machine lives only in this file.
  assert.match(listed, /kernel\/environments\/nlp\.txt/)

  // The database copy is as secret as the database itself.
  const { db } = backupPair(m.dir)
  assert.equal(fs.statSync(path.join(m.dir, db)).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(m.dir, files)).mode & 0o777, 0o600)
})

test('on an empty machine the backup is restored whole, and the signing key stays 0600', () => {
  const m = machine()
  seedDb(m.dir, 'первая пара')
  seedFiles(m.dir)
  m.make('backup')
  const pair = backupPair(m.dir)

  // An empty machine: no database, no files, no lists.
  fs.rmSync(path.join(m.dir, 'data/colloq.db'))
  fs.rmSync(path.join(m.dir, 'data/session-secret'))
  fs.rmSync(path.join(m.dir, 'workspace/s-one'), { recursive: true })
  fs.rmSync(path.join(m.dir, 'kernel/environments/nlp.txt'))
  fs.rmSync(path.join(m.dir, 'data/competitions'), { recursive: true })
  fs.rmSync(path.join(m.dir, 'data/dependencies'), { recursive: true })

  const r = m.restore([pair.db, pair.files])
  assert.equal(r.status, 0, r.out)

  assert.equal(markOf(path.join(m.dir, 'data/colloq.db')), 'первая пара')
  assert.equal(fs.readFileSync(path.join(m.dir, 'data/competitions/c-one/open/train.csv'), 'utf8'), 'feature\n42\n')
  assert.equal(fs.readFileSync(path.join(m.dir, 'data/competitions/c-one/secret/solution.csv'), 'utf8'), 'target\n1\n')
  assert.equal(fs.statSync(path.join(m.dir, 'data/competitions/c-one/secret/solution.csv')).mode & 0o777, 0o600)
  assert.deepEqual(fs.readFileSync(path.join(m.dir, 'data/dependencies/artifacts', wheelHash)), wheelBytes)
  assert.deepEqual(fs.readFileSync(path.join(m.dir, bundlePath, 'wheels/demo-1.0-py3-none-any.whl')), wheelBytes)
  assert.equal(fs.readFileSync(path.join(m.dir, bundlePath, 'requirements.lock'), 'utf8'), lockText)
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.dir, bundlePath, 'manifest.json'), 'utf8')).packages[0].sha256, wheelHash)
  assert.equal(fs.statSync(path.join(m.dir, bundlePath, 'requirements.lock')).mode & 0o777, 0o444)
  assert.equal(fs.readFileSync(path.join(m.dir, 'workspace/s-one/notes.csv'), 'utf8'), 'a,b\n1,2\n')
  assert.equal(fs.readFileSync(path.join(m.dir, 'kernel/environments/nlp.txt'), 'utf8'), '# из панели\nspacy\n')
  assert.equal(fs.statSync(path.join(m.dir, 'data/session-secret')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(m.dir, 'data/colloq.db')).mode & 0o777, 0o600)
})

test('over a non-empty machine and without a terminal — a refusal, not a silent replacement', () => {
  const m = machine()
  seedDb(m.dir, 'вчерашняя копия')
  seedFiles(m.dir)
  m.make('backup')
  const pair = backupPair(m.dir)

  // A class has taken place on the machine since then.
  execFileSync('sqlite3', [path.join(m.dir, 'data/colloq.db'), "update seminars set name='сегодняшняя пара'"])
  fs.writeFileSync(path.join(m.dir, 'workspace/s-one/notes.csv'), 'сегодняшнее\n')

  const r = m.restore([pair.db, pair.files])
  assert.notEqual(r.status, 0, 'restoring over a class must require an explicit word')
  assert.match(r.out, /REPLACE=1/)
  // And nothing is touched: not the database, not the files, and there are no
  // set-aside copies next to them.
  assert.equal(markOf(path.join(m.dir, 'data/colloq.db')), 'сегодняшняя пара')
  assert.equal(fs.readFileSync(path.join(m.dir, 'workspace/s-one/notes.csv'), 'utf8'), 'сегодняшнее\n')
  assert.equal(
    fs.readdirSync(path.join(m.dir, 'data')).filter((n) => n.includes('replaced')).length,
    0,
  )
})

test('REPLACE=1 restores over it and takes the old journal away together with the old database', () => {
  const m = machine()
  seedDb(m.dir, 'вчерашняя копия')
  seedFiles(m.dir)
  m.make('backup')
  const pair = backupPair(m.dir)

  execFileSync('sqlite3', [path.join(m.dir, 'data/colloq.db'), "update seminars set name='сегодняшняя пара'"])
  // A journal next to the database is the reason the script exists at all.
  fs.writeFileSync(path.join(m.dir, 'data/colloq.db-wal'), 'страницы прежней базы')
  fs.writeFileSync(path.join(m.dir, 'data/colloq.db-shm'), 'общая память')

  const r = m.restore([pair.db, pair.files], { REPLACE: '1' })
  assert.equal(r.status, 0, r.out)

  assert.equal(markOf(path.join(m.dir, 'data/colloq.db')), 'вчерашняя копия')
  const left = fs.readdirSync(path.join(m.dir, 'data'))
  assert.ok(
    !left.includes('colloq.db-wal') && !left.includes('colloq.db-shm'),
    `someone else's journal stayed next to the new database: ${left.join(', ')}`,
  )
  const replaced = left.filter((n) => n.startsWith('colloq.db.replaced-'))
  assert.equal(replaced.length, 3, `the old database and journal are set aside whole: ${replaced.join(', ')}`)
  assert.equal(
    markOf(path.join(m.dir, 'data', replaced.find((n) => !n.endsWith('-wal') && !n.endsWith('-shm'))!)),
    'сегодняшняя пара',
  )
})

test('a file that is not an sqlite database is not restored at all', () => {
  const m = machine()
  seedDb(m.dir, 'первая пара')
  seedFiles(m.dir)
  fs.mkdirSync(path.join(m.dir, 'backups'), { recursive: true })
  fs.writeFileSync(path.join(m.dir, 'backups/colloq-20260101-000000.db'), '<html>не докачалось</html>')
  fs.rmSync(path.join(m.dir, 'data/colloq.db'))

  const r = m.restore(['backups/colloq-20260101-000000.db'])
  assert.notEqual(r.status, 0)
  assert.match(r.out, /sqlite/i)
  assert.ok(!fs.existsSync(path.join(m.dir, 'data/colloq.db')), 'a broken copy is not put in place')
})

test('SQLite quick_check output must be ok even when sqlite3 exits successfully', () => {
  const m = machine(); seedDb(m.dir, 'keep')
  fs.mkdirSync(path.join(m.dir, 'backups'))
  fs.renameSync(path.join(m.dir, 'data/colloq.db'), path.join(m.dir, 'backups/check.db'))
  fs.mkdirSync(path.join(m.dir, 'bin'))
  fs.writeFileSync(path.join(m.dir, 'bin/sqlite3'), '#!/bin/sh\necho "database integrity error"\nexit 0\n', { mode: 0o755 })
  const r = m.restore(['backups/check.db'], { PATH: path.join(m.dir, 'bin') + ':' + process.env.PATH })
  assert.notEqual(r.status, 0, r.out)
  assert.ok(!fs.existsSync(path.join(m.dir, 'data/colloq.db')), 'non-ok database must not be installed')
})
