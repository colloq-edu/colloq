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
 * The terminal splits the same way. Opening it is open to everyone — it is the
 * room's shell, and a student who needs a library should be able to install it.
 * Clearing and closing are host-only, because both destroy something the whole
 * room can see: shared history, and the shell itself.
 *
 * А набранная в нём команда идёт под тем же правилом, что и ячейка: `python
 * train.py` в оболочке — это тот же контейнер и то же процессорное время, что и
 * Run над файлом, и комната, где кнопка «Запустить» погашена словами «Запускает
 * преподаватель», не может разрешать то же самое строкой ниже. При умолчании
 * (`run: 'room'`) это по-прежнему открыто всем.
 */
import { WebSocket, type RawData } from 'ws'
import {
  acceptPatch,
  allCellArrays,
  bookList,
  cellId,
  cellLock,
  cellsAt,
  cellSource,
  cellType,
  councilSettingsOf,
  DEFAULT_COUNCIL,
  findCell,
  findChatEntry,
  getCells,
  getMeta,
  isCellOpen,
  openValueFor,
  readCouncilSettings,
  rejectPatch,
  replaceText,
  type CellLock,
  type CouncilSettings,
  type KernelStatus,
} from '@shared/notebook'
import { colorForId } from '@shared/protocol'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilAttempt,
  CouncilRun,
  Participant,
  ParticipantRole,
} from '@shared/protocol'
import type { TokenPayload } from './auth.js'
import {
  applyOnBehalf,
  dropParticipant,
  getSessionDoc,
  peekSessionDoc,
  onCellsRemoved,
  onRefusal,
} from './collab/index.js'
import { moveInCells } from './collab/ops.js'
import { LINE_LENGTH } from './kernel/format.js'
import {
  actsAfterClass,
  allows,
  allowsAgent,
  allowsRun,
  allowsStructure,
  CLASS_IS_OVER,
  mayEditCell,
  mayLeadCouncil,
  mayRunCell,
  mayRunCouncil,
  mayWriteCouncil,
  runQueueCap,
  type Who,
} from '@shared/rules'
import {
  finishedAt,
  getParticipant,
  getRules,
  isFinished,
  moveNotesTo,
  notesOf,
  setFinished,
  setNote,
  storedRules,
} from './db.js'
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
  councilQueued,
  councilQueuePosition,
  queueIsOnly,
  requestCouncilRun,
  startedTheRunningCell,
} from './kernel/index.js'
import {
  attemptFor,
  attemptOf,
  attemptsOf,
  boardFor,
  cellsOfParticipant,
  cellsWithAttempts,
  countFor,
  countsFor,
  discardCouncil,
  mineFor,
  purgeAttempts,
  recordRun,
  saveDraft,
  setMark,
  setReply,
  setShown,
  submitAttempt,
  withdrawAttempt,
} from './council.js'
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
  listTree,
  makeDir,
  makeFile,
  movePath,
  statPath,
  type FileTree,
  type TreeResult,
} from './workspace.js'
import {
  MAX_DEPTH,
  MAX_PATH,
  baseOf,
  isInside,
  kindOf,
  normalizePath,
  parentOf,
  runnerFor,
  whySegmentRefused,
} from '@shared/paths'
import { flushFile, forgetFile, onFileSaved } from './collab/files.js'
import {
  addInk,
  clearInk,
  eraseInk,
  forgetLecture,
  handOver,
  inkOf,
  isPresenter,
  lectureOf,
  moveLecture,
  setBlank,
  startLecture,
  stopLecture,
  turnTo,
  undoInk,
} from './lecture.js'
import {
  createBook,
  dropBook,
  forgetMissingBooks,
  moveBook,
  onBooksWritten,
  openBook,
} from './collab/books.js'
import { stopAll, undoTurn } from './ai/agent.js'
import { onCouncilOracle } from './ai/council.js'

/** Same reason as the collab socket: stay under the usual 30s idle timeout. */
const PING_INTERVAL_MS = 25_000
/** A socket that ignores this many consecutive pings is a closed laptop lid. */
const MAX_MISSED_PONGS = 2
/**
 * Кадры управляющего сокета маленькие по устройству — кроме одного.
 *
 * Снимок попытки консилиума (`council:draft`) везёт код целиком, и восьми
 * килобайт ему мало: сотня строк с комментариями по-русски — это уже два
 * байта на букву. Потолок кадра поднят до того, что вмещает `MAX_ATTEMPT_CHARS`
 * кириллицей вместе с обвязкой; всё прочее по-прежнему в разы меньше.
 */
const MAX_FRAME_BYTES = 32 * 1024
/**
 * Попытка — это ячейка, а не файл: сотни строк в ней не бывает. Отказ вслух,
 * как у заметки: обрезанный молча код на экране выглядит целым.
 */
const MAX_ATTEMPT_CHARS = 8000
/** Ответ студенту — абзац, как заметка к странице. */
const MAX_REPLY_CHARS = 3000
/** A shell command, not a shell script: anything longer is a paste accident. */
const MAX_COMMAND_BYTES = 4096
/**
 * Речь к одной странице — абзац, а не глава.
 *
 * Три тысячи знаков стоят не от вкуса, а от потолка кадра: кириллица в UTF-8 —
 * два байта, шесть тысяч байт текста плюс путь и обвязка укладываются в 8192, а
 * кадр толще `parse` выбрасывает МОЛЧА — ни ошибки, ни строки в журнале.
 * Страница речи, исчезнувшая без единого слова посреди пары, — худшее, что этот
 * провод может сделать, поэтому потолок назван вслух и отказ на нём говорящий.
 */
const MAX_NOTE_CHARS = 3000

/**
 * Происхождение записи, которую сервер делает от своего имени.
 *
 * Та же строка, что в collab/index.ts, и это не совпадение: наблюдатели за
 * документом пропускают собственные записи сервера по ней. Серверные поля
 * ячейки (`state`, `outputs`, а теперь и `open`) пишутся так же — у них нет
 * автора, потому что их никто не набирал.
 */
const ORIGIN = 'server'

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
  /*
   * Доска и лекция — до всякой проверки на сокеты, и это не порядок ради
   * порядка: `rooms` чистится, как только уходит последний человек, а доска и
   * чернила намеренно переживают его уход. Преподаватель закрыл ноутбук, не
   * нажав «Закончить», а вечером удалил семинар — ниже возвращаться уже нечему,
   * и двести исписанных страниц остались бы в памяти процесса до перезапуска.
   */
  boards.delete(sessionId)
  forgetLecture(sessionId)
  // И попытки консилиума: они в базе, а не в документе, и снос документа их
  // не заденет — а лежать под ключом снесённой комнаты им незачем.
  discardCouncil(sessionId)
  forgetBoards(sessionId)
  const waiting = filesPending.get(sessionId)
  if (waiting) {
    clearTimeout(waiting)
    filesPending.delete(sessionId)
  }
  const room = rooms.get(sessionId)
  if (!room) return
  rooms.delete(sessionId)
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

/**
 * Выставить забаненного — сейчас, а не при следующем заходе.
 *
 * Проверка на рукопожатии закрывает дверь тому, кто стучится; забанили обычно
 * того, кто уже сидит внутри, и без этой строки он спокойно дописывает в
 * тетради до конца пары — его сокеты открылись раньше бана и ничего о нём не
 * знают.
 *
 * Кадр уходит ДО закрытия. Иначе вкладка видит обрыв связи и молча уходит
 * переподключаться, показывая «нет соединения» там, где надо показать причину
 * и срок; после кадра она знает, что произошло, и не стучится обратно.
 *
 * Точечно, а не `closeControlRoom`: комната продолжает занятие. И оба провода
 * сразу — управляющий держит нажатия, общий документ держит текст, и закрыть
 * один, оставив другой, значит выгнать наполовину.
 */
export function evictBanned(sessionId: string, participantId: string, until: number): void {
  tell(sessionId, participantId, { t: 'banned', until })
  const room = rooms.get(sessionId)
  if (room) {
    // Копия набора: обработчик закрытия правит его же.
    for (const ws of [...room.sockets]) {
      if (owner.get(ws) !== participantId) continue
      try {
        ws.close(1008, 'banned from this seminar')
      } catch {
        /* already gone */
      }
    }
  }
  dropParticipant(sessionId, participantId)
}

export function broadcastFiles(sessionId: string): void {
  const room = rooms.get(sessionId)
  if (!room || room.sockets.size === 0) return
  /*
   * Дерево едет вместе с признаком обрезки: список, упёршийся в потолок обхода,
   * — это не «в комнате столько файлов». Панель говорит это вслух, иначе
   * человек ищет глазами файл, который на диске лежит. Признак шлётся всегда, и
   * `false` в нём такой же ответ, как `true`: иначе комната, один раз увидевшая
   * обрезку, так и осталась бы с предупреждением после уборки папки.
   */
  let tree: FileTree
  try {
    tree = listTree(sessionId)
  } catch {
    return
  }
  broadcast(sessionId, { t: 'files', files: tree.files, truncated: tree.truncated })
}

/**
 * Столько ждём, прежде чем пересчитывать дерево само по себе.
 *
 * Один список стоит обхода всей папки (readdir и lstat на каждую запись) и
 * кадра каждому сокету. Двадцать человек, правящих по файлу, сохраняются
 * каждые семьсот миллисекунд НЕ ВМЕСТЕ — это до тридцати обходов в секунду и
 * панель файлов, перерисовывающаяся всю пару.
 *
 * Задержка видна только тому, кто ждёт своего же нажатия, — поэтому прямые
 * правки дерева (завели, убрали, переименовали, загрузили) рассылаются сразу,
 * а откладывается лишь то, что случается само: автосохранение, проекция
 * тетради, запись из ячейки.
 */
const FILES_EVERY_MS = 400
const filesPending = new Map<string, NodeJS.Timeout>()

function scheduleFiles(sessionId: string): void {
  if (filesPending.has(sessionId)) return
  const timer = setTimeout(() => {
    filesPending.delete(sessionId)
    broadcastFiles(sessionId)
  }, FILES_EVERY_MS)
  timer.unref?.()
  filesPending.set(sessionId, timer)
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

/**
 * Погасить указку у всей комнаты.
 *
 * Указка нигде не хранится: где она была секунду назад — не факт о лекции, а
 * положение руки, и держится она ровно тем, что кадры идут. Поэтому всякий раз,
 * когда рука пропала, не сказав «off», — лекцию закончили, пульт передали,
 * планшет выгрузили из памяти, — гасить приходится за неё. Иначе красное пятно
 * висит на слайде до конца лекции и показывает туда, где ведущий был минуту
 * назад. Таймаутом это не лечится: неподвижная указка кадров не шлёт вовсе, и
 * таймаут погасил бы штатный показ.
 */
function laserOff(sessionId: string): void {
  broadcast(sessionId, { t: 'laser', at: null })
}

function setBoard(sessionId: string, name: string | null): void {
  if (name === null) boards.delete(sessionId)
  else boards.set(sessionId, name)
  broadcast(sessionId, { t: 'board', open: name })
  /*
   * Лекция идёт по документу на общем экране, и убрать документ — значит
   * закончить лекцию. Иначе комната получает пульт, листающий то, чего никто
   * не видит, и чернила на файле, закрытом у всех.
   */
  const lecture = lectureOf(sessionId)
  if (lecture && lecture.file !== name) {
    stopLecture(sessionId)
    broadcast(sessionId, { t: 'lecture', state: null })
    laserOff(sessionId)
  }
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
  /*
   * Один `lstat` по самому пути, а не поиск в дереве: у обхода есть потолок
   * (см. `truncated` в workspace.ts), и документ, не влезший в список, никуда
   * не пропал. По обрезанному списку доска гасла бы посреди лекции — ровно там,
   * где студент распаковал датасет на две тысячи файлов.
   */
  if (statPath(sessionId, open)?.dir === false) return
  setBoard(sessionId, null)
}

/*
 * Файл лёг на диск — комната узнаёт новый размер и время.
 *
 * Редактор сохраняется сам каждые несколько секунд, и без этой строки панель
 * файлов показывала бы размер, каким он был при открытии вкладки: «0 B» у
 * файла, в котором уже сорок строк.
 */
onFileSaved((sessionId) => scheduleFiles(sessionId))

/*
 * Тетрадь легла на диск — комната узнаёт про файл.
 *
 * Без этого файл тетради появлялся бы в дереве только после чьей-нибудь
 * загрузки: проекция пишется сама, а сказать об этом некому.
 */
onBooksWritten((sessionId) => scheduleFiles(sessionId))

// Registered once, at import: the kernel runtime has no idea who is listening.
onWorkspaceChanged((sessionId) => {
  // Файл тетради могли убрать мимо дерева — `os.remove` в ячейке. Тетрадь без
  // файла — это вкладка, которую нечем закрыть и незачем показывать.
  forgetMissingBooks(sessionId)
  forgetMissingBoard(sessionId)
  scheduleFiles(sessionId)
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

/**
 * С какой ролью сокет подключился — рядом с `owner` и по той же причине.
 *
 * Не `getParticipant(...).role`: в таблице лежит роль, с которой человек вошёл
 * в комнату, а сокет живёт с ЭФФЕКТИВНОЙ (см. `effectiveRole` в index.ts).
 * Преподаватель, вошедший студентом по ссылке в чате и уже залогиненный в
 * панель, в таблице до сих пор участник — спросить её значило бы отказать ему в
 * его собственных заметках на его собственной лекции.
 */
const rank = new WeakMap<WebSocket, ParticipantRole>()

/**
 * Сказать всем преподавателям комнаты — и никому больше.
 *
 * Единственная рассылка в этом файле, у которой адресат уже комнаты, и это не
 * осторожность, а суть заметок: «здесь спросить, кто помнит формулу Байеса;
 * если молчат — вывести на доске» — это речь преподавателя самому себе, и
 * `broadcast` раздал бы её двадцати студентам вместе с ответом на вопрос,
 * который ещё не задан.
 *
 * И не `tell`: у семинара бывает двое ведущих, и правку, сделанную на ноутбуке
 * первого, обязан увидеть планшет второго. Один и тот же преподаватель с двух
 * устройств — тоже сюда: планшет входит по ключу ТЕМ ЖЕ участником, так что
 * `tell` покрыл бы только его, а второго преподавателя — нет.
 */
function toHosts(sessionId: string, file: string, message: ControlServerMessage): void {
  const room = rooms.get(sessionId)
  if (!room) return
  const frame = JSON.stringify(message)
  for (const ws of room.sockets) {
    if (ws.readyState !== WebSocket.OPEN || rank.get(ws) !== 'host') continue
    // И только тем, кто спрашивал про ЭТОТ документ.
    if (notesOpen.get(ws) !== file) continue
    try {
      ws.send(frame)
    } catch {
      /* dropped; the close handler will clean it up */
    }
  }
}

/**
 * Какой документ этот сокет спрашивал заметками.
 *
 * Роли мало. Ведущий входит на планшет по ключу тем же участником, и обе его
 * вкладки — пульт и ПРОЕКЦИЯ на кафедральном ноутбуке — одинаково «хосты». Речь
 * преподавателя самому себе не должна доезжать до машины, которая стоит
 * раскрытой перед аудиторией, даже если на экран она это не выводит: файл,
 * которого там нет в памяти, невозможно случайно показать.
 */
const notesOpen = new WeakMap<WebSocket, string>()

/* ------------------------------------------------------------- консилиум */

/**
 * Та же фраза, что у клиента (web/src/lib/may.ts · COUNCIL_CLOSED): отказ
 * сервера и серая кнопка должны говорить одно и то же.
 */
const COUNCIL_CLOSED = 'Консилиум закрыт — текст остался у вас черновиком'

/**
 * Сказать всем преподавателям комнаты — и никому больше.
 *
 * Не `toHosts`: тот отбирает ещё и по документу заметок. Стопка консилиума —
 * речь к пульту преподавателя, какой бы файл он ни открыл, и второй
 * преподаватель на планшете обязан видеть ту же стопку. Проекция на
 * кафедральном ноутбуке тоже хост и тоже получит стопку — не рисовать её на
 * экране решает клиент (протокол · council:count для проектора).
 */
function toTeachers(sessionId: string, message: ControlServerMessage): void {
  const room = rooms.get(sessionId)
  if (!room) return
  let frame: string | null = null
  for (const ws of room.sockets) {
    if (ws.readyState !== WebSocket.OPEN || rank.get(ws) !== 'host') continue
    frame ??= JSON.stringify(message)
    try {
      ws.send(frame)
    } catch {
      /* dropped; the close handler will clean it up */
    }
  }
}

/** Есть ли в комнате хоть один пульт преподавателя — иначе стопку собирать незачем. */
function teachersOnline(sessionId: string): boolean {
  const room = rooms.get(sessionId)
  if (!room) return false
  for (const ws of room.sockets)
    if (rank.get(ws) === 'host' && ws.readyState === WebSocket.OPEN) return true
  return false
}

/**
 * Положение замка и ручки — из документа, где их записал сервер.
 *
 * Ячейки нет — замок закрыт: попытку в неё не принять, а стопка по ней всё ещё
 * собирается (попытки остаются на просмотр), только с закрытым замком.
 */
function councilCellOf(
  sessionId: string,
  id: string,
): { lock: CellLock; settings: CouncilSettings } {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  if (!found) return { lock: 'closed', settings: DEFAULT_COUNCIL }
  return { lock: cellLock(found.cell), settings: councilSettingsOf(found.cell) ?? DEFAULT_COUNCIL }
}

/**
 * Стопка — не чаще, чем раз в это окно на ячейку, и не целиком.
 *
 * Снимки приходят на каждую паузу в наборе от каждого из сотен человек. Дребезг
 * держит частоту: первая перемена уходит сразу (пульт не должен ждать окна на
 * одном нажатии), остальные в окне сливаются в один хвостовой кадр. Размер
 * держит дельта: у каждой попытки в стопке лежит её вывод — до 64 КБ текста и
 * до 2 МБ картинок, — и кадр со всей стопкой из-за одной буквы у одного
 * студента весил бы десятки мегабайт по три раза в секунду. Поэтому перемена
 * везёт только тех, кого коснулась (`council:patch`); вся стопка едет лишь
 * там, где сменилось общее — замок, ручки, оракул — или где стопки у пульта
 * ещё нет (приветственная пачка). Окно копит, кого трогали; «всех» в окне
 * побеждает любой список.
 */
const BOARD_EVERY_MS = 300
interface BoardPending {
  timer: NodeJS.Timeout | null
  last: number
  /** Кого трогали с прошлого кадра; `'all'` — стопку целиком. */
  dirty: Set<string> | 'all'
}
const boardsPending = new Map<string, BoardPending>()

function boardNow(sessionId: string, cellId: string, dirty: Set<string> | 'all'): void {
  if (!teachersOnline(sessionId)) return
  const cell = councilCellOf(sessionId, cellId)
  if (dirty === 'all') {
    toTeachers(sessionId, {
      t: 'council:board',
      cellId,
      board: boardFor(sessionId, cellId, cell),
    })
    return
  }
  if (dirty.size === 0) return
  const attempts: CouncilAttempt[] = []
  const removed: string[] = []
  for (const participantId of dirty) {
    const attempt = attemptFor(sessionId, cellId, participantId)
    if (attempt) attempts.push(attempt)
    else removed.push(participantId)
  }
  toTeachers(sessionId, {
    t: 'council:patch',
    cellId,
    attempts,
    removed,
    counts: countsFor(sessionId, cellId),
    lock: cell.lock,
    settings: cell.settings,
  })
}

/**
 * Стопку — хосту: без `touched` целиком, с ним — только этих людей (тех, кого
 * в стопке уже нет, кадр назовёт в `removed`).
 */
function boardOut(sessionId: string, cellId: string, touched?: readonly string[]): void {
  const key = `${sessionId}\n${cellId}`
  let state = boardsPending.get(key)
  if (!state) {
    state = { timer: null, last: 0, dirty: new Set() }
    boardsPending.set(key, state)
  }
  if (touched === undefined) state.dirty = 'all'
  else if (state.dirty !== 'all') for (const id of touched) state.dirty.add(id)
  // Хвостовой кадр уже назначен — он увезёт и эту перемену.
  if (state.timer) return
  const since = Date.now() - state.last
  if (since >= BOARD_EVERY_MS) {
    flushBoard(sessionId, cellId, state)
    return
  }
  const pending = state
  state.timer = setTimeout(() => {
    pending.timer = null
    flushBoard(sessionId, cellId, pending)
  }, BOARD_EVERY_MS - since)
  state.timer.unref?.()
}

/** Отдать накопленное за окно одним кадром и начать копить заново. */
function flushBoard(sessionId: string, cellId: string, state: BoardPending): void {
  const dirty = state.dirty
  state.dirty = new Set()
  state.last = Date.now()
  boardNow(sessionId, cellId, dirty)
}

/**
 * Стопка хосту — снаружи, для оракула о решениях (routes/council.ts).
 *
 * Имена групп и черновики лежат в `CouncilBoard.oracle`, и после `setOracle`
 * сводка на пульте обновится только со стопкой; сам кадр `council:oracle`
 * маршрут шлёт отдельно.
 */
export function announceCouncilBoard(sessionId: string, cellId: string): void {
  boardOut(sessionId, cellId)
}

/** Отправить отложенные стопки сейчас — ради теста, которому нечего ждать. */
export function flushCouncilBoards(sessionId: string): void {
  for (const [key, state] of boardsPending) {
    if (!key.startsWith(`${sessionId}\n`) || !state.timer) continue
    clearTimeout(state.timer)
    state.timer = null
    flushBoard(sessionId, key.slice(sessionId.length + 1), state)
  }
}

function forgetBoards(sessionId: string): void {
  for (const [key, state] of boardsPending) {
    if (!key.startsWith(`${sessionId}\n`)) continue
    if (state.timer) clearTimeout(state.timer)
    boardsPending.delete(key)
  }
}

/** Свой лист — одному человеку, на все его сокеты. */
function mineOut(sessionId: string, cellId: string, participantId: string): void {
  const message = mineMessage(sessionId, cellId, participantId)
  if (message) tell(sessionId, participantId, message)
}

function mineMessage(
  sessionId: string,
  cellId: string,
  participantId: string,
): ControlServerMessage | null {
  const { lock } = councilCellOf(sessionId, cellId)
  const position = councilQueuePosition(sessionId, cellId, participantId)
  const state = mineFor(
    sessionId,
    cellId,
    participantId,
    lock !== 'council',
    // Ноль — «считается сейчас», и об этом говорит сам `run.state`.
    position !== null && position > 0 ? position : null,
  )
  return state ? { t: 'council:mine', cellId, state } : null
}

/** «N сдали из M» — всей комнате, без текстов. */
function countOut(sessionId: string, cellId: string): void {
  const { submitted, total } = countFor(sessionId, cellId)
  broadcast(sessionId, { t: 'council:count', cellId, submitted, total })
}

/**
 * Очередь сдвинулась — каждому, кто в ней ждёт, новый номер.
 *
 * «Вы 37-й» без этого показывал бы номер на момент нажатия до конца пары.
 */
function tellQueued(sessionId: string): void {
  for (const { cellId, participantId } of councilQueued(sessionId)) {
    mineOut(sessionId, cellId, participantId)
  }
}

/** Все, кому положен свой лист по этой ячейке: онлайн и те, у кого есть попытка. */
function councilAudience(sessionId: string, cellId: string): Set<string> {
  const people = new Set<string>()
  const room = rooms.get(sessionId)
  if (room)
    for (const ws of room.sockets) {
      const who = owner.get(ws)
      if (who) people.add(who)
    }
  for (const attempt of attemptsOf(sessionId, cellId)) people.add(attempt.participantId)
  return people
}

/** Замок сменился — хосту стопка, каждому его лист, комнате счётчик. */
function councilChanged(sessionId: string, cellId: string): void {
  boardOut(sessionId, cellId)
  for (const participantId of councilAudience(sessionId, cellId))
    mineOut(sessionId, cellId, participantId)
  countOut(sessionId, cellId)
}

/** Ячейки, где консилиум идёт сейчас, — по всем тетрадям комнаты. */
function councilCells(sessionId: string): string[] {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return []
  const out: string[] = []
  for (const cells of allCellArrays(doc)) {
    for (const cell of cells.toArray()) if (cellLock(cell) === 'council') out.push(cellId(cell))
  }
  return out
}

/**
 * Приветственная пачка консилиума — тому, кто только что подключился.
 *
 * Хосту — стопки по всем ячейкам, где консилиум идёт или где остались попытки
 * (после закрытия они на просмотр). Каждому — его листы там же, и счётчики.
 * Прямо в этот сокет, не через `tell`: второй вкладке того же человека пачка
 * уже приезжала при её собственном подключении.
 */
function councilWelcome(ws: WebSocket, sessionId: string, payload: TokenPayload): void {
  const cells = new Set<string>([...councilCells(sessionId), ...cellsWithAttempts(sessionId)])
  if (payload.role === 'host') {
    for (const id of cells) {
      send(ws, {
        t: 'council:board',
        cellId: id,
        board: boardFor(sessionId, id, councilCellOf(sessionId, id)),
      })
    }
  }
  const mine = new Set<string>([
    ...councilCells(sessionId),
    ...cellsOfParticipant(sessionId, payload.participantId),
  ])
  for (const id of mine) {
    const message = mineMessage(sessionId, id, payload.participantId)
    if (message) send(ws, message)
  }
  for (const id of cells) {
    const { submitted, total } = countFor(sessionId, id)
    send(ws, { t: 'council:count', cellId: id, submitted, total })
  }
}

/**
 * Убрать попытки забаненного из всех ячеек — и показать хосту стопки без него.
 *
 * Зовётся из routes/bans.ts рядом с purgeQuestions: за спам в общей ленте банят,
 * а попытка в консилиуме — тот же текст перед глазами преподавателя.
 */
export function purgeCouncilOf(sessionId: string, participantId: string): number {
  const cells = cellsOfParticipant(sessionId, participantId)
  const gone = purgeAttempts(sessionId, participantId)
  for (const id of cells) {
    // Попытки уже нет — кадр назовёт человека в `removed`.
    boardOut(sessionId, id, [participantId])
    countOut(sessionId, id)
  }
  return gone
}

/** Ручки консилиума из сообщения — только известные и только булевы. */
function pickSettings(raw: unknown): Partial<CouncilSettings> {
  const out: Partial<CouncilSettings> = {}
  if (!raw || typeof raw !== 'object') return out
  const from = raw as Record<string, unknown>
  if (typeof from.studentRun === 'boolean') out.studentRun = from.studentRun
  if (typeof from.namesOnProjector === 'boolean') out.namesOnProjector = from.namesOnProjector
  return out
}

/*
 * Ячеек больше нет — снять их с выполнения.
 *
 * Убрать можно и ту ячейку, что стоит в очереди: документ этого не запрещает, и
 * запрещать не следует — человек видит ячейку и вправе её убрать. Но очередь
 * живёт именами, и ядро потом честно берёт из неё id, которому не соответствует
 * ничего: Run All обрывается на пустом месте, а `meta.queue` называет ячейки,
 * которых в тетради не найти.
 *
 * `isHost` здесь не про право и не про человека: очередь разбирает сервер,
 * потому что запускать больше нечего, — своё и чужое одинаково. Ячейку, которая
 * СЧИТАЕТСЯ прямо сейчас, прерывает само ядро (`stopIfDeleted` в
 * kernel/index.ts): оно видит ту же правку документа и знает, что у него в
 * работе, а отсюда это было бы вторым SIGINT в ту же секунду.
 */
onCellsRemoved((sessionId, cellIds) => {
  cancelRun(sessionId, cellIds, '', true)
})

onRefusal((sessionId, participantId, refusal) => {
  tell(sessionId, participantId, {
    t: 'refused',
    rule: refusal.rule,
    message: refusal.message,
  })
})

/**
 * Оракул о решениях сменил состояние — сказать пультам.
 *
 * Сам кадр — только преподавателям (сводка читала тексты студентов, на проектор
 * и в зал ей нельзя), а следом стопка: имена групп и черновики ответов лежат в
 * `CouncilBoard.oracle`, и без свежей стопки чипы в сводке остались бы без
 * подписей. Регистрация здесь, а не в routes/council.ts: сокеты преподавателей
 * знает только этот модуль, а импорт control.ts из ai/council.ts замкнул бы
 * модули друг на друга — как и у onRefusal.
 */
onCouncilOracle((sessionId, cellId, oracle) => {
  toTeachers(sessionId, { t: 'council:oracle', cellId, oracle })
  boardOut(sessionId, cellId)
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
 *
 * `null` — «тетрадь названа, а такой в комнате нет». Это не то же самое, что
 * «путь не задан»: без пути подразумевается тетрадь комнаты (так читаются
 * сообщения вкладок, открытых до того, как тетрадей стало несколько), а вот
 * вкладка убранной тетради, не успевшая узнать об этом, нажатием Run All
 * поставила бы в очередь ЧУЖОЙ лист целиком.
 */
function codeCellIds(
  sessionId: string,
  book: string | undefined,
  upToCellId?: string,
): string[] | null {
  const doc = getSessionDoc(sessionId).doc
  const named = book ? cellsAt(doc, book) : null
  if (book && !named) return null
  const cells = named ?? getCells(doc)
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

/** Точка на конце — как у соседних фраз: это законченное предложение. */
const OVER = `${CLASS_IS_OVER}.`

/**
 * Отказ по праву — и одна фраза на все отказы законченного занятия.
 *
 * Права после конца занятия ужесточаются сами: их спрашивают у `getRules`, а
 * та отдаёт действующие (db.ts). А вот слова остались бы прежними — «В этом
 * семинаре запускает преподаватель» посылает человека искать преподавателя,
 * который ничего не менял. Поэтому подмена фразы стоит в одном месте, через
 * которое проходят все отказы по праву: проверка, дописанная завтра, получит
 * её даром, если откажет через этот helper.
 */
function refuse(ws: WebSocket, sessionId: string, payload: TokenPayload, message: string): void {
  send(ws, {
    t: 'error',
    message: actsAfterClass(isFinished(sessionId), payload.role) ? message : OVER,
  })
}

/**
 * Одна фраза на отказ по правилу `run` — и потому она константа.
 *
 * Запуск ячейки теперь спрашивает право, уже зная про замок, и потому называет
 * фразу сам; без общего имени в коде оказалось бы два одинаковых предложения,
 * из которых однажды поправят одно.
 */
const RUN_IS_THE_TEACHERS = 'Only the teacher runs cells in this seminar.'

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
 *
 * `cellOpen` — замок на ячейке: преподаватель открыл вот эту одну, и в ней
 * комната считает даже там, где вообще запускает он. Умолчание `false`, и это
 * важнее, чем кажется: тем же helper'ом спрашивают Run All, запуск файла и
 * команду оболочки, а открытая ячейка ни листа, ни терминала не открывает —
 * она открыта одна и ровно одна.
 */
function mayRun(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  message = RUN_IS_THE_TEACHERS,
  cellOpen = false,
): boolean {
  if (mayRunCell(getRules(sessionId), payload.role, cellOpen, isFinished(sessionId))) return true
  refuse(ws, sessionId, payload, message)
  return false
}

/**
 * Открыта ли эта ячейка комнате.
 *
 * Спрашивается у документа, а не у сообщения: поле пишет сервер (см.
 * `cell:open`), и читать его надо там же, где оно записано. Ячейки нет в
 * комнате — значит и замка нет: право тогда решают обычные правила, и отказ
 * говорит про них, а не про ячейку, которой не существует.
 */
function cellIsOpen(sessionId: string, id: string): boolean {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return found ? isCellOpen(found.cell) : false
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
  refuse(
    ws,
    sessionId,
    payload,
    'В этом семинаре весь лист запускает преподаватель — запускайте по одной ячейке.',
  )
  return false
}

/** Право по простому правилу, с одной фразой на отказ. */
function may(
  sessionId: string,
  rule: Who,
  payload: TokenPayload,
  ws: WebSocket,
  message: string,
): boolean {
  if (allows(rule, payload.role)) return true
  refuse(ws, sessionId, payload, message)
  return false
}

/**
 * Не оборвёт ли это идущую лекцию — и вправе ли этот человек её обрывать.
 *
 * Общий экран и лекция — один и тот же документ (см. `setBoard`), поэтому
 * «поставить другой файл» и «убрать файл» заканчивают лекцию. Само по себе это
 * намеренно, а вот вход в него был открыт настежь: щелчок по `homework.pdf` в
 * панели файлов выглядит как «открыть файл себе» и ничем не отличается от
 * щелчка по любому другому — а стоит сорока минут разметки на проекторе, при
 * всех и без возврата (чернила живут только в памяти). Крестик на вкладке
 * документа лекции — то же самое: он шлёт `board:close`.
 *
 * Поэтому пока лекция идёт, обрывают её только двумя руками: руками ведущего
 * (он и меняет документ, и заканчивает) или явным «Закончить». Всё остальное —
 * отказ словами, и слова называют документ, чтобы человек понял, во что упёрся.
 */
function lectureInTheWay(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  wanted: string | null,
): boolean {
  const going = lectureOf(sessionId)
  if (!going || going.file === wanted || going.by === payload.participantId) return false
  send(ws, {
    t: 'error',
    message: `Идёт лекция по «${baseOf(going.file)}» — сначала закончите её.`,
  })
  return true
}

/**
 * Пульт в руках — и занятие ещё идёт.
 *
 * Ведущий не всегда преподаватель: в комнате с `board: 'room'` студенты по
 * очереди показывают своё, и пульт у студента — не дыра, а смысл настройки.
 * Поэтому после звонка одной роли мало, а `isPresenter` мало тем более: иначе
 * студент-ведущий листает страницы всему залу, рисует и гасит экран в комнате,
 * где все остальные уже только читают.
 *
 * Саму лекцию звонок не гасит — сорок минут разметки живут только в памяти, и
 * терять их нажатием «Закончить занятие» дороже, чем оставить картинку на
 * экране, зрителем в ней участник и так был. Отбирается управление:
 * преподаватель перехватывает пульт тем же `lecture:start` или заканчивает
 * лекцию, как и раньше.
 */
function atTheRemote(sessionId: string, payload: TokenPayload): boolean {
  return (
    isPresenter(sessionId, payload.participantId) &&
    actsAfterClass(isFinished(sessionId), payload.role)
  )
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
 * Одна фраза на потолок глубины — и потому она константа.
 *
 * Её говорят двоим: полю ввода, где набрали слишком длинный путь, и переезду
 * папки, содержимое которой на новом месте ушло бы за восьмой уровень. Причина
 * одна и та же, и разъехаться этим двум предложениям незачем.
 */
const TOO_DEEP = `Слишком глубоко: папок в папке бывает не больше ${MAX_DEPTH}.`

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
  if (shown.split('/').filter(Boolean).length > MAX_DEPTH) return TOO_DEEP
  return whySegmentRefused(last)
}

/**
 * Всё, что лежит внутри этого пути, — считая его самого.
 *
 * Переименовать и убрать можно не только файл: `movePath` переносит каталог
 * целиком, `deleteFile` сносит его со всем содержимым, а правка имени в панели
 * заводится двойным щелчком по любой строке дерева, включая папку. При этом
 * всё, что помнит путь, — открытый в редакторе документ, тетрадь, заметки
 * спикера, лекция и общий экран — знает только точное имя, и без этого списка
 * папку переименовывали бы, а её содержимое оставалось бы жить по старому
 * адресу: тетрадь воскрешала бы папку проекцией, а проектор показывал бы файл,
 * которого нет.
 *
 * Считается ДО правки дерева: после неё спрашивать уже некого.
 */
function pathsInside(sessionId: string, dir: string): string[] {
  const found = new Set<string>([dir])
  try {
    for (const entry of listFiles(sessionId)) {
      if (!entry.dir && isInside(entry.path, dir)) found.add(entry.path)
    }
  } catch {
    /* папку не прочитать — обойдёмся самим путём */
  }
  // И тетради по списку комнаты: у обхода папки есть потолок, а тетрадь,
  // не попавшая в список файлов, — как раз та, чью запись важнее всего увести.
  const doc = peekSessionDoc(sessionId)?.doc
  if (doc) for (const book of bookList(doc)) if (isInside(book.path, dir)) found.add(book.path)
  /*
   * И то, что помнит один-единственный путь наизусть: документ на экране и файл
   * лекции. Довод тот же, что у тетрадей: обход дерева обрезается — по числу
   * строк и по глубине, — а документ, не попавший в список, никуда не делся, он
   * идёт на проекторе прямо сейчас. Спросить их стоит двух чтений из памяти;
   * пропустить — значит оставить проектор на пути, которого после переезда нет,
   * и речь к двадцати четырём страницам под ключом, которого не существует.
   */
  const shown = boardOf(sessionId)
  if (shown && isInside(shown, dir)) found.add(shown)
  const lecture = lectureOf(sessionId)?.file
  if (lecture && isInside(lecture, dir)) found.add(lecture)
  return [...found]
}

/**
 * Что сказать, когда путь годится, а сделать всё равно не вышло.
 *
 * Две стороны, а не одна: у переезда «не нашли» — это про источник, а «занято»
 * — про цель, и одной строкой на оба случая назывался файл, которого человек не
 * трогал: после `a.py` → `b.py` он читал «„b.py“ в комнате больше нет» про имя,
 * которого никогда не было. Там, где заводят новое, обе стороны совпадают, и
 * звать можно с одним путём.
 */
function treeTrouble(outcome: TreeResult, target: string, source = target): string {
  const name = baseOf(target)
  if (outcome === 'exists') {
    /*
     * Место называется, когда оно не то, на которое человек смотрит. Он
     * перетащил файл в соседнюю папку и получил отказ — а «в этой папке» из
     * прежней фразы указывает на ту, ИЗ которой тащил, и одноимённых data.csv
     * в комнате бывает несколько. Переименование на месте оставлено словом в
     * слово: там «эта папка» — ровно та, что открыта.
     */
    const into = parentOf(target)
    if (into === parentOf(source)) return `«${name}» в этой папке уже есть.`
    return into
      ? `«${name}» в папке «${baseOf(into)}» уже есть.`
      : `«${name}» в корне комнаты уже есть.`
  }
  if (outcome === 'missing') return `«${baseOf(source)}» в комнате больше нет.`
  if (outcome === 'too-deep') return TOO_DEEP
  /*
   * Виновата не та запись, которую переставляют, — её путь короток, — а то, что
   * лежит внутри: после переезда путь до него длиннее адресуемого, и открыть,
   * скачать или убрать его поштучно уже нечем. Панель говорит это теми же
   * словами (`tooLong` в tree-move.ts), не дожидаясь круга по сети.
   */
  if (outcome === 'too-long') {
    return `«${baseOf(source)}» не переложить: путь до того, что внутри, стал бы длиннее ${MAX_PATH} символов.`
  }
  // Получить его можно единственным способом: попросить положить внутрь файла
  // (`отчёт.py/данные.csv`). Корень папкой быть не перестаёт, так что имя того,
  // во что не влезло, здесь есть всегда.
  if (outcome === 'not-a-folder') {
    return `«${baseOf(parentOf(target))}» — файл, а не папка: внутрь него ничего не кладут.`
  }
  if (outcome === 'bad-name') return whySegmentRefused(name)
  return `«${baseOf(source)}» сейчас занят — попробуйте ещё раз через секунду.`
}

/**
 * Какую тетрадь называет сообщение.
 *
 * `undefined` — тетрадь комнаты. Так же читается сообщение вкладки, открытой до
 * того, как тетрадей стало несколько: путь в нём просто не проставлен, и
 * подразумевается единственная, которая тогда была.
 */
function bookOf(message: { book?: unknown }): string | undefined {
  return typeof message.book === 'string' && message.book ? message.book : undefined
}

/**
 * Одна фраза на все сообщения, называющие тетрадь, которой в комнате нет.
 *
 * Тетрадь убирают из комнаты, а вкладка у соседа живёт до прихода списка
 * файлов — и нажатие в ней не должно молча попадать в тетрадь комнаты. Вслух,
 * а не молчанием: «Run All ничего не сделал» человек объясняет себе сам, и
 * объясняет неверно.
 */
const NO_SUCH_BOOK = 'Этой тетради в комнате больше нет.'

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
      /*
       * Про ячейку спрашиваем РАНЬШЕ, чем про право: открытый замок и есть то,
       * что делает этот запуск разрешённым, а узнать о нём можно только в
       * документе. Проверка стояла до всякого знания о ячейке и потому не
       * могла его учесть. Отказ при этом остался одной фразой — той же самой.
       */
      if (!mayRun(sessionId, payload, ws, RUN_IS_THE_TEACHERS, cellIsOpen(sessionId, id))) return
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
      const ids = codeCellIds(sessionId, bookOf(message))
      if (ids === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK })
        return
      }
      queue(ws, sessionId, payload, ids)
      return
    }

    case 'runAbove': {
      const id = optionalId(message.cellId)
      if (!id) return
      if (!mayRun(sessionId, payload, ws)) return
      if (!mayBulkRun(sessionId, payload, ws)) return
      const ids = codeCellIds(sessionId, bookOf(message), id)
      if (ids === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK })
        return
      }
      queue(ws, sessionId, payload, ids)
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
        refuse(
          ws,
          sessionId,
          payload,
          'Only the host, or whoever started the running cell, can interrupt the kernel.',
        )
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
      if (
        !may(
          sessionId,
          getRules(sessionId).restart,
          payload,
          ws,
          'Only the host can restart the kernel.',
        )
      ) {
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
        ? may(
            sessionId,
            rules.edit,
            payload,
            ws,
            'В этом семинаре тетрадь принадлежит преподавателю.',
          )
        : may(sessionId, rules.wipe, payload, ws, 'Стирать всю доску здесь может преподаватель.')
      if (!allowed) return
      const book = bookOf(message)
      /*
       * Названная тетрадь обязана существовать: ниже неизвестный путь означает
       * «тетрадь не названа», а это стёртые выводы ВСЕХ тетрадей комнаты —
       * полтора часа счёта, снятые нажатием в закрывающейся вкладке.
       */
      if (book && !cellsAt(getSessionDoc(sessionId).doc, book)) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK })
        return
      }
      clearOutputs(sessionId, one, book)
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
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          'Ставить документ на общий экран в этом семинаре может преподаватель.',
        )
      ) {
        return
      }
      const name = normalizePath(typeof message.name === 'string' ? message.name : '') ?? ''
      if (lectureInTheWay(sessionId, payload, ws, name)) return
      /*
       * Существование проверяется здесь, а не у смотрящего: иначе комната
       * получит имя, которого нет, и двадцать человек увидят пустую область.
       * Спрашивается сам путь: в дереве его может не быть просто потому, что
       * список упёрся в потолок, а документ на диске лежит.
       */
      if (!name || statPath(sessionId, name)?.dir !== false) {
        send(ws, { t: 'error', message: 'Такого файла в комнате нет.' })
        return
      }
      setBoard(sessionId, name)
      return
    }

    case 'board:close': {
      if (
        !may(
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          'Убрать документ с общего экрана в этом семинаре может преподаватель.',
        )
      ) {
        return
      }
      if (lectureInTheWay(sessionId, payload, ws, null)) return
      setBoard(sessionId, null)
      return
    }

    /* ----------------------------------------------------------- занятие */

    /**
     * Закончить занятие — и открыть его обратно.
     *
     * Комната от этого не закрывается: тетрадь, файлы, лента терминала и
     * ответы оракула остаются открытыми на чтение — после пары в них и ходят.
     * Закрываются действия, и закрываются сами: проверки прав спрашивают
     * действующие правила, а те после конца занятия преподавательские
     * (shared/rules.ts · rulesAfterClass).
     *
     * Лекцию при этом не гасим: сорок минут разметки живут только в памяти, и
     * терять их нажатием «Закончить занятие» — потеря работы, а зрителем в
     * лекции участник и так был. И ядро не гасим: преподаватель после пары ещё
     * считает, холодный старт стоит минуты, а простаивающее приберёт уборка.
     */
    case 'class:finish':
    case 'class:resume': {
      const finish = message.t === 'class:finish'
      if (payload.role !== 'host') {
        refuse(
          ws,
          sessionId,
          payload,
          finish
            ? 'Закончить занятие может преподаватель.'
            : 'Открыть занятие обратно может преподаватель.',
        )
        return
      }
      /*
       * Второе нажатие — не ошибка: у преподавателя открыты две вкладки, и на
       * второй кнопка та же. Но и не новое время — «закончено в 15:40» не
       * должно переезжать на 16:10 оттого, что по кнопке попали ещё раз.
       */
      if (finish === (finishedAt(sessionId) !== null)) return
      const at = finish ? Date.now() : null
      setFinished(sessionId, at)
      broadcast(sessionId, { t: 'class', finishedAt: at })
      /*
       * И оборвать идущий ход оракула — там же, где его обрывают стирание
       * треда и удаление семинара. Иначе он ещё десяток шагов правит файлы в
       * комнате, где всем остальным уже только читать.
       *
       * А очередь ячеек, поставленная до звонка, доводится до конца — и это не
       * непоследовательность. Ход обрывается ровно потому, что он ПРАВИТ ФАЙЛЫ
       * дальше: каждый следующий его шаг переписывает комнату уже после звонка.
       * Ячейка не переписывает ничего — она досчитывает то, что человек
       * запустил, пока было можно, и её вывод как раз и есть то, за чем в
       * комнату приходят после пары. Начатое доводится, начать — уже нельзя.
       */
      if (finish) stopAll(sessionId)
      return
    }

    /* ------------------------------------------------------------ лекция */

    /**
     * Начать лекцию.
     *
     * Право то же, что у общего экрана: ставить документ перед всей комнатой.
     * Ведущий один — тот, кто начал; вторая попытка перехватывает пульт, и это
     * намеренно: двое преподавателей в комнате — обычное дело, а спорить о том,
     * чей планшет главный, посреди пары невозможно.
     */
    case 'lecture:start': {
      if (
        !may(
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          'Вести лекцию в этом семинаре может преподаватель.',
        )
      ) {
        return
      }
      const wanted = normalizePath(typeof message.file === 'string' ? message.file : '')
      if (!wanted || kindOf(wanted) !== 'pdf') {
        send(ws, { t: 'error', message: 'На проектор выводится документ PDF.' })
        return
      }
      if (!statPath(sessionId, wanted)) {
        send(ws, { t: 'error', message: 'Этого файла в комнате уже нет.' })
        return
      }
      /*
       * Та же лекция, но другими руками — это ПЕРЕДАЧА пульта, а не начало.
       *
       * Второму преподавателю нечем сказать «возьму управление»: кнопка «взять
       * пульт» шлёт тот же `lecture:start` по тому же файлу. Провалившись
       * дальше, оно ушло бы в `startLecture` и стёрло бы всё, ради чего пульт и
       * берут: страницу вернуло бы на первую, чернила — все до одного, часы
       * лекции — в ноль. Сорок минут разметки, стёртые нажатием «перехватить»,
       * и стёртые на проекторе при всех.
       *
       * Только когда ведёт КТО-ТО ДРУГОЙ: то же нажатие своего же пульта — это
       * «начать заново», и заново значит начисто. Общий экран здесь не трогаем
       * — документ на нём уже стоит, это та же лекция.
       */
      const going = lectureOf(sessionId)
      if (going && going.file === wanted && going.by === payload.participantId) {
        /*
         * Свой же документ своими же руками — это НИЧЕГО.
         *
         * «Ещё → сменить документ» показывает все PDF комнаты, и тот, что идёт
         * сейчас, стоит в том же ряду. Нажатие по нему читается как «убедиться,
         * что открыт правильный», а не как «начать заново начисто» — а стоило
         * бы это сорока минутами разметки и часами лекции, стёртыми на
         * проекторе при всех. Начать заново — это закончить и начать: два
         * нажатия, второе из которых человек делает уже осознанно.
         */
        return
      }
      if (going && going.file === wanted) {
        /*
         * Взять пульт у другого — дело преподавателя, а не правила `board`.
         *
         * Правило решает, кому ставить документ залу; забрать управление у
         * того, кто уже ведёт, — другой поступок, и в открытой комнате, где
         * доску ставит любой, он означал бы, что студент посреди пары молча
         * забирает страницу, чернила и указку себе.
         */
        if (payload.role !== 'host') {
          refuse(ws, sessionId, payload, 'Взять пульт у ведущего может преподаватель.')
          return
        }
        const taken = handOver(
          sessionId,
          wanted,
          payload.participantId,
          displayName(sessionId, payload.participantId),
          colorForId(payload.participantId),
        )
        if (taken) {
          broadcast(sessionId, { t: 'lecture', state: taken })
          // Рука сменилась: пятно прежнего ведущего залу больше ничего не
          // показывает, а само оно не погаснет — он уже не шлёт кадров.
          laserOff(sessionId)
          return
        }
      }
      /*
       * Дальше — начать НОВУЮ лекцию по другому документу, а идущая при этом
       * кончается. Менять документ залу вправе только тот, кто ведёт: для всех
       * остальных, включая второго преподавателя, это стёртые чернила чужой
       * лекции без предупреждения и без возврата. Им — «Закончить» и потом
       * «Лекция»: два нажатия, второе из которых делают осознанно.
       */
      if (lectureInTheWay(sessionId, payload, ws, wanted)) return
      /*
       * Лекция ставит документ и на общий экран — до того, как начаться.
       *
       * Не для красоты: правило «доска ушла — лекция кончилась» выше держится
       * ровно на том, что это один и тот же файл. Порядок важен — setBoard
       * успевает закрыть предыдущую лекцию, если она шла по другому документу,
       * и только потом комната узнаёт о новой.
       */
      setBoard(sessionId, wanted)
      const started = startLecture(sessionId, {
        file: wanted,
        by: payload.participantId,
        byName: displayName(sessionId, payload.participantId),
        color: colorForId(payload.participantId),
      })
      broadcast(sessionId, { t: 'lecture', state: started })
      broadcast(sessionId, { t: 'ink', strokes: [] })
      return
    }

    case 'lecture:stop': {
      if (
        !may(
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          'Закончить лекцию может преподаватель.',
        )
      ) {
        return
      }
      /*
       * И это второе право, а не то же самое: правило `board` решает, кому
       * ставить документ залу, а закончить ЧУЖУЮ лекцию — поступок другого
       * рода. В открытой комнате, где доску ставит любой, иначе получалось бы,
       * что студент одним нажатием гасит проекцию преподавателя вместе со всей
       * разметкой.
       */
      if (payload.role !== 'host' && !isPresenter(sessionId, payload.participantId)) {
        refuse(ws, sessionId, payload, 'Закончить чужую лекцию может преподаватель.')
        return
      }
      stopLecture(sessionId)
      broadcast(sessionId, { t: 'lecture', state: null })
      laserOff(sessionId)
      return
    }

    /*
     * Заметки спикера. Право — роль хоста, и это не то же самое, что право
     * вести лекцию.
     *
     * Не `isPresenter`: заметки пишут накануне вечером, когда лекции нет вовсе и
     * вести некому. И не правило `board`: правило решает, кому показывать
     * документ залу, а заметка залу не показывается никогда — в открытой
     * комнате, где доску ставит любой, она осталась бы преподавательской.
     */
    case 'notes:open': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, 'Заметки к лекции видит преподаватель.')
        return
      }
      const file = normalizePath(typeof message.file === 'string' ? message.file : '')
      if (!file) {
        send(ws, { t: 'error', message: refusedPath(message.file) })
        return
      }
      /*
       * Ответ — одному сокету, а не всем хостам: это ответ на вопрос, который
       * задала одна вкладка. Второму преподавателю, ничего не спрашивавшему,
       * приехала бы карта к документу, которого у него не открыто, и его пульт
       * подменил бы ею свою.
       */
      notesOpen.set(ws, file)
      send(ws, { t: 'notes', file, notes: notesOf(sessionId, file) })
      return
    }

    case 'notes:set': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, 'Заметки к лекции пишет преподаватель.')
        return
      }
      const file = normalizePath(typeof message.file === 'string' ? message.file : '')
      if (!file) {
        send(ws, { t: 'error', message: refusedPath(message.file) })
        return
      }
      const page = Number(message.page)
      if (!Number.isFinite(page) || page < 1) {
        // Тоже вслух: всё, что теряет написанный текст, обязано это сказать.
        send(ws, { t: 'error', message: 'Заметка пишется к странице документа.' })
        return
      }
      const text = typeof message.text === 'string' ? message.text : ''
      if (text.length > MAX_NOTE_CHARS) {
        /*
         * Вслух, а не обрезать. Обрезанная посередине фраза выглядит как
         * сохранённая, и человек узнаёт о потере на паре, читая обрубок; клиент
         * держит тот же потолок полем `maxlength`, так что сюда доезжает только
         * то, что мимо клиента.
         */
        send(ws, {
          t: 'error',
          message: `Заметка к странице — не длиннее ${MAX_NOTE_CHARS} знаков.`,
        })
        return
      }
      const at = Math.floor(page)
      setNote(sessionId, file, at, text)
      // Тем же текстом, каким он лёг в базу: `setNote` подрезает края, а пустая
      // заметка — это её отсутствие, и эхо обязано говорить то же самое, иначе
      // у второго устройства останется строка из пробелов там, где строки нет.
      toHosts(sessionId, file, { t: 'notes:one', file, page: at, text: text.trim() })
      return
    }

    /*
     * Дальше — то, чем управляет ПУЛЬТ. Право здесь не спрашивается: страницу,
     * чернила и указку двигает тот, кто ведёт, и только он — пока идёт занятие
     * (см. `atTheRemote`). Отказ молчаливый — это не решение преподавателя, о
     * котором надо рассказать, а сообщение от вкладки, которая ещё не знает,
     * что лекцию ведёт кто-то другой или что прозвенел звонок.
     */
    case 'lecture:page': {
      if (!atTheRemote(sessionId, payload)) return
      const turned = turnTo(sessionId, Number(message.page))
      if (turned) broadcast(sessionId, { t: 'lecture', state: turned })
      return
    }

    case 'lecture:blank': {
      if (!atTheRemote(sessionId, payload)) return
      const blanked = setBlank(sessionId, message.on === true)
      if (blanked) broadcast(sessionId, { t: 'lecture', state: blanked })
      return
    }

    case 'ink': {
      if (!atTheRemote(sessionId, payload)) return
      const stroke = addInk(sessionId, {
        id: optionalId(message.id) ?? '',
        page: Number(message.page),
        color: typeof message.color === 'string' ? message.color.slice(0, 32) : '#000000',
        width: Number.isFinite(message.width)
          ? Math.min(0.05, Math.max(0.0005, message.width))
          : 0.004,
        points: Array.isArray(message.points) ? (message.points as number[]) : [],
      })
      if (stroke) broadcast(sessionId, { t: 'ink:add', stroke })
      return
    }

    case 'ink:undo': {
      if (!atTheRemote(sessionId, payload)) return
      const page = Number(message.page)
      const dropped = undoInk(sessionId, page)
      if (dropped) broadcast(sessionId, { t: 'ink:drop', page, id: dropped })
      return
    }

    case 'ink:erase': {
      if (!atTheRemote(sessionId, payload)) return
      const page = Number(message.page)
      const id = optionalId(message.id)
      if (!id || !Number.isFinite(page)) return
      /*
       * Рассылаем только то, что действительно стёрли. Ластик проходит по
       * одному штриху десяток раз за движение руки, и «сотрите штрих, которого
       * нет» заставляло бы двадцать браузеров перерисовывать страницу впустую —
       * ровно за этим `eraseInk` и отвечает, был ли он там.
       */
      if (eraseInk(sessionId, page, id)) broadcast(sessionId, { t: 'ink:drop', page, id })
      return
    }

    case 'ink:clear': {
      if (!atTheRemote(sessionId, payload)) return
      const page = Number.isFinite(message.page) ? Number(message.page) : undefined
      clearInk(sessionId, page)
      broadcast(sessionId, { t: 'ink:clear', page: page ?? null })
      return
    }

    /*
     * Указка не хранится вовсе: где она была секунду назад — не факт о лекции,
     * а движение руки. Поэтому её просто пересылают, и опоздавший её не видит,
     * пока ведущий не пошевелит рукой, — то есть примерно через полсекунды.
     */
    case 'laser': {
      if (!atTheRemote(sessionId, payload)) return
      const x = Number(message.x)
      const y = Number(message.y)
      // И страница — так же, как x и y: без проверки NaN уезжает в кадр как
      // `null` (так его пишет JSON), и зал рисует указку на своей текущей
      // странице, а ведущий в это время говорит про другую.
      const page = Number(message.page)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(page)) return
      const shape = message.shape === 'dot' ? 'dot' : 'line'
      broadcast(sessionId, { t: 'laser', at: { page, x, y, shape } })
      return
    }

    case 'laser:off': {
      if (!atTheRemote(sessionId, payload)) return
      broadcast(sessionId, { t: 'laser', at: null })
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
          sessionId,
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
      /*
       * Файл с именем .ipynb — это просьба о тетради, а не о пустом файле.
       * Заводится он сразу тетрадью: иначе человек получил бы файл, который
       * открывается редактором как строка JSON, и должен был бы догадаться,
       * что с ним делать.
       */
      if (message.t === 'tree:new' && kindOf(wanted) === 'notebook') {
        const made = createBook(sessionId, wanted)
        if (!made.ok) {
          send(ws, { t: 'error', message: made.why })
          return
        }
        broadcastFiles(sessionId)
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

    /*
     * Внести .ipynb в комнату.
     *
     * Право то же, что и у заведения файла: тетрадь, внесённая в комнату,
     * становится её частью — она попадает в снимок, в историю и на экран ко
     * всем. Читать её глазами при этом может кто угодно и без этого: файл
     * скачивается, как любой другой.
     */
    case 'book:open': {
      if (
        !may(
          sessionId,
          getRules(sessionId).files,
          payload,
          ws,
          'Открывать тетради в этом семинаре может преподаватель.',
        )
      ) {
        return
      }
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      const opened = openBook(sessionId, wanted)
      if (!opened.ok) {
        send(ws, { t: 'error', message: opened.why })
        return
      }
      if (opened.imported) broadcastFiles(sessionId)
      return
    }

    case 'tree:move': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, 'Переименовать файл в комнате может преподаватель.')
        return
      }
      const from = normalizePath(typeof message.from === 'string' ? message.from : '')
      const to = normalizePath(typeof message.to === 'string' ? message.to : '')
      if (!from || !to) {
        send(ws, { t: 'error', message: refusedPath(from ? message.to : message.from) })
        return
      }
      /*
       * Переезд в никуда — тихое ничего.
       *
       * Мышь отпускают там же, где взяли, чаще, чем попадают в соседнюю папку.
       * До сих пор такой жест доезжал до `movePath` и возвращался фразой
       * «„data.csv“ в этой папке уже есть» — то есть объяснял человеку, что файл
       * столкнулся сам с собой. Сказать здесь нечего: ничего не произошло и
       * ничего не сломалось, а отказ на пустом месте читается как поломка.
       */
      if (from === to) return
      /*
       * Папку — не внутрь себя. Отказ стоит здесь, а не только в `movePath`,
       * ради слов: та отвечает `bad-name`, и фраза выходила про имя («„src“ не
       * годится в качестве имени»), тогда как имя как раз годится — не годится
       * место. Перетаскивание попадает сюда всякий раз, когда папку роняют на
       * что-нибудь внутри неё самой, то есть промахом на одну строку.
       */
      if (isInside(to, from)) {
        send(ws, { t: 'error', message: `«${baseOf(from)}» нельзя положить внутрь себя.` })
        return
      }
      // Переименовать могли и папку — тогда переезжает всё, что в ней.
      const inside = pathsInside(sessionId, from)
      // Несохранённый хвост — на диск ДО переезда: `movePath` переносит то, что
      // уже лежит на диске, а `forgetFile` ниже уносит документ вместе с
      // отложенным сохранением. Иначе последние полсекунды набора пропадают, и
      // сказать об этом некому.
      for (const path of inside) flushFile(sessionId, path)
      const outcome = movePath(sessionId, from, to)
      if (outcome !== 'ok') {
        send(ws, { t: 'error', message: treeTrouble(outcome, to, from) })
        return
      }
      for (const was of inside) {
        const now = to + was.slice(from.length)
        /*
         * Один путь не обрывает остальные.
         *
         * Файлы на диске уже переехали — все разом, одним `rename`, — и отказ
         * на середине списка оставляет комнату наполовину на старых путях:
         * тетрадь по новому адресу, проектор по старому, и ни одного слова о
         * том, почему. Отказ здесь бывает настоящий: заметки ходят в базу, где
         * у переезда есть свой конфликт ключа, — и потерять из-за него ещё и
         * доску было бы вдвое хуже, чем потерять заметки к одному файлу.
         */
        try {
          // Документ старого пути больше ни на что не смотрит: у него на диске
          // ничего нет, и следующее сохранение воскресило бы файл под прежним
          // именем. Наблюдатель заметит это сам, но не раньше двух секунд — а
          // вкладки, открытые на нём, должны узнать сразу.
          forgetFile(sessionId, was)
          // Тетрадь переезжает вместе со своим файлом: корень тот же, путь новый.
          moveBook(sessionId, was, now)
          const moved = moveLecture(sessionId, was, now)
          if (moved) broadcast(sessionId, { t: 'lecture', state: moved })
          // Лекция уезжает раньше доски намеренно: `setBoard` заканчивает лекцию,
          // если документ на экране разошёлся с её файлом.
          if (boardOf(sessionId) === was) setBoard(sessionId, now)
          /*
           * И заметки спикера — они привязаны к пути документа, а не к лекции.
           *
           * Переименовать файл посреди пары — обычное дело: преподаватель правит
           * «лекция3.pdf» на «Лекция 3. Поток и дивергенция.pdf». Без этой строки
           * вечер, потраченный на речь к двадцати четырём страницам, превращается
           * в строки, к которым больше нет ключа: старого пути на диске уже нет, а
           * восстановить их из интерфейса нечем.
           *
           * Последними в списке: только они ходят в базу, а значит только они
           * умеют отказать по-настоящему.
           */
          moveNotesTo(sessionId, was, now)
        } catch {
          /* см. выше: этот путь переехал не целиком, остальные переезжают */
        }
      }
      broadcastFiles(sessionId)
      return
    }

    case 'tree:remove': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, 'Убрать файл из комнаты может преподаватель.')
        return
      }
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      // Панель обещает «убрать папку со всем, что в ней», и обещание держится
      // здесь: список считается до удаления, потому что после него спрашивать
      // дерево уже не о чем.
      const inside = pathsInside(sessionId, wanted)
      if (!deleteFile(sessionId, wanted)) {
        send(ws, { t: 'error', message: 'Этого файла в комнате уже нет.' })
        return
      }
      for (const path of inside) {
        forgetFile(sessionId, path)
        // Иначе тетрадь, лежавшая внутри папки, осталась бы в комнате — и
        // проекция через полторы секунды завела бы папку и файл заново.
        dropBook(sessionId, path)
      }
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
       * Сначала на диск, потом запускать: Cmd+Enter приходит из самого
       * редактора и обгоняет отложенное сохранение, а `python` читает диск.
       * Иначе запускается текст без последних набранных строк — и это худший
       * вид ошибки: она про строку, которая на экране выглядит правильной, а со
       * второго нажатия всё «само» работает.
       */
      flushFile(sessionId, wanted)
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
     * Право почти то же, что и у самого режима «сделать»: кто мог его
     * запустить, тот может и отменить, — «разрешено начинать, но не разрешено
     * откатывать» было бы худшей из возможных пар. Разница одна, и она про
     * `off`: правила меняются на живой комнате, и естественный ход
     * «оракул натворил → выключаю оракула → откатываю» упирался в отказ,
     * который вдобавок говорил «может преподаватель» тому самому
     * преподавателю. Выключенный режим — это запрет НАЧИНАТЬ; убрать за уже
     * начатым преподаватель вправе всегда.
     */
    case 'ai:undo': {
      if (payload.role !== 'host' && !allowsAgent(getRules(sessionId).agent, payload.role)) {
        refuse(ws, sessionId, payload, 'Отменять ход оракула здесь может преподаватель.')
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
        refuse(ws, sessionId, payload, 'В этом семинаре порядок ячеек меняет преподаватель.')
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
     * Замок на ячейке: преподаватель открывает одну, и в ней комната печатает и
     * запускает — в лекционной тетради, где всё остальное его.
     *
     * Право простое и не выражается правилом комнаты: открывает тот, чья
     * тетрадь, то есть преподаватель. Правило здесь было бы правилом о том, кто
     * раздаёт права, — а такого в RoomRules нет и заводить его не за чем.
     */
    case 'cell:open':
    case 'cell:lock': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, 'Открывает ячейки преподаватель.')
        return
      }
      /*
       * И не в законченном занятии. Открытая ячейка — это обещание комнате, что
       * здесь ей можно; после звонка нельзя нигде (shared/rules.ts ·
       * rulesAfterClass), и обещание оказалось бы пустым: замок открыт, а Run
       * отвечает «занятие закончено». Пустое обещание хуже отказа — по нему
       * идут и упираются.
       */
      if (isFinished(sessionId)) {
        send(ws, { t: 'error', message: OVER })
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      /*
       * `cell:open` — частный случай на два положения, и читается он тем же
       * кодом: два обработчика одного замка разъехались бы на первой правке.
       */
      let state: CellLock
      let settings: Partial<CouncilSettings> = {}
      if (message.t === 'cell:open') {
        if (typeof message.open !== 'boolean') return
        /*
         * Один щелчок по замку открывает так, как заведено в комнате: в лекции —
         * общий текст, в консилиуме — каждому свой лист (shared/rules.ts ·
         * opens). Меню замка шлёт `cell:lock` с явным положением и это правило
         * не спрашивает.
         */
        const opens = getRules(sessionId).opens
        state = message.open ? (opens === 'council' ? 'council' : 'open') : 'closed'
      } else {
        if (message.state !== 'closed' && message.state !== 'open' && message.state !== 'council') {
          return
        }
        state = message.state
        settings = pickSettings(message.settings)
      }
      const { doc } = getSessionDoc(sessionId)
      const found = findCell(doc, id)
      if (!found) {
        send(ws, { t: 'error', message: 'Этой ячейки в комнате уже нет.' })
        return
      }
      const was = cellLock(found.cell)
      /*
       * Ручки: не приложены — как были; ячейка впервые в консилиуме — умолчания
       * (readCouncilSettings отдаёт их на пустом месте). Повторный `cell:lock`
       * с тем же положением и новыми ручками — это и есть «переключить ручку».
       */
      const prior = readCouncilSettings(found.cell.get('council'))
      const next: CouncilSettings | null = state === 'council' ? { ...prior, ...settings } : null
      // Повторное нажатие — не событие: лишняя версия в истории на каждый
      // щелчок по уже открытой ячейке ничего не рассказывает.
      const sameKnobs =
        next === null ||
        (next.studentRun === prior.studentRun && next.namesOnProjector === prior.namesOnProjector)
      if (was === state && sameKnobs) return
      /*
       * От имени сервера, как `state` и `outputs` у той же ячейки: `open` —
       * право, а не чей-то набор, и автора у него нет. Ключ `council` пишется
       * только там, где он есть или нужен: ячейке, которая консилиумом не была,
       * `null` в нём ничего не рассказывает.
       */
      doc.transact(() => {
        found.cell.set('open', openValueFor(state))
        if (next !== null || found.cell.get('council') != null) found.cell.set('council', next)
      }, ORIGIN)
      /*
       * Консилиум открыли, переключили или закрыли — комнате об этом надо
       * сказать по управляющему проводу: попытки не в документе, и студент
       * иначе узнал бы о закрытии только по отказу на следующий снимок. Закрытие
       * не стирает попыток — они остаются на просмотр (боард с lock: 'closed'),
       * а автору уходит `closed: true`, и текст остаётся у него черновиком.
       */
      if (was === 'council' || state === 'council') councilChanged(sessionId, id)
      return
    }

    /*
     * Консилиум: свой лист студента.
     *
     * Право — `mayWriteCouncil`: правила комнаты ни при чём (свой лист и
     * заводят там, где общий текст преподавательский), останавливают только
     * закрытый замок и конец занятия. Снимок в ячейку без консилиума — отказ
     * теми же словами, что у серой кнопки на клиенте.
     */
    case 'council:draft':
    case 'council:submit':
    case 'council:withdraw': {
      const id = optionalId(message.cellId)
      if (!id) return
      const { lock } = councilCellOf(sessionId, id)
      if (!mayWriteCouncil(payload.role, isFinished(sessionId), lock !== 'council')) {
        if (lock !== 'council') send(ws, { t: 'error', message: `${COUNCIL_CLOSED}.` })
        else refuse(ws, sessionId, payload, COUNCIL_CLOSED)
        return
      }
      const before = countFor(sessionId, id)
      const now = Date.now()
      if (message.t === 'council:draft') {
        if (typeof message.text !== 'string') return
        if (message.text.length > MAX_ATTEMPT_CHARS) {
          // Вслух, а не обрезать: обрезанный молча код на экране выглядит целым.
          send(ws, {
            t: 'error',
            message: `Попытка — не длиннее ${MAX_ATTEMPT_CHARS} знаков; остальное вынесите в файл.`,
          })
          return
        }
        saveDraft(sessionId, id, payload.participantId, message.text, now)
      } else if (message.t === 'council:submit') {
        if (!submitAttempt(sessionId, id, payload.participantId, now)) {
          send(ws, { t: 'error', message: 'Сдавать пока нечего — напишите что-нибудь.' })
          return
        }
      } else if (!withdrawAttempt(sessionId, id, payload.participantId)) {
        return
      }
      mineOut(sessionId, id, payload.participantId)
      boardOut(sessionId, id, [payload.participantId])
      // Счётчик — комнате, и только когда он сменился: снимок при паузе в
      // наборе счётчика не двигает, а кадр на каждый — двадцать браузеров ради ничего.
      const after = countFor(sessionId, id)
      if (after.total !== before.total || after.submitted !== before.submitted) {
        countOut(sessionId, id)
      }
      return
    }

    /*
     * Консилиум: то, что делает ведущий. Право одно на всё — `mayLeadCouncil`,
     * и после звонка тоже: сданное остаётся на просмотр, разобрать его после
     * пары — дело преподавателя.
     */
    case 'council:show': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, 'Консилиум ведёт преподаватель.')
        return
      }
      const id = optionalId(message.cellId)
      const target = optionalId(message.participantId)
      if (!id || !target) return
      const attempt = attemptOf(sessionId, id, target)
      if (!attempt) {
        send(ws, { t: 'error', message: 'Этой попытки уже нет.' })
        return
      }
      const found = findCell(getSessionDoc(sessionId).doc, id)
      if (!found) {
        send(ws, { t: 'error', message: 'Этой ячейки в комнате уже нет.' })
        return
      }
      /*
       * Обычной правкой от имени преподавателя, а не от имени сервера: это
       * текст, который теперь читает класс, и в истории у него должен быть
       * автор — тот, кто решил показать, а не тот, кто написал.
       */
      applyOnBehalf(sessionId, payload.participantId, () => {
        replaceText(cellSource(found.cell), attempt.text)
      })
      const changed = setShown(sessionId, id, target)
      for (const participantId of changed) mineOut(sessionId, id, participantId)
      boardOut(sessionId, id, [target, ...changed])
      return
    }

    case 'council:run': {
      const id = optionalId(message.cellId)
      if (!id) return
      const target = optionalId(message.participantId) ?? payload.participantId
      const own = target === payload.participantId
      if (!own && !mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, 'Чужую попытку запускает преподаватель.')
        return
      }
      const { lock, settings } = councilCellOf(sessionId, id)
      if (!mayRunCouncil(payload.role, settings.studentRun, isFinished(sessionId))) {
        refuse(ws, sessionId, payload, 'В этом консилиуме попытки запускает преподаватель.')
        return
      }
      // Студент — только пока консилиум идёт; преподаватель считает и на просмотре.
      if (payload.role !== 'host' && lock !== 'council') {
        send(ws, { t: 'error', message: `${COUNCIL_CLOSED}.` })
        return
      }
      const attempt = attemptOf(sessionId, id, target)
      if (!attempt) {
        send(ws, {
          t: 'error',
          message: own ? 'Сначала напишите попытку.' : 'Этой попытки уже нет.',
        })
        return
      }
      const outcome = requestCouncilRun(
        sessionId,
        {
          cellId: id,
          participantId: target,
          source: attempt.text,
          by: payload.role === 'host' ? 'host' : 'author',
          /*
           * Каждый кадр ядра — к попытке и двоим, кому она видна. Очередь после
           * конца запуска сдвинулась — ждущим новый номер.
           */
          onChange: (run: CouncilRun | null) => {
            recordRun(sessionId, id, target, run)
            mineOut(sessionId, id, target)
            boardOut(sessionId, id, [target])
            if (run === null || run.state === 'ok' || run.state === 'error') tellQueued(sessionId)
          },
        },
        displayName(sessionId, payload.participantId),
        payload.participantId,
      )
      if (!outcome.queued) {
        send(ws, {
          t: 'error',
          message:
            outcome.position === 0
              ? 'Эта попытка уже считается.'
              : `Эта попытка уже в очереди — ${outcome.position}-я.`,
        })
      }
      return
    }

    case 'council:reply': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, 'Консилиум ведёт преподаватель.')
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      const text = typeof message.text === 'string' ? message.text.trim() : ''
      if (!text) return
      if (text.length > MAX_REPLY_CHARS) {
        send(ws, { t: 'error', message: `Ответ — не длиннее ${MAX_REPLY_CHARS} знаков.` })
        return
      }
      const to = message.to as { participantId?: unknown; groupKey?: unknown } | undefined
      const participantId = optionalId(to?.participantId)
      const address =
        participantId !== undefined
          ? { participantId }
          : typeof to?.groupKey === 'string'
            ? { groupKey: to.groupKey }
            : null
      if (!address) return
      // Подпись преподавателя, не оракула: черновик модели сюда попадает уже
      // правленым текстом, и в ленте студента отвечает человек.
      const reply = { text, at: Date.now(), by: displayName(sessionId, payload.participantId) }
      const told = setReply(sessionId, id, address, reply)
      if (told.length === 0) {
        send(ws, { t: 'error', message: 'Отвечать некому: этой попытки уже нет.' })
        return
      }
      for (const who of told) mineOut(sessionId, id, who)
      boardOut(sessionId, id, told)
      return
    }

    case 'council:mark': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, 'Консилиум ведёт преподаватель.')
        return
      }
      const id = optionalId(message.cellId)
      const target = optionalId(message.participantId)
      if (!id || !target) return
      const correct =
        message.correct === null || typeof message.correct === 'boolean'
          ? message.correct
          : undefined
      if (correct === undefined) return
      setMark(sessionId, id, target, correct)
      mineOut(sessionId, id, target)
      boardOut(sessionId, id, [target])
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
      /*
       * Право на принятие спрашивается у ЯЧЕЙКИ, а не только у правила.
       *
       * Иначе замок читался бы как поломка: ячейку студенту открыли, он в ней
       * печатает и запускает, спрашивает оракула — и не может нажать
       * «принять» на предложение, сделанное для этой самой ячейки. Правило
       * `edit` при этом никуда не делось: в закрытой ячейке принимает
       * преподаватель, как и было.
       */
      const target = entry.get('cellId')
      const targetOpen = typeof target === 'string' ? cellIsOpen(sessionId, target) : false
      if (
        message.accept &&
        !mayEditCell(getRules(sessionId), payload.role, targetOpen, isFinished(sessionId))
      ) {
        // Отклонить может кто угодно: снятая плашка ничего не разрушает — пока
        // занятие идёт и оракула можно спросить заново.
        refuse(
          ws,
          sessionId,
          payload,
          'Применить правку оракула здесь может преподаватель — спросить его можно по-прежнему.',
        )
        return
      }
      /*
       * А после звонка — разрушает, и потому закрыто и отклонение. `patchState`
       * становится `rejected` навсегда, а вернуть предложение нечем: спросить
       * оракула участник уже не может, и снятая им плашка — это стёртая чужая
       * работа. Правилом это не выражается: `edit` спрашивают у «принять», у
       * «отклонить» правила нет вовсе — поэтому та же граница, что у `input`.
       */
      if (!actsAfterClass(isFinished(sessionId), payload.role)) {
        send(ws, { t: 'error', message: OVER })
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
        refuse(ws, sessionId, payload, 'Ответить может тот, чья ячейка спрашивает.')
        return
      }
      /*
       * И не после конца занятия — правилом это не выражается, а действие то
       * же: строка уходит в чужое ядро и двигает чужой счёт дальше. Читать
       * приглашение ко вводу в ленте по-прежнему может вся комната.
       */
      if (!actsAfterClass(isFinished(sessionId), payload.role)) {
        send(ws, { t: 'error', message: OVER })
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
          sessionId,
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
      void formatSession(sessionId, bookOf(message))
        .then((outcome) => {
          if (outcome.error) return
          if (outcome.changed === 0 && outcome.skipped === 0) {
            kernelNote(sessionId, 'Formatted with black — everything was already in shape.')
            return
          }
          const parts = [
            `${outcome.changed} ${outcome.changed === 1 ? 'cell' : 'cells'} reformatted`,
          ]
          /*
           * Два разных «не тронули», и сваливать их в одно число нельзя: про
           * ячейку, которую правили, пока работал black, сказано ровно
           * обратное тому, что про ячейку, которую он не смог прочитать.
           * `edited` входит в `skipped`, поэтому вычитается.
           */
          const unread = outcome.skipped - outcome.edited
          if (unread > 0) {
            parts.push(
              `${unread} left alone (a magic, a shell line, or code mid-sentence — black could not read them)`,
            )
          }
          if (outcome.edited > 0) {
            parts.push(
              `${outcome.edited} left as typed (somebody was editing them while black ran)`,
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
      /*
       * Открыть ящик — не действие, а взгляд: расшифровка общая, и после конца
       * занятия её дочитывают так же, как тетрадь. Набрать в нём команду
       * нельзя — это `term:run` и правило `run`. Цена названа вслух: уснувший
       * контейнер ящик поднимет, но ящик, который не открывается, читается как
       * поломка, а не как правило.
       *
       * А после звонка эту цену платить уже не за что: поднять контейнер и
       * завести новую оболочку ради ленты, которую и так отдаёт документ, —
       * минута ожидания и лишние гигабайты в комнате, где всем, кроме
       * преподавателя, только читать. Поэтому участнику ящик открывается и
       * читается, а оболочка остаётся спать. Отказа нет — есть статус: без него
       * вкладка ждала бы запуска, которого никто не начинал.
       */
      if (!actsAfterClass(isFinished(sessionId), payload.role)) {
        send(ws, { t: 'terminal', status: terminalPhase(sessionId) })
        return
      }
      void openTerminal(sessionId).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, 'Could not open the terminal.'),
        })
      })
      return
    }

    case 'term:run': {
      /*
       * То же право, что у ячейки, и по той же причине: `python train.py` в
       * оболочке — тот же контейнер и то же процессорное время, что и Run.
       * Без этой строки правило `run` оставалось честным только для тетради:
       * кнопка над файлом гаснет со словами «Запускает преподаватель», а
       * строкой ниже тот же скрипт запускается кем угодно. Открыть ящик и
       * читать чужой вывод по-прежнему может вся комната — оболочка общая.
       */
      if (
        !mayRun(
          sessionId,
          payload,
          ws,
          'В этом семинаре запускает преподаватель — и ячейки, и команды оболочки.',
        )
      ) {
        return
      }
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
        refuse(
          ws,
          sessionId,
          payload,
          'Only the host, or whoever typed the running command, can stop the terminal.',
        )
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
          sessionId,
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
      if (
        !may(
          sessionId,
          getRules(sessionId).wipe,
          payload,
          ws,
          'Only the host can close the terminal.',
        )
      ) {
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
  // Роль запоминается здесь и больше нигде: `toHosts` спрашивает только её, а
  // сокет живёт с той ролью, с которой пришёл, — ровно с той, которую dispatch
  // проверяет на каждом сообщении.
  rank.set(ws, payload.role)

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
  send(ws, { t: 'rules', rules: storedRules(sessionId) })
  /*
   * Правила здесь — ХРАНИМЫЕ, а конец занятия едет отдельным кадром, и клиент
   * накладывает одно на другое сам (shared/rules.ts · rulesAfterClass). Иначе
   * преподаватель, открывший настройки комнаты после конца пары, увидел бы в
   * них не то, что выбрал, а то, во что это превратил конец занятия.
   *
   * А кадр — по той же причине, что и правила: зашедший в середине обязан
   * увидеть, что пара кончилась, сразу, а не по первому отказу.
   */
  send(ws, { t: 'class', finishedAt: finishedAt(sessionId) })
  /*
   * И что комната смотрит сейчас. Без этой строки человек, зашедший в середине
   * занятия, не узнает про открытый документ, пока преподаватель его не
   * переоткроет, — то есть, скорее всего, никогда.
   */
  send(ws, { t: 'board', open: boardOf(sessionId) })
  /*
   * И лекция, если она идёт: опоздавший должен увидеть ту же страницу, что и
   * зал, вместе с тем, что на ней уже нарисовано, — а не белый лист до
   * следующего движения ведущего.
   */
  const lecture = lectureOf(sessionId)
  send(ws, { t: 'lecture', state: lecture })
  if (lecture) send(ws, { t: 'ink', strokes: inkOf(sessionId) })
  /*
   * И консилиум: попытки живут не в документе, и опоздавший иначе не узнал бы
   * ни о своём листе, ни о стопке (хост), ни о счётчике — до первого чужого
   * нажатия.
   */
  councilWelcome(ws, sessionId, payload)

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
    /*
     * Ведущий ушёл молча — гасим его указку сами.
     *
     * Пульт на iPad выгружают из памяти, не сказав «off»: вкладка не успевает
     * ничего послать, а лекция продолжается — стёртой она от этого не
     * считается. И только если у ведущего в комнате не осталось ни одного
     * сокета: у него их обычно два (планшет и кафедральный ноутбук), и уход
     * второго не должен гасить пятно, которое первый держит неподвижно.
     */
    const who = owner.get(ws)
    if (who && isPresenter(sessionId, who)) {
      let elsewhere = false
      for (const other of current.sockets) if (owner.get(other) === who) elsewhere = true
      if (!elsewhere) laserOff(sessionId)
    }
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
  let tree: FileTree
  try {
    tree = listTree(sessionId)
  } catch {
    tree = { files: [], truncated: false }
  }
  send(ws, { t: 'files', files: tree.files, truncated: tree.truncated })
}
