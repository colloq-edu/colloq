/**
 * Removing a participant from a competition: the teacher's "Delete".
 *
 * A student who asks to be erased has to be erased — rows, results and every
 * file the server keeps about their work — and the rest of the class must not
 * notice anything but a board one row shorter. What is checked is what breaks
 * quietly: a directory left behind with someone's notebook in it, a package
 * set whose rows went while its files stayed, a run still writing into a
 * removed directory, places that stop being one per row, a key that stops
 * working in a competition the person is still in.
 */
import './_env.mts'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { ENTRANT_COOKIE } from '../shared/competitions.js'
import type { EntrantLeaderboard } from '../shared/competitions-entrant.js'
import type { EntrantsList } from '../shared/competitions-api.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  entrantKeyOf,
  getEntrant,
  getSubmission,
  joinCompetition,
  joinedAt,
  leaveQueue,
  listEntrantSubmissions,
  listRuns,
  putFile,
  queueRow,
  queueRows,
  setCompetitionState,
  setQueuePaused,
  startRun,
  takeNext,
  updateCompetition,
  updateSubmission,
  finishRun,
} from '../server/src/competitions/store.js'
import {
  competitionsFs,
  putOpenFile,
  putSecretFile,
  putSubmissionNotebook,
  resultDir,
  submissionDir,
  SUBMISSION_FILE,
} from '../server/src/competitions/storage.js'
import {
  bindSubmission,
  completeBundle,
  createBundle,
  getBundle,
  putRevision,
  saveDraft,
  selectRevision,
  setPolicy,
} from '../server/src/dependencies/store.js'
import { bundleDir } from '../server/src/dependencies/files.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { pumpOnce, settleCompetitionWork, setQueueSlots } from '../server/src/competitions/runner.js'
import { deleteEntrantFromCompetition } from '../server/src/competitions/erase.js'
import { db } from '../server/src/db.js'
import { app } from '../server/src/app.js'

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

let base = ''
let server: http.Server
let teacher = ''

function staffCookie(name: string, email: string, role: 'owner' | 'teacher'): string {
  const made = createTeacher({ name, email, role })
  assert.ok(made, email)
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  // A teacher, not an owner: removing a person is a teacher's door.
  teacher = staffCookie('Преподаватель', 'teacher.erase@example.edu', 'teacher')
})

after(() => server?.close())

function call(pathname: string, init: RequestInit & { cookie?: string | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${pathname}`, { ...init, headers, redirect: 'manual' })
}

const enc = (text: string) => new TextEncoder().encode(text)
const NOTEBOOK = (source = 'print(1)') =>
  enc(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source, metadata: {}, outputs: [] }] }))

let seq = 0
function makeCompetition(slug: string) {
  seq += 1
  const made = createCompetition({
    slug: `${slug}-${seq}`,
    title: `Удаление ${seq}`,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(a, b):\n    return 1.0\n' },
    limits: { perDay: 0, wallSeconds: 600, memoryMb: 4096, cpus: 2 },
  })
  assert.ok(made)
  setCompetitionState(made.id, 'live')
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 16, visibility: 'open' })
  putSecretFile(made.id, 'solution.csv', enc('id,target\n1,1\n'))
  putFile({ competitionId: made.id, name: 'solution.csv', bytes: 16, visibility: 'hidden' })
  return made
}

function person(name: string, competitionId: string) {
  const minted = createEntrant(name)
  assert.equal(joinCompetition(competitionId, minted.entrant.id, name), 'ok')
  return minted
}

let at = Date.now() - 600_000
/** A finished submission with its files on disk, as a run leaves them. */
function finished(competitionId: string, entrantId: string, score: number | null) {
  const submission = acceptSubmission({ competitionId, entrantId, fileName: 'model.ipynb', bytes: 64, at: at++ })
  putSubmissionNotebook(competitionId, submission.id, NOTEBOOK())
  leaveQueue(submission.id)
  const run = startRun({ submissionId: submission.id, kind: 'notebook' })
  finishRun(run.id, { finishedAt: Date.now(), verdict: score === null ? 'cell_error' : 'ok' })
  const out = resultDir(competitionId, submission.id)
  competitionsFs.mkdirSync(out, { recursive: true })
  competitionsFs.writeFileSync(path.join(out, 'executed.ipynb'), Buffer.from('{"cells":[]}'))
  if (score !== null) competitionsFs.writeFileSync(path.join(out, SUBMISSION_FILE), Buffer.from('id,target\n1,0\n'))
  updateSubmission(submission.id, score === null
    ? { state: 'notebookFailed', stage: 'notebook', cellsDone: 1 }
    : { state: 'scored', stage: 'score', publicScore: score, privateScore: score, cellsDone: 1 })
  return submission
}

const onDisk = (competitionId: string, submissionId: string) =>
  competitionsFs.existsSync(submissionDir(competitionId, submissionId))

async function remove(competitionId: string, entrantId: string, cookie: string | null = teacher) {
  return call(`/api/admin/competitions/${competitionId}/entrants/${entrantId}`, { method: 'DELETE', cookie })
}

/* ------------------------------------------------------------------ tests */

test('removing a participant takes their rows, files and package sets, and the places close up', async () => {
  const c = makeCompetition('erase-main')
  const revision = putRevision({
    environmentName: c.environment, imageDigest: `sha256:${'e'.repeat(64)}`, pythonVersion: '3.11.16',
    pythonAbi: 'cp311', platform: 'linux/arm64', packages: [], baseConstraintsHash: 'hash',
  })
  selectRevision(c.id, revision.id)
  setPolicy(c.id, { enabled: true })

  const ivanov = person('ivanov@hse.ru', c.id)
  const petrova = person('petrova@hse.ru', c.id)
  const sidorov = person('@sidorov_s', c.id)
  const best = finished(c.id, ivanov.entrant.id, 0.1)
  const failed = finished(c.id, ivanov.entrant.id, null)
  finished(c.id, petrova.entrant.id, 0.2)
  finished(c.id, sidorov.entrant.id, 0.3)
  // A prepared package set, chosen in the draft and bound to a submission.
  const bundle = createBundle(c.id, ivanov.entrant.id, revision.id, 'geopy==2.4.1')
  completeBundle(bundle.id, { normalizedRequirements: ['geopy==2.4.1'], packages: [], downloadBytes: 0, installedBytes: 0, contentHash: '0'.repeat(64), lock: '' })
  saveDraft(c.id, ivanov.entrant.id, { requirementsText: 'geopy==2.4.1', selectedBundleId: bundle.id })
  bindSubmission(best.id, revision.id, bundle.id)
  fs.mkdirSync(bundleDir(bundle.id), { recursive: true })
  fs.writeFileSync(path.join(bundleDir(bundle.id), 'requirements.lock'), 'geopy==2.4.1\n')

  const before = (await (await call(`/api/k/competitions/${c.slug}/leaderboard`)).json()) as EntrantLeaderboard
  assert.deepEqual(before.public.map((line) => [line.place, line.name]), [[1, 'iva…@hse.ru'], [2, 'pet…@hse.ru'], [3, '@sidorov_s']])

  const res = await remove(c.id, ivanov.entrant.id)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { submissions: 2, identityRemoved: true })

  // The rows: the person, their key, their submissions and runs, the enrollment.
  assert.equal(getEntrant(ivanov.entrant.id), null)
  assert.equal(entrantKeyOf(ivanov.entrant.id), null)
  assert.equal(joinedAt(c.id, ivanov.entrant.id), null)
  assert.equal(listEntrantSubmissions(c.id, ivanov.entrant.id).length, 0)
  for (const id of [best.id, failed.id]) {
    assert.equal(getSubmission(id), null)
    assert.equal(listRuns(id).length, 0)
    assert.equal(queueRow(id), null)
  }
  // The package set's rows, its draft, the binding — and its directory.
  assert.equal(getBundle(bundle.id), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dependency_drafts WHERE entrant_id = ?').get(ivanov.entrant.id)?.n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submission_environments WHERE submission_id = ?').get(best.id)?.n, 0)
  assert.equal(fs.existsSync(bundleDir(bundle.id)), false, 'the set directory was left on disk')
  // The files: the notebook as sent, the executed copy, the answer.
  assert.equal(onDisk(c.id, best.id), false, 'a notebook was left on disk')
  assert.equal(onDisk(c.id, failed.id), false)

  // The places close up, one per row.
  const board = (await (await call(`/api/k/competitions/${c.slug}/leaderboard`)).json()) as EntrantLeaderboard
  assert.deepEqual(board.public.map((line) => [line.place, line.name]), [[1, 'pet…@hse.ru'], [2, '@sidorov_s']])
  // The person is gone from the teacher's list too.
  const list = (await (await call(`/api/admin/competitions/${c.id}/entrants`, { cookie: teacher })).json()) as EntrantsList
  assert.deepEqual(list.entrants.map((row) => row.name).sort(), ['@sidorov_s', 'petrova@hse.ru'])
})

test('a person in another competition keeps their identity and key there', async () => {
  const one = makeCompetition('erase-one')
  const two = makeCompetition('erase-two')
  const both = person('both@hse.ru', one.id)
  assert.equal(joinCompetition(two.id, both.entrant.id, 'both@hse.ru'), 'ok')
  const here = finished(one.id, both.entrant.id, 0.5)
  const there = finished(two.id, both.entrant.id, 0.5)

  const listed = (await (await call(`/api/admin/competitions/${one.id}/entrants`, { cookie: teacher })).json()) as EntrantsList
  assert.equal(listed.entrants.find((row) => row.id === both.entrant.id)?.otherCompetitions, 1)

  const res = await remove(one.id, both.entrant.id)
  assert.deepEqual(await res.json(), { submissions: 1, identityRemoved: false })
  assert.equal(getSubmission(here.id), null)
  assert.equal(onDisk(one.id, here.id), false)
  // In the other competition nothing moved, and the key still lets them in.
  assert.ok(getSubmission(there.id))
  assert.ok(onDisk(two.id, there.id))
  assert.ok(joinedAt(two.id, both.entrant.id))
  const signIn = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: both.key }) })
  assert.equal(signIn.status, 200)
  const cookie = signIn.headers.getSetCookie().find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))!.split(';')[0]
  // Back in the competition they were removed from, they are a stranger: no
  // upload goes in under the old enrollment.
  const form = new FormData()
  form.append('file', new Blob([NOTEBOOK()]), 'again.ipynb')
  const upload = await call(`/api/k/competitions/${one.slug}/submissions`, { method: 'POST', body: form, cookie })
  assert.equal(upload.status, 403)
  assert.equal(((await upload.json()) as { reason: string }).reason, 'not_joined')
})

test("the sample notebook's service participant cannot be removed", async () => {
  const c = makeCompetition('erase-baseline')
  const service = createEntrant('Базовое решение').entrant
  const run = finished(c.id, service.id, 0.4)
  updateCompetition(c.id, { baselineSubmissionId: run.id })
  const res = await remove(c.id, service.id)
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /служебный/)
  assert.ok(getSubmission(run.id))
})

test('the door is staff-only, and someone not in the competition is a 404', async () => {
  const c = makeCompetition('erase-door')
  const other = makeCompetition('erase-elsewhere')
  const inside = person('inside@hse.ru', c.id)
  const outside = person('outside@hse.ru', other.id)
  assert.equal((await remove(c.id, inside.entrant.id, null)).status, 401)
  assert.equal((await remove(c.id, 'nobody-here')).status, 404)
  assert.equal((await remove(c.id, outside.entrant.id)).status, 404)
  assert.ok(getEntrant(outside.entrant.id), 'a stranger to the competition was removed')
  assert.ok(getEntrant(inside.entrant.id))
})

test('a running submission is killed and waited for, then removed with everything else', async () => {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
  const c = makeCompetition('erase-running')
  const busy = person('busy@hse.ru', c.id)
  const running = acceptSubmission({ competitionId: c.id, entrantId: busy.entrant.id, fileName: 'long.ipynb', bytes: 64 })
  putSubmissionNotebook(c.id, running.id, NOTEBOOK('# colloq-test: {"hold": 20000}'))
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(running.id)?.state, 'running')
  // A rescore queued behind it, as "rescore everyone" would leave it.
  const waiting = acceptSubmission({ competitionId: c.id, entrantId: busy.entrant.id, fileName: 'next.ipynb', bytes: 64 })
  putSubmissionNotebook(c.id, waiting.id, NOTEBOOK())

  const started = Date.now()
  const res = await remove(c.id, busy.entrant.id)
  assert.equal(res.status, 200)
  assert.ok(Date.now() - started < 10_000, 'the removal waited for the run to time out instead of killing it')
  assert.deepEqual(await res.json(), { submissions: 2, identityRemoved: true })
  await settleCompetitionWork()
  for (const id of [running.id, waiting.id]) {
    assert.equal(getSubmission(id), null)
    assert.equal(queueRow(id), null)
    assert.equal(onDisk(c.id, id), false, 'a run wrote its files back after the removal')
  }
})

test('a run no job of this process owns refuses the removal, and nothing is touched', async () => {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  const c = makeCompetition('erase-orphan')
  const stuck = person('stuck@hse.ru', c.id)
  const first = acceptSubmission({ competitionId: c.id, entrantId: stuck.entrant.id, fileName: 'a.ipynb', bytes: 64 })
  putSubmissionNotebook(c.id, first.id, NOTEBOOK())
  // A previous life of the server took it and died: until the queue reclaims
  // it, nobody here can kill it or wait for it.
  assert.equal(takeNext({ boot: 'a-previous-life' })?.submissionId, first.id)
  const second = acceptSubmission({ competitionId: c.id, entrantId: stuck.entrant.id, fileName: 'b.ipynb', bytes: 64 })

  const outcome = await deleteEntrantFromCompetition(c.id, stuck.entrant.id, 50)
  assert.deepEqual(outcome, { ok: false, why: 'running' })
  assert.ok(getEntrant(stuck.entrant.id))
  assert.ok(getSubmission(first.id))
  assert.ok(onDisk(c.id, first.id))
  // The waiting one was not touched either: a refused removal changes nothing.
  assert.equal(queueRow(second.id)?.state, 'waiting')
  assert.equal(getSubmission(second.id)?.state, 'queued')

  const res = await remove(c.id, stuck.entrant.id)
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /ещё выполняется/)
  for (const row of queueRows()) leaveQueue(row.submissionId)
})

test('a person removed while their upload was arriving does not come back as a nameless submission', () => {
  const c = makeCompetition('erase-race')
  const gone = createEntrant('gone@hse.ru').entrant
  db.prepare('DELETE FROM entrants WHERE id = ?').run(gone.id)
  assert.throws(
    () => acceptSubmission({ competitionId: c.id, entrantId: gone.id, fileName: 'late.ipynb', bytes: 1 }),
    /no longer exists/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE entrant_id = ?').get(gone.id)?.n, 0)
})

test('the rows refuse to go while one of the person\'s submissions is running, and take nothing', async () => {
  const { removeEntrantRows } = await import('../server/src/competitions/store.js')
  for (const row of queueRows()) leaveQueue(row.submissionId)
  const c = makeCompetition('erase-rows')
  const held = person('held@hse.ru', c.id)
  const running = acceptSubmission({ competitionId: c.id, entrantId: held.entrant.id, fileName: 'a.ipynb', bytes: 1 })
  assert.equal(takeNext({ boot: 'erase-rows' })?.submissionId, running.id)
  const done = finished(c.id, held.entrant.id, 0.2)
  assert.equal(removeEntrantRows(c.id, held.entrant.id), 'running')
  assert.ok(getSubmission(done.id))
  assert.ok(getEntrant(held.entrant.id))
  assert.ok(joinedAt(c.id, held.entrant.id))
  leaveQueue(running.id)
  updateSubmission(running.id, { state: 'cancelled' })
  const removed = removeEntrantRows(c.id, held.entrant.id)
  assert.ok(removed !== 'running')
  assert.deepEqual(new Set(removed.submissionIds), new Set([running.id, done.id]))
  assert.equal(removed.identityRemoved, true)
})
