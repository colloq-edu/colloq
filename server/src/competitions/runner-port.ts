/**
 * The runner contract — everything the queue knows about executing a
 * submission.
 *
 * Narrow on purpose. The queue (runner.ts) must not know a single word about
 * docker: it decides whose work goes next, what to write into the submission
 * row and when to kill the container, while "how exactly to execute the
 * notebook" comes in three kinds behind this door. The local runner
 * (docker-runner.ts) starts two disposable containers, the production broker
 * starts a Pod; the stand-in (fake-runner.ts) does not execute a single line
 * of someone else's code and is not there for the tests' own sake: the test
 * stand and the whole suite live without docker, and a competition without a
 * runner is a page where no button can be pressed.
 *
 * THE SHAPE OF THE ANSWER IS ONE FOR ALL, otherwise the swap proves nothing: a
 * test that is green on the stand-in and fails on the real one is not a test
 * but decoration.
 *
 * And the main reason there are two separate fields here instead of one:
 * `message` for the participant and `teacherOnly` for the teacher are kept
 * apart AT THE TYPE LEVEL. They cannot be mixed up even when you badly want to
 * show the person more — and you always do, because the metric's traceback
 * holds the answer to their question. Along with the answer it holds lines of
 * someone else's solution.csv.
 */
import { metricMemoryMb, type Competition, type RunVerdict } from '@shared/competitions'

/** Which path executes a submission. Read from the environment, like KERNEL_BACKEND. */
export type CompetitionBackend = 'docker' | 'broker' | 'test'

/**
 * The limits of ONE trip into a container — already in the numbers docker
 * speaks.
 *
 * A competition stores its own (`CompetitionLimits`), but there are two steps,
 * and the metric's limits are different: it does not need four gigabytes and
 * ten minutes, but it must not write anything except one json. So these are
 * not "the competition's limits" but the step's limits — computed by
 * `limitsFor` below, and computed in one place.
 */
export interface StepLimits {
  /**
   * The step's overall time limit. Once it is up, the container is killed from
   * outside, no negotiation.
   */
  wallSeconds: number
  memoryMb: number
  cpus: number
  /** Process cap: 256 for a submission, 64 for the metric. */
  pids: number
  /** The cap on ONE file, in bytes — hard, by the kernel (SIGXFSZ). */
  fsizeBytes: number
  /** How much memory to give /tmp and the working folder. Counted in `memoryMb`. */
  tmpfsMb: number
  /** The cap on the answer the harness takes out of the container. */
  targetBytes: number
  /** Soft print cap: outputs beyond it are counted but not accumulated. */
  outputBytes: number
  /** Hard print cap: beyond it the container is killed from outside. */
  outputKillBytes: number
}

/**
 * The competition as a runner sees it: exactly the fields `run` reads, and
 * nothing else of the row.
 *
 * The runners read so little of it: its id (the broker's job, the paths it
 * checks, the stand-in's sample) and its environment (the image when a request
 * names none). Everything else a run needs comes in the request itself, as
 * paths, limits and an image. Narrowed on purpose, and picked field by field
 * (runCompetition), not cast: the request is what a machine that runs
 * submissions for this server will be handed as a small JSON, and a whole
 * Competition would hand it the metric code, the seed that splits the answer
 * key into public and private rows, and the teacher's texts along with it.
 */
export type RunCompetition = Pick<Competition, 'id' | 'environment'>

/**
 * The same for `score`, which also reads how the answer key's rows split
 * (`publicPercent`, `splitSeed`). The metric runs where the answers are, on
 * this server, so these two never travel with a notebook.
 */
export type ScoreCompetition = Pick<Competition, 'id' | 'environment' | 'publicPercent' | 'splitSeed'>

/** What of a competition a notebook run carries (RunRequest.competition). */
export function runCompetition(competition: RunCompetition): RunCompetition {
  return { id: competition.id, environment: competition.environment }
}

/** What of a competition a metric run carries (ScoreRequest.competition). */
export function scoreCompetition(competition: ScoreCompetition): ScoreCompetition {
  return {
    id: competition.id,
    environment: competition.environment,
    publicPercent: competition.publicPercent,
    splitSeed: competition.splitSeed,
  }
}

/** How far a running notebook has got — what "cell 9 of 14" is made of. */
export interface RunProgress {
  phase?: 'dependencies' | 'notebook'
  cell: number
  cells: number
  outputBytes: number
}

/** An order to run a notebook. Paths are directories already laid out (storage.ts). */
export interface RunRequest {
  attemptId?: string
  signal?: AbortSignal
  /** Immutable base binding; absent only for legacy callers. */
  imageDigest?: string
  /** Published bundle directory: requirements.lock and wheels/. */
  dependenciesDir?: string
  /**
   * The room the set is installed into, in MiB: memory-backed storage of its
   * own, sized for the set (`packagesRoomMb` in @shared/dependencies) and
   * counted in the submission's memory like every tmpfs of it. Absent, the
   * set shares the working folder's room, as it did when a 300 MB set failed
   * inside pip for the 256 MB that folder gets at 2 GB.
   */
  packagesMb?: number
  /** The fields of the competition a run reads (RunCompetition), not the whole row. */
  competition: RunCompetition
  submissionId: string
  /**
   * The container name; it is also what the container is killed by. Given from
   * outside, before the start.
   */
  container: string
  /**
   * The open half of the data. `:ro`, and only it. With a hidden test, this
   * run's own composed folder instead (storage.ts · composeRunInputs).
   */
  dataDir: string
  /**
   * `dataDir` is the attempt's composed folder with the hidden test in it. The
   * broker gets this as a typed flag and mounts that folder itself; Docker
   * simply mounts `dataDir`. Absent: the competition's open `data/`.
   */
  sealedInputs?: boolean
  /**
   * A directory with one notebook. A directory, not a file — see the header of
   * storage.ts.
   */
  inputDir: string
  /** Host-only destination for bounded artifacts exported from the attempt. */
  resultDir: string
  limits: StepLimits
  /**
   * The runner card this attempt holds, given by the queue when it took the
   * job (competitions/gpu.ts · pickRunnerGpu); absent — the notebook runs on
   * the CPU, exactly as before cards existed.
   *
   * `device` is the `KERNEL_GPUS` entry as docker names it; inside the
   * container the card is index 0. `sliceMb` — the video memory this run is
   * promised (the card's memory over `perDevice`), `null` when the card did
   * not say its size: then nothing is capped and nothing is watched, because
   * a limit nobody can state is not one to enforce. `perDevice` — how many
   * runs share the card; with one the run has the whole card and needs no
   * cap at all. Only the notebook step ever gets this: the metric step holds
   * the hidden answers.
   *
   * Under Kubernetes the queue holds no card (competition_queue.gpu stays
   * NULL): the cluster schedules the Pod onto a unit of its own GPU resource,
   * and a node without one sends the job back as a `gpu` resource deferral.
   * A GPU notebook there carries `CLUSTER_GPU` below — an empty device, "the
   * cluster picks", no share of ours and nothing to watch — and the broker
   * runner reads only that the field is there (`gpu: true` in its intent).
   */
  gpu?: { device: string; sliceMb: number | null; perDevice: number }
  /** Called as the run goes; the queue puts this into the submission row. */
  onProgress?: (progress: RunProgress) => void
}

/**
 * A GPU notebook under Kubernetes (RunRequest.gpu): no device of ours, no
 * share we could state, and so no cap and no watchdog — the cluster's device
 * plugin decides what a unit of its GPU resource is.
 */
export const CLUSTER_GPU: Readonly<NonNullable<RunRequest['gpu']>> = Object.freeze({ device: '', sliceMb: null, perDevice: 1 })

/** What became of the notebook. The same on both runners. */
export interface RunOutcome {
  /** The harness's word, untranslated and unembellished (`RunVerdict`). */
  status: RunVerdict
  /** Which cell it ended on and how many there were; `-1` means it did not start. */
  cell: number
  cells: number
  /** How long the step ran, in milliseconds. */
  wall: number
  /** Path to the collected answer; `null` means the submission did not write it. */
  submission: string | null
  /**
   * Text the participant reads verbatim.
   *
   * For a failed cell this is their own traceback: they wrote it, and hiding
   * it from them means answering "error in the notebook" to the question
   * "which one".
   */
  detail: string
  /** Exit code, OOM, the tail of the container log — for the teacher only. */
  log: string
  /** Why the package set did not install, when that is known (`dependency_error` only). */
  dependencyFailure?: DependencyFailure
  diagnostics: RunDiagnostics
}

/**
 * A package set's failure that has a cause other than "try again".
 *
 * `no_space` — its environment ran out of room during the install, and
 * `roomBytes` is how much it had. `memory` — the set cannot ride with this
 * submission at all: its room (`bytes`) is more than a set may take of the
 * submission's memory (`limitBytes`), found before any container started.
 */
export type DependencyFailure =
  | { reason: 'no_space'; roomBytes: number }
  | { reason: 'memory'; bytes: number; limitBytes: number }

export interface RunDiagnostics {
  exit: number | null
  oomKilled: boolean
  backend: CompetitionBackend
  /**
   * Who cut the container off from outside: time limit, printing, disk
   * writes, video memory past the run's share of a card (`gpu`: two
   * samples in a row above the share plus its tolerance, competitions/gpu.ts ·
   * GPU_TOLERANCE_MB), or a shared card that could not be read at all
   * (`gpu-unread`: docker-runner.ts · VRAM_UNREAD_LIMIT samples in a row
   * failed, and the run was stopped rather than left unwatched).
   */
  killedBy?: 'wall' | 'output' | 'disk' | 'gpu' | 'gpu-unread'
  /** Memory peak read by the harness from inside — it shows "right at the limit". */
  peakBytes?: number | null
  /**
   * The most video memory the run's container was seen holding, MB, for the
   * teacher; `null` — no sample answered; absent — a run nobody watched: no
   * card, a whole card (nothing to enforce), or a share of unknown size.
   */
  gpuPeakMb?: number | null
  /**
   * The last samples that answered, MB, oldest first, at most four — for a
   * run killed for its card, the two that decided it (docker-runner.ts ·
   * gpuOverShare). Absent, like the peak, for a run nobody watched.
   */
  gpuSamplesMb?: number[]
}

/** An order to compute the metric. The participant is not in this container. */
export interface ScoreRequest {
  attemptId?: string
  signal?: AbortSignal
  /** The scorer's pinned base, without participant packages. */
  imageDigest?: string
  /** The fields of the competition the metric reads (ScoreCompetition), not the whole row. */
  competition: ScoreCompetition
  submissionId: string
  container: string
  /** The closed half: solution.csv and the metric code. Only here, and only `:ro`. */
  secretDir: string
  /**
   * A directory with one copy of the answer. Neither the participant's notebook
   * nor its output.
   */
  submissionDir: string
  /** Where the metric writes its single json. */
  outDir: string
  limits: StepLimits
}

/** What the metric said. */
export interface ScoreOutcome {
  status: RunVerdict
  public: number | null
  private: number | null
  /** ParticipantVisibleError — the participant reads this verbatim. */
  message: string | null
  /** The traceback and everything else — for the teacher only. */
  teacherOnly: string | null
  wall: number
  diagnostics: RunDiagnostics
}

/**
 * How much memory on the machine can still be handed out; `null` means we
 * honestly do not know.
 *
 * `availableMb` is what resources.ts hands out, and the dependency
 * preparation reserves against it. The queue reads the finer numbers when a
 * runner has them (competitions/capacity.ts explains why there are two):
 * without `usableMb` it falls back on `availableMb`, without
 * `memAvailableMb` it skips the floor.
 */
export interface Capacity {
  availableMb: number | null
  /** What competition work may promise in total: the machine minus its reserve minus live room kernels. */
  usableMb?: number | null
  /** The kernel's MemAvailable, raw — nothing subtracted from it. */
  memAvailableMb?: number | null
  /** Memory still held by containers whose removal failed and is being retried. */
  heldMb?: number
  /**
   * Runner cards still held the same way, card → containers: a notebook
   * container that outlived its attempt keeps its share of the card until it
   * is gone, and the queue counts it as a run on that card (store.ts ·
   * takeNext). Absent — none, or a runner without cards of its own.
   */
  heldGpus?: Record<string, number>
}

export interface CompetitionRunner {
  readonly backend: CompetitionBackend
  run(request: RunRequest): Promise<RunOutcome>
  score(request: ScoreRequest): Promise<ScoreOutcome>
  /** Kill a running container by name. Silently if it is already gone. */
  kill(container: string): Promise<void>
  /** Clean up everything left over from the process's previous life. */
  sweep(legacyContainers?: readonly string[]): Promise<number>
  capacity(): Promise<Capacity>
}

let injected: CompetitionRunner | null = null
let chosen: CompetitionRunner | null = null

/**
 * Swap out the runner — for tests.
 *
 * The same trick, and for the same reason, as `useDockerForLimits` in pool.ts:
 * a test that needs an OOM on the third cell should say so directly rather
 * than bend real docker to it. The injection outranks the default; `null`
 * restores things as they were.
 */
export function useCompetitionRunner(fake: CompetitionRunner | null): void {
  injected = fake
}

/** Forget the chosen runner — after a test changes COMPETITION_BACKEND. */
export function forgetCompetitionRunner(): void {
  chosen = null
}

/**
 * Which path submissions take.
 *
 * An explicit COMPETITION_BACKEND is for tests and local development. Without
 * it the server picks the same private broker as rooms do; in production
 * Docker is not allowed for submissions. The test default stays the stand-in.
 */
export function competitionBackend(env: NodeJS.ProcessEnv = process.env): CompetitionBackend {
  const asked = (env.COMPETITION_BACKEND ?? '').trim()
  if (asked) {
    if (asked !== 'docker' && asked !== 'broker' && asked !== 'test') {
      throw new Error(`Unknown competition backend: ${asked}`)
    }
    if (asked === 'test' && env.NODE_ENV !== 'test') {
      throw new Error('The test competition backend requires NODE_ENV=test')
    }
    if (asked === 'docker' && env.NODE_ENV === 'production') {
      throw new Error('Production competition execution requires the private runtime broker')
    }
    return asked
  }
  return env.NODE_ENV === 'test' ? 'test' : env.NODE_ENV === 'production' || env.KERNEL_BACKEND === 'broker' || env.KERNEL_RUNTIME_URL ? 'broker' : 'docker'
}

/**
 * This process's runner.
 *
 * The imports are lazy: the stand-in has no reason to drag along the docker
 * argument assembly, nor the real one the notebook directive parsing. But the
 * main reason they are lazy is module load order: `runner.ts` loads with the
 * server, while the choice of path depends on the environment, which a test
 * edits before the call.
 */
export function competitionRunner(): CompetitionRunner {
  if (injected) return injected
  if (chosen) return chosen
  const backend=competitionBackend()
  chosen = backend === 'docker' ? dockerRunner() : backend === 'broker' ? brokerRunner() : fakeRunner()
  return chosen
}

/* Break the import cycle: both runners import their types from here. */
let dockerFactory: (() => CompetitionRunner) | null = null
let fakeFactory: (() => CompetitionRunner) | null = null
let brokerFactory: (() => CompetitionRunner) | null = null

/** Register oneself — called from the runners themselves when the module loads. */
export function registerCompetitionRunner(
  kind: CompetitionBackend,
  factory: () => CompetitionRunner,
): void {
  if (kind === 'docker') dockerFactory = factory
  else if (kind === 'broker') brokerFactory = factory
  else fakeFactory = factory
}

function dockerRunner(): CompetitionRunner {
  if (!dockerFactory) throw new Error('The Docker competition runner is not registered')
  return dockerFactory()
}

function fakeRunner(): CompetitionRunner {
  if (!fakeFactory) throw new Error('The test competition runner is not registered')
  return fakeFactory()
}
function brokerRunner(): CompetitionRunner {
  if (!brokerFactory) throw new Error('The broker competition runner is not registered')
  return brokerFactory()
}

/* ---------------------------------------------------------------- numbers */

/**
 * How many seconds to put up with the metric.
 *
 * A metric over twenty thousand rows is computed in a fraction of a second; a
 * hundred and twenty seconds is not headroom for big data but the deadline
 * after which the teacher's hung code stops occupying the executor of the
 * whole instance. Its own number rather than the competition's time limit:
 * ten minutes for a participant's notebook are reasonable, ten minutes for
 * `score()` do not happen.
 */
export const METRIC_WALL_SECONDS = 120

/** Memory for the metric: shared/competitions.ts · METRIC_MEMORY_MB (re-exported for the server's imports). */
export { METRIC_MEMORY_MB } from '@shared/competitions'

/** The metric writes one json; it needs nothing more. */
export const METRIC_FSIZE_BYTES = 1024 * 1024

/**
 * Step limits — from the competition's limits.
 *
 * One place for both runners and both steps. The numbers are not round but
 * derived from the step's memory: `/out` and `/tmp` count toward `--memory`,
 * and giving them half would mean taking it away from training. An eighth is
 * what the prototype stood on (512 MB out of four gigabytes), with a floor of
 * 128 MB, below which no reasonable answer will fit.
 */
export function limitsFor(competition: Competition, step: 'notebook' | 'metric'): StepLimits {
  const { limits } = competition
  if (step === 'metric') {
    return {
      wallSeconds: METRIC_WALL_SECONDS,
      memoryMb: metricMemoryMb(limits.memoryMb),
      cpus: limits.cpus,
      pids: 64,
      fsizeBytes: METRIC_FSIZE_BYTES,
      tmpfsMb: 128,
      targetBytes: METRIC_FSIZE_BYTES,
      outputBytes: 0,
      outputKillBytes: 0,
    }
  }
  const tmpfsMb = Math.max(128, Math.min(2048, Math.floor(limits.memoryMb / 8)))
  return {
    wallSeconds: limits.wallSeconds,
    memoryMb: limits.memoryMb,
    cpus: limits.cpus,
    pids: 256,
    /*
     * Four times the answer cap: `--ulimit fsize` guards not the answer (the
     * harness guards that) but whoever writes straight into a mounted host
     * directory. It cannot be set tight — a participant may have legitimate
     * temporary files bigger than the answer.
     */
    fsizeBytes: TARGET_BYTES * 4,
    tmpfsMb,
    targetBytes: TARGET_BYTES,
    outputBytes: SOFT_OUTPUT_BYTES,
    outputKillBytes: HARD_OUTPUT_BYTES,
  }
}

/**
 * The answer cap — the same one the product declares (`LIMITS.submissionBytes`).
 *
 * Deliberately not imported from here as an environment constant: the number
 * must be one and the same in three places — in the harness check inside the
 * container, in `--ulimit` outside and in the caption on the competition page.
 */
const TARGET_BYTES = 64 * 1024 * 1024

/**
 * Two print caps, and both are needed.
 *
 * The soft one (in the harness) keeps outputs from accumulating in memory:
 * without it a notebook printing gigabytes dies of OOM, and in the log that
 * looks like running out of memory during training. But printing burns CPU
 * even past it — the prototype measured thirty-three seconds on eight
 * gigabytes. The hard one (outside, by the beacon) cuts that off in two.
 */
const SOFT_OUTPUT_BYTES = 2_000_000
const HARD_OUTPUT_BYTES = 64 * 1024 * 1024
