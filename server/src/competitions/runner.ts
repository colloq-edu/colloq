/**
 * Очередь исполнения посылок — одна на инстанс, и насос над ней.
 *
 * УСТРОЙСТВО В ПЯТИ ФРАЗАХ. Очередь живёт в базе (store.ts), а не в памяти:
 * пара идёт полтора часа, посылки копятся всё это время, и перезапуск сервера
 * не должен означать «тридцать человек прислали в пустоту». Насос — это один
 * таймер, который берёт работу транзакцией `takeNext` и запускает её, не
 * дожидаясь; мест по умолчанию одно, потому что на машине преподавателя рядом
 * идёт занятие, и вторая посылка отнимает у него память, а не ускоряет
 * очередь. Работа идёт двумя шагами в двух одноразовых контейнерах — тетрадь,
 * потом метрика, — и между ними переезжает ровно один файл. Всё, что знает о
 * docker, лежит за дверью `runner-port.ts`: здесь решают, ЧЬЯ работа идёт
 * следующей и что записать в строку посылки. И на старте процесса очередь
 * поднимает осиротевшее: строка «исполняется», помеченная чужой жизнью
 * процесса, — это прогон, у которого больше нет контейнера.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Ни одного `docker`, ни одного пути на диске, собранного
 * руками, ни одной копии правил соревнования. Пути — `storage.ts`, правила —
 * `@shared/competitions`, строки — `store.ts`. Этот модуль их связывает, и
 * поэтому он читается сверху вниз, а не вширь.
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
 * Оба прогонщика грузятся здесь и только здесь.
 *
 * Модуль-порт знает лишь то, что они существуют: импортировать их оттуда
 * значило бы затянуть сборку аргументов docker в процесс, который её никогда
 * не позовёт. Регистрация происходит при загрузке модуля (registerCompetitionRunner).
 */
import './docker-runner.js'
import './fake-runner.js'
import './broker-runner.js'

/**
 * Имя контейнера — по нему его убивают и по нему же ищут в журнале docker.
 *
 * Префикс общий с комнатами (`colloq-`), чтобы всё хозяйство инстанса
 * находилось одним `docker ps`. Случайный хвост, а не номер захода: контейнер
 * прошлой посылки может ещё доживать свои миллисекунды, когда начинается
 * повтор, и `docker run` с занятым именем отказывает целиком.
 */
export function containerName(submissionId: string, kind: RunKind, token: string): string {
  return `colloq-comp-${submissionId}-${token}-${kind === 'metric' ? 'score' : 'run'}`
}

const newToken = (): string => randomBytes(4).toString('hex')

/* --------------------------------------------------------------- настройка */

/**
 * Сколько посылок исполнять разом.
 *
 * Ключ в общем ящике инстанса (instance_settings), а не столбец в таблице
 * очереди: это настройка МАШИНЫ, соседняя с настройками оракула, а не
 * состояние очереди вроде паузы. Умолчание — одно место: при четырёх
 * гигабайтах на посылку в виртуалку докера их помещается две, и это ещё до
 * ядер живых комнат.
 */
const SLOTS_KEY = 'competitions.slots'
export const DEFAULT_SLOTS = 1
export const MAX_SLOTS = 8

/*
 * Ящик заводит `admin/settings`, и импорт здесь — не украшение: без него
 * таблицы к моменту подготовки запросов ниже может ещё не быть, и очередь
 * падала бы на старте у всякого, кто поднял её раньше панели. Тот же импорт
 * ставит на место переводчик, читающий язык инстанса, — а строки, которые
 * прогонщик пишет участнику, идут через `tr`.
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
 * Запас памяти сверх того, что просит посылка.
 *
 * Контейнер стоит не только своим `--memory`: сверх него есть слой docker, сам
 * процесс python до первой строки тетради и tmpfs, который в лимит входит, но
 * занимается не сразу. Двести пятьдесят шесть мегабайт — та подушка, при
 * которой `docker run` не отказывает на границе.
 */
const RUN_RESERVE_MB = 256

/**
 * Хватает ли машины на новую работу.
 *
 * `null` — «честно не знаем» (нет /proc, не отвечает демон), и это НЕ повод
 * отказать: очередь, вставшая из-за того, что не прочитался файл, хуже
 * посылки, которой отказал docker. Отказ здесь — только когда мы точно знаем,
 * что памяти нет.
 */
export function enoughMemory(availableMb: number | null, needMb: number): boolean {
  if (availableMb === null) return true
  return availableMb >= needMb + RUN_RESERVE_MB
}

/**
 * Дать контейнеру прочитать то, что мы ему смонтировали.
 *
 * Файлы соревнования пишутся режимом 0600 — правильно для каталога внутри
 * DATA_DIR (0700), но контейнер ходит от uid 1000, и это не обязательно uid
 * сервера. Под `make up` они совпадают (в образе `USER node` — тот же 1000), а
 * на хозяйской машине — как повезёт: посылка молча не прочитает ни данных, ни
 * своей тетради, и в журнале это будет выглядеть как «тетрадь не нашла
 * train.csv».
 *
 * Отсюда, а не из storage.ts: режим меняется для изолированного исполнителя
 * (Docker локально или Pod в k3s). Каталог остаётся внутри DATA_DIR.
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
    // Не вышло — пусть решает docker: отказ по правам он называет вслух, а
    // ронять из-за этого посылку нечестно.
  }
}

/* ------------------------------------------------------------------ насос */

/** Идущие в ЭТОМ процессе работы: по ним видно, кого ещё ждать при остановке. */
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

/** Посылки, которые велели снять. Читается прогоном в конце, а не в начале. */
const cancelled = new Map<string, 'entrant' | 'teacher'>()

let timer: NodeJS.Timeout | null = null
let pumping = false
let stopped = false

/**
 * Взять столько работ, сколько машина и настройка позволяют, и НЕ ждать их.
 *
 * Не ждать — принципиально: при двух местах вторая посылка должна начаться,
 * пока идёт первая, а не после неё. Возвращается число начатых — по нему
 * `drainCompetitionQueue` понимает, что брать больше нечего.
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

/** Дождаться всего, что идёт в этом процессе. */
export function settleCompetitionWork(): Promise<void> {
  return Promise.all([...inFlight.values()]).then(() => undefined)
}

/**
 * Прогнать очередь до конца и дождаться её.
 *
 * Тестам и стенду: там нет секунды, которую можно подождать таймер, а
 * проверять надо ровно то, что очередь доходит до конца сама.
 */
export async function drainCompetitionQueue(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const started = await pumpOnce()
    await settleCompetitionWork()
    if (started === 0 && inFlight.size === 0) {
      // Работа могла появиться, пока шла предыдущая (пересчёт, повтор).
      if (waitingCount() === 0 || queuePaused()) return
    }
  }
}

/** Разбудить насос — после принятой посылки, снятой паузы, пересчёта. */
export function wakeCompetitionPump(): void {
  if (stopped || timer === null) return
  void pumpOnce()
}

const TICK_MS = 1_000

/**
 * Поднять насос.
 *
 * Зовётся один раз при старте процесса, после `reclaimCompetitionQueue`.
 * Таймер, а не «будить только на событие»: разбудить очередь должно и
 * освобождение памяти, и снятая пауза в соседней вкладке, и конец чужой
 * работы, — а секунда задержки для посылки, которая идёт минуты, не значит
 * ничего.
 */
export function startCompetitionPump(): void {
  if (timer) return
  stopped = false
  timer = setInterval(() => void pumpOnce(), TICK_MS)
  // Таймер очереди не должен держать процесс живым: он уходит вместе с ним.
  timer.unref?.()
  void pumpOnce()
}

/** Остановить насос и дождаться идущего. Новых работ после этого не берут. */
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

/* -------------------------------------------------------------- при старте */

/**
 * Поднять то, что осталось от прошлой жизни процесса.
 *
 * Строка «исполняется» с чужим `boot` означает ровно одно: сервер
 * перезапустили, пока посылка шла. Контейнера, скорее всего, уже нет, но если
 * есть — его имя лежит рядом, и снять его должен тот, кто это прочитал.
 * Зовётся ОДИН раз, до насоса: две такие уборки подряд подняли бы одну работу
 * дважды.
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
     * Строка посылки осталась «выполняется» — она о перезапуске не знает. Без
     * этой правки участник до следующего подъёма работы смотрел бы на таймер,
     * который не движется, и на полосу этапов, застрявшую на «ЗАПУСК ТЕТРАДИ».
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
      `[competitions] после перезапуска: поднято ${requeued.length}, брошено ${abandoned.length}, снято контейнеров ${swept}`,
    )
  }
  return { requeued: requeued.length, abandoned: abandoned.length, swept }
}

/* ------------------------------------------------------------------ работа */

async function runJob(row: QueueRow): Promise<void> {
  const submission = getSubmission(row.submissionId)
  const competition = submission ? getCompetition(submission.competitionId) : null
  if (!submission || !competition) {
    // Соревнование удалили, пока посылка ждала: снимать нечего, и держать
    // строку в очереди незачем.
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
     * Сюда попадает только наша собственная поломка — не падение тетради и не
     * падение метрики, у тех есть свои исходы. Участник в ней не виноват, и
     * слово `metricFailed` выбрано именно поэтому: он прочтёт «проверяющий код
     * упал, посылка будет пересчитана», а не обвинение своей тетради.
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

/** Шаг первый и, если он удался, шаг второй. */
async function runNotebookThenScore(competition: Competition, submission: Submission, row: QueueRow, provenance: AttemptProvenance): Promise<void> {
  const runner = competitionRunner()
  const binding = getBinding(submission.id)
  const limits = limitsFor(competition, 'notebook')
  const container = containerName(submission.id, 'notebook', newToken())
  const run = startRun({ submissionId: submission.id, kind: 'notebook', container, attemptId: row.attemptId!, inputRevision: provenance.inputRevision ?? undefined })
  // Имя ложится и в строку очереди: контейнер переживает процесс, который его
  // запустил, и снимать его после перезапуска будет уже другая жизнь сервера.
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
   * Этап «ПРОВЕРКА CSV» — не украшение полосы. Между «тетрадь исполнилась» и
   * «метрика посчитала» лежит единственная вещь, которую участник забывает
   * чаще всего: записать ответ. Отдельным этапом он видит, где именно
   * оборвалось.
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
 * Забранный ответ — или строка, объясняющая участнику, почему его нет.
 *
 * Пусто и слишком велико разведены нарочно: «файл не записан» и «файл на 80
 * мегабайт» — это два разных разговора, и участник, прочитавший первое вместо
 * второго, пойдёт искать ошибку не там.
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

/** Пересчёт: метрика по сохранённому ответу, без повторного исполнения тетради. */
async function scoreOnly(competition: Competition, submission: Submission, row: QueueRow, provenance: AttemptProvenance): Promise<void> {
  const answer = readAnswer(competition.id, submission.id)
  if (typeof answer === 'string') {
    /*
     * Пересчитать нечего: ответ с диска ушёл (уборка старых посылок) или его и
     * не было. Тетрадь второй раз не запускаем — это отдельное действие с
     * отдельной кнопкой; здесь честнее сказать преподавателю, что посылка
     * выпала из пересчёта.
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

/** Шаг второй: метрика преподавателя во втором одноразовом контейнере. */
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

  // Ответ переезжает в свой, НОВЫЙ каталог: контейнер метрики не должен видеть
  // ни исполненную тетрадь участника, ни её вывод. Каталог для ответа метрики
  // — отдельный, СОСЕДНИЙ: один и тот же путь, смонтированный и на чтение, и
  // на запись, отдал бы сторожу размер ответа как «метрика пишет на диск».
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
     * Вторая копия ответа и json метрики живут ровно на время подсчёта. Держать
     * их дальше значит хранить каждый ответ дважды: на соревновании в триста
     * посылок это гигабайты, которых никто не читает. Пересчёт заводит каталог
     * заново — он и обязан быть новым.
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
 * Ответы и код метрики на месте? Строка — чего не хватает, `null` — всё есть.
 *
 * Код метрики кладётся на диск КАЖДЫЙ раз, и это дешевле любой попытки
 * угадать, поменялся ли он: преподаватель правит метрику ровно тогда, когда
 * она упала, и посылка, пересчитанная старым кодом, выглядела бы как
 * неисправленная ошибка. Мы пишем файл ВНУТРИ смонтированного каталога, а не
 * монтируем сам файл, — именно поэтому перезапись безопасна (см. шапку
 * storage.ts про virtiofs).
 */
function snapshotSecrets(competition: Competition, submission: Submission, row: QueueRow): void {
  const directory = attemptDir(competition.id, submission.id, row.attemptId!, 'secret')
  const solution = path.join(secretDir(competition.id), SOLUTION_FILE)
  if (competitionsFs.existsSync(solution)) copyCompetitionFile(solution, path.join(directory, SOLUTION_FILE))
  competitionsFs.writeFileSync(path.join(directory, METRIC_NAME), Buffer.from(`${competition.metric.code}\n`), { mode: 0o600 })
}

/**
 * Посылку велели снять — записать это и уйти.
 *
 * Проверяется ПОСЛЕ шага, а не до: контейнер уже убит, работа кончилась, и
 * единственное, что осталось, — не записать участнику «вышло время» за то, что
 * он сам нажал «Отменить».
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

/* ------------------------------------------------------------------ слова */

const MB = 1024 * 1024

/**
 * Что читает УЧАСТНИК про упавшую тетрадь.
 *
 * Трассировка упавшей ячейки уезжает ему дословно: он её и писал, и «ошибка в
 * тетради» без единой строки причины — это отказ, за которым он придёт к
 * преподавателю. Всё остальное — наши слова, и они называют число: «не
 * уложилась в 10 минут» полезнее, чем «лимит времени».
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
      // harness_error и unknown: виновата обвязка, а не участник. Он увидит
      // фразу про упавший проверяющий код, а разбираться будет преподаватель.
      return null
  }
}

/** Что читает ПРЕПОДАВАТЕЛЬ: код выхода, OOM и хвост журнала контейнера. */
export function teacherNote(outcome: RunOutcome): string | null {
  if (outcome.status === 'ok') return null
  const head = `${outcome.status} · exit ${outcome.diagnostics.exit ?? '—'}${
    outcome.diagnostics.oomKilled ? ' · OOMKilled' : ''
  }${outcome.diagnostics.killedBy ? ` · killed by ${outcome.diagnostics.killedBy}` : ''}`
  const detail = outcome.status === 'dependency_error' ? outcome.detail : ''
  return [head, detail, outcome.log].filter(Boolean).join('\n')
}

/**
 * Что читает участник про метрику.
 *
 * `ParticipantVisibleError` — дословно, и это весь договор. Наши собственные
 * проверки приезжают из контейнера КОДОМ (harness.ts · align): страница
 * участника бывает на двух языках, а контейнер о языке инстанса не знает.
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
    // Метрика вернула что-то своё, начинающееся с фигурной скобки. Текст
    // участника он и есть — отдаём как написано.
    return raw
  }
}

/* ------------------------------------------------------------- вмешательство */

/**
 * Снять посылку: участник нажал «Отменить», преподаватель — «Убить».
 *
 * `false` — снимать нечего: работа уже кончилась. Это не ошибка, а ровно тот
 * случай, который в макете не нарисован («отмена не успела»), и разговаривать
 * с человеком о нём надо честно, а не притворяться, что получилось.
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

/** Исполнить тетрадь заново — то же самое, что прислать её ещё раз, но без номера. */
export function rerunSubmission(submissionId: string): boolean {
  const submission = getSubmission(submissionId)
  if (!submission) return false
  if (!isTerminal(submission.state)) return false
  // Присланная тетрадь могла уйти с диска уборкой старых посылок — тогда
  // исполнять нечего, и врать кнопкой «Исполнить заново» не стоит.
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
 * Пересчитать метрику всем посылкам соревнования.
 *
 * Тетради НЕ запускаются заново — ради этого прогоны и хранятся строкой на
 * заход: исполнение сотни тетрадей заняло бы час и дало бы ровно те же
 * ответы, которые уже лежат на диске. Берутся те, у кого ответ сохранился;
 * упавшая тетрадь пересчитывать нечего.
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

/** Приостановить очередь или пустить её снова. Идущее не трогается — на то «Убить». */
export function pauseCompetitionQueue(paused: boolean, by: string | null = null): void {
  setQueuePaused(paused, by)
  if (!paused) wakeCompetitionPump()
}

/* ------------------------------------------------------------------ сводка */

/** Полоса исполнителя в A1 и блок очереди в A3 — одним ответом. */
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
