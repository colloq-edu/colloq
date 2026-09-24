/**
 * What a ban does besides closing the door.
 *
 * The door is half of it: the person banned is already sitting inside and
 * writing into the shared feed right now. So what they wrote must be
 * removed, whatever the model is still writing for them must be cut off, and
 * they must be put out of the room, without touching the other nineteen who
 * are in the middle of a class.
 *
 * And three things that break silently. A purge that takes one record too
 * many erases someone else's question with a two-page answer. A purge
 * without a mark in the history erases it for good: there is nothing left
 * to bring the feed back from the document. And an eviction that closed the
 * socket before the frame shows the person "no connection" instead of the
 * reason and the term, and the tab silently goes back to knocking.
 *
 * No network, no kernel: the sockets are fake, the room is real.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import * as Y from 'yjs'
import { WebSocket } from 'ws'
import { createChatEntry, getChat } from '../shared/notebook.js'
import {
  createSession,
  listStoryVersions,
  updatesUpTo,
  upsertParticipant,
} from '../server/src/db.js'
import { banFor } from '../server/src/bans.js'
import {
  getSessionDoc,
  handleCollabSocket,
  onlineCount,
  shutdownCollab,
} from '../server/src/collab/index.js'
import { closeControlRoom, evictBanned, handleControlSocket } from '../server/src/control.js'
import { purgeQuestions } from '../server/src/routes/ai.js'
import { banRoutes } from '../server/src/routes/bans.js'
import { signToken } from '../server/src/auth.js'
import type { ControlServerMessage } from '../shared/protocol.js'

after(() => shutdownCollab())

let seq = 0

interface Room {
  id: string
  /** Ada is the host by host token: `roleFor` gives her the role, not the request token. */
  teacher: string
  /** Petya is the one about to be closed off. */
  loud: string
  /** Maria is the one none of this concerns at all. */
  quiet: string
}

/**
 * A room with a teacher, a loudmouth and someone asking to the point.
 *
 * Participant ids are global across the database (`participants.id` is the
 * primary key), so every room has its own. Identical `p_loud` in two rooms
 * are ONE row, bound to the first of them, and a test on the second room
 * would silently be checking emptiness.
 */
function room(): Room {
  const n = seq++
  const id = `ban${n}`
  const at = { id, teacher: `p_teacher${n}`, loud: `p_loud${n}`, quiet: `p_quiet${n}` }
  createSession(id, 'Бан', null)
  upsertParticipant({
    id: at.teacher,
    sessionId: id,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  upsertParticipant({ id: at.loud, sessionId: id, name: 'Петя', avatar: null, role: 'participant' })
  upsertParticipant({
    id: at.quiet,
    sessionId: id,
    name: 'Мария',
    avatar: null,
    role: 'participant',
  })
  return at
}

/** A question into the feed, with the same record the oracle puts there. */
function ask(id: string, participantId: string, question: string): string {
  const doc = getSessionDoc(id).doc
  const entry = createChatEntry({ participantId, name: participantId, color: '#7e82f0', question })
  doc.transact(() => getChat(doc).push([entry]))
  return entry.get('id') as string
}

const banLabel = 'до бана Петя'

/* ---------------------------------------------------------------- purge */

test('a purge removes the questions of the banned person and leaves the others alone', () => {
  const at = room()
  ask(at.id, at.loud, 'ааааааа')
  const hers = ask(at.id, at.quiet, 'почему loss стал nan?')
  ask(at.id, at.loud, 'ещё раз ааааааа')

  const gone = purgeQuestions(at.id, { participantId: at.loud, name: 'Петя' }, at.teacher)

  assert.equal(gone, 2)
  const chat = getChat(getSessionDoc(at.id).doc)
  assert.equal(chat.length, 1, 'more than just his were removed from the feed')
  assert.equal(chat.get(0).get('id'), hers)
})

test('a purge names a moment in the history, and names it before deleting', () => {
  const at = room()
  ask(at.id, at.loud, 'ааааааа')

  purgeQuestions(at.id, { participantId: at.loud, name: 'Петя' }, at.teacher)

  const marks = listStoryVersions(at.id, 400).filter((v) => v.kind === 'checkpoint')
  assert.equal(marks.length, 1, 'there is no named moment in the version feed')
  assert.equal(marks[0].label, banLabel)
  // Signed by whoever banned: a "before the ban of Petya" row without the
  // teacher's name reads as nobody's edit of a dozen records.
  assert.equal(marks[0].author_id, at.teacher)
})

test('what was erased comes back with a version', () => {
  const at = room()
  const his = ask(at.id, at.loud, 'ааааааа')
  const hers = ask(at.id, at.quiet, 'почему loss стал nan?')

  purgeQuestions(at.id, { participantId: at.loud, name: 'Петя' }, at.teacher)

  const named = listStoryVersions(at.id, 400).find((v) => v.kind === 'checkpoint')
  assert.ok(named, 'there is nowhere to go back to: the moment is not named')
  const back = new Y.Doc()
  for (const update of updatesUpTo(at.id, named.seq)) Y.applyUpdate(back, update)
  const ids = getChat(back)
    .toArray()
    .map((entry) => entry.get('id') as string)
  assert.deepEqual(ids, [his, hers], 'the "before the ban" version did not bring back the erased questions')
  back.destroy()
})

test('nothing to purge, and then the history is empty too', () => {
  const at = room()
  ask(at.id, at.quiet, 'почему loss стал nan?')

  assert.equal(purgeQuestions(at.id, { participantId: at.loud, name: 'Петя' }, at.teacher), 0)
  // Otherwise the version feed gets clogged with empty "before the ban"
  // marks, one for every banned person who never wrote to the oracle.
  assert.deepEqual(
    listStoryVersions(at.id, 400).filter((v) => v.kind === 'checkpoint'),
    [],
  )
})

/* -------------------------------------------------------------- eviction */

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
  closed: boolean
}

/**
 * Exactly what both wires read: the state, receiving a frame and closing.
 *
 * Closing sets `readyState`, not just a flag, and the order check rests on
 * this: a frame sent after closing never reaches `heard`, because both
 * senders ask for the state first.
 */
function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      // As a string or as bytes: frames the server builds once per room
      // (broadcast, tree, ink) go out already encoded; see
      // control.ts · sendFrame. A real socket makes no difference here.
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
      out.closed = true
      // The handler must run: it stops the heartbeat, and without it the
      // interval outlives the test and drags the whole suite along with it.
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  const out: Fake = { ws: fake as unknown as WebSocket, heard, closed: false }
  return out
}

test('the banned person is thrown out at once, and only they are', () => {
  const at = room()
  const his = socket()
  const hers = socket()
  handleControlSocket(his.ws, at.id, {
    sessionId: at.id,
    participantId: at.loud,
    role: 'participant',
  })
  handleControlSocket(hers.ws, at.id, {
    sessionId: at.id,
    participantId: at.quiet,
    role: 'participant',
  })
  const hisDoc = socket()
  const hersDoc = socket()
  handleCollabSocket(hisDoc.ws, at.id, 'participant', at.loud)
  handleCollabSocket(hersDoc.ws, at.id, 'participant', at.quiet)
  assert.equal(onlineCount(at.id), 2)

  const until = Date.now() + 24 * 60 * 60 * 1000
  evictBanned(at.id, at.loud, until)

  // The frame comes before the close: the fake socket accepts nothing after
  // close(), so "heard" here means "heard while it was open".
  assert.deepEqual(
    his.heard.filter((m) => m.t === 'banned'),
    [{ t: 'banned', until }],
    'the banned person was told neither the reason nor the term',
  )
  assert.ok(his.closed, 'the control socket of the banned person stayed open')
  assert.ok(hisDoc.closed, 'the shared notebook stayed open for the banned person')

  assert.equal(
    hers.heard.some((m) => m.t === 'banned'),
    false,
    'the ban frame went to the whole room',
  )
  assert.equal(hers.closed, false, 'the wrong person was evicted')
  assert.equal(onlineCount(at.id), 1, 'more than just him dropped out of the document')

  closeControlRoom(at.id)
})

/* --------------------------------------------------------- three doors */

const app = express()
app.use(express.json())
app.use(banRoutes())
const server = http.createServer(app)
after(() => server.close())

async function listening(): Promise<string> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  }
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

/*
 * The role in the token is always 'participant', and that is not
 * carelessness: `sessionAuth` recomputes it on every request (`roleFor`), and
 * what makes Ada a teacher is the host token in her row, not a word in the
 * signature. A token calling itself host would open nothing.
 */
function as(sessionId: string, participantId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signToken({ sessionId, participantId, role: 'participant' })}`,
    'content-type': 'application/json',
  }
}

/** The same thing the room door and every handshake ask the ban. */
const stopped = (id: string, participantId: string) => banFor(id, participantId, undefined)

test('lifting a ban lets the person back in', async () => {
  const base = await listening()
  const at = room()
  ask(at.id, at.loud, 'ааааааа')

  const made = await fetch(`${base}/api/sessions/${at.id}/bans`, {
    method: 'POST',
    headers: as(at.id, at.teacher),
    body: JSON.stringify({ participantId: at.loud }),
  })
  assert.equal(made.status, 201)
  const { ban } = (await made.json()) as { ban: { id: string; name: string; byTeacher: string } }
  assert.equal(ban.name, 'Петя')
  assert.equal(ban.byTeacher, 'Ада')
  assert.ok(stopped(at.id, at.loud), 'the door lets him in: the ban was not created')
  // And the feed is cleaned up by the same press, not by a separate button.
  assert.equal(getChat(getSessionDoc(at.id).doc).length, 0)

  const listed = await fetch(`${base}/api/sessions/${at.id}/bans`, {
    headers: as(at.id, at.teacher),
  })
  assert.deepEqual(
    ((await listed.json()) as { bans: { name: string }[] }).bans.map((b) => b.name),
    ['Петя'],
  )

  const lifted = await fetch(`${base}/api/sessions/${at.id}/bans/${ban.id}`, {
    method: 'DELETE',
    headers: as(at.id, at.teacher),
  })
  assert.equal(lifted.status, 200)
  assert.equal(stopped(at.id, at.loud), null, 'the lifted ban still holds the door')
  // The second lift has nothing to lift any more, and that is not silence.
  const again = await fetch(`${base}/api/sessions/${at.id}/bans/${ban.id}`, {
    method: 'DELETE',
    headers: as(at.id, at.teacher),
  })
  assert.equal(again.status, 404)
})

test('a teacher cannot be banned', async () => {
  const base = await listening()
  const at = room()

  const refused = await fetch(`${base}/api/sessions/${at.id}/bans`, {
    method: 'POST',
    headers: as(at.id, at.teacher),
    body: JSON.stringify({ participantId: at.teacher }),
  })

  assert.equal(refused.status, 403)
  assert.equal(stopped(at.id, at.teacher), null, 'the teacher locked themselves out')
})

test('the teacher bans, not anyone who has come in', async () => {
  const base = await listening()
  const at = room()
  const his = ask(at.id, at.loud, 'ааааааа')

  const refused = await fetch(`${base}/api/sessions/${at.id}/bans`, {
    method: 'POST',
    headers: as(at.id, at.quiet),
    body: JSON.stringify({ participantId: at.loud }),
  })

  assert.equal(refused.status, 403)
  assert.equal(stopped(at.id, at.loud), null)
  // And the feed is intact: the refusal must happen before any consequence.
  assert.equal(getChat(getSessionDoc(at.id).doc).get(0).get('id'), his)
})
