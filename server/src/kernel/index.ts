import { tr } from '@shared/i18n'
/**
 * One Python kernel per seminar, and the queue in front of it.
 *
 * The room shares a kernel, so the interesting part of this file is not talking
 * to Jupyter — jupyter.ts does that — but deciding whose turn it is and making
 * that decision visible. A `Runtime` per seminar holds the kernel, the queue
 * and, importantly, its *own* record of what is running and who started it: the
 * document is shared and a student with a console could write any `runById`
 * into any cell, so anything that grants a right (interrupting, cancelling) is
 * answered from here rather than from the CRDT.
 *
 * Everything the room sees is written into the session document, not sent to
 * the browser that pressed the button: cell state, execution counts, output,
 * the queue, the kernel status and the notes in the terminal's kernel log. That
 * is why a student who joins twenty minutes late sees the whole history, and
 * why two people watching the same run see byte-identical output.
 *
 * A press of Run is a *batch* — one cell for Run, thirty for Run All. A failure
 * stops the rest of its own batch and nothing else, so somebody else's queued
 * cell is not collateral damage.
 */

import * as Y from 'yjs'
import {
  cellId as idOf,
  cellOutputs,
  cellSource,
  allCellArrays,
  cellsAt,
  cellType,
  createTerminalLine,
  findCell,
  getMeta,
  getTerminal,
  type CellState,
  type KernelStatus,
  type YCell,
} from '@shared/notebook'
import { config } from '../config.js'
import { appendActivity } from '../activity.js'
import type { ActivityDetails, ActivityKind, ActivityOutcome } from '@shared/activity'
import { sessionEnvironment } from '../db.js'
import { activeName } from '../environments.js'
import { formatNotebook, type FormatOutcome } from './format.js'
import {
  dropRoomKernel,
  endpointForSession,
  forgetSessionKernel,
  listRoomKernels,
  onRoomKernelRecreated,
  runningRoomKernels,
} from './pool.js'
import { kernelBackend, RuntimeRequestError } from './runtime-client.js'
import { KERNEL_PROBLEM_KEY, type KernelProblem } from '@shared/kernel-problem'
import { explain as explainDeath, forgetKills, sampleKills } from './postmortem.js'
import { getSessionDoc, holdRoom, onlineCount } from '../collab/index.js'
import { seldom } from '../log.js'
import { projectBooks } from '../collab/books.js'
import { flushSessionFiles } from '../collab/files.js'
import {
  JupyterKernel,
  type CompleteResult,
  type ExecuteStatus,
  type InspectResult,
  type KernelPhase,
} from './jupyter.js'
import { dataBudgetFor, OutputWriter } from './outputs.js'
import { CouncilOutputBuffer, type CouncilJob } from './council.js'
import {
  councilEnterSource,
  councilEnterRefusal,
  councilSkipNotes,
  parseCouncilReport,
  COUNCIL_EXIT_SOURCE,
  COUNCIL_REPORT_EXPR,
  COUNCIL_REPORT_KEY,
  type CouncilIsolationReport,
} from './council-isolation.js'
import { durationWords } from '@shared/text'
import type { CouncilRun } from '@shared/protocol'
import { closeTerminal, terminalPhase } from './terminal.js'

/**
 * The per-session Python runtime.
 *
 * One seminar means one kernel and one queue: everybody shares the same
 * variables, and cells run strictly one at a time so `df` means the same thing
 * to the room as it does to the person who pressed Run. Runtime state is
 * mirrored into the document's `meta` map rather than pushed over a side
 * channel, so a browser that just finished syncing already knows what is
 * queued, what is running, and who asked for it.
 */

/** Marks every write this module makes to a session document. */
const ORIGIN = 'kernel'
/** Long enough that a healthy cold start never trips it, short enough to matter. */
const SLOW_START_NOTICE_MS = 8_000

interface QueueItem {
  cellId: string
  runBy: string
  runById: string
  activitySeq?: number | null
  activityFinished?: boolean
  activityCancelled?: boolean
  /**
   * Which press of Run this cell came from.
   *
   * Run All is one press and thirty cells; a single Run is one press and one.
   * When a cell fails, the rest of *its own* batch stops — the way Run All has
   * always worked in the tool this room already knows, and the way the execute
   * request this server sends (`stop_on_error: true`) already asks the kernel
   * to behave. Cells somebody else queued in the meantime are untouched: their
   * work has nothing to do with this failure.
   */
  batch: number
  /**
   * Попытка консилиума, а не ячейка.
   *
   * Тот же насос и та же очередь — ядро одно, и «запустить попытку» стоит в
   * ней рядом с ячейками, в порядке нажатий. Но `cellId` у такой записи
   * синтетический (`councilQueueId`): в документе такой ячейки нет, и всё, что
   * пишет в документ по имени ячейки — состояние, вывод, зеркало очереди, —
   * находит пустоту и молчит. Вывод идёт в буфер (kernel/council.ts), а не в
   * общую ячейку: показывать его залу решает преподаватель, а не ядро.
   */
  council?: CouncilJob
}

function executionActivity(runtime: Runtime, item: QueueItem, kind: ActivityKind, details: ActivityDetails = {}): number | null {
  return appendActivity(runtime.sessionId, item.runById, kind, {
    cellId: item.council?.cellId ?? item.cellId,
    subjectId: item.council?.participantId,
    requestSeq: item.activitySeq ?? undefined,
    source: 'participant',
    ...details,
  })
}

function finishExecution(runtime: Runtime, item: QueueItem, outcome: ActivityOutcome, durationMs = 0): void {
  if (item.activityFinished) return
  item.activityFinished = true
  executionActivity(runtime, item, 'execution.finished', {
    outcome: item.activityCancelled && outcome !== 'completed' ? 'cancelled' : outcome,
    durationMs,
  })
  if (runtime.activityItem === item) runtime.activityItem = null
}

/** Попытка консилиума, которую ядро считает прямо сейчас. */
interface ActiveJob {
  item: QueueItem
  job: CouncilJob
  buffer: CouncilOutputBuffer
  run: CouncilRun
  /** Отложенный кадр вывода — см. `touchJob`. */
  timer: NodeJS.Timeout | null
  /**
   * Предел ЭТОГО запуска в секундах и его будильник — две разные вещи.
   *
   * Число живёт отдельно от `job.limitSec`, потому что регламент можно
   * поменять посреди запуска, и «правила действуют сразу» значит, что новый
   * предел считается от начала уже идущей попытки (`retimeCouncilRun`).
   * Будильник — отдельное поле от `timer`: тот раз в 400 мс отправляет кадр
   * вывода и переставляется десятки раз за запуск, а этот стоит один раз до
   * конца. Одно поле на двоих означало бы, что первый же `print` отменяет
   * предел.
   */
  limitSec: number | null
  limitTimer: NodeJS.Timeout | null
  /** Предел, который СРАБОТАЛ: он поедет в `CouncilRun.timedOut`. */
  timedOut: number | null
  /** Сколько раз мы уже просили ядро остановиться по этому пределу. */
  interrupts: number
}

/**
 * Во сколько миллисекунд обходится секунда предела — и шов для теста.
 *
 * Санитайзер регламента принимает только целые секунды от единицы
 * (shared/notebook.ts · readCouncilSettings), и это правильно для ручки, но
 * означало бы сюиту, которая честно ждёт по пять секунд на каждый случай.
 * Масштаб переставляется только тестом; в работе он всегда тысяча.
 */
let limitTickMs = 1000
export function setCouncilLimitTick(ms: number): void {
  limitTickMs = ms
}

/**
 * Через сколько повторить SIGINT, если попытка его не заметила.
 *
 * Считается в тех же «секундах» предела, чтобы тест, ускоривший масштаб,
 * ускорил и повтор.
 */
const LIMIT_RETRY_TICKS = 5

/** Синтетическое имя записи очереди для попытки: никогда не совпадает с ячейкой. */
function councilQueueId(cellId: string, participantId: string): string {
  return `council:${cellId}:${participantId}`
}

interface Runtime {
  sessionId: string
  activityItem?: QueueItem | null
  kernel: JupyterKernel | null
  /** In-flight connect, shared by concurrent ensureKernel callers. */
  starting: Promise<void> | null
  /**
   * In-flight restart, if one is running.
   *
   * Гонка Run и Restart. Перезапуск сбрасывал очередь, объявлял 'restarting' и
   * уходил ждать ядро; Run в эту же секунду клал ячейку в очередь и будил
   * насос, который видел живое (ещё) ядро и слал execute в то, что уже
   * перезапускается. Ответа на такой execute не приходит никогда: очередь
   * стоит, комната видит «idle», а `currentCell` занят до следующего Restart.
   *
   * Обещание, а не флажок: и второе нажатие Restart, и насос ждут одного и
   * того же — того же самого перезапуска, а не своего.
   */
  restarting: Promise<void> | null
  queue: QueueItem[]
  /** A targeted interrupt that must settle before the queue may start another job. */
  beforeNext: Promise<void> | null
  pumping: boolean
  currentCell: string | null
  /** Which press of Run the running cell came from; see stopBatchOf. */
  currentBatch: number | null
  /**
   * Что и когда начали, по часам сервера.
   *
   * Дубль поля `startedAt` в документе — и дубль намеренный: документ пишет вся
   * комната, а по этому числу считается длительность, которую потом показывают
   * как факт. Живой секундомер растёт из документа, длительность — отсюда.
   *
   * Пара, а не одно число: `currentCell` обнуляется в `finally` у `runOne`
   * СТРОКОЙ РАНЬШЕ, чем вызывается `setCellState`, так что связать отметку с
   * ячейкой через него нельзя — длительность просто перестала бы записываться,
   * и заметил бы это только тест.
   */
  started: { cellId: string; at: number } | null
  /** Who asked for the running cell — the server's own record, not the document's. */
  currentRunById: string | null
  /**
   * Ячейка, которая только что закончилась, и её пачка.
   *
   * Нужна ровно для одного: «стоп», нажатый на ячейке в тот момент, когда она
   * успела кончиться, а ядро уже взяло следующую. Без этой записи о цели
   * нажатия не остаётся ничего, и снималась пачка того, что выполняется
   * сейчас, — то есть чужая.
   */
  lastFinished: { cellId: string; batch: number } | null
  writer: OutputWriter | null
  /**
   * «Не выселяй комнату»: писатель держит `Y.Doc` дольше одного вызова.
   *
   * Пустая комната выселяется из памяти через десять минут (collab · sweepIdleRooms),
   * и выселение уничтожает документ. Писатель же взял его в конструкторе
   * (outputs.ts · OutputWriter) и пишет в ЭТОТ объект до конца выполнения: в
   * уничтоженный запись не видит никто и молча. Само окно счёта прикрыто со
   * стороны collab (`atWork` не даёт выселить комнату, пока в документе стоит
   * работающая ячейка, очередь или занятое ядро) — это страховка на щель между
   * концом прогона и обнулением `writer`. Держит `dropWriter`, он же отпускает.
   */
  writerHold: (() => void) | null
  /** Считается попытка консилиума, а не ячейка; `currentCell` при этом — её синтетическое имя. */
  job: ActiveJob | null
  /**
   * Which environment this room's kernel actually came up on.
   *
   * Not the same as "the environment configured right now": switching rebuilds
   * and restarts the container, but a room that was already running keeps the
   * Python it started with until its own kernel is replaced. The panel says so
   * in the footnote; this is what makes the column able to say it too.
   */
  environment: string | null
  /**
   * Семинар закрыт (удалён или убран по простою) — эта среда больше не его.
   *
   * `shutdownSession` снимает среду с карты, но подъём ядра, начатый до этого,
   * доживает свою минуту на захваченном объекте — и всё, что он пишет, идёт
   * через `getSessionDoc`, который заводит документ заново. Удалённая комната
   * возвращалась в память, а с ней папка с новым session.ipynb и строка в
   * истории. Правило то же, что в collab: заводить документ имеет право только
   * то, что делает человек.
   */
  retired: boolean
}

const runtimes = new Map<string, Runtime>()
const workspaceListeners: Array<(sessionId: string) => void> = []

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function getRuntime(sessionId: string): Runtime {
  let runtime = runtimes.get(sessionId)
  if (!runtime) {
    runtime = {
      sessionId,
      kernel: null,
      starting: null,
      restarting: null,
      queue: [],
      beforeNext: null,
      pumping: false,
      currentCell: null,
      currentBatch: null,
      started: null,
      currentRunById: null,
      lastFinished: null,
      writer: null,
      writerHold: null,
      job: null,
      environment: null,
      retired: false,
    }
    runtimes.set(sessionId, runtime)
  }
  return runtime
}

/**
 * Закончить с писателем вывода: дописать накопленное и отпустить комнату.
 *
 * Одно место на все концы выполнения — пустая ячейка, `finally` у `runOne`,
 * мёртвое ядро, конец семинара, остановка сервера, — потому что забыть здесь
 * можно ровно одно, и молча: `holdRoom` не отпущен, и комната, в которую никто
 * не вернётся, остаётся в памяти навсегда. Повторный вызов безопасен: и
 * `dispose`, и «отпустить» идемпотентны.
 */
function dropWriter(runtime: Runtime): void {
  runtime.writer?.dispose()
  runtime.writer = null
  runtime.writerHold?.()
  runtime.writerHold = null
}

/* --------------------------------------------------------- document mirror */

function setStatus(runtime: Runtime, status: KernelStatus): void {
  if (runtime.retired) return
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  if (meta.get('kernelStatus') === status) return
  doc.transact(() => meta.set('kernelStatus', status), ORIGIN)
}

/**
 * Почему последний подъём не вышел — словом для совета преподавателю, или
 * ничего (см. shared/kernel-problem.ts). Поднялось ядро или упало по другой
 * причине — прежнее слово снимается: совет «уменьшите память» к комнате,
 * которой не отвечает Jupyter, был бы неправдой.
 */
function setKernelProblem(runtime: Runtime, problem: KernelProblem | null): void {
  if (runtime.retired) return
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  if (problem === null && !meta.has(KERNEL_PROBLEM_KEY)) return
  doc.transact(() => {
    if (problem === null) meta.delete(KERNEL_PROBLEM_KEY)
    else meta.set(KERNEL_PROBLEM_KEY, { ...problem })
  }, ORIGIN)
}

/**
 * Самая узкая правка списка: что выкинуть и что вставить, чтобы `current` стал
 * `next`.
 *
 * Очередь меняется двумя способами и обоими — по краям: ячейка ушла в работу
 * (пропал первый элемент) или встала в хвост (появился последний). Полная
 * перезапись превращала каждый из них в «удалить всё и положить всё»: при
 * пятистах участниках и правиле «по одной» это сотни идентификаторов в
 * обновлении Yjs — на КАЖДЫЙ старт и КАЖДЫЙ конец ячейки, всей комнате, плюс
 * столько же тумбстоунов в документе и лишний обход `record()` в истории.
 *
 * Считается по общей голове и общему хвосту, а не по «умному» диффу: очередь —
 * список без повторов, и этого достаточно, чтобы обычные два случая стоили
 * одной операции. Чистая функция — её и надо доказывать.
 */
export function queueDelta(
  current: string[],
  next: string[],
): { at: number; remove: number; insert: string[] } {
  let head = 0
  while (head < current.length && head < next.length && current[head] === next[head]) head++
  let tail = 0
  while (
    tail < current.length - head &&
    tail < next.length - head &&
    current[current.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++
  }
  return {
    at: head,
    remove: current.length - head - tail,
    insert: next.slice(head, next.length - tail),
  }
}

function syncQueue(runtime: Runtime): void {
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  // Попытки консилиума в зеркало не попадают: у них нет ячейки, которую
  // комната могла бы подсветить, а чип «2 queued» и так честен — он про лист.
  const ids = runtime.queue.filter((item) => !item.council).map((item) => item.cellId)
  const running = runtime.job ? null : (runtime.currentCell ?? null)

  const existing = meta.get('queue')
  const current = existing instanceof Y.Array ? (existing.toArray() as string[]) : null
  const queueUnchanged =
    current !== null && current.length === ids.length && current.every((id, i) => id === ids[i])
  if (queueUnchanged && meta.get('runningCell') === running) return

  doc.transact(() => {
    let list = meta.get('queue') as Y.Array<string> | undefined
    if (!(list instanceof Y.Array)) {
      list = new Y.Array<string>()
      meta.set('queue', list)
    }
    /*
     * Список трогается ТОЛЬКО когда он правда изменился.
     *
     * Смена одной `runningCell` — самое частое, что здесь происходит (два раза
     * на ячейку), и списка она не касается вовсе: раньше он всё равно
     * переписывался целиком.
     */
    if (!queueUnchanged) {
      const delta = queueDelta((list.toArray() as string[]) ?? [], ids)
      if (delta.remove > 0) list.delete(delta.at, delta.remove)
      if (delta.insert.length > 0) list.insert(delta.at, delta.insert)
    }
    meta.set('runningCell', running)
  }, ORIGIN)
}

/**
 * Send one cell to the kernel, bringing a new one up if the old one turns out
 * to have died while nobody was looking. Retries once and only for that: a
 * kernel that dies *during* the run is a real failure the room needs to see.
 */
async function runOnKernel(
  runtime: Runtime,
  source: string,
  handlers: Parameters<JupyterKernel['execute']>[1],
  opts?: Parameters<JupyterKernel['execute']>[2],
): Promise<ExecuteStatus> {
  try {
    return await runtime.kernel!.execute(source, handlers, opts)
  } catch (err) {
    if (runtime.kernel && runtime.kernel.phase !== 'dead') throw err
    kernelNote(
      runtime.sessionId,
      tr("server.theKernelHadStoppedStartingAFresh.65e2e2"),
    )
    await ensureKernel(runtime.sessionId)
    /*
     * Секундомер заводится заново, когда ядро наконец есть.
     *
     * Подъём холодного контейнера — это до полутора минут, и они шли в счёт
     * ячейки: однострочник отчитывался о полутора минутах работы, хотя считал
     * миллисекунды. Ждали при этом не его.
     */
    restamp(runtime)
    return await runtime.kernel!.execute(source, handlers, opts)
  }
}

/** Заново отметить начало выполнения — и в среде, и в документе. */
function restamp(runtime: Runtime): void {
  const cellId = runtime.currentCell
  if (!cellId) return
  const at = Date.now()
  runtime.started = { cellId, at }
  // И предел попытки отсчитывается заново по тому же доводу, что и секундомер:
  // полторы минуты подъёма холодного ядра — не время запуска, и сгорать в них
  // тридцатисекундному пределу нечестно.
  if (runtime.job?.item.cellId === cellId) armLimit(runtime, runtime.job)
  const { doc } = getSessionDoc(runtime.sessionId)
  const found = findCell(doc, cellId)
  if (found) doc.transact(() => found.cell.set('startedAt', at), ORIGIN)
}

/**
 * Единственная дверь из 'running' наружу — и потому единственное место, где
 * гасится секундомер.
 *
 * Сюда приходят все три конца выполнения: пустая ячейка, обычное завершение и
 * `reportDeadKernel`. Бросок из `execute` тоже: `runOne` ловит его сам и
 * доходит до этой же строки. Поэтому три ключа — `state`, `startedAt`, `ranMs`
 * — держатся согласованными здесь, а не в трёх местах порознь.
 *
 * `ranMs` пишется только на исходах, которые действительно чем-то кончились:
 * у прерванного выполнения нет времени завершения, и напечатать его рядом с
 * `Out [n]` значило бы объявить результат, которого не было. Проверка на
 * `was === 'running'` нужна ради `reportDeadKernel`: он приходит сюда и за
 * ячейками, которые стояли в очереди и не начинались.
 */
function setCellState(sessionId: string, cellId: string, state: CellState): void {
  const { doc } = getSessionDoc(sessionId)
  const found = findCell(doc, cellId)
  if (!found) return
  /*
   * Длительность считается по записи сервера, а не по полю документа.
   *
   * `startedAt` лежит в общем документе, а его пишет кто угодно в комнате — это
   * устройство продукта, а не дыра. Считать по нему длительность значило дать
   * любому студенту дописать преподавателю «выполнялось три часа». Поле в
   * документе остаётся тем, чем и было: числом, от которого в браузере растёт
   * секундомер. Настоящее время начала сервер держит у себя.
   */
  const runtime = runtimes.get(sessionId)
  const startedAt = runtime?.started?.cellId === cellId ? runtime.started.at : null
  doc.transact(() => {
    const was = found.cell.get('state') as CellState | undefined
    found.cell.set('state', state)
    if (found.cell.get('startedAt') != null) found.cell.set('startedAt', null)
    if (was === 'running' && (state === 'ok' || state === 'error') && startedAt !== null) {
      found.cell.set('ranMs', Math.max(0, Date.now() - startedAt))
    }
  }, ORIGIN)
  if (runtime?.started?.cellId === cellId) runtime.started = null
}

/**
 * Как часто одной комнате имеет смысл проходить по призракам.
 *
 * Поводов три — пульс, нажатие, подключение управляющего сокета, — и все три
 * приходят пачкой: после перезапуска сервера пятьсот вкладок возвращаются за
 * две секунды, и это пятьсот транзакций по всем ячейкам всех тетрадей ОДНОЙ
 * комнаты ровно в ту секунду, когда весь зал ждёт синхронизации. Чинит же этот
 * проход то, что осталось от умершего процесса: оно уже лежит в документе и
 * будет найдено первым же вызовом, а не пятисотым.
 */
const ORPHAN_SWEEP_EVERY_MS = 2000

/** Когда по этой комнате проходили в последний раз, по часам сервера. */
const orphanSweeps = new Map<string, number>()

/**
 * Ячейки, которые документ считает работающими, а сервер о них не знает.
 *
 * `clearStaleExecution` проходит один раз, при подъёме комнаты, — и этого мало.
 * Вкладка, открытая в момент падения сервера, держит свои обновления и при
 * переподключении сливает их обратно как есть. Yjs решает по каждому ключу
 * отдельно и по последней записи, так что 'running' из умершего процесса может
 * пережить сброс — и до этой правки такая ячейка просто тихо стояла. Теперь она
 * дышит и считает секунды до конца пары: анимация сделала старую тихую беду
 * громкой, и чинить её приходится здесь.
 *
 * `runtimes.get`, а не `getRuntime`: комната, в которой никто ничего не
 * запускал, не должна обзаводиться средой исполнения от одной проверки.
 *
 * Отвергнутый вариант — повесить отложенный проход на `doc.on('update')` в
 * collab. Это точный момент, и он же цикл: ядро берёт `getSessionDoc` у collab,
 * так что обратный импорт замкнул бы модули друг на друга. Три дешёвых повода
 * лучше одного красивого цикла.
 *
 * `now` — часы вызывающего: окно между проходами (ORPHAN_SWEEP_EVERY_MS) можно
 * проверить из теста, не ожидая его вживую, — тот же приём, что у
 * collab · sweepIdleRooms.
 */
export function sweepOrphanRuns(sessionId: string, now: number = Date.now()): number {
  // Прошли по этой комнате только что — второй раз незачем. Проверка стоит до
  // `getSessionDoc`: обход документа и есть та цена, ради которой окно заведено.
  const last = orphanSweeps.get(sessionId)
  if (last !== undefined && now - last < ORPHAN_SWEEP_EVERY_MS) return 0
  orphanSweeps.set(sessionId, now)
  const runtime = runtimes.get(sessionId)
  const { doc } = getSessionDoc(sessionId)
  // По всем тетрадям комнаты: ядро одно, очередь одна, и застрявшая ячейка
  // может стоять в любой открытой.
  const cells = allCellArrays(doc).flatMap((array: Y.Array<YCell>) => array.toArray())
  let repaired = 0

  doc.transact(() => {
    for (const cell of cells) {
      const state = cell.get('state')
      if (state !== 'running' && state !== 'queued') continue
      const id = idOf(cell)
      const ours =
        runtime && (runtime.currentCell === id || runtime.queue.some((q) => q.cellId === id))
      if (ours) continue
      cell.set('state', 'idle' as CellState)
      cell.set('startedAt', null)
      // Вместе с состоянием гаснет и вопрос ядра.
      //
      // Ячейка, остановившаяся в input(), несёт `stdin` — по нему рисуется
      // форма ответа. Погасить состояние и оставить форму значит показать
      // комнате поле ввода, за которым уже никого нет: отвечать некому,
      // «Send» уходит в пустоту, и убрать это с экрана нечем.
      if (cell.get('stdin') != null) cell.set('stdin', null)
      repaired++
    }
  }, ORIGIN)

  /*
   * Половина призрака — тоже призрак.
   *
   * Кроме состояния ячеек тот же умерший процесс оставляет за собой своё
   * зеркало в meta: `runningCell`, `queue` и `kernelStatus`. Их пишет только
   * сервер, клиент их читает — и читает по ним чип «2 queued» в панели,
   * строку «Maria — running cell 05» в списке людей и то, рисовать ли комнатный
   * Interrupt включённым. Почистить ячейки и оставить зеркало значило починить
   * то, что видно, и оставить то, по чему считают.
   *
   * `syncQueue` умеет ровно это и сам ничего не пишет, когда зеркало и так
   * право. Когда среды исполнения нет вовсе — а это и есть случай после
   * перезапуска — чистим прямо, как это делает clearStaleExecution.
   */
  if (repaired > 0) {
    if (runtime) syncQueue(runtime)
    else {
      const meta = getMeta(doc)
      doc.transact(() => {
        const queue = meta.get('queue')
        if (queue instanceof Y.Array && queue.length > 0) queue.delete(0, queue.length)
        if (meta.get('runningCell') != null) meta.set('runningCell', null)
        const status = meta.get('kernelStatus')
        if (status === 'busy' || status === 'restarting') {
          meta.set('kernelStatus', 'idle' as KernelStatus)
        }
      }, ORIGIN)
    }
  }

  // runBy, runById, execCount, ranMs и вывод остаются: та же позиция, что у
  // clearStaleExecution — мы гасим то, что происходит, и не трогаем то, что
  // произошло.
  return repaired
}

/** Queued work the kernel will never get to; put those cells back to rest. */
function dropQueue(runtime: Runtime): void {
  if (runtime.queue.length === 0) {
    syncQueue(runtime)
    return
  }
  const dropped = runtime.queue.splice(0, runtime.queue.length)
  const { doc } = getSessionDoc(runtime.sessionId)
  doc.transact(() => {
    for (const item of dropped) {
      const found = findCell(doc, item.cellId)
      if (found && found.cell.get('state') === 'queued')
        found.cell.set('state', 'idle' as CellState)
    }
  }, ORIGIN)
  releaseCouncil(runtime, dropped)
  syncQueue(runtime)
}

/**
 * Попытки, снятые с очереди без запуска, — об этом надо сказать их авторам.
 *
 * У ячейки та же новость ложится в документ (`state: 'idle'`), и комната видит
 * её сама. У попытки документа нет: не позвать — значит оставить на карточке
 * «в очереди» до конца пары. `null` — «запуска не было», см. CouncilJob.
 */
function releaseCouncil(runtime: Runtime, dropped: QueueItem[]): void {
  for (const item of dropped) {
    finishExecution(runtime, item, 'cancelled')
    if (item.council) tellJob(item.council, null)
  }
}

/** Обратный вызов чужого модуля не должен уметь уронить насос. */
function tellJob(job: CouncilJob, run: CouncilRun | null): void {
  try {
    job.onChange(run)
  } catch (err) {
    console.error(`[kernel] council listener failed for ${job.cellId}:`, errText(err))
  }
}

/**
 * Окно, в котором ядра падают не сами по себе.
 *
 * Смена окружения пересоздаёт контейнер, и все комнаты, которые в этот момент
 * что-то считали, теряют ядро разом. Каждая слышала «The kernel ran out of
 * memory» — фразу правильную для девяноста девяти падений из ста и совершенно
 * ложную здесь. Преподаватель шёл смотреть, чья ячейка съела память, а её
 * никто не ел: администратор нажал «использовать это окружение».
 *
 * Окно, а не флажок на комнату: пересоздание идёт по всем контейнерам сразу и
 * растянуто на секунды, а знает о нём один HTTP-запрос, который к этому
 * времени уже ответил.
 */
let churn: { reason: string; until: number } | null = null

export function expectKernelChurn(reason: string, ms = 120_000): void {
  churn = { reason, until: Date.now() + ms }
}

function churnReason(): string | null {
  if (!churn) return null
  if (Date.now() > churn.until) {
    churn = null
    return null
  }
  return churn.reason
}

/**
 * Досказать комнате, ПОЧЕМУ ядра не стало.
 *
 * Первая заметка уходит мгновенно и говорит правду о последствиях: переменных
 * нет, очередь пуста. Причина приезжает следом, через полсекунды, потому что
 * за ней надо сходить к docker — и ждать её, держа комнату в неведении, было бы
 * хуже, чем дописать вторую строку. В журнале ядра это две строки подряд, и
 * читаются они как одна мысль: что случилось и отчего.
 *
 * Номер ячейки — тот же, что нарисован в комнате слева от неё: порядковый в
 * своей тетради, считая markdown. Иначе преподаватель идёт искать «ячейку 11»
 * там, где на экране написано 21.
 *
 * Ничего не обещает: `explain` возвращает `null`, когда сказать нечего, и
 * молчание здесь — осознанный ответ, а не потерянная ошибка.
 */
function tellWhyItDied(runtime: Runtime, cellId: string | null): void {
  // Закрытой комнате — молча: и заметка, и сам поиск ячейки завели бы её
  // документ заново, а рассказывать причину уже некому.
  if (runtime.retired) return
  const doc = (() => {
    try {
      return getSessionDoc(runtime.sessionId).doc
    } catch {
      return null
    }
  })()
  const found = cellId && doc ? findCell(doc, cellId) : null
  const cell = found ? found.index + 1 : null
  void explainDeath(runtime.sessionId, cell)
    .then((why) => {
      if (!why) return
      // В журнал машины — тем же словом `oom`, по которому эту беду уже ищут
      // одним grep, и с числами, которых там до сих пор не было.
      console.warn(`[kernel ${runtime.sessionId}] ${why.oom ? 'oom' : 'died'}: ${why.text}`)
      if (!runtime.retired) kernelNote(runtime.sessionId, why.text)
    })
    .catch(() => {
      /* Вскрытие, сорвавшее работу комнаты, — хуже отсутствия вскрытия. */
    })
}

function onPhase(runtime: Runtime, phase: KernelPhase, expected = false): void {
  /*
   * Jupyter restarting the kernel by itself — the container's OOM killer,
   * almost always. The process is gone and coming back under the same id, so
   * this is neither `dead` (nothing to start) nor an ordinary phase (there is
   * something to say). The cell that was running gets its KernelDied from the
   * aborted execute; what is said here is for the rest of the room, and the
   * queue is dropped because everything in it assumed variables that no longer
   * exist.
   */
  if (phase === 'restarting' && !expected) {
    const hadWork = runtime.currentCell !== null || runtime.queue.length > 0
    dropQueue(runtime)
    setStatus(runtime, 'restarting')
    /*
     * И номера выполнений — со всей тетради, как это делает ручной Restart.
     *
     * Процесс новый, переменных нет, а `Out [12]` над каждым прошлым выводом
     * остаётся и утверждает обратное; по нему же клиент решает, показывать ли
     * «From an earlier run — the kernel restarted». Без этой строки врала не
     * одна убитая ячейка, а вся тетрадь.
     */
    resetAllCells(runtime.sessionId, runtime.currentCell)
    const known = churnReason()
    /*
     * В журнал — отдельной строкой, и словом «oom».
     *
     * Комнате об этом говорят её же словами (kernelNote ниже), но те слова
     * живут в тетради и умирают вместе с ней. Тому, кто через день выясняет,
     * почему у семинара пропали переменные, нужна строка с идентификатором
     * комнаты и временем — а по `oom` её ещё и найдут одним grep. Слово это
     * ставится только там, где причина неизвестна: пересборку окружения из
     * панели ядро переживает так же, и объявить её нехваткой памяти значило бы
     * отправить искать несуществующую прожорливую ячейку.
     */
    console.warn(`[kernel ${runtime.sessionId}] restarted itself — ${known ? 'churn' : 'oom'}`)
    kernelNote(
      runtime.sessionId,
      known
        ? tr("server.everyVariableIsGone.eff831", { p0: known, p1: hadWork ? '; whatever was queued was dropped' : '' })
        : hadWork
          ? tr("server.theKernelRestartedUnexpectedlyVariablesWereReset.f87dd9")
          : tr("server.theKernelRestartedUnexpectedlyVariablesWereReset.a76c88"),
    )
    // Пересборка окружения объяснена и без docker; всё остальное объясняет он.
    if (!known) tellWhyItDied(runtime, runtime.currentCell)
    return
  }
  if (phase === 'dead') {
    /*
     * Found by asking, before the cell was sent: the run is about to be retried
     * on a fresh kernel and will say so itself. Two notices, one of them about a
     * cell that then runs perfectly well, is worse than one.
     *
     * И очередь при этом не трогаем — она стояла ЗА этой ячейкой и поедет на
     * том же свежем ядре. Раньше `dropQueue` стоял выше проверки, и Run All на
     * ядре, умершем на перемене, выполнял ровно одну ячейку: остальные молча
     * возвращались в покой (заметки о них нет — `return` стоит раньше), причём
     * вместе с чужими пачками, вопреки обещанию «сбой останавливает только
     * свою». Сбоя тут и нет: ядро подменяют до отправки.
     */
    if (expected) {
      setStatus(runtime, 'dead')
      return
    }
    const hadWork = runtime.currentCell !== null || runtime.queue.length > 0
    dropQueue(runtime)
    setStatus(runtime, 'dead')
    // A kernel usually dies because a cell asked for more memory than the
    // container has. Saying so beats a room staring at a notebook that stopped.
    const known = churnReason()
    // Смерть ядра — то, из-за чего пара останавливается; в журнале это обязано
    // быть строкой, а не только заметкой в тетради, которая уедет вместе с ней.
    console.warn(
      `[kernel ${runtime.sessionId}] died${hadWork ? ' mid-run' : ''}${known ? ' — churn' : ''}`,
    )
    kernelNote(
      runtime.sessionId,
      known
        ? tr("server.runACellToStartAFresh.ffee95", { p0: known, p1: hadWork ? tr("server.whateverWasQueuedWasDropped.752abc") : '' })
        : hadWork
          ? tr("server.theKernelStoppedDuringExecutionQueuedCells.74ec64")
          : tr("server.theKernelStoppedRestartItToRun.911803"),
    )
    if (!known) tellWhyItDied(runtime, runtime.currentCell)
    return
  }
  // A cell mid-run keeps the room's status honest even between kernel messages.
  setStatus(runtime, runtime.currentCell ? 'busy' : phase)
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Idempotent and concurrency-safe: five students hitting Run at once share one
 * connect. A kernel that has died counts as absent, so the next Run quietly
 * brings a fresh one up instead of demanding a manual restart.
 */
export function ensureKernel(sessionId: string): Promise<void> {
  const runtime = getRuntime(sessionId)
  if (runtime.kernel && runtime.kernel.phase !== 'dead') return Promise.resolve()
  if (runtime.starting) return runtime.starting

  const dead = runtime.kernel
  runtime.kernel = null

  /*
   * A kernel that cannot be reached takes the full startup timeout to say so,
   * and a minute of "starting…" with nothing else is indistinguishable from a
   * room that is simply broken. Say something while it is still trying: the
   * seminar is usually in the middle of something and can decide whether to
   * wait or go on without Python.
   */
  const envName = sessionEnvironment(sessionId) ?? activeName()
  const slow = setTimeout(() => {
    /*
     * Про то окружение, которое поднимается, а не про глобальный адрес.
     *
     * Здесь стоял `config.jupyter.url` — «kernel:8888», общая настройка. Но
     * ждут обычно не его: комната на своём окружении поднимает свой контейнер,
     * и это те самые полторы минуты. Названный не тот адрес превращает
     * объяснение в загадку — идти чинить kernel:8888, который в этот момент
     * жив и совершенно ни при чём.
     */
    if (runtime.retired) return
    kernelNote(
      sessionId,
      envName
        ? tr("server.startingTheEnvironmentWaitingForTheKernel.df8f76", { p0: envName })
        : tr("server.waitingForTheKernelAtCellsCannot.8019bf", { p0: config.jupyter.url }),
    )
  }, SLOW_START_NOTICE_MS)

  runtime.starting = (async () => {
    setStatus(runtime, 'starting')
    // Read at the moment the kernel is built, not at the moment it is asked
    // for: that is the value the container will actually have.
    runtime.environment = envName
    if (dead) {
      try {
        await dead.dispose()
      } catch {
        /* it was already gone */
      }
    }
    // Какое окружение сейчас спрашиваем — понадобится, если оно не ответит.
    const wanted = sessionEnvironment(sessionId)
    try {
      // Куда идти за Python — решает сама комната: у каждой свой контейнер, и
      // окружение выбирает только образ, из которого он поднят.
      const endpoint = await endpointForSession(sessionId, wanted)
      const kernel = await JupyterKernel.connect(sessionId, endpoint)
      if (runtime.retired) {
        // Семинар закрыли, пока ядро поднималось. Подключаться теперь не к
        // чему: без этой ветки сокет и сторож живого ядра остались бы висеть
        // на среде, которой уже нет в карте, до перезапуска сервера.
        await kernel.dispose().catch(() => {})
        return
      }
      runtime.kernel = kernel
      setKernelProblem(runtime, null)
      kernel.onPhaseChange((phase, expected) => onPhase(runtime, phase, expected))
      // Before anything of ours is sent: a kernel that is already busy is
      // finishing a cell for a server that no longer exists, and it would make
      // every Run in this room wait behind output nobody will ever see.
      if ((await kernel.releaseOrphanedWork()) && !runtime.retired) {
        kernelNote(
          sessionId,
          tr("server.reconnectedToTheExistingKernelTheRunning.a20941"),
        )
      }
      setStatus(runtime, runtime.currentCell ? 'busy' : (kernel.phase as KernelStatus))
      // Подъём ядра — настоящее событие: до полутора минут холодного старта, и
      // именно между этой строкой и следующей комната смотрит в пустоту.
      console.log(`[kernel ${sessionId}] up (${envName ?? 'shared'})`)
      /*
       * Точка отсчёта для будущего вскрытия.
       *
       * Счётчик убийств по памяти у контейнера сквозной — он считает с рождения
       * контейнера, а контейнер переживает и смену ядра, и перезапуск сервера.
       * Не запомнив его сейчас, на первой же смерти мы не отличим «убит этой
       * ячейкой» от «убит утром на прошлой паре». Не ждём: старт комнаты не
       * должен стоять из-за диагностики, которая понадобится через час.
       */
      void sampleKills(sessionId)
    } catch (err) {
      setStatus(runtime, 'dead')
      // Отказ планировщика — слово для совета преподавателю; остальное его снимает.
      const problem = err instanceof RuntimeRequestError ? err.failure ?? null : null
      setKernelProblem(runtime, problem)
      // Не чаще раза в минуту на комнату: `ensureKernel` зовёт и вход каждого
      // студента, и каждый Run, а обещание у них одно на всех — тридцать
      // одинаковых строк в ту же миллисекунду мы уже видели.
      if (seldom(`kernel-down:${sessionId}`)) {
        // Текст ошибки здесь — студенческий, поэтому в журнал ещё и слово:
        // оператору по нему искать в событиях кластера.
        const lacking = problem ? ` [unschedulable: ${problem.unschedulable}]` : ''
        console.warn(`[kernel ${sessionId}] did not start: ${errText(err)}${lacking}`)
      }
      /*
       * Забыть запомненный адрес контейнера.
       *
       * Порт у контейнера комнаты случайный, и пул его кеширует. После
       * `docker restart colloq-room-<id>` порт другой, а комната ходит по
       * старому — и будет ходить, пока не перезапустят весь сервер: «No Python
       * kernel after 60s» на каждый Run, при живом и здоровом контейнере рядом.
       */
      forgetSessionKernel(sessionId)
      // Into the shared record too: the person who presses Run sees the message
      // on their cell, and everyone else sees a notebook that stopped.
      // Закрытой комнате — молча: заметка завела бы её документ заново.
      if (!runtime.retired) kernelNote(sessionId, errText(err))
      throw err
    } finally {
      clearTimeout(slow)
      runtime.starting = null
    }
  })()

  return runtime.starting
}

/*
 * Пересозданный контейнер — новость для комнаты, а не для журнала сервера.
 *
 * Пул сносит контейнер, когда тот собран из старого образа, стоит не в той
 * сети, держит чужой срез GPU или не принимает наш токен. Каждый такой случай
 * стоит семинару всех переменных сразу — и до сих пор проходил молча: `x` был и
 * вдруг NameError, а на экране ни строки. Теперь строка есть, и в ней сказано
 * почему.
 */
onRoomKernelRecreated((sessionId, why) => {
  // Контейнер новый — и счётчик его убийств тоже начинается с нуля.
  forgetKills(sessionId)
  // Закрытой комнате — молча: заметка завела бы её документ заново.
  if (runtimes.get(sessionId)?.retired) return
  kernelNote(
    sessionId,
    tr("server.theRoomSPythonContainerHadTo.253b0b", { p0: why }) +
      'The files in the Files panel are untouched; run your cells again.',
  )
})

/**
 * A line in the room's shared transcript, under the terminal's "Kernel log" tab.
 *
 * That tab was drawn for exactly this and had nothing in it: a kernel that
 * restarted or died was invisible to everybody except whoever pressed the
 * button. A student who ran three cells and looked away came back to an unrun
 * notebook with no explanation anywhere.
 *
 * Written straight into the document rather than through the live terminal,
 * because the news matters whether or not anyone has the drawer open; the
 * terminal rebuilds its own bookkeeping from these lines when it next opens.
 */
export function kernelNote(sessionId: string, text: string): void {
  try {
    const { doc } = getSessionDoc(sessionId)
    doc.transact(() => {
      getTerminal(doc).push([createTerminalLine({ kind: 'system', text })])
    }, ORIGIN)
  } catch {
    // Never let a log line be the reason a restart fails.
  }
}

export async function restartSession(sessionId: string, restartedBy?: string): Promise<void> {
  const runtime = getRuntime(sessionId)
  // Два нажатия — один перезапуск. Второе присоединяется к первому, а не
  // запускает поверх него ещё один.
  if (runtime.restarting) return runtime.restarting
  if (runtime.activityItem) runtime.activityItem.activityCancelled = true
  dropQueue(runtime)
  setStatus(runtime, 'restarting')

  runtime.restarting = (async () => {
    try {
      if (runtime.kernel && runtime.kernel.phase !== 'dead') await runtime.kernel.restart()
      else await ensureKernel(sessionId)
      resetAllCells(sessionId, runtime.currentCell)
      setStatus(runtime, 'idle')
      kernelNote(
        sessionId,
        restartedBy
          ? tr("server.kernelRestartedByEveryVariableIsGone.3322fd", { p0: restartedBy })
          : tr("server.kernelRestartedEveryVariableIsGoneAnd.38530e"),
      )
    } catch (err) {
      // Never a rejection: the person clicked a button, the document carries the news.
      console.error(`[kernel] restart failed for ${sessionId}:`, errText(err))
      setStatus(runtime, 'dead')
      kernelNote(
        sessionId,
        tr("server.theKernelDidNotComeBackAfter.cadaf5"),
      )
    }
  })()

  try {
    await runtime.restarting
  } finally {
    runtime.restarting = null
    // Что успели поставить в очередь, пока ядро возвращалось, — теперь можно.
    void pump(runtime)
  }
}

/**
 * @param cellId Ячейка, ради которой нажали. Комнатная кнопка её не называет.
 *
 * Нажатие на самой ячейке называет свою цель, и это исправление, а не удобство.
 * Кнопка нарисована по состоянию документа, а документ отстаёт от сервера на
 * круг: нажать «стоп» в промежутке между двумя ячейками Run All значило попасть
 * в ветку `else` внизу и вынести очередь всей комнаты — включая батчи людей,
 * которые ничего не нажимали. Пока «стоп» жил только внизу ячейки, попасть в
 * этот промежуток было трудно; кнопка под курсором делает это лёгким.
 *
 * Без `cellId` поведение прежнее, и эта ветка нужна: комнатный Interrupt в
 * верхней панели — единственный способ разобрать скопившуюся очередь одним
 * нажатием, когда не выполняется ничего.
 */
export async function interruptSession(sessionId: string, cellId?: string): Promise<void> {
  const runtime = getRuntime(sessionId)
  /*
   * Drop the tail first: interrupting cell 3 of 10 must not start cell 4.
   *
   * The tail is this press of Run, not the whole room's. Dropping everything
   * meant a student stopping their own loop silently cancelled thirty cells
   * the teacher had queued with Run All — who then saw a notebook that had
   * simply stopped, decided Run All had not worked, and pressed it again. It
   * also walked straight past the ownership check above, which exists exactly
   * so one person cannot cancel another's work.
   */
  const running = runtime.currentCell
  /*
   * Проверка цели стоит только на второй ветке, и это существенно.
   *
   * Сначала она стояла над всей функцией, и получалось строго хуже задуманного:
   * нажатие, промахнувшееся мимо своей ячейки, не делало вообще ничего — а
   * ядро в этот момент считает следующую ячейку того же Run All, и человек,
   * который жал «стоп», остаётся с работающей тетрадью и молчащей кнопкой.
   *
   * Опасна была ровно нижняя ветка: `dropQueue` выносит очередь всей комнаты,
   * включая чужие батчи. `stopBatchOf` так не умеет — он ограничен батчем той
   * ячейки, которая сейчас выполняется, — поэтому остановить текущую работу
   * можно и промахнувшимся нажатием, а вот разбирать очередь по промаху нельзя.
   */
  if (running) {
    /*
     * SIGINT всё равно достаётся тому, что считается: ядро одно, и выбирать
     * ему не из чего. А вот очередь по промаху разбираем только свою.
     *
     * Промах между двумя ячейками бывает и межвладельческим: преподаватель
     * жмёт «стоп» на своей ячейке ровно когда она кончилась, а ядро уже взяло
     * первую ячейку из Run All студента. Снять с неё пачку значило погасить
     * двенадцать чужих ячеек без объяснения — и именно это раньше и
     * происходило, потому что `stopBatchOf` по текущей ячейке падал на
     * `currentBatch`. Цель, о которой мы вообще ничего не знаем (ячейку успели
     * удалить), считается своей, как и прежде.
     */
    const batch = cellId === undefined ? runtime.currentBatch : batchOf(runtime, cellId)
    if (batch === null || batch === runtime.currentBatch) stopBatchOf(runtime, running)
  } else if (cellId === undefined) dropQueue(runtime)
  if (!runtime.kernel || runtime.kernel.phase === 'dead') return
  if (runtime.activityItem) runtime.activityItem.activityCancelled = true
  try {
    await runtime.kernel.interrupt()
  } catch (err) {
    console.error(`[kernel] interrupt failed for ${sessionId}:`, errText(err))
  }
}

/**
 * Stop one session's kernel and its shell, and forget both. A deleted seminar
 * must not leave a process running in the container writing output into a
 * document that is on its way out — and because every writer here reaches for
 * the document through getSessionDoc(), which creates one on demand, this has
 * to finish before the document is evicted or it simply builds another.
 * Every other caller wants restartSession, which keeps the room.
 */
export async function shutdownSession(sessionId: string, permanent = false): Promise<void> {
  const runtime = runtimes.get(sessionId)
  if (runtime) {
    // Первым делом, до всякого await: подъём ядра, идущий прямо сейчас, увидит
    // этот признак и не станет ни писать в документ, ни оставлять за собой
    // подключённое ядро.
    runtime.retired = true
    runtimes.delete(sessionId)
    for (const item of runtime.queue) finishExecution(runtime, item, 'cancelled')
    runtime.queue.length = 0
    dropWriter(runtime)
    try {
      await runtime.kernel?.dispose()
    } catch (err) {
      console.error(`[kernel] could not stop ${sessionId}:`, errText(err))
    }
  }
  try {
    await closeTerminal(sessionId)
  } catch (err) {
    console.error(`[kernel] could not stop the terminal for ${sessionId}:`, errText(err))
  }
  // Комната кончилась: если её откроют снова, про общее ядро надо сказать
  // заново — это уже другое занятие.
  // И отметка прохода по призракам: комната кончилась, помнить о ней нечего.
  orphanSweeps.delete(sessionId)
  /*
   * И сам контейнер комнаты.
   *
   * Контейнер теперь один на семинар, а не один на окружение: не убрать его —
   * значит оставить по контейнеру на каждую пару, когда-либо проведённую на
   * этой машине. Файлы комнаты лежат на хосте и это переживают; уходит только
   * Python со всеми переменными, что и означает «семинар закончился».
   */
  // Deleting documents or files is safe only after the runtime confirms that
  // every room writer stopped. The caller must retain the room on failure.
  await dropRoomKernel(sessionId, permanent)
  // Счётчик убийств по памяти считает с рождения КОНТЕЙНЕРА. Контейнера
  // больше нет, а запомненное число пережило бы его и объявило бы первую же
  // смерть в новом контейнере «не по памяти».
  forgetKills(sessionId)
}

/* --------------------------------------------------------- уборка простоя */

/**
 * Сколько контейнер комнаты живёт после того, как из неё все вышли.
 *
 * Пара идёт полтора часа; два часа пустой комнаты — это «занятие кончилось», а
 * не «преподаватель вышел за кофе». Раньше уборки не требовалось вовсе:
 * контейнер был один на окружение и обслуживал всех. Теперь их по одному на
 * семинар, и без уборки на машине копится по контейнеру на каждую когда-либо
 * проведённую пару.
 */
const IDLE_KERNEL_MS = 2 * 60 * 60 * 1000
/**
 * Остановленному контейнеру столько ждать незачем.
 *
 * Два часа — это «преподаватель вышел за кофе, переменные семинара пусть
 * подождут». У остановленного контейнера переменных нет вовсе: его Python убит
 * вместе с ним, а держит он только слой на диске и — что дороже — свой срез
 * GPU, из-за которого следующий семинар слышит «свободных срезов нет». После
 * перезагрузки машины (`--restart=no`) такими становятся ВСЕ вчерашние
 * контейнеры сразу, так что цена ожидания — целое утро без GPU.
 */
const IDLE_STOPPED_KERNEL_MS = 30 * 60 * 1000
const SWEEP_EVERY_MS = 10 * 60 * 1000

/** Когда в комнате в последний раз кто-то был. */
const lastOccupied = new Map<string, number>()

/**
 * Что делать с контейнером комнаты прямо сейчас — одним правилом и без docker.
 *
 * `busy` — занята: кто-то в комнате, считается ячейка, стоит очередь или
 * работает команда в оболочке. `watch` — пустая, отсчёт идёт. `drop` — пустая
 * достаточно долго, контейнер убираем.
 *
 * Отдельной функцией, потому что ошибка была именно в правиле, а не в докере:
 * остановленные контейнеры в уборку не попадали вовсе, и на GPU-машине после
 * ночной перезагрузки все срезы оставались за комнатами, которых больше никто
 * не откроет.
 */
export function idleVerdict(opts: {
  running: boolean
  busy: boolean
  since: number | undefined
  now: number
}): 'busy' | 'watch' | 'drop' {
  if (opts.busy) return 'busy'
  if (opts.since === undefined) return 'watch'
  const limit = opts.running ? IDLE_KERNEL_MS : IDLE_STOPPED_KERNEL_MS
  return opts.now - opts.since < limit ? 'watch' : 'drop'
}

let idleSweep: Promise<void> | null = null

/** A broker outage postpones maintenance; it must not reject the interval's
 * detached promise or strand the single-flight slot for all later sweeps. */
export function sweepIdleKernels(): Promise<void> {
  if (idleSweep) return idleSweep
  const attempt = sweepIdleKernelsOnce()
    .catch(() => {
      if (seldom('kernel-idle-sweep-census', 60_000)) {
        console.warn('[kernel] idle sweep postponed: runtime room census failed; will retry at the next sweep')
      }
    })
    .finally(() => {
      if (idleSweep === attempt) idleSweep = null
    })
  idleSweep = attempt
  return attempt
}

async function sweepIdleKernelsOnce(): Promise<void> {
  const now = Date.now()
  /*
   * Не только те, что поднял этот процесс, и не только живые.
   *
   * `runningRoomKernels()` — карта в памяти, и после перезапуска сервера она
   * пуста, а вчерашние контейнеры работают: уборка о них не знала, пока кто-то
   * не откроет комнату, и они жили до `make down`. Метка docker переживает нас,
   * поэтому спрашиваем и её — вместе с остановленными (`docker ps -a`), которые
   * до сих пор не попадали в уборку НИКОГДА.
   */
  const rooms = new Map<string, boolean>()
  for (const sessionId of runningRoomKernels()) rooms.set(sessionId, true)
  for (const room of await listRoomKernels()) rooms.set(room.session, room.running)
  for (const [sessionId, running] of rooms) {
    const runtime = runtimes.get(sessionId)
    // Считающая комната занята, даже если все закрыли вкладки: у ячейки есть
    // хозяин, который вернётся за результатом. То же и у команды в оболочке:
    // трёхчасовое обучение, запущенное в терминале, — работа с хозяином, и
    // снести контейнер под ней значит убить её строкой «terminal closed».
    const busy =
      onlineCount(sessionId) > 0 ||
      !!runtime?.currentCell ||
      (runtime?.queue.length ?? 0) > 0 ||
      terminalPhase(sessionId) === 'busy'
    const verdict = idleVerdict({ running, busy, since: lastOccupied.get(sessionId), now })
    if (verdict !== 'drop') {
      // Занятую — отмечаем сейчас; пустую впервые — тоже сейчас: отсчёт
      // начинается с первого взгляда, а не от нуля.
      if (verdict === 'busy' || !lastOccupied.has(sessionId)) lastOccupied.set(sessionId, now)
      continue
    }
    try {
      await shutdownSession(sessionId)
      lastOccupied.delete(sessionId)
    } catch (err) {
      console.error(`[kernel] idle sweep failed for ${sessionId}:`, errText(err))
    }
  }
}

/*
 * `unref`: таймер не должен держать процесс живым — тесты и одноразовые
 * скрипты импортируют этот модуль и обязаны уметь завершиться.
 */
setInterval(() => void sweepIdleKernels(), SWEEP_EVERY_MS).unref()

/**
 * Stopping the server, not the seminars.
 *
 * This used to DELETE every Jupyter session, which killed every kernel in
 * every room. `make run` is what the Makefile tells a teacher to do after any
 * edit, so a one-line change wiped the variables of every class in progress —
 * and the re-attach path, built precisely so a restart is invisible, only ever
 * ran after a crash. Now the sockets are dropped and the processes are left
 * running; a room's kernel is ended when the room is (shutdownSession).
 */
export async function shutdownKernels(): Promise<void> {
  const all = [...runtimes.values()]
  runtimes.clear()
  // Отметки прохода — вместе со средами исполнения: следующий процесс начинает
  // с чистого листа, и первый же его повод обязан пройти по призракам.
  orphanSweeps.clear()
  for (const runtime of all) {
    for (const item of runtime.queue) finishExecution(runtime, item, 'cancelled')
    runtime.queue.length = 0
    dropWriter(runtime)
    runtime.kernel?.detach()
  }
}

/**
 * Состояние ядер для минутной сводки: живые, из них занятые, и мёртвые.
 *
 * Комнаты, которым ядро ещё ни разу не поднимали, здесь не считаются вовсе:
 * у них нет ядра, а не мёртвое — и записывать всю тетрадную комнату в потери
 * значило бы каждую минуту пугать того, кто читает журнал.
 */
export function kernelCensus(): { live: number; busy: number; dead: number } {
  let live = 0
  let busy = 0
  let dead = 0
  for (const runtime of runtimes.values()) {
    const phase = runtime.kernel?.phase
    if (!phase) continue
    if (phase === 'dead') {
      dead += 1
      continue
    }
    live += 1
    // Занято — это когда в комнате правда идёт ячейка: фаза 'busy' приходит от
    // Jupyter с задержкой, а `currentCell` знает об этом с самого execute.
    if (phase === 'busy' || runtime.currentCell !== null) busy += 1
  }
  return { live, busy, dead }
}

/**
 * Whether this participant is the one whose cell is running right now.
 *
 * Read from the runtime rather than the document: the document is shared and a
 * client could write `runById` into a cell itself. The queue is the server's
 * own record of who asked for what.
 */
export function startedTheRunningCell(sessionId: string, participantId: string): boolean {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return false
  if (runtime.currentCell) return runtime.currentRunById === participantId
  /*
   * Между двумя ячейками хозяин работы — тот, чья ячейка стоит первой.
   *
   * `currentRunById` теперь гаснет вместе с `currentCell` (иначе потолок «по
   * одной» отказывал прежнему автору, пока насос поднимает умершее ядро — а это
   * до полутора минут). Читать его в это окно было бы неправдой; но и отвечать
   * «нет» нельзя: ровно в этот промежуток человек, у которого идёт Run All,
   * жмёт «стоп», и отказ оставил бы его с работающей тетрадью и молчащей
   * кнопкой. Спрашиваем очередь — она про ту же работу и тоже наша.
   */
  return runtime.queue[0]?.runById === participantId
}

/**
 * Стоит ли в очереди только то, что поставил этот человек.
 *
 * Комнатное «остановить» выносит очередь целиком, а очередь общая: одно нажатие
 * убирало чужие пачки под тем же правом, под которым человек останавливает
 * свою ячейку. Пустая очередь считается своей — останавливать нечего.
 */
export function queueIsOnly(sessionId: string, participantId: string): boolean {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return true
  return runtime.queue.every((item) => item.runById === participantId)
}

/* -------------------------------------------------------------- run queue */

let batchCounter = 0

/**
 * Поставить ячейки в очередь.
 *
 * `cap` — сколько своих ячеек этот человек держит в очереди одновременно; при
 * правиле «по одной» это единица. Потолок, а не право: он и делает «по одной»
 * границей, а не счётчиком нажатий — скриптовый цикл из кадров `{t:'run'}`
 * ставит одну ячейку и получает фразу на остальные. Возвращает, сколько
 * ячеек не поместилось, чтобы вызывающий сказал это один раз, а не двадцать.
 */
export function requestRun(
  sessionId: string,
  cellIds: string[],
  runBy: string,
  runById: string,
  cap = Number.POSITIVE_INFINITY,
): number {
  const runtime = getRuntime(sessionId)
  // Нажатие чинит комнату, в которой нажали: если в ней осталась ячейка,
  // которую документ считает работающей, а сервер о ней не знает, — самое
  // время это заметить. См. sweepOrphanRuns.
  sweepOrphanRuns(sessionId)
  const { doc } = getSessionDoc(sessionId)
  const batch = ++batchCounter

  // Считается по среде исполнения, а не по документу: документ пишут все.
  let mine =
    runtime.queue.filter((item) => item.runById === runById).length +
    (runtime.currentRunById === runById ? 1 : 0)
  let refused = 0

  doc.transact(() => {
    for (const cellId of cellIds) {
      const found = findCell(doc, cellId)
      // Markdown cells arrive in every runAll list; skipping them is not an error.
      if (!found || cellType(found.cell) !== 'code') continue
      if (runtime.currentCell === cellId) continue
      if (runtime.queue.some((item) => item.cellId === cellId)) continue
      if (mine >= cap) {
        refused += 1
        continue
      }
      mine += 1
      const item: QueueItem = { cellId, runBy, runById, batch }
      item.activitySeq = executionActivity(runtime, item, 'execution.queued', { count: 1 })
      runtime.queue.push(item)
      found.cell.set('state', 'queued' as CellState)
      found.cell.set('runBy', runBy)
      found.cell.set('runById', runById)
    }
  }, ORIGIN)

  syncQueue(runtime)
  void pump(runtime)
  return refused
}

/**
 * Take cells back out of the queue.
 *
 * Only ones that are still waiting: the cell holding the kernel is Interrupt's
 * business, and this must never be a second, quieter way to stop somebody
 * else's run. Whoever queued a cell may cancel it, and so may the host.
 *
 * Ownership is decided from the server's own queue record rather than from the
 * cell's `runById`, which is a field in a document anyone in the room can write.
 *
 * Returns how many were actually removed, so the caller can tell the difference
 * between "cancelled" and "there was nothing of yours to cancel".
 */
export function cancelRun(
  sessionId: string,
  cellIds: string[],
  participantId: string,
  isHost: boolean,
): number {
  const runtime = getRuntime(sessionId)
  const wanted = new Set(cellIds)
  const removed: string[] = []

  runtime.queue = runtime.queue.filter((item) => {
    if (!wanted.has(item.cellId)) return true
    if (!isHost && item.runById !== participantId) return true
    removed.push(item.cellId)
    finishExecution(runtime, item, 'cancelled')
    return false
  })
  if (removed.length === 0) return 0

  const { doc } = getSessionDoc(sessionId)
  doc.transact(() => {
    for (const cellId of removed) {
      const found = findCell(doc, cellId)
      if (!found) continue
      found.cell.set('state', 'idle' as CellState)
      found.cell.set('runBy', null)
      found.cell.set('runById', null)
    }
  }, ORIGIN)
  syncQueue(runtime)
  return removed.length
}

/** Did the cell that just ran end in a traceback? */
function failed(runtime: Runtime, cellId: string): boolean {
  const { doc } = getSessionDoc(runtime.sessionId)
  return findCell(doc, cellId)?.cell.get('state') === 'error'
}

/**
 * Из какой пачки ячейка, названная нажатием, — насколько сервер это ещё помнит.
 *
 * `null` значит «не знаем»: ячейка не в очереди, не выполняется и кончилась не
 * последней. Тогда судить о пачке нечем, и решает вызывающий.
 */
function batchOf(runtime: Runtime, cellId: string): number | null {
  const queued = runtime.queue.find((item) => item.cellId === cellId)
  if (queued) return queued.batch
  if (runtime.currentCell === cellId) return runtime.currentBatch
  if (runtime.lastFinished?.cellId === cellId) return runtime.lastFinished.batch
  return null
}

/**
 * A cell failed, so the rest of the same Run All is not worth running.
 *
 * Thirty cells that each need the one before produce thirty tracebacks, and the
 * only one worth reading is the first. Cells queued by anybody else stay: their
 * work is not what just broke.
 */
/**
 * Drop what was queued by the same press of Run as the cell now running.
 *
 * Everything else in the queue belongs to somebody else's press and is none of
 * this interrupt's business.
 */
function stopBatchOf(runtime: Runtime, cellId: string): void {
  const mine = runtime.queue.find((item) => item.cellId === cellId)
  const batch = mine?.batch ?? runtime.currentBatch
  if (batch === null || batch === undefined) return
  const dropped = runtime.queue.filter((item) => item.batch === batch)
  if (dropped.length === 0) return
  runtime.queue = runtime.queue.filter((item) => item.batch !== batch)

  const { doc } = getSessionDoc(runtime.sessionId)
  doc.transact(() => {
    for (const item of dropped) {
      const found = findCell(doc, item.cellId)
      if (!found) continue
      found.cell.set('state', 'idle' as CellState)
      found.cell.set('runBy', null)
      found.cell.set('runById', null)
    }
  }, ORIGIN)
  releaseCouncil(runtime, dropped)
  syncQueue(runtime)
  // Said out loud, because a queue that empties without a word reads as a
  // product that ignored the button.
  kernelNote(
    runtime.sessionId,
    dropped.length === 1
      ? tr("server.theInterruptAlsoDroppedTheOneCell.612a37")
      : tr("server.theInterruptAlsoDroppedTheCellsQueued.cfbaff", { p0: dropped.length }),
  )
}

function stopBatch(runtime: Runtime, failedItem: QueueItem): void {
  const dropped = runtime.queue.filter((item) => item.batch === failedItem.batch)
  if (dropped.length === 0) return
  runtime.queue = runtime.queue.filter((item) => item.batch !== failedItem.batch)

  const { doc } = getSessionDoc(runtime.sessionId)
  doc.transact(() => {
    for (const item of dropped) {
      const found = findCell(doc, item.cellId)
      if (!found) continue
      found.cell.set('state', 'idle' as CellState)
      found.cell.set('runBy', null)
      found.cell.set('runById', null)
    }
  }, ORIGIN)
  releaseCouncil(runtime, dropped)
  syncQueue(runtime)
  kernelNote(
    runtime.sessionId,
    dropped.length === 1
      ? tr("server.aCellFailedSoTheOneQueued.6d932d")
      : tr("server.aCellFailedSoTheCellsQueued.bbcda8", { p0: dropped.length }),
  )
}

async function pump(runtime: Runtime): Promise<void> {
  if (runtime.pumping) return
  runtime.pumping = true
  try {
    while (runtime.queue.length > 0) {
      // A ban may interrupt one Council author while another waits behind
      // them. The HTTP interrupt can arrive after the first run ends; starting
      // the next job before it settles would deliver that SIGINT to the wrong
      // author. Keep the queue intact and wait only at this boundary.
      if (runtime.beforeNext) await runtime.beforeNext
      // Перезапуск идёт — ждать его, а не слать execute в ядро, которого через
      // мгновение не будет. Ответ на такой execute не приходит никогда.
      if (runtime.restarting) {
        await runtime.restarting.catch(() => {})
        // Перезапуск сбрасывает очередь; всё, что осталось, пришло после него.
        if (runtime.queue.length === 0) break
      }
      try {
        await ensureKernel(runtime.sessionId)
      } catch (err) {
        reportDeadKernel(runtime, errText(err))
        return
      }
      const item = runtime.queue.shift()
      if (!item) break
      if (item.council) await runCouncilOne(runtime, item, item.council)
      else await runOne(runtime, item)
      if (runtime.kernel && runtime.kernel.phase === 'dead') {
        dropQueue(runtime)
        return
      }
      if (failed(runtime, item.cellId)) stopBatch(runtime, item)
    }
  } catch (err) {
    // The queue must not die silently with cells stuck on "running".
    console.error(`[kernel] run queue failed for ${runtime.sessionId}:`, errText(err))
    reportDeadKernel(runtime, errText(err))
  } finally {
    runtime.pumping = false
    runtime.currentCell = null
    runtime.currentBatch = null
    runtime.currentRunById = null
    syncQueue(runtime)
    const phase = runtime.kernel?.phase ?? 'dead'
    setStatus(runtime, phase === 'busy' ? 'idle' : (phase as KernelStatus))
  }
}

async function runOne(runtime: Runtime, item: QueueItem): Promise<void> {
  const { doc } = getSessionDoc(runtime.sessionId)
  const found = findCell(doc, item.cellId)
  // Someone deleted the cell while it sat in the queue.
  if (!found || cellType(found.cell) !== 'code') {
    finishExecution(runtime, item, 'cancelled')
    return
  }

  const cell = found.cell
  runtime.activityItem = item
  const source = cellSource(cell).toString()
  /*
   * Потолок картинок — по числу тех, кому они поедут.
   *
   * Вывод ячейки уходит в общий документ, то есть КАЖДОМУ открытому сокету
   * комнаты, каждому в своей копии и со своим deflate. Шесть мегабайт `imshow`
   * на семинаре из тридцати — это сто восемьдесят мегабайт и никого не трогает;
   * те же шесть на потоке из пятисот — это гигабайт исходящего, за которым у
   * всех встаёт очередь из собственного набора текста. См. dataBudgetFor.
   */
  const writer = new OutputWriter(
    doc,
    item.cellId,
    dataBudgetFor(onlineCount(runtime.sessionId)),
    // Комната — чтобы крупные картинки легли рядом с ней, а не в документ.
    runtime.sessionId,
  )
  runtime.currentCell = item.cellId
  runtime.currentBatch = item.batch
  runtime.currentRunById = item.runById
  // Писатель переживёт этот вызов, а значит и документ, который он взял:
  // пока он пишет, комнату из памяти не выселяют. Отпустит `dropWriter`.
  dropWriter(runtime)
  runtime.writer = writer
  runtime.writerHold = holdRoom(runtime.sessionId)
  // Одно и то же число в двух местах: в документ — чтобы росли часы у всех, в
  // среду исполнения — чтобы длительность считалась по нашей записи.
  const startedAt = Date.now()
  runtime.started = { cellId: item.cellId, at: startedAt }
  executionActivity(runtime, item, 'execution.started')
  syncQueue(runtime)
  setStatus(runtime, 'busy')

  doc.transact(() => {
    cell.set('state', 'running' as CellState)
    cell.set('runBy', item.runBy)
    cell.set('runById', item.runById)
    cell.set('execCount', null)
    /*
     * Одно число в транзакции, которая и так происходит.
     *
     * Живой секундомер на ячейке — это ровно эта отметка плюс счёт в браузере.
     * Писать сюда каждую секунду было бы проще на вид и разрушительно на деле:
     * поле, меняющееся чаще раза в двенадцать секунд, навсегда держит открытым
     * всплеск истории (и приписывает комнате всё, что за это время напечатали
     * люди), и заставляет запись на диск кодировать снимок каждые несколько
     * секунд в пустой комнате. Здесь же — ноль лишних обновлений Yjs, ноль
     * лишних рассылок и ноль лишних всплесков.
     *
     * `ranMs` гасится вместе с `execCount` и по той же причине: время прошлого
     * выполнения перестаёт быть правдой в тот момент, когда началось это.
     */
    cell.set('startedAt', startedAt)
    cell.set('ranMs', null)
    /*
     * Прошлый вывод стирается здесь же, в этой самой транзакции.
     *
     * Стирается по-прежнему на старте, а не в очереди: пока ячейка не пошла,
     * прошлый результат — всё ещё правда на экране. Изменилось одно: раньше
     * это была отдельная транзакция строкой ниже, и клиент получал два
     * события. На первом просыпался наблюдатель полей — `execCount` уходил в
     * null, и пропадала строка `Out [n]`, это двадцать четыре пикселя. На
     * втором просыпался наблюдатель вывода, и пропадало тело. Между этими
     * двумя кадрами область успевала обмериться на те же двадцать четыре
     * пикселя короче — то есть место под новый вывод резервировалось неверным,
     * — и комната видела лишний скачок.
     *
     * Одна транзакция — одно обновление на проводе, один вызов record() и один
     * обход shapeOf на запуск. На Run All из сорока ячеек в комнате из
     * двадцати это сорок обновлений и восемьсот кадров, которых больше нет.
     */
    writer.clear()
  }, ORIGIN)

  if (source.trim().length === 0) {
    runtime.currentCell = null
    runtime.currentBatch = null
    runtime.currentRunById = null
    runtime.lastFinished = { cellId: item.cellId, batch: item.batch }
    dropWriter(runtime)
    setCellState(runtime.sessionId, item.cellId, 'ok')
    finishExecution(runtime, item, 'completed', Math.max(0, Date.now() - startedAt))
    return
  }

  /*
   * Всё набранное — на диск, прежде чем ячейка пойдёт это читать.
   *
   * `%run solve.py`, `open('data.csv')`, `import helpers` читают файл, а не
   * документ, а документ доезжает до диска с задержкой: редактор — через
   * 700 мс после последнего нажатия, тетради — через полторы секунды. Ячейка,
   * запущенная сразу после правки, читала прошлую версию файла и падала на
   * строке, которую только что исправили при всех, — и объяснить это было
   * нечем.
   */
  flushToDisk(runtime.sessionId)

  const unwatch = stopIfDeleted(runtime, doc, item.cellId)
  let state: CellState = 'idle'
  try {
    /*
     * A kernel can die between two cells without anything saying so — Jupyter
     * leaves the socket open when it goes, so the first this server hears of it
     * is the check inside execute(). One retry turns that into a fresh kernel
     * and a cell that runs, rather than an error nobody can act on and a Run
     * that works the second time for no visible reason. The room is told what
     * happened by the phase change either way, so nothing is being hidden.
     */
    const status = await runOnKernel(runtime, source, {
      onExecuteInput: (execCount) => {
        const target = findCell(doc, item.cellId)
        if (target) doc.transact(() => target.cell.set('execCount', execCount), ORIGIN)
      },
      onStream: (name, text) => writer.stream(name, text),
      onData: (mimebundle, execCount) => writer.data(mimebundle, execCount),
      onError: (ename, evalue, traceback) => writer.error(ename, evalue, traceback),
      // wait=True — обещание заменить, wait=False — стереть сейчас. См. OutputWriter.
      onClear: (wait) => (wait ? writer.supersede() : writer.clear()),
      /*
       * input() blocks the kernel until a person types something, so the ask
       * goes into the shared document rather than to whoever pressed Run: in a
       * seminar the person who can answer is often not the person who started
       * the cell, and a room staring at a cell that never finishes has no way
       * to find out why.
       */
      onInputRequest: (prompt, password) => {
        const target = findCell(doc, item.cellId)
        if (target) {
          doc.transact(() => target.cell.set('stdin', { prompt, password }), ORIGIN)
        }
      },
    })
    state = status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'idle'
    if (status === 'abort') {
      const phase = runtime.kernel?.phase
      if (phase === 'dead') {
        writer.error('KernelDied', deadMessage(), [])
        state = 'error'
      } else if (phase === 'restarting' && runtime.kernel?.phaseExpected === false) {
        /*
         * Ядро перезапустил не человек, а сам Jupyter: процесс убили — почти
         * всегда за память, — и убила его эта ячейка. Фаза в этот момент
         * `restarting`, а не `dead`, поэтому раньше сюда не попадали вовсе:
         * ячейка садилась в `idle` с номером «Out [7]», на экране неотличимая
         * от успешной, а связь с NameError в следующей никто уже не видел.
         */
        writer.error('KernelDied', killedMessage(), [])
        state = 'error'
      }
    }
  } catch (err) {
    writer.error('KernelError', errText(err), [])
    state = 'error'
  } finally {
    unwatch()
    dropWriter(runtime)
    runtime.currentCell = null
    runtime.currentBatch = null
    /*
     * И хозяин запуска — здесь же, вместе с ячейкой.
     *
     * Раньше `currentRunById` держался до опустошения очереди (`finally` у
     * насоса), а между двумя ячейками насос успевает сходить в `ensureKernel`:
     * умершее ядро — это до полутора минут. Всё это время `requestRun` считал
     * прежнему автору лишнюю «выполняющуюся» ячейку и при правиле «по одной»
     * отказывал ему в новом Run, хотя у него ничего не выполнялось.
     */
    runtime.currentRunById = null
    // Чья это была пачка — помним ещё круг: «стоп» по этой ячейке может
    // доехать уже после того, как ядро взяло следующую.
    runtime.lastFinished = { cellId: item.cellId, batch: item.batch }
    // The prompt belongs to a running cell. Whatever ended the run — an answer,
    // an interrupt, a dead kernel — it must not be left on screen asking.
    const target = findCell(doc, item.cellId)
    if (target?.cell.get('stdin')) {
      doc.transact(() => target.cell.set('stdin', null), ORIGIN)
    }
  }

  setCellState(runtime.sessionId, item.cellId, state)
  finishExecution(runtime, item, state === 'ok' ? 'completed' : state === 'error' ? 'error' : 'cancelled',
    Math.max(0, Date.now() - startedAt))
  syncQueue(runtime)
  // The cell may have written a CSV; the Files panel should not need a refresh.
  notifyWorkspaceChanged(runtime.sessionId)
}

/* --------------------------------------------------------- консилиум */

/** Не чаще этого кадр вывода попытки едет хосту и автору, пока она считается. */
const COUNCIL_REPORT_MS = 400

/**
 * Попытка консилиума работает с личными копиями данных, а после неё ядро
 * возвращается в точности к тому, что было.
 *
 * Ядро в комнате одно — это устройство продукта, а не недосмотр: попытка
 * должна видеть `df`, `np` и всё, что преподаватель подготовил в общей ячейке.
 * А вот в обратную сторону это была дыра, и притом молчаливая. Сначала по
 * именам: `secret = 42` в попытке одного студента отвечал на `print(secret)` в
 * попытке следующего. Потом, на живом семинаре 19.09, — по данным: в задании
 * стояла строка `# data = data.dropna()`, один человек её раскомментировал, и
 * `data` стал другим у ВСЕХ, включая тех, кто уже сдал.
 *
 * Прежняя уборка (снимок имён до, снятие новых после) закрывала только первую
 * половину и по устройству не могла закрыть вторую: перепривязка меняет имя,
 * которое БЫЛО, а мутация на месте не меняет имён вовсе.
 *
 * Поэтому вокруг попытки теперь два других молчаливых запроса
 * (council-isolation.ts): вход подменяет привязки личными копиями и
 * отчитывается через `user_expressions`, выход возвращает каждую привязку,
 * снимает новые имена, откатывает cwd и rcParams. Изоляции пространства имён
 * (`exec` в свежем словаре) по-прежнему нет: она ломает и эхо последнего
 * выражения, и магии, и номера строк в трейсбеке — то есть всё, чем попытка
 * похожа на ячейку.
 *
 * Что остаётся общим — и о чём сказано вслух (COUNCIL_SHARED_KERNEL_NOTE,
 * README, docs/pages · council.html):
 *   · файлы на диске: `df.to_csv('out.csv')` пишет в общий каталог комнаты;
 *   · объекты вне списка копируемых типов — тензор torch, открытый файл,
 *     генератор, соединение с базой (council-isolation.ts · _plan);
 *   · объекты сверх бюджета `COUNCIL_COPY_MB` — эти названы в выводе попытки;
 *   · состояние модулей: `np.random.seed`, `pd.set_option`, `sys.path`,
 *     `warnings.filterwarnings`, счётчик выполнения ядра;
 *   · GPU: память карты и её контексты у комнаты одни.
 */
const COUNCIL_ENTER_SOURCE = councilEnterSource(config.councilCopyBytes)

/** Обработчики для служебного запроса, у которого нет ни вывода, ни зрителей. */
const SILENT_HANDLERS: Parameters<JupyterKernel['execute']>[1] = {
  onExecuteInput: () => {},
  onStream: () => {},
  onData: () => {},
  onError: () => {},
  onClear: () => {},
}

/** Молча посчитать служебную строку в ядре комнаты; неудача — не беда попытки. */
async function quietly(runtime: Runtime, source: string): Promise<void> {
  try {
    await runtime.kernel?.execute(source, SILENT_HANDLERS, { silent: true, storeHistory: false })
  } catch {
    /* ядро уже не отвечает — попытке об этом скажет её собственный запуск */
  }
}

/**
 * Приготовить попытке личные копии данных — и дождаться подтверждения.
 *
 * Подтверждение обязательно, и это главное свойство: `null` отсюда означает
 * «неизвестно, подменены ли привязки», а на общих объектах попытка не
 * запускается никогда. Отчёт едет `user_expressions` — при `silent: true` в
 * IOPUB не приходит ничего, и услышать вход иначе было бы нечем.
 *
 * `runOnKernel`, а не `quietly`: ядро, умершее между двумя попытками, здесь
 * поднимается заново — и попытка считается в свежем, пустом ядре, как считалась
 * бы и раньше, а не отказывается из-за того, что копировать оказалось нечего.
 */
async function enterCouncilIsolation(
  runtime: Runtime,
): Promise<{ report: CouncilIsolationReport | null; reason: string | null }> {
  let raw: unknown = null
  let reason: string | null = null
  try {
    const status = await runOnKernel(
      runtime,
      COUNCIL_ENTER_SOURCE,
      {
        ...SILENT_HANDLERS,
        onError: (ename, evalue) => {
          // Вход ловит свои ошибки сам и отчитывается ими; сюда доходит только
          // то, что его пережило, — прерывание пределом, смерть ядра. У
          // KeyboardInterrupt текста нет вовсе, и двоеточие после имени
          // повисало бы в строке отказа ни на чём.
          reason = evalue.trim().length > 0 ? `${ename}: ${evalue.trim()}` : ename
        },
        onUserExpressions: (values) => {
          raw = values[COUNCIL_REPORT_KEY]
        },
      },
      {
        silent: true,
        storeHistory: false,
        userExpressions: { [COUNCIL_REPORT_KEY]: COUNCIL_REPORT_EXPR },
      },
    )
    if (status !== 'ok' && reason === null) reason = tr("server.theAttemptWasInterrupted.4f4edf")
  } catch (err) {
    reason = errText(err)
  }
  const report = parseCouncilReport(raw)
  return { report, reason: report?.error ?? reason }
}

/** Первый кадр запуска: он же заявка, и текст под ним — тот, что в задании. */
const queuedRun = (job: CouncilJob): CouncilRun => ({
  state: 'queued',
  outputs: [],
  execCount: null,
  ranMs: null,
  startedAt: Date.now(),
  by: job.by,
})

/**
 * Поставить попытку консилиума в очередь ядра.
 *
 * Одна и та же попытка — одна запись: второе нажатие по ТОМУ ЖЕ тексту, пока
 * первая ждёт или считается, ничего не ставит и возвращает её место, чтобы
 * отказ мог сказать «вы 37-й». `position` — номер в очереди, считая ту, что
 * выполняется; `0` — выполняется сейчас. `runById` — кто нажал: преподаватель,
 * запускающий чужую попытку, остаётся хозяином запуска (прервать, ответить на
 * input) — как и у ячейки.
 *
 * Другой текст — не второе нажатие, а другой запуск.
 *
 * Очередь на потоке одна, ждать минуту — обычное дело, и правка за это время
 * тоже обычна. Прежде ждущая запись была неприкасаемой: студент, поправивший
 * лист, получал «эта попытка уже в очереди — 37-я» и не мог перезапустить
 * НОВУЮ версию, пока ядро не досчитает старую — а её вывод к тому времени всё
 * равно выбрасывался как опоздавший (council.ts · recordRun). Поэтому запись
 * подменяется на месте: место в очереди остаётся прежним (за опечатку не
 * наказывают), а считаться будет то, что человек видит на экране.
 *
 * Уже считающуюся подменить нечем: строка ушла в ядро. Ей по-прежнему отвечают
 * «уже считается», и это честно — прервать её можно кнопкой, а её вывод под
 * новый текст всё равно не ляжет.
 */
export function requestCouncilRun(
  sessionId: string,
  job: CouncilJob,
  runBy: string,
  runById: string,
): { queued: boolean; position: number } {
  const runtime = getRuntime(sessionId)
  sweepOrphanRuns(sessionId)
  const already = councilQueuePosition(sessionId, job.cellId, job.participantId)
  if (already !== null) {
    const id = councilQueueId(job.cellId, job.participantId)
    const index = runtime.queue.findIndex((item) => item.cellId === id)
    const waiting = index < 0 ? null : runtime.queue[index]
    if (!waiting || waiting.council?.source === job.source) {
      return { queued: false, position: already }
    }
    // Кадр «в очереди» уходит по НОВОМУ заданию: он же переставляет отпечаток
    // текста, по которому recordRun решает, чей вывод считать своим.
    finishExecution(runtime, waiting, 'cancelled')
    const replacement: QueueItem = { ...waiting, runBy, runById, council: job, activityFinished: false, activityCancelled: false, activitySeq: null }
    replacement.activitySeq = executionActivity(runtime, replacement, 'execution.queued', { count: 1 })
    runtime.queue[index] = replacement
    tellJob(job, queuedRun(job))
    return { queued: true, position: already }
  }
  const item: QueueItem = {
    cellId: councilQueueId(job.cellId, job.participantId),
    runBy,
    runById,
    batch: ++batchCounter,
    council: job,
  }
  item.activitySeq = executionActivity(runtime, item, 'execution.queued', { count: 1 })
  runtime.queue.push(item)
  const position = councilQueuePosition(sessionId, job.cellId, job.participantId) ?? 1
  tellJob(job, queuedRun(job))
  syncQueue(runtime)
  void pump(runtime)
  return { queued: true, position }
}

/**
 * Снять ждущую попытку с очереди — её больше некому считать.
 *
 * Два повода, и оба про то, что работа стала бессмысленной ещё до начала:
 * автор сменил текст (control.ts · council:draft) и человека забанили
 * (control.ts · purgeCouncilOf). Ядро на потоке одно, очередь к нему общая, и
 * минута, потраченная на код, которого уже нет, — это минута, которую ждёт
 * весь остальной класс.
 *
 * `null` в `tellJob` понимается как «запуска не было»: council.ts стирает и
 * запуск с карточки, и отпечаток текста. Возвращает, сняли ли: `false` — либо
 * попытка уже считается (строка ушла в ядро, отсюда её не достать), либо её в
 * очереди и не было.
 */
export function cancelCouncilRun(
  sessionId: string,
  cellId: string,
  participantId: string,
): boolean {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return false
  const id = councilQueueId(cellId, participantId)
  if (runtime.currentCell === id) return false
  const index = runtime.queue.findIndex((item) => item.cellId === id)
  if (index < 0) return false
  const [dropped] = runtime.queue.splice(index, 1)
  releaseCouncil(runtime, [dropped])
  syncQueue(runtime)
  return true
}

/**
 * Убрать из ядра все попытки человека, которого удаляют с занятия.
 *
 * Обычная отмена намеренно не трогает выполняющуюся попытку. Для бана это
 * оставляло бесконечный цикл занимать общее ядро уже после того, как автора и
 * его работу убрали из комнаты. Здесь текущая работа проверяется по серверной
 * записи задания. Следующую чужую попытку очередь не начинает до ответа на
 * interrupt: иначе поздний SIGINT мог попасть уже в неё.
 */
export function purgeCouncilRunsOf(
  sessionId: string,
  participantId: string,
): { running: boolean; queued: number } {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return { running: false, queued: 0 }

  const dropped = runtime.queue.filter((item) => item.council?.participantId === participantId)
  if (dropped.length > 0) {
    const gone = new Set(dropped)
    runtime.queue = runtime.queue.filter((item) => !gone.has(item))
    releaseCouncil(runtime, dropped)
    syncQueue(runtime)
  }

  const active = runtime.job
  const running = active?.job.participantId === participantId
  if (running) stopRunningJob(runtime, active)
  return { running, queued: dropped.length }
}

/**
 * Прервать ИМЕННО эту попытку — и не дать SIGINT догнать следующую.
 *
 * Два повода прервать попытку, которую никто не просил останавливать: автора
 * забанили и запуск перебрал предел регламента. Граница у них одна, потому что
 * опасность одна: `interrupt` уходит в Jupyter по HTTP и отвечает не мгновенно,
 * а очередь за это время успевает взять следующую работу — и сигнал, посланный
 * Пете, останавливал Машу. Поэтому обещание кладётся в `beforeNext`: насос
 * ждёт на нём ровно на границе между работами, ничего не выбрасывая из очереди.
 * Прошлый барьер не теряется — два бана подряд дают два сигнала, и ждать надо
 * обоих.
 *
 * `interruptSession` с именем записи очереди, а не без него: без имени он
 * разбирает очередь ВСЕЙ комнаты (там ветка комнатной кнопки Interrupt), а
 * пачка у попытки своя и единственная — `stopBatchOf` по ней не найдёт ничего
 * чужого.
 */
function stopRunningJob(runtime: Runtime, active: ActiveJob): void {
  const interrupt = interruptSession(runtime.sessionId, active.item.cellId)
  const prior = runtime.beforeNext
  const barrier = prior ? Promise.all([prior, interrupt]).then(() => {}) : interrupt
  runtime.beforeNext = barrier
  void barrier.then(() => {
    if (runtime.beforeNext === barrier) runtime.beforeNext = null
  })
}

/**
 * Где попытка в очереди: `0` — считается сейчас, `null` — её там нет.
 * Считает и ячейки перед ней: очередь одна, и ждать студенту придётся их всех.
 */
export function councilQueuePosition(
  sessionId: string,
  cellId: string,
  participantId: string,
): number | null {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return null
  const id = councilQueueId(cellId, participantId)
  if (runtime.currentCell === id) return 0
  const index = runtime.queue.findIndex((item) => item.cellId === id)
  if (index < 0) return null
  return index + 1 + (runtime.currentCell ? 1 : 0)
}

/**
 * Все ждущие попытки с их номерами — одним проходом по очереди.
 *
 * То же, что `councilQueuePosition` для каждого ждущего, только без поиска по
 * очереди на каждого: сдвиг очереди при пятистах попытках стоил четверти
 * миллиона сравнений на ровном месте. Номер считается так же — вместе с той,
 * что считается сейчас. Нуля здесь не бывает: считающаяся попытка уже не ждёт.
 */
export function councilQueuePositions(
  sessionId: string,
): { cellId: string; participantId: string; position: number }[] {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return []
  const ahead = runtime.currentCell ? 1 : 0
  const out: { cellId: string; participantId: string; position: number }[] = []
  runtime.queue.forEach((item, index) => {
    if (!item.council) return
    out.push({
      cellId: item.council.cellId,
      participantId: item.council.participantId,
      position: index + 1 + ahead,
    })
  })
  return out
}

/** Чьи попытки ждут в очереди — чтобы после каждого сдвига сказать им новый номер. */
export function councilQueued(sessionId: string): { cellId: string; participantId: string }[] {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return []
  const out: { cellId: string; participantId: string }[] = []
  for (const item of runtime.queue) {
    if (item.council)
      out.push({ cellId: item.council.cellId, participantId: item.council.participantId })
  }
  return out
}

/** Кадр вывода — не на каждую строку print, а раз в окно: стопка едет хосту целиком. */
function touchJob(runtime: Runtime, active: ActiveJob): void {
  if (active.timer) return
  active.timer = setTimeout(() => {
    active.timer = null
    if (runtime.job !== active) return
    tellJob(active.job, { ...active.run, outputs: active.buffer.snapshot() })
  }, COUNCIL_REPORT_MS)
  active.timer.unref?.()
}

/** Когда эта попытка началась по часам сервера — с поправкой на `restamp`. */
function startOfJob(runtime: Runtime, active: ActiveJob): number {
  // По записи среды, а не по своей: `restamp` переставляет начало, когда ядро
  // пришлось поднимать заново, и полторы минуты его подъёма — не время попытки.
  return runtime.started?.cellId === active.item.cellId
    ? runtime.started.at
    : active.run.startedAt
}

/**
 * Завести будильник предела на идущую попытку — или снять его.
 *
 * Считается от НАЧАЛА запуска, а не от «сейчас»: иначе преподаватель, дважды
 * тронувший регламент за минуту, продлевал бы зависшему циклу жизнь каждым
 * нажатием. Отсюда же и «опустили предел ниже уже прошедшего» — остаток
 * отрицательный, ноль в `setTimeout`, сигнал на следующем такте.
 */
function armLimit(runtime: Runtime, active: ActiveJob): void {
  if (active.limitTimer) {
    clearTimeout(active.limitTimer)
    active.limitTimer = null
  }
  const limit = active.limitSec
  if (limit === null) return
  const left = startOfJob(runtime, active) + limit * limitTickMs - Date.now()
  active.limitTimer = setTimeout(() => {
    active.limitTimer = null
    fireLimit(runtime, active)
  }, Math.max(0, left))
  active.limitTimer.unref?.()
}

/**
 * Предел сработал: остановить запуск и запомнить, какой именно предел это был.
 *
 * Ядро НЕ перезапускается, даже если SIGINT не помог. Питон, ушедший в C
 * (`np.linalg.inv` на матрице не того размера), сигнала не увидит до возврата
 * в интерпретатор — но ядро в комнате одно, и в нём лежит весь разбор
 * преподавателя: `df`, модель, полчаса подготовки. Снести это ради одной
 * попытки — цена выше беды. Поэтому попытка остаётся «считается», а у
 * преподавателя по-прежнему есть «Прервать» и «Перезапустить».
 *
 * И потому же сигналов не больше двух: один сразу и один через пять «секунд»
 * предела — на случай, когда первый пришёл ровно в чужой `except
 * KeyboardInterrupt`. Дальше молча: SIGINT в тугом цикле раз в секунду — это
 * шторм HTTP-запросов к Jupyter до конца пары, а помочь он не может.
 */
function fireLimit(runtime: Runtime, active: ActiveJob): void {
  // Попытка успела кончиться сама ровно в этот миг — трогать нечего: очередь
  // уже могла взять следующую работу, и сигнал попал бы в неё.
  if (runtime.job !== active) return
  // И семинар, закрытый за эти миллисекунды, не будит `getRuntime` внутри
  // `interruptSession`: тот заводит среду заново, а с ней и документ комнаты,
  // которой больше нет (та же осторожность, что у `retired` в `shutdownSession`).
  if (runtime.retired || runtimes.get(runtime.sessionId) !== runtime) return
  if (active.limitSec !== null) active.timedOut = active.limitSec
  active.interrupts += 1
  stopRunningJob(runtime, active)
  if (active.interrupts >= 2) return
  active.limitTimer = setTimeout(() => {
    active.limitTimer = null
    fireLimit(runtime, active)
  }, LIMIT_RETRY_TICKS * limitTickMs)
  active.limitTimer.unref?.()
}

/**
 * Регламент поменяли, пока попытка этой ячейки считается, — предел действует
 * сразу, с отсчётом от её начала.
 *
 * Зовётся из control.ts на `cell:lock`: «правила действуют сразу» — обещание
 * всей комнаты (shared/rules.ts), и предел запуска не может быть исключением
 * из него, иначе зависший цикл доживает до конца пары под новым регламентом,
 * который его как раз и запрещает.
 */
export function retimeCouncilRun(sessionId: string, cellId: string, limitSec: number | null): void {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return
  /*
   * Сначала те, кто ждёт: предел записан в саму работу при постановке в очередь
   * (ядро документа не читает), и без этой строки «действует сразу» было бы
   * правдой ровно для одной попытки. На потоке очередь — десятки работ: снял
   * преподаватель «без предела», а сорок уже стоящих запусков так и пошли бы
   * без него, по одному, до конца пары. Запись в очереди заменяется целиком, а
   * не правится на месте: `job` у неё — тот же объект, что держит слушатель в
   * control.ts, и чужое поле под ним менять незачем.
   */
  for (const item of runtime.queue) {
    if (item.council?.cellId === cellId && item.council.limitSec !== limitSec) {
      item.council = { ...item.council, limitSec }
    }
  }
  const active = runtime.job
  if (!active || active.job.cellId !== cellId) return
  if (active.limitSec === limitSec) return
  active.limitSec = limitSec
  // Сигнал уже посылали — второй раз по новому пределу не шлём: остановка одна,
  // и её число (`timedOut`) уже названо.
  if (active.timedOut !== null) return
  armLimit(runtime, active)
}

/**
 * Единственная дверь из «считается» для попытки — как `setCellState` у ячейки.
 * Сюда приходят обычный конец, бросок из execute и `reportDeadKernel`.
 */
function finishCouncil(runtime: Runtime, active: ActiveJob, state: 'ok' | 'error'): void {
  if (active.timer) {
    clearTimeout(active.timer)
    active.timer = null
  }
  /*
   * Будильник предела гасится ЗДЕСЬ, на единственном выходе, и потому гасится
   * на всех: обычный конец, падение, прерывание, смерть ядра, снос ячейки.
   * Переживи он попытку хоть на миг — сигнал ушёл бы в следующую работу
   * очереди, то есть в чужую попытку или в ячейку преподавателя.
   */
  if (active.limitTimer) {
    clearTimeout(active.limitTimer)
    active.limitTimer = null
  }
  const startedAt = startOfJob(runtime, active)
  /*
   * Отметка «остановлено по пределу» ставится только на упавший запуск.
   *
   * Сигнал и последняя строка кода могут совпасть в одну миллисекунду: ядро
   * успело ответить `ok`, значит попытка досчиталась сама и ничего у неё не
   * отняли. Назвать такой запуск остановленным — соврать на карточке и в
   * списке работ, а стоит это дороже, чем пропущенная секунда предела.
   */
  const limitFired = state === 'error' ? active.timedOut : null
  if (limitFired !== null) {
    active.buffer.stopped(
      tr("server.stoppedTheRunTookLongerThanThe.87bfc0", { p0: durationWords(limitFired) }),
    )
  }
  active.run = {
    ...active.run,
    state,
    outputs: active.buffer.snapshot(),
    ranMs: Math.max(0, Date.now() - startedAt),
    ...(limitFired !== null ? { timedOut: limitFired } : {}),
  }
  finishExecution(runtime, active.item, state === 'ok' ? 'completed' : 'error', active.run.ranMs ?? 0)
  if (runtime.started?.cellId === active.item.cellId) runtime.started = null
  runtime.job = null
  runtime.currentCell = null
  runtime.currentBatch = null
  runtime.currentRunById = null
  runtime.lastFinished = { cellId: active.item.cellId, batch: active.item.batch }
  tellJob(active.job, active.run)
  syncQueue(runtime)
}

/**
 * Посчитать попытку — тем же ядром и теми же обработчиками, что ячейку, но с
 * выводом в буфер. Отличия от `runOne` названы по месту; всё остальное —
 * нарочно то же самое, чтобы попытка вела себя как ячейка, которую нажали.
 */
async function runCouncilOne(runtime: Runtime, item: QueueItem, job: CouncilJob): Promise<void> {
  const { doc } = getSessionDoc(runtime.sessionId)
  const startedAt = Date.now()
  const active: ActiveJob = {
    item,
    job,
    buffer: new CouncilOutputBuffer(),
    run: { state: 'running', outputs: [], execCount: null, ranMs: null, startedAt, by: job.by },
    timer: null,
    limitSec: job.limitSec,
    limitTimer: null,
    timedOut: null,
    interrupts: 0,
  }
  runtime.currentCell = item.cellId
  runtime.currentBatch = item.batch
  runtime.currentRunById = item.runById
  runtime.started = { cellId: item.cellId, at: startedAt }
  runtime.job = active
  runtime.activityItem = item
  executionActivity(runtime, item, 'execution.started')
  syncQueue(runtime)
  setStatus(runtime, 'busy')
  tellJob(job, { ...active.run })

  if (job.source.trim().length === 0) {
    finishCouncil(runtime, active, 'ok')
    return
  }

  flushToDisk(runtime.sessionId)
  const unwatch = stopIfDeleted(runtime, doc, item.cellId, job.cellId)
  /*
   * Будильник заводится ДО первой строки, ушедшей в ядро, и после проверки на
   * пустую попытку: пустую считать нечего, а всё остальное — уже время,
   * которое очередь стоит. Личные копии данных (вход ниже) идут в счёт предела
   * намеренно: они тоже занимают общее ядро.
   */
  armLimit(runtime, active)
  const { buffer } = active
  let state: 'ok' | 'error' = 'ok'
  // Личные копии данных попытки. См. COUNCIL_ENTER_SOURCE.
  const { report, reason } = await enterCouncilIsolation(runtime)
  try {
    if (!report?.ok) {
      /*
       * Вход не подтвердился — попытка НЕ запускается.
       *
       * Молчание входа означает «неизвестно, чьи сейчас данные в ядре», и
       * запуск на общих объектах ровно здесь и стоил бы пары: студент получил
       * бы правильный на вид ответ, испортив данные всей группе. Одна строка
       * без трейсбека: кадры `<colloq-council>` — не его код и ничего ему не
       * скажут.
       */
      // Имя исключения пустое по той же причине, что у остановки пределом
      // (council.ts · stopped): карточка рисует «имя: текст», и английское
      // слово перед русской фразой ничего не добавляет.
      buffer.error('', councilEnterRefusal(reason), [])
      state = 'error'
      return
    }
    // Что осталось общим — в начало вывода, до первой строки самой попытки.
    for (const note of councilSkipNotes(report)) buffer.stream('stderr', note)
    /*
     * Без истории ядра — единственное отличие от ячейки в самом запросе.
     *
     * Ядро в комнате одно, и IPython кладёт исходник каждой выполненной ячейки
     * в `In`/`_ih`: попытки, которые преподаватель запускал, читал бы любой,
     * кому потом откроют ячейку «всем» (`print(In[-5:])`, `%history`). Вывод
     * попытки едет двоим честно, а её текст в памяти ядра лежал бы для всех —
     * вопреки правилу «чужих попыток студент не видит никогда».
     */
    const status = await runOnKernel(
      runtime,
      job.source,
      {
        onExecuteInput: (execCount) => {
          active.run.execCount = execCount
          touchJob(runtime, active)
        },
        onStream: (name, text) => {
          buffer.stream(name, text)
          touchJob(runtime, active)
        },
        onData: (mimebundle, execCount) => {
          buffer.data(mimebundle, execCount)
          touchJob(runtime, active)
        },
        onError: (ename, evalue, traceback) => {
          buffer.error(ename, evalue, traceback)
          touchJob(runtime, active)
        },
        onClear: (wait) => {
          if (wait) buffer.supersede()
          else buffer.clear()
          touchJob(runtime, active)
        },
        /*
         * `input()` в попытке некому показать: приглашение ячейки живёт в общем
         * документе, а у попытки документа нет, и зал её не видит. Ядро при этом
         * стоит, пока не ответят, — и стояло бы до конца пары. Отвечаем пустой
         * строкой сами и говорим об этом в выводе: `int('')` упадёт честно и
         * объяснимо, а очередь пойдёт дальше.
         */
        onInputRequest: () => {
          buffer.stream(
            'stderr',
            tr("server.colloqInputIsNotSupportedInCouncil.fd07fb"),
          )
          touchJob(runtime, active)
          void runtime.kernel?.answerInput('').catch(() => {})
        },
      },
      { storeHistory: false },
    )
    state = status === 'ok' ? 'ok' : 'error'
    if (status === 'abort' && !buffer.hasError) {
      const phase = runtime.kernel?.phase
      if (phase === 'dead') buffer.error('KernelDied', deadMessage(), [])
      else if (phase === 'restarting' && runtime.kernel?.phaseExpected === false) {
        buffer.error('KernelDied', killedMessage(), [])
      } else buffer.error('Interrupted', tr("server.theAttemptWasInterrupted.4f4edf"), [])
    }
  } catch (err) {
    buffer.error('KernelError', errText(err), [])
    state = 'error'
  } finally {
    unwatch()
    /*
     * Выход — ВСЕГДА, включая ту ветку, где попытку не запускали: вход мог
     * успеть подменить привязки и упасть после, и тогда единственное, что
     * вернёт комнате её данные, — вот эта строка.
     *
     * Конец попытки собран здесь же, за выходом, а не после `try`: ветка
     * «вход не подтвердился» выходит из блока раньше, и иначе карточка
     * осталась бы «считается» навсегда.
     */
    await quietly(runtime, COUNCIL_EXIT_SOURCE)
    finishCouncil(runtime, active, state)
    // Попытка могла записать файл — панели файлов это так же интересно.
    notifyWorkspaceChanged(runtime.sessionId)
  }
}

/** A kernel that will not come up is an output on the cell, never a crash. */
function reportDeadKernel(runtime: Runtime, message: string): void {
  if (runtime.activityItem && !runtime.job) {
    finishExecution(runtime, runtime.activityItem, 'error',
      Math.max(0, Date.now() - (runtime.started?.at ?? Date.now())))
  }
  /*
   * Попытка консилиума — тем же словом, но к попытке, а не в ячейку: у неё
   * нет ячейки, и OutputWriter ниже написал бы в пустоту, оставив карточку
   * «считается» навсегда.
   */
  if (runtime.job) {
    runtime.job.buffer.error('KernelError', message, [])
    finishCouncil(runtime, runtime.job, 'error')
    dropQueue(runtime)
    setStatus(runtime, 'dead')
    return
  }
  const head = runtime.queue[0]
  if (!runtime.currentCell && head?.council) {
    finishExecution(runtime, head, 'error')
    runtime.queue.shift()
    tellJob(head.council, {
      state: 'error',
      outputs: [{ kind: 'error', ename: 'KernelError', evalue: message, traceback: [] }],
      execCount: null,
      ranMs: null,
      startedAt: Date.now(),
      by: head.council.by,
    })
    dropQueue(runtime)
    setStatus(runtime, 'dead')
    return
  }
  const { doc } = getSessionDoc(runtime.sessionId)
  const stuck = runtime.currentCell ?? runtime.queue[0]?.cellId ?? null
  if (stuck) {
    const writer = runtime.writer ?? new OutputWriter(doc, stuck)
    writer.error('KernelError', message, [])
    // Свой, заведённый строкой выше, комнату не держит — его и отпускать
    // нечего; тот, что стоял в среде исполнения, отпускается здесь.
    writer.dispose()
    dropWriter(runtime)
    runtime.currentCell = null
    runtime.currentBatch = null
    runtime.currentRunById = null
    const waiting = runtime.queue[0]?.cellId === stuck
    if (waiting) finishExecution(runtime, runtime.queue[0], 'error')
    if (waiting) runtime.queue.shift()
    /*
     * Ячейка, которая только стояла в очереди, теряет номер вместе с ядром.
     *
     * Её прошлый результат остаётся — это единственное свидетельство того, что
     * она когда-то показывала, и стирать его незачем. А вот номер над ним
     * теперь врёт: под одним `Out [12] · 3.4 s` оказывается содержимое двух
     * разных выполнений, `hasError` красит всю ячейку как упавшую, и
     * `newestErrorIndex` в контексте оракула отдаёт модели таблицу двенадцатого
     * выполнения как обстоятельства падения, которое не принадлежит никакому.
     */
    if (waiting) {
      const found = findCell(doc, stuck)
      if (found) {
        doc.transact(() => {
          found.cell.set('execCount', null)
          found.cell.set('ranMs', null)
        }, ORIGIN)
      }
    }
    setCellState(runtime.sessionId, stuck, 'error')
  }
  dropQueue(runtime)
  setStatus(runtime, 'dead')
}

function deadMessage(): string {
  return tr("server.thePythonKernelStoppedRespondingRestartIt.09f400")
}

/**
 * Ячейку, которая считается прямо сейчас, удалили — остановить ядро.
 *
 * Удаление ничем не связано с выполнением: ячейка исчезает из документа, а
 * цикл в ядре крутится дальше, `meta.runningCell` называет id, которого больше
 * нет, и остановить это нечем — кнопка нарисована на ячейке, а ячейки нет.
 * Прерывание здесь — ровно то, что нажал бы человек, будь кнопке к чему
 * привязаться.
 *
 * Наблюдатель живёт только пока ячейка считается, и своих же записей не видит:
 * вывод и состояния идут под `ORIGIN`.
 */
function stopIfDeleted(
  runtime: Runtime,
  doc: Y.Doc,
  cellId: string,
  /*
   * За чем следить. У ячейки — она сама; у попытки консилиума запись очереди
   * синтетическая, а исчезнуть из документа может ячейка консилиума — и вместе
   * с ней смысл считать чью-то попытку к ней.
   */
  watched = cellId,
): () => void {
  let fired = false
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (fired || origin === ORIGIN) return
    if (runtime.currentCell !== cellId || findCell(doc, watched)) return
    fired = true
    if (runtime.activityItem) runtime.activityItem.activityCancelled = true
    kernelNote(
      runtime.sessionId,
      tr("server.theCellThatWasRunningWasDeleted.ec6ea8"),
    )
    void runtime.kernel?.interrupt().catch(() => {})
  }
  doc.on('update', onUpdate)
  return () => doc.off('update', onUpdate)
}

/**
 * Дописать на диск то, что комната набрала, но ещё не сохранила.
 *
 * Только по своей комнате: ячейка читает диск здесь, а чужие несохранённые
 * файлы уедут туда сами теми же семьюстами миллисекундами позже.
 */
function flushToDisk(sessionId: string): void {
  try {
    projectBooks(sessionId)
    flushSessionFiles(sessionId)
  } catch (err) {
    console.error(`[kernel] не удалось дописать файлы ${sessionId}:`, errText(err))
  }
}

/** Ядро вернулось само, а ячейка — нет: процесс, в котором она шла, убили. */
function killedMessage(): string {
  const known = churnReason()
  return known
    ? tr("server.theCellRunningAtTheTimeWas.11ac96", { p0: known })
    : tr("server.theKernelRestartedDuringExecutionThisCell.e72a65")
}

/* ------------------------------------------------------------------ outputs */

/**
 * Put the room's code in one shape.
 *
 * Waits for a kernel first: black runs in the seminar's own Python, so that the
 * formatting matches the version the room is actually using. Anything the
 * formatter refuses is left alone — see kernel/format.ts for why that is the
 * whole design rather than a fallback.
 */
export async function formatSession(sessionId: string, book?: string): Promise<FormatOutcome> {
  const runtime = getRuntime(sessionId)
  /*
   * Мимо очереди — но не в занятое ядро.
   *
   * Запрос форматирования идёт в ядро напрямую, минуя нашу очередь, а Jupyter
   * исполняет строго по порядку: пока считается ячейка, `execute` черноты
   * просто стоит за ней. Обычно это секунды и никого не касается. Но ячейка,
   * остановившаяся в `input()`, не кончится, пока кто-нибудь не ответит, — и
   * кнопка Format висит без единого слова до конца пары, а `stop_on_error`
   * соседней ячейки может ещё и оборвать запрос словами «The kernel could not
   * run the formatter», из которых не следует ничего.
   *
   * Поэтому отказ словами и сразу. Ждать своей очереди тут нечего: тетрадь всё
   * равно нельзя переписывать под ячейкой, которая её в этот момент выполняет.
   */
  const busyWith = formatBlocker(runtime)
  if (busyWith) return formatRefused(sessionId, busyWith)
  try {
    await ensureKernel(sessionId)
  } catch (err) {
    // Единственный отказ без своей строки в журнале: `ensureKernel` уже положил
    // туда `errText(err)` теми же словами, и повторять их второй раз всей
    // комнате незачем. Нажавшему они всё равно уедут ответом.
    return { changed: 0, skipped: 0, edited: 0, unchanged: 0, error: errText(err) }
  }
  const kernel = runtime.kernel
  if (!kernel) return formatRefused(sessionId, tr("server.theKernelIsNotRunning.2a9152"))
  // Ядро могло уйти в работу, пока оно поднималось: спрашиваем ещё раз, уже
  // зная и про `input()`.
  const nowBusy = formatBlocker(runtime)
  if (nowBusy) return formatRefused(sessionId, nowBusy)
  const outcome = await formatNotebook(sessionId, kernel, book)
  if (outcome.error) return formatRefused(sessionId, outcome.error)
  return outcome
}

/**
 * Отказ форматирования — одной дорогой для всех причин.
 *
 * Строка «Formatting failed: …» уходила в журнал ядра только из `formatNotebook`,
 * а ранние отказы (ждём `input()`, ядро занято, очередь) возвращались раньше
 * неё — то есть комната, у которой Format ничего не сделал, не видела причины
 * нигде, а комментарии рядом обещали обратное. Теперь причину пишет одно место:
 * нажавшему она едет ответом (control.ts · `t:'error'`), комнате — этой же
 * строкой в журнал. Считать тут нечего: `formatNotebook` при ошибке тоже
 * возвращает одни нули.
 */
function formatRefused(sessionId: string, error: string): FormatOutcome {
  kernelNote(sessionId, tr("server.formattingFailed.e1afc5", { p0: error }))
  return { changed: 0, skipped: 0, edited: 0, unchanged: 0, error }
}

/** Почему сейчас не время форматировать — теми словами, что уедут в журнал ядра. */
function formatBlocker(runtime: Runtime): string | null {
  if (runtime.kernel?.waitingForInput) {
    return tr("server.aCellIsWaitingForInputAnswer.370e11")
  }
  if (runtime.currentCell) {
    return tr("server.theKernelIsBusyRunningACell.9452d9")
  }
  if (runtime.queue.length > 0) {
    return tr("server.cellsAreQueuedToRunPressFormat.204e75")
  }
  return null
}

/**
 * Answer a cell that is blocked inside input().
 *
 * Anyone in the room may answer, and the first answer wins — that is not a
 * race to guard against but how a seminar works: the person at the keyboard is
 * not always the person who knows the number.
 */
/**
 * Ответить ячейке, остановившейся внутри `input()`.
 *
 * `cellId` — не украшение: без него ответ уходил тому, на чём ядро оказалось
 * заблокировано в этот момент, кем угодно и с любого экрана. Ячейка сменилась
 * между отрисовкой формы и нажатием Enter — и пароль, набранный для своей
 * ячейки, уходит в чужую.
 */
export async function answerInput(
  sessionId: string,
  value: string,
  cellId?: string,
): Promise<boolean> {
  const runtime = runtimes.get(sessionId)
  const kernel = runtime?.kernel
  if (!kernel || !kernel.waitingForInput) {
    /*
     * Ядро ввода не ждёт — значит, и форма на ячейке не должна спрашивать.
     *
     * Приглашение живёт в общем документе, и висело оно у ВСЕЙ комнаты: каждое
     * следующее «Send» тихо получало `false`, и выйти из этого можно было
     * только «остановить». Гасим здесь, а не только на удачном ответе.
     */
    if (runtime && !runtime.retired) clearStdinOn(sessionId, cellId ?? runtime.currentCell)
    return false
  }
  if (cellId && runtime.currentCell !== cellId) return false
  const answered = await kernel.answerInput(value)
  if (answered) clearStdinOn(sessionId, runtime.currentCell)
  return answered
}

/**
 * Ядро комнаты — но только то, которое УЖЕ живо.
 *
 * Про дополнение это не оговорка, а правило. `ensureKernel` поднимает
 * контейнер, и это до полутора минут: набранная точка после `df` не имеет
 * права заводить комнате Python, греть машину и объявлять всем «запускается
 * окружение» — тем более что человек, может быть, просто пишет текст в ячейку
 * и запускать ничего не собирается. Нет ядра, оно мертво или перезапускается —
 * ответ пуст, и клиент подставляет слова самой ячейки.
 */
function liveKernel(sessionId: string): JupyterKernel | null {
  const kernel = runtimes.get(sessionId)?.kernel ?? null
  if (!kernel) return null
  return kernel.phase === 'dead' || kernel.phase === 'restarting' || kernel.phase === 'starting'
    ? null
    : kernel
}

/**
 * Что ядро дописало бы в этом месте кода.
 *
 * `null` — «спросить было не у кого или ядро не ответило»: отдельного слова
 * для отказа нет намеренно, потому что показывать его негде. Подсказка либо
 * есть, либо её нет; тост про то, что jedi задумался, — это шум посреди
 * набора.
 */
export async function completeIn(
  sessionId: string,
  code: string,
  cursor: number,
): Promise<CompleteResult | null> {
  /*
   * У тестового бэкенда ядра нет вовсе (KERNEL_BACKEND=test, JUPYTER_URL
   * смотрит в мёртвый порт), а проверять надо путь целиком — от кадра пульта
   * до кадра обратно. Заготовленный ответ здесь и есть «ядро» этого бэкенда:
   * тот же набор, что даёт pandas на `df.`, чтобы тест говорил про настоящий
   * случай, а не про пустой список.
   */
  if (kernelBackend() === 'test') return cannedComplete(code, cursor)
  const kernel = liveKernel(sessionId)
  if (!kernel) return null
  try {
    return await kernel.complete(code, cursor)
  } catch {
    // Занятое ядро не отвечает на shell вовсе — см. SHELL_REQUEST_MS. Это
    // обычный исход посреди прогона, и жаловаться на него некуда.
    return null
  }
}

/** Справка о том, что стоит под кареткой, — теми же правилами, что и выше. */
export async function inspectIn(
  sessionId: string,
  code: string,
  cursor: number,
): Promise<InspectResult | null> {
  if (kernelBackend() === 'test') return cannedInspect(code, cursor)
  const kernel = liveKernel(sessionId)
  if (!kernel) return null
  try {
    return await kernel.inspect(code, cursor)
  } catch {
    return null
  }
}

/** Дополнение тестового бэкенда: несколько имён pandas и ничего больше. */
function cannedComplete(code: string, cursor: number): CompleteResult {
  const before = code.slice(0, cursor)
  // Слово, которое человек уже начал, и точка перед ним — ровно то, по чему
  // настоящий ядерный ответ решает, откуда начинается заменяемый кусок.
  const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)?.[0] ?? ''
  const start = cursor - word.length
  const attribute = before[start - 1] === '.'
  const names = attribute
    ? ['head', 'tail', 'describe', 'shape', 'columns']
    : ['print', 'pandas', 'property']
  return {
    matches: names
      .filter((name) => name.startsWith(word))
      .map((name) => ({
        text: name,
        type: name === 'shape' || name === 'columns' ? 'instance' : 'function',
      })),
    cursorStart: start,
    cursorEnd: cursor,
  }
}

/** Справка тестового бэкенда: сигнатура, узнаваемая на глаз и в утверждении. */
function cannedInspect(code: string, cursor: number): InspectResult {
  const name = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(code.slice(0, cursor))?.[0] ?? ''
  if (!name) return { found: false, text: null }
  return {
    found: true,
    text: `Signature: ${name}(n: int = 5)\nDocstring:\nReturn the first n rows.`,
  }
}

/** Погасить приглашение ко вводу на ячейке — там, где спрашивать уже нечему. */
function clearStdinOn(sessionId: string, cellId: string | null): void {
  if (!cellId) return
  const { doc } = getSessionDoc(sessionId)
  const target = findCell(doc, cellId)
  if (target?.cell.get('stdin')) doc.transact(() => target.cell.set('stdin', null), ORIGIN)
}

/**
 * Стереть выводы.
 *
 * С именем ячейки — у одной, в какой бы тетради она ни лежала. Без имени — у
 * ВСЕЙ комнаты, а не у одной тетради: кнопка так и называется, и стирать
 * половину было бы обещанием, которого она не давала.
 */
export function clearOutputs(sessionId: string, cellId?: string, book?: string): void {
  const { doc } = getSessionDoc(sessionId)
  /*
   * Тетрадь названа — стираем в ней; не названа — во всей комнате.
   *
   * Кнопка «Clear» стоит в тулбаре ОДНОЙ тетради и называет её; перезапуск ядра
   * не называет никого, потому что уносит переменные всей комнаты сразу.
   */
  const named = book ? cellsAt(doc, book) : null
  /*
   * Названная, но не найденная тетрадь — это не «тетрадь не названа».
   *
   * `null` здесь читался как «во всей комнате», и промах именем — кадр от
   * вкладки, чью тетрадь только что закрыли или переименовали, — стирал выводы
   * ВСЕХ тетрадей сразу. Кадры с неизвестным именем control.ts теперь отвергает
   * раньше; это вторая линия.
   */
  if (book && !named) return
  const cells = named
    ? named.toArray()
    : allCellArrays(doc).flatMap((array: Y.Array<YCell>) => array.toArray())
  doc.transact(() => {
    cells.forEach((cell: YCell) => {
      if (cellId && idOf(cell) !== cellId) return
      const outputs = cellOutputs(cell)
      if (outputs.length > 0) outputs.delete(0, outputs.length)
      const state = cell.get('state') as CellState | undefined
      // Leave queued and running cells alone; their state belongs to the queue.
      if (state === 'ok' || state === 'error') cell.set('state', 'idle' as CellState)
    })
  }, ORIGIN)
}

/**
 * Всё обратно в покой — кроме той ячейки, которую в этот момент разбирает насос.
 *
 * Перезапуск обрывает исполнение, но насос узнаёт об этом на своём await и
 * доводит ячейку до конца сам: пишет в неё KernelDied и ставит состояние. Если
 * пройтись по ней здесь, состояние ляжет раньше — и насос допишет своё поверх,
 * оставив ячейку «running» в комнате, где ничего не выполняется.
 */
function resetAllCells(sessionId: string, except: string | null = null): void {
  const { doc } = getSessionDoc(sessionId)
  // Перезапуск ядра уносит переменные всей комнаты, а не одной тетради.
  const cells = allCellArrays(doc).flatMap((array: Y.Array<YCell>) => array.toArray())
  doc.transact(() => {
    cells.forEach((cell: YCell) => {
      /*
       * Номер снимается со всех, состояние — не со всех.
       *
       * Исключение существует ради гонки: ячейку, которую сейчас разбирает
       * насос, он допишет сам, и трогать её состояние отсюда значит получить
       * «running» в комнате, где ничего не выполняется. К номеру это не
       * относится: за это выполнение его больше никто не запишет — execute_input
       * уже был, а setCellState номера не касается, — и счётчик, который его
       * выдал, принадлежит ядру, которого больше нет.
       *
       * Раньше исключение накрывало и номер, и получалось хуже всего: после
       * перезапуска сорок результатов оставались на экране, а единственный
       * проверяемый факт о них — номер выполнения — исчезал молча. Теперь
       * номера нет у всех, и клиент говорит об этом словами.
       */
      cell.set('execCount', null)
      if (except && idOf(cell) === except) return
      cell.set('state', 'idle' as CellState)
      // И секундомер вместе с ним: ядро, которое считало, перезапущено, а
      // время прошлого выполнения относилось к нему.
      cell.set('startedAt', null)
      cell.set('ranMs', null)
    })
  }, ORIGIN)
}

/* -------------------------------------------------------------- workspace */

export function onWorkspaceChanged(cb: (sessionId: string) => void): void {
  workspaceListeners.push(cb)
}

function notifyWorkspaceChanged(sessionId: string): void {
  for (const cb of [...workspaceListeners]) {
    try {
      cb(sessionId)
    } catch (err) {
      console.error(`[kernel] workspace listener failed for ${sessionId}:`, errText(err))
    }
  }
}

/**
 * The environment a room's kernel is actually running, or null when it has not
 * started one. Read by the panel: a seminar that was live through a switch is
 * still on the old image, and a column that showed the configured value would
 * be quietly wrong about exactly the case worth knowing.
 */
export function environmentOf(sessionId: string): string | null {
  return runtimes.get(sessionId)?.environment ?? null
}
