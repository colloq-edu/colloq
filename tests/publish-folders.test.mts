/**
 * Folders on a class page (server/src/publish/materials.ts, zip.ts).
 *
 * The EDA class needs `data/` (fifteen datasets), `scripts/` (modules the
 * notebooks import as `from scripts import case_cian as cian`) and `assets/`
 * (pictures the notes draw) next to its notebooks, at the room's paths, or
 * nothing in the archive runs. One file per material cannot hold that, so a
 * top-level folder is offered and published as ONE material: ticked by
 * default when something on the page uses it, with the same rules inside
 * («_», answers, run output, the upload limit) and the same checks. A refresh
 * re-reads a picked folder, so a file added in class goes out, and a key in
 * it holds the refresh like one in a cell.
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
import { config } from '../server/src/config.js'
import { createSession, db, widenMaterialKinds } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { addBook, createCell } from '../shared/notebook.js'
import { isPrivatePath, materialTags, mentioned } from '../shared/materials.js'
import { MAX_FOLDER_FILES, type PublicCourseView, type PublicPage } from '../shared/publish.js'
import {
  buildAndWrite,
  publishInfo,
  refreshPage,
  removeMaterial,
  repairFolderFiles,
} from '../server/src/publish/materials.js'
import {
  gcPageFiles,
  holdPageFiles,
  pageFileInfo,
  pageFilePath,
} from '../server/src/publish/page-files.js'
import {
  createCourse,
  deletePublication,
  listMaterials,
  publicationOf,
  setCourseItems,
  setCourseSlug,
  type Publication,
} from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { forgetTree, listTree, sessionDir } from '../server/src/workspace.js'
import {
  folderRequest,
  goingPaths,
  lockedFile,
  relevantChecks,
} from '../web/src/admin/page-picker.js'

const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0
const ID = 'eda-room'
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'
const SCRATCH = path.join(process.env.DATA_DIR!, '..', 'folder-out')
let uploadLimit = 0
let lecture = ''
let homework = ''
let base = ''
let server: http.Server

function put(room: string, rel: string, body: Buffer | string): void {
  const full = path.join(sessionDir(room), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

before(async () => {
  uploadLimit = config.maxUploadBytes
  ;(config as { maxUploadBytes: number }).maxUploadBytes = 1024 * 1024
  createSession(ID, 'Разведочный анализ', null)
  const { doc } = getSessionDoc(ID, 'Разведочный анализ')
  lecture = addBook(doc, 'lecture.ipynb').root
  homework = addBook(doc, 'homework/hw.ipynb').root
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>(lecture).push([
      createCell('markdown', '# Разведка\n\n![Квартиры](assets/fig1.png)'),
      // No dataset is named here: data/ is needed because scripts/eda_tools.py reads it.
      createCell(
        'code',
        'from scripts import case_cian as cian, case_bpm\nfrom scripts.eda_tools import load_dataset\ndf = load_dataset(NAME)',
      ),
    ])
    doc.getArray<Y.Map<unknown>>(homework).push([createCell('code', 'x = 1')])
  }, 'server')
  put(ID, 'data/flats.csv', 'rooms,price\n2,100\n')
  put(ID, 'data/prices.parquet', Buffer.from([80, 65, 82, 49, 0, 1, 2, 3]))
  put(ID, 'data/_raw.csv', `token,${KEY}\n`)
  put(ID, 'data/answers.csv', 'id,y\n1,2\n')
  put(ID, 'data/outputs/pred.csv', 'id,y\n1,3\n')
  put(ID, 'data/huge.bin', Buffer.alloc(1024 * 1024 + 10, 7))
  put(ID, 'scripts/__init__.py', '')
  put(ID, 'scripts/case_cian.py', 'def run():\n    return 1\n')
  put(ID, 'scripts/case_bpm.py', 'def run():\n    return 2\n')
  put(ID, 'scripts/eda_tools.py', "import pandas as pd\n\ndef load_dataset(name):\n    return pd.read_csv(f'data/{name}')\n")
  put(ID, 'scripts/_scratch.py', 'print("mine")\n')
  put(ID, 'scripts/__pycache__/case_cian.cpython-311.pyc', Buffer.from([1, 2, 3]))
  put(ID, 'assets/fig1.png', Buffer.from([137, 80, 78, 71, 1]))
  put(ID, 'assets/fig2.png', Buffer.from([137, 80, 78, 71, 2]))
  put(ID, 'notes/reading.txt', 'nobody reads this\n')
  // homework/ holds nothing but a notebook's file, and empty/ nothing: neither is a folder choice.
  put(ID, 'homework/hw.ipynb', '{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}')
  fs.mkdirSync(path.join(sessionDir(ID), 'empty'), { recursive: true })
  forgetTree(ID)

  const course = createCourse('Анализ данных', null, null)
  assert.equal(setCourseSlug(course.id, 'eda-course'), 'ok')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', id: 'reda0001', sessionId: ID, name: 'x', publication: null, day: '2026-10-05' },
  ])

  const app = express()
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  fs.mkdirSync(SCRATCH, { recursive: true })
})

after(() => {
  ;(config as { maxUploadBytes: number }).maxUploadBytes = uploadLimit
  server?.close()
  shutdownCollab()
})

const PICK = {
  notebooks: [{ root: '', name: 'Лекция' }],
  files: [
    { path: 'data/', name: '' },
    { path: 'scripts/', name: '' },
    { path: 'assets/', name: '' },
  ],
  autoRefresh: true,
  ack: [] as string[],
}

const pick = () => ({ ...PICK, notebooks: [{ root: lecture, name: 'Лекция' }] })

test('"from scripts import a, b as c" marks both modules and the package, and __init__.py is not private', () => {
  const text = 'from scripts import case_cian as cian, case_bpm\n'
  assert.ok(mentioned('scripts/case_cian.py', text))
  assert.ok(mentioned('scripts/case_bpm.py', text))
  assert.ok(!mentioned('scripts/eda_tools.py', text))
  assert.ok(mentioned('scripts/__init__.py', text))
  assert.ok(mentioned('scripts/__init__.py', 'from scripts.eda_tools import load_dataset'))
  assert.ok(mentioned('scripts/case_cian.py', 'from scripts import (\n    case_cian,\n    case_bpm as bpm,\n)'))
  assert.ok(mentioned('utils.py', 'import os, utils'))
  // A function taken from a library is not a local module of that name.
  assert.ok(!mentioned('plot.py', 'from matplotlib.pyplot import plot'))
  assert.equal(isPrivatePath('scripts/__init__.py'), false)
  assert.equal(isPrivatePath('scripts/__main__.py'), false)
  assert.equal(isPrivatePath('scripts/_scratch.py'), true)
  assert.equal(isPrivatePath('__secret.py'), true)
  assert.equal(isPrivatePath('_drafts/__init__.py'), true)
})

test('each top-level folder is offered once, with its counts, its contents and a default tick', () => {
  const info = publishInfo(ID)!
  const byPath = new Map(info.files.map((f) => [f.path, f]))
  // Nothing under a folder is offered on its own, and notebooks are never inside a folder.
  assert.deepEqual(
    info.files.map((f) => f.path),
    ['assets/', 'data/', 'notes/', 'scripts/'],
  )
  assert.ok(info.notebooks.some((n) => n.path === 'homework/hw.ipynb'))

  const data = byPath.get('data/')!
  assert.deepEqual([data.kind, data.picked, data.why, data.name], ['folder', true, null, 'data/'])
  assert.equal(data.files, 2)
  assert.equal(data.bytes, 'rooms,price\n2,100\n'.length + 8)
  assert.deepEqual(data.holds, ['data'])
  // data/ is read by code that goes out with the page, not by the notebook itself.
  assert.deepEqual(data.usedBy, ['scripts/eda_tools.py'])
  assert.deepEqual(
    Object.fromEntries(data.entries!.map((e) => [e.path, e.why])),
    {
      'data/outputs/pred.csv': 'generated',
      'data/_raw.csv': 'private',
      'data/answers.csv': 'answers',
      'data/flats.csv': null,
      'data/huge.bin': 'too-large',
      'data/prices.parquet': null,
    },
  )

  const scripts = byPath.get('scripts/')!
  assert.deepEqual([scripts.picked, scripts.why], [true, null])
  assert.deepEqual(scripts.usedBy, ['lecture.ipynb'])
  assert.deepEqual(
    scripts.entries!.map((e) => [e.path, e.why]),
    [
      ['scripts/__init__.py', null],
      ['scripts/_scratch.py', 'private'],
      ['scripts/case_bpm.py', null],
      ['scripts/case_cian.py', null],
      ['scripts/eda_tools.py', null],
    ],
  )
  assert.deepEqual(scripts.holds, ['code'])

  // Pictures the notes draw: ticked so that the archive shows them, every picture in it going.
  const assets = byPath.get('assets/')!
  assert.deepEqual([assets.picked, assets.why, assets.files], [true, null, 2])
  assert.deepEqual(assets.inNotes, ['lecture.ipynb'])
  assert.deepEqual(assets.holds, ['image'])

  const notes = byPath.get('notes/')!
  assert.deepEqual([notes.picked, notes.why], [false, 'unused'])

  assert.deepEqual(
    data.entries!.filter((e) => e.picked).map((e) => e.path),
    ['data/flats.csv', 'data/prices.parquet'],
  )

  /*
   * The key in data/_raw.csv stays in the room with the file. The finding is
   * known (the teacher may tick the file in «состав папки»), but nothing asks
   * about it while the file is not ticked.
   */
  assert.equal(info.checks.find((c) => c.path === 'data/_raw.csv')?.folder, 'data/')
  const asked = relevantChecks(info.checks, new Set(), goingPaths(info.files))
  assert.ok(!asked.some((c) => c.path === 'data/_raw.csv'), JSON.stringify(asked))
})

let pub: Publication

test('a picked folder is one material with its files at their room paths, after the notebooks', async () => {
  const result = await buildAndWrite(ID, pick(), { by: 'Ада' })
  assert.ok(result.ok, JSON.stringify(result))
  assert.deepEqual(result.refused, [])
  pub = result.publication
  const materials = listMaterials(pub.id)
  assert.deepEqual(
    materials.map((m) => [m.key, m.kind, m.name, m.path, m.files?.length ?? null]),
    [
      ['lecture', 'notebook', 'Лекция', 'lecture.ipynb', null],
      ['data', 'folder', 'data/', 'data', 2],
      ['scripts', 'folder', 'scripts/', 'scripts', 4],
      ['assets', 'folder', 'assets/', 'assets', 2],
    ],
  )
  const scripts = materials.find((m) => m.key === 'scripts')!
  assert.deepEqual(
    scripts.files!.map((f) => f.path),
    ['scripts/__init__.py', 'scripts/case_bpm.py', 'scripts/case_cian.py', 'scripts/eda_tools.py'],
  )
  for (const file of scripts.files!) assert.ok(pageFileInfo(file.hash), file.path)
  assert.equal(scripts.bytes, scripts.files!.reduce((sum, f) => sum + f.bytes, 0))
  assert.deepEqual(
    pub.selection!.files.map((f) => f.path),
    ['data/', 'scripts/', 'assets/'],
  )
  // The panel's list of the page counts the folder as one row, with what it holds.
  assert.deepEqual(
    result.page.materials.map((m) => [m.key, m.kind, m.files ?? null, m.holds ?? null]),
    [
      ['lecture', 'notebook', null, null],
      ['data', 'folder', 2, ['data']],
      ['scripts', 'folder', 4, ['code']],
      ['assets', 'folder', 2, ['image']],
    ],
  )
  assert.deepEqual(materialTags(listMaterials(pub.id)), ['lecture', 'data', 'code'])
})

test('the class page and the course list a folder as one row with its file count', async () => {
  const page = (await (await fetch(`${base}/api/p/${pub.id}`)).json()) as { page: PublicPage }
  const data = page.page.materials.find((m) => m.key === 'data')!
  assert.deepEqual(
    { ...data },
    { key: 'data', kind: 'folder', name: 'data/', bytes: data.bytes, files: 2, holds: ['data'], path: 'data' },
  )
  const course = (await (await fetch(`${base}/api/c/eda-course`)).json()) as { course: PublicCourseView }
  const row = course.course.classes[0]
  assert.deepEqual(
    row.page?.materials.map((m) => [m.key, m.kind, m.files ?? null]),
    [
      ['lecture', 'notebook', null],
      ['data', 'folder', 2],
      ['scripts', 'folder', 4],
      ['assets', 'folder', 2],
    ],
  )
  // A folder has no bytes of its own to open in place.
  assert.equal((await fetch(`${base}/api/p/${pub.id}/m/data/open`)).status, 404)
})

/** What Python's zipfile makes of an archive: its names, after checking every CRC. */
function unzip(file: string): { names: string[]; readme: string | null } {
  const code = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
names = [i.filename for i in z.infolist()]
readme = [n for n in names if n.endswith('/README.md')]
print(json.dumps({'names': names, 'readme': z.read(readme[0]).decode('utf-8') if readme else None}))
`
  const run = spawnSync('python3', ['-c', code, file], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout)
}

test('a folder downloads as its own valid ZIP: data.zip with data/ inside', { skip: HAVE_PYTHON ? false : 'no python3' }, async () => {
  const res = await fetch(`${base}/api/p/${pub.id}/m/scripts/download`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/zip')
  assert.match(res.headers.get('content-disposition') ?? '', /filename\*=UTF-8''scripts\.zip$/)
  const body = Buffer.from(await res.arrayBuffer())
  assert.equal(Number(res.headers.get('content-length')), body.length)
  const file = path.join(SCRATCH, 'scripts.zip')
  fs.writeFileSync(file, body)
  const check = spawnSync('python3', ['-m', 'zipfile', '-t', file], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr || check.stdout)
  assert.deepEqual(unzip(file), {
    names: ['scripts/__init__.py', 'scripts/case_bpm.py', 'scripts/case_cian.py', 'scripts/eda_tools.py'],
    readme: null,
  })
  assert.equal((await fetch(`${base}/api/p/${pub.id}/m/nothing-here/download`)).status, 404)
})

test('the class ZIP holds every folder file at its room path, and its README lists the folders', { skip: HAVE_PYTHON ? false : 'no python3' }, async () => {
  const res = await fetch(`${base}/api/p/${pub.id}/zip`)
  assert.equal(res.status, 200)
  const body = Buffer.from(await res.arrayBuffer())
  const file = path.join(SCRATCH, 'class.zip')
  fs.writeFileSync(file, body)
  const seen = unzip(file)
  const top = seen.names[0].split('/')[0]
  assert.equal(top, 'eda-course-01')
  assert.deepEqual(
    new Set(seen.names),
    new Set([
      `${top}/README.md`,
      `${top}/lecture.ipynb`,
      `${top}/data/flats.csv`,
      `${top}/data/prices.parquet`,
      `${top}/scripts/__init__.py`,
      `${top}/scripts/case_bpm.py`,
      `${top}/scripts/case_cian.py`,
      `${top}/scripts/eda_tools.py`,
      `${top}/assets/fig1.png`,
      `${top}/assets/fig2.png`,
    ]),
  )
  assert.match(seen.readme!, /- `data\/` — папка, 2 файла/)
  assert.match(seen.readme!, /- `scripts\/` — папка, 4 файла/)
  // The page tells the archive's size before anyone downloads, folders included.
  const page = (await (await fetch(`${base}/api/p/${pub.id}`)).json()) as { page: PublicPage }
  assert.equal(page.page.zip?.bytes, body.length)
})

test('a refresh re-reads a picked folder: a new file goes out, a new key in one holds it', async () => {
  put(ID, 'data/extra.csv', 'a,b\n1,2\n')
  forgetTree(ID)
  const fresh = await refreshPage(ID, { by: null })
  assert.ok(fresh.ok, JSON.stringify(fresh))
  const data = listMaterials(fresh.publication.id).find((m) => m.key === 'data')!
  assert.deepEqual(
    data.files!.map((f) => f.path),
    ['data/extra.csv', 'data/flats.csv', 'data/prices.parquet'],
  )

  // A file dropped into data/ in class that carries a key: nobody confirmed it, so the page waits.
  put(ID, 'data/leak.csv', `key,${KEY}\n`)
  forgetTree(ID)
  const held = await refreshPage(ID, { by: null })
  assert.equal(held.ok, false)
  assert.ok(!held.ok && held.status === 409 && held.error === 'unconfirmed', JSON.stringify(held))
  const check = !held.ok ? held.checks?.find((c) => c.path === 'data/leak.csv') : undefined
  assert.ok(check, JSON.stringify(held))
  assert.equal(check.kind, 'secret')
  assert.equal(check.folder, 'data/')
  // The page is still the one before the key arrived.
  const still = listMaterials(publicationOf(ID)!.id).find((m) => m.key === 'data')!
  assert.ok(!still.files!.some((f) => f.path === 'data/leak.csv'))

  // The picker names the folder the finding is in, so the panel shows it under the ticked folder.
  const info = publishInfo(ID)!
  assert.equal(info.checks.find((c) => c.path === 'data/leak.csv')?.folder, 'data/')

  // The panel asks about it because data/ is ticked and the file in it too.
  const going = goingPaths(info.files)
  assert.deepEqual(relevantChecks(info.checks, new Set(), going).map((c) => c.path), ['data/leak.csv'])
  const dataOff = info.files.map((f) => (f.path === 'data/' ? { ...f, picked: false } : f))
  assert.deepEqual(relevantChecks(info.checks, new Set(), goingPaths(dataOff)), [])

  // Confirmed by the teacher, it goes out with the folder.
  const confirmed = await buildAndWrite(ID, { ...pick(), ack: [check.id] }, { by: 'Ада' })
  assert.ok(confirmed.ok, JSON.stringify(confirmed))
  const after = listMaterials(confirmed.publication.id).find((m) => m.key === 'data')!
  assert.ok(after.files!.some((f) => f.path === 'data/leak.csv'))
  fs.rmSync(path.join(sessionDir(ID), 'data/leak.csv'))
  forgetTree(ID)
})

test('a pick saved before folders reads as the folder with just those files, not the whole folder', async () => {
  createSession('old-pick', 'Старый выбор', null)
  const { doc } = getSessionDoc('old-pick', 'Старый выбор')
  const seminar = addBook(doc, 'seminar.ipynb').root
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>(seminar).push([createCell('code', "pd.read_csv('data/old.csv')")])
  }, 'server')
  put('old-pick', 'data/old.csv', 'x\n1\n')
  put('old-pick', 'data/other.csv', 'y\n2\n')
  put('old-pick', 'data/_raw.csv', 'z\n3\n')
  forgetTree('old-pick')
  // 0.13 picked data/old.csv and data/_raw.csv on their own, and left data/other.csv out.
  const built = await buildAndWrite(
    'old-pick',
    {
      notebooks: [{ root: seminar, name: '' }],
      files: [{ path: 'data/old.csv', name: '' }, { path: 'data/_raw.csv', name: '' }],
      autoRefresh: true,
      ack: [],
    },
    { by: 'Ада' },
  )
  assert.ok(built.ok, JSON.stringify(built))
  assert.deepEqual(
    listMaterials(built.publication.id).map((m) => [m.kind, m.path]),
    [
      ['notebook', 'seminar.ipynb'],
      ['data', 'data/old.csv'],
      ['data', 'data/_raw.csv'],
    ],
  )
  // A refresh of that pick still publishes the two files, as 0.13 did.
  const refreshed = await refreshPage('old-pick', { by: null })
  assert.ok(refreshed.ok, JSON.stringify(refreshed))
  assert.deepEqual(
    listMaterials(refreshed.publication.id).map((m) => m.path),
    ['seminar.ipynb', 'data/old.csv', 'data/_raw.csv'],
  )
  /*
   * The panel shows data/ ticked with exactly those two files: the one the
   * teacher left out stays out, so the next «Опубликовать» sends no more
   * than before.
   */
  const folder = publishInfo('old-pick')!.files.find((f) => f.path === 'data/')!
  assert.deepEqual([folder.picked, folder.why, folder.isNew, folder.files], [true, null, false, 2])
  assert.deepEqual(
    folder.entries!.map((e) => [e.path, e.why, e.picked]),
    [
      ['data/_raw.csv', 'private', true],
      ['data/old.csv', null, true],
      ['data/other.csv', null, false],
    ],
  )
  const fromPanel = await buildAndWrite(
    'old-pick',
    { notebooks: [{ root: seminar, name: '' }], files: [folderRequest(folder, '')], autoRefresh: true, ack: [] },
    { by: 'Ада' },
  )
  assert.ok(fromPanel.ok, JSON.stringify(fromPanel))
  assert.deepEqual(
    listMaterials(fromPanel.publication.id).find((m) => m.kind === 'folder')!.files!.map((f) => f.path),
    ['data/_raw.csv', 'data/old.csv'],
  )
  // Both named: the file goes out inside the folder, once.
  const both = await buildAndWrite(
    'old-pick',
    {
      notebooks: [{ root: seminar, name: '' }],
      files: [{ path: 'data/old.csv', name: '' }, { path: 'data/', name: '' }],
      autoRefresh: true,
      ack: [],
    },
    { by: 'Ада' },
  )
  assert.ok(both.ok, JSON.stringify(both))
  assert.deepEqual(
    listMaterials(both.publication.id).map((m) => [m.kind, m.path]),
    [
      ['notebook', 'seminar.ipynb'],
      ['folder', 'data'],
    ],
  )
  assert.deepEqual(both.publication.selection!.files.map((f) => f.path), ['data/'])
})

test('a page counts a folder as one material, and a folder over the file cap is refused whole', async () => {
  createSession('max-room', 'Много файлов', null)
  for (let i = 0; i < 40; i++) put('max-room', `many/part-${String(i).padStart(2, '0')}.csv`, `p\n${i}\n`)
  for (let i = 0; i < 23; i++) put('max-room', `root-${i}.csv`, `r\n${i}\n`)
  for (let i = 0; i <= MAX_FOLDER_FILES; i++) put('max-room', `pics/${i}.png`, Buffer.from([i % 256, 1]))
  forgetTree('max-room')
  const rootFiles = Array.from({ length: 23 }, (_, i) => ({ path: `root-${i}.csv`, name: '' }))
  const fits = await buildAndWrite(
    'max-room',
    { notebooks: [], files: [...rootFiles, { path: 'many/', name: '' }], autoRefresh: true, ack: [] },
    { by: 'Ада' },
  )
  assert.ok(fits.ok, JSON.stringify(fits))
  assert.equal(listMaterials(fits.publication.id).length, 24)
  const folder = listMaterials(fits.publication.id).find((m) => m.kind === 'folder')!
  assert.equal(folder.files!.length, 40)

  const over = await buildAndWrite(
    'max-room',
    {
      notebooks: [],
      files: [...rootFiles, { path: 'many/', name: '' }, { path: 'pics/', name: '' }],
      autoRefresh: true,
      ack: [],
    },
    { by: 'Ада' },
  )
  assert.equal(over.ok, false)
  assert.equal(!over.ok && over.status, 400)

  const info = publishInfo('max-room')!
  const pics = info.files.find((f) => f.path === 'pics/')!
  assert.deepEqual([pics.picked, pics.why, pics.files], [false, 'too-many', MAX_FOLDER_FILES + 1])
  // The panel locks it; a folder bigger than one file may be is not locked for its size.
  assert.equal(lockedFile(pics, 1), true)
  const many = info.files.find((f) => f.path === 'many/')!
  assert.equal(lockedFile(many, 1), false)
  const refused = await buildAndWrite(
    'max-room',
    { notebooks: [], files: [{ path: 'many/', name: '' }, { path: 'pics/', name: '' }], autoRefresh: true, ack: [] },
    { by: 'Ада' },
  )
  assert.ok(refused.ok, JSON.stringify(refused))
  assert.deepEqual(refused.refused, [{ path: 'pics/', reason: 'too-many' }])
  // A nested folder is not a material of its own, and the root is not a folder.
  for (const bad of ['many/sub/', '/']) {
    const result = await buildAndWrite(
      'max-room',
      { notebooks: [], files: [{ path: bad, name: '' }], autoRefresh: true, ack: [] },
      { by: 'Ада' },
    )
    assert.equal(!result.ok && result.status, 400, bad)
  }
})

test('the page-file GC keeps a folder\'s files, and drops them with the folder and with the page', async () => {
  const before = listMaterials(publicationOf(ID)!.id)
  const assets = before.find((m) => m.key === 'assets')!
  const scripts = before.find((m) => m.key === 'scripts')!
  const fig2 = assets.files!.find((f) => f.path === 'assets/fig2.png')!
  assert.ok(pageFileInfo(fig2.hash))
  assert.ok(fs.existsSync(pageFilePath(fig2.hash)))

  // «Убрать со страницы» on a folder: its files go, and the pick forgets it.
  const removed = await removeMaterial(publicationOf(ID)!.id, 'assets')
  assert.ok(removed.ok, JSON.stringify(removed))
  assert.equal(pageFileInfo(fig2.hash), null, 'a removed folder kept its file')
  assert.equal(fs.existsSync(pageFilePath(fig2.hash)), false)
  assert.ok(!removed.publication.selection!.files.some((f) => f.path === 'assets/'))
  assert.ok(pageFileInfo(scripts.files![0].hash), 'another folder lost its file')
  const rows = (where: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM publication_material_files WHERE ${where}`).get(removed.publication.id) as {
      n: number
    }).n
  assert.equal(rows("pub = ? AND key = 'assets'"), 0)

  // Erasing the page takes every folder file with it.
  const hashes = listMaterials(removed.publication.id).flatMap((m) => (m.files ?? []).map((f) => f.hash))
  assert.ok(hashes.length > 0)
  deletePublication(removed.publication.id)
  assert.equal(rows('pub = ?'), 0)
  // These were only this page's; a file another page also held would stay.
  for (const hash of hashes) assert.equal(pageFileInfo(hash), null, hash)
})

/** A room with one notebook holding this code, and these files. */
function room(id: string, code: string, files: Record<string, Buffer | string>): string {
  createSession(id, id, null)
  const { doc } = getSessionDoc(id, id)
  const root = addBook(doc, 'lecture.ipynb').root
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>(root).push([createCell('code', code)])
  }, 'server')
  for (const [rel, body] of Object.entries(files)) put(id, rel, body)
  forgetTree(id)
  return root
}

const folderFiles = (pubId: string, key: string) =>
  listMaterials(pubId).find((m) => m.key === key)?.files?.map((f) => f.path) ?? null

test('the teacher\'s word on single files of a folder goes out and outlives a refresh', async () => {
  const lecture = room('override-room', "from scripts import eda_tools\nsub = pd.read_csv('data/train.csv')", {
    'scripts/__init__.py': '',
    // The package's own `_` modules: imported, so they go with it by themselves.
    'scripts/eda_tools.py': 'from ._utils import plot\nfrom scripts._core.engine import run\n',
    'scripts/_utils.py': 'def plot():\n    return "ovr-marker"\n',
    'scripts/_core/__init__.py': '',
    'scripts/_core/engine.py': 'def run():\n    return "ovr-marker"\n',
    'scripts/_scratch.py': 'print("ovr-marker")\n',
    'data/train.csv': 'a\novr-marker\n',
    'data/holdout.csv': 'y\novr-marker\n',
    'data/submission_example.csv': 'id,y\novr-marker\n',
    'data/server.pem': 'ovr-marker certificate\n',
    'data/huge.bin': Buffer.alloc(1024 * 1024 + 10, 3),
  })
  const info = publishInfo('override-room')!
  const scripts = info.files.find((f) => f.path === 'scripts/')!
  assert.deepEqual(
    Object.fromEntries(scripts.entries!.map((e) => [e.path, e.why])),
    {
      'scripts/_core/__init__.py': null,
      'scripts/_core/engine.py': null,
      'scripts/__init__.py': null,
      'scripts/_scratch.py': 'private',
      'scripts/_utils.py': null,
      'scripts/eda_tools.py': null,
    },
  )
  const data = info.files.find((f) => f.path === 'data/')!
  assert.deepEqual(
    Object.fromEntries(data.entries!.map((e) => [e.path, [e.why, e.picked]])),
    {
      'data/holdout.csv': [null, true],
      'data/huge.bin': ['too-large', false],
      'data/server.pem': ['secret', false],
      'data/submission_example.csv': ['generated', false],
      'data/train.csv': [null, true],
    },
  )

  // The teacher sends the sample submission and the certificate, and keeps the holdout back.
  const tick = (path: string, on: boolean) => {
    data.entries!.find((e) => e.path === path)!.picked = on
  }
  tick('data/submission_example.csv', true)
  tick('data/server.pem', true)
  tick('data/holdout.csv', false)
  const request = folderRequest(data, '')
  assert.deepEqual(request, {
    path: 'data/',
    name: '',
    include: ['data/server.pem', 'data/submission_example.csv'],
    exclude: ['data/holdout.csv'],
  })
  const built = await buildAndWrite(
    'override-room',
    {
      notebooks: [{ root: lecture, name: '' }],
      files: [
        // Over the upload limit, outside the folder, or not a path: none of it can go.
        { ...request, include: [...request.include!, 'data/huge.bin', '../etc/passwd', 'scripts/_scratch.py'] },
        { path: 'scripts/', name: '' },
      ],
      autoRefresh: true,
      ack: [],
    },
    { by: 'Ада' },
  )
  assert.ok(built.ok, JSON.stringify(built))
  const id = built.publication.id
  assert.deepEqual(folderFiles(id, 'data'), ['data/server.pem', 'data/submission_example.csv', 'data/train.csv'])
  assert.deepEqual(
    new Set(folderFiles(id, 'scripts')),
    new Set([
      'scripts/_core/__init__.py',
      'scripts/_core/engine.py',
      'scripts/__init__.py',
      'scripts/_utils.py',
      'scripts/eda_tools.py',
    ]),
  )
  // The saved pick keeps the word on files of that folder, and nothing else.
  assert.deepEqual(built.publication.selection!.files.find((f) => f.path === 'data/'), {
    path: 'data/',
    name: 'data/',
    include: ['data/huge.bin', 'data/server.pem', 'data/submission_example.csv'],
    exclude: ['data/holdout.csv'],
  })

  // A file arriving in class follows the rules; the files decided about keep the decision.
  put('override-room', 'data/new.csv', 'n\novr-marker\n')
  forgetTree('override-room')
  const fresh = await refreshPage('override-room', { by: null })
  assert.ok(fresh.ok, JSON.stringify(fresh))
  assert.deepEqual(folderFiles(id, 'data'), [
    'data/new.csv',
    'data/server.pem',
    'data/submission_example.csv',
    'data/train.csv',
  ])
  const again = publishInfo('override-room')!.files.find((f) => f.path === 'data/')!
  assert.deepEqual([again.picked, again.files], [true, 4])
  assert.deepEqual(
    again.entries!.filter((e) => e.picked).map((e) => e.path),
    ['data/new.csv', 'data/server.pem', 'data/submission_example.csv', 'data/train.csv'],
  )
})

test('a build puts a folder\'s files yielding, and a GC running meanwhile keeps them', async () => {
  const hold = holdPageFiles()
  const file = hold.put(Buffer.from(`held ${Date.now()}`), 'text/plain')
  gcPageFiles()
  assert.ok(pageFileInfo(file.hash), 'the GC took a file a build holds')
  hold.release()
  gcPageFiles()
  assert.equal(pageFileInfo(file.hash), null, 'a released file nothing references stayed')

  // A page deleted while a build yields runs the GC between the build's puts.
  for (let i = 0; i < 40; i++) put('override-room', `data/part-${i}.csv`, `p\n${i} ${Date.now()}\n`)
  forgetTree('override-room')
  let sweeps = 0
  const sweeper = setInterval(() => {
    gcPageFiles()
    sweeps++
  }, 0)
  const result = await refreshPage('override-room', { by: null })
  clearInterval(sweeper)
  assert.ok(result.ok, JSON.stringify(result))
  assert.ok(sweeps > 0, 'the build never yielded')
  const data = listMaterials(result.publication.id).find((m) => m.key === 'data')!
  assert.equal(data.files!.length, 44)
  for (const f of data.files!) {
    assert.ok(pageFileInfo(f.hash) && fs.existsSync(pageFilePath(f.hash)), f.path)
  }
})

test('a notebook that does not go out does not make a folder needed', () => {
  createSession('answers-room', 'Ответы', null)
  const { doc } = getSessionDoc('answers-room', 'Ответы')
  const lecture = addBook(doc, 'lecture.ipynb').root
  const solutions = addBook(doc, 'solutions.ipynb').root
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>(lecture).push([createCell('code', "pd.read_csv('data/train.csv')")])
    doc.getArray<Y.Map<unknown>>(solutions).push([
      createCell('markdown', '![График](figs/plot.png)'),
      createCell('code', "pd.read_csv('grading/test_labels.csv')"),
    ])
  }, 'server')
  put('answers-room', 'data/train.csv', 'x\n1\n')
  put('answers-room', 'grading/test_labels.csv', 'y\n1\n')
  put('answers-room', 'figs/plot.png', Buffer.from([137, 80, 78, 71, 9]))
  forgetTree('answers-room')
  const info = publishInfo('answers-room')!
  const book = (path: string) => info.notebooks.find((n) => n.path === path)!
  assert.deepEqual([book('lecture.ipynb').picked, book('lecture.ipynb').why], [true, null])
  assert.deepEqual([book('solutions.ipynb').picked, book('solutions.ipynb').why], [false, 'answers'])
  const by = (path: string) => info.files.find((f) => f.path === path)!
  assert.deepEqual([by('data/').picked, by('data/').usedBy], [true, ['lecture.ipynb']])
  for (const path of ['grading/', 'figs/']) {
    assert.deepEqual([by(path).picked, by(path).why, by(path).usedBy, by(path).inNotes], [false, 'unused', [], []], path)
  }
})

test('a folder is walked on its own: a big lib/ neither hides data/raw/ nor goes out half-listed', async () => {
  const files: Record<string, string> = {
    'data/top.csv': 't\n1\n',
    'data/raw/a.csv': 'a\n1\n',
    'scripts/__init__.py': '',
    'scripts/x.py': 'x = 1\n',
  }
  // `pip install --target lib`: more files than the room's tree lists for the whole room.
  for (let i = 0; i < 2100; i++) files[`lib/m${i}.py`] = ''
  const lecture = room('wide-room', "from scripts import x\npd.read_csv('data/top.csv')", files)
  assert.equal(listTree('wide-room').truncated, true)
  const info = publishInfo('wide-room')!
  const by = (path: string) => info.files.find((f) => f.path === path)
  assert.deepEqual(by('data/')!.entries!.map((e) => e.path), ['data/raw/a.csv', 'data/top.csv'])
  assert.deepEqual([by('data/')!.picked, by('data/')!.files], [true, 2])
  assert.deepEqual(by('scripts/')!.entries!.map((e) => e.path), ['scripts/__init__.py', 'scripts/x.py'])
  assert.deepEqual([by('lib/')!.picked, by('lib/')!.why, by('lib/')!.files], [false, 'too-many', MAX_FOLDER_FILES + 1])

  const built = await buildAndWrite(
    'wide-room',
    {
      notebooks: [{ root: lecture, name: '' }],
      files: [{ path: 'data/', name: '' }, { path: 'scripts/', name: '' }, { path: 'lib/', name: '' }],
      autoRefresh: true,
      ack: [],
    },
    { by: 'Ада' },
  )
  assert.ok(built.ok, JSON.stringify(built))
  assert.deepEqual(built.refused, [{ path: 'lib/', reason: 'too-many' }])
  assert.deepEqual(folderFiles(built.publication.id, 'data'), ['data/raw/a.csv', 'data/top.csv'])
  assert.deepEqual(folderFiles(built.publication.id, 'scripts'), ['scripts/__init__.py', 'scripts/x.py'])
})

test('folder files a rollback deleted are put back from the room, or the folder leaves the page', async () => {
  const lecture = room('repair-room', "pd.read_csv('data/a.csv')", {
    'data/a.csv': 'a\nrep-marker\n',
    'data/b.csv': 'b\nrep-marker\n',
  })
  const built = await buildAndWrite(
    'repair-room',
    { notebooks: [{ root: lecture, name: '' }], files: [{ path: 'data/', name: '' }], autoRefresh: true, ack: [] },
    { by: 'Ада' },
  )
  assert.ok(built.ok, JSON.stringify(built))
  const id = built.publication.id
  const data = listMaterials(id).find((m) => m.key === 'data')!
  // What the startup sweep of a release before folders does: it knows only publication_materials.
  const sweptBy013 = () => {
    for (const f of data.files!) {
      db.prepare('DELETE FROM page_files WHERE hash = ?').run(f.hash)
      fs.rmSync(pageFilePath(f.hash), { force: true })
    }
  }
  sweptBy013()
  assert.deepEqual(repairFolderFiles(), { restored: 2, dropped: [] })
  for (const f of data.files!) {
    assert.ok(pageFileInfo(f.hash) && fs.existsSync(pageFilePath(f.hash)), f.path)
  }

  // A file changed in the room since: the folder cannot be put back as it was published.
  put('repair-room', 'data/b.csv', 'b\nchanged since\n')
  forgetTree('repair-room')
  sweptBy013()
  assert.deepEqual(repairFolderFiles(), { restored: 1, dropped: [{ pub: id, key: 'data' }] })
  assert.equal(folderFiles(id, 'data'), null)
  // The pick still names the folder, so publishing again brings it back from the room.
  assert.ok(publicationOf('repair-room')!.selection!.files.some((f) => f.path === 'data/'))
  const again = await refreshPage('repair-room', { by: null })
  assert.ok(again.ok, JSON.stringify(again))
  assert.deepEqual(folderFiles(id, 'data'), ['data/a.csv', 'data/b.csv'])
  assert.deepEqual(repairFolderFiles(), { restored: 0, dropped: [] })
})

test('a 0.13 table, whose CHECK does not know folders, is rebuilt once with its rows', () => {
  db.exec(`
    DROP TABLE publication_materials;
    CREATE TABLE publication_materials (
      pub TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('notebook','pdf','data','code','text','image','file')),
      name TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
      cells TEXT, outline TEXT, cell_count INTEGER, output_count INTEGER,
      PRIMARY KEY (pub, key)
    );
    INSERT INTO publication_materials (pub, key, ord, kind, name, path, hash, bytes)
    VALUES ('old-page', 'slides', 0, 'pdf', 'Слайды', 'slides.pdf', 'abc', 3);
  `)
  const insertFolder = () =>
    db
      .prepare(
        "INSERT INTO publication_materials (pub, key, ord, kind, name, path, hash, bytes) VALUES ('old-page', 'data', 1, 'folder', 'data/', 'data', 'def', 0)",
      )
      .run()
  assert.throws(insertFolder, /CHECK/)
  assert.equal(widenMaterialKinds(), true)
  assert.equal(widenMaterialKinds(), false, 'the second start rebuilt it again')
  insertFolder()
  assert.deepEqual(
    listMaterials('old-page').map((m) => [m.key, m.kind, m.name]),
    [
      ['slides', 'pdf', 'Слайды'],
      ['data', 'folder', 'data/'],
    ],
  )
})
