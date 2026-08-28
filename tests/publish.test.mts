/**
 * Публикация: что уходит наружу и что не уходит.
 *
 * Два обещания, и оба держатся перечислением, а не вычитанием. У документа
 * четыре корня, и тетрадь только один из них: в `chat` имена всех, кто
 * спрашивал оракула, в `terminal` — всё, что кто-нибудь напечатал в оболочку.
 * Внутри ячейки то же: `runBy` и `runById` стоят на каждой запущенной. Поэтому
 * здесь проверяется не «нет ли имён в этом примере», а точный набор ключей:
 * поле, добавленное в тетрадь завтра, не должно оказаться на публичной
 * странице само собой.
 *
 * И второе: шагом может стать только версия, которая разворачивается хотя бы в
 * одну ячейку. Пустая страница у студента невозможна не потому, что о ней
 * позаботились, а потому, что такой шаг не собирается.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { candidatesFor } from '../server/src/publish/candidates.js'
import { newBlobBag, pageAt, pageOfDoc } from '../server/src/publish/build.js'
import {
  createCourse,
  entombSeminar,
  getCourse,
  publicationOf,
  readStep,
  setCourseItems,
  stepHeadings,
  writePublication,
} from '../server/src/publish/store.js'
import { BLOB_PREFIX } from '../shared/publish.js'

after(() => shutdownCollab())

/** Комната с двумя названными моментами и одним выводом от ядра. */
function taught(id: string): Y.Doc {
  createSession(id, 'Деревья и леса', null)
  const { doc } = getSessionDoc(id, 'Деревья и леса')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import pandas as pd'))
  mark(id, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')
  doc.transact(() => {
    const cell = cells.get(1)
    ;(cell.get('source') as Y.Text).insert(0, 'df.head()')
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'text/plain': 'таблица' }, execCount: 3 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([out])
    cell.set('execCount', 3)
    cell.set('ranMs', 1400)
    // То, чего наружу быть не должно ни при каких обстоятельствах.
    cell.set('runBy', 'Нина')
    cell.set('runById', 'p_nina')
    cell.set('state', 'ok')
  }, 'server')
  mark(id, doc, 'checkpoint' as never, null, 'решение', 'moment marked')
  return doc
}

test('на публичной странице ровно шесть полей ячейки, и среди них нет имён', () => {
  const doc = taught('pub-fields')
  const page = pageOfDoc(doc, newBlobBag())
  const withOutput = page.find((c) => c.outputs.length > 0)
  assert.ok(withOutput, 'ячейка с выводом не нашлась')
  assert.deepEqual(
    Object.keys(withOutput).sort(),
    ['execCount', 'id', 'outputs', 'ranMs', 'source', 'type'],
    'состав полей публичной ячейки изменился — проверьте, что новое поле правда можно показывать',
  )
  // И на всякий случай сама подстрока: набор ключей мог бы совпасть, а имя
  // приехать внутри вывода.
  assert.ok(!JSON.stringify(page).includes('Нина'))
  assert.ok(!JSON.stringify(page).includes('p_nina'))
})

test('кандидатами становятся только названные моменты, и только с тетрадью', () => {
  const id = 'pub-cands'
  taught(id)
  const candidates = candidatesFor(id)
  assert.ok(candidates.length >= 3, 'моменты не нашлись')
  assert.ok(
    candidates.every((c) => c.cellCount > 0),
    'в кандидатах есть версия, разворачивающаяся в пустую тетрадь',
  )
  // Всплески правок моментами не бывают: их десятки за пару и их никто не называл.
  assert.ok(!candidates.some((c) => c.kind === 'edit' || c.kind === 'quiet'))
  const named = candidates.filter((c) => c.label)
  assert.deepEqual(named.map((c) => c.label), ['перед упражнением', 'решение'])
  // Служебному снимку имя не выдумывается: «Снимок №14» в рельсе у студента —
  // не название момента, а признание, что назвать его забыли.
  assert.ok(candidates.some((c) => c.kind === 'opened' && c.label === ''))
})

test('шаг несёт тетрадь на свой момент, а не сегодняшнюю', () => {
  const id = 'pub-moments'
  const doc = taught(id)
  const [before, solution] = candidatesFor(id).filter((c) => c.label)
  const bag = newBlobBag()
  const early = pageAt(id, before.seq, bag)
  const later = pageAt(id, solution.seq, bag)
  assert.ok(early && later)
  assert.equal(early.find((c) => c.outputs.length > 0), undefined, 'ранний шаг уже несёт вывод')
  assert.ok(later.some((c) => c.outputs.length > 0), 'поздний шаг вывод потерял')
  doc.destroy()
})

test('крупная картинка лежит один раз, а в странице стоит ссылка', () => {
  // График matplotlib одинаков во всех шагах, где его ячейка не менялась:
  // шесть шагов давали бы шесть копий одной картинки.
  const id = 'pub-blobs'
  createSession(id, 'С графиком', null)
  const { doc } = getSessionDoc(id, 'С графиком')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  const png = 'A'.repeat(40_000)
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'image/png': png }, execCount: 1 }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')

  const bag = newBlobBag()
  const first = pageOfDoc(doc, bag)
  const again = pageOfDoc(doc, bag)
  const ref = (page: typeof first) =>
    page.flatMap((c) => c.outputs).find((o) => o.kind === 'data')?.data['image/png']
  assert.ok(ref(first)?.startsWith(BLOB_PREFIX), 'картинка осталась в странице целиком')
  assert.equal(ref(first), ref(again), 'та же картинка получила два адреса')
  assert.equal(bag.all().length, 1, 'одна картинка легла дважды')
})

test('удалённый семинар оставляет в курсе надгробие, а не дыру', () => {
  /*
   * Курс, из которого молча пропала четвёртая неделя, сломан для того, кто на
   * ней сидел, а нумерация остальных уезжает и перестаёт совпадать с
   * расписанием.
   */
  const id = 'pub-gone'
  createSession(id, 'Регуляризация', null)
  const course = createCourse('Прикладной ML', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Регуляризация', publication: null },
  ])
  entombSeminar(id, 'Регуляризация')
  const after = getCourse(course.id)!
  assert.equal(after.items.length, 1, 'строка исчезла вместе с семинаром')
  assert.equal(after.items[0].kind, 'gone')
  assert.equal(after.items[0].kind === 'gone' && after.items[0].name, 'Регуляризация')
})

test('повторная публикация сохраняет адрес и заменяет шаги', () => {
  // Ссылку у студентов не отозвать: адрес обязан пережить любую перепубликацию.
  const id = 'pub-again'
  const doc = taught(id)
  const bag = newBlobBag()
  const one = writePublication({
    sessionId: id,
    title: 'Деревья и леса',
    by: 'Ада',
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  const two = writePublication({
    sessionId: id,
    title: 'Деревья и леса',
    by: 'Ада',
    steps: [
      { seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) },
      { seq: 99, label: 'и ещё один', at: Date.now(), cells: pageOfDoc(doc, bag) },
    ],
    blobs: bag.all(),
  })
  assert.equal(one.id, two.id, 'повторная публикация выдала новый адрес')
  assert.equal(two.revision, 2)
  assert.equal(stepHeadings(two.id).length, 2)
  assert.equal(publicationOf(id)?.id, one.id)
  assert.ok(readStep(two.id, null), 'первый шаг не читается')
})
