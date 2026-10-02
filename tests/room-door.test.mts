/**
 * The way from a class page back into its room, and who gets it.
 *
 * Two objects since pages exist: the publication, which anyone with the link
 * reads and forwards, and the room, which keeps the marks and the oracle
 * thread with every asker's name, and whose eight characters are the right to
 * write in it. The page JSON never names the room. The door is a separate
 * POST that answers with the room's address only to staff, to everyone when
 * the teacher chose «Все», or to a browser that proves it was there with a
 * token minted for THAT room, of a participant who is not banned.
 *
 * Driven through the real app (server/src/app.ts), so the door stands behind
 * the same JSON parsing, origin check and staff cookie as in the product.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { addBook } from '../shared/notebook.js'
import { MAX_DOOR_TOKENS, type RoomDoor } from '../shared/publish.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { app } from '../server/src/app.js'
import { signToken } from '../server/src/auth.js'
import { banParticipant } from '../server/src/bans.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { createSession, db, setFinished, upsertParticipant } from '../server/src/db.js'
import { buildAndWrite, publishInfo, refreshPage } from '../server/src/publish/materials.js'
import {
  createCourse,
  getPublication,
  orphanPublication,
  setCourseItems,
  setCourseSlug,
  setPublicationState,
  writePublication,
} from '../server/src/publish/store.js'
import { forgetCourseIndex } from '../server/src/routes/course-view.js'

/* Distinctive ids, so "the id is in the body" cannot match anything else. */
const ROOM = 'rdq7m2xk'
const SEATED = 'rdw4n8pz'
const OTHER = 'rdh3v6cs'
const GONE = 'rdj9t5bf'

let base = ''
let server: http.Server
let pubId = ''
let courseId = ''
let staffCookie = ''

const token = (sessionId: string, participantId: string) =>
  signToken({ sessionId, participantId, role: 'participant' })

function seat(sessionId: string, id: string, name: string): void {
  upsertParticipant({ id, sessionId, name, avatar: null, role: 'participant' })
}

async function publish(sessionId: string): Promise<string> {
  const root = addBook(getSessionDoc(sessionId).doc, 'seminar.ipynb').root
  const built = await buildAndWrite(
    sessionId,
    { notebooks: [{ root, name: 'Семинар' }], files: [], autoRefresh: true, ack: [] },
    { by: null },
  )
  assert.ok(built.ok, JSON.stringify(built))
  return built.publication.id
}

before(async () => {
  createSession(ROOM, 'Лики и хаки данных', null)
  createSession(SEATED, 'Пайплайны', null)
  createSession(OTHER, 'Чужая комната', null)
  seat(ROOM, 'p_ann', 'Аня')
  seat(ROOM, 'p_bob', 'Боря')
  seat(SEATED, 'p_ann2', 'Аня')
  seat(OTHER, 'p_eve', 'Ева')

  const course = createCourse('МЛ | сильная группа', null, null)
  courseId = course.id
  assert.equal(setCourseSlug(course.id, 'rd-ml'), 'ok')
  const row = (id: string, sessionId: string, day: string) =>
    ({ kind: 'seminar', id, sessionId, name: id, publication: null, day }) as const
  setCourseItems(course.id, course.rev, [
    row('rrd00001', ROOM, '2026-10-04'),
    row('rrd00002', SEATED, '2026-10-11'),
    { kind: 'planned', id: 'rrd00003', name: 'Ансамбли', when: '', day: '2026-10-18' },
  ])
  forgetCourseIndex()
  pubId = await publish(ROOM)

  const teacher = createTeacher({ name: 'Ада', email: 'ada.roomdoor@test.local', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse
  issueStaffCookie(res, teacher)
  staffCookie = `${STAFF_COOKIE}=${value}`

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

async function knock(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; door: RoomDoor }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let door = null as unknown as RoomDoor
  try {
    door = JSON.parse(text) as RoomDoor
  } catch {
    /* a refusal page */
  }
  return { status: res.status, text, door }
}

const pageDoor = (tokens: string[], headers: Record<string, string> = {}) =>
  knock(`/api/p/${pubId}/room`, { tokens }, headers)

async function setAccess(access: string, cookie = staffCookie): Promise<number> {
  const res = await fetch(`${base}/api/admin/publications/${pubId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ roomAccess: access }),
  })
  return res.status
}

/* ------------------------------------------------- nothing public names it */

test('the course and the page never carry a room id, nor a room path', async () => {
  for (const path of ['/api/c/rd-ml', `/api/c/${courseId}`, `/api/p/${pubId}`, '/api/p/rd-ml-01']) {
    const res = await fetch(`${base}${path}`)
    assert.equal(res.status, 200, path)
    const text = await res.text()
    for (const id of [ROOM, SEATED, OTHER]) assert.ok(!text.includes(id), `${path} carries ${id}`)
    assert.ok(!text.includes('/s/'), `${path} carries a room path`)
    assert.doesNotMatch(text, /roomAccess|sessionId/, `${path} talks about the room`)
  }
})

test('a stranger is told the room is for participants, and nothing more', async () => {
  const { status, text, door } = await pageDoor([])
  assert.equal(status, 200)
  assert.deepEqual(door, { access: 'members', member: false, staff: false, room: null })
  assert.ok(!text.includes(ROOM))
  // No body at all reads the same as an empty list.
  const bare = await knock(`/api/p/${pubId}/room`, {})
  assert.deepEqual(bare.door, door)
})

/* --------------------------------------------------------- the members */

test('a token of this room opens it, and says whether the class is still on', async () => {
  const { door } = await pageDoor([token(OTHER, 'p_eve'), token(ROOM, 'p_ann')])
  assert.deepEqual(door, {
    access: 'members',
    member: true,
    staff: false,
    room: { path: `/s/${ROOM}`, live: true },
  })

  setFinished(ROOM, Date.now())
  try {
    assert.equal((await pageDoor([token(ROOM, 'p_ann')])).door.room?.live, false)
  } finally {
    setFinished(ROOM, null)
  }

  // An archived seminar is not «on» either: nobody intends to work in it.
  db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(Date.now(), ROOM)
  try {
    assert.equal((await pageDoor([token(ROOM, 'p_ann')])).door.room?.live, false)
  } finally {
    db.prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run(ROOM)
  }
})

test('a token of another room, a forged one, or one for nobody in the room does not', async () => {
  const forged = token(ROOM, 'p_ann').replace(/\.[^.]+$/, `.${'A'.repeat(43)}`)
  for (const tokens of [
    [token(OTHER, 'p_eve')],
    [forged],
    [token(ROOM, 'p_nobody')],
    ['not a token at all'],
  ]) {
    const { status, text, door } = await pageDoor(tokens)
    assert.equal(status, 200)
    assert.equal(door.member, false, tokens[0])
    assert.equal(door.room, null, tokens[0])
    assert.ok(!text.includes(ROOM), 'the refusal names the room')
  }
})

test('a banned participant does not get in, and a classmate still does', async () => {
  const ban = banParticipant({ sessionId: ROOM, participantId: 'p_bob', ip: null, byTeacher: 'А' })
  assert.ok(ban)
  const banned = await pageDoor([token(ROOM, 'p_bob')])
  assert.deepEqual([banned.door.member, banned.door.room], [false, null])
  assert.ok(!banned.text.includes(ROOM))
  assert.equal((await pageDoor([token(ROOM, 'p_ann')])).door.member, true)
})

/* ----------------------------------------------------- staff and the setting */

test('staff always see the way in, whatever the setting', async () => {
  for (const access of ['members', 'none', 'anyone']) {
    assert.equal(await setAccess(access), 200)
    const { door } = await pageDoor([], { cookie: staffCookie })
    assert.deepEqual(door, {
      access,
      member: false,
      staff: true,
      room: { path: `/s/${ROOM}`, live: true },
    })
  }
  assert.equal(await setAccess('members'), 200)
})

test('«Все» opens it to anyone with the page; «Никто» closes it to members too', async () => {
  assert.equal(await setAccess('anyone'), 200)
  const open = await pageDoor([])
  assert.deepEqual(open.door, {
    access: 'anyone',
    member: false,
    staff: false,
    room: { path: `/s/${ROOM}`, live: true },
  })

  assert.equal(await setAccess('none'), 200)
  const closed = await pageDoor([token(ROOM, 'p_ann')])
  assert.equal(closed.door.access, 'none')
  assert.equal(closed.door.room, null)
  assert.ok(!closed.text.includes(ROOM))

  assert.equal(await setAccess('members'), 200)
})

test('saving the setting rebuilds nothing, and a rebuild keeps it', async () => {
  const before = getPublication(pubId)!
  assert.equal(await setAccess('anyone'), 200)
  const after = getPublication(pubId)!
  assert.equal(after.revision, before.revision, 'the setting bumped the revision')
  assert.equal(after.publishedAt, before.publishedAt, 'the setting counted as a publish')
  assert.equal(after.materialsRev, before.materialsRev, 'every cached tab was invalidated')
  assert.equal(after.selection?.roomAccess, 'anyone')
  assert.equal(publishInfo(ROOM)?.roomAccess, 'anyone')

  const refreshed = await refreshPage(ROOM, { by: null })
  assert.ok(refreshed.ok, JSON.stringify(refreshed))
  assert.equal(getPublication(pubId)!.selection?.roomAccess, 'anyone', 'a refresh forgot the door')

  // A publish from the screen that does not mention it keeps it too.
  const root = getPublication(pubId)!.selection!.notebooks[0].root
  const rebuilt = await buildAndWrite(
    ROOM,
    { notebooks: [{ root, name: 'Семинар' }], files: [], autoRefresh: true, ack: [] },
    { by: null },
  )
  assert.ok(rebuilt.ok)
  assert.equal(getPublication(pubId)!.selection?.roomAccess, 'anyone')
  assert.equal(await setAccess('members'), 200)
})

test('the setting is staff-only, checked, and needs a saved pick', async () => {
  assert.equal(await setAccess('anyone', ''), 401)
  assert.equal(await setAccess('everybody'), 400)
  const missing = await fetch(`${base}/api/admin/publications/nosuchpg`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: staffCookie },
    body: JSON.stringify({ roomAccess: 'none' }),
  })
  assert.equal(missing.status, 404)

  // A page carried over from 0.12 has no pick to keep the setting in.
  createSession('rdlegacy', 'Старая страница', null)
  const legacy = writePublication({
    sessionId: 'rdlegacy',
    title: 'Старая',
    by: null,
    materials: [],
    blobs: [],
  })
  const refused = await fetch(`${base}/api/admin/publications/${legacy.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: staffCookie },
    body: JSON.stringify({ roomAccess: 'anyone' }),
  })
  assert.equal(refused.status, 409)
  assert.equal(getPublication(legacy.id)!.selection, null)
  // And it reads as 'members': a stranger gets the locked sentence, not the room.
  const door = await knock(`/api/p/${legacy.id}/room`, { tokens: [] })
  assert.deepEqual(door.door, { access: 'members', member: false, staff: false, room: null })
})

/* ------------------------------------------------------ nothing to lead to */

test('a withdrawn page leads nowhere, for staff as well', async () => {
  setPublicationState(pubId, 'withdrawn')
  try {
    for (const headers of [{}, { cookie: staffCookie }]) {
      const { status, text, door } = await pageDoor([token(ROOM, 'p_ann')], headers)
      assert.equal(status, 200)
      assert.equal(door.access, 'none')
      assert.equal(door.room, null)
      assert.ok(!text.includes(ROOM))
    }
  } finally {
    setPublicationState(pubId, 'published')
  }
})

test('a page whose room was deleted leads nowhere', async () => {
  createSession(GONE, 'Удалённая', null)
  seat(GONE, 'p_gil', 'Гиля')
  const gonePage = await publish(GONE)
  const before = await knock(`/api/p/${gonePage}/room`, { tokens: [token(GONE, 'p_gil')] })
  assert.equal(before.door.room?.path, `/s/${GONE}`)

  orphanPublication(GONE)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(GONE)
  for (const headers of [{}, { cookie: staffCookie }]) {
    const tokens = [token(GONE, 'p_gil')]
    const after = await knock(`/api/p/${gonePage}/room`, { tokens }, headers)
    assert.equal(after.status, 200)
    assert.equal(after.door.access, 'none')
    assert.equal(after.door.room, null)
    assert.ok(!after.text.includes(GONE))
  }

  const unknown = await knock('/api/p/no-such-page/room', { tokens: [] })
  assert.equal(unknown.status, 404)
})

/* ---------------------------------------------------------- the course row */

test('a course row opens its seated room before any page exists', async () => {
  const path = '/api/c/rd-ml/room'
  const stranger = await knock(path, { key: 'rrd00002', tokens: [] })
  assert.equal(stranger.status, 200)
  assert.deepEqual(stranger.door, { access: 'members', member: false, staff: false, room: null })
  assert.ok(!stranger.text.includes(SEATED))

  const member = await knock(path, { key: 'rrd00002', tokens: [token(SEATED, 'p_ann2')] })
  assert.deepEqual(member.door.room, { path: `/s/${SEATED}`, live: true })
  // A token of the neighbouring row's room is not one of this row's.
  const neighbour = await knock(path, { key: 'rrd00002', tokens: [token(ROOM, 'p_ann')] })
  assert.equal(neighbour.door.room, null)

  setFinished(SEATED, Date.now())
  try {
    const ended = await knock(path, { key: 'rrd00002', tokens: [token(SEATED, 'p_ann2')] })
    assert.equal(ended.door.room?.live, false)
  } finally {
    setFinished(SEATED, null)
  }

  const staff = await knock(path, { key: 'rrd00002', tokens: [] }, { cookie: staffCookie })
  assert.equal(staff.door.room?.path, `/s/${SEATED}`)
})

test('a course row with a page follows the page\'s setting; a plan row has no room', async () => {
  const path = `/api/c/${courseId}/room`
  assert.equal((await knock(path, { key: 'rrd00001', tokens: [] })).door.room, null)
  assert.equal(await setAccess('anyone'), 200)
  try {
    assert.equal((await knock(path, { key: 'rrd00001', tokens: [] })).door.room?.path, `/s/${ROOM}`)
  } finally {
    assert.equal(await setAccess('members'), 200)
  }

  const plan = await knock(path, { key: 'rrd00003', tokens: [] }, { cookie: staffCookie })
  assert.deepEqual(plan.door, { access: 'none', member: false, staff: true, room: null })

  assert.equal((await knock(path, { key: 'nope', tokens: [] })).status, 404)
  assert.equal((await knock(path, { tokens: [] })).status, 404)
  const noCourse = await knock('/api/c/no-such-course/room', { key: 'rrd00001', tokens: [] })
  assert.equal(noCourse.status, 404)
})

/* ---------------------------------------------------------- the ceilings */

test('the door refuses oversized requests and foreign pages', async () => {
  const many = Array.from({ length: MAX_DOOR_TOKENS + 1 }, () => token(ROOM, 'p_ann'))
  assert.equal((await pageDoor(many)).status, 400)
  assert.equal((await pageDoor(['x'.repeat(2049)])).status, 400)
  assert.equal((await knock(`/api/p/${pubId}/room`, { tokens: 'abc' })).status, 400)
  assert.equal((await knock(`/api/p/${pubId}/room`, { tokens: [42] })).status, 400)
  // Exactly the cap is fine, and the member's token still counts at the end of it.
  const others = Array.from({ length: MAX_DOOR_TOKENS - 1 }, () => token(OTHER, 'p_eve'))
  const full = [...others, token(ROOM, 'p_ann')]
  assert.equal((await pageDoor(full)).door.member, true)

  // A public write like any other: a foreign page cannot ask on someone's behalf.
  const foreign = await pageDoor([token(ROOM, 'p_ann')], { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  assert.ok(!foreign.text.includes(ROOM))

  const res = await fetch(`${base}/api/p/${pubId}/room`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tokens: [] }),
  })
  assert.equal(res.headers.get('cache-control'), 'no-store', 'one browser\'s answer is cached')
})

test('one address cannot knock without end', async () => {
  let refused = 0
  for (let i = 0; i < 140 && refused === 0; i++) {
    const { status } = await pageDoor([])
    if (status === 429) refused++
  }
  assert.equal(refused, 1, 'a loop knocked 140 times in a row')
  const after = await knock('/api/c/rd-ml/room', { key: 'rrd00002', tokens: [] })
  assert.equal(after.status, 429, 'the course door does not share the ceiling')
})
