/**
 * Publishing: what goes out and what does not.
 *
 * Two promises, and both are kept by listing, not by subtracting. The document
 * has four roots, and the notebooks are only some of them: `chat` holds the
 * names of everyone who asked the oracle, `terminal` everything anyone typed
 * into the shell. Inside a cell it is the same: `runBy` and `runById` sit on
 * every cell that was run. So what is checked here is not "are there no names
 * in this example" but the exact set of keys: a field added to the notebook
 * tomorrow must not end up on the public page by itself.
 *
 * And the second: a page keeps its address. Republishing, withdrawing and
 * deleting the room all leave the link a class was given pointing somewhere
 * honest.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession, db } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { newBlobBag, pageOfDoc, type BlobBag } from '../server/src/publish/build.js'
import { notebookMaterial } from '../server/src/publish/materials.js'
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
  listMaterials,
  orphanPublication,
  publicationOf,
  readBlob,
  readStep,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  setPublicationState,
  stepHeadings,
  writePublication,
} from '../server/src/publish/store.js'
import { BLOB_PREFIX, type PublicCell } from '../shared/publish.js'

after(() => shutdownCollab())

/** One notebook page, the way a build writes it. */
function publishCells(
  sessionId: string,
  title: string,
  cells: PublicCell[],
  bag: BlobBag = newBlobBag(),
  by: string | null = 'Ада',
) {
  const blobs = bag.all()
  const byHash = new Map(blobs.map((b) => [b.hash, b]))
  const material = notebookMaterial({
    key: 'seminar',
    name: 'Семинар',
    path: 'seminar.ipynb',
    cells,
    blob: (hash) => byHash.get(hash) ?? null,
  })
  return writePublication({ sessionId, title, by, materials: [material], blobs })
}

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

test('republishing keeps the address and replaces the materials', () => {
  // A link cannot be taken back from students: the address has to survive any republish.
  const id = 'pub-again'
  const doc = taught(id)
  const bag = newBlobBag()
  const one = publishCells(id, 'Деревья и леса', pageOfDoc(doc, bag), bag)
  const before = listMaterials(one.id)[0].hash
  doc.transact(() => {
    const cells = doc.getArray<Y.Map<unknown>>('cells')
    ;(cells.get(0).get('source') as Y.Text).insert(0, '# Новое\n')
  }, 'server')
  const two = publishCells(id, 'Деревья и леса', pageOfDoc(doc, bag), bag)
  assert.equal(one.id, two.id, 'republishing issued a new address')
  assert.equal(two.revision, 2)
  assert.equal(two.materialsRev, 2)
  assert.equal(two.firstAt, one.firstAt, 'the first publish moved')
  assert.ok(two.publishedAt >= one.publishedAt)
  assert.equal(publicationOf(id)?.id, one.id)
  const materials = listMaterials(two.id)
  assert.equal(materials.length, 1)
  assert.notEqual(materials[0].hash, before, 'the old notebook is still served')
  // One step stays for a rollback to 0.12: the first notebook, at seq 0.
  assert.deepEqual(stepHeadings(two.id).map((h) => h.seq), [0])
  assert.ok(readStep(two.id, null)?.cells[0].source.startsWith('# Новое'))
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
  const pub = publishCells(id, 'Снятая', pageOfDoc(doc, newBlobBag()), undefined, null)
  setPublicationState(pub.id, 'withdrawn')
  const back = publicationOf(id)
  assert.equal(back?.state, 'withdrawn')
  assert.equal(back?.id, pub.id, 'withdrawal changed the address')
  // The materials stay in place: bringing the page back is one press, not a new publication.
  assert.equal(listMaterials(pub.id).length, 1)
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

test('a tombstone carries a link to the remaining reading, and the row keeps its day and title', () => {
  /*
   * "Delete the seminar, keep the reading" is the default, and without this link
   * the course row becomes a dead end: the page is alive and opens at its direct
   * address, while the course is the only address the class is given at all.
   */
  const id = 'pub-tomb'
  const doc = taught(id)
  const pub = publishCells(id, 'Деревья и леса', pageOfDoc(doc, newBlobBag()))
  const course = createCourse('Курс с надгробием', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    {
      kind: 'seminar',
      id: 'rtomb001',
      sessionId: id,
      name: 'Деревья и леса',
      title: 'Деревья решений',
      day: '2026-09-13',
      about: 'Как растут деревья',
      when: 'вс, 13 сен',
      publication: null,
    },
  ])
  // Exactly the order in which the seminar deletion does it.
  orphanPublication(id)
  entombSeminar(id, 'Деревья и леса')

  const row = getCourse(course.id)!.items[0]
  assert.equal(row.kind, 'gone')
  assert.equal(row.kind === 'gone' && row.publication?.id, pub.id)
  assert.deepEqual(
    [row.id, row.title, row.day, row.about, row.when],
    ['rtomb001', 'Деревья решений', '2026-09-13', 'Как растут деревья', 'вс, 13 сен'],
  )
  // The page is alive meanwhile: there is now a way to withdraw it, by its own address.
  assert.equal(getPublication(pub.id)?.sessionId, null)

  // Erased for good, the tombstone loses the link and keeps the rest.
  deletePublication(pub.id)
  const after = getCourse(course.id)!.items[0]
  assert.equal(after.kind === 'gone' && after.publication, null)
  assert.equal(after.day, '2026-09-13')
})

test('a tombstone is not lost to a course saved in the same moment', (t) => {
  /*
   * entombSeminar used to try the compare-and-swap once and ignore a loss: a
   * teacher saving the course in that second kept a row pointing at a deleted
   * room. Here the first write of the course is made to lose, the way a
   * concurrent save would make it lose, and the tombstone must still land.
   */
  const id = 'pub-tomb-race'
  createSession(id, 'Гонка', null)
  const course = createCourse('Курс с гонкой', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Гонка', publication: null },
  ])
  db.exec(`
    CREATE TEMP TABLE race_once (n INTEGER);
    INSERT INTO race_once VALUES (1);
    CREATE TEMP TRIGGER race_tomb BEFORE UPDATE OF items ON courses
    WHEN (SELECT n FROM race_once) > 0
    BEGIN
      UPDATE race_once SET n = n - 1;
      SELECT RAISE(IGNORE);
    END;
  `)
  t.after(() => db.exec('DROP TRIGGER IF EXISTS race_tomb; DROP TABLE IF EXISTS race_once;'))
  entombSeminar(id, 'Гонка')
  const left = db.prepare('SELECT n FROM race_once').get() as { n: number }
  assert.equal(left.n, 0, 'the first write was not made to lose; the test proves nothing')
  assert.equal(getCourse(course.id)!.items[0].kind, 'gone', 'the tombstone was lost to the race')
})

test('a former name in the address leads where it used to', () => {
  /*
   * A course name is said out loud and written on the board, and then changed,
   * and the link the class has already saved has to keep working.
   */
  const id = 'pub-renamed'
  const doc = taught(id)
  const pub = publishCells(id, 'Переименование', pageOfDoc(doc, newBlobBag()))
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

  // A course can take back its own former name.
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
   * the instance origin, with the cookies of whoever opened the link. So a
   * note's SVG keeps its type (an `<img>` draws it) but goes out as a
   * sandboxed attachment: followed directly, it downloads instead of opening.
   */
  const id = 'pub-blob-mime'
  createSession(id, 'Блобы', null)
  const pub = writePublication({
    sessionId: id,
    title: 'Блобы',
    by: null,
    materials: [],
    blobs: [
      { hash: 'a'.repeat(32), mime: 'image/png', body: Buffer.from([137, 80, 78, 71]) },
      { hash: 'b'.repeat(32), mime: 'image/svg+xml', body: Buffer.from('<svg><script/></svg>') },
    ],
  })
  assert.ok(readBlob(pub.id, 'a'.repeat(32)))

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
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
  assert.match(svg.headers.get('content-disposition') ?? '', /^attachment/)
  assert.match(svg.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff')
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('a page without a room can be withdrawn by its own address', async () => {
  /*
   * Deleting a seminar keeps the reading and clears `session_id` — and the routes
   * keyed by the room id answer 404 forever. The page is still alive and
   * served: there was no way to withdraw it, and someone else's personal
   * output could remain on it.
   */
  const id = 'pub-orphan-route'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = publishCells(id, 'Осиротевшая', pageOfDoc(doc, bag), bag, null)
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
  const pub = publishCells(id, 'Прежний адрес', pageOfDoc(doc, bag), bag, null)
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
  const seen2 = (await page.json()) as { page: { id: string; slug: string; address: string } }
  assert.equal(seen2.page.id, pub.id)
  assert.equal(seen2.page.slug, 'lekciya-01-final')
  assert.equal(seen2.page.address, 'lekciya-01-final')
  // And deeper: the old notebook link, by the same former address, leads to the
  // download, with its outputs.
  const notebook = await get('/api/p/lekciya-01/notebook.ipynb')
  assert.equal(notebook.status, 200)
  const file = (await notebook.json()) as { cells: { outputs?: unknown[] }[] }
  assert.ok(file.cells.some((c) => (c.outputs ?? []).length > 0), 'the download lost its outputs')

  setPublicationState(pub.id, 'withdrawn')
  const withdrawn = await get('/api/p/lekciya-01')
  assert.equal(withdrawn.status, 200, 'a withdrawn page at a former address answers "no such page"')
  const state = (await withdrawn.json()) as { page: { state: string; materials: unknown[] } }
  assert.equal(state.page.state, 'withdrawn')
  assert.deepEqual(state.page.materials, [])

  deletePublication(pub.id)
  assert.equal((await get('/api/p/lekciya-01')).status, 404, 'the address of an erased page is not forgotten')
  deleteCourse(course.id)
  assert.equal((await get('/api/c/stat-vesna')).status, 404, 'the address of a deleted course is not forgotten')
  doc.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
