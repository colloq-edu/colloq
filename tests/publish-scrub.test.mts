/**
 * What a class page must not carry by accident (server/src/publish/checks.ts).
 *
 * The room id is the right to write into the room, and it sits in every
 * kernel path (`/workspace/<id>/…`) and in any link a teacher pasted: it is
 * removed, always, before anything is stored. A key or a student's full name
 * is the teacher's call: the page waits until they confirm, and a
 * confirmation names exactly the findings it covers.
 */
import './_env.mts'
import http from 'node:http'
import express, { type Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { addBook, createCell } from '../shared/notebook.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import { cellChecks, scrubCells, scrubText } from '../server/src/publish/checks.js'
import { readPageFile } from '../server/src/publish/page-files.js'
import { listMaterials, materialCellsText } from '../server/src/publish/store.js'
import type { PublicCell, PublishCheck, PublishInfo } from '../shared/publish.js'

const ID = 'scrubroom'
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'
let base = ''
let cookie = ''
let server: http.Server
let root = ''

function output(cell: Y.Map<unknown>, kind: 'stream' | 'data' | 'error', body: unknown): void {
  const out = new Y.Map<unknown>()
  out.set('kind', kind)
  if (kind === 'stream') {
    out.set('name', 'stdout')
    const text = new Y.Text()
    text.insert(0, body as string)
    out.set('text', text)
  } else out.set('json', JSON.stringify(body))
  ;(cell.get('outputs') as Y.Array<unknown>).push([out])
}

before(async () => {
  createSession(ID, 'Чистка', null)
  upsertParticipant({ id: 'p_zuev', sessionId: ID, name: 'Зуев Аким', avatar: null, role: 'participant' })
  const { doc } = getSessionDoc(ID, 'Чистка')
  root = addBook(doc, 'seminar.ipynb').root
  doc.transact(() => {
    const cells = doc.getArray<Y.Map<unknown>>(root)
    cells.push([
      createCell('markdown', `# Комната ${ID}\n\nСсылка: https://colloq.ru/s/${ID}`),
      createCell('code', `df = pd.read_csv('/workspace/${ID}/data.csv')`),
      createCell('code', `OPENAI_API_KEY = '${KEY}'`),
      createCell('markdown', '## Итоги\n\nОтвечал Зуев Аким, потом Аким ещё раз.'),
      createCell('code', 'run()'),
    ])
    const ran = cells.get(1)
    output(ran, 'stream', `saved to /workspace/${ID}/out.txt\n`)
    output(ran, 'data', { data: { 'text/html': `<a href="/s/${ID}">room</a>` }, execCount: 2 })
    output(cells.get(4), 'error', {
      ename: 'ValueError',
      evalue: `bad room ${ID}`,
      traceback: [`File "/workspace/${ID}/utils.py", line 3`],
    })
  }, 'server')

  const teacher = createTeacher({ name: 'Ада', email: 'ada@scrub.test', role: 'owner' })
  assert.ok(teacher)
  issueStaffCookie({ cookie: (_n: string, v: string) => (cookie = v) } as unknown as Response, teacher)
  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

const headers = () => ({ cookie: `${STAFF_COOKIE}=${cookie}`, 'content-type': 'application/json' })
const publish = (ack: string[]) =>
  fetch(`${base}/api/admin/seminars/${ID}/publish`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ notebooks: [{ root, name: 'Семинар' }], files: [], autoRefresh: true, ack }),
  })

test('kernel paths become relative and the bare id disappears, in every kind of text', () => {
  assert.equal(scrubText(`open('/workspace/${ID}/data.csv')`, ID), "open('data.csv')")
  assert.equal(scrubText(`cd /workspace/${ID}`, ID), 'cd .')
  assert.equal(scrubText(`https://colloq.ru/s/${ID}?x`, ID), 'https://colloq.ru/s/…?x')
  // Only the id as a word: a longer name that contains it is someone else's.
  assert.equal(scrubText(`${ID}2 and x${ID}`, ID), `${ID}2 and x${ID}`)
  const cells: PublicCell[] = [
    {
      id: 'a',
      type: 'code',
      source: `print('${ID}')`,
      outputs: [
        { kind: 'stream', name: 'stdout', text: `/workspace/${ID}/x` },
        { kind: 'error', ename: 'E', evalue: ID, traceback: [`/workspace/${ID}/u.py`] },
        {
          kind: 'data',
          data: { 'text/html': `<b>${ID}</b>`, 'image/png': `blob:${'a'.repeat(32)}` },
          execCount: 1,
        },
      ],
      execCount: 1,
      ranMs: 3,
    },
    { id: 'b', type: 'code', source: 'clean()', outputs: [], execCount: null, ranMs: null },
  ]
  const clean = scrubCells(cells, ID)
  assert.equal(clean.scrubbed, 1)
  assert.ok(!JSON.stringify(clean.cells).includes(ID))
  const image = clean.cells[0].outputs[2]
  assert.equal(image.kind === 'data' && image.data['image/png'], `blob:${'a'.repeat(32)}`)
})

test('a key-like string is a check; a full roster name is one, a lone first name is not', () => {
  const checks = cellChecks(
    {
      root: 'nb:x',
      name: 'Семинар',
      cells: [
        { id: 'c1', source: `key = '${KEY}'`, outputs: [] },
        { id: 'c2', source: 'Отвечал Зуев Аким. А потом Аким.', outputs: [] },
        { id: 'c3', source: 'Аким Зуев снова', outputs: [] },
        { id: 'c4', source: "key = 'sepal_length_of_the_flower_x'", outputs: [] },
      ],
    },
    ['Зуев Аким'],
  )
  assert.deepEqual(
    checks.map((c) => [c.kind, c.cellId, c.sample, c.where]),
    [
      ['secret', 'c1', 'sk-p…56', '«Семинар», ячейка 1'],
      ['name', 'c2', 'Зуев Аким', '«Семинар», ячейка 2'],
      ['name', 'c3', 'Аким Зуев', '«Семинар», ячейка 3'],
    ],
  )
  // The same finding gets the same id on the next build; a new one, a new id.
  const again = cellChecks(
    { root: 'nb:x', name: 'Другое имя', cells: [{ id: 'c1', source: `key = '${KEY}'`, outputs: [] }] },
    [],
  )
  assert.equal(again[0].id, checks[0].id)
  assert.notEqual(checks[1].id, checks[2].id)
})

test('the picker counts the scrubbed cells and lists the checks', async () => {
  const res = await fetch(`${base}/api/admin/seminars/${ID}/publish`, { headers: headers() })
  assert.equal(res.status, 200)
  const info = (await res.json()) as PublishInfo
  // The heading, the read_csv cell (with its outputs) and the traceback.
  assert.equal(info.scrubbed, 3)
  assert.deepEqual(info.checks.map((c) => c.kind).sort(), ['name', 'secret'])
})

test('an unconfirmed check stops the publish; confirming exactly it lets the page out clean', async () => {
  const refused = await publish([])
  assert.equal(refused.status, 409)
  const body = (await refused.json()) as { error: string; checks: PublishCheck[] }
  assert.equal(body.error, 'unconfirmed')
  assert.equal(body.checks.length, 2)
  const partly = await publish([body.checks[0].id])
  assert.equal(partly.status, 409, 'one confirmation let both findings through')

  const done = await publish(body.checks.map((c) => c.id))
  assert.equal(done.status, 200)
  const { page } = (await done.json()) as { page: { id: string; materials: { key: string }[] } }
  const text = materialCellsText(page.id, 'seminar')!
  assert.ok(!text.includes(ID), 'the room id reached the page')
  assert.ok(text.includes(KEY), 'a confirmed key was rewritten instead of published')
  const [material] = listMaterials(page.id)
  // The outline is built from the scrubbed text.
  assert.deepEqual(
    material.outline.map((o) => o.text),
    ['Комната …', 'Итоги'],
  )
  // And so is the download.
  assert.ok(!readPageFile(material.hash)!.toString('utf8').includes(ID))
})
