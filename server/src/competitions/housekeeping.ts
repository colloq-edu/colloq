/**
 * The sweep of old submission files — `pruneCompetitionFiles`, finally with a
 * caller.
 *
 * Every submission leaves a directory: the notebook as sent, the executed
 * copy with its outputs, the answer (storage.ts). The numbers live in the
 * database forever; the directories were meant to go "for a competition
 * closed long ago", and nothing ever sent them, so the disk that also holds
 * the database and every class's notebooks grew by a few megabytes a
 * submission until the competition itself was deleted.
 *
 * WHICH COMPETITIONS. Only those whose intake has been over for a week:
 * finished by hand, or past their deadline — and with «Поздние посылки» off:
 * late intake is intake too. During intake nothing is removed, and not out of caution for its own sake: "rescore everyone" after
 * a metric fix reads every stored answer, and an answer swept away mid-course
 * would leave that submission with a number from the old metric beside
 * numbers from the new one. A week after the end, the review is over and the
 * students have downloaded what they wanted.
 *
 * WHAT IN THEM. The store decides (store.ts · pruneCompetitionFiles): the
 * boards' submissions, the chosen ones, the sample notebook's run and each
 * person's ten latest stay; the rest go.
 *
 * NEVER UNDER A RUN. A competition with anything in the queue — a late result
 * still being counted, a teacher's rerun, a rescore of everyone — is left for
 * the next round, whole: the check and the removal happen in one turn of the
 * event loop, so no run can start between them.
 *
 * At start (a minute after, not in the middle of the startup's own work) and
 * every six hours. The log says how many and how much, never whose.
 */
import type { Competition } from '@shared/competitions'
import { lastLateSubmissionAt, listCompetitions, pruneCompetitionFiles, queueRows } from './store.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long after intake ends a competition's old files stay whole. */
export const PRUNE_AFTER_MS = 7 * DAY
/** The first round, after start; then one every `SWEEP_EVERY_MS`. */
const FIRST_SWEEP_AFTER_MS = MINUTE
const SWEEP_EVERY_MS = 6 * HOUR

/**
 * When the competition stopped taking submissions, or null while it still
 * takes them (or never did: a draft).
 *
 * A competition past its deadline stays `live` until someone presses "Finish",
 * and many never do, so the deadline counts as the end by itself. One
 * finished early ended when it was finished — `updatedAt`, which a later edit
 * moves forward, and that only delays the sweep.
 *
 * With «Поздние посылки» on, intake never ended: late submissions keep
 * arriving, and their authors are dealing with them now. Once the switch is
 * off, the end is no earlier than the last late submission (`lastLateAt`):
 * the week starts from the last thing anyone sent.
 */
export function intakeEndedAt(
  competition: Pick<Competition, 'state' | 'deadlineAt' | 'updatedAt' | 'lateSubmissions'>,
  now: number,
  lastLateAt: number | null = null,
): number | null {
  if (competition.state === 'draft' || competition.lateSubmissions) return null
  let ended: number | null
  if (competition.state === 'finished') {
    ended = competition.deadlineAt === null ? competition.updatedAt : Math.min(competition.updatedAt, competition.deadlineAt)
  } else {
    ended = competition.deadlineAt !== null && competition.deadlineAt <= now ? competition.deadlineAt : null
  }
  return ended === null || lastLateAt === null ? ended : Math.max(ended, lastLateAt)
}

export interface SweepReport {
  /** Competitions something was removed from. */
  competitions: number
  /** Competitions left for the next round because something of theirs is queued or running. */
  busy: number
  /** Submission directories removed, and what they weighed. */
  removed: number
  bytes: number
}

/**
 * One round of the sweep. A competition at a time, with a turn of the event
 * loop between them: the first round on an instance with a year of
 * competitions behind it removes thousands of directories, and the class
 * running next to it must not feel that as a frozen page.
 */
export async function sweepOldSubmissions(now = Date.now()): Promise<SweepReport> {
  const report: SweepReport = { competitions: 0, busy: 0, removed: 0, bytes: 0 }
  for (const competition of listCompetitions()) {
    const ended = intakeEndedAt(competition, now, lastLateSubmissionAt(competition.id))
    if (ended === null || now - ended < PRUNE_AFTER_MS) continue
    // The queue is read in the same turn as the removal below: nothing can
    // take work between the look and the sweep.
    if (queueRows().some((row) => row.competitionId === competition.id)) {
      report.busy++
      continue
    }
    const swept = pruneCompetitionFiles(competition.id)
    if (swept.removed > 0) report.competitions++
    report.removed += swept.removed
    report.bytes += swept.bytes
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (report.removed > 0) {
    console.log(
      `[competitions] swept old submission files: ${report.removed} submission(s) in ${report.competitions} ended competition(s), ` +
        `${size(report.bytes)} freed${report.busy ? `; ${report.busy} competition(s) left for later, work still queued` : ''}`,
    )
  }
  return report
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

let first: NodeJS.Timeout | null = null
let timer: NodeJS.Timeout | null = null
let sweeping: Promise<unknown> | null = null

function round(): void {
  // Never two rounds at once: a slow disk must not stack them.
  if (sweeping) return
  sweeping = sweepOldSubmissions()
    .catch((error: unknown) => console.warn('[competitions] the sweep of old submission files failed:', error instanceof Error ? error.message : error))
    .finally(() => { sweeping = null })
}

/** Start the rounds; the timers do not keep the process alive. Idempotent. */
export function startSubmissionSweep(): void {
  if (timer) return
  first = setTimeout(round, FIRST_SWEEP_AFTER_MS)
  first.unref?.()
  timer = setInterval(round, SWEEP_EVERY_MS)
  timer.unref?.()
}

/** Stop the rounds and wait for one in progress. */
export async function stopSubmissionSweep(): Promise<void> {
  if (first) clearTimeout(first)
  if (timer) clearInterval(timer)
  first = null
  timer = null
  await sweeping
}
