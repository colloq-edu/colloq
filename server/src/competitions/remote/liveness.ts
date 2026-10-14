/**
 * When a machine's runs count as gone (§3.4), and the rest of what has to
 * happen on a clock rather than on a call.
 *
 * EVERY FIVE SECONDS (remoteTick):
 * - an offer no sync has acked within REMOTE_OFFER_MS is withdrawn — no run
 *   began, nothing is counted;
 * - a lease past its ceiling (offer + prepare + wall + grace + upload) is
 *   revoked and counted lost, even while the machine keeps syncing: a run
 *   that long is a machine that is stuck, not slow — and so is a result left
 *   `applying` past it with no drive in flight, which this server could not
 *   apply however often the machine posted it (a full disk here): the row
 *   goes back to the queue rather than holding its place and its machine's
 *   for good (release.ts · loseLease, `unapplied`);
 * - a machine silent for REMOTE_SILENCE_MS loses its runs — but only while
 *   this server has PATH EVIDENCE (heard.ts · pathEvidence) that the road to
 *   the machines works, so that a dead tunnel is not taken for a dead fleet;
 *   without it nothing expires for up to REMOTE_BLIND_MS;
 * - in the first REMOTE_BOOT_GRACE_MS of this life nothing expires at all:
 *   every machine needs a round trip to be heard again;
 * - last_seen_at is written for the machines heard since, at most once a
 *   minute each.
 * EVERY THIRTY SECONDS, while any machine is connected, this server probes
 * its own PUBLIC_URL/api/readyz — through the relay, the way the machines
 * reach it — and a pass is path evidence for a minute.
 * EVERY HOUR, old leases and events go, and staging folders nothing needs.
 *
 * AT BOOT (startRemoteRunners): offers made by the previous life are
 * withdrawn (no machine has acked them to anyone alive), outcomes left
 * `applying` by a crash are driven again, and a machine's queue row without
 * a live lease (which no transaction here can leave, but a hand in the
 * database can) goes back to waiting.
 */
import { REMOTE_BLIND_MS, REMOTE_OFFER_MS, REMOTE_PROBE_MS, REMOTE_SEEN_FLUSH_MS, REMOTE_SILENCE_MS } from '@shared/remote-runner'
import { packagesFit } from '@shared/dependencies'
import { config } from '../../config.js'
import { getBinding } from '../../dependencies/store.js'
import { homeNotebooksSetting } from '../settings.js'
import { prepareNotebook, settleNotebook, unfitOutcome } from '../runner.js'
import { dropAttempt } from '../storage.js'
import {
  finishQueueAttempt,
  getCompetition,
  heldRows,
  holdQueueRow,
  queuePaused,
  requeueHeldRow,
  updateSubmission,
  waitingNotebookOrder,
} from '../store.js'
import { redriveApplying } from './apply.js'
import { loopbackAddress } from './origin.js'
import { heardAt, inBootGrace, noteProbe, pathEvidence, remoteBootAt, seenDue } from './heard.js'
import { loseLease, withdrawLease } from './release.js'
import { LIVE_LEASE_STATES, driveInFlight, flushRunnerSeen, getLease, leasesInState, listRunners, openLeases, pruneRemoteRows, runnerStanding } from './store.js'
import { dropStaging, stagedAttempts } from './upload.js'
import { wakeAllRunners } from './wake.js'

const TICK_MS = 5_000
const PRUNE_MS = 60 * 60_000

let tick: NodeJS.Timeout | null = null
let probe: NodeJS.Timeout | null = null
let prunedAt = 0

/**
 * One pass of the clock. `now` is passed in by the tests, which drive the
 * clock by hand; the timer passes the wall clock.
 */
export function remoteTick(now = Date.now()): { withdrawn: number; lost: number } {
  let withdrawn = 0
  let lost = 0
  const grace = inBootGrace(now)
  const silentSince = new Map<string, number>()
  for (const lease of openLeases()) {
    if (lease.state === 'offered' && now - lease.offeredAt > REMOTE_OFFER_MS) {
      if (withdrawLease(lease.attemptId, now, 'unacked')) withdrawn++
      continue
    }
    if (grace) continue
    if (lease.deadlineAt <= now) {
      if (loseLease(lease.attemptId, now, 'ceiling')) lost++
      continue
    }
    // Silence on this server's clock: never heard in this life counts from its start.
    let since = silentSince.get(lease.runnerId)
    if (since === undefined) {
      since = Math.max(heardAt(lease.runnerId) ?? remoteBootAt(), remoteBootAt())
      silentSince.set(lease.runnerId, since)
    }
    const silent = now - since
    if (silent <= REMOTE_SILENCE_MS) continue
    if (!pathEvidence(now, lease.runnerId) && silent <= REMOTE_BLIND_MS) continue
    if (loseLease(lease.attemptId, now, 'silent')) lost++
  }
  // The ceiling holds for a result being applied too: one that cannot be, by then, goes back to the queue (never one whose drive is under way).
  if (!grace) {
    for (const lease of leasesInState('applying')) {
      if (lease.deadlineAt > now || driveInFlight(lease.attemptId)) continue
      if (loseLease(lease.attemptId, now, 'unapplied')) lost++
    }
  }
  for (const runner of listRunners()) {
    const due = seenDue(runner.id, now, REMOTE_SEEN_FLUSH_MS)
    if (due) flushRunnerSeen(runner.id, due.at, due.address)
  }
  if (now - prunedAt >= PRUNE_MS) {
    prunedAt = now
    pruneRemoteRows(now)
    sweepStaging()
  }
  if (!homeNotebooksSetting().value) settleUnfit(now)
  if (withdrawn + lost > 0) wakeAllRunners()
  return { withdrawn, lost }
}

/**
 * Staging folders (upload.ts) of attempts whose lease is over or unknown:
 * an upload whose outcome never came, an attempt cancelled after its files
 * arrived. A live lease keeps its folder, whatever its age.
 */
export function sweepStaging(): number {
  let swept = 0
  for (const attemptId of stagedAttempts()) {
    const lease = getLease(attemptId)
    if (lease && LIVE_LEASE_STATES.includes(lease.state)) continue
    dropStaging(attemptId)
    swept++
  }
  return swept
}

/**
 * SETS THAT DO NOT FIT SETTLE HERE (§10.1 "Lifecycle"). A package set
 * attached while it fit, after which the teacher lowered the memory, is
 * refused before any container, wherever the run was to go (runner.ts ·
 * unfitOutcome) — and the take never leases it to a machine. With this
 * server's notebooks on, its pump settles such a row the moment it takes it;
 * with them off nobody would, and the row would wait for ever. So the clock
 * takes it as this server's own, settles it with the refusal and lets the
 * row go, all in one turn: no container, no machine, the participant told
 * how big their set is against the memory, exactly as a run here tells them.
 */
export function settleUnfit(now = Date.now()): number {
  if (queuePaused()) return 0
  let settled = 0
  for (const waiting of waitingNotebookOrder(now)) {
    const competition = getCompetition(waiting.competitionId)
    const bundle = getBinding(waiting.submissionId)?.bundle ?? null
    if (!competition || !bundle || packagesFit(bundle.installedBytes, competition.limits.memoryMb)) continue
    const row = holdQueueRow(waiting.submissionId, null, now)
    if (!row) continue
    const prepared = prepareNotebook(row, 'remote')
    const refusal = prepared ? unfitOutcome(prepared) : null
    if (!prepared || !refusal) {
      finishQueueAttempt(row)
      continue
    }
    // settleNotebook waits on nothing for a run placed away from this server's cards: this resolves in the same turn.
    void settleNotebook(prepared, { outcome: refusal, endedAt: now }).finally(() => {
      finishQueueAttempt(row)
      try { dropAttempt(row.competitionId, row.submissionId, row.attemptId!) } catch { /* the orphan sweep removes it */ }
    })
    settled++
  }
  return settled
}

/**
 * The probe of this server's own address through the relay: path evidence
 * (heard.ts · pathEvidence).
 *
 * ONLY AN ADDRESS THE MACHINES COME THROUGH IS EVIDENCE. PUBLIC_URL falls
 * back to http://localhost:PORT (config.ts) on an instance nobody gave an
 * address, and a probe of the loopback answers from this very process
 * whatever the relay and the tunnel are doing: it passed every time, and
 * a machine silent behind a dead tunnel lost its runs after three minutes —
 * the one thing path evidence exists to prevent. So a loopback PUBLIC_URL is
 * never probed, and without another machine heard nothing expires before
 * REMOTE_BLIND_MS. One redirect is followed, from http to https on the same
 * host (a relay that sends plain http to https, as Caddy does): taken for a
 * refusal, a public http PUBLIC_URL was never evidence at all. Any other
 * redirect is not followed — it leads somewhere that is not this server.
 */
export async function probeOwnPath(now = Date.now(), fetcher: typeof fetch = fetch, publicUrl: string = config.publicUrl): Promise<boolean> {
  if (!listRunners().some((runner) => runnerStanding(runner))) return false
  if (loopbackAddress(publicUrl)) return false
  let ok = false
  try {
    const target = new URL('/api/readyz', publicUrl)
    let answer = await fetcher(target, { signal: AbortSignal.timeout(10_000), redirect: 'manual' })
    const location = answer.status >= 300 && answer.status < 400 ? answer.headers.get('location') : null
    if (location !== null) {
      await answer.body?.cancel().catch(() => undefined)
      const next = new URL(location, target)
      if (target.protocol === 'http:' && next.protocol === 'https:' && next.hostname === target.hostname && next.pathname === target.pathname) {
        answer = await fetcher(next, { signal: AbortSignal.timeout(10_000), redirect: 'manual' })
      }
    }
    ok = answer.status === 200
    await answer.body?.cancel().catch(() => undefined)
  } catch {
    ok = false
  }
  noteProbe(ok, now)
  return ok
}

/**
 * At boot: what the previous life left half done. Offers it made are
 * withdrawn; outcomes it left `applying` are driven again; and a machine's
 * queue row whose lease is over (or missing) goes back to waiting, keeping
 * its place.
 */
export async function bootRemoteRunners(now = Date.now()): Promise<{ withdrawn: number; redriven: number; orphans: number }> {
  let withdrawn = 0
  for (const lease of leasesInState('offered')) if (withdrawLease(lease.attemptId, now, 'restart')) withdrawn++
  const redriven = await redriveApplying(now)
  let orphans = 0
  for (const row of heldRows()) {
    const lease = row.attemptId ? getLease(row.attemptId) : null
    if (lease && LIVE_LEASE_STATES.includes(lease.state)) continue
    if (requeueHeldRow(row, false)) {
      updateSubmission(row.submissionId, { state: 'queued', stage: 'queue' })
      orphans++
    }
  }
  if (withdrawn + redriven + orphans > 0) {
    console.log(`[runners] after restart: offers withdrawn ${withdrawn}, outcomes applied again ${redriven}, rows given back ${orphans}`)
  }
  return { withdrawn, redriven, orphans }
}

/** Start the clock and the probe: once, after the server listens (index.ts). */
export function startRemoteRunners(): void {
  if (tick) return
  void bootRemoteRunners().catch((error: unknown) => console.error('[runners] the boot pass failed', error))
  tick = setInterval(() => {
    try {
      remoteTick()
    } catch (error) {
      console.error('[runners] the clock pass failed', error)
    }
  }, TICK_MS)
  tick.unref?.()
  probe = setInterval(() => void probeOwnPath(), REMOTE_PROBE_MS)
  probe.unref?.()
  void probeOwnPath()
}

export function stopRemoteRunners(): void {
  if (tick) clearInterval(tick)
  if (probe) clearInterval(probe)
  tick = null
  probe = null
  // The held syncs are answered now rather than at the end of their hold: the server is closing, and they are what it would wait for.
  wakeAllRunners()
}

/** For tests: the silence a machine has on the clock now. */
export function silenceOf(runnerId: string, now = Date.now()): number {
  return now - Math.max(heardAt(runnerId) ?? remoteBootAt(), remoteBootAt())
}
