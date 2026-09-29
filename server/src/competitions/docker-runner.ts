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
 * And one rule, bought at a higher price than any other: we mount ONLY
 * directories, and only at paths that did not exist before this submission
 * (see the header of storage.ts).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform, type TransformCallback, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.js'
import { competitionsFs, hostPathOf, EXECUTED_BYTES, EXECUTED_FILE } from './storage.js'
import { harnessDir } from './harness.js'
import { competitionMemory } from './capacity.js'
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
const HOST_DATA_ROOT = path.resolve(hostPathOf(config.dataDir))
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
 * Containers whose removal failed: name → the memory they may still hold.
 *
 * A failed `docker rm` after a finished run is the daemon's trouble, not the
 * submission's: the verdict stands, the removal is retried later, and until
 * it succeeds only THAT container's memory stays out of the queue's reach.
 * It used to close the whole queue.
 */
const pendingCleanup = new Map<string, number>()
let cleanupTimer: NodeJS.Timeout | null = null
const CLEANUP_RETRY_MS = 30_000
let cleanupFailures = 0
let unverifiedLegacyContainers = 0
export function competitionDockerDiagnostics() { return { cleanupFailures, pendingCleanup: pendingCleanup.size, unverifiedLegacyContainers } }

/** Remove a container; `false` means it is left for the retry, holding `memoryMb`. Never throws. */
async function removeContainer(container: string, memoryMb = 0, patient = true): Promise<boolean> {
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
  pendingCleanup.set(container, Math.max(pendingCleanup.get(container) ?? 0, memoryMb))
  scheduleCleanup()
  return false
}

/** The retry in flight, if any: one at a time, whether the pump or the timer asks. */
let retrying: Promise<void> | null = null

/** One more try for every container still awaiting removal; the next pump or timer is the backoff. */
function retryPendingCleanup(): Promise<void> {
  retrying ??= (async () => {
    for (const [container, memoryMb] of [...pendingCleanup]) await removeContainer(container, memoryMb, false)
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
 */
function threadEnv(cpus: number): string[] {
  const t = threads(cpus)
  return ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS',
    'POLARS_MAX_THREADS', 'RAYON_NUM_THREADS', 'BLIS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'NUMBA_NUM_THREADS']
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
 * `docker run` arguments for the NOTEBOOK container.
 *
 * A separate pure function, because the tests have no real docker, and
 * assembling this line correctly matters more than calling it: a lost
 * `--network none` here is a submission with internet access, and it can only
 * be noticed when someone makes use of it.
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
}): string[] {
  const { container, limits } = opts
  const memory = `${limits.memoryMb}m`
  const packagesMb = opts.dependenciesDir && opts.packagesMb ? Math.max(1, Math.ceil(opts.packagesMb)) : 0
  // No file of the set is bigger than its room, and every file lives in a capped tmpfs.
  const fsize = Math.max(limits.fsizeBytes, packagesMb * 1024 ** 2)
  return [
    'run',
    '-d',
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
    `--ulimit=fsize=${fsize}:${fsize}`,
    '--restart=no',
    '--label',
    RUN_LABEL,
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
  killedBy: 'wall' | 'output' | 'disk' | null
  progress: RunProgress | null
  exit?: number
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
 * `salvage` runs right before a kill for time or printing, while the tmpfs is
 * still there to read: the harness normally stops a late notebook itself and
 * exits in time, and this is for the day it could not — the copy of the
 * notebook it keeps on disk is all that is left to show. A cancellation takes
 * nothing: a withdrawn run publishes nothing.
 */
async function watch(
  container: string,
  resultDir: string,
  limits: StepLimits,
  attemptId: string,
  onProgress?: (progress: RunProgress) => void,
  signal?: AbortSignal,
  salvage?: () => Promise<void>,
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
 * because that is exactly what happened.
 */
export function verdictOfRun(input: {
  oom: boolean
  killedBy: 'wall' | 'output' | 'disk' | null
  status: string | null
  produced: boolean
}): RunVerdict {
  if (input.oom) return 'out-of-memory'
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

class DockerCompetitionRunner implements CompetitionRunner {
  readonly backend = 'docker' as const

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
    })
    const started_ = await docker(args, 120_000)
    const held = request.limits.memoryMb + CONTAINER_CUSHION_MB
    if (started_.code !== 0) {
      await removeContainer(request.container, held)
      return {
        status: 'harness_error',
        cell: -1,
        cells: 0,
        wall: Date.now() - started,
        submission: null,
        detail: '',
        log: started_.out,
        diagnostics: { exit: null, oomKilled: false, backend: this.backend },
      }
    }
    let watched: Watched = { killedBy: null, progress: null }
    let dead = { exit: null as number | null, oom: false, tail: '' }
    try {
      const salvage = () => collectExports(request.container, '/result', request.resultDir, [[EXECUTED_FILE, EXECUTED_BYTES]], SALVAGE_MS)
      watched = await watch(request.container, '/result', request.limits, attemptId, request.onProgress, request.signal, salvage)
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
    const verdict = verdictOfRun({ oom: dead.oom, killedBy: watched.killedBy, status, produced })
    const beat = watched.progress
    return {
      status: verdict,
      cell: num(report?.cell) ?? beat?.cell ?? -1,
      cells: num(report?.cells) ?? beat?.cells ?? 0,
      wall: Date.now() - started,
      submission: verdict === 'ok' && produced ? answer : null,
      detail: typeof report?.detail === 'string' ? report.detail : '',
      log: dead.tail,
      ...dependencyFailureOf(verdict, report, request.packagesMb ?? request.limits.tmpfsMb),
      diagnostics: {
        exit: dead.exit,
        oomKilled: dead.oom,
        backend: this.backend,
        killedBy: watched.killedBy ?? undefined,
        peakBytes: num(report?.peakBytes),
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
    const held = request.limits.memoryMb + CONTAINER_CUSHION_MB
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
   */
  async sweep(legacyContainers: readonly string[] = []): Promise<number> {
    let dropped = 0
    for (const label of [RUN_LABEL, SCORE_LABEL]) {
      const found = await docker(['ps', '-aq', '--filter', `label=${label}`, '--filter', `label=${INSTANCE_LABEL}`], 20_000)
      if (found.code !== 0) continue
      for (const id of found.out.split('\n').map((line) => line.trim()).filter(Boolean)) {
        if (await removeContainer(id)) dropped++
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
   * Asked of the same module as the seminar form (kernel/resources.ts, through
   * capacity.ts): the ceiling is held by docker's VIRTUAL MACHINE, not the
   * Mac, and on colima that is twelve gigabytes out of the machine's
   * thirty-six. Counting by the host would mean taking on a submission that
   * `docker run` will refuse in the middle of a class. Containers still
   * awaiting removal keep their own memory out of reach, and nothing more.
   */
  async capacity(): Promise<Capacity> {
    // Not awaited: the pump asks this with admission held, and a daemon that
    // hangs on `docker rm` takes sixty seconds per container to say so.
    // Until they go, the stuck ones hold their memory, as counted below.
    if (pendingCleanup.size > 0) void retryPendingCleanup()
    let heldMb = 0
    for (const mb of pendingCleanup.values()) heldMb += mb
    const memory = await competitionMemory()
    return {
      availableMb: memory.availableMb === null ? null : Math.max(0, memory.availableMb - heldMb),
      usableMb: memory.usableMb,
      memAvailableMb: memory.memAvailableMb,
      heldMb,
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

registerCompetitionRunner('docker', () => new DockerCompetitionRunner())
