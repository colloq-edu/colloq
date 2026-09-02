/**
 * Один открытый файл — один документ Yjs, привязанный к байтам на диске.
 *
 * Тетрадь живёт в документе комнаты и в снимке в базе. Файлы — нет: у файла уже
 * есть каноническое место хранения, и это сам файл. Ядро читает его тем же
 * `open()`, скрипт запускается из него же, загрузка кладёт его туда же. Поэтому
 * документ здесь не хранилище, а способ печатать вдвоём: он заводится из диска
 * при первом открытии, пишется на диск с задержкой и исчезает, когда последняя
 * вкладка закрылась.
 *
 * Три решения, каждое из которых стоило бы дорого, будь оно принято иначе.
 *
 * **Отдельный документ на файл, а не раздел в документе комнаты.** Комнатный
 * документ целиком лежит в снимке, целиком разворачивается в истории версий и
 * целиком кешируется в браузере через y-indexeddb. Папка семинара на сотню
 * файлов сделала бы каждую из этих трёх вещей в сто раз тяжелее — ради текста,
 * который и так есть на диске.
 *
 * **Диск — источник правды между сессиями, документ — во время сессии.** Пока
 * файл открыт, правда в документе: он видит всех печатающих сразу. Когда открыт
 * не у кого — правда на диске. Стык между двумя состояниями и есть то, что
 * здесь написано.
 *
 * **Изменение с той стороны применяется склейкой, а не переписыванием.** Ячейка
 * пишет `results.csv`, оракул правит скрипт, `git checkout` в терминале меняет
 * половину папки — и всё это происходит с файлом, в котором стоит чей-то
 * курсор. Заменить текст целиком значит убить курсор и отменяемость; поэтому
 * меняется только то, что отличается, — общая голова и общий хвост остаются
 * теми же самыми символами Yjs.
 */
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { Awareness } from 'y-protocols/awareness'
import { WebSocket, type RawData } from 'ws'
import type { ParticipantRole } from '@shared/protocol'
import { actsAfterClass, allows, CLASS_IS_OVER } from '@shared/rules'
import { isInside } from '@shared/paths'
import { getRules, isFinished } from '../db.js'
import { MAX_TEXT_BYTES, readText, statPath, writeText } from '../workspace.js'
import { ownAwareness } from './index.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

/** Ключ текста внутри документа файла. Он там один. */
export const TEXT_KEY = 'text'

/** Происхождение записи, пришедшей с диска: по нему сохранение узнаёт себя. */
const DISK = 'disk'
/** Происхождение записи, сделанной сервером от чьего-то имени (оракул). */
const SERVER = 'server'

/**
 * Сколько ждать после последнего нажатия, прежде чем писать на диск.
 *
 * Семьсот миллисекунд — это пауза между словами, а не между сессиями: файл,
 * который правят, оказывается на диске раньше, чем человек успеет переключиться
 * в терминал и запустить его. Меньше — и каждый десятый символ становится
 * записью на диск в контейнере, который в этот момент считает.
 */
const SAVE_AFTER_MS = 700

/**
 * Как часто смотреть, не поменял ли файл кто-то мимо нас.
 *
 * Опрос, а не `fs.watch`: рекурсивное слежение ведёт себя по-разному на трёх
 * платформах, а смотреть надо за десятком открытых файлов, а не за деревом.
 * Две секунды — это задержка, с которой в редакторе появится строка, дописанная
 * ячейкой; для файла, который правят руками, этого не видно вовсе.
 */
const WATCH_EVERY_MS = 2_000

/** Сколько документ живёт после ухода последнего. Перезагрузка страницы — не закрытие. */
const LINGER_MS = 5_000

const PING_INTERVAL_MS = 25_000
const MAX_MISSED_PONGS = 2

/**
 * «Файл больше потолка» — отдельный код закрытия.
 *
 * 4404 клиент читает как «файла нет» и закрывает вкладку молча: нажатие по
 * трёхмегабайтному CSV выглядело вкладкой, которая мигнула и исчезла, ничего не
 * сказав. По этому коду вкладка остаётся и говорит правду — файл есть, править
 * его в редакторе нельзя, скачать и прочитать из ячейки можно.
 */
const TOO_BIG = 4413

interface ConnState {
  participantId: string | null
  clientIds: Set<number>
  missedPongs: number
  pingTimer: NodeJS.Timeout
  role: ParticipantRole
}

interface FileDoc {
  key: string
  sessionId: string
  path: string
  doc: Y.Doc
  awareness: Awareness
  conns: Map<WebSocket, ConnState>
  /** Текст, который, по нашему мнению, сейчас на диске. */
  onDisk: string
  /** Отпечаток диска, по которому узнаётся чужая запись. */
  stamp: string
  saveTimer: NodeJS.Timeout | null
  watchTimer: NodeJS.Timeout | null
  lingerTimer: NodeJS.Timeout | null
  /**
   * Запись похоронена: файла не стало, он уехал мимо дерева или перестал быть
   * правимым текстом. Писать больше некуда, и оживлять её нельзя — следующее
   * открытие заводит документ с диска заново.
   */
  gone: boolean
}

const open = new Map<string, FileDoc>()

function keyOf(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`
}

function stampOf(sessionId: string, path: string): string {
  const stat = statPath(sessionId, path)
  return stat ? `${stat.modifiedAt}:${stat.size}` : ''
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Заменить текст документа так, чтобы уцелело всё, что не менялось.
 *
 * Общая голова и общий хвост считаются посимвольно и остаются на месте; между
 * ними — одно удаление и одна вставка. Полноценный diff по строкам здесь не
 * годится: он квадратичный, а файл может быть на тридцать тысяч строк, и
 * пересчитывать его каждые две секунды на каждый открытый файл — это работа
 * ровно там, где её никто не просил. Курсор внутри изменившегося куска съедет к
 * его краю: так же ведёт себя любой редактор, которому файл поменяли снаружи.
 */
export function spliceText(text: Y.Text, next: string): boolean {
  const now = text.toString()
  if (now === next) return false
  let head = 0
  const max = Math.min(now.length, next.length)
  while (head < max && now[head] === next[head]) head++
  let tail = 0
  while (tail < max - head && now[now.length - 1 - tail] === next[next.length - 1 - tail]) tail++
  /*
   * Граница не имеет права встать посреди суррогатной пары. У соседних эмодзи
   * старшая половина общая, и голова останавливается ровно между половинками:
   * Yjs подменяет разорванную на U+FFFD, lib0 при передаче кодирует одиночный
   * суррогат ещё одним — и документ сервера расходится с документами браузеров
   * до конца сессии, а порча уходит на диск. Границы отодвигаются наружу,
   * и счёт становится посимвольным, каким он выше и объявлен.
   */
  if (head > 0 && isHighSurrogate(now.charCodeAt(head - 1))) head -= 1
  if (tail > 0 && isLowSurrogate(now.charCodeAt(now.length - tail))) tail -= 1
  const removed = now.length - head - tail
  const added = next.slice(head, next.length - tail)
  if (removed > 0) text.delete(head, removed)
  if (added.length > 0) text.insert(head, added)
  return true
}

/**
 * Открыть документ файла, заведя его из диска, если он ещё не открыт.
 *
 * `null` — файла нет, он не текст или он слишком большой. Для документа все три
 * случая означают одно: править нечего, и сокет открывать незачем. Для человека
 * — нет, поэтому `handleFileSocket` различает последний отдельным кодом.
 */
export function getFileDoc(sessionId: string, path: string): FileDoc | null {
  const existing = open.get(keyOf(sessionId, path))
  if (existing && !existing.gone) {
    if (existing.lingerTimer) {
      clearTimeout(existing.lingerTimer)
      existing.lingerTimer = null
    }
    return existing
  }

  const read = readText(sessionId, path)
  if (!read || read.binary || read.truncated) return null

  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  doc.getText(TEXT_KEY).insert(0, read.text)

  const entry: FileDoc = {
    key: keyOf(sessionId, path),
    sessionId,
    path,
    doc,
    awareness,
    conns: new Map(),
    onDisk: read.text,
    stamp: `${read.modifiedAt}:${read.size}`,
    saveTimer: null,
    watchTimer: null,
    lingerTimer: null,
    gone: false,
  }
  open.set(entry.key, entry)

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    broadcastUpdate(entry, update, origin)
    // Запись с диска не возвращается на диск: это её же байты, и второй заход
    // отличался бы от первого только временем изменения — которого хватило бы,
    // чтобы наблюдатель счёл его чужой правкой и пошёл на третий круг.
    if (origin === DISK) return
    scheduleSave(entry)
  })

  awareness.on(
    'update',
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const state = origin instanceof WebSocket ? entry.conns.get(origin) : undefined
      if (state) {
        for (const id of changes.added) state.clientIds.add(id)
        for (const id of changes.removed) state.clientIds.delete(id)
      }
      broadcastAwareness(entry, changes.added.concat(changes.updated, changes.removed))
    },
  )

  entry.watchTimer = setInterval(() => watchDisk(entry), WATCH_EVERY_MS)
  entry.watchTimer.unref?.()
  return entry
}

/** Открыт ли этот файл прямо сейчас — и его документ, если да. */
export function openFileDoc(sessionId: string, path: string): FileDoc | null {
  const entry = open.get(keyOf(sessionId, path))
  return entry && !entry.gone ? entry : null
}

/**
 * Записать файл от имени сервера — так, чтобы открытые редакторы увидели это
 * как правку, а не как подмену.
 *
 * Единственный путь записи для всего, что не браузер: оракул в режиме
 * «сделать», восстановление после отмены хода. Если файл открыт — правка идёт в
 * документ и оттуда на диск обычным сохранением; если нет — прямо на диск.
 * Двух путей быть не должно: они разошлись бы ровно в тот момент, когда
 * кто-нибудь смотрит на файл.
 *
 * «Сохранить сейчас, не меняя текста» — не сюда, для этого есть `flushFile`. До
 * него запуск файла и переименование ходили этой дверью: брали текст документа
 * и клали его в тот же документ, только чтобы дойти до записи на диск.
 */
export function putText(sessionId: string, path: string, text: string): boolean {
  /*
   * Потолок — до всего остального и одинаково для обоих путей. Открытому файлу
   * по нему откажет сохранение, и в документе остался бы текст, которого
   * никогда не будет на диске, а в ответе «готово»; закрытому не откажет никто,
   * и на диске завёлся бы файл, который потом не открыть ни редактором, ни
   * следующим шагом того же оракула.
   */
  if (text.length > MAX_TEXT_BYTES) return false
  const entry = openFileDoc(sessionId, path)
  if (!entry) {
    /*
     * Файл крупнее потолка целиком не читал никто: и оракул, и отмена хода
     * собирают текст из его начала. Положить такой текст на место файла значит
     * молча срезать хвост — три мегабайта метрик становятся полутора, а
     * следующая ячейка честно считает по половине набора.
     */
    const at = statPath(sessionId, path)
    if (at && !at.dir && at.size > MAX_TEXT_BYTES) return false
    return writeText(sessionId, path, text)
  }
  entry.doc.transact(() => spliceText(entry.doc.getText(TEXT_KEY), text), SERVER)
  return saveNow(entry)
}

/**
 * Текст файла — из документа, если он открыт, иначе с диска.
 *
 * `null` и для файла крупнее потолка: с диска он читается началом, и отдать
 * это начало как «текст файла» значит дать записать его обратно вместо целого.
 */
export function currentText(sessionId: string, path: string): string | null {
  const entry = openFileDoc(sessionId, path)
  if (entry) return entry.doc.getText(TEXT_KEY).toString()
  const read = readText(sessionId, path)
  if (!read || read.binary || read.truncated) return null
  return read.text
}

function scheduleSave(entry: FileDoc): void {
  if (entry.saveTimer) return
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null
    saveNow(entry)
  }, SAVE_AFTER_MS)
  entry.saveTimer.unref?.()
}

/** Записать документ на диск. `false` — не записали, и файл остался прежним. */
function saveNow(entry: FileDoc): boolean {
  if (entry.saveTimer) {
    clearTimeout(entry.saveTimer)
    entry.saveTimer = null
  }
  if (entry.gone) return false
  const text = entry.doc.getText(TEXT_KEY).toString()
  if (text === entry.onDisk) return true
  /*
   * Потолок проверяется здесь, а не только при открытии: файл открылся
   * маленьким, а стал большим — вставили мегабайт из буфера. Раньше отказ был
   * молчаливым, и это было худшее место в модуле: правка не сохранялась
   * никогда, а редактор показывал её как ни в чём не бывало и отдавал `true`
   * оракулу. Теперь вкладки узнают тем же 4403, что и о непринятой правке, —
   * «дальше только чтение» здесь буквальная правда, и набранное остаётся на
   * экране, откуда его можно забрать.
   */
  if (text.length > MAX_TEXT_BYTES) {
    entry.gone = true
    closeAll(entry, 4403, 'Файл больше потолка — дальше только чтение.')
    dispose(entry)
    return false
  }
  /*
   * Файл мог уехать мимо дерева: `mv` в терминале, `os.rename` в ячейке.
   * Наблюдатель заметит это не раньше двух секунд, а отложенное сохранение
   * успевает первым — и `writeText` заводит файл заново по старому пути, то
   * есть молча отменяет чужое переименование и разводит в комнате две копии.
   */
  const at = statPath(entry.sessionId, entry.path)
  if (!at || at.dir) {
    entry.gone = true
    closeAll(entry, 4404, 'файла больше нет')
    dispose(entry)
    return false
  }
  if (!writeText(entry.sessionId, entry.path, text)) return false
  entry.onDisk = text
  entry.stamp = stampOf(entry.sessionId, entry.path)
  fileSaved?.(entry.sessionId, entry.path)
  return true
}

let fileSaved: ((sessionId: string, path: string) => void) | null = null

/**
 * Кому сообщать, что файл лёг на диск. Регистрирует control.ts: комната узнаёт
 * новый размер и время, а импортировать его отсюда значило бы замкнуть цикл.
 */
export function onFileSaved(listener: (sessionId: string, path: string) => void): void {
  fileSaved = listener
}

function watchDisk(entry: FileDoc): void {
  if (entry.gone) return
  // Пока сохранение в очереди, диск заведомо отстаёт от документа: смотреть на
  // него сейчас значит принять свой же вчерашний текст за чужую правку.
  if (entry.saveTimer) return
  const stamp = stampOf(entry.sessionId, entry.path)
  if (stamp === entry.stamp) return
  if (stamp === '') {
    // Файл убрали. Комната узнает об этом из списка файлов; здесь важно
    // перестать писать — иначе следующее сохранение воскресит его.
    entry.gone = true
    closeAll(entry, 4404, 'файла больше нет')
    dispose(entry)
    return
  }
  const read = readText(entry.sessionId, entry.path)
  if (!read || read.binary || read.truncated) {
    /*
     * Файл перестал быть тем, что можно править: перерос потолок (ядро пишет
     * в него лог), стал двоичным (сверху лёг pickle) или не читается вовсе.
     * Раньше здесь был тихий выход, и документ навсегда оставался с текстом на
     * момент открытия — первое же нажатие клало этот короткий старый текст
     * поверх выросшего файла. У файлов нет ни снимка, ни истории версий, так
     * что дописанное ядром возвращать было бы нечем.
     *
     * Переросшему потолок — свой код: файл на месте, и вкладке есть что сказать
     * человеку, кроме молчаливого исчезновения.
     */
    entry.gone = true
    if (read?.truncated) closeAll(entry, TOO_BIG, 'файл больше потолка')
    else closeAll(entry, 4404, 'файл больше не открывается')
    dispose(entry)
    return
  }
  entry.stamp = stamp
  if (read.text === entry.onDisk) return
  entry.onDisk = read.text
  entry.doc.transact(() => spliceText(entry.doc.getText(TEXT_KEY), read.text), DISK)
}

function dispose(entry: FileDoc): void {
  /*
   * Только своя запись. Под этим ключом может лежать уже ДРУГАЯ — файл
   * вернулся и его открыли, пока эта доживала свои пять секунд, — или эту уже
   * хоронили. Удалить чужую значит оставить комнату с двумя документами на
   * один файл: две вкладки печатают в разные копии и по очереди пишут друг
   * поверх друга.
   */
  if (open.get(entry.key) !== entry) return
  open.delete(entry.key)
  if (entry.watchTimer) clearInterval(entry.watchTimer)
  if (entry.saveTimer) clearTimeout(entry.saveTimer)
  if (entry.lingerTimer) clearTimeout(entry.lingerTimer)
  entry.watchTimer = null
  entry.saveTimer = null
  entry.lingerTimer = null
  entry.doc.destroy()
}

/**
 * Закрыть все сокеты записи — и забыть их здесь же, не дожидаясь события
 * `close`.
 *
 * Событие приходит следующим тиком, и до него запись жила бы с полным списком
 * соединений: закрытие последнего из них заводило бы отложенную смерть уже
 * похороненной записи, а та через пять секунд выкидывала из карты НОВЫЙ
 * документ того же файла. Каждый, кто зовёт это, следом зовёт `dispose`, так
 * что присутствие уходит вместе с документом.
 */
function closeAll(entry: FileDoc, code: number, reason: string): void {
  for (const [conn, state] of [...entry.conns]) {
    entry.conns.delete(conn)
    clearInterval(state.pingTimer)
    try {
      conn.close(code, reason)
    } catch {
      /* уже закрыт */
    }
  }
}

/* --------------------------------------------------------------- сокет */

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data)
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
  }
  const buf = data as Buffer
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function send(entry: FileDoc, conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
    closeConn(entry, conn)
    return
  }
  try {
    conn.send(message, (err) => {
      if (err) closeConn(entry, conn)
    })
  } catch {
    closeConn(entry, conn)
  }
}

function broadcastUpdate(entry: FileDoc, update: Uint8Array, origin: unknown): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)
  for (const conn of entry.conns.keys()) {
    if (conn === origin) continue
    send(entry, conn, message)
  }
}

function broadcastAwareness(entry: FileDoc, clients: number[]): void {
  if (clients.length === 0) return
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(entry.awareness, clients),
  )
  const message = encoding.toUint8Array(encoder)
  for (const conn of entry.conns.keys()) send(entry, conn, message)
}

function closeConn(entry: FileDoc, conn: WebSocket): void {
  const state = entry.conns.get(conn)
  if (!state) return
  entry.conns.delete(conn)
  clearInterval(state.pingTimer)
  awarenessProtocol.removeAwarenessStates(entry.awareness, [...state.clientIds], null)
  try {
    conn.close()
  } catch {
    /* уже закрыт */
  }
  if (entry.conns.size > 0) return
  /*
   * Последний ушёл. Сохранить немедленно — перезагрузка страницы не должна
   * стоить последних набранных секунд, — а документ подержать ещё немного: та
   * же перезагрузка вернётся через долю секунды, и пересобирать документ с
   * нуля значило бы терять отменяемость на ровном месте.
   */
  saveNow(entry)
  // Записи могло уже не стать: сохранение обнаружило, что файла на диске нет.
  // Ставить ей отложенную смерть значит через пять секунд убрать из карты
  // документ, заведённый взамен, — и получить два документа на один файл.
  if (entry.gone) return
  entry.lingerTimer = setTimeout(() => {
    if (entry.conns.size === 0) dispose(entry)
  }, LINGER_MS)
  entry.lingerTimer.unref?.()
}

/**
 * Отказать соединению в кадре.
 *
 * Закрытием, как и в документе комнаты, и по той же причине: ничто в протоколе
 * синхронизации не умеет убрать у клиента структуру, которая у него уже есть.
 * Клиент, получивший 4403, пересобирает документ и показывает, что правка не
 * прошла.
 *
 * Причина — словами. У файлового сокета нет управляющего канала, по которому
 * комнатный гейт досылает фразу отказа (`collab/index.ts · onRefusal`), и
 * единственное место, где сюда помещается объяснение, — поле `reason` кадра
 * закрытия. Оно ограничено 123 байтами: фраза, которая в них не влезет,
 * `ws` не отправит, а бросит.
 */
function refuse(entry: FileDoc, conn: WebSocket, why: string): void {
  try {
    conn.close(4403, why)
  } catch {
    /* уже закрыт */
  }
  closeConn(entry, conn)
}

/**
 * Несёт ли кадр правку.
 *
 * y-websocket отвечает на серверный шаг 1 всегда — в том числе пустым кадром,
 * в котором нет ни одной структуры. Отказывать по подтипу значит рвать
 * рукопожатие каждому, кому файлы править нельзя: он ещё ничего не написал, а
 * ему уже «правку не приняли» и навсегда замерший файл. Комнатный сокет
 * разбирает содержимое ровно по этой причине.
 */
function carriesEdit(payload: Uint8Array): boolean {
  try {
    const update = Y.decodeUpdate(payload)
    if (update.structs.length > 0) return true
    for (const ranges of update.ds.clients.values()) if (ranges.length > 0) return true
    return false
  } catch {
    // Кадр не разбирается — считаем его правкой: пропустить непрочитанное
    // значит применить его после того, как проверка перестала смотреть.
    return true
  }
}

function handleMessage(entry: FileDoc, conn: WebSocket, data: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(data)
    const encoder = encoding.createEncoder()
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        const peek = decoding.clone(decoder)
        const subtype = decoding.readVarUint(peek)
        if (subtype === SYNC_STEP2 || subtype === SYNC_UPDATE) {
          const state = entry.conns.get(conn)
          const role = state?.role ?? 'participant'
          /*
           * Право читается сейчас, а не при открытии сокета: правила комнаты
           * меняются посреди пары, и сокет, открытый до ужесточения, жил бы по
           * старым правилам до самого переподключения.
           */
          if (
            !allows(getRules(entry.sessionId).files, role) &&
            carriesEdit(decoding.readVarUint8Array(peek))
          ) {
            /*
             * Слова — те же, которыми гаснет кнопка в панели файлов
             * (`web/src/lib/may.ts · filesWhy`): правило одно, значит и
             * объяснение одно. После конца занятия правило неотличимо от
             * «файлы преподавательские», а причина другая, и сказать надо её.
             */
            return refuse(
              entry,
              conn,
              actsAfterClass(isFinished(entry.sessionId), role)
                ? 'Файлы в этой комнате — преподавательские'
                : CLASS_IS_OVER,
            )
          }
        }
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, conn)
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
    console.error(`[files] bad message in ${entry.sessionId}:${entry.path}`, err)
    refuse(entry, conn, 'Правку не удалось разобрать — она не отправлена.')
  }
}

export function handleFileSocket(
  ws: WebSocket,
  sessionId: string,
  path: string,
  role: ParticipantRole,
  participantId: string | null,
): void {
  const entry = getFileDoc(sessionId, path)
  if (!entry) {
    /*
     * Почему не открылся — разные ответы. Файла нет (или он не текст) — вкладку
     * надо закрыть; файл больше потолка — сказать, что он есть, и не закрывать
     * ничего. Мерка та же, что у `readText`, и стоит она одного `lstat`: читать
     * полтора мегабайта второй раз ради кода закрытия незачем.
     */
    const at = statPath(sessionId, path)
    const tooBig = at !== null && !at.dir && at.size > MAX_TEXT_BYTES
    try {
      if (tooBig) ws.close(TOO_BIG, 'файл больше потолка')
      else ws.close(4404, 'файл не открывается')
    } catch {
      /* уже закрыт */
    }
    return
  }

  ws.binaryType = 'arraybuffer'
  const state: ConnState = {
    participantId,
    clientIds: new Set(),
    missedPongs: 0,
    pingTimer: setInterval(() => {
      const here = entry.conns.get(ws)
      if (!here) return
      if (here.missedPongs >= MAX_MISSED_PONGS) return closeConn(entry, ws)
      here.missedPongs += 1
      try {
        ws.ping()
      } catch {
        closeConn(entry, ws)
      }
    }, PING_INTERVAL_MS),
    role,
  }
  state.pingTimer.unref?.()
  entry.conns.set(ws, state)

  ws.on('pong', () => {
    const here = entry.conns.get(ws)
    if (here) here.missedPongs = 0
  })
  ws.on('message', (data: RawData) => handleMessage(entry, ws, toUint8Array(data)))
  ws.on('close', () => closeConn(entry, ws))
  ws.on('error', () => closeConn(entry, ws))

  // Шаг 1 синхронизации — от сервера, как и в документе комнаты.
  const sync = encoding.createEncoder()
  encoding.writeVarUint(sync, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(sync, entry.doc)
  send(entry, ws, encoding.toUint8Array(sync))

  const states = entry.awareness.getStates()
  if (states.size > 0) {
    const hello = encoding.createEncoder()
    encoding.writeVarUint(hello, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      hello,
      awarenessProtocol.encodeAwarenessUpdate(entry.awareness, [...states.keys()]),
    )
    send(entry, ws, encoding.toUint8Array(hello))
  }
}

/** Дописать всё несохранённое — при остановке процесса и в тестах. */
export function flushAllFiles(): void {
  for (const entry of [...open.values()]) saveNow(entry)
}

/**
 * То же самое, но одной комнатой: перед запуском, который читает диск.
 *
 * Ячейка и `run_file` оракула читают файл через ядро, то есть с диска, а запись
 * отложена на паузу в наборе. Ждать её они не вправе — но и дописывать за всех
 * тоже: карта здесь общая на инстанс, и без этой границы каждый запуск в одной
 * комнате трогал бы открытые файлы всех остальных.
 */
export function flushSessionFiles(sessionId: string): void {
  for (const entry of [...open.values()]) {
    if (entry.sessionId === sessionId) saveNow(entry)
  }
}

/**
 * Дописать один открытый файл на диск прямо сейчас.
 *
 * Запись отложена на паузу в наборе (`SAVE_AFTER_MS`), а два места ждать её не
 * вправе. Запуск: `python` читает диск, и без этого он читает текст без
 * последних набранных строк — ошибка приходит про строку, которая на экране
 * выглядит верной. Переименование: `forgetFile` уносит документ вместе с
 * отложенной записью, а после переезда писать уже некуда.
 *
 * Файл, который никто не открывал, и так на диске — тогда делать нечего.
 */
export function flushFile(sessionId: string, path: string): void {
  const entry = openFileDoc(sessionId, path)
  if (entry) saveNow(entry)
}

/**
 * Забыть файл — или папку со всем, что в ней: их переименовали или убрали.
 *
 * Без этого документ пережил бы собственный файл и записал бы его обратно на
 * прежнее место следующим сохранением — переименование отменилось бы само
 * секунду спустя, и объяснить это было бы нечем. Наблюдатель за диском заметил
 * бы то же самое, но только через две секунды, а окно между ними — ровно то,
 * в которое успевает сработать отложенное сохранение.
 *
 * Путь целиком, а не точное совпадение: переименовать и убрать можно ПАПКУ, а
 * документы лежат под путями файлов внутри неё. Забыв один точный путь, мы
 * оставляли их живыми — и ближайшее сохранение заводило старую папку заново с
 * одним файлом в ней, тогда как правки последних секунд оставались в этом
 * призрачном пути, а не в новом.
 */
export function forgetFile(sessionId: string, path: string): void {
  if (!path) return
  for (const entry of [...open.values()]) {
    if (entry.sessionId !== sessionId) continue
    if (!isInside(entry.path, path)) continue
    entry.gone = true
    closeAll(entry, 4404, 'файла больше нет')
    dispose(entry)
  }
}

/** Закрыть всё: комнату удалили, процесс останавливается. */
export function forgetFiles(sessionId: string): void {
  for (const entry of [...open.values()]) {
    if (entry.sessionId !== sessionId) continue
    saveNow(entry)
    closeAll(entry, 1001, 'комната закрыта')
    dispose(entry)
  }
}
