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
import { renderCourse } from '../server/src/publish/render.js'
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
  courseTally,
  plannedRow,
  putPlanned,
  seatSeminar,
} from '../web/src/admin/course-plan.js'

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
  assert.deepEqual(next[1], {
    kind: 'seminar',
    sessionId: 'room1',
    name: 'Деревья решений',
    publication: null,
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

test('the course tally sees plan rows', () => {
  const items: CourseItem[] = [
    {
      kind: 'seminar',
      sessionId: 'a',
      name: 'A',
      publication: { id: 'p', slug: null, publishedAt: 1, steps: 2 },
    },
    { kind: 'seminar', sessionId: 'b', name: 'B', publication: null },
    { kind: 'gone', name: 'C', at: 1 },
    week('D', ''),
    week('E', '1–7 окт'),
  ]
  assert.deepEqual(courseTally(items), { published: 1, waiting: 1, planned: 2 })
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
  assert.deepEqual(one.items, [
    week('Регрессия', '1–7 сен'),
    week('Деревья', '8–14 сен'),
    week('Бустинг', ''),
  ])

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
  const items = (view.body.course as { items: CourseItem[] }).items
  assert.deepEqual(items[0], week('Бустинг', '15–21 сен'))
  assert.equal(items[2].kind === 'seminar' && items[2].sessionId, '', 'the room address leaked outside')

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
  const save = screen.slice(screen.indexOf('async function savePlan'), screen.indexOf('function openSeat'))
  const sent = save.indexOf('const writing = writeItems(next)')
  const cleared = save.indexOf("plan = { target: null, name: '', when: '' }")
  const answered = save.indexOf('await writing')
  assert.ok(sent > 0 && cleared > sent && answered > cleared, 'the form clears only after the answer')
  assert.match(save, /plan === fresh/, 'the answer after "Cancel" opens the form again')
  assert.match(save, /\.\.\.typed/, 'an unsaved topic does not come back after a failure')
  const keys = screen.slice(screen.indexOf('function planKeys'), screen.indexOf('const addable = $derived('))
  assert.match(keys, /isComposing\) return/, 'Enter from an IME saves a half-typed topic')
})

test('a long week on the course page wraps instead of lying over the topic', () => {
  /*
   * The week is typed by hand, up to MAX_PLANNED_WHEN characters. With
   * `nowrap` on a 390 phone it took the whole row: the topic went one word
   * per line, the week lay over it. Both in the room reader and in the site
   * export.
   */
  const list = source('web/src/components/reader/CourseList.svelte')
  const planned = list.slice(list.indexOf("item.kind === 'planned'"))
  const when = /<span class="([^"]*)">\{item\.when\}<\/span>/.exec(planned)
  assert.ok(when, 'the plan row\'s week was not found')
  assert.doesNotMatch(when[1], /whitespace-nowrap/)
  assert.match(when[1], /max-w-/)
  const html = renderCourse(
    { id: 'c', slug: null, name: 'Курс', blurb: null, items: [week('Тема', 'н'.repeat(MAX_PLANNED_WHEN))] } as never,
    'https://colloq.ru',
  )
  assert.match(html, /\.row\.off \.s\{white-space:normal;max-width:45%/)
})
