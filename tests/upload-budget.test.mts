/**
 * The room's space and a taken name are per room, not per request.
 *
 * Both quantities were computed once at the start of a request, and both were
 * therefore bypassed by concurrent uploads. Five hundred students hand in a
 * CSV in the same minute: each request saw the old total and together they
 * put as much as they liked into the room; two people with the same file name
 * both saw "no such file", and the second one silently landed on top of the
 * first — with no refusal and no "replaced" mark.
 *
 * And a third one, from the same family: an interrupted upload. The client
 * left in the middle of the body — busboy does not get 'end', the file stream
 * does not close, the write promise never resolves. A half-written
 * `.uploading-*` lay in the folder until the next cleanup (the threshold is an
 * hour), all that time taking up the room's space and taking it away from the
 * next uploads.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/src/config.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { signToken } from '../server/src/auth.js'
import { app } from '../server/src/app.js'
import { sessionDir } from '../server/src/workspace.js'

let base = ''
let server: http.Server
const rooms: string[] = []

/** `config` is declared `as const`; this is how to move a cap for one test. */
const tunable: { maxSessionBytes: number; maxUploadBytes: number } = config

before(async () => {
  /*
   * The whole application (server/src/app.ts), not our own express next to
   * it: a copy of the middleware order does not catch divergence from the
   * product, it repeats it.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  for (const id of rooms) fs.rmSync(sessionDir(id), { recursive: true, force: true })
})

function room(id: string): string {
  createSession(id, id, null)
  upsertParticipant({ id: 'p_1', sessionId: id, name: 'Нина', avatar: null, role: 'participant' })
  upsertParticipant({ id: 'p_2', sessionId: id, name: 'Гриша', avatar: null, role: 'participant' })
  fs.mkdirSync(sessionDir(id), { recursive: true })
  rooms.push(id)
  return id
}

const bearer = (room: string, who = 'p_1') => ({
  authorization: `Bearer ${signToken({ sessionId: room, participantId: who, role: 'participant' })}`,
})

async function upload(
  id: string,
  name: string,
  bytes: number,
  who = 'p_1',
): Promise<number> {
  const form = new FormData()
  form.append('file', new Blob(['x'.repeat(bytes)]), name)
  const res = await fetch(`${base}/api/sessions/${id}/files`, {
    method: 'POST',
    headers: bearer(id, who),
    body: form,
  })
  return res.status
}

const temps = (id: string) => fs.readdirSync(sessionDir(id)).filter((n) => n.includes('.uploading-'))

test('two uploads in the same second share the room cap instead of each taking all of it', async () => {
  const id = room('budget-parallel')
  const wasRoom = tunable.maxSessionBytes
  tunable.maxSessionBytes = 4096
  try {
    const [first, second] = await Promise.all([
      upload(id, 'a.csv', 3000),
      upload(id, 'b.csv', 3000, 'p_2'),
    ])
    const codes = [first, second].sort()
    assert.deepEqual(codes, [200, 413], `both uploads got past the cap: ${codes.join(', ')}`)
    // And nothing extra was left on disk: a refusal does not cost space.
    assert.deepEqual(temps(id), [])
  } finally {
    tunable.maxSessionBytes = wasRoom
  }
})

test('two people with the same name: one puts the file, the other is refused', async () => {
  const id = room('budget-samename')
  const [first, second] = await Promise.all([
    upload(id, 'data.csv', 64, 'p_1'),
    upload(id, 'data.csv', 64, 'p_2'),
  ])
  const codes = [first, second].sort()
  /*
   * The second one is not silently "uploaded" on top of the first: replacing
   * someone else's file means deleting it, and deleting belongs to the
   * teacher. The taken check now stands one line before the rename, not at
   * the file-start event.
   */
  assert.deepEqual(codes, [200, 403], `both got the name: ${codes.join(', ')}`)
  assert.deepEqual(temps(id), [])
})

test('a cross-site POST into the seminar folder does not go through', async () => {
  /*
   * The only write outside /api/admin that the teacher's cookie alone
   * authorizes — and the `sameOrigin` check hung only on the /api/admin
   * prefix. So a foreign page could put a file into the seminar folder, and
   * only the browser's SameSite=Lax held that back.
   */
  const id = room('budget-origin')
  const form = new FormData()
  form.append('file', new Blob(['x']), 'from-elsewhere.txt')
  const res = await fetch(`${base}/api/sessions/${id}/files`, {
    method: 'POST',
    headers: { ...bearer(id), origin: 'https://evil.example' },
    body: form,
  })
  assert.equal(res.status, 403)
  assert.equal(fs.existsSync(`${sessionDir(id)}/from-elsewhere.txt`), false)

  // And from our own page — as before.
  const ok = await fetch(`${base}/api/sessions/${id}/files`, {
    method: 'POST',
    headers: { ...bearer(id), origin: base },
    body: (() => {
      const own = new FormData()
      own.append('file', new Blob(['x']), 'from-here.txt')
      return own
    })(),
  })
  assert.equal(ok.status, 200)
})

/** Cut off an upload in the middle of the body: the headers went out, the file is half sent. */
function cutOff(id: string): Promise<void> {
  return new Promise((resolve) => {
    const boundary = '----colloqcut'
    const req = http.request(
      `${base}/api/sessions/${id}/files`,
      {
        method: 'POST',
        headers: {
          ...bearer(id),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
      },
      () => undefined,
    )
    req.on('error', () => undefined)
    req.write(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="half.csv"\r\n' +
        'Content-Type: text/csv\r\n\r\n',
    )
    req.write('x'.repeat(50_000))
    // Let the server accept the start of the body and create the temporary
    // file.
    setTimeout(() => {
      req.destroy()
      resolve()
    }, 80)
  })
}

test('an interrupted upload leaves nothing half written and gives the room its space back', async () => {
  const id = room('budget-abort')
  const wasRoom = tunable.maxSessionBytes
  // A cap for exactly one normal file: if the abandoned 50 KB stay counted
  // against the room, the next upload will be refused.
  tunable.maxSessionBytes = 120_000
  try {
    await cutOff(id)
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(temps(id), [], 'the half-written file was left lying in the room')

    assert.equal(await upload(id, 'whole.csv', 100_000), 200, 'the room space did not come back')
    assert.equal(fs.readFileSync(`${sessionDir(id)}/whole.csv`, 'utf8').length, 100_000)
  } finally {
    tunable.maxSessionBytes = wasRoom
  }
})
