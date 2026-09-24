/**
 * The panel's doors: the right, the answer and the measure.
 *
 * Four different misses of one nature — a route does something other than what
 * it promises from the outside:
 *
 *  - Build answered "202 Accepted" only once the whole build had finished,
 *    that is, minutes later; all that time the tab kept the row busy, did not
 *    open the live log and would not let you press Cancel on your own build.
 *  - any teacher could erase a course with one request — even though deleting
 *    a seminar and "erase the page" belong to the owner, for exactly the
 *    reason that fits a course even better: `/c/slug` is handed out to the
 *    whole cohort.
 *  - a publication with a repeated step address silently lost a step, and
 *    `seq: 0` — the address reserved for the last page — went into the
 *    transaction.
 *  - the teacher PATCH promised optional fields in its comment and required
 *    the name and the email together.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, getTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { adminAuthRoutes } from '../server/src/routes/admin-auth.js'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { withinRoomBudget } from '../server/src/routes/admin-import.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { createCourse, getCourse, setCourseItems } from '../server/src/publish/store.js'
import { config } from '../server/src/config.js'
import type { SkippedStep } from '../shared/publish.js'

let base = ''
let server: http.Server
let ownerCookie = ''
let teacherCookie = ''

/** A build that does not finish until it is released: the real one goes to docker. */
let releaseBuild: (() => void) | null = null
let buildsStarted = 0

function cookieFor(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  const owner = createTeacher({ name: 'Ада', email: 'ada.panel@test.local', role: 'owner' })
  const teacher = createTeacher({ name: 'Нина', email: 'nina.panel@test.local', role: 'teacher' })
  assert.ok(owner)
  assert.ok(teacher)
  rotateLinkKey(owner.id)
  rotateLinkKey(teacher.id)
  ownerCookie = cookieFor(owner)
  teacherCookie = cookieFor(teacher)

  const app = express()
  app.use(express.json())
  app.use(adminAuthRoutes())
  app.use(courseRoutes())
  app.use(
    adminEnvironmentRoutes({
      environmentAbilities: () =>
        Promise.resolve({
          canBuild: true,
          cannotBuildReason: null,
          canSetDefault: true,
          cannotSetDefaultReason: null,
        }),
      startBuild: (_name: string) =>
        new Promise<void>((resolve) => {
          buildsStarted += 1
          releaseBuild = resolve
        }),
    }),
  )
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  releaseBuild?.()
  server?.close()
  shutdownCollab()
})

/* ------------------------------------------------------------------- build */

test('Build answers at once, not when the build is done', async () => {
  const res = await fetch(`${base}/api/admin/environments/base/build`, {
    method: 'POST',
    headers: { cookie: ownerCookie },
  })
  assert.equal(res.status, 202)
  // The answer has arrived and the build is running: exactly in this interval
  // the tab opens the live log and keeps the Cancel button working.
  assert.equal(buildsStarted, 1)
  assert.ok(releaseBuild, 'the build managed to finish before the answer')
  releaseBuild?.()
  releaseBuild = null
})

/* ------------------------------------------------------------------ course */

test('a course is erased by the owner, and only the owner', async () => {
  const course = createCourse('Матстат', null, 'Ада')
  const asTeacher = await fetch(`${base}/api/admin/courses/${course.id}`, {
    method: 'DELETE',
    headers: { cookie: teacherCookie },
  })
  assert.equal(asTeacher.status, 403, 'someone other than the owner erased the course')
  assert.ok(getCourse(course.id), 'the course was deleted after all')

  const asOwner = await fetch(`${base}/api/admin/courses/${course.id}`, {
    method: 'DELETE',
    headers: { cookie: ownerCookie },
  })
  assert.equal(asOwner.status, 200)
  assert.equal(getCourse(course.id), null)
})

test('no course: a 404, not "deleted"', async () => {
  const res = await fetch(`${base}/api/admin/courses/c_nope`, {
    method: 'DELETE',
    headers: { cookie: ownerCookie },
  })
  assert.equal(res.status, 404)
})

/* -------------------------------------------------------------- publishing */

const publish = (id: string, steps: unknown[]) =>
  fetch(`${base}/api/admin/seminars/${id}/publish`, {
    method: 'POST',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ steps }),
  })

test('a step with a taken address is named out loud, not lost in silence', async () => {
  const id = 'publish-dupes'
  createSession(id, 'Семинар с шагами', null)
  const res = await publish(id, [
    { seq: 5, label: 'первый' },
    { seq: 5, label: 'второй' },
  ])
  assert.equal(res.status, 200, 'a repeated address brought down the transaction')
  const body = (await res.json()) as { skipped: SkippedStep[] }
  assert.ok(
    body.skipped.some((s) => s.seq === 5 && s.reason === 'duplicate'),
    'the second step with the same address vanished without a word',
  )
})

test('a zero or fractional step address gets a refusal in words', async () => {
  const id = 'publish-zero'
  createSession(id, 'Семинар с нулём', null)
  for (const seq of [0, -3, 1.5]) {
    const res = await publish(id, [{ seq, label: 'шаг' }])
    assert.equal(res.status, 400, `seq=${seq} was accepted`)
    const body = (await res.json()) as { error?: string }
    assert.match(body.error ?? '', /номер версии для шага: целое число больше нуля/)
  }
})

/* ------------------------------------------------------ the course view */

test('the panel and the public page show the same course', async () => {
  /*
   * Building "a course with live names" was written twice — in the route and in
   * the site export — and had already diverged: the export substituted the
   * entry's name if the room was gone, while the route returned the row as is,
   * together with a stale link to the reading. The same course looked different
   * depending on which address it was opened at.
   */
  const id = 'course-view-room'
  createSession(id, 'Неделя 1', null)
  const course = createCourse('Анализ данных', null, 'Ада')
  assert.ok(
    setCourseItems(course.id, course.rev, [
      { kind: 'seminar', sessionId: id, name: 'Старое имя', publication: null },
    ]),
  )

  const panel = await fetch(`${base}/api/admin/courses/${course.id}`, {
    headers: { cookie: ownerCookie },
  })
  const fromPanel = (await panel.json()) as { course: { items: { name: string }[] } }
  assert.equal(fromPanel.course.items[0]?.name, 'Неделя 1', 'the panel showed the name from the entry')

  const open = await fetch(`${base}/api/c/${course.id}`)
  const fromPublic = (await open.json()) as {
    course: { items: { name: string; sessionId?: string }[] }
  }
  assert.equal(fromPublic.course.items[0]?.name, 'Неделя 1')
  // And the room id still does not leak out.
  assert.equal(fromPublic.course.items[0]?.sessionId, '')
})

/* ----------------------------------------------------------- the staff list */

test('the name is edited without the email: the fields really are optional', async () => {
  const person = createTeacher({ name: 'Иваннов', email: 'ivanov@test.local', role: 'teacher' })
  assert.ok(person)
  const res = await fetch(`${base}/api/admin/teachers/${person.id}`, {
    method: 'PATCH',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Иванов' }),
  })
  assert.equal(res.status, 200, 'a typo in a surname is still cured by deletion')
  const after = getTeacher(person.id)
  assert.equal(after?.name, 'Иванов')
  assert.equal(after?.email, 'ivanov@test.local', 'the email changed along with the name')
  assert.equal(after?.role, 'teacher', 'the role changed along with the name')
})

test('the email is edited without the name', async () => {
  const person = createTeacher({ name: 'Пётр', email: 'petr.old@test.local', role: 'teacher' })
  assert.ok(person)
  const res = await fetch(`${base}/api/admin/teachers/${person.id}`, {
    method: 'PATCH',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'petr.new@test.local' }),
  })
  assert.equal(res.status, 200)
  const after = getTeacher(person.id)
  assert.equal(after?.email, 'petr.new@test.local')
  assert.equal(after?.name, 'Пётр')
})

/* ------------------------------------------------------------------ import */

test('the import counts the room ceiling, not just the file size', () => {
  const tunable: { maxSessionBytes: number } = config
  const was = tunable.maxSessionBytes
  tunable.maxSessionBytes = 100
  try {
    const entry = (name: string, size: number) => ({
      name,
      path: name,
      type: 'file' as const,
      size,
      downloadUrl: `https://example.invalid/${name}`,
    })
    const { files, skipped } = withinRoomBudget([
      entry('week1.csv', 60),
      entry('week2.csv', 60),
      entry('notes.txt', 10),
    ])
    // The first fits, the second does not, and the third fits into what is left:
    // the ceiling is a sum, not "cut everything after the first one that does not fit".
    assert.deepEqual(
      files.map((f) => f.name),
      ['week1.csv', 'notes.txt'],
    )
    assert.deepEqual(skipped, ['week2.csv'])
  } finally {
    tunable.maxSessionBytes = was
  }
})
