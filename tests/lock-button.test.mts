/**
 * Замок на ячейке глазами преподавателя: что делает щелчок и что обещает
 * подсказка.
 *
 * Сервер на `cell:open` открывает так, как заведено в комнате (control.ts ·
 * `opens`), и кнопка обязана читать то же правило. Иначе в консилиумной
 * комнате подсказка обещала «открыть комнате» и намекала, что консилиум —
 * только удержанием, а после первого щелчка второй раскрывал меню вместо
 * того, чтобы закрыть ячейку: «ошибка чинится тем же нажатием» переставало
 * быть правдой ровно там, где нажимают посреди фразы.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockHint, lockLabel, lockPress } from '../web/src/lib/lock-button.js'

test('в лекции щелчок — закрыта ↔ открыта всем, консилиум за меню', () => {
  assert.deepEqual(lockPress('closed', 'shared'), { kind: 'open', open: true })
  assert.deepEqual(lockPress('open', 'shared'), { kind: 'open', open: false })
  // В консилиум щелчком не попадали — щелчок по нему открывает меню.
  assert.deepEqual(lockPress('council', 'shared'), { kind: 'menu' })

  assert.equal(lockLabel('closed', 'shared'), 'Открыть эту ячейку комнате')
  assert.equal(lockLabel('open', 'shared'), 'Закрыть эту ячейку')
  assert.equal(lockLabel('council', 'shared'), 'Консилиум — положение замка')
  assert.equal(lockHint('closed', 'shared'), 'Открыть эту ячейку комнате · удержать — консилиум')
  assert.equal(lockHint('open', 'shared'), 'Закрыть её · удержать — консилиум')
  assert.equal(lockHint('council', 'shared'), 'Консилиум · щелчок — положения замка')
})

test('в консилиуме щелчок — закрыта ↔ консилиум, и второе нажатие закрывает', () => {
  // Первый щелчок открывает (сервер сделает из него консилиум по правилу).
  assert.deepEqual(lockPress('closed', 'council'), { kind: 'open', open: true })
  // Второй — закрывает, а не раскрывает меню: промах чинится тем же нажатием.
  assert.deepEqual(lockPress('council', 'council'), { kind: 'open', open: false })
  // Открытую всем через меню тоже закрывает щелчок.
  assert.deepEqual(lockPress('open', 'council'), { kind: 'open', open: false })

  // Подсказка обещает ровно то, что случится: консилиум, а не общий текст.
  assert.equal(lockLabel('closed', 'council'), 'Открыть эту ячейку консилиумом')
  assert.equal(lockLabel('council', 'council'), 'Закрыть эту ячейку')
  assert.equal(lockLabel('open', 'council'), 'Закрыть эту ячейку')
  assert.equal(
    lockHint('closed', 'council'),
    'Открыть эту ячейку консилиумом · удержать — открыть всем',
  )
  assert.equal(lockHint('council', 'council'), 'Закрыть её · удержать — открыть всем')
  assert.equal(lockHint('open', 'council'), 'Закрыть её · удержать — положения замка')
  // Ни одна подсказка консилиумной комнаты не обещает общий текст щелчком.
  for (const state of ['closed', 'open', 'council'] as const) {
    assert.equal(lockHint(state, 'council').includes('комнате'), false)
    assert.equal(lockLabel(state, 'council').includes('комнате'), false)
  }
})
