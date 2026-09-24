/**
 * The decisions of the "Competitions" tab, taken out of the components.
 *
 * No Svelte and no browser — as in `admin/panel.ts` and for the same reason:
 * these are the numbers and words a teacher makes decisions by in the middle
 * of a class ("can I fix the metric before the deadline", "why won't it
 * open", "which cell is everyone failing on"), and a mistake in them only
 * shows on a live competition, when it is too late to fix.
 *
 * What is not here: rules that must match the server. Leaderboard order, the
 * counted submission, the row split — all of that lives in
 * `shared/competitions.ts` and is called from there. A second copy of such a
 * rule does not crash; it quietly shows the class a different place.
 */
import { tr, formatDate, formatNumber } from '@shared/i18n'
import {
  boardOf,
  competitionWord,
  directionWord,
  privateBoardOpen,
  type BoardEntry,
  type Competition,
  type CompetitionState,
  type MetricDirection,
  type RankedRow,
  type Submission,
  type SubmissionState,
} from '@shared/competitions'
import type {
  CompetitionRow,
  OpenRefusal,
  QueueSnapshot,
  SubmissionRow,
} from '@shared/competitions-api'

/* ------------------------------------------------------------- numbers */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * A metric value the way it is read in a column.
 *
 * The mockup knows exactly one scale — `0.0412`, four digits — and says
 * nothing about the others. Saying nothing is not an option here: the teacher
 * writes the metric, and RMSE in roubles gives `1234.5678`, while log-loss on
 * a good model gives `0.00003`. The first breaks a 96-pixel column, the
 * second prints as `0.0000` for everyone — that is, a leaderboard whose top
 * ten places look the same.
 *
 * Hence three rules. The larger the number, the fewer digits after the point
 * (the column is twelve characters of 13px monospace, and that was measured,
 * not guessed). Very large and very small values go to exponent notation —
 * it is narrow and honest. `NaN`, `inf` and a missing number become a dash:
 * inventing a zero where scoring failed is not allowed.
 */
export function metricNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const size = Math.abs(value)
  if (size !== 0 && (size >= 1e6 || size < 1e-4)) return value.toExponential(2)
  const digits = size >= 1000 ? 1 : size >= 100 ? 2 : size >= 10 ? 3 : 4
  return value.toFixed(digits)
}

/** An integer with a thousands separator: `7 340`. */
export function count(value: number): string {
  return formatNumber(value)
}

/**
 * A duration in words: "2 min 40 s", "1 min 48 s", "41 s".
 *
 * Seconds are kept for short runs and dropped for long ones: "4 h 12 min
 * 09 s" is not a fact but noise, whereas the difference between "41 s" and
 * "1 min 20 s" on a submission decides whether to wait for it on screen.
 */
export function spanWords(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const whole = Math.round(ms / 1000)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  if (hours > 0) return tr('admin.competitions.spanHm', { h: hours, m: minutes })
  if (minutes > 0) return tr('admin.competitions.spanMs', { m: minutes, s: seconds })
  return tr('admin.competitions.spanS', { s: seconds })
}

/**
 * The run timer: `01:12`, `10:00`, `1:02:30`.
 *
 * A monospace counter, not words: it stands next to the limit ("01:12 of
 * 10:00") and has to be compared at a glance, not by reading. Minutes are
 * zero-padded only when there is something to line up with — in the "TOOK"
 * column the mockup writes `3:05`, without a leading zero.
 */
export function clock(ms: number | null | undefined, pad = false): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const whole = Math.floor(ms / 1000)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  const ss = String(seconds).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
  return `${pad ? String(minutes).padStart(2, '0') : String(minutes)}:${ss}`
}

/**
 * How much is left: "6 d 4 h", "1 h 12 min", "40 s".
 *
 * Two units, never three: "6 d 4 h 17 min" takes longer to read than it is
 * worth, and the only decision made from this line is whether I will make it
 * or not.
 */
export function leftWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return tr('admin.competitions.leftNone')
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY)
    const hours = Math.floor((ms % DAY) / HOUR)
    return hours > 0
      ? tr('admin.competitions.leftDh', { d: days, h: hours })
      : tr('admin.competitions.leftD', { d: days })
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes > 0
      ? tr('admin.competitions.leftHm', { h: hours, m: minutes })
      : tr('admin.competitions.leftH', { h: hours })
  }
  if (ms >= MINUTE) return tr('admin.competitions.leftM', { m: Math.floor(ms / MINUTE) })
  return tr('admin.competitions.leftS', { s: Math.max(1, Math.round(ms / 1000)) })
}

/**
 * How much time has passed: "yesterday", "3 d ago", "a week ago".
 *
 * Its own, not `panel.ts · ago`: that scale ends at days, and a competition
 * finished a month ago was labelled "45 d ago" — a number nobody converts to
 * weeks in their head. Here the scale goes up to months, because the list of
 * competitions lives for a semester, not for one class.
 */
export function sinceWords(from: number, now: number): string {
  const ms = Math.max(0, now - from)
  if (ms < MINUTE) return tr('admin.competitions.sinceNow')
  if (ms < HOUR) return tr('admin.competitions.sinceM', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) return tr('admin.competitions.sinceH', { count: Math.floor(ms / HOUR) })
  const days = Math.floor(ms / DAY)
  if (days === 1) return tr('admin.competitions.sinceYesterday')
  if (days < 7) return tr('admin.competitions.sinceD', { count: days })
  if (days < 31) return tr('admin.competitions.sinceW', { count: Math.floor(days / 7) })
  return tr('admin.competitions.sinceMonth', { count: Math.max(1, Math.floor(days / 30)) })
}

/* ------------------------------------------------------------ deadline */

/** Deadline date and its caption — the two lines of the "DEADLINE" column. */
export interface DeadlineLine {
  /** `27.09, 23:59`, `today, 21:00` or "not set". */
  when: string
  /** "6 d 4 h left", "a week ago", "opens once it passes the check". */
  note: string
  /** The caption is lit: less than half a day to the deadline. */
  hot: boolean
}

/**
 * A moment in the "WHEN" column: `18:58` for today, `13.09` for earlier.
 *
 * The column is 74 pixels wide, and both at once do not fit. The choice is
 * made for the person, and it is the only meaningful one: the feed of a
 * running competition is almost entirely today's, and what tells yesterday's
 * row from today's is not the minute but the day.
 */
export function feedWhen(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return sameDay
    ? formatDate(at, { hour: '2-digit', minute: '2-digit' })
    : formatDate(at, { day: '2-digit', month: '2-digit' })
}

/** A moment as date and time; "today" instead of the date while it is today. */
export function moment(at: number, now: number): string {
  const time = formatDate(at, { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  if (sameDay) return tr('admin.competitions.todayAt', { time })
  return `${formatDate(at, { day: '2-digit', month: '2-digit' })}, ${time}`
}

/**
 * The threshold past which the deadline caption turns yellow.
 *
 * Half a day, not "today": a 23:59 deadline arrives just as suddenly for
 * someone who sat down to the task at nine in the evening as for someone who
 * opened the screen at midnight — and calendar days tell them apart only on a
 * technicality. And not an hour: with an hour left the teacher can no longer
 * do anything on their side, and the list row is there precisely so that
 * they still can.
 */
const HOT_MS = 12 * HOUR

export function deadlineLine(
  c: Pick<Competition, 'state' | 'deadlineAt'>,
  now: number,
  ready: OpenRefusal | null = null,
): DeadlineLine {
  if (c.deadlineAt === null) {
    return {
      when: tr('admin.competitions.deadlineNone'),
      // A draft without a date is not told "no date" (that is visible on the
      // left anyway) but what happens to it next: it waits for a check, not
      // for a date.
      note: c.state === 'draft' ? openNote(ready) : tr('admin.competitions.deadlineOpenEnded'),
      hot: false,
    }
  }
  const when = moment(c.deadlineAt, now)
  if (c.state === 'draft') return { when, note: openNote(ready), hot: false }
  const left = c.deadlineAt - now
  if (c.state === 'finished' || left <= 0) {
    return { when, note: sinceWords(c.deadlineAt, now), hot: false }
  }
  return {
    when,
    note: tr('admin.competitions.left', { time: leftWords(left) }),
    hot: left < HOT_MS,
  }
}

/** A draft's caption: it will open once it passes the check. */
function openNote(ready: OpenRefusal | null): string {
  return ready === null
    ? tr('admin.competitions.readyToOpen')
    : tr('admin.competitions.opensAfterCheck')
}

/* ----------------------------------------------------------- list rows */

/**
 * The title's second line: "MAPE · lower is better · public part 30%".
 *
 * The third piece changes with the state, and that is not decoration: for a
 * draft its place holds the one thing stopping it from opening, for a
 * finished one — whether the final result is open. One line answers the
 * question "what is wrong with it right now", which is why people open the
 * list in the first place.
 */
export function metricLine(row: CompetitionRow, now: number): string {
  const c = row.competition
  const head = `${c.metric.name || tr('admin.competitions.metricUnnamed')} · ${directionWord(c.metric.direction)}`
  if (c.state === 'draft') {
    return `${head} · ${row.ready === null ? tr('admin.competitions.readyToOpen') : tr('admin.competitions.baselineNotPassed')}`
  }
  if (c.state === 'finished') {
    return `${head} · ${
      privateBoardOpen(c, now)
        ? tr('admin.competitions.privateBoardOpen')
        : tr('admin.competitions.privateBoardClosed')
    }`
  }
  return `${head} · ${tr('admin.competitions.publicPart', { percent: c.publicPercent })}`
}

/**
 * The caption under the best public score: "baseline 0.0587" or its trouble.
 *
 * The baseline specifically, not the private result, even for a finished
 * one: there is no private number in a list row and there cannot be — it is
 * one row per competition, while the final result is computed from one
 * submission of EACH entrant. The baseline is exactly what the class's best
 * result is compared with: "0.0412 against 0.0587" is the only thing a list
 * row can say about the quality of the solutions at all.
 */
export function baselineNote(row: CompetitionRow): { text: string; bad: boolean } {
  if (row.baselineState === null) return { text: tr('admin.competitions.baselineNotRun'), bad: false }
  if (row.baselineState === 'metricFailed') {
    return { text: tr('admin.competitions.baselineMetricFailed'), bad: true }
  }
  if (row.baselineState !== 'scored') {
    return { text: tr('admin.competitions.baselineFailed'), bad: true }
  }
  return { text: tr('admin.competitions.baselineScore', { score: metricNumber(row.baselineScore) }), bad: false }
}

/* --------------------------------------------------------- queue strip */

/** The runner strip's two phrases: what is running and on what terms. */
export interface RunnerLine {
  head: string
  tail: string
}

/**
 * "running 1 submission · 2 waiting" and "one at a time · no network · 37 run
 * today, 2 min 40 s on average".
 *
 * The pause is said first and in words: a paused queue looks exactly like an
 * empty one — nothing is running — and only this line tells them apart. A
 * competition whose submissions have silently not been scored for two days
 * starts right here.
 */
export function runnerLine(queue: QueueSnapshot): RunnerLine {
  const parts: string[] = []
  if (queue.paused) parts.push(tr('admin.competitions.queuePaused'))
  parts.push(
    queue.running.length > 0
      ? tr('admin.competitions.runningN', { count: queue.running.length })
      : tr('admin.competitions.runningNone'),
  )
  if (queue.waiting > 0) parts.push(tr('admin.competitions.waitingN', { count: queue.waiting }))
  const tail = [
    tr('admin.competitions.slots', { count: queue.slots }),
    tr('admin.competitions.noNetwork'),
    queue.averageMs === null
      ? tr('admin.competitions.doneToday', { count: queue.doneToday })
      : tr('admin.competitions.doneTodayAvg', {
          count: queue.doneToday,
          avg: spanWords(queue.averageMs),
        }),
  ]
  return { head: parts.join(' · '), tail: tail.join(' · ') }
}

/** "≈ 3 min"; with no estimate it says so, rather than "≈ 0 min". */
export function etaWords(ms: number | null): string {
  if (ms === null) return tr('admin.competitions.etaUnknown')
  if (ms < MINUTE) return tr('admin.competitions.etaSoon')
  return tr('admin.competitions.eta', { time: leftWords(ms) })
}

/* ------------------------------------------------ why it will not open */

/** The editor section where the reason for a refusal lives. */
export type EditorSection = 'basics' | 'data' | 'baseline' | 'metric' | 'terms'

/**
 * Where to take the person for a refusal.
 *
 * A refusal names a reason, not a place, and "There is no answer file" on a
 * screen of six sections is six places to look for it. The order of checks
 * on the server (`competitions/panel.ts` · openRefusal) is the order of the
 * sections from top to bottom, so the mapping is unambiguous.
 */
export function refusalSection(refusal: OpenRefusal): EditorSection {
  switch (refusal) {
    case 'noData':
    case 'noSolution':
      return 'data'
    case 'noMetric':
      return 'metric'
    case 'noBaseline':
    case 'baselineNotChecked':
      return 'baseline'
    case 'noDeadline':
      return 'terms'
  }
}

/** The refusal phrase — the same one the `/open` door refuses with. */
export function refusalText(refusal: OpenRefusal): string {
  return tr(`competitions.refusal.open.${refusal}`)
}

/* ---------------------------------------------------- metric templates */

/** A template: the chip's name, which way the metric points and its code. */
export interface MetricPreset {
  name: string
  direction: MetricDirection
}

/**
 * The seven "TEMPLATES" chips — exactly the ones drawn, in the same order.
 *
 * The direction travels with the name: a MAPE that is "higher is better" is
 * a leaderboard turned upside down, and the one who notices is whoever ends
 * up last.
 */
export const METRIC_PRESETS: readonly MetricPreset[] = [
  { name: 'MAPE', direction: 'lower' },
  { name: 'RMSE', direction: 'lower' },
  { name: 'MAE', direction: 'lower' },
  { name: 'ROC AUC', direction: 'higher' },
  { name: 'F1', direction: 'higher' },
  { name: 'accuracy', direction: 'higher' },
  { name: 'QWK', direction: 'higher' },
]

/** Answer file columns: they tell a template what to merge with what. */
export interface AnswerColumns {
  /** The row key — the first column of `solution.csv`. */
  id: string
  /** What is predicted — the second. */
  target: string
}

/**
 * Columns from the answer file's header; no file — generic names.
 *
 * A template that puts `target` where the answers say `orders` fails on the
 * very first check — with a traceback the teacher will read as a bug in the
 * product. The server has already sent the answers' header (`FileView ·
 * columns`), and the only thing it lacked was someone to read it.
 */
export function answerColumns(columns: readonly string[] | null | undefined): AnswerColumns {
  const named = (columns ?? []).filter((name) => typeof name === 'string' && name.trim() !== '')
  // The `Usage` column marks the row split, it is not a prediction: it sits
  // in the answer file next to the target and does not go into the metric
  // (shared · splitByUsage).
  const useful = named.filter((name) => name.toLowerCase() !== 'usage')
  return { id: useful[0] ?? 'id', target: useful[1] ?? 'target' }
}

/** The `score` body for a template — with this competition's real column names. */
export function presetCode(name: string, columns: AnswerColumns): string {
  const { id, target } = columns
  const guard = [
    `    if list(submission.columns) != [${quote(id)}, ${quote(target)}]:`,
    `        raise ParticipantVisibleError(${quote(tr('admin.competitions.preset.columns', { cols: `${id}, ${target}` }))})`,
    `    merged = solution.merge(submission, on=${quote(id)}, how="left", suffixes=("", "_pred"))`,
    `    if merged[${quote(`${target}_pred`)}].isna().any():`,
    `        raise ParticipantVisibleError(${quote(tr('admin.competitions.preset.missing'))})`,
  ].join('\n')
  const head = (imports: string): string =>
    `${imports}\n\ndef score(solution: pd.DataFrame, submission: pd.DataFrame) -> float:\n${guard}\n`
  const truth = `merged[${quote(target)}]`
  const guess = `merged[${quote(`${target}_pred`)}]`
  switch (name) {
    case 'MAPE':
      return `${head('import numpy as np, pandas as pd')}    err = (${truth} - ${guess}).abs() / ${truth}\n    return float(err.mean())\n`
    case 'RMSE':
      return `${head('import numpy as np, pandas as pd')}    err = (${truth} - ${guess}) ** 2\n    return float(np.sqrt(err.mean()))\n`
    case 'MAE':
      return `${head('import numpy as np, pandas as pd')}    return float((${truth} - ${guess}).abs().mean())\n`
    case 'ROC AUC':
      return `${head('import pandas as pd\nfrom sklearn.metrics import roc_auc_score')}    return float(roc_auc_score(${truth}, ${guess}))\n`
    case 'F1':
      return `${head('import pandas as pd\nfrom sklearn.metrics import f1_score')}    return float(f1_score(${truth}, ${guess}, average="macro"))\n`
    case 'accuracy':
      return `${head('import pandas as pd\nfrom sklearn.metrics import accuracy_score')}    return float(accuracy_score(${truth}, ${guess}))\n`
    case 'QWK':
      return `${head('import pandas as pd\nfrom sklearn.metrics import cohen_kappa_score')}    return float(cohen_kappa_score(${truth}, ${guess}, weights="quadratic"))\n`
    default:
      return `${head('import pandas as pd')}    return float((${truth} - ${guess}).abs().mean())\n`
  }
}

/** A Python string: the same quotes as the rest of the template code. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The metric after a template chip is pressed. */
export interface MetricDraft {
  name: string
  direction: MetricDirection
  code: string
}

/**
 * What a template chip does to what has already been typed.
 *
 * It always changes the name and the direction — that is what it is pressed
 * for. But it puts in code ONLY over an empty field or over another,
 * untouched template: half an hour of work on your own metric, wiped by an
 * accidental hit on a chip, cannot be brought back, and Ctrl+Z in the code
 * field undoes typing, not someone else's substitution.
 */
export function applyPreset(current: MetricDraft, name: string, columns: AnswerColumns): MetricDraft {
  const preset = METRIC_PRESETS.find((one) => one.name === name)
  if (!preset) return current
  const next: MetricDraft = { name: preset.name, direction: preset.direction, code: current.code }
  if (current.code.trim() === '' || isUntouchedPreset(current.code, columns)) {
    next.code = presetCode(preset.name, columns)
  }
  return next
}

/** Code that matches some template exactly — so it belongs to nobody. */
export function isUntouchedPreset(code: string, columns: AnswerColumns): boolean {
  return METRIC_PRESETS.some((preset) => presetCode(preset.name, columns).trim() === code.trim())
}

/* ---------------------------------------------------------- A3 summary */

/** "Notebooks most often die on cell 7 — 11 submissions out of 27". */
export interface WorstCell {
  cell: number
  hits: number
  total: number
}

/**
 * The cell on which the most notebooks fail.
 *
 * The only number on this screen that speaks about the TASK rather than the
 * machine: if twenty-seven people out of a hundred stumble on the seventh
 * cell, the problem is not them but the data or the wording — and you can
 * only see that by piling other people's failures into one heap.
 *
 * `null` where the heap is not a heap yet: one or two failures are just
 * someone's `KeyError`, and calling that a pattern would send the teacher to
 * fix their task because of one person.
 */
export function worstCell(rows: readonly SubmissionRow[], least = 3): WorstCell | null {
  const failed = rows.filter(
    (row) => !row.baseline && row.submission.state === 'notebookFailed' && row.submission.cellsDone > 0,
  )
  if (failed.length === 0) return null
  const tally = new Map<number, number>()
  for (const row of failed) {
    const cell = row.submission.cellsDone
    tally.set(cell, (tally.get(cell) ?? 0) + 1)
  }
  let best: WorstCell | null = null
  for (const [cell, hits] of tally) {
    if (best === null || hits > best.hits || (hits === best.hits && cell < best.cell)) {
      best = { cell, hits, total: failed.length }
    }
  }
  return best !== null && best.hits >= least ? best : null
}

/**
 * A leaderboard from the submission feed, both parts at once.
 *
 * Only for complete local snapshots. The live screen gets the authoritative
 * table from the server: a page of the feed never serves as input for
 * ranking.
 *
 * The baseline solution is taken out of the table: it is not an entrant and
 * is not entitled to a place. The screen draws it as a "baseline" row —
 * separately and without a number.
 */
export function boardFromFeed(
  rows: readonly SubmissionRow[],
  c: Pick<Competition, 'scoring' | 'metric'>,
  part: 'public' | 'private',
): RankedRow[] {
  const people = new Map<string, BoardEntry[]>()
  for (const row of rows) {
    if (row.baseline) continue
    const entries = people.get(row.submission.entrantId) ?? []
    entries.push(entryOf(row.submission))
    people.set(row.submission.entrantId, entries)
  }
  return boardOf(
    [...people].map(([entrantId, entries]) => ({ entrantId, entries })),
    c.scoring,
    c.metric.direction,
    part,
  )
}

function entryOf(submission: Submission): BoardEntry {
  return {
    id: submission.id,
    number: submission.number,
    acceptedAt: submission.acceptedAt,
    state: submission.state,
    publicScore: submission.publicScore,
    privateScore: submission.privateScore,
    chosen: submission.chosen,
  }
}

/* --------------------------------------------------------------- words */

/** What happened to a submission — the "WHAT HAPPENED" column. */
export function outcomeLine(row: SubmissionRow, best: boolean): string {
  const s = row.submission
  if (s.state === 'metricFailed') return tr('admin.competitions.outcome.metricFailed')
  if (s.state === 'scored') {
    if (best) return tr('admin.competitions.outcome.newBest')
    if (s.chosen) return tr('admin.competitions.outcome.chosen')
    return ''
  }
  if (s.participantError) return s.participantError
  if (s.state === 'notebookFailed' && s.cellsDone > 0) {
    return tr('admin.competitions.outcome.cellFailed', { cell: s.cellsDone })
  }
  return ''
}

/** A competition's state as a word — one copy for the list and the header. */
export function stateWord(state: CompetitionState): string {
  return competitionWord(state)
}

/**
 * The tone of a competition's badge, per the mockup's table: live — accent,
 * draft — warning, finished — neutral.
 */
export function stateTone(state: CompetitionState): 'accent' | 'warning' | 'neutral' {
  return state === 'live' ? 'accent' : state === 'draft' ? 'warning' : 'neutral'
}

/** Whether a submission is in flight now; queue rows are not drawn in the feed. */
export function inFlight(state: SubmissionState): boolean {
  return state === 'queued' || state === 'running'
}
