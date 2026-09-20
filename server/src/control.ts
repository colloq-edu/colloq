import {getLocale} from '@shared/i18n'
import {onInstanceLanguage} from './instance-language.js'
import { tr, formatNumber } from '@shared/i18n'
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
 * without leaving the room. Interrupt is the host's, and also whoever started
 * the cell that is running — see the case below. Restart is a room rule
 * (`rules.restart`), host-only by default.
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
import type * as Y from 'yjs'
import { WebSocket, type RawData } from 'ws'
import {
  acceptPatch,
  allCellArrays,
  bookAt,
  bookCells,
  bookKernel,
  bookList,
  CELLS_KEY,
  cellId,
  cellLock,
  cellsAt,
  cellSource,
  cellType,
  councilSettingsOf,
  COUNCIL_RERUN_PAUSE_MAX,
  COUNCIL_RUN_LIMIT_MAX,
  DEFAULT_COUNCIL,
  findCell,
  findChatEntry,
  getCells,
  getMeta,
  isCellOpen,
  KERNELS_KEY,
  mainRoot,
  MAX_ATTEMPT_CHARS,
  openValueFor,
  readCouncilSettings,
  rejectPatch,
  rootOfCell,
  type CellLock,
  type CouncilSettings,
  type KernelStatus,
} from '@shared/notebook'
import { colorForId } from '@shared/protocol'
import { durationWords } from '@shared/text'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilAttempt,
  CouncilBoard,
  CouncilRun,
  FileEntry,
  Participant,
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
import { defineIn } from './definitions.js'
import { LINE_LENGTH } from './kernel/format.js'
import { importHeader, nameChainAt } from './kernel/inspect-static.js'
import { kernelBackend } from './kernel/runtime-client.js'
import {
  actsAfterClass,
  allows,
  allowsAgent,
  allowsRun,
  allowsStructure,
  bookRefusal,
  CLASS_IS_OVER,
  mayEditCell,
  mayLeadCouncil,
  mayRunCell,
  mayRunCouncil,
  mayWriteCouncil,
  rulesForBook,
  runQueueCap,
  type Asker,
  type RoomRules,
  type Who,
} from '@shared/rules'
import {
  db,
  forgetRules,
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
  briefIn,
  clearOutputs,
  completeIn,
  formatSession,
  inspectIn,
  kernelNote,
  interruptSession,
  onWorkspaceChanged,
  requestRun,
  restartSession,
  sweepOrphanRuns,
  syncBookKernels,
  cancelRun,
  cancelCouncilRun,
  purgeCouncilRunsOf,
  councilQueuePosition,
  councilQueuePositions,
  kernelWorkOf,
  onKernelQueueChanged,
  queueIsOnly,
  requestCouncilRun,
  retimeCouncilRun,
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
  nextRunAtFor,
  purgeAttempts,
  recordRun,
  rememberSeed,
  saveDraft,
  setHint,
  setMark,
  setReply,
  seedOf,
  setShown,
  shownFor,
  submitAttempt,
  withdrawAttempt,
  requestAttemptRun,
  resolveRunRequest,
  clearRunRequests,
  resetCouncilCache,
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
  copyFile,
  deleteFile,
  forgetTree,
  freeCopyName,
  listFiles,
  listTree,
  makeDir,
  makeFile,
  movePath,
  sessionBytes,
  statPath,
  treeDelta,
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
import { inkFullSays, LASER_EVERY_MS, MAX_NOTE_CHARS, type InkStroke } from '@shared/lecture'
import { flushFile, forgetFile, onFileSaved } from './collab/files.js'
import {
  addInk,
  clearInk,
  eraseInk,
  forgetLecture,
  handOver,
  inkPageOf,
  inkRevision,
  inkedPagesOf,
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
  isBookFile,
  moveBook,
  onBookRulesChanged,
  onBooksWritten,
  openBook,
  ownsBookAt,
  projectBooks,
  type BookAuthor,
} from './collab/books.js'
import { config } from './config.js'
import { stopAll, undoTurn } from './ai/agent.js'
import { onCouncilOracle } from './ai/council.js'
import { evicted } from './bans.js'
import { seldom } from './log.js'
import { appendActivity } from './activity.js'
import { recordQuestion } from './admin/usage.js'
import { holdOracleHint, oracleCapacity, oracleDoor } from './ai/door.js'
import { askCouncilHint, runFailed } from './ai/hint.js'

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
/*
 * Потолок самой попытки (`MAX_ATTEMPT_CHARS`) лежит в shared/notebook.ts, и это
 * не переезд ради порядка: клиент, не знающий числа, шлёт снимок на каждую
 * паузу в наборе и получает отказ на каждую. Отказ вслух, как у заметки:
 * обрезанный молча код на экране выглядит целым.
 */
/** Ответ студенту — абзац, как заметка к странице. */
const MAX_REPLY_CHARS = 3000
/** A shell command, not a shell script: anything longer is a paste accident. */
const MAX_COMMAND_BYTES = 4096
/*
 * Потолок речи к странице (`MAX_NOTE_CHARS`) лежит в shared/lecture.ts рядом с
 * потолками чернил — по той же причине, по какой там же лежат они: поле в
 * пульте обязано резать ровно там, где режет сервер, иначе набранное пропадает
 * молча. Копия здесь один раз уже разошлась с делом — комментарий выводил три
 * тысячи знаков из кадра в 8192 байта, хотя `MAX_FRAME_BYTES` выше давно 32 КБ.
 */

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
  /**
   * Сокеты по участнику и сокеты преподавателей — рядом с общим набором.
   *
   * `tell` и `toTeachers` адресуют одному человеку и пульту, а искали адресата
   * обходом всех сокетов комнаты. На двадцати это никто не замечал; на пятистах
   * `tellQueued` (по человеку на каждый сдвиг очереди) — это четверть миллиона
   * итераций на одно нажатие, а стопка на каждый снимок в наборе перебирает те
   * же пятьсот трижды в секунду. Наборы правятся ровно там же, где `sockets`.
   */
  byParticipant: Map<string, Set<WebSocket>>
  hosts: Set<WebSocket>
  unwatch: () => void
  /**
   * Один такт пинга на комнату, а не на сокет.
   *
   * Пинг — это два счётчика и `ws.ping()`; на одном сокете таймер вокруг него
   * не виден. На пятистах это пятьсот таймеров в куче node, каждый со своим
   * замыканием, и просыпаются они вразнобой по всей минуте — то есть цикл
   * событий будят пятьсот раз там, где хватает одного обхода набора, который
   * и так лежит рядом. Сроки те же: PING_INTERVAL_MS и MAX_MISSED_PONGS не
   * менялись, сдвинулась только фаза — сокеты комнаты пингуются вместе.
   */
  pingTimer: NodeJS.Timeout | null
}

/** Сколько пингов подряд этот сокет пропустил. Ноль ставит его же `pong`. */
const missedPongs = new WeakMap<WebSocket, number>()

/**
 * Обойти комнату и спросить каждый сокет, жив ли он.
 *
 * Молчащий второй раз — это закрытая крышка ноутбука, а не медленная сеть:
 * такой сокет рвётся, и вкладка, если она всё-таки есть, возвращается сама.
 */
function pingRoom(sessionId: string): void {
  const room = rooms.get(sessionId)
  if (!room) return
  for (const ws of room.sockets) {
    const missed = missedPongs.get(ws) ?? 0
    if (missed >= MAX_MISSED_PONGS) {
      try {
        ws.terminate()
      } catch {
        /* уже мёртв */
      }
      continue
    }
    missedPongs.set(ws, missed + 1)
    try {
      ws.ping()
    } catch {
      try {
        ws.terminate()
      } catch {
        /* уже мёртв */
      }
    }
  }
}

const rooms = new Map<string, Room>()
onInstanceLanguage((language) => {
  for (const sessionId of rooms.keys()) broadcast(sessionId, {t:'instance:language',language})
})

/* ----------------------------------------------------------------- send */

/**
 * Кадр строкой — и ни одного исключения наружу.
 *
 * `JSON.stringify` не бесконечен: строка свыше ~512 МБ — это RangeError
 * «Invalid string length», и бросается он ДО всякой отправки. Пока сборка
 * кадра стояла голой, такой бросок из таймера (стопка консилиума, список
 * файлов) уходил в `uncaughtException`, а тот уводит процесс со всеми
 * комнатами инстанса. Один кадр не стоит семинара — тем более чужого:
 * пишем причину и молчим в этот сокет.
 */
function frameOf(message: ControlServerMessage): string | null {
  try {
    return JSON.stringify(message)
  } catch (err) {
    console.error(`[control] кадр ${message.t} не собрался:`, reason(err, 'unknown error'))
    return null
  }
}

/**
 * Чем кадр важен — и что с ним делать, когда сокет не успевает.
 *
 * `stream` — то, что имеет смысл ровно сейчас: точка указки и кусок штриха.
 * Отставшему они не нужны вовсе: пока его очередь разгребается, рука ведущего
 * уже в другом месте, а следующий кадр всё равно везёт положение целиком.
 * `essential` — всё остальное: приветственная пачка, правила, конец занятия,
 * результат запуска, отказ. Такой кадр не повторится, и потерять его значит
 * оставить человека с комнатой, которой нет.
 */
type FrameClass = 'essential' | 'stream'

/**
 * Кадры, которые можно не досылать отставшему. Список, а не признак в каждом
 * месте отправки: «можно потерять» — свойство самого кадра, и решаться оно
 * должно один раз.
 */
/*
 * Ответы на дополнение и справку — тоже сюда.
 *
 * Подсказка имеет смысл ровно в ту секунду, когда её просили. Отставшему на
 * мегабайт сокету она не нужна вовсе: пока его очередь разгребается, человек
 * дописал слово сам, а следующая буква спросит заново. Досылать её значило бы
 * складывать в память процесса списки имён, которые никто не прочтёт, —
 * ровно та беда, ради которой этот класс кадров и заведён.
 */
/*
 * И ответ о том, где определено имя, — сюда же, хотя довод у него свой.
 *
 * Он приезжает не на букву, а на ОСОЗНАННЫЙ щелчок, и потерять его было бы
 * жалко — если бы было что терять. Но у этого ответа есть срок годности, и он
 * записан на той стороне: три секунды (session.svelte.ts · ASK_TIMEOUT_MS),
 * после чего обещание закрывается пустым, а опоздавший кадр отбрасывается по
 * неизвестному номеру. Сокет, отставший на мегабайт, доставит его заведомо
 * позже — то есть кадр не «теряется», он уже ничего не стоил. А доехав всё-таки
 * вовремя-но-поздно, он утащил бы экран из того места, где человек к тому
 * времени работает: ровно поэтому `define` не досылается и после обрыва
 * (session.svelte.ts · DISCARDED_OFFLINE).
 */
const STREAM_FRAMES = new Set<ControlServerMessage['t']>([
  'laser',
  'ink:add',
  'complete:reply',
  'inspect:reply',
  'define:reply',
])

function frameClass(message: ControlServerMessage): FrameClass {
  return STREAM_FRAMES.has(message.t) ? 'stream' : 'essential'
}

function send(
  ws: WebSocket,
  message: ControlServerMessage,
  kind: FrameClass = frameClass(message),
): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const frame = frameOf(message)
  if (frame === null) return
  sendFrame(ws, frame, kind)
}

/**
 * Уже собранный кадр — в один сокет.
 *
 * `Buffer`, а не только строка, и это не про удобство. `ws.send(строка)` каждый
 * раз кодирует её в UTF-8 заново — около миллисекунды на мегабайт (замерено), —
 * а кадры, которые едут ВСЕМ одинаковыми (дерево файлов, чернила лекции),
 * отправляются пятистам сокетам подряд: полмегабайта чернил превращались в
 * полсекунды блокировки цикла событий ровно на возврате зала. Кто собирает
 * такой кадр раз на комнату, тот и кодирует его раз на комнату; `binary: false`
 * держит кадр текстовым, каким его ждёт браузер.
 *
 * И две черты обратного давления — те же, что у общего документа (collab/index.ts
 * · AWARENESS_STALL_BYTES, HOPELESS_BYTES), и по той же причине. Провод не
 * бесконечен: ноутбук с закрытой крышкой, телефон в лифте, мобильная сеть на
 * краю аудитории принимают медленнее, чем комната говорит. Пока здесь стоял
 * один `readyState`, сервер складывал В ПАМЯТЬ ПРОЦЕССА всё, что не влезло в
 * провод: дерево файлов, стопку консилиума (до четырёх мегабайт) и чернила
 * тридцать раз в секунду — по копии на каждый отставший сокет. Одна забытая
 * вкладка выедала гигабайты и уводила инстанс со всеми чужими комнатами.
 */
const STREAM_STALL_BYTES = 1024 * 1024
const HOPELESS_BYTES = 8 * 1024 * 1024

function sendFrame(ws: WebSocket, frame: string | Buffer, kind: FrameClass = 'essential'): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const waiting = ws.bufferedAmount
  if (waiting > HOPELESS_BYTES) {
    if (seldom('control-backpressure')) {
      console.warn(
        `[control] сокет отстал на ${Math.round(waiting / 1024)} КБ — закрыт, ` +
          'вкладка вернётся сама и соберёт комнату заново',
      )
    }
    try {
      ws.terminate()
    } catch {
      /* уже мёртв */
    }
    return
  }
  // Отстал, но не безнадёжно: точку указки и кусок штриха он не увидит, а
  // всё, что случается один раз, — увидит.
  if (kind === 'stream' && waiting > STREAM_STALL_BYTES) return
  try {
    ws.send(frame, { binary: false })
  } catch {
    /* the socket died between the check and the write */
  }
}

export function broadcast(
  sessionId: string,
  message: ControlServerMessage,
  kind: FrameClass = frameClass(message),
): void {
  const room = rooms.get(sessionId)
  if (!room) return
  /*
   * Придержанные чернила — вперёд всего остального.
   *
   * Куски штриха склеиваются на такт (`inkTo`), и всё, что говорит о чернилах
   * что-то ещё, обязано приехать ПОСЛЕ них: «сотрите штрих», к которому в
   * очереди лежат точки, стёр бы его до того, как они дописались, а «вот вся
   * страница целиком» получила бы их дважды. Здесь, а не в каждом из десятка
   * мест, где это сказано: забыть одно из них — значит нарисовать залу не то,
   * что рисовали, и узнать об этом от преподавателя.
   */
  if (message.t !== 'ink:add') flushInk(sessionId)
  const text = frameOf(message)
  if (text === null) return
  /*
   * Байтами, а не строкой, и ровно один раз на комнату.
   *
   * `ws.send(строка)` кодирует её в UTF-8 заново на КАЖДЫЙ сокет. Кадр пера в
   * лекции — 89.6 КБ на комнату в пятьсот человек (замерено), тридцать раз в
   * секунду: это 4.9 МБ/с одного только кодирования, которое можно сделать
   * один раз. Дерево и чернила это давно делали сами (`filesFrame`, `inkFrame`)
   * — здесь то же самое для всех остальных рассылок.
   */
  const frame = Buffer.from(text, 'utf8')
  for (const ws of room.sockets) sendFrame(ws, frame, kind)
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
  forgetQueue(sessionId)
  treeSent.delete(sessionId)
  inkFrames.delete(sessionId)
  laserHeld.delete(sessionId)
  inkHeld.delete(sessionId)
  // И все открытые окна склейки: их хвосты искали бы комнату, которой нет.
  forgetTicks(sessionId)
  const room = rooms.get(sessionId)
  if (!room) return
  rooms.delete(sessionId)
  room.unwatch()
  if (room.pingTimer) clearInterval(room.pingTimer)
  room.pingTimer = null
  for (const ws of room.sockets) {
    try {
      ws.close(1001, tr("server.thisSeminarWasDeleted.daaaad"))
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
 * Точечно, а не `closeControlRoom`: комната продолжает занятие. И все три
 * провода сразу — управляющий держит нажатия, общий документ держит текст,
 * файловый держит открытый в редакторе `.py`, — закрыть один, оставив
 * остальные, значит выгнать наполовину: забаненный дописывает в общий файл
 * комнаты до тех пор, пока сам не перезагрузит страницу.
 *
 * Третий провод закрывается через событие бана (bans.ts · onEviction). Позвать
 * collab/files.ts отсюда напрямую было бы можно — этот модуль его и так
 * импортирует, — но тогда список проводов жил бы здесь, в модуле нажатий, и
 * каждый следующий провод пришлось бы вспоминать. Объявление живёт там, где
 * живёт само понятие «этому человеку сюда больше нельзя», а держащий провод
 * подписывается на него у себя.
 */
export function evictBanned(sessionId: string, participantId: string, until: number): void {
  tell(sessionId, participantId, { t: 'banned', until })
  const room = rooms.get(sessionId)
  if (room) {
    // Копия набора: обработчик закрытия правит его же.
    for (const ws of [...(room.byParticipant.get(participantId) ?? [])]) {
      try {
        ws.close(1008, tr("server.bannedFromThisSeminar.234bce"))
      } catch {
        /* already gone */
      }
    }
  }
  dropParticipant(sessionId, participantId)
  evicted(sessionId, participantId)
}

/**
 * Последний собранный кадр дерева — один на комнату, а не на сокет.
 *
 * Обход папки стоит readdir и lstat на каждую запись (до двух тысяч), а кадр —
 * до сотни килобайт строки. Одному подключению это незаметно; после перезапуска
 * сервера пятьсот вкладок возвращаются в одну-две секунды, и каждая получала
 * СВОЙ обход и СВОЮ сборку одного и того же списка — секунды блокировки цикла
 * ровно там, где все ждут возврата.
 *
 * Кэш недолгий и не заменяет рассылку: любая перемена в дереве и так проходит
 * через `broadcastFiles`, который считает список заново и кладёт сюда свежий.
 * Окно нужно только на пачку подключений подряд; за ним обход делается честно.
 */
const TREE_FRESH_MS = 1000

/**
 * Дерево, которое комната держит на руках, — одно на комнату и с номером.
 *
 * Тут сошлись две памяти, которые раньше стояли порознь: кадр на пачку
 * подключений и расписка «этот список уже разослан». Развести их больше нельзя,
 * потому что появился номер: перемена едет ДЕЛЬТОЙ (`files:delta`), а дельта
 * ложится только на тот список, из которого её посчитали. Значит запись обязана
 * быть одна — и список, и его номер, и собранный кадр.
 *
 * Номер растёт на единицу на каждую перемену состава. Вкладка, у которой на
 * руках не `from` дельты, склеивать её не пытается, а спрашивает дерево целиком
 * (`files:ask`) — так лечится и вошедший, пересчитавший дерево за пустую
 * комнату, и любое расхождение, о котором мы не знаем.
 *
 * Тик рассылки взводится от всего, что ТРОГАЕТ папку: автосохранение
 * редактора, проекция тетради, запись из ячейки. Дерево при этом чаще всего то
 * же самое — текст файла поменялся, список файлов нет. Совпавший обход поэтому
 * номера не двигает и не уезжает вовсе.
 */
interface TreeRecord {
  at: number
  rev: number
  files: FileEntry[]
  truncated: boolean
  frame: Buffer
}

const treeSent = new Map<string, TreeRecord>()

/** Тот же состав, та же цифра рядом с именем — говорить нечего. */
function sameTree(before: readonly FileEntry[], after: readonly FileEntry[]): boolean {
  if (before.length !== after.length) return false
  for (let i = 0; i < before.length; i++) {
    const was = before[i]
    const now = after[i]
    if (
      was.path !== now.path ||
      was.name !== now.name ||
      was.dir !== now.dir ||
      was.size !== now.size ||
      was.modifiedAt !== now.modifiedAt
    )
      return false
  }
  return true
}

/**
 * Дерево комнаты с номером — из памяти, если она моложе `reuseMs`, иначе обходом.
 *
 * Обход папки стоит readdir и lstat на каждую запись (до двух тысяч), а кадр —
 * до сотни килобайт строки. Одному подключению это незаметно; после перезапуска
 * сервера пятьсот вкладок возвращаются в одну-две секунды, и каждая получала
 * СВОЙ обход и СВОЮ сборку одного и того же списка — секунды блокировки цикла
 * ровно там, где все ждут возврата. Поэтому приветственная пачка берёт запись
 * моложе окна как есть, а рассылка (`reuseMs = 0`) считает честно: её зовут
 * ровно потому, что дерево изменилось.
 *
 * `ready` — дерево, которое вызывающий уже построил (загрузка файлов строит его
 * на ответ). Обход папки не дешевле подсчёта байтов, и делать его дважды на
 * одну загрузку незачем.
 */
function treeRecord(sessionId: string, ready?: FileTree, reuseMs = 0): TreeRecord | null {
  const known = treeSent.get(sessionId)
  if (!ready && known && Date.now() - known.at < reuseMs) return known
  /*
   * Дерево едет вместе с признаком обрезки: список, упёршийся в потолок обхода,
   * — это не «в комнате столько файлов». Панель говорит это вслух, иначе
   * человек ищет глазами файл, который на диске лежит. Признак шлётся всегда, и
   * `false` в нём такой же ответ, как `true`: иначе комната, один раз увидевшая
   * обрезку, так и осталась бы с предупреждением после уборки папки.
   */
  let tree: FileTree
  if (ready) tree = ready
  else {
    try {
      tree = listTree(sessionId)
    } catch {
      return null
    }
  }
  if (known && known.truncated === tree.truncated && sameTree(known.files, tree.files)) {
    known.at = Date.now()
    return known
  }
  const rev = (known?.rev ?? 0) + 1
  const text = frameOf({ t: 'files', files: tree.files, truncated: tree.truncated, rev })
  if (text === null) return null
  // Байтами, а не строкой: этот кадр уходит всем сокетам комнаты подряд, и
  // кодировать его на каждый из них — работа впустую (см. sendFrame).
  const record: TreeRecord = {
    at: Date.now(),
    rev,
    files: tree.files,
    truncated: tree.truncated,
    frame: Buffer.from(text, 'utf8'),
  }
  treeSent.set(sessionId, record)
  return record
}

/** Кадр дерева для того, кто только что вошёл, — общий на всю пачку возврата. */
function filesFrame(sessionId: string): Buffer | null {
  return treeRecord(sessionId, undefined, TREE_FRESH_MS)?.frame ?? null
}

export function broadcastFiles(sessionId: string, tree?: FileTree): void {
  /*
   * Короткая память обхода забывается ДО проверки на пустую комнату.
   *
   * Рассылка — всегда по свежему обходу: её зовут ровно потому, что дерево
   * изменилось, и отдать на это вчерашний список значило бы не сказать ничего.
   * Память самого обхода живёт в workspace.ts (`forgetTree`), и сбросить её
   * надо отсюда: в папку пишут и мимо workspace.ts (загрузка своими потоками,
   * ядро изнутри контейнера), так что обход своей памяти сам не забудет.
   *
   * Выше возврата — потому что комната без единого сокета не значит «ничего не
   * изменилось». Это ровно тот случай, когда файлы кладут до входа: рассылать
   * некому, а тот же запрос следом отдаёт `listTree` в ответе, и по старой
   * памяти он отдавал дерево БЕЗ только что положенного файла.
   */
  forgetTree(sessionId)
  const room = rooms.get(sessionId)
  if (!room || room.sockets.size === 0) return
  const before = treeSent.get(sessionId)
  const record = treeRecord(sessionId, tree)
  if (record === null) return
  /*
   * И только если оно ДЕЙСТВИТЕЛЬНО изменилось. Тот же список второй раз не
   * рассказывает панели ничего — а стоит пятисот отправок и пятисот отдельных
   * сжатий. Подключившемуся список приезжает своим путём (приветственная
   * пачка), так что молчание здесь его не касается.
   */
  if (before && before.rev === record.rev) return
  const frame = deltaFrame(before, record) ?? record.frame
  for (const ws of room.sockets) sendFrame(ws, frame)
}

/**
 * Кадр перемены — или `null`, если дешевле и честнее послать список целиком.
 *
 * Целиком отправляется в трёх случаях: комната и так ничего не держала,
 * обрезанное дерево (в нём «записи нет» и «не поместилась» неразличимы, а
 * разница эта стоит удалённой у всех тетради) и перемена крупнее самого списка
 * — так бывает на `pip install`, когда меняется вся папка разом.
 */
function deltaFrame(before: TreeRecord | undefined, now: TreeRecord): Buffer | null {
  if (!before || before.truncated || now.truncated) return null
  const delta = treeDelta(before.files, now.files)
  const text = frameOf({ t: 'files:delta', from: before.rev, rev: now.rev, ...delta })
  if (text === null) return null
  const frame = Buffer.from(text, 'utf8')
  return frame.length < now.frame.length ? frame : null
}

/* ---------------------------------------------------------- тик склейки */

/**
 * Одно окно на все рассылки «всем на каждое событие».
 *
 * Список файлов, номера очереди и указка приходят пачками — от автосохранения,
 * от каждого начала и конца работы ядра, от каждого движения руки, — а уходят
 * циклом `ws.send` по всем сокетам комнаты. У каждой из трёх был свой таймер с
 * тем же телом: карта ожидающих, `unref`, перехват броска. Три копии одного
 * правила расходятся на первой правке, поэтому окно здесь одно, а разное у них
 * только длина окна и то, что уезжает в конце.
 *
 * Первый вызов ЖДЁТ окно, а не проходит сразу: список файлов и номера очереди
 * от этого только выигрывают (перемены идут пачкой, и первая из них ничем не
 * важнее последней). Там, где ждать нельзя, ведущий кадр отправляется до
 * `onTick` руками — так сделана указка ниже.
 *
 * Ключ — «что» и комната: окна разных рассылок не мешают друг другу, а уборка
 * комнаты снимает все её окна разом (`forgetTicks`).
 */
const ticks = new Map<string, NodeJS.Timeout>()

function tickKey(sessionId: string, what: string): string {
  return `${what}\n${sessionId}`
}

function onTick(sessionId: string, what: string, everyMs: number, run: () => void): void {
  const key = tickKey(sessionId, what)
  if (ticks.has(key)) return
  const timer = setTimeout(() => {
    ticks.delete(key)
    /*
     * Под перехватом — как и всё, что делает таймер: бросок отсюда некому
     * поймать, он уходит в `uncaughtException` и уводит процесс со всеми
     * комнатами инстанса. Ни один из этих кадров не стоит чужого семинара.
     */
    try {
      run()
    } catch (err) {
      console.error(`[control ${sessionId}] тик «${what}» не уехал:`, reason(err, 'unknown error'))
    }
  }, everyMs)
  timer.unref?.()
  ticks.set(key, timer)
}

/** Окно ещё открыто: перемена приедет его хвостом, слать сейчас не надо. */
function ticking(sessionId: string, what: string): boolean {
  return ticks.has(tickKey(sessionId, what))
}

/** Все окна комнаты — снять. Комната опустела или её больше нет. */
function forgetTicks(sessionId: string): void {
  const tail = `\n${sessionId}`
  for (const [key, timer] of ticks) {
    if (!key.endsWith(tail)) continue
    clearTimeout(timer)
    ticks.delete(key)
  }
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

function scheduleFiles(sessionId: string): void {
  onTick(sessionId, 'список файлов', FILES_EVERY_MS, () => broadcastFiles(sessionId))
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

/** Куда указка приехала за окно склейки; уедет её последнее положение. */
type LaserAt = { page: number; x: number; y: number; shape: 'dot' | 'line' }
const laserHeld = new Map<string, LaserAt>()

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
  // Придержанная точка — вперёд гашения: иначе хвост окна зажёг бы пятно
  // обратно через шестьдесят миллисекунд после того, как руку убрали.
  laserHeld.delete(sessionId)
  broadcast(sessionId, { t: 'laser', at: null })
}

/**
 * Указка — комнате, но не чаще такта: за окно побеждает последняя точка.
 *
 * Такт указки — общий, из `@shared/lecture`: тем же окном режет кадры пульт.
 *
 * Кадр указки — не событие, а положение руки, и промежуточные положения никому
 * не нужны: зал всё равно ведёт её пружиной между редкими сэмплами. Сервер же
 * платил за каждое полным кругом — `JSON.stringify` и цикл `ws.send` по всем
 * сокетам комнаты; на пятистах слушателях рука ведущего стоила десятков тысяч
 * отправок в секунду. Пульт свой такт уже сбавил, но верить на слово вкладке,
 * которая может быть и старой, и чужой, нечего.
 *
 * Первый кадр уходит СРАЗУ, до окна: указка обязана появиться там, куда
 * показали, а не через такт после этого.
 */
function laserTo(sessionId: string, at: LaserAt): void {
  if (ticking(sessionId, 'указка')) {
    laserHeld.set(sessionId, at)
    return
  }
  broadcast(sessionId, { t: 'laser', at })
  onTick(sessionId, 'указка', LASER_EVERY_MS, () => {
    const held = laserHeld.get(sessionId)
    if (!held) return
    laserHeld.delete(sessionId)
    // Рука ещё идёт — отправить и открыть следующее окно.
    laserTo(sessionId, held)
  })
}

/* --------------------------------------------------------------- чернила */

/**
 * Такт склейки чернил. Чуть меньше трёх кадров экрана — рука этого не замечает.
 *
 * Перо шлёт точки пачками по мере рисования — двадцать-тридцать кусков штриха
 * в секунду, — и каждый кусок уезжал своим кадром всей комнате. На пятистах
 * слушателях это 89.6 КБ на кадр и 4.9 МБ/с (замерено) на ОДНУ проведённую
 * линию: сорок восемь байт полезных точек, остальное — обвязка кадра,
 * умноженная на зал.
 *
 * Куски одного штриха складываются в один кадр, и это ровно то же, что зал
 * увидел бы и так: разбор `ink:add` на вкладке дописывает точки к штриху с тем
 * же именем (session.svelte.ts), а склеенная пачка — это те же точки, в том же
 * порядке, одной записью.
 *
 * Первый кадр уходит СРАЗУ, до окна, как у указки: линия обязана появиться
 * там, где её начали, а не через такт.
 */
const INK_EVERY_MS = 45

/** Куски штрихов, придержанные на такт, — в порядке прихода. */
const inkHeld = new Map<string, InkStroke[]>()

function inkTo(sessionId: string, stroke: InkStroke): void {
  if (ticking(sessionId, 'чернила')) {
    const held = inkHeld.get(sessionId) ?? []
    const last = held.at(-1)
    /*
     * Только ПОДРЯД идущие куски одного штриха: между двумя кусками пера может
     * оказаться штрих второго преподавателя с планшета, и переставить их
     * местами значило бы нарисовать залу не то, что рисовали.
     *
     * Копия точек, а не память комнаты: `addInk` на новый штрих возвращает тот
     * самый массив, который лежит в комнате, и дописывать в него склейку
     * значило бы дважды разослать одни и те же точки.
     */
    if (last && last.id === stroke.id && last.page === stroke.page) {
      last.points = [...last.points, ...stroke.points]
    } else {
      held.push({ ...stroke, points: [...stroke.points] })
    }
    inkHeld.set(sessionId, held)
    return
  }
  broadcast(sessionId, { t: 'ink:add', stroke })
  openInkWindow(sessionId)
}

function openInkWindow(sessionId: string): void {
  onTick(sessionId, 'чернила', INK_EVERY_MS, () => {
    // Рука ещё идёт — отправить придержанное и открыть следующее окно.
    if (flushInk(sessionId)) openInkWindow(sessionId)
  })
}

/**
 * Придержанные куски — в провод сейчас. Возвращает, было ли что отправлять.
 *
 * Зовётся не только хвостом окна: всё, что говорит о чернилах ЧТО-ТО ЕЩЁ —
 * «сотрите штрих», «страница чистая», «вот вся страница целиком», — обязано
 * уехать ПОСЛЕ придержанного, иначе зал получает точки, дописанные к штриху,
 * который у него уже стёрт, или страницу, к которой тут же дописывается то,
 * что в ней и так есть. Место этого правила — `broadcast` ниже: там видно
 * всякую рассылку комнате, а не только те, про которые не забыли.
 */
function flushInk(sessionId: string): boolean {
  const held = inkHeld.get(sessionId)
  if (!held || held.length === 0) return false
  inkHeld.delete(sessionId)
  for (const stroke of held) broadcast(sessionId, { t: 'ink:add', stroke })
  return true
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
 *
 * Экспортируется ради второй двери удаления: файл убирают и сокетом
 * (`tree:remove` ниже), и REST'ом (routes/files.ts), а гасить доску обязаны
 * обе — иначе удалённый документ остаётся на общем экране всей комнаты до
 * перезагрузки.
 */
export function forgetMissingBoard(sessionId: string): void {
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
onFileSaved((sessionId, _path, origin) => {
  // Explicit agent writes (including new, unopened files) are complete now.
  // Keep editor autosave coalesced, but don't delay a reported tool result.
  if (origin === 'server') broadcastFiles(sessionId)
  else scheduleFiles(sessionId)
})

/*
 * Тетрадь легла на диск — комната узнаёт про файл.
 *
 * Без этого файл тетради появлялся бы в дереве только после чьей-нибудь
 * загрузки: проекция пишется сама, а сказать об этом некому.
 */
onBooksWritten((sessionId) => {
  scheduleFiles(sessionId)
  /*
   * Тетрадь убрали из комнаты — её ядро больше ничьё.
   *
   * Тот же повод, что у смены доступа: место ядра перестало существовать.
   * Оставить его значило бы держать процесс, который пишет вывод в лист,
   * которого в комнате нет, — и занимать им очередь и память до конца пары.
   */
  syncBookKernels(sessionId)
})

/*
 * Сервер поменял правила сам — комната узнаёт об этом сейчас же.
 *
 * Это случается ровно дважды: студент завёл себе тетрадь (сервер записал её
 * автора) и тетрадь убрали из комнаты (запись о ней снялась). Без рассылки
 * меню «Доступ» у преподавателя не увидело бы имени автора до перезагрузки
 * вкладки — то есть ровно в ту минуту, когда он собирается сделать тетрадь
 * личной. Едут ВЫБРАННЫЕ правила, как и во всех остальных рассылках: конец
 * занятия браузер накладывает сам (web/src/lib/may.ts).
 */
onBookRulesChanged((sessionId) => broadcast(sessionId, { t: 'rules', rules: storedRules(sessionId) }))

/*
 * Очередь ядра сдвинулась — пультам про это знать.
 *
 * Отдельной подпиской, а не из наблюдателя документа: зеркало очереди в
 * документе знает только про ЯЧЕЙКИ (попытки консилиума в него не едут
 * нарочно), так что целая очередь из попыток двигалась бы, не разбудив никого.
 */
onKernelQueueChanged((sessionId) => nudgeKernel(sessionId))

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
  const mine = room?.byParticipant.get(participantId)
  if (!mine || mine.size === 0) return
  const text = frameOf(message)
  if (text === null) return
  const kind = frameClass(message)
  // Байтами — по той же причине, что и в `broadcast`: у одного человека обычно
  // два сокета (ноутбук и планшет), и кодировать лист консилиума дважды незачем.
  const frame = mine.size > 1 ? Buffer.from(text, 'utf8') : text
  for (const ws of mine) sendFrame(ws, frame, kind)
}

/*
 * С какой ролью сокет подключился — набором `hosts` у комнаты, рядом с
 * `byParticipant` и по той же причине: адресат известен, а искали его обходом
 * всех сокетов.
 *
 * Не `getParticipant(...).role`: в таблице лежит роль, с которой человек вошёл
 * в комнату, а сокет живёт с ЭФФЕКТИВНОЙ (см. `effectiveRole` в index.ts).
 * Преподаватель, вошедший студентом по ссылке в чате и уже залогиненный в
 * панель, в таблице до сих пор участник — спросить её значило бы отказать ему в
 * его собственных заметках на его собственной лекции.
 */

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
  if (!room || room.hosts.size === 0) return
  let frame: Buffer | null = null
  for (const ws of room.hosts) {
    if (ws.readyState !== WebSocket.OPEN) continue
    // И только тем, кто спрашивал про ЭТОТ документ.
    if (notesOpen.get(ws) !== file) continue
    if (frame === null) {
      const text = frameOf(message)
      if (text === null) return
      frame = Buffer.from(text, 'utf8')
    }
    sendFrame(ws, frame)
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
const COUNCIL_CLOSED = () => tr("server.councilIsClosedYourTextRemainsIn.b08319")

/**
 * Отказ по паузе между запусками — с тем же числом, что тикает под кнопкой.
 *
 * Секунды округляются ВВЕРХ, и это не мелочь: отказ «через 0 с» читается как
 * поломка, а нажатие ровно в ту миллисекунду, которую назвал прошлый отказ,
 * должно проходить, а не встречать «через 0 с» второй раз.
 */
function rerunPauseNote(until: number): string {
  return tr("server.yourNextRunIsInTheTeacher.95d4f8", {
    p0: durationWords(Math.ceil(Math.max(0, until - Date.now()) / 1000)),
  })
}

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
  if (!room || room.hosts.size === 0) return
  let frame: Buffer | null = null
  for (const ws of room.hosts) {
    if (ws.readyState !== WebSocket.OPEN) continue
    if (frame === null) {
      const text = frameOf(message)
      // Кадр не собрался (стопка выросла за предел строки) — молчим одинаково
      // всем пультам, а не половине.
      if (text === null) return
      frame = Buffer.from(text, 'utf8')
    }
    sendFrame(ws, frame)
  }
}

/** Есть ли в комнате хоть один пульт преподавателя — иначе стопку собирать незачем. */
function teachersOnline(sessionId: string): boolean {
  const room = rooms.get(sessionId)
  if (!room) return false
  for (const ws of room.hosts) if (ws.readyState === WebSocket.OPEN) return true
  return false
}

/**
 * Ячейка консилиума одним чтением: замок и ручки.
 *
 * Именем, а не парой полей по месту: то и другое читают вместе — лист студента
 * спрашивает у одной и той же ячейки и «идёт ли консилиум», и «какая тут
 * пауза», — а ячейку ищут по всем тетрадям комнаты.
 */
interface CouncilCell {
  lock: CellLock
  settings: CouncilSettings
}

/**
 * Положение замка и ручки — из документа, где их записал сервер.
 *
 * Ячейки нет — замок закрыт: попытку в неё не принять, а стопка по ней всё ещё
 * собирается (попытки остаются на просмотр), только с закрытым замком.
 */
function councilCellOf(sessionId: string, id: string): CouncilCell {
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
/**
 * Сколько вывода попыток едет в ОДНОЙ полной стопке.
 *
 * У попытки в стопке лежит её вывод — до 64 КБ текста и до 2 МБ картинок
 * (kernel/council.ts). Пока попыток тридцать, всё помещается и ничего не
 * меняется. На пятистах прогнанных с графиком это десятки мегабайт в одном
 * кадре: `JSON.stringify` синхронно в цикле событий, разбор на iPad — и всё
 * это на каждый щелчок замка и каждое переподключение пульта. А свыше ~512 МБ
 * строки `JSON.stringify` бросает RangeError, и раньше он уводил процесс.
 *
 * Поэтому у кадра бюджет: попытки едут с выводом, пока он не выбран, дальше —
 * с пустым `outputs` и признаком `outputsOmitted`. Вывод одной карточки пульт
 * просит `council:attempt` и получает дельтой. Дельты (`council:patch`) бюджету
 * не подчиняются: там от одной до нескольких попыток, и вывод в них — то, ради
 * чего их и шлют.
 *
 * Четыре мегабайта, а не сколько-нибудь красивее: столько весит семинар на
 * тридцать человек, где КАЖДЫЙ нарисовал график, — то есть обычная пара
 * проходит целиком и ничего не замечает, а режется ровно поток на пятьсот, где
 * кадр иначе вырастает до десятков мегабайт. Когда пульт научится просить
 * вывод по карточке, число можно опускать: сделка станет честной в обе
 * стороны.
 */
const BOARD_OUTPUT_BUDGET = 4 * 1024 * 1024

/** Во сколько знаков обходится вывод одной попытки — грубо и без сборки строки. */
function outputWeight(run: CouncilRun): number {
  let total = 0
  for (const output of run.outputs) {
    if (output.kind === 'stream') total += output.text.length
    else if (output.kind === 'error') {
      total += output.ename.length + output.evalue.length
      for (const line of output.traceback) total += line.length
    } else for (const value of Object.values(output.data)) total += value.length
  }
  return total
}

/**
 * Стопка по бюджету вывода: что не поместилось — без выводов, но с признаком.
 *
 * Порядок стопки — по времени правки, и режется её хвост: свежее (то, что
 * преподаватель только что запустил и смотрит) остаётся с выводом.
 */
function withinBudget(board: CouncilBoard): CouncilBoard {
  let left = BOARD_OUTPUT_BUDGET
  let cut = false
  const attempts = board.attempts.map((attempt) => {
    const run = attempt.run
    if (!run || run.outputs.length === 0) return attempt
    const weight = outputWeight(run)
    if (!cut && weight <= left) {
      left -= weight
      return attempt
    }
    cut = true
    // Копия, а не правка на месте: `run` здесь — тот самый объект из кэша
    // попыток, и вычистить его значило бы стереть вывод у автора.
    return { ...attempt, run: { ...run, outputs: [], outputsOmitted: true } }
  })
  return cut ? { ...board, attempts } : board
}

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
      board: withinBudget(boardFor(sessionId, cellId, cell)),
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

/**
 * Отдать накопленное за окно одним кадром и начать копить заново.
 *
 * Под перехватом: половина вызовов сюда приходит из `setTimeout`, где бросок
 * ловить некому, — он уходит в `uncaughtException`, а тот уводит процесс со
 * всеми комнатами инстанса. Стопка одной ячейки не стоит чужого семинара, и
 * копить заново надо в любом случае: иначе одна неудачная сборка запирает
 * окно навсегда.
 */
function flushBoard(sessionId: string, cellId: string, state: BoardPending): void {
  const dirty = state.dirty
  state.dirty = new Set()
  state.last = Date.now()
  try {
    boardNow(sessionId, cellId, dirty)
  } catch (err) {
    console.error(
      `[control ${sessionId}] стопка ${cellId} не уехала:`,
      reason(err, 'unknown error'),
    )
  }
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

/**
 * Свой лист — одному человеку, на все его сокеты.
 *
 * `lock` — если положение замка уже прочитано снаружи. Замок один на ячейку, а
 * листы уходят пятистам: читать ради каждого одну и ту же ячейку (поиск по
 * всем массивам документа) значит пятьсот одинаковых обходов на одно нажатие.
 *
 * `position` — то же самое про номер в очереди: когда листы рассылаются пачкой
 * после сдвига очереди, номера всех ждущих уже посчитаны одним проходом
 * (`councilQueuePositions`), и искать в очереди ещё раз на каждого — тот же
 * квадрат, только с другой стороны.
 */
function mineOut(
  sessionId: string,
  cellId: string,
  participantId: string,
  cell?: CouncilCell,
  position?: number | null,
): void {
  const message = mineMessage(sessionId, cellId, participantId, cell, position)
  if (message) tell(sessionId, participantId, message)
}

function mineMessage(
  sessionId: string,
  cellId: string,
  participantId: string,
  known?: CouncilCell,
  knownPosition?: number | null,
): ControlServerMessage | null {
  // Замок и ручки читаются одним заходом: обе стороны листа — «идёт ли
  // консилиум» и «сколько ждать до следующего запуска» — живут на одной ячейке,
  // и второй её поиск по всем тетрадям стоил бы ровно столько же, сколько
  // первый.
  const cell = known ?? councilCellOf(sessionId, cellId)
  const position =
    knownPosition !== undefined
      ? knownPosition
      : councilQueuePosition(sessionId, cellId, participantId)
  const state = mineFor(
    sessionId,
    cellId,
    participantId,
    cell.lock !== 'council',
    // Ноль — «считается сейчас», и об этом говорит сам `run.state`.
    position !== null && position > 0 ? position : null,
    cell.settings.rerunPauseSec,
  )
  return state ? { t: 'council:mine', cellId, state } : null
}

/** «N сдали из M» — всей комнате, без текстов. */
function countOut(sessionId: string, cellId: string): void {
  const { submitted, total } = countFor(sessionId, cellId)
  broadcast(sessionId, { t: 'council:count', cellId, submitted, total })
}

/**
 * Что на экране по этой ячейке — всей комнате, включая студентов.
 *
 * Единственный кадр консилиума с чужим кодом, который уходит не только
 * преподавателю, и это ровно то, что сейчас стоит на проекторе: плашка под
 * ячейкой у всех — это подпись к тому, на что класс и так смотрит
 * (shared/protocol.ts · CouncilShown).
 *
 * Зовётся только там, где показ мог смениться: показали, убрали, автор
 * переписал показанный текст, преподаватель досчитал его запуск, щёлкнули
 * ручкой имён, забанили автора. На каждый кадр ядра — нет: в плашку едет
 * только досчитавшийся запуск, и промежуточные кадры в ней ничего не меняют.
 */
function shownOut(sessionId: string, cellId: string): void {
  const { settings } = councilCellOf(sessionId, cellId)
  broadcast(sessionId, {
    t: 'council:shown',
    cellId,
    shown: shownFor(sessionId, cellId, settings.namesOnProjector),
  })
}

/** Кто сейчас на экране по ячейке — без сборки кадра; `null` — никто. */
function shownWho(sessionId: string, cellId: string): string | null {
  for (const attempt of attemptsOf(sessionId, cellId)) {
    if (attempt.shown) return attempt.participantId
  }
  return null
}

/**
 * Номер в очереди, который каждый ждущий видел последним, — по комнате.
 *
 * Нужен, чтобы не слать кадр, в котором для человека ничего не изменилось:
 * очередь дёргается на каждое начало и каждый конец ЛЮБОЙ работы ядра.
 * Ключ — «ячейка и человек», значение — номер.
 */
const queueSent = new Map<string, Map<string, number>>()

/**
 * Очередь сдвинулась — каждому, кого сдвинуло, его новый номер.
 *
 * «Вы 37-й» без этого показывал бы номер на момент нажатия до конца пары.
 *
 * Уезжает ЧИСЛО, а не лист. Каждый конец любой работы ядра двигает номер у всех
 * ждущих сразу — то есть отсев «у этого не изменилось» не срабатывал никогда, —
 * и на пятистах попытках один досчитавшийся запуск рассылал пятьсот
 * `council:mine`. Каждый из них сервер собирал отдельно (`mineFor`: чтение
 * попытки из базы, её запуск, письма преподавателя) и вёз целиком, вместе с
 * текстом попытки и заданием, ради одного числа в нём. Замер на пятистах
 * ждущих: 0.32 МБ на сдвиг против 30 КБ.
 *
 * Комнате целиком очередь при этом не рассылается, хотя так её и собирали бы
 * один раз на всех: список из пятисот ждущих — одиннадцать килобайт, и уехал
 * бы он пятистам (замерено 5.65 МБ на сдвиг) ради одного числа каждому.
 * Дешевле собрать пятьсот кадров по шестьдесят байт — сборка такого кадра
 * стоит рядом с отправкой ничего.
 *
 * И `null` тому, кого в очереди больше нет: его попытка дошла до ядра. Раньше
 * об этом не говорил никто — рассылка шла только по тем, кто в очереди
 * остался, — и «вы 1-й» висел над считающейся попыткой до её конца.
 *
 * Номера — одним проходом по очереди, а не поиском в ней на каждого ждущего:
 * поштучный `councilQueuePosition` — это поиск по всей очереди на каждого её
 * участника, то есть четверть миллиона сравнений на один сдвиг при пятистах
 * попытках. Формула номера при этом одна и лежит в kernel/index.ts: здесь её
 * нет и не должно быть.
 */
function tellQueued(sessionId: string): void {
  const queued = councilQueuePositions(sessionId)
  const was = queueSent.get(sessionId)
  if (queued.length === 0 && !was) return
  const now = new Map<string, number>()
  for (const { cellId, participantId, position } of queued) {
    now.set(`${cellId}\n${participantId}`, position)
    if (was?.get(`${cellId}\n${participantId}`) === position) continue
    tell(sessionId, participantId, { t: 'council:queue', cellId, at: position })
  }
  for (const [key] of was ?? []) {
    if (now.has(key)) continue
    const split = key.indexOf('\n')
    tell(sessionId, key.slice(split + 1), { t: 'council:queue', cellId: key.slice(0, split), at: null })
  }
  if (now.size === 0) queueSent.delete(sessionId)
  else queueSent.set(sessionId, now)
}

/**
 * Чем занято ядро тетради этой ячейки — одному пульту, одним маленьким кадром.
 *
 * Собирается здесь, а не в ядре, ровно потому, что ядро не знает имён и не
 * умеет считать номер ячейки: у него есть `participantId` и `cellId`, а пульту
 * нужны «Петя» и «ячейка 7». Всё, что ядро знает само, приезжает из
 * `kernelWorkOf` неизменным — включая признак «не отвечает на прерывание».
 *
 * Имена здесь настоящие всегда: кадр едет одному преподавателю, а прятать их
 * за «Вариант 12» при выключенной ручке — дело пульта, как и у стопки.
 */
function kernelMessage(sessionId: string, cellId: string): ControlServerMessage | null {
  const work = kernelWorkOf(sessionId, cellId)
  // Область ещё не заводили — в этой тетради ничего не запускали ни разу.
  if (!work) return { t: 'council:kernel', cellId, kernel: { busy: null, queued: 0 } }
  const busy = work.busy
  if (!busy) return { t: 'council:kernel', cellId, kernel: { busy: null, queued: work.queued } }
  const found = findCell(getSessionDoc(sessionId).doc, busy.cellId)
  return {
    t: 'council:kernel',
    cellId,
    kernel: {
      queued: work.queued,
      busy: {
        kind: busy.kind,
        index: found ? found.index + 1 : null,
        // У попытки называется её АВТОР, а не тот, кто нажал: преподаватель,
        // запустивший чужое решение у доски, — не тот, чья это работа.
        name: displayName(sessionId, busy.participantId ?? busy.runById),
        participantId: busy.participantId,
        here: busy.kind === 'attempt' && busy.cellId === cellId,
        startedAt: busy.startedAt,
        limitSec: busy.limitSec,
        stuck: busy.stuck,
      },
    },
  }
}

function kernelOut(sessionId: string, cellId: string): void {
  const message = kernelMessage(sessionId, cellId)
  if (message) toTeachers(sessionId, message)
}

/**
 * Очередь тетради сдвинулась — сказать пультам, но не чаще окна.
 *
 * По всем ячейкам со стопкой, а не по одной: пульт открыт на одной ячейке, но
 * какой именно — сервер не знает и знать не должен (вкладку переключают без
 * него). Ячеек консилиума в занятии единицы, кадр — полсотни байт, и окно у
 * него то же, что у номеров очереди: очередь дёргается дважды на каждую
 * работу.
 *
 * Нет ни одного пульта — не собираем вовсе: на потоке очередь дёргается
 * непрерывно, а слушать её некому.
 */
function nudgeKernel(sessionId: string): void {
  if (!teachersOnline(sessionId)) return
  onTick(sessionId, 'ядро тетради', QUEUE_EVERY_MS, () => {
    if (!teachersOnline(sessionId)) return
    for (const id of new Set([...councilCells(sessionId), ...cellsWithAttempts(sessionId)])) {
      kernelOut(sessionId, id)
    }
  })
}

/**
 * Очередь дёрнулась — сказать ждущим новый номер, но не чаще окна.
 *
 * Раньше номера пересылались только на конце ЧУЖОЙ ПОПЫТКИ консилиума. Очередь
 * же одна на всю комнату, и номер студенту считает и ячейки впереди: пять
 * ячеек преподавательского Run All, досчитавшись, двигали его с шестого места
 * на первое — и не говорили ему об этом ни слова до конца следующей попытки.
 *
 * Окно — потому что очередь дёргается дважды на каждую работу ядра, а кадр
 * уходит каждому ждущему: на пятистах это заметная пачка, и склеить две
 * перемены подряд в одну дешевле, чем послать её дважды.
 */
const QUEUE_EVERY_MS = 250

function nudgeQueue(sessionId: string): void {
  onTick(sessionId, 'номера очереди', QUEUE_EVERY_MS, () => tellQueued(sessionId))
}

/** Комната опустела: очередь, которую в ней помнили, больше ничья. */
function forgetQueue(sessionId: string): void {
  queueSent.delete(sessionId)
}

/** Все, кому положен свой лист по этой ячейке: онлайн и те, у кого есть попытка. */
function councilAudience(sessionId: string, cellId: string): Set<string> {
  const people = new Set<string>(rooms.get(sessionId)?.byParticipant.keys())
  for (const attempt of attemptsOf(sessionId, cellId)) people.add(attempt.participantId)
  return people
}

/** Замок сменился — хосту стопка, каждому его лист, комнате счётчик и экран. */
function councilChanged(sessionId: string, cellId: string): void {
  boardOut(sessionId, cellId)
  // Ячейка читается один раз на всех: замок и ручки на ней одни, а листов
  // пятьсот.
  const cell = councilCellOf(sessionId, cellId)
  for (const participantId of councilAudience(sessionId, cellId))
    mineOut(sessionId, cellId, participantId, cell)
  countOut(sessionId, cellId)
  // И «что на экране»: сюда же приходит перемена ручки имён, а она решает,
  // чьим именем подписано показанное — или номером варианта вместо имени.
  shownOut(sessionId, cellId)
}

/** Revoke approvals when a class/cell closes or its execution policy changes. */
export function clearCouncilRunRequests(sessionId: string, cellId?: string): void {
  tellClearedRunRequests(sessionId, clearRunRequests(sessionId, cellId))
}

/** Persist the class transition and revoke old approvals as one operation. */
export function setClassFinished(sessionId: string, at: number | null): void {
  let changed: ReturnType<typeof clearRunRequests>
  try {
    changed = db.transaction(() => {
      setFinished(sessionId, at)
      return clearRunRequests(sessionId)
    })()
  } catch (error) {
    // Both stores cache writes; a rolled-back transaction must roll back reads too.
    resetCouncilCache(sessionId)
    forgetRules(sessionId)
    throw error
  }
  tellClearedRunRequests(sessionId, changed)
}

function tellClearedRunRequests(sessionId: string, changed: ReturnType<typeof clearRunRequests>): void {
  const cells = new Map<string, string[]>()
  for (const row of changed) {
    mineOut(sessionId, row.cellId, row.participantId)
    const people = cells.get(row.cellId) ?? []
    people.push(row.participantId)
    cells.set(row.cellId, people)
  }
  for (const [id, people] of cells) boardOut(sessionId, id, people)
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
  // Ячейки с консилиумом — один обход всех тетрадей комнаты, а не два: пачка
  // собирается на каждое подключение, а после сбоя сети их пятьсот подряд.
  const open = councilCells(sessionId)
  const cells = new Set<string>([...open, ...cellsWithAttempts(sessionId)])
  if (payload.role === 'host') {
    for (const id of cells) {
      send(ws, {
        t: 'council:board',
        cellId: id,
        // По бюджету вывода: у пульта, вернувшегося после обрыва, стопка на
        // пятьсот прогнанных попыток иначе весит десятки мегабайт — и это
        // первое, что он получает.
        board: withinBudget(boardFor(sessionId, id, councilCellOf(sessionId, id))),
      })
      // И чем занято ядро тетради: пульт, вернувшийся после обрыва, обязан
      // увидеть чужую работу, которая держит очередь, а не пустую карточку.
      const kernel = kernelMessage(sessionId, id)
      if (kernel) send(ws, kernel)
    }
  }
  const mine = new Set<string>([...open, ...cellsOfParticipant(sessionId, payload.participantId)])
  for (const id of mine) {
    const message = mineMessage(sessionId, id, payload.participantId)
    if (message) send(ws, message)
  }
  for (const id of cells) {
    const { submitted, total } = countFor(sessionId, id)
    send(ws, { t: 'council:count', cellId: id, submitted, total })
    /*
     * И «что на экране» — кадром на каждую ячейку, даже когда показывать
     * нечего.
     *
     * `null` здесь не лишний, а несущий: состояние консилиума живёт у клиента
     * дольше сокета, и вкладка, у которой связь оборвалась ДО «убрать с
     * экрана», вернулась бы с плашкой, которой у всех остальных уже нет, и
     * стояла бы с ней до следующего нажатия преподавателя. Цена — кадр в
     * шестьдесят байт рядом со счётчиком, который по тем же ячейкам едет уже.
     */
    send(ws, {
      t: 'council:shown',
      cellId: id,
      shown: shownFor(sessionId, id, councilCellOf(sessionId, id).settings.namesOnProjector),
    })
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
  /*
   * И очередь тоже: ядро на поток одно, а его минута, потраченная на код
   * человека, которого в комнате уже нет, — это минута, которую ждёт весь
   * остальной класс. Убираются все его ждущие попытки; если одна уже крутится,
   * прерывается только она, а чужая очередь дожидается конца этого interrupt.
   */
  purgeCouncilRunsOf(sessionId, participantId)
  for (const id of cells) {
    // Попытки уже нет — кадр назовёт человека в `removed`.
    boardOut(sessionId, id, [participantId])
    countOut(sessionId, id)
    // И плашка с его кодом, если на экране был он: забаненный уходит с экрана
    // вместе со своей попыткой, а не остаётся висеть под ячейкой у класса.
    shownOut(sessionId, id)
  }
  return gone
}

/** Целое в границах — иначе ручку считаем неприложенной. */
function whole(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null
}

/**
 * Ручки консилиума из сообщения — только известные значения.
 *
 * Непонятное ОТБРАСЫВАЕТСЯ, а не подменяется умолчанием: сообщение с одной
 * ручкой — это «переключить её», остальные остаются как были, и «предел 99999»
 * из чужого клиента не должен молча вернуть ячейку к тридцати секундам. Второй
 * замок — `readCouncilSettings` над слитыми ручками там, где их пишут в
 * документ: он чинит и то, что уже лежит в ячейке.
 */
function pickSettings(raw: unknown): Partial<CouncilSettings> {
  const out: Partial<CouncilSettings> = {}
  if (!raw || typeof raw !== 'object') return out
  const from = raw as Record<string, unknown>
  if (typeof from.studentRun === 'boolean' || from.studentRun === 'request') out.studentRun = from.studentRun
  if (typeof from.namesOnProjector === 'boolean') out.namesOnProjector = from.namesOnProjector
  // `null` у предела — законное значение и единственное не-число здесь: «без
  // предела» это выбор преподавателя, а не отсутствие ручки.
  if (from.runLimitSec === null) out.runLimitSec = null
  else {
    const limit = whole(from.runLimitSec, 1, COUNCIL_RUN_LIMIT_MAX)
    if (limit !== null) out.runLimitSec = limit
  }
  const pause = whole(from.rerunPauseSec, 0, COUNCIL_RERUN_PAUSE_MAX)
  if (pause !== null) out.rerunPauseSec = pause
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
  for (const cellId of cellIds) clearCouncilRunRequests(sessionId, cellId)
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
 * Только преподавателям: сводка читала тексты студентов, на проектор и в зал ей
 * нельзя. Регистрация здесь, а не в routes/council.ts: сокеты преподавателей
 * знает только этот модуль, а импорт control.ts из ai/council.ts замкнул бы
 * модули друг на друга — как и у onRefusal.
 *
 * И БЕЗ стопки следом. Она уезжала здесь ради подписей на чипах сводки, но
 * ни сводки, ни подписей больше нет, а пульт
 * кладёт оракула в свою стопку сам (council.svelte.ts · withOracle). Стоила эта
 * лишняя строка двух полных стопок на один вопрос — «читаю» и «готово», — то
 * есть двух кадров со всеми попытками и их выводами на каждое нажатие
 * «Спросить».
 */
onCouncilOracle((sessionId, cellId, oracle) => {
  toTeachers(sessionId, { t: 'council:oracle', cellId, oracle })
})

// The transcript is in the document; the terminal's health is not, so it comes
// down this channel the same way kernel status does.
onTerminalPhase((sessionId, status) => broadcast(sessionId, { t: 'terminal', status }))

/* ----------------------------------------------------------------- doc */

/**
 * Состояние ядра одной тетради — по её записи в карте `meta.kernels`.
 *
 * Без корня — тетрадь комнаты: так читает вкладка, открытая до того, как ядер
 * стало несколько, и так же отвечает первый кадр `ready`.
 */
function kernelStatus(sessionId: string, root: string = CELLS_KEY): KernelStatus {
  try {
    return bookKernel(getSessionDoc(sessionId).doc, root).status
  } catch {
    return 'starting'
  }
}

/** Состояние ядер по тетрадям — то, что едет в первом кадре сокета. */
function kernelStatuses(sessionId: string): Array<{ book: string; status: KernelStatus }> {
  try {
    const { doc } = getSessionDoc(sessionId)
    return bookList(doc).map((book) => ({
      book: book.path,
      status: bookKernel(doc, book.root).status,
    }))
  } catch {
    return []
  }
}

/**
 * Kernel health lives in the document, so the browser already re-renders from
 * there. Mirroring it onto this socket costs one small frame and keeps clients
 * that are watching only the control channel honest.
 *
 * И заодно — очередь. Она в том же `meta` (kernel/index.ts · syncQueue), и её
 * зеркало меняется на каждый сдвиг: ячейка встала, ячейка досчиталась, попытка
 * пошла в работу. Отсюда ждущим уходит новый номер — единственное место, где
 * он честен по любому поводу, а не только по концу чужой попытки консилиума.
 *
 * `observeDeep`, а не `observe`: список очереди — вложенный Y.Array, и его
 * правку (а это самый частый сдвиг) карта наружу не показывает.
 */
function watchRoomMeta(sessionId: string): () => void {
  const { doc } = getSessionDoc(sessionId)
  const meta = getMeta(doc)
  /*
   * Прежнее состояние — ПО ТЕТРАДЯМ.
   *
   * Одно поле `last` на комнату означало бы, что вторая тетрадь, ставшая
   * `busy` следом за первой, кадра не получает вовсе: значение то же. Кадр при
   * этом называет свой лист, и старая вкладка читает его как прежде — поле
   * `book` она просто не знает.
   */
  const last = new Map<string, KernelStatus>()
  /*
   * Список тетрадей обходится ТОЛЬКО когда изменилась карта ядер.
   *
   * `observeDeep` будит нас на каждый сдвиг очереди — два раза на ячейку, а при
   * Run All на сорок ячеек это восемьдесят раз подряд, всей комнате. Пока полей
   * было два, обход стоил двух чтений; теперь это проход по списку тетрадей с
   * чтением записи каждой. Путь события от `meta` и говорит, куда писали:
   * `['kernels', <корень>, …]` — в карту, пустой путь с ключом `kernels` — её
   * только что завели.
   */
  const touchesKernels = (events: Y.YEvent<any>[]): boolean =>
    events.some(
      (event) =>
        event.path[0] === KERNELS_KEY ||
        (event.path.length === 0 &&
          (event as Y.YMapEvent<any>).keysChanged?.has(KERNELS_KEY) === true),
    )
  const onChange = (events: Y.YEvent<any>[]) => {
    if (touchesKernels(events)) {
      for (const book of bookList(doc)) {
        const status = bookKernel(doc, book.root).status
        if (last.get(book.root) === status) continue
        last.set(book.root, status)
        broadcast(sessionId, { t: 'kernel', status, book: book.path })
      }
    }
    nudgeQueue(sessionId)
  }
  meta.observeDeep(onChange)
  return () => meta.unobserveDeep(onChange)
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

/**
 * Кадр толще потолка — это не мусор, и молчать про него нельзя.
 *
 * Раньше он выбрасывался здесь же, вместе с неразборчивым: ни ошибки, ни
 * строки в журнале. Для попытки консилиума это худшее, что провод может
 * сделать, — студент дописывает лист, снимки перестают доезжать МОЛЧА, и на
 * «Сдать» преподаватель видит текст получасовой давности. Отдельный ответ, а
 * не `null`.
 */
const TOO_BIG = 'too-big'

function parse(data: RawData): ControlClientMessage | typeof TOO_BIG | null {
  const text = frameText(data)
  if (text.length === 0) return null
  if (text.length > MAX_FRAME_BYTES) return TOO_BIG
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
const OVER = 'server.classOverPeriod'

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
    message: actsAfterClass(isFinished(sessionId), payload.role) ? message : tr(OVER),
  })
}

/**
 * Одна фраза на отказ по правилу `run` — и потому она константа.
 *
 * Запуск ячейки теперь спрашивает право, уже зная про замок, и потому называет
 * фразу сам; без общего имени в коде оказалось бы два одинаковых предложения,
 * из которых однажды поправят одно.
 */
const RUN_IS_THE_TEACHERS = () => tr("server.onlyTheTeacherRunsCellsInThis.21ec54")

/* ------------------------------------------- правила ОТДЕЛЬНОЙ тетради */

/**
 * Кто спрашивает — в той форме, в какой это читают правила тетради.
 *
 * Имя нужно ровно одному вопросу: его ли это личная тетрадь (shared/rules.ts ·
 * BookRule.owner). Всё остальное решается ролью, как и решалось.
 */
function asker(payload: TokenPayload): Asker {
  return { role: payload.role, participantId: payload.participantId }
}

/**
 * Кто заводит тетрадь — для записи об авторе.
 *
 * Имя берётся здесь, в момент заведения, а не ищется потом: тетрадь переживает
 * семестр, участника из базы могли и убрать, и «личная тетрадь: —» не объясняет
 * ничего (shared/rules.ts · BookRule.ownerName). Преподавателя запись не
 * касается — `rememberAuthor` отсеивает его сам, и роль едет сюда ровно затем.
 */
function authorOf(sessionId: string, payload: TokenPayload): BookAuthor {
  return {
    participantId: payload.participantId,
    name: displayName(sessionId, payload.participantId),
    role: payload.role,
  }
}

/**
 * Корень тетради, в которой лежит эта ячейка.
 *
 * `null` — такой ячейки в комнате нет. Тогда права решают правила комнаты, и
 * отказ говорит про них: рассуждать о доступе к тетради, которой у ячейки нет,
 * не о чем.
 */
function rootOf(sessionId: string, cellId: string): string | null {
  return rootOfCell(getSessionDoc(sessionId).doc, cellId)
}

/**
 * Корень НАЗВАННОЙ тетради — или тетради комнаты, если её не назвали.
 *
 * Без имени подразумевается первая тетрадь: так читаются сообщения вкладок,
 * открытых до того, как тетрадей стало несколько (см. `bookOf`). `null` —
 * названа тетрадь, которой в комнате нет; зовущий отвечает на это своим
 * NO_SUCH_BOOK, а не молча правилами комнаты.
 */
/**
 * В какой лист СОБРАН этот список ячеек — по первой из них.
 *
 * Отдельно от `rootOfBook`, и это не педантизм. Без имени листа права
 * спрашиваются у `mainRoot` (первой тетради по порядку), а ячейки собирает
 * `codeCellIds` из корня `cells` — и у комнаты, где тетрадь комнаты убрали, эти
 * два ответа расходятся. Очередь при этом принимает только ячейки СВОЕЙ тетради
 * (kernel/index.ts · requestRun), так что разойдясь, они дали бы Run All,
 * который молча не делает ничего. Очередь спрашивает у самих ячеек.
 */
function rootOfCells(sessionId: string, ids: string[]): string {
  for (const id of ids) {
    const root = rootOf(sessionId, id)
    if (root) return root
  }
  return CELLS_KEY
}

function rootOfBook(sessionId: string, book: string | undefined): string | null {
  const doc = getSessionDoc(sessionId).doc
  return book ? (bookAt(doc, book)?.root ?? null) : mainRoot(doc)
}

/**
 * Действующие правила ОДНОЙ тетради для ЭТОГО человека.
 *
 * Та же функция, которой считает серые кнопки браузер и судит кадры гейт
 * (shared/rules.ts · rulesForBook). Второй копии развилки «чья это тетрадь» в
 * продукте нет намеренно — расходятся такие копии молча и в сторону кнопки,
 * которая нажимается и приносит отказ.
 */
function rulesIn(sessionId: string, payload: TokenPayload, root: string | null): RoomRules {
  return rulesForBook(getRules(sessionId), root, asker(payload))
}

/**
 * Слова отказа: тетради, когда отказала она, и комнаты во всех прочих случаях.
 *
 * «В этом семинаре запускает преподаватель», сказанное про чужую личную
 * тетрадь, отправляет человека к преподавателю, который ничего не запрещал.
 * Конец занятия поверх этого накладывает `refuse` — одной фразой на всё.
 */
function whyIn(
  sessionId: string,
  payload: TokenPayload,
  root: string | null,
  own: string,
): string {
  const book = bookRefusal(getRules(sessionId), root, asker(payload))
  return book ? tr(book.key, { p0: book.name }) : own
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
 *
 * `cellOpen` — замок на ячейке: преподаватель открыл вот эту одну, и в ней
 * комната считает даже там, где вообще запускает он. Умолчание `false`, и это
 * важнее, чем кажется: тем же helper'ом спрашивают Run All, запуск файла и
 * команду оболочки, а открытая ячейка ни листа, ни терминала не открывает —
 * она открыта одна и ровно одна.
 *
 * `root` — тетрадь, в которую метит нажатие: у неё может быть свой доступ, и
 * тогда правило комнаты подменяется им (`rulesIn`). Умолчание `null` — «речь не
 * про тетрадь», и его берут `file:run` и `term:run`: скрипт из дерева и команда
 * в общей оболочке — это ядро комнаты, а не чья-то тетрадь, и открывать их
 * личной тетрадью было бы дырой ровно в том правиле, ради которого она заведена.
 */
function mayRun(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  message = RUN_IS_THE_TEACHERS(),
  cellOpen = false,
  root: string | null = null,
): boolean {
  if (mayRunCell(rulesIn(sessionId, payload, root), payload.role, cellOpen, isFinished(sessionId))) {
    return true
  }
  refuse(ws, sessionId, payload, whyIn(sessionId, payload, root, message))
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
 * То же для правки ОДНОЙ ячейки — и тоже с замком.
 *
 * Ровно тот же вопрос, что задаёт гейт CRDT на набор в этой ячейке
 * (collab/gate.ts) и клиент на серую кнопку (web/src/lib/may.ts). Открытая
 * ячейка — право поверх правил: в лекционной тетради зал в ней печатает и
 * запускает, и спрашивать про неё голое `rules.edit` значит отвечать «тетрадь
 * принадлежит преподавателю» про ячейку, которую преподаватель открыл.
 */
function mayEditThis(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  cellId: string,
): boolean {
  const open = cellIsOpen(sessionId, cellId)
  // И по правилам ТОЙ ТЕТРАДИ, в которой ячейка лежит: у личной тетради свой
  // ответ на «кто здесь печатает», и он сильнее комнатного в обе стороны.
  const root = rootOf(sessionId, cellId)
  if (mayEditCell(rulesIn(sessionId, payload, root), payload.role, open, isFinished(sessionId))) {
    return true
  }
  refuse(
    ws,
    sessionId,
    payload,
    whyIn(sessionId, payload, root, tr("server.onlyTheTeacherMayEditTheNotebook.d8abb3")),
  )
  return false
}

/**
 * А это — про весь лист сразу, и оно отдельное от предыдущего.
 *
 * Ядро одно, и разница между «двадцать человек считают» и «двадцать человек
 * забили очередь на восемьсот ячеек» ровно здесь. «По одной» разрешает нажать
 * на ячейке и запрещает Run All.
 */
function mayBulkRun(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  root: string | null = null,
): boolean {
  // Весь лист — это лист ОДНОЙ тетради, и спрашивать надо у неё: Run All в
  // своей личной тетради не должен упираться в лекционное правило комнаты,
  // а в чужой личной — не должен проходить при открытой.
  if (allowsRun(rulesIn(sessionId, payload, root).run, payload.role, 'bulk')) return true
  refuse(
    ws,
    sessionId,
    payload,
    whyIn(sessionId, payload, root, tr("server.onlyTheTeacherMayRunTheWhole.8359b5")),
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
    message: tr("server.aLectureIsUsingEndTheLecture.056f12", { p0: baseOf(going.file) }),
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
 *
 * `root` — в чью очередь. Очередей теперь столько, сколько тетрадей, и потолок
 * считается по каждой отдельно: «по одной» значит «по одной в тетради», иначе
 * ячейка, считающаяся в лекции, запирала бы человеку его собственный черновик.
 * Правило при этом комнатное (`getRules`, а не `rulesIn`) и таким остаётся:
 * потолок очереди — не право доступа к тетради.
 */
function queue(
  ws: WebSocket,
  sessionId: string,
  payload: TokenPayload,
  ids: string[],
  root: string = CELLS_KEY,
): void {
  if (ids.length === 0) return
  const refused = requestRun(
    sessionId,
    ids,
    displayName(sessionId, payload.participantId),
    payload.participantId,
    runQueueCap(getRules(sessionId).run, payload.role),
    root,
  )
  if (refused > 0) {
    send(ws, {
      t: 'error',
      message: tr("server.youMayRunOneCellAtA.35e7c7"),
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
const TOO_DEEP = () => tr("server.pathsMayBeUpToLevelsDeep.8e0b25", { p0: MAX_DEPTH })

/**
 * Почему путь не годится — теми же словами, что и в поле ввода панели.
 *
 * Отказ приходит на последний сегмент: остальные человек не набирал, они
 * пришли из дерева, и жаловаться на них значило бы указывать не туда.
 */
function refusedPath(raw: unknown): string {
  const shown = typeof raw === 'string' ? raw : ''
  const last = shown.split('/').filter(Boolean).pop() ?? ''
  if (!last) return tr("server.theNameCannotBeEmpty.fc2696")
  if (shown.split('/').filter(Boolean).length > MAX_DEPTH) return TOO_DEEP()
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
    if (into === parentOf(source)) return tr("server.alreadyExistsInThisFolder.3e8b1f", { p0: name })
    return into
      ? tr("server.alreadyExistsInFolder.2f1ace", { p0: name, p1: baseOf(into) })
      : tr("server.alreadyExistsInTheRoomSRoot.229dba", { p0: name })
  }
  if (outcome === 'missing') return tr("server.isNoLongerInThisRoom.2ab165", { p0: baseOf(source) })
  if (outcome === 'too-deep') return TOO_DEEP()
  /*
   * Виновата не та запись, которую переставляют, — её путь короток, — а то, что
   * лежит внутри: после переезда путь до него длиннее адресуемого, и открыть,
   * скачать или убрать его поштучно уже нечем. Панель говорит это теми же
   * словами (`tooLong` в tree-move.ts), не дожидаясь круга по сети.
   */
  if (outcome === 'too-long') {
    return tr("server.cannotMoveANestedPathWouldExceed.541d8f", { p0: baseOf(source), p1: MAX_PATH })
  }
  // Получить его можно единственным способом: попросить положить внутрь файла
  // (`отчёт.py/данные.csv`). Корень папкой быть не перестаёт, так что имя того,
  // во что не влезло, здесь есть всегда.
  if (outcome === 'not-a-folder') {
    return tr("server.isAFileChooseADestinationFolder.298ed2", { p0: baseOf(parentOf(target)) })
  }
  if (outcome === 'bad-name') return whySegmentRefused(name)
  return tr("server.isBusyTryAgainInAMoment.bb101a", { p0: baseOf(source) })
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
const NO_SUCH_BOOK = () => tr("server.thisNotebookIsNoLongerInThe.513a76")

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined
}

/* --------------------------------------------- дополнение и справка ядра */

/**
 * Потолок текста, который едет ядру на дополнение.
 *
 * Двадцать четыре килобайта — это ячейка на восемьсот строк, каких в тетради
 * не бывает; а кадр пульта режется на тридцати двух (MAX_FRAME_BYTES), и
 * между этими числами должно остаться место под сам JSON. Клиент режет у себя
 * (session.svelte.ts), сервер режет ещё раз: клиент не единственный, кто умеет
 * открыть этот сокет, а `complete_request` с мегабайтом кода — это jedi,
 * разбирающий мегабайт, на ядре, которое в этот момент общее для всей комнаты.
 */
const MAX_COMPLETE_CHARS = 24 * 1024

/**
 * Сколько вопросов о дополнении один сокет вправе задавать.
 *
 * Подсказка спрашивается НА НАЖАТИЕ КЛАВИШИ, и это делает её единственным
 * сообщением пульта, которое человек отправляет десятками в секунду, ничего
 * при этом не нажимая осознанно. Ведро на десять в секунду — это быстрее,
 * чем печатает человек, и медленнее, чем вкладка, у которой что-то заело;
 * четыре в полёте — потому что ядро отвечает по одному, и пятый вопрос всё
 * равно ждал бы своей очереди на shell.
 *
 * Перебравшему отвечаем ПУСТЫМ ответом, а не молчанием: обещание на клиенте
 * должно чем-то разрешиться, иначе редактор будет ждать своей подсказки до
 * таймаута и не покажет даже слова из самой ячейки.
 */
const ASK_PER_SECOND = 10
const ASK_BURST = 10
const ASK_IN_FLIGHT = 4

interface AskBudget {
  /** Ведро, пополняемое временем; дробное — доливается по миллисекундам. */
  tokens: number
  at: number
  /** Сколько вопросов этого сокета ядро ещё не закрыло. */
  flight: number
}

/*
 * По сокету, а не по человеку: ограничение тут про провод и про ядро, а
 * вкладка — это и есть провод. WeakMap по той же причине, что у `owner`:
 * закрытый сокет уносит свою запись сам, и чистить за ним нечего.
 */
const asking = new WeakMap<WebSocket, AskBudget>()

function mayAsk(ws: WebSocket): boolean {
  const now = Date.now()
  const budget = asking.get(ws) ?? { tokens: ASK_BURST, at: now, flight: 0 }
  asking.set(ws, budget)
  budget.tokens = Math.min(ASK_BURST, budget.tokens + ((now - budget.at) * ASK_PER_SECOND) / 1000)
  budget.at = now
  if (budget.flight >= ASK_IN_FLIGHT || budget.tokens < 1) return false
  budget.tokens -= 1
  budget.flight += 1
  return true
}

function askDone(ws: WebSocket): void {
  const budget = asking.get(ws)
  if (budget && budget.flight > 0) budget.flight -= 1
}

/**
 * Двадцать четыре килобайта, КОНЧАЮЩИЕСЯ курсором.
 *
 * Начало режется, а не конец: дополняют то, что стоит перед кареткой, и
 * тысяча строк ниже по ячейке разбору не нужна вовсе. Курсор при этом
 * переезжает вместе с текстом — иначе ядро дополняло бы другое место.
 */
function trimToCursor(code: string, cursor: number): { code: string; cursor: number } {
  const at = Math.max(0, Math.min(cursor, code.length))
  const head = code.slice(0, at)
  if (head.length <= MAX_COMPLETE_CHARS) return { code: head, cursor: at }
  return { code: head.slice(head.length - MAX_COMPLETE_CHARS), cursor: MAX_COMPLETE_CHARS }
}

/**
 * Право на подсказку — то же самое, что право запустить ячейку.
 *
 * И это не осторожность ради осторожности. `complete_request` спрашивает
 * ЖИВОЕ ядро тетради: по `df.` видно, какие у преподавателя переменные, по
 * `_` — что он считал последним, а `__builtins__.` вместе со справкой читается
 * как оглавление чужого сеанса. Комната, где запускает преподаватель, — это
 * комната, где состояние ядра принадлежит ему; читать его через подсказку
 * было бы обходом правила, а не удобством.
 *
 * Замок на ячейке по догадке здесь по-прежнему не спрашивается — но кадр
 * теперь МОЖЕТ назвать ячейку сам, и это меняет ровно один случай: свой лист
 * консилиума.
 *
 * Лист — та единственная ячейка, в которой студенту велено писать код: за этим
 * консилиум и открывают. В лекционной комнате (`run: 'host'`) прежнее правило
 * отказывало в нём каждому, и отказывало молча: имена приезжали из слов самой
 * ячейки, а столбцы настоящего `df`, ради которого задание и дано, — нет.
 * Обхода правила тут нет: попытка и так считается в ядре СВОЕЙ тетради
 * (`council:run` с ручкой преподавателя), и то же состояние, которое подсказка
 * покажет, человек в этой ячейке и так может напечатать и запустить.
 *
 * Имя ячейки доверяется потому, что проверяется: замок читается из документа
 * комнаты, а не из кадра. Назвал чужую ячейку не в консилиуме — правило
 * прежнее; назвал ячейку в консилиуме — значит она в консилиуме у всех.
 */
/**
 * По каким листам подсказка сейчас в пути — `sessionId:cellId:participantId`.
 *
 * Второе нажатие, пока первое идёт, — второй запрос к модели и вторая строка
 * расхода: кнопка гаснет на клиенте, но клиент здесь не единственный, кто
 * может прислать кадр. Память местная и умирает с процессом: незавершённый
 * запрос его не переживёт.
 */
const hintsReading = new Set<string>()

function mayComplete(sessionId: string, payload: TokenPayload, cellId?: unknown): boolean {
  const id = optionalId(cellId)
  if (id && councilCellOf(sessionId, id).lock === 'council') {
    return mayWriteCouncil(payload.role, isFinished(sessionId), false)
  }
  return mayWake(sessionId, payload, cellId)
}

/**
 * Может ли этот вопрос ПОДНЯТЬ ядро комнаты — то есть право нажать «Запустить».
 *
 * «Право = запуск» — и запуск в ТОЙ ТЕТРАДИ, где набирают. Иначе подсказки
 * молчали бы в собственной тетради студента посреди лекции: он там пишет и
 * считает, а дополнение отвечало бы пустотой, потому что комната закрыта.
 *
 * Отдельно от `mayComplete` ровно из-за одной развилки: тот пускает к подсказке
 * ещё и своего листа консилиума, где студент пишет код в лекционной комнате.
 * Читать состояние ядра оттуда можно, а ЗАВОДИТЬ комнате Python — нет: пуск
 * видит вся комната («запускается окружение») и греет машину на полторы
 * минуты. Кто нажимает Run, тот и будит.
 *
 * Законченное занятие сюда не попадает: `mayRunCell` спрашивают вместе с
 * `isFinished`, и в закрытой комнате ядро не поднимает уже никто.
 */
function mayWake(sessionId: string, payload: TokenPayload, cellId?: unknown): boolean {
  const id = optionalId(cellId)
  const root = id ? rootOf(sessionId, id) : null
  return mayRunCell(rulesIn(sessionId, payload, root), payload.role, false, isFinished(sessionId))
}

/**
 * Шапка импортов тетради — строки `import …` из ячеек кода ВЫШЕ этой.
 *
 * Нужна статическому разбору справки: jedi отвечает про `sns.lmplot`, только
 * если знает, что `sns` — это seaborn, а знать это в тетради неоткуда, кроме
 * ячейки с импортами. Область видимости в тетради — не ячейка, а ядро: шапка
 * ровно это и повторяет (kernel/inspect-static.ts · `importHeader`).
 *
 * Выше — и только выше: тетрадь читают и запускают сверху вниз, и импорт,
 * написанный ниже места, где набирают, в этот момент ещё ничего не значит.
 *
 * И только СВОЕЙ тетради. Ядер теперь столько, сколько тетрадей, и шапка,
 * собранная по соседней, рассказала бы jedi про импорты, которых в этом Python
 * нет вовсе: корень приезжает сюда тот же, которым выбрано ядро.
 */
function importsAbove(sessionId: string, root: string, cell: string | undefined): string {
  if (!cell) return ''
  const doc = peekSessionDoc(sessionId)?.doc ?? getSessionDoc(sessionId).doc
  const cells = bookCells(doc, root)
  for (let i = 0; i < cells.length; i++) {
    if (cellId(cells.get(i)) !== cell) continue
    const above: string[] = []
    for (let k = 0; k < i; k++) {
      const one = cells.get(k)
      if (cellType(one) !== 'code') continue
      above.push(cellSource(one).toString())
    }
    return importHeader(above)
  }
  return ''
}

/**
 * Спросить ядро и ответить — или ответить пустым, что бы ни случилось.
 *
 * Пустой ответ на КАЖДУЮ беду: нет права, нет ядра, ядро занято, вопросов
 * больше позволенного, ядро бросило. Обещание на той стороне должно
 * разрешиться всегда.
 *
 * У ДОПОЛНЕНИЯ пустой ответ к тому же безмолвный, и это правило: список
 * спрашивается на каждую букву, и тост «здесь запускает преподаватель» на
 * каждую набранную точку — наказание за печатание. А у СПРАВКИ с 19.09 к
 * пустому ответу прилагается причина (`inspect:reply.reason`): её спрашивают
 * наведением, то есть осознанно и по одному разу, и молчание в ответ на жест
 * читается как поломка — «она не всегда появляется». Причина едет одним словом
 * (protocol.ts · `InspectMiss`), а слова к ней подбирает клиент: тексты живут
 * на языке комнаты, а не на языке сервера.
 *
 * В журнал занятия не пишется ничего. Журнал — это то, что человек СДЕЛАЛ
 * («запустил ячейку», «открыл терминал»); нажатая точка — не поступок, а
 * тысяча строк «спросил дополнение» за пару похоронила бы в нём всё
 * остальное.
 */
function askKernel(
  ws: WebSocket,
  sessionId: string,
  payload: TokenPayload,
  message: Extract<ControlClientMessage, { t: 'complete' | 'inspect' }>,
): void {
  const id = message.id
  if (typeof id !== 'number' || !Number.isFinite(id)) return
  /** Отказ до всякого похода к ядру: причина у него одна — «спрашивать было нельзя». */
  const empty: ControlServerMessage =
    message.t === 'complete'
      ? { t: 'complete:reply', id, matches: [], start: 0, end: 0 }
      : { t: 'inspect:reply', id, found: false, reason: 'refused' }
  if (typeof message.code !== 'string' || typeof message.cursor !== 'number') {
    send(ws, empty)
    return
  }
  if (!mayComplete(sessionId, payload, message.cellId) || !mayAsk(ws)) {
    send(ws, empty)
    return
  }
  const { code, cursor } = trimToCursor(message.code, message.cursor)
  /*
   * Спрашиваем ядро ТОЙ тетради, в которой набирают.
   *
   * Ядер теперь столько, сколько тетрадей, и дополнение обязано знать про
   * переменные своего листа: `df.` в семинаре — это `df` семинара, а не тот,
   * что преподаватель загрузил на лекции. Кадр называет ячейку; ячейка — свою
   * тетрадь. Ячейки нет (пишут в пустом месте) — тетрадь комнаты, как раньше.
   *
   * Той же тетрадью меряется и всё остальное, что знает эта дверь: право
   * поднять ядро (`mayWake`) и шапка импортов для статического разбора
   * (`importsAbove`). Спросить одну тетрадь, а ответить по другой — самый
   * тихий способ показать человеку чужие переменные.
   */
  const askRoot = (message.cellId ? rootOf(sessionId, message.cellId) : null) ?? CELLS_KEY
  const wake = mayWake(sessionId, payload, message.cellId)
  if (message.t === 'complete') {
    void completeIn(sessionId, code, cursor, askRoot, { mayWake: wake })
      .then((result) => {
        if (result === null) {
          send(ws, empty)
          return
        }
        send(ws, {
          t: 'complete:reply',
          id,
          matches: result.matches.map(({ text, type }) => (type ? { text, type } : { text })),
          start: result.cursorStart,
          end: result.cursorEnd,
        })
      })
      .catch(() => send(ws, empty))
      .finally(() => askDone(ws))
    return
  }
  /*
   * Вопрос про ЗНАЧЕНИЕ — своя короткая дорога.
   *
   * Ни справки, ни подъёма ядра, ни статического разбора: тип и размер
   * объекта, который в ядре уже лежит. Нет ядра или оно занято — ответ пуст, и
   * клиент молчит: про переменную либо есть мгновенный ответ, либо ничего
   * (kernel/index.ts · `briefIn`).
   */
  if (message.brief === true) {
    void briefIn(sessionId, nameChainAt(code, cursor), askRoot)
      .then((brief) => {
        send(ws, { t: 'inspect:reply', id, found: brief !== null, ...(brief ? { brief } : {}) })
      })
      .catch(() => send(ws, empty))
      .finally(() => askDone(ws))
    return
  }
  void inspectIn(sessionId, code, cursor, askRoot, {
    mayWake: wake,
    header: importsAbove(sessionId, askRoot, optionalId(message.cellId)),
  })
    .then((result) => {
      send(ws, {
        t: 'inspect:reply',
        id,
        found: result.found,
        ...(result.text === null ? {} : { text: result.text }),
        ...(result.reason === null ? {} : { reason: result.reason }),
      })
    })
    .catch(() => send(ws, empty))
    .finally(() => askDone(ws))
}

/**
 * Двадцать четыре килобайта ВОКРУГ каретки — тот же потолок, что у соседей, и
 * стоит он здесь по тому же поводу: клиент режет у себя (session.svelte.ts ·
 * windowAroundCursor), а сервер режет ещё раз, потому что клиент не
 * единственный, кто умеет открыть этот сокет.
 *
 * Но режется иначе, и это единственная развилка на всю дорогу. Дополнению
 * довольно текста ДО каретки, а определение почти всегда стоит НИЖЕ места,
 * откуда по нему щёлкнули: `helper()` в третьей строке при `def helper()` в
 * тридцатой — обычная ячейка, обратный порядок — редкость. Обрезав хвост, как
 * `trimToCursor`, сервер честно отвечал бы «не нашлось, где определено» ровно
 * там, где переход нужнее всего, — в длинном файле.
 *
 * Курсор переезжает ровно на столько, сколько срезано слева: разъехавшись на
 * символ, разбор взял бы ДРУГОЕ имя — и увёл бы уверенно и не туда.
 */
function windowAround(code: string, cursor: number): { code: string; cursor: number; from: number } {
  const at = Math.max(0, Math.min(cursor, code.length))
  if (code.length <= MAX_COMPLETE_CHARS) return { code, cursor: at, from: 0 }
  const half = Math.floor(MAX_COMPLETE_CHARS / 2)
  const start = Math.max(0, Math.min(at - half, code.length - MAX_COMPLETE_CHARS))
  return { code: code.slice(start, start + MAX_COMPLETE_CHARS), cursor: at - start, from: start }
}

/**
 * Где это определено — третий вопрос той же формы и единственный, на который
 * отвечает не ядро.
 *
 * ПРАВА здесь не спрашиваются, и это решение, а не пропуск. `mayComplete` у
 * соседей — про чтение состояния ЖИВОГО ядра: по `df.` видно переменные
 * преподавателя, по `_` — что он считал последним, и в лекционной комнате это
 * его и только его. Переход к определению не трогает ядро вовсе: он читает
 * документ комнаты и .py-файлы её папки — то самое, что каждый участник и так
 * видит в тетради и в панели файлов, и читает через CRDT без всякого спроса.
 * Поставить сюда `mayComplete` значило бы погасить переход всей группе в
 * лекции — за чтение того, что у них и так открыто на экране.
 *
 * Ведро `mayAsk` переиспользуется как есть. Щелчок редок, и человеку это ведро
 * не помеха; но кадр в сокет умеет слать не только редактор, а каждый такой
 * вопрос — это обход папки семинара и разбор до восьмидесяти файлов
 * (definitions.ts · MAX_FILES_READ). `askDone` тут же, в `finally`: ядра никто
 * не ждёт, ответ считается здесь и сейчас, и держать место «в полёте» не за
 * чем — иначе пятый щелчок подряд отказывал бы навсегда.
 *
 * В журнал занятия не пишется ничего — по тому же доводу, что у дополнения:
 * журнал про поступки, а прочитать, где определена функция, поступком не
 * является.
 */
function answerDefine(
  ws: WebSocket,
  sessionId: string,
  message: Extract<ControlClientMessage, { t: 'define' }>,
): void {
  const id = message.id
  if (typeof id !== 'number' || !Number.isFinite(id)) return
  /*
   * Ответ на всякую беду — `nothing`, а не молчание: обещание на той стороне
   * обязано разрешиться. И именно `nothing`, потому что его одного клиент
   * проживает МОЛЧА (goto.svelte.ts · words): там, где сервер отказал по
   * ведру или не разобрал кадр, человеку сказать нечего — жест он сделал
   * правильный, объяснять ему нечего.
   */
  const nothing: ControlServerMessage = { t: 'define:reply', id, miss: { why: 'nothing' } }
  if (typeof message.code !== 'string' || typeof message.cursor !== 'number') {
    send(ws, nothing)
    return
  }
  if (!mayAsk(ws)) {
    send(ws, nothing)
    return
  }
  try {
    const { code, cursor, from } = windowAround(message.code, message.cursor)
    /*
     * Срез складывается: клиент мог отрезать своё окно (session.svelte.ts ·
     * windowAroundCursor), а здесь режется второй раз — от чужого клиента,
     * который потолка не знает. Строки считаются от НАЧАЛА ИСХОДНИКА, и оба
     * среза обязаны доехать до `defineIn` одним числом.
     */
    const cut =
      (typeof message.from === 'number' && Number.isFinite(message.from) && message.from > 0
        ? Math.floor(message.from)
        : 0) + from
    const cellId = optionalId(message.cellId)
    const path =
      typeof message.path === 'string' && message.path.length > 0 && message.path.length <= MAX_PATH
        ? message.path
        : undefined
    const answer = defineIn(sessionId, code, cursor, cellId, path, cut)
    send(ws, { t: 'define:reply', id, ...answer })
  } catch (error) {
    // Разбор чужого кода — место, где ошибиться можно на любом углу, а цена
    // такой ошибки не должна быть «упал сокет комнаты». Молчаливый `nothing`
    // и строка в консоль: человеку переход просто не сработал.
    if (seldom('define-failed')) console.warn('[control] переход к определению не удался:', error)
    send(ws, nothing)
  } finally {
    askDone(ws)
  }
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
      if (
        !mayRun(
          sessionId,
          payload,
          ws,
          RUN_IS_THE_TEACHERS(),
          cellIsOpen(sessionId, id),
          // И тетрадь этой ячейки: у личной свой ответ на «кто здесь запускает».
          rootOf(sessionId, id),
        )
      ) {
        return
      }
      queue(ws, sessionId, payload, [id], rootOf(sessionId, id) ?? CELLS_KEY)
      return
    }

    /*
     * Дополнение и справка — единственные два кадра пульта, которые приходят
     * на нажатие КЛАВИШИ, а не на нажатие кнопки. Поэтому у них своя дверь с
     * ведром, ответ в классе «можно потерять», и ни строки в журнале занятия.
     */
    case 'complete':
    case 'inspect':
      askKernel(ws, sessionId, payload, message)
      return

    /*
     * Переход к определению — третий кадр той же формы, но своей дверью: он не
     * идёт в ядро вовсе, отвечается синхронно и стоит не на праве запускать, а
     * на праве читать комнату. Всё это — в `answerDefine`.
     */
    case 'define':
      answerDefine(ws, sessionId, message)
      return

    case 'cancel': {
      const id = optionalId(message.cellId)
      if (!id) return
      // Silent when there was nothing of theirs waiting: two people pressing
      // cancel on the same cell is a race, not an error worth a message.
      cancelRun(sessionId, [id], payload.participantId, payload.role === 'host')
      return
    }

    case 'runAll': {
      /*
       * Тетрадь — раньше права, и это тот же порядок, что у `run` выше: право
       * запускать здесь решает не только комната, но и доступ к НАЗВАННОЙ
       * тетради, а узнать его можно, только разыскав её корень. Названная и
       * несуществующая отвечает своей фразой, а не правилами комнаты.
       */
      const book = bookOf(message)
      const root = rootOfBook(sessionId, book)
      if (book && root === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      if (!mayRun(sessionId, payload, ws, RUN_IS_THE_TEACHERS(), false, root)) return
      if (!mayBulkRun(sessionId, payload, ws, root)) return
      const ids = codeCellIds(sessionId, book)
      if (ids === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      queue(ws, sessionId, payload, ids, rootOfCells(sessionId, ids))
      return
    }

    case 'runAbove': {
      const id = optionalId(message.cellId)
      if (!id) return
      // По тетради, в которой нажали, — тот же довод, что у Run All.
      const book = bookOf(message)
      const root = rootOfBook(sessionId, book)
      if (book && root === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      if (!mayRun(sessionId, payload, ws, RUN_IS_THE_TEACHERS(), false, root)) return
      if (!mayBulkRun(sessionId, payload, ws, root)) return
      const ids = codeCellIds(sessionId, book, id)
      if (ids === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      queue(ws, sessionId, payload, ids, rootOfCells(sessionId, ids))
      return
    }

    case 'interrupt': {
      /*
       * Какую тетрадь останавливаем.
       *
       * Названная ячейка сильнее имени листа: она и есть та работа, ради
       * которой нажали, а лист приезжает из вкладки, которая в этот момент
       * открыта. Без обоих — тетрадь комнаты, то есть прежнее поведение кадра
       * от вкладки, открытой до появления нескольких ядер.
       */
      const stopBook = bookOf(message)
      const stopRoot = rootOfBook(sessionId, stopBook)
      if (stopBook && stopRoot === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      const here = stopRoot ?? CELLS_KEY
      /*
       * The host can always stop the kernel. So can whoever started the cell
       * that is running: they are stopping their own work, only one cell runs
       * at a time in a notebook, and a seminar with no teacher in the room
       * otherwise has no way at all to end a loop that will not end itself.
       *
       * Право спрашивается про ВСЁ занятие, а не про названную тетрадь:
       * человек, у которого считается ячейка в семинаре, остаётся хозяином
       * своей работы, какую бы вкладку ни держал открытой. Тетрадь решает, что
       * именно остановится, — не кто вправе нажать.
       *
       * By participant id, not by name — two students called Anna are two
       * people, and a name is not a credential.
       */
      if (payload.role !== 'host' && !startedTheRunningCell(sessionId, payload.participantId)) {
        refuse(
          ws,
          sessionId,
          payload,
          tr("server.onlyTheHostOrWhoeverStartedThe.835184"),
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
      // Очередь разбирается у ОДНОЙ тетради — у неё и спрашиваем, чья она.
      if (!target && payload.role !== 'host' && !queueIsOnly(sessionId, payload.participantId, here)) {
        send(ws, {
          t: 'error',
          message: tr("server.otherParticipantsHaveQueuedCellsStopYour.32a330"),
        })
        return
      }
      void interruptSession(sessionId, target, here).then(() => {
        appendActivity(sessionId, payload.participantId, 'execution.interrupted', target ? { cellId: target } : {}, payload.role)
      }).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, tr("server.couldNotInterruptTheKernel.ef82bf")),
        })
      })
      return
    }

    case 'restart': {
      /*
       * Перезапуск уносит переменные ОДНОЙ тетради — той, что названа; без
       * имени — тетради комнаты, как у вкладки, открытой до выкатки.
       */
      const restartBook = bookOf(message)
      const restartRoot = rootOfBook(sessionId, restartBook)
      if (restartBook && restartRoot === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      /*
       * Право — по ТЕТРАДИ, а не только по комнате.
       *
       * По умолчанию перезапуск преподавательский: он сбрасывает переменные
       * занятия, и комната, где работают вдвоём, вправе решить иначе. Но в
       * личной тетради студента ядро своё и переменные свои, и спрашивать на
       * них преподавателя — значит поднимать руку посреди лекции, чтобы заново
       * объявить `x` в собственном черновике. Развилка живёт в одном месте
       * (shared/rules.ts · rulesForBook), и здесь мы просто её спрашиваем.
       */
      if (
        !may(
          sessionId,
          rulesIn(sessionId, payload, restartRoot).restart,
          payload,
          ws,
          tr("server.onlyTheHostCanRestartTheKernel.987dcb"),
        )
      ) {
        return
      }
      void restartSession(
        sessionId,
        displayName(sessionId, payload.participantId),
        restartRoot ?? CELLS_KEY,
      ).then(() => {
        appendActivity(sessionId, payload.participantId, 'execution.restarted', {}, payload.role)
      }).catch(
        (err: unknown) => {
          send(ws, {
            t: 'error',
            message: reason(err, tr("server.couldNotRestartTheKernel.fc63d0")),
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
      const book = bookOf(message)
      /*
       * Названная тетрадь обязана существовать: ниже неизвестный путь означает
       * «тетрадь не названа», а это стёртые выводы ВСЕХ тетрадей комнаты —
       * полтора часа счёта, снятые нажатием в закрывающейся вкладке.
       */
      const wipeRoot = rootOfBook(sessionId, book)
      if (book && wipeRoot === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      /*
       * У своей ячейки — то же право, что у набора в ней, ЗАМОК ВКЛЮЧАЯ.
       * Открытая преподавателем ячейка — это «здесь комната работает»: зал в
       * ней печатает и запускает, а на «стереть вывод» читал отказ про
       * тетрадь, которую ему только что открыли, — про свой же трейсбек на
       * пол-экрана.
       *
       * У целого листа — право ТОЙ тетради: в личной вывод собственный, и
       * стирает его автор (shared/rules.ts · rulesForBook).
       */
      const allowed = one
        ? mayEditThis(sessionId, payload, ws, one)
        : may(
            sessionId,
            rulesIn(sessionId, payload, wipeRoot).wipe,
            payload,
            ws,
            whyIn(sessionId, payload, wipeRoot, tr("server.onlyTheTeacherMayEraseTheWhole.56250d")),
          )
      if (!allowed) return
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
          tr("server.onlyTheTeacherMayPutADocument.482e0d"),
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
        send(ws, { t: 'error', message: tr("server.thisFileIsNotInTheRoom.f557d3") })
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
          tr("server.onlyTheTeacherMayRemoveADocument.1b7a58"),
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
            ? tr("server.onlyTheTeacherMayFinishTheClass.84b1b4")
            : tr("server.onlyTheTeacherMayResumeTheClass.d3e509"),
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
      setClassFinished(sessionId, at)
      appendActivity(sessionId, payload.participantId, finish ? 'class.finished' : 'class.resumed', {}, payload.role)
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
          tr("server.onlyTheTeacherMayLeadALecture.f44eb3"),
        )
      ) {
        return
      }
      const wanted = normalizePath(typeof message.file === 'string' ? message.file : '')
      if (!wanted || kindOf(wanted) !== 'pdf') {
        send(ws, { t: 'error', message: tr("server.chooseAPdfDocumentForTheProjector.434426") })
        return
      }
      if (!statPath(sessionId, wanted)) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNoLongerInThe.b66e1e") })
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
          refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayTakeOverThe.31823b"))
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
      /*
       * Чистый лист — и опись к нему, хотя она пустая.
       *
       * Опись едет рядом с КАЖДЫМ полным кадром `ink`, и здесь это важнее
       * всего: она живёт у вкладки дольше самих чернил (по ней считаются
       * листы в ленте), и опись прошлой лекции, не стёртая новой, заставила бы
       * пульт держать её страницы пустыми листами.
       */
      broadcast(sessionId, { t: 'ink', strokes: [] })
      broadcast(sessionId, { t: 'ink:pages', pages: [] })
      return
    }

    case 'lecture:stop': {
      if (
        !may(
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          tr("server.onlyTheTeacherMayEndTheLecture.f996c5"),
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
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayEndAnotherPerson.8212a2"))
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
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayViewSpeakerNotes.8f7a4c"))
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
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayEditSpeakerNotes.729773"))
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
        send(ws, { t: 'error', message: tr("server.aNoteMustBelongToADocument.783591") })
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
          message: tr("server.aPageNoteMayContainUpTo.86232c", { p0: MAX_NOTE_CHARS }),
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

    /**
     * Чернила одной страницы — по вопросу вкладки.
     *
     * Не пультовое и правом не закрыто: спрашивает не ведущий, а тот, кто
     * смотрит, — вкладка, отставшая от зала, и лента эскизов на пульте. Право
     * здесь то же, что у приветственной пачки, которая эти же чернила и везёт:
     * кто в комнате, тот видит лекцию.
     *
     * Пустой список — законный ответ и означает «страница чистая». По нему
     * вкладка закрывает вопрос и второй раз про эту страницу не спрашивает;
     * молчание оставило бы её ждать чернил до конца лекции — и спрашивать
     * снова на каждое движение пера.
     */
    case 'ink:page': {
      // Как у указки: `Number` от чужого поля даёт NaN, а `JSON.stringify`
      // пишет его `null`, и вкладка приняла бы ответ про «страницу null» за
      // ответ про свою.
      const asked = Number(message.page)
      if (!Number.isFinite(asked)) return
      const page = Math.trunc(asked)
      // Придержанные куски — вперёд ответа: страница едет целиком, и точки,
      // дописанные к ней следом, приехали бы спрашивавшему дважды.
      flushInk(sessionId)
      send(ws, { t: 'ink:page', page, strokes: inkPageOf(sessionId, page) })
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
      if (!turned) return
      broadcast(sessionId, { t: 'lecture', state: turned })
      /*
       * И разметка новой страницы — следом за состоянием, всем сразу.
       *
       * Это не оптимизация, а условие: после обрезки приветственной пачки
       * чернил этой страницы у зала нет, и спросить её каждый умеет сам —
       * пятьсот вопросов на каждое перелистывание, то есть ровно тот круг
       * рассылки, ради которого пачку и обрезали. Вкладка поэтому ждёт
       * досылку (InkLayer · INK_WAIT_MS) и спрашивает, только если её не
       * дождалась.
       *
       * Один кадр на всех, не глядя, у кого что уже есть: страница — единица
       * выдачи, и `ink:page` заменяет её целиком, так что второй раз получить
       * то же самое безвредно. Чистый лист стоит при этом пустой список —
       * десятки байт.
       */
      broadcast(sessionId, {
        t: 'ink:page',
        page: turned.page,
        strokes: inkPageOf(sessionId, turned.page),
      })
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
      const added = addInk(sessionId, {
        id: optionalId(message.id) ?? '',
        page: Number(message.page),
        color: typeof message.color === 'string' ? message.color.slice(0, 32) : '#000000',
        width: Number.isFinite(message.width)
          ? Math.min(0.05, Math.max(0.0005, message.width))
          : 0.004,
        points: Array.isArray(message.points) ? (message.points as number[]) : [],
      })
      if (!added) return
      /*
       * Потолок — вслух, как переполненная заметка.
       *
       * Молчание здесь стоило четырёх секунд и восьми досылок штриха ЦЕЛИКОМ:
       * пульт не отличал отказ от потерянного кадра. Свои два потолка он теперь
       * считает сам и штрих на полной странице не открывает вовсе; сюда доезжает
       * то, чего он посчитать не может, — точки, кончившиеся в середине штриха,
       * и расхождение после переподключения. Слова — общие (shared/lecture.ts ·
       * inkFullSays), чтобы один и тот же отказ не звучал двумя голосами.
       */
      if (added.full) {
        send(ws, { t: 'error', message: inkFullSays(added.full) })
        return
      }
      inkTo(sessionId, added.stroke)
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
      /*
       * И свежая опись следом — «стереть» убавляет исписанные страницы.
       *
       * Опись говорит про страницы, которых у вкладки на руках нет, и сама
       * себя по кадру `ink:clear` не поправит: стёртая страница осталась бы в
       * ней лишним листом в ленте и вопросом про чернила, которых больше нет.
       * Стоит это десятки байт — в отличие от чернил, которые она описывает.
       */
      broadcast(sessionId, { t: 'ink:pages', pages: inkedPagesOf(sessionId) })
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
      laserTo(sessionId, { page, x, y, shape })
      return
    }

    case 'laser:off': {
      if (!atTheRemote(sessionId, payload)) return
      laserOff(sessionId)
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
       *
       * И правило у него СВОЁ — `ownBooks`, а не `files`, — поэтому ветка стоит
       * выше проверки папки. Это не обход: `files` про общую папку занятия,
       * куда кладут раздатку и решения, а своя тетрадь студента — про его
       * собственную работу, и её файл пишет сервер проекцией. Лекция, где файлы
       * преподавательские, а свои тетради разрешены, — обычная пара, и
       * проверка в прежнем порядке делала такую пару невозможной.
       */
      if (message.t === 'tree:new' && kindOf(wanted) === 'notebook') {
        const made = createBook(sessionId, wanted, authorOf(sessionId, payload))
        if (!made.ok) {
          send(ws, { t: 'error', message: made.why })
          return
        }
        broadcastFiles(sessionId)
        return
      }
      if (
        !may(
          sessionId,
          getRules(sessionId).files,
          payload,
          ws,
          tr("server.onlyTheTeacherMayCreateFilesIn.a33c2f"),
        )
      ) {
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
     * Продублировать файл — копией рядом, под свободным именем.
     *
     * Правило — `files`, то же, что у «нового файла» и у загрузки, и стоит оно
     * тут по той же причине: копия ДОБАВЛЯЕТ запись в папку. Переименование и
     * удаление остались преподавательскими, потому что убирают прежний путь, а
     * это нет — исходный файл после копии лежит там же и таким же.
     *
     * Имя выбирает сервер (`freeCopyName`), а не тот, кто нажал. Занятость тут
     * не отказ, а обычное дело: дублируют одно и то же дважды подряд, и вторая
     * копия обязана называться «(копия 2)», а не отвечать «уже есть».
     */
    case 'tree:copy': {
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      if (
        !may(
          sessionId,
          getRules(sessionId).files,
          payload,
          ws,
          tr("server.onlyTheTeacherMayCreateFilesIn.a33c2f"),
        )
      ) {
        return
      }
      /*
       * Тетрадь комнаты — это документ, а файл под ней проекция, и пишется она
       * с задержкой в полторы секунды после последней правки (collab/books.ts ·
       * WRITE_AFTER_MS). Копировать её файл, не дописав проекцию, — значит
       * отдать человеку тетрадь без последней ячейки, которую он только что и
       * набрал. Копия при этом остаётся обычным .ipynb в папке: внести её в
       * комнату — отдельное действие с отдельным правилом (`ownBooks`).
       */
      if (isBookFile(sessionId, wanted)) projectBooks(sessionId)
      const info = statPath(sessionId, wanted)
      if (!info) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNoLongerInThe.b66e1e") })
        return
      }
      if (info.dir) {
        send(ws, { t: 'error', message: tr('server.files.copyFolder') })
        return
      }
      // Потолок на один файл — тот же, что у загрузки: копия занимает место
      // ровно так же, как принесённый с диска файл того же размера.
      if (info.size > config.maxUploadBytes) {
        send(ws, {
          t: 'error',
          message: tr('server.files.copyTooBig', {
            p0: baseOf(wanted),
            p1: Math.round(config.maxUploadBytes / 1024 / 1024),
          }),
        })
        return
      }
      /*
       * И потолок на комнату целиком. Считается обходом папки, а не счётчиком
       * загрузок (routes/files.ts · usedBytes): счётчик живёт в маршруте, и
       * тащить его сюда значило бы замкнуть два модуля друг на друга ради
       * действия, которое человек нажимает раз в семинар. Цена расхождения
       * названа там же вслух: счётчик и так не знает о записях из ячейки.
       */
      if (sessionBytes(sessionId) + info.size > config.maxSessionBytes) {
        send(ws, {
          t: 'error',
          message: tr('server.files.copyNoRoom', {
            p0: Math.round(config.maxSessionBytes / 1024 / 1024),
            p1: baseOf(wanted),
          }),
        })
        return
      }
      // Несохранённый хвост открытого документа — на диск до копирования: иначе
      // копия отстаёт от того, что человек видит на экране, ровно на последние
      // полсекунды набора. Тот же порядок, что у `tree:move` ниже.
      flushFile(sessionId, wanted)
      const landing = freeCopyName(sessionId, wanted)
      const copied = copyFile(sessionId, wanted, landing)
      if (copied !== 'ok') {
        send(ws, { t: 'error', message: treeTrouble(copied, landing, wanted) })
        return
      }
      broadcastFiles(sessionId)
      return
    }

    /*
     * Внести .ipynb в комнату.
     *
     * Это ДОБАВЛЕНИЕ тетради, а не чтение файла: внесённая тетрадь становится
     * частью комнаты — попадает в снимок, в историю и на экран ко всем. Право
     * у неё то же, что у «новой тетради», и спрашивает его одна дверь
     * (collab/books.ts · whyNotAddBook), поэтому здесь проверки нет вовсе.
     *
     * Правило `files` сюда не годится, и раньше стояло именно оно: файл в
     * папке и тетрадь в комнате — разные вещи. При `files: 'room'` и
     * выключенных своих тетрадях положить .ipynb в папку можно, а внести его в
     * комнату — нет; при `files: 'host'` и разрешённых — наоборот.
     *
     * Читать её глазами при этом может кто угодно и без этого: файл
     * скачивается, как любой другой.
     */
    case 'book:open': {
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      const opened = openBook(sessionId, wanted, authorOf(sessionId, payload))
      if (!opened.ok) {
        send(ws, { t: 'error', message: opened.why })
        return
      }
      if (opened.imported) broadcastFiles(sessionId)
      return
    }

    case 'tree:move': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayRenameFilesIn.e04cee"))
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
        send(ws, { t: 'error', message: tr("server.cannotBePlacedInsideItself.de928c", { p0: baseOf(from) }) })
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
         * том, почему. Заметки — единственные здесь, кто ходит в базу, то есть
         * единственные, кто умеет отказать по-настоящему; спор за занятый ключ
         * они решают в пользу переезжающего файла (db.ts · moveNotes,
         * `UPDATE OR REPLACE`), так что терять тут больше нечего, — но перехват
         * полезен и сам по себе: доска и проектор не должны падать вместе с
         * одной строкой SQL.
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
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      /*
       * Убирают файлы из комнаты преподаватель — и автор СВОЕЙ личной тетради.
       *
       * Исключение ровно одно и без него «своя тетрадь» была бы полуправдой:
       * черновик, который студент завёл сам и который считается против его же
       * потолка (`MAX_OWN_BOOKS`), обязан убираться им же, иначе три неудачных
       * попытки запирают его до конца занятия. Чужую личную — нет, тетрадь
       * комнаты — нет, любой другой файл — нет.
       */
      if (payload.role !== 'host' && !ownsBookAt(sessionId, wanted, payload.participantId)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayRemoveAFile.77a4ef"))
        return
      }
      // Панель обещает «убрать папку со всем, что в ней», и обещание держится
      // здесь: список считается до удаления, потому что после него спрашивать
      // дерево уже не о чем.
      const inside = pathsInside(sessionId, wanted)
      if (!deleteFile(sessionId, wanted)) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNoLongerInThe.b66e1e") })
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
     * Дерево целиком — тому, кто спросил.
     *
     * Спрашивают в одном случае: приехала дельта, а склеить её не с чем. Права
     * здесь нет и быть не может — этот же список сокет получает приветственной
     * пачкой. Кадр берётся из общей памяти комнаты: если разрыв увидели все
     * разом, обход папки всё равно будет один.
     */
    case 'files:ask': {
      const frame = filesFrame(sessionId)
      if (frame !== null) sendFrame(ws, frame)
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
        send(ws, { t: 'error', message: tr("server.onlyPyAndShFilesCanBe.fb990d") })
        return
      }
      if (!statPath(sessionId, wanted)) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNoLongerInThe.b66e1e") })
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
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayUndoAnOracle.a064cd"))
        return
      }
      const entryId = optionalId(message.entryId)
      if (!entryId) return
      const touched = undoTurn(sessionId, entryId, displayName(sessionId, payload.participantId))
      if (touched === null) {
        send(ws, {
          t: 'error',
          message:
            tr("server.thisActionCanNoLongerBeUndone.29f138"),
        })
      }
      return
    }

    case 'cells:move': {
      const id = typeof message.cellId === 'string' ? message.cellId : ''
      const direction =
        message.direction === -1 || message.direction === 1 ? message.direction : null
      if (!id || direction === null) return
      /*
       * Состав — по правилам ТОЙ тетради, в которой переставляют: перестановка
       * не выходит за её пределы (`moveInCells` двигает внутри одного листа), и
       * спрашивать про неё комнату значило бы запрещать студенту перекладывать
       * ячейки в собственной тетради.
       */
      const root = rootOf(sessionId, id)
      if (!allowsStructure(rulesIn(sessionId, payload, root).structure, payload.role, 'move')) {
        refuse(
          ws,
          sessionId,
          payload,
          whyIn(sessionId, payload, root, tr("server.onlyTheTeacherMayReorderCellsIn.601caf")),
        )
        return
      }
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
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayOpenCells.27de8a"))
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
        send(ws, { t: 'error', message: tr(OVER) })
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
        send(ws, { t: 'error', message: tr("server.thisCellIsNoLongerInThe.3462ea") })
        return
      }
      const was = cellLock(found.cell)
      /*
       * Ручки: не приложены — как были; ячейка впервые в консилиуме — умолчания
       * (readCouncilSettings отдаёт их на пустом месте). Повторный `cell:lock`
       * с тем же положением и новыми ручками — это и есть «переключить ручку».
       */
      const prior = readCouncilSettings(found.cell.get('council'))
      /*
       * Слитые ручки — ЧЕРЕЗ санитайзер, а не как пришли.
       *
       * `pickSettings` уже отбросил непонятное из сообщения, но слева от него
       * стоит то, что лежит в документе, а документ в комнате пишут все. Ячейка
       * с `runLimitSec: "много"`, приехавшим мимо этого обработчика, доехала бы
       * до ядра и завела там будильник на NaN — то есть сняла бы предел молча.
       * Санитайзер здесь и есть та единственная дверь, за которой в документе
       * лежат только годные ручки.
       */
      const next: CouncilSettings | null =
        state === 'council' ? readCouncilSettings({ ...prior, ...settings }) : null
      // Повторное нажатие — не событие: лишняя версия в истории на каждый
      // щелчок по уже открытой ячейке ничего не рассказывает.
      const sameKnobs =
        next === null ||
        (next.studentRun === prior.studentRun &&
          next.namesOnProjector === prior.namesOnProjector &&
          next.runLimitSec === prior.runLimitSec &&
          next.rerunPauseSec === prior.rerunPauseSec)
      if (was === state && sameKnobs) return
      if (was !== state || next?.studentRun !== prior.studentRun) {
        clearRunRequests(sessionId, id)
      }
      /*
       * ЗАДАНИЕ — снимается здесь, на самом переходе в консилиум, и только на нём.
       *
       * Общий текст ячейки в эту секунду — то, что преподаватель дал классу;
       * через минуту он им уже не будет: «Показать классу» кладёт в ячейку
       * чьё-то решение (см. `council:show` ниже). Опоздавший или просто
       * перезагрузивший страницу засевал свой лист тем, что лежит в ячейке
       * СЕЙЧАС, — то есть чужим ответом, и одно нажатие «Сдать» отправляло его
       * в группу автора.
       *
       * Не на каждом нажатии: `cell:lock` с тем же положением — это
       * переключение ручки, и переписывать им задание значило бы вернуть ровно
       * ту же подмену. Пустая строка — законное задание: консилиум открыли на
       * пустой ячейке, «напишите сами».
       */
      if (was !== 'council' && state === 'council') {
        rememberSeed(sessionId, id, cellSource(found.cell).toString())
      }
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
       * Предел, поменянный посреди чужого запуска, действует на него же.
       *
       * «Правила действуют сразу» — обещание всей комнаты, и предел запуска не
       * может быть из него исключением: преподаватель ставит его, ГЛЯДЯ на
       * зависший цикл, и ждать конца этого самого цикла — единственное, чего он
       * в эту секунду не хочет. Новый предел отсчитывается от начала идущей
       * попытки, так что «тридцать секунд» на попытке, идущей минуту, срабатывает
       * сразу (kernel/index.ts · retimeCouncilRun).
       */
      if (next !== null && next.runLimitSec !== prior.runLimitSec) {
        retimeCouncilRun(sessionId, id, next.runLimitSec)
      }
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
        if (lock !== 'council') send(ws, { t: 'error', message: `${COUNCIL_CLOSED()}.` })
        else refuse(ws, sessionId, payload, COUNCIL_CLOSED())
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
            message: tr("server.anAttemptMayContainUpToCharacters.ff604b", { p0: MAX_ATTEMPT_CHARS }),
          })
          return
        }
        /*
         * Текст сменился — ждущий запуск снимается с очереди.
         *
         * `saveDraft` честно убирает с попытки всё, что было сказано о прежнем
         * тексте, и `recordRun` выбрасывает опоздавший кадр, — но запись в
         * очереди оставалась, и это стоило дважды. Ядру — минуту на код,
         * которого уже нет, при общей очереди на весь поток. Автору — отказ
         * «эта попытка уже в очереди» на попытку запустить НОВУЮ версию: пока
         * старый исходник не досчитается, перезапустить нечего.
         */
        const prior = attemptOf(sessionId, id, payload.participantId)
        const priorText = prior?.text
        if (priorText !== undefined && priorText !== message.text) {
          cancelCouncilRun(sessionId, id, payload.participantId)
        }
        saveDraft(sessionId, id, payload.participantId, message.text, now)
        /*
         * Автор переписал показанный текст — плашка на экране больше ни о чём.
         *
         * `saveDraft` честно снимает «на экране» вместе с запуском и отметкой
         * (они приклеены к тексту), но комната об этом узнавала только из
         * своего листа автора: у остальных под ячейкой продолжал висеть код,
         * которого больше нет ни у кого.
         */
        if (prior?.shown && priorText !== message.text) shownOut(sessionId, id)
      } else if (message.t === 'council:submit') {
        const alreadySubmitted = attemptOf(sessionId, id, payload.participantId)?.submittedAt != null
        if (!submitAttempt(sessionId, id, payload.participantId, now)) {
          send(ws, { t: 'error', message: tr("server.theAttemptIsEmptyWriteYourSolution.f38771") })
          return
        }
        if (!alreadySubmitted) appendActivity(sessionId, payload.participantId, 'council.submitted', { cellId: id, source: 'participant' }, payload.role)
      } else {
        const wasSubmitted = attemptOf(sessionId, id, payload.participantId)?.submittedAt != null
        if (!withdrawAttempt(sessionId, id, payload.participantId)) return
        if (wasSubmitted) appendActivity(sessionId, payload.participantId, 'council.withdrawn', { cellId: id, source: 'participant' }, payload.role)
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
    case 'council:show':
    case 'council:show:clear': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      const clearing = message.t === 'council:show:clear'
      const target = clearing ? null : (optionalId(message.participantId) ?? null)
      if (!clearing && target === null) return
      if (target !== null && !attemptOf(sessionId, id, target)) {
        send(ws, { t: 'error', message: tr("server.thisAttemptNoLongerExists.b490bf") })
        return
      }
      /*
       * Общий текст ячейки при показе НЕ трогается — в этом вся правка.
       *
       * Прежде «показать классу» переписывало `source` ячейки текстом попытки
       * обычной правкой от имени преподавателя: заготовка исчезала у всех, в
       * истории документа автором значился ведущий, отката не было (только
       * печатать руками), а на экране ничто не говорило, что это чьё-то
       * решение. Теперь показ — отметка на попытке плюс подписанный кадр
       * комнате (`council:shown`), и ячейка остаётся ячейкой.
       */
      // Кого показывали до этого: по нему различаются «показали другого» и
      // «нажали на том же ещё раз» — второе обновляет время подписи, но
      // событием в истории не становится.
      const before = shownWho(sessionId, id)
      const changed = setShown(sessionId, id, target, clearing ? null : payload.participantId, Date.now())
      // Убирать нечего — и говорить нечего: комнате не нужен кадр «плашки нет»
      // там, где её и не было. А вот ПОКАЗ пересылается всегда, даже когда в
      // строке ничего не поменялось: «Показать снова» на карточке — это и есть
      // «обнови подпись», по нему пересчитывается «так же написали ещё K».
      if (clearing && changed.length === 0) return
      const touched = target === null ? changed : [...new Set([...changed, target])]
      for (const participantId of touched) mineOut(sessionId, id, participantId)
      boardOut(sessionId, id, touched)
      shownOut(sessionId, id)
      /*
       * В историю — обоими концами: «вывел решение на экран» и «убрал». Кто
       * решал, чей код увидит класс, и чей это был код — то же самое, что
       * «предложил ячейку для разбора» рядом, только со стороны ведущего.
       * `subjectId` — автор показанного, актёр — преподаватель.
       */
      if (clearing) {
        appendActivity(sessionId, payload.participantId, 'council.unshown',
          { cellId: id, ...(before ? { subjectId: before } : {}) }, payload.role)
      } else if (before !== target) {
        appendActivity(sessionId, payload.participantId, 'council.shown',
          { cellId: id, ...(target ? { subjectId: target } : {}) }, payload.role)
      }
      return
    }

    case 'council:run:request': {
      const id = optionalId(message.cellId)
      if (!id) return
      const { lock, settings } = councilCellOf(sessionId, id)
      if (payload.role === 'host' || settings.studentRun !== 'request' ||
          !mayWriteCouncil(payload.role, isFinished(sessionId), lock !== 'council')) {
        send(ws, { t: 'error', message: tr("server.youCanRequestARunOnlyIn.dfdda0") })
        return
      }
      const attempt = attemptOf(sessionId, id, payload.participantId)
      if (!attempt?.text.trim()) {
        send(ws, { t: 'error', message: tr("server.writeYourSolutionFirst.b04f1e") })
        return
      }
      /*
       * Пауза спрашивается на ПРОСЬБЕ, а не на одобрении.
       *
       * Иначе она наказывала бы преподавателя: очередь просьб копится, он
       * разбирает её через минуту — и половина одобрений упирается в паузу,
       * которую отстояли, пока просьба лежала. Студент же о ней узнаёт там же,
       * где нажимает, и отсчёт у него под кнопкой стоит с конца его запуска.
       */
      const waitUntil = nextRunAtFor(sessionId, id, payload.participantId, settings.rerunPauseSec)
      if (waitUntil !== null) {
        send(ws, { t: 'error', message: rerunPauseNote(waitUntil) })
        return
      }
      if (councilQueuePosition(sessionId, id, payload.participantId) !== null ||
          !requestAttemptRun(sessionId, id, payload.participantId, Date.now())) {
        send(ws, { t: 'error', message: tr("server.theAttemptIsAlreadyRunningOrQueued.fc3fa7") })
        return
      }
      mineOut(sessionId, id, payload.participantId)
      boardOut(sessionId, id, [payload.participantId])
      return
    }

    case 'council:run:cancel':
    case 'council:run:decline': {
      const declining = message.t === 'council:run:decline'
      if (declining && !mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayReviewRunRequests.630a48"))
        return
      }
      const id = optionalId(message.cellId)
      const requestId = optionalId(message.requestId)
      const target = declining ? optionalId(message.participantId) : payload.participantId
      if (!id || !requestId || !target) return
      if (!resolveRunRequest(sessionId, id, target, requestId, declining ? 'decline' : 'clear')) {
        send(ws, { t: 'error', message: tr("server.theRequestHasChangedOrHasAlready.aa2b45") })
        return
      }
      mineOut(sessionId, id, target)
      boardOut(sessionId, id, [target])
      return
    }

    case 'council:run:drop': {
      /*
       * Снять чужой ждущий запуск — не трогая человека.
       *
       * Раньше единственной кнопкой у чужой записи в очереди было «убрать с
       * занятия»: освободить очередь от запуска, поставленного по ошибке,
       * можно было только вместе с автором. Здесь снимается работа и ничего
       * больше — текст попытки остаётся, автор остаётся, право запускать
       * остаётся.
       */
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      const target = optionalId(message.participantId)
      if (!id || !target) return
      if (!cancelCouncilRun(sessionId, id, target)) {
        // Ушедшую в ядро отсюда не достать: её останавливает «Прервать», и
        // сказать об этом надо тем же словом, что написано на кнопке.
        send(ws, { t: 'error', message: tr("server.theAttemptIsAlreadyRunningOrQueued.fc3fa7") })
        return
      }
      /*
       * Автору — словом. Запуск, исчезнувший с карточки молча, читается как
       * поломка: человек нажал, увидел «в очереди», а через минуту очереди
       * нет и вывода нет.
       */
      tell(sessionId, target, { t: 'error', message: tr('server.council.runDropped') })
      mineOut(sessionId, id, target)
      boardOut(sessionId, id, [target])
      tellQueued(sessionId)
      return
    }

    case 'council:run:approve':
    case 'council:run': {
      const approving = message.t === 'council:run:approve'
      if (approving && !mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayReviewRunRequests.630a48"))
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      const target = optionalId(message.participantId) ?? payload.participantId
      const own = target === payload.participantId
      if (!own && !mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayRunAnotherParticipant.982a38"))
        return
      }
      const { lock, settings } = councilCellOf(sessionId, id)
      if (approving && (settings.studentRun !== 'request' || lock !== 'council' || isFinished(sessionId))) {
        send(ws, { t: 'error', message: tr("server.runRequestsAreNowClosed.f23dc6") })
        return
      }
      if (!mayRunCouncil(payload.role, settings.studentRun, isFinished(sessionId))) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayRunAttemptsIn.fbe78a"))
        return
      }
      // Студент — только пока консилиум идёт; преподаватель считает и на просмотре.
      if (payload.role !== 'host' && lock !== 'council') {
        send(ws, { t: 'error', message: `${COUNCIL_CLOSED()}.` })
        return
      }
      const attempt = attemptOf(sessionId, id, target)
      if (!attempt) {
        send(ws, {
          t: 'error',
          message: own ? tr("server.writeYourAttemptFirst.746013") : tr("server.thisAttemptNoLongerExists.b490bf"),
        })
        return
      }
      if (approving && (attempt.runRequest?.status !== 'pending' ||
          attempt.runRequest.id !== optionalId(message.requestId))) {
        send(ws, { t: 'error', message: tr("server.theRequestHasChangedOrHasAlready.2ee147") })
        return
      }
      /*
       * Пауза между своими запусками — только своя и только не преподавателю.
       *
       * Преподаватель не ждёт никогда: он запускает чужую попытку, разбирая её
       * у доски, и пауза автора к этому нажатию отношения не имеет — как и к
       * одобрению просьбы, которую спросили на ней же.
       */
      if (payload.role !== 'host' && own) {
        const waitUntil = nextRunAtFor(sessionId, id, target, settings.rerunPauseSec)
        if (waitUntil !== null) {
          send(ws, { t: 'error', message: rerunPauseNote(waitUntil) })
          return
        }
      }
      const outcome = requestCouncilRun(
        sessionId,
        {
          cellId: id,
          participantId: target,
          source: attempt.text,
          by: payload.role === 'host' ? 'host' : 'author',
          /*
           * Предел снимается с ячейки в секунду нажатия и едет с заданием: ядро
           * документа не читает (kernel/council.ts · CouncilJob.limitSec).
           * Касается и преподавательских запусков: жирный код не становится
           * легче оттого, кто нажал, а ядро одно на всю тетрадь.
           */
          limitSec: settings.runLimitSec,
          /*
           * Каждый кадр ядра — к попытке и двоим, кому она видна. Очередь после
           * конца запуска сдвинулась — ждущим новый номер.
           */
          onChange: (run: CouncilRun | null) => {
            /*
             * Кадр, который не лёг, никому и не рассылается.
             *
             * `recordRun` отвечает `false` в двух случаях: попытки уже нет
             * (бан) и кадр опоздал — пока запуск ждал очереди, автор сменил
             * текст, и вывод относится к прежнему. Раньше за выброшенным
             * кадром всё равно шли `mineOut`/`boardOut`: пустая дельта в
             * каждый сокет комнаты, по три на попытку. Очередь при этом
             * сдвинулась по-настоящему — про неё сказать надо.
             */
            const landed = recordRun(sessionId, id, target, run)
            const over = run === null || run.state === 'ok' || run.state === 'error'
            if (!landed) {
              if (over) tellQueued(sessionId)
              return
            }
            mineOut(sessionId, id, target)
            boardOut(sessionId, id, [target])
            // Досчитался запуск того, кто на экране, — под плашкой у всей
            // комнаты появляется его вывод. Промежуточные кадры в плашку не
            // едут (`shownFor` берёт только досчитавшийся), и слать их некуда.
            if (over && shownWho(sessionId, id) === target) shownOut(sessionId, id)
            if (over) tellQueued(sessionId)
          },
        },
        displayName(sessionId, payload.participantId),
        payload.participantId,
      )
      if (!outcome.queued) {
        /*
         * Отказ говорит, ЧТО именно занято. Три случая и три разные фразы:
         * эта же попытка уже считается, эта же стоит в очереди — и, с недавних
         * пор, в очереди стоит его работа по ДРУГОЙ ячейке этой тетради
         * (kernel/index.ts · потолок «один запуск на человека в полёте»).
         * Одна фраза на все три отправляла бы человека искать свою попытку
         * там, где её нет.
         */
        const here = councilQueuePosition(sessionId, id, target)
        send(ws, {
          t: 'error',
          message:
            outcome.position === 0
              ? tr("server.thisAttemptIsAlreadyRunning.0efa94")
              : here !== null
                ? tr("server.thisAttemptIsAlreadyQueuedAtPosition.0c6a86", { p0: outcome.position })
                : tr('server.council.alreadyQueuedHere', { p0: outcome.position }),
        })
      }
      return
    }

    case 'council:reply': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      const text = typeof message.text === 'string' ? message.text.trim() : ''
      if (!text) return
      if (text.length > MAX_REPLY_CHARS) {
        send(ws, { t: 'error', message: tr("server.aReplyMayContainUpToCharacters.1d0ef3", { p0: MAX_REPLY_CHARS }) })
        return
      }
      /*
       * Адресат — только человек. Рассылка группе одинаковых решений («Всем
       * N») снята вместе с самой группировкой: письмо, написанное по чужому
       * тексту, приходило людям, которые его не писали, — совпал лишь код
       * после нормализации. Старый клиент, приславший `{groupKey}`, получает
       * молчание, а не рассылку: лучше не отправить, чем отправить не тем.
       */
      const to = message.to as { participantId?: unknown } | undefined
      const participantId = optionalId(to?.participantId)
      if (participantId === undefined) return
      const address = { participantId }
      // Подпись преподавателя, не оракула: черновик модели сюда попадает уже
      // правленым текстом, и в ленте студента отвечает человек.
      const reply = { text, at: Date.now(), by: displayName(sessionId, payload.participantId) }
      const told = setReply(sessionId, id, address, reply)
      if (told.length === 0) {
        send(ws, { t: 'error', message: tr("server.thereIsNobodyToReplyToThis.efbb65") })
        return
      }
      for (const who of told) mineOut(sessionId, id, who)
      boardOut(sessionId, id, told)
      return
    }

    case 'council:mark': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
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
      // Отметка стоит и в углу проекторной карточки: «верно», сказанное вслух,
      // на экране держится дольше голоса.
      if (shownWho(sessionId, id) === target) shownOut(sessionId, id)
      return
    }

    /*
     * Попытка целиком — с выводом, которого не было в стопке.
     *
     * У полной стопки есть бюджет вывода (`withinBudget`): на пятистах
     * прогнанных попытках кадр со всеми картинками весит десятки мегабайт, а
     * пульт рисует их по одной, когда карточку развернули. Это вторая половина
     * сделки — «покажи вот эту».
     *
     * Право то же, что у всей стопки: чужую попытку видит только ведущий.
     * Ответ — обычная дельта, её пульт уже умеет класть в стопку. Попытки
     * больше нет — молчим: её могли забанить, и `removed` уже уехал.
     */
    /*
     * «Подсказка оракула» — одному студенту по его же упавшей попытке.
     *
     * Сокетом, а не `/ai/ask`, и это несущее решение: тот маршрут пишет вопрос
     * и ответ в ОБЩИЙ тред комнаты, а тексты консилиума частные — вопрос
     * «почему у меня падает» вместе с кодом ушёл бы туда, где его прочитают
     * сорок соседей. Ответ возвращается письмом внутрь самой попытки: его
     * видят те же двое, что видят её текст, и он переживает перезагрузку.
     *
     * Чужую попытку спросить нельзя по устройству кадра: participantId в нём
     * не называется вовсе, он берётся из токена.
     */
    case 'council:hint': {
      const id = optionalId(message.cellId)
      if (!id) return
      const author = payload.participantId
      const hintState = (asking: boolean, error?: string) =>
        send(ws, error === undefined
          ? { t: 'council:hint:state', cellId: id, asking }
          : { t: 'council:hint:state', cellId: id, asking, error })
      if (councilCellOf(sessionId, id).lock !== 'council') {
        hintState(false, tr("server.council.hintNotInCouncil"))
        return
      }
      const attempt = attemptFor(sessionId, id, author)
      /*
       * Подсказку дают по УПАВШЕМУ запуску, и только по нему: без трейсбека
       * спрашивать нечего, а «посмотри на мой код и скажи, верно ли» — это
       * решение за студента, то есть ровно то, от чего консилиум и защищают.
       */
      if (!attempt || !runFailed(attempt.run)) {
        hintState(false, tr("server.council.hintNeedsError"))
        return
      }
      const refusal = oracleDoor(sessionId, payload) ?? oracleCapacity(sessionId, payload.role)
      if (refusal) {
        hintState(false, refusal.error)
        return
      }
      if (hintsReading.has(`${sessionId}:${id}:${author}`)) return
      hintsReading.add(`${sessionId}:${id}:${author}`)
      hintState(true)

      // Условие обычно лежит в маркдаун-ячейке над заданием; заготовка — в
      // `council_seed`, потому что в самой ячейке её к этому времени может уже
      // не быть («Показать классу» кладёт туда чужое решение).
      const before = (() => {
        const found = findCell(getSessionDoc(sessionId).doc, id)
        if (!found || found.index === 0) return null
        const above = found.cells.get(found.index - 1)
        return above ? cellSource(above).toString() : null
      })()
      /*
       * Строка расхода — при приёме, как у `/ai/ask`: запрос к провайдеру уйдёт,
       * чем бы он ни кончился. Своё действие в учёте: подсказка в разбивке
       * панели не должна прятаться среди «спросили».
       */
      const usageId = recordQuestion({ sessionId, participantId: author, action: 'hint' })
      appendActivity(sessionId, author, 'oracle.asked', { action: 'hint', source: 'participant', cellId: id })
      const releaseCapacity = holdOracleHint(sessionId)

      void askCouncilHint({
        before,
        stub: seedOf(sessionId, id),
        attempt: attempt.text,
        run: attempt.run,
        usageId,
      })
        .then((text) => {
          if (!text) {
            hintState(false, tr("server.theModelReturnedAnEmptyResponseTry.c365b1"))
            return
          }
          setHint(sessionId, id, author, { text, at: Date.now(), by: tr('server.council.oracleName') })
          hintState(false)
          mineOut(sessionId, id, author)
          // Преподавателю подсказка видна тоже: она часть попытки, и на разборе
          // из неё понятно, что человек уже слышал.
          boardOut(sessionId, id, [author])
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message.trim() : String(err)
          console.error(`[session ${sessionId}] council hint failed:`, reason)
          hintState(false, reason || tr("server.theOracleDidNotRespondCheckThe.e430c5"))
        })
        .finally(() => {
          releaseCapacity()
          hintsReading.delete(`${sessionId}:${id}:${author}`)
        })
      return
    }

    case 'council:attempt': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      const target = optionalId(message.participantId)
      if (!id || !target) return
      const attempt = attemptFor(sessionId, id, target)
      if (!attempt) return
      const cell = councilCellOf(sessionId, id)
      send(ws, {
        t: 'council:patch',
        cellId: id,
        attempts: [attempt],
        removed: [],
        counts: countsFor(sessionId, id),
        lock: cell.lock,
        settings: cell.settings,
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
      /*
       * Право на принятие спрашивается у ЯЧЕЙКИ, а не только у правила.
       *
       * Иначе замок читался бы как поломка: ячейку студенту открыли, он в ней
       * печатает и запускает, спрашивает оракула — и не может нажать
       * «принять» на предложение, сделанное для этой самой ячейки. Правило
       * `edit` при этом никуда не делось: в закрытой ячейке принимает
       * преподаватель, как и было.
       */
      /*
       * И у консилиума — отдельным слагаемым.
       *
       * Правило `edit` в открытой комнате разрешает участнику править ячейки,
       * а общая ячейка консилиума — это ЗАДАНИЕ: принять в неё предложение
       * значило бы переписать задание всему классу одним нажатием. Замок при
       * этом «открытой» её не считает (`open === 'council'`), так что прежняя
       * проверка её и не замечала. Преподаватель принимает везде: эталон в
       * общей ячейке — его текст.
       */
      const target = entry.get('cellId')
      const targetLock = typeof target === 'string' ? councilCellOf(sessionId, target).lock : 'closed'
      const targetOpen = targetLock === 'open'
      /*
       * И у тетради этой ячейки — тем же слагаемым, что и замок.
       *
       * «Принять» переписывает ячейку, то есть это правка, и она обязана
       * спрашивать там же, где спрашивает набор: в своей личной тетради студент
       * принимает предложение оракула и при закрытой комнате, в чужой личной —
       * не принимает и при открытой.
       */
      const targetRoot = typeof target === 'string' ? rootOf(sessionId, target) : null
      if (
        message.accept &&
        (!mayEditCell(
          rulesIn(sessionId, payload, targetRoot),
          payload.role,
          targetOpen,
          isFinished(sessionId),
        ) ||
          (targetLock === 'council' && !mayLeadCouncil(payload.role)))
      ) {
        // Отклонить может кто угодно: снятая плашка ничего не разрушает — пока
        // занятие идёт и оракула можно спросить заново.
        refuse(
          ws,
          sessionId,
          payload,
          whyIn(
            sessionId,
            payload,
            targetRoot,
            tr("server.onlyTheTeacherMayApplyAnOracle.231855"),
          ),
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
        send(ws, { t: 'error', message: tr(OVER) })
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
        refuse(ws, sessionId, payload, tr("server.onlyTheParticipantWhoRanTheCell.d7ea88"))
        return
      }
      /*
       * И не после конца занятия — правилом это не выражается, а действие то
       * же: строка уходит в чужое ядро и двигает чужой счёт дальше. Читать
       * приглашение ко вводу в ленте по-прежнему может вся комната.
       */
      if (!actsAfterClass(isFinished(sessionId), payload.role)) {
        send(ws, { t: 'error', message: tr(OVER) })
        return
      }
      const value = typeof message.value === 'string' ? message.value : ''
      /*
       * И `false` — тоже ответ, а не только бросок.
       *
       * `answerInput` возвращает его, когда ядро ввода уже не ждёт (или ждёт
       * его в другой ячейке): строка никуда не ушла. Пока этот исход тихо
       * выбрасывался, «Send» молчал — человек нажимал его ещё и ещё, а ядро
       * стояло. Приглашение в документе гасит само ядро (kernel/index.ts ·
       * clearStdinOn), но форма исчезает не мгновенно, и молчание в эту секунду
       * читается как «отправлено».
       */
      void answerInput(sessionId, value, optionalId(message.cellId))
        .then((answered) => {
          if (!answered) {
            send(ws, { t: 'error', message: tr("server.theKernelIsNoLongerWaitingFor.e35793") })
          }
        })
        .catch((err: unknown) => {
          send(ws, {
            t: 'error',
            message: reason(err, tr("server.couldNotSendThatToTheCell.b70cd9")),
          })
        })
      return
    }

    case 'format': {
      /*
       * Названная тетрадь обязана существовать — тот же довод, что у
       * clearOutputs и Run All: ниже по дороге неизвестный путь означает
       * «тетрадь не названа» (kernel/format.ts · `cellsAt(...) ?? getCells`), а
       * это black, переписавший КАЖДУЮ кодовую ячейку тетради КОМНАТЫ по
       * нажатию во вкладке убранной тетради — у всех и без имени в строке
       * терминала.
       *
       * И раньше права: форматирует black РОВНО эту тетрадь, значит и правило
       * спрашивается у неё (`rulesIn`), а узнать её доступ можно только зная
       * корень.
       */
      const book = bookOf(message)
      const root = rootOfBook(sessionId, book)
      if (book && root === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      /*
       * Строже обоих соседей: black и переписывает каждую ячейку с кодом, и
       * выполняется на общем ядре. Хватило бы одного из двух, чтобы спросить.
       */
      if (
        !may(
          sessionId,
          rulesIn(sessionId, payload, root).edit,
          payload,
          ws,
          whyIn(sessionId, payload, root, tr("server.onlyTheTeacherMayEditTheNotebook.d8abb3")),
        )
      ) {
        return
      }
      if (!mayBulkRun(sessionId, payload, ws, root)) return
      /*
       * The result goes to the terminal transcript rather than back down this
       * socket: everybody's notebook just changed under them, so everybody
       * deserves the sentence explaining it — not only whoever pressed the
       * button. It is also the one place that can say "three cells were left
       * alone", which is the part somebody will want to check.
       */
      void formatSession(sessionId, book)
        .then((outcome) => {
          if (outcome.error) {
            /*
             * Отказ — нажавшему, а не только в журнал ядра.
             *
             * Причина у него теперь по делу: «ядро занято ячейкой», «ячейка
             * ждёт input()», «в очереди стоят ячейки» (kernel/index.ts ·
             * formatBlocker). Журнал эти слова получает тоже — их касается вся
             * комната, — но тот, кто нажал, смотрит на кнопку, а не в ленту
             * терминала, и без этой строки Format выглядел бы просто не
             * сработавшим.
             */
            send(ws, { t: 'error', message: outcome.error })
            return
          }
          if (outcome.changed === 0 && outcome.skipped === 0) {
            kernelNote(sessionId, tr("server.formattingCompleteNoChangesNeeded.0b35b3"))
            return
          }
          const parts = [
            tr('server.formattedCells', { count: outcome.changed }),
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
              tr("server.skippedBlackCouldNotParseTheCode.ba9c0d", { p0: unread }),
            )
          }
          if (outcome.edited > 0) {
            parts.push(
              tr("server.skippedEditedWhileFormattingWasInProgress.6a01ab", { p0: outcome.edited }),
            )
          }
          kernelNote(
            sessionId,
            tr("server.formattedWithBlackColumns.105f9d", { p0: LINE_LENGTH, p1: parts.join('; ') }),
          )
        })
        .catch((err: unknown) => {
          send(ws, {
            t: 'error',
            message: reason(err, tr("server.couldNotFormatTheNotebook.a8322c")),
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
          message: reason(err, tr("server.couldNotOpenTheTerminal.b04b2c")),
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
          tr("server.onlyTheTeacherMayRunCellsAnd.1d861c"),
        )
      ) {
        return
      }
      const command = typeof message.command === 'string' ? message.command : ''
      if (command.trim().length === 0) return
      if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
        send(ws, {
          t: 'error',
          message:
            tr("server.theCommandExceedsBytes.4bc32c", { p0: formatNumber(MAX_COMMAND_BYTES) }) +
            tr("server.putItInAFileAndRun.5f2e18"),
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
          tr("server.onlyTheTeacherOrTheParticipantWho.f9b6f0"),
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
          tr("server.onlyTheTeacherMayClearTheTranscript.695583"),
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
          tr("server.onlyTheTeacherMayCloseTheShared.c7ec17"),
        )
      ) {
        return
      }
      void closeTerminal(sessionId).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, tr("server.couldNotCloseTheTerminal.17d21d")),
        })
      })
      return
    }
  }
}

function reason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * Чернила показываемой страницы — и один сбор на всех, кто пришёл между двумя
 * штрихами.
 *
 * Опоздавший обязан увидеть ту же страницу, что и зал, вместе с тем, что на
 * ней уже нарисовано. Раньше это собиралось из ВСЕХ страниц лекции (`inkOf` и
 * `JSON.stringify` — под мегабайт на лекции с двадцатью минутами письма), и
 * после сбоя сети зал возвращался весь сразу: мегабайт умножался на пятьсот.
 * Теперь пачка везёт одну страницу, а про остальные говорит опись
 * (`ink:pages`) — десятки байт вместо мегабайта; страницу, на которую ушли не
 * спросясь, вкладка спрашивает сама (`case 'ink:page'`), а ту, на которую
 * ведущий перевёл зал, сервер досылает (`case 'lecture:page'`).
 *
 * Кэш при этом остался и стал ключом на пару «перемена в чернилах + страница»:
 * пятьсот вернувшихся вкладок смотрят ОДНУ страницу — ту, что показывает
 * ведущий, — и собирать её пятьсот раз незачем. Номер перемены — сквозной
 * (lecture.ts · inkRevision): пока никто не рисует, кадр тот же самый.
 * Держится он байтами: иначе `ws.send` кодировал бы его в UTF-8 заново на
 * каждый сокет (см. sendFrame).
 *
 * Одна запись на комнату, а не по записи на страницу: спрошенные страницы
 * ответом и уходят, кэшировать их значило бы держать в памяти всю лекцию ради
 * ленты эскизов, открытой раз за пару.
 */
const inkFrames = new Map<string, { rev: number; page: number; frame: Buffer }>()

function inkFrame(sessionId: string, page: number): Buffer | null {
  const rev = inkRevision(sessionId)
  const known = inkFrames.get(sessionId)
  if (known && known.rev === rev && known.page === page) return known.frame
  const text = frameOf({ t: 'ink', strokes: inkPageOf(sessionId, page) })
  if (text === null) return null
  const frame = Buffer.from(text, 'utf8')
  inkFrames.set(sessionId, { rev, page, frame })
  return frame
}

/* --------------------------------------------------------------- socket */

export function handleControlSocket(ws: WebSocket, sessionId: string, payload: TokenPayload): void {
  let room = rooms.get(sessionId)
  if (!room) {
    room = {
      sockets: new Set<WebSocket>(),
      byParticipant: new Map<string, Set<WebSocket>>(),
      hosts: new Set<WebSocket>(),
      unwatch: () => {},
      pingTimer: null,
    }
    rooms.set(sessionId, room)
    // Attach after the room exists, so the first status change has somewhere to go.
    room.unwatch = watchRoomMeta(sessionId)
    // И один такт пинга на всю комнату — заводится с первым её сокетом и
    // снимается с последним (см. `pingRoom`).
    room.pingTimer = setInterval(() => pingRoom(sessionId), PING_INTERVAL_MS)
    room.pingTimer.unref?.()
  }
  room.sockets.add(ws)
  const mine = room.byParticipant.get(payload.participantId) ?? new Set<WebSocket>()
  mine.add(ws)
  room.byParticipant.set(payload.participantId, mine)
  // Роль запоминается здесь и больше нигде: `toHosts` и стопка консилиума
  // спрашивают только её, а сокет живёт с той ролью, с которой пришёл, —
  // ровно с той, которую dispatch проверяет на каждом сообщении.
  if (payload.role === 'host') room.hosts.add(ws)
  owner.set(ws, payload.participantId)

  // Before anything else: the browser gates its own interrupt/restart controls
  // on this, and the token it holds may say something staler than the truth.
  send(ws, { t: 'role', role: payload.role })
  send(ws, { t: 'instance:language', language: getLocale() })
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
  if (lecture) {
    /*
     * Чернила — ТОЛЬКО показываемой страницы, а про остальные едет опись.
     *
     * Двадцать минут разметки — это около мегабайта, и весь он уезжал каждому
     * вошедшему, хотя смотрит вошедший одну страницу; после сбоя Wi-Fi зал
     * возвращается весь сразу, и мегабайт умножается на пятьсот. Опись стоит
     * десятки байт и говорит ровно то, чего в обрезанном кадре больше нет:
     * какие страницы исписаны. По ней пульт считает заведённые чистые листы и
     * лента эскизов знает, что просить; недостающее вкладка спрашивает сама
     * (`ink:page`), а страницу, на которую ведущий перевёл зал, сервер
     * досылает.
     *
     * Порядок — кадр, потом опись: вкладка принимает `ink` как полную замену
     * чернил, и опись, пришедшая перед ним, описывала бы прошлую лекцию.
     */
    // И придержанные куски — до кадра: вошедший получает страницу целиком, а
    // склейка, уехавшая следом, дописала бы ему точки, которые в ней уже есть.
    flushInk(sessionId)
    const ink = inkFrame(sessionId, lecture.page)
    if (ink !== null) sendFrame(ws, ink)
    send(ws, { t: 'ink:pages', pages: inkedPagesOf(sessionId) })
  }
  /*
   * И консилиум: попытки живут не в документе, и опоздавший иначе не узнал бы
   * ни о своём листе, ни о стопке (хост), ни о счётчике — до первого чужого
   * нажатия.
   */
  councilWelcome(ws, sessionId, payload)

  missedPongs.set(ws, 0)

  const drop = () => {
    const current = rooms.get(sessionId)
    if (!current) return
    current.sockets.delete(ws)
    current.hosts.delete(ws)
    const who = owner.get(ws)
    const mine = who ? current.byParticipant.get(who) : undefined
    if (who && mine) {
      mine.delete(ws)
      if (mine.size === 0) current.byParticipant.delete(who)
    }
    /*
     * Ведущий ушёл молча — гасим его указку сами.
     *
     * Пульт на iPad выгружают из памяти, не сказав «off»: вкладка не успевает
     * ничего послать, а лекция продолжается — стёртой она от этого не
     * считается. И только если у ведущего в комнате не осталось ни одного
     * сокета: у него их обычно два (планшет и кафедральный ноутбук), и уход
     * второго не должен гасить пятно, которое первый держит неподвижно.
     */
    if (who && isPresenter(sessionId, who) && !current.byParticipant.has(who)) laserOff(sessionId)
    if (current.sockets.size === 0) {
      current.unwatch()
      if (current.pingTimer) clearInterval(current.pingTimer)
      current.pingTimer = null
      rooms.delete(sessionId)
      // Ждать в этой комнате больше некому: номера, которые в ней помнили,
      // ничьи.
      forgetQueue(sessionId)
      // И кэшам приветственной пачки незачем переживать последнего ушедшего:
      // семестр пустых комнат — это семестр списков файлов в памяти процесса.
      treeSent.delete(sessionId)
      inkFrames.delete(sessionId)
      laserHeld.delete(sessionId)
      inkHeld.delete(sessionId)
      // Хвосты склейки — туда же: слать их некому и некуда.
      forgetTicks(sessionId)
    }
  }

  ws.on('pong', () => {
    missedPongs.set(ws, 0)
  })

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return
    const message = parse(data)
    if (message === TOO_BIG) {
      // Называем оба потолка, до которых это доходит на самом деле: снимок
      // попытки и речь к странице. Всё прочее в этот провод в разы короче.
      send(ws, {
        t: 'error',
        message:
          tr("server.theMessageIsTooLongAndWas.e89d1c") +
          tr("server.anAttemptMayContainUpToCharacters.6a584e", { p0: formatNumber(MAX_ATTEMPT_CHARS) }) +
          tr("server.speakerNotesMayContainUpTo.bc3e46", { p0: formatNumber(MAX_NOTE_CHARS) }),
      })
      return
    }
    if (!message) return
    try {
      dispatch(ws, sessionId, payload, message)
    } catch (err) {
      // One bad request costs that click, never the seminar.
      console.error(`[control ${sessionId}] ${message.t} failed:`, reason(err, 'unknown error'))
      send(ws, { t: 'error', message: reason(err, tr("server.couldNotCompleteTheActionTryAgain.234540")) })
    }
  })

  ws.on('close', drop)
  ws.on('error', drop)

  // Переподключившаяся вкладка — это ровно тот, кто приносит с собой ячейку,
  // «работающую» в процессе, которого больше нет. Один проход на подключение.
  sweepOrphanRuns(sessionId)
  /*
   * `kernel` — состояние тетради комнаты, как и было: вкладка, открытая до
   * появления нескольких ядер, читает только его. `kernels` — по тетрадям, для
   * той, что умеет. Дальше и то и другое живёт в документе (`meta.kernels`), и
   * этот кадр только про первый миг, пока sync ещё едет.
   */
  send(ws, {
    t: 'ready',
    kernel: kernelStatus(sessionId),
    kernels: kernelStatuses(sessionId),
    // Не умеет их ровно брокер: Pod он заводит один на занятие. Тестовый
    // бэкенд умеет — у него ядра живут в одном Jupyter, и сессии по тетрадям
    // там такие же настоящие, как в контейнере.
    ownKernels: kernelBackend() !== 'broker',
  })
  send(ws, { t: 'terminal', status: terminalPhase(sessionId) })
  /*
   * Дерево — из общего кэша комнаты: после перезапуска сервера сюда приходят
   * пятьсот вкладок за две секунды, и обход папки на каждую — это секунды
   * блокировки цикла событий ровно тогда, когда все ждут возврата. Обход не
   * удался — молчим: пустой список здесь читался бы как «в комнате ничего
   * нет», а это не то, что случилось.
   *
   * Остальная цена того же возврата замерена и записана числом, а не догадкой
   * (tests/sync-storm-cost.test.mts): на семестровой комнате step2 каждого
   * вернувшегося — 87 КБ и 5.6 мс разбора гейтом, ответ сервера ему — те же 87
   * КБ. Это ×500 и лежит уже не здесь, а на общем документе.
   */
  /*
   * И номер списка вошедший получает вместе с ним. Это же и лечит расхождение,
   * ради которого раньше снималась расписка: пока комната стояла пустой, дерево
   * могло измениться, и вошедший пересчитал его — то есть сдвинул номер. У
   * остальных на руках прежний, и первая же дельта к ним не подойдёт: они
   * спросят дерево целиком сами (`files:ask`), вместо того чтобы применить
   * перемену к чужому списку.
   */
  const files = filesFrame(sessionId)
  if (files !== null) sendFrame(ws, files)
}
