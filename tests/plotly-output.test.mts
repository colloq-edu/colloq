/**
 * An interactive chart: what exactly gets from the kernel to the room.
 *
 * A failure here looks not like breakage but like an empty space: a cell with
 * `px.histogram(...)` reports "done", and under it there is NOTHING. That is
 * how it was before this work, and there is exactly one reason — the bundle
 * from ipykernel with current plotly consists of ONE key,
 * `application/vnd.plotly.v1+json`: there is neither `text/plain` nor an image
 * in it, and the choice of representation had nothing to hold on to.
 *
 * So what is checked is not "is the chart visible" (that is the job of the
 * browser and the frame) but what lies in the document: a JSON string — or,
 * for a large figure, a reference instead — and that dead plotly markup never
 * gets there under any conditions.
 */
import './_env.mts'
import { beforeEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
beforeEach(() => setLocaleResolver(() => 'ru'))
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  cellId,
  cellOutputs,
  createCell,
  getCells,
  readCell,
  writeOutput,
  type CellOutput,
  type YCell,
} from '../shared/notebook.js'
import { renderOutputs } from '../server/src/ai/context.js'
import { renderStep } from '../server/src/publish/render.js'
import { OutputWriter } from '../server/src/kernel/outputs.js'
import { CouncilOutputBuffer, MAX_ATTEMPT_DATA_CHARS } from '../server/src/kernel/council.js'
import { MAX_FIGURE_CHARS, withoutDeadPlotlyHtml } from '../server/src/kernel/figures.js'
import { PLOTLY_MIME, figureShape, normalizeFigure } from '../shared/plotly.js'
import { SPILL_MIMES, spillContentType, spillEncoding } from '../shared/publish.js'
import { createSession } from '../server/src/db.js'
import { readBlob, sniffMime } from '../server/src/blobs.js'

const FLUSH_MS = 80
const settle = () => new Promise((r) => setTimeout(r, FLUSH_MS))

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

/** A figure of the required weight: real points, so the parser accepts it. */
function figure(points: number, kind = 'scatter'): string {
  const x = Array.from({ length: points }, (_, i) => i)
  return JSON.stringify({
    data: [{ type: kind, x, y: x }],
    layout: { title: { text: 'проба' }, height: 420 },
  })
}

/* ------------------------------------------ the bundle from the kernel */

test('a figure arrives as a JSON string and lies in the document as is', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  const body = figure(20)
  writer.data({ [PLOTLY_MIME]: body }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  assert.equal(output.kind, 'data')
  if (output.kind !== 'data') return
  assert.equal(output.data[PLOTLY_MIME], body, 'the figure string changed on the way')
  // A string specifically: JSON.parse of it has to give the same figure.
  const parsed = normalizeFigure(JSON.parse(output.data[PLOTLY_MIME]))
  assert.ok(parsed, 'no figure can be read from the document')
  assert.equal(parsed.data.length, 1)
})

test('dead plotly markup is not put into the document', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // The `plotly_mimetype+notebook` renderer sends both: the figure and hundreds
  // of kilobytes of script that we do not execute anyway.
  const html = `<div id="x" class="plotly-graph-div"></div><script>${'/*'.repeat(5000)}</script>`
  writer.data({ [PLOTLY_MIME]: figure(5), 'text/html': html }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  assert.equal(output.kind, 'data')
  if (output.kind !== 'data') return
  assert.ok(output.data[PLOTLY_MIME], 'the figure was lost together with the markup')
  assert.equal(output.data['text/html'], undefined, 'dead script HTML got into the document')
})

test('the notebook renderer bootstrap — five megabytes of script — goes nowhere', () => {
  // A separate frame: it has ONE key, there is no figure next to it, and it can
  // be recognised only by plotly's own signature. Without this it would land in
  // the document whole and eat the entire output budget of the cell all this was for.
  const bootstrap = `<script>window.PlotlyConfig = {MathJaxConfig: 'local'};${'x'.repeat(200 * 1024)}</script>`
  const kept = withoutDeadPlotlyHtml({ 'text/html': bootstrap })
  assert.deepEqual(kept, {}, 'the plotly bootstrap stayed in the bundle')

  // But ordinary markup — a pandas table — is not touched by anything.
  const table = '<table><tr><td>1</td></tr></table>'
  assert.deepEqual(withoutDeadPlotlyHtml({ 'text/html': table }), { 'text/html': table })
})

/* -------------------------------------------------------- offloading */

test('a large figure goes to the shelf, and a reference stays in the document', async () => {
  const room = 'plotlyblob1'
  createSession(room, 'График')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const body = figure(20_000)
  assert.ok(body.length > 100 * 1024, 'the sample is too light, offloading will not kick in')

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ [PLOTLY_MIME]: body }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  assert.equal(output.kind, 'data')
  if (output.kind !== 'data') return
  assert.equal(output.data[PLOTLY_MIME], undefined, 'the figure megabytes stayed in the document')
  const blob = (output.blobs ?? []).find((b) => b.mime === PLOTLY_MIME)
  assert.ok(blob, 'there is no reference to the offloaded figure')
  // The bytes on the shelf are the same JSON, word for word: a figure is stored as
  // TEXT, not base64, and decoding it as base64 would put garbage there.
  const stored = readBlob(room, blob.sha)
  assert.ok(stored)
  assert.equal(stored.toString('utf8'), body)
  // And it is served not as what the kernel said but as harmless application/json.
  assert.equal(sniffMime(stored), 'application/json')
  assert.equal(spillContentType(PLOTLY_MIME), 'application/json')
})

test('a small figure does not go to the shelf: fetching it would take a second request', async () => {
  const room = 'plotlyblob2'
  createSession(room, 'График')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const body = figure(20)
  assert.ok(body.length < 16 * 1024)

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ [PLOTLY_MIME]: body }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  if (output.kind !== 'data') return assert.fail('not a data entry')
  assert.equal(output.data[PLOTLY_MIME], body)
  assert.equal(output.blobs, undefined)
})

test('offloading and encoding are listed in one set for the whole product', () => {
  assert.ok(SPILL_MIMES.has(PLOTLY_MIME))
  assert.ok(SPILL_MIMES.has('image/png'))
  // An image arrives as base64, a figure as text. Mixing them up means putting
  // garbage on the shelf and showing an empty frame.
  assert.equal(spillEncoding('image/png'), 'base64')
  assert.equal(spillEncoding(PLOTLY_MIME), 'utf8')
  // SVG is not offloaded: it is already lighter than the image offloading exists for.
  assert.ok(!SPILL_MIMES.has('image/svg+xml'))
})

/* --------------------------------------------------------- the ceiling */

test('a figure over the ceiling gets an honest line, not truncated JSON', async () => {
  const room = 'plotlyhuge1'
  createSession(room, 'Много точек')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  // We do not build a real million points: the ceiling counts characters, and a
  // string of them is just as long, while the test takes a second, not a minute.
  const body = JSON.stringify({
    data: [{ type: 'scattergl', x: [1, 2], y: [1, 2], text: 'z'.repeat(MAX_FIGURE_CHARS) }],
    layout: {},
  })

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ [PLOTLY_MIME]: body }, 1)
  writer.dispose()
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1, 'something besides the line landed in the document')
  assert.equal(outs[0].kind, 'stream')
  if (outs[0].kind !== 'stream') return
  assert.equal(outs[0].name, 'stderr')
  assert.match(outs[0].text, /слишком большой/)
  // The advice in the line is a real way out, not an excuse.
  assert.match(outs[0].text, /write_html/)
})

test('the figure ceiling does not cancel the rest of the bundle', async () => {
  const room = 'plotlyhuge2'
  createSession(room, 'Много точек')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const body = JSON.stringify({ data: [{ x: 'z'.repeat(MAX_FIGURE_CHARS) }], layout: {} })

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ [PLOTLY_MIME]: body, 'text/plain': 'Figure({...})' }, 1)
  writer.dispose()
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 2)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[1].kind, 'data')
  if (outs[1].kind !== 'data') return
  assert.equal(outs[1].data['text/plain'], 'Figure({...})')
  assert.equal(outs[1].data[PLOTLY_MIME], undefined)
})

/* -------------------------------------------------------- the council */

test('a council attempt: a figure under the ceiling goes whole, over it gets the same line', () => {
  const small = new CouncilOutputBuffer()
  const body = figure(50)
  small.data({ [PLOTLY_MIME]: body, 'text/html': '<div></div><script>x</script>' }, 1)
  const kept = small.snapshot()
  assert.equal(kept.length, 1)
  assert.equal(kept[0].kind, 'data')
  if (kept[0].kind !== 'data') return
  assert.equal(kept[0].data[PLOTLY_MIME], body, 'the attempt figure was cut')
  assert.equal(kept[0].data['text/html'], undefined, 'the dead script went onto the card')

  // An attempt has no blob shelf and cannot have one: its output lives in memory
  // and travels to the host over the socket. So it is either whole or a line.
  const big = new CouncilOutputBuffer()
  const huge = JSON.stringify({
    data: [{ x: 'z'.repeat(MAX_ATTEMPT_DATA_CHARS) }],
    layout: {},
  })
  big.data({ [PLOTLY_MIME]: huge }, 1)
  const outs = big.snapshot()
  assert.equal(outs.length, 1)
  assert.equal(outs[0].kind, 'stream')
  if (outs[0].kind !== 'stream') return
  assert.match(outs[0].text, /слишком большой|too large/)
})

/* -------------------------------------------------------- the summary */

test('a figure summary: the type, the number of traces and the number of points', () => {
  const one = normalizeFigure(JSON.parse(figure(37, 'histogram')))
  assert.ok(one)
  assert.deepEqual(figureShape(one), { kind: 'histogram', traces: 1, points: 37 })

  // Since version six plotly.py stores arrays as binary: `{dtype, bdata}`. Their
  // length cannot be asked with `.length`, and the oracle needs the number of points.
  const packed = normalizeFigure({
    data: [{ type: 'scattergl', x: { dtype: 'f8', bdata: 'A'.repeat(800) } }],
    layout: {},
  })
  assert.ok(packed)
  assert.equal(figureShape(packed).points, 75, '800 base64 characters are 600 bytes, that is, 75 f8 numbers')
})

/* --------------------------------------------------------- the oracle */

/** A cell inside a document: without one it has no outputs array. */
function cellWith(output: CellOutput): YCell {
  const doc = new Y.Doc()
  const cell = createCell('code', 'px.histogram(df, x="t")')
  getCells(doc).push([cell])
  cellOutputs(cell).push([writeOutput(output)])
  return cell
}

test('the oracle gets a note about the chart, not megabytes of coordinates', () => {
  const cell = cellWith(
    { kind: 'data', data: { [PLOTLY_MIME]: figure(2400, 'histogram') }, execCount: 7 },
  )
  const [rendered] = renderOutputs(cell, 4000)
  assert.match(rendered, /\[plotly figure: histogram, 1 trace, 2400 points\]/)
  // And not a single coordinate: a hundred thousand points are two megabytes,
  // that is, the whole context budget for one cell.
  assert.ok(!rendered.includes('"x"'), 'the figure JSON went to the model whole')
  assert.ok(rendered.length < 200, `a note of ${rendered.length} characters is not a note`)
})

test('an offloaded figure in the context is a chart, not an image', () => {
  const cell = cellWith({
    kind: 'data',
    data: {},
    blobs: [{ sha: 'a'.repeat(64), mime: PLOTLY_MIME, bytes: 1_600_000 }],
    execCount: 9,
  })
  const [rendered] = renderOutputs(cell, 4000)
  // Not "KB image": the oracle would suggest `plt.savefig` where plotly is used.
  assert.match(rendered, /\[plotly figure, ~1563 KB\]/)
})

/* ------------------------------------------------------- the published page */

test('in the exported directory a line stands where the chart is, not emptiness and not JSON', () => {
  const html = renderStep({
    title: 'Занятие',
    publishedAt: 0,
    course: null,
    steps: [{ seq: 1, label: 'Шаг', at: 0, cellCount: 1 }],
    step: {
      seq: 1,
      label: 'Шаг',
      at: 0,
      cells: [
        {
          id: 'c1',
          type: 'code',
          source: 'px.line(df, x="d", y="n")',
          outputs: [{ kind: 'data', data: { [PLOTLY_MIME]: figure(10) }, execCount: 1 }],
          execCount: 1,
          ranMs: 12,
        },
      ],
    },
    depth: 1,
    base: '',
  })
  /*
   * The static directory lives without a server, and the frame is a response
   * with a special header. Drawing the figure right in the page is even less
   * acceptable: foreign data and foreign code on an origin that holds other
   * classes too.
   */
  assert.match(html, /интерактивный график plotly/)
  assert.ok(!html.includes('"scatter"'), 'the figure JSON went into the static page')
  assert.ok(!html.includes('<iframe'), 'a frame does not work on a static page and is not placed there')
})
