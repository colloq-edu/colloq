/**
 * Одна кнопка на все состояния выполнения ячейки.
 *
 * До этого первое место в тулбаре всегда рисовало «запустить» — и на
 * работающей ячейке тоже. Кнопка была включена, обещала действие и не делала
 * ничего: `requestRun` на сервере пропускает и то, что уже выполняется, и то,
 * что уже в очереди. Такая неправда молчит, поэтому она здесь и закреплена.
 */
import './_env.mts'
import { test, beforeEach, afterEach } from 'node:test'
import { setLocaleResolver, tr } from '../shared/i18n.js'
beforeEach(() => setLocaleResolver(() => 'en'))
afterEach(() => setLocaleResolver(() => 'ru'))
import assert from 'node:assert/strict'
import { runSlot } from '../web/src/lib/run-slot.js'
import { OFFLINE_REASON } from '../web/src/lib/controls.js'

const OPEN = { connected: true, mayRun: true, canCancel: true, canInterrupt: true }

test('успокоившаяся ячейка предлагает запуск', () => {
  for (const state of ['idle', 'ok', 'error'] as const) {
    const slot = runSlot(state, OPEN)
    assert.equal(slot.action, 'run', state)
    assert.equal(slot.icon, 'play')
    assert.equal(slot.tint, 'text-accent-text')
    assert.equal(slot.disabled, false)
  }
})

test('стоящая в очереди предлагает отмену и никогда — запуск', () => {
  const slot = runSlot('queued', OPEN)
  assert.equal(slot.action, 'cancel')
  assert.equal(slot.icon, 'x')
  assert.notEqual(slot.action, 'run')
})

test('работающая предлагает остановку и никогда — запуск', () => {
  const slot = runSlot('running', OPEN)
  assert.equal(slot.action, 'interrupt')
  assert.equal(slot.icon, 'stop')
  assert.notEqual(slot.action, 'run')
})

test('запрет на запуск гасит кнопку, но не меняет её лица', () => {
  const slot = runSlot('idle', { ...OPEN, mayRun: false })
  assert.equal(slot.icon, 'play', 'лицо сменилось на отказе')
  assert.equal(slot.disabled, true)
  assert.match(slot.title, /only the teacher/i)
})

test('чужая работающая ячейка — нарисованный погашенный квадрат, а не «пуск»', () => {
  const slot = runSlot('running', { ...OPEN, canInterrupt: false })
  assert.equal(slot.icon, 'stop', 'чужая работающая ячейка предложила запуск')
  assert.equal(slot.disabled, true)
  assert.match(slot.title, /whoever started it/i)
})

test('чужая очередь — погашенный крест, и фраза не обещает разрешения', () => {
  const slot = runSlot('queued', { ...OPEN, canCancel: false })
  assert.equal(slot.icon, 'x')
  assert.equal(slot.disabled, true)
  assert.match(slot.title, /queued it/i)
  assert.notEqual(slot.title, 'Take this cell out of the queue')
})

test('обрыв связи перебивает любую другую причину', () => {
  for (const state of ['idle', 'queued', 'running'] as const) {
    const slot = runSlot(state, { connected: false, mayRun: true, canCancel: true, canInterrupt: true })
    assert.equal(slot.title, tr(OFFLINE_REASON), state)
    assert.equal(slot.disabled, true, state)
    // Лицо остаётся: значок по-прежнему говорит правду о том, что делает ячейка.
    assert.equal(slot.action, runSlot(state, OPEN).action, state)
  }
})

test('обрыв связи ничего не включает', () => {
  const offline = runSlot('running', { connected: false, mayRun: false, canCancel: false, canInterrupt: false })
  assert.equal(offline.disabled, true)
})
