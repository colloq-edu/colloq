/**
 * The participant's doors of contests: everything at `/api/k/contests`, the
 * pages of `/a/<slug>` and the contests of the `/k` list
 * (docs/architecture/contests.md §3).
 *
 * The participant is the competitions' entrant — the same key, the same
 * cookie (`colloq_k`, competitions/identity.ts), slid by the competitions'
 * router on every `/api/k` request, which is mounted before this one
 * (app.ts). Joining follows the competitions' rules word for word: a name is
 * a handle (@shared/competitions · nameForJoin), a namesake is refused, a
 * newcomer gets a key.
 *
 * WHAT NEVER LEAVES HERE, each «not» checked by tests/contests-api.test.mts:
 * the reference solution and the custom checker's code (EntrantProblem has
 * neither field), the hidden tests' data (a problem's `samples` are the tests
 * marked as examples, and a submission's report gives data, notes and
 * outputs of the examples only — a checker's note on a hidden test names the
 * expected answer), anybody else's code or submissions (every submission door
 * answers its author only), anybody else's whole email (the board masks it),
 * and anything at all of a draft or of a contest taken off publication —
 * those answer as missing. Staff who run the contest read a draft through the
 * same page as a preview, and a contest taken off publication through the
 * projector's `?audience=class` only; neither ever writes.
 *
 * Responses go through `reply<T>`, typed by the shared shapes, so a field
 * renamed in shared/contests-entrant.ts is a compile error here, not a blank
 * on the page during the class (the competitions' lesson).
 */
import { createHash } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { tr } from '@shared/i18n'
import { currentStaff } from '../admin/auth.js'
import { config } from '../config.js'
import { addressForLimits } from '../net/inbound.js'
import { tooOften } from '../net/too-often.js'
import { currentEntrant, issueEntrantCookie } from '../competitions/identity.js'
import { getEntrant } from '../competitions/store.js'
import { ENTRANT_SIGN_IN_PATH, nameForJoin, type Entrant } from '@shared/competitions'
import type { EntrantMe } from '@shared/competitions-entrant'
import {
  boardFrozen,
  CONTEST_LANGUAGES,
  CONTEST_LIMITS,
  contestPhase,
  costsAttempt,
  freezeAt,
  judged,
  problemLetter,
  problemsVisible,
  publicContest,
  shownToParticipants,
  SOURCE_BYTES,
  submissionsOpenFor,
  type Contest,
  type ContestAccepting,
  type ContestLanguage,
  type ContestPhase,
  type ContestProblem,
  type TestReport,
  type TestVerdict,
} from '@shared/contests'
import type {
  AskBody,
  ContestErrorBody,
  ContestQuestion,
  ContestRefusal,
  ContestStreamState,
  EntrantContestList,
  EntrantContestRow,
  EntrantContestSubmission,
  EntrantContestSubmissions,
  EntrantContestView,
  EntrantProblem,
  EntrantQuestions,
  EntrantStandings,
  EntrantSubmissionDetail,
  ProblemMine,
  SampleTest,
  SubmitAccepted,
  SubmitBody,
} from '@shared/contests-entrant'
import { canSeeContest } from '../contests/scope.js'
import {
  askQuestion,
  attemptsUsed,
  contestCounts,
  contestEntrantCount,
  contestJoinedAt,
  findContest,
  getSubmission,
  joinContest,
  joinContestAsNewcomer,
  listContests,
  listEntrantProblemSubmissions,
  listEntrantSubmissions,
  listProblems,
  listQuestions,
  listTests,
  markQuestionsSeen,
  MAX_PENDING,
  myContestIds,
  pendingCount,
  problemOf,
  questionsSeenAt,
  questionsVisibleTo,
  submitSolution,
  unreadFor,
  type StoredQuestion,
  type StoredSubmission,
} from '../contests/store.js'
import { boardVersion, contestBoard, problemMaxScore, type BoardViewer } from '../contests/standings.js'
import { currentJudge, imageLanguages, languageAvailable, languageLabel, languageOptions, wakeContestJudge } from '../contests/pump.js'
import { testSnippet } from '../contests/storage.js'
import { watchContest, type ContestEvent } from '../contests/events.js'

function reply<T>(res: Response, body: T): void {
  res.json(body)
}

function refuse(res: Response, status: number, reason: ContestRefusal, error: string): void {
  const body: ContestErrorBody = { error, reason }
  res.status(status).json(body)
}

/* --------------------------------------------------------- rate limits */

const MINUTE = 60_000
/** Joining creates an entrant row — what a script would bloat the database with. The competitions' window and ceiling. */
const joins = new Map<string, number[]>()
const JOIN_WINDOW = 10 * MINUTE
const MAX_JOINS = 60
/** One submission per five seconds per person: a double click is one submission, not two judgings. */
const submits = new Map<string, number[]>()
const SUBMIT_WINDOW = 5_000
/** A flood ceiling per address, generous enough for a lecture hall behind one NAT. */
const submitsByAddress = new Map<string, number[]>()
const MAX_SUBMITS_PER_ADDRESS = 300
/** Questions: one per ten seconds per person. */
const asks = new Map<string, number[]>()
const ASK_WINDOW = 10_000

/* ------------------------------------------------------------- helpers */

interface ContestEntrantRequest extends Request {
  entrant?: Entrant
}

/** The doors that need a signed-in person: the competitions' cookie, the contests' words. */
function requireContestEntrant(req: Request, res: Response, next: NextFunction): void {
  const entrant = currentEntrant(req)
  if (!entrant) return refuse(res, 401, 'unauthenticated', tr('contests.refusal.signIn'))
  ;(req as ContestEntrantRequest).entrant = entrant
  next()
}

const entrantOf = (req: Request): Entrant => (req as ContestEntrantRequest).entrant!

/**
 * The contest as a participant sees it, or null.
 *
 * A draft does not exist here, nor one taken off publication
 * (@shared/contests · shownToParticipants): every door answers both with the
 * same 404 as a missing one. `preview` — a read door (the page, the board,
 * the stream) that staff who run the contest may use to look at what the
 * class will get: a draft whole, read-only; a contest taken off publication
 * only under `?audience=class`, the projector's — elsewhere the teacher sees
 * exactly the 404 a student does, so «снять с публикации» never looks as if
 * it failed.
 */
function visible(slugOrId: string, req?: Request, preview = false): Contest | null {
  const contest = findContest(slugOrId)
  if (!contest) return null
  if (shownToParticipants(contest)) return contest
  if (!preview || !req || !canSeeContest(currentStaff(req), contest)) return null
  if (contest.state === 'draft') return contest
  return req.query.audience === 'class' ? contest : null
}

/** Staff of this contest reading as staff — not through the projector's class view. */
function staffReading(req: Request, contest: Contest): boolean {
  return req.query.audience !== 'class' && canSeeContest(currentStaff(req), contest)
}

/**
 * Whether this visitor may see the board at all: a `public` board is anyone's
 * with the link; an `entrants` board is the contest's participants' and its
 * staff's (the projector included).
 */
function boardOpenTo(req: Request, contest: Contest, me: Entrant | null): boolean {
  if (contest.boardVisibility === 'public') return true
  if (canSeeContest(currentStaff(req), contest)) return true
  return me !== null && contestJoinedAt(contest.id, me.id) !== null
}

/**
 * Whose eyes the board is read with: staff of the contest see it whole; the
 * projector's class view (`?audience=class`, the board on a screen the whole
 * room looks at) is nobody's in particular — the class's frozen board with no
 * row of «mine», whatever cookies the browser carries; anyone else is
 * themselves, their own row unfrozen and named whole.
 */
function boardViewer(req: Request, contest: Contest, me: Entrant | null): BoardViewer {
  if (staffReading(req, contest)) return { entrantId: null, staff: true }
  if (req.query.audience === 'class') return { entrantId: null, staff: false }
  return { entrantId: me?.id ?? null, staff: false }
}

function hashOf(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('base64url').slice(0, 16)
}

function lettersOf(contestId: string): Map<string, string> {
  return new Map(listProblems(contestId).map((problem) => [problem.id, problemLetter(problem.position)]))
}

/**
 * Every test's verdict in order — the strip under a row (K2). While an ICPC
 * judging runs, the tests it finished all passed (it stops at the first
 * failure), so the strip grows with the progress; an IOI judging goes past
 * failures, and its strip waits for the verdict. Judged: every test, the ones
 * the judge did not reach as skipped.
 */
function stripOf(contest: Contest, submission: StoredSubmission): TestVerdict[] {
  if (submission.state === 'running') {
    return contest.rules === 'icpc' && submission.progress !== null ? Array.from({ length: submission.progress }, () => 'OK' as const) : []
  }
  if (!judged(submission.state) || submission.verdict === 'CE' || !submission.report) return []
  const verdicts = new Map(submission.report.tests.map((test) => [test.ordinal, test.verdict]))
  const total = submission.total ?? submission.report.tests.length
  return Array.from({ length: total }, (_, index) => verdicts.get(index + 1) ?? 'skipped')
}

function entrantSubmission(contest: Contest, submission: StoredSubmission, letters: Map<string, string>): EntrantContestSubmission {
  return {
    id: submission.id,
    number: submission.number,
    problemId: submission.problemId,
    letter: letters.get(submission.problemId) ?? '?',
    language: submission.language,
    submittedAt: submission.submittedAt,
    late: submission.late,
    state: submission.state,
    verdict: submission.verdict,
    failedTest: submission.failedTest,
    passed: submission.passed,
    total: submission.total,
    score: contest.rules === 'ioi' ? submission.score : null,
    timeMs: submission.timeMs,
    memoryKb: submission.memoryKb,
    progress: submission.progress,
    strip: stripOf(contest, submission),
  }
}

/**
 * A report as its author may read it: every test's verdict and resources;
 * for the examples also the data, the output and the checker's note. Nothing
 * of a hidden test but its verdict — not even the checker's note, which names
 * the expected answer. The exit code and stderr are staff's
 * (@shared/contests · TestReport), examples included.
 */
function entrantTests(submission: StoredSubmission): TestReport[] {
  return (submission.report?.tests ?? []).map((test) => {
    const base: TestReport = { ordinal: test.ordinal, verdict: test.verdict, timeMs: test.timeMs, memoryKb: test.memoryKb, sample: test.sample }
    if (!test.sample) return base
    return {
      ...base,
      ...(test.note !== undefined ? { note: test.note } : {}),
      ...(test.input !== undefined ? { input: test.input } : {}),
      ...(test.output !== undefined ? { output: test.output } : {}),
      ...(test.answer !== undefined ? { answer: test.answer } : {}),
    }
  })
}

/** «Мои посылки», and its version for the stream: the same rows, the same moment. */
function submissionsView(contest: Contest, entrantId: string): EntrantContestSubmissions {
  const rows = listEntrantSubmissions(contest.id, entrantId)
  const letters = lettersOf(contest.id)
  return { submissions: rows.map((row) => entrantSubmission(contest, row, letters)), version: mineVersion(rows) }
}

function mineVersion(rows: readonly StoredSubmission[]): string {
  return hashOf(rows.map((row) => [row.id, row.state, row.verdict, row.progress, row.score, row.passed, row.judgedAt, row.testsRevision]))
}

/** The examples under a statement, whole up to the snippet cap. */
function samplesOf(problem: ContestProblem): SampleTest[] {
  return listTests(problem.id)
    .filter((test) => test.sample)
    .map((test) => {
      const input = testSnippet(problem.contestId, problem.id, problem.testsRevision, test.ordinal, 'in') ?? { text: '', truncated: false }
      const answer = test.answerBytes === null
        ? { text: '', truncated: false }
        : testSnippet(problem.contestId, problem.id, problem.testsRevision, test.ordinal, 'ans') ?? { text: '', truncated: false }
      return { ordinal: test.ordinal, input: input.text, answer: answer.text, truncated: input.truncated || answer.truncated }
    })
}

/**
 * What this person has done with one problem — the rail's colour. Their own
 * submissions, late ones included (the rail is theirs, not the board's), in
 * the shared rule's terms: an ICPC attempt is rejected when it costs one
 * (@shared/contests · costsAttempt); IOI keeps the best points.
 */
function problemMine(contest: Contest, problem: ContestProblem, entrantId: string, accepting: ContestAccepting, maxScore: number, testCount: number): ProblemMine {
  const rows = listEntrantProblemSubmissions(contest.id, problem.id, entrantId)
  let solved = false
  let attempts = 0
  let score: number | null = null
  for (const row of rows) {
    if (!judged(row.state)) continue
    if (contest.rules === 'icpc') {
      if (solved) continue
      if (row.verdict === 'OK') solved = true
      else if (costsAttempt(row.verdict)) attempts++
      continue
    }
    if (row.verdict === 'CE' || row.verdict === 'SE' || row.score === null) continue
    if (costsAttempt(row.verdict)) attempts++
    score = score === null ? row.score : Math.max(score, row.score)
    if (maxScore > 0 && row.score >= maxScore) solved = true
  }
  const running = rows.find((row) => row.state === 'running')
  const limited = contest.attemptsPerProblem > 0 && accepting !== 'late'
  return {
    solved,
    attempts,
    pending: rows.some((row) => !judged(row.state)),
    pendingTest: running && running.progress !== null ? Math.min(running.progress + 1, Math.max(1, testCount)) : null,
    score: contest.rules === 'ioi' ? score : null,
    attemptsLeft: limited ? Math.max(0, contest.attemptsPerProblem - attemptsUsed(contest.id, problem.id, entrantId)) : null,
  }
}

function entrantProblem(contest: Contest, problem: ContestProblem, entrantId: string | null, accepting: ContestAccepting): EntrantProblem {
  const tests = listTests(problem.id)
  const maxScore = problemMaxScore(contest, problem, tests)
  return {
    id: problem.id,
    letter: problemLetter(problem.position),
    title: problem.title,
    statement: problem.statement,
    timeLimitMs: problem.timeLimitMs,
    memoryMb: problem.memoryMb,
    checker: problem.checker,
    checkerEpsilon: problem.checkerEpsilon,
    maxScore,
    samples: samplesOf(problem),
    tests: tests.length,
    mine: entrantId === null ? null : problemMine(contest, problem, entrantId, accepting, maxScore, tests.length),
  }
}

function questionView(question: StoredQuestion, viewerId: string | null, letters: Map<string, string>): ContestQuestion {
  return {
    id: question.id,
    problemId: question.problemId,
    letter: question.problemId ? letters.get(question.problemId) ?? null : null,
    question: question.question,
    answer: question.answer,
    public: question.public,
    mine: viewerId !== null && question.entrantId === viewerId,
    askedAt: question.askedAt,
    answeredAt: question.answeredAt,
  }
}

function questionsView(contest: Contest, viewerId: string | null): EntrantQuestions {
  const letters = lettersOf(contest.id)
  return { questions: questionsVisibleTo(listQuestions(contest.id), viewerId).map((question) => questionView(question, viewerId, letters)) }
}

function questionsVersion(contest: Contest, viewerId: string | null): string {
  return hashOf(questionsVisibleTo(listQuestions(contest.id), viewerId).map((q) => [q.id, q.answer, q.answeredAt, q.public, q.problemId]))
}

/** The list orders open contests first, then those about to start, then the finished ones. */
const PHASE_ORDER: Record<ContestPhase, number> = { open: 0, soon: 1, over: 2, draft: 3 }

/** The person's place, solved and score on the board as they see it — their own row of it. */
function standingOf(contest: Contest, entrantId: string, now: number): { place: number | null; solved: number; score: number } {
  const row = contestBoard(contest, { entrantId, staff: false }, now).rows.find((one) => one.entrantId === entrantId)
  return { place: row?.place ?? null, solved: row?.solved ?? 0, score: row?.score ?? 0 }
}

/** The SSE headers of every stream here: the relay must not buffer a live screen into one packet. */
function openStream(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

/** Between two recomputations of one stream, at least this long: a burst of progress is one push, not forty. */
const STREAM_GAP_MS = 250
const KEEP_ALIVE_MS = 20_000

/* ------------------------------------------------------------------ doors */

export function contestRoutes(): Router {
  const router = Router()

  /** The contests of the `/k` list: shown ones, with what the person knows of themselves in each. */
  router.get('/api/k/contests', (req, res) => {
    const me = currentEntrant(req)
    const mine = me ? myContestIds(me.id) : new Set<string>()
    const now = Date.now()
    const contests: EntrantContestRow[] = listContests()
      .filter(shownToParticipants)
      .sort((a, b) => PHASE_ORDER[contestPhase(a, now)] - PHASE_ORDER[contestPhase(b, now)] || b.createdAt - a.createdAt)
      .map((contest) => {
        const counts = contestCounts(contest.id)
        const joined = me !== null && mine.has(contest.id)
        return {
          contest: publicContest(contest),
          problems: counts.problems,
          entrants: counts.entrants,
          mine: joined ? { joined: true, ...standingOf(contest, me!.id, now) } : null,
        }
      })
    reply<EntrantContestList>(res, { entrant: me, contests })
  })

  /**
   * The page of one contest. The problems are empty before the start: the
   * statements are the contest, and a page opened early must not hand them
   * out — except to staff previewing their own (not through the projector).
   */
  router.get('/api/k/contests/:slug', async (req, res) => {
    const contest = visible(req.params.slug, req, true)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const now = Date.now()
    const me = currentEntrant(req)
    const accepting = submissionsOpenFor(contest, now)
    const joined = me !== null && contestJoinedAt(contest.id, me.id) !== null
    const readable = problemsVisible(contest, now) || staffReading(req, contest)
    const standing = joined ? standingOf(contest, me!.id, now) : null
    reply<EntrantContestView>(res, {
      contest: publicContest(contest),
      accepting,
      now,
      frozen: boardFrozen(contest, now),
      freezeAt: freezeAt(contest),
      languages: await languageOptions(contest.environment, contest.languages),
      problems: readable ? listProblems(contest.id).map((problem) => entrantProblem(contest, problem, joined ? me!.id : null, accepting)) : [],
      entrants: contestEntrantCount(contest.id),
      mine: me
        ? {
            joined,
            place: standing?.place ?? null,
            solved: standing?.solved ?? 0,
            score: standing?.score ?? 0,
            unreadAnswers: unreadFor(listQuestions(contest.id), me.id, questionsSeenAt(contest.id, me.id)),
          }
        : null,
    })
  })

  /**
   * «Участвовать»: a name, and for a newcomer a key. The competitions' join,
   * for a contest: one button for a newcomer and a returning person; a
   * newcomer's namesake is refused before an identity is minted. Joining
   * before the start is let through (a class registers before the bell, not
   * all in its first second); after the end only while upsolving is on.
   */
  router.post('/api/k/contests/:slug/join', (req, res) => {
    const contest = visible(req.params.slug)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    if (submissionsOpenFor(contest, Date.now()) === 'closed') return refuse(res, 403, 'closed', tr('contests.refusal.joinClosed'))
    const known = currentEntrant(req)
    const name = nameForJoin(String((req.body as { name?: unknown } | undefined)?.name ?? ''), known?.name ?? null)
    if (!name) return refuse(res, 400, 'invalid', tr('contests.refusal.nameNotHandle'))
    if (!known && tooOften(joins, addressForLimits(req), JOIN_WINDOW, MAX_JOINS)) {
      res.setHeader('Retry-After', '60')
      return refuse(res, 429, 'too_often', tr('contests.refusal.tooOftenJoin'))
    }
    if (known) {
      if (joinContest(contest.id, known.id, name) === 'taken') return refuse(res, 409, 'name_taken', tr('contests.refusal.nameTaken'))
      return reply<EntrantMe>(res, { entrant: getEntrant(known.id), key: null, link: null })
    }
    const minted = joinContestAsNewcomer(contest.id, name)
    if (minted === 'taken') return refuse(res, 409, 'name_taken', tr('contests.refusal.nameTaken'))
    issueEntrantCookie(res, minted.entrant)
    reply<EntrantMe>(res, {
      entrant: getEntrant(minted.entrant.id),
      key: minted.key,
      link: `${config.publicUrl}${ENTRANT_SIGN_IN_PATH}${minted.key}`,
    })
  })

  /* --------------------------------------------------------- submissions */

  router.get('/api/k/contests/:slug/submissions', requireContestEntrant, (req, res) => {
    const contest = visible(req.params.slug)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    reply<EntrantContestSubmissions>(res, submissionsView(contest, entrantOf(req).id))
  })

  /** One's own submission opened: the code, the compiler's words, the tests as its author may read them. */
  router.get('/api/k/contests/:slug/submissions/:id', requireContestEntrant, (req, res) => {
    const contest = visible(req.params.slug)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const submission = getSubmission(String(req.params.id))
    // Someone else's answers exactly like a missing one: a participant never
    // sees another's ids, and «not yours» would confirm one exists.
    if (!submission || submission.contestId !== contest.id || submission.kind !== 'entrant' || submission.entrantId !== entrantOf(req).id) {
      return refuse(res, 404, 'not_found', tr('contests.refusal.noSubmission'))
    }
    reply<EntrantSubmissionDetail>(res, {
      ...entrantSubmission(contest, submission, lettersOf(contest.id)),
      source: submission.source,
      compileLog: submission.compileLog,
      tests: entrantTests(submission),
    })
  })

  /**
   * «Отправить». The refusals come in the order a person understands them:
   * the judge is not here at all, the contest is not open or is over, you
   * have not joined, the problem or the language is wrong, the code is too
   * big — and only then the counts: two still being judged, the attempts
   * spent, too often. The counting rules are checked again in the transaction
   * that takes the submission (store.ts · submitSolution).
   */
  router.post('/api/k/contests/:slug/submissions', requireContestEntrant, async (req, res) => {
    const contest = visible(req.params.slug)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const me = entrantOf(req)
    if (!currentJudge()) return refuse(res, 503, 'unavailable', tr('contests.refusal.unavailable'))
    const accepting = submissionsOpenFor(contest, Date.now())
    if (accepting === 'not_open') return refuse(res, 403, 'not_open', tr('contests.refusal.notOpen'))
    if (accepting === 'closed') return refuse(res, 403, 'closed', tr('contests.refusal.closed'))
    if (contestJoinedAt(contest.id, me.id) === null) return refuse(res, 403, 'not_joined', tr('contests.refusal.notJoined'))
    const body = (req.body ?? {}) as Partial<SubmitBody>
    const problem = typeof body.problemId === 'string' ? problemOf(contest.id, body.problemId) : null
    if (!problem) return refuse(res, 400, 'invalid', tr('contests.refusal.noProblem'))
    const language = body.language as ContestLanguage
    if (!CONTEST_LANGUAGES.includes(language) || !contest.languages.includes(language)) {
      return refuse(res, 400, 'language', tr('contests.refusal.languageNotTaken'))
    }
    if (typeof body.source !== 'string' || !body.source.trim()) return refuse(res, 400, 'invalid', tr('contests.refusal.emptySource'))
    if (Buffer.byteLength(body.source, 'utf8') > SOURCE_BYTES) {
      return refuse(res, 413, 'too_big', tr('contests.refusal.tooBig', { count: Math.round(SOURCE_BYTES / 1024) }))
    }
    const probe = await imageLanguages(contest.environment)
    if (probe === null) return refuse(res, 503, 'unavailable', tr('contests.refusal.imageUnavailable'))
    if (!languageAvailable(language, probe)) {
      return refuse(res, 400, 'language', tr('contests.refusal.languageMissing', { language: languageLabel(language, null) }))
    }
    // The probe may have taken a moment: the contest, its intake and the person as they are now.
    const fresh = visible(contest.id)
    if (!fresh) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const now = submissionsOpenFor(fresh, Date.now())
    if (now === 'not_open') return refuse(res, 403, 'not_open', tr('contests.refusal.notOpen'))
    if (now === 'closed') return refuse(res, 403, 'closed', tr('contests.refusal.closed'))
    const still = getEntrant(me.id)
    if (!still || still.disabled || contestJoinedAt(fresh.id, me.id) === null) {
      return refuse(res, 401, 'unauthenticated', tr('contests.refusal.signIn'))
    }
    if (pendingCount(fresh.id, me.id) >= MAX_PENDING) return refuse(res, 409, 'in_flight', tr('contests.refusal.inFlight'))
    if (fresh.attemptsPerProblem > 0 && now !== 'late' && attemptsUsed(fresh.id, problem.id, me.id) >= fresh.attemptsPerProblem) {
      return refuse(res, 409, 'attempts', tr('contests.refusal.attempts', { count: fresh.attemptsPerProblem }))
    }
    if (tooOften(submitsByAddress, addressForLimits(req), MINUTE, MAX_SUBMITS_PER_ADDRESS) || tooOften(submits, me.id, SUBMIT_WINDOW, 1)) {
      res.setHeader('Retry-After', '5')
      return refuse(res, 429, 'too_often', tr('contests.refusal.tooOften'))
    }
    const taken = submitSolution({
      contestId: fresh.id,
      problemId: problem.id,
      entrantId: me.id,
      language,
      source: body.source,
      late: now === 'late',
      attemptsPerProblem: fresh.attemptsPerProblem,
    })
    if ('refusal' in taken) {
      return taken.refusal === 'in_flight'
        ? refuse(res, 409, 'in_flight', tr('contests.refusal.inFlight'))
        : refuse(res, 409, 'attempts', tr('contests.refusal.attempts', { count: fresh.attemptsPerProblem }))
    }
    // At once, not at the next tick: the student is looking at the screen in that second.
    wakeContestJudge()
    res.status(201)
    reply<SubmitAccepted>(res, { submission: entrantSubmission(fresh, getSubmission(taken.submission.id) ?? taken.submission, lettersOf(fresh.id)) })
  })

  /* ----------------------------------------------------------- the board */

  /**
   * The board, as this visitor may see it: the freeze applied to everyone
   * but the viewer's own row, the names masked but the viewer's own. An
   * `entrants` board answers a stranger with a refusal the page can name, not
   * with an empty table: 401 for someone not signed in (a key would open it),
   * 403 for a signed-in person of another contest.
   */
  router.get('/api/k/contests/:slug/standings', (req, res) => {
    const contest = visible(req.params.slug, req, true)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const me = currentEntrant(req)
    if (!boardOpenTo(req, contest, me)) return refuse(res, me ? 403 : 401, 'board_closed', tr('contests.refusal.boardClosed'))
    const board = contestBoard(contest, boardViewer(req, contest, me))
    reply<EntrantStandings>(res, {
      rules: contest.rules,
      problems: board.problems,
      rows: board.rows,
      totals: board.totals,
      frozen: board.frozen,
      freezeAt: board.freezeAt,
      me: board.me,
      penaltyMinutes: contest.penaltyMinutes,
      startsAt: contest.startsAt,
    })
  })

  /* ---------------------------------------------------------- questions */

  /** A participant's own questions and every public one; a visitor not signed in reads the announcements. */
  router.get('/api/k/contests/:slug/questions', (req, res) => {
    const contest = visible(req.params.slug)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    reply<EntrantQuestions>(res, questionsView(contest, currentEntrant(req)?.id ?? null))
  })

  router.post('/api/k/contests/:slug/questions', requireContestEntrant, (req, res) => {
    const contest = visible(req.params.slug)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const me = entrantOf(req)
    if (contestJoinedAt(contest.id, me.id) === null) return refuse(res, 403, 'not_joined', tr('contests.refusal.notJoined'))
    const body = (req.body ?? {}) as Partial<AskBody>
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (!question) return refuse(res, 400, 'invalid', tr('contests.refusal.questionEmpty'))
    if (question.length > CONTEST_LIMITS.question) {
      return refuse(res, 400, 'invalid', tr('contests.refusal.questionTooLong', { count: CONTEST_LIMITS.question }))
    }
    let problemId: string | null = null
    if (body.problemId !== undefined && body.problemId !== null) {
      const problem = typeof body.problemId === 'string' ? problemOf(contest.id, body.problemId) : null
      if (!problem) return refuse(res, 400, 'invalid', tr('contests.refusal.noProblem'))
      problemId = problem.id
    }
    if (tooOften(asks, me.id, ASK_WINDOW, 1)) {
      res.setHeader('Retry-After', '10')
      return refuse(res, 429, 'too_often', tr('contests.refusal.askTooOften'))
    }
    const asked = askQuestion(contest.id, me.id, problemId, question)
    res.status(201)
    reply<ContestQuestion>(res, questionView(asked, me.id, lettersOf(contest.id)))
  })

  /** The questions' page was read: the unread count starts over from now. */
  router.post('/api/k/contests/:slug/questions/seen', requireContestEntrant, (req, res) => {
    const contest = visible(req.params.slug)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const me = entrantOf(req)
    markQuestionsSeen(contest.id, me.id)
    reply<EntrantQuestions>(res, questionsView(contest, me.id))
  })

  /* -------------------------------------------------------------- stream */

  /**
   * What changed, pushed when it does (contests/events.ts): the contest's
   * revision, the person's submissions, the board as they see it, the
   * questions they read — versions, never the data, so a page refetches only
   * what moved and nothing here needs the board's or the names' rules a
   * second time. A visitor not signed in gets the board's and the
   * announcements' versions (the projector's leaderboard). Ends when the
   * contest disappears; the reconnect then meets the 404.
   */
  router.get('/api/k/contests/:slug/stream', (req, res) => {
    const contest = visible(req.params.slug, req, true)
    if (!contest) return refuse(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const me = currentEntrant(req)
    openStream(res)
    let last = ''
    let pending: NodeJS.Timeout | null = null
    let lastAt = 0
    let closed = false
    let unwatch = (): void => {}
    let beat: NodeJS.Timeout | undefined
    const stop = (): void => {
      if (closed) return
      closed = true
      if (pending) clearTimeout(pending)
      clearInterval(beat)
      unwatch()
    }
    const push = (): void => {
      pending = null
      if (closed) return
      lastAt = Date.now()
      const fresh = visible(contest.id, req, true)
      if (!fresh) {
        stop()
        res.end()
        return
      }
      const state: ContestStreamState = {
        revision: fresh.revision,
        mine: me ? submissionsView(fresh, me.id).version : '',
        board: boardOpenTo(req, fresh, me) ? boardVersion(contestBoard(fresh, boardViewer(req, fresh, me))) : '',
        questions: questionsVersion(fresh, me?.id ?? null),
      }
      const body = JSON.stringify(state)
      if (body === last) return
      last = body
      res.write(`event: state\ndata: ${body}\n\n`)
    }
    const schedule = (event: ContestEvent): void => {
      // Another person's progress moves nothing this page shows.
      if (event.change === 'progress' && (!me || event.entrantId !== me.id)) return
      if (pending || closed) return
      pending = setTimeout(push, Math.max(0, lastAt + STREAM_GAP_MS - Date.now()))
    }
    push()
    if (closed) return
    unwatch = watchContest(contest.id, schedule)
    beat = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS)
    req.on('close', stop)
  })

  return router
}
