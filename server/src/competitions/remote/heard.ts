/**
 * What this server last heard from each machine, in memory and on its own
 * clock (§3.4, §5.1): when, from where, and the machine's whole state as its
 * last sync said it (free capacity, cards, what it has ready and fetches,
 * the attempts it holds, its problems) — and the evidence that the path to
 * the machines works at all.
 *
 * IN MEMORY, NOT IN THE DATABASE. A machine says all of this every ten to
 * twenty-five seconds, level-triggered: the next sync says it again, whole.
 * Written down it would be a write per heartbeat for state that is stale in
 * a minute, and after a restart of this server it is of no use anyway — the
 * machines are heard again within one round trip, which is exactly what the
 * boot grace waits for (REMOTE_BOOT_GRACE_MS). Three facts outlive the
 * process, each for a reason of its own: last_seen_at (the panel's «был на
 * связи», flushed at most once a minute), the machine's cards (the GPU door
 * asks about the last hour, decision 8), and the competitions it was asked to
 * hold (what `forget` is computed against: a competition closed or deleted
 * after a restart must still be forgotten).
 *
 * A module that imports only the remote store, on purpose: the door
 * (capabilities.ts), the forecast and the cards' share read it, and none of
 * them may pull the queue's pump (runner.ts) in behind it.
 */
import {
  REMOTE_BOOT_GRACE_MS,
  REMOTE_EVIDENCE_MS,
  REMOTE_GPU_SEEN_MS,
  REMOTE_SILENCE_MS,
  remoteCompatible,
  type RemoteCard,
  type RemoteProblem,
  type RemoteSyncRequest,
} from '@shared/remote-runner'
import type { RemoteMachineState } from '@shared/remote-admin'
import { homeRunnerBuild, listRunners, saveWantedCompetitions, wantedCompetitions, type RunnerRow } from './store.js'

interface Heard {
  /** The last call of any kind that authenticated, on this server's clock. */
  at: number
  address: string | null
  /** When last_seen_at was last written for it (REMOTE_SEEN_FLUSH_MS). */
  flushedAt: number
  /** Its last sync, as it sent it, and when. */
  sync: RemoteSyncRequest | null
  syncAt: number | null
  /** The digest of what the last sync reply said beyond its leases (routes.ts · newsDigest). */
  sentDigest: string | null
  /**
   * Competitions the replies have named in `want` and not forgotten since:
   * what `forget` is computed against. Read from the machine's row when this
   * life first hears of it (store.ts · wantedCompetitions) and written back
   * whenever it changes, so a restart forgets nothing it should forget.
   */
  wanted: Set<string>
}

const heard = new Map<string, Heard>()

/** When this life of the server began counting: nothing expires for REMOTE_BOOT_GRACE_MS after it. */
let bootAt = Date.now()

/** When the probe of PUBLIC_URL/api/readyz through the relay last passed (liveness.ts · probe). */
let probeOkAt: number | null = null

function entry(runnerId: string, now: number): Heard {
  let found = heard.get(runnerId)
  if (!found) {
    found = { at: now, address: null, flushedAt: 0, sync: null, syncAt: null, sentDigest: null, wanted: new Set(wantedCompetitions(runnerId)) }
    heard.set(runnerId, found)
  }
  return found
}

/** Any authenticated call: the machine is alive, and the path to it works. */
export function noteCall(runnerId: string, now: number, address: string | null): void {
  const found = entry(runnerId, now)
  found.at = Math.max(found.at, now)
  if (address) found.address = address
}

/** What changed in a machine's readiness since its previous sync: the log's image_ready, data_ready and problem lines. */
export interface SyncNews {
  first: boolean
  revisions: string[]
  data: string[]
  sealed: string[]
  problems: RemoteProblem[]
}

/** A sync came in: it replaces the machine's whole picture. Returns what is new in it, for the machine's log. */
export function noteSync(runnerId: string, request: RemoteSyncRequest, now: number, address: string | null): SyncNews {
  noteCall(runnerId, now, address)
  const found = entry(runnerId, now)
  const before = found.sync
  found.sync = request
  found.syncAt = now
  const had = (list: readonly string[] | undefined, value: string) => list?.includes(value) ?? false
  const problemKey = (p: RemoteProblem) => `${p.code}|${p.revisionId ?? ''}|${p.manifest ?? ''}|${p.bundleId ?? ''}|${p.detail}`
  const known = new Set((before?.problems ?? []).map(problemKey))
  return {
    first: before === null,
    revisions: before ? request.ready.revisions.filter((id) => !had(before.ready.revisions, id)) : [],
    data: before ? request.ready.data.filter((id) => !had(before.ready.data, id)) : [],
    sealed: before ? request.ready.sealed.filter((id) => !had(before.ready.sealed, id)) : [],
    problems: request.problems.filter((problem) => !known.has(problemKey(problem))),
  }
}

export function heardAt(runnerId: string): number | null {
  return heard.get(runnerId)?.at ?? null
}

export function heardAddress(runnerId: string): string | null {
  return heard.get(runnerId)?.address ?? null
}

export function lastSync(runnerId: string): RemoteSyncRequest | null {
  return heard.get(runnerId)?.sync ?? null
}

/** The attempts the machine's last sync listed: what home may count as accounted for in its free capacity. */
export function listedAttempts(runnerId: string): Set<string> | null {
  const sync = heard.get(runnerId)?.sync
  return sync ? new Set(sync.attempts.map((attempt) => attempt.id)) : null
}

export function sentDigest(runnerId: string): string | null {
  return heard.get(runnerId)?.sentDigest ?? null
}

export function noteSent(runnerId: string, digest: string, wanted: Iterable<string>, forgotten: Iterable<string>, now = Date.now()): void {
  const found = entry(runnerId, now)
  found.sentDigest = digest
  const size = found.wanted.size
  for (const id of wanted) found.wanted.add(id)
  let changed = found.wanted.size !== size
  for (const id of forgotten) changed = found.wanted.delete(id) || changed
  // Written only when the set moved: competitions open and close, syncs do not.
  if (changed) saveWantedCompetitions(runnerId, found.wanted)
}

/** Competitions named in this machine's `want` so far, across restarts: those no longer wanted are what `forget` names. */
export function wantedBefore(runnerId: string): ReadonlySet<string> {
  return heard.get(runnerId)?.wanted ?? new Set(wantedCompetitions(runnerId))
}

/**
 * Whether last_seen_at is due for this machine (at most once a minute), and
 * marks it written. Only once it has synced in this life: «был на связи» is
 * a machine that reported in, and one that joined and never synced keeps
 * last_seen_at empty, as RemoteMachine.lastSeenAt promises.
 */
export function seenDue(runnerId: string, now: number, everyMs: number): { at: number; address: string | null } | null {
  const found = heard.get(runnerId)
  if (!found || found.syncAt === null || now - found.flushedAt < everyMs || found.at <= found.flushedAt) return null
  found.flushedAt = now
  return { at: found.at, address: found.address }
}

/** A machine revoked or gone: what it said no longer counts for anything. */
export function forgetHeard(runnerId: string): void {
  heard.delete(runnerId)
}

/* ------------------------------------------------------------ the clock */

export function remoteBootAt(): number {
  return bootAt
}

/** Whether this life of the server is still in its boot grace: nothing expires yet (REMOTE_BOOT_GRACE_MS). */
export function inBootGrace(now: number): boolean {
  return now - bootAt < REMOTE_BOOT_GRACE_MS
}

/** The probe of PUBLIC_URL/api/readyz through the relay passed (`true`) or failed. */
export function noteProbe(ok: boolean, now: number): void {
  if (ok) probeOkAt = now
}

export function probePassedAt(): number | null {
  return probeOkAt
}

/**
 * PATH EVIDENCE (§3.4): whether a silence of `runnerId` means the machine is
 * gone rather than the road to it. Another machine heard within
 * REMOTE_EVIDENCE_MS says the relay and the tunnel carry calls; so does the
 * probe of this server's own address through the relay. Without either, the
 * silence may be the tunnel's — a frpc that lost its server, a relay
 * restarting — and a lease expired then would rerun every notebook in the
 * fleet the moment the tunnel came back.
 */
export function pathEvidence(now: number, except: string | null = null): boolean {
  if (probeOkAt !== null && now - probeOkAt <= REMOTE_EVIDENCE_MS) return true
  for (const [id, found] of heard) {
    if (id !== except && now - found.at <= REMOTE_EVIDENCE_MS) return true
  }
  return false
}

/** For the tests: a new life of the server, with nothing heard and its boot at `at`. */
export function resetHeard(at = Date.now()): void {
  heard.clear()
  bootAt = at
  probeOkAt = null
}

/* -------------------------------------------------------- what a machine is */

/**
 * The machine's state as the panel names it (RemoteMachineState), on this
 * server's clock. Most urgent first: a revoked or gone machine is that
 * whatever else is true of it; a silent one is losing its runs; a
 * quarantined or drained one takes nothing by the owner's word (or home's);
 * an outdated one finishes what it holds and takes nothing new.
 */
export function machineState(runner: RunnerRow, now: number): RemoteMachineState {
  if (runner.state === 'revoked') return 'revoked'
  if (runner.state === 'left') return 'left'
  const at = heardAt(runner.id) ?? runner.lastSeenAt
  if (at === null || now - at > REMOTE_SILENCE_MS) return 'silent'
  if (runner.state === 'draining' && runner.quarantinedAt !== null) return 'quarantined'
  const sync = lastSync(runner.id)
  if (runner.state === 'draining' || (sync !== null && sync.state !== 'active')) return 'draining'
  if (!remoteCompatible(homeRunnerBuild(), runner.build ?? '')) return 'outdated'
  return 'online'
}

/**
 * A LIVE machine (§5.7): active by the owner's word and its own, of home's
 * build, and heard within the silence — the only kind whose places the
 * forecast counts and whose free capacity the take trusts.
 */
export function liveRunner(runner: RunnerRow, now: number): boolean {
  return machineState(runner, now) === 'online' && lastSync(runner.id) !== null
}

/** A machine's cards as it last said them: from memory, or the row's echo after a restart. */
export function runnerCards(runner: RunnerRow): RemoteCard[] {
  return lastSync(runner.id)?.cards ?? runner.cards
}

/**
 * THE GPU DOOR'S QUESTION (decision 8): machines with cards heard within
 * REMOTE_GPU_SEEN_MS, revoked and gone ones aside, and the last machine with
 * cards heard at all (the editor's «была на связи 2 ч назад»). Not only live
 * ones: a GPU competition keeps taking uploads through a machine's restart,
 * an update or a quarter of an hour of a dead tunnel, and its notebooks wait
 * for the machine in the queue rather than being refused at the door.
 */
export function remoteCardsSeen(now = Date.now()): { recent: number; last: { name: string; at: number } | null; runners: RunnerRow[] } {
  let recent = 0
  let last: { name: string; at: number } | null = null
  const runners: RunnerRow[] = []
  for (const runner of listRunners()) {
    if (runner.state === 'revoked' || runner.state === 'left') continue
    if (runnerCards(runner).length === 0) continue
    const at = heardAt(runner.id) ?? runner.lastSeenAt
    if (at === null) continue
    if (now - at <= REMOTE_GPU_SEEN_MS) {
      recent++
      runners.push(runner)
    }
    if (!last || at > last.at) last = { name: runner.name, at }
  }
  return { recent, last, runners }
}
