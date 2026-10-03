/**
 * A lecture script written in one go: `PUT /api/sessions/:id/notes`.
 *
 * The door is new, and a new door to the one thing the room must never see
 * is checked for three things. WHO may write: the teacher, by the same rule
 * as `notes:set`, with no lecture running (notes are prepared the evening
 * before). WHAT gets written: all of it or none of it, and never a note cut
 * to fit. And WHO HEARS about it: the teacher tabs that have this document's
 * notes open, and nobody in the hall.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { WebSocket } from 'ws'
import { STAFF_COOKIE } from '../shared/admin.js'
import { MAX_NOTE_CHARS } from '../shared/lecture.js'
import type { ControlServerMessage } from '../shared/protocol.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { signToken, type TokenPayload } from '../server/src/auth.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { createSession, notesOf, setNote, upsertParticipant } from '../server/src/db.js'
import { app } from '../server/src/app.js'
import { MAX_IMPORT_PAGES } from '../server/src/routes/notes.js'

const ROOM = 'notes-import-http'
let base = ''
let server: http.Server
let staffCookie = ''

before(async () => {
  createSession(ROOM, 'Импорт сценария', null)
  for (const [id, name] of [
    ['p_teacher', 'Ада'],
    ['p_student', 'Гриша'],
  ]) {
    upsertParticipant({ id, sessionId: ROOM, name, avatar: null, role: 'participant' })
  }
  const teacher = createTeacher({ name: 'Ада', email: 'ada.notesimport@test.local', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, teacher)
  staffCookie = `${STAFF_COOKIE}=${value}`

  // Through the app, not the router alone: in the product the door stands
  // behind json parsing and the body ceiling, and "refused" must mean there.
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  closeControlRoom(ROOM)
  server?.close()
})

const bearer = (id: string) =>
  `Bearer ${signToken({ sessionId: ROOM, participantId: id, role: 'participant' })}`

async function put(
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: { error?: string; notes?: Record<string, string> } }> {
  const res = await fetch(`${base}/api/sessions/${ROOM}/notes`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { error?: string } }
}

const asTeacher = () => ({ authorization: bearer('p_teacher'), cookie: staffCookie })
const asStudent = () => ({ authorization: bearer('p_student') })

test('a student cannot write the notes, and nothing is written', async () => {
  const refused = await put({ file: 'student.pdf', notes: { 1: 'чужие слова' } }, asStudent())
  assert.equal(refused.status, 403)
  assert.match(refused.body.error ?? '', /преподавател/i)
  assert.deepEqual(notesOf(ROOM, 'student.pdf'), {})

  const anonymous = await put({ file: 'student.pdf', notes: { 1: 'x' } }, {})
  assert.equal(anonymous.status, 401)
  assert.deepEqual(notesOf(ROOM, 'student.pdf'), {})
})

test('the teacher writes many pages at once, with no lecture running', async () => {
  setNote(ROOM, 'lecture.pdf', 3, 'старая заметка')
  setNote(ROOM, 'lecture.pdf', 9, 'не упомянута — остаётся')
  const done = await put(
    { file: 'lecture.pdf', notes: { 1: '  первая  ', 3: 'новая третья', 4: '' } },
    asTeacher(),
  )
  assert.equal(done.status, 200)
  // Trimmed as `notes:set` trims; an empty page is an absence; a page the
  // script does not mention keeps what it had.
  const stored = { 1: 'первая', 3: 'новая третья', 9: 'не упомянута — остаётся' }
  assert.deepEqual(notesOf(ROOM, 'lecture.pdf'), stored)
  assert.deepEqual(done.body.notes, stored)
})

test('one note over the ceiling refuses the whole script, out loud', async () => {
  setNote(ROOM, 'atomic.pdf', 1, 'было')
  const res = await put(
    {
      file: 'atomic.pdf',
      notes: { 1: 'стало', 2: 'ы'.repeat(MAX_NOTE_CHARS + 1) },
    },
    asTeacher(),
  )
  assert.equal(res.status, 400)
  assert.match(res.body.error ?? '', /2/)
  assert.match(res.body.error ?? '', new RegExp(String(MAX_NOTE_CHARS)))
  // Not even the good page went in: half a script is worse than none.
  assert.deepEqual(notesOf(ROOM, 'atomic.pdf'), { 1: 'было' })

  // Exactly the ceiling is allowed, counted after trimming like the editor counts.
  const edge = await put(
    { file: 'atomic.pdf', notes: { 2: ` ${'ы'.repeat(MAX_NOTE_CHARS)} ` } },
    asTeacher(),
  )
  assert.equal(edge.status, 200)
  assert.equal(notesOf(ROOM, 'atomic.pdf')[2].length, MAX_NOTE_CHARS)
})

test('bad pages, paths, shapes and sizes are refused before anything is written', async () => {
  const cases: unknown[] = [
    { file: 'bad.pdf', notes: { 0: 'нулевая' } },
    { file: 'bad.pdf', notes: { '-1': 'доска' } },
    { file: 'bad.pdf', notes: { '1.5': 'дробная' } },
    { file: 'bad.pdf', notes: { 10000: 'за пределом' } },
    { file: 'bad.pdf', notes: { 1: 42 } },
    { file: 'bad.pdf', notes: ['массив'] },
    { file: '../etc/passwd', notes: { 1: 'x' } },
    { file: '/abs.pdf', notes: { 1: 'x' } },
    { file: '', notes: { 1: 'x' } },
    { notes: { 1: 'x' } },
  ]
  for (const body of cases) {
    const res = await put(body, asTeacher())
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.ok(res.body.error, 'a refusal says why')
  }
  assert.deepEqual(notesOf(ROOM, 'bad.pdf'), {})

  const many: Record<number, string> = {}
  for (let page = 1; page <= MAX_IMPORT_PAGES + 1; page += 1) many[page] = 'x'
  const tooMany = await put({ file: 'bad.pdf', notes: many }, asTeacher())
  assert.equal(tooMany.status, 400)
  assert.deepEqual(notesOf(ROOM, 'bad.pdf'), {})
})

/** A fake socket that records what the server sends it. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on() {
      return this
    },
    ping: () => {},
    terminate: () => {},
    close: () => {},
  } as unknown as WebSocket
  return { ws, heard }
}

test('the fresh map goes to teacher tabs with this document open, never to the hall', async () => {
  const who = (id: string, role: 'host' | 'participant'): TokenPayload => ({
    sessionId: ROOM,
    participantId: id,
    role,
  })
  const editor = socket()
  const elsewhere = socket()
  const hall = socket()
  handleControlSocket(editor.ws, ROOM, who('p_teacher', 'host'))
  handleControlSocket(elsewhere.ws, ROOM, who('p_teacher2', 'host'))
  handleControlSocket(hall.ws, ROOM, who('p_student', 'participant'))
  dispatch(editor.ws, ROOM, who('p_teacher', 'host'), { t: 'notes:open', file: 'push.pdf' })
  dispatch(elsewhere.ws, ROOM, who('p_teacher2', 'host'), { t: 'notes:open', file: 'other.pdf' })
  dispatch(hall.ws, ROOM, who('p_student', 'participant'), { t: 'notes:open', file: 'push.pdf' })
  for (const one of [editor, elsewhere, hall]) one.heard.length = 0

  const res = await put({ file: 'push.pdf', notes: { 2: 'вторая', 5: 'пятая' } }, asTeacher())
  assert.equal(res.status, 200)

  const notesFrames = (heard: ControlServerMessage[]) =>
    heard.filter((frame) => frame.t === 'notes' || frame.t === 'notes:one')
  assert.deepEqual(notesFrames(editor.heard), [
    { t: 'notes', file: 'push.pdf', notes: { 2: 'вторая', 5: 'пятая' } },
  ])
  assert.deepEqual(notesFrames(elsewhere.heard), [], 'a map for a document this tab does not have open')
  assert.deepEqual(notesFrames(hall.heard), [], "the teacher's notes went to the hall")
})
