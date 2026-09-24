/**
 * An indirect sign taken for a fact: a truncated list and a bare status.
 *
 * Two halves of one habit — deciding something irreversible on data that does
 * not prove it. The first: a truncated file list was read as "the file is
 * gone". The second: any handshake refusal was read as "the key has expired",
 * and any 404 as "the room no longer exists".
 *
 * The folder walk on the server hits a cap (server/src/workspace.ts ·
 * MAX_ENTRIES), and on a truncated list the client did something
 * irreversible: it put out the shared screen for the WHOLE room and closed
 * people's tabs. In class it looks like this: a student unpacked a dataset of
 * three thousand images — `slides/lecture.pdf` did not fit into the walk — and
 * the hall was thrown out of the lecture into an empty centre, and everyone
 * entering from that moment on did not see the lecture at all (the welcome
 * batch sends `board`, followed by `files`).
 *
 * The server has already fixed the same mistake on its side and announces a
 * real loss with a `board` frame. What is checked here is the client half of
 * the rule: a full list is evidence, a truncated one is not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardGone } from '../web/src/lib/board.js'
import { restore, type Room } from '../web/src/lib/tabs.svelte.js'
import { verdictOf, verdictOnFailure } from '../web/src/lib/identity.js'
import { ApiError } from '../web/src/lib/api.js'
import { SESSION_MISSING, type FileEntry } from '../shared/protocol.js'

function file(path: string, dir = false): FileEntry {
  return { path, name: path.split('/').pop() ?? path, dir, size: 10, modifiedAt: 0 }
}

const BOARD = 'slides/lecture.pdf'

test('a full list without the document — the document really is gone', () => {
  assert.equal(boardGone(BOARD, [file('utils.py')], false), true)
})

test('a truncated list without the document proves nothing', () => {
  assert.equal(
    boardGone(BOARD, [file('images/0001.png'), file('images/0002.png')], true),
    false,
    'the lecture went out for the whole room because of the walk cap',
  )
})

test('the document is in place — nothing goes out with either a full or a truncated list', () => {
  assert.equal(boardGone(BOARD, [file(BOARD), file('utils.py')], false), false)
  assert.equal(boardGone(BOARD, [file(BOARD)], true), false)
})

test('a folder with the same name is not the document', () => {
  assert.equal(boardGone(BOARD, [file(BOARD, true)], false), true)
})

test('the room is not looking at anything — there is nothing to put out', () => {
  assert.equal(boardGone(null, [], false), false)
})

/* ---------------------------------------------------------------- tabs */

function room(alive: string[], truncated = false): Room {
  return { alive: new Set(alive), firstBook: 'разбор.ipynb', board: null, truncated }
}

test('tabs are not weeded out by a truncated list', () => {
  const saved = { open: ['разбор.ipynb', 'utils.py'], active: 'utils.py' }
  assert.deepEqual(restore(saved, room(['разбор.ipynb'], true)), saved)
})

test('by a full list, a tab for a vanished file goes away', () => {
  const saved = { open: ['разбор.ipynb', 'utils.py'], active: 'utils.py' }
  assert.deepEqual(restore(saved, room(['разбор.ipynb'])), {
    open: ['разбор.ipynb'],
    active: 'разбор.ipynb',
  })
})

test('the tab memory cap is above what a person will open by hand', () => {
  // There used to be twelve here, and the thirteenth tab vanished silently
  // after F5: it was there in the live room, and after the reload it was not.
  const many = Array.from({ length: 30 }, (_, i) => `файл${i}.py`)
  const back = restore({ open: many, active: many[29] }, room(many))
  assert.deepEqual(back.open, many)
  assert.equal(back.active, many[29])
})

/* ------------------------------------------ why we are not let into the room */

test('a banned participant hears about the ban, not about an expired seat', () => {
  const until = Date.now() + 86_400_000
  assert.deepEqual(
    verdictOf({ tokenValid: false, ban: { until }, participantId: 'p1', role: null }),
    {
      why: 'banned',
      until,
    },
  )
  // And even with a valid key: the ban outranks the key, and mixing them up
  // means sending the person to the name form, that is, offering to get
  // around the ban by renaming.
  assert.equal(
    verdictOf({ tokenValid: true, ban: { until }, participantId: 'p1', role: 'participant' }).why,
    'banned',
  )
})

test('a valid key with a closed socket is a dropped connection, not an expired key', () => {
  assert.deepEqual(
    verdictOf({ tokenValid: true, ban: null, participantId: 'p1', role: 'participant' }),
    { why: 'unknown' },
  )
})

test('an invalid key without a ban — introduce yourself again', () => {
  assert.deepEqual(verdictOf({ tokenValid: false, ban: null, participantId: null, role: null }), {
    why: 'expired',
  })
})

test('the room is gone only by our words: any other 404 is "do not know"', () => {
  assert.deepEqual(verdictOnFailure(new ApiError(SESSION_MISSING, 404)), { why: 'gone' })
  // A relay with no frpc connected, static hosting over the whole path, a
  // server build without this door — all of these are a 404 without our
  // words, and on it the offline typing was wiped.
  assert.deepEqual(verdictOnFailure(new ApiError('Not found (404)', 404)), { why: 'unknown' })
  assert.deepEqual(verdictOnFailure(new ApiError('not found', 404)), { why: 'unknown' })
  assert.deepEqual(verdictOnFailure(new ApiError('связи нет', 0)), { why: 'unknown' })
  assert.deepEqual(verdictOnFailure(new ApiError('The server failed (502)', 502)), {
    why: 'unknown',
  })
})

test('a refusal with an expiry is also a ban: the door could have been hung behind the shared check', () => {
  const until = Date.now() + 3600_000
  assert.deepEqual(
    verdictOnFailure(new ApiError('преподаватель закрыл вам доступ', 403, null, until)),
    {
      why: 'banned',
      until,
    },
  )
  // But a 403 without an expiry is a room rule, not a ban: that is "do not
  // know".
  assert.deepEqual(verdictOnFailure(new ApiError('Not allowed (403)', 403)), { why: 'unknown' })
})
