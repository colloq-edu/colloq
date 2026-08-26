/**
 * Who the server thinks is in the room.
 *
 * The answer is read out of awareness, and awareness is written by the browser
 * to the shape in `shared/protocol.ts`. This read used to be a hand-written
 * inline cast for a field called `participantId`, which nothing publishes: the
 * browser sends `id`. So the online list came back empty for every real page,
 * and the only reason it ever looked right was a test client that happened to
 * send the invented name.
 *
 * The lesson is in the test, not the fix: the shape is asserted here against
 * `AwarenessUser`, so inventing a field cannot pass again.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { AwarenessUser } from '../shared/protocol.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, onlineParticipantIds, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

let seq = 0
function room() {
  const id = `online${seq++}`
  createSession(id, `Online ${id}`)
  return { id, awareness: getSessionDoc(id).awareness }
}

/** One browser tab, publishing exactly what the real client publishes. */
function tab(into: awarenessProtocol.Awareness, user: AwarenessUser): void {
  const client = new awarenessProtocol.Awareness(new Y.Doc())
  client.setLocalStateField('user', user)
  awarenessProtocol.applyAwarenessUpdate(
    into,
    awarenessProtocol.encodeAwarenessUpdate(client, [client.clientID]),
    'test',
  )
  client.destroy()
}

const person = (id: string, name: string): AwarenessUser => ({
  id,
  name,
  avatar: null,
  color: '#7e82f0',
  role: 'participant',
  activeCellId: null,
})

test('a browser in the room is counted', () => {
  const { id, awareness } = room()
  assert.deepEqual(onlineParticipantIds(id), [], 'an empty room had somebody in it')
  tab(awareness, person('p_maria', 'Maria'))
  assert.deepEqual(onlineParticipantIds(id), ['p_maria'])
})

test('a second tab does not make a second student', () => {
  const { id, awareness } = room()
  tab(awareness, person('p_maria', 'Maria'))
  tab(awareness, person('p_maria', 'Maria'))
  assert.deepEqual(onlineParticipantIds(id), ['p_maria'])
})

test('two people called Anna are two people', () => {
  const { id, awareness } = room()
  tab(awareness, person('p_1', 'Anna'))
  tab(awareness, person('p_2', 'Anna'))
  assert.deepEqual(onlineParticipantIds(id).sort(), ['p_1', 'p_2'])
})

test('a socket with no identity yet is not counted', () => {
  const { id, awareness } = room()
  const client = new awarenessProtocol.Awareness(new Y.Doc())
  client.setLocalStateField('user', { name: 'half-joined' })
  awarenessProtocol.applyAwarenessUpdate(
    awareness,
    awarenessProtocol.encodeAwarenessUpdate(client, [client.clientID]),
    'test',
  )
  client.destroy()
  assert.deepEqual(onlineParticipantIds(id), [])
})

test('a room nobody has opened has nobody in it', () => {
  assert.deepEqual(onlineParticipantIds('a-session-that-does-not-exist'), [])
})
