import { tr } from '@shared/i18n'
/**
 * Тетради и папка семинара: как одно становится видно в другом.
 *
 * Тетрадь живёт в документе комнаты — со снимком в базе, историей версий и
 * кешем в браузерах. Файл на диске — её ПРОЕКЦИЯ: он пишется из документа и
 * никогда не читается обратно, пока тетрадь открыта. Направление одно, и это
 * решение, а не недоделка.
 *
 * Почему не в обе стороны, как у текстовых файлов. У текста слияние двух правок
 * — это склейка по общей голове и хвосту, и она безобидна. У тетради «слить»
 * значило бы разобраться, какая ячейка какой соответствует, при том что ячейка
 * несёт имя, вывод, номер выполнения и чужие курсоры внутри. Неправильно
 * угаданное соответствие стирает работу молча — а правильно угадать нечем:
 * .ipynb на диске имён ячеек не хранит.
 *
 * Отсюда два следствия, названные вслух в интерфейсе:
 * — записать поверх файла тетради нельзя ни загрузкой, ни оракулом: проекция
 *   всё равно вернёт своё через секунду, и это выглядело бы как пропажа;
 * — открыть .ipynb, который положили в папку, — значит ВНЕСТИ его в комнату:
 *   ячейки переезжают в документ, и дальше правда там.
 */
import * as Y from 'yjs'
import {
  addBook,
  allBooks,
  allCellArrays,
  bookAt,
  bookCells,
  bookList,
  BOOKS_KEY,
  CELLS_KEY,
  createCell,
  getMeta,
  readCell,
  removeBook,
  renameBook,
  rootForNewBook,
  type Book,
} from '@shared/notebook'
import { parseIpynb, writeIpynb, type FlatCell } from '@shared/ipynb'
import { baseOf, isInside, kindOf } from '@shared/paths'
import { MAX_BOOK_OWNER_NAME, MAX_OWN_BOOKS, type BookRule } from '@shared/rules'
import { shelveCellImages, withInlinedImages } from '../notebook-images.js'
import { getRules, isFinished, setRules, storedRules } from '../db.js'
import { getSessionDoc, peekSessionDoc } from './index.js'
import { makeFile, readText, statPath, writeText } from '../workspace.js'

const ORIGIN = 'server'

/**
 * Сколько ждать после последней правки, прежде чем переписать файл.
 *
 * Полторы секунды, а не семьсот миллисекунд, как у текста: тетрадь
 * сериализуется целиком, и на паре, где двадцать человек печатают в разные
 * ячейки, это заметная работа на каждое нажатие. Файл нужен не тому, кто
 * печатает, а тому, кто потом его скачает или прочитает из ячейки.
 */
const WRITE_AFTER_MS = 1_500

/** Ячеек в тетради, которую соглашаемся внести в комнату. */
const MAX_IMPORT_CELLS = 500

/**
 * Байтов в файле тетради, который соглашаемся разобрать.
 *
 * Своя мера, крупнее редакторской (`MAX_TEXT_BYTES`, полтора мегабайта). Та
 * стоит там, где файл правят посимвольно, и полтора мегабайта — это уже предел
 * для CodeMirror. Тетрадь никто посимвольно не правит: её разбирают ОДИН раз,
 * из неё берут только тип и текст ячеек, а выводы — то есть почти весь её вес —
 * при внесении отбрасываются. Тетрадь с десятком картинок matplotlib весит
 * несколько мегабайт и является совершенно обычной преподавательской тетрадью;
 * потолок редактора отказывал ей словами «не похоже на .ipynb».
 *
 * Цена названа: тридцать два мегабайта — это около полусекунды `JSON.parse`,
 * заблокировавшего цикл событий один раз на нажатие в дереве. Больше — уже не
 * тетрадь для занятия, и об этом говорится вслух.
 */
const MAX_BOOK_BYTES = 32 * 1024 * 1024

const pending = new Map<string, NodeJS.Timeout>()

/**
 * Плоские ячейки тетради — то, что уходит в файл.
 *
 * Идентификатор несётся вместе с ними: схема 4.5 требует его у каждой ячейки, а
 * без него `writeIpynb` подставляет порядковый номер — и файл, переписанный
 * после перестановки двух ячеек, поменял бы имена всем, кто стоит ниже.
 */
function flatten(cells: Y.Array<any>): FlatCell[] {
  return cells.map((cell) => {
    const read = readCell(cell)
    return { id: read.id, type: read.type, source: read.source }
  })
}

/**
 * То же самое, но для ФАЙЛА: картинки заметок возвращаются вложениями.
 *
 * В документе они лежат ссылкой на полку комнаты (shared/images.ts) — ради
 * этого ссылка и заведена, — а файл несут к себе и открывают чем угодно. Без
 * этого тетрадь с условиями-картинками доезжала бы до студента пустыми
 * рамками.
 *
 * Отдельной функцией, а не флагом у `flatten`, потому что второй читатель
 * тетради — оракул (`bookText`), и ему в запрос модели раскодированный
 * мегабайт картинки не нужен и никогда не отправлялся.
 */
function flattenForFile(sessionId: string, cells: Y.Array<any>): FlatCell[] {
  return withInlinedImages(sessionId, flatten(cells))
}

/**
 * Переписать файлы всех тетрадей комнаты.
 *
 * Все, а не одну изменившуюся: сравнение с тем, что уже на диске, стоит дешевле
 * разбора события, а тетрадей в комнате единицы. Файл, который не поменялся, не
 * переписывается — иначе время изменения дёргалось бы на каждое нажатие и
 * панель файлов моргала бы всю пару.
 */
export function projectBooks(sessionId: string): boolean {
  // Заглянуть, а не завести: комнату могли закрыть, пока таймер ждал, и
  // строить её заново ради записи файла — значит воскрешать удалённое.
  const open = peekSessionDoc(sessionId)
  if (!open) return false
  const { doc } = open
  let wrote = false
  for (const { book, cells } of allBooks(doc)) {
    const text = writeIpynb(flattenForFile(sessionId, cells))
    const now = readText(sessionId, book.path)
    if (now && !now.binary && now.text === text) continue
    if (writeText(sessionId, book.path, text)) wrote = true
  }
  return wrote
}

function schedule(sessionId: string): void {
  if (pending.has(sessionId)) return
  const timer = setTimeout(() => {
    pending.delete(sessionId)
    try {
      /*
       * Комнате говорят только о том, что правда легло на диск.
       *
       * `filesChanged` — это обход всей папки (readdir + lstat на каждую
       * запись) и полное дерево файлов в КАЖДЫЙ сокет комнаты. Слать его после
       * проекции, которая сравнила текст и ничего не переписала, значит платить
       * этим за каждое нажатие в тетради: на паре из пятисот человек дерево
       * уезжало всем каждые полторы секунды при неизменном диске.
       */
      if (projectBooks(sessionId)) filesChanged?.(sessionId)
    } catch (err) {
      console.error(`[books] не удалось записать тетрадь ${sessionId}:`, err)
    }
  }, WRITE_AFTER_MS)
  timer.unref?.()
  pending.set(sessionId, timer)
}

let filesChanged: ((sessionId: string) => void) | null = null

/** Кому сказать, что файлы поменялись. Регистрирует control.ts. */
export function onBooksWritten(listener: (sessionId: string) => void): void {
  filesChanged = listener
}

/**
 * Следить за тетрадями этой комнаты и держать их файлы в порядке.
 *
 * Зовётся один раз на комнату, из `getSessionDoc`. Наблюдатель на весь
 * документ, а не на каждый корень: тетради появляются и исчезают, и
 * переподписываться на каждое появление — это ещё одно место, где можно
 * забыть отписаться.
 */
export function watchBooks(sessionId: string, doc: Y.Doc): () => void {
  const onUpdate = (
    _update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ) => {
    if (!touchesBooks(doc, transaction)) return
    schedule(sessionId)
  }
  doc.on('update', onUpdate)
  // Первая запись — сразу: комната, открытая после перезапуска сервера, должна
  // показать файл тетради в дереве, не дожидаясь, пока в ней что-то напечатают.
  schedule(sessionId)
  return () => {
    doc.off('update', onUpdate)
    const timer = pending.get(sessionId)
    if (timer) clearTimeout(timer)
    pending.delete(sessionId)
  }
}

/**
 * Изменилось ли этим обновлением то, ЧТО ЛЕЖИТ В ФАЙЛЕ тетради.
 *
 * В файле — только состав тетрадей, тип ячейки и её текст (`writeIpynb`).
 * Всё остальное, что живёт в том же документе, туда не попадает: вывод ячейки,
 * состояние запуска, номер `In[]`, строки терминала, ответ оракула, присутствие.
 *
 * Раньше вместо этого стояло `if (origin === PROJECTION) return` с обещанием
 * «своя проекция себя не будит» — ветка недостижимая (проекция пишет на диск, а
 * не в документ, и транзакций с этим происхождением не заводит никто), так что
 * не отсекалось НИЧЕГО. Ячейка, печатающая в цикле, взводила запись тетради
 * каждые полторы секунды, а с ней — обход папки и дерево файлов всей комнате,
 * хотя на диске от вывода не меняется ни байта.
 *
 * Проверка структурная, а не по происхождению: список чужих origin'ов
 * разошёлся бы с кодом при первой же новой записи в документ, и разошёлся бы
 * молча — в сторону «файл не обновился».
 */
function touchesBooks(doc: Y.Doc, transaction: Y.Transaction): boolean {
  const meta: unknown = getMeta(doc)
  const books = getMeta(doc).get(BOOKS_KEY)
  const sheets = new Set<unknown>(allCellArrays(doc))
  let hit = false
  transaction.changed.forEach((keys, type) => {
    if (hit) return
    // Ячейку добавили, убрали или переставили; тетрадь открыли или закрыли.
    if (sheets.has(type) || type === books) hit = true
    else if (type === meta) hit = keys.has(BOOKS_KEY)
    // Тип ячейки — ключ в её же карте; текст — `Y.Text` внутри неё.
    else if (type instanceof Y.Map) hit = sheets.has(type.parent) && keys.has('type')
    else if (type instanceof Y.Text) hit = sheets.has(type.parent?.parent)
  })
  return hit
}

/* ------------------------------------------------- кто завёл эту тетрадь */

/**
 * Кто заводит тетрадь — на случай, если это не преподаватель.
 *
 * Не `TokenPayload` и не участник из базы: сюда доезжает ровно столько, сколько
 * нужно записи об авторе, и ни строкой больше. Имя берётся НА ЭТОТ МОМЕНТ —
 * см. `BookRule.ownerName`, там объяснено, почему его не ищут потом.
 */
export interface BookAuthor {
  participantId: string
  name: string
  role: 'host' | 'participant'
}

let rulesChanged: ((sessionId: string) => void) | null = null

/**
 * Кому сказать, что правила комнаты поменялись сами.
 *
 * Регистрирует control.ts — тем же способом, что и `onBooksWritten` выше, и по
 * той же причине: рассылка живёт в control.ts, а control.ts импортирует этот
 * модуль. Прямой вызов замкнул бы круг импортов.
 */
export function onBookRulesChanged(listener: (sessionId: string) => void): void {
  rulesChanged = listener
}

/**
 * Одна дверь на все способы завести в комнате тетрадь.
 *
 * Способов четыре — пустая тетрадь из дерева, внесение положенного в папку
 * .ipynb, то же самое руками оракула и импорт, — и правило у них одно: свои
 * тетради студентам либо разрешены, либо нет (shared/rules.ts · ownBooks).
 * Проверка живёт здесь, а не у каждой двери, ровно поэтому: четыре копии
 * одного вопроса — это три места, где однажды забудут спросить.
 *
 * Возвращает ПРИЧИНУ отказа или `null`, если можно. Причина человеческая:
 * кнопка, молча ничего не делающая, читается как поломка.
 *
 * Преподаватель проходит насквозь: правила про то, что можно КЛАССУ.
 */
function whyNotAddBook(sessionId: string, doc: Y.Doc, by: BookAuthor): string | null {
  if (by.role === 'host') return null
  /*
   * Действующие правила, а не хранимые: после звонка `ownBooks` приезжает
   * выключенным (shared/rules.ts · rulesAfterClass), и отдельной проверки на
   * конец занятия здесь нет намеренно — она была бы второй копией той же
   * границы. Слова при этом свои: человеку важно, что пара кончилась.
   */
  if (isFinished(sessionId)) return tr('server.classOverPeriod')
  if (getRules(sessionId).ownBooks !== 'on') return tr('server.ownBooksAreOff')
  const mine = ownBooksOf(sessionId, doc, by.participantId)
  if (mine >= MAX_OWN_BOOKS) {
    return tr('server.ownBooksLimit', { p0: MAX_OWN_BOOKS })
  }
  return null
}

/**
 * Сколько СВОИХ тетрадей у этого человека сейчас в комнате.
 *
 * По живым записям: тетрадь, которую убрали, потолка не занимает — иначе три
 * черновика за семестр запирали бы студента навсегда. Считается по карте
 * правил, а не по файлам: автор живёт там (`BookRule.owner`), и только там.
 */
export function ownBooksOf(sessionId: string, doc: Y.Doc, participantId: string): number {
  const books = liveBookRules(doc, storedRules(sessionId).books)
  return Object.values(books).filter((rule) => rule.owner === participantId).length
}

/**
 * Записать автора только что заведённой тетради.
 *
 * Пишет СЕРВЕР и только для не-преподавателя: тетрадь, заведённую
 * преподавателем, автором не подписывают — он и так может в ней всё, а строка
 * «личная тетрадь: Иван Петрович» в меню была бы предложением отнять тетрадь у
 * самого себя. Такая тетрадь остаётся «как в комнате», и это же достаётся
 * тетрадям, заведённым студентами до появления этой записи.
 *
 * Доступ у своей тетради студента — сразу `owner`, и другого значения у неё
 * нет: «своя тетрадь» и «личная» — это одно и то же право, разрешает его
 * `ownBooks`, а сюда мы доходим уже разрешёнными (`whyNotAddBook`).
 * Преподаватель потом меняет доступ любой тетради из меню.
 *
 * Заодно карта чистится от корней, которых в документе больше нет: тетрадь
 * убирают из комнаты щелчком по файлу, а правила лежат в базе и сами об этом не
 * узнают. Чистка ровно здесь и в `dropBook` — то есть в обоих местах, где карта
 * и список тетрадей расходятся.
 */
function rememberAuthor(sessionId: string, doc: Y.Doc, root: string, by: BookAuthor): void {
  if (by.role === 'host') return
  const stored = storedRules(sessionId)
  const rule: BookRule = {
    access: 'owner',
    owner: by.participantId,
    ownerName: by.name.trim().slice(0, MAX_BOOK_OWNER_NAME) || null,
  }
  setRules(sessionId, { ...stored, books: { ...liveBookRules(doc, stored.books), [root]: rule } })
  rulesChanged?.(sessionId)
}

/**
 * Своя ли это личная тетрадь — и вправе ли этот человек её убрать.
 *
 * Убирать тетради из комнаты — право преподавателя, и оно остаётся; здесь одно
 * исключение, без которого «своя тетрадь» была бы полуправдой: черновик,
 * который завёл ты сам и который считается против твоего же потолка, обязан
 * убираться тобой. Чужую личную — нет, тетрадь комнаты — нет.
 */
export function ownsBookAt(sessionId: string, path: string, participantId: string): boolean {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return false
  const book = bookAt(doc, path)
  if (!book) return false
  const rule = storedRules(sessionId).books?.[book.root]
  return rule?.access === 'owner' && rule.owner === participantId
}

/** Записи карты, у которых в документе ещё есть тетрадь. */
function liveBookRules(
  doc: Y.Doc,
  books: Record<string, BookRule> | undefined,
): Record<string, BookRule> {
  if (!books) return {}
  const alive = new Set(bookList(doc).map((book) => book.root))
  const out: Record<string, BookRule> = {}
  for (const [root, rule] of Object.entries(books)) if (alive.has(root)) out[root] = rule
  return out
}

/* ------------------------------------------------------- внести в комнату */

export type OpenBookResult =
  | { ok: true; book: Book; imported: boolean }
  | { ok: false; why: string }

/**
 * Открыть .ipynb как тетрадь комнаты.
 *
 * Уже внесённая возвращается как есть. Ещё не внесённая читается с диска,
 * переезжает в документ и с этого момента живёт там: файл становится её
 * проекцией. Это односторонняя дверь, и в интерфейсе она названа открытием — то
 * есть тем, чем и является для человека.
 */
export function openBook(sessionId: string, path: string, by?: BookAuthor): OpenBookResult {
  const { doc } = getSessionDoc(sessionId)
  const known = bookAt(doc, path)
  // Уже внесённая — просто открывается: право спрашивают у того, кто ДОБАВЛЯЕТ
  // тетрадь в комнату, а не у того, кто смотрит уже добавленную.
  if (known) return { ok: true, book: known, imported: false }
  if (by) {
    const why = whyNotAddBook(sessionId, doc, by)
    if (why) return { ok: false, why }
  }
  if (kindOf(path) !== 'notebook') return { ok: false, why: tr("server.isNotANotebook.084f7a", { p0: baseOf(path) }) }

  const source = readBookText(sessionId, path)
  if ('why' in source) return { ok: false, why: source.why }
  /*
   * Пустой файл — это НОВАЯ тетрадь, а не сломанная.
   *
   * «Новый файл» в дереве заводит пустой файл; назвав его `.ipynb`, человек
   * просит тетрадь. Разбирать пустоту как JSON и отказывать было бы формально
   * верно и практически бесполезно.
   */
  const flat = source.text.trim().length === 0 ? [] : parseIpynb(source.text)
  if (flat === null) return { ok: false, why: tr("server.containsInvalidIpynbData.6292e4", { p0: baseOf(path) }) }
  if (flat.length > MAX_IMPORT_CELLS) {
    return {
      ok: false,
      why: tr("server.containsCellsTheLimitIs.0fbfa5", { p0: baseOf(path), p1: flat.length, p2: MAX_IMPORT_CELLS }),
    }
  }

  let made: Book | null = null
  /*
   * Корень — отдельной переменной, а не через `made`: проверка типов не верит,
   * что обратный вызов транзакции уже отработал, и сужает `made` до `never`
   * сразу после `if (!made) return`. Это видно и на строке ниже, где `made`
   * уезжает в ответ как есть.
   */
  let root = ''
  doc.transact(() => {
    /*
     * Корень у новой тетради свой, и из пути он больше не выводится: путь
     * освобождается — переименовали разбор, положили под тем же именем новый, —
     * и на освободившемся корне сидела чужая тетрадь.
     *
     * Проверка на пустоту осталась и осталась нужной: на занятый корень ячейки
     * файла не дописываются. Иначе одна тетрадь в комнате перестаёт быть одним
     * файлом на диске, а это единственное, на чём держится проекция.
     */
    const book = addBook(doc, path, rootForNewBook(doc))
    made = book
    root = book.root
    const cells = bookCells(doc, book.root)
    if (cells.length === 0) {
      /*
       * Картинки — на полку комнаты, а в текст ячейки ссылка на них.
       *
       * Тетрадь лекции с условиями-картинками весит мегабайты, и до этой
       * строки весь этот base64 переезжал в документ комнаты, то есть каждому
       * вошедшему и в каждый снимок (server/src/notebook-images.ts).
       */
      const shelved = flat.map((cell) => shelveCellImages(sessionId, cell))
      cells.push(
        shelved.length > 0
          ? shelved.map((cell) => createCell(cell.type, cell.source))
          : [createCell('code', '')],
      )
    }
  }, ORIGIN)
  if (!made) return { ok: false, why: tr("server.couldNotOpenTheNotebook.be7a27") }
  /*
   * Автор записывается ЗДЕСЬ, а не в дереве файлов, потому что здесь известен
   * корень: доступ к тетради живёт по корню, и другого места, где он рождается,
   * в продукте нет. Уже внесённая тетрадь сюда не доходит (возврат выше), так
   * что второй человек, открывший тот же файл, автора не переписывает.
   */
  if (by) rememberAuthor(sessionId, doc, root, by)
  schedule(sessionId)
  return { ok: true, book: made, imported: true }
}

/**
 * Прочитать файл тетради ЦЕЛИКОМ — или сказать, почему нельзя.
 *
 * `readText` бережёт редактор: файл больше полутора мегабайт он отдаёт началом
 * и ставит `truncated`. Здесь этот признак смотрели мимо, и обрезанный посреди
 * base64 JSON уходил в `parseIpynb`, тот честно возвращал `null`, а комната
 * получала «<имя> — не похоже на .ipynb» — про совершенно нормальную тетрадь с
 * картинками. Экран называл не ту причину, и обойти это изнутри комнаты было
 * нечем.
 *
 * Поэтому тетрадь читается своей мерой (`MAX_BOOK_BYTES`), а отказ по размеру
 * говорит про размер.
 */
function readBookText(sessionId: string, path: string): { text: string } | { why: string } {
  const file = readText(sessionId, path, MAX_BOOK_BYTES)
  if (!file || file.binary) return { why: tr("server.couldNotBeReadAsANotebook.03f997", { p0: baseOf(path) }) }
  if (!file.truncated) return { text: file.text }
  if (file.size > MAX_BOOK_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(0)
    return {
      why:
        tr("server.isMbExceedingTheSizeLimit.72c414", { p0: baseOf(path), p1: mb }) +
        tr("server.mbSaveTheNotebookWithoutOutputs.bf2200", { p0: MAX_BOOK_BYTES / (1024 * 1024) }),
    }
  }
  return { why: tr("server.couldNotBeReadAsANotebook.03f997", { p0: baseOf(path) }) }
}

/** Завести пустую тетрадь по этому пути: файл и запись в комнате. */
export function createBook(sessionId: string, path: string, by?: BookAuthor): OpenBookResult {
  /*
   * Право — ДО файла, а не после. `openBook` ниже спросит то же самое, но к
   * тому времени пустой .ipynb уже лежал бы на диске: отказ, оставляющий за
   * собой файл, хуже отказа.
   */
  if (by) {
    const why = whyNotAddBook(sessionId, getSessionDoc(sessionId).doc, by)
    if (why) return { ok: false, why }
  }
  if (statPath(sessionId, path)) return { ok: false, why: tr("server.alreadyExists.e348cc", { p0: baseOf(path) }) }
  const made = makeFile(sessionId, path, writeIpynb([]))
  if (made !== 'ok') return { ok: false, why: tr("server.couldNotCreate.0cfbaa", { p0: baseOf(path) }) }
  return openBook(sessionId, path, by)
}

/**
 * Что переехало вместе с этим путём: сам файл и всё, что лежало под ним.
 *
 * Переименовывают и убирают не только файлы, но и ПАПКИ, а тетрадь внутри
 * папки сверялась по точному пути и оставалась в комнате со старым: проекция
 * через полторы секунды писала её обратно — вместе с папкой, которую только что
 * убрали, — а вкладка правила призрак по адресу, которого на диске нет.
 */
function booksUnder(doc: Y.Doc, path: string): string[] {
  return allBooks(doc)
    .map(({ book }) => book.path)
    .filter((known) => isInside(known, path))
}

/** Тетрадь переехала вместе с файлом — или с папкой, в которой лежала. */
export function moveBook(sessionId: string, from: string, to: string): void {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return
  const moved = booksUnder(doc, from)
  if (moved.length === 0) return
  doc.transact(() => {
    for (const path of moved) renameBook(doc, path, to + path.slice(from.length))
  }, ORIGIN)
  schedule(sessionId)
}

/** Файла больше нет — и тетради тоже. Папки — со всеми тетрадями внутри. */
export function dropBook(sessionId: string, path: string): void {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return
  const gone = booksUnder(doc, path)
  if (gone.length === 0) return
  doc.transact(() => {
    for (const known of gone) removeBook(doc, known)
  }, ORIGIN)
  forgetBookRules(sessionId, doc)
}

/**
 * Тетрадь ли это в этой комнате.
 *
 * По списку комнаты, а не по расширению: .ipynb, который просто лежит в папке и
 * ещё не открывали, — обычный файл, и записывать поверх него можно.
 */
export function isBookFile(sessionId: string, path: string): boolean {
  const doc = peekSessionDoc(sessionId)?.doc
  return doc ? bookAt(doc, path) !== null : false
}

/**
 * Тетради, чьи файлы кто-то убрал мимо дерева, — например `os.remove` в ячейке.
 *
 * Возвращает пути, которых не стало. Комната узнаёт об этом одним сообщением о
 * списке файлов; вкладки закрываются сами, потому что файла в списке нет.
 */
export function forgetMissingBooks(sessionId: string): string[] {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return []
  /*
   * Каждый путь проверяется отдельно, а не ищется в дереве.
   *
   * `listFiles` — это то, что рисует панель: обход в глубину с потолком в две
   * тысячи записей и ограничением по глубине. Тетрадь, не влезшая в потолок,
   * из списка выпадает, а файл на диске лежит — и комната убирала бы живую
   * тетрадь у всех. Один `lstat` на тетрадь, а их в комнате единицы.
   */
  const missing = allBooks(doc)
    .map(({ book }) => book)
    .filter((book) => statPath(sessionId, book.path)?.dir !== false)
  if (missing.length === 0) return []

  /*
   * Тетрадь КОМНАТЫ из списка не убирается — её файл пишется заново.
   *
   * Эта проверка идёт после каждого прогона ячейки, а убрать тетрадь комнаты
   * значит стереть её ячейки (`removeBook` делает это только у её корня —
   * единственного, который умеет вернуть история). `os.remove('Тетрадь.ipynb')`
   * в чьей-нибудь ячейке — не согласие комнаты расстаться с тем, что она весь
   * час пишет: файл здесь проекция, и проекция восстанавливается.
   *
   * Убрать тетрадь комнаты по-прежнему можно — щелчком по файлу в дереве, и
   * это `dropBook`, то есть сказанное вслух.
   */
  const gone = missing.filter((book) => book.root !== CELLS_KEY).map((book) => book.path)
  if (gone.length > 0) {
    doc.transact(() => {
      for (const path of gone) removeBook(doc, path)
    }, ORIGIN)
    forgetBookRules(sessionId, doc)
  }
  if (gone.length < missing.length) schedule(sessionId)
  return gone
}

/**
 * Снять записи о доступе с тетрадей, которых в комнате больше нет.
 *
 * Тетрадь убрали — вместе с ней уходит и «личная тетрадь Акима»: корень `nb:`
 * второй раз не выдаётся (shared/notebook.ts · rootForNewBook), так что
 * оставленная запись не досталась бы никому, а просто лежала бы в базе и ехала
 * бы в каждый сокет комнаты до конца семестра.
 *
 * Молча, когда снимать нечего: `setRules` — это запись в SQLite и сброс кэша
 * правил, а `dropBook` зовут и с обычного файла, и с папки.
 */
function forgetBookRules(sessionId: string, doc: Y.Doc): void {
  const stored = storedRules(sessionId)
  if (!stored.books) return
  const live = liveBookRules(doc, stored.books)
  if (Object.keys(live).length === Object.keys(stored.books).length) return
  setRules(sessionId, { ...stored, books: live })
  rulesChanged?.(sessionId)
}

/** Текст ячеек тетради — для оракула и для всего, что читает её как текст. */
export function bookText(sessionId: string, path: string): string | null {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return null
  const book = bookAt(doc, path)
  if (!book) return null
  return writeIpynb(flatten(bookCells(doc, book.root)))
}
