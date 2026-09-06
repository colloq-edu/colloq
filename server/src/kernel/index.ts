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
import { sessionEnvironment } from '../db.js'
import { activeName } from '../environments.js'
import { formatNotebook, type FormatOutcome } from './format.js'
import {
  dropRoomKernel,
  endpointForSession,
  forgetSessionKernel,
  isolationLost,
  listRoomKernels,
  runningRoomKernels,
} from './pool.js'
import { getSessionDoc, onlineCount } from '../collab/index.js'
import { seldom } from '../log.js'
import { projectBooks } from '../collab/books.js'
import { flushSessionFiles } from '../collab/files.js'
import { JupyterKernel, type ExecuteStatus, type KernelPhase } from './jupyter.js'
import { OutputWriter } from './outputs.js'
import { CouncilOutputBuffer, type CouncilJob } from './council.js'
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

/** Попытка консилиума, которую ядро считает прямо сейчас. */
interface ActiveJob {
  item: QueueItem
  job: CouncilJob
  buffer: CouncilOutputBuffer
  run: CouncilRun
  /** Отложенный кадр вывода — см. `touchJob`. */
  timer: NodeJS.Timeout | null
}

/** Синтетическое имя записи очереди для попытки: никогда не совпадает с ячейкой. */
function councilQueueId(cellId: string, participantId: string): string {
  return `council:${cellId}:${participantId}`
}

interface Runtime {
  sessionId: string
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
      pumping: false,
      currentCell: null,
      currentBatch: null,
      started: null,
      currentRunById: null,
      lastFinished: null,
      writer: null,
      job: null,
      environment: null,
      retired: false,
    }
    runtimes.set(sessionId, runtime)
  }
  return runtime
}

/* --------------------------------------------------------- document mirror */

function setStatus(runtime: Runtime, status: KernelStatus): void {
  if (runtime.retired) return
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  if (meta.get('kernelStatus') === status) return
  doc.transact(() => meta.set('kernelStatus', status), ORIGIN)
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
    if (list.length > 0) list.delete(0, list.length)
    if (ids.length > 0) list.push(ids)
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
      'The kernel had stopped. Starting a fresh one — variables from before are gone.',
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
 */
export function sweepOrphanRuns(sessionId: string): number {
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
  releaseCouncil(dropped)
  syncQueue(runtime)
}

/**
 * Попытки, снятые с очереди без запуска, — об этом надо сказать их авторам.
 *
 * У ячейки та же новость ложится в документ (`state: 'idle'`), и комната видит
 * её сама. У попытки документа нет: не позвать — значит оставить на карточке
 * «в очереди» до конца пары. `null` — «запуска не было», см. CouncilJob.
 */
function releaseCouncil(dropped: QueueItem[]): void {
  for (const item of dropped) if (item.council) tellJob(item.council, null)
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
        ? `${known} Every variable is gone${hadWork ? '; whatever was queued was dropped' : ''}.`
        : hadWork
          ? 'The kernel ran out of memory and is coming back on its own. Every variable is gone; whatever was queued was dropped.'
          : 'The kernel restarted on its own — usually memory. Every variable is gone.',
    )
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
        ? `${known}${hadWork ? ' Whatever was queued was dropped.' : ''} Run a cell to start a fresh one.`
        : hadWork
          ? 'The kernel stopped while a cell was running — usually memory. Whatever was queued was dropped; restart to carry on.'
          : 'The kernel stopped. Restart it to run anything.',
    )
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
        ? `Starting the ${envName} environment — its container has to come up first, which takes up to a minute and a half on a cold start. Still trying; nothing can run until it answers.`
        : `The kernel is taking longer than usual to start at ${config.jupyter.url}. Still trying — nothing can run until it answers.`,
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
      kernel.onPhaseChange((phase, expected) => onPhase(runtime, phase, expected))
      // Before anything of ours is sent: a kernel that is already busy is
      // finishing a cell for a server that no longer exists, and it would make
      // every Run in this room wait behind output nobody will ever see.
      if ((await kernel.releaseOrphanedWork()) && !runtime.retired) {
        kernelNote(
          sessionId,
          'The kernel kept running while the server was away, so every variable is still here. The one cell it was in the middle of was stopped — its output had nowhere left to go.',
        )
      }
      setStatus(runtime, runtime.currentCell ? 'busy' : (kernel.phase as KernelStatus))
      // Подъём ядра — настоящее событие: до полутора минут холодного старта, и
      // именно между этой строкой и следующей комната смотрит в пустоту.
      console.log(`[kernel ${sessionId}] up (${envName ?? 'shared'})`)
      await noteSharedKernel(runtime)
    } catch (err) {
      setStatus(runtime, 'dead')
      // Не чаще раза в минуту на комнату: `ensureKernel` зовёт и вход каждого
      // студента, и каждый Run, а обещание у них одно на всех — тридцать
      // одинаковых строк в ту же миллисекунду мы уже видели.
      if (seldom(`kernel-down:${sessionId}`)) {
        console.warn(`[kernel ${sessionId}] did not start: ${errText(err)}`)
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

/** Про общее ядро комната слышит один раз, а не на каждый Run. */
const toldSharedKernel = new Set<string>()

/**
 * Сказать комнате, что своего контейнера у неё нет.
 *
 * `KERNEL_ISOLATION=auto` — умолчание, и оно обещает семинару свой контейнер, в
 * который смонтирована только его папка. Под `make up` сервер живёт в
 * контейнере, который не видит docker, и обещание тихо не выполняется: все
 * комнаты инстанса сидят в одном ядре compose, видят файлы друг друга, делят
 * один предел памяти, а выбранное окружение не значит ничего. До сих пор об
 * этом говорилось только в журнале контейнера — там, куда преподаватель не
 * смотрит; теперь и в комнате, где это касается людей.
 */
async function noteSharedKernel(runtime: Runtime): Promise<void> {
  if (toldSharedKernel.has(runtime.sessionId)) return
  if (!(await isolationLost())) return
  if (runtime.retired) return
  toldSharedKernel.add(runtime.sessionId)
  kernelNote(
    runtime.sessionId,
    'This server cannot reach Docker, so every seminar on it shares one Python container: ' +
      "cells here can read and delete other seminars' files, the memory limit is shared, and " +
      'the environment picked for this seminar is not the one actually running. Run the server ' +
      'where it can see Docker (make run) to give every room its own container.',
  )
}

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
          ? `Kernel restarted by ${restartedBy}. Every variable is gone and the queue was dropped.`
          : 'Kernel restarted. Every variable is gone and the queue was dropped.',
      )
    } catch (err) {
      // Never a rejection: the person clicked a button, the document carries the news.
      console.error(`[kernel] restart failed for ${sessionId}:`, errText(err))
      setStatus(runtime, 'dead')
      kernelNote(
        sessionId,
        'The kernel did not come back after the restart. Nothing can run until it does.',
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
export async function shutdownSession(sessionId: string): Promise<void> {
  const runtime = runtimes.get(sessionId)
  if (runtime) {
    // Первым делом, до всякого await: подъём ядра, идущий прямо сейчас, увидит
    // этот признак и не станет ни писать в документ, ни оставлять за собой
    // подключённое ядро.
    runtime.retired = true
    runtimes.delete(sessionId)
    runtime.queue.length = 0
    runtime.writer?.dispose()
    runtime.writer = null
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
  toldSharedKernel.delete(sessionId)
  /*
   * И сам контейнер комнаты.
   *
   * Контейнер теперь один на семинар, а не один на окружение: не убрать его —
   * значит оставить по контейнеру на каждую пару, когда-либо проведённую на
   * этой машине. Файлы комнаты лежат на хосте и это переживают; уходит только
   * Python со всеми переменными, что и означает «семинар закончился».
   */
  try {
    await dropRoomKernel(sessionId)
  } catch (err) {
    console.error(`[kernel] could not remove the container for ${sessionId}:`, errText(err))
  }
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
const SWEEP_EVERY_MS = 10 * 60 * 1000

/** Когда в комнате в последний раз кто-то был. */
const lastOccupied = new Map<string, number>()

async function sweepIdleKernels(): Promise<void> {
  const now = Date.now()
  /*
   * Не только те, что поднял этот процесс.
   *
   * `runningRoomKernels()` — карта в памяти, и после перезапуска сервера она
   * пуста, а вчерашние контейнеры работают: уборка о них не знала, пока кто-то
   * не откроет комнату, и они жили до `make down`. Метка docker переживает нас,
   * поэтому спрашиваем и её.
   */
  const rooms = new Set<string>(runningRoomKernels())
  for (const sessionId of await listRoomKernels()) rooms.add(sessionId)
  for (const sessionId of rooms) {
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
    if (busy) {
      lastOccupied.set(sessionId, now)
      continue
    }
    const since = lastOccupied.get(sessionId)
    if (since === undefined) {
      // Первый раз видим её пустой — отсчёт начинается сейчас, а не от нуля.
      lastOccupied.set(sessionId, now)
      continue
    }
    if (now - since < IDLE_KERNEL_MS) continue
    lastOccupied.delete(sessionId)
    try {
      await shutdownSession(sessionId)
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
  for (const runtime of all) {
    runtime.queue.length = 0
    runtime.writer?.dispose()
    runtime.writer = null
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
  return runtime?.currentRunById === participantId
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
      runtime.queue.push({ cellId, runBy, runById, batch })
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
  releaseCouncil(dropped)
  syncQueue(runtime)
  // Said out loud, because a queue that empties without a word reads as a
  // product that ignored the button.
  kernelNote(
    runtime.sessionId,
    dropped.length === 1
      ? 'The interrupt also dropped the one cell queued behind it.'
      : `The interrupt also dropped the ${dropped.length} cells queued behind it.`,
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
  releaseCouncil(dropped)
  syncQueue(runtime)
  kernelNote(
    runtime.sessionId,
    dropped.length === 1
      ? 'A cell failed, so the one queued behind it was not run.'
      : `A cell failed, so the ${dropped.length} cells queued behind it were not run.`,
  )
}

async function pump(runtime: Runtime): Promise<void> {
  if (runtime.pumping) return
  runtime.pumping = true
  try {
    while (runtime.queue.length > 0) {
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
  if (!found || cellType(found.cell) !== 'code') return

  const cell = found.cell
  const source = cellSource(cell).toString()
  const writer = new OutputWriter(doc, item.cellId)
  runtime.currentCell = item.cellId
  runtime.currentBatch = item.batch
  runtime.currentRunById = item.runById
  runtime.writer = writer
  // Одно и то же число в двух местах: в документ — чтобы росли часы у всех, в
  // среду исполнения — чтобы длительность считалась по нашей записи.
  const startedAt = Date.now()
  runtime.started = { cellId: item.cellId, at: startedAt }
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
    runtime.lastFinished = { cellId: item.cellId, batch: item.batch }
    runtime.writer = null
    writer.dispose()
    setCellState(runtime.sessionId, item.cellId, 'ok')
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
    writer.dispose()
    runtime.writer = null
    runtime.currentCell = null
    runtime.currentBatch = null
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
  syncQueue(runtime)
  // The cell may have written a CSV; the Files panel should not need a refresh.
  notifyWorkspaceChanged(runtime.sessionId)
}

/* --------------------------------------------------------- консилиум */

/** Не чаще этого кадр вывода попытки едет хосту и автору, пока она считается. */
const COUNCIL_REPORT_MS = 400

/**
 * Поставить попытку консилиума в очередь ядра.
 *
 * Одна и та же попытка — одна запись: второе нажатие, пока первая ждёт или
 * считается, ничего не ставит и возвращает её место, чтобы отказ мог сказать
 * «вы 37-й». `position` — номер в очереди, считая ту, что выполняется; `0` —
 * выполняется сейчас. `runById` — кто нажал: преподаватель, запускающий чужую
 * попытку, остаётся хозяином запуска (прервать, ответить на input) — как и у
 * ячейки.
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
  if (already !== null) return { queued: false, position: already }
  runtime.queue.push({
    cellId: councilQueueId(job.cellId, job.participantId),
    runBy,
    runById,
    batch: ++batchCounter,
    council: job,
  })
  const position = councilQueuePosition(sessionId, job.cellId, job.participantId) ?? 1
  tellJob(job, {
    state: 'queued',
    outputs: [],
    execCount: null,
    ranMs: null,
    startedAt: Date.now(),
    by: job.by,
  })
  syncQueue(runtime)
  void pump(runtime)
  return { queued: true, position }
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

/**
 * Единственная дверь из «считается» для попытки — как `setCellState` у ячейки.
 * Сюда приходят обычный конец, бросок из execute и `reportDeadKernel`.
 */
function finishCouncil(runtime: Runtime, active: ActiveJob, state: 'ok' | 'error'): void {
  if (active.timer) {
    clearTimeout(active.timer)
    active.timer = null
  }
  // По записи среды, а не по своей: `restamp` переставляет начало, когда ядро
  // пришлось поднимать заново, и полторы минуты его подъёма — не время попытки.
  const startedAt =
    runtime.started?.cellId === active.item.cellId ? runtime.started.at : active.run.startedAt
  active.run = {
    ...active.run,
    state,
    outputs: active.buffer.snapshot(),
    ranMs: Math.max(0, Date.now() - startedAt),
  }
  if (runtime.started?.cellId === active.item.cellId) runtime.started = null
  runtime.job = null
  runtime.currentCell = null
  runtime.currentBatch = null
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
  }
  runtime.currentCell = item.cellId
  runtime.currentBatch = item.batch
  runtime.currentRunById = item.runById
  runtime.started = { cellId: item.cellId, at: startedAt }
  runtime.job = active
  syncQueue(runtime)
  setStatus(runtime, 'busy')
  tellJob(job, { ...active.run })

  if (job.source.trim().length === 0) {
    finishCouncil(runtime, active, 'ok')
    return
  }

  flushToDisk(runtime.sessionId)
  const unwatch = stopIfDeleted(runtime, doc, item.cellId, job.cellId)
  const { buffer } = active
  let state: 'ok' | 'error' = 'ok'
  try {
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
            '[colloq] input() в попытке консилиума не спрашивает зал — подставлена пустая строка.\n',
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
      } else buffer.error('Interrupted', 'Запуск попытки прервали.', [])
    }
  } catch (err) {
    buffer.error('KernelError', errText(err), [])
    state = 'error'
  } finally {
    unwatch()
  }
  finishCouncil(runtime, active, state)
  // Попытка могла записать файл — панели файлов это так же интересно.
  notifyWorkspaceChanged(runtime.sessionId)
}

/** A kernel that will not come up is an output on the cell, never a crash. */
function reportDeadKernel(runtime: Runtime, message: string): void {
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
    writer.dispose()
    runtime.writer = null
    runtime.currentCell = null
    runtime.currentBatch = null
    const waiting = runtime.queue[0]?.cellId === stuck
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
  return 'The Python kernel stopped responding — restart it to keep going. (A cell that allocates all the memory will do this.)'
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
    kernelNote(
      runtime.sessionId,
      'The cell that was running was deleted, so the kernel was interrupted — whatever it had already changed is still in memory.',
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
    ? `${known} The cell running at the time was killed with it, and every variable is gone.`
    : 'The kernel was restarted while this cell was running — the process was killed, almost always because it ran out of memory. Every variable is gone; the kernel itself is back.'
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
  try {
    await ensureKernel(sessionId)
  } catch (err) {
    return { changed: 0, skipped: 0, edited: 0, unchanged: 0, error: errText(err) }
  }
  const kernel = runtime.kernel
  if (!kernel) {
    return {
      changed: 0,
      skipped: 0,
      edited: 0,
      unchanged: 0,
      error: 'The kernel is not running.',
    }
  }
  const outcome = await formatNotebook(sessionId, kernel, book)
  if (outcome.error) kernelNote(sessionId, `Formatting failed: ${outcome.error}`)
  return outcome
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
  if (!kernel || !kernel.waitingForInput) return false
  if (cellId && runtime.currentCell !== cellId) return false
  const answered = await kernel.answerInput(value)
  if (answered && runtime.currentCell) {
    const { doc } = getSessionDoc(sessionId)
    const target = findCell(doc, runtime.currentCell)
    if (target) doc.transact(() => target.cell.set('stdin', null), ORIGIN)
  }
  return answered
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
