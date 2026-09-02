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
  bookAt,
  bookCells,
  CELLS_KEY,
  createCell,
  readCell,
  removeBook,
  renameBook,
  rootForNewBook,
  type Book,
} from '@shared/notebook'
import { parseIpynb, writeIpynb } from '@shared/ipynb'
import { baseOf, isInside, kindOf } from '@shared/paths'
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

const pending = new Map<string, NodeJS.Timeout>()

/** Плоские ячейки тетради — то, что уходит в файл. */
function flatten(cells: Y.Array<any>): { type: 'code' | 'markdown'; source: string }[] {
  return cells.map((cell) => {
    const read = readCell(cell)
    return { type: read.type, source: read.source }
  })
}

/**
 * Переписать файлы всех тетрадей комнаты.
 *
 * Все, а не одну изменившуюся: сравнение с тем, что уже на диске, стоит дешевле
 * разбора события, а тетрадей в комнате единицы. Файл, который не поменялся, не
 * переписывается — иначе время изменения дёргалось бы на каждое нажатие и
 * панель файлов моргала бы всю пару.
 */
export function projectBooks(sessionId: string): void {
  // Заглянуть, а не завести: комнату могли закрыть, пока таймер ждал, и
  // строить её заново ради записи файла — значит воскрешать удалённое.
  const open = peekSessionDoc(sessionId)
  if (!open) return
  const { doc } = open
  for (const { book, cells } of allBooks(doc)) {
    const text = writeIpynb(flatten(cells))
    const now = readText(sessionId, book.path)
    if (now && !now.binary && now.text === text) continue
    writeText(sessionId, book.path, text)
  }
}

function schedule(sessionId: string): void {
  if (pending.has(sessionId)) return
  const timer = setTimeout(() => {
    pending.delete(sessionId)
    try {
      projectBooks(sessionId)
      filesChanged?.(sessionId)
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
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    // Своя же проекция сюда не возвращается: она пишет на диск, а не в
    // документ. Origin проверяется ради другого — записи ядра (вывод ячейки) в
    // файл не идут вовсе, потому что выводов в файле нет.
    if (origin === PROJECTION) return
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

const PROJECTION = 'projection'

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
export function openBook(sessionId: string, path: string): OpenBookResult {
  const { doc } = getSessionDoc(sessionId)
  const known = bookAt(doc, path)
  if (known) return { ok: true, book: known, imported: false }
  if (kindOf(path) !== 'notebook') return { ok: false, why: `${baseOf(path)} — не тетрадь.` }

  const file = readText(sessionId, path)
  if (!file || file.binary) return { ok: false, why: `${baseOf(path)} не читается как тетрадь.` }
  /*
   * Пустой файл — это НОВАЯ тетрадь, а не сломанная.
   *
   * «Новый файл» в дереве заводит пустой файл; назвав его `.ipynb`, человек
   * просит тетрадь. Разбирать пустоту как JSON и отказывать было бы формально
   * верно и практически бесполезно.
   */
  const flat = file.text.trim().length === 0 ? [] : parseIpynb(file.text)
  if (flat === null) return { ok: false, why: `${baseOf(path)} — не похоже на .ipynb.` }
  if (flat.length > MAX_IMPORT_CELLS) {
    return {
      ok: false,
      why: `В ${baseOf(path)} ${flat.length} ячеек — это больше, чем комната потянет (${MAX_IMPORT_CELLS}).`,
    }
  }

  let made: Book | null = null
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
    const cells = bookCells(doc, book.root)
    if (cells.length === 0) {
      cells.push(
        flat.length > 0
          ? flat.map((cell) => createCell(cell.type, cell.source))
          : [createCell('code', '')],
      )
    }
  }, ORIGIN)
  if (!made) return { ok: false, why: 'Не удалось открыть тетрадь.' }
  schedule(sessionId)
  return { ok: true, book: made, imported: true }
}

/** Завести пустую тетрадь по этому пути: файл и запись в комнате. */
export function createBook(sessionId: string, path: string): OpenBookResult {
  if (statPath(sessionId, path)) return { ok: false, why: `${baseOf(path)} уже есть.` }
  const made = makeFile(sessionId, path, writeIpynb([]))
  if (made !== 'ok') return { ok: false, why: `Не удалось завести ${baseOf(path)}.` }
  return openBook(sessionId, path)
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
  }
  if (gone.length < missing.length) schedule(sessionId)
  return gone
}

/** Текст ячеек тетради — для оракула и для всего, что читает её как текст. */
export function bookText(sessionId: string, path: string): string | null {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return null
  const book = bookAt(doc, path)
  if (!book) return null
  return writeIpynb(flatten(bookCells(doc, book.root)))
}
