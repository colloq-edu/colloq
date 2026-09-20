/**
 * Сторож на замолчавший поток — общий для тетради, консилиума и подсказки.
 *
 * Проверяется то, ради чего он и вынесен в одно место: три исхода, которые
 * снаружи выглядят одной и той же отменой, но означают разное. «Не открыл
 * поток» лечится меньшим contextChars, «замолчал на середине» — повтором, а
 * «нажали Стоп» вообще не отказ. Пока эта логика жила в одной дороге из трёх,
 * у консилиума её не было вовсе — и 20.09 живое занятие смотрело на «читает»
 * до конца пары.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COUNCIL_WATCH, NOTEBOOK_WATCH, watchSilence } from '../server/src/ai/watch.js'

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('до первого кадра — «не открыл поток», и это не «замолчал»', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 30, silenceMs: 500 })
  await tick(80)
  assert.equal(controller.signal.aborted, true)
  assert.equal(guard.why, 'opening')
  assert.equal(guard.spoke, false, 'ни одного кадра не было — говорить «замолчал» не о чем')
  guard.stop()
})

test('после первого кадра срок другой, и каждый кадр взводит его заново', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 1_000, silenceMs: 60 })
  for (let i = 0; i < 4; i++) {
    guard.heard()
    await tick(30)
    assert.equal(controller.signal.aborted, false, `оборвался на кадре ${i}`)
  }
  await tick(120)
  assert.equal(controller.signal.aborted, true)
  assert.equal(guard.why, 'silence')
  assert.equal(guard.spoke, true)
  guard.stop()
})

test('потолок на весь запрос ловит поток, который сыплет по букве', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 1_000, silenceMs: 100, capMs: 120 })
  // Кадры идут исправно — все сроки молчания сбрасываются, а пара кончается.
  const beat = setInterval(() => guard.heard(), 20)
  await tick(220)
  clearInterval(beat)
  assert.equal(controller.signal.aborted, true)
  assert.equal(guard.why, 'cap')
  guard.stop()
})

test('отмена рукой не считается молчанием: сторож молчит о причине', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 1_000, silenceMs: 1_000, capMs: 1_000 })
  guard.heard()
  controller.abort()
  await tick(20)
  assert.equal(guard.why, null, 'нажали Стоп — отказа не было')
  guard.stop()
})

test('снятый сторож больше не обрывает', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 20, silenceMs: 20, capMs: 20 })
  guard.stop()
  await tick(80)
  assert.equal(controller.signal.aborted, false)
  assert.equal(guard.why, null)
})

test('сроки названы числами, а не догадкой: консилиум короче тетради', () => {
  assert.equal(COUNCIL_WATCH.openingMs, 90_000)
  assert.equal(COUNCIL_WATCH.silenceMs, 45_000)
  assert.equal(COUNCIL_WATCH.capMs, 180_000)
  // У тетради потолка нет намеренно: ответ читают по мере того, как он пишется.
  assert.equal(NOTEBOOK_WATCH.capMs, undefined)
  assert.ok(NOTEBOOK_WATCH.openingMs > (COUNCIL_WATCH.openingMs ?? 0))
})
