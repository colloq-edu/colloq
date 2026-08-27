/**
 * Предел вопросов к оракулу — единственное, что стоит между чужим ключом и
 * чьим-то счётом. Личный предел обходится перезаходом: имя в комнате ничем не
 * подтверждено, и новая вкладка инкогнито — это новый участник со свежими N
 * вопросами. Поэтому есть второй потолок, на всю комнату; проверяется он, а
 * не личный, потому что дыра была именно здесь.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countRecentQuestions, countRoomQuestions, recordQuestion } from '../server/src/admin/usage.js'

const HOUR = 60 * 60 * 1000

test('перезаход обнуляет личный счёт и не обнуляет комнатный', () => {
  const room = 'limits-room'

  // Один человек задал три вопроса.
  for (let i = 0; i < 3; i++) {
    recordQuestion({ sessionId: room, participantId: 'p_one', action: 'ask' })
  }
  assert.equal(countRecentQuestions(room, 'p_one', HOUR), 3)
  assert.equal(countRoomQuestions(room, HOUR), 3)

  // Он же перезашёл: новая вкладка — новый participantId, личный счёт пуст.
  assert.equal(countRecentQuestions(room, 'p_one_again', HOUR), 0)
  recordQuestion({ sessionId: room, participantId: 'p_one_again', action: 'ask' })

  // А комната помнит всё, что в ней спросили, кем бы он ни назвался.
  assert.equal(countRoomQuestions(room, HOUR), 4)
})

test('счёт одной комнаты не течёт в другую', () => {
  const a = 'limits-a'
  const b = 'limits-b'
  recordQuestion({ sessionId: a, participantId: 'p_x', action: 'ask' })
  recordQuestion({ sessionId: a, participantId: 'p_y', action: 'ask' })
  assert.equal(countRoomQuestions(a, HOUR), 2)
  assert.equal(countRoomQuestions(b, HOUR), 0)
})

test('комнатный счёт считает всех, включая тех, кто больше не вернётся', () => {
  const room = 'limits-crowd'
  for (const who of ['p_a', 'p_b', 'p_c', 'p_d']) {
    recordQuestion({ sessionId: room, participantId: who, action: 'ask' })
  }
  // Ровно то, чем этот потолок отличается от личного: он не про человека.
  assert.equal(countRoomQuestions(room, HOUR), 4)
  for (const who of ['p_a', 'p_b', 'p_c', 'p_d']) {
    assert.equal(countRecentQuestions(room, who, HOUR), 1)
  }
})
