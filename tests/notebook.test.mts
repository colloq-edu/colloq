/**
 * The shared document is the contract between browser and server, and the two
 * read it with the same functions. What is pinned here is the shape: a cell
 * created on one side has to be readable on the other, and merging two people's
 * edits has to end in one notebook rather than two.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  addBook,
  bookKernel,
  CELLS_KEY,
  cellId,
  cellOutputs,
  cellSource,
  cloneCell,
  clearStaleExecution,
  createCell,
  createChatEntry,
  createTerminalLine,
  chatAnswer,
  ensureInitialNotebook,
  findCell,
  kernelEntry,
  KERNEL_STATUS_FIELD,
  legacyKernelStatus,
  findChatEntry,
  getCells,
  getChat,
  getMeta,
  getTerminal,
  readCell,
  readChatEntry,
  readNotebook,
  readOutput,
  readTerminalLine,
  replaceText,
  terminalText,
} from '../shared/notebook.js'

/** Roots have to exist before anything can be read out of them. */
function blank(): Y.Doc {
  const doc = new Y.Doc()
  getCells(doc)
  getMeta(doc)
  getChat(doc)
  getTerminal(doc)
  return doc
}

test('a cell is readable only once it has joined a document', () => {
  const doc = blank()
  const cell = createCell('code', 'print(1)')
  getCells(doc).push([cell])
  const snapshot = readCell(cell)
  assert.equal(snapshot.type, 'code')
  assert.equal(snapshot.source, 'print(1)')
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.execCount, null)
  assert.equal(snapshot.outputs.length, 0)
  assert.equal(cellId(cell), snapshot.id)
})

test('cell ids are unique across a notebook', () => {
  const doc = blank()
  const cells = getCells(doc)
  cells.push(Array.from({ length: 200 }, () => createCell('code', '')))
  const ids = readNotebook(doc).map((c) => c.id)
  assert.equal(new Set(ids).size, 200)
})

test('findCell reports the position, and nothing for an id that has gone', () => {
  const doc = blank()
  const cells = getCells(doc)
  const a = createCell('code', 'a')
  const b = createCell('markdown', 'b')
  cells.push([a, b])
  const idA = cellId(a)
  assert.equal(findCell(doc, idA)?.index, 0)
  assert.equal(findCell(doc, cellId(b))?.index, 1)
  cells.delete(0, 1)
  assert.equal(findCell(doc, idA), null)
  assert.equal(findCell(doc, 'never-existed'), null)
})

test('a stream output accumulates rather than being replaced', () => {
  const doc = blank()
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  const text = new Y.Text()
  cellOutputs(cell).push([new Y.Map(Object.entries({ kind: 'stream', name: 'stdout', text }))])
  // The kernel streams chunk by chunk; a reader must see the whole run so far.
  text.insert(text.length, 'first\n')
  text.insert(text.length, 'second\n')
  const out = readOutput(cellOutputs(cell).get(0))
  assert.ok(out && out.kind === 'stream')
  assert.equal(out.text, 'first\nsecond\n')
})

test('an output that makes no sense is dropped, not thrown over', () => {
  const doc = blank()
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  cellOutputs(cell).push([new Y.Map(Object.entries({ kind: 'nonsense' }))])
  cellOutputs(cell).push([new Y.Map(Object.entries({ kind: 'error', json: '{not json' }))])
  // A malformed entry from a future version, or a corrupted snapshot, must not
  // take the whole notebook down with it.
  assert.doesNotThrow(() => readCell(cell))
  assert.equal(readCell(cell).outputs.length, 0)
})

test('two people editing the same cell converge on one text', () => {
  const a = blank()
  const b = blank()
  const cell = createCell('code', '')
  getCells(a).push([cell])
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

  const idOf = cellId(cell)
  const inA = findCell(a, idOf)!.cell
  const inB = findCell(b, idOf)!.cell
  cellSource(inA).insert(0, 'import pandas')
  cellSource(inB).insert(0, 'import numpy')

  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

  const left = cellSource(findCell(a, idOf)!.cell).toString()
  const right = cellSource(findCell(b, idOf)!.cell).toString()
  assert.equal(left, right, 'the two clients disagree about the cell')
  assert.ok(left.includes('pandas') && left.includes('numpy'), left)
})

test('two people inserting cells at once keep every cell', () => {
  const a = blank()
  const b = blank()
  getCells(a).push([createCell('code', 'a1')])
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  getCells(a).push([createCell('code', 'a2')])
  getCells(b).push([createCell('code', 'b1')])
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

  const left = readNotebook(a).map((c) => c.source)
  const right = readNotebook(b).map((c) => c.source)
  assert.deepEqual(left, right)
  assert.equal(left.length, 3, left.join())
})

test('seeding a notebook is safe to repeat', () => {
  const doc = blank()
  ensureInitialNotebook(doc, 'Computer Vision Seminar')
  const first = readNotebook(doc).map((c) => c.id)
  ensureInitialNotebook(doc, 'A different name')
  const second = readNotebook(doc).map((c) => c.id)
  // Every reconnecting client calls this. A second seeding would duplicate the
  // welcome cells for the whole room, and rename the seminar under them.
  assert.deepEqual(first, second)
  assert.equal(getMeta(doc).get('title'), 'Computer Vision Seminar')
})

test('пустой заголовок — не «документ пуст», и участник его не вписывает', () => {
  /*
   * Хост выделил имя семинара в шапке и стёр — в документе осталось ''. Эту
   * функцию зовёт КАЖДЫЙ браузер на каждом sync, и по значению условие снова
   * истинно: заголовок писал бы студент, а гейт заголовок не-хосту отказывает —
   * закрытый сокет, стёртый кэш, перезагрузка, снова sync, снова запись. Круг,
   * из которого вкладка выходила только когда хост допечатает имя.
   */
  const doc = blank()
  ensureInitialNotebook(doc, 'Семинар')
  getMeta(doc).set('title', '')
  ensureInitialNotebook(doc, 'Семинар')
  assert.equal(getMeta(doc).get('title'), '', 'участник вписал заголовок обратно')
})

test('seeding never overwrites a notebook that has content', () => {
  const doc = blank()
  getCells(doc).push([createCell('code', 'the students work')])
  ensureInitialNotebook(doc, 'Seminar')
  const cells = readNotebook(doc)
  assert.equal(cells.length, 1)
  assert.equal(cells[0].source, 'the students work')
})

test('a chat entry carries who asked and streams its answer', () => {
  const doc = blank()
  const entry = createChatEntry({
    participantId: 'p_1',
    name: 'Maria',
    color: '#f97362',
    question: 'why does it run out of memory?',
    action: 'ask',
    cellId: 'c_4',
  })
  getChat(doc).push([entry])
  const id = readChatEntry(entry).id
  assert.equal(readChatEntry(entry).name, 'Maria')
  assert.equal(readChatEntry(entry).state, 'streaming')
  assert.equal(findChatEntry(doc, id), entry)

  const answer = chatAnswer(entry)
  answer.insert(answer.length, 'The batch is not what fills the card.')
  assert.match(readChatEntry(entry).answer, /fills the card/)
  assert.equal(findChatEntry(doc, 'no-such-entry'), null)
})

test('a terminal line streams its output the way a shell does', () => {
  const doc = blank()
  const line = createTerminalLine({ kind: 'command', text: 'pip install timm', name: 'John', color: '#4aa8f0' })
  getTerminal(doc).push([line])
  const out = createTerminalLine({ kind: 'output' })
  getTerminal(doc).push([out])
  const text = terminalText(out)
  text.insert(text.length, 'Collecting timm\n')
  text.insert(text.length, 'Successfully installed timm-1.0.15\n')
  assert.equal(readTerminalLine(line).kind, 'command')
  assert.equal(readTerminalLine(line).name, 'John')
  assert.match(readTerminalLine(out).text, /Successfully installed/)
})

test('принятая правка переписывает только то, что изменилось', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  doc.getMap('holder').set('t', text)
  text.insert(0, 'import pandas as pd\ndf = pd.read_csv("a.csv")\nprint(df)\n')

  // Курсор соседа — то, ради чего всё это. Y.RelativePosition переживает
  // правку соседних строк и не переживает «удалить всё и вставить заново».
  const caret = Y.createRelativePositionFromTypeIndex(text, text.length - 1)

  replaceText(text, 'import pandas as pd\ndf = pd.read_csv("b.csv")\nprint(df)\n')

  assert.equal(text.toString(), 'import pandas as pd\ndf = pd.read_csv("b.csv")\nprint(df)\n')
  const after = Y.createAbsolutePositionFromRelativePosition(caret, doc)
  assert.equal(after?.index, text.length - 1)
})

test('replaceText на одинаковом тексте не пишет ничего', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  doc.getMap('holder').set('t', text)
  text.insert(0, 'x = 1\n')

  let updates = 0
  doc.on('update', () => updates++)
  replaceText(text, 'x = 1\n')
  assert.equal(updates, 0)
})

test('replaceText справляется с дописыванием и с полной заменой', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  doc.getMap('holder').set('t', text)
  text.insert(0, 'a\n')

  replaceText(text, 'a\nb\n')
  assert.equal(text.toString(), 'a\nb\n')

  replaceText(text, 'совсем другое')
  assert.equal(text.toString(), 'совсем другое')

  replaceText(text, '')
  assert.equal(text.toString(), '')
})

test('клон несёт секундомер, время выполнения и форму ввода', () => {
  /*
   * `moveCell` пересоздаёт клоном соседнюю ячейку, а не ту, которую двигают:
   * подвинуть пятую, пока считается шестая, значит пересобрать шестую целиком.
   * Ключ, забытый в cloneCell, исчезает у неё посреди выполнения — с
   * `startedAt` это остановившийся секундомер на работающей ячейке, а с
   * `stdin` пропавшая у всей комнаты форма ввода, пока ядро ждёт ответа.
   *
   * Клон читается после того, как попал в документ: Yjs не отвечает на get()
   * у типа, который ещё никуда не вставлен, и молча отдаёт undefined.
   */
  const doc = blank()
  const cell = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([cell]))
  doc.transact(() => {
    cell.set('state', 'running')
    cell.set('startedAt', 1_700_000_000_000)
    cell.set('ranMs', 4_200)
    cell.set('stdin', { prompt: 'Имя: ', password: false })
  })

  const copy = cloneCell(cell)
  doc.transact(() => getCells(doc).push([copy]))

  assert.equal(copy.get('startedAt'), 1_700_000_000_000)
  assert.equal(copy.get('ranMs'), 4_200)
  assert.deepEqual(copy.get('stdin'), { prompt: 'Имя: ', password: false })
})

test('свежая ячейка заводится без секундомера, и старая читается без него', () => {
  const doc = blank()
  const fresh = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([fresh]))
  assert.equal(readCell(fresh).startedAt, null)
  assert.equal(readCell(fresh).ranMs, null)

  // Тетрадь, записанная до появления этих ключей: get() отдаёт undefined, а
  // весь просмотр сравнивает с null.
  const old = createCell('code', 'y = 2')
  doc.transact(() => {
    getCells(doc).push([old])
    old.delete('startedAt')
    old.delete('ranMs')
  })
  assert.equal(readCell(old).startedAt, null)
  assert.equal(readCell(old).ranMs, null)
})

/*
 * «ЗАПУСК python3» у комнаты, в которой ничего не запускается.
 *
 * Ядро поднимается лениво — первым Run или первым наведением за справкой, — то
 * есть у только что заведённой комнаты и у комнаты после перезапуска сервера
 * его нет и никто его не поднимает. Пока такое состояние называлось
 * `starting`, шапка часами обещала подъём, которого не было; жалоба с занятия
 * 20.09 звучала так: «это всё-таки не запуск, потому что он ничего не
 * запускает, просто висит».
 */
test('у комнаты без ядра состояние «не запущено», а не «запускается»', () => {
  const doc = blank()
  ensureInitialNotebook(doc, 'ZZ')
  // Новая вкладка читает карту тетрадей; записи там ещё нет вовсе.
  assert.equal(bookKernel(doc, CELLS_KEY).status, 'off')
  // Прежний ключ не засевается вовсе: пусто читается как «не запущено», а
  // старая вкладка видит своё прежнее умолчание и ничего не теряет.
  assert.equal(getMeta(doc).has('kernelStatus'), false)
  // А когда сервер напишет `off`, в прежний ключ уедет слово из словаря
  // старой вкладки — иначе её плашка осталась бы пустой.
  assert.equal(legacyKernelStatus('off'), 'idle')
  // Остальные состояния через зеркало проходят как есть.
  for (const status of ['starting', 'idle', 'busy', 'restarting', 'dead'] as const) {
    assert.equal(legacyKernelStatus(status), status)
  }
})

test('перезапуск сервера гасит и состояние ядра: процесса нет ни у одной тетради', () => {
  const doc = blank()
  ensureInitialNotebook(doc, 'ZZ')
  const second = addBook(doc, 'Семинар.ipynb')
  doc.transact(() => {
    // Так документ выглядит на диске после падения: лекция считала, семинар
    // был готов, а смерть ядра — факт, который перезапуск не отменяет.
    kernelEntry(doc, CELLS_KEY).set(KERNEL_STATUS_FIELD, 'busy')
    kernelEntry(doc, second.root).set(KERNEL_STATUS_FIELD, 'idle')
    getMeta(doc).set('kernelStatus', 'busy')
  })

  clearStaleExecution(doc)

  assert.equal(bookKernel(doc, CELLS_KEY).status, 'off')
  assert.equal(bookKernel(doc, second.root).status, 'off', 'вторая тетрадь осталась «готовой» без ядра')
  assert.equal(getMeta(doc).get('kernelStatus'), 'idle', 'старой вкладке уехало незнакомое слово')
})

test('настоящая смерть ядра перезапуск сервера не стирает', () => {
  const doc = blank()
  ensureInitialNotebook(doc, 'ZZ')
  doc.transact(() => kernelEntry(doc, CELLS_KEY).set(KERNEL_STATUS_FIELD, 'dead'))
  clearStaleExecution(doc)
  /*
   * `dead` — это OOM, падение или «не поднялось», и у него своя красная плашка
   * с кнопкой и свой совет преподавателю. Перекрасить его в «не запущено»
   * значило бы спрятать причину, ради которой этот статус и заведён.
   */
  assert.equal(bookKernel(doc, CELLS_KEY).status, 'dead')
})

test('перезапуск сервера гасит секундомер, но не стирает измеренное время', () => {
  const doc = blank()
  const wasRunning = createCell('code', 'a')
  const wasDone = createCell('code', 'b')
  doc.transact(() => {
    getCells(doc).push([wasRunning, wasDone])
    wasRunning.set('state', 'running')
    wasRunning.set('startedAt', 1_700_000_000_000)
    wasDone.set('state', 'ok')
    wasDone.set('ranMs', 4_200)
    // Протухшая отметка на успокоившейся ячейке: так выглядит слияние от
    // вкладки, пережившей падение сервера.
    wasDone.set('startedAt', 1_700_000_000_000)
  })

  const cleared = clearStaleExecution(doc)

  assert.equal(wasRunning.get('state'), 'idle')
  assert.equal(wasRunning.get('startedAt'), null)
  // Отметка погашена и у второй, но она не считается сброшенной работой:
  // `cleared` уходит в строку «Cells that were running or queued were put back
  // to rest», и приписать туда лишнюю ячейку значит сказать классу неправду.
  assert.equal(wasDone.get('startedAt'), null)
  assert.equal(wasDone.get('state'), 'ok')
  assert.equal(cleared, 1)
  // Измеренное время — факт с одних серверных часов; перезапуск его не отменяет.
  assert.equal(wasDone.get('ranMs'), 4_200)
})
