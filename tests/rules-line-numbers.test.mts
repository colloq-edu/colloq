/**
 * Line numbers in code: a property of the room that changes how the notebook
 * looks and nothing else.
 *
 * Three promises, and each breaks silently. The default is hidden for every
 * room, one stored before the field existed included, so a rollout moves
 * nobody's code. It is not a right: a lecture where the teacher showed the
 * numbers stays a lecture, the bell leaves them as they were, and a personal
 * notebook shows them exactly when the room does. And it is not announced:
 * "The teacher changed what can be done in this room" for a change nobody can
 * act on sends the class looking for a button that stopped working.
 *
 * And the road, checked through the real doors rather than `setRules`: the
 * room's own door and the panel's store the choice through `readRules` and
 * tell every socket of the room at once, garbage reads as hidden, and the
 * panel's two creating doors keep the row the teacher set on the form.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { WebSocket } from 'ws'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { ControlServerMessage } from '../shared/protocol.js'
import {
  changesWhatCanBeDone,
  COUNCIL_ROOM,
  isCouncilRoom,
  isLectureRoom,
  LECTURE_ROOM,
  OPEN_ROOM,
  readRules,
  rulesAfterClass,
  rulesForBook,
  type RoomRules,
} from '../shared/rules.js'
import { app } from '../server/src/app.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner, rotateLinkKey } from '../server/src/admin/store.js'
import { signToken } from '../server/src/auth.js'
import { closeControlRoom, handleControlSocket } from '../server/src/control.js'
import { createSession, setRules, storedRules, upsertParticipant } from '../server/src/db.js'

/* ------------------------------------------------------------ the rule */

test('line numbers are hidden in every preset and in every row written before them', () => {
  for (const [name, preset] of [
    ['open', OPEN_ROOM],
    ['lecture', LECTURE_ROOM],
    ['council', COUNCIL_ROOM],
  ] as const) {
    assert.equal(preset.lineNumbers, 'off', `the ${name} preset shows line numbers`)
  }
  // A seminar stored before the field existed, and a room never configured.
  assert.equal(readRules(JSON.stringify({ run: 'host', danger: 'allow' })).lineNumbers, 'off')
  assert.equal(readRules(null).lineNumbers, 'off')
  assert.equal(readRules({ lineNumbers: 'on' }).lineNumbers, 'on')
})

test('only an exact "on" shows them: anything else reads as hidden', () => {
  for (const junk of ['On', 'yes', 'shown', true, 1, {}, null]) {
    assert.equal(
      readRules({ lineNumbers: junk }).lineNumbers,
      'off',
      `${JSON.stringify(junk)} showed the numbers`,
    )
  }
})

test('line numbers are not a right: the lecture stays a lecture, and an open room stays open', () => {
  // The "Lecture" banner is about who types and runs; the numbers change neither.
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, lineNumbers: 'on' }), true)
  assert.equal(isCouncilRoom({ ...COUNCIL_ROOM, lineNumbers: 'on' }), true)
  assert.equal(isLectureRoom({ ...OPEN_ROOM, lineNumbers: 'on' }), false)
})

test('the bell leaves line numbers as the teacher set them, in both directions', () => {
  assert.equal(rulesAfterClass({ ...OPEN_ROOM, lineNumbers: 'on' }).lineNumbers, 'on')
  assert.equal(rulesAfterClass(LECTURE_ROOM).lineNumbers, 'off')
  // Applying the bell twice gives the same, numbers included.
  const once = rulesAfterClass({ ...OPEN_ROOM, lineNumbers: 'on' })
  assert.deepEqual(rulesAfterClass(once), once)
})

test('a personal notebook shows the numbers exactly when the room does', () => {
  const rules: RoomRules = {
    ...LECTURE_ROOM,
    lineNumbers: 'on',
    books: { 'nb:draft': { access: 'owner', owner: 'p_akim', ownerName: 'Аким' } },
  }
  // The author gets the notebook opened up, and the look stays the room's.
  const mine = rulesForBook(rules, 'nb:draft', { role: 'participant', participantId: 'p_akim' })
  assert.equal(mine.edit, 'room', 'the personal notebook did not open for its author')
  assert.equal(mine.lineNumbers, 'on', "the author's own notebook lost the room's numbers")
  // Somebody else watching that notebook sees the same numbers.
  const theirs = rulesForBook(rules, 'nb:draft', { role: 'participant', participantId: 'p_boris' })
  assert.equal(theirs.lineNumbers, 'on')
  // And a room without them has none in the personal notebook either.
  const hidden = rulesForBook({ ...rules, lineNumbers: 'off' }, 'nb:draft', {
    role: 'participant',
    participantId: 'p_akim',
  })
  assert.equal(hidden.lineNumbers, 'off')
})

/* ----------------------------------------------- what the room is told */

test('a change of line numbers alone is not announced to the room', () => {
  assert.equal(changesWhatCanBeDone(OPEN_ROOM, { ...OPEN_ROOM, lineNumbers: 'on' }), false)
  assert.equal(changesWhatCanBeDone({ ...LECTURE_ROOM, lineNumbers: 'on' }, LECTURE_ROOM), false)
  // The page cache may hold a string from an older build: it is read the same way.
  assert.equal(
    changesWhatCanBeDone(JSON.stringify({ run: 'host' }), { ...OPEN_ROOM, run: 'host', lineNumbers: 'on' }),
    false,
  )
  // But the numbers do not hide a real change that arrives with them.
  assert.equal(changesWhatCanBeDone(OPEN_ROOM, { ...OPEN_ROOM, lineNumbers: 'on', edit: 'host' }), true)
})

/**
 * A value of every other rule that the room keeps and the default does not
 * have.
 *
 * The loop below walks the rules themselves, not this list, so a rule added
 * tomorrow fails here by name until somebody says whether its change is
 * announced.
 */
const ANOTHER: Partial<Record<keyof RoomRules, unknown>> = {
  run: 'host',
  edit: 'host',
  structure: 'add',
  board: 'room',
  files: 'host',
  wipe: 'room',
  restart: 'room',
  agent: 'off',
  agentSteps: 5,
  history: 'host',
  oracle: 'off',
  questionsPerHour: 3,
  slowModeSeconds: 30,
  model: 'gpt-4o-mini',
  opens: 'council',
  ownBooks: 'on',
  ownMemoryMb: 2048,
  ownCpus: 2,
  cellLimitSec: 60,
  danger: 'allow',
}

test('a change of any other rule is announced, exactly as before line numbers', () => {
  for (const key of Object.keys(OPEN_ROOM) as (keyof RoomRules)[]) {
    if (key === 'lineNumbers') continue
    assert.ok(key in ANOTHER, `rule ${key} has no second value here: is its change announced?`)
    const changed = readRules({ ...OPEN_ROOM, [key]: ANOTHER[key] })
    assert.notEqual(changed[key], OPEN_ROOM[key], `${key}: the test value reads back as the default`)
    assert.equal(changesWhatCanBeDone(OPEN_ROOM, changed), true, `a change of ${key} is no longer announced`)
  }
})

test('the notebook map is compared by its records, not by reference', () => {
  const akim = { access: 'owner' as const, owner: 'p_akim', ownerName: 'Аким' }
  const boris = { access: 'owner' as const, owner: 'p_boris', ownerName: 'Борис' }
  const room: RoomRules = { ...OPEN_ROOM, books: { 'nb:a': akim, 'nb:b': boris } }
  /*
   * Two reads of one map are two objects, and the welcome frame of every
   * reconnect is exactly that. Compared by reference, a room with a single
   * personal notebook heard "the teacher changed what can be done" on each
   * reconnect, and on every line-number switch too.
   */
  assert.equal(changesWhatCanBeDone(room, JSON.parse(JSON.stringify(room))), false)
  assert.equal(changesWhatCanBeDone(room, { ...room, books: { 'nb:b': boris, 'nb:a': akim } }), false)
  assert.equal(changesWhatCanBeDone(room, { ...room, lineNumbers: 'on' }), false)
  // A changed access is a change.
  assert.equal(changesWhatCanBeDone(room, { ...room, books: { 'nb:a': { ...akim, access: 'host' }, 'nb:b': boris } }), true)
  // A student's own notebook made or removed is not the teacher changing the room: the first one, a later one, the last one.
  assert.equal(changesWhatCanBeDone(OPEN_ROOM, { ...OPEN_ROOM, books: { 'nb:a': akim } }), false)
  assert.equal(changesWhatCanBeDone({ ...OPEN_ROOM, books: { 'nb:a': akim } }, room), false)
  assert.equal(changesWhatCanBeDone(room, { ...room, books: { 'nb:a': akim } }), false)
  assert.equal(changesWhatCanBeDone(room, OPEN_ROOM), false)
  // While the teacher's own record that comes or goes is: a notebook given an access with no author behind it.
  const set = { access: 'host' as const, owner: null, ownerName: null }
  assert.equal(changesWhatCanBeDone(room, { ...room, books: { ...room.books, 'nb:lecture': set } }), true)
  assert.equal(changesWhatCanBeDone({ ...room, books: { ...room.books, 'nb:lecture': set } }, room), true)
  // And so is a student's notebook the teacher opened to others: its access changed, not its existence.
  assert.equal(changesWhatCanBeDone(room, { ...room, books: { 'nb:a': { ...akim, access: 'all' }, 'nb:b': boris } }), true)
})

/** Code without explanations: a comment is not a promise. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('the room asks the shared comparison before saying anything, and keeps no copy of its own', () => {
  // The store is a runes class with no browser here, so its wiring is read from the source.
  const session = code(
    fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/src/lib/session.svelte.ts'), 'utf8'),
  )
  assert.match(session, /const changed = changesWhatCanBeDone\(this\.session\.rules, message\.rules\)/)
  assert.match(session, /if \(!first && changed\) this\.rulesChangedAt = Date\.now\(\)/)
  // The new value reaches the page whether or not it is announced.
  assert.match(session, /this\.session = \{ \.\.\.this\.session, rules: message\.rules \}/)
  assert.doesNotMatch(session, /function sameRules/, 'a second copy of the comparison would drift')
})

/* -------------------------------------------------------------- doors */

let base = ''
let server: http.Server
let staff = ''

function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner =
    oldestOwner() ?? createTeacher({ name: 'Владелец', email: 'lines.owner@example.edu', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  staff = mintCookie(owner)
})

after(() => server?.close())

/** A token the server recognizes: the role is read from the participant row on every request. */
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
  return signToken({ sessionId, participantId, role, iat: Date.now() })
}

function patchRules(sessionId: string, rules: unknown, role: 'host' | 'participant' = 'host') {
  return fetch(`${base}/api/sessions/${sessionId}/rules`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${tokenFor(sessionId, role)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ rules }),
  })
}

function panel(method: string, url: string, body: unknown) {
  return fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: staff },
    body: JSON.stringify(body),
  })
}

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

const rulesFrames = (heard: ControlServerMessage[]) =>
  heard.filter((frame): frame is Extract<ControlServerMessage, { t: 'rules' }> => frame.t === 'rules')

/** A seat in the room, with its welcome batch already heard and set aside. */
function seat(sessionId: string): ControlServerMessage[] {
  const { ws, heard } = socket()
  handleControlSocket(ws, sessionId, { sessionId, participantId: 'p_seat', role: 'participant' })
  heard.length = 0
  return heard
}

test("the room's door stores line numbers and tells every socket of the room at once", async () => {
  const id = 'lines-room-door'
  createSession(id, 'Номера строк', null)
  setRules(id, LECTURE_ROOM)
  const heard = seat(id)

  const res = await patchRules(id, { lineNumbers: 'on' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { rules: RoomRules }).rules.lineNumbers, 'on')
  assert.equal(storedRules(id).lineNumbers, 'on', 'the choice did not reach the database')
  // Laid over the current rules: the lecture is still a lecture.
  assert.equal(storedRules(id).edit, 'host')
  assert.equal(isLectureRoom(storedRules(id)), true)

  const told = rulesFrames(heard)
  assert.equal(told.length, 1, 'the room was not told')
  assert.equal(told[0]!.rules.lineNumbers, 'on')

  // Whoever comes in later learns it from the welcome batch.
  const late = socket()
  handleControlSocket(late.ws, id, { sessionId: id, participantId: 'p_late', role: 'participant' })
  assert.equal(rulesFrames(late.heard)[0]?.rules.lineNumbers, 'on')

  closeControlRoom(id)
})

test('garbage at the door reads as hidden, and only the teacher switches the numbers', async () => {
  const id = 'lines-junk'
  createSession(id, 'Мусор в правилах', null)
  setRules(id, { ...OPEN_ROOM, lineNumbers: 'on' })

  const res = await patchRules(id, { lineNumbers: 'yes' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { rules: RoomRules }).rules.lineNumbers, 'off')
  assert.equal(storedRules(id).lineNumbers, 'off')

  const refused = await patchRules(id, { lineNumbers: 'on' }, 'participant')
  assert.equal(refused.status, 403)
  assert.equal(storedRules(id).lineNumbers, 'off', 'a student switched the numbers for the room')
})

test("the panel's settings store line numbers and tell the room too", async () => {
  const id = 'lines-panel-door'
  createSession(id, 'Номера из панели', null)
  setRules(id, COUNCIL_ROOM)
  const heard = seat(id)

  const res = await panel('PATCH', `/api/admin/seminars/${id}`, { rules: { lineNumbers: 'on' } })
  assert.equal(res.status, 200)
  // The list row the settings dialog redraws from carries the choice.
  assert.equal(((await res.json()) as { rules: RoomRules }).rules.lineNumbers, 'on')
  assert.deepEqual(storedRules(id), { ...COUNCIL_ROOM, lineNumbers: 'on' })
  assert.equal(rulesFrames(heard)[0]?.rules.lineNumbers, 'on', 'the room was not told')

  closeControlRoom(id)
})

test('the creating doors keep the row the teacher set on the form, on top of the mode', async () => {
  const made = await panel('POST', '/api/admin/seminars', {
    name: 'Лекция с номерами',
    mode: 'lecture',
    rules: { ...LECTURE_ROOM, lineNumbers: 'on' },
  })
  assert.equal(made.status, 201)
  const created = ((await made.json()) as { id: string }).id
  assert.deepEqual(storedRules(created), { ...LECTURE_ROOM, lineNumbers: 'on' })

  const imported = await panel('POST', '/api/admin/import/notebook', {
    name: 'Импорт с номерами',
    filename: 'lines.ipynb',
    cells: [{ cell_type: 'code', source: 'x = 1' }],
    mode: 'council',
    rules: { lineNumbers: 'on' },
  })
  assert.equal(imported.status, 201)
  const id = ((await imported.json()) as { id: string }).id
  assert.deepEqual(storedRules(id), { ...COUNCIL_ROOM, lineNumbers: 'on' })
})
