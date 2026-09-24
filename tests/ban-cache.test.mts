/**
 * The per-room ban cache: what it saves and what it pays for it.
 *
 * `banFor` is asked on entry and on the handshake of each of the three
 * sockets, and after a server restart five hundred tabs come back within a
 * second or two: a thousand DELETEs plus a thousand SELECTs in the very
 * second the whole room is waiting to come back, and in the vast majority
 * of rooms for nothing: there are no bans there at all. So a room remembers
 * one number: until what moment there is anyone to catch in it.
 *
 * The cache is right because it is about a number, not a flag: a ban can
 * expire by itself, but it can appear only through `banParticipant`, and
 * there the cache is forgotten. Both are checked here, and the price too: a
 * row put into the table BEHIND the product's back does not take effect
 * until the list is first read. That is the very proof that there was no
 * database read on the second request.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { banFor, banParticipant, liftBan, listBans } from '../server/src/bans.js'
import { createSession, db, upsertParticipant } from '../server/src/db.js'

let rooms = 0

function room(): { id: string; petya: string } {
  const id = `ban-cache-${++rooms}`
  createSession(id, 'Семинар', null)
  const petya = `p_petya_${rooms}`
  upsertParticipant({ id: petya, sessionId: id, name: 'Петя', avatar: null, role: 'participant' })
  return { id, petya }
}

/** A ban behind the product's back: the same SQL as `banParticipant`, but without it. */
function insertBehindTheBack(sessionId: string, participantId: string, until: number): void {
  db.prepare(
    `INSERT INTO bans (id, session_id, participant_id, device, ip, name, until, by_teacher, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
  ).run(`b_hand_${rooms}`, sessionId, participantId, 'Петя', until, Date.now())
}

test('in a room without bans the second question does not reach the database', () => {
  const { id, petya } = room()
  // The first read is honest: it both removes the expired and sets the number.
  assert.equal(banFor(id, petya, undefined), null)

  insertBehindTheBack(id, petya, Date.now() + 60_000)
  assert.equal(
    banFor(id, petya, undefined),
    null,
    'the room had no bans, yet the query still went to the database',
  )

  // And this is not blindness but not knowing: the product reads the list through its own door and sees it.
  assert.equal(listBans(id, null).length, 1)
  assert.ok(banFor(id, petya, undefined), 'the list that was read never reached the check')
})

test('a ban takes effect at once: the cache is forgotten where the row is created', () => {
  const { id, petya } = room()
  assert.equal(banFor(id, petya, undefined), null, 'the person is banned before the ban')

  const ban = banParticipant({ sessionId: id, participantId: petya, ip: null, byTeacher: 'Ада' })
  assert.ok(ban)
  const caught = banFor(id, petya, undefined)
  assert.equal(caught?.id, ban.id, 'the banned person got through the door while the cache remembered yesterday')

  assert.equal(liftBan(id, ban.id), true)
  assert.equal(banFor(id, petya, undefined), null, 'a lifted ban keeps holding')
})

test('the term runs out by itself: the number does not need anyone to forget it', async () => {
  const { id, petya } = room()
  const ban = banParticipant({
    sessionId: id,
    participantId: petya,
    ip: null,
    byTeacher: 'Ада',
    until: Date.now() + 120,
  })
  assert.ok(ban)
  assert.ok(banFor(id, petya, undefined), 'the ban does not take effect while its term is running')

  await sleep(200)
  assert.equal(
    banFor(id, petya, undefined),
    null,
    'not a second past the term, yet the cache keeps the door shut',
  )
})
