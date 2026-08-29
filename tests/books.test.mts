/**
 * Тетради стали файлами, и вот стык, на котором это держится.
 *
 * Документ — правда, файл — проекция. Всё, что ниже, ломается тихо: тетрадь,
 * не доехавшая до диска, невидима в дереве; тетрадь, прочитанная обратно с
 * диска, теряет имена ячеек и чужие курсоры; тетрадь, которую переписали
 * загрузкой, возвращает своё через секунду и выглядит как пропажа.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSession } from '../server/src/db.js'
import { listFiles, readText, sessionDir } from '../server/src/workspace.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import {
  bookText,
  createBook,
  dropBook,
  isBookFile,
  moveBook,
  openBook,
  projectBooks,
} from '../server/src/collab/books.js'
import { parseIpynb, writeIpynb } from '../shared/ipynb.js'
import {
  allBooks,
  bookAt,
  bookCells,
  cellSource,
  createCell,
  getCells,
} from '../shared/notebook.js'

const ROOM = 'books-room'

test('у новой комнаты одна тетрадь, и она лежит в папке файлом', () => {
  createSession(ROOM, 'Тетради', null)
  const { doc } = getSessionDoc(ROOM)
  const books = allBooks(doc)
  assert.equal(books.length, 1)
  assert.equal(books[0].book.path, 'Тетрадь.ipynb')
  // Корень первой тетради остался прежним: в нём вся история и весь кеш у тех,
  // кто уже в комнате.
  assert.equal(books[0].book.root, 'cells')

  projectBooks(ROOM)
  const listed = listFiles(ROOM).map((entry) => entry.path)
  assert.ok(listed.includes('Тетрадь.ipynb'), 'тетради нет в дереве')
})

test('файл тетради — настоящий .ipynb, который читается обратно', () => {
  projectBooks(ROOM)
  const text = readText(ROOM, 'Тетрадь.ipynb')?.text ?? ''
  const flat = parseIpynb(text)
  assert.ok(flat, 'то, что записали, не разбирается как тетрадь')
  assert.equal(flat.length, 2, 'стартовые ячейки не доехали до файла')
  assert.equal(flat[0].type, 'markdown')
  // Выводов в файле нет намеренно: он исходник тетради, а не её снимок.
  assert.ok(!text.includes('"outputs": ['.replace(' ', '')) || !text.includes('image/png'))
})

test('правка тетради доезжает до файла', () => {
  const { doc } = getSessionDoc(ROOM)
  const cells = getCells(doc)
  doc.transact(() => cellSource(cells.get(1)).insert(0, '# добавлено\n'))
  projectBooks(ROOM)
  assert.match(readText(ROOM, 'Тетрадь.ipynb')?.text ?? '', /# добавлено/)
})

test('вторая тетрадь заводится рядом и получает свой корень', () => {
  const made = createBook(ROOM, 'разбор.ipynb')
  assert.ok(made.ok && made.book.root !== 'cells')
  const { doc } = getSessionDoc(ROOM)
  assert.equal(allBooks(doc).length, 2)
  // И это разные листы: ячейка одной не появляется в другой.
  const second = bookAt(doc, 'разбор.ipynb')!
  doc.transact(() => bookCells(doc, second.root).push([createCell('code', 'x = 1')]))
  assert.ok(
    !getCells(doc)
      .toArray()
      .some((cell) => cellSource(cell).toString() === 'x = 1'),
  )
})

test('чужой .ipynb вносится в комнату со своими ячейками', () => {
  const dropped = writeIpynb([
    { type: 'markdown', source: '# Прошлая пара\n' },
    { type: 'code', source: 'import pandas as pd\n' },
  ])
  fs.writeFileSync(path.join(sessionDir(ROOM), 'прошлая.ipynb'), dropped)

  const opened = openBook(ROOM, 'прошлая.ipynb')
  assert.ok(opened.ok && opened.imported)
  const { doc } = getSessionDoc(ROOM)
  const book = bookAt(doc, 'прошлая.ipynb')!
  const sources = bookCells(doc, book.root)
    .toArray()
    .map((cell) => cellSource(cell).toString())
  assert.deepEqual(sources, ['# Прошлая пара\n', 'import pandas as pd\n'])
})

test('повторное открытие не вносит тетрадь второй раз', () => {
  const again = openBook(ROOM, 'прошлая.ipynb')
  assert.ok(again.ok && !again.imported, 'ячейки удвоились бы')
  assert.equal(allBooks(getSessionDoc(ROOM).doc).length, 3)
})

test('не тетрадь тетрадью не открывается', () => {
  fs.writeFileSync(path.join(sessionDir(ROOM), 'сломанная.ipynb'), 'это не json')
  const tried = openBook(ROOM, 'сломанная.ipynb')
  assert.ok(!tried.ok)
  assert.match(tried.why, /не похоже/)
})

test('пустой файл .ipynb — это новая тетрадь, а не сломанная', () => {
  // «Новый файл» в дереве заводит пустой файл; названный .ipynb, он просьба о
  // тетради, и отказывать на нём формально верно и бесполезно.
  fs.writeFileSync(path.join(sessionDir(ROOM), 'пустая.ipynb'), '')
  const opened = openBook(ROOM, 'пустая.ipynb')
  assert.ok(opened.ok)
  assert.equal(bookCells(getSessionDoc(ROOM).doc, opened.book.root).length, 1)
})

test('тетрадь переезжает вместе с файлом и не теряет ячейки', () => {
  const { doc } = getSessionDoc(ROOM)
  const before = bookAt(doc, 'разбор.ipynb')!.root
  moveBook(ROOM, 'разбор.ipynb', 'семинары/разбор.ipynb')
  const after = bookAt(doc, 'семинары/разбор.ipynb')
  assert.ok(after, 'тетрадь потерялась при переименовании')
  assert.equal(after.root, before, 'корень сменился — ячейки уехали бы вместе с ним')
  assert.equal(bookAt(doc, 'разбор.ipynb'), null)
})

test('убранная тетрадь перестаёт быть тетрадью', () => {
  dropBook(ROOM, 'пустая.ipynb')
  assert.equal(bookAt(getSessionDoc(ROOM).doc, 'пустая.ipynb'), null)
  assert.equal(isBookFile(ROOM, 'пустая.ipynb'), false)
})

test('поверх тетради не пишут: об этом знает и загрузка, и оракул', () => {
  assert.equal(isBookFile(ROOM, 'Тетрадь.ipynb'), true)
  assert.equal(isBookFile(ROOM, 'прошлая.ipynb'), true)
  // Обычный .ipynb, который просто лежит в папке, тетрадью не считается —
  // записывать поверх него можно.
  fs.writeFileSync(path.join(sessionDir(ROOM), 'просто.ipynb'), writeIpynb([]))
  assert.equal(isBookFile(ROOM, 'просто.ipynb'), false)
})

test('текст тетради берут из комнаты, а не с отставшего файла', () => {
  const { doc } = getSessionDoc(ROOM)
  doc.transact(() => getCells(doc).push([createCell('code', 'только_что = True')]))
  // Файл ещё не переписан — проекция отложена, — а оракулу нужно то, что в
  // комнате прямо сейчас.
  assert.match(bookText(ROOM, 'Тетрадь.ipynb') ?? '', /только_что/)
})
