/**
 * Who sees which room, course and page in the panel (0.19).
 *
 * A university install has many teachers, and until 0.19 every one of them
 * saw — and could change — every room and course on the instance. Now a
 * teacher sees what they teach: their own rooms, and the rooms of the courses
 * they teach; an owner sees everything when they ask for it. What is checked
 * here is the list AND the door: a room hidden from a list but still editable
 * by id would be a filter, not access control, so every per-id route answers
 * 404 for what the caller does not teach, exactly as for what does not exist.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AdminSeminar, TeacherWithCourses, InstanceResources } from '../shared/admin.js'
import type { Course } from '../shared/publish.js'
import { writePublication } from '../server/src/publish/store.js'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running
const owner = staffMember('Владелец Ольга', 'owner')
const anna = staffMember('Анна Белова')
const boris = staffMember('Борис Волков')
let roomA = ''
let roomB = ''
let roomO = ''
let courseB = ''

const get = async <T,>(path: string, cookie: string): Promise<T> => {
  const res = await call(app.base, 'GET', path, { cookie })
  assert.equal(res.status, 200, `${path}: ${res.status}`)
  return (await res.json()) as T
}

before(async () => {
  app = await startApp()
  // Anna's room outside courses, with memory set so the resources list names it.
  const a = await call(app.base, 'POST', '/api/admin/seminars', { cookie: anna.cookie, body: { name: 'Анна: без курса', memoryMb: 1024 } })
  assert.equal(a.status, 201)
  roomA = ((await a.json()) as AdminSeminar).id

  // Boris's course, and a room seated in it in the same request.
  const c = await call(app.base, 'POST', '/api/admin/courses', { cookie: boris.cookie, body: { name: 'Курс Бориса' } })
  courseB = ((await c.json()) as { course: Course }).course.id
  const b = await call(app.base, 'POST', '/api/admin/seminars', {
    cookie: boris.cookie,
    body: { name: 'Борис: неделя 1', seat: { courseId: courseB } },
  })
  assert.equal(b.status, 201)
  roomB = ((await b.json()) as AdminSeminar).id

  const o = await call(app.base, 'POST', '/api/admin/seminars', { cookie: owner.cookie, body: { name: 'Владелец: своя', memoryMb: 1024 } })
  roomO = ((await o.json()) as AdminSeminar).id
})

after(() => app?.close())

/* ------------------------------------------------------------ the lists */

test('a teacher lists the rooms they teach; an owner lists theirs, or every room when asked', async () => {
  const ids = (rows: AdminSeminar[]) => rows.map((row) => row.id).sort()
  assert.deepEqual(ids(await get('/api/admin/seminars', anna.cookie)), [roomA])
  // Boris's room is his through the course, not through a row of his own.
  assert.deepEqual(ids(await get('/api/admin/seminars', boris.cookie)), [roomB])
  assert.deepEqual(ids(await get('/api/admin/seminars', owner.cookie)), [roomO])
  const all = await get<AdminSeminar[]>('/api/admin/seminars?scope=all', owner.cookie)
  for (const id of [roomA, roomB, roomO]) assert.ok(all.some((row) => row.id === id), `owner's «Все» misses ${id}`)
})

test('«Все» is the owner\'s: a teacher asking for it is refused in words, not given a narrowed list', async () => {
  for (const path of ['/api/admin/seminars?scope=all', '/api/admin/courses?scope=all']) {
    const res = await call(app.base, 'GET', path, { cookie: anna.cookie })
    assert.equal(res.status, 403, path)
    const body = (await res.json()) as { error: string; reason: string }
    assert.equal(body.reason, 'forbidden')
    assert.ok(body.error.length > 0)
  }
})

test('a row says who teaches the room and whether it is the viewer\'s', async () => {
  const [mine] = await get<AdminSeminar[]>('/api/admin/seminars', anna.cookie)
  assert.deepEqual(mine.teachers, [{ id: anna.teacher.id, name: anna.teacher.name }])
  assert.equal(mine.mine, true)
  const [seated] = await get<AdminSeminar[]>('/api/admin/seminars', boris.cookie)
  assert.deepEqual(seated.courses, [{ id: courseB, name: 'Курс Бориса' }])
  assert.equal(seated.mine, true, 'a course teacher\'s room is theirs')
  const all = await get<AdminSeminar[]>('/api/admin/seminars?scope=all', owner.cookie)
  assert.equal(all.find((row) => row.id === roomA)?.mine, false, 'the owner sees Anna\'s room by role, not as theirs')
})

test('courses: a teacher lists the ones they teach, with who teaches them', async () => {
  assert.deepEqual(await get<{ courses: Course[] }>('/api/admin/courses', anna.cookie), { courses: [] })
  const { courses } = await get<{ courses: Course[] }>('/api/admin/courses', boris.cookie)
  assert.deepEqual(courses.map((course) => course.id), [courseB])
  assert.deepEqual(courses[0].teachers, [{ id: boris.teacher.id, name: boris.teacher.name }])
  assert.equal(courses[0].mine, true)
  const everything = await get<{ courses: Course[] }>('/api/admin/courses?scope=all', owner.cookie)
  assert.equal(everything.courses.find((course) => course.id === courseB)?.mine, false)
})

/* --------------------------------------------------------- the doors */

test('every per-id route answers 404 for a room or course the caller does not teach', async () => {
  const refused: [string, string, unknown?][] = [
    ['PATCH', `/api/admin/seminars/${roomB}`, { name: 'Чужое' }],
    ['GET', `/api/admin/seminars/${roomB}/teachers`],
    ['POST', `/api/admin/seminars/${roomB}/teachers`, { staffId: anna.teacher.id }],
    ['GET', `/api/admin/seminars/${roomB}/publish`],
    ['POST', `/api/admin/seminars/${roomB}/publish`, { notebooks: [{ root: 'cells', name: 'Т' }], files: [], ack: [] }],
    ['POST', `/api/admin/seminars/${roomB}/publish/refresh`],
    ['DELETE', `/api/admin/seminars/${roomB}/publish`],
    ['GET', `/api/admin/courses/${courseB}`],
    ['PATCH', `/api/admin/courses/${courseB}`, { name: 'Захват' }],
    ['PUT', `/api/admin/courses/${courseB}/items`, { rev: 0, items: [] }],
    ['GET', `/api/admin/courses/${courseB}/teachers`],
    ['POST', `/api/admin/courses/${courseB}/teachers`, { staffId: anna.teacher.id }],
    ['POST', `/api/admin/courses/${courseB}/teachers/invite`, { email: 'x@example.edu', name: 'X' }],
    ['PUT', `/api/admin/slug/course/${courseB}`, { slug: 'zahvat' }],
  ]
  for (const [method, path, body] of refused) {
    const res = await call(app.base, method, path, { cookie: anna.cookie, body })
    assert.equal(res.status, 404, `${method} ${path} answered ${res.status}`)
  }
  // Nothing changed behind the refusals.
  const { course } = await get<{ course: Course }>(`/api/admin/courses/${courseB}`, boris.cookie)
  assert.equal(course.name, 'Курс Бориса')
  assert.equal(course.slug, null)
  // And the owner still reaches everything.
  assert.equal((await call(app.base, 'PATCH', `/api/admin/seminars/${roomB}`, { cookie: owner.cookie, body: { archived: false } })).status, 200)
})

test('pages: listed and changed only through a room or course the caller teaches', async () => {
  const pub = writePublication({ sessionId: roomB, title: 'Страница Бориса', by: null, materials: [], blobs: [] })
  const listed = async (cookie: string) =>
    (await get<{ publications: { id: string }[] }>('/api/admin/publications', cookie)).publications.map((p) => p.id)
  assert.ok(!(await listed(anna.cookie)).includes(pub.id))
  assert.ok((await listed(boris.cookie)).includes(pub.id))
  assert.ok((await listed(owner.cookie)).includes(pub.id))
  for (const [method, path, body] of [
    ['DELETE', `/api/admin/publications/${pub.id}`],
    ['POST', `/api/admin/publications/${pub.id}/restore`],
    ['PATCH', `/api/admin/publications/${pub.id}`, { roomAccess: 'none' }],
    ['PUT', `/api/admin/slug/publication/${pub.id}`, { slug: 'boris-1' }],
  ] as [string, string, unknown?][]) {
    assert.equal((await call(app.base, method, path, { cookie: anna.cookie, body })).status, 404, `${method} ${path}`)
  }
  assert.equal((await call(app.base, 'DELETE', `/api/admin/publications/${pub.id}`, { cookie: boris.cookie })).status, 200)
})

test('the staff list names a teacher\'s courses only to someone who may see them', async () => {
  const of = (rows: TeacherWithCourses[], id: string) => rows.find((row) => row.id === id)?.courses
  assert.deepEqual(of(await get('/api/admin/teachers', owner.cookie), boris.teacher.id), [{ id: courseB, name: 'Курс Бориса' }])
  assert.deepEqual(of(await get('/api/admin/teachers', boris.cookie), boris.teacher.id), [{ id: courseB, name: 'Курс Бориса' }])
  // Anna still finds Boris in the picker, but not the name of his course.
  assert.deepEqual(of(await get('/api/admin/teachers', anna.cookie), boris.teacher.id), [])
})

test('the machine\'s room list names only the viewer\'s rooms; its sums stay the whole machine\'s', async () => {
  const forAnna = await get<InstanceResources>('/api/instance/resources', anna.cookie)
  const forOwner = await get<InstanceResources>('/api/instance/resources', owner.cookie)
  assert.ok(!forAnna.rooms.some((room) => room.id === roomO), 'Anna read the owner\'s room on the machine list')
  assert.ok(forOwner.rooms.some((room) => room.id === roomO))
  assert.equal(forAnna.memory.totalMb, forOwner.memory.totalMb)
})
