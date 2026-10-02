/**
 * What used to slip past the class page's checks (server/src/publish).
 *
 * Cells were checked for keys and student names and scrubbed of the room id,
 * but three things were not: picked room files (a `utils.py` with a key, the
 * `kaggle.json` an ML seminar copies, a roster CSV), plotly figures (moved
 * into blobs before the scrub and the checks ran), and the images of a
 * notebook taken off the page («Убрать со страницы» left them served).
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { putBlob } from '../server/src/blobs.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { addBook, createCell } from '../shared/notebook.js'
import { PLOTLY_MIME } from '../shared/plotly.js'
import {
  buildAndWrite,
  publishInfo,
  refreshPage,
  removeMaterial,
  type BuildResult,
  type PublishRequest,
} from '../server/src/publish/materials.js'
import { readPageFile } from '../server/src/publish/page-files.js'
import {
  listMaterials,
  materialCellsText,
  publicationOf,
  readBlob,
} from '../server/src/publish/store.js'
import { forgetTree, sessionDir } from '../server/src/workspace.js'
import type { PublishCheck } from '../shared/publish.js'

const ID = 'leaksroom'
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'
const KAGGLE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
let seminar = ''
let other = ''

function put(rel: string, body: string): void {
  const full = path.join(sessionDir(ID), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

function dataOutput(cell: Y.Map<unknown>, json: unknown): void {
  const out = new Y.Map<unknown>()
  out.set('kind', 'data')
  out.set('json', JSON.stringify(json))
  ;(cell.get('outputs') as Y.Array<unknown>).push([out])
}

/** A plotly figure whose hover text names a student and the room's folder. */
function figure(who: string, pad: number): string {
  return JSON.stringify({
    data: [{ type: 'bar', x: [who], y: [7], hovertext: [`/workspace/${ID}/scores.csv`] }],
    layout: { title: { text: 'Квиз' }, meta: 'x'.repeat(pad) },
  })
}

const png = (fill: number): string => Buffer.alloc(2000, fill).toString('base64')

before(() => {
  createSession(ID, 'Утечки', null)
  upsertParticipant({ id: 'p_zuev', sessionId: ID, name: 'Зуев Аким', avatar: null, role: 'participant' })
  const { doc } = getSessionDoc(ID, 'Утечки')
  seminar = addBook(doc, 'seminar.ipynb').root
  other = addBook(doc, 'extra.ipynb').root
  // A figure big enough for the room's shelf, the way the kernel stores it (as text).
  const shelved = figure('Аким Зуев', 20_000)
  const stored = putBlob(ID, Buffer.from(shelved, 'utf8'))
  assert.ok(stored)
  doc.transact(() => {
    const cells = doc.getArray<Y.Map<unknown>>(seminar)
    cells.push([
      createCell('code', "from utils import load\n!cp kaggle.json ~/.kaggle/\ndf = pd.read_csv('data/students.csv')"),
      createCell('code', 'px.bar(df)'),
      createCell('code', 'px.bar(df.T)'),
      createCell('code', 'plt.plot(x)'),
    ])
    // Inline in the room (under the shelf's threshold), but over the page's 2 KB: a blob on the page.
    dataOutput(cells.get(1), { data: { [PLOTLY_MIME]: figure('Зуев Аким', 3_000) }, execCount: 2 })
    dataOutput(cells.get(2), {
      data: {},
      blobs: [{ sha: stored.sha, mime: PLOTLY_MIME, bytes: stored.bytes }],
      execCount: 3,
    })
    dataOutput(cells.get(3), { data: { 'image/png': png(1) }, execCount: 4 })
    const extra = doc.getArray<Y.Map<unknown>>(other)
    extra.push([createCell('code', 'plt.plot(y)')])
    dataOutput(extra.get(0), { data: { 'image/png': png(2) }, execCount: 1 })
  }, 'server')
  put('utils.py', `OPENAI_API_KEY = "${KEY}"\n\ndef load():\n    pass\n`)
  put('kaggle.json', `{"username": "teacher", "key": "${KAGGLE}"}\n`)
  put('data/students.csv', 'name,score\nЗуев Аким,7\n')
  forgetTree(ID)
})

after(() => shutdownCollab())

/** The seminar and the three files a default pick ticks; `seminar` is known only after `before`. */
const pick = (ack: string[] = []): PublishRequest => ({
  notebooks: [{ root: seminar, name: 'Семинар' }],
  files: [
    { path: 'utils.py', name: '' },
    { path: 'kaggle.json', name: '' },
    { path: 'data/students.csv', name: '' },
  ],
  autoRefresh: true,
  ack,
})

const summary = (checks: readonly PublishCheck[]) =>
  checks.map((c) => [c.kind, c.path ?? c.cellId, c.sample]).sort((a, b) => String(a).localeCompare(String(b)))

test('picked files are checked for keys and names like cells are', () => {
  const info = publishInfo(ID)!
  const files = info.checks.filter((c) => c.path !== null)
  assert.deepEqual(summary(files), [
    ['name', 'data/students.csv', 'Зуев Аким'],
    ['secret', 'kaggle.json', 'a1b2…90'],
    ['secret', 'utils.py', 'sk-p…56'],
  ])
  for (const check of files) {
    assert.equal(check.root, null)
    assert.equal(check.cellId, null)
    assert.match(check.where, /^файл /)
  }
})

test('plotly figures are checked for names, inline and on the shelf', () => {
  const info = publishInfo(ID)!
  const names = info.checks.filter((c) => c.kind === 'name' && c.cellId !== null)
  assert.deepEqual(names.map((c) => c.sample).sort(), ['Аким Зуев', 'Зуев Аким'])
})

let pubId = ''

test('the build holds a page with unconfirmed findings in files and figures, then lets it out clean', async () => {
  const held = await buildAndWrite(ID, pick(), { by: 'Ада' })
  assert.equal(held.ok, false)
  const refused = held as Extract<BuildResult, { ok: false }>
  assert.equal(refused.status, 409)
  // The build finds what the picker showed, with the same ids, so the picker's confirmation holds.
  const shown = publishInfo(ID)!.checks.filter((c) => c.root === seminar || c.path !== null)
  assert.deepEqual(refused.checks!.map((c) => c.id).sort(), shown.map((c) => c.id).sort())

  const built = await buildAndWrite(ID, pick(refused.checks!.map((c) => c.id)), { by: 'Ада' })
  assert.ok(built.ok, JSON.stringify(built))
  pubId = built.publication.id
  // The figures went out without the room id: it is scrubbed before they become blobs.
  const cells = materialCellsText(pubId, 'seminar')!
  const refs = [...cells.matchAll(/blob:([0-9a-f]{32})/g)].map((m) => m[1])
  const figures = refs.map((hash) => readBlob(pubId, hash)!).filter((b) => b.mime === PLOTLY_MIME)
  assert.equal(figures.length, 2, 'both figures should be blobs on the page')
  for (const blob of figures) {
    const text = blob.body.toString('utf8')
    assert.ok(!text.includes(ID), 'the room id rode out in a plotly blob')
    assert.ok(text.includes('scores.csv'), 'the scrub ate the path instead of relativizing it')
  }
  // Nor in the download, which inlines the figures back.
  const [material] = listMaterials(pubId)
  assert.ok(!readPageFile(material.hash)!.toString('utf8').includes(ID))
})

test('a refresh with the same findings goes through; a new key in a picked file holds it', async () => {
  const same = await refreshPage(ID, { by: null })
  assert.ok(same.ok, JSON.stringify(same))
  // A student overwrites a picked file during class.
  put('utils.py', `OPENAI_API_KEY = "${KEY}"\nHF_TOKEN = "hf_abcdefghijklmnopqrstuvwxyz0123456789"\n`)
  const held = await refreshPage(ID, { by: null })
  assert.equal(held.ok, false)
  const refused = held as Extract<BuildResult, { ok: false }>
  assert.equal(refused.status, 409)
  assert.deepEqual(summary(refused.checks!), [['secret', 'utils.py', 'hf_a…89']])
  assert.equal(publicationOf(ID)!.revision, same.ok ? same.publication.revision : -1)
})

test('taking a notebook off the page takes its images with it', async () => {
  put('utils.py', 'def load():\n    pass\n')
  const ack = publishInfo(ID)!.checks.map((c) => c.id)
  const built = await buildAndWrite(
    ID,
    {
      notebooks: [
        { root: seminar, name: 'Семинар' },
        { root: other, name: 'Чужая' },
      ],
      files: [],
      autoRefresh: true,
      ack,
    },
    { by: 'Ада' },
  )
  assert.ok(built.ok, JSON.stringify(built))
  const hashesOf = (key: string) =>
    [...materialCellsText(pubId, key)!.matchAll(/blob:([0-9a-f]{32})/g)].map((m) => m[1])
  const kept = hashesOf('seminar')
  const gone = hashesOf('extra')
  assert.equal(gone.length, 1)
  assert.ok(readBlob(pubId, gone[0]), 'the image was not on the page to begin with')

  const removed = await removeMaterial(pubId, 'extra')
  assert.ok(removed.ok, JSON.stringify(removed))
  assert.equal(readBlob(pubId, gone[0]), null, 'the removed notebook’s image is still served')
  for (const hash of kept) assert.ok(readBlob(pubId, hash), 'an image of a notebook still on the page went')
})
