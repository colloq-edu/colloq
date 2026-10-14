/**
 * The real runner: two disposable containers per submission.
 *
 * The kinship with rooms is intentional. `runArgs()` below is the `runArgs()`
 * of kernel/pool.ts with everything that makes a container live taken away
 * (the room name, the published port, the class volume, GPU, the Jupyter
 * token), and with what makes it disposable added: the network removed
 * entirely, a read-only root, a cap on file size. `hardeningArgs()` is
 * `roomHardeningArgs()` from kernel/perimeter.ts word for word, with one
 * change: a lower process cap.
 *
 * DIFFERENCES FROM A ROOM, each one bought by the prototype's experience, not
 * by reasoning.
 *
 * 1. `--network none` instead of the room network. A room needs pip and
 *    datasets, a submission does not, and a network ban is cheaper and more
 *    reliable than iptables rules. The price is stated to the participant on
 *    the competition page: packages that are not in the image cannot be had
 *    from anywhere, and `pip install` without a network fails after fifteen
 *    seconds, spent from the participant's own time limit.
 *
 * 2. `--read-only`. A room cannot do that — it lives for whole class periods
 *    and installs packages with `%pip install` into its own layer (perimeter.ts
 *    says so outright). A submission lives for a minute and must write only to
 *    `/out` and `/tmp`.
 *
 * 3. `/out` is a tmpfs with a hard cap, not a host folder. The container's
 *    disk is not limited by anything, and that is the main hole of the first
 *    step: a ten-line notebook writes a terabyte. tmpfs solves it in the
 *    kernel — a write over the cap gives ENOSPC right in the cell, and not a
 *    single byte reaches the host disk. The price is honest and stated: tmpfs
 *    counts toward the submission's `--memory`.
 * 4. `/result` is bounded tmpfs. A fixed supervisor keeps it mounted after
 *    notebook completion; the host exports only regular allowlisted files with
 *    per-file byte limits, then removes the container. No writable host mount.
 *
 * 5. `--ulimit fsize` also bounds each individual file inside tmpfs.
 *
 * 6. A participant's package set is installed at the start of the run into a
 *    tmpfs of its own, `/packages`, sized for that set (runner-port.ts ·
 *    RunRequest.packagesMb) — a room the read-only root cannot give and a
 *    host folder must not. It counts toward `--memory` like every tmpfs, and
 *    the participant is told so; a set that could not fit is refused when it
 *    is chosen. The per-file cap grows to that room: one library of a ready
 *    set weighs more than four answers (catboost's `_catboost.so` alone is
 *    264 MB), and every file still sits in a capped tmpfs.
 *
 * 7. No `--rm`. The container is needed dead for another ten milliseconds or
 *    so — to read `State.OOMKilled`. On a DISPOSABLE container this flag is
 *    honest, unlike in a room, where it sticks forever and postmortem.ts has
 *    to count kills with a cgroup counter: the container lives once.
 *
 * 8. A video card comes back only for a notebook the queue gave one
 *    (RunRequest.gpu, competitions/gpu.ts), with what a room gets for it:
 *    `--gpus device=`, a /dev/shm big enough for DataLoader workers (docker's
 *    64 MB kills them with a bus error; it counts toward `--memory`), and the
 *    `colloq.gpu` label, by which a class is kept off the card while the run
 *    holds it (kernel/pool.ts · submissionGpuCards). Every hardening flag
 *    stays: the card was tried under `--read-only`, `--cap-drop=ALL`, uid
 *    1000 and `--network none` on the lab VM. A card shared by several runs
 *    has each held to its share twice: torch's allocator and CatBoost's GPU
 *    pool are capped from inside (harness.ts · SITECUSTOMIZE), and the
 *    container is watched from outside (VramWatch), because the inside is
 *    the participant's own. The watch is not theirs either: it samples as
 *    root, whom their uid cannot signal, and it fails closed — a run on a
 *    shared card that cannot be read is stopped, not left unwatched.
 *
 * And one rule, bought at a higher price than any other: we mount ONLY
 * directories, and only at paths that did not exist before this submission
 * (see the header of storage.ts).
 *
 * TWO KINDS OF PROCESS LOAD THIS MODULE: this server, and the agent of a
 * machine that runs its submissions (docs/architecture/remote-runners.md,
 * «машины для посылок»), which calls DockerCompetitionRunner.run() exactly as
 * the queue here does, so that the argv, the harness, the export and the
 * verdicts are home's by construction. So this module, and everything it
 * imports, loads no database, no room pool, no settings and no .env, and does
 * nothing when it loads but register the runner
 * (tests/runner-import-graph.test.mts keeps it so). What only this server
 * knows — how much memory the machine can still give, which depends on its
 * rooms — is handed in (DockerRunnerOptions), never reached for.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform, type TransformCallback, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tr } from '@shared/i18n'
import { dataDir } from '../data-dir.js'
import { competitionsFs, hostPathOf, EXECUTED_BYTES, EXECUTED_FILE } from './storage.js'
import { HARNESS_SITE, harnessDir } from './harness.js'
import { gpuAllocatorMb, gpuKillAboveMb } from './gpu-math.js'
import {
  METRIC_WALL_SECONDS,
  registerCompetitionRunner,
  type Capacity,
  type CompetitionRunner,
  type RunDiagnostics,
  type RunOutcome,
  type RunProgress,
  type RunRequest,
  type ScoreOutcome,
  type ScoreRequest,
  type StepLimits,
} from './runner-port.js'
import type { RunVerdict } from '@shared/competitions'

/** Label on both containers: cleanup finds them by it, and only them. */
export const RUN_LABEL = 'colloq.kind=competition-run'
export const SCORE_LABEL = 'colloq.kind=competition-score'
const HOST_DATA_ROOT = path.resolve(hostPathOf(dataDir))
const INSTANCE_KEY = 'ru.colloq.competition-instance'
const INSTANCE_SCOPE = createHash('sha256').update(HOST_DATA_ROOT).digest('hex').slice(0, 16)
const INSTANCE_LABEL = `${INSTANCE_KEY}=${INSTANCE_SCOPE}`

/** The image is the one the class runs in: one environment for task and solution. */
const IMAGE_PREFIX = 'colloq-kernel'

/**
 * How often to look at a running container: whether it is alive and whether
 * its time is up. The wall limit is enforced to within this, which is why the
 * sleep also ends exactly at the deadline.
 */
const POLL_MS = 1000

/**
 * How often to look INSIDE it: progress, printed output, completion.
 *
 * Every look inside is a `docker exec` and a python start that the
 * submission pays for out of its own CPU quota. Four a second (the
 * prototype's quarter second) across eight slots is thirty-two of them a
 * second spent on watching; the price of three seconds is up to that long
 * between a notebook's end and the host noticing it. Latency only, never a
 * verdict: the deadline takes one more look before it kills (watch).
 */
const STATUS_EVERY_MS = 3000

/** Backoff before each retry of a docker call that failed without saying why. */
const RETRY_DELAYS_MS = [250, 750, 2000]

/** The cushion a container costs above its `--memory` — the same one as runner.ts · RUN_RESERVE_MB. */
const CONTAINER_CUSHION_MB = 256

/**
 * How long the salvage before a kill may take: one bounded `docker exec`
 * for the executed notebook while the container still runs past its limit.
 */
const SALVAGE_MS = 10_000

/** Names of the files the harness puts into `/result`. */
const RUN_FILE = 'run.json'
const SCORE_FILE = 'score.json'

interface Shell {
  /**
   * `sink` takes stdout as a stream instead of the answer string: an export
   * of up to 64 MB goes through it without becoming one string on the event
   * loop. stderr still comes back in `out`.
   */
  (args: string[], timeoutMs?: number, maxOutputBytes?: number, sink?: Writable): Promise<{ code: number; out: string }>
}

/**
 * Call docker.
 *
 * Our own copy rather than `dockerRead` from pool.ts, for exactly one reason:
 * that one has a short read deadline, while here we get `docker run` of a
 * heavy image. The form is the same — spawn with an array, no shell, no
 * quoting.
 */
const shell: Shell = (args, timeoutMs = 60_000, maxOutputBytes = 256 * 1024, sink) =>
  new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    let bytes = 0, overflow = false
    const within = (chunk: Buffer): boolean => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) { overflow = true; child.kill('SIGKILL'); return false }
      return true
    }
    if (sink) {
      // Back-pressure: a slow disk pauses docker rather than filling memory.
      let broken = false
      sink.once('error', () => { broken = true; child.kill('SIGKILL') })
      sink.on('drain', () => child.stdout.resume())
      child.stdout.on('data', (chunk: Buffer) => {
        if (broken || !within(chunk)) return
        if (!sink.write(chunk)) child.stdout.pause()
      })
      child.stdout.on('end', () => { if (!broken) sink.end() })
    } else {
      child.stdout.on('data', (chunk: Buffer) => { if (within(chunk)) out += chunk.toString() })
    }
    child.stderr.on('data', (chunk: Buffer) => { if (within(chunk)) out += chunk.toString() })
    child.on('error', (err) => {
      clearTimeout(kill)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code: overflow ? -1 : code ?? -1, out: overflow ? 'Docker response exceeded its output limit' : out.trim() })
    })
  })

let docker: Shell = shell

/** The daemon said the container does not exist — an answer, not a hiccup. */
const missing = (out: string): boolean => /No such (?:container|object)/i.test(out)

/**
 * A docker call retried while it fails without saying why.
 *
 * A daemon under load can fail one `inspect` without a reason; before the
 * retries that single failure read as "the container is gone" and turned a
 * finished notebook into "no submission". `settled` tells a real answer
 * (including "no such container") from a hiccup.
 */
async function retried(
  call: () => Promise<{ code: number; out: string }>,
  settled: (result: { code: number; out: string }) => boolean,
): Promise<{ code: number; out: string }> {
  let result = await call()
  for (const delay of RETRY_DELAYS_MS) {
    if (settled(result)) break
    await sleep(delay)
    result = await call()
  }
  return result
}

/**
 * What a container still holds while its removal is pending: memory, and the
 * runner card it was given (`null` — none).
 */
interface Held {
  memoryMb: number
  gpu: string | null
}

/**
 * Containers whose removal failed: name → what they may still hold.
 *
 * A failed `docker rm` after a finished run is the daemon's trouble, not the
 * submission's: the verdict stands, the removal is retried later, and until
 * it succeeds only THAT container's memory stays out of the queue's reach.
 * It used to close the whole queue. Its card too: a notebook that may still
 * be on the card holds its share, and the next GPU run goes to it only after
 * the container is gone (capacity · heldGpus).
 */
const pendingCleanup = new Map<string, Held>()
let cleanupTimer: NodeJS.Timeout | null = null
const CLEANUP_RETRY_MS = 30_000
let cleanupFailures = 0
let unverifiedLegacyContainers = 0
export function competitionDockerDiagnostics() { return { cleanupFailures, pendingCleanup: pendingCleanup.size, unverifiedLegacyContainers } }

/** Remove a container; `false` means it is left for the retry, holding what `held` says. Never throws. */
async function removeContainer(container: string, held: Partial<Held> = {}, patient = true): Promise<boolean> {
  const removal = () => docker(['rm', '-f', container], 60_000)
  const gone = (result: { code: number; out: string }) => result.code === 0 || missing(result.out)
  const result = patient ? await retried(removal, gone) : await removal()
  if (gone(result)) {
    pendingCleanup.delete(container)
    return true
  }
  if (!pendingCleanup.has(container)) {
    cleanupFailures = Math.min(Number.MAX_SAFE_INTEGER, cleanupFailures + 1)
    console.warn('[competitions] container removal failed; retrying later', container)
  }
  const before = pendingCleanup.get(container)
  pendingCleanup.set(container, {
    memoryMb: Math.max(before?.memoryMb ?? 0, held.memoryMb ?? 0),
    gpu: held.gpu || before?.gpu || null,
  })
  scheduleCleanup()
  return false
}

/** The retry in flight, if any: one at a time, whether the pump or the timer asks. */
let retrying: Promise<void> | null = null

/** One more try for every container still awaiting removal; the next pump or timer is the backoff. */
function retryPendingCleanup(): Promise<void> {
  retrying ??= (async () => {
    for (const [container, held] of [...pendingCleanup]) await removeContainer(container, held, false)
  })().finally(() => { retrying = null })
  return retrying
}

function scheduleCleanup(): void {
  if (cleanupTimer || pendingCleanup.size === 0) return
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null
    void retryPendingCleanup().finally(scheduleCleanup)
  }, CLEANUP_RETRY_MS)
  // The retry must not keep the process alive: it goes away with it.
  cleanupTimer.unref?.()
}

/**
 * Swap out docker — for the tests of arguments and of the post-mortem.
 *
 * The same trick as `useDockerForLimits` (pool.ts) and `useDockerForPostmortem`:
 * the suite has no real docker, and what needs checking is exactly what only
 * happens with it. This swaps the CALL, not the whole runner: a test of how
 * the command is assembled must not depend on whether the machine has the
 * image.
 */
export function useDockerForCompetitions(fake: Shell | null): void {
  docker = fake ?? shell
}

/* ------------------------------------------------------- argument assembly */

/**
 * The hardened profile — `roomHardeningArgs` word for word, with one change.
 *
 * 256 processes instead of the room's 512: a submission hosts one python and
 * its threads, not Jupyter with a terminal and `DataLoader(num_workers=8)` all
 * at once. A fork bomb hits the wall twice as early, and `DataLoader` does not
 * notice (prototype measurement: 88 children, 829 MB peak, the container
 * survived).
 */
function hardeningArgs(pids: number): string[] {
  return [
    '--label', INSTANCE_LABEL,
    // Raw stdout/stderr can bypass the notebook's IOPub counter. Keep daemon
    // log files bounded too: two rotated 8 MiB files per execution container.
    '--log-driver=local',
    '--log-opt=max-size=8m',
    '--log-opt=max-file=2',
    '--user=1000:1000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--pids-limit=${pids}`,
    '--sysctl=net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl=net.ipv6.conf.default.disable_ipv6=1',
  ]
}

/**
 * How many threads to allow numeric libraries.
 *
 * The same rule as in pool.ts · threadLimit, and for the same reason:
 * `os.cpu_count()` inside a container shows the HOST's cores, and numpy will
 * spin up thirty threads on the two cores it was given.
 */
function threads(cpus: number): string {
  return String(Math.max(1, Math.floor(Number.isFinite(cpus) && cpus > 0 ? cpus : 2)))
}

/**
 * Every thread pool a notebook is likely to meet, capped at the step's CPUs.
 *
 * BLAS and OpenMP were capped from the start; polars (rayon underneath),
 * BLIS, Apple's vecLib and numba each read their own variable, and each one
 * forgotten is a pool of host-core-count threads on two CPUs — with eight
 * slots side by side, the queue's throughput goes to context switches.
 * LOKY_MAX_CPU_COUNT is joblib's: `n_jobs=-1` asks it for the CPU count,
 * and a notebook in the rehearsal saw os.cpu_count() = 76 on a 2-CPU quota.
 */
function threadEnv(cpus: number): string[] {
  const t = threads(cpus)
  return ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS',
    'POLARS_MAX_THREADS', 'RAYON_NUM_THREADS', 'BLIS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'NUMBA_NUM_THREADS', 'LOKY_MAX_CPU_COUNT']
    .flatMap((name) => ['-e', `${name}=${t}`])
}

/**
 * Every `-v` goes through `hostPathOf` — mandatory, with no exceptions.
 *
 * Under `make run` this is the identity. Under `make up` the server itself is
 * in a container, and the path at which it sees a file is unknown to the
 * docker daemon: the daemon creates an empty directory at that path on the
 * fly, and the submission SILENTLY sees neither the data nor its notebook — no
 * error, no line in the log.
 */
function mount(inside: string, at: string, readOnly = false): string[] {
  return ['-v', `${hostPathOf(inside)}:${at}${readOnly ? ':ro' : ''}`]
}

/**
 * The video memory a run is held to on its card, MB, or `null` — nothing to
 * hold: no card, a whole card to itself (`perDevice` 1, nobody to disturb),
 * or a card that did not say its size (a limit nobody can state is not one
 * to enforce). Both halves of the share key off this one answer: the cap
 * inside (runArgs) and the watchdog outside (VramWatch).
 */
export function heldShareMb(gpu: RunRequest['gpu']): number | null {
  if (!gpu?.device || gpu.sliceMb === null || !(gpu.perDevice > 1)) return null
  return gpu.sliceMb
}

/**
 * /dev/shm for a run with a card, MB: half its memory, at most a gigabyte —
 * what a room gets by default (KERNEL_SHM). It is memory-backed and counted
 * in `--memory`, so a bigger one is only a bigger way to die of memory.
 */
function shmMb(memoryMb: number): number {
  return Math.min(1024, Math.floor(memoryMb / 2))
}

/**
 * PYTHONPATH from its entries, in order; nothing at all without any.
 *
 * The one variable both the runner and the image could want: the kernel
 * images set none (kernel/Dockerfile), so the entries here are the whole of
 * it, and a second one the runner adds later goes into this list rather than
 * into a second `-e` that would replace the first.
 */
function pythonPath(entries: readonly string[]): string[] {
  return entries.length > 0 ? ['-e', `PYTHONPATH=${entries.join(':')}`] : []
}

/**
 * `docker run` arguments for the NOTEBOOK container.
 *
 * A separate pure function, because the tests have no real docker, and
 * assembling this line correctly matters more than calling it: a lost
 * `--network none` here is a submission with internet access, and it can only
 * be noticed when someone makes use of it.
 *
 * Without `gpu` the line is exactly what it was before cards existed.
 */
export function runArgs(opts: {
  attemptId?: string
  container: string
  image: string
  dataDir: string
  inputDir: string
  resultDir: string
  dependenciesDir?: string
  /** The set's own room, MiB (RunRequest.packagesMb); only together with `dependenciesDir`. */
  packagesMb?: number
  limits: StepLimits
  target: string
  /** The card the queue gave this run (RunRequest.gpu); an empty device is none of ours. */
  gpu?: RunRequest['gpu']
}): string[] {
  const { container, limits } = opts
  const memory = `${limits.memoryMb}m`
  const packagesMb = opts.dependenciesDir && opts.packagesMb ? Math.max(1, Math.ceil(opts.packagesMb)) : 0
  // No file of the set is bigger than its room, and every file lives in a capped tmpfs.
  const fsize = Math.max(limits.fsizeBytes, packagesMb * 1024 ** 2)
  const device = opts.gpu?.device || null
  const share = heldShareMb(opts.gpu)
  return [
    'run',
    '-d',
    // The image is the revision the submission was pinned to, and it is here
    // or the run is not ours to start: a missing image fails the launch at once
    // with docker's "No such image", never a pull under the launch's 120 s
    // that fetches whatever a registry holds under that name today.
    '--pull=never',
    '--name',
    container,
    // No network at all: no DNS, no loopback, no bridge. A competition is
    // learning on the data provided, not a trip outside for the answers.
    '--network',
    'none',
    ...hardeningArgs(limits.pids),
    '--read-only',
    `--tmpfs=/tmp:rw,nosuid,nodev,size=${limits.tmpfsMb}m,mode=1777`,
    // The notebook's working folder is a tmpfs with a hard cap: not a single
    // byte of the host disk in it.
    `--tmpfs=/out:rw,exec,nosuid,nodev,size=${limits.tmpfsMb}m,mode=1777`,
    // HOME is inside the tmpfs, and the harness creates the folders in it:
    // `--tmpfs` creates only the mount point, and IPython, not finding HOME,
    // prints a warning into EVERY submission.
    '-e',
    'HOME=/tmp/home',
    '-e',
    'JUPYTER_RUNTIME_DIR=/tmp/home/runtime',
    '-e',
    'JUPYTER_DATA_DIR=/tmp/home/data',
    '-e',
    'MPLCONFIGDIR=/tmp/home/mpl',
    '-e',
    'MPLBACKEND=Agg',
    ...threadEnv(limits.cpus),
    '-e',
    'PYTHONUNBUFFERED=1',
    '-e',
    'PYTHONDONTWRITEBYTECODE=1',
    '-e',
    `COMP_TARGET=${opts.target}`,
    '-e',
    `COMP_MAX_OUTPUT_BYTES=${limits.outputBytes}`,
    '-e',
    `COMP_MAX_TARGET_BYTES=${limits.targetBytes}`,
    /*
     * The cap on ONE cell — for the sake of a clear message, not a guarantee.
     * The prototype showed it to be sturdier than expected (it fires on `while
     * True`, on SVD in C, and on a cell that ignores SIGINT), but it knows
     * nothing about the OVERALL time limit: a notebook of fifty cells at three
     * seconds each goes straight past it. So it equals the overall limit, and
     * the real killer is outside.
     */
    '-e',
    `COMP_CELL_TIMEOUT_SEC=${limits.wallSeconds}`,
    // The supervisor's own deadline (harness.ts · HOLD_EXPORT): the container
    // stops by itself if the host that should kill it is gone.
    '-e',
    `COMP_WALL_SECONDS=${limits.wallSeconds}`,
    // The open half of the data. solution.csv never appears here — it lies in
    // the closed directory, which is not mounted into this container.
    ...mount(opts.dataDir, '/data', true),
    // A directory, not a file: one notebook inside and nothing else.
    ...mount(opts.inputDir, '/submission', true),
    ...mount(harnessDir(), '/harness', true),
    // Hard aggregate export bound. The host copies only validated named files.
    `--tmpfs=/result:rw,nosuid,nodev,size=${Math.max(1, Math.ceil(limits.targetBytes * 2 / 1024 ** 2))}m,mode=1777`,
    '-e', `COMP_ATTEMPT_ID=${opts.attemptId ?? opts.container}`,
    '-e', `COMP_MAX_OUTPUT_KILL_BYTES=${limits.outputKillBytes}`,
    /*
     * A share of a card: torch's allocator is capped a little below it (the
     * CUDA context lives outside the allocator, competitions/gpu-math.ts ·
     * gpuAllocatorMb) by the harness's sitecustomize, which Python finds on
     * PYTHONPATH in every process of the container, the kernel included.
     * CatBoost's GPU pool is a fraction of the card rather than a size, so
     * the same sitecustomize also needs the card the share was cut from: the
     * share times the runs on the card, within a few megabytes of what
     * nvidia-smi said (gpuSliceMb rounds down).
     */
    ...(share !== null
      ? ['-e', `COLLOQ_GPU_MEMORY_MB=${gpuAllocatorMb(share)}`, '-e', `COLLOQ_GPU_CARD_MB=${share * (opts.gpu?.perDevice ?? 1)}`]
      : []),
    ...pythonPath(share !== null ? [HARNESS_SITE] : []),
    ...(opts.dependenciesDir ? [...mount(opts.dependenciesDir, '/deps', true), '-e', 'COMP_DEPENDENCIES=/deps'] : []),
    /*
     * The set's environment: `exec`, because its libraries are mapped as code;
     * sized for the set, because the working folder's eighth of the memory is
     * the participant's, and a ready set of three hundred megabytes never fit
     * into it (ENOSPC inside pip, four submissions in a row).
     */
    ...(packagesMb
      ? [`--tmpfs=/packages:rw,exec,nosuid,nodev,size=${packagesMb}m,mode=1777`, '-e', 'COMP_PACKAGES=/packages']
      : []),
    `--memory=${memory}`,
    // Swap exactly equal to memory — otherwise a container that hits the limit
    // does not die but goes to disk and stalls for minutes (the same reason as
    // in pool.ts).
    `--memory-swap=${memory}`,
    `--cpus=${limits.cpus}`,
    // The card by its KERNEL_GPUS name; inside the container it is device 0.
    ...(device ? ['--gpus', `device=${device}`, `--shm-size=${shmMb(limits.memoryMb)}m`] : []),
    `--ulimit=fsize=${fsize}:${fsize}`,
    '--restart=no',
    '--label',
    RUN_LABEL,
    // The label rooms carry too: by it a new class is kept off the card while this run holds it.
    ...(device ? ['--label', `colloq.gpu=${device}`] : []),
    '-w',
    '/out',
    '--entrypoint',
    'python',
    opts.image,
    '/harness/hold_export.py',
    '/result',
    '/harness/run_notebook.py',
  ]
}

/**
 * `docker run` arguments for the METRIC container.
 *
 * The participant is not in it: only their one file arrives, read-only. The
 * open data and the executed notebook do not get here — the teacher's code
 * runs next to the answers, and anything put there may leak into the text of
 * its error.
 *
 * Never a card, whatever the notebook had, and there is no way to ask for
 * one here: a container that holds the hidden answers shares a card with
 * nobody, and a metric over one CSV has no use for it.
 */
export function scoreArgs(opts: {
  attemptId?: string
  container: string
  image: string
  secretDir: string
  submissionDir: string
  outDir: string
  limits: StepLimits
  solutionFile: string
  metricFile: string
  idColumn: string
  publicPercent: number
  splitSeed: string
}): string[] {
  const { container, limits } = opts
  const memory = `${limits.memoryMb}m`
  return [
    'run',
    '-d',
    // Never a pull, as for the notebook (runArgs): the metric runs in the image
    // the submission was pinned to, beside the answers, or not at all.
    '--pull=never',
    '--name',
    container,
    '--network',
    'none',
    ...hardeningArgs(limits.pids),
    '--read-only',
    `--tmpfs=/tmp:rw,nosuid,nodev,size=${limits.tmpfsMb}m,mode=1777`,
    '-e',
    'HOME=/tmp/home',
    '-e',
    'MPLCONFIGDIR=/tmp/home/mpl',
    ...threadEnv(limits.cpus),
    '-e',
    'PYTHONUNBUFFERED=1',
    '-e',
    'PYTHONDONTWRITEBYTECODE=1',
    '-e',
    `COMP_SOLUTION=/secret/${opts.solutionFile}`,
    '-e',
    `COMP_METRIC=/secret/${opts.metricFile}`,
    '-e',
    `COMP_ID_COLUMN=${opts.idColumn}`,
    '-e',
    `COMP_PUBLIC_PERCENT=${opts.publicPercent}`,
    '-e',
    `COMP_SPLIT_SEED=${opts.splitSeed}`,
    // The closed half of the competition and one file of the participant.
    // Neither of them has been or will be visible to the notebook container.
    ...mount(opts.secretDir, '/secret', true),
    ...mount(opts.submissionDir, '/submission', true),
    ...mount(harnessDir(), '/harness', true),
    '--tmpfs=/out:rw,nosuid,nodev,size=4m,mode=1777',
    '-e', `COMP_ATTEMPT_ID=${opts.attemptId ?? opts.container}`,
    '-e', `COMP_WALL_SECONDS=${limits.wallSeconds}`,
    `--memory=${memory}`,
    `--memory-swap=${memory}`,
    `--cpus=${limits.cpus}`,
    `--ulimit=fsize=${limits.fsizeBytes}:${limits.fsizeBytes}`,
    '--restart=no',
    '--label',
    SCORE_LABEL,
    '-w',
    '/out',
    '--entrypoint',
    'python',
    opts.image,
    '/harness/hold_export.py',
    '/out',
    '/harness/score_metric.py',
  ]
}

/* ---------------------------------------------------------------- watchdog */

/** What the watchdog over a running container returned. */
interface Watched {
  killedBy: 'wall' | 'output' | 'disk' | 'gpu' | 'gpu-unread' | null
  progress: RunProgress | null
  exit?: number
}

/* ------------------------------------------------- a share of a card, outside */

/**
 * How long one sample of a card may take. nvidia-smi answers in a tenth of a
 * second; one that has not answered in five is stuck — in the driver, or
 * starved of the processor by the container it runs in (VramWatch).
 */
const VRAM_SAMPLE_MS = 5_000

/**
 * How long past VRAM_SAMPLE_MS a sample is waited for before it counts as
 * failed anyway. The shell kills the docker client at VRAM_SAMPLE_MS and
 * answers when it exits; this is for the day that exit never comes, so that
 * no client, however stuck, holds the next sample off for the rest of a run.
 */
const VRAM_LATE_MS = 1_000

/** How many answered samples a run keeps: the peak is kept apart, and the rule needs two. */
const VRAM_KEPT = 4

/**
 * How many samples in a row may fail before a run on a shared card is
 * stopped as one nobody can watch (VramWatch · unwatchable).
 *
 * One failed sample decides nothing: a daemon under load fails an exec now
 * and then (every other call here is retried for that reason, `retried`),
 * and two in a row happen. Four in a row is twelve seconds on the status
 * cycle (STATUS_EVERY_MS), about twenty-five when each hangs to its deadline
 * (a hung one spans two cycles), in which nothing at all is known of a run
 * that may hold the whole card: twice what the over-share rule needs to
 * decide (two samples, three to six seconds) and a hiccup on top. Fewer would
 * stop honest runs for a slow daemon; more would hand the card, a stretch at
 * a time, to a run that keeps itself unreadable, and every run sharing the
 * card would pay for it in out-of-memory errors of their own.
 */
export const VRAM_UNREAD_LIMIT = 4

/**
 * The video memory a run's container holds on its card, MiB, from
 * `nvidia-smi --query-compute-apps=used_memory --format=csv,noheader,nounits`
 * run INSIDE it: there it lists that container's processes only (checked on
 * the lab VM: two containers on one card each see themselves), so the sum is
 * this run's and nobody else's. No line at all is a valid answer — nothing
 * on the card yet, 0. `null` — not an answer: a field that is not a whole
 * number ("[N/A]"), or anything else nvidia-smi might print.
 */
export function parseGpuMemory(out: string): number | null {
  let total = 0
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line || /^no running processes found$/i.test(line)) continue
    if (!/^\d+$/.test(line)) return null
    total += Number(line)
  }
  return Number.isSafeInteger(total) ? total : null
}

/**
 * The watchdog's rule: whether a run is over its share, given its samples
 * oldest first (MiB; `null` — a sample that failed or did not parse).
 *
 * Over means the last two samples that answered are both above the share
 * plus its tolerance (competitions/gpu-math.ts · gpuKillAboveMb). Two,
 * because one reading may catch a moment — an allocator that grows and gives
 * back within a second — and a kill is final; two, three seconds apart, are a
 * run that stays where it should not be. A sample that did not answer decides
 * nothing either way here: it neither counts toward this kill (a failure is
 * not a reading) nor resets one (a run that keeps the daemon from answering
 * must not buy itself the card that way). Failures in a row have a rule of
 * their own, VRAM_UNREAD_LIMIT.
 */
export function gpuOverShare(samples: ReadonlyArray<number | null>, sliceMb: number): boolean {
  const limit = gpuKillAboveMb(sliceMb)
  const answered = samples.filter((sample): sample is number => sample !== null)
  return answered.length >= 2 && answered[answered.length - 1] > limit && answered[answered.length - 2] > limit
}

/**
 * The video memory of one run with a share of a card, watched from outside —
 * the hard half of the share (the soft one is inside, harness.ts ·
 * SITECUSTOMIZE, which the participant's code can lift and other libraries
 * never see).
 *
 * The participant is the one watched, so the watch must not be theirs to
 * stop. nvidia-smi has to run inside the container — only there does it list
 * that container's processes and nobody else's — and a plain `docker exec`
 * enters as the container's user: uid 1000, the participant's own, and a
 * process may signal any other of its uid without a single capability. One
 * SIGSTOP blinded the first version of this watch for the rest of a run, and
 * a loop of SIGKILLs left every sample unanswered and the run unstopped
 * (review, 13 Oct 2026). So the sample runs as root: uid 1000 cannot signal
 * root without CAP_KILL, and the container has no capability at all
 * (`--cap-drop=ALL`). Nor does root gain anything in there: no capability, a
 * read-only root filesystem, and nvidia-smi found on the image's own PATH,
 * every directory of which is on that read-only root.
 *
 * What root cannot buy is the processor: the sample runs in the container's
 * cgroup, and a notebook that keeps hundreds of threads busy starves it past
 * its deadline. So no failure is final and none is ignored. Samples are
 * taken on the watchdog's status cycle, in the background (a slow one must
 * not hold up the deadline or the progress beacon), never two at once; one
 * that has not answered by its deadline is given up and the next cycle tries
 * again; and the samples that fail in a row are counted, VRAM_UNREAD_LIMIT of
 * them stopping the run (`unwatchable`, watch). A stuck nvidia-smi stays in
 * the container until it ends, which bounds them at that many as well.
 */
class VramWatch {
  /** The most seen at once, MiB; `null` until a sample answers. */
  peakMb: number | null = null
  /** Samples that did not answer since the last one that did. */
  failures = 0
  /**
   * What the last failed sample said, for the teacher: the first line of its
   * output, or its exit code; `null` — nothing before its deadline.
   */
  lastFailure: string | null = null
  private readonly answered: number[] = []
  private inFlight = false

  constructor(
    private readonly container: string,
    readonly sliceMb: number,
  ) {}

  sample(): void {
    if (this.inFlight) return
    this.inFlight = true
    const started = Date.now()
    let late: NodeJS.Timeout | undefined
    let open = true
    const settle = (result: { code: number; out: string }): void => {
      if (!open) return
      open = false
      clearTimeout(late)
      this.inFlight = false
      this.record(result, Date.now() - started >= VRAM_SAMPLE_MS)
    }
    late = setTimeout(() => settle({ code: -1, out: '' }), VRAM_SAMPLE_MS + VRAM_LATE_MS)
    // As root: see the class's comment. The client itself is killed at VRAM_SAMPLE_MS (shell).
    docker(
      ['exec', '--user', '0:0', this.container, 'nvidia-smi', '--query-compute-apps=used_memory', '--format=csv,noheader,nounits'],
      VRAM_SAMPLE_MS,
      64 * 1024,
    ).then(settle, () => settle({ code: -1, out: '' }))
  }

  private record(result: { code: number; out: string }, stalled: boolean): void {
    const mb = result.code === 0 ? parseGpuMemory(result.out) : null
    if (mb === null) {
      this.failures++
      this.lastFailure = stalled ? null : result.out.split('\n')[0].trim().slice(0, 200) || `exit ${result.code}`
      return
    }
    this.failures = 0
    this.peakMb = Math.max(this.peakMb ?? 0, mb)
    this.answered.push(mb)
    if (this.answered.length > VRAM_KEPT) this.answered.shift()
  }

  over(): boolean {
    return gpuOverShare(this.answered, this.sliceMb)
  }

  /** Whether the card has gone unread long enough to stop the run (VRAM_UNREAD_LIMIT). */
  unwatchable(): boolean {
    return this.failures >= VRAM_UNREAD_LIMIT
  }

  /** What the teacher reads next to the kill: the last samples that answered. */
  samples(): number[] {
    return [...this.answered]
  }
}

const INSPECT = '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}'

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (competitionsFs.statSync(file).size > 1024 * 1024) return null
    const raw = competitionsFs.readFileSync(file) as Buffer
    const value: unknown = JSON.parse(raw.toString('utf8'))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Watching a running container: the time limit, printed output and what it
 * writes to disk.
 *
 * An internal timer is no good for this at all. A cell that went into a C loop
 * holds the GIL, and no Python alarm inside will fire; `--ulimit fsize`
 * catches one file, not a hundred files of a gigabyte each. There is no hiding
 * from outside the container: `docker kill` is a SIGKILL from the host kernel.
 *
 * Disk growth is bounded by tmpfs itself, including nested directories. The
 * host watchdog handles time/output and reads only bounded progress JSON.
 *
 * `salvage` runs right before a kill for time, printing or a card's memory,
 * while the tmpfs is still there to read: the harness normally stops a late
 * notebook itself and exits in time, and this is for the day it could not —
 * the copy of the notebook it keeps on disk is all that is left to show. A
 * cancellation takes nothing: a withdrawn run publishes nothing.
 *
 * `vram` watches a run's share of a card (VramWatch): sampled on the same
 * status cycle, and a run over its share is killed from outside like one over
 * its printing — and so is a run whose card cannot be read at all.
 */
async function watch(
  container: string,
  resultDir: string,
  limits: StepLimits,
  attemptId: string,
  onProgress?: (progress: RunProgress) => void,
  signal?: AbortSignal,
  salvage?: () => Promise<void>,
  vram?: VramWatch | null,
): Promise<Watched> {
  const deadline = Date.now() + limits.wallSeconds * 1000
  let last: RunProgress | null = null
  let lookedInside = -Infinity
  for (;;) {
    if (signal?.aborted) {
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: null, progress: last }
    }
    const state = await containerState(container)
    if (state === 'stopped' || state === 'gone') return { killedBy: null, progress: last }
    /*
     * At the deadline the container is looked into once more before it is
     * killed, however recent the last look: the supervisor keeps a finished
     * notebook's container running for the export, and a notebook that ended
     * between two looks has finished, not run out of time.
     */
    const due = Date.now() >= deadline
    // `unknown`: the daemon keeps failing without saying why. Nothing is
    // concluded from that — the deadline still bounds the wait.
    if (state === 'running' && (due || Date.now() - lookedInside >= STATUS_EVERY_MS)) {
      lookedInside = Date.now()
      // Started first and not waited for: it lands while the beacon is read, or by the next look.
      vram?.sample()
      const snapshot = await docker(['exec', container, 'python', '-I', '/harness/export_files.py', 'status', resultDir], 5000, 128 * 1024)
      let report: any = {}
      try { report = snapshot.code === 0 ? JSON.parse(snapshot.out) : {} } catch { /* incomplete report */ }
      const beat = report.progress?.attemptId === attemptId ? report.progress : null
      if (beat) {
        const progress: RunProgress = {
          phase: beat.phase === 'dependencies' ? 'dependencies' : 'notebook',
          cell: num(beat.cell) ?? -1,
          cells: num(beat.cells) ?? 0,
          outputBytes: num(beat.outputBytes) ?? 0,
        }
        if (
          !last ||
          last.phase !== progress.phase ||
          last.cell !== progress.cell ||
          last.cells !== progress.cells ||
          last.outputBytes !== progress.outputBytes
        ) {
          last = progress
          onProgress?.(progress)
        }
      }
      /*
       * Printed output is read from the beacon, not from the container: trimmed
       * outputs do not get into memory, but the notebook spends time and CPU on
       * them, and eight gigabytes of printing is thirty seconds of someone else's
       * queue.
       */
      if (limits.outputKillBytes > 0 && (last?.outputBytes ?? 0) > limits.outputKillBytes) {
        await salvage?.().catch(() => undefined)
        await docker(['kill', '--signal=KILL', container], 30_000)
        return { killedBy: 'output', progress: last }
      }
      if (report.complete?.attemptId === attemptId && Number.isInteger(report.complete.exit))
        return { killedBy: null, progress: last, exit: report.complete.exit }
    }
    /*
     * Over its share of the card: the other runs on the card are losing their
     * memory to it right now, and the soft cap inside did not hold it (lifted
     * by the participant's code, or memory torch never saw). Before the
     * deadline's own kill: the run has been over its share for a status
     * cycle at least, and that is what it is stopped for.
     */
    if (state === 'running' && vram?.over()) {
      await salvage?.().catch(() => undefined)
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: 'gpu', progress: last }
    }
    /*
     * A run on a shared card that nobody can read: fail closed. Whatever
     * keeps its samples from answering — a notebook starving the container's
     * processor, a driver that hangs, a daemon that cannot exec — the run may
     * be holding the whole card meanwhile, and the runs beside it pay. After
     * the evidence above, so a run seen over its share is told that instead.
     * No salvage first: what keeps nvidia-smi from answering — most often a
     * starved processor — would most likely keep the notebook's copy in for
     * the ten seconds a salvage may take as well, and each of those seconds
     * may be the card.
     */
    if (state === 'running' && vram?.unwatchable()) {
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: 'gpu-unread', progress: last }
    }
    if (due) {
      if (state === 'running') await salvage?.().catch(() => undefined)
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: 'wall', progress: last }
    }
    // Wake at the deadline itself, not up to a poll later.
    await sleep(Math.max(0, Math.min(POLL_MS, deadline - Date.now())))
  }
}

/** Whether the container runs — `unknown` only when the daemon kept failing through the retries. */
async function containerState(container: string): Promise<'running' | 'stopped' | 'gone' | 'unknown'> {
  const result = await retried(
    () => docker(['inspect', container, '--format', '{{.State.Running}}'], 20_000),
    (answer) => answer.code === 0 || missing(answer.out),
  )
  if (result.code === 0) return result.out.trim() === 'true' ? 'running' : 'stopped'
  return missing(result.out) ? 'gone' : 'unknown'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Copy only a bounded allowlist while the supervisor keeps tmpfs mounted. */
async function collectExports(container: string, from: string, to: string, files: Array<[string, number]>, timeoutMs = 20_000): Promise<void> {
  competitionsFs.mkdirSync(to, { recursive: true })
  for (const [name, maximum] of files) await exportFile(container, from, to, name, maximum, timeoutMs)
}

/**
 * One allowlisted file out of the container — streamed.
 *
 * The base64 that `docker exec` prints is decoded as it arrives and written
 * to disk asynchronously. Before, a 64 MB answer became an 85 MB string, was
 * checked, decoded, encoded again for the comparison and written
 * synchronously — all of it on the event loop that serves the class, and with
 * eight slots finishing at once, eight times over. The file appears under its
 * name only whole: it is written next to it and renamed at the end.
 */
async function exportFile(container: string, from: string, to: string, name: string, maximum: number, timeoutMs = 20_000): Promise<void> {
  const temporary = path.join(to, `.${name}.part`)
  const decoder = new Base64Decoder(maximum)
  const written = pipeline(decoder, competitionsFs.createWriteStream(temporary, { mode: 0o600 })).then(() => true, () => false)
  const result = await docker(['exec', container, 'python', '-I', '/harness/export_files.py', 'file', from, name], timeoutMs, Math.ceil(maximum / 3) * 4 + 4, decoder)
  // A shell that does not stream (the tests' stand-in) hands the whole answer back in `out`.
  if (!decoder.writableEnded) decoder.end(!decoder.fed && result.code === 0 ? result.out : undefined)
  const whole = await written
  if (whole && result.code === 0) competitionsFs.renameSync(temporary, path.join(to, name))
  else competitionsFs.rmSync(temporary, { force: true })
}

/**
 * Base64 in, bytes out — held to the same rules the whole-string check had:
 * only the alphabet, padding only at the very end, whitespace only after the
 * data, and never more than `maximum` bytes.
 */
class Base64Decoder extends Transform {
  /** Whether anything arrived through the stream at all. */
  fed = false
  private carry = ''
  private bytes = 0
  private padded = false
  private trailing = false

  constructor(private readonly maximum: number) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.fed = true
    let text = chunk.toString('latin1')
    if (this.trailing) return done(/\S/.test(text) ? new Error('Export is not base64') : null)
    const blank = text.search(/\s/)
    if (blank >= 0) {
      if (/\S/.test(text.slice(blank))) return done(new Error('Export is not base64'))
      this.trailing = true
      text = text.slice(0, blank)
    }
    if (!/^[A-Za-z0-9+/=]*$/.test(text)) return done(new Error('Export is not base64'))
    text = this.carry + text
    const whole = text.length - (text.length % 4)
    this.carry = text.slice(whole)
    const body = text.slice(0, whole)
    if (!body) return done()
    if (this.padded) return done(new Error('Export continues after its padding'))
    const pad = body.indexOf('=')
    if (pad >= 0) {
      if (pad < body.length - 4 || !/^[A-Za-z0-9+/]{2}(?:==|[A-Za-z0-9+/]=)$/.test(body.slice(-4))) {
        return done(new Error('Export is not base64'))
      }
      this.padded = true
    }
    const decoded = Buffer.from(body, 'base64')
    this.bytes += decoded.length
    if (this.bytes > this.maximum) return done(new Error('Export grew beyond its limit'))
    done(null, decoded)
  }

  override _flush(done: TransformCallback): void {
    done(this.carry ? new Error('Export is cut short') : null)
  }
}

/** Post-mortem of a stopped container — BEFORE it is removed. */
async function postmortem(container: string): Promise<{ exit: number | null; oom: boolean; tail: string }> {
  const state = await retried(
    () => docker(['inspect', container, '--format', INSPECT], 20_000),
    (answer) => answer.code === 0 || missing(answer.out),
  )
  let exit: number | null = null
  let oom = false
  if (state.code === 0) {
    const parts = state.out.trim().split(/\s+/)
    const code = Number(parts[1])
    exit = Number.isFinite(code) ? code : null
    oom = parts[2] === 'true'
  }
  const logs = await docker(['logs', '--tail', '40', container], 20_000)
  return { exit, oom, tail: logs.out.slice(-4000) }
}

/**
 * What everything we saw turns into.
 *
 * The order here is the answer itself, and it is the same as in the prototype
 * (`drive.py` · verdict_of). A kill for memory or for the time limit outranks
 * anything the harness managed to write: its `run.json` may have been left
 * over from the previous cell. "The notebook ran, but there is no file" goes
 * BEFORE its status — otherwise a submission with empty hands would count as a
 * success and go to the metric with nothing.
 *
 * The two kills from outside are named in the participant's words, not ours.
 * Printing over the cap is a crash of their notebook (`cell_error`, "NOTEBOOK
 * ERROR"), with a sentence next to it about how much it printed. A write over
 * the cap into the host directory is "answer rejected" (`target_too_large`),
 * because that is exactly what happened. A card's memory over the run's share
 * is out of memory, like the machine's: the same badge, and a sentence of its
 * own about the share (runner.ts · gpuKillNote).
 *
 * A card that could not be read (`gpu-unread`) is named by what was seen
 * before it went silent. A card that answered and then stopped answering in
 * this run is a notebook that broke the rule of a shared card — most often by
 * starving its own container's processor — and its cell fails with our
 * sentence in place of a traceback (unreadCardNotes); it counts like any
 * failed notebook, so stopping a run this way cannot be had for free again
 * and again. A card that never answered at all is our machinery (no
 * nvidia-smi in the container, a driver in trouble), never the participant's
 * doing: a harness error, which blames nobody and costs them nothing.
 */
export function verdictOfRun(input: {
  oom: boolean
  killedBy: 'wall' | 'output' | 'disk' | 'gpu' | 'gpu-unread' | null
  status: string | null
  produced: boolean
  /** Whether the run's card answered at least once (VramWatch); only `gpu-unread` asks. */
  cardRead?: boolean
}): RunVerdict {
  if (input.oom) return 'out-of-memory'
  if (input.killedBy === 'gpu') return 'out-of-memory'
  if (input.killedBy === 'gpu-unread') return input.cardRead ? 'cell_error' : 'harness_error'
  if (input.killedBy === 'wall') return 'timeout'
  if (input.killedBy === 'output') return 'cell_error'
  if (input.killedBy === 'disk') return 'target_too_large'
  const status = input.status
  if (status && status !== 'ok') return asVerdict(status)
  if (!input.produced) return 'no-submission'
  return status ? asVerdict(status) : 'unknown'
}

/**
 * The harness's word — only if we know it.
 *
 * The harness and the types are edited in different files, and an unknown
 * word passed on as is would land in the database as a state that no badge
 * has.
 */
const VERDICTS = new Set<string>([
  'ok',
  'cell_error',
  'cell_timeout',
  'kernel_died',
  'exit',
  'target_too_large',
  'target_unreadable',
  'harness_error',
  'dependency_error',
  'no-submission',
  'out-of-memory',
  'timeout',
  'participant_error',
  'metric_error',
])

function asVerdict(status: string): RunVerdict {
  // A notebook that nbformat could not read is a refusal to the participant,
  // not a harness crash: the participant sent the file.
  if (status === 'notebook_unreadable') return 'target_unreadable'
  return VERDICTS.has(status) ? (status as RunVerdict) : 'unknown'
}

/**
 * The words for a run stopped because its card could not be read (watch ·
 * `gpu-unread`): `participant` goes where a traceback would (RunOutcome.detail,
 * after runner.ts's own "failed at cell" head), `teacher` heads the log.
 *
 * Both are ours alone. Every number in them was counted outside the notebook
 * (the samples, the share), and there is no cell number in the participant's
 * sentence: the head that precedes it names the cell, clamped to the notebook
 * that was sent (runner.ts · clampCells), and a cell read from the beacon
 * here would not be. The reason in the teacher's line is what docker or
 * nvidia-smi said, running as root where the notebook cannot reach. A card
 * that never answered has no participant sentence at all — that run ends as
 * our own failure (verdictOfRun) — and the teacher is told where to look.
 */
export function unreadCardNotes(input: {
  device: string
  sliceMb: number
  failures: number
  /** What the last failed sample said; `null` — nothing before its deadline. */
  lastFailure: string | null
  /** Whether the card answered at least once in this run. */
  answered: boolean
}): { participant: string | null; teacher: string } {
  const reason = input.lastFailure ?? tr('competitions.answer.gpuSampleStalled', { seconds: VRAM_SAMPLE_MS / 1000 })
  const teacher = tr('competitions.answer.gpuUnreadKilled', {
    device: input.device,
    count: input.failures,
    reason,
    slice: input.sliceMb,
  })
  return input.answered
    ? { participant: tr('competitions.answer.gpuUnread', { count: input.failures }), teacher }
    : { participant: null, teacher: `${teacher} ${tr('competitions.answer.gpuNeverRead')}` }
}

/**
 * Why the package set failed to install, when the harness could tell — read
 * off its run.json by both runners, so that both give the participant the
 * same words: a set that ran out of room is not a reason to "try again".
 * `roomMb` is the room the run was given, for a report that could not
 * measure it.
 */
export function dependencyFailureOf(verdict: RunVerdict, report: Record<string, unknown> | null, roomMb: number): Pick<RunOutcome, 'dependencyFailure'> {
  if (verdict !== 'dependency_error' || report?.reason !== 'no_space') return {}
  return { dependencyFailure: { reason: 'no_space', roomBytes: num(report.roomBytes) ?? roomMb * 1024 ** 2 } }
}

/* ------------------------------------------------------------------- runner */

/**
 * What the machine can still hand out, as capacity() reports it next to the
 * containers awaiting removal (runner-port.ts · Capacity says what each
 * number is for); `null` — honestly unknown.
 */
export interface MachineMemory {
  availableMb: number | null
  usableMb: number | null
  memAvailableMb: number | null
}

/** Asked at every capacity() call; never rejects (an unknown number is `null`). */
export type MachineMemorySource = () => Promise<MachineMemory>

const UNKNOWN_MEMORY: MachineMemory = { availableMb: null, usableMb: null, memAvailableMb: null }

export interface DockerRunnerOptions {
  /**
   * What the machine can still hand out. Home's is the room census, the
   * host's reserve and MemAvailable (competitions/capacity.ts ·
   * competitionMemory), which this module may not import; without it the
   * memory is unknown, which is what a machine for submissions starts with —
   * its agent sizes its offer to home by its own numbers and never asks this.
   */
  memory?: MachineMemorySource
}

export class DockerCompetitionRunner implements CompetitionRunner {
  readonly backend = 'docker' as const
  private readonly memory: MachineMemorySource

  constructor(options: DockerRunnerOptions = {}) {
    this.memory = options.memory ?? (() => Promise.resolve(UNKNOWN_MEMORY))
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    const started = Date.now()
    const attemptId = request.attemptId ?? randomUUID()
    const image = request.imageDigest ?? `${IMAGE_PREFIX}:${request.competition.environment || 'base'}`
    const args = runArgs({
      container: request.container,
      attemptId,
      image,
      dataDir: request.dataDir,
      inputDir: request.inputDir,
      resultDir: request.resultDir,
      dependenciesDir: request.dependenciesDir,
      packagesMb: request.packagesMb,
      limits: request.limits,
      target: SUBMISSION_NAME,
      gpu: request.gpu,
    })
    const started_ = await docker(args, 120_000)
    const held = { memoryMb: request.limits.memoryMb + CONTAINER_CUSHION_MB, gpu: request.gpu?.device || null }
    if (started_.code !== 0) {
      await removeContainer(request.container, held)
      /*
       * The most common trouble of a card is not ours: the host lacks
       * nvidia-container-toolkit, and docker answers "could not select device
       * driver". The teacher reads the same hint a GPU room gives, and only
       * when docker said exactly that.
       */
      const noDriver = held.gpu !== null && /device driver|nvidia/i.test(started_.out)
      return {
        status: 'harness_error',
        cell: -1,
        cells: 0,
        wall: Date.now() - started,
        submission: null,
        detail: '',
        log: noDriver ? `${started_.out}${tr('server.theHostMayBeMissingNvidiaContainer.f5c0df')}` : started_.out,
        diagnostics: { exit: null, oomKilled: false, backend: this.backend },
      }
    }
    const share = heldShareMb(request.gpu)
    const vram = share === null ? null : new VramWatch(request.container, share)
    let watched: Watched = { killedBy: null, progress: null }
    let dead = { exit: null as number | null, oom: false, tail: '' }
    try {
      const salvage = () => collectExports(request.container, '/result', request.resultDir, [[EXECUTED_FILE, EXECUTED_BYTES]], SALVAGE_MS)
      watched = await watch(request.container, '/result', request.limits, attemptId, request.onProgress, request.signal, salvage, vram)
      dead = await postmortem(request.container)
      if (watched.exit !== undefined) {
        dead.exit = watched.exit
        await collectExports(request.container, '/result', request.resultDir, [[RUN_FILE, 65536], [SUBMISSION_NAME, request.limits.targetBytes], [EXECUTED_FILE, EXECUTED_BYTES]])
      }
    } finally {
      // The container is ALWAYS removed, and only after the post-mortem: `--rm`
      // would take the OOM flag from us, and a forgotten container is gigabytes
      // on a machine where a class is running. A removal that fails is retried
      // later and does not touch the verdict: the notebook did run.
      await removeContainer(request.container, held)
    }
    const observed = readJson(path.join(request.resultDir, RUN_FILE))
    const report = observed?.attemptId === attemptId ? observed : null
    const answer = path.join(request.resultDir, SUBMISSION_NAME)
    const produced = competitionsFs.existsSync(answer)
    const status = dead.exit !== 0 && report?.status === 'ok' ? 'exit' : typeof report?.status === 'string' ? report.status : null
    const cardRead = vram !== null && vram.peakMb !== null
    const verdict = verdictOfRun({ oom: dead.oom, killedBy: watched.killedBy, status, produced, cardRead })
    const unread = watched.killedBy === 'gpu-unread' && vram
      ? unreadCardNotes({
        device: request.gpu?.device ?? '',
        sliceMb: vram.sliceMb,
        failures: vram.failures,
        lastFailure: vram.lastFailure,
        answered: cardRead,
      })
      : null
    const beat = watched.progress
    return {
      status: verdict,
      cell: num(report?.cell) ?? beat?.cell ?? -1,
      cells: num(report?.cells) ?? beat?.cells ?? 0,
      wall: Date.now() - started,
      submission: verdict === 'ok' && produced ? answer : null,
      // The sentence goes only where it is read: after a cell's head (runner.ts · notebookNote).
      detail: verdict === 'cell_error' && unread?.participant ? unread.participant : typeof report?.detail === 'string' ? report.detail : '',
      log: unread ? [unread.teacher, dead.tail].filter(Boolean).join('\n') : dead.tail,
      ...dependencyFailureOf(verdict, report, request.packagesMb ?? request.limits.tmpfsMb),
      diagnostics: {
        exit: dead.exit,
        oomKilled: dead.oom,
        backend: this.backend,
        killedBy: watched.killedBy ?? undefined,
        peakBytes: num(report?.peakBytes),
        // Measured from outside, for the teacher; only a watched run has them.
        ...(vram ? { gpuPeakMb: vram.peakMb, gpuSamplesMb: vram.samples() } : {}),
      },
    }
  }

  async score(request: ScoreRequest): Promise<ScoreOutcome> {
    const started = Date.now()
    const attemptId = request.attemptId ?? randomUUID()
    const image = request.imageDigest ?? `${IMAGE_PREFIX}:${request.competition.environment || 'base'}`
    const args = scoreArgs({
      container: request.container,
      attemptId,
      image,
      secretDir: request.secretDir,
      submissionDir: request.submissionDir,
      outDir: request.outDir,
      limits: request.limits,
      solutionFile: SOLUTION_NAME,
      metricFile: METRIC_NAME,
      idColumn: DEFAULT_ID_COLUMN,
      publicPercent: request.competition.publicPercent,
      splitSeed: request.competition.splitSeed,
    })
    const launched = await docker(args, 120_000)
    // Memory only: the metric's container never has a card.
    const held = { memoryMb: request.limits.memoryMb + CONTAINER_CUSHION_MB }
    if (launched.code !== 0) {
      await removeContainer(request.container, held)
      return metricFailure(this.backend, launched.out, Date.now() - started, null, false)
    }
    let watched: Watched = { killedBy: null, progress: null }
    let dead = { exit: null as number | null, oom: false, tail: '' }
    try {
      watched = await watch(request.container, '/out', request.limits, attemptId, undefined, request.signal)
      dead = await postmortem(request.container)
      if (watched.exit !== undefined) {
        dead.exit = watched.exit
        await collectExports(request.container, '/out', request.outDir, [[SCORE_FILE, 1024 * 1024]])
      }
    } finally {
      await removeContainer(request.container, held)
    }
    const wall = Date.now() - started
    /*
     * The metric was killed from outside or for memory — that is the TEACHER's
     * code failing, not the participant's, and calling it "time ran out" would
     * give the participant a badge for someone else's mistake:
     * `stateOfVerdict` examines `timeout` and `out-of-memory` before the kind
     * of run.
     */
    if (dead.oom) {
      return metricFailure(this.backend, `metric container out of memory\n${dead.tail}`, wall, dead.exit, true)
    }
    if (watched.killedBy !== null) {
      return metricFailure(
        this.backend,
        `metric container killed after ${METRIC_WALL_SECONDS}s (${watched.killedBy})\n${dead.tail}`,
        wall,
        dead.exit,
        false,
      )
    }
    const report = readJson(path.join(request.outDir, SCORE_FILE))
    if (!report || report.attemptId !== attemptId || (report.status === 'ok' && dead.exit !== 0)) {
      return metricFailure(this.backend, `no ${SCORE_FILE}\n${dead.tail}`, wall, dead.exit, false)
    }
    const status = typeof report.status === 'string' ? asVerdict(report.status) : 'metric_error'
    return {
      status,
      public: num(report.public),
      private: num(report.private),
      message: participantText(report),
      teacherOnly: typeof report.teacherOnly === 'string' ? report.teacherOnly : null,
      wall,
      diagnostics: { exit: dead.exit, oomKilled: dead.oom, backend: this.backend },
    }
  }

  async kill(container: string): Promise<void> {
    await docker(['kill', '--signal=KILL', container], 30_000)
  }

  /**
   * Sweep up after the process's previous life.
   *
   * Only by OUR OWN labels: on the teacher's machine the containers of rooms
   * and personal notebooks stand alongside, and removing someone else's here
   * would mean killing a class in progress. Containers labelled
   * `competition-run`/`competition-score` are created only by this module and
   * live only for the duration of one submission, so any found after startup
   * is already orphaned.
   *
   * Each is read with the card it holds (its `colloq.gpu` label): an orphan
   * whose removal fails keeps that card out of the queue's reach until the
   * retry gets it, exactly like a container of this life (capacity ·
   * heldGpus). The queue rows of the previous life gave their cards back
   * when they were put back into waiting (store.ts · reclaimQueue).
   */
  async sweep(legacyContainers: readonly string[] = []): Promise<number> {
    let dropped = 0
    for (const label of [RUN_LABEL, SCORE_LABEL]) {
      const found = await docker(['ps', '-a', '--filter', `label=${label}`, '--filter', `label=${INSTANCE_LABEL}`, '--format', '{{.ID}}\t{{.Label "colloq.gpu"}}'], 20_000)
      if (found.code !== 0) continue
      for (const line of found.out.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
        const [id, card = ''] = line.split('\t').map((part) => part.trim())
        // No label prints nothing or "<no value>"; a device id has no blanks in it.
        const gpu = card && card !== '<no value>' && !/\s/.test(card) ? card : null
        if (await removeContainer(id, { gpu })) dropped++
      }
    }
    // Old queue rows name specific pre-scope containers. Never scan/delete all
    // unscoped jobs: prove each recorded container binds only this data root.
    for (const container of new Set(legacyContainers)) {
      const inspected = await docker(['inspect', container, '--format', '{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}'], 10_000)
      if (inspected.code !== 0 && /No such (?:container|object)/i.test(inspected.out)) continue
      let owned = false
      try {
        const info = JSON.parse(inspected.out)
        const kind = info.labels?.['colloq.kind']
        const instance = info.labels?.[INSTANCE_KEY]
        const binds = Array.isArray(info.mounts) ? info.mounts.filter((mount: any) => mount.Type === 'bind') : []
        owned = inspected.code === 0 && ['competition-run', 'competition-score'].includes(kind)
          && (instance === INSTANCE_SCOPE || (!instance && binds.length > 0 && binds.every((mount: any) => {
            if (typeof mount.Source !== 'string') return false
            const source = path.resolve(mount.Source)
            return source === HOST_DATA_ROOT || source.startsWith(`${HOST_DATA_ROOT}${path.sep}`)
          })))
      } catch { /* Unreadable ownership stays untouched. */ }
      if (!owned) {
        unverifiedLegacyContainers = Math.min(Number.MAX_SAFE_INTEGER, unverifiedLegacyContainers + 1)
        console.warn('[competitions] recorded legacy container ownership could not be verified; left untouched')
        continue
      }
      if (await removeContainer(container)) dropped++
    }
    return dropped
  }

  /**
   * How much memory on the machine can still be handed out.
   *
   * At home the numbers are the seminar form's (kernel/resources.ts, through
   * capacity.ts · competitionMemory, handed in as DockerRunnerOptions.memory):
   * the ceiling is held by docker's VIRTUAL MACHINE, not the Mac, and on
   * colima that is twelve gigabytes out of the machine's thirty-six. Counting
   * by the host would mean taking on a submission that `docker run` will
   * refuse in the middle of a class. Containers still awaiting removal keep
   * their own memory out of reach, and nothing more — and their cards, a
   * share each (`heldGpus`).
   */
  async capacity(): Promise<Capacity> {
    // Not awaited: the pump asks this with admission held, and a daemon that
    // hangs on `docker rm` takes sixty seconds per container to say so.
    // Until they go, the stuck ones hold their memory, as counted below.
    if (pendingCleanup.size > 0) void retryPendingCleanup()
    let heldMb = 0
    const heldGpus: Record<string, number> = {}
    for (const held of pendingCleanup.values()) {
      heldMb += held.memoryMb
      if (held.gpu) heldGpus[held.gpu] = (heldGpus[held.gpu] ?? 0) + 1
    }
    const memory = await this.memory()
    return {
      availableMb: memory.availableMb === null ? null : Math.max(0, memory.availableMb - heldMb),
      usableMb: memory.usableMb,
      memAvailableMb: memory.memAvailableMb,
      heldMb,
      heldGpus,
    }
  }
}

/** Text the participant reads verbatim — and only that. */
function participantText(report: Record<string, unknown>): string | null {
  if (typeof report.message === 'string' && report.message) return report.message
  // Our own check arrives as a code: the translation lives in shared/locales,
  // and the container knows nothing of the instance's language (see
  // harness.ts · align).
  if (typeof report.code === 'string' && report.code) {
    return JSON.stringify({ code: report.code, params: report.params ?? {} })
  }
  return null
}

function metricFailure(
  backend: 'docker',
  teacherOnly: string,
  wall: number,
  exit: number | null,
  oom: boolean,
): ScoreOutcome {
  return {
    status: 'metric_error',
    public: null,
    private: null,
    message: null,
    teacherOnly,
    wall,
    diagnostics: { exit, oomKilled: oom, backend },
  }
}

/** Names in the closed directory and in `/result` — one set for runner and storage. */
export const SUBMISSION_NAME = 'submission.csv'
export const SOLUTION_NAME = 'solution.csv'
export const METRIC_NAME = 'metric.py'

/**
 * Which column joins a submitted answer to the answer key.
 *
 * The competition editor (A2) has no field for it yet, and the default here is
 * the same as Kaggle's and the prototype's. When the field appears, it will
 * come here through `Competition`, not through a second environment variable.
 */
export const DEFAULT_ID_COLUMN = 'id'

/* ---------------------------------------------- the runner this server uses */

/**
 * The machine's memory for the runner registered below: capacity.ts ·
 * competitionMemory, which hands itself over when it loads
 * (provideMachineMemory). It goes this way round because this module may not
 * import capacity.ts — the room census and the database behind it are what a
 * machine for submissions must not load — while capacity.ts may import this
 * one, and the queue loads it for admitJob anyway (runner.ts).
 *
 * Asked at every capacity() call rather than once: the registration below is
 * made when this module loads, which is before capacity.ts has, and the queue
 * asks only later. A process that never loads capacity.ts (a script that runs
 * one submission, a test of this module) gets an unknown picture, which
 * admission never refuses (capacity.ts · admitJob), and one line in the log
 * that says so rather than a queue that silently stops weighing memory.
 */
let machineMemory: MachineMemorySource | null = null
let unwiredSaid = false

/** Hand the registered runner its memory picture; `null` takes it back (tests). */
export function provideMachineMemory(source: MachineMemorySource | null): void {
  machineMemory = source
}

function homeMemory(): Promise<MachineMemory> {
  if (machineMemory) return machineMemory()
  if (!unwiredSaid) {
    unwiredSaid = true
    console.warn('[competitions] the Docker runner has no memory picture (competitions/capacity.ts is not loaded): memory admission is skipped')
  }
  return Promise.resolve(UNKNOWN_MEMORY)
}

registerCompetitionRunner('docker', () => new DockerCompetitionRunner({ memory: homeMemory }))
