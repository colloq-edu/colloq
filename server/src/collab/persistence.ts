import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { noteRoomDoc } from '../blobs.js'
import { config } from '../config.js'
import { db, loadDocSnapshot, saveDocSnapshot } from '../db.js'

/**
 * Durability for session documents.
 *
 * We store one whole-document snapshot per session rather than an update log:
 * a seminar notebook is small, and a single row makes recovery trivial — the
 * process can be restarted mid-class and every notebook comes back intact.
 *
 * Writes are debounced because typing emits an update per keystroke, and the
 * debounce is capped because a lecturer who types for a solid minute must still
 * never have more than MAX_DEFER_MS of work exposed to a crash.
 *
 * A snapshot is also what makes a late joiner fast, so the cap is a promise:
 * everything below only decides *when* inside that window to spend the encode,
 * never whether the promise holds.
 *
 * ХВОСТ. Полная копия каждые пять секунд — это и есть цена этой простоты, и
 * платит её тот, у кого тетрадь большая: пока в комнате не перестают печатать,
 * двухмегабайтный документ уезжал в WAL двенадцать раз в минуту, то есть
 * двадцать шесть мегабайт в минуту ради нескольких килобайт настоящих правок
 * (сводится WAL раз в пять минут). Поэтому между полными копиями пишется
 * ХВОСТ — разница с последним снимком, файлом рядом с базой
 * (`<DATA_DIR>/doc-tail/<комната>.bin`), мимо WAL и мимо всякой сборки мусора.
 * Полная копия — не чаще раза в FULL_EVERY_MS, а также на затишье, на явный
 * сброс и на выходе.
 *
 * Обещание при этом то же самое, и это здесь главное: снимок плюс хвост — это
 * документ, а хвост пишется по прежнему сроку. Окно потери при `kill -9` не
 * выросло ни на миллисекунду; выросло только расстояние между полными копиями.
 */

/**
 * Hard ceiling on how old the oldest unsaved edit may get.
 *
 * Пять секунд, а не пятнадцать: это и есть окно потери при `kill -9`, OOM или
 * обесточивании — штатные выходы (SIGINT/SIGTERM/uncaughtException) флашат сами.
 * Пятнадцать секунд молчаливой потери — это абзац, набранный при всей комнате,
 * и вернувшийся сервер, который заставляет перезагрузить вкладки, чтобы его
 * стереть.
 *
 * Цена названа замером (encode + запись в SQLite, better-sqlite3): тетрадь на
 * 22 КБ — 0.5 мс, на 292 КБ — 2.4 мс, на 2.3 МБ — 6.8 мс. Потолок бьёт только
 * по большим тетрадям (маленькие пишутся по snapshotIntervalMs), так что
 * втрое чаще платит именно тот, у кого мегабайт: 6.8 мс раз в пять секунд —
 * 0.14% цикла событий. Дороже другое, и это осознанно: пока в такой тетради
 * печатают не переставая, в WAL уходит втрое больше байтов (2.3 МБ каждые пять
 * секунд), а сводится он раз в пять минут.
 */
const MAX_DEFER_MS = 5_000

/**
 * Как часто документ ложится на диск ЦЕЛИКОМ, пока в комнате печатают.
 *
 * Тридцать секунд — это про место и про WAL, а не про сохранность: между
 * полными копиями на диске лежит хвост (см. шапку), и он пишется по прежнему
 * сроку в пять секунд. Считать надо так: полная копия обязана быть настолько
 * редкой, чтобы её цена не зависела от того, печатают в комнате или нет, и
 * настолько частой, чтобы хвост не вырос до размеров самого документа. За
 * полминуты непрерывного набора хвост — это десятки килобайт против мегабайтов
 * документа.
 */
const FULL_EVERY_MS = 30_000

/**
 * Сколько тишины считается затишьем: после него документ ложится целиком.
 *
 * Комната, в которой перестали печатать, — самый дешёвый момент для полной
 * копии, и самый правильный: хвоста после неё нет вовсе, а поднимать такую
 * комнату будет тот, кто войдёт в неё завтра. Больше окна дребезга и заметно
 * меньше полминуты: между упражнениями пауза именно такая.
 */
const SETTLE_MS = 10_000

/** Marks our own writes back into the doc so they don't schedule a re-save. */
const ORIGIN = 'persistence'

/** Below this the encode is too cheap to be worth deferring. */
const BACKOFF_FROM_BYTES = 128 * 1024

/**
 * Пауза перед повтором неудачной записи.
 *
 * Диск не освободится за миллисекунду, а спешить некуда: правки в памяти целы,
 * и повторять их можно сколько угодно. Без паузы повтор пошёл бы сразу —
 * дедлайн-то давно прошёл, — и переполненный диск дал бы горячий цикл.
 */
const RETRY_MS = 5_000

/** Snapshot timings, for the seminar that has quietly grown a 4 MB notebook. */
const DEBUG =
  (process.env.DEBUG ?? '').includes('colloq') || (process.env.LOG_LEVEL ?? '') === 'debug'

interface Binding {
  sessionId: string
  doc: Y.Doc
  onUpdate: (update: Uint8Array, origin: unknown, doc: Y.Doc, tr: Y.Transaction) => void
  timer: NodeJS.Timeout | null
  /** Таймер затишья: полная копия, когда в комнате перестали печатать. */
  settleTimer: NodeJS.Timeout | null
  /** Timestamp of the oldest unsaved edit; 0 means the doc is clean. */
  dirtySince: number
  /** State of what is durable — snapshot plus tail — and how big the snapshot was. */
  savedVector: Uint8Array | null
  savedBytes: number
  /**
   * Что лежит в самой строке снимка, и когда она туда легла.
   *
   * Отдельно от `savedVector`: хвост считается разницей именно с НЕЙ, а не с
   * тем, что durable вообще. Без этого разделения второй хвост подряд
   * описывал бы разницу с первым хвостом — и восстановление после сбоя
   * зависело бы от того, какой из них успел лечь.
   */
  snapshotVector: Uint8Array | null
  snapshotAt: number
  /** Лежит ли сейчас на диске хвост. */
  tailed: boolean
  /** Transactions that deleted something, here and as of the last snapshot. */
  deletions: number
  savedDeletions: number
}

const bindings = new Map<string, Binding>()

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * How long an idle-but-dirty doc may wait. Encoding a large notebook is
 * milliseconds of event loop that every keystroke in the room queues behind, so
 * a big doc drifts toward the ceiling instead of paying that every few seconds.
 */
function intervalFor(bytes: number): number {
  if (bytes <= BACKOFF_FROM_BYTES) return config.snapshotIntervalMs
  return Math.min(Math.round(config.snapshotIntervalMs * (bytes / BACKOFF_FROM_BYTES)), MAX_DEFER_MS)
}

/**
 * Есть ли строка семинара — честным SELECT, мимо кэша комнат.
 *
 * `getSession` теперь отвечает из памяти (db.ts · roomCache), и на рукопожатии
 * это правильно: пятьсот вкладок спрашивают одно и то же за секунду. Здесь тот
 * же вопрос стоит иначе — это последняя преграда перед снимком удалённого
 * семинара, и цена ошибки несимметрична. Промах кэша стоит один SELECT по
 * первичному ключу раз в несколько секунд на комнату — ровно ничего; забытая
 * инвалидация в новом пути удаления вернула бы тетрадь класса на диск, а до
 * снимка без строки семинара не ведёт уже ни одна дверь: ни открыть, ни
 * удалить. Пусть эта проверка держится сама, а не тем, что каждый писатель
 * помнит про `forgetRoom`.
 *
 * Писать в `sessions` этот модуль по-прежнему не умеет: дверь на запись одна,
 * и она в db.ts.
 */
const selectSessionRow = db.prepare('SELECT 1 FROM sessions WHERE id = ?')

function sessionRowExists(sessionId: string): boolean {
  return selectSessionRow.get(sessionId) !== undefined
}

/* ------------------------------------------------------------------ хвост */

/**
 * Разница с последним полным снимком — файлом рядом с базой.
 *
 * Файл, а не строка SQLite: строка означала бы запись в WAL, то есть ровно ту
 * цену, ради которой хвост и заведён. Имя — комната; содержимое — обычное
 * обновление Yjs, которое достаточно применить поверх снимка.
 *
 * Пишется через временный файл: восстановление после сбоя читает его первым
 * делом, и недописанный хвост — это не «потеряли пять секунд», а «не
 * поднимается комната».
 */
const TAIL_DIR = 'doc-tail'
const ROOM_OK = /^[A-Za-z0-9_-]{1,64}$/

function tailPath(sessionId: string): string | null {
  if (!ROOM_OK.test(sessionId)) return null
  return path.join(config.dataDir, TAIL_DIR, `${sessionId}.bin`)
}

function writeTail(sessionId: string, update: Uint8Array): boolean {
  const file = tailPath(sessionId)
  if (!file) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, update, { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    console.error(`[persistence] не записался хвост для ${sessionId}`, err)
    return false
  }
}

function readTail(sessionId: string): Uint8Array | null {
  const file = tailPath(sessionId)
  if (!file) return null
  try {
    const body = fs.readFileSync(file)
    return body.length > 0 ? new Uint8Array(body) : null
  } catch {
    return null
  }
}

/**
 * Убрать хвост — всегда ПОСЛЕ того, как полная копия легла.
 *
 * Порядок здесь и есть обещание сохранности: между записью снимка и сносом
 * хвоста процесс может умереть, и тогда старый хвост применится поверх нового
 * снимка. Это ничего не портит — он описывает то, что в снимке уже есть, а
 * повторное применение обновления в Yjs не делает ничего. Обратный порядок
 * оставлял бы окно, в котором на диске нет ни того ни другого.
 */
function dropTail(sessionId: string): void {
  const file = tailPath(sessionId)
  if (!file) return
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* хвост, который не убрался, применится ещё раз и ничего не изменит */
  }
}

/**
 * Документ целиком — одной строкой, после чего хвоста нет.
 *
 * Порядок: сначала строка снимка, потом снос хвоста (почему именно так —
 * см. `dropTail`). Возвращает, сколько весила копия.
 */
function full(binding: Binding, vector: Uint8Array): number {
  const update = Y.encodeStateAsUpdate(binding.doc)
  saveDocSnapshot(binding.sessionId, update)
  if (binding.tailed) {
    dropTail(binding.sessionId)
    binding.tailed = false
  }
  binding.dirtySince = 0
  binding.savedVector = vector
  binding.savedDeletions = binding.deletions
  binding.savedBytes = update.byteLength
  binding.snapshotVector = vector
  binding.snapshotAt = Date.now()
  if (binding.settleTimer) {
    clearTimeout(binding.settleTimer)
    binding.settleTimer = null
  }
  return update.byteLength
}

/** Положить комнату целиком, когда в ней перестанут печатать. */
function settle(binding: Binding): void {
  if (binding.settleTimer) clearTimeout(binding.settleTimer)
  binding.settleTimer = setTimeout(() => {
    binding.settleTimer = null
    if (bindings.get(binding.sessionId) !== binding) return
    // Грязный документ положит своим чередом обычная запись — а она к этому
    // моменту либо уже прошла, либо вот-вот пройдёт по своему сроку.
    if (binding.dirtySince !== 0 || !binding.tailed) return
    if (!sessionRowExists(binding.sessionId)) return
    try {
      full(binding, Y.encodeStateVector(binding.doc))
    } catch (err) {
      console.error(`[persistence] snapshot on settle failed for ${binding.sessionId}`, err)
    }
  }, SETTLE_MS)
  binding.settleTimer.unref?.()
}

function write(binding: Binding, force = false): void {
  if (binding.timer) {
    clearTimeout(binding.timer)
    binding.timer = null
  }
  if (binding.dirtySince === 0) {
    // Чистый документ с хвостом на диске — это комната, в которой перестали
    // печатать: самый дешёвый момент положить её целиком и убрать хвост.
    if (force && binding.tailed && sessionRowExists(binding.sessionId)) {
      try {
        full(binding, Y.encodeStateVector(binding.doc))
      } catch (err) {
        console.error(`[persistence] snapshot failed for ${binding.sessionId}`, err)
      }
    }
    return
  }

  // The last word on a deleted seminar. Anything still holding this document —
  // a kernel shutting down, a socket that has not noticed yet — would otherwise
  // put the room back on disk seconds after the owner destroyed it, and a
  // snapshot with no session row is a file nobody can reach or remove.
  if (!sessionRowExists(binding.sessionId)) {
    binding.dirtySince = 0
    if (binding.tailed) {
      dropTail(binding.sessionId)
      binding.tailed = false
    }
    return
  }

  // Two questions, because Yjs answers "what changed?" in two places: inserts
  // advance a client's clock and show up in the state vector, deletions never
  // do — they only add ranges to the delete set. Skipping on the vector alone
  // would silently drop a deleted cell from the snapshot.
  const vector = Y.encodeStateVector(binding.doc)
  if (
    binding.savedVector &&
    binding.deletions === binding.savedDeletions &&
    sameBytes(vector, binding.savedVector)
  ) {
    binding.dirtySince = 0
    return
  }

  /*
   * Хвостом или целиком — по тому, давно ли лежала полная копия.
   *
   * Первая запись комнаты всегда полная: разницу считать не с чем. Дальше, пока
   * в комнате печатают, идут хвосты, а раз в полминуты — полная копия, после
   * которой хвост начинается заново и потому не растёт.
   */
  const now = Date.now()
  const canTail =
    !force && binding.snapshotVector !== null && now - binding.snapshotAt < FULL_EVERY_MS

  try {
    const began = process.hrtime.bigint()
    if (canTail) {
      const tail = Y.encodeStateAsUpdate(binding.doc, binding.snapshotVector!)
      if (!writeTail(binding.sessionId, tail)) throw new Error('tail write failed')
      binding.tailed = true
      binding.dirtySince = 0
      binding.savedVector = vector
      binding.savedDeletions = binding.deletions
      /*
       * Полная копия — когда перестанут печатать.
       *
       * Без этого комната, в которой замолчали на середине хвоста, так и
       * лежала бы снимком получасовой давности плюс файлом рядом: поднимается
       * это правильно, но лишний файл переживал бы и конец занятия, и
       * перезапуск. Таймер снимается следующей же записью.
       */
      settle(binding)
      if (DEBUG) {
        const ms = Number(process.hrtime.bigint() - began) / 1e6
        console.debug(
          `[persistence] ${binding.sessionId} tail ${tail.byteLength}B in ${ms.toFixed(1)}ms`,
        )
      }
    } else {
      /*
       * Чистым документ делает удачная запись, а не попытка.
       *
       * Стояло выше, до записи, — и ошибка sqlite (диск полон, ввод-вывод,
       * занятая база) молча оставляла комнату «сохранённой»: ни таймер, ни flush
       * на выходе к ней больше не возвращались, потому что все они выходят на
       * `dirtySince === 0`. Класс, в котором после сбоя никто больше не
       * напечатал ни символа, доезжал до `make down` без последних правок.
       */
      const bytes = full(binding, vector)
      if (DEBUG) {
        const ms = Number(process.hrtime.bigint() - began) / 1e6
        console.debug(
          `[persistence] ${binding.sessionId} snapshot ${bytes}B in ${ms.toFixed(1)}ms`,
        )
      }
    }
  } catch (err) {
    // Losing a snapshot must not take the live session down with it.
    console.error(`[persistence] snapshot failed for ${binding.sessionId}`, err)
    // Документ остался грязным — значит, будет и повтор. Только пока привязка
    // жива: у отпущенной (комнату закрыли и открыли заново) документ уже не
    // тот, и запись поверх свежего снимка была бы откатом.
    binding.timer = setTimeout(() => {
      if (bindings.get(binding.sessionId) === binding) write(binding)
    }, RETRY_MS)
    binding.timer.unref?.()
  }
}

function schedule(binding: Binding): void {
  const now = Date.now()
  if (binding.dirtySince === 0) binding.dirtySince = now
  const deadline = binding.dirtySince + MAX_DEFER_MS
  // The deadline is measured from the oldest unsaved edit and clamps the
  // backoff, so a bigger notebook waits longer but never past the ceiling.
  const delay = Math.max(0, Math.min(intervalFor(binding.savedBytes), deadline - now))
  if (binding.timer) clearTimeout(binding.timer)
  /*
   * unref: a pending snapshot must not be the reason a process stays alive. The
   * server is kept up by its listening socket and shutdownCollab() flushes on
   * the way out, so nothing is lost — while without it any script that so much
   * as reads a document hangs for the length of the interval, which is exactly
   * how the unit suite came to take three minutes to print anything.
   */
  binding.timer = setTimeout(() => write(binding), delay)
  binding.timer.unref?.()
}

/**
 * Hydrate `doc` from its stored snapshot and keep writing it back as it changes.
 * Returns a disposer that flushes synchronously and stops observing.
 */
export function bindPersistence(sessionId: string, doc: Y.Doc): () => void {
  const previous = bindings.get(sessionId)
  if (previous) {
    write(previous)
    previous.doc.off('update', previous.onUpdate)
    bindings.delete(sessionId)
  }

  const binding: Binding = {
    sessionId,
    doc,
    onUpdate: () => {},
    timer: null,
    settleTimer: null,
    dirtySince: 0,
    savedVector: null,
    savedBytes: 0,
    snapshotVector: null,
    snapshotAt: 0,
    tailed: false,
    deletions: 0,
    savedDeletions: 0,
  }
  binding.onUpdate = (_update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
    if (origin === ORIGIN) return
    if (tr.deleteSet.clients.size > 0) binding.deletions++
    schedule(binding)
  }

  const snapshot = loadDocSnapshot(sessionId)
  if (snapshot) {
    Y.applyUpdate(doc, snapshot, ORIGIN)
    // Read the vector out of the stored bytes, not out of the doc: this has to
    // describe what is on disk. If the doc were handed to us with content the
    // snapshot never had, the two differ and the next edit writes, as it must.
    binding.savedVector = Y.encodeStateVectorFromUpdate(snapshot)
    binding.savedBytes = snapshot.byteLength
    binding.snapshotVector = binding.savedVector
    binding.snapshotAt = Date.now()
  }
  /*
   * И хвост — то, что комната успела написать после последней полной копии.
   *
   * Читается всегда, а не только когда снимок нашёлся: снимка может не быть
   * вовсе (первая полная копия ещё не легла), и тогда хвост — это всё, что от
   * комнаты осталось. Применяется ПОСЛЕ снимка, потому что описывает разницу
   * с ним; лишний, уже учтённый хвост Yjs применит и не изменит ничего.
   */
  const tail = readTail(sessionId)
  if (tail) {
    try {
      Y.applyUpdate(doc, tail, ORIGIN)
      binding.tailed = true
      binding.savedVector = Y.encodeStateVector(doc)
    } catch (err) {
      // Испорченный хвост — это потерянные секунды, а не потерянная комната:
      // снимок уже применён, и дальше работаем от него.
      console.error(`[persistence] хвост ${sessionId} не читается`, err)
      dropTail(sessionId)
    }
  }
  /*
   * Документ теперь знает, чьей комнаты он: единственное место, через которое
   * проходит КАЖДАЯ тетрадь, живая и поднятая на минуту. Читает это
   * `publish/build.ts`, когда вкладывает вынесенные картинки обратно в
   * публикацию (server/src/blobs.ts · roomOfDoc).
   */
  noteRoomDoc(sessionId, doc)

  doc.on('update', binding.onUpdate)
  bindings.set(sessionId, binding)

  return () => {
    if (bindings.get(sessionId) !== binding) return
    bindings.delete(sessionId)
    doc.off('update', binding.onUpdate)
    if (binding.settleTimer) clearTimeout(binding.settleTimer)
    // Комната уходит из памяти — на диске должна остаться она целиком, а не
    // снимок с файлом рядом: поднимут её, может быть, через неделю.
    write(binding, true)
  }
}

/**
 * Stop persisting a session and write nothing — the opposite of the disposer
 * above, which flushes on its way out. The only caller is a seminar being
 * deleted: flushing there would write a snapshot row for a room that no longer
 * exists, which is exactly the state the delete was for.
 */
export function discardPersistence(sessionId: string): void {
  // Хвост — тоже запись о комнате, и уходит он вместе с ней. Снимается даже
  // без привязки: строку снимка удаление убирает своей рукой, и файл рядом с
  // ней остался бы единственным следом удалённого семинара на диске.
  dropTail(sessionId)
  const binding = bindings.get(sessionId)
  if (!binding) return
  bindings.delete(sessionId)
  if (binding.timer) clearTimeout(binding.timer)
  if (binding.settleTimer) clearTimeout(binding.settleTimer)
  binding.tailed = false
  binding.doc.off('update', binding.onUpdate)
}

/**
 * Забыть, что снимок на диске совпадает с документом, — и переписать его.
 *
 * `write()` не пишет, пока вектор состояния и число удалений те же, что у
 * записанного: это правильно для правок, у которых нет ни того ни другого не
 * бывает. Но сброс подвисших структур (collab/index.ts · getEntry) не меняет ни
 * вектора, ни удалений — он меняет только то, что `encodeStateAsUpdate` кладёт
 * в байты, — и без этой ручки чистый документ ложился бы на диск лишь со
 * следующим нажатием в комнате, а до него каждый перезапуск поднимал бы мусор
 * заново.
 */
export function invalidateSnapshot(sessionId: string): void {
  const binding = bindings.get(sessionId)
  if (!binding) return
  binding.savedVector = null
  /*
   * И хвостом тут не отделаться.
   *
   * Хвост — это разница с записанным снимком, а сброс подвисших структур
   * меняет не разницу, а САМ снимок: те же такты, те же удаления, другие
   * байты. Пока на диске лежит прежняя полная копия, мусор в ней остаётся при
   * любом числе хвостов, — поэтому следующая запись обязана быть полной.
   */
  binding.snapshotVector = null
  schedule(binding)
}

/**
 * Write one document's snapshot now, without waiting for the debounce.
 *
 * The debounce exists for typing, where a snapshot per keystroke would be
 * absurd. A brand-new room is the opposite case: it holds two starter cells and
 * nothing else, the encode is under a millisecond, and until those bytes are on
 * disk the room does not exist as far as a crash is concerned — the server
 * comes back, finds no snapshot, decides the room is new and seeds the starter
 * cells a second time. The returning clients then merge their real notebook in
 * on top and the room opens with two Welcome cells.
 */
export function flushPersistence(sessionId: string): void {
  const binding = bindings.get(sessionId)
  // Целиком, а не хвостом: «запиши сейчас» просят в тех местах, где на диске
  // должна остаться комната, а не комната плюс файл рядом, — новая комната
  // перед первым входом, визит в чужую тетрадь, конец занятия.
  if (binding) write(binding, true)
}

/** Last-chance save for every live document, called on shutdown. */
export function flushAllPersistence(): void {
  for (const binding of bindings.values()) write(binding, true)
}
