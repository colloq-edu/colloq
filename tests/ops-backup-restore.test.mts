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
  for (const dir of built.splice(0)) {
    // A failed assertion can leave a folder a test closed with chmod 000.
    spawnSync('chmod', ['-R', 'u+rwx', dir])
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

/* ------------------------------------------ what student code leaves behind */

/** backup-local.sh itself, with settings in the environment (the pip `colloq backup`, the image's `colloq-vast backup`). */
function backupLocal(dir: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(dir, 'scripts/backup-local.sh')], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, COLLOQ_HOME: '', ENV_FILE: path.join(dir, '.env'), ...env },
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const LINKS: Record<string, string> = {
  'to-file': 'notes.csv',
  'to-dir': 'sub',
  dangling: 'missing-target',
  absolute: '/etc/hosts',
  '.venv/bin/python': '/usr/bin/python3',
}

function studentMess(dir: string, outside: string): void {
  const room = path.join(dir, 'workspace/s-one')
  fs.mkdirSync(path.join(room, 'sub'), { recursive: true })
  fs.mkdirSync(path.join(room, '.venv/bin'), { recursive: true })
  for (const [name, target] of Object.entries(LINKS)) fs.symlinkSync(target, path.join(room, name))
  fs.symlinkSync(path.relative(room, outside), path.join(room, 'escaping'))
  execFileSync('mkfifo', [path.join(room, 'pipe')])
  execFileSync('python3', ['-c', 'import os,socket,sys; os.chdir(sys.argv[1]); socket.socket(socket.AF_UNIX).bind("k.sock")', room])
}

test('symlinks of every kind survive the round trip as links, FIFOs and sockets are named and left out', () => {
  const m = machine()
  seedDb(m.dir, 'first class')
  seedFiles(m.dir)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-outside-'))
  built.push(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not the backup\'s')
  studentMess(m.dir, outside)
  fs.mkdirSync(path.join(m.dir, 'data/blobs/ab'), { recursive: true })
  fs.writeFileSync(path.join(m.dir, 'data/blobs/ab/cdef'), 'an output image')

  const b = backupLocal(m.dir)
  assert.equal(b.status, 0, b.out)
  const room = fs.realpathSync(path.join(m.dir, 'workspace/s-one'))
  assert.match(b.out, new RegExp(`skipped a FIFO: .*${path.basename(m.dir)}/workspace/s-one/pipe`))
  assert.match(b.out, new RegExp(`skipped a socket: .*${path.basename(m.dir)}/workspace/s-one/k\\.sock`))
  const pair = backupPair(m.dir)
  const listed = execFileSync('tar', ['-tzf', path.join(m.dir, pair.files)], { encoding: 'utf8' }).split('\n')
  // Output images are in the pip backup now.
  assert.ok(listed.includes('data/blobs/ab/cdef'), listed.join('\n'))
  assert.ok(!listed.some((n) => n.includes('secret.txt') || n.startsWith('workspace/s-one/to-dir/') || /pipe$|k\.sock$/.test(n)))

  // An empty machine, then the restore.
  for (const p of ['data/colloq.db', 'workspace', 'data/blobs']) fs.rmSync(path.join(m.dir, p), { recursive: true, force: true })
  const r = m.restore([pair.db, pair.files])
  assert.equal(r.status, 0, r.out)
  for (const [name, target] of Object.entries(LINKS)) {
    assert.ok(fs.lstatSync(path.join(room, name)).isSymbolicLink(), name)
    assert.equal(fs.readlinkSync(path.join(room, name)), target, name)
  }
  assert.equal(fs.readlinkSync(path.join(room, 'escaping')), path.relative(path.join(m.dir, 'workspace/s-one'), outside))
  assert.equal(fs.readFileSync(path.join(m.dir, 'data/blobs/ab/cdef'), 'utf8'), 'an output image')
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt'])
})

test('an unreadable file or folder in a room is named and skipped; the backup still happens', { skip: process.getuid?.() === 0 && 'root reads mode 000' }, () => {
  const m = machine()
  seedDb(m.dir, 'first class')
  seedFiles(m.dir)
  const room = path.join(m.dir, 'workspace/s-one')
  fs.writeFileSync(path.join(room, 'closed.txt'), 'x'); fs.chmodSync(path.join(room, 'closed.txt'), 0)
  fs.mkdirSync(path.join(room, 'closed-dir')); fs.writeFileSync(path.join(room, 'closed-dir/f'), 'x'); fs.chmodSync(path.join(room, 'closed-dir'), 0)
  try {
    const b = backupLocal(m.dir)
    assert.equal(b.status, 0, b.out)
    assert.match(b.out, /skipped an unreadable file: .*workspace\/s-one\/closed\.txt/)
    assert.match(b.out, /skipped an unreadable folder: .*workspace\/s-one\/closed-dir/)
    const listed = execFileSync('tar', ['-tzf', path.join(m.dir, backupPair(m.dir).files)], { encoding: 'utf8' })
    assert.match(listed, /workspace\/s-one\/notes\.csv/)
    assert.doesNotMatch(listed, /closed\.txt|closed-dir\/f/)
  } finally {
    fs.chmodSync(path.join(room, 'closed.txt'), 0o600)
    fs.chmodSync(path.join(room, 'closed-dir'), 0o700)
  }
})

test('the backup is private while it is written: everything under it runs with umask 077', () => {
  const m = machine()
  seedDb(m.dir, 'first class')
  seedFiles(m.dir)
  // A tar that reports the umask it inherited, then does the real work.
  const real = execFileSync('/bin/sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim()
  const bin = path.join(m.dir, 'bin'); fs.mkdirSync(bin)
  const log = path.join(m.dir, 'tar-umask')
  fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh\numask > '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  const b = backupLocal(m.dir, { PATH: `${bin}:${process.env.PATH}` })
  assert.equal(b.status, 0, b.out)
  assert.equal(fs.readFileSync(log, 'utf8').trim(), '0077')
  assert.equal(fs.statSync(path.join(m.dir, 'backups')).mode & 0o777, 0o700)
})

test('BACKUP_KEEP keeps the newest pairs of this instance, never the one just made, and nothing it did not write', async () => {
  const m = machine()
  seedDb(m.dir, 'first class')
  seedFiles(m.dir)
  const backups = path.join(m.dir, 'backups')
  fs.mkdirSync(path.join(backups, 'demo'), { recursive: true })
  const old = ['20250101-000000', '20250102-000000', '20250103-000000']
  for (const stamp of old) {
    fs.writeFileSync(path.join(backups, `colloq-${stamp}.db`), 'old')
    fs.writeFileSync(path.join(backups, `colloq-${stamp}-files.tar.gz`), 'old')
  }
  fs.renameSync(path.join(backups, 'colloq-20250103-000000.db'), path.join(backups, 'colloq-20250103-000000.db.age'))
  const strangers = ['notes.txt', 'colloq-manual.db', 'colloq-20250101-000000.db.replaced-1']
  for (const name of strangers) fs.writeFileSync(path.join(backups, name), 'keep me')
  fs.writeFileSync(path.join(backups, 'demo/colloq-20200101-000000.db'), 'another deployment')

  const b = backupLocal(m.dir, { BACKUP_KEEP: '2' })
  assert.equal(b.status, 0, b.out)
  const left = fs.readdirSync(backups).sort()
  const fresh = left.filter((n) => /^colloq-\d{8}-\d{6}\.db$/.test(n) && !n.startsWith('colloq-2025'))
  assert.equal(fresh.length, 1, left.join(', '))
  assert.deepEqual(left.filter((n) => n.startsWith('colloq-2025')).sort(),
    ['colloq-20250101-000000.db.replaced-1', 'colloq-20250103-000000-files.tar.gz', 'colloq-20250103-000000.db.age'])
  for (const name of strangers) assert.ok(left.includes(name), name)
  assert.ok(fs.existsSync(path.join(backups, 'demo/colloq-20200101-000000.db')))

  // A clock that went backwards: the fresh pair sorts older and still stays.
  // (Names go by the second, so the next backup waits for a new one.)
  fs.writeFileSync(path.join(backups, 'colloq-29991231-235959.db'), 'future')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const again = backupLocal(m.dir, { BACKUP_KEEP: '1' })
  assert.equal(again.status, 0, again.out)
  const now = fs.readdirSync(backups).filter((n) => /^colloq-\d{8}-\d{6}(\.db|-files\.tar\.gz)(\.age)?$/.test(n)).sort()
  assert.equal(now.length, 3, now.join(', '))
  assert.ok(now.includes('colloq-29991231-235959.db'))
  // Nonsense is refused before anything is written.
  const before = fs.readdirSync(backups).length
  const bad = backupLocal(m.dir, { BACKUP_KEEP: 'fourteen' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.out, /BACKUP_KEEP/)
  assert.equal(fs.readdirSync(backups).length, before)
})

test('a disk without room for both files refuses before writing either', () => {
  const m = machine()
  seedDb(m.dir, 'first class')
  seedFiles(m.dir)
  const bin = path.join(m.dir, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/disk 1000000 999000 1000 99% /"\n', { mode: 0o755 })
  const b = backupLocal(m.dir, { PATH: `${bin}:${process.env.PATH}` })
  assert.notEqual(b.status, 0)
  assert.match(b.out, /not enough free space/)
  assert.deepEqual(fs.readdirSync(path.join(m.dir, 'backups')), [])
})

/** A files archive built entry by entry. */
function craftFiles(dir: string, entries: string): string {
  const file = path.join(dir, 'backups', 'colloq-20260101-000000-files.tar.gz')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('python3', ['-c', `import tarfile,io,sys
t=tarfile.open(sys.argv[1],'w:gz')
def add(name, kind='file', link=''):
    m=tarfile.TarInfo(name)
    if kind=='dir': m.type=tarfile.DIRTYPE; m.mode=0o755; t.addfile(m)
    elif kind=='sym': m.type=tarfile.SYMTYPE; m.linkname=link; t.addfile(m)
    else: m.size=4; t.addfile(m, io.BytesIO(b'evil'))
${entries}
t.close()`, file])
  return path.relative(dir, file)
}

test('restore reads the archive names first and never unpacks outside the state directory', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-outside-'))
  built.push(outside)
  for (const [label, entries, reason] of [
    ['an absolute name', `add('${outside}/evil')`, /absolute name/],
    ['a name with ..', "add('workspace/../../evil')", /"\.\."/],
    ['a name outside what a backup holds', "add('.env')", /unexpected name/],
    ['the database slipped into the files', "add('data/colloq.db')", /unexpected name/],
  ] as const) {
    const m = machine()
    const archive = craftFiles(m.dir, entries)
    const r = m.restore([archive])
    assert.notEqual(r.status, 0, label)
    assert.match(r.out, reason, label)
    assert.deepEqual(fs.readdirSync(outside), [], label)
    assert.deepEqual(fs.readdirSync(path.join(m.dir, 'workspace/s-one')), [], `${label}: nothing unpacked`)
    assert.equal(fs.existsSync(path.join(m.dir, 'data/colloq.db')), false, label)
  }
  // A link, then a file beneath it: tar itself refuses to write through the
  // link it has just made (GNU delays such links, bsdtar refuses), so the
  // restore fails and nothing lands outside.
  const m = machine()
  const archive = craftFiles(m.dir, `add('workspace','dir'); add('workspace/l','sym','${outside}'); add('workspace/l/evil')`)
  const r = m.restore([archive])
  assert.notEqual(r.status, 0, r.out)
  assert.deepEqual(fs.readdirSync(outside), [])
})

/** A stand-in for age: "encrypts" with a header line, "decrypts" by removing it, and insists on an identity. */
const FAKE_AGE = `#!/bin/sh
mode=enc; out=; in=; identity=
while [ $# -gt 0 ]; do
  case "$1" in -d) mode=dec; shift;; -i) identity="$2"; shift 2;; -r|-R) shift 2;; -o) out="$2"; shift 2;; *) in="$1"; shift;; esac
done
if [ "$mode" = enc ]; then { printf 'AGE-TEST\\n'; cat "$in"; } > "$out"; exit 0; fi
[ -f "$identity" ] || { echo "no identity" >&2; exit 1; }
tail -n +2 "$in" > "$out"
`

test('BACKUP_AGE_RECIPIENT encrypts both files, and restore decrypts them with BACKUP_AGE_IDENTITY', () => {
  const m = machine()
  seedDb(m.dir, 'secret class')
  seedFiles(m.dir)
  const bin = path.join(m.dir, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'age'), FAKE_AGE, { mode: 0o755 })
  const env = { PATH: `${bin}:${process.env.PATH}` }
  const b = backupLocal(m.dir, { ...env, BACKUP_AGE_RECIPIENT: 'age1example' })
  assert.equal(b.status, 0, b.out)
  const names = fs.readdirSync(path.join(m.dir, 'backups')).sort()
  assert.equal(names.length, 2, names.join(', '))
  assert.match(names[0], /^colloq-\d{8}-\d{6}-files\.tar\.gz\.age$/)
  assert.match(names[1], /^colloq-\d{8}-\d{6}\.db\.age$/)
  for (const name of names) assert.equal(fs.statSync(path.join(m.dir, 'backups', name)).mode & 0o777, 0o600)
  assert.match(b.out, /restore it back: colloq restore --legacy --db backups\/colloq-.*\.db\.age --files backups\/colloq-.*-files\.tar\.gz\.age/)

  fs.rmSync(path.join(m.dir, 'data/colloq.db'))
  fs.rmSync(path.join(m.dir, 'workspace/s-one'), { recursive: true })
  const db = `backups/${names[1]}`
  const refused = m.restore([db], env)
  assert.notEqual(refused.status, 0)
  assert.match(refused.out, /BACKUP_AGE_IDENTITY/)
  assert.equal(fs.existsSync(path.join(m.dir, 'data/colloq.db')), false)
  const identity = path.join(m.dir, 'identity.txt'); fs.writeFileSync(identity, 'AGE-SECRET-KEY-TEST')
  const r = m.restore([db], { ...env, BACKUP_AGE_IDENTITY: identity })
  assert.equal(r.status, 0, r.out)
  assert.equal(markOf(path.join(m.dir, 'data/colloq.db')), 'secret class')
  assert.equal(fs.readFileSync(path.join(m.dir, 'workspace/s-one/notes.csv'), 'utf8'), 'a,b\n1,2\n')
  assert.equal(fs.readdirSync(m.dir).filter((n) => n.startsWith('.restore-plain')).length, 0, 'the plain copies are removed')
})

test('asked to encrypt without age, the backup refuses before writing anything', () => {
  const m = machine()
  seedDb(m.dir, 'first class')
  const python = execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
  const sqlite = execFileSync('/bin/sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).trim()
  const bare = [...new Set([path.dirname(python), path.dirname(sqlite), '/usr/bin', '/bin'])].join(':')
  if (spawnSync('/bin/sh', ['-c', 'command -v age'], { encoding: 'utf8', env: { PATH: bare } }).stdout.trim() !== '') return
  const b = backupLocal(m.dir, { PATH: bare, BACKUP_AGE_RECIPIENT: 'age1example' })
  assert.notEqual(b.status, 0)
  assert.match(b.out, /age is not installed/)
  assert.equal(fs.existsSync(path.join(m.dir, 'backups')) ? fs.readdirSync(path.join(m.dir, 'backups')).length : 0, 0)
})
