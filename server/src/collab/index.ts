import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { Awareness } from 'y-protocols/awareness'
import { WebSocket, type RawData } from 'ws'
import type { YCell } from '@shared/notebook'
import {
  allCellArrays,
  clearStaleExecution,
  createTerminalLine,
  ensureInitialNotebook,
  getCells,
  getChat,
  getMeta,
  getTerminal,
} from '@shared/notebook'
import type { AwarenessUser, GateRule, ParticipantRole } from '@shared/protocol'
import { getRules, getSession, isFinished, renameSession } from '../db.js'
import { seldom, tally } from '../log.js'
import { classify, MAX_SYNC_STEP2_BYTES, permits } from './gate.js'
import { forgetSession, onCarets, rememberDeleted, resetRetyped, settleFresh } from './ops.js'
import {
  bindPersistence,
  flushPersistence,
  discardPersistence,
  flushAllPersistence,
  invalidateSnapshot,
} from './persistence.js'
import {
  RESTORE_ORIGIN,
  beginHistory,
  discardBurst,
  flushAllHistory,
  forgetHistory,
  record,
} from './history.js'
import { flushAllFiles, forgetFiles } from './files.js'
import { watchBooks } from './books.js'
import { forgetUndo } from '../ai/agent.js'
import { abortSession } from '../ai/index.js'

/**
 * Происхождение для записи, которую сервер делает от чьего-то имени.
 *
 * `onBehalfOf(id)` в транзакции — и версия в истории подписана этим человеком,
 * а не «комнатой». Составить такую строку может только код на сервере:
 * обновление от клиента приходит с сокетом в качестве происхождения.
 */
const BEHALF_PREFIX = 'on-behalf:'

/**
 * Записать в документ комнаты от имени человека, а не от имени сервера.
 *
 * Вложенная `doc.transact` присоединяется к внешней, и происхождение остаётся
 * внешним — поэтому обёртка работает даже вокруг кода, который заводит свою
 * транзакцию сам (а `acceptPatch` именно такой).
 */
export function applyOnBehalf(sessionId: string, participantId: string, write: () => void): void {
  const { doc } = getSessionDoc(sessionId)
  doc.transact(write, `${BEHALF_PREFIX}${participantId}`)
}

/**
 * The server side of the collaborative document.
 *
 * This speaks the y-websocket wire protocol (the browser uses the stock
 * `WebsocketProvider`), but it is not a dumb relay: the server holds the
 * authoritative Y.Doc in memory and is a first-class writer. The kernel runtime
 * appends execution output straight into that doc, which is how results reach
 * everyone — including whoever opens the link two minutes later.
 */

/** y-websocket's own frame tags. The numbers are the protocol, not a choice. */
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/*
 * Under the thirty seconds that proxies and load balancers commonly use as an
 * idle timeout. A seminar has long silences — nobody types while the teacher
 * talks — and a socket dropped for being quiet looks to the room like the
 * server going away.
 */
const PING_INTERVAL_MS = 25_000
/** A socket that ignores this many consecutive pings is a closed laptop lid. */
const MAX_MISSED_PONGS = 2

export interface SessionDoc {
  sessionId: string
  doc: Y.Doc
  awareness: Awareness
}

/** Marks a write as the server's own, so its observers do not chase themselves. */
const ORIGIN = 'server'

/**
 * Эту ячейку завела вот эта транзакция?
 *
 * Так спрашивает и сам Yjs: у структуры, появившейся в транзакции, такт не ниже
 * того, на котором её клиент стоял до начала. Нужно там, где из двух одинаковых
 * имён надо выбрать пришедшее, а не то, что уже жило в тетради.
 */
function madeIn(transaction: Y.Transaction, cell: YCell): boolean {
  const item = cell._item
  if (!item) return false
  return item.id.clock >= (transaction.beforeState.get(item.id.client) ?? 0)
}

/**
 * Ячейки, в которых прямо сейчас стоят курсоры, — по присутствию.
 *
 * Нужно перестановке ячеек: клон уносит с собой нажатия, ушедшие в старый
 * `Y.Text` за круг до сервера, и выбирать, кого пересоздавать, лучше зная, где
 * кто стоит. В `ops.ts` попадает регистрацией, а не импортом, чтобы тот остался
 * модулем без сокетов и базы; возврат версии (`history.ts · reorder`) пересобирает
 * клонами весь лист и вправе спросить о том же.
 */
export function cellsWithCarets(doc: Y.Doc): ReadonlySet<string> {
  const busy = new Set<string>()
  for (const entry of docs.values()) {
    if (entry.doc !== doc) continue
    for (const state of entry.awareness.getStates().values()) {
      const user = (state as { user?: AwarenessUser } | null)?.user
      const id = user?.activeCellId
      if (typeof id === 'string' && id) busy.add(id)
    }
    break
  }
  return busy
}

onCarets(cellsWithCarets)

interface ConnState {
  /**
   * Who is on the other end.
   *
   * The history needs an author for every change, and the update bytes cannot
   * give one: an insertion carries the Yjs client that made it, but a deletion
   * carries the client whose text was deleted — the victim, not the author. The
   * socket knows, because the token said so when it connected.
   */
  participantId: string | null
  /** Awareness clientIDs this socket introduced, so we can retract exactly those. */
  clientIds: Set<number>
  missedPongs: number
  pingTimer: NodeJS.Timeout
  /**
   * The role the token carried. The document is shared and every field in it is
   * writable by anyone connected — that is what a CRDT is — so this is not an
   * access list. It is here for the one field the interface already promises is
   * the host's: the seminar's name.
   */
  role: ParticipantRole
  /**
   * Когда открылся этот сокет.
   *
   * Комната знает про себя «сколько людей сейчас», но не знает «с какого
   * момента идёт то, что идёт»: строка семинара помнит только час создания, а
   * заводят его за неделю до пары и переиспользуют на второй. Из-за этого
   * панель писала «Running now · started 6 days ago» про занятие, начавшееся
   * двадцать минут назад. Часы занятия — это самый старый из открытых сейчас
   * сокетов (см. liveSince), и других у сервера нет.
   */
  openedAt: number
}

interface DocEntry extends SessionDoc {
  conns: Map<WebSocket, ConnState>
  /** Снять наблюдение за тетрадями и отпустить запись на диск, дописав её. */
  dispose: () => void
  /** Только снять наблюдение за тетрадями — для удаления семинара, где писать некуда. */
  unwatch: () => void
  /**
   * Кадры, ещё не уехавшие в комнату, — см. `scheduleFlush`.
   *
   * Правки лежат вместе с сокетом, по которому пришли: свои же байты автору
   * обратно не едут, и склейка обязана это сохранить.
   */
  outbox: { updates: { update: Uint8Array; from: unknown }[]; faces: Set<number>; queued: boolean }
  /** С какого момента в комнате нет ни одного сокета; 0 — есть. */
  emptySince: number
}

const docs = new Map<string, DocEntry>()

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data)
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
  }
  const buf = data as Buffer
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/**
 * Сколько байт может ждать отправки на одном сокете, прежде чем ему перестают
 * слать курсоры, — и сколько, прежде чем его считают безнадёжным.
 *
 * `ws.send` не спрашивает, успевает ли сеть: он складывает кадр в очередь
 * сокета и возвращается. `plt.imshow` при dpi=200 — мегабайт-другой в одном
 * обновлении, и на пятистах слушателях с аудиторным аплинком это гигабайт,
 * который сервер держит в памяти по копии на сокет, пока картинка ползёт к
 * телефону на краю сети. Каждое следующее нажатие в комнате встаёт в эту
 * очередь ЗА картинкой — у всех.
 *
 * Поэтому две черты. За первой перестают ехать кадры присутствия: курсор —
 * единственное, что можно не досылать без последствий (следующее движение
 * объявит положение заново). За второй сокет закрывается: он всё равно
 * получает вчерашнюю комнату, а браузер переподключится через секунду и
 * соберёт состояние заново одним шагом синхронизации — дешевле, чем мегабайты
 * в памяти сервера.
 */
const AWARENESS_STALL_BYTES = 1024 * 1024
const HOPELESS_BYTES = 8 * 1024 * 1024

/**
 * Потолок кадра, выше которого сжатие не окупается.
 *
 * `perMessageDeflate` (server/src/index.ts) работает НА СОКЕТ: у ws свой
 * `PerMessageDeflate` на соединение, поэтому один двухмегабайтный кадр вывода —
 * это пятьсот независимых заданий zlib по два мегабайта через общий лимитер на
 * десять потоков, то есть секунды процессорного времени и пятьсот сжатых копий
 * в памяти на одну картинку.
 *
 * `threshold` в настройке сервера этого не лечит: он НИЖНЯЯ граница («мельче —
 * не сжимать»), и поднять его значит перестать сжимать ровно то, ради чего
 * сжатие заведено, — первые шаги синхронизации в десятки килобайт. Верхняя
 * граница живёт здесь, где виден размер кадра.
 *
 * Четверть мегабайта: текстовый вывод и дерево такого размера жмутся в разы и
 * стоят миллисекунды, а всё, что крупнее, — это data-вывод (картинка, PDF) в
 * base64, то есть уже сжатые байты, из которых deflate вернёт четверть объёма
 * за куда большую цену.
 */
const MAX_DEFLATE_BYTES = 256 * 1024

function send(
  entry: DocEntry,
  conn: WebSocket,
  message: Uint8Array,
  /** Присутствие можно пропустить; правки — нет, они и есть документ. */
  kind: 'sync' | 'awareness' = 'sync',
): void {
  if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
    closeConn(entry, conn)
    return
  }
  const waiting = conn.bufferedAmount
  if (waiting > HOPELESS_BYTES) {
    if (seldom(`collab-backpressure-${entry.sessionId}`)) {
      console.warn(
        `[collab ${entry.sessionId}] сокет отстал на ${Math.round(waiting / 1024)} КБ — закрыт, ` +
          'браузер соберёт документ заново',
      )
    }
    closeConn(entry, conn)
    return
  }
  if (kind === 'awareness' && waiting > AWARENESS_STALL_BYTES) return
  try {
    conn.send(message, { compress: message.byteLength <= MAX_DEFLATE_BYTES }, (err) => {
      if (err) closeConn(entry, conn)
    })
  } catch {
    closeConn(entry, conn)
  }
}

function closeConn(entry: DocEntry, conn: WebSocket): void {
  const state = entry.conns.get(conn)
  if (!state) return
  entry.conns.delete(conn)
  // Ушёл последний — с этой секунды комната пустая, и отсчёт до выселения
  // (см. `sweepIdleRooms`) идёт отсюда.
  if (entry.conns.size === 0) entry.emptySince = Date.now()
  clearInterval(state.pingTimer)
  // Without this the People panel keeps showing whoever just walked out.
  awarenessProtocol.removeAwarenessStates(entry.awareness, Array.from(state.clientIds), null)
  try {
    conn.close()
  } catch {
    /* already gone */
  }
}

function syncFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

/**
 * Рассылка комнате — одним кадром за тик цикла событий, а не кадром на нажатие.
 *
 * Считать так. Одно нажатие — это одно обновление документа И один кадр
 * присутствия (`yCollab` объявляет положение курсора на каждое движение
 * выделения). Без склейки комната из пятисот человек получает на него две
 * тысячи `ws.send`, каждый со своим `deflate`; двадцать печатающих по пять
 * нажатий в секунду — двести тысяч отправок в секунду, и цикл событий занят
 * только ими.
 *
 * `setImmediate` выбран не «на глазок»: он срабатывает после того, как Node
 * разобрал ВСЕ кадры, пришедшие в текущем цикле опроса сокетов. То есть
 * задержка ровно нулевая для одинокого нажатия (тик и так закончится сейчас) и
 * тем больше склеивает, чем больше нагрузка, — а это и есть то, что нужно.
 */
function scheduleFlush(entry: DocEntry): void {
  if (entry.outbox.queued) return
  entry.outbox.queued = true
  setImmediate(() => {
    /*
     * Своё исключение — только своей комнате.
     *
     * Это `setImmediate`, а не обработчик сокета: брошенное отсюда не ловит
     * никто, и одна не собравшаяся рассылка унесла бы процесс вместе со всеми
     * остальными комнатами.
     */
    try {
      flushRoom(entry)
    } catch (err) {
      console.error(`[collab] could not deliver a frame to ${entry.sessionId}`, err)
      entry.outbox.updates = []
      entry.outbox.faces.clear()
    }
  })
}

function flushRoom(entry: DocEntry): void {
  entry.outbox.queued = false
  /*
   * Некому — значит и кодировать нечего. Ядро дописывает вывод и в комнату, из
   * которой все вышли (за результатом вернутся), и склейка кадра для нуля
   * слушателей — это `mergeUpdates` целого всплеска впустую.
   */
  if (entry.conns.size === 0) {
    entry.outbox.updates = []
    entry.outbox.faces.clear()
    return
  }
  const batch = entry.outbox.updates
  if (batch.length > 0) {
    entry.outbox.updates = []
    sendUpdates(entry, batch)
  }
  const faces = entry.outbox.faces
  if (faces.size > 0) {
    entry.outbox.faces = new Set()
    sendAwareness(entry, [...faces])
  }
}

const mergeOf = (batch: { update: Uint8Array }[]): Uint8Array =>
  batch.length === 1 ? batch[0].update : Y.mergeUpdates(batch.map((it) => it.update))

function sendUpdates(entry: DocEntry, batch: { update: Uint8Array; from: unknown }[]): void {
  let merged: Uint8Array
  try {
    merged = mergeOf(batch)
  } catch (err) {
    /*
     * Склейка — это ускорение, а не протокол. Если `mergeUpdates` почему-то не
     * справился, комната обязана получить свои правки, пусть и по одной: иначе
     * оптимизация превращается в молчание, которое никто не заметит.
     */
    console.error(`[collab] could not merge updates for ${entry.sessionId}`, err)
    for (const item of batch) {
      const frame = syncFrame(item.update)
      for (const conn of entry.conns.keys()) if (conn !== item.from) send(entry, conn, frame)
    }
    return
  }
  const whole = syncFrame(merged)
  /*
   * Автору его собственные байты обратно не едут. Происхождение — сокет только
   * у того, что сделал человек; серверные записи (вывод ядра, правка оракула)
   * приходят с другим происхождением и уезжают всем.
   *
   * Поэтому кадров получается не один, а один плюс по одному на КАЖДЫЙ сокет,
   * приславший что-то в этом тике, — обычно это ровно один человек.
   */
  const authors = new Set(batch.map((it) => it.from))
  const spare = new Map<unknown, Uint8Array | null>()
  for (const conn of entry.conns.keys()) {
    if (!authors.has(conn)) {
      send(entry, conn, whole)
      continue
    }
    let frame = spare.get(conn)
    if (frame === undefined) {
      const rest = batch.filter((it) => it.from !== conn)
      frame = rest.length === 0 ? null : syncFrame(mergeOf(rest))
      spare.set(conn, frame)
    }
    if (frame) send(entry, conn, frame)
  }
}

function sendAwareness(entry: DocEntry, clients: number[]): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(entry.awareness, clients),
  )
  const message = encoding.toUint8Array(encoder)
  for (const conn of entry.conns.keys()) send(entry, conn, message, 'awareness')
}

/**
 * The document for a session, created on first use.
 *
 * Seeding happens here rather than in the browser: this runs once, under a
 * single writer, before anyone can connect. Two students tapping the link at
 * the same instant would otherwise each seed the starter cells into their own
 * copy and the merge would show both.
 */
export function getSessionDoc(sessionId: string, title?: string): SessionDoc {
  return getEntry(sessionId, title)
}

/**
 * Документ комнаты, если он уже открыт, — и `null`, если нет.
 *
 * Отличается от `getSessionDoc` ровно тем, что НЕ заводит его. Разница
 * оказалась не косметической: отложенная работа, доехавшая после закрытия
 * комнаты — запись файла тетради, уборка за удалённым файлом, — звала
 * `getSessionDoc`, тот честно строил комнату заново из снимка, новая комната
 * заводила себе таймеры, и следующая отложенная работа строила её опять.
 * Процесс переставал завершаться, а удалённая комната возвращалась в память.
 *
 * Правило простое: заводить документ имеет право только то, что делает человек.
 * Всё, что доезжает само, обязано спрашивать так.
 */
export function peekSessionDoc(sessionId: string): SessionDoc | null {
  return docs.get(sessionId) ?? null
}

function getEntry(sessionId: string, title?: string): DocEntry {
  const existing = docs.get(sessionId)
  if (existing) return existing

  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  // The server is a writer, not a person in the room.
  awareness.setLocalState(null)

  const entry: DocEntry = {
    sessionId,
    doc,
    awareness,
    conns: new Map(),
    dispose: bindPersistence(sessionId, doc),
    unwatch: () => {},
    outbox: { updates: [], faces: new Set(), queued: false },
    // Комната заводится не только человеком (ядро, оракул, маршрут истории), и
    // пустой она с этой секунды: отсчёт до выселения идёт от рождения.
    emptySince: Date.now(),
  }
  docs.set(sessionId, entry)
  if (dropPending(sessionId, doc)) invalidateSnapshot(sessionId)
  /*
   * Файлы тетрадей — сразу после того, как документ попал в реестр, и до
   * засева: наблюдатель должен увидеть засев обычной правкой, а `watchBooks`
   * зовёт `getSessionDoc` изнутри и нашёл бы полупостроенную комнату, встань он
   * строкой выше.
   */
  const unwatchBooks = watchBooks(sessionId, doc)
  const closeBinding = entry.dispose
  entry.unwatch = unwatchBooks
  entry.dispose = () => {
    unwatchBooks()
    closeBinding()
  }

  /*
   * Seed, then put it on disk before returning. A room that has just been
   * created is at its most vulnerable: the snapshot is debounced by seconds and
   * the room is reachable immediately, so a crash in between leaves a seminar
   * with a row and no document. On the way back the server would find nothing
   * stored, conclude the room is new and seed it again — and the students, who
   * still hold the real notebook, would merge it in underneath a second copy of
   * the starter cells. Encoding a two-cell document costs less than the
   * scheduling does.
   */
  if (ensureInitialNotebook(doc, title ?? getSession(sessionId)?.name)) {
    flushPersistence(sessionId)
  }

  /*
   * Whatever the snapshot says was running, was not running by the time this
   * process existed. Cleared here rather than by the kernel, because a room can
   * be reopened without a kernel ever being asked for one — the notebook has to
   * be honest before anybody presses anything.
   */
  if (clearStaleExecution(doc) > 0) {
    doc.transact(() => {
      getTerminal(doc).push([
        createTerminalLine({
          kind: 'system',
          text: 'The server restarted. Cells that were running or queued were put back to rest — run them again when you are ready.',
        }),
      ])
    }, ORIGIN)
  }

  /*
   * История начинается ПОСЛЕ засева, и это не мелочь порядка.
   *
   * Стояло раньше — с комментарием, обещавшим ровно обратное: «новая комната
   * записывает свои стартовые ячейки первой версией». Не записывала. Слепок
   * снимался с пустого документа (две байты), засев происходил следом и в
   * историю не попадал вовсе — наблюдатель `doc.on('update')` вешается ещё
   * ниже. Дальше каждая строка была дельтой к документу, которого история
   * никогда не видела: Yjs складывал их в pending, и ЛЮБАЯ версия
   * разворачивалась в пустую тетрадь. Молча — вкладка «История» показывала
   * ноль ячеек и не жаловалась.
   *
   * Проверено на живой базе: у семинара с двадцатью одной строкой все
   * двадцать одна давали ноль ячеек.
   *
   * И ПОСЛЕ уборки протухшего запуска — по той же причине, с другого конца.
   * Между базовой точкой и подпиской `record()` строкой ниже документ обязан
   * стоять: `clearStaleExecution` пишет в него своими тактами (очередь,
   * `runningCell`, `startedAt`, `stdin` — и пишет даже когда сбрасывать нечего),
   * а эти такты не попадали ни в базу, ни в дельты. Дальше любая серверная
   * запись — принятый патч оракула, перестановка ячейки — ссылалась при разборе
   * версии на такт, которого в истории нет, и навсегда уходила в pending:
   * принятие патча не показывалось в ленте, а «вернуть версию» обнуляло текст
   * ячейки у всей комнаты.
   */
  beginHistory(sessionId, doc)

  /*
   * A cell id appears once.
   *
   * Y.Array has no move, so the editor moves a cell by cloning it and deleting
   * the original. Two people nudging the same cell at the same moment merge
   * into two deletes — which collapse into one — and two inserts, which do not:
   * the notebook ends up holding the same cell twice, under one id. Everything
   * downstream is keyed by that id — running it, attributing it, asking the
   * oracle about it — so a duplicate is not a cosmetic problem.
   *
   * Repaired here rather than in the editor for the reason the title is: there
   * is exactly one server, and it cannot be a stale client racing another.
   *
   * Кто из двух остаётся — не безразлично, и раньше было. Совпадение имён
   * бывает законным: кто-то вернул удалённую ячейку из истории — возврат
   * воссоздаёт её с ПРЕЖНИМ именем, — а тот, кто её удалял, нажал Ctrl+Z, и
   * Yjs отменил удаление копией. Остаётся живая ячейка, уходит копия, которую
   * принесла эта транзакция; среди копий, приехавших разом (две слитые
   * перестановки), остаётся первая.
   */
  /*
   * Наблюдатель на весь документ, а не на один массив ячеек: тетрадей в комнате
   * несколько, они появляются на ходу, и подписка на каждую при появлении — это
   * ещё одно место, где можно забыть отписаться.
   */
  doc.on('afterTransaction', (transaction: Y.Transaction) => {
    if (transaction.origin === ORIGIN) return
    // Только вставка заводит двойника, и только в массиве ячеек.
    let touched = false
    transaction.changed.forEach((_keys, type) => {
      if (type instanceof Y.Array) touched = true
    })
    if (!touched) return

    /*
     * Уходит та копия, которую завела ЭТА транзакция, а не та, что стоит дальше
     * по списку. Разница видна там, где совпадение имён законно: кто-то вернул
     * удалённую ячейку из истории — возврат воссоздаёт её с ПРЕЖНИМ именем, — а
     * тот, кто её удалял, нажал Ctrl+Z, и Yjs отменил удаление копией. Выкинуть
     * надо копию: иначе новая, встав выше по списку, вытесняла бы живую ячейку
     * вместе с её выводом, и подменить чужую ячейку своей можно было бы одним
     * совпадением имени.
     *
     * Имена сверяются по ВСЕМ тетрадям сразу, а не внутри каждой: ячейку ищут
     * по имени, не зная тетради (см. `findCell`), и два одинаковых имени в
     * разных тетрадях значат, что «Запустить» иногда запускает не ту.
     */
    const seen = new Map<string, { cells: Y.Array<YCell>; index: number; fresh: boolean }>()
    const doomed = new Map<Y.Array<YCell>, number[]>()
    const drop = (cells: Y.Array<YCell>, index: number): void => {
      const list = doomed.get(cells)
      if (list) list.push(index)
      else doomed.set(cells, [index])
    }
    for (const cells of allCellArrays(doc)) {
      cells.forEach((cell: YCell, index: number) => {
        const id = cell.get('id')
        if (typeof id !== 'string') return
        const fresh = madeIn(transaction, cell)
        const first = seen.get(id)
        if (!first) {
          seen.set(id, { cells, index, fresh })
          return
        }
        if (first.fresh && !fresh) {
          drop(first.cells, first.index)
          seen.set(id, { cells, index, fresh })
        } else {
          drop(cells, index)
        }
      })
    }
    if (doomed.size === 0) return
    doc.transact(() => {
      // Back to front, so the earlier indices stay valid as they go.
      for (const [cells, indices] of doomed) {
        for (const index of indices.sort((a, b) => b - a)) cells.delete(index, 1)
      }
    }, ORIGIN)
  })

  /*
   * The room's title is the seminar's name, and the admin list reads it from the
   * sessions row. Mirror one into the other so a rename — from the header or
   * from the panel — is one name and not two.
   *
   * Observed rather than written by whoever renamed: there is exactly one
   * writer this way, and it is the server, which cannot be a stale client.
   */
  const meta = getMeta(doc)
  meta.observe((event: Y.YMapEvent<unknown>) => {
    if (!event.keysChanged.has('title')) return
    if (event.transaction.origin === ORIGIN) return

    /*
     * The header lets only the host rename the room, and this mirrors the name
     * into the row the admin list reads — so a rename written straight into the
     * shared document by anyone else would reach further than the interface it
     * came from. Put it back rather than pass it on.
     *
     * This is the one field defended this way. Everything else in the document
     * is writable by everyone by construction, which the README says out loud.
     */
    const from = event.transaction.origin
    const writer = from instanceof WebSocket ? entry.conns.get(from) : undefined
    if (writer && writer.role !== 'host') {
      const previous = event.changes.keys.get('title')?.oldValue
      doc.transact(() => {
        if (typeof previous === 'string') meta.set('title', previous)
        else meta.delete('title')
      }, ORIGIN)
      return
    }

    const title = meta.get('title')
    if (typeof title !== 'string' || !title.trim()) return
    if (getSession(sessionId)?.name === title) return
    renameSession(sessionId, title)
  })

  doc.on('update', (update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
    entry.outbox.updates.push({ update, from: origin })
    scheduleFlush(entry)
    /*
     * The author comes from the origin, which for anything a person did is the
     * socket it arrived on. The server's own writes — seeding a new room,
     * importing from GitHub, the kernel writing an output — have no author, and
     * that is honest: nobody in the room typed them.
     *
     * A restore is skipped here and recorded by the restore itself, under the
     * name of whoever pressed the button.
     */
    if (origin === RESTORE_ORIGIN) return
    /*
     * Автор берётся из происхождения обновления.
     *
     * Обычно это сокет, по которому оно пришло. Но сервер и сам иногда пишет в
     * документ от чьего-то имени — сейчас так применяется предложение оракула:
     * решение принимает сервер, чтобы две вкладки не вписали патч дважды, и
     * без этой ветки версия в истории оказывалась ничьей. Строка «принял
     * Пётр» превращалась в «the room», а Ctrl+Z у самого Петра переставал
     * доставать до его же собственной правки.
     *
     * Форма — `on-behalf:<participantId>`: строка, которую может составить
     * только код на сервере, потому что клиентское обновление приходит с
     * сокетом в качестве происхождения и никогда со строкой.
     */
    const author =
      origin instanceof WebSocket
        ? (entry.conns.get(origin)?.participantId ?? null)
        : typeof origin === 'string' && origin.startsWith(BEHALF_PREFIX)
          ? origin.slice(BEHALF_PREFIX.length)
          : null
    record(sessionId, doc, update, author, tr)
  })

  awareness.on(
    'update',
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const state = origin instanceof WebSocket ? entry.conns.get(origin) : undefined
      if (state) {
        for (const id of changes.added) state.clientIds.add(id)
        for (const id of changes.removed) state.clientIds.delete(id)
        /*
         * Before the relay, not after. Awareness is whatever the client says
         * it is — that is the point of it, and why a caret can carry a colour.
         * But `role` is not a preference: the People panel draws a Host badge
         * from it, and one edit to localStorage put a second teacher in front
         * of the room. The server knows the real role for this socket, so it
         * corrects the state and then broadcasts the corrected one. The forger
         * still lies to their own screen; nobody else hears it.
         */
        pinRole(entry, state, changes.added.concat(changes.updated))
      }
      for (const id of changes.added) entry.outbox.faces.add(id)
      for (const id of changes.updated) entry.outbox.faces.add(id)
      for (const id of changes.removed) entry.outbox.faces.add(id)
      scheduleFlush(entry)
    },
  )

  return entry
}

/**
 * Подтипы протокола синхронизации. Числа — сам протокол, а не выбор.
 *
 * `1` (step2) и `2` (update) проверяются одинаково. Проверять только `2` — дыра
 * шириной в одно переподключение: сервер шлёт step1 при каждом соединении,
 * браузер отвечает step2 всем, чего у сервера нет, и любой отказ отмывается
 * повторным входом.
 */
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

/**
 * Отказать этому соединению в кадре.
 *
 * Закрытие, а не молчание. Ничто в протоколе синхронизации не умеет убрать у
 * клиента структуру, которая у него уже есть: слияние CRDT — объединение, и
 * ни `encodeStateAsUpdate`, ни полный круг step1/step2 не уберут отказанный
 * текст с экрана того, кто его набрал. Поэтому клиент, получивший 4403,
 * пересобирает документ с нуля — и новый clientID заодно лечит разрыв в
 * тактах, из-за которого следующее разрешённое нажатие иначе легло бы в
 * `pendingStructs` за тактом, который сервер не принял.
 */
function refuse(
  entry: DocEntry,
  conn: WebSocket,
  refusal: {
    rule: GateRule
    message: string
    /**
     * Что именно не разобралось — словами гейта, с путём. В журнал, не
     * человеку: по одной общей фразе про кэш два вечера искали причину,
     * которая называлась «кадр слишком велик для разбора (cells#…)».
     */
    detail?: string
    /**
     * Отказ первой синхронизации, а не правке. Вкладка по этому слову в кадре
     * закрытия отличает «ваш кэш старше сервера» от «эту правку не приняли»:
     * управляющий сокет с текстом отказа идёт другим проводом и может прийти
     * позже закрытия.
     */
    stale?: boolean
  },
): void {
  const state = entry.conns.get(conn)
  if (state?.participantId && refusalListener) {
    refusalListener(entry.sessionId, state.participantId, refusal)
  }
  tally('gate')
  /*
   * Причина — словами, но не на каждый отказ.
   *
   * Отказ гейта в журнале нужен: по нему видно, что комната упёрлась в правило,
   * а не сломалась. Но отказывают целому кадру, и браузер после 4403
   * пересобирает документ и пробует снова — на потоке это лавина одинаковых
   * строк. Первая за минуту на комнату и правило говорится, остальные видны
   * числом в сводке. Ни имени участника, ни текста правки: только правило и
   * причина, которую сформулировал сам гейт.
   */
  if (seldom(`gate:${entry.sessionId}:${refusal.rule}`)) {
    const detail = refusal.detail ? ` · ${refusal.detail}` : ''
    console.warn(`[gate ${entry.sessionId}] ${refusal.rule} refused — ${refusal.message}${detail}`)
  }
  try {
    conn.close(4403, refusal.stale ? 'stale' : refusal.rule)
  } catch {
    /* сокет уже закрыт — отказ всё равно состоялся: кадр не применён */
  }
}

/**
 * Выбросить из документа то, что в него так и не встало.
 *
 * `pendingStructs` — нажатия, для которых Yjs ждёт предыдущего такта их же
 * клиента. Ждать нечего: тот кадр гейт отказал, и такт не придёт никогда. А
 * подвисшее не лежит тихо — `encodeStateAsUpdate` кладёт его в снимок и в
 * каждый step2 каждой вкладке, вкладка возвращает его в своём step2, и гейт
 * судит те же нажатия при каждом входе — в закрытой комнате отказом. Измерено
 * на живой комнате: 140 КБ подвисших нажатий шести клиентов после одного утра.
 *
 * Сейчас гейт такой кадр не пропускает (gate.ts · checkContiguity), так что
 * это уборка за прошлым: снимки, записанные до неё. Вкладки, у которых мусор
 * остался в кэше, получат отказ на первом же входе и пересоберутся начисто.
 *
 * Возвращает, было ли что выбрасывать.
 */
function dropPending(sessionId: string, doc: Y.Doc): boolean {
  const store = doc.store as unknown as {
    pendingStructs: { update: Uint8Array } | null
    pendingDs: Uint8Array | null
  }
  if (!store.pendingStructs && !store.pendingDs) return false
  const bytes = (store.pendingStructs?.update.byteLength ?? 0) + (store.pendingDs?.byteLength ?? 0)
  console.warn(`[room ${sessionId}] dropped ${bytes} bytes of pending structs that could never integrate`)
  store.pendingStructs = null
  store.pendingDs = null
  return true
}

type RefusalListener = (
  sessionId: string,
  participantId: string,
  refusal: { rule: GateRule; message: string },
) => void

let refusalListener: RefusalListener | null = null

/**
 * Кому сообщать словами об отказе. Регистрирует `control.ts`: сообщение уходит
 * по управляющему сокету, а импортировать его отсюда значило бы замкнуть цикл.
 */
export function onRefusal(listener: RefusalListener): void {
  refusalListener = listener
}

type RemovedListener = (sessionId: string, cellIds: string[]) => void

let removedListener: RemovedListener | null = null

/**
 * Каких ячеек в комнате больше нет. Регистрирует `control.ts`.
 *
 * Удалить можно и ту ячейку, которую ядро прямо сейчас считает или держит в
 * очереди: документ этого не запрещает, и запрещать не следует — человек видит
 * ячейку и вправе её убрать. Расходится другое: ядро продолжает крутить цикл
 * ради ячейки, которой нет, а `meta.runningCell` называет исчезнувшее имя.
 *
 * Через регистрацию, как и `onRefusal`: снимает с выполнения ядро, а импорт
 * ядра отсюда замкнул бы модули друг на друга — ядро само берёт документ через
 * `getSessionDoc`.
 */
export function onCellsRemoved(listener: RemovedListener): void {
  removedListener = listener
}

/**
 * Сколько лиц одно соединение может завести в комнате.
 *
 * Одно на вкладку — норма; вторым бывает переход между провайдерами при
 * переподключении. Четыре — потолок с запасом, а без потолка один сокет
 * наполняет панель людей выдуманными участниками, у каждого из которых имя,
 * цвет и курсор в чужой ячейке.
 */
const MAX_AWARENESS_CLIENTS = 4

/**
 * Лица, которые комната уже видела, — включая ушедшие вместе со своим сокетом.
 *
 * `y-websocket` пересылает в сокет КАЖДОЕ обновление присутствия, которое
 * применил, — в том числе приехавшее по BroadcastChannel из соседней вкладки
 * того же семинара. Пока сосед на связи, эхо отбивается тем, что его лицо уже
 * стоит в комнате. Но стоит соседу оборваться, `closeConn` его лицо снимает — и
 * эхо проходит: вкладка А присваивает себе clientID вкладки Б, кадры
 * переподключившегося Б молча отбрасываются, а уход А уносит Б из панели людей.
 *
 * Поэтому имя, которое комната уже слышала, достаётся только сокету, который
 * ещё никого не привёл: переподключившийся Б заходит со своим прежним clientID
 * первым же кадром, а у А своё лицо уже есть.
 *
 * По документу присутствия, а не по записи комнаты: этой же проверкой живут
 * сокеты редактора файлов (collab/files.ts), у которых своя.
 */
const introduced = new WeakMap<Awareness, Map<number, number>>()

/**
 * Сколько комната помнит ушедшее лицо.
 *
 * По времени, а не по счёту. Стоял потолок в 256 имён с подписью «столько
 * вкладок за пару не открывают» — неправда ровно на том масштабе, ради которого
 * продукт сделан: в комнате на пятьсот человек живых clientID заведомо больше,
 * а с переподключениями за пару их тысячи. Память переполнялась, забывала
 * ушедшие имена по одному — и защита от эха переставала действовать там, где
 * она и нужна: эхо соседней вкладки присваивало себе clientID ушедшего
 * участника, тот пропадал из панели людей, а его кадры молча отбрасывались.
 *
 * Полчаса — заведомо дольше, чем живёт эхо в `BroadcastChannel` соседней
 * вкладки (оно приезжает в ту же секунду), и заведомо короче пары. Цена памяти
 * — одно число на лицо: комната на пятьсот человек с переподключениями помнит
 * тысячи имён и стоит десятки килобайт.
 */
const REMEMBER_FACE_MS = 30 * 60 * 1000

/**
 * Сколько имён держим, пока не пришло время их забывать.
 *
 * Не мера комнаты, а предохранитель от бесконечного роста: сюда упирается
 * только тот, кто открывает вкладки быстрее, чем истекает получас.
 */
const MAX_REMEMBERED_CLIENTS = 8192

/** Забыть лица, которых комната не видела дольше `REMEMBER_FACE_MS`. */
function forgetOldFaces(known: Map<number, number>, now: number): void {
  for (const [clientId, at] of known) {
    if (now - at < REMEMBER_FACE_MS) continue
    known.delete(clientId)
  }
  // Не помогло — значит имена сыплются быстрее, чем истекают: уходят самые
  // старые, вставка в Map держит их первыми.
  while (known.size > MAX_REMEMBERED_CLIENTS) {
    const oldest = known.keys().next()
    if (oldest.done) break
    known.delete(oldest.value)
  }
}

/**
 * Всё, что проверке ниже нужно от документа: свои сокеты и своё присутствие.
 *
 * Не `Pick<DocEntry, …>`: этот же разбор служит документам файлов, а их
 * `ConnState` — свой (collab/files.ts) и совпадать с нашим не обязан. Пока
 * поля у них случайно сходились, `Pick` работал; первое же поле, нужное только
 * комнате, ломало сборку в чужом файле. Названо то, что правда требуется.
 */
export interface AwarenessOwner {
  conns: Map<WebSocket, { clientIds: Set<number> }>
  awareness: Awareness
}

/**
 * Кадр присутствия — только про себя.
 *
 * `applyAwarenessUpdate` принимает состояние ЛЮБОГО clientID, лишь бы такт был
 * выше: то есть один участник мог убрать всех остальных из панели людей для
 * всей комнаты или переписать чужой курсор вместе с именем и ролью. Сокет
 * знает, кого он привёл (`state.clientIds`), — и всё остальное отвергается.
 *
 * Отвергается кадр целиком, а не по одному лицу: у пакета присутствия нет
 * способа выкинуть из середины одну запись, и разбирать его на части значило бы
 * пересобирать его же протокол.
 */
export function ownAwareness(entry: AwarenessOwner, conn: WebSocket, payload: Uint8Array): boolean {
  const state = entry.conns.get(conn)
  if (!state) return false
  const decoder = decoding.createDecoder(payload)
  const count = decoding.readVarUint(decoder)
  const now = Date.now()
  for (let i = 0; i < count; i += 1) {
    const clientId = decoding.readVarUint(decoder)
    decoding.readVarUint(decoder) // такт — не наше дело
    /*
     * Состояние ПРОПУСКАЕТСЯ, а не читается.
     *
     * `readVarString` — это разбор UTF-8 в новую строку, то есть копия всего
     * JSON присутствия. А `y-websocket` возвращает серверу каждый кадр, который
     * применил, — в том числе чужой, приехавший от сервера же (см. load.mts):
     * в комнате на пятьсот вкладок это пятьсот копий чужого курсора на каждое
     * нажатие, и все они заведомо отвергаются строкой ниже. На проводе строка
     * лежит как длина плюс байты, так что пройти её мимо — это сложение.
     *
     * Длина — отдельной строкой, и это не вкусовщина. `decoder.pos +=
     * readVarUint(decoder)` в JS сначала берёт СТАРЫЙ `pos`, и байты самого
     * варинта длины пропадают: на кадре с одним лицом это незаметно (дальше
     * никто не читает), а со второго лица декодер разъезжается и клиентом
     * оказывается случайный байт чужого JSON — то есть проверка принадлежности
     * начинает пропускать чужое присутствие вторым лицом в кадре.
     */
    const bytes = decoding.readVarUint(decoder)
    decoder.pos += bytes
    if (state.clientIds.has(clientId)) continue
    // Новое лицо этого сокета — можно, пока их не слишком много.
    if (state.clientIds.size + 1 > MAX_AWARENESS_CLIENTS) return false
    if (entry.awareness.getStates().has(clientId)) return false
    let known = introduced.get(entry.awareness)
    if (!known) introduced.set(entry.awareness, (known = new Map()))
    // Чужое лицо, уже уходившее из комнаты, — эхо соседней вкладки.
    if (known.has(clientId) && state.clientIds.size > 0) return false
    state.clientIds.add(clientId)
    known.set(clientId, now)
    if (known.size > MAX_REMEMBERED_CLIENTS) forgetOldFaces(known, now)
  }
  return true
}

function handleMessage(entry: DocEntry, conn: WebSocket, data: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(data)
    const encoder = encoding.createEncoder()
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        /*
         * Проверка до применения, и позже её поставить некуда: ретрансляция,
         * запись в историю и запись на диск висят синхронно внутри
         * `applyUpdate` внутри `readSyncMessage`. Подтип читается с копии
         * декодера, чтобы настоящий остался нетронутым, если кадр принят.
         */
        const peek = decoding.clone(decoder)
        const subtype = decoding.readVarUint(peek)
        let accepted: { retyped: string[]; created: string[]; removed: string[] } | null = null
        /*
         * Чего эта ветка стоит на возврате зала — числом, а не на глаз.
         *
         * step2 вернувшегося — не «дельта в пару десятков байт»: он несёт весь
         * набор удалений комнаты, и ответ сервера синхронному клиенту,
         * `encodeStateAsUpdate(doc, sv)`, — тот же набор обратно. Замер на
         * семестровой комнате (400 ячеек, 160 тыс. набранных символов, 22.8 тыс.
         * удалений, документ 750 КБ; tests/sync-storm-cost.test.mts):
         *
         *   step2 вернувшегося ......................... 87 КБ
         *   `classify` этого кадра ..................... 5.6 мс
         *   `encodeStateAsUpdate(doc, sv)` в ответ ..... 87 КБ, 1.3 мс
         *
         * Пятьсот вкладок возвращаются за одну-две секунды после перезапуска
         * сервера или моргания ретранслятора — это ≈2.8 с занятого цикла
         * событий на одном разборе и ≈44 МБ исходящего. До потолка кадра
         * (`MAX_SYNC_STEP2_BYTES`, 8 МБ) при этом ещё ×90 запаса: упирается не
         * он, а цикл событий.
         */
        if (subtype === SYNC_STEP2 || subtype === SYNC_UPDATE) {
          const state = entry.conns.get(conn)
          const stale = subtype === SYNC_STEP2
          const judgement = classify(
            entry.doc,
            decoding.readVarUint8Array(peek),
            stale ? MAX_SYNC_STEP2_BYTES : undefined,
          )
          if (!judgement.ok) {
            // Пол комнаты: это не право, а то, что сервер пишет сам.
            return refuse(entry, conn, {
              rule: 'edit',
              message: stale ? STALE_SYNC : floorMessage(judgement.why),
              detail: `${judgement.why} (${judgement.path})`,
              stale,
            })
          }
          /*
           * Конец занятия едет отдельно от правил, хотя ужесточает их же.
           * `getRules` уже отдаёт преподавательские правила, так что отказ
           * состоится и без этого признака; но по одним правилам гейт не
           * отличит закончившуюся пару от комнаты, где тетрадь и так закрыта, а
           * фразы у них разные.
           */
          const verdict = permits(
            judgement.verdicts,
            getRules(entry.sessionId),
            state?.role ?? 'participant',
            isFinished(entry.sessionId),
          )
          if (!verdict.ok) return refuse(entry, conn, verdict)
          /*
           * Запомнить ДО применения: после него читать уже нечего, а без этого
           * Ctrl+Z вернул бы ячейку без вывода — Yjs отменяет удаление копией,
           * и вывод в копии пришлось бы взять у браузера, чего пол не разрешает.
           */
          rememberDeleted(entry.sessionId, entry.doc, judgement.removed)
          accepted = judgement
          // Принятый кадр — единственная мера того, что в комнате правда
          // работают. Только число, раз в минуту: их десятки тысяч.
          tally('frames')
        }
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, conn)
        /*
         * Принятый кадр обязан встать целиком: дыры отказывает гейт. Если
         * подвисло всё же — это ошибка в гейте, и молчать о ней нельзя, но и
         * оставлять мусор в документе тоже: см. dropPending.
         */
        if (accepted && dropPending(entry.sessionId, entry.doc)) {
          console.error(`[collab] accepted frame left pending structs in ${entry.sessionId}`)
          invalidateSnapshot(entry.sessionId)
        }
        if (accepted) {
          const { retyped, created, removed } = accepted
          if (retyped.length > 0 || created.length > 0) {
            entry.doc.transact(() => {
              resetRetyped(entry.doc, retyped)
              settleFresh(entry.sessionId, entry.doc, created)
            }, ORIGIN)
          }
          // После применения: ядру говорят про ячейки, которых в тетради уже нет.
          if (removed.length > 0) removedListener?.(entry.sessionId, removed)
        }
        // A bare message type and nothing after it means there is nothing to say.
        if (encoding.length(encoder) > 1) send(entry, conn, encoding.toUint8Array(encoder))
        break
      }
      case MESSAGE_AWARENESS: {
        const payload = decoding.readVarUint8Array(decoder)
        if (!ownAwareness(entry, conn, payload)) break
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, payload, conn)
        break
      }
    }
  } catch (err) {
    /*
     * Отказ, а не проглатывание.
     *
     * Раньше здесь стояло «одному кривому кадру стоить сокету сообщения, а не
     * семинару» — и это верно ровно до появления проверки: проглотить кадр
     * синхронизации значит навсегда и молча онеметь, потому что клиент считает
     * его доставленным и никогда не повторит. Развалившаяся проверка обязана
     * отказывать, иначе она выполняется после того, как перестала смотреть.
     */
    console.error(`[collab] bad message in ${entry.sessionId}`, err)
    refuse(entry, conn, {
      rule: 'edit',
      message: 'Правку не удалось разобрать — она не отправлена.',
    })
  }
}

/**
 * Слова для отказа по полу комнаты — то есть не по правилу, а по тому, что
 * сервер пишет сам. Человеку незачем знать про пути внутри документа.
 */
function floorMessage(why: string): string {
  return `Эта правка не принята: ${why}.`
}

/**
 * Отдельные слова для отказа кадру ПЕРВОЙ синхронизации.
 *
 * `step2` — это не чья-то правка, а весь кэш вкладки, который браузер
 * предлагает серверу при каждом подключении. Причина отказа тут обычно не в
 * человеке: сервер убили жёстко (OOM, питание) или базу вернули из копии, его
 * снимок отстал на несколько секунд, и в кэше вкладки лежат выводы и состояние
 * ядра, написанные ПРОШЛЫМ сервером. Сказать на это «это поле пишет сервер, а
 * не браузер» значит обвинить человека в чужой беде — а вкладка всё равно
 * пересоберётся, потому что убрать у неё эти структуры протоколу нечем.
 */
const STALE_SYNC =
  'Сервер не знает части того, что осталось в кэше этой вкладки, — она собирается заново.'

/**
 * Force this connection's awareness role back to what the socket was opened
 * with. Cheap: one map lookup per awareness frame, and awareness frames are
 * already the chattiest thing on this wire.
 */
function pinRole(entry: DocEntry, state: ConnState, clientIds: number[]): void {
  if (!state.participantId) return
  for (const clientId of clientIds) {
    const local = entry.awareness.getStates().get(clientId) as
      | { user?: { id?: string; role?: ParticipantRole } }
      | undefined
    const user = local?.user
    if (!user) continue
    if (user.id === state.participantId && user.role === state.role) continue
    entry.awareness.states.set(clientId, {
      ...local,
      user: { ...user, id: state.participantId, role: state.role },
    })
  }
}

export function handleCollabSocket(
  ws: WebSocket,
  sessionId: string,
  role: ParticipantRole = 'participant',
  participantId: string | null = null,
): void {
  const entry = getEntry(sessionId)
  /*
   * Комната открылась — по первому сокету, а не по строке в базе.
   *
   * Семинар заводят заранее и иногда за неделю; пара начинается, когда в
   * комнату кто-то вошёл. Та же строка повторится после перезапуска сервера, и
   * это правильно: с точки зрения журнала комната тогда открывается заново.
   */
  const wasEmpty = entry.conns.size === 0
  entry.emptySince = 0
  ws.binaryType = 'arraybuffer'

  const state: ConnState = {
    role,
    participantId,
    openedAt: Date.now(),
    clientIds: new Set<number>(),
    missedPongs: 0,
    pingTimer: setInterval(() => {
      if (state.missedPongs >= MAX_MISSED_PONGS) {
        closeConn(entry, ws)
        ws.terminate()
        return
      }
      state.missedPongs++
      try {
        ws.ping()
      } catch {
        closeConn(entry, ws)
        ws.terminate()
      }
    }, PING_INTERVAL_MS),
  }
  entry.conns.set(ws, state)
  if (wasEmpty) console.log(`[room ${sessionId}] opened`)

  ws.on('pong', () => {
    state.missedPongs = 0
  })
  ws.on('message', (data: RawData) => handleMessage(entry, ws, toUint8Array(data)))
  ws.on('close', () => closeConn(entry, ws))
  ws.on('error', () => closeConn(entry, ws))

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, entry.doc)
  send(entry, ws, encoding.toUint8Array(encoder))

  const states = entry.awareness.getStates()
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(entry.awareness, Array.from(states.keys())),
    )
    send(entry, ws, encoding.toUint8Array(awarenessEncoder))
  }
}

/** Open sockets, not distinct people — a second tab counts twice. */
export function onlineCount(sessionId: string): number {
  return docs.get(sessionId)?.conns.size ?? 0
}

/**
 * С какого момента в комнате кто-то есть — или null, если сейчас никого.
 *
 * Самый старый из открытых сокетов, а не первый за всю историю комнаты:
 * занятие, которое идёт, — это те, кто в ней сейчас. Комната, опустевшая и
 * наполнившаяся снова, начинает часы заново, и это правда о ней: перерыв между
 * парами ничем другим от конца занятия не отличается.
 *
 * Перезапуск сервера обнуляет эти часы вместе с сокетами — ровно как обнуляет
 * журнальное «[room …] opened», и по той же причине.
 */
export function liveSince(sessionId: string): number | null {
  const entry = docs.get(sessionId)
  if (!entry || entry.conns.size === 0) return null
  let oldest = Infinity
  for (const state of entry.conns.values()) oldest = Math.min(oldest, state.openedAt)
  return Number.isFinite(oldest) ? oldest : null
}

/**
 * Сколько комнат сейчас живо и сколько в них людей — для минутной сводки.
 *
 * Живая комната — та, в которой есть хоть один сокет: документ переживает уход
 * последнего (его ещё дописывают на диск), а пара нет, и считать такую комнату
 * идущей значило бы врать в каждой строке до перезапуска. Люди считаются по
 * участникам, а не по сокетам, — то же число, что комната видит у себя в
 * панели людей.
 */
export function roomCensus(): { rooms: number; people: number } {
  let rooms = 0
  let people = 0
  for (const [sessionId, entry] of docs) {
    if (entry.conns.size === 0) continue
    rooms += 1
    people += onlineParticipantIds(sessionId).length
  }
  return { rooms, people }
}

/**
 * The participant ids actually present right now, deduplicated.
 *
 * Not the same as onlineCount, which counts sockets: one person with the
 * seminar open in two tabs is two connections and one participant. And not the
 * same as the participants table either, which is every name that ever joined —
 * the join screen said "148 people are already inside" about a room holding one,
 * because that table never forgets.
 */
export function onlineParticipantIds(sessionId: string): string[] {
  const entry = docs.get(sessionId)
  if (!entry) return []
  const ids = new Set<string>()
  for (const state of entry.awareness.getStates().values()) {
    /*
     * Typed against the shared contract on purpose. This read used to be a
     * hand-written `{ user?: { participantId?: unknown } }`, and the field the
     * browser actually publishes is `id` — so every real page was invisible
     * here and the room's online list came back empty for everybody, while the
     * test client, which happened to send `participantId`, showed thirty. An
     * inline cast asserts what you meant; the shared type is what is true.
     *
     * One person can hold several of these — two tabs, or a reconnect whose old
     * socket has not timed out — so the set is by participant, not by socket.
     */
    const user = (state as { user?: Partial<AwarenessUser> } | undefined)?.user
    if (typeof user?.id === 'string' && user.id) ids.add(user.id)
  }
  return Array.from(ids)
}

/**
 * Убрать из документа комнаты одного человека, не трогая комнату.
 *
 * Сосед `dropSessionDoc` сносит документ целиком, потому что сносят семинар.
 * Здесь всё наоборот: пара идёт дальше, и уйти должен ровно тот, кого забанили,
 * — остальные девятнадцать не должны заметить ничего.
 *
 * Через тот же `closeConn`, что и обычный уход: он снимает присутствие, и
 * курсор ушедшего исчезает у всех сразу, а не висит в чужой ячейке до
 * тайм-аута. Вернуться этот сокет не сможет — рукопожатие спрашивает бан до
 * апгрейда; чистый браузер по-прежнему сможет, и это сказано вслух везде, где
 * про бан вообще говорится.
 */
export function dropParticipant(sessionId: string, participantId: string): void {
  const entry = docs.get(sessionId)
  if (!entry) return
  // Копия: closeConn правит ту же карту, по которой идёт обход.
  for (const [conn, state] of [...entry.conns]) {
    if (state.participantId !== participantId) continue
    closeConn(entry, conn)
  }
}

/* ------------------------------------------------- выселение простаивающих */

/**
 * Сколько пустая комната ещё живёт в памяти.
 *
 * Десять минут — это «преподаватель закрыл вкладку, чтобы открыть её с другого
 * ноутбука», а не «пара кончилась». Меньше — и переменка стоила бы всем
 * повторной сборки документа из снимка; больше — и семестровый инстанс копит
 * комнаты быстрее, чем их отпускает.
 *
 * Держит комната не только `Y.Doc` (полный CRDT вместе с набором удалений — у
 * долгой комнаты это сотни килобайт и только растёт), но и базовую точку
 * истории (ВТОРАЯ полная копия документа), тексты всех ячеек, лица присутствия
 * и привязку к снимку. На тетради с картинками это десяток мегабайт на
 * брошенную комнату, а освобождалось это раньше только удалением семинара или
 * перезапуском сервера: университетский инстанс за семестр накапливал сотни
 * таких — до OOM, который роняет ВСЕ комнаты разом.
 *
 * Вернуться в выселенную комнату можно как всегда: она поднимется из снимка,
 * ровно так же, как после перезапуска сервера.
 */
const IDLE_ROOM_MS = 10 * 60 * 1000

/**
 * А столько — при любых обстоятельствах.
 *
 * Обычное выселение ждёт, пока в комнате ничего не делается: ядро может считать
 * ячейку, когда все закрыли ноутбуки, и снести из-под неё документ значило бы
 * выбросить результат, за которым хозяин вернётся. Но признак «делается»
 * читается из самого документа, а он способен застрять: ответ оракула, чей
 * процесс убили посреди потока, остаётся `streaming` навсегда — и одна такая
 * запись держала бы комнату в памяти до перезапуска, то есть ровно ту утечку,
 * ради которой выселение и написано.
 *
 * Три часа — заведомо позже, чем ядро само сносит контейнер простаивающей
 * комнаты (два часа, kernel/index.ts · IDLE_KERNEL_MS): писать в документ к
 * этому времени уже некому.
 */
const MAX_IDLE_ROOM_MS = 3 * 60 * 60 * 1000

/** Как часто смотрим. Обход карты комнат стоит меньше, чем один кадр правки. */
const ROOM_SWEEP_MS = 60 * 1000

/** Комнаты, которые кто-то держит в памяти намеренно, и сколько держателей. */
const holds = new Map<string, number>()

/**
 * Не выселять эту комнату, пока держат.
 *
 * Для того, кто взял `Y.Doc` в руки и работает с ним дольше одного вызова:
 * выселение уничтожает документ, и запись в уничтоженный не видит никто —
 * молча. Всё, что берёт документ через `getSessionDoc` на каждое обращение,
 * держать ничего не должно: такая запись поднимет комнату заново.
 *
 * Возвращает «отпустить». Вызывать его дважды безопасно.
 */
export function holdRoom(sessionId: string): () => void {
  holds.set(sessionId, (holds.get(sessionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (holds.get(sessionId) ?? 1) - 1
    if (left > 0) holds.set(sessionId, left)
    else holds.delete(sessionId)
  }
}

/**
 * Делается ли в комнате что-то, чему нужен ЭТОТ документ.
 *
 * Спрашивается у самого документа, а не у ядра: импортировать ядро отсюда
 * значило бы замкнуть модули друг на друга (ядро берёт документ здесь). Всё,
 * что перечислено, ядро в документ и пишет — по этим же полям комната рисует,
 * что она занята.
 */
function atWork(doc: Y.Doc): boolean {
  const meta = getMeta(doc)
  if (meta.get('runningCell') != null) return true
  const status = meta.get('kernelStatus')
  if (status === 'busy' || status === 'restarting') return true
  const queue = meta.get('queue')
  if (queue instanceof Y.Array && queue.length > 0) return true
  // Идущий ответ оракула пишется в ленту чата теми же тактами.
  return getChat(doc)
    .toArray()
    .some((turn) => turn.get('state') === 'streaming')
}

/**
 * Отпустить пустые комнаты. Возвращает, кого выселили, — этим же зовут тесты.
 */
export function sweepIdleRooms(now: number = Date.now()): string[] {
  const gone: string[] = []
  for (const entry of [...docs.values()]) {
    if (entry.conns.size > 0 || entry.emptySince === 0) continue
    const empty = now - entry.emptySince
    if (empty < IDLE_ROOM_MS) continue
    if (empty < MAX_IDLE_ROOM_MS && (holds.has(entry.sessionId) || atWork(entry.doc))) continue
    evictRoom(entry)
    gone.push(entry.sessionId)
  }
  return gone
}

/**
 * Убрать комнату из памяти, не потеряв ничего из написанного.
 *
 * Порядок здесь — весь смысл: сперва дописывается открытая строка истории
 * (это чья-то работа), потом снимок документа на диск, и только после этого
 * документ уничтожается вместе со своими наблюдателями и присутствием.
 */
function evictRoom(entry: DocEntry): void {
  docs.delete(entry.sessionId)
  forgetHistory(entry.sessionId)
  entry.dispose()
  // И то, что сервер помнил об удалённых в ней ячейках ради Ctrl+Z: отменять
  // спустя десять минут пустой комнаты уже некому.
  forgetSession(entry.sessionId)
  // И то, что оракул помнил ради отмены: возвращать спустя десять минут пустой
  // комнаты уже некому.
  forgetUndo(entry.sessionId)
  entry.doc.destroy()
  console.log(`[room ${entry.sessionId}] released from memory`)
}

/*
 * `unref`: уборка не должна держать процесс живым — этот модуль импортируют и
 * тесты, и одноразовые скрипты.
 */
setInterval(() => sweepIdleRooms(), ROOM_SWEEP_MS).unref?.()

/**
 * Отпустить документ комнаты, ничего в ней не закрывая.
 *
 * Тот же выход, что у уборки простаивающих, только по требованию: им уходит
 * гость тетради (routes/doc-visit.ts), поднявший документ пустой комнаты ради
 * одной строки — переименования в панели, чтения ленты, публикации. Ждать за
 * такую тетрадь десять минут пустоты незачем: она не была ничьей ни секунды.
 *
 * `dropSessionDoc` для этого шире, чем нужно: он написан для снесённого
 * семинара и закрывает его сокеты и файлы. Файловые сокеты живут в своей карте
 * (collab/files.ts) и документ комнаты не поднимают, так что открытый в
 * редакторе `.py` переживает и уборку простаивающих, и визит, — а `forgetFiles`
 * хлопнул бы ему кодом 1001 «комната закрыта» посреди живого семинара.
 *
 * Комнату, в которой кто-то сидит, не выселяет: её документ держат сокеты, и
 * для них это тот же снос. Возвращает, отпустил ли: `false` — либо документа в
 * памяти не было, либо в комнате есть люди.
 */
export function releaseSessionDoc(sessionId: string): boolean {
  const entry = docs.get(sessionId)
  if (!entry || entry.conns.size > 0) return false
  evictRoom(entry)
  return true
}

/**
 * Evict a session's document for good: used when the seminar itself is deleted.
 *
 * Everything here is about making the deletion stick. The binding is discarded
 * rather than disposed, because disposing flushes and the flush would write a
 * snapshot row back for a room that has just been removed; the sockets are
 * closed so a browser still standing in the room cannot keep editing a document
 * nobody will ever load again; and the doc is destroyed so its observers go with
 * it. Called before the rows are dropped, so nothing can write between the two.
 *
 * Letting go of a room nobody is in is a different door: `releaseSessionDoc`
 * above, which closes nothing. So every step added here may assume the seminar
 * is going away — that assumption is what the two doors buy.
 */
export function dropSessionDoc(sessionId: string): void {
  // Открытые файлы этой комнаты — тоже её: их надо дописать и закрыть до того,
  // как исчезнет папка, иначе последнее сохранение создаст её заново.
  forgetFiles(sessionId)
  // И то, что оракул помнил о ней ради отмены: возвращать больше некуда.
  forgetUndo(sessionId)
  // И идущие ответы оракула: писать их больше некуда, а сам поток заметил бы
  // это только на ближайшем кадре — незачем платить за ответ снесённой комнате.
  abortSession(sessionId)
  const entry = docs.get(sessionId)
  if (!entry) return
  docs.delete(sessionId)
  // Наблюдатель тетрадей — тоже привязка к этому документу, и его таймер
  // проекции пережил бы удаление: `dispose` здесь не годится, он дописывает
  // снимок комнаты, которой больше нет.
  entry.unwatch()
  discardPersistence(sessionId)
  // The room is gone; an open burst describing it would be a version of nothing.
  discardBurst(sessionId)
  // И то, что сервер помнил об удалённых в ней ячейках: возвращать некуда.
  forgetSession(sessionId)
  for (const conn of Array.from(entry.conns.keys())) {
    const state = entry.conns.get(conn)
    if (state) clearInterval(state.pingTimer)
    entry.conns.delete(conn)
    try {
      conn.close(1001, 'this seminar was deleted')
    } catch {
      /* already gone */
    }
  }
  entry.doc.destroy()
}

export function shutdownCollab(): void {
  for (const entry of docs.values()) {
    for (const conn of Array.from(entry.conns.keys())) {
      const state = entry.conns.get(conn)
      if (state) clearInterval(state.pingTimer)
      entry.conns.delete(conn)
      try {
        conn.close(1001, 'server shutting down')
      } catch {
        /* already gone */
      }
    }
    entry.dispose()
  }
  docs.clear()
  flushAllPersistence()
  // То же и для файлов: набранное за последние полсекунды — это работа, а
  // остановка процесса — не повод её терять.
  flushAllFiles()
  // Whatever somebody was typing when the process was told to stop is still a
  // thing they did, and the seminar may be reopened tomorrow.
  flushAllHistory()
}
