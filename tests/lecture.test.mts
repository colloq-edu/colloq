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
  eraseInk,
  forgetLecture,
  handOver,
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

test('лекция по другому документу начинается начисто', () => {
  // Другой документ — другая лекция, и чернила от прошлой на его страницах
  // означали бы разметку, сделанную поверх чужого текста.
  const id = room()
  addInk(id, { id: 's1', page: 1, color: '#000', width: 0.004, points: [0.1, 0.1] })
  startLecture(id, { file: 'other.pdf', by: 'second', byName: 'Борис', color: '#0f2d69' })
  assert.equal(isPresenter(id, 'teacher'), false)
  assert.equal(isPresenter(id, 'second'), true)
  assert.deepEqual(inkOf(id), [])
})

test('передача пульта меняет руки и не трогает саму лекцию', () => {
  /*
   * Второму преподавателю нечем сказать «возьму управление»: кнопка «взять
   * пульт» шлёт тот же `lecture:start` по тому же файлу. Если он уйдёт в
   * `startLecture`, нажатие на сороковой минуте вернёт страницу на первую,
   * сотрёт всю разметку и обнулит часы — при всех, на проекторе.
   */
  const id = room()
  turnTo(id, 14)
  setBlank(id, true)
  addInk(id, { id: 's1', page: 14, color: '#000', width: 0.004, points: [0.1, 0.1] })
  const began = lectureOf(id)?.startedAt

  const taken = handOver(id, 'slides.pdf', 'second', 'Борис', '#0f2d69')
  assert.equal(taken?.by, 'second')
  assert.equal(taken?.byName, 'Борис')
  assert.equal(taken?.color, '#0f2d69')

  assert.equal(taken?.page, 14, 'страница вернулась к началу')
  assert.equal(taken?.blank, true, 'пауза снялась сама собой')
  assert.equal(taken?.startedAt, began, 'часы лекции пошли заново')
  assert.equal(inkOf(id).length, 1, 'разметка стёрлась')
  assert.equal(isPresenter(id, 'second'), true)
  assert.equal(isPresenter(id, 'teacher'), false)
})

test('передавать нечего, если файл другой или лекции нет вовсе', () => {
  // По другому документу это уже не передача рук, а новая лекция, и начинать
  // её надо начисто — здесь мы про это молчим и отдаём решение вызывающему.
  const id = room()
  assert.equal(handOver(id, 'other.pdf', 'second', 'Борис', '#0f2d69'), null)
  assert.equal(lectureOf(id)?.by, 'teacher')
  assert.equal(handOver('нет такой комнаты', 'slides.pdf', 'second', 'Борис', '#0f2d69'), null)
})

test('страница не уходит ниже первой и не рассылается, когда не менялась', () => {
  const id = room()
  assert.equal(turnTo(id, 4)?.page, 4)
  // Ноль — не страница, а мусор из вкладки: рассылать по нему нечего.
  assert.equal(turnTo(id, 0), null)
  assert.equal(lectureOf(id)?.page, 4, 'нулевая страница доехала до зала')
  assert.equal(turnTo(id, 4), null, 'та же страница — рассылать нечего')
  assert.equal(turnTo(id, 2.7)?.page, 2, 'дробная страница округляется вниз')
})

test('чистый лист — такая же страница, только с минусом', () => {
  /*
   * Слайд кончился, а вывод формулы нет: преподаватель заводит белое поле
   * прямо посреди лекции. Отдельным полем состояния это было бы вторым
   * источником правды о том, что сейчас на экране, и он разъехался бы с
   * номером страницы на первом же перелистывании. Поэтому чистый лист —
   * страница с отрицательным номером, и всё остальное про него уже работает.
   */
  const id = room()
  assert.equal(turnTo(id, -1)?.page, -1)
  addInk(id, { id: 'b1', page: -1, color: '#111', width: 0.004, points: [0.1, 0.1, 0.2, 0.2] })
  assert.deepEqual(inkOf(id).map((stroke) => stroke.page), [-1])

  // И возвращение к слайду ничего с ним не делает: чернила листа остаются на нём.
  assert.equal(turnTo(id, 3)?.page, 3)
  assert.equal(inkOf(id).length, 1)

  // Заевшая кнопка не заводит листов без конца.
  assert.equal(turnTo(id, -5000)?.page, -50)
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
  assert.deepEqual(first?.stroke?.points, [0, 0, 0.1, 0.1])

  const more = addInk(id, { id: 's1', page: 2, color: '#111', width: 0.004, points: [0.2, 0.2] })
  assert.deepEqual(more?.stroke?.points, [0.2, 0.2], 'в рассылку идёт только продолжение')
  assert.equal(more?.stroke?.id, 's1')

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
  assert.equal(
    addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: flood })?.stroke?.points
      .length,
    512,
  )

  // Штрих: палец, забытый на экране, перестаёт расти.
  for (let i = 0; i < 20; i += 1) {
    addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: flood })
  }
  assert.ok(inkOf(id)[0].points.length <= 4_000 + 512)
  /*
   * И это отказ ПО ИМЕНИ, а не молчание: `null` здесь означал бы «добавлять
   * нечего», и пульт восемь раз досылал бы штрих целиком, прежде чем молча
   * убрать его с листа. Три потолка — три разных слова человеку.
   */
  assert.deepEqual(
    addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: [0.1, 0.1] }),
    { full: 'stroke-full' },
    'дописать переполненный штрих нельзя, и об этом надо сказать',
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

test('ластик убирает названный штрих, а не последний', () => {
  /*
   * Отмена снимает ПОСЛЕДНИЙ, ластик — тот, до которого дотронулись. Разница
   * видна ровно тогда, когда она дорога: провели ластиком по первой из трёх
   * линий и получили бы вместо неё стёртую третью.
   */
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'b', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'c', page: 1, color: '#111', width: 0.004, points: [0, 0] })

  assert.equal(eraseInk(id, 1, 'a'), true)
  assert.deepEqual(inkOf(id).map((stroke) => stroke.id), ['b', 'c'])
})

test('ластик отвечает, был ли там штрих', () => {
  /*
   * Ластик проходит по одному штриху десяток раз за движение руки, и без
   * этого ответа каждое попадание рассылало бы «сотрите штрих, которого нет»
   * — двадцать браузеров перерисовывали бы страницу впустую.
   */
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })

  assert.equal(eraseInk(id, 1, 'a'), true)
  assert.equal(eraseInk(id, 1, 'a'), false, 'второй проход по тому же штриху')
  assert.equal(eraseInk(id, 1, 'нет такого'), false)
  // Страница называется в сообщении, и чужая не должна годиться: иначе ластик
  // на восьмом слайде стирал бы разметку с седьмого.
  addInk(id, { id: 'b', page: 2, color: '#111', width: 0.004, points: [0, 0] })
  assert.equal(eraseInk(id, 1, 'b'), false)
  assert.equal(eraseInk(id, 9, 'b'), false, 'страницы без чернил вовсе')
  assert.equal(inkOf(id).length, 1)
  assert.equal(eraseInk('нет такой комнаты', 1, 'a'), false)
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
