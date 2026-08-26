/**
 * Tokens are the only thing standing between a student and someone else's
 * badge. Every case here is one a forged or replayed value would exploit.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newParticipantId,
  newSessionId,
  signHostToken,
  signToken,
  verifyHostToken,
  verifyToken,
} from '../server/src/auth.js'

const payload = { sessionId: 's1', participantId: 'p_1', role: 'participant' as const }

test('a token round-trips its payload', () => {
  const parsed = verifyToken(signToken(payload))
  assert.deepEqual(parsed, payload)
})

test('a tampered body is refused', () => {
  const token = signToken(payload)
  const [body, sig] = token.split('.')
  const forged = Buffer.from(
    JSON.stringify({ ...payload, role: 'host' }),
  ).toString('base64url')
  // The exact attack: keep the signature, swap the claims underneath it.
  assert.equal(verifyToken(`${forged}.${sig}`), null)
  assert.notEqual(body, forged)
})

test('a tampered signature is refused', () => {
  const [body] = signToken(payload).split('.')
  assert.equal(verifyToken(`${body}.notasignature`), null)
})

test('malformed input never throws', () => {
  for (const bad of ['', '.', 'a.', '.b', 'no-dot', 'a.b.c', null, undefined]) {
    assert.equal(verifyToken(bad as string | null), null, JSON.stringify(bad))
  }
})

test('a host token belongs to exactly one seminar', () => {
  const token = signHostToken('room-a')
  assert.equal(verifyHostToken('room-a', token), true)
  // The whole point: holding the host token for your own room must not make
  // you host of anybody else's.
  assert.equal(verifyHostToken('room-b', token), false)
  assert.equal(verifyHostToken('room-a', signHostToken('room-b')), false)
  assert.equal(verifyHostToken('room-a', null), false)
  assert.equal(verifyHostToken('room-a', 'garbage'), false)
})

test('session ids avoid characters that are ambiguous when read aloud', () => {
  // A seminar link gets dictated across a lecture hall; 0/O and 1/l do not survive it.
  const ids = Array.from({ length: 500 }, () => newSessionId())
  for (const id of ids) {
    assert.match(id, /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/, id)
  }
  assert.ok(new Set(ids).size > 490, 'ids are not distinct enough to be ids')
})

test('participant ids are distinct', () => {
  const ids = Array.from({ length: 500 }, () => newParticipantId())
  assert.equal(new Set(ids).size, 500)
})
