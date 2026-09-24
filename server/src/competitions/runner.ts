/**
 * The submission execution queue — one per instance, and the pump over it.
 *
 * THE DESIGN IN FIVE SENTENCES. The queue lives in the database (store.ts),
 * not in memory: a class period lasts an hour and a half, submissions pile up
 * all that time, and a server restart must not mean "thirty people submitted
 * into the void". The pump is one timer that takes work with the `takeNext`
 * transaction and starts it without waiting; there is one slot by default,
 * because a class is running next to it on the teacher's machine, and a
 * second submission takes memory away from the class rather than speeding up
 * the queue. Work goes in two steps in two disposable containers — the
 * notebook, then the metric — and exactly one file moves between them.
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
import { submissionUsesCurrentBase, type AttemptProvenance } from './provenance.js'
import { tr } from '@shared/i18n'
import '../admin/settings.js'
import { db } from '../db.js'
import { getBinding, lockOf } from '../dependencies/store.js'
import { verifyBundleFiles } from '../dependencies/files.js'
import {
  BOOT,
  enqueue,
  deferResourceAttempt,
  discardUnstartedRun,
  finishRun,
  finishQueueAttempt,
  ownsQueueAttempt,
  getCompetition,
  getSubmission,
  leaveQueue,
  listSubmissions,
  noteQueueContainer,
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
  type QueueRow,
} from './store.js'
import {
  competitionsFs,
  competitionsDir,
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
import { METRIC_NAME, competitionDockerDiagnostics } from './docker-runner.js'
import { CompetitionResourcePending } from './broker-runner.js'
import {
  competitionBackend,
  competitionRunner,
  limitsFor,
  type CompetitionBackend,
  type RunOutcome,
  type ScoreOutcome,
} from './runner-port.js'
import {
  LIMITS,
  isTerminal,
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
 * A key in the instance's shared box (instance_settings), not a column in the
 * queue table: this is a setting of the MACHINE, next to the Oracle's
 * settings, not queue state like the pause. The default is one slot: at four
 * gigabytes per submission, two fit into docker's virtual machine, and that
 * is before the kernels of live rooms.
 */
const SLOTS_KEY = 'competitions.slots'
export const DEFAULT_SLOTS = 1
export const MAX_SLOTS = 8

/*
 * The box is created by `admin/settings`, and the import here is not
 * decoration: without it the table might not exist yet when the statements
 * below are prepared, and the queue would crash at startup for anyone who
 * brought it up before the panel. The same import puts in place the
 * translator that reads the instance language — and the strings the runner
 * writes to the participant go through `tr`.
 */
const readSetting = db.prepare('SELECT value FROM instance_settings WHERE key = ?')
const writeSetting = db.prepare(`
  INSERT INTO instance_settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`)

export function queueSlots(): number {
  const row = readSetting.get(SLOTS_KEY) as { value: string } | undefined
  const asked = Number(row?.value)
  if (!Number.isFinite(asked)) return DEFAULT_SLOTS
  return Math.min(MAX_SLOTS, Math.max(1, Math.floor(asked)))
}

export function setQueueSlots(slots: number): number {
  const value = Math.min(MAX_SLOTS, Math.max(1, Math.floor(Number(slots) || DEFAULT_SLOTS)))
  writeSetting.run(SLOTS_KEY, String(value))
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
const RUN_RESERVE_MB = 256

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
    if (!(await competitionCapabilities()).execution.available) return 0
    const { availableMb } = await competitionRunner().capacity()
    let availableDiskBytes: number | null = null
    try { const disk = fs.statfsSync(competitionsDir); availableDiskBytes = disk.bavail * disk.bsize } catch { /* unknown capacity */ }
    for (;;) {
      if (runningRows().length >= slots) break
      const candidate = nextQueueRow()
      if (!candidate) break
      const competition = getCompetition(candidate.competitionId)
      const need = competition ? Math.max(limitsFor(competition, candidate.kind).memoryMb, limitsFor(competition, 'metric').memoryMb) : 0
      let secretBytes = 0
      try { secretBytes = competitionsFs.statSync(path.join(secretDir(candidate.competitionId), SOLUTION_FILE)).size } catch { /* no solution */ }
      const release = reserveWork({ id: `competition:${newToken()}`, kind: 'competition', memoryMb: need + RUN_RESERVE_MB,
        diskBytes: LIMITS.submissionBytes * 4 + secretBytes }, { availableMemoryMb: availableMb, availableDiskBytes })
      if (!release) {
        warnOnce(`[competitions] resource reservations leave insufficient capacity for ${candidate.submissionId}`)
        break
      }
      forgetWarning()
      const row = takeNext({ boot: BOOT, slots })
      if (!row) { release(); break }
      started++
      const attemptId = row.attemptId!
      count('started')
      aborters.set(attemptId, new AbortController())
      const job = runJob(row).finally(() => {
        release()
        inFlight.delete(attemptId)
        aborters.delete(attemptId)
        count('completed')
      })
      inFlight.set(attemptId, job)
    }
  } finally {
    pumping = false
  }
  return started
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
}

/** Stop the pump and wait for what is running. No new work is taken after that. */
export async function stopCompetitionPump(): Promise<void> {
  stopped = true
  if (timer) clearInterval(timer)
  timer = null
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
  try {
    if (!ownsQueueAttempt(row)) return
    const provenance: AttemptProvenance = submissionUsesCurrentBase(competition, submission.id)
      ? { inputRevision: competition.inputRevision ?? 0, notebookInputRevision: competition.notebookInputRevision ?? 0 }
      : { inputRevision: null, notebookInputRevision: null }
    snapshotSecrets(competition, submission, row)
    if (row.kind === 'metric') await scoreOnly(competition, submission, row, provenance)
    else await runNotebookThenScore(competition, submission, row, provenance)
  } catch (err) {
    if (err instanceof CompetitionResourcePending && ownsQueueAttempt(row)) {
      const reason=tr('competitions.runtime.resourcesWaiting')
      const after=deferResourceAttempt(row,reason,Date.now(),`Competition Pod unschedulable (${err.resource}); retrying automatically.`,err.kind)
      if (after!==null) {
        updateSubmission(submission.id,{cellsDone:submission.cellsDone,cellsTotal:submission.cellsTotal,durationMs:submission.durationMs})
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
    try { dropAttempt(competition.id, submission.id, row.attemptId!) } catch { count('cleanupFailures'); console.warn('[competitions] attempt cleanup failed', row.attemptId) }
  }
}

/** Step one and, if it succeeded, step two. */
async function runNotebookThenScore(competition: Competition, submission: Submission, row: QueueRow, provenance: AttemptProvenance): Promise<void> {
  const runner = competitionRunner()
  const binding = getBinding(submission.id)
  const limits = limitsFor(competition, 'notebook')
  const container = containerName(submission.id, 'notebook', newToken())
  const run = startRun({ submissionId: submission.id, kind: 'notebook', container, attemptId: row.attemptId!, inputRevision: provenance.inputRevision ?? undefined })
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
  })

  const data = openDir(competition.id)
  const input = inputDir(competition.id, submission.id)
  const result = attemptDir(competition.id, submission.id, row.attemptId!)
  if (runner.backend !== 'test') {
    letContainerRead(data)
    letContainerRead(input)
  }

  let dependenciesDir: string | undefined
  let preflightError: unknown = null
  if (runner.backend !== 'test') {
    try {
      if (!binding?.revision) throw new Error('This legacy submission has no available pinned environment. Submit the notebook again.')
      if (binding.bundle) {
        const lock = lockOf(binding.bundle.id)
        if (lock === null) throw new Error('Dependency set is no longer ready')
        dependenciesDir = await verifyBundleFiles(binding.bundle, lock)
      }
    } catch (error) { preflightError = error }
  }
  // Hashing a large set yields to cancellation before any container exists.
  if (!ownsQueueAttempt(row) || takeCancellation(submission.id, 0)) {
    finishRun(run.id, { finishedAt: Date.now(), verdict: 'exit', cellsDone: 0, cellsTotal: 0,
      teacherError: 'Cancelled before container start' })
    return
  }
  let outcome: RunOutcome
  try { outcome = preflightError ? {
    status: 'dependency_error', cell: -1, cells: 0, wall: 0, submission: null,
    detail: preflightError instanceof Error ? preflightError.message : String(preflightError), log: '',
    diagnostics: { exit: null, oomKilled: false, backend: runner.backend },
  } : await runner.run({
    imageDigest: binding?.revision?.imageDigest,
    dependenciesDir,
    competition,
    submissionId: submission.id,
    attemptId: row.attemptId!,
    signal: aborters.get(row.attemptId!)?.signal,
    container,
    dataDir: data,
    inputDir: input,
    resultDir: result,
    limits,
    onProgress: (progress) => {
      if (!ownsQueueAttempt(row)) return
      updateSubmission(submission.id, {
        stage: progress.phase === 'dependencies' ? 'dependencies' : 'notebook',
        cellsDone: progress.cell + 1,
        cellsTotal: progress.cells,
      })
    },
  }) } catch(error) {
    if(error instanceof CompetitionResourcePending)discardUnstartedRun(run.id,row.attemptId!)
    throw error
  }
  finishRun(run.id, {
    finishedAt: Date.now(),
    verdict: outcome.status,
    exitCode: outcome.diagnostics.exit,
    oom: outcome.diagnostics.oomKilled,
    cellsDone: outcome.cell + 1,
    cellsTotal: outcome.cells,
    participantError: notebookNote(outcome, competition),
    teacherError: teacherNote(outcome),
  })

  if (!ownsQueueAttempt(row) || takeCancellation(submission.id, outcome.wall)) return
  publishAttemptArtifacts(competition.id, submission.id, result)
  if (outcome.status !== 'ok') {
    updateSubmission(submission.id, {
      state: stateOfVerdict('notebook', outcome.status),
      stage: outcome.status === 'dependency_error' ? 'dependencies' : outcome.status === 'no-submission' ? 'check' : 'notebook',
      durationMs: outcome.wall,
      cellsDone: outcome.cell + 1,
      cellsTotal: outcome.cells,
      participantError: notebookNote(outcome, competition),
      teacherError: teacherNote(outcome),
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
  const answer = readAnswer(competition.id, submission.id, result)
  if (typeof answer === 'string') {
    updateSubmission(submission.id, {
      state: 'rejected',
      stage: 'check',
      durationMs: outcome.wall,
      participantError: answer,
    })
    return
  }
  updateSubmission(submission.id, { notebookInputRevision: provenance.notebookInputRevision })
  promoteAttempt(competition.id, submission.id, result, answer)
  await scoreStep(competition, submission, answer, outcome.wall, outcome, row, provenance)
}

/**
 * The collected answer — or a string explaining to the participant why there
 * is none.
 *
 * Empty and too big are kept apart on purpose: "file not written" and "an
 * 80-megabyte file" are two different conversations, and a participant who
 * read the first instead of the second will look for the mistake in the wrong
 * place.
 */
function readAnswer(competitionId: string, submissionId: string, directory = resultDir(competitionId, submissionId)): Buffer | string {
  const file = path.join(directory, SUBMISSION_FILE)
  let size: number
  try {
    size = competitionsFs.statSync(file).size
  } catch {
    return tr('competitions.answer.noFile', { file: SUBMISSION_FILE })
  }
  if (size > LIMITS.submissionBytes) {
    return tr('competitions.answer.tooLarge', {
      file: SUBMISSION_FILE,
      count: Math.round(LIMITS.submissionBytes / MB),
    })
  }
  let body: Buffer | null = null
  try { body = competitionsFs.readFileSync(file) as Buffer } catch { /* unreadable regular file */ }
  return body ?? tr('competitions.answer.unreadable', { file: SUBMISSION_FILE })
}

/** Rescoring: the metric over the stored answer, without executing the notebook again. */
async function scoreOnly(competition: Competition, submission: Submission, row: QueueRow, provenance: AttemptProvenance): Promise<void> {
  const answer = readAnswer(competition.id, submission.id)
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
  await scoreStep(competition, submission, answer, submission.durationMs ?? 0, null, row, provenance)
}

/** Step two: the teacher's metric in the second disposable container. */
async function scoreStep(
  competition: Competition,
  submission: Submission,
  answer: Buffer,
  notebookWall: number,
  notebook: RunOutcome | null,
  row: QueueRow,
  provenance: AttemptProvenance,
): Promise<void> {
  const runner = competitionRunner()
  updateSubmission(submission.id, { stage: 'score' })

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
  competitionsFs.writeFileSync(path.join(scoreInput, SUBMISSION_FILE), answer, { mode: 0o600 })
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
    teacherError: outcome.teacherOnly,
    ...(notebook ? { cellsDone: notebook.cell + 1, cellsTotal: notebook.cells } : {}),
  })
}

/**
 * Are the answers and the metric code in place? A string says what is
 * missing, `null` means everything is there.
 *
 * The metric code is put on disk EVERY time, and that is cheaper than any
 * attempt to guess whether it changed: the teacher edits the metric exactly
 * when it has failed, and a submission rescored with the old code would look
 * like an unfixed error. We write the file INSIDE the mounted directory
 * rather than mounting the file itself — that is exactly why overwriting is
 * safe (see the header of storage.ts about virtiofs).
 */
function snapshotSecrets(competition: Competition, submission: Submission, row: QueueRow): void {
  const directory = attemptDir(competition.id, submission.id, row.attemptId!, 'secret')
  const solution = path.join(secretDir(competition.id), SOLUTION_FILE)
  if (competitionsFs.existsSync(solution)) copyCompetitionFile(solution, path.join(directory, SOLUTION_FILE))
  competitionsFs.writeFileSync(path.join(directory, METRIC_NAME), Buffer.from(`${competition.metric.code}\n`), { mode: 0o600 })
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
 */
export function notebookNote(outcome: RunOutcome, competition: Competition): string | null {
  const at = outcome.cell + 1
  switch (outcome.status) {
    case 'ok':
      return null
    case 'dependency_error':
      return tr('dependencies.error.install')
    case 'cell_error':
      if (outcome.diagnostics.killedBy === 'output') {
        return tr('competitions.answer.tooMuchOutput', {
          count: Math.round((outcome.diagnostics.peakBytes ?? 0) / MB) || 64,
          cell: at,
        })
      }
      return outcome.detail
        ? `${tr('competitions.answer.cellFailed', { cell: at, cells: outcome.cells })}\n\n${outcome.detail}`
        : tr('competitions.answer.cellFailed', { cell: at, cells: outcome.cells })
    case 'cell_timeout':
    case 'timeout':
      return tr('competitions.answer.timeout', {
        count: Math.max(1, Math.round(competition.limits.wallSeconds / 60)),
        cell: at,
        cells: outcome.cells,
      })
    case 'out-of-memory':
      return tr('competitions.answer.outOfMemory', {
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

/** What the TEACHER reads: the exit code, OOM and the tail of the container log. */
export function teacherNote(outcome: RunOutcome): string | null {
  if (outcome.status === 'ok') return null
  const head = `${outcome.status} · exit ${outcome.diagnostics.exit ?? '—'}${
    outcome.diagnostics.oomKilled ? ' · OOMKilled' : ''
  }${outcome.diagnostics.killedBy ? ` · killed by ${outcome.diagnostics.killedBy}` : ''}`
  const detail = outcome.status === 'dependency_error' ? outcome.detail : ''
  return [head, detail, outcome.log].filter(Boolean).join('\n')
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

function hasStoredAnswer(competitionId: string, submissionId: string): boolean {
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
