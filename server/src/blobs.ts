/**
 * Картинки вывода — рядом с комнатой, а не внутри её документа.
 *
 * Документ комнаты разъезжается ЦЕЛИКОМ каждому, кто вошёл, и переписывается
 * целиком в каждый снимок и в каждый ключевой кадр истории. Пока график
 * matplotlib лежал в нём base64-строкой, одна картинка на двести килобайт
 * стоила: 270 КБ в документе (base64 — это +33%), столько же в каждом кадре
 * синхронизации КАЖДОМУ из пятисот зрителей, столько же в снимке каждые пять
 * секунд, пока в комнате печатают, и столько же в ключевом кадре истории.
 * Замер на настоящем занятии: 100 МБ исходящего и 2.2 секунды zlib на одну
 * картинку в зале на пятьсот человек.
 *
 * Здесь байты лежат один раз, по хэшу своего содержимого, а в документе
 * остаётся ссылка на полторы сотни байт (`shared/notebook.ts · OutputBlob`).
 * Раздаёт их `routes/blobs.ts` с вечным кэшем: хэш и есть версия, так что
 * второй раз за той же картинкой браузер не придёт.
 *
 * Почему файлы, а не строки SQLite (как у публикаций): снимок публикации
 * собирают раз в семестр, а вывод пишется посреди занятия — блоб в базе
 * означал бы двести килобайт в WAL на каждый график, то есть ровно ту цену, от
 * которой уходили. Файл ложится мимо базы и раздаётся системным вызовом.
 *
 * Уборка — по комнате: `deleteRoomBlobs` зовут при удалении семинара, а
 * `sweepOrphans` подметает за путями удаления, которые об этом хранилище не
 * знают (и за теми, которые появятся). Внутри живой комнаты байты не
 * собираются: на старую картинку смотрит не только нынешняя тетрадь, но и
 * каждая версия истории, в которой эта ячейка ещё не перезапускалась.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { db } from './db.js'

/** Ссылка, какой её кладут в документ: хэш, тип и вес. */
export interface StoredBlob {
  sha: string
  bytes: number
}

/** Имя комнаты едет в путь на диске, поэтому проверяется буквами. */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/
/** sha256 в шестнадцатеричном виде — и ничего, кроме него. */
const SHA_OK = /^[0-9a-f]{64}$/

function roomDir(sessionId: string): string | null {
  if (!ID_OK.test(sessionId)) return null
  return path.join(config.dataDir, 'blobs', sessionId)
}

/**
 * Тип содержимого — по его первым байтам, а не по тому, что сказал зовущий.
 *
 * Заголовок ответа собирается из этого, а заголовок — это то, чем браузер
 * решает, показать байты картинкой или исполнить их документом на origin
 * инстанса. Ядро присылает mime само, и доверять ему тут нечего: `display_data`
 * формирует библиотека, работающая в коде студента. Сигнатура файла такого
 * выбора не оставляет — `text/html` из неё не выйдет никогда.
 */
export function sniffMime(body: Uint8Array): string {
  const at = (i: number) => body[i]
  if (body.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return 'image/png'
  }
  if (body.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (body.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif'
  if (
    body.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp'
  }
  return 'application/octet-stream'
}

/**
 * Положить байты и назвать их хэшем.
 *
 * Содержимое адресует само себя: одна и та же картинка, нарисованная дважды
 * (перезапуск ячейки без изменений — обычное дело на семинаре), ложится один
 * раз и в документе выглядит той же ссылкой. `null` — не положили: тогда
 * зовущий пишет вывод как раньше, прямо в документ.
 */
export function putBlob(sessionId: string, body: Uint8Array): StoredBlob | null {
  const dir = roomDir(sessionId)
  if (!dir || body.length === 0) return null
  const sha = createHash('sha256').update(body).digest('hex')
  const file = path.join(dir, sha)
  try {
    // Существующий не переписываем: те же байты дали тот же хэш, а лишняя
    // запись посреди занятия — это лишний fsync под чужим набором текста.
    if (fs.existsSync(file)) return { sha, bytes: body.length }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    /*
     * Через временный файл: читатель приходит за картинкой в тот же миг, в
     * какой она появилась в документе, — и недописанный файл он получил бы
     * битой картинкой с вечным кэшем, то есть навсегда.
     */
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, file)
    sweepSometimes()
    return { sha, bytes: body.length }
  } catch (err) {
    console.error(`[blobs] не удалось записать вывод комнаты ${sessionId}`, err)
    return null
  }
}

/** Байты по ссылке — или `null`, если такой записи нет. */
export function readBlob(sessionId: string, sha: string): Buffer | null {
  const dir = roomDir(sessionId)
  if (!dir || !SHA_OK.test(sha)) return null
  try {
    return fs.readFileSync(path.join(dir, sha))
  } catch {
    return null
  }
}

/** Сколько весит запись, не читая её. `null` — записи нет. */
export function blobBytes(sessionId: string, sha: string): number | null {
  const dir = roomDir(sessionId)
  if (!dir || !SHA_OK.test(sha)) return null
  try {
    return fs.statSync(path.join(dir, sha)).size
  } catch {
    return null
  }
}

/** Убрать всё, что комната нарисовала. Говорит, сколько записей унесла. */
export function deleteRoomBlobs(sessionId: string): number {
  const dir = roomDir(sessionId)
  if (!dir) return 0
  let count = 0
  try {
    count = fs.readdirSync(dir).length
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    return 0
  }
  return count
}

/* ------------------------------------------------- чей это документ */

/**
 * Какой комнате принадлежит этот `Y.Doc`.
 *
 * Ссылка в выводе адресуется хэшем, а полка — комнатой, и тот, кто читает
 * тетрадь, комнату знает не всегда: `pageOfDoc` для публикации получает один
 * документ и всё. Спрашивать её вторым параметром через пять уровней вызовов
 * значило бы тащить идентификатор туда, где он больше ни для чего не нужен, —
 * а документ комнаты и так рождается в одном-единственном месте, где имя
 * известно: привязке к диску (`collab/persistence.ts · bindPersistence`).
 *
 * `WeakMap`: запись уходит вместе с выселенным документом, ничего не удерживая.
 */
const docRooms = new WeakMap<object, string>()

export function noteRoomDoc(sessionId: string, doc: object): void {
  docRooms.set(doc, sessionId)
}

export function roomOfDoc(doc: object): string | null {
  return docRooms.get(doc) ?? null
}

/* --------------------------------------------------------------- уборка */

/**
 * Подмести за удалёнными комнатами.
 *
 * Удаление семинара зовёт `deleteRoomBlobs` само, и этого достаточно ровно до
 * первого нового пути удаления, который про это хранилище не узнает. Цена
 * ошибки несимметрична: забытая папка — это картинки удалённого занятия,
 * лежащие на диске неограниченно долго. Поэтому вторая линия: раз в час, на
 * запись, сверяем имена папок со строками семинаров.
 *
 * Строку спрашиваем честным SELECT мимо кэша комнат по той же причине, по
 * какой это делает persistence.ts: промах кэша стоит один поиск по первичному
 * ключу раз в час, а ошибка в другую сторону стёрла бы картинки живого
 * занятия.
 */
const SWEEP_EVERY_MS = 60 * 60_000
const selectSessionRow = db.prepare('SELECT 1 FROM sessions WHERE id = ?')
let sweptAt = 0

function sweepSometimes(): void {
  const now = Date.now()
  if (now - sweptAt < SWEEP_EVERY_MS) return
  sweptAt = now
  sweepOrphans()
}

/** То же самое, но сейчас и вслух: сколько комнат убрано. */
export function sweepOrphans(): number {
  const root = path.join(config.dataDir, 'blobs')
  let rooms: string[]
  try {
    rooms = fs.readdirSync(root)
  } catch {
    return 0
  }
  let dropped = 0
  for (const room of rooms) {
    if (selectSessionRow.get(room) !== undefined) continue
    deleteRoomBlobs(room)
    dropped++
  }
  return dropped
}
