/**
 * A competition's open files and hidden test carry the sha256 of their bytes:
 * the content address by which a machine that runs submissions for this
 * server will ask for them, keep them, and know a replaced file from the one
 * it holds.
 *
 * What breaks quietly here. A hash that names bytes no longer on disk sends
 * every machine a file that fails its check, forever. A hash learned about an
 * unchanged file that bumps the competition's input revision makes the sample
 * notebook's check stale, and the teacher runs it again for nothing. A hash on
 * the answers is a row that something may one day hand out by hash.
 */
import './_env.mts'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { app } from '../server/src/app.js'
import { db } from '../server/src/db.js'
import {
  competitionFileHashes,
  competitionTriggers,
  createCompetition,
  getCompetition,
  putFile,
} from '../server/src/competitions/store.js'
import {
  composeRunInputs,
  dropAttempt,
  openDir,
  openFileSha256,
  putOpenFile,
  putSealedFile,
  putSecretFile,
  sealedFileSha256,
} from '../server/src/competitions/storage.js'
import { letContainerRead } from '../server/src/competitions/runner.js'
import { cachedSha256 } from '../server/src/dependencies/files.js'
import type { Competition } from '../shared/competitions.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const enc = (text: string) => new TextEncoder().encode(text)

let base = ''
let server: http.Server
let cookie = ''

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const teacher = createTeacher({ name: 'Преподаватель', email: 'hashes.teacher@example.edu', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  cookie = `${STAFF_COOKIE}=${value}`
})
after(() => server?.close())

let seq = 0
function competition(): Competition {
  const made = createCompetition({ slug: `hashes-${++seq}`, title: `Hashes ${seq}` })
  assert.ok(made)
  return made
}

/** The row as the table holds it, hash included. */
const row = (c: Competition, visibility: string, name: string) =>
  db.prepare('SELECT * FROM competition_files WHERE competition_id = ? AND visibility = ? AND name = ?').get(c.id, visibility, name) as
    | { bytes: number; uploaded_at: number; sha256: string | null }
    | undefined

/** The three counters a file change moves, read straight from the row. */
const revisions = (c: Competition) => {
  const fresh = getCompetition(c.id)!
  return { revision: fresh.revision, input: fresh.inputRevision, notebook: fresh.notebookInputRevision }
}

function upload(route: string, files: { name: string; body: string }[]) {
  const form = new FormData()
  for (const file of files) form.append('file', new Blob([file.body]), file.name)
  return fetch(`${base}${route}`, { method: 'POST', headers: { cookie }, body: form })
}

test('an upload keeps the sha256 of the bytes it wrote, for the open data and the hidden test, and none for the answers', async () => {
  const c = competition()
  assert.equal((await upload(`/api/admin/competitions/${c.id}/files`, [{ name: 'train.csv', body: 'id,target\n1,0\n2,1\n' }])).status, 200)
  assert.equal((await upload(`/api/admin/competitions/${c.id}/sealed`, [{ name: 'test.csv', body: 'id\n101\n102\n' }])).status, 200)
  assert.equal((await upload(`/api/admin/competitions/${c.id}/solution`, [{ name: 'answers.csv', body: 'id,target\n101,1\n102,0\n' }])).status, 200)
  assert.equal(row(c, 'open', 'train.csv')?.sha256, sha('id,target\n1,0\n2,1\n'))
  assert.equal(row(c, 'sealed', 'test.csv')?.sha256, sha('id\n101\n102\n'))
  assert.equal(row(c, 'hidden', 'solution.csv')?.sha256, null, 'the answers are never addressed by hash')
  // The stored file is the one hashed.
  assert.equal(sha(fs.readFileSync(path.join(openDir(c.id), 'train.csv'), 'utf8')), row(c, 'open', 'train.csv')?.sha256)
})

/*
 * The data changes only by a new inode renamed over its name, and every run
 * here moves its ctime with nothing changed: the hard links a hidden-test run
 * makes and drops, the mode a container needs. Keyed by ctime, each such run
 * made the next hash of every data file read it whole again — up to two
 * hundred megabytes each, the files the machines fetch by hash.
 */
test('a data file that only gained links and a mode is not read again; one renamed over is, and wheels never push the data out', async () => {
  const c = competition()
  putOpenFile(c.id, 'train.csv', enc('id,target\n1,0\n'))
  putSealedFile(c.id, 'test.csv', enc('id\n101\n'))
  let reads = 0
  const createReadStream = fs.createReadStream
  fs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => { reads++; return createReadStream(...args) }) as typeof fs.createReadStream
  try {
    assert.equal((await openFileSha256(c.id, 'train.csv'))?.sha256, sha('id,target\n1,0\n'))
    assert.equal((await sealedFileSha256(c.id, 'test.csv'))?.sha256, sha('id\n101\n'))
    assert.equal(reads, 2)
    // Runs on the hidden test here: both files linked into each run's data folder, given a mode, unlinked when it goes.
    for (let run = 0; run < 3; run++) {
      const inputs = await composeRunInputs(c.id, `s${run}`, `a${run}`, { open: ['train.csv'], sealed: ['test.csv'] })
      letContainerRead(inputs)
      letContainerRead(openDir(c.id))
      dropAttempt(c.id, `s${run}`, `a${run}`)
      assert.equal((await openFileSha256(c.id, 'train.csv'))?.sha256, sha('id,target\n1,0\n'))
      assert.equal((await sealedFileSha256(c.id, 'test.csv'))?.sha256, sha('id\n101\n'))
    }
    assert.equal(reads, 2, 'the bytes did not change, and no file was read again')
    // A few thousand wheels hashed meanwhile keep to a cache of their own.
    for (let i = 0; i < 4100; i++) {
      await cachedSha256(`/wheels/w-${i}.whl`, { size: i, mtimeMs: 1, ctimeMs: 1, ino: i, dev: 1 } as unknown as fs.Stats, async function* () { yield 'w' })
    }
    await openFileSha256(c.id, 'train.csv')
    assert.equal(reads, 2, 'the data\'s digests were not pushed out')
    // New bytes are a new inode renamed over the name: read again.
    putOpenFile(c.id, 'train.csv', enc('id,target\n1,1\n'))
    assert.equal((await openFileSha256(c.id, 'train.csv'))?.sha256, sha('id,target\n1,1\n'))
    assert.equal(reads, 3)
  } finally {
    fs.createReadStream = createReadStream
  }
})

test('a put returns the size and the hash of what it wrote', () => {
  const c = competition()
  assert.deepEqual(putOpenFile(c.id, 'a.csv', enc('a\n1\n')), { bytes: 4, sha256: sha('a\n1\n') })
  assert.deepEqual(putSealedFile(c.id, 'a.csv', enc('a\n2\n')), { bytes: 4, sha256: sha('a\n2\n') })
})

test('a re-upload carries its own hash, the same bytes again keep theirs, and the answers keep none even when handed one', () => {
  const c = competition()
  const first = putOpenFile(c.id, 'train.csv', enc('id\n1\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: first.bytes, visibility: 'open', sha256: first.sha256 })
  const second = putOpenFile(c.id, 'train.csv', enc('id\n2\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: second.bytes, visibility: 'open', sha256: second.sha256 })
  assert.equal(row(c, 'open', 'train.csv')?.sha256, sha('id\n2\n'))
  // The same bytes once more: the hash the upload brings is the one that stays.
  const again = putOpenFile(c.id, 'train.csv', enc('id\n2\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: again.bytes, visibility: 'open', sha256: again.sha256 })
  assert.equal(row(c, 'open', 'train.csv')?.sha256, sha('id\n2\n'))
  putSecretFile(c.id, 'solution.csv', enc('id,target\n1,1\n'))
  putFile({ competitionId: c.id, name: 'solution.csv', bytes: 14, visibility: 'hidden', sha256: sha('id,target\n1,1\n') })
  assert.equal(row(c, 'hidden', 'solution.csv')?.sha256, null)
  putFile({ competitionId: c.id, name: 'b.csv', bytes: 1, visibility: 'open', sha256: 'not a hash' })
  assert.equal(row(c, 'open', 'b.csv')?.sha256, null, 'only a sha256 is kept as one')
})

test("an older server's re-upload forgets the hash of the bytes it replaced", () => {
  const c = competition()
  const stored = putOpenFile(c.id, 'train.csv', enc('id\n1\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
  // 0.22's upsert, word for word: it knows nothing of the hash.
  putOpenFile(c.id, 'train.csv', enc('id\n1\n2\n'))
  db.prepare(`
    INSERT INTO competition_files (competition_id, name, bytes, row_count, visibility, uploaded_at)
    VALUES (@competition_id, @name, @bytes, @row_count, @visibility, @uploaded_at)
    ON CONFLICT(competition_id, visibility, name) DO UPDATE SET
      bytes = excluded.bytes, row_count = excluded.row_count, uploaded_at = excluded.uploaded_at
  `).run({ competition_id: c.id, name: 'train.csv', bytes: 7, row_count: 2, visibility: 'open', uploaded_at: Date.now() + 1 })
  assert.equal(row(c, 'open', 'train.csv')?.sha256, null, 'a hash naming the bytes that are gone was kept')
})

test('a row from before the hash gets one from the disk, once, and learning it bumps no revision', async () => {
  const c = competition()
  // Rows as an older server wrote them: the size, no hash.
  const train = putOpenFile(c.id, 'train.csv', enc('id,target\n1,0\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: train.bytes, visibility: 'open' })
  const test = putSealedFile(c.id, 'test.csv', enc('id\n9\n'))
  putFile({ competitionId: c.id, name: 'test.csv', bytes: test.bytes, visibility: 'sealed' })
  assert.equal(row(c, 'open', 'train.csv')?.sha256, null)
  const before = revisions(c)
  assert.deepEqual(await competitionFileHashes(c.id, 'open'), [{ name: 'train.csv', bytes: 14, sha256: sha('id,target\n1,0\n') }])
  assert.deepEqual(await competitionFileHashes(c.id, 'sealed'), [{ name: 'test.csv', bytes: 5, sha256: sha('id\n9\n') }])
  assert.equal(row(c, 'open', 'train.csv')?.sha256, sha('id,target\n1,0\n'), 'the hash is written into the row')
  assert.deepEqual(revisions(c), before, "a fact about unchanged bytes made the sample notebook's check stale")
  // Once: the next ask reads the row, not the disk.
  fs.rmSync(path.join(openDir(c.id), 'train.csv'))
  assert.equal((await competitionFileHashes(c.id, 'open'))[0]?.sha256, sha('id,target\n1,0\n'))
})

test('a file the disk does not hold as its row says gets no hash', async () => {
  const c = competition()
  putOpenFile(c.id, 'short.csv', enc('id\n1\n'))
  putFile({ competitionId: c.id, name: 'short.csv', bytes: 999, visibility: 'open' })
  putFile({ competitionId: c.id, name: 'gone.csv', bytes: 3, visibility: 'open' })
  assert.deepEqual(await competitionFileHashes(c.id, 'open'), [
    { name: 'gone.csv', bytes: 3, sha256: null },
    { name: 'short.csv', bytes: 999, sha256: null },
  ])
  assert.equal(row(c, 'open', 'short.csv')?.sha256, null)
  assert.equal(await openFileSha256(c.id, 'gone.csv'), null)
  assert.equal(await sealedFileSha256(c.id, 'gone.csv'), null)
})

test("a re-upload while the backfill reads the old bytes keeps the new upload's hash", async () => {
  const c = competition()
  putOpenFile(c.id, 'train.csv', enc('id\nold\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: 7, visibility: 'open' })
  // The backfill opens the old file before its first wait...
  const pending = competitionFileHashes(c.id, 'open')
  // ...and the teacher's new file lands, disk and row, while it reads.
  const next = putOpenFile(c.id, 'train.csv', enc('id\nnew\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: next.bytes, visibility: 'open', sha256: next.sha256 })
  assert.deepEqual(await pending, [{ name: 'train.csv', bytes: 7, sha256: sha('id\nnew\n') }])
  assert.equal(row(c, 'open', 'train.csv')?.sha256, sha('id\nnew\n'), "the old bytes' hash overwrote the new upload's")
})

test("an older server's re-upload while the backfill reads leaves the row without a hash, not with the old one", async () => {
  const c = competition()
  putOpenFile(c.id, 'train.csv', enc('id\nold\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: 7, visibility: 'open', at: 1000 })
  const pending = competitionFileHashes(c.id, 'open')
  putOpenFile(c.id, 'train.csv', enc('id\nnew\n'))
  db.prepare("UPDATE competition_files SET uploaded_at = 2000 WHERE competition_id = ? AND name = 'train.csv'").run(c.id)
  assert.equal((await pending)[0]?.sha256, null)
  assert.equal(row(c, 'open', 'train.csv')?.sha256, null)
  // The next ask hashes what is there now.
  assert.equal((await competitionFileHashes(c.id, 'open'))[0]?.sha256, sha('id\nnew\n'))
})

test("an upload still bumps the competition's inputs; a hash written alone does not", () => {
  const c = competition()
  const first = putOpenFile(c.id, 'train.csv', enc('id\n1\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: first.bytes, visibility: 'open', sha256: first.sha256 })
  const before = revisions(c)
  const next = putOpenFile(c.id, 'train.csv', enc('id\n2\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: next.bytes, visibility: 'open', sha256: next.sha256 })
  const after = revisions(c)
  assert.ok(after.input > before.input && after.notebook > before.notebook && after.revision > before.revision, 'a new file is a new input')
  db.prepare("UPDATE competition_files SET sha256 = ? WHERE competition_id = ? AND name = 'train.csv'").run('f'.repeat(64), c.id)
  assert.deepEqual(revisions(c), after)
})

test('the triggers an older start made, firing on any update, are replaced by ones that ignore the hash', () => {
  const c = competition()
  putOpenFile(c.id, 'train.csv', enc('id\n1\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: 5, visibility: 'open' })
  // 0.22's two triggers, as its start left them in every database.
  db.exec(`
    DROP TRIGGER competition_files_update_revision;
    DROP TRIGGER competition_files_update_notebook_inputs;
    CREATE TRIGGER competition_files_update_notebook_inputs AFTER UPDATE ON competition_files
      WHEN OLD.visibility IN ('open', 'sealed') OR NEW.visibility IN ('open', 'sealed')
      BEGIN UPDATE competitions SET notebook_input_revision = notebook_input_revision + 1 WHERE id = NEW.competition_id; END;
    CREATE TRIGGER competition_files_update_revision AFTER UPDATE ON competition_files
      BEGIN UPDATE competitions SET revision = revision + 1, input_revision = input_revision + 1 WHERE id = NEW.competition_id; END;
  `)
  competitionTriggers()
  const sql = (name: string) => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string }).sql
  for (const name of ['competition_files_update_revision', 'competition_files_update_notebook_inputs']) {
    assert.match(sql(name), /UPDATE OF competition_id, name, bytes, row_count, visibility, uploaded_at/, name)
  }
  const before = revisions(c)
  db.prepare("UPDATE competition_files SET sha256 = ? WHERE competition_id = ? AND name = 'train.csv'").run('e'.repeat(64), c.id)
  assert.deepEqual(revisions(c), before)
  // Idempotent: a second start leaves them be.
  competitionTriggers()
  assert.match(sql('competition_files_update_revision'), /UPDATE OF/)
  // And they still fire for what a file is.
  db.prepare("UPDATE competition_files SET bytes = 6 WHERE competition_id = ? AND name = 'train.csv'").run(c.id)
  assert.ok(revisions(c).input > before.input)
})
