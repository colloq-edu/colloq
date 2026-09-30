/**
 * Removing a participant from a competition: the teacher's "Delete" in the
 * list of people.
 *
 * WHY IT EXISTS. An entrant's name is a Telegram username or an email (the
 * owner's rule, shared/competitions.ts · entrantHandle), and a student who
 * asks a university to erase them has to be erasable: rows, results and every
 * file the server keeps about their work. Before this there was no way to
 * remove an entrant at all, only to disable their key.
 *
 * WHAT GOES. Everything the person left in THIS competition: submissions with
 * their runs and queue rows, the enrollment, prepared package sets and
 * drafts, and on disk the notebooks as sent, the executed copies with their
 * outputs, the answers, the attempts' leftovers, the sets' directories. The
 * person themselves (their identity and key) goes too, unless they take part
 * in another competition: there their key must keep working, and their other
 * results are not this teacher's to remove.
 *
 * WHAT STAYS. Wheel files shared through the content-addressed cache: other
 * sets may link the same wheel, and the dependency sweep removes the ones
 * nobody links any more. They are public packages, not anybody's work.
 *
 * A RUN IN PROGRESS. Waiting submissions leave the queue first, in the same
 * turn of the event loop the check happens in, so the pump cannot start them
 * meanwhile. A running one is killed the way "Kill" kills it, and the
 * removal waits for the run to finish writing (runner.ts · settleSubmission);
 * if it does not within half a minute, nothing is removed (the waiting ones
 * stay cancelled) and the teacher is told to try again. A run of a previous
 * life of the server, not reclaimed yet, refuses the removal before anything
 * is touched. The last check is inside the transaction that removes the rows,
 * so a run that started in between refuses the whole removal rather than
 * being cut in half.
 */
import { dependencyActive } from '@shared/dependencies'
import { db } from '../db.js'
import { cancelPreparation } from '../dependencies/service.js'
import { listBundles, removeEntrantDependencies } from '../dependencies/store.js'
import { removeBundleFiles, removeStaging } from '../dependencies/files.js'
import { cancelSubmission, runningHere, settleSubmission } from './runner.js'
import {
  getCompetition,
  getEntrant,
  leaveQueue,
  queueRows,
  removeEntrantRows,
  takesPart,
  updateSubmission,
  type EntrantRemoval,
} from './store.js'
import { competitionsFs, removeSubmission, submissionDir } from './storage.js'
import { tr } from '@shared/i18n'

/** How long the removal waits for a killed run to finish writing. */
export const SETTLE_MS = 30_000

/** Thrown inside the removal's transaction to roll back what it already did. */
class RunStarted extends Error {}

export type EntrantDeletion =
  | {
      ok: true
      /** How many submissions went. */
      submissions: number
      /** The identity and its key went too: the person took part nowhere else. */
      identityRemoved: boolean
    }
  | { ok: false; why: 'not_found' | 'baseline' | 'running' }

export async function deleteEntrantFromCompetition(
  competitionId: string,
  entrantId: string,
  settleMs = SETTLE_MS,
): Promise<EntrantDeletion> {
  const competition = getCompetition(competitionId)
  if (!competition || !getEntrant(entrantId) || !takesPart(competitionId, entrantId)) {
    return { ok: false, why: 'not_found' }
  }
  /*
   * The service entrant the sample notebook runs under is not a person, and
   * the competition's readiness to open rests on its run.
   */
  if (competition.baselineEntrantId === entrantId) return { ok: false, why: 'baseline' }

  const mine = queueRows().filter((row) => row.competitionId === competitionId && row.entrantId === entrantId)
  // A run of a previous life of the server is nobody's here to kill or to
  // wait for until the queue reclaims it: refused before anything is touched
  // (ordering its cancellation would only leave a note that cancels its next,
  // legitimate run).
  if (mine.some((row) => row.state === 'running' && !runningHere(row.submissionId))) {
    return { ok: false, why: 'running' }
  }
  // Waiting work leaves the queue at once, before the first await below: the
  // pump must not start it while a running one is being taken down. Marked
  // cancelled, so that a removal refused later leaves no submission waiting
  // for a queue row it no longer has.
  for (const row of mine) {
    if (row.state !== 'waiting') continue
    leaveQueue(row.submissionId)
    updateSubmission(row.submissionId, {
      state: 'cancelled',
      stage: 'queue',
      teacherError: tr('competitions.answer.killedByTeacher'),
    })
  }
  for (const row of mine) {
    if (row.state !== 'running') continue
    if (!(await cancelSubmission(row.submissionId, 'teacher'))) {
      // Too late to cancel means it already ended; anything else means no
      // runtime to take it down, and then there is nothing to wait for.
      if (queueRows().some((one) => one.submissionId === row.submissionId && one.state === 'running')) {
        return { ok: false, why: 'running' }
      }
    }
    if (!(await settleSubmission(row.submissionId, settleMs))) return { ok: false, why: 'running' }
  }
  // A package set still being prepared stops working now rather than
  // publishing into a row this removal takes (it would notice and clean up
  // after itself, but only after a full download).
  for (const bundle of listBundles(competitionId, entrantId)) {
    if (dependencyActive(bundle.state)) await cancelPreparation(bundle.id).catch(() => undefined)
  }

  /*
   * One transaction for both owners' rows. The package sets go first: once
   * the person's row is gone the cascades would take the sets too, and with
   * them the ids their directories are found by. A run that started since
   * the checks above refuses the whole of it, sets included.
   */
  let outcome: (EntrantRemoval & { bundles: string[] }) | 'running'
  try {
    outcome = db.transaction(() => {
      const bundles = removeEntrantDependencies(entrantId, competitionId)
      const removed = removeEntrantRows(competitionId, entrantId)
      if (removed === 'running') throw new RunStarted()
      return { ...removed, bundles }
    })()
  } catch (error) {
    if (!(error instanceof RunStarted)) throw error
    outcome = 'running'
  }
  if (outcome === 'running') return { ok: false, why: 'running' }

  /*
   * The files go after the commit, the same order as deleting a competition:
   * a directory removed for rows that then rolled back would be a result
   * without its notebook. A directory that fails to go is said out loud,
   * without a name, and the rest still go.
   */
  let failures = 0
  for (const id of outcome.submissionIds) {
    // `removeSubmission` answers false both for "failed" and for "was never
    // there" (a pruned submission); the disk itself tells them apart.
    removeSubmission(competitionId, id)
    if (competitionsFs.existsSync(submissionDir(competitionId, id))) failures++
  }
  for (const id of outcome.bundles) {
    try {
      removeBundleFiles(id)
      removeStaging(id)
    } catch {
      failures++
    }
  }
  if (failures) console.warn(`[competitions] removing a participant left ${failures} director(ies) on disk`)
  return { ok: true, submissions: outcome.submissionIds.length, identityRemoved: outcome.identityRemoved }
}
