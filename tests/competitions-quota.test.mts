/**
 * Failed submissions do not spend the daily limit — through the real upload
 * door and the real queue, over the stand-in runner.
 *
 * The owner's complaint (4 Oct 2026): with a limit of two, one notebook that
 * failed in its first cell and one that ran out of time used up the whole
 * day, and the third upload was refused. The same happened when the teacher's
 * own metric crashed, when our runner threw mid-run, and when two server
 * restarts cut a run off. Each of those is a case here, and each must leave
 * "left today", the third upload and the board's SUBMISSIONS column alone.
 *
 * Free failures got a brake of their own: a ceiling on FAILED submissions a
 * day, with its own refusal (`attempts`), never the limit's words.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { ENTRANT_COOKIE, failedAttemptsCeiling, type SubmissionState } from '../shared/competitions.js'
import type { EntrantLeaderboard, EntrantSubmissions } from '../shared/competitions-entrant.js'
import {
  acceptSubmission,
  BOOT,
  createCompetition,
  getCompetition,
  getSubmission,
  leaveQueue,
  leftToday,
  putFile,
  reclaimQueue,
  setCompetitionState,
  submissionCounts,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSecretFile } from '../server/src/competitions/storage.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type RunOutcome, type RunRequest } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue } from '../server/src/competitions/runner.js'
import { acceptPinnedSubmission } from '../server/src/dependencies/service.js'
import { DependencyStoreError } from '../server/src/dependencies/store.js'
import { db } from '../server/src/db.js'
import { app } from '../server/src/app.js'

/** The stand-in runner, plus OUR breakage mid-run: Docker gone, the broker lost. */
class FlakyRunner extends FakeCompetitionRunner {
  explodeAfterCells: number | null = null
  override async run(request: RunRequest): Promise<RunOutcome> {
    if (this.explodeAfterCells !== null) {
      request.onProgress?.({ cell: this.explodeAfterCells - 1, cells: 5, outputBytes: 0 })
      throw new Error('docker: connection reset (simulated infrastructure failure)')
    }
    return super.run(request)
  }
}
const runner = new FlakyRunner()
useCompetitionRunner(runner)

const SLUG = 'quota-free-failures'
let base = ''
let server: http.Server
let competitionId = ''

before(async () => {
  const made = createCompetition({
    slug: SLUG,
    title: 'Failures are free',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 0.5\n' },
    limits: { perDay: 2, wallSeconds: 600, memoryMb: 4096, cpus: 2 },
  })
  assert.ok(made)
  competitionId = made.id
  setCompetitionState(competitionId, 'live')
  ensureCompetition(competitionId)
  putOpenFile(competitionId, 'sample_submission.csv', new TextEncoder().encode('id,target\n1,0\n2,0\n'))
  putFile({ competitionId, name: 'sample_submission.csv', bytes: 20, rows: 2, visibility: 'open' })
  putSecretFile(competitionId, 'solution.csv', new TextEncoder().encode('id,target\n1,1\n2,2\n'))
  putFile({ competitionId, name: 'solution.csv', bytes: 20, rows: 2, visibility: 'hidden' })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
after(() => {
  useCompetitionRunner(null)
  server?.close()
})

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
const notebook = (...sources: string[]) => JSON.stringify({
  nbformat: 4, nbformat_minor: 5, metadata: {},
  cells: sources.map((source) => ({ cell_type: 'code', source, outputs: [], metadata: {}, execution_count: null })),
})
async function join(name: string) {
  const res = await call(`/api/k/competitions/${SLUG}/join`, { method: 'POST', body: JSON.stringify({ name }) })
  assert.equal(res.status, 200, name)
  const body = (await res.json()) as { entrant: { id: string } }
  return { cookie: cookieOf(res)!, id: body.entrant.id }
}
async function submit(cookie: string, body: string) {
  const form = new FormData()
  form.append('file', new Blob([body]), 'solution.ipynb')
  const res = await call(`/api/k/competitions/${SLUG}/submissions`, { method: 'POST', body: form, cookie })
  const json = (await res.json()) as { submission?: { id: string }; leftToday?: number | null; reason?: string; error?: string }
  return { status: res.status, ...json }
}
const left = (who: string) => leftToday(getCompetition(competitionId)!, who)

/** Send, run to the end, and check the outcome spent nothing of the day. */
async function failFree(who: { cookie: string; id: string }, body: string, state: SubmissionState, before = 2) {
  const sent = await submit(who.cookie, body)
  assert.equal(sent.status, 200, `${state}: accepted (${sent.reason ?? ''} ${sent.error ?? ''})`)
  assert.equal(left(who.id), before - 1, 'a waiting one holds a place')
  await drainCompetitionQueue()
  const done = getSubmission(sent.submission!.id)!
  assert.equal(done.state, state)
  assert.equal(left(who.id), before, `${state} gave its place back`)
  return done
}

/** The third upload of the day is taken, gets its score, and only it shows in the board's column. */
async function thirdIsTaken(who: { cookie: string; id: string }) {
  const third = await submit(who.cookie, notebook('print("finally a good one")'))
  assert.equal(third.status, 200, `the third upload: ${third.reason ?? ''} ${third.error ?? ''}`)
  await drainCompetitionQueue()
  assert.equal(getSubmission(third.submission!.id)!.state, 'scored')
  assert.equal(left(who.id), 1)
  assert.equal(submissionCounts(competitionId).get(who.id), 1, 'the SUBMISSIONS column counts the score only')
  const board = (await (await call(`/api/k/competitions/${SLUG}/leaderboard`, { cookie: who.cookie })).json()) as EntrantLeaderboard
  assert.equal(board.public.find((row) => row.entrantId === who.id)?.submissions, 1)
}

test('an error in the first cell and a time-limit kill spend nothing; the third upload is taken', async () => {
  const p = await join('@first_cell_and_timeout')
  const failed = await failFree(p, notebook('# colloq-test: {"status": "cell_error", "cell": 0}', 'x = 1'), 'notebookFailed')
  assert.equal(failed.cellsDone, 1, 'the notebook did run: cell one raised')
  await failFree(p, notebook('a = 1', 'b = 2', '# colloq-test: {"status": "timeout", "cell": 2}'), 'timedOut')
  assert.equal(submissionCounts(competitionId).get(p.id), undefined, 'failures are not in the board column')
  // The send box reads the same: two left, and two failures under the ceiling.
  const mine = (await (await call(`/api/k/competitions/${SLUG}/submissions`, { cookie: p.cookie })).json()) as EntrantSubmissions
  assert.equal(mine.leftToday, 2)
  assert.deepEqual(mine.failedAttempts, { used: 2, ceiling: 10 })
  await thirdIsTaken(p)
})

test('out of memory and a notebook that wrote no answer spend nothing', async () => {
  const p = await join('@oom_and_no_file')
  await failFree(p, notebook('# colloq-test: {"status": "oom", "cell": 1}', 'y = 2'), 'outOfMemory')
  await failFree(p, notebook('# colloq-test: {"status": "no_submission", "cell": 0}'), 'rejected')
  await thirdIsTaken(p)
})

test("the metric's refusal of the answer and the teacher's crashed metric spend nothing", async () => {
  const p = await join('@metric_said_no')
  await failFree(p, notebook('# colloq-test: {"metric": "participant_error"}'), 'rejected')
  await failFree(p, notebook('# colloq-test: {"metric": "metric_error"}', 'z = 3'), 'metricFailed')
  await thirdIsTaken(p)
})

test('our own breakage spends nothing: a runner that threw mid-run, a run cut off by restarts', async () => {
  const p = await join('@not_my_fault')
  runner.explodeAfterCells = 4
  try {
    const thrown = await failFree(p, notebook('x = 1'), 'metricFailed')
    assert.equal(thrown.cellsDone, 4, 'it had run four cells before we broke')
  } finally {
    runner.explodeAfterCells = null
  }
  // A run cut off by the second restart: reclaimQueue gives up on it.
  const sent = await submit(p.cookie, notebook('x = 1', 'y = 2', 'z = 3'))
  assert.equal(sent.status, 200)
  const id = sent.submission!.id
  db.prepare("UPDATE submissions SET state = 'running', stage = 'notebook', cells_done = 3 WHERE id = ?").run(id)
  db.prepare("UPDATE competition_queue SET state = 'running', boot = 'previous-life', attempts = 2, started_at = ? WHERE submission_id = ?").run(Date.now() - 1000, id)
  assert.equal(reclaimQueue(BOOT).abandoned.length, 1)
  assert.equal(getSubmission(id)!.state, 'metricFailed')
  assert.equal(left(p.id), 2)
  await thirdIsTaken(p)
})

/** Finished submissions of today, written straight into the table. */
function finished(entrantId: string, state: SubmissionState, count: number): void {
  for (let i = 0; i < count; i++) {
    const row = acceptSubmission({ competitionId, entrantId, fileName: `f${i}.ipynb`, bytes: 1 })
    leaveQueue(row.id)
    updateSubmission(row.id, { state, cellsDone: 1 })
  }
}

test('a day of failures meets its own ceiling, with its own reason and words, never the limit', async () => {
  const p = await join('@endless_crashes')
  const ceiling = failedAttemptsCeiling(2)!
  assert.equal(ceiling, 10)
  finished(p.id, 'notebookFailed', ceiling - 1)
  assert.equal(left(p.id), 2, 'nine failures and the limit is untouched')
  // One more is still allowed: the ceiling refuses only once it is reached.
  const last = await submit(p.cookie, notebook('# colloq-test: {"status": "cell_error", "cell": 0}'))
  assert.equal(last.status, 200)
  await drainCompetitionQueue()
  const refused = await submit(p.cookie, notebook('print(1)'))
  assert.equal(refused.status, 429)
  assert.equal(refused.reason, 'attempts')
  assert.match(refused.error ?? '', /10 упавших посылок/)
  assert.match(refused.error ?? '', /не лимит посылок/)
  assert.doesNotMatch(refused.error ?? '', /посылки кончились|Лимит обновится/)
  const mine = (await (await call(`/api/k/competitions/${SLUG}/submissions`, { cookie: p.cookie })).json()) as EntrantSubmissions
  assert.equal(mine.leftToday, 2, 'the limit itself was never spent')
  assert.deepEqual(mine.failedAttempts, { used: 10, ceiling: 10 })
  assert.equal(mine.replaceable, null)

  // The intake transaction holds the same line, in case the door's look went stale.
  const competition = getCompetition(competitionId)!
  assert.throws(
    () => acceptPinnedSubmission(competition, p.id, 'late.ipynb', 1, null, null, { startedAt: Date.now() }),
    (error: unknown) => error instanceof DependencyStoreError && error.code === 'dependency_submission_attempts' && error.status === 429,
  )
})

test("the metric's failures and cancelled ones are not the participant's doing: they never reach the ceiling", async () => {
  const p = await join('@teachers_metric_is_broken')
  finished(p.id, 'metricFailed', 12)
  finished(p.id, 'cancelled', 12)
  const sent = await submit(p.cookie, notebook('print(1)'))
  assert.equal(sent.status, 200, `${sent.reason ?? ''} ${sent.error ?? ''}`)
  await drainCompetitionQueue()
  assert.equal(left(p.id), 1)
})

test('without a limit there is no ceiling either', async () => {
  const open = createCompetition({ slug: 'quota-no-limit', title: 'No limit', limits: { perDay: 0 } })
  assert.ok(open)
  setCompetitionState(open.id, 'live')
  const who = (await join('@no_limit_person')).id
  for (let i = 0; i < 40; i++) {
    const row = acceptSubmission({ competitionId: open.id, entrantId: who, fileName: 'x.ipynb', bytes: 1 })
    leaveQueue(row.id)
    updateSubmission(row.id, { state: 'notebookFailed', cellsDone: 1 })
  }
  const fresh = getCompetition(open.id)!
  const accepted = acceptPinnedSubmission(fresh, who, 'ok.ipynb', 1, null, null, { startedAt: Date.now() })
  assert.ok(accepted.id)
  leaveQueue(accepted.id)
})
