/**
 * The room hands out marks, not thirty browsers independently.
 *
 * The join screen picks an animal by the roster and promises "one nobody in
 * this room has taken". It cannot keep that promise — a class opens the link
 * within one minute, for all thirty the room is empty — and the client
 * honestly narrowed this down to one network round trip
 * (web/src/components/join/pick.ts): the roster is re-read right before the
 * knock. Two tabs that knocked in the same second still do not see each
 * other, and forty marks for a class of thirty give about eleven pairs with
 * the same animal — that is, with the same cursor in the notebook, because
 * the colour does not tell them apart (it is minted from the id). People
 * notice in the twentieth minute.
 *
 * There is one judge here, and it is right here: `/join` replaces a taken
 * mark with a free one and returns the one it actually handed out. Two groups
 * count as taken — those in the room NOW (presence), and those who were given
 * a mark just now: a second passes between the join and the first presence
 * frame, and a whole class that opened the link at once fits into it.
 *
 * Only a HANDED-OUT mark gets replaced. One tapped with a finger (`picked` in
 * the request body) the server leaves as is: the picker does not let you
 * press taken ones, so it can collide only within a network round trip — and
 * two hedgehogs in a room are cheaper than a screen that silently handed out
 * an otter instead of a hedgehog.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { isMark } from '../shared/marks.js'
import type { JoinResponse } from '../shared/protocol.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

let ROOM = ''
let roomNumber = 0
const FOX = '🦊'
const TURTLE = '🐢'
const HEDGEHOG = '🦔'
const WHALE = '🐳'
const PARROT = '🦜'
let base = ''
let server: http.Server

before(async () => {
  const app = express()
  app.use(express.json())
  app.use(sessionRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

// Automatic reassignment picks a random free animal. A shared room lets a
// previous test reserve the animal this test expects to be free.
beforeEach(() => {
  ROOM = `mark-judge-${++roomNumber}`
  createSession(ROOM, 'Кто есть кто', null)
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** `picked` as the browser sends it: as anything at all, not only a boolean. */
type Extra = { participantId?: string; token?: string; picked?: unknown }

async function knock(name: string, avatar: string, extra?: Extra): Promise<JoinResponse> {
  const res = await fetch(`${base}/api/sessions/${ROOM}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, avatar, ...(extra ?? {}) }),
  })
  assert.equal(res.status, 200, `${name} did not get in`)
  return (await res.json()) as JoinResponse
}

/** A join with a mark tapped by finger: the same body, plus the picked flag. */
function pick(name: string, avatar: string, picked: unknown = true): Promise<JoinResponse> {
  return knock(name, avatar, { picked })
}

/** A person in the room — the way the server sees them: as a presence frame. */
function sitsInRoom(participantId: string): void {
  const entry = getSessionDoc(ROOM)
  const guest = new Awareness(new Y.Doc())
  guest.setLocalStateField('user', { id: participantId, name: participantId, color: '#123456' })
  applyAwarenessUpdate(entry.awareness, encodeAwarenessUpdate(guest, [guest.clientID]), 'тест')
}

test('two tabs in the same second leave with different animals', async () => {
  const first = await knock('Аня', FOX)
  assert.equal(first.participant.avatar, FOX, 'a free mark was replaced for no reason')

  // Anya has no presence yet — she has not even had time to open a socket.
  // Exactly this gap turned a class that opened the link at once into a room
  // with pairs of identical cursors.
  const second = await knock('Боря', FOX)
  assert.notEqual(second.participant.avatar, FOX, 'two identical animals in one room')
  assert.ok(
    isMark(second.participant.avatar),
    `the server handed out ${second.participant.avatar} — that is not a mark from the list`,
  )
})

test('the mark of someone in the room now is taken for a latecomer too', async () => {
  const sitting = await knock('Вера', TURTLE)
  sitsInRoom(sitting.participant.id)

  const late = await knock('Гриша', TURTLE)
  assert.notEqual(late.participant.avatar, TURTLE, "the latecomer took over someone else's cursor")
})

test('someone coming back stays themselves: their own mark does not count as taken', async () => {
  const first = await knock('Дина', '🦉')
  const mine = { participantId: first.participant.id, token: first.token }
  sitsInRoom(first.participant.id)

  // A reloaded tab is the same person with the same key. Replacing their mark
  // would mean declaring them a stranger to themselves.
  const again = await knock('Дина', '🦉', mine)
  assert.equal(again.participant.id, first.participant.id)
  assert.equal(again.participant.avatar, '🦉', 'the person came back and became a different animal')
})

test('the server does not touch a free mark', async () => {
  const free = await knock('Женя', '🦩')
  assert.equal(free.participant.avatar, '🦩')
})

/* --------------------------------------------------- picked by hand */

/**
 * The replacement is against a silent collision, not against the person.
 *
 * The picker draws taken marks as taken and does not let you press them, and
 * it re-reads the roster on opening, so tapping someone else's animal is
 * possible only within a network round trip. Two hedgehogs in a room are
 * cheaper than a screen that silently pretended not to hear: by then the join
 * card has already gone, and there is nothing to explain the replacement with
 * afterwards.
 */
test('tapped a taken hedgehog — joined as the hedgehog', async () => {
  const first = await knock('Зина', HEDGEHOG)
  assert.equal(first.participant.avatar, HEDGEHOG)
  sitsInRoom(first.participant.id)

  const byHand = await pick('Игорь', HEDGEHOG)
  assert.equal(
    byHand.participant.avatar,
    HEDGEHOG,
    'the animal picked by hand was replaced — the person tapped the hedgehog and became someone else',
  )
})

test('a mark picked by hand takes the window: the next person will not be handed it', async () => {
  const byHand = await pick('Ксюша', WHALE)
  assert.equal(byHand.participant.avatar, WHALE)

  // She has no presence yet — the short memory of handed-out marks holds it.
  // Without it the auto-pick would hand out the same whale a second later,
  // and the rule for the "picked" mark would backfire as a pair of identical
  // cursors from the other side.
  const next = await knock('Лёва', WHALE)
  assert.notEqual(next.participant.avatar, WHALE, 'the whale was handed out twice in a row')
  assert.ok(isMark(next.participant.avatar), 'the server handed out a string that is not in the list of marks')
})

test('the flag is read strictly: "true" as a string opens nothing', async () => {
  const first = await knock('Марк', PARROT)
  sitsInRoom(first.participant.id)

  // The request body comes from the browser, and something "truthy" like a
  // string or a one does not count here: otherwise anyone who does not want
  // the replacement could switch it off.
  const sneaky = await pick('Нина', PARROT, 'true')
  assert.notEqual(sneaky.participant.avatar, PARROT, 'a string instead of true switched the replacement off')
})
