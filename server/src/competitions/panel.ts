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
  BOARD_VISIBILITIES,
  isTerminal,
  LIMITS,
  OUTPUT_POLICIES,
  parseSlug,
  slugRefusal,
  type BoardVisibility,
  type CompetitionLimits,
  type MetricDirection,
  type OutputPolicy,
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

/**
 * A running job is never expected to free its slot sooner than this: "any
 * second now" about a job that has already overrun its median is a promise,
 * not an estimate.
 */
export const MIN_REMAINING_MS = 5_000

export interface EtaInput {
  /** How many submissions run at once. */
  slots: number
  /** Jobs running now: how long each is expected to take and how long it has run. */
  running: readonly { expectedMs: number; elapsedMs: number }[]
  /** Waiting jobs in the order the runner will take them, each with its expected run time. */
  waiting: readonly { expectedMs: number }[]
}

export interface Eta {
  /** When the job is expected to start, ms from now. */
  startMs: number
  /** When its result is expected, ms from now: the start plus its own run time. */
  etaMs: number
}

/**
 * "≈ 3 min" for each waiting submission, in queue order — until its RESULT,
 * not until its start: the person waits for a number, not for a container.
 *
 * Computed by simulating the slots, not by multiplying the position by the
 * average: a min-heap of the moments slots free up (a running job frees one
 * after what it still has left, never sooner than five seconds; an idle slot
 * is free now), and the waiting jobs take them in queue order. With two
 * executors the fifth in the queue waits half as long, and a number computed
 * without this lies by exactly that factor.
 *
 * More running jobs than slots (the owner lowered the number mid-class): the
 * first of them to finish free nothing for the queue — only the last `slots`
 * of them do.
 */
export function queueEtas(input: EtaInput): Eta[] {
  const slots = Math.max(1, Math.floor(input.slots))
  const left = input.running
    .map((job) => Math.max(job.expectedMs - job.elapsedMs, MIN_REMAINING_MS))
    .sort((a, b) => a - b)
  const free = new MinHeap(left.slice(Math.max(0, left.length - slots)))
  while (free.size < slots) free.push(0)
  return input.waiting.map((job) => {
    const startMs = free.pop()
    const etaMs = startMs + Math.max(0, job.expectedMs)
    free.push(etaMs)
    return { startMs, etaMs }
  })
}

/**
 * How long one run of a competition is expected to take.
 *
 * The competition's own recent median once it has three runs: a neighbouring
 * competition may train boosting for ten minutes, and its number under a
 * simple task makes a person leave the screen. Fewer than three — the
 * instance's recent median, the best guess about this machine. Nothing has
 * run at all — half the time limit: honest about not knowing, and never
 * "≈ 0 min".
 */
export function expectedRunMs(input: {
  recent: readonly number[]
  instance: readonly number[]
  wallSeconds: number
}): number {
  if (input.recent.length >= 3) return medianOf(input.recent) ?? 0
  return medianOf(input.instance) ?? Math.round((input.wallSeconds * 1000) / 2)
}

/** The smallest number first — the moments slots free up. A few dozen entries at most. */
class MinHeap {
  private readonly items: number[] = []

  constructor(values: readonly number[] = []) {
    for (const value of values) this.push(value)
  }

  get size(): number {
    return this.items.length
  }

  push(value: number): void {
    const items = this.items
    items.push(value)
    let at = items.length - 1
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (items[parent] <= items[at]) break
      ;[items[parent], items[at]] = [items[at], items[parent]]
      at = parent
    }
  }

  pop(): number {
    const items = this.items
    const top = items[0]
    const last = items.pop()!
    if (items.length > 0) {
      items[0] = last
      let at = 0
      for (;;) {
        const left = at * 2 + 1
        const right = left + 1
        let least = at
        if (left < items.length && items[left] < items[least]) least = left
        if (right < items.length && items[right] < items[least]) least = right
        if (least === at) break
        ;[items[least], items[at]] = [items[at], items[least]]
        at = least
      }
    }
    return top
  }
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
    // The sample notebook is never late: its runs are not uploads.
    ...(counts.late === undefined ? {} : { late: counts.late }),
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
  boardVisibility: BOARD_VISIBILITIES,
  outputPolicy: OUTPUT_POLICIES,
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

  if (has('boardVisibility')) {
    const value = String(raw.boardVisibility ?? '')
    if (!(CHOICES.boardVisibility as readonly string[]).includes(value)) {
      return { refusal: { field: 'boardVisibility', why: 'value' } }
    }
    input.boardVisibility = value as BoardVisibility
  }

  // A switch is true or false, not "anything truthy": "false" as a string is
  // the form that would turn late intake ON by accident.
  if (has('lateSubmissions')) {
    if (typeof raw.lateSubmissions !== 'boolean') return { refusal: { field: 'lateSubmissions', why: 'value' } }
    input.lateSubmissions = raw.lateSubmissions
  }

  if (has('outputPolicy')) {
    const value = String(raw.outputPolicy ?? '')
    if (!(CHOICES.outputPolicy as readonly string[]).includes(value)) {
      return { refusal: { field: 'outputPolicy', why: 'value' } }
    }
    input.outputPolicy = value as OutputPolicy
  }

  /*
   * «Курс»: an id or null, and only the shape is checked here. Whether the
   * course exists and is the caller's is a question about the person, which
   * this parser does not know (routes/admin-competitions.ts asks it).
   */
  if (has('courseId')) {
    if (raw.courseId === null || raw.courseId === '') {
      input.courseId = null
    } else if (typeof raw.courseId === 'string' && raw.courseId.trim().length > 0 && raw.courseId.length <= 64) {
      input.courseId = raw.courseId.trim()
    } else {
      return { refusal: { field: 'courseId', why: 'value' } }
    }
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
  /** Late work waits behind every on-time row (store.ts · selectNext). */
  late?: boolean
}

/**
 * The waiting ones — in the order in which they will be taken.
 *
 * THIS IS A COPY OF THE ORDER FROM `store.ts` · `selectNext`, and it cannot be
 * any other: SQL takes the work (two processes must see one answer), while
 * the screen numbers the rows. If they diverge, nothing crashes — the screen
 * simply lies: a person reads "you are second", while the executor takes the
 * third, and nothing can explain it. The rule is one: on-time work before
 * late work; whoever already has something running lets the others go ahead;
 * one's own k-th submission gets in line behind everyone else's (k−1)-th; on
 * a tie, whoever sent it first.
 */
export function fairOrder<T extends QueueOrderRow>(
  waiting: readonly T[],
  busyEntrants: ReadonlySet<string>,
): T[] {
  return [...waiting].sort((a, b) => {
    const late = Number(!!a.late) - Number(!!b.late)
    if (late !== 0) return late
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
