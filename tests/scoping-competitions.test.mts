/**
 * Who runs which competition (0.19).
 *
 * Until 0.19 any staff cookie ran every competition on the instance: read its
 * entrants' keys, killed its runs, paused the one queue under every course.
 * Now a teacher runs what they created and what their courses hold; an owner
 * runs everything. Checked here are the list AND the doors — the per-id
 * routes, the second lookup the dependency routes use, the queue, the entrant
 * registry and the /k board's staff exemptions — because a competition hidden
 * from the list but still reachable by id would be a filter, not access
 * control.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../server/src/db.js'
import { createCourse } from '../server/src/publish/store.js'
import { addCourseTeacher, removeCourseTeacher } from '../server/src/admin/access.js'
import { updateTeacherRole } from '../server/src/admin/store.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  getCompetition,
  getEntrant,
  joinCompetition,
  queueRow,
  restampSharedCompetitionsForTest,
  setCompetitionState,
  setQueuePaused,
  updateCompetition,
} from '../server/src/competitions/store.js'
import type { Competition } from '../shared/competitions.js'
import type { CompetitionsList, CompetitionView, CompetitionLive, EntrantsList, EntrantRow, QueueSnapshot } from '../shared/competitions-api.js'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running
const owner = staffMember('Владелица Ольга', 'owner')
const anna = staffMember('Анна Белова')
const boris = staffMember('Борис Волков')
/** Vera teaches Anna's course but created nothing herself. */
const vera = staffMember('Вера Котова')

let courseA = ''
let courseB = ''
/** Anna's own competition, outside courses. */
let annaOwn: Competition
/** A competition of Anna's course, created by the owner. */
let annaCourse: Competition
/** Boris's own competition. */
let borisOwn: Competition
/** Made by a script: no creator, no course. */
let orphan: Competition

const get = async <T,>(path: string, cookie: string): Promise<T> => {
  const res = await call(app.base, 'GET', path, { cookie })
  assert.equal(res.status, 200, `${path}: ${res.status}`)
  return (await res.json()) as T
}

const listed = async (cookie: string): Promise<string[]> =>
  (await get<CompetitionsList>('/api/admin/competitions', cookie)).competitions.map((row) => row.competition.slug).sort()

before(async () => {
  app = await startApp()
  // Nothing here may be taken by a pump: the queue rows are the test's.
  setQueuePaused(true)
  courseA = createCourse('Курс Анны', null, anna.teacher.name).id
  addCourseTeacher(courseA, anna.teacher.id, null)
  addCourseTeacher(courseA, vera.teacher.id, null)
  courseB = createCourse('Курс Бориса', null, boris.teacher.name).id
  addCourseTeacher(courseB, boris.teacher.id, null)

  const made = await call(app.base, 'POST', '/api/admin/competitions', {
    cookie: anna.cookie,
    body: { slug: 'anna-own', title: 'Анна: своё' },
  })
  assert.equal(made.status, 201)
  annaOwn = ((await made.json()) as CompetitionView).competition
  assert.equal(annaOwn.createdBy, anna.teacher.id)
  assert.equal(annaOwn.courseId, null)

  annaCourse = createCompetition({ slug: 'anna-course', title: 'Курс Анны: задача', createdBy: owner.teacher.id, courseId: courseA })!
  borisOwn = createCompetition({ slug: 'boris-own', title: 'Борис: своё', createdBy: boris.teacher.id })!
  orphan = createCompetition({ slug: 'orphan', title: 'Без хозяина' })!
})

after(() => {
  setQueuePaused(false)
  app?.close()
})

/* ------------------------------------------------------------- the list */

test('a teacher lists what they created and what their courses hold; an owner lists everything', async () => {
  assert.deepEqual(await listed(anna.cookie), ['anna-course', 'anna-own'])
  assert.deepEqual(await listed(vera.cookie), ['anna-course'])
  assert.deepEqual(await listed(boris.cookie), ['boris-own'])
  const all = await listed(owner.cookie)
  for (const slug of ['anna-course', 'anna-own', 'boris-own', 'orphan']) assert.ok(all.includes(slug), slug)
})

test('a row names its course; a competition outside courses has none', async () => {
  const rows = (await get<CompetitionsList>('/api/admin/competitions', anna.cookie)).competitions
  assert.deepEqual(rows.find((row) => row.competition.id === annaCourse.id)?.course, { id: courseA, name: 'Курс Анны' })
  assert.equal(rows.find((row) => row.competition.id === annaOwn.id)?.course, null)
})

test('the public /k list does not carry the course', async () => {
  setCompetitionState(annaCourse.id, 'live')
  try {
    const res = await call(app.base, 'GET', '/api/k/competitions/anna-course')
    assert.equal(res.status, 200)
    const text = await res.text()
    const list = await (await call(app.base, 'GET', '/api/k/competitions')).text()
    assert.ok(list.includes('anna-course') && !list.includes(courseA), 'the public list carries the course')
    assert.ok(!text.includes(courseA), 'the course id reached a public page')
    assert.ok(!text.includes('courseId'))
  } finally {
    setCompetitionState(annaCourse.id, 'draft')
  }
})

/* ------------------------------------------------------------- the doors */

test('every per-competition door answers 404 for a competition the caller does not run, by id or by slug', async () => {
  const doors: [string, string, unknown?][] = [
    ['GET', `/api/admin/competitions/${annaOwn.id}`],
    ['GET', '/api/admin/competitions/anna-own'],
    ['PATCH', `/api/admin/competitions/${annaOwn.id}`, { title: 'Чужое' }],
    ['PUT', `/api/admin/competitions/${annaOwn.id}/metric`, { code: 'def score(a, b): return 0' }],
    ['GET', `/api/admin/competitions/${annaOwn.id}/live`],
    ['GET', `/api/admin/competitions/${annaOwn.id}/leaderboard`],
    ['GET', `/api/admin/competitions/${annaOwn.id}/submissions`],
    ['GET', `/api/admin/competitions/${annaOwn.id}/entrants`],
    ['POST', `/api/admin/competitions/${annaOwn.id}/entrants`, { name: '@intruder' }],
    ['GET', `/api/admin/competitions/${annaOwn.id}/sealed`],
    ['POST', `/api/admin/competitions/${annaOwn.id}/private-board`],
    ['POST', `/api/admin/competitions/${annaOwn.id}/open`],
    ['POST', `/api/admin/competitions/${annaOwn.id}/rescore`],
  ]
  for (const [method, path, body] of doors) {
    const res = await call(app.base, method, path, { cookie: boris.cookie, body })
    assert.equal(res.status, 404, `${method} ${path}`)
    assert.equal(((await res.json()) as { reason: string }).reason, 'not_found', `${method} ${path}`)
  }
  // Nothing behind them moved.
  assert.equal(getCompetition(annaOwn.id)?.title, 'Анна: своё')
  assert.equal(getCompetition(annaOwn.id)?.privateOpenedAt, null)

  // A course teacher who did not create it runs it; a stranger to both does not.
  assert.equal((await call(app.base, 'GET', `/api/admin/competitions/${annaCourse.id}`, { cookie: vera.cookie })).status, 200)
  assert.equal((await call(app.base, 'GET', `/api/admin/competitions/${annaOwn.id}`, { cookie: vera.cookie })).status, 404)
  // A competition with no creator and no course is the owners'.
  assert.equal((await call(app.base, 'GET', `/api/admin/competitions/${orphan.id}`, { cookie: anna.cookie })).status, 404)
  assert.equal((await call(app.base, 'GET', `/api/admin/competitions/${orphan.id}`, { cookie: owner.cookie })).status, 200)
})

test('the dependency routes ask the same question as the rest of the panel', async () => {
  for (const [method, path, body] of [
    ['GET', `/api/admin/competitions/${annaOwn.id}/dependencies`],
    ['PATCH', `/api/admin/competitions/${annaOwn.id}/dependencies/policy`, { enabled: true }],
    ['POST', `/api/admin/competitions/${annaOwn.id}/dependencies/refresh-base`],
    ['POST', `/api/admin/competitions/${annaOwn.id}/dependencies/whatever/cancel`],
  ] as [string, string, unknown?][]) {
    const res = await call(app.base, method, path, { cookie: boris.cookie, body })
    assert.equal(res.status, 404, `${method} ${path}`)
    assert.equal(((await res.json()) as { reason: string }).reason, 'dependency_owner', `${method} ${path}`)
  }
  const own = await call(app.base, 'GET', `/api/admin/competitions/${annaOwn.id}/dependencies`, { cookie: anna.cookie })
  assert.notEqual(own.status, 404)
})

test('leaving the course takes its competitions away at once; coming back returns them', async () => {
  removeCourseTeacher(courseA, vera.teacher.id)
  try {
    assert.deepEqual(await listed(vera.cookie), [])
    assert.equal((await call(app.base, 'GET', `/api/admin/competitions/${annaCourse.id}`, { cookie: vera.cookie })).status, 404)
  } finally {
    addCourseTeacher(courseA, vera.teacher.id, null)
  }
  assert.deepEqual(await listed(vera.cookie), ['anna-course'])
})

test('an open live stream ends when its viewer leaves the course', async () => {
  const res = await fetch(`${app.base}/api/admin/competitions/${annaCourse.id}/stream`, { headers: { cookie: vera.cookie } })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /event: state/)
  removeCourseTeacher(courseA, vera.teacher.id)
  try {
    const started = Date.now()
    let done = false
    while (!done && Date.now() - started < 5000) done = (await reader.read()).done
    assert.ok(done, 'the stream kept going after the teacher left the course')
  } finally {
    addCourseTeacher(courseA, vera.teacher.id, null)
  }
})

test('an open live stream ends when its owner is made a teacher: the viewer is re-read on every push', async () => {
  const demoted = staffMember('Владелец На Время', 'owner')
  const res = await fetch(`${app.base}/api/admin/competitions/${borisOwn.id}/stream`, { headers: { cookie: demoted.cookie } })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: state/)
  assert.ok(updateTeacherRole(demoted.teacher.id, 'teacher'))
  const started = Date.now()
  let done = false
  while (!done && Date.now() - started < 5000) done = (await reader.read()).done
  assert.ok(done, 'a demoted owner kept streaming another teacher\'s competition')
})

/* ------------------------------------------------------- the 0.19 update */

test('a competition from before the update stays with everyone on the staff list then, until it gets a course', async () => {
  // As on the first boot: a competition co-run by everyone, made by Anna, and
  // one copied from another instance whose creator means nothing here.
  const coRun = createCompetition({ slug: 'before-update', title: 'До обновления', createdBy: anna.teacher.id })!
  const copied = createCompetition({ slug: 'copied-in', title: 'Перенесённое', createdBy: 'staff-from-elsewhere' })!
  assert.equal(restampSharedCompetitionsForTest([coRun.id, copied.id]), 2)
  // Someone who arrives after the update starts with nothing of these.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const newcomer = staffMember('Новенький Соревнований')

  for (const { cookie, teacher } of [boris, vera]) {
    const slugs = await listed(cookie)
    assert.ok(slugs.includes('before-update') && slugs.includes('copied-in'), `${teacher.name} lost a competition on the update`)
    assert.equal((await call(app.base, 'GET', `/api/admin/competitions/${coRun.id}`, { cookie })).status, 200)
  }
  assert.ok(!(await listed(newcomer.cookie)).includes('before-update'), 'the update shared with someone it did not know')
  assert.equal((await call(app.base, 'GET', `/api/admin/competitions/${copied.id}`, { cookie: newcomer.cookie })).status, 404)

  // Given a course, it is the course's: Boris (not in Anna's course) loses it.
  const moved = await call(app.base, 'PATCH', `/api/admin/competitions/${coRun.id}`, { cookie: anna.cookie, body: { courseId: courseA } })
  assert.equal(moved.status, 200)
  assert.ok(!(await listed(boris.cookie)).includes('before-update'))
  assert.ok((await listed(vera.cookie)).includes('before-update'), 'the course\'s teacher does not see it')
  // And taking the course away again does not bring the old sharing back.
  assert.equal((await call(app.base, 'PATCH', `/api/admin/competitions/${coRun.id}`, { cookie: anna.cookie, body: { courseId: null } })).status, 200)
  assert.ok(!(await listed(vera.cookie)).includes('before-update'))
  assert.ok((await listed(anna.cookie)).includes('before-update'), 'its creator lost it')
})

test('a row names only a course the viewer teaches', async () => {
  // The owner moves Anna's own competition into Boris's course: Anna keeps it
  // as its creator, but the course is not hers to name.
  const mine = createCompetition({ slug: 'anna-moved', title: 'Анна: перенесено', createdBy: anna.teacher.id })!
  assert.equal((await call(app.base, 'PATCH', `/api/admin/competitions/${mine.id}`, { cookie: owner.cookie, body: { courseId: courseB } })).status, 200)
  const row = (await get<CompetitionsList>('/api/admin/competitions', anna.cookie)).competitions.find((one) => one.competition.id === mine.id)
  assert.ok(row, 'the creator lost their competition')
  assert.equal(row.course, null, 'a teacher read the name of a course they do not teach')
  const ownerRow = (await get<CompetitionsList>('/api/admin/competitions', owner.cookie)).competitions.find((one) => one.competition.id === mine.id)
  assert.deepEqual(ownerRow?.course, { id: courseB, name: 'Курс Бориса' })
})

/* --------------------------------------------------------------- «Курс» */

test('«Курс» takes one of the caller\'s courses, or none', async () => {
  // Creating straight into a course of one's own.
  const inCourse = await call(app.base, 'POST', '/api/admin/competitions', {
    cookie: boris.cookie,
    body: { slug: 'boris-course', title: 'Борис: в курсе', courseId: courseB },
  })
  assert.equal(inCourse.status, 201)
  assert.equal(((await inCourse.json()) as CompetitionView).competition.courseId, courseB)

  // Another teacher's course answers like a missing one, and nothing is created.
  const foreign = await call(app.base, 'POST', '/api/admin/competitions', {
    cookie: boris.cookie,
    body: { slug: 'boris-foreign', title: 'Борис в чужой курс', courseId: courseA },
  })
  assert.equal(foreign.status, 404)
  assert.equal(db.prepare('SELECT 1 FROM competitions WHERE slug = ?').get('boris-foreign'), undefined)
  const missing = await call(app.base, 'POST', '/api/admin/competitions', {
    cookie: boris.cookie,
    body: { slug: 'boris-nowhere', title: 'Нет курса', courseId: 'no-such-course' },
  })
  assert.equal(missing.status, 404)
  const malformed = await call(app.base, 'POST', '/api/admin/competitions', {
    cookie: boris.cookie,
    body: { slug: 'boris-bad', title: 'Плохой курс', courseId: 42 },
  })
  assert.equal(malformed.status, 400)

  // Moving one's own competition into a foreign course is refused the same way.
  const move = await call(app.base, 'PATCH', `/api/admin/competitions/${borisOwn.id}`, {
    cookie: boris.cookie,
    body: { courseId: courseA },
  })
  assert.equal(move.status, 404)
  assert.equal(getCompetition(borisOwn.id)?.courseId, null)

  // Into one's own course and back out: the creator keeps it either way.
  for (const courseId of [courseB, null]) {
    const res = await call(app.base, 'PATCH', `/api/admin/competitions/${borisOwn.id}`, {
      cookie: boris.cookie,
      body: { courseId },
    })
    assert.equal(res.status, 200, String(courseId))
    assert.equal(getCompetition(borisOwn.id)?.courseId, courseId)
  }
  // An owner may put any competition in any course.
  const byOwner = await call(app.base, 'PATCH', `/api/admin/competitions/${orphan.id}`, {
    cookie: owner.cookie,
    body: { courseId: courseB },
  })
  assert.equal(byOwner.status, 200)
  assert.ok((await listed(boris.cookie)).includes('orphan'))
  updateCompetition(orphan.id, { courseId: null })
})

test('a course teacher cannot move a competition out of their own sight', async () => {
  // Vera runs it only through the course: «Без курса» would leave it to its creator.
  const res = await call(app.base, 'PATCH', `/api/admin/competitions/${annaCourse.id}`, {
    cookie: vera.cookie,
    body: { courseId: null, title: 'Переименовано' },
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /пропадёт из вашей панели/)
  assert.equal(getCompetition(annaCourse.id)?.courseId, courseA)
  assert.equal(getCompetition(annaCourse.id)?.title, 'Курс Анны: задача')
  // Sending the course it already has is no move at all.
  const same = await call(app.base, 'PATCH', `/api/admin/competitions/${annaCourse.id}`, {
    cookie: vera.cookie,
    body: { courseId: courseA, blurb: 'Описание' },
  })
  assert.equal(same.status, 200)
})

/* ---------------------------------------------------------------- queue */

test('the queue shows another course\'s run as a busy slot, nothing of whose', async () => {
  const person = createEntrant('runner.anna@hse.ru').entrant
  joinCompetition(annaOwn.id, person.id, 'runner.anna@hse.ru')
  const submission = acceptSubmission({ competitionId: annaOwn.id, entrantId: person.id, fileName: 'anna.ipynb', bytes: 10 })
  db.prepare("UPDATE competition_queue SET state = 'running', started_at = ?, container = 'zz-anna' WHERE submission_id = ?")
    .run(Date.now(), submission.id)
  try {
    const mine = (await get<QueueSnapshot>('/api/admin/competitions/queue', anna.cookie)).running
      .find((row) => row.submissionId === submission.id)
    assert.ok(mine)
    assert.equal(mine.entrantName, 'runner.anna@hse.ru')
    assert.equal(mine.competitionSlug, 'anna-own')
    assert.equal(mine.hidden, undefined)

    const views: [string, QueueSnapshot][] = [
      ['queue', await get<QueueSnapshot>('/api/admin/competitions/queue', boris.cookie)],
      ['list', (await get<CompetitionsList>('/api/admin/competitions', boris.cookie)).queue],
      ['live', (await get<CompetitionLive>(`/api/admin/competitions/${borisOwn.id}/live`, boris.cookie)).queue],
    ]
    for (const [where, snapshot] of views) {
      const theirs = snapshot.running.find((row) => row.submissionId === submission.id)
      assert.ok(theirs, `${where}: the slot is still shown`)
      assert.equal(theirs.hidden, true, where)
      assert.equal(theirs.entrantName, '', where)
      assert.equal(theirs.entrantId, '', where)
      assert.equal(theirs.competitionSlug, '', where)
      assert.equal(theirs.competitionId, '', where)
      assert.equal(theirs.fileName, '', where)
      assert.equal(theirs.container, null, where)
      const text = JSON.stringify(snapshot)
      assert.ok(!text.includes('runner.anna') && !text.includes('anna-own') && !text.includes('zz-anna'), `${where} leaked`)
    }
    // The counts are the instance's for everyone.
    const annaSees = await get<QueueSnapshot>('/api/admin/competitions/queue', anna.cookie)
    assert.equal(views[0][1].running.length, annaSees.running.length)
    assert.equal(views[0][1].waiting, annaSees.waiting)
    assert.equal(views[0][1].slots, annaSees.slots)

    const owned = (await get<QueueSnapshot>('/api/admin/competitions/queue', owner.cookie)).running
      .find((row) => row.submissionId === submission.id)
    assert.equal(owned?.entrantName, 'runner.anna@hse.ru')
  } finally {
    db.prepare('DELETE FROM competition_queue WHERE submission_id = ?').run(submission.id)
  }
})

test('a teacher kills only a run of a competition they run', async () => {
  const person = createEntrant('kill.anna@hse.ru').entrant
  joinCompetition(annaOwn.id, person.id, 'kill.anna@hse.ru')
  const theirs = acceptSubmission({ competitionId: annaOwn.id, entrantId: person.id, fileName: 'k.ipynb', bytes: 10 })
  assert.ok(queueRow(theirs.id))

  const refused = await call(app.base, 'POST', '/api/admin/competitions/queue/kill', {
    cookie: boris.cookie,
    body: { submissionId: theirs.id },
  })
  assert.equal(refused.status, 409)
  assert.ok(queueRow(theirs.id), 'another course\'s submission left the queue')

  const killed = await call(app.base, 'POST', '/api/admin/competitions/queue/kill', {
    cookie: anna.cookie,
    body: { submissionId: theirs.id },
  })
  assert.equal(killed.status, 200)
  assert.equal(queueRow(theirs.id), null)
})

test('pausing the one queue is the owner\'s', async () => {
  const refused = await call(app.base, 'POST', '/api/admin/competitions/queue/pause', {
    cookie: anna.cookie,
    body: { paused: false },
  })
  assert.equal(refused.status, 403)
  assert.match(((await refused.json()) as { error: string }).error, /очередь посылок/)
  const done = await call(app.base, 'POST', '/api/admin/competitions/queue/pause', {
    cookie: owner.cookie,
    body: { paused: true },
  })
  assert.equal(done.status, 200)
  assert.equal(((await done.json()) as QueueSnapshot).paused, true)
})

/* ------------------------------------------------------------- entrants */

test('the instance-wide entrant registry and a loose entrant are the owner\'s', async () => {
  assert.equal((await call(app.base, 'GET', '/api/admin/competitions/entrants', { cookie: anna.cookie })).status, 403)
  assert.equal((await call(app.base, 'GET', '/api/admin/competitions/entrants', { cookie: owner.cookie })).status, 200)
  const loose = await call(app.base, 'POST', '/api/admin/competitions/entrants', { cookie: anna.cookie, body: { name: '@loose_one' } })
  assert.equal(loose.status, 403)
  const byOwner = await call(app.base, 'POST', '/api/admin/competitions/entrants', { cookie: owner.cookie, body: { name: '@loose_owner' } })
  assert.equal(byOwner.status, 201)
})

test('a person added from a competition joins it, and shows in its list with the key', async () => {
  const made = await call(app.base, 'POST', `/api/admin/competitions/${annaOwn.id}/entrants`, {
    cookie: anna.cookie,
    body: { name: 'New_Student' },
  })
  assert.equal(made.status, 201)
  const { entrant, key } = (await made.json()) as { entrant: EntrantRow; key: string }
  assert.equal(entrant.name, '@new_student')
  assert.match(key, /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/)
  const list = await get<EntrantsList>(`/api/admin/competitions/${annaOwn.id}/entrants`, anna.cookie)
  const row = list.entrants.find((one) => one.id === entrant.id)
  assert.ok(row, 'the new person is in the competition')
  assert.equal(row.key, key)

  // A namesake in the same competition is refused, and no identity is minted.
  const before = (db.prepare('SELECT COUNT(*) AS n FROM entrants').get() as { n: number }).n
  const twin = await call(app.base, 'POST', `/api/admin/competitions/${annaOwn.id}/entrants`, {
    cookie: anna.cookie,
    body: { name: '@NEW_STUDENT' },
  })
  assert.equal(twin.status, 409)
  assert.equal(((await twin.json()) as { reason: string }).reason, 'name_taken')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entrants').get() as { n: number }).n, before)
})

test('a person shared with another course\'s competition: key withheld, rename left to the owner', async () => {
  const shared = createEntrant('shared@hse.ru').entrant
  joinCompetition(annaOwn.id, shared.id, 'shared@hse.ru')
  joinCompetition(borisOwn.id, shared.id, 'shared@hse.ru')
  const only = createEntrant('only.anna@hse.ru').entrant
  joinCompetition(annaOwn.id, only.id, 'only.anna@hse.ru')
  // In two competitions, both Anna's: everything is hers to see.
  const both = createEntrant('both.anna@hse.ru').entrant
  joinCompetition(annaOwn.id, both.id, 'both.anna@hse.ru')
  joinCompetition(annaCourse.id, both.id, 'both.anna@hse.ru')

  const rows = (await get<EntrantsList>(`/api/admin/competitions/${annaOwn.id}/entrants`, anna.cookie)).entrants
  const sharedRow = rows.find((row) => row.id === shared.id)!
  assert.equal(sharedRow.key, null)
  assert.equal(sharedRow.keyWithheld, true)
  assert.equal(sharedRow.editable, false)
  // The count names only competitions Anna runs: Boris's is not hers to
  // count. `keyWithheld` is what tells the dialog the key outlives this one.
  assert.equal(sharedRow.otherCompetitions, 0)
  const onlyRow = rows.find((row) => row.id === only.id)!
  assert.match(String(onlyRow.key), /^[A-Z0-9]{3}-/)
  assert.equal(onlyRow.keyWithheld, undefined)
  const bothRow = rows.find((row) => row.id === both.id)!
  assert.match(String(bothRow.key), /^[A-Z0-9]{3}-/)
  assert.equal(bothRow.otherCompetitions, 1)
  // The owner sees every key.
  const ownerRows = (await get<EntrantsList>(`/api/admin/competitions/${annaOwn.id}/entrants`, owner.cookie)).entrants
  assert.match(String(ownerRows.find((row) => row.id === shared.id)?.key), /^[A-Z0-9]{3}-/)
  assert.equal(ownerRows.find((row) => row.id === shared.id)?.otherCompetitions, 1, 'the owner counts every competition')

  const patch = (id: string, cookie: string, body: unknown) =>
    call(app.base, 'PATCH', `/api/admin/competitions/entrants/${id}`, { cookie, body })
  // The shared person: Anna is refused out loud, Boris too, and nothing changes.
  for (const cookie of [anna.cookie, boris.cookie]) {
    const res = await patch(shared.id, cookie, { name: 'renamed@hse.ru', disabled: true })
    assert.equal(res.status, 403)
    assert.match(((await res.json()) as { error: string }).error, /владелец/)
  }
  assert.equal(getEntrant(shared.id)?.name, 'shared@hse.ru')
  assert.equal(getEntrant(shared.id)?.disabled, false)
  // A person who is only in Anna's competitions is Anna's, and nobody's else.
  const stranger = await patch(only.id, boris.cookie, { disabled: true })
  assert.equal(stranger.status, 404)
  assert.equal(getEntrant(only.id)?.disabled, false)
  assert.equal((await patch(only.id, anna.cookie, { name: 'only.renamed@hse.ru' })).status, 200)
  assert.equal(getEntrant(only.id)?.name, 'only.renamed@hse.ru')
  assert.equal((await patch(both.id, anna.cookie, { disabled: true })).status, 200)
  // The owner changes anyone.
  assert.equal((await patch(shared.id, owner.cookie, { disabled: true })).status, 200)
  assert.equal(getEntrant(shared.id)?.disabled, true)
  // A loose person (in no competition) is the owner's only.
  const loose = createEntrant('@nowhere_person').entrant
  assert.equal((await patch(loose.id, anna.cookie, { disabled: true })).status, 404)
})

/* ------------------------------------------------------------ /k board */

test('the board\'s staff exemptions belong to staff who run the competition', async () => {
  const c = createCompetition({ slug: 'board-anna', title: 'Доска Анны', createdBy: anna.teacher.id, boardVisibility: 'entrants' })!
  setCompetitionState(c.id, 'live')
  const person = createEntrant('board.person@hse.ru').entrant
  joinCompetition(c.id, person.id, 'board.person@hse.ru')
  const scored = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'b.ipynb', bytes: 10 })
  db.prepare('DELETE FROM competition_queue WHERE submission_id = ?').run(scored.id)
  db.prepare("UPDATE submissions SET state = 'scored', stage = 'score', public_score = 0.5, private_score = 0.5 WHERE id = ?").run(scored.id)

  const board = (cookie?: string) => call(app.base, 'GET', '/api/k/competitions/board-anna/leaderboard', { cookie })
  // A closed board: open to Anna and the owner, not to a teacher of another course.
  assert.equal((await board(anna.cookie)).status, 200)
  assert.equal((await board(owner.cookie)).status, 200)
  assert.equal((await board(boris.cookie)).status, 401)

  // A public board: Anna reads names whole, Boris reads them as any visitor does.
  updateCompetition(c.id, { boardVisibility: 'public' })
  const whole = await (await board(anna.cookie)).text()
  assert.ok(whole.includes('board.person@hse.ru'))
  const masked = await (await board(boris.cookie)).text()
  assert.ok(!masked.includes('board.person@hse.ru'), 'a teacher of another course read a full address')
  assert.ok(masked.includes('…@hse.ru'))
})
