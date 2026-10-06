/**
 * What a membership taken away takes, and what it leaves alone (0.19).
 *
 * A grant interrupts nobody: making a room or a course for next week must not
 * drop the creator's live lecture. A removal closes the sockets of the rooms
 * it took and only those. A room that leaves its last course with nobody of
 * its own stays with the course's teachers instead of becoming owner-only.
 * And "host" is what the person holds now — not the badge their row kept
 * from the day they still taught here: the remaining host can ban them, and
 * a console key minted back then opens nothing.
 */
import './_env.mts'
import { EventEmitter } from 'node:events'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { AdminSeminar } from '../shared/admin.js'
import type { Course } from '../shared/publish.js'
import type { CreateSessionResponse, HandoffResponse, JoinResponse } from '../shared/protocol.js'
import type { OracleUsage } from '../shared/admin.js'
import {
  addCourseTeacher,
  canSeeRoom,
  roomTeacherIds,
} from '../server/src/admin/access.js'
import { seatRoom } from '../server/src/admin/seat.js'
import { recordQuestion } from '../server/src/admin/usage.js'
import { banParticipant } from '../server/src/bans.js'
import { signHostToken } from '../server/src/auth.js'
import { roleFor } from '../server/src/authorization.js'
import { createSession, getParticipant, syncParticipantRole } from '../server/src/db.js'
import { createCourse, getCourse, setCourseItems } from '../server/src/publish/store.js'
import { authorizeSocket } from '../server/src/socket-authorization.js'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running
const owner = staffMember('Владелец Отзыва', 'owner')
const anna = staffMember('Анна Отзыв')

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN
  closed: number | null = null
  close(code: number) { this.closed ??= code; this.readyState = WebSocket.CLOSED; this.emit('close') }
  terminate() { this.close(1006) }
}

/** A socket of this staff member in this room, held as the upgrade would hold it. */
function socketIn(sessionId: string, cookie: string): FakeSocket {
  const ws = new FakeSocket()
  const payload = { sessionId, participantId: `p_${sessionId}`, role: roleFor(cookie, { sessionId, participantId: `p_${sessionId}` }) }
  assert.equal(payload.role, 'host', 'the test socket must start as host')
  authorizeSocket(ws as unknown as WebSocket, { cookieHeader: cookie, payload })
  return ws
}

async function newCourse(cookie: string, name: string): Promise<string> {
  const res = await call(app.base, 'POST', '/api/admin/courses', { cookie, body: { name } })
  assert.ok(res.ok, `course ${name}: ${res.status}`)
  return ((await res.json()) as { course: Course }).course.id
}

async function newRoom(cookie: string, name: string, courseId?: string): Promise<string> {
  const res = await call(app.base, 'POST', '/api/admin/seminars', {
    cookie,
    body: { name, ...(courseId ? { seat: { courseId } } : {}) },
  })
  assert.equal(res.status, 201, `room ${name}: ${res.status}`)
  return ((await res.json()) as AdminSeminar).id
}

const courseNow = async (id: string, cookie: string): Promise<Course> =>
  ((await (await call(app.base, 'GET', `/api/admin/courses/${id}`, { cookie })).json()) as { course: Course }).course

/** A room as the one-time migration left a seated one: in the course, with no teachers of its own. */
function migratedRoomIn(courseId: string, id: string): void {
  createSession(id, id, null)
  const course = getCourse(courseId)!
  assert.ok(setCourseItems(courseId, course.rev, [
    ...course.items,
    { kind: 'seminar', id: `r${id.slice(-7)}`, sessionId: id, name: id, publication: null },
  ]))
  assert.deepEqual(roomTeacherIds(id), [])
}

before(async () => {
  app = await startApp()
})
after(() => app?.close())

/* ------------------------------------------------------------- sockets */

test('a grant closes no socket; a removal closes only the sockets of the rooms it took', async () => {
  const gleb = staffMember('Глеб Лектор')
  const course = await newCourse(anna.cookie, 'Курс Глеба')
  assert.equal((await call(app.base, 'POST', `/api/admin/courses/${course}/teachers`, { cookie: anna.cookie, body: { staffId: gleb.teacher.id } })).status, 201)
  const lecture = await newRoom(anna.cookie, 'Лекция в курсе', course)
  const inLecture = socketIn(lecture, gleb.cookie)

  // Mid-lecture Gleb makes next week's room and a course of his own: nothing
  // was taken from him, and the lecture's socket stays open.
  const ownRoom = await newRoom(gleb.cookie, 'Своя комната')
  await newCourse(gleb.cookie, 'Свой курс')
  // Being added to someone else's room is a grant too.
  const other = await newRoom(anna.cookie, 'Комната Анны')
  assert.equal((await call(app.base, 'POST', `/api/admin/seminars/${other}/teachers`, { cookie: anna.cookie, body: { staffId: gleb.teacher.id } })).status, 201)
  assert.equal(inLecture.closed, null, 'a grant dropped the live lecture')

  // Removed from the course: the course's room closes, his own room does not.
  const inOwn = socketIn(ownRoom, gleb.cookie)
  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course}/teachers/${gleb.teacher.id}`, { cookie: anna.cookie })).status, 200)
  assert.equal(inLecture.closed, 4401, 'the room he lost kept its host socket')
  assert.equal(inOwn.closed, null, 'leaving one course dropped a class in another room')

  // A room he still teaches another way is not touched by losing one way in.
  const both = await newRoom(anna.cookie, 'Через курс и лично', course)
  assert.equal((await call(app.base, 'POST', `/api/admin/seminars/${both}/teachers`, { cookie: anna.cookie, body: { staffId: gleb.teacher.id } })).status, 201)
  assert.equal((await call(app.base, 'POST', `/api/admin/courses/${course}/teachers`, { cookie: anna.cookie, body: { staffId: gleb.teacher.id } })).status, 201)
  const inBoth = socketIn(both, gleb.cookie)
  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course}/teachers/${gleb.teacher.id}`, { cookie: anna.cookie })).status, 200)
  assert.equal(inBoth.closed, null, 'a room he still teaches by room_teachers was interrupted')
})

/* ------------------------------------------------------ orphaned rooms */

test('a migrated room taken out of its course stays with the course\'s teachers, and can be seated elsewhere', async () => {
  const lera = staffMember('Лера Миграция')
  const from = createCourse('Курс до обновления', null, null)
  const to = createCourse('Второй курс Леры', null, null)
  addCourseTeacher(from.id, lera.teacher.id, null)
  addCourseTeacher(to.id, lera.teacher.id, null)
  migratedRoomIn(from.id, 'orphan-room-1')
  assert.ok(canSeeRoom(lera.teacher, 'orphan-room-1'))

  const before = await courseNow(from.id, lera.cookie)
  const without = before.items.filter((item) => !(item.kind === 'seminar' && item.sessionId === 'orphan-room-1'))
  assert.equal((await call(app.base, 'PUT', `/api/admin/courses/${from.id}/items`, { cookie: lera.cookie, body: { rev: before.rev, items: without } })).status, 200)
  assert.ok(canSeeRoom(lera.teacher, 'orphan-room-1'), 'the teacher who removed the row lost the room')
  assert.deepEqual(roomTeacherIds('orphan-room-1'), [lera.teacher.id])

  // And she can move it into her other course.
  const target = await courseNow(to.id, lera.cookie)
  const seated = await call(app.base, 'PUT', `/api/admin/courses/${to.id}/items`, {
    cookie: lera.cookie,
    body: { rev: target.rev, items: [...target.items, { kind: 'seminar', sessionId: 'orphan-room-1' }] },
  })
  assert.equal(seated.status, 200, 'a migrated room could not be moved between courses')
})

test('deleting a course leaves its orphaned rooms with its teachers, and other rooms with their own', async () => {
  const mark = staffMember('Марк Удаление')
  const doomed = createCourse('Курс под удаление', null, null)
  addCourseTeacher(doomed.id, mark.teacher.id, null)
  migratedRoomIn(doomed.id, 'orphan-room-2')
  // A room with its own teacher (Anna) goes back to her alone.
  const annas = await newRoom(anna.cookie, 'Своя комната Анны')
  const course = getCourse(doomed.id)!
  assert.ok(setCourseItems(doomed.id, course.rev, [...course.items, { kind: 'seminar', id: 'r0annas1', sessionId: annas, name: 'x', publication: null }]))
  assert.ok(canSeeRoom(mark.teacher, annas))

  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${doomed.id}`, { cookie: owner.cookie })).status, 200)
  assert.ok(canSeeRoom(mark.teacher, 'orphan-room-2'), 'deleting the course made its room owner-only')
  assert.equal(canSeeRoom(mark.teacher, annas), false, 'a room with its own teacher was handed to the course\'s teachers')
  assert.deepEqual(roomTeacherIds(annas), [anna.teacher.id])
})

/* -------------------------------------------------------- stale "host" */

test('a teacher removed from the course is bannable, and their old console key opens nothing', async () => {
  const course = await newCourse(anna.cookie, 'Курс с баном')
  const room = await newRoom(anna.cookie, 'Комната с баном', course)
  const tim = staffMember('Тимур Бывший')
  assert.equal((await call(app.base, 'POST', `/api/admin/courses/${course}/teachers`, { cookie: anna.cookie, body: { staffId: tim.teacher.id } })).status, 201)
  const joined = (await (await call(app.base, 'POST', `/api/sessions/${room}/join`, { cookie: tim.cookie, body: { name: tim.teacher.name } })).json()) as JoinResponse
  assert.equal(joined.participant.role, 'host')
  // A console key minted while he taught here.
  const made = await call(app.base, 'POST', `/api/sessions/${room}/handoff`, { cookie: tim.cookie, bearer: joined.token })
  assert.equal(made.status, 200)
  const { key } = (await made.json()) as HandoffResponse

  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course}/teachers/${tim.teacher.id}`, { cookie: anna.cookie })).status, 200)
  // He reconnects with his stored token and never joins again: the row still
  // says host, the room does not.
  assert.equal(getParticipant(room, joined.participant.id)?.role, 'host')
  assert.equal(roleFor(tim.cookie, { sessionId: room, participantId: joined.participant.id }), 'participant')

  const claimed = await call(app.base, 'POST', `/api/sessions/${room}/handoff/claim`, { body: { key } })
  assert.equal(claimed.status, 401, 'a key minted before the removal handed out a console')
  assert.equal(getParticipant(room, joined.participant.id)?.role, 'host', 'the refused claim still rewrote the row')

  const ban = banParticipant({ sessionId: room, participantId: joined.participant.id, ip: null, byTeacher: 'Анна' })
  assert.ok(ban, 'the remaining host could not ban a teacher who no longer teaches the room')

  // The control handshake brings the badge to the truth (db.ts · syncParticipantRole).
  syncParticipantRole(room, joined.participant.id, 'participant')
  assert.equal(getParticipant(room, joined.participant.id)?.role, 'participant')
})

test('a host by the room\'s own token stays unbannable, and a staff creator gets no such token', async () => {
  // An open instance's room, as its visitor creates it: the host token is their only grant.
  createSession('open-room-1', 'Открытая комната', null)
  const host = (await (await call(app.base, 'POST', '/api/sessions/open-room-1/join', { body: { name: 'Автор', hostToken: signHostToken('open-room-1') } })).json()) as JoinResponse
  assert.equal(host.participant.role, 'host')
  assert.equal(banParticipant({ sessionId: 'open-room-1', participantId: host.participant.id, ip: null, byTeacher: null }), null)

  // A signed-in teacher's grant is the membership, which removal takes away;
  // a permanent token on top of it would outlive that.
  const scripted = await call(app.base, 'POST', '/api/sessions', { cookie: anna.cookie, body: { name: 'Скриптом' } })
  assert.equal(scripted.status, 201)
  const body = (await scripted.json()) as CreateSessionResponse
  assert.equal(body.hostToken, null)
  assert.ok(canSeeRoom(anna.teacher, body.session.id))
})

/* ---------------------------------------------------------- small doors */

test('a room or page id new to the course gets one refusal, whether it exists or not', async () => {
  const course = await newCourse(anna.cookie, 'Курс без оракула существования')
  const foreign = await newRoom(owner.cookie, 'Чужая комната')
  const put = async (extra: unknown) => {
    const now = await courseNow(course, anna.cookie)
    const res = await call(app.base, 'PUT', `/api/admin/courses/${course}/items`, { cookie: anna.cookie, body: { rev: now.rev, items: [...now.items, extra] } })
    return { status: res.status, error: ((await res.json()) as { error?: string }).error }
  }
  const real = await put({ kind: 'seminar', sessionId: foreign })
  const made = await put({ kind: 'seminar', sessionId: 'zzzz9999' })
  assert.equal(real.status, 403)
  assert.deepEqual(made, real, 'a missing room answered differently from someone else\'s')
  const ghost = await put({ kind: 'gone', name: 'x', publication: { id: 'no-such-page' } })
  assert.equal(ghost.status, 403, 'a missing page id was saved where a foreign one is refused')
})

test('the oracle usage a teacher reads is their own rooms\'', async () => {
  const mine = await newRoom(anna.cookie, 'Оракул Анны')
  const theirs = await newRoom(owner.cookie, 'Оракул чужой')
  const since = Date.now() - 1000
  recordQuestion({ sessionId: mine, participantId: 'p1', action: 'ask', tokens: 10 })
  recordQuestion({ sessionId: theirs, participantId: 'p2', action: 'ask', tokens: 90 })
  recordQuestion({ sessionId: theirs, participantId: 'p3', action: 'hint', tokens: null })
  const read = async (cookie: string) =>
    (await (await call(app.base, 'GET', `/api/admin/oracle/usage?since=${since}`, { cookie })).json()) as OracleUsage
  const teacher = await read(anna.cookie)
  assert.equal(teacher.questions, 1)
  assert.equal(teacher.tokens, 10)
  assert.equal(teacher.seminarsWithQuestions, 1)
  assert.deepEqual(teacher.byAction, { ask: 1 })
  const all = await read(owner.cookie)
  assert.equal(all.questions >= 3, true)
})

test('seating re-checks the course: a teacher removed while the room was being made does not write into it', async () => {
  const course = await newCourse(anna.cookie, 'Курс для импорта')
  const ira = staffMember('Ира Импорт')
  assert.equal((await call(app.base, 'POST', `/api/admin/courses/${course}/teachers`, { cookie: anna.cookie, body: { staffId: ira.teacher.id } })).status, 201)
  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course}/teachers/${ira.teacher.id}`, { cookie: anna.cookie })).status, 200)
  createSession('late-seat', 'Импорт', null)
  assert.equal(seatRoom({ courseId: course }, { id: 'late-seat', name: 'Импорт' }, ira.teacher), null)
  assert.ok(!getCourse(course)!.items.some((item) => item.kind === 'seminar' && item.sessionId === 'late-seat'))
})
