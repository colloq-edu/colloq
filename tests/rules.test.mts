/**
 * Правила комнаты: что они обещают и что переживает старая запись.
 *
 * Каждое поле падает на своё умолчание отдельно от других — это и есть
 * миграция, и ломается она молча: семинар, заведённый до появления поля,
 * должен открыться ровно тем, чем был, а не строгим.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allows,
  allowsRun,
  allowsShell,
  allowsStructure,
  isOpenRoom,
  OPEN_ROOM,
  readRules,
  runQueueCap,
} from '../shared/rules.js'

test('семинар, записанный до новых полей, открывается прежним', () => {
  // Ровно то, что лежит в базе у семинаров, заведённых раньше.
  const stored = { run: 'room', edit: 'room', structure: 'room', terminal: 'room', files: 'room', oracle: 'inherit', model: null }
  const read = readRules(stored)
  assert.equal(read.run, 'room')
  assert.equal(read.structure, 'room')
  assert.equal(read.terminal, 'room')
  // Новые три отсутствовали вовсе — читаются умолчаниями.
  assert.equal(read.wipe, 'host')
  assert.equal(read.restart, 'host')
  assert.equal(read.history, 'room')
  // И такая комната по-прежнему считается «продуктом как он есть».
  assert.equal(isOpenRoom(read), true, 'старый семинар перестал быть открытой комнатой')
})

test('строгое значение из старой записи тоже переживает', () => {
  const read = readRules({ run: 'host', structure: 'host', terminal: 'host' })
  assert.equal(read.run, 'host')
  assert.equal(read.structure, 'host')
  assert.equal(read.terminal, 'host')
})

test('незнакомое значение падает на разрешительное, а не на строгое', () => {
  // Правило, которое от испорченной строки становится строже, запирает комнату
  // посреди пары и объяснить это некому.
  const read = readRules({ run: 'sometimes', structure: 42, terminal: null, wipe: 'everyone' })
  assert.equal(read.run, OPEN_ROOM.run)
  assert.equal(read.structure, OPEN_ROOM.structure)
  assert.equal(read.terminal, OPEN_ROOM.terminal)
  assert.equal(read.wipe, OPEN_ROOM.wipe)
})

test('«по одной» разрешает ячейку и запрещает весь лист', () => {
  assert.equal(allowsRun('single', 'participant', 'one'), true)
  assert.equal(allowsRun('single', 'participant', 'bulk'), false, 'Run All прошёл при «по одной»')
  // Преподавателю — и то и другое, при любом значении.
  assert.equal(allowsRun('single', 'host', 'bulk'), true)
  assert.equal(allowsRun('host', 'host', 'bulk'), true)
  assert.equal(allowsRun('host', 'participant', 'one'), false)
})

test('«по одной» — это потолок очереди, а не запрет', () => {
  assert.equal(runQueueCap('single', 'participant'), 1)
  assert.equal(runQueueCap('single', 'host'), Number.POSITIVE_INFINITY)
  assert.equal(runQueueCap('room', 'participant'), Number.POSITIVE_INFINITY)
})

test('«только дописывать» разрешает ровно первый глагол', () => {
  assert.equal(allowsStructure('add', 'participant', 'add'), true)
  assert.equal(allowsStructure('add', 'participant', 'remove'), false)
  assert.equal(allowsStructure('add', 'participant', 'move'), false, 'переставить в никуда — обход запрета убирать')
  for (const verb of ['add', 'remove', 'move'] as const) {
    assert.equal(allowsStructure('add', 'host', verb), true)
    assert.equal(allowsStructure('host', 'participant', verb), false)
    assert.equal(allowsStructure('room', 'participant', verb), true)
  }
})

test('«терминала нет» относится и к преподавателю', () => {
  // Ящик, который видит один человек из двадцати, — это не «нет терминала».
  assert.equal(allowsShell('off', 'host', 'exist'), false)
  assert.equal(allowsShell('off', 'host', 'type'), false)
  assert.equal(allowsShell('host', 'participant', 'exist'), true, 'класс должен видеть, что делает преподаватель')
  assert.equal(allowsShell('host', 'participant', 'type'), false)
  assert.equal(allowsShell('room', 'participant', 'type'), true)
})

test('allows не забывает про преподавателя', () => {
  assert.equal(allows('host', 'host'), true)
  assert.equal(allows('host', 'participant'), false)
  assert.equal(allows('room', 'participant'), true)
})
