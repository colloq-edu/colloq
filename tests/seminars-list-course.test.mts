/**
 * «Добавить в курс…» on the classes list (0.25): a class in no course goes
 * into one from its own row.
 *
 * The owner's words: «назначить занятию без курса курс в списке занятий».
 * The door is the class's PATCH with a `seat` — the same check and the same
 * write as a creation that asks for one (admin/seat.ts) — so the class lands
 * at the end of the course as the course screen's «добавить занятие» puts it,
 * and the list's answer carries the course, which is what draws the row under
 * it at once. Pinned here: the course row and the course screen's door still
 * owning it, the list's answer and its group, the refusals (a course the
 * teacher cannot edit, a class already in a course, a class they do not
 * teach, a seat that is not one), and what the row and its menu offer.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AdminErrorBody, AdminSeminar } from '../shared/admin.js'
import type { Course, CourseItem } from '../shared/publish.js'
import { canSeat, groupRows, seatChoices, seatLinkShown, seatsOf } from '../web/src/admin/seminar-list.js'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running

before(async () => {
  app = await startApp()
})

after(() => app?.close())

const owner = staffMember('Владелец', 'owner')
const teacher = staffMember('Мария Преподаватель')
const stranger = staffMember('Олег Другой')

async function course(cookie: string, name: string): Promise<Course> {
  const res = await call(app.base, 'POST', '/api/admin/courses', { cookie, body: { name } })
  assert.equal(res.status, 200)
  return ((await res.json()) as { course: Course }).course
}

async function courseOf(id: string): Promise<Course> {
  const res = await call(app.base, 'GET', `/api/admin/courses/${id}`, { cookie: owner.cookie })
  assert.equal(res.status, 200)
  return ((await res.json()) as { course: Course }).course
}

async function room(cookie: string, name: string, courseId?: string): Promise<AdminSeminar> {
  const res = await call(app.base, 'POST', '/api/admin/seminars', {
    cookie,
    body: { name, ...(courseId ? { seat: { courseId } } : {}) },
  })
  assert.equal(res.status, 201)
  return (await res.json()) as AdminSeminar
}

function seat(cookie: string, roomId: string, seatBody: unknown): Promise<globalThis.Response> {
  return call(app.base, 'PATCH', `/api/admin/seminars/${roomId}`, { cookie, body: { seat: seatBody } })
}

async function rowOf(cookie: string, roomId: string): Promise<AdminSeminar> {
  const res = await call(app.base, 'GET', '/api/admin/seminars', { cookie })
  assert.equal(res.status, 200)
  const found = ((await res.json()) as AdminSeminar[]).find((row) => row.id === roomId)
  assert.ok(found, `${roomId} is on the list`)
  return found
}

const roomsIn = (c: Course): string[] =>
  c.items.flatMap((item: CourseItem) => (item.kind === 'seminar' ? [item.sessionId] : []))

/* ------------------------------------------------------------- the door */

test('a class outside courses goes into a course from its row, as the course screen puts a class there', async () => {
  const ml = await course(owner.cookie, 'Машинное обучение')
  const loose = await room(owner.cookie, 'Факультатив по pandas')
  assert.deepEqual(loose.courses, [])
  const was = await courseOf(ml.id)

  const res = await seat(owner.cookie, loose.id, { courseId: ml.id })
  assert.equal(res.status, 200)
  const seated = (await res.json()) as AdminSeminar
  // The answer is the class with its course: the row moves under it at once.
  assert.deepEqual(seated.courses, [{ id: ml.id, name: 'Машинное обучение' }])
  assert.equal(seated.seat?.courseId, ml.id)
  assert.equal(seated.seat?.replaced, false)

  // One write, at the end of the course: the row the course screen appends.
  const now = await courseOf(ml.id)
  assert.equal(now.rev, was.rev + 1)
  const last = now.items.at(-1)!
  assert.equal(last.kind, 'seminar')
  assert.equal(last.id, seated.seat?.rowId)
  assert.deepEqual(
    { sessionId: last.kind === 'seminar' ? last.sessionId : null, name: last.name },
    { sessionId: loose.id, name: 'Факультатив по pandas' },
  )

  // The course screen's own door appends a second class beside it, and keeps
  // the first as the list put it: one shape of row, one owner of the plan.
  const other = await room(owner.cookie, 'Неделя 2')
  const put = await call(app.base, 'PUT', `/api/admin/courses/${ml.id}/items`, {
    cookie: owner.cookie,
    body: {
      rev: now.rev,
      items: [...now.items, { kind: 'seminar', sessionId: other.id, name: other.name, publication: null }],
    },
  })
  assert.equal(put.status, 200)
  const both = ((await put.json()) as { course: Course }).course
  assert.deepEqual(roomsIn(both), [loose.id, other.id])
  assert.equal(both.items[0]!.id, last.id, 'the course screen kept the row the list wrote')
  assert.deepEqual(Object.keys(both.items[0]!).sort(), Object.keys(both.items[1]!).sort())

  // The list says so on the next read too, and draws it in the course's group, numbered.
  const listed = await rowOf(owner.cookie, loose.id)
  assert.deepEqual(listed.courses, [{ id: ml.id, name: 'Машинное обучение' }])
  const groups = groupRows([listed], [{ id: ml.id, name: ml.name }], seatsOf([both]), 'all', '2026-10-20')
  assert.deepEqual(
    groups.map((group) => [group.key, group.rows.map((row) => [row.seminar.id, row.n])]),
    [[`course:${ml.id}`, [[loose.id, 1]]]],
  )
})

test('a plan row can be taken, as at creation', async () => {
  const c = await course(owner.cookie, 'Курс с планом')
  const planned = await call(app.base, 'PUT', `/api/admin/courses/${c.id}/items`, {
    cookie: owner.cookie,
    body: { rev: c.rev, items: [{ kind: 'planned', name: 'Деревья решений', when: '', day: '2026-11-01' }] },
  })
  assert.equal(planned.status, 200)
  const rowId = ((await planned.json()) as { course: Course }).course.items[0]!.id!
  const loose = await room(owner.cookie, 'Неделя 3 (повтор)')

  const res = await seat(owner.cookie, loose.id, { courseId: c.id, rowId })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as AdminSeminar).seat?.replaced, true)
  const [item] = (await courseOf(c.id)).items
  assert.equal(item!.kind, 'seminar')
  // The plan row's topic and day go with it: the class is still «Деревья решений».
  assert.equal(item!.title, 'Деревья решений')
  assert.equal(item!.day, '2026-11-01')
})

/* ----------------------------------------------------------- refusals */

test('a teacher who cannot edit the course is refused, and the course is untouched', async () => {
  const theirs = await course(owner.cookie, 'Курс владельца')
  const mine = await room(teacher.cookie, 'Консультация перед экзаменом')

  const res = await seat(teacher.cookie, mine.id, { courseId: theirs.id })
  // The 404 of a course that does not exist: an id must not tell a teacher
  // that someone else's course is behind it.
  assert.equal(res.status, 404)
  assert.equal(((await res.json()) as AdminErrorBody).reason, 'invalid')
  assert.deepEqual((await courseOf(theirs.id)).items, [])
  assert.deepEqual((await rowOf(teacher.cookie, mine.id)).courses, [])
})

test('a class already in a course is refused by this action, and stays where it was', async () => {
  const a = await course(teacher.cookie, 'Курс А')
  const b = await course(teacher.cookie, 'Курс Б')
  const inA = await room(teacher.cookie, 'Неделя 1. Свёртки', a.id)
  assert.deepEqual(inA.courses, [{ id: a.id, name: 'Курс А' }])

  const res = await seat(teacher.cookie, inA.id, { courseId: b.id })
  assert.equal(res.status, 409)
  // Said with the course it is in: moving is the course screen's.
  assert.match(((await res.json()) as AdminErrorBody).error, /Курс А/)
  assert.deepEqual(roomsIn(await courseOf(b.id)), [])
  assert.deepEqual(roomsIn(await courseOf(a.id)), [inA.id])
  // An owner, who sees every course, is refused the same.
  assert.equal((await seat(owner.cookie, inA.id, { courseId: b.id })).status, 409)
})

test('a refused seat leaves the rest of the request unwritten, as a refused environment does', async () => {
  const theirs = await course(owner.cookie, 'Ещё один курс владельца')
  const mine = await room(teacher.cookie, 'До переименования')
  const res = await call(app.base, 'PATCH', `/api/admin/seminars/${mine.id}`, {
    cookie: teacher.cookie,
    body: { name: 'После переименования', archived: true, seat: { courseId: theirs.id } },
  })
  assert.equal(res.status, 404)
  const row = await rowOf(teacher.cookie, mine.id)
  assert.deepEqual([row.name, row.archivedAt, row.courses], ['До переименования', null, []])
})

test('a seat in the same request as a rename goes into the course under the new name', async () => {
  const c = await course(owner.cookie, 'Курс для переименованного')
  const loose = await room(owner.cookie, 'Черновик названия')
  const res = await call(app.base, 'PATCH', `/api/admin/seminars/${loose.id}`, {
    cookie: owner.cookie,
    body: { name: 'Неделя 4. Бустинг', seat: { courseId: c.id } },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(((await res.json()) as AdminSeminar).courses, [{ id: c.id, name: 'Курс для переименованного' }])
  assert.equal((await courseOf(c.id)).items.at(-1)!.name, 'Неделя 4. Бустинг')
})

test('a class the teacher does not teach is the 404 of a missing class', async () => {
  const notTheirs = await room(owner.cookie, 'Занятие владельца')
  const theirCourse = await course(stranger.cookie, 'Курс Олега')
  const res = await seat(stranger.cookie, notTheirs.id, { courseId: theirCourse.id })
  assert.equal(res.status, 404)
  assert.deepEqual((await courseOf(theirCourse.id)).items, [])
})

test('a seat that names no course is a refusal in words', async () => {
  const loose = await room(owner.cookie, 'Без курса пока')
  for (const bad of [null, {}, { courseId: '' }, { courseId: 7 }]) {
    const res = await seat(owner.cookie, loose.id, bad)
    assert.equal(res.status, 400, JSON.stringify(bad))
    assert.ok(((await res.json()) as AdminErrorBody).error)
  }
  assert.deepEqual((await rowOf(owner.cookie, loose.id)).courses, [])
})

test('a class only in a course its teacher cannot see is «Без курса» to them, and may go into theirs', async () => {
  // The owner seats the teacher's class into a course the teacher is not in.
  const ownersCourse = await course(owner.cookie, 'Курс без Марии')
  const shared = await room(teacher.cookie, 'Общая консультация')
  assert.equal((await seat(owner.cookie, shared.id, { courseId: ownersCourse.id })).status, 200)
  const seen = await rowOf(teacher.cookie, shared.id)
  assert.deepEqual(seen.courses, [], 'the stranger course is not named to her')
  assert.equal(canSeat(seen), true)

  // Her own course takes it, as her course screen would: the class is in both.
  const hers = await course(teacher.cookie, 'Курс Марии')
  assert.equal((await seat(teacher.cookie, shared.id, { courseId: hers.id })).status, 200)
  assert.deepEqual((await rowOf(teacher.cookie, shared.id)).courses, [{ id: hers.id, name: 'Курс Марии' }])
  assert.deepEqual(roomsIn(await courseOf(ownersCourse.id)), [shared.id])
})

/* ---------------------------------------------------------- the screen */

const row = (fields: Partial<AdminSeminar>): Pick<AdminSeminar, 'courses' | 'archivedAt'> => ({
  courses: [],
  archivedAt: null,
  ...fields,
})

test('only a class in no course, outside the archive, offers «Добавить в курс…»', () => {
  assert.equal(canSeat(row({})), true)
  assert.equal(canSeat(row({ courses: [{ id: 'c1', name: 'Курс' }] })), false)
  assert.equal(canSeat(row({ archivedAt: Date.UTC(2026, 9, 1) })), false)
})

test('the row carries the link only with a course to choose; the menu keeps the item, which says why', () => {
  const choices = [{ id: 'a', name: 'Мой курс' }]
  assert.equal(seatLinkShown(row({}), choices), true)
  // A teacher who teaches no course: no dead end on every row.
  assert.equal(seatLinkShown(row({}), []), false)
  assert.equal(canSeat(row({})), true)
  assert.equal(seatLinkShown(row({ courses: [{ id: 'c1', name: 'Курс' }] }), choices), false)
})

test('the menu offers the courses by the list’s scope: a teacher’s own, an owner’s «Мои» or «Все»', () => {
  const courses = [
    { id: 'a', name: 'Мой курс', mine: true },
    { id: 'b', name: 'Чужой курс', mine: false },
    // A course list from an older server, without the flag: it is the viewer's.
    { id: 'c', name: 'Курс без флага' },
  ]
  assert.deepEqual(seatChoices(courses, 'mine').map((c) => c.id), ['a', 'c'])
  assert.deepEqual(seatChoices(courses, 'all').map((c) => c.id), ['a', 'b', 'c'])
  assert.deepEqual(seatChoices([], 'all'), [])
})
