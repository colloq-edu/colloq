/**
 * Contests: algorithmic problems with tests, as on Yandex.Contest or
 * Codeforces — types and rules shared by the server and the web app.
 *
 * A contest is a set of problems (A, B, C…). A participant sends SOURCE CODE
 * for one problem in one language; the judge compiles it and runs it on the
 * problem's tests in a disposable container without network, test by test,
 * each with a time and a memory limit, and compares every output with the
 * teacher's answer. The result is a verdict — OK, WA, TL, ML, RE, OL, CE —
 * and the number of the first test that failed.
 *
 * The sibling of `shared/competitions.ts`, not a kind of it. A competition
 * runs one notebook against one metric and ranks by a number; a contest runs
 * many small programs against many tests and ranks by problems solved. They
 * share the participant (the instance-level entrant with a sign-in key, the
 * `/k` list) and the board's manners (distinct places, masked addresses,
 * visibility), and nothing of the pipeline.
 *
 * WHAT LIVES EXACTLY HERE: the rules on which the server and the browser must
 * give one and the same answer — the phase a contest is in, the letter of a
 * problem, how a test's points are split, which verdicts cost an attempt, and
 * above all THE STANDINGS: who is above whom, what a frozen cell shows to
 * whom. Once apart, two copies of the standings do not crash — they quietly
 * disagree, and whoever notices is the student who counted the penalty by
 * hand.
 *
 * What is not here: a single access to the disk, the database or docker.
 * Pure functions and data, and so are their tests (tests/contests-rules).
 */
import { tr } from './i18n.js'
import { slugOk } from './publish.js'
import type { BoardVisibility } from './competitions.js'

/* ------------------------------------------------------------------ contest */

/**
 * Draft · live · finished — the stored state, moved only by a hand.
 *
 * Exactly as for competitions (competitionPhase): the dates never change the
 * state, the phase is worked out from both (contestPhase), so a deadline
 * moved later reopens the contest with no second press.
 */
export type ContestState = 'draft' | 'live' | 'finished'

/** Where a contest is in its life, as every list and header names it. */
export type ContestPhase = 'draft' | 'soon' | 'open' | 'over'

/**
 * How the standings count.
 *
 * `icpc` — a problem is solved or not; the place is by problems solved, then
 * by penalty minutes. The classroom test against the clock. `ioi` — every
 * problem gives points for the tests (or groups of tests) it passes; the
 * place is by the sum of the best submissions. The homework.
 */
export type ContestRules = 'icpc' | 'ioi'

export const CONTEST_RULES: readonly ContestRules[] = ['icpc', 'ioi']

/**
 * The languages a submission can be in.
 *
 * Ids rather than display names: the display carries the compiler's version,
 * and that comes from the image the contest runs in (a probe), not from here.
 * The command lines are the judge's (server/src/contests/judge).
 */
export type ContestLanguage = 'python3' | 'cpp20' | 'c17'

export const CONTEST_LANGUAGES: readonly ContestLanguage[] = ['python3', 'cpp20', 'c17']

/** What a language needs from the image: python3 is always there, the C family needs a compiler. */
export const LANGUAGE_TOOL: Record<ContestLanguage, 'python' | 'gpp' | 'gcc'> = {
  python3: 'python',
  cpp20: 'gpp',
  c17: 'gcc',
}

/** The file name a source goes under — in the judge, in a download, in the editor's mode. */
export const LANGUAGE_FILE: Record<ContestLanguage, string> = {
  python3: 'solution.py',
  cpp20: 'solution.cpp',
  c17: 'solution.c',
}

/**
 * The language a dropped file means, by its extension; `null` — none of ours.
 * `.h`/`.hpp` are not sources a judge can run alone, and are not taken.
 */
export function languageOfFile(name: string): ContestLanguage | null {
  const ext = String(name ?? '').toLowerCase().split('.').pop() ?? ''
  if (ext === 'py') return 'python3'
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'c++') return 'cpp20'
  if (ext === 'c') return 'c17'
  return null
}

/**
 * How an output is compared with the answer.
 *
 * `tokens` — word by word through any whitespace: what most problems want and
 * the default. `lines` — line by line, trailing spaces and trailing empty
 * lines ignored. `float` — word by word, numbers within an absolute or
 * relative epsilon. `custom` — the teacher's Python `check(input, output,
 * answer)`, for problems with more than one right answer.
 */
export type CheckerKind = 'tokens' | 'lines' | 'float' | 'custom'

export const CHECKER_KINDS: readonly CheckerKind[] = ['tokens', 'lines', 'float', 'custom']

/**
 * How an IOI problem's points are split: equally between the tests that are
 * not examples (`tests`), or by groups the teacher sets, a group giving its
 * points only when every test in it passes (`groups`). ICPC ignores it.
 */
export type PointsMode = 'tests' | 'groups'

export interface Contest {
  id: string
  /** The address: `/a/<slug>`. */
  slug: string
  title: string
  /** One line — in the participant's list. */
  blurb: string
  /** Markdown above the problems: the rules of the class, what may be used. */
  description: string
  state: ContestState
  rules: ContestRules
  /** ICPC: minutes added for every rejected attempt before the accepted one. */
  penaltyMinutes: number
  /**
   * The standings freeze this many minutes before the end; 0 — never.
   *
   * During the freeze everyone keeps seeing their OWN verdicts, and other
   * people's new attempts show as «?». The board stays frozen after the end
   * until the teacher reveals it (`unfrozenAt`) — the reveal is a moment of
   * the class, not of the clock.
   */
  freezeMinutes: number
  /** When the teacher revealed the frozen board; null — not revealed (or never frozen). */
  unfrozenAt: number | null
  /** Submissions per problem per person; 0 — no limit. Compilation errors do not count. */
  attemptsPerProblem: number
  /** The languages this contest takes, in the order the editor offers them. */
  languages: ContestLanguage[]
  /** The image the judge runs in: the same environments as class kernels. */
  environment: string
  startsAt: number | null
  endsAt: number | null
  /**
   * «Дорешивание»: after the end submissions are still taken and judged, and
   * marked late — never on the board, never in the place.
   */
  upsolving: boolean
  boardVisibility: BoardVisibility
  /** The course this contest belongs to (the panel's scope rule); null — none. */
  courseId: string | null
  createdBy: string | null
  /** «Снять с публикации»: while set, every participant door answers as for a missing contest. */
  hiddenAt: number | null
  /** Bumps on every change a participant's page can see — streams compare it. */
  revision: number
  createdAt: number
  updatedAt: number
}

/** The fields a participant may see: no creator, no course, nothing of the panel. */
export type ContestPublic = Omit<Contest, 'createdBy' | 'courseId' | 'hiddenAt'>

export function publicContest(c: Contest): ContestPublic {
  const { createdBy: _c, courseId: _k, hiddenAt: _h, ...rest } = c
  return rest
}

/** Shown on `/k` and reachable at `/a/<slug>`: not a draft and not taken off publication. */
export function shownToParticipants(c: Pick<Contest, 'state' | 'hiddenAt'>): boolean {
  return c.state !== 'draft' && (c.hiddenAt ?? null) === null
}

/**
 * The phase — in the same order as `submissionsOpenFor`, so that a page and a
 * list never disagree (competitionPhase's rule, word for word).
 */
export function contestPhase(c: Pick<Contest, 'state' | 'startsAt' | 'endsAt'>, now: number): ContestPhase {
  if (c.state === 'draft') return 'draft'
  if (c.state === 'finished') return 'over'
  if (c.startsAt !== null && now < c.startsAt) return 'soon'
  if (c.endsAt !== null && now > c.endsAt) return 'over'
  return 'open'
}

/**
 * Whether a submission is taken right now: on time (`open`), as upsolving
 * (`late`), or not at all. Problems are hidden before the start, so `not_open`
 * is also «nothing to read yet».
 */
export type ContestAccepting = 'open' | 'late' | 'not_open' | 'closed'

export function submissionsOpenFor(
  c: Pick<Contest, 'state' | 'startsAt' | 'endsAt' | 'upsolving'>,
  now: number,
): ContestAccepting {
  if (c.state === 'draft') return 'not_open'
  const over = c.upsolving ? 'late' : 'closed'
  if (c.state === 'finished') return over
  if (c.startsAt !== null && now < c.startsAt) return 'not_open'
  if (c.endsAt !== null && now > c.endsAt) return over
  return 'open'
}

/** Problems are readable once the contest has started (or ended); a draft shows them to staff only. */
export function problemsVisible(c: Pick<Contest, 'state' | 'startsAt'>, now: number): boolean {
  if (c.state === 'draft') return false
  if (c.state === 'finished') return true
  return c.startsAt === null || now >= c.startsAt
}

/**
 * When the board freezes; null — no freeze. Counted from the end, so moving
 * the end moves the freeze with it.
 */
export function freezeAt(c: Pick<Contest, 'freezeMinutes' | 'endsAt'>): number | null {
  if (!c.freezeMinutes || c.freezeMinutes <= 0 || c.endsAt === null) return null
  return c.endsAt - c.freezeMinutes * 60_000
}

/**
 * The board is frozen now: the freeze has begun and the teacher has not
 * revealed THIS freeze.
 *
 * A reveal covers the freeze that had begun when it was pressed, not every
 * freeze to come: a contest reopened or given a later end has a new freeze
 * window, and the board freezes again when it comes (`unfrozenAt` before the
 * new `freezeAt`). Kept as a comparison rather than a reset on every door that
 * moves the end, so no door can forget it.
 */
export function boardFrozen(c: Pick<Contest, 'freezeMinutes' | 'endsAt' | 'unfrozenAt'>, now: number): boolean {
  const at = freezeAt(c)
  if (at === null || now < at) return false
  const revealed = c.unfrozenAt ?? null
  return revealed === null || revealed < at
}

/** The board was revealed after its freeze, and that freeze is still the current one. */
export function boardRevealed(c: Pick<Contest, 'freezeMinutes' | 'endsAt' | 'unfrozenAt'>): boolean {
  const at = freezeAt(c)
  return at !== null && (c.unfrozenAt ?? null) !== null && c.unfrozenAt! >= at
}

/* ------------------------------------------------------------------ problem */

export interface ContestProblem {
  id: string
  contestId: string
  /** 0-based order; the letter is worked out from it (problemLetter). */
  position: number
  title: string
  /** Markdown with $…$ formulas; examples are not written into it — they are tests marked as such. */
  statement: string
  /** CPU time per test, ms. */
  timeLimitMs: number
  memoryMb: number
  checker: CheckerKind
  /** `float`: the absolute or relative difference allowed. */
  checkerEpsilon: number
  /** `custom`: Python defining `check(input, output, answer)`. Never sent to participants. */
  checkerCode: string
  points: PointsMode
  /** The teacher's solution: judged like a submission; the contest opens only when it passes. */
  referenceLanguage: ContestLanguage
  referenceSource: string
  /** Bumps whenever the tests change: a verdict judged on an older revision is stale. */
  testsRevision: number
  createdAt: number
  updatedAt: number
}

/** The most problems a contest can have: one letter each, A to Z. */
export const MAX_PROBLEMS = 26

/** `A`, `B`, … `Z` — the problem's name in every table, by its place in the contest. */
export function problemLetter(position: number): string {
  if (!Number.isInteger(position) || position < 0 || position >= MAX_PROBLEMS) return '?'
  return String.fromCharCode(65 + position)
}

/** The position a letter in an address names (`/a/x/c` → 2); null — not a letter. */
export function letterPosition(letter: string): number | null {
  const value = String(letter ?? '').trim().toUpperCase()
  if (!/^[A-Z]$/.test(value)) return null
  return value.charCodeAt(0) - 65
}

export interface ContestTest {
  problemId: string
  /** 1-based; the order tests run in. */
  ordinal: number
  /** Shown under the statement and, when it fails, with the participant's own output. */
  sample: boolean
  /** IOI groups: the group this test belongs to (0 is conventionally the examples). */
  group: number
  inputBytes: number
  /** null — no answer yet: it is to be written by the reference solution. */
  answerBytes: number | null
  /** Where the answer came from: uploaded by the teacher or written by the reference. */
  answerFrom: 'upload' | 'reference'
}

export interface ContestGroup {
  group: number
  points: number
}

/** The full score of a problem under IOI rules. */
export const PROBLEM_POINTS = 100

/**
 * What each test is worth, by ordinal, under IOI rules — and what each group
 * is worth, the unit a test's points are actually given by.
 *
 * `tests`: every test that is not an example is a group of its own, and they
 * share the problem's points equally; the remainder of the division goes to
 * the LAST tests, the hard ones. If every test is an example, the examples
 * share them — a problem worth zero is not a problem. `groups`: the teacher's
 * table; a test in a group the table does not list is worth nothing.
 */
export function pointGroups(
  tests: readonly Pick<ContestTest, 'ordinal' | 'sample' | 'group'>[],
  mode: PointsMode,
  groups: readonly ContestGroup[],
): { group: number; points: number; tests: number[] }[] {
  const ordered = [...tests].sort((a, b) => a.ordinal - b.ordinal)
  if (mode === 'groups') {
    const byGroup = new Map<number, number[]>()
    for (const test of ordered) byGroup.set(test.group, [...(byGroup.get(test.group) ?? []), test.ordinal])
    return [...byGroup.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([group, members]) => ({ group, points: Math.max(0, Math.round(groups.find((g) => g.group === group)?.points ?? 0)), tests: members }))
  }
  const scored = ordered.filter((test) => !test.sample)
  const paid = scored.length > 0 ? scored : ordered
  const base = paid.length > 0 ? Math.floor(PROBLEM_POINTS / paid.length) : 0
  const remainder = paid.length > 0 ? PROBLEM_POINTS - base * paid.length : 0
  const paidIndex = new Map(paid.map((test, index) => [test.ordinal, index]))
  return ordered.map((test) => {
    const index = paidIndex.get(test.ordinal)
    const points = index === undefined ? 0 : base + (index >= paid.length - remainder ? 1 : 0)
    return { group: -test.ordinal, points, tests: [test.ordinal] }
  })
}

/** The most points a problem can give: what its groups add up to. */
export function problemMaxPoints(groups: readonly { points: number }[]): number {
  return groups.reduce((sum, group) => sum + group.points, 0)
}

/** Points for a set of test verdicts: a group pays only when every one of its tests is OK. */
export function pointsFor(
  groups: readonly { points: number; tests: number[] }[],
  verdicts: ReadonlyMap<number, TestVerdict>,
): number {
  let total = 0
  for (const group of groups) {
    if (group.tests.length > 0 && group.tests.every((ordinal) => verdicts.get(ordinal) === 'OK')) total += group.points
  }
  return total
}

/* ----------------------------------------------------------------- verdicts */

/**
 * The judge's word on a submission.
 *
 * OK — accepted. WA — wrong answer. TL — time limit (CPU, or the wall clock
 * when the program sleeps). ML — memory limit. RE — runtime error (a non-zero
 * exit or a signal). OL — the output was too large. CE — compilation error.
 * SE — the judge itself failed (the checker crashed, docker refused): the
 * teacher's trouble, never the participant's — it costs no attempt and the
 * panel offers a rejudge.
 */
export type Verdict = 'OK' | 'WA' | 'TL' | 'ML' | 'RE' | 'OL' | 'CE' | 'SE'

export const VERDICTS: readonly Verdict[] = ['OK', 'WA', 'TL', 'ML', 'RE', 'OL', 'CE', 'SE']

/** A test's outcome in a report: a verdict, or `skipped` — not run (ICPC stopped, an IOI group failed). */
export type TestVerdict = Exclude<Verdict, 'CE'> | 'skipped'

/** Where a submission is in the judge. `failed` — the judge gave up (verdict SE). */
export type JudgeState = 'queued' | 'running' | 'done' | 'failed'

export function judged(state: JudgeState): boolean {
  return state === 'done' || state === 'failed'
}

/**
 * A rejected attempt — what costs penalty minutes under ICPC and spends the
 * per-problem limit. A compilation error does not (it never ran), and neither
 * does SE (the judge's fault).
 */
export function costsAttempt(verdict: Verdict | null): boolean {
  return verdict === 'WA' || verdict === 'TL' || verdict === 'ML' || verdict === 'RE' || verdict === 'OL'
}

/** Spends the per-problem limit: everything sent except a compilation error and the judge's own failure. */
export function spendsLimit(verdict: Verdict | null, state: JudgeState): boolean {
  if (!judged(state)) return true
  return verdict !== 'CE' && verdict !== 'SE'
}

export type VerdictTone = 'positive' | 'danger' | 'warning' | 'neutral' | 'accent'

/** The colour family of a verdict badge (Paper 19 · Контесты, K2): OK green, WA/RE red, TL/ML/OL amber, CE navy. */
export function verdictTone(verdict: Verdict | null, state: JudgeState = 'done'): VerdictTone {
  if (!judged(state)) return 'accent'
  if (verdict === 'OK') return 'positive'
  if (verdict === 'WA' || verdict === 'RE') return 'danger'
  if (verdict === 'TL' || verdict === 'ML' || verdict === 'OL') return 'warning'
  return 'neutral'
}

/** «Неправильный ответ», «Превышено время»… — the words beside the two-letter code. */
export function verdictWords(verdict: Verdict): string {
  return tr(`contests.verdict.${verdict}`)
}

/* --------------------------------------------------------------- submission */

export type SubmissionKind = 'entrant' | 'reference' | 'answers'

export interface ContestSubmission {
  id: string
  contestId: string
  problemId: string
  /** null for the teacher's own runs (reference, answers). */
  entrantId: string | null
  kind: SubmissionKind
  /** #1, #2… within the contest, for entrants; 0 for the teacher's runs. */
  number: number
  language: ContestLanguage
  sourceBytes: number
  submittedAt: number
  /** Upsolving: after the end, outside the standings. */
  late: boolean
  state: JudgeState
  verdict: Verdict | null
  /** The first test that failed; null — none (OK, CE, still running). */
  failedTest: number | null
  /** Tests that passed, of `total` run or to run. */
  passed: number | null
  total: number | null
  /** IOI points; null under ICPC and before the verdict. */
  score: number | null
  /** The largest CPU time and memory over the tests run. */
  timeMs: number | null
  memoryKb: number | null
  /** While running: tests finished so far. */
  progress: number | null
  judgedAt: number | null
  /** The problem's tests revision the verdict was given on. */
  testsRevision: number | null
}

/** One test in a report. Output and answer snippets travel only where the reader may see them. */
export interface TestReport {
  ordinal: number
  verdict: TestVerdict
  timeMs: number | null
  memoryKb: number | null
  sample: boolean
  /** The checker's note: «слово 3: ожидалось 5, получено 4». */
  note?: string
  /** Snippets (≤ SNIPPET_BYTES): to the participant for examples only, to staff always. */
  input?: string
  output?: string
  answer?: string
  /** Staff only: the exit code or signal, and what the program printed to stderr. */
  exit?: string
  stderr?: string
}

/** The cap on any snippet of a test's data that leaves the server. */
export const SNIPPET_BYTES = 4096

/** The cap on a compiler's log that is kept and shown. */
export const COMPILE_LOG_BYTES = 16384

/** The cap on a source: a page of code, not a dataset in a string. */
export const SOURCE_BYTES = 65536

/* ---------------------------------------------------------------- standings */

/** A judged or pending attempt, as the standings read it. Upsolving and teacher runs never get here. */
export interface StandingAttempt {
  entrantId: string
  problemId: string
  submittedAt: number
  state: JudgeState
  verdict: Verdict | null
  score: number | null
}

export interface StandingEntrant {
  id: string
  name: string
  joinedAt: number
}

export interface StandingCell {
  /** ICPC: accepted; IOI: the full score. */
  solved: boolean
  /** Rejected attempts counted (before the accepted one, or all of them while unsolved). */
  attempts: number
  /** Minutes from the start to the accepted submission; null — not solved (or no start). */
  minutes: number | null
  /** The first accepted solution of this problem in the contest. */
  first: boolean
  /** Sent and not judged yet (only what this viewer may know of). */
  pending: number
  /** Attempts after the freeze this viewer may not see the outcome of. */
  frozen: number
  /** IOI: the best points; null — nothing judged yet. */
  score: number | null
  /** Anything sent at all (judged, pending or frozen). */
  tried: boolean
}

export interface StandingRow {
  place: number
  entrantId: string
  name: string
  cells: StandingCell[]
  /** ICPC: problems solved; IOI: problems with the full score. */
  solved: number
  /** ICPC penalty minutes; 0 under IOI. */
  penalty: number
  /** IOI: the sum of the best scores; ICPC: equals `solved`. */
  score: number
  /** The submission that last improved the row: the tie-breaker, earlier is higher. */
  improvedAt: number | null
}

export interface StandingProblemTotals {
  /** People who solved it (as this viewer sees). */
  solved: number
  /** People who tried it. */
  tried: number
  /** Attempts sent (judged and pending), as this viewer sees. */
  attempts: number
}

export interface StandingsInput {
  rules: ContestRules
  startsAt: number | null
  penaltyMinutes: number
  /** When the freeze began, if the board is frozen for this viewer now; null — open. */
  frozenFrom: number | null
  problems: readonly { id: string; maxScore: number }[]
  entrants: readonly StandingEntrant[]
  attempts: readonly StandingAttempt[]
  /** Who is looking: their own row is never frozen. Staff looking at the class view pass null. */
  viewerId: string | null
  /** Staff view: nothing is frozen. */
  seeAll: boolean
}

export interface StandingsResult {
  rows: StandingRow[]
  totals: StandingProblemTotals[]
}

const EMPTY_CELL: StandingCell = {
  solved: false,
  attempts: 0,
  minutes: null,
  first: false,
  pending: 0,
  frozen: 0,
  score: null,
  tried: false,
}

/**
 * The standings — every row, every cell, and the places.
 *
 * PLACES ARE DISTINCT, one per row, even on equal results: the owner's rule
 * for every board in Colloq («места на доске разные», 30.09.2026). Under ICPC
 * the order is problems solved, then penalty, then the earlier last accepted
 * submission; under IOI the sum, then the moment it was reached. Whoever is
 * still level — two people with nothing solved — goes by their first
 * submission, then by when they joined, then by name, so the order never
 * depends on the database's mood.
 *
 * THE FREEZE is applied per viewer. An attempt sent at or after `frozenFrom`
 * by anyone but the viewer counts neither for nor against: the cell shows how
 * many such attempts there were, and nothing of their verdicts. A cell solved
 * before the freeze stays solved — later attempts at a solved problem never
 * mattered. The ranking itself uses only what the viewer sees, so the frozen
 * board is a board, not a puzzle with holes.
 */
export function computeStandings(input: StandingsInput): StandingsResult {
  const problemIndex = new Map(input.problems.map((problem, index) => [problem.id, index]))
  const firstOk = new Map<string, number>()
  const perEntrant = new Map<string, StandingAttempt[]>()
  for (const attempt of input.attempts) {
    if (!problemIndex.has(attempt.problemId)) continue
    const list = perEntrant.get(attempt.entrantId)
    if (list) list.push(attempt)
    else perEntrant.set(attempt.entrantId, [attempt])
  }
  const hidden = (attempt: StandingAttempt): boolean =>
    !input.seeAll && input.frozenFrom !== null && attempt.submittedAt >= input.frozenFrom && attempt.entrantId !== input.viewerId
  // «First to solve» is known only of what the viewer may see: an accepted
  // submission behind the freeze would otherwise announce itself by its colour.
  for (const attempt of input.attempts) {
    if (attempt.state !== 'done' || hidden(attempt)) continue
    const solvedNow = input.rules === 'icpc'
      ? attempt.verdict === 'OK'
      : attempt.score !== null && attempt.score >= (input.problems[problemIndex.get(attempt.problemId) ?? -1]?.maxScore ?? Infinity)
    if (!solvedNow) continue
    const before = firstOk.get(attempt.problemId)
    if (before === undefined || attempt.submittedAt < before) firstOk.set(attempt.problemId, attempt.submittedAt)
  }

  const rows: StandingRow[] = input.entrants.map((entrant) => {
    const cells = input.problems.map(() => ({ ...EMPTY_CELL }))
    const own = [...(perEntrant.get(entrant.id) ?? [])].sort((a, b) => a.submittedAt - b.submittedAt)
    const solvedAt: (number | null)[] = input.problems.map(() => null)
    const bestAt: (number | null)[] = input.problems.map(() => null)
    for (const attempt of own) {
      const index = problemIndex.get(attempt.problemId)!
      const cell = cells[index]
      cell.tried = true
      if (input.rules === 'icpc' && cell.solved) continue
      if (hidden(attempt)) {
        cell.frozen++
        continue
      }
      if (!judged(attempt.state)) {
        cell.pending++
        continue
      }
      if (input.rules === 'icpc') {
        if (attempt.verdict === 'OK') {
          cell.solved = true
          solvedAt[index] = attempt.submittedAt
          cell.minutes = input.startsAt === null ? null : Math.max(0, Math.floor((attempt.submittedAt - input.startsAt) / 60_000))
          cell.first = firstOk.get(attempt.problemId) === attempt.submittedAt
        } else if (costsAttempt(attempt.verdict)) {
          cell.attempts++
        }
      } else {
        if (attempt.verdict === 'CE' || attempt.verdict === 'SE' || attempt.score === null) continue
        if (costsAttempt(attempt.verdict) || attempt.verdict === 'OK') cell.attempts++
        // The tie-breaker is the moment the SUM last grew: a first zero shows
        // in the cell (a red «0» is information) but reached nothing.
        if (attempt.score > (cell.score ?? 0)) bestAt[index] = attempt.submittedAt
        if (cell.score === null || attempt.score > cell.score) cell.score = attempt.score
        const max = input.problems[index].maxScore
        if (!cell.solved && max > 0 && attempt.score >= max) {
          cell.solved = true
          solvedAt[index] = attempt.submittedAt
          cell.minutes = input.startsAt === null ? null : Math.max(0, Math.floor((attempt.submittedAt - input.startsAt) / 60_000))
          cell.first = firstOk.get(attempt.problemId) === attempt.submittedAt
        }
      }
    }
    const solved = cells.filter((cell) => cell.solved).length
    let penalty = 0
    let score = solved
    let improvedAt: number | null = null
    if (input.rules === 'icpc') {
      for (const cell of cells) {
        if (cell.solved && cell.minutes !== null) penalty += cell.minutes + cell.attempts * input.penaltyMinutes
      }
      improvedAt = solvedAt.reduce<number | null>((latest, at) => (at === null ? latest : latest === null || at > latest ? at : latest), null)
    } else {
      score = cells.reduce((sum, cell) => sum + (cell.score ?? 0), 0)
      improvedAt = bestAt.reduce<number | null>((latest, at) => (at === null ? latest : latest === null || at > latest ? at : latest), null)
    }
    return { place: 0, entrantId: entrant.id, name: entrant.name, cells, solved, penalty, score, improvedAt }
  })

  const firstSent = new Map<string, number>()
  for (const [entrantId, list] of perEntrant) firstSent.set(entrantId, Math.min(...list.map((a) => a.submittedAt)))
  const joined = new Map(input.entrants.map((entrant) => [entrant.id, entrant.joinedAt]))
  const earlier = (a: number | null | undefined, b: number | null | undefined): number => {
    if (a === b) return 0
    if (a === null || a === undefined) return 1
    if (b === null || b === undefined) return -1
    return a - b
  }
  rows.sort((a, b) => {
    if (input.rules === 'icpc') {
      if (a.solved !== b.solved) return b.solved - a.solved
      if (a.penalty !== b.penalty) return a.penalty - b.penalty
    } else if (a.score !== b.score) {
      return b.score - a.score
    }
    return earlier(a.improvedAt, b.improvedAt)
      || earlier(firstSent.get(a.entrantId), firstSent.get(b.entrantId))
      || earlier(joined.get(a.entrantId), joined.get(b.entrantId))
      || a.name.localeCompare(b.name)
  })
  rows.forEach((row, index) => {
    row.place = index + 1
  })

  const totals: StandingProblemTotals[] = input.problems.map((_, index) => {
    let solved = 0
    let tried = 0
    let attempts = 0
    for (const row of rows) {
      const cell = row.cells[index]
      if (cell.solved) solved++
      if (cell.tried) tried++
      attempts += cell.attempts + cell.pending + cell.frozen + (cell.solved && input.rules === 'icpc' ? 1 : 0)
    }
    return { solved, tried, attempts }
  })
  return { rows, totals }
}

/* ------------------------------------------------------------- addresses */

/**
 * Names taken by things other than contests, in `/a/<slug>`: none yet, but the
 * list exists so that the day a tail like `/a/t/<key>` is needed, a contest of
 * that name does not already stand in its way.
 */
export const RESERVED_CONTEST_SLUGS: readonly string[] = ['t', 'new']

/** Bring a name to an address or refuse — the product's one letter rule (shared/publish.ts · slugOk). */
export function parseContestSlug(raw: string): string | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!slugOk(value) || RESERVED_CONTEST_SLUGS.includes(value)) return null
  return value
}

/** The participant's page of a contest. */
export function contestPath(slug: string): string {
  return `/a/${slug}`
}

/* ------------------------------------------------------------------ limits */

/** The bounds every form and every door keeps, one copy for both. */
export const CONTEST_LIMITS = {
  title: 120,
  blurb: 200,
  description: 20_000,
  statement: 50_000,
  problemTitle: 120,
  checkerCode: 20_000,
  timeLimitMs: { min: 100, max: 15_000, default: 1000 },
  /*
   * At least 32 MB: a test's memory is the program's peak, and a forked child
   * starts at the harness's own size (≈10 MB) — a 16 MB limit would leave a
   * Python solution no room before its first line.
   */
  memoryMb: { min: 32, max: 2048, default: 256 },
  penaltyMinutes: { min: 0, max: 120, default: 20 },
  freezeMinutes: { min: 0, max: 7 * 24 * 60, default: 0 },
  attemptsPerProblem: { min: 0, max: 1000, default: 0 },
  epsilon: { min: 0, max: 1, default: 1e-6 },
  /** Tests in one problem. */
  tests: 300,
  /** One test's input or answer. */
  testBytes: 64 * 1024 * 1024,
  /** All of a problem's tests together, inputs and answers. */
  problemTestBytes: 512 * 1024 * 1024,
  /** An uploaded archive of tests. */
  archiveBytes: 256 * 1024 * 1024,
  question: 2000,
  answer: 4000,
} as const

/** Judge slots: how many submissions are judged at once on this server. */
export const JUDGE_SLOTS = { min: 1, max: 32 } as const
