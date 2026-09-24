/**
 * Between full copies of the document, a tail goes to disk.
 *
 * A full copy of the notebook every few seconds was what the room paid for
 * simple recovery: for a two-megabyte notebook under continuous typing,
 * twenty-six megabytes a minute went into the WAL for the sake of a few
 * kilobytes of real edits. The tail — the difference from the last snapshot —
 * is written as a file next to the database, and the full copy waits for its
 * time.
 *
 * What is checked here is exactly what this deal could lose: the promise of
 * durability. The snapshot plus the tail have to add up to the whole notebook
 * — not "mostly" but character for character — and the tail itself has to
 * disappear once the full copy has landed, and when the room is deleted.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellSource, createCell, getCells, readNotebook } from '../shared/notebook.js'
import { config } from '../server/src/config.js'
import { createSession, db, loadDocSnapshot } from '../server/src/db.js'
import { flushPersistence } from '../server/src/collab/persistence.js'
import { dropSessionDoc, getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

let seq = 0
function room(): string {
  const id = `tail${seq++}`
  createSession(id, `Tail ${id}`)
  return id
}

const tailFile = (id: string) => path.join(config.dataDir, 'doc-tail', `${id}.bin`)
const snapshotAt = (id: string) =>
  (db.prepare('SELECT updated_at FROM doc_snapshots WHERE session_id = ?').get(id) as
    | { updated_at: number }
    | undefined)?.updated_at ?? 0

/** Wait until the deferred write fires (config.snapshotIntervalMs). */
const written = () => new Promise((r) => setTimeout(r, config.snapshotIntervalMs + 600))

/** What the server brings back after `kill -9`: the snapshot row plus the tail next to it. */
function afterCrash(id: string): string[] {
  const doc = new Y.Doc()
  const snapshot = loadDocSnapshot(id)
  if (snapshot) Y.applyUpdate(doc, snapshot)
  if (fs.existsSync(tailFile(id))) Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(tailFile(id))))
  const cells = readNotebook(doc).map((c) => c.source)
  doc.destroy()
  return cells
}

function typeInto(id: string, text: string): void {
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  cellSource(cell).insert(0, text)
}

test('while people type, a tail goes to disk, not a full copy', async () => {
  const id = room()
  typeInto(id, 'первая строка')
  flushPersistence(id)
  const full = snapshotAt(id)
  assert.ok(loadDocSnapshot(id), 'the full copy should have landed right away')
  assert.equal(fs.existsSync(tailFile(id)), false, 'there is no tail after a full copy')

  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(0)
  cellSource(cell).insert(cellSource(cell).length, ' и продолжение')
  await written()

  assert.ok(fs.existsSync(tailFile(id)), 'the continuation should have landed as a tail')
  assert.equal(snapshotAt(id), full, 'there was no reason to rewrite the full copy')

  const stored = new Y.Doc()
  Y.applyUpdate(stored, loadDocSnapshot(id)!)
  assert.equal(
    readNotebook(stored)[0].source,
    'первая строка',
    'the snapshot row holds the state as of the copy',
  )
  // And together with the tail, everything the room wrote.
  assert.deepEqual(afterCrash(id), ['первая строка и продолжение'])
})

test('the tail is smaller than the document: that is the whole saving', async () => {
  const id = room()
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  // A notebook the size of a real one: a hundred kilobytes of text.
  cellSource(cell).insert(0, 'x'.repeat(120 * 1024))
  flushPersistence(id)
  const size = loadDocSnapshot(id)!.byteLength

  cellSource(cell).insert(cellSource(cell).length, 'ещё одна строка')
  await written()

  const tail = fs.statSync(tailFile(id)).size
  assert.ok(size > 100 * 1024, `the notebook should be large, but it is ${size} B`)
  assert.ok(tail < size / 20, `the tail should be an order of magnitude smaller: ${tail} B against ${size} B`)
})

test('an explicit flush writes the whole room and takes the tail away', async () => {
  const id = room()
  typeInto(id, 'начало')
  flushPersistence(id)
  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(0)
  cellSource(cell).insert(cellSource(cell).length, ' и хвост')
  await written()
  assert.ok(fs.existsSync(tailFile(id)), 'the tail did not land: nothing further to check')

  flushPersistence(id)
  assert.equal(fs.existsSync(tailFile(id)), false, 'the tail is removed after a full copy')
  const stored = new Y.Doc()
  Y.applyUpdate(stored, loadDocSnapshot(id)!)
  assert.equal(readNotebook(stored)[0].source, 'начало и хвост')
})

test('a deleted room leaves no tail on disk', async () => {
  const id = room()
  typeInto(id, 'занятие')
  flushPersistence(id)
  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(0)
  cellSource(cell).insert(cellSource(cell).length, ' продолжается')
  await written()
  assert.ok(fs.existsSync(tailFile(id)), 'the tail did not land: nothing further to check')

  // The first line of the seminar deletion path: evict the document without writing anything.
  dropSessionDoc(id)
  assert.equal(fs.existsSync(tailFile(id)), false, 'the deleted room left its file on disk')
})
