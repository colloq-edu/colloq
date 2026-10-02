/**
 * The course page's rows: number, title, day, state and page.
 *
 * `/api/c/:id` used to hand out the stored rows with the room id blanked and
 * leave the reader to work out what each meant. Now the server says it:
 * a break has no number and does not shift the others, a row's title is
 * the one students are given (else the live room name), a withdrawn page is
 * no page, and «сегодня» is the instance's day, never the phone's.
 *
 * And the panel's save keeps what it does not mention: a tab opened before
 * class days existed saves the order without wiping them.
 */
import './_env.mts'
import http from 'node:http'
import express, { type Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { STAFF_COOKIE } from '../shared/admin.js'
import { dayOf } from '../shared/class-day.js'
import type { Course, CourseItem, PublicCourseView } from '../shared/publish.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher } from '../server/src/admin/store.js'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { notebookMaterial } from '../server/src/publish/materials.js'
import {
  createCourse,
  getCourse,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  setPublicationState,
  writePublication,
} from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'

let base = ''
let cookie = ''
let server: http.Server

before(async () => {
  const teacher = createTeacher({ name: 'Ада', email: 'ada@course-classes.test', role: 'owner' })
  assert.ok(teacher)
  issueStaffCookie({ cookie: (_n: string, v: string) => (cookie = v) } as unknown as Response, teacher)
  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** A room with a one-notebook page. */
function published(sessionId: string, name: string) {
  createSession(sessionId, name, null)
  const material = notebookMaterial({
    key: 'seminar',
    name: 'Семинар',
    path: 'seminar.ipynb',
    cells: [{ id: 'c1', type: 'code', source: 'x = 1', outputs: [], execCount: 1, ranMs: null }],
    blob: () => null,
  })
  return writePublication({ sessionId, title: name, by: 'Ада', materials: [material], blobs: [] })
}

const view = async (handle: string): Promise<{ course: PublicCourseView; text: string; etag: string }> => {
  const res = await fetch(`${base}/api/c/${handle}`)
  assert.equal(res.status, 200)
  const text = await res.text()
  return { course: (JSON.parse(text) as { course: PublicCourseView }).course, text, etag: res.headers.get('etag') ?? '' }
}

const put = async (id: string, body: unknown) => {
  const res = await fetch(`${base}/api/admin/courses/${id}/items`, {
    method: 'PUT',
    headers: { cookie: `${STAFF_COOKIE}=${cookie}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { course?: Course; error?: string } }
}

/* ------------------------------------------------------------- the view */

test('every kind of row has its state, and a break has no number', async () => {
  const page = published('cc-page', 'Неделя 3')
  createSession('cc-room', 'Неделя 4', null)
  const gone = published('cc-gone', 'Удалённая')
  const withdrawn = published('cc-withdrawn', 'Снятая')
  setPublicationState(withdrawn.id, 'withdrawn')
  assert.equal(setPublicationSlug(page.id, 'cc-03'), 'ok')
  const course = createCourse('Классы', 'Про всё.', null)
  assert.equal(setCourseSlug(course.id, 'cc-course'), 'ok')
  assert.ok(
    setCourseItems(course.id, course.rev, [
      { kind: 'planned', id: 'r0000001', name: 'Введение', when: '31 авг — 6 сен', day: null },
      { kind: 'gone', id: 'r0000002', name: 'Удалённая', at: 1, publication: { id: gone.id, slug: null }, day: '2026-09-13' },
      { kind: 'seminar', id: 'r0000003', sessionId: 'cc-page', name: 'старое', publication: null, title: 'EDA', day: '2026-09-20', about: 'Смотрим на данные.' },
      { kind: 'planned', id: 'r0000004', name: 'Каникулы', when: '27 дек — 10 янв', pause: true },
      { kind: 'seminar', id: 'r0000005', sessionId: 'cc-room', name: 'Неделя 4', publication: null, day: '2026-10-04' },
      { kind: 'seminar', id: 'r0000006', sessionId: 'cc-withdrawn', name: 'Снятая', publication: null },
      { kind: 'gone', id: 'r0000007', name: 'Без страницы', at: 2, publication: null, when: '1–7 окт' },
    ]),
  )
  const { course: seen, text } = await view('cc-course')
  assert.equal(seen.id, course.id)
  assert.equal(seen.slug, 'cc-course')
  assert.equal(seen.blurb, 'Про всё.')
  assert.deepEqual(
    seen.classes.map((c) => [c.key, c.n, c.title, c.state, c.day, c.when]),
    [
      ['r0000001', 1, 'Введение', 'plan', null, '31 авг — 6 сен'],
      ['r0000002', 2, 'Удалённая', 'page', '2026-09-13', null],
      ['r0000003', 3, 'EDA', 'page', '2026-09-20', null],
      ['r0000004', null, 'Каникулы', 'pause', null, '27 дек — 10 янв'],
      ['r0000005', 4, 'Неделя 4', 'room', '2026-10-04', null],
      ['r0000006', 5, 'Снятая', 'closed', null, null],
      ['r0000007', 6, 'Без страницы', 'closed', null, '1–7 окт'],
    ],
  )
  const eda = seen.classes[2]
  assert.equal(eda.about, 'Смотрим на данные.')
  assert.equal(eda.page?.address, 'cc-03')
  assert.deepEqual(eda.page?.materials, [
    { key: 'seminar', kind: 'notebook', name: 'Семинар', bytes: eda.page!.materials[0].bytes },
  ])
  assert.ok((eda.page?.zipBytes ?? 0) > eda.page!.materials[0].bytes, 'the archive is smaller than what is in it')
  assert.equal(eda.page?.updatedAt, page.publishedAt)
  // A gone row's page is reached by the page's id when it has no name.
  assert.equal(seen.classes[1].page?.address, gone.id)
  // A withdrawn page is no page.
  assert.equal(seen.classes[5].page, null)
  // The room ids never go out.
  for (const room of ['cc-page', 'cc-room', 'cc-gone', 'cc-withdrawn']) {
    assert.ok(!text.includes(room), `${room} went out with the course`)
  }
  assert.ok(!text.includes('sessionId'))
})

test('«сегодня» is the instance’s day', async () => {
  const course = createCourse('Часовой пояс', null, null)
  const was = process.env.TZ
  try {
    // UTC+14: for ten hours of every UTC day it is already tomorrow there.
    process.env.TZ = 'Pacific/Kiritimati'
    const { course: seen } = await view(course.id)
    assert.equal(seen.today, dayOf(Date.now(), 'Pacific/Kiritimati'))
    process.env.TZ = 'Pacific/Pago_Pago'
    assert.equal((await view(course.id)).course.today, dayOf(Date.now(), 'Pacific/Pago_Pago'))
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
})

test('the course answers 304 to the tag it gave, and a new one after an edit', async () => {
  const course = createCourse('Тег', null, null)
  const first = await view(course.id)
  const again = await fetch(`${base}/api/c/${course.id}`, { headers: { 'if-none-match': first.etag } })
  assert.equal(again.status, 304)
  const saved = await put(course.id, { rev: course.rev, items: [{ kind: 'planned', name: 'Тема', when: '' }] })
  assert.equal(saved.status, 200)
  const after = await fetch(`${base}/api/c/${course.id}`, { headers: { 'if-none-match': first.etag } })
  assert.equal(after.status, 200)
})

/* ------------------------------------------------------------- the save */

test('the server gives every row an id, and keeps it', async () => {
  const course = createCourse('Ids', null, null)
  const made = await put(course.id, {
    rev: course.rev,
    items: [
      { kind: 'planned', name: 'Один', when: '' },
      { kind: 'planned', name: 'Два', when: '', id: 'made-up-by-the-client' },
    ],
  })
  assert.equal(made.status, 200)
  const ids = made.body.course!.items.map((i) => i.id)
  assert.ok(ids.every((id) => typeof id === 'string' && /^r[a-z0-9]{7}$/.test(id)), String(ids))
  assert.notEqual(ids[0], ids[1])
  // Saved again in the other order, each row keeps its own.
  const again = await put(course.id, {
    rev: made.body.course!.rev,
    items: [...made.body.course!.items].reverse(),
  })
  assert.deepEqual(again.body.course!.items.map((i) => i.id), [...ids].reverse())
})

test('an absent field keeps what is stored, null clears it, and a bad day is refused', async () => {
  const course = createCourse('Поля', null, null)
  const saved = setCourseItems(course.id, course.rev, [
    { kind: 'planned', id: 'rfield01', name: 'Регрессия', when: 'вс, 6 сен', day: '2026-09-06', title: 'Линейная регрессия', about: 'МНК.' },
    { kind: 'planned', id: 'rfield02', name: 'Деревья', when: '', day: '2026-09-13', about: 'Gini.' },
  ])!
  // A tab that knows nothing of days or titles saves the order.
  const old = await put(course.id, {
    rev: saved.rev,
    items: [
      { kind: 'planned', id: 'rfield02', name: 'Деревья', when: '' },
      { kind: 'planned', id: 'rfield01', name: 'Регрессия', when: 'вс, 6 сен' },
    ],
  })
  assert.equal(old.status, 200)
  const [trees, regression] = old.body.course!.items
  assert.equal(trees.day, '2026-09-13')
  assert.equal(trees.about, 'Gini.')
  assert.equal(regression.day, '2026-09-06')
  assert.equal(regression.title, 'Линейная регрессия')
  assert.equal(regression.about, 'МНК.')

  // A row sent without its id (a 0.12 tab) is matched by its topic and week.
  const anonymous = await put(course.id, {
    rev: old.body.course!.rev,
    items: [
      { kind: 'planned', name: 'Деревья', when: '' },
      { kind: 'planned', name: 'Регрессия', when: 'вс, 6 сен' },
    ],
  })
  assert.deepEqual(anonymous.body.course!.items.map((i) => [i.id, i.day]), [
    ['rfield02', '2026-09-13'],
    ['rfield01', '2026-09-06'],
  ])

  // null clears; a value replaces.
  const cleared = await put(course.id, {
    rev: anonymous.body.course!.rev,
    items: [
      { kind: 'planned', id: 'rfield02', name: 'Деревья', when: '', day: null, about: null, title: 'Решающие деревья' },
      { kind: 'planned', id: 'rfield01', name: 'Регрессия', when: 'вс, 6 сен', day: '2026-09-07', pause: true },
    ],
  })
  assert.equal(cleared.status, 200)
  const [a, b] = cleared.body.course!.items
  assert.equal(a.day, null)
  assert.equal(a.about, null)
  assert.equal(a.title, 'Решающие деревья')
  assert.equal(b.day, '2026-09-07')
  assert.equal(b.kind === 'planned' && b.pause, true)


  for (const day of ['2026-02-30', '06.09.2026', 'завтра', 20260906]) {
    const refused = await put(course.id, {
      rev: cleared.body.course!.rev,
      items: [{ kind: 'planned', id: 'rfield02', name: 'Деревья', when: '', day }],
    })
    assert.equal(refused.status, 400, String(day))
    assert.equal(refused.body.error, 'День занятия — в формате ГГГГ-ММ-ДД')
  }
  assert.equal(getCourse(course.id)!.rev, cleared.body.course!.rev, 'a refusal wrote the set after all')

  // An explicit false clears a stored break; an absent key keeps it (above).
  const unpaused = await put(course.id, {
    rev: cleared.body.course!.rev,
    items: [
      { kind: 'planned', id: 'rfield02', name: 'Деревья', when: '' },
      { kind: 'planned', id: 'rfield01', name: 'Регрессия', when: 'вс, 6 сен', pause: false },
    ],
  })
  assert.equal(unpaused.status, 200)
  const back = unpaused.body.course!.items[1]
  assert.equal(back.kind === 'planned' && back.pause === true, false, 'the row stayed a break')
  const kept = await put(course.id, {
    rev: unpaused.body.course!.rev,
    items: [
      { kind: 'planned', id: 'rfield02', name: 'Деревья', when: '', pause: true },
      { kind: 'planned', id: 'rfield01', name: 'Регрессия', when: 'вс, 6 сен' },
    ],
  })
  const [paused] = kept.body.course!.items
  assert.equal(paused.kind === 'planned' && paused.pause, true)
  const again = await put(course.id, {
    rev: kept.body.course!.rev,
    items: [
      { kind: 'planned', id: 'rfield02', name: 'Деревья', when: '' },
      { kind: 'planned', id: 'rfield01', name: 'Регрессия', when: 'вс, 6 сен' },
    ],
  })
  const [stillPaused] = again.body.course!.items
  assert.equal(stillPaused.kind === 'planned' && stillPaused.pause, true, 'an absent key cleared the break')
})

test('seating a room into a plan row keeps its id, topic, day, «о чём» and week', async () => {
  createSession('cc-seat', 'Неделя 5 (повтор)', null)
  const course = createCourse('Посадка', null, null)
  const saved = setCourseItems(course.id, course.rev, [
    { kind: 'planned', id: 'rseat001', name: 'Лики и хаки данных', when: '28 сен — 4 окт', day: '2026-10-04', about: 'Утечки.' },
  ])!
  const seated = await put(course.id, {
    rev: saved.rev,
    items: [{ kind: 'seminar', id: 'rseat001', sessionId: 'cc-seat', name: 'Неделя 5 (повтор)', publication: null }],
  })
  assert.equal(seated.status, 200)
  const row = seated.body.course!.items[0] as CourseItem
  assert.equal(row.kind, 'seminar')
  assert.equal(row.id, 'rseat001')
  assert.equal(row.title, 'Лики и хаки данных', 'the plan topic gave way to the room name')
  assert.equal(row.day, '2026-10-04')
  assert.equal(row.about, 'Утечки.')
  assert.equal(row.when, '28 сен — 4 окт')
  assert.equal(row.kind === 'seminar' && row.name, 'Неделя 5 (повтор)')
  const { course: seen } = await view(course.id)
  assert.equal(seen.classes[0].title, 'Лики и хаки данных')
  assert.equal(seen.classes[0].when, null, 'a week text shows only while there is no day')
})
