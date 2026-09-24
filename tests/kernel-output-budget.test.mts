/**
 * Two properties of cell output that broke silently.
 *
 * The first is "the first output does not wait for the merge window". The
 * mechanism exists precisely for the fifty milliseconds the room stares at an
 * empty space after a press, and in production it did not work: `runOne`
 * calls `writer.clear()` in the starting transaction EVEN BEFORE execute, and
 * the "already wrote" flag was raised on any write, including the clearing.
 * The old test did not catch this because it did not call `clear()` before
 * the first output — that is, it checked a path that does not exist in the
 * product.
 *
 * The second is the image ceiling. It is per cell, but the room pays for it:
 * output goes to every open socket, each in its own copy and with its own
 * deflate. Six megabytes of `imshow` in a seminar of thirty is a hundred and
 * eighty megabytes; the same six in a lecture of five hundred is a gigabyte
 * of egress, behind which everyone's own typing gets stuck in a queue.
 */
import './_env.mts'
import { beforeEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
// Existing diagnostic expectations intentionally exercise English; bilingual behavior has its own tests.
beforeEach(() => setLocaleResolver(() => 'en'))
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellId, createCell, getCells, readCell } from '../shared/notebook.js'
import { dataBudgetFor, OutputWriter } from '../server/src/kernel/outputs.js'

function cellIn(doc: Y.Doc): string {
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  return cellId(cell)
}
const outputsOf = (doc: Y.Doc, id: string) => {
  const found = getCells(doc)
    .toArray()
    .find((c) => cellId(c) === id)
  return readCell(found!).outputs
}
const settle = () => new Promise((r) => setTimeout(r, 80))

test('the first output does not wait for the merge window even after clear() at the start', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // Exactly what runOne does in the starting transaction: it clears the
  // previous output.
  writer.clear()
  writer.stream('stdout', 'первая строка\n')
  assert.equal(outputsOf(doc, id).length, 1, 'the first output was held back for the merge window')

  // After that — as before: adjacent chunks within one tick go as one write.
  writer.stream('stdout', 'вторая\n')
  writer.stream('stdout', 'третья\n')
  await settle()
  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.ok(outs[0].kind === 'stream')
  assert.match(outs[0].text, /первая строка\nвторая\nтретья/)
  writer.dispose()
})

test('a progress-bar redraw is still merged', async () => {
  // `clear()` does not reset the flag: otherwise a widget frame would be
  // written unmerged twenty times a second — to the whole room.
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'начало\n')
  await settle()
  writer.clear()
  writer.stream('stdout', 'кадр 1\n')
  writer.stream('stdout', 'кадр 2\n')
  assert.equal(outputsOf(doc, id).length, 0, 'after the first write the merge must hold')
  await settle()
  assert.equal(outputsOf(doc, id).length, 1)
  writer.dispose()
})

test('the image ceiling drops as the audience grows, but not to zero', () => {
  const seminar = dataBudgetFor(30)
  const lecture = dataBudgetFor(500)
  assert.equal(dataBudgetFor(1), seminar, 'the ceiling for an ordinary seminar is unchanged')
  assert.ok(lecture < seminar, 'with five hundred people the budget must be smaller')
  assert.ok(lecture >= 512 * 1024, 'a single matplotlib image must always get through')
  // And monotonically: the bigger the audience, the smaller the frame — no
  // steps up.
  let previous = seminar
  for (const viewers of [50, 100, 200, 500, 1000]) {
    const now = dataBudgetFor(viewers)
    assert.ok(now <= previous, `the budget grew at ${viewers} viewers`)
    previous = now
  }
})

test('in a lecture a cell hits the image limit sooner than in a seminar', () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id, dataBudgetFor(500))
  // Three one-megabyte "images": a seminar would pass them all, here not all.
  for (let i = 0; i < 3; i++) writer.data({ 'image/png': 'x'.repeat(1024 * 1024) }, null)
  writer.dispose()

  const outs = outputsOf(doc, id)
  const images = outs.filter((o) => o.kind === 'data')
  assert.ok(images.length < 3, 'the lecture budget did not kick in at all')
  const notice = outs.find((o) => o.kind === 'stream' && /images/.test(o.text))
  assert.ok(notice, `the refusal must be stated in words: ${JSON.stringify(outs)}`)
})
