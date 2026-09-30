/**
 * The database carries the data schema of the code that last opened it.
 *
 * dataSchemaVersion used to be a literal 1 in every release while destructive
 * migrations shipped (competitions/store.ts · liftEntrantKeys), so the
 * rollback check compared 1 with 1 and could never refuse. Now the number is
 * one constant (server/src/data-schema.ts), stamped into colloq.db as
 * PRAGMA user_version before any migration runs, read by release-build.py
 * (tests/release-source.test.mts) and checked by the backup tools
 * (tests/portable-backup-robustness.test.mts).
 *
 * db.ts opens the database on import, so each case runs in its own process
 * with its own data directory.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ALLOW_SCHEMA_DOWNGRADE, DATA_SCHEMA_VERSION } from '../server/src/data-schema.ts'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dirs: string[] = []
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

function instance(userVersion?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-schema-'))
  dirs.push(root)
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 })
  fs.mkdirSync(path.join(root, 'workspace'))
  if (userVersion !== undefined) {
    // A database as an earlier release left it: its own tables, a row, and
    // whatever stamp that code wrote (none at all before this change).
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('create table sessions (id text primary key, name text not null, created_at integer not null)')
c.execute("insert into sessions values ('s1','kept',1)"); c.execute('pragma user_version=${userVersion}'); c.commit(); c.close()`,
      path.join(root, 'data/colloq.db')])
  }
  return root
}

function open(root: string, env: Record<string, string> = {}) {
  const probe = path.join(root, 'probe.mts')
  fs.writeFileSync(probe, `const { db } = await import(${JSON.stringify(path.join(repo, 'server/src/db.ts'))})
console.log('stamp=' + db.pragma('user_version', { simple: true }))
console.log('rows=' + db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n)
process.exit(0)
`)
  const r = spawnSync(process.execPath, ['--import', 'tsx', probe], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DATA_DIR: path.join(root, 'data'), WORKSPACE_DIR: path.join(root, 'workspace'),
      SESSION_SECRET: 'test-secret-not-random-on-purpose', [ALLOW_SCHEMA_DOWNGRADE]: '', ...env },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

function stampOf(root: string): number {
  return Number(execFileSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("pragma user_version").fetchone()[0])',
    path.join(root, 'data/colloq.db')], { encoding: 'utf8' }).trim())
}

test('the constant is a positive integer that release-build.py can read', () => {
  assert.ok(Number.isInteger(DATA_SCHEMA_VERSION) && DATA_SCHEMA_VERSION >= 1)
  const source = fs.readFileSync(path.join(repo, 'server/src/data-schema.ts'), 'utf8')
  assert.equal(source.match(/^export const DATA_SCHEMA_VERSION = (\d+)\s*$/gm)?.length, 1)
})

test('a new database and one from before the stamp both open and carry the current schema', () => {
  const fresh = instance()
  let r = open(fresh)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, new RegExp(`stamp=${DATA_SCHEMA_VERSION}\\b`))
  const legacy = instance(0)
  r = open(legacy)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, new RegExp(`stamp=${DATA_SCHEMA_VERSION}\\b`))
  assert.match(r.out, /rows=1/)
  assert.equal(stampOf(legacy), DATA_SCHEMA_VERSION)
})

test('a database stamped by newer code is refused, and opens only with the explicit override, keeping its stamp', () => {
  const newer = DATA_SCHEMA_VERSION + 1
  const root = instance(newer)
  const refused = open(root)
  assert.notEqual(refused.status, 0)
  assert.match(refused.out, new RegExp(`data schema ${newer}, while this release knows ${DATA_SCHEMA_VERSION}`))
  assert.match(refused.out, new RegExp(ALLOW_SCHEMA_DOWNGRADE))
  assert.equal(stampOf(root), newer, 'a refusal changes nothing')
  const forced = open(root, { [ALLOW_SCHEMA_DOWNGRADE]: '1' })
  assert.equal(forced.status, 0, forced.out)
  assert.match(forced.out, /WARNING/)
  assert.match(forced.out, /rows=1/)
  assert.equal(stampOf(root), newer, 'the stamp is never lowered')
})
