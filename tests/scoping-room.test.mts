/**
 * Host only in the rooms you teach (0.19).
 *
 * The panel's lists are not the access control: the room is. Until 0.19 any
 * staff cookie made its holder host in every room on the instance — restart,
 * bans, the activity log, the lecture remote — and a hidden list row would
 * have changed none of that. Here the room decides: a course's teachers and a
 * room's own teachers are hosts, owners are hosts, and anyone else on the
 * staff list joins by the link as a participant and is told why. Every door
 * that used to wave staff through asks the same question, and a membership
 * taken away takes the rights with it at once — on open sockets and on a
 * tablet the console was handed to.
 */
import './_env.mts'
import { EventEmitter } from 'node:events'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { AdminSeminar } from '../shared/admin.js'
import type { Course } from '../shared/publish.js'
import type { HandoffResponse, JoinResponse, SessionMe } from '../shared/protocol.js'
import { onStaffAuthorizationChanged } from '../server/src/admin/store.js'
import { banFor, banParticipant } from '../server/src/bans.js'
import { verifyToken } from '../server/src/auth.js'
import { roleFor } from '../server/src/authorization.js'
import { authorizeSocket } from '../server/src/socket-authorization.js'
import { writePublication, savePublicationSelection } from '../server/src/publish/store.js'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running
const owner = staffMember('Владелец Олег', 'owner')
const anna = staffMember('Анна Ковалёва')
const boris = staffMember('Борис Гость')
let room = ''
let course = ''

async function join(cookie: string | undefined, name: string): Promise<JoinResponse> {
  const res = await call(app.base, 'POST', `/api/sessions/${room}/join`, { cookie, body: { name } })
  assert.equal(res.status, 200, `join as ${name}: ${res.status}`)
  return (await res.json()) as JoinResponse
}

const as = (cookie: string | undefined, participantId = 'p_nobody') => roleFor(cookie, { sessionId: room, participantId })

before(async () => {
  app = await startApp()
  const c = await call(app.base, 'POST', '/api/admin/courses', { cookie: anna.cookie, body: { name: 'Анализ данных' } })
  course = ((await c.json()) as { course: Course }).course.id
  const r = await call(app.base, 'POST', '/api/admin/seminars', {
    cookie: anna.cookie,
    body: { name: 'Неделя 3', seat: { courseId: course } },
  })
  room = ((await r.json()) as AdminSeminar).id
})

after(() => app?.close())

test('a staff cookie is host in a room its holder teaches, and a participant elsewhere', () => {
  assert.equal(as(owner.cookie), 'host', 'an owner runs every room')
  assert.equal(as(anna.cookie), 'host', 'the course teacher runs the course\'s room')
  assert.equal(as(boris.cookie), 'participant', 'another teacher is a participant here')
  assert.equal(as(undefined), 'participant')
})

test('a staff member who does not teach the room joins as a participant and is told why', async () => {
  const guest = await join(boris.cookie, boris.teacher.name)
  assert.equal(guest.participant.role, 'participant')
  // The author is the room's own teacher (no names repeated), and the course is named.
  assert.deepEqual(guest.staffGuest, { course: { id: course, name: 'Анализ данных' }, teachers: [anna.teacher.name] })

  // The same note on /me, which every reconnecting tab asks.
  const me = await call(app.base, 'GET', `/api/sessions/${room}/me`, { cookie: boris.cookie, bearer: guest.token })
  const body = (await me.json()) as SessionMe
  assert.equal(body.role, 'participant')
  assert.deepEqual(body.staffGuest, guest.staffGuest)

  // The room's own teacher and the owner are hosts, with nothing to explain.
  const host = await join(anna.cookie, anna.teacher.name)
  assert.equal(host.participant.role, 'host')
  assert.equal(host.staffGuest, undefined)
  const top = await join(owner.cookie, owner.teacher.name)
  assert.equal(top.participant.role, 'host')
  assert.equal(top.staffGuest, undefined)

  // A student has nothing to be told either.
  const student = await join(undefined, 'Студент')
  assert.equal(student.staffGuest, undefined)
})

test('the cookie alone uploads only into a room its holder teaches', async () => {
  const upload = (cookie: string) => {
    const form = new FormData()
    form.append('file', new Blob([new TextEncoder().encode('a,b\n')]), 'data.csv')
    return fetch(`${app.base}/api/sessions/${room}/files`, { method: 'POST', headers: { cookie }, body: form })
  }
  assert.equal((await upload(boris.cookie)).status, 401, 'another course\'s teacher put a file into this room')
  assert.ok((await upload(anna.cookie)).ok, 'the room\'s teacher could not attach a material')
})

test('the ban exemption is for the room\'s own staff, not for every cookie', async () => {
  const guest = await join(boris.cookie, 'Борис ещё раз')
  assert.ok(banParticipant({ sessionId: room, participantId: guest.participant.id, ip: null, byTeacher: 'Анна' }))
  assert.ok(banFor(room, guest.participant.id, boris.cookie), 'a guest teacher walked past the host\'s ban')
  // The room's teacher on the same browser id is let through: a slip must not lock them out.
  assert.equal(banFor(room, guest.participant.id, anna.cookie), null)
})

test('the page\'s door gives the room to its teachers, not to every member of staff', async () => {
  const pub = writePublication({ sessionId: room, title: 'Неделя 3', by: null, materials: [], blobs: [] })
  savePublicationSelection(pub.id, { v: 1, notebooks: [], files: [], autoRefresh: false, ack: [], roomAccess: 'none' } as Parameters<typeof savePublicationSelection>[1])
  const door = async (cookie: string) =>
    (await (await call(app.base, 'POST', `/api/p/${pub.id}/room`, { cookie, body: { tokens: [] } })).json()) as {
      staff: boolean
      room: { path: string } | null
    }
  const teacher = await door(anna.cookie)
  assert.equal(teacher.staff, true)
  assert.equal(teacher.room?.path, `/s/${room}`)
  const guest = await door(boris.cookie)
  assert.equal(guest.staff, false)
  assert.equal(guest.room, null, '«никто, кроме преподавателей» let another course\'s teacher in')
})

test('taking a room out of the course takes the course teacher\'s rights in it at once', async () => {
  const load = async () =>
    ((await (await call(app.base, 'GET', `/api/admin/courses/${course}`, { cookie: anna.cookie })).json()) as { course: Course }).course
  const before = await load()
  // The owner unseats it (Anna could too; the owner keeps seeing the room either way).
  const without = before.items.filter((item) => !(item.kind === 'seminar' && item.sessionId === room))
  const res = await call(app.base, 'PUT', `/api/admin/courses/${course}/items`, {
    cookie: owner.cookie,
    body: { rev: before.rev, items: without },
  })
  assert.equal(res.status, 200)
  // Anna created the room, so she is still its own teacher: host by room_teachers.
  assert.equal(as(anna.cookie), 'host')

  // A second course teacher who is not the author loses it with the unseat.
  const vera = staffMember('Вера Соавтор')
  assert.equal((await call(app.base, 'POST', `/api/admin/courses/${course}/teachers`, { cookie: anna.cookie, body: { staffId: vera.teacher.id } })).status, 201)
  assert.equal(roleFor(vera.cookie, { sessionId: room, participantId: 'p' }), 'participant')
  const now = await load()
  const back = await call(app.base, 'PUT', `/api/admin/courses/${course}/items`, {
    cookie: anna.cookie,
    body: { rev: now.rev, items: [...now.items, { kind: 'seminar', sessionId: room }] },
  })
  assert.equal(back.status, 200)
  assert.equal(roleFor(vera.cookie, { sessionId: room, participantId: 'p' }), 'host', 'the seat did not reach the room at once')
})

test('a console handed to a tablet stops being host when its teacher stops teaching the room', async () => {
  const vera = staffMember('Вера Пульт')
  assert.equal((await call(app.base, 'POST', `/api/admin/courses/${course}/teachers`, { cookie: anna.cookie, body: { staffId: vera.teacher.id } })).status, 201)
  const laptop = await join(vera.cookie, vera.teacher.name)
  const made = await call(app.base, 'POST', `/api/sessions/${room}/handoff`, { cookie: vera.cookie, bearer: laptop.token })
  assert.equal(made.status, 200)
  const { key } = (await made.json()) as HandoffResponse
  const claimed = (await (await call(app.base, 'POST', `/api/sessions/${room}/handoff/claim`, { body: { key } })).json()) as JoinResponse
  const tablet = verifyToken(claimed.token)!
  assert.equal(tablet.staff, vera.teacher.id)
  assert.equal(roleFor(undefined, tablet), 'host')

  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course}/teachers/${vera.teacher.id}`, { cookie: anna.cookie })).status, 200)
  assert.equal(roleFor(undefined, tablet), 'participant', 'the tablet kept host after its teacher left the course')
})

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN
  closed: number | null = null
  close(code: number) { this.closed ??= code; this.readyState = WebSocket.CLOSED; this.emit('close') }
  terminate() { this.close(1006) }
}

test('a membership taken away closes the person\'s open sockets, which reconnect with the new role', async () => {
  const gleb = staffMember('Глеб Сокет')
  assert.equal((await call(app.base, 'POST', `/api/admin/seminars/${room}/teachers`, { cookie: anna.cookie, body: { staffId: gleb.teacher.id } })).status, 201)
  const heard: string[] = []
  const stop = onStaffAuthorizationChanged((id) => heard.push(id))
  try {
    const ws = new FakeSocket()
    const payload = { sessionId: room, participantId: 'p_gleb', role: as(gleb.cookie, 'p_gleb') }
    assert.equal(payload.role, 'host')
    const stillValid = authorizeSocket(ws as unknown as WebSocket, { cookieHeader: gleb.cookie, payload })
    assert.equal(stillValid(), true)
    const removed = await call(app.base, 'DELETE', `/api/admin/seminars/${room}/teachers/${gleb.teacher.id}`, { cookie: anna.cookie })
    assert.equal(removed.status, 200)
    assert.ok(heard.includes(gleb.teacher.id), 'the membership change did not reach the socket revocation hook')
    assert.equal(ws.closed, 4401)
    assert.equal(stillValid(), false)
    assert.equal(as(gleb.cookie, 'p_gleb'), 'participant')
  } finally {
    stop()
  }
})
