/**
 * Speaker notes: the teacher's words to themselves.
 *
 * The only thing in this product the room is not supposed to see. A note
 * "here ask who remembers Bayes' formula; if they are silent, derive it on
 * the board" that reaches everyone arrives together with the answer to a
 * question not yet asked — and this breaks SILENTLY: on the teacher's screen
 * everything is as it should be, while twenty people in the hall have an
 * extra line nobody will notice until the end of class.
 *
 * So what is checked here is not the permission (that is in control-rules)
 * but the recipient: who the frame actually went to. And three ways to lose
 * what has already been written — an empty string instead of a deletion,
 * renaming the document and deleting the seminar.
 *
 * The socket is fake, but the room is real: `toHosts` goes through the room's
 * registered sockets and asks them for their role, and the role is remembered
 * only on connection. Checking this around the connection is pointless — the
 * broadcast simply has nowhere to go, and the test would always be green.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, discardNotes, notesOf, setNote } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { makeFile } from '../server/src/workspace.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** A fake socket that can do exactly what `control.ts` wants from it. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping: () => {},
    terminate: () => {},
    // Closing must reach the handler: that is where the heartbeat is stopped,
    // and without it the interval would outlive the test and drag the whole
    // suite along.
    close: () => {
      for (const fn of handlers.get('close') ?? []) fn()
    },
  } as unknown as WebSocket
  return { ws, heard }
}

function who(sessionId: string, role: 'host' | 'participant', tag: string = role): TokenPayload {
  return { sessionId, participantId: `p_${tag}`, role }
}

let rooms = 0

/**
 * A room with three connected: two teachers and a student.
 *
 * Two hosts are not made up for completeness: a seminar can have two, and an
 * edit made on the first one's laptop must reach the second one's tablet.
 * Exactly because of this the broadcast cannot be `tell`.
 */
function room() {
  const id = `notes-${++rooms}`
  createSession(id, 'Заметки', null)
  const first = socket()
  const second = socket()
  const guest = socket()
  handleControlSocket(first.ws, id, who(id, 'host', 'host'))
  handleControlSocket(second.ws, id, who(id, 'host', 'host2'))
  handleControlSocket(guest.ws, id, who(id, 'participant'))
  /*
   * Both teachers open the notes for a document — exactly what the console
   * does when it shows a lecture. The echo of an edit comes only to those who
   * asked about THIS file: one person can have two tabs, and the second of
   * them is the projection on the lectern laptop, open in front of the
   * audience.
   */
  dispatch(first.ws, id, who(id, 'host', 'host'), { t: 'notes:open', file: 'l3.pdf' })
  dispatch(second.ws, id, who(id, 'host', 'host2'), { t: 'notes:open', file: 'l3.pdf' })
  dispatch(guest.ws, id, who(id, 'participant'), { t: 'notes:open', file: 'l3.pdf' })
  // The welcome batch and the answers to the open are not our business: we
  // look only at what comes after.
  for (const one of [first, second, guest]) one.heard.length = 0
  return { id, first, second, guest }
}

/** Say something on someone's behalf over their own socket. */
function say(
  id: string,
  from: { ws: WebSocket },
  payload: TokenPayload,
  message: ControlClientMessage,
): void {
  dispatch(from.ws, id, payload, message)
}

function notesFrames(heard: ControlServerMessage[]): ControlServerMessage[] {
  return heard.filter((frame) => frame.t === 'notes' || frame.t === 'notes:one')
}

/* ------------------------------------------------------------- recipient */

test('the notes map goes only to the one who asked, and that one must be a teacher', () => {
  const { id, first, second, guest } = room()
  setNote(id, 'l3.pdf', 7, 'спросить про поток')

  say(id, guest, who(id, 'participant'), { t: 'notes:open', file: 'l3.pdf' })
  assert.deepEqual(notesFrames(guest.heard), [], "the teacher's notes went to the hall")
  assert.match(guest.heard.find((frame) => frame.t === 'error')?.message ?? '', /преподавател/i)

  say(id, first, who(id, 'host', 'host'), { t: 'notes:open', file: 'l3.pdf' })
  assert.deepEqual(notesFrames(first.heard), [
    { t: 'notes', file: 'l3.pdf', notes: { 7: 'спросить про поток' } },
  ])
  /*
   * Nothing for the second teacher: they asked for nothing. A map for a
   * document they do not have open would replace their own on their console.
   */
  assert.deepEqual(notesFrames(second.heard), [])
  closeControlRoom(id)
})

test('an edit reaches the second teacher and does not reach the hall', () => {
  const { id, first, second, guest } = room()

  say(id, first, who(id, 'host', 'host'), {
    t: 'notes:set',
    file: 'l3.pdf',
    page: 7,
    text: 'спросить, кто помнит формулу Байеса',
  })

  const echo = {
    t: 'notes:one',
    file: 'l3.pdf',
    page: 7,
    text: 'спросить, кто помнит формулу Байеса',
  }
  // To oneself too: one person's laptop and tablet are two different sockets,
  // and the second learns about the edit only this way.
  assert.deepEqual(notesFrames(first.heard), [echo])
  assert.deepEqual(notesFrames(second.heard), [echo])
  assert.deepEqual(notesFrames(guest.heard), [], 'the note went to a student')
  closeControlRoom(id)
})

test('a tab that did not ask for notes does not get them', () => {
  /*
   * The projection on the lectern laptop joins with the same key as the same
   * participant — that is, also as "teacher". The teacher's words to
   * themselves must not lie in the memory of a machine open in front of the
   * audience, even if it does not put them on the screen: a file that is not
   * there cannot be shown by accident.
   */
  const { id, first, second } = room()
  // The second one "leaves the document": the console asked for the notes of
  // another file.
  say(id, second, who(id, 'host', 'host2'), { t: 'notes:open', file: 'other.pdf' })
  second.heard.length = 0

  say(id, first, who(id, 'host', 'host'), {
    t: 'notes:set',
    file: 'l3.pdf',
    page: 7,
    text: 'здесь пауза',
  })
  assert.equal(notesFrames(first.heard).length, 1)
  assert.deepEqual(notesFrames(second.heard), [], 'the note went to a different document')
  closeControlRoom(id)
})

/* -------------------------------------------------------- empty note */

test('an empty note is its absence, not an empty string in the map', () => {
  /*
   * Otherwise the strip shows a "there is something to say here" dot over a
   * page where nothing is said — and in class the teacher searches with their
   * eyes for text that is not there. A string of spaces is the same case: it
   * is left by whoever did not quite erase the note.
   */
  const { id, first } = room()
  const host = who(id, 'host', 'host')

  say(id, first, host, { t: 'notes:set', file: 'l3.pdf', page: 7, text: 'сказать про Стокса' })
  assert.deepEqual(notesOf(id, 'l3.pdf'), { 7: 'сказать про Стокса' })

  say(id, first, host, { t: 'notes:set', file: 'l3.pdf', page: 7, text: '   \n  ' })
  assert.deepEqual(notesOf(id, 'l3.pdf'), {}, 'the page stayed in the map as an empty string')

  // And the echo says the same as what went into the database: otherwise the
  // second device would keep spaces where there is no note anymore.
  const last = notesFrames(first.heard).at(-1)
  assert.deepEqual(last, { t: 'notes:one', file: 'l3.pdf', page: 7, text: '' })
  closeControlRoom(id)
})

test('a note page is a whole number and not below the first', () => {
  const { id, first } = room()
  const host = who(id, 'host', 'host')

  say(id, first, host, { t: 'notes:set', file: 'l3.pdf', page: 7.8, text: 'дробная' })
  assert.deepEqual(notesOf(id, 'l3.pdf'), { 7: 'дробная' }, 'a fractional page is rounded down')

  // There is no page zero or negative page: that is junk from a tab, and it
  // must not be kept quiet — everything that loses written text says so out
  // loud.
  say(id, first, host, { t: 'notes:set', file: 'l3.pdf', page: 0, text: 'ниоткуда' })
  assert.match(first.heard.find((frame) => frame.t === 'error')?.message ?? '', /страниц/i)
  assert.deepEqual(notesOf(id, 'l3.pdf'), { 7: 'дробная' })
  closeControlRoom(id)
})

/* ------------------------------------------------ renaming and deletion */

test('renaming a document takes the notes along', () => {
  /*
   * An evening spent on notes for twenty-four pages is tied to the document's
   * PATH. The teacher renames "l3.pdf" to "Lecture 3. Flux and
   * divergence.pdf" — an ordinary thing — and without the move the notes
   * remain rows with no key anymore: the old path no longer exists on disk,
   * and there is nothing in the interface to restore them with.
   *
   * It is checked through `tree:move`, not through `moveNotesTo`: the function
   * itself was written long ago and correctly, and what was broken is that
   * nobody called it.
   */
  const { id, first } = room()
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  setNote(id, 'l3.pdf', 7, 'спросить про поток')
  setNote(id, 'l3.pdf', 12, 'вывести на доске')

  say(id, first, who(id, 'host', 'host'), { t: 'tree:move', from: 'l3.pdf', to: 'лекция-3.pdf' })

  assert.deepEqual(notesOf(id, 'l3.pdf'), {}, 'the notes stayed under a name that no longer exists')
  assert.deepEqual(notesOf(id, 'лекция-3.pdf'), { 7: 'спросить про поток', 12: 'вывести на доске' })
  closeControlRoom(id)
})

test('a deleted seminar takes its notes along', () => {
  /*
   * Notes are the only thing the teacher wrote for themselves, and they
   * survive both the end of the lecture and a server restart. They must not
   * survive the deletion of the room: no room and no document remain behind
   * them, and they lie in the shared database, where there will be nobody to
   * show them or clean them up.
   */
  const id = `notes-gone-${++rooms}`
  createSession(id, 'Заметки', null)
  setNote(id, 'l3.pdf', 1, 'начать с задачи про шар')
  const other = `notes-stays-${++rooms}`
  createSession(other, 'Соседний', null)
  setNote(other, 'l3.pdf', 1, 'чужая речь')

  discardNotes(id)

  assert.deepEqual(notesOf(id, 'l3.pdf'), {})
  // The same path in a neighbouring room is not the same document: the key
  // has three parts.
  assert.deepEqual(notesOf(other, 'l3.pdf'), { 1: 'чужая речь' })
})

test('notes for one document are not visible from another', () => {
  // The key is seminar, file and page. A mistake in any part of the key looks
  // like "the notes are gone", while in fact they lie under a neighbouring
  // name.
  const id = `notes-key-${++rooms}`
  createSession(id, 'Заметки', null)
  setNote(id, 'l3.pdf', 7, 'про поток')
  setNote(id, 'seminar-3.pdf', 7, 'про задачи')

  assert.deepEqual(notesOf(id, 'l3.pdf'), { 7: 'про поток' })
  assert.deepEqual(notesOf(id, 'seminar-3.pdf'), { 7: 'про задачи' })
  assert.deepEqual(notesOf(id, 'l4.pdf'), {})
})
