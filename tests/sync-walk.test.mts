/**
 * A reconnect is not an edit, and the gate must survive it.
 *
 * On every entry the browser offers the server everything the server does not
 * have (step2), and this "everything" includes the document's ENTIRE delete
 * set — forever, because the delete set never shrinks. Two breakages here cost
 * a live room an evening: walking the deleted content one clock at a time hit
 * the cap after nine cleared Oracle feeds, and keystrokes with a gap before
 * them hung in the document and travelled back and forth in every step2. Both
 * show only at real volume, so the numbers below come from that room.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { WebSocket } from 'ws'
import { classify, MAX_SYNC_STEP2_BYTES } from '../server/src/collab/gate.js'
import { createSession, loadDocSnapshot, saveDocSnapshot } from '../server/src/db.js'
import { getSessionDoc, handleCollabSocket, shutdownCollab } from '../server/src/collab/index.js'
import { flushPersistence } from '../server/src/collab/persistence.js'
import { createChatEntry, getCells, getChat } from '../shared/notebook.js'

after(() => shutdownCollab())

/** A tab in sync with the server. */
function tabOf(server: Y.Doc): Y.Doc {
  const tab = new Y.Doc()
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(server))
  return tab
}

/** What the tab will offer the server on entry. */
function step2(tab: Y.Doc, server: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(tab, Y.encodeStateVector(server))
}

function sourceOf(doc: Y.Doc, i: number): Y.Text {
  return (getCells(doc).get(i) as Y.Map<unknown>).get('source') as Y.Text
}

/**
 * A frame with a gap: the tab typed "a" and "b" but gives the server only
 * "b". That is what a keystroke looks like when it arrives right after a
 * refused frame of the same client. "b" is put at the end of the text so that
 * it refers to something the server knows — otherwise the refusal would come
 * earlier and for another reason.
 */
function holed(server: Y.Doc): { tab: Y.Doc; frame: Uint8Array } {
  const tab = tabOf(server)
  const text = sourceOf(tab, 1)
  tab.transact(() => text.insert(0, 'a'))
  const afterA = Y.encodeStateVector(tab)
  tab.transact(() => text.insert(text.length, 'b'))
  return { tab, frame: Y.encodeStateAsUpdate(tab, afterA) }
}

/* ------------------------------------------------------------ delete set */

test('a cleared feed does not lock the room: the reconnect goes through', () => {
  createSession('walk-gc', 'Лента', null)
  const { doc: server } = getSessionDoc('walk-gc')
  /*
   * One Oracle answer of a hundred and fifty thousand characters, cleared by
   * a ban. After the entry is deleted, its text is garbage-collected into one
   * piece of the same length, and walking "by clock" would cost one and a half
   * MAX_WALK caps here. In the live room there were 432 such pieces over 122
   * thousand clocks.
   */
  const entry = createChatEntry({ participantId: 'p_x', name: 'X', color: '#000', question: 'q' })
  server.transact(() => {
    getChat(server).push([entry])
    entry.set('answer', new Y.Text('x'.repeat(150_000)))
  }, 'server')
  server.transact(() => getChat(server).delete(0, 1), 'server')

  const tab = tabOf(server)
  const frame = step2(tab, server)
  const ds = (Y.decodeUpdate(frame) as unknown as { ds: { clients: Map<number, { len: number }[]> } })
    .ds
  let span = 0
  for (const ranges of ds.clients.values()) for (const r of ranges) span += r.len
  assert.ok(span >= 150_000, `the delete set is too small for the check: ${span}`)

  const judged = classify(server, frame, MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, true, judged.ok ? '' : `${judged.why} (${judged.path})`)
  if (judged.ok) assert.deepEqual(judged.verdicts, [], 'an in-sync tab is "doing" something')
})

test('a big room reconnects even when the tab offers the whole document', () => {
  /*
   * The walk cap was constant — a hundred thousand steps — while the delete
   * set is walked by structure and grows with every class. In the live room
   * zxrrsac6 (35 thousand structs) an in-sync tab cost 55 thousand steps, and
   * a tab that offered the whole document anew cost more than a hundred
   * thousand, and got "frame too large" on every entry. Here is the same
   * shape: forty thousand keystrokes at the start of the text (this way they
   * do not merge into one struct), and half of them erased.
   */
  createSession('walk-big', 'Большая', null)
  // A copy without the room's observers: forty thousand transactions through
  // history and disk writes would take minutes, and the gate needs only the
  // document itself.
  const server = tabOf(getSessionDoc('walk-big').doc)
  const text = sourceOf(server, 1)
  for (let i = 0; i < 40_000; i++) server.transact(() => text.insert(0, 'x'), 'server')
  for (let i = 0; i < 20_000; i++) server.transact(() => text.delete(i, 1), 'server')

  const tab = tabOf(server)
  const judged = classify(server, Y.encodeStateAsUpdate(tab), MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, true, judged.ok ? '' : `${judged.why} (${judged.path})`)
  if (judged.ok) assert.deepEqual(judged.verdicts, [], 'an in-sync tab is "doing" something')
})

/* ------------------------------------------------------------------ gaps */

test('a frame with a gap in keystrokes is refused, not left hanging', () => {
  createSession('walk-hole', 'Дыра', null)
  const { doc: server } = getSessionDoc('walk-hole')
  const { frame } = holed(server)

  // This is what Yjs would do without the refusal: accept it and leave it
  // hanging forever.
  const naive = tabOf(server)
  Y.applyUpdate(naive, frame)
  assert.ok(
    (naive.store as unknown as { pendingStructs: unknown }).pendingStructs,
    'the frame has no gap — the check checks nothing',
  )

  const judged = classify(server, frame)
  assert.equal(judged.ok, false)
  if (!judged.ok) assert.match(judged.why, /продолжает нажатия/)
})

test('consecutive keystrokes are not a gap', () => {
  createSession('walk-run', 'Подряд', null)
  const { doc: server } = getSessionDoc('walk-run')
  const tab = tabOf(server)
  const before = Y.encodeStateVector(tab)
  const text = sourceOf(tab, 1)
  tab.transact(() => {
    text.insert(text.length, 'a')
    text.insert(text.length, 'b')
    text.insert(0, 'c')
  })
  const judged = classify(server, Y.encodeStateAsUpdate(tab, before))
  assert.equal(judged.ok, true, judged.ok ? '' : `${judged.why} (${judged.path})`)
})

test('content left hanging in the tab cache is refused on entry, and only that', () => {
  /*
   * A tab that got a step2 with hanging content from the previous server keeps
   * it and offers it back. Yjs writes such a difference with an explicit gap
   * (Skip) — it is the same hole, and the answer is the same.
   */
  createSession('walk-skip', 'Пропуск', null)
  const { doc: server } = getSessionDoc('walk-skip')
  const { frame } = holed(server)
  const tab = tabOf(server)
  Y.applyUpdate(tab, frame)
  const judged = classify(server, step2(tab, server), MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, false)
  if (!judged.ok) assert.match(judged.why, /пропуском|продолжает нажатия/)
})

/* -------------------------------------------------------------- snapshot */

test('hanging content in a snapshot is thrown away on load, and the snapshot is rewritten clean', () => {
  createSession('walk-pending', 'Снимок', null)
  const seed = getSessionDoc('walk-pending').doc
  // A snapshot as the server would have written it before gaps were checked:
  // the document plus the hanging content.
  const dirty = tabOf(seed)
  Y.applyUpdate(dirty, holed(seed).frame)
  assert.ok((dirty.store as unknown as { pendingStructs: unknown }).pendingStructs)
  shutdownCollab()
  saveDocSnapshot('walk-pending', Y.encodeStateAsUpdate(dirty))

  const { doc: server } = getSessionDoc('walk-pending')
  assert.equal(
    (server.store as unknown as { pendingStructs: unknown }).pendingStructs,
    null,
    'the hanging content came up together with the room',
  )
  // A tab gets a clean document from such a server — and its step2 is empty.
  const judged = classify(server, step2(tabOf(server), server), MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, true)

  // And what goes to disk is already clean — otherwise every restart would
  // bring the garbage back up.
  flushPersistence('walk-pending')
  const again = new Y.Doc()
  Y.applyUpdate(again, loadDocSnapshot('walk-pending')!)
  assert.equal(
    (again.store as unknown as { pendingStructs: unknown }).pendingStructs,
    null,
    'the snapshot on disk still carries hanging content',
  )
})

/* --------------------------------------------------------------- socket */

interface Fake {
  ws: WebSocket
  fire(event: string, ...args: unknown[]): void
  closedWith: { code?: number; reason?: string } | null
}

/** Exactly what handleCollabSocket reads — and the word it was closed with. */
function socket(): Fake {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const out: Fake = {
    ws: null as unknown as WebSocket,
    fire(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    closedWith: null,
  }
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    send() {},
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close(code?: number, reason?: string) {
      fake.readyState = WebSocket.CLOSED
      out.closedWith ??= { code, reason }
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  out.ws = fake as unknown as WebSocket
  return out
}

function syncFrame(write: (encoder: encoding.Encoder) => void): Buffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0) // MESSAGE_SYNC
  write(encoder)
  return Buffer.from(encoding.toUint8Array(encoder))
}

test('a refused first sync closes the socket with the word "stale", a refused edit with the rule', () => {
  createSession('walk-word', 'Слово', null)
  const { doc: server } = getSessionDoc('walk-word')
  const warned: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '))
  try {
    const { frame } = holed(server)

    const entering = socket()
    handleCollabSocket(entering.ws, 'walk-word', 'participant', 'p_one')
    entering.fire(
      'message',
      syncFrame((encoder) => {
        encoding.writeVarUint(encoder, 1) // step2
        encoding.writeVarUint8Array(encoder, frame)
      }),
    )
    assert.deepEqual(entering.closedWith, { code: 4403, reason: 'stale' })

    const typing = socket()
    handleCollabSocket(typing.ws, 'walk-word', 'participant', 'p_two')
    typing.fire(
      'message',
      syncFrame((encoder) => syncProtocol.writeUpdate(encoder, frame)),
    )
    assert.deepEqual(typing.closedWith, { code: 4403, reason: 'edit' })
  } finally {
    console.warn = original
  }
  // The journal gets the gate's reason in words and with the path, not one
  // generic phrase about the cache.
  const line = warned.find((w) => w.includes('[gate walk-word]'))
  assert.ok(line, 'the refusal did not make it to the journal')
  assert.match(line!, /продолжает нажатия.*\(cells#\d+\)/)
})
