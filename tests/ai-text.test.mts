/**
 * Слова и обрезка оракула — и цена сборки кадра.
 *
 * Русский плюрал был написан в этом модуле четырьмя разными способами, а
 * `clip` — двумя, и они уже разошлись: одна копия считала маркер в бюджет,
 * другая клала его сверх — то есть отдавала модели больше, чем ей отвели.
 * Правило одно, значит и копия одна; здесь она закреплена.
 *
 * Рядом — то, чего кадр делать не должен: читать выводы всех ячеек всех
 * тетрадей и заводить в документе то, чего в нём не было. Разбор вывода —
 * `JSON.parse` каждой записи, включая base64 картинки на сотни килобайт, и
 * делался он на каждый вопрос для ячеек, которые до кадра и не доезжают.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cellsWord,
  clip,
  clipLine,
  flatten,
  groupsWord,
  pad,
  people,
  plural,
  seconds,
} from '../server/src/ai/text.js'
import { buildContext } from '../server/src/ai/context.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { cellOutputs, createCell, getCells, writeOutput } from '@shared/notebook'

test('плурал по одному правилу — включая 11–14 и 111', () => {
  assert.equal(seconds(1), '1 секунду')
  assert.equal(seconds(2), '2 секунды')
  assert.equal(seconds(5), '5 секунд')
  assert.equal(seconds(11), '11 секунд', 'одиннадцать — не «одну»')
  assert.equal(seconds(21), '21 секунду')
  assert.equal(seconds(22), '22 секунды')
  assert.equal(seconds(111), '111 секунд')
  assert.equal(seconds(114), '114 секунд')
  assert.equal(seconds(122), '122 секунды')

  assert.equal(people(1), '1 человек')
  assert.equal(people(3), '3 человека')
  assert.equal(people(15), '15 человек')
  assert.equal(groupsWord(1), 'группа')
  assert.equal(groupsWord(4), 'группы')
  assert.equal(groupsWord(12), 'групп')
  assert.equal(cellsWord(1), 'ячейка')
  assert.equal(cellsWord(3), 'ячейки')
  assert.equal(cellsWord(13), 'ячеек')
  assert.equal(plural(0, 'а', 'б', 'в'), 'в')
  assert.equal(pad(3), '03')
})

test('обрезка укладывается в потолок вместе со своим маркером', () => {
  const long = 'a'.repeat(5_000)
  for (const limit of [100, 400, 1_500, 4_999]) {
    const cut = clip(long, limit)
    assert.ok(cut.length <= limit, `обрезка на ${limit} вышла длиной ${cut.length}`)
    assert.match(cut, /truncated \d+ chars/)
  }
  // Число в маркере — то, что правда выброшено, а не разница с потолком.
  const cut = clip(long, 1_000)
  const dropped = Number(/truncated (\d+) chars/.exec(cut)![1])
  assert.equal(dropped, 5_000 - (cut.length - `\n… truncated ${dropped} chars …\n`.length))
  // Короткое не трогается вовсе.
  assert.equal(clip('коротко', 100), 'коротко')
})

test('маркер обрезки говорит на языке своего кадра', () => {
  const russian = clip('б'.repeat(2_000), 300, (n) => `\n… пропущено ${n} знаков …\n`)
  assert.ok(russian.length <= 300)
  assert.match(russian, /пропущено \d+ знаков/)
})

test('однострочная обрезка и распрямление многострочного', () => {
  assert.equal(clipLine('коротко', 20), 'коротко')
  assert.equal(clipLine('a'.repeat(30), 10).length, 10)
  assert.ok(clipLine('a'.repeat(30), 10).endsWith('…'))
  assert.equal(flatten('первая\n  вторая\tтретья  '), 'первая вторая третья')
})

test('кадр для модели не разбирает выводы дальних ячеек и не правит документ', () => {
  const id = 'ai-text-context'
  createSession(id, 'Кадр', null)
  const { doc } = getSessionDoc(id)
  // Картинка на четверть мегабайта — ровно то, что стоило дорого: base64 в
  // модель не едет никогда, а `JSON.parse` по нему шёл на каждый вопрос.
  const heavy = 'A'.repeat(250_000)
  doc.transact(() => {
    const cells = getCells(doc)
    for (let i = 0; i < 40; i++) {
      const cell = createCell('code', `step_${i} = ${i}`, `c_ctx_${i}`)
      cells.push([cell])
      if (i % 2 === 0) {
        cellOutputs(cell).push([writeOutput({ kind: 'data', data: { 'image/png': heavy }, execCount: null })])
      }
    }
    cells.push([createCell('code', 'последняя = 1', 'c_ctx_bare')])
  })
  // Ячейка старой комнаты — без списка выводов вовсе: такие в базе есть, и
  // именно их чтение и заводило.
  const bare = getCells(doc).get(getCells(doc).length - 1)
  doc.transact(() => bare.delete('outputs'))
  assert.ok(bare.get('outputs') === undefined, 'подготовка теста не удалась')

  const text = buildContext(id, ['c_ctx_0'], null)
  assert.match(text, /step_0 = 0/, 'о чём спросили, того в кадре нет')
  // Дальние ячейки свёрнуты — вместе со своими картинками.
  assert.ok(!text.includes('AAAAAAAA'), 'base64 картинки уехал модели')

  /*
   * И главное: чтение не пишет. `readCell` заводил в ячейке пустой список
   * выводов через `cellOutputs`, то есть каждый вопрос про тетрадь со старыми
   * ячейками был правкой документа — с рассылкой всем сокетам комнаты.
   *
   * Сравнение — булевым: в ячейке лежит Y-структура, привязанная к документу на
   * пять мегабайт, и печать её в тексте несошедшегося утверждения кладёт узел.
   */
  assert.ok(bare.get('outputs') === undefined, 'чтение завело ячейке список выводов')
})
