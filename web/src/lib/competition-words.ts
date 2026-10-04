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
import { zonedClock } from '@shared/time-zone'
import {
  acceptsUploads,
  compareScores,
  countedSubmission,
  countsTowardDailyQuota,
  entrantBadge,
  hasScore,
  isTerminal,
  metricFailedNote,
  placesAmongPeople,
  stagePosition,
  stageWord,
  SUBMISSION_STAGES,
  DIRECTION_ARROW,
  type CompetitionPublic,
  type EntrantSubmission,
  type MetricDirection,
  type Placed,
  type StagePosition,
  type SubmissionBadge,
  type SubmissionStage,
  type SubmissionState,
} from '@shared/competitions'
import type {
  Accepting,
  EntrantCompetitionView,
  EntrantSubmissions,
  FailedAttempts,
  SubmissionLive,
} from '@shared/competitions-entrant'

/*
 * Re-exported for the components: the send box and the header ask "does the
 * door take a notebook now" by the server's own rule, and the svelte files
 * that tests compile on their own reach shared code only through this module.
 */
export { acceptsUploads }

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
  return englishOrdinal(place)
}

/**
 * A submission's ordinal among the person's own: "3-я" in Russian, "3rd" in
 * English.
 *
 * Feminine here, unlike the place: the word it stands for is "посылка", and
 * that one has no gender to guess. The Russian form is the catalog's, the
 * same one the queue says "11-я в очереди" with; English suffixes follow
 * rules a plural form cannot pick, so they are computed.
 */
export function submissionOrdinal(n: number): string {
  if (getLocale() !== 'en') return tr('competitions.p.ordinalN', { count: n })
  return englishOrdinal(n)
}

/** "1st", "2nd", "3rd", "11th", "21st": English picks the suffix by its own rules. */
function englishOrdinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  const mod10 = n % 10
  return `${n}${mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th'}`
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
 * The same time, but as a clock: "10:52", "1:05:00", "6 d 04:12:00".
 *
 * The large figure in the header (P2, P4) is a clock, not words, and that is
 * not taste: it changes in plain sight, and "1 h 12 min" → "1 h 11 min"
 * changes the width of the line, while `1:12:00` → `1:11:59` does not.
 *
 * Seconds are always there, and that is the whole point. The clock used to be
 * hours and minutes, so eleven minutes before the deadline it read "00:11",
 * and at the rehearsal (29 Sep 2026) the class read that as eleven seconds.
 * Now a clock with one colon is minutes and seconds, and hours bring a second
 * colon — the same shape as a run's stopwatch (`elapsedClock`), which the
 * person watches on the same page.
 *
 * Rounded up: "00:00" means the deadline has come, so the last second before
 * it still reads "00:01".
 */
export function remainingClock(ms: number): string {
  if (ms <= 0) return '00:00'
  const total = Math.ceil(ms / SECOND)
  const days = Math.floor(total / (DAY / SECOND))
  if (days === 0) return elapsedClock(total * SECOND)
  const rest = total % (DAY / SECOND)
  const clock = `${pad(Math.floor(rest / 3600))}:${pad(Math.floor((rest % 3600) / 60))}:${pad(rest % 60)}`
  return tr('competitions.p.durClockDays', { days, clock })
}

/**
 * How often the competition page's clock ticks, in milliseconds.
 *
 * Every second while the header counts down to a deadline — the countdown
 * shows seconds, and at a slower tick they would jump by thirty and the timer
 * would look broken exactly in the last hour, when people watch it — and
 * while a run's stopwatch is on screen. Half a minute otherwise: then the
 * only thing that moves is "Today at 18:40".
 *
 * `deadlineAt` is the deadline the header counts down to, or null when it
 * shows no countdown (no deadline, or submissions already closed).
 */
export function clockStep(running: boolean, deadlineAt: number | null, now: number): number {
  if (running) return SECOND
  if (deadlineAt !== null && deadlineAt > now) return SECOND
  return 30 * SECOND
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

/**
 * "The limit resets at 00:00 GMT+3." — after the day's limit, in the zone the
 * server counts days in, named, because the reader's phone may be set to any
 * other: "tomorrow" without a zone was three different moments in one class.
 * An empty string when the server said nothing (no limit, an older server);
 * the reader's own clock when this browser does not know the zone.
 */
export function quotaResetWords(resetsAt: number | null | undefined, zone: string | null | undefined): string {
  const time = resetClock(resetsAt, zone)
  return time ? tr('competitions.p.quotaResets', { time }) : ''
}

/** "00:00 GMT+3" — the next midnight of the server's day; '' when the server named none. */
function resetClock(resetsAt: number | null | undefined, zone: string | null | undefined): string {
  if (resetsAt === null || resetsAt === undefined || !Number.isFinite(resetsAt)) return ''
  return (zone ? zonedClock(resetsAt, zone, getLocale()) : null) ?? clockOf(resetsAt)
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

/* ------------------------------------------- own numbers and the quota */

/**
 * Each submission's number among the person's OWN, oldest first: the "3rd"
 * that "My submissions" leads with, next to the competition-wide "#28".
 *
 * The "#" is the competition's counter, shared by the whole class, so one
 * person's list reads "#8, #27, #28" — and at the rehearsal (29 Sep 2026)
 * five students asked where their other submissions went. The order is the
 * list's own (accepted, then number), so the ordinal is the row's place from
 * the bottom; replaced and cancelled rows keep theirs, being rows of the list.
 */
export function ownOrdinals(
  submissions: readonly Pick<EntrantSubmission, 'id' | 'acceptedAt' | 'number'>[],
): Map<string, number> {
  const oldestFirst = [...submissions].sort((a, b) => a.acceptedAt - b.acceptedAt || a.number - b.number)
  return new Map(oldestFirst.map((submission, index) => [submission.id, index + 1]))
}

/**
 * Whether a finished submission left the day's limit untouched — the "limit
 * not spent" beside its number (C1, C3).
 *
 * The rule itself is `countsTowardDailyQuota`, the one the server refuses by
 * and the leaderboard counts by; here it only decides when saying so is worth
 * a word. Not while the submission is in flight: a waiting one does hold a
 * place in the quota and gives it back if it fails or is cancelled. Every
 * finished one without a score is free (since 4 Oct 2026).
 * And not without a limit, where there is nothing to count against.
 */
export function outsideQuota(
  submission: Pick<EntrantSubmission, 'acceptedAt' | 'state'>,
  perDay: number,
): boolean {
  return perDay > 0 && isTerminal(submission.state) && !countsTowardDailyQuota(submission)
}

/**
 * What the send box says before the click under scoring "last": "If this
 * submission gets a score, it counts instead of #28 (0.8255)". Null under any
 * other rule, or while nothing of the person's counts yet.
 *
 * Under "last" a new notebook that reaches a number takes the counted one's
 * place even with a worse number. The rule is on purpose — the class lives
 * with its last word — but found out on the leaderboard it reads as a result
 * that went missing. Which submission counts is `countedSubmission`, the same
 * call the leaderboard is built with, not a guess of its own.
 */
export function lastScoringNote(
  competition: Pick<CompetitionPublic, 'scoring' | 'metric'>,
  submissions: readonly EntrantSubmission[],
): string | null {
  if (competition.scoring !== 'last') return null
  const counted = countedSubmission('last', submissions, competition.metric.direction)
  if (!counted) return null
  return tr('competitions.p.lastReplaces', { number: counted.number, score: formatScore(counted.publicScore) })
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
 *
 * A stop inside quotes is not one: the quotes hold the participant's own
 * data. The column to_csv() adds for the index is “Unnamed: 0”, and cut at
 * its colon, the title ended in the middle of the name.
 */
export function splitError(text: string | null): { head: string; rest: string } {
  const value = (text ?? '').trim()
  if (!value) return { head: '', rest: '' }
  let quoted = 0
  for (let at = 0; at < value.length - 1; at++) {
    const char = value[at]
    if (char === '«' || char === '“') quoted += 1
    else if ((char === '»' || char === '”') && quoted > 0) quoted -= 1
    else if (quoted === 0 && '.!?:'.includes(char) && /\s/.test(value[at + 1])) {
      return { head: value.slice(0, at + 1).trim(), rest: value.slice(at + 1).trim() }
    }
  }
  return { head: value, rest: '' }
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
 *
 * "Limit not spent" is not a caption any more: it stands under the number in
 * its own colour (C1), where the eye that checks "did this cost me one" looks.
 *
 * A LATE submission says so where nothing else on the row does (C1, C3): a
 * scored one carries the "after the deadline · not counted" chip on a desktop,
 * so its caption stays as it was, and a failed one has no chip — nothing of it
 * counts anyway — so "after the deadline" follows its time instead. The phone
 * has a LATE badge on every late card, and spells "not counted" only under a
 * score, the one thing a person might take for a result in the standings.
 */
export function rowWords(input: RowInput): RowWords {
  return outcomeWords(input)
}

function outcomeWords(input: RowInput): RowWords {
  const { submission, live, now } = input
  const file = submission.fileName
  const late = !!submission.late && isTerminal(submission.state)
  /** When it was sent — and, for a late one without a chip, that it was after the deadline. */
  const stamp =
    whenWords(submission.acceptedAt, now) +
    (late && submission.state !== 'scored' && !input.phone ? ` · ${tr('competitions.p.afterDeadline')}` : '')
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
      const parts = [stamp]
      if (!input.phone) {
        parts.push(
          input.best
            ? spellDuration(submission.durationMs)
            : tr('competitions.p.doneIn', { duration: spellDuration(submission.durationMs) }),
        )
      }
      if (input.best) parts.push(tr('competitions.p.best'))
      if (late && input.phone) parts.push(tr('competitions.p.afterDeadline'), tr('competitions.p.notCounted'))
      return { title: file, lines: [parts.join(' · ')] }
    }
    case 'notebookFailed': {
      // A blind card on a phone says the cell in its own mono line
      // (blindCellLine, C3): here only when it was sent.
      if (input.phone && submission.blind) return { title: file, lines: [stamp] }
      const head = [stamp]
      if (submission.cellsTotal > 0) {
        head.push(
          tr('competitions.p.failedAtCell', {
            cell: Math.max(1, submission.cellsDone),
            cells: submission.cellsTotal,
            duration: spellDuration(submission.durationMs),
          }),
        )
      }
      // The class of the exception, from the server's short list (never the
      // traceback's own word): "KeyError" is half the diagnosis, and on a
      // blind run it is all the diagnosis there is.
      if (submission.errorType) head.push(submission.errorType)
      return { title: file, lines: [head.join(' · ')] }
    }
    case 'timedOut': {
      const head = [stamp]
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
      const first = [stamp, file]
      if (!input.phone) first.push(spellDuration(submission.durationMs))
      const lines = [first.join(' · ')]
      if (rest && !input.phone) lines.push(rest)
      return { title: head || file, lines: input.phone && head ? [] : lines }
    }
    case 'outOfMemory': {
      const lines = [stamp]
      if (submission.participantError && !input.phone) lines.push(submission.participantError)
      return { title: file, lines }
    }
    case 'metricFailed':
      return {
        title: file,
        lines: [stamp, metricFailedNote()],
      }
    case 'cancelled':
      return {
        title: file,
        lines: [
          `${stamp} · ${
            submission.replacedBy != null
              ? tr('competitions.p.replacedNote', { number: submission.replacedBy })
              : tr('competitions.p.cancelledNote')
          }`,
        ],
      }
  }
}

/**
 * The badge of a row in "My submissions".
 *
 * A replaced submission is `cancelled` in the database (it never ran and does
 * not count against the day), but "CANCELLED" would tell its author they
 * pressed something they did not: the newer notebook took its place.
 */
export function submissionBadge(submission: Pick<EntrantSubmission, 'state' | 'replacedBy'>): SubmissionBadge | null {
  if (submission.state === 'cancelled' && submission.replacedBy != null) {
    return { word: tr('competitions.entrant.replaced'), tone: 'neutral', form: 'outline' }
  }
  return entrantBadge(submission.state)
}

/* ------------------------------------------------------- the day's limit */

/** What the send box knows about the day: the server's answer, as it came. */
export type QuotaState = Pick<EntrantSubmissions, 'leftToday' | 'perDay' | 'resetsAt' | 'dayZone' | 'failedAttempts'>

/**
 * The first line under the drop zone (C1): "Only scored submissions spend the
 * limit — 3 of 5 left today, resets at 00:00 GMT+3."
 *
 * The rule LEADS, ahead of the number, since 4 Oct 2026: a failure stopped
 * costing a submission, and a count that does not go down after a crash reads
 * as a bug unless the sentence that holds it says why first. Spent, it is the
 * door's own refusal with the reset after it; without a limit, one sentence
 * that there is none.
 */
export function quotaLead(quota: QuotaState): string {
  if (quota.leftToday === null) return tr('competitions.p.dropNoLimit')
  const time = resetClock(quota.resetsAt, quota.dayZone)
  if (quota.leftToday <= 0) {
    return [tr('competitions.refusal.dailyQuota', { count: quota.perDay }), quotaResetWords(quota.resetsAt, quota.dayZone)]
      .filter(Boolean)
      .join(' ')
  }
  const params = { count: quota.leftToday, perDay: quota.perDay }
  return time ? tr('competitions.p.quotaLeadResets', { ...params, time }) : tr('competitions.p.quotaLead', params)
}

/**
 * The same on a phone, where the box has room for one paragraph (C3): the
 * count first, its reset, and the rule in a short sentence after it.
 */
export function phoneQuota(quota: QuotaState): string {
  if (quota.leftToday === null) return tr('competitions.p.dropNoLimit')
  const resets = quotaResetWords(quota.resetsAt, quota.dayZone)
  if (quota.leftToday <= 0) {
    return [tr('competitions.refusal.dailyQuota', { count: quota.perDay }), resets].filter(Boolean).join(' ')
  }
  return [
    tr('competitions.p.phoneLeftToday', { count: quota.leftToday, perDay: quota.perDay }),
    resets,
    tr('competitions.p.quotaShort'),
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The cells of the meter beside the lead (C1): one per submission of the day,
 * filled while it is still left. Null past ten a day — thirty cells are a
 * texture, not a count — and without a limit; the words beside it stay.
 */
export function quotaCells(leftToday: number | null, perDay: number): boolean[] | null {
  if (leftToday === null || !Number.isFinite(perDay) || perDay <= 0 || perDay > 10) return null
  return Array.from({ length: Math.floor(perDay) }, (_, index) => index < leftToday)
}

/** "3 of 5 left" under the meter. */
export function quotaMeterWords(leftToday: number, perDay: number): string {
  return tr('competitions.p.quotaMeter', { count: Math.max(0, leftToday), perDay })
}

/**
 * The quiet line about the ceiling on FAILED submissions (C1): "Failed
 * attempts: at most 15 a day; 3 today." Never worded as the limit — failures
 * do not spend it, and the two sitting side by side are told apart by their
 * names. Empty without a ceiling (no limit at all).
 */
export function attemptsNote(failed: FailedAttempts | null | undefined): string {
  if (!failed) return ''
  return failed.used > 0
    ? tr('competitions.p.attemptsNoteUsed', { ceiling: failed.ceiling, used: failed.used })
    : tr('competitions.p.attemptsNote', { ceiling: failed.ceiling })
}

/** The ceiling is reached: the box stops taking notebooks until midnight. */
export function attemptsExhausted(failed: FailedAttempts | null | undefined): boolean {
  return !!failed && failed.used >= failed.ceiling
}

/**
 * What the box says once the ceiling is reached — the door's own refusal
 * (`reason: 'attempts'`, routes/competitions.ts · attemptsWords) said BEFORE
 * the click, with the moment the count of failures starts over. Empty while
 * there is room.
 */
export function attemptsSpentWords(
  failed: FailedAttempts | null | undefined,
  resetsAt: number | null | undefined,
  zone: string | null | undefined,
): string {
  if (!failed || !attemptsExhausted(failed)) return ''
  const time = resetClock(resetsAt, zone)
  return [
    tr('competitions.refusal.dailyAttempts', { count: failed.ceiling }),
    time ? tr('competitions.p.attemptsResets', { time }) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The footer of a failed run's details (C1): "This attempt did not spend the
 * limit — 3 of 5 left today". Empty without a limit, where there is nothing
 * it could have spent.
 */
export function attemptFreeWords(leftToday: number | null, perDay: number): string {
  if (!Number.isFinite(perDay) || perDay <= 0) return ''
  return leftToday === null
    ? tr('competitions.p.attemptFree')
    : tr('competitions.p.attemptFreeLeft', { count: Math.max(0, leftToday), perDay })
}

/* ------------------------------------------------- after the deadline */

/** "today", "yesterday", "03.10" — the day of a moment, as it reads in the middle of a line. */
export function dayWord(at: number, now: number): string {
  if (sameDay(at, now)) return tr('competitions.p.dayToday')
  if (sameDay(at, now - DAY)) return tr('competitions.p.dayYesterday')
  return dateOf(at)
}

/**
 * The deadline that has passed, as day and clock; null when there is none to
 * name: no deadline, or intake was ended early by «Завершить сейчас» and the
 * deadline itself is still ahead — "the deadline passed" would be untrue.
 */
export function passedDeadline(deadlineAt: number | null, now: number): { day: string; time: string } | null {
  if (deadlineAt === null || deadlineAt > now) return null
  return { day: dayWord(deadlineAt, now), time: clockOf(deadlineAt) }
}

/**
 * The line between late and on-time rows of "My submissions" (C1, C3):
 * "DEADLINE · TODAY 12:00", or the bare word when the moment cannot be named.
 */
export function deadlineDividerWords(deadlineAt: number | null, now: number): string {
  const passed = passedDeadline(deadlineAt, now)
  return passed
    ? tr('competitions.p.deadlineDivider', { when: `${passed.day} ${passed.time}` })
    : tr('competitions.p.deadlineDividerBare')
}

/**
 * Where that line goes in a list sorted newest first: before the first
 * on-time row, when late ones stand above it. -1 — no late rows on top, or
 * nothing on time below them, and a line "below: sent on time" over nothing
 * would point at an empty space.
 */
export function deadlineSplit(rows: readonly Pick<EntrantSubmission, 'late'>[]): number {
  const first = rows.findIndex((row) => !row.late)
  return first > 0 ? first : -1
}

/**
 * Under a late scored row (C1): "Better than the counted #14 by 0.0057, but it
 * changes neither the place nor what counts." Said only when it IS better —
 * that is the case a person reads as a lost result. Null otherwise.
 */
export function lateBetterNote(
  submission: Pick<EntrantSubmission, 'late' | 'state' | 'publicScore'>,
  counted: Pick<EntrantSubmission, 'number' | 'publicScore'> | null,
  direction: MetricDirection,
): string | null {
  if (!submission.late || submission.state !== 'scored' || !counted) return null
  if (!hasScore(submission.publicScore) || !hasScore(counted.publicScore)) return null
  const gain = direction === 'lower' ? counted.publicScore - submission.publicScore : submission.publicScore - counted.publicScore
  if (!(gain > 0)) return null
  return tr('competitions.p.lateBetter', { number: counted.number, delta: formatScore(gain) })
}

/**
 * One's best LATE public score — what the mini leaderboard says is not on it
 * (C1). By the board's own comparison; null when no late one scored.
 */
export function bestLateScore(
  submissions: readonly Pick<EntrantSubmission, 'late' | 'state' | 'publicScore' | 'acceptedAt'>[],
  direction: MetricDirection,
): number | null {
  let best: { score: number; at: number } | null = null
  for (const submission of submissions) {
    if (!submission.late || submission.state !== 'scored' || !hasScore(submission.publicScore)) continue
    const next = { score: submission.publicScore, at: submission.acceptedAt }
    if (!best || compareScores(next, best, direction) < 0) best = next
  }
  return best?.score ?? null
}

/**
 * Whether the page is past intake for the standings — closed, or taking late
 * notebooks only. The final results, the counting banner and the closed pick
 * all hang on this, not on the door being shut.
 */
export function standingsClosed(accepting: Accepting): boolean {
  return accepting === 'closed' || accepting === 'late'
}

/* ------------------------------------------------------- the hidden test */

/** The hidden file the words talk about, with the counts that make the point. */
export interface SealedTarget {
  /** `data/test.csv` — the path the notebook reads. */
  file: string
  rows: number | null
  /** Rows of the open example it replaces; null — none, or not counted. */
  exampleRows: number | null
  /** It stands in for an example of the same name (otherwise it is a name new to `data/`). */
  replaces: boolean
}

/**
 * Which hidden file to name: the first that stands in for an example — the
 * usual "test.csv is the hidden test" — or else the first one. Null without a
 * hidden test, and then nothing on the page mentions one.
 */
export function sealedTarget(view: Pick<EntrantCompetitionView, 'files' | 'sealedFiles'>): SealedTarget | null {
  const sealed = view.sealedFiles ?? []
  const pick = sealed.find((file) => file.replaces !== null) ?? sealed[0]
  if (!pick) return null
  const example = pick.replaces === null ? null : (view.files.find((file) => file.name === pick.replaces) ?? null)
  return {
    file: `data/${pick.name}`,
    rows: pick.rows,
    exampleRows: example?.rows ?? null,
    replaces: pick.replaces !== null,
  }
}

/** "2 140 rows" — a row count in words, with the digits grouped. */
export function rowsWords(rows: number): string {
  return tr('competitions.p.rows', { count: rows, n: formatNumber(rows) })
}

/** The cell a failed notebook stopped at, by the count the caption uses; null — it did not fail in a cell. */
function failedCell(submission: Pick<EntrantSubmission, 'state' | 'cellsDone' | 'cellsTotal'>): number | null {
  return submission.state === 'notebookFailed' && submission.cellsTotal > 0 ? Math.max(1, submission.cellsDone) : null
}

/**
 * The first line of a blind run's details (C1): "Checked on the hidden test:
 * cell 12 · ValueError · output hidden". Built from the row's own numbers and
 * the server's allow-listed exception class, never from text the notebook
 * produced: on the hidden test that text may carry its rows.
 */
export function blindHead(submission: Pick<EntrantSubmission, 'state' | 'cellsDone' | 'cellsTotal' | 'errorType'>): string {
  const cell = failedCell(submission)
  if (cell === null) return tr('competitions.p.blindHead')
  const where = [tr('competitions.p.blindCell', { cell }), submission.errorType ?? ''].filter(Boolean).join(' · ')
  return tr('competitions.p.blindHeadAt', { where })
}

/** "cell 6 of 12 · ValueError" — the phone card's one mono line for a blind failure (C3). */
export function blindCellLine(submission: Pick<EntrantSubmission, 'state' | 'cellsDone' | 'cellsTotal' | 'errorType'>): string {
  const cell = failedCell(submission)
  const at = cell === null ? '' : tr('competitions.p.blindCellOf', { cell, cells: submission.cellsTotal })
  return [at, submission.errorType ?? ''].filter(Boolean).join(' · ')
}

/**
 * Why the details are missing, and what to try (C1): the hidden test's rows
 * against the example's — the difference a notebook fitted to the example
 * trips on — and, for a failed cell, the advice to run that cell on the
 * example and look for counts and ids it relies on.
 */
export function blindWhy(
  submission: Pick<EntrantSubmission, 'state' | 'cellsDone' | 'cellsTotal'>,
  target: SealedTarget | null,
): string {
  const why = !target || !target.replaces
    ? tr('competitions.p.blindWhy')
    : target.rows !== null && target.exampleRows !== null
      ? tr('competitions.p.blindWhyRows', {
          file: target.file,
          rows: rowsWords(target.rows),
          example: formatNumber(target.exampleRows),
        })
      : tr('competitions.p.blindWhyFile', { file: target.file })
  const cell = failedCell(submission)
  return cell === null ? why : `${why} ${tr('competitions.p.blindHint', { cell })}`
}

/**
 * "during the check it is swapped for the hidden test (2 000 rows) at the
 * same path" — under the example in the data list (C3).
 */
export function sealedSwapWords(rows: number | null): string {
  return rows === null
    ? tr('competitions.p.sealedSwapBare')
    : tr('competitions.p.sealedSwap', { rows: rowsWords(rows) })
}

/**
 * "37 columns: chamber_id, store_id, …" — the example's header, which the
 * hidden test shares. Six names at most: the line says what kind of table it
 * is, the file itself lists the rest.
 */
export function sealedColumnsWords(columns: readonly string[] | null): string {
  if (!columns || columns.length === 0) return ''
  const shown = columns.slice(0, 6).join(', ')
  return tr('competitions.p.sealedColumns', {
    count: columns.length,
    names: columns.length > 6 ? `${shown} …` : shown,
  })
}

/* ----------------------------------------------------------- leaderboard */

/**
 * Places in the table — by PEOPLE, with the baseline wherever it landed.
 *
 * The board ranks the baseline in a row with everyone, and a place counted
 * over that whole row takes people's places. While it is twentieth of
 * twenty-eight (as in the mockup), there is no difference; but in a
 * competition where nobody has beaten the baseline yet, it becomes first, and
 * the person reads "YOUR PLACE 2 of 3" in the header next to a row "3" in the
 * table. Here the baseline stops taking people's places and stands exactly
 * where it would if it were an entrant: after everyone above it, and without
 * a number while nobody is.
 *
 * A place per row, the earlier submission higher between equal scores. The
 * rule is `placesAmongPeople` from `@shared/competitions`, the one the server
 * numbers its answers with, so the header's "YOUR PLACE", the list of
 * competitions and the teacher's screen say the same number as this row.
 *
 * The order of the rows does not change — the server has already computed it
 * by the metric's rule.
 */
export function boardPlaces<T extends { baseline: boolean; score: number }>(
  lines: readonly T[],
): Placed<T, number | null>[] {
  return placesAmongPeople(lines, (line) => line.baseline)
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

/**
 * One letter on the circle — the first letter of the name, as in the mockup
 * ("T"). A Telegram name is stored as `@login` (shared/competitions.ts ·
 * entrantHandle), and its `@` is punctuation, not a letter: without skipping
 * it every such circle on the leaderboard would read "@".
 *
 * Other people's addresses arrive shortened (`iva…@hse.ru`, maskEntrantName),
 * and the letter is looked for before the `@` first: the local part keeps its
 * first characters, so the circle says "I" to everyone, the owner included,
 * who sees `ivanov@hse.ru` whole. Only a local part with no letter in what is
 * left of it (`_…@hse.ru`) falls back to the domain's.
 */
export function avatarLetter(name: string): string {
  const trimmed = name.trim()
  const letter = (text: string) => [...text].find((char) => /[\p{L}\p{N}]/u.test(char))
  const at = trimmed.lastIndexOf('@')
  const first = (at > 0 ? letter(trimmed.slice(0, at)) : undefined) ?? letter(trimmed)
  return first ? first.toUpperCase() : '?'
}

/** "Timur A." — how the person is labelled in the phone header. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return name.trim()
  return `${parts[0]} ${[...parts[1]][0].toUpperCase()}.`
}
