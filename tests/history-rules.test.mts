/**
 * Who gets the version feed, and who only gets to look at the notebook.
 *
 * The feed has three doors and two permissions. By default the whole room may
 * read it — the notebook is shared, and who changed what is no secret from
 * those present when it changed; but a seminar where the notebook is shown
 * rather than written together may close it (`history: 'host'`): there the
 * feed holds the teacher's drafts, which they did not show. Restoring a
 * version and a checkpoint are always the teacher's: the first rewrites what
 * the whole room is looking at, the second puts a mark in the shared feed.
 *
 * Of all this exactly one case was tested — the 404 of a deleted seminar — so
 * removing the `allows()` check broke nothing: the rule existed, but there was
 * no test for it.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { signToken } from '../server/src/auth.js'
import { createSession, setRules, storedRules, upsertParticipant } from '../server/src/db.js'
import { readRules } from '../shared/rules.js'
import { app } from '../server/src/app.js'
import { peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

const ROOM = 'history-rules'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Лекция с лентой', null)
  upsertParticipant({
    id: 'p_student',
    sessionId: ROOM,
    name: 'Нина',
    avatar: null,
    role: 'participant',
  })
  upsertParticipant({
    id: 'p_teacher',
    sessionId: ROOM,
    name: 'Преподаватель',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })

  /*
   * The whole app (server/src/app.ts), not an express of our own next to it:
   * a copy of the middleware order does not catch discrepancies with the
   * product, it repeats them.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/*
 * The role in the token is always 'participant': `sessionAuth` recomputes it
 * on every request — from the staff cookie and the token_host column, not
 * from what the token says. The host here is whoever has token_host set in
 * their row.
 */
const bearer = (id: string) => ({
  authorization: `Bearer ${signToken({ sessionId: ROOM, participantId: id, role: 'participant' })}`,
})

const ask = (path: string, id: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api/sessions/${ROOM}${path}`, {
    method,
    headers: body ? { ...bearer(id), 'content-type': 'application/json' } : bearer(id),
    body: body ? JSON.stringify(body) : undefined,
  })

test('by default the whole room reads the feed', async () => {
  const res = await ask('/history', 'p_student')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { versions: unknown[] }
  assert.ok(Array.isArray(body.versions))
})

test("history: 'host' closes the feed to a participant and leaves it to the teacher", async () => {
  setRules(ROOM, readRules({ ...storedRules(ROOM), history: 'host' }))

  const student = await ask('/history', 'p_student')
  assert.equal(student.status, 403, "the teacher's drafts were shown to the hall")
  const refusal = (await student.json()) as { error?: string }
  // A refusal in words: "In this seminar the version feed is the teacher's".
  assert.match(refusal.error ?? '', /может только преподаватель/i)

  const teacher = await ask('/history', 'p_teacher')
  assert.equal(teacher.status, 200, 'the rule closed the feed to the teacher too')
})

test('restoring a version and a checkpoint stay closed to a participant even with the feed open', async () => {
  setRules(ROOM, readRules({ ...storedRules(ROOM), history: 'everyone' }))
  // The feed can be read — but writing to it is still not allowed.
  assert.equal((await ask('/history', 'p_student')).status, 200)

  const restored = await ask('/history/1/restore', 'p_student', 'POST', {})
  assert.equal(restored.status, 403, 'a participant restored a version for the whole room')

  const marked = await ask('/history/checkpoint', 'p_student', 'POST', { label: 'до упражнения' })
  assert.equal(marked.status, 403, 'a participant put a mark in the shared feed')
})

test('reading the feed does not settle the notebook in memory and appends no rows', async () => {
  /*
   * The feed brings up the room document — without it a seminar nobody has
   * opened since the restart has no base row, and the panel would show an
   * empty list for a room full of work. But a document brought up this way
   * was evicted only by deleting the seminar: opening the feed of twenty
   * archived seminars meant settling twenty other notebooks, images and all,
   * in memory until the restart.
   */
  const first = await ask('/history', 'p_teacher')
  const before = ((await first.json()) as { versions: unknown[] }).versions.length
  assert.equal(peekSessionDoc(ROOM), null, 'the notebook stayed in memory after reading the feed')

  await ask('/history', 'p_teacher')
  const again = await ask('/history', 'p_teacher')
  const after = ((await again.json()) as { versions: unknown[] }).versions.length
  // And each read does not append "seminar opened" again.
  assert.equal(after, before)
})

test('the teacher sets a checkpoint, and it appears in the feed', async () => {
  const marked = await ask('/history/checkpoint', 'p_teacher', 'POST', { label: 'до упражнения' })
  assert.equal(marked.status, 201)
  const { seq } = (await marked.json()) as { seq: number }

  const list = await ask('/history', 'p_teacher')
  const { versions } = (await list.json()) as {
    versions: { seq: number; label: string | null; authorName: string | null }[]
  }
  const marked2 = versions.find((v) => v.seq === seq)
  assert.ok(marked2, 'the named moment is not visible in the feed')
  assert.equal(marked2.label, 'до упражнения')
  /*
   * The author's name comes from one participant map per request, not from a
   * query per row: four hundred feed rows are four hundred synchronous
   * SELECTs, and the feed opens for the whole room at once.
   */
  assert.equal(marked2.authorName, 'Преподаватель')
})
