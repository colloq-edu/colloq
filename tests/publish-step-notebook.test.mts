/**
 * A notebook's download: which notebook it is, and what is in the file.
 *
 * The 0.12 «Скачать тетрадь» link was one for the whole page and served the
 * code without outputs. A page now has a download per material, each notebook
 * as an .ipynb WITH its outputs (the reason a student opens it at all), and
 * the bytes are the ones built at publish time, not whatever the room holds
 * by the time somebody clicks.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { notebookMaterial } from '../server/src/publish/materials.js'
import { setPublicationSlug, writePublication } from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import type { PublicCell } from '../shared/publish.js'

const cell = (id: string, source: string, outputs: PublicCell['outputs'] = []): PublicCell => ({
  id,
  type: 'code',
  source,
  outputs,
  execCount: 1,
  ranMs: null,
})

let base = ''
let server: http.Server

before(async () => {
  const app = express()
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

test('each notebook downloads as its own file, with its outputs', async () => {
  const id = 'pub-step-notebook'
  createSession(id, 'Две тетради', null)
  const lecture = notebookMaterial({
    key: 'lecture',
    name: 'Лекция',
    path: 'lecture.ipynb',
    cells: [cell('c1', 'print("лекция")', [{ kind: 'stream', name: 'stdout', text: 'лекция\n' }])],
    blob: () => null,
  })
  const seminar = notebookMaterial({
    key: 'seminar',
    name: 'Семинар',
    path: 'week 4/семинар.ipynb',
    cells: [cell('c2', 'after = 2')],
    blob: () => null,
  })
  const pub = writePublication({
    sessionId: id,
    title: 'Две тетради',
    by: 'Ада',
    materials: [lecture, seminar],
    blobs: [],
  })
  assert.equal(setPublicationSlug(pub.id, 'dve-tetradi'), 'ok')

  const first = await fetch(`${base}/api/p/dve-tetradi/m/lecture/download`)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('content-type'), 'application/x-ipynb+json')
  assert.match(first.headers.get('content-disposition') ?? '', /^attachment; .*filename\*=UTF-8''lecture\.ipynb$/)
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff')
  assert.match(first.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.equal(first.headers.get('x-robots-tag'), 'noindex')
  const nb = (await first.json()) as {
    nbformat: number
    cells: { source: string[]; outputs: { text: string[] | string }[]; execution_count: number }[]
  }
  assert.equal(nb.nbformat, 4)
  assert.equal(nb.cells[0].execution_count, 1)
  assert.match([nb.cells[0].outputs[0].text].flat().join(''), /лекция/)

  // The second one is the second one, named by the base of its room path.
  const second = await fetch(`${base}/api/p/dve-tetradi/m/seminar/download`)
  assert.equal(second.status, 200)
  assert.match(
    second.headers.get('content-disposition') ?? '',
    new RegExp(`filename\\*=UTF-8''${encodeURIComponent('семинар.ipynb')}$`),
  )
  const code = ((await second.json()) as { cells: { source: string[] }[] }).cells
    .map((c) => c.source.join(''))
    .join('\n')
  assert.equal(code, 'after = 2')
  // The content length is the stored file's, exactly.
  assert.equal(Number(second.headers.get('content-length')), seminar.bytes)
})

test('only a PDF opens in place; everything else is a download or a 404', async () => {
  const id = 'pub-open-pdf'
  createSession(id, 'Слайды', null)
  const { putPageFile } = await import('../server/src/publish/page-files.js')
  const pdf = putPageFile(Buffer.from('%PDF-1.4\n% slides\n'), 'application/pdf')
  const csv = putPageFile(Buffer.from('a,b\n1,2\n'), 'text/csv')
  const pub = writePublication({
    sessionId: id,
    title: 'Слайды',
    by: 'Ада',
    materials: [
      { key: 'slides', kind: 'pdf', name: 'Слайды лекции', path: 'lecture.pdf', hash: pdf.hash, bytes: pdf.bytes },
      { key: 'train', kind: 'data', name: 'data/train.csv', path: 'data/train.csv', hash: csv.hash, bytes: csv.bytes },
    ],
    blobs: [],
  })
  const open = await fetch(`${base}/api/p/${pub.id}/m/slides/open`)
  assert.equal(open.status, 200)
  assert.equal(open.headers.get('content-type'), 'application/pdf')
  assert.match(open.headers.get('content-disposition') ?? '', /^inline;/)
  // A sandboxed document is exactly what Chrome's PDF viewer refuses to draw.
  assert.equal(open.headers.get('content-security-policy'), null)
  assert.equal(open.headers.get('x-content-type-options'), 'nosniff')

  assert.equal((await fetch(`${base}/api/p/${pub.id}/m/train/open`)).status, 404)
  const data = await fetch(`${base}/api/p/${pub.id}/m/train/download`)
  assert.equal(data.headers.get('content-type'), 'text/csv')
  assert.equal(await data.text(), 'a,b\n1,2\n')
  // A file is not a notebook tab.
  const tab = await fetch(`${base}/api/p/${pub.id}/m/train`)
  assert.equal(tab.status, 404)
  assert.equal(((await tab.json()) as { error: string }).error, 'material not found')
})
