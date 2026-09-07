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
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { listFiles, readText, sessionDir } from '../server/src/workspace.js'
import { dropSessionDoc, getSessionDoc, peekSessionDoc } from '../server/src/collab/index.js'
import { restoreInto } from '../server/src/collab/history.js'
import {
  bookText,
  createBook,
  dropBook,
  isBookFile,
  moveBook,
  forgetMissingBooks,
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
  ensureInitialNotebook,
  findCell,
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
})

test('в файл тетради не уезжают выводы, сколько бы их ни было в комнате', () => {
  /*
   * Файл — ИСХОДНИК тетради, а не её снимок (см. shared/ipynb.ts): с выводами
   * он весит мегабайты base64, и эти мегабайты потом едут загрузкой, в контекст
   * оракула и на GitHub.
   *
   * Проверка здесь была тавтологией: `!text.includes('"outputs":[') ||
   * !text.includes('image/png')` — вторая половина истинна для стартовой
   * тетради при любом содержимом файла, так что выражение не падало никогда.
   * Теперь вывод в комнате есть, и его отсутствие в файле — настоящий факт.
   */
  const { doc } = getSessionDoc(ROOM)
  const cell = getCells(doc).get(1)
  const base64 = 'iVBORw0KGgo' + 'A'.repeat(4096)
  doc.transact(() => {
    const png = new Y.Map<unknown>()
    png.set('kind', 'data')
    png.set('json', JSON.stringify({ data: { 'image/png': base64 }, execCount: 3 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([png])
    cell.set('execCount', 3)
  }, 'server')
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 1, 'вывод не лёг в документ')

  projectBooks(ROOM)
  const text = readText(ROOM, 'Тетрадь.ipynb')?.text ?? ''
  const written = JSON.parse(text) as { cells: { outputs?: unknown[] }[] }
  assert.ok(written.cells.length > 0, 'в файле не осталось ячеек')
  for (const [i, inFile] of written.cells.entries()) {
    assert.deepEqual(inFile.outputs ?? [], [], `в файл уехал вывод ячейки ${i}`)
  }
  // И то же самое строкой: набор ключей мог бы совпасть, а картинка приехать
  // где-нибудь в метаданных.
  assert.ok(!text.includes('image/png'), 'mime вывода уехал в файл')
  assert.ok(!text.includes(base64.slice(0, 64)), 'base64 вывода уехал в файл')

  // Тот же файл, взятый напрямую из комнаты (оракул и выгрузка ходят сюда).
  const direct = bookText(ROOM, 'Тетрадь.ipynb') ?? ''
  assert.ok(!direct.includes('image/png'), 'вывод уехал в текст тетради для оракула')
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

test('убранная тетрадь не возвращается сама', () => {
  /*
   * Комната, где тетрадь убрали намеренно, при следующем открытии получала её
   * обратно вместе со всеми ячейками: список пуст — значит, надо завести, — и
   * удаление отменялось само, стоило перезапустить сервер.
   */
  const { doc } = getSessionDoc(ROOM)
  const before = allBooks(doc).length
  dropBook(ROOM, 'прошлая.ipynb')
  ensureInitialNotebook(doc, 'Тетради')
  assert.equal(allBooks(doc).length, before - 1, 'тетрадь воскресла')
  assert.equal(bookAt(doc, 'прошлая.ipynb'), null)
})

test('убранная тетрадь перестаёт быть видна комнате, но её ячейки не стираются', () => {
  /*
   * Из списка — и этого довольно: и `allBooks`, и `findCell` ходят по списку,
   * так что брошенный корень не читается больше ничем. А стирать нечем вернуть:
   * история версий есть только у тетради комнаты, и один щелчок по файлу в
   * дереве — в том числе случайный — уносил бы час работы пары навсегда.
   */
  const { doc } = getSessionDoc(ROOM)
  const flat = writeIpynb([{ type: 'code', source: 'останется_ли = True\n' }])
  fs.writeFileSync(path.join(sessionDir(ROOM), 'на-выброс.ipynb'), flat)
  const opened = openBook(ROOM, 'на-выброс.ipynb')
  assert.ok(opened.ok)
  const root = opened.book.root
  assert.equal(bookCells(doc, root).length, 1)
  const id = bookCells(doc, root).get(0).get('id') as string

  dropBook(ROOM, 'на-выброс.ipynb')
  assert.equal(bookAt(doc, 'на-выброс.ipynb'), null, 'тетрадь осталась в списке')
  assert.equal(findCell(doc, id), null, 'ячейки убранной тетради всё ещё видны комнате')
  assert.equal(bookCells(doc, root).length, 1, 'ячейки стёрты, а вернуть их нечем')
})

test('новая тетрадь на освободившемся пути не садится на чужой корень', () => {
  /*
   * Корень выводился из пути. Переименовать разбор в архивный и положить на
   * прежнее имя новый файл — обычная привычка, и корень у обеих выходил один:
   * загруженный файл не читался вовсе, правки шли в обе вкладки, а убрать
   * «лишнюю» значило опустошить обе.
   */
  const id = 'books-roots'
  createSession(id, 'Корни', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'Корни')

  createBook(id, 'разбор.ipynb')
  const first = bookAt(doc, 'разбор.ipynb')!
  doc.transact(() => bookCells(doc, first.root).push([createCell('code', 'ПРОШЛОЕ = 1')]))
  moveBook(id, 'разбор.ipynb', 'разбор-v1.ipynb')

  fs.writeFileSync(
    path.join(sessionDir(id), 'разбор.ipynb'),
    writeIpynb([{ type: 'code', source: 'НОВОЕ = 2\n' }]),
  )
  const opened = openBook(id, 'разбор.ipynb')
  assert.ok(opened.ok && opened.imported)
  assert.notEqual(opened.book.root, first.root, 'две тетради сели на один корень')
  const sources = bookCells(doc, opened.book.root)
    .toArray()
    .map((cell) => cellSource(cell).toString())
  assert.deepEqual(sources, ['НОВОЕ = 2\n'], 'загруженный файл не прочитан')

  // И убрать одну — не значит опустошить другую.
  dropBook(id, 'разбор.ipynb')
  assert.ok(
    bookCells(doc, first.root)
      .toArray()
      .some((cell) => cellSource(cell).toString() === 'ПРОШЛОЕ = 1'),
    'архивная тетрадь опустела вместе с той, что убрали',
  )
})

test('папка переезжает вместе с тетрадями внутри', () => {
  /*
   * `tree:move` работает и с папками, а тетрадь внутри сверялась по точному
   * пути и оставалась со старым: проекция через полторы секунды писала её
   * обратно вместе с папкой, которую только что убрали.
   */
  const id = 'books-folder'
  createSession(id, 'Папки', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'Папки')
  createBook(id, 'семинары/разбор.ipynb')
  const root = bookAt(doc, 'семинары/разбор.ipynb')!.root

  moveBook(id, 'семинары', 'архив')
  assert.equal(bookAt(doc, 'семинары/разбор.ipynb'), null, 'тетрадь осталась на старом пути')
  assert.equal(bookAt(doc, 'архив/разбор.ipynb')?.root, root, 'тетрадь не переехала с папкой')

  dropBook(id, 'архив')
  assert.equal(bookAt(doc, 'архив/разбор.ipynb'), null, 'убранная папка оставила тетрадь в комнате')
})

test('тетрадь, не влезшую в дерево, комната не забывает', () => {
  /*
   * `listFiles` — это то, что рисует панель: у неё потолок в две тысячи
   * записей. Тетрадь, не попавшая в список, с диска никуда не делась, а
   * комната убирала её у всех. Проверяется каждый путь отдельно.
   */
  const id = 'books-crowded'
  createSession(id, 'Толпа', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'Толпа')
  projectBooks(id)
  assert.ok(bookAt(doc, 'Тетрадь.ipynb'), 'тетради комнаты нет')

  const dir = sessionDir(id)
  for (let i = 0; i < 2100; i += 1) {
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(5, '0')}.txt`), 'x')
  }
  assert.equal(listFiles(id).length, 2000, 'потолок дерева изменился — тест больше ни о чём')

  assert.deepEqual(forgetMissingBooks(id), [], 'живую тетрадь убрали из комнаты')
  assert.ok(bookAt(doc, 'Тетрадь.ipynb'), 'тетрадь комнаты исчезла')

  // А ту, чей файл и правда убрали мимо дерева, — забывает.
  fs.writeFileSync(
    path.join(dir, 'разбор.ipynb'),
    writeIpynb([{ type: 'code', source: 'x = 1\n' }]),
  )
  openBook(id, 'разбор.ipynb')
  fs.rmSync(path.join(dir, 'разбор.ipynb'))
  assert.deepEqual(forgetMissingBooks(id), ['разбор.ipynb'])
  assert.equal(bookAt(doc, 'разбор.ipynb'), null)
})

test('тетрадь комнаты не убирает из неё os.remove в ячейке', () => {
  /*
   * Проверка на пропавшие файлы идёт после КАЖДОГО прогона ячейки, а убрать
   * тетрадь комнаты — значит стереть её ячейки. `os.remove('Тетрадь.ipynb')`
   * в чьей-нибудь ячейке — не согласие комнаты расстаться с тем, что она весь
   * час пишет: файл здесь проекция, и проекция возвращается.
   */
  const id = 'books-selfremove'
  createSession(id, 'Уборка', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'Уборка')
  projectBooks(id)
  const file = path.join(sessionDir(id), 'Тетрадь.ipynb')
  assert.ok(fs.existsSync(file))
  const cells = bookCells(doc, 'cells').length
  assert.ok(cells > 0)

  fs.rmSync(file)
  assert.deepEqual(forgetMissingBooks(id), [], 'тетрадь комнаты убрали из комнаты')
  assert.ok(bookAt(doc, 'Тетрадь.ipynb'), 'тетрадь комнаты исчезла из списка')
  assert.equal(bookCells(doc, 'cells').length, cells, 'ячейки комнаты стёрты')

  projectBooks(id)
  assert.ok(fs.existsSync(file), 'файл тетради не вернулся на диск')
})

test('возврат версии не вписывает историю в чужую тетрадь', () => {
  /*
   * История комнаты — про её тетрадь, и корень у неё прибит. Разница видна
   * ровно в одном случае и стоит дорого: тетрадь комнаты убрали, первой в
   * списке стала другая — и возврат версии вписал бы в неё ячейки чужого листа.
   */
  const id = 'books-history'
  createSession(id, 'История', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'История')
  const roomBook = bookAt(doc, 'Тетрадь.ipynb')!
  assert.equal(roomBook.root, 'cells')

  createBook(id, 'вторая.ipynb')
  const second = bookAt(doc, 'вторая.ipynb')!
  doc.transact(() => bookCells(doc, second.root).push([createCell('code', 'своё = 1')]))

  dropBook(id, 'Тетрадь.ipynb')
  assert.equal(allBooks(doc)[0].book.root, second.root, 'первой стала вторая тетрадь')

  // Возврат к версии, где у комнаты была своя тетрадь: ячейки обязаны лечь в
  // неё же, а не в ту, что оказалась первой.
  restoreInto(id, doc, 1, null, null)
  const restored = allBooks(doc).find((entry) => entry.book.root === 'cells')
  assert.ok(restored, 'тетрадь комнаты не вернулась')
  const inSecond = bookCells(doc, second.root)
    .toArray()
    .map((cell) => cellSource(cell).toString())
  assert.ok(inSecond.includes('своё = 1'), 'вторая тетрадь потеряла своё')
  assert.ok(
    !inSecond.some((source) => source.includes('hello, seminar')),
    'в чужую тетрадь вписали ячейки комнаты',
  )
})

test('закрытая комната не воскресает от отложенной работы', () => {
  /*
   * Запись файла тетради отложена на полторы секунды, и за это время комнату
   * могли закрыть — удалить семинар, остановить процесс. Отложенная работа
   * звала `getSessionDoc`, тот честно строил комнату заново из снимка, новая
   * комната заводила себе таймеры, и следующая отложенная работа строила её
   * опять: процесс переставал завершаться, а удалённая комната возвращалась.
   */
  const id = 'books-ghost'
  createSession(id, 'Призрак', null)
  getSessionDoc(id)
  dropSessionDoc(id)
  assert.equal(peekSessionDoc(id), null)

  projectBooks(id)
  forgetMissingBooks(id)
  moveBook(id, 'Тетрадь.ipynb', 'другая.ipynb')
  dropBook(id, 'Тетрадь.ipynb')
  assert.equal(peekSessionDoc(id), null, 'комната вернулась в память сама собой')
})
