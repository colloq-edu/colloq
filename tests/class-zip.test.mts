/**
 * «Скачать всё одним архивом» (server/src/publish/zip.ts).
 *
 * The archive is written by hand, store-only and streamed, so the checks are
 * the ones an unzip would make: Python's zipfile reads it and verifies every
 * CRC, Cyrillic names come out as typed (the UTF-8 flag), files sit at the
 * room's own paths under one folder named after the page, entries carry the
 * class day, and Content-Length is the exact length, since a download that
 * promises more than it sends hangs at 99 %. The README says what the class
 * is and never names the room: its id is the right to write into it.
 *
 * Three archives of a page at a time, six on the instance; the rest wait in
 * line, and only a long wait hears «через минуту».
 */
import './_env.mts'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { addBook, createCell } from '../shared/notebook.js'
import { buildAndWrite } from '../server/src/publish/materials.js'
import {
  ZIP_IDLE_MS,
  ZIP_PER_INSTANCE,
  ZIP_PER_PAGE,
  enterZip,
  leaveZip,
  setZipWait,
  waitForZip,
} from '../server/src/publish/zip.js'
import { createCourse, listMaterials, setCourseItems, setCourseSlug, type Publication } from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { forgetTree, sessionDir } from '../server/src/workspace.js'

const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0
const ROOM = 'zipr00m1'
const SCRATCH = path.join(process.env.DATA_DIR!, '..', 'zip-out')
const CSV = 'район,цена\nЦентр,100\n'
const PDF = '%PDF-1.4\n% Слайды\n'
let base = ''
let server: http.Server
let pub: Publication

function put(rel: string, body: string): void {
  const full = path.join(sessionDir(ROOM), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

before(async () => {
  // The room's own name carries its id, as rooms named by hand sometimes do.
  createSession(ROOM, `Комната ${ROOM}`, null)
  const { doc } = getSessionDoc(ROOM)
  const seminar = addBook(doc, 'семинар.ipynb').root
  doc.transact(() => {
    doc
      .getArray<Y.Map<unknown>>(seminar)
      .push([createCell('code', "pd.read_csv('данные/цены.csv')"), createCell('markdown', '# Утечки')])
  }, 'server')
  put('данные/цены.csv', CSV)
  put('Слайды лекции.pdf', PDF)
  put('README.md', '# Своё README комнаты\n')
  forgetTree(ROOM)

  const course = createCourse('МЛ | сильная группа', null, null)
  assert.equal(setCourseSlug(course.id, 'zip-ml'), 'ok')
  setCourseItems(course.id, course.rev, [
    { kind: 'planned', id: 'rzip0001', name: 'Введение', when: '' },
    { kind: 'seminar', id: 'rzip0002', sessionId: ROOM, name: 'x', publication: null, day: '2026-10-04' },
  ])
  const built = await buildAndWrite(
    ROOM,
    {
      notebooks: [{ root: seminar, name: 'Семинар' }],
      files: [
        { path: 'данные/цены.csv', name: '' },
        { path: 'Слайды лекции.pdf', name: 'Слайды лекции' },
        { path: 'README.md', name: '' },
      ],
      autoRefresh: true,
      ack: [],
    },
    { by: 'Ада' },
  )
  assert.ok(built.ok, JSON.stringify(built))
  pub = built.publication
  assert.equal(pub.slug, 'zip-ml-02', 'the first publish from a course takes <course>-<nn>')

  const app = express()
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  fs.mkdirSync(SCRATCH, { recursive: true })
})

after(() => {
  server?.close()
  shutdownCollab()
})

/**
 * A slot taken by hand. The previous download frees its own on the server's
 * 'close', which can come a moment after the client has read the last byte.
 */
async function takeSlot(page: string): Promise<void> {
  for (let tries = 0; !enterZip(page); tries++) {
    assert.ok(tries < 100, `no slot for ${page}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function download(handle: string): Promise<{ res: Response; body: Buffer }> {
  const res = await fetch(`${base}/api/p/${handle}/zip`)
  return { res, body: Buffer.from(await res.arrayBuffer()) }
}

/** What Python's zipfile makes of the archive: names, flags, dates and the README. */
function inspect(file: string): {
  names: string[]
  utf8: boolean[]
  dates: number[][]
  sizes: Record<string, number>
  readme: string
} {
  const code = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
infos = z.infolist()
readme = [i for i in infos if i.filename.endswith('/README-colloq.md') or i.filename.endswith('/README.md')]
print(json.dumps({
  'names': [i.filename for i in infos],
  'utf8': [bool(i.flag_bits & 0x800) for i in infos],
  'dates': [list(i.date_time) for i in infos],
  'sizes': {i.filename: i.file_size for i in infos},
  'readme': z.read('zip-ml-02/README-colloq.md').decode('utf-8'),
}))
`
  const run = spawnSync('python3', ['-c', code, file], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout)
}

test('the archive is valid, laid out like the room, and its length is exact', { skip: HAVE_PYTHON ? false : 'no python3' }, async () => {
  const { res, body } = await download('zip-ml-02')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/zip')
  assert.equal(Number(res.headers.get('content-length')), body.length)
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; .*filename\*=UTF-8''zip-ml-02\.zip$/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  const file = path.join(SCRATCH, 'zip-ml-02.zip')
  fs.writeFileSync(file, body)

  const test = spawnSync('python3', ['-m', 'zipfile', '-t', file], { encoding: 'utf8' })
  assert.equal(test.status, 0, test.stderr || test.stdout)

  const seen = inspect(file)
  // The room's own README keeps its name; ours steps aside.
  assert.deepEqual(new Set(seen.names), new Set([
    'zip-ml-02/README-colloq.md',
    'zip-ml-02/семинар.ipynb',
    'zip-ml-02/Слайды лекции.pdf',
    'zip-ml-02/данные/цены.csv',
    'zip-ml-02/README.md',
  ]))
  assert.ok(seen.utf8.every(Boolean), 'every name is flagged as UTF-8')
  assert.ok(seen.dates.every((d) => d.join() === '2026,10,4,12,0,0'), JSON.stringify(seen.dates))
  assert.equal(seen.sizes['zip-ml-02/данные/цены.csv'], Buffer.byteLength(CSV))
  assert.equal(seen.sizes['zip-ml-02/Слайды лекции.pdf'], Buffer.byteLength(PDF))
  // The notebook inside is the downloadable one, byte for byte.
  const notebook = listMaterials(pub.id).find((m) => m.kind === 'notebook')!
  assert.equal(seen.sizes['zip-ml-02/семинар.ipynb'], notebook.bytes)

  // The README says which class, which course, where the page is, what is inside; never the room.
  assert.match(seen.readme, /^# 02 · Комната /)
  assert.match(seen.readme, /Занятие 02 · /)
  assert.match(seen.readme, /МЛ \| сильная группа — http:\/\/localhost:9999\/c\/zip-ml/)
  assert.match(seen.readme, /http:\/\/localhost:9999\/p\/zip-ml-02/)
  assert.match(seen.readme, /`данные\/цены.csv`/)
  assert.ok(!seen.readme.includes(ROOM), seen.readme)
  assert.ok(!body.includes(Buffer.from(ROOM)), 'the room id is somewhere in the archive')

  // The page tells the size before anyone downloads.
  const page = (await (await fetch(`${base}/api/p/zip-ml-02`)).json()) as { page: { zip: { name: string; bytes: number } } }
  assert.deepEqual(page.page.zip, { name: 'zip-ml-02.zip', bytes: body.length })
})

test('a page takes three archives at a time; the rest wait in line, and only a long wait hears «через минуту»', async () => {
  for (let i = 0; i < ZIP_PER_PAGE; i++) await takeSlot(pub.id)
  // A download that finds the page full waits for a slot instead of failing at once.
  const waiting = download(pub.id)
  await new Promise((resolve) => setTimeout(resolve, 50))
  leaveZip(pub.id)
  const one = await waiting
  assert.equal(one.res.status, 200, 'a slot that was let go did not reach the one waiting')

  // Only a wait past the limit is refused, and the refusal says when to come back.
  await takeSlot(pub.id)
  setZipWait(30)
  try {
    const busy = await download(pub.id)
    assert.equal(busy.res.status, 429)
    assert.equal(busy.res.headers.get('retry-after'), '60')
    assert.equal(JSON.parse(busy.body.toString()).error, 'Слишком много загрузок — попробуйте через минуту')
  } finally {
    setZipWait(null)
  }
  for (let i = 0; i < ZIP_PER_PAGE; i++) leaveZip(pub.id)

  // Six other pages downloading at once fill the instance.
  const others = Array.from({ length: ZIP_PER_INSTANCE }, (_, i) => `other-${i}`)
  for (const other of others) await takeSlot(other)
  assert.equal(enterZip(pub.id), false)
  const queued = download(pub.id)
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const other of others) leaveZip(other)
  assert.equal((await queued).res.status, 200)
})

test('the line is first come, first served, and a client that leaves it gives up its place', async () => {
  for (let i = 0; i < ZIP_PER_PAGE; i++) assert.ok(enterZip('line-page'))
  const order: string[] = []
  const left = new AbortController()
  const first = waitForZip('line-page').then((ok) => order.push(`first:${ok}`))
  const quitter = waitForZip('line-page', { signal: left.signal }).then((ok) => order.push(`quitter:${ok}`))
  const second = waitForZip('line-page').then((ok) => order.push(`second:${ok}`))
  // A waiter for another page is not held up behind a full one.
  assert.equal(await waitForZip('line-other'), true)
  leaveZip('line-other')
  left.abort()
  leaveZip('line-page')
  leaveZip('line-page')
  await Promise.all([first, quitter, second])
  assert.deepEqual(order, ['quitter:false', 'first:true', 'second:true'])
  for (let i = 0; i < ZIP_PER_PAGE; i++) leaveZip('line-page')
})

test('a stalled archive stream is dropped, so it cannot keep its slot', () => {
  /*
   * Checked by reading: a test that pauses a reader until the socket buffers
   * fill would need hundreds of megabytes on loopback. The idle timer is the
   * socket's, so it fires exactly when no bytes move, and destroying the
   * response fires the 'close' that frees the slot.
   */
  const route = fs.readFileSync(path.resolve(import.meta.dirname, '../server/src/routes/courses.ts'), 'utf8')
  const zip = route.slice(route.indexOf("router.get('/api/p/:id/zip'"), route.indexOf('The 0.12 addresses'))
  assert.match(zip, /res\.setTimeout\(ZIP_IDLE_MS, \(\) => res\.destroy\(\)\)/)
  assert.match(zip, /res\.on\('close', \(\) => \{\s*gone\.abort\(\)\s*leave\(\)/)
  assert.ok(ZIP_IDLE_MS <= 120_000, 'a stalled stream holds its slot for too long')
})
