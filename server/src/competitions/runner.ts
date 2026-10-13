/**
 * The submission execution queue — one per instance, and the pump over it.
 *
 * THE DESIGN IN FIVE SENTENCES. The queue lives in the database (store.ts),
 * not in memory: a class period lasts an hour and a half, submissions pile up
 * all that time, and a server restart must not mean "thirty people submitted
 * into the void". The pump is one timer that takes work with the `takeNext`
 * transaction and starts it without waiting; how many at once is a setting of
 * the machine (`auto` sizes it by its CPUs and memory, capacity.ts), and every
 * job must also fit into memory next to the class, which runs on the same
 * machine and comes first. Work goes in two steps in two disposable
 * containers — the notebook, then the metric — and exactly one file moves
 * between them.
 * Everything that knows about docker lives behind the `runner-port.ts` door:
 * here we decide WHOSE work goes next and what to write into the submission
 * row. And at process startup the queue picks up the orphans: a "running" row
 * marked with another life of the process is a run that no longer has a
 * container.
 *
 * WHAT IS NOT HERE. Not a single `docker`, not a single disk path assembled
 * by hand, not a single copy of the competition rules. Paths are
 * `storage.ts`, rules are `@shared/competitions`, rows are `store.ts`. This
 * module ties them together, and so it reads top to bottom rather than
 * sideways.
 */
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { reserveWork, workBudgetSnapshot } from '../ops/work-budget.js'
import { competitionCapabilities } from './capabilities.js'
import { admitJob, MAX_SLOTS, slotsResolution } from './capacity.js'
import { saveSlots } from './settings.js'
import { submissionUsesCurrentBase, type AttemptProvenance } from './provenance.js'
import { gpuKillAboveMb, gpuSliceFor, noteClusterGpuSlots, runnerCardsHere, runnerGpuDevices, runnerGpuPerDevice, runnerGpuState } from './gpu.js'
import { formatNumber, tr } from '@shared/i18n'
/*
 * Not decoration: `admin/settings` installs the translator that reads the
 * instance language, and the strings the runner writes to the participant go
 * through `tr`.
 */
import '../admin/settings.js'
import { db } from '../db.js'
import { getBinding, lockOf, policyOf, type SubmissionBinding } from '../dependencies/store.js'
import { verifyBundleFiles } from '../dependencies/files.js'
import { dependencyMessage } from '../dependencies/messages.js'
import { dependencySize, packagesFit, packagesRoomMb } from '@shared/dependencies'
import {
  BOOT,
  cardWorkWaiting,
  enqueue,
  deferResourceAttempt,
  discardUnstartedRun,
  finishRun,
  finishQueueAttempt,
  ownsQueueAttempt,
  getCompetition,
  getSubmission,
  leaveQueue,
  listFiles,
  listSubmissions,
  openFileBytes,
  sealedFileBytes,
  noteQueueContainer,
  noteQueueGpuShare,
  nextQueueRow,
  orphanedRuns,
  queuePaused,
  queueRow,
  queueRows,
  reclaimQueue,
  runningRows,
  setQueuePaused,
  startRun,
  takeNext,
  updateSubmission,
  waitingCount,
  type QueueGpu,
  type QueueRow,
} from './store.js'
import {
  competitionsFs,
  competitionsDir,
  composeRunInputs,
  copyCompetitionFile,
  attemptDir,
  dropAttempt,
  promoteAttempt,
  publishAttemptArtifacts,
  inputDir,
  NOTEBOOK_FILE,
  openDir,
  resultDir,
  secretDir,
  SOLUTION_FILE,
  SUBMISSION_FILE,
} from './storage.js'
import { METRIC_NAME, VRAM_UNREAD_LIMIT, competitionDockerDiagnostics } from './docker-runner.js'
import { startSubmissionSweep, stopSubmissionSweep } from './housekeeping.js'
import { CompetitionResourcePending } from './broker-runner.js'
import {
  CLUSTER_GPU,
  competitionBackend,
  competitionRunner,
  limitsFor,
  type Capacity,
  type CompetitionBackend,
  type DependencyFailure,
  type RunOutcome,
  type RunRequest,
  type ScoreOutcome,
} from './runner-port.js'
import {
  LIMITS,
  isTerminal,
  notebookCellList,
  stateOfVerdict,
  type Competition,
  type RunKind,
  type Submission,
} from '@shared/competitions'

/*
 * Both runners are loaded here and only here.
 *
 * The port module only knows that they exist: importing them from there would
 * mean dragging docker argument assembly into a process that will never call
 * it. Registration happens when the module loads (registerCompetitionRunner).
 */
import './docker-runner.js'
import './fake-runner.js'
import './broker-runner.js'

/**
 * The container name — it is what the container is killed by and what it is
 * looked up by in the docker log.
 *
 * The prefix is shared with rooms (`colloq-`), so that all of the instance's
 * belongings are found with one `docker ps`. A random tail rather than an
 * attempt number: the previous submission's container may still be living
 * out its last milliseconds when a retry starts, and `docker run` with a
 * taken name refuses outright.
 */
export function containerName(submissionId: string, kind: RunKind, token: string): string {
  return `colloq-comp-${submissionId}-${token}-${kind === 'metric' ? 'score' : 'run'}`
}

const newToken = (): string => randomBytes(4).toString('hex')

/* ---------------------------------------------------------------- settings */

/**
 * How many submissions to execute at once.
 *
 * A setting of the MACHINE, not queue state like the pause: the owner's
 * number, the environment's COMPETITION_SLOTS, or `auto`, which sizes the
 * queue by the machine itself (settings.ts stores it, capacity.ts resolves
 * it). A slot is a ceiling, not a promise: every job must also fit into
 * memory before it takes one (pumpOnce).
 */
export { MAX_SLOTS }
export const DEFAULT_SLOTS = 1

export function queueSlots(): number {
  return slotsResolution().effective
}

/** Fix the number of slots (tests, stands); `'auto'` hands the choice back to the machine. */
export function setQueueSlots(slots: number | 'auto'): number {
  if (slots === 'auto') {
    saveSlots('auto')
    return queueSlots()
  }
  const value = Math.min(MAX_SLOTS, Math.max(1, Math.floor(Number(slots) || DEFAULT_SLOTS)))
  saveSlots(value)
  return value
}

/**
 * Memory headroom on top of what a submission asks for.
 *
 * A container costs more than its `--memory`: on top of it there is the
 * docker layer, the python process itself before the notebook's first line,
 * and the tmpfs, which counts toward the limit but is not taken up at once.
 * Two hundred and fifty-six megabytes is the cushion at which `docker run`
 * does not refuse at the boundary.
 */
export const RUN_RESERVE_MB = 256

/**
 * What the pump reserves for one queue row: the larger of its step's and the
 * metric's memory, plus the headroom. Both steps run under the one lease, so
 * the larger one is what it must cover. Also read by the owner's
 * «Работают сейчас» (routes/admin-running.ts), which lists the reservation.
 */
export function runReservationMb(competition: Competition, kind: RunKind): number {
  return RUN_RESERVE_MB + Math.max(limitsFor(competition, kind).memoryMb, limitsFor(competition, 'metric').memoryMb)
}

/**
 * Whether the machine has enough for new work.
 *
 * `null` means "we honestly do not know" (no /proc, the daemon is not
 * answering), and that is NOT a reason to refuse: a queue that stalled
 * because a file could not be read is worse than a submission refused by
 * docker. A refusal here happens only when we know for sure there is no
 * memory.
 */
export function enoughMemory(availableMb: number | null, needMb: number): boolean {
  if (availableMb === null) return true
  return availableMb >= needMb + RUN_RESERVE_MB
}

/**
 * Let the container read what we mounted for it.
 *
 * Competition files are written with mode 0600 — right for a directory inside
 * DATA_DIR (0700), but the container runs as uid 1000, and that is not
 * necessarily the server's uid. Under `make up` they match (the image has
 * `USER node` — the same 1000), while on the host machine it is the luck of
 * the draw: the submission silently reads neither the data nor its notebook,
 * and in the log this looks like "the notebook did not find train.csv".
 *
 * From here, not from storage.ts: the mode is changed for the isolated
 * executor (Docker locally or a Pod in k3s). The directory stays inside
 * DATA_DIR.
 */
function letContainerRead(dir: string): void {
  try {
    competitionsFs.chmodSync(dir, 0o755)
    for (const name of competitionsFs.readdirSync(dir) as string[]) {
      const file = path.join(dir, name)
      if (competitionsFs.statSync(file).isDirectory()) letContainerRead(file)
      else competitionsFs.chmodSync(file, 0o644)
    }
  } catch {
    // It did not work — let docker decide: it names a permission refusal out
    // loud, and failing the submission over this would be unfair.
  }
}

/* ------------------------------------------------------------------- pump */

/** Work running in THIS process: it shows whom we still have to wait for on shutdown. */
const inFlight = new Map<string, Promise<void>>()
const aborters = new Map<string, AbortController>()
const diagnostics = { started: 0, completed: 0, cancelled: 0, recovered: 0, cleanupFailures: 0 }
function count(key: keyof typeof diagnostics) { diagnostics[key] = Math.min(Number.MAX_SAFE_INTEGER, diagnostics[key] + 1) }
export function competitionExecutionDiagnostics() {
  const docker = competitionDockerDiagnostics()
  return { started: diagnostics.started, completed: diagnostics.completed, retries: diagnostics.recovered,
    cancellations: diagnostics.cancelled, cleanupFailures: diagnostics.cleanupFailures + docker.cleanupFailures,
    pendingContainerCleanup: docker.pendingCleanup,
    unverifiedLegacyContainers: docker.unverifiedLegacyContainers,
    activeAttemptIds: [...inFlight.keys()].slice(0, MAX_SLOTS) }
}

/** Submissions ordered to be taken down. Read by the run at the end, not at the start. */
const cancelled = new Map<string, 'entrant' | 'teacher'>()

let timer: NodeJS.Timeout | null = null
let pumping = false
let stopped = false

/**
 * Until when no GPU notebook is taken under the cluster (queueCards): the
 * backoff of the last one the cluster sent back for want of a unit. Zero —
 * no rest.
 */
let clusterGpuRestUntil = 0

/**
 * Take as much work as the machine and the setting allow, and do NOT wait for
 * it.
 *
 * Not waiting is essential: with two slots the second submission must start
 * while the first is running, not after it. Returns the number started —
 * `drainCompetitionQueue` uses it to tell that there is nothing more to take.
 */
export async function pumpOnce(): Promise<number> {
  if (pumping || stopped) return 0
  pumping = true
  let started = 0
  try {
    if (queuePaused()) return 0
    const slots = queueSlots()
    if (runningRows().length >= slots) return 0
    if (waitingCount() === 0) return 0
    const capabilities = await competitionCapabilities()
    if (!capabilities.execution.available) return 0
    const capacity = await competitionRunner().capacity()
    const usableMb = capacity.usableMb !== undefined ? capacity.usableMb : capacity.availableMb
    const heldMb = capacity.heldMb ?? 0
    /*
     * MemAvailable was measured once, before this loop, and a job started a
     * millisecond ago has not taken its memory yet: what this loop admits is
     * subtracted from the measurement by hand — that, and only that. Jobs
     * already running took theirs out of MemAvailable themselves.
     */
    let admittedMb = 0
    let availableDiskBytes: number | null = null
    try { const disk = fs.statfsSync(competitionsDir); availableDiskBytes = disk.bavail * disk.bsize } catch { /* unknown capacity */ }
    /*
     * The runner cards, once per pass: what each may hold is a census of the
     * rooms' containers, and that is a docker call. Who holds them is not read
     * here: the queue counts its own running rows at every take, so the
     * second take of this pass already sees the card the first one took.
     */
    const gpu = await queueCards(capacity, noteClusterGpuSlots(capabilities.gpuSlots))
    for (;;) {
      if (runningRows().length >= slots) break
      // The same filter as the take below: the work admitted is the work taken.
      const candidate = nextQueueRow(Date.now(), gpu)
      if (!candidate) break
      const competition = getCompetition(candidate.competitionId)
      const needMb = competition ? runReservationMb(competition, candidate.kind) : RUN_RESERVE_MB
      const admission = admitJob({
        needMb,
        reservedMb: workBudgetSnapshot().memoryMb + heldMb,
        usableMb,
        memAvailableMb: capacity.memAvailableMb == null ? null : capacity.memAvailableMb - admittedMb,
      })
      if (!admission.ok) {
        warnOnce(admission.reason === 'floor'
          ? `[competitions] free memory is below the safety floor for ${candidate.submissionId}`
          : `[competitions] resource reservations leave insufficient capacity for ${candidate.submissionId}`)
        break
      }
      let secretBytes = 0
      try { secretBytes = competitionsFs.statSync(path.join(secretDir(candidate.competitionId), SOLUTION_FILE)).size } catch { /* no solution */ }
      // A run on a hidden test composes its own data folder: hard links cost
      // nothing, but where the volume refuses them every file is copied.
      const sealedBytes = candidate.kind === 'notebook' ? sealedFileBytes(candidate.competitionId) : 0
      const inputsBytes = sealedBytes > 0 ? sealedBytes + openFileBytes(candidate.competitionId) : 0
      const release = reserveWork({ id: `competition:${newToken()}`, kind: 'competition', memoryMb: needMb,
        diskBytes: LIMITS.submissionBytes * 4 + secretBytes + inputsBytes },
      { availableMemoryMb: usableMb === null ? null : Math.max(0, usableMb - heldMb), availableDiskBytes })
      if (!release) {
        warnOnce(`[competitions] resource reservations leave insufficient capacity for ${candidate.submissionId}`)
        break
      }
      forgetWarning()
      const row = takeNext({ boot: BOOT, slots, gpu })
      if (!row) { release(); break }
      admittedMb += needMb
      started++
      const attemptId = row.attemptId!
      count('started')
      aborters.set(attemptId, new AbortController())
      const job = runJob(row).finally(() => {
        release()
        inFlight.delete(attemptId)
        aborters.delete(attemptId)
        count('completed')
        // A freed slot is filled at once, not at the next tick: with eight
        // slots and a queue of thirty, half a second per job adds up.
        wakeCompetitionPump()
      })
      inFlight.set(attemptId, job)
    }
  } finally {
    pumping = false
  }
  return started
}

/**
 * The runner cards for one pass of the pump (store.ts · QueueGpu).
 *
 * A GPU notebook needs a general slot AND a free share of a card, and the
 * queue passes it over while no share is free instead of waiting behind it:
 * CPU work flows past a GPU notebook that waits for a card, and the GPU
 * notebook waits for nothing else but a general slot (store.ts ·
 * selectNext). The cards are this machine's — the docker runner and its test
 * stand-in; each may hold `perDevice` runs, none while a class still holds it
 * or while docker cannot say who does (competitions/gpu.ts ·
 * runnerGpuState), what it holds already is weighed by the shares its runs
 * were taken at (gpu.ts · cardsInUse), and a container whose removal failed
 * still holds its share (Capacity.heldGpus).
 *
 * Under the cluster the queue keeps no card (Kubernetes schedules the Pod
 * onto a unit of its GPU resource, and a node without one sends the job back
 * as a `gpu` resource deferral), but it does keep to the number of GPU
 * notebooks the broker has units for (`clusterSlots`, gpu.ts ·
 * clusterGpuSlots): a GPU notebook taken past it held a general slot for the
 * half minute its Pod waited, came back to the head of the queue, and was
 * taken again — with 25 GPU notebooks waiting no CPU work got a slot for
 * hours. And once the cluster has sent one back for want of a unit, none is
 * taken until that one's backoff ends (or a GPU notebook of ours ends and
 * frees a unit): the cluster has said it has none now, and the CPU work goes
 * past in the meantime, as it does past a full card here.
 *
 * Without GPU work waiting there is no census at all: no cards to count, and
 * a GPU notebook that arrives during the pass simply waits for the next one,
 * a second away.
 */
async function queueCards(capacity: Capacity, clusterSlots: number): Promise<QueueGpu> {
  if (!runnerCardsHere()) return Date.now() < clusterGpuRestUntil ? { cards: [] } : { cards: [], cluster: clusterSlots }
  if (!cardWorkWaiting()) return { cards: [] }
  try {
    const state = await runnerGpuState()
    return { cards: state.cards, held: capacity.heldGpus ?? {} }
  } catch (error) {
    // No count, no card: the GPU work waits for the next pass, the rest goes on.
    warnOnce(`[competitions] runner cards could not be counted: ${error instanceof Error ? error.message : String(error)}`)
    return { cards: [] }
  }
}

/** Wait for everything running in this process. */
export function settleCompetitionWork(): Promise<void> {
  return Promise.all([...inFlight.values()]).then(() => undefined)
}

/**
 * Run the queue to the end and wait for it.
 *
 * For tests and the test stand: there is no second there to wait for the
 * timer, and what needs checking is exactly that the queue gets to the end by
 * itself.
 */
export async function drainCompetitionQueue(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const started = await pumpOnce()
    await settleCompetitionWork()
    if (started === 0 && inFlight.size === 0) {
      // Work may have appeared while the previous work ran (rescoring, a retry).
      if (waitingCount() === 0 || queuePaused()) return
    }
  }
}

/** Wake the pump — after an accepted submission, a lifted pause, a rescore. */
export function wakeCompetitionPump(): void {
  if (stopped || timer === null) return
  void pumpOnce()
}

const TICK_MS = 1_000

/**
 * Start the pump.
 *
 * Called once at process startup, after `reclaimCompetitionQueue`. A timer
 * rather than "wake only on an event": the queue has to be woken by freed
 * memory, by a pause lifted in a neighbouring tab, and by the end of someone
 * else's work — and a second of delay for a submission that runs for minutes
 * means nothing.
 */
export function startCompetitionPump(): void {
  if (timer) return
  stopped = false
  timer = setInterval(() => void pumpOnce(), TICK_MS)
  // The queue timer must not keep the process alive: it goes away with it.
  timer.unref?.()
  void pumpOnce()
  // The sweep of old submission files lives as long as the queue whose
  // files it sweeps, and starts after the reclaim that came before the pump
  // (housekeeping.ts).
  startSubmissionSweep()
}

/** Stop the pump and wait for what is running. No new work is taken after that. */
export async function stopCompetitionPump(): Promise<void> {
  stopped = true
  if (timer) clearInterval(timer)
  timer = null
  await stopSubmissionSweep()
  await settleCompetitionWork()
}

let warned = ''
function warnOnce(text: string): void {
  if (warned === text) return
  warned = text
  console.warn(text)
}
function forgetWarning(): void {
  warned = ''
}

/* -------------------------------------------------------------- at startup */

/**
 * Pick up what is left from the process's previous life.
 *
 * A "running" row with someone else's `boot` means exactly one thing: the
 * server was restarted while the submission was running. The container is
 * most likely gone already, but if it is there, its name lies next to it, and
 * whoever read it must take it down. Called ONCE, before the pump: two such
 * cleanups in a row would pick up the same work twice.
 */
export async function reclaimCompetitionQueue(): Promise<{
  requeued: number
  abandoned: number
  swept: number
}> {
  if (!(await competitionCapabilities()).execution.available) return { requeued: 0, abandoned: 0, swept: 0 }
  const orphans = orphanedRuns(BOOT)
  const { requeued, abandoned } = reclaimQueue(BOOT)
  const runner = competitionRunner()
  for (const row of orphans) {
    // Docker verifies recorded legacy ownership inside sweep before stopping it.
    if (row.container && runner.backend !== 'docker') await runner.kill(row.container).catch(() => undefined)
  }
  for (const row of requeued) {
    count('recovered')
    /*
     * The submission row is still "running" — it knows nothing about the
     * restart. Without this edit the participant would, until the work is
     * picked up again, watch a timer that does not move and a stage bar stuck
     * on "RUNNING NOTEBOOK".
     */
    updateSubmission(row.submissionId, { state: 'queued', stage: 'queue' })
  }
  const swept = await runner.sweep(orphans.flatMap((row) => row.container ? [row.container] : [])).catch(() => 0)
  for (const row of orphans) if (row.attemptId) {
    try { dropAttempt(row.competitionId, row.submissionId, row.attemptId) }
    catch { count('cleanupFailures'); console.warn('[competitions] orphan attempt cleanup failed', row.attemptId) }
  }
  if (requeued.length || abandoned.length || swept) {
    console.log(
      `[competitions] after restart: requeued ${requeued.length}, abandoned ${abandoned.length}, containers removed ${swept}`,
    )
  }
  return { requeued: requeued.length, abandoned: abandoned.length, swept }
}

/* -------------------------------------------------------------------- work */

async function runJob(row: QueueRow): Promise<void> {
  const submission = getSubmission(row.submissionId)
  const competition = submission ? getCompetition(submission.competitionId) : null
  if (!submission || !competition) {
    // The competition was deleted while the submission was waiting: there is
    // nothing to take down, and no reason to keep the row in the queue.
    finishQueueAttempt(row)
    return
  }
  /*
   * The answer key is snapshotted as of the moment the job starts, but copied
   * in the background while the notebook runs: it only has to be in place by
   * the time the metric runs, and a two-hundred-megabyte copy in front of the
   * notebook would be two hundred megabytes of everyone's queue. Resolves to
   * the copy's error, or null.
   */
  let secrets: Promise<unknown> = Promise.resolve(null)
  try {
    if (!ownsQueueAttempt(row)) return
    const provenance: AttemptProvenance = submissionUsesCurrentBase(competition, submission.id)
      ? { inputRevision: competition.inputRevision ?? 0, notebookInputRevision: competition.notebookInputRevision ?? 0 }
      : { inputRevision: null, notebookInputRevision: null }
    secrets = snapshotSecrets(competition, submission, row).then(() => null, (error: unknown) => error ?? new Error('Secret snapshot failed'))
    if (row.kind === 'metric') await scoreOnly(competition, submission, row, provenance, secrets)
    else await runNotebookThenScore(competition, submission, row, provenance, secrets)
    // A GPU notebook of ours ended under the cluster: its unit is free, and the next one may ask for it.
    if (row.kind === 'notebook' && competition.limits.gpu === true && !runnerCardsHere()) clusterGpuRestUntil = 0
  } catch (err) {
    if (err instanceof CompetitionResourcePending && ownsQueueAttempt(row)) {
      const reason=tr('competitions.runtime.resourcesWaiting')
      const after=deferResourceAttempt(row,reason,Date.now(),err.teacherReason,err.kind)
      if (after!==null) {
        updateSubmission(submission.id,{cellsDone:submission.cellsDone,cellsTotal:submission.cellsTotal,durationMs:submission.durationMs})
        // The cluster has no unit now: no GPU notebook asks again until this one may (queueCards).
        if (err.resource === 'gpu' && !runnerCardsHere()) clusterGpuRestUntil = Math.max(clusterGpuRestUntil, after)
        return
      }
    }
    /*
     * Only our own breakage ends up here — not a notebook crash and not a
     * metric crash, those have outcomes of their own. The participant is not
     * to blame for it, and the word `metricFailed` was chosen precisely for
     * that reason: they will read "the checking code crashed, the submission
     * will be rescored", not an accusation against their notebook.
     */
    console.error('[competitions] attempt failed', { attemptId: row.attemptId, submissionId: submission.id, inputRevision: competition.inputRevision }, err)
    if (ownsQueueAttempt(row)) updateSubmission(submission.id, {
      state: 'metricFailed',
      teacherError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    })
  } finally {
    if (finishQueueAttempt(row)) cancelled.delete(row.submissionId)
    // No copy may still be writing into the directory that is about to go.
    await secrets
    try { dropAttempt(competition.id, submission.id, row.attemptId!) } catch { count('cleanupFailures'); console.warn('[competitions] attempt cleanup failed', row.attemptId) }
  }
}

/** Step one and, if it succeeded, step two. */
async function runNotebookThenScore(competition: Competition, submission: Submission, row: QueueRow, provenance: AttemptProvenance, secrets: Promise<unknown>): Promise<void> {
  const runner = competitionRunner()
  const binding = getBinding(submission.id)
  const limits = limitsFor(competition, 'notebook')
  const container = containerName(submission.id, 'notebook', newToken())
  /*
   * The hidden test is read off the rows when the run starts: a file the
   * teacher adds a second later belongs to the next run, never half to this
   * one. Without hidden files nothing below changes: the open data/ is
   * mounted as it always was.
   */
  const sealedFiles = listFiles(competition.id, 'sealed').map((file) => file.name)
  const sealed = sealedFiles.length > 0
  const run = startRun({ submissionId: submission.id, kind: 'notebook', container, attemptId: row.attemptId!, inputRevision: provenance.inputRevision ?? undefined, sealedInputs: sealed })
  // The name also goes into the queue row: the container outlives the process
  // that started it, and taking it down after a restart will be the job of
  // another life of the server.
  noteQueueContainer(submission.id, container, row.attemptId!)
  updateSubmission(submission.id, {
    state: 'running',
    stage: binding?.bundle ? 'dependencies' : 'notebook',
    cellsDone: 0,
    participantError: null,
    teacherError: null,
    briefError: null,
    errorType: null,
  })

  const input = inputDir(competition.id, submission.id)
  /*
   * With a hidden test the run gets a data folder of its own, composed from
   * the open files with the hidden ones swapped in; it goes with the attempt
   * (dropAttempt). A hidden file gone from disk throws here, and runJob writes
   * the outcome as our breakage rather than scoring the example.
   */
  const data = sealed
    ? await composeRunInputs(competition.id, submission.id, row.attemptId!, {
        open: listFiles(competition.id, 'open').map((file) => file.name),
        sealed: sealedFiles,
      })
    : openDir(competition.id)
  const result = attemptDir(competition.id, submission.id, row.attemptId!)
  if (runner.backend !== 'test') {
    letContainerRead(data)
    letContainerRead(input)
  }
  /*
   * On the hidden test every number the notebook reports about itself is
   * clamped to the notebook that was sent: run.json and progress.json live
   * where the participant's code can write, and "cell 48213 of 99999" is a
   * channel for whatever the code read. Null without a hidden test: the
   * numbers stay exactly what they were.
   */
  const codeCells = sealed ? codeCellsIn(input) : null

  let dependenciesDir: string | undefined
  let preflightError: unknown = null
  /*
   * A set that cannot fit this submission's memory is refused before any
   * container, whichever runner it is: it was attached while it fit
   * (dependencies/store.ts · assertUsableBundle), and the teacher has lowered
   * the memory since. Installing it would only fail inside the run.
   */
  const bundle = binding?.bundle ?? null
  const unfit: Extract<DependencyFailure, { reason: 'memory' }> | null = bundle && !packagesFit(bundle.installedBytes, competition.limits.memoryMb)
    ? { reason: 'memory', bytes: packagesRoomMb(bundle.installedBytes) * MB, limitBytes: competition.limits.memoryMb * MB }
    : null
  if (runner.backend !== 'test' && !unfit) {
    try {
      if (!binding?.revision) throw new Error('This legacy submission has no available pinned environment. Submit the notebook again.')
      if (binding.bundle) {
        const lock = lockOf(binding.bundle.id)
        if (lock === null) throw new Error('Dependency set is no longer ready')
        dependenciesDir = await verifyBundleFiles(binding.bundle, lock)
      }
    } catch (error) { preflightError = error }
  }
  // Read before the cancellation check, like the set's hash: a card nobody
  // has asked about yet takes a few seconds to say its size.
  const gpu = unfit || preflightError ? undefined : await runGpu(row, competition)
  // Hashing a large set yields to cancellation before any container exists.
  if (!ownsQueueAttempt(row) || takeCancellation(submission.id, 0)) {
    finishRun(run.id, { finishedAt: Date.now(), verdict: 'exit', cellsDone: 0, cellsTotal: 0,
      teacherError: 'Cancelled before container start' })
    return
  }
  // After the cancellation, which outranks it: a cancelled run is not put back in the queue.
  const withdrawn = takenBack(gpu)
  if (withdrawn !== null) {
    discardUnstartedRun(run.id, row.attemptId!)
    throw new CardWithdrawn(withdrawn)
  }
  let outcome: RunOutcome
  try { outcome = unfit ? {
    status: 'dependency_error', cell: -1, cells: 0, wall: 0, submission: null,
    detail: `Package set room of ${unfit.bytes / MB} MiB exceeds half of the submission's ${competition.limits.memoryMb} MiB memory`,
    log: '', dependencyFailure: unfit,
    diagnostics: { exit: null, oomKilled: false, backend: runner.backend },
  } : preflightError ? {
    status: 'dependency_error', cell: -1, cells: 0, wall: 0, submission: null,
    detail: preflightError instanceof Error ? preflightError.message : String(preflightError), log: '',
    diagnostics: { exit: null, oomKilled: false, backend: runner.backend },
  } : await runner.run({
    imageDigest: binding?.revision?.imageDigest,
    dependenciesDir,
    // The set's own room, sized for it; the runner mounts it only with a set.
    packagesMb: dependenciesDir && bundle ? packagesRoomMb(bundle.installedBytes) : undefined,
    competition,
    submissionId: submission.id,
    attemptId: row.attemptId!,
    signal: aborters.get(row.attemptId!)?.signal,
    container,
    dataDir: data,
    ...(sealed ? { sealedInputs: true } : {}),
    inputDir: input,
    resultDir: result,
    limits,
    ...(gpu ? { gpu } : {}),
    onProgress: (progress) => {
      if (!ownsQueueAttempt(row)) return
      const seen = codeCells === null ? progress : clampCells(progress, codeCells)
      updateSubmission(submission.id, {
        stage: progress.phase === 'dependencies' ? 'dependencies' : 'notebook',
        cellsDone: seen.cell + 1,
        cellsTotal: seen.cells,
      })
    },
  }) } catch(error) {
    if(error instanceof CompetitionResourcePending)discardUnstartedRun(run.id,row.attemptId!)
    throw error
  }
  const endedAt = Date.now()
  // Said at once, before anything below waits: a neighbour on the card may be waiting to learn it (neighbourOverran).
  const stoppedBy = outcome.diagnostics.killedBy
  if ((stoppedBy === 'gpu' || stoppedBy === 'gpu-unread') && gpu?.device) noteShareKill(gpu.device, endedAt, stoppedBy)
  if (codeCells !== null) outcome = { ...clampCells(outcome, codeCells), diagnostics: { ...outcome.diagnostics, peakBytes: null } }
  // One text for the run row and the submission row. Where packages come from
  // is read only for a failed cell: that is the one outcome a missing module
  // explains.
  const participantError = notebookNote(outcome, competition,
    outcome.status === 'cell_error' ? packageSources(competition, submission, binding) : null, gpu)
  const errorType = outcome.status === 'cell_error' && outcome.diagnostics.killedBy !== 'output' ? errorTypeOf(outcome.detail) : null
  const briefError = sealed ? briefNote(outcome, competition, errorType, gpu) : null
  const teacherError = teacherNote(outcome, gpu)
  finishRun(run.id, {
    finishedAt: Date.now(),
    verdict: outcome.status,
    exitCode: outcome.diagnostics.exit,
    oom: outcome.diagnostics.oomKilled,
    cellsDone: outcome.cell + 1,
    cellsTotal: outcome.cells,
    participantError,
    teacherError,
  })

  if (!ownsQueueAttempt(row) || takeCancellation(submission.id, outcome.wall)) return
  /*
   * Torch ran out of video memory on a shared card while the watchdog was
   * stopping a neighbour on the same card for going past its share: the
   * neighbour's burst took the memory this run was promised, in the seconds
   * the watchdog needs for its two samples. That is not this notebook's
   * failure, and judging it one told the participant to shrink a model that
   * fit. So the run goes back to the queue, once (a second time it is judged
   * like any other), with our own words, and counts toward nothing.
   */
  if (gpu?.device && gpu.perDevice > 1 && errorType === 'OutOfMemoryError' && row.resourceRetries === 0
    && await neighbourOverran(row, gpu.device, endedAt)) {
    if (!ownsQueueAttempt(row) || takeCancellation(submission.id, outcome.wall)) return
    const retried = deferResourceAttempt(row, tr('competitions.answer.gpuNeighbourRetry'), Date.now(),
      tr('competitions.answer.gpuNeighbourRetryTeacher', { device: gpu.device }))
    if (retried !== null) {
      updateSubmission(submission.id, { cellsDone: submission.cellsDone, cellsTotal: submission.cellsTotal, durationMs: submission.durationMs })
      return
    }
  }
  publishAttemptArtifacts(competition.id, submission.id, result)
  if (outcome.status !== 'ok') {
    updateSubmission(submission.id, {
      state: stateOfVerdict('notebook', outcome.status),
      stage: outcome.status === 'dependency_error' ? 'dependencies' : outcome.status === 'no-submission' ? 'check' : 'notebook',
      durationMs: outcome.wall,
      cellsDone: outcome.cell + 1,
      cellsTotal: outcome.cells,
      participantError,
      briefError,
      errorType,
      teacherError,
    })
    return
  }

  /*
   * The "CHECKING CSV" stage is not decoration of the bar. Between "the
   * notebook ran" and "the metric scored" lies the one thing participants
   * forget most often: writing the answer. As a separate stage they see where
   * exactly it broke off.
   */
  updateSubmission(submission.id, {
    stage: 'check',
    cellsDone: outcome.cell + 1,
    cellsTotal: outcome.cells,
  })
  const answer = answerIn(result)
  if (typeof answer === 'string') {
    updateSubmission(submission.id, {
      state: 'rejected',
      stage: 'check',
      durationMs: outcome.wall,
      participantError: answer,
      // Our own words about the file, nothing read from it: safe to show blind.
      briefError: sealed ? answer : null,
    })
    return
  }
  updateSubmission(submission.id, { notebookInputRevision: provenance.notebookInputRevision })
  promoteAttempt(competition.id, submission.id, result)
  await scoreStep(competition, submission, path.join(resultDir(competition.id, submission.id), SUBMISSION_FILE), outcome.wall, outcome, row, provenance, secrets, sealed)
}

/**
 * The card a notebook run is given (RunRequest.gpu); `undefined` — the CPU.
 *
 * On this machine's cards it is the one the queue took for the attempt
 * (QueueRow.gpu), with the share promised on THAT card: the panel promises
 * the smallest card's share, and a run on a bigger card gets its bigger one.
 * The share is the one the row was taken at (QueueRow.gpuPerDevice), never
 * the number in force: the queue admitted the run by it, and an owner who
 * changed «посылок на карту» a second after the take must not hand this run
 * a share its card has no room for, or a whole uncapped card next to capped
 * neighbours. What it comes to in MB goes back into the row for the console.
 *
 * Under the cluster the queue holds no card, and a GPU notebook carries
 * CLUSTER_GPU: the Pod asks the cluster for a unit of its GPU resource. A
 * rescore never gets here with one, and the metric step after the notebook
 * never asks (scoreStep): it holds the hidden answers.
 */
async function runGpu(row: QueueRow, competition: Competition): Promise<RunRequest['gpu']> {
  if (row.gpu) {
    const perDevice = row.gpuPerDevice ?? runnerGpuPerDevice()
    const sliceMb = await gpuSliceFor(row.gpu, { perDevice })
    noteQueueGpuShare(row, sliceMb)
    return { device: row.gpu, sliceMb, perDevice }
  }
  if (!runnerCardsHere() && row.kind === 'notebook' && competition.limits.gpu === true) return { ...CLUSTER_GPU }
  return undefined
}

/**
 * The card of a run about to start that the owner has taken back from
 * submissions since the queue took it; `null` — none: the card is still
 * given, the run has no card, or it has the cluster's.
 *
 * Asked once more right before `docker run`, after the slow part: the card's
 * size (runGpu) takes seconds on a card nobody has asked about, and before it
 * the run's inputs were composed and its package set hashed. An owner who
 * gave the card back to classes in between gave it to a class that needs it
 * now. The rooms keep off a card a running row holds (kernel/pool.ts ·
 * takeGpu), so a run started on it anyway kept the card from that class for
 * the run's whole time limit, for a run that had not begun. Instead the run
 * goes back to the queue for a card still given (CardWithdrawn), and the
 * card is the classes' at once.
 */
function takenBack(gpu: RunRequest['gpu']): string | null {
  return gpu?.device && !runnerGpuDevices().includes(gpu.device) ? gpu.device : null
}

/**
 * A GPU notebook whose card the owner took back from submissions between the
 * queue's take and `docker run` (takenBack). A resource deferral, like a Pod
 * the cluster could not place (runJob · deferResourceAttempt): no run began,
 * the card goes with the attempt, and the row waits for a card still given,
 * counting toward nothing. The participant reads the queue's usual words
 * about resources; the teacher reads ours, which name the card — not the
 * cluster's "Pod unschedulable", which on this machine would be untrue.
 */
class CardWithdrawn extends CompetitionResourcePending {
  constructor(readonly device: string) {
    super('gpu', 'notebook')
  }

  override get teacherReason(): string {
    return tr('competitions.answer.gpuWithdrawnTeacher', { device: this.device })
  }
}

/**
 * How close, either way, the watchdog's kill of a neighbour and a run's
 * out-of-memory on the same card must be for the second to be the first's
 * doing. The watchdog stops a run only on its second sample over the line,
 * three seconds apart and up to five each (docker-runner.ts · VramWatch), and
 * both runs then take a few seconds to end and be collected.
 */
export const NEIGHBOUR_WINDOW_MS = 20_000

/**
 * The same after the stop of a neighbour whose card could not be read
 * (`gpu-unread`, docker-runner.ts · VRAM_UNREAD_LIMIT). Such a run held
 * memory nobody saw for as long as its unanswered samples took — up to about
 * twenty-five seconds, each given up at its five-second deadline on the
 * three-second cycle, against the three to six of two samples over the line.
 * Its burst may come at the start of that stretch and its stop at the end, so
 * the stop may land that much later after the run it crowded out: fifteen
 * seconds more. It is also how long a run that ran out of memory beside a
 * neighbour still on the card waits to learn whether that neighbour is
 * stopped (neighbourVerdict) — fifteen seconds longer than before for an
 * out-of-memory that turns out to be its own, which nothing on this side can
 * tell from a neighbour's in advance. That is the price of not billing the
 * participant for a card a run nobody could read had taken.
 */
export const UNREAD_NEIGHBOUR_WINDOW_MS = NEIGHBOUR_WINDOW_MS + 15_000

/** A neighbour stopped from outside: when, and how long after a run's end the stop may still be that run's cause. */
export interface NeighbourStop {
  at: number
  windowMs: number
}

/**
 * A run stopped from outside at `at`, as the runs beside it on its card are
 * judged against it: for going past its share (`gpu`), or because its card
 * could not be read (`gpu-unread`). Both count. A run whose memory nobody
 * could read may have held any of the card meanwhile — the fail-closed rule
 * exists for a notebook that keeps itself unreadable to take the card — and a
 * neighbour that ran out of memory then was crowded out by it as surely as by
 * a burst the watchdog saw; only later, by the length of its unread stretch.
 */
export function neighbourStop(at: number, by: 'gpu' | 'gpu-unread'): NeighbourStop {
  return { at, windowMs: by === 'gpu-unread' ? UNREAD_NEIGHBOUR_WINDOW_MS : NEIGHBOUR_WINDOW_MS }
}

/** The stops of runs on each card, by device; only the recent ones are kept. */
const shareKills = new Map<string, NeighbourStop[]>()

function noteShareKill(device: string, at: number, by: 'gpu' | 'gpu-unread'): void {
  const recent = (shareKills.get(device) ?? []).filter((stop) => at - stop.at <= 3 * UNREAD_NEIGHBOUR_WINDOW_MS)
  recent.push(neighbourStop(at, by))
  shareKills.set(device, recent)
}

/**
 * Pure: whether a run that died of torch's out-of-memory at `endedAt` on a
 * shared card, taken at `startedAt`, was crowded out by a neighbour's stop
 * (`crowded`), may still learn of one (`wait`: another run `stays` on the
 * card, and a stop could yet land within its window), or died of its own
 * (`own`). A stop counts when it came while this run ran — one before it was
 * taken freed the memory before it asked for any — at most
 * NEIGHBOUR_WINDOW_MS before its end and at most the stop's own window after.
 */
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
 * Whether a run that died of torch's out-of-memory at `endedAt` on a shared
 * card died of a neighbour (neighbourVerdict). The stop may land after the
 * victim has already failed — its cudaMalloc fails during the burst, and the
 * burst is stopped only on the second sample over the line, or after the last
 * of VRAM_UNREAD_LIMIT unanswered ones — so while another run is still on the
 * card this waits for it: up to the longest window, and no longer than that
 * run stays (a neighbour that ends of its own accord was not stopped).
 */
async function neighbourOverran(row: QueueRow, device: string, endedAt: number): Promise<boolean> {
  const signal = aborters.get(row.attemptId!)?.signal
  const run = { startedAt: row.startedAt ?? 0, endedAt }
  for (;;) {
    const stays = runningRows().some((other) => other.gpu === device && other.submissionId !== row.submissionId)
    const verdict = neighbourVerdict(shareKills.get(device) ?? [], run, Date.now(), stays)
    if (verdict !== 'wait') return verdict === 'crowded'
    if (stopped || signal?.aborted) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * The code cells of the sent notebook — what the harness counts as "cells"
 * (harness.ts · cells_total), read from the notebook we stored ourselves, not
 * from anything the run reported. Zero when it does not parse (the door
 * refuses such a notebook, so only a file swept from under the run gets
 * here), and then nothing can be vouched for: every count is clamped to none.
 */
function codeCellsIn(input: string): number {
  try {
    const book: unknown = JSON.parse((competitionsFs.readFileSync(path.join(input, NOTEBOOK_FILE)) as Buffer).toString('utf8'))
    return (notebookCellList(book) ?? []).filter((cell) => (cell as { cell_type?: unknown })?.cell_type === 'code').length
  } catch {
    return 0
  }
}

/** A reported position held to the cells the notebook really has: -1 (none run) to its last. */
export function clampCells<T extends { cell: number; cells: number }>(reported: T, codeCells: number): T {
  const cell = Number.isFinite(reported.cell) ? Math.trunc(reported.cell) : -1
  return { ...reported, cell: Math.max(-1, Math.min(cell, codeCells - 1)), cells: codeCells }
}

/**
 * Where the collected answer lies — or a string explaining to the participant
 * why there is none.
 *
 * Empty and too big are kept apart on purpose: "file not written" and "an
 * 80-megabyte file" are two different conversations, and a participant who
 * read the first instead of the second will look for the mistake in the wrong
 * place.
 *
 * Only looked at, never read: the answer moves to the submission by rename
 * and into the metric's directory by a streamed copy, so up to 64 MB of it
 * never sit in this process's memory or on its event loop.
 */
function answerIn(directory: string): { file: string } | string {
  const file = path.join(directory, SUBMISSION_FILE)
  let info: fs.Stats
  try {
    info = competitionsFs.statSync(file)
  } catch {
    return tr('competitions.answer.noFile', { file: SUBMISSION_FILE })
  }
  if (!info.isFile()) return tr('competitions.answer.unreadable', { file: SUBMISSION_FILE })
  if (info.size > LIMITS.submissionBytes) {
    return tr('competitions.answer.tooLarge', {
      file: SUBMISSION_FILE,
      count: Math.round(LIMITS.submissionBytes / MB),
    })
  }
  return { file }
}

/** Rescoring: the metric over the stored answer, without executing the notebook again. */
async function scoreOnly(competition: Competition, submission: Submission, row: QueueRow, provenance: AttemptProvenance, secrets: Promise<unknown>): Promise<void> {
  const answer = answerIn(resultDir(competition.id, submission.id))
  if (typeof answer === 'string') {
    /*
     * There is nothing to rescore: the answer left the disk (cleanup of old
     * submissions) or never existed. We do not run the notebook a second time
     * — that is a separate action with a separate button; here it is more
     * honest to tell the teacher that the submission dropped out of the
     * rescoring.
     */
    updateSubmission(submission.id, {
      state: 'metricFailed',
      stage: 'check',
      teacherError: tr('competitions.answer.gone', { file: SUBMISSION_FILE }),
    })
    return
  }
  updateSubmission(submission.id, {
    state: 'running',
    stage: 'score',
    participantError: null,
    teacherError: null,
  })
  // The stored answer was made on the hidden test if any run of this
  // submission read it: a rescore cleans the metric's words the same way.
  await scoreStep(competition, submission, answer.file, submission.durationMs ?? 0, null, row, provenance, secrets, !!submission.sealedInputs)
}

/** Step two: the teacher's metric in the second disposable container. */
async function scoreStep(
  competition: Competition,
  submission: Submission,
  answerFile: string,
  notebookWall: number,
  notebook: RunOutcome | null,
  row: QueueRow,
  provenance: AttemptProvenance,
  snapshot: Promise<unknown>,
  /** The answer was made on the hidden test: what the participant may read is cleaned (sealedMetricNote). */
  sealed = false,
): Promise<void> {
  const runner = competitionRunner()
  updateSubmission(submission.id, { stage: 'score' })
  // The answer key's background copy must be whole before the metric may see it.
  const snapshotFailed = await snapshot
  if (snapshotFailed) throw snapshotFailed

  const imageDigest = getBinding(submission.id)?.revision?.imageDigest
  if (runner.backend !== 'test' && !imageDigest) {
    updateSubmission(submission.id, {
      state: 'metricFailed', stage: 'score', durationMs: notebookWall,
      teacherError: 'This legacy submission has no pinned environment. Submit the notebook again before scoring.',
    })
    return
  }

  const secrets = attemptDir(competition.id, submission.id, row.attemptId!, 'secret')
  const missing = !competition.metric.code.trim() ? tr('competitions.answer.noMetric') :
    !competitionsFs.existsSync(path.join(secrets, SOLUTION_FILE)) ? tr('competitions.answer.noSolution', { file: SOLUTION_FILE }) : null
  if (missing) {
    updateSubmission(submission.id, {
      state: 'metricFailed',
      stage: 'score',
      durationMs: notebookWall,
      teacherError: missing,
    })
    return
  }

  const container = containerName(submission.id, 'metric', newToken())
  const run = startRun({ submissionId: submission.id, kind: 'metric', container, attemptId: row.attemptId!, inputRevision: provenance.inputRevision ?? undefined })
  noteQueueContainer(submission.id, container, row.attemptId!)

  // The answer moves into its own, NEW directory: the metric container must
  // see neither the participant's executed notebook nor its output. The
  // directory for the metric's answer is a separate, NEIGHBOURING one: one and
  // the same path mounted both read-only and writable would hand the answer's
  // size to the watchdog as "the metric writes to disk".
  const scoreInput = attemptDir(competition.id, submission.id, row.attemptId!, 'score')
  await copyCompetitionFile(answerFile, path.join(scoreInput, SUBMISSION_FILE))
  const outDir = attemptDir(competition.id, submission.id, row.attemptId!, 'score-out')
  if (runner.backend !== 'test') {
    letContainerRead(secrets)
    letContainerRead(scoreInput)
  }

  let outcome: ScoreOutcome
  try {
    outcome = await runner.score({
      imageDigest,
      competition,
      submissionId: submission.id,
      container,
      attemptId: row.attemptId!,
      signal: aborters.get(row.attemptId!)?.signal,
      secretDir: secrets,
      submissionDir: scoreInput,
      outDir,
      limits: limitsFor(competition, 'metric'),
    })
  } catch(error) {
    if(error instanceof CompetitionResourcePending)discardUnstartedRun(run.id,row.attemptId!)
    throw error
  } finally {
    /*
     * The second copy of the answer and the metric's json live exactly for
     * the duration of scoring. Keeping them longer means storing every answer
     * twice: in a competition of three hundred submissions that is gigabytes
     * nobody reads. Rescoring creates the directory anew — and it has to be a
     * new one.
     */
    try {
      competitionsFs.rmSync(scoreInput, { recursive: true, force: true })
      competitionsFs.rmSync(outDir, { recursive: true, force: true })
    } catch { count('cleanupFailures'); console.warn('[competitions] score cleanup failed', row.attemptId) }
  }
  const state = stateOfVerdict('metric', outcome.status)
  const participant = metricNote(outcome)
  const brief = sealed ? sealedMetricNote(outcome) : null
  finishRun(run.id, {
    finishedAt: Date.now(),
    verdict: outcome.status,
    exitCode: outcome.diagnostics.exit,
    oom: outcome.diagnostics.oomKilled,
    publicScore: outcome.public,
    privateScore: outcome.private,
    participantError: participant,
    teacherError: outcome.teacherOnly,
  })
  if (!ownsQueueAttempt(row) || takeCancellation(submission.id, notebookWall + outcome.wall)) return

  updateSubmission(submission.id, {
    state,
    stage: 'score',
    durationMs: notebookWall + outcome.wall,
    inputRevision: provenance.inputRevision,
    publicScore: state === 'scored' ? outcome.public : null,
    privateScore: state === 'scored' ? outcome.private : null,
    participantError: participant,
    briefError: brief,
    teacherError: outcome.teacherOnly,
    ...(notebook ? { cellsDone: notebook.cell + 1, cellsTotal: notebook.cells } : {}),
  })
}

/**
 * Put the answers and the metric code into the attempt's own directory.
 *
 * The metric code is put on disk EVERY time, and that is cheaper than any
 * attempt to guess whether it changed: the teacher edits the metric exactly
 * when it has failed, and a submission rescored with the old code would look
 * like an unfixed error. We write the file INSIDE the mounted directory
 * rather than mounting the file itself — that is exactly why overwriting is
 * safe (see the header of storage.ts about virtiofs).
 *
 * The directory and the metric are written right away, and a failure there
 * fails the job before its notebook runs; the answer key's copy is returned
 * as a promise. Its source is opened here, synchronously, so the snapshot is
 * the file as it was when the job started — a new answer key replaces the
 * name, not these bytes (storage.ts · putSecretFile).
 */
function snapshotSecrets(competition: Competition, submission: Submission, row: QueueRow): Promise<void> {
  const directory = attemptDir(competition.id, submission.id, row.attemptId!, 'secret')
  competitionsFs.writeFileSync(path.join(directory, METRIC_NAME), Buffer.from(`${competition.metric.code}\n`), { mode: 0o600 })
  const solution = path.join(secretDir(competition.id), SOLUTION_FILE)
  return competitionsFs.existsSync(solution) ? copyCompetitionFile(solution, path.join(directory, SOLUTION_FILE)) : Promise.resolve()
}

/**
 * The submission was ordered to be taken down — record that and leave.
 *
 * Checked AFTER the step, not before: the container is already killed, the
 * work is over, and the only thing left is not to write "time ran out" to the
 * participant for having pressed "Cancel" themselves.
 */
function takeCancellation(submissionId: string, durationMs: number): boolean {
  const by = cancelled.get(submissionId)
  if (!by) return false
  cancelled.delete(submissionId)
  updateSubmission(submissionId, {
    state: 'cancelled',
    durationMs,
    participantError: null,
    teacherError: tr(by === 'teacher' ? 'competitions.answer.killedByTeacher' : 'competitions.answer.killedByEntrant'),
  })
  return true
}

/* ------------------------------------------------------------------ words */

const MB = 1024 * 1024

/**
 * What the PARTICIPANT reads about a failed notebook.
 *
 * The traceback of the failed cell goes to them verbatim: they wrote it, and
 * "error in the notebook" without a single line of cause is a refusal that
 * sends them to the teacher. Everything else is our words, and they name a
 * number: "did not fit into 10 minutes" is more useful than "time limit".
 *
 * One more sentence of ours may follow the traceback: when the cell died on
 * a missing module, it says what only the platform knows (missingPackageHint),
 * and when torch ran out of video memory on a card, the share the run had
 * (gpuMemoryHint). `sources` is where the submission's packages could come
 * from; without it the traceback goes alone. `gpu` is the card the run was
 * given: a run stopped for its share of the card is told so in numbers
 * (gpuKillNote).
 */
export function notebookNote(outcome: RunOutcome, competition: Competition, sources: PackageSources | null = null, gpu: RunRequest['gpu'] | null = null): string | null {
  const at = outcome.cell + 1
  switch (outcome.status) {
    case 'ok':
      return null
    case 'dependency_error': {
      // "Try again" is the answer to a hiccup, not to a set that cannot fit.
      const failure = outcome.dependencyFailure
      if (failure?.reason === 'memory') {
        return dependencyMessage('dependency_memory', { bytes: failure.bytes, limitBytes: failure.limitBytes })
      }
      if (failure?.reason === 'no_space') return tr('dependencies.error.noSpace', { room: dependencySize(failure.roomBytes) })
      return tr('dependencies.error.install')
    }
    case 'cell_error': {
      if (outcome.diagnostics.killedBy === 'output') {
        return tr('competitions.answer.tooMuchOutput', {
          count: Math.round((outcome.diagnostics.peakBytes ?? 0) / MB) || 64,
          cell: at,
        })
      }
      const head = tr('competitions.answer.cellFailed', { cell: at, cells: outcome.cells })
      if (!outcome.detail) return head
      // One hint at most: a missing module and torch's out-of-memory are different last lines.
      const hint = missingPackageHint(outcome.detail, sources) ?? gpuMemoryHint(errorTypeOf(outcome.detail), gpu)
      return withinLimit(head, outcome.detail, hint)
    }
    case 'cell_timeout':
    case 'timeout':
      // cell_timeout is the harness stopping the notebook itself, a few
      // seconds before the host's deadline so that its output is saved
      // (harness.ts · STOP_EARLY), and the words say so: unsaid, a run
      // stopped at 118 s of 120 read as a limit shorter than the stated one.
      // A timeout is the host's kill at the deadline itself, and nothing
      // about it was early.
      return tr(outcome.status === 'cell_timeout' ? 'competitions.answer.timeoutEarly' : 'competitions.answer.timeout', {
        count: Math.max(1, Math.round(competition.limits.wallSeconds / 60)),
        cell: at,
        cells: outcome.cells,
      })
    case 'out-of-memory':
      return gpuKillNote(outcome, gpu) ?? tr('competitions.answer.outOfMemory', {
        count: Math.max(1, Math.round(competition.limits.memoryMb / 1024)),
        cell: at,
      })
    case 'kernel_died':
      return tr('competitions.answer.kernelDied', { cell: at })
    case 'exit':
      return tr('competitions.answer.exited', { cell: at })
    case 'target_too_large':
      return tr('competitions.answer.tooLarge', {
        file: SUBMISSION_FILE,
        count: Math.round(LIMITS.submissionBytes / MB),
      })
    case 'target_unreadable':
      return outcome.detail
        ? `${tr('competitions.answer.unreadable', { file: SUBMISSION_FILE })}\n\n${outcome.detail}`
        : tr('competitions.answer.unreadable', { file: SUBMISSION_FILE })
    case 'no-submission':
      return tr('competitions.answer.noFile', { file: SUBMISSION_FILE })
    default:
      // harness_error and unknown: the harness is to blame, not the
      // participant. They will see the sentence about the crashed checking
      // code, and the teacher will do the investigating.
      return null
  }
}

/**
 * Our sentence, the traceback and the hint, within what the row keeps.
 *
 * The store cuts `participantError` at LIMITS.participantError from the END,
 * while the harness hands over up to twice that (harness.ts ·
 * cell_error_detail). Left to the store, a long traceback lost its last line
 * — the exception itself — and would lose the hint after it. So the
 * traceback gives way from its start, where nbclient repeats the cell's
 * source, by whole lines, and the sentences around it stay whole.
 */
function withinLimit(head: string, detail: string, hint: string | null): string {
  const tail = hint ? `\n\n${hint}` : ''
  const room = LIMITS.participantError - head.length - 2 - tail.length
  if (detail.length <= room) return `${head}\n\n${detail}${tail}`
  // Two characters go to the "…\n" that marks the cut.
  const kept = detail.slice(detail.length - Math.max(0, room - 2))
  const line = kept.indexOf('\n')
  // Without a line break to cut at, a half of a surrogate pair must not lead.
  return `${head}\n\n…\n${line >= 0 ? kept.slice(line + 1) : kept.replace(/^[\uDC00-\uDFFF]/, '')}${tail}`
}

/**
 * Where a submission's packages could come from — what the sentence after a
 * missing module is chosen by.
 */
export interface PackageSources {
  /** The competition lets participants prepare their own package sets. */
  ownPackages: boolean
  /** Distributions of the set attached to this submission; null — none attached. */
  attached: readonly string[] | null
  /** Distributions the pinned base environment already has. */
  base: readonly string[]
}

/**
 * The sources of THIS submission.
 *
 * Null for the sample notebook: it is the teacher's, it never carries a set,
 * and "attach a set" or "contact your teacher" are sentences for a student.
 * Null, too, if anything here fails: the hint is a courtesy, and a throw from
 * here would turn the participant's failed cell into our breakage (runJob
 * writes `metricFailed` for whatever escapes a step).
 */
function packageSources(competition: Competition, submission: Submission, binding: SubmissionBinding | null): PackageSources | null {
  if (submission.id === competition.baselineSubmissionId || submission.entrantId === competition.baselineEntrantId) return null
  try {
    return {
      ownPackages: policyOf(competition.id).enabled,
      attached: binding?.bundle ? binding.bundle.packages.map((one) => one.name) : null,
      base: binding?.revision?.packages.map((one) => one.name) ?? [],
    }
  } catch {
    return null
  }
}

/**
 * The module a failed cell could not import, or null.
 *
 * Read off the traceback's LAST line: that is the exception the cell died of
 * (nbclient's text ends with it, and cell_error_detail keeps the tail), while
 * the same words higher up may be the cell's own printing. A dotted name is
 * left alone: Python names the first piece it could not find, so
 * `sklearn.externals` means scikit-learn IS there and a submodule is not — a
 * version mismatch or a typo, and "install the package" would be untrue.
 */
export function missingModule(detail: string): string | null {
  const last = detail.trimEnd().split('\n').pop()?.trim() ?? ''
  const found = /^(?:ModuleNotFoundError|ImportError): No module named '([A-Za-z_][A-Za-z0-9_]{0,99})'/.exec(last)
  return found ? found[1] : null
}

/**
 * Import names whose distribution is called otherwise.
 *
 * Only those a data class meets and where there is one answer: `import
 * sklearn` is scikit-learn and nothing else. Any other module is named as it
 * is — pip reads `_` and `-` alike, so for most that name is already right,
 * and a guessed one would send the student to install something else.
 * `umap` is here because the PyPI project of that name is a different one.
 *
 * `cv2` is the HEADLESS build on purpose: the kernel image has no libGL, and
 * the desktop opencv-python dies on `import cv2` with a missing shared
 * library — a student who followed the hint would get a stranger error than
 * the one they came with.
 */
const PACKAGE_OF_MODULE: Readonly<Record<string, string>> = {
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  cv2: 'opencv-python-headless',
  PIL: 'pillow',
  yaml: 'pyyaml',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  imblearn: 'imbalanced-learn',
  skopt: 'scikit-optimize',
  umap: 'umap-learn',
}

export function packageOfModule(imported: string): string {
  return Object.hasOwn(PACKAGE_OF_MODULE, imported) ? PACKAGE_OF_MODULE[imported] : imported
}

/** One distribution under different spellings (PEP 503): `Scikit_Learn` is scikit-learn. */
const distributionKey = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')

/**
 * What the platform adds to a traceback that ends in a missing module, or
 * null.
 *
 * The traceback says `No module named 'lightgbm'` and nothing more, while the
 * cause is outside the notebook: the check runs without network, so a
 * `!pip install` at the top failed quietly and the notebook went on to die at
 * the import. The way out depends on the competition, hence three sentences.
 * Turned-off own packages go first: a set prepared before the teacher turned
 * them off can still be attached, but no new one can be made, and "add it to
 * your set" would be advice nobody can follow.
 *
 * Silent when the package is in fact there, in the base or in the attached
 * set: the import then failed for another reason, and "it is not on the
 * server" would send the student after the wrong problem.
 */
export function missingPackageHint(detail: string, sources: PackageSources | null): string | null {
  if (!sources) return null
  const imported = missingModule(detail)
  if (!imported) return null
  const name = packageOfModule(imported)
  const key = distributionKey(name)
  const holds = (names: readonly string[] | null) => !!names?.some((one) => distributionKey(one) === key)
  if (holds(sources.base) || holds(sources.attached)) return null
  if (!sources.ownPackages) return tr('competitions.answer.missingPackage.askTeacher', { name })
  return sources.attached
    ? tr('competitions.answer.missingPackage.notInSet', { name })
    : tr('competitions.answer.missingPackage.attach', { name })
}

/**
 * "6", "7,1": a share or a peak in gigabytes to a tenth — what a person
 * compares at a glance, in the instance's own decimal separator.
 */
const gigabytes = (mb: number): string => formatNumber(Math.round(mb / 102.4) / 10)

/**
 * What the PARTICIPANT reads about a run stopped for its share of a card;
 * `null` — the run was not stopped for that (any other out-of-memory is the
 * machine's memory, and keeps its own sentence).
 *
 * Our own words and our own numbers: the share is the card's memory over the
 * runs sharing it, and the peak is what the watchdog read from outside the
 * notebook (docker-runner.ts · VramWatch). Neither a traceback nor anything
 * the notebook printed — there is none: it was killed from outside. `brief`
 * leaves the peak out. Under the brief output policy how far past its share
 * a run went is a number the notebook chose while it had the hidden test in
 * memory — a channel, exactly like how much it printed (briefNote) — and only
 * the share, which is ours, stays.
 */
export function gpuKillNote(outcome: RunOutcome, gpu: RunRequest['gpu'] | null, brief = false): string | null {
  const slice = gpu?.sliceMb ?? null
  if (outcome.diagnostics.killedBy !== 'gpu' || slice === null) return null
  const peak = outcome.diagnostics.gpuPeakMb ?? null
  const cell = outcome.cell + 1
  if (brief || peak === null) return tr('competitions.answer.gpuOverShare', { slice: gigabytes(slice), cell })
  return tr('competitions.answer.gpuOutOfMemory', { peak: gigabytes(peak), slice: gigabytes(slice), cell })
}

/**
 * The sentence after torch's own OutOfMemoryError in a run that had a card;
 * `null` — no card, or another error.
 *
 * Not the watchdog's kill (gpuKillNote): here torch met its share inside the
 * participant's own cell — the allocator's cap (harness.ts · SITECUSTOMIZE) or
 * a full card — and the traceback says "CUDA out of memory" with nothing about
 * why a 24 GB card ran out at six. The share is ours: the card's memory over
 * the runs sharing it, as the run was given it (RunRequest.gpu), never a
 * number the notebook reported. So a blind participant may read it too, next
 * to the type (briefNote). With a card to itself there is no share to name,
 * and under the cluster, or on a card that did not say its size, nobody can
 * name one — the advice stays.
 */
export function gpuMemoryHint(errorType: string | null, gpu: RunRequest['gpu'] | null): string | null {
  if (!gpu || errorType !== 'OutOfMemoryError') return null
  // The cluster's card (CLUSTER_GPU): its device plugin decides the share, not us.
  if (gpu.device === '') return tr('competitions.answer.gpuOomCard')
  if (gpu.perDevice <= 1) return tr('competitions.answer.gpuOomWhole')
  return gpu.sliceMb === null
    ? tr('competitions.answer.gpuOomCard')
    : tr('competitions.answer.gpuOomShare', { slice: gigabytes(gpu.sliceMb) })
}

/**
 * What the TEACHER reads: the exit code, OOM and the tail of the container
 * log — and for a run with a watched share of a card, a line about the card
 * (cardNote).
 */
export function teacherNote(outcome: RunOutcome, gpu: RunRequest['gpu'] | null = null): string | null {
  if (outcome.status === 'ok') return null
  const head = `${outcome.status} · exit ${outcome.diagnostics.exit ?? '—'}${
    outcome.diagnostics.oomKilled ? ' · OOMKilled' : ''
  }${outcome.diagnostics.killedBy ? ` · killed by ${outcome.diagnostics.killedBy}` : ''}`
  const detail = outcome.status === 'dependency_error' ? outcome.detail : ''
  return [head, detail, cardNote(outcome, gpu), outcome.log].filter(Boolean).join('\n')
}

/**
 * The teacher's line about the card of a failed run that had a watched share:
 * which card, the share and the peak — and for a run stopped for it, the two
 * samples that decided the kill and the line they crossed, so a teacher who
 * thinks the share too small has the numbers to say by how much. `null` — no
 * card, a whole card, or a share of unknown size: nobody watched, and there
 * is nothing to say.
 *
 * A watched run that no sample ever saw holding memory — none answered, or
 * every one that did listed nothing — says the peak was not measured, not
 * "peak 0 MB": a notebook that trained on the card for minutes read as one
 * that never touched it.
 */
function cardNote(outcome: RunOutcome, gpu: RunRequest['gpu'] | null): string | null {
  if (!gpu?.device || gpu.sliceMb === null) return null
  if (outcome.diagnostics.killedBy === 'gpu') {
    return tr('competitions.answer.gpuKilled', {
      device: gpu.device,
      samples: (outcome.diagnostics.gpuSamplesMb ?? []).slice(-2).join(', '),
      limit: gpuKillAboveMb(gpu.sliceMb),
      slice: gpu.sliceMb,
    })
  }
  const peak = outcome.diagnostics.gpuPeakMb
  if (peak === undefined) return null
  return typeof peak === 'number' && peak > 0
    ? tr('competitions.answer.gpuPeak', { device: gpu.device, peak, slice: gpu.sliceMb })
    : tr('competitions.answer.gpuPeakUnmeasured', { device: gpu.device, slice: gpu.sliceMb })
}

/**
 * What the participant reads about the metric.
 *
 * `ParticipantVisibleError` — verbatim, and that is the whole contract. Our
 * own checks arrive from the container as a CODE (harness.ts · align): the
 * participant's page comes in two languages, and the container does not know
 * the instance's language.
 */
export function metricNote(outcome: ScoreOutcome): string | null {
  if (outcome.status !== 'participant_error') return null
  const raw = outcome.message ?? ''
  if (!raw.startsWith('{')) return raw || null
  try {
    const asked: unknown = JSON.parse(raw)
    const code = (asked as { code?: unknown })?.code
    if (typeof code !== 'string') return raw
    const params = ((asked as { params?: unknown })?.params ?? {}) as Record<string, string | number>
    return tr(`competitions.answer.${code}`, params)
  } catch {
    // The metric returned something of its own that starts with a curly
    // brace. That is the participant's text — hand it over as written.
    return raw
  }
}

/* ------------------------------------------------- words on the hidden test */

/**
 * Exception classes a blind participant may be told: the common ones of
 * Python and the data stack. A short list on purpose, not "whatever the last
 * line says": a notebook on the hidden test can raise a class it made up and
 * named after the rows it read, and the name would carry them out whole. The
 * list caps that channel at a handful of bits.
 *
 * `OutOfMemoryError` is torch's (torch.OutOfMemoryError, the CUDA allocator
 * out of room): on a shared card it is what a run meets at its share, raised
 * in the participant's own cell (harness.ts · SITECUSTOMIZE), and the one
 * word a blind participant needs to look at their batch size.
 */
const ERROR_TYPES: ReadonlySet<string> = new Set([
  'ArithmeticError', 'AssertionError', 'AttributeError', 'EmptyDataError', 'FileNotFoundError',
  'ImportError', 'IndentationError', 'IndexError', 'KeyError', 'LinAlgError', 'LookupError',
  'MemoryError', 'MergeError', 'ModuleNotFoundError', 'NameError', 'NotFittedError',
  'NotImplementedError', 'OSError', 'OutOfMemoryError', 'OverflowError', 'ParserError', 'PermissionError',
  'RecursionError', 'RuntimeError', 'StopIteration', 'SyntaxError', 'TypeError',
  'UnboundLocalError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'ValueError', 'ZeroDivisionError',
])

/**
 * The class of the exception a failed cell died of, when it is on the list;
 * null otherwise.
 *
 * Read from the end of the traceback: nbclient's text ends with `Name: message`,
 * and a message with line breaks of its own pushes that line up, so the
 * nearest line that looks like one is taken. A dotted name
 * (`pandas.errors.ParserError`) is judged by its last part.
 */
export function errorTypeOf(detail: string): string | null {
  const lines = String(detail ?? '').trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = /^([A-Za-z_][A-Za-z0-9_.]{0,99})(?::\s|:$|$)/.exec(lines[i].trim())
    if (!found) continue
    const name = found[1].split('.').pop() ?? ''
    if (ERROR_TYPES.has(name)) return name
  }
  return null
}

/**
 * What a BLIND participant reads about a failed notebook on the hidden test.
 *
 * Our own sentences, with only what we can vouch for: the cell (already
 * clamped to the sent notebook), the class from the short list, the limits.
 * Never the traceback, never the printed output, never the measured print
 * size or anything else the run reported about itself, never the module a
 * traceback names: each of those is text the notebook wrote while it had the
 * hidden rows in memory. The sentences that already carry nothing but our
 * numbers (time, memory, no file) are the usual ones. A run stopped for its
 * share of a card is told the share and not how far past it went
 * (gpuKillNote); one stopped because its card could not be read, our
 * sentence about that (unreadCardSentence).
 */
export function briefNote(outcome: RunOutcome, competition: Competition, errorType: string | null, gpu: RunRequest['gpu'] | null = null): string | null {
  const at = outcome.cell + 1
  switch (outcome.status) {
    case 'cell_error': {
      if (outcome.diagnostics.killedBy === 'output') return tr('competitions.answer.sealed.tooMuchOutput', { cell: at })
      const head = errorType
        ? tr('competitions.answer.sealed.cellFailed', { cell: at, cells: outcome.cells, type: errorType })
        : tr('competitions.answer.sealed.cellFailedUntyped', { cell: at, cells: outcome.cells })
      // A paragraph of its own: the blind row shows only what follows the
      // head it already repeats (web/src/lib/competition-words.ts · blindAdvice).
      const unread = outcome.diagnostics.killedBy === 'gpu-unread' ? unreadCardSentence(outcome.detail) : null
      const hint = unread ?? gpuMemoryHint(errorType, gpu)
      return hint ? `${head}\n\n${hint}` : head
    }
    case 'out-of-memory':
      return gpuKillNote(outcome, gpu, true) ?? notebookNote({ ...outcome, detail: '' }, competition)
    case 'target_unreadable':
      return tr('competitions.answer.unreadable', { file: SUBMISSION_FILE })
    case 'dependency_error':
      // The packages install before the notebook's first line, with no hidden
      // row read yet, and the words are ours (sizes we measured).
      return notebookNote(outcome, competition)
    default:
      return notebookNote({ ...outcome, detail: '' }, competition)
  }
}

/**
 * The docker runner's sentence for a run stopped because its card could not
 * be read, when the detail is exactly that sentence (docker-runner.ts ·
 * unreadCardNotes puts it where a traceback would be); `null` otherwise.
 *
 * Without it a blind participant read "the notebook failed at cell 5, the
 * output is hidden" about a run no code of theirs failed in: we stopped it,
 * and why — the card went unanswered sample after sample, most often a
 * notebook starving its own processor — is the one thing they can act on.
 * Matched word for word against our own catalogue rather than passed on for
 * the kill's name: the detail is the traceback's place, and under the brief
 * policy nothing the notebook wrote may leave. The count in it is the
 * runner's: the limit, and a sample still in flight at the stop.
 */
function unreadCardSentence(detail: string): string | null {
  for (let count = VRAM_UNREAD_LIMIT; count <= 2 * VRAM_UNREAD_LIMIT; count++) {
    const ours = tr('competitions.answer.gpuUnread', { count })
    if (detail === ours) return ours
  }
  return null
}

/** Codes of our own alignment checks whose blind words exist (competitions.answer.sealed.*). */
const SEALED_METRIC_CODES: ReadonlySet<string> = new Set([
  'noIdColumn', 'indexColumn', 'duplicateId', 'missingRows', 'idForm', 'emptyPredictions',
  'nonNumeric', 'decimalComma', 'infinitePredictions', 'unparsable',
])

/**
 * What a BLIND participant reads about the metric's refusal of an answer made
 * on the hidden test.
 *
 * Our own checks keep their meaning and lose every value: no example ids (a
 * solution id is a row of the hidden test), no values or column lists from the
 * answer (the notebook wrote those, from the hidden rows), no counts (how many
 * rows are missing is a number the notebook chose). The column names that
 * stay are the answer key's own. A teacher's ParticipantVisibleError becomes
 * one generic sentence: its text may quote the answer, and we cannot tell.
 */
export function sealedMetricNote(outcome: ScoreOutcome): string | null {
  if (outcome.status !== 'participant_error') return null
  const raw = outcome.message ?? ''
  try {
    const asked: unknown = raw.startsWith('{') ? JSON.parse(raw) : null
    const code = (asked as { code?: unknown } | null)?.code
    if (typeof code === 'string' && SEALED_METRIC_CODES.has(code)) {
      const params = ((asked as { params?: unknown }).params ?? {}) as Record<string, unknown>
      const column = typeof params.column === 'string' ? params.column.slice(0, 64) : ''
      return tr(`competitions.answer.sealed.${code}`, { column, file: SUBMISSION_FILE })
    }
  } catch {
    /* not our code: the teacher's own text, which is never shown blind */
  }
  return tr('competitions.answer.sealed.metricRejected')
}

/* -------------------------------------------------------------- intervention */

/**
 * Take a submission down: the participant pressed "Cancel", the teacher
 * "Kill".
 *
 * `false` means there is nothing to take down: the work has already ended.
 * This is not an error but exactly the case the mockup does not draw ("the
 * cancel was too late"), and the person has to be told about it honestly
 * rather than pretending it worked.
 */
export async function cancelSubmission(
  submissionId: string,
  by: 'entrant' | 'teacher',
): Promise<boolean> {
  const row = queueRow(submissionId)
  if (!row) return false
  if (row.state === 'waiting') {
    leaveQueue(submissionId)
    updateSubmission(submissionId, {
      state: 'cancelled',
      stage: 'queue',
      teacherError: tr(by === 'teacher' ? 'competitions.answer.killedByTeacher' : 'competitions.answer.killedByEntrant'),
    })
    return true
  }
  if (!(await competitionCapabilities()).execution.available) return false
  if (queueRow(submissionId)?.attemptId !== row.attemptId) return false
  cancelled.set(submissionId, by)
  count('cancelled')
  if (row.attemptId) aborters.get(row.attemptId)?.abort()
  db.prepare('UPDATE competition_queue SET pending_kind = NULL WHERE submission_id = ? AND attempt_id = ?').run(submissionId, row.attemptId)
  if (row.container) await competitionRunner().kill(row.container).catch(() => undefined)
  return true
}

/**
 * Whether the submission's run belongs to a job of THIS process — the only
 * kind "Kill" can take down and anyone here can wait for. A running row of a
 * previous life (not reclaimed yet) is not one.
 */
export function runningHere(submissionId: string): boolean {
  const row = queueRow(submissionId)
  return row?.state === 'running' && !!row.attemptId && inFlight.has(row.attemptId)
}

/**
 * Wait until this process is done with a submission's run — the container
 * answered its kill, the outcome is written, the attempt's directory is gone
 * — for at most `timeoutMs`.
 *
 * For whoever is about to remove the submission itself (competitions/
 * erase.ts): a run still finishing would write its outcome into a row that is
 * no longer there, and its files into a directory that was just removed.
 * `false` means it is still going, or it is a run no job of this process
 * owns (a previous life's, not reclaimed yet), which nobody here can wait
 * for.
 */
export async function settleSubmission(submissionId: string, timeoutMs: number): Promise<boolean> {
  const row = queueRow(submissionId)
  if (!row || row.state !== 'running') return true
  const job = row.attemptId ? inFlight.get(row.attemptId) : undefined
  if (!job) return false
  let timeout: NodeJS.Timeout | undefined
  const late = new Promise<'late'>((resolve) => {
    timeout = setTimeout(() => resolve('late'), timeoutMs)
    timeout.unref?.()
  })
  const outcome = await Promise.race([job.then(() => 'done' as const, () => 'done' as const), late])
  clearTimeout(timeout)
  if (outcome === 'late') return false
  return queueRow(submissionId)?.state !== 'running'
}

/**
 * Take every run of a competition off the executor before the competition
 * is deleted: the waiting ones leave the queue, the running ones are killed
 * the way "Kill" kills them and waited for, each for at most `settleMs`.
 *
 * Without it the delete took the running rows away under live containers:
 * the run went on to its time limit holding its share of a card, while the
 * queue, which knows a card is busy only from its rows, put the next GPU
 * notebook on it — "the whole card" promised on a card a stranger filled.
 * `false` — a run is still going (it did not stop in time, or it belongs to a
 * previous life of the server that nobody here can wait for), and nothing
 * may be deleted yet. The waiting ones stay cancelled either way, as when a
 * participant is removed (erase.ts): the competition is going.
 */
export async function stopCompetitionRuns(competitionId: string, settleMs: number): Promise<boolean> {
  const rows = queueRows().filter((row) => row.competitionId === competitionId)
  if (rows.some((row) => row.state === 'running' && !runningHere(row.submissionId))) return false
  // Before the first await: the pump must not start them while the running ones are taken down.
  for (const row of rows) {
    if (row.state !== 'waiting') continue
    leaveQueue(row.submissionId)
    updateSubmission(row.submissionId, { state: 'cancelled', stage: 'queue', teacherError: tr('competitions.answer.killedByTeacher') })
  }
  for (const row of rows) {
    if (row.state !== 'running') continue
    await cancelSubmission(row.submissionId, 'teacher')
    if (!(await settleSubmission(row.submissionId, settleMs))) return false
  }
  return true
}

/**
 * Execute the notebook again — the same as submitting it once more, but
 * without a number.
 */
export function rerunSubmission(submissionId: string): boolean {
  const submission = getSubmission(submissionId)
  if (!submission) return false
  if (!isTerminal(submission.state)) return false
  // The submitted notebook may have left the disk in a cleanup of old
  // submissions — then there is nothing to execute, and lying with a "Run
  // again" button is not worth it.
  if (!competitionsFs.existsSync(path.join(inputDir(submission.competitionId, submission.id), NOTEBOOK_FILE))) {
    return false
  }
  updateSubmission(submissionId, {
    state: 'queued',
    stage: 'queue',
    participantError: null,
    teacherError: null,
    errorType: null,
    publicScore: null,
    privateScore: null,
  })
  enqueue({
    submissionId,
    competitionId: submission.competitionId,
    entrantId: submission.entrantId,
    kind: 'notebook',
  })
  wakeCompetitionPump()
  return true
}

/**
 * Rescore the metric for all submissions of a competition.
 *
 * The notebooks are NOT run again — that is why runs are stored as one row
 * per attempt: executing a hundred notebooks would take an hour and give
 * exactly the same answers that already lie on disk. Those whose answer has
 * been kept are taken; a crashed notebook has nothing to rescore.
 */
export function rescoreCompetition(competitionId: string): number {
  let queued = 0
  for (const submission of listSubmissions(competitionId)) {
    if (!hasStoredAnswer(competitionId, submission.id)) continue
    if (queueRow(submission.id)?.state === 'running') {
      enqueue({ submissionId: submission.id, competitionId, entrantId: submission.entrantId, kind: 'metric' })
      queued++
      continue
    }
    updateSubmission(submission.id, {
      state: 'queued',
      stage: 'score',
      participantError: null,
      teacherError: null,
    })
    enqueue({
      submissionId: submission.id,
      competitionId,
      entrantId: submission.entrantId,
      kind: 'metric',
    })
    queued++
  }
  if (queued) wakeCompetitionPump()
  return queued
}

/** Whether the submission's answer is still on disk: what a metric-only rescore reads. */
export function hasStoredAnswer(competitionId: string, submissionId: string): boolean {
  try {
    return competitionsFs.existsSync(
      path.join(resultDir(competitionId, submissionId), SUBMISSION_FILE),
    )
  } catch {
    return false
  }
}

/**
 * Pause the queue or let it go again. Running work is not touched — that is
 * what "Kill" is for.
 */
export function pauseCompetitionQueue(paused: boolean, by: string | null = null): void {
  setQueuePaused(paused, by)
  if (!paused) wakeCompetitionPump()
}

/* ----------------------------------------------------------------- summary */

/** The executor bar in A1 and the queue block in A3 — in one answer. */
export interface RunnerStatus {
  backend: CompetitionBackend
  slots: number
  paused: boolean
  waiting: number
  running: Array<{ submissionId: string; competitionId: string; kind: RunKind; startedAt: number | null }>
  diagnostics: typeof diagnostics & { oldestWaitingMs: number; reservations: ReturnType<typeof workBudgetSnapshot> }
}

export function runnerStatus(): RunnerStatus {
  return {
    backend: competitionBackend(),
    slots: queueSlots(),
    paused: queuePaused(),
    waiting: waitingCount(),
    diagnostics: { ...diagnostics, oldestWaitingMs: Math.max(0, ...queueRows().filter((row) => row.state === 'waiting').map((row) => Date.now() - row.enqueuedAt)), reservations: workBudgetSnapshot() },
    running: runningRows().map((row) => ({
      submissionId: row.submissionId,
      competitionId: row.competitionId,
      kind: row.kind,
      startedAt: row.startedAt,
    })),
  }
}
