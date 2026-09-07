/**
 * Хранилище консилиума: чей вывод под чьим текстом, чего стоят числа полосы и
 * что происходит с оракулом снесённой комнаты.
 *
 * Здесь нет ни сокетов, ни ядра, ни модели — только `server/src/council.ts` и
 * то, что он обязан не перепутать. Три вещи ломаются молча и дорого.
 *
 * Первая: очередь ядра одна на комнату, ждать минуту на потоке в пятьсот
 * человек — обычное дело, и правка листа за это время тоже обычна. Кадр
 * запуска, посчитанного по ПРЕЖНЕМУ тексту, ложился под новый: карточка
 * показывала трейсбек программы, которой на ней нет, а преподаватель ставил
 * «верно» по чужому выводу.
 *
 * Вторая: числа полосы едут хосту трижды в секунду, пока класс печатает, и
 * считались через полную сборку стопки — SELECT участника и нормализация всего
 * текста на каждую из пятисот попыток ради четырёх чисел без единого имени.
 *
 * Третья: снесённый семинар. Ответ оракула, пришедший после удаления, заводил
 * кэш комнаты заново и писал строку в `council_oracle` для сессии, которой в
 * списке уже нет.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, db, forgetRules } from '../server/src/db.js'
import {
  attemptsOf,
  boardFor,
  countsFor,
  discardCouncil,
  oracleOf,
  recordRun,
  saveDraft,
  setOracle,
  submitAttempt,
} from '../server/src/council.js'
import { groupsOf, idleOracle } from '../server/src/ai/council.js'
import { normalizeAttempt, DEFAULT_COUNCIL } from '@shared/notebook'
import type { CouncilRun } from '@shared/protocol'

const CELL = 'c_task'
const SHEET = { lock: 'council' as const, settings: DEFAULT_COUNCIL }

let seq = 0
function room(): string {
  const id = `council-runs-${++seq}`
  createSession(id, 'Консилиум', null)
  return id
}

const queued: CouncilRun = {
  state: 'queued',
  outputs: [],
  execCount: null,
  ranMs: null,
  startedAt: 1_000,
  by: 'author',
}

function finished(text: string): CouncilRun {
  return {
    state: 'ok',
    outputs: [{ kind: 'stream', name: 'stdout', text }],
    execCount: 1,
    ranMs: 12,
    startedAt: 1_000,
    by: 'author',
  }
}

const crashed: CouncilRun = {
  state: 'error',
  outputs: [
    { kind: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: [] },
  ],
  execCount: 1,
  ranMs: null,
  startedAt: 1_000,
  by: 'author',
}

/* ------------------------------------------------- вывод под своим текстом */

test('вывод старого текста не ложится под новый', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'import time; time.sleep(20); 1/0', 1_000)
  assert.equal(recordRun(id, CELL, 'p_petya', queued), true, 'заявка на запуск не принята')
  assert.equal(attemptsOf(id, CELL)[0].run?.state, 'queued')

  // Пока попытка ждёт очереди, автор правит лист. Сама правка снимает запуск —
  // это уже проверено в council-server.test.mts.
  saveDraft(id, CELL, 'p_petya', 'x = 1', 2_000)
  assert.equal(attemptsOf(id, CELL)[0].run, null)

  // …и через двадцать секунд ядро досчитывает СТАРЫЙ исходник.
  assert.equal(recordRun(id, CELL, 'p_petya', crashed), false, 'опоздавший кадр приняли')
  const mine = attemptsOf(id, CELL)[0]
  assert.equal(mine.run, null, 'ZeroDivisionError лёг под «x = 1»')

  submitAttempt(id, CELL, 'p_petya', 3_000)
  const card = boardFor(id, CELL, SHEET).attempts[0]
  assert.equal(card.status, 'unrun', 'непроверенный текст помечен «упал»')
})

test('кадры своего запуска доезжают все до одного', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'print(1)', 1_000)
  recordRun(id, CELL, 'p_petya', queued)
  assert.equal(
    recordRun(id, CELL, 'p_petya', { ...queued, state: 'running' }),
    true,
    'кадр идущего запуска выброшен',
  )
  assert.equal(recordRun(id, CELL, 'p_petya', finished('1\n')), true)
  assert.equal(attemptsOf(id, CELL)[0].run?.state, 'ok')

  // Эхо того же текста ничего не снимает: текст не менялся.
  saveDraft(id, CELL, 'p_petya', 'print(1)', 2_000)
  assert.equal(attemptsOf(id, CELL)[0].run?.state, 'ok')
})

test('после правки новый запуск считается заново и доезжает', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'print(1)', 1_000)
  recordRun(id, CELL, 'p_petya', queued)
  saveDraft(id, CELL, 'p_petya', 'print(2)', 2_000)
  recordRun(id, CELL, 'p_petya', finished('1\n')) // опоздавший — выброшен

  recordRun(id, CELL, 'p_petya', queued)
  assert.equal(recordRun(id, CELL, 'p_petya', finished('2\n')), true)
  const run = attemptsOf(id, CELL)[0].run
  assert.equal(run?.state, 'ok')
  assert.deepEqual(run?.outputs, [{ kind: 'stream', name: 'stdout', text: '2\n' }])
})

test('снятие с очереди стирает запуск и у него же снимает отпечаток', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'print(1)', 1_000)
  recordRun(id, CELL, 'p_petya', queued)
  assert.equal(recordRun(id, CELL, 'p_petya', null), true)
  assert.equal(attemptsOf(id, CELL)[0].run, null)
  // Кадр запуска, который сняли, обратно не воскресает.
  assert.equal(recordRun(id, CELL, 'p_petya', finished('1\n')), false)
})

/* -------------------------------------------------------- числа для полосы */

test('числа полосы совпадают с полной стопкой — и считаются без имён', () => {
  const id = room()
  for (let i = 0; i < 40; i++) {
    // Три разных решения, каждое в нескольких написаниях: группы считаются по
    // нормализованному тексту, а не по буквам.
    const text = ['x = 1', 'x=1  # ответ', 'x = 2', 'y = 3'][i % 4]
    saveDraft(id, CELL, `p_${i}`, text, 1_000 + i)
    if (i % 5 !== 0) submitAttempt(id, CELL, `p_${i}`, 2_000 + i)
  }
  const board = boardFor(id, CELL, SHEET)
  assert.deepEqual(countsFor(id, CELL), board.counts)
  assert.equal(board.counts.attempts, 40)
  assert.equal(board.counts.groups, board.groups.length)
  assert.equal(board.counts.writing, board.counts.attempts - board.counts.submitted)

  // «x = 1» и «x=1  # ответ» — одна группа: ключ на строке тот же, что считает
  // normalizeAttempt, и он не пересчитывается на каждый кадр.
  assert.equal(attemptsOf(id, CELL)[0].groupKey, normalizeAttempt('x = 1'))
  assert.equal(attemptsOf(id, CELL)[1].groupKey, normalizeAttempt('x=1'))
  assert.equal(board.counts.groups, 3)
})

test('пустая ячейка — четыре нуля, а не отказ', () => {
  const id = room()
  assert.deepEqual(countsFor(id, 'c_nobody'), {
    attempts: 0,
    submitted: 0,
    writing: 0,
    groups: 0,
  })
})

/* ------------------------------------------------------------ группировка */

test('представитель группы у стопки и у оракула — один и тот же', () => {
  const id = room()
  // Сдали в одну миллисекунду: ничью решает время последней правки, и раньше
  // оракул её не знал вовсе — разрыв у него шёл по id, то есть представитель
  // мог оказаться не тем, что на карточке, и черновик лёг бы на чужую группу.
  saveDraft(id, CELL, 'p_zzz', 'x = 1', 1_000)
  saveDraft(id, CELL, 'p_aaa', 'x = 1', 2_000)
  submitAttempt(id, CELL, 'p_zzz', 5_000)
  submitAttempt(id, CELL, 'p_aaa', 5_000)

  const board = boardFor(id, CELL, SHEET)
  const oracle = groupsOf(attemptsOf(id, CELL))
  assert.equal(board.groups.length, 1)
  assert.equal(oracle.length, 1)
  assert.equal(board.groups[0].representative, 'p_zzz', 'раньше писал — он и представитель')
  assert.equal(oracle[0].representative, board.groups[0].representative)
  assert.equal(oracle[0].key, board.groups[0].key)
  assert.deepEqual(oracle[0].members, board.groups[0].members)
})

/* --------------------------------------------------------- снесённая комната */

test('сводка не воскрешает удалённый семинар', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'x = 1', 1_000)
  setOracle(id, CELL, { ...idleOracle(), state: 'ready', summary: ['было'] })
  assert.equal(oracleOf(id, CELL)?.summary[0], 'было')

  /*
   * Ровно тот порядок, в котором семинар сносят: сперва закрывается комната
   * (control.ts · closeControlRoom → discardCouncil), потом уходит строка
   * (routes/admin-instance.ts). Ответ модели приезжает уже после обоих: чтение
   * его обрывает `stopRoomOracles`, но между обрывом и ответом есть тик, и на
   * этот тик стоит второй замок.
   */
  discardCouncil(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  // И последняя строка того же маршрута: строка комнаты отвечает из памяти
  // (db.ts · forgetRoom), и удаление, забывшее это сказать, оставило бы
  // семинар живым для всех, кто спрашивает «а он ещё есть?».
  forgetRules(id)

  setOracle(id, CELL, { ...idleOracle(), state: 'ready', summary: ['опоздал'] })
  assert.equal(oracleOf(id, CELL), null, 'строка удалённого семинара воскресла')
  const rows = db
    .prepare('SELECT COUNT(*) AS n FROM council_oracle WHERE session_id = ?')
    .get(id) as { n: number }
  assert.equal(rows.n, 0, 'в council_oracle осталась строка снесённой комнаты')
})
