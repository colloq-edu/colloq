/**
 * Taking work for a machine, and keeping its leases in step with what the
 * machine says it holds (§3.4, §5.2).
 *
 * THE TAKE (takeForRunner) is one synchronous transaction next to the pump's
 * own (store.ts · takeNext), over the same fair order. It skips the rows the
 * machine cannot run — and never stops on one: a GPU notebook waiting for a
 * card must not hold up the CPU work behind it, here as there — and leases
 * the rest until the machine's room is spent. Each lease is the queue row
 * marked as the machine's (holder), its notebook step prepared by the very
 * code a run here is prepared by (runner.ts · prepareNotebook: the run row,
 * the stage bar, the hidden files by name), and the lease row with
 * everything its offer is built from and its outcome is settled by.
 *
 * THE RECONCILIATION (reconcileSync) is level-triggered: every sync lists
 * every attempt the machine holds, and home compares the list with its
 * leases. An offer listed is delivered; one left out of a sync that has seen
 * its number was never received and is withdrawn; a delivered lease left out
 * is lost at once — the machine says it no longer has it (an agent restart,
 * §3.4 "Agent restart"). Nothing is decided on a lost reply: the next sync
 * says the same, whole.
 */
import path from 'node:path'
import {
  REMOTE_ATTEMPTS_MAX,
  REMOTE_ATTEMPT_DISK_MB,
  REMOTE_CONTAINER,
  REMOTE_DECLINE_SKIP_MS,
  REMOTE_HARNESS,
  REMOTE_INLINE_BYTES,
  REMOTE_INLINE_TOTAL_BYTES,
  REMOTE_PER_DEVICE_MAX,
  REMOTE_RUN_MS_MAX,
  remoteCeilingMs,
  type RemoteFree,
  type RemoteHeldAttempt,
  type RemoteLease,
  type RemoteRevoke,
  type RemoteSyncRequest,
} from '@shared/remote-runner'
import type { Competition } from '@shared/competitions'
import { db } from '../../db.js'
import { HARNESS_REVISION } from '../harness.js'
import { clampCells, prepareNotebook } from '../runner.js'
import { gpuPerDeviceSetting } from '../settings.js'
import { competitionsFs, inputDir, NOTEBOOK_FILE } from '../storage.js'
import {
  finishQueueAttempt,
  getSubmission,
  holdQueueRow,
  noteHeldStart,
  queuePaused,
  queueRow,
  updateSubmission,
  waitingNotebookOrder,
  type QueueRow,
} from '../store.js'
import { fitCache, machineFit, rowNeeds, stepClaim, type FitCache, type MachineRefusal, type RowRefusal } from './fit.js'
import {
  boundedPerDevice,
  declinedBy,
  getLease,
  insertLease,
  liveLeases,
  nextOfferSeq,
  openLeases,
  remoteEvent,
  sha256,
  updateLease,
  type LeaseManifest,
  type LeaseRow,
  type RunnerRow,
} from './store.js'
import { loseLease, withdrawLease } from './release.js'

/* ------------------------------------------------------------ the room */

/** What a machine can still take now: places, memory, CPUs, card shares and disk, after what home has leased it. */
export interface RunnerRoom {
  slots: number
  memoryMb: number
  cpus: number
  gpuShares: number
  diskMb: number
}

/** The take's view of a machine: its room, and what it has in place. */
export interface RunnerOffer {
  room: RunnerRoom
  ready: { revisions: ReadonlySet<string>; data: ReadonlySet<string>; sealed: ReadonlySet<string> }
  trusted: boolean
  /** It has cards at all (its sync listed any): a GPU kernel is pulled only where there are. */
  cards: boolean
  /** Runs per card a GPU lease is pinned at (§5.5): the machine's own setting, or the instance's. */
  perDevice: number
}

/** A lease's claim on its machine: the memory docker gives the container and its cushion, its CPUs (fit.ts · stepClaim). */
function claimOf(manifest: Pick<LeaseManifest, 'limits'>): { memoryMb: number; cpus: number } {
  return stepClaim(manifest.limits)
}

/**
 * THE STALE-CAPACITY RULE (§3.4): what a machine has room for is what it
 * says is free, less whatever home has leased it that the machine has not
 * accounted for yet — the leases its sync did not list (offered since it was
 * sent, or while it was held) and, for the cards, the GPU leases it listed
 * without a card (a share is taken at prepare, not at the ack). A sync held
 * for twenty-five seconds therefore cannot get the machine leased twice over
 * on its stale numbers. The places are the owner's cap, or what the machine
 * offers in all (free and held), less every lease out to it.
 *
 * `listed` — the attempts the machine's sync listed, with the ones that hold
 * a card; `null` — no sync to go by, and nothing is taken as accounted for.
 */
export function runnerRoom(runner: Pick<RunnerRow, 'id' | 'approvedSlots'>, free: RemoteFree, listed: ReadonlyMap<string, boolean> | null): RunnerRoom {
  const live = liveLeases(runner.id)
  const unlisted = live.filter((lease) => !listed?.has(lease.attemptId))
  const offered = free.slots + (live.length - unlisted.length)
  // Never more out to one machine than one sync can list (REMOTE_ATTEMPTS_MAX): a reply naming more is one its agent refuses.
  const cap = Math.min(REMOTE_ATTEMPTS_MAX, runner.approvedSlots === null ? offered : Math.min(runner.approvedSlots, offered))
  let memoryMb = free.memoryMb
  let cpus = free.cpus
  for (const lease of unlisted) {
    const claim = claimOf(lease.manifest)
    memoryMb -= claim.memoryMb
    cpus -= claim.cpus
  }
  const shares = live.filter((lease) => lease.manifest.gpu && listed?.get(lease.attemptId) !== true).length
  return {
    slots: Math.max(0, cap - live.length),
    memoryMb,
    cpus,
    gpuShares: free.gpuShares - shares,
    diskMb: free.diskMb - unlisted.length * REMOTE_ATTEMPT_DISK_MB,
  }
}

/** The attempts a sync lists, each with whether it holds a card: runnerRoom's `listed`. */
export function listedOf(sync: Pick<RemoteSyncRequest, 'attempts'> | null): Map<string, boolean> | null {
  return sync ? new Map(sync.attempts.map((attempt) => [attempt.id, attempt.card !== undefined])) : null
}

/** The take's view of a machine from its sync (or, after an outcome, its last sync and the outcome's `free`). */
export function runnerOffer(runner: RunnerRow, free: RemoteFree, sync: Pick<RemoteSyncRequest, 'attempts' | 'ready'> & Partial<Pick<RemoteSyncRequest, 'cards'>> | null): RunnerOffer {
  return {
    room: runnerRoom(runner, free, listedOf(sync)),
    ready: {
      revisions: new Set(sync?.ready.revisions ?? []),
      data: new Set(sync?.ready.data ?? []),
      sealed: new Set(runner.trusted ? (sync?.ready.sealed ?? []) : []),
    },
    trusted: runner.trusted,
    cards: (sync?.cards?.length ?? 0) > 0 || free.gpuShares > 0,
    perDevice: boundedPerDevice(runner.perDevice ?? gpuPerDeviceSetting().value),
  }
}

/* ------------------------------------------------------------- the take */

/** What a waiting row would be leased with, or why it cannot be (the reason only the tests read). */
type Fit = { ok: true; competition: Competition; manifest: LeaseManifest } | { ok: false; why: RowRefusal | MachineRefusal | 'declined' }

/**
 * Whether this machine can run this row now, and if so its lease's
 * manifest: §5.2's skip rules, asked by the one predicate the wait reasons
 * ask too (fit.ts) — the row's own needs, read once per competition and pin
 * in a take, then the machine against them with the room it has LEFT.
 * Never a write: the take writes only for the row it picks.
 */
function fitFor(row: QueueRow & { needsGpu: boolean }, offer: RunnerOffer, room: RunnerRoom, skipped: ReadonlySet<string>, cache: FitCache): Fit {
  if (skipped.has(row.submissionId)) return { ok: false, why: 'declined' }
  const read = rowNeeds(row, cache)
  if (!read.ok) return read
  const needs = read.needs
  const refusal = machineFit(needs, { ready: offer.ready, trusted: offer.trusted, cards: offer.cards, room })
  if (refusal) return { ok: false, why: refusal }
  return {
    ok: true,
    competition: needs.competition,
    manifest: {
      revision: { id: needs.revision.id, ref: needs.revision.registryRef, layers: needs.revision.layers },
      harness: HARNESS_REVISION,
      limits: needs.limits,
      gpu: needs.gpu,
      perDevice: needs.gpu ? Math.min(REMOTE_PER_DEVICE_MAX, offer.perDevice) : null,
      data: needs.open!,
      sealed: needs.hasSealed ? needs.sealed : null,
      notebook: needs.notebook,
      bundle: needs.bundle,
    },
  }
}

/**
 * Lease waiting notebooks to a machine, as many as its room allows (§5.2).
 *
 * STOPS when the queue is paused, the machine may not take work (drained,
 * quarantined, revoked, of another build, draining on its own word: the
 * caller checks those and passes no offer), or its places are spent. WALKS
 * the fair order of the waiting notebook rows (selectNext's, store.ts ·
 * waitingNotebookOrder), and a machine with a free card share takes the
 * first GPU notebook it can run before any CPU one. SKIPS, never stops on, a
 * row it cannot run: its image or its data not in place there, a hidden test
 * on a machine not trusted or not ready, more memory or CPUs than are left,
 * no card share left, a submission it declined within REMOTE_DECLINE_SKIP_MS,
 * an environment only this server has. Metric rows are never leased: the
 * answers stay here (§5.6). The cards are the machine's own and never enter
 * competition_queue.gpu (§5.1).
 *
 * One transaction with the rows' writes, so two machines' takes and the
 * pump's never take one row twice.
 */
export const takeForRunner = db.transaction((runner: RunnerRow, offer: RunnerOffer, now: number): LeaseRow[] => {
  if (queuePaused()) return []
  const taken: LeaseRow[] = []
  const room: RunnerRoom = { ...offer.room }
  const skipped = declinedBy(runner.id, now - REMOTE_DECLINE_SKIP_MS)
  // Each competition, revision and set read once for all its waiting rows: every upload wakes every held sync to take again.
  const cache = fitCache()
  const unfit = new Set<string>()
  for (;;) {
    if (room.slots <= 0) break
    const rows = waitingNotebookOrder(now).filter((row) => !unfit.has(row.submissionId))
    let pick: { row: (typeof rows)[number]; fit: Extract<Fit, { ok: true }> } | null = null
    // A free card share takes the first GPU notebook it can run before any CPU one (§5.2, step 2).
    for (const wantGpu of room.gpuShares > 0 ? [true, false] : [false]) {
      for (const row of rows) {
        if (row.needsGpu !== wantGpu) continue
        const fit = fitFor(row, offer, room, skipped, cache)
        if (fit.ok) {
          pick = { row, fit }
          break
        }
        unfit.add(row.submissionId)
      }
      if (pick) break
    }
    if (!pick) break
    const lease = leaseRow(runner, pick.row.submissionId, pick.fit, now)
    if (!lease) {
      unfit.add(pick.row.submissionId)
      continue
    }
    taken.push(lease)
    const claim = claimOf(lease.manifest)
    room.slots--
    room.memoryMb -= claim.memoryMb
    room.cpus -= claim.cpus
    room.diskMb -= REMOTE_ATTEMPT_DISK_MB
    if (lease.manifest.gpu) room.gpuShares--
  }
  return taken
})

/** The row marked as the machine's, its step prepared as a run here is, and the lease written down; `null` — it could not be taken. */
function leaseRow(runner: RunnerRow, submissionId: string, fit: Extract<Fit, { ok: true }>, now: number): LeaseRow | null {
  const row = holdQueueRow(submissionId, runner.id, now)
  if (!row) return null
  const prepared = prepareNotebook(row, 'remote')
  if (!prepared) {
    // Its submission or competition went between the look and the take: the row goes, as the pump's own job lets it go.
    finishQueueAttempt(row)
    return null
  }
  if (!REMOTE_CONTAINER.test(prepared.container) || !REMOTE_HARNESS.test(fit.manifest.harness)) throw new Error('A lease must carry a container and a harness the contract takes')
  const seq = nextOfferSeq(runner.id)
  insertLease({
    attemptId: row.attemptId!,
    runnerId: runner.id,
    competitionId: fit.competition.id,
    submissionId,
    runId: prepared.runId,
    seq,
    sealed: prepared.sealed,
    codeCells: prepared.codeCells,
    provenance: prepared.provenance,
    // The hidden files the step reads are the take's (PreparedNotebook.sealedFiles), and so is the manifest of them.
    manifest: { ...fit.manifest, limits: prepared.limits, sealed: prepared.sealed ? fit.manifest.sealed : null },
    prepared: {
      sealedFiles: prepared.sealedFiles,
      before: { cellsDone: prepared.submission.cellsDone, cellsTotal: prepared.submission.cellsTotal, durationMs: prepared.submission.durationMs },
      competition: prepared.competition,
    },
    container: prepared.container,
    perDevice: fit.manifest.perDevice,
    offeredAt: now,
    deadlineAt: now + remoteCeilingMs(prepared.limits.wallSeconds),
  })
  if (prepared.sealed && !fit.manifest.sealed) throw new Error('A hidden-test lease without its manifest')
  remoteEvent(runner.id, 'leased', { attemptId: row.attemptId }, now)
  return getLease(row.attemptId!)
}

/* ------------------------------------------------------------- the offer */

/**
 * A lease as the machine is told it (RemoteLease). Its notebook rides inside
 * when it is small and the reply's budget has room (REMOTE_INLINE_BYTES,
 * REMOTE_INLINE_TOTAL_BYTES); otherwise the machine fetches it by its hash.
 * The deadline is relative: this server's clock is the one that counts.
 */
export function leaseOffer(lease: LeaseRow, now: number, budget: { inline: number }): RemoteLease {
  const m = lease.manifest
  let inline: string | undefined
  if (m.notebook.bytes <= REMOTE_INLINE_BYTES && budget.inline >= m.notebook.bytes) {
    try {
      const body = competitionsFs.readFileSync(path.join(inputDir(lease.competitionId, lease.submissionId), NOTEBOOK_FILE)) as Buffer
      if (body.length === m.notebook.bytes && sha256(body) === m.notebook.sha256) {
        inline = body.toString('base64')
        budget.inline -= body.length
      }
    } catch {
      // Gone from disk (an erase on its way): the machine asks by hash, and the lease is revoked anyway.
    }
  }
  return {
    attemptId: lease.attemptId,
    seq: lease.seq,
    competitionId: lease.competitionId,
    submissionId: lease.submissionId,
    container: lease.container,
    deadlineMs: Math.min(REMOTE_RUN_MS_MAX, Math.max(1, lease.deadlineAt - now)),
    revision: m.revision,
    harness: m.harness,
    limits: m.limits,
    sealed: lease.sealed,
    gpu: m.gpu,
    ...(m.gpu ? { perDevice: m.perDevice ?? 1 } : {}),
    data: m.data.manifest,
    ...(lease.sealed && m.sealed ? { sealedData: m.sealed.manifest } : {}),
    notebook: { sha256: m.notebook.sha256, bytes: m.notebook.bytes, ...(inline !== undefined ? { inline } : {}) },
    ...(m.bundle ? { bundle: m.bundle } : {}),
  }
}

/** Every offer of a machine not acked yet, oldest first: repeated in each reply until acked or withdrawn. */
export function pendingOffers(runnerId: string, now: number): RemoteLease[] {
  const budget = { inline: REMOTE_INLINE_TOTAL_BYTES }
  return openLeases(runnerId)
    .filter((lease) => lease.state === 'offered' && lease.deadlineAt > now)
    .slice(0, REMOTE_ATTEMPTS_MAX)
    .map((lease) => leaseOffer(lease, now, budget))
}

/* ---------------------------------------------------- the reconciliation */

const STARTED: ReadonlySet<string> = new Set(['running', 'exporting', 'uploading'])

/**
 * What a sync says about the attempts, written down (§3.4). Called once, when
 * the sync arrives: a held sync answered later says nothing new about them.
 *
 * Listed: an offer is delivered; a delivered lease takes the machine's phase,
 * the card it was given and, from its container's start, a started_at on
 * this server's clock (now less what the machine says it has run), into the
 * lease and the queue row; a running notebook's progress goes into its
 * submission, clamped to the notebook sent on the hidden test. Not listed: an
 * offer whose number the machine has seen is withdrawn, and a delivered lease
 * is lost — the machine no longer has it.
 */
export function reconcileSync(runner: RunnerRow, request: RemoteSyncRequest, now: number): void {
  const listed = new Set<string>()
  for (const attempt of request.attempts) {
    listed.add(attempt.id)
    const lease = getLease(attempt.id)
    if (!lease || lease.runnerId !== runner.id) continue
    noteAttempt(lease, attempt, now)
  }
  for (const lease of openLeases(runner.id)) {
    if (listed.has(lease.attemptId)) continue
    if (lease.state === 'offered') {
      if (lease.seq <= request.seq) withdrawLease(lease.attemptId, now, 'unseen')
    } else loseLease(lease.attemptId, now, 'missing')
  }
}

/** One listed attempt into its lease, its queue row and its submission. */
function noteAttempt(lease: LeaseRow, attempt: RemoteHeldAttempt, now: number): void {
  if (lease.state !== 'offered' && lease.state !== 'accepted' && lease.state !== 'running') return
  const started = STARTED.has(attempt.phase)
  const startedAt = started && lease.startedAt === null ? now - Math.min(attempt.runningMs ?? 0, Math.max(0, now - lease.offeredAt)) : undefined
  const changed = lease.state === 'offered' || lease.phase !== attempt.phase || startedAt !== undefined
    || (attempt.card !== undefined && (lease.device !== attempt.card.device || lease.sliceMb !== attempt.card.sliceMb))
  if (changed) {
    updateLease(lease.attemptId, {
      state: started ? 'running' : lease.state === 'running' ? 'running' : 'accepted',
      ...(lease.state === 'offered' ? { acceptedAt: now } : {}),
      phase: attempt.phase,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(attempt.card !== undefined ? { device: attempt.card.device, sliceMb: attempt.card.sliceMb } : {}),
    }, ['offered', 'accepted', 'running'])
  }
  const row = queueRow(lease.submissionId)
  const owned = row && row.state === 'running' && row.attemptId === lease.attemptId && row.holder === lease.runnerId ? row : null
  if (!owned) return
  if (startedAt !== undefined) noteHeldStart(owned, startedAt)
  if (attempt.progress && attempt.phase === 'running') {
    const seen = lease.codeCells === null ? attempt.progress : clampCells(attempt.progress, lease.codeCells)
    const stage = attempt.progress.phase === 'dependencies' ? 'dependencies' : 'notebook'
    const submission = getSubmission(lease.submissionId)
    // Written only when it changed: a heartbeat every ten seconds must not be a write every ten seconds.
    if (submission && (submission.stage !== stage || submission.cellsDone !== seen.cell + 1 || submission.cellsTotal !== seen.cells)) {
      updateSubmission(lease.submissionId, { stage, cellsDone: seen.cell + 1, cellsTotal: seen.cells })
    }
  }
}

/**
 * What the reply says about the attempts the sync listed, as things stand
 * when it is answered (a cancel during a held sync is in it): `applied` —
 * outcomes applied, the machine deletes their trees; `revoke` — leases over
 * by other means (a cancel or a revoked machine's run, a withdrawn offer, a
 * lost run) and attempts this server holds no lease of for this machine.
 */
export function syncVerdicts(runnerId: string, request: Pick<RemoteSyncRequest, 'attempts'>): { revoke: RemoteRevoke[]; applied: string[] } {
  const revoke: RemoteRevoke[] = []
  const applied: string[] = []
  for (const attempt of request.attempts) {
    const lease = getLease(attempt.id)
    if (!lease || lease.runnerId !== runnerId) {
      revoke.push({ id: attempt.id, reason: 'unknown' })
      continue
    }
    switch (lease.state) {
      case 'applied':
        applied.push(attempt.id)
        break
      case 'withdrawn':
      case 'declined':
        revoke.push({ id: attempt.id, reason: 'withdrawn' })
        break
      case 'lost':
        revoke.push({ id: attempt.id, reason: 'lost' })
        break
      case 'revoked':
        revoke.push({ id: attempt.id, reason: 'cancelled' })
        break
      default:
        break
    }
  }
  return { revoke, applied }
}
