/**
 * Every way a machine's lease ends WITHOUT its result (§3.4, §3.5): an offer
 * nobody acked (withdrawn), a run the machine lost or went silent on (lost),
 * one it refused (declined), one this server took back (revoked: a cancel,
 * an erase, a deletion, the machine disconnected or no longer trusted).
 *
 * EACH IS ONE TRANSACTION, FENCED ON THE ATTEMPT. The lease's state and the
 * queue row's attempt and holder are checked and changed together, so a
 * result arriving in the same millisecond as a loss is applied or refused,
 * never both, and a row is never requeued twice for one attempt. The
 * requeue is markWaiting fenced on attempt_id (store.ts · requeueHeldRow):
 * the row keeps its arrival, its turn and its lateness — a machine's trouble
 * is no reason to send a person to the end of the queue.
 *
 * NONE OF IT SPENDS QUOTA. A requeued submission waits as `queued`; one this
 * server gives up on ends as `metricFailed`, our failure (decision 6), which
 * neither the day's quota nor the failed-attempts ceiling counts
 * (@shared/competitions · countsTowardDailyQuota, countsTowardFailedAttempts).
 *
 * A module that does not import the queue's pump (runner.ts): the pump's own
 * cancel calls cancelRemote, and an import back would close a cycle.
 */
import { tr } from '@shared/i18n'
import {
  REMOTE_DECLINE_LIMIT,
  REMOTE_LOSS_LIMIT,
  REMOTE_QUARANTINE_DECLINES,
  REMOTE_QUARANTINE_LOSSES,
  REMOTE_QUARANTINE_WINDOW_MS,
  type RemoteDeclineReason,
} from '@shared/remote-runner'
import { db } from '../../db.js'
import {
  discardUnstartedRun,
  finishRun,
  leaveHeldRow,
  listRuns,
  queueRow,
  requeueHeldRow,
  updateSubmission,
  type QueueRow,
} from '../store.js'
import {
  OPEN_LEASE_STATES,
  driveInFlight,
  endedLeases,
  getLease,
  getRunner,
  markRunnerLeft,
  openLeases,
  reasonText,
  refusedDecline,
  remoteEvent,
  runnerStanding,
  submissionLeases,
  updateLease,
  updateRunner,
  type LeaseRow,
  type LeaseState,
} from './store.js'
import { wakeAllRunners, wakeRunner } from './wake.js'
import { forgetHeard } from './heard.js'
import { dropAttempt } from '../storage.js'
import { dropStaging } from './upload.js'
import { cutBlobStreams, starvedLease } from './blobs.js'

/** Prometheus' counts of how leases ended (ops/metrics.ts): fixed labels only. */
export const leaseEndings = { withdrawn: 0, lost: 0, declined: 0, revoked: 0, cancelled: 0, failed: 0, orphaned: 0 }

/** Why a run was lost: the teacher's note names it (server.runners.why.*). */
export type LossCause = 'silent' | 'ceiling' | 'missing' | 'refused' | 'declined' | 'unapplied'

const machineName = (runnerId: string): string => getRunner(runnerId)?.name ?? runnerId

/** The queue row of a lease, if the lease still owns it: the same attempt, held by the same machine, running. */
function ownedRow(lease: LeaseRow): QueueRow | null {
  const row = queueRow(lease.submissionId)
  return row && row.state === 'running' && row.attemptId === lease.attemptId && row.holder === lease.runnerId ? row : null
}

/**
 * What the take laid out for the attempt (its result folder, prepareNotebook)
 * and what the machine uploaded for it: neither is anyone's once the lease
 * ended without its outcome. Never fatal — the sweep of a later pass finds
 * what is left (liveness.ts · sweepStaging).
 */
function dropAttemptFiles(lease: LeaseRow): void {
  try {
    dropAttempt(lease.competitionId, lease.submissionId, lease.attemptId)
  } catch {
    // A submission erased meanwhile has no folder left to drop.
  }
  dropStaging(lease.attemptId)
}

/** The run row is finished only once: a cancel after a settle must not overwrite the verdict the settle wrote. */
function runOpen(lease: LeaseRow): boolean {
  return listRuns(lease.submissionId).some((run) => run.id === lease.runId && run.finishedAt === null)
}

/**
 * The submission back in the queue as it was before the take, with our
 * words when its run had started and was cut short (`said`): the numbers the
 * take cleared come back (the neighbour retry does the same, runner.ts ·
 * settleNotebook), and a blind participant may read our sentence as it is.
 */
function backInQueue(lease: LeaseRow, said: { participant: string | null; teacher: string | null }): void {
  const before = lease.prepared.before
  updateSubmission(lease.submissionId, {
    state: 'queued',
    stage: 'queue',
    cellsDone: before.cellsDone,
    cellsTotal: before.cellsTotal,
    durationMs: before.durationMs,
    participantError: said.participant,
    briefError: said.participant,
    teacherError: said.teacher,
  })
}

/**
 * A row this module just put back in the queue is work any other machine can
 * take NOW: their held syncs are woken (wake.ts), as an upload wakes them. A
 * row given back by a machine's own sync (an offer it never received, a run
 * it no longer holds) or by its outcome (a decline, a result that did not
 * match its files) otherwise waited for an idle machine to ask again, up to
 * twenty-five seconds, or for the clock's next pass. Waking inside a
 * transaction is safe: a woken sync recomputes its reply only after this
 * synchronous turn, so after the commit.
 */
function backForOthers(): void {
  wakeAllRunners()
}

/**
 * The submission given up on as our failure (decision 6): metricFailed, which
 * spends no quota. Its numbers are put back as they were before the take, as
 * a run given back to the queue has them (backInQueue): the stage bar and
 * «ячейка 3 из 5» of the run that was lost are no progress of the
 * submission's, and a failure of ours must not read as a notebook that
 * stopped in its third cell.
 */
function serverFailure(lease: LeaseRow, row: QueueRow, participant: string, teacher: string): void {
  leaveHeldRow(row)
  const before = lease.prepared.before
  updateSubmission(lease.submissionId, {
    state: 'metricFailed',
    stage: 'queue',
    cellsDone: before.cellsDone,
    cellsTotal: before.cellsTotal,
    durationMs: before.durationMs,
    participantError: participant,
    briefError: participant,
    teacherError: teacher,
  })
  leaseEndings.failed++
}

/* --------------------------------------------------------------- withdrawn */

/**
 * An offer the machine never acked (§3.4 "Delivery"): no run began, so
 * nothing is counted against anyone. The run row the take started goes, as
 * a run the broker never placed goes (store.ts · discardUnstartedRun), and
 * the submission waits again exactly as before the take.
 */
export const withdrawLease = db.transaction((attemptId: string, now: number, cause: 'unacked' | 'unseen' | 'restart' | LossCause): boolean => {
  const lease = getLease(attemptId)
  if (!lease || lease.state !== 'offered') return false
  const why = tr(`server.runners.why.${cause}`)
  updateLease(attemptId, { state: 'withdrawn', endedAt: now, reason: why, cause }, ['offered'])
  const row = ownedRow(lease)
  if (row) {
    if (requeueHeldRow(row, false)) backForOthers()
    discardUnstartedRun(lease.runId, attemptId)
    backInQueue(lease, { participant: null, teacher: null })
  }
  remoteEvent(lease.runnerId, 'withdrawn', { attemptId, detail: why }, now)
  dropAttemptFiles(lease)
  leaseEndings.withdrawn++
  return true
})

/* -------------------------------------------------------------------- lost */

/**
 * A run the machine lost (§3.4 "Loss accounting"): it went silent past
 * REMOTE_SILENCE_MS with the path to it proven, ran past its ceiling, said
 * it no longer holds the attempt, or sent a result that did not match its
 * uploads.
 *
 * Before its container started the run is refunded: it waits again as if
 * never taken. After, the loss is counted on the row (`lost`), the run row
 * says on which machine it was lost, and the participant reads our words —
 * their notebook did nothing wrong. Lost by REMOTE_LOSS_LIMIT different
 * machines, the submission ends as our failure, spending no quota (decision
 * 6); twice that many losses on any machines end it too, so that a notebook
 * that keeps killing one machine cannot keep a place for ever once the
 * owner resumes that machine after its quarantine.
 *
 * `unapplied` ends a lease whose result came and could not be applied by its
 * ceiling — the drive kept failing (a full disk here) and no drive is in
 * flight (store.ts · driveInFlight). Its container ran, so the loss counts
 * on the row like any after a start, and the row's limits bound how often an
 * unusable result is run again; but it is this server's failure, not the
 * machine's: it is no quarantine of a machine that delivered its result.
 */
export const loseLease = db.transaction((attemptId: string, now: number, cause: LossCause, detail: string | null = null): boolean => {
  const lease = getLease(attemptId)
  const applying = lease?.state === 'applying' && cause === 'unapplied' && !driveInFlight(attemptId)
  if (!lease || !(OPEN_LEASE_STATES.includes(lease.state) || applying)) return false
  if (lease.state === 'offered') return withdrawLease(attemptId, now, cause)
  const machine = machineName(lease.runnerId)
  const why = causeText(cause, detail)
  const teacher = tr('server.runners.lostTeacher', { machine, why })
  updateLease(attemptId, { state: 'lost', endedAt: now, reason: why, cause }, applying ? ['applying'] : ['accepted', 'running'])
  const row = ownedRow(lease)
  if (row) {
    // A result that came had a container behind it, whether or not a sync ever said it started.
    if (lease.startedAt === null && !applying) {
      if (requeueHeldRow(row, false)) backForOthers()
      discardUnstartedRun(lease.runId, attemptId)
      backInQueue(lease, { participant: null, teacher })
    } else {
      if (runOpen(lease)) finishRun(lease.runId, { finishedAt: now, verdict: 'unknown', cellsDone: 0, cellsTotal: 0, teacherError: teacher })
      const lostOn = submissionLeases(lease.submissionId, row.enqueuedAt).filter((one) => one.state === 'lost' && (one.startedAt !== null || one.cause === 'unapplied'))
      const machines = [...new Set(lostOn.map((one) => one.runnerId))]
      if (machines.length >= REMOTE_LOSS_LIMIT || row.lost + 1 >= 2 * REMOTE_LOSS_LIMIT) {
        serverFailure(lease, row, tr('server.runners.lostFailed'), tr('server.runners.lostFailedTeacher', { machines: machines.map(machineName).join(', ') }))
      } else {
        if (requeueHeldRow(row, true)) backForOthers()
        backInQueue(lease, { participant: tr('server.runners.returned'), teacher })
      }
    }
  }
  remoteEvent(lease.runnerId, 'lost', { attemptId, detail: why }, now)
  dropAttemptFiles(lease)
  leaseEndings.lost++
  if (cause !== 'unapplied') quarantineIfDue(lease.runnerId, now)
  return true
})

function causeText(cause: LossCause, detail: string | null): string {
  const said = tr(`server.runners.why.${cause}`)
  return detail ? reasonText(`${said}: ${detail}`) : said
}

/* ---------------------------------------------------------------- declined */

/**
 * The machine refused the lease (§3.4 "Decline", §13 note 3).
 *
 * `draining` — the machine stops (`colloq-host runner update`, a leave,
 * `--now` after the container started): the row waits again with no loss
 * counted and no decline either, whatever phase the run was in. Any other
 * reason comes before a container started (the image, the data, the wheels,
 * the disk, the memory, a card, a version): the attempt is refunded, the run
 * row the take started goes, that machine is not offered the submission for
 * REMOTE_DECLINE_SKIP_MS (lease.ts · takeForRunner reads the declines), and
 * nothing row-wide waits — another machine or this server takes it at once.
 * Declined by REMOTE_DECLINE_LIMIT different machines, the submission ends
 * as our failure with their reasons. A refusal claimed after a container
 * started for a reason other than draining is a lost run, and counted as one.
 *
 * A drain after the container started is skipped by its machine for the
 * decline's window all the same (store.ts · declinedBy): free to repeat, it
 * let one machine hold a submission for as long as it liked.
 *
 * `data` for a lease this server's own blob streams kept waiting (blobs.ts ·
 * starvedLease: its machine asked for the lease's notebook or a wheel and was
 * told to come back, until its preparation ran out) is no refusal of the
 * machine's: it is written down as `starved`, counts toward no quarantine and
 * no limit, is not skipped, and the row waits again as after a drain.
 */
export const declineLease = db.transaction((attemptId: string, now: number, reason: RemoteDeclineReason, detail: string): 'declined' | 'lost' | null => {
  const lease = getLease(attemptId)
  if (!lease || !OPEN_LEASE_STATES.includes(lease.state)) return null
  const said = reasonText(detail ? `${reason}: ${detail}` : reason)
  if (reason !== 'draining' && lease.startedAt !== null) return loseLease(attemptId, now, 'declined', said) ? 'lost' : null
  const starved = reason === 'data' && starvedLease(attemptId)
  const cause = starved ? 'starved' : reason
  updateLease(attemptId, { state: 'declined', endedAt: now, reason: reason === 'draining' ? 'draining' : said, cause }, OPEN_LEASE_STATES)
  const refusal = reason !== 'draining' && !starved
  const row = ownedRow(lease)
  if (row) {
    const machine = machineName(lease.runnerId)
    if (lease.startedAt === null) discardUnstartedRun(lease.runId, attemptId)
    else if (runOpen(lease)) finishRun(lease.runId, { finishedAt: now, verdict: 'unknown', cellsDone: 0, cellsTotal: 0, teacherError: tr('server.runners.givenBack', { machine }) })
    const declinedBy = !refusal
      ? []
      : submissionLeases(lease.submissionId, row.enqueuedAt).filter((one) => one.state === 'declined' && refusedDecline(one))
    const machines = [...new Set(declinedBy.map((one) => one.runnerId))]
    if (machines.length >= REMOTE_DECLINE_LIMIT) {
      const reasons = declinedBy.map((one) => `${machineName(one.runnerId)}: ${one.reason ?? ''}`).join('; ')
      serverFailure(lease, row, tr('server.runners.declinedFailed'), tr('server.runners.declinedFailedTeacher', { reasons }))
    } else {
      if (requeueHeldRow(row, false)) backForOthers()
      backInQueue(lease, lease.startedAt === null
        ? { participant: null, teacher: null }
        : { participant: tr('server.runners.returned'), teacher: tr('server.runners.givenBack', { machine }) })
    }
  }
  remoteEvent(lease.runnerId, 'declined', { attemptId, detail: starved ? `${said} (${tr('server.runners.why.starved')})` : said }, now)
  dropAttemptFiles(lease)
  leaseEndings.declined++
  if (refusal) quarantineIfDue(lease.runnerId, now)
  return 'declined'
})

/* ------------------------------------------------------- taken back by home */

/**
 * This server takes a run back from its machine with no penalty to anyone:
 * the owner disconnected the machine, or no longer trusts it with the hidden
 * test the run reads. The row waits again in its place; the machine is told
 * at its next sync (revoke) or by its next call's 401, and whatever it sends
 * about the attempt afterwards is refused.
 */
export const releaseLease = db.transaction((attemptId: string, now: number, why: 'revoked' | 'untrusted'): boolean => {
  const lease = getLease(attemptId)
  if (!lease || !OPEN_LEASE_STATES.includes(lease.state)) return false
  updateLease(attemptId, { state: 'revoked', endedAt: now, reason: why, cause: why }, OPEN_LEASE_STATES)
  const row = ownedRow(lease)
  if (row) {
    const machine = machineName(lease.runnerId)
    if (lease.startedAt === null) discardUnstartedRun(lease.runId, attemptId)
    else if (runOpen(lease)) finishRun(lease.runId, { finishedAt: now, verdict: 'unknown', cellsDone: 0, cellsTotal: 0, teacherError: tr('server.runners.givenBack', { machine }) })
    requeueHeldRow(row, false)
    backInQueue(lease, lease.startedAt === null
      ? { participant: null, teacher: null }
      : { participant: tr('server.runners.returned'), teacher: tr('server.runners.givenBack', { machine }) })
  }
  remoteEvent(lease.runnerId, 'revoked', { attemptId, detail: why }, now)
  dropAttemptFiles(lease)
  leaseEndings.revoked++
  return true
})

/**
 * A LEASE WHOSE QUEUE ROW IT NO LONGER OWNS, ended with no penalty: the row
 * is gone, waiting, or running under another attempt or another holder.
 *
 * No transaction of this release leaves one — every take and every end
 * changes the lease and the row together — but a rollback does. Home rolled
 * back to 0.22 (§13d note 30) took a machine's running row for its own
 * orphan, ran it again under an attempt of its own, and kept the holder it
 * does not know; forward again, the reclaim put the row back to waiting
 * (store.ts · orphanedRuns) and nothing ended the leases. They stayed
 * `running` on a machine that went on running them: their outcomes were
 * answered `revoked` with the lease left as it was, the same submissions
 * were leased to the same machine again beside them, and as the machine let
 * each one go its next sync lost it as `missing` — a loss after a start, at
 * three different moments, and a healthy machine was quarantined by this
 * server's own rollback.
 *
 * So such a lease is revoked as a cancel is (the machine's next sync hears
 * `cancelled`, kills the container and drops the attempt): no loss on the
 * row (which is not its to touch), no quarantine, no decline, no skip. Its
 * run row is finished as given back — or dropped, if its container never
 * started — so the teacher's history has no run that never ends. At boot
 * (liveness.ts · bootRemoteRunners), and whenever the machine says a word
 * about one (lease.ts · noteAttempt, apply.ts · finish).
 */
export const orphanLease = db.transaction((attemptId: string, now: number): boolean => {
  const lease = getLease(attemptId)
  if (!lease || !OPEN_LEASE_STATES.includes(lease.state) || ownedRow(lease)) return false
  updateLease(attemptId, { state: 'revoked', endedAt: now, reason: tr('server.runners.why.orphan'), cause: 'orphan' }, OPEN_LEASE_STATES)
  if (lease.startedAt === null) discardUnstartedRun(lease.runId, attemptId)
  else if (runOpen(lease)) {
    finishRun(lease.runId, { finishedAt: now, verdict: 'unknown', cellsDone: 0, cellsTotal: 0, teacherError: tr('server.runners.orphanTeacher', { machine: machineName(lease.runnerId) }) })
  }
  remoteEvent(lease.runnerId, 'revoked', { attemptId, detail: 'orphan' }, now)
  dropAttemptFiles(lease)
  leaseEndings.orphaned++
  wakeRunner(lease.runnerId)
  return true
})

/**
 * CANCEL A MACHINE'S RUN, DURABLY (§3.5): the participant's «Отменить», the
 * teacher's «Остановить», a participant erased, a competition deleted. One
 * transaction, fenced on the attempt: the queue row goes, the lease is
 * revoked, the run row is finished and the submission is cancelled in the
 * words a cancel here uses. Then the machine's held sync is woken, its
 * reply carries the revoke, and the agent aborts the run — its container
 * dies within about one round trip, and a late upload or outcome gets
 * refused. It survives a restart of this server, unlike a cancel of a
 * container here, which is a note in memory until the run ends.
 *
 * `false` — the row is not a machine's running row any more (it ended, or
 * it never was one), and nothing was touched.
 */
export function cancelRemote(row: QueueRow, by: 'entrant' | 'teacher', now = Date.now()): boolean {
  let woken: string | null = null
  const done = db.transaction((): boolean => {
    const lease = row.attemptId ? getLease(row.attemptId) : null
    if (!lease || lease.runnerId !== row.holder || !(['offered', 'accepted', 'running', 'applying'] as LeaseState[]).includes(lease.state)) return false
    /*
     * Its result is being applied this very moment (apply.ts · drive): the
     * run is over, and the cancel is too late, as a cancel of a run that has
     * just ended here is. Cancelled under the drive, the run row took the
     * cancel's words and the submission went `cancelled`, and then the
     * settle wrote its own verdict over them and the machine was told
     * `applied` for a cancelled run. A lease `applying` with no drive in
     * flight (one that threw, one a crash left) is the cancel's to end.
     */
    if (lease.state === 'applying' && driveInFlight(lease.attemptId)) return false
    const current = ownedRow(lease)
    if (!current) return false
    leaveHeldRow(current)
    updateLease(lease.attemptId, { state: 'revoked', endedAt: now, reason: 'cancelled', cause: 'cancelled' }, ['offered', 'accepted', 'running', 'applying'])
    const words = tr(by === 'teacher' ? 'competitions.answer.killedByTeacher' : 'competitions.answer.killedByEntrant')
    if (runOpen(lease)) finishRun(lease.runId, { finishedAt: now, verdict: 'exit', cellsDone: 0, cellsTotal: 0, teacherError: words })
    updateSubmission(lease.submissionId, {
      state: 'cancelled',
      durationMs: lease.startedAt === null ? lease.prepared.before.durationMs : Math.max(0, now - lease.startedAt),
      participantError: null,
      teacherError: words,
    })
    remoteEvent(lease.runnerId, 'revoked', { attemptId: lease.attemptId, detail: 'cancelled' }, now)
    dropAttemptFiles(lease)
    leaseEndings.cancelled++
    woken = lease.runnerId
    return true
  })()
  if (woken) wakeRunner(woken)
  return done
}

/* ----------------------------------------------------------------- machines */

/**
 * The owner disconnects a machine («Отключить»): its secret is refused from
 * the next call on (401, which makes the agent purge the hidden test and
 * stop), its runs go back to the queue with no penalty, and its late results
 * are refused. A result already being applied is left to finish: it is this
 * server's work by then, not the machine's.
 *
 * And what is on its way to it stops now: every blob stream open to it is cut
 * (blobs.ts · cutBlobStreams). The next call was refused, but a stream begun
 * a second before went on to its last byte — rivals' notebooks, open data,
 * and on a trusted machine up to 200 MiB of the hidden test — to exactly the
 * machine these buttons exist for: one the owner no longer trusts.
 */
export function revokeRunner(runnerId: string, now = Date.now()): boolean {
  const runner = getRunner(runnerId)
  if (!runner || runner.state === 'revoked' || runner.state === 'left') return false
  db.transaction(() => {
    updateRunner(runnerId, { state: 'revoked', revokedAt: now })
    for (const lease of openLeases(runnerId)) releaseLease(lease.attemptId, now, 'revoked')
    remoteEvent(runnerId, 'revoked', {}, now)
  })()
  cutBlobStreams(runnerId, 'all')
  forgetHeard(runnerId)
  wakeRunner(runnerId)
  wakeAllRunners()
  return true
}

/**
 * The machine revokes itself (colloq-host runner leave, §13c note 19): its
 * leaving sync lists nothing held, and from its next call on its secret is
 * refused, as after the owner's «Отключить». The sync has been reconciled
 * by then (lease.ts · reconcileSync), so a run it no longer lists is lost
 * and an offer it saw and left out is withdrawn; what it may still have here
 * is an offer its last reply carried and the machine never heard (a reply
 * lost on the way). That one is withdrawn now, with nothing counted, rather
 * than holding its row for the offer's minute (REMOTE_OFFER_MS) for a
 * machine that is gone. Anything else still open — no path here leaves one —
 * goes back the way a revoke sends it.
 */
export function leaveRunner(runnerId: string, now = Date.now()): boolean {
  const runner = getRunner(runnerId)
  if (!runner || !runnerStanding(runner)) return false
  let freed = 0
  db.transaction(() => {
    markRunnerLeft(runnerId, now)
    for (const lease of openLeases(runnerId)) {
      if (lease.state === 'offered' ? withdrawLease(lease.attemptId, now, 'unseen') : releaseLease(lease.attemptId, now, 'revoked')) freed++
    }
    remoteEvent(runnerId, 'left', {}, now)
  })()
  cutBlobStreams(runnerId, 'all')
  if (freed > 0) wakeAllRunners()
  return true
}

/**
 * The owner stops trusting a machine with the hidden test (decision 1): the
 * runs on it that read the hidden test go back to the queue — a trusted
 * machine may take them, or none, and they wait with that reason — and the
 * next sync tells the machine it is not trusted, which makes it purge what
 * it held of the hidden test. Its other runs go on. A stream of the hidden
 * test open to it now is cut on the spot (blobs.ts · cutBlobStreams): the
 * rest of a 200 MiB file must not go on flowing to a machine for the minutes
 * a slow «Скорость раздачи» takes, after the owner said it may not hold it.
 */
export function untrustRunner(runnerId: string, now = Date.now()): number {
  let released = 0
  db.transaction(() => {
    updateRunner(runnerId, { trusted: false })
    for (const lease of openLeases(runnerId)) {
      if (lease.sealed && releaseLease(lease.attemptId, now, 'untrusted')) released++
    }
    remoteEvent(runnerId, 'untrusted', {}, now)
  })()
  cutBlobStreams(runnerId, 'sealed')
  wakeRunner(runnerId)
  if (released > 0) wakeAllRunners()
  return released
}

/**
 * QUARANTINE (§3.4): REMOTE_QUARANTINE_LOSSES losses or
 * REMOTE_QUARANTINE_DECLINES declines on one machine within
 * REMOTE_QUARANTINE_WINDOW_MS drain it — it finishes what it holds and takes
 * nothing new — and the panel raises a banner until the owner has looked. A
 * machine that loses or refuses run after run is broken, and every lease it
 * takes meanwhile is a participant waiting behind it for nothing. Drains
 * given by the machine itself are not refusals and do not count.
 *
 * LOSSES COUNT AS EVENTS, NOT AS LEASES. One restart of the agent (a docker
 * restart, the agent's own OOM, a reboot of the host) loses every run it
 * held in one sync — reconcileSync loses each lease the sync no longer lists,
 * at one `now` — and one silence loses them in one pass of the clock. Counted
 * lease by lease, a machine holding three runs was drained for one restart:
 * with one GPU machine, every GPU notebook of a class stopped, while §10.2
 * expects `docker kill colloq-runner` only to requeue the runs. So the leases
 * lost at one moment are one loss, and only losses after a container
 * started count at all: one before it is refunded as if never taken, cost
 * nobody a minute, and says nothing about the machine's runs.
 *
 * THE WINDOW STARTS OVER WHEN THE OWNER RESUMES THE MACHINE (resumedAt): the
 * losses that drained it are the ones the owner looked at and decided about.
 * Counted again, the next single loss within the half hour — one agent
 * restart — drained it at once, one event undoing the owner's decision.
 */
export function quarantineIfDue(runnerId: string, now: number): boolean {
  const runner = getRunner(runnerId)
  if (!runner || runner.state !== 'active') return false
  const since = Math.max(now - REMOTE_QUARANTINE_WINDOW_MS, runner.resumedAt ?? Number.NEGATIVE_INFINITY)
  const losses = new Set(endedLeases(runnerId, ['lost'], since).filter((lease) => lease.startedAt !== null && lease.cause !== 'unapplied').map((lease) => lease.endedAt)).size
  const declines = endedLeases(runnerId, ['declined'], since).filter(refusedDecline).length
  if (losses < REMOTE_QUARANTINE_LOSSES && declines < REMOTE_QUARANTINE_DECLINES) return false
  updateRunner(runnerId, { state: 'draining', quarantinedAt: now, quarantineSeen: false })
  remoteEvent(runnerId, 'quarantined', { detail: losses >= REMOTE_QUARANTINE_LOSSES ? `lost ${losses}` : `declined ${declines}` }, now)
  wakeRunner(runnerId)
  return true
}
