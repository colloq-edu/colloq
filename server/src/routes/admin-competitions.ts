/**
 * The panel's doors to competitions: the list (A1), the editor (A2), the
 * running one (A3).
 *
 * The rights here read in two words. Everything that shows and creates is
 * `requireStaff`: a competition is run by the same teacher as the lesson.
 * `ownerOnly` sits on the destructive ones, and its list is short and
 * deliberate: delete a competition, delete the ANSWERS FILE, end submissions,
 * issue an entrant a new key (the old one stops working that same second) and
 * remove someone else's submission from scoring. These five have one thing in
 * common: the consequence falls on people who are not in the request.
 *
 * WHAT IS NOT HERE AND CANNOT BE: a door serving the contents of
 * `solution.csv`. The answers lie in the competition's DATA_DIR, outside the
 * class working folders (see SECURITY.md), and they have exactly one way out:
 * the metric container the runner brings up. The teacher sees the names and
 * columns of the answers (that is how A2 is drawn); nobody sees the bytes.
 * The hidden test is held the same way: uploaded, listed and removed here,
 * read by the notebook during the check, downloaded by no one.
 *
 * Running submissions does not live here. These routes put work into the
 * queue (`store.ts`) and wake the pump (`runner.ts`), and "run again", "kill"
 * and "rescore everyone" call the same pump: it knows where exactly the sent
 * notebook lies and whether the answer was kept, and the panel must not have
 * a second copy of that knowledge.
 */
import path from 'node:path'
import busboy from 'busboy'
import { Router, type Request, type Response } from 'express'
import { tr } from '@shared/i18n'
import { acceptPinnedSubmission, executionRevision, publicExecution } from '../dependencies/service.js'
import { assertCompetitionCapability, competitionCapabilities } from '../competitions/capabilities.js'
import { submissionUsesCurrentBase } from '../competitions/provenance.js'
import { competitionRevision } from '../dependencies/store.js'
import { DependencyStoreError } from '../dependencies/store.js'
import { dependencyMessage } from '../dependencies/messages.js'
import { currentStaff, ownerOnly, requireStaff } from '../admin/auth.js'
import { instanceDayStart } from '../time-zone.js'
import { deleteEntrantFromCompetition } from '../competitions/erase.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import {
  acceptSubmission,
  competitionsElsewhere,
  competitionSummary,
  invalidateCompetitionInputs,
  createCompetition,
  createEntrant,
  deleteCompetition,
  dropFile,
  entrantKeyOf,
  findCompetition,
  getCompetition,
  getEntrant,
  getSubmission,
  leaderboard,
  leaveQueue,
  listCompetitionEntrants,
  listCompetitions,
  listEntrantSubmissions,
  listEntrants,
  listFiles,
  listRuns,
  listSubmissions,
  openFileBytes,
  openPrivateBoard,
  putFile,
  sealedFileBytes,
  queuePause,
  queueRow,
  queueRows,
  renameEntrant,
  rotateEntrantKey,
  runningRows,
  setCompetitionState,
  setEntrantDisabled,
  updateCompetition,
  forgiveLateSubmissions,
  updateSubmission,
  waitingCount,
  enqueue,
} from '../competitions/store.js'
import {
  EXECUTED_FILE,
  NOTEBOOK_FILE,
  SOLUTION_FILE,
  baselineDir,
  competitionsFs,
  dropOpenFile,
  dropSealedFile,
  dropSecretFile,
  ensureCompetition,
  putBaseline,
  putOpenFile,
  putSealedFile,
  putSecretFile,
  putSubmissionNotebook,
  readBaseline,
  readOpenFile,
  readResultFile,
  readSealedFile,
  readSecretFile,
  resultDir,
} from '../competitions/storage.js'
import {
  executedToday,
  medianOf,
  openRefusal,
  parseCompetitionInput,
  rescorable,
  withoutBaseline,
  type DoneEntry,
  type InputRefusal,
} from '../competitions/panel.js'
import { queueForecast } from '../competitions/forecast.js'
import { DEADLINE_GRACE_MS, privateBoardState } from '../competitions/results.js'
import { machineShape, slotsResolution } from '../competitions/capacity.js'
import { competitionDefaults, parseSettingsInput, saveCompetitionSettings, uploadsPerMinute, type SettingsRefusal } from '../competitions/settings.js'
import { HOST_RESERVE_MB } from '../kernel/resources.js'
import { baseName, csvShape, csvUsageSplit, intakeNotebook, notebookCells } from '../competitions/intake.js'
import {
  cancelSubmission,
  hasStoredAnswer,
  pauseCompetitionQueue,
  queueSlots,
  rerunSubmission,
  rescoreCompetition,
  wakeCompetitionPump,
} from '../competitions/runner.js'
import type { QueueRow } from '../competitions/store.js'
import { METRIC_WALL_SECONDS } from '../competitions/runner-port.js'
import type { AdminErrorBody, AdminErrorReason } from '@shared/admin'
import { SETTINGS_LIMITS, type CompetitionSettings } from '@shared/competitions-settings'
import {
  LIMITS,
  entrantHandle,
  placesAmongPeople,
  placesByScore,
  publicRowCount,
  type Competition,
  type CompetitionFile,
  type Entrant,
  type Submission,
} from '@shared/competitions'
import type {
  BaselineView,
  CompetitionCounts,
  CompetitionLive,
  CompetitionRow,
  CompetitionView,
  CompetitionsList,
  EntrantRemoved,
  EntrantRow,
  EntrantsList,
  FileView,
  QueueSnapshot,
  RunningNow,
  SealedFileView,
  SubmissionDetail,
  SubmissionFeed,
  SubmissionRow,
  WaitingRow,
} from '@shared/competitions-api'

function fail(res: Response, status: number, reason: AdminErrorReason, message: string): void {
  const body: AdminErrorBody = { error: message, reason }
  res.status(status).json(body)
}

/** Data files per upload. More than that means a whole folder was dragged in. */
const FILES_PER_UPLOAD = 20

/** The submissions feed as one page. */
const FEED_PAGE = 200

/* --------------------------------------------------------------- helpers */

function competitionOf(req: Request, res: Response): Competition | null {
  const found = findCompetition(String(req.params.id ?? ''))
  if (!found) {
    fail(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    return null
  }
  return found
}

function submissionOf(competition: Competition, req: Request, res: Response): Submission | null {
  const found = getSubmission(String(req.params.sid ?? ''))
  // Someone else's submission by a direct link is `not_found`, not
  // "forbidden": the panel shows both phrases the same anyway, and the second
  // names a competition the asker did not know about.
  if (!found || found.competitionId !== competition.id) {
    fail(res, 404, 'not_found', tr('competitions.refusal.noSubmission'))
    return null
  }
  return found
}

/** The service entrant the sample notebook is recorded under; null means it was not checked. */
function baselineEntrantOf(competition: Competition): string | null {
  return competition.baselineEntrantId ?? null
}

/** The sample notebook file on disk: its bytes and when it was put there. */
function baselineFile(id: string): { bytes: number; uploadedAt: number } | null {
  try {
    const info = competitionsFs.statSync(path.join(baselineDir(id), NOTEBOOK_FILE))
    return { bytes: info.size, uploadedAt: Math.round(info.mtimeMs) }
  } catch {
    return null
  }
}

/** The CLASS's best public score: the baseline solution is shown as a separate row. */
function bestPublicOf(competition: Competition, baselineEntrant: string | null): number | null {
  const rows = leaderboard(competition.id, 'public').filter(
    (row) => row.entrantId !== baselineEntrant,
  )
  return rows.length ? rows[0].score : null
}

function baselineInputsCurrent(competition: Competition, baseline: Submission | null): boolean {
  return !!baseline && baseline.inputRevision != null && baseline.notebookInputRevision != null
    && baseline.inputRevision === competition.inputRevision
    && baseline.notebookInputRevision === competition.notebookInputRevision
    && submissionUsesCurrentBase(competition, baseline.id)
}

function readinessOf(competition: Competition) {
  const baseline = competition.baselineSubmissionId
    ? getSubmission(competition.baselineSubmissionId)
    : null
  return openRefusal({
    openFiles: listFiles(competition.id, 'open').length,
    hiddenFiles: listFiles(competition.id, 'hidden').length,
    metricCode: competition.metric.code,
    baseline: baselineFile(competition.id) !== null,
    baselineState: baselineInputsCurrent(competition, baseline) ? baseline?.state ?? null : null,
    privateRelease: competition.privateRelease,
    deadlineAt: competition.deadlineAt,
  })
}

function countsOf(competition: Competition): CompetitionCounts {
  const baselineEntrant = baselineEntrantOf(competition)
  const baselineRows = baselineEntrant
    ? listEntrantSubmissions(competition.id, baselineEntrant)
    : []
  return withoutBaseline(
    competitionSummary(competition.id),
    baselineRows,
    bestPublicOf(competition, baselineEntrant),
  )
}

function rowOf(competition: Competition): CompetitionRow {
  const counts = countsOf(competition)
  const baseline = competition.baselineSubmissionId
    ? getSubmission(competition.baselineSubmissionId)
    : null
  return {
    competition,
    entrants: counts.entrants,
    submissions: counts.submissions,
    bestPublic: counts.bestPublic,
    baselineScore: baseline?.publicScore ?? null,
    baselineState: baseline?.state ?? null,
    ready: readinessOf(competition),
    privatePending: privateBoardState(competition).pending,
  }
}

/**
 * CSV columns: "397 rows · id, orders".
 *
 * The file is read whole for the sake of one header, so the read has a cap:
 * beyond it the columns are not shown at all. Opening the competition editor
 * at the cost of two hundred megabytes in memory is not acceptable: this
 * screen is opened in the middle of a lesson.
 */
const HEADER_READ_LIMIT = 8 * 1024 * 1024

function fileView(competitionId: string, file: CompetitionFile): FileView {
  let columns: string[] | null = null
  if (file.name.toLowerCase().endsWith('.csv') && file.bytes <= HEADER_READ_LIMIT) {
    const bytes =
      file.visibility === 'open'
        ? readOpenFile(competitionId, file.name, HEADER_READ_LIMIT)
        : file.visibility === 'sealed'
          ? readSealedFile(competitionId, file.name, HEADER_READ_LIMIT)
          : readSecretFile(competitionId, file.name, HEADER_READ_LIMIT)
    columns = bytes ? csvShape(bytes)?.columns ?? null : null
  }
  return { ...file, columns }
}

function baselineView(competition: Competition): BaselineView | null {
  const file = baselineFile(competition.id)
  if (!file) return null
  const notebook = readBaseline(competition.id, LIMITS.notebookBytes)
  const submission = competition.baselineSubmissionId
    ? getSubmission(competition.baselineSubmissionId)
    : null
  return {
    fileName: NOTEBOOK_FILE,
    bytes: file.bytes,
    cells: notebook ? notebookCells(notebook) : null,
    uploadedAt: file.uploadedAt,
    submissionId: submission?.id ?? null,
    inputsCurrent: baselineInputsCurrent(competition, submission),
    inputRevision: submission?.inputRevision ?? null,
    notebookInputRevision: submission?.notebookInputRevision ?? null,
    state: submission?.state ?? null,
    publicScore: submission?.publicScore ?? null,
    privateScore: submission?.privateScore ?? null,
    durationMs: submission?.durationMs ?? null,
    participantError: submission?.participantError ?? null,
    teacherError: submission?.teacherError ?? null,
  }
}

async function viewOf(competition: Competition): Promise<CompetitionView> {
  const capabilities = await competitionCapabilities(competition.environment, competitionRevision(competition.id)?.imageDigest)
  competition = getCompetition(competition.id) ?? competition
  const open = listFiles(competition.id, 'open')
  const hidden = listFiles(competition.id, 'hidden')
  const hiddenViews = hidden.map((file) => fileView(competition.id, file))
  const openNames = new Set(open.map((file) => file.name))
  const sealedViews: SealedFileView[] = listFiles(competition.id, 'sealed').map((file) => ({
    ...fileView(competition.id, file),
    replaces: openNames.has(file.name) ? file.name : null,
  }))
  const solution =
    hiddenViews.find((file) => file.name === SOLUTION_FILE) ?? hiddenViews[0] ?? null
  /*
   * The rows are split by the seed or by the Usage column in the answers
   * file itself.
   *
   * Only HOW MANY there will be is counted here: which rows exactly are
   * public is decided by `splitRows` at the moment the metric is computed,
   * and the panel does not need to know that, and has nowhere to show it and
   * must not.
   */
  const total = solution?.rows ?? null
  const solutionBytes = solution
    ? readSecretFile(competition.id, solution.name, HEADER_READ_LIMIT)
    : null
  const usage = solutionBytes ? csvUsageSplit(solutionBytes) : null
  const publicRows = usage?.publicRows ?? publicRowCount(total ?? 0, competition.publicPercent)
  return {
    competition,
    capabilities,
    openFiles: open.map((file) => fileView(competition.id, file)),
    hiddenFiles: hiddenViews,
    sealedFiles: sealedViews,
    sealedBytes: sealedFileBytes(competition.id),
    baseline: baselineView(competition),
    split:
      total === null || solutionBytes === null
        ? null
        : {
            total,
            publicRows,
            privateRows: total - publicRows,
            byUsage: usage !== null,
          },
    counts: countsOf(competition),
    ready: readinessOf(competition),
    dataBytes: openFileBytes(competition.id),
    privatePending: privateBoardState(competition).pending,
  }
}

/* ----------------------------------------------------------------- queue */

function runningNow(row: QueueRow): RunningNow | null {
  const submission = getSubmission(row.submissionId)
  const competition = getCompetition(row.competitionId)
  if (!submission || !competition) return null
  const limitSeconds =
    row.kind === 'metric' ? METRIC_WALL_SECONDS : competition.limits.wallSeconds
  return {
    submissionId: submission.id,
    competitionId: competition.id,
    competitionSlug: competition.slug,
    entrantId: row.entrantId,
    entrantName: getEntrant(row.entrantId)?.name ?? '',
    number: submission.number,
    fileName: submission.fileName,
    kind: row.kind,
    cellsDone: submission.cellsDone,
    cellsTotal: submission.cellsTotal,
    startedAt: row.startedAt ?? submission.acceptedAt,
    limitMs: limitSeconds * 1000,
    container: row.container,
    baseline: row.entrantId === baselineEntrantOf(competition),
    late: row.late,
  }
}

/**
 * "run today: 37, on average 2 min 40 s", across the whole instance.
 *
 * Computed no more than once every couple of seconds and kept in memory:
 * this line is looked at from every open panel tab and from the live A3
 * stream, and under it lies a walk over all of the instance's submissions.
 */
const TODAY_TTL_MS = 2000
let todayCache: { at: number; value: { done: number; averageMs: number | null } } | null = null

function todayStats(now: number): { done: number; averageMs: number | null } {
  if (todayCache && now - todayCache.at < TODAY_TTL_MS) return todayCache.value
  const entries: DoneEntry[] = []
  for (const competition of listCompetitions()) {
    for (const submission of listSubmissions(competition.id)) {
      entries.push({
        acceptedAt: submission.acceptedAt,
        state: submission.state,
        durationMs: submission.durationMs,
      })
    }
  }
  /*
   * "Run today" ends at the same midnight as the students' daily limit: the
   * instance's (server/src/time-zone.ts). It used to be the server process's
   * own zone — UTC in a container — while the limit counted UTC regardless,
   * and at a morning lesson the two could name different days.
   */
  const value = executedToday(entries, instanceDayStart(now), now)
  todayCache = { at: now, value }
  return value
}

function queueSnapshot(now = Date.now()): QueueSnapshot {
  const pause = queuePause()
  const today = todayStats(now)
  return {
    paused: pause.paused,
    pausedAt: pause.at,
    running: runningRows()
      .map(runningNow)
      .filter((row): row is RunningNow => row !== null),
    waiting: waitingCount(),
    slots: queueSlots(),
    doneToday: today.done,
    averageMs: today.averageMs,
  }
}

/**
 * The waiting ones, in the order they will be taken, with an estimated wait.
 *
 * The queue is shared by the instance, while a screen is per competition:
 * the place is counted over the whole queue (otherwise "you are first" would
 * mean "first among your own", that is, nothing), and only this
 * competition's rows are returned. The estimate is the participant's own
 * (competitions/forecast.ts): the projector and the phone name one number.
 */
function waitingRows(competitionId: string | null, snapshot: QueueSnapshot, now: number): WaitingRow[] {
  const forecast = queueForecast(snapshot.slots, now)
  const rows: WaitingRow[] = []
  for (const queued of [...forecast.eligible, ...forecast.deferred]) {
    if (competitionId && queued.competitionId !== competitionId) continue
    const submission = getSubmission(queued.submissionId)
    const competition = getCompetition(queued.competitionId)
    if (!submission || !competition) continue
    const spot = forecast.at.get(queued.submissionId) ?? null
    rows.push({
      submissionId: submission.id,
      competitionId: competition.id,
      entrantId: queued.entrantId,
      entrantName: getEntrant(queued.entrantId)?.name ?? '',
      number: submission.number,
      // The place is over the WHOLE queue: "you are first among your own" means nothing.
      place: spot?.place ?? null,
      etaMs: spot?.etaMs ?? null,
      resourcePending: queued.notBefore > now,
      baseline: queued.entrantId === baselineEntrantOf(competition),
      late: queued.late,
    })
  }
  return rows
}

function liveOf(competition: Competition, now = Date.now()): CompetitionLive {
  const snapshot = queueSnapshot(now)
  const spans = listSubmissions(competition.id)
    .map((submission) => submission.durationMs)
    .filter((ms): ms is number => typeof ms === 'number' && ms > 0)
  return {
    revision: competition.revision ?? 0,
    counts: countsOf(competition),
    queue: snapshot,
    waiting: waitingRows(competition.id, snapshot, now),
    medianMs: medianOf(spans),
    privatePending: privateBoardState(competition, now).pending,
  }
}

/* ---------------------------------------------------------------- settings */

/**
 * The owner's competition settings, as the form reads them.
 *
 * The machine goes along with the numbers: "8 slots" means nothing without
 * "on 16 CPUs and 64 GB", and the bounds for memory and CPUs are the
 * machine's, not the editor's.
 */
function settingsView(): CompetitionSettings {
  const machine = machineShape()
  const { limits, sources } = competitionDefaults()
  return {
    slots: slotsResolution(),
    uploadsPerMinute: uploadsPerMinute(),
    defaults: limits,
    defaultSources: sources,
    machine,
    bounds: {
      slots: { min: SETTINGS_LIMITS.slots.min, max: SETTINGS_LIMITS.slots.max },
      uploadsPerMinute: { min: SETTINGS_LIMITS.uploadsPerMinute.min, max: SETTINGS_LIMITS.uploadsPerMinute.max },
      wallSeconds: { min: SETTINGS_LIMITS.wallSeconds.min, max: SETTINGS_LIMITS.wallSeconds.max },
      memoryMb: {
        min: SETTINGS_LIMITS.memoryMb.min,
        max: Math.max(SETTINGS_LIMITS.memoryMb.min, Math.min(SETTINGS_LIMITS.memoryMb.max, machine.memoryMb - HOST_RESERVE_MB)),
      },
      cpus: { min: SETTINGS_LIMITS.cpus.min, max: Math.max(1, Math.min(SETTINGS_LIMITS.cpus.max, machine.cpus)) },
      perDay: { min: SETTINGS_LIMITS.perDay.min, max: SETTINGS_LIMITS.perDay.max },
    },
  }
}

function refuseSetting(res: Response, refusal: SettingsRefusal): void {
  if (refusal.why === 'range') {
    return fail(res, 400, 'invalid', tr('competitions.refusal.range', { field: refusal.field, min: refusal.min, max: refusal.max }))
  }
  fail(res, 400, 'invalid', tr('competitions.refusal.value', { field: refusal.field }))
}

/* -------------------------------------------------------------- multipart */

interface Upload {
  name: string
  body: Buffer
}

interface Received {
  files: Upload[]
  /** Plain form fields, the last value of each name (a hidden test's target name). */
  fields: Record<string, string>
  /** The name of the file that did not fit under the cap; null means all fit. */
  oversize: string | null
  /** More files were sent than the door accepts: busboy silently dropped the extra ones. */
  tooMany: boolean
}

/**
 * Receive multipart into memory.
 *
 * Into memory, not to disk through a temp file the way a room upload does:
 * there students put the file and an instance setting sets the size; here it
 * is the teacher, and the competition has a cap of its own
 * (`LIMITS.dataBytes` for all the data, `LIMITS.notebookBytes` for the
 * notebook). The cap is exactly what makes this path honest: without it one
 * `curl` with a gigabyte file brings down the process that runs the class.
 */
function receive(
  req: Request,
  limits: { maxBytes: number; maxFiles: number },
): Promise<Received | 'not-multipart' | 'cut-off'> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) return Promise.resolve('not-multipart')
  return new Promise((resolve) => {
    let bb: ReturnType<typeof busboy>
    try {
      bb = busboy({
        headers: req.headers,
        // Otherwise the file name is read as latin-1, and `данные.csv` turns
        // into garbage, which an entrant will then not find from their notebook.
        defParamCharset: 'utf8',
        limits: {
          fileSize: limits.maxBytes,
          files: limits.maxFiles,
          fields: 8,
          fieldSize: 8192,
        },
      })
    } catch {
      return resolve('not-multipart')
    }

    const out: Received = { files: [], fields: {}, oversize: null, tooMany: false }
    let answered = false
    const done = (value: Received | 'cut-off') => {
      if (answered) return
      answered = true
      resolve(value)
    }

    bb.on('filesLimit', () => {
      out.tooMany = true
    })
    bb.on('field', (name, value, info) => {
      if (!info.valueTruncated) out.fields[name] = value
    })
    bb.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = []
      let over = false
      stream.on('limit', () => {
        over = true
        out.oversize = baseName(info.filename)
      })
      stream.on('data', (chunk: Buffer) => {
        if (!over) chunks.push(chunk)
      })
      stream.on('end', () => {
        // A truncated file is not stored at all: pandas reads half a CSV
        // without a single complaint, and the loss is noticed by the numbers
        // on the leaderboard.
        if (!over) out.files.push({ name: baseName(info.filename), body: Buffer.concat(chunks) })
      })
    })
    bb.on('error', () => done('cut-off'))
    bb.on('close', () => done(out))
    // A cut-off request: busboy will not get 'end', and the promise will
    // never resolve, and the handler will hang along with it.
    req.on('aborted', () => {
      bb.destroy()
      done('cut-off')
    })
    req.pipe(bb)
  })
}

function refuseUpload(res: Response, received: 'not-multipart' | 'cut-off'): void {
  if (received === 'not-multipart') {
    return fail(res, 400, 'invalid', tr('competitions.refusal.notMultipart'))
  }
  fail(res, 400, 'invalid', tr('competitions.refusal.uploadCutOff'))
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)

function refuseInput(res: Response, refusal: InputRefusal): void {
  if (refusal.field === 'slug') {
    return fail(res, 400, 'invalid', tr(`competitions.refusal.slug.${refusal.why}`))
  }
  if (refusal.field === 'title') {
    return fail(res, 400, 'invalid', tr('competitions.refusal.title'))
  }
  if (refusal.field === 'environment') {
    return fail(res, 400, 'invalid', tr('competitions.refusal.environment'))
  }
  if (refusal.why === 'range') {
    return fail(
      res,
      400,
      'invalid',
      tr('competitions.refusal.range', {
        field: refusal.field,
        min: refusal.min,
        max: refusal.max,
      }),
    )
  }
  fail(res, 400, 'invalid', tr('competitions.refusal.value', { field: refusal.field }))
}

/* ------------------------------------------------------------------ doors */

export function adminCompetitionRoutes(): Router {
  const router = Router()

  /*
   * The queue and the entrants are declared BEFORE `/:id`.
   *
   * express matches routes in order, and `/competitions/queue` would match
   * `/competitions/:id`. Competition ids are issued by the database, so they
   * cannot collide, but the order here is not an accident, and it must not be
   * rearranged.
   */

  /* ------------------------------------------------------------- queue */

  router.get('/api/admin/competitions/queue', requireStaff, (_req, res) => {
    res.json(queueSnapshot())
  })

  /* ---------------------------------------------------------- settings */

  router.get('/api/admin/competitions/settings', requireStaff, (_req, res) => {
    res.json(settingsView())
  })

  /**
   * Change the instance's competition settings.
   *
   * By an owner: slots decide how much of the machine the queue takes from
   * the class running next to it, and the defaults become every new
   * competition's limits — both fall on people who are not in the request.
   */
  router.put('/api/admin/competitions/settings', ownerOnly('competitions.owner.settings'), (req, res) => {
    const machine = machineShape()
    const parsed = parseSettingsInput(req.body, { ...machine, reserveMb: HOST_RESERVE_MB })
    if ('refusal' in parsed) return refuseSetting(res, parsed.refusal)
    saveCompetitionSettings(parsed.patch)
    // The audit log (admin/audit-log.ts): which of the instance's competition settings, by whom.
    recordAdminEvent({ actor: currentStaff(req), action: 'settings.competitions_changed', target: { type: 'settings', id: 'competitions' }, detail: { changed: Object.keys(parsed.patch) }, req })
    // More slots may mean work can start right now.
    wakeCompetitionPump()
    res.json(settingsView())
  })

  /**
   * Pause the queue or let it run again.
   *
   * A pause does not touch the run in progress: "start no new ones" and "kill
   * what is running" are different promises, and the second costs someone a
   * minute of work.
   */
  router.post('/api/admin/competitions/queue/pause', requireStaff, (req, res) => {
    const paused = (req.body as { paused?: unknown } | undefined)?.paused !== false
    pauseCompetitionQueue(paused, currentStaff(req)?.id ?? null)
    res.json(queueSnapshot())
  })

  /** Kill the run in progress. The "Kill" button in the "RUNNING NOW" block. */
  router.post('/api/admin/competitions/queue/kill', requireStaff, async (req, res) => {
    const id = String((req.body as { submissionId?: unknown } | undefined)?.submissionId ?? '')
    if (!queueRow(id)) {
      return fail(res, 409, 'invalid', tr('competitions.refusal.notRunning'))
    }
    // The pump takes it down: a waiting one it removes from the queue itself,
    // for a running one it kills the container and writes the outcome when it
    // dies. From here only "yes" is visible.
    const killed = await cancelSubmission(id, 'teacher')
    if (!killed) return fail(res, 409, 'failed', tr('competitions.refusal.killRefused'))
    res.json({ killed: true })
  })

  /* ---------------------------------------------------------- entrants */

  /**
   * The instance's entrant list, together with the sign-in keys.
   *
   * The key is here on purpose: the teacher hands it out to the class, and
   * there is no other place in the product where the key can be read
   * (`entrantKeyOf` is the only door to the secret). It is a panel door, and
   * that is its whole lock.
   */
  router.get('/api/admin/competitions/entrants', requireStaff, (_req, res) => {
    const body: EntrantsList = {
      entrants: listEntrants().map((entrant) => entrantRow(entrant, null, null)),
    }
    res.json(body)
  })

  /*
   * A name the teacher types obeys the same rule as one typed at the join
   * door: a Telegram username or an email address, stored in its one form
   * (shared/competitions.ts · entrantHandle). A panel that could still give
   * "Анна Ким" would bring back, one rename at a time, the free-text names
   * the rule exists to end.
   */
  router.post('/api/admin/competitions/entrants', requireStaff, (req, res) => {
    const name = entrantHandle(String((req.body as { name?: unknown } | undefined)?.name ?? ''))
    if (!name) return fail(res, 400, 'invalid', tr('competitions.refusal.nameNotHandle'))
    const minted = createEntrant(name)
    res.status(201).json({ entrant: entrantRow(minted.entrant, null, null), key: minted.key })
  })

  router.patch('/api/admin/competitions/entrants/:eid', requireStaff, (req, res) => {
    const id = String(req.params.eid)
    if (!getEntrant(id)) return fail(res, 404, 'not_found', tr('competitions.refusal.noEntrant'))
    const body = (req.body ?? {}) as { name?: unknown; disabled?: unknown }
    if (typeof body.name === 'string') {
      const name = entrantHandle(body.name)
      if (!name) return fail(res, 400, 'invalid', tr('competitions.refusal.nameNotHandle'))
      /*
       * Refused as a whole: a namesake in any of the person's competitions
       * rolls the rename back (store · renameEntrant), and the `disabled` flag
       * sent alongside is not applied either — half a request done is a
       * request whose outcome the panel cannot report.
       */
      const renamed = renameEntrant(id, name)
      if (renamed === 'taken') return fail(res, 409, 'name_taken', tr('competitions.refusal.renameTaken'))
      if (renamed === 'missing') return fail(res, 404, 'not_found', tr('competitions.refusal.noEntrant'))
    }
    if (typeof body.disabled === 'boolean') setEntrantDisabled(id, body.disabled)
    res.json({ entrant: entrantRow(getEntrant(id)!, null, null) })
  })

  /**
   * Issue a new key.
   *
   * By an owner: the old key stops working that same second, and if the
   * person is in a lesson right now, they drop out of their competition until
   * the new key reaches them.
   */
  router.post(
    '/api/admin/competitions/entrants/:eid/rotate',
    ownerOnly('competitions.owner.rotateKey'),
    (req, res) => {
      const minted = rotateEntrantKey(String(req.params.eid))
      if (!minted) return fail(res, 404, 'not_found', tr('competitions.refusal.noEntrant'))
      res.json({ entrant: entrantRow(minted.entrant, null, null), key: minted.key })
    },
  )

  /* ------------------------------------------------------ competitions */

  router.get('/api/admin/competitions', requireStaff, (_req, res) => {
    const body: CompetitionsList = {
      competitions: listCompetitions().map(rowOf),
      queue: queueSnapshot(),
    }
    res.json(body)
  })

  /** A new competition is always a draft: a separate door opens it. */
  router.post('/api/admin/competitions', requireStaff, async (req, res) => {
    const parsed = parseCompetitionInput(req.body, { creating: true })
    if ('refusal' in parsed) return refuseInput(res, parsed.refusal)
    const created = createCompetition({
      ...parsed.input,
      slug: parsed.input.slug!,
      title: parsed.input.title!,
      createdBy: currentStaff(req)?.id ?? null,
    })
    if (!created) return fail(res, 409, 'exists', tr('competitions.refusal.slug.taken'))
    ensureCompetition(created.id)
    recordAdminEvent({ actor: currentStaff(req), action: 'competition.created', target: { type: 'competition', id: created.id, label: created.title }, detail: { slug: created.slug }, req })
    res.status(201).json(await viewOf(created))
  })

  router.get('/api/admin/competitions/:id', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    res.json(await viewOf(competition))
  })

  router.patch('/api/admin/competitions/:id', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const parsed = parseCompetitionInput(req.body)
    if ('refusal' in parsed) return refuseInput(res, parsed.refusal)
    const saved = updateCompetition(competition.id, parsed.input)
    if (saved === 'taken') return fail(res, 409, 'exists', tr('competitions.refusal.slug.taken'))
    if (!saved) return fail(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    // A deadline moved later frees what was sent before it; an earlier one
    // never makes an on-time row late (store.ts · forgiveLateSubmissions).
    if (parsed.input.deadlineAt !== undefined) forgiveLateSubmissions(saved.id, DEADLINE_GRACE_MS)
    res.json(await viewOf(getCompetition(saved.id) ?? saved))
  })

  /**
   * Delete a competition entirely, together with the directory holding the
   * answers.
   *
   * By an owner: the submissions, scores and places of a hundred people
   * disappear for good, and there is nothing to restore them from.
   */
  router.delete(
    '/api/admin/competitions/:id',
    ownerOnly('competitions.owner.delete'),
    (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
      deleteCompetition(competition.id)
      recordAdminEvent({ actor: currentStaff(req), action: 'competition.deleted', target: { type: 'competition', id: competition.id, label: competition.title }, req })
      res.status(204).end()
    },
  )

  /**
   * The metric code has its own door, not a field in the common patch.
   *
   * The code editor in A2 saves with its own button and shows neither dates
   * nor limits: a PATCH with the whole form from it would overwrite fields it
   * never saw.
   */
  router.put('/api/admin/competitions/:id/metric', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const parsed = parseCompetitionInput({ metric: req.body })
    if ('refusal' in parsed) return refuseInput(res, parsed.refusal)
    const saved = updateCompetition(competition.id, { metric: parsed.input.metric })
    if (!saved || saved === 'taken') {
      return fail(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    }
    res.json(await viewOf(saved))
  })

  /* ------------------------------------------------------------ data */

  router.post('/api/admin/competitions/:id/files', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const room = LIMITS.dataBytes - openFileBytes(competition.id)
    if (room <= 0) {
      return fail(res, 413, 'too_long', tr('competitions.refusal.dataFull', { mb: mb(LIMITS.dataBytes) }))
    }
    const received = await receive(req, { maxBytes: room, maxFiles: FILES_PER_UPLOAD })
    if (typeof received === 'string') return refuseUpload(res, received)
    if (received.oversize) {
      return fail(
        res,
        413,
        'too_long',
        tr('competitions.refusal.dataFull', { mb: mb(LIMITS.dataBytes) }),
      )
    }
    if (received.files.length === 0) {
      return fail(res, 400, 'invalid', tr('competitions.refusal.noFile'))
    }
    if (
      received.tooMany ||
      listFiles(competition.id, 'open').length + received.files.length > LIMITS.files
    ) {
      return fail(res, 409, 'too_long', tr('competitions.refusal.tooManyFiles', { max: LIMITS.files }))
    }
    /*
     * The busboy cap is per EACH file, while space is counted per
     * competition.
     *
     * Ten files of a hundred megabytes pass one by one and together make a
     * gigabyte, so the sum is checked here, before the first write to disk:
     * otherwise part of the set would already be in `data/`, and an entrant
     * would see half the data.
     */
    const arriving = received.files.reduce((sum, file) => sum + file.body.length, 0)
    if (arriving > room) {
      return fail(
        res,
        413,
        'too_long',
        tr('competitions.refusal.dataFull', { mb: mb(LIMITS.dataBytes) }),
      )
    }
    for (const file of received.files) {
      const shape = file.name.toLowerCase().endsWith('.csv') ? csvShape(file.body) : null
      try {
        // First the disk, then the row: a file that did not make it into place
        // must not be listed where the used space is counted.
        putOpenFile(competition.id, file.name, file.body)
      } catch {
        return fail(res, 400, 'invalid', tr('competitions.refusal.badName', { name: file.name }))
      }
      putFile({
        competitionId: competition.id,
        name: file.name,
        bytes: file.body.length,
        rows: shape?.rows ?? null,
        visibility: 'open',
      })
    }
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /** Download an open file, the same one an entrant sees. The answers do not come here. */
  router.get('/api/admin/competitions/:id/files/:name', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const name = String(req.params.name)
    /*
     * Visibility is checked BY THE DATABASE ROW, not by the directory.
     *
     * The name comes from the address, and the anchored file system would
     * reject `../secret/solution.csv` too, but with a read error, that is,
     * the right answer would depend on what lies on disk today. Here it is
     * said plainly: only what is marked open goes out.
     */
    const listed = listFiles(competition.id, 'open').find((file) => file.name === name)
    if (!listed) return fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
    const bytes = readOpenFile(competition.id, name)
    if (!bytes) return fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`)
    res.end(bytes)
  })

  router.delete('/api/admin/competitions/:id/files/:name', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const name = String(req.params.name)
    const listed = listFiles(competition.id, 'open').find((file) => file.name === name)
    if (!listed) return fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
    dropOpenFile(competition.id, name)
    dropFile(competition.id, name, 'open')
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /**
   * The answers have a door separate from the open data.
   *
   * Not a `visibility` parameter on the same door: mixing up the directory
   * means handing the answers to the class, and such a mistake has to look
   * like a different address, not like a different field value (the same
   * reason storage.ts has two write functions).
   */
  router.post('/api/admin/competitions/:id/solution', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const received = await receive(req, { maxBytes: LIMITS.dataBytes, maxFiles: 1 })
    if (typeof received === 'string') return refuseUpload(res, received)
    if (received.oversize) {
      return fail(res, 413, 'too_long', tr('competitions.refusal.dataFull', { mb: mb(LIMITS.dataBytes) }))
    }
    const file = received.files[0]
    if (!file) return fail(res, 400, 'invalid', tr('competitions.refusal.noFile'))
    /*
     * The name on disk is always `solution.csv`.
     *
     * The metric container mounts the closed directory and reads the file
     * with this name from it; if the name came from the teacher, a renamed
     * file would break the scoring silently, after the class had already
     * started sending submissions.
     */
    const shape = csvShape(file.body)
    putSecretFile(competition.id, SOLUTION_FILE, file.body)
    putFile({
      competitionId: competition.id,
      name: SOLUTION_FILE,
      bytes: file.body.length,
      rows: shape?.rows ?? null,
      visibility: 'hidden',
    })
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /** Remove the answers. By an owner: without them the competition stops being scored at all. */
  router.delete(
    '/api/admin/competitions/:id/solution/:name',
    ownerOnly('competitions.owner.dropSolution'),
    async (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
      const name = String(req.params.name)
      const listed = listFiles(competition.id, 'hidden').find((file) => file.name === name)
      if (!listed) return fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
      dropSecretFile(competition.id, name)
      dropFile(competition.id, name, 'hidden')
      res.json(await viewOf(getCompetition(competition.id)!))
    },
  )

  /* ------------------------------------------------------- hidden test */

  /**
   * The hidden test: files the notebook reads in `data/` during the check, in
   * place of the open example of the same name.
   *
   * A door of its own, like the answers' and for the same reason: a hidden
   * test sent through the open-data door would be downloadable by the class,
   * and such a mistake must look like a different address. The target name is
   * the file's own unless the `name` field says otherwise — "upload my
   * test_full.csv as data/test.csv" — and a name may be given for one file
   * only. Staff, like the open data: it is part of building the task.
   *
   * No GET for the bytes, here or anywhere: the list travels in the view.
   */
  router.post('/api/admin/competitions/:id/sealed', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const room = LIMITS.sealedBytes - sealedFileBytes(competition.id)
    if (room <= 0) return fail(res, 413, 'too_long', tr('competitions.refusal.sealedFull', { mb: mb(LIMITS.sealedBytes) }))
    const received = await receive(req, { maxBytes: room, maxFiles: LIMITS.sealedFiles })
    if (typeof received === 'string') return refuseUpload(res, received)
    if (received.oversize) return fail(res, 413, 'too_long', tr('competitions.refusal.sealedFull', { mb: mb(LIMITS.sealedBytes) }))
    if (received.files.length === 0) return fail(res, 400, 'invalid', tr('competitions.refusal.noFile'))
    const target = (received.fields.name ?? '').trim()
    if (target && received.files.length > 1) return fail(res, 400, 'invalid', tr('competitions.refusal.sealedOneName'))
    const named = received.files.map((file) => ({ ...file, name: target || file.name }))
    const existing = new Set(listFiles(competition.id, 'sealed').map((file) => file.name))
    const fresh = new Set(named.map((file) => file.name).filter((name) => !existing.has(name)))
    if (received.tooMany || existing.size + fresh.size > LIMITS.sealedFiles) {
      return fail(res, 409, 'too_long', tr('competitions.refusal.tooManySealed', { max: LIMITS.sealedFiles }))
    }
    // The sum, before the first write: half a hidden test is a test on the wrong rows.
    const replaced = listFiles(competition.id, 'sealed')
      .filter((file) => named.some((one) => one.name === file.name))
      .reduce((sum, file) => sum + file.bytes, 0)
    if (named.reduce((sum, file) => sum + file.body.length, 0) - replaced > room) {
      return fail(res, 413, 'too_long', tr('competitions.refusal.sealedFull', { mb: mb(LIMITS.sealedBytes) }))
    }
    for (const file of named) {
      const shape = file.name.toLowerCase().endsWith('.csv') ? csvShape(file.body) : null
      try {
        // First the disk, then the row, as for the open data.
        putSealedFile(competition.id, file.name, file.body)
      } catch {
        return fail(res, 400, 'invalid', tr('competitions.refusal.badName', { name: file.name }))
      }
      putFile({ competitionId: competition.id, name: file.name, bytes: file.body.length, rows: shape?.rows ?? null, visibility: 'sealed' })
    }
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /** The hidden test as names, rows and columns — the same list the view carries. */
  router.get('/api/admin/competitions/:id/sealed', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    res.json({ sealedFiles: (await viewOf(competition)).sealedFiles ?? [] })
  })

  /** Remove a hidden-test file; the open example of the same name is the check's again from the next run. */
  router.delete('/api/admin/competitions/:id/sealed/:name', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const name = String(req.params.name)
    const listed = listFiles(competition.id, 'sealed').find((file) => file.name === name)
    if (!listed) return fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
    dropSealedFile(competition.id, name)
    dropFile(competition.id, name, 'sealed')
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  async function executionAvailable(competition: Competition, res: Response): Promise<boolean> {
    try {
      await assertCompetitionCapability('execution', competition.environment, competitionRevision(competition.id)?.imageDigest)
      return true
    } catch (error) {
      fail(res, 503, 'failed', error instanceof Error ? error.message : tr('runtime.brokerUnavailable'))
      return false
    }
  }

  /* ------------------------------------------------------ sample notebook */

  router.post('/api/admin/competitions/:id/baseline', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const received = await receive(req, { maxBytes: LIMITS.notebookBytes, maxFiles: 1 })
    if (typeof received === 'string') return refuseUpload(res, received)
    if (received.oversize) {
      return fail(
        res,
        413,
        'too_long',
        tr('competitions.refusal.tooBig', { count: mb(LIMITS.notebookBytes) }),
      )
    }
    const file = received.files[0]
    if (!file) return fail(res, 400, 'invalid', tr('competitions.refusal.noFile'))
    /*
     * The entrant's door, word for word (intake · intakeNotebook). The sample
     * notebook is checked by the same harness as every submission, so a file
     * one door takes and the other refuses is a lie at one of them, and the
     * stored bytes are the ones the check read, a byte order mark cut off.
     */
    const { body, refusal } = intakeNotebook(file.body)
    if (refusal) return fail(res, 400, 'invalid', refusal)
    putBaseline(competition.id, body)
    invalidateCompetitionInputs(competition.id)
    /*
     * The previous check is forgotten together with the file.
     *
     * Otherwise "PASSES" would stay on the screen from the old notebook, and
     * the competition could be opened on a number that a different notebook
     * got.
     */
    updateCompetition(competition.id, { baselineSubmissionId: null })
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /**
   * Check the sample notebook by the same path submissions will take.
   *
   * The same, literally: a real submission of a real (service) entrant is
   * created and put into the same queue. A separate "check mode" would prove
   * only that the check mode works.
   */
  router.post('/api/admin/competitions/:id/baseline/check', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    if (!await executionAvailable(competition, res)) return
    const notebook = readBaseline(competition.id, LIMITS.notebookBytes)
    if (!notebook) {
      return fail(res, 409, 'not_ready', tr('competitions.refusal.noBaselineFile'))
    }
    const entrantId = baselineEntrantOf(competition) ?? newBaselineEntrant()
    let revision
    try { revision = await executionRevision(competition) } catch (error) {
      // The teacher reads "check the base"; the operator needs the cause, which
      // was swallowed here (found on a bank-like cluster, 1 Oct 2026).
      console.warn(`[competitions] ${competition.id}: the environment image could not be pinned: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
      return fail(res, 503, 'failed', tr('dependencies.error.base'))
    }
    // The notebook bytes and configuration were observed before async image
    // inspection. A concurrent edit must start a fresh baseline check.
    if (getCompetition(competition.id)?.inputRevision !== competition.inputRevision) {
      return fail(res, 409, 'not_ready', tr('competitions.refusal.open.baselineNotChecked'))
    }
    let submission
    try {
      submission = acceptPinnedSubmission(competition, entrantId, NOTEBOOK_FILE, notebook.length, revision, null, { baseline: true })
      putSubmissionNotebook(competition.id, submission.id, notebook)
    } catch (error) {
      if (submission) {
        leaveQueue(submission.id)
        updateSubmission(submission.id, { state: 'cancelled', stage: 'accepted' })
      }
      return fail(res, error instanceof DependencyStoreError ? error.status : 503, 'failed',
        dependencyMessage(error instanceof DependencyStoreError ? error.code : 'dependency_image'))
    }
    updateCompetition(competition.id, { baselineSubmissionId: submission.id })
    wakeCompetitionPump()
    res.status(202).json({ submissionId: submission.id })
  })

  /**
   * Check the metric on the baseline solution, "up to 60 s", without running
   * the notebook again.
   *
   * Separate from the full check, because it is usually the metric that gets
   * fixed: rerunning a ten-minute notebook for one edit of `score()` means
   * ten minutes during which the teacher goes off to do something else.
   */
  router.post('/api/admin/competitions/:id/metric/check', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    if (!await executionAvailable(competition, res)) return
    const baseline = competition.baselineSubmissionId
      ? getSubmission(competition.baselineSubmissionId)
      : null
    if (!baseline || !rescorable(baseline.state)) {
      return fail(res, 409, 'not_ready', tr('competitions.refusal.noBaselineRun'))
    }
    enqueue({
      submissionId: baseline.id,
      competitionId: competition.id,
      entrantId: baseline.entrantId,
      kind: 'metric',
    })
    wakeCompetitionPump()
    res.status(202).json({ submissionId: baseline.id })
  })

  /* ----------------------------------------------------- open and finish */

  router.post('/api/admin/competitions/:id/open', requireStaff, async (req, res) => {
    let competition = competitionOf(req, res)
    if (!competition) return
    if (!await executionAvailable(competition, res)) return
    competition = getCompetition(competition.id)
    if (!competition) return fail(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    if (competition.state !== 'draft') {
      return fail(res, 409, 'invalid', tr('competitions.refusal.notDraft'))
    }
    const refusal = readinessOf(competition)
    if (refusal) {
      return fail(res, 409, 'not_ready', tr(`competitions.refusal.open.${refusal}`))
    }
    setCompetitionState(competition.id, 'live')
    recordAdminEvent({ actor: currentStaff(req), action: 'competition.opened', target: { type: 'competition', id: competition.id, label: competition.title }, req })
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /**
   * "Finish now": close submissions early.
   *
   * By an owner: submissions stop being accepted for the whole class. The
   * private leaderboard then opens by itself if that was the plan (`auto`):
   * for a competition that is over, the deadline is now.
   */
  router.post(
    '/api/admin/competitions/:id/finish',
    ownerOnly('competitions.owner.finish'),
    async (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
      if (competition.state !== 'live') {
        return fail(res, 409, 'invalid', tr('competitions.refusal.notLive'))
      }
      // No `openPrivateBoard` for `auto`: a finished competition opens its
      // private board by itself once the submissions accepted before the
      // finish have their results (results.ts · privateBoardState).
      setCompetitionState(competition.id, 'finished')
      recordAdminEvent({ actor: currentStaff(req), action: 'competition.closed', target: { type: 'competition', id: competition.id, label: competition.title }, req })
      res.json(await viewOf(getCompetition(competition.id)!))
    },
  )

  /** Open the private leaderboard by hand: "I will open it manually, at the review". */
  router.post('/api/admin/competitions/:id/private-board', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    openPrivateBoard(competition.id)
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /* ----------------------------------------------------------- live (A3) */

  router.get('/api/admin/competitions/:id/live', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    res.json(liveOf(competition))
  })

  /*
   * The same, but pushed by itself.
   *
   * Server-sent events, like the live environment build log: a one-way
   * stream, the browser reconnects by itself, and no second protocol for the
   * sake of three numbers. It is sent on change, not on a timer: a screen
   * where nothing happens must not redraw every second.
   */
  router.get('/api/admin/competitions/:id/stream', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // By default the relay buffers the response, that is, turns a live
      // screen into one packet at the end of the lesson.
      'X-Accel-Buffering': 'no',
    })
    let last = ''
    const push = () => {
      const fresh = getCompetition(competition.id)
      if (!fresh) return
      const body = JSON.stringify(liveOf(fresh))
      if (body === last) return
      last = body
      res.write(`event: state\ndata: ${body}\n\n`)
    }
    push()
    const tick = setInterval(push, 1500)
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000)
    req.on('close', () => {
      clearInterval(tick)
      clearInterval(beat)
    })
  })

  /* ------------------------------------------------------ submissions feed */

  // The board is computed from complete server state; the feed is only a page.
  // Places are the class's own (`placesByScore`): the baseline row is drawn
  // apart and takes nobody's, and a tie is ranked by time, a place per row —
  // the number each person reads on their own screen, and the arrows are
  // computed from it.
  router.get('/api/admin/competitions/:id/leaderboard', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const baseline = baselineEntrantOf(competition)
    const names = new Map(listCompetitionEntrants(competition.id).map((entrant) => [entrant.id, entrant.name]))
    const board = (part: 'public' | 'private') =>
      placesByScore(leaderboard(competition.id, part).filter((row) => row.entrantId !== baseline))
        .map((row) => ({ ...row, entrantName: names.get(row.entrantId) ?? getEntrant(row.entrantId)?.name ?? '' }))
    res.json({ revision: competition.revision ?? 0, public: board('public'), private: board('private'), baseline: baselineView(competition) })
  })

  router.get('/api/admin/competitions/:id/submissions', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const baselineEntrant = baselineEntrantOf(competition)
    const best = leaderboard(competition.id, 'public').filter(
      (row) => row.entrantId !== baselineEntrant,
    )[0]
    const wantedState = String(req.query.state ?? '')
    const wantedEntrant = String(req.query.entrant ?? '')
    // `late=1` — late submissions only, `late=0` — on-time only; absent — both.
    const wantedLate = req.query.late === '1' ? true : req.query.late === '0' ? false : null
    const needle = String(req.query.q ?? '').trim().toLowerCase()
    const names = new Map(listCompetitionEntrants(competition.id).map((it) => [it.id, it.name]))

    const all = listSubmissions(competition.id)
      .filter((submission) => {
        if (wantedState && submission.state !== wantedState) return false
        if (wantedEntrant && submission.entrantId !== wantedEntrant) return false
        if (wantedLate !== null && !!submission.late !== wantedLate) return false
        if (!needle) return true
        const name = (names.get(submission.entrantId) ?? '').toLowerCase()
        return name.includes(needle) || submission.fileName.toLowerCase().includes(needle)
      })
      .sort((a, b) => b.acceptedAt - a.acceptedAt || b.number - a.number)

    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0)
    const limit = Math.min(FEED_PAGE, Math.max(1, Number(req.query.limit ?? FEED_PAGE) || FEED_PAGE))
    const body: SubmissionFeed = {
      total: all.length,
      rows: all.slice(offset, offset + limit).map((submission): SubmissionRow => ({
        submission: publicExecution(submission, competition.environment),
        entrantName: names.get(submission.entrantId) ?? getEntrant(submission.entrantId)?.name ?? '',
        baseline: submission.entrantId === baselineEntrant,
        best: best?.submissionId === submission.id,
      })),
    }
    res.json(body)
  })

  /** "All output": the runs, the metric trace and what is left on disk. */
  router.get('/api/admin/competitions/:id/submissions/:sid', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const submission = submissionOf(competition, req, res)
    if (!submission) return
    const entrant = getEntrant(submission.entrantId)
    const body: SubmissionDetail = {
      submission: publicExecution(submission, competition.environment),
      entrant: { id: submission.entrantId, name: entrant?.name ?? '' },
      runs: listRuns(submission.id),
      artifacts: resultFiles(competition.id, submission.id),
    }
    res.json(body)
  })

  /** "Open the executed notebook": the file from the submission's result directory. */
  router.get(
    '/api/admin/competitions/:id/submissions/:sid/file/:name',
    requireStaff,
    (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
      const submission = submissionOf(competition, req, res)
      if (!submission) return
      const name = String(req.params.name)
      let bytes: Buffer | null = null
      try {
        bytes = readResultFile(competition.id, submission.id, name)
      } catch {
        return fail(res, 400, 'invalid', tr('competitions.refusal.badName', { name }))
      }
      if (!bytes) return fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
      res.setHeader(
        'content-type',
        name.endsWith('.ipynb') || name.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8',
      )
      res.end(bytes)
    },
  )

  /** "Run again": the same notebook, a new container, from scratch. */
  router.post(
    '/api/admin/competitions/:id/submissions/:sid/rerun',
    requireStaff,
    async (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
    if (!await executionAvailable(competition, res)) return
      const submission = submissionOf(competition, req, res)
      if (!submission) return
      /*
       * The pump decides, not the panel.
       *
       * It also knows two circumstances not visible from here: whether the
       * submission is running right now (a running one must not be
       * restarted) and whether the sent notebook is still on disk: the sweep
       * of old submissions removes it, leaving the numbers in the database.
       */
      if (!rerunSubmission(submission.id)) {
        return fail(res, 409, 'invalid', tr('competitions.refusal.cannotRerun'))
      }
      res.status(202).json({ submissionId: submission.id })
    },
  )

  /** Rescore one submission's metric; the notebook is not run. */
  router.post(
    '/api/admin/competitions/:id/submissions/:sid/rescore',
    requireStaff,
    async (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
    if (!await executionAvailable(competition, res)) return
      const submission = submissionOf(competition, req, res)
      if (!submission) return
      /*
       * Without its answer on disk (the sweep of a long-finished competition
       * took it, housekeeping.ts) the rescore could only end in "metric
       * failed" and drop a scored row from the board: refused here instead,
       * the way "run again" refuses without its notebook.
       */
      if (!rescorable(submission.state) || !hasStoredAnswer(competition.id, submission.id)) {
        return fail(res, 409, 'invalid', tr('competitions.refusal.notRescorable'))
      }
      updateSubmission(submission.id, {
        state: 'queued',
        stage: 'score',
        participantError: null,
        teacherError: null,
        errorType: null,
      })
      enqueue({
        submissionId: submission.id,
        competitionId: competition.id,
        entrantId: submission.entrantId,
        kind: 'metric',
      })
      wakeCompetitionPump()
      res.status(202).json({ submissionId: submission.id })
    },
  )

  /**
   * "Drop from the standings": remove a submission from scoring.
   *
   * By an owner: it is someone else's result and someone else's place on the
   * leaderboard. The "scored" mark is not removed separately: only one that
   * reached a number counts as scored (`countedSubmission`), and this one
   * will not reach it any more.
   */
  router.post(
    '/api/admin/competitions/:id/submissions/:sid/drop',
    ownerOnly('competitions.owner.dropSubmission'),
    async (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
      const submission = submissionOf(competition, req, res)
      if (!submission) return
      // If it is still running, first take it off execution: keeping a
      // container for a submission that no longer counts means holding up the
      // queue.
      if (queueRow(submission.id)) await cancelSubmission(submission.id, 'teacher')
      leaveQueue(submission.id)
      const note = tr('competitions.note.droppedByTeacher')
      // Our own words: safe for a blind participant to read as they are.
      const saved = updateSubmission(submission.id, { state: 'cancelled', participantError: note, briefError: note })
      res.json({ submission: saved })
    },
  )

  /**
   * Rescore everyone, after a metric edit.
   *
   * The notebooks are not run: the entrants' answers lie on disk, and that
   * is the whole point of two steps. Only what has that answer goes into the
   * queue.
   */
  router.post('/api/admin/competitions/:id/rescore', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    if (!await executionAvailable(competition, res)) return
    // The pump counts: a submission qualifies if its answer IS ON DISK, and
    // that is a question for the files, not for the row's state.
    res.status(202).json({ queued: rescoreCompetition(competition.id) })
  })

  /**
   * The "Entrants" tab of one competition: place, submissions, sign-in key.
   *
   * The place is the leaderboard tab's and the person's own: among people.
   * Taken straight from the store it counted the baseline as a row, and
   * everyone below the baseline stood one lower here than on the tab next
   * door.
   */
  router.get('/api/admin/competitions/:id/entrants', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const baselineEntrant = baselineEntrantOf(competition)
    const board = placesAmongPeople(leaderboard(competition.id, 'public'), (row) => row.entrantId === baselineEntrant)
    const body: EntrantsList = {
      entrants: listCompetitionEntrants(competition.id).map((entrant) => ({
        ...entrantRow(
          entrant,
          competition,
          entrant.id === baselineEntrant ? 'baseline' : null,
          board.find((row) => row.entrantId === entrant.id)?.place ?? null,
        ),
        // What the confirmation says about the key: it keeps working there.
        otherCompetitions: competitionsElsewhere(entrant.id, competition.id),
      })),
    }
    res.json(body)
  })

  /**
   * Remove a person from this competition: their submissions with every file
   * the server keeps about them, their package sets, their place on the
   * boards, and — when they take part nowhere else — the person with their
   * key (competitions/erase.ts says what goes and why).
   *
   * Staff, not owner only, unlike the other doors that fall on people who are
   * not in the request: a student asking their teacher to be erased should
   * not have to wait for the one person who owns the instance, and the
   * confirmation in the panel names the person and how many submissions go.
   * A running submission is killed and waited for; one that does not stop in
   * time refuses the whole removal, with nothing removed.
   */
  router.delete('/api/admin/competitions/:id/entrants/:eid', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const outcome = await deleteEntrantFromCompetition(competition.id, String(req.params.eid))
    if (!outcome.ok) {
      if (outcome.why === 'not_found') return fail(res, 404, 'not_found', tr('competitions.refusal.noEntrant'))
      if (outcome.why === 'baseline') return fail(res, 409, 'invalid', tr('competitions.refusal.entrantBaseline'))
      return fail(res, 409, 'failed', tr('competitions.refusal.entrantRunning'))
    }
    // The id and the counts only: a log that kept the name would keep exactly
    // what the removal was asked to take away.
    recordAdminEvent({
      actor: currentStaff(req),
      action: 'competition.entrant_deleted',
      target: { type: 'entrant', id: String(req.params.eid) },
      detail: { competition: competition.id, submissions: outcome.submissions, identityRemoved: outcome.identityRemoved },
      req,
    })
    const body: EntrantRemoved = { submissions: outcome.submissions, identityRemoved: outcome.identityRemoved }
    res.json(body)
  })

  return router
}

/* -------------------------------------------------------------- helpers */

/**
 * The service entrant the sample notebook is recorded under.
 *
 * Disabled right away: it does have a key (`createEntrant` issues one), and
 * a working key nobody knows about is an entrance to the competition lying
 * in the database without an owner.
 */
function newBaselineEntrant(): string {
  const minted = createEntrant(tr('competitions.baselineEntrant'))
  setEntrantDisabled(minted.entrant.id, true)
  return minted.entrant.id
}

function entrantRow(
  entrant: Entrant,
  competition: Competition | null,
  kind: 'baseline' | null = null,
  place: number | null = null,
): EntrantRow {
  return {
    ...entrant,
    key: entrantKeyOf(entrant.id),
    submissions: competition ? listEntrantSubmissions(competition.id, entrant.id).length : 0,
    place,
    baseline: kind === 'baseline',
  }
}

/**
 * What is left of a run on disk: a list, not the contents.
 *
 * `stat` is read, not the file itself: an executed notebook with charts is
 * megabytes of base64, and there is no point opening them in server memory
 * for the sake of a "present" line. The sweep of old submissions
 * (`pruneCompetitionFiles`) keeps the row in the database and removes the
 * directory, so an empty list is normal here.
 */
function resultFiles(competitionId: string, submissionId: string): { name: string; bytes: number }[] {
  const out: { name: string; bytes: number }[] = []
  // The executed copy under its own name: under the sent notebook's name `out/` has nothing.
  for (const name of [EXECUTED_FILE, 'run.json', 'progress.json', 'submission.csv']) {
    try {
      const info = competitionsFs.statSync(path.join(resultDir(competitionId, submissionId), name))
      out.push({ name, bytes: info.size })
    } catch {
      /* no file: the run did not get that far, or the directory was removed */
    }
  }
  return out
}
