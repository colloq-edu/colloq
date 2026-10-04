/**
 * «Поздние посылки»: after the deadline an upload is still taken, run and
 * scored — and kept off every board, place, counted submission, summary and
 * the final results' wait.
 *
 * What breaks quietly here is the standings: a late fix that silently becomes
 * the "last" or the "best public" one changes the final places; a late upload
 * that replaces a still-waiting on-time notebook throws away a result that
 * was in the table; a late row in the queue or in the release count holds the
 * final results back for as long as late intake stays open.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { ENTRANT_COOKIE, type Competition } from '../shared/competitions.js'
import type { EntrantCompetitionView, EntrantLeaderboard, EntrantSubmissions, SubmissionAccepted } from '../shared/competitions-entrant.js'
import type { CompetitionView, SubmissionFeed } from '../shared/competitions-api.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import {
  acceptSubmission,
  chooseSubmission,
  competitionSummary,
  createCompetition,
  createEntrant,
  getCompetition,
  getSubmission,
  intakePlan,
  leaveQueue,
  leftToday,
  nextQueueRow,
  openPrivateBoard,
  pendingResultsCount,
  putFile,
  queueRow,
  setCompetitionState,
  submissionCounts,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSecretFile } from '../server/src/competitions/storage.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue } from '../server/src/competitions/runner.js'
import { privateBoardState, DEADLINE_GRACE_MS } from '../server/src/competitions/results.js'
import { intakeEndedAt } from '../server/src/competitions/housekeeping.js'
import { fairOrder } from '../server/src/competitions/panel.js'
import { acceptPinnedSubmission } from '../server/src/dependencies/service.js'
import { DependencyStoreError } from '../server/src/dependencies/store.js'
import { app } from '../server/src/app.js'

const HOUR = 60 * 60 * 1000
let base = ''
let server: http.Server
let staffCookie = ''

/** A live competition whose deadline passed an hour ago. */
function competition(slug: string, extra: Partial<Parameters<typeof createCompetition>[0]> = {}): Competition {
  const made = createCompetition({
    slug,
    title: slug,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 0.5\n' },
    limits: { perDay: 5 },
    deadlineAt: Date.now() - HOUR,
    lateSubmissions: true,
    scoring: 'last',
    ...extra,
  })
  assert.ok(made)
  setCompetitionState(made.id, 'live')
  ensureCompetition(made.id)
  putOpenFile(made.id, 'sample_submission.csv', new TextEncoder().encode('id,target\n1,0\n2,0\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 20, rows: 2, visibility: 'open' })
  putSecretFile(made.id, 'solution.csv', new TextEncoder().encode('id,target\n1,1\n2,2\n'))
  putFile({ competitionId: made.id, name: 'solution.csv', bytes: 20, rows: 2, visibility: 'hidden' })
  return getCompetition(made.id)!
}

before(async () => {
  useCompetitionRunner(null)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const teacher = createTeacher({ name: 'Преподаватель', email: 'late.teacher@example.edu', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  staffCookie = `${STAFF_COOKIE}=${value}`
})
after(() => server?.close())

function cookieOf(res: Response): string | null {
  for (const line of res.headers.getSetCookie?.() ?? []) if (line.startsWith(`${ENTRANT_COOKIE}=`)) return line.split(';')[0]
  return null
}
function call(path: string, init: RequestInit & { cookie?: string | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
}
const notebook = (source = 'print(1)') =>
  JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source, outputs: [], metadata: {}, execution_count: null }] })
async function join(slug: string, name: string) {
  const res = await call(`/api/k/competitions/${slug}/join`, { method: 'POST', body: JSON.stringify({ name }) })
  assert.equal(res.status, 200, `joining ${slug} after the deadline`)
  const body = (await res.json()) as { entrant: { id: string } }
  return { cookie: cookieOf(res)!, id: body.entrant.id }
}
async function upload(slug: string, cookie: string, body = notebook()) {
  const form = new FormData()
  form.append('file', new Blob([body]), 'late.ipynb')
  return call(`/api/k/competitions/${slug}/submissions`, { method: 'POST', body: form, cookie })
}

/** An on-time submission, scored, as if it ran before the deadline. */
function onTime(c: Competition, entrantId: string, publicScore: number, privateScore: number) {
  const at = c.deadlineAt! - 10 * 60 * 1000
  const row = acceptSubmission({ competitionId: c.id, entrantId, fileName: 'on-time.ipynb', bytes: 1, at })
  leaveQueue(row.id)
  return updateSubmission(row.id, { state: 'scored', stage: 'score', publicScore, privateScore })!
}

test('late on: an upload after the deadline is taken as late, scored, and on no board under "last"', async () => {
  const c = competition('late-board')
  const view = (await (await call('/api/k/competitions/late-board')).json()) as EntrantCompetitionView
  assert.equal(view.accepting, 'late')
  assert.equal(view.competition.lateSubmissions, true)
  const p = await join('late-board', '@late_but_better')
  const counted = onTime(c, p.id, 0.99, 0.98)
  const leftBefore = leftToday(c, p.id)!

  const res = await upload('late-board', p.cookie)
  assert.equal(res.status, 200)
  const accepted = (await res.json()) as SubmissionAccepted
  assert.equal(accepted.submission.late, true)
  assert.ok(typeof accepted.submission.sentAt === 'number' && accepted.submission.sentAt > c.deadlineAt!)
  await drainCompetitionQueue()
  const late = getSubmission(accepted.submission.id)!
  assert.equal(late.state, 'scored')
  assert.ok(late.publicScore! < 0.99, 'the late one is better and later: it would win "last" and "best public"')

  // Both boards keep the on-time submission; the late one is in neither.
  const board = (await (await call('/api/k/competitions/late-board/leaderboard', { cookie: p.cookie })).json()) as EntrantLeaderboard
  assert.deepEqual(board.public.map((row) => row.submissionId), [counted.id])
  assert.equal(board.privateOpen, true)
  assert.deepEqual(board.private?.map((row) => row.submissionId), [counted.id])
  assert.equal(board.public[0].submissions, 1, 'the board column is the standings: on-time only')

  // The author sees it, marked late, with its private score once the final results are open.
  const mine = (await (await call('/api/k/competitions/late-board/submissions', { cookie: p.cookie })).json()) as EntrantSubmissions
  const row = mine.submissions.find((s) => s.id === late.id)!
  assert.equal(row.late, true)
  assert.equal(row.privateScore, late.privateScore)
  assert.equal(mine.leftToday, leftBefore - 1, 'the same daily limit: a scored late one spends one')

  // Summaries count the standings; the late one is counted apart.
  const summary = competitionSummary(c.id)
  assert.equal(summary.submissions, 1)
  assert.equal(summary.scored, 1)
  assert.equal(summary.bestPublic, 0.99)
  assert.equal(summary.late, 1)
  assert.equal(submissionCounts(c.id).get(p.id), 1)

  // The teacher's feed carries the flag and filters by it.
  const feed = (await (await call(`/api/admin/competitions/${c.id}/submissions?late=1`, { cookie: staffCookie })).json()) as SubmissionFeed
  assert.deepEqual(feed.rows.map((r) => r.submission.id), [late.id])
  assert.equal(feed.rows[0].submission.late, true)
  const onTimeFeed = (await (await call(`/api/admin/competitions/${c.id}/submissions?late=0`, { cookie: staffCookie })).json()) as SubmissionFeed
  assert.deepEqual(onTimeFeed.rows.map((r) => r.submission.id), [counted.id])
  const live = (await (await call(`/api/admin/competitions/${c.id}/live`, { cookie: staffCookie })).json()) as { counts: { late?: number; submissions: number } }
  assert.equal(live.counts.late, 1)
  assert.equal(live.counts.submissions, 1)
})

test('a late private score stays hidden until the final results open, like any other', async () => {
  const c = competition('late-manual', { privateRelease: 'manual' })
  const p = await join('late-manual', '@late_private')
  const res = await upload('late-manual', p.cookie)
  assert.equal(res.status, 200)
  const id = ((await res.json()) as SubmissionAccepted).submission.id
  await drainCompetitionQueue()
  assert.ok(getSubmission(id)!.privateScore !== null)
  const closed = (await (await call('/api/k/competitions/late-manual/submissions', { cookie: p.cookie })).json()) as EntrantSubmissions
  assert.equal(closed.submissions.find((s) => s.id === id)!.privateScore, null)
  openPrivateBoard(c.id)
  const opened = (await (await call('/api/k/competitions/late-manual/submissions', { cookie: p.cookie })).json()) as EntrantSubmissions
  assert.equal(opened.submissions.find((s) => s.id === id)!.privateScore, getSubmission(id)!.privateScore)
})

test('late off: after the deadline the door stays closed, and "Finish now" closes it too', async () => {
  const c = competition('late-off', { lateSubmissions: false })
  const view = (await (await call('/api/k/competitions/late-off')).json()) as EntrantCompetitionView
  assert.equal(view.accepting, 'closed')
  const join = await call('/api/k/competitions/late-off/join', { method: 'POST', body: JSON.stringify({ name: '@too_late' }) })
  assert.equal(join.status, 403)
  // On, then finished by hand: the late door stays open; off again: closed.
  updateCompetition(c.id, { lateSubmissions: true, deadlineAt: null })
  setCompetitionState(c.id, 'finished')
  assert.equal(((await (await call('/api/k/competitions/late-off')).json()) as EntrantCompetitionView).accepting, 'late')
  updateCompetition(c.id, { lateSubmissions: false })
  assert.equal(((await (await call('/api/k/competitions/late-off')).json()) as EntrantCompetitionView).accepting, 'closed')
})

test('a late upload never takes the place of an on-time submission still waiting', async () => {
  const c = competition('late-replace')
  const p = await join('late-replace', '@still_waiting')
  const waiting = acceptSubmission({ competitionId: c.id, entrantId: p.id, fileName: 'on-time.ipynb', bytes: 1, at: c.deadlineAt! - 1000 })
  assert.equal(intakePlan(c.id, p.id, true), 'on_time_waiting')
  const res = await upload('late-replace', p.cookie)
  assert.equal(res.status, 409)
  const body = (await res.json()) as { reason: string; error: string }
  assert.equal(body.reason, 'in_flight')
  assert.match(body.error, /до дедлайна/)
  assert.equal(queueRow(waiting.id)?.state, 'waiting', 'the on-time one kept its place')
  const mine = (await (await call('/api/k/competitions/late-replace/submissions', { cookie: p.cookie })).json()) as EntrantSubmissions
  assert.equal(mine.replaceable, null, 'the send box offers no replacement it would refuse')
  leaveQueue(waiting.id)
  updateSubmission(waiting.id, { state: 'cancelled' })

  // A late one waiting can be replaced by a late one, as an on-time by an on-time.
  const first = (await (await upload('late-replace', p.cookie)).json()) as SubmissionAccepted
  const second = await upload('late-replace', p.cookie)
  assert.equal(second.status, 200)
  assert.equal(((await second.json()) as SubmissionAccepted).replacedNumber, first.submission.number)
  await drainCompetitionQueue()
})

test('the queue takes on-time work first, and the panel numbers it the same way', () => {
  const c = competition('late-queue')
  const lateRow = acceptSubmission({ competitionId: c.id, entrantId: createEntrantId('late-q-1'), fileName: 'l.ipynb', bytes: 1, at: Date.now() - 5000, late: true })
  const onTimeRow = acceptSubmission({ competitionId: c.id, entrantId: createEntrantId('late-q-2'), fileName: 'o.ipynb', bytes: 1, at: Date.now() })
  assert.equal(queueRow(lateRow.id)?.late, true)
  assert.equal(nextQueueRow()?.submissionId, onTimeRow.id, 'arrived later, goes first')
  const order = fairOrder([queueRow(lateRow.id)!, queueRow(onTimeRow.id)!], new Set())
  assert.deepEqual(order.map((row) => row.submissionId), [onTimeRow.id, lateRow.id])
  leaveQueue(lateRow.id)
  leaveQueue(onTimeRow.id)
})

function createEntrantId(name: string): string {
  return createEntrant(`@${name.replaceAll('-', '_')}`).entrant.id
}

test('an upload begun on time stays on time; a body after the grace is late only with late intake on', () => {
  const now = Date.now()
  const c = competition('late-grace', { deadlineAt: now - 30_000 })
  const who = createEntrantId('grace-person')
  const inGrace = acceptPinnedSubmission(c, who, 'a.ipynb', 1, null, null, { startedAt: now - 60_000 })
  assert.equal(inGrace.late, false, 'begun before the deadline, arrived within the grace')
  leaveQueue(inGrace.id)
  updateSubmission(inGrace.id, { state: 'scored', publicScore: 0.5 })

  updateCompetition(c.id, { deadlineAt: now - DEADLINE_GRACE_MS - 60_000 })
  const pastGrace = acceptPinnedSubmission(getCompetition(c.id)!, who, 'b.ipynb', 1, null, null, { startedAt: now - DEADLINE_GRACE_MS - 120_000 })
  assert.equal(pastGrace.late, true, 'begun on time, but the body came after the grace: late, since late intake is open')
  leaveQueue(pastGrace.id)
  updateSubmission(pastGrace.id, { state: 'scored', publicScore: 0.4 })

  updateCompetition(c.id, { lateSubmissions: false })
  assert.throws(
    () => acceptPinnedSubmission(getCompetition(c.id)!, who, 'c.ipynb', 1, null, null, { startedAt: now - DEADLINE_GRACE_MS - 120_000 }),
    (error: unknown) => error instanceof DependencyStoreError && error.code === 'dependency_closed',
  )
})

test('late work does not hold the final results back', () => {
  const c = competition('late-release')
  const who = createEntrantId('release-person')
  const lateRow = acceptSubmission({ competitionId: c.id, entrantId: who, fileName: 'l.ipynb', bytes: 1, late: true })
  const cutoff = Number.MAX_SAFE_INTEGER
  assert.equal(pendingResultsCount(c.id, cutoff), 0)
  assert.deepEqual(privateBoardState(getCompetition(c.id)!), { open: true, pending: 0 })
  // "Finish now" without a deadline: the cutoff is the end of time, and late rows still do not count.
  updateCompetition(c.id, { deadlineAt: null })
  setCompetitionState(c.id, 'finished')
  assert.deepEqual(privateBoardState(getCompetition(c.id)!), { open: true, pending: 0 })
  const other = createEntrantId('release-other')
  const onTimeRow = acceptSubmission({ competitionId: c.id, entrantId: other, fileName: 'o.ipynb', bytes: 1, at: Date.now() - HOUR * 2 })
  assert.deepEqual(privateBoardState(getCompetition(c.id)!), { open: false, pending: 1 })
  leaveQueue(lateRow.id)
  leaveQueue(onTimeRow.id)
})

test('a late submission can never be picked to count', async () => {
  const c = competition('late-choose', { scoring: 'chosen' })
  const p = await join('late-choose', '@picky')
  const late = acceptSubmission({ competitionId: c.id, entrantId: p.id, fileName: 'l.ipynb', bytes: 1, late: true })
  leaveQueue(late.id)
  updateSubmission(late.id, { state: 'scored', publicScore: 0.1 })
  assert.equal(chooseSubmission(c.id, p.id, late.id), false)
  // Intake open again by a direct store edit, which recomputes nothing (only
  // the editor's deadline move does, see below): the door still refuses a row
  // that is late.
  updateCompetition(c.id, { deadlineAt: Date.now() + HOUR })
  const res = await call(`/api/k/competitions/late-choose/submissions/${late.id}/choose`, { method: 'POST', cookie: p.cookie })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /Поздняя посылка вне зачёта/)
  assert.equal(getSubmission(late.id)!.late, true, 'the store does not recompute lateness on its own')
})

test('moving the deadline later frees what was sent before it; moving it earlier makes no one late', async () => {
  const c = competition('late-moved', { scoring: 'chosen' })
  const patch = (body: object) => call(`/api/admin/competitions/${c.id}`, { method: 'PATCH', body: JSON.stringify(body), cookie: staffCookie })
  const p = await join('late-moved', '@moved_deadline')
  const deadline = c.deadlineAt!
  const sentEarly = deadline + 10 * 60 * 1000
  const sentLater = deadline + 40 * 60 * 1000
  // Two late ones, both scored, and a third still waiting in the queue.
  const early = acceptSubmission({ competitionId: c.id, entrantId: p.id, fileName: 'early.ipynb', bytes: 1, late: true, at: sentEarly, sentAt: sentEarly })
  leaveQueue(early.id)
  updateSubmission(early.id, { state: 'scored', stage: 'score', publicScore: 0.3, privateScore: 0.3 })
  const later = acceptSubmission({ competitionId: c.id, entrantId: p.id, fileName: 'later.ipynb', bytes: 1, late: true, at: sentLater, sentAt: sentLater })
  leaveQueue(later.id)
  updateSubmission(later.id, { state: 'scored', stage: 'score', publicScore: 0.2, privateScore: 0.2 })
  const other = await join('late-moved', '@moved_waiting')
  const waiting = acceptSubmission({ competitionId: c.id, entrantId: other.id, fileName: 'w.ipynb', bytes: 1, late: true, at: sentEarly, sentAt: sentEarly })
  assert.equal(queueRow(waiting.id)?.late, true)

  // Twenty minutes later: the one sent ten minutes after the old deadline is on time now.
  const moved = await patch({ deadlineAt: deadline + 20 * 60 * 1000 })
  assert.equal(moved.status, 200)
  assert.equal(getSubmission(early.id)!.late, false, 'sent before the new deadline: on time')
  assert.equal(getSubmission(later.id)!.late, true, 'sent after the new deadline: still late')
  assert.equal(getSubmission(waiting.id)!.late, false)
  assert.equal(queueRow(waiting.id)?.late, false, 'the queue row carries the same mark')
  const view = (await moved.json()) as CompetitionView
  assert.equal(view.counts.late, 1, 'the answer already counts the freed one in the standings')
  assert.equal(competitionSummary(c.id).scored, 1)

  // Back to the old deadline: the freed one is not made late again.
  assert.equal((await patch({ deadlineAt: deadline })).status, 200)
  assert.equal(getSubmission(early.id)!.late, false, 'no one is penalised retroactively')
  assert.equal(getSubmission(later.id)!.late, true)

  // An unrelated save leaves the marks alone.
  assert.equal((await patch({ title: 'late-moved again' })).status, 200)
  assert.equal(getSubmission(later.id)!.late, true)

  // No deadline at all: intake never ended, and nothing is late.
  assert.equal((await patch({ deadlineAt: null })).status, 200)
  assert.equal(getSubmission(later.id)!.late, false)
  leaveQueue(waiting.id)
})

test('a body that came after the grace of the new deadline stays late, and so does all of a finished one', async () => {
  const c = competition('late-moved-grace')
  const patch = (body: object) => call(`/api/admin/competitions/${c.id}`, { method: 'PATCH', body: JSON.stringify(body), cookie: staffCookie })
  const who = createEntrantId('moved-grace')
  const deadline = c.deadlineAt!
  // Began five minutes after the old deadline, its body arrived ten minutes after that.
  const slow = acceptSubmission({ competitionId: c.id, entrantId: who, fileName: 's.ipynb', bytes: 1, late: true, at: deadline + 15 * 60 * 1000, sentAt: deadline + 5 * 60 * 1000 })
  leaveQueue(slow.id)
  assert.equal((await patch({ deadlineAt: deadline + 6 * 60 * 1000 })).status, 200)
  assert.equal(getSubmission(slow.id)!.late, true, 'begun in time for the new deadline, but past its grace')
  assert.equal((await patch({ deadlineAt: deadline + 14 * 60 * 1000 })).status, 200)
  assert.equal(getSubmission(slow.id)!.late, false, 'within the grace of this one')

  const done = competition('late-moved-finished')
  const someone = createEntrantId('moved-finished')
  const row = acceptSubmission({ competitionId: done.id, entrantId: someone, fileName: 'f.ipynb', bytes: 1, late: true, at: done.deadlineAt! + 60_000, sentAt: done.deadlineAt! + 60_000 })
  leaveQueue(row.id)
  setCompetitionState(done.id, 'finished')
  const res = await call(`/api/admin/competitions/${done.id}`, { method: 'PATCH', body: JSON.stringify({ deadlineAt: Date.now() + HOUR }), cookie: staffCookie })
  assert.equal(res.status, 200)
  assert.equal(getSubmission(row.id)!.late, true, '«Завершить сейчас» closed the standings, and a date does not reopen them')
})

test('the editor switches late intake and the output policy strictly', async () => {
  const c = competition('late-editor', { lateSubmissions: false })
  const patch = (body: object) => call(`/api/admin/competitions/${c.id}`, { method: 'PATCH', body: JSON.stringify(body), cookie: staffCookie })
  const on = await patch({ lateSubmissions: true })
  assert.equal(on.status, 200)
  assert.equal(((await on.json()) as CompetitionView).competition.lateSubmissions, true)
  assert.equal((await patch({ lateSubmissions: 'false' })).status, 400, 'a string is not a switch')
  assert.equal(getCompetition(c.id)!.lateSubmissions, true)
  const full = await patch({ outputPolicy: 'full' })
  assert.equal(((await full.json()) as CompetitionView).competition.outputPolicy, 'full')
  assert.equal((await patch({ outputPolicy: 'everything' })).status, 400)
  const off = await patch({ lateSubmissions: false, outputPolicy: 'brief' })
  const saved = ((await off.json()) as CompetitionView).competition
  assert.equal(saved.lateSubmissions, false)
  assert.equal(saved.outputPolicy, 'brief')
  // Every older competition reads as before: late off, brief.
  const plain = createCompetition({ slug: 'late-defaults', title: 'defaults' })!
  assert.equal(plain.lateSubmissions, false)
  assert.equal(plain.outputPolicy, 'brief')
})

test('the file sweep treats open late intake as intake still running', () => {
  const now = Date.now()
  const finished = { state: 'finished' as const, deadlineAt: now - 30 * 24 * HOUR, updatedAt: now - 20 * 24 * HOUR }
  assert.equal(intakeEndedAt({ ...finished, lateSubmissions: true }, now), null)
  assert.equal(intakeEndedAt({ ...finished, lateSubmissions: false }, now), finished.deadlineAt)
  // Switched off after late uploads: the week starts from the last of them.
  assert.equal(intakeEndedAt({ ...finished, lateSubmissions: false }, now, now - HOUR), now - HOUR)
  const live = { state: 'live' as const, deadlineAt: now - 10 * 24 * HOUR, updatedAt: now - 10 * 24 * HOUR }
  assert.equal(intakeEndedAt({ ...live, lateSubmissions: true }, now), null)
})
