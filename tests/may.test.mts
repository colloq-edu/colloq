/**
 * Замок на ячейке — глазами интерфейса.
 *
 * Само право считает shared/rules.ts, теми же функциями, которыми отвечает
 * сервер. Проверяется тонкий слой поверх них (web/src/lib/may.ts), у которого
 * есть ровно одна своя мысль: НУЖЕН ЛИ замок в этой комнате вообще.
 *
 * Мысль эта задаёт вопрос про УЧАСТНИКА, а не про того, кто смотрит, и
 * ошибиться в ней можно совершенно молча. Спроси интерфейс про себя — и
 * преподаватель, у которого ответ не меняется ни при каком замке, остался бы
 * без единственной кнопки, которой ячейку открывают: значок не нарисован,
 * жаловаться не на что, комната просто не умеет того, ради чего написана.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import type { ParticipantRole } from '../shared/protocol.js'
import { cellLockMatters, mayEditThisCell, mayRunThisCell, permitsIn } from '../web/src/lib/may.js'

const may = (rules: RoomRules, role: ParticipantRole, finished = false) =>
  permitsIn(rules, role, finished)

test('в лекции замок открывает участнику ровно эту ячейку', () => {
  const student = may(LECTURE_ROOM, 'participant')
  assert.equal(mayEditThisCell(student, false), false)
  assert.equal(mayRunThisCell(student, false), false)
  assert.equal(mayEditThisCell(student, true), true)
  assert.equal(mayRunThisCell(student, true), true)
})

test('в открытой лаборатории замка нет — открывать там нечего', () => {
  assert.equal(cellLockMatters(may(OPEN_ROOM, 'participant')), false)
  assert.equal(cellLockMatters(may(OPEN_ROOM, 'host')), false)
})

test('замок нужен и преподавателю, хотя ему самому ничего не меняет', () => {
  const host = may(LECTURE_ROOM, 'host')
  assert.equal(mayEditThisCell(host, false), true, 'ведущему запертая ячейка не заперта')
  assert.equal(cellLockMatters(host), true, 'а рисовать замок всё равно надо — открывает он')
})

test('закончившееся занятие снимает замок вместе со всем остальным', () => {
  const student = may(LECTURE_ROOM, 'participant', true)
  assert.equal(mayEditThisCell(student, true), false, 'после звонка не пишут и в открытую')
  assert.equal(cellLockMatters(student), false, 'значит и говорить про замок не о чем')
})

test('комната, где нельзя только запускать, замок показывает тоже', () => {
  // Замок — свойство не лекционного пресета, а любого правила, которое он
  // способен отпустить. Иначе «открыть ячейку» работало бы ровно в одной
  // комнате из всех, где сервер его слушает.
  const student = may({ ...OPEN_ROOM, run: 'host' }, 'participant')
  assert.equal(cellLockMatters(student), true)
  assert.equal(mayEditThisCell(student, false), true, 'печатать здесь можно и без замка')
  assert.equal(mayRunThisCell(student, false), false)
  assert.equal(mayRunThisCell(student, true), true)
})
