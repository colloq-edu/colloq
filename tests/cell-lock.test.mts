import { tr } from '../shared/i18n.js'
/**
 * The lock on a cell: a lecture in which individual cells are open.
 *
 * A lecture notebook is closed as a whole, and its only door is a cell the
 * teacher opened personally. The door is narrow by design: typing goes
 * through it and nothing else. A mistake here is visible neither on screen nor
 * in the log — it either locks the class out in a room where it was just
 * allowed to type, or hands it the whole notebook one open cell at a time.
 *
 * The frames are real: two documents and the bytes between them, as in
 * crdt-gate. The lock is set by a server transaction, because only the server
 * sets it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { classify, permits } from '../server/src/collab/gate.js'
import {
  CELLS_KEY,
  META_KEY,
  cellLock,
  cloneCell,
  councilSettingsOf,
  DEFAULT_COUNCIL,
  createCell,
  findCell,
  isCellCouncil,
  isCellOpen,
  normalizeAttempt,
  openValueFor,
  readCell,
} from '../shared/notebook.js'
import { settleFresh } from '../server/src/collab/ops.js'
import {
  CLASS_IS_OVER,
  LECTURE_ROOM,
  OPEN_ROOM,
  rulesAfterClass,
  type RoomRules,
} from '../shared/rules.js'

function pair(): { server: Y.Doc; client: Y.Doc; frame: (write: () => void) => Uint8Array } {
  const server = new Y.Doc()
  const client = new Y.Doc()
  server.transact(() => {
    server.getMap(META_KEY).set('title', 'Лекция')
    server
      .getArray(CELLS_KEY)
      .push([createCell('code', 'print(1)', 'c1'), createCell('code', 'print(2)', 'c2')])
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
    assert.ok(captured, 'the transaction produced no update')
    return captured
  }
  return { server, client, frame }
}

function cellAt(doc: Y.Doc, i: number): Y.Map<any> {
  return doc.getArray(CELLS_KEY).get(i) as Y.Map<any>
}

/** The teacher opened a cell. The server writes it, otherwise it is no lock. */
function unlock(server: Y.Doc, client: Y.Doc, i: number): void {
  server.transact(() => cellAt(server, i).set('open', true), 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
}

/** The teacher opened a council: a sheet each, the shared text closed. */
function council(server: Y.Doc, client: Y.Doc, i: number): void {
  server.transact(() => {
    cellAt(server, i).set('open', 'council')
    cellAt(server, i).set('council', { studentRun: true })
  }, 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
}

/** Would this frame pass in this room from this person; `null` means yes. */
function passes(
  server: Y.Doc,
  bytes: Uint8Array,
  rules: RoomRules,
  role: 'host' | 'participant',
  finished = false,
): string | null {
  const judged = classify(server, bytes)
  if (!judged.ok) return judged.why
  const verdict = permits(judged.verdicts, rules, role, finished)
  return verdict.ok ? null : verdict.message
}

const typing = (client: Y.Doc, i: number): void => {
  ;(cellAt(client, i).get('source') as Y.Text).insert(0, 'ы')
}

/* ------------------------------------------------------------------- model */

test('no lock means the cell is closed; and `false` is closed too', () => {
  // Every cell the teacher has not touched has no key, and so does every
  // notebook written before lectures existed. It is one and the same case,
  // and it is closed.
  const { server } = pair()
  const cell = cellAt(server, 0)
  assert.equal(isCellOpen(cell), false)
  cell.set('open', false)
  assert.equal(isCellOpen(cell), false)
  cell.set('open', true)
  assert.equal(isCellOpen(cell), true)
  assert.equal(readCell(cell).open, true, 'the cell snapshot does not tell about the lock')
})

test('moving a neighbour does not slam an open cell shut', () => {
  /*
   * `moveInCells` recreates the neighbour as a clone, and whatever the clone
   * forgot is lost for it. A forgotten lock is a cell that closed under the
   * hands of a typing room because someone moved the neighbouring row.
   */
  const { server } = pair()
  server.transact(() => {
    cellAt(server, 0).set('open', true)
    // The clone is read once it is in the document: on a Y.Map not yet
    // inserted, `get` returns nothing.
    const cells = server.getArray(CELLS_KEY)
    cells.push([cloneCell(cellAt(server, 0)), cloneCell(cellAt(server, 1))])
  }, 'server')
  assert.equal(isCellOpen(cellAt(server, 2)), true)
  // But for a closed one the clone creates no key: an empty key on every move
  // is a document transaction and a disk write for nothing.
  assert.equal(cellAt(server, 3).get('open') ?? null, null)
})

test('a council is the third position of the same key, and it is closed for typing', () => {
  /*
   * One field for three positions: two fields would have to agree on which
   * one wins when both are set. And `isCellOpen` answers strictly to `true` —
   * otherwise a council would open the shared text to the very five hundred
   * people it was created for.
   */
  const { server } = pair()
  const cell = cellAt(server, 0)
  assert.equal(cellLock(cell), 'closed')
  cell.set('open', 'council')
  assert.equal(isCellOpen(cell), false, 'the council opened the shared text')
  assert.equal(isCellCouncil(cell), true)
  assert.equal(cellLock(cell), 'council')
  // Knobs with a default per field: with no key, student runs are off, names
  // on the projector are on, the rules at their defaults. The comparison is
  // against the whole `DEFAULT_COUNCIL`, not a list: a knob added tomorrow
  // must arrive with its default rather than break this line.
  assert.deepEqual(councilSettingsOf(cell), DEFAULT_COUNCIL)
  cell.set('council', { studentRun: true })
  assert.deepEqual(councilSettingsOf(cell), { ...DEFAULT_COUNCIL, studentRun: true })
  const snap = readCell(cell)
  assert.equal(snap.open, false, 'the snapshot said "typing allowed"')
  assert.equal(snap.lock, 'council')
  assert.deepEqual(snap.council, { ...DEFAULT_COUNCIL, studentRun: true })
  // Outside a council there are no knobs, whatever garbage is left in the key.
  cell.set('open', true)
  assert.equal(cellLock(cell), 'open')
  assert.equal(councilSettingsOf(cell), null)
  // And there and back through the position name, which is what control.ts
  // writes.
  assert.equal(openValueFor('council'), 'council')
  assert.equal(openValueFor('open'), true)
  assert.equal(openValueFor('closed'), null)
})

test('moving a neighbour does not lose the council and its knobs', () => {
  const { server } = pair()
  server.transact(() => {
    cellAt(server, 0).set('open', 'council')
    cellAt(server, 0).set('council', { studentRun: true, namesOnProjector: false })
    server.getArray(CELLS_KEY).push([cloneCell(cellAt(server, 0))])
  }, 'server')
  assert.equal(cellLock(cellAt(server, 2)), 'council')
  assert.deepEqual(councilSettingsOf(cellAt(server, 2)), {
    ...DEFAULT_COUNCIL,
    studentRun: true,
    namesOnProjector: false,
  })
})

test('the group key: one solution written in different ways', () => {
  // Spaces, blank lines and comments are not the solution; quotes are.
  assert.equal(normalizeAttempt('x = 1  # ответ\n\nprint( x )\n'), 'x=1\nprint(x)')
  assert.equal(normalizeAttempt('x=1\nprint(x)'), normalizeAttempt('x = 1\n# всё\nprint (x)'))
  assert.notEqual(normalizeAttempt('print("# нет")'), normalizeAttempt('print("")'))
  assert.equal(normalizeAttempt('   \n# только комментарий\n'), '')
})

/* -------------------------------------------------------------------- gate */

test('typing in an open cell is an edit whose lock is off', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const judged = classify(
    server,
    frame(() => typing(client, 0)),
  )
  assert.equal(judged.ok, true)
  if (!judged.ok) return
  assert.deepEqual(
    judged.verdicts.map((v) => `${v.rule}:${v.open === true}`),
    ['edit:true'],
  )
})

test('typing in a closed cell is an edit without the lock, as it always was', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const judged = classify(
    server,
    frame(() => typing(client, 1)),
  )
  assert.equal(judged.ok, true)
  if (!judged.ok) return
  assert.deepEqual(
    judged.verdicts.map((v) => `${v.rule}:${v.open === true}`),
    ['edit:false'],
    "the neighbouring cell's lock went to this one",
  )
})

test('a cell cannot be opened by a frame, neither by a participant nor by the teacher', () => {
  /*
   * This is a right, not a readout: a cell that opened itself is a participant
   * who allowed themselves to type in a closed notebook. The teacher gets the
   * same refusal, and that is not strictness: the teacher opens cells with a
   * control message, where the role is asked, not with a frame, where the role
   * plays no part.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('open', true))
  assert.match(passes(server, bytes, LECTURE_ROOM, 'participant') ?? '', /ячейку открывает/)
  assert.match(passes(server, bytes, OPEN_ROOM, 'host') ?? '', /ячейку открывает/)
})

test('a council cannot be opened by a frame, nor its knobs turned', () => {
  // "Runs for students" is a right, not a readout: a cell that switched it on
  // for itself is a class that allowed itself a queue to the kernel.
  const first = pair()
  const lock = first.frame(() => cellAt(first.client, 0).set('open', 'council'))
  assert.match(passes(first.server, lock, LECTURE_ROOM, 'participant') ?? '', /ячейку открывает/)
  // The server never saw the rejected frame, and the next one would continue
  // keystrokes the server does not have — hence a second pair of documents.
  const second = pair()
  const knob = second.frame(() => cellAt(second.client, 1).set('council', { studentRun: true }))
  assert.match(passes(second.server, knob, OPEN_ROOM, 'host') ?? '', /ячейку открывает/)
})

test('in a council the shared text is closed, as in a closed cell', () => {
  /*
   * This is rule number one: everyone has their own sheet. An attempt travels
   * as a snapshot over the control socket, and a participant's frame into the
   * shared Y.Text gets the same refusal phrase as for a closed cell: to the
   * gate a council is no different from it.
   */
  const { server, client, frame } = pair()
  council(server, client, 0)
  const bytes = frame(() => typing(client, 0))
  const judged = classify(server, bytes)
  assert.ok(judged.ok)
  assert.deepEqual(
    judged.verdicts.map((v) => `${v.rule}:${v.open === true}`),
    ['edit:false'],
  )
  assert.match(passes(server, bytes, LECTURE_ROOM, 'participant') ?? '', /преподавател/i)
  // The teacher types into the shared text: "Show to class" is the teacher's
  // edit.
  assert.equal(passes(server, bytes, LECTURE_ROOM, 'host'), null)
})

test('a cell brought in with a council arrives closed and without knobs', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const made = createCell('code', 'моё', 'c8')
    made.set('open', 'council')
    made.set('council', { studentRun: true })
    client.getArray(CELLS_KEY).push([made])
  })
  assert.equal(passes(server, bytes, OPEN_ROOM, 'participant'), null, 'the frame was not accepted')
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh('lock-room', server, ['c8']), 'server')
  const landed = findCell(server, 'c8')
  assert.ok(landed, 'the cell did not arrive')
  assert.equal(cellLock(landed.cell), 'closed', 'the council survived settling to clean')
  assert.equal(landed.cell.get('council') ?? null, null, 'the knobs survived settling to clean')
})

test('removing the lock by a frame is not allowed either', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => cellAt(client, 0).set('open', false))
  assert.match(
    passes(server, bytes, LECTURE_ROOM, 'participant') ?? '',
    /ячейку открывает/,
    'the lock was removed from the browser',
  )
})

test('a cell brought in with a lock arrives closed', () => {
  /*
   * "Adding is allowed" must not read as "typing is allowed everywhere": it
   * would be enough to bring a cell already opened for itself. But refusing is
   * not an option either — the same kind of frame carries the teacher's Ctrl+Z
   * undoing the deletion of an open cell, and the teacher would get a tab
   * reload for their own move. So the frame is accepted, and the server
   * removes the lock.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const made = createCell('code', 'моё', 'c9')
    made.set('open', true)
    client.getArray(CELLS_KEY).push([made])
  })
  assert.equal(passes(server, bytes, OPEN_ROOM, 'participant'), null, 'the frame was not accepted')
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh('lock-room', server, ['c9']), 'server')
  const landed = findCell(server, 'c9')
  assert.ok(landed, 'the cell did not arrive')
  assert.equal(isCellOpen(landed.cell), false, 'the lock survived settling to clean')
})

/* ------------------------------------------------------- what the door gives */

test('in a lecture the room types in an open cell and stays silent in a closed one', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)

  const inside = frame(() => typing(client, 0))
  assert.equal(passes(server, inside, LECTURE_ROOM, 'participant'), null, 'the door did not open')
  Y.applyUpdate(server, inside)

  const outside = frame(() => typing(client, 1))
  assert.match(
    passes(server, outside, LECTURE_ROOM, 'participant') ?? '',
    /преподавател/i,
    'an open cell opened the whole notebook',
  )
})

test('in an open cell erasing works the same as typing', () => {
  /*
   * Backspace is a deletion, and the gate judges deletions by a different path
   * than insertions: through the delete set, bottom up to the outermost
   * deleted ancestor. The lock must be found there too, otherwise an open cell
   * accepts typing and rejects backspace — that is, it breaks on the very
   * first typo.
   */
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => (cellAt(client, 0).get('source') as Y.Text).delete(0, 3))
  assert.equal(passes(server, bytes, LECTURE_ROOM, 'participant'), null, 'erasing their own text was not allowed')
})

test('an open cell cannot be removed', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => client.getArray(CELLS_KEY).delete(0, 1))
  assert.match(passes(server, bytes, LECTURE_ROOM, 'participant') ?? '', /убирает/)
})

test('an open cell cannot be moved', () => {
  // A move in the browser is a deletion plus an inserted copy, that is, the
  // makeup of the notebook. Otherwise "moving into nowhere" would be a way to
  // remove a cell that must not be removed.
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => {
    const cells = client.getArray(CELLS_KEY)
    cells.delete(0, 1)
    cells.insert(1, [createCell('code', 'print(1)', 'c1')])
  })
  assert.match(
    passes(server, bytes, LECTURE_ROOM, 'participant') ?? '',
    /добавляет|убирает/,
    'the cell was moved in a lecture',
  )
})

test('an open cell cannot have its type changed', () => {
  // A cell turned into a note loses its output and "In [7]" — that is the
  // makeup of the notebook, and in a lecture it belongs to the teacher. The
  // door is open for typing, not for editing the notebook from inside one
  // cell.
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => cellAt(client, 0).set('type', 'markdown'))
  assert.match(passes(server, bytes, LECTURE_ROOM, 'participant') ?? '', /преподавател/i)
})

test('an open cell changes nothing for the teacher, who writes everywhere anyway', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  assert.equal(
    passes(
      server,
      frame(() => typing(client, 1)),
      LECTURE_ROOM,
      'host',
    ),
    null,
  )
})

/* ------------------------------------------------------------- end of class */

test('in a finished class an open cell is closed along with the whole notebook', () => {
  /*
   * Otherwise "Finish class" would leave the room as many doors as the teacher
   * had managed to open during the class, and they would have to be closed one
   * by one, remembering which ones had been opened.
   */
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => typing(client, 0))
  // Rules arrive at the gate as the effective ones — after the end of class,
  // the teacher's.
  const after = rulesAfterClass(LECTURE_ROOM)
  assert.equal(
    passes(server, bytes, after, 'participant', true),
    tr(CLASS_IS_OVER),
    'the open cell survived the end of class',
  )
  // But the teacher types after class: the room stays alive.
  assert.equal(passes(server, bytes, after, 'host', true), null)
})
