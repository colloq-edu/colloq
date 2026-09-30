/**
 * The portable backup against what student code leaves in a room.
 *
 * One symlink or FIFO in any room used to stop every backup, and since
 * update and rollback take their backup after stopping the app, the update
 * then failed with the classes already down. `python -m venv` alone makes a
 * dozen links. What is pinned here, against the real scripts:
 *
 *  - links of every kind are stored as links and come back as the same links;
 *    FIFOs and sockets are skipped with their full path; nothing outside the
 *    state directory is read or written;
 *  - restore refuses archives that would write outside its stage: absolute
 *    names, "..", a link followed by an entry beneath it, hard links, special
 *    files, links where a file must be;
 *  - the backup refuses a copy that would not fit and stops before the disk
 *    fills;
 *  - retention keeps BACKUP_KEEP archives, never the fresh one, and touches
 *    nothing it did not name;
 *  - a database stamped by newer code is refused under an older release;
 *  - cluster.sh update pulls images and checks the backup before it stops
 *    anything, and brings the classes back when the backup fails after the
 *    stop.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(repo, 'scripts/runtime-backup.py')
const dirs: string[] = []
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))
function temp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-robust-')))
  dirs.push(dir)
  return dir
}
function run(...args: string[]) {
  const r = spawnSync('python3', [script, ...args], { encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}
const release = (compatible = [1]) => ({ schemaVersion: 1, version: 'v1', sourceCommit: 'a'.repeat(40), k3sVersion: 'v1.34.1+k3s1',
  appImage: 'registry.example/app@sha256:' + 'b'.repeat(64), runtimeImage: 'registry.example/runtime@sha256:' + 'c'.repeat(64),
  dataSchemaVersion: compatible[compatible.length - 1], compatibleDataSchemaVersions: compatible,
  catalog: { schemaVersion: 1, release: 'v1', defaultEnvironment: 'base',
    environments: [{ name: 'base', image: 'registry.example/kernel@sha256:' + 'd'.repeat(64), gpu: false }] } })

function database(file: string, userVersion = 0): void {
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute("create table note(value text)"); c.execute("insert into note values ('kept')")
c.execute("pragma user_version=${userVersion}"); c.commit(); c.close()`, file])
}

function seed(userVersion = 0, compatible = [1]) {
  const root = temp()
  fs.mkdirSync(path.join(root, 'data'))
  fs.mkdirSync(path.join(root, 'workspace/room-a/sub'), { recursive: true })
  fs.mkdirSync(path.join(root, 'secrets'))
  database(path.join(root, 'data/colloq.db'), userVersion)
  fs.writeFileSync(path.join(root, 'workspace/room-a/file.txt'), 'room data')
  fs.writeFileSync(path.join(root, 'workspace/room-a/sub/inner.txt'), 'inner')
  fs.writeFileSync(path.join(root, 'data/session-secret'), 'signing-key', { mode: 0o600 })
  const releaseFile = path.join(root, 'release.json')
  fs.writeFileSync(releaseFile, JSON.stringify(release(compatible)))
  return { root, release: releaseFile, archive: path.join(temp(), 'colloq-test.tar.gz') }
}

/** What `python -m venv` and a running kernel leave behind, plus the worst links a student can make. */
const LINKS: Record<string, string> = {
  'to-file': 'file.txt',
  'to-dir': 'sub',
  dangling: 'missing-target',
  absolute: '/etc/hosts',
  '.venv/bin/python': '/usr/bin/python3',
  '.venv/lib64': 'lib',
}
function leaveStudentMess(root: string, outside: string): void {
  const room = path.join(root, 'workspace/room-a')
  fs.mkdirSync(path.join(room, '.venv/bin'), { recursive: true })
  fs.mkdirSync(path.join(room, '.venv/lib'))
  for (const [name, target] of Object.entries(LINKS)) fs.symlinkSync(target, path.join(room, name))
  // Out of the tree, to a real folder with something in it.
  fs.symlinkSync(path.relative(room, outside), path.join(room, 'escaping'))
  execFileSync('mkfifo', [path.join(room, 'pipe')])
  // A socket, bound by a relative name: macOS caps socket paths at 104 bytes.
  execFileSync('python3', ['-c', 'import os,socket,sys; os.chdir(sys.argv[1]); socket.socket(socket.AF_UNIX).bind("kernel.sock")', room])
}

function members(archive: string): { name: string; type: string; link: string }[] {
  return JSON.parse(execFileSync('python3', ['-c',
    'import tarfile,sys,json; print(json.dumps([dict(name=m.name,type=m.type.decode(),link=m.linkname) for m in tarfile.open(sys.argv[1])]))',
    archive], { encoding: 'utf8' }))
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('links are kept as links, FIFOs and sockets are skipped by full path, and a room comes back whole', () => {
  const s = seed()
  const outside = temp()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the state')
  leaveStudentMess(s.root, outside)
  const backed = run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'live')
  assert.equal(backed.status, 0, backed.out)
  assert.match(backed.out, new RegExp(`skipped a FIFO: ${escape(path.join(s.root, 'workspace/room-a/pipe'))}`))
  assert.match(backed.out, new RegExp(`skipped a socket: ${escape(path.join(s.root, 'workspace/room-a/kernel.sock'))}`))

  const listed = members(s.archive)
  const byName = new Map(listed.map((m) => [m.name, m]))
  for (const [name, target] of Object.entries(LINKS)) {
    const member = byName.get(`workspace/room-a/${name}`)
    assert.ok(member, `link ${name} is in the archive`)
    assert.equal(member.type, '2', `${name} is stored as a symlink, not followed`)
    assert.equal(member.link, target)
  }
  assert.equal(byName.get('workspace/room-a/escaping')?.type, '2')
  // Nothing was read through a link: no copy of the outside folder, no second
  // copy of the file a link points to, no FIFO or socket entry.
  assert.ok(!listed.some((m) => m.name.includes('secret.txt') || m.name.startsWith('workspace/room-a/escaping/')))
  assert.ok(!listed.some((m) => m.name.startsWith('workspace/room-a/to-dir/')))
  assert.ok(!listed.some((m) => /pipe$|kernel\.sock$/.test(m.name)))

  const validated = run('validate', '--archive', s.archive)
  assert.equal(validated.status, 0, validated.out)
  const summary = JSON.parse(validated.stdout)
  assert.equal(summary.linkCount, Object.keys(LINKS).length + 1)
  assert.deepEqual(summary.skipped, { fifo: 1, socket: 1 })

  const dest = temp()
  const restored = run('restore', '--root', dest, '--release', s.release, '--archive', s.archive)
  assert.equal(restored.status, 0, restored.out)
  const room = path.join(dest, 'workspace/room-a')
  for (const [name, target] of Object.entries(LINKS)) {
    assert.ok(fs.lstatSync(path.join(room, name)).isSymbolicLink(), name)
    assert.equal(fs.readlinkSync(path.join(room, name)), target, name)
  }
  assert.equal(fs.readlinkSync(path.join(room, 'escaping')), path.relative(path.join(s.root, 'workspace/room-a'), outside))
  assert.equal(fs.readFileSync(path.join(room, 'file.txt'), 'utf8'), 'room data')
  assert.equal(fs.readFileSync(path.join(room, 'sub/inner.txt'), 'utf8'), 'inner')
  assert.equal(fs.existsSync(path.join(room, 'pipe')), false)
  assert.equal(fs.existsSync(path.join(room, 'kernel.sock')), false)
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt'], 'nothing was written outside the state')
})

test('device nodes are classified from lstat, and a tree deeper than the cap is skipped by name, not a crash', () => {
  // Device nodes need CAP_MKNOD, which no room has; the classification is
  // checked on the mode bits the walker reads with lstat.
  const kinds = spawnSync('python3', ['-c', `import importlib.util,stat,sys
s=importlib.util.spec_from_file_location('backup',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
print(m.kind_of(stat.S_IFCHR|0o600), m.kind_of(stat.S_IFBLK|0o600), m.kind_of(stat.S_IFIFO|0o600), m.kind_of(stat.S_IFSOCK|0o600))`, script], { encoding: 'utf8' })
  assert.equal(kinds.status, 0, kinds.stderr)
  assert.equal(kinds.stdout.trim(), 'device device fifo socket')
  // Every directory on the current path holds a descriptor; a student's
  // thousand nested folders must cost a warning, not the backup. The cap is
  // lowered here so the tree stays small.
  const s = seed()
  fs.mkdirSync(path.join(s.root, 'workspace/room-a/sub/x/y'), { recursive: true })
  fs.writeFileSync(path.join(s.root, 'workspace/room-a/sub/x/y/deep.txt'), 'deep')
  const deep = spawnSync('python3', ['-c', `import importlib.util,sys,types
s=importlib.util.spec_from_file_location('backup',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.MAX_DEPTH=3
m.backup(types.SimpleNamespace(root=sys.argv[2],release=sys.argv[3],output=sys.argv[4],mode='live',quiesced=False,name=''))`,
    script, s.root, s.release, s.archive], { encoding: 'utf8' })
  assert.equal(deep.status, 0, deep.stderr)
  assert.match(deep.stderr, new RegExp(`skipped a directory nested too deep: ${escape(path.join(s.root, 'workspace/room-a/sub/x'))}`))
  const names = members(s.archive).map((m) => m.name)
  assert.ok(names.includes('workspace/room-a/sub/inner.txt'))
  assert.ok(!names.some((n) => n.includes('deep.txt')))
  assert.equal(run('validate', '--archive', s.archive).status, 0)
})

test('unreadable files and folders are skipped with their path; the rest is backed up', { skip: process.getuid?.() === 0 && 'root reads mode 000' }, () => {
  const s = seed()
  const room = path.join(s.root, 'workspace/room-a')
  fs.writeFileSync(path.join(room, 'closed.txt'), 'nobody'); fs.chmodSync(path.join(room, 'closed.txt'), 0)
  fs.mkdirSync(path.join(room, 'closed-dir')); fs.writeFileSync(path.join(room, 'closed-dir/f'), 'x'); fs.chmodSync(path.join(room, 'closed-dir'), 0)
  try {
    const backed = run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'live')
    assert.equal(backed.status, 0, backed.out)
    assert.match(backed.out, new RegExp(`skipped an unreadable entry: ${escape(path.join(room, 'closed.txt'))}`))
    assert.match(backed.out, new RegExp(`skipped an unreadable entry: ${escape(path.join(room, 'closed-dir'))}`))
    const names = members(s.archive).map((m) => m.name)
    assert.ok(names.includes('workspace/room-a/file.txt'))
    assert.ok(!names.some((n) => n.includes('closed')))
    assert.equal(run('validate', '--archive', s.archive).status, 0)
  } finally {
    fs.chmodSync(path.join(room, 'closed.txt'), 0o600)
    fs.chmodSync(path.join(room, 'closed-dir'), 0o700)
  }
})

/** An archive built entry by entry, the way an attacker (or a bug) would. */
function craft(entries: string): string {
  const file = path.join(temp(), 'crafted.tar.gz')
  const made = spawnSync('python3', ['-c', `import tarfile,io,sys
t=tarfile.open(sys.argv[1],'w:gz')
def add(name, kind='file', link='', data=b'x'):
    m=tarfile.TarInfo(name)
    if kind=='dir': m.type=tarfile.DIRTYPE; t.addfile(m)
    elif kind=='sym': m.type=tarfile.SYMTYPE; m.linkname=link; t.addfile(m)
    elif kind=='hard': m.type=tarfile.LNKTYPE; m.linkname=link; t.addfile(m)
    elif kind=='fifo': m.type=tarfile.FIFOTYPE; t.addfile(m)
    else: m.size=len(data); t.addfile(m, io.BytesIO(data))
${entries}
t.close()`, file], { encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  return file
}

test('restore never writes outside its stage, whatever the archive says', () => {
  const outside = temp()
  const s = seed()
  const cases: [string, string, RegExp][] = [
    ['absolute name', `add('${outside}/evil')`, /unsafe archive path/],
    ['dot-dot', "add('workspace/../../evil')", /unsafe archive path/],
    ['unknown top level', "add('etc/passwd')", /unsafe archive path/],
    ['a link, then a file beneath it', `add('workspace','dir'); add('workspace/l','sym','${outside}'); add('workspace/l/evil')`, /through a link/],
    ['a relative escaping link, then a folder beneath it', "add('workspace','dir'); add('workspace/up','sym','../../../../..'); add('workspace/up/tmp','dir')", /through a link/],
    ['a file used as a folder', "add('workspace','dir'); add('workspace/f'); add('workspace/f/evil')", /through a link or into a file/],
    ['a hard link', "add('workspace','dir'); add('workspace/f'); add('workspace/h','hard','workspace/f')", /hard links and special files/],
    ['a FIFO', "add('workspace','dir'); add('workspace/p','fifo')", /hard links and special files/],
    ['a link where the manifest must be', "add('manifest.json','sym','/etc/passwd')", /link outside/],
    ['a link where the database must be', "add('data','dir'); add('data/colloq.db','sym','/etc/passwd')", /link outside/],
    ['a link as a whole tree', "add('workspace','sym','/')", /link outside/],
    ['a duplicate entry', "add('workspace','dir'); add('workspace/a'); add('workspace/a')", /duplicate archive path/],
  ]
  for (const [label, entries, reason] of cases) {
    const archive = craft(entries)
    const validated = run('validate', '--archive', archive)
    assert.notEqual(validated.status, 0, label)
    assert.match(validated.out, reason, label)
    const dest = temp()
    const restored = run('restore', '--root', dest, '--release', s.release, '--archive', archive)
    assert.notEqual(restored.status, 0, label)
    assert.deepEqual(fs.readdirSync(outside), [], `${label}: nothing may appear outside`)
    assert.deepEqual(fs.readdirSync(dest).filter((n) => !n.startsWith('.')), [], `${label}: the target stays untouched`)
  }
})

test('the backup refuses a copy that would not fit and stops itself before the disk fills', () => {
  const s = seed()
  fs.writeFileSync(path.join(s.root, 'workspace/room-a/big.bin'), Buffer.alloc(1024 * 1024, 7))
  const code = `import importlib.util,sys,types,shutil,collections,os,pathlib
s=importlib.util.spec_from_file_location('backup',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
root,release,out=sys.argv[2:5]
Usage=collections.namedtuple('Usage','total used free')
real=shutil.disk_usage
def args(o): return types.SimpleNamespace(root=root,release=release,output=o,mode='live',quiesced=False,name='')
# 1. The estimate alone does not fit: refused before anything is copied.
shutil.disk_usage=lambda p: Usage(10**12, 0, m.FREE_FLOOR + 1024)
try: m.backup(args(out)); raise AssertionError('estimate')
except ValueError as e: print('estimate:', e)
# 2. The estimate fits, the disk then runs low mid-copy: the guard stops it.
calls={'n':0}
def shrinking(p):
    calls['n']+=1
    return Usage(10**12, 0, 10**12 if calls['n']==1 else m.FREE_FLOOR - 1)
shutil.disk_usage=shrinking; m.SpaceGuard.STEP=1
try: m.backup(args(out)); raise AssertionError('guard')
except ValueError as e: print('guard:', e)
# 3. The consistent-backup preflight wants the copy and an archive as large.
shutil.disk_usage=lambda p: Usage(10**12, 0, m.FREE_FLOOR + 1536*1024)
try: m.preflight(types.SimpleNamespace(root=root,release=release,output=out,name='')); raise AssertionError('preflight')
except ValueError as e: print('preflight:', e)
shutil.disk_usage=real
print('left:', sorted(os.listdir(pathlib.Path(out).parent)))
`
  const r = spawnSync('python3', ['-c', code, script, s.root, s.release, s.archive], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /estimate: not enough free space for the backup/)
  assert.match(r.stdout, /guard: backup stopped before the disk filled/)
  assert.match(r.stdout, /preflight: not enough free space for a backup.*Nothing was stopped/)
  // No archive and no half-written stage left behind.
  assert.match(r.stdout, /left: \[\]/)
})

test('retention keeps the newest BACKUP_KEEP archives, never the fresh one, and nothing it did not name', () => {
  const dir = temp()
  const archives = ['colloq-20260101T000000Z-live.tar.gz', 'colloq-20260102T000000Z-consistent.tar.gz',
    'colloq-20260103T000000Z-live.tar.gz.age', 'colloq-20260104T000000Z-live.tar.gz']
  const strangers = ['notes.txt', 'colloq-manual.tar.gz', 'colloq-20250101T000000Z-live.tar.gz.partial']
  for (const name of [...archives, ...strangers]) fs.writeFileSync(path.join(dir, name), name)
  fs.symlinkSync(path.join(dir, 'notes.txt'), path.join(dir, 'colloq-20240101T000000Z-live.tar.gz'))
  fs.mkdirSync(path.join(dir, 'demo')); fs.writeFileSync(path.join(dir, 'demo/colloq-20200101T000000Z-live.tar.gz'), 'other env')
  const prune = (keep: number, fresh: string) => run('prune', '--directory', dir, '--keep', String(keep), '--fresh', path.join(dir, fresh))
  assert.equal(prune(2, archives[3]).status, 0)
  assert.deepEqual(fs.readdirSync(dir).sort(), [...strangers, archives[2], archives[3], 'colloq-20240101T000000Z-live.tar.gz', 'demo'].sort())
  assert.ok(fs.existsSync(path.join(dir, 'demo/colloq-20200101T000000Z-live.tar.gz')))
  // A clock that went backwards: the fresh archive sorts oldest and still stays.
  fs.writeFileSync(path.join(dir, 'colloq-20991231T235959Z-live.tar.gz'), 'future')
  fs.writeFileSync(path.join(dir, 'colloq-20250601T000000Z-live.tar.gz'), 'fresh')
  assert.equal(prune(1, 'colloq-20250601T000000Z-live.tar.gz').status, 0)
  const left = fs.readdirSync(dir).filter((n) => /^colloq-\d{8}T/.test(n)).sort()
  assert.deepEqual(left, ['colloq-20240101T000000Z-live.tar.gz', 'colloq-20250101T000000Z-live.tar.gz.partial',
    'colloq-20250601T000000Z-live.tar.gz', 'colloq-20991231T235959Z-live.tar.gz'])
  // 0 keeps every backup.
  fs.writeFileSync(path.join(dir, 'colloq-20000101T000000Z-live.tar.gz'), 'old')
  assert.equal(prune(0, 'colloq-20250601T000000Z-live.tar.gz').status, 0)
  assert.ok(fs.existsSync(path.join(dir, 'colloq-20000101T000000Z-live.tar.gz')))
})

/** A tools directory like a release bundle: the real scripts, a fake cluster.sh unless asked otherwise. */
function tools(root: string, withRealCluster = false): string {
  const dir = path.join(root, 'tools'); fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  for (const f of ['backup.sh', 'runtime-backup.py', 'state-lock.py', 'restore.sh', 'release.py', 'host.sh', 'lib.sh', ...(withRealCluster ? ['cluster.sh'] : [])]) {
    fs.copyFileSync(path.join(repo, 'scripts', f), path.join(dir, 'scripts', f))
  }
  fs.chmodSync(path.join(dir, 'scripts/backup.sh'), 0o755)
  if (!withRealCluster) fs.writeFileSync(path.join(dir, 'scripts/cluster.sh'), '#!/bin/bash\necho "$1" >> "$COLLOQ_STATE_DIR/lifecycle"\n')
  return dir
}

test('backup.sh writes 0600 archives into backups/ next to the tools, prunes to BACKUP_KEEP, and a consistent backup refuses before stopping', () => {
  const s = seed()
  const dir = tools(s.root)
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(backups, { mode: 0o700 })
  for (const stamp of ['20250101T000000Z', '20250102T000000Z', '20250103T000000Z']) fs.writeFileSync(path.join(backups, `colloq-${stamp}-live.tar.gz`), 'old')
  const env = { ...process.env, COLLOQ_STATE_DIR: s.root, RELEASE: s.release, NAME: '', BACKUP_KEEP: '2' }
  const live = spawnSync('bash', [path.join(dir, 'scripts/backup.sh')], { encoding: 'utf8', env: { ...env, MODE: 'live' } })
  assert.equal(live.status, 0, live.stdout + live.stderr)
  const kept = fs.readdirSync(backups).sort()
  assert.equal(kept.length, 2, kept.join(', '))
  assert.equal(kept[0], 'colloq-20250103T000000Z-live.tar.gz')
  assert.match(kept[1], /^colloq-\d{8}T\d{6}Z-live\.tar\.gz$/)
  assert.equal(fs.statSync(path.join(backups, kept[1])).mode & 0o777, 0o600)
  assert.equal(run('validate', '--archive', path.join(backups, kept[1])).status, 0)

  // Everything a consistent backup can refuse for, it refuses with the app running.
  fs.rmSync(path.join(s.root, 'data/colloq.db'))
  const refused = spawnSync('bash', [path.join(dir, 'scripts/backup.sh')], { encoding: 'utf8', env: { ...env, MODE: 'consistent', RESUME: '1' } })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /application database is missing/)
  assert.equal(fs.existsSync(path.join(s.root, 'lifecycle')), false, 'no writer may be stopped for a backup that cannot happen')

  // Asked to encrypt without age: refused before anything is stopped or written.
  database(path.join(s.root, 'data/colloq.db'))
  const python = spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim()
  const bare = [path.dirname(python), '/usr/bin', '/bin'].join(':')
  if (spawnSync('/bin/sh', ['-c', 'command -v age'], { encoding: 'utf8', env: { PATH: bare } }).stdout.trim() === '') {
    const before = fs.readdirSync(backups).length
    const noAge = spawnSync('bash', [path.join(dir, 'scripts/backup.sh')], { encoding: 'utf8',
      env: { ...env, MODE: 'consistent', PATH: bare, BACKUP_AGE_RECIPIENT: 'age1example' } })
    assert.notEqual(noAge.status, 0)
    assert.match(noAge.stderr, /age is not installed/)
    assert.equal(fs.readdirSync(backups).length, before)
    assert.equal(fs.existsSync(path.join(s.root, 'lifecycle')), false)
  }
})

/** A stand-in for age: "encrypts" with a header line, "decrypts" by removing it, and insists on an identity. */
const FAKE_AGE = `#!/bin/sh
mode=enc; out=; in=; identity=
while [ $# -gt 0 ]; do
  case "$1" in -d) mode=dec; shift;; -i) identity="$2"; shift 2;; -r|-R) shift 2;; -o) out="$2"; shift 2;; *) in="$1"; shift;; esac
done
if [ "$mode" = enc ]; then { printf 'AGE-TEST\\n'; cat "$in"; } > "$out"; exit 0; fi
[ -f "$identity" ] || { echo "no identity" >&2; exit 1; }
head -1 "$in" | grep -q '^AGE-TEST$' || { echo "not ours" >&2; exit 1; }
tail -n +2 "$in" > "$out"
`

test('with BACKUP_AGE_RECIPIENT the archive is encrypted, the plaintext removed, and restore.sh decrypts it', () => {
  const s = seed()
  const dir = tools(s.root)
  const bin = path.join(s.root, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'age'), FAKE_AGE, { mode: 0o755 })
  const env = { ...process.env, COLLOQ_STATE_DIR: s.root, RELEASE: s.release, NAME: '', PATH: `${bin}:${process.env.PATH}` }
  const backed = spawnSync('bash', [path.join(dir, 'scripts/backup.sh')], { encoding: 'utf8', env: { ...env, MODE: 'live', BACKUP_AGE_RECIPIENT: 'age1example' } })
  assert.equal(backed.status, 0, backed.stdout + backed.stderr)
  const names = fs.readdirSync(path.join(dir, 'backups'))
  assert.equal(names.length, 1)
  assert.match(names[0], /^colloq-\d{8}T\d{6}Z-live\.tar\.gz\.age$/)
  const encrypted = path.join(dir, 'backups', names[0])
  assert.equal(fs.statSync(encrypted).mode & 0o777, 0o600)

  const target = temp()
  const identity = path.join(s.root, 'identity.txt'); fs.writeFileSync(identity, 'AGE-SECRET-KEY-TEST')
  const restoreEnv = { ...env, COLLOQ_STATE_DIR: target }
  const command = ['bash', path.join(dir, 'scripts/restore.sh'), '--archive', encrypted, '--release', s.release]
  const without = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: restoreEnv })
  assert.notEqual(without.status, 0)
  assert.match(without.stderr, /BACKUP_AGE_IDENTITY/)
  assert.equal(fs.existsSync(path.join(target, 'lifecycle')), false, 'a backup that cannot be opened stops nothing')
  const restored = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: { ...restoreEnv, BACKUP_AGE_IDENTITY: identity } })
  assert.equal(restored.status, 0, restored.stdout + restored.stderr)
  assert.equal(fs.readFileSync(path.join(target, 'workspace/room-a/file.txt'), 'utf8'), 'room data')
  assert.equal(fs.readdirSync(target).filter((n) => n.startsWith('.restore-plain')).length, 0, 'the plaintext copy is removed')
})

test('a database stamped by newer code is refused under an older release, before anything moves', () => {
  const older = path.join(temp(), 'older.json'); fs.writeFileSync(older, JSON.stringify(release([1, 2])))
  // A rollback forced past the manifest check leaves exactly this: the
  // installed release (and so the backup's manifest) says schema 1, while
  // newer code has already stamped the database with 3. The manifest-level
  // check passes; the stamp is the one that cannot be out of date.
  const forced = seed(3, [1])
  assert.equal(run('backup', '--root', forced.root, '--release', forced.release, '--output', forced.archive, '--mode', 'live').status, 0)
  const validated = run('validate', '--archive', forced.archive, '--release', older)
  assert.notEqual(validated.status, 0)
  assert.match(validated.out, /incompatible with this backup: its database is at data schema 3/)
  const dest = temp(); fs.mkdirSync(path.join(dest, 'data')); fs.writeFileSync(path.join(dest, 'data/old'), 'old')
  const restored = run('restore', '--root', dest, '--release', older, '--archive', forced.archive, '--replace')
  assert.notEqual(restored.status, 0)
  assert.match(restored.out, /incompatible/)
  assert.equal(fs.readFileSync(path.join(dest, 'data/old'), 'utf8'), 'old')
  // The same rule for the installed data, which cluster.sh asks before an update.
  const checked = run('check-schema', '--root', forced.root, '--release', older)
  assert.notEqual(checked.status, 0)
  assert.match(checked.out, /data schema 3/)
  const newer = path.join(temp(), 'newer.json'); fs.writeFileSync(newer, JSON.stringify(release([1, 2, 3])))
  assert.equal(run('check-schema', '--root', forced.root, '--release', newer).status, 0)
  // A database from before the stamp existed (user_version 0) counts as 1.
  const legacy = seed(0, [1])
  assert.equal(run('backup', '--root', legacy.root, '--release', legacy.release, '--output', legacy.archive, '--mode', 'live').status, 0)
  assert.equal(run('validate', '--archive', legacy.archive, '--release', legacy.release).status, 0)
  assert.equal(run('check-schema', '--root', legacy.root, '--release', legacy.release).status, 0)
})

/** cluster.sh on a pretend VM: uname/id say Linux/root, k3s records every call and keeps the replica count. */
function vm(dropDatabaseOnStop: boolean) {
  const s = seed()
  const state = s.root
  const bundle = tools(temp(), true)
  const backups = path.join(bundle, 'backups')
  const hashes: Record<string, string> = {}
  for (const f of ['cluster.sh', 'release.py', 'state-lock.py', 'backup.sh', 'runtime-backup.py', 'restore.sh', 'host.sh', 'lib.sh']) {
    hashes[`scripts/${f}`] = createHash('sha256').update(fs.readFileSync(path.join(bundle, 'scripts', f))).digest('hex')
  }
  const next = path.join(bundle, 'release.json')
  fs.writeFileSync(next, JSON.stringify({ ...release(), version: 'v2', catalog: { ...release().catalog, release: 'v2' }, tooling: { sourceFiles: hashes } }))
  fs.mkdirSync(path.join(state, 'releases'))
  fs.writeFileSync(path.join(state, 'releases/current.json'), JSON.stringify(release()))
  const bin = path.join(state, 'bin'); fs.mkdirSync(bin)
  const k3s = `#!/bin/sh
printf '%s\\n' "$*" >> "$COLLOQ_STATE_DIR/k3s-calls"
case "$*" in
  --version) echo "k3s version v1.34.1+k3s1 (fake)";;
  *"create -f -"*) cat >/dev/null;;
  *"jsonpath={.spec.replicas}"*) cat "$COLLOQ_STATE_DIR/replicas" 2>/dev/null || echo 1;;
  *"scale deployment/colloq-app deployment/colloq-runtime --replicas=0"*)
    echo 0 > "$COLLOQ_STATE_DIR/replicas"
    ${dropDatabaseOnStop ? 'rm -f "$COLLOQ_STATE_DIR/data/colloq.db"' : ':'};;
  *"scale deployment/colloq-app --replicas=1"*) echo 1 > "$COLLOQ_STATE_DIR/replicas";;
esac
exit 0
`
  for (const [name, body] of Object.entries({ uname: 'echo Linux', id: 'echo 0', curl: 'exit 0', chown: 'exit 0', systemctl: 'exit 1', k3s: null })) {
    fs.writeFileSync(path.join(bin, name), body === null ? k3s : `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  const update = () => spawnSync('bash', [path.join(bundle, 'scripts/cluster.sh'), 'update', '--release', next], { encoding: 'utf8',
    env: { ...process.env, COLLOQ_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` } })
  const calls = () => fs.existsSync(path.join(state, 'k3s-calls')) ? fs.readFileSync(path.join(state, 'k3s-calls'), 'utf8').split('\n').filter(Boolean) : []
  return { state, backups, update, calls }
}

test('update pulls the images and takes its backup preflight before it stops anything', () => {
  const machine = vm(false)
  const r = machine.update()
  const calls = machine.calls()
  const pulled = calls.findIndex((c) => c.includes('create -f -'))
  const stopped = calls.findIndex((c) => c.includes('scale deployment/colloq-app deployment/colloq-runtime --replicas=0'))
  assert.ok(pulled >= 0, calls.join('\n'))
  assert.ok(stopped > pulled, 'images are pulled while the classes still run:\n' + calls.join('\n'))
  const archives = fs.readdirSync(machine.backups)
  assert.equal(archives.length, 1)
  assert.match(archives[0], /-consistent\.tar\.gz$/)
  // A pretend VM has no /etc/rancher/k3s/colloq-managed, so prepare stops
  // there; everything this test is about happened before it.
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /not Colloq-managed/)
  assert.equal(fs.readdirSync(path.join(machine.state, 'releases')).filter((n) => n.startsWith('.pulled')).length, 0)
})

test('an update whose backup cannot happen stops nothing, and one whose backup fails after the stop brings the classes back', () => {
  const refused = vm(false)
  fs.rmSync(path.join(refused.state, 'data/colloq.db'))
  let r = refused.update()
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /application database is missing/)
  assert.match(r.stderr, /aborted before any change/)
  assert.ok(!refused.calls().some((c) => c.includes('scale')), refused.calls().join('\n'))

  const failed = vm(true)
  r = failed.update()
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /starting the installed release again/)
  assert.match(r.stderr, /aborted before any change/)
  const calls = failed.calls()
  const stopped = calls.findIndex((c) => c.includes('--replicas=0'))
  const started = calls.findIndex((c) => c.includes('scale deployment/colloq-app --replicas=1'))
  assert.ok(stopped >= 0 && started > stopped, calls.join('\n'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(failed.state, 'releases/current.json'), 'utf8')).version, 'v1', 'the installed release is unchanged')
})

test('update refuses a release that does not list the schema stamped in the database, before any cluster call', () => {
  const machine = vm(false)
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("pragma user_version=2"); c.commit()', path.join(machine.state, 'data/colloq.db')])
  const r = machine.update()
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /data schema 2/)
  assert.match(r.stderr, /refused before stopping anything/)
  assert.deepEqual(machine.calls(), [])
})
