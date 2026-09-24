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
 * 6. No `--rm`. The container is needed dead for another ten milliseconds or
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
import { config } from '../config.js'
import { competitionsFs, hostPathOf } from './storage.js'
import { harnessDir } from './harness.js'
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
import { machineResources } from '../kernel/resources.js'
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

/** How often to look at a running container. A quarter second, as in the prototype. */
const POLL_MS = 250

/** Names of the files the harness puts into `/result`. */
const RUN_FILE = 'run.json'
const SCORE_FILE = 'score.json'

interface Shell {
  (args: string[], timeoutMs?: number, maxOutputBytes?: number): Promise<{ code: number; out: string }>
}

/**
 * Call docker.
 *
 * Our own copy rather than `dockerRead` from pool.ts, for exactly one reason:
 * that one has a short read deadline, while here we get `docker run` of a
 * heavy image. The form is the same — spawn with an array, no shell, no
 * quoting.
 */
const shell: Shell = (args, timeoutMs = 60_000, maxOutputBytes = 256 * 1024) =>
  new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    let bytes = 0, overflow = false
    const read = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) { overflow = true; child.kill('SIGKILL'); return }
      out += chunk.toString()
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
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
const pendingCleanup = new Set<string>()
let cleanupFailures = 0
let unverifiedLegacyContainers = 0
export function competitionDockerDiagnostics() { return { cleanupFailures, pendingCleanup: pendingCleanup.size, unverifiedLegacyContainers } }

async function removeContainer(container: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const removed = await docker(['rm', '-f', container], 60_000)
    if (removed.code === 0 || /No such container/i.test(removed.out)) {
      pendingCleanup.delete(container)
      return
    }
  }
  if (!pendingCleanup.has(container)) cleanupFailures = Math.min(Number.MAX_SAFE_INTEGER, cleanupFailures + 1)
  pendingCleanup.add(container)
  throw new Error('Competition container cleanup failed; execution capacity is held until cleanup recovers')
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
  limits: StepLimits
  target: string
}): string[] {
  const { container, limits } = opts
  const t = threads(limits.cpus)
  const memory = `${limits.memoryMb}m`
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
    '-e',
    `OMP_NUM_THREADS=${t}`,
    '-e',
    `MKL_NUM_THREADS=${t}`,
    '-e',
    `OPENBLAS_NUM_THREADS=${t}`,
    '-e',
    `NUMEXPR_NUM_THREADS=${t}`,
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
    `--memory=${memory}`,
    // Swap exactly equal to memory — otherwise a container that hits the limit
    // does not die but goes to disk and stalls for minutes (the same reason as
    // in pool.ts).
    `--memory-swap=${memory}`,
    `--cpus=${limits.cpus}`,
    `--ulimit=fsize=${limits.fsizeBytes}:${limits.fsizeBytes}`,
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
  const t = threads(limits.cpus)
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
    '-e',
    `OMP_NUM_THREADS=${t}`,
    '-e',
    `MKL_NUM_THREADS=${t}`,
    '-e',
    `OPENBLAS_NUM_THREADS=${t}`,
    '-e',
    `NUMEXPR_NUM_THREADS=${t}`,
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
 */
async function watch(
  container: string,
  resultDir: string,
  limits: StepLimits,
  attemptId: string,
  onProgress?: (progress: RunProgress) => void,
  signal?: AbortSignal,
): Promise<Watched> {
  const deadline = Date.now() + limits.wallSeconds * 1000
  let last: RunProgress | null = null
  for (;;) {
    if (signal?.aborted) {
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: null, progress: last }
    }
    const alive = await docker(['inspect', container, '--format', '{{.State.Running}}'], 20_000)
    if (alive.code !== 0 || alive.out.trim() !== 'true') return { killedBy: null, progress: last }

    const snapshot = await docker(['exec', container, 'python', '-I', '/harness/export_files.py', 'status', resultDir], 5000, 128 * 1024)
    let state: any = {}
    try { state = snapshot.code === 0 ? JSON.parse(snapshot.out) : {} } catch { /* incomplete report */ }
    const beat = state.progress?.attemptId === attemptId ? state.progress : null
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

    if (Date.now() > deadline) {
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: 'wall', progress: last }
    }
    /*
     * Printed output is read from the beacon, not from the container: trimmed
     * outputs do not get into memory, but the notebook spends time and CPU on
     * them, and eight gigabytes of printing is thirty seconds of someone else's
     * queue.
     */
    if (limits.outputKillBytes > 0 && (last?.outputBytes ?? 0) > limits.outputKillBytes) {
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: 'output', progress: last }
    }
    if (state.complete?.attemptId === attemptId && Number.isInteger(state.complete.exit))
      return { killedBy: null, progress: last, exit: state.complete.exit }
    await sleep(POLL_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Copy only a bounded allowlist while the supervisor keeps tmpfs mounted. */
async function collectExports(container: string, from: string, to: string, files: Array<[string, number]>): Promise<void> {
  competitionsFs.mkdirSync(to, { recursive: true })
  for (const [name, maximum] of files) {
    const result = await docker(['exec', container, 'python', '-I', '/harness/export_files.py', 'file', from, name], 20000, Math.ceil(maximum / 3) * 4 + 4)
    if (result.code !== 0 || result.out.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.out)) continue
    const body = Buffer.from(result.out, 'base64')
    if (body.length > maximum || body.toString('base64') !== result.out) continue
    competitionsFs.writeFileSync(path.join(to, name), body, { mode: 0o600 })
  }
}

/** Post-mortem of a stopped container — BEFORE it is removed. */
async function postmortem(container: string): Promise<{ exit: number | null; oom: boolean; tail: string }> {
  const state = await docker(['inspect', container, '--format', INSPECT], 20_000)
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
      limits: request.limits,
      target: SUBMISSION_NAME,
    })
    const started_ = await docker(args, 120_000)
    if (started_.code !== 0) {
      await removeContainer(request.container)
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
      watched = await watch(request.container, '/result', request.limits, attemptId, request.onProgress, request.signal)
      dead = await postmortem(request.container)
      if (watched.exit !== undefined) {
        dead.exit = watched.exit
        await collectExports(request.container, '/result', request.resultDir, [[RUN_FILE, 65536], [SUBMISSION_NAME, request.limits.targetBytes], ['executed.ipynb', 64 * 1024 ** 2]])
      }
    } finally {
      // The container is ALWAYS removed, and only after the post-mortem: `--rm`
      // would take the OOM flag from us, and a forgotten container is gigabytes
      // on a machine where a class is running.
      await removeContainer(request.container)
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
    if (launched.code !== 0) {
      await removeContainer(request.container)
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
      await removeContainer(request.container)
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
        try { await removeContainer(id); dropped++ } catch { /* capacity stays blocked until cleanup succeeds */ }
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
      try { await removeContainer(container); dropped++ } catch { /* retry through capacity */ }
    }
    return dropped
  }

  /**
   * How much memory on the machine can still be handed out.
   *
   * Asked of the same module as the seminar form (kernel/resources.ts): the
   * ceiling is held by docker's VIRTUAL MACHINE, not the Mac, and on colima
   * that is twelve gigabytes out of the machine's thirty-six. Counting by the
   * host would mean taking on a submission that `docker run` will refuse in the
   * middle of a class.
   */
  async capacity(): Promise<Capacity> {
    for (const container of pendingCleanup) {
      try { await removeContainer(container) } catch { return { availableMb: 0 } }
    }
    try {
      // reserveWork atomically deducts all in-flight promises after this census.
      const machine = await machineResources({ fresh: true, beforeReservations: true })
      return { availableMb: machine.memory.availableMb }
    } catch {
      return { availableMb: null }
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
