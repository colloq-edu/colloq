/**
 * The judge's queue (server/src/contests/pump.ts) with a judge that runs
 * nothing (tests/_contests.mts · stubJudge): what goes into a request, what
 * comes out into the row, and the queue's manners — slots, the pause, one
 * judging per person, the teacher's runs first, the previous life's runs
 * picked up again, a shutdown that costs nobody a start.
 *
 * And the two runs that are the teacher's: the reference check, whose «passes»
 * must mean «on THESE tests with THESE limits», and the answers written by the
 * reference, which must become a new revision of the tests rather than
 * changing the one a judging may be reading.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { useContestJudge } from '../server/src/contests/judge/port.js'
import {
  addProblem,
  createContest,
  enqueueTeacherRun,
  getContest,
  getProblem,
  getSubmission,
  joinContest,
  listTests,
  rejudgeProblems,
  setContestState,
  startJudging,
  submitSolution,
  updateContest,
  updateProblem,
  replaceGroups,
} from '../server/src/contests/store.js'
import {
  drainContestJudge,
  forgetLanguageProbes,
  holdAndStop,
  judgeStatus,
  languageOptions,
  pauseContestJudge,
  pumpContestJudge,
  startContestJudge,
  stopContestJudge,
} from '../server/src/contests/pump.js'
import { contestReadiness, referenceStatus } from '../server/src/contests/readiness.js'
import { saveJudgeSlots } from '../server/src/contests/settings.js'
import { changeTests } from '../server/src/contests/revisions.js'
import { readTestFile, revisionExists, jobDir } from '../server/src/contests/storage.js'
import { createEntrant } from '../server/src/competitions/store.js'
import { db } from '../server/src/db.js'
import { stubJudge, type StubJudge } from './_contests.mts'

let judge: StubJudge

before(() => {
  judge = stubJudge()
  useContestJudge(judge)
})

beforeEach(async () => {
  // Every test starts with nothing waiting and the judge free.
  judge.holding = false
  judge.release()
  await drainContestJudge()
  db.prepare("UPDATE contest_submissions SET state = 'done', verdict = 'OK' WHERE state IN ('queued', 'running')").run()
  judge.requests.length = 0
  pauseContestJudge(false)
  saveJudgeSlots(4)
})

after(async () => {
  judge.release()
  await stopContestJudge()
  useContestJudge(null)
})

let made = 0
function fixture(rules: 'icpc' | 'ioi' = 'icpc', tests = 3) {
  made++
  const contest = createContest({ slug: `pump-${made}`, title: `Pump ${made}`, rules })!
  setContestState(contest.id, 'live')
  const problem = addProblem(contest.id, { title: 'Сумма', referenceSource: 'ok', timeLimitMs: 1000, memoryMb: 256 })
  assert.ok(problem !== 'full')
  changeTests(problem, Array.from({ length: tests }, (_, index) => ({
    sample: index === 0,
    group: index,
    input: { bytes: Buffer.from(`in ${index + 1}\n`) },
    answer: { bytes: Buffer.from(`ans ${index + 1}\n`) },
    answerFrom: 'upload' as const,
  })))
  return { contest: getContest(contest.id)!, problem: getProblem(problem.id)! }
}

function person(contestId: string, handle: string) {
  const entrant = createEntrant(handle).entrant
  assert.equal(joinContest(contestId, entrant.id, handle), 'ok')
  return entrant
}

function send(contestId: string, problemId: string, entrantId: string, source: string, at = Date.now()) {
  const sent = submitSolution({ contestId, problemId, entrantId, language: 'cpp20', source, late: false, attemptsPerProblem: 0 }, at)
  assert.ok('submission' in sent)
  return sent.submission
}

/* -------------------------------------------------------------- judging */

test('a request carries the pinned revision\'s tests, the answers as bytes, and a run directory not made yet', async () => {
  const { contest, problem } = fixture()
  const p = person(contest.id, '@req_p')
  const sent = send(contest.id, problem.id, p.id, 'ok')
  let jobExisted: boolean | null = null
  const original = judge.judge.bind(judge)
  judge.judge = async (request) => {
    jobExisted = fs.existsSync(request.jobDir)
    // The judge lays out its job there, as the docker judge does.
    fs.mkdirSync(request.jobDir)
    fs.writeFileSync(path.join(request.jobDir, 'job.json'), '{}')
    return original(request)
  }
  try {
    await drainContestJudge()
  } finally {
    judge.judge = original
  }
  const request = judge.requests.at(-1)!
  assert.equal(request.submissionId, sent.id)
  assert.equal(request.image, 'colloq-kernel:base')
  assert.equal(request.container, `colloq-contest-${sent.id}-1`)
  assert.equal(request.language, 'cpp20')
  assert.equal(request.mode, 'icpc')
  assert.equal(request.timeLimitMs, 1000)
  assert.deepEqual(request.tests.map((t) => [t.ordinal, t.sample, t.group, t.answer?.toString()]), [
    [1, true, 0, 'ans 1\n'],
    [2, false, 1, 'ans 2\n'],
    [3, false, 2, 'ans 3\n'],
  ])
  // The inputs' directory is the pinned revision's (no DATA_HOST_DIR here: the server's own path).
  assert.equal(fs.readFileSync(path.join(request.testsDir, '2.in'), 'utf8'), 'in 2\n')
  assert.equal(fs.existsSync(path.join(request.testsDir, '..', 'ans')), true)
  assert.equal(fs.readdirSync(request.testsDir).some((name) => name.endsWith('.ans')), false, 'no answer lies among the inputs')
  assert.deepEqual(request.checker, { kind: 'tokens', epsilon: problem.checkerEpsilon, code: '' })
  assert.equal(jobExisted, false, 'the run directory is the judge\'s to create, fresh')
  assert.equal(fs.existsSync(jobDir(contest.id, sent.id, 1)), false, 'and it is gone after the run')
  const row = getSubmission(sent.id)!
  assert.equal(row.state, 'done')
  assert.equal(row.verdict, 'OK')
  assert.equal(row.passed, 3)
  assert.equal(row.total, 3)
  assert.equal(row.testsRevision, problem.testsRevision)
  assert.equal(row.score, null, 'no points under ICPC')
})

test('the report keeps everything, with the data of the examples and of the failed test', async () => {
  const { contest, problem } = fixture()
  const p = person(contest.id, '@report_p')
  const sent = send(contest.id, problem.id, p.id, 'wa 2')
  await drainContestJudge()
  const row = getSubmission(sent.id)!
  assert.equal(row.verdict, 'WA')
  assert.equal(row.failedTest, 2)
  assert.equal(row.passed, 1)
  const tests = row.report!.tests
  // ICPC stops at the first failure: test 3 never ran.
  assert.deepEqual(tests.map((t) => [t.ordinal, t.verdict]), [[1, 'OK'], [2, 'WA']])
  assert.equal(tests[0].input, 'in 1\n')
  assert.equal(tests[0].answer, 'ans 1\n')
  assert.equal(tests[1].input, 'in 2\n', 'the failed test\'s data, for the teacher\'s drawer')
  assert.equal(tests[1].answer, 'ans 2\n')
  assert.equal(tests[1].note, 'token 1: expected 5, got 4')
  assert.equal(tests[1].exit, 'exit 0')
  assert.equal(tests[1].group, 1)
})

test('IOI counts points here, from the verdicts: the examples are free, the rest share 100', async () => {
  const { contest, problem } = fixture('ioi')
  const p = person(contest.id, '@ioi_p')
  const half = send(contest.id, problem.id, p.id, 'wa 3')
  await drainContestJudge()
  const row = getSubmission(half.id)!
  assert.equal(row.verdict, 'WA')
  // IOI goes on past a failure: every test has a verdict.
  assert.deepEqual(row.report!.tests.map((t) => t.verdict), ['OK', 'OK', 'WA'])
  assert.equal(row.score, 50)
  assert.equal(judge.requests.at(-1)!.mode, 'ioi')
  const ce = send(contest.id, problem.id, p.id, 'ce')
  await drainContestJudge()
  assert.equal(getSubmission(ce.id)!.verdict, 'CE')
  assert.equal(getSubmission(ce.id)!.score, 0)
  assert.match(getSubmission(ce.id)!.compileLog, /expected unqualified-id/)
})

test('a judge that throws is the judge\'s failure: SE, the reason for the teacher, no attempt spent', async () => {
  const { contest, problem } = fixture()
  const p = person(contest.id, '@se_p')
  const sent = send(contest.id, problem.id, p.id, 'se')
  await drainContestJudge()
  const row = getSubmission(sent.id)!
  assert.equal(row.state, 'failed')
  assert.equal(row.verdict, 'SE')
  assert.match(row.systemDetail ?? '', /docker said no/)
})

test('progress is written while a run goes, and cleared with the verdict', async () => {
  const { contest, problem } = fixture('icpc', 3)
  const p = person(contest.id, '@progress_p')
  const sent = send(contest.id, problem.id, p.id, 'ok')
  const seen: Array<number | null> = []
  const original = judge.judge.bind(judge)
  judge.judge = async (request) => {
    request.onProgress?.({ phase: 'compile', test: null, done: 0, total: 3 })
    request.onProgress?.({ phase: 'test', test: 1, done: 0, total: 3 })
    seen.push(getSubmission(sent.id)!.progress)
    // A second report within the second is not written…
    request.onProgress?.({ phase: 'test', test: 2, done: 1, total: 3 })
    seen.push(getSubmission(sent.id)!.progress)
    // …the last one always is.
    request.onProgress?.({ phase: 'test', test: null, done: 3, total: 3 })
    seen.push(getSubmission(sent.id)!.progress)
    return original({ ...request, onProgress: undefined })
  }
  try {
    await drainContestJudge()
  } finally {
    judge.judge = original
  }
  assert.deepEqual(seen, [0, 0, 3])
  assert.equal(getSubmission(sent.id)!.progress, null)
})

/* ---------------------------------------------------------- the queue */

test('slots: no more judgings at once than the setting, and a freed slot is filled at once', async () => {
  saveJudgeSlots(1)
  const { contest, problem } = fixture()
  const a = person(contest.id, '@slots_a')
  const b = person(contest.id, '@slots_b')
  const first = send(contest.id, problem.id, a.id, 'ok', Date.now() - 2)
  const second = send(contest.id, problem.id, b.id, 'ok', Date.now() - 1)
  judge.holding = true
  assert.equal(pumpContestJudge(), 1)
  assert.equal(getSubmission(first.id)!.state, 'running')
  assert.equal(getSubmission(second.id)!.state, 'queued')
  assert.equal(judgeStatus().running, 1)
  judge.holding = false
  judge.release()
  await drainContestJudge()
  assert.equal(getSubmission(second.id)!.state, 'done')
})

test('one judging per person: the class does not wait behind the student who pressed five times', async () => {
  saveJudgeSlots(4)
  const { contest, problem } = fixture()
  const eager = person(contest.id, '@eager_one')
  const calm = person(contest.id, '@calm_one')
  const t0 = Date.now() - 100
  const e1 = send(contest.id, problem.id, eager.id, 'ok', t0)
  const e2 = send(contest.id, problem.id, eager.id, 'ok', t0 + 1)
  const c1 = send(contest.id, problem.id, calm.id, 'ok', t0 + 2)
  judge.holding = true
  assert.equal(pumpContestJudge(), 2)
  assert.equal(getSubmission(e1.id)!.state, 'running')
  assert.equal(getSubmission(e2.id)!.state, 'queued')
  assert.equal(getSubmission(c1.id)!.state, 'running')
  judge.holding = false
  judge.release()
  await drainContestJudge()
  assert.equal(getSubmission(e2.id)!.state, 'done')
})

test('the teacher\'s runs go first, and the pause starts nothing until it is lifted', async () => {
  saveJudgeSlots(1)
  const { contest, problem } = fixture()
  const p = person(contest.id, '@pause_p')
  const early = send(contest.id, problem.id, p.id, 'ok', Date.now() - 60_000)
  const reference = enqueueTeacherRun(problem, 'reference')
  pauseContestJudge(true)
  assert.equal(pumpContestJudge(), 0)
  assert.equal(judgeStatus().paused, true)
  assert.equal(getSubmission(reference.id)!.state, 'queued')
  pauseContestJudge(false)
  judge.holding = true
  assert.equal(pumpContestJudge(), 1)
  assert.equal(getSubmission(reference.id)!.state, 'running', 'the reference, though sent later')
  assert.equal(getSubmission(early.id)!.state, 'queued')
  judge.holding = false
  judge.release()
  await drainContestJudge()
})

test('a restart: the previous life\'s runs are requeued and the judge\'s leftovers swept; a shutdown counts no start', async () => {
  const { contest, problem } = fixture()
  const p = person(contest.id, '@restart_p')
  const orphan = send(contest.id, problem.id, p.id, 'ok')
  // Started by another process life, which then died.
  assert.ok(startJudging(orphan.id, 'the-life-before'))
  const sweeps = judge.sweeps
  judge.holding = true
  await startContestJudge()
  assert.equal(judge.sweeps, sweeps + 1)
  // Requeued, and taken again by this life's pump at once.
  const running = getSubmission(orphan.id)!
  assert.equal(running.state, 'running')
  assert.equal(running.attempt, 2)
  assert.equal(running.starts, 2)
  // A shutdown now: back to the queue, this start not counted, and nothing written.
  await stopContestJudge()
  const stopped = getSubmission(orphan.id)!
  assert.equal(stopped.state, 'queued')
  assert.equal(stopped.starts, 1)
  assert.equal(stopped.verdict, null)
  judge.holding = false
  judge.release()
  await drainContestJudge()
  assert.equal(getSubmission(orphan.id)!.verdict, 'OK')
})

test('a judging stopped for a removal never writes the judge\'s «aborted» as a verdict; held back, it waits', async () => {
  const { contest, problem } = fixture()
  const p = person(contest.id, '@held_back')
  const sent = send(contest.id, problem.id, p.id, 'ok')
  judge.holding = true
  assert.equal(pumpContestJudge(), 1)
  assert.equal(getSubmission(sent.id)!.state, 'running')
  // A removal begins: the scope is held, the run requeued and killed.
  const stop = await holdAndStop({ contestId: contest.id, entrantId: p.id })
  assert.equal(stop.ended, true)
  const after = getSubmission(sent.id)!
  assert.equal(after.state, 'queued', 'the «aborted» SE the judge reported was not written')
  assert.equal(after.verdict, null)
  assert.equal(after.starts, 0)
  // While held, the pump passes it over — and takes others.
  const other = person(contest.id, '@not_held')
  const theirs = send(contest.id, problem.id, other.id, 'ok')
  judge.holding = false
  await drainContestJudge()
  assert.equal(getSubmission(sent.id)!.state, 'queued')
  assert.equal(getSubmission(theirs.id)!.verdict, 'OK')
  // The removal was refused after all: let go, it is judged as if nothing happened.
  stop.release()
  await drainContestJudge()
  assert.equal(getSubmission(sent.id)!.verdict, 'OK')
})

/* ------------------------------------------------------ the reference */

test('the reference passes on THESE tests with THESE limits: a changed limit or tests make it unchecked', async () => {
  const { contest, problem } = fixture()
  assert.equal(referenceStatus(problem).state, 'unchecked')
  enqueueTeacherRun(problem, 'reference')
  assert.equal(referenceStatus(problem).state, 'queued')
  await drainContestJudge()
  let status = referenceStatus(getProblem(problem.id)!)
  assert.equal(status.state, 'passes')
  assert.equal(status.slowestTest, 3)
  assert.ok(status.submissionId)
  // A tighter limit: what passed under one second says nothing about half of it.
  updateProblem(problem.id, { timeLimitMs: 500 })
  assert.equal(referenceStatus(getProblem(problem.id)!).state, 'unchecked')
  updateProblem(problem.id, { timeLimitMs: 1000 })
  assert.equal(referenceStatus(getProblem(problem.id)!).state, 'passes', 'back to the limits it was checked under')
  // New tests: unchecked again.
  const now = getProblem(problem.id)!
  changeTests(now, [{ sample: false, group: 0, input: { bytes: Buffer.from('x') }, answer: { bytes: Buffer.from('y') }, answerFrom: 'upload' }])
  assert.equal(referenceStatus(getProblem(problem.id)!).state, 'unchecked')
  // A failing reference says how.
  updateProblem(problem.id, { referenceSource: 'wa 1' })
  enqueueTeacherRun(getProblem(problem.id)!, 'reference')
  await drainContestJudge()
  status = referenceStatus(getProblem(problem.id)!)
  assert.equal(status.state, 'fails')
  assert.equal(status.verdict, 'WA')
  assert.equal(status.failedTest, 1)
  void contest
})

test('the reference writes the missing answers as a NEW revision, keeps the uploaded ones, then checks itself', async () => {
  const { contest, problem } = fixture()
  // Test 1 keeps its uploaded answer; 2 and 3 have none.
  changeTests(problem, [
    { sample: true, group: 0, input: { bytes: Buffer.from('a b\n') }, answer: { bytes: Buffer.from('UPLOADED\n') }, answerFrom: 'upload' },
    { sample: false, group: 0, input: { bytes: Buffer.from('c d\n') }, answer: null, answerFrom: 'upload' },
    { sample: false, group: 0, input: { bytes: Buffer.from('e f\n') }, answer: null, answerFrom: 'upload' },
  ])
  const before = getProblem(problem.id)!
  const run = enqueueTeacherRun(before, 'answers')
  await drainContestJudge()
  const request = judge.requests.find((one) => one.submissionId === run.id)!
  assert.equal(request.mode, 'answers')
  assert.ok(request.tests.every((test) => test.answer === null), 'nothing to compare with while answers are written')
  const after = getProblem(problem.id)!
  assert.ok(after.testsRevision > before.testsRevision, 'a new revision')
  assert.deepEqual(listTests(problem.id).map((t) => [t.answerFrom, t.answerBytes]), [['upload', 9], ['reference', 4], ['reference', 4]])
  assert.equal(readTestFile(contest.id, problem.id, after.testsRevision, 1, 'ans').toString(), 'UPLOADED\n')
  assert.equal(readTestFile(contest.id, problem.id, after.testsRevision, 2, 'ans').toString(), 'C D\n')
  assert.equal(revisionExists(contest.id, problem.id, before.testsRevision), false, 'the old revision went with nothing pinning it')
  // The revision moved, so the reference was checked again by itself.
  assert.equal(referenceStatus(after).state, 'passes')
})

test('answers from a run whose tests changed meanwhile are not written', async () => {
  const { problem } = fixture()
  changeTests(problem, [{ sample: false, group: 0, input: { bytes: Buffer.from('q\n') }, answer: null, answerFrom: 'upload' }])
  const run = enqueueTeacherRun(getProblem(problem.id)!, 'answers')
  judge.holding = true
  pumpContestJudge()
  // The teacher uploads new tests while the reference runs.
  changeTests(getProblem(problem.id)!, [{ sample: false, group: 0, input: { bytes: Buffer.from('new\n') }, answer: null, answerFrom: 'upload' }])
  judge.holding = false
  judge.release()
  await drainContestJudge()
  const row = getSubmission(run.id)!
  assert.equal(row.verdict, 'SE')
  assert.match(row.systemDetail ?? '', /\S/)
  assert.deepEqual(listTests(problem.id).map((t) => t.answerBytes), [null], 'the new tests are untouched')
})

test('a verdict on old tests is stale: a stale-only rejudge judges it again on the current ones', async () => {
  const { contest, problem } = fixture()
  const p = person(contest.id, '@stale_p')
  const sent = send(contest.id, problem.id, p.id, 'ok')
  await drainContestJudge()
  const first = getSubmission(sent.id)!
  changeTests(getProblem(problem.id)!, [{ sample: false, group: 0, input: { bytes: Buffer.from('1') }, answer: { bytes: Buffer.from('2') }, answerFrom: 'upload' }])
  const current = getProblem(problem.id)!
  assert.notEqual(first.testsRevision, current.testsRevision)
  assert.equal(rejudgeProblems([current], true), 1)
  await drainContestJudge()
  const again = getSubmission(sent.id)!
  assert.equal(again.testsRevision, current.testsRevision)
  assert.equal(again.total, 1)
})

test('IOI groups changed: the judged submissions get their points anew without running again', async () => {
  const { contest, problem } = fixture('ioi')
  updateProblem(problem.id, { points: 'groups' })
  replaceGroups(problem.id, [{ group: 1, points: 30 }, { group: 2, points: 70 }])
  const p = person(contest.id, '@groups_p')
  const sent = send(contest.id, problem.id, p.id, 'wa 3')
  await drainContestJudge()
  assert.equal(getSubmission(sent.id)!.score, 30)
  void updateContest
})

/* -------------------------------------------------- languages, readiness */

test('the languages come from the image, and a failed probe makes none available', async () => {
  forgetLanguageProbes()
  judge.probeAnswer = { python: '3.11.9', gpp: '12.2.0', gcc: null }
  const options = await languageOptions('base')
  assert.deepEqual(options.map((o) => [o.id, o.available]), [['python3', true], ['cpp20', true], ['c17', false]])
  assert.match(options[0].label, /^Python 3\.11/)
  assert.match(options[1].label, /g\+\+ 12/)
  forgetLanguageProbes()
  judge.probeAnswer = new Error('no such image')
  const none = await languageOptions('missing-env')
  assert.ok(none.every((option) => !option.available))
  judge.probeAnswer = { python: '3.11.9', gpp: '12.2.0', gcc: null }
  forgetLanguageProbes()
})

test('readiness names every missing piece, and an empty list once the contest is whole', async () => {
  forgetLanguageProbes()
  const contest = createContest({ slug: 'ready-or-not', title: 'Ready' })!
  assert.ok((await contestReadiness(contest)).some((reason) => /задач|problem/i.test(reason)))
  const problem = addProblem(contest.id, { title: 'A' })
  assert.ok(problem !== 'full')
  let reasons = await contestReadiness(contest)
  assert.equal(reasons.length, 1, reasons.join(' | '))
  changeTests(problem, [
    { sample: true, group: 0, input: { bytes: Buffer.from('1') }, answer: null, answerFrom: 'upload' },
  ])
  reasons = await contestReadiness(contest)
  assert.equal(reasons.length, 2, reasons.join(' | '))
  updateProblem(problem.id, { referenceSource: 'ok' })
  enqueueTeacherRun(getProblem(problem.id)!, 'answers')
  await drainContestJudge()
  reasons = await contestReadiness(getContest(contest.id)!)
  assert.deepEqual(reasons, [])
  // Dates that make no sense, and an image that runs none of its languages.
  updateContest(contest.id, { endsAt: Date.now() - 1000 })
  assert.equal((await contestReadiness(getContest(contest.id)!)).length, 1)
  updateContest(contest.id, { endsAt: null, languages: ['c17'] })
  assert.equal((await contestReadiness(getContest(contest.id)!)).length, 1)
})

test('without a judge here: the strip says none, and readiness says why', async () => {
  useContestJudge(null)
  const saved = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = 'broker'
  try {
    assert.equal(judgeStatus().backend, 'none')
    const contest = createContest({ slug: 'no-judge-here', title: 'None' })!
    const reasons = await contestReadiness(contest)
    assert.ok(reasons.length >= 2)
    assert.equal(pumpContestJudge(), 0)
  } finally {
    if (saved === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = saved
    useContestJudge(judge)
  }
})
