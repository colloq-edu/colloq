/**
 * Командный режим тетради: чужое выделение и шаг за последнюю ячейку.
 *
 * Две беды в одном месте. Первая: `selectedCellId` один на комнату и при
 * переключении вкладки не сбрасывается — `d d`, `m`, `y` и Shift+Enter в
 * ОТКРЫТОЙ тетради действовали на ячейку в спрятанной, и тот, кто нажал, не
 * видел ничего. Вторая: Shift+Enter на последней ячейке в комнате, где состав
 * тетради преподавательский, отвечал красным тостом на каждый запуск — при
 * том что запуск состоялся.
 *
 * Обе ломаются молча и обе проверяются здесь на чистых решениях, без браузера.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectionHere, stepPlan } from '../web/src/components/notebook/command-mode.js'

const LIST = ['a', 'b', 'c']

test('выделение из этой тетради берётся как есть', () => {
  assert.deepEqual(selectionHere('b', LIST), { id: 'b', at: 1 })
  assert.deepEqual(selectionHere('a', LIST), { id: 'a', at: 0 })
})

test('выделение из ДРУГОЙ тетради считается пустым', () => {
  // Ячейка существует — но не здесь. `d d` не должна её удалить, `m` — сменить
  // вид, Shift+Enter — отправить на запуск в спрятанную вкладку.
  assert.deepEqual(selectionHere('чужая', LIST), { id: null, at: -1 })
  assert.deepEqual(selectionHere(null, LIST), { id: null, at: -1 })
})

test('пустая тетрадь не выдаёт ячейку из чужой', () => {
  assert.deepEqual(selectionHere('b', []), { id: null, at: -1 })
})

test('шаг идёт к соседу в обе стороны', () => {
  assert.deepEqual(stepPlan(LIST, 'a', 1), { kind: 'move', cellId: 'b' })
  assert.deepEqual(stepPlan(LIST, 'c', -1), { kind: 'move', cellId: 'b' })
})

test('удаление первой ячейки подхватывает соседа с другой стороны', () => {
  // fallback: вверх идти некуда, значит выделение уходит вниз.
  assert.deepEqual(stepPlan(LIST, 'a', -1, { fallback: true }), { kind: 'move', cellId: 'b' })
  assert.deepEqual(stepPlan(LIST, 'a', -1), { kind: 'stay' })
})

test('Shift+Enter на последней дописывает ячейку — если добавлять можно', () => {
  assert.deepEqual(stepPlan(LIST, 'c', 1, { grow: true, mayAdd: true }), { kind: 'grow', at: 3 })
})

test('без права добавлять Shift+Enter на последней просто остаётся на месте', () => {
  /*
   * Комната `run: room, structure: host`: считать можно всем, каркас
   * преподавательский. Запуск состоялся и был правильный — тост «Состав
   * тетради в этом семинаре — преподавательский» на каждое нажатие читался как
   * «запуск не прошёл».
   */
  assert.deepEqual(stepPlan(LIST, 'c', 1, { grow: true, mayAdd: false }), { kind: 'stay' })
  // И тем более не должен пытаться вставить: `grow` без права — не отказ, а
  // «выполнить и остаться», как у ⌘↵.
  assert.notEqual(stepPlan(LIST, 'c', 1, { grow: true, mayAdd: false }).kind, 'grow')
})

test('шаг от ячейки, которой в списке нет, не двигает ничего', () => {
  assert.deepEqual(stepPlan(LIST, 'нет такой', 1, { grow: true, mayAdd: true }), { kind: 'stay' })
})

test('без grow последняя ячейка ничего не дописывает', () => {
  assert.deepEqual(stepPlan(LIST, 'c', 1, { mayAdd: true }), { kind: 'stay' })
})
