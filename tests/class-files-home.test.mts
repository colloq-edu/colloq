/**
 * A class folder on a machine, at home (docs/architecture/remote-classes.md
 * §8; server/src/kernel/remote/files.ts, with the doors it adds to
 * competitions/remote/{routes,blobs,upload}.ts): the barrier and its counter
 * fast path, the walk and the diff, moves, inline files and blobs, the words
 * of a run waiting at the barrier and its stall, the compare-and-swap of §8.4
 * row by row, the caps, package rows, «Привезти», the rebuild from a full
 * report, the PUT door's fence, and the anchored writes.
 *
 * Every rule here fails without a word. A barrier that walks for every Run
 * puts a folder walk on every cell of every class; one that never pushes runs
 * the cell on yesterday's file; a CAS that lets the machine win erases what
 * the teacher just saved, and one that lets a delete come back resurrects a
 * dataset someone removed on purpose; a late PUT of a fenced gen writes into
 * a class its machine no longer holds; a symlinked folder walks a machine's
 * bytes out of the class folder.
 *
 * No agent and no Docker: the machine's half is its sync blocks and its PUTs
 * in the contract's shapes, and the files' clock is moved by hand.
 */
import './_env.mts'
import { after, beforeEach, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import { tr } from '../shared/i18n.js'
import {
  CLASS_BARRIER_MS,
  CLASS_BARRIER_STALL_MS,
  CLASS_INLINE_BYTES,
  CLASS_INLINE_PUSH_BYTES,
  REMOTE_DIR_BASE,
  remoteClassPaths,
  type RemoteClassFacts,
  type RemoteFilesReport,
  type RemoteKernelsRequest,
  type RemotePlacementHeld,
} from '../shared/remote-kernels.js'
import { REMOTE_BYTES_HEADER, REMOTE_SHA256_HEADER, parseRemoteSyncReply } from '../shared/remote-runner.js'
import type { TunnelClock } from '../shared/remote-tunnel.js'
import type { ControlServerMessage, FileEntry } from '../shared/protocol.js'
import { CELLS_KEY, cellId, cellSource, cellType, createCell, getCells } from '../shared/notebook.js'
import { WebSocket } from 'ws'
import { dispatch } from '../server/src/control.js'
import { config } from '../server/src/config.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, peekSessionDoc, releaseSessionDoc } from '../server/src/collab/index.js'
import { createBook } from '../server/src/collab/books.js'
import { updateClassMachineSettings, updateResourceSettings } from '../server/src/admin/resource-settings.js'
import { mintRemoteCode } from '../server/src/competitions/remote/store.js'
import { noteCall, resetHeard, useClassPort, type ClassPort } from '../server/src/competitions/remote/heard.js'
import { heldSyncs, wakeRunner } from '../server/src/competitions/remote/wake.js'
import { PACE_BURST_BYTES, Pace, resetBlobBucket } from '../server/src/competitions/remote/blobs.js'
import { interruptSession, requestRun, shutdownSession, useClassPlacements, type ClassPlacements, type PlacementEvent } from '../server/src/kernel/index.js'
import { useDefaultEndpointForTest } from '../server/src/kernel/jupyter.js'
import { writePlacement, updatePlacement } from '../server/src/kernel/remote/placement-store.js'
import { ClassFiles, FilesStalled, PACKAGES_ROW, conflictCopyName, movingWords, useClassFiles } from '../server/src/kernel/remote/files.js'
import { buildAndWrite, refreshPage } from '../server/src/publish/materials.js'
import { deleteFile, forgetTree, movePath, roomTree, sessionDir, sweepStaleUploads, tempNameIn, treeDelta, writeText } from '../server/src/workspace.js'
import { startFakeJupyter } from './_fake-jupyter.mjs'
import { guardAnswer } from './_guard.mts'
import { Machine, close, code as _code, reset, serve, syncRequest } from './_remote.mts'

void _code

let fakeJupyter: Awaited<ReturnType<typeof startFakeJupyter>> | null = null

after(async () => {
  useClassFiles(null)
  useClassPort(null)
  close()
  await fakeJupyter?.close()
})

/* -------------------------------------------------------------- the rig */

/** A clock the test moves: timers run when it passes them, never on their own. */
class FakeClock implements TunnelClock {
  t = Date.now()
  private next = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()
  now(): number {
    return this.t
  }
  setTimeout(run: () => void, ms: number): unknown {
    const id = this.next++
    this.timers.set(id, { at: this.t + ms, run })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }
  advance(ms: number): void {
    this.t += ms
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.t) continue
      this.timers.delete(id)
      timer.run()
    }
  }
}

/** The machine's bounds the resource settings are clamped into (admin/resource-settings.ts · updateResourceSettings). */
const BOUNDS = { memory: { min: 512, max: 65_536 }, cpus: { min: 1, max: 16 } }
const FACTS: RemoteClassFacts = { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false }
const C1 = 'c'.repeat(64)
const REVISION = `sha256:${'a'.repeat(64)}`
const sha = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')
const b64 = (content: string): string => Buffer.from(content).toString('base64')

interface Rig {
  files: ClassFiles
  clock: FakeClock
  notes: string[]
  changed: string[]
  books: Set<string>
  reprojected: string[]
  woken: string[]
}

let rigged: Rig

function rig(): Rig {
  const clock = new FakeClock()
  const notes: string[] = []
  const changed: string[] = []
  const books = new Set<string>()
  const reprojected: string[] = []
  const woken: string[] = []
  const files = new ClassFiles({
    clock,
    wake: (runnerId) => woken.push(runnerId),
    log: () => undefined,
    seqBase: 100,
    hooks: {
      note: (_sessionId, text) => notes.push(text),
      changed: (sessionId) => changed.push(sessionId),
      isBook: (_sessionId, where) => books.has(where),
      reproject: (sessionId) => reprojected.push(sessionId),
    },
  })
  useClassFiles(files)
  return { files, clock, notes, changed, books, reprojected, woken }
}

beforeEach(() => {
  // A life of the machines' side that began a while ago: rows written now are this life's (a fresh copy).
  resetHeard(Date.now() - 60_000)
  updateClassMachineSettings({ machineFileMb: null })
  updateResourceSettings({ uploadMb: null, sessionMb: null }, BOUNDS)
  resetBlobBucket()
  rigged = rig()
})

let seq = 0

/** A class with a folder, and its room slot placed on `runnerId` (ready, written now unless `createdAt` says otherwise). */
function classOn(runnerId: string, options: { createdAt?: number; role?: 'room' | 'own' } = {}): { id: string; gen: number; dir: string } {
  const id = `cf${++seq}${randomUUID().slice(0, 6)}`
  createSession(id, `Files ${seq}`, 'base')
  return { id, gen: placeOn(id, runnerId, options).gen, dir: sessionDir(id) }
}

/** The class's slot placed on `runnerId`, ready: a new gen of it when one was placed before (placement-store.ts · writePlacement). */
function placeOn(id: string, runnerId: string, options: { createdAt?: number; role?: 'room' | 'own' } = {}) {
  return writePlacement({
    sessionId: id, role: options.role ?? 'room', runnerId, state: 'ready', environment: 'base',
    revision: { id: 'rev', ref: 'ghcr.io/x@sha256:' + 'b'.repeat(64), layers: 'l'.repeat(64) },
    memoryMb: 512, cpus: 1, gpu: null, workers: null, container: C1, readyAt: Date.now(), endedAt: null, reason: null,
    createdAt: options.createdAt ?? Date.now(),
  })
}

const machineName = (): string => `m-${randomUUID().slice(0, 6)}`

/** Let the event loop turn once: what was going to happen without a timer has happened by then. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Poll for something a real kernel or socket does in its own time (never a timer of the files' clock). */
async function until(what: () => boolean, polls = 400): Promise<boolean> {
  for (let poll = 0; poll < polls; poll++) {
    if (what()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return what()
}

/** The bytes as the PUT door stages them (upload.ts · receiveRoomFile): a temporary name at the top of the class folder. */
function staged(dir: string, content: Buffer | string): string {
  const tmp = tempNameIn(dir)
  fs.writeFileSync(tmp, content)
  return tmp
}

function put(dir: string, rel: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content)
}

function held(sessionId: string, gen: number, pushSeq: number, role: 'room' | 'own' = 'room'): RemotePlacementHeld {
  return { key: `${sessionId}:${role}`, gen, phase: 'ready', container: C1, revision: REVISION, files: { pushSeq, pending: 0, pendingBytes: 0, heldOnly: 0, heldOnlyBytes: 0 } }
}

function block(over: Partial<RemoteKernelsRequest> = {}): RemoteKernelsRequest {
  return { placements: [], reports: [], epochs: [], readings: [], tunnel: 'up', classes: FACTS, ...over }
}

/** The machine says it applied pushes up to `pushSeq` (its held placement's files lag). */
async function ack(machine: string, klass: { id: string; gen: number }, pushSeq: number): Promise<void> {
  rigged.files.noteKernelsBlock(machine, block({ placements: [held(klass.id, klass.gen, pushSeq)] }))
  await rigged.files.whenIdle()
}

let reportSeq = 0

function report(klass: { id: string; gen: number }, over: Partial<RemoteFilesReport> = {}): RemoteFilesReport {
  return { sessionId: klass.id, gen: klass.gen, seq: ++reportSeq, changed: [], removed: [], skipped: [], ...over }
}

async function says(machine: string, ...reports: RemoteFilesReport[]): Promise<void> {
  rigged.files.noteKernelsBlock(machine, block({ reports }))
  await rigged.files.whenIdle()
}

/** Let the eager push run: its timers, then its walk. */
async function eager(): Promise<void> {
  rigged.clock.advance(1_000)
  await rigged.files.whenIdle()
}

/** The newest push of the class in the machine's next reply. */
function pushOf(machine: string, sessionId: string) {
  return rigged.files.replyBlock(machine).pushes.find((one) => one.sessionId === sessionId) ?? null
}

/** The copy made and its first (full) push acked: a copy in step with this server. */
async function inStep(machine: string, klass: { id: string; gen: number }): Promise<number> {
  rigged.files.replyBlock(machine)
  await eager()
  const push = pushOf(machine, klass.id)
  assert.ok(push, 'a fresh copy is pushed')
  rigged.files.replySent(machine, rigged.files.replyBlock(machine))
  await ack(machine, klass, push.seq)
  return push.seq
}

const read = (dir: string, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8')
  } catch {
    return null
  }
}

/* ------------------------------------------------------- home → machine */

test('a fresh copy is pushed whole: every folder and file, small ones inline, larger ones by hash', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'notes.txt', 'hello')
  put(klass.dir, 'data/big.bin', Buffer.alloc(CLASS_INLINE_BYTES + 1, 7))
  rigged.files.replyBlock(machine)
  await eager()
  const push = pushOf(machine, klass.id)
  assert.ok(push)
  assert.equal(push.full, true, 'the first push of a placement made in this life describes the whole folder')
  const byPath = new Map(push.put.map((entry) => [entry.path, entry]))
  assert.deepEqual(byPath.get('data'), { path: 'data', dir: true })
  assert.equal(byPath.get('notes.txt')?.inline, b64('hello'))
  assert.equal(byPath.get('notes.txt')?.sha256, sha('hello'))
  const big = byPath.get('data/big.bin')
  assert.equal(big?.inline, undefined, 'over CLASS_INLINE_BYTES it goes as a blob')
  assert.equal(big?.bytes, CLASS_INLINE_BYTES + 1)
  // The blob is the machine's to fetch while the push is unacked, and nobody else's.
  assert.equal(rigged.files.blobFor(machine, big!.sha256!)?.path, 'data/big.bin')
  assert.equal(rigged.files.blobFor('another-machine', big!.sha256!), null)
  await ack(machine, klass, push.seq)
  assert.equal(rigged.files.blobFor(machine, big!.sha256!), null, 'acked: out of the machine\'s scope')
  assert.equal(pushOf(machine, klass.id), null, 'acked: no push in the next reply')
})

test('the counter fast path: nothing written since the acked push and a fresh walk is no walk, no push, no round trip', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'a.py', 'x = 1\n')
  await inStep(machine, klass)
  // A barrier walks once (the copy's walk is the eager push's), then passes on the counter.
  await rigged.files.filesBarrier(klass.id, machine)
  const walks = rigged.files.counts.walks
  const woken = rigged.woken.length
  for (let i = 0; i < 5; i++) await rigged.files.filesBarrier(klass.id, machine)
  assert.equal(rigged.files.counts.walks, walks, 'no walk')
  assert.equal(rigged.woken.length, woken, 'no round trip')
  // A walk older than FRESH_WALK_MS is walked again: a writer that forgets no tree (a kernel here) is caught within it.
  rigged.clock.advance(11_000)
  await rigged.files.filesBarrier(klass.id, machine)
  assert.equal(rigged.files.counts.walks, walks + 1)
  assert.equal(pushOf(machine, klass.id), null, 'and an empty diff pushes nothing')
})

test('walk and diff: a 10 KB edit is one push of that file; the run waits for its ack, promoted, and goes on', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'a.py', 'x = 1\n')
  put(klass.dir, 'b.py', 'y = 2\n')
  await inStep(machine, klass)
  const edit = 'z'.repeat(10 * 1024)
  assert.ok(writeText(klass.id, 'a.py', edit))
  let passed = false
  const barrier = rigged.files.filesBarrier(klass.id, machine).then(() => {
    passed = true
  })
  await rigged.files.whenIdle()
  await new Promise((resolve) => setImmediate(resolve))
  const push = pushOf(machine, klass.id)
  assert.ok(push)
  assert.equal(push.full, false)
  assert.equal(push.promoted, true, 'a push a run waits on is promoted')
  assert.deepEqual(push.put.map((entry) => entry.path), ['a.py'], 'only what changed')
  assert.equal(push.put[0]!.inline, b64(edit))
  assert.deepEqual(push.remove, [])
  assert.equal(passed, false, 'the run waits for the ack')
  await ack(machine, klass, push.seq)
  await barrier
  assert.equal(passed, true)
})

test('a run never waits for the room\'s notebook files: they follow its push in the background', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'lesson.ipynb', '{"cells":[]}')
  put(klass.dir, 'a.py', 'x = 1\n')
  await inStep(machine, klass)
  rigged.books.add('lesson.ipynb')
  assert.ok(writeText(klass.id, 'lesson.ipynb', '{"cells":[{"outputs":[1]}]}'))
  assert.ok(writeText(klass.id, 'a.py', 'x = 2\n'))
  const barrier = rigged.files.filesBarrier(klass.id, machine)
  await rigged.files.whenIdle()
  await new Promise((resolve) => setImmediate(resolve))
  const push = pushOf(machine, klass.id)!
  assert.deepEqual(push.put.map((entry) => entry.path), ['a.py'], 'the run waits for its own files only')
  await ack(machine, klass, push.seq)
  await barrier
  await eager()
  const after = pushOf(machine, klass.id)!
  assert.deepEqual(after.put.map((entry) => entry.path), ['lesson.ipynb'])
  // Only a notebook changed: the run passes at once, and the notebook follows.
  await ack(machine, klass, after.seq)
  assert.ok(writeText(klass.id, 'lesson.ipynb', '{"cells":[{"outputs":[2]}]}'))
  await rigged.files.filesBarrier(klass.id, machine)
  await eager()
  assert.deepEqual(pushOf(machine, klass.id)!.put.map((entry) => entry.path), ['lesson.ipynb'])
})

test('a run while students type waits for no notebook push in flight: one of notebooks alone, the walk\'s own or an older one, lets it go at once', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'lesson.ipynb', '{"cells":[]}')
  put(klass.dir, 'a.py', 'x = 1\n')
  await inStep(machine, klass)
  rigged.books.add('lesson.ipynb')
  // A student types: the notebook's projection is written, and its eager push goes out — unacked, the machine busy applying it.
  assert.ok(writeText(klass.id, 'lesson.ipynb', '{"cells":[{"source":"x"}]}'))
  await eager()
  const typed = pushOf(machine, klass.id)!
  assert.deepEqual(typed.put.map((entry) => entry.path), ['lesson.ipynb'])
  rigged.files.replySent(machine, rigged.files.replyBlock(machine))
  let passed = 0
  const run = (): void => void rigged.files.filesBarrier(klass.id, machine).then(() => passed++)
  // A run whose walk is that push's own.
  run()
  await rigged.files.whenIdle()
  await turn()
  assert.equal(passed, 1, 'not behind the notebook push\'s ack')
  // A run after the next keystroke: its walk differs from the push in flight, which still carries only the notebook.
  assert.ok(writeText(klass.id, 'lesson.ipynb', '{"cells":[{"source":"xy"}]}'))
  run()
  await rigged.files.whenIdle()
  await turn()
  assert.equal(passed, 2, 'nor behind a newer notebook version')
  assert.equal(pushOf(machine, klass.id)!.seq, typed.seq, 'and no push of its own: nothing it reads is missing there')
  // A file the run reads, written meanwhile: that one it waits for, as always.
  assert.ok(writeText(klass.id, 'a.py', 'x = 2\n'))
  run()
  await rigged.files.whenIdle()
  await turn()
  assert.equal(passed, 2, 'a.py is a push away')
  const mine = pushOf(machine, klass.id)!
  assert.deepEqual(mine.put.map((entry) => entry.path), ['a.py'])
  await ack(machine, klass, mine.seq)
  await turn()
  assert.equal(passed, 3)
})

test('moves: a rename here is a rename there, a folder\'s too, with nothing uploaded; a delete is a remove', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'a.csv', 'id\n1\n')
  put(klass.dir, 'raw/one.csv', 'one')
  put(klass.dir, 'raw/two.csv', 'two')
  put(klass.dir, 'gone.txt', 'bye')
  await inStep(machine, klass)
  assert.equal(movePath(klass.id, 'a.csv', 'b.csv'), 'ok')
  assert.equal(movePath(klass.id, 'raw', 'data'), 'ok')
  assert.ok(deleteFile(klass.id, 'gone.txt'))
  await eager()
  const push = pushOf(machine, klass.id)
  assert.ok(push)
  assert.deepEqual(push.move.sort((x, y) => x.from.localeCompare(y.from)), [{ from: 'a.csv', to: 'b.csv' }, { from: 'raw', to: 'data' }])
  assert.deepEqual(push.remove, ['gone.txt'])
  assert.deepEqual(push.put, [], 'no upload for a rename')
  // Should a source be gone there, the agent fetches the moved files by hash: the blob door serves them, at their new place here.
  assert.deepEqual(rigged.files.blobFor(machine, sha('id\n1\n')), { sessionId: klass.id, path: 'b.csv', bytes: 5, promoted: false })
  assert.equal(rigged.files.blobFor(machine, sha('two'))?.path, 'data/two.csv')
  await ack(machine, klass, push.seq)
  // What the copy holds now is what this server has: the next walk pushes nothing.
  forgetTree(klass.id)
  await eager()
  assert.equal(pushOf(machine, klass.id), null)
})

test('a push planned while another is unacked supersedes it whole, with no move in it', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'a.csv', 'one')
  await inStep(machine, klass)
  assert.equal(movePath(klass.id, 'a.csv', 'b.csv'), 'ok')
  await eager()
  const first = pushOf(machine, klass.id)!
  assert.deepEqual(first.move, [{ from: 'a.csv', to: 'b.csv' }])
  put(klass.dir, 'c.csv', 'three')
  forgetTree(klass.id)
  // An eager push never supersedes one in flight; a run's barrier does.
  await eager()
  assert.equal(pushOf(machine, klass.id)!.seq, first.seq)
  const barrier = rigged.files.filesBarrier(klass.id, machine)
  await rigged.files.whenIdle()
  await new Promise((resolve) => setImmediate(resolve))
  const second = pushOf(machine, klass.id)!
  assert.ok(second.seq > first.seq)
  assert.deepEqual(second.move, [], 'a move is not repeatable on a half-applied push')
  assert.deepEqual(second.remove, ['a.csv'])
  assert.deepEqual(second.put.map((entry) => entry.path).sort(), ['b.csv', 'c.csv'])
  await ack(machine, klass, second.seq)
  await barrier
})

test('the barrier\'s words while a blob moves, its promotion, and its stall: 30 s without progress refuses the run', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  const big = Buffer.alloc(3 * 1024 * 1024, 1)
  put(klass.dir, 'big.bin', big)
  forgetTree(klass.id)
  const told: string[] = []
  const barrier = rigged.files.filesBarrier(klass.id, machine, { onProgress: (words) => told.push(words) })
  const refused = barrier.then(() => null, (error: unknown) => error)
  await rigged.files.whenIdle()
  await new Promise((resolve) => setImmediate(resolve))
  const push = pushOf(machine, klass.id)!
  assert.equal(push.promoted, true)
  assert.deepEqual(told, [movingWords(0, big.length)])
  rigged.files.replySent(machine, rigged.files.replyBlock(machine))
  // Bytes moving start the stall's clock over, and the words follow them (not more often than once a second).
  rigged.files.noteServed(machine, sha(big), 1024 * 1024)
  rigged.clock.advance(1_000)
  rigged.files.noteServed(machine, sha(big), 1024 * 1024)
  assert.equal(told.at(-1), movingWords(2 * 1024 * 1024, big.length))
  assert.match(told.at(-1)!, /2 .*3/)
  rigged.clock.advance(CLASS_BARRIER_STALL_MS - 1_000)
  assert.equal(await Promise.race([refused, Promise.resolve('waiting')]), 'waiting', 'progress a moment ago: still waiting')
  rigged.clock.advance(1_000)
  const error = await refused
  assert.ok(error instanceof FilesStalled)
  assert.equal(error.words, tr('server.theFilesDidNotReachTheMachine.20cf87', { seconds: CLASS_BARRIER_STALL_MS / 1000 }))
})

test('a push that never moves at all refuses the run CLASS_BARRIER_STALL_MS on', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  put(klass.dir, 'big.bin', Buffer.alloc(CLASS_INLINE_BYTES + 1, 8))
  forgetTree(klass.id)
  const refused = rigged.files.filesBarrier(klass.id, machine).then(() => null, (error: unknown) => error)
  await rigged.files.whenIdle()
  await new Promise((resolve) => setImmediate(resolve))
  rigged.clock.advance(CLASS_BARRIER_STALL_MS)
  assert.ok((await refused) instanceof FilesStalled)
})

test('the barrier waits CLASS_BARRIER_MS at most, however the bytes keep moving', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  const big = Buffer.alloc(2 * 1024 * 1024, 2)
  put(klass.dir, 'big.bin', big)
  forgetTree(klass.id)
  const refused = rigged.files.filesBarrier(klass.id, machine).then(() => null, (error: unknown) => error)
  await rigged.files.whenIdle()
  await new Promise((resolve) => setImmediate(resolve))
  for (let at = 0; at < CLASS_BARRIER_MS; at += 10_000) {
    rigged.files.noteServed(machine, sha(big), 1)
    rigged.clock.advance(10_000)
  }
  const error = await refused
  assert.ok(error instanceof FilesStalled)
  assert.equal(error.words, tr('server.theFilesDidNotReachTheMachineIn.793493', { seconds: CLASS_BARRIER_MS / 1000 }))
})

/* ------------------------------------------------------- machine → home */

test('§8.4 · the kernel writes out.csv home never touched: applied', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  const row = report(klass, { changed: [{ path: 'out.csv', sha256: sha('a,b\n'), bytes: 4, base: null, inline: b64('a,b\n') }] })
  await says(machine, row)
  assert.equal(read(klass.dir, 'out.csv'), 'a,b\n')
  assert.deepEqual(rigged.files.replyBlock(machine).verdicts, [{ sessionId: klass.id, seq: row.seq, accepted: ['out.csv'], refused: [] }])
  // The hooks follow once the burst is over (400 ms), as for a cell's own writes.
  assert.deepEqual(rigged.changed, [])
  rigged.clock.advance(400)
  assert.deepEqual(rigged.changed, [klass.id])
})

test('§8.4 · both sides changed it: this server\'s stays, the machine\'s is kept as «name (с машины HH-MM).ext», and is pushed back', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'utils.py', 'v0')
  await inStep(machine, klass)
  assert.ok(writeText(klass.id, 'utils.py', 'home v1'))
  const name = conflictCopyName(klass.id, 'utils.py', rigged.clock.now())
  assert.match(name, /^utils \(с машины \d\d-\d\d\)\.py$/)
  const row = report(klass, { changed: [{ path: 'utils.py', sha256: sha('machine v1'), bytes: 10, base: sha('v0'), inline: b64('machine v1') }] })
  await says(machine, row)
  assert.equal(read(klass.dir, 'utils.py'), 'home v1', 'home wins')
  assert.equal(read(klass.dir, name), 'machine v1', 'the machine\'s version kept beside it')
  const verdict = rigged.files.replyBlock(machine).verdicts.find((one) => one.seq === row.seq)
  assert.deepEqual(verdict?.refused, [{ path: 'utils.py', why: 'base', copy: name }])
  assert.ok(rigged.notes.includes(tr('server.wasChangedHereAndOnTheMachine.107a60', { file: 'utils.py', copy: name })))
  // The copy's row says whose it is.
  const rowOf = roomTree(klass.id).files.find((entry) => entry.path === name)
  assert.equal(rowOf?.conflict?.of, 'utils.py')
  // And this server's version goes back to the machine.
  await eager()
  const push = pushOf(machine, klass.id)!
  assert.ok(push.put.some((entry) => entry.path === 'utils.py' && entry.sha256 === sha('home v1')))
})

test('§8.4 · home deleted it while a loop rewrote it: the delete holds, and nothing comes back', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'old.csv', 'v0')
  await inStep(machine, klass)
  assert.ok(deleteFile(klass.id, 'old.csv'))
  for (const version of ['loop 1', 'loop 2']) {
    const row = report(klass, { changed: [{ path: 'old.csv', sha256: sha(version), bytes: version.length, base: sha('v0'), inline: b64(version) }] })
    await says(machine, row)
    assert.equal(read(klass.dir, 'old.csv'), null, 'deletes never resurrect')
    assert.deepEqual(rigged.files.replyBlock(machine).verdicts.find((one) => one.seq === row.seq)?.refused, [{ path: 'old.csv', why: 'base' }])
  }
  assert.equal(rigged.notes.filter((note) => note === tr('server.wasDeletedOnTheServerTheChanges.6230f9', { file: 'old.csv' })).length, 1, 'said once')
  // The copy is told to remove it; after that, a write on the machine is a new file.
  await eager()
  const push = pushOf(machine, klass.id)!
  assert.deepEqual(push.remove, ['old.csv'])
  await ack(machine, klass, push.seq)
  await says(machine, report(klass, { changed: [{ path: 'old.csv', sha256: sha('new'), bytes: 3, base: null, inline: b64('new') }] }))
  assert.equal(read(klass.dir, 'old.csv'), 'new', 'the loop\'s next write after the push applies as a new file')
})

test('§8.4 · the kernel deleted a file home has since replaced: home\'s file is pushed back', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'keep.csv', 'v0')
  await inStep(machine, klass)
  assert.ok(writeText(klass.id, 'keep.csv', 'v1 here'))
  const row = report(klass, { removed: [{ path: 'keep.csv', base: sha('v0') }] })
  await says(machine, row)
  assert.equal(read(klass.dir, 'keep.csv'), 'v1 here')
  assert.deepEqual(rigged.files.replyBlock(machine).verdicts.find((one) => one.seq === row.seq)?.refused, [{ path: 'keep.csv', why: 'base' }])
  await eager()
  assert.ok(pushOf(machine, klass.id)!.put.some((entry) => entry.path === 'keep.csv' && entry.sha256 === sha('v1 here')))
  // A delete of what both still agree on is a delete here.
  const plain = report(klass, { removed: [{ path: 'keep.csv', base: sha('v1 here') }] })
  await ack(machine, klass, pushOf(machine, klass.id)!.seq)
  await says(machine, plain)
  assert.equal(read(klass.dir, 'keep.csv'), null)
})

test('§8.4 · the kernel renamed a.csv to b.csv: a movePath here, with no upload', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'a.csv', 'rows')
  await inStep(machine, klass)
  const row = report(klass, { removed: [{ path: 'a.csv', base: sha('rows') }], changed: [{ path: 'b.csv', sha256: sha('rows'), bytes: 4, base: null }] })
  await says(machine, row)
  assert.equal(read(klass.dir, 'a.csv'), null)
  assert.equal(read(klass.dir, 'b.csv'), 'rows')
  const block = rigged.files.replyBlock(machine)
  assert.deepEqual(block.pulls, [], 'nothing pulled')
  assert.deepEqual(block.verdicts.find((one) => one.seq === row.seq)?.accepted.sort(), ['a.csv', 'b.csv'])
})

test('§8.4 · a notebook file changed or removed on the machine is refused and projected again', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  put(klass.dir, 'lesson.ipynb', '{"cells":[]}')
  await inStep(machine, klass)
  rigged.books.add('lesson.ipynb')
  const row = report(klass, { changed: [{ path: 'lesson.ipynb', sha256: sha('{}'), bytes: 2, base: sha('{"cells":[]}'), inline: b64('{}') }] })
  await says(machine, row)
  assert.equal(read(klass.dir, 'lesson.ipynb'), '{"cells":[]}')
  assert.deepEqual(rigged.files.replyBlock(machine).verdicts.find((one) => one.seq === row.seq)?.refused, [{ path: 'lesson.ipynb', why: 'book' }])
  assert.deepEqual(rigged.reprojected, [klass.id])
  await eager()
  assert.ok(pushOf(machine, klass.id)!.put.some((entry) => entry.path === 'lesson.ipynb' && entry.sha256 === sha('{"cells":[]}')), 'this server\'s notebook goes back')
  const removal = report(klass, { removed: [{ path: 'lesson.ipynb', base: sha('{"cells":[]}') }] })
  await says(machine, removal)
  assert.equal(read(klass.dir, 'lesson.ipynb'), '{"cells":[]}', 'an os.remove on a machine deletes no notebook tab')
})

test('§8.4 · a report of an older gen applies nothing; its late changes are named in the room once, without the machine', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  const stale = { id: klass.id, gen: klass.gen }
  assert.ok(updatePlacement(klass.id, 'room', klass.gen, { state: 'lost', endedAt: Date.now(), reason: 'silence' }))
  const row = report(stale, { changed: [{ path: 'late.csv', sha256: sha('x'), bytes: 1, base: null, inline: b64('x') }], late: ['late.csv', 'model.pt'] })
  await says(machine, row)
  await says(machine, { ...row, seq: ++reportSeq })
  assert.equal(read(klass.dir, 'late.csv'), null)
  const late = rigged.notes.filter((note) => note.includes('late.csv'))
  assert.equal(late.length, 1)
  assert.ok(late[0]!.includes('model.pt'))
  assert.doesNotMatch(late[0]!, new RegExp(machine))
  // A machine that never held the class writes nothing into its room, whatever it says.
  const stranger = `m-${randomUUID().slice(0, 6)}`
  await says(stranger, report(stale, { late: ['forged.csv'] }))
  assert.equal(rigged.notes.some((note) => note.includes('forged.csv')), false)
})

/* ------------------------------------------------------- caps and rows */

test('caps: a file over «Файл с машины — до» or the room\'s limit stays on the machine, said once, with its row', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  updateClassMachineSettings({ machineFileMb: 1 })
  const big = { path: 'model.pt', sha256: sha('model'), bytes: 2 * 1024 * 1024, base: null }
  const row = report(klass, { changed: [big] })
  await says(machine, row)
  await says(machine, report(klass, { changed: [big] }))
  assert.deepEqual(rigged.files.replyBlock(machine).pulls, [], 'nothing pulled')
  assert.equal(rigged.files.replyBlock(machine).verdicts.find((one) => one.seq === row.seq)?.refused[0]?.why, 'cap')
  assert.equal(rigged.notes.filter((note) => note.startsWith('model.pt')).length, 1, 'the kernel log says it once')
  const entry = roomTree(klass.id).files.find((one) => one.path === 'model.pt')
  assert.deepEqual(entry?.onMachine, { bytes: 2 * 1024 * 1024, why: 'size' })
  // The room's limit: the class folder's sum.
  updateClassMachineSettings({ machineFileMb: 100 })
  updateResourceSettings({ uploadMb: 1, sessionMb: 16 }, BOUNDS)
  await says(machine, report(klass, { changed: [{ path: 'room.bin', sha256: sha('room'), bytes: 20 * 1024 * 1024, base: null }] }))
  assert.equal(roomTree(klass.id).files.find((one) => one.path === 'room.bin')?.onMachine?.why, 'room')
  // And what stays there is never removed from the machine by a push.
  forgetTree(klass.id)
  await eager()
  assert.equal(pushOf(machine, klass.id), null)
})

test('a package tree on the machine is one row, its files counted; a skipped file keeps its own row', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  await says(machine, report(klass, {
    skipped: [
      { path: 'torch/__init__.py', bytes: 100, why: 'package' },
      { path: 'torch/nn/modules/linear.py', bytes: 200, why: 'package' },
      { path: 'torch-2.1.0.dist-info/RECORD', bytes: 50, why: 'package' },
      { path: 'lib/numpy/core/a.so', bytes: 1000, why: 'package' },
      { path: 'lib/numpy-2.4.dist-info/RECORD', bytes: 10, why: 'package' },
      { path: 'deep/x/y.bin', bytes: 5, why: 'count' },
      // `pip install -t vendor/py/lib` with no vendor/ here: every folder above the row is made up, or the row is nowhere.
      { path: 'vendor/py/lib/six.py', bytes: 3, why: 'package' },
      { path: 'vendor/py/lib/six-1.16.dist-info/RECORD', bytes: 2, why: 'package' },
    ],
  }))
  const tree = roomTree(klass.id).files
  const top = tree.find((entry) => entry.path === PACKAGES_ROW)
  assert.deepEqual({ kind: top?.kind, bytes: top?.bytes, count: top?.count }, { kind: 'packages', bytes: 350, count: 3 })
  const lib = tree.find((entry) => entry.path === `lib/${PACKAGES_ROW}`)
  assert.deepEqual({ bytes: lib?.bytes, count: lib?.count }, { bytes: 1010, count: 2 })
  assert.equal(tree.some((entry) => entry.path.startsWith('torch/')), false, 'no row per package file')
  assert.equal(tree.find((entry) => entry.path === 'deep/x/y.bin')?.onMachine?.why, 'count')
  assert.equal(tree.find((entry) => entry.path === 'deep')?.dir, true, 'its folders made up as rows')
  assert.deepEqual(['vendor', 'vendor/py', 'vendor/py/lib'].map((dir) => tree.find((entry) => entry.path === dir)?.dir), [true, true, true])
  assert.equal(tree.find((entry) => entry.path === `vendor/py/lib/${PACKAGES_ROW}`)?.count, 2)
  // In the tree's own order: folders first, then files, each by name.
  const top_level = tree.filter((entry) => !entry.path.includes('/')).map((entry) => entry.path)
  assert.deepEqual(top_level, ['deep', 'lib', 'vendor', PACKAGES_ROW])
})

test('«Привезти»: a file over the per-file cap is pulled by its hash, within the room\'s limit; one of a package tree is refused in words', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  updateClassMachineSettings({ machineFileMb: 1 })
  const body = Buffer.alloc(2 * 1024 * 1024, 3)
  const row = report(klass, { changed: [{ path: 'model.pt', sha256: sha(body), bytes: body.length, base: null }], skipped: [{ path: 'torch/x.py', bytes: 1, why: 'package' }] })
  await says(machine, row)
  assert.deepEqual(rigged.files.fetch(klass.id, 'torch/x.py'), { refused: tr('server.thisFileCannotBeBroughtFromThe.148a43') })
  assert.deepEqual(rigged.files.fetch(klass.id, 'nothing.csv'), { refused: tr('server.thisFileIsNotOnTheClassMachines.0fd59f') })
  assert.deepEqual(rigged.files.fetch(klass.id, 'model.pt'), { ok: true })
  assert.deepEqual(rigged.files.replyBlock(machine).pulls, [{ sessionId: klass.id, gen: klass.gen, paths: [{ path: 'model.pt', sha256: sha(body) }] }])
  assert.equal(roomTree(klass.id).files.find((one) => one.path === 'model.pt')?.pending, true, 'on its way')
  // Allowed over the per-file cap, as «Привезти» may: the bytes land and the row is this server's file now.
  const allowed = rigged.files.pullFor(machine, klass.id, 'model.pt', klass.gen, sha(body), body.length)
  assert.equal(allowed.cap, 1024 * 1024 * 1024)
  const tmp = path.join(klass.dir, '.colloq.uploading-test-fetch')
  fs.writeFileSync(tmp, body)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'model.pt', sha(body), tmp), { accepted: true })
  assert.equal(fs.statSync(path.join(klass.dir, 'model.pt')).size, body.length)
  assert.equal(roomTree(klass.id).files.find((one) => one.path === 'model.pt')?.onMachine, undefined)
  // The room's limit still holds for it.
  updateResourceSettings({ uploadMb: 1, sessionMb: 16 }, BOUNDS)
  await says(machine, report(klass, { changed: [{ path: 'second.pt', sha256: sha('2'), bytes: 20 * 1024 * 1024, base: null }] }))
  const refused = rigged.files.fetch(klass.id, 'second.pt')
  assert.ok('refused' in refused && refused.refused.startsWith('second.pt'))
})

test('a file the machine left unhashed over a cap is brought as it is: a pull with no hash, the PUT saying which; a released row goes', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  await says(machine, report(klass, { skipped: [{ path: 'model.pt', bytes: 300 * 1024 * 1024, why: 'size' }, { path: 'old.bin', bytes: 1, why: 'size' }] }))
  assert.equal(rigged.notes.filter((note) => note.startsWith('model.pt')).length, 1, 'the over-cap words, once')
  await says(machine, report(klass, { released: ['old.bin'] }))
  assert.equal(roomTree(klass.id).files.some((entry) => entry.path === 'old.bin'), false, 'a released path no longer stays there')
  assert.deepEqual(rigged.files.fetch(klass.id, 'model.pt'), { ok: true })
  assert.deepEqual(rigged.files.replyBlock(machine).pulls, [{ sessionId: klass.id, gen: klass.gen, paths: [{ path: 'model.pt' }] }])
  // Whatever version the PUT names lands, within the room's limit (not the per-file cap).
  const body = Buffer.from('the model as it is now')
  assert.equal(rigged.files.pullFor(machine, klass.id, 'model.pt', klass.gen, sha(body), body.length).target, 'model.pt')
  const tmp = path.join(klass.dir, '.colloq.uploading-test-unhashed')
  fs.writeFileSync(tmp, body)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'model.pt', sha(body), tmp), { accepted: true })
  assert.equal(read(klass.dir, 'model.pt'), 'the model as it is now')
  const verdicts = rigged.files.replyBlock(machine).verdicts
  assert.ok(verdicts.some((one) => one.accepted.includes('model.pt')), 'the machine hears it is agreed now')
})

test('«Привезти» of a file the kernel then removed there is let go once the machine says it no longer stays: nothing waits for it', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  await says(machine, report(klass, { skipped: [{ path: 'model.pt', bytes: 300 * 1024 * 1024, why: 'size' }] }))
  assert.deepEqual(rigged.files.fetch(klass.id, 'model.pt'), { ok: true })
  assert.equal(rigged.files.filesLag(klass.id, machine)?.pending, 1, '«↑ 1 файл» while it comes')
  // The kernel removed it before the agent sent it: it is released, and in no change.
  await says(machine, report(klass, { released: ['model.pt'] }))
  assert.deepEqual(rigged.files.replyBlock(machine).pulls, [], 'never asked again')
  assert.equal(rigged.files.pendingUnder(klass.id, 'model.pt'), false, 'a download or a move of it waits for nothing')
  assert.equal(rigged.files.filesLag(klass.id, machine)?.pending, 0)
  // Released because it is on its way as a change, the change's pull stands.
  await says(machine, report(klass, { skipped: [{ path: 'big.csv', bytes: 300 * 1024 * 1024, why: 'size' }] }))
  assert.deepEqual(rigged.files.fetch(klass.id, 'big.csv'), { ok: true })
  await says(machine, report(klass, { released: ['big.csv'], changed: [{ path: 'big.csv', sha256: sha('small now'), bytes: 9, base: null }] }))
  assert.equal(rigged.files.pendingUnder(klass.id, 'big.csv'), true, 'its bytes are still on their way')
})

/** A control socket as dispatch sees one, keeping what it was told. */
function fakeSocket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) heard.push(JSON.parse(String(frame)) as ControlServerMessage)
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {},
  }
  return { ws: ws as unknown as WebSocket, heard }
}

test('«Привезти» on the control socket is staff\'s, and a move of a file on its way from the machine waits for it to land', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  updateClassMachineSettings({ machineFileMb: 1 })
  await says(machine, report(klass, { changed: [{ path: 'model.pt', sha256: sha('m'), bytes: 2 * 1024 * 1024, base: null }] }))
  const student = fakeSocket()
  dispatch(student.ws, klass.id, { sessionId: klass.id, participantId: 'p_student', role: 'participant' }, { t: 'files:fetch', path: 'model.pt' })
  assert.deepEqual(student.heard.filter((one) => one.t === 'error').map((one) => (one as { message: string }).message), [tr('server.onlyTheTeacherCanBringAFile.031ac7')])
  assert.deepEqual(rigged.files.replyBlock(machine).pulls, [], 'nothing asked of the machine')
  const teacher = fakeSocket()
  dispatch(teacher.ws, klass.id, { sessionId: klass.id, participantId: 'p_teacher', role: 'host' }, { t: 'files:fetch', path: 'model.pt' })
  assert.equal(teacher.heard.filter((one) => one.t === 'error').length, 0)
  assert.deepEqual(rigged.files.replyBlock(machine).pulls[0]?.paths, [{ path: 'model.pt', sha256: sha('m') }])
  // A file of this server's with a newer version on its way: its move waits for the version to land (or for the settle's end).
  put(klass.dir, 'out.csv', 'v0')
  forgetTree(klass.id)
  await eager()
  await ack(machine, klass, pushOf(machine, klass.id)!.seq)
  const v1 = Buffer.alloc(80_000, 49)
  await says(machine, report(klass, { changed: [{ path: 'out.csv', sha256: sha(v1), bytes: v1.length, base: sha('v0') }] }))
  assert.equal(rigged.files.pendingUnder(klass.id, 'out.csv'), true)
  // (A machine that still calls: a silent one is waited for by nobody.)
  noteCall(machine, Date.now(), null)
  dispatch(teacher.ws, klass.id, { sessionId: klass.id, participantId: 'p_teacher', role: 'host' }, { t: 'tree:move', from: 'out.csv', to: 'moved.csv' })
  assert.equal(read(klass.dir, 'out.csv'), 'v0', 'not moved while its newer version is on its way')
  const tmp = path.join(klass.dir, '.colloq.uploading-test-move')
  fs.writeFileSync(tmp, v1)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'out.csv', sha(v1), tmp), { accepted: true })
  rigged.files.replySent(machine, rigged.files.replyBlock(machine))
  rigged.clock.advance(3_000)
  rigged.files.noteKernelsBlock(machine, block({ placements: [] }))
  await rigged.files.whenIdle()
  for (let i = 0; i < 50 && read(klass.dir, 'moved.csv') === null; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(read(klass.dir, 'moved.csv')?.length, v1.length, 'the move went on with the version that landed')
})

test('a row only the machine has, deleted by staff, is removed there: a remove in the next push, the row gone once it is acked; a student is refused', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  updateClassMachineSettings({ machineFileMb: 1 })
  // One left unhashed over the cap, one a refused change over it, and one in a folder this server does not have.
  await says(machine, report(klass, {
    skipped: [{ path: 'model.pt', bytes: 300 * 1024 * 1024, why: 'size' }, { path: 'runs/a/ckpt.bin', bytes: 2 * 1024 * 1024, why: 'size' }],
    changed: [{ path: 'refused.bin', sha256: sha('r'), bytes: 2 * 1024 * 1024, base: null }],
  }))
  const rows = () => new Set(roomTree(klass.id).files.filter((entry) => entry.onMachine).map((entry) => entry.path))
  assert.deepEqual(rows(), new Set(['model.pt', 'refused.bin', 'runs', 'runs/a', 'runs/a/ckpt.bin']))
  const changed = rigged.changed.length
  // A student is refused as for any file, and nothing goes to the machine.
  const student = fakeSocket()
  dispatch(student.ws, klass.id, { sessionId: klass.id, participantId: 'p_student', role: 'participant' }, { t: 'tree:remove', path: 'model.pt' })
  assert.deepEqual(student.heard.filter((one) => one.t === 'error').map((one) => (one as { message: string }).message), [tr('server.onlyTheTeacherMayRemoveAFile.77a4ef')])
  await eager()
  assert.equal(pushOf(machine, klass.id), null)
  // Staff delete the file, the refused one and the made-up folder: each is a remove of the next push.
  const teacher = fakeSocket()
  for (const where of ['model.pt', 'refused.bin', 'runs']) {
    dispatch(teacher.ws, klass.id, { sessionId: klass.id, participantId: 'p_teacher', role: 'host' }, { t: 'tree:remove', path: where })
  }
  assert.equal(teacher.heard.filter((one) => one.t === 'error').length, 0, 'no «уже нет в комнате» for a row of the machine')
  await eager()
  const push = pushOf(machine, klass.id)!
  assert.deepEqual([...push.remove].sort(), ['model.pt', 'refused.bin', 'runs'])
  assert.deepEqual(push.put, [])
  assert.deepEqual(rows(), new Set(['model.pt', 'refused.bin', 'runs', 'runs/a', 'runs/a/ckpt.bin']), 'the rows stay until the machine has removed them')
  // A run's push planned before the ack carries the removes again (a newer one supersedes the one in flight whole).
  rigged.files.replySent(machine, rigged.files.replyBlock(machine))
  writeText(klass.id, 'notes.txt', 'x')
  const barrier = rigged.files.filesBarrier(klass.id, machine)
  await rigged.files.whenIdle()
  await turn()
  const again = pushOf(machine, klass.id)!
  assert.notEqual(again.seq, push.seq)
  assert.deepEqual([...again.remove].sort(), ['model.pt', 'refused.bin', 'runs'])
  await ack(machine, klass, again.seq)
  await barrier
  assert.deepEqual(rows(), new Set(), 'gone once the machine applied the push that removed them')
  assert.ok(rigged.changed.length > changed, 'and the room heard its tree changed')
  // Nothing more to remove: the next push carries none of them.
  writeText(klass.id, 'notes.txt', 'y')
  await eager()
  assert.deepEqual(pushOf(machine, klass.id)?.remove ?? [], [])
  // A row this server never had, nor any machine: the usual refusal.
  dispatch(teacher.ws, klass.id, { sessionId: klass.id, participantId: 'p_teacher', role: 'host' }, { t: 'tree:remove', path: 'nowhere.csv' })
  assert.deepEqual(teacher.heard.filter((one) => one.t === 'error').map((one) => (one as { message: string }).message), [tr('server.thisFileIsNoLongerInThe.b66e1e')])
})

test('a file the proxy in front of this server refused stays «на машине» with its own words; its pull goes, and «Привезти» is refused', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  const bytes = 150 * 1024 * 1024
  // The kernel wrote it, the machine said it as a change, and this server pulled it.
  await says(machine, report(klass, { changed: [{ path: 'model.pt', sha256: sha('m'), bytes, base: null }] }))
  assert.deepEqual(rigged.files.replyBlock(machine).pulls[0]?.paths, [{ path: 'model.pt', sha256: sha('m') }])
  // Its PUT met the proxy's 413: the machine says it stays there, and why.
  await says(machine, report(klass, { skipped: [{ path: 'model.pt', bytes, why: 'proxy' }] }))
  assert.deepEqual(rigged.files.replyBlock(machine).pulls, [], 'no pull waits for bytes the proxy turns away')
  assert.deepEqual(roomTree(klass.id).files.find((entry) => entry.path === 'model.pt')?.onMachine, { bytes, why: 'proxy' })
  const said = tr('server.staysOnTheMachineTheProxyIn.8cfa12', { file: 'model.pt', size: '150 МБ' })
  assert.deepEqual(rigged.notes.filter((note) => note.startsWith('model.pt')), [said], 'said once, naming no cap of ours')
  assert.deepEqual(rigged.files.fetch(klass.id, 'model.pt'), { refused: tr('server.cannotBeBroughtHereTheProxyIn.fc1eca', { file: 'model.pt' }) })
})

test('a row of the machine comes and goes in the room\'s tree as reports say it: the room hears it at once', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  const before = rigged.changed.length
  await says(machine, report(klass, { skipped: [{ path: 'model.pt', bytes: 300 * 1024 * 1024, why: 'size' }] }))
  rigged.clock.advance(1_000)
  assert.equal(rigged.changed.length, before + 1, 'a new row: the workspace hooks run (the files frame goes out)')
  await says(machine, report(klass, { skipped: [{ path: 'model.pt', bytes: 300 * 1024 * 1024, why: 'size' }] }))
  rigged.clock.advance(1_000)
  assert.equal(rigged.changed.length, before + 1, 'the same row said again changes nothing')
  await says(machine, report(klass, { released: ['model.pt'] }))
  rigged.clock.advance(1_000)
  assert.equal(rigged.changed.length, before + 2, 'gone from the machine: the room hears that too')
})

test('«Привезти» answers the press itself: taken, here already, or refused in words, so the panel waits on no timer', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  await says(machine, report(klass, { skipped: [{ path: 'model.pt', bytes: 300 * 1024 * 1024, why: 'size' }, { path: 'torch/x.py', bytes: 1, why: 'package' }] }))
  const teacher = fakeSocket()
  const press = (where: string) => {
    teacher.heard.length = 0
    dispatch(teacher.ws, klass.id, { sessionId: klass.id, participantId: 'p_teacher', role: 'host' }, { t: 'files:fetch', path: where })
    return teacher.heard.filter((one) => one.t === 'files:fetched')
  }
  assert.deepEqual(press('model.pt'), [{ t: 'files:fetched', path: 'model.pt', outcome: 'accepted' }])
  assert.deepEqual(press('model.pt'), [{ t: 'files:fetched', path: 'model.pt', outcome: 'accepted' }], 'pressed again while it comes: still taken')
  assert.deepEqual(press('torch/x.py'), [{ t: 'files:fetched', path: 'torch/x.py', outcome: 'refused', message: tr('server.thisFileCannotBeBroughtFromThe.148a43') }])
  assert.deepEqual(press('nothing.csv'), [{ t: 'files:fetched', path: 'nothing.csv', outcome: 'refused', message: tr('server.thisFileIsNotOnTheClassMachines.0fd59f') }])
  assert.equal(teacher.heard.some((one) => one.t === 'error'), false, 'a refusal travels in the answer, not as a stray error')
  // The bytes landed before a second tab's press was read: here already, nothing asked of the machine.
  const body = Buffer.from('the model')
  const tmp = path.join(klass.dir, '.colloq.uploading-test-fetched')
  fs.writeFileSync(tmp, body)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'model.pt', sha(body), tmp), { accepted: true })
  assert.deepEqual(press('model.pt'), [{ t: 'files:fetched', path: 'model.pt', outcome: 'brought' }])
  // A student is refused as before, and the press hears its answer too.
  const student = fakeSocket()
  dispatch(student.ws, klass.id, { sessionId: klass.id, participantId: 'p_student', role: 'participant' }, { t: 'files:fetch', path: 'model.pt' })
  assert.deepEqual(student.heard.filter((one) => one.t === 'files:fetched'), [{ t: 'files:fetched', path: 'model.pt', outcome: 'refused' }])
})

/* ---------------------------------------------------------- the rebuild */

test('a copy from before this life is rebuilt from the machine\'s paged full report; a gap in its pages starts it over', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine, { createdAt: Date.now() - 10 * 60_000 })
  put(klass.dir, 'same.csv', 'same')
  put(klass.dir, 'here.csv', 'home edit')
  assert.deepEqual(rigged.files.replyBlock(machine).scan, [{ sessionId: klass.id, full: true }], 'a full report asked')
  const page = (index: number, last: boolean, over: Partial<RemoteFilesReport> = {}): RemoteFilesReport => report(klass, { full: true, page: { index, last }, ...over })
  // A page that does not follow the ones counted is no walk: asked again.
  await says(machine, page(1, false))
  assert.deepEqual(rigged.files.replyBlock(machine).scan, [{ sessionId: klass.id, full: true }])
  // A gap in the middle of a walk (page 2 after page 0) drops what was kept, and asks again.
  await says(machine, page(0, false))
  await says(machine, page(2, false))
  assert.deepEqual(rigged.files.replyBlock(machine).scan, [{ sessionId: klass.id, full: true }])
  await says(machine, page(0, false, { changed: [{ path: 'same.csv', sha256: sha('same'), bytes: 4, base: sha('same') }] }))
  assert.deepEqual(rigged.files.replyBlock(machine).scan, [], 'not asked while a walk is being paged')
  // The last page: written while home was down, this one is pulled; the agreed rest is what the copy holds.
  const changed = { path: 'down.csv', sha256: sha('written while home was down'), bytes: 27, base: null }
  await says(machine, page(1, true, { changed: [changed, { path: 'here.csv', sha256: sha('v0'), bytes: 2, base: sha('v0') }] }))
  assert.deepEqual(rigged.files.replyBlock(machine).pulls, [{ sessionId: klass.id, gen: klass.gen, paths: [{ path: 'down.csv', sha256: changed.sha256 }] }])
  await eager()
  const push = pushOf(machine, klass.id)!
  assert.equal(push.full, false)
  assert.deepEqual(push.put.map((entry) => entry.path), ['here.csv'], 'only what differs from what was agreed')
})

/* ---------------------------------------------------------- settle */

test('filesSettled asks every machine of the class for a scan and waits for the answer and its pulls; a silent machine is not waited for', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  noteCall(machine, Date.now(), null)
  let settled: boolean | null = null
  const settle = rigged.files.filesSettled(klass.id, 60_000).then((value) => {
    settled = value
  })
  const asked = rigged.files.replyBlock(machine)
  assert.deepEqual(asked.scan, [{ sessionId: klass.id }])
  rigged.files.replySent(machine, asked)
  await says(machine, report(klass, { changed: [{ path: 'new.bin', sha256: sha('n'), bytes: CLASS_INLINE_BYTES + 5, base: null }] }))
  assert.equal(settled, null, 'a pull is still on its way')
  const tmp = path.join(klass.dir, '.colloq.uploading-test-settle')
  fs.writeFileSync(tmp, 'n')
  // A version other than the one asked for lands nowhere.
  await assert.rejects(rigged.files.landPulled(machine, klass.id, klass.gen, 'new.bin', sha('other'), tmp))
  rigged.files.pullFor(machine, klass.id, 'new.bin', klass.gen, sha('n'), CLASS_INLINE_BYTES + 5)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'new.bin', sha('n'), tmp), { accepted: true })
  // The agent scans in its own time and says nothing when nothing changed: the answer has its few seconds, and the
  // machine's own word that nothing of the class is pending there.
  const pending = { ...held(klass.id, klass.gen, 0), files: { pushSeq: 0, pending: 2, pendingBytes: 10, heldOnly: 0, heldOnlyBytes: 0 } }
  rigged.files.noteKernelsBlock(machine, block({ placements: [pending] }))
  rigged.clock.advance(3_000)
  await rigged.files.whenIdle()
  assert.equal(settled, null, 'two files still pending there')
  rigged.files.noteKernelsBlock(machine, block({ placements: [] }))
  await rigged.files.whenIdle()
  await settle
  assert.equal(settled, true)
  // A machine that has not called for longer than the evidence window answers no scan: nothing waits for it.
  const quiet = `m-${randomUUID().slice(0, 6)}`
  const other = classOn(quiet)
  rigged.clock.advance(5_000)
  assert.equal(await rigged.files.filesSettled(other.id, 60_000), true)
})

/* ---------------------------------------------- safety of what lands here */

test('the anchored apply refuses a symlinked parent: nothing lands outside the class folder', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  const outside = fs.mkdtempSync(path.join(config.workspaceDir, '..', 'outside-'))
  fs.symlinkSync(outside, path.join(klass.dir, 'link'))
  const row = report(klass, { changed: [{ path: 'link/x.csv', sha256: sha('x'), bytes: 1, base: null, inline: b64('x') }] })
  await says(machine, row)
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the link')
  const verdict = rigged.files.replyBlock(machine).verdicts.find((one) => one.seq === row.seq)
  assert.equal(verdict?.accepted.length, 0)
})

test('temporary names a crash left in the class folder are swept, and a refused write leaves none', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  const stale = path.join(klass.dir, `.colloq.uploading-${randomUUID()}`)
  fs.writeFileSync(stale, 'half a file')
  const hourAgo = (Date.now() - 2 * 60 * 60_000) / 1000
  fs.utimesSync(stale, hourAgo, hourAgo)
  sweepStaleUploads(klass.id)
  assert.equal(fs.existsSync(stale), false)
  // A change with bytes other than its report says is refused, and leaves nothing behind.
  await says(machine, report(klass, { changed: [{ path: 'lie.csv', sha256: sha('true'), bytes: 4, base: null, inline: b64('fake') }] }))
  assert.deepEqual(fs.readdirSync(klass.dir).filter((name) => name.startsWith('.')), [])
  assert.equal(read(klass.dir, 'lie.csv'), null)
})

/* ---------------------------------------------------------- the tree */

test('the room\'s tree: rows of files on their way and of conflict copies change by delta like any other row', () => {
  const before: FileEntry[] = [{ name: 'a.csv', path: 'a.csv', dir: false, size: 1, modifiedAt: 1 }]
  const after: FileEntry[] = [{ ...before[0]!, pending: true }]
  assert.deepEqual(treeDelta(before, after).changed, after)
  assert.deepEqual(treeDelta(after, after).changed, [])
})

/* ------------------------------------------------------------ the doors */

/** A class machine joined with a classes code, to the real app; its class placements a stand-in that answers little. */
async function joinedMachine(): Promise<Machine> {
  const home = await serve()
  const port: ClassPort = {
    wantedPlacements: () => [],
    noteKernelsReport: () => undefined,
    hasLivePlacements: () => true,
    anyLivePlacements: () => true,
    classTick: () => undefined,
    failoverRunner: () => 0,
    postmortemWanted: () => [],
    classRevisionsWanted: () => [],
    tunnelWanted: () => 'open',
    placementOf: () => ({ where: 'home' }),
  }
  useClassPort(port)
  const machine = new Machine(home)
  const minted = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, namePrefix: null, createdBy: 'tests', classes: true })
  assert.equal((await machine.join(minted.code)).status, 200)
  return machine
}

async function putRoomFile(machine: Machine, sessionId: string, where: string, gen: number, content: Buffer, over: { sha256?: string; bytes?: string } = {}): Promise<{ status: number; body: { error?: string; verdict?: unknown } }> {
  const answer = await machine.call('PUT', remoteClassPaths.roomFile(sessionId, where, gen), {
    raw: zlib.gzipSync(content),
    headers: {
      'content-encoding': 'gzip',
      [REMOTE_SHA256_HEADER]: over.sha256 ?? sha(content),
      [REMOTE_BYTES_HEADER]: over.bytes ?? String(content.length),
      'content-type': 'application/octet-stream',
    },
  })
  return { status: answer.status, body: (await answer.json()) as { error?: string; verdict?: unknown } }
}

test('the sync carries the files both ways through the agent\'s own parser; the PUT door takes only what was asked, at the current gen', async () => {
  reset()
  rigged = rig()
  const machine = await joinedMachine()
  const klass = classOn(machine.runnerId)
  put(klass.dir, 'a.py', 'print(1)\n')
  // The first reply makes the copy; its push follows in the next.
  await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, 0)] }) }))
  await eager()
  const first = await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, 0)] }) }))
  assert.equal(first.status, 200)
  const reply = parseRemoteSyncReply(first.body)
  const push = reply.kernels?.pushes.find((one) => one.sessionId === klass.id)
  assert.ok(push?.full)
  assert.ok(push.put.some((entry) => entry.path === 'a.py'))
  // The caps the machine keeps a kernel's files to: unsaid while they are the machine's own defaults, said once the owner moves one.
  assert.equal(reply.kernels?.caps, undefined)
  updateClassMachineSettings({ machineFileMb: 300 })
  const moved = parseRemoteSyncReply((await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, 0)] }) }))).body)
  assert.deepEqual(moved.kernels?.caps, { machineFileMb: 300, roomMb: 1024 })
  updateClassMachineSettings({ machineFileMb: null })
  // The machine applies it and reports a large file its kernel wrote.
  const big = Buffer.alloc(CLASS_INLINE_BYTES * 2, 9)
  const row = report(klass, { changed: [{ path: 'out.bin', sha256: sha(big), bytes: big.length, base: null }] })
  await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, push.seq)], reports: [row] }) }))
  await rigged.files.whenIdle()
  const asked = await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, push.seq)] }) }))
  assert.deepEqual(parseRemoteSyncReply(asked.body).kernels?.pulls, [{ sessionId: klass.id, gen: klass.gen, paths: [{ path: 'out.bin', sha256: sha(big) }] }])
  // Not asked for: 404. Another version: 404. Bytes other than declared: 422. Over its cap: 413.
  assert.equal((await putRoomFile(machine, klass.id, 'other.bin', klass.gen, big)).status, 404)
  assert.equal((await putRoomFile(machine, klass.id, 'out.bin', klass.gen, Buffer.from('else'))).status, 404)
  assert.equal((await putRoomFile(machine, klass.id, 'out.bin', klass.gen, Buffer.alloc(big.length, 1), { sha256: sha(big) })).status, 422)
  assert.deepEqual(fs.readdirSync(klass.dir).filter((name) => name.startsWith('.')), [], 'a refused PUT leaves no temporary name')
  // The asked version lands, and its verdict rides the next reply.
  const landed = await putRoomFile(machine, klass.id, 'out.bin', klass.gen, big)
  assert.equal(landed.status, 200)
  assert.deepEqual(landed.body.verdict, { accepted: true })
  assert.equal(fs.statSync(path.join(klass.dir, 'out.bin')).size, big.length)
  const next = parseRemoteSyncReply((await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, push.seq)] }) }))).body)
  assert.deepEqual(next.kernels?.verdicts, [{ sessionId: klass.id, seq: row.seq, accepted: ['out.bin'], refused: [] }])
  // A fenced gen's late PUT: 409 — the slot lost, and placed again on another machine since.
  assert.ok(updatePlacement(klass.id, 'room', klass.gen, { state: 'lost', endedAt: Date.now(), reason: 'silence' }))
  const late = await putRoomFile(machine, klass.id, 'out.bin', klass.gen, big)
  assert.equal(late.status, 409)
  assert.equal(late.body.error, 'revoked')
  writePlacement({
    sessionId: klass.id, role: 'room', runnerId: `elsewhere-${randomUUID().slice(0, 6)}`, state: 'ready', environment: 'base',
    revision: { id: 'rev', ref: 'ghcr.io/x@sha256:' + 'b'.repeat(64), layers: 'l'.repeat(64) },
    memoryMb: 512, cpus: 1, gpu: null, workers: null, container: C1, readyAt: Date.now(), endedAt: null, reason: null, createdAt: Date.now(),
  })
  assert.equal((await putRoomFile(machine, klass.id, 'out.bin', klass.gen, big)).status, 409)
  // A gen the class never had is nothing to this machine at all.
  assert.equal((await putRoomFile(machine, klass.id, 'out.bin', klass.gen + 5, big)).status, 404)
})

test('a room blob is served to the machine its push names, and to no other', async () => {
  reset()
  rigged = rig()
  const machine = await joinedMachine()
  const stranger = await joinedMachine()
  const klass = classOn(machine.runnerId)
  const big = Buffer.alloc(CLASS_INLINE_BYTES + 10, 4)
  put(klass.dir, 'data.bin', big)
  await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, 0)] }) }))
  await eager()
  assert.ok(pushOf(machine.runnerId, klass.id))
  const theirs = await stranger.call('GET', `blobs/${sha(big)}`)
  assert.equal(theirs.status, 404)
  await theirs.arrayBuffer()
  const mine = await machine.call('GET', `blobs/${sha(big)}`)
  assert.equal(mine.status, 200)
  assert.equal(Buffer.from(await mine.arrayBuffer()).equals(big), true)
  // Rewritten here since its push named it: 410, and the push is planned again.
  put(klass.dir, 'data.bin', Buffer.alloc(CLASS_INLINE_BYTES + 10, 5))
  const gone = await machine.call('GET', `blobs/${sha(big)}`)
  assert.equal(gone.status, 410)
  await gone.arrayBuffer()
  await rigged.files.whenIdle()
  assert.ok(pushOf(machine.runnerId, klass.id)!.put.some((entry) => entry.sha256 === sha(Buffer.alloc(CLASS_INLINE_BYTES + 10, 5))))
})

/* ---------------------------------------------------------- the rates */

test('every flow is paced smoothly: a burst of at most 256 KiB, then the rate, continuously', () => {
  const pace = new Pace(() => 4 * 1024 * 1024)
  const chunk = 64 * 1024
  const start = 1_000_000
  const waits = Array.from({ length: 8 }, () => pace.reserve(chunk, start))
  // 256 KiB go at once, every chunk after it waits its share at 4 MiB/s (15.6 ms a chunk).
  assert.deepEqual(waits.slice(0, PACE_BURST_BYTES / chunk), [0, 0, 0, 0])
  for (let i = PACE_BURST_BYTES / chunk; i < waits.length; i++) assert.ok(Math.abs(waits[i]! - (i - 3) * 15.625) < 0.01, `chunk ${i} waits ${waits[i]}`)
  // A slow flow keeps a quarter of a second as its burst when that is smaller.
  const slow = new Pace(() => 512 * 1024)
  assert.deepEqual([slow.reserve(chunk, start), slow.reserve(chunk, start)], [0, 0])
  assert.ok(slow.reserve(chunk, start) > 0)
})

test('the barrier of a class with nothing on machines, and a home with no class files at all, pass at once', async () => {
  const id = `cf-home-${randomUUID().slice(0, 6)}`
  createSession(id, 'Home', 'base')
  assert.equal(await rigged.files.filesSettled(id, 1_000), true)
  await rigged.files.filesBarrier(id, 'no-machine')
  assert.equal(rigged.files.counts.walks, 0)
  assert.deepEqual(roomTree(id).files, roomTree(id).files)
})

test('the words: «Файлы едут на машину: 12 из 150 МБ…», and a conflict copy\'s name is a name the folder takes', () => {
  assert.equal(movingWords(12 * 1024 * 1024, 150 * 1024 * 1024), tr('server.filesAreOnTheirWayToThe.1bb29d', { done: '12', total: tr('server.council.sizeMb', { p0: '150' }) }))
  const id = `cf-name-${randomUUID().slice(0, 6)}`
  createSession(id, 'Names', 'base')
  const long = `${'x'.repeat(118)}.csv`
  const name = conflictCopyName(id, long, Date.now())
  assert.ok(name.length <= 120 + 1, name)
  assert.match(name, /\(с машины \d\d-\d\d\)\.csv$/)
  assert.equal(REMOTE_DIR_BASE, 'dir')
})

/* ------------------------------------------------- after the reviews (K6a) */

test('a slot stopped and placed again on its machine at a new gen: the copy begins anew, pushed whole, and the Run waits for that push', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  put(klass.dir, 'data.csv', 'id\n1\n')
  await inStep(machine, klass)
  // An idle stop, then a Run that places the slot again on the class's last machine (placement.ts replaces a stopping row):
  // the agent fences its copy, removes it and begins an empty one for the new gen.
  assert.ok(updatePlacement(klass.id, 'room', klass.gen, { state: 'stopping', reason: 'stopped' }))
  const next = { id: klass.id, gen: placeOn(klass.id, machine).gen }
  assert.equal(next.gen, klass.gen + 1)
  let passed = false
  const barrier = rigged.files.filesBarrier(klass.id, machine).then(() => {
    passed = true
  })
  await rigged.files.whenIdle()
  await turn()
  const push = pushOf(machine, klass.id)
  assert.equal(push?.full, true, 'the new copy is pushed whole')
  assert.ok(push.put.some((entry) => entry.path === 'data.csv'))
  assert.equal(passed, false, 'the run waits for the new copy')
  await ack(machine, next, push.seq)
  await barrier
  // A machine that says it applied less of the copy than it did (its copy begun anew under this one) is pushed whole too.
  rigged.files.noteKernelsBlock(machine, block({ placements: [{ ...held(klass.id, next.gen, 0), files: undefined }] }))
  await rigged.files.whenIdle()
  await eager()
  assert.equal(pushOf(machine, klass.id)?.full, true)
})

test('a folder of small files goes inline over a chain of pushes, never a GET each; the run waits for the last; a reply carries one push\'s inline worth', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  await inStep(machine, klass)
  for (let i = 0; i < 1500; i++) put(klass.dir, `images/img${String(i).padStart(4, '0')}.png`, Buffer.alloc(2048, i % 251))
  forgetTree(klass.id)
  let passed = false
  const barrier = rigged.files.filesBarrier(klass.id, machine).then(() => {
    passed = true
  })
  const sizes: number[] = []
  for (let round = 0; round < 10 && !passed; round++) {
    await rigged.files.whenIdle()
    await turn()
    const push = pushOf(machine, klass.id)
    if (!push) break
    assert.equal(push.put.filter((entry) => !entry.dir && entry.inline === undefined).length, 0, 'no small file goes as a blob')
    sizes.push(push.put.length)
    rigged.files.replySent(machine, rigged.files.replyBlock(machine))
    await ack(machine, klass, push.seq)
    await turn()
  }
  await barrier
  assert.deepEqual(sizes, [513, 512, 476], 'three pushes of a megabyte inline each, the folder in the first')
  // Two classes' pushes of most of a megabyte inline each: a reply carries one whole, the next reply the other.
  const one = classOn(machine)
  const two = classOn(machine)
  for (const room of [one, two]) for (let i = 0; i < 400; i++) put(room.dir, `f${i}.txt`, Buffer.alloc(2048, 1))
  rigged.files.replyBlock(machine)
  await eager()
  const reply = rigged.files.replyBlock(machine)
  assert.equal(reply.pushes.filter((push) => push.sessionId === one.id || push.sessionId === two.id).length, 1)
  assert.ok(reply.pushes.every((push) => push.put.every((entry) => entry.dir || entry.inline !== undefined)), 'nothing stripped to a GET')
  assert.ok(reply.pushes.reduce((sum, push) => sum + push.put.reduce((bytes, entry) => bytes + (entry.inline !== undefined ? entry.bytes! : 0), 0), 0) <= CLASS_INLINE_PUSH_BYTES)
})

test('a machine that stops acking holds two pushes here, however many runs push again: the one it may be applying and the newest', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  await inStep(machine, klass)
  for (let i = 0; i < 12; i++) {
    assert.ok(writeText(klass.id, `out${i}.csv`, `${i},`.repeat(2_000)))
    const run = rigged.files.filesBarrier(klass.id, machine).catch(() => undefined)
    await rigged.files.whenIdle()
    await turn()
    // Carried by a reply, never acked (a full disk there): the run is refused at the stall.
    rigged.files.replySent(machine, rigged.files.replyBlock(machine))
    rigged.clock.advance(CLASS_BARRIER_STALL_MS)
    await run
    assert.ok(rigged.files.unackedPushes() <= 2, `${rigged.files.unackedPushes()} pushes held`)
  }
  // Nothing was lost with the pushes let go: the newest is whole on top of any of them.
  assert.deepEqual(pushOf(machine, klass.id)!.put.map((entry) => entry.path).sort(), Array.from({ length: 12 }, (_, i) => `out${i}.csv`).sort())
})

test('a refusal no write here tells is put back by the next run\'s push: no fast path while the copy differs, and no push in flight reused for it', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  put(klass.dir, 'data/x.csv', '1')
  put(klass.dir, 'a.py', 'x = 1\n')
  await inStep(machine, klass)
  // The kernel replaced the folder data/ by a file: refused, the shape here wins, and the copy holds the file now.
  const shape = () => report(klass, { changed: [{ path: 'data', sha256: sha('f'), bytes: 1, base: REMOTE_DIR_BASE, inline: b64('f') }] })
  await says(machine, shape())
  let passed = false
  const barrier = rigged.files.filesBarrier(klass.id, machine).then(() => {
    passed = true
  })
  await rigged.files.whenIdle()
  await turn()
  assert.equal(passed, false, 'no fast path: the machine holds what no write here says')
  const back = pushOf(machine, klass.id)!
  assert.deepEqual(back.put.map((entry) => entry.path).sort(), ['data', 'data/x.csv'])
  await ack(machine, klass, back.seq)
  await barrier
  // The same with an unrelated push in flight, planned from the very walk the run finds: the run's push is planned anew.
  assert.ok(writeText(klass.id, 'a.py', 'x = 2\n'))
  await eager()
  const flying = pushOf(machine, klass.id)!
  rigged.files.replySent(machine, rigged.files.replyBlock(machine))
  await says(machine, shape())
  const run = rigged.files.filesBarrier(klass.id, machine)
  await rigged.files.whenIdle()
  await turn()
  const planned = pushOf(machine, klass.id)!
  assert.ok(planned.seq > flying.seq)
  assert.ok(planned.put.some((entry) => entry.path === 'data' && entry.dir), 'the folder goes back')
  await ack(machine, klass, planned.seq)
  await run
})

test('a folder deleted here goes from the machine, its files with it, though the copy\'s record names only the files', async () => {
  // A folder a kernel made, its file landed here, the folder deleted before the push that would have named it.
  const machine = machineName()
  const klass = classOn(machine)
  put(klass.dir, 'keep.csv', 'k')
  await inStep(machine, klass)
  await says(machine, report(klass, { changed: [{ path: 'results/out.csv', sha256: sha('o'), bytes: 1, base: null, inline: b64('o') }] }))
  assert.equal(read(klass.dir, 'results/out.csv'), 'o')
  assert.ok(deleteFile(klass.id, 'results'))
  await eager()
  assert.deepEqual(pushOf(machine, klass.id)?.remove, ['results'])
  // A copy rebuilt from a full report, which lists files alone: a folder deleted here while home was down goes too.
  const other = machineName()
  const old = classOn(other, { createdAt: Date.now() - 10 * 60_000 })
  put(old.dir, 'keep.csv', 'k')
  rigged.files.replyBlock(other)
  await says(other, report(old, {
    full: true,
    page: { index: 0, last: true },
    changed: [
      { path: 'keep.csv', sha256: sha('k'), bytes: 1, base: sha('k') },
      { path: 'old/a.csv', sha256: sha('a'), bytes: 1, base: sha('a') },
    ],
  }))
  assert.deepEqual(pushOf(other, old.id)?.remove, ['old'])
})

test('§8.4 · the same conflict said again is one copy, answered with it; a copy that comes by a pull is answered once its bytes landed', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  put(klass.dir, 'utils.py', 'v0')
  put(klass.dir, 'big.csv', 'v0')
  await inStep(machine, klass)
  assert.ok(writeText(klass.id, 'utils.py', 'home v1'))
  const change = { path: 'utils.py', sha256: sha('machine v1'), bytes: 10, base: sha('v0'), inline: b64('machine v1') }
  await says(machine, report(klass, { changed: [change] }))
  // Said again: its verdict lost, or the machine keeping its version aside when this server's push came over it.
  const again = report(klass, { changed: [change] })
  await says(machine, again)
  const copies = fs.readdirSync(klass.dir).filter((name) => name.startsWith('utils ('))
  assert.equal(copies.length, 1, copies.join(', '))
  assert.deepEqual(rigged.files.replyBlock(machine).verdicts.find((one) => one.seq === again.seq)?.refused, [{ path: 'utils.py', why: 'base', copy: copies[0] }])
  // A large one: no verdict before its bytes land, so the machine keeps its version for the pull to send.
  assert.ok(writeText(klass.id, 'big.csv', 'home v1'))
  const big = Buffer.alloc(CLASS_INLINE_BYTES + 10, 6)
  const bigChange = { path: 'big.csv', sha256: sha(big), bytes: big.length, base: sha('v0') }
  const first = report(klass, { changed: [bigChange] })
  const second = report(klass, { changed: [bigChange] })
  await says(machine, first)
  await says(machine, second)
  const before = rigged.files.replyBlock(machine)
  assert.equal(before.verdicts.some((one) => one.seq === first.seq || one.seq === second.seq), false, 'nothing said before the bytes land')
  assert.deepEqual(before.pulls[0]?.paths, [{ path: 'big.csv', sha256: sha(big) }])
  const { target } = rigged.files.pullFor(machine, klass.id, 'big.csv', klass.gen, sha(big), big.length)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'big.csv', sha(big), staged(klass.dir, big)), { accepted: false, why: 'base', copy: target })
  const after = rigged.files.replyBlock(machine).verdicts
  for (const seq of [first.seq, second.seq]) assert.deepEqual(after.find((one) => one.seq === seq)?.refused, [{ path: 'big.csv', why: 'base', copy: target }])
  assert.equal(read(klass.dir, 'big.csv'), 'home v1')
  assert.equal(fs.statSync(path.join(klass.dir, target)).size, big.length)
})

test('«Привезти»: the version brought is the base of the machine\'s next change of it, which the machine\'s record may lack', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  await inStep(machine, klass)
  await says(machine, report(klass, { skipped: [{ path: 'model.pt', bytes: 300 * 1024 * 1024, why: 'size' }] }))
  assert.deepEqual(rigged.files.fetch(klass.id, 'model.pt'), { ok: true })
  const v1 = Buffer.from('model v1')
  rigged.files.pullFor(machine, klass.id, 'model.pt', klass.gen, sha(v1), v1.length)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'model.pt', sha(v1), staged(klass.dir, v1)), { accepted: true })
  // The kernel rewrites it; the machine's record never took the version brought, so it says no base.
  await says(machine, report(klass, { changed: [{ path: 'model.pt', sha256: sha('model v2'), bytes: 8, base: null, inline: b64('model v2') }] }))
  assert.equal(read(klass.dir, 'model.pt'), 'model v2', 'a change of the version brought: applied')
  assert.equal(fs.readdirSync(klass.dir).some((name) => name.startsWith('model (')), false, 'no conflict copy')
})

test('§8.4 · a notebook\'s file is the room\'s while its document is out of memory: the machine\'s removal of it is refused', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  // The server's own notebook rule this time (control.ts · isBookOfRoom), not the rig's.
  const files = new ClassFiles({ clock: rigged.clock, wake: () => undefined, log: () => undefined, seqBase: 100, hooks: { note: () => undefined, changed: () => undefined } })
  useClassFiles(files)
  assert.equal(createBook(klass.id, 'lesson.ipynb').ok, true)
  assert.ok(releaseSessionDoc(klass.id))
  assert.equal(peekSessionDoc(klass.id), null)
  // The file as it lies here now, which the machine's copy agrees on: its removal's base holds.
  const before = read(klass.dir, 'lesson.ipynb')!
  files.noteKernelsBlock(machine, block({ reports: [report(klass, { removed: [{ path: 'lesson.ipynb', base: sha(before) }] })] }))
  await files.whenIdle()
  assert.notEqual(read(klass.dir, 'lesson.ipynb'), null, 'an os.remove on a machine takes no notebook')
  assert.deepEqual(files.replyBlock(machine).verdicts.at(-1)?.refused, [{ path: 'lesson.ipynb', why: 'book' }])
})

test('a pulled file lands within the room\'s limit as the door stages it: its staged bytes are not counted twice', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  await inStep(machine, klass)
  updateResourceSettings({ uploadMb: 1, sessionMb: 16 }, BOUNDS)
  const body = Buffer.alloc(10 * 1024 * 1024, 7)
  await says(machine, report(klass, { changed: [{ path: 'out.bin', sha256: sha(body), bytes: body.length, base: null }] }))
  rigged.files.pullFor(machine, klass.id, 'out.bin', klass.gen, sha(body), body.length)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'out.bin', sha(body), staged(klass.dir, body)), { accepted: true })
  assert.equal(fs.statSync(path.join(klass.dir, 'out.bin')).size, body.length)
})

test('another version of a file this server has stays on the machine over a cap: its row says so, and «Привезти» lands it over this server\'s', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  put(klass.dir, 'model.pt', 'v0 checkpoint')
  await inStep(machine, klass)
  updateClassMachineSettings({ machineFileMb: 1 })
  const v1 = Buffer.alloc(2 * 1024 * 1024, 5)
  await says(machine, report(klass, { changed: [{ path: 'model.pt', sha256: sha(v1), bytes: v1.length, base: sha('v0 checkpoint') }] }))
  const row = roomTree(klass.id).files.find((entry) => entry.path === 'model.pt')
  assert.equal(row?.size, 13, 'the row is this server\'s file')
  assert.deepEqual(row?.newer, { bytes: v1.length, why: 'size' })
  assert.deepEqual(rigged.files.fetch(klass.id, 'model.pt'), { ok: true })
  rigged.files.pullFor(machine, klass.id, 'model.pt', klass.gen, sha(v1), v1.length)
  assert.deepEqual(await rigged.files.landPulled(machine, klass.id, klass.gen, 'model.pt', sha(v1), staged(klass.dir, v1)), { accepted: true })
  assert.equal(fs.statSync(path.join(klass.dir, 'model.pt')).size, v1.length)
  assert.equal(fs.readdirSync(klass.dir).some((name) => name.startsWith('model (')), false, 'no conflict copy')
})

test('a machine failed over is nothing to the room at once: no push is planned for it, its blob scope is empty, its rows go', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  await inStep(machine, klass)
  await says(machine, report(klass, { skipped: [{ path: 'model.pt', bytes: 300 * 1024 * 1024, why: 'size' }] }))
  assert.equal(roomTree(klass.id).files.find((entry) => entry.path === 'model.pt')?.onMachine?.why, 'size')
  // Silence: the slot is lost, and the machine never calls again (a destroyed VM).
  assert.ok(updatePlacement(klass.id, 'room', klass.gen, { state: 'lost', endedAt: Date.now(), reason: 'silence' }))
  const pushes = rigged.files.counts.pushes
  const body = 'x'.repeat(70_000)
  assert.ok(writeText(klass.id, 'after.txt', body))
  await eager()
  assert.equal(rigged.files.counts.pushes, pushes, 'no push for a machine the class left')
  assert.equal(rigged.files.blobFor(machine, sha(body)), null)
  assert.equal(roomTree(klass.id).files.some((entry) => entry.path === 'model.pt'), false)
})

test('each settle keeps its own time: a short one gives up without the long one, which waits on, and one that gave up is no settle', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  await inStep(machine, klass)
  noteCall(machine, Date.now(), null)
  // A cell wrote a large file there: its pull is on its way, and stays so.
  await says(machine, report(klass, { changed: [{ path: 'out.bin', sha256: sha('o'), bytes: CLASS_INLINE_BYTES * 2, base: null }] }))
  let long: boolean | null = null
  let short: boolean | null = null
  void rigged.files.filesSettled(klass.id, 120_000).then((value) => {
    long = value
  })
  void rigged.files.filesSettled(klass.id, 10_000).then((value) => {
    short = value
  })
  rigged.clock.advance(10_000)
  await turn()
  assert.equal(short, false)
  assert.equal(long, null, 'the class end still waits')
  rigged.clock.advance(110_000)
  await turn()
  assert.equal(long, false)
  let next: boolean | null = null
  void rigged.files.filesSettled(klass.id, 15_000).then((value) => {
    next = value
  })
  await turn()
  assert.equal(next, null, 'asked again, and waited for')
  rigged.clock.advance(15_000)
  await turn()
  assert.equal(next, false)
})

test('a settle is answered by a sync sent after its scan had its time, never by one that crossed the scan; the next reply asks again', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  const acked = await inStep(machine, klass)
  noteCall(machine, Date.now(), null)
  let settled: boolean | null = null
  void rigged.files.filesSettled(klass.id, 120_000).then((value) => {
    settled = value
  })
  rigged.files.replySent(machine, rigged.files.replyBlock(machine))
  // The machine's next sync leaves the moment that reply comes, before its scan hashed anything: nothing pending, it says.
  await ack(machine, klass, acked)
  rigged.clock.advance(3_000)
  await rigged.files.whenIdle()
  await turn()
  assert.equal(settled, null, 'a sync that crossed the scan answers nothing')
  // The scan had its time: the next reply asks again (an answer at once to the held sync), and the sync after it settles.
  const asked = rigged.files.replyBlock(machine)
  assert.deepEqual(asked.scan, [{ sessionId: klass.id }])
  rigged.files.replySent(machine, asked)
  await ack(machine, klass, acked)
  await turn()
  assert.equal(settled, true)
})

test('a page build waits for its class\'s machines before the publish queue, never in it: another class\'s page goes meanwhile', async () => {
  const machine = machineName()
  const klass = classOn(machine)
  await inStep(machine, klass)
  noteCall(machine, Date.now(), null)
  await says(machine, report(klass, { changed: [{ path: 'out.bin', sha256: sha('o'), bytes: CLASS_INLINE_BYTES * 2, base: null }] }))
  const building = buildAndWrite(klass.id, { notebooks: [], files: [], autoRefresh: false, ack: [] }, { by: null })
  const other = `cf-other-${randomUUID().slice(0, 6)}`
  createSession(other, 'Other', 'base')
  const elsewhere = await Promise.race([refreshPage(other, { by: null }), new Promise((resolve) => setImmediate(() => resolve('queued')))])
  assert.notEqual(elsewhere, 'queued', 'a class waiting for its machine holds no other class\'s page')
  rigged.clock.advance(15_000)
  await building
})

/* --------------------------------------------- the kernel at the barrier */

/** A placement module that keeps every slot here as far as the kernel hooks ask (the files ask the store), and sends the news a test gives it. */
function newsPlacements(): { impl: ClassPlacements; emit: (event: PlacementEvent) => void } {
  const listeners = new Set<(event: PlacementEvent) => void>()
  class Lost extends Error {
    readonly words = ''
  }
  const impl: ClassPlacements = {
    placementOf: () => ({ where: 'home' }),
    placementGate: () => Promise.resolve(),
    onPlacementChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    moveNow: async () => ({ refused: 'no' }),
    helpPadMs: () => 0,
    PlacementLost: Lost,
  }
  return {
    impl,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

/**
 * A class whose kernel runs here (the fake Jupyter), then its room slot is
 * placed on a machine: the kernel this process holds stays, and the cell's
 * next run meets the barrier of that machine's copy, which nobody acks.
 */
async function kernelAtBarrier(t: TestContext, marker: string) {
  fakeJupyter ??= await startFakeJupyter({ guardAnswer, interpreter: true, buffer: true, keepAlive: false })
  useDefaultEndpointForTest({ url: fakeJupyter.url, token: 'fake' })
  const news = newsPlacements()
  useClassPlacements(news.impl)
  const id = `cfk${++seq}${randomUUID().slice(0, 6)}`
  createSession(id, `Kernel ${seq}`, 'base')
  const cells = getCells(getSessionDoc(id).doc)
  cells.push([createCell('code', 'x = 1')])
  const cell = cells.toArray().filter((one) => cellType(one) === 'code').at(-1)!
  const machine = machineName()
  let gen = 0
  t.after(async () => {
    if (gen) updatePlacement(id, 'room', gen, { state: 'stopped', endedAt: Date.now() })
    await shutdownSession(id).catch(() => undefined)
    useClassPlacements(null)
    useDefaultEndpointForTest(null)
  })
  const run = () => requestRun(id, [cellId(cell)], 'Teacher', 'p_teacher', undefined, CELLS_KEY)
  run()
  assert.ok(await until(() => cell.get('state') === 'ok'), 'the kernel here runs a cell')
  gen = placeOn(id, machine).gen
  const text = cellSource(cell)
  text.delete(0, text.length)
  text.insert(0, `print("${marker}")`)
  run()
  assert.ok(await until(() => cell.get('state') === 'running' && pushOf(machine, id) !== null), 'the cell waits at the barrier')
  return { id, cell, machine, gen, news, ran: () => fakeJupyter!.requests.some((request) => request.code.includes(marker)) }
}

test('Stop on a cell waiting at the files barrier ends it unrun: it is at rest, and the kernel never hears of it', async (t) => {
  const room = await kernelAtBarrier(t, 'stopped-at-the-barrier')
  await interruptSession(room.id, cellId(room.cell))
  assert.ok(await until(() => room.cell.get('state') === 'idle'), `the cell is ${String(room.cell.get('state'))}`)
  // The files land after all: the cell stays unrun.
  await ack(room.machine, { id: room.id, gen: room.gen }, pushOf(room.machine, room.id)!.seq)
  await turn()
  assert.equal(room.ran(), false)
  assert.equal(room.cell.get('state'), 'idle')
})

test('news that the class left its machine lets a cell waiting at the barrier go at once, not at the stall', async (t) => {
  const room = await kernelAtBarrier(t, 'went-on-with-the-news')
  assert.ok(updatePlacement(room.id, 'room', room.gen, { state: 'stopped', endedAt: Date.now() }))
  room.news.emit({ sessionId: room.id, role: 'room', kind: 'stopped', view: { where: 'home' }, at: Date.now() })
  assert.ok(await until(() => room.cell.get('state') === 'ok'), `the cell is ${String(room.cell.get('state'))}`)
  assert.equal(room.ran(), true)
})

/* ------------------------------------------------- the doors, after review */

/** Whether a sync was answered without being held for news (wake.ts counts the held ones). */
async function answeredAtOnce(machine: Machine, call: Promise<unknown>): Promise<boolean> {
  let done = false
  void call.then(() => (done = true), () => (done = true))
  for (let poll = 0; poll < 5_000 && !done; poll++) {
    if (heldSyncs() > 0) {
      wakeRunner(machine.runnerId)
      await call
      return false
    }
    await turn()
  }
  await call
  return true
}

test('a page of a full report said again replaces the one kept, the last one after its rebuild is nothing, and every page but the last is answered at once', async () => {
  reset()
  rigged = rig()
  const machine = await joinedMachine()
  // Placed before this life of the server (reset() dates the life ten minutes back): rebuilt from the machine's full report.
  const klass = classOn(machine.runnerId, { createdAt: Date.now() - 20 * 60_000 })
  put(klass.dir, 'a.csv', 'a')
  const page = (index: number, last: boolean, changed: RemoteFilesReport['changed']) => report(klass, { full: true, page: { index, last }, changed })
  const sync = (reports: RemoteFilesReport[], holdMs = 0) => machine.sync(syncRequest({ holdMs, kernels: block({ placements: [held(klass.id, klass.gen, 7)], reports }) }))
  assert.deepEqual(parseRemoteSyncReply((await sync([])).body).kernels?.scan, [{ sessionId: klass.id, full: true }])
  await sync([page(0, false, [{ path: 'a.csv', sha256: sha('a'), bytes: 1, base: sha('a') }])])
  // The next page comes only with the next sync: one held for news would be ten seconds a page.
  assert.equal(await answeredAtOnce(machine, sync([page(1, false, [])], 10_000)), true)
  // The same page said again (the answer to its sync lost): kept in its place, nothing asked again.
  await sync([page(1, false, [])])
  const down = { path: 'down.csv', sha256: sha('written while home was down'), bytes: CLASS_INLINE_BYTES * 2, base: null }
  await sync([page(2, true, [down])])
  await rigged.files.whenIdle()
  const rebuilt = parseRemoteSyncReply((await sync([])).body).kernels
  assert.deepEqual(rebuilt?.scan, [], 'the walk was whole')
  assert.deepEqual(rebuilt?.pulls, [{ sessionId: klass.id, gen: klass.gen, paths: [{ path: 'down.csv', sha256: down.sha256 }] }])
  // Its last page said again after the rebuild: nothing to do.
  await sync([page(2, true, [down])])
  assert.deepEqual(parseRemoteSyncReply((await sync([])).body).kernels?.scan, [])
})

test('a class\'s files have rate buckets of their own: a machine at its submissions\' limits still fetches and sends its class\'s files', async () => {
  reset()
  rigged = rig()
  const machine = await joinedMachine()
  const klass = classOn(machine.runnerId)
  const big = Buffer.alloc(CLASS_INLINE_BYTES + 10, 4)
  put(klass.dir, 'data.bin', big)
  await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, 0)] }) }))
  await eager()
  const out = Buffer.alloc(CLASS_INLINE_BYTES * 2, 9)
  await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, 0)], reports: [report(klass, { changed: [{ path: 'out.bin', sha256: sha(out), bytes: out.length, base: null }] })] }) }))
  await rigged.files.whenIdle()
  // A minute's worth of result uploads and of competition blobs (an attempt and a blob nobody has: answered, and counted).
  for (let batch = 0; batch < 12; batch++) {
    await Promise.all(Array.from({ length: 50 }, async () => {
      await (await machine.call('GET', `blobs/${'e'.repeat(64)}`)).arrayBuffer()
      await (await machine.call('PUT', `attempts/${'a'.repeat(32)}/files/submission.csv`, { raw: zlib.gzipSync('x'), headers: { 'content-encoding': 'gzip' } })).arrayBuffer()
    }))
  }
  const limited = await machine.call('GET', `blobs/${'e'.repeat(64)}`)
  await limited.arrayBuffer()
  assert.equal(limited.status, 429, 'the submissions\' bucket is full')
  const blob = await machine.call('GET', `blobs/${sha(big)}`)
  assert.equal(blob.status, 200, 'a blob of its class\'s push')
  assert.equal(Buffer.from(await blob.arrayBuffer()).equals(big), true)
  assert.equal((await putRoomFile(machine, klass.id, 'out.bin', klass.gen, out)).status, 200, 'a file its kernel wrote')
})

test('a refused PUT of a file in a new folder leaves no folder behind: its folders are made when the checked bytes land', async () => {
  reset()
  rigged = rig()
  const machine = await joinedMachine()
  const klass = classOn(machine.runnerId)
  const big = Buffer.alloc(CLASS_INLINE_BYTES * 2, 9)
  await machine.sync(syncRequest({ kernels: block({ placements: [held(klass.id, klass.gen, 0)], reports: [report(klass, { changed: [{ path: 'deep/new/out.bin', sha256: sha(big), bytes: big.length, base: null }] })] }) }))
  await rigged.files.whenIdle()
  assert.equal((await putRoomFile(machine, klass.id, 'deep/new/out.bin', klass.gen, Buffer.alloc(big.length, 1), { sha256: sha(big) })).status, 422)
  assert.equal(fs.existsSync(path.join(klass.dir, 'deep')), false)
  assert.deepEqual(fs.readdirSync(klass.dir).filter((name) => name.startsWith('.')), [], 'nor a temporary name')
  assert.equal((await putRoomFile(machine, klass.id, 'deep/new/out.bin', klass.gen, big)).status, 200)
  assert.equal(fs.statSync(path.join(klass.dir, 'deep/new/out.bin')).size, big.length)
})

test('a verdict in a reply the machine never took in goes again in the next answer, once; one it took in does not; an agent that says nothing hears each once', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  await inStep(machine, klass)
  // The reply the agent last took in, as its blocks say from now on (RemoteKernelsRequest.heard).
  const before = rigged.files.replyBlock(machine)
  rigged.files.replySent(machine, before)
  const taken = before.replySeq!
  assert.ok(Number.isSafeInteger(taken), 'every reply is numbered')
  const agent = async (heard: number, reports: RemoteFilesReport[] = []): Promise<void> => {
    rigged.files.noteKernelsBlock(machine, block({ heard, reports }))
    await rigged.files.whenIdle()
  }
  const row = report(klass, { changed: [{ path: 'out.csv', sha256: sha('a,b\n'), bytes: 4, base: null, inline: b64('a,b\n') }] })
  await agent(taken, [row])
  const said = { sessionId: klass.id, seq: row.seq, accepted: ['out.csv'], refused: [] }
  const first = rigged.files.replyBlock(machine)
  assert.deepEqual(first.verdicts, [said])
  rigged.files.replySent(machine, first)
  assert.ok(first.replySeq! > taken)
  // The agent cut that sync short for news: its next block says it took in only the reply before. The verdict goes again.
  await agent(taken)
  const again = rigged.files.replyBlock(machine)
  assert.deepEqual(again.verdicts, [said], 'said again, not after the agent\'s minute')
  rigged.files.replySent(machine, again)
  // Taken in this time: nothing more of it, however often the agent says so.
  await agent(again.replySeq!)
  assert.deepEqual(rigged.files.replyBlock(machine).verdicts, [])
  await agent(again.replySeq!)
  assert.deepEqual(rigged.files.replyBlock(machine).verdicts, [])
  // An agent that never says what it took in (one before the field) hears a verdict once, as before.
  const late = report(klass, { changed: [{ path: 'late.csv', sha256: sha('c\n'), bytes: 2, base: null, inline: b64('c\n') }] })
  await says(machine, late)
  const once = rigged.files.replyBlock(machine)
  assert.deepEqual(once.verdicts.map((one) => one.seq), [late.seq])
  rigged.files.replySent(machine, once)
  await says(machine)
  assert.deepEqual(rigged.files.replyBlock(machine).verdicts, [])
})

test('a pull the machine holds nothing pending for is let go a minute on: no settle waits on it for good', async () => {
  const machine = `m-${randomUUID().slice(0, 6)}`
  const klass = classOn(machine)
  const pushSeq = await inStep(machine, klass)
  // The kernel wrote a file too large to ride inline: home asks for its bytes.
  await says(machine, report(klass, { changed: [{ path: 'big.bin', sha256: sha('the bytes'), bytes: 300_000, base: null }] }))
  assert.equal(rigged.files.pendingUnder(klass.id, 'big.bin'), true)
  const sync = async (pending: number): Promise<void> => {
    rigged.files.noteKernelsBlock(machine, block({ placements: [{ ...held(klass.id, klass.gen, pushSeq), files: { pushSeq, pending, pendingBytes: pending * 300_000, heldOnly: 0, heldOnlyBytes: 0 } }] }))
    await rigged.files.whenIdle()
  }
  // While the machine says the change is pending there, its pull waits however long it takes.
  rigged.clock.advance(120_000)
  await sync(1)
  assert.equal(rigged.files.pendingUnder(klass.id, 'big.bin'), true, 'a slow upload is no lost one')
  // Its agent restarted and kept nothing of it: nothing pending there, and the pull is let go.
  await sync(0)
  assert.equal(rigged.files.pendingUnder(klass.id, 'big.bin'), false)
  assert.deepEqual(rigged.files.replyBlock(machine).pulls, [], 'never asked again')
  // A pull asked a moment ago is not: the machine's next scan says it.
  await says(machine, report(klass, { changed: [{ path: 'next.bin', sha256: sha('next'), bytes: 300_000, base: null }] }))
  await sync(0)
  assert.equal(rigged.files.pendingUnder(klass.id, 'next.bin'), true)
})
