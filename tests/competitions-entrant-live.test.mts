/**
 * The entrant's live doors: the state stream, cancelling one's own
 * submission, and what the leaderboard now says about the counted submission.
 *
 * All of this is about rights, not decoration. The stream gives out one's OWN
 * submissions: it stays open for the whole run, and an extra field in it goes
 * out not once but every second. Cancelling kills a container — all the more
 * reason it must not remove someone else's submission. And the "COUNTED
 * SUBMISSION" column (P3) added the number and the author's choice to a
 * leaderboard row, and that is exactly where it is easiest to attach a
 * private score to them.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { ENTRANT_COOKIE } from '../shared/competitions.js'
import { db } from '../server/src/db.js'
import type { EntrantLeaderboard, EntrantSubmissions } from '../shared/competitions-entrant.js'
import {
  acceptSubmission,
  chooseSubmission,
  createCompetition,
  getSubmission,
  putFile,
  queueRow,
  setCompetitionState,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSecretFile } from '../server/src/competitions/storage.js'
import { app } from '../server/src/app.js'

let base = ''
let server: http.Server
let competitionId = ''

const METRIC_CODE = 'def score(solution, submission):\n    return 0.5\n'
const SEED_MARK = 'zerno-kotoroe-nelzya-otdavat'

before(async () => {
  const made = createCompetition({
    slug: 'live-k',
    title: 'Живое соревнование',
    blurb: 'Проверка живых дверей.',
    description: 'Задача.',
    metric: { name: 'MAPE', direction: 'lower', code: METRIC_CODE },
    limits: { perDay: 20 },
  })
  assert.ok(made)
  competitionId = made.id
  setCompetitionState(competitionId, 'live')
  ensureCompetition(competitionId)
  putOpenFile(competitionId, 'test.csv', new TextEncoder().encode('id\n1\n2\n'))
  putFile({ competitionId, name: 'test.csv', bytes: 6, rows: 2, visibility: 'open' })
  putSecretFile(competitionId, 'solution.csv', new TextEncoder().encode('id,orders\n1,7\n2,9\n'))
  putFile({ competitionId, name: 'solution.csv', bytes: 18, rows: 2, visibility: 'hidden' })

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

/* --------------------------------------------------------------- helpers */

function cookieOf(res: Response): string | null {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    if (line.startsWith(`${ENTRANT_COOKIE}=`)) return line.split(';')[0]
  }
  return null
}

function call(path: string, init: RequestInit & { cookie?: string | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
}

async function join(name: string): Promise<{ cookie: string; id: string }> {
  const res = await call('/api/k/competitions/live-k/join', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  assert.equal(res.status, 200, `joining ${name}`)
  const payload = (await res.json()) as { entrant: { id: string } }
  const cookie = cookieOf(res)
  assert.ok(cookie)
  return { cookie, id: payload.entrant.id }
}

/** A submission queued directly: the suite has no runner. */
function queue(entrantId: string, fileName: string, at = Date.now()) {
  return acceptSubmission({ competitionId, entrantId, fileName, bytes: 100, at })
}

/** The first `event: state` frame of the stream; then the stream is closed. */
async function firstFrame(cookie: string | null): Promise<{ status: number; data: string }> {
  const control = new AbortController()
  const res = await call('/api/k/competitions/live-k/stream', { cookie, signal: control.signal })
  if (!res.ok || !res.body) {
    control.abort()
    return { status: res.status, data: await res.text().catch(() => '') }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!buffer.includes('\n\n')) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    control.abort()
  }
  const frame = buffer.split('\n\n')[0]
  const line = frame.split('\n').find((part) => part.startsWith('data: ')) ?? ''
  return { status: res.status, data: line.slice('data: '.length) }
}

/* ------------------------------------------------------------- stream */

test("the live stream requires the entrant's cookie", async () => {
  const anonymous = await firstFrame(null)
  assert.equal(anonymous.status, 401)
})

test('the live stream of a nonexistent competition is a 404, not an empty stream', async () => {
  const person = await join('Поток Первый')
  const control = new AbortController()
  const res = await call('/api/k/competitions/net-takogo/stream', {
    cookie: person.cookie,
    signal: control.signal,
  })
  control.abort()
  assert.equal(res.status, 404)
})

test("the stream gives one's own submissions, the queue place and not a single foreign field", async () => {
  const person = await join('Поток Второй')
  const mine = queue(person.id, 'mine.ipynb')
  // Someone else's submission queued EARLIER: it is the one that takes first
  // place in the queue.
  const other = await join('Поток Третий')
  queue(other.id, 'other.ipynb')

  const frame = await firstFrame(person.cookie)
  assert.equal(frame.status, 200)
  const body = JSON.parse(frame.data) as EntrantSubmissions
  assert.equal(body.submissions.length, 1)
  assert.equal(body.submissions[0].id, mine.id)
  assert.equal(body.live.length, 1)
  assert.equal(body.live[0].submissionId, mine.id)
  assert.ok((body.live[0].place ?? 0) >= 1, 'the queue place is not given')
  // Only someone else's work is ahead, and its number is not shown to the
  // entrant.
  assert.equal(body.live[0].aheadNumber, null)
  assert.equal(body.paused, false)

  // No teacher trace, no private score, no row-split seed.
  assert.doesNotMatch(frame.data, /teacherError/)
  assert.doesNotMatch(frame.data, /"privateScore":[^n]/)
  assert.doesNotMatch(frame.data, new RegExp(SEED_MARK))
  assert.doesNotMatch(frame.data, /def score/)
})

test('in the submission list the place and the wait estimate follow the same order as the executor', async () => {
  const person = await join('Очередь Моя')
  // A finished submission provides the average duration; without it there is
  // no estimate at all.
  const done = queue(person.id, 'done.ipynb')
  updateSubmission(done.id, { state: 'scored', stage: 'score', durationMs: 120_000, publicScore: 0.5 })

  const waiting = queue(person.id, 'waiting.ipynb')
  const res = await call('/api/k/competitions/live-k/submissions', { cookie: person.cookie })
  assert.equal(res.status, 200)
  const body = (await res.json()) as EntrantSubmissions
  const live = body.live.find((row) => row.submissionId === waiting.id)
  assert.ok(live, 'the waiting submission did not make it into the live state')
  assert.ok((live.place ?? 0) >= 1)
  assert.ok(live.etaMs !== null && live.etaMs >= 0, 'the wait estimate was not computed')
  assert.equal(live.limitMs, 600_000)
  assert.equal(live.startedAt, null)
})

test('a Pod deferred for lack of resources does not get a false queue place and time', async () => {
  const person = await join('Ожидание ресурсов')
  const deferred = queue(person.id, 'deferred.ipynb')
  db.prepare('UPDATE competition_queue SET resource_retries=1, not_before=? WHERE submission_id=?')
    .run(Date.now() + 60_000, deferred.id)
  const res = await call('/api/k/competitions/live-k/submissions', { cookie: person.cookie })
  assert.equal(res.status, 200)
  const body = (await res.json()) as EntrantSubmissions
  const live = body.live.find((row) => row.submissionId === deferred.id)
  assert.ok(live)
  assert.equal(live.resourcePending, true)
  assert.equal(live.place, null)
  assert.equal(live.etaMs, null)
})

/* -------------------------------------------------------- cancellation */

test('only its author can cancel a submission, and only while it has not finished', async () => {
  const person = await join('Отменяющий')
  const stranger = await join('Посторонний')
  const submission = queue(person.id, 'cancel-me.ipynb')

  const anonymous = await call(`/api/k/competitions/live-k/submissions/${submission.id}/cancel`, {
    method: 'POST',
  })
  assert.equal(anonymous.status, 401, 'the cancellation went through without a cookie')

  const alien = await call(`/api/k/competitions/live-k/submissions/${submission.id}/cancel`, {
    method: 'POST',
    cookie: stranger.cookie,
  })
  assert.equal(alien.status, 403, "someone else's submission was cancelled")
  assert.ok(queueRow(submission.id), "someone else's cancellation still touched the queue")

  const own = await call(`/api/k/competitions/live-k/submissions/${submission.id}/cancel`, {
    method: 'POST',
    cookie: person.cookie,
  })
  assert.equal(own.status, 200)
  const body = (await own.json()) as EntrantSubmissions
  assert.equal(body.submissions.find((s) => s.id === submission.id)?.state, 'cancelled')
  assert.equal(queueRow(submission.id), null, 'the cancelled submission stayed in the queue')
  // The cancellation trace is a teacher field and must not be in the answer to
  // the entrant.
  assert.doesNotMatch(JSON.stringify(body), /teacherError/)

  const again = await call(`/api/k/competitions/live-k/submissions/${submission.id}/cancel`, {
    method: 'POST',
    cookie: person.cookie,
  })
  assert.equal(again.status, 409, 'cancelling a finished submission pretended to succeed')
})

/* ------------------------------------------------------- leaderboard */

test("a leaderboard row carries the submission number and the author's choice, and not a single private score", async () => {
  const person = await join('Лидер Списка')
  const first = queue(person.id, 'a.ipynb')
  updateSubmission(first.id, {
    state: 'scored',
    stage: 'score',
    publicScore: 0.2,
    privateScore: 0.9,
    durationMs: 60_000,
  })
  const second = queue(person.id, 'b.ipynb')
  updateSubmission(second.id, {
    state: 'scored',
    stage: 'score',
    publicScore: 0.4,
    privateScore: 0.1,
    durationMs: 60_000,
  })
  assert.ok(chooseSubmission(competitionId, person.id, second.id))

  // The baseline is a submission of a service entrant, marked by the
  // competition.
  const baseline = await join('Базовый Прогон')
  const baseRun = queue(baseline.id, 'baseline.ipynb')
  updateSubmission(baseRun.id, {
    state: 'scored',
    stage: 'score',
    publicScore: 0.9,
    privateScore: 0.95,
    durationMs: 30_000,
  })
  updateCompetition(competitionId, { baselineSubmissionId: baseRun.id })

  const res = await call('/api/k/competitions/live-k/leaderboard', { cookie: person.cookie })
  assert.equal(res.status, 200)
  const raw = await res.text()
  const body = JSON.parse(raw) as EntrantLeaderboard
  const mine = body.public.find((line) => line.you)
  assert.ok(mine, "one's own row is missing from the leaderboard")
  // The chosen one is counted, not the best by score: that is the "chosen"
  // rule.
  assert.equal(mine.number, getSubmission(second.id)?.number)
  assert.equal(mine.chosen, true)
  assert.equal(mine.baseline, false)
  const base = body.public.find((line) => line.baseline)
  assert.ok(base, 'the baseline is not marked')
  assert.equal(base.you, false)

  // The place on the P1 card is counted among PEOPLE: the baseline is ahead of
  // everyone, and the place from the full table would show a person "2" where
  // they are alone.
  const card = await call('/api/k/competitions/live-k', { cookie: person.cookie })
  const view = (await card.json()) as { entrants: number; mine: { place: number | null } }
  assert.equal(view.mine.place, 1, 'the baseline took the place from a person')
  assert.equal(view.entrants >= 1, true)

  // Results are closed, so there is no private table at all, rather than an
  // "empty" one.
  assert.equal(body.private, null)
  assert.equal(body.privateOpen, false)
  assert.doesNotMatch(raw, /0\.95/)
  assert.doesNotMatch(raw, /teacherError/)
})

/**
 * A passed deadline closes submissions WITHOUT touching the competition state.
 *
 * `state` is switched to `finished` only by the teacher with the "Finish now"
 * button, and during the review they do not get to it right away. The
 * entrant page header (components/competitions/PageHeader.svelte) looks at
 * `accepting` rather than `competition.state` for exactly this reason: while
 * it looked at the state, a closed competition showed a "LIVE" badge next to
 * a "00:00" clock, whereas the P3 mockup draws "FINISHED" here. This field
 * ties the door and the screen together, so it is checked on a real response,
 * not on a pure function next to it.
 */
test('the deadline has passed: submissions are closed although the competition is still `live`', async () => {
  const person = await join('Дедлайн Дедлайнович')
  const before = (await (await call('/api/k/competitions/live-k', { cookie: person.cookie })).json()) as {
    competition: { state: string }
    accepting: string
  }
  assert.equal(before.accepting, 'open')

  updateCompetition(competitionId, { deadlineAt: Date.now() - 60_000 })
  try {
    const res = await call('/api/k/competitions/live-k', { cookie: person.cookie })
    const after = (await res.json()) as { competition: { state: string }; accepting: string }
    assert.equal(after.competition.state, 'live', 'the deadline must not change the state by itself')
    assert.equal(after.accepting, 'closed', 'submissions must close by themselves')

    // And the submit door says the same: two answers to one question are worse
    // than one wrong answer, and they diverge silently.
    const form = new FormData()
    form.append('file', new File([JSON.stringify({ nbformat: 4, cells: [] })], 'late.ipynb'), 'late.ipynb')
    const sent = await call('/api/k/competitions/live-k/submissions', {
      method: 'POST',
      cookie: person.cookie,
      body: form,
    })
    assert.equal(sent.status, 403)
    assert.equal(((await sent.json()) as { reason: string }).reason, 'closed')
  } finally {
    updateCompetition(competitionId, { deadlineAt: null })
  }
})

/**
 * After the deadline the counted submission cannot be switched — not even by
 * its owner.
 *
 * Results open at the deadline, and under "my submissions" a person sees the
 * private score of EACH of their submissions. While the choice stayed open,
 * anyone who had sent more than one simply counted the best one by the hidden
 * part: not a workaround of the rule but a direct fit to it — exactly what the
 * private part exists to prevent. The door treats this as a `closed` refusal,
 * not as "no right".
 */
test('after the deadline the counted submission cannot be switched', async () => {
  const person = await join('Поздний Выбор')
  const first = queue(person.id, 'a.ipynb')
  const second = queue(person.id, 'b.ipynb')
  for (const one of [first, second]) {
    updateSubmission(one.id, { state: 'scored', publicScore: 0.4, privateScore: 0.4 })
  }

  // Before the deadline the choice works and can change any number of times.
  const early = await call(`/api/k/competitions/live-k/submissions/${first.id}/choose`, {
    method: 'POST',
    cookie: person.cookie,
  })
  assert.equal(early.status, 200)
  assert.equal(getSubmission(first.id)?.chosen, true)

  updateCompetition(competitionId, { deadlineAt: Date.now() - 60_000 })
  try {
    const late = await call(`/api/k/competitions/live-k/submissions/${second.id}/choose`, {
      method: 'POST',
      cookie: person.cookie,
    })
    assert.equal(late.status, 403)
    assert.equal(((await late.json()) as { reason: string }).reason, 'closed')
    // The main thing: THE submission chosen before the deadline is still the
    // counted one.
    assert.equal(getSubmission(first.id)?.chosen, true)
    assert.equal(getSubmission(second.id)?.chosen, false)
  } finally {
    updateCompetition(competitionId, { deadlineAt: null })
  }
})
