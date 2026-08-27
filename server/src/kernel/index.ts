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
  cellType,
  createTerminalLine,
  findCell,
  getCells,
  getMeta,
  getTerminal,
  type CellState,
  type KernelStatus,
} from '@shared/notebook'
import { config } from '../config.js'
import { sessionEnvironment } from '../db.js'
import { activeName } from '../environments.js'
import { formatNotebook, type FormatOutcome } from './format.js'
import { endpointForEnvironment, forgetEnvironment } from './pool.js'
import { getSessionDoc } from '../collab/index.js'
import { JupyterKernel, type ExecuteStatus, type KernelPhase } from './jupyter.js'
import { OutputWriter } from './outputs.js'
import { closeTerminal } from './terminal.js'

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
  writer: OutputWriter | null
  /**
   * Which environment this room's kernel actually came up on.
   *
   * Not the same as "the environment configured right now": switching rebuilds
   * and restarts the container, but a room that was already running keeps the
   * Python it started with until its own kernel is replaced. The panel says so
   * in the footnote; this is what makes the column able to say it too.
   */
  environment: string | null
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
      writer: null,
      environment: null,
    }
    runtimes.set(sessionId, runtime)
  }
  return runtime
}

/* --------------------------------------------------------- document mirror */

function setStatus(runtime: Runtime, status: KernelStatus): void {
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  if (meta.get('kernelStatus') === status) return
  doc.transact(() => meta.set('kernelStatus', status), ORIGIN)
}

function syncQueue(runtime: Runtime): void {
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  const ids = runtime.queue.map((item) => item.cellId)
  const running = runtime.currentCell ?? null

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
): Promise<ExecuteStatus> {
  try {
    return await runtime.kernel!.execute(source, handlers)
  } catch (err) {
    if (runtime.kernel && runtime.kernel.phase !== 'dead') throw err
    kernelNote(runtime.sessionId, 'The kernel had stopped. Starting a fresh one — variables from before are gone.')
    await ensureKernel(runtime.sessionId)
    /*
     * Секундомер заводится заново, когда ядро наконец есть.
     *
     * Подъём холодного контейнера — это до полутора минут, и они шли в счёт
     * ячейки: однострочник отчитывался о полутора минутах работы, хотя считал
     * миллисекунды. Ждали при этом не его.
     */
    restamp(runtime)
    return await runtime.kernel!.execute(source, handlers)
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
  const cells = getCells(doc)
  let repaired = 0

  doc.transact(() => {
    for (const cell of cells) {
      const state = cell.get('state')
      if (state !== 'running' && state !== 'queued') continue
      const id = idOf(cell)
      const ours = runtime && (runtime.currentCell === id || runtime.queue.some((q) => q.cellId === id))
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
      if (found && found.cell.get('state') === 'queued') found.cell.set('state', 'idle' as CellState)
    }
  }, ORIGIN)
  syncQueue(runtime)
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
    const known = churnReason()
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
    const hadWork = runtime.currentCell !== null || runtime.queue.length > 0
    dropQueue(runtime)
    setStatus(runtime, 'dead')
    // Found by asking, before the cell was sent: the run is about to be retried
    // on a fresh kernel and will say so itself. Two notices, one of them about a
    // cell that then runs perfectly well, is worse than one.
    if (expected) return
    // A kernel usually dies because a cell asked for more memory than the
    // container has. Saying so beats a room staring at a notebook that stopped.
    const known = churnReason()
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
      // Куда идти за Python — решает окружение комнаты, а не глобальная
      // настройка: два семинара могут одновременно сидеть на разном.
      const endpoint = await endpointForEnvironment(wanted)
      const kernel = await JupyterKernel.connect(sessionId, endpoint)
      runtime.kernel = kernel
      kernel.onPhaseChange((phase, expected) => onPhase(runtime, phase, expected))
      // Before anything of ours is sent: a kernel that is already busy is
      // finishing a cell for a server that no longer exists, and it would make
      // every Run in this room wait behind output nobody will ever see.
      if (await kernel.releaseOrphanedWork()) {
        kernelNote(
          sessionId,
          'The kernel kept running while the server was away, so every variable is still here. The one cell it was in the middle of was stopped — its output had nowhere left to go.',
        )
      }
      setStatus(runtime, runtime.currentCell ? 'busy' : (kernel.phase as KernelStatus))
    } catch (err) {
      setStatus(runtime, 'dead')
      /*
       * Забыть запомненный адрес контейнера.
       *
       * Порт у контейнера окружения случайный, и пул его кеширует. После
       * `docker restart colloq-env-cv` порт другой, а комната ходит по старому
       * — и будет ходить, пока не перезапустят весь сервер: «No Python kernel
       * after 60s» на каждый Run, при живом и здоровом контейнере рядом.
       * Функция для этого была написана и не вызывалась ниоткуда.
       */
      if (wanted) forgetEnvironment(wanted)
      // Into the shared record too: the person who presses Run sees the message
      // on their cell, and everyone else sees a notebook that stopped.
      kernelNote(sessionId, errText(err))
      throw err
    } finally {
      clearTimeout(slow)
      runtime.starting = null
    }
  })()

  return runtime.starting
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
      kernelNote(sessionId, restartedBy ? `Kernel restarted by ${restartedBy}. Every variable is gone and the queue was dropped.` : 'Kernel restarted. Every variable is gone and the queue was dropped.')
    } catch (err) {
      // Never a rejection: the person clicked a button, the document carries the news.
      console.error(`[kernel] restart failed for ${sessionId}:`, errText(err))
      setStatus(runtime, 'dead')
      kernelNote(sessionId, 'The kernel did not come back after the restart. Nothing can run until it does.')
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
  if (running) stopBatchOf(runtime, running)
  else if (cellId === undefined) dropQueue(runtime)
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
}

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

/* -------------------------------------------------------------- run queue */

let batchCounter = 0

export function requestRun(sessionId: string, cellIds: string[], runBy: string, runById: string): void {
  const runtime = getRuntime(sessionId)
  // Нажатие чинит комнату, в которой нажали: если в ней осталась ячейка,
  // которую документ считает работающей, а сервер о ней не знает, — самое
  // время это заметить. См. sweepOrphanRuns.
  sweepOrphanRuns(sessionId)
  const { doc } = getSessionDoc(sessionId)
  const batch = ++batchCounter

  doc.transact(() => {
    for (const cellId of cellIds) {
      const found = findCell(doc, cellId)
      // Markdown cells arrive in every runAll list; skipping them is not an error.
      if (!found || cellType(found.cell) !== 'code') continue
      if (runtime.currentCell === cellId) continue
      if (runtime.queue.some((item) => item.cellId === cellId)) continue
      runtime.queue.push({ cellId, runBy, runById, batch })
      found.cell.set('state', 'queued' as CellState)
      found.cell.set('runBy', runBy)
      found.cell.set('runById', runById)
    }
  }, ORIGIN)

  syncQueue(runtime)
  void pump(runtime)
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
      await runOne(runtime, item)
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
    runtime.writer = null
    writer.dispose()
    setCellState(runtime.sessionId, item.cellId, 'ok')
    return
  }

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
    if (status === 'abort' && runtime.kernel?.phase === 'dead') {
      writer.error('KernelDied', deadMessage(), [])
      state = 'error'
    }
  } catch (err) {
    writer.error('KernelError', errText(err), [])
    state = 'error'
  } finally {
    writer.dispose()
    runtime.writer = null
    runtime.currentCell = null
    runtime.currentBatch = null
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

/** A kernel that will not come up is an output on the cell, never a crash. */
function reportDeadKernel(runtime: Runtime, message: string): void {
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

/* ------------------------------------------------------------------ outputs */

/**
 * Put the room's code in one shape.
 *
 * Waits for a kernel first: black runs in the seminar's own Python, so that the
 * formatting matches the version the room is actually using. Anything the
 * formatter refuses is left alone — see kernel/format.ts for why that is the
 * whole design rather than a fallback.
 */
export async function formatSession(sessionId: string): Promise<FormatOutcome> {
  const runtime = getRuntime(sessionId)
  try {
    await ensureKernel(sessionId)
  } catch (err) {
    return { changed: 0, skipped: 0, unchanged: 0, error: errText(err) }
  }
  const kernel = runtime.kernel
  if (!kernel) {
    return { changed: 0, skipped: 0, unchanged: 0, error: 'The kernel is not running.' }
  }
  const outcome = await formatNotebook(sessionId, kernel)
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
export async function answerInput(sessionId: string, value: string): Promise<boolean> {
  const runtime = runtimes.get(sessionId)
  const kernel = runtime?.kernel
  if (!kernel || !kernel.waitingForInput) return false
  const answered = await kernel.answerInput(value)
  if (answered && runtime.currentCell) {
    const { doc } = getSessionDoc(sessionId)
    const target = findCell(doc, runtime.currentCell)
    if (target) doc.transact(() => target.cell.set('stdin', null), ORIGIN)
  }
  return answered
}

export function clearOutputs(sessionId: string, cellId?: string): void {
  const { doc } = getSessionDoc(sessionId)
  const cells = getCells(doc)
  doc.transact(() => {
    cells.forEach((cell) => {
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
  const cells = getCells(doc)
  doc.transact(() => {
    cells.forEach((cell) => {
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
