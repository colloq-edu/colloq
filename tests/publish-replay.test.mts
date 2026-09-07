/**
 * Публикация идёт по истории одним документом — и собирает то же самое.
 *
 * Сорок шагов публикации разворачивались сорока новыми `Y.Doc`, каждый от
 * ближайшего кейфрейма: тетрадь с картинками — мегабайты на шаг, и всё это
 * синхронно, в процессе, где у коллеги в эту минуту идёт пара. Проход вперёд
 * одним документом (`publish/replay.ts`) убирает повторы, но платит за это
 * состоянием, которое живёт между шагами, — а значит, обязан доказать, что
 * страница на каждом шаге ровно та же, что при сборке с нуля.
 *
 * Здесь три свойства этого прохода: одинаковость с полной сборкой, стойкость к
 * порядку и повторам в запросе и то, что назад он не отдаёт будущее за
 * прошлое.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { candidatesFor } from '../server/src/publish/candidates.js'
import { newBlobBag, pagesAt, pagesAtAsync, type BuiltPage } from '../server/src/publish/build.js'
import { openReplay } from '../server/src/publish/replay.js'
import { readNotebook } from '../shared/notebook.js'

after(() => shutdownCollab())

/** Комната с тремя названными моментами: чистая тетрадь, код, код с выводом. */
function taught(id: string): Y.Doc {
  createSession(id, 'Градиентный спуск', null)
  const { doc } = getSessionDoc(id, 'Градиентный спуск')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  mark(id, doc, 'checkpoint' as never, null, 'чистая тетрадь', 'moment marked')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import numpy as np'))
  mark(id, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')
  doc.transact(() => {
    const cell = cells.get(1)
    ;(cell.get('source') as Y.Text).insert(0, 'grad(x)')
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'text/plain': '0.014' }, execCount: 2 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([out])
    cell.set('execCount', 2)
  }, 'server')
  mark(id, doc, 'checkpoint' as never, null, 'решение', 'moment marked')
  return doc
}

/** Все моменты комнаты, по возрастанию: их и просит панель публикации. */
const moments = (id: string): number[] =>
  candidatesFor(id)
    .map((c) => c.seq)
    .sort((a, b) => a - b)

/** Страница шага, собранная с нуля: проход длиной в один шаг — это она и есть. */
const alone = (id: string, seq: number): BuiltPage =>
  pagesAt(id, [seq], newBlobBag()).get(seq) ?? { ok: false, reason: 'broken' }

test('шаги, собранные одним проходом, — те же, что собранные по одному', () => {
  const id = 'replay-same'
  const doc = taught(id)
  const seqs = moments(id)
  assert.ok(seqs.length >= 3, 'моменты не записались')

  const together = pagesAt(id, seqs, newBlobBag())
  assert.deepEqual([...together.keys()], seqs, 'проход отдал не те шаги, что просили')
  for (const seq of seqs) {
    assert.deepEqual(
      together.get(seq),
      alone(id, seq),
      `шаг ${seq} в общем проходе разошёлся со сборкой с нуля`,
    )
  }

  // И это не тавтология «пусто равно пусто»: моменты правда разные.
  const pages = seqs.map((seq) => together.get(seq)!)
  assert.notDeepEqual(
    pages[0],
    pages[pages.length - 1],
    'все шаги вышли одинаковыми — тетрадь для теста собралась не так',
  )
  const outputs = pages.map((p) => (p.ok ? p.cells.flatMap((c) => c.outputs).length : -1))
  assert.ok(outputs.includes(0) && outputs.some((n) => n > 0), 'вывод виден на всех шагах сразу')
  doc.destroy()
})

test('порядок и повторы в запросе ничего не меняют', async () => {
  const id = 'replay-order'
  const doc = taught(id)
  const seqs = moments(id)

  const straight = pagesAt(id, seqs, newBlobBag())
  // Панель отдаёт моменты в том порядке, в каком их назвал преподаватель, и
  // один момент может прийти дважды: порядок рельсы — его дело, а не арифметики.
  const shuffled = pagesAt(id, [...seqs].reverse().concat(seqs[0]), newBlobBag())
  assert.deepEqual([...shuffled.keys()], seqs, 'проход не разложил шаги по возрастанию')
  assert.deepEqual(shuffled, straight)

  // Уступка цикла событий между шагами на результат не влияет — она и заведена
  // затем, чтобы не влиять ни на что, кроме занятия рядом.
  assert.deepEqual(await pagesAtAsync(id, seqs, newBlobBag()), straight)
  doc.destroy()
})

test('проход не отдаёт будущее за прошлое', () => {
  /*
   * Документ идёт вперёд и назад не отматывается — CRDT так не умеет. Просьба
   * о строке ниже уже пройденной обязана собрать новый документ, иначе шаг «до
   * упражнения» показал бы решение: страница была бы не пустой, а неверной, и
   * заметить это студенту нечем.
   */
  const id = 'replay-back'
  const doc = taught(id)
  const seqs = moments(id)
  const first = seqs[0]
  const last = seqs[seqs.length - 1]

  const replay = openReplay(id)
  const solo = openReplay(id)
  try {
    const ahead = readNotebook(replay.at(last))
    const back = readNotebook(replay.at(first))
    assert.deepEqual(
      back,
      readNotebook(solo.at(first)),
      'шаг назад собрал не то, что сборка с нуля',
    )
    assert.notDeepEqual(back, ahead, 'ранний момент показал тетрадь позднего')
  } finally {
    replay.close()
    solo.close()
  }
  doc.destroy()
})
