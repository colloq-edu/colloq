/**
 * «Преподаватели» since 0.19: the «Курсы» column and the owner's way of
 * putting a colleague into courses from it (web/src/admin/staff-courses.ts),
 * and the course colour square every screen draws (web/src/admin/course-color.ts).
 *
 * A teacher in no course sees an empty panel, so this column is where an
 * owner notices it — and where a teacher looking at the same list must not be
 * told something false about a colleague whose courses they cannot see.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addableCourses,
  coursesCell,
  joinCourses,
  withCourse,
  withoutCourse,
} from '../web/src/admin/staff-courses.js'
import { COURSE_COLORS, courseColor } from '../web/src/admin/course-color.js'

const ml = { id: 'ml', name: 'МЛ | сильная группа' }
const base = { id: 'base', name: 'МЛ | базовая группа' }
const data = { id: 'data', name: 'Анализ данных, ПМИ 3 курс' }
const ege = { id: 'ege', name: 'Подготовка к ЕГЭ' }

test('the courses cell: chips, an owner who sees all, and a warning only an owner can trust', () => {
  assert.deepEqual(coursesCell({ role: 'teacher', courses: [ml, base] }, true), { kind: 'chips', courses: [ml, base] })
  assert.deepEqual(coursesCell({ role: 'owner', courses: [ml, base] }, true), { kind: 'owner', teaches: 2 }, '«видит все курсы · ведёт 2»')
  assert.deepEqual(
    coursesCell({ role: 'owner', courses: [ml] }, false),
    { kind: 'owner', teaches: null },
    'a teacher sees a trimmed list: no count of an owner\'s courses',
  )
  assert.deepEqual(coursesCell({ role: 'teacher', courses: [] }, true), { kind: 'none' }, '«ещё ни в одном курсе»')
  assert.deepEqual(
    coursesCell({ role: 'teacher', courses: [] }, false),
    { kind: 'unshared' },
    'to a teacher an empty list means «none in common», not «in none»',
  )
  assert.deepEqual(coursesCell({ role: 'teacher' }, true), { kind: 'none' }, 'an older server without the field')
})

test('«+ курс» offers the courses the person does not teach, by name, narrowed by words', () => {
  const all = [ege, ml, data, base]
  assert.deepEqual(
    addableCourses(all, [ml]).map((c) => c.id),
    ['data', 'base', 'ege'],
    'what they already teach is not offered; the rest by name',
  )
  assert.deepEqual(addableCourses(all, [], 'мл баз').map((c) => c.id), ['base'], 'every word starts a word of the name')
  assert.deepEqual(addableCourses(all, [], 'пми').map((c) => c.id), ['data'])
  assert.deepEqual(addableCourses(all, [], 'егэ').map((c) => c.id), ['ege'], 'case does not matter')
  assert.deepEqual(addableCourses([{ id: 'x', name: 'Объёмы' }], [], 'объем').map((c) => c.id), ['x'], '«ё» is «е»')
  assert.deepEqual(addableCourses(all, [], 'руппа'), [], 'the middle of a word is not a match')
  assert.deepEqual(addableCourses(all, all), [], 'teaching every course leaves nothing to offer')
})

test('a row after a course is added or removed', () => {
  const vera = { id: 'v', role: 'teacher' as const, courses: [ml] }
  assert.deepEqual(withCourse(vera, base).courses, [ml, base], 'appended')
  assert.deepEqual(withCourse(vera, ml).courses, [ml], 'never twice')
  assert.deepEqual(withoutCourse(vera, 'ml').courses, [])
  assert.deepEqual(vera.courses, [ml], 'the old row is left as it was')
  assert.deepEqual(withCourse({ id: 'n' }, ml).courses, [ml], 'a row without the field')
})

test('a new teacher joins the ticked courses one by one, and a refusal does not stop the rest', async () => {
  const asked: string[] = []
  const result = await joinCourses([ml, data, base], async (id) => {
    asked.push(id)
    if (id === 'data') throw new Error('404')
  })
  assert.deepEqual(asked, ['ml', 'data', 'base'], 'every course is tried, in order')
  assert.deepEqual(result.joined, [ml, base])
  assert.deepEqual(result.failed, [data])
  assert.deepEqual(await joinCourses([], async () => assert.fail('no call')), { joined: [], failed: [] })
})

test('a course keeps its colour: from its id, the same on every screen', () => {
  assert.equal(courseColor('ml'), courseColor('ml'))
  const seen = new Set(['ml', 'base', 'data', 'ege', 'c1', 'c2', 'c3', 'c4', 'c5'].map(courseColor))
  assert.ok(seen.size >= 3, 'different courses are told apart')
  for (const color of seen) assert.ok((COURSE_COLORS as readonly string[]).includes(color))
  assert.deepEqual(COURSE_COLORS.slice(0, 2), ['#0FA0D7', '#374B9B'], 'the mockup\'s first two')
})

/* -------------------------------------------------------------- the screen */

/** Markup and code without comments: an explanation is not a promise. */
const source = (rel: string): string =>
  fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('the Teachers screen: memberships go through the course routes, and only an owner changes them', () => {
  const screen = source('web/src/admin/screens/Teachers.svelte')
  assert.match(screen, /adminApi\.addCourseTeacher\(course\.id, t\.id\)/)
  assert.match(screen, /adminApi\.removeCourseTeacher\(course\.id, t\.id\)/)
  assert.match(screen, /adminApi\.listCourses\('all'\)/, 'the picker offers every course, not the owner\'s own')
  const load = screen.slice(screen.indexOf('async function loadCourses'), screen.indexOf('function openPicker'))
  assert.match(load, /if \(!isOwner\) return/, 'a teacher never asks for every course (403)')
  // The × and «+ курс» are drawn for owners only.
  const cell = screen.slice(screen.indexOf('{#snippet coursesOf'), screen.indexOf('{/snippet}', screen.indexOf('{#snippet coursesOf')))
  const remove = cell.indexOf('removeCourse(t, course)')
  const add = cell.indexOf('openPicker(t)')
  assert.ok(remove > 0 && add > 0)
  assert.ok(cell.lastIndexOf('{#if isOwner}', remove) > cell.lastIndexOf('{/if}', remove), 'the × sits inside an owner check')
  assert.ok(cell.lastIndexOf('{#if isOwner}', add) > cell.lastIndexOf('{/if}', add), '«+ курс» sits inside an owner check')
  // A bare Teacher from a role or name change keeps the row's courses.
  assert.match(screen, /t\.id === updated\.id \? \{ \.\.\.t, \.\.\.updated \} : t/)
  // The add form's courses are joined after the person exists, and a refusal is said.
  const create = screen.slice(screen.indexOf('async function create'), screen.indexOf('async function setRole'))
  assert.ok(create.indexOf('adminApi.createTeacher(') < create.indexOf('joinCourses('))
  assert.match(create, /admin\.teachers\.coursesNotJoined/)
})
