/**
 * One lease, prepared and run: the machine's half of a notebook step
 * (docs/architecture/remote-runners.md §2 steps 4–5, §5.5).
 *
 * THE RUN IS HOME'S OWN. The container is started, watched, exported and
 * judged by DockerCompetitionRunner.run() (competitions/docker-runner.ts),
 * unchanged, with a RunRequest built field for field the way home builds its
 * own (runner.ts · runNotebookThenScore): the lease's container name, attempt
 * id and limits; the pinned image under its colloq-revision tag; the package
 * set's room; the card's share. The paths are this machine's tree, laid out as
 * home lays out its DATA_DIR (competitions/storage.ts), so runArgs, hostPathOf
 * and the harness find what they always do, and the argv is home's but for
 * the folders' names (tests/runner-agent-argv.test.mts holds the two equal).
 * `--pull=never` is in that argv: a missing image fails at once, never a pull
 * under the launch's 120 s.
 *
 * DECLINED BEFORE ANY CONTAINER, WITH THE REASON (§3.4 "Decline"): the image,
 * the data, the hidden test or the notebook not here; the wheels not to be
 * had; the disk or memory not there; no share of a card left; a harness this
 * build does not carry. Home refunds the attempt and skips this machine for
 * the submission a while. After the container started there is no decline
 * but `draining` (sync.ts): what a run came to is an outcome, even our own
 * failure (`harness_error`, which blames nobody).
 *
 * THE NEIGHBOUR WINDOW IS THE MACHINE'S (§5.5). A run that died of torch's
 * out-of-memory on a shared card while the watchdog stopped a neighbour on
 * the same card for going past its share was crowded out, not wrong, and home
 * gives it back to the queue once. Home sees neither the card nor the
 * neighbour, so the machine keeps the stops per card and says `crowded`
 * itself, by home's own rule: runner.ts · neighbourVerdict and the two
 * windows, copied here because this bundle may not load the queue, and held
 * equal to them by tests/runner-agent-execute.test.mts.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  REMOTE_PREPARE_MS,
  REMOTE_REASON_CHARS,
  remoteText,
  type RemoteDeclineReason,
  type RemoteLease,
} from '@shared/remote-runner'
import { attemptDir } from '../competitions/storage.js'
import { HARNESS_REVISION } from '../competitions/harness.js'
import { gpuSliceFor } from '../competitions/gpu-math.js'
import type { Capacity, CompetitionRunner, RunOutcome, RunProgress, RunRequest } from '../competitions/runner-port.js'
import { CacheError, type Cache } from './cache.js'
import type { Images } from './images.js'
import { diskFits, memoryFits, type Holding, type MachinePicture, type ProbedCard } from './machine.js'

/** What of a CompetitionRunner the agent uses: DockerCompetitionRunner, or a test's stand-in. */
export type RunSeam = Pick<CompetitionRunner, 'run' | 'sweep'> & { capacity(): Promise<Capacity> }

/** The card a run was given, and its share (RunRequest.gpu). */
export type RunCard = NonNullable<RunRequest['gpu']>

export interface Decline {
  reason: RemoteDeclineReason
  /** For the owner, at most REMOTE_REASON_CHARS: what was missing, in the machine's words. */
  detail: string
}

/** A lease ready to run: its request, without the signal and the progress callback the attempt adds. */
export interface PreparedRun {
  request: Omit<RunRequest, 'signal' | 'onProgress'>
  card: RunCard | null
}

export interface PrepareInput {
  lease: RemoteLease
  /** When the machine wrote the lease down: preparation must end within REMOTE_PREPARE_MS of it. */
  receivedAt: number
  cache: Cache
  images: Pick<Images, 'verify'>
  /** The machine's numbers now, and what its attempts hold with this one among them. */
  picture: MachinePicture
  holding: readonly Holding[]
  heldMb: number
  attempts: number
  trusted: boolean
  cards: readonly ProbedCard[]
  /**
   * Pick and hold a card share for this attempt at the lease's runs per card,
   * synchronously (the pick and the hold must not have an await between them,
   * or two leases prepared at once could take the last share twice); `null` —
   * none left.
   */
  claimCard: (perDevice: number) => string | null
  /** Resolves when home has described a package set this lease needs (the next sync, sets of live leases first). */
  described: (bundleId: string, signal: AbortSignal) => Promise<void>
  signal: AbortSignal
  now?: () => number
}

export type Prepared = { ok: true; run: PreparedRun } | { ok: false; decline: Decline }

const decline = (reason: RemoteDeclineReason, detail: string): Prepared => ({ ok: false, decline: { reason, detail: remoteText(detail, REMOTE_REASON_CHARS, 'start') } })

/**
 * Everything a lease needs, from this machine's own cache, or the reason it
 * cannot run here — in the order that fails cheapest first, and with the card
 * last, after the slow parts (a card held while wheels download is a share a
 * neighbour could have had).
 */
export async function prepareRun(input: PrepareInput): Promise<Prepared> {
  const { lease, cache } = input
  const now = input.now ?? Date.now
  if (lease.harness !== HARNESS_REVISION) {
    return decline('version', `this machine's build carries harness ${HARNESS_REVISION}, the lease names ${lease.harness}`)
  }
  const image = await input.images.verify(lease.revision)
  if (image === null) return decline('image', `the revision ${lease.revision.id.slice(0, 12)} is not ready here`)
  if (!diskFits(input.picture, input.attempts)) return decline('disk', `free disk ${input.picture.diskFreeMb} MB is below what ${input.attempts} attempt(s) need`)
  if (!memoryFits(input.picture, input.holding, input.heldMb, { memoryMb: lease.limits.memoryMb, cpus: lease.limits.cpus })) {
    return decline('memory', `${lease.limits.memoryMb} MB does not fit: MemAvailable ${input.picture.memAvailableMb ?? 'unknown'} MB`)
  }

  // Preparation has its own part of the lease's ceiling (REMOTE_PREPARE_MS); waits end with it.
  const deadline = new AbortController()
  const left = Math.max(1_000, input.receivedAt + REMOTE_PREPARE_MS - 30_000 - now())
  const timer = setTimeout(() => deadline.abort(new Error('preparation ran out of its time')), left)
  timer.unref?.()
  const signal = AbortSignal.any([input.signal, deadline.signal])
  try {
    let dataDir: string
    try {
      if (!cache.complete(lease.data)) return decline('data', `the data ${lease.data.slice(0, 12)} is not complete here`)
      if (lease.sealed) {
        if (!input.trusted) return decline('data', 'this machine is not trusted with the hidden test')
        if (!lease.sealedData || !cache.complete(lease.sealedData)) return decline('data', `the hidden test ${(lease.sealedData ?? '').slice(0, 12)} is not complete here`)
        dataDir = cache.composeSealed(lease)
      } else {
        dataDir = cache.dataDir(lease.data)
      }
    } catch (error) {
      return decline('data', `the data could not be laid out: ${message(error)}`)
    }

    let inputDir: string
    try {
      inputDir = await cache.placeNotebook(lease, signal)
    } catch (error) {
      return decline('data', `the notebook could not be had: ${message(error)}`)
    }

    let dependenciesDir: string | undefined
    if (lease.bundle) {
      try {
        let dir = await cache.bundle(lease.bundle.id, signal)
        while (dir === null) {
          await input.described(lease.bundle.id, signal)
          dir = await cache.bundle(lease.bundle.id, signal)
        }
        dependenciesDir = dir
      } catch (error) {
        return decline('wheels', `the package set ${lease.bundle.id.slice(0, 12)} could not be had: ${message(error)}`)
      }
    }

    let card: RunCard | null = null
    if (lease.gpu) {
      const perDevice = lease.perDevice ?? 1
      const device = input.claimCard(perDevice)
      if (device === null) return decline('card', `no share of a card is free at ${perDevice} per card`)
      const sliceMb = await gpuSliceFor(device, {
        perDevice,
        cards: async (devices) => devices.map((id) => ({ memoryMb: input.cards.find((found) => found.device === id)?.memoryMb ?? null })),
      })
      card = { device, sliceMb, perDevice }
    }

    letRead(dataDir)
    letRead(inputDir)
    return {
      ok: true,
      run: {
        card,
        request: {
          attemptId: lease.attemptId,
          imageDigest: image,
          dependenciesDir,
          // The set's own room, sized at home for it (runner-port.ts · RunRequest.packagesMb); only with a set.
          packagesMb: dependenciesDir && lease.bundle ? lease.bundle.packagesMb : undefined,
          // A run reads the competition's id and, without an image, its environment; the image is always given here.
          competition: { id: lease.competitionId, environment: '' },
          submissionId: lease.submissionId,
          container: lease.container,
          dataDir,
          ...(lease.sealed ? { sealedInputs: true } : {}),
          inputDir,
          resultDir: attemptDir(lease.competitionId, lease.submissionId, lease.attemptId, 'result'),
          limits: lease.limits,
          ...(card ? { gpu: card } : {}),
        },
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

/** The run itself, by the runner's own code. */
export function runPrepared(seam: RunSeam, prepared: PreparedRun, signal: AbortSignal, onProgress: (progress: RunProgress) => void): Promise<RunOutcome> {
  return seam.run({ ...prepared.request, signal, onProgress })
}

/**
 * Our own failure as a run's outcome: the run started and then the machinery
 * here broke (an export that could not be written, a runner that threw). It
 * blames nobody, as a harness error at home does, and costs the participant
 * nothing a failed attempt would.
 */
export function brokenOutcome(error: unknown, wall: number): RunOutcome {
  return {
    status: 'harness_error', cell: -1, cells: 0, wall, submission: null, detail: '',
    log: `The machine that ran this submission failed around it: ${message(error)}`,
    diagnostics: { exit: null, oomKilled: false, backend: 'docker' },
  }
}

/* ------------------------------------------------- the neighbour window */

/** runner.ts · NEIGHBOUR_WINDOW_MS: how close a neighbour's stop and a run's out-of-memory must be. */
export const NEIGHBOUR_WINDOW_MS = 20_000
/** runner.ts · UNREAD_NEIGHBOUR_WINDOW_MS: the same after the stop of a neighbour whose card could not be read. */
export const UNREAD_NEIGHBOUR_WINDOW_MS = NEIGHBOUR_WINDOW_MS + 15_000

export interface NeighbourStop {
  at: number
  windowMs: number
}

/** runner.ts · neighbourStop. */
export function neighbourStop(at: number, by: 'gpu' | 'gpu-unread'): NeighbourStop {
  return { at, windowMs: by === 'gpu-unread' ? UNREAD_NEIGHBOUR_WINDOW_MS : NEIGHBOUR_WINDOW_MS }
}

/** runner.ts · neighbourVerdict, word for word. */
export function neighbourVerdict(
  stops: readonly NeighbourStop[],
  run: { startedAt: number; endedAt: number },
  now: number,
  stays: boolean,
): 'crowded' | 'wait' | 'own' {
  const since = Math.max(run.startedAt, run.endedAt - NEIGHBOUR_WINDOW_MS)
  if (stops.some((stop) => stop.at >= since && stop.at <= run.endedAt + stop.windowMs)) return 'crowded'
  return stays && now - run.endedAt < UNREAD_NEIGHBOUR_WINDOW_MS ? 'wait' : 'own'
}

/**
 * Whether a failed cell's traceback names torch's out-of-memory: what home's
 * neighbour retry looks for (runner.ts · errorTypeOf === 'OutOfMemoryError').
 * Read the way errorTypeOf reads it, from the end, a dotted name by its last
 * part; wider than it on purpose — any such line counts — since this decides
 * only whether to wait for a neighbour's stop, and waiting for nothing costs
 * a few seconds where not waiting could bill a participant for a neighbour.
 */
export function diedOfCardMemory(detail: string): boolean {
  for (const line of String(detail ?? '').trimEnd().split('\n').reverse()) {
    const found = /^([A-Za-z_][A-Za-z0-9_.]{0,99})(?::\s|:$|$)/.exec(line.trim())
    if (found && found[1]!.split('.').pop() === 'OutOfMemoryError') return true
  }
  return false
}

/** The stops of runs on this machine's cards, per card; only the recent ones are kept. */
export class NeighbourWindow {
  private readonly stops = new Map<string, NeighbourStop[]>()

  note(device: string, at: number, by: 'gpu' | 'gpu-unread'): void {
    const recent = (this.stops.get(device) ?? []).filter((stop) => at - stop.at <= 3 * UNREAD_NEIGHBOUR_WINDOW_MS)
    recent.push(neighbourStop(at, by))
    this.stops.set(device, recent)
  }

  /**
   * Whether this run was crowded out on its shared card (the header). A run
   * stopped from outside for its card is noted first, so a neighbour still on
   * the card can learn of it; a run that died of torch's out-of-memory waits,
   * while another run stays on the card and its stop could still land in the
   * window, as home waits for its own (runner.ts · neighbourOverran).
   */
  async crowded(input: {
    outcome: RunOutcome
    card: RunCard | null
    startedAt: number
    endedAt: number
    /** Whether another run is still on the card. */
    stays: () => boolean
    signal: AbortSignal
    now?: () => number
  }): Promise<boolean> {
    const { outcome, card } = input
    const now = input.now ?? Date.now
    const stoppedBy = outcome.diagnostics.killedBy
    if (card?.device && (stoppedBy === 'gpu' || stoppedBy === 'gpu-unread')) this.note(card.device, input.endedAt, stoppedBy)
    if (!card?.device || !(card.perDevice > 1)) return false
    if (outcome.status !== 'cell_error' || stoppedBy === 'output' || !diedOfCardMemory(outcome.detail)) return false
    for (;;) {
      const verdict = neighbourVerdict(this.stops.get(card.device) ?? [], { startedAt: input.startedAt, endedAt: input.endedAt }, now(), input.stays())
      if (verdict !== 'wait') return verdict === 'crowded'
      if (input.signal.aborted) return false
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }
}

/* -------------------------------------------------------------- helpers */

/**
 * Let the container read what is mounted for it: runner.ts · letContainerRead,
 * the same modes and only where they differ (a chmod moves ctime). On a
 * machine the agent and the run are both uid 1000, so this is the developer's
 * runner-dev's (another uid on the host) more than the fleet's.
 */
export function letRead(dir: string): void {
  try {
    const own = fs.statSync(dir)
    if ((own.mode & 0o7777) !== 0o755) fs.chmodSync(dir, 0o755)
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      const entry = fs.statSync(file)
      if (entry.isDirectory()) letRead(file)
      else if ((entry.mode & 0o7777) !== 0o644) fs.chmodSync(file, 0o644)
    }
  } catch {
    // Docker says a permission refusal out loud; failing the run over this would be unfair.
  }
}

function message(error: unknown): string {
  if (error instanceof CacheError) return error.message
  return error instanceof Error ? error.message : String(error)
}
