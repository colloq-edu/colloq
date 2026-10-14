/**
 * A machine's outcome, applied once (§3.6 "Outcome").
 *
 * THE ORDER IS THE DESIGN'S, and each step is there for a crash:
 *   1. the fence — the lease is accepted or running, the queue row still
 *      this attempt's and this machine's;
 *   2. the lease becomes `applying`, with the outcome itself and its digest
 *      written into it, before anything moves;
 *   3. the staged files must be exactly the ones the outcome lists, and move
 *      into the attempt's own result folder;
 *   4. settleNotebook — the very code a run here is settled by: the clamps,
 *      the words for each reader, the run row, the neighbour retry, the
 *      artifacts, the answer check, the promotion;
 *   5. the row becomes this server's metric work (continueAsMetric), or
 *      leaves the queue, or waits for the work asked meanwhile;
 *   6. the lease becomes `applied`, with its reply, in the same transaction
 *      as step 5.
 * A crash between 2 and 6 leaves the lease `applying`, and the boot (or the
 * machine's repeated post) drives it again from the row alone: the moves are
 * skipped where they were made, and publish and promote are once per
 * attempt (storage.ts · attemptRecord). The second drive stops at the lease
 * state and at the fence of step 5 before it settles twice (§13b note 12).
 *
 * THE PREPARATION IS REBUILT FROM THE LEASE, never prepared again (§13b note
 * 11): preparing again would start a second run row for one run. The lease
 * keeps what the take read — the run row, the container, the hidden files
 * by name, the code cells, the provenance, the limits, the competition
 * itself (its limits and texts word the outcome, as the job's own read does
 * for a run here), and the submission's numbers from before the run, which
 * the neighbour retry puts back.
 *
 * EVERY TEXT FROM THE MACHINE IS RENDERED HERE, in this server's language:
 * the machine's bundle carries no translations, and its core's sentences
 * come as markers (shared/remote-runner.ts · remoteRenderTexts, §13b note 9).
 *
 * IDEMPOTENT BY DIGEST. The same outcome posted again gets the reply its
 * first post got; a different one for a settled attempt is 409 `conflict`.
 */
import path from 'node:path'
import {
  remoteOutcomeDigest,
  type RemoteDeclinedRequest,
  type RemoteFinishedRequest,
  type RemoteOutcomeRequest,
  type RemoteResultFile,
  type RemoteRunOutcome,
} from '@shared/remote-runner'
import { db } from '../../db.js'
import { getBinding } from '../../dependencies/store.js'
import type { RunOutcome, RunRequest } from '../runner-port.js'
import { continueAsMetric, settleNotebook, type PreparedNotebook } from '../runner.js'
import { attemptDir, attemptPromoted, competitionsFs, dropAttempt, inputDir, SUBMISSION_FILE } from '../storage.js'
import { finishQueueAttempt, getCompetition, getSubmission, listRuns, queueRow, type QueueRow } from '../store.js'
import { declineLease, loseLease } from './release.js'
import { getLease, leasesInState, noteDrive, remoteEvent, sha256, updateLease, type LeaseRow } from './store.js'
import { dropStaging, stagedPath, stagedWhole } from './upload.js'
import { homeWords } from './words.js'

/** What a lease keeps of its outcome for the re-drive: the request without `free`, which is only the machine's room. */
type StoredOutcome =
  | { kind: 'finished'; outcome: RemoteRunOutcome; runJson: string | null; files: RemoteResultFile[] }
  | { kind: 'declined'; reason: RemoteDeclinedRequest['reason']; detail: string }

export type ApplyResult = 'applied' | 'refused' | 'revoked'

/** How an outcome was answered, for the router: a result, or a refusal by its code. */
export type ApplyAnswer = { ok: true; result: ApplyResult } | { ok: false; code: 'not_found' | 'conflict' }

export const applyCounts = { applied: 0, refused: 0, revoked: 0, redriven: 0 }

/**
 * The drives in flight in this process, by attempt. A repeated post — the
 * machine's retry after its first post timed out, while that one is still
 * being applied — waits for the same drive and gets its answer: never a
 * second settle, and never `applied` before it is (were the drive to fail,
 * the machine must keep its result and post again).
 */
const applying = new Map<string, Promise<ApplyResult>>()

/** The queue row a lease still owns: running, under its attempt, held by its machine. */
function ownedRow(lease: LeaseRow): QueueRow | null {
  const row = queueRow(lease.submissionId)
  return row && row.state === 'running' && row.attemptId === lease.attemptId && row.holder === lease.runnerId ? row : null
}

/**
 * Apply `request` for `runnerId`'s attempt `attemptId`. The leases the reply
 * may carry are the router's business; this answers what became of this
 * attempt.
 */
export async function applyOutcome(runnerId: string, attemptId: string, request: RemoteOutcomeRequest, now = Date.now()): Promise<ApplyAnswer> {
  const lease = getLease(attemptId)
  if (!lease || lease.runnerId !== runnerId) return { ok: false, code: 'not_found' }
  const digest = remoteOutcomeDigest(request, sha256)
  if (lease.outcomeSha256 !== null) {
    if (lease.outcomeSha256 !== digest) return { ok: false, code: 'conflict' }
    // The same outcome again: its reply, once the first post is through (a crash may have left it to drive).
    if (lease.state === 'applying') return { ok: true, result: await drive(attemptId, now) }
    return { ok: true, result: lease.reply?.result ?? 'revoked' }
  }
  if (lease.state !== 'offered' && lease.state !== 'accepted' && lease.state !== 'running') {
    applyCounts.revoked++
    return { ok: true, result: 'revoked' }
  }
  if (request.kind === 'declined') return { ok: true, result: decline(lease, request, digest, now) }
  return { ok: true, result: await finish(lease, request, digest, now) }
}

/** A decline (release.ts · declineLease), remembered by its digest so that its repeat gets the same reply. */
function decline(lease: LeaseRow, request: RemoteDeclinedRequest, digest: string, now: number): ApplyResult {
  return db.transaction((): ApplyResult => {
    // The machine's reason, in this server's words (words.ts).
    const ended = declineLease(lease.attemptId, now, request.reason, homeWords(request.detail))
    if (ended === null) return 'revoked'
    const result: ApplyResult = ended === 'declined' ? 'applied' : 'refused'
    updateLease(lease.attemptId, { outcomeSha256: digest, outcome: { kind: 'declined', reason: request.reason, detail: request.detail }, reply: { result } })
    return result
  })()
}

/** A finished run: fenced, written down as `applying`, then driven. */
async function finish(lease: LeaseRow, request: RemoteFinishedRequest, digest: string, now: number): Promise<ApplyResult> {
  if (!ownedRow(lease)) {
    applyCounts.revoked++
    return 'revoked'
  }
  // The staged files must be exactly the ones listed: a missing one means this server cannot use the result.
  const missing = request.files.find((file) => !stagedWhole(lease.attemptId, file))
  if (missing) {
    db.transaction(() => {
      loseLease(lease.attemptId, now, 'refused', missing.name)
      updateLease(lease.attemptId, { outcomeSha256: digest, reply: { result: 'refused' } })
    })()
    dropStaging(lease.attemptId)
    applyCounts.refused++
    return 'refused'
  }
  const stored: StoredOutcome = { kind: 'finished', outcome: request.outcome, runJson: request.runJson, files: request.files }
  const marked = updateLease(lease.attemptId, {
    state: 'applying',
    ...(lease.acceptedAt === null ? { acceptedAt: now } : {}),
    endedAt: now,
    outcomeSha256: digest,
    outcome: stored,
  }, ['offered', 'accepted', 'running'])
  if (!marked) return getLease(lease.attemptId)?.reply?.result ?? 'revoked'
  return drive(lease.attemptId, now)
}

/**
 * The steps from the moves to the commit, for a lease in `applying`: from a
 * post, or again after a crash. While it runs the lease is marked in flight
 * (store.ts · noteDrive), and neither a cancel nor the ceiling ends it under
 * the drive.
 */
function drive(attemptId: string, now: number): Promise<ApplyResult> {
  const inFlight = applying.get(attemptId)
  if (inFlight) return inFlight
  noteDrive(attemptId, true)
  const once = driveOnce(attemptId, now).finally(() => {
    applying.delete(attemptId)
    noteDrive(attemptId, false)
  })
  applying.set(attemptId, once)
  return once
}

async function driveOnce(attemptId: string, now: number): Promise<ApplyResult> {
  const lease = getLease(attemptId)
  if (!lease) return 'revoked'
  if (lease.state !== 'applying') return lease.reply?.result ?? 'revoked'
  const stored = lease.outcome as StoredOutcome | null
  const row = ownedRow(lease)
  const competition = getCompetition(lease.competitionId)
  const submission = getSubmission(lease.submissionId)
  if (!row || !competition || !submission || stored?.kind !== 'finished') {
    /*
     * The attempt is not the row's any more. A cancel, an erase or a deletion
     * came between the post and the drive (or before a crash): the result is
     * refused. Or a drive before a crash settled the run and the neighbour
     * retry put the row back itself: its run row is finished, and the result
     * did take effect.
     */
    // A cancelled submission's run is finished too, by the cancel: that run did not take effect.
    const settled = submission?.state !== 'cancelled' && listRuns(lease.submissionId).some((run) => run.id === lease.runId && run.finishedAt !== null)
    const result: ApplyResult = settled && stored?.kind === 'finished' ? 'applied' : 'revoked'
    updateLease(attemptId, { state: result === 'applied' ? 'applied' : 'revoked', reply: { result }, ...(result === 'revoked' ? { reason: 'cancelled', cause: 'cancelled' as const } : {}) }, ['applying'])
    cleanUp(lease)
    applyCounts[result]++
    return result
  }

  // 3. The staged files into the attempt's own result folder; a move made before a crash is not made again.
  const result = attemptDir(lease.competitionId, lease.submissionId, attemptId, 'result')
  for (const file of stored.files) {
    const staged = stagedPath(attemptId, file.name, file.sha256)
    if (competitionsFs.existsSync(staged)) competitionsFs.renameSync(staged, path.join(result, file.name))
  }
  const report = runJsonOf(stored.runJson, attemptId)
  if (report && !competitionsFs.existsSync(path.join(result, 'run.json'))) competitionsFs.writeFileSync(path.join(result, 'run.json'), report, { mode: 0o600 })

  // 4. Settled by the code a run here is settled by, from what the lease kept: the competition among it, as the take read it.
  const binding = getBinding(lease.submissionId)
  const before = lease.prepared.before
  const prepared: PreparedNotebook = {
    placement: 'remote',
    competition: lease.prepared.competition ?? competition,
    submission: { ...submission, cellsDone: before.cellsDone, cellsTotal: before.cellsTotal, durationMs: before.durationMs },
    row,
    provenance: lease.provenance,
    binding,
    limits: lease.manifest.limits,
    container: lease.container,
    runId: lease.runId,
    sealedFiles: lease.prepared.sealedFiles,
    sealed: lease.sealed,
    codeCells: lease.codeCells,
    input: inputDir(lease.competitionId, lease.submissionId),
    result,
    bundle: binding?.bundle ?? null,
    unfit: null,
  }
  const outcome = runOutcomeOf(stored.outcome, result, attemptId, lease)
  const card = stored.outcome.card
  const gpu: RunRequest['gpu'] = card ? { device: card.device, sliceMb: card.sliceMb, perDevice: card.perDevice } : undefined
  const settled = await settleNotebook(prepared, { outcome, endedAt: now, ...(gpu ? { gpu } : {}), crowded: stored.outcome.crowded })

  /*
   * 5 and 6 in one transaction: a crash leaves either both or neither. Fenced
   * on the lease still being `applying`: whatever ended it meanwhile (nothing
   * of this life can while the drive is in flight, store.ts · noteDrive, but
   * a hand in the database can) keeps the row as it left it, and the machine
   * is told what that was — never `applied` for a run that did not take
   * effect.
   */
  const committed = db.transaction((): boolean => {
    if (!updateLease(attemptId, { state: 'applied', reply: { result: 'applied' } }, ['applying'])) return false
    if (settled.next === 'score') continueAsMetric(prepared, settled)
    else finishQueueAttempt(row)
    return true
  })()
  cleanUp(lease)
  if (!committed) {
    applyCounts.revoked++
    return getLease(attemptId)?.reply?.result ?? 'revoked'
  }
  remoteEvent(lease.runnerId, 'applied', { attemptId, detail: outcome.status }, now)
  applyCounts.applied++
  return 'applied'
}

/** The attempt's own folders and its staging go once its outcome is settled: out/ holds what was published. */
function cleanUp(lease: LeaseRow): void {
  try {
    dropAttempt(lease.competitionId, lease.submissionId, lease.attemptId)
  } catch {
    // The sweep of a later life finds it (liveness.ts · sweepStaging).
  }
  dropStaging(lease.attemptId)
}

/**
 * The harness's run.json as the machine took it out, if it is this
 * attempt's: a report naming another attempt is not this run's, whatever it
 * says (docker-runner.ts takes no other either), and it goes nowhere.
 */
function runJsonOf(runJson: string | null, attemptId: string): Buffer | null {
  if (runJson === null) return null
  try {
    const bytes = Buffer.from(runJson, 'base64')
    const report = JSON.parse(bytes.toString('utf8')) as { attemptId?: unknown } | null
    return report && typeof report === 'object' && report.attemptId === attemptId ? bytes : null
  } catch {
    return null
  }
}


/** The machine's outcome as settleNotebook takes it (runner-port.ts · RunOutcome). */
function runOutcomeOf(remote: RemoteRunOutcome, result: string, attemptId: string, lease: LeaseRow): RunOutcome {
  const d = remote.diagnostics
  const answer = path.join(result, SUBMISSION_FILE)
  // An answer this attempt promoted already before a crash is in out/ now, and settleNotebook knows that (attemptPromoted).
  const produced = remote.produced && (competitionsFs.existsSync(answer) || attemptPromoted(lease.competitionId, lease.submissionId, attemptId))
  return {
    status: remote.status,
    cell: remote.cell,
    cells: remote.cells,
    wall: remote.wall,
    submission: produced ? answer : null,
    detail: homeWords(remote.detail),
    log: homeWords(remote.log),
    ...(remote.dependencyFailure ? { dependencyFailure: remote.dependencyFailure } : {}),
    diagnostics: {
      exit: d.exit,
      oomKilled: d.oomKilled,
      backend: d.backend === 'test' ? 'test' : 'docker',
      ...(d.killedBy !== undefined ? { killedBy: d.killedBy } : {}),
      ...(d.peakBytes !== undefined ? { peakBytes: d.peakBytes } : {}),
      ...(d.gpuPeakMb !== undefined ? { gpuPeakMb: d.gpuPeakMb } : {}),
      ...(d.gpuSamplesMb !== undefined ? { gpuSamplesMb: d.gpuSamplesMb } : {}),
    },
  }
}

/**
 * At boot (§3.4 "Home restart"): every lease left `applying` by a crash is
 * driven again from its row. Returns how many.
 */
export async function redriveApplying(now = Date.now()): Promise<number> {
  let n = 0
  for (const lease of leasesInState('applying')) {
    await drive(lease.attemptId, now).catch((error: unknown) => console.error('[runners] an outcome could not be applied again', lease.attemptId, error))
    n++
    applyCounts.redriven++
  }
  return n
}
