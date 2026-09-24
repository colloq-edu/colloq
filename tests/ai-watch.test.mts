/**
 * The watchdog on a stream that went silent, shared by the notebook, the
 * council and the hint.
 *
 * This checks what it was moved into one place for: three outcomes that
 * look like one and the same abort from the outside but mean different
 * things. "Did not open the stream" is cured by a smaller contextChars,
 * "went silent in the middle" by a retry, and "Stop was pressed" is not a
 * failure at all. While this logic lived in one road out of three, the
 * council did not have it at all, and on 20 Sep 2026 a live class stared at
 * "reading" until the end of the class.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COUNCIL_WATCH, NOTEBOOK_WATCH, watchSilence } from '../server/src/ai/watch.js'

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('before the first frame it is "did not open the stream", not "went silent"', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 30, silenceMs: 500 })
  await tick(80)
  assert.equal(controller.signal.aborted, true)
  assert.equal(guard.why, 'opening')
  assert.equal(guard.spoke, false, 'there was not a single frame, so there is nothing to call "went silent"')
  guard.stop()
})

test('after the first frame the deadline is different, and every frame rearms it', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 1_000, silenceMs: 60 })
  for (let i = 0; i < 4; i++) {
    guard.heard()
    await tick(30)
    assert.equal(controller.signal.aborted, false, `aborted at frame ${i}`)
  }
  await tick(120)
  assert.equal(controller.signal.aborted, true)
  assert.equal(guard.why, 'silence')
  assert.equal(guard.spoke, true)
  guard.stop()
})

test('the ceiling for the whole request catches a stream that trickles one letter at a time', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 1_000, silenceMs: 100, capMs: 120 })
  // Frames arrive properly, so every silence deadline resets, but the class time runs out.
  const beat = setInterval(() => guard.heard(), 20)
  await tick(220)
  clearInterval(beat)
  assert.equal(controller.signal.aborted, true)
  assert.equal(guard.why, 'cap')
  guard.stop()
})

test('a manual abort does not count as silence: the watchdog gives no reason', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 1_000, silenceMs: 1_000, capMs: 1_000 })
  guard.heard()
  controller.abort()
  await tick(20)
  assert.equal(guard.why, null, 'Stop was pressed, so there was no failure')
  guard.stop()
})

test('a stopped watchdog no longer aborts', async () => {
  const controller = new AbortController()
  const guard = watchSilence(controller, { openingMs: 20, silenceMs: 20, capMs: 20 })
  guard.stop()
  await tick(80)
  assert.equal(controller.signal.aborted, false)
  assert.equal(guard.why, null)
})

test('deadlines are stated as numbers, not guesses: the council is shorter than the notebook', () => {
  assert.equal(COUNCIL_WATCH.openingMs, 90_000)
  assert.equal(COUNCIL_WATCH.silenceMs, 45_000)
  assert.equal(COUNCIL_WATCH.capMs, 180_000)
  // The notebook has no ceiling on purpose: the answer is read as it is written.
  assert.equal(NOTEBOOK_WATCH.capMs, undefined)
  assert.ok(NOTEBOOK_WATCH.openingMs > (COUNCIL_WATCH.openingMs ?? 0))
})
