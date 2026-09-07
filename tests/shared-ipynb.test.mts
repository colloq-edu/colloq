/**
 * Заготовка преподавателя переживает импорт.
 *
 * Учебная тетрадь состоит из пустых ячеек наполовину: «# Задание 1 → пустая
 * ячейка под ответ → # Задание 2 → …». Разбор выбрасывал их ВСЕ, а обещал
 * выбрасывать только хвостовые — и в комнату приезжали одни условия. Молча:
 * предпросмотр импорта показывает уже урезанное число, а в лекции
 * (structure: host) завести ячейку обратно студенту нечем.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIpynb, readIpynb, writeIpynb } from '../shared/ipynb.js'

/** Тетрадь-заготовка ровно того вида, какой раздают классу. */
function worksheet(): unknown {
  return {
    cells: [
      { cell_type: 'markdown', source: '# Задание 1\n' },
      { cell_type: 'code', source: '' },
      { cell_type: 'markdown', source: '# Задание 2\n' },
      { cell_type: 'code', source: '\n  \n' },
      { cell_type: 'markdown', source: '# Задание 3\n' },
      { cell_type: 'code', source: '' },
    ],
  }
}

test('пустые ячейки под ответ доезжают до комнаты', () => {
  const cells = readIpynb(worksheet())
  assert.equal(cells.length, 5, 'ячейки под ответ выброшены из заготовки')
  assert.deepEqual(
    cells.map((cell) => cell.type),
    ['markdown', 'code', 'markdown', 'code', 'markdown'],
  )
  // И пустые — именно пустые: ничего не подставляется вместо текста.
  assert.equal(cells[1].source, '')
  assert.equal(cells[3].source, '\n  \n')
})

test('пустая ячейка в конце — след редактора, и её по-прежнему нет', () => {
  const cells = readIpynb({
    cells: [
      { cell_type: 'code', source: 'x = 1' },
      { cell_type: 'code', source: '' },
      { cell_type: 'code', source: '\n  \n' },
    ],
  })
  assert.equal(cells.length, 1, 'хвост из пустых ячеек уехал в комнату')
})

test('тетрадь из одних пустых ячеек — это по-прежнему ничего', () => {
  // На этом держится отказ импорта: «в этой тетради нет ячеек с содержимым».
  assert.deepEqual(readIpynb({ cells: [{ cell_type: 'code', source: '   ' }] }), [])
  assert.deepEqual(readIpynb({ cells: [] }), [])
})

test('заготовка переживает круг через файл', () => {
  /*
   * Тетради комнаты лежат на диске файлами, и записывает их этот же модуль.
   * Круг «прочитать → записать → прочитать» — ровно то, что происходит с
   * заготовкой, открытой в комнате и спроецированной обратно в файл.
   */
  const once = readIpynb(worksheet())
  const twice = parseIpynb(writeIpynb(once))
  assert.deepEqual(twice, once, 'круг через файл потерял ячейки под ответ')
})

/**
 * Схема 4.5 требует `id` у каждой ячейки, и требует его от ОБОИХ пишущих.
 *
 * Пишущих было два: выгрузка публикации (publish/notebook.ts) ставила `id`, а
 * проекция тетрадей комнаты на диск — нет, при том что `nbformat_minor: 5`
 * объявляли обе. Файл из комнаты `nbformat.validate` не проходил, а
 * `nbformat.read` дописывал ему свои имена — то есть студент, открывший свою же
 * тетрадь у себя, получал предупреждение и чужие идентификаторы. Пишет теперь
 * один `writeIpynb`, и правило у него одно.
 */
test('в записанном .ipynb у каждой ячейки есть id', () => {
  const notebook = JSON.parse(
    writeIpynb([
      { id: 'c_ok', type: 'code', source: 'x = 1\n' },
      { id: 'плохой id', type: 'markdown', source: '# Заголовок\n' },
      { type: 'code', source: 'y = 2\n' },
    ]),
  ) as { nbformat_minor: number; cells: { id: string }[] }
  assert.equal(notebook.nbformat_minor, 5)
  // Своё имя, если оно годится схеме; порядковый номер — если нет или если его
  // не донесли вовсе.
  assert.deepEqual(
    notebook.cells.map((cell) => cell.id),
    ['c_ok', 'cell-2', 'cell-3'],
  )
  for (const cell of notebook.cells) assert.match(cell.id, /^[a-zA-Z0-9-_]{1,64}$/)
})
