/**
 * Перечитывание ленты и расшифровки по кадру, а не целиком.
 *
 * Лента оракула и терминал растут дописыванием в Y.Text ВНУТРИ строки: один
 * кусочек ответа — один кадр `observeDeep`. Прежние панели на каждом таком
 * кадре собирали весь массив заново (`chat.map(readChatEntry)`,
 * `terminal.map(readTerminalLine)`), то есть читали `toString()` каждого ответа
 * и каждой команды на КАЖДЫЙ токен: работа по длине всего треда на символ, у
 * каждого, у кого открыта панель. Вдобавок объекты выходили новые, поэтому
 * производные каждого хода (дифф патча, разбор markdown, роль автора) и
 * `{@const}` каждой строки терминала пересчитывались вместе с ними.
 *
 * Здесь проверяется ровно то, на чём это держится: перечитано только задетое,
 * снимки остальных — ТЕ ЖЕ объекты, а всё, что делает номера строк
 * ненадёжными (вставка, удаление, перестановка), возвращает панель к полному
 * перечиту. Ошибиться в сторону лишней работы можно, в сторону устаревшего
 * снимка — нет.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  changedRows,
  createChatEntry,
  createTerminalLine,
  chatAnswer,
  getChat,
  getTerminal,
  readChatEntry,
  readTerminalLine,
  rereadRows,
  terminalText,
  type ChatSnapshot,
} from '../shared/notebook.js'

/** Панель целиком: массив снимков, который обновляется кадрами документа. */
function panel<Row extends Y.Map<any>, Snapshot>(
  array: Y.Array<Row>,
  read: (row: Row) => Snapshot,
): { rows: Snapshot[]; frames: number; stop: () => void } {
  const state = { rows: array.map(read), frames: 0, stop: () => {} }
  const onFrame = (events: Y.YEvent<any>[]) => {
    state.frames++
    state.rows = rereadRows(state.rows, array, read, events)
  }
  array.observeDeep(onFrame)
  state.stop = () => array.unobserveDeep(onFrame)
  return state
}

function ask(doc: Y.Doc, question: string): void {
  getChat(doc).push([createChatEntry({ participantId: 'p1', name: 'Нина', color: '#000', question })])
}

/* ------------------------------------------------------------ лента оракула */

test('ответ дописывается — перечитан только тот ход, в который пишут', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  ask(doc, 'второй')
  ask(doc, 'третий')

  const view = panel(getChat(doc), readChatEntry)
  const before = [...view.rows]

  // Двадцать кусочков ответа в средний ход — то, как приходит стриминг.
  const entry = getChat(doc).get(1)
  for (let i = 0; i < 20; i++) chatAnswer(entry).insert(chatAnswer(entry).length, 'слово ')

  assert.equal(view.frames, 20, 'каждый кусочек — свой кадр')
  assert.equal(view.rows.length, 3)
  assert.notEqual(view.rows[1], before[1], 'выросший ход перечитан')
  assert.equal(view.rows[1].answer, 'слово '.repeat(20))
  // Главное: соседи не тронуты, поэтому их производные не проснутся.
  assert.equal(view.rows[0], before[0], 'соседний ход остался тем же снимком')
  assert.equal(view.rows[2], before[2], 'и последний тоже')
  view.stop()
})

test('новый вопрос — полный перечит: номера строк поехали', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  const view = panel(getChat(doc), readChatEntry)
  const before = [...view.rows]

  // Вставка в НАЧАЛО: у прежнего хода сменился номер, и переиспользовать
  // снимок по индексу нельзя.
  getChat(doc).insert(0, [
    createChatEntry({ participantId: 'p2', name: 'Пётр', color: '#111', question: 'нулевой' }),
  ])

  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].question, 'нулевой')
  assert.equal(view.rows[1].question, 'первый')
  assert.notEqual(view.rows[1], before[0], 'после сдвига снимки собраны заново')
  view.stop()
})

test('удаление хода не оставляет в ленте снимок исчезнувшего', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  ask(doc, 'второй')
  const view = panel(getChat(doc), readChatEntry)

  getChat(doc).delete(0, 1)

  assert.deepEqual(
    view.rows.map((row: ChatSnapshot) => row.question),
    ['второй'],
  )
  view.stop()
})

test('поле хода (state, patch) — тоже кадр, и тоже точечный', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  ask(doc, 'второй')
  const view = panel(getChat(doc), readChatEntry)
  const before = [...view.rows]

  getChat(doc).get(0).set('state', 'done')

  assert.equal(view.rows[0].state, 'done')
  assert.equal(view.rows[1], before[1], 'второй ход не перечитан')
  view.stop()
})

/* --------------------------------------------------------------- терминал */

test('вывод команды растёт — остальные строки расшифровки не пересобираются', () => {
  const doc = new Y.Doc()
  const terminal = getTerminal(doc)
  terminal.push([createTerminalLine({ kind: 'command', text: 'pip install torch', name: 'Нина' })])
  terminal.push([createTerminalLine({ kind: 'output', text: '' })])

  const view = panel(terminal, readTerminalLine)
  const before = [...view.rows]

  const out = terminalText(terminal.get(1))
  for (let i = 0; i < 50; i++) out.insert(out.length, `Downloading ${i}\n`)

  assert.equal(view.rows[0], before[0], 'строка команды осталась тем же снимком')
  assert.notEqual(view.rows[1], before[1])
  assert.match(view.rows[1].text, /Downloading 49/)
  view.stop()
})

/* ------------------------------------------------------------- сам разбор */

test('пустой путь события — это сам массив, и он значит «перечитать всё»', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  const chat = getChat(doc)

  let seen: Set<number> | null | undefined
  const onFrame = (events: Y.YEvent<any>[]) => (seen = changedRows(events))

  chat.observeDeep(onFrame)
  ask(doc, 'второй')
  assert.equal(seen, null, 'вставка в массив — null, то есть полный перечит')

  chat.get(0).set('state', 'done')
  assert.deepEqual(seen, new Set([0]), 'правка карточки называет её номер')

  const answer = chatAnswer(chat.get(1))
  answer.insert(0, 'да')
  assert.deepEqual(seen, new Set([1]), 'текст внутри карточки — её же номер')
  chat.unobserveDeep(onFrame)
})

test('первое чтение (кадра ещё не было) собирает всё', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  const rows = rereadRows<Y.Map<any>, ChatSnapshot>([], getChat(doc), readChatEntry, null)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].question, 'первый')
})

test('когда трогать нечего — возвращается ТОТ ЖЕ массив', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  const rows = getChat(doc).map(readChatEntry)
  // Пустой набор событий: панель, сравнивающая по ссылке, не должна писать
  // новое значение — один такой лишний виток однажды стоил комнате
  // бесконечного цикла эффектов.
  assert.equal(rereadRows(rows, getChat(doc), readChatEntry, []), rows)
})
