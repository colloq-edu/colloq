/**
 * One button for every execution state of a cell.
 *
 * Before this, the first slot in the toolbar always drew "run" — on a running
 * cell too. The button was enabled, promised an action and did nothing:
 * `requestRun` on the server skips both what is already running and what is
 * already queued. A lie like that is silent, which is why it is pinned here.
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

test('a settled cell offers to run', () => {
  for (const state of ['idle', 'ok', 'error'] as const) {
    const slot = runSlot(state, OPEN)
    assert.equal(slot.action, 'run', state)
    assert.equal(slot.icon, 'play')
    assert.equal(slot.tint, 'text-accent-text')
    assert.equal(slot.disabled, false)
  }
})

test('a queued cell offers cancel and never run', () => {
  const slot = runSlot('queued', OPEN)
  assert.equal(slot.action, 'cancel')
  assert.equal(slot.icon, 'x')
  assert.notEqual(slot.action, 'run')
})

test('a running cell offers stop and never run', () => {
  const slot = runSlot('running', OPEN)
  assert.equal(slot.action, 'interrupt')
  assert.equal(slot.icon, 'stop')
  assert.notEqual(slot.action, 'run')
})

test('a ban on running disables the button but does not change its face', () => {
  const slot = runSlot('idle', { ...OPEN, mayRun: false })
  assert.equal(slot.icon, 'play', 'the face changed on a refusal')
  assert.equal(slot.disabled, true)
  assert.match(slot.title, /only the teacher/i)
})

test('a running cell somebody else started is a dimmed square, not "run"', () => {
  const slot = runSlot('running', { ...OPEN, canInterrupt: false })
  assert.equal(slot.icon, 'stop', 'a running cell somebody else started offered to run')
  assert.equal(slot.disabled, true)
  assert.match(slot.title, /whoever started it/i)
})

test('a cell somebody else queued is a dimmed cross, and the phrase promises no permission', () => {
  const slot = runSlot('queued', { ...OPEN, canCancel: false })
  assert.equal(slot.icon, 'x')
  assert.equal(slot.disabled, true)
  assert.match(slot.title, /queued it/i)
  assert.notEqual(slot.title, 'Take this cell out of the queue')
})

test('a lost connection overrides any other reason', () => {
  for (const state of ['idle', 'queued', 'running'] as const) {
    const slot = runSlot(state, { connected: false, mayRun: true, canCancel: true, canInterrupt: true })
    assert.equal(slot.title, tr(OFFLINE_REASON), state)
    assert.equal(slot.disabled, true, state)
    // The face stays: the icon still tells the truth about what the cell is doing.
    assert.equal(slot.action, runSlot(state, OPEN).action, state)
  }
})

test('a lost connection enables nothing', () => {
  const offline = runSlot('running', { connected: false, mayRun: false, canCancel: false, canInterrupt: false })
  assert.equal(offline.disabled, true)
})
