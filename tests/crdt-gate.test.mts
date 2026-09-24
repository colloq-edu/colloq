/**
 * Parsing an incoming frame into verbs — before it is applied.
 *
 * The test here is not a formality: the whole gate is built on Yjs
 * properties that do not follow from the documentation but are measured. The
 * parent arrives on the wire in three forms and is most often absent;
 * deleting one cell touches two clients; on every reload the browser offers
 * the server its whole document again. A mistake in any of these places
 * looks like a working gate — and either locks the room under permissive
 * rules or lets a forgery through.
 *
 * So the frames here are real: two documents, bytes exchanged between them,
 * no hand-built structures.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { classify, MAX_SYNC_FRAME_BYTES } from '../server/src/collab/gate.js'
import { rememberDeleted, resetRetyped, settleFresh } from '../server/src/collab/ops.js'
import {
  addBook,
  bookAt,
  bookCells,
  CELLS_KEY,
  CHAT_KEY,
  KERNELS_KEY,
  META_KEY,
  TERMINAL_KEY,
} from '../shared/notebook.js'

/** The server and the browser: two documents, in sync at the start. */
/** The room name — the server remembers deletions per seminar. */
const ROOM = 'gate-test'

function pair(): { server: Y.Doc; client: Y.Doc; frame: (write: () => void) => Uint8Array } {
  const server = new Y.Doc()
  const client = new Y.Doc()

  const cells = server.getArray(CELLS_KEY)
  server.transact(() => {
    server.getMap(META_KEY).set('title', 'Семинар')
    cells.push([cell('c1', 'print(1)')])
    cells.push([cell('c2', 'print(2)')])
  })
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  /** The bytes the browser would send to the server for one transaction. */
  const frame = (write: () => void): Uint8Array => {
    let captured: Uint8Array | null = null
    const grab = (update: Uint8Array): void => {
      captured = captured ? Y.mergeUpdates([captured, update]) : update
    }
    client.on('update', grab)
    client.transact(write)
    client.off('update', grab)
    assert.ok(captured, 'the transaction produced no update')
    return captured
  }

  return { server, client, frame }
}

function cell(id: string, source: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  map.set('id', id)
  map.set('type', 'code')
  const text = new Y.Text()
  text.insert(0, source)
  map.set('source', text)
  map.set('outputs', new Y.Array())
  map.set('state', 'idle')
  map.set('execCount', null)
  map.set('runBy', null)
  map.set('runById', null)
  map.set('startedAt', null)
  map.set('ranMs', null)
  return map
}

function cellAt(doc: Y.Doc, i: number): Y.Map<unknown> {
  return doc.getArray(CELLS_KEY).get(i) as Y.Map<unknown>
}

function ok(judgement: ReturnType<typeof classify>): {
  verdicts: { rule: string; verb?: string; cellId: string | null }[]
  retyped: string[]
  created: string[]
  removed: string[]
} {
  assert.equal(
    judgement.ok,
    true,
    judgement.ok ? '' : `refused: ${judgement.why} (${judgement.path})`,
  )
  if (!judgement.ok) throw new Error('unreachable')
  return judgement
}

function refused(judgement: ReturnType<typeof classify>): string {
  assert.equal(judgement.ok, false, 'the frame passed, but it should not have')
  return judgement.ok ? '' : judgement.why
}

/* ------------------------------------------------------------- ordinary life */

test('a keystroke in a cell\'s text is an edit, and nothing more', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => (cellAt(client, 0).get('source') as Y.Text).insert(8, '0'))
  const { verdicts } = ok(classify(server, bytes))
  assert.deepEqual(
    verdicts.map((v) => v.rule),
    ['edit'],
  )
  assert.equal(verdicts[0].cellId, 'c1', 'the edit was not tied to the cell')
})

test('a new cell is one verdict about the notebook\'s structure', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).push([cell('c3', 'x = 1')]))
  const { verdicts } = ok(classify(server, bytes))
  assert.deepEqual(
    new Set(verdicts.map((v) => `${v.rule}/${v.verb ?? ''}`)),
    new Set(['structure/add']),
  )
})

test('deleting a cell that has run is one verdict too', () => {
  /*
   * This is where the obvious rule "take the outer element of the range"
   * breaks. Deleting a cell that has run gives ranges under TWO clients:
   * besides the browser, the server has its own clock too, having written
   * outputs and state. Inside the server's range the outer element is an
   * output write, which the floor declares server-owned; by that rule every
   * legitimate deletion of a cell that has run would be refused in any room.
   */
  const { server, client, frame } = pair()
  // The server writes the output — with its own clock, as the kernel does.
  server.transact(() => {
    const map = cellAt(server, 0)
    const outputs = map.get('outputs') as Y.Array<unknown>
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('name', 'stdout')
    out.set('text', new Y.Text('1\n'))
    outputs.push([out])
    map.set('state', 'ok')
    map.set('execCount', 1)
    map.set('ranMs', 12)
  }, 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  const bytes = frame(() => client.getArray(CELLS_KEY).delete(0, 1))
  const { verdicts } = ok(classify(server, bytes))
  assert.deepEqual(
    verdicts.map((v) => `${v.rule}/${v.verb ?? ''}`),
    ['structure/remove'],
    'the nested items were not absorbed — more than one verdict',
  )
  assert.equal(verdicts[0].cellId, 'c1')
})

test('changing a cell\'s type is an edit, and the server learns which one to reset', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('type', 'markdown'))
  const { verdicts, retyped } = ok(classify(server, bytes))
  assert.deepEqual(
    verdicts.map((v) => v.rule),
    ['edit'],
  )
  assert.deepEqual(retyped, ['c1'], 'the server will not learn whose execution state to reset')
})

test('the seminar title is a separate rule', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getMap(META_KEY).set('title', 'Другое имя'))
  const { verdicts } = ok(classify(server, bytes))
  assert.deepEqual(
    verdicts.map((v) => v.rule),
    ['title'],
  )
})

/* ------------------------------------------------------- what it is all for */

test('forging someone else\'s output is impossible in any room', () => {
  // This is `text/html` that blanks the screen for the whole seminar, and it
  // used to come as an ordinary frame.
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<script>…' }))
    ;(cellAt(client, 0).get('outputs') as Y.Array<unknown>).push([out])
  })
  assert.match(refused(classify(server, bytes)), /сервер/)
})

test('a forged prompt to enter a password does not get through', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('stdin', { prompt: 'Пароль:', password: true }))
  assert.match(refused(classify(server, bytes)), /сервер/)
})

test('a frame cannot open a cell for its sender', () => {
  /*
   * `open` is not a reading but a right: in a lecture an open cell accepts
   * typing while the notebook is closed. A cell that opened itself is a
   * participant who allowed themselves to type, so the field is server-owned,
   * and the refusal phrase is its own: "this field is written by the server"
   * explains nothing to someone opening a cell for themselves.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('open', true))
  assert.match(refused(classify(server, bytes)), /ячейку открывает преподаватель/)
})

test('a new cell with a lock is accepted, and the server removes the lock from it', () => {
  /*
   * Refusing here would cost more than the hole: Ctrl+Z after deleting an
   * OPEN cell arrives as its copy together with the field, and a teacher
   * undoing their own deletion would get a refusal and a tab reload. The
   * frame is accepted, and settleFresh removes the lock — the returned cell
   * is closed.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const map = cell('c3', 'x')
    map.set('open', true)
    client.getArray(CELLS_KEY).push([map])
  })
  const judged = ok(classify(server, bytes))
  assert.deepEqual(judged.created, ['c3'], 'the cell was not counted as new — there is no one to close it')
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh(ROOM, server, judged.created), 'server')
  assert.equal(cellAt(server, 2).get('open') ?? null, null, 'the lock stayed on the new cell')
})

test('declaring the kernel dead to a healthy room is impossible', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getMap(META_KEY).set('kernelStatus', 'dead'))
  assert.ok(refused(classify(server, bytes)))
})

test('the per-notebook kernel map is closed to the client just like the old key', () => {
  /*
   * Kernel state moved to `meta.kernels` — a map of root → what is up with
   * it. It is as much a server record as `kernelStatus` next to it: it
   * drives the notebook badge, the queue counter and whether the "Interrupt"
   * button is enabled. A tab allowed to write there would tell its
   * neighbours that their kernel is free while it is running — and vice
   * versa.
   */
  const named = pair()
  assert.ok(
    refused(classify(named.server, named.frame(() => {
      const kernels = new Y.Map<unknown>()
      kernels.set('cells', 'idle')
      named.client.getMap(META_KEY).set(KERNELS_KEY, kernels)
    }))),
    'the client created the kernel map',
  )

  // And inside an existing entry — too: the server creates it, the client
  // reads it.
  const inside = pair()
  inside.server.transact(() => {
    const kernels = new Y.Map<unknown>()
    const entry = new Y.Map<unknown>()
    entry.set('status', 'busy')
    kernels.set('cells', entry)
    inside.server.getMap(META_KEY).set(KERNELS_KEY, kernels)
  }, 'server')
  Y.applyUpdate(inside.client, Y.encodeStateAsUpdate(inside.server))
  const bytes = inside.frame(() =>
    ((inside.client.getMap(META_KEY).get(KERNELS_KEY) as Y.Map<any>).get('cells') as Y.Map<any>)
      .set('status', 'idle'),
  )
  assert.ok(refused(classify(inside.server, bytes)), 'the client rewrote the state of someone else\'s kernel')
})

test('a terminal line in someone else\'s name does not get through', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(TERMINAL_KEY).push([{ who: 'Ада', text: 'rm -rf /' }]))
  assert.ok(refused(classify(server, bytes)))
})

test('a forged oracle answer does not get through', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() =>
    client.getArray(CHAT_KEY).push([{ role: 'assistant', text: 'да, удаляй' }]),
  )
  assert.ok(refused(classify(server, bytes)))
})

test('renaming someone else\'s cell is impossible', () => {
  // A matching name is a takeover: "Run" looks for a cell by name.
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 1).set('id', 'c1'))
  assert.match(refused(classify(server, bytes)), /имя/)
})

test('replacing a cell\'s text wholesale is impossible — it holds other people\'s cursors', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('source', new Y.Text('свой текст')))
  assert.match(refused(classify(server, bytes)), /целиком/)
})

test('a section the document does not have is refused', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray('secrets').push(['x']))
  assert.match(refused(classify(server, bytes)), /раздел/)
})

/* ---------------------------------------- values of a new cell, not the path */

test('a new cell with ready output gets through, but the output does not stay in the document', () => {
  /*
   * A cell and its output in one transaction — that is, in one frame in
   * which the server does not have the cell yet. This is not judged by
   * refusal: Ctrl+Z after deleting a cell that has run looks exactly the
   * same, and a refusal costs a person a closed socket and a reload. The
   * server wipes the output right after applying.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    client.getArray(CELLS_KEY).push([cell('c3', 'x')])
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<script>…' }))
    ;(cellAt(client, 2).get('outputs') as Y.Array<unknown>).push([out])
  })
  const judged = ok(classify(server, bytes))
  assert.deepEqual(judged.created, ['c3'])
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh(ROOM, server, judged.created), 'server')
  assert.equal((cellAt(server, 2).get('outputs') as Y.Array<unknown>).length, 0)
})

test('a new cell with a forged stdin does not get through', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const map = cell('c3', 'x')
    map.set('stdin', { prompt: 'Пароль:', password: true })
    client.getArray(CELLS_KEY).push([map])
  })
  assert.match(refused(classify(server, bytes)), /лишнее поле/)
})

test('a cell with a living cell\'s name is not refused, but not counted as created either', () => {
  /*
   * This is what Ctrl+Z looks like after someone brought a deleted cell back
   * from history: the restore recreates it with the old name, the undo
   * inserts a copy. Refusing would mean reloading a person's page over an
   * ordinary gesture. The copy is removed by the twin watcher; it does not
   * get into `created` — otherwise `settleFresh` would reset to clean a cell
   * that already lives in the notebook, that is, would wipe the room's
   * output by a name coincidence.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).push([cell('c1', 'x')]))
  const judged = ok(classify(server, bytes))
  assert.deepEqual(judged.created, [])
})

test('two new cells with one name in one frame do not get through', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).push([cell('c9', 'a'), cell('c9', 'b')]))
  assert.match(refused(classify(server, bytes)), /одним именем/)
})

test('a new cell that declared itself executed is reset to clean, not refused', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const map = cell('c3', 'x')
    map.set('state', 'ok')
    map.set('execCount', 41)
    client.getArray(CELLS_KEY).push([map])
  })
  const judged = ok(classify(server, bytes))
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh(ROOM, server, judged.created), 'server')
  const made = cellAt(server, 2)
  assert.equal(made.get('state'), 'idle', 'the forged "executed" stayed in the document')
  assert.equal(made.get('execCount'), null)
})

test('a new cell\'s text must be a Y.Text', () => {
  // A plain string in place of a Y.Text throws inside rendering in EVERY
  // tab, not only for the one who wrote it.
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const map = cell('c3', 'x')
    map.set('source', 'просто строка')
    client.getArray(CELLS_KEY).push([map])
  })
  assert.match(refused(classify(server, bytes)), /Y\.Text/)
})

test('a cell type that does not exist does not get through', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('type', 'sql'))
  assert.ok(refused(classify(server, bytes)))
})

/* -------------------------------------------------- freshness and reconnection */

test('a browser that offered its whole document again is not refused', () => {
  /*
   * This happens on every page reload: `y-indexeddb` replays the local
   * cache, `y-websocket` resends everything that is not itself. Without a
   * freshness check such a frame would be refused in any room under any
   * rules — and the prescribed rebuild would wipe the student's cache.
   */
  const { server, client } = pair()
  const whole = Y.encodeStateAsUpdate(client)
  const { verdicts } = ok(classify(server, whole))
  assert.deepEqual(verdicts, [], `the whole document gave verdicts: ${JSON.stringify(verdicts)}`)
})

test('deleting what is already deleted means nothing', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).delete(1, 1))
  ok(classify(server, bytes))
  Y.applyUpdate(server, bytes)
  // The same frame a second time — a reconnect, a cache, anything.
  assert.deepEqual(ok(classify(server, bytes)).verdicts, [])
})

test('a reference to content the server does not have is refused', () => {
  /*
   * Measured: a frame without structures, with one deletion range on the
   * lead's current clock, is put by Yjs into pendingDs and re-applied inside
   * every following applyUpdate. The lead types " world" — they have
   * "hello world", the server has "hello", and every next keystroke is
   * deleted on arrival. Silently. Forever.
   */
  const { server, client, frame } = pair()
  const ahead = new Y.Doc()
  Y.applyUpdate(ahead, Y.encodeStateAsUpdate(client))
  // A tab whose content the server has not heard of yet deletes its own.
  const local = frame(() => (cellAt(client, 0).get('source') as Y.Text).insert(0, 'ЛОКАЛЬНО'))
  Y.applyUpdate(ahead, local)
  let bytes: Uint8Array | null = null
  ahead.on('update', (u: Uint8Array) => (bytes = bytes ? Y.mergeUpdates([bytes, u]) : u))
  ahead.transact(() => (cellAt(ahead, 0).get('source') as Y.Text).delete(0, 8))
  assert.ok(bytes)
  assert.match(refused(classify(server, bytes!)), /нет/)
})

test('a write into a tombstone gets through', () => {
  /*
   * And this is NOT the previous case: the clock tells them apart
   * mechanically. One deleted the cell in which the other is typing; the
   * other's structure resolves through origin at a low clock, getItem
   * returns GC — a write into a tombstone changes nothing anyone will see.
   */
  const { server, client, frame } = pair()
  const typing = frame(() => (cellAt(client, 1).get('source') as Y.Text).insert(0, 'ещё '))
  server.transact(() => server.getArray(CELLS_KEY).delete(1, 1), 'other')
  // The tombstone needs garbage collection — that is what makes getItem
  // return GC.
  Y.applyUpdate(server, Y.encodeStateAsUpdate(server))
  ok(classify(server, typing))
})

/* ----------------------------------------------------------------- ceilings */

test('a frame over the ceiling is refused before parsing', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() =>
    (cellAt(client, 0).get('source') as Y.Text).insert(0, 'ы'.repeat(MAX_SYNC_FRAME_BYTES)),
  )
  assert.ok(bytes.byteLength > MAX_SYNC_FRAME_BYTES)
  assert.match(refused(classify(server, bytes)), /большой/)
})

test('garbage instead of a frame is refused, not let through', () => {
  // Letting through what could not be read means executing it after the
  // check stopped looking.
  const { server } = pair()
  assert.ok(refused(classify(server, new Uint8Array([9, 9, 9, 9, 9, 9]))))
})

/* ---------------------------------------------------- undoing one's own deletion */

test('Ctrl+Z after deleting a cell that has run gets through and brings the output back', () => {
  /*
   * A gesture the gate broke silently and in any room. Yjs undoes a deletion
   * with a COPY — that is, the browser offers the server a new cell with
   * ready output — while the floor forbids the browser to write output. A
   * refusal here would mean rebuilding the document over an ordinary Ctrl+Z.
   *
   * What tells them apart is the server's memory: it remembers what was
   * deleted from it. And it brings back its own output, not the sent one, so
   * the floor stays intact.
   */
  const { server, client, frame } = pair()
  server.transact(() => {
    const map = cellAt(server, 0)
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('name', 'stdout')
    out.set('text', new Y.Text('42\n'))
    ;(map.get('outputs') as Y.Array<unknown>).push([out])
    map.set('state', 'ok')
    map.set('execCount', 7)
    map.set('runBy', 'Мария')
  }, 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  const undo = new Y.UndoManager(client.getArray(CELLS_KEY), {
    trackedOrigins: new Set([null, 'local']),
    captureTimeout: 400,
  })

  const removal = frame(() => client.transact(() => client.getArray(CELLS_KEY).delete(0, 1)))
  const gone = ok(classify(server, removal))
  assert.deepEqual(gone.removed, ['c1'], 'the server will not learn what to remember')
  // The server remembers BEFORE applying: after it there is nothing left to
  // read.
  rememberDeleted(ROOM, server, gone.removed)
  Y.applyUpdate(server, removal)

  let back: Uint8Array | null = null
  const grab = (u: Uint8Array): void => {
    back = back ? Y.mergeUpdates([back, u]) : u
  }
  client.on('update', grab)
  undo.undo()
  client.off('update', grab)
  assert.ok(back)

  const restored = ok(classify(server, back!))
  assert.deepEqual(restored.created, ['c1'], 'the undo was not recognized as creating a cell')
  Y.applyUpdate(server, back!)
  server.transact(() => settleFresh(ROOM, server, restored.created), 'server')

  const cell = cellAt(server, 0)
  assert.equal(cell.get('id'), 'c1', 'the wrong cell came back')
  const outputs = cell.get('outputs') as Y.Array<Y.Map<unknown>>
  assert.equal(outputs.length, 1, 'the cell came back without output')
  assert.equal((outputs.get(0).get('text') as Y.Text).toString(), '42\n')
  assert.equal(cell.get('execCount'), 7)
  assert.equal(cell.get('runBy'), 'Мария')
  assert.equal(
    cell.get('startedAt'),
    null,
    'the stopwatch came back on a cell nobody is running',
  )
})

test('the output is put by the server from its own record, not by the browser from the frame', () => {
  /*
   * A frame with ready output gets through — otherwise a late Ctrl+Z would
   * cost a reload — but the output gets into the document only from the
   * server's record. Here there is no record, so nothing gets in.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    client.getArray(CELLS_KEY).push([cell('c7', 'x')])
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<style>*{display:none}</style>' }))
    ;(cellAt(client, 2).get('outputs') as Y.Array<unknown>).push([out])
  })

  assert.equal(classify(server, bytes).ok, true)
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh(ROOM, server, ['c7']), 'server')
  const made = server
    .getArray(CELLS_KEY)
    .toArray()
    .find((c) => (c as Y.Map<unknown>).get('id') === 'c7') as Y.Map<unknown>
  assert.equal(
    (made.get('outputs') as Y.Array<unknown>).length,
    0,
    'the forged output stayed in the document',
  )
})

test('an undo the server no longer remembers brings the cell back clean, not as a refusal', () => {
  /*
   * The memory of deletions lives ten minutes and thirty cells. Beyond these
   * bounds an undo used to arrive as "a new cell declares itself executed":
   * the socket closed, the cache wiped, the page reloaded in the middle of a
   * class — over an ordinary Ctrl+Z. The cell comes back without output: the
   * server no longer remembers it and does not take it from the frame.
   */
  const { server, client, frame } = pair()
  server.transact(() => {
    const map = cellAt(server, 0)
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('name', 'stdout')
    out.set('text', new Y.Text('42\n'))
    ;(map.get('outputs') as Y.Array<unknown>).push([out])
    map.set('state', 'ok')
    map.set('execCount', 7)
  }, 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  const undo = new Y.UndoManager(client.getArray(CELLS_KEY), {
    trackedOrigins: new Set([null, 'local']),
    captureTimeout: 400,
  })
  const removal = frame(() => client.transact(() => client.getArray(CELLS_KEY).delete(0, 1)))
  ok(classify(server, removal))
  // The server does NOT remember: ten minutes have passed, or thirty
  // deletions in a row.
  Y.applyUpdate(server, removal)

  let back: Uint8Array | null = null
  const grab = (u: Uint8Array): void => {
    back = back ? Y.mergeUpdates([back, u]) : u
  }
  client.on('update', grab)
  undo.undo()
  client.off('update', grab)
  assert.ok(back)

  const forgotten = 'gate-test-forgotten'
  const restored = ok(classify(server, back!))
  assert.deepEqual(restored.created, ['c1'])
  Y.applyUpdate(server, back!)
  server.transact(() => settleFresh(forgotten, server, restored.created), 'server')
  const cell = cellAt(server, 0)
  assert.equal(cell.get('id'), 'c1', 'the cell did not come back')
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 0)
  assert.equal(cell.get('state'), 'idle')
  assert.equal(cell.get('execCount'), null)
})

/* --------------------------------------------------------- second notebook */

/**
 * A room with two notebooks: the first has the root `cells`, the second its
 * own.
 *
 * Everything below broke silently exactly in the second: the gate judges
 * edits in all notebooks (`isBookRoot`), while server operations walked the
 * root `cells` — that is, the first one. Ctrl+Z in the second ended in a
 * refused frame and a page reload, and a cell turned into text kept its
 * output and "In [7]".
 */
function twoBooks(): {
  server: Y.Doc
  client: Y.Doc
  frame: (write: () => void) => Uint8Array
  root: string
} {
  const { server, client, frame } = pair()
  server.transact(() => {
    addBook(server, 'Тетрадь.ipynb', CELLS_KEY)
    const second = addBook(server, 'разбор.ipynb')
    bookCells(server, second.root).push([cell('b1', 'print(3)')])
  }, 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  const root = bookAt(server, 'разбор.ipynb')!.root
  assert.notEqual(root, CELLS_KEY, 'the second notebook sat on the first one\'s root')
  return { server, client, frame, root }
}

function ran(doc: Y.Doc, root: string, id: string): Y.Map<unknown> {
  const map = bookCells(doc, root)
    .toArray()
    .find((c) => (c as unknown as Y.Map<unknown>).get('id') === id) as unknown as Y.Map<unknown>
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('name', 'stdout')
    out.set('text', new Y.Text('3\n'))
    ;(map.get('outputs') as Y.Array<unknown>).push([out])
    map.set('state', 'ok')
    map.set('execCount', 7)
    map.set('runBy', 'Мария')
  }, 'server')
  return map
}

test('Ctrl+Z in the second notebook brings the cell back with output, not a refusal', () => {
  const room = 'gate-test-second'
  const { server, client, frame, root } = twoBooks()
  ran(server, root, 'b1')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  const undo = new Y.UndoManager(client.getArray(root), {
    trackedOrigins: new Set([null, 'local']),
    captureTimeout: 400,
  })
  const removal = frame(() => client.transact(() => client.getArray(root).delete(0, 1)))
  const gone = ok(classify(server, removal))
  assert.deepEqual(gone.removed, ['b1'], 'the deletion in the second notebook was not recognized')
  rememberDeleted(room, server, gone.removed)
  Y.applyUpdate(server, removal)

  let back: Uint8Array | null = null
  const grab = (u: Uint8Array): void => {
    back = back ? Y.mergeUpdates([back, u]) : u
  }
  client.on('update', grab)
  undo.undo()
  client.off('update', grab)
  assert.ok(back)

  const restored = ok(classify(server, back!))
  assert.deepEqual(restored.created, ['b1'])
  Y.applyUpdate(server, back!)
  server.transact(() => settleFresh(room, server, restored.created), 'server')

  const cell = bookCells(server, root).get(0) as unknown as Y.Map<unknown>
  assert.equal(cell.get('id'), 'b1')
  assert.equal(
    (cell.get('outputs') as Y.Array<unknown>).length,
    1,
    'the output in the second notebook did not come back',
  )
  assert.equal(cell.get('execCount'), 7)
  assert.equal(cell.get('runBy'), 'Мария')
})

test('changing the type in the second notebook clears the output and the state', () => {
  const { server, client, frame, root } = twoBooks()
  ran(server, root, 'b1')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  const bytes = frame(() =>
    (client.getArray(root).get(0) as Y.Map<unknown>).set('type', 'markdown'),
  )
  const judged = ok(classify(server, bytes))
  assert.deepEqual(judged.retyped, ['b1'])
  Y.applyUpdate(server, bytes)
  server.transact(() => resetRetyped(server, judged.retyped), 'server')

  const cell = bookCells(server, root).get(0) as unknown as Y.Map<unknown>
  assert.equal(cell.get('state'), 'idle', 'the note cell stayed "executed"')
  assert.equal(cell.get('execCount'), null)
  assert.equal(cell.get('startedAt'), null)
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 0)
})

test('a new cell is always clean, even if the browser sent it dirty', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).push([cell('c8', 'x')]))
  const judged = ok(classify(server, bytes))
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh(ROOM, server, judged.created), 'server')
  const made = server
    .getArray(CELLS_KEY)
    .toArray()
    .find((c) => (c as Y.Map<unknown>).get('id') === 'c8') as Y.Map<unknown>
  assert.equal(made.get('state'), 'idle')
  assert.equal(made.get('execCount'), null)
  assert.equal(made.get('stdin') ?? null, null)
})
