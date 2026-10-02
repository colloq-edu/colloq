/**
 * "Planned" rows from the panel.
 *
 * A semester plan could only be set up with a script from a spreadsheet or
 * with an API request: the course screen showed plan rows but did not create
 * them, did not edit them and did not put a held class in their place. Here
 * are the screen's decisions (web/src/admin/course-plan.ts) and what the
 * server does with what the screen sends (PUT /api/admin/courses/:id/items).
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createCourse, getCourse, setCourseItems } from '../server/src/publish/store.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import {
  MAX_COURSE_NAME,
  MAX_PLANNED_WHEN,
  type Course,
  type CourseItem,
  type CourseItemPlanned,
} from '../shared/publish.js'
import {
  applyDraft,
  classOptions,
  courseTally,
  defaultClass,
  draftOf,
  nextPlanDay,
  pageState,
  plannedRow,
  putPlanned,
  putRow,
  roomChoices,
  roomNameFor,
  seatCreated,
  seatSeminar,
} from '../web/src/admin/course-plan.js'
import type { AdminSeminar } from '../shared/admin.js'

after(() => shutdownCollab())

const week = (name: string, when: string): CourseItemPlanned => ({ kind: 'planned', name, when })

/* ---------------------------------------------------------- screen decisions */

test('a plan row from what was typed: the topic is required, trimming is the same as the server\'s', () => {
  assert.equal(plannedRow('   ', '1–7 сен'), null, 'an empty topic became a row')
  assert.deepEqual(plannedRow('  Бустинг ', ' 14–20 сен '), week('Бустинг', '14–20 сен'))
  assert.deepEqual(plannedRow('Бустинг', ''), week('Бустинг', ''), 'the week is optional')
  const long = plannedRow('т'.repeat(MAX_COURSE_NAME + 10), 'н'.repeat(MAX_PLANNED_WHEN + 10))!
  assert.equal(long.name.length, MAX_COURSE_NAME)
  assert.equal(long.when.length, MAX_PLANNED_WHEN)
})

test('a new topic goes to the end, an edit goes to its own place', () => {
  const items: CourseItem[] = [week('Регрессия', '1–7 сен'), week('Деревья', '8–14 сен')]
  assert.deepEqual(putPlanned(items, week('Бустинг', '15–21 сен'), null), [
    ...items,
    week('Бустинг', '15–21 сен'),
  ])
  const edited = putPlanned(items, week('Деревья решений', '8–14 сен'), {
    at: 1,
    was: week('Деревья', '8–14 сен'),
  })
  assert.deepEqual(edited, [week('Регрессия', '1–7 сен'), week('Деревья решений', '8–14 сен')])
  assert.deepEqual(items[1], week('Деревья', '8–14 сен'), 'the original list was changed in place')
})

test('an edit by index under which there is already another row writes nothing', () => {
  /*
   * The field was opened on "Деревья" (row 2), and meanwhile the course was
   * reordered: the second position now holds "Регрессия". Writing by index
   * would rename someone else's week — silently, on a page the cohort reads.
   */
  const swapped: CourseItem[] = [week('Деревья', '8–14 сен'), week('Регрессия', '1–7 сен')]
  const target = { at: 1, was: week('Деревья', '8–14 сен') }
  assert.equal(putPlanned(swapped, week('Деревья решений', '8–14 сен'), target), null)
  assert.equal(seatSeminar(swapped, target, { id: 'room1', name: 'Деревья' }), null)
  // And if a class now stands in the place of the plan row — the same.
  const seated: CourseItem[] = [
    week('Регрессия', '1–7 сен'),
    { kind: 'seminar', sessionId: 'room1', name: 'Деревья', publication: null },
  ]
  assert.equal(putPlanned(seated, week('x', ''), target), null)
})

test('a class takes the place of a plan row, and the week numbering does not shift', () => {
  const items: CourseItem[] = [
    week('Регрессия', '1–7 сен'),
    week('Деревья', '8–14 сен'),
    week('Бустинг', '15–21 сен'),
  ]
  const next = seatSeminar(items, { at: 1, was: week('Деревья', '8–14 сен') }, {
    id: 'room1',
    name: 'Деревья решений',
  })!
  assert.equal(next.length, 3)
  // The topic stays the student title, and the week rides along until a day replaces it.
  assert.deepEqual(next[1], {
    kind: 'seminar',
    sessionId: 'room1',
    name: 'Деревья решений',
    publication: null,
    title: 'Деревья',
    when: '8–14 сен',
  })
  assert.deepEqual(next[0], items[0])
  assert.deepEqual(next[2], items[2])
  // The same room is not put into the course a second time: two rows of one
  // room read as two different weeks.
  assert.equal(
    seatSeminar(next, { at: 2, was: week('Бустинг', '15–21 сен') }, { id: 'room1', name: 'x' }),
    null,
  )
})

test('the course tally counts pages and plan rows, and breaks are not classes', () => {
  const items: CourseItem[] = [
    {
      kind: 'seminar',
      sessionId: 'a',
      name: 'A',
      publication: { id: 'p', slug: null, publishedAt: 1, materials: 2 },
    },
    { kind: 'seminar', sessionId: 'b', name: 'B', publication: null },
    { kind: 'gone', name: 'C', at: 1 },
    { kind: 'gone', name: 'G', at: 1, publication: { id: 'q', slug: null } },
    week('D', ''),
    week('E', '1–7 окт'),
    { ...week('Каникулы', ''), pause: true },
  ]
  // «2 со страницей · 1 без страницы · 2 по плану»
  assert.deepEqual(courseTally(items), { pages: 2, rooms: 1, planned: 2 })
})

/* ------------------------------------------------- class days and titles */

const dated = (name: string, day: string, extra: Partial<CourseItemPlanned> = {}): CourseItemPlanned => ({
  kind: 'planned',
  name,
  when: '',
  day,
  ...extra,
})

test('seating keeps the row\'s id, title, day, about and week', () => {
  const row: CourseItemPlanned = {
    kind: 'planned',
    id: 'r0000004',
    name: 'Лики и хаки данных',
    when: '28 сен – 4 окт',
    day: '2026-10-04',
    about: 'Как данные подсказывают ответ — и как найти это раньше модели.',
  }
  const next = seatSeminar([dated('EDA', '2026-09-20'), row], { at: 1, was: row }, {
    id: 'room4',
    name: '04 · Лики и хаки данных',
  })!
  assert.deepEqual(next[1], {
    kind: 'seminar',
    id: 'r0000004',
    sessionId: 'room4',
    name: '04 · Лики и хаки данных',
    publication: null,
    title: 'Лики и хаки данных',
    day: '2026-10-04',
    about: 'Как данные подсказывают ответ — и как найти это раньше модели.',
    when: '28 сен – 4 окт',
  })
  // A row someone already gave a student title keeps that title, not the topic.
  const titled = { ...row, title: 'Утечки данных' }
  const again = seatSeminar([titled], { at: 0, was: titled }, { id: 'room5', name: 'x' })!
  assert.equal(again[0].title, 'Утечки данных')
})

test('a new plan row starts a week after the last dated row', () => {
  assert.equal(nextPlanDay([]), '', 'no days yet: no guess')
  assert.equal(nextPlanDay([week('Регрессия', '1–7 сен')]), '')
  const items: CourseItem[] = [
    dated('Торч', '2026-09-06'),
    dated('Дообучение', '2026-09-13'),
    week('Без дня', ''),
  ]
  assert.equal(nextPlanDay(items), '2026-09-20', 'the undated row at the end is stepped over')
  assert.equal(nextPlanDay([dated('Перед Новым годом', '2026-12-27')]), '2027-01-03', 'across the year')
  // The typed day reaches the row; a day that is not a date does not.
  assert.equal(plannedRow('EDA', '', { day: '2026-09-20' })?.day, '2026-09-20')
  assert.equal(plannedRow('EDA', '', { day: '2026-02-30' })?.day, undefined)
  assert.deepEqual(plannedRow('Каникулы', '', { pause: true, about: '  ' }), {
    ...week('Каникулы', ''),
    pause: true,
  })
})

test('the row form edits a title, a day and «о чём», and clears with null', () => {
  const room: CourseItem = {
    kind: 'seminar',
    id: 'r1',
    sessionId: 's1',
    name: '03 · EDA',
    publication: null,
    day: '2026-09-20',
    about: 'старое',
  }
  assert.deepEqual(draftOf(room), { title: '03 · EDA', day: '2026-09-20', about: 'старое', pause: false })
  const saved = applyDraft(room, { title: 'EDA', day: '', about: '', pause: false })!
  assert.equal(saved.title, 'EDA')
  // null, not absent: the server keeps a stored field the request does not mention.
  assert.equal(saved.day, null)
  assert.equal(saved.about, null)
  // The room's own name is not frozen as a title: a later rename must still show.
  assert.equal(applyDraft(room, { ...draftOf(room) })!.title, null)
  // A plan row's title is its topic, and an empty topic is not saved.
  const plan = dated('Деревья', '2026-09-27', { id: 'r2', title: 'Деревья решений' })
  assert.equal(applyDraft(plan, { ...draftOf(plan), title: '   ' }), null)
  const renamed = applyDraft(plan, { ...draftOf(plan), title: 'Бустинг', pause: true })!
  assert.equal(renamed.kind === 'planned' && renamed.name, 'Бустинг')
  assert.equal(renamed.title, null)
  assert.equal(renamed.kind === 'planned' && renamed.pause, true)
  // Unticking «Перерыв» is sent as false: an absent key keeps the stored pause on the server.
  const unpaused = applyDraft(renamed, { ...draftOf(renamed), pause: false })!
  assert.equal(unpaused.kind === 'planned' && unpaused.pause, false)
  assert.ok('pause' in unpaused, 'an unticked break went out without the key')
  // The edit lands in its own place and keeps its id.
  const items: CourseItem[] = [room, plan]
  const next = putRow(items, { at: 1, was: plan }, { ...renamed, id: undefined })!
  assert.equal(next[1].id, 'r2')
  assert.equal(putRow([plan, room], { at: 1, was: plan }, renamed), null, 'a moved row is not edited')
})

test('the page column: a page, before class, forgotten, withdrawn, a plan', () => {
  const today = '2026-10-02'
  const page = { id: 'p', slug: 'ml-strong-03', publishedAt: 1, materials: 5 }
  const room = (day: string | null, publication: typeof page | null = null): CourseItem => ({
    kind: 'seminar',
    sessionId: 's',
    name: 'EDA',
    publication,
    day,
  })
  assert.equal(pageState(room('2026-09-20', page), { today }), 'page')
  assert.equal(pageState(room('2026-10-04', page), { today }), 'early')
  assert.equal(pageState(room('2026-09-20'), { today }), 'missing', 'the day passed without a page')
  assert.equal(pageState(room('2026-10-02'), { today }), 'room', 'today is not over yet')
  assert.equal(pageState(room('2026-10-02'), { today, finished: true }), 'missing', 'unless it was finished')
  assert.equal(pageState(room(null), { today }), 'room')
  assert.equal(pageState(room('2026-09-20'), { today, withdrawn: true }), 'withdrawn')
  assert.equal(pageState(week('x', ''), { today }), 'plan')
  assert.equal(pageState({ ...week('x', ''), pause: true }, { today }), 'pause')
  assert.equal(pageState({ kind: 'gone', name: 'x', at: 1 }, { today }), 'gone')
})

test('the room pickers put the room held on the row\'s day first and hide the archive', () => {
  const at = (day: string) => Date.parse(`${day}T12:00:00`)
  const room = (id: string, day: string, extra: Partial<AdminSeminar> = {}) =>
    ({ id, name: id, createdAt: at(day), finishedAt: null, archivedAt: null, ...extra }) as AdminSeminar
  const rooms = [
    room('week1', '2026-09-06'),
    room('week3', '2026-09-19', { finishedAt: at('2026-09-20') }),
    room('week2', '2026-09-13'),
    room('old', '2026-09-20', { archivedAt: 1 }),
    room('seated', '2026-09-20'),
  ]
  const choices = roomChoices(rooms, '2026-09-20', new Set(['seated']))
  assert.deepEqual(choices.map((c) => c.seminar.id), ['week3', 'week2', 'week1'])
  assert.equal(choices[0].day, '2026-09-20', 'held when it was finished, not when it was made')
  assert.deepEqual(choices.map((c) => c.fits), [true, false, false])
  // Nothing within a week of the row: nothing «подходит по дате».
  assert.ok(roomChoices(rooms, '2026-12-20', new Set()).every((c) => !c.fits))
  // No day on the row: newest first.
  assert.deepEqual(roomChoices(rooms, null, new Set()).map((c) => c.seminar.id), ['seated', 'week3', 'week2', 'week1'])
})

test('the new room form offers unseated rows nearest first and guesses the teacher\'s course', () => {
  const course = (id: string, name: string, items: CourseItem[]): Course =>
    ({ id, name, slug: null, blurb: null, createdAt: 0, createdBy: null, items, rev: 1 }) as Course
  const ml = course('ml', 'МЛ | сильная группа', [
    { kind: 'seminar', id: 'r1', sessionId: 's1', name: 'EDA', publication: null, day: '2026-09-20' },
    { ...dated('Лики и хаки данных', '2026-10-04'), id: 'r2' },
    { ...dated('Каникулы', '2026-10-11'), id: 'r3', pause: true },
    { ...dated('Пайплайны', '2026-10-18'), id: 'r4' },
    { ...dated('Забытое', '2026-09-27'), id: 'r5' },
  ])
  const py = course('py', 'Питон', [{ ...week('Списки', ''), id: 'p1' }])
  const options = classOptions([ml, py], '2026-10-02')
  assert.deepEqual(
    options.map((o) => `${o.courseId}:${o.n}:${o.title}`),
    ['ml:2:Лики и хаки данных', 'ml:3:Пайплайны', 'ml:4:Забытое', 'py:1:Списки'],
    'ahead in order, then the past, then undated; breaks are not offered and not numbered',
  )
  assert.equal(roomNameFor(options[0]), '02 · Лики и хаки данных')
  const rooms = [
    { createdAt: 1, createdBy: 'Ада', courses: [{ id: 'py', name: 'Питон' }] },
    { createdAt: 5, createdBy: 'Борис', courses: [{ id: 'py', name: 'Питон' }] },
    { createdAt: 3, createdBy: 'Ада', courses: [{ id: 'ml', name: 'МЛ' }] },
  ]
  assert.equal(defaultClass(options, rooms, 'Ада', '2026-10-02')?.rowId, 'r2', 'my latest seated room is in МЛ')
  assert.equal(defaultClass(options, rooms, 'Борис', '2026-10-02')?.rowId, 'p1', 'an undated course offers its first row')
  assert.equal(defaultClass(options, [], 'Ада', '2026-10-02'), null, 'no seated room: «Без курса»')
  assert.equal(defaultClass(options, rooms, 'Ада', '2026-12-01'), null, 'nothing left ahead in that course')
})

test('a created room takes its row once more after a race, and never a taken row', async () => {
  const row = { ...dated('Лики', '2026-10-04'), id: 'r2' }
  const base = { id: 'ml', name: 'МЛ', slug: null, blurb: null, createdAt: 0, createdBy: null } as const
  let rev = 1
  let items: CourseItem[] = [row]
  let saves = 0
  const conflict = new Error('409')
  const io = {
    load: async () => ({ ...base, items, rev }) as Course,
    save: async (sent: number, next: CourseItem[]) => {
      saves++
      if (saves === 1) {
        rev++ // someone else wrote meanwhile
        throw conflict
      }
      assert.equal(sent, rev)
      items = next
    },
    isConflict: (cause: unknown) => cause === conflict,
  }
  assert.equal(await seatCreated('r2', { id: 'room4', name: '04 · Лики' }, io), 'seated')
  assert.equal(saves, 2, 'one retry on 409')
  assert.equal(items[0].kind === 'seminar' && items[0].sessionId, 'room4')
  // The row is a room now: a second room does not seat over it.
  assert.equal(await seatCreated('r2', { id: 'room5', name: 'x' }, io), 'taken')
  // Two races in a row are a refusal said out loud, not a silent loop.
  items = [row]
  saves = 0
  const always = { ...io, save: async () => { saves++; throw conflict } }
  await assert.rejects(seatCreated('r2', { id: 'room6', name: 'x' }, always))
  assert.equal(saves, 2)
})

/* ------------------------------------------------------------------- server */

let teacher: ReturnType<typeof createTeacher> = null

async function panel(): Promise<{
  put: (id: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  get: (route: string) => Promise<{ status: number; body: Record<string, unknown> }>
  close: () => Promise<void>
}> {
  // One owner per file: a second `createTeacher` with the same address
  // returns null.
  teacher ??= createTeacher({ name: 'Ада', email: 'ada@course-plan.test', role: 'owner' })
  assert.ok(teacher)
  let cookie = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (cookie = v) } as unknown as Response, teacher)
  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const head = { cookie: `${STAFF_COOKIE}=${cookie}`, 'content-type': 'application/json' }
  const read = async (res: globalThis.Response) => ({
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  })
  return {
    put: async (id, body) =>
      read(
        await fetch(`${base}/api/admin/courses/${id}/items`, {
          method: 'PUT',
          headers: head,
          body: JSON.stringify(body),
        }),
      ),
    get: async (route) => read(await fetch(`${base}${route}`, { headers: head })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('the plan from the panel: create, edit, reorder, replace with a class, remove', async () => {
  createSession('plan-room', 'Деревья решений', null)
  const course = createCourse('ML · план', null, 'Ада')
  const api = await panel()

  // Create: three weeks, one without a date.
  const made = await api.put(course.id, {
    rev: course.rev,
    items: [week('Регрессия', '1–7 сен'), week('Деревья', '8–14 сен'), week('Бустинг', '')],
  })
  assert.equal(made.status, 200)
  const one = made.body.course as Course
  // Every row comes back with an id of the server's.
  assert.ok(one.items.every((item) => typeof item.id === 'string' && item.id.length > 0))
  assert.deepEqual(
    one.items.map(({ id: _id, ...row }) => row),
    [week('Регрессия', '1–7 сен'), week('Деревья', '8–14 сен'), week('Бустинг', '')],
  )

  // Edit a topic and a week, reorder — in one set, the way the screen sends
  // it.
  const moved = await api.put(course.id, {
    rev: one.rev,
    items: [week('Бустинг', '15–21 сен'), week('Регрессия', '1–7 сен'), week('Деревья', '8–14 сен')],
  })
  assert.equal(moved.status, 200)
  const two = moved.body.course as Course
  assert.deepEqual(
    two.items.map((i) => i.kind === 'planned' && `${i.name}|${i.when}`),
    ['Бустинг|15–21 сен', 'Регрессия|1–7 сен', 'Деревья|8–14 сен'],
  )

  // A class in the place of "Деревья" — the position is the same, the name is
  // the room's.
  const seated = await api.put(course.id, {
    rev: two.rev,
    items: seatSeminar(two.items, { at: 2, was: week('Деревья', '8–14 сен') }, {
      id: 'plan-room',
      name: 'Деревья решений',
    }),
  })
  assert.equal(seated.status, 200)
  const three = seated.body.course as Course
  assert.equal(three.items[2].kind, 'seminar')
  assert.equal(three.items[2].kind === 'seminar' && three.items[2].sessionId, 'plan-room')

  // The course page: plan rows with the week, the room without its address.
  const view = await api.get(`/api/c/${course.id}`)
  assert.equal(view.status, 200)
  const classes = (view.body.course as { classes: { title: string; when: string | null; state: string }[] })
    .classes
  assert.deepEqual(
    classes.map((c) => [c.title, c.when, c.state]),
    [
      ['Бустинг', '15–21 сен', 'plan'],
      ['Регрессия', '1–7 сен', 'plan'],
      // Seated rows keep the plan topic as their title, and the week until a day is set.
      ['Деревья', '8–14 сен', 'room'],
    ],
  )
  assert.ok(!JSON.stringify(view.body).includes('plan-room'), 'the room address leaked outside')

  // Remove a plan row.
  const dropped = await api.put(course.id, { rev: three.rev, items: three.items.slice(1) })
  assert.equal(dropped.status, 200)
  assert.equal((dropped.body.course as Course).items.length, 2)
  await api.close()
})

test('a plan row without a topic is a refusal in words, not a silent loss', async () => {
  /*
   * Such a row used to be thrown away, and the answer was 200: "Add" with an
   * empty topic looked like success, after which the row was not there. A
   * refusal writes nothing — including the other rows of the same request.
   */
  const course = createCourse('Без темы', null, null)
  const saved = setCourseItems(course.id, course.rev, [week('Регрессия', '1–7 сен')])!
  const api = await panel()
  const res = await api.put(course.id, {
    rev: saved.rev,
    items: [week('Регрессия', '1–7 сен'), week('   ', '8–14 сен')],
  })
  assert.equal(res.status, 400)
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0)
  const now = getCourse(course.id)!
  assert.equal(now.rev, saved.rev, 'the refusal wrote the set after all')
  assert.deepEqual(now.items, [week('Регрессия', '1–7 сен')])
  await api.close()
})

test('the week is cut by the shared constant, and a stale version gets 409 with the truth', async () => {
  const course = createCourse('Длинная неделя', null, null)
  const api = await panel()
  const long = 'н'.repeat(MAX_PLANNED_WHEN + 25)
  const res = await api.put(course.id, { rev: course.rev, items: [week('Тема', long)] })
  assert.equal(res.status, 200)
  const saved = res.body.course as Course
  assert.equal(saved.items[0].kind === 'planned' && saved.items[0].when.length, MAX_PLANNED_WHEN)

  // The screen holds an old version: the write does not go through, the
  // answer carries the course as it is.
  const stale = await api.put(course.id, { rev: course.rev, items: [] })
  assert.equal(stale.status, 409)
  assert.equal((stale.body.course as Course).items.length, 1)
  assert.equal(getCourse(course.id)!.items.length, 1)
  await api.close()
})

/* ---------------------------------------------- typing in a row, the screen */

/** Markup and code without comments: an explanation is not a promise. */
const source = (rel: string): string =>
  fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('a new topic: the form clears at once, not on the answer, and the answer does not reopen a closed form', () => {
  /*
   * A test stand with a write taking a second and a half: Enter in the week
   * field, the cursor stays in it, the next topic was typed onto the tail of
   * the week ("1–7 сенДеревья"), and the arriving answer wiped both rows.
   * "Cancel" in the middle of a write — the form opened again when the
   * answer arrived.
   */
  const screen = source('web/src/admin/screens/Courses.svelte')
  const save = screen.slice(screen.indexOf('async function savePlan'), screen.indexOf('async function saveRow'))
  const sent = save.indexOf('const writing = writeItems(next)')
  const cleared = save.indexOf('plan = blankPlan(next)')
  const answered = save.indexOf('await writing')
  assert.ok(sent > 0 && cleared > sent && answered > cleared, 'the form clears only after the answer')
  assert.match(save, /plan === fresh/, 'the answer after "Cancel" opens the form again')
  assert.match(save, /draft: typed/, 'an unsaved topic does not come back after a failure')
  // The next empty form starts a week after the row just added.
  assert.match(screen, /day: nextPlanDay\(items\)/)
  const keys = screen.slice(screen.indexOf('function formKeys'), screen.indexOf('const inCourse = $derived('))
  assert.match(keys, /isComposing\) return/, 'Enter from an IME saves a half-typed topic')
})

test('creating a room: the row is the one on screen at the press, and a failed seating still uploads the files', () => {
  /*
   * Two ways a room came out wrong. The default row arrives with the slow
   * room list, and `seatRow` was read after the creation's await, so a press
   * made on «Без курса» could still seat a scratch room into the default row.
   * And a seating refused or failed returned before the upload: the room had
   * none of its datasets, and the message spoke only of the row.
   */
  const screen = source('web/src/admin/screens/NewSeminar.svelte')
  const create = screen.slice(screen.indexOf('async function create'), screen.indexOf('const ORACLE'))
  const taken = create.indexOf('const row = seatRow')
  assert.ok(taken > 0, 'the row is no longer read once at the press')
  assert.ok(taken < create.indexOf('await '), 'the row is read after the creation, where a late default can move it')
  assert.ok(create.indexOf('rowTouched = true') < create.indexOf('await '), 'a late default can still move the select')
  const seat = create.indexOf('await seatCreated(')
  const upload = create.indexOf('await uploadMaterials(')
  assert.ok(seat > 0 && upload > seat)
  assert.doesNotMatch(create.slice(seat, upload), /\breturn\b/, 'a seating problem skips the upload again')
  // Both outcomes are said together, and the screen closes only when nothing went wrong.
  assert.match(create, /problems\.push\(\(\) => tr\('admin\.new\.rowTaken'\)\)/)
  assert.ok(create.indexOf('if (problems.length > 0)') > upload)
  assert.ok(create.indexOf('ondone(seminar.id)') > create.indexOf('if (problems.length > 0)'))
})
