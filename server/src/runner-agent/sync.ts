/**
 * The agent of a machine for submissions: its identity, its leases, and the
 * one long-polled sync that keeps both in step with its home
 * (docs/architecture/remote-runners.md §3).
 *
 * LEVEL-TRIGGERED. Every sync carries the machine's whole state — what it can
 * take, its cards, what it has ready, what it fetches, every attempt it holds
 * and how far each has got, its problems — and every reply the whole answer:
 * offers, revocations, outcomes applied, what to fetch and forget, whether to
 * drain, whether it is trusted. A reply lost on the way is only a delay: the
 * next one says it all again. So nothing here counts on hearing a thing once.
 *
 * WHAT IT HOLDS IS WRITTEN DOWN BEFORE IT IS SAID. A reply's leases are on the
 * disk (state.ts · writeLease, flushed) before the next sync lists them, and a
 * run's outcome is on the disk before a byte of it is uploaded. A machine that
 * dies comes back, removes its containers (the Docker runner's sweep, by the
 * label that names this tree; asked again until the daemon says none of its
 * runs still runs, before a lease of theirs is given up: sweptForGood),
 * uploads the outcomes it had written down, and reports nothing else: home
 * marks the rest lost at once instead of waiting out the silence (§3.4
 * "Agent restart").
 *
 * NO LEASE IS EVER DROPPED OVER A TRANSIENT ANSWER (client.ts says what one
 * is). The machine backs off, asks the relay whether home is offline (for the
 * status and the log), and asks again; home's own clock decides when a silent
 * machine's leases are lost, and only with evidence that the path works.
 *
 * WHEN IT STOPS TAKING WORK. A drain (`runner drain`, or home's «Осушить» in
 * a reply) finishes what is held and takes nothing more: offers that still
 * arrive are not written down, and the next sync's seq covers them, which
 * withdraws them at once with no penalty. A leave drains, then tells home it
 * is leaving and is revoked by it; revoked by its owner while it drains, it
 * has left all the same. SIGTERM (docker stop -t 90, `runner update --now`)
 * first tells home in one sync that it is draining, so that home leases it
 * nothing more, then hands back every run not yet finished as a `draining`
 * decline, which home requeues with no loss counted and no quota spent (§13
 * note 3), removes its containers and exits. A 401 is the owner's revocation:
 * the hidden test is purged, Docker's restart policy for this container is
 * turned off (or unless-stopped would start a revoked machine forever) and the
 * agent exits — unless COLLOQ_RUNNER_JOIN carries a new code, in which case the
 * dead identity is put aside and the machine joins anew.
 *
 * NEVER MORE THAN ONE SYNC CAN LIST, AND NO CRASH OVER A FULL DISK. An offer
 * past REMOTE_ATTEMPTS_MAX held (home's parser refuses a sync listing more,
 * and every lease of the machine would be lost with it), and an offer whose
 * lease cannot be written down, are declined at once and never held. A disk
 * that refuses the identity, a lease or an outcome is said as a `disk` problem
 * and lived with; a restart would only meet the same disk.
 *
 * CLASSES RIDE THE SAME SYNC, AND ONLY WHEN HOME SPEAKS OF THEM
 * (docs/architecture/remote-classes.md §7, §15). A reply's `kernels` block is
 * the whole set of class placements home wants here, which the kernel host
 * reconciles (kernels.ts) before the same reply's offers are taken: classes
 * go first, never by preemption (§6.4). The sync carries a `kernels` block
 * only after a reply that carried one, so a home without classes (0.24) never
 * meets a key its parser refuses, and a home that refuses it after all (one
 * rolled back since its last reply) gets the next sync without it at once;
 * the first sync of a life therefore carries none, and with class containers
 * adopted it is held for no time, so home's block comes back at once. Class containers outlive the agent: SIGTERM
 * leaves them running, and the stop's last sync says why it is the last
 * (`bye`: `restart` when `colloq-host runner update` left its marker,
 * `stopping` otherwise, `leaving` on a leave). A revocation, a leave and a
 * move to another home remove them with their folders. The class folders'
 * copies ride the same block (room-files.ts, §8): home's pushes and pulls in
 * the reply, the ack in every held placement's `files` and the kernels'
 * writes in `reports`, each said once the sync that carried it was answered.
 * So do the councils (council.ts, §9): the epochs home wants here and the
 * attempts whose files to collect in the reply, every epoch held and the
 * collections over in the sync.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  REMOTE_ATTEMPTS_MAX,
  REMOTE_BACKOFF_MAX_MS,
  REMOTE_BACKOFF_MIN_MS,
  REMOTE_DISK_MIN_GB,
  REMOTE_DISK_RESERVE_MB,
  REMOTE_FETCHING_MAX,
  REMOTE_HOLD_BUSY_MS,
  REMOTE_HOLD_IDLE_MS,
  REMOTE_JOIN_REPEAT_MS,
  REMOTE_OFFER_MS,
  REMOTE_PROBLEMS_MAX,
  REMOTE_PROTOCOL,
  REMOTE_REASON_CHARS,
  REMOTE_RUN_MS_MAX,
  REMOTE_UPLOAD_MS,
  remoteCount,
  remoteCredential,
  remoteProgress,
  remoteText,
  type RemoteAttemptPhase,
  type RemoteDeclineReason,
  type RemoteFacts,
  type RemoteFree,
  type RemoteHeldAttempt,
  type RemoteLease,
  type RemoteOutcomeReply,
  type RemoteProblem,
  type RemoteProgress,
  type RemoteRevokeReason,
  type RemoteRunnerState,
  type RemoteSyncReply,
  type RemoteSyncRequest,
  type RemoteWantRevision,
} from '@shared/remote-runner'
import { CLASS_PACE_BURST_BYTES, MACHINE_PACE_MBPS, parseRemoteKernelsRequest, type RemoteBye, type RemoteKernelsReply, type RemoteKernelsRequest } from '@shared/remote-kernels'
import { tunnelUrl } from '@shared/remote-tunnel'
import { DockerCompetitionRunner, RUN_LABEL } from '../competitions/docker-runner.js'
import { competitionsDir, dropAttempt, removeSubmission, attemptPath } from '../competitions/storage.js'
import type { Capacity, RunOutcome } from '../competitions/runner-port.js'
import { Backoff, RemoteClient, type CallResult, type HomeWord } from './client.js'
import { Cache, Pacer, diskRefused, type Keep } from './cache.js'
import { CouncilHost, councilUploader, type CouncilPut, type CouncilTimings } from './council.js'
import { realDocker, type Docker } from './docker.js'
import { brokenOutcome, NeighbourWindow, prepareRun, runPrepared, type Decline, type RunCard, type RunSeam } from './execute.js'
import { CHECK_LABEL, CHECK_LABELS, INSTANCE_LABEL, Images, type SmokeCard } from './images.js'
import { KernelHost, type KernelHostOptions } from './kernels.js'
import { RoomFiles, homeUploader, type RoomFileTimings, type RoomUpload, type RoomUploadAnswer } from './room-files.js'
import {
  cardReport,
  dockerInfo,
  freeCapacity,
  machineFacts,
  measureDockerDisk,
  pickCard,
  probeCards,
  readMachine,
  type CardRun,
  type DiskSpace,
  type MachinePicture,
  type ProbedCard,
} from './machine.js'
import {
  clearRestartMarker,
  dropLease,
  joined,
  readIdentity,
  readLeases,
  restartMarked,
  retired,
  retireIdentity,
  writeIdentity,
  writeLease,
  writeOutcome,
  writeStatus,
  type AgentState,
  type AgentStatus,
  type HomePath,
  type Identity,
  type Joined,
  type StateLayout,
  type StoredOutcome,
} from './state.js'
import { assembleOutcome, deliver, gzipResults, wait, type Delivery } from './upload.js'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** How often the status is written while nothing else writes it: the health check reads a status older than STATUS_STALE_MS as no agent's. */
export const STATUS_EVERY_MS = 10_000
export const STATUS_STALE_MS = 90_000
/** A refused join is asked again after this: an expired or spent code does not come back, but a fixed home might. */
const JOIN_REFUSED_WAIT_MS = 10 * 60_000
/** What a filesystem loses below the size its disk was rented at (sizeProblem): a few percent, never a missing kernel. */
const DISK_SLACK = 0.05

/** How often the cards and the daemon are asked again; sooner after a probe that failed. */
const PROBE_EVERY_MS = 30 * 60_000
const PROBE_RETRY_MS = 2 * 60_000
/** A held sync is cut short for news (something ready, a run ended, a drain) at most this often. */
const POKE_MIN_MS = 1_000
/** What the disk keeps free before what nobody wants is evicted. */
export const DISK_FLOOR_MB = 8 * 1024
/** How long a stop has to hand everything back (docker stop -t 90 kills at ninety). */
const STOP_MS = 75_000
/** How long a left machine waits for `runner leave` to hear it before the process, and its container, go. */
const LEAVE_ACK_MS = 10_000
/**
 * How long a leave waits for its classes' files to go home before it says
 * `leaving` (settleForLeave): as long as home waits for a class's files before
 * «Перенести сейчас» (kernel/remote/placement.ts · MOVE_SETTLE_MS).
 */
export const LEAVE_SETTLE_MS = 10_000
/** Attempts settled lately, whose repeats in a late reply are not taken for new offers. */
const SETTLED_KEEP = 512
/** The stop's last sync, the one that says `draining` (finalSync): a home that does not answer within this must not eat the hand-backs' time. */
const FINAL_SYNC_MS = 10_000
/** A decline of an offer never held is posted for this long at most: past REMOTE_OFFER_MS home withdraws the offer by itself. */
const OFFER_DECLINE_MS = REMOTE_OFFER_MS + 60_000
/** A join id that cannot be written down is tried again after this, and no join goes out meanwhile. */
const IDENTITY_RETRY_MS = 30_000
/** A write the disk refused stays said this long after the last one (a disk that refuses writes does not say when it stops). */
const DISK_FULL_KEEP_MS = 10 * 60_000
/** The status's line for a machine whose build home does not take. */
const OUTDATED = 'this machine\'s build is not its home\'s: it finishes what it holds and takes nothing new (colloq-host runner update)'
/** What the CAS keeps for the councils before their host is built (Cache · pinned). */
const NOTHING_PINNED: ReadonlySet<string> = new Set()

/** What the agent asks of its end of the class tunnel (runner-agent/tunnel.ts · AgentTunnel, remote-classes.md §4.6). */
export interface TunnelPort {
  want(mode: RemoteKernelsReply['tunnel']): void
  state(): { up: boolean; rttMs: number | null; since: number }
  close(): Promise<void>
}

/** What the agent hands its end of the tunnel: where to dial, as whom, and the only ports a stream may reach (kernels.ts · resolve). */
export interface TunnelOptions {
  /** `wss://<home>/api/runners/v1/tunnel` (`ws://` for a home on plain HTTP, as make dev's). */
  url: string
  /** The Authorization header's whole value: `Bearer cr1.<runnerId>.<secret>`. */
  authorization: string
  build: string
  resolve: (key: string, gen: number) => { port: number } | { refused: 'gone' | 'stale' | 'starting' }
  /** The pace of the machine's lanes towards home, as the last reply's `rates` said it. */
  paceMBps: () => number
  log: (event: string, detail?: Record<string, unknown>) => void
}

export type TunnelFactory = (options: TunnelOptions) => TunnelPort | Promise<TunnelPort>

/**
 * The tunnel's own module, loaded the first time home asks for a tunnel: a
 * machine that takes no class never loads its WebSocket client, and one whose
 * tunnel cannot load says so in its log and goes on running submissions.
 */
const agentTunnel: TunnelFactory = async (options) => new (await import('./tunnel.js')).AgentTunnel(options)

export interface AgentOptions {
  layout: StateLayout
  /** COLLOQ_RUNNER_JOIN, parsed (remoteJoinTarget); null — none given. */
  join: { home: string; code: string } | null
  build: string
  version: string
  /**
   * COLLOQ_RUNNER_CONTAINER: this agent's container, whose restart policy goes
   * off when the machine is revoked or left; null — none of its own (make
   * runner-dev, §13c note 20), and then nothing is `docker update`d or
   * inspected by a name that could be anyone's container on that daemon.
   */
  container: string | null
  /** COLLOQ_RUNNER_IMAGE: the image the cards (and Docker's disk) are probed with; null — the image of `container`, as docker says. */
  image: string | null
  docker?: Docker
  runner?: RunSeam
  fetch?: typeof fetch
  /** The machine's numbers now (tests hand in their own). */
  machine?: () => MachinePicture
  now?: () => number
  random?: () => number
  /** Tests: the backoff's bounds, the floor of the disk, the stop's time. */
  backoffMs?: { min: number; max: number }
  diskFloorMb?: number
  stopMs?: number
  /** Tests: the hold the agent asks home for; by default the contract's. */
  holdMs?: { idle: number; busy: number }
  /** Tests: the most attempts held at once, below REMOTE_ATTEMPTS_MAX (never above it). */
  attemptsMax?: number
  /** The machine's own COLLOQ_ROOM_NETWORK, KERNEL_BLOCKED_CIDRS and KERNEL_ROOM_SUBNET, for its classes' perimeter; by default the process's. */
  env?: NodeJS.ProcessEnv
  /** Tests: the class tunnel's end (AgentTunnel by default). */
  tunnel?: TunnelFactory
  /** Tests: the kernel host's seams and clock (kernels.ts). */
  classes?: Pick<KernelHostOptions, 'probe' | 'sleep' | 'timings' | 'instanceLabel'>
  /** Tests: the class folders' timings (room-files.ts): their scans, the quiet rule, the waits. */
  files?: Partial<RoomFileTimings>
  /** Tests: the council's timings (council.ts): its beat, its retries, the grace of an older epoch, the scratch sweep. */
  council?: Partial<CouncilTimings>
  log?: (line: string) => void
}

export interface AgentExit {
  reason: 'stopped' | 'revoked' | 'left' | 'refused'
  /** 0, or 78 (EX_CONFIG) for a machine started without what it needs. */
  code: number
  detail?: string
}

/** One attempt the machine holds, from the moment its lease is written down until home is done with it. */
interface Held {
  lease: RemoteLease
  receivedAt: number
  phase: RemoteAttemptPhase
  /** When its container started, on this machine's clock; null — not started. */
  startedAt: number | null
  progress: RemoteProgress | null
  card: RunCard | null
  /** Kills the container and stops the preparation: a revoke, a stop. */
  run: AbortController
  /** Stops what is sent about it: applied by a sync, revoked, the stop's deadline. */
  send: AbortController
  /** Home is done with it (revoked, applied): it is listed no more, and its files go once its task ends. */
  ended: RemoteRevokeReason | 'applied' | 'discarded' | null
  /** A stop: whatever it ran to is handed back as a `draining` decline. */
  handBack: boolean
  /** It holds memory and CPUs (from its lease until its container is gone). */
  holds: boolean
  stored: StoredOutcome | null
  task: Promise<void> | null
}

/**
 * The revisions to pull: home's `want`, in its order, then any a class
 * placement runs or is to run that it does not list (home lists them, §6.6;
 * a container must not wait on a list that missed its image), each flagged a
 * GPU kernel when a room of it holds a card.
 */
function wantedRevisions(home: readonly RemoteWantRevision[], classes: readonly RemoteWantRevision[]): RemoteWantRevision[] {
  const listed = new Set(home.map((revision) => revision.id))
  return [...home, ...classes.filter((revision) => !listed.has(revision.id))]
}

/** A promise with its resolve, for the leave and its acknowledgement. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

export class Agent extends EventEmitter {
  readonly layout: StateLayout
  private readonly options: AgentOptions
  private readonly docker: Docker
  private readonly runner: RunSeam
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly cache: Cache
  private readonly images: Images
  private readonly neighbours = new NeighbourWindow()
  private readonly held = new Map<string, Held>()
  /** The card shares GPU smoke tests hold while they run (checkCard): runs are not placed into the room a check uses. */
  private readonly checkHolds = new Set<CardRun>()
  private readonly settled = new Set<string>()
  private readonly problems = new Map<string, RemoteProblem>()
  private readonly describedWaiters = new Map<string, Set<() => void>>()
  private readonly stopAbort = new AbortController()
  private readonly started: number
  private client: RemoteClient | null = null
  private identity: Identity | null = null
  private seq = 0
  private state: AgentState = 'joining'
  private path: HomePath | null = null
  private problemLine: string | null = null
  private syncedAt: number | null = null
  private localDrain = false
  private homeDrain = false
  private leaving = false
  private stopping = false
  private trusted = false
  /** Home's cap on this machine's places, from the join and then every sync reply; null — none. */
  private approvedSlots: number | null = null
  private compatible: boolean | null = null
  private perDevice = 1
  private homeVersion: string | null = null
  private probe: { info: Awaited<ReturnType<typeof dockerInfo>>['info']; cards: ProbedCard[]; driver: string | null } = { info: null, cards: [], driver: null }
  /** The image check containers start from (COLLOQ_RUNNER_IMAGE, or this container's own), once asked. */
  private checkImage: Promise<string | null> | null = null
  /** Docker's own store, where pulls land: `same` as the tree's filesystem, its room when another, null — not measured (machine.ts · measureDockerDisk). */
  private dockerDisk: DiskSpace | 'same' | null = null
  /** When a write last met a full disk (ENOSPC): said as a `disk` problem for DISK_FULL_KEEP_MS after. */
  private diskFullAt = 0
  private factsSent: string | null = null
  private runnerHeld: Pick<Capacity, 'heldMb' | 'heldGpus'> = { heldMb: 0, heldGpus: {} }
  private syncAbort: AbortController | null = null
  private syncSentAt = 0
  private pokeTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private statusSoon: NodeJS.Timeout | null = null
  private readySignature = ''
  private evicting = false
  private stopDone: Promise<void> | null = null
  private readonly leaveDone = deferred<'left' | 'revoked' | 'stopped'>()
  private readonly leaveAck = deferred<void>()
  /** A leave's settle of its classes' files (settleForLeave): since when, whether it is over, and its bound's timer. */
  private leaveSettle: { since: number; done: boolean; timer: NodeJS.Timeout | null } | null = null
  /** The class containers (kernels.ts). */
  private readonly kernels: KernelHost
  /** The class folders' copies and their files on the way to and from home (room-files.ts). */
  private readonly files: RoomFiles
  /** The councils' epochs, scratch space and artifacts (council.ts). */
  private readonly council: CouncilHost
  /** Whether the last reply carried a `kernels` block: only then does a sync carry one (§15). */
  private kernelsHeard = false
  /**
   * The number of home's last block taken in (RemoteKernelsReply.replySeq),
   * said back in the next block (`heard`): home says again the verdicts of a
   * reply this agent never took in — one it cut short for news. Null — no
   * reply carried one (a home without the field takes no such key).
   */
  private replyHeard: number | null = null
  /** Why the class folders' last reports were left out of a sync (kernelsBlock), said once. */
  private filesRefused: string | null = null
  /** Home's last refusal of the block (blockRefused), said once. */
  private blockRefusal: string | null = null
  /** When a reply last carried one, or this life began: home's last word on its classes, for the orphan rule. */
  private kernelsHeardAt: number
  /** No reply has been taken in this life yet: the first sync with class containers adopted is held for no time. */
  private firstSync = true
  private tunnel: TunnelPort | null = null
  private tunnelOpening: Promise<void> | null = null
  private tunnelMode: RemoteKernelsReply['tunnel'] = 'closed'
  private tunnelUp = false
  private paceMBps = MACHINE_PACE_MBPS

  constructor(options: AgentOptions) {
    super()
    this.options = options
    this.layout = options.layout
    this.docker = options.docker ?? realDocker
    this.runner = options.runner ?? new DockerCompetitionRunner()
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(line))
    this.started = this.now()
    this.cache = new Cache({
      // The client exists once the home is known; the cache asks it only after that.
      client: { blob: (sha, offset, signal) => this.client!.blob(sha, offset, signal) },
      books: path.join(this.layout.booksDir),
      fetch: options.fetch,
      now: this.now,
      onChange: () => this.changed(),
      onUnauthorized: () => this.poke(true),
      inUse: () => this.inUse(),
      diskGate: (bytes, forLease) => this.mayFetch(bytes, forLease),
      onDiskFull: (detail) => this.diskFull(detail),
      // The councils' epochs, built after the cache: until then nothing is pinned, and nothing is released or evicted either.
      pinned: () => this.council?.pinned() ?? NOTHING_PINNED,
      log: this.log,
      backoff: this.newBackoff(),
    })
    this.images = new Images({
      docker: this.docker,
      dir: path.join(this.layout.booksDir, 'revisions'),
      now: this.now,
      cards: () => ({ count: this.probe.cards.length, driver: this.probe.driver }),
      onChange: () => {
        this.changed()
        // A class revision ready (or failed) is what a placement waits on.
        this.kernels?.imagesChanged()
      },
      diskGate: () => this.mayPull(),
      onDiskFull: (detail) => this.diskFull(detail),
      smokeCard: () => this.checkCard(),
      log: this.log,
    })
    this.kernelsHeardAt = this.started
    this.kernels = new KernelHost({
      layout: this.layout,
      docker: this.docker,
      images: this.images,
      container: options.container,
      image: options.image,
      env: options.env,
      cards: () => this.probe.cards,
      cardRuns: () => this.cardRuns(),
      heldGpus: () => this.runnerHeld.heldGpus ?? {},
      diskFreeMb: () => this.machine().diskFreeMb,
      diskFloorMb: this.floorMb(),
      onDiskLow: () => void this.keepDiskFloor(),
      sealed: () => this.trusted || [...this.held.values()].some((held) => held.lease.sealed && !held.ended),
      heardAt: () => this.homeHeardAt(),
      onChange: (urgent) => {
        this.changed(urgent)
        if (urgent && this.kernelsHeard) this.poke(true)
      },
      log: this.log,
      now: this.now,
      ...options.classes,
    })
    // One bucket for every byte of the classes on its way home, the class folders' and the council's alike: they share the class's rate.
    const uploads = new Pacer(this.now, CLASS_PACE_BURST_BYTES)
    this.files = new RoomFiles({
      layout: this.layout,
      // The agent's one blob stream (home cuts a second), at the class's pace: ahead of a lease's while a run waits on the push.
      blob: (sha, bytes, { signal, pace, urgent }) => this.cache.blob(sha, bytes, { signal, pace, urgent }),
      release: (sha) => this.cache.release(sha),
      hurry: () => this.cache.hurry(),
      upload: (upload) => this.uploadRoomFile(upload),
      held: (sessionId) => this.kernels.heldGens(sessionId),
      busyAt: (sessionId) => this.kernels.busyAt(sessionId),
      onChange: (urgent) => {
        this.changed(urgent)
        if (urgent && this.kernelsHeard) this.poke(true)
      },
      onUnauthorized: () => this.poke(true),
      log: this.log,
      now: this.now,
      random: options.random,
      timings: options.files,
      pacer: uploads,
    })
    this.council = new CouncilHost({
      layout: this.layout,
      docker: this.docker,
      cas: {
        // The agent's one blob stream, at the class's rate, behind a run waiting on its push and a lease's blob, ahead of prefetch.
        blob: (sha, bytes, { signal, pace, urgent }) => this.cache.blob(sha, bytes, { signal, pace, urgent }),
        has: (sha) => this.cache.has(sha),
        adopt: (file, sha) => this.cache.adopt(file, sha),
        place: (sha, to) => this.cache.place(sha, to),
        path: (sha) => this.cache.blobPath(sha, false),
        release: (sha) => this.cache.release(sha),
      },
      upload: (put) => this.uploadCouncilFile(put),
      held: (sessionId) => this.kernels.heldGens(sessionId),
      containerOf: (container) => this.kernels.containerOf(container),
      // Root's scratch space, which the agent cannot list or empty itself: its helper does (council.ts · scratchHelperArgs).
      scratch: (sessionId, action) => this.kernels.councilScratch(sessionId, action),
      diskFreeMb: () => this.machine().diskFreeMb,
      diskFloorMb: this.floorMb(),
      onDiskLow: () => void this.keepDiskFloor(),
      onChange: (urgent) => {
        this.changed(urgent)
        if (urgent && this.kernelsHeard) this.poke(true)
      },
      onUnauthorized: () => this.poke(true),
      log: this.log,
      now: this.now,
      random: options.random,
      timings: options.council,
      pacer: uploads,
    })
  }

  /* --------------------------------------------------------- lifecycle */

  /**
   * The agent's whole life: the sweep and the recovery of an earlier one, the
   * join, then syncs until it stops, leaves or is revoked.
   */
  async run(): Promise<AgentExit> {
    this.writeStatus()
    this.statusTimer = setInterval(() => {
      this.watchTunnel()
      this.writeStatus()
    }, STATUS_EVERY_MS)
    this.statusTimer.unref?.()
    try {
      // A marker an earlier stop did not take is no word about this life's (colloq-host writes it right before the stop it means).
      clearRestartMarker(this.layout)
      await this.sweep()
      const stored = readLeases(this.layout)
      // Leases with nothing written down are given up below: only once no container of theirs still runs.
      if (stored.some((entry) => entry.outcome === null) && !(await this.sweptForGood())) return { reason: 'stopped', code: 0 }
      this.recover(stored)
      this.cache.load()
      // The councils' epochs an earlier life held, checked against the CAS that holds their files (and pins them from now on).
      this.council.load()
      // The class folders' copies an earlier life left, each with what both sides last agreed (§8.1): home's first block says whose they are.
      this.files.load()
      await this.images.load()
      // The class kernels an earlier life started run on (§7.3): found again before the first sync, so that they hold what they hold.
      await this.kernels.adopt()
      const identity = await this.ensureJoined()
      if ('reason' in identity) return identity
      for (const held of this.held.values()) {
        if (held.stored) held.task = this.deliverTask(held).finally(() => this.settle(held))
      }
      this.startProbes()
      return await this.loop()
    } finally {
      // A stop that began meanwhile hands back and sweeps before the process may go.
      if (this.stopDone) await this.stopDone
      this.finish()
    }
  }

  /** `runner drain`: finish what is held, take nothing new, until a restart (draining is not written down). */
  requestDrain(): void {
    if (this.localDrain) return
    this.localDrain = true
    this.log('[runner] draining: the runs held finish, nothing new is taken')
    // The runs held are to finish, the hidden-test ones too: what they read stays until they settle (cache.ts · purgeSealed).
    this.cache.purgeSealed('drain', this.inUse().manifests)
    this.changed(true)
    this.poke(true)
  }

  /** `runner leave`: drain, then tell home and be revoked by it. Resolves when it is done (or cannot be). */
  requestLeave(): Promise<'left' | 'revoked' | 'stopped'> {
    if (!this.leaving) {
      this.leaving = true
      this.log('[runner] leaving: the runs held finish, then this machine revokes itself')
      this.cache.purgeSealed('leave', this.inUse().manifests)
      this.changed(true)
      this.poke(true)
    }
    return this.leaveDone.promise
  }

  /** The one who asked for the leave heard that it is done: the process may go. */
  leaveAcknowledged(): void {
    this.leaveAck.resolve()
  }

  /**
   * SIGTERM: home hears first that the machine is draining (finalSync), then
   * everything not yet finished is handed back as a `draining` decline, a
   * finished run keeps uploading until the stop's time is up (its outcome is
   * written down: the next life sends it), the containers go. The last sync's
   * time is the stop's own: docker stop kills at ninety seconds whatever is
   * still under way.
   */
  stop(): Promise<void> {
    if (this.stopDone) return this.stopDone
    this.stopping = true
    this.log('[runner] stopping: the runs held go back to home\'s queue')
    this.stopAbort.abort()
    this.leaveDone.resolve('stopped')
    this.stopDone = (async () => {
      const began = Date.now()
      await this.finalSync()
      // Said (or not, home being away): the marker meant this stop, and the next stop is not an update unless it says so again.
      clearRestartMarker(this.layout)
      // The class containers run on, written down for the next life (§7.3): only the host's own timers and the tunnel go.
      this.kernels.stop()
      this.files.stop()
      this.council.stop()
      await this.closeTunnel()
      for (const held of this.held.values()) {
        if (held.stored || held.ended) continue
        held.handBack = true
        held.run.abort()
      }
      this.changed(true)
      const limit = Math.max(1_000, (this.options.stopMs ?? STOP_MS) - (Date.now() - began))
      const deadline = setTimeout(() => {
        for (const held of this.held.values()) held.send.abort()
      }, limit)
      try {
        await Promise.race([Promise.allSettled([...this.held.values()].map((held) => held.task)), wait(limit + 5_000)])
      } finally {
        clearTimeout(deadline)
      }
      for (const held of this.held.values()) held.send.abort()
      await this.sweep('on the way out')
      this.state = 'stopped'
      this.writeStatus()
    })()
    return this.stopDone
  }

  /**
   * The stop's word to home before anything is handed back: one sync that
   * says `draining`, listing every attempt still held as it is (a sync is
   * level-triggered: one it leaves out, home counts lost at once). Home leases
   * a draining machine nothing more, neither in this reply nor in the replies
   * to the hand-backs after it (routes.ts takes work for an `active` sync and
   * for an outcome after one): without it each decline's reply could carry a
   * fresh offer from the head of the queue, which a stopping machine passes
   * and never syncs again to refuse, and which waits REMOTE_OFFER_MS before
   * anyone else may run it. Held for no time (holdMs 0) and for at most
   * FINAL_SYNC_MS. What the reply revokes or applied is taken in, so that a run
   * home has already given up is not handed back; its offers are passed.
   *
   * AND THE SEQ THEY MOVED IS SAID ONCE MORE. The reply repeats every offer
   * home made the machine and has not seen acked — those of the held sync
   * the stop cut off on its way back among them, which the agent never read.
   * Passing them moves the agent's seq past them, and home withdraws an
   * offer at once only when a sync says a seq at or above its own; the
   * hand-backs' replies carry none, and no sync followed: home held those
   * rows offered to a machine on its way out for REMOTE_OFFER_MS, while
   * other machines and this server sat idle beside them. So when the reply
   * moved the seq, a second draining sync, held for no time and within the
   * same FINAL_SYNC_MS, says it, and the offers go back to the queue now.
   */
  private async finalSync(): Promise<void> {
    const identity = this.identity
    if (!this.client || !identity || !joined(identity) || retired(identity)) return
    const within = AbortSignal.timeout(FINAL_SYNC_MS)
    for (let round = 0; round < 2; round++) {
      const request: RemoteSyncRequest = { ...this.syncRequest(), holdMs: 0 }
      const answer = await this.client.sync(request, within)
      // A home that does not take the block hears the stop without it.
      if (answer.kind === 'refused' && round === 0 && this.blockRefused(request, answer)) continue
      if (answer.kind !== 'ok') {
        this.log(`[runner] home did not hear the stop (${answer.kind === 'refused' ? answer.error : answer.reason}); the runs go back as they are handed back`)
        return
      }
      try {
        for (const revoke of answer.value.revoke) this.revoke(revoke.id, revoke.reason)
        for (const id of answer.value.applied) this.applied(id)
        this.trust(answer.value.trusted)
        this.acceptLeases(answer.value.leases, answer.value.seq)
      } catch (error) {
        this.log(`[runner] the stop's last reply could not be taken in: ${String(error)}`)
      }
      if (this.seq <= request.seq) return
    }
  }

  status(): AgentStatus {
    const identity = this.identity
    return {
      joined: joined(identity) && !retired(identity),
      home: identity?.home ?? this.options.join?.home ?? null,
      runnerId: identity?.runnerId ?? null,
      state: this.state,
      held: this.held.size,
      version: this.options.version,
      build: this.options.build,
      ...(this.homeVersion ? { homeVersion: this.homeVersion } : {}),
      compatible: this.compatible,
      trusted: joined(identity) ? this.trusted : null,
      approvedSlots: joined(identity) ? this.approvedSlots : null,
      path: this.path,
      problem: this.problemLine,
      pid: process.pid,
      startedAt: this.started,
      updatedAt: this.now(),
      syncedAt: this.syncedAt,
      tunnel: this.tunnel ? (({ up, rttMs }) => ({ up, rttMs }))(this.tunnel.state()) : null,
      classes: this.kernels.counts(),
    }
  }

  private finish(): void {
    for (const timer of [this.statusTimer, this.probeTimer, this.pokeTimer, this.statusSoon, this.leaveSettle?.timer ?? null]) if (timer) clearTimeout(timer)
    this.statusTimer = this.probeTimer = this.pokeTimer = this.statusSoon = null
    if (this.leaveSettle) this.leaveSettle.timer = null
    this.images.stop()
    this.cache.stop()
    this.kernels.stop()
    this.files.stop()
    this.council.stop()
    void this.closeTunnel()
    this.writeStatus()
  }

  /* ---------------------------------------------------------- recovery */

  /**
   * Remove this tree's containers: the Docker runner's sweep, by its labels and
   * the instance label that names this data root (docker-runner.ts ·
   * INSTANCE_LABEL), and the agent's own check containers.
   */
  private async sweep(why = 'left by an earlier life'): Promise<void> {
    const swept = await this.runner.sweep().catch(() => 0)
    // Both labels: a check container of another tree on this daemon is that agent's, mid-run (images.ts · INSTANCE_LABEL).
    const found = await this.docker(['ps', '-aq', '--filter', `label=${CHECK_LABEL}`, '--filter', `label=${INSTANCE_LABEL}`], { timeoutMs: 20_000 })
    const checks = found.code === 0 ? found.out.split('\n').map((line) => line.trim()).filter((line) => /^[a-f0-9]{12,64}$/.test(line)) : []
    if (checks.length > 0) await this.docker(['rm', '-f', ...checks], { timeoutMs: 60_000 })
    if (swept + checks.length > 0) this.log(`[runner] removed ${swept + checks.length} container(s) ${why}`)
  }

  /**
   * Before the leases an earlier life wrote down without an outcome are given
   * up (recover), the daemon must say that no run of this tree still runs:
   * the sweep again and again, with a backoff, until it does. True once it
   * has; false — the agent stops meanwhile.
   *
   * THE SWEEP SAYS NOTHING WHEN IT FAILS. The Docker runner's sweep skips a
   * `docker ps` that failed (a busy daemon, a timeout) and reports nothing
   * removed, and once it read as done: the leases were dropped and their
   * trees deleted under containers that still ran a notebook each, home
   * marked them lost at once and requeued them, to this same machine as like
   * as not, whose `free` counted none of the memory, CPUs or card those
   * containers held — the same notebook run twice here, and runs placed
   * beside them dying of an out-of-memory nobody accounted for, billed to
   * their participants. So the leases stay written down, the machine syncs
   * not at all (home's own clock decides when a silent machine's leases are
   * lost, and it takes nothing meanwhile), and the status says why, until
   * the daemon answers that none of this tree's runs is still running
   * (runsLeft). Exited ones are no concern: they hold nothing, and the Docker
   * runner's cleanup keeps after them.
   */
  private async sweptForGood(): Promise<boolean> {
    const backoff = this.newBackoff()
    let said: string | null = null
    for (;;) {
      if (this.stopping) return false
      const left = await this.runsLeft()
      if (left === 0) {
        if (said !== null) this.log('[runner] no run of an earlier life runs here any more: its leases are given up')
        this.problemLine = null
        return true
      }
      const problem = left === null
        ? 'docker does not answer whether the runs of an earlier life still run; their leases are kept until it does, and nothing is taken meanwhile'
        : `${left} run(s) of an earlier life still run here and could not be removed; their leases are kept until they are, and nothing is taken meanwhile`
      if (problem !== said) this.log(`[runner] ${problem}`)
      said = problem
      this.problemLine = problem
      this.writeStatus()
      await this.sleep(backoff.next())
      if (this.stopping) return false
      await this.sweep()
    }
  }

  /**
   * Every class container of this tree and every class folder gone
   * (kernels.ts · removeAll), asked again and again with a backoff until
   * docker lists none of them, as sweptForGood asks for the runs: a class
   * kernel left running on a machine that has left, been revoked or moved
   * holds a class's work, and a machine that is gone has no later life to
   * remove it. The status says why meanwhile; only a stop ends the wait,
   * and the next life's adoption finds what is left by its labels.
   */
  private async removeClasses(why: string): Promise<void> {
    const backoff = this.newBackoff()
    let said: string | null = null
    // Nothing of the class folders, nor of the councils' epochs and scratch space, is under way, or written again, while they go.
    await this.files.clear()
    await this.council.clear()
    for (;;) {
      const left = await this.kernels.removeAll(why)
      if (left === 0) {
        if (said !== null) {
          this.log('[runner] every class container of this machine is gone at last')
          this.problemLine = null
        }
        return
      }
      const problem = left === null
        ? `${why}: docker does not answer whether the class kernels here are gone; asked again until it does`
        : `${why}: ${left} class container(s) could not be removed; asked again until they are`
      if (problem !== said) this.log(`[runner] ${problem}`)
      said = problem
      this.problemLine = problem
      this.writeStatus()
      if (this.stopping) return
      await this.sleep(backoff.next())
      if (this.stopping) return
    }
  }

  /** How many of this tree's runs are still running, as the daemon says (`docker ps` lists the running ones); null — it did not answer. */
  private async runsLeft(): Promise<number | null> {
    const found = await this.docker(['ps', '-q', '--filter', `label=${RUN_LABEL}`, '--filter', `label=${INSTANCE_LABEL}`], { timeoutMs: 20_000 })
    if (found.code !== 0) return null
    return found.out.split('\n').map((line) => line.trim()).filter((line) => /^[a-f0-9]{12,64}$/.test(line)).length
  }

  /**
   * What the identity being put aside held: its leases are its home's to
   * requeue, its outcomes can no longer be sent by anyone, and its seq was
   * its own (a new machine's offers start from the first).
   */
  private forgetHeld(): void {
    for (const held of [...this.held.values()]) {
      held.ended ??= 'discarded'
      this.settle(held)
    }
    this.seq = 0
  }

  /**
   * The leases an earlier life wrote down (`stored`, read before the sweep
   * was made sure of: sweptForGood): those whose outcome it wrote down are
   * uploaded again (and listed as uploading); the rest are dropped with their
   * trees and not reported, so home marks them lost at once. Attempt trees no
   * kept lease names go too.
   */
  private recover(stored: ReturnType<typeof readLeases>): void {
    for (const { lease } of stored) this.seq = Math.max(this.seq, lease.seq)
    const kept = new Set<string>()
    let dropped = 0
    for (const entry of stored) {
      const { lease, outcome } = entry
      if (!outcome) {
        dropLease(this.layout, lease.attemptId)
        dropped++
        continue
      }
      kept.add(lease.attemptId)
      const started = outcome.startedAt !== null
      this.held.set(lease.attemptId, {
        ...this.fresh(lease, entry.receivedAt),
        phase: started ? 'uploading' : 'preparing',
        startedAt: outcome.startedAt,
        holds: false,
        stored: outcome,
      })
    }
    this.sweepTrees(kept)
    if (dropped + kept.size > 0) this.log(`[runner] after a restart: ${kept.size} outcome(s) to upload, ${dropped} lease(s) dropped (home requeues them)`)
  }

  /** Attempt trees (data/competitions/<c>/s/<s>/attempts/<a>) that no kept attempt names, and submissions left with none. */
  private sweepTrees(kept: ReadonlySet<string>): void {
    let competitions: string[] = []
    try {
      competitions = fs.readdirSync(competitionsDir)
    } catch {
      return
    }
    for (const competition of competitions) {
      if (competition.startsWith('.')) continue
      const s = path.join(competitionsDir, competition, 's')
      let submissions: string[] = []
      try {
        submissions = fs.readdirSync(s)
      } catch {
        continue
      }
      for (const submission of submissions) {
        let attempts: string[] = []
        try {
          attempts = fs.readdirSync(path.join(s, submission, 'attempts'))
        } catch { /* none */ }
        const keep = attempts.filter((attempt) => kept.has(attempt))
        if (keep.length === 0) {
          fs.rmSync(path.join(s, submission), { recursive: true, force: true })
          continue
        }
        for (const attempt of attempts) if (!kept.has(attempt)) fs.rmSync(path.join(s, submission, 'attempts', attempt), { recursive: true, force: true })
      }
    }
  }

  /* ---------------------------------------------------------------- join */

  /**
   * The identity to sync with: the one written down, a new join, or an exit.
   * Never another home's secret to this one: an identity of another home is
   * put aside. A revoked or left identity is put aside only for a new code in
   * COLLOQ_RUNNER_JOIN; with the same code the machine stays gone.
   */
  private async ensureJoined(): Promise<Joined | AgentExit> {
    const target = this.options.join
    const code = target ? sha256(target.code) : null
    let identity = readIdentity(this.layout)
    if (identity && target && identity.home !== target.home) {
      const kept = this.putAside('moved')
      this.log(`[runner] this machine belonged to ${identity.home}; that identity is put aside (${kept}) to join ${target.home}`)
      this.forgetHeld()
      // Another home's classes are none of the new one's: their kernels and folders go with the identity.
      await this.removeClasses('this machine now belongs to another home')
      identity = null
    }
    if (joined(identity)) {
      if (!retired(identity)) return this.adopt(identity)
      const why = identity.leftAt !== undefined ? 'left' : 'revoked'
      if (!target || code === identity.codeSha256) {
        this.identity = identity
        return this.gone(why, why === 'left'
          ? 'this machine left its home with this code; a new code from the home\'s owner joins it again'
          : 'this machine was revoked by its home\'s owner; a new code joins it again')
      }
      const kept = this.putAside(why)
      this.log(`[runner] the ${why} identity is put aside (${kept}); joining ${target.home} with the new code`)
      this.forgetHeld()
      // What the gone identity's removal left (adopted at this start) is none of the new one's.
      await this.removeClasses(`the ${why} identity's classes`)
      identity = null
    }
    if (!target) return { reason: 'refused', code: 78, detail: 'COLLOQ_RUNNER_JOIN is not set and this machine has not joined a home: -e COLLOQ_RUNNER_JOIN=\'https://<home>#<code>\'' }
    if (!identity || identity.codeSha256 !== code) {
      // Written down before the first try: a join whose reply is lost is the same join next time.
      identity = { home: target.home, joinId: randomBytes(16).toString('hex'), joinIdAt: this.now(), codeSha256: code! }
      const stopped = await this.writeJoinId(identity)
      if (stopped) return stopped
    }
    return this.joinWith(identity, target.code)
  }

  /**
   * The join, asked until home answers it (a transient answer is asked
   * again with a backoff, a refusal after JOIN_REFUSED_WAIT_MS).
   *
   * A JOIN ID HOME NO LONGER HONOURS IS MINTED ANEW. The same id is the same
   * join, which home answers with the same machine and a new secret — but
   * only within REMOTE_JOIN_REPEAT_MS of the machine's first join; past it
   * home refuses the id (`code`), whatever uses the code has left. A join
   * whose reply was lost, then a home unreachable for longer than that (or a
   * disk that refused the identity after the join, and a restart later), met
   * that refusal on every try for ever: the machine stayed out, its first
   * row in the panel never synced, and its host needed a new code by hand.
   * So a `code` refusal of a join id at least that old mints a new one and
   * asks again at once: home did not honour the old one, so no second
   * machine is made where the first would have been answered, and a code
   * that is spent or expired refuses the new id as well, which then waits
   * as any refusal does. Never sooner than that: within the window a refusal
   * is the code's own.
   */
  private async joinWith(identity: Identity, code: string): Promise<Joined | AgentExit> {
    this.identity = identity
    this.state = 'joining'
    this.client = new RemoteClient({ home: identity.home, build: this.options.build, credential: () => null, fetch: this.options.fetch })
    const backoff = this.newBackoff()
    for (;;) {
      if (this.stopping) return { reason: 'stopped', code: 0 }
      const answer = await this.client.join({ protocol: REMOTE_PROTOCOL, build: this.options.build, code, joinId: identity.joinId, facts: await this.facts() }, this.stopAbort.signal)
      if (this.stopping) return { reason: 'stopped', code: 0 }
      if (answer.kind === 'ok') {
        const done: Joined = { ...identity, runnerId: answer.value.runnerId, secret: answer.value.secret, trusted: answer.value.trusted, approvedSlots: answer.value.approvedSlots, joinedAt: this.now() }
        // Not written down, the secret lives for this life: the next one joins with the same id, which home answers with a new secret.
        this.keepIdentity(done)
        this.log(`[runner] joined ${identity.home} as ${done.runnerId}${done.trusted ? ', trusted with the hidden test' : ''}`)
        this.syncedAt = this.now()
        return this.adopt(done)
      }
      if (answer.kind === 'refused' && answer.error === 'code' && this.now() - (identity.joinIdAt ?? 0) >= REMOTE_JOIN_REPEAT_MS) {
        const minted: Identity = { ...identity, joinId: randomBytes(16).toString('hex'), joinIdAt: this.now() }
        this.log(`[runner] home no longer honours this machine's join (its first try is over ${Math.round(REMOTE_JOIN_REPEAT_MS / 60_000)} min old); joining again as a new machine`)
        const stopped = await this.writeJoinId(minted)
        if (stopped) return stopped
        identity = minted
        this.identity = minted
        continue
      }
      if (answer.kind === 'refused') {
        this.state = 'refused'
        this.path = 'refused'
        this.problemLine = answer.error === 'code'
          ? 'home refused the code: it is unknown, used up or expired; take a new one from the home\'s owner'
          : `home refused the join: ${answer.error}${answer.detail ? ` (${answer.detail})` : ''}`
        this.log(`[runner] ${this.problemLine}`)
        this.writeStatus()
        await this.sleep(JOIN_REFUSED_WAIT_MS)
        continue
      }
      await this.hiccup(answer, backoff)
    }
  }

  private adopt(identity: Joined): Joined {
    this.identity = identity
    this.trusted = identity.trusted === true
    this.approvedSlots = identity.approvedSlots ?? null
    this.state = this.wireState()
    this.problemLine = null
    this.client = new RemoteClient({
      home: identity.home,
      build: this.options.build,
      credential: () => remoteCredential(identity.runnerId, identity.secret),
      fetch: this.options.fetch,
    })
    this.writeStatus()
    return identity
  }

  /**
   * Revoked or left for good. The hidden test goes first, whichever way out
   * this is (§4.2: purged on a 401 and on the way out): a leave purges it
   * only as far as the runs held allow (requestLeave), and what the last of
   * them read went with the leaving sync's reply — unless that reply was
   * lost and the retry met the 401 of a machine home had marked left
   * already, or the owner disconnected it in between, when nothing else
   * would ever purge it: the machine never syncs again, and a university
   * server keeps a disk for years. A start of an identity that is gone
   * purges it too, for what an earlier life left behind. Nothing is held
   * here: a leaving sync goes out only with nothing held, and a revocation
   * has discarded everything first (discardAll). Then Docker must not start
   * this container again into a home that refuses it.
   */
  private async gone(why: 'left' | 'revoked', detail: string): Promise<AgentExit> {
    try {
      this.cache.purgeSealed(why)
    } catch (error) {
      this.log(`[runner] the hidden test could not be purged on the way out: ${error instanceof Error ? error.message : String(error)}`)
    }
    // A class machine's kernels and the class folders, whichever way out (§7.3, §11.5): home has moved the classes away already.
    await this.closeTunnel()
    await this.removeClasses(why === 'left' ? 'this machine has left its home' : 'home revoked this machine')
    await this.noRestart()
    this.state = why
    this.problemLine = detail
    this.log(`[runner] ${detail}`)
    this.writeStatus()
    return { reason: why, code: 0, detail }
  }

  private async noRestart(): Promise<void> {
    // No container of its own (make runner-dev): nothing restarts it, and a container that happens to bear the usual name is somebody else's.
    if (this.options.container === null) return
    const updated = await this.docker(['update', '--restart=no', this.options.container], { timeoutMs: 30_000 })
    if (updated.code !== 0) this.log(`[runner] could not turn off the restart policy of ${this.options.container} (not in that container?): ${updated.out.split('\n')[0] ?? ''}`)
  }

  /**
   * The identity written down, or the failure said and lived with: a disk
   * that refuses it (ENOSPC) costs the next life this one's word (a trust, a
   * revocation, a join's secret, which a join with the same id gets anew),
   * where a crash would cost every run held and meet the same disk at the next
   * start, a restart loop with the hidden test still on the disk.
   */
  private keepIdentity(identity: Identity): boolean {
    try {
      writeIdentity(this.layout, identity)
      return true
    } catch (error) {
      this.writeFailed('the identity', error)
      return false
    }
  }

  /** The identity put aside; one that cannot be renamed is overwritten by the next instead (nothing ever reads one put aside). */
  private putAside(why: 'revoked' | 'left' | 'moved'): string | null {
    try {
      return retireIdentity(this.layout, why)
    } catch (error) {
      this.log(`[runner] the ${why} identity could not be put aside: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * A join's id written down before its first try, however long the disk
   * takes to allow it: a join whose id is not on the disk would, were its
   * reply lost and the agent restarted, be a second machine against the
   * owner's code. Null once written; an exit when the agent stops first.
   */
  private async writeJoinId(identity: Identity): Promise<AgentExit | null> {
    for (;;) {
      if (this.stopping) return { reason: 'stopped', code: 0 }
      try {
        writeIdentity(this.layout, identity)
        this.problemLine = null
        return null
      } catch (error) {
        this.writeFailed('the join', error)
        this.problemLine = `the join cannot be written down (${error instanceof Error ? error.message : String(error)}); it is tried again in ${Math.round(IDENTITY_RETRY_MS / 1000)} s`
        this.writeStatus()
        await this.sleep(IDENTITY_RETRY_MS)
      }
    }
  }

  /** A file of the machine's own that could not be written: logged, and a `disk` problem when the disk had no room for it. */
  private writeFailed(what: string, error: unknown): void {
    const said = `${what} could not be written down: ${error instanceof Error ? error.message : String(error)}`
    this.log(`[runner] ${said}`)
    if (diskRefused(error)) this.diskFull(said)
  }

  /* ---------------------------------------------------------------- loop */

  private async loop(): Promise<AgentExit> {
    const backoff = this.newBackoff()
    for (;;) {
      if (this.stopping) return { reason: 'stopped', code: 0 }
      this.runnerHeld = await this.runner.capacity().catch(() => ({ heldMb: 0, heldGpus: {} }))
      this.expire()
      this.settleForLeave()
      const request = this.syncRequest()
      const abort = new AbortController()
      this.syncAbort = abort
      this.syncSentAt = this.now()
      const answer = await this.client!.sync(request, AbortSignal.any([abort.signal, this.stopAbort.signal]))
      this.syncAbort = null
      if (this.stopping) return { reason: 'stopped', code: 0 }
      if (answer.kind === 'ok') {
        backoff.reset()
        this.path = 'ok'
        this.problemLine = answer.value.compatible ? null : OUTDATED
        this.syncedAt = this.now()
        this.firstSync = false
        if (request.facts) this.factsSent = JSON.stringify(request.facts)
        // Home has the readings, the file reports and the collections over this sync carried: none is said again, and this reply's verdicts find them.
        if (request.kernels) {
          this.kernels.readingsSaid(request.kernels.readings)
          this.files.reportsSaid(request.kernels.reports)
          this.council.said(request.kernels)
        }
        try {
          this.handleReply(answer.value)
        } catch (error) {
          // A reply is the whole answer, said again by the next one: a failure taking it in (a disk, a bug) is a delay, never the agent's end.
          this.log(`[runner] a sync reply could not be taken in whole: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        }
        if (request.state === 'leaving') return this.left()
        this.writeStatus()
        continue
      }
      // Cut short for news: ask again at once. Home took the block in as the sync arrived and only then held its answer: the file
      // reports it carried count as said (room-files.ts · reportsCut), never sent again as new.
      if (abort.signal.aborted) {
        if (request.kernels) {
          this.files.reportsCut(request.kernels.reports)
          this.council.said(request.kernels)
        }
        continue
      }
      if (answer.kind === 'refused') {
        if (answer.error === 'unauthorized') {
          const exit = await this.unauthorized(request.state === 'leaving')
          if (exit) return exit
          continue
        }
        // A home that does not take the block (rolled back to a release without classes, or refusing a field of it): the next sync
        // goes without it at once, and the syncs after it too until a reply carries one again (§15). A refusal of a sync without the
        // block is the backoff's below, as before.
        if (this.blockRefused(request, answer)) continue
        this.path = 'refused'
        // Another version of the contract: no lease is taken here until the machine runs home's release, which `compatible: false` tells the fleet's update.
        if (answer.error === 'protocol') this.compatible = false
        this.problemLine = answer.error === 'protocol'
          ? `home runs another version of this machine's protocol (${answer.detail}): it needs the release home runs (colloq-host runner update)`
          : `home refused the sync: ${answer.error}${answer.detail ? ` (${answer.detail})` : ''}`
        this.log(`[runner] ${this.problemLine}`)
        this.writeStatus()
        // Another protocol, or our own bug: no quick retry changes it.
        await this.sleep(backoff.next(this.options.backoffMs?.max ?? REMOTE_BACKOFF_MAX_MS))
        continue
      }
      if (answer.heard) {
        await this.unread(answer, answer.heard, backoff)
        continue
      }
      await this.hiccup(answer, backoff)
    }
  }

  /**
   * Home answered the sync in words this build's parser refuses (a home of
   * another build, or our own bug): nothing of it is taken in, and the leases
   * stay as they are, as after any transient answer — but home's plain word
   * on this build is the status's (client.ts · HomeWord): `runner status` once
   * kept saying `compatible: true` from the last reply it could read, while
   * every reply since said false. No relay to ask: home itself answered.
   */
  private async unread(answer: Extract<CallResult<never>, { kind: 'transient' }>, word: HomeWord, backoff: Backoff): Promise<void> {
    this.compatible = word.compatible
    if (word.homeVersion) this.homeVersion = word.homeVersion
    this.path = 'ok'
    this.problemLine = word.compatible ? `home's reply could not be read by this machine: ${answer.reason}` : OUTDATED
    if (backoff.streak === 0) this.log(`[runner] ${answer.reason}${word.compatible ? '' : `; ${OUTDATED}`}; trying again`)
    this.writeStatus()
    await this.sleep(backoff.next(answer.retryAfterMs))
  }

  /**
   * After a transient answer: what the relay says (on the first of a streak
   * and every fifth), and a wait.
   *
   * THE RELAY'S "TUNNEL UP" IS NOT A CONFIRMATION. It is frps's word that the
   * home's proxy is registered, and frps notices a tunnel cut under it (a
   * firewall, a dead link) only when its heartbeats time out, a minute or
   * more later: through a cut of four minutes the agent logged that its
   * relay's tunnel was up. Only `tunnel: false` is the relay knowing; with
   * the tunnel said up and home silent, whether the tunnel is up is said to
   * be unknown — a home that hangs, or a tunnel the relay has not yet seen
   * go.
   */
  private async hiccup(answer: Extract<CallResult<never>, { kind: 'transient' }>, backoff: Backoff): Promise<void> {
    const before = this.path
    if (backoff.streak % 5 === 0) this.path = await this.client!.relayState(this.stopAbort.signal)
    if (this.path !== before || backoff.streak === 0) {
      const words: Record<string, string> = {
        home_offline: 'home is offline (its relay has no tunnel to it)',
        home_silent: 'home does not answer, and whether its relay\'s tunnel to it is up is unknown (the relay says so, but sees a cut tunnel only a while later)',
        home_unknown: 'the relay serves no home by this name (is the address in COLLOQ_RUNNER_JOIN right?)',
        unreachable: 'neither home nor its relay answers',
      }
      this.log(`[runner] ${answer.reason}: ${words[this.path ?? ''] ?? 'home did not answer'}; trying again`)
    }
    this.writeStatus()
    await this.sleep(backoff.next(answer.retryAfterMs))
  }

  /**
   * A 401. While leaving with nothing held, it is home revoking the machine as
   * asked. With a new code in COLLOQ_RUNNER_JOIN, the dead identity goes aside
   * and the machine joins anew (null: go on syncing). Otherwise the owner
   * revoked it (the header): an exit.
   *
   * A machine asked to leave that the owner revokes while it still drains has
   * got where the leave was going: it is gone from its home, and `runner
   * leave` hears that it left, and that it was revoked (control.ts), rather
   * than a dropped connection colloq-host would read as "did not leave" and
   * answer by turning the restart policy back on. And it joins nothing anew,
   * whatever code waits: it was asked to go.
   */
  private async unauthorized(leaving: boolean): Promise<AgentExit | null> {
    if (leaving) return this.left()
    const identity = this.identity!
    await this.discardAll('the machine was revoked')
    this.cache.purgeSealed('revoked')
    // The revoked identity's classes, whether the machine joins anew or goes: home failed them over first (§11.5).
    await this.closeTunnel()
    await this.removeClasses('home revoked this machine')
    this.kernelsHeard = false
    this.replyHeard = null
    const target = this.options.join
    if (!this.leaving && target && target.home === identity.home && sha256(target.code) !== identity.codeSha256) {
      this.keepIdentity({ ...identity, revokedAt: this.now() })
      const kept = this.putAside('revoked')
      this.log(`[runner] home revoked this machine; its identity is put aside (${kept}) and it joins again with the new code`)
      this.forgetHeld()
      const next: Identity = { home: target.home, joinId: randomBytes(16).toString('hex'), joinIdAt: this.now(), codeSha256: sha256(target.code) }
      const stopped = await this.writeJoinId(next)
      if (stopped) return stopped
      const done = await this.joinWith(next, target.code)
      return 'reason' in done ? done : null
    }
    this.identity = { ...identity, revokedAt: this.now() }
    this.keepIdentity(this.identity)
    const exit = await this.gone('revoked', 'home revoked this machine (its owner disconnected it); a new code joins it again')
    if (this.leaving) {
      this.leaveDone.resolve('revoked')
      await Promise.race([this.leaveAck.promise, wait(LEAVE_ACK_MS)])
    }
    return exit
  }

  /**
   * Whether home refused a sync for its `kernels` block: a 400 (the parser
   * of a home rolled back to 0.24 meets a key it does not know, or a home
   * refuses a field of the block) or a 413 (0.24's sync is a sixteenth of
   * this one's) of a sync that carried it. Then no sync carries it until a
   * reply carries one again, and the tunnel goes with it: without this, every
   * sync after was refused the same way, and the machine synced no more —
   * no leases, its attempts lost by silence — until its agent restarted.
   */
  private blockRefused(request: RemoteSyncRequest, answer: Extract<CallResult<never>, { kind: 'refused' }>): boolean {
    if (!request.kernels || (answer.error !== 'invalid' && answer.error !== 'too_large')) return false
    this.kernelsHeard = false
    this.replyHeard = null
    this.tunnelWant('closed')
    const said = `${answer.error}${answer.detail ? ` (${answer.detail})` : ''}`
    if (said !== this.blockRefusal) this.log(`[runner] home refused the sync's kernels block: ${said}; the syncs go without it until a reply carries one`)
    this.blockRefusal = said
    return true
  }

  /** The leaving sync was answered (or the machine was revoked by it): written down, said, and the process may go. */
  private async left(): Promise<AgentExit> {
    if (this.identity) {
      this.identity = { ...this.identity, leftAt: this.now() }
      this.keepIdentity(this.identity)
    }
    const exit = await this.gone('left', 'this machine has left its home; a new code from the home\'s owner joins it again')
    this.leaveDone.resolve('left')
    // `runner leave` must hear it before the process, and its container with it, are gone.
    await Promise.race([this.leaveAck.promise, wait(LEAVE_ACK_MS)])
    return exit
  }

  /* ------------------------------------------------------------- the sync */

  /**
   * The state a sync says: leaving only once nothing is held (a leave drains
   * first) and its classes' files went home (settleForLeave); a stopping
   * machine drains (finalSync).
   */
  private wireState(): RemoteRunnerState {
    if (this.stopping) return 'draining'
    if (this.leaving) return this.held.size === 0 && this.leaveSettle?.done === true ? 'leaving' : 'draining'
    return this.localDrain ? 'draining' : 'active'
  }

  /**
   * A LEAVE SETTLES ITS CLASSES' FILES FIRST (remote-classes.md §11.5, §8.7):
   * once its runs are done, every copy of a class here is scanned now, what
   * the scan found is said and answered, and what home pulls of it is
   * uploaded — within LEAVE_SETTLE_MS, as home waits before «Перенести
   * сейчас» — and only then does a sync say `leaving`, whose answer fails the
   * classes over and lets this machine remove their copies. A cell's file
   * written a moment before the leave is the class's; a home that does not
   * answer meanwhile has the machine leave at the bound all the same.
   */
  private settleForLeave(): void {
    if (!this.leaving || this.held.size > 0 || this.leaveSettle?.done) return
    const now = this.now()
    if (!this.leaveSettle) {
      if (!this.kernelsHeard || !this.files.holdsCopies()) {
        this.leaveSettle = { since: now, done: true, timer: null }
        return
      }
      // The bound's own beat: a held sync is cut then, whatever home says meanwhile.
      const timer = setTimeout(() => this.poke(true), LEAVE_SETTLE_MS)
      timer.unref?.()
      this.leaveSettle = { since: now, done: false, timer }
      this.log(`[runner] leaving: the class files go home first (${LEAVE_SETTLE_MS / 1000} s at most)`)
      /*
       * Scanned now. A scan that found something cuts the held sync itself, for its report (room-files.ts · onChange); one that
       * found nothing says nothing, and the held sync is cut here then, for the leaving sync — never one that may carry a report.
       */
      const since = now
      void this.files.scanAll().then(() => {
        if (this.files.settledSince(since)) this.poke(true)
      })
      return
    }
    const settled = this.files.settledSince(this.leaveSettle.since)
    if (!settled && now - this.leaveSettle.since < LEAVE_SETTLE_MS) return
    if (this.leaveSettle.timer) clearTimeout(this.leaveSettle.timer)
    this.leaveSettle = { ...this.leaveSettle, done: true, timer: null }
    this.log(settled ? '[runner] leaving: the class files are home' : `[runner] leaving: the class files did not all go home within ${LEAVE_SETTLE_MS / 1000} s; leaving all the same`)
  }

  /** Whether an offer is written down: not while draining (for whichever reason), leaving, stopping, or outdated. */
  private takesWork(): boolean {
    return !this.localDrain && !this.homeDrain && !this.leaving && !this.stopping && this.compatible !== false
  }

  private syncRequest(): RemoteSyncRequest {
    const attempts = this.listed()
    const facts = this.factsNow()
    const changedFacts = JSON.stringify(facts) !== this.factsSent
    const hold = this.options.holdMs ?? { idle: REMOTE_HOLD_IDLE_MS, busy: REMOTE_HOLD_BUSY_MS }
    const state = this.wireState()
    const kernels = this.kernelsHeard ? this.kernelsBlock(state) : null
    // Class containers say their progress as attempts do, within the busy hold.
    const busy = attempts.length > 0 || (kernels?.placements.length ?? 0) > 0
    // The first sync of a life carries no block (none goes out before a reply carried one): with class containers adopted,
    // home is asked for its block now, not after a held sync's time, so that the next sync says them.
    const asap = this.firstSync && kernels === null && this.kernels.holdsAny()
    return {
      protocol: REMOTE_PROTOCOL,
      build: this.options.build,
      seq: this.seq,
      holdMs: asap ? 0 : busy ? Math.min(hold.busy, REMOTE_HOLD_BUSY_MS) : Math.min(hold.idle, REMOTE_HOLD_IDLE_MS),
      state,
      free: this.free(),
      cards: this.cardsNow().cards,
      ready: {
        revisions: this.images.readyIds(),
        data: this.cache.readyData(),
        sealed: this.trusted ? this.cache.readySealed() : [],
        bundles: this.cache.readyBundles(),
      },
      fetching: [...this.images.fetchingList(), ...this.cache.fetchingList()].slice(0, REMOTE_FETCHING_MAX),
      attempts,
      problems: this.problemsNow(),
      ...(changedFacts ? { facts } : {}),
      ...(kernels ? { kernels } : {}),
    }
  }

  /**
   * The machine's `kernels` block (§15): every class container held, each
   * with how far its class folder's copy is from home (`files`: the last push
   * applied whole is the ack, room-files.ts); what the kernels wrote
   * (`reports`); the councils' epochs, held or on their way, and the
   * attempts whose files are home (`epochs`, `collected`); the post-mortem
   * readings home asked for, the tunnel, the facts home's eligibility reads,
   * and, in the last sync of this life, why it is the last.
   */
  private kernelsBlock(state: RemoteRunnerState): RemoteKernelsRequest {
    const bye: RemoteBye | undefined = state === 'leaving' ? 'leaving' : this.stopping ? (restartMarked(this.layout) ? 'restart' : 'stopping') : undefined
    const collected = this.council.collectedNow()
    const block: RemoteKernelsRequest = {
      placements: this.kernels.held().map((held) => {
        const lag = this.files.lag(held.key.slice(0, held.key.lastIndexOf(':')))
        return lag ? { ...held, files: lag } : held
      }),
      reports: this.files.reportsNow(),
      epochs: this.council.epochsNow(),
      readings: this.kernels.readingsNow(),
      tunnel: this.tunnel?.state().up ? 'up' : 'down',
      ...(bye ? { bye } : {}),
      classes: this.kernels.facts(),
      ...(this.replyHeard !== null ? { heard: this.replyHeard } : {}),
      // Only of attempts home named, so a home without the key never meets it (§15).
      ...(collected.length > 0 ? { collected } : {}),
    }
    /*
     * Read first as home's strict parser reads it: what a kernel wrote is
     * participant data, and a report or a lag home would refuse costs the
     * machine its whole block (blockRefused) — every class on it, its tunnel
     * closed. What the class folders say goes without them this time (their
     * reports are built again for the next sync), and the log says why once;
     * and so do the councils' parts, last, should they be what home refuses.
     */
    try {
      parseRemoteKernelsRequest(block)
      this.filesRefused = null
      return block
    } catch (error) {
      const bare: RemoteKernelsRequest = { ...block, placements: block.placements.map(({ files: _files, ...held }) => held), reports: [] }
      const bareOf = (candidate: RemoteKernelsRequest): boolean => {
        try {
          parseRemoteKernelsRequest(candidate)
          return true
        } catch {
          return false
        }
      }
      const { collected: _collected, ...barest } = { ...bare, epochs: [] }
      const sent = bareOf(bare) ? bare : bareOf(barest) ? barest : null
      // Not the class folders' nor the councils': home's refusal says what it is (blockRefused), as before.
      if (sent === null) return block
      const why = error instanceof Error ? error.message : String(error)
      if (this.filesRefused !== why) this.log(`[runner] the class folders' reports${sent === barest ? ' and the councils\' epochs' : ''} would not pass home's parser (${why}); the sync goes without them`)
      this.filesRefused = why
      return sent
    }
  }

  /**
   * The problems a sync says, one of each code about each subject: the disk
   * can be short of its floor, have refused a write and be smaller than a
   * machine of its kind needs all at once, and the owner reads one line about
   * it, the first of those (the floor's: it says what nothing more frees).
   */
  private problemsNow(): RemoteProblem[] {
    if (this.diskFullAt > 0 && this.now() - this.diskFullAt > DISK_FULL_KEEP_MS) {
      this.problems.delete('disk-full')
      this.diskFullAt = 0
    }
    const seen = new Set<string>()
    const said: RemoteProblem[] = []
    // The machine's own in this order, whenever each was found: the floor's `disk` before a refused write's.
    const own = (['docker', 'cards', 'disk', 'disk-full'] as const).flatMap((key) => this.problems.get(key) ?? [])
    for (const problem of [...own, ...this.sizeProblem(), ...this.images.problemList(), ...this.cache.problemList()]) {
      const key = `${problem.code}:${problem.revisionId ?? problem.manifest ?? problem.bundleId ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      said.push(problem)
    }
    return said.slice(0, REMOTE_PROBLEMS_MAX)
  }

  /** Every attempt held and not ended, as the contract carries it. */
  private listed(): RemoteHeldAttempt[] {
    const now = this.now()
    const found: RemoteHeldAttempt[] = []
    for (const held of this.held.values()) {
      if (held.ended) continue
      const started = held.startedAt !== null
      // A phase after the start says how long the container has run; one that cannot is said as before it.
      const phase: RemoteAttemptPhase = (held.phase === 'running' || held.phase === 'exporting' || held.phase === 'uploading') && !started ? 'preparing' : held.phase
      const entry: RemoteHeldAttempt = { id: held.lease.attemptId, phase }
      if (phase === 'running' || phase === 'exporting' || phase === 'uploading') entry.runningMs = remoteCount(now - held.startedAt!, 0, REMOTE_RUN_MS_MAX)
      if (phase === 'running' && held.progress) entry.progress = held.progress
      if (phase !== 'accepted' && held.card) entry.card = { device: held.card.device, sliceMb: held.card.sliceMb }
      found.push(entry)
    }
    return found
  }

  private handleReply(reply: RemoteSyncReply): void {
    this.perDevice = reply.perDevice
    this.compatible = reply.compatible
    this.homeVersion = reply.homeVersion
    this.trust(reply.trusted)
    // The owner's «Места»: what `free` offers from now on, and what a restart starts from before the first reply.
    if (reply.approvedSlots !== this.approvedSlots && this.identity && joined(this.identity)) {
      this.identity = { ...this.identity, approvedSlots: reply.approvedSlots }
      this.keepIdentity(this.identity)
      this.log(`[runner] home allows this machine ${reply.approvedSlots === null ? 'as many places as it offers' : `${reply.approvedSlots} place(s) at once`}`)
    }
    this.approvedSlots = reply.approvedSlots
    // A machine on its way out is drained by home as well (its leaving sync's reply): nothing to say about that.
    if (reply.drain && !this.homeDrain) {
      if (!this.leaving) this.log('[runner] home drains this machine: the runs held finish, nothing new is taken')
      this.cache.purgeSealed('drain', this.inUse().manifests)
    }
    if (!reply.drain && this.homeDrain) this.log('[runner] home takes this machine back into work')
    this.homeDrain = reply.drain
    for (const revoke of reply.revoke) this.revoke(revoke.id, revoke.reason)
    for (const id of reply.applied) this.applied(id)
    this.cache.forget(reply.forget)
    // The classes first, before this reply's offers: what they hold is out of `free` when the offers are prepared (§6.4).
    if (reply.kernels) {
      this.kernelsHeard = true
      this.kernelsHeardAt = this.now()
      this.paceMBps = reply.kernels.rates.machinePaceMBps
      this.kernels.reconcile(reply.kernels)
      // The class folders after the containers: a copy home no longer names waits for its containers to go (room-files.ts).
      this.files.reconcile(reply.kernels)
      // The councils' epochs and the attempts' files, the same way: a class's council folder goes once nothing of it runs here.
      this.council.reconcile(reply.kernels)
      // Taken in, its verdicts among it: the next block says so.
      this.replyHeard = reply.kernels.replySeq ?? null
      this.tunnelWant(reply.kernels.tunnel)
    } else {
      // A reply without the block says nothing of classes (a home without them): the next sync carries none, the containers stay.
      this.kernelsHeard = false
      this.replyHeard = null
      this.tunnelWant('closed')
    }
    this.images.want(wantedRevisions(reply.want.revisions, this.kernels.revisions()))
    // A draining or leaving machine keeps none of the hidden test, whatever `want` still lists (purged on drain, decision 1).
    const draining = this.localDrain || this.homeDrain || this.leaving
    this.cache.want(draining ? reply.want.data.filter((entry) => !entry.sealed) : reply.want.data, reply.want.bundles)
    for (const bundle of reply.want.bundles) {
      if (bundle.lock === undefined) continue
      for (const wake of this.describedWaiters.get(bundle.id) ?? []) wake()
      this.describedWaiters.delete(bundle.id)
    }
    this.acceptLeases(reply.leases, reply.seq)
    void this.keepDiskFloor()
  }

  /**
   * Offers from a sync or an outcome reply. Each new one is written down
   * before anything else happens to it, and its run starts. Not taking work
   * (a drain, a leave, a stop, an outdated build), the offers are not written
   * down and the seq is moved past them: home withdraws them at once.
   *
   * Two offers are declined at once instead, before anything is done for
   * them (declineOffer): one past the most attempts a sync may list
   * (REMOTE_ATTEMPTS_MAX: home's parser refuses a sync with more, and a
   * machine whose every sync is refused loses every lease it holds, its
   * neighbours' runs with the offer), which only a home that over-leased can
   * send; and one whose lease the disk will not take, which held unwritten
   * would be a run the next life knows nothing of.
   */
  private acceptLeases(leases: readonly RemoteLease[], replySeq: number): void {
    let passed = false
    const most = Math.min(REMOTE_ATTEMPTS_MAX, this.options.attemptsMax ?? REMOTE_ATTEMPTS_MAX)
    for (const lease of leases) {
      if (this.held.has(lease.attemptId) || this.settled.has(lease.attemptId)) continue
      if (!this.takesWork()) {
        passed = true
        continue
      }
      if (this.listed().length >= most) {
        this.declineOffer(lease, 'memory', `this machine already holds ${most} attempts, the most one sync can list; home offered more`)
        continue
      }
      // The hidden test never lies beside a class (D3): home's parser refuses a reply with both, this refuses one across replies.
      if (lease.sealed && this.kernels.holdsAny()) {
        this.declineOffer(lease, 'draining', 'this machine holds class kernels, and the hidden test never lies beside them')
        continue
      }
      const receivedAt = this.now()
      try {
        writeLease(this.layout, { lease, receivedAt })
      } catch (error) {
        this.writeFailed(`the lease of ${lease.attemptId.slice(0, 8)}`, error)
        this.declineOffer(lease, 'disk', `the lease could not be written down: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      this.seq = Math.max(this.seq, lease.seq)
      const held = this.fresh(lease, receivedAt)
      this.held.set(lease.attemptId, held)
      held.task = this.attempt(held)
      this.log(`[runner] took ${lease.attemptId.slice(0, 8)} (submission ${lease.submissionId}${lease.gpu ? ', a card' : ''}${lease.sealed ? ', hidden test' : ''})`)
    }
    if (passed) this.seq = Math.max(this.seq, replySeq)
    this.changed(true)
  }

  /**
   * An offer declined without being held: never written down, never listed,
   * never run; its decline is posted like any outcome (home declines an offer
   * it has not seen acked as well as an accepted one, and does not offer this
   * machine the submission again for a while). The seq is not moved past it:
   * a sync that left it out at or above its seq would withdraw it first and
   * the decline would find it gone, with nothing said about why. Posted for
   * OFFER_DECLINE_MS at most, through every hiccup: past that home has
   * withdrawn the offer by itself. Remembered as settled, so that a repeat of
   * the offer in a later reply is not taken for a new one.
   */
  private declineOffer(lease: RemoteLease, reason: RemoteDeclineReason, detail: string): void {
    this.remember(lease.attemptId)
    this.log(`[runner] declined ${lease.attemptId.slice(0, 8)} without taking it (${reason}): ${detail}`)
    void deliver({
      client: this.client!,
      build: this.options.build,
      attemptId: lease.attemptId,
      stored: { kind: 'declined', reason, detail: remoteText(detail, REMOTE_REASON_CHARS, 'start'), startedAt: null },
      uploads: [],
      free: () => this.free(),
      signal: AbortSignal.any([this.stopAbort.signal, AbortSignal.timeout(OFFER_DECLINE_MS)]),
      onReply: (reply) => this.outcomeReply(reply),
      backoff: () => this.newBackoff(),
      sleep: (ms, signal) => wait(ms, signal),
      log: this.log,
    }).then((how) => {
      if (how === 'unauthorized') this.poke(true)
    }, (error: unknown) => this.log(`[runner] the decline of ${lease.attemptId.slice(0, 8)} failed: ${String(error)}`))
  }

  /**
   * Home's reply to an outcome: its word on the hidden test, as a sync's
   * (an untrust between two syncs purges it here, before the next work is
   * taken), and the next work it carries, taken as a sync's offers are.
   */
  private outcomeReply(reply: RemoteOutcomeReply): void {
    this.trust(reply.trusted)
    this.acceptLeases(reply.leases, reply.seq)
  }

  /**
   * Home's word on whether this machine may hold the hidden test, from any
   * reply that says it: written down when it changes (a restart starts from
   * it), and the hidden test purged at once when it is no (decision 1).
   */
  private trust(trusted: boolean): void {
    if (trusted !== this.trusted && this.identity && joined(this.identity)) {
      this.identity = { ...this.identity, trusted }
      this.keepIdentity(this.identity)
      this.log(`[runner] home ${trusted ? 'trusts this machine with the hidden test now' : 'no longer trusts this machine with the hidden test'}`)
    }
    this.trusted = trusted
    if (!trusted && this.cache.holdsSealed()) this.cache.purgeSealed('untrusted')
  }

  /** An attempt this machine is done with, whose repeats in a late reply are not new offers. */
  private remember(attemptId: string): void {
    this.settled.add(attemptId)
    if (this.settled.size > SETTLED_KEEP) this.settled.delete(this.settled.values().next().value!)
  }

  private fresh(lease: RemoteLease, receivedAt: number): Held {
    return {
      lease,
      receivedAt,
      phase: 'accepted',
      startedAt: null,
      progress: null,
      card: null,
      run: new AbortController(),
      send: new AbortController(),
      ended: null,
      handBack: false,
      holds: true,
      stored: null,
      task: null,
    }
  }

  /**
   * Outcomes home can no longer want: past the lease's ceiling (its
   * deadlineMs, counted from when the machine wrote it down, which is after
   * home offered it) and the upload's time again, home has revoked the lease
   * and counted it lost, whatever the machine still sends. Through a long
   * outage they would be asked again forever and their trees kept; they go.
   */
  private expire(): void {
    const now = this.now()
    for (const held of this.held.values()) {
      if (held.ended || !held.stored || now <= held.receivedAt + held.lease.deadlineMs + REMOTE_UPLOAD_MS) continue
      held.ended = 'discarded'
      held.send.abort()
      this.log(`[runner] ${held.lease.attemptId.slice(0, 8)} is past its ceiling at home, which has given it up; its outcome is discarded`)
      if (!held.task) this.settle(held)
    }
  }

  /** Home revoked an attempt: its container is killed, nothing more is sent about it, its files go. */
  private revoke(id: string, reason: RemoteRevokeReason): void {
    const held = this.held.get(id)
    if (!held) {
      dropLease(this.layout, id)
      return
    }
    if (held.ended) return
    held.ended = reason
    held.run.abort()
    held.send.abort()
    this.log(`[runner] ${id.slice(0, 8)} revoked by home (${reason})`)
    if (!held.task) this.settle(held)
    this.changed(true)
  }

  /** Home applied an attempt's outcome: its tree is deleted. */
  private applied(id: string): void {
    const held = this.held.get(id)
    if (!held) {
      dropLease(this.layout, id)
      return
    }
    if (held.ended || !held.stored) return
    held.ended = 'applied'
    held.send.abort()
    if (!held.task) this.settle(held)
    this.changed(true)
  }

  /* ------------------------------------------------------------ attempts */

  /** One attempt, from its lease to home's last word on it (see the header and execute.ts). */
  private async attempt(held: Held): Promise<void> {
    const { lease } = held
    try {
      held.phase = 'preparing'
      this.changed()
      const prepared = await prepareRun({
        lease,
        receivedAt: held.receivedAt,
        cache: this.cache,
        images: this.images,
        picture: this.machine(),
        holding: this.holding(),
        heldMb: this.runnerHeld.heldMb ?? 0,
        attempts: this.held.size,
        trusted: this.trusted,
        cards: this.probe.cards,
        claimCard: (perDevice) => this.claimCard(held, perDevice),
        described: (bundleId, signal) => this.described(bundleId, signal),
        signal: held.run.signal,
        now: this.now,
      })
      if (held.ended) return
      if (held.handBack || this.stopping) return await this.decline(held, { reason: 'draining', detail: 'the machine is stopping' })
      if (!prepared.ok) return await this.decline(held, prepared.decline)
      held.card = prepared.run.card
      held.phase = 'running'
      held.startedAt = this.now()
      this.changed(true)
      this.poke()
      let outcome: RunOutcome
      try {
        outcome = await runPrepared(this.runner, prepared.run, held.run.signal, (progress) => {
          held.progress = remoteProgress(progress)
        })
      } catch (error) {
        outcome = brokenOutcome(error, this.now() - held.startedAt)
      }
      const endedAt = this.now()
      held.holds = false
      this.poke()
      if (held.ended) return
      if (held.handBack) return await this.decline(held, { reason: 'draining', detail: 'the machine stopped while the run was under way' })
      held.phase = 'exporting'
      this.changed()
      const crowded = await this.neighbours.crowded({
        outcome,
        card: held.card,
        startedAt: held.startedAt,
        endedAt,
        stays: () => [...this.held.values()].some((other) => other !== held && other.holds && other.card?.device === held.card?.device),
        signal: held.send.signal,
        now: this.now,
      })
      const resultDir = attemptPath(lease.competitionId, lease.submissionId, lease.attemptId, 'result')
      let stored: StoredOutcome
      try {
        stored = await assembleOutcome({ outcome, resultDir, card: held.card, crowded, startedAt: held.startedAt, endedAt })
      } catch (error) {
        stored = await assembleOutcome({ outcome: brokenOutcome(error, outcome.wall), resultDir: this.nowhere(), card: held.card, crowded: false, startedAt: held.startedAt, endedAt })
      }
      if (held.ended) return
      this.keepOutcome(held, stored)
      held.stored = stored
      held.phase = 'uploading'
      this.changed(true)
      await this.deliverTask(held)
    } catch (error) {
      this.log(`[runner] ${lease.attemptId.slice(0, 8)} failed here: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (!held.ended && !held.stored) {
        // Before the container: the closest reason there is. After it, our failure as the run's outcome.
        if (held.startedAt === null) await this.decline(held, { reason: held.handBack ? 'draining' : 'disk', detail: `the machine failed preparing it: ${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined)
      }
    } finally {
      held.holds = false
      // A stop keeps what is written down for the next life (settle says so); anything else leaves the machine.
      this.settle(held)
    }
  }

  /**
   * What a run came to, written down before a byte of it goes out (a restart
   * sends it again). A disk that will not take it costs exactly that: the
   * outcome goes up from memory all the same, and only a restart before home
   * answered would lose it, where a throw here lost it at once (the attempt
   * left unreported, a finished run counted lost).
   */
  private keepOutcome(held: Held, stored: StoredOutcome): void {
    try {
      writeOutcome(this.layout, held.lease.attemptId, stored)
    } catch (error) {
      this.writeFailed(`the outcome of ${held.lease.attemptId.slice(0, 8)}`, error)
    }
  }

  /** Declined before any container (or handed back): written down, then posted like an outcome. */
  private async decline(held: Held, decline: Decline): Promise<void> {
    held.holds = false
    const stored: StoredOutcome = { kind: 'declined', reason: decline.reason, detail: remoteText(decline.detail, REMOTE_REASON_CHARS, 'start'), startedAt: held.startedAt }
    this.keepOutcome(held, stored)
    held.stored = stored
    if (held.startedAt !== null) held.phase = 'uploading'
    if (decline.reason !== 'draining') this.log(`[runner] declined ${held.lease.attemptId.slice(0, 8)} (${decline.reason}): ${decline.detail}`)
    this.changed(true)
    await this.deliverTask(held)
  }

  /** The upload and the outcome (upload.ts), and what home's answer means for the attempt. */
  private async deliverTask(held: Held): Promise<void> {
    const stored = held.stored!
    const { lease } = held
    let uploads: Awaited<ReturnType<typeof gzipResults>> = []
    if (stored.kind === 'finished' && stored.files.length > 0) {
      const resultDir = attemptPath(lease.competitionId, lease.submissionId, lease.attemptId, 'result')
      try {
        uploads = await gzipResults(resultDir, stored.files, path.join(resultDir, '..', 'upload'))
      } catch (error) {
        this.log(`[runner] the files of ${lease.attemptId.slice(0, 8)} could not be compressed (${String(error)}); home refuses the outcome without them`)
      }
    }
    const how: Delivery = await deliver({
      client: this.client!,
      build: this.options.build,
      attemptId: lease.attemptId,
      stored,
      uploads,
      free: () => this.free(held),
      signal: held.send.signal,
      onReply: (reply) => this.outcomeReply(reply),
      backoff: () => this.newBackoff(),
      sleep: (ms, signal) => wait(ms, signal),
      log: this.log,
    })
    if (how === 'stopped') return
    if (how === 'unauthorized') {
      // The sync says it to the whole machine at once.
      this.poke(true)
      return
    }
    held.ended ??= how === 'applied' ? 'applied' : 'discarded'
    if (how !== 'applied') this.log(`[runner] ${lease.attemptId.slice(0, 8)}: home ${how === 'discarded' ? 'has no use for it' : `answered ${how}`}; discarded`)
    this.changed(true)
  }

  /**
   * An attempt that home is done with leaves the machine: its lease and
   * outcome files, its attempt tree, and its submission's folder once no
   * other attempt of it is held.
   */
  private settle(held: Held): void {
    if (this.held.get(held.lease.attemptId) !== held) return
    if (!held.ended && held.stored && this.stopping) return
    const { lease } = held
    this.held.delete(lease.attemptId)
    this.remember(lease.attemptId)
    dropLease(this.layout, lease.attemptId)
    try {
      dropAttempt(lease.competitionId, lease.submissionId, lease.attemptId)
      if (![...this.held.values()].some((other) => other.lease.submissionId === lease.submissionId)) removeSubmission(lease.competitionId, lease.submissionId)
    } catch (error) {
      this.log(`[runner] the tree of ${lease.attemptId.slice(0, 8)} could not be removed: ${String(error)}`)
    }
    this.changed(true)
    this.poke()
  }

  /** Everything held, given up: a revocation or a stop that will not hand back. */
  private async discardAll(why: string): Promise<void> {
    for (const held of this.held.values()) {
      held.ended ??= 'discarded'
      held.run.abort()
      held.send.abort()
    }
    await Promise.race([Promise.allSettled([...this.held.values()].map((held) => held.task)), wait(30_000)])
    for (const held of [...this.held.values()]) this.settle(held)
    await this.sweep('of runs given up')
    this.log(`[runner] ${why}: everything held is discarded`)
  }

  /* -------------------------------------------------------- the machine */

  private machine(): MachinePicture {
    return this.options.machine?.() ?? readMachine(this.layout.root)
  }

  /**
   * What the attempts hold, from their lease until their container is gone,
   * and what the class containers hold (§6.4): `free` is one truth for
   * submissions and classes, with no arithmetic of its own for either.
   */
  private holding(): Array<{ memoryMb: number; cpus: number }> {
    const attempts = [...this.held.values()].filter((held) => held.holds && !held.ended).map((held) => ({ memoryMb: held.lease.limits.memoryMb, cpus: held.lease.limits.cpus }))
    return [...attempts, ...this.kernels.holding()]
  }

  /**
   * The shares taken on the cards: each run's, at the runs per card its lease
   * pinned, each smoke test's while it runs, and the whole card of each GPU
   * class room (§6.5), as a run at one per card.
   */
  private cardRuns(): CardRun[] {
    const runs = [...this.held.values()].filter((held) => held.holds && held.card).map((held) => ({ device: held.card!.device, perDevice: held.card!.perDevice }))
    return [...runs, ...this.checkHolds, ...this.kernels.cardRuns()]
  }

  /**
   * The card a GPU revision's smoke test runs on (images.ts ·
   * ImagesOptions.smokeCard): the one a run would take now, the least loaded
   * with a share free at home's runs per card (pickCard, the pick of the
   * runs' own shares), and held as a run's share is until the test ends, so
   * that no lease is placed into the room the check uses meanwhile; null —
   * every card is full, and the check waits for one.
   */
  private checkCard(): SmokeCard | null {
    const device = pickCard(this.probe.cards, this.perDevice, this.cardRuns(), this.runnerHeld.heldGpus ?? {})
    if (device === null) return null
    const hold: CardRun = { device, perDevice: this.perDevice }
    this.checkHolds.add(hold)
    this.changed()
    return {
      device,
      release: () => {
        this.checkHolds.delete(hold)
        this.changed()
      },
    }
  }

  private cardsNow(): ReturnType<typeof cardReport> {
    return cardReport(this.probe.cards, this.perDevice, this.cardRuns(), this.runnerHeld.heldGpus ?? {}, this.kernels.wholeCards())
  }

  /** The share an attempt takes, picked and held in one breath (execute.ts · PrepareInput.claimCard). */
  private claimCard(held: Held, perDevice: number): string | null {
    const device = pickCard(this.probe.cards, perDevice, this.cardRuns(), this.runnerHeld.heldGpus ?? {})
    if (device !== null) held.card = { device, sliceMb: null, perDevice }
    return device
  }

  /**
   * What the machine can still take (machine.ts · freeCapacity), in a sync
   * or with an outcome. An outcome's leaves out the attempt it reports
   * (`reporting`): home applies or ends that lease before it reads the room
   * the outcome offers for the next one, and its stale-capacity rule adds
   * back only the live leases the last sync listed (lease.ts · runnerRoom),
   * so a place still counted here for an attempt home has just let go was a
   * place lost: a machine at its places (the owner's «Места») got none in
   * any completion reply, and each run cost one more sync and its round
   * trip before the next began. What that attempt holds besides is out of
   * `free` already: its container is gone.
   */
  private free(reporting: Held | null = null): RemoteFree {
    return freeCapacity({
      picture: this.machine(),
      holding: this.holding(),
      heldMb: this.runnerHeld.heldMb ?? 0,
      attempts: this.held.size - (reporting !== null && this.held.get(reporting.lease.attemptId) === reporting ? 1 : 0),
      gpuShares: this.cardsNow().freeShares,
      approvedSlots: this.approvedSlots,
    })
  }

  private factsNow(): RemoteFacts {
    return machineFacts({ version: this.options.version, info: this.probe.info, picture: this.machine(), driver: this.probe.driver })
  }

  /** The facts for the join: the daemon asked first when no probe has yet. */
  private async facts(): Promise<RemoteFacts> {
    if (!this.probe.info) {
      const asked = await dockerInfo(this.docker)
      this.probe.info = asked.info
      this.setProblem('docker', asked.problem)
    }
    return this.factsNow()
  }

  private startProbes(): void {
    const once = async (): Promise<void> => {
      let failed = false
      const asked = await dockerInfo(this.docker)
      if (asked.info) this.probe.info = asked.info
      this.setProblem('docker', asked.problem)
      failed ||= asked.problem !== null
      // Where pulls land, measured anew with every probe (and before every pull, and after the evictions that free it); one filesystem with the tree stays one.
      if (this.dockerDisk !== 'same') this.dockerDisk = (await this.measureDocker()) ?? this.dockerDisk
      const image = await this.probeImage()
      const cards = await probeCards(this.docker, image)
      if (cards.problem === null) {
        this.probe.cards = cards.cards
        this.probe.driver = cards.driver
      }
      this.setProblem('cards', cards.problem)
      failed ||= cards.problem !== null
      if (this.probe.cards.length > 0) this.log(`[runner] cards: ${this.probe.cards.map((card) => `${card.device} ${card.name ?? '?'} ${card.memoryMb ?? '?'} MB`).join(', ')}; driver ${this.probe.driver ?? 'unknown'}`)
      this.changed(true)
      this.poke()
      if (this.stopping) return
      this.probeTimer = setTimeout(() => void once(), failed ? PROBE_RETRY_MS : PROBE_EVERY_MS)
      this.probeTimer.unref?.()
    }
    void once()
  }

  /**
   * The image the check containers start from (the card probe, the measure
   * of Docker's disk): COLLOQ_RUNNER_IMAGE, or the image this container runs,
   * as docker says; null — neither (no container of its own and no image
   * named: make runner-dev), and then no check container is started at all.
   * A probe that found none asks again; one found is kept.
   */
  private probeImage(): Promise<string | null> {
    if (this.options.image) return Promise.resolve(this.options.image)
    if (this.options.container === null) return Promise.resolve(null)
    this.checkImage ??= this.ownImage().then((image) => {
      if (image === null) this.checkImage = null
      return image
    })
    return this.checkImage
  }

  /** The image this container runs, when COLLOQ_RUNNER_IMAGE did not say: what `--gpus all` probes the cards with. */
  private async ownImage(): Promise<string | null> {
    if (this.options.container === null) return null
    const asked = await this.docker(['inspect', '-f', '{{.Config.Image}}', this.options.container], { timeoutMs: 20_000 })
    const image = asked.code === 0 ? asked.out.trim().split('\n')[0]?.trim() ?? '' : ''
    return image || null
  }

  private setProblem(code: 'docker' | 'cards' | 'disk', detail: string | null): void {
    if (detail === null) this.problems.delete(code)
    else this.problems.set(code, { code, detail: remoteText(detail, REMOTE_REASON_CHARS, 'start') })
  }

  /**
   * A write the disk refused for want of room, from wherever it came (a
   * blob, a pull, the identity, a lease, an outcome): a `disk` problem for
   * DISK_FULL_KEEP_MS after the last one, kept apart from the floor's own
   * (which a statfs above the floor clears: a disk out of inodes refuses
   * writes with room to spare), and eviction asked for.
   */
  private diskFull(detail: string): void {
    this.diskFullAt = this.now()
    this.problems.set('disk-full', { code: 'disk', detail: remoteText(detail, REMOTE_REASON_CHARS, 'start') })
    void this.keepDiskFloor()
    this.changed()
  }

  /** The floor of free disk: below it eviction begins, and nothing is prefetched or pulled. */
  private floorMb(): number {
    return this.options.diskFloorMb ?? DISK_FLOOR_MB
  }

  /**
   * Whether a fetch of `bytes` into the tree may start (cache.ts · diskGate).
   * A prefetch only while the disk is at or above the floor, the line
   * eviction keeps: below it, fetching what nobody waits for would only be
   * evicted again, or fill the disk under the runs. A lease's own blob may
   * take the disk lower, down to what the machine promised home it always
   * keeps (REMOTE_DISK_RESERVE_MB, the reserve in `free.diskMb`): home leased
   * it on that promise. Refused, eviction is asked for, and the floor's
   * `disk` problem says when nothing more can go.
   */
  private mayFetch(bytes: number, forLease: boolean): boolean {
    const free = this.machine().diskFreeMb
    if (free === null) return true
    if (forLease ? free - Math.ceil(bytes / (1024 * 1024)) >= REMOTE_DISK_RESERVE_MB : free >= this.floorMb()) return true
    void this.keepDiskFloor()
    return false
  }

  /** Whether a pull may start (images.ts · diskGate): Docker's disk, measured now, at or above the floor. */
  private async mayPull(): Promise<boolean> {
    const free = await this.pullFreeMb(true)
    if (free === null || free >= this.floorMb()) return true
    void this.keepDiskFloor()
    return false
  }

  /**
   * Docker's own store, measured (machine.ts · measureDockerDisk), with the
   * check containers' labels: what `docker info` says it is, against the
   * tree. Null when it cannot be told, which no pull is refused for.
   */
  private async measureDocker(): Promise<DiskSpace | 'same' | null> {
    return measureDockerDisk({
      docker: this.docker,
      rootDir: this.probe.info?.rootDir ?? null,
      tree: this.layout.root,
      image: await this.probeImage(),
      contained: this.options.container !== null,
      labels: CHECK_LABELS,
    })
  }

  /**
   * The free disk where pulls land: Docker's own store when it is a
   * filesystem of its own (measured anew when `fresh`: a pull's few
   * gigabytes or an eviction change it), the tree's otherwise, and the tree's
   * too when Docker's could not be measured: no worse a guess than before.
   */
  private async pullFreeMb(fresh: boolean): Promise<number | null> {
    if (fresh && this.dockerDisk !== 'same') {
      // The first pull may come before the first probe has asked the daemon where its store is.
      if (!this.probe.info) await this.facts()
      this.dockerDisk = (await this.measureDocker()) ?? this.dockerDisk
    }
    return this.dockerDisk !== null && this.dockerDisk !== 'same' ? this.dockerDisk.freeMb : this.machine().diskFreeMb
  }

  /**
   * A disk smaller than a machine of its kind needs (REMOTE_DISK_MIN_GB: a
   * CPU kernel is a gigabyte, a GPU one four to thirteen, and the caches and
   * runs come on top): said to the owner as a `disk` problem, beside the
   * floor's own, for as long as it is so.
   *
   * The floor is the size a disk is rented or sold at, and a filesystem on it
   * shows a few percent less (partition table, ext4's journal and inodes): a
   * Vast VM rented with 150 GB showed 146 in df on 14 Oct 2026, so one rented
   * with `make vast-runner`'s default 120 would be told it is too small for
   * the very floor it was rented by. DISK_SLACK keeps that difference out.
   */
  private sizeProblem(): RemoteProblem[] {
    const total = this.machine().diskTotalMb
    const needGb = this.probe.cards.length > 0 ? REMOTE_DISK_MIN_GB.gpu : REMOTE_DISK_MIN_GB.cpu
    if (total === null || total >= needGb * 1024 * (1 - DISK_SLACK) || this.problems.has('disk')) return []
    return [{ code: 'disk', detail: remoteText(`the disk holds ${Math.round(total / 1024)} GB, less than the ${needGb} GB a machine ${this.probe.cards.length > 0 ? 'with cards' : 'without cards'} needs`, REMOTE_REASON_CHARS, 'start') }]
  }

  /** What leases hold: the manifests and sets eviction and a want must leave alone. */
  private inUse(): { manifests: Set<string>; bundles: Set<string> } {
    const manifests = new Set<string>()
    const bundles = new Set<string>()
    for (const held of this.held.values()) {
      manifests.add(held.lease.data)
      if (held.lease.sealedData) manifests.add(held.lease.sealedData)
      if (held.lease.bundle) bundles.add(held.lease.bundle.id)
    }
    return { manifests, bundles }
  }

  /**
   * Below the disk's floor: revisions not wanted for a day, then the caches'
   * least recently used, until it holds; a `disk` problem when nothing more
   * can go.
   *
   * Each by the disk it frees. On a host whose Docker store is a filesystem
   * of its own, revisions go while that disk is below the floor, measured
   * again after each (dockerDisk), and the caches while the tree's is: a
   * revision evicted for the tree's sake frees nothing there, and a full store
   * the tree's statfs never sees would fail every pull.
   */
  private async keepDiskFloor(): Promise<void> {
    if (this.evicting) return
    this.evicting = true
    try {
      const floor = this.floorMb()
      const freeMb = (): number | null => this.machine().diskFreeMb
      const separate = this.dockerDisk !== null && this.dockerDisk !== 'same'
      const free = freeMb()
      const store = separate ? (this.dockerDisk as DiskSpace).freeMb : free
      if ((free === null || free >= floor) && (store === null || store >= floor)) {
        this.setProblem('disk', null)
        return
      }
      const use = this.inUse()
      const wanted = this.cache.wantedNeeds()
      const keep: Keep = {
        manifests: new Set([...wanted.manifests, ...use.manifests]),
        bundles: new Set([...wanted.bundles, ...use.bundles]),
        blobs: new Set([
          ...wanted.blobs,
          ...this.cache.needsOf(use.manifests, use.bundles),
          ...[...this.held.values()].map((held) => held.lease.notebook.sha256),
        ]),
      }
      // What the runs and the class containers run on (or are to) is never evicted from under them.
      const running = new Set([...[...this.held.values()].map((held) => held.lease.revision.id), ...this.kernels.revisions().map((revision) => revision.id)])
      if (!separate) {
        await this.images.evict(running, freeMb, floor)
        const holds = this.cache.evict(keep, freeMb, floor)
        this.setProblem('disk', holds ? null : `free disk ${freeMb()} MB is below the ${floor} MB floor, and nothing more can be evicted`)
        return
      }
      if (store !== null && store < floor) await this.images.evict(running, () => this.pullFreeMb(true), floor)
      const treeHolds = this.cache.evict(keep, freeMb, floor)
      const after = await this.pullFreeMb(false)
      const storeHolds = after === null || after >= floor
      this.setProblem('disk', !treeHolds
        ? `free disk ${freeMb()} MB is below the ${floor} MB floor, and nothing more can be evicted`
        : !storeHolds
          ? `free disk ${after} MB on Docker's own disk (${this.probe.info?.rootDir ?? 'its store'}) is below the ${floor} MB floor, and no revision can be evicted`
          : null)
    } catch (error) {
      this.log(`[runner] eviction failed: ${String(error)}`)
    } finally {
      this.evicting = false
    }
  }

  /** Resolves when a reply describes the set (it does so for the sets of live leases first). */
  private described(bundleId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('the lease stopped waiting for its package set'))
      const waiters = this.describedWaiters.get(bundleId) ?? new Set()
      const done = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        waiters.delete(done)
        reject(new Error('home did not describe the package set in time'))
      }
      waiters.add(done)
      this.describedWaiters.set(bundleId, waiters)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** A class's file home (PUT rooms/:sessionId/files), as this machine, with its credential: none before a join or after the identity is gone. */
  private uploadRoomFile(upload: RoomUpload): Promise<RoomUploadAnswer> {
    const identity = this.identity
    if (!joined(identity) || retired(identity)) return Promise.resolve({ kind: 'transient', reason: 'this machine has no identity to send it with', retryAfterMs: null })
    return homeUploader({ home: identity.home, credential: () => remoteCredential(identity.runnerId, identity.secret), fetch: this.options.fetch })(upload)
  }

  /** A council's file home (PUT epochs/:sha256, PUT council/:sessionId/runs/:runId/files/:name), as this machine, as the class files go. */
  private uploadCouncilFile(put: CouncilPut): Promise<RoomUploadAnswer> {
    const identity = this.identity
    if (!joined(identity) || retired(identity)) return Promise.resolve({ kind: 'transient', reason: 'this machine has no identity to send it with', retryAfterMs: null })
    return councilUploader({ home: identity.home, credential: () => remoteCredential(identity.runnerId, identity.secret), fetch: this.options.fetch })(put)
  }

  /* --------------------------------------------------------- the tunnel */

  /**
   * Home's word on the class tunnel, from each reply (§4.6): `open` dials it
   * and keeps it up, `reconnect` dials again (it is down on home's side),
   * `closed` holds none. The tunnel's end is made once the first reply asks
   * for one, with this machine's credential; streams reach only the ports the
   * kernel host's records name (kernels.ts · resolve).
   */
  private tunnelWant(mode: RemoteKernelsReply['tunnel']): void {
    this.tunnelMode = mode
    if (this.tunnel) {
      this.tunnel.want(mode)
      return
    }
    if (mode === 'closed' || this.tunnelOpening || this.stopping) return
    const identity = this.identity
    if (!joined(identity)) return
    const factory = this.options.tunnel ?? agentTunnel
    this.tunnelOpening = (async () => {
      try {
        const tunnel = await factory({
          url: tunnelUrl(identity.home),
          authorization: `Bearer ${remoteCredential(identity.runnerId, identity.secret)}`,
          build: this.options.build,
          resolve: (key, gen) => this.kernels.resolve(key, gen),
          paceMBps: () => this.paceMBps,
          log: (event, detail) => {
            this.log(`[runner] class tunnel: ${event}${detail ? ` ${JSON.stringify(detail).slice(0, 300)}` : ''}`)
            this.watchTunnel()
          },
        })
        if (this.stopping || this.identity !== identity) {
          await tunnel.close()
          return
        }
        this.tunnel = tunnel
        tunnel.want(this.tunnelMode)
      } catch (error) {
        this.log(`[runner] the class tunnel could not be made: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.tunnelOpening = null
      }
    })()
  }

  /** The tunnel ends: a stop, a revocation, a leave, a new identity. */
  private async closeTunnel(): Promise<void> {
    this.tunnelMode = 'closed'
    await this.tunnelOpening
    const tunnel = this.tunnel
    this.tunnel = null
    this.tunnelUp = false
    if (tunnel) await tunnel.close().catch((error: unknown) => this.log(`[runner] the class tunnel did not close cleanly: ${String(error)}`))
  }

  /** The tunnel went up or down: home hears it in the next sync, which is sent now. */
  private watchTunnel(): void {
    const up = this.tunnel?.state().up ?? false
    if (up === this.tunnelUp) return
    this.tunnelUp = up
    if (this.kernelsHeard) this.poke(true)
  }

  /**
   * When home last said anything of its classes (the orphan rule, §7.6): a
   * reply that carried the block, or the tunnel, which home keeps alive with
   * a frame every few seconds while it is up.
   */
  private homeHeardAt(): number {
    const tunnel = this.tunnel?.state()
    return Math.max(this.kernelsHeardAt, tunnel ? (tunnel.up ? this.now() : tunnel.since) : 0)
  }

  /* -------------------------------------------------------------- helpers */

  /**
   * Something a sync reports has changed. The status is rewritten soon; a
   * change of what the machine has ready (or of its problems) also cuts the
   * held sync short, since home leases by it. `now` writes the status at once.
   */
  private changed(now = false): void {
    const signature = JSON.stringify([this.images.readyIds(), this.cache.readyData(), this.cache.readySealed(), this.cache.readyBundles(),
      [...this.problems.keys()], this.images.problemList().map((problem) => problem.code + (problem.revisionId ?? '')),
      this.cache.problemList().map((problem) => problem.code + (problem.manifest ?? problem.bundleId ?? ''))])
    if (signature !== this.readySignature) {
      this.readySignature = signature
      this.poke()
    }
    if (now) {
      this.writeStatus()
      return
    }
    if (this.statusSoon) return
    this.statusSoon = setTimeout(() => {
      this.statusSoon = null
      this.writeStatus()
    }, 500)
    this.statusSoon.unref?.()
  }

  /** Cut the held sync short, at most once a POKE_MIN_MS (`urgent` at once): the next one says what changed. */
  private poke(urgent = false): void {
    const sync = this.syncAbort
    if (!sync) return
    const age = this.now() - this.syncSentAt
    if (urgent || age >= POKE_MIN_MS) {
      sync.abort()
      return
    }
    if (this.pokeTimer) return
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null
      this.syncAbort?.abort()
    }, POKE_MIN_MS - age)
    this.pokeTimer.unref?.()
  }

  private writeStatus(): void {
    if (this.identity && joined(this.identity) && !retired(this.identity) && this.state !== 'stopped' && this.state !== 'refused') this.state = this.stopping ? this.state : this.wireState()
    const status = this.status()
    writeStatus(this.layout, status)
    this.emit('change', status)
  }

  private newBackoff(): Backoff {
    return new Backoff(this.options.random ?? Math.random, this.options.backoffMs?.min ?? REMOTE_BACKOFF_MIN_MS, this.options.backoffMs?.max ?? REMOTE_BACKOFF_MAX_MS)
  }

  /** A wait that a stop cuts short. */
  private sleep(ms: number): Promise<void> {
    return wait(ms, this.stopAbort.signal)
  }

  /** A folder that holds nothing, for an outcome assembled from our own failure. */
  private nowhere(): string {
    return path.join(this.layout.root, 'nowhere')
  }
}
