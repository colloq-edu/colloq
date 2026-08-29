/**
 * Память лекции: страница, чернила и потолки.
 *
 * Всё, что здесь проверяется, ломается молча и посреди пары. Штрих, у которого
 * сервер потерял продолжение, — это линия, оборванная на середине формулы у
 * двадцати человек сразу; потолок, который не сработал, — это браузер
 * опоздавшего, который минуту разбирает приветственную пачку; ведущий,
 * определённый неверно, — это чужой планшет, листающий вашу лекцию.
 *
 * Никакой сети: это чистая память процесса, и проверять её надо там, где она
 * живёт, а не через сокет.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addInk,
  clearInk,
  forgetLecture,
  inkOf,
  isPresenter,
  lectureOf,
  moveLecture,
  setBlank,
  startLecture,
  stopLecture,
  turnTo,
  undoInk,
} from '../server/src/lecture.js'

let n = 0
/** Своя комната на каждый тест: модуль — общая память процесса. */
function room(): string {
  const id = `lec${++n}`
  startLecture(id, { file: 'slides.pdf', by: 'teacher', byName: 'Ада', color: '#d4162f' })
  return id
}

test('лекция начинается с первой страницы и не погашенной', () => {
  const id = room()
  const state = lectureOf(id)
  assert.equal(state?.page, 1)
  assert.equal(state?.blank, false)
  assert.equal(state?.file, 'slides.pdf')
})

test('ведущий — тот, кто начал, и только он', () => {
  const id = room()
  assert.equal(isPresenter(id, 'teacher'), true)
  assert.equal(isPresenter(id, 'student'), false)
  // Комната без лекции не даёт пульт никому: иначе `lecture:page` от вкладки,
  // не узнавшей о конце лекции, воскресил бы её у всех.
  assert.equal(isPresenter('нет такой комнаты', 'teacher'), false)
})

test('вторая попытка перехватывает пульт и стирает чернила прошлой лекции', () => {
  const id = room()
  addInk(id, { id: 's1', page: 1, color: '#000', width: 0.004, points: [0.1, 0.1] })
  startLecture(id, { file: 'other.pdf', by: 'second', byName: 'Борис', color: '#0f2d69' })
  assert.equal(isPresenter(id, 'teacher'), false)
  assert.equal(isPresenter(id, 'second'), true)
  assert.deepEqual(inkOf(id), [])
})

test('страница не уходит ниже первой и не рассылается, когда не менялась', () => {
  const id = room()
  assert.equal(turnTo(id, 4)?.page, 4)
  // Ноль и минус — не «предыдущая», а мусор из вкладки; страницы ноль не бывает.
  assert.equal(turnTo(id, 0)?.page, 1)
  assert.equal(turnTo(id, 1), null, 'та же страница — рассылать нечего')
  assert.equal(turnTo(id, 2.7)?.page, 2, 'дробная страница округляется вниз')
})

test('пауза переключается один раз', () => {
  const id = room()
  assert.equal(setBlank(id, true)?.blank, true)
  assert.equal(setBlank(id, true), null)
  assert.equal(setBlank(id, false)?.blank, false)
})

test('штрих дописывается по имени, а рассылаются только новые точки', () => {
  const id = room()
  const first = addInk(id, { id: 's1', page: 2, color: '#111', width: 0.004, points: [0, 0, 0.1, 0.1] })
  assert.deepEqual(first?.points, [0, 0, 0.1, 0.1])

  const more = addInk(id, { id: 's1', page: 2, color: '#111', width: 0.004, points: [0.2, 0.2] })
  assert.deepEqual(more?.points, [0.2, 0.2], 'в рассылку идёт только продолжение')
  assert.equal(more?.id, 's1')

  // А в памяти — целый штрих: опоздавший получает его одним куском.
  assert.deepEqual(inkOf(id)[0].points, [0, 0, 0.1, 0.1, 0.2, 0.2])
  assert.equal(inkOf(id).length, 1)
})

test('точка без пары и нечисла не доезжают', () => {
  const id = room()
  assert.equal(addInk(id, { id: 's1', page: 1, color: '#111', width: 0.004, points: [0.5] }), null)
  assert.equal(
    addInk(id, { id: 's2', page: 1, color: '#111', width: 0.004, points: [Number.NaN, Infinity] }),
    null,
  )
  assert.deepEqual(inkOf(id), [])
})

test('чернила в комнату без лекции не пишутся вовсе', () => {
  assert.equal(
    addInk('пусто', { id: 's1', page: 1, color: '#111', width: 0.004, points: [0, 0] }),
    null,
  )
  assert.deepEqual(inkOf('пусто'), [])
})

test('потолки: точек в кадре, точек в штрихе, штрихов на странице, страниц', () => {
  const id = room()

  // Кадр обрезается, а не отбрасывается: лучше кусок линии, чем её отсутствие.
  const flood = Array.from({ length: 2_000 }, () => 0.5)
  assert.equal(addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: flood })?.points.length, 512)

  // Штрих: палец, забытый на экране, перестаёт расти.
  for (let i = 0; i < 20; i += 1) {
    addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: flood })
  }
  assert.ok(inkOf(id)[0].points.length <= 4_000 + 512)
  assert.equal(
    addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: [0.1, 0.1] }),
    null,
    'дописать переполненный штрих нельзя',
  )

  // Штрихи на странице.
  for (let i = 0; i < 700; i += 1) {
    addInk(id, { id: `s${i}`, page: 3, color: '#111', width: 0.004, points: [0, 0] })
  }
  assert.equal(inkOf(id).filter((stroke) => stroke.page === 3).length, 600)

  // Исписанные страницы: приветственная пачка обязана оставаться конечной.
  for (let page = 10; page < 400; page += 1) {
    addInk(id, { id: `p${page}`, page, color: '#111', width: 0.004, points: [0, 0] })
  }
  const pages = new Set(inkOf(id).map((stroke) => stroke.page))
  assert.equal(pages.size, 200)
})

test('отменяется последний штрих и только на своей странице', () => {
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'b', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'c', page: 2, color: '#111', width: 0.004, points: [0, 0] })

  assert.equal(undoInk(id, 1), 'b')
  assert.equal(undoInk(id, 1), 'a')
  assert.equal(undoInk(id, 1), null, 'на пустой странице отменять нечего')
  assert.equal(inkOf(id).length, 1)
})

test('стирается страница или вся лекция', () => {
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'b', page: 2, color: '#111', width: 0.004, points: [0, 0] })

  clearInk(id, 1)
  assert.deepEqual(inkOf(id).map((stroke) => stroke.page), [2])
  clearInk(id)
  assert.deepEqual(inkOf(id), [])
})

test('переименование файла уводит за собой лекцию, а чужую не трогает', () => {
  const id = room()
  assert.equal(moveLecture(id, 'other.pdf', 'renamed.pdf'), null)
  assert.equal(moveLecture(id, 'slides.pdf', 'lecture-01.pdf')?.file, 'lecture-01.pdf')
  assert.equal(lectureOf(id)?.file, 'lecture-01.pdf')
})

test('конец лекции уносит и чернила', () => {
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  stopLecture(id)
  assert.equal(lectureOf(id), null)
  assert.deepEqual(inkOf(id), [])

  const again = room()
  addInk(again, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  forgetLecture(again)
  assert.equal(lectureOf(again), null)
})
