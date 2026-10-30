/**
 * Everything the contest pages compute and say — without a single DOM node.
 *
 * Here lives what has a right and a wrong answer while looking equally
 * plausible on screen either way: «+2» or «+3» in a cell, «0:44» or «44:00»
 * under it, «−2» painted red or amber, «тест 7» or «тест 8» on the rail, the
 * seconds of a run as «0,08» or «0.08», the window of «Рядом со мной». A
 * mistake in any of them is found by a student counting by hand, in class.
 *
 * The rules themselves are NOT here. Which verdict costs an attempt, what a
 * frozen cell may say, who is first, the phase, whether submissions are taken
 * — all of that is `shared/contests.ts`, the server's own copy, and the page
 * only puts its answers into words and colours. A second copy of a rule here
 * would agree with the server for exactly as long as nobody edits either.
 *
 * The words come from the `contests` catalog (shared/locales/contests.ts),
 * which travels inside the competitions one: the `/a` pages load the same
 * dictionary as `/k`, and so does the panel, which draws the same board.
 */
import { formatNumber, tr } from '@shared/i18n'
import type { BadgeForm, BadgeTone } from '@shared/competitions'
import {
  contestPhase,
  costsAttempt,
  judged,
  languageOfFile,
  verdictTone,
  verdictWords,
  type CheckerKind,
  type ContestLanguage,
  type ContestPhase,
  type ContestPublic,
  type ContestRules,
  type JudgeState,
  type StandingCell,
  type StandingProblemTotals,
  type StandingRow,
  type TestVerdict,
  type Verdict,
  type VerdictTone,
} from '@shared/contests'
import type {
  ContestQuestion,
  EntrantContestSubmission,
  LanguageOption,
  ProblemMine,
  SampleTest,
} from '@shared/contests-entrant'

const SECOND = 1000

/** U+2212: «−2» in a cell is a count of misses, and a hyphen would read as a dash beside a number. */
const MINUS = '−'

/* ------------------------------------------------------------------ clock */

/**
 * Where the page's countdown points: to the start while the contest is
 * «СКОРО», to the end while it runs; nothing once it is over (or has no end).
 *
 * `serverNow` is the server's clock as the page knows it — the laptop's clock
 * plus the offset the last answer measured (EntrantContestView · now). A
 * student's laptop five minutes fast must not see the problems «open» before
 * the door opens them, nor a countdown that reaches zero while sending is
 * still refused.
 */
export interface ContestCountdown {
  kind: 'start' | 'end'
  at: number
}

export function contestCountdown(
  contest: Pick<ContestPublic, 'state' | 'startsAt' | 'endsAt'>,
  serverNow: number,
): ContestCountdown | null {
  const phase = contestPhase(contest, serverNow)
  if (phase === 'soon' && contest.startsAt !== null) return { kind: 'start', at: contest.startsAt }
  if (phase === 'open' && contest.endsAt !== null) return { kind: 'end', at: contest.endsAt }
  return null
}

/* ----------------------------------------------------------------- header */

/** «ИДЁТ», «СКОРО», «ЗАВЕРШЕНО» in the competitions' badge (Badge.svelte): live is the accent, the rest are quiet. */
export function phaseBadge(phase: ContestPhase): { word: string; tone: BadgeTone; form: BadgeForm } {
  return {
    word: tr(`contests.phase.${phase}`),
    tone: phase === 'open' || phase === 'soon' ? 'accent' : 'neutral',
    form: phase === 'soon' || phase === 'draft' ? 'outline' : 'filled',
  }
}

/**
 * «Контест · правила ICPC · 6 задач · 34 участника · штраф 20 мин за попытку»
 * — the line over the title (K1). The count of problems is left out while
 * they are hidden (before the start the door sends none), rather than saying
 * «0 задач» about a contest that has six; the penalty only where it exists.
 */
export function contestMeta(input: {
  rules: ContestRules
  problems: number
  entrants: number
  penaltyMinutes: number
}): string {
  return [
    tr('contests.p.kind'),
    tr(`contests.rules.${input.rules}`),
    input.problems > 0 ? tr('contests.p.problemsCount', { count: input.problems }) : '',
    tr('contests.p.entrants', { count: input.entrants }),
    input.rules === 'icpc' && input.penaltyMinutes > 0
      ? tr('contests.p.penaltyLine', { minutes: input.penaltyMinutes })
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** «5 из 34» — a place, or «3 из 6» solved; a dash for what is not known yet. */
export function ofWords(value: number | null, total: number): string {
  if (value === null) return '—'
  return tr('contests.p.of', { value: formatNumber(value), total: formatNumber(total) })
}

/* ----------------------------------------------------------------- limits */

/** «1 с», «0,5 с», «2,5 с» — a problem's time limit, as the statement's line says it. */
export function limitTime(ms: number): string {
  return tr('contests.p.secondsUnit', { value: formatNumber(ms / SECOND, { maximumFractionDigits: 2 }) })
}

/** «256 МБ». */
export function limitMemory(mb: number): string {
  return tr('contests.p.mbUnit', { value: formatNumber(mb) })
}

/**
 * How the answer is checked, in the words of the limits line: «по словам»,
 * «по строкам», «числа ± 1e-6», «программой преподавателя». A small epsilon
 * in the notation statements use for it (`1e-6`: six zeros are counted
 * wrong more often than read), a coarse one as a plain number («0,01»).
 */
export function checkerWords(kind: CheckerKind, epsilon: number): string {
  if (kind !== 'float') return tr(`contests.p.checker.${kind}`)
  const value = epsilon > 0 && epsilon < 1e-3 ? epsilon.toExponential() : formatNumber(epsilon, { maximumFractionDigits: 6 })
  return tr('contests.p.checker.float', { epsilon: value })
}

/** The phone's one line of limits (K5): «1 с · 256 МБ · по словам». */
export function limitsLine(problem: { timeLimitMs: number; memoryMb: number; checker: CheckerKind; checkerEpsilon: number }): string {
  return [limitTime(problem.timeLimitMs), limitMemory(problem.memoryMb), checkerWords(problem.checker, problem.checkerEpsilon)].join(' · ')
}

/* ------------------------------------------------------------ measurements */

/**
 * «0,04» — a run's CPU time in seconds, two decimals, in the reader's
 * notation (a comma in Russian). Two, not three: the limit is set in tenths,
 * and a third digit is the noise of the machine.
 */
export function secondsValue(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  return formatNumber(ms / SECOND, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** «0,08 с». */
export function timeWords(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  return tr('contests.p.secondsUnit', { value: secondsValue(ms) })
}

/**
 * «12 МБ» — the peak memory of a run. Whole megabytes from ten up, one
 * decimal below (a C program lives in 1,6 МБ, and «2 МБ» would round it into
 * a different program), kilobytes under one megabyte.
 */
export function memoryWords(kb: number | null | undefined): string {
  if (kb === null || kb === undefined || !Number.isFinite(kb) || kb < 0) return '—'
  if (kb < 1024) return tr('contests.p.kbUnit', { value: formatNumber(Math.round(kb)) })
  const mb = kb / 1024
  const digits = mb < 10 ? 1 : 0
  return tr('contests.p.mbUnit', { value: formatNumber(mb, { minimumFractionDigits: 0, maximumFractionDigits: digits }) })
}

/**
 * «> 1 с» — the time of a run killed at the limit. The measured number of a
 * killed run is the moment it was stopped, not how long it would have taken,
 * and printing it as a time invites «so 1,02 s is enough?».
 */
export function overLimitWords(limitMs: number): string {
  return `> ${limitTime(limitMs)}`
}

/** «> 1,00» — the same in the table's seconds column (K2). */
export function overLimitValue(limitMs: number): string {
  return `> ${secondsValue(limitMs)}`
}

/** The usage beside a judged submission (K1): «0,08 с · 12 МБ», «> 1 с · 31 МБ»; '' when nothing was run. */
export function usageWords(
  submission: Pick<EntrantContestSubmission, 'verdict' | 'timeMs' | 'memoryKb'>,
  timeLimitMs: number | null,
): string {
  if (submission.timeMs === null && submission.memoryKb === null) return ''
  const time = submission.verdict === 'TL' && timeLimitMs !== null ? overLimitWords(timeLimitMs) : timeWords(submission.timeMs)
  return [time, memoryWords(submission.memoryKb)].join(' · ')
}

/* ------------------------------------------------------------ board cells */

/**
 * «0:44», «1:10», «12:05» — minutes from the start, as hours and minutes.
 * The ICPC board's own notation: a cell is too narrow for «44 мин», and
 * «1:10» reads as «an hour and ten» at a glance where «70» does not.
 */
export function boardMinutes(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * What one cell of the board looks like.
 *
 * `first` — the first accepted solution of the problem (a solid fill),
 * `solved` — accepted (a tint), `failed` — tried and not solved, `frozen` —
 * behind the freeze, `pending` — being judged, `empty` — nothing to say.
 * `busy` marks a cell that keeps its face while a new attempt is judged (an
 * IOI score being improved). `bar` is the IOI share of the full score, for
 * the line under the number. `label` is the same said in words, for a screen
 * reader: «+2 0:44» is a notation, not a sentence.
 */
export type CellTone = 'first' | 'solved' | 'failed' | 'frozen' | 'pending' | 'empty'

export interface CellFace {
  tone: CellTone
  main: string
  sub: string
  bar: number | null
  busy: boolean
  label: string
}

const EMPTY_FACE: CellFace = { tone: 'empty', main: '', sub: '', bar: null, busy: false, label: '' }

/** Every attempt the cell knows of: the misses, the ones being judged and the ones behind the freeze. */
function tries(cell: StandingCell): number {
  return cell.attempts + cell.pending + cell.frozen
}

/**
 * An ICPC cell (K3): «+» / «+2» over «0:44» when solved, «−3» when not,
 * «?» over «2 поп.» behind the freeze, «…» while being judged.
 *
 * The order is the board's, not the eye's: a solved cell stays solved
 * whatever came after it (later attempts at a solved problem never counted —
 * computeStandings skips them), and a frozen attempt outranks a pending one,
 * because the freeze is exactly what must not leak: a «…» in another
 * person's frozen cell would say «it is not judged yet», which is already
 * more than the freeze allows.
 *
 * `pendingTest` is the test the viewer's OWN submission is on, which only
 * the viewer's row may show (K3: «тест 7» under «ВЫ»).
 */
export function icpcCell(cell: StandingCell, pendingTest: number | null = null): CellFace {
  if (cell.solved) {
    const main = cell.attempts > 0 ? `+${cell.attempts}` : '+'
    const sub = cell.minutes === null ? '' : boardMinutes(cell.minutes)
    return {
      tone: cell.first ? 'first' : 'solved',
      main,
      sub,
      bar: null,
      busy: false,
      label: [
        tr('contests.p.cellSolved', { time: sub || '—', count: cell.attempts }),
        cell.first ? tr('contests.p.cellFirst') : '',
      ].filter(Boolean).join(', '),
    }
  }
  if (cell.frozen > 0) {
    return {
      tone: 'frozen',
      main: '?',
      sub: tr('contests.p.triesShort', { count: tries(cell) }),
      bar: null,
      busy: false,
      label: tr('contests.p.cellFrozen', { count: tries(cell) }),
    }
  }
  if (cell.pending > 0) {
    return {
      tone: 'pending',
      main: '…',
      sub: pendingTest !== null ? tr('contests.p.testN', { n: pendingTest }) : cell.attempts > 0 ? `${MINUS}${cell.attempts}` : '',
      bar: null,
      busy: true,
      label: tr('contests.p.cellPending'),
    }
  }
  if (cell.attempts > 0) {
    return {
      tone: 'failed',
      main: `${MINUS}${cell.attempts}`,
      sub: '',
      bar: null,
      busy: false,
      label: tr('contests.p.cellFailed', { count: cell.attempts }),
    }
  }
  return EMPTY_FACE
}

/**
 * An IOI cell (K4): the best score; the full score filled solid, a partial
 * one tinted with a line under it as long as the share, a zero in red.
 *
 * A score being improved keeps its number and gets the «busy» outline: the
 * points already earned stay earned whatever the new attempt does, and a «…»
 * in their place would read as «lost».
 */
export function ioiCell(cell: StandingCell, maxScore: number, pendingTest: number | null = null): CellFace {
  if (cell.frozen > 0) {
    return {
      tone: 'frozen',
      main: '?',
      sub: tr('contests.p.triesShort', { count: tries(cell) }),
      bar: null,
      busy: false,
      label: tr('contests.p.cellFrozen', { count: tries(cell) }),
    }
  }
  const busy = cell.pending > 0
  if (cell.score === null) {
    if (!busy) return EMPTY_FACE
    return {
      tone: 'pending',
      main: '…',
      sub: pendingTest !== null ? tr('contests.p.testN', { n: pendingTest }) : '',
      bar: null,
      busy: true,
      label: tr('contests.p.cellPending'),
    }
  }
  const full = cell.solved || (maxScore > 0 && cell.score >= maxScore)
  const share = maxScore > 0 ? Math.min(1, Math.max(0, cell.score / maxScore)) : 0
  return {
    tone: full ? 'first' : cell.score > 0 ? 'solved' : 'failed',
    main: formatNumber(cell.score),
    sub: busy && pendingTest !== null ? tr('contests.p.testN', { n: pendingTest }) : '',
    bar: full || cell.score <= 0 ? null : share,
    busy,
    label: tr('contests.p.cellPoints', { score: formatNumber(cell.score), max: formatNumber(maxScore) }),
  }
}

export function cellFace(
  rules: ContestRules,
  cell: StandingCell,
  maxScore: number,
  pendingTest: number | null = null,
): CellFace {
  return rules === 'icpc' ? icpcCell(cell, pendingTest) : ioiCell(cell, maxScore, pendingTest)
}

/** The totals row's numbers (K3): «31 / 40» — who solved it, and how many attempts were sent. */
export function totalsPair(totals: StandingProblemTotals | undefined): { solved: string; attempts: string } {
  if (!totals) return { solved: '0', attempts: '0' }
  return { solved: formatNumber(totals.solved), attempts: formatNumber(totals.attempts) }
}

/**
 * «Рядом со мной»: the viewer's row and up to `radius` rows on either side,
 * where the person's own race is — the three people just above to catch, the
 * three just below catching up. `from` is the index of the first row shown,
 * for the «1–4» note above them. All rows when the viewer is not on the board.
 */
export function nearRows(
  rows: readonly StandingRow[],
  me: string | null | undefined,
  radius = 3,
): { rows: StandingRow[]; from: number; found: boolean } {
  const index = me ? rows.findIndex((row) => row.entrantId === me) : -1
  if (index < 0) return { rows: [...rows], from: 0, found: false }
  const from = Math.max(0, index - radius)
  return { rows: rows.slice(from, index + radius + 1), from, found: true }
}

/**
 * «Первыми решили: A — Марфа Соколова, B — Даниил Орлов» — the projector's
 * footer (K6), read off the cells the server marked `first`. Only those the
 * board shows: a first solve behind the freeze is not marked there, and so
 * not named here.
 */
export function firstSolvers(
  rows: readonly StandingRow[],
  problems: readonly { letter: string }[],
): { letter: string; name: string }[] {
  const named: { letter: string; name: string }[] = []
  problems.forEach((problem, index) => {
    const row = rows.find((candidate) => candidate.cells[index]?.first)
    if (row) named.push({ letter: problem.letter, name: row.name })
  })
  return named
}

/* ------------------------------------------------------------------- rail */

/**
 * The rail's letter (K1): solved — a filled green box, tried — a red tint
 * with «−2», being judged — a dashed accent with «тест 7», untried — an
 * outline. IOI has a fifth: a partial score, tinted green with its number.
 */
export type RailTone = 'solved' | 'partial' | 'failed' | 'pending' | 'untried'

export interface RailFace {
  tone: RailTone
  mark: string
  label: string
}

/** The person's own submission of a problem that is being judged now, and the test it is on. */
export interface LiveRun {
  test: number | null
}

/**
 * Being judged, read off the person's own list rather than off the page: the
 * list follows every test of a run through the stream, the page's copy is a
 * snapshot from the last reload. The newest unjudged submission of the
 * problem wins.
 */
export function liveRun(submissions: readonly EntrantContestSubmission[], problemId: string): LiveRun | null {
  const running = submissions
    .filter((submission) => submission.problemId === problemId && !judged(submission.state))
    .sort((a, b) => b.number - a.number)[0]
  return running ? { test: currentTest(running) } : null
}

export function railFace(
  rules: ContestRules,
  maxScore: number,
  mine: ProblemMine | null,
  live: LiveRun | null,
): RailFace {
  const solved = mine?.solved === true
  const pending = !solved && (live !== null || mine?.pending === true)
  if (pending) {
    const test = live?.test ?? mine?.pendingTest ?? null
    return {
      tone: 'pending',
      mark: test !== null ? tr('contests.p.testN', { n: test }) : '…',
      label: tr('contests.p.railPending'),
    }
  }
  if (rules === 'ioi') {
    const score = mine?.score ?? null
    if (solved || (score !== null && maxScore > 0 && score >= maxScore)) {
      return { tone: 'solved', mark: formatNumber(score ?? maxScore), label: tr('contests.p.railSolved') }
    }
    if (score === null) return { tone: 'untried', mark: '', label: tr('contests.p.railUntried') }
    return {
      tone: score > 0 ? 'partial' : 'failed',
      mark: formatNumber(score),
      label: tr('contests.p.cellPoints', { score: formatNumber(score), max: formatNumber(maxScore) }),
    }
  }
  const attempts = mine?.attempts ?? 0
  if (solved) {
    return {
      tone: 'solved',
      mark: attempts > 0 ? `+${attempts}` : '+',
      label: tr('contests.p.railSolved'),
    }
  }
  if (attempts > 0) {
    return { tone: 'failed', mark: `${MINUS}${attempts}`, label: tr('contests.p.cellFailed', { count: attempts }) }
  }
  return { tone: 'untried', mark: '', label: tr('contests.p.railUntried') }
}

/* --------------------------------------------------------------- verdicts */

/** The two-letter code in the badge; «…» while the judge has not spoken. SE for a run the judge gave up on. */
export function verdictCode(submission: Pick<EntrantContestSubmission, 'state' | 'verdict'>): string {
  if (!judged(submission.state)) return '…'
  return submission.verdict ?? 'SE'
}

export function submissionTone(submission: Pick<EntrantContestSubmission, 'state' | 'verdict'>): VerdictTone {
  if (submission.state === 'failed' && submission.verdict === null) return 'neutral'
  return verdictTone(submission.verdict, submission.state)
}

/**
 * The badge's paint by its tone (K1, K2): accepted is the one solid badge
 * — the result a student scans the list for — the rejections are tints,
 * the judge's own failure and a compilation error are quiet navy, and the
 * running one is an outline in the live accent.
 */
export const BADGE_PAINT: Record<VerdictTone, string> = {
  positive: 'bg-positive text-white dark:text-canvas',
  danger: 'bg-danger/10 text-danger dark:bg-danger/20',
  warning: 'bg-warning/10 text-warning dark:bg-warning/20',
  neutral: 'bg-raised text-brand-2 dark:text-ink',
  accent: 'border border-accent text-accent-text',
}

/** The words beside the badge take its colour; accepted is bold besides. */
export const VERDICT_TEXT: Record<VerdictTone, string> = {
  positive: 'font-bold text-positive',
  danger: 'text-danger',
  warning: 'text-warning',
  neutral: 'text-brand-2 dark:text-ink',
  accent: 'text-accent-text',
}

/** The test a running submission is on now (1-based), or null when nothing says. */
export function currentTest(
  submission: Pick<EntrantContestSubmission, 'state' | 'progress' | 'total'>,
): number | null {
  if (submission.state !== 'running' || submission.progress === null) return null
  const next = submission.progress + 1
  return submission.total !== null ? Math.min(next, submission.total) : next
}

/**
 * The words of the verdict column (K2), without the test: «Неправильный
 * ответ», «Принято · 24 теста», «Ошибка компиляции · без штрафа»,
 * «Проверяется». An IOI result names its points instead of the tests.
 *
 * «без штрафа» is said where it is true by the shared rule (costsAttempt):
 * a compilation error and the judge's own failure cost nothing, and a
 * student who sees red needs to know that before deciding whether to send
 * again or to fix the code more carefully.
 */
export function verdictLine(
  submission: Pick<EntrantContestSubmission, 'state' | 'verdict' | 'total' | 'score' | 'late'>,
  rules: ContestRules,
): string {
  const words = verdictOnly(submission, rules)
  return submission.late ? `${words} · ${tr('contests.p.lateMark')}` : words
}

function verdictOnly(
  submission: Pick<EntrantContestSubmission, 'state' | 'verdict' | 'total' | 'score'>,
  rules: ContestRules,
): string {
  if (submission.state === 'queued') return tr('contests.p.queued')
  if (submission.state === 'running') return tr('contests.p.running')
  const verdict: Verdict = submission.verdict ?? 'SE'
  // A rejection that costs nothing by the shared rule (a compilation error, the judge's own failure).
  if (verdict !== 'OK' && !costsAttempt(verdict)) return `${verdictWords(verdict)} · ${tr('contests.p.noPenalty')}`
  if (rules === 'ioi' && submission.score !== null) {
    return `${verdictWords(verdict)} · ${tr('contests.p.points', { count: submission.score })}`
  }
  if (verdict === 'OK' && submission.total !== null) {
    return `${verdictWords(verdict)} · ${tr('contests.p.testsCount', { count: submission.total })}`
  }
  return verdictWords(verdict)
}

/**
 * The line beside a submission under the problem (K1): what the column says,
 * and the test, since there is no test column there — «Проверяется · тест 12
 * из 18», «Неправильный ответ · тест 4».
 */
export function submissionHead(
  submission: Pick<EntrantContestSubmission, 'state' | 'verdict' | 'total' | 'score' | 'late' | 'failedTest' | 'progress'>,
  rules: ContestRules,
): string {
  if (submission.state === 'running') {
    const test = currentTest(submission)
    if (test === null) return tr('contests.p.running')
    return submission.total !== null
      ? tr('contests.p.runningTestOf', { n: test, total: submission.total })
      : tr('contests.p.runningTest', { n: test })
  }
  const line = verdictLine(submission, rules)
  if (!judged(submission.state) || submission.failedTest === null || rules === 'ioi') return line
  const verdict = submission.verdict
  if (verdict === 'OK' || verdict === 'CE' || verdict === 'SE') return line
  return `${line} · ${tr('contests.p.testN', { n: submission.failedTest })}`
}

/** The phone's short line (K5): «тест 2 · пример», «тест 9 · > 1 с». */
export function phoneHead(
  submission: Pick<EntrantContestSubmission, 'state' | 'verdict' | 'total' | 'score' | 'late' | 'failedTest' | 'progress' | 'timeMs'>,
  rules: ContestRules,
  timeLimitMs: number | null,
  samples: readonly { ordinal: number }[],
): string {
  if (!judged(submission.state) || submission.failedTest === null || submission.verdict === 'OK') {
    return submissionHead(submission, rules)
  }
  const parts = [tr('contests.p.testN', { n: submission.failedTest })]
  if (samples.some((sample) => sample.ordinal === submission.failedTest)) parts.push(tr('contests.p.sampleWord'))
  else if (submission.verdict === 'TL' && timeLimitMs !== null) parts.push(overLimitWords(timeLimitMs))
  return parts.join(' · ')
}

/** The «ТЕСТ» column (K2): the failed test, the progress «7/22» while running, a dash otherwise. */
export function testColumn(
  submission: Pick<EntrantContestSubmission, 'state' | 'progress' | 'total' | 'failedTest'>,
): string {
  if (submission.state === 'running' && submission.progress !== null) {
    return submission.total !== null ? `${submission.progress}/${submission.total}` : String(submission.progress)
  }
  return submission.failedTest === null ? '—' : String(submission.failedTest)
}

/**
 * The strip of test squares under a row (K2): passed green, failed red,
 * skipped as an outline, the one running now in the accent, the ones not
 * reached yet as an outline too. `done` is a test a running submission has
 * finished but the strip has not reported a verdict for — finished, not yet
 * named.
 */
export type StripCell = 'ok' | 'fail' | 'skip' | 'current' | 'todo' | 'done'

export function stripCells(
  submission: Pick<EntrantContestSubmission, 'state' | 'progress' | 'total' | 'strip'>,
): StripCell[] {
  const strip = submission.strip ?? []
  const total = Math.max(submission.total ?? 0, strip.length)
  const running = !judged(submission.state)
  const done = submission.progress ?? 0
  const cells: StripCell[] = []
  for (let index = 0; index < total; index++) {
    const verdict: TestVerdict | undefined = strip[index]
    if (verdict !== undefined) cells.push(verdict === 'OK' ? 'ok' : verdict === 'skipped' ? 'skip' : 'fail')
    else if (!running) cells.push('skip')
    else if (submission.state === 'running' && index < done) cells.push('done')
    else if (submission.state === 'running' && index === done) cells.push('current')
    else cells.push('todo')
  }
  return cells
}

/**
 * The note beside a finished strip (K2): «1 из 18 пройден · дальше проверка
 * остановилась» — said when the judge stopped at a failure and the rest was
 * never run (ICPC), so that an empty tail does not read as «failed too».
 */
export function stripNote(
  submission: Pick<EntrantContestSubmission, 'state' | 'passed' | 'total' | 'strip' | 'verdict'>,
): string {
  if (!judged(submission.state) || submission.total === null || submission.passed === null) return ''
  if (submission.verdict === 'OK' || submission.verdict === 'CE') return ''
  const passed = tr('contests.p.passedOf', { count: submission.passed, total: submission.total })
  const stopped = (submission.strip ?? []).some((verdict) => verdict === 'skipped')
  return stopped ? `${passed} · ${tr('contests.p.stoppedAfter')}` : passed
}

/* -------------------------------------------------------------- languages */

/** The name of a language when the server has not said the version (an older answer, a missing option). */
export const LANGUAGE_NAME: Record<ContestLanguage, string> = {
  python3: 'Python 3',
  cpp20: 'C++20',
  c17: 'C17',
}

/** «Python 3.11», «C++20 · g++ 12» — the server's label for the contest's image, or the bare name. */
export function languageLabel(id: ContestLanguage, options: readonly LanguageOption[]): string {
  return options.find((option) => option.id === id)?.label ?? LANGUAGE_NAME[id]
}

/**
 * The language the editor opens a problem in: the one last used for it, then
 * the one last used in the contest, then the first the contest offers that
 * the image can run. Never one the contest does not take.
 */
export function pickLanguage(
  options: readonly LanguageOption[],
  wanted: readonly (string | null | undefined)[],
): ContestLanguage | null {
  for (const id of wanted) {
    const option = options.find((candidate) => candidate.id === id && candidate.available)
    if (option) return option.id
  }
  return options.find((option) => option.available)?.id ?? null
}

/** The compiler line over a compilation error (K2): «g++ -O2 -std=gnu++20» — what the judge ran. */
export const COMPILER_LINE: Record<ContestLanguage, string> = {
  python3: 'python3',
  cpp20: 'g++ -O2 -std=gnu++20',
  c17: 'gcc -O2 -std=gnu17',
}

/* ------------------------------------------------------------------ files */

/** What the file picker offers: the extensions `languageOfFile` reads (shared/contests.ts). */
export const SOURCE_ACCEPT = '.py,.cpp,.cc,.cxx,.c++,.c'

/** A source's size as the door counts it: UTF-8 bytes, not characters. */
export function sourceBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * A file dropped on the editor or picked: the language it is in, or why it
 * is not taken — not a source (`.txt`, `.h`), larger than a source may be,
 * or in a language the contest does not take or its image cannot run.
 */
export function fileChoice(
  file: { name: string; size: number },
  options: readonly LanguageOption[],
  limit: number,
): { language: ContestLanguage } | { refusal: string } {
  const language = languageOfFile(file.name)
  if (language === null) return { refusal: tr('contests.p.fileKind') }
  if (file.size > limit) return { refusal: tr('contests.p.fileTooBig', { size: formatNumber(Math.round(limit / 1024)) }) }
  const option = options.find((candidate) => candidate.id === language)
  if (!option) return { refusal: tr('contests.p.fileLanguage', { language: LANGUAGE_NAME[language] }) }
  if (!option.available) return { refusal: tr('contests.p.languageMissing', { language: option.label }) }
  return { language }
}

/* ----------------------------------------------------------------- drafts */

/**
 * Drafts live in this browser's storage, one per contest, problem and
 * language: switching C++ → Python and back must give back the C++, and a
 * page reloaded in the middle of a contest must not cost the solution typed
 * so far.
 *
 * By the contest's id, not its address: a teacher may rename the address in
 * the middle of the week, and the drafts must not be lost with the old one.
 * Not by person: a stranger types before joining, and joining must not take
 * the draft away.
 */
const DRAFTS = 'colloq.contest.v1'

export function draftKey(contestId: string, problemId: string, language: ContestLanguage): string {
  return `${DRAFTS}:${contestId}:${problemId}:${language}`
}

/** The language last used for a problem; without a problem — the last one used in the contest. */
export function languageKey(contestId: string, problemId: string | null = null): string {
  return problemId === null ? `${DRAFTS}:${contestId}:language` : `${DRAFTS}:${contestId}:${problemId}:language`
}

/**
 * Storage that may not be there: a private window throws on access, a full
 * one throws on write, and neither may cost the person the page. A failed
 * read is «no draft»; a failed write says so, and the page stops promising
 * «черновик сохранён».
 */
export function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeStored(key: string, value: string): boolean {
  try {
    const storage = globalThis.localStorage
    if (!storage) return false
    if (value) storage.setItem(key, value)
    else storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- samples */

/**
 * The note under the examples. «Примеры — первые тесты проверки» is a promise
 * — that a solution failing an example fails on test 1 or 2, and shows its
 * output there — and it is made only when it is true: when the examples are
 * tests 1, 2, … in a row. Otherwise the note says only that the examples are
 * among the tests.
 */
export function samplesNote(samples: readonly Pick<SampleTest, 'ordinal'>[]): string {
  const ordinals = samples.map((sample) => sample.ordinal).sort((a, b) => a - b)
  const leading = ordinals.every((ordinal, index) => ordinal === index + 1)
  return tr(leading ? 'contests.p.samplesFirst' : 'contests.p.samplesAmong')
}

/* ------------------------------------------------------------ compile log */

export interface LogPiece {
  text: string
  kind: 'error' | 'warning' | 'note' | null
}

/**
 * One line of a compiler's log in pieces, the gcc words coloured (K2):
 * `error:` red, `note:` in the accent, `warning:` amber. The rest is text,
 * and it is drawn as text — never as markup: a log is the program's words.
 */
export function logPieces(line: string): LogPiece[] {
  const match = /\b(fatal error|error|warning|note):/.exec(line)
  if (!match) return [{ text: line, kind: null }]
  const word = match[1]
  const kind: LogPiece['kind'] = word === 'note' ? 'note' : word === 'warning' ? 'warning' : 'error'
  const pieces: LogPiece[] = [
    { text: line.slice(0, match.index), kind: null },
    { text: `${word}:`, kind },
    { text: line.slice(match.index + word.length + 1), kind: null },
  ]
  return pieces.filter((piece) => piece.text !== '')
}

/**
 * The line of the first error in a log, for «открыть код на строке 14»:
 * gcc's `solution.cpp:14:5: error:` or Python's `File "solution.py", line 3`.
 */
export function firstErrorLine(log: string): number | null {
  const gcc = /^[^\n:]*solution\.\w+:(\d+):(?:\d+:)? (?:fatal )?error:/m.exec(log)
  if (gcc) return Number(gcc[1])
  const python = /File "[^"\n]*", line (\d+)/.exec(log)
  return python ? Number(python[1]) : null
}

/* -------------------------------------------------------------- questions */

/**
 * The questions tab's order: newest first by the moment something happened
 * to the entry — an answer that arrives today moves yesterday's question up,
 * where the person looks for it.
 */
export function questionsOrder(questions: readonly ContestQuestion[]): ContestQuestion[] {
  const moment = (question: ContestQuestion): number => Math.max(question.askedAt, question.answeredAt ?? 0)
  return [...questions].sort((a, b) => moment(b) - moment(a))
}

/* --------------------------------------------------------------- shortcut */

/** «⌘ ↵» on a Mac, «Ctrl ↵» elsewhere: the hint names the key the person actually has. */
export function sendShortcut(platform: string): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘ ↵' : 'Ctrl ↵'
}

/* ------------------------------------------------------------------ misc */

/** Judged in the given state: re-exported so components reach the rule through this module. */
export { judged }

/** «Задача C: Острова» — the accessible name of a rail letter or a problem cell. */
export function problemName(letter: string, title: string): string {
  return tr('contests.p.problemName', { letter, title })
}

/** Whether a submission is still with the judge: the page keeps its clock ticking and its stream busy for it. */
export function inFlight(submission: { state: JudgeState }): boolean {
  return !judged(submission.state)
}
