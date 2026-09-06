/**
 * Вопрос в ленте появляется по нажатию Enter, а не по кругу до сервера.
 *
 * Проверяется подстановка: строка вкладки обязана исчезнуть ровно тогда, когда
 * её место заняла настоящая запись, — и ни раньше, ни позже. Раньше — человек
 * снова смотрит в пустоту и жмёт Enter второй раз; позже — один вопрос стоит в
 * ленте дважды.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outgoingRow, settleOutbox, type Outgoing } from '../web/src/lib/ask-outbox.js'
import type { ChatSnapshot } from '../shared/notebook.js'

const ME = { id: 'p_ada', name: 'Ада', color: '#7e82f0' }

let seq = 0
function mine(question: string, before: ChatSnapshot[] = []): Outgoing {
  return {
    row: outgoingRow({ id: `outgoing:${++seq}`, me: ME, question, at: 1000 }),
    before: new Set(before.map((entry) => entry.id)),
  }
}

/** Запись, какой её кладёт в ленту сервер. */
function real(id: string, question: string, who = ME.id): ChatSnapshot {
  return { ...outgoingRow({ id, me: ME, question, at: 2000 }), id, participantId: who }
}

test('строка вкладки выглядит как запись, которой станет', () => {
  const row = outgoingRow({ id: 'outgoing:1', me: ME, question: 'почему nan?', at: 7 })
  // Вертушка и «Стоп» — те же, что у настоящей только что заведённой записи:
  // подмена не должна быть заметна рывком.
  assert.equal(row.state, 'streaming')
  assert.equal(row.answer, '')
  assert.equal(row.reasoning, '')
  assert.equal(row.thoughtMs, null)
  assert.deepEqual(row.steps, [])
  assert.equal(row.patch, null)
  assert.equal(row.undo, 'none')
  assert.equal(row.participantId, ME.id)
  assert.equal(row.createdAt, 7)
})

test('ход «сделать» остаётся ходом «сделать», а ячейка берётся из выделения', () => {
  const row = outgoingRow({
    id: 'outgoing:1',
    me: ME,
    question: 'перепиши',
    mode: 'agent',
    cellIds: ['c7', 'c8'],
    at: 0,
  })
  assert.equal(row.mode, 'agent')
  // Привязка одна — та, куда ляжет предложение; спрашивали про обе.
  assert.equal(row.cellId, 'c7')
  assert.deepEqual(row.cellIds, ['c7', 'c8'])
})

test('доехавшая запись снимает свою строку', () => {
  const pending = [mine('почему nan?')]
  assert.equal(settleOutbox(pending, []).length, 1, 'сняли раньше времени')
  assert.deepEqual(settleOutbox(pending, [real('q1', 'почему nan?')]), [])
})

test('чужая запись с тем же текстом мою строку не снимает', () => {
  // Вопрос «почему nan?» на семинаре задают трое, и снять чужой записью
  // означало бы, что мой вопрос пропал с экрана, не успев доехать.
  const pending = [mine('почему nan?')]
  assert.equal(settleOutbox(pending, [real('q1', 'почему nan?', 'p_petya')]).length, 1)
})

test('мой старый такой же вопрос не снимает новую строку', () => {
  /*
   * Ровно это делает Retry: тот же текст, тот же автор, запись уже в ленте.
   * Различает их только то, что старая запись лежала там ДО отправки.
   */
  const old = real('q1', 'почему nan?')
  const pending = [mine('почему nan?', [old])]
  assert.equal(settleOutbox(pending, [old]).length, 1, 'строку снял вопрос десятиминутной давности')
  assert.deepEqual(settleOutbox(pending, [old, real('q2', 'почему nan?')]), [])
})

test('два одинаковых вопроса подряд разбираются по очереди', () => {
  const first = mine('ещё раз?')
  const second = mine('ещё раз?')
  const landed = real('q1', 'ещё раз?')
  const left = settleOutbox([first, second], [landed])
  assert.equal(left.length, 1, 'одна запись сняла обе строки')
  assert.equal(left[0].row.id, second.row.id, 'сняли не ту: первой доехала первая')
  assert.deepEqual(settleOutbox(left, [landed, real('q2', 'ещё раз?')]), [])
})

test('пустая очередь — пустая работа', () => {
  assert.deepEqual(settleOutbox([], [real('q1', 'что угодно')]), [])
})

test('снимать нечего — возвращается тот же массив, а не копия', () => {
  /*
   * Не придирка к аллокации, а причина настоящей поломки: вызывающий сравнивает
   * по ссылке и на новом массиве пишет состояние. Один такой `filter` внутри
   * эффекта, который сам же читает это состояние, положил комнату целиком —
   * `effect_update_depth_exceeded` вместо тетради.
   */
  const pending = [mine('почему nan?')]
  assert.equal(settleOutbox(pending, []), pending)
  assert.equal(settleOutbox(pending, [real('q1', 'чужой вопрос', 'p_petya')]), pending)
  assert.equal(settleOutbox([], []).length, 0)
  // А когда снимать есть что — массив, конечно, новый.
  assert.notEqual(settleOutbox(pending, [real('q1', 'почему nan?')]), pending)
})
