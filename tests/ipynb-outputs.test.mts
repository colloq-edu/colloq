/**
 * The class-page download is an .ipynb WITH outputs (server/src/publish/notebook.ts).
 *
 * It used to carry code only. A student downloading the seminar wants what
 * the class saw: tables, plots, the traceback the teacher explained, and the
 * pictures in the notes, all opening on a laptop that never saw the server.
 * So images kept out of line on the page go back inline, and note images
 * become nbformat attachments.
 */
import './_env.mts'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { putBlob } from '../server/src/blobs.js'
import { addBook, createCell } from '../shared/notebook.js'
import { notebookWithOutputs } from '../server/src/publish/notebook.js'
import { buildAndWrite } from '../server/src/publish/materials.js'
import { readPageFile } from '../server/src/publish/page-files.js'
import { listMaterials } from '../server/src/publish/store.js'
import type { PublicCell } from '../shared/publish.js'

after(() => shutdownCollab())

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
const PNG_HASH = 'a'.repeat(32)
const SVG_HASH = 'b'.repeat(32)
const PLOT_HASH = 'c'.repeat(32)
const PLOT = { data: [{ x: [1, 2], y: [3, 4] }], layout: {} }

const blobs = new Map([
  [PNG_HASH, { mime: 'image/png', body: PNG }],
  [SVG_HASH, { mime: 'image/svg+xml', body: SVG }],
  [PLOT_HASH, { mime: 'application/vnd.plotly.v1+json', body: Buffer.from(JSON.stringify(PLOT)) }],
])

const cells: PublicCell[] = [
  {
    id: 'note',
    type: 'markdown',
    // The page names an SVG note image `.svgxml` (publish/build.ts · extOfMime).
    source: `# Схема\n\n![схема](blob:${PNG_HASH}.png) и ![граф](blob:${SVG_HASH}.svgxml)`,
    outputs: [],
    execCount: null,
    ranMs: null,
  },
  {
    id: 'run',
    type: 'code',
    source: 'df.head()\nplt.show()',
    outputs: [
      { kind: 'stream', name: 'stdout', text: 'loaded 100 rows\n' },
      { kind: 'stream', name: 'stderr', text: 'warning\n' },
      { kind: 'data', data: { 'text/plain': 'таблица', 'text/html': '<table/>' }, execCount: 7 },
      { kind: 'data', data: { 'image/png': `blob:${PNG_HASH}`, 'text/plain': '<Figure>' }, execCount: null },
      { kind: 'data', data: { 'application/vnd.plotly.v1+json': `blob:${PLOT_HASH}` }, execCount: null },
      { kind: 'data', data: { 'image/png': `blob:${'f'.repeat(32)}` }, execCount: null },
      { kind: 'error', ename: 'KeyError', evalue: "'price'", traceback: ['Traceback…', "KeyError: 'price'"] },
    ],
    execCount: 7,
    ranMs: 120,
  },
  { id: 'never', type: 'code', source: 'later()', outputs: [], execCount: null, ranMs: null },
]

const parse = () => JSON.parse(notebookWithOutputs(cells, (hash) => blobs.get(hash) ?? null))

test('every output type goes into the file, with execution counts', () => {
  const nb = parse()
  const run = nb.cells[1]
  assert.equal(run.execution_count, 7)
  assert.deepEqual(
    run.outputs.map((o: { output_type: string }) => o.output_type),
    ['stream', 'stream', 'execute_result', 'display_data', 'display_data', 'error'],
    'the output whose image is gone should be dropped, not written broken',
  )
  assert.deepEqual(run.outputs[0], { output_type: 'stream', name: 'stdout', text: 'loaded 100 rows\n' })
  assert.equal(run.outputs[1].name, 'stderr')
  assert.deepEqual(run.outputs[2], {
    output_type: 'execute_result',
    execution_count: 7,
    data: { 'text/plain': 'таблица', 'text/html': '<table/>' },
    metadata: {},
  })
  assert.deepEqual(run.outputs[5], {
    output_type: 'error',
    ename: 'KeyError',
    evalue: "'price'",
    traceback: ['Traceback…', "KeyError: 'price'"],
  })
  assert.equal(nb.cells[2].execution_count, null)
  assert.deepEqual(nb.cells[2].outputs, [])
})

test('images kept out of line come back inline, and a figure as JSON', () => {
  const run = parse().cells[1]
  assert.equal(run.outputs[3].data['image/png'], PNG.toString('base64'))
  assert.equal(run.outputs[3].data['text/plain'], '<Figure>')
  assert.deepEqual(run.outputs[4].data['application/vnd.plotly.v1+json'], PLOT)
})

test('note images become attachments, and the text points at them', () => {
  const note = parse().cells[0]
  assert.equal(
    note.source.join(''),
    `# Схема\n\n![схема](attachment:${PNG_HASH}.png) и ![граф](attachment:${SVG_HASH}.svgxml)`,
  )
  assert.deepEqual(note.attachments[`${PNG_HASH}.png`], { 'image/png': PNG.toString('base64') })
  assert.deepEqual(note.attachments[`${SVG_HASH}.svgxml`], { 'image/svg+xml': SVG.toString('base64') })
})

/** The parts of the nbformat 4.5 schema a reader trips over first. */
function assertNbformat45(nb: Record<string, unknown>): void {
  assert.equal(nb.nbformat, 4)
  assert.equal(nb.nbformat_minor, 5)
  assert.equal(typeof nb.metadata, 'object')
  const seen = new Set<string>()
  for (const cell of nb.cells as Record<string, unknown>[]) {
    assert.match(String(cell.id), /^[a-zA-Z0-9-_]{1,64}$/)
    assert.ok(!seen.has(String(cell.id)), 'two cells share an id')
    seen.add(String(cell.id))
    assert.ok(cell.cell_type === 'code' || cell.cell_type === 'markdown')
    assert.equal(typeof cell.metadata, 'object')
    assert.ok(Array.isArray(cell.source) || typeof cell.source === 'string')
    if (cell.cell_type !== 'code') {
      assert.ok(!('outputs' in cell) && !('execution_count' in cell))
      continue
    }
    assert.ok(cell.execution_count === null || Number.isInteger(cell.execution_count))
    for (const out of cell.outputs as Record<string, unknown>[]) {
      if (out.output_type === 'stream') assert.ok(['stdout', 'stderr'].includes(String(out.name)))
      else if (out.output_type === 'error') assert.ok(Array.isArray(out.traceback))
      else {
        assert.ok(['display_data', 'execute_result'].includes(String(out.output_type)))
        assert.equal(typeof out.data, 'object')
        assert.equal(typeof out.metadata, 'object')
        if (out.output_type === 'execute_result') assert.ok(Number.isInteger(out.execution_count))
      }
    }
  }
}

test('a page built from a live room downloads as valid nbformat 4.5, with its images', async (t) => {
  const id = 'ipynb-room'
  createSession(id, 'Графики', null)
  const { doc } = getSessionDoc(id, 'Графики')
  const shelf = putBlob(id, PNG)
  assert.ok(shelf)
  const root = addBook(doc, 'plots.ipynb').root
  const big = 'A'.repeat(40_000)
  doc.transact(() => {
    const book = doc.getArray<Y.Map<unknown>>(root)
    book.push([
      createCell('markdown', `![фото](attachment:${shelf.sha}.png)`),
      createCell('code', 'plt.plot(xs)'),
    ])
    const cell = book.get(1)
    const inline = new Y.Map<unknown>()
    inline.set('kind', 'data')
    inline.set('json', JSON.stringify({ data: { 'image/png': big }, execCount: 1 }))
    const shelved = new Y.Map<unknown>()
    shelved.set('kind', 'data')
    shelved.set(
      'json',
      JSON.stringify({
        data: { 'text/plain': '<Figure>' },
        blobs: [{ sha: shelf.sha, mime: 'image/png', bytes: PNG.length }],
        execCount: null,
      }),
    )
    ;(cell.get('outputs') as Y.Array<unknown>).push([inline, shelved])
    cell.set('execCount', 1)
  }, 'server')

  const result = await buildAndWrite(
    id,
    { notebooks: [{ root, name: 'Графики' }], files: [], autoRefresh: true, ack: [] },
    { by: null },
  )
  assert.ok(result.ok, JSON.stringify(result))
  const [material] = listMaterials(result.publication.id)
  const text = readPageFile(material.hash)!.toString('utf8')
  const nb = JSON.parse(text)
  assertNbformat45(nb)
  assert.ok(!text.includes('blob:'), 'a page-only reference leaked into the file')
  const outputs = nb.cells[1].outputs
  assert.equal(outputs[0].data['image/png'], big)
  assert.equal(outputs[1].data['image/png'], PNG.toString('base64'))
  assert.equal(nb.cells[0].source.join('').startsWith('![фото](attachment:'), true)
  assert.deepEqual(Object.values(nb.cells[0].attachments), [{ 'image/png': PNG.toString('base64') }])

  // When the real validator is at hand, it has the last word.
  const probe = spawnSync('python3', ['-c', 'import nbformat'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.diagnostic('nbformat is not installed; the structural checks above stand in for it')
    return
  }
  const check = spawnSync(
    'python3',
    ['-c', 'import sys, nbformat; nbformat.validate(nbformat.reads(sys.stdin.read(), as_version=4))'],
    { input: text, encoding: 'utf8' },
  )
  assert.equal(check.status, 0, check.stderr)
})
