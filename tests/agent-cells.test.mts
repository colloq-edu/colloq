/**
 * Оракул, который правит тетрадь.
 *
 * Модель здесь не участвует: проверяются руки. Всё, что ниже, ломается тихо —
 * оракул сообщает об успехе, а правка ушла в файл, который через полторы
 * секунды перепишет проекция; или ушла в документ, но вернуться из неё некуда;
 * или участник в лекции поправил чужую тетрадь чужими руками.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bookCells,
  cellId,
  cellsAt,
  cellOutputs,
  cellSource,
  createChatEntry,
  getChat,
  readCell,
  writeOutput,
  type YCell,
} from '@shared/notebook'
import { LECTURE_ROOM } from '@shared/rules'
import { createSession, listVersions, setFinished, setRules } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { flushHistory, restoreInto } from '../server/src/collab/history.js'
import { createBook } from '../server/src/collab/books.js'
import { flushAllFiles } from '../server/src/collab/files.js'
import { readText } from '../server/src/workspace.js'
import { saidAboutCells, toolsFor, undoTurn, useTool, type Hands } from '../server/src/ai/agent.js'

after(() => shutdownCollab())

const BY = { name: 'Ада', color: '#F97362', participantId: 'p_ada' }

let seq = 0
/** Своя комната на тест: чекпоинты и возвраты версий друг другу не соседи. */
function room(): string {
  const id = `cells${seq++}`
  createSession(id, `Cells ${id}`)
  // Заводит документ, а с ним стартовую тетрадь: markdown-заголовок и ячейка с
  // кодом — ровно то, что видит комната, открытая впервые.
  getSessionDoc(id)
  return id
}

function turn(sessionId: string): string {
  const doc = getSessionDoc(sessionId).doc
  const entry = createChatEntry({
    participantId: BY.participantId,
    name: BY.name,
    color: BY.color,
    question: 'подготовь тетрадь',
    mode: 'agent',
  })
  doc.transact(() => getChat(doc).push([entry]))
  const id = entry.get('id') as string
  doc.transact(() => entry.set('undo', 'available'))
  return id
}

function hands(sessionId: string, entryId: string, role: 'host' | 'participant' = 'host'): Hands {
  return { sessionId, entryId, by: BY, role }
}

/** Ячейки тетради комнаты — как их видит человек. */
function cells(sessionId: string): YCell[] {
  return bookCells(getSessionDoc(sessionId).doc, 'cells').toArray()
}

function source(sessionId: string, at: number): string {
  return cellSource(cells(sessionId)[at]).toString()
}

function call(hands: Hands, name: string, args: Record<string, unknown>) {
  return useTool(hands, name, JSON.stringify(args))
}

/* --------------------------------------------------------------- читает */

test('read_notebook показывает имена ячеек, вид и наличие вывода', async () => {
  const id = room()
  const doc = getSessionDoc(id).doc
  const first = cells(id)[0]
  doc.transact(() =>
    cellOutputs(cells(id)[1]).push([writeOutput({ kind: 'stream', name: 'stdout', text: '42\n' })]),
  )

  const listed = await call(hands(id, turn(id)), 'read_notebook', {})
  assert.equal(listed.step.kind, 'read')
  assert.equal(listed.step.target, 'Тетрадь.ipynb')
  assert.match(listed.said, new RegExp(cellId(first)), 'имени ячейки в списке нет')
  assert.match(listed.said, /markdown/)
  assert.match(listed.said, /print\("hello, seminar"\)/)
  assert.match(listed.said, /вывод есть/, 'про вывод не сказано — нечего будет перезапускать')
})

test('тетради с таким именем нет — человеческий отказ', async () => {
  const id = room()
  const tried = await call(hands(id, turn(id)), 'read_notebook', { path: 'Разбор.ipynb' })
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /не тетрадь этой комнаты/)
  assert.match(tried.said, /Тетрадь\.ipynb/, 'не сказано, какие тетради есть')
})

test('вторая тетрадь читается, но не правится: возвращать её нечем', async () => {
  const id = room()
  assert.equal(createBook(id, 'Разбор.ipynb').ok, true)
  const other = cellsAt(getSessionDoc(id).doc, 'Разбор.ipynb')
  assert.ok(other && other.length > 0, 'вторая тетрадь завелась без ячеек')

  const listed = await call(hands(id, turn(id)), 'read_notebook', { path: 'Разбор.ipynb' })
  assert.equal(listed.step.target, 'Разбор.ipynb')

  const tried = await call(hands(id, turn(id)), 'edit_cell', {
    cellId: cellId(other.get(0)),
    source: 'x = 1',
  })
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /только тетрадь комнаты/)
  assert.equal(cellSource(other.get(0)).toString(), '', 'чужую тетрадь всё-таки поправили')
})

/* ---------------------------------------------------------------- правит */

test('edit_cell меняет документ комнаты, а не файл тетради', async () => {
  const id = room()
  const entry = turn(id)
  const target = cells(id)[1]

  const wrote = await call(hands(id, entry), 'edit_cell', {
    cellId: cellId(target),
    source: 'print("готово к практике")',
  })
  assert.equal(wrote.step.kind, 'write')
  assert.equal(source(id, 1), 'print("готово к практике")')

  // Файл — проекция: запись в него была бы принята и молча потеряна, поэтому
  // отказ остался, но ведёт он теперь к ячейкам.
  const toFile = await call(hands(id, entry), 'write_file', {
    path: 'Тетрадь.ipynb',
    content: '{}',
  })
  assert.equal(toFile.step.kind, 'note')
  assert.match(toFile.said, /edit_cell/, 'отказ по файлу тетради остался тупиком')
})

test('вывод правка не стирает, а называет устаревшим', async () => {
  const id = room()
  const doc = getSessionDoc(id).doc
  const target = cells(id)[1]
  doc.transact(() =>
    cellOutputs(target).push([writeOutput({ kind: 'stream', name: 'stdout', text: 'старое\n' })]),
  )

  const wrote = await call(hands(id, turn(id)), 'edit_cell', {
    cellId: cellId(target),
    source: 'print("новое")',
  })
  assert.equal(readCell(target).outputs.length, 1, 'вывод стёрли — комната не узнает, что было')
  assert.match(wrote.said, /устаревш/i, 'про устаревший вывод не сказано')
})

test('add_cell встаёт после указанной, а без неё — в конец', async () => {
  const id = room()
  const entry = turn(id)
  const first = cellId(cells(id)[0])

  const added = await call(hands(id, entry), 'add_cell', {
    after: first,
    type: 'markdown',
    source: '## Задание 1',
  })
  assert.equal(added.step.kind, 'new')
  assert.equal(cells(id).length, 3)
  assert.equal(source(id, 1), '## Задание 1')

  await call(hands(id, entry), 'add_cell', { type: 'code', source: '# ваш код' })
  assert.equal(cells(id).length, 4)
  assert.equal(source(id, 3), '# ваш код')
})

test('remove_cell убирает ячейку, а считающуюся — нет', async () => {
  const id = room()
  const entry = turn(id)
  const doomed = cells(id)[1]

  const doc = getSessionDoc(id).doc
  doc.transact(() => doomed.set('state', 'running'))
  const busy = await call(hands(id, entry), 'remove_cell', { cellId: cellId(doomed) })
  assert.equal(busy.step.kind, 'note')
  assert.match(busy.said, /в очереди на ядро/)
  assert.equal(cells(id).length, 2, 'считающуюся ячейку всё-таки убрали')

  doc.transact(() => doomed.set('state', 'idle'))
  const gone = await call(hands(id, entry), 'remove_cell', { cellId: cellId(doomed) })
  assert.equal(gone.step.removed, 1)
  assert.equal(cells(id).length, 1)
})

test('несуществующая ячейка — человеческий отказ, а не молчание', async () => {
  const id = room()
  const entry = turn(id)
  for (const name of ['edit_cell', 'remove_cell']) {
    const tried = await call(hands(id, entry), name, { cellId: 'c_нетакой', source: 'x' })
    assert.equal(tried.step.kind, 'note', name)
    assert.match(tried.said, /в комнате нет/, name)
    assert.match(tried.said, /read_notebook/, name)
  }
  assert.equal(cells(id).length, 2)
})

/* ------------------------------------------------------------ чем платим */

test('чекпоинт ставится один раз за ход и возвращает тетрадь', async () => {
  const id = room()
  const was = [source(id, 0), source(id, 1)]
  const first = turn(id)

  await call(hands(id, first), 'edit_cell', { cellId: cellId(cells(id)[0]), source: '# Практика' })
  await call(hands(id, first), 'edit_cell', { cellId: cellId(cells(id)[1]), source: '# TODO' })

  const marks = listVersions(id, 50).filter((row) => row.kind === 'checkpoint')
  assert.equal(marks.length, 1, 'отметка на каждую ячейку вытолкнет из панели ту, что нужна')
  assert.equal(marks[0].label, 'до правки оракула')
  assert.equal(marks[0].author_id, BY.participantId, 'отметка вышла ничьей')

  // Одна кнопка — и тетрадь такая, какой была до хода.
  const doc = getSessionDoc(id).doc
  assert.ok(restoreInto(id, doc, marks[0].seq, BY.participantId, null) > 0)
  assert.deepEqual([source(id, 0), source(id, 1)], was)

  // Следующий ход — своя отметка: возвращаться из него надо не в чужую точку.
  const second = turn(id)
  await call(hands(id, second), 'edit_cell', { cellId: cellId(cells(id)[1]), source: 'x = 1' })
  assert.equal(listVersions(id, 50).filter((row) => row.kind === 'checkpoint').length, 2)
})

test('правка идёт от имени того, кто попросил ход', async () => {
  const id = room()
  await call(hands(id, turn(id)), 'edit_cell', {
    cellId: cellId(cells(id)[1]),
    source: 'print("от имени Ады")',
  })
  flushHistory(id)
  const newest = listVersions(id, 5).find((row) => row.kind === 'edit')
  assert.ok(newest, 'правка не попала в историю версий')
  assert.equal(newest.author_id, BY.participantId, 'версия оказалась ничьей — «the room»')
})

test('ответ называет ячейки, которые пришлось бы перезапустить', async () => {
  const id = room()
  const entry = turn(id)
  await call(hands(id, entry), 'edit_cell', { cellId: cellId(cells(id)[1]), source: 'x = 1' })
  await call(hands(id, entry), 'add_cell', { type: 'code', source: 'y = 2' })

  const said = saidAboutCells(id, entry)
  assert.match(said, /поправил 02/)
  assert.match(said, /добавил 03/)
  assert.match(said, /перезапустите/)
  assert.match(said, /до правки оракула/, 'не сказано, куда возвращаться')
})

test('отмена хода по-прежнему возвращает файлы', async () => {
  const id = room()
  const entry = turn(id)
  await call(hands(id, entry), 'write_file', { path: 'train.py', content: 'x = 1\n' })
  await call(hands(id, entry), 'edit_cell', { cellId: cellId(cells(id)[1]), source: 'x = 1' })
  flushAllFiles()
  assert.equal(readText(id, 'train.py')?.text, 'x = 1\n')

  assert.equal(undoTurn(id, entry, 'Ада'), 1, 'кнопка под ходом перестала возвращать файлы')
  flushAllFiles()
  assert.equal(readText(id, 'train.py')?.text, '')
  // Тетрадь отмена не трогает: её возвращает история версий, и об этом сказано
  // в самом ответе хода.
  assert.equal(source(id, 1), 'x = 1')
})

/* ------------------------------------------------------------------ права */

test('участнику в лекции инструментов по ячейкам не дают вовсе', async () => {
  const id = room()
  setRules(id, { ...LECTURE_ROOM, agent: 'room' })
  const entry = turn(id)

  const theirs = toolsFor(hands(id, entry, 'participant')).map((tool) => tool.name)
  assert.ok(theirs.includes('read_notebook'), 'смотреть тетрадь можно всем — она и так на экране')
  for (const name of ['edit_cell', 'add_cell', 'remove_cell']) {
    assert.ok(!theirs.includes(name), `${name} предложили тому, кому нельзя`)
  }
  const hosts = toolsFor(hands(id, entry, 'host')).map((tool) => tool.name)
  for (const name of ['edit_cell', 'add_cell', 'remove_cell']) {
    assert.ok(hosts.includes(name), `${name} не дали преподавателю в его же лекции`)
  }

  // И не только в списке: отказ приходит и на прямой вызов.
  const target = cells(id)[1]
  const tried = await call(hands(id, entry, 'participant'), 'edit_cell', {
    cellId: cellId(target),
    source: 'решение = 42',
  })
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /преподавател/i)
  assert.equal(source(id, 1), 'print("hello, seminar")', 'лекционную тетрадь поправил участник')

  const added = await call(hands(id, entry, 'participant'), 'add_cell', {
    type: 'code',
    source: 'x',
  })
  assert.match(added.said, /преподавател/i)
  assert.equal(cells(id).length, 2)
})

test('замок на ячейке: участнику открыта одна, преподавателю вся тетрадь', async () => {
  const id = room()
  setRules(id, { ...LECTURE_ROOM, agent: 'room' })
  const entry = turn(id)
  const doc = getSessionDoc(id).doc
  const open = cells(id)[1]
  const closed = cells(id)[0]
  doc.transact(() => open.set('open', true))

  const theirs = toolsFor(hands(id, entry, 'participant')).map((tool) => tool.name)
  assert.ok(theirs.includes('edit_cell'), 'открытая ячейка есть, а инструмента к ней нет')

  const allowed = await call(hands(id, entry, 'participant'), 'edit_cell', {
    cellId: cellId(open),
    source: 'мой ответ',
  })
  assert.equal(allowed.step.kind, 'write')
  assert.equal(source(id, 1), 'мой ответ')

  const refused = await call(hands(id, entry, 'participant'), 'edit_cell', {
    cellId: cellId(closed),
    source: 'и тут тоже',
  })
  assert.equal(refused.step.kind, 'note')
  assert.match(refused.said, /преподавател/i)

  const theirCell = await call(hands(id, entry, 'participant'), 'remove_cell', {
    cellId: cellId(open),
  })
  assert.match(theirCell.said, /убирает преподаватель/, 'открытая ячейка дала право её же убрать')

  const host = await call(hands(id, entry, 'host'), 'edit_cell', {
    cellId: cellId(closed),
    source: '# Разбор',
  })
  assert.equal(host.step.kind, 'write')
  assert.equal(source(id, 0), '# Разбор')
})

test('после звонка тетрадь не правит и преподавательский ход участника', async () => {
  const id = room()
  const entry = turn(id)
  setFinished(id, Date.now())

  const tried = await call(hands(id, entry, 'participant'), 'edit_cell', {
    cellId: cellId(cells(id)[1]),
    source: 'x = 1',
  })
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /Занятие закончено/)
  assert.equal(source(id, 1), 'print("hello, seminar")')

  // Преподавателю — можно: комната после звонка остаётся его.
  const host = await call(hands(id, entry, 'host'), 'edit_cell', {
    cellId: cellId(cells(id)[1]),
    source: 'x = 1',
  })
  assert.equal(host.step.kind, 'write')
  setFinished(id, null)
})
