/**
 * The hint on the join screen: it leads to the address that was dictated to
 * the class.
 *
 * The link a student really has is `/s/<room>`, and a week later they type
 * their name through it into a finished class. So the join screen shows the
 * published version and the course — and its page address is `/p/<slug>`, not
 * `/p/<id>`: it was given a name precisely so that the name could be said out
 * loud. While the server sent only the id, the hint led the class to the
 * fallback entrance.
 *
 * Next to it is the cost of this answer. The course was found by going through
 * ALL courses of the semester, parsing each one's item list from JSON, and
 * this was done on every join and every page reload: up to five hundred times
 * in the first minute of class.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from '../shared/protocol.js'
import { publicationAddress } from '../shared/publish.js'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import {
  createCourse,
  setCourseItems,
  setPublicationSlug,
  writePublication,
} from '../server/src/publish/store.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

const ROOM = 'join-hint-room'
const LONELY = 'join-hint-lonely'
let base = ''
let server: http.Server
let pubId = ''

before(async () => {
  createSession(ROOM, 'Неделя 4', null)
  createSession(LONELY, 'Никем не изданная', null)
  pubId = writePublication({
    sessionId: ROOM,
    title: 'Неделя 4',
    by: 'Ада',
    steps: [{ seq: 0, label: 'разбор', at: Date.now(), cells: [] }],
    blobs: [],
  }).id
  assert.equal(setPublicationSlug(pubId, 'week-4'), 'ok')

  const course = createCourse('Машинное обучение', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'planned', name: 'Неделя 5', when: 'через неделю' },
    { kind: 'seminar', sessionId: ROOM, name: 'Неделя 4', publication: null },
  ])

  const app = express()
  app.use(express.json())
  app.use(sessionRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

const info = async (id: string): Promise<SessionInfo> =>
  (await (await fetch(`${base}/api/sessions/${id}`)).json()) as SessionInfo

test('the hint names the page address, not the fallback entrance by id', async () => {
  const body = await info(ROOM)
  assert.equal(body.published?.id, pubId)
  assert.equal(body.published?.slug, 'week-4', 'the hint leads the class to /p/<id> again')
  // One function builds the address for the whole product — and with this
  // field it has something to build it from.
  assert.equal(publicationAddress({ id: pubId, slug: body.published?.slug ?? null }), 'week-4')
  assert.equal(body.course?.name, 'Машинное обучение', 'the way up from the join screen is gone')
})

test('a room without a publication promises nothing', async () => {
  const body = await info(LONELY)
  assert.equal(body.published, null)
  assert.equal(body.course, null)
})
