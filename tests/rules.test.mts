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
  allowsAgent,
  allowsStructure,
  isLectureRoom,
  isOpenRoom,
  LECTURE_ROOM,
  mayEditCell,
  mayRunCell,
  OPEN_ROOM,
  oracleLimitsIn,
  readRules,
  rulesAfterClass,
  runQueueCap,
} from '../shared/rules.js'
import { LIMITS } from '../shared/admin.js'

test('семинар, записанный до новых полей, открывается прежним', () => {
  // Ровно то, что лежит в базе у семинаров, заведённых раньше.
  const stored = {
    run: 'room',
    edit: 'room',
    structure: 'room',
    terminal: 'room',
    files: 'room',
    oracle: 'inherit',
    model: null,
  }
  const read = readRules(stored)
  assert.equal(read.run, 'room')
  assert.equal(read.structure, 'room')
  // Новые три отсутствовали вовсе — читаются умолчаниями.
  assert.equal(read.wipe, 'host')
  assert.equal(read.restart, 'host')
  assert.equal(read.history, 'room')
  // И такая комната по-прежнему считается «продуктом как он есть».
  assert.equal(isOpenRoom(read), true, 'старый семинар перестал быть открытой комнатой')
})

test('строгое значение из старой записи тоже переживает', () => {
  const read = readRules({ run: 'host', structure: 'host', wipe: 'room' })
  assert.equal(read.run, 'host')
  assert.equal(read.structure, 'host')
  assert.equal(read.wipe, 'room')
})

test('незнакомое значение падает на разрешительное, а не на строгое', () => {
  // Правило, которое от испорченной строки становится строже, запирает комнату
  // посреди пары и объяснить это некому.
  const read = readRules({ run: 'sometimes', structure: 42, wipe: 'everyone' })
  assert.equal(read.run, OPEN_ROOM.run)
  assert.equal(read.structure, OPEN_ROOM.structure)
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
  assert.equal(
    allowsStructure('add', 'participant', 'move'),
    false,
    'переставить в никуда — обход запрета убирать',
  )
  for (const verb of ['add', 'remove', 'move'] as const) {
    assert.equal(allowsStructure('add', 'host', verb), true)
    assert.equal(allowsStructure('host', 'participant', verb), false)
    assert.equal(allowsStructure('room', 'participant', verb), true)
  }
})

test('allows не забывает про преподавателя', () => {
  assert.equal(allows('host', 'host'), true)
  assert.equal(allows('host', 'participant'), false)
  assert.equal(allows('room', 'participant'), true)
})

test('режим «сделать» по умолчанию преподавательский, и «никто» закрывает его всем', () => {
  assert.equal(OPEN_ROOM.agent, 'host')
  assert.equal(allowsAgent('host', 'host'), true)
  assert.equal(allowsAgent('host', 'participant'), false)
  assert.equal(allowsAgent('room', 'participant'), true)
  /*
   * `off` — свойство комнаты, а не чьё-то право: «в этом семинаре оракул файлы
   * не трогает» верно и для преподавателя. Тот же довод, что был у оболочки,
   * когда она была.
   */
  assert.equal(allowsAgent('off', 'host'), false)
})

test('старая строка правил читается без режима «сделать», а не ломается об него', () => {
  const old = readRules(JSON.stringify({ run: 'room', edit: 'room' }))
  assert.equal(old.agent, 'host', 'семинар, созданный до режима, вдруг разрешил бы его всем')
})

/* ------------------------------------------------------------------ лекция */

test('лекция закрывает всё, что делают руками, и не трогает то, чем смотрят', () => {
  for (const key of ['run', 'edit', 'structure', 'board', 'files', 'wipe', 'restart'] as const) {
    assert.equal(LECTURE_ROOM[key], 'host', `в лекции открыто правило ${key}`)
  }
  assert.equal(LECTURE_ROOM.agent, 'host')
  // Читать историю и спрашивать оракула лекция не запрещает: она про то, кто
  // печатает и запускает, а не про то, кому смотреть.
  assert.equal(LECTURE_ROOM.history, OPEN_ROOM.history)
  assert.equal(LECTURE_ROOM.oracle, OPEN_ROOM.oracle)
  assert.equal(LECTURE_ROOM.model, OPEN_ROOM.model)
  // И записанная в базу лекция читается лекцией, а не падает на умолчания.
  assert.equal(isLectureRoom(readRules(JSON.stringify(LECTURE_ROOM))), true)
})

test('лекция и открытая комната — не одно и то же, а конец занятия читается лекцией', () => {
  assert.equal(isLectureRoom(LECTURE_ROOM), true)
  assert.equal(isLectureRoom(OPEN_ROOM), false)
  assert.equal(isOpenRoom(LECTURE_ROOM), false)
  // Одно значение мимо — и это уже не пресет: иначе панель показывала бы
  // «лекция» комнате, в которой преподаватель что-то приоткрыл.
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, edit: 'room' }), false)
  /*
   * А это стоит знать в лицо: `rulesAfterClass` любой комнаты даёт ровно
   * лекционные значения. По сути верно — печатает и запускает один
   * преподаватель, — но спрашивать этим «занятие идёт по-лекционному» нельзя.
   */
  assert.equal(isLectureRoom(rulesAfterClass(OPEN_ROOM)), true)
})

test('открытая ячейка даёт набор и запуск там, где правило их закрыло', () => {
  const closed = false
  const open = true
  // Лекция: тетрадь преподавательская, и единственная дверь — открытая ячейка.
  assert.equal(mayEditCell(LECTURE_ROOM, 'participant', closed, false), false)
  assert.equal(mayEditCell(LECTURE_ROOM, 'participant', open, false), true)
  assert.equal(mayRunCell(LECTURE_ROOM, 'participant', closed, false), false)
  assert.equal(mayRunCell(LECTURE_ROOM, 'participant', open, false), true)
  // Преподавателю замок ничего не меняет: он пишет и запускает везде.
  assert.equal(mayEditCell(LECTURE_ROOM, 'host', closed, false), true)
  assert.equal(mayRunCell(LECTURE_ROOM, 'host', closed, false), true)
  // В открытой комнате замок тоже ничего не меняет — там и так всё можно.
  assert.equal(mayEditCell(OPEN_ROOM, 'participant', closed, false), true)
  assert.equal(mayRunCell(OPEN_ROOM, 'participant', closed, false), true)
  // «По одной» и без замка пускает нажатие на ячейке — замок его не ужесточает.
  assert.equal(mayRunCell({ ...OPEN_ROOM, run: 'single' }, 'participant', closed, false), true)
})

test('конец занятия сильнее замка', () => {
  /*
   * Иначе «Закончить занятие» оставляло бы комнате столько дверей, сколько
   * преподаватель успел открыть за пару, и закрывать их пришлось бы по одной.
   */
  assert.equal(mayEditCell(LECTURE_ROOM, 'participant', true, true), false)
  assert.equal(mayRunCell(LECTURE_ROOM, 'participant', true, true), false)
  // Даже в комнате, где правила разрешают всё: занятие кончилось у всей комнаты.
  assert.equal(mayEditCell(OPEN_ROOM, 'participant', true, true), false)
  assert.equal(mayRunCell(OPEN_ROOM, 'participant', true, true), false)
  // А преподаватель после пары действует: комната остаётся живой.
  assert.equal(mayEditCell(LECTURE_ROOM, 'host', false, true), true)
  assert.equal(mayRunCell(LECTURE_ROOM, 'host', false, true), true)
})

/* ------------------------------------------------------ потолки оракула */

test('потолки оракула читаются тотально: мусор и отсутствие — «как на инстансе»', () => {
  // Ни одного из этих значений комната не должна принять за число: правило,
  // собранное из мусора, тише всего ломает именно расход.
  const junk = readRules({
    questionsPerHour: 'много',
    slowModeSeconds: {},
  })
  assert.equal(junk.questionsPerHour, null)
  assert.equal(junk.slowModeSeconds, null)
  assert.equal(readRules({ slowModeSeconds: Number.NaN }).slowModeSeconds, null)
  assert.equal(readRules({ questionsPerHour: Number.POSITIVE_INFINITY }).questionsPerHour, null)

  // Старая строка не знала этих полей вовсе — и открывается как была.
  const old = readRules(JSON.stringify({ run: 'room', edit: 'room' }))
  assert.equal(old.questionsPerHour, null)
  assert.equal(old.slowModeSeconds, null)
  assert.equal(isOpenRoom(old), true, 'комната без потолков перестала быть открытой')
})

test('число зажимается той же линейкой, что и настройка инстанса', () => {
  assert.equal(
    readRules({ questionsPerHour: 99_999 }).questionsPerHour,
    LIMITS.questionsPerHour.max,
  )
  assert.equal(readRules({ slowModeSeconds: 9_999 }).slowModeSeconds, LIMITS.slowModeSeconds.max)
  assert.equal(readRules({ slowModeSeconds: -5 }).slowModeSeconds, LIMITS.slowModeSeconds.min)
  assert.equal(readRules({ questionsPerHour: 4.6 }).questionsPerHour, 5)
  /*
   * Пол — один вопрос, а не ноль: «оракула сегодня нет» — это `oracle: 'off'`,
   * у которого отказ говорит об этом словами, а ноль здесь развернул бы класс
   * фразой «использовано все 0 вопросов».
   */
  assert.equal(readRules({ questionsPerHour: 0 }).questionsPerHour, 1)
})

test('комната ужесточает потолки оракула и не ослабляет их', () => {
  const instance = { questionsPerHour: 20, slowModeSeconds: 10 }

  // Ничего не сказала — отвечает инстанс, и это умолчание любой комнаты.
  assert.deepEqual(oracleLimitsIn(OPEN_ROOM, instance), instance)

  // Строже — в разные стороны: вопросов меньше, промежуток длиннее.
  assert.deepEqual(
    oracleLimitsIn({ ...OPEN_ROOM, questionsPerHour: 5, slowModeSeconds: 60 }, instance),
    { questionsPerHour: 5, slowModeSeconds: 60 },
  )

  // А мягче нельзя ни тем, ни другим концом: за модель платит инстанс.
  assert.deepEqual(
    oracleLimitsIn({ ...OPEN_ROOM, questionsPerHour: 500, slowModeSeconds: 0 }, instance),
    instance,
  )

  // Выключенный оракул комнатным числом обратно не включается.
  assert.equal(
    oracleLimitsIn(
      { ...OPEN_ROOM, questionsPerHour: 50 },
      {
        questionsPerHour: 0,
        slowModeSeconds: 0,
      },
    ).questionsPerHour,
    0,
  )
})

test('конец занятия потолков оракула не трогает', () => {
  // Они про расход, а не про право: закрывать их звонком нечему.
  const after = rulesAfterClass({ ...OPEN_ROOM, questionsPerHour: 3, slowModeSeconds: 45 })
  assert.equal(after.questionsPerHour, 3)
  assert.equal(after.slowModeSeconds, 45)
})
