/**
 * Why a contest cannot open yet — the list «Открыть контест» answers with, in
 * the editor's words, in the order of the editor's sections.
 *
 * The competitions' rule, for contests (docs/architecture/contests.md §0): a
 * contest whose problems even its author cannot solve has nothing to open.
 * So every problem needs tests, an answer for every test, and a reference
 * solution that passed on exactly the tests there are now, with the limits
 * and the checker there are now (store.ts · referenceStamp) — a reference
 * that passed under a two-second limit says nothing about one second. And the
 * contest needs a judge on this server, an image that runs at least one of
 * its languages, and dates that make sense.
 *
 * Nothing here decides anything about access or writes anything: a list of
 * reasons, empty when ready. The door refuses on a non-empty one
 * (routes/admin-contests.ts · open).
 */
import { tr } from '@shared/i18n'
import { problemLetter, verdictWords, type Contest, type ContestProblem } from '@shared/contests'
import type { ReferenceStatus } from '@shared/contests-api'
import { getContest, getProblem, latestTeacherRun, listProblems, listTests, referenceStamp, type StoredReport } from './store.js'
import { problemMaxScore } from './standings.js'
import { currentJudge, environmentImage, imageLanguages, kernelImage, languageAvailable } from './pump.js'

/** The slowest test of a report: the margin the editor shows against the time limit. */
function slowestTest(report: StoredReport | null): number | null {
  let slowest: { ordinal: number; timeMs: number } | null = null
  for (const test of report?.tests ?? []) {
    if (test.timeMs === null || test.timeMs === undefined) continue
    if (!slowest || test.timeMs > slowest.timeMs) slowest = { ordinal: test.ordinal, timeMs: test.timeMs }
  }
  return slowest?.ordinal ?? null
}

/**
 * How the problem's reference fared, as its editor shows it: missing, waiting,
 * running, passing or failing on the CURRENT tests and settings — and
 * `unchecked` when the last check was of something else (the source, the
 * tests, a limit or the checker changed since).
 */
export async function referenceStatus(problem: ContestProblem): Promise<ReferenceStatus> {
  const contest = getContest(problem.contestId)
  const image = contest ? await environmentImage(contest.environment) : null
  // Resolve the image before reading mutable settings or the latest run.
  return referenceStatusFor(getProblem(problem.id) ?? problem, image, contest?.environment ?? '')
}

function referenceStatusFor(problem: ContestProblem, image: string | null, environment: string): ReferenceStatus {
  const none: ReferenceStatus = {
    state: 'missing',
    verdict: null,
    failedTest: null,
    timeMs: null,
    memoryKb: null,
    slowestTest: null,
    checkedAt: null,
    submissionId: null,
  }
  if (!problem.referenceSource.trim()) return none
  const run = latestTeacherRun(problem.id, 'reference')
  if (!run) return { ...none, state: 'unchecked' }
  const facts: ReferenceStatus = {
    state: 'unchecked',
    verdict: run.verdict,
    failedTest: run.failedTest,
    timeMs: run.timeMs,
    memoryKb: run.memoryKb,
    slowestTest: slowestTest(run.report),
    checkedAt: run.judgedAt,
    submissionId: run.id,
  }
  if (run.state === 'queued') return { ...facts, state: 'queued' }
  if (run.state === 'running') return { ...facts, state: 'running' }
  const current = image !== null && run.report?.environment?.image === image
    && run.report.environment.name === environment && environment === getContest(problem.contestId)?.environment
    && run.testsRevision === problem.testsRevision && run.report.stamp === referenceStamp(problem)
  if (!current) return facts
  return { ...facts, state: run.verdict === 'OK' ? 'passes' : 'fails' }
}

/** The problems' letters whose reference does not pass yet — the list row's «эталон не проверен: C, D». */
export async function problemsNotReady(contest: Contest): Promise<string[]> {
  const problems = listProblems(contest.id)
  const states = await Promise.all(problems.map(referenceStatus))
  return problems
    .filter((_problem, index) => states[index].state !== 'passes')
    .map((problem) => problemLetter(problem.position))
}

/** One problem's reasons. */
function problemReasons(contest: Contest, problem: ContestProblem, image: string | null): string[] {
  const letter = problemLetter(problem.position)
  const tests = listTests(problem.id)
  if (tests.length === 0) return [tr('contests.readiness.noTests', { letter })]
  const reasons: string[] = []
  const missing = tests.filter((test) => test.answerBytes === null).length
  if (missing > 0) reasons.push(tr('contests.readiness.missingAnswers', { letter, count: missing }))
  if (contest.rules === 'ioi' && problemMaxScore(contest, problem, tests) <= 0) {
    reasons.push(tr('contests.readiness.noPoints', { letter }))
  }
  const reference = referenceStatusFor(problem, image, contest.environment)
  if (reference.state === 'missing') reasons.push(tr('contests.readiness.noReference', { letter }))
  else if (reference.state === 'unchecked') reasons.push(tr('contests.readiness.referenceUnchecked', { letter }))
  else if (reference.state === 'queued' || reference.state === 'running') reasons.push(tr('contests.readiness.referenceRunning', { letter }))
  else if (reference.state === 'fails') {
    const verdict = reference.verdict ? `${reference.verdict} (${verdictWords(reference.verdict)})` : '—'
    reasons.push(
      reference.failedTest !== null
        ? tr('contests.readiness.referenceFailsOn', { letter, verdict, test: reference.failedTest })
        : tr('contests.readiness.referenceFails', { letter, verdict }),
    )
  }
  return reasons
}

/** Why the contest cannot open now; empty — it can. */
export async function contestReadiness(contest: Contest, now = Date.now(), freshImage = true): Promise<string[]> {
  const checkedImage = await environmentImage(contest.environment, freshImage)
  const judge = currentJudge()
  const probe = judge && checkedImage ? await imageLanguages(contest.environment, now, checkedImage) : null
  // A cold probe may cross a rebuild. It only proves tools in the image it actually ran in.
  const image = await environmentImage(contest.environment, freshImage)
  const checkedEnvironment = contest.environment
  contest = getContest(contest.id) ?? contest
  const sameImage = image !== null && image === checkedImage && contest.environment === checkedEnvironment
  // Everything below is synchronous: tests, reference, limits and languages are read AFTER the awaits.
  const reasons: string[] = []
  const problems = listProblems(contest.id)
  if (problems.length === 0) reasons.push(tr('contests.readiness.noProblems'))
  for (const problem of problems) reasons.push(...problemReasons(contest, problem, sameImage ? image : null))
  if (!judge) {
    reasons.push(tr('contests.readiness.noJudge'))
  } else {
    const tag = kernelImage(contest.environment)
    if (probe === null || !sameImage) reasons.push(tr('contests.readiness.imageUnknown', { image: tag }))
    else if (!contest.languages.some((language) => languageAvailable(language, probe))) {
      reasons.push(tr('contests.readiness.noLanguage', { image: tag }))
    }
  }
  // The freeze is counted back from the end (@shared/contests · freezeAt): with
  // no end it would quietly never come, and the class would watch a live board
  // through what the teacher meant as its frozen hour.
  if (contest.freezeMinutes > 0 && contest.endsAt === null) reasons.push(tr('contests.readiness.freezeWithoutEnd'))
  if (contest.startsAt !== null && contest.endsAt !== null && contest.endsAt <= contest.startsAt) {
    reasons.push(tr('contests.readiness.endBeforeStart'))
  } else if (contest.endsAt !== null && contest.endsAt <= now) {
    reasons.push(tr('contests.readiness.endPassed'))
  }
  return reasons
}
