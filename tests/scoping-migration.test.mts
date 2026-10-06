/**
 * The first boot with course and room teachers keeps today's visibility.
 *
 * Before 0.19 every staff member saw and ran everything. An update that
 * quietly took that away would hide a teacher's own semester from them in the
 * middle of it — so the first boot with the new tables makes every existing
 * staff member a teacher of every existing course, and of every room that
 * sits in no course (a seated room is reached through its course). Once:
 * an owner who later removes someone must not see them come back on the next
 * restart. And memberships go with what they name: a deleted person, course
 * or room leaves no rows behind.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { db, createSession } from '../server/src/db.js'
import { canSeeCourse, canSeeRoom, reseedMembershipsForTest } from '../server/src/admin/access.js'
import { deleteTeacher } from '../server/src/admin/store.js'
import { createCourse, getCourse, setCourseItems } from '../server/src/publish/store.js'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running
before(async () => {
  app = await startApp()
})
after(() => app?.close())

const count = (table: 'course_teachers' | 'room_teachers', where = '1=1', ...args: string[]) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n

test('every existing staff member keeps every existing course and every room outside courses, once', () => {
  // An instance as it was before the tables: staff, courses, rooms, no memberships.
  const nina = staffMember('Нина Прежняя')
  const oleg = staffMember('Олег Прежний')
  const course = createCourse('Старый курс', null, 'Нина Прежняя')
  createSession('mig-seated', 'В курсе', null)
  createSession('mig-loose', 'Без курса', null)
  createSession('mig-open', 'Открытая, без автора', null)
  assert.ok(setCourseItems(course.id, getCourse(course.id)!.rev, [
    { kind: 'seminar', id: 'r0000001', sessionId: 'mig-seated', name: 'В курсе', publication: null },
  ]))
  db.exec('DELETE FROM course_teachers; DELETE FROM room_teachers')
  assert.equal(canSeeRoom(nina.teacher, 'mig-loose'), false)

  reseedMembershipsForTest()

  for (const { teacher } of [nina, oleg]) {
    assert.ok(canSeeCourse(teacher, course.id), `${teacher.name} lost the course`)
    for (const room of ['mig-seated', 'mig-loose', 'mig-open']) {
      assert.ok(canSeeRoom(teacher, room), `${teacher.name} lost ${room}`)
    }
  }
  // The seated room is reached through its course, not copied into room_teachers.
  assert.equal(count('room_teachers', 'session_id = ?', 'mig-seated'), 0)
  assert.equal(count('room_teachers', 'session_id = ?', 'mig-open'), 2)

  // Once: a later boot does not bring back someone an owner removed.
  db.prepare('DELETE FROM course_teachers WHERE course_id = ? AND staff_id = ?').run(course.id, oleg.teacher.id)
  reseedMembershipsForTest(false)
  assert.equal(canSeeCourse(oleg.teacher, course.id), false, 'the migration ran again and undid an owner\'s decision')
})

test('someone who arrives after the migration starts with nothing', () => {
  const newcomer = staffMember('Новенький')
  createSession('mig-later', 'Позже', null)
  assert.equal(canSeeRoom(newcomer.teacher, 'mig-later'), false)
  assert.equal(canSeeRoom(newcomer.teacher, 'mig-loose'), false, 'the migration ran for a person it did not know')
})

test('memberships go with the person, the course and the room they name', async () => {
  const owner = staffMember('Владелец Миграции', 'owner')
  const pavel = staffMember('Павел Уходящий')
  const made = await call(app.base, 'POST', '/api/admin/courses', { cookie: pavel.cookie, body: { name: 'Курс Павла' } })
  const { course } = (await made.json()) as { course: { id: string } }
  const room = (await (await call(app.base, 'POST', '/api/admin/seminars', { cookie: pavel.cookie, body: { name: 'Комната Павла' } })).json()) as { id: string }
  assert.equal(count('course_teachers', 'course_id = ?', course.id), 1)
  assert.equal(count('room_teachers', 'session_id = ?', room.id), 1)

  // The course, deleted by an owner, takes its teachers with it.
  assert.equal((await call(app.base, 'DELETE', `/api/admin/courses/${course.id}`, { cookie: owner.cookie })).status, 200)
  assert.equal(count('course_teachers', 'course_id = ?', course.id), 0)

  // The room too.
  assert.equal((await call(app.base, 'DELETE', `/api/admin/seminars/${room.id}`, { cookie: owner.cookie })).status, 204)
  assert.equal(count('room_teachers', 'session_id = ?', room.id), 0)

  // And the person.
  const other = (await (await call(app.base, 'POST', '/api/admin/seminars', { cookie: pavel.cookie, body: { name: 'Ещё одна' } })).json()) as { id: string }
  assert.equal(count('room_teachers', 'staff_id = ?', pavel.teacher.id), 1)
  assert.equal(deleteTeacher(pavel.teacher.id), true)
  assert.equal(count('room_teachers', 'staff_id = ?', pavel.teacher.id), 0)
  assert.equal(count('room_teachers', 'session_id = ?', other.id), 0)
})
