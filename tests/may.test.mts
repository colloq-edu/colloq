/**
 * The lock on a cell — through the eyes of the interface.
 *
 * The permission itself is computed by shared/rules.ts, with the same
 * functions the server answers with. What is checked is the thin layer on top
 * of them (web/src/lib/may.ts), which has exactly one idea of its own: IS a
 * lock needed in this room at all.
 *
 * That idea asks about a PARTICIPANT, not about whoever is looking, and it can
 * go wrong completely silently. Let the interface ask about itself — and the
 * teacher, for whom the answer does not change under any lock, would be left
 * without the only button that opens a cell: the icon is not drawn, there is
 * nothing to complain about, the room simply cannot do what it was written
 * for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import type { ParticipantRole } from '../shared/protocol.js'
import { cellLockMatters, mayEditThisCell, mayRunThisCell, permitsIn } from '../web/src/lib/may.js'

const may = (rules: RoomRules, role: ParticipantRole, finished = false) =>
  permitsIn(rules, role, finished)

test('in a lecture the lock opens exactly this cell to a participant', () => {
  const student = may(LECTURE_ROOM, 'participant')
  assert.equal(mayEditThisCell(student, false), false)
  assert.equal(mayRunThisCell(student, false), false)
  assert.equal(mayEditThisCell(student, true), true)
  assert.equal(mayRunThisCell(student, true), true)
})

test('an open lab has no lock — there is nothing to open there', () => {
  assert.equal(cellLockMatters(may(OPEN_ROOM, 'participant')), false)
  assert.equal(cellLockMatters(may(OPEN_ROOM, 'host')), false)
})

test('the teacher needs the lock too, though it changes nothing for the teacher', () => {
  const host = may(LECTURE_ROOM, 'host')
  assert.equal(mayEditThisCell(host, false), true, 'a locked cell is not locked for the host')
  assert.equal(cellLockMatters(host), true, 'but the lock still has to be drawn — the host is the one who opens it')
})

test('a finished class removes the lock along with everything else', () => {
  const student = may(LECTURE_ROOM, 'participant', true)
  assert.equal(mayEditThisCell(student, true), false, 'after the bell nobody writes, even in an open cell')
  assert.equal(cellLockMatters(student), false, 'so there is nothing to say about the lock')
})

test('a room where only running is forbidden shows the lock too', () => {
  // The lock is a property not of the lecture preset but of any rule it is
  // able to release. Otherwise "open the cell" would work in exactly one room
  // out of all those where the server listens to it.
  const student = may({ ...OPEN_ROOM, run: 'host' }, 'participant')
  assert.equal(cellLockMatters(student), true)
  assert.equal(mayEditThisCell(student, false), true, 'typing here is allowed even without the lock')
  assert.equal(mayRunThisCell(student, false), false)
  assert.equal(mayRunThisCell(student, true), true)
})
