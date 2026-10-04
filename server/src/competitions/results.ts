/**
 * The deadline from the side of the queue: which uploads still make it, and
 * when the final results may open.
 *
 * THE DEADLINE IS JUDGED BY THE MOMENT AN UPLOAD BEGAN. Twenty megabytes over
 * a classroom's Wi-Fi take a minute, and a notebook sent at 23:59:50 must not
 * lose to the connection it was sent over. The route records when the request
 * arrived and both checks (before the body and in the intake transaction) look
 * at that moment — but the body must arrive within two minutes after the
 * deadline, otherwise the grace would become a way around it.
 *
 * THE FINAL RESULTS WAIT FOR THE QUEUE. At the deadline thirty notebooks may
 * still be waiting, and their private numbers are the final table. The
 * automatic release waits until every submission accepted before the
 * deadline (and every upload still arriving) has a result; the teacher's
 * manual reveal does not wait — that is their call to make.
 */
import { privateBoardAwaits, privateBoardOpen, type Competition } from '@shared/competitions'
import { pendingResultsCount } from './store.js'

/** How long after the deadline an upload that began before it may still finish arriving. */
export const DEADLINE_GRACE_MS = 120_000

/** The body arrived too late: the upload began in time, but the grace is over. */
export function pastGrace(c: Pick<Competition, 'deadlineAt'>, now: number): boolean {
  return c.deadlineAt !== null && now > c.deadlineAt + DEADLINE_GRACE_MS
}

/* ------------------------------------------------------ uploads in flight */

/**
 * Uploads whose request has arrived and whose body has not been accepted or
 * refused yet, per competition.
 *
 * In memory on purpose: an upload is a live connection, and a server restart
 * cuts it anyway — there is nothing to recover. After the deadline these are
 * exactly the uploads that began before it (new ones are refused at the
 * door, or taken as late ones, which the door never holds: a late result is
 * in no table), so they count as results still to come.
 */
const uploading = new Map<string, number>()

/** Count an upload in; the returned function counts it out, once, however the request ends. */
export function holdUpload(competitionId: string): () => void {
  uploading.set(competitionId, (uploading.get(competitionId) ?? 0) + 1)
  let held = true
  return () => {
    if (!held) return
    held = false
    const left = (uploading.get(competitionId) ?? 1) - 1
    if (left > 0) uploading.set(competitionId, left)
    else uploading.delete(competitionId)
  }
}

export function uploadsInProgress(competitionId: string): number {
  return uploading.get(competitionId) ?? 0
}

/* --------------------------------------------------------- private board */

/**
 * Whether the private board is open, and how many results it still waits for.
 *
 * The count covers submissions still queued or running that were accepted by
 * the end of the grace (a rescore of an old one counts too: its private number
 * is changing right now) plus uploads still arriving. Counted only while the
 * automatic release is actually waiting — before the deadline the answer is
 * "closed" without a query.
 */
export function privateBoardState(c: Competition, now = Date.now()): { open: boolean; pending: number } {
  if (!privateBoardAwaits(c, now)) return { open: privateBoardOpen(c, now), pending: 0 }
  const cutoff = c.deadlineAt === null ? Number.MAX_SAFE_INTEGER : c.deadlineAt + DEADLINE_GRACE_MS
  const pending = pendingResultsCount(c.id, cutoff) + uploadsInProgress(c.id)
  return { open: privateBoardOpen(c, now, pending), pending }
}
