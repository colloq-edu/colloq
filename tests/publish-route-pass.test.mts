/**
 * Публикация целиком — один проход истории, и рельса от этого не поехала.
 *
 * Маршрут собирал шаги по одному (`buildPageAt`), а каждый такой вызов — новый
 * `Y.Doc` и повтор всей истории от кейфрейма: до сорока полных повторов на одну
 * публикацию, синхронно, в процессе, где у коллеги в эту минуту идёт пара.
 * Проход вперёд одним документом (`publish/build.ts` · pagesAtAsync) убирает
 * повторы, но платит состоянием, которое живёт между шагами, — и потому обязан
 * доказать, что снаружи ничего не изменилось.
 *
 * Свойства самого прохода проверены в `publish-replay.test.mts`; здесь — то,
 * что через него ходит маршрут: шаг в публикации ровно тот же, что собранный с
 * нуля, порядок рельсы по-прежнему выбирает преподаватель, а выпавший момент
 * по-прежнему назван вслух, а не потерян молча.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { candidatesFor } from '../server/src/publish/candidates.js'
import { newBlobBag, pagesAt } from '../server/src/publish/build.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import type { PublicCell, SkippedStep, StepHeading } from '../shared/publish.js'

const ROOM = 'publish-pass'
let base = ''
let server: http.Server
let cookie = ''
let doc: Y.Doc

function cookieFor(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  const owner = createTeacher({ name: 'Ада', email: 'ada.pass@test.local', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  cookie = cookieFor(owner)

  /* Три названных момента: пустая тетрадь, код, код с выводом. Шаги обязаны
   * выйти разными — иначе «совпало» ничего не значит. */
  createSession(ROOM, 'Градиентный спуск', null)
  doc = getSessionDoc(ROOM, 'Градиентный спуск').doc
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  mark(ROOM, doc, 'checkpoint' as never, null, 'чистая тетрадь', 'moment marked')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import numpy as np'))
  mark(ROOM, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')
  doc.transact(() => {
    const cell = cells.get(1)
    ;(cell.get('source') as Y.Text).insert(0, 'grad(x)')
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'text/plain': '0.014' }, execCount: 2 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([out])
    cell.set('execCount', 2)
  }, 'server')
  mark(ROOM, doc, 'checkpoint' as never, null, 'решение', 'moment marked')

  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  doc?.destroy()
  server?.close()
  shutdownCollab()
})

/** Моменты комнаты по возрастанию — их и предлагает панель. */
const moments = (): number[] =>
  candidatesFor(ROOM)
    .map((c) => c.seq)
    .sort((a, b) => a - b)

/** Страница шага, собранная с нуля: проход длиной в один шаг. */
const alone = (seq: number): PublicCell[] => {
  const page = pagesAt(ROOM, [seq], newBlobBag()).get(seq)
  assert.ok(page?.ok, `шаг ${seq} не собрался в одиночку — сравнивать нечего`)
  return page.cells
}

interface Published {
  publication: { id: string; steps: StepHeading[] }
  skipped: SkippedStep[]
}

async function publish(steps: unknown[]): Promise<Published> {
  const res = await fetch(`${base}/api/admin/seminars/${ROOM}/publish`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ steps }),
  })
  assert.equal(res.status, 200)
  return (await res.json()) as Published
}

async function stepOf(pub: string, seq: number): Promise<PublicCell[]> {
  const res = await fetch(`${base}/api/p/${pub}/step/${seq}`)
  assert.equal(res.status, 200, `шага ${seq} нет на опубликованной странице`)
  const body = (await res.json()) as { step: { cells: PublicCell[] } }
  return body.step.cells
}

test('каждый шаг публикации — тот же, что собранный с нуля', async () => {
  const seqs = moments()
  assert.ok(seqs.length >= 3, 'моменты не записались — публиковать нечего')

  // Порядок рельсы выбирает преподаватель: просим наоборот.
  const asked = [...seqs].reverse().map((seq, i) => ({ seq, label: `шаг ${i + 1}` }))
  const answer = await publish(asked)
  assert.deepEqual(answer.skipped, [], 'шаг выпал там, где выпадать нечему')

  // Рельса — в том порядке, в каком назвали, и с последней страницей в конце.
  assert.deepEqual(
    answer.publication.steps.map((s) => s.seq),
    [...asked.map((s) => s.seq), 0],
    'проход по возрастанию переложил рельсу за преподавателя',
  )
  assert.deepEqual(
    answer.publication.steps.map((s) => s.label),
    [...asked.map((s) => s.label), 'Тетрадь на момент публикации'],
  )

  for (const seq of seqs) {
    assert.deepEqual(
      await stepOf(answer.publication.id, seq),
      alone(seq),
      `шаг ${seq} в общем проходе разошёлся со сборкой с нуля`,
    )
  }

  // И это не «пусто равно пусто»: моменты правда разные.
  const first = await stepOf(answer.publication.id, seqs[0])
  const last = await stepOf(answer.publication.id, seqs[seqs.length - 1])
  assert.notDeepEqual(first, last, 'все шаги вышли одинаковыми — тетрадь собралась не так')
})

test('выпавший момент по-прежнему назван вслух', async () => {
  const seqs = moments()
  const answer = await publish([
    { seq: seqs[0], label: 'первый' },
    // Безымянный шаг не публикуется: «Снимок №14» в рельсе у студента — не
    // название, а признание, что назвать забыли.
    { seq: seqs[1], label: '' },
    // И тот же адрес дважды — это про запрос, а не про занятие.
    { seq: seqs[0], label: 'первый ещё раз' },
  ])
  assert.deepEqual(
    answer.publication.steps.map((s) => s.seq),
    [seqs[0], 0],
    'в рельсу попал шаг, которого не просили',
  )
  assert.deepEqual(
    answer.skipped,
    [
      { seq: seqs[1], label: '', reason: 'unnamed' },
      { seq: seqs[0], label: 'первый ещё раз', reason: 'duplicate' },
    ],
    'выпавшие моменты нечем назвать в панели',
  )
})

test('шаг, которого не из чего собрать, называет причину, а не пропадает', async () => {
  /*
   * Причина приходит из самого прохода (`BuiltPage.reason`), а не из разбора
   * запроса, — и это ровно то, что могло потеряться при переходе на один
   * проход: у комнаты без истории тетрадь на любом шаге пуста.
   */
  const empty = 'publish-pass-empty'
  createSession(empty, 'Комната без истории', null)
  const res = await fetch(`${base}/api/admin/seminars/${empty}/publish`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ seq: 1, label: 'которого не было' }] }),
  })
  assert.equal(res.status, 200)
  const answer = (await res.json()) as Published
  assert.deepEqual(answer.skipped, [{ seq: 1, label: 'которого не было', reason: 'empty' }])
  assert.deepEqual(
    answer.publication.steps.map((s) => s.seq),
    [0],
    'несобранный шаг всё-таки попал в рельсу',
  )
})
