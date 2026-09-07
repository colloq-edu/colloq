/**
 * Общий контракт: обещание совпадает с делом.
 *
 * Всё ниже ломается молча и у всей комнаты сразу: полоса «Идёт лекция»,
 * пропавшая от переключателя, который прав не менял; строка в журнале ядра,
 * говорящая пятистам людям, что их работу отменили; адрес опубликованной
 * страницы, собранный не тем полем; путь, у которого две записи.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  COUNCIL_ROOM,
  isCouncilRoom,
  isLectureRoom,
  LECTURE_ROOM,
  OPEN_ROOM,
  readRules,
  rulesAfterClass,
} from '../shared/rules.js'
import { LIMITS } from '../shared/admin.js'
import { normalizePath } from '../shared/paths.js'
import { publicationAddress } from '../shared/publish.js'
import {
  clearStaleExecution,
  clearStaleWork,
  createCell,
  createChatEntry,
  ensureInitialNotebook,
  getCells,
  getChat,
  getMeta,
} from '../shared/notebook.js'

/* ------------------------------------------------------------------ лекция */

test('лекция остаётся лекцией от переключателей, которые прав не меняли', () => {
  /*
   * Полоса «Идёт лекция» над тетрадью — единственное объяснение серой тетради
   * у пятисот человек. Она гасла от контрольной с выключенным оракулом, от
   * закрытой истории и от своего потолка вопросов: `isLectureRoom` сравнивала
   * ВСЕ поля пресета, а лекция — про то, кто печатает и запускает.
   */
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, oracle: 'off' }), true, 'контрольная')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, history: 'host' }), true, 'закрытая история')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, questionsPerHour: 5 }), true, 'свой потолок')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, slowModeSeconds: 30 }), true, 'свой промежуток')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, model: 'gpt-4o-mini' }), true, 'своя модель')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, opens: 'council' }), true, 'консилиум')
  // Выключенный агент строже лекционного, а не мягче: из лекций не выписывает.
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, agent: 'off' }), true, 'агент выключен')
  // И всё это вместе — то, как выглядит настоящая контрольная.
  assert.equal(
    isLectureRoom({
      ...LECTURE_ROOM,
      oracle: 'off',
      history: 'host',
      agent: 'off',
      questionsPerHour: 5,
    }),
    true,
  )
})

test('отпущенное право — уже не лекция', () => {
  for (const key of ['run', 'edit', 'structure', 'board', 'files', 'wipe', 'restart'] as const) {
    assert.equal(
      isLectureRoom({ ...LECTURE_ROOM, [key]: 'room' }),
      false,
      `правило ${key} отпустили, а комната всё ещё лекция`,
    )
  }
  // Агент, отданный комнате, — то же самое: это право, а не свойство.
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, agent: 'room' }), false)
  assert.equal(isLectureRoom(OPEN_ROOM), false)
  assert.equal(isCouncilRoom({ ...COUNCIL_ROOM, oracle: 'off' }), true)
})

test('закончившееся занятие читается лекцией — при любых правилах, из которых его закончили', () => {
  /*
   * Это стоит знать в лицо: права после звонка — неподвижная точка, так что
   * ЛЮБАЯ законченная комната отвечает здесь «да». Спрашивать этим «занятие
   * идёт по-лекционному» нельзя, для конца пары есть свой признак.
   */
  assert.equal(isLectureRoom(rulesAfterClass(OPEN_ROOM)), true)
  assert.equal(isLectureRoom(rulesAfterClass({ ...OPEN_ROOM, agent: 'off' })), true)
  assert.equal(isLectureRoom(rulesAfterClass(COUNCIL_ROOM)), true)
})

test('имя модели комнаты мерится тем же потолком, что и модель инстанса', () => {
  // Своё число резало имя до 80 знаков против 120 на инстансе — то есть
  // комната, которой это однажды включат, спрашивала бы обрубок.
  const long = 'm'.repeat(LIMITS.model + 10)
  assert.equal(readRules({ model: long }).model?.length, LIMITS.model)
  assert.equal(readRules({ model: 'a'.repeat(100) }).model?.length, 100)
})

/* ------------------------------------------------------------------- пути */

test('normalizePath сводит разделители и не трогает ни одного имени', () => {
  // Каноническая запись — это про запись пути, а не про то, где окажется файл.
  assert.equal(normalizePath('a//b'), 'a/b')
  assert.equal(normalizePath('data/'), 'data')
  assert.equal(normalizePath('a//b/'), 'a/b')
  // А имя не чинится никогда: не подошло — отвергнут весь путь.
  assert.equal(normalizePath('data/.env'), null)
  assert.equal(normalizePath('data/train .csv '), null)
  assert.equal(normalizePath('../etc/passwd'), null)
  assert.equal(normalizePath('/data/train.csv'), null)
  // Корень — пустая строка, и это не отказ.
  assert.equal(normalizePath(''), '')
})

/* --------------------------------------------------------------- публикация */

test('адрес страницы — имя, если оно есть', () => {
  assert.equal(publicationAddress({ id: 'x9tb4kwm', slug: 'ml-2026-w4' }), 'ml-2026-w4')
  assert.equal(publicationAddress({ id: 'x9tb4kwm', slug: null }), 'x9tb4kwm')
  // Сервер, который поля ещё не шлёт, оставляет запасной вход — это правда, а
  // не догадка: `/p/<id>` открывается.
  assert.equal(publicationAddress({ id: 'x9tb4kwm' }), 'x9tb4kwm')
})

/* ------------------------------------------------------- перезапуск сервера */

/** Комната, которую застали посреди ответа оракула и без единого запуска. */
function midAnswer(): Y.Doc {
  const doc = new Y.Doc()
  ensureInitialNotebook(doc, 'Week 4')
  getChat(doc).push([
    createChatEntry({ participantId: 'p1', name: 'Мария', color: '#c273e6', question: 'почему?' }),
  ])
  return doc
}

test('оборванный ход оракула не считается за сброшенные ячейки', () => {
  /*
   * `cells` уходит в строку журнала ядра «Cells that were running or queued
   * were put back to rest». Под одним счётчиком туда попадал и ход оракула: в
   * комнате не считалась ни одна ячейка, а класс читал, что его работу
   * отменили.
   */
  const doc = midAnswer()
  const work = clearStaleWork(doc)
  assert.equal(work.cells, 0, 'ячейки, которых не было, посчитаны сброшенными')
  assert.equal(work.turns, 1)
  // Сам ход при этом успокоен и сказал о себе словами — прямо в треде.
  assert.equal(getChat(doc).get(0).get('state'), 'error')
})

test('ячейки и ходы считаются порознь, а старое имя считает ячейки', () => {
  const doc = midAnswer()
  const cells = getCells(doc)
  doc.transact(() => {
    cells.push([createCell('code', 'train()')])
    cells.get(1).set('state', 'running')
    getMeta(doc).set('runningCell', cells.get(1).get('id'))
    cells.get(cells.length - 1).set('state', 'queued')
  })
  const work = clearStaleWork(doc)
  assert.equal(work.cells, 2, 'работавшая и стоявшая в очереди')
  assert.equal(work.turns, 1, 'ход оракула')

  // А старое имя отвечает тем же числом ячеек — им и решают, объяснять ли
  // комнате строкой про ячейки.
  const again = midAnswer()
  const more = getCells(again)
  again.transact(() => more.get(1).set('state', 'running'))
  assert.equal(clearStaleExecution(again), 1)
})
