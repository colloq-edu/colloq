/**
 * The machine's own files under its state root (COLLOQ_RUNNER_STATE, by
 * default /var/lib/colloq-runner, the same path inside the agent's container
 * and on the host): who it is to its home, the leases it holds, what each run
 * came to, and the status the health check reads.
 *
 *   runner.json              its identity: home, runner id, secret, the hash of
 *                            the code it joined with (0600; the code itself is
 *                            never written down)
 *   runner.json.<why>-<time> an identity put aside: revoked, left, or another home's
 *   status.json              what `runner status` prints, rewritten by the running agent
 *   agent.sock               the running agent's door for `runner drain` and `leave`
 *   leases/<attempt>.json    a lease, written down before the next sync says so
 *   leases/<attempt>.outcome.json   what the run came to, before a byte is uploaded
 *   books/                   what the caches know about themselves (cache.ts, images.ts)
 *   data/                    DATA_DIR: home's layout (competitions/storage.ts), §4.2
 *   placements/<id>-<role>.json   a class container (kernels.ts), written down before
 *                            `docker run`: what an agent restarted under a class adopts
 *   rooms/<id>/              a class folder's copy, mounted into the class's containers
 *                            (uid 1000, folders 2775, files 0664, as home's sessionDir)
 *   restart.marker           left by `colloq-host runner update` before it stops the
 *                            agent: the last sync then says `bye: restart`
 *
 * EVERY WRITE IS WHOLE OR NOT AT ALL: a temporary file next to the target,
 * flushed, then renamed over it. A machine dies the way rented VMs die,
 * mid-write, and a lease half written is a lease home counts on and the next
 * life of the agent cannot read; the rename leaves either the old file or the
 * new one. The identity and the leases are flushed to the disk before the
 * rename (durable before the next sync says they are held); the status, which
 * is rewritten every few seconds and only ever describes the present, is not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  REMOTE_DEVICE,
  REMOTE_JOIN_ID,
  REMOTE_RUNNER_ID,
  REMOTE_SECRET,
  REMOTE_SHA256,
  REMOTE_PROTOCOL,
  REMOTE_BUILD_DEV,
  parseRemoteOutcomeReply,
  parseRemoteOutcomeRequest,
  type RemoteDeclineReason,
  type RemoteLease,
  type RemoteResultFile,
  type RemoteRunOutcome,
} from '@shared/remote-runner'
import {
  REMOTE_CLASS_CONTAINER,
  REMOTE_ROOM_CPUS_MAX,
  parseRemoteKernelsReply,
  parseRemotePlacementKey,
  type RemotePlacementIntent,
} from '@shared/remote-kernels'
import { RUNTIME_MEMORY_MAX_MB, RUNTIME_MEMORY_MIN_MB } from '@shared/runtime'
import { COMPETITION_ATTEMPT_ID } from '@shared/competition-runtime'

/** Where the tree lives when COLLOQ_RUNNER_STATE names none: the path deploy/vast/colloq-host mounts. */
export const DEFAULT_STATE_ROOT = '/var/lib/colloq-runner'

export interface StateLayout {
  root: string
  identityFile: string
  statusFile: string
  socket: string
  leasesDir: string
  booksDir: string
  /** DATA_DIR as the agent requires it to be: home's layout lives under it. */
  dataDir: string
  /** The class containers' records (kernels.ts). */
  placementsDir: string
  /** The class folders' copies: one per class, shared by its containers on this machine (§8.1). */
  roomsDir: string
  /** Written by `colloq-host runner update` before it stops the agent (§14). */
  restartMarker: string
}

export function stateLayout(root: string): StateLayout {
  const at = path.resolve(root)
  return {
    root: at,
    identityFile: path.join(at, 'runner.json'),
    statusFile: path.join(at, 'status.json'),
    socket: path.join(at, 'agent.sock'),
    leasesDir: path.join(at, 'leases'),
    booksDir: path.join(at, 'books'),
    dataDir: path.join(at, 'data'),
    placementsDir: path.join(at, 'placements'),
    roomsDir: path.join(at, 'rooms'),
    restartMarker: path.join(at, 'restart.marker'),
  }
}

/* ------------------------------------------------------------ whole writes */

/**
 * Write `body` to `file` whole or not at all (see the header). `durable`
 * flushes the bytes before the rename and the directory after it.
 */
export function writeWhole(file: string, body: string | Uint8Array, options: { mode?: number; durable?: boolean } = {}): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(temporary, 'wx', options.mode ?? 0o600)
  try {
    fs.writeSync(fd, typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    if (options.durable) fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(temporary, file)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
  if (options.durable) syncDirectory(dir)
}

/** Flush a directory's entries (the rename above); a filesystem that cannot is no reason to fail. */
function syncDirectory(dir: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    /* not every filesystem lets a directory be flushed */
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** A JSON file's value; `null` — no file, or not JSON (cut short by a crash before whole writes, or by hand). */
export function readJson(file: string, limit = 4 * 1024 * 1024): unknown {
  try {
    if (fs.statSync(file).size > limit) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** A compact UTC time for file names: 20261014T013500Z, as colloq-host names what it puts aside. */
export function fileTime(at = Date.now()): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/* ---------------------------------------------------------------- identity */

/**
 * Who the machine is to its home. While a join is under way only `home`,
 * `joinId` and `codeSha256` are there: the join id is minted once and written
 * down before the first try, so that a join whose reply was lost is the same
 * join (REMOTE_JOIN_ID), home handing the same machine a new secret instead
 * of counting a second one against the code.
 */
export interface Identity {
  home: string
  joinId: string
  /**
   * When the join id was minted, on this machine's clock: home honours a
   * repeat of it for REMOTE_JOIN_REPEAT_MS only (sync.ts · joinWith). Absent
   * in an identity an earlier build wrote: as old as that.
   */
  joinIdAt?: number
  /** The sha256 of the code it joined (or is joining) with: a new code in COLLOQ_RUNNER_JOIN is told apart by it. */
  codeSha256: string
  runnerId?: string
  secret?: string
  trusted?: boolean
  approvedSlots?: number | null
  joinedAt?: number
  /** Home answered 401: the owner revoked it. */
  revokedAt?: number
  /** It revoked itself (`runner leave`). */
  leftAt?: number
}

/** A joined identity: one that can sign a call. */
export type Joined = Identity & { runnerId: string; secret: string }

export function joined(identity: Identity | null): identity is Joined {
  return !!identity && typeof identity.runnerId === 'string' && typeof identity.secret === 'string'
}

/** Whether the identity can no longer be used with its home: revoked by the owner, or left. */
export function retired(identity: Identity): boolean {
  return identity.revokedAt !== undefined || identity.leftAt !== undefined
}

const ORIGIN = /^https?:\/\/[^/?#\s]+$/

export function readIdentity(layout: StateLayout): Identity | null {
  const value = readJson(layout.identityFile, 64 * 1024) as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return null
  const text = (key: string, pattern: RegExp): string | undefined =>
    typeof value[key] === 'string' && pattern.test(value[key] as string) ? (value[key] as string) : undefined
  const time = (key: string): number | undefined => (Number.isSafeInteger(value[key]) ? (value[key] as number) : undefined)
  const home = text('home', ORIGIN)
  const joinId = text('joinId', REMOTE_JOIN_ID)
  const codeSha256 = text('codeSha256', REMOTE_SHA256)
  if (!home || !joinId || !codeSha256) return null
  const runnerId = text('runnerId', REMOTE_RUNNER_ID)
  const secret = text('secret', REMOTE_SECRET)
  return {
    home,
    joinId,
    ...(time('joinIdAt') !== undefined ? { joinIdAt: time('joinIdAt') } : {}),
    codeSha256,
    ...(runnerId && secret ? { runnerId, secret } : {}),
    ...(typeof value.trusted === 'boolean' ? { trusted: value.trusted } : {}),
    ...(value.approvedSlots === null || Number.isSafeInteger(value.approvedSlots) ? { approvedSlots: value.approvedSlots as number | null } : {}),
    ...(time('joinedAt') !== undefined ? { joinedAt: time('joinedAt') } : {}),
    ...(time('revokedAt') !== undefined ? { revokedAt: time('revokedAt') } : {}),
    ...(time('leftAt') !== undefined ? { leftAt: time('leftAt') } : {}),
  }
}

/** Written whole and flushed, 0600: it holds the machine's secret. */
export function writeIdentity(layout: StateLayout, identity: Identity): void {
  writeWhole(layout.identityFile, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, durable: true })
}

/**
 * Put the identity aside, under a name no agent reads (runner.json.<why>-<time>),
 * the way colloq-host's retire_identity does after a leave: a revoked or left
 * identity in place would greet the next join with a 401 for good. The caches
 * stay for the next join. Returns where it went; `null` — there was none.
 */
export function retireIdentity(layout: StateLayout, why: 'revoked' | 'left' | 'moved'): string | null {
  if (!fs.existsSync(layout.identityFile)) return null
  const kept = `${layout.identityFile}.${why}-${fileTime()}`
  fs.renameSync(layout.identityFile, kept)
  return kept
}

/* ------------------------------------------------------------------ leases */

/** A lease as the machine wrote it down, with when: its deadline counts from then (RemoteLease.deadlineMs). */
export interface StoredLease {
  lease: RemoteLease
  receivedAt: number
}

/**
 * What a run came to, written down before anything is uploaded: a restart
 * uploads it again rather than losing a finished run, and posts the very same
 * outcome, which home answers with the reply it cached for its digest.
 * `startedAt` is when the container started, on this machine's clock (null:
 * a decline before any container), for the runningMs every report after the
 * start carries.
 */
export type StoredOutcome =
  | { kind: 'finished'; outcome: RemoteRunOutcome; runJson: string | null; files: RemoteResultFile[]; startedAt: number; endedAt: number }
  | { kind: 'declined'; reason: RemoteDeclineReason; detail: string; startedAt: number | null }

const leaseFile = (layout: StateLayout, attemptId: string): string => path.join(layout.leasesDir, `${checkedAttempt(attemptId)}.json`)
const outcomeFile = (layout: StateLayout, attemptId: string): string => path.join(layout.leasesDir, `${checkedAttempt(attemptId)}.outcome.json`)

function checkedAttempt(attemptId: string): string {
  if (!COMPETITION_ATTEMPT_ID.test(attemptId)) throw new Error('Invalid attempt id')
  return attemptId
}

export function writeLease(layout: StateLayout, stored: StoredLease): void {
  writeWhole(leaseFile(layout, stored.lease.attemptId), JSON.stringify(stored), { mode: 0o600, durable: true })
}

export function writeOutcome(layout: StateLayout, attemptId: string, outcome: StoredOutcome): void {
  writeWhole(outcomeFile(layout, attemptId), JSON.stringify(outcome), { mode: 0o600, durable: true })
}

export function dropLease(layout: StateLayout, attemptId: string): void {
  fs.rmSync(leaseFile(layout, attemptId), { force: true })
  fs.rmSync(outcomeFile(layout, attemptId), { force: true })
}

/** A free picture that any parser takes, for checking a stored outcome with the contract's own parser. */
const NO_FREE = { slots: 0, memoryMb: 0, cpus: 0, gpuShares: 0, diskMb: 0 }

/**
 * The leases written down by an earlier life, each checked again with the
 * contract's own parsers: a file this code did not write whole (or a hand
 * that edited one) is dropped, never sent. A lease without its outcome comes
 * back with `outcome: null`.
 */
export function readLeases(layout: StateLayout): Array<StoredLease & { outcome: StoredOutcome | null }> {
  let names: string[]
  try {
    names = fs.readdirSync(layout.leasesDir)
  } catch {
    return []
  }
  const found: Array<StoredLease & { outcome: StoredOutcome | null }> = []
  for (const name of names) {
    const match = /^([a-f0-9]{32})\.json$/.exec(name)
    if (!match) continue
    const attemptId = match[1]!
    const stored = readJson(path.join(layout.leasesDir, name)) as StoredLease | null
    let lease: RemoteLease | null = null
    try {
      // The lease parser is the outcome reply's: one lease, at its own seq, trusted (a hidden-test lease was taken only while the machine was; home revokes it if that changed).
      if (stored && Number.isSafeInteger(stored.receivedAt) && stored.lease?.attemptId === attemptId) {
        lease = parseRemoteOutcomeReply({ result: 'applied', seq: stored.lease.seq, leases: [stored.lease], trusted: true }).leases[0] ?? null
      }
    } catch {
      lease = null
    }
    if (!lease || !stored) {
      dropLease(layout, attemptId)
      continue
    }
    found.push({ lease, receivedAt: stored.receivedAt, outcome: readOutcome(layout, attemptId) })
  }
  return found
}

function readOutcome(layout: StateLayout, attemptId: string): StoredOutcome | null {
  const value = readJson(outcomeFile(layout, attemptId)) as StoredOutcome | null
  if (!value || typeof value !== 'object') return null
  try {
    if (value.kind === 'finished') {
      parseRemoteOutcomeRequest({ protocol: REMOTE_PROTOCOL, build: REMOTE_BUILD_DEV, free: NO_FREE, kind: 'finished', outcome: value.outcome, runJson: value.runJson, files: value.files })
      return Number.isSafeInteger(value.startedAt) && Number.isSafeInteger(value.endedAt) ? value : null
    }
    if (value.kind === 'declined') {
      parseRemoteOutcomeRequest({ protocol: REMOTE_PROTOCOL, build: REMOTE_BUILD_DEV, free: NO_FREE, kind: 'declined', reason: value.reason, detail: value.detail })
      return value.startedAt === null || Number.isSafeInteger(value.startedAt) ? value : null
    }
  } catch {
    /* not one this code wrote */
  }
  return null
}

/* -------------------------------------------------------------- placements */

/**
 * A class container as the machine wrote it down (remote-classes.md §7.2):
 * the intent it was started for, whole, and what docker made of it. Written
 * before `docker run` and again once docker said the container's id, so that
 * an agent restarted at any moment finds every class container it started
 * (kernels.ts · adopt): by its id, or by the label that names its slot and gen.
 */
export interface StoredPlacement {
  intent: RemotePlacementIntent
  /** The container's full id; null — written before the run that makes it. */
  container: string | null
  /** The image it runs: the revision's tag (images.ts · revisionImage). */
  image: string
  /** The digest of what only a new container changes (kernels.ts · specDigest): an exited one is started again only for the same. */
  spec: string
  /** The memory and CPUs docker holds it to: a resize docker refused leaves the old ones here. */
  limits: { memoryMb: number; cpus: number }
  /** The whole card a GPU room holds while this record lives; null — none. */
  card: string | null
}

const PLACEMENT_FILE = /^([A-Za-z0-9_-]{1,64})-(room|own|council)\.json$/
const REVISION_TAG_IMAGE = /^colloq-revision:[a-f0-9]{32}$/

/** `<id>-<role>.json`, from a key the contract's pattern took: the role is the name's last part, whatever the id holds. */
function placementFile(layout: StateLayout, key: string): string {
  const slot = parseRemotePlacementKey(key)
  if (!slot) throw new Error('Invalid placement key')
  return path.join(layout.placementsDir, `${slot.sessionId}-${slot.role}.json`)
}

/** Written whole and flushed before it is relied on (0600: the intent holds the container's token). */
export function writePlacement(layout: StateLayout, stored: StoredPlacement): void {
  writeWhole(placementFile(layout, stored.intent.key), JSON.stringify(stored), { mode: 0o600, durable: true })
}

/**
 * A record gone. With `gen`, only a record of that very generation (or one
 * that names none): the late end of an older placement's start never takes
 * the record a newer one of the same slot has written since.
 */
export function dropPlacement(layout: StateLayout, key: string, gen?: number): void {
  const file = placementFile(layout, key)
  if (gen !== undefined) {
    const written = readJson(file, 256 * 1024) as { intent?: { gen?: unknown } } | null
    if (written && typeof written === 'object' && written.intent?.gen !== undefined && written.intent.gen !== gen) return
  }
  fs.rmSync(file, { force: true })
}

/**
 * The placements written down by an earlier life, each checked again with
 * the contract's own parser (the intent as the agent takes it from a reply)
 * and against its file's name. A record this build cannot read whole is not
 * one of them, and is not deleted either (unreadPlacements): written by an
 * older or a newer build, its container may hold a class's variables.
 */
export function readPlacements(layout: StateLayout): StoredPlacement[] {
  return placementFiles(layout).flatMap(({ stored }) => (stored ? [stored] : []))
}

/**
 * A record this build cannot read whole: one of an older or a newer shape
 * (a field a later release requires, a bound it tightened), or one edited
 * by hand. What it still says of its slot, as far as it says it: its gen and
 * the limits its container was held to (kernels.ts keeps that container, not
 * ready, until home names its slot again).
 */
export interface UnreadPlacement {
  key: string
  gen: number | null
  limits: { memoryMb: number; cpus: number } | null
}

export function unreadPlacements(layout: StateLayout): UnreadPlacement[] {
  return placementFiles(layout).flatMap(({ key, raw, stored }) => {
    if (stored) return []
    const v = (raw && typeof raw === 'object' ? raw : {}) as { intent?: { gen?: unknown }; limits?: { memoryMb?: unknown; cpus?: unknown } }
    const gen = v.intent?.gen
    const memoryMb = v.limits?.memoryMb
    const cpus = v.limits?.cpus
    const whole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
    return [{
      key,
      gen: typeof gen === 'number' && Number.isSafeInteger(gen) && gen >= 0 ? gen : null,
      limits: whole(memoryMb) && whole(cpus) ? { memoryMb, cpus } : null,
    }]
  })
}

/** Every record file by the name this code gives it, read and checked: `stored` when it parses whole, the raw value either way. */
function placementFiles(layout: StateLayout): Array<{ key: string; raw: unknown; stored: StoredPlacement | null }> {
  let names: string[]
  try {
    names = fs.readdirSync(layout.placementsDir)
  } catch {
    return []
  }
  const found: Array<{ key: string; raw: unknown; stored: StoredPlacement | null }> = []
  for (const name of names.sort()) {
    const match = PLACEMENT_FILE.exec(name)
    if (!match) continue
    const key = `${match[1]}:${match[2]}`
    const raw = readJson(path.join(layout.placementsDir, name), 256 * 1024)
    found.push({ key, raw, stored: placementOf(raw, key) })
  }
  return found
}

/** A record as written, or null. */
function placementOf(value: unknown, key: string): StoredPlacement | null {
  const v = value as Partial<StoredPlacement> | null
  if (!v || typeof v !== 'object') return null
  let intent: RemotePlacementIntent | undefined
  try {
    const block = { placements: [v.intent], pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [], rates: { classBulkMBps: 8, machinePaceMBps: 6 }, tunnel: 'closed' }
    intent = parseRemoteKernelsReply(block).placements[0]
  } catch {
    return null
  }
  const limits = v.limits as StoredPlacement['limits'] | undefined
  if (!intent || intent.key !== key
    || !(v.container === null || (typeof v.container === 'string' && REMOTE_CLASS_CONTAINER.test(v.container)))
    || typeof v.image !== 'string' || !REVISION_TAG_IMAGE.test(v.image) || typeof v.spec !== 'string' || !REMOTE_SHA256.test(v.spec)
    || !limits || !Number.isSafeInteger(limits.memoryMb) || limits.memoryMb < RUNTIME_MEMORY_MIN_MB || limits.memoryMb > RUNTIME_MEMORY_MAX_MB
    || !Number.isSafeInteger(limits.cpus) || limits.cpus < 1 || limits.cpus > REMOTE_ROOM_CPUS_MAX
    || !(v.card === null || (typeof v.card === 'string' && REMOTE_DEVICE.test(v.card)))) return null
  return { intent, container: v.container, image: v.image, spec: v.spec, limits: { memoryMb: limits.memoryMb, cpus: limits.cpus }, card: v.card }
}

/** `colloq-host runner update` left the marker: this stop is a restart (bye `restart`). */
export function restartMarked(layout: StateLayout): boolean {
  return fs.existsSync(layout.restartMarker)
}

export function clearRestartMarker(layout: StateLayout): void {
  fs.rmSync(layout.restartMarker, { force: true })
}

/* ------------------------------------------------------------------ status */

/**
 * The agent's state as `runner status` reports it, and the health check
 * every 30 s with it: `joining` until home answered the join; `active`,
 * `draining` and `leaving` while it syncs; `left`, `revoked`, `refused` (a
 * join home refused: the code is unknown, spent or expired) and `stopped`
 * once the agent no longer works for its home.
 */
export type AgentState = 'joining' | 'active' | 'draining' | 'leaving' | 'left' | 'revoked' | 'refused' | 'stopped'

/**
 * How the way to home was at the last call: `ok`; `home_offline` — the relay
 * says home's tunnel is down; `home_silent` — home does not answer and the
 * relay does not say its tunnel is down: a home that hangs, or a tunnel cut
 * that the relay has not seen yet (its word that the tunnel is up lags a cut
 * by its heartbeats), so whether the tunnel is up is unknown; `home_unknown` —
 * the relay serves no home by this name (the
 * address in COLLOQ_RUNNER_JOIN, or a home whose name was given up), which no
 * waiting mends; `unreachable` — neither home nor its relay answered (this
 * machine's network, or no relay in front of home); `refused` — home answered
 * with a refusal.
 */
export type HomePath = 'ok' | 'home_offline' | 'home_silent' | 'home_unknown' | 'unreachable' | 'refused'

export interface AgentStatus {
  joined: boolean
  home: string | null
  runnerId: string | null
  state: AgentState
  /** Attempts held: written down and not yet settled with home. */
  held: number
  version: string
  build: string
  homeVersion?: string
  /** Whether home takes this build (remoteCompatible); null — not heard yet. */
  compatible: boolean | null
  trusted: boolean | null
  /** The places home allows this machine at once (the owner's «Места»); null — no cap of home's, or not joined. */
  approvedSlots: number | null
  path: HomePath | null
  /** One line about what keeps it from working, for the owner; null — nothing. */
  problem: string | null
  pid: number
  startedAt: number
  /** When the agent last wrote this: a status older than STATUS_STALE_MS is no running agent's. */
  updatedAt: number
  /** When home last answered a sync (or the join). */
  syncedAt: number | null
  /**
   * The class tunnel (remote-classes.md §4.6): whether it is up, and its
   * round trip as the tunnel last measured it; null — none, since home asked
   * for none (no class here, or a home without classes).
   */
  tunnel?: { up: boolean; rttMs: number | null } | null
  /** The class containers held, by slot (§6.1): what `colloq-host runner status` shows beside the runs. */
  classes?: { room: number; own: number; council: number }
}

export function writeStatus(layout: StateLayout, status: AgentStatus): void {
  try {
    writeWhole(layout.statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 })
  } catch (error) {
    // The health check reads a stale status as unhealthy, which is the truth here.
    console.warn(`[runner] could not write ${layout.statusFile}: ${String(error)}`)
  }
}

export function readStatus(layout: StateLayout): AgentStatus | null {
  const value = readJson(layout.statusFile, 64 * 1024) as AgentStatus | null
  return value && typeof value === 'object' && typeof value.state === 'string' && Number.isSafeInteger(value.updatedAt) ? value : null
}
