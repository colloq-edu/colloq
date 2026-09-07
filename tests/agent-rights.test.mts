/**
 * Режим «сделать» и правила комнаты: чем ход отличается от рук просящего.
 *
 * Шапка agent.ts обещает, что ход правит «по правам того, кто попросил». Для
 * ячеек это проверялось (agent-cells.test.mts), а для файлов и запуска — нет, и
 * не выполнялось: в лекции с `files: 'host'` участник через оракула писал любой
 * файл папки семинара и запускал .py в общем контейнере. Правило, которое
 * обходится одной кнопкой, — не правило, и здесь оно закреплено отказом.
 *
 * Рядом — бюджет переписки: прочитанное файлом остаётся в разговоре и уезжает
 * провайдеру на КАЖДОМ следующем шаге, до двенадцати раз. Потолок чтения
 * поэтому считается от `contextChars`, а не стоит числом.
 *
 * И отмена: снимок кладётся только после удавшейся записи. Иначе у хода,
 * который ничего не изменил, появлялась кнопка «отменить», а нажатие обвиняло
 * несуществующего редактора.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSession, setRules } from '../server/src/db.js'
import { readText, sessionDir } from '../server/src/workspace.js'
import { toolsFor, undoTurn, useTool, type Hands } from '../server/src/ai/agent.js'
import { getOracleSettings, updateOracleSettings } from '../server/src/admin/settings.js'
import { createChatEntry, getChat } from '@shared/notebook'
import { getSessionDoc } from '../server/src/collab/index.js'
import { LECTURE_ROOM, OPEN_ROOM } from '@shared/rules'

const ROOM = 'agent-rights'
const BY = { name: 'Оракул', color: '#0FA0D7', participantId: 'p_oracle' }

function hands(entryId: string, role: 'host' | 'participant'): Hands {
  return { sessionId: ROOM, entryId, by: BY, role }
}

function turn(): string {
  const doc = getSessionDoc(ROOM).doc
  const entry = createChatEntry({
    participantId: BY.participantId,
    name: 'Петя',
    color: '#F97362',
    question: 'сделай',
    mode: 'agent',
  })
  doc.transact(() => getChat(doc).push([entry]))
  const id = entry.get('id') as string
  doc.transact(() => entry.set('undo', 'available'))
  return id
}

test('комната заводится', () => {
  createSession(ROOM, 'Права хода', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'train.py'), 'x = 1\n')
  fs.writeFileSync(path.join(sessionDir(ROOM), 'go.sh'), 'echo hi\n')
})

test('лекция: участнику ход файлы не пишет и скрипты не запускает', async () => {
  // Ровно та комната, где дыра и жила: оракулу ход дали, а печатать и запускать
  // студентам нельзя.
  setRules(ROOM, { ...LECTURE_ROOM, agent: 'room' })
  const id = turn()
  const student = hands(id, 'participant')

  const wrote = await useTool(
    student,
    'write_file',
    JSON.stringify({ path: 'solution.py', content: 'print(1)' }),
  )
  assert.equal(wrote.step.kind, 'note', 'участник записал файл при files: host')
  assert.match(wrote.said, /файлы правит преподаватель/i)
  assert.equal(readText(ROOM, 'solution.py'), null, 'файл всё-таки завёлся')

  const edited = await useTool(
    student,
    'edit_file',
    JSON.stringify({ path: 'train.py', find: 'x = 1', replace: 'x = 2' }),
  )
  assert.equal(edited.step.kind, 'note')
  assert.equal(readText(ROOM, 'train.py')?.text, 'x = 1\n', 'точечная правка прошла мимо правила')

  const ran = await useTool(student, 'run_file', JSON.stringify({ path: 'go.sh' }))
  assert.equal(ran.step.kind, 'note', 'участник запустил скрипт при run: host')
  assert.match(ran.said, /запускает преподаватель/i)

  // Читать по-прежнему можно: правило `files` в этом продукте про запись.
  const read = await useTool(student, 'read_file', JSON.stringify({ path: 'train.py' }))
  assert.equal(read.said, 'x = 1\n')

  // И инструментов, которые всё равно откажут, модели не показывают: шаг хода
  // не должен тратиться на выяснение правила, известного заранее.
  const offered = toolsFor(student).map((tool) => tool.name)
  assert.ok(!offered.includes('write_file'), 'write_file предложен тому, кому нельзя')
  assert.ok(!offered.includes('edit_file'))
  assert.ok(!offered.includes('run_file'))
  assert.ok(offered.includes('read_file'), 'чтение отняли вместе с записью')
})

test('преподавателю в той же комнате — можно', async () => {
  const id = turn()
  const teacher = hands(id, 'host')
  const wrote = await useTool(
    teacher,
    'write_file',
    JSON.stringify({ path: 'solution.py', content: 'print(1)' }),
  )
  assert.equal(wrote.step.kind, 'new', wrote.said)
  assert.equal(readText(ROOM, 'solution.py')?.text, 'print(1)')
  assert.ok(
    toolsFor(teacher)
      .map((t) => t.name)
      .includes('run_file'),
  )
})

test('открытая комната: участник пишет файлы своими руками — и руками оракула', async () => {
  setRules(ROOM, { ...OPEN_ROOM, agent: 'room' })
  const id = turn()
  const student = hands(id, 'participant')
  const wrote = await useTool(
    student,
    'write_file',
    JSON.stringify({ path: 'mine.py', content: 'print(2)' }),
  )
  assert.equal(wrote.step.kind, 'new', wrote.said)
  assert.equal(readText(ROOM, 'mine.py')?.text, 'print(2)')
  assert.ok(
    toolsFor(student)
      .map((t) => t.name)
      .includes('write_file'),
  )
})

test('потолок чтения считается от contextChars, а не стоит числом', async () => {
  const was = getOracleSettings().contextChars
  try {
    fs.writeFileSync(path.join(sessionDir(ROOM), 'big.py'), 'a'.repeat(20_000))
    // Маленькая модель на ноутбуке преподавателя: одно чтение на 60 000 знаков
    // переполняло её окно на втором шаге, и ход обрывался с 400 — уже после
    // того, как часть правок легла в файлы.
    updateOracleSettings({ contextChars: 40_000 })
    const first = await useTool(
      hands(turn(), 'host'),
      'read_file',
      JSON.stringify({ path: 'big.py' }),
    )
    assert.ok(
      first.said.length < 12_000,
      `прочитано ${first.said.length} знаков при бюджете 40 000`,
    )
    assert.match(first.said, /обрезано/)

    updateOracleSettings({ contextChars: 100_000 })
    const wide = await useTool(
      hands(turn(), 'host'),
      'read_file',
      JSON.stringify({ path: 'big.py' }),
    )
    assert.equal(wide.said.length, 20_000, 'на большом окне файл читается целиком')
  } finally {
    updateOracleSettings({ contextChars: was })
  }
})

test('запись не прошла — отменять нечего, и кнопки «отменить» быть не должно', async () => {
  const id = turn()
  // Завести файл внутри файла нельзя: mkdir по пути `train.py/…` — ENOTDIR.
  const tried = await useTool(
    hands(id, 'host'),
    'write_file',
    JSON.stringify({ path: 'train.py/child.py', content: 'нет' }),
  )
  assert.equal(tried.step.kind, 'note', tried.said)
  assert.match(tried.said, /Не получилось записать|не удалось/i)
  /*
   * `null`, а не `0`: снимка нет вовсе. Пока `remember` стоял ДО записи, снимок
   * оставался и от неудачи — ход получал `undo: 'available'`, а нажатие
   * дописывало под ним «не тронул: train.py/child.py — после этого хода файл
   * меняли или убрали». Файл никто не трогал, и ход не менял ничего.
   */
  assert.equal(undoTurn(ROOM, id, 'Ада'), null, 'у неудавшейся записи остался снимок для отмены')
})
