/**
 * A taken address: who holds it and how to release it.
 *
 * "Address 'ml-2025' is already taken" is a dead end, and most often an
 * implausible one: there is no course with that address in the list. It is
 * held by the FORMER name of another course — that one was renamed to
 * "ml-2025-fall", and the old name stayed an address for the sake of the link
 * handed out to the class — and there is nowhere in the panel to see it. A
 * teacher preparing next year's course searches for what cannot be seen and
 * ends up with an address with a digit at the end.
 *
 * The refusal now names the holder, and the owner can release a former name
 * themselves. The price is said out loud and stays a price: a released address
 * stops leading anywhere, and that is the owner's decision.
 *
 * The holder is checked along the same path by which it reaches the screen:
 * the 409 body → `addressHolderOf` → the "Release former address" button. The
 * panel reads the field, not the phrase, so the phrase and the field are
 * checked separately.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { createCourse, findCourse, formerSlugs } from '../server/src/publish/store.js'
import { AdminApiError, addressHolderOf } from '../web/src/lib/adminApi.js'

let base = ''
let server: http.Server
let cookie = ''

function cookieFor(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  const teacher = createTeacher({ name: 'Ада', email: 'ada.addr@test.local', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  cookie = cookieFor(teacher)

  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

interface Refusal {
  status: number
  error: string
  body: unknown
}

async function setSlug(id: string, slug: string): Promise<Refusal> {
  const res = await fetch(`${base}/api/admin/slug/course/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ slug }),
  })
  const body = (await res.json()) as { error?: string }
  return { status: res.status, error: body.error ?? '', body }
}

/** The same path as in the panel: refusal body → holder → a button or silence. */
const seenByPanel = (taken: Refusal) =>
  addressHolderOf(new AdminApiError(taken.error, taken.status, 'invalid', taken.body))

async function release(id: string, slug: string): Promise<number> {
  const res = await fetch(`${base}/api/admin/slug/course/${id}/former/${slug}`, {
    method: 'DELETE',
    headers: { cookie },
  })
  return res.status
}

test('a live address is taken: the refusal names the course', async () => {
  const mine = createCourse('Матстат', null, 'Ада')
  const other = createCourse('Матстат для физиков', null, 'Ада')
  assert.equal((await setSlug(mine.id, 'matstat')).status, 200)

  const taken = await setSlug(other.id, 'matstat')
  assert.equal(taken.status, 409)
  assert.equal(taken.error, 'Адрес «matstat» занят курсом «Матстат».')
  // Another course's live address is not released from here: there must be no
  // button, but the holder is named anyway — so there is someone to go to.
  assert.deepEqual(seenByPanel(taken), {
    kind: 'course',
    id: mine.id,
    name: 'Матстат',
    former: false,
  })
})

test('a former name holds the address, and the refusal says what to do about it', async () => {
  const course = createCourse('ML 2025', null, 'Ада')
  const next = createCourse('ML 2026', null, 'Ада')
  assert.equal((await setSlug(course.id, 'ml-2025')).status, 200)
  // A rename does not cancel a link already handed out: the old name stays an address.
  assert.equal((await setSlug(course.id, 'ml-2025-fall')).status, 200)
  assert.deepEqual(formerSlugs('course', course.id), ['ml-2025'])

  const taken = await setSlug(next.id, 'ml-2025')
  assert.equal(taken.status, 409)
  assert.equal(
    taken.error,
    'Адрес «ml-2025» — прежнее имя курса «ML 2025».',
    'the refusal again does not name the holder: there is nowhere to look for it',
  )
  // The release happens at the same address field, and advice to go into someone
  // else's settings would be a lie two centimetres from the button that does it right here.
  assert.doesNotMatch(taken.error, /настройк/)

  // The panel shows the "Release former address" button by the field, not by the
  // phrase, and calls the route with the HOLDER's id, not the requester's.
  assert.deepEqual(seenByPanel(taken), {
    kind: 'course',
    id: course.id,
    name: 'ML 2025',
    former: true,
  })
})

test('the panel sees the course former names, otherwise there is nothing to release', async () => {
  const course = createCourse('Алгоритмы', null, 'Ада')
  assert.equal((await setSlug(course.id, 'algo-2025')).status, 200)
  assert.equal((await setSlug(course.id, 'algo-2026')).status, 200)

  const res = await fetch(`${base}/api/admin/courses/${course.id}`, { headers: { cookie } })
  const body = (await res.json()) as { course: { slug: string | null; former?: string[] } }
  assert.equal(body.course.slug, 'algo-2026')
  // A course shows its former names itself: without this list the owner would not
  // see that "algo-2025" is still taken by that very course, and would have nothing to release.
  assert.deepEqual(body.course.former, ['algo-2025'])
})

test('a former name is released by its owner, and only their own', async () => {
  const course = createCourse('Линал', null, 'Ада')
  const stranger = createCourse('Линал у соседей', null, 'Ада')
  assert.equal((await setSlug(course.id, 'linal-2025')).status, 200)
  assert.equal((await setSlug(course.id, 'linal-2026')).status, 200)

  assert.equal(
    await release(stranger.id, 'linal-2025'),
    404,
    'a former name was released by someone who does not own it',
  )
  assert.equal(await release(course.id, 'linal-2026'), 404, 'a LIVE name was released instead of a former one')
  assert.ok(findCourse('linal-2025'), 'the address stopped leading to the course too early')

  assert.equal(await release(course.id, 'linal-2025'), 200)
  // The price: a link with the former address now leads nowhere — and that was the
  // owner's decision, not a side effect.
  assert.equal(findCourse('linal-2025'), null)
  assert.equal(await release(course.id, 'linal-2025'), 404, 'released twice, and "ok" both times')

  // And the new course can finally take it.
  assert.equal((await setSlug(stranger.id, 'linal-2025')).status, 200)
})
