/**
 * The class page as the reader gets it from `/api/p/:id`.
 *
 * One request answers the whole header: the course row's number, title, day
 * and «о чём», the neighbours to go back and forth to, and every material
 * with what its row needs (cells and outputs for a notebook, size for the
 * rest), plus the archive. The notebooks' cells come per tab from `/m/:key`,
 * and only notebooks have cells: a key of a PDF is «no such material».
 *
 * A withdrawn page still answers, naming itself, with nothing on it, and
 * every file behind it is a 404. A page outside a course has no number and
 * no neighbours, and its day is the one the teacher gave it.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { folderHash, notebookMaterial } from '../server/src/publish/materials.js'
import { putPageFile } from '../server/src/publish/page-files.js'
import {
  createCourse,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  setPublicationState,
  writePublication,
  type StoredMaterial,
} from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { instanceToday } from '../server/src/time-zone.js'
import type { PublicCell, PublicPage } from '../shared/publish.js'

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

const code = (id: string, source: string, outputs: PublicCell['outputs'] = []): PublicCell => ({
  id,
  type: 'code',
  source,
  outputs,
  execCount: outputs.length > 0 ? 1 : null,
  ranMs: null,
})
const note = (id: string, source: string): PublicCell => ({
  id,
  type: 'markdown',
  source,
  outputs: [],
  execCount: null,
  ranMs: null,
})

function file(key: string, kind: StoredMaterial['kind'], name: string, path: string, body: string): StoredMaterial {
  const stored = putPageFile(Buffer.from(body), 'application/octet-stream')
  return { key, kind, name, path, hash: stored.hash, bytes: stored.bytes }
}

/** A folder material: its files in the page-file store, at their room paths. */
function folder(key: string, path: string, files: Record<string, string>): StoredMaterial {
  const stored = Object.entries(files).map(([rel, body]) => {
    const put = putPageFile(Buffer.from(body), 'application/octet-stream')
    return { path: `${path}/${rel}`, hash: put.hash, bytes: put.bytes }
  })
  const bytes = stored.reduce((sum, f) => sum + f.bytes, 0)
  return { key, kind: 'folder', name: `${path}/`, path, hash: folderHash(stored), bytes, files: stored }
}

/** A room with a page holding the given materials. */
function page(sessionId: string, name: string, materials: StoredMaterial[]) {
  createSession(sessionId, name, null)
  return writePublication({ sessionId, title: name, by: 'Ада', materials, blobs: [] })
}

const lecture = () =>
  notebookMaterial({
    key: 'lecture',
    name: 'Лекция',
    path: 'lecture.ipynb',
    cells: [
      note('h1', '# Утечки\n\n## Что это'),
      code('c1', 'print(1)', [{ kind: 'stream', name: 'stdout', text: '1\n' }]),
      code('c2', 'x = 2'),
    ],
    blob: () => null,
  })

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: (await res.json()) as T }
}

test('the page says which class it is, what is on it and where its neighbours are', async () => {
  const before = page('pp-before', 'Неделя 1', [lecture()])
  const mine = page('pp-mine', 'Неделя 4', [
    lecture(),
    file('slides', 'pdf', 'Слайды лекции', 'slides.pdf', '%PDF-1.4\n'),
    file('train', 'data', 'data/train.csv', 'data/train.csv', 'a,b\n1,2\n'),
  ])
  createSession('pp-after', 'Неделя 5', null)
  const course = createCourse('МЛ | сильная группа', null, null)
  assert.equal(setCourseSlug(course.id, 'pp-ml'), 'ok')
  assert.equal(setPublicationSlug(mine.id, 'pp-ml-02'), 'ok')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', id: 'rpp00001', sessionId: 'pp-before', name: 'Неделя 1', publication: null, title: 'EDA', day: '2026-09-20' },
    { kind: 'planned', id: 'rpp00002', name: 'Каникулы', when: '', pause: true },
    { kind: 'seminar', id: 'rpp00003', sessionId: 'pp-mine', name: 'Неделя 4', publication: null, title: 'Лики и хаки данных', day: '2026-10-04', about: 'Утечки целевой переменной.' },
    { kind: 'planned', id: 'rpp00004', name: 'Каникулы 2', when: '', pause: true },
    { kind: 'seminar', id: 'rpp00005', sessionId: 'pp-after', name: 'Неделя 5', publication: null, title: 'Пайплайны', day: '2026-10-11' },
  ])

  // By its name, its id: the same page.
  const { status, body } = await get<{ page: PublicPage }>('/api/p/pp-ml-02')
  assert.equal(status, 200)
  assert.deepEqual((await get<{ page: PublicPage }>(`/api/p/${mine.id}`)).body, body)
  const seen = body.page
  assert.equal(seen.id, mine.id)
  assert.equal(seen.slug, 'pp-ml-02')
  assert.equal(seen.address, 'pp-ml-02')
  assert.equal(seen.state, 'published')
  assert.equal(seen.title, 'Лики и хаки данных')
  assert.equal(seen.about, 'Утечки целевой переменной.')
  assert.equal(seen.day, '2026-10-04')
  assert.equal(seen.n, 2, 'the break is not counted')
  assert.equal(seen.today, instanceToday())
  assert.equal(seen.updatedAt, mine.publishedAt)
  // «обновлено 14 сен» is the instance's day of the update, never the browser's.
  assert.equal(seen.updatedOn, instanceToday(mine.publishedAt))
  assert.equal(seen.firstAt, mine.firstAt)
  assert.deepEqual(seen.course, { id: course.id, slug: 'pp-ml', name: 'МЛ | сильная группа' })
  // Back to a class with a page, by its id since it has no name; forward to one without.
  assert.deepEqual(seen.prev, { n: 1, title: 'EDA', day: '2026-09-20', address: before.id })
  assert.deepEqual(seen.next, { n: 3, title: 'Пайплайны', day: '2026-10-11', address: null })

  assert.deepEqual(
    seen.materials.map((m) => [m.key, m.kind, m.name, m.path]),
    [
      ['lecture', 'notebook', 'Лекция', 'lecture.ipynb'],
      ['slides', 'pdf', 'Слайды лекции', 'slides.pdf'],
      ['train', 'data', 'data/train.csv', 'data/train.csv'],
    ],
  )
  const [nb, pdf] = seen.materials
  assert.equal(nb.cells, 3)
  assert.equal(nb.outputs, 1)
  assert.deepEqual(nb.outline, [
    { id: 'h1', level: 1, text: 'Утечки' },
    { id: 'h1', level: 2, text: 'Что это' },
  ])
  assert.equal(pdf.bytes, Buffer.byteLength('%PDF-1.4\n'))
  assert.ok(!('cells' in pdf) && !('outline' in pdf), 'a PDF row has no cells')
  assert.equal(seen.zip?.name, 'pp-ml-02.zip')
  assert.ok((seen.zip?.bytes ?? 0) > seen.materials.reduce((sum, m) => sum + m.bytes, 0))
  // The cells are not in the page: they come per tab.
  assert.ok(!JSON.stringify(body).includes('print(1)'))
})

test('a notebook tab has its cells; any other key is «no such material»', async () => {
  const pub = page('pp-tabs', 'Вкладки', [
    lecture(),
    file('slides', 'pdf', 'Слайды', 'slides.pdf', '%PDF-1.4\n'),
    folder('data', 'data', { 'a.csv': 'a\n1\n' }),
  ])
  const tab = await get<{ notebook: { key: string; cells: PublicCell[] } }>(`/api/p/${pub.id}/m/lecture`)
  assert.equal(tab.status, 200)
  assert.equal(tab.body.notebook.key, 'lecture')
  assert.deepEqual(tab.body.notebook.cells.map((c) => c.id), ['h1', 'c1', 'c2'])
  for (const key of ['slides', 'data', 'nope', '12', 'LECTURE']) {
    const refused = await get<{ error: string }>(`/api/p/${pub.id}/m/${key}`)
    assert.deepEqual([refused.status, refused.body.error], [404, 'material not found'], key)
  }
  const unknown = await get<{ error: string }>('/api/p/no-such-page/m/lecture')
  assert.deepEqual([unknown.status, unknown.body.error], [404, 'publication not found'])
})

test('a withdrawn page names itself with nothing on it, and its files are gone', async () => {
  const pub = page('pp-withdrawn', 'Снятая', [
    lecture(),
    file('slides', 'pdf', 'Слайды', 'slides.pdf', '%PDF-1.4\n'),
    folder('data', 'data', { 'train.csv': 'x,y\n1,2\n' }),
  ])
  const live = (await get<{ page: PublicPage }>(`/api/p/${pub.id}`)).body.page
  assert.deepEqual(
    live.materials.find((m) => m.kind === 'folder'),
    { key: 'data', kind: 'folder', name: 'data/', bytes: 8, files: 1, holds: ['data'], path: 'data' },
  )
  assert.equal((await fetch(`${base}/api/p/${pub.id}/m/data/download`)).status, 200)
  setPublicationState(pub.id, 'withdrawn')
  const { status, body } = await get<{ page: PublicPage }>(`/api/p/${pub.id}`)
  assert.equal(status, 200)
  assert.equal(body.page.state, 'withdrawn')
  assert.equal(body.page.title, 'Снятая')
  assert.deepEqual(body.page.materials, [])
  assert.equal(body.page.zip, null)
  for (const path of ['/m/lecture', '/m/lecture/download', '/m/slides/open', '/m/data/download', '/zip', '/notebook.ipynb']) {
    const res = await fetch(`${base}/api/p/${pub.id}${path}`, { redirect: 'manual' })
    assert.equal(res.status, 404, path)
    assert.equal(((await res.json()) as { error: string }).error, 'publication not found', path)
  }
  // Restored, it is all there again.
  setPublicationState(pub.id, 'published')
  assert.equal((await fetch(`${base}/api/p/${pub.id}/m/slides/open`)).status, 200)
})

test('a page outside a course has no number and no neighbours, and its own day', async () => {
  createSession('pp-alone', 'Разбор контрольной', null)
  const pub = writePublication({
    sessionId: 'pp-alone',
    title: 'Разбор контрольной',
    by: null,
    materials: [lecture()],
    blobs: [],
    heldOn: '2026-09-30',
  })
  const { body } = await get<{ page: PublicPage }>(`/api/p/${pub.id}`)
  assert.equal(body.page.title, 'Разбор контрольной')
  assert.equal(body.page.day, '2026-09-30')
  assert.equal(body.page.n, null)
  assert.equal(body.page.course, null)
  assert.equal(body.page.prev, null)
  assert.equal(body.page.next, null)

  // Without a day of its own, the day of its first publish.
  createSession('pp-undated', 'Без дня', null)
  const undated = writePublication({ sessionId: 'pp-undated', title: 'Без дня', by: null, materials: [lecture()], blobs: [] })
  const seen = (await get<{ page: PublicPage }>(`/api/p/${undated.id}`)).body.page
  assert.equal(seen.day, instanceToday(undated.firstAt))
})
