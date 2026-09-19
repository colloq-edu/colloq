/**
 * The notebook as a document people rearrange while other people are in it.
 *
 * Y.Array has no move, so a cell is moved by cloning it and deleting the
 * original. Everything the cell was carrying has to come along — the outputs
 * were being left behind, so a cell that had just printed a number arrived at
 * its new position still claiming to have run as [3] with nothing under it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { CELLS_KEY, cellOutputs, cellSource, createCell, getCells } from '../shared/notebook.js'
import {
  deleteCell,
  hasPendingRun,
  insertCellAfter,
  setCellType,
} from '../web/src/lib/notebook-ops.js'
/*
 * Перестановка делается на сервере, а не в браузере: клон соседа несёт её
 * вывод, а запись вывода из браузера закрыта в любой комнате. Свойства
 * перестановки от переезда не изменились, и проверяются они здесь же.
 */
import { moveInCells, resetRetyped } from '../server/src/collab/ops.js'

function notebook(sources: string[]) {
  const doc = new Y.Doc()
  const cells = getCells(doc)
  const made = sources.map((source) => createCell('code', source))
  doc.transact(() => cells.push(made))
  return { doc, cells, made, ids: made.map((c) => c.get('id') as string) }
}

function printed(cell: Y.Map<unknown>, text: string): void {
  const output = new Y.Map<unknown>()
  output.set('kind', 'stream')
  output.set('name', 'stdout')
  const body = new Y.Text()
  body.insert(0, text)
  output.set('text', body)
  cellOutputs(cell as never).push([output as never])
}

const order = (cells: Y.Array<Y.Map<unknown>>) =>
  cells.toArray().map((c) => cellSource(c as never).toString())

/* ------------------------------------------------------------------ moving */

test('a cell keeps what it printed when it moves', () => {
  const { doc, cells, made, ids } = notebook(['a = 1', 'b = 2'])
  doc.transact(() => {
    made[0].set('state', 'ok')
    made[0].set('execCount', 3)
    made[0].set('runBy', 'Maria')
    made[0].set('runById', 'p_maria')
  })
  printed(made[0], '42\n')

  moveInCells(doc, ids[0], 1)
  const moved = cells.toArray().find((c) => (c.get('id') as string) === ids[0])!
  assert.equal(order(cells).join(','), 'b = 2,a = 1', 'the cell did not move')
  const outputs = moved.get('outputs') as Y.Array<Y.Map<unknown>>
  assert.equal(outputs.length, 1, 'the output was left behind')
  assert.equal((outputs.get(0).get('text') as Y.Text).toString(), '42\n')
  // And the claim on the cell still matches what is under it.
  assert.equal(moved.get('state'), 'ok')
  assert.equal(moved.get('execCount'), 3)
  assert.equal(moved.get('runBy'), 'Maria')
  assert.equal(moved.get('runById'), 'p_maria', 'the run lost its owner')
})

test('the copied output is a copy, not the same object twice', () => {
  const { doc, cells, made, ids } = notebook(['x', 'y'])
  printed(made[0], 'before\n')
  moveInCells(doc, ids[0], 1)
  const moved = cells.toArray().find((c) => (c.get('id') as string) === ids[0])!
  const text = (moved.get('outputs') as Y.Array<Y.Map<unknown>>).get(0).get('text') as Y.Text
  text.insert(text.length, 'after\n')
  assert.equal(text.toString(), 'before\nafter\n')
})

test('a move at the edge of the notebook does nothing', () => {
  const { doc, cells, ids } = notebook(['one', 'two'])
  moveInCells(doc, ids[0], -1)
  moveInCells(doc, ids[1], 1)
  assert.deepEqual(order(cells), ['one', 'two'])
})

/* ---------------------------------------------------------------- the rest */

test('the notebook is never left with nothing in it', () => {
  const { doc, cells, ids } = notebook(['only one'])
  deleteCell(doc, ids[0])
  assert.equal(cells.length, 1, 'the room was left staring at an empty page')
  assert.equal(cellSource(cells.get(0) as never).toString(), '')
})

test('ставшая текстом ячейка теряет вывод — но гасит его сервер', () => {
  /*
   * Две половины одного действия. Браузер пишет только вид: пока он гасил
   * здесь состояние выполнения, правило «вывод и состояние пишет только
   * сервер» имело исключение — то есть не было правилом. Секундомер и вывод
   * гасит сервер, увидев принятую смену вида.
   */
  const { doc, cells, made, ids } = notebook(['print(1)'])
  doc.transact(() => {
    made[0].set('state', 'ok')
    made[0].set('execCount', 7)
  })
  printed(made[0], '1\n')

  setCellType(doc, ids[0], 'markdown')
  const cell = cells.get(0)
  assert.equal(cell.get('type'), 'markdown')
  assert.equal(
    (cell.get('outputs') as Y.Array<unknown>).length,
    1,
    'браузер сам погасил вывод — значит по-прежнему пишет серверные поля',
  )

  doc.transact(() => resetRetyped(doc, [ids[0]]))
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 0)
  assert.equal(cell.get('execCount'), null)
  assert.equal(cell.get('state'), 'idle')
})

test('сервер не гасит выполнение у ячейки, оставшейся кодом', () => {
  // Ячейка, которую сделали текстом и тут же вернули обратно, за один круг: имя
  // в списке есть, а вид уже снова 'code' — гасить нечего.
  const { doc, cells, made, ids } = notebook(['print(1)'])
  doc.transact(() => made[0].set('state', 'ok'))
  printed(made[0], '1\n')
  doc.transact(() => resetRetyped(doc, [ids[0]]))
  assert.equal((cells.get(0).get('outputs') as Y.Array<unknown>).length, 1)
  assert.equal(cells.get(0).get('state'), 'ok')
})

test('inserting after a cell puts it next, not at the end', () => {
  const { doc, cells, ids } = notebook(['one', 'two', 'three'])
  const id = insertCellAfter(doc, CELLS_KEY, ids[0], 'code')
  assert.equal(cells.toArray().findIndex((c) => (c.get('id') as string) === id), 1)
})

test('an operation on a cell that is gone is a no-op, not a crash', () => {
  const { doc, cells } = notebook(['one', 'two'])
  const before = order(cells)
  moveInCells(doc, 'c_never_existed', 1)
  deleteCell(doc, 'c_never_existed')
  setCellType(doc, 'c_never_existed', 'markdown')
  assert.deepEqual(order(cells), before)
})

test('двигают ячейку — пересоздают соседа, а не её', () => {
  const { doc, cells, made, ids } = notebook(['a = 1', 'b = 2'])
  const moving = made[0]
  const movingText = moving.get('source') as Y.Text

  moveInCells(doc, ids[0], 1)

  // Порядок тот же, что и был бы при любом способе.
  assert.equal(order(cells).join(','), 'b = 2,a = 1')

  /*
   * Та ячейка, на кнопке которой стоял палец, — тот же самый объект.
   *
   * У Y.Array нет перемещения, так что одну из двух приходится пересоздавать
   * клоном, и всё привязанное к ней — редактор, курсор, набранное в этот миг —
   * пересоздаётся вместе с ней. Пусть это будет сосед.
   */
  const after = cells.toArray().find((c) => (c.get('id') as string) === ids[0])!
  assert.equal(after, moving, 'подвинули саму ячейку вместо соседа')

  // И её Y.Text по-прежнему живой: то, что в него пишет CodeMirror, доезжает.
  movingText.insert(movingText.length, ' + 1')
  assert.equal(order(cells).join(','), 'b = 2,a = 1 + 1')
})

test('перестановка соседа не сбивает секундомер работающей ячейки', () => {
  /*
   * Настоящий путь той же беды: двигают пятую, пересоздаётся шестая. Пока
   * ячейка считается, её `startedAt` — это то, из чего в комнате растёт цифра
   * секундомера; исчезнув, он останавливает часы на работающей ячейке.
   */
  const { doc, cells, made, ids } = notebook(['a = 1', 'b = 2'])
  doc.transact(() => {
    made[1].set('state', 'running')
    made[1].set('startedAt', 1_700_000_000_000)
  })

  moveInCells(doc, ids[0], 1)

  const still = cells.toArray().find((c) => (c.get('id') as string) === ids[1])!
  assert.equal(still.get('state'), 'running')
  assert.equal(still.get('startedAt'), 1_700_000_000_000, 'секундомер потерялся при перестановке')
})

/*
 * Потолок «по одной» живёт на сервере, а шаг Shift+Enter — в браузере, и до
 * сих пор они друг о друге не знали: отказанный запуск всё равно шагал вниз и
 * дописывал пустую ячейку в общую тетрадь класса. Клиент считает свои ячейки
 * тем же способом, что и `requestRun`: очередь плюс та, что уже считается.
 */
test('своя ячейка в очереди или в работе видна клиенту', () => {
  const { doc, made } = notebook(['a = 1', 'b = 2', 'c = 3'])
  assert.equal(hasPendingRun(doc, 'anna'), false)

  doc.transact(() => {
    made[0].set('state', 'queued')
    made[0].set('runById', 'petya')
  })
  // Чужая очередь потолка не занимает — иначе своя ячейка не запустилась бы
  // ни разу, пока преподаватель держит ядро.
  assert.equal(hasPendingRun(doc, 'anna'), false)
  assert.equal(hasPendingRun(doc, 'petya'), true)

  doc.transact(() => {
    made[1].set('state', 'running')
    made[1].set('runById', 'anna')
  })
  assert.equal(hasPendingRun(doc, 'anna'), true)

  // Досчитала — потолок снова свободен.
  doc.transact(() => made[1].set('state', 'ok'))
  assert.equal(hasPendingRun(doc, 'anna'), false)
})
