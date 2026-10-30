/**
 * The panel's doors to contests: the list (A1), the contest's editor (A2),
 * the problem's editor (A3), the console of a live contest (A4) —
 * docs/architecture/contests.md §3.
 *
 * THE SCOPE RULE IS ASKED IN ONE PLACE. Every per-id door goes through
 * `contestOf`, which answers a contest the caller does not run exactly as a
 * missing one (contests/scope.ts has the rule: an owner, the creator, a
 * teacher of its course); a door added later inherits it without anyone
 * remembering. The instance-wide doors — the judge's slots and its pause —
 * are an owner's: there is one judge for every course on the machine.
 * Deleting a contest is its creator's or an owner's (scope.ts ·
 * canDeleteContest).
 *
 * Everything here may hold what the class must never see: the tests and
 * their answers (served to these doors only, as files), the reference, the
 * custom checker, every participant's code and whole name. Nothing of it is
 * computed here twice: the board is standings.ts's, the readiness
 * readiness.ts's, the judging pump.ts's, and a change of tests goes through
 * revisions.ts, the one way they change.
 */
import busboy from 'busboy'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { tr } from '@shared/i18n'
import { currentStaff, ownerOnly, requireStaff } from '../admin/auth.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import { canSeeCourse, type StaffLike } from '../admin/access.js'
import { getCourse } from '../publish/store.js'
import { courseRefOf } from '../competitions/scope.js'
import { getEntrant } from '../competitions/store.js'
import { instanceTimeZone } from '../time-zone.js'
import { ENVIRONMENT_NAME, type AdminAuditAction, type AdminAuditValue, type AdminErrorBody, type AdminErrorReason } from '@shared/admin'
import {
  CHECKER_KINDS,
  CONTEST_LANGUAGES,
  CONTEST_LIMITS,
  CONTEST_RULES,
  contestPhase,
  boardFrozen,
  parseContestSlug,
  pointGroups,
  pointsFor,
  problemLetter,
  problemMaxPoints,
  RESERVED_CONTEST_SLUGS,
  SOURCE_BYTES,
  VERDICTS,
  type CheckerKind,
  type Contest,
  type ContestGroup,
  type ContestLanguage,
  type ContestProblem,
  type ContestRules,
  type ContestTest,
  type TestReport,
  type TestVerdict,
  type Verdict,
} from '@shared/contests'
import { PREVIEW_BYTES } from '@shared/contests-api'
import type {
  AdminQuestion,
  AdminQuestions,
  AdminStandings,
  AdminSubmissionDetail,
  AdminSubmissionRow,
  AdminSubmissions,
  AdminTest,
  AnnouncementBody,
  AnswerBody,
  ArchiveImport,
  ContestEntrantRow,
  ContestList,
  ContestListRow,
  ContestLiveState,
  ContestPatch,
  ContestSettings,
  ContestView,
  JudgeStatus,
  NewContestBody,
  NewTestBody,
  ProblemPatch,
  ProblemView,
  TestPatch,
} from '@shared/contests-api'
import { canDeleteContest, canSeeContest } from '../contests/scope.js'
import {
  addProblem,
  announce,
  answerQuestion,
  contestCounts,
  contestEntrants,
  contestQueueCounts,
  contestJoinedAt,
  createContest,
  deleteContestRows,
  deleteProblemRows,
  deleteQuestion,
  enqueueTeacherRun,
  entrantSubmissionStats,
  findContest,
  getContest,
  getProblem,
  getQuestion,
  getSubmission,
  hasEntrantSubmissions,
  listContestSubmissions,
  listContests,
  listGroups,
  listProblems,
  listQuestions,
  listTests,
  problemOf,
  rejudgeProblems,
  rejudgeSubmission,
  removeContestEntrantRows,
  reorderProblems,
  replaceGroups,
  rescoreProblem,
  setContestHidden,
  setContestState,
  setContestUnfrozen,
  teacherRunPending,
  updateContest,
  updateProblem,
  type ContestFields,
  type ProblemFields,
  type StoredQuestion,
  type StoredReport,
  type StoredSubmission,
} from '../contests/store.js'
import { contestBoard, standingsCsv } from '../contests/standings.js'
import { contestReadiness, problemsNotReady, referenceStatus } from '../contests/readiness.js'
import {
  currentJudge,
  holdAndStop,
  judgeStatus,
  languageOptions,
  pauseContestJudge,
  wakeContestJudge,
} from '../contests/pump.js'
import { holdTestFile, removeContestFiles, removeJobDir, removeProblemFiles, revisionExists, testSnippet, TestsRefused } from '../contests/storage.js'
import { openZip, ZipRefused, type ZipArchive } from '../contests/zip-reader.js'
import { planTests, ProblemArchiveRefused, readProblemArchive } from '../contests/tests-import.js'
import { changeTests, keepAll, TestsMoved, type NextTest } from '../contests/revisions.js'
import { autoJudgeSlots, parseJudgeSlots, savedJudgeSlots, saveJudgeSlots } from '../contests/settings.js'
import { noteJudgeChanged, submissionsVersion, watchContests } from '../contests/events.js'

function fail(res: Response, status: number, reason: AdminErrorReason, message: string, extra: Record<string, unknown> = {}): void {
  const body: AdminErrorBody & Record<string, unknown> = { error: message, reason, ...extra }
  res.status(status).json(body)
}

function reply<T>(res: Response, body: T): void {
  res.json(body)
}

/** The console's feed as one page, at most. */
const FEED_PAGE = { default: 50, max: 200 }
/** Entries an archive may hold, every name counted: a little over two files per test of the cap. */
const ARCHIVE_ENTRIES = 2048
/** What a whole problem's archive may hold besides its tests: a statement, a checker, a reference. */
const PROBLEM_EXTRAS_BYTES = 2 * 1024 * 1024
/** An IOI group's number, and the points one group may give. */
const GROUP_RANGE = { min: 0, max: 999 }
const GROUP_POINTS = { min: 0, max: 1000 }

const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024)

/* --------------------------------------------------------------- helpers */

/**
 * The contest the address names — if the caller runs it. The scope check
 * lives in this one lookup every per-contest door goes through; someone
 * else's contest answers exactly like a missing one.
 */
function contestOf(req: Request, res: Response): Contest | null {
  const found = findContest(String(req.params.id ?? ''))
  if (!found || !canSeeContest(currentStaff(req), found)) {
    fail(res, 404, 'not_found', tr('contests.refusal.notFound'))
    return null
  }
  return found
}

function problemFor(contest: Contest, req: Request, res: Response): ContestProblem | null {
  const problem = problemOf(contest.id, String(req.params.pid ?? ''))
  if (!problem) {
    fail(res, 404, 'not_found', tr('contests.refusal.noProblem'))
    return null
  }
  return problem
}

/** «Курс» from a form: absent, null, or a course the caller teaches (an owner — any existing one). */
function courseAllowed(staff: StaffLike | null, courseId: string | null | undefined, res: Response): boolean {
  if (courseId === undefined || courseId === null) return true
  if (!getCourse(courseId) || !canSeeCourse(staff, courseId)) {
    fail(res, 404, 'not_found', tr('contests.refusal.courseNotFound'))
    return false
  }
  return true
}

/**
 * The problem's tests as the editor lists them: each row with the first
 * PREVIEW_BYTES of its input and answer, read from the current revision — «4 5
 * ⏎ ##..#», so the teacher knows a test without downloading it.
 */
function adminTests(problem: ContestProblem, tests: readonly ContestTest[]): AdminTest[] {
  return tests.map((test) => ({
    ...test,
    inputPreview: testSnippet(problem.contestId, problem.id, problem.testsRevision, test.ordinal, 'in', PREVIEW_BYTES)?.text ?? '',
    answerPreview: test.answerBytes === null
      ? null
      : testSnippet(problem.contestId, problem.id, problem.testsRevision, test.ordinal, 'ans', PREVIEW_BYTES)?.text ?? '',
  }))
}

function problemView(problem: ContestProblem): ProblemView {
  const tests = listTests(problem.id)
  const groups = listGroups(problem.id)
  return {
    ...problem,
    letter: problemLetter(problem.position),
    tests: adminTests(problem, tests),
    groups,
    // The points the groups add up to, whatever the rules: the editor shows what IOI would give.
    maxScore: problemMaxPoints(pointGroups(tests, problem.points, groups)),
    testBytes: tests.reduce((sum, test) => sum + test.inputBytes + (test.answerBytes ?? 0), 0),
    reference: referenceStatus(problem),
    missingAnswers: tests.filter((test) => test.answerBytes === null).length,
    answersRunning: teacherRunPending(problem.id, 'answers'),
  }
}

async function viewOf(contest: Contest, viewer: StaffLike | null): Promise<ContestView> {
  const counts = contestCounts(contest.id)
  return {
    contest,
    phase: contestPhase(contest, Date.now()),
    problems: listProblems(contest.id).map(problemView),
    languages: await languageOptions(contest.environment),
    course: courseRefOf(contest.courseId, viewer),
    timeZone: instanceTimeZone(),
    readiness: await contestReadiness(contest),
    entrants: counts.entrants,
    submissions: counts.submissions,
    judge: judgeStatus(),
  }
}

function rowOf(contest: Contest, viewer: StaffLike | null): ContestListRow {
  const counts = contestCounts(contest.id)
  const board = contestBoard(contest, { entrantId: null, staff: true })
  const icpc = contest.rules === 'icpc'
  const average = board.rows.length === 0
    ? null
    : board.rows.reduce((sum, row) => sum + (icpc ? row.solved : row.score), 0) / board.rows.length
  return {
    contest,
    phase: contestPhase(contest, Date.now()),
    problems: counts.problems,
    entrants: counts.entrants,
    submissions: counts.submissions,
    averageSolved: average === null ? null : Math.round(average * 10) / 10,
    averageOf: icpc ? board.problems.length : board.problems.reduce((sum, problem) => sum + problem.maxScore, 0),
    notReady: problemsNotReady(contest),
    course: courseRefOf(contest.courseId, viewer),
  }
}

function lettersOf(contestId: string): Map<string, string> {
  return new Map(listProblems(contestId).map((problem) => [problem.id, problemLetter(problem.position)]))
}

function namesOf(contestId: string): Map<string, string> {
  return new Map(contestEntrants(contestId).map((entrant) => [entrant.id, entrant.name]))
}

function adminRow(submission: StoredSubmission, letters: Map<string, string>, names: Map<string, string>): AdminSubmissionRow {
  const { source: _source, compileLog: _log, report: _report, systemDetail: _detail, attempt: _attempt, starts: _starts, boot: _boot, startedAt: _started, ...row } = submission
  const entrantId = submission.entrantId
  return {
    ...row,
    letter: letters.get(submission.problemId) ?? '?',
    entrant: entrantId ? { id: entrantId, name: names.get(entrantId) ?? getEntrant(entrantId)?.name ?? '' } : null,
  }
}

/**
 * Every test of a report with everything the judge said, and the data of
 * every test — read from the revision it was judged on while that revision is
 * still on disk, stored in the report for the examples and the failed test.
 */
function reportTests(submission: StoredSubmission): TestReport[] {
  const problem = getProblem(submission.problemId)
  const revision = submission.testsRevision
  const onDisk = problem !== null && revision !== null && revisionExists(problem.contestId, problem.id, revision)
  return (submission.report?.tests ?? []).map(({ group: _group, ...test }) => {
    if (!onDisk || !problem || revision === null) return test
    const input = test.input ?? testSnippet(problem.contestId, problem.id, revision, test.ordinal, 'in')?.text
    const answer = test.answer ?? (submission.kind === 'answers' ? undefined : testSnippet(problem.contestId, problem.id, revision, test.ordinal, 'ans')?.text)
    return { ...test, ...(input !== undefined ? { input } : {}), ...(answer !== undefined ? { answer } : {}) }
  })
}

function questionView(question: StoredQuestion, letters: Map<string, string>, names: Map<string, string>): AdminQuestion {
  return {
    id: question.id,
    problemId: question.problemId,
    letter: question.problemId ? letters.get(question.problemId) ?? null : null,
    question: question.question,
    answer: question.answer,
    public: question.public,
    mine: false,
    askedAt: question.askedAt,
    answeredAt: question.answeredAt,
    entrant: question.entrantId ? { id: question.entrantId, name: names.get(question.entrantId) ?? getEntrant(question.entrantId)?.name ?? '' } : null,
  }
}

function questionsOf(contest: Contest): AdminQuestions {
  const letters = lettersOf(contest.id)
  const names = namesOf(contest.id)
  const all = listQuestions(contest.id)
  return {
    questions: all.map((question) => questionView(question, letters, names)),
    unanswered: all.filter((question) => question.question !== '' && question.answer === null).length,
  }
}

function entrantsOf(contest: Contest): { entrants: ContestEntrantRow[] } {
  const stats = entrantSubmissionStats(contest.id)
  const solved = new Map(contestBoard(contest, { entrantId: null, staff: true }).rows.map((row) => [row.entrantId, row.solved]))
  return {
    entrants: contestEntrants(contest.id).map((entrant) => ({
      id: entrant.id,
      name: entrant.name,
      joinedAt: entrant.joinedAt,
      submissions: stats.get(entrant.id)?.count ?? 0,
      solved: solved.get(entrant.id) ?? 0,
      lastSubmissionAt: stats.get(entrant.id)?.last ?? null,
    })),
  }
}

function audit(req: Request, action: AdminAuditAction, contest: Contest, detail?: Record<string, AdminAuditValue>): void {
  recordAdminEvent({
    actor: currentStaff(req),
    action,
    target: { type: 'contest', id: contest.id, label: contest.title },
    ...(detail ? { detail } : {}),
    req,
  })
}

/* ------------------------------------------------------------ validation */

type Refusal =
  | { field: string; why: 'value' }
  | { field: string; why: 'range'; min: number; max: number }
  | { field: string; why: 'tooLong'; max: number }
  | { field: 'title'; why: 'empty' }
  | { field: 'slug'; why: 'chars' | 'reserved' }
  | { field: 'languages'; why: 'empty' }
  | { field: 'endsAt'; why: 'dates' }

function refuseInput(res: Response, refusal: Refusal): void {
  if (refusal.field === 'slug' && (refusal.why === 'chars' || refusal.why === 'reserved')) {
    return fail(res, 400, 'invalid', tr(`contests.refusal.slug.${refusal.why}`))
  }
  if (refusal.why === 'empty') return fail(res, 400, 'invalid', tr(refusal.field === 'title' ? 'contests.refusal.title' : 'contests.refusal.languages'))
  if (refusal.why === 'dates') return fail(res, 400, 'invalid', tr('contests.refusal.dates'))
  if (refusal.why === 'range') return fail(res, 400, 'invalid', tr('contests.refusal.range', { field: refusal.field, min: refusal.min, max: refusal.max }))
  if (refusal.why === 'tooLong') return fail(res, 400, 'invalid', tr('contests.refusal.tooLong', { field: refusal.field, max: refusal.max }))
  fail(res, 400, 'invalid', tr('contests.refusal.value', { field: refusal.field }))
}

function wholeIn(raw: unknown, field: string, range: { min: number; max: number }): number | Refusal {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { field, why: 'value' }
  if (raw < range.min || raw > range.max) return { field, why: 'range', min: range.min, max: range.max }
  return raw
}

const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && 'why' in value

/** A moment in milliseconds, or null; a finite whole number only. */
function momentIn(raw: unknown, field: string): number | null | Refusal {
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return { field, why: 'value' }
  return raw
}

function slugIn(raw: unknown): string | Refusal {
  const slug = parseContestSlug(String(raw ?? ''))
  if (slug) return slug
  return { field: 'slug', why: RESERVED_CONTEST_SLUGS.includes(String(raw ?? '').trim().toLowerCase()) ? 'reserved' : 'chars' }
}

function titleIn(raw: unknown, max: number): string | Refusal {
  if (typeof raw !== 'string') return { field: 'title', why: 'empty' }
  const title = raw.trim()
  if (!title) return { field: 'title', why: 'empty' }
  if (title.length > max) return { field: 'title', why: 'tooLong', max }
  return title
}

function textIn(raw: unknown, field: string, max: number): string | Refusal {
  if (typeof raw !== 'string') return { field, why: 'value' }
  if (raw.length > max) return { field, why: 'tooLong', max }
  return raw
}

/**
 * The editor's PATCH, checked field by field against CONTEST_LIMITS. Only the
 * fields that came: a section that saves its two fields must not clear the
 * other ten. The dates are checked together, as they will be after the save.
 */
function parseContestPatch(body: unknown, current: Contest): { fields: ContestFields } | { refusal: Refusal } {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown> & ContestPatch
  const fields: ContestFields = {}
  const has = (key: keyof ContestPatch): boolean => raw[key] !== undefined
  if (has('title')) {
    const title = titleIn(raw.title, CONTEST_LIMITS.title)
    if (isRefusal(title)) return { refusal: title }
    fields.title = title
  }
  if (has('slug')) {
    const slug = slugIn(raw.slug)
    if (isRefusal(slug)) return { refusal: slug }
    fields.slug = slug
  }
  if (has('blurb')) {
    const blurb = textIn(raw.blurb, 'blurb', CONTEST_LIMITS.blurb)
    if (isRefusal(blurb)) return { refusal: blurb }
    fields.blurb = blurb.trim()
  }
  if (has('description')) {
    const description = textIn(raw.description, 'description', CONTEST_LIMITS.description)
    if (isRefusal(description)) return { refusal: description }
    fields.description = description
  }
  if (has('rules')) {
    if (!CONTEST_RULES.includes(raw.rules as ContestRules)) return { refusal: { field: 'rules', why: 'value' } }
    fields.rules = raw.rules as ContestRules
  }
  for (const key of ['penaltyMinutes', 'freezeMinutes', 'attemptsPerProblem'] as const) {
    if (!has(key)) continue
    const value = wholeIn(raw[key], key, CONTEST_LIMITS[key])
    if (isRefusal(value)) return { refusal: value }
    fields[key] = value
  }
  if (has('languages')) {
    if (!Array.isArray(raw.languages)) return { refusal: { field: 'languages', why: 'value' } }
    if (!raw.languages.every((id) => CONTEST_LANGUAGES.includes(id as ContestLanguage))) return { refusal: { field: 'languages', why: 'value' } }
    const languages = [...new Set(raw.languages as ContestLanguage[])]
    if (languages.length === 0) return { refusal: { field: 'languages', why: 'empty' } }
    fields.languages = languages
  }
  if (has('environment')) {
    const environment = String(raw.environment ?? '').trim()
    if (!ENVIRONMENT_NAME.test(environment)) return { refusal: { field: 'environment', why: 'value' } }
    fields.environment = environment
  }
  for (const key of ['startsAt', 'endsAt'] as const) {
    if (!has(key)) continue
    const value = momentIn(raw[key], key)
    if (isRefusal(value)) return { refusal: value }
    fields[key] = value
  }
  const startsAt = fields.startsAt !== undefined ? fields.startsAt : current.startsAt
  const endsAt = fields.endsAt !== undefined ? fields.endsAt : current.endsAt
  if ((has('startsAt') || has('endsAt')) && startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    return { refusal: { field: 'endsAt', why: 'dates' } }
  }
  if (has('upsolving')) {
    if (typeof raw.upsolving !== 'boolean') return { refusal: { field: 'upsolving', why: 'value' } }
    fields.upsolving = raw.upsolving
  }
  if (has('boardVisibility')) {
    if (raw.boardVisibility !== 'public' && raw.boardVisibility !== 'entrants') return { refusal: { field: 'boardVisibility', why: 'value' } }
    fields.boardVisibility = raw.boardVisibility
  }
  if (has('courseId')) {
    if (raw.courseId !== null && typeof raw.courseId !== 'string') return { refusal: { field: 'courseId', why: 'value' } }
    fields.courseId = raw.courseId
  }
  return { fields }
}

/** A problem's fields, checked against CONTEST_LIMITS; `creating` lets a missing title be the letter's own. */
function parseProblemPatch(body: unknown): { fields: ProblemFields } | { refusal: Refusal } {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown> & ProblemPatch
  const fields: ProblemFields = {}
  const has = (key: keyof ProblemPatch): boolean => raw[key] !== undefined
  if (has('title')) {
    const title = titleIn(raw.title, CONTEST_LIMITS.problemTitle)
    if (isRefusal(title)) return { refusal: title.why === 'empty' ? { field: 'title', why: 'value' } : title }
    fields.title = title
  }
  if (has('statement')) {
    const statement = textIn(raw.statement, 'statement', CONTEST_LIMITS.statement)
    if (isRefusal(statement)) return { refusal: statement }
    fields.statement = statement
  }
  if (has('timeLimitMs')) {
    const value = wholeIn(raw.timeLimitMs, 'timeLimitMs', CONTEST_LIMITS.timeLimitMs)
    if (isRefusal(value)) return { refusal: value }
    fields.timeLimitMs = value
  }
  if (has('memoryMb')) {
    const value = wholeIn(raw.memoryMb, 'memoryMb', CONTEST_LIMITS.memoryMb)
    if (isRefusal(value)) return { refusal: value }
    fields.memoryMb = value
  }
  if (has('checker')) {
    if (!CHECKER_KINDS.includes(raw.checker as CheckerKind)) return { refusal: { field: 'checker', why: 'value' } }
    fields.checker = raw.checker as CheckerKind
  }
  if (has('checkerEpsilon')) {
    const value = raw.checkerEpsilon
    if (typeof value !== 'number' || !Number.isFinite(value)) return { refusal: { field: 'checkerEpsilon', why: 'value' } }
    if (value < CONTEST_LIMITS.epsilon.min || value > CONTEST_LIMITS.epsilon.max) {
      return { refusal: { field: 'checkerEpsilon', why: 'range', min: CONTEST_LIMITS.epsilon.min, max: CONTEST_LIMITS.epsilon.max } }
    }
    fields.checkerEpsilon = value
  }
  if (has('checkerCode')) {
    const code = textIn(raw.checkerCode, 'checkerCode', CONTEST_LIMITS.checkerCode)
    if (isRefusal(code)) return { refusal: code }
    fields.checkerCode = code
  }
  if (has('points')) {
    if (raw.points !== 'tests' && raw.points !== 'groups') return { refusal: { field: 'points', why: 'value' } }
    fields.points = raw.points
  }
  if (has('referenceLanguage')) {
    if (!CONTEST_LANGUAGES.includes(raw.referenceLanguage as ContestLanguage)) return { refusal: { field: 'referenceLanguage', why: 'value' } }
    fields.referenceLanguage = raw.referenceLanguage as ContestLanguage
  }
  if (has('referenceSource')) {
    if (typeof raw.referenceSource !== 'string') return { refusal: { field: 'referenceSource', why: 'value' } }
    if (Buffer.byteLength(raw.referenceSource, 'utf8') > SOURCE_BYTES) return { refusal: { field: 'referenceSource', why: 'tooLong', max: SOURCE_BYTES } }
    fields.referenceSource = raw.referenceSource
  }
  return { fields }
}

/* -------------------------------------------------------------- multipart */

type Received = { name: string; body: Buffer } | 'not-multipart' | 'cut-off' | 'too-big' | 'no-file'

/**
 * Receive one file into memory, under a cap — the competitions' way
 * (admin-competitions.ts · receive): the teacher's archive is bounded by
 * CONTEST_LIMITS.archiveBytes, and the cap is what makes the memory path
 * honest — without it one `curl` with a gigabyte brings down the process that
 * runs the class. A file cut at the cap is not stored at all.
 */
function receiveFile(req: Request, maxBytes: number): Promise<Received> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) return Promise.resolve('not-multipart')
  return new Promise((resolve) => {
    let bb: ReturnType<typeof busboy>
    try {
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: maxBytes, files: 1, fields: 4, fieldSize: 1024 } })
    } catch {
      return resolve('not-multipart')
    }
    let answered = false
    const done = (value: Received): void => {
      if (answered) return
      answered = true
      resolve(value)
    }
    let file: { name: string; body: Buffer } | null = null
    let over = false
    bb.on('file', (_field, stream, info) => {
      if (file) return stream.resume()
      const chunks: Buffer[] = []
      stream.on('limit', () => {
        over = true
        stream.resume()
      })
      stream.on('data', (chunk: Buffer) => {
        if (!over) chunks.push(chunk)
      })
      stream.on('end', () => {
        if (!over) file = { name: path.basename(info.filename ?? ''), body: Buffer.concat(chunks) }
      })
    })
    bb.on('error', () => done('cut-off'))
    bb.on('close', () => {
      if (over) return done('too-big')
      done(file && file.body.length > 0 ? file : 'no-file')
    })
    req.on('aborted', () => {
      bb.destroy()
      done('cut-off')
    })
    req.pipe(bb)
  })
}

function refuseUpload(res: Response, received: Exclude<Received, { name: string }>): void {
  if (received === 'not-multipart') return fail(res, 400, 'invalid', tr('contests.refusal.notMultipart'))
  if (received === 'too-big') return fail(res, 413, 'invalid', tr('contests.refusal.archiveTooBig', { count: mb(CONTEST_LIMITS.archiveBytes) }))
  if (received === 'no-file') return fail(res, 400, 'invalid', tr('contests.refusal.noFile'))
  fail(res, 400, 'invalid', tr('contests.refusal.uploadCutOff'))
}

/** What the archive's reader refused, in words the teacher can act on. */
function refuseZip(res: Response, error: ZipRefused): void {
  const name = error.entry ?? ''
  const words = {
    malformed: () => tr('contests.refusal.zip.malformed'),
    encrypted: () => tr('contests.refusal.zip.encrypted'),
    method: () => tr('contests.refusal.zip.method', { name }),
    multidisk: () => tr('contests.refusal.zip.multidisk'),
    tooManyEntries: () => tr('contests.refusal.zip.tooManyEntries', { count: ARCHIVE_ENTRIES }),
    fileTooBig: () => tr('contests.refusal.zip.fileTooBig', { name, count: mb(CONTEST_LIMITS.testBytes) }),
    totalTooBig: () => tr('contests.refusal.zip.totalTooBig', { count: mb(CONTEST_LIMITS.problemTestBytes) }),
    checksum: () => tr('contests.refusal.zip.checksum', { name }),
  }[error.why]
  fail(res, 400, 'invalid', words())
}

function refuseTests(res: Response, error: TestsRefused): void {
  if (error.why === 'tooMany') return fail(res, 400, 'invalid', tr('contests.refusal.testsTooMany', { count: CONTEST_LIMITS.tests }))
  if (error.why === 'fileTooBig') {
    return fail(res, 400, 'invalid', tr('contests.refusal.testTooBig', { test: error.ordinal ?? 0, count: mb(CONTEST_LIMITS.testBytes) }))
  }
  fail(res, 400, 'invalid', tr('contests.refusal.testsTooBig', { count: mb(CONTEST_LIMITS.problemTestBytes) }))
}

function refuseProblemArchive(res: Response, error: ProblemArchiveRefused): void {
  if (error.why === 'range' && error.range) {
    return fail(res, 400, 'invalid', tr('contests.refusal.problemArchive.range', { field: error.field, min: error.range.min, max: error.range.max }))
  }
  fail(res, 400, 'invalid', tr(`contests.refusal.problemArchive.${error.why}`, { field: error.field }))
}

/**
 * A tests change through the one way they change (revisions.ts), with the
 * refusals said in words; `true` — done.
 */
function tryChangeTests(res: Response, problem: ContestProblem, next: readonly NextTest[]): boolean {
  try {
    changeTests(problem, next)
    return true
  } catch (error) {
    if (error instanceof TestsRefused) refuseTests(res, error)
    else if (error instanceof ZipRefused) refuseZip(res, error)
    else if (error instanceof TestsMoved) fail(res, 409, 'failed', tr('contests.refusal.testsMoved'))
    else throw error
    return false
  }
}

/** An archive's tests, to be read from it when the revision is written. */
function archiveTests(archive: ZipArchive, tests: ReturnType<typeof planTests>['tests'], samples: readonly number[] = []): NextTest[] {
  return tests.map((test) => ({
    sample: samples.includes(test.number),
    group: 0,
    input: { bytes: () => archive.read(test.input) },
    answer: test.answer ? { bytes: () => archive.read(test.answer!) } : null,
    answerFrom: 'upload' as const,
  }))
}

/** IOI points of a stored report under the problem's groups now (for a rescore after the groups changed). */
function scorer(problem: ContestProblem): (report: StoredReport) => number {
  const groups = pointGroups(listTests(problem.id), problem.points, listGroups(problem.id))
  return (report) => pointsFor(groups, new Map<number, TestVerdict>(report.tests.map((test) => [test.ordinal, test.verdict])))
}

function rescoreIfIoi(contest: Contest, problemId: string): void {
  const problem = getProblem(problemId)
  if (contest.rules === 'ioi' && problem) rescoreProblem(problem, scorer(problem))
}

function openStream(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

const STREAM_GAP_MS = 250
const KEEP_ALIVE_MS = 20_000

/** What the teacher's download of a test says about caching: kept nowhere (the competitions' rule for their staff files). */
const STAFF_FILE_CACHE = 'private, no-store'

/* ------------------------------------------------------------------ doors */

export function adminContestRoutes(): Router {
  const router = Router()

  /*
   * The instance-wide doors are declared BEFORE `/:id`: express matches in
   * order, and `/contests/settings` would match `/contests/:id`.
   */

  /* ------------------------------------------------------------ settings */

  router.get('/api/admin/contests/settings', requireStaff, (_req, res) => {
    reply<ContestSettings>(res, { judgeSlots: savedJudgeSlots(), autoSlots: autoJudgeSlots() })
  })

  /** The judge's slots: an owner's, since the judge takes the machine from every course's class next to it. */
  router.put('/api/admin/contests/settings', ownerOnly('contests.owner.settings'), (req, res) => {
    const slots = parseJudgeSlots((req.body as { judgeSlots?: unknown } | undefined)?.judgeSlots ?? null)
    if (slots === 'invalid') return fail(res, 400, 'invalid', tr('contests.refusal.slots', { min: 1, max: 32 }))
    saveJudgeSlots(slots)
    recordAdminEvent({ actor: currentStaff(req), action: 'settings.competitions_changed', target: { type: 'settings', id: 'contests' }, detail: { changed: ['contests.judgeSlots'] }, req })
    noteJudgeChanged()
    // More slots may mean work can start right now.
    wakeContestJudge()
    reply<ContestSettings>(res, { judgeSlots: savedJudgeSlots(), autoSlots: autoJudgeSlots() })
  })

  /** Pause the judge, or let it go: an owner's — there is one judge for every course. Running judgings go on. */
  router.post('/api/admin/contests/judge/pause', ownerOnly('contests.owner.pause'), (req, res) => {
    pauseContestJudge((req.body as { paused?: unknown } | undefined)?.paused !== false)
    reply<JudgeStatus>(res, judgeStatus())
  })

  /* ------------------------------------------------------------ contests */

  router.get('/api/admin/contests', requireStaff, (req, res) => {
    const staff = currentStaff(req)
    reply<ContestList>(res, {
      contests: listContests().filter((contest) => canSeeContest(staff, contest)).map((contest) => rowOf(contest, staff)),
      judge: judgeStatus(),
    })
  })

  /** A new contest is always a draft; a separate door, with its readiness, opens it. */
  router.post('/api/admin/contests', requireStaff, async (req, res) => {
    const body = (req.body ?? {}) as Partial<NewContestBody>
    const title = titleIn(body.title, CONTEST_LIMITS.title)
    if (isRefusal(title)) return refuseInput(res, title)
    const slug = slugIn(body.slug)
    if (isRefusal(slug)) return refuseInput(res, slug)
    if (body.rules !== undefined && !CONTEST_RULES.includes(body.rules)) return refuseInput(res, { field: 'rules', why: 'value' })
    if (body.courseId !== undefined && body.courseId !== null && typeof body.courseId !== 'string') {
      return refuseInput(res, { field: 'courseId', why: 'value' })
    }
    const staff = currentStaff(req)
    if (!courseAllowed(staff, body.courseId, res)) return
    const created = createContest({ slug, title, rules: body.rules, courseId: body.courseId ?? null, createdBy: staff?.id ?? null })
    if (!created) return fail(res, 409, 'exists', tr('contests.refusal.slug.taken'))
    audit(req, 'contest.created', created, { slug: created.slug })
    res.status(201)
    reply<ContestView>(res, await viewOf(created, staff))
  })

  router.get('/api/admin/contests/:id', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    reply<ContestView>(res, await viewOf(contest, currentStaff(req)))
  })

  router.patch('/api/admin/contests/:id', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const parsed = parseContestPatch(req.body, contest)
    if ('refusal' in parsed) return refuseInput(res, parsed.refusal)
    const { fields } = parsed
    const staff = currentStaff(req)
    /*
     * The rules do not change under submissions: an ICPC judging stops at the
     * first failed test and gives no points, so the board would be counted
     * by IOI from verdicts that never ran the rest — quietly wrong for
     * everyone who already sent something.
     */
    if (fields.rules !== undefined && fields.rules !== contest.rules && hasEntrantSubmissions(contest.id)) {
      return fail(res, 409, 'invalid', tr('contests.refusal.rulesLocked'))
    }
    if (fields.courseId !== undefined && fields.courseId !== (contest.courseId ?? null)) {
      if (!courseAllowed(staff, fields.courseId, res)) return
      // A move that would take the contest out of the mover's own sight is refused.
      if (!canSeeContest(staff, { createdBy: contest.createdBy, courseId: fields.courseId })) {
        return fail(res, 409, 'invalid', tr('contests.refusal.courseWouldHide'))
      }
    }
    const saved = updateContest(contest.id, fields)
    if (saved === 'taken') return fail(res, 409, 'exists', tr('contests.refusal.slug.taken'))
    if (!saved) return fail(res, 404, 'not_found', tr('contests.refusal.notFound'))
    audit(req, 'contest.updated', saved, { changed: Object.keys(fields) })
    reply<ContestView>(res, await viewOf(saved, staff))
  })

  /**
   * Delete a contest with every row and file — its creator's or an owner's.
   * Its judgings are held back and the running ones stopped first and waited
   * for (pump.ts · holdAndStop): a container left running would hold a slot
   * for a row that is gone. A run that does not stop in time refuses the
   * delete, and the teacher tries again in a moment.
   */
  router.delete('/api/admin/contests/:id', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    if (!canDeleteContest(currentStaff(req), contest)) return fail(res, 403, 'forbidden', tr('contests.refusal.deleteForbidden'))
    const stop = await holdAndStop({ contestId: contest.id })
    try {
      if (!stop.ended || deleteContestRows(contest.id) === 'running') return fail(res, 409, 'failed', tr('contests.refusal.running'))
      removeContestFiles(contest.id)
      audit(req, 'contest.deleted', contest)
      res.status(204).end()
    } finally {
      stop.release()
    }
  })

  /* --------------------------------------------------------------- state */

  /**
   * Open a draft, or open a finished contest again — both only when it is
   * ready (readiness.ts), with the reasons in the refusal for the editor to
   * show. A contest opened without a start time starts now: an ICPC penalty
   * is counted from the start, and «no start» would make every solve cost
   * nothing.
   */
  const openFrom = (from: 'draft' | 'finished') => async (req: Request, res: Response): Promise<void> => {
    const contest = contestOf(req, res)
    if (!contest) return
    if (contest.state !== from) {
      return fail(res, 409, 'invalid', tr(from === 'draft' ? 'contests.refusal.notDraft' : 'contests.refusal.notFinished'))
    }
    const readiness = await contestReadiness(contest)
    if (readiness.length > 0) return fail(res, 409, 'not_ready', tr('contests.refusal.notReady'), { readiness })
    const fresh = getContest(contest.id)
    if (!fresh || fresh.state !== from) return fail(res, 409, 'invalid', tr('contests.refusal.notDraft'))
    if (fresh.startsAt === null) updateContest(fresh.id, { startsAt: Date.now() })
    setContestState(fresh.id, 'live')
    const opened = getContest(fresh.id)!
    audit(req, 'contest.opened', opened, from === 'finished' ? { reopened: true } : undefined)
    wakeContestJudge()
    reply<ContestView>(res, await viewOf(opened, currentStaff(req)))
  }
  router.post('/api/admin/contests/:id/open', requireStaff, openFrom('draft'))
  router.post('/api/admin/contests/:id/reopen', requireStaff, openFrom('finished'))

  router.post('/api/admin/contests/:id/finish', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    if (contest.state !== 'live') return fail(res, 409, 'invalid', tr('contests.refusal.notLive'))
    setContestState(contest.id, 'finished')
    const finished = getContest(contest.id)!
    audit(req, 'contest.finished', finished)
    reply<ContestView>(res, await viewOf(finished, currentStaff(req)))
  })

  /** «Разморозить»: the frozen board revealed to the class — only once the freeze has begun. */
  router.post('/api/admin/contests/:id/unfreeze', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    if (!boardFrozen(contest, Date.now())) return fail(res, 409, 'invalid', tr('contests.refusal.notFrozen'))
    setContestUnfrozen(contest.id, Date.now())
    const revealed = getContest(contest.id)!
    audit(req, 'contest.unfrozen', revealed)
    reply<ContestView>(res, await viewOf(revealed, currentStaff(req)))
  })

  /** «Снять с публикации»: every participant door answers as for a missing contest; nothing else changes. */
  router.post('/api/admin/contests/:id/hide', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    if (contest.state === 'draft') return fail(res, 409, 'invalid', tr('contests.refusal.draftHide'))
    if (contest.hiddenAt !== null) return fail(res, 409, 'invalid', tr('contests.refusal.alreadyHidden'))
    setContestHidden(contest.id, Date.now())
    const hidden = getContest(contest.id)!
    audit(req, 'contest.hidden', hidden)
    reply<ContestView>(res, await viewOf(hidden, currentStaff(req)))
  })

  router.post('/api/admin/contests/:id/show', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    if (contest.hiddenAt === null) return fail(res, 409, 'invalid', tr('contests.refusal.notHidden'))
    setContestHidden(contest.id, null)
    const shown = getContest(contest.id)!
    audit(req, 'contest.shown', shown)
    reply<ContestView>(res, await viewOf(shown, currentStaff(req)))
  })

  /** Judge again every judged submission of the contest, or `{stale: true}` — those judged on older tests. */
  router.post('/api/admin/contests/:id/rejudge', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const stale = (req.body as { stale?: unknown } | undefined)?.stale === true
    const queued = rejudgeProblems(listProblems(contest.id), stale)
    if (queued > 0) audit(req, 'contest.rejudged', contest, { scope: 'contest', stale, count: queued })
    wakeContestJudge()
    res.json({ queued })
  })

  /* ------------------------------------------------------------ problems */

  router.post('/api/admin/contests/:id/problems', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const parsed = parseProblemPatch(req.body)
    if ('refusal' in parsed) return refuseInput(res, parsed.refusal)
    const made = addProblem(contest.id, parsed.fields)
    if (made === 'full') return fail(res, 409, 'invalid', tr('contests.refusal.problemsFull'))
    res.status(201)
    reply<ProblemView>(res, problemView(made))
  })

  router.put('/api/admin/contests/:id/problems/order', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const ids = (req.body as { ids?: unknown } | undefined)?.ids
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string') || !reorderProblems(contest.id, ids as string[])) {
      return fail(res, 400, 'invalid', tr('contests.refusal.order'))
    }
    reply<ContestView>(res, await viewOf(getContest(contest.id)!, currentStaff(req)))
  })

  /**
   * A copy of a problem — of this contest or of another the caller runs — at
   * the end of this one: its fields, its tests (hard links, no disk spent),
   * its groups. Its reference is checked afresh: the check belongs to the
   * problem it ran for.
   */
  router.post('/api/admin/contests/:id/problems/copy', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const source = getProblem(String((req.body as { fromProblemId?: unknown } | undefined)?.fromProblemId ?? ''))
    const from = source ? getContest(source.contestId) : null
    if (!source || !from || !canSeeContest(currentStaff(req), from)) return fail(res, 404, 'not_found', tr('contests.refusal.noProblem'))
    const made = addProblem(contest.id, {
      title: source.title,
      statement: source.statement,
      timeLimitMs: source.timeLimitMs,
      memoryMb: source.memoryMb,
      checker: source.checker,
      checkerEpsilon: source.checkerEpsilon,
      checkerCode: source.checkerCode,
      points: source.points,
      referenceLanguage: source.referenceLanguage,
      referenceSource: source.referenceSource,
    })
    if (made === 'full') return fail(res, 409, 'invalid', tr('contests.refusal.problemsFull'))
    const tests = listTests(source.id)
    if (tests.length > 0 && !tryChangeTests(res, made, keepAll(source, tests))) {
      deleteProblemRows(made.id)
      removeProblemFiles(contest.id, made.id)
      return
    }
    replaceGroups(made.id, listGroups(source.id))
    if (tests.length > 0) audit(req, 'contest.problem.tests', contest, { problem: problemLetter(made.position), change: 'copy', tests: tests.length })
    res.status(201)
    reply<ProblemView>(res, problemView(getProblem(made.id)!))
  })

  /**
   * A whole problem from one archive (tests-import.ts · readProblemArchive):
   * `problem.json`, `statement.md`, `checker.py`, `solution.*` and the tests.
   * All of it or nothing: a refused test removes the problem just made.
   */
  router.post('/api/admin/contests/:id/problems/import', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const received = await receiveFile(req, CONTEST_LIMITS.archiveBytes)
    if (typeof received === 'string') return refuseUpload(res, received)
    let archive: ZipArchive
    let parsed: ReturnType<typeof readProblemArchive>
    try {
      archive = openZip(received.body, {
        maxEntries: ARCHIVE_ENTRIES,
        maxFileBytes: CONTEST_LIMITS.testBytes,
        maxTotalBytes: CONTEST_LIMITS.problemTestBytes + PROBLEM_EXTRAS_BYTES,
      })
      parsed = readProblemArchive(archive)
    } catch (error) {
      if (error instanceof ZipRefused) return refuseZip(res, error)
      if (error instanceof ProblemArchiveRefused) return refuseProblemArchive(res, error)
      throw error
    }
    if (parsed.tests.tests.length > CONTEST_LIMITS.tests) return refuseTests(res, new TestsRefused('tooMany'))
    const fresh = getContest(contest.id)
    if (!fresh) return fail(res, 404, 'not_found', tr('contests.refusal.notFound'))
    const heading = /^\s*#\s+(.+?)\s*$/m.exec(parsed.statement ?? '')?.[1]
    const made = addProblem(fresh.id, {
      ...(parsed.meta.title || heading ? { title: (parsed.meta.title ?? heading ?? '').slice(0, CONTEST_LIMITS.problemTitle) } : {}),
      statement: parsed.statement ?? '',
      timeLimitMs: parsed.meta.timeLimitMs,
      memoryMb: parsed.meta.memoryMb,
      checker: parsed.meta.checker ?? (parsed.checkerCode !== null ? 'custom' : 'tokens'),
      checkerEpsilon: parsed.meta.checkerEpsilon,
      checkerCode: parsed.checkerCode ?? '',
      points: parsed.meta.points,
      referenceLanguage: parsed.reference?.language,
      referenceSource: parsed.reference?.source ?? '',
    })
    if (made === 'full') return fail(res, 409, 'invalid', tr('contests.refusal.problemsFull'))
    if (parsed.tests.tests.length > 0 && !tryChangeTests(res, made, archiveTests(archive, parsed.tests.tests, parsed.meta.samples))) {
      deleteProblemRows(made.id)
      removeProblemFiles(fresh.id, made.id)
      return
    }
    audit(req, 'contest.problem.tests', fresh, { problem: problemLetter(made.position), change: 'import', tests: parsed.tests.tests.length })
    res.status(201)
    reply<ProblemView>(res, problemView(getProblem(made.id)!))
  })

  router.patch('/api/admin/contests/:id/problems/:pid', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem) return
    const parsed = parseProblemPatch(req.body)
    if ('refusal' in parsed) return refuseInput(res, parsed.refusal)
    const saved = updateProblem(problem.id, parsed.fields)
    if (!saved) return fail(res, 404, 'not_found', tr('contests.refusal.noProblem'))
    // A switch between points per test and per group gives every judged submission its points anew.
    if (parsed.fields.points !== undefined && parsed.fields.points !== problem.points) rescoreIfIoi(contest, problem.id)
    reply<ProblemView>(res, problemView(getProblem(problem.id)!))
  })

  router.delete('/api/admin/contests/:id/problems/:pid', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem) return
    const stop = await holdAndStop({ contestId: contest.id, problemId: problem.id })
    try {
      if (!stop.ended) return fail(res, 409, 'failed', tr('contests.refusal.running'))
      const removed = deleteProblemRows(problem.id)
      if (removed === 'running') return fail(res, 409, 'failed', tr('contests.refusal.running'))
      if (!removed) return fail(res, 404, 'not_found', tr('contests.refusal.noProblem'))
      removeProblemFiles(contest.id, problem.id)
    } finally {
      stop.release()
    }
    audit(req, 'contest.updated', contest, { deletedProblem: problem.title })
    reply<ContestView>(res, await viewOf(getContest(contest.id)!, currentStaff(req)))
  })

  /* --------------------------------------------------------------- tests */

  /**
   * An archive of tests: `replace` (the default) — these are the problem's
   * tests now; `append` — after the ones there are. Every recognised layout
   * is taken (tests-import.ts); the rest is named in `skipped`.
   */
  router.post('/api/admin/contests/:id/problems/:pid/tests/archive', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    if (!problemFor(contest, req, res)) return
    const mode = req.query.mode === 'append' ? 'append' : 'replace'
    const received = await receiveFile(req, CONTEST_LIMITS.archiveBytes)
    if (typeof received === 'string') return refuseUpload(res, received)
    let archive: ZipArchive
    try {
      archive = openZip(received.body, { maxEntries: ARCHIVE_ENTRIES, maxFileBytes: CONTEST_LIMITS.testBytes, maxTotalBytes: CONTEST_LIMITS.problemTestBytes })
    } catch (error) {
      if (error instanceof ZipRefused) return refuseZip(res, error)
      throw error
    }
    const plan = planTests(archive.entries)
    const skipped = [...archive.ignored, ...plan.skipped]
    if (plan.tests.length === 0) return fail(res, 400, 'invalid', tr('contests.refusal.noTestsInArchive'), { skipped })
    // The problem as it is after the upload, not before it: the body took a while.
    const problem = problemOf(contest.id, String(req.params.pid))
    if (!problem) return fail(res, 404, 'not_found', tr('contests.refusal.noProblem'))
    const next = [...(mode === 'append' ? keepAll(problem) : []), ...archiveTests(archive, plan.tests)]
    if (next.length > CONTEST_LIMITS.tests) return refuseTests(res, new TestsRefused('tooMany'))
    if (!tryChangeTests(res, problem, next)) return
    audit(req, 'contest.problem.tests', contest, { problem: problemLetter(problem.position), change: mode === 'append' ? 'archive-append' : 'archive', tests: plan.tests.length })
    reply<ArchiveImport>(res, {
      problem: problemView(getProblem(problem.id)!),
      added: plan.tests.length,
      withoutAnswers: plan.tests.filter((test) => test.answer === null).length,
      skipped,
    })
  })

  /** One test typed in by hand, at the end. Its answer may wait for the reference. */
  router.post('/api/admin/contests/:id/problems/:pid/tests', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem) return
    const body = (req.body ?? {}) as Partial<NewTestBody>
    if (typeof body.input !== 'string') return refuseInput(res, { field: 'input', why: 'value' })
    if (body.answer !== undefined && body.answer !== null && typeof body.answer !== 'string') return refuseInput(res, { field: 'answer', why: 'value' })
    if (body.sample !== undefined && typeof body.sample !== 'boolean') return refuseInput(res, { field: 'sample', why: 'value' })
    const group = body.group === undefined ? 0 : wholeIn(body.group, 'group', GROUP_RANGE)
    if (isRefusal(group)) return refuseInput(res, group)
    const answer = typeof body.answer === 'string' ? body.answer : null
    const next: NextTest[] = [
      ...keepAll(problem),
      {
        sample: body.sample === true,
        group,
        input: { bytes: Buffer.from(body.input, 'utf8') },
        answer: answer === null ? null : { bytes: Buffer.from(answer, 'utf8') },
        answerFrom: 'upload',
      },
    ]
    if (!tryChangeTests(res, problem, next)) return
    audit(req, 'contest.problem.tests', contest, { problem: problemLetter(problem.position), change: 'add' })
    res.status(201)
    reply<ProblemView>(res, problemView(getProblem(problem.id)!))
  })

  /** Every test of the problem goes (a new, empty revision). */
  router.delete('/api/admin/contests/:id/problems/:pid/tests', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem) return
    if (!tryChangeTests(res, problem, [])) return
    audit(req, 'contest.problem.tests', contest, { problem: problemLetter(problem.position), change: 'clear' })
    reply<ProblemView>(res, problemView(getProblem(problem.id)!))
  })

  /** A test's marks — example, group — or its place (`ordinal`; the others shift). */
  router.patch('/api/admin/contests/:id/problems/:pid/tests/:n', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem) return
    const tests = listTests(problem.id)
    const index = tests.findIndex((test) => test.ordinal === Number(req.params.n))
    if (index < 0) return fail(res, 404, 'not_found', tr('contests.refusal.noTest'))
    const body = (req.body ?? {}) as TestPatch
    const next = keepAll(problem, tests)
    const moved = next[index]
    if (body.sample !== undefined) {
      if (typeof body.sample !== 'boolean') return refuseInput(res, { field: 'sample', why: 'value' })
      moved.sample = body.sample
    }
    if (body.group !== undefined) {
      const group = wholeIn(body.group, 'group', GROUP_RANGE)
      if (isRefusal(group)) return refuseInput(res, group)
      moved.group = group
    }
    if (body.ordinal !== undefined) {
      const ordinal = wholeIn(body.ordinal, 'ordinal', { min: 1, max: tests.length })
      if (isRefusal(ordinal)) return refuseInput(res, ordinal)
      next.splice(index, 1)
      next.splice(ordinal - 1, 0, moved)
    }
    if (!tryChangeTests(res, problem, next)) return
    audit(req, 'contest.problem.tests', contest, { problem: problemLetter(problem.position), change: 'edit', test: tests[index].ordinal })
    reply<ProblemView>(res, problemView(getProblem(problem.id)!))
  })

  router.delete('/api/admin/contests/:id/problems/:pid/tests/:n', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem) return
    const tests = listTests(problem.id)
    const index = tests.findIndex((test) => test.ordinal === Number(req.params.n))
    if (index < 0) return fail(res, 404, 'not_found', tr('contests.refusal.noTest'))
    const next = keepAll(problem, tests)
    next.splice(index, 1)
    if (!tryChangeTests(res, problem, next)) return
    audit(req, 'contest.problem.tests', contest, { problem: problemLetter(problem.position), change: 'delete', test: tests[index].ordinal })
    reply<ProblemView>(res, problemView(getProblem(problem.id)!))
  })

  /** A test's input or answer, whole, as a text file for the teacher: kept by no cache on the way. */
  for (const part of ['input', 'answer'] as const) {
    router.get(`/api/admin/contests/:id/problems/:pid/tests/:n/${part}`, requireStaff, (req, res) => {
      const contest = contestOf(req, res)
      if (!contest) return
      const problem = problemFor(contest, req, res)
      if (!problem) return
      const test = listTests(problem.id).find((one) => one.ordinal === Number(req.params.n))
      if (!test || (part === 'answer' && test.answerBytes === null)) return fail(res, 404, 'not_found', tr('contests.refusal.noTest'))
      let held: ReturnType<typeof holdTestFile>
      try {
        held = holdTestFile(contest.id, problem.id, problem.testsRevision, test.ordinal, part === 'input' ? 'in' : 'ans')
      } catch {
        return fail(res, 404, 'not_found', tr('contests.refusal.noTest'))
      }
      const name = `${problemLetter(problem.position)}-${String(test.ordinal).padStart(2, '0')}.${part === 'input' ? 'in' : 'ans'}`
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      try {
        res.download(held.path, name, { dotfiles: 'allow', etag: false, lastModified: false, cacheControl: false, headers: { 'Cache-Control': STAFF_FILE_CACHE } }, (error) => {
          held.close()
          if (error && !res.headersSent) fail(res, 404, 'not_found', tr('contests.refusal.noTest'))
        })
      } catch (error) {
        held.close()
        throw error
      }
    })
  }

  /** The IOI groups' table, as a whole; the judged submissions get their points anew from their verdicts. */
  router.put('/api/admin/contests/:id/problems/:pid/groups', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem) return
    const raw = (req.body as { groups?: unknown } | undefined)?.groups
    if (!Array.isArray(raw) || raw.length > CONTEST_LIMITS.tests) return refuseInput(res, { field: 'groups', why: 'value' })
    const groups: ContestGroup[] = []
    for (const item of raw as { group?: unknown; points?: unknown }[]) {
      const group = wholeIn(item?.group, 'group', GROUP_RANGE)
      if (isRefusal(group)) return refuseInput(res, group)
      const points = wholeIn(item?.points, 'points', GROUP_POINTS)
      if (isRefusal(points)) return refuseInput(res, points)
      if (groups.some((one) => one.group === group)) return refuseInput(res, { field: 'group', why: 'value' })
      groups.push({ group, points })
    }
    replaceGroups(problem.id, groups)
    rescoreIfIoi(contest, problem.id)
    reply<ProblemView>(res, problemView(getProblem(problem.id)!))
  })

  /* ----------------------------------------------------------- reference */

  /** What a teacher's run of the reference needs before it is queued: a source and tests; a check also every answer. */
  function teacherRunRefusal(res: Response, problem: ContestProblem, kind: 'reference' | 'answers'): boolean {
    if (!currentJudge()) {
      fail(res, 503, 'no_docker', tr('contests.refusal.unavailable'))
      return true
    }
    if (!problem.referenceSource.trim()) {
      fail(res, 409, 'invalid', tr('contests.refusal.noReference'))
      return true
    }
    const tests = listTests(problem.id)
    if (tests.length === 0) {
      fail(res, 409, 'invalid', tr('contests.refusal.noTestsYet'))
      return true
    }
    const missing = tests.filter((test) => test.answerBytes === null).length
    if (kind === 'reference' && missing > 0) {
      fail(res, 409, 'invalid', tr('contests.refusal.answersFirst', { count: missing }))
      return true
    }
    return false
  }

  router.post('/api/admin/contests/:id/problems/:pid/reference/check', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem || teacherRunRefusal(res, problem, 'reference')) return
    enqueueTeacherRun(problem, 'reference')
    wakeContestJudge()
    reply<ProblemView>(res, problemView(getProblem(problem.id)!))
  })

  /** «Ответы из эталона»: the reference runs on every test and its outputs become the missing answers. */
  router.post('/api/admin/contests/:id/problems/:pid/reference/answers', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem || teacherRunRefusal(res, problem, 'answers')) return
    enqueueTeacherRun(problem, 'answers')
    audit(req, 'contest.problem.tests', contest, { problem: problemLetter(problem.position), change: 'answers' })
    wakeContestJudge()
    reply<ProblemView>(res, problemView(getProblem(problem.id)!))
  })

  /** Judge again a problem's judged submissions, or `{stale: true}` — only those judged on older tests. */
  router.post('/api/admin/contests/:id/problems/:pid/rejudge', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const problem = problemFor(contest, req, res)
    if (!problem) return
    const stale = (req.body as { stale?: unknown } | undefined)?.stale === true || req.query.stale === '1'
    const queued = rejudgeProblems([problem], stale)
    if (queued > 0) audit(req, 'contest.rejudged', contest, { scope: 'problem', problem: problemLetter(problem.position), stale, count: queued })
    wakeContestJudge()
    res.json({ queued })
  })

  /* --------------------------------------------------------- submissions */

  /** The console's feed: newest first, by problem (id or letter), verdict (`pending` too), person, number or name. */
  router.get('/api/admin/contests/:id/submissions', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const query = req.query as Record<string, unknown>
    const text = (key: string): string => (typeof query[key] === 'string' ? (query[key] as string).trim() : '')
    let problemId: string | undefined
    if (text('problem')) {
      const byLetter = /^[A-Za-z]$/.test(text('problem'))
        ? listProblems(contest.id).find((problem) => problemLetter(problem.position) === text('problem').toUpperCase())
        : problemOf(contest.id, text('problem'))
      if (!byLetter) return fail(res, 404, 'not_found', tr('contests.refusal.noProblem'))
      problemId = byLetter.id
    }
    const verdict = text('verdict')
    if (verdict && verdict !== 'pending' && !VERDICTS.includes(verdict as Verdict)) return refuseInput(res, { field: 'verdict', why: 'value' })
    const kind = text('kind') || 'entrant'
    if (!['entrant', 'reference', 'answers', 'all'].includes(kind)) return refuseInput(res, { field: 'kind', why: 'value' })
    const limit = Math.min(FEED_PAGE.max, Math.max(1, Number.parseInt(text('limit'), 10) || FEED_PAGE.default))
    const offset = Math.max(0, Number.parseInt(text('offset'), 10) || 0)
    const page = listContestSubmissions(contest.id, {
      kind: kind as 'entrant' | 'reference' | 'answers' | 'all',
      problemId,
      verdict: (verdict || undefined) as Verdict | 'pending' | undefined,
      entrantId: text('entrant') || undefined,
      q: text('q') || undefined,
      limit,
      offset,
    })
    const letters = lettersOf(contest.id)
    const names = namesOf(contest.id)
    reply<AdminSubmissions>(res, { submissions: page.rows.map((row) => adminRow(row, letters, names)), total: page.total })
  })

  router.get('/api/admin/contests/:id/submissions/:sid', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const submission = getSubmission(String(req.params.sid))
    if (!submission || submission.contestId !== contest.id) return fail(res, 404, 'not_found', tr('contests.refusal.noSubmission'))
    reply<AdminSubmissionDetail>(res, {
      ...adminRow(submission, lettersOf(contest.id), namesOf(contest.id)),
      source: submission.source,
      compileLog: submission.compileLog,
      tests: reportTests(submission),
      systemDetail: submission.systemDetail,
    })
  })

  router.post('/api/admin/contests/:id/submissions/:sid/rejudge', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const submission = getSubmission(String(req.params.sid))
    if (!submission || submission.contestId !== contest.id) return fail(res, 404, 'not_found', tr('contests.refusal.noSubmission'))
    const outcome = rejudgeSubmission(submission.id)
    if (outcome === 'running') return fail(res, 409, 'invalid', tr('contests.refusal.beingJudged'))
    if (outcome === 'requeued') audit(req, 'contest.rejudged', contest, { scope: 'submission', number: submission.number, count: 1 })
    wakeContestJudge()
    reply<AdminSubmissionRow>(res, adminRow(getSubmission(submission.id) ?? submission, lettersOf(contest.id), namesOf(contest.id)))
  })

  /* ----------------------------------------------------------- the board */

  /** Unfrozen with every name whole — or, `?audience=class`, exactly what the class sees. */
  router.get('/api/admin/contests/:id/standings', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const board = contestBoard(contest, req.query.audience === 'class' ? { entrantId: null, staff: false } : { entrantId: null, staff: true })
    reply<AdminStandings>(res, {
      rules: contest.rules,
      problems: board.problems,
      rows: board.rows,
      totals: board.totals,
      frozen: board.frozen,
      freezeAt: board.freezeAt,
      penaltyMinutes: contest.penaltyMinutes,
      startsAt: contest.startsAt,
    })
  })

  router.get('/api/admin/contests/:id/standings.csv', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Cache-Control', STAFF_FILE_CACHE)
    res.attachment(`${contest.slug}-standings.csv`)
    res.send(standingsCsv(contest))
  })

  /* ----------------------------------------------------------- entrants */

  router.get('/api/admin/contests/:id/entrants', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    res.json(entrantsOf(contest))
  })

  /**
   * Remove a person from this contest: their submissions, questions and
   * enrollment — and the person with their key when nothing else on the
   * instance holds them. Their judgings are held back and the running one
   * stopped and waited for (pump.ts · holdAndStop); a run that does not end in
   * time refuses the removal, and nothing is touched — their submissions wait
   * to be judged as before.
   */
  router.delete('/api/admin/contests/:id/entrants/:eid', requireStaff, async (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const entrantId = String(req.params.eid)
    if (contestJoinedAt(contest.id, entrantId) === null && entrantSubmissionStats(contest.id).get(entrantId) === undefined) {
      return fail(res, 404, 'not_found', tr('contests.refusal.noEntrant'))
    }
    const stop = await holdAndStop({ contestId: contest.id, entrantId })
    let removed: ReturnType<typeof removeContestEntrantRows>
    try {
      // A run of a previous life not reclaimed yet is nobody's here to stop: the rows refuse it ('running').
      removed = stop.ended ? removeContestEntrantRows(contest.id, entrantId) : 'running'
    } finally {
      stop.release()
    }
    if (removed === 'running') return fail(res, 409, 'failed', tr('contests.refusal.running'))
    for (const submission of removed.submissions) removeJobDir(contest.id, submission.id, submission.attempt)
    recordAdminEvent({
      actor: currentStaff(req),
      action: 'contest.entrant.removed',
      target: { type: 'entrant', id: entrantId, label: null },
      detail: { contest: contest.id, submissions: removed.submissions.length, identityRemoved: removed.identityRemoved },
      req,
    })
    res.json(entrantsOf(contest))
  })

  /* ---------------------------------------------------------- questions */

  router.get('/api/admin/contests/:id/questions', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    reply<AdminQuestions>(res, questionsOf(contest))
  })

  /** «Ответить лично» / «Ответить всем»: the second makes the question and its answer an announcement. */
  router.post('/api/admin/contests/:id/questions/:qid/answer', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const question = getQuestion(String(req.params.qid))
    if (!question || question.contestId !== contest.id) return fail(res, 404, 'not_found', tr('contests.refusal.noQuestion'))
    const body = (req.body ?? {}) as Partial<AnswerBody>
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    if (!answer) return fail(res, 400, 'invalid', tr('contests.refusal.answerEmpty'))
    if (answer.length > CONTEST_LIMITS.answer) return refuseInput(res, { field: 'answer', why: 'tooLong', max: CONTEST_LIMITS.answer })
    const answered = answerQuestion(question.id, answer, body.public === true, currentStaff(req)?.id ?? null)
    if (!answered) return fail(res, 404, 'not_found', tr('contests.refusal.noQuestion'))
    reply<AdminQuestion>(res, questionView(answered, lettersOf(contest.id), namesOf(contest.id)))
  })

  router.post('/api/admin/contests/:id/announcements', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const body = (req.body ?? {}) as Partial<AnnouncementBody>
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return fail(res, 400, 'invalid', tr('contests.refusal.announcementEmpty'))
    if (text.length > CONTEST_LIMITS.answer) return refuseInput(res, { field: 'text', why: 'tooLong', max: CONTEST_LIMITS.answer })
    let problemId: string | null = null
    if (body.problemId !== undefined && body.problemId !== null) {
      const problem = typeof body.problemId === 'string' ? problemOf(contest.id, body.problemId) : null
      if (!problem) return fail(res, 404, 'not_found', tr('contests.refusal.noProblem'))
      problemId = problem.id
    }
    const made = announce(contest.id, problemId, text, currentStaff(req)?.id ?? null)
    res.status(201)
    reply<AdminQuestion>(res, questionView(made, lettersOf(contest.id), namesOf(contest.id)))
  })

  router.delete('/api/admin/contests/:id/questions/:qid', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    const question = getQuestion(String(req.params.qid))
    if (!question || question.contestId !== contest.id) return fail(res, 404, 'not_found', tr('contests.refusal.noQuestion'))
    deleteQuestion(question.id)
    reply<AdminQuestions>(res, questionsOf(contest))
  })

  /* -------------------------------------------------------------- stream */

  /**
   * The console's stream: revisions to compare, nothing heavy — pushed on
   * every change of this contest and on the judge's (any contest's
   * submissions move its strip). Ends when the contest is gone, or no longer
   * the caller's.
   */
  router.get('/api/admin/contests/:id/stream', requireStaff, (req, res) => {
    const contest = contestOf(req, res)
    if (!contest) return
    openStream(res)
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
      const fresh = getContest(contest.id)
      if (!fresh || !canSeeContest(currentStaff(req), fresh)) {
        stop()
        res.end()
        return
      }
      const questions = listQuestions(fresh.id)
      const state: ContestLiveState = {
        revision: fresh.revision,
        ...contestQueueCounts(fresh.id),
        submissions: submissionsVersion(fresh.id),
        questions: createHash('sha1')
          .update(JSON.stringify(questions.map((q) => [q.id, q.answer, q.answeredAt, q.public])))
          .digest('base64url')
          .slice(0, 16),
        judge: judgeStatus(),
        now: Date.now(),
      }
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`)
    }
    const schedule = (): void => {
      if (pending || closed) return
      pending = setTimeout(push, Math.max(0, lastAt + STREAM_GAP_MS - Date.now()))
    }
    push()
    if (closed) return
    unwatch = watchContests(schedule)
    beat = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS)
    req.on('close', stop)
  })

  return router
}
