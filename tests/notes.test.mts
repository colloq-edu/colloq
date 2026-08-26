/**
 * The mark on the terminal tab.
 *
 * The kernel's news — "a cell failed, so the 3 cells queued behind it were not
 * run", "kernel restarted by Maria, every variable is gone" — is written into
 * the shared transcript, which lives in a drawer that starts closed. Measured
 * in a browser: a Run All stopped at the failing cell, the three cells behind
 * it went quietly back to idle, and the sentence explaining why was on file
 * with nothing on screen pointing at it.
 *
 * The first version of the mark counted the replay too, so joining a room said
 * there were nine notes to read and all nine were from the seminar before.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countsAsUnread } from '../web/src/lib/notes.js'

const settled = { open: false, synced: true }

test("a kernel note nobody is looking at is unread", () => {
  assert.equal(countsAsUnread({ kind: 'system' }, settled), true)
})

test('nothing is unread while somebody has the transcript open', () => {
  assert.equal(countsAsUnread({ kind: 'system' }, { open: true, synced: true }), false)
})

test('the history that replays on arrival is not news', () => {
  // Every line the room has ever seen comes through the same observer when the
  // server hands over the document. None of it happened while I was here.
  assert.equal(countsAsUnread({ kind: 'system' }, { open: false, synced: false }), false)
})

test("a classmate's command is not a kernel note", () => {
  // They are watching it, and its output follows it down the transcript.
  assert.equal(countsAsUnread({ kind: 'command' }, settled), false)
  assert.equal(countsAsUnread({ kind: 'output' }, settled), false)
})

test('a line with no kind at all is not counted', () => {
  // The transcript is shared, so a client could put anything in it.
  assert.equal(countsAsUnread({}, settled), false)
  assert.equal(countsAsUnread({ kind: null }, settled), false)
  assert.equal(countsAsUnread({ kind: 42 }, settled), false)
})

test('open wins over synced, and both over the kind', () => {
  assert.equal(countsAsUnread({ kind: 'system' }, { open: true, synced: false }), false)
})
