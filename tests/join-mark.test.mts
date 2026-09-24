/**
 * The mark a person knocks on the room with, and the moment it is chosen.
 *
 * The join screen promises a mark nobody in the room is wearing. The promise
 * rested on a single read of the roster — at mount — while a class opens the
 * link within one minute: for all thirty the room is empty, everyone picks
 * from the full list independently, and identical marks come not from bad luck
 * but by construction. The bug is quiet: two hedgehogs in a room are two
 * identical cursors in the notebook (the colour does not tell them apart, it
 * is minted from the id), and someone will notice in the twentieth minute.
 *
 * What is checked here is the part of this that the client cures: a mark is
 * taken only by THOSE IN THE ROOM, and the mark is recomputed from the roster
 * read right before joining — while one picked by hand is never replaced.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Participant } from '../shared/protocol.js'
import { markToClaim, takenMarks } from '../web/src/components/join/pick.js'
import { MARKS } from '../web/src/lib/marks.js'

const all = MARKS.map((entry) => entry.mark)

const person = (id: string, avatar: string | null, role: Participant['role'] = 'participant'): Participant => ({
  id,
  name: id,
  avatar,
  color: '#123456',
  role,
})

test('only the mark of someone in the room right now is taken', () => {
  const roster = [person('p1', all[0]), person('p2', all[1])]
  // p2 joined a week ago and closed the tab long ago.
  const taken = takenMarks(roster, new Set(['p1']), null)
  assert.equal(taken.has(all[0]), true)
  assert.equal(taken.has(all[1]), false, 'the mark of someone who left stayed taken')
})

test('your own past seat does not get in the way', () => {
  const roster = [person('me', all[3])]
  assert.equal(takenMarks(roster, new Set(['me']), 'me').size, 0)
  assert.equal(takenMarks(roster, new Set(['me']), null).size, 1)
})

test('a participant without a mark takes nothing', () => {
  assert.equal(takenMarks([person('p1', null)], new Set(['p1']), null).size, 0)
})

test('a mark we handed out is recomputed from a fresh roster', () => {
  /*
   * Exactly the case all this is for: at mount the room is empty, the screen
   * handed out the hedgehog; while the student typed their name, a neighbour
   * took the hedgehog.
   */
  const mine = all[7]
  const atMount = takenMarks([], new Set(), null)
  assert.equal(markToClaim(mine, false, atMount, null), mine)

  const beforeKnock = takenMarks([person('other', mine)], new Set(['other']), null)
  const given = markToClaim(mine, false, beforeKnock, null)
  assert.notEqual(given, mine, 'knocked with a mark that someone had already put on in front of us')
  assert.ok(all.includes(given))
})

test('nobody replaces a mark picked by hand', () => {
  const chosen = all[11]
  const taken = takenMarks([person('other', chosen)], new Set(['other']), null)
  assert.equal(
    markToClaim(chosen, true, taken, null),
    chosen,
    'the screen silently undid the choice the person made — worse than two hedgehogs',
  )
})

test('a free mark is left alone under any roster', () => {
  const mine = all[2]
  const taken = takenMarks([person('a', all[0]), person('b', all[1])], new Set(['a', 'b']), null)
  for (let i = 0; i < 20; i++) assert.equal(markToClaim(mine, false, taken, null), mine)
})

test('a full room shares a mark rather than closing the door', () => {
  const roster = all.map((mark, i) => person(`p${i}`, mark))
  const taken = takenMarks(roster, new Set(roster.map((p) => p.id)), null)
  const given = markToClaim(all[0], false, taken, null)
  assert.ok(all.includes(given), 'the join was left without any mark at all')
})

test('someone coming back gets their own animal if it is free', () => {
  const prefer = all[5]
  const taken = takenMarks([person('a', all[0])], new Set(['a']), null)
  // The mark we handed out is taken, but the browser has its own from last time.
  for (let i = 0; i < 20; i++) {
    assert.equal(markToClaim(all[0], false, taken, prefer), prefer)
  }
})
