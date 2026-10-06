/**
 * The «Занятия» list (web/src/admin/seminar-list.ts): folders, tabs, groups
 * and the numbers beside them.
 *
 * Every figure on that screen — the rail, the tabs, the nav row — is counted
 * by these functions from the same rows, and the cases below are the ones
 * where two of them would otherwise disagree: a room in two courses, an
 * archived room, a room set up a week before its class, a room people came
 * to and left without the teacher ending it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AdminSeminar } from '../shared/admin.js'
import type { Course, CourseItem } from '../shared/publish.js'
import {
  folderCounts,
  groupRows,
  inFolder,
  matches,
  phaseForTabs,
  phaseOf,
  railCourses,
  readScope,
  seatsOf,
  tabCounts,
} from '../web/src/admin/seminar-list.js'

const TODAY = '2026-10-06'
const at = (day: string): number => new Date(`${day}T12:00:00`).getTime()

function room(id: string, fields: Partial<AdminSeminar> = {}): AdminSeminar {
  return {
    id,
    name: `Room ${id}`,
    createdAt: at('2026-10-01'),
    status: 'draft',
    liveCount: 0,
    totalParticipants: 0,
    cellCount: 0,
    fileCount: 0,
    url: `http://x/s/${id}`,
    createdBy: null,
    environment: null,
    archivedAt: null,
    rules: {} as AdminSeminar['rules'],
    publication: null,
    courses: [],
    teachers: [],
    mine: true,
    finishedAt: null,
    ...fields,
  }
}

const seat = (sessionId: string, day: string | null = null): CourseItem => ({
  kind: 'seminar',
  sessionId,
  name: sessionId,
  publication: null,
  day,
})
const plan = (name: string, pause = false): CourseItem => ({ kind: 'planned', name, when: '', pause })

function course(id: string, items: CourseItem[]): Course {
  return { id, slug: null, name: `Course ${id}`, blurb: null, createdAt: 0, createdBy: null, items, rev: 1 }
}

/* --------------------------------------------------------------- seats */

test('a seated room takes its number among numbered rows and its planned day', () => {
  const c = course('a', [plan('intro'), plan('holidays', true), seat('r1', '2026-10-11'), seat('r2')])
  const seats = seatsOf([c]).get('a')!
  // The break has no number, so r1 is the second numbered row, not the third.
  assert.deepEqual(seats.get('r1'), { n: 2, day: '2026-10-11' })
  assert.deepEqual(seats.get('r2'), { n: 3, day: null })
})

/* --------------------------------------------------------------- phase */

test('live and finished are what they say; between them the plan day decides', () => {
  assert.equal(phaseOf({ status: 'live' }, '2026-01-01', TODAY), 'running')
  assert.equal(phaseOf({ status: 'finished' }, '2026-12-01', TODAY), 'past', 'an ended class is behind')
  assert.equal(phaseOf({ status: 'draft' }, '2026-10-11', TODAY), 'upcoming')
  assert.equal(phaseOf({ status: 'idle' }, TODAY, TODAY), 'upcoming', 'today is still ahead')
  assert.equal(phaseOf({ status: 'draft' }, '2026-10-04', TODAY), 'past', 'a planned day gone by is behind')
  // No plan day: an unopened room was made for a class to come; one people
  // came to and left has already happened.
  assert.equal(phaseOf({ status: 'draft' }, null, TODAY), 'upcoming')
  assert.equal(phaseOf({ status: 'idle' }, null, TODAY), 'past')
})

test('a room in two courses counts in one tab, through the first course with a day', () => {
  const r = room('r1', { courses: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] })
  const seats = seatsOf([course('a', [seat('r1')]), course('b', [seat('r1', '2026-09-20')])])
  assert.equal(phaseForTabs(r, seats, TODAY), 'past')
  const counts = tabCounts([r], seats, TODAY)
  assert.deepEqual(counts, { all: 1, running: 0, upcoming: 0, past: 1 })
})

/* ------------------------------------------------------------- folders */

test('archived rooms live only in the archive folder', () => {
  const archived = room('r1', { archivedAt: 1, courses: [{ id: 'a', name: 'A' }] })
  assert.equal(inFolder(archived, 'archive'), true)
  assert.equal(inFolder(archived, 'all'), false)
  assert.equal(inFolder(archived, 'course:a'), false)
  const loose = room('r2')
  assert.equal(inFolder(loose, 'none'), true)
  assert.equal(inFolder(loose, 'course:a'), false)
  assert.equal(inFolder(loose, 'archive'), false)
})

test('the rail counts active rooms per folder; a room in two courses counts in both', () => {
  const rooms = [
    room('r1', { courses: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
    room('r2', { courses: [{ id: 'a', name: 'A' }] }),
    room('r3'),
    room('r4', { archivedAt: 5, courses: [{ id: 'a', name: 'A' }] }),
  ]
  const counts = folderCounts(rooms)
  assert.equal(counts.all, 3, 'archived rooms are not in «Все занятия»')
  assert.equal(counts.none, 1)
  assert.equal(counts.archive, 1)
  assert.equal(counts.courses.get('a'), 2)
  assert.equal(counts.courses.get('b'), 1)
})

test('the rail lists the course list first, then courses only a room names', () => {
  const rail = railCourses(
    [course('a', []), course('b', [])],
    [room('r1', { courses: [{ id: 'x', name: 'Stranger' }] }), room('r2', { archivedAt: 1, courses: [{ id: 'y', name: 'Old' }] })],
  )
  assert.deepEqual(
    rail.map((c) => c.id),
    ['a', 'b', 'x'],
    'an archived room does not add a course to the rail',
  )
})

test('search matches the name and the address', () => {
  const r = room('k2mx91aa', { name: 'Пайплайны для экспериментов' })
  assert.ok(matches(r, 'пайплайн'))
  assert.ok(matches(r, 'k2mx'))
  assert.ok(!matches(r, 'cnn'))
  assert.ok(matches(r, ''))
})

/* -------------------------------------------------------------- groups */

test('rows are grouped by course in rail order, «Без курса» last', () => {
  const a = course('a', [seat('r1', '2026-10-04'), seat('r2', '2026-10-18'), seat('r3', TODAY)])
  const b = course('b', [seat('r4', '2026-10-11')])
  const rooms = [
    room('r1', { status: 'finished', courses: [{ id: 'a', name: 'A' }] }),
    room('r2', { courses: [{ id: 'a', name: 'A' }] }),
    room('r3', { status: 'live', courses: [{ id: 'a', name: 'A' }] }),
    room('r4', { courses: [{ id: 'b', name: 'B' }] }),
    room('r5'),
  ]
  const rail = railCourses([a, b], rooms)
  const groups = groupRows(rooms, rail, seatsOf([a, b]), 'all', TODAY)
  assert.deepEqual(groups.map((g) => g.key), ['course:a', 'course:b', 'none'])
  // Live first, then what is ahead, then what is behind.
  assert.deepEqual(groups[0].rows.map((r) => r.seminar.id), ['r3', 'r2', 'r1'])
  assert.deepEqual(groups[0].rows.map((r) => r.n), [3, 2, 1], 'each row keeps its number in the course')
  assert.equal(groups[0].rows[1].day, '2026-10-18')
  assert.equal(groups[0].rows[1].planned, true)
  assert.equal(groups[2].rows[0].n, null, 'a room outside courses has no number')
  assert.equal(groups[2].rows[0].planned, false)
})

test('ahead is nearest first, behind is latest first', () => {
  const c = course('a', [seat('u2', '2026-10-25'), seat('u1', '2026-10-11'), seat('p1', '2026-09-20'), seat('p2', '2026-10-04')])
  const ref = [{ id: 'a', name: 'A' }]
  const rooms = ['u2', 'u1', 'p1', 'p2'].map((id) => room(id, { courses: ref }))
  const [group] = groupRows(rooms, railCourses([c], rooms), seatsOf([c]), 'all', TODAY)
  assert.deepEqual(group.rows.map((r) => r.seminar.id), ['u1', 'u2', 'p2', 'p1'])
})

test('rooms ahead without a planned day follow the dated ones, newest first', () => {
  const c = course('a', [seat('dated', '2026-10-20')])
  const rooms = [
    room('old', { createdAt: at('2026-09-27') }),
    room('new', { createdAt: at('2026-10-05') }),
    room('dated', { courses: [{ id: 'a', name: 'A' }] }),
  ]
  const groups = groupRows(rooms, railCourses([c], rooms), seatsOf([c]), 'all', TODAY)
  assert.deepEqual(groups[1].rows.map((r) => r.seminar.id), ['new', 'old'], 'not "27 Sep" first because it is earliest')
  // Mixed in one group (a seated row whose course has no day for it):
  const mixed = course('b', [seat('x', '2026-10-30'), seat('y')])
  const ref = [{ id: 'b', name: 'B' }]
  const two = [room('y', { courses: ref, createdAt: at('2026-10-05') }), room('x', { courses: ref })]
  const [group] = groupRows(two, railCourses([mixed], two), seatsOf([mixed]), 'all', TODAY)
  assert.deepEqual(group.rows.map((r) => r.seminar.id), ['x', 'y'])
})

test('a room in two courses is drawn in both groups, with each course’s number', () => {
  const ref = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const a = course('a', [seat('r1')])
  const b = course('b', [plan('x'), seat('r1')])
  const rooms = [room('r1', { courses: ref })]
  const groups = groupRows(rooms, railCourses([a, b], rooms), seatsOf([a, b]), 'all', TODAY)
  assert.deepEqual(groups.map((g) => [g.key, g.rows[0].n]), [['course:a', 1], ['course:b', 2]])
})

test('a course folder keeps its group when empty; other folders draw only full groups', () => {
  const a = course('a', [])
  const b = course('b', [seat('r1')])
  const rooms = [room('r1', { courses: [{ id: 'b', name: 'B' }] })]
  const rail = railCourses([a, b], rooms)
  const seats = seatsOf([a, b])
  const one = groupRows([], rail, seats, 'course:a', TODAY)
  assert.deepEqual(one.map((g) => [g.key, g.rows.length]), [['course:a', 0]], '«+ Занятие в курс» stays reachable')
  const all = groupRows(rooms, rail, seats, 'all', TODAY)
  assert.deepEqual(all.map((g) => g.key), ['course:b'], 'an empty course is not a header over nothing')
  // A room in two courses, looked at through one: only that course's group.
  const both = room('r2', { courses: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] })
  assert.deepEqual(groupRows([both], rail, seats, 'course:b', TODAY).map((g) => g.key), ['course:b'])
})

/* --------------------------------------------------------------- scope */

test('the remembered scope is an owner’s only, and storage failures fall back to «Мои»', () => {
  assert.equal(readScope(() => 'all', true), 'all')
  assert.equal(readScope(() => 'all', false), 'mine', 'a teacher never asks for a list the server refuses')
  assert.equal(readScope(() => 'garbage', true), 'mine')
  assert.equal(readScope(() => null, true), 'mine')
  assert.equal(
    readScope(() => {
      throw new Error('SecurityError')
    }, true),
    'mine',
  )
})
