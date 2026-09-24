/**
 * The council on the server: the lock's third position, attempts, the stack,
 * the sheet.
 *
 * Three design rules, each one as an assertion: everyone has their own sheet
 * (a student never sees someone else's attempt, only the teacher sees the
 * stack); whoever leads runs (a student only via the control, with a queue
 * number); the class sees what the teacher showed (the text lands in the
 * shared cell by the teacher's hand).
 *
 * No network, no kernel: the sockets are fake, the room is real, the
 * dispatcher is the same one that listens to the wire. Attempts go through a
 * real SQLite in a temporary folder — the "survive a restart" check rests on
 * that.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setFinished, setRules, upsertParticipant, db, finishedAt } from '../server/src/db.js'
import {
  closeControlRoom,
  dispatch,
  flushCouncilBoards,
  handleControlSocket,
  purgeCouncilOf,
} from '../server/src/control.js'
import { attemptsOf, oracleOf, resetCouncilCache, saveDraft, setOracle, submitAttempt } from '../server/src/council.js'
import { listActivity } from '../server/src/activity.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import {
  cellId,
  cellLock,
  cellSource,
  councilSettingsOf,
  DEFAULT_COUNCIL,
  createCell,
  findCell,
  getCells,
} from '../shared/notebook.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import { groupAttempts } from '../web/src/lib/council-board.js'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilBoard,
  CouncilMine,
  CouncilOracle,
  CouncilShown,
} from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
}

/** Exactly what `send` and `handleControlSocket` read: the state, receiving, subscriptions. */
function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      // As a string or as bytes: frames the server builds once per room
      // (broadcast, tree, ink) go out already encoded — see control.ts ·
      // sendFrame. A real socket makes no difference here.
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
    },
  }
  return { ws: fake as unknown as WebSocket, heard }
}

interface Person {
  payload: TokenPayload
  sock: Fake
}

interface Room {
  id: string
  cell: string
  teacher: Person
  petya: Person
  masha: Person
}

let rooms = 0

function join(
  sessionId: string,
  participantId: string,
  name: string,
  role: 'host' | 'participant',
): Person {
  upsertParticipant({ id: participantId, sessionId, name, avatar: null, role })
  const payload: TokenPayload = { sessionId, participantId, role }
  const sock = socket()
  handleControlSocket(sock.ws, sessionId, payload)
  return { payload, sock }
}

/** A lecture room with one cell and three people, all on the wire. */
function room(): Room {
  const id = `council-${++rooms}`
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const made = createCell('code', '# задание: посчитайте x')
  doc.transact(() => getCells(doc).push([made]))
  return {
    id,
    cell: cellId(made),
    // The ids include the room name: a participant row is one per instance
    // (participants.id is the key), and "Petya" from a neighbouring test
    // would otherwise stay registered in the previous room and read here as
    // "Someone".
    teacher: join(id, `${id}_teacher`, 'Ада', 'host'),
    petya: join(id, `${id}_petya`, 'Петя', 'participant'),
    masha: join(id, `${id}_masha`, 'Маша', 'participant'),
  }
}

/** What the server answered to this message with an error; `null` means it answered nothing. */
function say(at: Room, who: Person, message: ControlClientMessage): string | null {
  const before = who.sock.heard.length
  dispatch(who.sock.ws, at.id, who.payload, message)
  const fresh = who.sock.heard.slice(before)
  const error = fresh.find((m) => m.t === 'error')
  return error && error.t === 'error' ? error.message : null
}

function lastBoard(who: Person, cell: string): CouncilBoard | null {
  for (let i = who.sock.heard.length - 1; i >= 0; i--) {
    const m = who.sock.heard[i]
    if (m.t === 'council:board' && m.cellId === cell) return m.board
  }
  return null
}

function lastMine(who: Person, cell: string): CouncilMine | null {
  for (let i = who.sock.heard.length - 1; i >= 0; i--) {
    const m = who.sock.heard[i]
    if (m.t === 'council:mine' && m.cellId === cell) return m.state
  }
  return null
}

function lastCount(who: Person, cell: string): { submitted: number; total: number } | null {
  for (let i = who.sock.heard.length - 1; i >= 0; i--) {
    const m = who.sock.heard[i]
    if (m.t === 'council:count' && m.cellId === cell) {
      return { submitted: m.submitted, total: m.total }
    }
  }
  return null
}

/**
 * The last "what is on screen" frame to this person. `undefined` means there
 * was no frame at all (which is not the same as `null`: `null` means
 * "cleared from the screen").
 */
function lastShown(who: Person, cell: string): CouncilShown | null | undefined {
  for (let i = who.sock.heard.length - 1; i >= 0; i--) {
    const m = who.sock.heard[i]
    if (m.t === 'council:shown' && m.cellId === cell) return m.shown
  }
  return undefined
}

function lockOf(at: Room): string {
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  return found ? cellLock(found.cell) : 'no such cell'
}

/**
 * The stack after all deferred frames, as the console sees it: the last full
 * one and the deltas on top of it (with the same merge as the client's —
 * council.svelte.ts · withPatch, done by hand here: there is no Svelte
 * compiler in the test). The test does not wait for the batching window.
 */
function board(at: Room): CouncilBoard {
  flushCouncilBoards(at.id)
  const heard = at.teacher.sock.heard
  let start = -1
  for (let i = heard.length - 1; i >= 0; i--) {
    const m = heard[i]
    if (m.t === 'council:board' && m.cellId === at.cell) {
      start = i
      break
    }
  }
  assert.ok(start >= 0, 'the host did not get the stack')
  const full = heard[start] as Extract<ControlServerMessage, { t: 'council:board' }>
  let got = full.board
  for (const m of heard.slice(start + 1)) {
    if (m.t !== 'council:patch' || m.cellId !== at.cell) continue
    const fresh = new Map(m.attempts.map((a) => [a.participantId, a]))
    const attempts = got.attempts
      .filter((a) => !m.removed.includes(a.participantId))
      .map((a) => fresh.get(a.participantId) ?? a)
    for (const a of m.attempts)
      if (!attempts.some((x) => x.participantId === a.participantId)) attempts.push(a)
    // A delta carries no groups — the console computes them itself from the
    // full list.
    got = {
      ...got,
      attempts,
      groups: groupAttempts(attempts, got.oracle?.groupLabels ?? {}),
      counts: m.counts,
      lock: m.lock,
      settings: m.settings,
    }
  }
  return got
}

/** How many stack frames of each kind went to the host for the cell. */
function frames(at: Room): { full: number; patch: number } {
  flushCouncilBoards(at.id)
  let full = 0
  let patch = 0
  for (const m of at.teacher.sock.heard) {
    if (m.t === 'council:board' && m.cellId === at.cell) full++
    if (m.t === 'council:patch' && m.cellId === at.cell) patch++
  }
  return { full, patch }
}

function council(
  at: Room,
  settings?: { studentRun?: boolean | 'request'; namesOnProjector?: boolean },
): void {
  assert.equal(
    say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council', settings }),
    null,
  )
}

/* ----------------------------------------------------------------- lock */

test('the teacher puts a cell into council — and the room learns about it over the wire', () => {
  const at = room()
  assert.match(
    say(at, at.petya, { t: 'cell:lock', cellId: at.cell, state: 'council' }) ?? '',
    /преподавател/i,
  )
  assert.equal(lockOf(at), 'closed', 'a participant opened the council for themselves')

  council(at)
  assert.equal(lockOf(at), 'council')
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  // The defaults as a whole, not by listing: a control added tomorrow must
  // arrive on a new cell with its own default instead of breaking this line.
  assert.deepEqual(councilSettingsOf(found!.cell), DEFAULT_COUNCIL)

  // The host gets the stack, everyone their own empty sheet, the room a
  // counter.
  assert.equal(board(at).lock, 'council')
  assert.deepEqual(lastMine(at.petya, at.cell)?.closed, false)
  assert.deepEqual(lastMine(at.masha, at.cell)?.closed, false)
  assert.deepEqual(lastCount(at.masha, at.cell), { submitted: 0, total: 0 })

  // `cell:open` remained a special case for two positions — and is read by
  // the same code.
  assert.equal(say(at, at.teacher, { t: 'cell:open', cellId: at.cell, open: true }), null)
  assert.equal(lockOf(at), 'open')
  closeControlRoom(at.id)
})

/* ------------------------------------------------------ one's own sheet */

test('a snapshot goes to the host as the stack and to the author as the sheet — and to nobody else', () => {
  const at = room()
  council(at)
  assert.equal(
    say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1  # ответ' }),
    null,
  )

  const stack = board(at)
  assert.equal(stack.counts.attempts, 1)
  assert.equal(stack.counts.writing, 1)
  assert.equal(stack.attempts[0].text, 'x = 1  # ответ')
  assert.equal(stack.attempts[0].name, 'Петя')
  assert.equal(stack.attempts[0].groupKey, 'x=1', 'the server sets the group key by normalization')
  assert.equal(stack.groups.length, 0, 'someone still writing got into the groups — only submitted ones go there')

  assert.equal(lastMine(at.petya, at.cell)?.text, 'x = 1  # ответ')
  assert.deepEqual(lastCount(at.masha, at.cell), { submitted: 0, total: 1 })

  // Masha is a participant: neither the stack nor someone else's sheet.
  // Never.
  assert.equal(
    at.masha.sock.heard.some((m) => m.t === 'council:board'),
    false,
    'the stack went to a participant',
  )
  assert.equal(
    at.masha.sock.heard.some((m) => m.t === 'council:mine' && m.state.text.length > 0),
    false,
    'someone else\'s attempt went to a participant',
  )
  closeControlRoom(at.id)
})

test('submit and change: groups are counted only by submitted ones', () => {
  const at = room()
  council(at)
  assert.match(
    say(at, at.petya, { t: 'council:submit', cellId: at.cell }) ?? '',
    /Попытка пуста/i,
    'an empty space was submitted',
  )
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x=1 # тоже' })
  assert.equal(say(at, at.petya, { t: 'council:submit', cellId: at.cell }), null)
  assert.equal(say(at, at.masha, { t: 'council:submit', cellId: at.cell }), null)

  assert.equal(typeof lastMine(at.petya, at.cell)?.submittedAt, 'number')
  const stack = board(at)
  assert.equal(stack.counts.submitted, 2)
  assert.equal(stack.groups.length, 1, 'identical after normalization — one group')
  assert.equal(stack.groups[0].count, 2)
  // Submitted in the same millisecond — "the earliest" is decided by the
  // typing time and id; what matters is that it is one of the two and the
  // same one from frame to frame.
  assert.ok(
    stack.groups[0].members.includes(stack.groups[0].representative),
    'the representative is from the group',
  )
  assert.equal(stack.groups[0].representative, board(at).groups[0].representative)
  assert.deepEqual(lastCount(at.masha, at.cell), { submitted: 2, total: 2 })

  assert.equal(say(at, at.petya, { t: 'council:withdraw', cellId: at.cell }), null)
  assert.equal(lastMine(at.petya, at.cell)?.submittedAt, null)
  assert.equal(board(at).groups[0].count, 1)
  closeControlRoom(at.id)
})

/* ------------------------------------------------------- the lead's actions */

test('"show to the class" does not touch the cell text but goes to everyone as a signed badge', () => {
  const at = room()
  const task = '# задание: посчитайте x'
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })

  assert.match(
    say(at, at.masha, {
      t: 'council:show',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
    }) ?? '',
    /преподавател/i,
  )
  assert.equal(
    say(at, at.teacher, {
      t: 'council:show',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
    }),
    null,
  )

  // The main thing: the stub is in place. 'x = 42' used to lie here — an edit
  // in the teacher's name that they never made.
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.equal(cellSource(found!.cell).toString(), task, 'showing rewrote the shared cell')

  // The badge went to the WHOLE room, not to a single console: signed and
  // with the code.
  const seen = lastShown(at.masha, at.cell)
  assert.equal(seen?.participantId, at.petya.payload.participantId)
  assert.equal(seen?.name, 'Петя')
  assert.equal(seen?.text, 'x = 42')
  assert.equal(seen?.shownBy, 'Ада')
  assert.ok((seen?.shownAt ?? 0) > 0, 'the show has no time')
  assert.equal(seen?.variant, 1)
  assert.equal(seen?.alsoWrote, 0)
  assert.equal(seen?.run, null, 'the teacher did not run anything')
  // And to the author — with the same frame, and with their sheet: they see
  // "your variant".
  assert.equal(lastShown(at.petya, at.cell)?.participantId, at.petya.payload.participantId)
  assert.equal(lastMine(at.petya, at.cell)?.shown, true)
  assert.equal(board(at).attempts[0].shown, true)

  // The shared text in the council is still locked: the cell stayed a cell.
  assert.equal(lockOf(at), 'council')
  closeControlRoom(at.id)
})

test('"clear the screen" resets the badge for everyone, and the cell text again has nothing to do with it', () => {
  const at = room()
  const task = '# задание: посчитайте x'
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, {
    t: 'council:show',
    cellId: at.cell,
    participantId: at.petya.payload.participantId,
  })

  // Only the lead may clear — by the same rule as showing.
  assert.match(
    say(at, at.masha, { t: 'council:show:clear', cellId: at.cell }) ?? '',
    /преподавател/i,
  )
  assert.equal(say(at, at.teacher, { t: 'council:show:clear', cellId: at.cell }), null)

  assert.equal(lastShown(at.masha, at.cell), null, 'the neighbour still has the badge')
  assert.equal(lastShown(at.petya, at.cell), null)
  assert.equal(lastMine(at.petya, at.cell)?.shown, false)
  assert.equal(board(at).attempts[0].shown, false)
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.equal(cellSource(found!.cell).toString(), task)
  closeControlRoom(at.id)
})

test('showing someone else replaces the badge instead of adding a second one', () => {
  const at = room()
  council(at)
  const petya = at.petya.payload.participantId
  const masha = at.masha.payload.participantId
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 43' })
  say(at, at.masha, { t: 'council:submit', cellId: at.cell })

  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: masha })

  assert.equal(lastShown(at.petya, at.cell)?.participantId, masha)
  assert.equal(lastMine(at.petya, at.cell)?.shown, false, 'the mark was not removed from the previous one')
  assert.equal(lastMine(at.masha, at.cell)?.shown, true)
  assert.equal(
    attemptsOf(at.id, at.cell).filter((one) => one.shown).length,
    1,
    'two on the screen at once',
  )
  closeControlRoom(at.id)
})

test('the author rewrote the shown text — the badge goes away for the whole room', () => {
  const at = room()
  council(at)
  const petya = at.petya.payload.participantId
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })
  assert.equal(lastShown(at.masha, at.cell)?.text, 'x = 42')

  /*
   * "On screen" is glued to the text, not to the person (saveDraft) — but
   * only the author knew about it: under the neighbour's cell hung code that
   * no longer exists for anyone.
   */
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 43' })
  assert.equal(lastShown(at.masha, at.cell), null)
  closeControlRoom(at.id)
})

test('names on the projector off: "Variant N" and not a single name in the frame', () => {
  const at = room()
  council(at, { namesOnProjector: false })
  const petya = at.petya.payload.participantId
  // Masha submitted first — so Petya's variant is the second: the number
  // follows submission time.
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:submit', cellId: at.cell })
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })

  const seen = lastShown(at.masha, at.cell)
  assert.equal(seen?.name, null, 'the name reached someone else\'s browser')
  assert.equal(seen?.color, null)
  assert.equal(seen?.avatar, null)
  assert.equal(seen?.variant, 2)
  assert.equal(seen?.participantId, petya)
  // And not a single frame to this person has the author's name at all —
  // neither in the badge nor anywhere else: they do not get the stack.
  assert.ok(
    !JSON.stringify(at.masha.sock.heard.filter((m) => m.t === 'council:shown')).includes('Петя'),
    'the author\'s name went to a student',
  )

  // The control was clicked back — the label arrives as a name, with the same
  // frame.
  say(at, at.teacher, {
    t: 'cell:lock',
    cellId: at.cell,
    state: 'council',
    settings: { namesOnProjector: true },
  })
  assert.equal(lastShown(at.masha, at.cell)?.name, 'Петя')
  assert.equal(lastShown(at.masha, at.cell)?.variant, 2, 'the number moved because of someone else\'s press')
  closeControlRoom(at.id)
})

test('"K more wrote the same" is counted among submitted ones and without the author', () => {
  const at = room()
  council(at)
  const petya = at.petya.payload.participantId
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 1  # то же самое' })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })
  assert.equal(lastShown(at.masha, at.cell)?.alsoWrote, 0, 'an unsubmitted one was counted')

  say(at, at.masha, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })
  assert.equal(lastShown(at.masha, at.cell)?.alsoWrote, 1)
  closeControlRoom(at.id)
})

test('the number of the shown solution counts submitted ones before any drafts', () => {
  const at = room()
  council(at)
  const petya = at.petya.payload.participantId
  saveDraft(at.id, at.cell, at.masha.payload.participantId, 'still writing', 1000)
  saveDraft(at.id, at.cell, petya, 'finished', 2000)
  submitAttempt(at.id, at.cell, petya, 3000)
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })
  assert.equal(lastShown(at.masha, at.cell)?.variant, 1, 'an earlier draft must not consume a submitted variant number')
  closeControlRoom(at.id)
})

test('showing and clearing land in the class events — with the author in subjectId', () => {
  const at = room()
  council(at)
  const petya = at.petya.payload.participantId
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })
  say(at, at.teacher, { t: 'council:show:clear', cellId: at.cell })

  const events = listActivity(at.id, { level: 'normal', category: 'council' }).events
  const shown = events.find((one) => one.kind === 'council.shown')
  const unshown = events.find((one) => one.kind === 'council.unshown')
  assert.equal(shown?.actor?.id, at.teacher.payload.participantId)
  assert.equal(shown?.details.subjectId, petya)
  assert.equal(shown?.details.cellId, at.cell)
  assert.equal(unshown?.details.subjectId, petya)
  closeControlRoom(at.id)
})

test('"on screen" and "correct" are glued to the text: the text changed — they are removed, the reply stayed', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  const petya = at.petya.payload.participantId
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })
  say(at, at.teacher, { t: 'council:mark', cellId: at.cell, participantId: petya, correct: true })
  say(at, at.teacher, {
    t: 'council:reply',
    cellId: at.cell,
    to: { participantId: petya },
    text: 'Хорошо',
  })
  assert.equal(lastMine(at.petya, at.cell)?.shown, true)
  assert.equal(lastMine(at.petya, at.cell)?.correct, true)

  // "Change" and an echo of the same text remove nothing: the text is the
  // same.
  say(at, at.petya, { t: 'council:withdraw', cellId: at.cell })
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  assert.equal(lastMine(at.petya, at.cell)?.shown, true)
  assert.equal(lastMine(at.petya, at.cell)?.correct, true)

  // A different text — it is not in the shared cell and nobody checked it.
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 43' })
  const mine = lastMine(at.petya, at.cell)
  assert.equal(mine?.shown, false, '"On screen" over a text that is not on the screen')
  assert.equal(mine?.correct, null, '"correct" over unchecked code')
  assert.equal(mine?.reply?.text, 'Хорошо', 'the reply is a letter to a person, it stays')
  const card = board(at).attempts.find((a) => a.participantId === petya)
  assert.equal(card?.shown, false)
  assert.equal(card?.status, 'unrun')
  closeControlRoom(at.id)
})

test('the group state goes by all members: a mark on a non-representative\'s card colours the group', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 1  # тоже' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.masha, { t: 'council:submit', cellId: at.cell })
  // Submitted in the same millisecond — who the representative is gets
  // decided by id; the mark is given to the one who did NOT become it.
  const [before] = board(at).groups
  const other = before.members.find((id) => id !== before.representative)!
  say(at, at.teacher, { t: 'council:mark', cellId: at.cell, participantId: other, correct: true })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: other })
  const [group] = board(at).groups
  assert.equal(group.representative, before.representative)
  assert.equal(group.status, 'correct')
  assert.equal(group.shown, true)
  closeControlRoom(at.id)
})

test('the reply reaches the author; there is no broadcast to a group any more', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.masha, { t: 'council:submit', cellId: at.cell })

  assert.equal(
    say(at, at.teacher, {
      t: 'council:reply',
      cellId: at.cell,
      to: { participantId: at.petya.payload.participantId },
      text: 'Проверьте знак',
    }),
    null,
  )
  assert.equal(lastMine(at.petya, at.cell)?.reply?.text, 'Проверьте знак')
  assert.equal(lastMine(at.petya, at.cell)?.reply?.by, 'Ада')
  assert.equal(lastMine(at.masha, at.cell)?.reply, null, 'a reply to one person went to the neighbour')

  /*
   * The letter "to the whole group" was removed together with grouping
   * itself.
   *
   * It was addressed to the group key — the text after normalization — and
   * "look at the accumulator" came to five people, four of whom had not
   * written an accumulator: only the code without spaces and comments
   * matched. An old client that sends `{groupKey}` now gets silence: better
   * not to send than to send to the wrong people.
   */
  assert.equal(
    say(at, at.teacher, {
      t: 'council:reply',
      cellId: at.cell,
      to: { groupKey: 'x=1' },
      text: 'Всем: так и надо',
    }),
    null,
  )
  assert.equal(lastMine(at.masha, at.cell)?.reply, null, 'the group broadcast still gets through')
  assert.deepEqual(
    lastMine(at.petya, at.cell)?.replies?.map((one) => [one.to, one.text]),
    [['person', 'Проверьте знак']],
  )

  // A personal letter overwrites the personal one — an attempt never has a
  // second personal one.
  assert.equal(
    say(at, at.teacher, {
      t: 'council:reply',
      cellId: at.cell,
      to: { participantId: at.petya.payload.participantId },
      text: 'И ещё: назовите переменную',
    }),
    null,
  )
  assert.deepEqual(
    lastMine(at.petya, at.cell)?.replies?.map((one) => one.text),
    ['И ещё: назовите переменную'],
  )

  assert.equal(
    say(at, at.teacher, {
      t: 'council:mark',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
      correct: true,
    }),
    null,
  )
  assert.equal(lastMine(at.petya, at.cell)?.correct, true)
  assert.equal(
    board(at).attempts.find((a) => a.participantId === at.petya.payload.participantId)?.status,
    'correct',
  )
  closeControlRoom(at.id)
})

/* ------------------------------------------------------------------- run */

test('running: closed to students by default, the control opens it, the queue counts', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'print(1)' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'print(2)' })

  assert.match(
    say(at, at.petya, { t: 'council:run', cellId: at.cell }) ?? '',
    /преподавател/i,
    'a student ran with the control off',
  )
  assert.match(
    say(at, at.petya, {
      t: 'council:run',
      cellId: at.cell,
      participantId: at.masha.payload.participantId,
    }) ?? '',
    /преподавател/i,
    'a student ran someone else\'s attempt',
  )

  council(at, { studentRun: true })
  assert.equal(board(at).settings.studentRun, true)
  assert.equal(say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.equal(say(at, at.masha, { t: 'council:run', cellId: at.cell }), null)
  assert.equal(lastMine(at.petya, at.cell)?.run?.state, 'queued')
  assert.equal(lastMine(at.petya, at.cell)?.run?.by, 'author')
  assert.equal(lastMine(at.masha, at.cell)?.queue, 2, 'the second in the queue did not learn their number')
  assert.match(
    say(at, at.masha, { t: 'council:run', cellId: at.cell }) ?? '',
    /уже в очереди/i,
    'one attempt got into the queue twice',
  )
  // The output goes to the attempt, not into the shared cell: that one is at
  // rest.
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.equal(found!.cell.get('state') ?? 'idle', 'idle')
  closeControlRoom(at.id)
})

/* ------------------------------------------------------ ban and database */

test('a ban wipes the attempts, and the stack without them goes to the host', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'спам' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  assert.equal(board(at).counts.attempts, 2)

  assert.equal(purgeCouncilOf(at.id, at.petya.payload.participantId), 1)
  assert.deepEqual(
    attemptsOf(at.id, at.cell).map((a) => a.participantId),
    [at.masha.payload.participantId],
  )
  assert.deepEqual(
    board(at).attempts.map((a) => a.participantId),
    [at.masha.payload.participantId],
  )
  assert.deepEqual(lastCount(at.masha, at.cell), { submitted: 0, total: 1 })
  closeControlRoom(at.id)
})

test('changes travel as a delta, not as the whole stack; a ban goes into removed', () => {
  const at = room()
  council(at)
  const before = frames(at)
  assert.equal(before.full, 1, 'the lock is one full stack')
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 2' })
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 11' })
  const after = frames(at)
  assert.equal(after.full, before.full, 'the snapshot took the whole stack to the host')
  assert.ok(after.patch > 0, 'the snapshot did not go as a delta')
  const last = [...at.teacher.sock.heard]
    .reverse()
    .find((m) => m.t === 'council:patch' && m.cellId === at.cell)
  assert.ok(last && last.t === 'council:patch')
  assert.deepEqual(
    last.attempts.map((a) => a.participantId).sort(),
    [at.masha.payload.participantId, at.petya.payload.participantId].sort(),
    'the delta has only those touched within the window',
  )
  assert.equal(last.counts.attempts, 2)
  assert.deepEqual(
    board(at)
      .attempts.map((a) => a.text)
      .sort(),
    ['x = 11', 'x = 2'],
  )

  purgeCouncilOf(at.id, at.petya.payload.participantId)
  flushCouncilBoards(at.id)
  const gone = [...at.teacher.sock.heard]
    .reverse()
    .find((m) => m.t === 'council:patch' && m.cellId === at.cell)
  assert.ok(gone && gone.t === 'council:patch')
  assert.deepEqual(gone.removed, [at.petya.payload.participantId])
  assert.deepEqual(
    board(at).attempts.map((a) => a.text),
    ['x = 2'],
  )

  // Changing a control is shared: the whole stack again.
  council(at, { studentRun: true })
  assert.equal(frames(at).full, before.full + 1)
  closeControlRoom(at.id)
})

test('an oracle that was "reading" at the moment of a restart does not read forever after it', () => {
  const at = room()
  /*
   * The row is written WITHOUT `answers` and `pending` — exactly the way the
   * version before the class questions feed writes it. A seminar started
   * yesterday is read by today's server, and it must not crash on the
   * missing field (ai/council.ts · normalizeOracle).
   */
  const reading = {
    state: 'reading',
    askedAt: 5,
    basedOn: 3,
    summary: [],
    groupLabels: {},
    drafts: {},
    error: null,
  } as unknown as CouncilOracle
  setOracle(at.id, at.cell, reading)
  resetCouncilCache(at.id)
  const fresh = oracleOf(at.id, at.cell)
  assert.equal(fresh?.state, 'idle', 'a spinner until the end of the class, "Stop" stops nothing')
  assert.match(fresh?.error ?? '', /перезапустился/)
  assert.deepEqual(fresh?.answers, [])
  assert.equal(fresh?.pending, null)

  // There was a conversation — it comes back ready, with the reason next to
  // it: the feed survives a restart because it is about the conversation,
  // not about a request in progress.
  setOracle(at.id, at.cell, {
    ...reading,
    answers: [
      {
        id: 'a1',
        question: 'Кто застрял?',
        text: 'Никто.',
        askedAt: 1,
        basedOn: { submitted: 1, drafts: 0 },
        people: {},
      },
    ],
  })
  resetCouncilCache(at.id)
  const kept = oracleOf(at.id, at.cell)
  assert.equal(kept?.state, 'ready')
  assert.equal(kept?.answers.length, 1)
  assert.match(kept?.error ?? '', /перезапустился/)
  closeControlRoom(at.id)
})

test('attempts survive a restart: the cache is rebuilt from the database', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 7' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  const before = attemptsOf(at.id, at.cell)[0]

  resetCouncilCache(at.id)
  const after = attemptsOf(at.id, at.cell)
  assert.equal(after.length, 1)
  assert.equal(after[0].text, 'x = 7')
  assert.equal(after[0].submittedAt, before.submittedAt)

  // And to a new host connection the stack arrives in a batch — from the
  // database.
  const late = join(at.id, at.teacher.payload.participantId, 'Ада', 'host')
  assert.equal(lastBoard(late, at.cell)?.attempts[0]?.text, 'x = 7')
  closeControlRoom(at.id)
})

test('a letter survives a restart and travels in the stack', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, {
    t: 'council:reply',
    cellId: at.cell,
    to: { participantId: at.petya.payload.participantId },
    text: 'Проверьте знак',
  })

  // A restart without a process: the cache is forgotten, the truth is in the
  // database. The letters are one field there, and the list must go into it
  // whole, not as the last letter: there is no group broadcast any more, but
  // the oracle hint lands next to the personal one.
  resetCouncilCache(at.id)
  assert.deepEqual(
    attemptsOf(at.id, at.cell)[0]?.replies.map((one) => [one.to, one.text]),
    [['person', 'Проверьте знак']],
  )

  // And on the console, the card has the same letter (and the glued text for
  // an old client).
  const late = join(at.id, at.teacher.payload.participantId, 'Ада', 'host')
  const card = lastBoard(late, at.cell)?.attempts[0]
  assert.deepEqual(card?.replies?.map((one) => one.text), ['Проверьте знак'])
  assert.equal(card?.reply?.text, 'Проверьте знак')
  closeControlRoom(at.id)
})

/* ------------------------------------------------------ closing and the bell */

test('closing the council: a sheet with closed, the attempts stay, a snapshot is a refusal', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  assert.equal(say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'closed' }), null)
  assert.equal(lockOf(at), 'closed')

  assert.equal(lastMine(at.petya, at.cell)?.closed, true)
  assert.equal(lastMine(at.petya, at.cell)?.text, 'x = 1', 'the text disappeared for the author')
  assert.equal(attemptsOf(at.id, at.cell).length, 1, 'closing wiped the attempts')
  assert.equal(board(at).lock, 'closed')

  assert.match(
    say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 2' }) ?? '',
    /Консилиум закрыт/,
  )
  closeControlRoom(at.id)
})

test('after the bell attempts are not accepted and the lock is not set', () => {
  const at = room()
  council(at)
  setFinished(at.id, Date.now())
  assert.match(
    say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' }) ?? '',
    /Занятие закончено/,
  )
  assert.match(
    say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'closed' }) ?? '',
    /Занятие закончено/,
  )
  // But the teacher keeps viewing the stack — submissions are reviewed after
  // class.
  assert.equal(board(at).lock, 'council')
  closeControlRoom(at.id)
})

/* ----------------------------------------------------------------- task */

test('a latecomer is seeded with the task, not with a rewritten stub', () => {
  const at = room()
  // The very text that lies in the cell by the moment the council opens.
  const task = '# задание: посчитайте x'
  council(at)

  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, {
    t: 'council:show',
    cellId: at.cell,
    participantId: at.petya.payload.participantId,
  })
  /*
   * Showing no longer touches the shared text — but the teacher edits it:
   * they added to the problem statement in the middle of the council, and
   * from that second "what lies in the cell now" is no longer the task the
   * class is sitting with.
   */
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.ok(found)
  assert.equal(cellSource(found.cell).toString(), task, 'showing rewrote the shared text')
  getSessionDoc(at.id).doc.transact(() => {
    const source = cellSource(found.cell)
    source.insert(source.length, '\n# и y тоже')
  })

  /*
   * Klava comes in by the link after that. Her sheet used to be seeded with
   * the shared text — that is, with what is in the cell now. Now the welcome
   * batch carries the task captured on the lock switch.
   */
  const late = join(at.id, `${at.id}_late`, 'Клава', 'participant')
  const mine = lastMine(late, at.cell)
  assert.equal(mine?.text, '', 'she has no attempt yet')
  assert.equal(mine?.seed, task)

  // And to someone who already has an attempt: the sheet may have failed to
  // set up, and pages get reloaded in the middle of a class.
  assert.equal(lastMine(at.petya, at.cell)?.seed, task)
  closeControlRoom(at.id)
})

test('someone who comes in in the middle of a show gets the badge in the welcome batch', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, {
    t: 'council:show',
    cellId: at.cell,
    participantId: at.petya.payload.participantId,
  })

  // The "what is on screen" frame is not a change but a state: someone who
  // connected after the show would otherwise sit without the badge until the
  // next press.
  const late = join(at.id, `${at.id}_late2`, 'Клава', 'participant')
  assert.equal(lastShown(late, at.cell)?.text, 'x = 42')

  /*
   * And where nothing is shown, `null` arrives — and it is not a superfluous
   * frame. The room state lives in the client longer than the socket: a tab
   * that lost the connection before "clear the screen" would come back with
   * a badge that everyone else no longer has, and would keep it until the
   * teacher's next press.
   */
  say(at, at.teacher, { t: 'council:show:clear', cellId: at.cell })
  const later = join(at.id, `${at.id}_late3`, 'Нина', 'participant')
  assert.equal(lastShown(later, at.cell), null)
  closeControlRoom(at.id)
})


function requestRun(at: Room, who = at.petya) {
  say(at, who, {t:'council:run:request',cellId:at.cell})
  const request=lastMine(who,at.cell)?.runRequest
  assert.equal(request?.status,'pending')
  return request!
}
function draftForRequest(at: Room, text='print(123)') {
  council(at,{studentRun:'request'})
  say(at,at.petya,{t:'council:draft',cellId:at.cell,text})
}

test('run requests are private, idempotent and separate from submitting or executing',()=>{
 const at=room();draftForRequest(at)
 const otherFrames=at.masha.sock.heard.length
 const request=requestRun(at)
 assert.equal(board(at).settings.studentRun,'request')
 assert.equal(board(at).attempts[0].runRequest?.id,request.id)
 assert.equal(lastMine(at.petya,at.cell)?.run,null)
 assert.equal(lastMine(at.petya,at.cell)?.submittedAt,null)
 assert.equal(at.masha.sock.heard.length,otherFrames)
 assert.equal(requestRun(at).id,request.id)
 say(at,at.petya,{t:'council:run',cellId:at.cell})
 assert.equal(attemptsOf(at.id,at.cell)[0].run,null,'request mode must not grant direct execution')
})

test('only a teacher can approve the current request once and place it in the shared queue',()=>{
 const at=room();draftForRequest(at);const request=requestRun(at)
 const approve={t:'council:run:approve',cellId:at.cell,participantId:at.petya.payload.participantId,requestId:request.id} as const
 say(at,at.masha,approve)
 assert.equal(attemptsOf(at.id,at.cell)[0].run,null)
 assert.equal(say(at,at.teacher,approve),null)
 const attempt=attemptsOf(at.id,at.cell)[0]
 assert.ok(attempt.run)
 assert.equal(attempt.run.by,'host')
 assert.equal(attempt.runRequest,null)
 const started=attempt.run.startedAt
 assert.ok(say(at,at.teacher,approve))
 assert.equal(attemptsOf(at.id,at.cell)[0].run?.startedAt,started)
})

test('changed code invalidates approval and a new request cannot be approved with an old ID',()=>{
 const at=room();draftForRequest(at);const old=requestRun(at)
 say(at,at.petya,{t:'council:draft',cellId:at.cell,text:'print(456)'})
 assert.equal(lastMine(at.petya,at.cell)?.runRequest??null,null)
 const fresh=requestRun(at);assert.notEqual(fresh.id,old.id)
 assert.ok(say(at,at.teacher,{t:'council:run:approve',cellId:at.cell,participantId:at.petya.payload.participantId,requestId:old.id}))
 assert.equal(attemptsOf(at.id,at.cell)[0].run,null)
 assert.equal(attemptsOf(at.id,at.cell)[0].runRequest?.id,fresh.id)
})

test('teacher can decline; author can retry or cancel without submitting the attempt',()=>{
 const at=room();draftForRequest(at);const request=requestRun(at)
 say(at,at.teacher,{t:'council:run:decline',cellId:at.cell,participantId:at.petya.payload.participantId,requestId:request.id})
 assert.equal(lastMine(at.petya,at.cell)?.runRequest?.status,'declined')
 const fresh=requestRun(at);assert.notEqual(fresh.id,request.id)
 say(at,at.masha,{t:'council:run:cancel',cellId:at.cell,requestId:fresh.id})
 assert.equal(attemptsOf(at.id,at.cell)[0].runRequest?.id,fresh.id)
 say(at,at.petya,{t:'council:run:cancel',cellId:at.cell,requestId:fresh.id})
 assert.equal(lastMine(at.petya,at.cell)?.runRequest??null,null)
 assert.equal(lastMine(at.petya,at.cell)?.submittedAt,null)
})

test('changing execution policy or closing Council discards pending approvals',()=>{
 const at=room();draftForRequest(at);let request=requestRun(at)
 council(at,{studentRun:true})
 assert.equal(lastMine(at.petya,at.cell)?.runRequest??null,null)
 assert.ok(say(at,at.teacher,{t:'council:run:approve',cellId:at.cell,participantId:at.petya.payload.participantId,requestId:request.id}))
 council(at,{studentRun:'request'});request=requestRun(at)
 say(at,at.teacher,{t:'cell:lock',cellId:at.cell,state:'closed'})
 assert.equal(lastMine(at.petya,at.cell)?.runRequest??null,null)
 assert.ok(say(at,at.teacher,{t:'council:run:approve',cellId:at.cell,participantId:at.petya.payload.participantId,requestId:request.id}))
})

test('ending a class clears requests; resuming does not revive them',()=>{
 const at=room();draftForRequest(at);const request=requestRun(at)
 say(at,at.teacher,{t:'class:finish'})
 assert.equal(attemptsOf(at.id,at.cell)[0].runRequest,null)
 say(at,at.teacher,{t:'class:resume'})
 assert.ok(say(at,at.teacher,{t:'council:run:approve',cellId:at.cell,participantId:at.petya.payload.participantId,requestId:request.id}))
 assert.equal(attemptsOf(at.id,at.cell)[0].run,null)
})


test('class finish and request revocation commit together when storage fails',()=>{
 const at=room();draftForRequest(at);const request=requestRun(at)
 const before=at.petya.sock.heard.length
 db.exec(`CREATE TEMP TRIGGER refuse_request_clear BEFORE UPDATE OF run_request_json ON council_attempts
   WHEN OLD.session_id='${at.id}' AND NEW.run_request_json IS NULL
   BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`)
 try{
  assert.throws(()=>say(at,at.teacher,{t:'class:finish'}),/test storage failure/)
  assert.equal(finishedAt(at.id),null,'class closure must roll back along with failed request revocation')
  assert.equal(attemptsOf(at.id,at.cell)[0].runRequest?.id,request.id,'cache must match rolled-back data')
  assert.equal(at.petya.sock.heard.length,before,'no premature state broadcast')
 }finally{db.exec('DROP TRIGGER refuse_request_clear')}
})

/**
 * The oracle-on-the-class feed is the most private thing in the room.
 *
 * In the model's answer people are named by labels `S1…SN`, and next to it
 * travels a "label → participantId" dictionary: this is a tagging of other
 * people's work collected across the whole class, and its place is in
 * exactly one frame — the one that goes to the teacher's console. The stack
 * frame (`council:board`) and the oracle frame (`council:oracle`) both go
 * via `toTeachers`, but one wrong `broadcast` here would turn "who is stuck"
 * into an announcement to the whole audience, and no type would notice.
 */
test('the oracle feed with people\'s labels goes only to consoles — the class does not have it', async () => {
  const { askCouncilOracle } = await import('../server/src/ai/council.js')
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })

  const secret = 'S1 застрял на цикле, к нему стоит подойти.'
  const mark = at.petya.payload.participantId
  setOracle(at.id, at.cell, {
    state: 'ready',
    askedAt: 1,
    basedOn: 1,
    error: null,
    pending: null,
    answers: [
      {
        id: 'a1',
        question: 'Кто застрял?',
        text: secret,
        askedAt: 2,
        basedOn: { submitted: 1, drafts: 0 },
        people: { S1: mark },
      },
    ],
  })

  /*
   * The real path: "reading" is announced at once and carries the previous
   * feed with it. There is no gateway in tests, so a refusal arrives next —
   * and it also shows that the feed survives an error (ai/council.ts ·
   * giveBack).
   */
  askCouncilOracle({
    sessionId: at.id,
    cellId: at.cell,
    task: { source: '# задание', before: null, reference: null },
    attempts: attemptsOf(at.id, at.cell).map((a) => ({
      participantId: a.participantId,
      text: a.text,
      submittedAt: a.submittedAt,
      updatedAt: a.updatedAt,
      run: a.run,
      correct: a.correct,
    })),
    store: { oracleOf, setOracle },
    question: 'Кто застрял?',
  })
  await new Promise((done) => setTimeout(done, 200))

  const toHost = at.teacher.sock.heard.filter((m) => m.t === 'council:oracle')
  assert.ok(toHost.length >= 1, 'the console did not learn that the oracle is reading')
  assert.ok(JSON.stringify(toHost).includes(secret), 'the feed did not reach the console')
  /*
   * A refusal does not wipe the conversation and does not eat the question:
   * the previous turn stays, and the failed one stands next to it — with its
   * question and the reason instead of an answer. Before this, a "Refresh"
   * that ended in nothing took the question away too: there was nothing to
   * repeat.
   */
  const feed = oracleOf(at.id, at.cell)?.answers ?? []
  assert.equal(feed.length, 2, 'the refusal wiped the conversation')
  assert.equal(feed[0].text, secret)
  assert.equal(feed[1].question, 'Кто застрял?')
  assert.ok((feed[1].failed ?? '').length > 0, 'the failed turn has no reason')

  // A late console gets the feed in the welcome batch, the class — never.
  const late = join(at.id, at.teacher.payload.participantId, 'Ада', 'host')
  assert.equal(lastBoard(late, at.cell)?.oracle?.answers[0]?.text, secret)
  const student = join(at.id, `${at.id}_late`, 'Гриша', 'participant')
  for (const who of [at.petya, at.masha, student]) {
    const heard = JSON.stringify(who.sock.heard)
    assert.ok(!heard.includes(secret), 'the oracle\'s answer went to the class')
    assert.ok(!heard.includes('"S1"'), 'the label dictionary went to the class')
    assert.ok(!heard.includes('Кто застрял?'), 'the teacher\'s question went to the class')
  }
  closeControlRoom(at.id)
})
