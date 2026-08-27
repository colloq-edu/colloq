/**
 * Kernel messages becoming cell outputs.
 *
 * This is the narrowest place where a bug is invisible: the cell runs, Python is
 * fine, and the room simply never sees the answer. The coalescing and the caps
 * exist because the document is shared — every write here fans out to everyone —
 * so the properties worth pinning are "nothing is lost" and "one runaway cell
 * cannot make the notebook unloadable for the whole seminar".
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellId, createCell, getCells, readCell } from '../shared/notebook.js'
import { OutputWriter } from '../server/src/kernel/outputs.js'

const FLUSH_MS = 80

function cellIn(doc: Y.Doc): string {
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  return cellId(cell)
}
const settle = () => new Promise((r) => setTimeout(r, FLUSH_MS))
const outputsOf = (doc: Y.Doc, id: string) => {
  const found = getCells(doc)
    .toArray()
    .find((c) => cellId(c) === id)
  return readCell(found!).outputs
}

test('a loop that prints a line at a time arrives as one block, in order', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  for (let i = 0; i < 200; i++) writer.stream('stdout', `line ${i}\n`)
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1, `coalescing produced ${outs.length} outputs`)
  assert.ok(outs[0].kind === 'stream')
  const lines = outs[0].text.trimEnd().split('\n')
  assert.equal(lines.length, 200, 'lines went missing')
  assert.equal(lines[0], 'line 0')
  assert.equal(lines[199], 'line 199')
})

test('stdout and stderr stay apart and stay in order', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'before\n')
  writer.stream('stderr', 'warning\n')
  writer.stream('stdout', 'after\n')
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  // A warning in the middle must not be reordered to the end, or the student
  // reads it as being about the wrong line.
  const shape = outs.map((o) => (o.kind === 'stream' ? `${o.name}:${o.text.trim()}` : o.kind))
  assert.deepEqual(shape, ['stdout:before', 'stderr:warning', 'stdout:after'])
})

test('a result is written after the printing that came before it', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'computing\n')
  writer.data({ 'text/plain': '42' }, 1)
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[1].kind, 'data')
  assert.ok(outs[1].kind === 'data' && outs[1].data['text/plain'] === '42')
})

test('an error carries the name, the value and the traceback', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.error('RuntimeError', 'CUDA out of memory', ['frame one', 'frame two'])
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.ok(outs[0].kind === 'error')
  assert.equal(outs[0].ename, 'RuntimeError')
  assert.equal(outs[0].evalue, 'CUDA out of memory')
  assert.deepEqual(outs[0].traceback, ['frame one', 'frame two'])
})

test('a thousand-frame traceback is cut down before it reaches the room', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // RecursionError really does produce thousands of identical frames, and every
  // one of them would be sent to every browser in the seminar.
  writer.error('RecursionError', 'maximum recursion depth exceeded', Array.from({ length: 3000 }, (_, i) => `frame ${i}`))
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.ok(outs[0].kind === 'error')
  assert.ok(outs[0].traceback.length < 3000, 'the whole traceback was kept')
  assert.ok(outs[0].traceback.length > 0, 'the traceback was thrown away entirely')
  // The tail is where the actual error is; keeping only the head would be worse
  // than useless.
  assert.match(outs[0].traceback.join('\n'), /frame 2999|truncated|omitted|…/i)
})

test('a runaway cell is capped, and says so instead of going quiet', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  const chunk = 'x'.repeat(64 * 1024)
  for (let i = 0; i < 20; i++) writer.stream('stdout', chunk)
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  const total = outs.reduce((n, o) => n + (o.kind === 'stream' ? o.text.length : 0), 0)
  assert.ok(total < 20 * 64 * 1024, 'nothing was capped')
  // Silence would read as a broken cell. There has to be a line saying why.
  const said = outs.map((o) => (o.kind === 'stream' ? o.text : JSON.stringify(o))).join('\n')
  assert.match(said, /truncat|cut|limit|too much|stopped/i)
})

test('writing to a disposed writer is a no-op, not a crash', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'before\n')
  await settle()
  writer.dispose?.()
  // A cell interrupted mid-run keeps receiving messages for a moment after.
  assert.doesNotThrow(() => {
    writer.stream('stdout', 'after dispose\n')
    writer.data({ 'text/plain': 'late' }, 2)
    writer.error('LateError', 'late', ['late'])
  })
  await settle()
  const said = outputsOf(doc, id)
    .map((o) => (o.kind === 'stream' ? o.text : JSON.stringify(o)))
    .join('\n')
  assert.ok(!said.includes('after dispose'), 'a disposed writer still wrote')
})

/* ------------------------------- отложенное стирание (clear_output wait=True) */

test('обещание заменить ничего не трогает, пока замены нет', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  assert.equal(outputsOf(doc, id).length, 1)

  // `clear_output(wait=True)` — «сотри, когда будет чем заменить».
  writer.supersede()
  await settle()
  assert.equal(outputsOf(doc, id).length, 1, 'стёрли раньше времени')

  writer.stream('stdout', 'кадр 2\n')
  await settle()
  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.match(JSON.stringify(outs), /кадр 2/)
  assert.doesNotMatch(JSON.stringify(outs), /кадр 1/)
})

test('новый кадр не подклеивается в хвост старого', async () => {
  /*
   * Стереть после mutate, а не до, значит дать append() слить оба кадра в один
   * Y.Text: получилась бы строка «кадр 1\nкадр 2» без границы — и она поехала
   * бы и в снимок, и в экспорт. Не устаревший кадр, а порча.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  writer.supersede()
  writer.stream('stdout', 'кадр 2\n')
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1, `записей ${outs.length}, а должна быть одна`)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[0].text, 'кадр 2\n')
})

test('обещание, за которым ничего не пришло, выполняется в конце', async () => {
  // Иначе стёртый кадр виджета не вернулся бы никогда: на экране осталась бы
  // картинка, которую ядро уже отменило.
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  writer.supersede()
  writer.dispose()
  assert.equal(outputsOf(doc, id).length, 0, 'отменённый кадр остался на экране')
})

test('немедленное стирание снимает отложенное', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  writer.supersede()
  writer.clear()
  writer.stream('stdout', 'a')
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.equal(outs[0].text, 'a', 'отложенное стирание съело то, что уже написали')
})

test('упёршаяся в потолок ячейка всё же принимает замену', async () => {
  /*
   * Раньше `stream` отказывал каждому куску после переполнения — включая тот,
   * который должен был выполнить отложенное стирание и сбросить бюджет. Ячейка
   * держала прошлый вывод до конца выполнения, и в коротком тесте этого не
   * видно вовсе.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'x'.repeat(600_000))
  await settle()
  assert.ok(outputsOf(doc, id).length > 0)

  writer.supersede()
  writer.stream('stdout', 'после переполнения\n')
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1, `записей ${outs.length}`)
  assert.equal(outs[0].text, 'после переполнения\n')
})

test('первый вывод не ждёт окна склейки', async () => {
  // Окно существует, чтобы двести записей не стали двумястами обновлениями. На
  // первом байте оно не экономит ничего и стоит тех миллисекунд, которые
  // комната смотрит на пустое место.
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'первая строка\n')
  assert.equal(outputsOf(doc, id).length, 1, 'первый вывод придержали')

  // А дальше — как было: два куска в одном тике склеиваются.
  writer.stream('stdout', 'вторая\n')
  writer.stream('stdout', 'третья\n')
  await settle()
  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.match(outs[0].text ?? '', /первая строка\nвторая\nтретья/)
})
