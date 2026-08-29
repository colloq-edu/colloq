/**
 * The run-control socket.
 *
 * Everything the room *sees* — source, outputs, kernel status — travels through
 * the CRDT. This channel carries the things a CRDT cannot express: "run this",
 * "stop", "start over", and the two pieces of side-band state the document has
 * no home for (the workspace file listing and a plain error sentence).
 *
 * Running a cell is open to every participant. That is not an oversight: a
 * seminar where only the lecturer may press Run is a screen share, and the
 * whole point of Colloq is that a student can try the thing being discussed
 * without leaving the room. Interrupt and restart are host-only, because those
 * are destructive to everyone else's kernel state.
 *
 * The terminal splits the same way. Opening it and typing into it are open to
 * everyone — it is the room's shell, and a student who needs a library should be
 * able to install it. Clearing and closing are host-only, because both destroy
 * something the whole room can see: shared history, and the shell itself.
 */
import { WebSocket, type RawData } from 'ws'
import {
  acceptPatch,
  cellId,
  cellType,
  findChatEntry,
  getCells,
  getMeta,
  rejectPatch,
  type KernelStatus,
} from '@shared/notebook'
import { colorForId } from '@shared/protocol'
import type {
  ControlClientMessage,
  ControlServerMessage,
  FileEntry,
  Participant,
} from '@shared/protocol'
import type { TokenPayload } from './auth.js'
import { applyOnBehalf, getSessionDoc, onRefusal } from './collab/index.js'
import { moveInCells } from './collab/ops.js'
import { LINE_LENGTH } from './kernel/format.js'
import { allows, allowsAgent, allowsRun, allowsStructure, runQueueCap, type Who } from '@shared/rules'
import { getParticipant, getRules } from './db.js'
import {
  answerInput,
  clearOutputs,
  formatSession,
  kernelNote,
  interruptSession,
  onWorkspaceChanged,
  requestRun,
  restartSession,
  sweepOrphanRuns,
  cancelRun,
  queueIsOnly,
  startedTheRunningCell,
} from './kernel/index.js'
import {
  clearTerminal,
  closeTerminal,
  interruptTerminal,
  onTerminalPhase,
  openTerminal,
  runCommand,
  terminalPhase,
  typedRunningCommand,
} from './kernel/terminal.js'
import {
  deleteFile,
  listFiles,
  makeDir,
  makeFile,
  movePath,
  statPath,
  type TreeResult,
} from './workspace.js'
import { MAX_DEPTH, baseOf, normalizePath, runnerFor, whySegmentRefused } from '@shared/paths'
import { forgetFile, onFileSaved } from './collab/files.js'
import { undoTurn } from './ai/agent.js'

/** Same reason as the collab socket: stay under the usual 30s idle timeout. */
const PING_INTERVAL_MS = 25_000
/** A socket that ignores this many consecutive pings is a closed laptop lid. */
const MAX_MISSED_PONGS = 2
/** Control frames are tiny by construction; anything larger is not ours. */
const MAX_FRAME_BYTES = 8192
/** A shell command, not a shell script: anything longer is a paste accident. */
const MAX_COMMAND_BYTES = 4096

interface Room {
  sockets: Set<WebSocket>
  unwatch: () => void
}

const rooms = new Map<string, Room>()

/* ----------------------------------------------------------------- send */

function send(ws: WebSocket, message: ControlServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(message))
  } catch {
    /* the socket died between the check and the write */
  }
}

export function broadcast(sessionId: string, message: ControlServerMessage): void {
  const room = rooms.get(sessionId)
  if (!room) return
  const frame = JSON.stringify(message)
  for (const ws of room.sockets) {
    if (ws.readyState !== WebSocket.OPEN) continue
    try {
      ws.send(frame)
    } catch {
      /* dropped; the close handler will clean it up */
    }
  }
}

/**
 * Push the workspace listing to a session. Called after an upload or delete and,
 * via `onWorkspaceChanged`, whenever a cell writes a file — so `df.to_csv(...)`
 * makes the Files panel update for the whole room, not just for whoever ran it.
 */
/**
 * Send everyone in a room home and stop watching it. Called when the seminar
 * itself is deleted: a control socket that outlives its seminar can still ask
 * for a run, and every path in kernel/index.ts reaches for the document through
 * getSessionDoc(), which would build the deleted room again from nothing.
 */
export function closeControlRoom(sessionId: string): void {
  const room = rooms.get(sessionId)
  if (!room) return
  rooms.delete(sessionId)
  // И доску: комнаты больше нет, показывать нечего и некому.
  boards.delete(sessionId)
  room.unwatch()
  for (const ws of room.sockets) {
    try {
      ws.close(1001, 'this seminar was deleted')
    } catch {
      /* already gone */
    }
  }
  room.sockets.clear()
}

export function broadcastFiles(sessionId: string): void {
  const room = rooms.get(sessionId)
  if (!room || room.sockets.size === 0) return
  let files: FileEntry[]
  try {
    files = listFiles(sessionId)
  } catch {
    return
  }
  broadcast(sessionId, { t: 'files', files })
}

/* ------------------------------------------------------- общий экран */

/**
 * Документ, который комната смотрит вместе.
 *
 * В памяти процесса, рядом с комнатой, а не в общем документе и не в
 * присутствии. Присутствие исчезает вместе с вкладкой — закрытый ноутбук
 * преподавателя убрал бы материал у всех. Общий документ Yjs пишет каждую
 * запись в ленту версий, и «открыл PDF» стало бы строкой истории, а Ctrl+Z в
 * ячейке — способом закрыть его всей комнате.
 *
 * Цена названа вслух: перезапуск сервера закрывает доску у всех. Так же уходит
 * и очередь запуска, и это то же самое обещание — комната переживает обрыв
 * связи, но не перезапуск процесса.
 */
const boards = new Map<string, string>()

/** Что комната смотрит сейчас. */
export function boardOf(sessionId: string): string | null {
  return boards.get(sessionId) ?? null
}

function setBoard(sessionId: string, name: string | null): void {
  if (name === null) boards.delete(sessionId)
  else boards.set(sessionId, name)
  broadcast(sessionId, { t: 'board', open: name })
}

/**
 * Файл пропал или его переписали — доску надо закрыть.
 *
 * Удалить файл может преподаватель, а переписать — любая ячейка: `df.to_csv`
 * идёт в ту же папку. Читалка, продолжающая показывать документ, которого нет,
 * — это пустая область без объяснения.
 */
function forgetMissingBoard(sessionId: string): void {
  const open = boards.get(sessionId)
  if (!open) return
  try {
    if (!listFiles(sessionId).some((file) => !file.dir && file.path === open)) {
      setBoard(sessionId, null)
    }
  } catch {
    /* папку не прочитать — доску не трогаем, это не повод её закрывать */
  }
}

/*
 * Файл лёг на диск — комната узнаёт новый размер и время.
 *
 * Редактор сохраняется сам каждые несколько секунд, и без этой строки панель
 * файлов показывала бы размер, каким он был при открытии вкладки: «0 B» у
 * файла, в котором уже сорок строк.
 */
onFileSaved((sessionId) => broadcastFiles(sessionId))

// Registered once, at import: the kernel runtime has no idea who is listening.
onWorkspaceChanged((sessionId) => {
  forgetMissingBoard(sessionId)
  broadcastFiles(sessionId)
})

/**
 * Кому принадлежит управляющий сокет.
 *
 * Отказ в правке адресован одному человеку, а не комнате: рассказывать всем
 * двадцати, что кто-то попробовал написать в чужую тетрадь, — не то, что нужно
 * ни автору правки, ни остальным.
 */
const owner = new WeakMap<WebSocket, string>()

function tell(sessionId: string, participantId: string, message: ControlServerMessage): void {
  const room = rooms.get(sessionId)
  if (!room) return
  for (const ws of room.sockets) if (owner.get(ws) === participantId) send(ws, message)
}

onRefusal((sessionId, participantId, refusal) => {
  tell(sessionId, participantId, {
    t: 'refused',
    rule: refusal.rule,
    message: refusal.message,
  })
})

// The transcript is in the document; the terminal's health is not, so it comes
// down this channel the same way kernel status does.
onTerminalPhase((sessionId, status) => broadcast(sessionId, { t: 'terminal', status }))

/* ----------------------------------------------------------------- doc */

function kernelStatus(sessionId: string): KernelStatus {
  try {
    const status = getMeta(getSessionDoc(sessionId).doc).get('kernelStatus')
    return typeof status === 'string' ? (status as KernelStatus) : 'starting'
  } catch {
    return 'starting'
  }
}

/**
 * Kernel health lives in the document, so the browser already re-renders from
 * there. Mirroring it onto this socket costs one small frame and keeps clients
 * that are watching only the control channel honest.
 */
function watchKernelStatus(sessionId: string): () => void {
  const meta = getMeta(getSessionDoc(sessionId).doc)
  let last = meta.get('kernelStatus') as KernelStatus | undefined
  const onChange = () => {
    const status = meta.get('kernelStatus') as KernelStatus | undefined
    if (!status || status === last) return
    last = status
    broadcast(sessionId, { t: 'kernel', status })
  }
  meta.observe(onChange)
  return () => meta.unobserve(onChange)
}

/**
 * Code cell ids in document order. With `upToCellId`, stops after that cell —
 * and returns nothing if the id is unknown, so a stale "run above" from a tab
 * that missed a deletion cannot silently turn into "run the whole notebook".
 */
function codeCellIds(sessionId: string, upToCellId?: string): string[] {
  const cells = getCells(getSessionDoc(sessionId).doc)
  const ids: string[] = []
  for (let i = 0; i < cells.length; i++) {
    const cell = cells.get(i)
    const id = cellId(cell)
    if (cellType(cell) === 'code') ids.push(id)
    if (upToCellId !== undefined && id === upToCellId) return ids
  }
  return upToCellId === undefined ? ids : []
}

/** Output attribution is a human name or nothing worth showing. */
function displayName(sessionId: string, participantId: string): string {
  try {
    return getParticipant(sessionId, participantId)?.name || 'Someone'
  } catch {
    return 'Someone'
  }
}

/**
 * Terminal lines carry the typist's colour as well as their name — in a shared
 * shell, "who ran that" is the first question anyone asks.
 */
function sender(
  sessionId: string,
  participantId: string,
): { name: string; color: string; participantId: string } {
  let participant: Participant | null = null
  try {
    participant = getParticipant(sessionId, participantId)
  } catch {
    participant = null
  }
  return {
    name: participant?.name || 'Someone',
    color: participant?.color || colorForId(participantId),
    participantId,
  }
}

/* ------------------------------------------------------------- dispatch */

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return (data as Buffer).toString('utf8')
}

function parse(data: RawData): ControlClientMessage | null {
  const text = frameText(data)
  if (text.length === 0 || text.length > MAX_FRAME_BYTES) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const t = (parsed as { t?: unknown }).t
    if (typeof t !== 'string') return null
    return parsed as ControlClientMessage
  } catch {
    return null
  }
}

/**
 * May this person start the kernel on something?
 *
 * The first of the room's rules to be enforced, and the reason it is first: one
 * kernel serves everybody, so a class where twenty people press Run is one
 * queue, and a lecture usually wants the queue to be the teacher's. Every other
 * rule in RoomRules costs more to keep than this one — they live in the CRDT,
 * where the server would have to start refusing document updates.
 *
 * The refusal is spoken rather than silent. A button that does nothing is a bug
 * report; a button that says why is a rule.
 */
function mayRun(sessionId: string, payload: TokenPayload, ws: WebSocket): boolean {
  if (allowsRun(getRules(sessionId).run, payload.role, 'one')) return true
  send(ws, {
    t: 'error',
    message: 'Only the teacher runs cells in this seminar.',
  })
  return false
}

/**
 * А это — про весь лист сразу, и оно отдельное от предыдущего.
 *
 * Ядро одно, и разница между «двадцать человек считают» и «двадцать человек
 * забили очередь на восемьсот ячеек» ровно здесь. «По одной» разрешает нажать
 * на ячейке и запрещает Run All.
 */
function mayBulkRun(sessionId: string, payload: TokenPayload, ws: WebSocket): boolean {
  if (allowsRun(getRules(sessionId).run, payload.role, 'bulk')) return true
  send(ws, {
    t: 'error',
    message: 'В этом семинаре весь лист запускает преподаватель — запускайте по одной ячейке.',
  })
  return false
}

/** Право по простому правилу, с одной фразой на отказ. */
function may(rule: Who, payload: TokenPayload, ws: WebSocket, message: string): boolean {
  if (allows(rule, payload.role)) return true
  send(ws, { t: 'error', message })
  return false
}

/**
 * Поставить в очередь и, если что-то не поместилось, сказать это один раз.
 *
 * Потолок берётся из правила: «по одной» — одна ячейка на человека
 * одновременно. Это и делает правило границей, а не счётчиком нажатий:
 * скриптовый цикл получает одну ячейку в очереди и одну фразу.
 */
function queue(ws: WebSocket, sessionId: string, payload: TokenPayload, ids: string[]): void {
  if (ids.length === 0) return
  const refused = requestRun(
    sessionId,
    ids,
    displayName(sessionId, payload.participantId),
    payload.participantId,
    runQueueCap(getRules(sessionId).run, payload.role),
  )
  if (refused > 0) {
    send(ws, {
      t: 'error',
      message: 'В этом семинаре считают по одной ячейке — ваша уже в очереди.',
    })
  }
}

/**
 * Почему путь не годится — теми же словами, что и в поле ввода панели.
 *
 * Отказ приходит на последний сегмент: остальные человек не набирал, они
 * пришли из дерева, и жаловаться на них значило бы указывать не туда.
 */
function refusedPath(raw: unknown): string {
  const shown = typeof raw === 'string' ? raw : ''
  const last = shown.split('/').filter(Boolean).pop() ?? ''
  if (!last) return 'Имя не может быть пустым.'
  if (shown.split('/').filter(Boolean).length > MAX_DEPTH) {
    return `Слишком глубоко: папок в папке бывает не больше ${MAX_DEPTH}.`
  }
  return whySegmentRefused(last)
}

/** Что сказать, когда путь годится, а сделать всё равно не вышло. */
function treeTrouble(outcome: TreeResult, path: string): string {
  const base = baseOf(path)
  if (outcome === 'exists') return `«${base}» в этой папке уже есть.`
  if (outcome === 'missing') return `«${base}» в комнате больше нет.`
  if (outcome === 'bad-name') return whySegmentRefused(base)
  return `«${base}» сейчас занят — попробуйте ещё раз через секунду.`
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined
}

/**
 * Разбор одного сообщения управляющего сокета.
 *
 * Экспортируется ради теста: таблица прав живёт здесь, и проверять её через
 * настоящий сокет значило бы поднимать ядро ради того, чтобы убедиться, что до
 * ядра не дошло. Каждый отказ отвечает раньше всякого действия.
 */
export function dispatch(
  ws: WebSocket,
  sessionId: string,
  payload: TokenPayload,
  message: ControlClientMessage,
): void {
  switch (message.t) {
    case 'ping':
      // Пульс раз в 25 секунд — и заодно самый частый повод заметить ячейку,
      // которую документ считает работающей, а сервер о ней не знает. Это то,
      // что ограничивает жизнь такого призрака одним ударом пульса, а не
      // «пока кто-нибудь что-нибудь не нажмёт». Проход читает по одному ключу
      // на ячейку и пишет только там, где документ неправ.
      sweepOrphanRuns(sessionId)
      // Часы сервера в ответ: по ним браузер считает свою поправку и не
      // показывает «40.0s» на только что запущенной ячейке. См. session.svelte.ts.
      send(ws, { t: 'pong', now: Date.now() })
      return

    case 'run': {
      const id = optionalId(message.cellId)
      if (!id) return
      if (!mayRun(sessionId, payload, ws)) return
      queue(ws, sessionId, payload, [id])
      return
    }

    case 'cancel': {
      const id = optionalId(message.cellId)
      if (!id) return
      // Silent when there was nothing of theirs waiting: two people pressing
      // cancel on the same cell is a race, not an error worth a message.
      cancelRun(sessionId, [id], payload.participantId, payload.role === 'host')
      return
    }

    case 'runAll': {
      if (!mayRun(sessionId, payload, ws)) return
      if (!mayBulkRun(sessionId, payload, ws)) return
      queue(ws, sessionId, payload, codeCellIds(sessionId))
      return
    }

    case 'runAbove': {
      const id = optionalId(message.cellId)
      if (!id) return
      if (!mayRun(sessionId, payload, ws)) return
      if (!mayBulkRun(sessionId, payload, ws)) return
      queue(ws, sessionId, payload, codeCellIds(sessionId, id))
      return
    }

    case 'interrupt': {
      /*
       * The host can always stop the kernel. So can whoever started the cell
       * that is running: they are stopping their own work, only one cell runs
       * at a time, and a seminar with no teacher in the room otherwise has no
       * way at all to end a loop that will not end itself.
       *
       * By participant id, not by name — two students called Anna are two
       * people, and a name is not a credential.
       */
      if (payload.role !== 'host' && !startedTheRunningCell(sessionId, payload.participantId)) {
        send(ws, {
          t: 'error',
          message: 'Only the host, or whoever started the running cell, can interrupt the kernel.',
        })
        return
      }
      /*
       * Нажатие на ячейке называет свою цель, комнатное — нет.
       *
       * Кнопка на ячейке нарисована по состоянию документа, а документ отстаёт
       * от сервера на круг: нажатие в промежутке между двумя ячейками Run All
       * попадало в ветку «ничего не выполняется» и выносило очередь всей
       * комнаты. Право проверено выше и по-прежнему по среде исполнения, а не
       * по документу: имя цели ничего не разрешает, оно только уточняет.
       */
      /*
       * Безымянное нажатие выносит очередь целиком — включая пачки, которые
       * поставили туда другие, под тем же правом, что и «остановить свою
       * ячейку». Это не право, а поведение: у себя останавливай что угодно,
       * чужие пачки не трогай.
       */
      const target = optionalId(message.cellId)
      if (!target && payload.role !== 'host' && !queueIsOnly(sessionId, payload.participantId)) {
        send(ws, {
          t: 'error',
          message: 'В очереди ячейки других — остановите свою, нажав на ней.',
        })
        return
      }
      void interruptSession(sessionId, target).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, 'Could not interrupt the kernel.'),
        })
      })
      return
    }

    case 'restart': {
      // Перезапуск сбрасывает все переменные у всей комнаты, поэтому по
      // умолчанию он преподавательский; но комната, где работают вдвоём,
      // вправе решить иначе.
      if (!may(getRules(sessionId).restart, payload, ws, 'Only the host can restart the kernel.')) {
        return
      }
      void restartSession(sessionId, displayName(sessionId, payload.participantId)).catch(
        (err: unknown) => {
          send(ws, {
            t: 'error',
            message: reason(err, 'Could not restart the kernel.'),
          })
        },
      )
      return
    }

    case 'clearOutputs': {
      /*
       * Своя ячейка и вся доска — разные действия, и правила у них разные.
       * Иначе «стирать всё — преподавателю» запрещало бы студенту прибрать за
       * собой в собственной ячейке, чего никто не имел в виду.
       */
      const one = optionalId(message.cellId)
      const rules = getRules(sessionId)
      const allowed = one
        ? may(rules.edit, payload, ws, 'В этом семинаре тетрадь принадлежит преподавателю.')
        : may(rules.wipe, payload, ws, 'Стирать всю доску здесь может преподаватель.')
      if (!allowed) return
      clearOutputs(sessionId, one)
      return
    }

    /**
     * Поставить документ на общий экран.
     *
     * Смотреть и листать самому может любой всегда — файл комнаты и так
     * скачивается кем угодно из неё. Право здесь про другое: про общий экран.
     */
    case 'board:open': {
      if (
        !may(
          getRules(sessionId).board,
          payload,
          ws,
          'Ставить документ на общий экран в этом семинаре может преподаватель.',
        )
      ) {
        return
      }
      const name = typeof message.name === 'string' ? message.name : ''
      // Существование проверяется здесь, а не у смотрящего: иначе комната
      // получит имя, которого нет, и двадцать человек увидят пустую область.
      if (!name || !listFiles(sessionId).some((file) => !file.dir && file.path === name)) {
        send(ws, { t: 'error', message: 'Такого файла в комнате нет.' })
        return
      }
      setBoard(sessionId, name)
      return
    }

    case 'board:close': {
      if (
        !may(
          getRules(sessionId).board,
          payload,
          ws,
          'Убрать документ с общего экрана в этом семинаре может преподаватель.',
        )
      ) {
        return
      }
      setBoard(sessionId, null)
      return
    }

    /*
     * Правка дерева файлов. Четыре глагола и две границы между ними.
     *
     * Завести — по правилу `files`, тому же, по которому файл загружают: и то и
     * другое ДОБАВЛЯЕТ, и открытая комната, куда каждый кладёт своё решение, —
     * обычный семинар. Убрать и переименовать — преподавательские, потому что
     * оба УБИРАЮТ: старого пути после переименования нет ровно так же, как нет
     * удалённого файла, и раздатка, которую класс разбирает, исчезает у всех
     * одинаково. Это не новое ограничение — удаление было правом
     * преподавателя и раньше.
     */
    case 'tree:mkdir':
    case 'tree:new': {
      if (
        !may(
          getRules(sessionId).files,
          payload,
          ws,
          'Заводить файлы в этом семинаре может преподаватель.',
        )
      ) {
        return
      }
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      const outcome =
        message.t === 'tree:mkdir' ? makeDir(sessionId, wanted) : makeFile(sessionId, wanted)
      if (outcome !== 'ok') {
        send(ws, { t: 'error', message: treeTrouble(outcome, wanted) })
        return
      }
      broadcastFiles(sessionId)
      return
    }

    case 'tree:move': {
      if (payload.role !== 'host') {
        send(ws, {
          t: 'error',
          message: 'Переименовать файл в комнате может преподаватель.',
        })
        return
      }
      const from = normalizePath(typeof message.from === 'string' ? message.from : '')
      const to = normalizePath(typeof message.to === 'string' ? message.to : '')
      if (!from || !to) {
        send(ws, { t: 'error', message: refusedPath(from ? message.to : message.from) })
        return
      }
      const outcome = movePath(sessionId, from, to)
      if (outcome !== 'ok') {
        send(ws, { t: 'error', message: treeTrouble(outcome, to) })
        return
      }
      // Документ старого пути больше ни на что не смотрит: у него на диске
      // ничего нет, и следующее сохранение воскресило бы файл под прежним
      // именем. Наблюдатель заметит это сам, но не раньше двух секунд — а
      // вкладки, открытые на нём, должны узнать сразу.
      forgetFile(sessionId, from)
      if (boardOf(sessionId) === from) setBoard(sessionId, to)
      broadcastFiles(sessionId)
      return
    }

    case 'tree:remove': {
      if (payload.role !== 'host') {
        send(ws, {
          t: 'error',
          message: 'Убрать файл из комнаты может преподаватель.',
        })
        return
      }
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      if (!deleteFile(sessionId, wanted)) {
        send(ws, { t: 'error', message: 'Этого файла в комнате уже нет.' })
        return
      }
      forgetFile(sessionId, wanted)
      forgetMissingBoard(sessionId)
      broadcastFiles(sessionId)
      return
    }

    /*
     * Запуск скрипта. Право — то же, что у ячейки: это тот же контейнер, тот же
     * Python и та же чужая машина. Разница только в том, что вывод идёт в
     * терминал, а не в ячейку.
     */
    case 'file:run': {
      if (!mayRun(sessionId, payload, ws)) return
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      const runner = wanted ? runnerFor(wanted) : null
      if (!wanted || !runner) {
        send(ws, { t: 'error', message: 'Этот файл нечем запустить.' })
        return
      }
      if (!statPath(sessionId, wanted)) {
        send(ws, { t: 'error', message: 'Этого файла в комнате уже нет.' })
        return
      }
      /*
       * Кавычки одинарные с экранированием: имя файла набирает человек, и в нём
       * бывает пробел, скобка и апостроф. Строка уходит в ту же оболочку, что и
       * всё, что люди набирают в терминале руками, — и разница в том, что эту
       * строку человек не набирал и увидеть перед запуском не мог.
       */
      const quoted = `'${wanted.replace(/'/g, `'\\''`)}'`
      runCommand(
        sessionId,
        runner === 'python' ? `python -u ${quoted}` : `bash ${quoted}`,
        sender(sessionId, payload.participantId),
      )
      return
    }

    /*
     * Перестановка ячейки — серверная операция, и это вынужденно: см.
     * `collab/ops.ts`. Право проверяется здесь, а не в классификаторе, потому
     * что в документе этого глагола больше нет вовсе.
     */
    /*
     * Отменить ход оракула: вернуть файлы к тому, что было до него.
     *
     * Право то же, что и у самого режима «сделать»: кто мог его запустить, тот
     * может и отменить. Отдельного правила здесь не заводится — «разрешено
     * начинать, но не разрешено откатывать» было бы худшей из возможных пар.
     */
    case 'ai:undo': {
      if (!allowsAgent(getRules(sessionId).agent, payload.role)) {
        send(ws, { t: 'error', message: 'Отменять ход оракула здесь может преподаватель.' })
        return
      }
      const entryId = optionalId(message.entryId)
      if (!entryId) return
      const touched = undoTurn(sessionId, entryId, displayName(sessionId, payload.participantId))
      if (touched === null) {
        send(ws, {
          t: 'error',
          message:
            'Этот ход уже нельзя отменить: сервер помнит прежние файлы только до перезапуска.',
        })
      }
      return
    }

    case 'cells:move': {
      const rules = getRules(sessionId)
      if (!allowsStructure(rules.structure, payload.role, 'move')) {
        send(ws, {
          t: 'error',
          message: 'В этом семинаре порядок ячеек меняет преподаватель.',
        })
        return
      }
      const id = typeof message.cellId === 'string' ? message.cellId : ''
      const direction =
        message.direction === -1 || message.direction === 1 ? message.direction : null
      if (!id || direction === null) return
      // От имени нажавшего: у версии в истории должен быть автор.
      const { doc } = getSessionDoc(sessionId)
      applyOnBehalf(sessionId, payload.participantId, () => {
        moveInCells(doc, id, direction)
      })
      return
    }

    /*
     * Решение по предложению оракула принимает сервер.
     *
     * Проверка «ещё открыто» внутри транзакции спасала от двух нажатий в одной
     * вкладке и не спасала от двух браузеров: каждый читал в своей копии
     * `'open'`, каждый писал, и Yjs добросовестно сливал обе правки — ячейка
     * получала патч дважды. У сервера копия одна, и сообщения он разбирает по
     * очереди: второе видит то, что поставило первое.
     *
     * Имя берётся из соединения, а не из сообщения: в документе будет написано,
     * кто принял, и написать туда чужое имя нельзя.
     */
    case 'ai:decide': {
      const entryId = typeof message.entryId === 'string' ? message.entryId : ''
      if (!entryId) return
      const { doc } = getSessionDoc(sessionId)
      const entry = findChatEntry(doc, entryId)
      if (!entry) return
      if (
        message.accept &&
        !may(
          getRules(sessionId).edit,
          payload,
          ws,
          'Применить правку оракула здесь может преподаватель — спросить его можно по-прежнему.',
        )
      ) {
        // Отклонить может кто угодно: снятая плашка ничего не разрушает.
        return
      }
      const who = displayName(sessionId, payload.participantId)
      /*
       * От имени нажавшего, а не от имени сервера.
       *
       * Приняв патч, сервер переписывает текст ячейки — это правка документа,
       * и в истории у неё должен быть автор. Без этого версия оказывалась
       * ничьей: строка читалась как «the room», хотя нажал конкретный человек,
       * и Ctrl+Z у него самого до собственной правки не доставал.
       */
      applyOnBehalf(sessionId, payload.participantId, () => {
        if (message.accept) acceptPatch(doc, entry, who)
        else rejectPatch(doc, entry, who)
      })
      return
    }

    case 'input': {
      /*
       * Отвечает тот, чья ячейка спрашивает, — или преподаватель. Та же форма,
       * что у «остановить», и по той же причине: приглашение ко вводу живёт в
       * документе, потому что его должна видеть комната, — но видеть и
       * отвечать не одно и то же, а `input()` под паролем тем более.
       */
      if (payload.role !== 'host' && !startedTheRunningCell(sessionId, payload.participantId)) {
        send(ws, {
          t: 'error',
          message: 'Ответить может тот, чья ячейка спрашивает.',
        })
        return
      }
      const value = typeof message.value === 'string' ? message.value : ''
      void answerInput(sessionId, value, optionalId(message.cellId)).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, 'Could not send that to the cell.'),
        })
      })
      return
    }

    case 'format': {
      /*
       * Строже обоих соседей: black и переписывает каждую ячейку с кодом, и
       * выполняется на общем ядре. Хватило бы одного из двух, чтобы спросить.
       */
      if (
        !may(
          getRules(sessionId).edit,
          payload,
          ws,
          'В этом семинаре тетрадь принадлежит преподавателю.',
        )
      ) {
        return
      }
      if (!mayBulkRun(sessionId, payload, ws)) return
      /*
       * The result goes to the terminal transcript rather than back down this
       * socket: everybody's notebook just changed under them, so everybody
       * deserves the sentence explaining it — not only whoever pressed the
       * button. It is also the one place that can say "three cells were left
       * alone", which is the part somebody will want to check.
       */
      void formatSession(sessionId)
        .then((outcome) => {
          if (outcome.error) return
          if (outcome.changed === 0 && outcome.skipped === 0) {
            kernelNote(sessionId, 'Formatted with black — everything was already in shape.')
            return
          }
          const parts = [
            `${outcome.changed} ${outcome.changed === 1 ? 'cell' : 'cells'} reformatted`,
          ]
          if (outcome.skipped > 0) {
            parts.push(
              `${outcome.skipped} left alone (a magic, a shell line, or code mid-sentence — black could not read them)`,
            )
          }
          kernelNote(
            sessionId,
            `Formatted with black, ${LINE_LENGTH} columns: ${parts.join('; ')}.`,
          )
        })
        .catch((err: unknown) => {
          send(ws, {
            t: 'error',
            message: reason(err, 'Could not format the notebook.'),
          })
        })
      return
    }

    case 'term:open': {
      void openTerminal(sessionId).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, 'Could not open the terminal.'),
        })
      })
      return
    }

    case 'term:run': {
      const command = typeof message.command === 'string' ? message.command : ''
      if (command.trim().length === 0) return
      if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
        send(ws, {
          t: 'error',
          message: `That command is over ${MAX_COMMAND_BYTES.toLocaleString('en-GB')} characters. Put it in a file and run the file.`,
        })
        return
      }
      runCommand(sessionId, command, sender(sessionId, payload.participantId))
      return
    }

    case 'term:interrupt': {
      /*
       * Same rule as the kernel's interrupt, and for the same reason: Ctrl+C
       * throws away every command still waiting, including other people's. The
       * shell is shared, so whoever's command is running may stop it, and the
       * host may stop anything.
       */
      if (payload.role !== 'host' && !typedRunningCommand(sessionId, payload.participantId)) {
        send(ws, {
          t: 'error',
          message: 'Only the host, or whoever typed the running command, can stop the terminal.',
        })
        return
      }
      /*
       * Хост сбрасывает всю очередь, остальные — только своё.
       *
       * У хоста кнопка означает «прекратить в этой комнате всё» и всегда
       * означала. У студента она означает «останови мою зависшую команду», и
       * раньше означала то же, что у хоста: прервав свой `pip install`, он
       * молча уносил всё, что успел поставить в очередь преподаватель.
       */
      interruptTerminal(
        sessionId,
        displayName(sessionId, payload.participantId),
        payload.role === 'host' ? undefined : payload.participantId,
      )
      return
    }

    case 'term:clear': {
      if (
        !may(
          getRules(sessionId).wipe,
          payload,
          ws,
          'Only the host can clear the terminal — that history belongs to the room.',
        )
      ) {
        return
      }
      clearTerminal(sessionId)
      return
    }

    case 'term:close': {
      // Закрыть оболочку — то же, что стереть расшифровку: она общая, и гасит
      // её тот же, кто вправе стирать общее.
      if (!may(getRules(sessionId).wipe, payload, ws, 'Only the host can close the terminal.')) {
        return
      }
      void closeTerminal(sessionId).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, 'Could not close the terminal.'),
        })
      })
      return
    }
  }
}

function reason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/* --------------------------------------------------------------- socket */

export function handleControlSocket(ws: WebSocket, sessionId: string, payload: TokenPayload): void {
  let room = rooms.get(sessionId)
  if (!room) {
    room = { sockets: new Set<WebSocket>(), unwatch: () => {} }
    rooms.set(sessionId, room)
    // Attach after the room exists, so the first status change has somewhere to go.
    room.unwatch = watchKernelStatus(sessionId)
  }
  room.sockets.add(ws)
  owner.set(ws, payload.participantId)

  // Before anything else: the browser gates its own interrupt/restart controls
  // on this, and the token it holds may say something staler than the truth.
  send(ws, { t: 'role', role: payload.role })
  /*
   * И правила — здесь же, а не только при их изменении.
   *
   * Иначе клиент, чей управляющий сокет моргнул поперёк смены правила, живёт со
   * старыми правилами до конца пары: слой погашенных кнопок отказывает ровно
   * тогда, когда он всего нужнее, и человек упирается в отказы сервера вместо
   * того, чтобы видеть, чего в этой комнате нельзя.
   */
  send(ws, { t: 'rules', rules: getRules(sessionId) })
  /*
   * И что комната смотрит сейчас. Без этой строки человек, зашедший в середине
   * занятия, не узнает про открытый документ, пока преподаватель его не
   * переоткроет, — то есть, скорее всего, никогда.
   */
  send(ws, { t: 'board', open: boardOf(sessionId) })

  let missedPongs = 0
  const pingTimer = setInterval(() => {
    if (missedPongs >= MAX_MISSED_PONGS) {
      ws.terminate()
      return
    }
    missedPongs++
    try {
      ws.ping()
    } catch {
      ws.terminate()
    }
  }, PING_INTERVAL_MS)

  const drop = () => {
    clearInterval(pingTimer)
    const current = rooms.get(sessionId)
    if (!current) return
    current.sockets.delete(ws)
    if (current.sockets.size === 0) {
      current.unwatch()
      rooms.delete(sessionId)
    }
  }

  ws.on('pong', () => {
    missedPongs = 0
  })

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return
    const message = parse(data)
    if (!message) return
    try {
      dispatch(ws, sessionId, payload, message)
    } catch (err) {
      // One bad request costs that click, never the seminar.
      console.error(`[control ${sessionId}] ${message.t} failed:`, reason(err, 'unknown error'))
      send(ws, { t: 'error', message: reason(err, 'That did not work.') })
    }
  })

  ws.on('close', drop)
  ws.on('error', drop)

  // Переподключившаяся вкладка — это ровно тот, кто приносит с собой ячейку,
  // «работающую» в процессе, которого больше нет. Один проход на подключение.
  sweepOrphanRuns(sessionId)
  send(ws, { t: 'ready', kernel: kernelStatus(sessionId) })
  send(ws, { t: 'terminal', status: terminalPhase(sessionId) })
  let files: FileEntry[]
  try {
    files = listFiles(sessionId)
  } catch {
    files = []
  }
  send(ws, { t: 'files', files })
}
