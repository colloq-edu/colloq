/**
 * What exactly a deleted seminar takes away with it.
 *
 * The cascade was checked only from the client side — that the button calls
 * that URL — while the order of the steps was copied by hand into
 * persistence.test ("Exactly what the delete route does, in its order"). So
 * the route could be reordered — tearing down the document AFTER tearing down
 * the snapshot — and the room came back to life after a restart with a green
 * suite.
 *
 * This checks the route itself: the rows, the files, the history, the
 * tombstone in the course and the fate of the published page — and that no
 * snapshot reappears after the response.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { createCell, getCells } from '../shared/notebook.js'
import {
  createSession,
  getSession,
  listParticipants,
  loadDocSnapshot,
  upsertParticipant,
  versionCount,
} from '../server/src/db.js'
import { getSessionDoc, peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { flushPersistence } from '../server/src/collab/persistence.js'
import {
  createCourse,
  getCourse,
  getPublication,
  publicationOf,
  setCourseItems,
  writePublication,
} from '../server/src/publish/store.js'
import { adminInstanceRoutes } from '../server/src/routes/admin-instance.js'
import { sessionDir, workspaceFs } from '../server/src/workspace.js'

let base = ''
let server: http.Server
let cookie = ''

before(async () => {
  const owner = createTeacher({ name: 'Ада', email: 'ada.delete@test.local', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, owner)
  cookie = `${STAFF_COOKIE}=${value}`

  const app = express()
  app.use(express.json())
  app.use(adminInstanceRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** A seminar with all that trails it: a person, a file, a notebook, history, a page. */
function seminarWithEverything(id: string, name: string): void {
  createSession(id, name, 'base')
  upsertParticipant({ id: 'p_1', sessionId: id, name: 'Нина', avatar: null, role: 'participant' })
  fs.writeFileSync(path.join(sessionDir(id), 'handout.csv'), 'a,b\n1,2\n')
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    getCells(doc).push([createCell('code', 'print(1)')])
  })
  flushPersistence(id)
  writePublication({
    sessionId: id,
    title: name,
    by: 'Ада',
    steps: [{ seq: 0, label: 'Тетрадь', at: Date.now(), cells: [] }],
    blobs: [],
  })
}

const remove = (id: string, query = '') =>
  fetch(`${base}/api/admin/seminars/${id}${query}`, { method: 'DELETE', headers: { cookie } })

test('deletion takes the rows, the files and the history, but leaves the reading', async () => {
  const id = 'delete-keep'
  seminarWithEverything(id, 'Четвёртая неделя')
  const pub = publicationOf(id)
  assert.ok(pub)
  // And a course it belongs to: a tombstone has to remain in its place.
  const course = createCourse('Матстат', null, 'Ада')
  assert.ok(setCourseItems(course.id, course.rev, [{ kind: 'seminar', sessionId: id, name: 'Четвёртая неделя', publication: null }]))

  assert.ok(loadDocSnapshot(id), 'there was no snapshot: nothing to check')
  assert.ok(versionCount(id) > 0, 'there was no history: nothing to check')

  const res = await remove(id)
  assert.equal(res.status, 204)

  assert.equal(getSession(id), null, 'the seminar row survived the deletion')
  assert.deepEqual(listParticipants(id), [])
  assert.equal(loadDocSnapshot(id), null, 'the notebook snapshot was left behind')
  assert.equal(versionCount(id), 0, 'the history remained, and the whole notebook is in it')
  // Not `sessionDir`: it creates the folder if it is missing, so we build the path ourselves.
  assert.equal(
    fs.existsSync(path.join(process.env.WORKSPACE_DIR ?? '', id, 'handout.csv')),
    false,
    'the room files stayed on disk',
  )
  assert.equal(peekSessionDoc(id), null, 'the room document stayed in memory')

  // The page lives on, but without the room: the link cannot be taken back from the students.
  const after = getPublication(pub.id)
  assert.ok(after, 'the reading was erased together with the room')
  assert.equal(after.sessionId, null, 'the page still clings to the demolished room')

  // And in the course, a tombstone linking to this reading rather than a missing week.
  const now = getCourse(course.id)
  assert.ok(now)
  const [row] = now.items
  assert.equal(row?.kind, 'gone')
  assert.equal(row?.kind === 'gone' ? row.name : '', 'Четвёртая неделя')
  assert.equal(row?.kind === 'gone' ? row.publication?.id : null, pub.id)
})

test('the snapshot does not come back after the response', async () => {
  /*
   * That very order: the sockets are closed and the document evicted BEFORE the
   * rows are torn down, and the kernel is shut down afterwards — and whatever
   * could come back to life while it was shutting down is torn down by a second
   * pass. If the snapshot is written after the rows are deleted, the room
   * returns on the next server restart — with a roster that no longer exists.
   */
  const id = 'delete-snapshot'
  seminarWithEverything(id, 'Пятая неделя')
  assert.equal((await remove(id)).status, 204)

  // Half a second is longer than the snapshot debounce (persistence.ts).
  await new Promise<void>((resolve) => setTimeout(resolve, 500))
  assert.equal(loadDocSnapshot(id), null, 'a snapshot of the deleted room appeared again')
  assert.equal(versionCount(id), 0, 'the feed of the deleted room got written to after the response')
})

test('"delete with the reading" erases the page for good', async () => {
  const id = 'delete-drop'
  seminarWithEverything(id, 'Шестая неделя')
  const pub = publicationOf(id)
  assert.ok(pub)

  assert.equal((await remove(id, '?reading=drop')).status, 204)
  assert.equal(getPublication(pub.id), null, 'the page survived "delete with the reading"')
})

test('the owner deletes, and only the owner', async () => {
  const id = 'delete-teacher'
  seminarWithEverything(id, 'Седьмая неделя')
  const teacher = createTeacher({ name: 'Нина', email: 'nina.delete@test.local', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie(
    { cookie: (_n: string, v: string) => (value = v) } as unknown as Response,
    teacher,
  )

  const res = await fetch(`${base}/api/admin/seminars/${id}`, {
    method: 'DELETE',
    headers: { cookie: `${STAFF_COOKIE}=${value}` },
  })
  assert.equal(res.status, 403)
  assert.ok(getSession(id), 'someone other than the owner deleted the seminar')
})

test('no seminar: a 404, not a cheerful "deleted"', async () => {
  const res = await remove('no-such-seminar')
  assert.equal(res.status, 404)
})

test('failed runtime termination keeps seminar, files, snapshot and publication for a retry', async () => {
  const id = 'delete-broker-failure'
  seminarWithEverything(id, 'Do not lose work')
  const pub = publicationOf(id)!
  const snapshot = loadDocSnapshot(id)
  const old = {...process.env}
  const tokenFile = path.join(process.env.DATA_DIR!, 'deletion-runtime-token')
  fs.writeFileSync(tokenFile, 't'.repeat(64))
  let fail = true
  const methods: string[] = []
  const broker = http.createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`)
    res.writeHead(fail ? 503 : 200, {'content-type':'application/json'})
    res.end(JSON.stringify(fail ? {error:'Kubernetes unavailable'} : {ok:true}))
  })
  await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve))
  Object.assign(process.env, {KERNEL_BACKEND:'broker', KERNEL_ISOLATION:'required', KERNEL_RUNTIME_TOKEN_FILE:tokenFile,
    KERNEL_RUNTIME_URL:`http://127.0.0.1:${(broker.address() as {port:number}).port}`})
  try {
    assert.equal((await remove(id, '?reading=drop')).status, 503)
    assert.ok(getSession(id))
    assert.deepEqual(loadDocSnapshot(id), snapshot)
    assert.ok(versionCount(id) > 0)
    assert.ok(getPublication(pub.id))
    assert.equal(fs.readFileSync(path.join(sessionDir(id),'handout.csv'),'utf8'),'a,b\n1,2\n')
    fail = false
    assert.equal((await remove(id, '?reading=drop')).status, 204)
    assert.equal(getSession(id), null)
    assert.equal(getPublication(pub.id), null)
    assert.deepEqual(methods, [`DELETE /v1/rooms/${id}?retire=true`,`DELETE /v1/rooms/${id}?retire=true`])
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
    Object.assign(process.env,old)
    await new Promise<void>(resolve => broker.close(() => resolve()))
  }
})


test('incomplete filesystem cleanup retains database tracking and reports failure until retry', async (t) => {
  const id = 'delete-files-failure'
  seminarWithEverything(id, 'Retry cleanup')
  const publication = publicationOf(id)!
  const removal = t.mock.method(workspaceFs, 'rmSync', () => { throw new Error('simulated filesystem I/O failure') })
  assert.equal((await remove(id, '?reading=drop')).status, 503)
  assert.ok(getSession(id), 'failed cleanup must retain a row that can be retried')
  assert.ok(getPublication(publication.id))
  assert.ok(fs.existsSync(path.join(sessionDir(id), 'handout.csv')))
  removal.mock.restore()
  assert.equal((await remove(id, '?reading=drop')).status, 204)
  assert.equal(getSession(id), null)
  assert.equal(getPublication(publication.id), null)
})
