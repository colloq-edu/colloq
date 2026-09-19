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

  /*
   * Два режима замка зовутся одинаково везде, где о них говорят: в строке
   * правил, в меню замка и в подсказке. Разные имена одного и того же и есть
   * то, из-за чего «открытая ячейка» ничего не объясняла.
   */
  assert.equal(lockLabel('closed', 'shared'), 'Открыть ячейку: пишут вместе')
  assert.equal(lockLabel('open', 'shared'), 'Закрыть ячейку')
  assert.equal(lockLabel('council', 'shared'), 'Изменить доступ к ячейке')
  assert.equal(lockHint('closed', 'shared'), 'Открыть ячейку: пишут вместе · удержать — выбрать доступ')
  assert.equal(lockHint('open', 'shared'), 'Закрыть ячейку · удержать — выбрать доступ')
  assert.equal(lockHint('council', 'shared'), 'Консилиум · щелчок — настроить доступ к ячейке')
})

test('в консилиуме щелчок — закрыта ↔ консилиум, и второе нажатие закрывает', () => {
  // Первый щелчок открывает (сервер сделает из него консилиум по правилу).
  assert.deepEqual(lockPress('closed', 'council'), { kind: 'open', open: true })
  // Второй — закрывает, а не раскрывает меню: промах чинится тем же нажатием.
  assert.deepEqual(lockPress('council', 'council'), { kind: 'open', open: false })
  // Открытую всем через меню тоже закрывает щелчок.
  assert.deepEqual(lockPress('open', 'council'), { kind: 'open', open: false })

  // Подсказка обещает ровно то, что случится: консилиум, а не общий текст.
  assert.equal(lockLabel('closed', 'council'), 'Открыть консилиум в этой ячейке')
  assert.equal(lockLabel('council', 'council'), 'Закрыть ячейку')
  assert.equal(lockLabel('open', 'council'), 'Закрыть ячейку')
  assert.equal(
    lockHint('closed', 'council'),
    'Открыть консилиум в этой ячейке · удержать — выбрать доступ',
  )
  assert.equal(lockHint('council', 'council'), 'Закрыть ячейку · удержать — выбрать доступ')
  assert.equal(lockHint('open', 'council'), 'Закрыть ячейку · удержать — выбрать доступ')
  // Ни одна подсказка консилиумной комнаты не обещает общий текст щелчком.
  for (const state of ['closed', 'open', 'council'] as const) {
    assert.equal(lockHint(state, 'council').includes('комнате'), false)
    assert.equal(lockLabel(state, 'council').includes('комнате'), false)
  }
})
