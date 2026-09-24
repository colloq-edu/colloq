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
import { beforeEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
// Existing diagnostic expectations intentionally exercise English; bilingual behavior has its own tests.
beforeEach(() => setLocaleResolver(() => 'en'))
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

test('a large image gets through, and printing after it does not go quiet', async () => {
  /*
   * Images used to be counted from the same wallet as text: a single
   * `plt.imshow` at dpi=200 did not fit into 400 KB, the cell showed the advice
   * "write to a file instead of printing" instead of the chart, and all further
   * output of that cell went quiet until the end of the run. At a computer
   * vision seminar that is exactly the cell everything was run for.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  const png = 'i'.repeat(1_200_000)
  writer.data({ 'image/png': png }, 1)
  writer.stream('stdout', 'после картинки\n')
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  const image = outs.find((o) => o.kind === 'data')
  assert.ok(image, `the image was not shown: ${JSON.stringify(outs.map((o) => o.kind))}`)
  const said = outs.map((o) => (o.kind === 'stream' ? o.text : '')).join('\n')
  assert.match(said, /после картинки/, 'the printing after the image is gone')
  assert.doesNotMatch(said, /instead of printing/, 'the wrong thing was said about the image')
})

test('images are still not unlimited, and the refusal talks about them, not about print', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // Twenty frames of a megabyte each are an animation, not a result: that much
  // would go to everyone in the room, into the snapshot and into the history.
  for (let i = 0; i < 20; i++) writer.data({ 'image/png': 'i'.repeat(1_000_000) }, i + 1)
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  const images = outs.filter((o) => o.kind === 'data').length
  assert.ok(images > 0, 'not a single image was shown')
  assert.ok(images < 20, 'there is no image budget at all')
  const said = outs.map((o) => (o.kind === 'stream' ? o.text : '')).join('\n')
  assert.match(said, /MB image output limit/, 'the image limit was not mentioned')
})

test('a progress bar stays one line even across coalescing windows', async () => {
  /*
   * tqdm and pip draw progress with a carriage return, one frame per coalescing
   * window. Each frame used to go into the document as a separate line:
   * thousands of frames over ten minutes of training are both traffic for the
   * whole room and the cell output ceiling filled up by a progress bar, which
   * cut off the real result.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'Training\n')
  for (let i = 0; i <= 100; i += 10) {
    writer.stream('stdout', `\r${i}% [${'#'.repeat(i / 10)}]`)
    await settle()
  }
  writer.stream('stdout', '\ndone\n')
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.ok(outs[0].kind === 'stream')
  const lines = outs[0].text.split('\n')
  assert.deepEqual(
    lines.slice(0, 3),
    ['Training', '100% [##########]', 'done'],
    `the document got ${JSON.stringify(lines)}`,
  )
})

test('CRLF is a line break, not a new frame', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // A line may arrive in two chunks, and the second ends it the Windows way.
  writer.stream('stdout', 'Collecting')
  await settle()
  writer.stream('stdout', ' torch\r\nDone\r\n')
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.ok(outs[0].kind === 'stream')
  assert.equal(outs[0].text, 'Collecting torch\nDone\n')
})

test('a huge error message is truncated instead of going into the document whole', async () => {
  /*
   * `assert len(rows) == 0, rows` on a list of a million elements puts megabytes
   * into both `evalue` and the last traceback line. The write bypasses the cell
   * ceiling (the traceback is why the cell was run), but "bypasses the ceiling"
   * does not mean "any amount": this goes to all thirty browsers, into the
   * snapshot and into every history keyframe.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  const huge = 'r'.repeat(7_000_000)
  writer.error('AssertionError', huge, ['Traceback:', `  assert rows == [], ${huge}`])
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.ok(outs[0].kind === 'error')
  const size = JSON.stringify(outs[0]).length
  assert.ok(size < 400 * 1024, `the error took ${size} characters`)
  // The start of the message is still there: that is how people see what failed.
  assert.match(outs[0].evalue, /^rrrr/)
  assert.match(outs[0].evalue + outs[0].traceback.join(''), /more characters cut/)
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

/* --------------------------------- deferred clearing (clear_output wait=True) */

test('a promise to replace touches nothing until the replacement arrives', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  assert.equal(outputsOf(doc, id).length, 1)

  // `clear_output(wait=True)` means "clear when there is something to replace it with".
  writer.supersede()
  await settle()
  assert.equal(outputsOf(doc, id).length, 1, 'cleared too early')

  writer.stream('stdout', 'кадр 2\n')
  await settle()
  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.match(JSON.stringify(outs), /кадр 2/)
  assert.doesNotMatch(JSON.stringify(outs), /кадр 1/)
})

test('a new frame is not glued onto the tail of the old one', async () => {
  /*
   * Clearing after mutate rather than before would let append() merge both
   * frames into one Y.Text: the result would be the string "кадр 1\nкадр 2"
   * with no boundary — and it would go into both the snapshot and the export.
   * Not a stale frame but corruption.
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
  assert.equal(outs.length, 1, `${outs.length} entries, but there should be one`)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[0].text, 'кадр 2\n')
})

test('a promise that nothing followed is carried out at the end', async () => {
  // Otherwise the widget frame marked for clearing would never go: the screen
  // would keep an image the kernel has already cancelled.
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  writer.supersede()
  writer.dispose()
  assert.equal(outputsOf(doc, id).length, 0, 'the cancelled frame stayed on screen')
})

test('an immediate clear cancels the deferred one', async () => {
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
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[0].text, 'a', 'the deferred clear ate what had already been written')
})

test('a cell that hit the ceiling still accepts a replacement', async () => {
  /*
   * `stream` used to refuse every chunk after an overflow — including the one
   * that was supposed to carry out the deferred clear and reset the budget. The
   * cell kept the previous output until the end of the run, and a short test
   * does not show this at all.
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
  assert.equal(outs.length, 1, `${outs.length} entries`)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[0].text, 'после переполнения\n')
})

test('the first output does not wait for the coalescing window', async () => {
  // The window exists so that two hundred writes do not become two hundred
  // updates. On the first byte it saves nothing and costs the milliseconds the
  // room spends looking at an empty spot.
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // As in production: runOne clears the previous output in the starting
  // transaction, before execute. Without this line the test checked a path the
  // product does not have.
  writer.clear()
  writer.stream('stdout', 'первая строка\n')
  assert.equal(outputsOf(doc, id).length, 1, 'the first output was held back')

  // And after that, as before: two chunks in one tick are merged.
  writer.stream('stdout', 'вторая\n')
  writer.stream('stdout', 'третья\n')
  await settle()
  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.equal(outs[0].kind, 'stream')
  assert.match(outs[0].text, /первая строка\nвторая\nтретья/)
})
