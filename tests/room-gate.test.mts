/**
 * A room rule carried all the way to the document.
 *
 * The parse says WHAT is in a frame; the rules say who may do it. What is
 * checked here is the joint, and it is checked on real frames: two documents,
 * an exchange of bytes, no invented verdicts. A mistake here looks like a
 * working gate and costs either a locked room under permissive defaults or a
 * rule that means nothing.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import type { WebSocket } from 'ws'
import { ownAwareness } from '../server/src/collab/index.js'
import { classify, permits } from '../server/src/collab/gate.js'
import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import { CELLS_KEY, META_KEY, createCell } from '../shared/notebook.js'
import { mayReload, refusalHealed, stashRefusal, takeRefusal } from '../web/src/lib/refusal.js'

/*
 * Node has no sessionStorage — and the module is written precisely about it. A
 * fake of exactly the size it reads: if it one day starts storing things
 * differently, the test will notice rather than pass it by.
 */
const store = new Map<string, string>()
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

function pair(): { server: Y.Doc; client: Y.Doc; frame: (write: () => void) => Uint8Array } {
  const server = new Y.Doc()
  const client = new Y.Doc()
  server.transact(() => {
    server.getMap(META_KEY).set('title', 'Семинар')
    server.getArray(CELLS_KEY).push([createCell('code', 'print(1)', 'c1'), createCell('code', 'x', 'c2')])
  })
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  const frame = (write: () => void): Uint8Array => {
    let captured: Uint8Array | null = null
    const grab = (u: Uint8Array): void => {
      captured = captured ? Y.mergeUpdates([captured, u]) : u
    }
    client.on('update', grab)
    client.transact(write)
    client.off('update', grab)
    assert.ok(captured)
    return captured!
  }
  return { server, client, frame }
}

/** Whether this frame would pass in such a room from such a person. */
function passes(
  server: Y.Doc,
  bytes: Uint8Array,
  rules: Partial<RoomRules>,
  role: 'host' | 'participant',
): string | null {
  const judged = classify(server, bytes)
  if (!judged.ok) return judged.why
  const verdict = permits(judged.verdicts, { ...OPEN_ROOM, ...rules }, role)
  return verdict.ok ? null : verdict.message
}

const typing = (client: Y.Doc): void => {
  const cell = client.getArray(CELLS_KEY).get(0) as Y.Map<unknown>
  ;(cell.get('source') as Y.Text).insert(0, 'ы')
}

/* ----------------------------------------------------------------- typing */

test('in a lecture room a student does not write, and the teacher does', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => typing(client))
  assert.match(passes(server, bytes, { edit: 'host' }, 'participant') ?? '', /преподавател/i)
  assert.equal(passes(server, bytes, { edit: 'host' }, 'host'), null)
  assert.equal(passes(server, bytes, {}, 'participant'), null, 'the default closed the notebook')
})

test('in a lecture a student types in an open cell, and only there', () => {
  /*
   * The lock is the only right that lives not in the room rules but in the
   * document, and the joint here is the same: the parse says the frame edits the
   * text of THIS cell, the rules say the notebook is the teacher's, and the open
   * cell reconciles the two answers. A mistake costs either a locked class or a
   * notebook opened entirely through one cell.
   */
  const { server, client, frame } = pair()
  // The server opens it: the gate does not accept `open` from a browser at all.
  server.transact(() => (server.getArray(CELLS_KEY).get(0) as Y.Map<unknown>).set('open', true), 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  const lecture: Partial<RoomRules> = { ...LECTURE_ROOM }
  const inside = frame(() => typing(client))
  assert.equal(passes(server, inside, lecture, 'participant'), null, 'the open cell did not let the typing in')
  Y.applyUpdate(server, inside)

  const outside = frame(() => {
    const cell = client.getArray(CELLS_KEY).get(1) as Y.Map<unknown>
    ;(cell.get('source') as Y.Text).insert(0, 'ы')
  })
  assert.match(
    passes(server, outside, lecture, 'participant') ?? '',
    /преподавател/i,
    'the open cell opened the whole notebook',
  )
})

/* ----------------------------------------------------- the sheet structure */

test('"append only" allows adding your own cell and forbids removing another', () => {
  const { server, client, frame } = pair()
  const added = frame(() => client.getArray(CELLS_KEY).push([createCell('code', 'моё', 'c9')]))
  assert.equal(passes(server, added, { structure: 'add' }, 'participant'), null)
  Y.applyUpdate(server, added)

  const removed = frame(() => client.getArray(CELLS_KEY).delete(0, 1))
  assert.match(passes(server, removed, { structure: 'add' }, 'participant') ?? '', /убирает/i)
  assert.equal(passes(server, removed, { structure: 'add' }, 'host'), null)
})

test('"structure: teacher only" forbids adding too', () => {
  const { server, client, frame } = pair()
  const added = frame(() => client.getArray(CELLS_KEY).push([createCell('code', 'моё', 'c9')]))
  assert.match(passes(server, added, { structure: 'host' }, 'participant') ?? '', /добавляет/i)
})

/* --------------------------------------------------------- the seminar name */

test('the seminar name is changed by the teacher, under any rules', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getMap(META_KEY).set('title', 'Моё имя'))
  for (const rules of [{}, { edit: 'room' as const }, { structure: 'room' as const }]) {
    assert.ok(passes(server, bytes, rules, 'participant'), 'the name was rewritten under the rules ' + JSON.stringify(rules))
  }
  assert.equal(passes(server, bytes, {}, 'host'), null)
})

/* --------------------------------------------------------------- the floor */

test('the room floor is not raised by any rules', () => {
  /*
   * There are no rules more permissive than "everyone may do everything" — and
   * this still refuses, as it must: the server writes output itself, and no
   * setting turns forging someone else's output into a matter of settings.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<style>*{display:none}</style>' }))
    ;((client.getArray(CELLS_KEY).get(0) as Y.Map<unknown>).get('outputs') as Y.Array<unknown>).push([out])
  })
  const everything: Partial<RoomRules> = {
    edit: 'room',
    run: 'room',
    structure: 'room',
    board: 'room',
    files: 'room',
    agent: 'room',
    wipe: 'room',
    restart: 'room',
    history: 'room',
  }
  assert.ok(passes(server, bytes, everything, 'participant'))
  assert.ok(passes(server, bytes, everything, 'host'), 'forging output is closed to the teacher too')
})

/* -------------------------------------------------- tightening on the fly */

test('a rule changed in the middle of a class applies from the very next frame', () => {
  // The rules are read on every frame, not per connection: otherwise "eyes here"
  // would start working only after everyone had reconnected.
  const { server, client, frame } = pair()
  const before = frame(() => typing(client))
  assert.equal(passes(server, before, {}, 'participant'), null)
  Y.applyUpdate(server, before)
  const after = frame(() => typing(client))
  assert.ok(passes(server, after, { edit: 'host' }, 'participant'))
})

/* --------------------------------------------- what a refused browser does */

test('the refusal note survives a reload, exactly once', () => {
  /*
   * A refused browser rebuilds its document with a reload: the protocol cannot
   * take structure away from it, and without a rebuild it is mute forever — all
   * its following frames refer to clocks the server does not have.
   *
   * A reload without a note would silently erase someone's work, which is no
   * better than a silently muted browser.
   */
  const note = {
    kind: 'edit' as const,
    sessionId: 'gate-room',
    message: 'Тетрадь принадлежит преподавателю.',
    text: 'df.head()',
    at: Date.now(),
  }
  stashRefusal(note)
  const back = takeRefusal('gate-room')
  assert.equal(back?.text, 'df.head()')
  assert.equal(back?.message, note.message)
  // Exactly once: showing it on a second reload would explain to the person
  // something they no longer remember.
  assert.equal(takeRefusal('gate-room'), null)
})

test('a note from another room and an old note are not shown', () => {
  stashRefusal({ kind: 'edit', sessionId: 'другая', message: 'нет', text: 'x', at: Date.now() })
  assert.equal(takeRefusal('gate-room'), null, 'another room showed the note')

  stashRefusal({ kind: 'edit', sessionId: 'gate-room', message: 'нет', text: 'x', at: Date.now() - 300_000 })
  assert.equal(takeRefusal('gate-room'), null, 'an old note outlived its purpose')
})

/* --------------------------------------------------------------- presence */

test('a presence frame about another person is not accepted', () => {
  /*
   * `applyAwarenessUpdate` accepts the state of ANY clientID as long as the clock
   * is higher. So one participant could remove everyone else from the people
   * panel for the whole room, or rewrite someone else's cursor with its name and role.
   */
  const alice = new Awareness(new Y.Doc())
  alice.setLocalStateField('user', { name: 'Алиса' })
  const bob = new Awareness(new Y.Doc())
  bob.setLocalStateField('user', { name: 'Боб' })

  const room = new Awareness(new Y.Doc())
  applyAwarenessUpdate(room, encodeAwarenessUpdate(bob, [bob.clientID]), 'bob')

  const socket = {} as WebSocket
  const entry = {
    awareness: room,
    conns: new Map([[socket, { clientIds: new Set<number>() } as never]]),
  }

  // Its own face is allowed, and the socket remembers it.
  assert.equal(ownAwareness(entry, socket, encodeAwarenessUpdate(alice, [alice.clientID])), true)
  assert.equal(ownAwareness(entry, socket, encodeAwarenessUpdate(alice, [alice.clientID])), true)

  // Someone else's, already in the room, is not.
  assert.equal(
    ownAwareness(entry, socket, encodeAwarenessUpdate(bob, [bob.clientID])),
    false,
    'one socket rewrote the presence of another',
  )

  alice.destroy()
  bob.destroy()
  room.destroy()
})

test('the echo of a neighbouring tab does not go to a socket that already brought its own face', () => {
  /*
   * `y-websocket` forwards into the socket EVERY presence update it has applied —
   * including one that arrived over BroadcastChannel from a neighbouring tab of
   * the same seminar. While the neighbour is connected, the echo is repelled
   * because its face is already in the room. But once the neighbour drops, its
   * face is removed — and the echo got through: tab A took over tab B's
   * clientID, the frames of the reconnected B were silently dropped, and A
   * leaving took B out of the people panel.
   */
  const room = new Awareness(new Y.Doc())
  const a = new Awareness(new Y.Doc())
  a.setLocalStateField('user', { name: 'Вкладка А' })
  const b = new Awareness(new Y.Doc())
  b.setLocalStateField('user', { name: 'Вкладка Б' })

  const socketA = {} as WebSocket
  const socketB = {} as WebSocket
  const stateA = { clientIds: new Set<number>() }
  const stateB = { clientIds: new Set<number>() }
  const entry = {
    awareness: room,
    conns: new Map([
      [socketA, stateA as never],
      [socketB, stateB as never],
    ]),
  }

  assert.equal(ownAwareness(entry, socketA, encodeAwarenessUpdate(a, [a.clientID])), true)
  assert.equal(ownAwareness(entry, socketB, encodeAwarenessUpdate(b, [b.clientID])), true)
  applyAwarenessUpdate(room, encodeAwarenessUpdate(b, [b.clientID]), 'b')

  // B's Wi-Fi blinked: the socket is closed, the face removed from the room.
  entry.conns.delete(socketB)
  removeAwarenessStates(room, [b.clientID], null)

  assert.equal(
    ownAwareness(entry, socketA, encodeAwarenessUpdate(b, [b.clientID])),
    false,
    'socket A took over the face of the neighbouring tab',
  )

  // And B itself, on reconnecting, comes in with its old clientID in the first frame.
  const back = {} as WebSocket
  entry.conns.set(back, { clientIds: new Set<number>() } as never)
  assert.equal(
    ownAwareness(entry, back, encodeAwarenessUpdate(b, [b.clientID])),
    true,
    'the reconnected tab could not get its own face back',
  )

  a.destroy()
  b.destroy()
  room.destroy()
})

test('one socket does not fill the room with invented people', () => {
  // Without a ceiling the people panel fills up with participants, each with a
  // name, a colour and a cursor in someone else's cell.
  const room = new Awareness(new Y.Doc())
  const socket = {} as WebSocket
  const entry = {
    awareness: room,
    conns: new Map([[socket, { clientIds: new Set<number>() } as never]]),
  }
  const made: Awareness[] = []
  let accepted = 0
  for (let i = 0; i < 8; i += 1) {
    const face = new Awareness(new Y.Doc())
    face.setLocalStateField('user', { name: `Призрак ${i}` })
    made.push(face)
    if (ownAwareness(entry, socket, encodeAwarenessUpdate(face, [face.clientID]))) accepted += 1
  }
  assert.equal(accepted, 4, 'the per-socket face ceiling did not work')
  for (const face of made) face.destroy()
  room.destroy()
})

test('a reload after a refusal does not turn into a loop', () => {
  /*
   * A reload cures only together with clearing the cache. If `clear()` failed —
   * a private window, storage forbidden — `y-indexeddb` replays the refused
   * edit, the server refuses again, and the page starts reloading in a loop. A
   * mute browser is bad; an endlessly reloading one is worse.
   */
  refusalHealed()
  assert.equal(mayReload(), true)
  assert.equal(mayReload(), true)
  assert.equal(mayReload(), false, 'a third reload in a row is a loop')

  // But a revived connection does NOT break the series: the server sync arrives
  // before the server parses our frame and refuses, so resetting the count on it
  // would mean never firing at all. What breaks the series is time lived — see
  // web/src/lib/refusal.ts and tests/panels.test.mts.
  refusalHealed()
  assert.equal(mayReload(), false, 'a sync in the middle of the loop reset the attempt count')
})
