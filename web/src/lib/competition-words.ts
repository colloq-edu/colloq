/**
 * Everything the competition pages compute and say — without a single DOM node.
 *
 * Here is what has a right and a wrong answer: how much time is left until the
 * deadline, how a metric number is typeset, which caption sits under a file
 * name, where a submission stands on the stage strip. On screen all of this
 * looks equally plausible whatever the answer — "0.046" instead of "0.0455",
 * "1 h" instead of "1 h 12 min", a green stage instead of the current one —
 * and a mistake in it is noticed during a class, not in the browser.
 *
 * The words come from the `competitions` catalog
 * (shared/locales/competitions.ts), and only from it: the `/k` pages load
 * neither the room catalog nor the panel one
 * (web/src/lib/messages/competitions-*.ts), so `spell()` and `elapsed()` from
 * lib/utils.ts, built on `room.ui.*` keys, would show a bare key here.
 *
 * Badges, stages and the metric direction live not here but in
 * `@shared/competitions`: the server and the browser say them the same way,
 * and a second copy would drift from the first on the very first edit.
 */
import { formatNumber, getLocale, tr } from '@shared/i18n'
import {
  metricFailedNote,
  stagePosition,
  stageWord,
  SUBMISSION_STAGES,
  DIRECTION_ARROW,
  type EntrantSubmission,
  type MetricDirection,
  type StagePosition,
  type SubmissionStage,
  type SubmissionState,
} from '@shared/competitions'
import type { SubmissionLive } from '@shared/competitions-entrant'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* ----------------------------------------------------------------- number */

/**
 * A metric — with four digits after the point, as throughout the mockup.
 *
 * Four digits were not chosen by column width: the difference between 0.0455
 * and 0.0452 is the difference between fourth and seventh place, and rounding
 * to three digits glues neighbours together on the leaderboard. But a metric
 * is not always a fraction: RMSE in roubles arrives in thousands, and `log
 * loss` on a degenerate task in millionths. So there are three steps, and each
 * keeps SIGNIFICANT digits, not a number of decimal places.
 *
 * `NaN` and infinity are a dash: a number that does not exist must not look
 * like a number. Such a thing comes from a metric that divided by zero and did
 * not crash.
 */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const size = Math.abs(value)
  if (size !== 0 && (size >= 1e6 || size < 1e-4)) return value.toExponential(2)
  if (size >= 1000) return value.toFixed(2)
  return value.toFixed(4)
}

/** "0.0412 · 3rd" — number and place on one line (the "PUBLIC MAPE" column, P3). */
export function scoreWithPlace(score: number | null, place: number | null): string {
  const number = formatScore(score)
  return place === null ? number : `${number} · ${ordinalPlace(place)}`
}

/**
 * "7th · 0.0455" — the same, but place first (the "YOU" block on P1).
 *
 * The order is not cosmetic: in a list card the person looks for THEMSELVES,
 * that is, their place, while in a leaderboard column they look for the number
 * the column is named after. Both forms are in the mockup, and both are here.
 */
export function placeWithScore(place: number | null, score: number | null): string {
  if (place === null) return formatScore(score)
  return `${ordinalPlace(place)} · ${formatScore(score)}`
}

/**
 * The place as an ordinal: "7-й" in Russian, "7th" in English.
 *
 * Always the masculine form, although the mockup writes the feminine "1-я" for
 * Marfa and the masculine "3-й" for Daniil: agreement is only possible with
 * the person's gender, and gender cannot be derived from a name either
 * reliably or politely. One form is more honest than a guessed one.
 */
export function ordinalPlace(place: number): string {
  if (getLocale() !== 'en') return `${place}-й`
  const mod100 = place % 100
  if (mod100 >= 11 && mod100 <= 13) return `${place}th`
  const mod10 = place % 10
  return `${place}${mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th'}`
}

/** "MAPE ↓" — the metric with its direction arrow (P1, P4). */
export function metricArrow(name: string, direction: MetricDirection): string {
  return `${name} ${DIRECTION_ARROW[direction]}`
}

/* --------------------------------------------------------------- time */

/**
 * A finished duration in words: "41 s", "2 min 51 s", "6 min", "1 h 12 min".
 *
 * Seconds disappear as soon as hours appear: "1 h 12 min 03 s" is a precision
 * nobody uses, and three extra characters in the column.
 */
export function spellDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / SECOND)
  if (total < 60) return tr('competitions.p.durSeconds', { count: total })
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return seconds === 0
      ? tr('competitions.p.durMinutes', { count: minutes })
      : tr('competitions.p.durMinutesSeconds', { minutes, seconds })
  }
  return tr('competitions.p.durHoursMinutes', {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
  })
}

/**
 * How much is left, in words: "6 d 4 h", "1 h 12 min", "12 min".
 *
 * Two units and no more: the person reads this line to decide "will I make it
 * today or not", and a third unit does not affect that decision.
 */
export function remainingWords(ms: number): string {
  if (ms <= 0) return tr('competitions.p.closedNow')
  if (ms < MINUTE) return tr('competitions.p.durInstant')
  if (ms < HOUR) return tr('competitions.p.durMinutes', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) {
    return tr('competitions.p.durHoursMinutes', {
      hours: Math.floor(ms / HOUR),
      minutes: Math.floor((ms % HOUR) / MINUTE),
    })
  }
  return tr('competitions.p.durDaysHours', {
    days: Math.floor(ms / DAY),
    hours: Math.floor((ms % DAY) / HOUR),
  })
}

/**
 * The same time, but as a clock: "6 d 04:12", "04:12", "00:07".
 *
 * The large figure in the header (P2, P4) is a clock, not words, and that is
 * not taste: it updates every minute in plain sight, and "1 h 12 min" →
 * "1 h 11 min" changes the width of the line, while `01:12` → `01:11` does not.
 */
export function remainingClock(ms: number): string {
  if (ms <= 0) return '00:00'
  const days = Math.floor(ms / DAY)
  const rest = ms - days * DAY
  const clock = `${pad(Math.floor(rest / HOUR))}:${pad(Math.floor((rest % HOUR) / MINUTE))}`
  return days > 0 ? tr('competitions.p.durClockDays', { days, clock }) : clock
}

/** "01:12" — the stopwatch of a run in progress; hours appear only when needed. */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${pad(minutes)}:${pad(seconds)}`
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * A deadline is urgent when it is less than six hours away.
 *
 * Six, not a day: "20 h left" is still a whole evening, and painting it as
 * alarming teaches people to ignore the colour. Six hours is the last round in
 * which a person can still train a model and send the notebook.
 */
export const URGENT_MS = 6 * HOUR

export function deadlineUrgent(deadlineAt: number | null, now: number): boolean {
  if (deadlineAt === null) return false
  const left = deadlineAt - now
  return left > 0 && left <= URGENT_MS
}

/** The caption under the timer: "until 27.09, 23:59" or "today until 21:00". */
export function deadlineNote(deadlineAt: number | null, now: number): string {
  if (deadlineAt === null) return tr('competitions.p.noDeadline')
  if (deadlineAt <= now) return tr('competitions.p.closedNow')
  if (sameDay(deadlineAt, now)) return tr('competitions.p.untilToday', { time: clockOf(deadlineAt) })
  return tr('competitions.p.untilDate', { date: `${dateOf(deadlineAt)}, ${clockOf(deadlineAt)}` })
}

/** "Today at 18:40", "Yesterday at 22:14", "13.09 at 20:05". */
export function whenWords(at: number, now: number): string {
  if (sameDay(at, now)) return tr('competitions.p.todayAt', { time: clockOf(at) })
  if (sameDay(at, now - DAY)) return tr('competitions.p.yesterdayAt', { time: clockOf(at) })
  return tr('competitions.p.dateAt', { date: dateOf(at), time: clockOf(at) })
}

export function sameDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/** "23:59" in the reader's time zone: the server sends a moment, not a string. */
export function clockOf(at: number): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(at))
}

/** "27.09" — day and month, no year: a competition lives for weeks, not years. */
export function dateOf(at: number): string {
  return new Intl.DateTimeFormat(getLocale(), { day: '2-digit', month: '2-digit' })
    .format(new Date(at))
}

/* ----------------------------------------------------------- stage strip */

export interface StageCell {
  stage: SubmissionStage
  position: StagePosition
  word: string
}

/** The strip's five captions under a running submission (P2) — with their state colour. */
export function stageStrip(state: SubmissionState, at: SubmissionStage): StageCell[] {
  return SUBMISSION_STAGES.map((stage) => ({
    stage,
    position: stagePosition(state, at, stage),
    word: stageWord(stage),
  }))
}

/**
 * How full the strip is, 0–100.
 *
 * Cells are the only thing that really moves, so they are what counts: while
 * their number is unknown (the notebook has not been opened yet), the strip
 * shows the stage, not zero. A zero under the word "RUNNING" reads as "stuck".
 */
export function runProgress(live: Pick<SubmissionLive, 'stage' | 'cellsDone' | 'cellsTotal'>): number {
  if (live.cellsTotal > 0) {
    const share = live.cellsDone / live.cellsTotal
    return clampPercent(5 + share * 90)
  }
  const at = SUBMISSION_STAGES.indexOf(live.stage)
  return clampPercent(((at + 1) / SUBMISSION_STAGES.length) * 100)
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/* ----------------------------------------------------------------- queue */

/** "Third", "11th" — the place in the queue as a word, the way it is said aloud. */
export function queueOrdinal(place: number): string {
  if (place >= 1 && place <= 10) return tr(`competitions.p.ordinal.${place}`)
  return tr('competitions.p.ordinalN', { count: place })
}

export interface QueueNote {
  place: number | null
  aheadNumber: number | null
  paused: boolean
  /** The phone says it shorter: "starts after submission #12", without "finishes". */
  short?: boolean
}

/**
 * The caption of a waiting submission: "Third in the queue · starts once
 * submission #12 finishes".
 *
 * The tail about someone else's number is never written (the server does not
 * even send it): "after submission #7" about someone else's submission is a
 * number from someone else's list, which the person has nothing to match
 * against their own.
 */
export function queueNote(note: QueueNote): string {
  const parts: string[] = []
  if (note.place !== null) parts.push(tr('competitions.p.queueAt', { place: queueOrdinal(note.place) }))
  if (note.aheadNumber !== null) {
    parts.push(
      tr(note.short ? 'competitions.p.afterMineShort' : 'competitions.p.afterMine', {
        number: note.aheadNumber,
      }),
    )
  }
  if (note.paused) parts.push(tr('competitions.p.queuePaused'))
  return parts.join(' · ')
}

/* ----------------------------------------------- submission row captions */

/**
 * The first sentence of a refusal goes to the title, the rest to the caption.
 *
 * For "ANSWER REJECTED" the row title is not the file name but the reason:
 * "Not every row of test.csv has a prediction", and that is not a whim of the
 * mockup — the reason matters more to an entrant than what they named the
 * file. The reason arrives as one line from the metric, and it is cut at the
 * first full stop: that is how all catalog messages are written ("… has a
 * prediction. submission.csv has 391 rows instead of 397…").
 */
export function splitError(text: string | null): { head: string; rest: string } {
  const value = (text ?? '').trim()
  if (!value) return { head: '', rest: '' }
  const at = value.search(/[.!?:](\s|$)/)
  if (at < 0 || at >= value.length - 1) return { head: value, rest: '' }
  return { head: value.slice(0, at + 1).trim(), rest: value.slice(at + 1).trim() }
}

export interface RowWords {
  /** What sits in the row title: the file name or the refusal reason. */
  title: string
  /** The caption lines under it, top to bottom. */
  lines: string[]
}

export interface RowInput {
  submission: EntrantSubmission
  live: SubmissionLive | null
  /** The best public result among one's own submissions. */
  best: boolean
  paused: boolean
  now: number
  /** The phone layout (P4): shorter captions, no duration. */
  phone?: boolean
}

/**
 * What a submission row says — as title and caption.
 *
 * One function for all eight outcomes on purpose: the caption differs from
 * outcome to outcome not in styling but in CONTENT ("failed at cell 7 of 14
 * after 41 s" versus "stopped at cell 11 of 16"), and assembled on the spot it
 * would drift apart between desktop and phone on the very first edit.
 */
export function rowWords(input: RowInput): RowWords {
  const { submission, live, now } = input
  const file = submission.fileName
  switch (submission.state) {
    case 'running': {
      const lines: string[] = []
      if ((live?.stage ?? submission.stage) === 'dependencies') {
        return { title: file, lines: [tr('dependencies.installing')] }
      }
      if (input.phone) {
        lines.push(
          submission.cellsTotal > 0
            ? tr('competitions.p.cellRunning', {
                cell: Math.max(1, submission.cellsDone),
                cells: submission.cellsTotal,
              })
            : tr('competitions.entrant.running'),
        )
        return { title: file, lines }
      }
      if (submission.cellsTotal > 0) {
        lines.push(
          tr('competitions.p.cellOf', {
            cell: Math.max(1, submission.cellsDone),
            cells: submission.cellsTotal,
          }),
        )
      }
      lines.push(tr('competitions.p.sentAt', { time: clockOf(submission.acceptedAt) }))
      if (live?.startedAt) {
        lines.push(
          tr('competitions.p.waited', {
            duration: spellDuration(live.startedAt - submission.acceptedAt),
          }),
        )
      }
      return { title: file, lines: [lines.join(' · ')] }
    }
    case 'queued':
      return {
        title: file,
        lines: [
          live?.resourcePending ? tr('competitions.runtime.resourcesWaiting') : '',
          queueNote({
            place: live?.place ?? null,
            aheadNumber: live?.aheadNumber ?? null,
            paused: input.paused,
            short: input.phone,
          }),
        ].filter(Boolean),
      }
    case 'scored': {
      const parts = [whenWords(submission.acceptedAt, now)]
      if (!input.phone) {
        parts.push(
          input.best
            ? spellDuration(submission.durationMs)
            : tr('competitions.p.doneIn', { duration: spellDuration(submission.durationMs) }),
        )
      }
      if (input.best) parts.push(tr('competitions.p.best'))
      return { title: file, lines: [parts.join(' · ')] }
    }
    case 'notebookFailed': {
      const head = [whenWords(submission.acceptedAt, now)]
      if (submission.cellsTotal > 0) {
        head.push(
          tr('competitions.p.failedAtCell', {
            cell: Math.max(1, submission.cellsDone),
            cells: submission.cellsTotal,
            duration: spellDuration(submission.durationMs),
          }),
        )
      }
      return { title: file, lines: [head.join(' · ')] }
    }
    case 'timedOut': {
      const head = [whenWords(submission.acceptedAt, now)]
      if (submission.cellsTotal > 0) {
        head.push(
          tr('competitions.p.stoppedAtCell', {
            cell: Math.max(1, submission.cellsDone),
            cells: submission.cellsTotal,
          }),
        )
      }
      const lines = [head.join(' · ')]
      if (submission.participantError && !input.phone) lines.push(submission.participantError)
      return { title: file, lines }
    }
    case 'rejected': {
      /*
       * The reason goes to the title, the file name to the caption: that is
       * the mockup, and this is the one outcome where the person looks not at
       * "which notebook did I send" but at "what exactly was wrong with the
       * answer".
       */
      const { head, rest } = splitError(submission.participantError)
      const first = [whenWords(submission.acceptedAt, now), file]
      if (!input.phone) first.push(spellDuration(submission.durationMs))
      const lines = [first.join(' · ')]
      if (rest && !input.phone) lines.push(rest)
      return { title: head || file, lines: input.phone && head ? [] : lines }
    }
    case 'outOfMemory': {
      const lines = [whenWords(submission.acceptedAt, now)]
      if (submission.participantError && !input.phone) lines.push(submission.participantError)
      return { title: file, lines }
    }
    case 'metricFailed':
      return {
        title: file,
        lines: [whenWords(submission.acceptedAt, now), metricFailedNote()],
      }
    case 'cancelled':
      return {
        title: file,
        lines: [`${whenWords(submission.acceptedAt, now)} · ${tr('competitions.p.cancelledNote')}`],
      }
  }
}

/* ----------------------------------------------------------- leaderboard */

/**
 * Places in the table — by PEOPLE, with the baseline wherever it landed.
 *
 * The server ranks everyone in a row, and the baseline gets an ordinary place
 * from it. While it is twentieth of twenty-eight (as in the mockup), there is
 * no difference; but in a competition where nobody has beaten the baseline
 * yet, it becomes first, and the person reads "YOUR PLACE 2 of 3" in the
 * header next to a row "3" in the table. Here the baseline stops taking
 * people's places and stands exactly where it would if it were an entrant:
 * after everyone who has beaten it.
 *
 * The order of the rows does not change — the server has already computed it
 * by the metric's rule.
 */
export function boardPlaces<T extends { baseline: boolean }>(
  lines: readonly T[],
): (T & { place: number | null })[] {
  let people = 0
  return lines.map((line) => {
    if (!line.baseline) {
      people += 1
      return { ...line, place: people }
    }
    /*
     * A baseline nobody has beaten yet takes no place at all: a "1" in its row
     * next to the "1" of the first person reads as a tie that does not exist.
     * A dash in that spot is the news itself: no submission is better than the
     * baseline yet.
     */
    return { ...line, place: people === 0 ? null : people + 1 }
  })
}

/* ----------------------------------------------------------------- files */

/**
 * The size of a data file: "6 KB", "212 KB", "4.1 MB".
 *
 * Our own, not `formatBytes` from lib/utils.ts: that one is built on `room.*`
 * keys, and the room catalog does not reach these pages — the screen would
 * show the string `room.ui.1185`. The tenth lives only up to ten megabytes:
 * beyond that it says nothing and breaks the column's width.
 */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return tr('competitions.p.sizeBytes', { count: bytes })
  if (bytes < 1024 * 1024) {
    return tr('competitions.p.sizeKb', { size: formatNumber(Math.round(bytes / 1024)) })
  }
  const mb = bytes / (1024 * 1024)
  const digits = mb < 10 ? 1 : 0
  return tr('competitions.p.sizeMb', {
    size: formatNumber(mb, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  })
}

/* --------------------------------------------------------------- avatar */

/**
 * A circle with a letter: the mockup's six pastel backings, chosen by name.
 *
 * By name, not by id: a person recognises themselves in the table by colour,
 * and that colour must be the same on a phone, where the id is different… and
 * the same after the teacher issues a new key.
 */
export const AVATAR_TINTS: readonly string[] = [
  '#CFE3F7',
  '#F7D9E3',
  '#D8F0E4',
  '#F2D9B8',
  '#E3DDF7',
  '#F7E9C4',
]

export function avatarTint(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 100_000
  return AVATAR_TINTS[hash % AVATAR_TINTS.length]
}

/** One letter on the circle — the first letter of the name, as in the mockup ("T"). */
export function avatarLetter(name: string): string {
  const trimmed = name.trim()
  return trimmed ? [...trimmed][0].toUpperCase() : '?'
}

/** "Timur A." — how the person is labelled in the phone header. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return name.trim()
  return `${parts[0]} ${[...parts[1]][0].toUpperCase()}.`
}
