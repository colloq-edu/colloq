/**
 * The last edits of a room survive a database that refuses them, and the disk
 * never mixes the room with something it is not.
 *
 * Four ways the 3 Nov 2026 audit found to lose or corrupt a notebook, each
 * pinned down here through the real doors — the release of an idle room, a
 * room deletion, an open after a restore:
 *
 *  - a room left memory while its last write was failing (a full disk, a
 *    read-only database): the binding was removed before the write, so the
 *    write's retry had nothing to retry for, and the document was destroyed;
 *  - a tail applied to a snapshot it does not belong to — an older database
 *    restored under the tails of a newer one opened as "the backup plus what
 *    was written after it";
 *  - a room deleted before anyone opened it since a restart kept its tail on
 *    disk;
 *  - nothing removed the tails of rooms that no longer exist.
 */
import './_env.mts'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { config } from '../server/src/config.js'
import { createSession, db, loadDocSnapshot, saveDocSnapshot } from '../server/src/db.js'
import {
  flushAllPersistence,
  flushPersistence,
  persistenceDiagnostics,
  readPersisted,
  sweepOrphanTails,
} from '../server/src/collab/persistence.js'
import {
  dropSessionDoc,
  getSessionDoc,
  peekSessionDoc,
  releaseSessionDoc,
  shutdownCollab,
  sweepIdleRooms,
} from '../server/src/collab/index.js'
import { cellSource, createCell, getCells, readNotebook } from '../shared/notebook.js'

after(() => shutdownCollab())

const tailDir = () => path.join(config.dataDir, 'doc-tail')
const tailFile = (id: string) => path.join(tailDir(), `${id}.bin`)

/** The room's notebook as one string per cell, read from a live or a fresh document. */
function texts(doc: Y.Doc): string[] {
  return readNotebook(doc).map((cell) => cell.source)
}

/** Replace the notebook with one code cell holding `text`. */
function typeInto(id: string, text: string): void {
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  doc.transact(() => {
    cells.delete(0, cells.length)
    const cell = createCell('code', '')
    cells.push([cell])
    cellSource(cell).insert(0, text)
  })
}

/** What the next open would load, without opening the room. */
function onDisk(id: string): string[] {
  const doc = new Y.Doc()
  const { snapshot, tail } = readPersisted(id)
  if (snapshot) Y.applyUpdate(doc, snapshot)
  if (tail) Y.applyUpdate(doc, tail)
  const cells = texts(doc)
  doc.destroy()
  return cells
}

/** The database answers every write with SQLITE_READONLY while `run` works. */
function readOnlyDatabase<T>(run: () => T): T {
  db.pragma('query_only = ON')
  try {
    return run()
  } finally {
    db.pragma('query_only = OFF')
  }
}

/** Tail files cannot be renamed into place either: the disk refuses too. */
function failingTails() {
  const rename = fs.renameSync
  return mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]).includes(`${path.sep}doc-tail${path.sep}`)) {
      throw Object.assign(new Error('test ENOSPC'), { code: 'ENOSPC' })
    }
    return rename(...args)
  })
}

test('a room released while the database refuses writes keeps its edits in a tail file', () => {
  const id = 'durable-spill'
  createSession(id, 'Spill', null)
  typeInto(id, 'saved')
  flushPersistence(id)
  typeInto(id, 'unsaved edit')
  const quiet = mock.method(console, 'error', () => {})
  try {
    const released = readOnlyDatabase(() => releaseSessionDoc(id))
    assert.equal(released, true, 'a tail file was enough to let the room go')
  } finally {
    quiet.mock.restore()
  }
  assert.equal(peekSessionDoc(id), null)
  assert.ok(fs.existsSync(tailFile(id)), 'the edit was spilled past the database')
  assert.deepEqual(onDisk(id), ['unsaved edit'])
  assert.deepEqual(texts(getSessionDoc(id).doc), ['unsaved edit'], 'the next open lost the edit')
  assert.equal(releaseSessionDoc(id), true)
})

test('a room whose edits reach no disk at all stays in memory until they do', () => {
  const id = 'durable-stay'
  createSession(id, 'Stay', null)
  typeInto(id, 'saved')
  flushPersistence(id)
  typeInto(id, 'unsaved edit')
  const quiet = mock.method(console, 'error', () => {})
  const fault = failingTails()
  try {
    readOnlyDatabase(() => {
      assert.equal(releaseSessionDoc(id), false, 'the room left with its edits nowhere')
      assert.deepEqual(sweepIdleRooms(Date.now() + 24 * 60 * 60 * 1000), [], 'the idle sweep let it go too')
      assert.deepEqual(flushAllPersistence(), [id], 'shutdown would not name the room it is losing')
    })
    assert.deepEqual(texts(peekSessionDoc(id)!.doc), ['unsaved edit'], 'the document in memory is intact')
    assert.ok(persistenceDiagnostics().dirtyDocuments >= 1, 'the diagnostics forgot the unsaved room')
  } finally {
    fault.mock.restore()
    quiet.mock.restore()
  }

  // The disk is back: the very next release writes the room and lets it go.
  assert.equal(releaseSessionDoc(id), true)
  assert.equal(peekSessionDoc(id), null)
  assert.deepEqual(onDisk(id), ['unsaved edit'])
  assert.deepEqual(texts(getSessionDoc(id).doc), ['unsaved edit'])
  assert.equal(releaseSessionDoc(id), true)
})

test('a tail written against another snapshot is not applied: a restored database opens as it was', () => {
  const id = 'durable-restore'
  createSession(id, 'Restore', null)
  typeInto(id, 'backup')
  flushPersistence(id)
  const backup = loadDocSnapshot(id)!

  // The class goes on: a newer full copy, then edits that land as a tail of it.
  typeInto(id, 'newer')
  flushPersistence(id)
  typeInto(id, 'newer, and the tail')
  const quiet = mock.method(console, 'error', () => {})
  try {
    readOnlyDatabase(() => assert.equal(releaseSessionDoc(id), true))
  } finally {
    quiet.mock.restore()
  }
  assert.ok(fs.existsSync(tailFile(id)))

  // The operator restores yesterday's database; the tail folder stays as it was.
  saveDocSnapshot(id, backup)

  const warned: string[] = []
  const warn = mock.method(console, 'warn', (...args: unknown[]) => warned.push(args.map(String).join(' ')))
  try {
    assert.deepEqual(texts(getSessionDoc(id).doc), ['backup'], 'the restore picked up a newer tail')
  } finally {
    warn.mock.restore()
  }
  assert.ok(warned.some((line) => line.includes('[persistence]') && line.includes(id)), 'the refusal was silent')
  assert.equal(fs.existsSync(tailFile(id)), false, 'the foreign tail stayed to be asked about again')
  assert.equal(releaseSessionDoc(id), true)
})

test('a tail from before the mark is still applied, once', () => {
  const id = 'durable-legacy'
  createSession(id, 'Legacy', null)
  typeInto(id, 'snapshot')
  flushPersistence(id)
  assert.equal(releaseSessionDoc(id), true)

  // What 0.30.1 wrote: a bare Yjs update, the difference from the snapshot row.
  const stored = new Y.Doc()
  Y.applyUpdate(stored, loadDocSnapshot(id)!)
  const before = Y.encodeStateVector(stored)
  const cell = getCells(stored).get(0)
  cellSource(cell).insert(cellSource(cell).length, ' and the legacy tail')
  fs.mkdirSync(tailDir(), { recursive: true })
  fs.writeFileSync(tailFile(id), Y.encodeStateAsUpdate(stored, before))
  stored.destroy()

  assert.deepEqual(texts(getSessionDoc(id).doc), ['snapshot and the legacy tail'])
  assert.equal(releaseSessionDoc(id), true)
  assert.equal(fs.existsSync(tailFile(id)), false, 'the release folds the tail into a full copy')
})

test('deleting a room nobody has opened since the restart removes its tail too', () => {
  const id = 'durable-cold-delete'
  createSession(id, 'Cold delete', null)
  typeInto(id, 'saved')
  flushPersistence(id)
  typeInto(id, 'spilled')
  const quiet = mock.method(console, 'error', () => {})
  try {
    readOnlyDatabase(() => assert.equal(releaseSessionDoc(id), true))
  } finally {
    quiet.mock.restore()
  }
  assert.ok(fs.existsSync(tailFile(id)), 'no tail to delete: the test checks nothing')
  assert.equal(peekSessionDoc(id), null)

  dropSessionDoc(id)
  assert.equal(fs.existsSync(tailFile(id)), false, 'the deleted room left its tail behind')
})

test('the startup sweep removes tails of rooms that no longer exist, and leftovers of unfinished writes', () => {
  const kept = 'durable-sweep-kept'
  createSession(kept, 'Kept', null)
  typeInto(kept, 'saved')
  flushPersistence(kept)
  typeInto(kept, 'spilled')
  const quiet = mock.method(console, 'error', () => {})
  try {
    readOnlyDatabase(() => assert.equal(releaseSessionDoc(kept), true))
  } finally {
    quiet.mock.restore()
  }
  fs.writeFileSync(tailFile('durable-sweep-gone'), new Uint8Array([1, 2, 3]))
  const unfinished = `${tailFile(kept)}.99999999.tmp`
  fs.writeFileSync(unfinished, new Uint8Array([1, 2, 3]))

  const said = mock.method(console, 'log', () => {})
  try {
    assert.equal(sweepOrphanTails(), 2)
  } finally {
    said.mock.restore()
  }
  assert.equal(fs.existsSync(tailFile('durable-sweep-gone')), false)
  assert.equal(fs.existsSync(unfinished), false)
  assert.ok(fs.existsSync(tailFile(kept)), 'the sweep removed the tail of a room that exists')
  assert.deepEqual(onDisk(kept), ['spilled'])
})
