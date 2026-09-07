/**
 * Backspace, который удаляет ячейку у всей комнаты.
 *
 * Удержанная клавиша съедала ячейки ВВЕРХ по тетради: документ пустел, повтор
 * через ~30 мс уносил ячейку, фокус синхронно переезжал в предыдущую (CodeMirror
 * восстанавливает её последний курсор), и следующие повторы стирали её хвост, а
 * опустошив — удаляли и её. В открытой комнате это доступно любому студенту, и
 * удаляется ячейка вместе с выводом.
 *
 * Ошибка молчаливая в обе стороны: с ней всё «работает» до первого удержания, а
 * с лишней строгостью Backspace на пустой ячейке перестаёт работать вовсе.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backspaceRemovesCell,
  emptyCellIsRemovable,
} from '../web/src/components/notebook/cell-keys.js'

test('Backspace на пустой ячейке — намеренное нажатие — удаляет её', () => {
  assert.equal(backspaceRemovesCell({ empty: true, repeat: false }), true)
})

test('автоповтор на опустевшей ячейке не удаляет ничего', () => {
  // Тот самый кадр: последняя буква стёрта предыдущим повтором, палец на месте.
  assert.equal(backspaceRemovesCell({ empty: true, repeat: true }), false)
})

test('в непустой ячейке Backspace остаётся Backspace', () => {
  assert.equal(backspaceRemovesCell({ empty: false, repeat: false }), false)
  assert.equal(backspaceRemovesCell({ empty: false, repeat: true }), false)
})

test('пустой текст с выводом под ним — ещё не пустая ячейка', () => {
  assert.equal(emptyCellIsRemovable(0), true)
  assert.equal(emptyCellIsRemovable(1), false)
  assert.equal(emptyCellIsRemovable(12), false)
})
