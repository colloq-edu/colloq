/**
 * Двери панели к соревнованиям: список (A1), редактор (A2), идущее (A3).
 *
 * Право здесь читается двумя словами. Всё, что показывает и заводит, —
 * `requireStaff`: соревнование ведёт тот же преподаватель, что и пару.
 * `ownerOnly` стоит на разрушительном, и список его короткий и намеренный:
 * удалить соревнование, удалить ФАЙЛ ОТВЕТОВ, завершить приём посылок, выдать
 * участнику новый ключ (старый в ту же секунду перестаёт работать) и снять
 * чужую посылку с зачёта. Общее у этих пяти одно: последствие достаётся
 * людям, которых в запросе нет.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ — двери, отдающей содержимое `solution.csv`.
 * Ответы лежат в DATA_DIR соревнования, вне рабочих папок занятий (см.
 * SECURITY.md), и единственный путь наружу у них один: контейнер метрики,
 * который поднимает исполнитель. Имена и колонки ответов преподаватель видит
 * (так нарисован A2), байты — никто.
 *
 * Исполнение посылок живёт не здесь. Эти маршруты кладут работу в очередь
 * (`store.ts`) и будят насос (`runner.ts`) — а «исполнить заново», «убить» и
 * «пересчитать всех» зовут его же: где именно лежит присланная тетрадь и
 * сохранился ли ответ, знает он, и второй копии этого знания в панели быть не
 * должно.
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
  fairOrder,
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

/** Файлов данных за одну загрузку. Больше — это уже перетащили папку целиком. */
const FILES_PER_UPLOAD = 20

/** Лента посылок одной страницей. */
const FEED_PAGE = 200

/* ------------------------------------------------------------- помощники */

/**
 * Пояс — местный пояс МАШИНЫ, на которой идёт занятие.
 *
 * «Сегодня исполнено 37» и дневная норма посылок обязаны кончаться в полночь
 * преподавателя, а не в полночь UTC: в Москве это три часа ночи, то есть норма
 * обнуляется посреди ночной работы, а «сегодня» на утренней паре показывает
 * вчерашние числа. Настройки пояса у инстанса нет — и не нужно: сервер стоит
 * там же, где идёт пара.
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
  // Чужая посылка по прямой ссылке — это `not_found`, а не «нельзя»: панель
  // всё равно покажет обе фразы одинаково, а вторая называет соревнование,
  // о котором спросивший и так не знал.
  if (!found || found.competitionId !== competition.id) {
    fail(res, 404, 'not_found', tr('competitions.refusal.noSubmission'))
    return null
  }
  return found
}

/** Служебный участник, на которого записана сэмпл-тетрадь; null — её не проверяли. */
function baselineEntrantOf(competition: Competition): string | null {
  return competition.baselineEntrantId ?? null
}

/** Файл сэмпл-тетради на диске: байты и когда положен. */
function baselineFile(id: string): { bytes: number; uploadedAt: number } | null {
  try {
    const info = competitionsFs.statSync(path.join(baselineDir(id), NOTEBOOK_FILE))
    return { bytes: info.size, uploadedAt: Math.round(info.mtimeMs) }
  } catch {
    return null
  }
}

/** Лучший публичный результат КЛАССА — базовое решение показано отдельной строкой. */
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
 * Колонки CSV — «397 строк · id, orders».
 *
 * Файл читается целиком ради одной шапки, поэтому у чтения есть потолок: за
 * ним колонки не показываются вовсе. Открывать редактор соревнования ценой
 * двухсот мегабайт в памяти нельзя — этот экран открывают посреди пары.
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
   * Делят строки — зерно или колонка Usage в самом файле ответов.
   *
   * Здесь считается только СКОЛЬКО их выйдет: какие именно строки публичные,
   * решает `splitRows` в момент подсчёта метрики, и знать это панели не нужно
   * — а показать некуда и нельзя.
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

/* --------------------------------------------------------------- очередь */

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
 * «сегодня исполнено 37, в среднем 2 мин 40 с» — по всему инстансу.
 *
 * Считается не чаще раза в пару секунд и кладётся в память: на эту строку
 * смотрят из каждой открытой вкладки панели и из живого потока A3, а под ней
 * обход всех посылок инстанса.
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
 * Ждущие — в том порядке, в каком их возьмут, с оценкой ожидания.
 *
 * Очередь общая на инстанс, а экран один на соревнование: место считается по
 * всей очереди (иначе «вы первая» означало бы «первая среди своих», то есть
 * ничего), а отдаются строки только этого соревнования.
 */
function waitingRows(competitionId: string | null, snapshot: QueueSnapshot, now: number): WaitingRow[] {
  const waiting = queueRows().filter((row) => row.state === 'waiting')
  const busy = new Set(snapshot.running.map((row) => row.entrantId))
  const ordered = fairOrder(waiting, busy)
  const left = snapshot.running.map((row) => {
    const elapsed = now - row.startedAt
    const guess = snapshot.averageMs === null ? row.limitMs : Math.min(snapshot.averageMs, row.limitMs)
    return Math.max(0, guess - elapsed)
  })
  const etas = waitEtas(ordered.length, {
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
      // Место — по ВСЕЙ очереди: «вы первая среди своих» не значит ничего.
      place: index + 1,
      etaMs: etas[index] ?? null,
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

/* ----------------------------------------------------------- многочастное */

interface Upload {
  name: string
  body: Buffer
}

interface Received {
  files: Upload[]
  /** Имя файла, который не влез в потолок; null — все влезли. */
  oversize: string | null
  /** Файлов прислали больше, чем дверь принимает: лишние busboy молча отбросил. */
  tooMany: boolean
}

/**
 * Принять multipart в память.
 *
 * В память, а не на диск через временный файл, как это делает загрузка в
 * комнату: там файл кладут студенты и размер задаёт настройка инстанса, здесь
 * — преподаватель, и потолок у соревнования свой (`LIMITS.dataBytes` на все
 * данные, `LIMITS.notebookBytes` на тетрадь). Именно потолок и делает этот
 * путь честным: без него один `curl` с гигабайтным файлом кладёт процесс,
 * который ведёт занятие.
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
        // Иначе имя файла читается как latin-1, и `данные.csv` превращается в
        // мусор — который участник потом не найдёт из своей тетради.
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
        // Обрезанный файл не кладётся вовсе: половина CSV читается pandas без
        // единой жалобы, и о потере узнают по числам в лидерборде.
        if (!over) out.files.push({ name: baseName(info.filename), body: Buffer.concat(chunks) })
      })
    })
    bb.on('error', () => done('cut-off'))
    bb.on('close', () => done(out))
    // Оборванный запрос: busboy 'end' не получит, и обещание не разрешится
    // никогда — а вместе с ним повиснет и обработчик.
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

/* ------------------------------------------------------------------ двери */

export function adminCompetitionRoutes(): Router {
  const router = Router()

  /*
   * Очередь и участники объявлены ДО `/:id`.
   *
   * express разбирает маршруты по порядку, и `/competitions/queue` совпало бы с
   * `/competitions/:id`. Идентификаторы соревнований выдаёт база, так что
   * столкнуться они не могут, но порядок здесь — не случайность, и переставлять
   * его нельзя.
   */

  /* ----------------------------------------------------------- очередь */

  router.get('/api/admin/competitions/queue', requireStaff, (_req, res) => {
    res.json(queueSnapshot())
  })

  /**
   * Приостановить очередь или пустить её снова.
   *
   * Пауза не трогает идущий прогон: «не начинай новых» и «убей то, что идёт» —
   * разные обещания, и второе стоит чужой минуты работы.
   */
  router.post('/api/admin/competitions/queue/pause', requireStaff, (req, res) => {
    const paused = (req.body as { paused?: unknown } | undefined)?.paused !== false
    pauseCompetitionQueue(paused, currentStaff(req)?.id ?? null)
    res.json(queueSnapshot())
  })

  /** Убить идущий прогон. Кнопка «Убить» в блоке «ИСПОЛНЯЕТСЯ СЕЙЧАС». */
  router.post('/api/admin/competitions/queue/kill', requireStaff, async (req, res) => {
    const id = String((req.body as { submissionId?: unknown } | undefined)?.submissionId ?? '')
    if (!queueRow(id)) {
      return fail(res, 409, 'invalid', tr('competitions.refusal.notRunning'))
    }
    // Снимает её насос: ждущую он убирает из очереди сам, идущей — убивает
    // контейнер и дописывает исход, когда тот умрёт. Отсюда видно только «да».
    const killed = await cancelSubmission(id, 'teacher')
    if (!killed) return fail(res, 409, 'failed', tr('competitions.refusal.killRefused'))
    res.json({ killed: true })
  })

  /* --------------------------------------------------------- участники */

  /**
   * Список участников инстанса — вместе с ключами входа.
   *
   * Ключ здесь есть намеренно: преподаватель раздаёт его классу, и другого
   * места, где ключ читается, в продукте нет (`entrantKeyOf` — единственная
   * дверь к секрету). Дверь панельная, и это весь её замок.
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
   * Выдать новый ключ.
   *
   * Владельцем: старый ключ перестаёт действовать в ту же секунду, и если
   * человек сейчас на паре — он выпадает из своего соревнования до тех пор,
   * пока новый ключ до него не доедет.
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

  /* ------------------------------------------------------ соревнования */

  router.get('/api/admin/competitions', requireStaff, (_req, res) => {
    const body: CompetitionsList = {
      competitions: listCompetitions().map(rowOf),
      queue: queueSnapshot(),
    }
    res.json(body)
  })

  /** Новое соревнование — всегда черновиком: открывает его отдельная дверь. */
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
   * Удалить соревнование целиком — вместе с каталогом, в котором лежат ответы.
   *
   * Владельцем: посылки, числа и места ста человек исчезают безвозвратно, и
   * восстанавливать их не из чего.
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
   * Код метрики — своей дверью, а не полем в общем патче.
   *
   * Редактор кода в A2 сохраняется своей кнопкой и не показывает ни сроков, ни
   * пределов: PATCH со всей формой из него затёр бы поля, которых он не видел.
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

  /* ---------------------------------------------------------- данные */

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
     * Потолок busboy — на КАЖДЫЙ файл, а место считается на соревнование.
     *
     * Десять файлов по сто мегабайт проходят поштучно и вместе дают гигабайт,
     * так что сумма проверяется здесь, до первой записи на диск: иначе часть
     * набора уже лежала бы в `data/`, и участник увидел бы половину данных.
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
        // Сначала диск, потом строка: файл, не легший на место, не должен
        // числиться в списке, по которому считается занятое место.
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

  /** Скачать открытый файл — то же, что увидит участник. Ответы сюда не ходят. */
  router.get('/api/admin/competitions/:id/files/:name', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    const name = String(req.params.name)
    /*
     * Видимость проверяется ПО СТРОКЕ В БАЗЕ, а не по каталогу.
     *
     * Имя приходит из адреса, и `../secret/solution.csv` отбила бы и якорная
     * файловая система — но отбила бы ошибкой чтения, то есть правильный ответ
     * зависел бы от того, что сегодня лежит на диске. Здесь сказано прямо:
     * наружу уезжает только то, что помечено открытым.
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
   * Ответы — отдельной дверью от открытых данных.
   *
   * Не параметром `visibility` у той же двери: перепутать каталог значит выдать
   * ответы классу, и такая ошибка обязана выглядеть как другой адрес, а не как
   * другое значение поля (та же причина, по которой в storage.ts две функции
   * записи).
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
     * Имя на диске — всегда `solution.csv`.
     *
     * Контейнер метрики монтирует закрытый каталог и читает из него файл с
     * этим именем; если бы имя приходило от преподавателя, переименованный
     * файл ломал бы подсчёт молча — уже после того, как класс начал присылать
     * посылки.
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

  /** Снять ответы. Владельцем: без них соревнование перестаёт считаться вовсе. */
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

  /* -------------------------------------------------------- сэмпл-тетрадь */

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
     * Прежняя проверка забывается вместе с файлом.
     *
     * Иначе «ПРОХОДИТ» осталось бы на экране от старой тетради, и открыть
     * соревнование можно было бы по числу, которое получила не та.
     */
    updateCompetition(competition.id, { baselineSubmissionId: null })
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /**
   * Проверить сэмпл-тетрадь тем же путём, которым пойдут посылки.
   *
   * Тем же — буквально: заводится настоящая посылка настоящего (служебного)
   * участника и кладётся в ту же очередь. Отдельный «режим проверки» доказывал
   * бы только то, что работает режим проверки.
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
   * Проверить метрику на базовом решении — «до 60 с», без повторного запуска
   * тетради.
   *
   * Отдельно от полной проверки, потому что чинят обычно метрику: гонять ради
   * одной правки `score()` десятиминутную тетрадь заново — это десять минут,
   * за которые преподаватель уйдёт делать что-то другое.
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

  /* ------------------------------------------------- открыть и завершить */

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
   * «Завершить сейчас» — досрочно закрыть приём.
   *
   * Владельцем: посылки перестают приниматься у всего класса. Приватный
   * лидерборд при этом открывается сам, если так и было задумано (`auto`): для
   * соревнования, которое кончилось, дедлайн — это сейчас.
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

  /** Открыть приватный лидерборд рукой — «открою вручную, на разборе». */
  router.post('/api/admin/competitions/:id/private-board', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    openPrivateBoard(competition.id)
    res.json(await viewOf(getCompetition(competition.id)!))
  })

  /* ---------------------------------------------------------- живое (A3) */

  router.get('/api/admin/competitions/:id/live', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    res.json(liveOf(competition))
  })

  /*
   * То же самое, но само.
   *
   * Server-sent events, как у живого журнала сборки окружений: поток в одну
   * сторону, браузер переподключается сам, и никакого второго протокола ради
   * трёх чисел. Отдаётся не по таймеру, а по изменению — экран, на котором
   * ничего не происходит, не должен перерисовываться раз в секунду.
   */
  router.get('/api/admin/competitions/:id/stream', requireStaff, (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Ретранслятор по умолчанию копит ответ — то есть превращает живой
      // экран в один пакет в конце пары.
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

  /* --------------------------------------------------------- лента посылок */

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

  /** «Весь вывод»: прогоны, трейс метрики и что осталось на диске. */
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

  /** «Открыть исполненную тетрадь» — файл из каталога результата посылки. */
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

  /** «Исполнить заново»: та же тетрадь, новый контейнер, с нуля. */
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
       * Решает насос, а не панель.
       *
       * Он же знает два обстоятельства, которых отсюда не видно: идёт ли
       * посылка прямо сейчас (перезапускать идущее нельзя) и лежит ли ещё на
       * диске присланная тетрадь — уборка давних посылок сносит её, оставляя
       * числа в базе.
       */
      if (!rerunSubmission(submission.id)) {
        return fail(res, 409, 'invalid', tr('competitions.refusal.cannotRerun'))
      }
      res.status(202).json({ submissionId: submission.id })
    },
  )

  /** Пересчитать метрику одной посылки — тетрадь не запускается. */
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
   * «Не засчитывать» — снять посылку с зачёта.
   *
   * Владельцем: это чужой результат и чужое место в лидерборде. Отметка «в
   * зачёт» не снимается отдельно — зачётной считается только дошедшая до числа
   * (`countedSubmission`), а эта больше не дойдёт.
   */
  router.post(
    '/api/admin/competitions/:id/submissions/:sid/drop',
    ownerOnly('competitions.owner.dropSubmission'),
    async (req, res) => {
      const competition = competitionOf(req, res)
      if (!competition) return
      const submission = submissionOf(competition, req, res)
      if (!submission) return
      // Если она ещё идёт — сперва снять её с исполнения: держать контейнер
      // ради посылки, которая уже не считается, значит занимать очередь.
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
   * Пересчитать всех — после правки метрики.
   *
   * Тетради не запускаются: ответы участников лежат на диске, и в этом весь
   * смысл двух шагов. В очередь идёт только то, у чего этот ответ есть.
   */
  router.post('/api/admin/competitions/:id/rescore', requireStaff, async (req, res) => {
    const competition = competitionOf(req, res)
    if (!competition) return
    if (!await executionAvailable(competition, res)) return
    // Считает насос: годится та посылка, чей ответ ЛЕЖИТ НА ДИСКЕ, а это
    // вопрос к файлам, а не к состоянию строки.
    res.status(202).json({ queued: rescoreCompetition(competition.id) })
  })

  /** Вкладка «Участники» одного соревнования: место, посылки, ключ входа. */
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

/* ------------------------------------------------------------ помощники */

/**
 * Служебный участник, на которого записана сэмпл-тетрадь.
 *
 * Отключённый сразу: ключ у него есть (его выдаёт `createEntrant`), и
 * работающий ключ, о котором никто не знает, — это вход в соревнование,
 * лежащий в базе без хозяина.
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
 * Что осталось от прогона на диске — список, а не содержимое.
 *
 * Читается `stat`, а не сам файл: исполненная тетрадь с графиками — это
 * мегабайты base64, и открывать их в памяти сервера ради строчки «есть»
 * незачем. Уборка давних посылок (`pruneCompetitionFiles`) оставляет строку в
 * базе и сносит каталог, поэтому пустой список здесь — обычное дело.
 */
function resultFiles(competitionId: string, submissionId: string): { name: string; bytes: number }[] {
  const out: { name: string; bytes: number }[] = []
  for (const name of [NOTEBOOK_FILE, 'run.json', 'progress.json', 'submission.csv']) {
    try {
      const info = competitionsFs.statSync(path.join(resultDir(competitionId, submissionId), name))
      out.push({ name, bytes: info.size })
    } catch {
      /* файла нет — прогон до него не дошёл или каталог убран */
    }
  }
  return out
}
