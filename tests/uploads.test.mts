/**
 * An upload lands whole or not at all.
 *
 * The route used to write straight into the target file, which truncates it
 * first: a cell already reading that CSV watched it shrink to nothing and grow
 * again, read half the rows, and finished *without an error* — the worst of the
 * three possible outcomes. The same window swallowed the old file whenever an
 * upload was cut off partway through.
 *
 * Uploads now write beside the target and rename over it. Every failure path
 * removes its own temp file; the one that cannot is the process dying mid-write,
 * and what that leaves is swept here.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionDir, sweepStaleUploads } from '../server/src/workspace.js'

let seq = 0
const rooms: string[] = []
function room(): string {
  const id = `sweep${seq++}`
  rooms.push(id)
  fs.mkdirSync(sessionDir(id), { recursive: true })
  return id
}
const write = (id: string, name: string, body = 'x', ageMs = 0) => {
  const full = path.join(sessionDir(id), name)
  fs.writeFileSync(full, body)
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(full, when, when)
  }
  return full
}
const listing = (id: string) => fs.readdirSync(sessionDir(id)).sort()

after(() => {
  for (const id of rooms) fs.rmSync(sessionDir(id), { recursive: true, force: true })
})

test('a temp left by a dead process is swept', () => {
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'half a file', 2 * 60 * 60 * 1000)
  sweepStaleUploads(id)
  assert.deepEqual(listing(id), [])
})

test('an upload still in flight is left alone', () => {
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'still arriving')
  sweepStaleUploads(id)
  assert.equal(listing(id).length, 1, 'a live upload was swept out from under itself')
})

test('the room\u2019s own files are never touched', () => {
  const id = room()
  write(id, 'data.csv', 'real', 5 * 60 * 60 * 1000)
  write(id, '.gitkeep', '', 5 * 60 * 60 * 1000)
  write(id, 'notes.uploading-nope.md', 'real too', 5 * 60 * 60 * 1000)
  sweepStaleUploads(id)
  assert.deepEqual(listing(id), ['.gitkeep', 'data.csv', 'notes.uploading-nope.md'])
})

test('a seminar with no folder yet is not an error', () => {
  sweepStaleUploads('a-seminar-that-never-uploaded-anything')
})

test('the temp name is hidden from the room', async () => {
  // listFiles drops dotfiles, which is what keeps a half-arrived upload out of
  // the panel. If the temp naming ever stops starting with a dot, this fails.
  const { listFiles } = await import('../server/src/workspace.js')
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'half')
  write(id, 'data.csv', 'whole')
  assert.deepEqual(listFiles(id).map((f) => f.name), ['data.csv'])
})
