/**
 * Базовая точка истории — живой документ, а не сборка на каждый всплеск.
 *
 * Закрытие всплеска обязано знать, как тетрадь выглядит после него. Знало оно
 * это единственным способом: собрать документ заново из базовой точки и
 * склеенного обновления — полный разбор всей тетради, замер на 2.2 МБ дал 37 мс
 * заблокированного цикла событий ради полутора килобайт разницы. И платила за
 * это не запись в историю, а комната: всплеск закрывается на каждом добавлении,
 * удалении и перетаскивании ячейки, то есть эти миллисекунды стоят между
 * нажатиями клавиш у всех остальных.
 *
 * Теневая тетрадь держится живой и двигается тем же обновлением. Сломаться это
 * может тихо и одинаково страшно в обе стороны: слова версии посчитаются
 * относительно СДВИНУТОЙ тетради («ничего не менялось»), или полный снимок
 * запишется из одного всплеска вместо всей тетради — и «Вернуть» отдаст комнате
 * пустую страницу. Проверяется здесь и то и другое.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createCell, getCells } from '../shared/notebook.js'
import { createSession, listVersions } from '../server/src/db.js'
import {
  beginHistory,
  cellsAt,
  flushHistory,
  forgetHistory,
  record,
} from '../server/src/collab/history.js'
import { shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

function room(sessionId: string, author: string | null = 'p_maria'): Y.Doc {
  createSession(sessionId, 'Shadow test', null)
  const doc = new Y.Doc()
  doc.on('update', (update: Uint8Array, _origin, _doc, tr: Y.Transaction) =>
    record(sessionId, doc, update, author, tr),
  )
  return doc
}

function write(doc: Y.Doc, index: number, text: string): void {
  const source = getCells(doc).get(index).get('source') as Y.Text
  source.insert(source.length, text)
}

/** Строка ленты хранит список ячеек текстом — как он лежит в базе. */
const touched = (row: { cells: string | string[] }): string[] =>
  typeof row.cells === 'string' ? (JSON.parse(row.cells) as string[]) : row.cells

const sources = (doc: Y.Doc) =>
  getCells(doc)
    .toArray()
    .map((cell) => (cell.get('source') as Y.Text).toString())

test('двадцать всплесков подряд: каждая версия про своё, и лента совпадает с тетрадью', () => {
  const id = 'shadow-steps'
  const doc = room(id)
  beginHistory(id, doc)
  doc.transact(() => getCells(doc).push([createCell('code', 'x = 1')]))
  flushHistory(id)

  for (let i = 0; i < 20; i++) {
    write(doc, 0, `\nstep ${i}`)
    flushHistory(id)
    const rows = listVersions(id, 40).filter((v) => v.kind === 'edit')
    const last = rows[0]
    assert.ok(last, `всплеск ${i} не записался`)
    assert.equal(touched(last).length, 1, `всплеск ${i} описан не одной ячейкой`)
    assert.ok(last.added > 0, `всплеск ${i} записан как «ничего не менялось»`)
  }

  // И самое главное: последняя версия — это ровно то, что в тетради сейчас.
  const rows = listVersions(id, 40)
  assert.deepEqual(
    cellsAt(id, rows[0].seq).map((c) => c.source),
    sources(doc),
  )
})

test('всплеск после выселения комнаты собирается заново и ничего не теряет', () => {
  const id = 'shadow-evicted'
  const doc = room(id)
  beginHistory(id, doc)
  doc.transact(() => getCells(doc).push([createCell('code', 'первая ячейка')]))
  doc.transact(() => getCells(doc).push([createCell('code', 'вторая ячейка')]))
  flushHistory(id)

  /*
   * Комнату выселили из памяти (десять минут пустоты) — теневой тетради больше
   * нет. Следующая правка обязана описаться относительно всей тетради, а не
   * относительно пустоты: это и есть запасной ход.
   */
  forgetHistory(id)
  beginHistory(id, doc)
  write(doc, 1, ' с дополнением')
  flushHistory(id)

  const rows = listVersions(id, 40)
  const last = rows[0]
  assert.equal(touched(last).length, 1, 'правка тронула одну ячейку')
  assert.deepEqual(cellsAt(id, last.seq).map((c) => c.source), [
    'первая ячейка',
    'вторая ячейка с дополнением',
  ])
})

test('полный снимок содержит всю тетрадь, а не последний всплеск', () => {
  const id = 'shadow-keyframe'
  const doc = room(id)
  beginHistory(id, doc)
  doc.transact(() => getCells(doc).push([createCell('code', 'начало')]))
  flushHistory(id)

  // Много мелких правок подряд: где-то здесь ляжет полный снимок.
  for (let i = 0; i < 40; i++) {
    write(doc, 0, `\nстрока ${i} ${'y'.repeat(2048)}`)
    flushHistory(id)
  }

  const rows = listVersions(id, 200)
  const keyframes = rows.filter((v) => v.kind === 'keyframe')
  assert.ok(keyframes.length > 0, 'полный снимок так и не лёг — проверять нечего')

  /*
   * Снимок читается сам по себе: `cellsAt` для его версии начинает повтор
   * ровно с него. Если бы он был записан из одного всплеска, здесь была бы
   * тетрадь из одной строки — и «Вернуть» отдал бы комнате её.
   */
  const at = cellsAt(id, keyframes[0].seq)
  assert.equal(at.length, 1)
  assert.ok(
    at[0].source.startsWith('начало') && at[0].source.includes('строка 0'),
    'снимок потерял всё, что было до последнего всплеска',
  )
})
