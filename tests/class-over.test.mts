import { tr } from '../shared/i18n.js'
/**
 * The class is over.
 *
 * The teacher pressed one button, and the room stayed alive: the notebook,
 * the files, the terminal feed and the Oracle's answers are in place — but
 * from that minute a participant only reads in it. The server keeps the
 * promise, and keeps it in one place: `getRules` returns the effective rules,
 * not the stored ones, so every rights check tightens by itself. What is
 * checked here is that it does tighten — and that reopening the class means
 * returning to exactly the settings it was finished from.
 *
 * The main trap is checked separately and through the real route: a rules
 * PATCH lays what was sent over the CURRENT rules, and a single toggle
 * pressed after the bell would write the tightening into the database
 * forever — there would be nothing left to reopen the class into.
 *
 * No network, no kernel: the socket is fake, the room is real.
 *
 * There used to be a promise here that a missed check "would fail with an
 * attempt to reach a nonexistent Jupyter". That is untrue: `JUPYTER_URL`
 * points at a dead port, the connection refusal is swallowed, and it never
 * gets to an assertion at all — while for the teacher the same presses go
 * there as a matter of course. A miss is caught by something else:
 * `assert.ok(said)` — that the refusal WAS SAID — and a separate check below
 * that the press left no trace: cells not moved, output not wiped, no file
 * created, no document put on screen.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import {
  createSession,
  finishedAt,
  getRules,
  getSession,
  isFinished,
  setFinished,
  setRules,
  storedRules,
  upsertParticipant,
} from '../server/src/db.js'
import { listFiles, makeFile } from '../server/src/workspace.js'
import { boardOf, closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import {
  addInk,
  inkOf,
  lectureOf,
  startLecture,
  stopLecture,
  turnTo,
} from '../server/src/lecture.js'
import { terminalPhase } from '../server/src/kernel/terminal.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { createChatEntry, findChatEntry, getCells, getChat } from '../shared/notebook.js'
import { app } from '../server/src/app.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { signToken, type TokenPayload } from '../server/src/auth.js'
import {
  actsAfterClass,
  CLASS_IS_OVER,
  OPEN_ROOM,
  rulesAfterClass,
  type RoomRules,
} from '../shared/rules.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'

/** Everything decided in the students' favour: no rule restricts anything. */
const WIDE_OPEN: RoomRules = {
  ...OPEN_ROOM,
  run: 'room',
  edit: 'room',
  structure: 'room',
  board: 'room',
  files: 'room',
  wipe: 'room',
  restart: 'room',
  agent: 'room',
  history: 'room',
}

/* ----------------------------------------------------- the rules themselves */

test('the end of class closes seven rights and leaves three fields alone', () => {
  const after = rulesAfterClass({ ...WIDE_OPEN, oracle: 'hints', model: 'gpt-4o-mini' })
  for (const field of ['run', 'edit', 'structure', 'board', 'files', 'wipe', 'restart'] as const) {
    assert.equal(after[field], 'host', `${field} stayed open after the bell`)
  }
  assert.equal(after.agent, 'host', "the Oracle keeps editing files at a student's request")
  /*
   * And the three fields the end of class does not touch. `history` is
   * reading, and reading is exactly what the room stays open for; `oracle`
   * and `model` describe not a right to act but the model and its level of
   * detail.
   */
  assert.equal(after.history, 'room', 'the version history was closed together with the class')
  assert.equal(after.oracle, 'hints')
  assert.equal(after.model, 'gpt-4o-mini')
})

test('a switched-off agent is not switched on by the end of class', () => {
  // `off` is a property of the room, not anyone's right: nothing may soften it.
  assert.equal(rulesAfterClass({ ...WIDE_OPEN, agent: 'off' }).agent, 'off')
})

test('applying the end of class twice is the same as once', () => {
  // The client applies it itself, on top of the stored rules; a frame that
  // arrives already tightened must not give a different answer.
  const once = rulesAfterClass(WIDE_OPEN)
  assert.deepEqual(rulesAfterClass(once), once)
})

test('after the bell the teacher acts and a participant watches', () => {
  // For what the rules do not express: asking the Oracle, answering input().
  assert.equal(actsAfterClass(false, 'participant'), true)
  assert.equal(actsAfterClass(false, 'host'), true)
  assert.equal(actsAfterClass(true, 'host'), true)
  assert.equal(actsAfterClass(true, 'participant'), false)
})

/* --------------------------------------------------------------- database */

test('the end of class is written, read and cleared', () => {
  const id = 'class-db-flag'
  createSession(id, 'Занятие', null)
  assert.equal(isFinished(id), false)
  assert.equal(finishedAt(id), null)
  assert.equal(getSession(id)?.finishedAt, null, 'a new room arrived finished')

  const at = Date.now()
  setFinished(id, at)
  assert.equal(isFinished(id), true)
  assert.equal(finishedAt(id), at)
  // The same time goes into GET /api/sessions/:id and into the sign-in
  // response.
  assert.equal(getSession(id)?.finishedAt, at, "the time did not reach the room's card")

  setFinished(id, null)
  assert.equal(isFinished(id), false)
  assert.equal(getSession(id)?.finishedAt, null)
})

test('the rules cache learns about the bell at once, not after a server restart', () => {
  /*
   * Rules are asked for on every frame, so they are cached. A cache warmed
   * before the bell is exactly the case where the end of class would take
   * effect only after a restart: the room is already finished in class, yet
   * the rights in it are the old ones.
   */
  const id = 'class-db-cache'
  createSession(id, 'Кэш', null)
  setRules(id, WIDE_OPEN)
  assert.equal(getRules(id).run, 'room')

  setFinished(id, Date.now())
  assert.equal(getRules(id).run, 'host', "the cache gave out yesterday's rights")
  assert.equal(getRules(id).edit, 'host')
  // While what the teacher chose lies next to it, intact: it is what the
  // settings show.
  assert.equal(storedRules(id).run, 'room', 'the setting got lost')

  // Editing a rule in the middle of a finished class must not erase the bell
  // itself.
  setRules(id, { ...storedRules(id), history: 'host' })
  assert.equal(isFinished(id), true, 'setRules forgot that the class is over')
  assert.equal(getRules(id).run, 'host')

  setFinished(id, null)
  assert.equal(getRules(id).run, 'room', 'the room came back to the wrong settings')
  assert.equal(getRules(id).history, 'host', 'the edit made after the bell was lost')
})

/* ------------------------------------------------ routes: rules and sign-in */

/*
 * The room's and the Oracle's doors come from the app (server/src/app.ts):
 * the bell must close them where they stand during class, not in a copy
 * assembled next to it.
 */
let base = ''
let server: http.Server

before(async () => {
  // The Oracle must be configured, otherwise its door answers 503 before any
  // rights.
  updateOracleSettings({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    questionsPerHour: 20,
  })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

/**
 * A token for whom the server will actually recognize.
 *
 * The role is decided on every request from the participant row, not from
 * what the token says (routes/sessions.ts · roleFor) — so the teacher has to
 * be created for real. The id is a key across the whole table, not within
 * the room, so it carries the room's name.
 */
function tokenFor(sessionId: string, role: 'host' | 'participant'): string {
  const participantId = `p_${sessionId}_${role}`
  upsertParticipant({
    id: participantId,
    sessionId,
    name: role === 'host' ? 'Ада' : 'Нина',
    avatar: null,
    role,
    tokenHost: role === 'host',
  })
  // Older than two minutes: the Oracle does not answer newcomers
  // (routes/ai.ts · NEWCOMER_MS).
  return signToken({ sessionId, participantId, role, iat: Date.now() - 3 * 60_000 })
}

test('a rules patch after the bell edits the chosen rules, not the tightened ones', async () => {
  /*
   * The very trap. The route lays what was sent over the current rules — and
   * if "current" meant the effective rules, a single toggle pressed after
   * class would write `host` into all seven fields forever.
   */
  const id = 'class-patch'
  createSession(id, 'Правила после звонка', null)
  setRules(id, WIDE_OPEN)
  setFinished(id, Date.now())

  const res = await fetch(`${base}/api/sessions/${id}/rules`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${tokenFor(id, 'host')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ rules: { history: 'host' } }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { rules: RoomRules }
  assert.equal(body.rules.history, 'host', 'the toggle was not saved')
  assert.equal(body.rules.run, 'room', 'the response returned the tightening instead of the settings')

  // The database holds what was chosen; the effective rules are still strict.
  assert.equal(storedRules(id).run, 'room', 'the tightening was written into the settings')
  assert.equal(getRules(id).run, 'host')

  // And the class can be reopened — the room returns to where it left off.
  setFinished(id, null)
  assert.equal(getRules(id).run, 'room')
  assert.equal(getRules(id).edit, 'room')
  assert.equal(getRules(id).history, 'host')
})

test("the room's card names the time the class ended", async () => {
  const id = 'class-card'
  createSession(id, 'Карточка', null)
  const at = Date.now()
  setFinished(id, at)

  const res = await fetch(`${base}/api/sessions/${id}`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { finishedAt: number | null }
  assert.equal(body.finishedAt, at, 'the sign-in screen will not know that the class is over')
})

test('in a finished room the teacher is the one who asks the Oracle', async () => {
  /*
   * `oracle` has no "who" dimension — it is about the level of detail of an
   * answer for the whole room — so the right to ask is closed not by a rule
   * but by the role (shared/rules.ts · actsAfterClass). The refusal comes as a
   * status the panel knows how to explain, not as an error in the thread that
   * the whole room watches.
   */
  const id = 'class-ai'
  createSession(id, 'Оракул после звонка', null)
  setFinished(id, Date.now())

  const denied = await askOracle(id, 'participant')
  assert.equal(denied.status, 403, 'a participant asked the Oracle after the bell')
  const body = (await denied.json()) as { error: string }
  assert.ok(body.error.includes(tr(CLASS_IS_OVER)), `the refusal is not about the end of class: ${body.error}`)

  // For the teacher it is the same door as before the bell: they finish the
  // review themselves.
  assert.equal((await askOracle(id, 'host')).status, 202)
})

function askOracle(sessionId: string, role: 'host' | 'participant'): Promise<Response> {
  return fetch(`${base}/api/sessions/${sessionId}/ai/ask`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenFor(sessionId, role)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: 'почему тут падает?' }),
  })
}

/* -------------------------------------------------------- control socket */

/** Exactly what `send` reads: state, frame intake and the close subscription. */
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
    close: () => {
      for (const fn of handlers.get('close') ?? []) fn()
    },
  } as unknown as WebSocket
  return { ws, heard }
}

const who = (sessionId: string, role: 'host' | 'participant'): TokenPayload => ({
  sessionId,
  participantId: `p_${role}`,
  role,
})

/** What the server said in reply to this message; `null` if it said nothing. */
function say(sessionId: string, role: 'host' | 'participant', message: ControlClientMessage) {
  const seat = socket()
  dispatch(seat.ws, sessionId, who(sessionId, role), message)
  const refusal = seat.heard.find(
    (frame): frame is Extract<ControlServerMessage, { t: 'error' }> => frame.t === 'error',
  )
  return refusal?.message ?? null
}

const classFrame = (heard: ControlServerMessage[]) =>
  heard.find((frame): frame is Extract<ControlServerMessage, { t: 'class' }> => frame.t === 'class')

let rooms = 0

/** A room where all that can be allowed is allowed, with files to press on. */
function room(): string {
  const id = `class-ctl-${++rooms}`
  createSession(id, 'Занятие', null)
  setRules(id, WIDE_OPEN)
  makeFile(id, 'main.py', 'print(1)')
  makeFile(id, 'lecture.pdf', '%PDF-1.4')
  return id
}

/**
 * Everything that changes the room or wakes the kernel. None of these may
 * reach the action: a cell does not get queued, a shell does not open, a
 * file does not get created.
 */
const CLOSED: ControlClientMessage[] = [
  { t: 'run', cellId: 'c_nope' },
  { t: 'runAll' },
  { t: 'format' },
  { t: 'cells:move', cellId: 'c_nope', direction: 1 },
  { t: 'tree:new', path: 'заметка.txt' },
  { t: 'tree:copy', path: 'main.py' },
  { t: 'term:run', command: 'ls' },
  { t: 'file:run', path: 'main.py' },
  { t: 'board:open', name: 'lecture.pdf' },
  { t: 'clearOutputs' },
  { t: 'restart' },
]

test('after the bell a participant hits a wall on everything that changes the room', () => {
  const id = room()
  setFinished(id, Date.now())
  for (const message of CLOSED) {
    const said = say(id, 'participant', message)
    assert.ok(said, `${message.t} went through for a participant`)
    /*
     * And one sentence for all refusals. Right now a person does not care
     * which rule stopped them: hearing "in this class the teacher runs code"
     * means going off to look for a teacher who changed nothing.
     */
    assert.ok(
      said.includes(tr(CLASS_IS_OVER)),
      `${message.t} was refused by a rule, not by the end of class: ${said}`,
    )
  }
})

test('a refusal after the bell also means no trace, not just a word', () => {
  /*
   * The word is easy: `assert.ok(said)` catches a missed check but not a
   * check that REFUSED AFTER the action. Here presses go to a real cell and a
   * real file, and then the room is examined: it must be the same as it was
   * before the presses.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  const before = cells.toArray().map((cell) => cell.get('id') as string)
  assert.ok(before.length >= 2, 'the starting notebook has nothing to move')
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('json', JSON.stringify({ name: 'stdout', text: 'посчитано на паре\n' }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')

  setFinished(id, Date.now())
  for (const message of [
    { t: 'run', cellId: before[0] },
    { t: 'cells:move', cellId: before[0], direction: 1 },
    { t: 'tree:new', path: 'заметка.txt' },
    { t: 'clearOutputs' },
    { t: 'board:open', name: 'lecture.pdf' },
  ] as ControlClientMessage[]) {
    assert.ok(say(id, 'participant', message), `${message.t} went through for a participant`)
  }

  assert.deepEqual(
    cells.toArray().map((cell) => cell.get('id') as string),
    before,
    'the cells moved, yet the refusal was sent',
  )
  assert.equal(cells.get(0).get('state'), 'idle', 'the cell was queued after the refusal')
  assert.equal(
    (cells.get(0).get('outputs') as Y.Array<unknown>).length,
    1,
    "the class's output was wiped after the refusal",
  )
  assert.equal(
    listFiles(id).some((entry) => entry.path === 'заметка.txt'),
    false,
    'the file was created after the refusal',
  )
  assert.equal(boardOf(id), null, 'the document went onto the shared screen after the refusal')
})

test('while the teacher in a finished room can do everything they could before the bell', () => {
  // The review is finished after class, and it is finished by whoever taught
  // it.
  const id = room()
  setFinished(id, Date.now())
  for (const message of CLOSED) {
    assert.equal(say(id, 'host', message), null, `${message.t} was refused to the teacher`)
  }
})

test('while the class is running, none of these refusals is heard', () => {
  // A rule that refuses everyone is not a rule: the same ten presses in the
  // same room must go through while there has been no bell.
  const id = room()
  for (const message of CLOSED) {
    assert.equal(say(id, 'participant', message), null, `${message.t} was refused before the bell`)
  }
})

test('the teacher can end the class, a participant cannot', () => {
  const id = room()

  assert.ok(say(id, 'participant', { t: 'class:finish' }), 'a participant ended the class silently')
  assert.equal(isFinished(id), false, 'a participant ended the class')

  assert.equal(say(id, 'host', { t: 'class:finish' }), null)
  assert.equal(isFinished(id), true, 'the teacher pressed, yet the class is still running')
  assert.ok(say(id, 'participant', { t: 'run', cellId: 'c_nope' }), 'running stayed open')

  // The reverse move takes one press, and it is the teacher's too: a class
  // sometimes ends before one more cell needed finishing.
  assert.ok(say(id, 'participant', { t: 'class:resume' }), 'a participant reopened the class themselves')
  assert.equal(say(id, 'host', { t: 'class:resume' }), null)
  assert.equal(isFinished(id), false)
  assert.equal(say(id, 'participant', { t: 'run', cellId: 'c_nope' }), null, 'the rights did not come back')
  assert.equal(storedRules(id).run, 'room', 'the settings did not survive the end of class')
})

test('the room learns about the bell from a frame, and a latecomer from the welcome', () => {
  /*
   * As a separate frame, not a field in `rules`: the stored rules do not
   * change. And in the welcome batch — otherwise a tab whose socket blinked
   * across the bell lives with open buttons until the end of the day.
   */
  const id = room()
  const seat = socket()
  const desk = socket()
  handleControlSocket(seat.ws, id, who(id, 'participant'))
  handleControlSocket(desk.ws, id, who(id, 'host'))

  const greeting = classFrame(seat.heard)
  assert.ok(greeting, 'the welcome batch has no class frame')
  assert.equal(greeting.finishedAt, null, 'a running class arrived finished')

  seat.heard.length = 0
  dispatch(desk.ws, id, who(id, 'host'), { t: 'class:finish' })

  const told = classFrame(seat.heard)
  assert.ok(told, 'the room was not told that the class had ended')
  assert.equal(typeof told.finishedAt, 'number')
  assert.equal(told.finishedAt, finishedAt(id))

  // And whoever joins after the bell learns the same from the welcome.
  const late = socket()
  handleControlSocket(late.ws, id, who(id, 'participant'))
  assert.equal(classFrame(late.heard)?.finishedAt, finishedAt(id))

  closeControlRoom(id)
})

/* ------------------------------------------------------ lecture console */

/**
 * All eight console messages: what the presenter drives the lecture with for
 * the whole audience.
 */
const REMOTE: ControlClientMessage[] = [
  { t: 'lecture:page', page: 8 },
  { t: 'lecture:blank', on: true },
  { t: 'ink', page: 7, id: 's_new', color: '#000000', width: 0.004, points: [0.3, 0.3, 0.4, 0.4] },
  { t: 'ink:undo', page: 7 },
  { t: 'ink:erase', page: 7, id: 's_first' },
  { t: 'ink:clear' },
  { t: 'laser', page: 7, x: 0.5, y: 0.5 },
  { t: 'laser:off' },
]

/** A lecture presented by a student: exactly what `board: 'room'` exists for. */
function lecture(id: string): void {
  startLecture(id, { file: 'lecture.pdf', by: 'p_participant', byName: 'Нина', color: '#d4162f' })
  turnTo(id, 7)
  addInk(id, {
    id: 's_first',
    page: 7,
    color: '#d4162f',
    width: 0.004,
    points: [0.1, 0.1, 0.2, 0.2],
  })
}

test('after the bell the console is taken from a student presenter, but the lecture is not shut down', () => {
  /*
   * A room where students take turns showing their work is not made up, and
   * a student can be the presenter in it. So the console does not ask about
   * the role at all, and without the bell that is right: the page is turned
   * by whoever presents.
   */
  const id = room()
  lecture(id)
  assert.equal(say(id, 'participant', { t: 'lecture:page', page: 8 }), null)
  assert.equal(lectureOf(id)?.page, 8, 'the student presenter cannot turn pages even before the bell')
  turnTo(id, 7)

  setFinished(id, Date.now())
  for (const message of REMOTE) {
    // The refusal is silent here, like all refusals in this block: the frame
    // comes from a tab that does not yet know the class is over.
    assert.equal(say(id, 'participant', message), null, `${message.t} answered in words`)
  }
  // The bell does not shut down the lecture: forty minutes of markup live only
  // in memory.
  assert.equal(lectureOf(id)?.file, 'lecture.pdf', 'the lecture went dark together with the class')
  assert.equal(lectureOf(id)?.page, 7, 'a student turned pages for the audience after the bell')
  assert.equal(lectureOf(id)?.blank, false, 'a student blanked the screen after the bell')
  assert.equal(inkOf(id).length, 1, 'the markup was touched after the bell')
  assert.equal(inkOf(id)[0]?.id, 's_first', 'a stroke was replaced after the bell')

  // The class was reopened, and the console went back to the same student.
  setFinished(id, null)
  assert.equal(say(id, 'participant', { t: 'lecture:page', page: 9 }), null)
  assert.equal(lectureOf(id)?.page, 9, 'the console did not come back with the class')
  stopLecture(id)
})

test('after the bell the teacher presents the lecture by taking over the console, as before', () => {
  const id = room()
  lecture(id)
  setFinished(id, Date.now())

  // The console does not move to the teacher by itself: there is still one
  // presenter.
  assert.equal(say(id, 'host', { t: 'lecture:page', page: 4 }), null)
  assert.equal(lectureOf(id)?.page, 7, 'the console went to someone who did not take it')

  // The takeover is the same `lecture:start` on the same file, and the markup
  // is intact.
  assert.equal(say(id, 'host', { t: 'lecture:start', file: 'lecture.pdf' }), null)
  assert.equal(lectureOf(id)?.by, 'p_host', 'the console did not pass to the teacher')
  assert.equal(lectureOf(id)?.page, 7, 'the takeover restarted the lecture')
  assert.equal(inkOf(id).length, 1, 'the takeover erased the markup')

  assert.equal(say(id, 'host', { t: 'lecture:page', page: 8 }), null)
  assert.equal(lectureOf(id)?.page, 8, 'the teacher cannot turn the pages of their own lecture')
  assert.equal(say(id, 'host', { t: 'ink:clear' }), null)
  assert.equal(inkOf(id).length, 0, 'the teacher cannot erase the markup after the bell')
  stopLecture(id)
})

test("after the bell a student's laser pointer does not reach the audience", () => {
  // The pointer has no state — it is only broadcast, and there is only one way
  // to check it: that the audience did not see it.
  const id = room()
  const hall = socket()
  handleControlSocket(hall.ws, id, who(id, 'host'))
  lecture(id)

  hall.heard.length = 0
  say(id, 'participant', { t: 'laser', page: 7, x: 0.5, y: 0.5 })
  assert.ok(
    hall.heard.some((frame) => frame.t === 'laser'),
    "the presenter's dot did not reach the audience even before the bell",
  )

  setFinished(id, Date.now())
  hall.heard.length = 0
  say(id, 'participant', { t: 'laser', page: 7, x: 0.6, y: 0.6 })
  assert.ok(
    !hall.heard.some((frame) => frame.t === 'laser'),
    "a student's pointer shines to the audience after the bell",
  )

  stopLecture(id)
  closeControlRoom(id)
})

/* ------------------------------------------------------ Oracle proposal */

/** A proposal in the room thread, the kind with "accept" and "reject". */
function propose(sessionId: string, participantId: string): string {
  const doc = getSessionDoc(sessionId).doc
  const entry = createChatEntry({
    participantId,
    name: 'Нина',
    color: '#d4162f',
    question: 'почини это',
    action: 'edit',
    cellId: 'c_nope',
  })
  doc.transact(() => getChat(doc).push([entry]))
  return entry.get('id') as string
}

/** What happened to the banner: `open` while nobody has touched it. */
function patchStateOf(sessionId: string, entryId: string): unknown {
  return findChatEntry(getSessionDoc(sessionId).doc, entryId)?.get('patchState')
}

test('while the class is running, anyone can reject a proposal', () => {
  // A dismissed banner destroys nothing: the Oracle is simply asked again.
  const id = room()
  const entryId = propose(id, 'p_host')
  assert.equal(say(id, 'participant', { t: 'ai:decide', entryId, accept: false }), null)
  assert.equal(patchStateOf(id, entryId), 'rejected', 'rejecting did not work even before the bell')
})

test('after the bell a participant cannot reject a proposal: there would be no way to get it back', () => {
  /*
   * `rejected` is set forever, and a participant can no longer ask the Oracle
   * again: a banner they dismiss is someone else's erased work, not a hint put
   * away.
   */
  const id = room()
  const entryId = propose(id, 'p_host')
  setFinished(id, Date.now())

  const denied = say(id, 'participant', { t: 'ai:decide', entryId, accept: false })
  assert.ok(denied?.includes(tr(CLASS_IS_OVER)), `the refusal is not about the end of class: ${denied}`)
  assert.equal(patchStateOf(id, entryId), 'open', 'the banner was dismissed after the bell')

  // "Accept" is closed by the `edit` rule, and it has the same sentence.
  const accept = say(id, 'participant', { t: 'ai:decide', entryId, accept: true })
  assert.ok(accept?.includes(tr(CLASS_IS_OVER)), `accept was refused by a rule: ${accept}`)
  assert.equal(patchStateOf(id, entryId), 'open')

  // The teacher decides after the bell too: they are the one finishing the
  // review.
  assert.equal(say(id, 'host', { t: 'ai:decide', entryId, accept: false }), null)
  assert.equal(patchStateOf(id, entryId), 'rejected', 'the teacher was refused')

  // And the class can be reopened — the right comes back with it.
  const second = propose(id, 'p_host')
  setFinished(id, null)
  assert.equal(say(id, 'participant', { t: 'ai:decide', entryId: second, accept: false }), null)
  assert.equal(patchStateOf(id, second), 'rejected', 'the right did not come back with the class')
})

/* ---------------------------------------------------- terminal drawer */

test('after the bell the terminal drawer opens but does not wake the shell', () => {
  /*
   * The feed is shared, and after class people come for exactly that — so
   * there is no refusal here. But there is no longer any reason to start the
   * container and a new shell just for reading.
   */
  const id = room()
  setFinished(id, Date.now())

  const seat = socket()
  dispatch(seat.ws, id, who(id, 'participant'), { t: 'term:open' })
  assert.ok(!seat.heard.some((frame) => frame.t === 'error'), 'the drawer refused to open with words')
  assert.equal(terminalPhase(id), 'closed', "reading the feed started the room's container")
  // The status goes out anyway: without it the tab waits for a start nobody
  // began.
  const status = seat.heard.find(
    (frame): frame is Extract<ControlServerMessage, { t: 'terminal' }> => frame.t === 'terminal',
  )
  assert.equal(status?.status, 'closed', 'the tab was not told that the shell is asleep')
})

test('while for the teacher the drawer still starts the shell', () => {
  // The teacher finishes the review after class, and needs a real shell for
  // it.
  const id = room()
  setFinished(id, Date.now())
  dispatch(socket().ws, id, who(id, 'host'), { t: 'term:open' })
  assert.equal(terminalPhase(id), 'starting', 'no shell was started for the teacher')
})

/* ------------------------------------------------ stopping Oracle work */

function cancelEntry(sessionId: string, role: 'host' | 'participant', entryId: string) {
  return fetch(`${base}/api/sessions/${sessionId}/ai/cancel`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenFor(sessionId, role)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ entryId }),
  })
}

/**
 * Who stops it — and this is no longer about the bell.
 *
 * The test lives here because this is the only place in the suite with the
 * "Oracle routes + a real teacher" combination, and the rule is the same on
 * both sides of the bell; checking it separately would mean pretending there
 * are two.
 */
test("the author stops their own entry, only the teacher stops someone else's", async () => {
  /*
   * "Anyone can stop it, it destroys nothing" is true exactly for one's own
   * entry. Cutting off someone else's answer erases work a person is waiting
   * for; cutting off someone else's agent turn leaves a file edit half done.
   */
  const id = 'class-cancel-own'
  createSession(id, 'Чей вопрос', null)
  const mine = propose(id, `p_${id}_participant`)
  const theirs = propose(id, `p_${id}_host`)

  const denied = await cancelEntry(id, 'participant', theirs)
  assert.equal(denied.status, 403, "a participant cut off someone else's work in the middle of class")
  const body = (await denied.json()) as { error: string }
  assert.match(body.error, /свой вопрос/, `the refusal did not name the rule: ${body.error}`)
  assert.ok(!body.error.includes(tr(CLASS_IS_OVER)), 'the refusal referred to a bell that never rang')

  assert.equal(
    (await cancelEntry(id, 'participant', mine)).status,
    200,
    "one's own entry cannot be stopped",
  )
  // The teacher really needs to stop someone else's: a runaway answer hangs on
  // the projector in front of the whole room, and someone in the audience
  // asked for it.
  assert.equal((await cancelEntry(id, 'host', theirs)).status, 200, 'the teacher was refused')
})

test('after the bell the rule is the same', async () => {
  // The bell adds nothing here and takes nothing away — and that is checked,
  // because a separate check for it was removed from the route as redundant.
  const id = 'class-cancel'
  createSession(id, 'Обрыв', null)
  const mine = propose(id, `p_${id}_participant`)
  const theirs = propose(id, `p_${id}_host`)

  setFinished(id, Date.now())
  assert.equal(
    (await cancelEntry(id, 'participant', theirs)).status,
    403,
    "a participant cut off someone else's work after the bell",
  )
  assert.equal(
    (await cancelEntry(id, 'participant', mine)).status,
    200,
    "one's own entry, asked before the bell, cannot be stopped",
  )
  assert.equal((await cancelEntry(id, 'host', theirs)).status, 200, 'the teacher was refused')

  setFinished(id, null)
  assert.equal(
    (await cancelEntry(id, 'participant', theirs)).status,
    403,
    "the reopened class brought back the right to someone else's entry",
  )
})
