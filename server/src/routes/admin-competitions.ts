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
 * columns of the answers (that is how A2 is drawn); nobody sees the bytes,
 * and the materials archive (competitions/materials-zip.ts) names them the
 * same way. The hidden test is uploaded, listed and removed here and read by
 * the notebook during the check; no entrant ever downloads it, and the
 * teachers who may open the competition do — a file at a time or in the
 * materials archive — each time with a row in the audit log.
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
import { assertCompetitionCapability, competitionCapabilities, notebookNeeds, type CompetitionNeeds } from '../competitions/capabilities.js'
import { submissionUsesCurrentBase } from '../competitions/provenance.js'
import { competitionRevision, policyOf } from '../dependencies/store.js'
import { DependencyStoreError } from '../dependencies/store.js'
import { dependencyMessage } from '../dependencies/messages.js'
import { currentStaff, ownerOnly, requireStaff } from '../admin/auth.js'
import { getTeacher } from '../admin/store.js'
import { instanceDayStart } from '../time-zone.js'
import { deleteEntrantFromCompetition, SETTLE_MS } from '../competitions/erase.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import { canSeeCourse, isOwner, type StaffLike } from '../admin/access.js'
import { getCourse } from '../publish/store.js'
import { canSeeCompetition, canSeeCompetitionId, courseRefOf, entrantReach } from '../competitions/scope.js'
import {
  acceptSubmission,
  competitionsElsewhere,
  competitionSummary,
  invalidateCompetitionInputs,
  createCompetition,
  createEntrant,
  deleteCompetition,
  entrantCompetitionIds,
  dropFile,
  entrantKeyOf,
  findCompetition,
  getCompetition,
  getEntrant,
  getSubmission,
  joinAsNewcomer,
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
  cardWorkWaiting,
  heldRows,
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
  holdOpenFile,
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
  sealedDir,
  type StoredFile,
} from '../competitions/storage.js'
import type { HeldFile } from '../secure-files.js'
import { disposition, sendArchive } from '../publish/zip-send.js'
import { materialsTop, materialsZipPlan, type MaterialsInput } from '../competitions/materials-zip.js'
import { submissionCeilingNow } from '../competitions/executors.js'
import {
  executedToday,
  gpuEnvironmentRefusal,
  medianOf,
  openRefusal,
  parseCompetitionInput,
  rescorable,
  withoutBaseline,
  type DoneEntry,
  type InputRefusal,
} from '../competitions/panel.js'
import { queueForecast, runnerGpuPicture } from '../competitions/forecast.js'
import { competitionMix, competitionWhere, consoleGroups, heldRunView, placeMix, remoteFleet, type WaitReason } from '../competitions/remote/views.js'
import { anyRunnerEver } from '../competitions/remote/store.js'
import { DEADLINE_GRACE_MS, privateBoardState } from '../competitions/results.js'
import { machineShape, slotsResolution } from '../competitions/capacity.js'
import { competitionDefaults, homeNotebooksAfter, homeNotebooksSetting, parseSettingsInput, runnerSettings, saveCompetitionSettings, uploadsPerMinute, type SettingsRefusal } from '../competitions/settings.js'
import { competitionGpuSliceMb, environmentNeedsGpu, gpuSettingsView, placesTaken, runnerCardsHere, runnerGpuDevices, runnerGpuPerDevice } from '../competitions/gpu.js'
import { gpuDevices } from '../kernel/pool.js'
import { HOST_RESERVE_MB } from '../kernel/resources.js'
import { baseName, csvShape, csvUsageSplit, intakeNotebook, notebookCells } from '../competitions/intake.js'
import {
  LIGHT_METRIC_ENVIRONMENT,
  cancelSubmission,
  hasStoredAnswer,
  metricScoringImage,
  moveMetricToLightImage,
  pauseCompetitionQueue,
  queueSlots,
  rerunSubmission,
  rescoreCompetition,
  scoresInPin,
  stopCompetitionRuns,
  wakeCompetitionPump,
} from '../competitions/runner.js'
import type { QueueRow } from '../competitions/store.js'
import { METRIC_WALL_SECONDS } from '../competitions/runner-port.js'
import type { AdminErrorBody, AdminErrorReason } from '@shared/admin'
import { SETTINGS_LIMITS, type CeilingSource, type CompetitionSettings } from '@shared/competitions-settings'
import {
  LIMITS,
  competitionPhase,
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

/**
 * The competition the address names — if the caller runs it.
 *
 * The scope check lives HERE, in the one lookup every per-competition door
 * goes through, rather than in each of them: a door added later inherits it
 * without anyone remembering. Someone else's competition answers exactly like
 * a missing one, so a guessed slug tells nothing about what exists
 * (competitions/scope.ts has the rule).
 */
function competitionOf(req: Request, res: Response): Competition | null {
  const found = findCompetition(String(req.params.id ?? ''))
  if (!found || !canSeeCompetition(currentStaff(req), found)) {
    fail(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    return null
  }
  return found
}

/**
 * «Курс» from the form: absent, null, or a course the caller teaches. An owner
 * may pick any existing course. A course the caller cannot see answers like a
 * missing one. Returns false when it has already refused.
 */
function courseAllowed(staff: StaffLike | null, courseId: string | null | undefined, res: Response): boolean {
  if (courseId === undefined || courseId === null) return true
  if (!getCourse(courseId) || !canSeeCourse(staff, courseId)) {
    fail(res, 404, 'not_found', tr('server.courseNotFound.0429ec'))
    return false
  }
  return true
}

/**
 * What a teacher's download of a competition's file says about caching: kept
 * nowhere. These doors stand behind a staff cookie, and the hidden test or a
 * sample notebook kept by a shared proxy or by a classroom PC's disk cache
 * is one that left the server past its audit row.
 */
const STAFF_FILE_CACHE = 'private, no-store'

/**
 * A competition's file to a teacher, held and streamed with byte ranges, as
 * `attachment` under `name` — as the entrant's door hands out the open data
 * (secure-files.ts · downloadHeldFile), but stored nowhere and validated by
 * nothing: STAFF_FILE_CACHE, no ETag, no Last-Modified. With no validator
 * there is no 304 either, so a GET always sends bytes, which is what the
 * hidden test's audit row says. A file its row names but the disk no longer
 * has is the same 404 as one never listed. `false` — it was refused, and
 * nothing went out.
 */
function sendFile(res: Response, hold: () => HeldFile, name: string): boolean {
  let file: HeldFile
  try {
    file = hold()
  } catch {
    fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
    return false
  }
  res.type(name)
  try {
    res.download(
      file.path,
      name,
      { dotfiles: 'allow', etag: false, lastModified: false, cacheControl: false, headers: { 'Cache-Control': STAFF_FILE_CACHE } },
      (error) => {
        file.close()
        if (error && !res.headersSent) fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
      },
    )
  } catch (error) {
    file.close()
    throw error
  }
  return true
}

/**
 * The hidden test left the server for a teacher (the audit log): who, when,
 * which of its files, and by which door — its own (`file`) or the materials
 * archive. Its bytes have no other way out of the competition's folder.
 *
 * Only a GET: a HEAD sends no bytes, and download managers and link checkers
 * send one before (or instead of) the download. Every GET is a row, a byte
 * range too: `Range: bytes=1-` is the whole file but its first byte.
 */
function recordHiddenTestDownload(req: Request, competition: Competition, files: string[], via: 'file' | 'archive'): void {
  if (req.method !== 'GET') return
  recordAdminEvent({
    actor: currentStaff(req),
    action: 'competition.hidden_test_downloaded',
    target: { type: 'competition', id: competition.id, label: competition.title },
    detail: { files, via },
    req,
  })
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

/**
 * The best counted score, once intake is over: the number a finished
 * competition's row leads with. Before the deadline the private part means
 * nothing yet, and the row keeps to the public one.
 */
function bestPrivateOf(competition: Competition, now = Date.now()): number | null {
  if (competitionPhase(competition, now) !== 'over') return null
  const baseline = baselineEntrantOf(competition)
  const rows = leaderboard(competition.id, 'private').filter((row) => row.entrantId !== baseline)
  return rows.length ? rows[0].score : null
}

function rowOf(competition: Competition, viewer: StaffLike | null): CompetitionRow {
  const counts = countsOf(competition)
  const baseline = competition.baselineSubmissionId
    ? getSubmission(competition.baselineSubmissionId)
    : null
  return {
    competition,
    entrants: counts.entrants,
    submissions: counts.submissions,
    bestPublic: counts.bestPublic,
    bestPrivate: bestPrivateOf(competition),
    ...(counts.late === undefined ? {} : { late: counts.late }),
    baselineScore: baseline?.publicScore ?? null,
    baselineState: baseline?.state ?? null,
    ready: readinessOf(competition),
    privatePending: privateBoardState(competition).pending,
    course: courseRefOf(competition.courseId, viewer),
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
  const capabilities = await competitionCapabilities(competition.environment, competitionRevision(competition.id)?.imageDigest, notebookNeeds(competition))
  competition = getCompetition(competition.id) ?? competition
  const gpuSliceMb = await competitionGpuSliceMb(competition)
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
    gpuSliceMb,
    // The metric section's «Образ метрики» row stands by where the metric scores, not by the card switch (runner.ts · scoresInPin).
    metricScoresInPin: scoresInPin(competition),
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
    // «Где считается» (M6): only once a machine was ever connected (remote/views.ts · competitionWhere).
    ...whereOf(competition),
  }
}

function whereOf(competition: Competition): Pick<CompetitionView, 'where'> {
  const where = competitionWhere(competition, queueSlots())
  return where ? { where } : {}
}

/**
 * What the materials archive is made of (competitions/materials-zip.ts): the
 * editor's own view of the competition — its files with their rows and
 * columns, the split, the sample notebook's card — so the archive says what
 * the screen says, and the base and the package policy the editor's
 * dependencies section shows. The course by name, as the viewer's list row
 * names it (courseRefOf).
 */
async function materialsOf(competition: Competition, viewer: StaffLike | null): Promise<MaterialsInput> {
  const view = await viewOf(competition)
  return {
    competition: view.competition,
    openFiles: view.openFiles,
    hiddenFiles: view.hiddenFiles,
    sealedFiles: view.sealedFiles ?? [],
    split: view.split,
    baseline: view.baseline,
    course: courseRefOf(view.competition.courseId, viewer)?.name ?? null,
    revision: competitionRevision(competition.id),
    dependencies: policyOf(competition.id),
  }
}

/* ----------------------------------------------------------------- queue */

/**
 * The card a running row holds, as the runner grid shows it.
 *
 * On this machine's cards: the one the queue took for it, with the share the
 * run was given there (QueueRow.gpuSliceMb, null until the card said its
 * size, or when it cannot) — the run's own, not what the number of runs per
 * card in force would make now: after the owner changes it, the runs already
 * on a card keep the share they were started with, and showing them the new
 * one was a number nothing enforced. Under the cluster the queue keeps no
 * card, and a GPU notebook runs on whatever unit the cluster gave it: an
 * empty device, no share of ours. The card is held until the attempt ends,
 * so a notebook's metric step still shows it.
 */
function runningCard(row: QueueRow, competition: Competition): RunningNow['gpu'] {
  // A machine's run: the card its machine gave it, as the machine reported it (remote_leases).
  if (row.holder !== null) return heldRunView(row)?.card ?? null
  if (row.gpu !== null) return { device: row.gpu, sliceMb: row.gpuSliceMb }
  if (!runnerCardsHere() && row.kind === 'notebook' && competition.limits.gpu === true) return { device: '', sliceMb: null }
  return null
}

function runningNow(row: QueueRow, viewer: StaffLike | null): RunningNow | null {
  const submission = getSubmission(row.submissionId)
  const competition = getCompetition(row.competitionId)
  if (!submission || !competition) return null
  const limitSeconds =
    row.kind === 'metric' ? METRIC_WALL_SECONDS : competition.limits.wallSeconds
  /*
   * A machine's run says which machine and how far (Paper M4): its container
   * may not have started yet. The machine is the instance's, not a course's,
   * so another course's run keeps it too — the sums per machine must add up.
   */
  const held = heldRunView(row)
  const remote: Pick<RunningNow, 'machine' | 'remotePhase'> = held ? { machine: held.machine, remotePhase: held.phase ?? 'accepted' } : {}
  if (!canSeeCompetition(viewer, competition)) {
    /*
     * Another course's run: the slot and its clock, nothing of whose. The
     * queue is the instance's, so "4 of 6 slots busy" must add up on every
     * teacher's screen, but a name and an address from a course they do not
     * teach are not theirs to read. The submission id stays — it keys the
     * row on screen and opens nothing: the kill door checks scope itself.
     * The card stays too, for the same sum over the GPU slots: which card is
     * busy is the machine's business, not anyone's.
     */
    return {
      submissionId: submission.id,
      competitionId: '',
      competitionSlug: '',
      entrantId: '',
      entrantName: '',
      number: 0,
      fileName: '',
      kind: row.kind,
      cellsDone: submission.cellsDone,
      cellsTotal: submission.cellsTotal,
      startedAt: row.startedAt ?? submission.acceptedAt,
      limitMs: limitSeconds * 1000,
      container: null,
      baseline: false,
      late: row.late,
      hidden: true,
      gpu: runningCard(row, competition),
      ...remote,
    }
  }
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
    gpu: runningCard(row, competition),
    ...remote,
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

/**
 * The instance queue as this viewer may see it: every count whole (waiting,
 * slots, run today), the running rows of competitions they do not run
 * blanked (`runningNow`).
 *
 * The runner cards come with it when any are given to submissions here
 * (competitions/forecast.ts · runnerGpuPicture): how many GPU runs may go at
 * once, how many of those places are taken — by the shares the runs were
 * given, so a card still full of runs taken at fewer per card reads full
 * (gpu.ts · placesTaken) — and the share each is promised. Under the cluster
 * there are none to count.
 *
 * And with no card given at all, while GPU notebooks wait: zero places. They
 * wait for a card nobody gave (the owner took the last one back, or the
 * switch went on after they were sent), and without the block the console
 * showed them as plain waiting, with no word of what for, while the queue
 * passed them over at every take.
 */
function queueSnapshot(viewer: StaffLike | null, now = Date.now(), competition: Competition | null = null): QueueSnapshot {
  const pause = queuePause()
  const today = todayStats(now)
  const running = runningRows()
  const cards = runnerGpuPicture(now)
  const onCards = running.flatMap((row) => row.gpu === null ? [] : [{ device: row.gpu, perDevice: row.gpuPerDevice }])
  const homeGpu = cards
    ? { slots: cards.slots, busy: placesTaken(cards.cards, onCards), sliceMb: cards.sliceMb }
    : runnerCardsHere() && cardWorkWaiting(Number.MAX_SAFE_INTEGER)
      ? { slots: 0, busy: placesTaken([], onCards), sliceMb: null }
      : null
  const snapshot: QueueSnapshot = {
    paused: pause.paused,
    pausedAt: pause.at,
    running: running
      .map((row) => runningNow(row, viewer))
      .filter((row): row is RunningNow => row !== null),
    waiting: waitingCount(),
    slots: queueSlots(),
    doneToday: today.done,
    averageMs: today.averageMs,
    gpu: homeGpu,
  }
  if (!anyRunnerEver()) return snapshot
  /*
   * WITH MACHINES (§5.7, Paper M4): the runs they hold are in `running` too,
   * the places are this server's (with its notebooks on) and every live
   * machine's, the GPU block counts their card shares beside this server's,
   * and `groups` says whose each is. Before any machine was ever connected
   * none of this is here, and the console stays as it was.
   *
   * A machine's places are counted in runs of the competition the console is
   * about (its own memory and CPUs, remote/views.ts · placesFor), or of the
   * queue's work for a screen of no one competition: in the machine's own
   * smallest runs a 61-vCPU machine showed «60 мест» for runs of two CPUs, and
   * free cells the take would never fill. A machine's run whose container has
   * not started yet has no clock: it starts at zero when it does (store.ts ·
   * holdQueueRow), never at the moment the run was sent.
   */
  const fleet = remoteFleet(now, competition ? competitionMix(competition) : placeMix(queueRows(), now))
  const held = heldRows()
  const homeOn = homeNotebooksSetting().value
  const heldGpu = held.filter((row) => getCompetition(row.competitionId)?.limits.gpu === true).length
  snapshot.running.push(...held.map((row) => runningNow(row.startedAt === null ? { ...row, startedAt: now } : row, viewer)).filter((row): row is RunningNow => row !== null))
  snapshot.slots = (homeOn ? queueSlots() : 0) + fleet.places
  if (fleet.gpuShares > 0 || heldGpu > 0) {
    const here = homeOn ? homeGpu : null
    /*
     * This server's share counts only where it gives GPU work places: with no
     * card of its own (homeGpu's zero places, kept to say GPU work waits)
     * its null is no unknown size, there is simply no share of its, and the
     * machines' known one must not read as «срез неизвестен» for it.
     */
    const slices = [here && here.slots > 0 ? here.sliceMb : undefined, fleet.gpuShares > 0 ? fleet.sliceMb : undefined].filter((slice): slice is number | null => slice !== undefined)
    snapshot.gpu = {
      slots: (here?.slots ?? 0) + fleet.gpuShares,
      busy: (here?.busy ?? 0) + heldGpu,
      sliceMb: slices.length === 0 || slices.some((slice) => slice === null) ? null : Math.min(...(slices as number[])),
    }
  }
  const devices = runnerGpuDevices()
  snapshot.groups = consoleGroups(queueSlots(), devices.length ? { count: devices.length, perDevice: runnerGpuPerDevice() } : null, now, competition ? competitionMix(competition) : placeMix(queueRows(), now))
  return snapshot
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
function waitingRows(competitionId: string | null, _snapshot: QueueSnapshot, now: number): WaitingRow[] {
  // This server's own slots: the forecast adds the machines' places itself (forecast.ts · queueForecast).
  const forecast = queueForecast(queueSlots(), now)
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
      // The queue's own rule of who needs a card share (store.ts · selectNext, forecast.ts · cardNeeds).
      gpu: queued.kind === 'notebook' && competition.limits.gpu === true,
      // A machine's reason it waits for (remote/views.ts · waitReasons), and a fresh result's metric («оценивается»).
      ...waitReasonOf(forecast.reasons.get(queued.submissionId)),
      ...(queued.kind === 'metric' && submission.state === 'running' ? { scoring: true } : {}),
    })
  }
  return rows
}

function waitReasonOf(reason: WaitReason | undefined): Pick<WaitingRow, 'reason' | 'returnedFrom' | 'returnedWhy' | 'tooBig'> {
  if (!reason) return {}
  return {
    reason: reason.reason,
    ...(reason.returnedFrom !== undefined ? { returnedFrom: reason.returnedFrom } : {}),
    ...(reason.returnedWhy !== undefined ? { returnedWhy: reason.returnedWhy } : {}),
    // Left to the machines for its size (runner.ts · leftToMachines): the console's words say this server is too small.
    ...(reason.tooBig ? { tooBig: true } : {}),
  }
}

function liveOf(competition: Competition, viewer: StaffLike | null, now = Date.now()): CompetitionLive {
  // The machines' places in runs of this competition's own size (queueSnapshot).
  const snapshot = queueSnapshot(viewer, now, competition)
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
 * "on 16 CPUs and 64 GB". So do its cards: which of KERNEL_GPUS went to
 * submissions, what each one is and how big a run's share comes out — read
 * from the cards themselves, which may take a few seconds on a cold server
 * (kernel/resources.ts · gpuCards), hence asynchronous.
 *
 * The bounds for memory and CPUs are not the editor's but the executors'
 * (competitions/settings.ts · submissionCeiling): the CPUs the biggest of
 * this server and the machines that run its submissions, the memory this
 * server's while it runs notebooks — and `ceiling` says which, the machine
 * by name for an owner, whose list the machines are.
 */
async function settingsView(viewer: StaffLike | null): Promise<CompetitionSettings> {
  const machine = machineShape()
  const { limits, sources } = competitionDefaults()
  const ceiling = submissionCeilingNow()
  const gpu = await gpuSettingsView()
  const sourceOf = (one: { machine: string | null }): CeilingSource =>
    one.machine === null ? { from: 'home' } : { from: 'machine', name: isOwner(viewer) ? one.machine : null }
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
      memoryMb: { min: SETTINGS_LIMITS.memoryMb.min, max: ceiling.memoryMb.max },
      cpus: { min: SETTINGS_LIMITS.cpus.min, max: ceiling.cpus.max },
      perDay: { min: SETTINGS_LIMITS.perDay.min, max: SETTINGS_LIMITS.perDay.max },
    },
    ceiling: { cpus: sourceOf(ceiling.cpus), memoryMb: sourceOf(ceiling.memoryMb) },
    gpu,
    // The machines' half of the same box (competitions/settings.ts · runnerSettings): saved through the same PUT.
    runners: runnerSettings(),
  }
}

function refuseSetting(res: Response, refusal: SettingsRefusal): void {
  if (refusal.why === 'device') {
    return fail(res, 400, 'invalid', tr('server.competitions.gpuUnknownDevice', { device: refusal.device }))
  }
  if (refusal.why === 'managed') {
    // The same answer the environments door gives under the cluster: not a typo, the wrong place.
    return fail(res, 409, 'managed_environment', tr('server.competitions.gpuManaged'))
  }
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
  // Before the field checks: this one names `limits.gpu` but is about the environment too.
  if (refusal.why === 'cpuEnvironment') {
    return fail(res, 400, 'invalid', tr('server.competitions.gpuCpuEnvironment', { environment: refusal.environment }))
  }
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

  router.get('/api/admin/competitions/queue', requireStaff, (req, res) => {
    res.json(queueSnapshot(currentStaff(req)))
  })

  /* ---------------------------------------------------------- settings */

  router.get('/api/admin/competitions/settings', requireStaff, (req, res, next) => {
    settingsView(currentStaff(req))
      .then((body) => res.json(body))
      .catch(next)
  })

  /**
   * Change the instance's competition settings.
   *
   * By an owner: slots decide how much of the machine the queue takes from
   * the class running next to it, and the defaults become every new
   * competition's limits — both fall on people who are not in the request.
   * The cards even more so: a card given to submissions is a card no class
   * can start on from that moment.
   */
  router.put('/api/admin/competitions/settings', ownerOnly('competitions.owner.settings'), (req, res, next) => {
    const machine = machineShape()
    // Cores and memory by the executors (submissionCeiling), the form's own
    // bounds (settingsView) — of «Тетради на этом сервере» as this save leaves
    // it, which the same body may turn (settings.ts · homeNotebooksAfter).
    const ceiling = submissionCeilingNow(homeNotebooksAfter(req.body, homeNotebooksSetting().value))
    const parsed = parseSettingsInput(req.body, {
      ...machine,
      reserveMb: HOST_RESERVE_MB,
      gpus: gpuDevices(),
      gpuManaged: !runnerCardsHere(),
      ceiling: { cpus: ceiling.cpus.max, memoryMb: ceiling.memoryMb.max },
    })
    if ('refusal' in parsed) return refuseSetting(res, parsed.refusal)
    saveCompetitionSettings(parsed.patch)
    // The audit log (admin/audit-log.ts): which of the instance's competition settings, by whom.
    recordAdminEvent({ actor: currentStaff(req), action: 'settings.competitions_changed', target: { type: 'settings', id: 'competitions' }, detail: { changed: Object.keys(parsed.patch) }, req })
    // More slots (or a card) may mean work can start right now.
    wakeCompetitionPump()
    settingsView(currentStaff(req))
      .then((body) => res.json(body))
      .catch(next)
  })

  /**
   * Pause the queue or let it run again.
   *
   * A pause does not touch the run in progress: "start no new ones" and "kill
   * what is running" are different promises, and the second costs someone a
   * minute of work.
   *
   * By an owner: there is one queue per instance, so a pause stops every
   * course's competitions, not only the caller's — it falls on people who are
   * not in the request.
   */
  router.post('/api/admin/competitions/queue/pause', ownerOnly('competitions.owner.pause'), (req, res) => {
    const paused = (req.body as { paused?: unknown } | undefined)?.paused !== false
    pauseCompetitionQueue(paused, currentStaff(req)?.id ?? null)
    res.json(queueSnapshot(currentStaff(req)))
  })

  /**
   * Kill the run in progress. The "Kill" button in the "RUNNING NOW" block.
   *
   * Only in a competition the caller runs: the id comes bare from the body,
   * and another course's run answers like one that already ended, so the
   * door does not confirm that it exists.
   */
  router.post('/api/admin/competitions/queue/kill', requireStaff, async (req, res) => {
    const body = req.body as { submissionId?: unknown; onMachine?: unknown } | undefined
    const id = String(body?.submissionId ?? '')
    const queued = queueRow(id)
    if (!queued || !canSeeCompetitionId(currentStaff(req), queued.competitionId)) {
      return fail(res, 409, 'invalid', tr('competitions.refusal.notRunning'))
    }
    /*
     * A stop aimed at a run on a machine («Работают сейчас», a machine's
     * page, a machine's cell in the console: `onMachine`) stops only a run
     * whose notebook is still there — taken by a machine and not yet past
     * its container (RemoteAttemptPhase accepted, preparing, running). The
     * lists it was pressed from are seconds old: meanwhile the notebook may
     * have finished, its answer travelling here (exporting, uploading) or
     * applied and waiting for its metric as a `kind='metric'` row with no
     * holder — and cancelSubmission took that row's `waiting` branch and
     * threw the finished result away, counted as «снята на машине». Decided
     * here, in the same turn as the cancel itself, so no outcome applied
     * between the two can slip under it.
     */
    if (body?.onMachine === true) {
      const held = queued.state === 'running' && queued.holder !== null ? heldRunView(queued) : null
      if (!held || held.phase === 'exporting' || held.phase === 'uploading') {
        return fail(res, 409, 'invalid', tr('competitions.refusal.notOnMachine'))
      }
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
   * (`entrantKeyOf` is the only door to the secret).
   *
   * By an owner: it is every person on the instance with a working key, and
   * a teacher's view of people goes through the competitions they run (the
   * "Entrants" tab of each). The panel itself does not call this door.
   */
  router.get('/api/admin/competitions/entrants', ownerOnly('competitions.owner.entrants'), (_req, res) => {
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
   *
   * This door makes a person who belongs to no competition, so by an owner
   * only: such a person is visible to nobody else. A teacher adds people
   * through the competition (POST /:id/entrants below).
   */
  router.post('/api/admin/competitions/entrants', ownerOnly('competitions.owner.entrantAnywhere'), (req, res) => {
    const name = entrantHandle(String((req.body as { name?: unknown } | undefined)?.name ?? ''))
    if (!name) return fail(res, 400, 'invalid', tr('competitions.refusal.nameNotHandle'))
    const minted = createEntrant(name)
    res.status(201).json({ entrant: entrantRow(minted.entrant, null, null), key: minted.key })
  })

  /*
   * Rename or switch off a person — everywhere at once, since a person has
   * one name and one key per instance. So a teacher may do it only when every
   * competition of the person is theirs; a person they do not see at all is
   * `not_found`, and one who also sits in another course's competition is
   * the owner's to change.
   */
  router.patch('/api/admin/competitions/entrants/:eid', requireStaff, (req, res) => {
    const id = String(req.params.eid)
    if (!getEntrant(id)) return fail(res, 404, 'not_found', tr('competitions.refusal.noEntrant'))
    const reach = entrantReach(currentStaff(req), id)
    if (reach === 'none') return fail(res, 404, 'not_found', tr('competitions.refusal.noEntrant'))
    if (reach === 'some') return fail(res, 403, 'forbidden', tr('competitions.refusal.entrantShared'))
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

  /**
   * The competitions the caller runs (competitions/scope.ts): an owner's list
   * is the whole instance, a teacher's is what they created and what their
   * courses hold. The rows are filtered before their counts are computed —
   * those walk the submissions.
   */
  router.get('/api/admin/competitions', requireStaff, (req, res) => {
    const staff = currentStaff(req)
    const body: CompetitionsList = {
      competitions: listCompetitions()
        .filter((competition) => canSeeCompetition(staff, competition))
        .map((competition) => rowOf(competition, staff)),
      queue: queueSnapshot(staff),
    }
    res.json(body)
  })

  /** A new competition is always a draft: a separate door opens it. */
  router.post('/api/admin/competitions', requireStaff, async (req, res) => {
    const parsed = parseCompetitionInput(req.body, { creating: true })
    if ('refusal' in parsed) return refuseInput(res, parsed.refusal)
    const gpu = gpuEnvironmentRefusal(parsed.input, null, environmentNeedsGpu)
    if (gpu) return refuseInput(res, gpu)
    const staff = currentStaff(req)
    if (!courseAllowed(staff, parsed.input.courseId, res)) return
    const created = createCompetition({
      ...parsed.input,
      slug: parsed.input.slug!,
      title: parsed.input.title!,
      createdBy: staff?.id ?? null,
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
    const gpu = gpuEnvironmentRefusal(parsed.input, competition, environmentNeedsGpu)
    if (gpu) return refuseInput(res, gpu)
    const staff = currentStaff(req)
    if (parsed.input.courseId !== undefined && parsed.input.courseId !== (competition.courseId ?? null)) {
      if (!courseAllowed(staff, parsed.input.courseId, res)) return
      /*
       * A move that would take the competition out of the mover's own sight
       * is refused: a course teacher who is not its creator, choosing «Без
       * курса», would lose the competition mid-lesson with no way back but
       * the owner.
       */
      if (!canSeeCompetition(staff, { createdBy: competition.createdBy, courseId: parsed.input.courseId })) {
        return fail(res, 409, 'invalid', tr('competitions.refusal.courseWouldHide'))
      }
    }
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
   *
   * Its runs are taken off the executor first and waited for (runner.ts ·
   * stopCompetitionRuns): a container left running holds its slot and its
   * share of a card while the queue, its row gone, gives that share to the
   * next GPU notebook. A run that does not stop in time refuses the delete,
   * and the owner tries again in a moment.
   */
  router.delete(
    '/api/admin/competitions/:id',
    ownerOnly('competitions.owner.delete'),
    async (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
      if (!(await stopCompetitionRuns(competition.id, SETTLE_MS)) || deleteCompetition(competition.id) === 'running') {
        return fail(res, 409, 'failed', tr('competitions.refusal.competitionRunning'))
      }
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

  /* ------------------------------------------------------- materials */

  /**
   * «Скачать материалы»: the competition as one archive, for another teacher
   * of the course to read through or build again
   * (competitions/materials-zip.ts): the task, the settings, the metric, the
   * base's packages, the sample notebook, the open data and the hidden test —
   * never the answers, never anything of a person.
   *
   * Whoever may open the competition in the editor (competitionOf), and the
   * same line as every archive (publish/zip-send.ts · sendArchive): up to
   * four hundred megabytes read on the class's process. The plan is read
   * after the wait, against the competition as it is then and with the scope
   * asked again; the hidden-test files it holds are recorded in the audit
   * log, as at their own door.
   *
   * A HEAD is answered from the competition alone: what a GET would be called
   * and what it is, with no plan, no line and no row in the audit log —
   * a link checker's HEAD read every file of the archive from disk into a
   * body nobody receives, and wrote a download that never happened.
   */
  router.get('/api/admin/competitions/:id/materials.zip', requireStaff, (req, res, next) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    if (req.method === 'HEAD') {
      res.setHeader('content-type', 'application/zip')
      res.setHeader('content-disposition', disposition('attachment', `${materialsTop(competition)}.zip`))
      res.setHeader('cache-control', STAFF_FILE_CACHE)
      res.status(200).end()
      return
    }
    sendArchive(
      res,
      next,
      `km:${competition.id}`,
      async () => {
        const viewer = currentStaff(req)
        const fresh = getCompetition(competition.id)
        if (!fresh || !canSeeCompetition(viewer, fresh)) return { error: tr('competitions.refusal.notFound') }
        const archive = await materialsZipPlan(await materialsOf(fresh, viewer))
        if (archive.sealed.length > 0) recordHiddenTestDownload(req, fresh, archive.sealed, 'archive')
        return { plan: archive.plan }
      },
      'competitions',
      // It carries the hidden test: kept in no cache, as at the file's own door.
      { cacheControl: STAFF_FILE_CACHE },
    )
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
      let stored: StoredFile
      try {
        // First the disk, then the row: a file that did not make it into place
        // must not be listed where the used space is counted. The two in one
        // step, with nothing awaited between: a reader of the row then finds
        // the bytes its hash names (store.ts · competitionFileHashes).
        stored = putOpenFile(competition.id, file.name, file.body)
      } catch {
        return fail(res, 400, 'invalid', tr('competitions.refusal.badName', { name: file.name }))
      }
      putFile({
        competitionId: competition.id,
        name: file.name,
        bytes: stored.bytes,
        rows: shape?.rows ?? null,
        visibility: 'open',
        sha256: stored.sha256,
      })
    }
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /**
   * Download an open file, the same one an entrant sees — the editor's link
   * on its row. The answers do not come here.
   *
   * Streamed from a held descriptor, byte ranges and all (holdOpenFile), the
   * way the entrant's own door hands it out: a two-hundred-megabyte table
   * read into the class's process for one teacher's click is two hundred
   * megabytes taken from the rooms running beside it.
   */
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
    sendFile(res, () => holdOpenFile(competition.id, name), name)
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
   * The list travels in the view. The bytes go back only to the teachers
   * who may open the competition — one file at its own door below, or in the
   * materials archive — and each time with a row in the audit log.
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
      let stored: StoredFile
      try {
        // First the disk, then the row, in one step, as for the open data.
        stored = putSealedFile(competition.id, file.name, file.body)
      } catch {
        return fail(res, 400, 'invalid', tr('competitions.refusal.badName', { name: file.name }))
      }
      putFile({ competitionId: competition.id, name: file.name, bytes: stored.bytes, rows: shape?.rows ?? null, visibility: 'sealed', sha256: stored.sha256 })
    }
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /** The hidden test as names, rows and columns — the same list the view carries. */
  router.get('/api/admin/competitions/:id/sealed', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    res.json({ sealedFiles: (await viewOf(competition)).sealedFiles ?? [] })
  })

  /**
   * One hidden-test file, the editor's link on its row: for the teachers who
   * may open the competition (competitionOf), so that a colleague can read
   * what the check reads. Each GET is recorded in the audit log — who, when,
   * which file (recordHiddenTestDownload) — since its bytes leave no other
   * way but the materials archive, and kept in no cache (sendFile). An
   * entrant never gets here: their notebook reads it only inside the check.
   */
  router.get('/api/admin/competitions/:id/sealed/:name', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const name = String(req.params.name)
    // By the row, as for the open data: only a file listed as the hidden test goes out here.
    const listed = listFiles(competition.id, 'sealed').find((file) => file.name === name)
    if (!listed) return fail(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
    if (!sendFile(res, () => competitionsFs.openRead(path.join(sealedDir(competition.id), name)), name)) return
    recordHiddenTestDownload(req, competition, [name], 'file')
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

  /**
   * Whether the executor can do what this door asks of it, said in words when
   * it cannot. `needs` is what the door runs: a door that runs the notebook
   * (the baseline check, a rerun, opening the competition) asks for a card
   * when the competition has one (`notebookNeeds`); a door that runs only the
   * metric (the metric check, a rescore) asks for none — the metric never
   * gets a card (store.ts · NEEDS_CARD). Asked with the card, a rescore after
   * the owner gave the cards back to classes was refused "this competition
   * needs a GPU" for work the queue would have run on the CPU at once.
   */
  async function executionAvailable(competition: Competition, res: Response, needs: CompetitionNeeds): Promise<boolean> {
    try {
      await assertCompetitionCapability('execution', competition.environment, competitionRevision(competition.id)?.imageDigest, needs)
      return true
    } catch (error) {
      fail(res, 503, 'failed', error instanceof Error ? error.message : tr('runtime.brokerUnavailable'))
      return false
    }
  }

  /**
   * The same for a door that runs only the metric (the metric check, a
   * rescore, all of them), asked of the image that metric will run in
   * (runner.ts · metricScoringImage): a competition with a card scores in its
   * pinned kaggle-base, and asked about its own GPU image such a door was
   * refused once the owner removed that image to free the disk — what
   * decision 2 is for — though the metric would have run.
   */
  async function metricExecutionAvailable(competition: Competition, res: Response): Promise<boolean> {
    try {
      const image = await metricScoringImage(competition)
      await assertCompetitionCapability('execution', image.environment, image.imageDigest, {})
      return true
    } catch (error) {
      fail(res, 503, 'failed', error instanceof Error ? error.message : tr('runtime.brokerUnavailable'))
      return false
    }
  }

  /* ------------------------------------------------------ sample notebook */

  /**
   * The sample notebook as it was uploaded (the bytes the check read): the
   * link on its card in the editor. Named after the competition, so that a
   * few of them downloaded side by side are not all `notebook.ipynb`.
   */
  router.get('/api/admin/competitions/:id/baseline', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    sendFile(res, () => competitionsFs.openRead(path.join(baselineDir(competition.id), NOTEBOOK_FILE)), `${competition.slug}-baseline.ipynb`)
  })

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
    if (!await executionAvailable(competition, res, notebookNeeds(competition))) return
    const notebook = readBaseline(competition.id, LIMITS.notebookBytes)
    if (!notebook) {
      return fail(res, 409, 'not_ready', tr('competitions.refusal.noBaselineFile'))
    }
    const entrantId = baselineEntrantOf(competition) ?? newBaselineEntrant()
    let revision
    try { revision = await executionRevision(competition, notebookNeeds(competition)) } catch (error) {
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
    if (!await metricExecutionAvailable(competition, res)) return
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
    if (!await executionAvailable(competition, res, notebookNeeds(competition))) return
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
    res.json(liveOf(competition, currentStaff(req)))
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
    /*
     * The viewer is asked again on every push, not kept from the moment the
     * stream opened: the cookie is re-verified (a rotated link, a deleted
     * row) and the staff row re-read (a demoted owner), and the scope reads
     * live membership — so a teacher taken off the course, a competition
     * moved out of it, an owner made a teacher, loses the stream on the next
     * tick instead of watching until they reload. The reconnect then meets
     * the 401 or the 404.
     */
    const viewerNow = (): StaffLike | null => {
      const signed = currentStaff(req)
      return signed ? getTeacher(signed.id) : null
    }
    let tick: ReturnType<typeof setInterval> | null = null
    let beat: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (tick) clearInterval(tick)
      if (beat) clearInterval(beat)
      tick = beat = null
    }
    const push = () => {
      const fresh = getCompetition(competition.id)
      if (!fresh) return
      const viewer = viewerNow()
      if (!canSeeCompetition(viewer, fresh)) {
        stop()
        res.end()
        return
      }
      const body = JSON.stringify(liveOf(fresh, viewer))
      if (body === last) return
      last = body
      res.write(`event: state\ndata: ${body}\n\n`)
    }
    push()
    tick = setInterval(push, 1500)
    beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000)
    req.on('close', stop)
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
    if (!await executionAvailable(competition, res, notebookNeeds(competition))) return
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
    if (!await metricExecutionAvailable(competition, res)) return
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
    if (!await metricExecutionAvailable(competition, res)) return
    // The pump counts: a submission qualifies if its answer IS ON DISK, and
    // that is a question for the files, not for the row's state.
    res.status(202).json({ queued: rescoreCompetition(competition.id) })
  })

  /**
   * Move the metric of a competition with a card to the current kaggle-base
   * and rescore every submission in it (runner.ts · moveMetricToLightImage):
   * the one way that metric's image changes, so no leaderboard holds scores of
   * two images. For a teacher whose pinned kaggle-base is gone from the
   * server, who wants the rebuilt one, or whose competition scored in its own
   * GPU image before kaggle-base was here — its card on, or turned off since
   * its metric was pinned, which still scores in the pin. A competition on
   * the CPU that was never pinned scores in its own pin, which moves with its
   * base («обновить базу»).
   */
  router.post('/api/admin/competitions/:id/metric/image', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    let moved: Awaited<ReturnType<typeof moveMetricToLightImage>>
    try {
      moved = await moveMetricToLightImage(competition)
    } catch (error) {
      // Docker did not say whether kaggle-base is here, or it could not be recorded: nothing moved.
      console.warn(`[competitions] ${competition.id}: the metric image could not be moved: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
      return fail(res, 503, 'failed', tr('runtime.dockerUnavailable'))
    }
    if (moved === 'cpu') return fail(res, 409, 'invalid', tr('competitions.refusal.metricImageCpu'))
    if (moved === 'none') return fail(res, 503, 'failed', tr('competitions.refusal.noMetricImage', { environment: LIGHT_METRIC_ENVIRONMENT }))
    res.status(202).json({ revisionId: moved.revision.id, queued: moved.queued })
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
    const staff = currentStaff(req)
    const baselineEntrant = baselineEntrantOf(competition)
    const board = placesAmongPeople(leaderboard(competition.id, 'public'), (row) => row.entrantId === baselineEntrant)
    const body: EntrantsList = {
      entrants: listCompetitionEntrants(competition.id).map((entrant) => {
        const row = entrantRow(
          entrant,
          competition,
          entrant.id === baselineEntrant ? 'baseline' : null,
          board.find((one) => one.entrantId === entrant.id)?.place ?? null,
        )
        // What the confirmation says about the key: it keeps working there.
        const otherCompetitions = competitionsElsewhere(entrant.id, competition.id)
        if (isOwner(staff) || otherCompetitions === 0) return { ...row, otherCompetitions }
        /*
         * The person is in other competitions too. If any of those is not
         * this teacher's, the key — valid in all of them — is withheld, and
         * the person as a whole (rename, switch off) is the owner's.
         */
        const all = entrantReach(staff, entrant.id) === 'all'
        if (all) return { ...row, otherCompetitions }
        // The count names only competitions this teacher runs: the rest are
        // other courses', and how many of those a person is in is not theirs
        // to learn. `keyWithheld` tells the dialog the key outlives this one.
        const visibleElsewhere = entrantCompetitionIds(entrant.id)
          .filter((id) => id !== competition.id && canSeeCompetitionId(staff, id)).length
        return { ...row, otherCompetitions: visibleElsewhere, key: null, keyWithheld: true, editable: false }
      }),
    }
    res.json(body)
  })

  /**
   * Add a person to this competition from the panel: a new identity with its
   * key, joined to the competition in the same transaction — the "Entrants"
   * tab's «Добавить». Joined, not loose: a person who belongs to no
   * competition is visible to no teacher, the one who made them included.
   * A namesake already in this competition is refused, as at the join door.
   */
  router.post('/api/admin/competitions/:id/entrants', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const name = entrantHandle(String((req.body as { name?: unknown } | undefined)?.name ?? ''))
    if (!name) return fail(res, 400, 'invalid', tr('competitions.refusal.nameNotHandle'))
    const minted = joinAsNewcomer(competition.id, name)
    if (minted === 'taken') return fail(res, 409, 'name_taken', tr('competitions.refusal.entrantNameTaken'))
    res.status(201).json({
      entrant: { ...entrantRow(minted.entrant, competition, null), otherCompetitions: 0 },
      key: minted.key,
    })
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
