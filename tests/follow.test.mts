/**
 * Whom to follow through the document, and whether it is the same leader.
 *
 * Everything here breaks quietly: the screen just behaves strangely, with no
 * explanation. Two tabs of one teacher, two teachers on different pages, a
 * position in another file — each of these gives jitter or jumps that look
 * like a rendering bug.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leaderFor, sameLead } from '../web/src/lib/follow.js'
import type { Peer } from '../web/src/lib/session.svelte.js'

let clientId = 0

function peer(
  role: 'host' | 'participant',
  viewing: { file: string; page: number; y: number } | null,
  extra: { name?: string; isSelf?: boolean; id?: number } = {},
): Peer {
  return {
    clientId: extra.id ?? ++clientId,
    isSelf: extra.isSelf ?? false,
    user: {
      id: `p${clientId}`,
      name: extra.name ?? 'Кто-то',
      avatar: null,
      color: '#000',
      role,
      viewing,
    },
  }
}

const HERE = { file: 'lecture.pdf', page: 3, y: 0.1 }

test('people follow the teacher, not a neighbour', () => {
  const student = peer('participant', { file: 'lecture.pdf', page: 9, y: 0 })
  const teacher = peer('host', HERE, { name: 'Ада' })
  const lead = leaderFor([student, teacher], 'lecture.pdf', null)
  assert.equal(lead?.name, 'Ада')
  assert.equal(lead?.page, 3)
})

test('a position in another file does not count', () => {
  /*
   * Page twelve of another document is not the same place. Without the file
   * name the screen would jump around someone else's pages, and that looks
   * like a rendering bug.
   */
  const teacher = peer('host', { file: 'seminar-02.pdf', page: 12, y: 0 })
  assert.equal(leaderFor([teacher], 'lecture.pdf', null), null)
})

test('nobody follows themselves', () => {
  const me = peer('host', HERE, { isSelf: true })
  assert.equal(leaderFor([me], 'lecture.pdf', null), null)
})

test('of two tabs, the one with the document open is taken', () => {
  /*
   * Merging tabs into one person prefers the tab with an active cell — which
   * may well be the one without the PDF open. So the raw presence list is
   * read, and the tab is chosen by whether it has a position in this file.
   */
  const notebookTab = peer('host', null, { name: 'Ада', id: 10 })
  const readerTab = peer('host', { file: 'lecture.pdf', page: 7, y: 0.5 }, { name: 'Ада', id: 11 })
  const lead = leaderFor([notebookTab, readerTab], 'lecture.pdf', null)
  assert.equal(lead?.clientId, 11)
  assert.equal(lead?.page, 7)
})

test('the leader sticks: two teachers do not rock the screen', () => {
  /*
   * `host` is not one person: the teacher cookie makes any staff member a
   * host. Two of them on different pages without stickiness make the screen
   * jitter for the whole room.
   */
  const first = peer('host', { file: 'lecture.pdf', page: 3, y: 0 }, { name: 'Ада', id: 20 })
  const second = peer('host', { file: 'lecture.pdf', page: 8, y: 0 }, { name: 'Борис', id: 5 })

  // Without history — a stable choice, not "the first in the list": the order
  // in presence changes with the arrival of any frame.
  assert.equal(leaderFor([first, second], 'lecture.pdf', null)?.clientId, 5)
  assert.equal(leaderFor([second, first], 'lecture.pdf', null)?.clientId, 5)

  // And if we were already following the first one, we stay with them, even
  // though the second has a smaller id.
  assert.equal(leaderFor([first, second], 'lecture.pdf', 20)?.clientId, 20)
})

test('the leader left — there is no one to follow, and that differs from "silent"', () => {
  const gone = leaderFor([], 'lecture.pdf', 20)
  assert.equal(gone, null)
  // No position at all is also "no one to follow": the presence frame could
  // have been dropped entirely, for instance by the ceiling on the number of
  // faces from one socket.
  assert.equal(leaderFor([peer('host', null)], 'lecture.pdf', null), null)
})

test('the board is closed — there is no one to lead', () => {
  assert.equal(leaderFor([peer('host', HERE)], null, null), null)
})

/* --------------------------------------------------- same leader or not */

const lead = { clientId: 1, name: 'Ада', color: '#000', page: 5, y: 0.4 }

test('the same leader in the same place is no reason to rewrite the property', () => {
  /*
   * `leaderFor` builds a NEW object every time, and without this comparison
   * the effect that writes it into a bound property subscribes to what it
   * itself causes: the parent re-renders, the property comes back, the effect
   * recomputes — effect_update_depth_exceeded.
   */
  assert.equal(sameLead(lead, { ...lead }), true)
  // A one-pixel scroll jitter is the same place: y is a fraction of the page
  // height, and a hundredth of it at 1080 px is ten pixels.
  assert.equal(sameLead(lead, { ...lead, y: 0.405 }), true)
})

test('moved or replaced — a different leader', () => {
  assert.equal(sameLead(lead, { ...lead, page: 6 }), false)
  assert.equal(sameLead(lead, { ...lead, y: 0.9 }), false)
  assert.equal(sameLead(lead, { ...lead, clientId: 2 }), false)
})

test('"no one to follow" compares equal to itself', () => {
  // On the teacher themselves the leader is always `null`, and without this
  // branch the effect would count every frame of theirs as a change of leader.
  assert.equal(sameLead(null, null), true)
  assert.equal(sameLead(null, lead), false)
  assert.equal(sameLead(lead, null), false)
})
