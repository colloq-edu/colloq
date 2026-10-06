/**
 * Creating a room into a course, and who teaches what (0.19).
 *
 * The creation form used to seat a new room with a second request from the
 * browser — a whole-list write that could fail after the room already
 * existed. Now every creation door takes `seat` and the server checks the
 * course BEFORE creating anything; the author becomes the room's first
 * teacher whichever door they used. The course plan's own writes check their
 * references: a room can be seated only by someone who teaches it, a
 * tombstone can only link a page of its own course. And a course or a room
 * outside courses keeps at least one teacher unless an owner says otherwise.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AdminSeminar, ImportResult, InviteTeacherResponse, MemberTeacher } from '../shared/admin.js'
import type { Course, CourseItem } from '../shared/publish.js'
import type { CreateSessionResponse } from '../shared/protocol.js'
import { isRoomTeacher } from '../server/src/admin/access.js'
import { getTeacherByEmail } from '../server/src/admin/store.js'
import { writePublication } from '../server/src/publish/store.js'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running
const owner = staffMember('Владелец Ира', 'owner')
const anna = staffMember('Анна План')
const boris = staffMember('Борис Сосед')
let course = ''

async function courseNow(cookie = anna.cookie): Promise<Course> {
  const res = await call(app.base, 'GET', `/api/admin/courses/${course}`, { cookie })
  assert.equal(res.status, 200)
  return ((await res.json()) as { course: Course }).course
}

async function putItems(cookie: string, items: unknown[]): Promise<globalThis.Response> {
  const { rev } = await courseNow(owner.cookie)
  return call(app.base, 'PUT', `/api/admin/courses/${course}/items`, { cookie, body: { rev, items } })
}

before(async () => {
  app = await startApp()
  const c = await call(app.base, 'POST', '/api/admin/courses', { cookie: anna.cookie, body: { name: 'Python, осень' } })
  course = ((await c.json()) as { course: Course }).course.id
  const planned = await putItems(anna.cookie, [
    { kind: 'planned', name: 'Списки и словари', day: '2026-10-11' },
    { kind: 'planned', name: 'Перерыв', pause: true },
    { kind: 'planned', name: 'Функции' },
  ])
  assert.equal(planned.status, 200)
})

after(() => app?.close())

/* --------------------------------------------------------- the seat */

test('a room created into a plan row takes its place, its topic and its day, in one request', async () => {
  const row = (await courseNow()).items[0]
  const res = await call(app.base, 'POST', '/api/admin/seminars', {
    cookie: anna.cookie,
    body: { name: '04 · Списки', seat: { courseId: course, rowId: row.id } },
  })
  assert.equal(res.status, 201)
  const made = (await res.json()) as AdminSeminar
  assert.deepEqual(made.seat, { courseId: course, rowId: row.id, replaced: true })
  assert.deepEqual(made.courses, [{ id: course, name: 'Python, осень' }])
  assert.deepEqual(made.teachers, [{ id: anna.teacher.id, name: anna.teacher.name }], 'the author is not the room\'s teacher')
  const seated = (await courseNow()).items[0] as Extract<CourseItem, { kind: 'seminar' }>
  assert.equal(seated.kind, 'seminar')
  assert.equal(seated.sessionId, made.id)
  assert.equal(seated.title, 'Списки и словари')
  assert.equal(seated.day, '2026-10-11')
})

test('without a row the room is appended; a break or a taken row is refused before anything is created', async () => {
  const before = await courseNow()
  const appended = await call(app.base, 'POST', '/api/admin/seminars', { cookie: anna.cookie, body: { name: 'Доп. занятие', seat: { courseId: course } } })
  assert.equal(appended.status, 201)
  const made = (await appended.json()) as AdminSeminar
  assert.equal(made.seat?.replaced, false)
  const after = await courseNow()
  assert.equal(after.items.length, before.items.length + 1)
  assert.equal((after.items.at(-1) as { sessionId?: string }).sessionId, made.id)

  const rooms = async () => ((await (await call(app.base, 'GET', '/api/admin/seminars', { cookie: anna.cookie })).json()) as AdminSeminar[]).length
  const count = await rooms()
  const pause = after.items[1]
  const taken = after.items[0]
  for (const rowId of [pause.id, taken.id, 'rnosuch']) {
    const res = await call(app.base, 'POST', '/api/admin/seminars', { cookie: anna.cookie, body: { name: 'Лишняя', seat: { courseId: course, rowId } } })
    assert.equal(res.status, 409, `row ${rowId}`)
  }
  assert.equal(await rooms(), count, 'a refused seat still created a room')
})

test('a course the author does not teach is a 404 at creation, and no room is made', async () => {
  const res = await call(app.base, 'POST', '/api/admin/seminars', { cookie: boris.cookie, body: { name: 'В чужой курс', seat: { courseId: course } } })
  assert.equal(res.status, 404)
  const mine = (await (await call(app.base, 'GET', '/api/admin/seminars', { cookie: boris.cookie })).json()) as AdminSeminar[]
  assert.ok(!mine.some((room) => room.name === 'В чужой курс'))
  const bad = await call(app.base, 'POST', '/api/admin/seminars', { cookie: anna.cookie, body: { name: 'X', seat: { rowId: 'r1' } } })
  assert.equal(bad.status, 400)
})

test('the notebook import seats too, and the GitHub import refuses a foreign course before going to the network', async () => {
  const row = (await courseNow()).items.find((item) => item.kind === 'planned' && !item.pause && item.name === 'Функции')!
  const res = await call(app.base, 'POST', '/api/admin/import/notebook', {
    cookie: anna.cookie,
    body: { cells: [{ cell_type: 'code', source: 'print(1)' }], filename: 'functions.ipynb', seat: { courseId: course, rowId: row.id } },
  })
  assert.equal(res.status, 201)
  const made = (await res.json()) as ImportResult
  assert.deepEqual(made.seat, { courseId: course, rowId: row.id, replaced: true })
  assert.ok(isRoomTeacher(anna.teacher.id, made.id))

  const github = await call(app.base, 'POST', '/api/admin/import', {
    cookie: boris.cookie,
    body: { url: 'https://github.com/colloq-edu/colloq/blob/main/x.ipynb', seat: { courseId: course } },
  })
  assert.equal(github.status, 404)
})

test('a room created against the scripted door belongs to the staff member who made it', async () => {
  const res = await call(app.base, 'POST', '/api/sessions', { cookie: boris.cookie, body: { name: 'Скрипт' } })
  assert.equal(res.status, 201)
  const { session } = (await res.json()) as CreateSessionResponse
  assert.ok(isRoomTeacher(boris.teacher.id, session.id))
})

/* ------------------------------------------------- the plan's references */

test('the plan seats only rooms the writer teaches, and links only its own pages', async () => {
  const theirs = (await (await call(app.base, 'POST', '/api/admin/seminars', { cookie: boris.cookie, body: { name: 'Комната Бориса' } })).json()) as AdminSeminar
  const items = (await courseNow()).items
  const smuggled = await putItems(anna.cookie, [...items, { kind: 'seminar', sessionId: theirs.id }])
  assert.equal(smuggled.status, 403, 'a teacher pulled another teacher\'s room into their course')

  // Rows already in the course pass as they are: saving the order never fails on a co-teacher's room.
  assert.equal((await putItems(anna.cookie, items)).status, 200)

  const foreign = writePublication({ sessionId: theirs.id, title: 'Страница Бориса', by: null, materials: [], blobs: [] })
  const hijack = await putItems(anna.cookie, [...items, { kind: 'gone', name: 'Старая', at: 1, publication: { id: foreign.id } }])
  assert.equal(hijack.status, 403, 'a tombstone took over another course\'s page')

  // The owner may seat any room.
  assert.equal((await putItems(owner.cookie, [...items, { kind: 'seminar', sessionId: theirs.id }])).status, 200)
})

/* --------------------------------------------------------- the teachers */

test('a course teacher adds a colleague, invites a new one by address, and cannot leave the course with nobody', async () => {
  const add = await call(app.base, 'POST', `/api/admin/courses/${course}/teachers`, { cookie: anna.cookie, body: { staffId: boris.teacher.id } })
  assert.equal(add.status, 201)
  const { teachers } = (await add.json()) as { teachers: MemberTeacher[] }
  assert.deepEqual(teachers.map((t) => t.id), [anna.teacher.id, boris.teacher.id])
  assert.equal(teachers[1].email, boris.teacher.email)

  const invited = await call(app.base, 'POST', `/api/admin/courses/${course}/teachers/invite`, {
    cookie: anna.cookie,
    body: { email: 'New.Assistant@Example.edu', name: 'Новый Ассистент' },
  })
  assert.equal(invited.status, 201)
  const fresh = (await invited.json()) as InviteTeacherResponse
  assert.equal(fresh.created, true)
  assert.match(fresh.signInUrl ?? '', /\/admin\/k\//)
  assert.equal(fresh.teacher.role, 'teacher')
  assert.equal(getTeacherByEmail('new.assistant@example.edu')?.id, fresh.teacher.id)

  // An address already on the list is added, and its link is not handed to whoever typed it.
  const existing = await call(app.base, 'POST', `/api/admin/courses/${course}/teachers/invite`, {
    cookie: anna.cookie,
    body: { email: owner.teacher.email, name: 'что угодно' },
  })
  assert.equal(existing.status, 200)
  const again = (await existing.json()) as InviteTeacherResponse
  assert.equal(again.created, false)
  assert.equal(again.signInUrl, null, 'an owner\'s sign-in link was handed to a teacher')

  for (const id of [boris.teacher.id, fresh.teacher.id, owner.teacher.id]) {
    assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course}/teachers/${id}`, { cookie: anna.cookie })).status, 200)
  }
  // Anna is the last one: she cannot remove herself, an owner can.
  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course}/teachers/${anna.teacher.id}`, { cookie: anna.cookie })).status, 409)
  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course}/teachers/${anna.teacher.id}`, { cookie: owner.cookie })).status, 200)
  assert.equal((await call(app.base, 'GET', `/api/admin/courses/${course}`, { cookie: anna.cookie })).status, 404, 'Anna still sees the course she left')
  assert.equal((await call(app.base, 'POST', `/api/admin/courses/${course}/teachers`, { cookie: owner.cookie, body: { staffId: anna.teacher.id } })).status, 201)
})

test('a room outside courses keeps its last own teacher unless an owner removes them', async () => {
  const room = (await (await call(app.base, 'POST', '/api/admin/seminars', { cookie: anna.cookie, body: { name: 'Факультатив' } })).json()) as AdminSeminar
  const added = await call(app.base, 'POST', `/api/admin/seminars/${room.id}/teachers`, { cookie: anna.cookie, body: { staffId: boris.teacher.id } })
  assert.deepEqual(((await added.json()) as { teachers: MemberTeacher[] }).teachers.map((t) => t.id), [anna.teacher.id, boris.teacher.id])
  // Boris now runs it and sees it.
  const borisRooms = (await (await call(app.base, 'GET', '/api/admin/seminars', { cookie: boris.cookie })).json()) as AdminSeminar[]
  assert.ok(borisRooms.some((one) => one.id === room.id))

  assert.equal((await call(app.base, 'DELETE', `/api/admin/seminars/${room.id}/teachers/${anna.teacher.id}`, { cookie: boris.cookie })).status, 200)
  assert.equal((await call(app.base, 'DELETE', `/api/admin/seminars/${room.id}/teachers/${boris.teacher.id}`, { cookie: boris.cookie })).status, 409)
  assert.equal((await call(app.base, 'DELETE', `/api/admin/seminars/${room.id}/teachers/${anna.teacher.id}`, { cookie: owner.cookie })).status, 404, 'removing someone who is not a teacher here')
  assert.equal((await call(app.base, 'DELETE', `/api/admin/seminars/${room.id}/teachers/${boris.teacher.id}`, { cookie: owner.cookie })).status, 200)
})
