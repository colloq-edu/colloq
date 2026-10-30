/**
 * The contests' rows (server/src/contests/store.ts): what the database holds
 * and the rules only the database can hold.
 *
 * The participant is the competitions' entrant, so the most expensive bugs
 * here are on the border between the two: a person removed from a
 * competition losing the key their contest still opens with, a rename in one
 * module making namesakes in the other. The queue is the table, so its order
 * — the teacher's runs first, one judging per person, then by time — and its
 * memory of the previous process life are pinned here too.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../server/src/db.js'
import {
  BOOT,
  addProblem,
  announce,
  answerQuestion,
  askQuestion,
  attemptsUsed,
  contestEntrants,
  contestJoinedAt,
  createContest,
  deleteContestRows,
  deleteProblemRows,
  enqueueTeacherRun,
  finishJudging,
  findContest,
  getContest,
  getProblem,
  getSubmission,
  joinContest,
  joinContestAsNewcomer,
  listProblems,
  listQuestions,
  markQuestionsSeen,
  MAX_STARTS,
  nextQueued,
  pendingCount,
  questionsSeenAt,
  questionsVisibleTo,
  rejudgeProblems,
  rejudgeSubmission,
  removeContestEntrantRows,
  reorderProblems,
  replaceGroups,
  requeueOrphans,
  requeueStopped,
  setContestHidden,
  setContestState,
  startJudging,
  submitSolution,
  unreadFor,
  updateContest,
  type JudgingResult,
} from '../server/src/contests/store.js'
import {
  createCompetition,
  createEntrant,
  getEntrant,
  joinCompetition,
  removeEntrantRows,
  renameEntrant,
} from '../server/src/competitions/store.js'
import { changeTests } from '../server/src/contests/revisions.js'
import { watchContest, type ContestEvent } from '../server/src/contests/events.js'

/** Everything said about one contest from now on. */
function contestEvents(contestId: string): ContestEvent[] {
  const heard: ContestEvent[] = []
  watchContest(contestId, (event) => heard.push(event))
  return heard
}

let made = 0
function contestFixture(rules: 'icpc' | 'ioi' = 'icpc') {
  made++
  const contest = createContest({ slug: `store-${made}`, title: `Store ${made}`, rules })!
  setContestState(contest.id, 'live')
  return getContest(contest.id)!
}

function problemOf(contestId: string, title = 'A') {
  const problem = addProblem(contestId, { title })
  assert.ok(problem !== 'full')
  return problem
}

function withTests(problemId: string, count = 3) {
  const problem = getProblem(problemId)!
  changeTests(problem, Array.from({ length: count }, (_, index) => ({
    sample: index === 0,
    group: index,
    input: { bytes: Buffer.from(`${index + 1}\n`) },
    answer: { bytes: Buffer.from(`${index + 2}\n`) },
    answerFrom: 'upload' as const,
  })))
  return getProblem(problemId)!
}

function send(contestId: string, problemId: string, entrantId: string, at = Date.now(), source = 'ok') {
  const sent = submitSolution({ contestId, problemId, entrantId, language: 'python3', source, late: false, attemptsPerProblem: 0 }, at)
  assert.ok('submission' in sent, JSON.stringify(sent))
  return sent.submission
}

function done(verdict: JudgingResult['verdict']): JudgingResult {
  return {
    state: verdict === 'SE' ? 'failed' : 'done',
    verdict,
    failedTest: verdict === 'OK' ? null : 1,
    passed: verdict === 'OK' ? 3 : 0,
    total: 3,
    score: null,
    timeMs: 10,
    memoryKb: 1000,
    compileLog: '',
    report: { tests: [] },
    systemDetail: null,
    judgedAt: Date.now(),
  }
}

/* --------------------------------------------------------------- contests */

test('an address is one contest\'s: the index decides, on create and on edit', () => {
  const one = createContest({ slug: 'taken-slug', title: 'One' })
  assert.ok(one)
  assert.equal(one.state, 'draft')
  assert.equal(createContest({ slug: 'taken-slug', title: 'Two' }), null)
  const two = createContest({ slug: 'other-slug', title: 'Two' })!
  assert.equal(updateContest(two.id, { slug: 'taken-slug' }), 'taken')
  assert.equal(findContest('taken-slug')?.id, one.id)
  assert.equal(findContest(one.id)?.slug, 'taken-slug')
  // The defaults of a new contest.
  assert.deepEqual(
    [one.rules, one.penaltyMinutes, one.freezeMinutes, one.attemptsPerProblem, one.languages, one.environment, one.upsolving, one.boardVisibility],
    ['icpc', 20, 0, 0, ['python3', 'cpp20'], 'base', false, 'public'],
  )
})

test('the revision moves by itself on every change a page can see, and not on the reference', () => {
  const contest = createContest({ slug: 'revisions', title: 'Rev' })!
  const at = () => getContest(contest.id)!.revision
  let last = at()
  const moved = (what: string) => {
    const now = at()
    assert.ok(now > last, `${what} did not move the revision`)
    last = now
  }
  updateContest(contest.id, { title: 'Rev 2' })
  moved('a title')
  const problem = problemOf(contest.id)
  moved('a new problem')
  db.prepare('UPDATE contest_problems SET statement = ? WHERE id = ?').run('new words', problem.id)
  moved('a statement')
  db.prepare('UPDATE contest_problems SET reference_source = ? WHERE id = ?').run('print(1)', problem.id)
  assert.equal(at(), last, 'the reference is no participant\'s business')
  replaceGroups(problem.id, [{ group: 1, points: 50 }])
  moved('the groups')
  withTests(problem.id, 1)
  moved('the tests')
  setContestHidden(contest.id, Date.now())
  moved('taking it off publication')
})

test('problems keep dense positions: a deletion closes the gap, a reorder names every one once', () => {
  const contest = contestFixture()
  const [a, b, c] = ['A', 'B', 'C'].map((title) => problemOf(contest.id, title))
  assert.deepEqual(listProblems(contest.id).map((p) => [p.title, p.position]), [['A', 0], ['B', 1], ['C', 2]])
  assert.equal(reorderProblems(contest.id, [c.id, a.id]), false)
  assert.equal(reorderProblems(contest.id, [c.id, a.id, a.id]), false)
  assert.equal(reorderProblems(contest.id, [c.id, a.id, b.id]), true)
  assert.deepEqual(listProblems(contest.id).map((p) => p.title), ['C', 'A', 'B'])
  assert.deepEqual(deleteProblemRows(a.id), { contestId: contest.id })
  assert.deepEqual(listProblems(contest.id).map((p) => [p.title, p.position]), [['C', 0], ['B', 1]])
  // A title not given is the letter's own.
  const d = problemOf(contest.id, '')
  assert.match(d.title, /C$/)
  // Twenty-six letters, no more.
  for (let i = listProblems(contest.id).length; i < 26; i++) problemOf(contest.id, `P${i}`)
  assert.equal(addProblem(contest.id, { title: 'one too many' }), 'full')
})

/* --------------------------------------------------------------- joining */

test('a newcomer joins with a key; a namesake is refused before anything is minted', () => {
  const contest = contestFixture()
  const before = (db.prepare('SELECT COUNT(*) AS n FROM entrants').get() as { n: number }).n
  const minted = joinContestAsNewcomer(contest.id, '@anya_smirnova')
  assert.ok(minted !== 'taken')
  assert.match(minted.key, /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/)
  assert.ok(contestJoinedAt(contest.id, minted.entrant.id))
  assert.equal(joinContestAsNewcomer(contest.id, '@Anya_Smirnova'), 'taken')
  const after = (db.prepare('SELECT COUNT(*) AS n FROM entrants').get() as { n: number }).n
  assert.equal(after, before + 1, 'the refused newcomer left no identity behind')
})

test('a person has one name: joining under a new one renames them everywhere, and a clash anywhere refuses it all', () => {
  const left = contestFixture()
  const right = contestFixture()
  const competition = createCompetition({ slug: `with-contests-${made}`, title: 'Both' })!
  const lena = createEntrant('@lena_one').entrant
  const kira = createEntrant('@kira_two').entrant
  assert.equal(joinContest(left.id, lena.id, '@lena_one'), 'ok')
  assert.equal(joinCompetition(competition.id, lena.id, '@lena_one'), 'ok')
  assert.equal(joinContest(right.id, kira.id, '@kira_two'), 'ok')
  // Lena takes Kira's name in the contest where Kira is not: refused all the same —
  // Lena is also in the competition... and Kira joins it under her name first.
  assert.equal(joinCompetition(competition.id, kira.id, '@kira_two'), 'ok')
  assert.equal(joinContest(left.id, lena.id, '@kira_two'), 'taken')
  assert.equal(getEntrant(lena.id)!.name, '@lena_one', 'a refused join renamed nobody')
  // A free name renames her in both modules' keys.
  assert.equal(joinContest(left.id, lena.id, '@lena_new'), 'ok')
  assert.equal(getEntrant(lena.id)!.name, '@lena_new')
  const keys = db.prepare('SELECT name_key FROM contest_entrants WHERE entrant_id = ?').all(lena.id) as { name_key: string }[]
  assert.deepEqual(keys.map((row) => row.name_key), ['@lena_new'])
  const competitionKey = db.prepare('SELECT name_key FROM competition_entrants WHERE entrant_id = ?').get(lena.id) as { name_key: string }
  assert.equal(competitionKey.name_key, '@lena_new')
})

test('a rename made on the competitions\' side is caught up with before a contest judges a namesake', () => {
  const contest = contestFixture()
  const masha = createEntrant('@masha_old').entrant
  assert.equal(joinContest(contest.id, masha.id, '@masha_old'), 'ok')
  // The teacher renames her in the competitions' panel: their keys only.
  assert.equal(renameEntrant(masha.id, '@masha_new'), 'ok')
  // A newcomer under her new name: refused against her CURRENT name, not the stale key.
  assert.equal(joinContestAsNewcomer(contest.id, '@masha_new'), 'taken')
  // And the old name is free again.
  assert.notEqual(joinContestAsNewcomer(contest.id, '@masha_old'), 'taken')
})

/* ----------------------------------------------------- removing a person */

test('removing a person from a competition keeps the identity a contest still uses', () => {
  const contest = contestFixture()
  const competition = createCompetition({ slug: `removal-${made}`, title: 'Removal' })!
  const pavel = createEntrant('@pavel_both').entrant
  assert.equal(joinCompetition(competition.id, pavel.id, '@pavel_both'), 'ok')
  assert.equal(joinContest(contest.id, pavel.id, '@pavel_both'), 'ok')
  const removed = removeEntrantRows(competition.id, pavel.id)
  assert.ok(removed !== 'running')
  assert.equal(removed.identityRemoved, false)
  assert.ok(getEntrant(pavel.id), 'the key still opens the contest')
  // And the other way: removed from the contest, with no competition left, the person goes.
  const out = removeContestEntrantRows(contest.id, pavel.id)
  assert.ok(out !== 'running')
  assert.equal(out.identityRemoved, true)
  assert.equal(getEntrant(pavel.id), null)
})

test('removing a person from a contest keeps the identity a competition still uses, and takes only their rows', () => {
  const contest = contestFixture()
  const problem = withTests(problemOf(contest.id).id)
  const competition = createCompetition({ slug: `removal-other-${made}`, title: 'Removal' })!
  const ira = createEntrant('@ira_both').entrant
  const oleg = createEntrant('@oleg_stays').entrant
  assert.equal(joinCompetition(competition.id, ira.id, '@ira_both'), 'ok')
  assert.equal(joinContest(contest.id, ira.id, '@ira_both'), 'ok')
  assert.equal(joinContest(contest.id, oleg.id, '@oleg_stays'), 'ok')
  const iras = send(contest.id, problem.id, ira.id)
  const olegs = send(contest.id, problem.id, oleg.id)
  const asked = askQuestion(contest.id, ira.id, null, 'Можно ли numpy?')
  const told = askQuestion(contest.id, ira.id, null, 'Ввод с пробелами?')
  answerQuestion(told.id, 'Да, через пробел.', true, null)
  // A running judging refuses the removal, nothing touched.
  const running = startJudging(iras.id)!
  assert.equal(running.submission.entrantId, ira.id)
  assert.equal(removeContestEntrantRows(contest.id, ira.id), 'running')
  assert.ok(finishJudging(running.submission.id, running.submission.attempt, done('OK')))
  const out = removeContestEntrantRows(contest.id, ira.id)
  assert.ok(out !== 'running')
  assert.equal(out.identityRemoved, false)
  assert.equal(out.submissions.length, 1)
  assert.ok(getEntrant(ira.id))
  assert.equal(contestJoinedAt(contest.id, ira.id), null)
  assert.ok(getSubmission(olegs.id), "another person's submission stays")
  // Her private question went; the one answered to everyone stays, an announcement with no asker.
  const left = listQuestions(contest.id)
  assert.equal(left.some((q) => q.id === asked.id), false)
  const kept = left.find((q) => q.id === told.id)!
  assert.equal(kept.entrantId, null)
  assert.equal(kept.question, '')
  assert.equal(kept.answer, 'Да, через пробел.')
})

/* ----------------------------------------------------------- submissions */

test('numbers go #1, #2… per contest for people; the teacher\'s runs are #0', () => {
  const contest = contestFixture()
  const problem = withTests(problemOf(contest.id).id)
  const a = createEntrant('@number_a').entrant
  const b = createEntrant('@number_b').entrant
  joinContest(contest.id, a.id, '@number_a')
  joinContest(contest.id, b.id, '@number_b')
  assert.equal(send(contest.id, problem.id, a.id).number, 1)
  assert.equal(send(contest.id, problem.id, b.id).number, 2)
  const reference = enqueueTeacherRun({ ...problem, referenceSource: 'ok' }, 'reference')
  assert.equal(reference.number, 0)
  assert.equal(reference.entrantId, null)
  // A second press while the first still waits is the same run, with the latest source.
  const again = enqueueTeacherRun({ ...problem, referenceSource: 'ok 2' }, 'reference')
  assert.equal(again.id, reference.id)
  assert.equal(getSubmission(reference.id)!.source, 'ok 2')
})

test('two waiting per person per contest, and the attempts limit counts what the shared rule spends', () => {
  const contest = contestFixture()
  const problem = withTests(problemOf(contest.id).id)
  const p = createEntrant('@limits_p').entrant
  joinContest(contest.id, p.id, '@limits_p')
  const one = send(contest.id, problem.id, p.id)
  const two = send(contest.id, problem.id, p.id)
  assert.equal(pendingCount(contest.id, p.id), 2)
  const third = submitSolution({ contestId: contest.id, problemId: problem.id, entrantId: p.id, language: 'python3', source: 'x', late: false, attemptsPerProblem: 0 })
  assert.deepEqual(third, { refusal: 'in_flight' })
  // While both are judged or waiting, both spend the limit.
  assert.equal(attemptsUsed(contest.id, problem.id, p.id), 2)
  // Judge them: one CE (free), one WA (spends).
  const first = startJudging(one.id)!
  finishJudging(first.submission.id, first.submission.attempt, done('CE'))
  const second = startJudging(two.id)!
  finishJudging(second.submission.id, second.submission.attempt, done('WA'))
  assert.equal(attemptsUsed(contest.id, problem.id, p.id), 1)
  const limited = (late: boolean) =>
    submitSolution({ contestId: contest.id, problemId: problem.id, entrantId: p.id, language: 'python3', source: 'x', late, attemptsPerProblem: 1 })
  assert.deepEqual(limited(false), { refusal: 'attempts' })
  // Upsolving is outside the limit, as it is outside the board.
  assert.ok('submission' in limited(true))
})

/* ------------------------------------------------------------------ queue */

test('the queue: the teacher\'s runs first, then by the moment of sending, never two of one person at once', () => {
  // A clean queue for this test: everything earlier is judged away.
  db.prepare("UPDATE contest_submissions SET state = 'done', verdict = 'OK' WHERE state IN ('queued', 'running')").run()
  const contest = contestFixture()
  const problem = withTests(problemOf(contest.id).id)
  const anna = createEntrant('@queue_anna').entrant
  const boris = createEntrant('@queue_boris').entrant
  joinContest(contest.id, anna.id, '@queue_anna')
  joinContest(contest.id, boris.id, '@queue_boris')
  const t0 = Date.now() - 10_000
  const anna1 = send(contest.id, problem.id, anna.id, t0)
  const anna2 = send(contest.id, problem.id, anna.id, t0 + 1)
  const boris1 = send(contest.id, problem.id, boris.id, t0 + 2)
  const reference = enqueueTeacherRun({ ...problem, referenceSource: 'ok' }, 'reference')
  assert.equal(nextQueued()!.id, reference.id, 'the teacher\'s run goes first')
  const ref = startJudging(reference.id)!
  assert.equal(nextQueued()!.id, anna1.id)
  const a1 = startJudging(anna1.id)!
  // Anna has one running: her second waits, Boris goes ahead.
  assert.equal(nextQueued()!.id, boris1.id)
  assert.equal(startJudging(anna2.id), null, 'a second judging of one person is refused even when asked by id')
  const b1 = startJudging(boris1.id)!
  assert.equal(nextQueued(), null)
  finishJudging(a1.submission.id, a1.submission.attempt, done('OK'))
  assert.equal(nextQueued()!.id, anna2.id)
  // The pin: a started judging names the tests revision it reads.
  assert.equal(b1.submission.testsRevision, problem.testsRevision)
  assert.equal(b1.tests.length, 3)
  finishJudging(b1.submission.id, b1.submission.attempt, done('OK'))
  finishJudging(ref.submission.id, ref.submission.attempt, done('OK'))
})

test('an outcome is written only into the run that produced it', () => {
  const contest = contestFixture()
  const problem = withTests(problemOf(contest.id).id)
  const p = createEntrant('@outcome_p').entrant
  joinContest(contest.id, p.id, '@outcome_p')
  const sent = send(contest.id, problem.id, p.id)
  const started = startJudging(sent.id)!
  assert.equal(finishJudging(sent.id, started.submission.attempt + 1, done('OK')), false, 'another attempt')
  assert.equal(finishJudging(sent.id, started.submission.attempt, done('OK'), 'another-life'), false, 'another process life')
  assert.ok(requeueStopped(sent.id, started.submission.attempt))
  assert.equal(getSubmission(sent.id)!.starts, 0, 'a deliberate stop is no start')
  assert.equal(finishJudging(sent.id, started.submission.attempt, done('OK')), false, 'requeued meanwhile')
  const again = startJudging(sent.id)!
  assert.equal(again.submission.attempt, started.submission.attempt + 1, 'the attempt number never repeats')
  assert.ok(finishJudging(sent.id, again.submission.attempt, done('WA')))
  assert.equal(getSubmission(sent.id)!.verdict, 'WA')
})

test('the previous life\'s judgings go back to the queue, and the third start cut short ends as SE', () => {
  const contest = contestFixture()
  const problem = withTests(problemOf(contest.id).id)
  const p = createEntrant('@orphan_p').entrant
  const q = createEntrant('@orphan_q').entrant
  joinContest(contest.id, p.id, '@orphan_p')
  joinContest(contest.id, q.id, '@orphan_q')
  const soon = send(contest.id, problem.id, p.id)
  const doomed = send(contest.id, problem.id, q.id)
  const life = 'a-previous-life'
  startJudging(soon.id, life)
  startJudging(doomed.id, life)
  // The doomed one has been cut short twice before.
  db.prepare('UPDATE contest_submissions SET starts = ? WHERE id = ?').run(MAX_STARTS, doomed.id)
  const { requeued, failed } = requeueOrphans(BOOT)
  assert.deepEqual(requeued.map((row) => row.id), [soon.id])
  assert.deepEqual(failed.map((row) => row.id), [doomed.id])
  const back = getSubmission(soon.id)!
  assert.equal(back.state, 'queued')
  assert.equal(back.boot, null)
  const gone = getSubmission(doomed.id)!
  assert.equal(gone.state, 'failed')
  assert.equal(gone.verdict, 'SE')
  assert.match(gone.systemDetail ?? '', /\d/)
  // A run of THIS life is nobody's orphan.
  const mine = startJudging(soon.id, BOOT)!
  assert.deepEqual(requeueOrphans(BOOT), { requeued: [], failed: [] })
  finishJudging(soon.id, mine.submission.attempt, done('OK'))
})

test('a rejudge forgets the verdict and starts the count over; a stale-only rejudge takes the old revision\'s', () => {
  const contest = contestFixture()
  let problem = withTests(problemOf(contest.id).id)
  const p = createEntrant('@rejudge_p').entrant
  joinContest(contest.id, p.id, '@rejudge_p')
  const old = send(contest.id, problem.id, p.id, Date.now() - 1000)
  const judged = startJudging(old.id)!
  finishJudging(old.id, judged.submission.attempt, done('WA'))
  // The tests change: the old verdict is stale now.
  problem = withTests(problem.id, 2)
  const fresh = send(contest.id, problem.id, p.id)
  const freshRun = startJudging(fresh.id)!
  finishJudging(fresh.id, freshRun.submission.attempt, done('OK'))
  assert.equal(rejudgeProblems([problem], true), 1)
  const back = getSubmission(old.id)!
  assert.equal(back.state, 'queued')
  assert.equal(back.verdict, null)
  assert.equal(back.starts, 0)
  assert.equal(back.testsRevision, null)
  assert.equal(getSubmission(fresh.id)!.state, 'done', 'the current one stays')
  assert.equal(rejudgeSubmission(old.id), 'queued')
  const running = startJudging(old.id)!
  assert.equal(rejudgeSubmission(old.id), 'running')
  finishJudging(old.id, running.submission.attempt, done('OK'))
  assert.equal(rejudgeSubmission(old.id), 'requeued')
})

test('a contest goes with every row of it, but not while it judges, and not its people', () => {
  const contest = contestFixture()
  const problem = withTests(problemOf(contest.id).id)
  const p = createEntrant('@deleted_p').entrant
  joinContest(contest.id, p.id, '@deleted_p')
  const sent = send(contest.id, problem.id, p.id)
  const run = startJudging(sent.id)!
  assert.equal(deleteContestRows(contest.id), 'running')
  finishJudging(sent.id, run.submission.attempt, done('OK'))
  assert.equal(deleteContestRows(contest.id), true)
  assert.equal(getContest(contest.id), null)
  assert.equal(getSubmission(sent.id), null)
  assert.equal(listProblems(contest.id).length, 0)
  assert.deepEqual(contestEntrants(contest.id), [])
  assert.ok(getEntrant(p.id), 'a person lives on the instance')
})

/* -------------------------------------------------------------- questions */

test('a person reads their own questions and the public ones; unread counts answers since the last look', () => {
  const contest = contestFixture()
  const a = createEntrant('@ask_a').entrant
  const b = createEntrant('@ask_b').entrant
  joinContest(contest.id, a.id, '@ask_a')
  joinContest(contest.id, b.id, '@ask_b')
  const mine = askQuestion(contest.id, a.id, null, 'Мой вопрос')
  askQuestion(contest.id, b.id, null, 'Чужой вопрос')
  announce(contest.id, null, 'Задача C исправлена', null, Date.now() - 1000)
  const all = listQuestions(contest.id)
  assert.equal(questionsVisibleTo(all, a.id).length, 2)
  assert.equal(questionsVisibleTo(all, null).length, 1, 'a stranger reads the announcements')
  assert.equal(unreadFor(all, a.id, questionsSeenAt(contest.id, a.id)), 1)
  markQuestionsSeen(contest.id, a.id)
  assert.equal(unreadFor(listQuestions(contest.id), a.id, questionsSeenAt(contest.id, a.id)), 0)
  answerQuestion(mine.id, 'Ответ лично', false, null, Date.now() + 1000)
  assert.equal(unreadFor(listQuestions(contest.id), a.id, questionsSeenAt(contest.id, a.id)), 1)
  assert.equal(unreadFor(listQuestions(contest.id), b.id, questionsSeenAt(contest.id, b.id)), 1, 'only the announcement for B')
})

test('every write says what it touched, after the write', async () => {
  const contest = contestFixture()
  const heard = contestEvents(contest.id)
  const problem = problemOf(contest.id)
  const p = createEntrant('@events_p').entrant
  joinContest(contest.id, p.id, '@events_p')
  assert.equal(heard.length, 0, 'nothing is delivered inside the turn of the write')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(heard.some((event) => event.change === 'revision'))
  assert.ok(heard.some((event) => event.change === 'submission' && event.entrantId === p.id))
  void problem
})
