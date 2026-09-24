/**
 * A room in server memory: how long it lives there and what one of its
 * frames costs.
 *
 * Three things, each of which breaks silently and shows only at five
 * hundred. A room entered once in a semester hung in memory until the class
 * was deleted — together with a second full snapshot in the history and the
 * texts of all the cells. One keystroke went to the room as two frames per
 * socket with no merging. And writing the notebook file woke a walk of the
 * whole folder and the whole room's file tree on every kernel output,
 * although an output does not change a single byte on disk.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { createSession, listVersions } from '../server/src/db.js'
import { sessionDir } from '../server/src/workspace.js'
import {
  FACES_WINDOW_MS,
  getSessionDoc,
  handleCollabSocket,
  holdRoom,
  onlineCount,
  ownAwareness,
  peekSessionDoc,
  shutdownCollab,
  sweepIdleRooms,
} from '../server/src/collab/index.js'
import { onBooksWritten, openBook, projectBooks } from '../server/src/collab/books.js'
import { putText } from '../server/src/collab/files.js'
import { beginHistory, discardBurst, record } from '../server/src/collab/history.js'
import { BURST_MAX_CHARS } from '../shared/history.js'
import {
  addBook,
  bookCells,
  cellOutputs,
  cellSource,
  createCell,
  createChatEntry,
  getCells,
  getChat,
  getMeta,
} from '../shared/notebook.js'

after(() => shutdownCollab())

const MINUTE = 60 * 1000

/** An empty room is released after ten minutes; we take a margin. */
const LATER = 11 * MINUTE

/**
 * Whether the sweep released THIS room. Exactly this one, not the list as a
 * whole: the process has one room map for the whole suite, and a
 * neighbouring test keeps its own room in it.
 */
function released(id: string, at: number = Date.now() + LATER): boolean {
  return sweepIdleRooms(at).includes(id)
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** The presence window and a bit more: carets go out when it ends. */
const faceWindow = (): Promise<void> => wait(FACES_WINDOW_MS + 50)

/* ---------------------------------------------------- evicting idle rooms */

test('an empty room is released from memory and comes back whole', () => {
  const id = 'evict-plain'
  createSession(id, 'Пустеющая', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'x = 1\n'))
  const wrote = cellSource(getCells(doc).get(0)).toString()

  assert.equal(released(id), true)
  assert.equal(peekSessionDoc(id), null, 'the room stayed in memory')

  // It comes back from the snapshot — exactly as after a server restart.
  const again = getSessionDoc(id).doc
  assert.equal(cellSource(getCells(again).get(0)).toString(), wrote, 'the work did not reach the disk')
})

test('a room with a running cell is not evicted from under it', () => {
  const id = 'evict-busy'
  createSession(id, 'Считающая', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => getMeta(doc).set('runningCell', 'c1'))

  assert.equal(released(id), false, 'the document was torn down from under the kernel')

  doc.transact(() => getMeta(doc).set('runningCell', null))
  assert.equal(released(id), true)
})

test('a queue and a kernel restart hold the room just like a running cell', () => {
  const id = 'evict-queue'
  createSession(id, 'С очередью', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => getMeta(doc).set('kernelStatus', 'busy'))
  assert.equal(released(id), false, 'the document was torn down from under a kernel restart')

  doc.transact(() => {
    getMeta(doc).set('kernelStatus', 'idle')
    const queue = new Y.Array<string>()
    getMeta(doc).set('queue', queue)
    queue.push(['c2'])
  })
  assert.equal(released(id), false, 'the queue was left without a document')

  doc.transact(() => (getMeta(doc).get('queue') as Y.Array<string>).delete(0, 1))
  assert.equal(released(id), true)
})

test('a document holder keeps it from being destroyed, and once released lets it go', () => {
  const id = 'evict-hold'
  createSession(id, 'Занятая', null)
  getSessionDoc(id)
  const release = holdRoom(id)
  assert.equal(released(id), false, 'the document was torn down from under its holder')
  release()
  // Releasing twice is no problem: the counter goes to zero once.
  release()
  assert.equal(released(id), true)
})

test('a stuck Oracle stream holds the room for no longer than three hours', () => {
  const id = 'evict-stuck'
  createSession(id, 'Застрявшая', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    const entry = createChatEntry({
      participantId: 'p_one',
      name: 'Аня',
      color: '#000',
      question: 'почему?',
    })
    entry.set('state', 'streaming')
    getChat(doc).push([entry])
  })

  assert.equal(released(id), false, "the Oracle's answer was cut off mid-stream")
  // The kernel tears down an idle room's container after two hours; after
  // three there is nobody left to write to the document, and "streaming"
  // stays forever.
  assert.equal(released(id, Date.now() + 4 * 60 * MINUTE), true)
})

test('a room with someone in it is never evicted', () => {
  const id = 'evict-occupied'
  createSession(id, 'Живая', null)
  const seat = socket()
  handleCollabSocket(seat.ws, id, 'participant', 'p_one')

  assert.equal(released(id, Date.now() + 10 * 60 * MINUTE), false, 'a room with people in it was evicted')

  seat.close()
  assert.equal(released(id), true)
})

/* -------------------------------------------------------- frame merging */

interface Fake {
  ws: WebSocket
  frames: Uint8Array[]
  close(): void
}

/** Exactly what `handleCollabSocket` reads, plus a list of received frames. */
function socket(): Fake {
  const frames: Uint8Array[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    // How many bytes are waiting to be sent: by it the server decides whether
    // to send this socket carets and whether it is time to close it
    // (collab/index.ts · send). A real socket always has the field, and here
    // it must be a number too.
    bufferedAmount: 0,
    // Exactly the signature the server calls with: the frame, the compression
    // options and the callback. While the options did not arrive here, the
    // fake took them for the callback and called an object — the socket
    // closed on the very first frame, and the test reported it as missing
    // merging.
    send(frame: unknown, ...rest: unknown[]) {
      if (frame instanceof Uint8Array) frames.push(new Uint8Array(frame))
      const done = rest.find((it) => typeof it === 'function') as
        | ((err?: Error) => void)
        | undefined
      done?.()
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
      // The handler must run: the heartbeat is stopped in it, and without it
      // the interval outlives the test and drags the whole suite along.
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  return {
    ws: fake as unknown as WebSocket,
    frames,
    close: () => fake.close(),
  }
}

/** Sync frames, which carry edits; the first frame on entry does not count. */
const syncFrames = (fake: Fake): Uint8Array[] => fake.frames.filter((frame) => frame[0] === 0)

/** The update bytes from a sync frame: type, subtype, payload. */
function updateIn(frame: Uint8Array): Uint8Array {
  const decoder = decoding.createDecoder(frame)
  decoding.readVarUint(decoder)
  decoding.readVarUint(decoder)
  return decoding.readVarUint8Array(decoder)
}

test('five edits in one tick go to the room as one frame, not five', async () => {
  const id = 'coalesce-one'
  createSession(id, 'Склейка', null)
  const { doc } = getSessionDoc(id)
  const watcher = socket()
  handleCollabSocket(watcher.ws, id, 'participant', 'p_watch')
  await tick()

  const before = Y.encodeStateAsUpdate(doc)
  watcher.frames.length = 0
  for (const ch of 'abcde') {
    doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, ch))
  }
  assert.equal(syncFrames(watcher).length, 0, 'the frame went out before the end of the tick')

  await tick()
  const sent = syncFrames(watcher)
  assert.equal(sent.length, 1, `the room got ${sent.length} frames instead of one`)

  // And the merged frame is the same five edits: the tab arrives at the same
  // text as the server.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, before)
  Y.applyUpdate(tab, updateIn(sent[0]))
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
  )

  watcher.close()
})

/**
 * The merged frame goes to EVERYONE, the author included — and that is
 * cheaper than subtracting the author from it.
 *
 * The subtraction cost a square: the batch was merged anew for every sending
 * socket (`mergeUpdates` over the whole burst minus its own edits). Bench
 * measurement: one author — 0.01 ms per broadcast, a hundred — 15.75 ms, five
 * hundred — 1403 ms, that is, a second and a half of a busy event loop per
 * tick of a room where half the course is typing.
 *
 * Sending one's own edits back is safe because in Yjs applying structures
 * that are already there is a no-op: the transaction changes nothing, and no
 * `update` event comes out of it. It is checked here the same way the tab
 * will see it.
 */
test("the merged frame goes to everyone, and the author's own bytes change nothing for the author", async () => {
  const id = 'coalesce-author'
  createSession(id, 'Автор', null)
  const { doc } = getSessionDoc(id)
  const author = socket()
  const reader = socket()
  handleCollabSocket(author.ws, id, 'participant', 'p_author')
  handleCollabSocket(reader.ws, id, 'participant', 'p_reader')
  await tick()
  author.frames.length = 0
  reader.frames.length = 0

  // The author's tab: the same as the server has, plus its own keystrokes.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(doc))

  // An edit that came over a socket carries it as its origin — that is how
  // `handleMessage` applies it.
  for (const ch of 'xyz') {
    doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, ch), author.ws)
  }
  // The tab already has these keystrokes: it typed them.
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(doc))
  await tick()

  assert.equal(syncFrames(author).length, 1, "the room's common frame did not go to the author")
  assert.equal(syncFrames(reader).length, 1, 'the neighbour was sent more than one frame')
  assert.deepEqual(
    syncFrames(author)[0],
    syncFrames(reader)[0],
    'the room got two different frames: the merge was computed twice',
  )

  // No echo: a tab that applies its own bytes does not produce an update that
  // would travel back to the server.
  const echo: Uint8Array[] = []
  tab.on('update', (update: Uint8Array) => echo.push(update))
  Y.applyUpdate(tab, updateIn(syncFrames(author)[0]), 'провайдер')
  assert.deepEqual(echo, [], "the tab's own bytes produced an update in it")
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
    "the tab's text diverged from the room",
  )

  author.close()
  reader.close()
})

test('presence is merged by a window: ten caret moves make one frame', async () => {
  const id = 'coalesce-faces'
  createSession(id, 'Курсоры', null)
  const entry = getSessionDoc(id)
  const watcher = socket()
  handleCollabSocket(watcher.ws, id, 'participant', 'p_watch')
  await faceWindow()
  watcher.frames.length = 0

  const guest = new Awareness(new Y.Doc())
  for (let i = 0; i < 10; i += 1) {
    guest.setLocalStateField('user', { id: 'p_guest', name: 'Гость', activeCellId: `c${i}` })
    // Exactly what the server does on receiving a presence frame from a tab.
    applyAwarenessUpdate(
      entry.awareness,
      encodeAwarenessUpdate(guest, [guest.clientID]),
      'приезжий',
    )
  }
  const faces = watcher.frames.filter((frame) => frame[0] === 1)
  assert.equal(faces.length, 0, 'the presence frame went out before the window')

  // A tick is no longer enough: presence waits for the window — a quarter of
  // a second per room, not a tick per movement (collab/index.ts ·
  // FACES_WINDOW_MS).
  await tick()
  assert.equal(
    watcher.frames.filter((frame) => frame[0] === 1).length,
    0,
    'the caret went out at the end of the tick, the window does not work',
  )

  await faceWindow()
  assert.equal(
    watcher.frames.filter((frame) => frame[0] === 1).length,
    1,
    'ten caret moves went out as ten frames',
  )

  guest.destroy()
  watcher.close()
})

/* ------------------------------------------------------ backpressure */

/** How many bytes are "waiting to be sent" on the fake socket. */
function stalled(fake: Fake, bytes: number): void {
  ;(fake.ws as unknown as { bufferedAmount: number }).bufferedAmount = bytes
}

/**
 * A cell output frame with an image is hundreds of kilobytes, and it goes to
 * EVERYONE. While `send` looked only at `readyState`, the server put a copy of
 * such a frame into the queue of each of five hundred sockets, and all the
 * room's following keystrokes queued up behind the image. Now the queue has
 * two marks (collab/index.ts · AWARENESS_STALL_BYTES, HOPELESS_BYTES).
 */
test('a lagging socket stops getting carets but still gets edits', async () => {
  const id = 'stall-faces'
  createSession(id, 'Отставший', null)
  const entry = getSessionDoc(id)
  const slow = socket()
  const quick = socket()
  handleCollabSocket(slow.ws, id, 'participant', 'p_slow')
  handleCollabSocket(quick.ws, id, 'participant', 'p_quick')
  await tick()
  slow.frames.length = 0
  quick.frames.length = 0

  // Two megabytes queued: past the first mark (1 MB) but far from the second.
  stalled(slow, 2 * 1024 * 1024)

  const guest = new Awareness(new Y.Doc())
  guest.setLocalStateField('user', { id: 'p_guest', name: 'Гость', activeCellId: 'c1' })
  applyAwarenessUpdate(entry.awareness, encodeAwarenessUpdate(guest, [guest.clientID]), 'приезжий')
  entry.doc.transact(() => cellSource(getCells(entry.doc).get(0)).insert(0, 'z'))
  // An edit goes out at the end of the tick, presence at the end of the
  // window.
  await faceWindow()

  assert.equal(
    slow.frames.filter((frame) => frame[0] === 1).length,
    0,
    'the caret went into a queue that already holds an image',
  )
  assert.equal(syncFrames(slow).length, 1, 'the lagging socket was not given the edit — and the edit is the document')
  assert.equal(quick.frames.filter((frame) => frame[0] === 1).length, 1, 'the caret did not reach the neighbour')
  assert.equal(syncFrames(quick).length, 1)

  guest.destroy()
  slow.close()
  quick.close()
})

test('a hopelessly lagging socket is closed instead of piling up megabytes for it', async () => {
  const id = 'stall-hopeless'
  createSession(id, 'Безнадёжный', null)
  const { doc } = getSessionDoc(id)
  const lost = socket()
  handleCollabSocket(lost.ws, id, 'participant', 'p_lost')
  await tick()
  lost.frames.length = 0
  assert.equal(onlineCount(id), 1)

  // Nine megabytes: not even a phone at the edge of the network will catch up
  // with that — the tab will rebuild the document in one sync step, and that
  // is cheaper.
  stalled(lost, 9 * 1024 * 1024)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'z'))
  await tick()

  assert.equal(syncFrames(lost).length, 0, 'the frame was put into the dead queue after all')
  assert.equal(onlineCount(id), 0, 'the room still counts the hopeless socket as its own')
})

/* -------------------------------------- notebook projection and the tree */

test('a cell output does not wake the notebook write, but a cell edit does', async () => {
  const id = 'books-quiet'
  createSession(id, 'Проекция', null)
  const { doc } = getSessionDoc(id)

  const told: string[] = []
  onBooksWritten((session) => told.push(session))

  // The room's first write happens right on opening — wait for it and forget
  // it.
  await wait(1_800)
  told.length = 0

  // The kernel writes output: the notebook file has no outputs at all.
  doc.transact(() => {
    const cell = getCells(doc).get(0)
    const output = new Y.Map<unknown>()
    output.set('type', 'stream')
    output.set('text', new Y.Text('привет'))
    cellOutputs(cell).push([output as never])
    cell.set('execCount', 1)
    cell.set('state', 'ok')
  }, 'kernel')
  await wait(1_800)
  assert.deepEqual(told, [], 'the file tree went out to the room because of a cell output')

  // But the cell text is in the file — and the room learns about that.
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'print(1)'))
  await wait(1_800)
  assert.deepEqual(told, [id], 'the room was not told about the rewritten notebook')

  onBooksWritten(() => {})
})

test('the projection says whether it wrote anything at all', () => {
  const id = 'books-wrote'
  createSession(id, 'Проекция-2', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'y = 2'))

  assert.equal(projectBooks(id), true, 'the first notebook write did not happen')
  assert.equal(projectBooks(id), false, 'the notebook was rewritten although the disk holds the same')
})

/* ------------------------------------------------------- large notebook */

/** A notebook of a given number of bytes: one output inflated to the size. */
function fatNotebook(bytes: number): string {
  const shell = {
    cells: [
      {
        cell_type: 'code',
        source: ['print("привет")'],
        metadata: {},
        execution_count: 1,
        outputs: [{ output_type: 'display_data', data: { 'image/png': '' }, metadata: {} }],
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }
  const base = JSON.stringify(shell)
  const png = 'A'.repeat(Math.max(0, bytes - base.length))
  shell.cells[0].outputs[0].data['image/png'] = png
  return JSON.stringify(shell)
}

test('a notebook with images opens instead of being declared "not like an .ipynb"', () => {
  const id = 'book-fat'
  createSession(id, 'Большая', null)
  getSessionDoc(id)
  const file = path.join(sessionDir(id), 'Лекция.ipynb')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Larger than the editor's ceiling (1.5 MB): an ordinary teacher's notebook.
  fs.writeFileSync(file, fatNotebook(2 * 1024 * 1024))

  const opened = openBook(id, 'Лекция.ipynb')
  assert.equal(opened.ok, true, `did not open: ${opened.ok ? '' : opened.why}`)
  if (!opened.ok) return
  const cells = bookCells(getSessionDoc(id).doc, opened.book.root)
  assert.equal(cells.length, 1)
  assert.equal(cellSource(cells.get(0)).toString(), 'print("привет")')
})

test('a notebook over its ceiling is refused with words about its size', () => {
  const id = 'book-huge'
  createSession(id, 'Огромная', null)
  getSessionDoc(id)
  const file = path.join(sessionDir(id), 'Гора.ipynb')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, fatNotebook(33 * 1024 * 1024))

  const opened = openBook(id, 'Гора.ipynb')
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.why, /МБ/, `the refusal was not about size: ${opened.why}`)
  assert.doesNotMatch(opened.why, /не похоже/, 'the wrong reason was given')
})

/* --------------------------------------------------------- shape and burst */

function historyRoom(id: string): Y.Doc {
  createSession(id, 'История', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  return doc
}

/** Record the way `collab/index.ts` does it, together with the transaction. */
function watchFor(id: string, doc: Y.Doc, author: string | null): void {
  doc.on('update', (update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction) =>
    record(id, doc, update, author, tr),
  )
}

const edits = (id: string): number =>
  listVersions(id, 200).filter((v) => v.kind === 'edit' || v.kind === 'quiet').length

test('typing does not close a burst, but moving a cell does', () => {
  const id = 'shape-typing'
  const doc = historyRoom(id)
  doc.transact(() => getCells(doc).push([createCell('code', 'a', 'c1'), createCell('code', 'b', 'c2')]))
  watchFor(id, doc, 'p_one')

  const before = edits(id)
  for (const ch of 'print(1)') doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, ch))
  assert.equal(edits(id), before, 'typing closed the burst on every keystroke')

  // But the notebook's structure closes it at once: that is what people open
  // the panel for.
  doc.transact(() => getCells(doc).push([createCell('code', 'c', 'c3')]))
  assert.equal(edits(id), before + 1, 'the added cell did not become a version')
  discardBurst(id)
})

test('a move in the SECOND notebook closes a burst too', () => {
  const id = 'shape-second'
  const doc = historyRoom(id)
  doc.transact(() => {
    getCells(doc).push([createCell('code', 'a', 'c1')])
    addBook(doc, 'Вторая.ipynb', 'cells-2')
    bookCells(doc, 'cells-2').push([createCell('code', 'x', 'd1'), createCell('code', 'y', 'd2')])
  })
  watchFor(id, doc, 'p_one')

  const before = edits(id)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'z'))
  assert.equal(edits(id), before, 'typing in the first notebook closed the burst')

  // The shape looked only at the room notebook: a structural edit in the
  // second one slipped past the history and got merged with someone else's
  // typing.
  doc.transact(() => bookCells(doc, 'cells-2').delete(0, 1))
  assert.equal(edits(id), before + 1, 'the edit in the second notebook did not become a version')
  discardBurst(id)
})

test('the burst ceiling grows with the number of people typing', () => {
  // In Latin letters, so that a character is a byte: the burst counts update
  // BYTES.
  const big = 'a'.repeat(BURST_MAX_CHARS + 200)

  const alone = 'burst-alone'
  const one = historyRoom(alone)
  one.transact(() => getCells(one).push([createCell('code', '', 'c1')]))
  one.on('update', (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) =>
    record(alone, one, u, 'p_one', tr),
  )
  const wasAlone = edits(alone)
  one.transact(() => cellSource(getCells(one).get(0)).insert(0, big))
  assert.equal(edits(alone), wasAlone + 1, "a single typist's burst did not close on volume")
  discardBurst(alone)

  // The same volume written by two people is two pieces of work, not one, and
  // its threshold is twice as high: otherwise five hundred typists would close
  // the burst dozens of times a second, each time unpacking the whole
  // document.
  const pair = 'burst-pair'
  const two = historyRoom(pair)
  two.transact(() => getCells(two).push([createCell('code', '', 'c1')]))
  const wasPair = edits(pair)
  const half = 'a'.repeat(Math.floor(BURST_MAX_CHARS / 2) + 200)
  for (const author of ['p_one', 'p_two']) {
    const grab = (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) =>
      record(pair, two, u, author, tr)
    two.on('update', grab)
    two.transact(() => cellSource(getCells(two).get(0)).insert(0, half))
    two.off('update', grab)
  }
  assert.equal(edits(pair), wasPair, "the burst of two closed at one person's threshold")
  discardBurst(pair)
})

/* --------------------------------------------------------- faces and echo */

test('the room remembers a departed face longer than it takes five hundred tabs to turn over', () => {
  const room = new Awareness(new Y.Doc())
  const first = {} as WebSocket
  const second = {} as WebSocket
  const conns = new Map<WebSocket, unknown>([
    [first, { clientIds: new Set<number>() }],
    [second, { clientIds: new Set<number>() }],
  ])
  const entry = { awareness: room, conns } as never

  // A face the room has already seen and lost together with its socket.
  const gone = new Awareness(new Y.Doc())
  gone.setLocalStateField('user', { name: 'Ушедший' })
  assert.equal(ownAwareness(entry, first, encodeAwarenessUpdate(gone, [gone.clientID])), true)

  // The neighbouring tab already has its own face — and it is the one that
  // sends the echo.
  const neighbour = new Awareness(new Y.Doc())
  neighbour.setLocalStateField('user', { name: 'Сосед' })
  assert.equal(
    ownAwareness(entry, second, encodeAwarenessUpdate(neighbour, [neighbour.clientID])),
    true,
  )

  // During a class in a room of five hundred people far more than two hundred
  // and fifty-six faces pass through — that is how many the old ceiling
  // remembered.
  for (let i = 0; i < 600; i += 1) {
    const passing = new Awareness(new Y.Doc())
    const seat = {} as WebSocket
    conns.set(seat, { clientIds: new Set<number>() })
    assert.equal(
      ownAwareness(entry, seat, encodeAwarenessUpdate(passing, [passing.clientID])),
      true,
    )
    conns.delete(seat)
    passing.destroy()
  }

  // The neighbouring tab's echo brings the departed one's clientID. Had the
  // room forgotten it, the tab would have taken someone else's face along with
  // the caret and the name.
  assert.equal(
    ownAwareness(entry, second, encodeAwarenessUpdate(gone, [gone.clientID])),
    false,
    "the neighbouring tab's echo took the departed one's face",
  )

  gone.destroy()
  neighbour.destroy()
  room.destroy()
})

/* ---------------------------------------------------------- file ceiling */

test('the file ceiling is measured in bytes, not characters', () => {
  const id = 'file-bytes'
  createSession(id, 'Потолок', null)
  fs.mkdirSync(sessionDir(id), { recursive: true })

  // 800 thousand Cyrillic characters are 1.6 MB in UTF-8: over the ceiling,
  // although the `length` of such a string is clearly below it.
  const cyrillic = 'я'.repeat(800_000)
  assert.ok(cyrillic.length < 1_500_000 && Buffer.byteLength(cyrillic, 'utf8') > 1_500_000)
  assert.equal(putText(id, 'русский.txt', cyrillic), false, 'a file over the ceiling landed on disk')
  assert.equal(fs.existsSync(path.join(sessionDir(id), 'русский.txt')), false)

  // While the same number of bytes in Latin letters still passes.
  assert.equal(putText(id, 'latin.txt', 'a'.repeat(800_000)), true)
})
