/**
 * The course screen's «Ведут» strip and the course list's «Мои / Все»
 * (web/src/admin/course-teachers.ts).
 *
 * These are the screen's own decisions on top of what the server already
 * enforces: whom the search offers, whose × is drawn, which room list the
 * course screen asks for and which rooms its pickers may offer. A mistake
 * here does not leak anything (the server answers 403/404/409), but it
 * draws buttons that are always refused, or a course table without its
 * rooms.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AdminSeminar, TeacherWithCourses } from '../shared/admin.js'
import {
  COURSE_SCOPE_KEY,
  STAFF_SHOWN,
  addableStaff,
  canRemoveMember,
  foldForSearch,
  invitePrefill,
  looksLikeEmail,
  orderMembers,
  pickerRooms,
  reachableSignIn,
  readCourseScope,
  saveCourseScope,
  selfRemoval,
  seminarScopeFor,
  staffMatches,
  teacherLine,
} from '../web/src/admin/course-teachers.js'

function person(id: string, name: string, email: string, courses = 0): TeacherWithCourses {
  return {
    id,
    name,
    email,
    role: 'teacher',
    createdAt: 0,
    lastSeenAt: null,
    hasLink: true,
    courses: Array.from({ length: courses }, (_, i) => ({ id: `c${i}`, name: `Курс ${i}` })),
  }
}

const staff = [
  person('s1', 'Марина Смирнова', 'm.smirnova@university.ru', 2),
  person('s2', 'Марк Петров', 'mark.p@university.ru'),
  person('s3', 'Ирина Семёнова', 'irina@university.ru', 1),
  person('s4', 'Александр К.', 'alex@university.ru', 3),
]

test('the search reads «ё» as «е», ignores case and extra spaces', () => {
  assert.equal(foldForSearch('  Семён   ПЕТРОВ '), 'семен петров')
  assert.ok(staffMatches(staff[2], 'семенова'))
  assert.ok(staffMatches(staff[2], 'СЕМЁН'))
})

test('every word must start a word of the name, or sit anywhere in the address', () => {
  assert.ok(staffMatches(staff[0], 'мар смир'))
  assert.ok(staffMatches(staff[0], 'smirnova@'))
  assert.ok(staffMatches(staff[1], 'mark.p'))
  // «ина» is inside Марина and Ирина but starts neither word: not a match.
  assert.equal(staffMatches(staff[0], 'ина'), false)
  assert.equal(staffMatches(staff[0], 'мар петр'), false)
  assert.ok(staffMatches(staff[0], ''), 'an empty query matches everyone')
})

test('the popover offers people not in the course yet, by name, cut to a screenful', () => {
  const { shown, more } = addableStaff(staff, [{ id: 's4' }], 'мар')
  assert.deepEqual(shown.map((p) => p.id), ['s1', 's2'], 'Марина before Марк, by name; the member left out')
  assert.equal(more, 0)

  const everyone = addableStaff(staff, [], '')
  assert.deepEqual(everyone.shown.map((p) => p.name), ['Александр К.', 'Ирина Семёнова', 'Марина Смирнова', 'Марк Петров'])

  const many = Array.from({ length: STAFF_SHOWN + 3 }, (_, i) => person(`m${i}`, `Преподаватель ${i}`, `t${i}@u.ru`))
  const cut = addableStaff(many, [], 'препод')
  assert.equal(cut.shown.length, STAFF_SHOWN)
  assert.equal(cut.more, 3)

  const allIn = addableStaff(staff, staff, '')
  assert.deepEqual(allIn, { shown: [], more: 0 })
})

test('an empty search prefills the invitation: an address goes to «Почта», anything else to «Имя»', () => {
  assert.deepEqual(invitePrefill(' new.person@university.ru '), { email: 'new.person@university.ru', name: '' })
  assert.deepEqual(invitePrefill('Вера Новикова'), { email: '', name: 'Вера Новикова' })
  assert.deepEqual(invitePrefill(''), { email: '', name: '' })
  assert.ok(looksLikeEmail('v.n@university.ru'))
  assert.equal(looksLikeEmail('v.n@university'), false)
  assert.equal(looksLikeEmail('вера'), false)
})

test('yourself first among the chips, the rest in the server order', () => {
  const members = [{ id: 'a' }, { id: 'me' }, { id: 'b' }]
  assert.deepEqual(orderMembers(members, 'me').map((m) => m.id), ['me', 'a', 'b'])
  assert.deepEqual(orderMembers(members, null).map((m) => m.id), ['a', 'me', 'b'])
  assert.deepEqual(orderMembers(members, 'stranger').map((m) => m.id), ['a', 'me', 'b'])
})

test('the last teacher has no × for a teacher (the server would refuse), an owner keeps it', () => {
  assert.equal(canRemoveMember(1, false), false)
  assert.equal(canRemoveMember(2, false), true)
  assert.equal(canRemoveMember(1, true), true)
  assert.equal(canRemoveMember(0, true), true)
  // What leaving costs decides the question asked before it.
  assert.equal(selfRemoval(false), 'loses')
  assert.equal(selfRemoval(true), 'keeps')
})

test('«Мои / Все» is remembered for an owner only, and a broken storage reads as «Мои»', () => {
  const store = new Map<string, string>()
  const storage = () => ({
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  })
  assert.equal(readCourseScope(true, storage), 'mine', 'nothing stored yet')
  saveCourseScope('all', storage)
  assert.equal(store.get(COURSE_SCOPE_KEY), 'all')
  assert.equal(readCourseScope(true, storage), 'all')
  assert.equal(readCourseScope(false, storage), 'mine', 'a teacher never asks for «Все»: the server answers 403')

  store.set(COURSE_SCOPE_KEY, 'everything')
  assert.equal(readCourseScope(true, storage), 'mine', 'an unknown value is not «Все»')

  const throwing = () => {
    throw new Error('SecurityError: access denied')
  }
  assert.equal(readCourseScope(true, throwing), 'mine')
  assert.doesNotThrow(() => saveCourseScope('all', throwing))
  assert.equal(readCourseScope(true, () => null), 'mine')
  assert.doesNotThrow(() => saveCourseScope('mine', () => null))
})

test('the course screen asks for every room only when an owner needs them', () => {
  // A teacher's own list holds every room of a course they teach.
  assert.equal(seminarScopeFor(false, 'mine', true), 'mine')
  assert.equal(seminarScopeFor(false, 'all', false), 'mine', 'a teacher never gets «all»')
  // An owner in a course they teach, on «Мои»: their own list is enough.
  assert.equal(seminarScopeFor(true, 'mine', true), 'mine')
  // An owner in a colleague's course: its rooms are not in the owner's list.
  assert.equal(seminarScopeFor(true, 'mine', false), 'all')
  // An owner who switched the list to «Все».
  assert.equal(seminarScopeFor(true, 'all', true), 'all')
})

test('the pickers offer the viewer\'s own rooms unless an owner asked for «Все»', () => {
  const room = (id: string, mine: boolean) => ({ id, mine }) as unknown as AdminSeminar
  const listed = [room('r1', true), room('r2', false), room('r3', true)]
  assert.deepEqual(pickerRooms(listed, false).map((r) => r.id), ['r1', 'r3'])
  assert.deepEqual(pickerRooms(listed, true).map((r) => r.id), ['r1', 'r2', 'r3'])
  // A row from an older server without `mine` is not hidden by its absence.
  const old = [{ id: 'r9' } as unknown as AdminSeminar]
  assert.deepEqual(pickerRooms(old, false).map((r) => r.id), ['r9'])
})

test('the course row names at most three teachers and counts the rest', () => {
  assert.deepEqual(teacherLine(undefined), { names: '', more: 0 })
  assert.deepEqual(teacherLine([]), { names: '', more: 0 })
  assert.deepEqual(teacherLine([{ name: 'Лера В.' }, { name: 'Борис К.' }]), { names: 'Лера В., Борис К.', more: 0 })
  assert.deepEqual(
    teacherLine([{ name: 'А' }, { name: 'Б' }, { name: 'В' }, { name: 'Г' }, { name: 'Д' }]),
    { names: 'А, Б, В', more: 2 },
  )
})

test('a sign-in link built on localhost is moved to the address the panel is open on, key intact', () => {
  assert.equal(
    reachableSignIn('http://localhost:3000/admin/in/abc123?x=1', 'https://vsos.colloq.ru'),
    'https://vsos.colloq.ru/admin/in/abc123?x=1',
  )
  assert.equal(
    reachableSignIn('https://colloq.university.ru/admin/in/abc123', 'http://10.0.0.5:3000'),
    'https://colloq.university.ru/admin/in/abc123',
    'a usable PUBLIC_URL is believed',
  )
  assert.equal(reachableSignIn('not a url', 'https://vsos.colloq.ru'), 'not a url')
})
