/**
 * The sweep of old submission files: which competitions it touches, what it
 * keeps in them, and when it keeps its hands off.
 *
 * Every submission leaves a directory (the notebook, the executed copy, the
 * answer), and nothing ever removed one, so the disk the database shares
 * grew until a competition was deleted. The sweep must free that space
 * without costing anyone a result: never under a run that reads the files,
 * never during intake (a rescore of everyone reads every answer), never the
 * submissions a board counts. And its log line says how much, never whose.
 */
import './_env.mts'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { Competition } from '../shared/competitions.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import {
  acceptSubmission,
  chooseSubmission,
  createCompetition,
  createEntrant,
  leaveQueue,
  queueRows,
  setCompetitionState,
  takeNext,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import {
  competitionDir,
  competitionsFs,
  putSubmissionNotebook,
  resultDir,
  submissionDir,
  SUBMISSION_FILE,
} from '../server/src/competitions/storage.js'
import {
  intakeEndedAt,
  PRUNE_AFTER_MS,
  startSubmissionSweep,
  stopSubmissionSweep,
  sweepOldSubmissions,
} from '../server/src/competitions/housekeeping.js'
import { db } from '../server/src/db.js'
import { app } from '../server/src/app.js'

const DAY = 24 * 60 * 60 * 1000
const enc = (text: string) => new TextEncoder().encode(text)

/* ------------------------------------------------------------ eligibility */

test('intake is over when the competition was finished or its deadline passed, never for a draft', () => {
  const now = Date.UTC(2026, 9, 1, 12)
  const of = (over: Partial<Pick<Competition, 'state' | 'deadlineAt' | 'updatedAt'>>) =>
    intakeEndedAt({ state: 'live', deadlineAt: null, updatedAt: now - DAY, ...over }, now)
  assert.equal(of({ state: 'draft', deadlineAt: now - 30 * DAY }), null)
  // Live without a deadline, or before it: still taking submissions.
  assert.equal(of({}), null)
  assert.equal(of({ deadlineAt: now + DAY }), null)
  // Past the deadline it is over by itself, "Finish" pressed or not.
  assert.equal(of({ deadlineAt: now - 3 * DAY }), now - 3 * DAY)
  // Finished early: it ended when it was finished, not at the later deadline.
  assert.equal(of({ state: 'finished', deadlineAt: now + 5 * DAY, updatedAt: now - 2 * DAY }), now - 2 * DAY)
  assert.equal(of({ state: 'finished', deadlineAt: now - 9 * DAY, updatedAt: now - DAY }), now - 9 * DAY)
  assert.equal(of({ state: 'finished', updatedAt: now - 4 * DAY }), now - 4 * DAY)
})

/* ---------------------------------------------------------------- sweeps */

let seq = 0
function competition(label: string, setup: (id: string) => void): Competition {
  seq += 1
  const made = createCompetition({
    slug: `sweep-${label}-${seq}`,
    title: `Уборка ${seq}`,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(a, b):\n    return 1\n' },
  })
  assert.ok(made)
  setup(made.id)
  return made
}

let at = Date.now() - 60 * DAY
/** A finished submission with its directory, as a run leaves it. */
function submission(competitionId: string, entrantId: string, score: number | null) {
  const made = acceptSubmission({ competitionId, entrantId, fileName: 'n.ipynb', bytes: 10, at: at++ })
  putSubmissionNotebook(competitionId, made.id, enc('{"cells":[]}'))
  competitionsFs.mkdirSync(resultDir(competitionId, made.id), { recursive: true })
  competitionsFs.writeFileSync(path.join(resultDir(competitionId, made.id), SUBMISSION_FILE), Buffer.from('id,target\n1,0\n'))
  leaveQueue(made.id)
  updateSubmission(made.id, score === null
    ? { state: 'notebookFailed', cellsDone: 2 }
    : { state: 'scored', stage: 'score', publicScore: score, privateScore: score })
  return made
}

const kept = (competitionId: string, id: string) => competitionsFs.existsSync(submissionDir(competitionId, id))

function endedDaysAgo(id: string, days: number, now: number): void {
  setCompetitionState(id, 'finished', now - days * DAY)
}

test('a competition long over keeps its boards, its choices, its sample run and ten latest per person', async () => {
  const now = Date.now()
  const person = createEntrant('sweep.one@hse.ru').entrant
  const other = createEntrant('sweep.two@hse.ru').entrant
  const service = createEntrant('Базовое решение').entrant
  let made: ReturnType<typeof submission>[] = []
  let otherBest: ReturnType<typeof submission> | null = null
  let baseline: ReturnType<typeof submission> | null = null
  const c = competition('over', (id) => {
    // The oldest scores best, but the person chose another one below, and
    // under "the participant chooses" the choice is what the board counts.
    made = [submission(id, person.id, 0.01)]
    for (let i = 1; i < 14; i++) made.push(submission(id, person.id, i % 3 === 0 ? null : 0.5 + i / 100))
    otherBest = submission(id, other.id, 0.02)
    baseline = submission(id, service.id, 0.3)
    updateCompetition(id, { baselineSubmissionId: baseline.id, scoring: 'chosen' })
  })
  // A choice of an old one, made before the deadline.
  assert.ok(chooseSubmission(c.id, person.id, made[2].id))
  endedDaysAgo(c.id, 8, now)

  const report = await sweepOldSubmissions(now)
  assert.equal(report.busy, 0)
  // Fourteen of theirs: the ten latest stay, and so does the chosen one
  // (which is also the one the board counts); the three oldest others go,
  // the best-scoring one among them, since it counts for nothing.
  const gone = made.filter((one) => !kept(c.id, one.id)).map((one) => made.indexOf(one))
  assert.deepEqual(gone, [0, 1, 3])
  assert.ok(kept(c.id, made[2].id), 'the chosen submission lost its files')
  for (let i = 4; i < 14; i++) assert.ok(kept(c.id, made[i].id), `#${i} is among the ten latest`)
  assert.ok(kept(c.id, otherBest!.id))
  assert.ok(kept(c.id, baseline!.id), "the sample notebook's run lost its answer")
  assert.ok(report.removed >= 1 && report.bytes > 0)
})

test('the counted submission keeps its answer however old it is', async () => {
  const now = Date.now()
  const person = createEntrant('counted.sweep@hse.ru').entrant
  let made: ReturnType<typeof submission>[] = []
  const c = competition('counted', (id) => {
    made = [submission(id, person.id, 0.001)]
    for (let i = 0; i < 12; i++) made.push(submission(id, person.id, 0.9))
  })
  endedDaysAgo(c.id, 30, now)
  await sweepOldSubmissions(now)
  assert.ok(kept(c.id, made[0].id), 'the board-counted submission lost its answer')
  assert.equal(kept(c.id, made[1].id), false)
  assert.equal(kept(c.id, made[2].id), false)
})

test('work in the queue keeps the whole competition out of the round', async () => {
  const now = Date.now()
  const person = createEntrant('busy.sweep@hse.ru').entrant
  let made: ReturnType<typeof submission>[] = []
  let running: ReturnType<typeof submission> | null = null
  const c = competition('busy', (id) => {
    for (let i = 0; i < 13; i++) made.push(submission(id, person.id, 0.5))
    // A teacher's rerun of an old one, taken by the queue.
    running = acceptSubmission({ competitionId: id, entrantId: person.id, fileName: 'rerun.ipynb', bytes: 1, at: at++ })
    putSubmissionNotebook(id, running.id, enc('{}'))
  })
  for (const row of queueRows()) if (row.submissionId !== running!.id) leaveQueue(row.submissionId)
  assert.equal(takeNext({ boot: 'sweep-test' })?.submissionId, running!.id)
  endedDaysAgo(c.id, 10, now)

  const report = await sweepOldSubmissions(now)
  assert.equal(report.busy, 1)
  for (const one of made) assert.ok(kept(c.id, one.id), 'a file was swept from under a run')
  assert.ok(kept(c.id, running!.id))

  // The round after the run is over sweeps it as usual.
  leaveQueue(running!.id)
  updateSubmission(running!.id, { state: 'scored', publicScore: 0.9, privateScore: 0.9 })
  const later = await sweepOldSubmissions(now)
  assert.equal(later.busy, 0)
  assert.ok(made.some((one) => !kept(c.id, one.id)))
})

test('during intake, a week after it and in a draft nothing is swept', async () => {
  const now = Date.now()
  const person = createEntrant('intake.sweep@hse.ru').entrant
  const all: { c: Competition; ids: string[] }[] = []
  const fill = (id: string) => {
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push(submission(id, person.id, 0.5).id)
    return ids
  }
  let ids: string[] = []
  const open = competition('open', (id) => { ids = fill(id) })
  setCompetitionState(open.id, 'live')
  updateCompetition(open.id, { deadlineAt: now + DAY })
  all.push({ c: open, ids })
  const recent = competition('recent', (id) => { ids = fill(id) })
  endedDaysAgo(recent.id, Math.floor(PRUNE_AFTER_MS / DAY) - 1, now)
  all.push({ c: recent, ids })
  const draft = competition('draft', (id) => { ids = fill(id) })
  all.push({ c: draft, ids })

  await sweepOldSubmissions(now)
  for (const { c, ids: list } of all) {
    for (const id of list) assert.ok(kept(c.id, id), `${c.state} ${c.slug} lost a file`)
  }

  // A live competition past its deadline by more than a week is over.
  const past = competition('past', (id) => { ids = fill(id) })
  setCompetitionState(past.id, 'live')
  updateCompetition(past.id, { deadlineAt: now - 8 * DAY })
  await sweepOldSubmissions(now)
  assert.ok(ids.some((id) => !kept(past.id, id)))
})

test('a stray name among the submissions does not stop the sweep, and stays', async () => {
  const now = Date.now()
  const person = createEntrant('stray.sweep@hse.ru').entrant
  let made: ReturnType<typeof submission>[] = []
  const c = competition('stray', (id) => {
    for (let i = 0; i < 12; i++) made.push(submission(id, person.id, 0.5))
  })
  const stray = path.join(competitionDir(c.id), 's', '.DS_Store')
  competitionsFs.writeFileSync(stray, Buffer.from('x'))
  endedDaysAgo(c.id, 9, now)
  const report = await sweepOldSubmissions(now)
  assert.ok(report.removed >= 1)
  assert.ok(competitionsFs.existsSync(stray))
})

test('the log line says how many and how much, never whose', async () => {
  const now = Date.now()
  const person = createEntrant('secret.person@hse.ru').entrant
  const c = competition('log', (id) => {
    for (let i = 0; i < 12; i++) submission(id, person.id, 0.5)
  })
  endedDaysAgo(c.id, 9, now)
  const lines: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    await sweepOldSubmissions(now)
  } finally {
    console.log = log
  }
  const line = lines.find((one) => one.includes('swept old submission files'))
  assert.ok(line, 'nothing was said about the sweep')
  assert.match(line, /\d+ submission\(s\) in 1 ended competition\(s\), \d+(\.\d)? [KM]B freed/)
  for (const secret of ['secret.person', c.slug, c.id, person.id]) assert.ok(!line.includes(secret), `the log names ${secret}`)
})

test('the rounds start and stop without keeping the process alive', async () => {
  startSubmissionSweep()
  startSubmissionSweep()
  await stopSubmissionSweep()
  await stopSubmissionSweep()
})

/* --------------------------------------------- rescoring after a sweep */

let base = ''
let server: http.Server
before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
after(() => server?.close())

test('a swept submission refuses a rescore instead of dropping off the board', async () => {
  const now = Date.now()
  const person = createEntrant('rescore.sweep@hse.ru').entrant
  let made: ReturnType<typeof submission>[] = []
  const c = competition('rescore', (id) => {
    made = [submission(id, person.id, 0.1)]
    for (let i = 0; i < 12; i++) made.push(submission(id, person.id, 0.8))
  })
  endedDaysAgo(c.id, 9, now)
  await sweepOldSubmissions(now)
  const swept = made.find((one) => !kept(c.id, one.id))
  assert.ok(swept)
  const teacher = createTeacher({ name: 'Преподаватель', email: 'teacher.sweep@example.edu', role: 'teacher' })!
  rotateLinkKey(teacher.id)
  // The teacher's own competition: a teacher runs only what they made or what
  // their course holds (competitions/scope.ts).
  db.prepare('UPDATE competitions SET created_by = ? WHERE id = ?').run(teacher.id, c.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  const res = await fetch(`${base}/api/admin/competitions/${c.id}/submissions/${swept.id}/rescore`, {
    method: 'POST',
    headers: { cookie: `${STAFF_COOKIE}=${value}` },
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /не оставила ответа/)
  const row = db.prepare('SELECT state, public_score FROM submissions WHERE id = ?').get(swept.id) as { state: string; public_score: number }
  assert.deepEqual(row, { state: 'scored', public_score: 0.8 })
})
