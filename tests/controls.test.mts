/**
 * What the room may press while the server cannot be reached.
 *
 * Measured in a browser with the sockets closed under the page: the header told
 * the truth — the kernel pill dimmed to "Last known" and a RECONNECTING spinner
 * appeared — and every Run button stayed fully lit beside it. Pressing Run
 * produced no queue position, no spinner, no word at all; the request went into
 * a queue and waited. Three presses on one cell came back as three runs when
 * the network returned.
 *
 * Two rules cover it: offline outranks every other reason a control is
 * disabled, and a press that lands in the queue lands there once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  controlDisabled,
  controlTitle,
  enqueueControl,
  MAX_QUEUED_CONTROL,
  OFFLINE_REASON,
} from '../web/src/lib/controls.js'
import type { ControlClientMessage } from '../shared/protocol.js'

/* ------------------------------------------------ what the button says */

test('connected, a control keeps its own reason', () => {
  assert.equal(controlTitle(true, 'Run every code cell'), 'Run every code cell')
  assert.equal(controlTitle(true, 'Only the host can restart the kernel'), 'Only the host can restart the kernel')
})

test('disconnected, the connection is the reason — not who you are', () => {
  // Telling a student "only the host can restart the kernel" while the room is
  // disconnected answers a question nobody asked and hides the one that matters.
  assert.equal(controlTitle(false, 'Only the host can restart the kernel'), OFFLINE_REASON)
  assert.equal(controlTitle(false, 'Run cell'), OFFLINE_REASON)
})

test('the offline sentence says what to expect, not just what is wrong', () => {
  // По-русски, как и вся поверхность, куда она приезжает.
  assert.match(OFFLINE_REASON, /связ/i)
  // «возвращения» — это ожидание, а не отказ. Шапка уже крутит спиннер.
  assert.match(OFFLINE_REASON, /после подключения/i)
})

/* --------------------------------------------- whether it can be pressed */

test('offline disables a control that would otherwise be allowed', () => {
  assert.equal(controlDisabled(true), false)
  assert.equal(controlDisabled(false), true)
})

test('offline never re-enables a control the room was not allowed to press', () => {
  // A student who may not restart the kernel may not restart it offline either.
  assert.equal(controlDisabled(false, false), true)
  assert.equal(controlDisabled(true, false), true)
  assert.equal(controlDisabled(true, true), false)
})

/* ------------------------------------------------------------ the queue */

test('the same press twice in the closing frame is one press', () => {
  const q: unknown[] = []
  enqueueControl(q, { t: 'run', cellId: 'c_1' })
  enqueueControl(q, { t: 'run', cellId: 'c_1' })
  enqueueControl(q, { t: 'run', cellId: 'c_1' })
  assert.deepEqual(q, [{ t: 'run', cellId: 'c_1' }])
})

test('two different cells both still run', () => {
  const q: unknown[] = []
  enqueueControl(q, { t: 'run', cellId: 'c_1' })
  enqueueControl(q, { t: 'run', cellId: 'c_2' })
  assert.equal(q.length, 2)
})

test('two different shell commands are two commands', () => {
  // Dedup is about repeated presses, not about a person typing two things.
  const q: unknown[] = []
  enqueueControl(q, { t: 'term:run', command: 'ls' })
  enqueueControl(q, { t: 'term:run', command: 'pwd' })
  enqueueControl(q, { t: 'term:run', command: 'ls' })
  assert.deepEqual(q, [
    { t: 'term:run', command: 'ls' },
    { t: 'term:run', command: 'pwd' },
  ])
})

test('order is kept: what was pressed first is sent first', () => {
  const q: unknown[] = []
  enqueueControl(q, { t: 'interrupt' })
  enqueueControl(q, { t: 'run', cellId: 'c_1' })
  enqueueControl(q, { t: 'restart' })
  assert.deepEqual(q, [{ t: 'interrupt' }, { t: 'run', cellId: 'c_1' }, { t: 'restart' }])
})

test('the queue does not grow without end', () => {
  const q: unknown[] = []
  for (let i = 0; i < MAX_QUEUED_CONTROL * 3; i += 1) enqueueControl(q, { t: 'run', cellId: `c_${i}` })
  assert.equal(q.length, MAX_QUEUED_CONTROL)
  // The oldest go: a press from two minutes ago is stale, the last one is not.
  assert.deepEqual(q[q.length - 1], { t: 'run', cellId: `c_${MAX_QUEUED_CONTROL * 3 - 1}` })
})

test('enqueueControl hands back the same array it was given', () => {
  // Callers keep a reference to the queue; replacing it would strand the press.
  const q: unknown[] = []
  assert.equal(enqueueControl(q, { t: 'runAll' }), q)
  assert.equal(enqueueControl(q, { t: 'runAll' }), q)
})

test('«стоп» с целью и «стоп» без цели — два разных нажатия', () => {
  /*
   * Кнопка на ячейке называет свою цель, комнатная в верхней панели нет: одна
   * останавливает конкретное выполнение, другая ещё и разбирает очередь, когда
   * не выполняется ничего. Свернуть их в одно значило бы вернуть ту самую
   * гонку, из-за которой нажатие в промежутке между двумя ячейками Run All
   * выносило очередь всей комнаты.
   */
  const queue: ControlClientMessage[] = []
  enqueueControl(queue, { t: 'interrupt' })
  enqueueControl(queue, { t: 'interrupt', cellId: 'c1' })
  assert.equal(queue.length, 2, 'нажатия слились в одно')

  // А два одинаковых — по-прежнему одно.
  enqueueControl(queue, { t: 'interrupt', cellId: 'c1' })
  assert.equal(queue.length, 2, 'повтор одного и того же нажатия удвоился')
})

test('offline state snapshots persist the final A after A → B → A', () => {
  for (const t of ['council:draft', 'notes:set']) {
    const queue: any[] = []
    for (const text of ['A', 'B', 'A']) enqueueControl(queue, t === 'council:draft'
      ? { t, cellId: 'cell', text }
      : { t, file: 'slides.pdf', page: 1, text })
    assert.deepEqual(queue.map((message) => message.text), ['A'])
  }
})

test('offline state coalescing preserves independent resources and command barriers', () => {
  const queue: any[] = []
  enqueueControl(queue, { t: 'council:draft', cellId: 'a', text: 'before' })
  enqueueControl(queue, { t: 'council:draft', cellId: 'b', text: 'other' })
  enqueueControl(queue, { t: 'council:submit', cellId: 'a' })
  enqueueControl(queue, { t: 'council:draft', cellId: 'a', text: 'after' })
  enqueueControl(queue, { t: 'council:submit', cellId: 'a' })
  assert.deepEqual(queue.map((message) => message.text ?? message.t), [
    'before', 'other', 'council:submit', 'after', 'council:submit',
  ])
  enqueueControl(queue, { t: 'notes:set', file: 'slides.pdf', page: 1, text: 'one' })
  enqueueControl(queue, { t: 'notes:set', file: 'slides.pdf', page: 2, text: 'two' })
  enqueueControl(queue, { t: 'notes:set', file: 'slides.pdf', page: 1, text: 'latest' })
  assert.deepEqual(queue.slice(-2).map((message) => [message.page, message.text]), [[2, 'two'], [1, 'latest']])
})
