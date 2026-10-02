/**
 * The room id never leaves on anything public.
 *
 * Its eight characters are the whole right to write into the room: whoever
 * has them joins the live notebook. A class page is a link handed to the
 * class «for reading» and forwarded further, so neither the course, nor the
 * page, nor a notebook tab, nor a download, nor the archive, nor the link
 * card may carry it, even when the teacher's code printed its own folder
 * (`/workspace/<id>/…`) into an output or a traceback.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { addBook, cellOutputs, createCell, writeOutput, type CellOutput, type YCell } from '../shared/notebook.js'
import { linkPreview } from '../server/src/link-preview.js'
import { buildAndWrite } from '../server/src/publish/materials.js'
import { createCourse, setCourseItems, setCourseSlug } from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { forgetTree, sessionDir } from '../server/src/workspace.js'

const ROOM = 'nrid0042'
const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-no-room-id-'))
let base = ''
let server: http.Server
let courseId = ''
let pubId = ''
let seminarKey = ''

before(async () => {
  fs.mkdirSync(path.join(staticDir, 'og'), { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'og', 'colloq.png'), 'not really a png')
  // Named by hand after its own id, as happens.
  createSession(ROOM, `Неделя 4 (${ROOM})`, null)
  const { doc } = getSessionDoc(ROOM)
  const seminar = addBook(doc, 'seminar.ipynb').root
  doc.transact(() => {
    const code = createCell('code', `df = pd.read_csv('/workspace/${ROOM}/data/train.csv')  # ${ROOM}`)
    doc.getArray<Y.Map<unknown>>(seminar).push([createCell('markdown', `# Разбор\n\nКомната ${ROOM}`), code])
    cellOutputs(code as YCell).push([
      writeOutput({ kind: 'stream', name: 'stdout', text: `saved /workspace/${ROOM}/out.png\n` }),
      writeOutput({
        kind: 'error',
        ename: 'FileNotFoundError',
        evalue: `/workspace/${ROOM}/missing.csv`,
        traceback: [`File /workspace/${ROOM}/seminar.py, line 1`],
      }),
      writeOutput({ kind: 'data', data: { 'text/html': `<b>${ROOM}</b>` } } as CellOutput),
    ])
  }, 'server')
  const csv = path.join(sessionDir(ROOM), 'data', 'train.csv')
  fs.mkdirSync(path.dirname(csv), { recursive: true })
  fs.writeFileSync(csv, 'a,b\n1,2\n')
  forgetTree(ROOM)

  const course = createCourse('Курс без ключей', null, null)
  courseId = course.id
  assert.equal(setCourseSlug(course.id, 'nrid-course'), 'ok')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', id: 'rnrid001', sessionId: ROOM, name: 'x', publication: null, day: '2026-10-04' },
  ])
  const built = await buildAndWrite(
    ROOM,
    {
      notebooks: [{ root: seminar, name: 'Семинар' }],
      files: [{ path: 'data/train.csv', name: '' }],
      autoRefresh: true,
      ack: [],
    },
    { by: null },
  )
  assert.ok(built.ok, JSON.stringify(built))
  pubId = built.publication.id
  seminarKey = built.page.materials[0].key

  const app = express()
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  shutdownCollab()
  fs.rmSync(staticDir, { recursive: true, force: true })
})

async function body(p: string): Promise<Buffer> {
  const res = await fetch(`${base}${p}`)
  assert.equal(res.status, 200, p)
  return Buffer.from(await res.arrayBuffer())
}

test('not in the course, the page, a tab, a download or the archive', async () => {
  const paths = [
    `/api/c/nrid-course`,
    `/api/c/${courseId}`,
    `/api/p/nrid-course-01`,
    `/api/p/${pubId}`,
    `/api/p/${pubId}/m/${seminarKey}`,
    `/api/p/${pubId}/m/${seminarKey}/download`,
    `/api/p/${pubId}/zip`,
  ]
  for (const p of paths) {
    const bytes = await body(p)
    assert.ok(!bytes.includes(Buffer.from(ROOM)), `${p} carries the room id`)
  }
  const course = (await body('/api/c/nrid-course')).toString()
  assert.ok(!course.includes('sessionId'), 'the course names its rooms')
  // What the code printed is still there, without the folder.
  const tab = (await body(`/api/p/${pubId}/m/${seminarKey}`)).toString()
  assert.match(tab, /data\/train\.csv/)
  assert.match(tab, /FileNotFoundError/)
})

test('not in the link cards of the course or the page', async () => {
  for (const p of ['/c/nrid-course', '/p/nrid-course-01', `/p/${pubId}`, `/p/nrid-course-01/${seminarKey}`]) {
    const extras = await linkPreview(p, 'ru', staticDir)
    const all = `${extras.title ?? ''}${extras.head ?? ''}`
    assert.ok(all.includes('og:title'), p)
    assert.ok(!all.includes(ROOM), `${p}: ${all}`)
  }
})
