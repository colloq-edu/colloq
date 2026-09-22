import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dirs: string[] = []
after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-portable-')); dirs.push(dir); return dir }
function run(...args: string[]) { const r = spawnSync('python3', [path.join(repo, 'scripts/runtime-backup.py'), ...args], { encoding: 'utf8' }); return { status: r.status, out: r.stdout + r.stderr } }
function seed() {
  const root = temp(); fs.mkdirSync(path.join(root, 'data')); fs.mkdirSync(path.join(root, 'workspace/room-a'), { recursive: true })
  const sql = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table note(value text)"); c.execute("insert into note values (\'kept\')"); c.commit()', path.join(root, 'data/colloq.db')]); assert.equal(sql.status, 0)
  fs.writeFileSync(path.join(root, 'workspace/room-a/file.txt'), 'room data')
  fs.writeFileSync(path.join(root, 'workspace/room-a/run.sh'), '#!/bin/sh\ntrue\n', { mode: 0o700 })
  fs.writeFileSync(path.join(root, 'data/session-secret'), 'test-key', { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'config.env'), 'OPENAI_API_KEY=test-secret\n', { mode: 0o600 })
  fs.mkdirSync(path.join(root, 'secrets')); fs.writeFileSync(path.join(root, 'secrets/room-secret'), 'persistent-room-identity', { mode: 0o600 })
  const release = path.join(root, 'release.json'); fs.writeFileSync(release, JSON.stringify({ schemaVersion: 1, version: '1.0.0', dataSchemaVersion: 1, compatibleDataSchemaVersions: [1], catalog: { schemaVersion: 1, release: '1.0.0', environments: [] } }))
  return { root, release, archive: path.join(temp(), 'colloq-test.tar.gz') }
}
test('portable live backup roundtrips data, secret, catalog and declares non-atomic files', () => {
  const s = seed()
  const preserved = {
    'data/competitions/c-one/secret/solution.csv': Buffer.from('target\n1\n'),
    'data/dependencies/artifacts/test-sha256': Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]),
    'data/dependencies/bundles/bundle-one/wheels/demo-1.0-py3-none-any.whl': Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]),
    'data/dependencies/bundles/bundle-one/requirements.lock': Buffer.from('demo==1.0 --hash=sha256:test-sha256\n'),
    'data/dependencies/bundles/bundle-one/manifest.json': Buffer.from('{"packages":[{"sha256":"test-sha256"}]}'),
  }
  for (const [file, content] of Object.entries(preserved)) {
    fs.mkdirSync(path.dirname(path.join(s.root, file)), { recursive: true })
    fs.writeFileSync(path.join(s.root, file), content)
  }
  const b = run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'live', '--name', 'class-a'); assert.equal(b.status, 0, b.out)
  const v = run('validate', '--archive', s.archive, '--name', 'class-a'); assert.equal(v.status, 0, v.out); assert.match(v.out, /live/)
  const dest = temp(); const r = run('restore', '--root', dest, '--release', s.release, '--archive', s.archive, '--name', 'class-a'); assert.equal(r.status, 0, r.out)
  for (const [file, content] of Object.entries(preserved)) assert.deepEqual(fs.readFileSync(path.join(dest, file)), content, file)
  assert.equal(fs.readFileSync(path.join(dest, 'workspace/room-a/file.txt'), 'utf8'), 'room data')
  assert.equal(fs.statSync(path.join(dest, 'workspace/room-a/run.sh')).mode & 0o700, 0o700)
  assert.equal(fs.readFileSync(path.join(dest, 'data/session-secret'), 'utf8'), 'test-key')
  assert.equal(fs.statSync(path.join(dest, 'data/session-secret')).mode & 0o777, 0o600)
  assert.ok(fs.existsSync(path.join(dest, 'recovery/catalog.json')))
  assert.equal(fs.readFileSync(path.join(dest, 'config.env'), 'utf8'), 'OPENAI_API_KEY=test-secret\n')
  assert.equal(fs.readFileSync(path.join(dest, 'secrets/room-secret'), 'utf8'), 'persistent-room-identity')
})
test('portable backup rejects symlinks and consistent mode without stopped-writer assertion', () => {
  const s = seed(); let r = run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'consistent'); assert.notEqual(r.status, 0); assert.match(r.out, /quiesc/)
  fs.symlinkSync('/etc/passwd', path.join(s.root, 'workspace/room-a/link'))
  r = run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'live'); assert.notEqual(r.status, 0); assert.match(r.out, /symlink/)
})
test('restore refuses wrong environment, corrupt checksum, and existing data without replace', () => {
  const s = seed(); assert.equal(run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'live', '--name', 'class-a').status, 0)
  assert.match(run('validate', '--archive', s.archive, '--name', 'class-b').out, /environment/)
  const d = temp(); fs.mkdirSync(path.join(d, 'workspace')); fs.writeFileSync(path.join(d, 'workspace/old'), 'old')
  const r = run('restore', '--root', d, '--release', s.release, '--archive', s.archive, '--name', 'class-a'); assert.notEqual(r.status, 0); assert.equal(fs.readFileSync(path.join(d, 'workspace/old'), 'utf8'), 'old')
  const tamper = spawnSync('python3', ['-c', 'import tarfile,io,sys; p=sys.argv[1]; src=tarfile.open(p); members=[(m,src.extractfile(m).read() if m.isfile() else None) for m in src]; src.close(); out=tarfile.open(p,"w:gz");\nfor m,b in members:\n if m.name=="workspace/room-a/file.txt": b=b"tampered"; m.size=len(b)\n out.addfile(m,io.BytesIO(b) if b is not None else None)\nout.close()', s.archive]); assert.equal(tamper.status, 0)
  const bad = run('validate', '--archive', s.archive, '--name', 'class-a'); assert.notEqual(bad.status, 0); assert.match(bad.out, /checksum/)
})
test('explicit restore replacement preserves previous entire data trees for rollback', () => {
  const s = seed(); assert.equal(run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'live').status, 0)
  const d = temp(); fs.mkdirSync(path.join(d, 'data')); fs.mkdirSync(path.join(d, 'workspace')); fs.writeFileSync(path.join(d, 'data/old'), 'prior'); fs.writeFileSync(path.join(d, 'workspace/stale'), 'stale')
  const r = run('restore', '--root', d, '--release', s.release, '--archive', s.archive, '--replace'); assert.equal(r.status, 0, r.out)
  assert.ok(!fs.existsSync(path.join(d, 'workspace/stale')))
  const old = fs.readdirSync(d).find(n => n.startsWith('replaced-')); assert.ok(old); assert.equal(fs.readFileSync(path.join(d, old, 'workspace/stale'), 'utf8'), 'stale')
})
test('workspace manifest.json files are also checksum-covered', () => {
  const s = seed(); fs.writeFileSync(path.join(s.root, 'workspace/room-a/manifest.json'), 'user file')
  assert.equal(run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'live').status, 0)
  const r = run('validate', '--archive', s.archive); assert.equal(r.status, 0, r.out)
})
test('consistent shell backup stops all writers and resumes only when explicitly requested', () => {
  const s = seed(); fs.mkdirSync(path.join(s.root, 'scripts'))
  for (const f of ['backup.sh', 'runtime-backup.py', 'state-lock.py']) fs.copyFileSync(path.join(repo, 'scripts', f), path.join(s.root, 'scripts', f))
  fs.writeFileSync(path.join(s.root, 'scripts/cluster.sh'), '#!/bin/bash\necho "$1" >> "$COLLOQ_STATE_DIR/lifecycle"\n')
  const result = spawnSync('bash', ['scripts/backup.sh'], { cwd: s.root, encoding: 'utf8', env: { ...process.env, COLLOQ_STATE_DIR: s.root, RELEASE: s.release, OUT: s.archive, MODE: 'consistent', RESUME: '1', NAME: '' } })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(fs.readFileSync(path.join(s.root, 'lifecycle'), 'utf8'), 'stop\nstart\n')
  assert.match(run('validate', '--archive', s.archive).out, /stopped-writers/)
})
test('a failed stop prevents consistent backup creation and does not restart writers', () => {
  const s = seed(); fs.mkdirSync(path.join(s.root, 'scripts'))
  for (const f of ['backup.sh', 'runtime-backup.py', 'state-lock.py']) fs.copyFileSync(path.join(repo, 'scripts', f), path.join(s.root, 'scripts', f))
  fs.writeFileSync(path.join(s.root, 'scripts/cluster.sh'), '#!/bin/bash\necho "$1" >> "$COLLOQ_STATE_DIR/lifecycle"\nexit 55\n')
  const result = spawnSync('bash', ['scripts/backup.sh'], { cwd: s.root, encoding: 'utf8', env: { ...process.env, COLLOQ_STATE_DIR: s.root, RELEASE: s.release, OUT: s.archive, MODE: 'consistent', RESUME: '1', NAME: '' } })
  assert.equal(result.status, 55)
  assert.equal(fs.readFileSync(path.join(s.root, 'lifecycle'), 'utf8'), 'stop\n')
  assert.ok(!fs.existsSync(s.archive))
  assert.ok(!fs.existsSync(path.join(s.root, '.recovery-lock')))
})
test('incompatible restore and archive traversal do not alter the target', () => {
  const s = seed(); assert.equal(run('backup', '--root', s.root, '--release', s.release, '--output', s.archive, '--mode', 'live').status, 0)
  const dest = temp(); fs.mkdirSync(path.join(dest, 'data')); fs.writeFileSync(path.join(dest, 'data/old'), 'old')
  const selected = JSON.parse(fs.readFileSync(s.release, 'utf8')); selected.compatibleDataSchemaVersions = [2]; fs.writeFileSync(s.release, JSON.stringify(selected))
  const compatibility = run('validate', '--archive', s.archive, '--release', s.release); assert.notEqual(compatibility.status, 0); assert.match(compatibility.out, /incompatible/)
  const bad = run('restore', '--root', dest, '--archive', s.archive, '--release', s.release, '--replace'); assert.notEqual(bad.status, 0); assert.match(bad.out, /incompatible/); assert.equal(fs.readFileSync(path.join(dest, 'data/old'), 'utf8'), 'old')
  const evil = path.join(temp(), 'evil.tar.gz'); const made = spawnSync('python3', ['-c', 'import tarfile,io,sys; t=tarfile.open(sys.argv[1],"w:gz"); m=tarfile.TarInfo("../escaped"); m.size=3; t.addfile(m,io.BytesIO(b"bad")); t.close()', evil]); assert.equal(made.status, 0)
  const v = run('validate', '--archive', evil); assert.notEqual(v.status, 0); assert.match(v.out, /unsafe archive path/)
})
