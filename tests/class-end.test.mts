/**
 * «Завершить занятие» and the class page (server/src/publish/class-end.ts).
 *
 * After the first week the bell is all a teacher presses. So the finish
 * dates the course row when it has no day, asks the host of a seated room
 * with no page to pick materials, and rebuilds a page that refreshes itself,
 * but only once the cells queued before the bell have finished, since their
 * outputs are what the page is for. A rebuild never publishes what nobody
 * confirmed: a new key-like string in a cell keeps the old page and says so.
 * Resuming the class leaves the page alone.
 */
import './_env.mts'
import http from 'node:http'
import express, { type Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { STAFF_COOKIE } from '../shared/admin.js'
import { addBook, createCell } from '../shared/notebook.js'
import type { CourseItem } from '../shared/publish.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { listAdminEvents } from '../server/src/admin/audit-log.js'
import { createTeacher } from '../server/src/admin/store.js'
import { createSession, setFinished } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import {
  afterClassFinished,
  pendingRefresh,
  stampClassDay,
  type ClassEndDeps,
  type PageFrame,
} from '../server/src/publish/class-end.js'
import { buildAndWrite, refreshPage } from '../server/src/publish/materials.js'
import {
  createCourse,
  getCourse,
  publicationOf,
  rewriteCourseRows,
  setCourseItems,
  setCourseSlug,
  setPublicationState,
} from '../server/src/publish/store.js'
import { adminInstanceRoutes } from '../server/src/routes/admin-instance.js'
import { forgetCourseIndex } from '../server/src/routes/course-view.js'
import { instanceToday } from '../server/src/time-zone.js'

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'
let base = ''
let cookie = ''
let server: http.Server

before(async () => {
  const teacher = createTeacher({ name: 'Ада', email: 'ada@class-end.test', role: 'owner' })
  assert.ok(teacher)
  issueStaffCookie({ cookie: (_n: string, v: string) => (cookie = v) } as unknown as Response, teacher)
  const app = express()
  app.use(express.json())
  app.use(adminInstanceRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** A room with one notebook, finished now. */
function room(id: string, name = 'Неделя 4'): { book: string; doc: Y.Doc } {
  createSession(id, name, null)
  const { doc } = getSessionDoc(id, name)
  const book = addBook(doc, 'seminar.ipynb').root
  doc.transact(() => doc.getArray<Y.Map<unknown>>(book).push([createCell('code', 'x = 1')]), 'server')
  return { book, doc }
}

/** A course with these rooms seated, in order. */
function seat(name: string, rows: CourseItem[]): string {
  const course = createCourse(name, null, null)
  assert.ok(setCourseItems(course.id, course.rev, rows))
  forgetCourseIndex()
  return course.id
}

async function publish(id: string, book: string, autoRefresh: boolean) {
  const built = await buildAndWrite(
    id,
    { notebooks: [{ root: book, name: 'Семинар' }], files: [], autoRefresh, ack: [] },
    { by: 'Ада' },
  )
  assert.ok(built.ok, JSON.stringify(built))
  return built.publication
}

/** Dependencies with a fake run queue and a record of what the consoles heard. */
function fake(busyPolls = 0): { deps: Partial<ClassEndDeps>; heard: PageFrame[]; polls: () => number } {
  const heard: PageFrame[] = []
  let polls = 0
  return {
    heard,
    polls: () => polls,
    deps: {
      computing: () => polls < busyPolls,
      tell: (_id, frame) => heard.push(frame),
      sleep: async () => {
        polls++
      },
      pollMs: 1_000,
      maxWaitMs: 120_000,
    },
  }
}

const finish = (id: string, at = Date.now()) => setFinished(id, at)

/* ------------------------------------------------------------- the offer */

test('the first finish of a seated room asks for a page; a room outside a course is not asked', () => {
  room('ce-offer', 'Неделя 4 (повтор)')
  seat('МЛ | сильная группа', [
    { kind: 'planned', id: 'rceoff00', name: 'Перерыв', when: '', pause: true },
    { kind: 'planned', id: 'rceoff01', name: 'Введение', when: '' },
    { kind: 'seminar', id: 'rceoff02', sessionId: 'ce-offer', name: 'x', publication: null, title: 'Лики и хаки данных', day: '2026-10-04' },
  ])
  finish('ce-offer')
  const { deps, heard } = fake()
  assert.equal(afterClassFinished('ce-offer', deps), 'offer')
  // What the host's dialog prints: «04 · Лики и хаки данных · вс, 4 окт» in «МЛ | сильная группа».
  assert.deepEqual(heard, [
    {
      t: 'page',
      state: 'offer',
      course: { name: 'МЛ | сильная группа', n: 2, title: 'Лики и хаки данных', day: '2026-10-04' },
    },
  ])

  room('ce-alone')
  finish('ce-alone')
  const alone = fake()
  assert.equal(afterClassFinished('ce-alone', alone.deps), null)
  assert.deepEqual(alone.heard, [])
})

/* ----------------------------------------------------------- the refresh */

test('a page that refreshes itself is rebuilt once the queue drains, and only once', async () => {
  const { book, doc } = room('ce-refresh')
  const course = seat('Обновление', [
    { kind: 'seminar', id: 'rceref01', sessionId: 'ce-refresh', name: 'Неделя 4', publication: null },
  ])
  assert.equal(setCourseSlug(course, 'ce-course'), 'ok')
  forgetCourseIndex()
  const first = await publish('ce-refresh', book, true)
  assert.equal(first.slug, 'ce-course-01')
  // A cell computed after the publish: its output is what the refresh is for.
  doc.transact(() => doc.getArray<Y.Map<unknown>>(book).push([createCell('code', 'y = 2')]), 'server')

  finish('ce-refresh')
  const { deps, heard, polls } = fake(3)
  assert.equal(afterClassFinished('ce-refresh', deps), 'waiting')
  // A second press while it waits queues nothing more.
  assert.equal(afterClassFinished('ce-refresh', deps), 'waiting')
  await pendingRefresh('ce-refresh')
  assert.equal(polls(), 3, 'it did not wait for the queue')
  const after = publicationOf('ce-refresh')!
  assert.equal(after.revision, first.revision + 1, 'rebuilt more or less than once')
  assert.deepEqual(heard, [
    { t: 'page', state: 'waiting', address: 'ce-course-01' },
    { t: 'page', state: 'updated', address: 'ce-course-01', materials: 1 },
  ])
  const event = listAdminEvents({ limit: 5 }).events.find((e) => e.action === 'publication.published')
  assert.equal(event?.detail?.trigger, 'finish')
  assert.equal(event?.detail?.room, 'ce-refresh')
  assert.equal(event?.actor, null)
})

test('a cell that never stops does not hold the page past the cap', async () => {
  const { book } = room('ce-cap')
  const first = await publish('ce-cap', book, true)
  finish('ce-cap')
  const { deps, polls } = fake(Number.POSITIVE_INFINITY)
  afterClassFinished('ce-cap', { ...deps, maxWaitMs: 5_000 })
  await pendingRefresh('ce-cap')
  assert.equal(polls(), 5)
  assert.equal(publicationOf('ce-cap')!.revision, first.revision + 1)
})

test('with «Обновлять страницу» off, the bell leaves the page alone', async () => {
  const { book } = room('ce-manual')
  const first = await publish('ce-manual', book, false)
  finish('ce-manual')
  const { deps, heard } = fake()
  assert.equal(afterClassFinished('ce-manual', deps), null)
  assert.equal(pendingRefresh('ce-manual'), undefined)
  assert.deepEqual(heard, [])
  assert.equal(publicationOf('ce-manual')!.revision, first.revision)
})

test('a new key-like string keeps the old page, and the host hears which cell', async () => {
  const { book, doc } = room('ce-held')
  const first = await publish('ce-held', book, true)
  doc.transact(
    () => doc.getArray<Y.Map<unknown>>(book).push([createCell('code', `OPENAI_API_KEY = '${KEY}'`)]),
    'server',
  )
  finish('ce-held')
  const { deps, heard } = fake()
  afterClassFinished('ce-held', deps)
  await pendingRefresh('ce-held')
  assert.equal(publicationOf('ce-held')!.revision, first.revision, 'published what nobody confirmed')
  assert.equal(heard.length, 1)
  assert.equal(heard[0].state, 'held')
  assert.equal(heard[0].address, first.id)
  assert.match(heard[0].reason ?? '', /^похоже на ключ API — «Семинар», ячейка 2/)
})

test('a class resumed while its refresh waits keeps its page as it was', async () => {
  const { book } = room('ce-resume')
  const first = await publish('ce-resume', book, true)
  finish('ce-resume')
  let busy = true
  const heard: PageFrame[] = []
  afterClassFinished('ce-resume', {
    computing: () => busy,
    tell: (_id, frame) => heard.push(frame),
    sleep: async () => {
      // The teacher presses «Продолжить занятие» while the cells compute.
      setFinished('ce-resume', null)
      busy = false
    },
    pollMs: 1_000,
    maxWaitMs: 120_000,
  })
  await pendingRefresh('ce-resume')
  assert.equal(publicationOf('ce-resume')!.revision, first.revision)
  // The spinner the host saw is taken back, or it promises a refresh for the rest of the class.
  assert.deepEqual(heard.map((f) => f.state), ['waiting', 'cancelled'])
})

test('a page withdrawn while its refresh waits stays withdrawn', async () => {
  const { book } = room('ce-withdrawn')
  const first = await publish('ce-withdrawn', book, true)
  finish('ce-withdrawn')
  let busy = true
  const heard: PageFrame[] = []
  afterClassFinished('ce-withdrawn', {
    computing: () => busy,
    tell: (_id, frame) => heard.push(frame),
    sleep: async () => {
      // The teacher spots a student's name and presses «Снять страницу» during the wait.
      setPublicationState(first.id, 'withdrawn')
      busy = false
    },
    pollMs: 1_000,
    maxWaitMs: 120_000,
  })
  await pendingRefresh('ce-withdrawn')
  const after = publicationOf('ce-withdrawn')!
  assert.equal(after.state, 'withdrawn', 'the refresh put a withdrawn page back')
  assert.equal(after.revision, first.revision)
  assert.deepEqual(heard.map((f) => f.state), ['waiting', 'cancelled'])
})

test('«Обновить страницу» never restores a withdrawn page', async () => {
  const id = 'ce-manual-withdrawn'
  const { book } = room(id)
  // A picked file, so the build yields once (materials.ts · pause) before it commits.
  const first = await buildAndWrite(
    id,
    { notebooks: [{ root: book, name: 'Семинар' }], files: [{ path: 'gone.txt', name: '' }], autoRefresh: true, ack: [] },
    { by: 'Ада' },
  )
  assert.ok(first.ok, JSON.stringify(first))
  setPublicationState(first.publication.id, 'withdrawn')
  const refused = await refreshPage(id, { by: 'Ада' })
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.status, 409)
  assert.equal(publicationOf(id)!.state, 'withdrawn')
  assert.equal(publicationOf(id)!.revision, first.publication.revision)

  // A refresh already building when the page is withdrawn commits without republishing it.
  setPublicationState(first.publication.id, 'published')
  const building = refreshPage(id, { by: 'Ада' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  setPublicationState(first.publication.id, 'withdrawn')
  const built = await building
  assert.ok(built.ok, JSON.stringify(built))
  assert.equal(publicationOf(id)!.revision, first.publication.revision + 1, 'the race was not raced')
  assert.equal(publicationOf(id)!.state, 'withdrawn', 'a refresh made a withdrawn page public')
})

/* ---------------------------------------------------------------- the day */

test('the course row gets the finish day when it has none, and keeps the one it has', () => {
  room('ce-day-empty')
  room('ce-day-set')
  const course = seat('Дни', [
    { kind: 'seminar', id: 'rceday01', sessionId: 'ce-day-empty', name: 'a', publication: null, day: null },
    { kind: 'seminar', id: 'rceday02', sessionId: 'ce-day-set', name: 'b', publication: null, day: '2026-09-06' },
  ])
  // 21:30 UTC is already the next day in Moscow, the instance's zone here or not.
  const at = Date.UTC(2026, 9, 4, 21, 30)
  finish('ce-day-empty', at)
  finish('ce-day-set', at)
  afterClassFinished('ce-day-empty', fake().deps)
  afterClassFinished('ce-day-set', fake().deps)
  const [empty, set] = getCourse(course)!.items
  assert.equal(empty.day, instanceToday(at))
  assert.equal(set.day, '2026-09-06')
  // A second finish does not move it.
  finish('ce-day-empty', at + 7 * 86_400_000)
  stampClassDay('ce-day-empty')
  assert.equal(getCourse(course)!.items[0].day, instanceToday(at))
})

test('a course saved in the same instant is re-read and the day still lands', () => {
  room('ce-race')
  const id = seat('Гонка', [
    { kind: 'seminar', id: 'rcerace1', sessionId: 'ce-race', name: 'a', publication: null },
  ])
  let raced = false
  rewriteCourseRows((item) => {
    if (item.kind !== 'seminar' || item.sessionId !== 'ce-race' || item.day) return null
    if (!raced) {
      // Another tab saves the course between the read and the write.
      raced = true
      const now = getCourse(id)!
      assert.ok(setCourseItems(id, now.rev, [...now.items, { kind: 'planned', id: 'rcerace2', name: 'Новая тема', when: '' }]))
    }
    return { ...item, day: '2026-10-04' }
  })
  const items = getCourse(id)!.items
  assert.deepEqual(items.map((i) => [i.id, i.day ?? null]), [
    ['rcerace1', '2026-10-04'],
    ['rcerace2', null],
  ])
})

/* -------------------------------------------------------------- the panel */

test('finishing from the panel does the same and says what happens next', async () => {
  room('ce-panel')
  const course = seat('Панель', [{ kind: 'seminar', id: 'rcepan01', sessionId: 'ce-panel', name: 'Неделя 4', publication: null }])
  const patch = (finished: boolean) =>
    fetch(`${base}/api/admin/seminars/ce-panel`, {
      method: 'PATCH',
      headers: { cookie: `${STAFF_COOKIE}=${cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ finished }),
    })
  const finished = await patch(true)
  assert.equal(finished.status, 200)
  const row = (await finished.json()) as { afterClass?: string; finishedAt: number | null }
  assert.equal(row.afterClass, 'offer')
  assert.equal(getCourse(course)!.items[0].day, instanceToday(row.finishedAt!))
  // Resuming says nothing about the page.
  const resumed = (await (await patch(false)).json()) as { afterClass?: string }
  assert.equal(resumed.afterClass, undefined)
})

