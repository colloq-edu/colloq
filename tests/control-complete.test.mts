/**
 * Completion in a cell: the door through which the browser asks the LIVE
 * kernel.
 *
 * What is checked here is not convenience but three things that break
 * silently.
 *
 * The right. `complete_request` answers from the state of the room's kernel:
 * `df.` gives the real columns of a real DataFrame, `_` is whatever was
 * computed last. A room where the teacher runs code is a room where the
 * kernel's contents belong to the teacher, and reading them through a hint
 * would be a way around the rule, not a convenience. The refusal is SILENT,
 * though: a hint is requested on a keystroke, and a "the teacher runs code
 * here" toast for every typed dot would punish typing rather than explain the
 * rule.
 *
 * The ceiling on questions. This is the only control message a person sends
 * by the dozen per second without consciously pressing anything.
 *
 * And the fact that an answer ALWAYS comes. On the other side is a promise
 * that CodeMirror autocompletion waits for: an unresolved one is a list that
 * never appears and never closes.
 *
 * The suite has no kernel (KERNEL_BACKEND=test, JUPYTER_URL points at a dead
 * port), and the canned answer of the test backend — the same set pandas
 * gives for `df.` — stands in for it here.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { dispatch } from '../server/src/control.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { cellId as nameOf, createCell, getCells } from '../shared/notebook.js'
import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
import { after } from 'node:test'

after(() => shutdownCollab())

/** Exactly what `send` reads: the state and taking in a frame. */
function socket(): { ws: WebSocket; said: ControlServerMessage[] } {
  const said: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (frame: string) => said.push(JSON.parse(frame) as ControlServerMessage),
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

function room(rules: Partial<RoomRules> = {}): string {
  const id = `cmpl-${++rooms}`
  createSession(id, 'Дополнение', null)
  setRules(id, { ...OPEN_ROOM, ...rules })
  return id
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/**
 * Ask and wait for the answer.
 *
 * The answer is asynchronous — a trip to the kernel lies between `dispatch`
 * and the frame — so we wait for it rather than read it right away. We wait
 * with a ceiling: an unresolved promise is exactly the trouble this file
 * guards against, and it has to look like a failed assertion, not like a test
 * hanging forever.
 */
async function ask(
  ws: WebSocket,
  said: ControlServerMessage[],
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): Promise<ControlServerMessage> {
  const before = said.length
  dispatch(ws, sessionId, who(role, sessionId), message)
  const deadline = Date.now() + 5000
  while (said.length === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const reply = said[before]
  assert.ok(reply, 'the completion question got no answer at all')
  return reply
}

test('in a room where the teacher runs code, a student gets an empty list and no words', async () => {
  const id = room(LECTURE_ROOM)
  const { ws, said } = socket()
  const reply = await ask(ws, said, id, 'participant', { t: 'complete', id: 1, code: 'df.', cursor: 3 })
  assert.deepEqual(reply, { t: 'complete:reply', id: 1, matches: [], start: 0, end: 0 })
  // Not a single `error`: a hint refusal does not talk.
  assert.equal(
    said.some((frame) => frame.t === 'error'),
    false,
    'the hint refusal said something out loud',
  )

  /*
   * The help refusal now SPEAKS, but it does not say everything. `refused` is
   * the one reason the client lives through silently: the person made the
   * right gesture, and explaining "the teacher runs code here" on every mouse
   * hover would scold them for hovering.
   */
  const help = await ask(ws, said, id, 'participant', { t: 'inspect', id: 2, code: 'df.head', cursor: 7 })
  assert.deepEqual(help, { t: 'inspect:reply', id: 2, found: false, reason: 'refused' })
})

test('the teacher of the same room gets names and their kinds from the kernel', async () => {
  const id = room(LECTURE_ROOM)
  const { ws, said } = socket()
  const reply = await ask(ws, said, id, 'host', { t: 'complete', id: 7, code: 'df.', cursor: 3 })
  assert.equal(reply.t, 'complete:reply')
  assert.equal(reply.id, 7)
  const matches = (reply as Extract<ControlServerMessage, { t: 'complete:reply' }>).matches
  assert.deepEqual(
    matches.map((match) => match.text),
    ['head', 'tail', 'describe', 'shape', 'columns'],
  )
  // The kind comes with the name: the editor draws the icon and the label
  // from it.
  assert.equal(matches[0].type, 'function')
  assert.equal(matches.find((match) => match.text === 'shape')?.type, 'instance')
  // The part AFTER the dot is replaced, not the whole expression.
  assert.deepEqual(
    [
      (reply as Extract<ControlServerMessage, { t: 'complete:reply' }>).start,
      (reply as Extract<ControlServerMessage, { t: 'complete:reply' }>).end,
    ],
    [3, 3],
  )

  /*
   * And help for the same teacher answers "the kernel is starting" — and that
   * is a right too, just a different one: by hovering for help the teacher
   * STARTS the kernel, as the Run button would (control.ts · mayWake). The
   * suite has no kernel, so things go no further than "starting"; that the
   * start goes all the way through is checked on a fake Jupyter
   * (kernel.test.mts · "help brings the kernel up").
   */
  const help = (await ask(ws, said, id, 'host', {
    t: 'inspect',
    id: 8,
    code: 'df.head',
    cursor: 7,
  })) as Extract<ControlServerMessage, { t: 'inspect:reply' }>
  assert.equal(help.found, false)
  assert.equal(help.reason, 'starting')
})

test('in an open room completion is given to everyone, and a started word is filtered by the kernel', async () => {
  const id = room()
  const { ws, said } = socket()
  const reply = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 3,
    code: 'df.he',
    cursor: 5,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.deepEqual(
    reply.matches.map((match) => match.text),
    ['head'],
  )
  // The replacement starts where the word starts, not where the caret is.
  assert.deepEqual([reply.start, reply.end], [3, 5])
})

test('whoever asks too much gets an empty answer, not silence', async () => {
  const id = room()
  const { ws, said } = socket()
  /*
   * The bucket is ten questions and four in flight; twenty in a row without a
   * single pause are guaranteed to drain it. We count not "how many got
   * through" but two facts: EVERY question was answered, and some answers are
   * empty. The first is the promise to the client, the second is what the
   * bucket exists for.
   */
  const replies: Extract<ControlServerMessage, { t: 'complete:reply' }>[] = []
  for (let i = 0; i < 20; i++) {
    replies.push(
      (await ask(ws, said, id, 'host', {
        t: 'complete',
        id: 100 + i,
        code: 'df.',
        cursor: 3,
      })) as Extract<ControlServerMessage, { t: 'complete:reply' }>,
    )
  }
  assert.equal(replies.length, 20)
  assert.deepEqual(
    replies.map((reply) => reply.id),
    Array.from({ length: 20 }, (_, i) => 100 + i),
    'an answer came for the wrong question',
  )
  const refused = replies.filter((reply) => reply.matches.length === 0)
  assert.ok(refused.length > 0, 'the bucket stopped none of the twenty questions')
  assert.ok(replies[0].matches.length > 0, 'the very first question hit the bucket')

  // Another socket has its own bucket: one runaway tab does not silence the
  // whole room.
  const other = socket()
  const fresh = (await ask(other.ws, other.said, id, 'host', {
    t: 'complete',
    id: 1,
    code: 'df.',
    cursor: 3,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.ok(fresh.matches.length > 0, 'the bucket turned out to be shared by the room')
})

test('a cell longer than the ceiling gets an answer, not a rejection', async () => {
  const id = room()
  const { ws, said } = socket()
  /*
   * Forty thousand characters is a file pasted into a cell, and that happens.
   * Only the tail ending at the caret goes to the kernel: completion is for
   * what precedes it. The one thing that matters here is that there is an
   * answer, and it is about the place where the caret is — not a refusal and
   * not silence.
   */
  const code = `${'# заметка на полях\n'.repeat(2000)}df.`
  const reply = (await ask(ws, said, id, 'host', {
    t: 'complete',
    id: 42,
    code,
    cursor: code.length,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.ok(code.length > 24 * 1024, 'the check stopped checking long text')
  assert.deepEqual(
    reply.matches.map((match) => match.text),
    ['head', 'tail', 'describe', 'shape', 'columns'],
  )
})

test('a frame without code or without a number does not crash the room or answer with garbage', async () => {
  const id = room()
  const { ws, said } = socket()
  const broken = { t: 'complete', id: 5 } as unknown as ControlClientMessage
  const reply = await ask(ws, said, id, 'host', broken)
  assert.deepEqual(reply, { t: 'complete:reply', id: 5, matches: [], start: 0, end: 0 })
})

/* ---------------------------------------------------- own council sheet */

/** A cell in the room's notebook, with its lock in this position. */
function cell(sessionId: string, lock: 'closed' | 'council'): string {
  const { doc } = getSessionDoc(sessionId)
  const made = createCell('code', 'imp = ...')
  doc.transact(() => {
    // The lock position lives in the `open` key (notebook.ts · cellLock); the
    // knobs are a separate key, and without them a council is still a council.
    if (lock === 'council') made.set('open', 'council')
    getCells(doc).push([made])
  })
  return nameOf(made)
}

test('in a lecture room a student gets completion in their own council sheet, and only there', async () => {
  const id = room(LECTURE_ROOM)
  const council = cell(id, 'council')
  const plain = cell(id, 'closed')
  const { ws, said } = socket()

  /*
   * The same room, the same person, the same line of code — the only
   * difference is which cell the frame names. The council sheet is the only
   * cell where a student is told to write code themselves, and a silent
   * refusal there meant "write from memory": names came from the words of the
   * cell itself, but the columns of the real `df` did not.
   */
  const mine = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 11,
    code: 'df.',
    cursor: 3,
    cellId: council,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.ok(mine.matches.length > 0, 'the student was refused in their own council sheet')
  assert.deepEqual(
    mine.matches.map((match) => match.text),
    ['head', 'tail', 'describe', 'shape', 'columns'],
  )

  // A neighbouring cell of the same room: the rule is as before, and the
  // refusal still stays silent.
  const other = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 12,
    code: 'df.',
    cursor: 3,
    cellId: plain,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.deepEqual(other.matches, [], 'an ordinary lecture cell handed out the kernel state')

  // And the name of a cell that is not in the room opens nothing: the lock is
  // read from the document, not from the frame.
  const made = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 13,
    code: 'df.',
    cursor: 3,
    cellId: 'c_nosuchcell',
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.deepEqual(made.matches, [], 'a made-up cell name granted the right')

  assert.equal(
    said.some((frame) => frame.t === 'error'),
    false,
    'the hint refusal said something out loud',
  )
})

test('hover help in the council sheet answers that same student', async () => {
  const id = room(LECTURE_ROOM)
  const council = cell(id, 'council')
  const { ws, said } = socket()
  const help = (await ask(ws, said, id, 'participant', {
    t: 'inspect',
    id: 21,
    code: 'df.head',
    cursor: 7,
    cellId: council,
  })) as Extract<ControlServerMessage, { t: 'inspect:reply' }>
  assert.equal(help.found, true, "no signature in one's own sheet")
  assert.match(help.text ?? '', /Signature: df\.head/)
})

/* ----------------------------------------------- why there is no help */

/**
 * Silence instead of an answer is what made help look broken.
 *
 * "It does not always show up": the kernel is not started, the name was never
 * executed, the kernel is running someone else's cell — three DIFFERENT
 * cases, and all three looked the same, that is, like nothing. Now a refusal
 * carries its reason in one word (protocol.ts · InspectMiss), and the client
 * picks the words for it in the room's language.
 */
test('a name there is nothing to say about gets a reason, not silence', async () => {
  /*
   * A council sheet in a lecture room: the student may ask, but may not start
   * the room's kernel. That is exactly the pair of rights under which the test
   * backend's canned answer stands in for the kernel; under the pointer is a
   * space, there is no name, and the answer will be a reason.
   */
  const id = room(LECTURE_ROOM)
  const council = cell(id, 'council')
  const { ws, said } = socket()
  const help = (await ask(ws, said, id, 'participant', {
    t: 'inspect',
    id: 31,
    code: 'x = ',
    cursor: 4,
    cellId: council,
  })) as Extract<ControlServerMessage, { t: 'inspect:reply' }>
  assert.equal(help.found, false)
  assert.equal(help.reason, 'unknown')
  assert.equal(help.text, undefined)
})

test('completion still refuses silently: it has no reasons', async () => {
  const id = room(LECTURE_ROOM)
  const { ws, said } = socket()
  const reply = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 32,
    code: 'df.',
    cursor: 3,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.equal('reason' in reply, false, 'completion acquired a refusal reason')
})

test("in one's own council sheet there is help, but starting the room's kernel is not allowed", async () => {
  /*
   * Two different rights, and exactly this case tells them apart. Completing
   * and hovering in one's own sheet is allowed for a student even in a lecture
   * room (`mayComplete`) — otherwise the task gets written from memory. But
   * STARTING the kernel is a minute and a half the whole room sees, and it is
   * pressed by whoever has Run (`mayWake`).
   *
   * There is no kernel in the suite at all, so the answer here is `no-kernel`:
   * "only the teacher can start it in this room". If the right to wake it
   * leaked, the answer would be `starting`, and a container would come up on
   * the machine.
   */
  const previous = process.env.KERNEL_BACKEND
  process.env.KERNEL_BACKEND = 'docker'
  try {
    const id = room(LECTURE_ROOM)
    const council = cell(id, 'council')
    const { ws, said } = socket()
    const help = (await ask(ws, said, id, 'participant', {
      t: 'inspect',
      id: 33,
      code: 'df.head',
      cursor: 7,
      cellId: council,
    })) as Extract<ControlServerMessage, { t: 'inspect:reply' }>
    assert.equal(help.found, false)
    assert.equal(help.reason, 'no-kernel', "the student woke the room's kernel with a help request")
  } finally {
    if (previous === undefined) delete process.env.KERNEL_BACKEND
    else process.env.KERNEL_BACKEND = previous
  }
})
