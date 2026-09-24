/**
 * Publishing: what goes out and what does not.
 *
 * Two promises, and both are kept by listing, not by subtracting. The document
 * has four roots, and the notebook is only one of them: `chat` holds the names
 * of everyone who asked the oracle, `terminal` everything anyone typed into the
 * shell. Inside a cell it is the same: `runBy` and `runById` sit on every cell
 * that was run. So what is checked here is not "are there no names in this
 * example" but the exact set of keys: a field added to the notebook tomorrow
 * must not end up on the public page by itself.
 *
 * And the second: only a version that unfolds into at least one cell can become
 * a step. An empty page for a student is impossible not because someone took
 * care of it but because such a step does not build.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { appendVersion, createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { addBook, createCell, getCells, removeBook } from '../shared/notebook.js'
import { candidatesFor } from '../server/src/publish/candidates.js'
import { newBlobBag, pageAt, pageOfDoc } from '../server/src/publish/build.js'
import { exportSite } from '../server/src/publish/export.js'
import { notebookOf } from '../server/src/publish/notebook.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { Response } from 'express'
import {
  createCourse,
  deleteCourse,
  deletePublication,
  entombSeminar,
  findCourse,
  findPublication,
  formerSlugs,
  getCourse,
  getPublication,
  orphanPublication,
  publicationOf,
  readStep,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  setPublicationState,
  stepHeadings,
  writePublication,
} from '../server/src/publish/store.js'
import { BLOB_PREFIX } from '../shared/publish.js'

after(() => shutdownCollab())

/** A room with two named moments and one output from the kernel. */
function taught(id: string): Y.Doc {
  createSession(id, 'Деревья и леса', null)
  const { doc } = getSessionDoc(id, 'Деревья и леса')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import pandas as pd'))
  mark(id, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')
  doc.transact(() => {
    const cell = cells.get(1)
    ;(cell.get('source') as Y.Text).insert(0, 'df.head()')
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'text/plain': 'таблица' }, execCount: 3 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([out])
    cell.set('execCount', 3)
    cell.set('ranMs', 1400)
    // What must not get out under any circumstances.
    cell.set('runBy', 'Нина')
    cell.set('runById', 'p_nina')
    cell.set('state', 'ok')
  }, 'server')
  mark(id, doc, 'checkpoint' as never, null, 'решение', 'moment marked')
  return doc
}

test('a public page has exactly six cell fields, and no names among them', () => {
  const doc = taught('pub-fields')
  const page = pageOfDoc(doc, newBlobBag())
  const withOutput = page.find((c) => c.outputs.length > 0)
  assert.ok(withOutput, 'no cell with output was found')
  assert.deepEqual(
    Object.keys(withOutput).sort(),
    ['execCount', 'id', 'outputs', 'ranMs', 'source', 'type'],
    'the set of public cell fields changed: check that the new field really may be shown',
  )
  // And the substring itself, just in case: the key set could match while the
  // name arrived inside an output.
  assert.ok(!JSON.stringify(page).includes('Нина'))
  assert.ok(!JSON.stringify(page).includes('p_nina'))
})

test('only named moments become candidates, and only ones with a notebook', () => {
  const id = 'pub-cands'
  taught(id)
  const candidates = candidatesFor(id)
  assert.ok(candidates.length >= 3, 'no moments were found')
  assert.ok(
    candidates.every((c) => c.cellCount > 0),
    'the candidates include a version that unfolds into an empty notebook',
  )
  // Edit bursts are never moments: there are dozens of them per class, and nobody named them.
  assert.ok(!candidates.some((c) => c.kind === 'edit' || c.kind === 'quiet'))
  const named = candidates.filter((c) => c.label)
  assert.deepEqual(named.map((c) => c.label), ['перед упражнением', 'решение'])
  // A service snapshot gets no invented name: "Snapshot #14" on a student's rail is
  // not the name of a moment but an admission that someone forgot to name it.
  assert.ok(candidates.some((c) => c.kind === 'opened' && c.label === ''))
})

test('a step carries the notebook as of its own moment, not as it is today', () => {
  const id = 'pub-moments'
  const doc = taught(id)
  const [before, solution] = candidatesFor(id).filter((c) => c.label)
  const bag = newBlobBag()
  const early = pageAt(id, before.seq, bag)
  const later = pageAt(id, solution.seq, bag)
  assert.ok(early && later)
  assert.equal(early.find((c) => c.outputs.length > 0), undefined, 'the early step already carries output')
  assert.ok(later.some((c) => c.outputs.length > 0), 'the late step lost its output')
  doc.destroy()
})

test('a large image is stored once, and the page holds a reference', () => {
  // A matplotlib chart is the same in every step where its cell did not change:
  // six steps would give six copies of one image.
  const id = 'pub-blobs'
  createSession(id, 'С графиком', null)
  const { doc } = getSessionDoc(id, 'С графиком')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  const png = 'A'.repeat(40_000)
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'image/png': png }, execCount: 1 }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')

  const bag = newBlobBag()
  const first = pageOfDoc(doc, bag)
  const again = pageOfDoc(doc, bag)
  const ref = (page: typeof first) =>
    page.flatMap((c) => c.outputs).find((o) => o.kind === 'data')?.data['image/png']
  assert.ok(ref(first)?.startsWith(BLOB_PREFIX), 'the image stayed in the page whole')
  assert.equal(ref(first), ref(again), 'the same image got two addresses')
  assert.equal(bag.all().length, 1, 'one image was stored twice')
})

test('a deleted seminar leaves a tombstone in the course, not a hole', () => {
  /*
   * A course from which the fourth week silently disappeared is broken for
   * whoever attended it, and the numbering of the rest shifts and stops matching
   * the timetable.
   */
  const id = 'pub-gone'
  createSession(id, 'Регуляризация', null)
  const course = createCourse('Прикладной ML', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Регуляризация', publication: null },
  ])
  entombSeminar(id, 'Регуляризация')
  const after = getCourse(course.id)!
  assert.equal(after.items.length, 1, 'the row disappeared together with the seminar')
  assert.equal(after.items[0].kind, 'gone')
  assert.equal(after.items[0].kind === 'gone' && after.items[0].name, 'Регуляризация')
})

test('republishing keeps the address and replaces the steps', () => {
  // A link cannot be taken back from students: the address has to survive any republish.
  const id = 'pub-again'
  const doc = taught(id)
  const bag = newBlobBag()
  const one = writePublication({
    sessionId: id,
    title: 'Деревья и леса',
    by: 'Ада',
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  const two = writePublication({
    sessionId: id,
    title: 'Деревья и леса',
    by: 'Ада',
    steps: [
      { seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) },
      { seq: 99, label: 'и ещё один', at: Date.now(), cells: pageOfDoc(doc, bag) },
    ],
    blobs: bag.all(),
  })
  assert.equal(one.id, two.id, 'republishing issued a new address')
  assert.equal(two.revision, 2)
  assert.equal(stepHeadings(two.id).length, 2)
  assert.equal(publicationOf(id)?.id, one.id)
  assert.ok(readStep(two.id, null), 'the first step cannot be read')
})

test('two people reordering a course in the same minute do not silently lose the order', () => {
  /*
   * Teachers on an instance share their rights, the seminars screen rereads
   * itself, and a course's contents are written whole as one value. Without
   * comparing the version, the second writer would wipe the first one's work,
   * and nobody would notice.
   */
  const course = createCourse('Курс', null, 'Ада')
  const one = { kind: 'gone' as const, name: 'Первый', at: 1 }
  const two = { kind: 'gone' as const, name: 'Второй', at: 2 }

  const first = setCourseItems(course.id, course.rev, [one, two])
  assert.ok(first, 'the first write did not go through')
  // The second screen holds the course as it read it before.
  assert.equal(setCourseItems(course.id, course.rev, [two, one]), null, 'a stale write went through')
  assert.deepEqual(getCourse(course.id)!.items.map((i) => i.kind === 'gone' && i.name), [
    'Первый',
    'Второй',
  ])
})

test('a withdrawn page stays an address instead of turning into a 404', () => {
  // A link cannot be taken back from students: the page has to answer that it was withdrawn.
  const id = 'pub-withdrawn'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Снятая',
    by: null,
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  setPublicationState(pub.id, 'withdrawn')
  const back = publicationOf(id)
  assert.equal(back?.state, 'withdrawn')
  assert.equal(back?.id, pub.id, 'withdrawal changed the address')
  // The steps stay in place: bringing the page back is one press, not a new publication.
  assert.equal(stepHeadings(pub.id).length, 1)
})

test('SVG stays in the page as text, and only raster images go into a separate entry', () => {
  /*
   * The kernel stores the mimebundle as it is: `image/png` as base64,
   * `image/svg+xml` as XML. Moving a value into an entry assumes base64
   * (`Buffer.from(value, 'base64')`), so an SVG turned into garbage bytes there,
   * and into an empty frame on the page. There was nothing left to recover it from.
   */
  const id = 'pub-svg'
  createSession(id, 'Граф', null)
  const { doc } = getSessionDoc(id, 'Граф')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(1000)}</svg>`
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'image/svg+xml': svg }, execCount: 1 }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')

  const bag = newBlobBag()
  const page = pageOfDoc(doc, bag)
  const value = page.flatMap((c) => c.outputs).find((o) => o.kind === 'data')?.data['image/svg+xml']
  assert.equal(value, svg, 'the SVG went into an entry and lost itself')
  assert.equal(bag.all().length, 0, 'the entry holds something other than base64')
})

test('a checkpoint from the start of a class stays a candidate however much is typed after it', () => {
  /*
   * A burst closes every four kilobytes, on any change to the notebook's cells
   * and after twelve seconds of silence: a room of thirty people produces
   * hundreds of them per class. A window of the four hundred freshest rows of ANY
   * kind threw out of the list exactly the moment it was opened for.
   */
  const id = 'pub-window'
  taught(id)
  const noop = Y.encodeStateAsUpdate(new Y.Doc())
  for (let i = 0; i < 500; i++) {
    appendVersion({
      sessionId: id,
      update: noop,
      kind: 'edit',
      authorId: null,
      createdAt: Date.now(),
      label: null,
      summary: 'печатали',
      added: 1,
      removed: 0,
      cells: [],
    })
  }
  const labels = candidatesFor(id).map((c) => c.label)
  assert.ok(labels.includes('перед упражнением'), 'edit bursts pushed out the checkpoint')
  assert.ok(labels.includes('решение'))
})

test('checkpoints live on after the first notebook of the room is deleted', () => {
  /*
   * The host can delete any file, including "Тетрадь.ipynb": its root is then
   * erased, and the class goes on in the second notebook. Counting cells by the
   * `cells` root gave zero, and all subsequent checkpoints silently stopped being
   * candidates — even though the step page would have built.
   */
  const id = 'pub-books'
  createSession(id, 'Две тетради', null)
  const { doc } = getSessionDoc(id, 'Две тетради')
  const lecture = addBook(doc, 'Лекция.ipynb')
  doc.transact(() => {
    doc.getArray(lecture.root).push([createCell('code', 'plt.plot(xs)')])
    removeBook(doc, 'Тетрадь.ipynb')
  }, 'server')
  assert.equal(getCells(doc).length, 1, 'the second notebook did not become the first')
  mark(id, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')

  const checkpoint = candidatesFor(id).find((c) => c.label === 'перед упражнением')
  assert.ok(checkpoint, 'the checkpoint of the second notebook fell out of the candidates')
  assert.equal(checkpoint.cellCount, 1)
})

test('a tombstone carries a link to the remaining reading', () => {
  /*
   * "Delete the seminar, keep the reading" is the default, and without this link
   * the course row becomes a dead end: the page is alive and opens at its direct
   * address, while the course is the only address the class is given at all.
   */
  const id = 'pub-tomb'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Деревья и леса',
    by: 'Ада',
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  const course = createCourse('Курс с надгробием', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Деревья и леса', publication: null },
  ])
  // Exactly the order in which the seminar deletion does it.
  orphanPublication(id)
  entombSeminar(id, 'Деревья и леса')

  const row = getCourse(course.id)!.items[0]
  assert.equal(row.kind, 'gone')
  assert.equal(row.kind === 'gone' && row.publication?.id, pub.id)
  // The page is alive meanwhile: there is now a way to withdraw it, by its own address.
  assert.equal(getPublication(pub.id)?.sessionId, null)
})

/* ------------------------------------------------------------- the export */

test('the export puts a page under both addresses and replaces a withdrawn one with a tombstone', (t) => {
  /*
   * The whole path by which pages reach a student: directories, images, the
   * notebook as a file — and the address by id that was handed out before the
   * course got a name. On a live server `WHERE id = ? OR slug = ?` keeps it
   * working; Pages has no routing at all.
   */
  const id = 'pub-export'
  createSession(id, 'Выгрузка', null)
  const { doc } = getSessionDoc(id, 'Выгрузка')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(1000)}</svg>`
  doc.transact(() => {
    const png = new Y.Map<unknown>()
    png.set('kind', 'data')
    png.set('json', JSON.stringify({ data: { 'image/png': 'A'.repeat(40_000) }, execCount: 1 }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([png])
    const graph = new Y.Map<unknown>()
    graph.set('kind', 'data')
    graph.set('json', JSON.stringify({ data: { 'image/svg+xml': svg }, execCount: 2 }))
    ;(cells.get(1).get('outputs') as Y.Array<unknown>).push([graph])
  }, 'server')

  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Выгрузка',
    by: 'Ада',
    steps: [
      { seq: 7, label: 'перед упражнением', at: Date.now(), cells: pageOfDoc(doc, bag) },
      { seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) },
    ],
    blobs: bag.all(),
  })
  // SQLite counts a step's cells: parsing the whole page for it would be
  // hundreds of kilobytes of JSON on every public course request.
  assert.deepEqual(
    stepHeadings(pub.id).map((h) => h.cellCount),
    [2, 2],
  )
  assert.equal(setPublicationSlug(pub.id, 'vygruzka'), 'ok')
  const course = createCourse('Курс выгрузки', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Выгрузка', publication: null },
  ])
  assert.equal(setCourseSlug(course.id, 'kurs-vygruzki'), 'ok')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-site-'))
  // Cleaned up here, not in the last line of the test: an assertion failing
  // midway left a directory with a whole site lying in /tmp forever.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  exportSite(root, 'https://colloq.ru')
  const at = (...parts: string[]): string => path.join(root, ...parts)
  const read = (...parts: string[]): string => fs.readFileSync(at(...parts), 'utf8')

  assert.ok(fs.existsSync(at('c', 'kurs-vygruzki', 'index.html')))
  assert.match(read('c', course.id, 'index.html'), /https:\/\/colloq\.ru\/c\/kurs-vygruzki\//)
  assert.ok(fs.existsSync(at('p', 'vygruzka', 'index.html')))
  // The first step is the publication root itself; the others lie one level deeper.
  assert.ok(fs.existsSync(at('p', 'vygruzka', '0', 'index.html')))
  assert.match(read('p', pub.id, 'index.html'), /https:\/\/colloq\.ru\/p\/vygruzka\//)
  assert.match(read('p', pub.id, '0', 'index.html'), /https:\/\/colloq\.ru\/p\/vygruzka\/0\//)

  // An image goes as a file alongside, while SVG stays in the page itself.
  const blobs = fs.readdirSync(at('p', 'vygruzka', 'blob'))
  assert.equal(blobs.length, 1)
  assert.ok(blobs[0].endsWith('.png'), `the image was stored as ${blobs[0]}`)
  assert.match(read('p', 'vygruzka', 'index.html'), /src="data:image\/svg\+xml;charset=utf-8,/)

  // The notebook as a file is the only way to take the code away.
  const notebook = JSON.parse(read('p', 'vygruzka', 'notebook.ipynb')) as {
    cells: { outputs?: unknown[] }[]
  }
  assert.ok(notebook.cells.length > 0)
  assert.ok(notebook.cells.every((c) => (c.outputs ?? []).length === 0), 'outputs went into the file')
  assert.equal(notebookOf(pub.id).length > 0, true)

  /*
   * A withdrawn page is a tombstone, not a GitHub 404. The promise is written out
   * in store.ts: "a link has to say 'it was withdrawn', not 'there is no such
   * page here'". No content remains meanwhile: no steps, no images.
   */
  setPublicationState(pub.id, 'withdrawn')
  exportSite(root, 'https://colloq.ru')
  assert.match(read('p', 'vygruzka', 'index.html'), /снял эту страницу/)
  assert.match(read('p', pub.id, 'index.html'), /снял эту страницу/, 'the former address of the withdrawn page died')
  assert.equal(fs.existsSync(at('p', 'vygruzka', '0')), false, 'a step of the withdrawn page can still be read')
  assert.equal(fs.existsSync(at('p', 'vygruzka', 'blob')), false, 'the images of the withdrawn page remained')
  assert.equal(
    fs.existsSync(at('p', 'vygruzka', 'notebook.ipynb')),
    false,
    'the notebook of the withdrawn page can still be downloaded',
  )
})

test('a former name in the address leads where it used to', (t) => {
  /*
   * A course name is said out loud and written on the board, and then changed —
   * and the link the class has already saved has to keep working. On a live
   * server this is a query; Pages has no routing at all: there the former
   * address stays a pointer file.
   */
  const id = 'pub-renamed'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Переименование',
    by: 'Ада',
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  assert.equal(setPublicationSlug(pub.id, 'nedelya-tri'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'nedelya-04'), 'ok')

  const course = createCourse('Курс с именем', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Переименование', publication: null },
  ])
  assert.equal(setCourseSlug(course.id, 'ml-osen'), 'ok')
  assert.equal(setCourseSlug(course.id, 'ml-strong'), 'ok')

  assert.deepEqual(formerSlugs('course', course.id), ['ml-osen'])
  assert.equal(findCourse('ml-osen')?.id, course.id)
  assert.equal(findCourse(course.id)?.id, course.id)
  assert.equal(findPublication('nedelya-tri')?.id, pub.id)
  // A former address is not given to a neighbour: the link would lead the class
  // into another course.
  const other = createCourse('Соседний курс', null, 'Ада')
  assert.equal(setCourseSlug(other.id, 'ml-osen'), 'taken')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-site-'))
  // Cleaned up here, not in the last line of the test: an assertion failing
  // midway left a directory with a whole site lying in /tmp forever.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  exportSite(root, 'https://colloq.ru')
  const at = (...parts: string[]): string => path.join(root, ...parts)
  const read = (...parts: string[]): string => fs.readFileSync(at(...parts), 'utf8')
  assert.ok(fs.existsSync(at('c', 'ml-strong', 'index.html')))
  assert.match(read('c', 'ml-osen', 'index.html'), /https:\/\/colloq\.ru\/c\/ml-strong\//)
  assert.match(read('c', course.id, 'index.html'), /https:\/\/colloq\.ru\/c\/ml-strong\//)
  assert.match(read('p', 'nedelya-tri', 'index.html'), /https:\/\/colloq\.ru\/p\/nedelya-04\//)
  assert.match(read('p', pub.id, 'index.html'), /https:\/\/colloq\.ru\/p\/nedelya-04\//)

  // A course can take back its own former name — then there is no pointer under it any more.
  assert.equal(setCourseSlug(course.id, 'ml-osen'), 'ok')
  assert.deepEqual(formerSlugs('course', course.id), ['ml-strong'])
  doc.destroy()
})

/* ----------------------------------------------------------------- routes */

test('a blob is served as an image only with a known type', async () => {
  /*
   * The output mime comes from the room document, that is, from anyone, and
   * `content-type` decides what the response becomes when a direct link is
   * followed. `image/svg+xml` is a document, and a script inside it would run on
   * the instance origin, with the cookies of whoever opened the link.
   */
  const id = 'pub-blob-mime'
  createSession(id, 'Блобы', null)
  const pub = writePublication({
    sessionId: id,
    title: 'Блобы',
    by: null,
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: [] }],
    blobs: [
      { hash: 'a'.repeat(32), mime: 'image/png', body: Buffer.from([137, 80, 78, 71]) },
      { hash: 'b'.repeat(32), mime: 'image/svg+xml', body: Buffer.from('<svg><script/></svg>') },
    ],
  })

  const app = express()
  app.use(courseRoutes())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const at = (hash: string): string => `http://127.0.0.1:${port}/api/p/${pub.id}/blob/${hash}`

  const png = await fetch(at('a'.repeat(32)))
  assert.equal(png.headers.get('content-type'), 'image/png')
  assert.equal(png.headers.get('content-disposition'), 'inline')

  const svg = await fetch(at('b'.repeat(32)))
  assert.equal(svg.headers.get('content-type'), 'application/octet-stream')
  assert.match(svg.headers.get('content-disposition') ?? '', /^attachment/)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('a page without a room can be withdrawn by its own address', async () => {
  /*
   * Deleting a seminar keeps the reading and clears `session_id` — and the routes
   * keyed by the room id answer 404 forever. The page is still alive and gets
   * deployed by every `make site`: there was no way to withdraw it, and someone
   * else's personal output could remain on it.
   */
  const id = 'pub-orphan-route'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Осиротевшая',
    by: null,
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  orphanPublication(id)

  const teacher = createTeacher({
    name: 'Ада',
    email: 'ada@publish.test',
    role: 'owner',
  })
  assert.ok(teacher)
  let cookie = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (cookie = v) } as unknown as Response, teacher)

  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const head = { cookie: `${STAFF_COOKIE}=${cookie}` }

  const listed = (await (
    await fetch(`http://127.0.0.1:${port}/api/admin/publications`, { headers: head })
  ).json()) as { publications: { id: string; orphaned: boolean }[] }
  assert.ok(
    listed.publications.some((p) => p.id === pub.id && p.orphaned),
    'the orphaned page is not shown anywhere',
  )

  const withdraw = await fetch(`http://127.0.0.1:${port}/api/admin/publications/${pub.id}`, {
    method: 'DELETE',
    headers: head,
  })
  assert.equal(withdraw.status, 200)
  assert.equal(getPublication(pub.id)?.state, 'withdrawn')

  const back = await fetch(
    `http://127.0.0.1:${port}/api/admin/publications/${pub.id}/restore`,
    { method: 'POST', headers: head },
  )
  assert.equal(back.status, 200)
  assert.equal(getPublication(pub.id)?.state, 'published')

  const forever = await fetch(
    `http://127.0.0.1:${port}/api/admin/publications/${pub.id}/forever`,
    { method: 'DELETE', headers: head },
  )
  assert.equal(forever.status, 200)
  assert.equal(getPublication(pub.id), null)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('a former address lives on the server and is forgotten together with the page', async () => {
  /*
   * A link handed out under a former name cannot be taken back: it is in the
   * group chat and on the board. On Pages a pointer file lies under it; here it
   * is the same response as for the current address, with the canonical address
   * inside: the reader builds further links from it. Withdrawing the page does
   * not cancel the address — the link has to say "it was withdrawn" — but full
   * deletion does: there is nothing to point to.
   */
  const id = 'pub-former-route'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Прежний адрес',
    by: null,
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  assert.equal(setPublicationSlug(pub.id, 'lekciya-01'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'lekciya-01-final'), 'ok')

  const course = createCourse('Статистика', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Прежний адрес', publication: null },
  ])
  assert.equal(setCourseSlug(course.id, 'stat-vesna'), 'ok')
  assert.equal(setCourseSlug(course.id, 'stat-osen'), 'ok')

  const app = express()
  app.use(courseRoutes())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`)

  const asked = await get('/api/c/stat-vesna')
  assert.equal(asked.status, 200, 'the course did not open by its former name')
  const seen = (await asked.json()) as { course: { id: string; slug: string } }
  assert.equal(seen.course.id, course.id)
  assert.equal(seen.course.slug, 'stat-osen', 'the response does not carry the canonical address')

  const page = await get('/api/p/lekciya-01')
  assert.equal(page.status, 200, 'the page did not open by its former name')
  const seminar = (await page.json()) as { seminar: { id: string; slug: string; state: string } }
  assert.equal(seminar.seminar.id, pub.id)
  assert.equal(seminar.seminar.slug, 'lekciya-01-final')
  // And deeper: a step and the notebook file, by the same former address.
  assert.equal((await get('/api/p/lekciya-01/step/first')).status, 200)
  assert.equal((await get('/api/p/lekciya-01/notebook.ipynb')).status, 200)

  setPublicationState(pub.id, 'withdrawn')
  const withdrawn = await get('/api/p/lekciya-01')
  assert.equal(withdrawn.status, 200, 'a withdrawn page at a former address answers "no such page"')
  const state = (await withdrawn.json()) as { seminar: { state: string } }
  assert.equal(state.seminar.state, 'withdrawn')

  deletePublication(pub.id)
  assert.equal((await get('/api/p/lekciya-01')).status, 404, 'the address of an erased page is not forgotten')
  deleteCourse(course.id)
  assert.equal((await get('/api/c/stat-vesna')).status, 404, 'the address of a deleted course is not forgotten')
  doc.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
