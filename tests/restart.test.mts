/**
 * The server is restarted in the middle of a class.
 *
 * Not a hypothetical: a crash, a deploy and `docker compose restart` all land
 * here, and the room is thirty people who did not do anything wrong. Two things
 * used to break, both silently.
 *
 * The signing key was `crypto.randomBytes(24)` per boot, so every participant
 * token in the room stopped verifying at once. Nobody saw an error — the
 * sockets were simply refused from then on, the room went quiet, and each
 * student had to reload and retype their name to come back as a new person with
 * a new colour.
 *
 * And the first snapshot was debounced by seconds while the room was reachable
 * immediately, so a crash in that window left a seminar with a row and no
 * document. On the way back the server found nothing stored, decided the room
 * was new, and seeded the starter cells a second time — the students, who still
 * held the real notebook, then merged it in underneath a second copy of them.
 */
import './_env.mts'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { TEST_ROOT } from './_env.mts'
import {
  cellSource,
  clearStaleExecution,
  createCell,
  ensureInitialNotebook,
  getCells,
  getMeta,
  getTerminal,
} from '../shared/notebook.js'
import { createSession, loadDocSnapshot } from '../server/src/db.js'
import { dropSessionDoc, getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

/** What a student does to a starter cell: select all, then type over it. */
function retype(cell: Y.Map<unknown>, text: string): void {
  const source = cellSource(cell)
  source.delete(0, source.length)
  source.insert(0, text)
}

let seq = 0
function room(): string {
  const id = `restart${seq++}`
  createSession(id, `Restart ${id}`)
  return id
}

/* ------------------------------------------------- the room comes back */

test('a brand-new room is on disk before anyone can crash it', () => {
  const id = room()
  getSessionDoc(id)
  // No timers, no waiting: the assertion is that the window does not exist.
  assert.ok(loadDocSnapshot(id), 'the starter notebook was never written')
})

test('a restart does not seed the starter cells a second time', () => {
  const id = room()
  const { doc } = getSessionDoc(id)
  retype(getCells(doc).get(1), 'x = 1')

  // The process dies without flushing: drop the live document and rebuild it
  // the way a fresh boot does, from whatever happens to be on disk. The last
  // few seconds of typing are gone here by design — the snapshot is debounced,
  // and the next test is how the room gets them back. What must not happen is
  // the server deciding this is a new seminar.
  dropSessionDoc(id)
  const { doc: reopened } = getSessionDoc(id)
  assert.equal(getCells(reopened).length, 2, 'the room came back with extra cells')
  assert.deepEqual(
    getCells(reopened).map((cell) => cell.get('type')),
    ['markdown', 'code'],
    'the room came back with a second Welcome',
  )
})

test('the notebook a student still holds merges back without duplicating', () => {
  const id = room()
  const { doc } = getSessionDoc(id)
  retype(getCells(doc).get(1), 'answer = 42')

  // What a browser has in memory across the outage.
  const student = new Y.Doc()
  Y.applyUpdate(student, Y.encodeStateAsUpdate(doc))
  cellSource(getCells(student).get(1)).insert(11, '\nprint(answer)')

  dropSessionDoc(id)
  const { doc: reopened } = getSessionDoc(id)
  Y.applyUpdate(reopened, Y.encodeStateAsUpdate(student))

  assert.equal(getCells(reopened).length, 2, 'reconnecting duplicated the starter cells')
  assert.equal(cellSource(getCells(reopened).get(1)).toString(), 'answer = 42\nprint(answer)')
})

test('seeding reports itself exactly once', () => {
  const doc = new Y.Doc()
  assert.equal(ensureInitialNotebook(doc, 'Week 1'), true)
  assert.equal(ensureInitialNotebook(doc, 'Week 1'), false)
  assert.equal(getCells(doc).length, 2)
})

/* --------------------------------------------- the room stays signed in */

/**
 * Two boots of the real config module, with SESSION_SECRET unset so the
 * fallback is what answers. Run out of process on purpose: config resolves once
 * per process and this is a question about the *second* one.
 */
function bootSecret(dataDir: string): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./server/src/config.js').then(m => process.stdout.write(m.config.sessionSecret))"],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, DATA_DIR: dataDir, SESSION_SECRET: '', WORKSPACE_DIR: path.join(dataDir, 'ws') },
      encoding: 'utf8',
    },
  ).trim()
}

test('the signing key survives a restart, so nobody is signed out', () => {
  const dataDir = path.join(TEST_ROOT, 'boot')
  const first = bootSecret(dataDir)
  assert.ok(first.length >= 32, 'the key is too short to be worth signing with')
  assert.equal(bootSecret(dataDir), first, 'the second boot invalidated every token in every room')
})

test('the key is written where only the owner of the process can read it', () => {
  const dataDir = path.join(TEST_ROOT, 'boot-mode')
  bootSecret(dataDir)
  const mode = fs.statSync(path.join(dataDir, 'session-secret')).mode & 0o777
  assert.equal(mode, 0o600, `session-secret is ${mode.toString(8)}, readable beyond this account`)
})

test('SESSION_SECRET still wins, which is how a key is rotated', () => {
  const dataDir = path.join(TEST_ROOT, 'boot-override')
  bootSecret(dataDir)
  const forced = execFileSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./server/src/config.js').then(m => process.stdout.write(m.config.sessionSecret))"],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, DATA_DIR: dataDir, SESSION_SECRET: 'rotated-by-hand', WORKSPACE_DIR: path.join(dataDir, 'ws') },
      encoding: 'utf8',
    },
  ).trim()
  assert.equal(forced, 'rotated-by-hand')
})

/* ------------------------------------------- nothing is running any more */

/**
 * A cell that was running when the process died is in the snapshot as running.
 * Reloaded as-is it spins against a runtime that has never heard of it, and the
 * queue behind it waits on a run that no longer exists.
 */
function midRun(): Y.Doc {
  const doc = new Y.Doc()
  ensureInitialNotebook(doc, 'Week 8')
  const cells = getCells(doc)
  const meta = getMeta(doc)
  const second = createCell('code', 'time.sleep(600)')
  cells.push([second])
  doc.transact(() => {
    cells.get(1).set('state', 'running')
    second.set('state', 'queued')
    meta.set('kernelStatus', 'busy')
    meta.set('runningCell', cells.get(1).get('id'))
    const queue = new Y.Array<string>()
    queue.push([second.get('id') as string])
    meta.set('queue', queue)
  })
  return doc
}

test('a cell left running comes back at rest', () => {
  const doc = midRun()
  assert.equal(clearStaleExecution(doc), 2, 'the running cell and the queued one both count')
  const cells = getCells(doc)
  assert.equal(cells.get(1).get('state'), 'idle')
  assert.equal(cells.get(2).get('state'), 'idle')
  assert.equal(getMeta(doc).get('runningCell'), null)
  assert.equal((getMeta(doc).get('queue') as Y.Array<string>).length, 0)
  assert.equal(getMeta(doc).get('kernelStatus'), 'idle')
})

test('what the cell printed before the crash is kept', () => {
  const doc = midRun()
  const cell = getCells(doc).get(1)
  const outputs = cell.get('outputs') as Y.Array<unknown>
  doc.transact(() => outputs.push([{ kind: 'stream', name: 'stdout', text: 'epoch 3\n' }]))
  clearStaleExecution(doc)
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 1, 'the evidence of how far it got was deleted')
})

test('a room where nothing was running is not touched', () => {
  const doc = new Y.Doc()
  ensureInitialNotebook(doc, 'Week 9')
  getMeta(doc).set('kernelStatus', 'idle')
  assert.equal(clearStaleExecution(doc), 0)
  assert.equal(getMeta(doc).get('kernelStatus'), 'idle')
})

test('a finished cell keeps its verdict', () => {
  const doc = new Y.Doc()
  ensureInitialNotebook(doc, 'Week 10')
  const cells = getCells(doc)
  doc.transact(() => {
    cells.get(1).set('state', 'error')
    cells.push([createCell('code', 'ok()')])
    cells.get(2).set('state', 'ok')
  })
  assert.equal(clearStaleExecution(doc), 0)
  assert.equal(cells.get(1).get('state'), 'error')
  assert.equal(cells.get(2).get('state'), 'ok')
})

test('the room is told, once, when it comes back', () => {
  const id = room()
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  doc.transact(() => {
    cells.get(1).set('state', 'running')
    getMeta(doc).set('runningCell', cells.get(1).get('id'))
  })
  // The whole process goes down with a cell running, and comes back up.
  shutdownCollab()

  const { doc: reopened } = getSessionDoc(id)
  const notes = getTerminal(reopened)
    .toArray()
    .filter((line) => line.get('kind') === 'system')
    .map((line) => String(line.get('text')))
  assert.equal(notes.length, 1, `expected one line, got ${notes.length}`)
  assert.match(notes[0], /перезапустился/i)
})
