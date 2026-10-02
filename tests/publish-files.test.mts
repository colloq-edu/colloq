/**
 * Room files on a class page (server/src/publish/materials.ts).
 *
 * The slides, the dataset and the helper module are what a student needs
 * next to the notebook, and they used to stay in the room. Now they are
 * offered with a default tick that leans towards leaving things out: PDFs
 * go, data only when a notebook reads it, and generated output, answer keys
 * and drafts stay, each with its reason. What goes out is copied byte for
 * byte and outlives the room.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { config } from '../server/src/config.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { addBook, createCell } from '../shared/notebook.js'
import { buildAndWrite, publishInfo } from '../server/src/publish/materials.js'
import { readPageFile } from '../server/src/publish/page-files.js'
import { listMaterials, orphanPublication, publicationOf } from '../server/src/publish/store.js'
import { forgetTree, sessionDir } from '../server/src/workspace.js'

const ID = 'files-room'
const MB = 1024 * 1024
const PDF = Buffer.from('%PDF-1.4\n% slides\n')
const CSV = Buffer.from('area,price\n50,100\n')
let uploadLimit = 0
let seminar = ''
let draft = ''

function put(rel: string, body: Buffer | string): void {
  const full = path.join(sessionDir(ID), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

before(() => {
  // A small upload limit, so a file over it costs seven megabytes, not fifty.
  uploadLimit = config.maxUploadBytes
  ;(config as { maxUploadBytes: number }).maxUploadBytes = 6 * MB
  createSession(ID, 'Регрессия', null)
  const { doc } = getSessionDoc(ID, 'Регрессия')
  seminar = addBook(doc, 'seminar.ipynb').root
  draft = addBook(doc, '_draft.ipynb').root
  doc.transact(() => {
    doc
      .getArray<Y.Map<unknown>>(seminar)
      .push([
        createCell('markdown', '# Регрессия\n\n![](fig.png)'),
        createCell('code', "df = pd.read_csv('data/train_home_price.csv')"),
      ])
    doc.getArray<Y.Map<unknown>>(draft).push([createCell('code', 'x = 1')])
  }, 'server')
  put('lecture.pdf', PDF)
  put('data/train_home_price.csv', CSV)
  put('data/unused.csv', 'a,b\n')
  put('surface.html', Buffer.alloc(Math.round(5.2 * MB), 'x'))
  put('solutions.py', 'answer = 42\n')
  put('outputs/pred.csv', 'id,y\n1,2\n')
  put('fig.png', Buffer.from([137, 80, 78, 71]))
  put('big.bin', Buffer.alloc(Math.round(6.5 * MB), 1))
  forgetTree(ID)
})

after(() => {
  ;(config as { maxUploadBytes: number }).maxUploadBytes = uploadLimit
  shutdownCollab()
})

test('the picker offers each file with a default tick and its reason', () => {
  const info = publishInfo(ID)!
  const files = Object.fromEntries(info.files.map((f) => [f.path, [f.kind, f.picked, f.why]]))
  assert.deepEqual(files['lecture.pdf'], ['pdf', true, null])
  assert.deepEqual(files['data/train_home_price.csv'], ['data', true, null])
  assert.deepEqual(files['data/unused.csv'], ['data', false, 'unused'])
  assert.deepEqual(files['surface.html'], ['file', false, 'generated'])
  assert.deepEqual(files['solutions.py'], ['code', false, 'answers'])
  assert.deepEqual(files['outputs/pred.csv'], ['data', false, 'generated'])
  assert.deepEqual(files['fig.png'], ['image', false, 'image'])
  assert.deepEqual(files['big.bin'], ['file', false, 'too-large'])
  assert.equal(info.limits.fileBytes, 6 * MB)
  assert.equal(info.limits.materials, 24)
  assert.deepEqual(
    info.files.find((f) => f.path === 'data/train_home_price.csv')?.usedBy,
    ['seminar.ipynb'],
  )
  // Notebooks are not offered twice, as files.
  assert.ok(!info.files.some((f) => f.path.endsWith('.ipynb')))
  const offered = info.notebooks.find((n) => n.root === draft)!
  assert.deepEqual([offered.picked, offered.why], [false, 'private'])
})

test('picked files are copied byte for byte; one over the upload limit is refused by name', async () => {
  const result = await buildAndWrite(
    ID,
    {
      notebooks: [{ root: seminar, name: 'Семинар' }],
      files: [
        { path: 'data/train_home_price.csv', name: '' },
        { path: 'lecture.pdf', name: 'Слайды лекции' },
        { path: 'big.bin', name: '' },
        { path: 'gone.csv', name: '' },
      ],
      autoRefresh: true,
      ack: [],
    },
    { by: 'Ада' },
  )
  assert.ok(result.ok, JSON.stringify(result))
  assert.deepEqual(result.refused, [
    { path: 'big.bin', reason: 'too-large' },
    { path: 'gone.csv', reason: 'missing' },
  ])
  const materials = listMaterials(result.publication.id)
  // Notebooks first, then files by kind: the PDF before the data.
  assert.deepEqual(
    materials.map((m) => [m.key, m.kind, m.name, m.path]),
    [
      ['seminar', 'notebook', 'Семинар', 'seminar.ipynb'],
      ['lecture', 'pdf', 'Слайды лекции', 'lecture.pdf'],
      ['train-home-price', 'data', 'data/train_home_price.csv', 'data/train_home_price.csv'],
    ],
  )
  assert.deepEqual(readPageFile(materials[1].hash), PDF)
  assert.deepEqual(readPageFile(materials[2].hash), CSV)
  assert.ok(result.publication.zipBytes > PDF.length + CSV.length)
  const selection = result.publication.selection!
  assert.deepEqual(
    selection.files.map((f) => f.path),
    ['data/train_home_price.csv', 'lecture.pdf', 'big.bin', 'gone.csv'],
  )
})

test('a path outside the room is refused before anything is read', async () => {
  const result = await buildAndWrite(
    ID,
    { notebooks: [], files: [{ path: '../../etc/passwd', name: '' }], autoRefresh: true, ack: [] },
    { by: null },
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.status, 400)
})

test('the page and its files outlive the room', () => {
  const pub = publicationOf(ID)
  assert.ok(pub)
  orphanPublication(ID)
  fs.rmSync(sessionDir(ID), { recursive: true, force: true })
  const materials = listMaterials(pub.id)
  assert.equal(materials.length, 3)
  assert.deepEqual(readPageFile(materials[1].hash), PDF)
  assert.deepEqual(readPageFile(materials[2].hash), CSV)
})
