/**
 * The rights table on the control socket.
 *
 * Every row here is a refusal that must sound BEFORE the action: the kernel
 * is not touched, the shell does not open, the queue does not grow. The
 * socket is fake and there is no kernel at all — but what catches a miss is
 * the assertion, not the missing kernel: `JUPYTER_URL` points at a dead port,
 * the connection refusal is swallowed silently, and a skipped check does not
 * fail the test by itself. (The opposite was written here and sounded
 * convincing right up to the first attempt to rely on it.) A side effect of
 * the same silence: the allowing half of every row wakes kernel and shell
 * reconnects that live until `--test-force-exit`.
 *
 * And the second half, without which the first is worth nothing: with
 * permissive defaults all of this goes through. A rule that refuses everyone
 * is not a rule.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, notesOf, setRules } from '../server/src/db.js'
import { makeFile } from '../server/src/workspace.js'
import { OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import { dispatch } from '../server/src/control.js'
import { addInk, inkOf, lectureOf, startLecture, stopLecture, turnTo } from '../server/src/lecture.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Exactly what `send` reads: the state and taking in a frame. */
function socket(): { ws: WebSocket; said: string[] } {
  const said: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

/** A room with these rules and one person in it. */
function room(rules: Partial<RoomRules>): string {
  const id = `ctl-${++rooms}`
  createSession(id, 'Control', null)
  setRules(id, { ...OPEN_ROOM, ...rules })
  return id
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** What the server said in reply to this message; `null` if it said nothing. */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, said } = socket()
  dispatch(ws, sessionId, who(role, sessionId), message)
  return said[0] ?? null
}

/* ---------------------------------------------------------- whole sheet */

test('"one at a time" allows a cell and refuses the whole sheet', () => {
  const id = room({ run: 'single' })
  // One cell — it should not even reach the kernel: there is no such cell in
  // the notebook.
  assert.equal(say(id, 'participant', { t: 'run', cellId: 'c_nope' }), null)
  assert.match(say(id, 'participant', { t: 'runAll' }) ?? '', /по одной/)
  assert.match(say(id, 'participant', { t: 'runAbove', cellId: 'c_nope' }) ?? '', /по одной/)
  // The teacher may do both.
  assert.equal(say(id, 'host', { t: 'runAll' }), null)
})

test('"the teacher runs code" refuses both a cell and the sheet', () => {
  const id = room({ run: 'host' })
  assert.ok(say(id, 'participant', { t: 'run', cellId: 'c_nope' }))
  assert.ok(say(id, 'participant', { t: 'runAll' }))
  assert.equal(say(id, 'host', { t: 'run', cellId: 'c_nope' }), null)
})

/* ------------------------------------------- own and shared are different */

test('a student clears their own cell, but not the whole board', () => {
  /*
   * Otherwise "wiping everything is for the teacher" would forbid a student to
   * clean up after themselves in their own cell, which nobody meant.
   */
  const id = room({ wipe: 'host' })
  assert.equal(say(id, 'participant', { t: 'clearOutputs', cellId: 'c_nope' }), null)
  assert.match(say(id, 'participant', { t: 'clearOutputs' }) ?? '', /доск/i)
  assert.equal(say(id, 'host', { t: 'clearOutputs' }), null)
})

test('in a lecture room a student cannot clear even their own cell', () => {
  // Output is part of the notebook; the notebook rule extends to it as well.
  const id = room({ edit: 'host' })
  assert.ok(say(id, 'participant', { t: 'clearOutputs', cellId: 'c_nope' }))
})

/* ------------------------------------------------------------------ shell */

test('opening and closing the shell are not the same right', () => {
  /*
   * Anyone can open it: the shell is shared, and that is its point. Closing it
   * is the same as wiping the transcript: it is shut by whoever may wipe shared
   * things, otherwise one click takes away from the room what it was watching.
   */
  const id = room({})
  assert.equal(say(id, 'participant', { t: 'term:open' }), null)
  assert.equal(say(id, 'participant', { t: 'term:run', command: 'ls' }), null)
  assert.ok(say(id, 'participant', { t: 'term:close' }))
  assert.equal(say(id, 'host', { t: 'term:close' }), null)
})

/* ----------------------------------------------------- structure and kernel */

test('"append only" does not allow moving other people\'s cells', () => {
  // Moving into nowhere is a way around the ban on removing, so move goes
  // together with remove.
  const id = room({ structure: 'add' })
  assert.match(
    say(id, 'participant', { t: 'cells:move', cellId: 'c_nope', direction: 1 }) ?? '',
    /порядок/i,
  )
  assert.equal(say(id, 'host', { t: 'cells:move', cellId: 'c_nope', direction: 1 }), null)
})

test('restarting the kernel is a rule, not a role', () => {
  const strict = room({})
  assert.ok(say(strict, 'participant', { t: 'restart' }))
  // A room where two people work together is entitled to decide otherwise.
  const open = room({ restart: 'room' })
  assert.equal(say(open, 'participant', { t: 'restart' }), null)
})

test('formatting is stricter than both of its neighbours', () => {
  // black both rewrites every cell and runs on the shared kernel.
  assert.ok(say(room({ edit: 'host' }), 'participant', { t: 'format' }))
  assert.ok(say(room({ run: 'single' }), 'participant', { t: 'format' }))
  assert.equal(say(room({}), 'participant', { t: 'format' }), null)
})

/* ------------------------------------------------- behaviour, not a right */

test('the answer to input() comes from the person whose cell is asking', () => {
  /*
   * The prompt lives in the document because the room must see it. Seeing and
   * answering are different, all the more so for an `input()` asking for a
   * password.
   */
  const id = room({})
  assert.match(say(id, 'participant', { t: 'input', value: 'пароль' }) ?? '', /участник, запустивший ячейку/i)
  assert.equal(say(id, 'host', { t: 'input', value: 'да' }), null)
})

test('a cell lock is a role, not a room rule', () => {
  /*
   * Cells are opened by whoever owns the notebook, and the rules are not asked
   * about it: RoomRules say what can be done in the room, not who hands out
   * rights. The lock's behaviour itself is in control-lock.test.mts; here it is
   * only a row in the table.
   */
  const id = room({ run: 'host', edit: 'host' })
  assert.match(
    say(id, 'participant', { t: 'cell:open', cellId: 'c_nope', open: true }) ?? '',
    /преподавател/i,
  )
  // For the teacher the refusal is no longer about the right: there is no such
  // cell in the room.
  assert.match(say(id, 'host', { t: 'cell:open', cellId: 'c_nope', open: true }) ?? '', /ячейки/i)
})

test('whoever owns the running cell can stop it, or the teacher can', () => {
  // This rule outranks the room rules and is not governed by them: there is
  // one kernel, and a stop hits whoever's code is in it right now.
  const id = room({})
  assert.match(say(id, 'participant', { t: 'interrupt' }) ?? '', /преподаватель/i)
  assert.equal(say(id, 'host', { t: 'interrupt' }), null)
})

/* ------------------------------------------- and all this with the defaults */

test("in a room where nothing was decided, nothing in a student's work is refused", () => {
  // A rule that refuses everyone is not a rule. The default is Colloq as it
  // has been: the whole room can work in the notebook and in the shell.
  const id = room({})
  const messages: ControlClientMessage[] = [
    { t: 'run', cellId: 'c_nope' },
    { t: 'runAll' },
    { t: 'runAbove', cellId: 'c_nope' },
    { t: 'clearOutputs', cellId: 'c_nope' },
    { t: 'format' },
    { t: 'term:open' },
    { t: 'term:run', command: 'ls' },
    { t: 'cells:move', cellId: 'c_nope', direction: 1 },
  ]
  for (const message of messages) {
    assert.equal(say(id, 'participant', message), null, `refused on ${message.t}`)
  }
})

test("but what is destructive for the whole room is the teacher's from the start", () => {
  /*
   * The only place where the default is stricter than the old behaviour, and
   * that is deliberate. "Clear all outputs" asked nobody: one press by a
   * student removed from the screen everything the room had computed in an
   * hour and a half, and nothing but a rerun could bring it back. Restarting
   * the kernel and clearing the transcript were the teacher's before too.
   */
  const id = room({})
  for (const message of [
    { t: 'clearOutputs' },
    { t: 'restart' },
    { t: 'term:clear' },
  ] as ControlClientMessage[]) {
    assert.ok(say(id, 'participant', message), `${message.t} went through for a student`)
    assert.equal(say(id, 'host', message), null, `${message.t} was refused to the teacher`)
  }
})

/* ---------------------------------------------------------- shared screen */

test('the teacher can put a document up for the room, anyone can view it', () => {
  /*
   * The right here is about the shared screen, not about reading: anyone in
   * the room can download the room's file anyway, and forbidding a student to
   * open a PDF on their own screen would mean forbidding what the "download"
   * button already allows.
   */
  const id = room({})
  assert.match(say(id, 'participant', { t: 'board:open', name: 'lecture.pdf' }) ?? '', /преподавател/i)
  assert.match(say(id, 'participant', { t: 'board:close' }) ?? '', /преподавател/i)
})

test('a room where everyone may present lets a student in', () => {
  // A class where students take turns showing their work is not made up.
  const id = room({ board: 'room' })
  // There is no file, and the refusal must be about the file, not about the
  // right.
  assert.match(say(id, 'participant', { t: 'board:open', name: 'lecture.pdf' }) ?? '', /файла/i)
  assert.equal(say(id, 'participant', { t: 'board:close' }), null)
})

test('what is not in the room cannot be put on the shared screen', () => {
  /*
   * It is checked on the server, not by the viewer: otherwise the room gets a
   * name that does not exist, and twenty people see an empty area without an
   * explanation.
   */
  const id = room({})
  assert.match(say(id, 'host', { t: 'board:open', name: 'нет-такого.pdf' }) ?? '', /файла/i)
  assert.match(say(id, 'host', { t: 'board:open', name: '' }) ?? '', /файла/i)
})

/* ----------------------------------------------------------- speaker notes */

test("speaker notes are the teacher's role, not a room rule", () => {
  /*
   * A room where anyone puts a document on the shared screen is an ordinary
   * one. The notes in it are still the teacher's: the `board` rule decides who
   * shows a document to the AUDIENCE, and a note is never shown to the
   * audience.
   */
  const id = room({ board: 'room' })
  assert.match(say(id, 'participant', { t: 'notes:open', file: 'l.pdf' }) ?? '', /преподавател/i)
  assert.match(
    say(id, 'participant', { t: 'notes:set', file: 'l.pdf', page: 1, text: 'спросить про Гаусса' }) ??
      '',
    /преподавател/i,
  )
  assert.deepEqual(notesOf(id, 'l.pdf'), {}, "a student wrote into someone else's speech")

  assert.equal(say(id, 'host', { t: 'notes:open', file: 'l.pdf' }), null)
  assert.equal(say(id, 'host', { t: 'notes:set', file: 'l.pdf', page: 1, text: 'спросить про Гаусса' }), null)
  assert.deepEqual(notesOf(id, 'l.pdf'), { 1: 'спросить про Гаусса' })
})

test('a note longer than the ceiling does not vanish silently', () => {
  /*
   * The server throws away a frame over 8192 bytes in `parse` without a single
   * word, and a page of the speech vanishes in the middle of class. The
   * character ceiling leaves headroom for Cyrillic, and the refusal at it
   * speaks — otherwise it would be no better than silence.
   */
  const id = room({})
  assert.match(
    say(id, 'host', { t: 'notes:set', file: 'l.pdf', page: 1, text: 'я'.repeat(3001) }) ?? '',
    /3000/,
  )
  assert.deepEqual(notesOf(id, 'l.pdf'), {})
})

/* ----------------------------------------------------------------- eraser */

test('the eraser obeys the presenter and stays silent for everyone else', () => {
  /*
   * The refusal is silent here on purpose: this is not a teacher's decision
   * that has to be announced but a tab that does not know someone else is
   * presenting the lecture.
   */
  const id = room({})
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Пётр Ильич', color: '#0f2d69' })
  addInk(id, { id: 's1', page: 3, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })

  assert.equal(say(id, 'participant', { t: 'ink:erase', page: 3, id: 's1' }), null)
  assert.equal(inkOf(id).length, 1, "a non-presenter erased someone else's stroke")

  assert.equal(say(id, 'host', { t: 'ink:erase', page: 3, id: 's1' }), null)
  assert.equal(inkOf(id).length, 0)
  stopLecture(id)
})

/* ---------------------------------------------------------------- handover */

test('a second teacher takes over the console without restarting the lecture', () => {
  /*
   * The "take the console" button does not exist on the wire: it sends the
   * same `lecture:start` for the same file. If that went into `startLecture`,
   * a press in the fortieth minute would send the page back to the first,
   * erase all the markup and reset the clock — and do it on the projector, in
   * front of everyone. What is checked here is exactly the fork in `dispatch`:
   * the handover itself is checked in lecture.test.mts.
   */
  const id = room({})
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l3.pdf', by: 'p_first', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 14)
  addInk(id, { id: 's1', page: 14, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })
  const began = lectureOf(id)?.startedAt

  const { ws } = socket()
  dispatch(ws, id, { sessionId: id, participantId: 'p_second', role: 'host' }, {
    t: 'lecture:start',
    file: 'l3.pdf',
  })

  assert.equal(lectureOf(id)?.by, 'p_second', 'the console did not change hands')
  assert.equal(lectureOf(id)?.page, 14, 'the page went back to the start')
  assert.equal(lectureOf(id)?.startedAt, began, 'the lecture clock restarted')
  assert.equal(inkOf(id).length, 1, 'the markup was erased')
  stopLecture(id)
})

test('the same teacher on the same file starts nothing', () => {
  /*
   * The "change document" list shows all of the room's PDFs, and the current
   * one sits in the same row: a press on it reads as "make sure the right one
   * is open". It cost forty minutes of markup and the lecture clock, erased on
   * the projector in front of everyone. Starting over means "Finish" and then
   * "Lecture": two presses, the second of which is made deliberately.
   */
  const id = room({})
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 14)
  addInk(id, { id: 's1', page: 14, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })
  const began = lectureOf(id)?.startedAt

  assert.equal(say(id, 'host', { t: 'lecture:start', file: 'l3.pdf' }), null)
  assert.equal(lectureOf(id)?.page, 14, 'the page went back to the start')
  assert.equal(lectureOf(id)?.startedAt, began, 'the clock restarted')
  assert.equal(inkOf(id).length, 1, 'the markup was erased')
  stopLecture(id)
})

test('the console is taken from the presenter by a teacher, not by anyone allowed to use the board', () => {
  /*
   * The `board` rule decides who puts a document up for the audience. Taking
   * control from the one already presenting is a different act: in an open
   * room it would mean a student silently taking the page, the ink and the
   * pointer in the middle of class, with the teacher learning about it from
   * the console going missing.
   */
  const id = room({ board: 'room' })
  makeFile(id, 'l4.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l4.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 9)

  const denied = say(id, 'participant', { t: 'lecture:start', file: 'l4.pdf' })
  assert.match(String(denied ?? ''), /преподаватель/)
  assert.equal(lectureOf(id)?.by, 'p_host', 'the console went to a student')
  assert.equal(lectureOf(id)?.page, 9)
  stopLecture(id)
})

/* ----------------------------------- lecture running, someone else's hands */

test("while a lecture is running, someone else's hand neither changes the document nor removes it", () => {
  /*
   * A class sometimes has two presenters. The second one clicks `homework.pdf`
   * in the file panel on a laptop — that is `board:open`, and it used to
   * silently end the first one's lecture: the projector went dark, forty
   * minutes of markup vanished, and there was nothing to bring them back with
   * (the ink lives only in memory). The cross on the lecture document's tab is
   * the same case: it sends `board:close`.
   */
  const id = room({})
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  makeFile(id, 'homework.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l3.pdf', by: 'p_first', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 14)
  addInk(id, { id: 's1', page: 14, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })

  for (const message of [
    { t: 'board:open', name: 'homework.pdf' },
    { t: 'board:close' },
    { t: 'lecture:start', file: 'homework.pdf' },
  ] as ControlClientMessage[]) {
    assert.match(say(id, 'host', message) ?? '', /Идёт лекция/, `${message.t} went through silently`)
  }
  assert.equal(lectureOf(id)?.file, 'l3.pdf', "the lecture was ended by someone else's hand")
  assert.equal(lectureOf(id)?.page, 14)
  assert.equal(inkOf(id).length, 1, 'the markup was erased')
  stopLecture(id)
})

test('the presenter switches their own lecture to another document themselves', () => {
  // Exactly what "More → change document" does on the console: it is their
  // lecture, and it starts from scratch.
  const id = room({})
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  makeFile(id, 'l4.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 14)

  assert.equal(say(id, 'host', { t: 'lecture:start', file: 'l4.pdf' }), null)
  assert.equal(lectureOf(id)?.file, 'l4.pdf')
  assert.equal(lectureOf(id)?.page, 1, 'a different document is a different lecture, and it starts from the beginning')
  stopLecture(id)
})

test("in a room where anyone can use the board, a student cannot shut down the teacher's lecture", () => {
  /*
   * The `board` rule decides who puts a document up for the audience; ending
   * someone else's lecture is a different act, and there must be no way around
   * it: not the tab's cross, not another PDF, not the "Finish" button.
   */
  const id = room({ board: 'room' })
  makeFile(id, 'l4.pdf', '%PDF-1.4')
  makeFile(id, 'seminar.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l4.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })

  for (const message of [
    { t: 'board:close' },
    { t: 'board:open', name: 'seminar.pdf' },
    { t: 'lecture:start', file: 'seminar.pdf' },
  ] as ControlClientMessage[]) {
    assert.match(say(id, 'participant', message) ?? '', /Идёт лекция/, `${message.t} went through silently`)
  }
  assert.match(say(id, 'participant', { t: 'lecture:stop' }) ?? '', /преподаватель/)
  assert.equal(lectureOf(id)?.file, 'l4.pdf', 'the lecture was ended by a hand not its own')
  stopLecture(id)
})

/* ------------------------------------------------------ shell and kernel */

test('a shell command falls under the same rule as a cell', () => {
  /*
   * The same container and the same CPU time: a room where the "Run" button
   * above a file is greyed out with "The teacher runs code" cannot allow the
   * same script one line below. Anyone can still open the drawer and read the
   * shared output — the room's shell stays shared.
   */
  const id = room({ run: 'host' })
  assert.equal(say(id, 'participant', { t: 'term:open' }), null)
  assert.match(
    say(id, 'participant', { t: 'term:run', command: 'python train.py' }) ?? '',
    /преподавател/i,
  )
  assert.equal(say(id, 'host', { t: 'term:run', command: 'ls' }), null)
})

test("a tab of a removed notebook neither runs nor clears someone else's sheet", () => {
  /*
   * The notebook was removed from the room, while a neighbour's tab lives on
   * until the file list arrives. A press in it landed in the room notebook:
   * Run All queued SOMEONE ELSE'S whole sheet, and "Clear" wiped the outputs of
   * all notebooks at once.
   */
  const id = room({})
  for (const message of [
    { t: 'runAll', book: 'hw.ipynb' },
    { t: 'runAbove', cellId: 'c_nope', book: 'hw.ipynb' },
    { t: 'clearOutputs', book: 'hw.ipynb' },
  ] as ControlClientMessage[]) {
    assert.match(say(id, 'host', message) ?? '', /тетради в комнате больше нет/, message.t)
  }
})

test('a switched-off Oracle does not lock the undo of its own turn', () => {
  /*
   * Rules change on a live room, and the sequence here is natural: the Oracle
   * made a mess → I switch the Oracle off → I roll it back. The refusal at the
   * last step, on top of that, said "the teacher can" to that very teacher.
   */
  const id = room({ agent: 'off' })
  const host = say(id, 'host', { t: 'ai:undo', entryId: 'e_nope' })
  assert.doesNotMatch(String(host ?? ''), /может преподаватель/)
  assert.match(String(host ?? ''), /уже нельзя отменить/)
  assert.match(say(id, 'participant', { t: 'ai:undo', entryId: 'e_nope' }) ?? '', /преподавател/i)
})
