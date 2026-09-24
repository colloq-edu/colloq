/**
 * The oracle's words and cutting, and the cost of building a frame.
 *
 * The Russian plural was written in this module in four different ways, and
 * `clip` in two, and they had already diverged: one copy counted the marker
 * within the budget, the other put it on top, that is, gave the model more
 * than it was allotted. One rule means one copy; it is pinned down here.
 *
 * Next to it is what a frame must not do: read the outputs of every cell of
 * every notebook and create in the document what was not there. Parsing an
 * output is `JSON.parse` of every record, including base64 images of
 * hundreds of kilobytes, and it was done on every question for cells that
 * never even reach the frame.
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

test('plurals by one rule, including 11–14 and 111', () => {
  assert.equal(seconds(1), '1 секунду')
  assert.equal(seconds(2), '2 секунды')
  assert.equal(seconds(5), '5 секунд')
  assert.equal(seconds(11), '11 секунд', 'eleven does not take the singular form')
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

test('a cut fits within the ceiling together with its marker', () => {
  const long = 'a'.repeat(5_000)
  for (const limit of [100, 400, 1_500, 4_999]) {
    const cut = clip(long, limit)
    assert.ok(cut.length <= limit, `a cut at ${limit} came out ${cut.length} long`)
    assert.match(cut, /truncated \d+ chars/)
  }
  // The number in the marker is what was really dropped, not the difference from the ceiling.
  const cut = clip(long, 1_000)
  const dropped = Number(/truncated (\d+) chars/.exec(cut)![1])
  assert.equal(dropped, 5_000 - (cut.length - `\n… truncated ${dropped} chars …\n`.length))
  // Something short is not touched at all.
  assert.equal(clip('коротко', 100), 'коротко')
})

test('the cut marker speaks the language of its frame', () => {
  const russian = clip('б'.repeat(2_000), 300, (n) => `\n… пропущено ${n} знаков …\n`)
  assert.ok(russian.length <= 300)
  assert.match(russian, /пропущено \d+ знаков/)
})

test('one-line cut and flattening of multi-line text', () => {
  assert.equal(clipLine('коротко', 20), 'коротко')
  assert.equal(clipLine('a'.repeat(30), 10).length, 10)
  assert.ok(clipLine('a'.repeat(30), 10).endsWith('…'))
  assert.equal(flatten('первая\n  вторая\tтретья  '), 'первая вторая третья')
})

test('the frame for the model does not parse outputs of distant cells and does not edit the document', () => {
  const id = 'ai-text-context'
  createSession(id, 'Кадр', null)
  const { doc } = getSessionDoc(id)
  // An image of a quarter of a megabyte is exactly what was expensive: base64
  // never goes to the model, yet `JSON.parse` ran over it on every question.
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
  // A cell of an old room, with no output list at all: such cells exist in the
  // database, and it was exactly reading them that created one.
  const bare = getCells(doc).get(getCells(doc).length - 1)
  doc.transact(() => bare.delete('outputs'))
  assert.ok(bare.get('outputs') === undefined, 'test setup failed')

  const text = buildContext(id, ['c_ctx_0'], null)
  assert.match(text, /step_0 = 0/, 'what was asked about is not in the frame')
  // Distant cells are collapsed, together with their images.
  assert.ok(!text.includes('AAAAAAAA'), 'the image base64 went to the model')

  /*
   * And the main thing: reading does not write. `readCell` created an empty
   * output list in a cell through `cellOutputs`, that is, every question
   * about a notebook with old cells was an edit of the document, broadcast
   * to every socket of the room.
   *
   * The comparison is boolean: the cell holds a Y structure bound to a
   * five-megabyte document, and printing it in the text of a failed
   * assertion brings the node down.
   */
  assert.ok(bare.get('outputs') === undefined, 'reading created an output list in the cell')
})
