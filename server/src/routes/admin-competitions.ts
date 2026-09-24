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
import {
  acceptSubmission,
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
  queuePause,
  queueRow,
  queueRows,
  renameEntrant,
  rotateEntrantKey,
  runningRows,
  setCompetitionState,
  setEntrantDisabled,
  updateCompetition,
  updateSubmission,
  waitingCount,
  enqueue,
} from '../competitions/store.js'
import {
  NOTEBOOK_FILE,
  SOLUTION_FILE,
  baselineDir,
  competitionsFs,
  dropOpenFile,
  dropSecretFile,
  ensureCompetition,
  putBaseline,
  putOpenFile,
  putSecretFile,
  putSubmissionNotebook,
  readBaseline,
  readOpenFile,
  readResultFile,
  readSecretFile,
  resultDir,
} from '../competitions/storage.js'
import {
  executedToday,
  waitingEligibilityOrder,
  medianOf,
  openRefusal,
  parseCompetitionInput,
  rescorable,
  waitEtas,
  withoutBaseline,
  type DoneEntry,
  type InputRefusal,
} from '../competitions/panel.js'
import { baseName, csvShape, csvUsageSplit, notebookCells } from '../competitions/intake.js'
import {
  cancelSubmission,
  pauseCompetitionQueue,
  queueSlots,
  rerunSubmission,
  rescoreCompetition,
  wakeCompetitionPump,
} from '../competitions/runner.js'
import type { QueueRow } from '../competitions/store.js'
import { METRIC_WALL_SECONDS } from '../competitions/runner-port.js'
import type { AdminErrorBody, AdminErrorReason } from '@shared/admin'
import {
  LIMITS,
  dayStart,
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
  EntrantRow,
  EntrantsList,
  FileView,
  QueueSnapshot,
  RunningNow,
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
 * The zone is the local zone of the MACHINE the class runs on.
 *
 * "Run today: 37" and the daily submission quota have to end at the
 * teacher's midnight, not at UTC midnight: in Moscow that is three in the
 * morning, that is, the quota resets in the middle of night work, and "today"
 * at a morning lesson shows yesterday's numbers. The instance has no time
 * zone setting, and needs none: the server stands where the lesson takes
 * place.
 */
function offsetMinutes(at: number): number {
  return -new Date(at).getTimezoneOffset()
}

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
  const value = executedToday(entries, dayStart(now, offsetMinutes(now)), now)
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
 * competition's rows are returned.
 */
function waitingRows(competitionId: string | null, snapshot: QueueSnapshot, now: number): WaitingRow[] {
  const waiting = queueRows().filter((row) => row.state === 'waiting')
  const busy = new Set(snapshot.running.map((row) => row.entrantId))
  const {eligible,deferred}=waitingEligibilityOrder(waiting,busy,now)
  const ordered=[...eligible,...deferred]
  const left = snapshot.running.map((row) => {
    const elapsed = now - row.startedAt
    const guess = snapshot.averageMs === null ? row.limitMs : Math.min(snapshot.averageMs, row.limitMs)
    return Math.max(0, guess - elapsed)
  })
  const etas = waitEtas(eligible.length, {
    runningLeftMs: left,
    averageMs: snapshot.averageMs,
    slots: snapshot.slots,
  })
  const rows: WaitingRow[] = []
  ordered.forEach((queued, index) => {
    if (competitionId && queued.competitionId !== competitionId) return
    const submission = getSubmission(queued.submissionId)
    const competition = getCompetition(queued.competitionId)
    if (!submission || !competition) return
    rows.push({
      submissionId: submission.id,
      competitionId: competition.id,
      entrantId: queued.entrantId,
      entrantName: getEntrant(queued.entrantId)?.name ?? '',
      number: submission.number,
      // The place is over the WHOLE queue: "you are first among your own" means nothing.
      place: index<eligible.length?index+1:null,
      etaMs: index<eligible.length?etas[index]??null:null,
      resourcePending: queued.notBefore>now,
      baseline: queued.entrantId === baselineEntrantOf(competition),
    })
  })
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
  }
}

/* -------------------------------------------------------------- multipart */

interface Upload {
  name: string
  body: Buffer
}

interface Received {
  files: Upload[]
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

    const out: Received = { files: [], oversize: null, tooMany: false }
    let answered = false
    const done = (value: Received | 'cut-off') => {
      if (answered) return
      answered = true
      resolve(value)
    }

    bb.on('filesLimit', () => {
      out.tooMany = true
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

  router.post('/api/admin/competitions/entrants', requireStaff, (req, res) => {
    const name = String((req.body as { name?: unknown } | undefined)?.name ?? '').trim()
    if (!name) return fail(res, 400, 'invalid', tr('competitions.refusal.nameEmpty'))
    const minted = createEntrant(name)
    res.status(201).json({ entrant: entrantRow(minted.entrant, null, null), key: minted.key })
  })

  router.patch('/api/admin/competitions/entrants/:eid', requireStaff, (req, res) => {
    const id = String(req.params.eid)
    if (!getEntrant(id)) return fail(res, 404, 'not_found', tr('competitions.refusal.noEntrant'))
    const body = (req.body ?? {}) as { name?: unknown; disabled?: unknown }
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name) return fail(res, 400, 'invalid', tr('competitions.refusal.nameEmpty'))
      renameEntrant(id, name)
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
    res.json(await viewOf(saved))
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
    dropFile(competition.id, name)
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
      dropFile(competition.id, name)
      res.json(await viewOf(getCompetition(competition.id)!))
    },
  )

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
    if (notebookCells(file.body) === null) {
      return fail(res, 400, 'invalid', tr('competitions.refusal.notNotebook'))
    }
    putBaseline(competition.id, file.body)
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
    try { revision = await executionRevision(competition) } catch {
      return fail(res, 503, 'failed', tr('dependencies.error.base'))
    }
    // The notebook bytes and configuration were observed before async image
    // inspection. A concurrent edit must start a fresh baseline check.
    if (getCompetition(competition.id)?.inputRevision !== competition.inputRevision) {
      return fail(res, 409, 'not_ready', tr('competitions.refusal.open.baselineNotChecked'))
    }
    let submission
    try {
      submission = acceptPinnedSubmission(competition, entrantId, NOTEBOOK_FILE, notebook.length, revision, null, true)
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
      setCompetitionState(competition.id, 'finished')
      if (competition.privateRelease === 'auto') openPrivateBoard(competition.id)
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
  router.get('/api/admin/competitions/:id/leaderboard', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const baseline = baselineEntrantOf(competition)
    const names = new Map(listCompetitionEntrants(competition.id).map((entrant) => [entrant.id, entrant.name]))
    const board = (part: 'public' | 'private') => leaderboard(competition.id, part)
      .filter((row) => row.entrantId !== baseline)
      .map((row, index) => ({ ...row, place: index + 1,
        entrantName: names.get(row.entrantId) ?? getEntrant(row.entrantId)?.name ?? '' }))
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
    const needle = String(req.query.q ?? '').trim().toLowerCase()
    const names = new Map(listCompetitionEntrants(competition.id).map((it) => [it.id, it.name]))

    const all = listSubmissions(competition.id)
      .filter((submission) => {
        if (wantedState && submission.state !== wantedState) return false
        if (wantedEntrant && submission.entrantId !== wantedEntrant) return false
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
      if (!rescorable(submission.state)) {
        return fail(res, 409, 'invalid', tr('competitions.refusal.notRescorable'))
      }
      updateSubmission(submission.id, {
        state: 'queued',
        stage: 'score',
        participantError: null,
        teacherError: null,
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
   * "Do not count": remove a submission from scoring.
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
      const saved = updateSubmission(submission.id, {
        state: 'cancelled',
        participantError: tr('competitions.note.droppedByTeacher'),
      })
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

  /** The "Entrants" tab of one competition: place, submissions, sign-in key. */
  router.get('/api/admin/competitions/:id/entrants', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const baselineEntrant = baselineEntrantOf(competition)
    const board = leaderboard(competition.id, 'public')
    const body: EntrantsList = {
      entrants: listCompetitionEntrants(competition.id).map((entrant) =>
        entrantRow(
          entrant,
          competition,
          entrant.id === baselineEntrant ? 'baseline' : null,
          board.find((row) => row.entrantId === entrant.id)?.place ?? null,
        ),
      ),
    }
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
  for (const name of [NOTEBOOK_FILE, 'run.json', 'progress.json', 'submission.csv']) {
    try {
      const info = competitionsFs.statSync(path.join(resultDir(competitionId, submissionId), name))
      out.push({ name, bytes: info.size })
    } catch {
      /* no file: the run did not get that far, or the directory was removed */
    }
  }
  return out
}
