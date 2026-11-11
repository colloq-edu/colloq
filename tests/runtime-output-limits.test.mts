import './_env.mts'
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { cellId, createCell, getCells, readCell, type CellOutput } from '../shared/notebook.js'
import { PLOTLY_MIME } from '../shared/plotly.js'
import { setLocaleResolver } from '../shared/i18n.js'
import { CouncilOutputBuffer, MAX_ATTEMPT_OUTPUT_CHARS } from '../server/src/kernel/council.js'
import { OutputWriter } from '../server/src/kernel/outputs.js'
import { MAX_FIGURE_CHARS } from '../server/src/kernel/figures.js'
import { config } from '../server/src/config.js'

beforeEach(() => setLocaleResolver(() => 'en'))
const textCost = (outputs: CellOutput[]) => outputs.reduce((n, o) => n + (o.kind === 'stream' ? o.text.length : o.kind === 'error' ? JSON.stringify({ ename: o.ename, evalue: o.evalue, traceback: o.traceback }).length : 0), 0)
function room(budget?: number, session?: string) {
  const doc = new Y.Doc()
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  const writer = new OutputWriter(doc, cellId(cell), budget, session)
  return { doc, writer, snapshot: () => readCell(cell).outputs }
}
for (const council of [false, true]) {
  const name = council ? 'council' : 'room'
  const limit = council ? MAX_ATTEMPT_OUTPUT_CHARS : 400 * 1024
  test(`${name}: the truncation notice preserves the beginning of overflowing stdout`, () => {
    const r = room()
    const buffer = council ? new CouncilOutputBuffer() : r.writer
    buffer.stream('stdout', 'important first line\n' + 'x'.repeat(limit * 2))
    if (!council) r.writer.flush()
    const outputs = council ? (buffer as CouncilOutputBuffer).snapshot() : r.snapshot()
    const first = outputs.find(o => o.kind === 'stream' && o.name === 'stdout')
    assert.ok(first?.kind === 'stream' && first.text.startsWith('important first line\n'))
    assert.ok(textCost(outputs) <= limit)
    assert.ok(outputs.some(o => o.kind === 'stream' && o.name === 'stderr'))
    r.writer.dispose(); r.doc.destroy()
  })
  test(`${name}: repeated exceptions have an aggregate bound and retain the final error`, () => {
    const r = room()
    const buffer = council ? new CouncilOutputBuffer() : r.writer
    const snapshot = () => council ? (buffer as CouncilOutputBuffer).snapshot() : r.snapshot()
    for (let i = 0; i < 1000; i++) buffer.error(`Error${i}`, 'x'.repeat(4096), ['f'.repeat(4096)])
    assert.ok(textCost(snapshot()) <= limit, `error flood retained ${textCost(snapshot())} characters`)
    buffer.stream('stdout', 's'.repeat(limit + 1))
    if (!council) r.writer.flush()
    buffer.error('FinalError', 'useful final failure', ['last useful frame'])
    assert.ok(textCost(snapshot()) <= limit)
    assert.ok(snapshot().some(o => o.kind === 'error' && o.ename === 'FinalError'))
    buffer.supersede()
    buffer.error('ReplacementError', 'after clear', [])
    assert.deepEqual(snapshot().map(o => o.kind), ['error'])
    r.writer.dispose(); r.doc.destroy()
  })
  test(`${name}: oversize-figure diagnostics occur once and share the text budget`, () => {
    const r = room()
    const buffer = council ? new CouncilOutputBuffer() : r.writer
    const snapshot = () => council ? (buffer as CouncilOutputBuffer).snapshot() : r.snapshot()
    const big = 'x'.repeat(MAX_FIGURE_CHARS + 1)
    for (let i = 0; i < 1000; i++) buffer.data({ [PLOTLY_MIME]: big }, null)
    assert.equal(snapshot().filter(o => o.kind === 'stream').length, 1)
    buffer.stream('stdout', 's'.repeat(limit + 1))
    if (!council) r.writer.flush()
    assert.ok(textCost(snapshot()) <= limit)
    buffer.supersede()
    buffer.data({ [PLOTLY_MIME]: big }, null)
    assert.equal(snapshot().filter(o => o.kind === 'stream').length, 1)
    r.writer.dispose(); r.doc.destroy()
  })
}
test('room: blob-storage failure charges the full inline fallback', (t) => {
  const session = 'runtime-full-shelf'
  fs.mkdirSync(path.join(config.dataDir, 'blobs'), { recursive: true })
  fs.writeFileSync(path.join(config.dataDir, 'blobs', session), 'not a directory')
  t.mock.method(console, 'error', () => {})
  const budget = 256 * 1024
  const r = room(budget, session)
  const png = Buffer.alloc(150000).toString('base64')
  for (let i = 0; i < 20; i++) r.writer.data({ 'image/png': png }, null)
  const images = r.snapshot().filter(o => o.kind === 'data')
  assert.ok(images.length > 0, 'a fitting inline fallback is still usable')
  assert.ok(JSON.stringify(images).length <= budget, `inline fallback kept ${JSON.stringify(images).length} characters`)
  r.writer.dispose(); r.doc.destroy()
})
test('room: truncated images do not decode, while deferred clear admits a new image', (t) => {
  const r = room(64 * 1024, 'runtime-no-decode')
  r.writer.data({ 'text/plain': 'x'.repeat(128 * 1024) }, null)
  const png = Buffer.alloc(256 * 1024).toString('base64')
  const original = Buffer.from
  let decoded = 0
  t.mock.method(Buffer, 'from', function (...args: any[]) {
    if (args[1] === 'base64') decoded++
    return (original as any)(...args)
  })
  for (let i = 0; i < 100; i++) r.writer.data({ 'image/png': png }, null)
  assert.equal(decoded, 0, 'discarded frames never allocate decoded buffers')
  r.writer.supersede()
  r.writer.data({ 'image/png': png, 'text/plain': 'replacement' }, null)
  const outputs = r.snapshot()
  assert.equal(outputs.length, 1)
  assert.ok(outputs[0].kind === 'data' && outputs[0].data['text/plain'] === 'replacement')
  assert.equal(decoded, 1, 'the replacement image is decoded after deferred clear restores its budget')
  assert.ok(outputs[0].kind === 'data' && outputs[0].blobs?.length === 1)
  r.writer.dispose(); r.doc.destroy()
})
test('council: stopping retains an earlier useful error and replaces only interrupt diagnostics', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.error('ValueError', 'useful failure', ['useful traceback'])
  buffer.supersede()
  for (let i = 0; i < 1000; i++) buffer.stopped('time limit reached')
  const outputs = buffer.snapshot()
  assert.ok(outputs.some(o => o.kind === 'error' && o.ename === 'ValueError'))
  assert.ok(outputs.some(o => o.kind === 'error' && o.evalue === 'time limit reached'))
  assert.ok(textCost(outputs) <= MAX_ATTEMPT_OUTPUT_CHARS)
  assert.ok(outputs.length <= 2)
})
for (const council of [false, true]) test(`${council ? 'council' : 'room'}: escaped traceback strings still fit the serialized text ceiling`, () => {
  const r = room()
  const buffer = council ? new CouncilOutputBuffer() : r.writer
  const pathological = '\0'.repeat(100000)
  buffer.error(pathological, pathological, Array(10000).fill(pathological))
  const outputs = council ? (buffer as CouncilOutputBuffer).snapshot() : r.snapshot()
  assert.ok(textCost(outputs) <= (council ? MAX_ATTEMPT_OUTPUT_CHARS : 400 * 1024))
  assert.equal(outputs.length, 1)
  r.writer.dispose(); r.doc.destroy()
})
test('room: emergency writer accounts for output retained by an earlier writer', () => {
  const r = room()
  r.writer.stream('stdout', 'x'.repeat(400 * 1024))
  r.writer.error('EarlierError', 'earlier', [])
  r.writer.dispose()
  const replacement = new OutputWriter(r.doc, cellId(getCells(r.doc).get(0)))
  replacement.error('KernelError', 'kernel stopped', [])
  assert.ok(textCost(r.snapshot()) <= 400 * 1024)
  replacement.stream('stdout', 'x'.repeat(400 * 1024))
  replacement.flush()
  assert.ok(textCost(r.snapshot()) <= 400 * 1024, 'replacing an old error must not create negative accounting')
  replacement.dispose(); r.doc.destroy()
})
