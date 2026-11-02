/**
 * The speaker notes' outbox (web/src/lib/notes-outbox.ts): what the editors
 * show while the server has not confirmed an edit, what goes again after a
 * reconnect, and which echo lets an edit go.
 *
 * The editor, the session and the server are driven together by
 * tests/browser/notes-offline.spec.ts in a real browser; this holds the
 * bookkeeping to the cases a browser run would take minutes to reach: a deck
 * annotated past the control queue's sixteen messages, echoes of older texts
 * landing late, another device's echo of the same page.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NotesOutbox } from '../web/src/lib/notes-outbox.js'
import { enqueueControl, MAX_QUEUED_CONTROL } from '../web/src/lib/controls.js'
import type { ControlClientMessage } from '../shared/protocol.js'

const FILE = 'slides.pdf'
const SERVER = { 1: 'Server page one', 2: 'Server page two', 3: 'Server page three' }

test('offline A → B → A: every slide reads back what was typed on it, not the server', () => {
  const outbox = new NotesOutbox()
  outbox.write(FILE, 1, 'Offline page-one edit', false)
  outbox.write(FILE, 2, 'Offline page-two edit', false)
  assert.equal(outbox.over(FILE, SERVER)[1], 'Offline page-one edit')
  outbox.write(FILE, 1, 'Offline page-one edit + next edit', false)
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const shown = outbox.over(FILE, SERVER)
    assert.deepEqual(shown, {
      1: 'Offline page-one edit + next edit',
      2: 'Offline page-two edit',
      3: 'Server page three',
    })
  }
  assert.deepEqual(outbox.pending(), { [FILE]: [1, 2] })
  // The reconnect sends each page's latest text once, and its echo lets it go.
  const sent = outbox.resend()
  assert.deepEqual(sent, [
    { file: FILE, page: 1, text: 'Offline page-one edit + next edit' },
    { file: FILE, page: 2, text: 'Offline page-two edit' },
  ])
  for (const note of sent) assert.equal(outbox.settle(note.file, note.page, note.text), true)
  assert.deepEqual(outbox.pending(), {})
  assert.equal(outbox.over(FILE, SERVER), SERVER, 'with nothing unconfirmed the server map is shown as it is')
})

test('a deck annotated offline past sixteen slides keeps every slide', () => {
  const outbox = new NotesOutbox()
  const queue: ControlClientMessage[] = []
  for (let page = 1; page <= 24; page += 1) {
    outbox.write(FILE, page, `slide ${page}`, false)
    enqueueControl(queue, { t: 'notes:set', file: FILE, page, text: `slide ${page}` })
  }
  // What the control queue used to carry across the reconnect: the last sixteen.
  assert.equal(queue.length, MAX_QUEUED_CONTROL)
  assert.equal((queue[0] as { page: number }).page, 24 - MAX_QUEUED_CONTROL + 1)
  assert.deepEqual(outbox.resend().map((note) => note.page), Array.from({ length: 24 }, (_, at) => at + 1))
})

test('a late echo of an older text settles nothing; the newest one does', () => {
  const outbox = new NotesOutbox()
  for (const text of ['A', 'AB', 'A']) outbox.write(FILE, 1, text, true)
  assert.equal(outbox.settle(FILE, 1, 'A'), false, 'the first A settled the edit while AB and A were out')
  assert.equal(outbox.over(FILE, SERVER)[1], 'A')
  assert.equal(outbox.settle(FILE, 1, 'AB'), false)
  outbox.write(FILE, 1, 'A then more', true)
  assert.equal(outbox.settle(FILE, 1, 'A'), false)
  assert.equal(outbox.over(FILE, { ...SERVER, 1: 'A' })[1], 'A then more')
  assert.equal(outbox.settle(FILE, 1, 'A then more'), true)
  assert.deepEqual(outbox.pending(), {})
})

test("another device's echo of the same slide does not settle this device's edit", () => {
  const outbox = new NotesOutbox()
  outbox.write(FILE, 2, 'mine', true)
  assert.equal(outbox.settle(FILE, 2, 'theirs'), false)
  assert.equal(outbox.over(FILE, { ...SERVER, 2: 'theirs' })[2], 'mine')
  assert.equal(outbox.settle(FILE, 2, 'mine'), true)
  // Settled: from here the server's map, whatever it says, is the truth.
  assert.equal(outbox.over(FILE, { ...SERVER, 2: 'theirs' })[2], 'theirs')
})

test('an edit is held until its echo, and a reconnect resends what the dead socket swallowed', () => {
  const outbox = new NotesOutbox()
  outbox.write(FILE, 2, 'Sent into a dead line', true)
  // No echo: the socket died. The edit stays, and the new socket gets it again.
  assert.deepEqual(outbox.resend(), [{ file: FILE, page: 2, text: 'Sent into a dead line' }])
  outbox.write(FILE, 2, 'typed after the resend', true)
  assert.equal(outbox.settle(FILE, 2, 'Sent into a dead line'), false)
  assert.equal(outbox.settle(FILE, 2, 'typed after the resend'), true)
})

test('texts are kept as the server stores them, and an emptied note is an absence', () => {
  const outbox = new NotesOutbox()
  outbox.write(FILE, 3, '  spaced out \n', true)
  assert.equal(outbox.settle(FILE, 3, 'spaced out'), true, 'the trimmed echo did not match the edit')
  outbox.write(FILE, 3, '   ', false)
  assert.equal(3 in outbox.over(FILE, SERVER), false, 'an erased note came back as the server text')
})

test('edits are per document, and an import drops the ones it wrote over', () => {
  const outbox = new NotesOutbox()
  outbox.write('a.pdf', 1, 'from a', false)
  outbox.write('b.pdf', 1, 'from b', false)
  outbox.write('b.pdf', 2, 'from b, page two', false)
  assert.deepEqual(outbox.over('a.pdf', {}), { 1: 'from a' })
  assert.deepEqual(outbox.over(null, { 1: 'heard' }), { 1: 'heard' })
  outbox.drop('b.pdf', [1])
  assert.deepEqual(outbox.pending(), { 'a.pdf': [1], 'b.pdf': [2] })
  outbox.drop('b.pdf', [2])
  assert.deepEqual(outbox.resend().map((note) => note.file), ['a.pdf'])
})
