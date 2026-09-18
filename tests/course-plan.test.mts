/**
 * Строки «по плану» из панели.
 *
 * Завести план семестра можно было только скриптом из таблицы или запросом к
 * API: экран курса строки плана показывал, но не заводил, не правил и не
 * ставил на их место состоявшееся занятие. Здесь — решения экрана
 * (web/src/admin/course-plan.ts) и то, что сервер делает с тем, что экран
 * присылает (PUT /api/admin/courses/:id/items).
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

/* ------------------------------------------------------------ решения экрана */

test('строка плана из набранного: тема обязательна, обрезка та же, что у сервера', () => {
  assert.equal(plannedRow('   ', '1–7 сен'), null, 'пустая тема стала строкой')
  assert.deepEqual(plannedRow('  Бустинг ', ' 14–20 сен '), week('Бустинг', '14–20 сен'))
  assert.deepEqual(plannedRow('Бустинг', ''), week('Бустинг', ''), 'неделя необязательна')
  const long = plannedRow('т'.repeat(MAX_COURSE_NAME + 10), 'н'.repeat(MAX_PLANNED_WHEN + 10))!
  assert.equal(long.name.length, MAX_COURSE_NAME)
  assert.equal(long.when.length, MAX_PLANNED_WHEN)
})

test('новая тема встаёт в конец, правка — на своё место', () => {
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
  assert.deepEqual(items[1], week('Деревья', '8–14 сен'), 'исходный список изменён на месте')
})

test('правка по номеру, под которым уже другая строка, не пишет ничего', () => {
  /*
   * Поле открыли на «Деревьях» (строка 2), а курс тем временем переставили:
   * на второй позиции теперь «Регрессия». Запись по номеру переименовала бы
   * чужую неделю — молча, на странице, которую читает поток.
   */
  const swapped: CourseItem[] = [week('Деревья', '8–14 сен'), week('Регрессия', '1–7 сен')]
  const target = { at: 1, was: week('Деревья', '8–14 сен') }
  assert.equal(putPlanned(swapped, week('Деревья решений', '8–14 сен'), target), null)
  assert.equal(seatSeminar(swapped, target, { id: 'room1', name: 'Деревья' }), null)
  // И если на месте строки плана теперь занятие — тоже.
  const seated: CourseItem[] = [
    week('Регрессия', '1–7 сен'),
    { kind: 'seminar', sessionId: 'room1', name: 'Деревья', publication: null },
  ]
  assert.equal(putPlanned(seated, week('x', ''), target), null)
})

test('занятие встаёт на место строки плана, и нумерация недель не уезжает', () => {
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
  // Второй раз ту же комнату в курс не ставим: две строки одной комнаты
  // читаются как две разные недели.
  assert.equal(
    seatSeminar(next, { at: 2, was: week('Бустинг', '15–21 сен') }, { id: 'room1', name: 'x' }),
    null,
  )
})

test('счёт курса видит строки плана', () => {
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

/* ------------------------------------------------------------------- сервер */

let teacher: ReturnType<typeof createTeacher> = null

async function panel(): Promise<{
  put: (id: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  get: (route: string) => Promise<{ status: number; body: Record<string, unknown> }>
  close: () => Promise<void>
}> {
  // Одна владелица на файл: второй `createTeacher` с тем же адресом — null.
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

test('план из панели: завести, поправить, переставить, заменить занятием, убрать', async () => {
  createSession('plan-room', 'Деревья решений', null)
  const course = createCourse('ML · план', null, 'Ада')
  const api = await panel()

  // Завести: три недели, одна без даты.
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

  // Поправить тему и неделю, переставить — одним составом, как шлёт экран.
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

  // Занятие на место «Деревьев» — позиция та же, имя — комнаты.
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

  // Страница курса: строки плана с неделей, комната — без своего адреса.
  const view = await api.get(`/api/c/${course.id}`)
  assert.equal(view.status, 200)
  const items = (view.body.course as { items: CourseItem[] }).items
  assert.deepEqual(items[0], week('Бустинг', '15–21 сен'))
  assert.equal(items[2].kind === 'seminar' && items[2].sessionId, '', 'адрес комнаты ушёл наружу')

  // Убрать строку плана.
  const dropped = await api.put(course.id, { rev: three.rev, items: three.items.slice(1) })
  assert.equal(dropped.status, 200)
  assert.equal((dropped.body.course as Course).items.length, 2)
  await api.close()
})

test('строка плана без темы — отказ словами, а не молчаливая пропажа', async () => {
  /*
   * Раньше такая строка выбрасывалась, а ответ был 200: «Добавить» с пустой
   * темой выглядело успехом, после которого строки нет. Отказ не пишет ничего —
   * и остальные строки того же запроса тоже.
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
  assert.equal(now.rev, saved.rev, 'отказ всё-таки записал состав')
  assert.deepEqual(now.items, [week('Регрессия', '1–7 сен')])
  await api.close()
})

test('неделя режется по общей константе, а устаревшая версия — 409 с правдой', async () => {
  const course = createCourse('Длинная неделя', null, null)
  const api = await panel()
  const long = 'н'.repeat(MAX_PLANNED_WHEN + 25)
  const res = await api.put(course.id, { rev: course.rev, items: [week('Тема', long)] })
  assert.equal(res.status, 200)
  const saved = res.body.course as Course
  assert.equal(saved.items[0].kind === 'planned' && saved.items[0].when.length, MAX_PLANNED_WHEN)

  // Экран держит старую версию: запись не проходит, ответ несёт курс как есть.
  const stale = await api.put(course.id, { rev: course.rev, items: [] })
  assert.equal(stale.status, 409)
  assert.equal((stale.body.course as Course).items.length, 1)
  assert.equal(getCourse(course.id)!.items.length, 1)
  await api.close()
})

/* ------------------------------------------------------ набор подряд, экран */

/** Разметка и код без комментариев: объяснение — не обещание. */
const source = (rel: string): string =>
  fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('новая тема: форма пустеет сразу, а не по ответу, и закрытую ответ не открывает', () => {
  /*
   * Стенд с записью в полторы секунды: Enter в поле недели, курсор остаётся в
   * нём, следующая тема печаталась в хвост недели («1–7 сенДеревья»), и
   * пришедший ответ стирал обе строки. «Отмена» посреди записи — форма
   * открывалась снова, когда ответ доезжал.
   */
  const screen = source('web/src/admin/screens/Courses.svelte')
  const save = screen.slice(screen.indexOf('async function savePlan'), screen.indexOf('function openSeat'))
  const sent = save.indexOf('const writing = writeItems(next)')
  const cleared = save.indexOf("plan = { target: null, name: '', when: '' }")
  const answered = save.indexOf('await writing')
  assert.ok(sent > 0 && cleared > sent && answered > cleared, 'форма пустеет только после ответа')
  assert.match(save, /plan === fresh/, 'ответ после «Отмены» снова открывает форму')
  assert.match(save, /\.\.\.typed/, 'несохранённая тема не возвращается после сбоя')
  const keys = screen.slice(screen.indexOf('function planKeys'), screen.indexOf('/** Семинары, которых'))
  assert.match(keys, /isComposing\) return/, 'Enter из IME сохраняет недонабранную тему')
})

test('длинная неделя на странице курса переносится, а не ложится поверх темы', () => {
  /*
   * Неделю набирают руками, до MAX_PLANNED_WHEN знаков. С `nowrap` на
   * телефоне в 390 она забирала всю строку: тема — по слову в строке, неделя —
   * поверх неё. И в комнатном чтении, и в выгрузке сайта.
   */
  const list = source('web/src/components/reader/CourseList.svelte')
  const planned = list.slice(list.indexOf("item.kind === 'planned'"))
  const when = /<span class="([^"]*)">\{item\.when\}<\/span>/.exec(planned)
  assert.ok(when, 'неделя строки плана не найдена')
  assert.doesNotMatch(when[1], /whitespace-nowrap/)
  assert.match(when[1], /max-w-/)
  const html = renderCourse(
    { id: 'c', slug: null, name: 'Курс', blurb: null, items: [week('Тема', 'н'.repeat(MAX_PLANNED_WHEN))] } as never,
    'https://colloq.ru',
  )
  assert.match(html, /\.row\.off \.s\{white-space:normal;max-width:45%/)
})
