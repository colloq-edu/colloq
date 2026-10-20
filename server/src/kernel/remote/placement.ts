/**
 * Where a class's slots run, at home («занятия на машинах»,
 * docs/architecture/remote-classes.md §6, §11): the chooser, the asynchronous
 * ensure over the sync, the state of every placement and its link, liveness
 * and failover on the class clock, and what the machines' sync and the
 * kernel hooks read of it.
 *
 * ONE PLACEMENT IS ONE SLOT ON ONE MACHINE AT ONE GENERATION. Its row
 * (placement-store.ts) is the truth, written in transactions fenced by the
 * gen; the machine's reports, the links and the waiters live in memory, as
 * heard.ts keeps a machine's sync, and a restart of this server re-derives
 * them: the rows survive, the agents keep their containers, the boot grace
 * holds every failover while tunnels come back, and the next ensure of each
 * kernel opens a fresh loopback port for the same identity.
 *
 * CONTROL IS LEVEL-TRIGGERED, AS FOR LEASES. Home never pushes: a placement
 * written, stopped or resized is what the next reply's `kernels.placements`
 * says (`wantedPlacements`, the whole wanted set: a slot left out is one the
 * machine removes), and `wakeRunner` answers its held sync early. The
 * machine's next sync says what it holds (`noteKernelsReport`): a lost reply
 * is a delay, never a lost order.
 *
 * FAILOVER ONLY ON PROOF (§11.1, D13). A tunnel down with syncs still coming
 * is a machine alive but unreachable: the class waits, and moves only after
 * CLASS_TUNNEL_STUCK_MS. A tunnel down and no sync is a silence, and a
 * silence counts only while this server has path evidence (another machine
 * heard, or its own probe passed, within CLASS_EVIDENCE_MS) and only from the
 * end of the last stretch without it; nothing moves in the boot grace, in a
 * `bye: 'restart'` grace, or for a class that said «ждать машину». Revoke,
 * «Не принимает занятия», leave, a perimeter that failed closed and
 * «Перенести сейчас» move at once. A move is one transaction (`lost` with its
 * cause), then the link answers `lost`, the listener closes, every gate is
 * rejected with PlacementLost and the hooks hear the event; the next ensure
 * places the slot again at the next gen, on another machine or here.
 *
 * WHAT NEVER LEAVES HOME: SESSION_SECRET. A placement's Jupyter token is
 * derived from it per slot, machine and gen (placementToken), so a restart
 * re-derives it with nothing stored, and no event, view or log carries it.
 */
import { createHmac } from 'node:crypto'
import { getLocale, tr } from '@shared/i18n'
import {
  CLASS_BYE_GRACE_MS,
  CLASS_EVIDENCE_MS,
  CLASS_HELP_PAD_MAX_MS,
  CLASS_QUARANTINE_FAILOVERS,
  CLASS_QUARANTINE_WINDOW_MS,
  CLASS_START_MS,
  CLASS_TUNNEL_STUCK_MS,
  CLASS_UNREACHABLE_NOTE_MS,
  COUNCIL_WORKERS,
  REMOTE_BLOCKED_CIDRS_MAX,
  REMOTE_PIDS,
  REMOTE_PLACEMENTS_MAX,
  REMOTE_READINGS_MAX,
  REMOTE_ROOM_CPUS_MAX,
  REMOTE_SHM,
  remotePlacementKey,
  remoteRevisionDigest,
  type PostmortemReading,
  type RemoteBye,
  type RemoteClassFacts,
  type RemoteKernelsRequest,
  type RemotePlacementHeld,
  type RemotePlacementIntent,
} from '@shared/remote-kernels'
import {
  REMOTE_BOOT_GRACE_MS,
  REMOTE_CONTAINER_CUSHION_MB,
  remoteCompatible,
  type RemoteWantRevision,
} from '@shared/remote-runner'
import {
  RUNTIME_MEMORY_MAX_MB,
  RUNTIME_MEMORY_MIN_MB,
  RuntimeEndpointError,
  checkRuntimeEndpoint,
  type RuntimeStartFailure,
} from '@shared/runtime'
import { processClock, type TunnelClock } from '@shared/remote-tunnel'
import { CLASS_PLACEMENT_DEFAULT, storedClassPlacement, type ClassPlacement } from '@shared/admin'
import type { EnvironmentRevision } from '@shared/dependencies'
import { config } from '../../config.js'
import { placedSessions, sessionEnvironment } from '../../db.js'
import { activeName } from '../../environments.js'
import { instanceTimeZone } from '../../time-zone.js'
import { captureRevision } from '../../dependencies/revisions.js'
import { getRevision } from '../../dependencies/store.js'
import { heardAt, inBootGrace, lastSync, listedAttempts, liveRunner, probePassedAt, remoteBootAt, runnerCards } from '../../competitions/remote/heard.js'
import {
  getRunner,
  homeRunnerBuild,
  listStandingRunners,
  liveLeases,
  remoteEvent,
  runnerEventsOf,
  runnerStanding,
  updateRunner,
  type RunnerRow,
} from '../../competitions/remote/store.js'
import { wakeRunner } from '../../competitions/remote/wake.js'
import { gpuRevision, portableRevision } from '../../competitions/remote/want.js'
import { stepClaim } from '../../competitions/remote/fit.js'
import { RuntimeRequestError } from '../runtime-client.js'
import type { KernelEndpoint, KernelLink } from '../jupyter.js'
import { kernelLimits, roomShm, type LimitOutcome } from '../pool.js'
import { blockedCidrsSetting, roomHardening } from '../perimeter.js'
import { ROOM_SHM, classHashSeed, type RoomRole } from '../room-spec.js'
import { machineTunnels, type MachineTunnels } from './tunnel.js'
import {
  classPlacement,
  classPlacementRows,
  livePlacement,
  livePlacementRows,
  machinePlaced,
  placementRow,
  runnerPlacementRows,
  updatePlacement,
  wantsMachines,
  writePlacement,
  type PlacementRow,
  type PlacementState,
} from './placement-store.js'

export { machinePlaced }

/* ------------------------------------------------------------------ numbers */

/** On top of a placement's memory, the free memory a machine must still have: the stale-capacity rule's cushion (lease.ts · runnerRoom). */
const PLACEMENT_CUSHION_MB = REMOTE_CONTAINER_CUSHION_MB
/** A machine that hosted the class this recently keeps its folder copy warm, and is preferred (§6.3). */
const LAST_HOST_MS = 7 * 24 * 60 * 60_000
/** Above this p95 the form says «далеко: +N мс на ячейку» (§6.3). */
const FAR_RTT_MS = 150
/**
 * A machine heard this recently still syncs (§11.1 «Tunnel down, syncs
 * arriving»): one holding placements is held at most REMOTE_HOLD_BUSY_MS a
 * sync (routes.ts · syncHold), so a live one is heard well within it. Never
 * the class's failoverSec: a machine silent on both channels is a silence
 * whatever the class waits for, and only path evidence proves one.
 */
const SYNCS_COMING_MS = CLASS_EVIDENCE_MS
/** How long an owner's stop of a machine slot waits for the machine to say it is gone. */
const STOP_WAIT_MS = 30_000
/** A stop on a machine silent this long is done as far as home is concerned (classTick). */
const STOPPING_SILENT_MS = 5 * 60_000
/** How long a resize waits for the machine's `docker update` to be answered. */
const RESIZE_WAIT_MS = 30_000
/** How long a post-mortem question waits for the machine's reading (§7.4). */
const READING_WAIT_MS = 10_000
/** A slot moved off a machine does not go back to it for this long: «Перенести на сервер» means away from it. */
const AVOID_MS = CLASS_QUARANTINE_WINDOW_MS
/** A class's revision is looked up again this often; one that could not be found, sooner. */
const REVISION_TTL_MS = 10 * 60_000
const REVISION_RETRY_MS = 60_000
/** The classes on machines are looked through for their images this often (classTick). */
const PREFETCH_EVERY_MS = 60_000
/** Memory of slots that live nowhere is let go this often (forgetIdleSlots). */
const FORGET_EVERY_MS = 60 * 60_000
/** A council pool starts with this many workers when the class says `auto` (§9.5: min(4, auto)); K7b grows it. */
const COUNCIL_START_WORKERS = Math.min(4, COUNCIL_WORKERS.auto)
/** A council container's memory beyond its workers' ceilings (§9.5). */
const COUNCIL_EXTRA_MB = 512

const HOME = { where: 'home' } as const

/* -------------------------------------------------------------------- types */

/** Where one slot of a class runs, as the kernel hooks and the panel read it. */
export type PlacementView =
  | { where: 'home' }
  | {
      where: 'machine'
      runnerId: string
      /** The machine's name: for staff only (§13.1 «Data path»); students read «на машине». */
      name: string
      gen: number
      state: 'starting' | 'ready' | 'unreachable' | 'stopping'
      /** The placement's road (KernelEndpoint.link); null while it starts (nothing runs to reach yet) or stops. */
      link: KernelLink | null
      /** When it entered its state, on this server's clock. */
      since: number
      failover: 'auto' | 'wait'
      /** When it moves by itself if nothing changes; null — it is reachable, or waits for the machine. */
      failoverAt: number | null
    }

/** Why a slot left its machine (§11.1): the reason is the row's, the words the room's. */
export type FailoverCause = 'silence' | 'tunnel' | 'revoked' | 'unclassed' | 'leaving' | 'perimeter' | 'moved' | 'blocked'

/** The causes that count for the class quarantine (D32): the machine went quiet for its classes, by no one's hand. */
const LIVENESS_CAUSES: ReadonlySet<FailoverCause> = new Set(['silence', 'tunnel'])

/**
 * A slot's placement was lost while something waited on it (a gate, a
 * start): the words are the room's failover note, the cause what moved it.
 */
export class PlacementLost extends Error {
  constructor(
    readonly words: string,
    readonly cause: FailoverCause,
  ) {
    super(words)
    this.name = 'PlacementLost'
  }
}

export type PlacementEventKind =
  /** A placement was written; the machine is starting its container. */
  | 'starting'
  /** The machine reported it ready and its echoes passed. */
  | 'ready'
  /** Its machine's tunnel went down (no words), and again after CLASS_UNREACHABLE_NOTE_MS with the room's words. */
  | 'unreachable'
  /** Reachable again; words only when the note had gone out. */
  | 'back'
  /** «Перенести сейчас» was pressed: the move follows at once. */
  | 'moving'
  /** Failed over: the room's failover note in the words, the cause beside it. */
  | 'lost'
  /** A slot lost before runs again (on another machine, or here). */
  | 'moved'
  /** The machine says the slot's container is not running now (a death, a recreate at the same gen). */
  | 'restarting'
  /** The machine could not start it: the words say why. */
  | 'failed'
  /** No machine was eligible and the class starts here instead (its fallback). */
  | 'fallback'
  /** A stop was asked of the machine, and done. */
  | 'stopping'
  | 'stopped'

export interface PlacementEvent {
  sessionId: string
  role: RoomRole
  kind: PlacementEventKind
  view: PlacementView
  /** The room's words, naming the machine (§13.2): students' variants without the name are the hooks'. */
  words?: string
  /** The staff's longer words while unreachable: until when this server waits (§13.2 «Waiting (staff)»). */
  staffWords?: string
  /** Why: a failover's cause (lost, moving), or `updating` while the machine's agent restarts for an update (`bye: 'restart'`). */
  cause?: FailoverCause | 'updating'
  /** For `lost`: when the machine last reported the class's slots, the files' «по 14:31:58» until files travel (§8.8). */
  filesAt?: number
  at: number
}

/** What the tunnel module gives a placement: the process's machineTunnels() unless a test injects its own. */
export type PlacementTunnels = Pick<MachineTunnels, 'listen' | 'link' | 'lost' | 'isUp' | 'since' | 'rtt' | 'onChange'>

/** Why a machine cannot take a slot now, the first filter it failed (§6.3). */
export type MachineRefusal =
  | 'not-live'
  | 'classes-off'
  | 'quarantined'
  | 'sealed'
  | 'tunnel'
  | 'facts'
  | 'host-network'
  | 'perimeter'
  | 'canary'
  | 'same-daemon'
  | 'image'
  /** It holds REMOTE_PLACEMENTS_MAX placements already: as many as one reply may name, and its report may list. */
  | 'full'
  | 'memory'
  | 'cpus'
  | 'card'
  | 'avoided'

/** Why no machine can take any slot of the class: before any machine is asked. */
export type ClassRefusal = 'not-portable' | 'blocked-ranges' | 'no-machines'

/** One machine as the form's live line reads it (§13.1 Z4). */
export interface MachineOutlook {
  runnerId: string
  name: string
  refusal: MachineRefusal | null
  freeMb: number | null
  cards: number
  rttP95Ms: number | null
  /** Over FAR_RTT_MS: «далеко: +N мс на ячейку». */
  far: boolean
}

export interface ClassPlacementsOptions {
  /** The class clock: the gates', the starts', the stops' and the notes' timers. The process's by default. */
  clock?: TunnelClock
  /** The tunnels; the process's (machineTunnels(), read at every use) by default. */
  tunnels?: PlacementTunnels
  /** A class environment's revision; this server's own image of it by default (dependencies/revisions.ts · captureRevision). */
  revisionOf?: (environment: string) => Promise<EnvironmentRevision | null>
  log?: (line: string) => void
}

/** What a slot needs of a machine: the pinned image, a card or not, and its numbers. */
interface Need {
  sessionId: string
  role: RoomRole
  environment: string
  revision: { id: string; ref: string; layers: string }
  /** The revision's GPU bit (want.ts · gpuRevision): what the prefetch and the machines' smoke test read. */
  gpuImage: boolean
  /** A whole card for the slot (§6.5): a GPU environment's class room alone. */
  card: boolean
  memoryMb: number
  cpus: number
  workers: number | null
}

/** A machine's last kernels block, kept as it said it. */
interface MachineReport {
  /** Which report of the machine this is, counted from 1 in this life. */
  index: number
  at: number
  /** How many replies had been built for the machine before it came (wantedPlacements). */
  afterReply: number
  held: Map<string, RemotePlacementHeld>
  facts: RemoteClassFacts
  tunnel: 'up' | 'down'
  bye: RemoteBye | null
  /** When the machine first said `bye: 'restart'` in this run of them: the grace counts from it. */
  restartAt: number | null
}

interface ReadyWaiter {
  gen: number
  /** The report index at which it began: a failure said before is not this start's. */
  since: number
  resolve(row: PlacementRow): void
  reject(error: unknown): void
}

interface ResizeWaiter {
  gen: number
  /** Replies built before the change: the outcome must come in a report that followed a reply carrying it. */
  afterReply: number
  resolve(outcome: LimitOutcome): void
}

interface ReadingWaiter {
  gen: number
  since: number
  resolve(reading: PostmortemReading | null): void
}

/** What memory holds of one slot: the waiters, the outage, the cached endpoint. */
interface Slot {
  gen: number
  unreachableSince: number | null
  /** The unreachable note went out for this outage. */
  noted: boolean
  /** When the row entered its state, as far as this life saw it. */
  stateSince: number | null
  gates: Set<{ resolve(): void; reject(error: unknown): void }>
  ready: Set<ReadyWaiter>
  resizes: Set<ResizeWaiter>
  stops: Set<() => void>
  readings: Set<ReadingWaiter>
  listener: { port: number; close(): void } | null
  endpoint: KernelEndpoint | null
  /** The container the endpoint was made for. */
  endpointOf: string | null
  /** A loss this slot has not yet come back from: the next placement says «moved», and runs the image the lost one ran. */
  movedFrom: { runnerId: string; at: number } | null
  /** The machine it does not go back to soon after leaving it. */
  avoid: { runnerId: string; until: number } | null
  /** When the machine first reported this gen's start failed, since it was last ready: the start is given up CLASS_START_MS on. */
  failingSince: number | null
}

const slotKey = (sessionId: string, role: RoomRole): string => remotePlacementKey(sessionId, role)
const keyOf = (row: Pick<PlacementRow, 'sessionId' | 'role'>): string => slotKey(row.sessionId, row.role)

/* ---------------------------------------------------------------- the token */

/**
 * A placement's Jupyter token (§6.9): HMAC-SHA256 of the instance secret and
 * the slot, the machine and the gen, cut to forty hex digits, beside
 * roomToken (pool.ts). Deterministic, so a restart of this server derives it
 * again with nothing stored; another for every gen and every machine, so a
 * machine that held the slot once opens nothing of its next placement.
 */
export function placementToken(sessionId: string, role: RoomRole, runnerId: string, gen: number): string {
  return createHmac('sha256', config.sessionSecret).update(`placement:${sessionId}:${role}:${runnerId}:${gen}`).digest('hex').slice(0, 40)
}

/* ---------------------------------------------------------------- the words */

/** «14:32:05» in the instance's zone: when the room's notes say a machine went quiet. */
function clockOf(at: number): string {
  try {
    return new Intl.DateTimeFormat(getLocale(), { timeZone: instanceTimeZone(), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at)
  } catch {
    return new Date(at).toISOString().slice(11, 19)
  }
}

/** «0:12»: how long a machine has been unreachable, as the chip's timer says it. */
function elapsedOf(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/* ------------------------------------------------------------- the numbers */

const clampMemory = (mb: number): number => Math.min(RUNTIME_MEMORY_MAX_MB, Math.max(RUNTIME_MEMORY_MIN_MB, Math.floor(mb)))
/** Cores as the contract carries them: whole, one to REMOTE_ROOM_CPUS_MAX; a fractional instance default is rounded up. */
const clampCpus = (cpus: number): number => Math.min(REMOTE_ROOM_CPUS_MAX, Math.max(1, Math.ceil(cpus)))
const clampPids = (pids: number): number => Math.min(REMOTE_PIDS.max, Math.max(REMOTE_PIDS.min, Math.floor(pids)))

let shmWarned = false

/**
 * A GPU room's `--shm-size` for an intent: this server's own (pool.ts ·
 * roomShm), checked by the contract's pattern first, since the agent
 * refuses a whole reply over an intent outside it. A KERNEL_SHM docker would
 * not read either goes out as the default, said once.
 */
function intentShm(): string {
  const shm = roomShm()
  if (REMOTE_SHM.test(shm)) return shm
  if (!shmWarned) {
    shmWarned = true
    console.warn(`[classes] KERNEL_SHM=${shm} is not a size docker reads; classes on machines get ${ROOM_SHM}`)
  }
  return ROOM_SHM
}

/** This server's blocked ranges as a machine may be told them: valid, and few enough for one intent (§7.6, REMOTE_BLOCKED_CIDRS_MAX). */
function homeRanges(): { cidrs: string[]; placeable: boolean; keepable: boolean } {
  const { cidrs, invalid } = blockedCidrsSetting()
  const keepable = cidrs.length <= REMOTE_BLOCKED_CIDRS_MAX
  return { cidrs, placeable: keepable && invalid.length === 0, keepable }
}

/* ---------------------------------------------------------------- the class */

/**
 * The placements of this home. One per process (classPlacements); tests make
 * their own, on their own clock and tunnels, and install it with
 * usePlacements.
 */
export class ClassPlacements {
  private readonly clock: TunnelClock
  private readonly log: (line: string) => void
  private readonly revisionOf: (environment: string) => Promise<EnvironmentRevision | null>
  private readonly injected: PlacementTunnels | null
  private subscribed: { tunnels: PlacementTunnels; stop: () => void } | null = null
  private readonly slots = new Map<string, Slot>()
  private readonly machines = new Map<string, MachineReport>()
  private readonly reports = new Map<string, number>()
  private readonly replies = new Map<string, number>()
  /** Post-mortem questions not yet answered, by machine: key → gen. */
  private readonly asked = new Map<string, Map<string, number>>()
  private readonly ensuring = new Map<string, Promise<KernelEndpoint | null>>()
  private readonly listeners = new Set<(event: PlacementEvent) => void>()
  /** Each class environment's revision as last found, and whether a class set to machines uses it. */
  private readonly revisions = new Map<string, { revision: EnvironmentRevision | null; at: number; pending: Promise<EnvironmentRevision | null> | null; wanted: boolean }>()
  /** The last pass of the class clock with no class path evidence: a silence is proven only from there on. */
  private blindAt: number | null = null
  /** Machines whose fail-closed perimeter was written to their log in this episode. */
  private readonly failing = new Set<string>()
  private prefetchedAt = Number.NEGATIVE_INFINITY
  private forgottenAt = Number.NEGATIVE_INFINITY
  private closed = false

  constructor(options: ClassPlacementsOptions = {}) {
    this.clock = options.clock ?? processClock
    this.log = options.log ?? ((line) => console.log(line))
    this.revisionOf = options.revisionOf ?? (async (environment) => captureRevision(environment))
    this.injected = options.tunnels ?? null
  }

  /** The tunnels in use, subscribed to: a test's, or the process's as it is now (useMachineTunnels may change it). */
  private tunnels(): PlacementTunnels {
    const tunnels = this.injected ?? machineTunnels()
    if (!this.closed && this.subscribed?.tunnels !== tunnels) {
      this.subscribed?.stop()
      this.subscribed = { tunnels, stop: tunnels.onChange((runnerId) => this.tunnelChanged(runnerId)) }
    }
    return tunnels
  }

  /** Stop listening and let every waiter go: a test's teardown, or a home stopping. */
  close(): void {
    this.closed = true
    this.subscribed?.stop()
    this.subscribed = null
    for (const slot of this.slots.values()) {
      for (const gate of slot.gates) gate.resolve()
      for (const waiter of slot.ready) waiter.reject(new Error('Class placements closed'))
      for (const waiter of slot.resizes) waiter.resolve('pending')
      for (const stop of slot.stops) stop()
      for (const waiter of slot.readings) waiter.resolve(null)
      slot.listener?.close()
    }
    this.slots.clear()
  }

  private slot(sessionId: string, role: RoomRole, gen: number): Slot {
    const key = slotKey(sessionId, role)
    let slot = this.slots.get(key)
    if (!slot) {
      slot = {
        gen, unreachableSince: null, noted: false, stateSince: null, gates: new Set(), ready: new Set(), resizes: new Set(), stops: new Set(),
        readings: new Set(), listener: null, endpoint: null, endpointOf: null, movedFrom: null, avoid: null, failingSince: null,
      }
      this.slots.set(key, slot)
    }
    if (slot.gen !== gen) {
      // Another placement of the slot: what memory held of the previous one is over (its waiters were settled with it).
      slot.gen = gen
      slot.unreachableSince = null
      slot.noted = false
      slot.stateSince = null
      slot.failingSince = null
      slot.listener?.close()
      slot.listener = null
      slot.endpoint = null
      slot.endpointOf = null
    }
    return slot
  }

  /* --------------------------------------------------------------- events */

  onPlacementChange(listener: (event: PlacementEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: Omit<PlacementEvent, 'at'>, at: number): void {
    const full: PlacementEvent = { ...event, at }
    for (const listener of [...this.listeners]) {
      try {
        listener(full)
      } catch (error) {
        this.log(`[classes] a listener of ${event.sessionId}/${event.role} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /* ----------------------------------------------------------------- views */

  placementOf(sessionId: string, role: RoomRole): PlacementView {
    const row = livePlacement(sessionId, role)
    return row ? this.viewOf(row, this.clock.now()) : HOME
  }

  private viewOf(row: PlacementRow, now: number): PlacementView {
    if (!(['starting', 'ready', 'unreachable', 'stopping'] as PlacementState[]).includes(row.state)) return HOME
    const setting = classPlacement(row.sessionId)
    const slot = this.slots.get(keyOf(row))
    const state = row.state as 'starting' | 'ready' | 'unreachable' | 'stopping'
    return {
      where: 'machine',
      runnerId: row.runnerId,
      name: getRunner(row.runnerId)?.name ?? row.runnerId,
      gen: row.gen,
      state,
      // No link for a gen not running yet: the tunnel keeps a link until its listener closes, and one that never got a listener stays.
      link: state === 'stopping' || state === 'starting' ? null : this.tunnels().link(row.runnerId, keyOf(row), row.gen),
      since: (slot?.gen === row.gen ? (state === 'unreachable' ? slot.unreachableSince : slot.stateSince) : null) ?? (state === 'ready' ? row.readyAt : null) ?? row.createdAt,
      failover: setting.failover,
      failoverAt: this.failoverAt(row, setting, now),
    }
  }

  /** When an unreachable slot moves by itself, if nothing changes: the earlier of its two rules, after every grace. */
  private failoverAt(row: PlacementRow, setting: ClassPlacement, now: number): number | null {
    if (setting.failover === 'wait' || row.state === 'stopping' || this.tunnels().isUp(row.runnerId)) return null
    const slot = this.slots.get(keyOf(row))
    const downSince = slot?.gen === row.gen && slot.unreachableSince !== null ? slot.unreachableSince : this.tunnels().since(row.runnerId)
    const heard = Math.max(heardAt(row.runnerId) ?? remoteBootAt(), remoteBootAt())
    const failoverMs = setting.failoverSec * 1000
    // The rule dueFailover would apply: the stuck tunnel's while the machine's syncs still come, the silence's once they stopped.
    let at = now - heard <= SYNCS_COMING_MS
      ? downSince + CLASS_TUNNEL_STUCK_MS
      : Math.max(heard, this.blindAt ?? Number.NEGATIVE_INFINITY) + failoverMs
    at = Math.max(at, remoteBootAt() + REMOTE_BOOT_GRACE_MS)
    const restartAt = this.machines.get(row.runnerId)?.restartAt ?? null
    if (restartAt !== null) at = Math.max(at, restartAt + CLASS_BYE_GRACE_MS)
    return Math.max(at, now)
  }

  /** For a waiting cell's or the slow start's words: «Запускаем ядро на машине «vast-3»… образ ↓ 45 %». Null — the slot is not starting on a machine. */
  startingWords(sessionId: string, role: RoomRole): string | null {
    const row = livePlacement(sessionId, role)
    if (!row || row.state !== 'starting') return null
    const machine = getRunner(row.runnerId)?.name ?? row.runnerId
    const held = this.machines.get(row.runnerId)?.held.get(keyOf(row))
    const fetching = lastSync(row.runnerId)?.fetching.find((fetch) => fetch.revisionId === row.revision.id)
    if ((held === undefined || held.phase === 'pulling') && fetching) return tr('server.startingTheKernelOnMachineImage.1f4cdc', { machine, percent: Math.round(fetching.percent) })
    return tr('server.startingTheKernelOnMachine.c2d7a3', { machine })
  }

  /** min(1000, 2 × RTT p95) for a machine placement, its RTT's average until a p95 exists; 0 here (§5.6). */
  helpPadMs(sessionId: string, role: RoomRole): number {
    const row = livePlacement(sessionId, role)
    if (!row || row.state === 'stopping') return 0
    const rtt = this.tunnels().rtt(row.runnerId)
    const base = rtt.p95Ms ?? rtt.ewmaMs ?? 0
    return Math.min(CLASS_HELP_PAD_MAX_MS, Math.round(2 * base))
  }

  /* ------------------------------------------------------------------ gate */

  /**
   * The pump's gate (§5.3): at once here, for a starting or reachable
   * placement and for one that stops; while it is unreachable, until it is
   * back (or stops), and rejected with PlacementLost when it moves. Under
   * «ждать машину» the same: nothing but the machine or «Перенести сейчас»
   * ends the wait.
   *
   * The row is read against the tunnel first: `unreachable` may be a
   * previous life's word (a stopping home's tunnels close under it), and a
   * tunnel back before this life heard of it changed nothing in memory.
   */
  placementGate(sessionId: string, role: RoomRole, signal?: AbortSignal): Promise<void> {
    let row = livePlacement(sessionId, role)
    if (!row || row.state !== 'unreachable') return Promise.resolve()
    this.reach(row, this.clock.now())
    row = livePlacement(sessionId, role)
    if (!row || row.state !== 'unreachable') return Promise.resolve()
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('The wait for the machine was cancelled'))
    const slot = this.slot(sessionId, role, row.gen)
    return new Promise<void>((resolve, reject) => {
      const gate = {
        resolve: () => {
          slot.gates.delete(gate)
          signal?.removeEventListener('abort', aborted)
          resolve()
        },
        reject: (error: unknown) => {
          slot.gates.delete(gate)
          signal?.removeEventListener('abort', aborted)
          reject(error)
        },
      }
      const aborted = (): void => gate.reject(signal?.reason ?? new Error('The wait for the machine was cancelled'))
      slot.gates.add(gate)
      signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  /* ---------------------------------------------------------------- ensure */

  /**
   * MachineKernels.ensure (§6.8), with RuntimeClient.ensure's arguments: the
   * slot's endpoint on its machine, placing it first when it has no live
   * placement. `revisionId` pins an image (a recreate); without it the class
   * environment's own. Null: no machine can take it and the class falls
   * back here (its `fallback`), and the caller starts it through this
   * server's own admission. One ensure at a time per slot, shared.
   */
  ensure(
    sessionId: string,
    environment: string,
    revisionId?: string,
    cpus?: number | null,
    memoryMb?: number | null,
    role: RoomRole = 'room',
  ): Promise<KernelEndpoint | null> {
    const key = slotKey(sessionId, role)
    const inFlight = this.ensuring.get(key)
    if (inFlight) return inFlight
    const attempt = this.ensureOnce(sessionId, environment, revisionId, cpus ?? null, memoryMb ?? null, role).finally(() => {
      if (this.ensuring.get(key) === attempt) this.ensuring.delete(key)
    })
    this.ensuring.set(key, attempt)
    return attempt
  }

  private async ensureOnce(
    sessionId: string,
    environment: string,
    revisionId: string | undefined,
    cpus: number | null,
    memoryMb: number | null,
    role: RoomRole,
  ): Promise<KernelEndpoint | null> {
    let row = livePlacement(sessionId, role)
    // A slot being stopped is replaced: the next gen's intent supersedes the removal (the agent removes the old one first).
    if (row?.state === 'stopping') row = null
    if (!row) {
      row = await this.place(sessionId, role, environment, revisionId, cpus, memoryMb)
      if (!row) return null
    }
    const ready = await this.whenReady(row)
    return this.endpointOf(ready)
  }

  /** Choose a machine and write the placement; null — the class falls back here. Throws the refusal when it may not. */
  private async place(
    sessionId: string,
    role: RoomRole,
    environment: string,
    revisionId: string | undefined,
    cpus: number | null,
    memoryMb: number | null,
  ): Promise<PlacementRow | null> {
    const setting = classPlacement(sessionId)
    // The setting moved back here since the pool asked: the slot starts here.
    if (!wantsMachines(setting, role)) return null
    const revision = revisionId ? getRevision(revisionId) : (this.continuedRevision(sessionId, role, environment) ?? await this.classRevision(environment))
    const now = this.clock.now()
    let need: Need | null = null
    let chosen: RunnerRow | null = null
    let why: string
    if (!portableRevision(revision)) why = 'its environment exists on this server only'
    else if (!homeRanges().placeable) why = "this server's KERNEL_BLOCKED_CIDRS cannot be told to a machine"
    else {
      need = this.needOf(sessionId, role, environment, revision, cpus, memoryMb, setting)
      chosen = this.choose(need, now)
      why = this.candidates(need, now).map((candidate) => `${candidate.runner.name}: ${candidate.refusal}`).join(', ') || 'no machine takes classes'
    }
    if (!need || !chosen) {
      if (role === 'council') throw new RuntimeRequestError(tr('server.theCouncilPoolRunsOnlyOnMachines.ef5702'), 503)
      if (setting.fallback) {
        this.log(`[classes] ${sessionId}/${role}: no machine can take it (${why}); it starts on this server`)
        this.emit({ sessionId, role, kind: 'fallback', view: HOME }, now)
        return null
      }
      throw new RuntimeRequestError(`No machine can take this class now, and it may not run on this server (${why})`, 503)
    }
    const row = writePlacement({
      sessionId,
      role,
      runnerId: chosen.id,
      state: 'starting',
      environment: need.environment,
      revision: need.revision,
      memoryMb: need.memoryMb,
      cpus: need.cpus,
      gpu: need.card ? '' : null,
      workers: need.workers,
      container: null,
      readyAt: null,
      endedAt: null,
      reason: null,
      createdAt: now,
    })
    const slot = this.slot(sessionId, role, row.gen)
    slot.stateSince = now
    this.log(`[classes] ${sessionId}/${role} gen ${row.gen} goes to machine ${chosen.name} (${chosen.id})`)
    this.emit({ sessionId, role, kind: 'starting', view: this.viewOf(row, now) }, now)
    wakeRunner(chosen.id)
    return row
  }

  /**
   * The image a slot lost from its machine ran, for the placement that
   * follows the loss (§6.6: a placement pins its revision, so a failover
   * uses the same image; the council's epochs load only into it, §9.3).
   * Null — no loss to continue (the slot came back since, here or on a
   * machine), another environment now, or a revision machines cannot run.
   */
  private continuedRevision(sessionId: string, role: RoomRole, environment: string): EnvironmentRevision | null {
    if (!this.slots.get(slotKey(sessionId, role))?.movedFrom) return null
    const last = placementRow(sessionId, role)
    if (!last || last.state !== 'lost' || last.environment !== environment) return null
    const revision = getRevision(last.revision.id)
    return portableRevision(revision) ? revision : null
  }

  /** Why no machine may take any slot of the class, whatever machines there are; null — machines may be asked. */
  private classRefusal(revision: EnvironmentRevision | null): ClassRefusal | null {
    if (!portableRevision(revision)) return 'not-portable'
    if (!homeRanges().placeable) return 'blocked-ranges'
    return null
  }

  /** The class environment's revision, as last found, looked up again when it is old; null — none this server can name. */
  async classRevision(environment: string): Promise<EnvironmentRevision | null> {
    const now = this.clock.now()
    const known = this.revisions.get(environment)
    if (known?.pending) return known.pending
    if (known && now - known.at < (known.revision ? REVISION_TTL_MS : REVISION_RETRY_MS)) return known.revision
    const entry = known ?? { revision: null, at: now, pending: null, wanted: false }
    this.revisions.set(environment, entry)
    entry.pending = this.revisionOf(environment)
      .catch((error: unknown) => {
        this.log(`[classes] the revision of ${environment} could not be found: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      .then((revision) => {
        entry.revision = revision
        entry.at = this.clock.now()
        return revision
      })
      .finally(() => {
        entry.pending = null
      })
    return entry.pending
  }

  /** What the slot needs, in the numbers the contract carries. */
  private needOf(
    sessionId: string,
    role: RoomRole,
    environment: string,
    revision: EnvironmentRevision & { registryRef: string; layers: string },
    cpus: number | null,
    memoryMb: number | null,
    setting: ClassPlacement,
  ): Need {
    let gpuImage = false
    try {
      gpuImage = gpuRevision(revision)
    } catch {
      /* an environment that cannot be read is no GPU one */
    }
    let workers: number | null = null
    let mb = memoryMb ?? 0
    let cores = cpus ?? 0
    if (role === 'council') {
      // The pool's container: its workers' ceilings and a margin, a core each (§9.5); its sizing beyond that is the pool's.
      workers = setting.workers === 'auto' ? COUNCIL_START_WORKERS : setting.workers
      mb = workers * setting.attemptMb + COUNCIL_EXTRA_MB
      cores = workers
    }
    return {
      sessionId,
      role,
      environment: revision.environmentName || environment,
      revision: { id: revision.id, ref: revision.registryRef, layers: revision.layers },
      gpuImage,
      card: role === 'room' && gpuImage,
      memoryMb: clampMemory(mb > 0 ? mb : RUNTIME_MEMORY_MIN_MB),
      cpus: clampCpus(cores > 0 ? cores : 1),
      workers,
    }
  }

  /* -------------------------------------------------------------- chooser */

  /**
   * chooseMachine (§6.3): every eligible machine, by the preferences — the
   * one holding another slot of the class (the council's: the notebook's
   * kernel's first), the last host of the class within a week, the image in
   * place, the shorter link, the most free memory, the name. Null — none.
   */
  private choose(need: Need, now: number): RunnerRow | null {
    const ranked = this.candidates(need, now).filter((candidate) => candidate.refusal === null)
    ranked.sort((a, b) =>
      b.sameClass - a.sameClass ||
      Number(b.lastHost) - Number(a.lastHost) ||
      Number(b.ready) - Number(a.ready) ||
      (a.rtt ?? Number.POSITIVE_INFINITY) - (b.rtt ?? Number.POSITIVE_INFINITY) ||
      b.freeMb - a.freeMb ||
      a.runner.name.localeCompare(b.runner.name) ||
      a.runner.id.localeCompare(b.runner.id))
    return ranked[0]?.runner ?? null
  }

  private candidates(need: Need, now: number): Array<{ runner: RunnerRow; refusal: MachineRefusal | null; sameClass: number; lastHost: boolean; ready: boolean; rtt: number | null; freeMb: number; cards: number }> {
    const rows = classPlacementRows(need.sessionId)
    const avoid = this.slots.get(slotKey(need.sessionId, need.role))?.avoid ?? null
    return listStandingRunners().filter((runner) => runner.classes).map((runner) => {
      const room = this.roomOf(runner)
      const refusal = avoid && avoid.runnerId === runner.id && now < avoid.until ? 'avoided' : this.eligibility(runner, need, room, now)
      const live = rows.filter((row) => row.runnerId === runner.id && row.role !== need.role && ['starting', 'ready', 'unreachable'].includes(row.state))
      const sameClass = need.role === 'council' && live.some((row) => row.role === 'room') ? 2 : live.length > 0 ? 1 : 0
      const lastHost = rows.some((row) => row.runnerId === runner.id && row.state === 'stopped' && now - (row.endedAt ?? row.createdAt) <= LAST_HOST_MS)
      const sync = lastSync(runner.id)
      return {
        runner,
        refusal,
        sameClass,
        lastHost,
        ready: sync?.ready.revisions.includes(need.revision.id) ?? false,
        rtt: this.tunnels().rtt(runner.id).p95Ms,
        freeMb: room?.memoryMb ?? 0,
        cards: room?.cards ?? 0,
      }
    })
  }

  /**
   * THE STALE-CAPACITY RULE (lease.ts · runnerRoom, §6.4): what the machine
   * said is free, less what home has asked of it that its last sync had not
   * accounted for — placements its last report did not hold (or held failed,
   * which holds nothing), memory a resize raised that the container does not
   * have yet (the machine counts what docker gave it), and leases its sync
   * did not list — and its whole cards: those no share of is in use, less the
   * cards such placements and leases are about to take. `slots`: the keys of
   * every live placement there, a stop in flight included.
   */
  private roomOf(runner: RunnerRow): { memoryMb: number; cpus: number; cards: number; slots: string[] } | null {
    const sync = lastSync(runner.id)
    if (!sync) return null
    const held = this.machines.get(runner.id)?.held ?? new Map<string, RemotePlacementHeld>()
    let memoryMb = sync.free.memoryMb
    let cpus = sync.free.cpus
    let cards = sync.cards.filter((card) => card.busyShares === 0).length
    const slots: string[] = []
    for (const row of runnerPlacementRows(runner.id)) {
      slots.push(keyOf(row))
      if (row.state === 'stopping') continue
      const entry = held.get(keyOf(row))
      if (entry && entry.gen === row.gen && entry.phase !== 'failed') {
        if (row.gpu !== null && !entry.card) cards -= 1
        if (entry.usage) memoryMb -= Math.max(0, row.memoryMb - entry.usage.limitMb)
        continue
      }
      memoryMb -= row.memoryMb
      cpus -= row.cpus
      if (row.gpu !== null) cards -= 1
    }
    const listed = listedAttempts(runner.id)
    for (const lease of liveLeases(runner.id)) {
      if (listed?.has(lease.attemptId)) continue
      const claim = stepClaim(lease.manifest.limits)
      memoryMb -= claim.memoryMb
      cpus -= claim.cpus
      if (lease.manifest.gpu) cards -= 1
    }
    return { memoryMb, cpus, cards, slots }
  }

  /**
   * The first filter a machine fails for this slot, or null: live (active,
   * home's build, heard), taking classes, not quarantined for them, holding
   * no hidden test (D3), its tunnel up, its facts as classes need them
   * (host networking, perimeter ok, canary ok, not on this server's daemon,
   * D20 — its own network floor is not compared with home's: the intent
   * carries home's, and the machine applies the stricter, D21), the image
   * in place or on its way, fewer placements there than one reply may name
   * (the slot's own row aside: a new gen replaces it), then its room by the
   * stale-capacity rule.
   */
  private eligibility(runner: RunnerRow, need: Need, room: { memoryMb: number; cpus: number; cards: number; slots: string[] } | null, now: number): MachineRefusal | null {
    if (!liveRunner(runner, now)) return 'not-live'
    if (!runner.classes || runner.trusted) return 'classes-off'
    if (runner.classesQuarantinedAt !== null) return 'quarantined'
    if (liveLeases(runner.id).some((lease) => lease.sealed)) return 'sealed'
    if (!this.tunnels().isUp(runner.id)) return 'tunnel'
    const facts = this.machines.get(runner.id)?.facts
    if (!facts) return 'facts'
    if (!facts.hostNetwork) return 'host-network'
    if (facts.perimeter !== 'ok') return 'perimeter'
    if (facts.canary !== 'ok') return 'canary'
    if (facts.sameDaemon) return 'same-daemon'
    const sync = lastSync(runner.id)
    const id = need.revision.id
    const imaged = (sync?.ready.revisions.includes(id) ?? false) || (sync?.fetching.some((fetch) => fetch.revisionId === id) ?? false)
    if (!imaged || sync?.problems.some((problem) => problem.revisionId === id)) return 'image'
    const key = slotKey(need.sessionId, need.role)
    if (room && room.slots.filter((slot) => slot !== key).length >= REMOTE_PLACEMENTS_MAX) return 'full'
    if (!room || room.memoryMb < need.memoryMb + PLACEMENT_CUSHION_MB) return 'memory'
    if (room.cpus < need.cpus) return 'cpus'
    if (need.card && room.cards < 1) return 'card'
    return null
  }

  /**
   * The form's live line (§13.1 Z4): every machine that takes classes, with
   * what it has free and why it cannot take the class's room slot (the
   * personal one for a class whose room stays here), or the class's own
   * refusal. Staff only: it names machines.
   */
  async outlook(sessionId: string): Promise<{ refusal: ClassRefusal | null; machines: MachineOutlook[] }> {
    const setting = classPlacement(sessionId)
    const role: RoomRole = setting.room === 'machines' ? 'room' : setting.own === 'machines' ? 'own' : setting.council === 'machines' ? 'council' : 'room'
    const environment = sessionEnvironment(sessionId) ?? activeName()
    const revision = await this.classRevision(environment)
    const refusal = this.classRefusal(revision)
    const now = this.clock.now()
    const runners = listStandingRunners().filter((runner) => runner.classes)
    if (refusal || !revision || !portableRevision(revision)) {
      return { refusal: refusal ?? 'not-portable', machines: runners.map((runner) => ({ runnerId: runner.id, name: runner.name, refusal: null, freeMb: null, cards: 0, rttP95Ms: this.tunnels().rtt(runner.id).p95Ms, far: false })) }
    }
    const limits = kernelLimits(sessionId, environment, role === 'council' ? 'own' : role)
    const need = this.needOf(sessionId, role, environment, revision, limits.cpus, limits.memoryMb, setting)
    const machines = this.candidates(need, now).map((candidate) => ({
      runnerId: candidate.runner.id,
      name: candidate.runner.name,
      refusal: candidate.refusal,
      freeMb: candidate.refusal === 'not-live' ? null : candidate.freeMb,
      cards: candidate.cards,
      rttP95Ms: candidate.rtt,
      far: candidate.rtt !== null && candidate.rtt > FAR_RTT_MS,
    }))
    return { refusal: machines.length === 0 ? 'no-machines' : null, machines }
  }

  /* ----------------------------------------------------- ready and endpoint */

  /** The placement once the machine reports it ready (its echoes passed); rejected with the machine's failure, a loss, a stop or CLASS_START_MS. */
  private whenReady(row: PlacementRow): Promise<PlacementRow> {
    const current = livePlacement(row.sessionId, row.role)
    if (!current || current.gen !== row.gen) return Promise.reject(new RuntimeRequestError('The class kernel on the machine was replaced while it started', 503))
    if (current.state === 'ready' || current.state === 'unreachable') return Promise.resolve(current)
    if (current.state === 'stopping') return Promise.reject(new RuntimeRequestError(tr('server.kernel.startsPaused'), 503))
    const slot = this.slot(row.sessionId, row.role, row.gen)
    const machine = getRunner(row.runnerId)?.name ?? row.runnerId
    wakeRunner(row.runnerId)
    return new Promise<PlacementRow>((resolve, reject) => {
      let timer: unknown = null
      const waiter: ReadyWaiter = {
        gen: row.gen,
        since: this.reports.get(row.runnerId) ?? 0,
        resolve: (ready) => {
          this.clock.clearTimeout(timer)
          slot.ready.delete(waiter)
          resolve(ready)
        },
        reject: (error) => {
          this.clock.clearTimeout(timer)
          slot.ready.delete(waiter)
          reject(error)
        },
      }
      slot.ready.add(waiter)
      timer = this.clock.setTimeout(
        () => waiter.reject(new RuntimeRequestError(`The kernel did not start on machine ${machine} within ${Math.round(CLASS_START_MS / 1000)} s`, 503)),
        CLASS_START_MS,
      )
    })
  }

  /**
   * The endpoint of a ready placement (§4.5): its loopback listener, its
   * token, its identity, its link. Every listener opened here is either the
   * slot's (closed with the gen: a stop, a loss, the next placement, the
   * hourly forgetting) or closed before the error: one a stop or a loss
   * overtook while it opened would otherwise stay open on 127.0.0.1 with
   * nothing to close it.
   */
  private async endpointOf(row: PlacementRow): Promise<KernelEndpoint> {
    const key = keyOf(row)
    const slot = this.slot(row.sessionId, row.role, row.gen)
    if (slot.endpoint && slot.endpointOf === row.container) return slot.endpoint
    const tunnels = this.tunnels()
    const listener = await tunnels.listen(row.runnerId, key, row.gen)
    const now = livePlacement(row.sessionId, row.role)
    if (!now || now.gen !== row.gen || now.state === 'stopping') {
      // Lost, stopped or replaced while the port was being opened: nothing may reach it through this one.
      listener.close()
      if (slot.listener === listener) slot.listener = null
      throw new RuntimeRequestError(now?.state === 'stopping' ? tr('server.kernel.startsPaused') : 'The class kernel on the machine went away while it was being reached', 503)
    }
    // The gen's own: whatever its container now, the port leads to the placement.
    slot.listener = listener
    if (now.state !== 'ready' && now.state !== 'unreachable') {
      // Its container stopped running meanwhile, and the machine starts it again: the next ensure waits for that.
      throw new RuntimeRequestError('The class kernel on the machine went away while it was being reached', 503)
    }
    // A recreate at the same gen may have landed meanwhile: the endpoint is the container's that runs now.
    const container = now.container ?? ''
    const endpoint: KernelEndpoint = {
      url: `http://127.0.0.1:${listener.port}`,
      token: placementToken(now.sessionId, now.role, now.runnerId, now.gen),
      instanceId: `${now.runnerId}:${container}:${now.gen}`,
      identity: `machine:${now.runnerId}:${container}:${now.gen}`,
      link: tunnels.link(now.runnerId, key, now.gen),
    }
    slot.endpoint = endpoint
    slot.endpointOf = now.container
    return endpoint
  }

  /** Forget the slot's endpoint: the next ensure builds it again (pool.ts · forgetSessionKernel). The listener stays. */
  forget(sessionId: string, role: RoomRole): void {
    const slot = this.slots.get(slotKey(sessionId, role))
    if (!slot) return
    slot.endpoint = null
    slot.endpointOf = null
  }

  /** The slot started here after a loss (its fallback): the room hears that it moved. */
  settledHome(sessionId: string, role: RoomRole): void {
    const slot = this.slots.get(slotKey(sessionId, role))
    if (!slot?.movedFrom) return
    slot.movedFrom = null
    this.emit({ sessionId, role, kind: 'moved', view: HOME }, this.clock.now())
  }

  /** Whether the slot left a machine in the last half hour: a start here then says the failover's words when it does not fit. */
  lostRecently(sessionId: string, role: RoomRole): boolean {
    const slot = this.slots.get(slotKey(sessionId, role))
    return slot?.movedFrom != null && this.clock.now() - slot.movedFrom.at < AVOID_MS
  }

  /* ---------------------------------------------------------- the machine */

  /**
   * A machine's kernels block (§15), as K5b's sync hands it over: what it
   * holds, its facts and its farewell. Fenced by the gen: an entry for a gen
   * the slot no longer has is the machine's to remove (the reply omits it),
   * and nothing of it moves any row.
   */
  noteKernelsReport(runnerId: string, kernels: RemoteKernelsRequest, now: number): void {
    const index = (this.reports.get(runnerId) ?? 0) + 1
    this.reports.set(runnerId, index)
    const before = this.machines.get(runnerId)
    const restartAt = kernels.bye === 'restart' ? (before?.restartAt ?? now) : null
    const report: MachineReport = {
      index,
      at: now,
      afterReply: this.replies.get(runnerId) ?? 0,
      held: new Map(kernels.placements.map((entry) => [entry.key, entry])),
      facts: kernels.classes,
      tunnel: kernels.tunnel,
      bye: kernels.bye ?? null,
      restartAt,
    }
    this.machines.set(runnerId, report)
    if (restartAt !== null && before?.restartAt == null) this.log(`[classes] machine ${runnerId} is restarting its agent: its classes wait up to ${CLASS_BYE_GRACE_MS / 1000} s`)

    for (const reading of kernels.readings) this.answerReading(runnerId, reading.key, reading.gen, reading.reading, index)

    if (kernels.classes.perimeter === 'failing') {
      // Failed closed (§7.6): every class there moves, and the owner hears of it once per episode.
      if (!this.failing.has(runnerId)) {
        this.failing.add(runnerId)
        remoteEvent(runnerId, 'perimeter_failing', { detail: 'the class perimeter failed closed' }, now)
      }
      this.failoverRunner(runnerId, 'perimeter', now)
    } else {
      this.failing.delete(runnerId)
    }

    for (const row of runnerPlacementRows(runnerId)) {
      const entry = report.held.get(keyOf(row))
      const mine = entry !== undefined && entry.gen === row.gen
      if (row.state === 'stopping') {
        if (!mine) this.stopped(row, now)
        continue
      }
      const slot = this.slot(row.sessionId, row.role, row.gen)
      if (!mine) {
        // Not held at this gen: not taken up yet (just placed), or gone from the machine, which starts it again by itself.
        if (row.state === 'ready' || row.state === 'unreachable') this.restarting(row, null, now)
        continue
      }
      if (entry.card?.device && row.gpu !== entry.card.device) updatePlacement(row.sessionId, row.role, row.gen, { gpu: entry.card.device })
      // A start failing since: retried between the reports, it is given up only if it is never ready (classTick).
      if (entry.phase === 'failed' && row.state === 'starting') slot.failingSince ??= now
      if (entry.phase === 'ready') {
        // Ready at last, or ready again in a container the machine made anew (it lost the old one): the echoes are checked either way.
        if (row.state === 'starting' || entry.container !== row.container) this.becameReady(row, entry, now)
      } else if (row.state === 'ready' || row.state === 'unreachable') {
        this.restarting(row, entry.container ?? null, now)
      } else if (entry.phase === 'failed') {
        this.startFailed(row, entry, index, now)
      }
      if (entry.resized) {
        for (const waiter of [...slot.resizes]) {
          if (waiter.gen === row.gen && report.afterReply >= waiter.afterReply) waiter.resolve(entry.resized === 'applied' ? 'applied' : 'pending')
        }
      }
    }
  }

  /**
   * The machine reported the slot ready: its echoes are checked as
   * RuntimeClient.ensure checks the broker's, then the starts waiting on it
   * go on. A ready slot reported in another container than the one home
   * knew is a new kernel at the same gen (the machine lost the old one and
   * made it again): checked the same way, and announced as one.
   */
  private becameReady(row: PlacementRow, entry: RemotePlacementHeld, now: number): void {
    const container = entry.container ?? ''
    const slot = this.slot(row.sessionId, row.role, row.gen)
    try {
      checkRuntimeEndpoint(
        {
          url: 'http://127.0.0.1',
          token: placementToken(row.sessionId, row.role, row.runnerId, row.gen),
          instanceId: `${row.runnerId}:${container}:${row.gen}`,
          environment: row.environment,
          revision: entry.revision,
          gen: entry.gen,
        },
        { environment: row.environment, revision: remoteRevisionDigest(row.revision.ref), gen: row.gen },
      )
    } catch (error) {
      const refusal = error instanceof RuntimeEndpointError ? error.refusal : 'endpoint'
      const words = refusal === 'revision'
        ? tr('server.kernelRuntimeReturnedADifferentEnvironmentRevision.8f728c')
        : tr('server.invalidKernelRuntimeEndpointOrInstanceIdentity.a63d8b')
      this.log(`[classes] ${row.sessionId}/${row.role} gen ${row.gen} on ${row.runnerId}: its ready report was refused (${refusal}); the container goes`)
      for (const waiter of [...slot.ready]) waiter.reject(new RuntimeRequestError(words, 503))
      this.stopRow(row, `echo: ${refusal}`, now)
      return
    }
    const anew = row.state !== 'starting'
    const state: PlacementState = this.tunnels().isUp(row.runnerId) ? 'ready' : 'unreachable'
    if (!updatePlacement(row.sessionId, row.role, row.gen, { state, container: entry.container ?? null, readyAt: now }, anew ? ['ready', 'unreachable'] : ['starting'])) return
    const ready = livePlacement(row.sessionId, row.role)!
    slot.stateSince = now
    slot.failingSince = null
    slot.endpoint = null
    slot.endpointOf = null
    if (state === 'unreachable') slot.unreachableSince ??= now
    if (anew) {
      this.log(`[classes] ${row.sessionId}/${row.role} gen ${row.gen}: machine ${row.runnerId} runs it in a new container now`)
      this.emit({ sessionId: row.sessionId, role: row.role, kind: 'restarting', view: this.viewOf(ready, now) }, now)
    }
    for (const waiter of [...slot.ready]) waiter.resolve(ready)
    this.emit({ sessionId: row.sessionId, role: row.role, kind: 'ready', view: this.viewOf(ready, now) }, now)
    if (slot.movedFrom) {
      slot.movedFrom = null
      this.emit({ sessionId: row.sessionId, role: row.role, kind: 'moved', view: this.viewOf(ready, now) }, now)
    }
  }

  /**
   * The machine says the slot's container is not running now: a death the
   * agent starts again at the same gen, or a container it lost and starts
   * anew (§11.1 «Recreate on the same machine»). Not a failover: the row
   * goes back to starting, the next ensure waits for its ready report and
   * gets a new identity, and the room hears today's death words from the
   * kernel itself. The same container taken up again (a record the agent
   * could not read) is no death and is not announced.
   */
  private restarting(row: PlacementRow, container: string | null, now: number): void {
    const same = container !== null && container === row.container
    if (!updatePlacement(row.sessionId, row.role, row.gen, { state: 'starting', ...(same ? {} : { container: null }), readyAt: null }, ['ready', 'unreachable'])) return
    const slot = this.slot(row.sessionId, row.role, row.gen)
    slot.stateSince = now
    if (!same) {
      slot.endpoint = null
      slot.endpointOf = null
    }
    for (const gate of [...slot.gates]) gate.resolve()
    if (same) return
    this.log(`[classes] ${row.sessionId}/${row.role} gen ${row.gen}: its container on ${row.runnerId} is not running; the machine starts it again`)
    this.emit({ sessionId: row.sessionId, role: row.role, kind: 'restarting', view: this.viewOf(livePlacement(row.sessionId, row.role) ?? row, now) }, now)
  }

  /**
   * The machine could not start the slot: the starts that waited for this
   * report hear its words (§6.8, RuntimeRequestError with the failure for
   * the room's advice). The row stays: the agent retries while home keeps the
   * intent (10 s doubling to five minutes), and the next Run waits for that
   * — until the machine has failed it for CLASS_START_MS (giveUpStart).
   */
  private startFailed(row: PlacementRow, entry: RemotePlacementHeld, index: number, now: number): void {
    const slot = this.slot(row.sessionId, row.role, row.gen)
    const waiting = [...slot.ready].filter((waiter) => waiter.since < index)
    if (waiting.length === 0) return
    const { words, failure } = this.failureOf(row, entry)
    for (const waiter of waiting) waiter.reject(new RuntimeRequestError(words, 503, failure))
    this.emit({ sessionId: row.sessionId, role: row.role, kind: 'failed', view: this.viewOf(row, now), words }, now)
  }

  /** A failed start in the machine's words, and the failure for the room's advice. */
  private failureOf(row: PlacementRow, entry: RemotePlacementHeld | undefined): { words: string; failure: RuntimeStartFailure } {
    const machine = getRunner(row.runnerId)?.name ?? row.runnerId
    const failure: RuntimeStartFailure = { unschedulable: entry?.failure?.unschedulable ?? 'other', ...(entry?.failure?.memoryMb !== undefined ? { memoryMb: entry.failure.memoryMb } : {}), ...(entry?.failure?.cpus !== undefined ? { cpus: entry.failure.cpus } : {}) }
    return { words: `The kernel did not start on machine ${machine}${entry?.failure?.detail ? `: ${entry.failure.detail}` : ''}`, failure }
  }

  /**
   * A start the machine has failed for CLASS_START_MS and never made ready
   * is given up there: the starts waiting hear its words, the row stops
   * (the reply omits it, the machine removes what it made), and the slot
   * keeps away from that machine for AVOID_MS, so that its next ensure goes
   * to another machine or, with the class's fallback, here. Not a failover:
   * no variables were there to lose, and no quarantine counts it.
   */
  private giveUpStart(row: PlacementRow, slot: Slot, now: number): void {
    const { words, failure } = this.failureOf(row, this.machines.get(row.runnerId)?.held.get(keyOf(row)))
    for (const waiter of [...slot.ready]) waiter.reject(new RuntimeRequestError(words, 503, failure))
    slot.failingSince = null
    slot.avoid = { runnerId: row.runnerId, until: now + AVOID_MS }
    this.log(`[classes] ${row.sessionId}/${row.role} gen ${row.gen}: machine ${row.runnerId} could not start it for ${CLASS_START_MS / 1000} s; it is stopped there and goes elsewhere`)
    this.stopRow(row, 'start failed', now)
  }

  /* ------------------------------------------------------------ the reply */

  /**
   * The whole wanted set for one machine (§15): every placement there that is
   * not stopping, as the intent its container is made from. Called once per
   * reply built: a resize's outcome counts only from a report that followed
   * a reply carrying its numbers.
   */
  wantedPlacements(runnerId: string): RemotePlacementIntent[] {
    this.replies.set(runnerId, (this.replies.get(runnerId) ?? 0) + 1)
    const ranges = homeRanges()
    let rows = runnerPlacementRows(runnerId).filter((row) => row.state !== 'stopping')
    if (!ranges.keepable && rows.length > 0) {
      // Home's floor is one no intent can carry (REMOTE_BLOCKED_CIDRS_MAX): the slots move now, as at the class clock's pass,
      // rather than run a reply's time behind a part of it.
      const now = this.clock.now()
      let moved = 0
      for (const row of rows) if (this.failoverRow(row, 'blocked', now)) moved++
      if (moved > 0) this.failedOver(runnerId, 'blocked', now)
      rows = []
    }
    if (rows.length > REMOTE_PLACEMENTS_MAX) {
      // The chooser keeps a machine below this; should it ever hold more, the running slots are the ones kept: a slot left out
      // is one the machine removes.
      rows.sort((a, b) => Number(a.state === 'starting') - Number(b.state === 'starting') || a.createdAt - b.createdAt)
      this.log(`[classes] machine ${runnerId} holds ${rows.length} placements, more than a reply names: ${rows.length - REMOTE_PLACEMENTS_MAX} are left out, the newest starting ones first`)
      rows = rows.slice(0, REMOTE_PLACEMENTS_MAX)
    }
    return rows.map((row) => this.intentOf(row, ranges.cidrs))
  }

  /** One intent, every field within the contract (the agent refuses a whole reply over one outside it); `cidrs` home's ranges, few enough. */
  private intentOf(row: PlacementRow, cidrs: readonly string[]): RemotePlacementIntent {
    const { pids, mode } = roomHardening(process.env, row.role)
    const network = mode === 'none' ? 'none' : 'blocked'
    return {
      key: keyOf(row),
      gen: row.gen,
      environment: row.environment,
      revision: { ...row.revision },
      memoryMb: clampMemory(row.memoryMb),
      cpus: clampCpus(row.cpus),
      pids: clampPids(pids),
      gpu: row.role === 'room' && row.gpu !== null,
      // Home's mode is the floor (D21): an open home sends blocked, and `none` takes no ranges (it refuses everything).
      network,
      blockedCidrs: network === 'blocked' ? [...cidrs] : [],
      token: placementToken(row.sessionId, row.role, row.runnerId, row.gen),
      hashSeed: classHashSeed(row.sessionId),
      shm: intentShm(),
      ...(row.role === 'council' ? { workers: Math.min(COUNCIL_WORKERS.max, Math.max(1, row.workers ?? COUNCIL_START_WORKERS)) } : {}),
    }
  }

  /** Whether the machine holds anything of a class now (a stop in flight included): its syncs are held at most REMOTE_HOLD_BUSY_MS. */
  hasLivePlacements(runnerId: string): boolean {
    return runnerPlacementRows(runnerId).length > 0
  }

  /**
   * `kernels.tunnel` for the machine (§4.6): open (or reconnect, when home's
   * side has none) while it holds a placement — and while it takes classes
   * at all, so that the chooser sees its tunnel up and its RTT before the
   * first placement there (§6.3 requires both). Its class quarantine changes
   * nothing here: a quarantine never closes a tunnel (D32). Closed for a
   * machine that takes no classes now, or one that cannot be given any
   * (draining, another build) and holds none.
   */
  tunnelWanted(runnerId: string): 'open' | 'reconnect' | 'closed' {
    const holds = runnerPlacementRows(runnerId).some((row) => row.state !== 'stopping')
    if (!holds) {
      const runner = getRunner(runnerId)
      const may = runner !== null && runnerStanding(runner) && runner.state === 'active' && runner.classes && !runner.trusted
        && remoteCompatible(homeRunnerBuild(), runner.build ?? '')
      if (!may) return 'closed'
    }
    return this.tunnels().isUp(runnerId) ? 'open' : 'reconnect'
  }

  /** The placements whose container home wants read (§7.4): the questions not answered yet, by key. */
  postmortemWanted(runnerId: string): string[] {
    return [...(this.asked.get(runnerId)?.keys() ?? [])].slice(0, REMOTE_READINGS_MAX)
  }

  /**
   * The class revisions this machine should hold before the bell (§6.6): what
   * its placements run, then the images of classes set to machines, portable
   * ones only (the lookup gives no other), a GPU kernel only to a machine
   * with cards.
   *
   * `gpu` is the revision's own bit (want.ts · gpuRevision), never whether a
   * slot holds a card: the leases and the stock name the same id with it,
   * and the machine reads its change as another image (it books the image
   * again, and checks a GPU kernel on a card before calling it ready). A
   * personal slot of a GPU class runs the GPU image without a card.
   */
  classRevisionsWanted(runnerId: string): RemoteWantRevision[] {
    const runner = getRunner(runnerId)
    if (!runner || !runner.classes) return []
    const cards = runnerCards(runner).length > 0
    const out = new Map<string, RemoteWantRevision>()
    for (const row of runnerPlacementRows(runnerId)) {
      if (row.state === 'stopping' || out.has(row.revision.id)) continue
      let gpu = row.gpu !== null
      try {
        gpu = gpuRevision({ id: row.revision.id, environmentName: row.environment })
      } catch {
        /* an environment that cannot be read: a card held says it is a GPU kernel, as at its placement */
      }
      out.set(row.revision.id, { ...row.revision, gpu })
    }
    for (const known of this.revisions.values()) {
      const revision = known.revision
      if (!known.wanted || !portableRevision(revision) || out.has(revision.id)) continue
      let gpu = false
      try {
        gpu = gpuRevision(revision)
      } catch {
        /* an environment that cannot be read is no GPU one */
      }
      if (gpu && !cards) continue
      out.set(revision.id, { id: revision.id, ref: revision.registryRef, layers: revision.layers, gpu })
    }
    return [...out.values()]
  }

  /* -------------------------------------------------------------- the clock */

  /**
   * One pass of the class clock (§11.1), from liveness.ts · remoteTick every
   * five seconds: reachability and its notes, the two failover rules on
   * proof, stops a machine that is gone cannot confirm, the quarantine; and,
   * now and then, the prefetch's look at classes set to machines and the
   * pruning of history.
   */
  classTick(now: number): void {
    if (!this.evidence(now, null)) this.blindAt = Math.max(this.blindAt ?? now, now)
    const grace = inBootGrace(now)
    const ranges = homeRanges()
    const moved = new Map<string, FailoverCause>()
    for (const row of livePlacementRows()) {
      const runner = getRunner(row.runnerId)
      if (row.state === 'stopping') {
        // A machine that may no longer call, or that went silent for good, will not say it is gone: its stop is done as far as
        // anyone can do it. Should it call again, the reply's wanted set names no such slot, and it removes the container itself.
        const silentFor = now - Math.max(heardAt(row.runnerId) ?? remoteBootAt(), remoteBootAt())
        if (!runner || !runnerStanding(runner) || silentFor >= STOPPING_SILENT_MS) this.stopped(row, now)
        continue
      }
      if (!runner || !runnerStanding(runner)) {
        const cause: FailoverCause = runner?.state === 'left' ? 'leaving' : 'revoked'
        if (this.failoverRow(row, cause, now) && runner && !moved.has(row.runnerId)) moved.set(row.runnerId, cause)
        continue
      }
      if (!runner.classes) {
        if (this.failoverRow(row, 'unclassed', now) && !moved.has(row.runnerId)) moved.set(row.runnerId, 'unclassed')
        continue
      }
      if (!ranges.keepable) {
        // Home's floor is one no intent can carry (REMOTE_BLOCKED_CIDRS_MAX): no slot is kept there.
        if (this.failoverRow(row, 'blocked', now) && !moved.has(row.runnerId)) moved.set(row.runnerId, 'blocked')
        continue
      }
      const failing = row.state === 'starting' ? this.slots.get(keyOf(row)) : undefined
      if (failing?.gen === row.gen && failing.failingSince !== null && now - failing.failingSince >= CLASS_START_MS) {
        this.giveUpStart(row, failing, now)
        continue
      }
      this.reach(row, now)
      const cause = this.dueFailover(row, now, grace)
      if (cause && this.failoverRow(row, cause, now) && !moved.has(row.runnerId)) moved.set(row.runnerId, cause)
    }
    for (const [runnerId, cause] of moved) this.failedOver(runnerId, cause, now)
    if (now - this.prefetchedAt >= PREFETCH_EVERY_MS) {
      this.prefetchedAt = now
      this.lookForImages()
    }
    // No history row is ever pruned: it holds the slot's last gen, and a gen used again is a fence opened (§6.9) — the tunnel
    // remembers a lost (machine, slot, gen) and refuses it, and the token is the old placement's. One row per slot.
    if (now - this.forgottenAt >= FORGET_EVERY_MS) {
      this.forgottenAt = now
      this.forgetIdleSlots(now)
    }
  }

  /** Memory of slots that live nowhere now, wait for nothing and keep no machine away: the next placement starts it anew. */
  private forgetIdleSlots(now: number): void {
    for (const [key, slot] of this.slots) {
      const [sessionId, role] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1) as RoomRole]
      if (livePlacement(sessionId, role)) continue
      if (slot.gates.size + slot.ready.size + slot.resizes.size + slot.stops.size + slot.readings.size > 0) continue
      if ((slot.avoid && now < slot.avoid.until) || (slot.movedFrom && now - slot.movedFrom.at < AVOID_MS)) continue
      slot.listener?.close()
      this.slots.delete(key)
    }
  }

  /**
   * PATH EVIDENCE BY THE CLASSES' RULE (§11.1): another machine heard, a
   * tunnel frame among its calls, or this server's own probe passed, within
   * CLASS_EVIDENCE_MS.
   */
  private evidence(now: number, except: string | null): boolean {
    const probe = probePassedAt()
    if (probe !== null && now - probe <= CLASS_EVIDENCE_MS) return true
    for (const runner of listStandingRunners()) {
      if (runner.id === except) continue
      const at = heardAt(runner.id)
      if (at !== null && now - at <= CLASS_EVIDENCE_MS) return true
    }
    return false
  }

  /** A machine's silence as far as the path was proven for it: since its last call, this life's start, and the last pass without evidence. */
  private silence(runnerId: string, now: number): number {
    const since = Math.max(heardAt(runnerId) ?? remoteBootAt(), remoteBootAt(), this.blindAt ?? Number.NEGATIVE_INFINITY)
    return Math.max(0, now - since)
  }

  /** Which failover rule a slot meets now, or null: never in a grace, never under «ждать машину», never while its tunnel is up. */
  private dueFailover(row: PlacementRow, now: number, grace: boolean): FailoverCause | null {
    if (grace || this.tunnels().isUp(row.runnerId)) return null
    const setting = classPlacement(row.sessionId)
    if (setting.failover === 'wait') return null
    const restartAt = this.machines.get(row.runnerId)?.restartAt ?? null
    if (restartAt !== null && now - restartAt < CLASS_BYE_GRACE_MS) return null
    const failoverMs = setting.failoverSec * 1000
    // Its syncs still come (heard within SYNCS_COMING_MS): alive, but its classes cannot compute. They move once the tunnel has
    // been stuck long enough. A machine heard longer ago is silent on both channels, whatever the class's own delay.
    const lastHeard = Math.max(heardAt(row.runnerId) ?? remoteBootAt(), remoteBootAt())
    if (now - lastHeard <= SYNCS_COMING_MS) {
      const slot = this.slots.get(keyOf(row))
      const downSince = slot?.gen === row.gen && slot.unreachableSince !== null ? slot.unreachableSince : this.tunnels().since(row.runnerId)
      return now - downSince >= CLASS_TUNNEL_STUCK_MS ? 'tunnel' : null
    }
    // Silent on both channels: proven only with evidence of the path, and only for as long as it was proven.
    return this.evidence(now, row.runnerId) && this.silence(row.runnerId, now) >= failoverMs ? 'silence' : null
  }

  /** A machine's tunnel went up or down: its placements' reachability, now rather than at the next pass. */
  private tunnelChanged(runnerId: string): void {
    if (this.closed) return
    const now = this.clock.now()
    for (const row of runnerPlacementRows(runnerId)) if (row.state !== 'stopping') this.reach(row, now)
  }

  /**
   * Reachability of one slot: the tunnel down turns a ready placement
   * unreachable (the chip amber at once), and after CLASS_UNREACHABLE_NOTE_MS
   * the room's note goes out; the tunnel up again turns it ready, the gates
   * open, and «вернулась через 37 с» is said if the note went out. A slot
   * still starting is followed as quietly: the room uses none of it yet, and
   * hears of its start from the start itself.
   *
   * Every gate opens with the tunnel up, whether or not this life saw the
   * outage begin: a row a previous life left `unreachable` (a stopping
   * home's tunnels close under it) has gates waiting on it too, and its
   * turn to `ready` is the hooks' news.
   */
  private reach(row: PlacementRow, now: number): void {
    const slot = this.slot(row.sessionId, row.role, row.gen)
    const machine = getRunner(row.runnerId)?.name ?? row.runnerId
    const announced = row.state !== 'starting'
    if (this.tunnels().isUp(row.runnerId)) {
      const turned = row.state === 'unreachable' && updatePlacement(row.sessionId, row.role, row.gen, { state: 'ready' }, ['unreachable'])
      if (turned) slot.stateSince = now
      for (const gate of [...slot.gates]) gate.resolve()
      if (slot.unreachableSince === null) {
        if (turned) this.emit({ sessionId: row.sessionId, role: row.role, kind: 'back', view: this.viewOf(livePlacement(row.sessionId, row.role) ?? row, now) }, now)
        return
      }
      const seconds = Math.max(1, Math.round((now - slot.unreachableSince) / 1000))
      const noted = slot.noted
      slot.unreachableSince = null
      slot.noted = false
      if (!announced) return
      const view = this.viewOf(livePlacement(row.sessionId, row.role) ?? row, now)
      this.emit({ sessionId: row.sessionId, role: row.role, kind: 'back', view, ...(noted ? { words: tr('server.theConnectionToMachineCameBackAfter.28f7cf', { machine, seconds }) } : {}) }, now)
      return
    }
    if (slot.unreachableSince === null) {
      slot.unreachableSince = Math.min(now, this.tunnels().since(row.runnerId))
      if (row.state === 'ready' && updatePlacement(row.sessionId, row.role, row.gen, { state: 'unreachable' }, ['ready'])) slot.stateSince = slot.unreachableSince
      if (announced) this.emit({ sessionId: row.sessionId, role: row.role, kind: 'unreachable', view: this.viewOf(livePlacement(row.sessionId, row.role) ?? row, now) }, now)
    } else if (row.state === 'ready') {
      updatePlacement(row.sessionId, row.role, row.gen, { state: 'unreachable' }, ['ready'])
    }
    if (!announced || slot.noted || now - slot.unreachableSince < CLASS_UNREACHABLE_NOTE_MS) return
    slot.noted = true
    const current = livePlacement(row.sessionId, row.role) ?? row
    const restarting = this.machines.get(row.runnerId)?.restartAt != null
    const words = restarting
      ? tr('server.theAgentOnMachineIsUpdatingThe.88b188', { machine })
      : tr('server.noConnectionToMachineTheKernelAnd.df78c8', { machine, elapsed: elapsedOf(now - slot.unreachableSince) })
    const until = this.failoverAt(current, classPlacement(row.sessionId), now)
    const staffWords = until === null ? undefined : tr('server.machineHasNotAnsweredSinceWaitingUntil.3d926e', { machine, since: clockOf(slot.unreachableSince), until: clockOf(until) })
    this.emit({ sessionId: row.sessionId, role: row.role, kind: 'unreachable', view: this.viewOf(current, now), words, ...(staffWords ? { staffWords } : {}), ...(restarting ? { cause: 'updating' as const } : {}) }, now)
  }

  /* ------------------------------------------------------------- failover */

  /**
   * Every placement of one machine moves, FIRST (§11.5): before an unclass,
   * a revoke or a leave goes on, and when its perimeter failed closed. How
   * many moved; the machine's log gets one `class_failover` line for them.
   */
  failoverRunner(runnerId: string, cause: FailoverCause, now: number): number {
    let count = 0
    for (const row of runnerPlacementRows(runnerId)) {
      if (row.state === 'stopping') {
        // Going anyway: done as far as this server is concerned, since the machine is leaving its classes.
        this.stopped(row, now)
        continue
      }
      if (this.failoverRow(row, cause, now)) count++
    }
    if (count > 0) this.failedOver(runnerId, cause, now)
    return count
  }

  /**
   * «Перенести сейчас» (§11.1): a slot of the class (or all of its machine
   * slots) moves now, whether its machine is reachable («Перенести на
   * сервер») or not. Refused in words when nothing of it is on a machine.
   */
  async moveNow(sessionId: string, role: RoomRole | null, by: string): Promise<{ ok: true } | { refused: string }> {
    const roles: RoomRole[] = role ? [role] : ['room', 'own', 'council']
    const rows = roles.flatMap((one) => {
      const row = livePlacement(sessionId, one)
      return row && row.state !== 'stopping' ? [row] : []
    })
    if (rows.length === 0) return { refused: 'Nothing of this class runs on a machine now' }
    const now = this.clock.now()
    const runners = new Set<string>()
    for (const row of rows) {
      this.emit({ sessionId, role: row.role, kind: 'moving', view: this.viewOf(row, now), cause: 'moved' }, now)
      if (this.failoverRow(row, 'moved', now)) runners.add(row.runnerId)
    }
    this.log(`[classes] ${sessionId}${role ? `/${role}` : ''} moved off its machine by ${by}`)
    for (const runnerId of runners) this.failedOver(runnerId, 'moved', now, by)
    return { ok: true }
  }

  /**
   * One slot leaves its machine (§11.2): one transaction marks it lost with
   * its cause; then its link answers `lost` (the kernel client never sends
   * that machine a DELETE), its listener closes, every gate and start
   * waiting on it is rejected with the room's words, and the hooks hear
   * the event. Whether it moved (false: a newer write was there first).
   */
  private failoverRow(row: PlacementRow, cause: FailoverCause, now: number): boolean {
    const runner = getRunner(row.runnerId)
    const slot = this.slot(row.sessionId, row.role, row.gen)
    const words = this.failoverWords(row, runner, cause, slot, now)
    if (!updatePlacement(row.sessionId, row.role, row.gen, { state: 'lost', endedAt: now, reason: cause }, ['starting', 'ready', 'unreachable'])) return false
    const key = keyOf(row)
    this.tunnels().lost(row.runnerId, key, row.gen)
    slot.listener?.close()
    slot.listener = null
    slot.endpoint = null
    slot.endpointOf = null
    const lost = new PlacementLost(words, cause)
    for (const gate of [...slot.gates]) gate.reject(lost)
    for (const waiter of [...slot.ready]) waiter.reject(lost)
    for (const waiter of [...slot.resizes]) waiter.resolve('pending')
    for (const waiter of [...slot.readings]) waiter.resolve(null)
    for (const stop of [...slot.stops]) stop()
    this.asked.get(row.runnerId)?.delete(key)
    slot.movedFrom = { runnerId: row.runnerId, at: now }
    slot.avoid = { runnerId: row.runnerId, until: now + AVOID_MS }
    slot.unreachableSince = null
    slot.noted = false
    this.log(`[classes] ${row.sessionId}/${row.role} gen ${row.gen} lost machine ${row.runnerId} (${cause})`)
    const filesAt = this.machines.get(row.runnerId)?.at
    this.emit({ sessionId: row.sessionId, role: row.role, kind: 'lost', view: HOME, words, cause, ...(filesAt !== undefined ? { filesAt } : {}) }, now)
    wakeRunner(row.runnerId)
    return true
  }

  /** The room's failover note for a cause (§13.2), naming the machine. */
  private failoverWords(row: PlacementRow, runner: RunnerRow | null, cause: FailoverCause, slot: Slot, now: number): string {
    const machine = runner?.name ?? row.runnerId
    const started = tr('server.theKernelWasStartedOnThisServer.497a79')
    const quiet = (): string => {
      const since = slot.unreachableSince ?? heardAt(row.runnerId) ?? now
      const filesAt = this.machines.get(row.runnerId)?.at ?? since
      return tr('server.machineHasNotAnsweredSinceTheKernel.05bf4e', { machine, since: clockOf(since), filesAt: clockOf(Math.min(filesAt, now)) })
    }
    switch (cause) {
      case 'silence':
      case 'tunnel':
        return quiet()
      case 'revoked':
        return `${tr('server.theOwnerDisconnectedMachine.1a3061', { machine })} ${started}`
      case 'unclassed':
        return `${tr('server.machineIsNoLongerTrustedToRun.8962f2', { machine })} ${started}`
      case 'leaving':
        return `${tr('server.machineIsBeingDisconnected.6aa752', { machine })} ${started}`
      case 'perimeter':
        return tr('server.theNetworkOnMachineGotOutOf.6b309d', { machine })
      case 'moved':
        return this.tunnels().isUp(row.runnerId) ? started : quiet()
      case 'blocked':
        return started
    }
  }

  /**
   * After a pass moved slots off a machine: one `class_failover` line in its
   * log (the class quarantine counts lines, not placements), and, for a
   * machine that went quiet twice within half an hour by no one's hand, the
   * quarantine (D32). A quarantine keeps new placements away and closes
   * nothing: what the machine still holds is reached as before.
   *
   * ONE DISAPPEARANCE, ONE LINE. Both liveness rules need the tunnel down,
   * and the classes of one machine move at their own failoverSec, in
   * passes apart: a later pass of the same outage (the tunnel down since
   * before the last liveness line) writes nothing more, or one outage of a
   * machine with two classes would quarantine it — «дважды пропадала» is two
   * outages. A home restart in mid-outage starts another (this life knows
   * the tunnel only since its own start).
   */
  private failedOver(runnerId: string, cause: FailoverCause, now: number, by?: string): void {
    const liveness = (line: { detail: string | null }): boolean => LIVENESS_CAUSES.has((line.detail ?? '').split(':')[0] as FailoverCause)
    if (LIVENESS_CAUSES.has(cause) && runnerEventsOf(runnerId, ['class_failover'], this.tunnels().since(runnerId)).some(liveness)) return
    remoteEvent(runnerId, 'class_failover', { detail: by ? `${cause}: ${by}` : cause }, now)
    if (!LIVENESS_CAUSES.has(cause)) return
    const runner = getRunner(runnerId)
    if (!runner || runner.classesQuarantinedAt !== null) return
    const since = Math.max(now - CLASS_QUARANTINE_WINDOW_MS, runner.classesResumedAt ?? 0)
    const lines = runnerEventsOf(runnerId, ['class_failover'], since).filter(liveness)
    if (lines.length < CLASS_QUARANTINE_FAILOVERS) return
    updateRunner(runnerId, { classesQuarantinedAt: now })
    remoteEvent(runnerId, 'classes_quarantined', { detail: `${lines.length} failovers within ${CLASS_QUARANTINE_WINDOW_MS / 60_000} min` }, now)
    this.log(`[classes] machine ${runnerId} takes no new classes: it was lost ${lines.length} times within ${CLASS_QUARANTINE_WINDOW_MS / 60_000} min`)
  }

  /* --------------------------------------------------------------- stops */

  /**
   * Stop these slots of the class on their machines (§6.10): durable — the
   * row says stopping, the reply omits the slot, the machine removes it and
   * stops listing it. An owner's stop waits for that while the machine still
   * calls, at most STOP_WAIT_MS; its memory was never this server's.
   */
  async drop(sessionId: string, roles: readonly RoomRole[], options: { owner?: boolean } = {}): Promise<void> {
    const now = this.clock.now()
    const rows = roles.flatMap((role) => {
      const row = livePlacement(sessionId, role)
      return row ? [row] : []
    })
    for (const row of rows) if (row.state !== 'stopping') this.stopRow(row, 'stopped', now)
    if (!options.owner) return
    await Promise.all(rows.map((row) => this.whenStopped(row)))
  }

  private stopRow(row: PlacementRow, reason: string, now: number): void {
    const runner = getRunner(row.runnerId)
    const gone = !runner || !runnerStanding(runner)
    const state: PlacementState = gone ? 'stopped' : 'stopping'
    if (!updatePlacement(row.sessionId, row.role, row.gen, { state, reason, ...(gone ? { endedAt: now } : {}) }, ['starting', 'ready', 'unreachable'])) return
    const slot = this.slot(row.sessionId, row.role, row.gen)
    slot.stateSince = now
    // Fenced as a loss is: whatever still holds this gen's link hears `lost`, never a road to a port the system may give another.
    this.tunnels().lost(row.runnerId, keyOf(row), row.gen)
    slot.listener?.close()
    slot.listener = null
    slot.endpoint = null
    slot.endpointOf = null
    for (const gate of [...slot.gates]) gate.resolve()
    for (const waiter of [...slot.ready]) waiter.reject(new RuntimeRequestError(tr('server.kernel.startsPaused'), 503))
    for (const waiter of [...slot.resizes]) waiter.resolve('pending')
    const view = gone ? HOME : this.viewOf(livePlacement(row.sessionId, row.role) ?? row, now)
    this.emit({ sessionId: row.sessionId, role: row.role, kind: gone ? 'stopped' : 'stopping', view }, now)
    if (gone) for (const stop of [...slot.stops]) stop()
    else wakeRunner(row.runnerId)
  }

  /** The machine no longer lists a stopping slot: it is gone, and so is the row's life. */
  private stopped(row: PlacementRow, now: number): void {
    if (!updatePlacement(row.sessionId, row.role, row.gen, { state: 'stopped', endedAt: now }, ['stopping'])) return
    const slot = this.slot(row.sessionId, row.role, row.gen)
    for (const stop of [...slot.stops]) stop()
    this.emit({ sessionId: row.sessionId, role: row.role, kind: 'stopped', view: HOME }, now)
  }

  /** Until the stopping row is gone or replaced, the machine stops calling, or STOP_WAIT_MS passes. */
  private whenStopped(row: PlacementRow): Promise<void> {
    const current = livePlacement(row.sessionId, row.role)
    if (!current || current.gen !== row.gen || current.state !== 'stopping') return Promise.resolve()
    const now = this.clock.now()
    // A machine that does not call says nothing until it calls again: «остановится, когда машина выйдет на связь».
    if (now - (heardAt(row.runnerId) ?? Number.NEGATIVE_INFINITY) > CLASS_EVIDENCE_MS) return Promise.resolve()
    const slot = this.slot(row.sessionId, row.role, row.gen)
    return new Promise<void>((resolve) => {
      let timer: unknown = null
      const done = (): void => {
        this.clock.clearTimeout(timer)
        slot.stops.delete(done)
        resolve()
      }
      slot.stops.add(done)
      timer = this.clock.setTimeout(done, STOP_WAIT_MS)
    })
  }

  /* --------------------------------------------------------------- resize */

  /**
   * New numbers for a slot on its machine (§6.10): the row changes at its
   * gen, the reply carries them, and the machine answers with `docker
   * update`'s outcome. `applied` once it said so for these numbers; `pending`
   * when it is not running now, refused, did not answer within
   * RESIZE_WAIT_MS, or is unreachable (the numbers wait in the row).
   *
   * `failed` — more memory than the machine has free beside its cushion, by
   * the stale-capacity rule, as this server's own admission refuses a raise
   * (pool.ts · updateWithMemory): the machine runs `docker update` with no
   * such check, and its OOM killer would choose among the runs there, a
   * submission among them (D24). The row keeps its numbers.
   */
  async resize(sessionId: string, role: RoomRole, change: { memoryMb?: number | null; cpus?: number | null }): Promise<LimitOutcome> {
    const row = livePlacement(sessionId, role)
    if (!row || row.state === 'stopping') return 'pending'
    const memoryMb = change.memoryMb == null ? row.memoryMb : clampMemory(change.memoryMb)
    const cpus = change.cpus == null ? row.cpus : clampCpus(change.cpus)
    const slot = this.slot(sessionId, role, row.gen)
    if (memoryMb === row.memoryMb && cpus === row.cpus) {
      const held = this.machines.get(row.runnerId)?.held.get(keyOf(row))
      return row.state === 'ready' && held?.gen === row.gen && held.resized === 'applied' ? 'applied' : 'pending'
    }
    if (memoryMb > row.memoryMb) {
      const runner = getRunner(row.runnerId)
      const room = runner ? this.roomOf(runner) : null
      if (!room || room.memoryMb < memoryMb - row.memoryMb + PLACEMENT_CUSHION_MB) {
        this.log(`[classes] ${sessionId}/${role}: machine ${row.runnerId} has ${room ? `${room.memoryMb} MB` : 'nothing known'} free, not ${memoryMb - row.memoryMb} MB more; the limit stays at ${row.memoryMb} MB`)
        return 'failed'
      }
    }
    if (!updatePlacement(sessionId, role, row.gen, { memoryMb, cpus }, ['starting', 'ready', 'unreachable'])) return 'pending'
    wakeRunner(row.runnerId)
    if (row.state !== 'ready') return 'pending'
    return new Promise<LimitOutcome>((resolve) => {
      let timer: unknown = null
      const waiter: ResizeWaiter = {
        gen: row.gen,
        afterReply: (this.replies.get(row.runnerId) ?? 0) + 1,
        resolve: (outcome) => {
          this.clock.clearTimeout(timer)
          slot.resizes.delete(waiter)
          resolve(outcome)
        },
      }
      slot.resizes.add(waiter)
      timer = this.clock.setTimeout(() => waiter.resolve('pending'), RESIZE_WAIT_MS)
    })
  }

  /* ----------------------------------------------------------- post-mortem */

  /**
   * The machine's reading of a slot's container (§7.4): asked through
   * `kernels.postmortem`, answered by its next sync. Null — not on a
   * machine, or no answer within READING_WAIT_MS.
   */
  reading(sessionId: string, role: RoomRole): Promise<PostmortemReading | null> {
    const row = livePlacement(sessionId, role)
    if (!row || row.state === 'stopping') return Promise.resolve(null)
    const key = keyOf(row)
    const questions = this.asked.get(row.runnerId) ?? new Map<string, number>()
    questions.set(key, row.gen)
    this.asked.set(row.runnerId, questions)
    const slot = this.slot(sessionId, role, row.gen)
    wakeRunner(row.runnerId)
    return new Promise((resolve) => {
      let timer: unknown = null
      const waiter: ReadingWaiter = {
        gen: row.gen,
        since: this.reports.get(row.runnerId) ?? 0,
        resolve: (reading) => {
          this.clock.clearTimeout(timer)
          slot.readings.delete(waiter)
          if (slot.readings.size === 0) this.asked.get(row.runnerId)?.delete(key)
          resolve(reading)
        },
      }
      slot.readings.add(waiter)
      timer = this.clock.setTimeout(() => waiter.resolve(null), READING_WAIT_MS)
    })
  }

  private answerReading(runnerId: string, key: string, gen: number, reading: PostmortemReading, index: number): void {
    const asked = this.asked.get(runnerId)
    if (asked?.get(key) !== gen) return
    const slot = this.slots.get(key)
    if (!slot || slot.gen !== gen) return
    for (const waiter of [...slot.readings]) if (waiter.gen === gen && waiter.since < index) waiter.resolve(reading)
  }

  /** The slot container's OOM kill counter as the machine's census last said it: a post-mortem's baseline (postmortem.ts · sampleKills). */
  kills(sessionId: string, role: RoomRole): number | null {
    const row = livePlacement(sessionId, role)
    if (!row) return null
    const held = this.machines.get(row.runnerId)?.held.get(keyOf(row))
    return held?.gen === row.gen ? (held.usage?.oomKills ?? null) : null
  }

  /** What the census of «Работают сейчас» shows of a slot on its machine (usage.ts): the machine's numbers, its name, its link. */
  usage(row: PlacementRow): { name: string; held: RemotePlacementHeld | null; up: boolean; rttP95Ms: number | null } {
    const held = this.machines.get(row.runnerId)?.held.get(keyOf(row))
    return {
      name: getRunner(row.runnerId)?.name ?? row.runnerId,
      held: held?.gen === row.gen ? held : null,
      up: this.tunnels().isUp(row.runnerId),
      rttP95Ms: this.tunnels().rtt(row.runnerId).p95Ms,
    }
  }

  /* ------------------------------------------------------------- prefetch */

  /**
   * The images of classes set to machines, looked up in the background so
   * that `classRevisionsWanted` names them before anyone presses Run: a
   * teacher who sets the class to «На машинах» the day before finds its
   * image on the machines (§3 «The life of a placement», step 1).
   */
  private lookForImages(): void {
    const wanted = new Set<string>()
    for (const row of placedSessions()) {
      const setting = storedClassPlacement(row.placement, CLASS_PLACEMENT_DEFAULT)
      if (setting.room !== 'machines' && setting.own !== 'machines' && setting.council !== 'machines') continue
      let environment = row.environment
      if (!environment) {
        try {
          environment = activeName()
        } catch {
          continue
        }
      }
      wanted.add(environment)
    }
    for (const [environment, known] of this.revisions) known.wanted = wanted.has(environment)
    for (const environment of wanted) {
      void this.classRevision(environment).then(() => {
        const known = this.revisions.get(environment)
        if (known) known.wanted = true
      })
    }
  }

  /** A class's setting changed (routes/admin-instance.ts): its image is looked for now, not at the next minute. */
  classPlacementChanged(sessionId: string, environment: string | null): void {
    // The next pass looks through every class again: one that left the machines lets its image go too.
    this.prefetchedAt = Number.NEGATIVE_INFINITY
    const setting = classPlacement(sessionId)
    if (setting.room !== 'machines' && setting.own !== 'machines' && setting.council !== 'machines') return
    let name = environment
    try {
      name ??= activeName()
    } catch {
      return
    }
    void this.classRevision(name).then(() => {
      const known = this.revisions.get(name!)
      if (known) known.wanted = true
    })
  }
}

/* ------------------------------------------------------------ the process */

let current: ClassPlacements | null = null

/** This process's placements. */
export function classPlacements(): ClassPlacements {
  current ??= new ClassPlacements()
  return current
}

/** For tests and harnesses: the process's placements become these (null — a fresh default at the next use). */
export function usePlacements(next: ClassPlacements | null): void {
  if (current && current !== next) current.close()
  current = next
}

/* The shared interface of this wave (wave2-phases.md), as functions of the process's placements. */

export const placementOf = (sessionId: string, role: RoomRole): PlacementView => classPlacements().placementOf(sessionId, role)
export const placementGate = (sessionId: string, role: RoomRole, signal?: AbortSignal): Promise<void> => classPlacements().placementGate(sessionId, role, signal)
export const onPlacementChange = (listener: (event: PlacementEvent) => void): (() => void) => classPlacements().onPlacementChange(listener)
export const moveNow = (sessionId: string, role: RoomRole | null, by: string): Promise<{ ok: true } | { refused: string }> => classPlacements().moveNow(sessionId, role, by)
export const helpPadMs = (sessionId: string, role: RoomRole): number => classPlacements().helpPadMs(sessionId, role)
export const startingWords = (sessionId: string, role: RoomRole): string | null => classPlacements().startingWords(sessionId, role)
export const wantedPlacements = (runnerId: string): RemotePlacementIntent[] => classPlacements().wantedPlacements(runnerId)
export const noteKernelsReport = (runnerId: string, kernels: RemoteKernelsRequest, now: number): void => classPlacements().noteKernelsReport(runnerId, kernels, now)
export const hasLivePlacements = (runnerId: string): boolean => classPlacements().hasLivePlacements(runnerId)
export const classTick = (now: number): void => classPlacements().classTick(now)
export const failoverRunner = (runnerId: string, cause: 'revoked' | 'unclassed' | 'leaving' | 'perimeter', now: number): number =>
  classPlacements().failoverRunner(runnerId, cause, now)
export const postmortemWanted = (runnerId: string): string[] => classPlacements().postmortemWanted(runnerId)
export const classRevisionsWanted = (runnerId: string): RemoteWantRevision[] => classPlacements().classRevisionsWanted(runnerId)
export const tunnelWanted = (runnerId: string): 'open' | 'reconnect' | 'closed' => classPlacements().tunnelWanted(runnerId)

/**
 * Whether `gen` is the slot's current placement on that machine: what a
 * late report, PUT or reading from an older gen is answered 409 `stale` by
 * (§6.9), and what the upload doors of wave 3 check. A placement being
 * stopped is still current — the kernel's last writes come home after a
 * stop as before it; only a loss fences them (§11.2), and a newer gen.
 */
export function placementCurrent(runnerId: string, sessionId: string, role: RoomRole, gen: number): boolean {
  const row = livePlacement(sessionId, role)
  return row !== null && row.runnerId === runnerId && row.gen === gen
}

/** What pool.ts calls in its early branches (§6.10), and the census and post-mortem with it. */
export const machineKernels = {
  ensure: (sessionId: string, environment: string, revisionId?: string, cpus?: number | null, memoryMb?: number | null, role: RoomRole = 'room') =>
    classPlacements().ensure(sessionId, environment, revisionId, cpus, memoryMb, role),
  drop: (sessionId: string, roles: readonly RoomRole[], options: { owner?: boolean } = {}) => classPlacements().drop(sessionId, roles, options),
  resize: (sessionId: string, role: RoomRole, change: { memoryMb?: number | null; cpus?: number | null }) => classPlacements().resize(sessionId, role, change),
  /** The classes with something live on a machine, as the idle sweep counts them (pool.ts · listRoomKernels). */
  list: (): Array<{ session: string; running: boolean; own: boolean }> => {
    const out = new Map<string, { running: boolean; own: boolean }>()
    for (const row of livePlacementRows()) {
      if (row.state === 'stopping') continue
      const seen = out.get(row.sessionId) ?? { running: false, own: false }
      seen.running = true
      seen.own ||= row.role === 'own'
      out.set(row.sessionId, seen)
    }
    return [...out].map(([session, seen]) => ({ session, ...seen }))
  },
  forget: (sessionId: string, role: RoomRole) => classPlacements().forget(sessionId, role),
  reading: (sessionId: string, role: RoomRole) => classPlacements().reading(sessionId, role),
  kills: (sessionId: string, role: RoomRole) => classPlacements().kills(sessionId, role),
  settledHome: (sessionId: string, role: RoomRole) => classPlacements().settledHome(sessionId, role),
  lostRecently: (sessionId: string, role: RoomRole) => classPlacements().lostRecently(sessionId, role),
}

/** The form's live line for a class (§13.1 Z4), staff only. */
export const placementOutlook = (sessionId: string) => classPlacements().outlook(sessionId)

/** A class's setting changed: its image is looked for at once. */
export const classPlacementChanged = (sessionId: string, environment: string | null): void => classPlacements().classPlacementChanged(sessionId, environment)
