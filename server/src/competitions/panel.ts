/**
 * Decisions the competitions panel makes by numbers rather than by request.
 *
 * Pure functions: no database, no disk, no express. Everything that has a
 * right and a wrong answer is moved here — readiness to open, the queue wait
 * estimate, the summary without the baseline solution — because checking them
 * over HTTP means also checking the cookie, routing and JSON, and they will
 * fail silently and by a single number.
 *
 * There are no words here: a refusal is named by its reason (`OpenRefusal`),
 * and the sentence for it is picked by whoever answers — in Russian or in
 * English, depending on whose instance it is.
 */
import { ENVIRONMENT_NAME } from '@shared/admin'
import {
  isTerminal,
  LIMITS,
  parseSlug,
  slugRefusal,
  type CompetitionLimits,
  type MetricDirection,
  type PrivateRelease,
  type ScoringRule,
  type SlugRefusal,
  type SubmissionState,
} from '@shared/competitions'
import type { CompetitionCounts, CompetitionInput, OpenRefusal } from '@shared/competitions-api'

/** Everything that decides "may it be opened". */
export interface Readiness {
  openFiles: number
  hiddenFiles: number
  metricCode: string
  /** Whether the sample notebook is on disk. */
  baseline: boolean
  /** How its last run ended; null means it has not been checked. */
  baselineState: SubmissionState | null
  privateRelease: 'auto' | 'manual'
  deadlineAt: number | null
}

/**
 * Why the competition cannot be opened yet; `null` means it can.
 *
 * The order of checks is the order of sections in the editor (data, answers,
 * metric, sample notebook, dates): a person fixes what is named first, and
 * should go down the form from top to bottom rather than jump around it after
 * each next refusal.
 *
 * The main thing here is the second-to-last line. "The sample notebook is
 * uploaded" and "the sample notebook went all the way to a number" are
 * different things, and the competition may be opened only on the second: a
 * task that not even its author can solve means a hundred people searching in
 * vain for a mistake in their own work.
 */
export function openRefusal(r: Readiness): OpenRefusal | null {
  if (r.openFiles === 0) return 'noData'
  if (r.hiddenFiles === 0) return 'noSolution'
  if (r.metricCode.trim().length === 0) return 'noMetric'
  if (!r.baseline) return 'noBaseline'
  if (r.baselineState !== 'scored') return 'baselineNotChecked'
  // The private leaderboard is opened by the deadline — without a date there
  // is nothing to open it, and the competition will have no final result.
  if (r.privateRelease === 'auto' && r.deadlineAt === null) return 'noDeadline'
  return null
}

/**
 * Whether this submission's metric can be recomputed without running the
 * notebook again.
 *
 * Rescoring reads the `submission.csv` taken by the previous run — so anything
 * that got that far will do: a successful submission, one rejected by the
 * metric (after the code is fixed the same answer may turn out to be
 * accepted), and one that failed in the metric itself. A notebook that
 * crashed or was killed for time or memory left no answer, and "rescore"
 * would mean executing it again — a different action at a different price.
 */
export function rescorable(state: SubmissionState): boolean {
  return state === 'scored' || state === 'rejected' || state === 'metricFailed'
}

/* ---------------------------------------------------------- wait estimates */

export interface QueueTiming {
  /** How much time each running run has left, ms. */
  runningLeftMs: readonly number[]
  /** Average submission duration; null means there is nothing to measure by. */
  averageMs: number | null
  slots: number
}

/**
 * "≈ 3 min" for each waiting submission, in queue order.
 *
 * Computed by assigning to free slots, not by multiplying the position by the
 * average: with two executors the fifth in the queue waits half as long, and a
 * number computed without this lies by exactly a factor of two — upward, at
 * that, so the person leaves the screen thinking they have time to go for a
 * coffee.
 *
 * `null` when there is no average yet: the first submission of a competition
 * waits who knows how long, and "≈ 0 min" would be a promise, not an estimate.
 */
export function waitEtas(count: number, timing: QueueTiming): (number | null)[] {
  if (count <= 0) return []
  if (timing.averageMs === null) return Array.from({ length: count }, () => null)
  const slots = Math.max(1, timing.slots)
  const free: number[] = []
  for (let i = 0; i < slots; i++) free.push(Math.max(0, timing.runningLeftMs[i] ?? 0))
  const out: (number | null)[] = []
  for (let i = 0; i < count; i++) {
    free.sort((a, b) => a - b)
    const at = free[0]
    out.push(at)
    free[0] = at + timing.averageMs
  }
  return out
}

/* ------------------------------------------------------------ summaries */

/** What is known about a submission for the day's count and the average duration. */
export interface DoneEntry {
  acceptedAt: number
  state: SubmissionState
  durationMs: number | null
}

/**
 * "37 executed today, 2 min 40 s on average".
 *
 * The day that counts is the day the submission was ACCEPTED, not the day its
 * run ended: a submission has no end time, it has a duration, and
 * reconstructing the moment from it would mean adding the unknown wait in the
 * queue to the acceptance time as well. The two days differ only for a
 * submission accepted before midnight and finished after — one row a day, and
 * it is not worth a made-up time.
 */
export function executedToday(
  entries: readonly DoneEntry[],
  since: number,
  now: number,
): { done: number; averageMs: number | null } {
  const today = entries.filter(
    (entry) => entry.acceptedAt >= since && entry.acceptedAt <= now && isTerminal(entry.state),
  )
  const spans = today
    .map((entry) => entry.durationMs)
    .filter((ms): ms is number => typeof ms === 'number' && ms > 0)
  return {
    done: today.length,
    averageMs: spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null,
  }
}

/** The median — "Median run time 2 min 40 s" in the A3 summary. */
export function medianOf(values: readonly number[]): number | null {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/**
 * The summary without the baseline solution.
 *
 * The sample notebook is recorded as an ordinary submission of an ordinary
 * (service) participant — otherwise there would be no point in executing it
 * along the same path submissions are executed on, and "checked" would prove
 * nothing. But it must not be in the "PARTICIPANTS 28" line or in the
 * "SUBMISSIONS 143" summary: these are numbers about the class, and an extra
 * one in them is exactly the kind of trifle that makes people stop trusting
 * the whole screen.
 */
export function withoutBaseline(
  counts: CompetitionCounts,
  baselineRows: readonly { state: SubmissionState }[],
  bestPublic: number | null,
): CompetitionCounts {
  const of = (state: SubmissionState) => baselineRows.filter((row) => row.state === state).length
  return {
    submissions: Math.max(0, counts.submissions - baselineRows.length),
    scored: Math.max(0, counts.scored - of('scored')),
    notebookFailed: Math.max(0, counts.notebookFailed - of('notebookFailed')),
    rejected: Math.max(0, counts.rejected - of('rejected')),
    timedOut: Math.max(0, counts.timedOut - of('timedOut')),
    outOfMemory: Math.max(0, counts.outOfMemory - of('outOfMemory')),
    metricFailed: Math.max(0, counts.metricFailed - of('metricFailed')),
    cancelled: Math.max(0, counts.cancelled - of('cancelled')),
    entrants: Math.max(0, counts.entrants - (baselineRows.length > 0 ? 1 : 0)),
    bestPublic,
  }
}

/* ------------------------------------------------------- parsing form A2 */

/*
 * What the editor form sent lives in `@shared/competitions-api`: it is the
 * shape of the wire, and a second copy of it here would diverge from the
 * client on the very first new field.
 */
export type { CompetitionInput }

/** A form refusal names the FIELD: the person must know what to highlight. */
export type InputRefusal =
  | { field: 'slug'; why: SlugRefusal }
  | { field: 'title'; why: 'empty' }
  | { field: 'environment'; why: 'chars' }
  | { field: string; why: 'range'; min: number; max: number }
  | { field: string; why: 'value' }

const CHOICES = {
  direction: ['lower', 'higher'],
  privateRelease: ['auto', 'manual'],
  scoring: ['chosen', 'bestPublic', 'last'],
} as const

/**
 * Read the request body as an edit of a competition.
 *
 * Pure, and not out of love for purity: the field bounds are the only thing
 * standing between the form and the database. A field checked only on screen
 * is a field without a limit, and "public part 0 %" or "memory 64 MB" break
 * not on saving but a week later, on someone else's submission, and look like
 * the participant's mistake.
 *
 * The fields that arrive are only those the form named: the A2 editor and the
 * "Settings" tab in A3 show DIFFERENT pieces of a competition, and "save
 * everything" would mean the tab overwrites fields it never showed.
 */
export function parseCompetitionInput(
  body: unknown,
  opts: { creating: boolean } = { creating: false },
): { input: CompetitionInput } | { refusal: InputRefusal } {
  const raw = (body ?? {}) as Record<string, unknown>
  const input: CompetitionInput = {}
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key)

  if (has('slug') || opts.creating) {
    const slug = parseSlug(String(raw.slug ?? ''))
    if (!slug) return { refusal: { field: 'slug', why: slugRefusal(String(raw.slug ?? '')) ?? 'chars' } }
    input.slug = slug
  }
  if (has('title') || opts.creating) {
    const title = String(raw.title ?? '').trim()
    if (!title) return { refusal: { field: 'title', why: 'empty' } }
    input.title = title
  }
  if (has('blurb')) input.blurb = String(raw.blurb ?? '').trim()
  // The description is not trimmed at the edges: a space at the end of a
  // Markdown line is a line break, not garbage.
  if (has('description')) input.description = String(raw.description ?? '')

  if (has('metric')) {
    const metric = (raw.metric ?? {}) as Record<string, unknown>
    const out: { name?: string; direction?: MetricDirection; code?: string } = {}
    if (Object.prototype.hasOwnProperty.call(metric, 'name')) out.name = String(metric.name ?? '').trim()
    if (Object.prototype.hasOwnProperty.call(metric, 'code')) out.code = String(metric.code ?? '')
    if (Object.prototype.hasOwnProperty.call(metric, 'direction')) {
      const direction = String(metric.direction ?? '')
      if (!CHOICES.direction.includes(direction as MetricDirection)) {
        return { refusal: { field: 'metric.direction', why: 'value' } }
      }
      out.direction = direction as MetricDirection
    }
    input.metric = out
  }

  if (has('publicPercent')) {
    const range = LIMITS.publicPercent
    const value = number(raw.publicPercent)
    if (value === null || value < range.min || value > range.max) {
      return { refusal: { field: 'publicPercent', why: 'range', min: range.min, max: range.max } }
    }
    input.publicPercent = value
  }

  if (has('limits')) {
    const limits = (raw.limits ?? {}) as Record<string, unknown>
    const out: Partial<CompetitionLimits> = {}
    for (const name of ['wallSeconds', 'memoryMb', 'cpus', 'perDay'] as const) {
      if (!Object.prototype.hasOwnProperty.call(limits, name)) continue
      const range = LIMITS[name]
      const value = number(limits[name])
      if (value === null || value < range.min || value > range.max) {
        return { refusal: { field: `limits.${name}`, why: 'range', min: range.min, max: range.max } }
      }
      out[name] = value
    }
    input.limits = out
  }

  if (has('environment')) {
    const environment = String(raw.environment ?? '').trim()
    if (!ENVIRONMENT_NAME.test(environment)) {
      return { refusal: { field: 'environment', why: 'chars' } }
    }
    input.environment = environment
  }

  for (const name of ['startsAt', 'deadlineAt'] as const) {
    if (!has(name)) continue
    if (raw[name] === null) {
      input[name] = null
      continue
    }
    const at = number(raw[name])
    if (at === null) return { refusal: { field: name, why: 'value' } }
    input[name] = at
  }

  for (const name of ['privateRelease', 'scoring'] as const) {
    if (!has(name)) continue
    const value = String(raw[name] ?? '')
    if (!(CHOICES[name] as readonly string[]).includes(value)) {
      return { refusal: { field: name, why: 'value' } }
    }
    input[name] = value as PrivateRelease & ScoringRule
  }

  return { input }
}

/**
 * An integer from the request body; `null` means it is not a number
 * (including `"5"` with garbage).
 */
function number(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

/* ----------------------------------------------------------- queue order */

/** A queue row in the form in which it is sorted. */
export interface QueueOrderRow {
  submissionId: string
  entrantId: string
  turn: number
  enqueuedAt: number
}

/**
 * The waiting ones — in the order in which they will be taken.
 *
 * THIS IS A COPY OF THE ORDER FROM `store.ts` · `selectNext`, and it cannot be
 * any other: SQL takes the work (two processes must see one answer), while
 * the screen numbers the rows. If they diverge, nothing crashes — the screen
 * simply lies: a person reads "you are second", while the executor takes the
 * third, and nothing can explain it. The rule is one: whoever already has
 * something running lets the others go ahead; one's own k-th submission gets
 * in line behind everyone else's (k−1)-th; on a tie, whoever sent it first.
 */
export function fairOrder<T extends QueueOrderRow>(
  waiting: readonly T[],
  busyEntrants: ReadonlySet<string>,
): T[] {
  return [...waiting].sort((a, b) => {
    const busy = Number(busyEntrants.has(a.entrantId)) - Number(busyEntrants.has(b.entrantId))
    if (busy !== 0) return busy
    if (a.turn !== b.turn) return a.turn - b.turn
    if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt
    return a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0
  })
}

/** Delayed resource retries remain visible, but cannot claim a queue slot yet. */
export function waitingEligibilityOrder<T extends QueueOrderRow & {notBefore:number}>(
  waiting:readonly T[],busyEntrants:ReadonlySet<string>,now=Date.now(),
):{eligible:T[];deferred:T[]} {
  return {
    eligible:fairOrder(waiting.filter(row=>row.notBefore<=now),busyEntrants),
    deferred:fairOrder(waiting.filter(row=>row.notBefore>now),busyEntrants),
  }
}
