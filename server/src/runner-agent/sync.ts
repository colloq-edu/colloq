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
 * label that names this tree), uploads the outcomes it had written down, and
 * reports nothing else: home marks the rest lost at once instead of waiting
 * out the silence (§3.4 "Agent restart").
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
 * is leaving and is revoked by it. SIGTERM (docker stop -t 90, `runner update
 * --now`) hands back every run not yet finished as a `draining` decline,
 * which home requeues with no loss counted and no quota spent (§13 note 3),
 * removes its containers and exits. A 401 is the owner's revocation: the
 * hidden test is purged, Docker's restart policy for this container is turned
 * off (or unless-stopped would start a revoked machine forever) and the agent
 * exits — unless COLLOQ_RUNNER_JOIN carries a new code, in which case the dead
 * identity is put aside and the machine joins anew.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  REMOTE_BACKOFF_MAX_MS,
  REMOTE_BACKOFF_MIN_MS,
  REMOTE_DISK_MIN_GB,
  REMOTE_FETCHING_MAX,
  REMOTE_HOLD_BUSY_MS,
  REMOTE_HOLD_IDLE_MS,
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
  type RemoteFacts,
  type RemoteFree,
  type RemoteHeldAttempt,
  type RemoteLease,
  type RemoteProblem,
  type RemoteProgress,
  type RemoteRevokeReason,
  type RemoteRunnerState,
  type RemoteSyncReply,
  type RemoteSyncRequest,
} from '@shared/remote-runner'
import { DockerCompetitionRunner } from '../competitions/docker-runner.js'
import { competitionsDir, dropAttempt, removeSubmission, attemptPath } from '../competitions/storage.js'
import type { Capacity, RunOutcome } from '../competitions/runner-port.js'
import { Backoff, RemoteClient, type CallResult } from './client.js'
import { Cache, type Keep } from './cache.js'
import { realDocker, type Docker } from './docker.js'
import { brokenOutcome, NeighbourWindow, prepareRun, runPrepared, type Decline, type RunCard, type RunSeam } from './execute.js'
import { CHECK_LABEL, Images } from './images.js'
import {
  cardReport,
  dockerInfo,
  freeCapacity,
  machineFacts,
  pickCard,
  probeCards,
  readMachine,
  type MachinePicture,
  type ProbedCard,
} from './machine.js'
import {
  dropLease,
  joined,
  readIdentity,
  readLeases,
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
/** Attempts settled lately, whose repeats in a late reply are not taken for new offers. */
const SETTLED_KEEP = 512

export interface AgentOptions {
  layout: StateLayout
  /** COLLOQ_RUNNER_JOIN, parsed (remoteJoinTarget); null — none given. */
  join: { home: string; code: string } | null
  build: string
  version: string
  /** COLLOQ_RUNNER_CONTAINER: this agent's container, whose restart policy goes off when the machine is revoked or left. */
  container: string
  /** COLLOQ_RUNNER_IMAGE: the image the cards are probed with; null — the image of `container`, as docker says. */
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
  private compatible: boolean | null = null
  private perDevice = 1
  private homeVersion: string | null = null
  private probe: { info: Awaited<ReturnType<typeof dockerInfo>>['info']; cards: ProbedCard[]; driver: string | null } = { info: null, cards: [], driver: null }
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
      log: this.log,
      backoff: this.newBackoff(),
    })
    this.images = new Images({
      docker: this.docker,
      dir: path.join(this.layout.booksDir, 'revisions'),
      now: this.now,
      cards: () => ({ count: this.probe.cards.length, driver: this.probe.driver }),
      onChange: () => this.changed(),
      log: this.log,
    })
  }

  /* --------------------------------------------------------- lifecycle */

  /**
   * The agent's whole life: the sweep and the recovery of an earlier one, the
   * join, then syncs until it stops, leaves or is revoked.
   */
  async run(): Promise<AgentExit> {
    this.writeStatus()
    this.statusTimer = setInterval(() => this.writeStatus(), STATUS_EVERY_MS)
    this.statusTimer.unref?.()
    try {
      await this.sweep()
      this.recover()
      this.cache.load()
      await this.images.load()
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
    this.cache.purgeSealed('drain')
    this.changed(true)
    this.poke(true)
  }

  /** `runner leave`: drain, then tell home and be revoked by it. Resolves when it is done (or cannot be). */
  requestLeave(): Promise<'left' | 'revoked' | 'stopped'> {
    if (!this.leaving) {
      this.leaving = true
      this.log('[runner] leaving: the runs held finish, then this machine revokes itself')
      this.cache.purgeSealed('leave')
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
   * SIGTERM: everything not yet finished is handed back as a `draining`
   * decline, a finished run keeps uploading until the stop's time is up (its
   * outcome is written down: the next life sends it), the containers go.
   */
  stop(): Promise<void> {
    if (this.stopDone) return this.stopDone
    this.stopping = true
    this.log('[runner] stopping: the runs held go back to home\'s queue')
    this.stopAbort.abort()
    this.leaveDone.resolve('stopped')
    this.stopDone = (async () => {
      for (const held of this.held.values()) {
        if (held.stored || held.ended) continue
        held.handBack = true
        held.run.abort()
      }
      this.changed(true)
      const limit = this.options.stopMs ?? STOP_MS
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
      path: this.path,
      problem: this.problemLine,
      pid: process.pid,
      startedAt: this.started,
      updatedAt: this.now(),
      syncedAt: this.syncedAt,
    }
  }

  private finish(): void {
    for (const timer of [this.statusTimer, this.probeTimer, this.pokeTimer, this.statusSoon]) if (timer) clearTimeout(timer)
    this.statusTimer = this.probeTimer = this.pokeTimer = this.statusSoon = null
    this.images.stop()
    this.cache.stop()
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
    const found = await this.docker(['ps', '-aq', '--filter', `label=${CHECK_LABEL}`], { timeoutMs: 20_000 })
    const checks = found.code === 0 ? found.out.split('\n').map((line) => line.trim()).filter((line) => /^[a-f0-9]{12,64}$/.test(line)) : []
    if (checks.length > 0) await this.docker(['rm', '-f', ...checks], { timeoutMs: 60_000 })
    if (swept + checks.length > 0) this.log(`[runner] removed ${swept + checks.length} container(s) ${why}`)
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
   * The leases an earlier life wrote down: those whose outcome it wrote down
   * are uploaded again (and listed as uploading); the rest are dropped with
   * their trees and not reported, so home marks them lost at once. Attempt
   * trees no kept lease names go too.
   */
  private recover(): void {
    const stored = readLeases(this.layout)
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
      const kept = retireIdentity(this.layout, 'moved')
      this.log(`[runner] this machine belonged to ${identity.home}; that identity is put aside (${kept}) to join ${target.home}`)
      this.forgetHeld()
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
      const kept = retireIdentity(this.layout, why)
      this.log(`[runner] the ${why} identity is put aside (${kept}); joining ${target.home} with the new code`)
      this.forgetHeld()
      identity = null
    }
    if (!target) return { reason: 'refused', code: 78, detail: 'COLLOQ_RUNNER_JOIN is not set and this machine has not joined a home: -e COLLOQ_RUNNER_JOIN=\'https://<home>#<code>\'' }
    if (!identity || identity.codeSha256 !== code) {
      // Written down before the first try: a join whose reply is lost is the same join next time.
      identity = { home: target.home, joinId: randomBytes(16).toString('hex'), codeSha256: code! }
      writeIdentity(this.layout, identity)
    }
    return this.joinWith(identity, target.code)
  }

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
        writeIdentity(this.layout, done)
        this.log(`[runner] joined ${identity.home} as ${done.runnerId}${done.trusted ? ', trusted with the hidden test' : ''}`)
        this.syncedAt = this.now()
        return this.adopt(done)
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

  /** Revoked or left for good: Docker must not start this container again into a home that refuses it. */
  private async gone(why: 'left' | 'revoked', detail: string): Promise<AgentExit> {
    await this.noRestart()
    this.state = why
    this.problemLine = detail
    this.log(`[runner] ${detail}`)
    this.writeStatus()
    return { reason: why, code: 0, detail }
  }

  private async noRestart(): Promise<void> {
    const updated = await this.docker(['update', '--restart=no', this.options.container], { timeoutMs: 30_000 })
    if (updated.code !== 0) this.log(`[runner] could not turn off the restart policy of ${this.options.container} (not in that container?): ${updated.out.split('\n')[0] ?? ''}`)
  }

  /* ---------------------------------------------------------------- loop */

  private async loop(): Promise<AgentExit> {
    const backoff = this.newBackoff()
    for (;;) {
      if (this.stopping) return { reason: 'stopped', code: 0 }
      this.runnerHeld = await this.runner.capacity().catch(() => ({ heldMb: 0, heldGpus: {} }))
      this.expire()
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
        this.problemLine = answer.value.compatible ? null : 'this machine\'s build is not its home\'s: it finishes what it holds and takes nothing new (colloq-host runner update)'
        this.syncedAt = this.now()
        if (request.facts) this.factsSent = JSON.stringify(request.facts)
        this.handleReply(answer.value)
        if (request.state === 'leaving') return this.left()
        this.writeStatus()
        continue
      }
      // Cut short for news: ask again at once.
      if (abort.signal.aborted) continue
      if (answer.kind === 'refused') {
        if (answer.error === 'unauthorized') {
          const exit = await this.unauthorized(request.state === 'leaving')
          if (exit) return exit
          continue
        }
        this.path = 'refused'
        this.problemLine = `home refused the sync: ${answer.error}${answer.detail ? ` (${answer.detail})` : ''}`
        this.log(`[runner] ${this.problemLine}`)
        this.writeStatus()
        // Another protocol, or our own bug: no quick retry changes it.
        await this.sleep(backoff.next(this.options.backoffMs?.max ?? REMOTE_BACKOFF_MAX_MS))
        continue
      }
      await this.hiccup(answer, backoff)
    }
  }

  /** After a transient answer: what the relay says (on the first of a streak and every fifth), and a wait. */
  private async hiccup(answer: Extract<CallResult<never>, { kind: 'transient' }>, backoff: Backoff): Promise<void> {
    const before = this.path
    if (backoff.streak % 5 === 0) this.path = await this.client!.relayState(this.stopAbort.signal)
    if (this.path !== before || backoff.streak === 0) {
      const words: Record<string, string> = {
        home_offline: 'home is offline (its relay has no tunnel to it)',
        home_silent: 'home does not answer (its relay\'s tunnel is up)',
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
   */
  private async unauthorized(leaving: boolean): Promise<AgentExit | null> {
    if (leaving) return this.left()
    const identity = this.identity!
    await this.discardAll('the machine was revoked')
    this.cache.purgeSealed('revoked')
    const target = this.options.join
    if (target && target.home === identity.home && sha256(target.code) !== identity.codeSha256) {
      writeIdentity(this.layout, { ...identity, revokedAt: this.now() })
      const kept = retireIdentity(this.layout, 'revoked')
      this.log(`[runner] home revoked this machine; its identity is put aside (${kept}) and it joins again with the new code`)
      this.forgetHeld()
      const next: Identity = { home: target.home, joinId: randomBytes(16).toString('hex'), codeSha256: sha256(target.code) }
      writeIdentity(this.layout, next)
      const done = await this.joinWith(next, target.code)
      return 'reason' in done ? done : null
    }
    this.identity = { ...identity, revokedAt: this.now() }
    writeIdentity(this.layout, this.identity)
    return this.gone('revoked', 'home revoked this machine (its owner disconnected it); a new code joins it again')
  }

  /** The leaving sync was answered (or the machine was revoked by it): written down, said, and the process may go. */
  private async left(): Promise<AgentExit> {
    if (this.identity) {
      this.identity = { ...this.identity, leftAt: this.now() }
      writeIdentity(this.layout, this.identity)
    }
    const exit = await this.gone('left', 'this machine has left its home; a new code from the home\'s owner joins it again')
    this.leaveDone.resolve('left')
    // `runner leave` must hear it before the process, and its container with it, are gone.
    await Promise.race([this.leaveAck.promise, wait(LEAVE_ACK_MS)])
    return exit
  }

  /* ------------------------------------------------------------- the sync */

  /** The state a sync says: leaving only once nothing is held (a leave drains first). */
  private wireState(): RemoteRunnerState {
    if (this.leaving) return this.held.size === 0 ? 'leaving' : 'draining'
    return this.localDrain ? 'draining' : 'active'
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
    return {
      protocol: REMOTE_PROTOCOL,
      build: this.options.build,
      seq: this.seq,
      holdMs: attempts.length > 0 ? Math.min(hold.busy, REMOTE_HOLD_BUSY_MS) : Math.min(hold.idle, REMOTE_HOLD_IDLE_MS),
      state: this.wireState(),
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
      problems: [...this.problems.values(), ...this.sizeProblem(), ...this.images.problemList(), ...this.cache.problemList()].slice(0, REMOTE_PROBLEMS_MAX),
      ...(changedFacts ? { facts } : {}),
    }
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
    if (reply.trusted !== this.trusted && this.identity && joined(this.identity)) {
      this.identity = { ...this.identity, trusted: reply.trusted }
      writeIdentity(this.layout, this.identity)
      this.log(`[runner] home ${reply.trusted ? 'trusts this machine with the hidden test now' : 'no longer trusts this machine with the hidden test'}`)
    }
    this.trusted = reply.trusted
    if (!reply.trusted && this.cache.holdsSealed()) this.cache.purgeSealed('untrusted')
    // A machine on its way out is drained by home as well (its leaving sync's reply): nothing to say about that.
    if (reply.drain && !this.homeDrain) {
      if (!this.leaving) this.log('[runner] home drains this machine: the runs held finish, nothing new is taken')
      this.cache.purgeSealed('drain')
    }
    if (!reply.drain && this.homeDrain) this.log('[runner] home takes this machine back into work')
    this.homeDrain = reply.drain
    for (const revoke of reply.revoke) this.revoke(revoke.id, revoke.reason)
    for (const id of reply.applied) this.applied(id)
    this.cache.forget(reply.forget)
    this.images.want(reply.want.revisions)
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
   */
  private acceptLeases(leases: readonly RemoteLease[], replySeq: number): void {
    let passed = false
    for (const lease of leases) {
      if (this.held.has(lease.attemptId) || this.settled.has(lease.attemptId)) continue
      if (!this.takesWork()) {
        passed = true
        continue
      }
      const receivedAt = this.now()
      writeLease(this.layout, { lease, receivedAt })
      this.seq = Math.max(this.seq, lease.seq)
      const held = this.fresh(lease, receivedAt)
      this.held.set(lease.attemptId, held)
      held.task = this.attempt(held)
      this.log(`[runner] took ${lease.attemptId.slice(0, 8)} (submission ${lease.submissionId}${lease.gpu ? ', a card' : ''}${lease.sealed ? ', hidden test' : ''})`)
    }
    if (passed) this.seq = Math.max(this.seq, replySeq)
    this.changed(true)
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
      writeOutcome(this.layout, lease.attemptId, stored)
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

  /** Declined before any container (or handed back): written down, then posted like an outcome. */
  private async decline(held: Held, decline: Decline): Promise<void> {
    held.holds = false
    const stored: StoredOutcome = { kind: 'declined', reason: decline.reason, detail: remoteText(decline.detail, REMOTE_REASON_CHARS, 'start'), startedAt: held.startedAt }
    writeOutcome(this.layout, held.lease.attemptId, stored)
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
      free: () => this.free(),
      signal: held.send.signal,
      onReply: (reply) => this.acceptLeases(reply.leases, reply.seq),
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
    this.settled.add(lease.attemptId)
    if (this.settled.size > SETTLED_KEEP) this.settled.delete(this.settled.values().next().value!)
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

  /** What the attempts hold: from their lease until their container is gone. */
  private holding(): Array<{ memoryMb: number; cpus: number }> {
    return [...this.held.values()].filter((held) => held.holds && !held.ended).map((held) => ({ memoryMb: held.lease.limits.memoryMb, cpus: held.lease.limits.cpus }))
  }

  private cardRuns(): Array<{ device: string; perDevice: number }> {
    return [...this.held.values()].filter((held) => held.holds && held.card).map((held) => ({ device: held.card!.device, perDevice: held.card!.perDevice }))
  }

  private cardsNow(): ReturnType<typeof cardReport> {
    return cardReport(this.probe.cards, this.perDevice, this.cardRuns(), this.runnerHeld.heldGpus ?? {})
  }

  /** The share an attempt takes, picked and held in one breath (execute.ts · PrepareInput.claimCard). */
  private claimCard(held: Held, perDevice: number): string | null {
    const device = pickCard(this.probe.cards, perDevice, this.cardRuns(), this.runnerHeld.heldGpus ?? {})
    if (device !== null) held.card = { device, sliceMb: null, perDevice }
    return device
  }

  private free(): RemoteFree {
    return freeCapacity({
      picture: this.machine(),
      holding: this.holding(),
      heldMb: this.runnerHeld.heldMb ?? 0,
      attempts: this.held.size,
      gpuShares: this.cardsNow().freeShares,
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
      const image = this.options.image ?? (await this.ownImage())
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

  /** The image this container runs, when COLLOQ_RUNNER_IMAGE did not say: what `--gpus all` probes the cards with. */
  private async ownImage(): Promise<string | null> {
    const asked = await this.docker(['inspect', '-f', '{{.Config.Image}}', this.options.container], { timeoutMs: 20_000 })
    const image = asked.code === 0 ? asked.out.trim().split('\n')[0]?.trim() ?? '' : ''
    return image || null
  }

  private setProblem(code: 'docker' | 'cards' | 'disk', detail: string | null): void {
    if (detail === null) this.problems.delete(code)
    else this.problems.set(code, { code, detail: remoteText(detail, REMOTE_REASON_CHARS, 'start') })
  }

  /**
   * A disk smaller than a machine of its kind needs (REMOTE_DISK_MIN_GB: a
   * CPU kernel is a gigabyte, a GPU one four to thirteen, and the caches and
   * runs come on top): said to the owner as a `disk` problem, beside the
   * floor's own, for as long as it is so.
   */
  private sizeProblem(): RemoteProblem[] {
    const total = this.machine().diskTotalMb
    const needGb = this.probe.cards.length > 0 ? REMOTE_DISK_MIN_GB.gpu : REMOTE_DISK_MIN_GB.cpu
    if (total === null || total >= needGb * 1024 || this.problems.has('disk')) return []
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
   */
  private async keepDiskFloor(): Promise<void> {
    if (this.evicting) return
    this.evicting = true
    try {
      const floor = this.options.diskFloorMb ?? DISK_FLOOR_MB
      const freeMb = (): number | null => this.machine().diskFreeMb
      const free = freeMb()
      if (free === null || free >= floor) {
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
      await this.images.evict(new Set([...this.held.values()].map((held) => held.lease.revision.id)), freeMb, floor)
      const holds = this.cache.evict(keep, freeMb, floor)
      this.setProblem('disk', holds ? null : `free disk ${freeMb()} MB is below the ${floor} MB floor, and nothing more can be evicted`)
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
