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
 *   minute each;
 * - the classes' clock runs (remote-classes.md §11.1: kernel/remote/
 *   placement.ts · classTick, through heard.ts · ClassPort), on the
 *   same `now`, after a pass without class evidence is written down
 *   (noteClassBlind): a class's silence is proven by the classes' shorter
 *   rule, CLASS_EVIDENCE_MS.
 * EVERY THIRTY SECONDS, while any machine is connected, this server probes
 * its own PUBLIC_URL/api/readyz — through the relay, the way the machines
 * reach it — and a pass is path evidence for a minute; EVERY FIVE SECONDS
 * (CLASS_PROBE_MS) while any class placement lives, since a class fails over
 * after a minute of silence and its evidence counts for fifteen seconds
 * (probeTick).
 * EVERY HOUR, old leases and events go, and staging folders nothing needs.
 *
 * AT BOOT (startRemoteRunners): offers made by the previous life are
 * withdrawn (no machine has acked them to anyone alive), outcomes left
 * `applying` by a crash are driven again, and a machine's queue row without
 * a live lease (which no transaction here can leave, but a hand in the
 * database can) goes back to waiting.
 */
import dns from 'node:dns'
import os from 'node:os'
import { isIP } from 'node:net'
import { REMOTE_BLIND_MS, REMOTE_OFFER_MS, REMOTE_PROBE_MS, REMOTE_SEEN_FLUSH_MS, REMOTE_SILENCE_MS } from '@shared/remote-runner'
import { CLASS_PROBE_MS } from '@shared/remote-kernels'
import { config } from '../../config.js'
import { getBinding } from '../../dependencies/store.js'
import { runnerCardsHere, runnerGpuDevices } from '../gpu.js'
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
import { fitCache, homeTakes, rowNeedsCard, setUnfit } from './fit.js'
import { loopbackAddress } from './origin.js'
import {
  classPathEvidence,
  classPort,
  classPlacementsLive,
  heardAt,
  inBootGrace,
  loadClassPort,
  noteBlind,
  noteClassBlind,
  noteProbe,
  pathEvidence,
  provenSilence,
  remoteBootAt,
  seenDue,
} from './heard.js'
import { loseLease, orphanLease, withdrawLease } from './release.js'
import { LIVE_LEASE_STATES, driveInFlight, flushRunnerSeen, getLease, leasesInState, listStandingRunners, openLeases, pruneRemoteRows } from './store.js'
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
  // No path evidence at all at this pass: a silence is proven only from the next pass that has some (heard.ts · provenSilence).
  if (!pathEvidence(now)) noteBlind(now)
  // The same by the classes' rule, which counts evidence for a quarter of the time (heard.ts · classProvenSilence).
  if (!classPathEvidence(now)) noteClassBlind(now)
  // The classes' clock, on the same `now` (the tests drive both by hand), and apart: neither's failure stops the other's pass.
  try {
    classPort().classTick(now)
  } catch (error) {
    console.error('[runners] the classes\' clock pass failed', error)
  }
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
    /*
     * Lost for a silence only while the path is proven, and only for as much
     * of the silence as it was proven: after an outage every machine gets a
     * whole REMOTE_SILENCE_MS from the moment the evidence came back. Without
     * evidence, REMOTE_BLIND_MS of real silence all the same.
     */
    const proven = pathEvidence(now, lease.runnerId) && provenSilence(lease.runnerId, now) > REMOTE_SILENCE_MS
    if (!proven && silent <= REMOTE_BLIND_MS) continue
    if (loseLease(lease.attemptId, now, 'silent')) lost++
  }
  // The ceiling holds for a result being applied too: one that cannot be, by then, goes back to the queue (never one whose drive is under way).
  if (!grace) {
    for (const lease of leasesInState('applying')) {
      if (lease.deadlineAt > now || driveInFlight(lease.attemptId)) continue
      if (loseLease(lease.attemptId, now, 'unapplied')) lost++
    }
  }
  for (const runner of listStandingRunners()) {
    const due = seenDue(runner.id, now, REMOTE_SEEN_FLUSH_MS)
    if (due) flushRunnerSeen(runner.id, due.at, due.address)
  }
  if (now - prunedAt >= PRUNE_MS) {
    prunedAt = now
    pruneRemoteRows(now)
    sweepStaging()
  }
  settleUnfit(now)
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
 * unfitOutcome) — and the take never leases it to a machine. Where this
 * server's pump takes the row (fit.ts · homeTakes: its notebooks on, and a
 * GPU notebook only with cards of its own), the pump settles it the moment it
 * takes it; anywhere else nobody would — its notebooks off, or a GPU notebook
 * on a server with no card, which the pump passes over whatever the switch
 * says — and the row would wait for ever, with place 1 and no reason. So the
 * clock takes it as this server's own, settles it with the refusal and lets
 * the row go, all in one turn: no container, no machine, the participant told
 * how big their set is against the memory, exactly as a run here tells them.
 */
export function settleUnfit(now = Date.now()): number {
  if (queuePaused()) return 0
  let settled = 0
  const homeNotebooks = homeNotebooksSetting().value
  // This server takes GPU work on its own cards, or under the cluster on the cluster's (forecast.ts asks the same).
  const homeCards = !runnerCardsHere() || runnerGpuDevices().length > 0
  const cache = fitCache()
  for (const waiting of waitingNotebookOrder(now)) {
    if (homeTakes({ gpu: rowNeedsCard(waiting, cache), homeNotebooks, homeCards })) continue
    const competition = getCompetition(waiting.competitionId)
    const bundle = getBinding(waiting.submissionId)?.bundle ?? null
    if (!competition || !bundle || !setUnfit(bundle, competition)) continue
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
 *
 * AND NOT A NAME THAT LEADS BACK HERE. A literal loopback was the only one
 * refused, but PUBLIC_URL=http://lab-gpu:3000 on a Debian host resolves to
 * 127.0.1.1 through /etc/hosts, and one naming this host's own LAN address
 * goes out of the process and straight back in: the probe passed every 30 s
 * whatever the network did, and when the LAN or the uplink failed every run
 * on every machine was lost after three minutes. So the host is resolved
 * first (leavesHost), and a probe of an address that is loopback, unspecified
 * or link-local, or one of this host's own interfaces, is no evidence.
 */
export async function probeOwnPath(now = Date.now(), fetcher: typeof fetch = fetch, publicUrl: string = config.publicUrl, leaves: (url: string) => Promise<boolean> = leavesHost): Promise<boolean> {
  if (listStandingRunners().length === 0) return false
  if (loopbackAddress(publicUrl)) return false
  if (!(await leaves(publicUrl).catch(() => false))) return false
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

/** When the last probe started on the probe's clock, and whether one is in flight (probeTick). */
let probedAt = Number.NEGATIVE_INFINITY
let probing = false

/**
 * One beat of the probe's clock, every CLASS_PROBE_MS: a probe of this
 * server's own path (probeOwnPath) when one is due — every CLASS_PROBE_MS
 * while any class placement lives (heard.ts · classPlacementsLive), every
 * REMOTE_PROBE_MS otherwise — and never two at once: a probe through a dead
 * relay waits out its timeout, and a beat meanwhile starts none. Returns
 * whether it started one. `probe` is for the tests, which count them.
 *
 * Due half a beat early: the interval's beats are on the event loop's clock,
 * and by Date.now() one comes a millisecond before its time now and then. A
 * beat skipped for that put the next probe a whole beat later, ten seconds
 * of a class's fifteen of evidence.
 */
export function probeTick(now = Date.now(), probe: (now: number) => Promise<boolean> = (at) => probeOwnPath(at)): boolean {
  if (probing) return false
  if (now - probedAt < (classPlacementsLive() ? CLASS_PROBE_MS : REMOTE_PROBE_MS) - CLASS_PROBE_MS / 2) return false
  probedAt = now
  probing = true
  void probe(now)
    .catch(() => false)
    .finally(() => {
      probing = false
    })
  return true
}

/** For tests: the probe's clock as at a start, nothing probed and nothing in flight. */
export function resetProbeTick(): void {
  probedAt = Number.NEGATIVE_INFINITY
  probing = false
}

/** An address that never leaves this host whatever the network does: loopback, unspecified, link-local. */
function localOnly(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:(?=\d+\.)/, '')
  if (isIP(ip) === 4) return /^(?:127\.|0\.|169\.254\.)/.test(ip)
  if (isIP(ip) === 6) return ip === '::1' || ip === '::' || /^fe[89ab][0-9a-f]:/.test(ip)
  return false
}

/** This host's own addresses, by its interfaces (the container's own, when this server runs in one). */
function ownAddresses(): Set<string> {
  const out = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const one of list ?? []) out.add(one.address.toLowerCase().replace(/%.*$/, ''))
  }
  return out
}

/**
 * Whether a probe of `url` would have to leave this host: its name resolves
 * to no address that is this host's own (an interface's, or loopback,
 * unspecified, link-local). A name that does not resolve is not probed.
 * Exported for the tests, which pass their own resolver and interfaces.
 */
export async function leavesHost(
  url: string,
  resolve: (host: string) => Promise<string[]> = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((one) => one.address),
  own: () => Set<string> = ownAddresses,
): Promise<boolean> {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  const addresses = isIP(host) ? [host] : await resolve(host)
  if (addresses.length === 0) return false
  const mine = own()
  return addresses.every((address) => !localOnly(address) && !mine.has(address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '')))
}

/**
 * At boot: what the previous life left half done. Offers it made are
 * withdrawn; outcomes it left `applying` are driven again; a machine's
 * queue row whose lease is over (or missing) goes back to waiting, keeping
 * its place; and a lease whose queue row it no longer owns — a rollback ran
 * the row itself (release.ts · orphanLease) — is ended with no penalty, so
 * that the machine's next sync hears it and drops the run.
 */
export async function bootRemoteRunners(now = Date.now()): Promise<{ withdrawn: number; redriven: number; orphans: number; strays: number }> {
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
  let strays = 0
  for (const lease of openLeases()) if (orphanLease(lease.attemptId, now)) strays++
  if (withdrawn + redriven + orphans + strays > 0) {
    console.log(`[runners] after restart: offers withdrawn ${withdrawn}, outcomes applied again ${redriven}, rows given back ${orphans}, leases without their row ended ${strays}`)
  }
  if (strays > 0) wakeAllRunners()
  return { withdrawn, redriven, orphans, strays }
}

/** Start the clock and the probe: once, after the server listens (index.ts). `probe` stands in for probeOwnPath in the tests, which count its calls. */
export function startRemoteRunners(options: { probe?: (now: number) => Promise<boolean> } = {}): void {
  if (tick) return
  const probeNow = options.probe ?? ((at: number) => probeOwnPath(at))
  void bootRemoteRunners().catch((error: unknown) => console.error('[runners] the boot pass failed', error))
  // The classes' clock runs from the start, not from a class machine's first sync (heard.ts · loadClassPort).
  void loadClassPort().catch((error: unknown) => console.error('[runners] the class placements could not be loaded', error))
  tick = setInterval(() => {
    try {
      remoteTick()
    } catch (error) {
      console.error('[runners] the clock pass failed', error)
    }
  }, TICK_MS)
  tick.unref?.()
  // Beats at the classes' cadence; a probe is due at each only while a class placement lives (probeTick).
  probe = setInterval(() => probeTick(Date.now(), probeNow), CLASS_PROBE_MS)
  probe.unref?.()
  probeTick(Date.now(), probeNow)
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
