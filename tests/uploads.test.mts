/**
 * An upload lands whole or not at all.
 *
 * The route used to write straight into the target file, which truncates it
 * first: a cell already reading that CSV watched it shrink to nothing and grow
 * again, read half the rows, and finished *without an error* — the worst of the
 * three possible outcomes. The same window swallowed the old file whenever an
 * upload was cut off partway through.
 *
 * Uploads now write beside the target and rename over it. Every failure path
 * removes its own temp file; the one that cannot is the process dying mid-write,
 * and what that leaves is swept here.
 *
 * Below is the route itself: until now no test sent multipart, and three
 * hundred lines with temporary files and synchronous fs calls inside stream
 * handlers lived without a safety net. One of them crashed the process.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/src/config.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { app } from '../server/src/app.js'
import { signToken } from '../server/src/auth.js'
import { sessionDir, sweepAllStaleUploads, sweepStaleUploads } from '../server/src/workspace.js'

let seq = 0
const rooms: string[] = []
function room(): string {
  const id = `sweep${seq++}`
  rooms.push(id)
  fs.mkdirSync(sessionDir(id), { recursive: true })
  return id
}
const write = (id: string, name: string, body = 'x', ageMs = 0) => {
  const full = path.join(sessionDir(id), name)
  fs.writeFileSync(full, body)
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(full, when, when)
  }
  return full
}
const listing = (id: string) => fs.readdirSync(sessionDir(id)).sort()

after(() => {
  for (const id of rooms) fs.rmSync(sessionDir(id), { recursive: true, force: true })
})

test('a temp left by a dead process is swept', () => {
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'half a file', 2 * 60 * 60 * 1000)
  sweepStaleUploads(id)
  assert.deepEqual(listing(id), [])
})

test('an upload still in flight is left alone', () => {
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'still arriving')
  sweepStaleUploads(id)
  assert.equal(listing(id).length, 1, 'a live upload was swept out from under itself')
})

test('the room\u2019s own files are never touched', () => {
  const id = room()
  write(id, 'data.csv', 'real', 5 * 60 * 60 * 1000)
  write(id, '.gitkeep', '', 5 * 60 * 60 * 1000)
  write(id, 'notes.uploading-nope.md', 'real too', 5 * 60 * 60 * 1000)
  sweepStaleUploads(id)
  assert.deepEqual(listing(id), ['.gitkeep', 'data.csv', 'notes.uploading-nope.md'])
})

test('an autosave leftover is swept just like an upload leftover', () => {
  /*
   * The sweeper knew only `.name.uploading-<hex>` — the upload pattern —
   * although it promised to remove everything a crash in the middle of a write
   * left behind. The editor writes with its own pattern,
   * `.name.saving-<pid>-<time>`, and saves by itself every few seconds: after
   * a process crash such a file lay invisible (the name starts with a dot),
   * there was nothing to delete it with from the panel, and `sessionBytes`
   * counted it against the room cap.
   */
  const id = room()
  write(id, `.train.py.saving-${process.pid}-m9x2k1`, 'половина', 2 * 60 * 60 * 1000)
  write(id, 'train.py', 'x = 1\n', 2 * 60 * 60 * 1000)
  sweepStaleUploads(id)
  assert.deepEqual(listing(id), ['train.py'])
})

test('a fresh autosave is not swept out from under a live editor', () => {
  const id = room()
  write(id, `.train.py.saving-${process.pid}-m9x2k1`, 'ещё пишется')
  sweepStaleUploads(id)
  assert.equal(listing(id).length, 1)
})

test('the startup sweep goes through all rooms, not just the one being uploaded to', () => {
  /*
   * The sweep hung on the next file upload into the same room. In a room
   * where nothing gets uploaded, an autosave leftover would lie there until a
   * manual cleanup — so startup walks the whole volume.
   */
  const one = room()
  const two = room()
  write(one, '.a.csv.uploading-a1b2c3d4', 'половина', 2 * 60 * 60 * 1000)
  write(two, `.b.py.saving-${process.pid}-m9x2k1`, 'половина', 2 * 60 * 60 * 1000)
  sweepAllStaleUploads()
  assert.deepEqual(listing(one), [])
  assert.deepEqual(listing(two), [])
})

test('a seminar with no folder yet is not an error', () => {
  sweepStaleUploads('a-seminar-that-never-uploaded-anything')
})

test('the temp name is hidden from the room', async () => {
  // listFiles drops dotfiles, which is what keeps a half-arrived upload out of
  // the panel. If the temp naming ever stops starting with a dot, this fails.
  const { listFiles } = await import('../server/src/workspace.js')
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'half')
  write(id, 'data.csv', 'whole')
  assert.deepEqual(listFiles(id).map((f) => f.name), ['data.csv'])
})

/* --------------------------------------------------------------- route */

const UP = 'upload-room'
let base = ''
let server: http.Server

before(async () => {
  createSession(UP, 'Uploads', null)
  // The role is decided on every request and is not read from the token: the
  // teacher is the one whose participant was created with a host token (see
  // roleFor in routes/sessions.ts).
  upsertParticipant({
    id: 'p_host',
    sessionId: UP,
    name: 'Преподаватель',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  /*
   * The whole application (server/src/app.ts), not our own express next to
   * it: a copy of the middleware order does not catch divergence from the
   * product, it repeats it.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => server?.close())

const asWho = (role: 'host' | 'participant') =>
  signToken({ sessionId: UP, participantId: `p_${role}`, role })

interface UploadAnswer {
  status: number
  error?: string
  files: string[]
  replaced?: string[]
}

async function upload(
  named: { name: string; body?: string }[],
  opts: { dir?: string; role?: 'host' | 'participant' } = {},
): Promise<UploadAnswer> {
  const form = new FormData()
  // The field goes before the files — the way the panel puts it.
  if (opts.dir !== undefined) form.append('dir', opts.dir)
  for (const one of named) {
    form.append('file', new Blob([one.body ?? 'a,b\n1,2\n']), one.name)
  }
  const res = await fetch(`${base}/api/sessions/${UP}/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${asWho(opts.role ?? 'participant')}` },
    body: form,
  })
  const body = (await res.json()) as {
    error?: string
    files?: { path: string }[]
    replaced?: string[]
  }
  return {
    status: res.status,
    error: body.error,
    files: (body.files ?? []).map((f) => f.path),
    replaced: body.replaced,
  }
}

const onDisk = (rel: string) => path.join(sessionDir(UP), rel)

test('a file dropped into the room lands in its folder', async () => {
  const answer = await upload([{ name: 'handout.csv' }])
  assert.equal(answer.status, 200)
  assert.ok(answer.files.includes('handout.csv'))
  assert.equal(fs.readFileSync(onDisk('handout.csv'), 'utf8'), 'a,b\n1,2\n')
})

test('the dir field puts the file into a folder that did not exist yet', async () => {
  const answer = await upload([{ name: 'model.py', body: 'x = 1\n' }], { dir: 'src/nested' })
  assert.equal(answer.status, 200)
  assert.ok(answer.files.includes('src/nested/model.py'))
})

test('a dir that names a file is refused instead of crashing the server', async () => {
  /*
   * `mkdirSync` without try/catch in the busboy handler threw EEXIST straight
   * out of the stream event — past express, into `uncaughtException`, and
   * that does `process.exit(1)`: one request from any participant took down
   * the instance with all its seminars. The `data.csv/sub` variant is the same
   * thing, only ENOTDIR.
   */
  for (const dir of ['handout.csv', 'handout.csv/sub']) {
    const answer = await upload([{ name: 'more.csv' }], { dir })
    assert.equal(answer.status, 400, `dir=${dir}`)
    assert.ok(answer.error && answer.error.length > 20, `nothing to say about dir=${dir}`)
  }
  // The server is alive, and the file whose name was taken for a folder is
  // intact.
  assert.equal(fs.readFileSync(onDisk('handout.csv'), 'utf8'), 'a,b\n1,2\n')
  const after = await upload([{ name: 'after.csv' }])
  assert.equal(after.status, 200)
})

test('a name that is too long is explained with the same cap as in the tree', async () => {
  // A hundred and fifty characters is an ordinary export from an LMS.
  // Previously the upload measured the name against two hundred, and the path
  // further on against a hundred and twenty, and the person got "cannot be
  // used as a file name here" without a single reason.
  const answer = await upload([{ name: 'a'.repeat(146) + '.csv' }])
  assert.equal(answer.status, 400)
  assert.match(answer.error ?? '', /120/)
  assert.match(answer.error ?? '', /150/)
})

test('a participant does not put a file on top of an existing one', async () => {
  const answer = await upload([{ name: 'handout.csv', body: 'подмена\n' }])
  assert.equal(answer.status, 403)
  assert.equal(fs.readFileSync(onDisk('handout.csv'), 'utf8'), 'a,b\n1,2\n')
  // But the teacher does, and it is said out loud.
  const asHost = await upload([{ name: 'handout.csv', body: 'a,b\n3,4\n' }], { role: 'host' })
  assert.equal(asHost.status, 200)
  assert.deepEqual(asHost.replaced, ['handout.csv'])
})

test('more than eight files at once is refused with the number', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `many${i}.txt`, body: 'x' }))
  const answer = await upload(many)
  assert.equal(answer.status, 400)
  assert.match(answer.error ?? '', /8/)
})

test('a file larger than the cap does not land on top of a whole one and leaves no garbage', async () => {
  /*
   * The cap is touched right here: pushing fifty megabytes through a socket
   * for the sake of one branch is a minute of test time for nothing, and the
   * route reads it on every request.
   */
  // `config` is declared `as const`; this is how to move a cap for one test.
  const tunable: { maxUploadBytes: number } = config
  const was = tunable.maxUploadBytes
  tunable.maxUploadBytes = 32
  try {
    const answer = await upload([{ name: 'handout.csv', body: 'x'.repeat(4096) }], { role: 'host' })
    assert.equal(answer.status, 413)
    assert.equal(fs.readFileSync(onDisk('handout.csv'), 'utf8'), 'a,b\n3,4\n', 'a truncated piece landed on top')
  } finally {
    tunable.maxUploadBytes = was
  }
  const leftovers = fs.readdirSync(sessionDir(UP)).filter((name) => name.startsWith('.'))
  assert.deepEqual(leftovers, [], 'the half-written file was left lying in the room folder')
})
