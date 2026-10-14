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
  /**
   * Jobs running now: how long each is expected to take and how long it has
   * run, and whether it holds a share of a runner card.
   */
  running: readonly { expectedMs: number; elapsedMs: number; gpu?: boolean }[]
  /**
   * Waiting jobs in the order the runner prefers them (fairOrder), each with
   * its expected run time and whether it needs a card share.
   */
  waiting: readonly { expectedMs: number; gpu?: boolean }[]
  /**
   * How many runs may hold a card share at once (QueueSnapshot.gpu.slots).
   * Absent — no job waits for a card here: the cluster places GPU work
   * itself, and it is simulated like any other.
   */
  gpuSlots?: number
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
 * average: the moments slots free up (a running job frees one after what it
 * still has left, never sooner than five seconds; an idle slot is free now),
 * and the waiting jobs take them in queue order. With two executors the
 * fifth in the queue waits half as long, and a number computed without this
 * lies by exactly that factor.
 *
 * More running jobs than slots (the owner lowered the number mid-class): the
 * first of them to finish free nothing for the queue — only the last `slots`
 * of them do.
 *
 * With `gpuSlots`, the card shares are simulated as the queue takes them
 * (store.ts · selectNext): a job that needs a card takes a slot AND a share,
 * and while no share is free it is passed over, and the jobs behind it take
 * the slot. So a GPU job may start after jobs that come after it in the
 * order, and the caller numbers places by start (forecast.ts). `null` — a job
 * that needs a card where there are no shares at all: it does not start, and
 * nobody can say when it will.
 *
 * One lane over its places alone, with no memory to wait for: the one
 * simulation of both lanes (laneEtas) asked about a single lane, so the rules
 * above and the ones the forecast numbers places by cannot part.
 */
export function queueEtas(input: EtaInput): Array<Eta | null> {
  return laneEtas({
    memoryMb: null,
    notebook: {
      slots: Math.max(1, Math.floor(input.slots)),
      elsewhere: 0,
      running: input.running.map((job) => ({ ...job, memoryMb: 0 })),
      waiting: input.waiting.map((job, index) => ({ ...job, memoryMb: 0, enqueuedAt: 0, submissionId: String(index) })),
      ...(input.gpuSlots === undefined ? {} : { gpuSlots: input.gpuSlots }),
    },
    metric: { slots: 1, running: [], waiting: [] },
  }).notebook
}

/* ------------------------------------------- the two lanes over one memory */

/** The pump's two lanes as the simulation names them (store.ts · QueueLane). */
export type LaneName = 'notebook' | 'metric'

/** A waiting job of one lane, as the simulation of both lanes takes it (laneEtas). */
export interface LaneJob extends LaneHead {
  expectedMs: number
  /** What it reserves of this server's memory while it runs here (runner.ts · runReservationMb). */
  memoryMb: number
  /** Whether it needs a card share: a notebook of a competition whose card is on, never a metric. */
  gpu?: boolean
  /**
   * `false` — this server's pump never takes it (remote/fit.ts · homeTakes: a
   * GPU notebook where this server has no card), and only a machine's place
   * starts it: it never holds one of this server's places or its memory.
   */
  home?: boolean
}

/** A job running now, as the simulation of both lanes counts it. */
export interface LaneRun {
  expectedMs: number
  elapsedMs: number
  gpu?: boolean
  /** What it holds of this server's memory until it ends; 0 — nothing here (a machine's run). */
  memoryMb: number
  /** A machine's run: it holds one of the machines' places, not one of this server's. */
  elsewhere?: boolean
}

export interface LanesInput {
  /**
   * What this server's queue may hold of its memory in all — what may be
   * promised to competition work, less the containers still being removed
   * and every reservation that is not a run of the queue's (runner.ts ·
   * queueMemory). `null` — unknown, and no job waits for memory: the pump
   * refuses none for a number it does not have.
   */
  memoryMb: number | null
  notebook: {
    /** This server's places for notebooks: its slots, none while it runs no notebooks. */
    slots: number
    /** The live machines' places together (remote/views.ts · remoteFleet): a run there takes none of this server's memory. */
    elsewhere: number
    running: readonly LaneRun[]
    /** In the order the take walks them (fairOrder). */
    waiting: readonly LaneJob[]
    /** Runs that may hold a card share at once, this server's and the machines' together; absent — no card is counted, and GPU work is simulated like any other. */
    gpuSlots?: number
  }
  metric: {
    slots: number
    running: readonly LaneRun[]
    /** In the metric lane's own order (scoreOrder). */
    waiting: readonly LaneJob[]
  }
}

export interface LanesEtas {
  /** Per waiting notebook, in its order: when it starts and when its result is expected; `null` — it does not start. */
  notebook: Array<Eta | null>
  metric: Array<Eta | null>
  /** Every simulated start, in the order the pump makes them: the places on both screens. */
  starts: Array<{ lane: LaneName; index: number }>
}

/** A run's end in the simulation, and everything it gives back. */
interface LaneEnd {
  at: number
  lane: LaneName
  elsewhere: boolean
  card: boolean
  memoryMb: number
}

/**
 * Both lanes of the pump at once (runner.ts · takeLanes), over the one
 * memory they share: what the forecast numbers the places by.
 *
 * Simulated apart, as they once were, each lane read its free places and
 * nothing else, and a lane whose head the memory held back was promised a
 * start "now" for as long as the other lane kept the memory: a notebook
 * ahead of a bulk rescore read «первое место, начнётся сейчас» through the
 * whole rescore. So the simulation takes work exactly as the pump does.
 * Each lane has its own places and its own order; a notebook that needs a
 * card share is passed over while none is free, and the work behind it
 * takes the place (store.ts · selectNext); a notebook goes to a machine's
 * place first, where it costs this server no memory; and of the two heads that
 * would take this server's memory the one that waited longer goes first
 * (laneHeadOrder). A head that does not fit what is free waits for what the
 * queue's own runs will free, and the other lane's head waits behind it; a
 * head that would not fit even with nothing of the queue running is waiting
 * for no run of the queue at all, and its lane alone takes nothing here
 * while it stays its head — the pump stops at a lane's head too.
 *
 * A running job frees what it holds after what it still has left, never
 * sooner than five seconds (MIN_REMAINING_MS), and every job that ends at a
 * moment gives back what it held before anything starts at it; the places
 * are the order of the simulated starts.
 */
export function laneEtas(input: LanesInput): LanesEtas {
  const notebook = input.notebook
  const metric = input.metric
  const cards = notebook.gpuSlots === undefined ? null : Math.max(0, Math.floor(notebook.gpuSlots))
  const needsCard = (job: { gpu?: boolean }): boolean => cards !== null && job.gpu === true
  const total = input.memoryMb === null ? Infinity : Math.max(0, input.memoryMb)
  // More running than places (the owner lowered the number): the first of them to end free nothing for the queue.
  let homeFree = Math.max(0, Math.floor(notebook.slots)) - notebook.running.filter((run) => !run.elsewhere).length
  let awayFree = Math.max(0, Math.floor(notebook.elsewhere)) - notebook.running.filter((run) => run.elsewhere).length
  let metricFree = Math.max(1, Math.floor(metric.slots)) - metric.running.length
  let freeCards = cards ?? 0
  let freeMb = total
  const ends = new EndHeap()
  const hold = (lane: LaneName, run: LaneRun): void => {
    const card = lane === 'notebook' && needsCard(run)
    if (card) freeCards--
    freeMb -= run.memoryMb
    ends.push({ at: Math.max(run.expectedMs - run.elapsedMs, MIN_REMAINING_MS), lane, elsewhere: !!run.elsewhere, card, memoryMb: run.memoryMb })
  }
  for (const run of notebook.running) hold('notebook', run)
  for (const run of metric.running) hold('metric', run)
  const etas: LanesEtas = { notebook: notebook.waiting.map(() => null), metric: metric.waiting.map(() => null), starts: [] }
  const pending: Record<LaneName, number[]> = { notebook: notebook.waiting.map((_, index) => index), metric: metric.waiting.map((_, index) => index) }
  let now = 0
  const start = (lane: LaneName, at: number, elsewhere: boolean): void => {
    const index = pending[lane].splice(at, 1)[0]
    const job = (lane === 'notebook' ? notebook : metric).waiting[index]
    const card = lane === 'notebook' && needsCard(job)
    const memoryMb = elsewhere ? 0 : job.memoryMb
    if (lane === 'metric') metricFree--
    else if (elsewhere) awayFree--
    else homeFree--
    if (card) freeCards--
    freeMb -= memoryMb
    const etaMs = now + Math.max(0, job.expectedMs)
    etas[lane][index] = { startMs: now, etaMs }
    etas.starts.push({ lane, index })
    ends.push({ at: etaMs, lane, elsewhere, card, memoryMb })
  }
  for (;;) {
    // Everything that can start now starts, the way one pass of the pump takes it.
    for (;;) {
      // The notebook lane's head: the first in its order that no card holds back (store.ts · selectNext) — here, of the work this server takes at all.
      const cardFree = (index: number): boolean => !needsCard(notebook.waiting[index]) || freeCards > 0
      const away = awayFree > 0 ? pending.notebook.findIndex(cardFree) : -1
      if (away >= 0) {
        start('notebook', away, true)
        continue
      }
      const nb = homeFree > 0 ? pending.notebook.findIndex((index) => notebook.waiting[index].home !== false && cardFree(index)) : -1
      const heads: Array<{ lane: LaneName; at: number; job: LaneJob }> = []
      if (nb >= 0) heads.push({ lane: 'notebook', at: nb, job: notebook.waiting[pending.notebook[nb]] })
      if (metricFree > 0 && pending.metric.length > 0) heads.push({ lane: 'metric', at: 0, job: metric.waiting[pending.metric[0]] })
      heads.sort((a, b) => laneHeadOrder(a.job, b.job))
      let started = false
      for (const head of heads) {
        if (head.job.memoryMb <= freeMb) {
          start(head.lane, head.at, false)
          started = true
          break
        }
        // It waits for what the queue's own runs will free, and the head that waited less waits behind it.
        if (head.job.memoryMb <= total) break
      }
      if (!started) break
    }
    if (pending.notebook.length === 0 && pending.metric.length === 0) break
    // Then time moves to the next end; every job that ends at that moment gives back what it held first.
    if (ends.size === 0) break
    now = ends.peek().at
    while (ends.size > 0 && ends.peek().at === now) {
      const end = ends.pop()
      if (end.lane === 'metric') metricFree++
      else if (end.elsewhere) awayFree++
      else homeFree++
      if (end.card) freeCards++
      freeMb += end.memoryMb
    }
  }
  return etas
}

/** The earliest end first. A few hundred entries at most. */
class EndHeap {
  private readonly items: LaneEnd[] = []

  get size(): number {
    return this.items.length
  }

  /** The earliest, left where it is; only for a heap that is not empty. */
  peek(): LaneEnd {
    return this.items[0]
  }

  push(value: LaneEnd): void {
    const items = this.items
    items.push(value)
    let at = items.length - 1
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (items[parent].at <= items[at].at) break
      ;[items[parent], items[at]] = [items[at], items[parent]]
      at = parent
    }
  }

  pop(): LaneEnd {
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
        if (left < items.length && items[left].at < items[least].at) least = left
        if (right < items.length && items[right].at < items[least].at) least = right
        if (least === at) break
        ;[items[least], items[at]] = [items[at], items[least]]
        at = least
      }
    }
    return top
  }
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
  /** A video card for an environment that runs on the CPU (`gpuEnvironmentRefusal`). */
  | { field: 'limits.gpu'; why: 'cpuEnvironment'; environment: string }

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
    // A switch, like late intake below: true or false, never "anything truthy".
    if (Object.prototype.hasOwnProperty.call(limits, 'gpu')) {
      if (typeof limits.gpu !== 'boolean') return { refusal: { field: 'limits.gpu', why: 'value' } }
      out.gpu = limits.gpu
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
 * A video card is for an environment that needs one; `null` — the edit is fine.
 *
 * Judged on what the competition is AFTER the edit — the environment and the
 * switch as sent, or as they are where the form did not send them — so both
 * ways in are closed: turning the card on for a CPU environment, and moving a
 * competition that has a card to a CPU environment. A card under a CPU
 * environment is a card held for nothing: no package there can use it, and
 * the run takes it from a submission that could. Only an edit that touches
 * one of the two is judged: a title saved under an environment that has since
 * lost its GPU directive is not the place to stop someone.
 *
 * `needsGpu` comes in from outside (competitions/gpu.ts · environmentNeedsGpu):
 * whether an environment needs a GPU is read from its package list on disk,
 * or from the cluster's catalog, and this module reads neither.
 */
export function gpuEnvironmentRefusal(
  input: CompetitionInput,
  current: { environment: string; limits: { gpu?: boolean } } | null,
  needsGpu: (environment: string) => boolean,
): InputRefusal | null {
  if (input.environment === undefined && input.limits?.gpu === undefined) return null
  // A new competition is born on `base` (store.ts · createCompetition).
  const environment = input.environment ?? current?.environment ?? 'base'
  const gpu = input.limits?.gpu ?? current?.limits.gpu ?? false
  if (!gpu || needsGpu(environment)) return null
  return { field: 'limits.gpu', why: 'cpuEnvironment', environment }
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
 *
 * The one part of `selectNext` that is not an order is not here: work that
 * needs a card share is passed over while none is free. Whether it is
 * depends on the moment, so that part lives in the simulation (queueEtas),
 * and the places on both screens are numbered by the simulated starts
 * (forecast.ts) — with no GPU work waiting, exactly this order.
 *
 * "Something running" is a COUNT, as in the SQL, not a yes or no: a person
 * with two runs going lets a person with one go ahead, and a person's runs
 * count wherever they run — here or on a machine that runs submissions
 * (RunningCounts). As a yes or no the screen put the person with two first
 * among equals by arrival, while the executor took the other.
 */
export function fairOrder<T extends QueueOrderRow>(
  waiting: readonly T[],
  running: RunningCounts,
): T[] {
  return [...waiting].sort((a, b) => {
    const late = Number(!!a.late) - Number(!!b.late)
    if (late !== 0) return late
    const busy = runningOf(running, a.entrantId) - runningOf(running, b.entrantId)
    if (busy !== 0) return busy
    if (a.turn !== b.turn) return a.turn - b.turn
    if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt
    return a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0
  })
}

/**
 * How many runs each person has going, by entrant — every running row of
 * the queue, whoever holds it (store.ts · selectNext counts them all). A set
 * of entrants is the older form, and reads as one run each.
 */
export type RunningCounts = ReadonlyMap<string, number> | ReadonlySet<string>

/** The running rows counted per person, the way selectNext counts them. */
export function runningCounts(running: readonly { entrantId: string }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of running) counts.set(row.entrantId, (counts.get(row.entrantId) ?? 0) + 1)
  return counts
}

function runningOf(running: RunningCounts, entrantId: string): number {
  return running instanceof Set ? (running.has(entrantId) ? 1 : 0) : ((running as ReadonlyMap<string, number>).get(entrantId) ?? 0)
}

/**
 * The metric lane's order — A COPY OF store.ts · selectNextScore, for the same
 * reason fairOrder copies selectNext: a fresh result (`fresh` — the metric of
 * a notebook that has already run, as its queue row says, QueueRow.fresh)
 * before every rescore, and the fair order within each.
 */
export function scoreOrder<T extends QueueOrderRow>(
  waiting: readonly T[],
  running: RunningCounts,
  fresh: (row: T) => boolean,
): T[] {
  const fair = fairOrder(waiting, running)
  return [...fair.filter(fresh), ...fair.filter((row) => !fresh(row))]
}

/** A lane's head as the two lanes are weighed against each other (laneHeadOrder). */
export interface LaneHead {
  submissionId: string
  enqueuedAt: number
  late?: boolean
}

/**
 * Which of the two lanes' heads takes this server's memory first when it
 * fits only one of them (runner.ts · takeLanes; laneEtas simulates the
 * same): on-time work before late work, as everywhere in the queue, then the
 * one that has waited longer.
 *
 * NEITHER LANE GOES FIRST BY RIGHT. The places are each lane's own, the
 * memory is one, and whichever lane was asked first took what a run that
 * ended had freed. Notebooks first, a server whose memory, not its places,
 * was the limit gave every freed four gigabytes to the next notebook, and a
 * rescore after a metric fix, the teacher's metric check and a machine's
 * fresh result waited for the whole notebook backlog; metrics first, the
 * memory each metric freed went to the next one, and a notebook ahead of a
 * bulk rescore waited for all of it. By arrival neither waits for more than
 * what came before it, which is what the one fair order of 0.22 promised.
 * A machine's fresh result keeps its notebook's arrival (store.ts ·
 * continueQueueAsMetric), so it goes ahead of everything sent after that
 * notebook, as a run here would have; a rescore arrives when it is asked
 * for.
 */
export function laneHeadOrder(a: LaneHead, b: LaneHead): number {
  const late = Number(!!a.late) - Number(!!b.late)
  if (late !== 0) return late
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt
  return a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0
}

/** Delayed resource retries remain visible, but cannot claim a queue slot yet. */
export function waitingEligibilityOrder<T extends QueueOrderRow & {notBefore:number}>(
  waiting:readonly T[],running:RunningCounts,now=Date.now(),
):{eligible:T[];deferred:T[]} {
  return {
    eligible:fairOrder(waiting.filter(row=>row.notBefore<=now),running),
    deferred:fairOrder(waiting.filter(row=>row.notBefore>now),running),
  }
}
