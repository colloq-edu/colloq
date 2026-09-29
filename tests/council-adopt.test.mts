/**
 * "Put in the cell": the shown attempt becomes the cell's text — and can be
 * taken back.
 *
 * Showing deliberately leaves the shared cell alone (council-seed-server
 * checks that), so teachers copied the shown code in by hand: an attempt runs
 * sandboxed and its variables vanish, while the class goes on from the cell.
 * One press now does the copy, and what is checked here is what makes such a
 * press trustworthy: the text comes from the council store and never from the
 * frame, the edit in the history is the teacher's, the run is the cell's
 * ordinary run, only the host presses it and only on what is on screen, and
 * the undo never erases anything but the adoption itself.
 *
 * No network, no kernel: the sockets are fake, the room is real, the
 * dispatcher is the same one that listens to the wire. The client's half —
 * the success line and the "4" key — is at the end.
 */
import './_env.mts'
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, listVersions, setRules, upsertParticipant } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { flushHistory } from '../server/src/collab/history.js'
import { listActivity } from '../server/src/activity.js'
import { cellId, cellSource, createCell, findCell, getCells } from '../shared/notebook.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import { tr } from '../shared/i18n.js'
import {
  ADOPT_UNDO_MS,
  type ControlClientMessage,
  type ControlServerMessage,
  type CouncilShown,
} from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Person {
  payload: TokenPayload
  ws: WebSocket
  heard: ControlServerMessage[]
}

function join(sessionId: string, who: string, name: string, role: 'host' | 'participant'): Person {
  upsertParticipant({ id: who, sessionId, name, avatar: null, role })
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      // Frames built once per room go out already encoded (control.ts ·
      // sendFrame): a string or bytes, the same to a real socket.
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
  const ws = fake as unknown as WebSocket
  const payload: TokenPayload = { sessionId, participantId: who, role }
  handleControlSocket(ws, sessionId, payload)
  return { payload, ws, heard }
}

const TASK = '# задание: посчитайте среднее\nmean = ...'
const PETYA = 'mean = sum(xs) / len(xs)'
const MASHA = 'import statistics\nmean = statistics.mean(xs)'

interface Room {
  id: string
  cell: string
  teacher: Person
  petya: Person
  masha: Person
}

let rooms = 0

function room(): Room {
  const id = `adopt-${++rooms}`
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const made = createCell('code', TASK)
  doc.transact(() => getCells(doc).push([made]))
  const at: Room = {
    id,
    cell: cellId(made),
    teacher: join(id, `${id}_teacher`, 'Ада', 'host'),
    petya: join(id, `${id}_petya`, 'Петя', 'participant'),
    masha: join(id, `${id}_masha`, 'Маша', 'participant'),
  }
  say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' })
  return at
}

/** What this person heard in answer to this message. */
function say(at: Room, who: Person, message: ControlClientMessage): ControlServerMessage[] {
  const before = who.heard.length
  dispatch(who.ws, at.id, who.payload, message)
  return who.heard.slice(before)
}

const id = (who: Person): string => who.payload.participantId

/** The author writes and submits, the teacher puts it on screen. */
function show(at: Room, author: Person, text: string): void {
  say(at, author, { t: 'council:draft', cellId: at.cell, text })
  say(at, author, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: id(author) })
}

function adopt(at: Room, who: Person, author: Person, run: boolean): ControlServerMessage[] {
  return say(at, who, { t: 'council:adopt', cellId: at.cell, participantId: id(author), run })
}

function undo(at: Room, who: Person = at.teacher): ControlServerMessage[] {
  return say(at, who, { t: 'council:adopt:undo', cellId: at.cell })
}

function cellOf(at: Room) {
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.ok(found, 'the cell left the notebook')
  return found.cell
}

const textOf = (at: Room): string => cellSource(cellOf(at)).toString()
const stateOf = (at: Room): unknown => cellOf(at).get('state')

function refusal(heard: ControlServerMessage[]): string | null {
  const frame = heard.find((m) => m.t === 'council:adopt:refused')
  return frame && frame.t === 'council:adopt:refused' ? frame.message : null
}

/** The newest version in the timeline — with its author. */
function newestEdit(at: Room) {
  flushHistory(at.id)
  return listVersions(at.id, 10).find((row) => row.kind === 'edit') ?? null
}

function lastShown(who: Person, cell: string): CouncilShown | null | undefined {
  for (let i = who.heard.length - 1; i >= 0; i--) {
    const m = who.heard[i]
    if (m.t === 'council:shown' && m.cellId === cell) return m.shown
  }
  return undefined
}

/* ---------------------------------------------------------------- adopt */

test('the shown attempt goes into the cell from the store — not from the frame — signed by the teacher', () => {
  const at = room()
  show(at, at.petya, PETYA)
  flushHistory(at.id)
  const heard = say(at, at.teacher, {
    t: 'council:adopt',
    cellId: at.cell,
    participantId: id(at.petya),
    run: false,
    // A forged field: the server must not read it.
    text: 'import shutil; shutil.rmtree("/")',
  } as unknown as ControlClientMessage)

  assert.equal(textOf(at), PETYA, 'the cell holds something other than the stored attempt')
  const ack = heard.find((m) => m.t === 'council:adopted')
  assert.ok(ack && ack.t === 'council:adopted', 'no acknowledgement for the one who pressed')
  assert.equal(ack.cellId, at.cell)
  assert.equal(ack.participantId, id(at.petya))
  assert.equal(ack.run, false)
  assert.equal(ack.undoable, true)
  assert.equal(typeof ack.at, 'number')
  // Only the one who pressed hears about it: the room reads the document.
  assert.equal(at.masha.heard.some((m) => m.t === 'council:adopted'), false)

  const edit = newestEdit(at)
  assert.ok(edit, 'the adoption is not in the version history')
  assert.equal(edit.author_id, id(at.teacher), 'the version belongs to nobody: "the room"')

  // The showing stays as it was, and nothing was queued.
  assert.equal(heard.some((m) => m.t === 'council:shown'), false)
  assert.equal(lastShown(at.masha, at.cell)?.participantId, id(at.petya))
  assert.notEqual(stateOf(at), 'queued')

  const event = listActivity(at.id, { level: 'important', category: 'council' }).events.find(
    (one) => one.kind === 'council.adopted',
  )
  assert.equal(event?.actor?.id, id(at.teacher))
  assert.equal(event?.details.subjectId, id(at.petya))
  assert.equal(event?.details.cellId, at.cell)
  closeControlRoom(at.id)
})

test('"…and run" queues the cell itself, like any run of the teacher', () => {
  const at = room()
  show(at, at.petya, PETYA)
  const heard = adopt(at, at.teacher, at.petya, true)
  assert.equal(heard.some((m) => m.t === 'error'), false)
  assert.equal(textOf(at), PETYA)
  assert.equal(stateOf(at), 'queued', 'the cell was not queued')
  assert.equal(cellOf(at).get('runById'), id(at.teacher))
  const ack = heard.find((m) => m.t === 'council:adopted')
  assert.equal(ack?.t === 'council:adopted' && ack.run, true)
  closeControlRoom(at.id)
})

test('a student cannot put anything into the cell, nor take it back out', () => {
  const at = room()
  show(at, at.petya, PETYA)
  const heard = adopt(at, at.masha, at.petya, true)
  assert.ok(heard.some((m) => m.t === 'error'), 'the refusal was silent')
  assert.equal(heard.some((m) => m.t === 'council:adopted'), false)
  assert.equal(textOf(at), TASK)
  assert.notEqual(stateOf(at), 'queued')

  adopt(at, at.teacher, at.petya, false)
  assert.ok(undo(at, at.petya).some((m) => m.t === 'error'))
  assert.equal(textOf(at), PETYA, 'a student took the adoption back')
  closeControlRoom(at.id)
})

test('only the attempt on screen goes in — not another one from the pile, not a cleared one', () => {
  const at = room()
  show(at, at.petya, PETYA)
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: MASHA })
  say(at, at.masha, { t: 'council:submit', cellId: at.cell })

  assert.equal(refusal(adopt(at, at.teacher, at.masha, true)), tr('server.council.adoptNotShown'))
  assert.equal(textOf(at), TASK)
  assert.notEqual(stateOf(at), 'queued')

  say(at, at.teacher, { t: 'council:show:clear', cellId: at.cell })
  assert.equal(refusal(adopt(at, at.teacher, at.petya, false)), tr('server.council.adoptNotShown'))

  const nobody = say(at, at.teacher, {
    t: 'council:adopt',
    cellId: at.cell,
    participantId: `${at.id}_nobody`,
    run: false,
  })
  assert.equal(refusal(nobody), tr('server.thisAttemptNoLongerExists.b490bf'))
  assert.equal(textOf(at), TASK)
  closeControlRoom(at.id)
})

/* ----------------------------------------------------------------- undo */

test('the undo puts back what the cell held before, in the teacher\'s name, once', () => {
  const at = room()
  show(at, at.petya, PETYA)
  adopt(at, at.teacher, at.petya, false)
  const adopted = newestEdit(at)?.seq ?? 0

  const heard = undo(at)
  assert.ok(heard.some((m) => m.t === 'council:adopt:undone' && m.cellId === at.cell))
  assert.equal(textOf(at), TASK)
  const restored = newestEdit(at)
  assert.ok(restored && restored.seq > adopted, 'the undo left no version of its own')
  assert.equal(restored.author_id, id(at.teacher))

  // The memory is gone with the success: a second undo has nothing to restore.
  assert.equal(
    refusal(undo(at)),
    tr('server.council.adoptTooLate', { p0: Math.round(ADOPT_UNDO_MS / 60_000) }),
  )
  assert.equal(textOf(at), TASK)
  closeControlRoom(at.id)
})

test('the undo is refused once the cell was edited after the adoption', () => {
  const at = room()
  show(at, at.petya, PETYA)
  adopt(at, at.teacher, at.petya, false)
  const { doc } = getSessionDoc(at.id)
  doc.transact(() => {
    const source = cellSource(cellOf(at))
    source.insert(source.length, '\nprint(mean)')
  })

  assert.equal(refusal(undo(at)), tr('server.council.adoptChanged'))
  assert.equal(textOf(at), `${PETYA}\nprint(mean)`, 'the undo erased an edit made after it')
  closeControlRoom(at.id)
})

test('the undo is refused after the window', () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    const at = room()
    show(at, at.petya, PETYA)
    adopt(at, at.teacher, at.petya, false)
    mock.timers.tick(ADOPT_UNDO_MS + 1)
    assert.equal(
      refusal(undo(at)),
      tr('server.council.adoptTooLate', { p0: Math.round(ADOPT_UNDO_MS / 60_000) }),
    )
    assert.equal(textOf(at), PETYA)
    closeControlRoom(at.id)
  } finally {
    mock.timers.reset()
  }
})

test('a second press on the same code keeps the first "before", and a waiting run leaves with the undo', () => {
  const at = room()
  show(at, at.petya, PETYA)
  adopt(at, at.teacher, at.petya, false)
  adopt(at, at.teacher, at.petya, true)
  assert.equal(stateOf(at), 'queued')
  // No second event for a press that changed no text.
  const events = listActivity(at.id, { level: 'important', category: 'council' }).events
  assert.equal(events.filter((one) => one.kind === 'council.adopted').length, 1)

  undo(at)
  assert.equal(textOf(at), TASK, 'the undo put back the adopted code itself')
  assert.equal(stateOf(at), 'idle', 'the run queued for the adopted code stayed in the queue')
  closeControlRoom(at.id)
})

test('adopting another attempt over the first: the undo returns the first', () => {
  const at = room()
  show(at, at.petya, PETYA)
  adopt(at, at.teacher, at.petya, false)
  show(at, at.masha, MASHA)
  adopt(at, at.teacher, at.masha, false)
  assert.equal(textOf(at), MASHA)
  undo(at)
  assert.equal(textOf(at), PETYA)
  closeControlRoom(at.id)
})

/* --------------------------------------------------------------- client */

const shim = <T,>(value: T): T => value
shim.raw = <T,>(value: T): T => value
;(globalThis as { $state?: unknown }).$state ??= shim

function shownOf(participantId: string): CouncilShown {
  return {
    participantId,
    variant: 1,
    name: 'Петя',
    color: '#123456',
    avatar: null,
    shownBy: 'Ада',
    shownAt: 1_700_000_000_000,
    text: PETYA,
    run: null,
    alsoWrote: 0,
    correct: null,
  }
}

test('the client sends no text and keeps the success line exactly as long as the undo can work', async () => {
  const { CouncilState } = await import('../web/src/lib/council.svelte.js')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const wire: unknown[] = []
    const council = new CouncilState((message) => wire.push(message))
    council.adopt('c1', 'p_2', true)
    council.undoAdopt('c1')
    assert.deepEqual(wire, [
      { t: 'council:adopt', cellId: 'c1', participantId: 'p_2', run: true },
      { t: 'council:adopt:undo', cellId: 'c1' },
    ])

    council.receive({ t: 'council:shown', cellId: 'c1', shown: shownOf('p_2') })
    council.receive({ t: 'council:adopted', cellId: 'c1', participantId: 'p_2', run: true, at: 1, undoable: true })
    assert.deepEqual(council.adopted.c1, { participantId: 'p_2', run: true, at: 1 })
    // The same attempt sent again (a fresh caption) keeps the line…
    council.receive({ t: 'council:shown', cellId: 'c1', shown: shownOf('p_2') })
    assert.ok(council.adopted.c1)
    // …another one on screen takes it away.
    council.receive({ t: 'council:shown', cellId: 'c1', shown: shownOf('p_3') })
    assert.equal(council.adopted.c1, undefined)

    council.receive({ t: 'council:adopted', cellId: 'c1', participantId: 'p_3', run: false, at: 2, undoable: true })
    mock.timers.tick(ADOPT_UNDO_MS - 1)
    assert.ok(council.adopted.c1, 'the line left before the window did')
    mock.timers.tick(1)
    assert.equal(council.adopted.c1, undefined, 'the line outlived the server\'s window')

    council.receive({ t: 'council:adopted', cellId: 'c1', participantId: 'p_3', run: false, at: 3, undoable: true })
    council.receive({ t: 'council:adopt:refused', cellId: 'c1', message: 'поздно' })
    assert.equal(council.adopted.c1, undefined)
    assert.equal(council.adoptErrors.c1, 'поздно')
    council.adopt('c1', 'p_3', false)
    assert.equal(council.adoptErrors.c1, undefined, 'the next press kept the old refusal')

    council.receive({ t: 'council:adopt:undone', cellId: 'c1' })
    assert.equal(council.adopted.c1, undefined)
    council.destroy()
  } finally {
    mock.timers.reset()
  }
})

test('"4" in the console puts what is on screen into the cell and runs it — only where keys are the console\'s', async () => {
  const { pultKeyAction, pultShortcutAllowed } = await import('../web/src/lib/council-pult.js')
  assert.equal(pultKeyAction({ key: '4' }, 'list'), 'adoptRun')
  assert.equal(pultKeyAction({ key: '4' }, 'actions'), 'adoptRun')
  assert.equal(pultKeyAction({ key: '4' }, 'reply'), null, 'a digit in a letter stays a digit')
  assert.equal(pultKeyAction({ key: '4' }, 'search'), null)
  assert.equal(pultKeyAction({ key: '4', meta: true }, 'list'), null)
  assert.equal(pultShortcutAllowed('adoptRun', 'work', false), true)
  assert.equal(pultShortcutAllowed('adoptRun', 'queue', false), false)
})
