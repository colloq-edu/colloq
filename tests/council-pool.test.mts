/**
 * The council's pool of workers at home (docs/architecture/remote-classes.md
 * §9.2, §9.5–9.10): kernel/council-pool.ts in front of kernel/index.ts's
 * unchanged pumps, and the epochs of kernel/remote/epochs.ts.
 *
 * The class's council placement is a fake (`useClassPlacements`, as
 * class-kernel-hooks.test.mts has it), every kernel is the fake Jupyter
 * behind a road of its own (startFakeLink), and what a machine says it holds
 * of an epoch is told by the test as its sync would (`noteEpochStates`). The
 * pool's clock is moved by hand; the five seconds of D8, the minutes of the
 * shrink and the linger pass with it, never by waiting. Everything else is
 * polled for.
 */
import './_env.mts'
import { after, afterEach, before, beforeEach, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { WebSocket } from 'ws'
import { guardAnswer } from './_guard.mts'
import { startFakeJupyter, startFakeLink } from './_fake-jupyter.mjs'
import type { ClassClock, ClassPlacements, PlacementEvent, PlacementView } from '../server/src/kernel/index.js'
import type { TokenPayload } from '../server/src/auth.js'
import type { ControlServerMessage, CouncilRun } from '../shared/protocol.js'
import { COUNCIL_EPOCH_MB, COUNCIL_POOL_READY_MS, COUNCIL_WORKER_BASE_MB } from '../shared/remote-kernels.js'
import { classHashSeed } from '../server/src/kernel/room-spec.js'

process.env.KERNEL_QUIET_MS = '150'
process.env.KERNEL_WATCHDOG_MS = '50'

let kernel: typeof import('../server/src/kernel/index.js')
let pool: typeof import('../server/src/kernel/council-pool.js')
let epochs: typeof import('../server/src/kernel/remote/epochs.js')
let jupyter: typeof import('../server/src/kernel/jupyter.js')
let notebook: typeof import('../shared/notebook.js')
let db: typeof import('../server/src/db.js')
let collab: typeof import('../server/src/collab/index.js')
let control: typeof import('../server/src/control.js')
let tr: typeof import('../shared/i18n.js').tr
let fake: Awaited<ReturnType<typeof startFakeJupyter>>

before(async () => {
  fake = await startFakeJupyter({ guardAnswer, interpreter: true, buffer: true, keepAlive: false })
  kernel = await import('../server/src/kernel/index.js')
  pool = await import('../server/src/kernel/council-pool.js')
  epochs = await import('../server/src/kernel/remote/epochs.js')
  jupyter = await import('../server/src/kernel/jupyter.js')
  notebook = await import('../shared/notebook.js')
  db = await import('../server/src/db.js')
  collab = await import('../server/src/collab/index.js')
  control = await import('../server/src/control.js')
  tr = (await import('../shared/i18n.js')).tr
  kernel.setCouncilLimitTick(20)
})

beforeEach(async () => {
  const { setInstanceLanguage } = await import('../server/src/admin/settings.js')
  setInstanceLanguage('ru')
  fake.councilRuns.export = 0
  fake.councilRuns.load = 0
  fake.councilRuns.enter = 0
  fake.councilRuns.leave = 0
  fake.councilRuns.drop = 0
})

afterEach(() => {
  fake.reset()
  fake.resetHoldPeak()
  kernel.useClassPlacements(null)
  jupyter.useDefaultEndpointForTest(null)
  pool.usePoolSetting(null)
  pool.usePoolClock(null)
  pool.usePoolRoom(null)
  pool.usePoolOnline(null)
  pool.useEpochPython(null)
  epochs.useEpochCollector(null)
  pool.resetPoolsForTest()
  epochs.resetEpochsForTest()
})

after(async () => {
  kernel.setCouncilLimitTick(1000)
  await kernel.shutdownKernels()
  await fake.close()
  collab.shutdownCollab()
})

/* ------------------------------------------------------------------ helpers */

const NAME = 'vast-3'
/** The notebook kernel's container on the machine: a placement's, as the contract names one. */
const CONTAINER = 'c0ffee'.padEnd(64, '0')
const POOL_WAIT_MS = 5_000

async function until(what: () => boolean, polls = 400): Promise<boolean> {
  for (let poll = 0; poll < polls; poll++) {
    if (what()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return what()
}

/** Let the event loop turn: what was going to happen without a timer has happened by then. */
async function turns(count = 50): Promise<void> {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve))
}

/** A clock the test moves: the timers of the hooks and of the pool fire as it passes them, in order. */
function handClock(start = Date.now()) {
  let now = start
  const timers: Array<{ at: number; run: () => void }> = []
  const clock: ClassClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + Math.max(0, ms), run }
      timers.push(timer)
      return timer
    },
    clearTimeout: (handle) => {
      const at = timers.indexOf(handle as (typeof timers)[number])
      if (at >= 0) timers.splice(at, 1)
    },
  }
  return {
    clock,
    get now() {
      return now
    },
    advance(ms: number) {
      now += ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const due = timers[0]
        if (!due || due.at > now) return
        timers.shift()
        due.run()
      }
    },
  }
}

class PlacementLost extends Error {
  constructor(
    readonly words: string,
    readonly cause: string,
  ) {
    super(words)
    this.name = 'PlacementLost'
  }
}

/** A placement module whose slots the test sets, and whose news the test sends. */
function fakePlacements() {
  const views = new Map<string, PlacementView>()
  const listeners = new Set<(event: PlacementEvent) => void>()
  const key = (sessionId: string, role: string) => `${sessionId}:${role}`
  /** The durable stops asked of a slot: role and gen. */
  const stops: Array<{ role: string; gen: number }> = []
  const impl: ClassPlacements = {
    placementOf: (sessionId, role) => views.get(key(sessionId, role)) ?? { where: 'home' },
    placementGate: () => Promise.resolve(),
    onPlacementChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    moveNow: async () => ({ ok: true }),
    helpPadMs: () => 0,
    PlacementLost,
    stopSlot: (_sessionId, role, gen) => {
      stops.push({ role, gen })
      return true
    },
  }
  return {
    impl,
    stops,
    set: (sessionId: string, role: string, view: PlacementView) => views.set(key(sessionId, role), view),
    emit: (event: PlacementEvent) => {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

let seq = 0

/**
 * A class whose council computes on a pretend machine «vast-3»: its notebook
 * kernel and its council slot placed there and ready, every kernel the fake
 * behind a road, the pool's setting, clock and room the test's. Its first
 * code cell is the teacher's, its second the council's.
 */
async function poolClass(
  t: TestContext,
  options: {
    sources?: string[]
    workers?: 'auto' | number
    council?: 'machines' | 'shared'
    lane?: 'pool' | 'shared'
    refresh?: 'auto' | 'manual'
    /** The pool on a machine of its own («vast-7», r2), its road apart from the notebook kernel's: the workers start on it (toWorkers). */
    split?: boolean
    /** The notebook's kernel here, on this server: no road, and its export copied out of its container into the store. */
    home?: boolean
    /** The council cell starts locked; the teacher opens it (cell:lock). */
    closed?: boolean
  } = {},
) {
  const hand = handClock()
  const places = fakePlacements()
  kernel.useClassPlacements(places.impl, hand.clock)
  const road = await startFakeLink({ target: fake.port })
  const poolRoad = options.split ? await startFakeLink({ target: fake.port }) : road
  const poolRunner = options.split ? 'r2' : 'r1'
  if (options.home) jupyter.useDefaultEndpointForTest({ url: fake.url, token: 'fake' })
  else jupyter.useDefaultEndpointForTest({ url: road.url, token: 'fake', link: road.link, identity: `machine:r1:${CONTAINER}:1` })
  const id = `pool${seq++}`
  db.createSession(id, `Pool ${id}`)
  const { doc } = collab.getSessionDoc(id)
  const cells = notebook.getCells(doc)
  // Beside the first cell a new notebook has: the test's own, from index 0.
  const before = cells.length
  for (const source of options.sources ?? ['x = 5', '']) cells.push([notebook.createCell('code', source)])
  const code = () => cells.toArray().slice(before).filter((cell) => notebook.cellType(cell) === 'code')
  const councilCell = code()[1]!
  if (!options.closed) {
    councilCell.set('open', 'council')
    councilCell.set('council', { ...notebook.DEFAULT_COUNCIL, lane: options.lane ?? 'pool', refresh: options.refresh ?? 'auto' })
  }
  const view = (over: Partial<Extract<PlacementView, { where: 'machine' }>> = {}): PlacementView => ({
    where: 'machine',
    runnerId: 'r1',
    name: NAME,
    gen: 1,
    state: 'ready',
    link: road.link,
    since: hand.now,
    failover: 'auto',
    failoverAt: null,
    ...over,
  })
  places.set(id, 'room', view())
  places.set(id, 'council', options.split ? view({ runnerId: 'r2', name: 'vast-7', link: poolRoad.link }) : view())
  const setting = { council: options.council ?? 'machines', workers: options.workers ?? 2, attemptMb: 1024 } as const
  const live = { ...setting } as { council: 'machines' | 'shared'; workers: 'auto' | number; attemptMb: number }
  pool.usePoolSetting((sessionId) => (sessionId === id ? live : { council: 'shared', workers: 'auto', attemptMb: 1024 }))
  pool.usePoolClock(hand.clock)
  const resizes: Array<{ memoryMb: number; cpus: number; workers: number }> = []
  const room = { memoryMb: 4096, freeMb: 60_000, readyBefore: false }
  pool.usePoolRoom({
    room: async () => room,
    resize: async (_sessionId, memoryMb, cpus, workers) => {
      resizes.push({ memoryMb, cpus, workers })
      return 'applied'
    },
    readyBefore: () => room.readyBefore,
  })
  const people = { online: 0 }
  pool.usePoolOnline((sessionId) => (sessionId === id ? people.online : 0))
  t.after(async () => {
    pool.councilDiscarded(id)
    await kernel.shutdownSession(id).catch(() => {})
    await road.close()
    if (poolRoad !== road) await poolRoad.close()
  })
  const cell = (index: number) => {
    const one = code()[index]!
    return {
      id: notebook.cellId(one),
      state: () => one.get('state') as string,
      type(source: string) {
        const text = notebook.cellSource(one)
        text.delete(0, text.length)
        text.insert(0, source)
      },
    }
  }
  /** What the pool's machine says it holds: every epoch of the notebook home could use, ready there (its agent's sync). */
  const held = new Map<number, { sessionId: string; root: string; seq: number; ready: boolean; failed?: 'source' | 'files' | 'disk' }>()
  const holdWanted = () => {
    for (const epoch of epochs.epochsOf(id, notebook.CELLS_KEY)) {
      if (epoch.trouble === null && !held.has(epoch.seq)) held.set(epoch.seq, { sessionId: id, root: notebook.CELLS_KEY, seq: epoch.seq, ready: true })
    }
    epochs.noteEpochStates(poolRunner, [...held.values()])
  }
  return {
    id,
    doc,
    hand,
    places,
    road,
    poolRoad,
    poolRunner,
    view,
    /** From now on kernels start on the pool's road, as the pool's machine: its workers. */
    toWorkers: () => {
      if (options.split) jupyter.useDefaultEndpointForTest({ url: poolRoad.url, token: 'fake', link: poolRoad.link, identity: `machine:r2:${CONTAINER.replace(/^c/, 'd')}:1` })
    },
    live,
    resizes,
    room,
    people,
    cell,
    councilCellId: notebook.cellId(councilCell),
    held,
    holdWanted,
    /** The teacher runs code cells by index in the notebook's kernel. */
    run: (...indices: number[]) =>
      kernel.requestRun(id, indices.map((index) => cell(index).id), 'Teacher', 'p_teacher', undefined, notebook.CELLS_KEY),
    /** One author's attempt at the council cell; its card's frames, in order. */
    attempt(participantId: string, source: string, by: 'author' | 'host' = 'author', limitSec: number | null = null) {
      const frames: Array<CouncilRun | null> = []
      const answer = kernel.requestCouncilRun(
        id,
        { cellId: notebook.cellId(councilCell), participantId, source, by, limitSec, onChange: (run) => frames.push(run) },
        by === 'host' ? 'Teacher' : participantId,
        by === 'host' ? 'p_teacher' : participantId,
        { lane: options.lane ?? 'pool', refresh: options.refresh ?? 'auto' },
      )
      return {
        answer,
        frames,
        last: () => frames.at(-1) ?? null,
        said: () =>
          (frames.at(-1)?.outputs ?? [])
            .map((output) => (output.kind === 'stream' ? output.text : output.kind === 'error' ? output.evalue : ''))
            .join(''),
      }
    },
    /** The pool of the notebook, by its own record. */
    pool: () => pool.poolForTest(id, notebook.CELLS_KEY),
    /** The console's view of it (CouncilKernel.pool). */
    console: () => kernel.kernelWorkOf(id, notebook.cellId(councilCell))?.pool ?? null,
    workerKernel: (n: number) => fake.kernelAt(`${id}/session-cells-w${n}.ipynb`),
    mainKernel: () => fake.kernelAt(`${id}/session.ipynb`),
  }
}

type PoolRoom = Awaited<ReturnType<typeof poolClass>>

/** The epoch's stream, MB: what each worker's load unpickles into memory of its own, beside the shared buffers (§9.5). */
function streamMbOf(epoch: { files: { body: string; buffers: Array<{ sha256: string; bytes: number }> } | null } | null): number {
  const files = epoch?.files
  return files ? Math.ceil((files.buffers.find((file) => file.sha256 === files.body)?.bytes ?? 0) / (1024 * 1024)) : 0
}

/** A pool of the class's notebook up: the teacher's cell run, the council opened, the epoch held on the machine, every worker loaded. */
async function readyPool(t: TestContext, options: Parameters<typeof poolClass>[1] = {}) {
  const room = await poolClass(t, options)
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'), `the teacher's cell is ${room.cell(0).state()}`)
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false), 'the epoch was never taken')
  room.holdWanted()
  const size = room.pool()!.size
  assert.ok(
    await until(() => (room.pool()?.workers ?? []).filter((worker) => worker.seeded !== null).length === size),
    JSON.stringify(room.pool()),
  )
  return room
}

/** What the fake logged of a call, and of a request to run (the fake is plain JavaScript). */
type FakeCall = { kind: string; method?: string; path: string }
type FakeRequest = { code: string; kernel?: string; silent?: boolean; store_history?: boolean }

/** Requests of one kind the fake received: HTTP by method and path. */
const http = (method: string, pattern: RegExp): number =>
  (fake.calls as FakeCall[]).filter((call) => call.kind === 'http' && call.method === method && pattern.test(call.path)).length

/** The code one kernel was asked to run, in order (its id: `fake.kernelAt`). */
const ranIn = (kernelId: string | null): string[] =>
  (fake.requests as FakeRequest[]).filter((request) => kernelId !== null && request.kernel === kernelId).map((request) => request.code)

const doneStates = new Set(['ok', 'error', 'cancelled'])

/* --------------------------------------------------------- no pool, no change */

test('a class whose council computes in the shared kernel meets no pool: its attempts go to the notebook\'s queue unmarked, and nothing of a pool is made', async (t) => {
  const room = await poolClass(t, { council: 'shared' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => doneStates.has(attempt.last()?.state ?? '')), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '5\n')
  for (const frame of attempt.frames) {
    assert.equal(frame?.placed, undefined, 'a shared class\'s attempt was marked')
    assert.equal(frame?.note, undefined)
  }
  assert.equal(room.pool(), null, 'a pool was made for a class whose council is shared')
  assert.equal(room.console(), null, 'the console was told of a pool')
  assert.equal(fake.councilRuns.export, 0, 'an epoch was taken')
  assert.equal(room.workerKernel(1), null, 'a worker was started')
})

test('a council cell whose attempts go to the shared kernel by the teacher\'s choice is not marked, in a class whose council is on machines', async (t) => {
  const room = await readyPool(t, { lane: 'shared' })
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => doneStates.has(attempt.last()?.state ?? '')))
  assert.equal(attempt.said(), '5\n')
  assert.ok(attempt.frames.every((frame) => frame?.placed === undefined), JSON.stringify(attempt.frames.map((frame) => frame?.placed)))
  assert.equal(fake.councilRuns.enter, 0, 'a worker\'s entry ran')
})

/* ------------------------------------------------------------- the route */

test('an attempt pressed before the pool is ready runs in the notebook\'s kernel, its card saying the pool is still starting', async (t) => {
  const room = await poolClass(t)
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  // The machine has not said it holds the epoch: no worker is loaded yet.
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => doneStates.has(attempt.last()?.state ?? '')), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '5\n')
  const queued = attempt.frames[0]!
  assert.equal(queued.state, 'queued')
  assert.equal(queued.placed, 'shared')
  assert.equal(queued.note, tr('server.thePoolIsStillStartingThisAttempt.bf84be'))
  assert.equal(attempt.last()?.placed, 'shared', 'the footnote was lost on the way to the end')
  assert.equal(fake.councilRuns.enter, 0)
})

test('opening a council takes an epoch between the teacher\'s cells, the workers load it, and an attempt runs on a worker with the notebook\'s state, the notebook\'s queue never holding it', async (t) => {
  const room = await poolClass(t, { sources: ['HOLD teacher\nx = 5', ''] })
  room.run(0)
  assert.ok(await until(() => fake.holding('teacher') === 1))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  await turns()
  // The export waits behind the teacher's running cell: a service item at the head of the notebook's queue, never under it.
  assert.equal(fake.councilRuns.export, 0, 'the export ran under the teacher\'s cell')
  assert.ok(await until(() => (room.pool()?.workers ?? []).length === 2 && room.workerKernel(2) !== null), JSON.stringify(room.pool()))
  fake.release('teacher')
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  assert.equal(room.cell(0).state(), 'ok')
  const [epoch] = epochs.epochsOf(room.id, notebook.CELLS_KEY)
  assert.ok(epoch, 'no epoch was recorded')
  assert.equal(epoch.trouble, null)
  assert.deepEqual(epoch.carried, ['x'])
  assert.deepEqual(epoch.source, { runnerId: 'r1', role: 'room', container: CONTAINER, gen: 1 })
  // The registry has it, for the next life of this server.
  assert.deepEqual(db.councilEpochsOf(room.id, notebook.CELLS_KEY).map((row) => row.seq), [epoch.seq])
  // The export was silent and kept no history: the notebook's kernel counted one run, the teacher's.
  const exported = (fake.requests as FakeRequest[]).find((request) => request.code.includes('.export(globals()'))!
  assert.equal(exported.silent, true)
  assert.equal(exported.store_history, false)
  // The machine is asked to hold it, from the notebook kernel's own container there.
  const [intent] = epochs.epochIntentsFor('r1')
  assert.deepEqual(intent?.from, { container: CONTAINER, dir: `/tmp/colloq-epoch/${epoch.seq}` })
  assert.equal(room.console()?.state, 'starting', 'the pool said it was ready before its machine held the epoch')
  room.holdWanted()
  assert.ok(await until(() => room.pool()!.workers.every((worker) => worker.seeded === epoch.seq)), JSON.stringify(room.pool()))
  assert.equal(fake.councilRuns.load, 2)
  assert.equal(room.console()?.state, 'ready')

  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => doneStates.has(attempt.last()?.state ?? '')), JSON.stringify(attempt.last()))
  assert.equal(attempt.last()?.state, 'ok')
  assert.equal(attempt.said(), '5\n', 'the worker did not hold the notebook\'s state')
  assert.equal(attempt.last()?.placed, 'pool')
  assert.equal(attempt.last()?.epoch?.seq, epoch.seq)
  assert.equal(attempt.last()?.epoch?.behind, 0)
  assert.match(attempt.last()?.runId ?? '', /^[0-9a-f]{32}$/)
  assert.equal(fake.councilRuns.enter, 1, 'the worker\'s entry did not run')
  // The attempt never stood in the notebook's queue, nor ran in its kernel: a worker ran it.
  assert.ok(!ranIn(room.mainKernel()).includes('print(x)'), 'the attempt ran in the notebook\'s kernel')
  assert.equal([1, 2].filter((n) => ranIn(room.workerKernel(n)).includes('print(x)')).length, 1)
})

/* ------------------------------------------------------------ the workers */

test('twelve attempts on four workers compute four at a time beside a teacher\'s cell held in the notebook\'s kernel, and none of them waits for it', async (t) => {
  const room = await readyPool(t, { workers: 4, refresh: 'manual', sources: ['x = 5', '', 'HOLD teacher'] })
  room.run(2)
  assert.ok(await until(() => fake.holding('teacher') === 1))
  fake.resetHoldPeak()
  const attempts = Array.from({ length: 12 }, (_, n) => room.attempt(`p_s${n}`, `HOLD a\nprint(x + ${n})`))
  assert.ok(await until(() => fake.holding('a') === 4), `holding ${fake.holding('a')}`)
  await turns()
  assert.equal(fake.holding('a'), 4, 'more attempts computed at once than there are workers')
  const shown = room.console()!
  assert.equal(shown.workers, 4)
  assert.equal(shown.busy, 4)
  assert.equal(shown.queued, 8)
  // Their places: among the pool's waiting attempts alone, the running ones computing (0).
  const places = kernel.councilQueuePositions(room.id).map((one) => one.position).sort((a, b) => a - b)
  assert.deepEqual(places, [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(attempts.filter((_, n) => kernel.councilQueuePosition(room.id, room.councilCellId, `p_s${n}`) === 0).length, 4)
  for (let round = 0; round < 3; round++) {
    assert.ok(await until(() => fake.holding('a') === 4), `round ${round}: holding ${fake.holding('a')}`)
    fake.release('a')
  }
  assert.ok(await until(() => attempts.every((one) => doneStates.has(one.last()?.state ?? ''))), attempts.map((one) => one.last()?.state).join(','))
  assert.equal(fake.holdPeak('a'), 4)
  attempts.forEach((one, n) => {
    assert.equal(one.last()?.state, 'ok')
    assert.equal(one.said(), `${5 + n}\n`)
    assert.equal(one.last()?.placed, 'pool')
  })
  // The teacher's cell held the notebook's kernel the whole time.
  assert.equal(room.cell(2).state(), 'running')
  fake.release('teacher')
  assert.ok(await until(() => room.cell(2).state() === 'ok'))
})

test('the teacher\'s attempts go ahead of the authors\' waiting in the pool, a press of the same text keeps its place, and an edit replaces it in place', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const first = room.attempt('p_s1', 'HOLD one')
  assert.ok(await until(() => fake.holding('one') === 1))
  const second = room.attempt('p_s2', 'print(2)')
  const third = room.attempt('p_s3', 'print(3)')
  assert.equal(second.answer.position, 1)
  assert.equal(third.answer.position, 2)
  // The teacher runs someone's attempt at the board: ahead of every author's (D12).
  const board = room.attempt('p_s4', 'print(4)', 'host')
  assert.equal(board.answer.position, 1)
  assert.equal(kernel.councilQueuePosition(room.id, room.councilCellId, 'p_s2'), 2)
  assert.equal(kernel.councilQueuePosition(room.id, room.councilCellId, 'p_s3'), 3)
  // A second press of the same text: nothing new, the place said.
  const again = room.attempt('p_s3', 'print(3)')
  assert.deepEqual(again.answer, { queued: false, position: 3 })
  // An edited text replaces the waiting one where it stands.
  const edited = room.attempt('p_s2', 'print(22)')
  assert.deepEqual(edited.answer, { queued: true, position: 2 })
  assert.equal(edited.frames[0]?.state, 'queued')
  // One attempt in flight per person: a second text of one computing now is refused with its place.
  const busy = room.attempt('p_s1', 'print(1)')
  assert.deepEqual(busy.answer, { queued: false, position: 0 })
  fake.release('one')
  assert.ok(await until(() => [board, edited, third].every((one) => one.last()?.state === 'ok')), JSON.stringify([first, board, edited, third, busy].map((one) => one.frames.map((frame) => frame && [frame.state, frame.placed, frame.note]))) + JSON.stringify(room.pool()))
  assert.equal(board.said(), '4\n')
  assert.equal(edited.said(), '22\n')
  assert.equal(third.said(), '3\n')
  // The order they ran in: the teacher's first, then the authors' in the order pressed.
  const ran = ranIn(room.workerKernel(1)).filter((code) => /^print\(\d+\)$/.test(code))
  assert.deepEqual(ran, ['print(4)', 'print(22)', 'print(3)'])
  assert.equal(first.last()?.state, 'ok')
})

test('an attempt waiting in the pool is cancelled, or taken with the rest of a banned author\'s, and its card hears there was no run', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const first = room.attempt('p_s1', 'HOLD one')
  assert.ok(await until(() => fake.holding('one') === 1))
  const second = room.attempt('p_s2', 'print(2)')
  const third = room.attempt('p_s3', 'print(3)')
  assert.equal(kernel.cancelCouncilRun(room.id, room.councilCellId, 'p_s2'), true)
  assert.equal(second.last(), null, 'the card did not hear its attempt was taken off')
  assert.equal(kernel.councilQueuePosition(room.id, room.councilCellId, 'p_s3'), 1)
  // A ban: the one waiting goes, and the one computing on a worker is stopped there.
  const purged = kernel.purgeCouncilRunsOf(room.id, 'p_s3')
  assert.deepEqual(purged, { running: false, queued: 1 })
  assert.equal(third.last(), null)
  const stopped = kernel.purgeCouncilRunsOf(room.id, 'p_s1')
  assert.equal(stopped.running, true)
  assert.ok(await until(() => first.last()?.state === 'error'), JSON.stringify(first.last()))
  assert.equal(room.pool()?.queue, 0)
  assert.ok(!ranIn(room.workerKernel(1)).includes('print(2)'))
  assert.ok(!ranIn(room.workerKernel(1)).includes('print(3)'))
  // The notebook's kernel was never interrupted for it.
  assert.equal(http('POST', new RegExp(`/api/kernels/${room.mainKernel()}/interrupt$`)), 0)
})

/* -------------------------------------------------------------- the epoch */

test('a teacher\'s cell after the epoch: the next attempt waits for the refreeze and runs on the new state', async (t) => {
  const room = await readyPool(t)
  room.cell(0).type('x = 7')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  await turns()
  assert.equal(attempt.last()?.state, 'queued', 'the attempt ran before the new epoch reached its machine')
  room.holdWanted()
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '7\n')
  assert.equal(attempt.last()?.epoch?.seq, 2)
  assert.equal(attempt.last()?.epoch?.behind, 0)
  assert.equal(attempt.last()?.note, undefined)
  // One refreeze for that run of the teacher's, however many attempts follow.
  const later = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => later.last()?.state === 'ok'))
  assert.equal(fake.councilRuns.export, 2)
})

test('an export slower than five seconds: the attempt runs on the old state after them, its card naming the cells it lacks', async (t) => {
  const room = await readyPool(t, { sources: ['x = 5', '', 'HOLD teacher\nx = 9'] })
  room.run(2)
  assert.ok(await until(() => fake.holding('teacher') === 1))
  const attempt = room.attempt('p_s1', 'print(x)')
  await turns()
  assert.equal(attempt.last()?.state, 'queued', JSON.stringify(attempt.frames.map((frame) => frame && [frame.state, frame.placed, frame.epoch, frame.note])) + JSON.stringify(room.pool()) + JSON.stringify(epochs.epochsOf(room.id, notebook.CELLS_KEY).map((e) => [e.seq, e.mainRuns, e.trouble])))
  room.hand.advance(POOL_WAIT_MS - 1)
  await turns()
  assert.equal(attempt.last()?.state, 'queued', 'the attempt did not wait for the refreeze')
  room.hand.advance(1)
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '5\n', 'the attempt did not run on the old state')
  assert.equal(attempt.last()?.epoch?.seq, 1)
  assert.equal(attempt.last()?.epoch?.behind, 1)
  const cell = notebook.findCell(room.doc, room.cell(2).id)!.index + 1
  const epoch = epochs.epochOf(room.id, notebook.CELLS_KEY, 1)!
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: (await import('../server/src/time-zone.js')).instanceTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(epoch.at)
  assert.equal(attempt.last()?.note, tr('server.stateAsOfWithoutCell.30d8e4', { time, cells: String(cell) }))
  // The next attempt does not wait again for the same refreeze.
  const next = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => next.last()?.state === 'ok'))
  // Once the teacher's cell ends, the refreeze runs, and the attempts after it see its state.
  fake.release('teacher')
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  room.holdWanted()
  assert.ok(await until(() => room.console()?.epoch?.seq === 2))
  const fresh = room.attempt('p_s3', 'print(x)')
  assert.ok(await until(() => fresh.last()?.state === 'ok'))
  assert.equal(fresh.said(), '9\n')
})

test('a cell whose refresh is by hand never refreezes on the teacher\'s runs; «Обновить состояние» takes one now', async (t) => {
  const room = await readyPool(t, { refresh: 'manual' })
  room.cell(0).type('x = 8')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.said(), '5\n')
  assert.equal(attempt.last()?.epoch?.behind, 1)
  assert.equal(fake.councilRuns.export, 1, 'a manual cell refroze by itself')
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  room.holdWanted()
  assert.ok(await until(() => room.console()?.epoch?.seq === 2 && room.pool()!.workers.every((worker) => worker.seeded === 2)), JSON.stringify(room.pool()))
  const after = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => after.last()?.state === 'ok'))
  assert.equal(after.said(), '8\n')
  // A class whose council is not on machines has nothing to refresh.
  assert.equal(pool.councilRefresh('no-such-class', notebook.CELLS_KEY), false)
})

/* ----------------------------------------------------- the shared mode §9.9 */

test('an attempt that reads a name its epoch left behind is refused by the worker\'s entry and runs in the notebook\'s kernel keeping its place, the rest on the workers', async (t) => {
  fake.council.left = [{ name: 'conn', why: 'connection' }]
  const room = await readyPool(t, { workers: 1, refresh: 'manual', sources: ['x = 5\nconn = "db"', '', 'HOLD teacher', 'print("later")'] })
  assert.deepEqual(room.console()?.epoch?.left, [{ name: 'conn', why: tr('server.databaseConnection.cdf70c') }])
  assert.equal(room.console()?.epoch?.carried, 1)
  // The worker is busy and the notebook's kernel too: the attempt waits in the pool, and the teacher's next cell in the notebook's queue.
  const busy = room.attempt('p_s0', 'HOLD worker')
  assert.ok(await until(() => fake.holding('worker') === 1))
  const reader = room.attempt('p_s1', 'print(conn)')
  room.run(2)
  assert.ok(await until(() => fake.holding('teacher') === 1))
  room.run(3)
  await turns()
  assert.equal(room.cell(3).state(), 'queued')
  fake.release('worker')
  assert.ok(await until(() => reader.frames.some((frame) => frame?.placed === 'shared')), JSON.stringify(reader.frames))
  const back = reader.frames.find((frame) => frame?.placed === 'shared')!
  assert.equal(back.state, 'queued')
  assert.equal(back.note, tr('server.runInTheSharedKernelItUses.eaf141', { name: 'conn' }))
  // No end before it: the refusal is not a run of the author's.
  assert.ok(reader.frames.slice(0, reader.frames.indexOf(back)).every((frame) => frame?.state === 'queued' || frame?.state === 'running'), JSON.stringify(reader.frames))
  fake.release('teacher')
  assert.ok(await until(() => reader.last()?.state === 'ok' && room.cell(3).state() === 'ok'), JSON.stringify(reader.last()))
  assert.equal(reader.said(), 'db\n')
  // Pressed before the teacher's cell, it ran before it.
  const order = ranIn(room.mainKernel()).filter((code) => code === 'print(conn)' || code === 'print("later")')
  assert.deepEqual(order, ['print(conn)', 'print("later")'])
  assert.equal(busy.last()?.state, 'ok')
  // The worker was not recycled for a refusal: its next attempt runs on it, loaded once.
  const loads = fake.councilRuns.load
  const other = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => other.last()?.state === 'ok'))
  assert.equal(other.last()?.placed, 'pool')
  assert.equal(fake.councilRuns.load, loads)
})

test('a notebook whose state holds data on the GPU keeps its attempts in its own kernel, the card and the console saying why', async (t) => {
  fake.council.left = [{ name: 'model', why: 'cuda' }]
  const room = await poolClass(t)
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, 'cuda')
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.frames[0]?.placed, 'shared')
  assert.equal(attempt.frames[0]?.note, tr('server.theNotebookSStateHoldsDataOn.2ac2bc'))
  assert.equal(room.console()?.state, 'shared')
  assert.equal(room.console()?.note, tr('server.theNotebookSStateHoldsDataOn.2ac2bc'))
  assert.equal(fake.councilRuns.load, 0, 'a worker loaded an epoch of the GPU')
})

test('a state that cannot be the pool\'s is exported again only once something changes: a cell the teacher runs, not every look of the pool', async (t) => {
  fake.council.left = [{ name: 'model', why: 'cuda' }]
  const room = await poolClass(t)
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  for (let look = 0; look < 3; look++) await tickBy(room, 5_000)
  await turns()
  assert.equal(fake.councilRuns.export, 1, 'the pool exported the same state again and again')
  // The teacher moves the model off the card: the next look takes a fresh epoch, and the pool comes up on it.
  fake.council.left = []
  room.cell(0).type('x = 6')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  await tickBy(room, 5_000)
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, null)
  room.holdWanted()
  assert.ok(await until(() => room.console()?.state === 'ready'), JSON.stringify(room.console()))
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.last()?.placed, 'pool')
  assert.equal(attempt.said(), '6\n')
})

test('an export that does not come together keeps the attempts in the notebook\'s kernel with its reason, and an empty notebook gives an empty epoch the workers start from', async (t) => {
  fake.council.exportError = 'MemoryError'
  const room = await poolClass(t)
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, 'failed')
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.frames[0]?.note, tr('server.theNotebookSStateCouldNotBe.9e7101'))
  assert.equal(room.console()?.state, 'shared')
})

test('a notebook with no kernel yet gives an empty epoch: no export, nothing to fetch, and the workers start from nothing', async (t) => {
  const room = await poolClass(t)
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => (room.pool()?.workers ?? []).filter((worker) => worker.seeded !== null).length === 2), JSON.stringify(room.pool()))
  const [epoch] = epochs.epochsOf(room.id, notebook.CELLS_KEY)
  assert.equal(epoch?.files, null)
  assert.equal(fake.councilRuns.export, 0)
  assert.equal(fake.councilRuns.load, 0, 'a worker loaded an empty epoch')
  assert.equal(room.mainKernel(), null, 'a kernel was started for the export')
  const attempt = room.attempt('p_s1', 'y = 3\nprint(y)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.last()?.placed, 'pool')
  assert.equal(attempt.said(), '3\n')
})

test('a machine that does not answer keeps the attempts in the notebook\'s kernel, said on the card', async (t) => {
  const room = await readyPool(t)
  room.places.set(room.id, 'council', room.view({ state: 'unreachable', since: room.hand.now }))
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.frames[0]?.placed, 'shared')
  assert.equal(attempt.frames[0]?.note, tr('server.thePoolSMachineDoesNotAnswer.16922d'))
})

/* ---------------------------------------------------------- failures §9.10 */

test('the pool\'s machine lost mid-attempt: the attempt runs once more in the notebook\'s kernel with no end in between, and those waiting go there keeping their place', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual', split: true })
  const running = room.attempt('p_s1', 'HOLD lost\nprint("again")')
  assert.ok(await until(() => fake.holding('lost') === 1))
  const waiting = room.attempt('p_s2', 'print(x)')
  assert.equal(room.pool()?.queue, 1)
  // The pool's machine goes: its road is cut and its placement lost.
  room.poolRoad.lose({ cut: false })
  room.places.set(room.id, 'council', { where: 'home' })
  // Kernels that start from now on start where the notebook's kernel is (the pool has no machine).
  jupyter.useDefaultEndpointForTest({ url: room.road.url, token: 'fake', link: room.road.link, identity: `machine:r1:${CONTAINER}:1` })
  room.places.emit({ sessionId: room.id, role: 'council', kind: 'lost', view: { where: 'home' }, cause: 'revoked', at: room.hand.now })
  assert.ok(await until(() => running.frames.some((frame) => frame?.placed === 'shared')), JSON.stringify(running.frames))
  const again = running.frames.find((frame) => frame?.placed === 'shared')!
  assert.equal(again.state, 'queued')
  assert.equal(again.note, tr('server.theMachineWasLostInTheMiddle.b5f5c5'))
  // The lost run never ended: no frame of an end went out for it, so no pause is charged.
  assert.ok(running.frames.slice(0, running.frames.indexOf(again)).every((frame) => frame?.state === 'queued' || frame?.state === 'running'), JSON.stringify(running.frames))
  assert.ok(await until(() => ranIn(room.mainKernel()).some((code) => code.startsWith('HOLD lost'))))
  await turns()
  assert.equal(waiting.last()?.state, 'queued', 'an attempt pressed later ran before the one that was lost')
  fake.release('lost')
  assert.ok(await until(() => running.last()?.state === 'ok' && waiting.last()?.state === 'ok'), JSON.stringify([running.last(), waiting.last()]))
  assert.equal(running.said(), 'again\n')
  assert.equal(running.last()?.placed, 'shared')
  assert.equal(waiting.last()?.placed, 'shared')
  assert.equal(waiting.frames.find((frame) => frame?.placed === 'shared')?.note, tr('server.thePoolSMachineWasLostThe.8aff4c'))
  // In the order pressed.
  const order = ranIn(room.mainKernel()).filter((code) => code.startsWith('HOLD lost') || code === 'print(x)')
  assert.deepEqual(order, ['HOLD lost\nprint("again")', 'print(x)'])
  // Run once more, not twice: a second loss would end it.
  assert.equal(running.frames.filter((frame) => frame?.placed === 'shared' && frame.state === 'queued').length, 1)
})

test('the notebook\'s kernel restarted changes nothing for the pool: it keeps its epoch, and its attempts still go to the workers', async (t) => {
  const room = await readyPool(t, { refresh: 'manual' })
  const kernelBefore = room.mainKernel()
  const restarts = http('POST', new RegExp(`/api/kernels/${kernelBefore}/restart$`))
  await kernel.restartSession(room.id, 'Teacher', notebook.CELLS_KEY)
  assert.equal(http('POST', new RegExp(`/api/kernels/${kernelBefore}/restart$`)), restarts + 1)
  await turns()
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.seq, 1, 'the restart replaced the epoch')
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.last()?.placed, 'pool')
  assert.equal(attempt.said(), '5\n', 'the pool lost its epoch with the notebook\'s kernel')
})

/* ------------------------------------------------------------- recycling */

/** The restarts the fake was asked for one kernel. */
const restartsOf = (kernelId: string | null) => (kernelId === null ? 0 : http('POST', new RegExp(`/api/kernels/${kernelId}/restart$`)))

test('a worker is recycled after twenty attempts and loaded again before the next, never the notebook\'s kernel', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const worker = room.workerKernel(1)
  const loads = fake.councilRuns.load
  for (let n = 0; n < 20; n++) {
    const attempt = room.attempt(`p_s${n}`, `print(x + ${n})`)
    assert.ok(await until(() => attempt.last()?.state === 'ok'), `attempt ${n}: ${JSON.stringify(attempt.last())}`)
  }
  assert.ok(await until(() => restartsOf(worker) === 1), `restarts ${restartsOf(worker)}`)
  assert.ok(await until(() => fake.councilRuns.load === loads + 1 && room.pool()!.workers[0]!.seeded === 1))
  assert.equal(room.pool()!.workers[0]!.served, 0)
  const next = room.attempt('p_next', 'print(x)')
  assert.ok(await until(() => next.last()?.state === 'ok'))
  assert.equal(next.said(), '5\n', 'the recycled worker lost its epoch')
  assert.equal(restartsOf(room.mainKernel()), 0, 'the notebook\'s kernel was restarted')
})

test('a worker whose attempt left a thread behind, or more memory than an attempt\'s, is recycled before it serves again', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const worker = room.workerKernel(1)
  fake.council.threads = 1
  const leaky = room.attempt('p_s1', 'print(1)')
  assert.ok(await until(() => leaky.last()?.state === 'ok'))
  fake.council.threads = 0
  assert.ok(await until(() => restartsOf(worker) === 1), 'a worker that left a thread was not recycled')
  const after = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => after.last()?.state === 'ok'))
  assert.equal(after.said(), '5\n')
  assert.equal(restartsOf(worker), 1)
  // «Память на попытку» is 1024 MB: an attempt that left the worker 1.5 GB above its seed sends it to a recycle.
  fake.council.grown = 1536 * 1024 * 1024
  const heavy = room.attempt('p_s3', 'print(3)')
  assert.ok(await until(() => heavy.last()?.state === 'ok'))
  fake.council.grown = null
  assert.ok(await until(() => restartsOf(worker) === 2), 'a worker past its memory was not recycled')
  // Below it, nothing.
  fake.council.grown = 100 * 1024 * 1024
  const light = room.attempt('p_s4', 'print(4)')
  assert.ok(await until(() => light.last()?.state === 'ok'))
  await turns()
  assert.equal(restartsOf(worker), 2)
  assert.equal(restartsOf(room.mainKernel()), 0)
})

test('an attempt deaf to its two interrupts recycles its worker; the notebook\'s kernel is neither interrupted nor restarted', async (t) => {
  const room = await readyPool(t, { workers: 2, refresh: 'manual' })
  const deaf = room.attempt('p_s1', 'DEAF stuck', 'author', 1)
  const fine = room.attempt('p_s2', 'HOLD fine\nprint("fine")', 'author', null)
  assert.ok(await until(() => fake.holding('stuck') === 1 && fake.holding('fine') === 1))
  const deafWorker = [1, 2].map((n) => room.workerKernel(n)).find((id) => ranIn(id).includes('DEAF stuck'))!
  assert.ok(await until(() => restartsOf(deafWorker) === 1), 'the stuck worker was not recycled')
  assert.ok(await until(() => doneStates.has(deaf.last()?.state ?? '')), JSON.stringify(deaf.last()))
  assert.equal(deaf.last()?.state, 'error')
  assert.equal(http('POST', new RegExp(`/api/kernels/${deafWorker}/interrupt$`)), 2)
  // The other worker computes on, untouched.
  assert.equal(fake.holding('fine'), 1)
  fake.release('fine')
  assert.ok(await until(() => fine.last()?.state === 'ok'))
  assert.equal(http('POST', new RegExp(`/api/kernels/${room.mainKernel()}/interrupt$`)), 0)
  assert.equal(restartsOf(room.mainKernel()), 0)
  // The recycled worker serves again, loaded.
  assert.ok(await until(() => room.pool()!.workers.every((worker) => worker.seeded === 1)), JSON.stringify(room.pool()))
  const next = room.attempt('p_s3', 'print(x)')
  assert.ok(await until(() => next.last()?.state === 'ok'))
  assert.equal(next.said(), '5\n')
  // Recycled once for being stuck, not again for the end of the attempt that was.
  assert.equal(restartsOf(deafWorker), 1)
})

test('the run limit stops an attempt on its own worker, and an author interrupts only their own attempt there', async (t) => {
  const room = await readyPool(t, { workers: 3, refresh: 'manual' })
  const limited = room.attempt('p_s1', 'HOLD slow', 'author', 1)
  const mine = room.attempt('p_s2', 'HOLD mine')
  const theirs = room.attempt('p_s3', 'HOLD theirs')
  assert.ok(await until(() => fake.holding('mine') === 1 && fake.holding('theirs') === 1))
  assert.ok(await until(() => doneStates.has(limited.last()?.state ?? '')), JSON.stringify(limited.last()))
  assert.equal(limited.last()?.state, 'error')
  // An author's Stop reaches their own worker alone.
  assert.ok(kernel.attemptOnWorker(room.id, room.councilCellId, 'p_s2'))
  await kernel.interruptSession(room.id, room.councilCellId, notebook.CELLS_KEY, 'p_s2')
  assert.ok(await until(() => doneStates.has(mine.last()?.state ?? '')), JSON.stringify(mine.last()))
  assert.equal(fake.holding('theirs'), 1, 'another author\'s attempt was interrupted')
  assert.equal(http('POST', new RegExp(`/api/kernels/${room.mainKernel()}/interrupt$`)), 0, 'the notebook\'s kernel was interrupted')
  fake.release('theirs')
  assert.ok(await until(() => theirs.last()?.state === 'ok'))
})

test('rules changed mid-attempt reach the pool: a worker\'s attempt is stopped by the new limit, counted from its start, and those waiting carry it', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const running = room.attempt('p_s1', 'HOLD long')
  assert.ok(await until(() => fake.holding('long') === 1))
  const waiting = room.attempt('p_s2', 'HOLD next')
  kernel.retimeCouncilRun(room.id, room.councilCellId, 1)
  assert.ok(await until(() => doneStates.has(running.last()?.state ?? '')), JSON.stringify(running.last()))
  assert.equal(running.last()?.state, 'error')
  // The one waiting went with the new number: stopped by it too, on its worker.
  assert.ok(await until(() => doneStates.has(waiting.last()?.state ?? '')), JSON.stringify(waiting.last()))
  assert.equal(waiting.last()?.state, 'error')
  assert.equal(http('POST', new RegExp(`/api/kernels/${room.mainKernel()}/interrupt$`)), 0)
})

/* ---------------------------------------------------------------- sizing */

/** Move the pool's clock and let the tick it fires finish (it arms the next one when done). */
async function tickBy(room: PoolRoom, ms: number): Promise<void> {
  room.hand.advance(ms)
  await turns()
}

test('auto: the pool starts with min(4, auto) workers, grows by two every five seconds while attempts wait, its container with it, and sheds one a minute after three empty ones, down to two', async (t) => {
  const room = await poolClass(t, { workers: 'auto', refresh: 'manual' })
  // Thirty in the room: auto is ten.
  room.people.online = 30
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  room.holdWanted()
  assert.equal(room.pool()?.size, 4)
  assert.ok(await until(() => room.pool()!.workers.filter((worker) => worker.seeded === 1).length === 4))
  const attempts = Array.from({ length: 12 }, (_, n) => room.attempt(`p_g${n}`, 'HOLD g'))
  assert.ok(await until(() => fake.holding('g') === 4))
  const epoch = epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]!
  const bufferMb = Math.ceil(epoch.bytes / (1024 * 1024))
  // A worker takes its ceiling, what it holds before an attempt, and the epoch's stream it unpickled (§9.5).
  const each = 1024 + COUNCIL_WORKER_BASE_MB + streamMbOf(epoch)
  // The epoch on the machine first: the four workers' container is asked to hold its buffers as they load it.
  assert.ok(await until(() => room.resizes.length === 1), JSON.stringify(room.resizes))
  assert.deepEqual(room.resizes[0], { memoryMb: 4 * each + bufferMb + 512, cpus: 4, workers: 4 })
  for (const size of [6, 8, 10]) {
    await tickBy(room, 5_000)
    assert.ok(await until(() => room.pool()?.size === size && fake.holding('g') === size), `size ${room.pool()?.size}, holding ${fake.holding('g')}`)
    assert.deepEqual(room.resizes.at(-1), { memoryMb: size * each + bufferMb + 512, cpus: size, workers: size })
  }
  // Ten is the cap: it grows no more, whatever waits, and the container is not asked the same numbers again.
  await tickBy(room, 5_000)
  await turns()
  assert.equal(room.pool()?.size, 10)
  assert.equal(room.resizes.length, 4)
  fake.release('g')
  assert.ok(await until(() => fake.holding('g') === 2))
  fake.release('g')
  assert.ok(await until(() => attempts.every((one) => one.last()?.state === 'ok')))
  // Three minutes with nothing waiting, then one a minute.
  await tickBy(room, 3 * 60_000 - 5_000)
  assert.equal(room.pool()?.size, 10, 'it shrank before three empty minutes')
  await tickBy(room, 5_000)
  assert.ok(await until(() => room.pool()?.size === 9), `size ${room.pool()?.size}`)
  await tickBy(room, 30_000)
  assert.equal(room.pool()?.size, 9, 'it shed two in a minute')
  for (let size = 8; size >= 2; size--) {
    await tickBy(room, 60_000)
    assert.ok(await until(() => room.pool()?.size === size), `size ${room.pool()?.size}, wanted ${size}`)
  }
  await tickBy(room, 60_000)
  assert.equal(room.pool()?.size, 2, 'it shrank below two')
  assert.ok(await until(() => room.pool()!.workers.length === 2))
  assert.deepEqual(room.resizes.at(-1), { memoryMb: 2 * each + bufferMb + 512, cpus: 2, workers: 2 })
})

test('a number by hand is that many workers, changed at the next look; the pool stops fifteen minutes after its last council closes', async (t) => {
  const room = await readyPool(t, { workers: 3, refresh: 'manual' })
  assert.equal(room.pool()?.size, 3)
  room.live.workers = 5
  await tickBy(room, 5_000)
  assert.ok(await until(() => room.pool()?.size === 5 && room.pool()!.workers.filter((worker) => worker.seeded === 1).length === 5), JSON.stringify(room.pool()))
  const fifth = room.workerKernel(5)
  assert.ok(fifth)
  pool.councilClosed(room.id, notebook.CELLS_KEY, room.councilCellId)
  await tickBy(room, 15 * 60_000 - 10_000)
  assert.ok(room.pool(), 'the pool stopped before its fifteen minutes')
  await tickBy(room, 10_000)
  assert.ok(await until(() => room.pool() === null), 'the pool did not stop')
  assert.equal(room.console()?.workers ?? 0, 0)
  assert.deepEqual(epochs.epochIntentsFor('r1'), [], 'its machine is still asked to hold its epoch')
  // The class's last pool gone, its council container goes too: the machine holds nothing for it.
  assert.ok(await until(() => room.places.stops.length === 1))
  assert.deepEqual(room.places.stops, [{ role: 'council', gen: 1 }])
  // Its workers' kernels went with it; the notebook's stayed.
  assert.ok(await until(() => http('DELETE', /\/api\/sessions\//) >= 5 || kernel.workerState({ sessionId: room.id, root: notebook.CELLS_KEY, n: 5 }).up === false))
  assert.equal(kernel.workerState({ sessionId: room.id, root: notebook.CELLS_KEY, n: 1 }).up, false)
  assert.ok(room.mainKernel())
  // The next attempt brings it back.
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.ok(room.pool(), 'the pool did not come back on its next need')
})

/* ----------------------------------------------------- the class's work */

test('a worker computing is the class\'s work: the owner\'s stop sees it, the class is computing, and the room\'s document hears nothing of the workers', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const before = JSON.stringify(room.doc.toJSON())
  const attempt = room.attempt('p_s1', 'HOLD busy')
  assert.ok(await until(() => fake.holding('busy') === 1))
  const waiting = room.attempt('p_s2', 'print(2)')
  assert.deepEqual(kernel.stopBlocker(room.id, 'class'), { kind: 'attempt', participantId: 'p_s1', root: notebook.CELLS_KEY, since: attempt.frames.find((frame) => frame?.state === 'running')!.startedAt })
  assert.equal(kernel.sessionComputing(room.id), true)
  // The idle sweep's and the panel's word on the class: busy, not idle, while a worker computes.
  assert.equal(kernel.classActivity(room.id).busy?.kind, 'attempt')
  assert.ok(kernel.classActivity(room.id).scopes.every((scope) => !scope.root.includes('~w')), 'a worker was listed as a notebook\'s kernel')
  assert.equal(room.console()?.busy, 1)
  assert.equal(room.console()?.queued, 1)
  fake.release('busy')
  assert.ok(await until(() => waiting.last()?.state === 'ok'))
  await turns()
  assert.equal(kernel.sessionComputing(room.id), false)
  assert.equal(kernel.stopBlocker(room.id, 'class'), null)
  // Nothing of the workers in the room's document: no notebook of theirs, no chip, no note.
  const after = JSON.stringify(room.doc.toJSON())
  assert.equal(after, before, 'the workers wrote into the room\'s document')
  assert.ok(![...room.doc.share.keys()].some((key) => key.includes('~w')))
})

/* -------------------------------------------------- a restart of this server */

test('after a restart of this server the pool comes back with its epoch from the registry, its workers re-attached by their paths and recycled before they serve', async (t) => {
  const room = await readyPool(t, { workers: 2, refresh: 'manual' })
  const workers = [room.workerKernel(1), room.workerKernel(2)]
  assert.ok(workers.every((id) => id !== null))
  // The process goes as a crash takes it: nothing said, the kernels left running on the machine.
  kernel.abandonKernelsForTest()
  epochs.resetEpochsForTest()
  room.held.clear()
  room.room.readyBefore = true
  // A console comes: the open council's pool comes back.
  pool.councilWarm(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => room.pool()?.workers.length === 2))
  assert.deepEqual(epochs.epochsOf(room.id, notebook.CELLS_KEY).map((epoch) => epoch.seq), [1], 'the registry lost the epoch')
  // The machine's next sync says it still holds it.
  room.holdWanted()
  assert.ok(await until(() => workers.every((id) => restartsOf(id) === 1)), workers.map(restartsOf).join(','))
  assert.ok(await until(() => room.pool()!.workers.every((worker) => worker.seeded === 1)), JSON.stringify(room.pool()))
  assert.deepEqual([room.workerKernel(1), room.workerKernel(2)], workers, 'the workers were not re-attached')
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '5\n')
  assert.equal(attempt.last()?.placed, 'pool')
  // Once, not on every start: a worker started again later in this life is a new kernel.
  assert.ok(workers.every((id) => restartsOf(id) === 1))
})

/* ------------------------------------------------------- the store at home */

/**
 * The export's copy out of the kernel's container, as `docker cp` would make
 * it: the fake's folder for that epoch. The seqs copied, and those whose
 * folder was only removed (`drops`).
 */
function copyFromFake(spoil: (name: string, bytes: Buffer) => Buffer = (_name, bytes) => bytes) {
  const copies: number[] & { drops: number[] } = Object.assign([] as number[], { drops: [] as number[] })
  epochs.useEpochCollector(async (_sessionId, _role, seq, into) => {
    if (into === null) {
      copies.drops.push(seq)
      return
    }
    copies.push(seq)
    const from = fake.epochFolder(seq)
    for (const name of fs.readdirSync(from)) fs.writeFileSync(path.join(into, name), spoil(name, fs.readFileSync(path.join(from, name))))
  })
  return copies
}

test('an export of a kernel here comes into the store by content: every file checked against its hash, the machine then fetching them from here', async (t) => {
  const copies = copyFromFake()
  fake.council.buffers = [200_000]
  const room = await poolClass(t, { home: true })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  const [epoch] = epochs.epochsOf(room.id, notebook.CELLS_KEY)
  assert.ok(epoch?.files)
  assert.equal(epoch.trouble, null)
  assert.equal(epoch.source, 'home')
  assert.deepEqual([...copies], [epoch.seq])
  for (const file of epochs.epochFileList(epoch.files)) assert.ok(epochs.storeHas(room.id, file), `the store lacks ${file.sha256}`)
  // Three files: the manifest, the stream (a file among the buffers, as the contract carries it) and the one buffer.
  assert.equal(epochs.epochFileList(epoch.files).length, 3)
  assert.ok(epoch.files.buffers.some((file) => file.sha256 === epoch.files!.body))
  // The pool's machine fetches them from here: the blob door serves exactly those to it.
  const [intent] = epochs.epochIntentsFor('r1')
  assert.equal(intent?.from, 'home')
  assert.deepEqual(intent.manifest, epoch.files.manifest)
  for (const file of epochs.epochFileList(epoch.files)) assert.ok(epochs.epochBlobFor('r1', file.sha256), `the door does not serve ${file.sha256}`)
  assert.equal(epochs.epochBlobFor('r9', epoch.files.body), null, 'another machine may fetch the epoch')
  assert.equal(epochs.epochBlobFor('r1', 'f'.repeat(64)), null)
  room.holdWanted()
  assert.ok(await until(() => room.pool()!.workers.every((worker) => worker.seeded === epoch.seq)))
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.said(), '5\n')
})

test('an export whose copied files do not hash to its report is no epoch, and the next export writes every buffer again', async (t) => {
  copyFromFake((_name, bytes) => (bytes.length > 0 ? Buffer.concat([bytes, Buffer.from('!')]) : bytes))
  const room = await poolClass(t, { home: true })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  const [epoch] = epochs.epochsOf(room.id, notebook.CELLS_KEY)
  assert.equal(epoch?.trouble, 'failed')
  assert.ok(epochs.epochFileList(epoch.files).every((file) => !epochs.storeHas(room.id, file)), 'a file that did not check out was kept')
  assert.deepEqual(epochs.epochIntentsFor('r1'), [])
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.frames[0]?.note, tr('server.theNotebookSStateCouldNotBe.9e7101'))
  const exports = () => ranIn(room.mainKernel()).filter((code) => code.includes('.export(globals()'))
  assert.match(exports()[0]!, /'full': False/)
  copyFromFake()
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.match(exports()[1]!, /'full': True/, 'the export after a lost one reused buffers its collector may lack')
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, null)
})

test('a notebook keeps its last two epochs, and the store lets go of the files neither of them names', async (t) => {
  copyFromFake()
  const room = await poolClass(t, { home: true, refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  const first = epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]!
  for (const value of [6, 7]) {
    room.cell(0).type(`x = ${value}`)
    room.run(0)
    assert.ok(await until(() => room.cell(0).state() === 'ok' && kernel.kernelWorkOf(room.id, room.cell(0).id)?.busy === null))
    const before = fake.councilRuns.export
    assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
    assert.ok(await until(() => fake.councilRuns.export === before + 1 && room.pool()?.refreezing === false))
  }
  assert.deepEqual(epochs.epochsOf(room.id, notebook.CELLS_KEY).map((epoch) => epoch.seq), [3, 2])
  assert.deepEqual(db.councilEpochsOf(room.id, notebook.CELLS_KEY).map((row) => row.seq), [3, 2])
  assert.equal(epochs.epochOf(room.id, notebook.CELLS_KEY, 1), null)
  // The first epoch's stream and manifest are its own: gone from the store with it.
  assert.ok(!epochs.storeHas(room.id, first.files!.manifest))
  assert.ok(!epochs.storeHas(room.id, { sha256: first.files!.body, bytes: first.files!.buffers[0]!.bytes }))
  const [newest] = epochs.epochsOf(room.id, notebook.CELLS_KEY)
  for (const file of epochs.epochFileList(newest!.files)) assert.ok(epochs.storeHas(room.id, file))
})

test('past 4 GB the store lets go of the classes used least lately first: stored or served, a class is used', () => {
  const sha = (what: string) => createHash('sha256').update(what).digest('hex')
  let now = 1_000
  epochs.useStoreClock(() => now)
  // Stored in this order: b first, then a, then c.
  const [b, a, c] = ['lru-b', 'lru-a', 'lru-c'].map((name) => `${name}${seq++}`) as [string, string, string]
  const big = 1536 * 1024 * 1024
  const files = new Map<string, { manifest: { sha256: string; bytes: number }; stream: { sha256: string; bytes: number } }>()
  const land = (sessionId: string, file: { sha256: string; bytes: number }) => {
    // A file of 1.5 GB that takes no room: its length is all the store counts.
    const staged = path.join(epochs.epochStagingDir(), `${file.sha256}.part`)
    fs.writeFileSync(staged, '')
    if (file.bytes > 0) fs.truncateSync(staged, file.bytes)
    epochs.landEpochUpload('r-lru', sessionId, file, staged)
  }
  try {
    for (const sessionId of [b, a, c]) {
      db.createSession(sessionId, 'LRU')
      const manifest = { sha256: sha(`${sessionId} manifest`), bytes: 0 }
      const stream = { sha256: sha(sessionId), bytes: big }
      files.set(sessionId, { manifest, stream })
      epochs.recordEpoch({
        sessionId, root: notebook.CELLS_KEY, seq: 1, at: now, mainRuns: 0, incarnation: epochs.epochIncarnation(), bytes: big, shipBytes: 0,
        carried: [], left: [], trouble: null, source: 'home',
        files: { manifest, body: stream.sha256, buffers: [stream] },
      })
      land(sessionId, manifest)
      land(sessionId, stream)
      now += 1_000
    }
    // b's machine fetches its epoch from here: b is the class used last of all.
    epochs.wantEpoch(b, notebook.CELLS_KEY, { runnerId: 'r-lru', seq: 1 })
    assert.equal(epochs.epochIntentsFor('r-lru').length, 1)
    now += 1_000
    assert.ok(epochs.epochBlobFor('r-lru', files.get(b)!.stream.sha256))
    epochs.pruneStore()
    assert.equal(epochs.storeHas(a, files.get(a)!.stream), false, 'the class used least lately kept its files')
    assert.equal(epochs.storeHas(b, files.get(b)!.stream), true, 'a class just served lost its files')
    assert.equal(epochs.storeHas(c, files.get(c)!.stream), true)
  } finally {
    epochs.useStoreClock(null)
    for (const sessionId of [a, b, c]) epochs.forgetClassEpochs(sessionId)
  }
})

/* ------------------------------------------------------- what ships across */

/** The hidden module's own Python, with every export's report carrying one more buffer of `bytes` (a stand-in for a big model). */
function biggerExports(bytes: () => number): string {
  const real = pool.KERNEL_PYTHON
  const big = createHash('sha256').update('the model').digest('hex')
  pool.useEpochPython({
    ...real,
    exportReport: (raw) => {
      const report = real.exportReport(raw)
      if (!report?.files || bytes() === 0) return report
      return { ...report, files: { ...report.files, buffers: [...report.files.buffers, { sha256: big, bytes: bytes() }] } }
    },
  })
  return big
}

test('a refreeze that would ship more than 256 MB to a pool on another machine keeps the previous epoch, the console saying so', async (t) => {
  let extra = 0
  biggerExports(() => extra)
  const room = await readyPool(t, { split: true, refresh: 'manual' })
  const first = epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]!
  assert.equal(first.seq, 1)
  // A model of 300 MB appears in the notebook's state.
  extra = 300 * 1024 * 1024
  room.cell(0).type('x = 6')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  // The notebook kernel's placement on r1, whose container the export lies in: it ships home what the pool's machine lacks.
  const { writePlacement, updatePlacement } = await import('../server/src/kernel/remote/placement-store.js')
  const now = Date.now()
  const placed = writePlacement({
    sessionId: room.id, role: 'room', runnerId: 'r1', state: 'ready', environment: 'base', revision: { id: 'r', ref: 'x', layers: '[]' },
    memoryMb: 1024, cpus: 1, gpu: null, workers: null, container: CONTAINER, readyAt: now, endedAt: null, reason: null, createdAt: now,
  })
  try {
    assert.equal(placed.gen, 1)
    assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
    assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
    const [second] = epochs.epochsOf(room.id, notebook.CELLS_KEY)
    assert.equal(second?.seq, 2)
    // Too big for this machine, not for every machine: the verdict is the pool's, the registry's row is a sound epoch.
    assert.equal(second?.trouble, null)
    assert.ok(second.shipBytes > 256 * 1024 * 1024)
    // The pool runs on the one before it.
    assert.equal(room.console()?.state, 'ready')
    assert.equal(room.console()?.epoch?.seq, 1)
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: (await import('../server/src/time-zone.js')).instanceTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(first.at)
    assert.equal(room.console()?.note, tr('server.theNewStateDoesNotFit.1c7533', { time }))
    const attempt = room.attempt('p_s1', 'print(x)')
    assert.ok(await until(() => attempt.last()?.state === 'ok'))
    assert.equal(attempt.said(), '5\n')
    assert.equal(attempt.last()?.epoch?.seq, 1)
    // Neither machine is asked anything of the epoch that does not fit.
    assert.ok(!epochs.epochIntentsFor('r2').some((intent) => intent.seq === 2))
    assert.ok(!epochs.epochIntentsFor('r1').some((intent) => intent.seq === 2))
  } finally {
    updatePlacement(room.id, 'room', placed.gen, { state: 'stopped', endedAt: Date.now() })
  }
})

test('only the bytes a machine lacks count toward what ships: the buffers of an epoch it holds are not sent again', () => {
  const sessionId = `ship${seq++}`
  db.createSession(sessionId, 'Ship')
  const file = (what: string, bytes: number) => ({ sha256: createHash('sha256').update(what).digest('hex'), bytes })
  const model = file('model', 300 * 1024 * 1024)
  const epoch = (n: number, ...buffers: Array<{ sha256: string; bytes: number }>) => {
    const body = file(`stream ${n}`, 1000)
    return {
      sessionId, root: notebook.CELLS_KEY, seq: n, at: Date.now(), mainRuns: n, incarnation: epochs.epochIncarnation(), bytes: 0, shipBytes: 0,
      carried: [], left: [], files: { manifest: file(`manifest ${n}`, 500), body: body.sha256, buffers: [body, ...buffers] },
      source: 'home' as const, trouble: null,
    }
  }
  epochs.recordEpoch(epoch(1, model))
  epochs.noteEpochStates('r2', [{ sessionId, root: notebook.CELLS_KEY, seq: 1, ready: true }])
  const next = epoch(2, model)
  assert.equal(epochs.bytesMissingOn('r2', next.files), 1500)
  assert.equal(epochs.bytesMissingOn('r3', next.files), 300 * 1024 * 1024 + 1500)
  epochs.forgetClassEpochs(sessionId)
})

/** The silent run that removes an export's folder from its kernel's container (council-isolation.ts · exportDropExpression). */
const dropOf = (seq: number) => `__import__('shutil').rmtree("/tmp/colloq-epoch/${seq}", ignore_errors=True)`

test('an export too big to ship to the pool\'s machine goes from the container it lies in, which nobody will read, and the next export writes every buffer again', async (t) => {
  let extra = 0
  biggerExports(() => extra)
  const room = await readyPool(t, { split: true, refresh: 'manual' })
  extra = 300 * 1024 * 1024
  room.cell(0).type('x = 6')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  await kernelPlacedOnR1(t, room.id)
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.equal(room.console()?.epoch?.seq, 1, 'the one before it is no longer the pool\'s')
  // Its kernel removes the folder between the teacher's cells; the one the pool runs on stays.
  assert.ok(await until(() => fake.councilRuns.drop === 1), `drops ${fake.councilRuns.drop}`)
  assert.ok(ranIn(room.mainKernel()).includes(dropOf(2)))
  assert.deepEqual([fs.existsSync(fake.epochFolder(1)), fs.existsSync(fake.epochFolder(2))], [true, false])
  extra = 0
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 3 && room.pool()?.refreezing === false))
  const exports = ranIn(room.mainKernel()).filter((code) => code.includes('.export(globals()'))
  assert.deepEqual(exports.map((code) => /'full': True/.test(code)), [false, false, true])
  // Asked once, however often the pool looks again.
  for (let look = 0; look < 2; look++) await tickBy(room, 5_000)
  assert.equal(fake.councilRuns.drop, 1)
})

test('a refreeze too big to ship never takes the export before it along, named to no machine yet: that one is what the replies name now, and its folder stays', async (t) => {
  let extra = 0
  biggerExports(() => extra)
  const room = await poolClass(t, { split: true, refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  await kernelPlacedOnR1(t, room.id)
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  // The pool's machine has said what it holds (nothing yet): a refreeze is judged against it.
  epochs.noteEpochStates('r2', [])
  extra = 300 * 1024 * 1024
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.ok(await until(() => fake.councilRuns.drop === 1), `drops ${fake.councilRuns.drop}`)
  assert.ok(ranIn(room.mainKernel()).includes(dropOf(2)))
  await turns()
  assert.equal(fake.councilRuns.drop, 1, 'the first export went with the one too big to ship')
  assert.ok(fs.existsSync(fake.epochFolder(1)))
  assert.deepEqual(epochs.epochIntentsFor('r1').map((intent) => [intent.seq, intent.ship !== undefined]), [[1, true]])
})

test('refreezes taken faster than the machine heard of them: an export no reply named goes from its container, one named stays for the machine to read', async (t) => {
  const room = await poolClass(t, { refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  assert.ok(fs.existsSync(fake.epochFolder(1)))
  // The teacher refreezes before any reply named the first to the machine: a reply names a notebook's newest.
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.ok(await until(() => fake.councilRuns.drop === 1 && !fs.existsSync(fake.epochFolder(1))), `drops ${fake.councilRuns.drop}`)
  assert.ok(ranIn(room.mainKernel()).includes(dropOf(1)))
  // A reply names the second: it stays — the machine reads it before a refreeze that needs its buffers (runner-agent/council.ts · feeds).
  assert.deepEqual(epochs.epochIntentsFor('r1').map((intent) => intent.seq), [2])
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 3 && room.pool()?.refreezing === false))
  await turns()
  assert.equal(fake.councilRuns.drop, 1)
  assert.ok(fs.existsSync(fake.epochFolder(2)))
})

/* ----------------------------------------------------- the attempt's files */

test('an attempt\'s files are named on its card, those within the caps on their way and asked of its machine, marked kept as they land, the rest named with their size', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  fake.council.files = [{ name: 'out.csv', text: 'a,b\n1,2\n' }, { name: 'big.bin', bytes: 50 * 1024 * 1024 }]
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  const runId = attempt.last()!.runId!
  const sha = createHash('sha256').update('a,b\n1,2\n').digest('hex')
  // The run's end: the one within the caps on its way (null, never «not kept»), the one past them left behind.
  const ended = attempt.frames.find((frame) => frame?.state === 'ok')!
  assert.deepEqual(ended.files, [{ name: 'out.csv', bytes: 8, kept: null, sha256: sha }, { name: 'big.bin', bytes: 50 * 1024 * 1024, kept: false }])
  assert.deepEqual(attempt.last()?.files, ended.files)
  // The machine is asked for the one with a hash, within the caps, under the council placement's gen.
  const [collect] = epochs.collectFor('r1')
  assert.equal(collect?.runId, runId)
  assert.deepEqual(collect?.files, [{ name: 'out.csv', sha256: sha, bytes: 8 }])
  // It lands: the card says so.
  const frames = attempt.frames.length
  const staged = path.join(fake.epochFolder(0), 'out.part')
  fs.mkdirSync(path.dirname(staged), { recursive: true })
  fs.writeFileSync(staged, 'a,b\n1,2\n')
  const target = epochs.artifactPath(room.id, runId, collect!.files[0]!.sha256)
  epochs.landArtifact(room.id, runId, 'out.csv', staged, target)
  assert.equal(attempt.frames.length, frames + 1)
  assert.deepEqual(attempt.last()?.files, [{ name: 'out.csv', bytes: 8, kept: true, sha256: sha }, { name: 'big.bin', bytes: 50 * 1024 * 1024, kept: false }])
  assert.equal(fs.readFileSync(target, 'utf8'), 'a,b\n1,2\n')
  // The machine says the collection is over: nothing more is asked, and the card, whole, hears nothing more.
  epochs.noteCollected('r1', [{ sessionId: room.id, runId }])
  assert.deepEqual(epochs.collectFor('r1'), [])
  assert.equal(attempt.frames.length, frames + 1)
  fake.council.files = []
})

test('a file on its way whose collection ends without it is said left behind, once: the machine refused it, or went', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  fake.council.files = [{ name: 'a.csv', text: 'a\n' }, { name: 'b.csv', text: 'b\n' }]
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  const runId = attempt.last()!.runId!
  assert.deepEqual(attempt.last()?.files?.map((file) => [file.name, file.kept]), [['a.csv', null], ['b.csv', null]])
  // One lands; then the machine says the collection is over without the other (its agent would not send it).
  const [collect] = epochs.collectFor('r1')
  const staged = path.join(fake.epochFolder(0), 'a.part')
  fs.mkdirSync(path.dirname(staged), { recursive: true })
  fs.writeFileSync(staged, 'a\n')
  epochs.landArtifact(room.id, runId, 'a.csv', staged, epochs.artifactPath(room.id, runId, collect!.files[0]!.sha256))
  const frames = attempt.frames.length
  epochs.noteCollected('r1', [{ sessionId: room.id, runId }])
  assert.equal(attempt.frames.length, frames + 1, 'the card heard nothing of the end')
  assert.deepEqual(attempt.last()?.files?.map((file) => [file.name, file.kept]), [['a.csv', true], ['b.csv', false]])
  // A collection the machine's going ends: the same.
  const second = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => second.last()?.state === 'ok'))
  assert.deepEqual(second.last()?.files?.map((file) => file.kept), [null, null])
  epochs.dropCollects(room.id, 'r1')
  assert.deepEqual(second.last()?.files?.map((file) => file.kept), [false, false])
  fake.council.files = []
})

test('an attempt whose entry failed on its worker after making its folder has that folder collected all the same: nothing is brought, and the machine removes it', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  fake.council.enterError = 'memory ceiling unavailable'
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => doneStates.has(attempt.last()?.state ?? '')), JSON.stringify(attempt.last()))
  assert.deepEqual([attempt.last()?.state, attempt.last()?.placed], ['error', 'pool'])
  const runId = attempt.last()!.runId!
  assert.deepEqual(epochs.collectFor('r1').map((one) => [one.runId, one.files]), [[runId, []]], 'its folder is left on the machine for the six-hour sweep')
})

/* -------------------------------------------------------------- adopting */

test('«В ячейку и запустить» of an attempt that ran on a state the kernel has moved on from warns the teacher; one on the current state does not', async (t) => {
  const room = await readyPool(t, { refresh: 'manual' })
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(pool.adoptWarning(room.id, attempt.last()), null)
  room.cell(0).type('x = 6')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  assert.equal(pool.adoptWarning(room.id, attempt.last()), tr('server.theKernelHasRunCellsSinceThe.e29733', { count: 1 }))
  // A shared kernel's attempt ran on the kernel itself: nothing to warn of.
  assert.equal(pool.adoptWarning(room.id, { ...attempt.last()!, placed: 'shared' }), null)
})

/* ----------------------------------------------------------- the console */

/** A control socket that keeps what it is sent (control-welcome.test.mts). */
function socket() {
  const heard: ControlServerMessage[] = []
  const fakeSocket = {
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
    close() {
      fakeSocket.readyState = WebSocket.CLOSED
    },
  }
  return { ws: fakeSocket as unknown as WebSocket, heard }
}

const host = (sessionId: string): TokenPayload => ({ sessionId, participantId: 'p_teacher', role: 'host' })
const author = (sessionId: string, participantId: string): TokenPayload => ({ sessionId, participantId, role: 'participant' })
const errorsOf = (heard: ControlServerMessage[]) => heard.flatMap((message) => (message.t === 'error' ? [message.message] : []))

test('the lock opens the pool: a council opened takes its notebook\'s epoch and starts its workers, and its knobs reach the attempts', async (t) => {
  const room = await poolClass(t, { closed: true })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const teacher = socket()
  t.after(() => control.closeControlRoom(room.id))
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'cell:lock', cellId: room.councilCellId, state: 'council', settings: { refresh: 'manual' } })
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false), JSON.stringify(errorsOf(teacher.heard)))
  assert.equal(room.pool()?.size, 2)
  const settings = notebook.councilSettingsOf(notebook.findCell(room.doc, room.councilCellId)!.cell)
  assert.equal(settings?.lane, 'pool')
  assert.equal(settings?.refresh, 'manual')
  // A knob changed on an open council goes through, nothing else touched.
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'cell:lock', cellId: room.councilCellId, state: 'council', settings: { lane: 'shared' } })
  assert.equal(notebook.councilSettingsOf(notebook.findCell(room.doc, room.councilCellId)!.cell)?.lane, 'shared')
  assert.equal(fake.councilRuns.export, 1)
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'cell:lock', cellId: room.councilCellId, state: 'closed' })
  // Closed, the pool lingers: there still, and gone fifteen minutes later.
  assert.ok(room.pool())
  await tickBy(room, 15 * 60_000)
  assert.ok(await until(() => room.pool() === null))
})

test('«Обновить состояние» is the teacher\'s, for a council cell whose attempts go to the pool', async (t) => {
  const room = await readyPool(t)
  const teacher = socket()
  const pupil = socket()
  t.after(() => control.closeControlRoom(room.id))
  control.dispatch(pupil.ws, room.id, author(room.id, 'p_s1'), { t: 'council:epoch', cellId: room.councilCellId })
  assert.deepEqual(errorsOf(pupil.heard), [tr('server.onlyTheTeacherRefreshesTheAttempts.3cdeb6')])
  // Not a council's cell: nothing to refresh.
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'council:epoch', cellId: room.cell(0).id })
  assert.deepEqual(errorsOf(teacher.heard), [tr('server.thisCellSAttemptsDoNotGo.7d2837')])
  assert.equal(fake.councilRuns.export, 1)
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'council:epoch', cellId: room.councilCellId })
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.equal(errorsOf(teacher.heard).length, 1)
})

test('an author stops their own attempt on a worker, never another\'s; the teacher stops any', async (t) => {
  const room = await readyPool(t, { workers: 2, refresh: 'manual' })
  const teacher = socket()
  const pupil = socket()
  t.after(() => control.closeControlRoom(room.id))
  const one = room.attempt('p_s1', 'HOLD one')
  const two = room.attempt('p_s2', 'HOLD two')
  assert.ok(await until(() => fake.holding('one') === 1 && fake.holding('two') === 1))
  control.dispatch(pupil.ws, room.id, author(room.id, 'p_s1'), { t: 'interrupt', cellId: room.councilCellId, participantId: 'p_s2' })
  await turns()
  assert.deepEqual(errorsOf(pupil.heard), [tr('server.onlyTheHostOrWhoeverStartedThe.835184')])
  assert.equal(fake.holding('two'), 1)
  control.dispatch(pupil.ws, room.id, author(room.id, 'p_s1'), { t: 'interrupt', cellId: room.councilCellId, participantId: 'p_s1' })
  assert.ok(await until(() => doneStates.has(one.last()?.state ?? '')))
  assert.equal(fake.holding('two'), 1)
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'interrupt', cellId: room.councilCellId, participantId: 'p_s2' })
  assert.ok(await until(() => doneStates.has(two.last()?.state ?? '')))
  assert.equal(http('POST', new RegExp(`/api/kernels/${room.mainKernel()}/interrupt$`)), 0)
})

/* --------------------------------------------------------------- the doors */

test('the council\'s doors home: an epoch file only from the machine asked to ship it, at its placement\'s gen; its blobs only to the pool\'s machine; an attempt\'s file only as its collection named it', async () => {
  const remote = await import('./_remote.mts')
  const { useClassPort } = await import('../server/src/competitions/remote/heard.js')
  const { mintRemoteCode } = await import('../server/src/competitions/remote/store.js')
  const { writePlacement } = await import('../server/src/kernel/remote/placement-store.js')
  const { remoteClassPaths } = await import('../shared/remote-kernels.js')
  const { REMOTE_BYTES_HEADER, REMOTE_SHA256_HEADER } = await import('../shared/remote-runner.js')
  remote.reset()
  const home = await remote.serve()
  useClassPort({
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
  })
  const join = async () => {
    const machine = new remote.Machine(home)
    const minted = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, namePrefix: null, createdBy: 'tests', classes: true })
    assert.equal((await machine.join(minted.code)).status, 200)
    return machine
  }
  const source = await join()
  const poolMachine = await join()
  const sessionId = `door${seq++}`
  db.createSession(sessionId, 'Doors')
  const now = Date.now()
  const row = (role: 'room' | 'council', runnerId: string) => writePlacement({
    sessionId, role, runnerId, state: 'ready', environment: 'base', revision: { id: 'r', ref: 'x', layers: '[]' }, memoryMb: 1024, cpus: 1,
    gpu: null, workers: role === 'council' ? 2 : null, container: CONTAINER, readyAt: now, endedAt: null, reason: null, createdAt: now,
  })
  const placed = row('room', source.runnerId)
  const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
  const manifest = Buffer.from('{"format":1}')
  const stream = Buffer.from('the stream of the notebook\'s state')
  epochs.recordEpoch({
    sessionId, root: notebook.CELLS_KEY, seq: 1, at: now, mainRuns: 0, incarnation: epochs.epochIncarnation(), bytes: manifest.length + stream.length, shipBytes: 0,
    carried: ['x'], left: [], trouble: null,
    files: { manifest: { sha256: sha(manifest), bytes: manifest.length }, body: sha(stream), buffers: [{ sha256: sha(stream), bytes: stream.length }] },
    source: { runnerId: source.runnerId, role: 'room', container: CONTAINER, gen: placed.gen },
  })
  epochs.wantEpoch(sessionId, notebook.CELLS_KEY, { runnerId: poolMachine.runnerId, seq: 1 })
  // The machine of the export is to ship what this server lacks; the pool's has nothing to fetch yet.
  assert.deepEqual(epochs.epochIntentsFor(poolMachine.runnerId), [])
  const [ship] = epochs.epochIntentsFor(source.runnerId)
  assert.deepEqual(new Set(ship?.ship), new Set([sha(manifest), sha(stream)]))
  const put = (machine: InstanceType<typeof remote.Machine>, bytes: Buffer, gen: number, over: { sha?: string; length?: number } = {}) =>
    machine.call('PUT', remoteClassPaths.epoch(sha(bytes), sessionId, gen), {
      raw: bytes,
      headers: { [REMOTE_SHA256_HEADER]: over.sha ?? sha(bytes), [REMOTE_BYTES_HEADER]: String(over.length ?? bytes.length), 'content-type': 'application/octet-stream' },
    })
  assert.equal((await put(poolMachine, manifest, placed.gen)).status, 404, 'a machine not asked sent an epoch file')
  assert.equal((await put(source, manifest, placed.gen + 1)).status, 409, 'a fenced gen sent an epoch file')
  assert.equal((await put(source, manifest, placed.gen, { length: manifest.length + 1 })).status, 422)
  assert.equal((await put(source, Buffer.concat([manifest, Buffer.from(' ')]), placed.gen, { sha: sha(manifest) })).status, 422)
  assert.ok(!epochs.storeHas(sessionId, { sha256: sha(manifest), bytes: manifest.length }))
  const landed = await put(source, manifest, placed.gen)
  assert.equal(landed.status, 200, await landed.text())
  assert.equal((await put(source, stream, placed.gen)).status, 200)
  assert.ok(epochs.storeHas(sessionId, { sha256: sha(manifest), bytes: manifest.length }))
  assert.ok(epochs.storeHas(sessionId, { sha256: sha(stream), bytes: stream.length }))
  // Now the pool's machine fetches them from here: those blobs to it alone.
  const [fetch] = epochs.epochIntentsFor(poolMachine.runnerId)
  assert.equal(fetch?.from, 'home')
  const blob = await poolMachine.call('GET', `blobs/${sha(stream)}`)
  assert.equal(blob.status, 200)
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), stream)
  assert.equal((await source.call('GET', `blobs/${sha(stream)}`)).status, 404, 'the machine of the export may fetch it')
  // An attempt's file: only as its collection named it, under the council placement's gen.
  const council = row('council', poolMachine.runnerId)
  const runId = 'a'.repeat(32)
  const content = Buffer.from('a,b\n1,2\n')
  const landedNames: string[] = []
  epochs.askCollect({ sessionId, runId, runnerId: poolMachine.runnerId, gen: council.gen, files: [{ name: 'out.csv', sha256: sha(content), bytes: content.length }], landed: (name) => landedNames.push(name), over: () => {} })
  const putFile = (machine: InstanceType<typeof remote.Machine>, name: string, gen: number, bytes = content) =>
    machine.call('PUT', remoteClassPaths.artifact(sessionId, runId, name, gen), {
      raw: zlib.gzipSync(bytes),
      headers: { 'content-encoding': 'gzip', [REMOTE_SHA256_HEADER]: sha(bytes), [REMOTE_BYTES_HEADER]: String(bytes.length), 'content-type': 'application/octet-stream' },
    })
  assert.equal((await putFile(source, 'out.csv', council.gen)).status, 404)
  assert.equal((await putFile(poolMachine, 'other.csv', council.gen)).status, 404)
  assert.equal((await putFile(poolMachine, 'out.csv', council.gen + 1)).status, 409)
  assert.equal((await putFile(poolMachine, 'out.csv', council.gen, Buffer.from('a,b\n9,9\n'))).status, 422)
  assert.deepEqual(landedNames, [])
  const kept = await putFile(poolMachine, 'out.csv', council.gen)
  assert.equal(kept.status, 200, await kept.text())
  assert.deepEqual(landedNames, ['out.csv'])
  assert.deepEqual(fs.readFileSync(epochs.artifactPath(sessionId, runId, sha(content))), content)
  epochs.forgetClassEpochs(sessionId)
  useClassPort(null)
  remote.close()
})

/* ------------------------------------------------- the workers, after review */

test('an idle worker whose Python restarts by itself is loaded again before it serves: an OOM kill in the class\'s one cgroup costs no attempt its state', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const warm = room.attempt('p_s0', 'print(x)')
  assert.ok(await until(() => warm.last()?.state === 'ok'))
  const loads = fake.councilRuns.load
  // The cgroup's OOM killer takes the worker at rest: a new Python behind the same kernel, an empty namespace.
  fake.oomKill(room.workerKernel(1)!)
  // Its new Python answers (the client's comeback poll): loaded again, before any attempt asks for it.
  assert.ok(await until(() => fake.councilRuns.load === loads + 1 && room.pool()!.workers[0]!.seeded === 1, 200), JSON.stringify(room.pool()))
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => doneStates.has(attempt.last()?.state ?? '')), JSON.stringify(attempt.last()))
  assert.equal(attempt.last()?.placed, 'pool')
  assert.equal(attempt.said(), '5\n', 'the attempt computed on a worker that had lost its epoch')
})

test('a stop naming an attempt a worker holds and has not begun takes it off with no run, never a signal to the notebook\'s kernel; a cancel takes one there too', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual', sources: ['x = 5', '', 'HOLD teacher'] })
  room.run(2)
  assert.ok(await until(() => fake.holding('teacher') === 1))
  // The council slot's gate holds the worker's pump (its road blinked): the attempt is the worker's, not begun.
  let open: () => void = () => {}
  const gate = room.places.impl.placementGate
  room.places.impl.placementGate = (sessionId, role, signal) =>
    role === 'council' ? new Promise<void>((resolve) => { open = resolve }) : gate(sessionId, role, signal)
  t.after(() => {
    room.places.impl.placementGate = gate
    open()
  })
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => kernel.councilQueuePosition(room.id, room.councilCellId, 'p_s1') === 0))
  const teacher = socket()
  t.after(() => control.closeControlRoom(room.id))
  const interrupts = () => http('POST', new RegExp(`/api/kernels/${room.mainKernel()}/interrupt$`))
  const before = interrupts()
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'interrupt', cellId: room.councilCellId, participantId: 'p_s1' })
  await turns()
  assert.equal(attempt.last(), null, 'the card did not hear its attempt was taken off')
  assert.equal(interrupts(), before, 'the notebook\'s kernel was interrupted for an attempt of the pool')
  assert.equal(room.cell(2).state(), 'running')
  // The next is given to the worker at its gate again: a cancel takes it from there.
  open()
  const second = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => kernel.councilQueuePosition(room.id, room.councilCellId, 'p_s2') === 0))
  assert.equal(kernel.cancelCouncilRun(room.id, room.councilCellId, 'p_s2'), true, 'an attempt a worker holds and has not begun could not be cancelled')
  assert.equal(second.last(), null)
  room.places.impl.placementGate = gate
  open()
  fake.release('teacher')
  assert.ok(await until(() => room.cell(2).state() === 'ok'))
  assert.ok(!ranIn(room.workerKernel(1)).includes('print(x)'), 'an attempt taken off ran all the same')
})

test('an attempt a worker holds when the pool\'s machine is lost runs in the notebook\'s kernel saying the machine was lost, and the worker is held against nothing', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const gate = room.places.impl.placementGate
  room.places.impl.placementGate = (sessionId, role, signal) => (role === 'council' ? new Promise<void>(() => {}) : gate(sessionId, role, signal))
  t.after(() => {
    room.places.impl.placementGate = gate
  })
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => kernel.councilQueuePosition(room.id, room.councilCellId, 'p_s1') === 0))
  // The pool's machine is lost while the worker waits at its gate.
  room.places.set(room.id, 'council', { where: 'home' })
  room.places.emit({ sessionId: room.id, role: 'council', kind: 'lost', view: { where: 'home' }, cause: 'revoked', at: room.hand.now })
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.frames))
  assert.equal(attempt.frames.find((frame) => frame?.placed === 'shared')?.note, tr('server.thePoolSMachineWasLostThe.8aff4c'))
  assert.equal(attempt.said(), '5\n')
  assert.equal(room.pool()!.workers[0]!.broken, null, 'the worker was held against for its machine\'s loss')
})

test('a worker whose runtime went behind its pool\'s back (an owner\'s stop retires every scope) is started again, not given up on', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const handle = { sessionId: room.id, root: notebook.CELLS_KEY, n: 1 }
  // Its scope retired while the pool keeps its record: the window of an owner's stop in flight.
  await kernel.retireCouncilWorker(handle)
  assert.equal(kernel.workerState(handle).up, false)
  await tickBy(room, 5_000)
  assert.ok(await until(() => kernel.workerState(handle).up && room.pool()!.workers[0]!.seeded === 1), JSON.stringify(room.pool()))
  assert.equal(room.pool()!.workers[0]!.broken, null)
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.last()?.placed, 'pool')
})

test('two notebooks\' pools of one class share its one council container: it is sized for both', async (t) => {
  const room = await readyPool(t, { workers: 2, refresh: 'manual' })
  // A council in a second notebook of the class: a pool of its own, in the same container.
  const second = 'nb:second.ipynb'
  pool.councilOpened(room.id, second, 'second-council')
  assert.ok(await until(() => pool.poolForTest(room.id, second)?.workers.filter((worker) => worker.seeded !== null).length === 2), JSON.stringify(pool.poolForTest(room.id, second)))
  room.live.workers = 3
  await tickBy(room, 5_000)
  assert.ok(await until(() => room.pool()?.size === 3 && pool.poolForTest(room.id, second)?.size === 3))
  const buffers = [notebook.CELLS_KEY, second].reduce((sum, root) => sum + Math.ceil((epochs.epochsOf(room.id, root)[0]?.bytes ?? 0) / (1024 * 1024)), 0)
  const workers = [notebook.CELLS_KEY, second].reduce((sum, root) => sum + 3 * (1024 + COUNCIL_WORKER_BASE_MB + streamMbOf(epochs.epochsOf(room.id, root)[0] ?? null)), 0)
  assert.deepEqual(room.resizes.at(-1), { memoryMb: workers + buffers + 512, cpus: 6, workers: 6 }, 'the container was sized for one notebook\'s workers')
})

test('a class\'s notebooks number their epochs in one count: their exports, in the containers their kernels share, never meet in one folder', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const second = 'nb:second.ipynb'
  pool.councilOpened(room.id, second, 'second-council')
  assert.ok(await until(() => epochs.epochsOf(room.id, second).length === 1), JSON.stringify(pool.poolForTest(room.id, second)))
  assert.deepEqual(epochs.epochsOf(room.id, notebook.CELLS_KEY).map((epoch) => epoch.seq), [1])
  assert.deepEqual(epochs.epochsOf(room.id, second).map((epoch) => epoch.seq), [2], 'the second notebook\'s epoch took the first one\'s number, and so its folder')
  // A new life of this server counts on above every number any notebook of the class had.
  epochs.resetEpochsForTest()
  assert.equal(epochs.nextEpochSeq(room.id), 3)
})

/* -------------------------------------------- the epoch's lifecycle, after review */

test('after the owner stops the class\'s kernels the teacher\'s runs still count against the kept epoch: the next attempt refreezes and sees the new state', async (t) => {
  const room = await readyPool(t, { workers: 1 })
  for (const value of [6, 7]) {
    room.cell(0).type(`x = ${value}`)
    room.run(0)
    assert.ok(await until(() => room.cell(0).state() === 'ok' && kernel.kernelWorkOf(room.id, room.cell(0).id)?.busy === null))
  }
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  room.holdWanted()
  await kernel.stopKernelsByOwner(room.id, 'class', { force: true })
  // A console comes: the pool comes back on its kept epoch.
  pool.councilWarm(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => (room.pool()?.workers ?? []).some((worker) => worker.seeded === 2)), JSON.stringify(room.pool()))
  // The teacher goes on, in a fresh kernel.
  room.cell(0).type('x = 42')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => fake.councilRuns.export === 3 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  room.holdWanted()
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '42\n', 'the attempt ran on the state from before the stop, its card saying it was current')
  assert.equal(attempt.last()?.epoch?.seq, 3)
})

test('a restart of the notebook\'s kernel after the teacher\'s runs leaves the pool on its epoch: the empty kernel is not exported, and the first run after it is', async (t) => {
  const room = await readyPool(t)
  room.cell(0).type('x = 7')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  await kernel.restartSession(room.id, 'Teacher', notebook.CELLS_KEY)
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '5\n')
  assert.deepEqual([attempt.last()?.epoch?.seq, attempt.last()?.epoch?.behind], [1, 0])
  assert.equal(fake.councilRuns.export, 1, 'the restarted, empty kernel was exported')
  // The teacher's first run after the restart: the epoch is behind it, and the next attempt waits for its refreeze.
  room.cell(0).type('x = 8')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const after = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  room.holdWanted()
  assert.ok(await until(() => after.last()?.state === 'ok'), JSON.stringify(after.last()))
  assert.equal(after.said(), '8\n')
})

test('after a restart of this server a pool with no epoch it may use makes none up: the notebook\'s kernel may run still, and the attempts go to it', async (t) => {
  const { resetHeard } = await import('../server/src/competitions/remote/heard.js')
  fake.council.left = [{ name: 'model', why: 'cuda' }]
  const room = await poolClass(t, { refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, 'cuda')
  // The process goes as a crash takes it, and a new life begins: the notebook's kernel left running, not attached yet.
  kernel.abandonKernelsForTest()
  epochs.resetEpochsForTest()
  resetHeard(Date.now())
  room.room.readyBefore = true
  pool.councilWarm(room.id, notebook.CELLS_KEY, room.councilCellId)
  await turns()
  assert.ok(epochs.epochsOf(room.id, notebook.CELLS_KEY).every((epoch) => epoch.files !== null || epoch.trouble !== null), 'an empty epoch was made up')
  assert.equal(room.console()?.state, 'shared')
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => doneStates.has(attempt.last()?.state ?? '')), JSON.stringify(attempt.last()))
  assert.equal(attempt.frames[0]?.placed, 'shared')
  assert.equal(attempt.frames[0]?.note, tr('server.theNotebookSStateHoldsDataOn.2ac2bc'))
  assert.equal(attempt.said(), '5\n')
})

test('refreezes that cannot be the pool\'s keep the epoch it runs; an attempt waiting when its machine lets that epoch go runs in the notebook\'s kernel', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  fake.council.exportError = 'boom'
  for (const value of [6, 7]) {
    room.cell(0).type(`x = ${value}`)
    room.run(0)
    assert.ok(await until(() => room.cell(0).state() === 'ok' && kernel.kernelWorkOf(room.id, room.cell(0).id)?.busy === null))
    const before = fake.councilRuns.export
    assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
    assert.ok(await until(() => fake.councilRuns.export === before + 1 && room.pool()?.refreezing === false))
  }
  assert.deepEqual(epochs.epochsOf(room.id, notebook.CELLS_KEY).map((epoch) => [epoch.seq, epoch.trouble]), [[3, 'failed'], [1, null]])
  const busy = room.attempt('p_s0', 'HOLD worker')
  assert.ok(await until(() => fake.holding('worker') === 1), JSON.stringify(busy.frames))
  const waiting = room.attempt('p_s1', 'print(x)')
  assert.equal(waiting.frames[0]?.placed, 'pool')
  // Its machine lets the epoch go (its sync lists it no more): nothing in the pool can take the attempt.
  room.held.clear()
  epochs.noteEpochStates(room.poolRunner, [])
  assert.ok(await until(() => waiting.last()?.state === 'ok'), JSON.stringify(waiting.frames))
  assert.equal(waiting.last()?.placed, 'shared')
  assert.equal(waiting.said(), '7\n')
  assert.equal(room.pool()?.queue, 0)
  fake.release('worker')
})

test('an attempt waits for a fresher epoch at most five seconds from its press, however many refreezes the teacher\'s Run All asks meanwhile', async (t) => {
  const room = await readyPool(t, { workers: 1, sources: ['x = 5', '', 'HOLD t1\nx = 6', 'HOLD t2\nx = 7', 'HOLD t3\nx = 8'] })
  room.run(2, 3, 4)
  assert.ok(await until(() => fake.holding('t1') === 1))
  const attempt = room.attempt('p_s1', 'print(x)')
  await turns()
  assert.equal(attempt.last()?.state, 'queued')
  for (const [held, next, exports] of [['t1', 't2', 2], ['t2', 't3', 3]] as const) {
    room.hand.advance(2_000)
    fake.release(held)
    assert.ok(await until(() => fake.councilRuns.export === exports && fake.holding(next) === 1), `exports ${fake.councilRuns.export}`)
    await turns()
    room.holdWanted()
    await turns()
    assert.equal(attempt.last()?.state, 'queued', 'the attempt did not wait for a fresher epoch')
  }
  // Five seconds after the press: it goes on the newest epoch its machine holds, whatever refreeze is coming.
  room.hand.advance(1_000)
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '7\n')
  assert.equal(attempt.last()?.epoch?.seq, 3)
  fake.release('t3')
})

test('after a restart of this server an epoch too big to ship is not judged before its machine\'s first sync: the one the machine holds stays the pool\'s', async (t) => {
  biggerExports(() => 300 * 1024 * 1024)
  const room = await poolClass(t, { split: true, refresh: 'manual', workers: 1 })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  // The notebook kernel's placement on r1, whose container the export lies in.
  const placed = await placeRoom(room.id)
  t.after(() => placed.stop())
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  // The pool's machine holds it (it fetched it before).
  room.holdWanted()
  assert.ok(await until(() => room.console()?.state === 'ready'), JSON.stringify(room.console()))
  // The process goes as a crash takes it: the machine's next sync has not come yet.
  kernel.abandonKernelsForTest()
  epochs.resetEpochsForTest()
  room.held.clear()
  room.room.readyBefore = true
  pool.councilWarm(room.id, notebook.CELLS_KEY, room.councilCellId)
  await turns()
  assert.deepEqual(db.councilEpochsOf(room.id, notebook.CELLS_KEY).map((row) => [row.seq, (row.report as { trouble: unknown }).trouble]), [[1, null]])
  // Its first sync: it holds the epoch still.
  room.holdWanted()
  assert.ok(await until(() => room.pool()!.workers.every((worker) => worker.seeded === 1)), JSON.stringify(room.pool()))
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.last()?.placed, 'pool')
  assert.equal(room.console()?.state, 'ready')
})

test('a first epoch too big to ship to the pool\'s machine keeps the council in the shared kernel, the console saying so', async (t) => {
  biggerExports(() => 300 * 1024 * 1024)
  const room = await poolClass(t, { split: true, refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const placed = await placeRoom(room.id)
  t.after(() => placed.stop())
  room.toWorkers()
  // The pool's machine has synced: it holds nothing of the notebook's.
  epochs.noteEpochStates('r2', [])
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  assert.equal(room.console()?.state, 'shared')
  assert.equal(room.console()?.note, tr('server.theNotebookSStateDoesNotFit.c67b68'))
  assert.ok(!epochs.epochIntentsFor('r2').some((intent) => intent.seq === 1))
  // (The class folder's barrier is for a placement this suite has no files for: the attempt computes once it is gone.)
  placed.stop()
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.frames[0]?.note, tr('server.theNotebookSStateDoesNotFit.c67b68'))
})

/** The notebook kernel's placement on r1 in the registry, as a machine's ready report leaves it: the container its exports lie in. */
async function placeRoom(sessionId: string): Promise<{ stop(): void }> {
  const { writePlacement, updatePlacement } = await import('../server/src/kernel/remote/placement-store.js')
  const now = Date.now()
  const placed = writePlacement({
    sessionId, role: 'room', runnerId: 'r1', state: 'ready', environment: 'base', revision: { id: 'r', ref: 'x', layers: '[]' },
    memoryMb: 1024, cpus: 1, gpu: null, workers: null, container: CONTAINER, readyAt: now, endedAt: null, reason: null, createdAt: now,
  })
  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      updatePlacement(sessionId, 'room', placed.gen, { state: 'stopped', endedAt: Date.now() })
    },
  }
}

test('a home epoch whose files the store let go of is not taken for one a new machine can fetch: a fresh export is taken, every buffer written again', async (t) => {
  copyFromFake()
  let now = 1_000
  epochs.useStoreClock(() => now)
  t.after(() => epochs.useStoreClock(null))
  const room = await poolClass(t, { home: true, refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  const [epoch] = epochs.epochsOf(room.id, notebook.CELLS_KEY)
  assert.equal(epoch?.source, 'home')
  // Three classes store 1.5 GB each after it: past 4 GB the store lets go of this one's files, used least lately.
  const sha = (what: string) => createHash('sha256').update(what).digest('hex')
  const others: string[] = []
  t.after(() => {
    for (const sessionId of others) epochs.forgetClassEpochs(sessionId)
  })
  for (const name of ['o1', 'o2', 'o3']) {
    now += 1_000
    const sessionId = `${name}${seq++}`
    others.push(sessionId)
    db.createSession(sessionId, 'Other')
    const stream = { sha256: sha(sessionId), bytes: 1536 * 1024 * 1024 }
    const manifest = { sha256: sha(`${sessionId} manifest`), bytes: 0 }
    epochs.recordEpoch({
      sessionId, root: notebook.CELLS_KEY, seq: 1, at: now, mainRuns: 0, incarnation: epochs.epochIncarnation(), bytes: stream.bytes, shipBytes: 0,
      carried: [], left: [], trouble: null, source: 'home', files: { manifest, body: stream.sha256, buffers: [stream] },
    })
    for (const file of [manifest, stream]) {
      const staged = path.join(epochs.epochStagingDir(), `${file.sha256}.part`)
      fs.writeFileSync(staged, '')
      if (file.bytes > 0) fs.truncateSync(staged, file.bytes)
      epochs.landEpochUpload('r-other', sessionId, file, staged)
    }
  }
  epochs.pruneStore()
  assert.ok(epochs.storeLacks(room.id, epoch!.files).length > 0, 'the store kept this class\'s files')
  // The council slot moves to a machine that holds nothing of the epoch.
  room.places.set(room.id, 'council', room.view({ runnerId: 'r2', name: 'vast-7', gen: 2 }))
  kernel.kernelMachinesChanged(room.id)
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  const exports = ranIn(room.mainKernel()).filter((code) => code.includes('.export(globals()'))
  assert.match(exports[1]!, /'full': True/, 'the export reused buffers the store had let go of')
  assert.equal(epochs.epochIntentsFor('r2')[0]?.seq, 2)
})

test('an export of a kernel here that is not kept leaves no folder in the kernel\'s container', async (t) => {
  const copies = copyFromFake()
  const room = await poolClass(t, { home: true, refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  assert.deepEqual([[...copies], copies.drops], [[1], []])
  // One that does not come together: nothing of it is kept, and its folder goes.
  fake.council.exportError = 'boom'
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, 'failed')
  assert.deepEqual([[...copies], copies.drops], [[1], [2]], 'a failed export\'s folder stayed in the kernel\'s /tmp')
})

test('the pool\'s machine giving up on the only epoch (its files did not check out there) has one fresh export taken, every buffer written again', async (t) => {
  const room = await poolClass(t, { refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  const given = (seqs: number[]) => epochs.noteEpochStates('r1', seqs.map((n) => ({ sessionId: room.id, root: notebook.CELLS_KEY, seq: n, ready: false, failed: 'files' as const })))
  given([1])
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  const exports = () => ranIn(room.mainKernel()).filter((code) => code.includes('.export(globals()'))
  assert.match(exports()[1]!, /'full': True/)
  // Once: a machine that fails that one too is not fed exports until something changes.
  given([1, 2])
  for (let look = 0; look < 3; look++) await tickBy(room, 5_000)
  assert.equal(fake.councilRuns.export, 2)
})

/**
 * The notebook kernel's placement on r1, as a split pool's tests have it: the
 * container its exports lie in, which ships them home. Written once the
 * teacher's cells ran: a cell's run would wait at the files barrier of a
 * machine nobody plays here.
 */
async function kernelPlacedOnR1(t: TestContext, sessionId: string) {
  const { writePlacement, updatePlacement } = await import('../server/src/kernel/remote/placement-store.js')
  const now = Date.now()
  const placed = writePlacement({
    sessionId, role: 'room', runnerId: 'r1', state: 'ready', environment: 'base', revision: { id: 'r', ref: 'x', layers: '[]' },
    memoryMb: 1024, cpus: 1, gpu: null, workers: null, container: CONTAINER, readyAt: now, endedAt: null, reason: null, createdAt: now,
  })
  t.after(() => {
    updatePlacement(sessionId, 'room', placed.gen, { state: 'stopped', endedAt: Date.now() })
  })
  return placed
}

test('an export its own machine gives up, for a pool on another machine, is waited for no more: one fresh export is taken, every buffer written again', async (t) => {
  const room = await poolClass(t, { split: true, refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  await kernelPlacedOnR1(t, room.id)
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  assert.deepEqual(epochs.epochIntentsFor('r1').map((intent) => [intent.seq, intent.ship !== undefined]), [[1, true]], 'r1 was not asked to ship its export home')
  // r1 cannot read it (its folder gone from the kernel's /tmp): nothing of it can reach this server, nor the pool's machine.
  const given = (seqs: number[]) => epochs.noteEpochStates('r1', seqs.map((n) => ({ sessionId: room.id, root: notebook.CELLS_KEY, seq: n, ready: false, failed: 'source' as const })))
  given([1])
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  const exports = () => ranIn(room.mainKernel()).filter((code) => code.includes('.export(globals()'))
  assert.match(exports()[1]!, /'full': True/)
  assert.deepEqual(epochs.epochIntentsFor('r1').map((intent) => intent.seq), [2])
  // Once: a machine that gives that one up too is not fed exports until something changes.
  given([1, 2])
  for (let look = 0; look < 3; look++) await tickBy(room, 5_000)
  assert.equal(fake.councilRuns.export, 2)
})

test('an export its own machine gave up is asked of it no more, a full disk there excepted: that machine tries again by itself', async (t) => {
  const sessionId = `ship${seq++}`
  db.createSession(sessionId, 'Ship')
  await kernelPlacedOnR1(t, sessionId)
  t.after(() => {
    epochs.wantEpoch(sessionId, notebook.CELLS_KEY, null)
    epochs.forgetClassEpochs(sessionId)
  })
  const file = (what: string, bytes: number) => ({ sha256: createHash('sha256').update(what).digest('hex'), bytes })
  const body = file('stream', 1000)
  epochs.recordEpoch({
    sessionId, root: notebook.CELLS_KEY, seq: 1, at: Date.now(), mainRuns: 0, incarnation: epochs.epochIncarnation(), bytes: 1500, shipBytes: 1500,
    carried: [], left: [], files: { manifest: file('manifest', 500), body: body.sha256, buffers: [body] },
    source: { runnerId: 'r1', role: 'room', container: CONTAINER, gen: 1 }, trouble: null,
  })
  // A pool on r2 wants it: r1, whose container holds the export, is to send home what this server lacks.
  epochs.wantEpoch(sessionId, notebook.CELLS_KEY, { runnerId: 'r2', seq: 1 })
  assert.deepEqual(epochs.epochIntentsFor('r1').map((intent) => [intent.seq, intent.ship?.length]), [[1, 2]])
  epochs.noteEpochStates('r1', [{ sessionId, root: notebook.CELLS_KEY, seq: 1, ready: false, failed: 'disk' }])
  assert.deepEqual(epochs.epochIntentsFor('r1').map((intent) => intent.seq), [1])
  epochs.noteEpochStates('r1', [{ sessionId, root: notebook.CELLS_KEY, seq: 1, ready: false, failed: 'source' }])
  assert.deepEqual(epochs.epochIntentsFor('r1'), [], 'r1 is still asked for an export it gave up')
})

test('an export written but not kept (past what an epoch may hold) has the next one write every buffer again: the kernel\'s table of its buffers was that export\'s', async (t) => {
  const copies = copyFromFake()
  let extra = 0
  biggerExports(() => extra)
  const room = await poolClass(t, { home: true, refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  extra = COUNCIL_EPOCH_MB * 1024 * 1024
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, 'failed')
  assert.deepEqual(copies.drops, [2], 'its folder stayed in the kernel\'s /tmp')
  extra = 0
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 3 && room.pool()?.refreezing === false))
  const exports = ranIn(room.mainKernel()).filter((code) => code.includes('.export(globals()'))
  assert.deepEqual(exports.map((code) => /'full': True/.test(code)), [false, false, true])
})

test('«Пул не поднялся» gives the placement\'s own words for its council slot, a machine\'s name never: those words are staff\'s', async (t) => {
  const { RuntimeRequestError } = await import('../server/src/kernel/runtime-client.js')
  const room = await poolClass(t, { refresh: 'manual' })
  // The council's slot on «vast-3», as the pool reads it.
  assert.equal(kernel.slotViewOf(room.id, 'council').where, 'machine')
  const nobody = tr('server.theCouncilPoolRunsOnlyOnMachines.ef5702')
  assert.equal(kernel.councilStartWords(room.id, new RuntimeRequestError(nobody, 503)), nobody)
  const named = tr('server.theKernelDidNotStartOnMachine.5db0fa', { machine: NAME, seconds: 60 })
  assert.equal(kernel.councilStartWords(room.id, new RuntimeRequestError(named, 503)), tr('server.theKernelDidNotStartOnThe.8ad0fb'))
  // This server's own errors are English, for its log: the pool says its own words then.
  assert.equal(kernel.councilStartWords(room.id, new Error('the guard was not confirmed')), null)
})

test('a pool whose workers cannot load the notebook\'s state says so in the room\'s words, the server\'s detail kept for its log', async (t) => {
  fake.council.loadError = 'Traceback (most recent call last): an internal detail'
  const room = await poolClass(t, { refresh: 'manual', workers: 1 })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  room.toWorkers()
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  room.holdWanted()
  assert.ok(await until(() => (room.pool()?.workers ?? []).every((worker) => worker.broken !== null) && fake.councilRuns.load > 0), JSON.stringify(room.pool()))
  const words = tr('server.thePoolDidNotStart.80644c', { why: tr('server.theWorkersCouldNotLoadThe.69de42') })
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.equal(attempt.frames[0]?.note, words)
  assert.equal(room.console()?.note, words)
  // The failure passes: once its while is over, the worker is tried again and loads, and the pool serves.
  fake.council.loadError = null
  await tickBy(room, 30_000)
  assert.ok(await until(() => room.pool()!.workers.every((worker) => worker.seeded === 1 && worker.broken === null)), JSON.stringify(room.pool()))
  const later = room.attempt('p_s2', 'print(x)')
  assert.ok(await until(() => later.last()?.state === 'ok'))
  assert.equal(later.last()?.placed, 'pool')
})

test('a refreeze asked while a teacher\'s cell waits before its execute counts that cell: the epoch, taken after it, is not behind it', async (t) => {
  const { setInstanceLanguage } = await import('../server/src/admin/settings.js')
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  // Another language, another guard: the next cell installs it before its execute, and that install is held.
  setInstanceLanguage('en')
  fake.holdSilent = [{ match: '].apply(', name: 'guard', kernel: room.mainKernel()! }]
  room.cell(0).type('x = 6')
  room.run(0)
  assert.ok(await until(() => fake.holding('guard') === 1))
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  fake.holdSilent = []
  fake.release('guard')
  assert.ok(await until(() => room.cell(0).state() === 'ok' && fake.councilRuns.export === 2 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  room.holdWanted()
  assert.ok(await until(() => room.console()?.epoch?.seq === 2), JSON.stringify(room.console()))
  assert.equal(room.console()?.epoch?.behind, 0, 'the epoch taken after the cell reads as behind it')
})

test('an export that ends after its pool stopped asks no machine to hold its epoch', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  fake.holdSilent = [{ match: '.export(globals()', name: 'export', kernel: room.mainKernel()! }]
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.holding('export') === 1))
  pool.councilClosed(room.id, notebook.CELLS_KEY, room.councilCellId)
  await tickBy(room, 15 * 60_000)
  assert.ok(await until(() => room.pool() === null))
  fake.holdSilent = []
  fake.release('export')
  assert.ok(await until(() => fake.councilRuns.export === 2))
  await turns()
  assert.deepEqual(epochs.epochIntentsFor('r1'), [], 'a machine is asked to hold the epoch of a pool that is gone')
})

test('a stop pressed while the epoch\'s export runs between the teacher\'s cells does not end the export', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual', sources: ['x = 5', '', 'x = 6'] })
  fake.holdSilent = [{ match: '.export(globals()', name: 'export', kernel: room.mainKernel()! }]
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.holding('export') === 1))
  room.run(2)
  await turns()
  const interrupts = () => http('POST', new RegExp(`/api/kernels/${room.mainKernel()}/interrupt$`))
  const before = interrupts()
  await kernel.interruptSession(room.id, room.cell(2).id, notebook.CELLS_KEY)
  assert.equal(interrupts(), before, 'the stop reached the export')
  fake.holdSilent = []
  fake.release('export')
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, null)
})

test('«Обновить состояние» pressed while a refreeze is still being taken in takes one more once it is done, when the teacher ran cells meanwhile', async (t) => {
  let held = false
  let release: () => void = () => {}
  epochs.useEpochCollector(async (_sessionId, _role, seq, into) => {
    if (into === null) return
    // The copy-out of a big export takes its while: the notebook's queue moves on meanwhile.
    if (held) await new Promise<void>((resolve) => { release = resolve })
    const from = fake.epochFolder(seq)
    for (const name of fs.readdirSync(from)) fs.writeFileSync(path.join(into, name), fs.readFileSync(path.join(from, name)))
  })
  const room = await poolClass(t, { home: true, refresh: 'manual' })
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  held = true
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === true))
  // The teacher runs a cell while that one is copied in, and presses again.
  room.cell(0).type('x = 7')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  held = false
  release()
  assert.ok(await until(() => fake.councilRuns.export === 3 && room.pool()?.refreezing === false), `exports ${fake.councilRuns.export}`)
  assert.deepEqual(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.carried, ['x'])
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.mainRuns, 2)
})

test('a council cell deleted from the notebook closes its pool as the lock would: it stops fifteen minutes later', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  // Deleted, not closed by the lock: no message says so.
  const found = notebook.findCell(room.doc, room.councilCellId)!
  notebook.getCells(room.doc).delete(found.index, 1)
  await tickBy(room, 5_000)
  await tickBy(room, 15 * 60_000)
  assert.ok(await until(() => room.pool() === null), 'the pool of a deleted council never stopped')
})

test('an attempt\'s file landing after its author pressed the same text again leaves the new run\'s card alone', async (t) => {
  const council = await import('../server/src/council.js')
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  fake.council.files = [{ name: 'out.csv', text: 'a,b\n' }]
  const cellId = room.councilCellId
  const text = 'HOLD r\nprint(x)'
  council.saveDraft(room.id, cellId, 'p_s1', text, Date.now())
  // As control.ts wires a press: every frame through recordRun, with the text it computes.
  const press = () =>
    kernel.requestCouncilRun(
      room.id,
      { cellId, participantId: 'p_s1', source: text, by: 'author', limitSec: null, onChange: (run) => void council.recordRun(room.id, cellId, 'p_s1', run, text) },
      'p_s1', 'p_s1', { lane: 'pool', refresh: 'manual' },
    )
  const stored = () => council.attemptOf(room.id, cellId, 'p_s1')?.run ?? null
  press()
  assert.ok(await until(() => fake.holding('r') === 1))
  fake.release('r')
  assert.ok(await until(() => stored()?.state === 'ok'))
  const runId = stored()!.runId!
  const [collect] = epochs.collectFor('r1')
  assert.equal(collect?.runId, runId)
  // The same text again: its run computes now.
  press()
  assert.ok(await until(() => fake.holding('r') === 1 && stored()?.state === 'running'))
  // The first run's file lands only now.
  const staged = path.join(fake.epochFolder(0), 'late.part')
  fs.mkdirSync(path.dirname(staged), { recursive: true })
  fs.writeFileSync(staged, 'a,b\n')
  epochs.landArtifact(room.id, runId, 'out.csv', staged, epochs.artifactPath(room.id, runId, collect!.files[0]!.sha256))
  assert.equal(stored()?.state, 'running', 'the first run\'s file put its end on the card of the run computing now')
  assert.notEqual(stored()?.runId, runId)
  fake.release('r')
  assert.ok(await until(() => stored()?.state === 'ok'))
  fake.council.files = []
})

test('an attempt run again after its pool\'s machine was lost, whose author edited the text meanwhile, lands nothing under the new text', async (t) => {
  const council = await import('../server/src/council.js')
  const room = await readyPool(t, { workers: 1, refresh: 'manual', split: true })
  const cellId = room.councilCellId
  const old = 'HOLD lost\nprint("old")'
  council.saveDraft(room.id, cellId, 'p_s1', old, Date.now())
  kernel.requestCouncilRun(
    room.id,
    { cellId, participantId: 'p_s1', source: old, by: 'author', limitSec: null, onChange: (run) => void council.recordRun(room.id, cellId, 'p_s1', run, old) },
    'p_s1', 'p_s1', { lane: 'pool', refresh: 'manual' },
  )
  assert.ok(await until(() => fake.holding('lost') === 1))
  // The author edits the text while it computes, and presses nothing.
  council.saveDraft(room.id, cellId, 'p_s1', 'print("new")', Date.now())
  // The pool's machine is lost: the attempt is run once more in the notebook's kernel.
  room.poolRoad.lose({ cut: false })
  room.places.set(room.id, 'council', { where: 'home' })
  jupyter.useDefaultEndpointForTest({ url: room.road.url, token: 'fake', link: room.road.link, identity: `machine:r1:${CONTAINER}:1` })
  room.places.emit({ sessionId: room.id, role: 'council', kind: 'lost', view: { where: 'home' }, cause: 'revoked', at: room.hand.now })
  assert.ok(await until(() => ranIn(room.mainKernel()).some((code) => code.startsWith('HOLD lost'))))
  fake.release('lost')
  assert.ok(await until(() => !kernel.sessionComputing(room.id)))
  const attempt = council.attemptOf(room.id, cellId, 'p_s1')
  assert.equal(attempt?.text, 'print("new")')
  assert.equal(attempt?.run ?? null, null, 'the old text\'s output is on the card under the new one')
})

test('attempts waiting in the pool when its machine stops answering go to the notebook\'s kernel at once, keeping their place ahead of later presses', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const busy = room.attempt('p_s0', 'HOLD worker')
  assert.ok(await until(() => fake.holding('worker') === 1))
  const waiting = room.attempt('p_s1', 'print("first")')
  assert.equal(room.pool()?.queue, 1)
  // The pool's machine stops answering, and the class waits for it («ждать машину»): no loss comes.
  const away = room.view({ state: 'unreachable', since: room.hand.now, failover: 'wait' })
  room.places.set(room.id, 'council', away)
  room.places.emit({ sessionId: room.id, role: 'council', kind: 'unreachable', view: away, at: room.hand.now })
  assert.ok(await until(() => waiting.frames.some((frame) => frame?.placed === 'shared')), JSON.stringify(waiting.frames))
  assert.equal(waiting.frames.find((frame) => frame?.placed === 'shared')?.note, tr('server.thePoolSMachineDoesNotAnswer.16922d'))
  assert.equal(room.pool()?.queue, 0)
  const later = room.attempt('p_s2', 'print("second")')
  assert.ok(await until(() => waiting.last()?.state === 'ok' && later.last()?.state === 'ok'), JSON.stringify([waiting.last(), later.last()]))
  // In the order pressed.
  assert.deepEqual(ranIn(room.mainKernel()).filter((code) => code.startsWith('print("')), ['print("first")', 'print("second")'])
  fake.release('worker')
  void busy
})

/* -------------------------------------------- what the console reads (F6) */

/** «14:05» of an epoch, as the server's sentences say it: the instance's time zone. */
async function serverClock(at: number): Promise<string> {
  const zone = (await import('../server/src/time-zone.js')).instanceTimeZone()
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}

test('a press while every worker loads a fresh epoch waits in the pool\'s queue for them, never in the notebook\'s kernel', async (t) => {
  const room = await readyPool(t, { workers: 2, refresh: 'manual', sources: ['x = 5', '', 'x = 6'] })
  // Every worker between its recycle and its load of the next epoch: the moment a burst caught (K12b, handoff 1).
  fake.holdSilent = [{ match: '.load(globals()', name: 'reload' }]
  room.run(2)
  assert.ok(await until(() => room.cell(2).state() === 'ok'))
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  room.holdWanted()
  assert.ok(await until(() => fake.holding('reload') === 2), JSON.stringify(room.pool()))
  assert.deepEqual(room.pool()!.workers.map((worker) => worker.seeded), [null, null])
  assert.equal(room.console()?.state, 'ready', 'a pool reloading its workers read as one still starting')
  const attempt = room.attempt('p_s1', 'print(x)')
  await turns()
  assert.deepEqual([attempt.frames[0]?.state, attempt.frames[0]?.placed, attempt.frames[0]?.note], ['queued', 'pool', undefined], JSON.stringify(attempt.frames))
  fake.holdSilent = []
  fake.release('reload')
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '6\n')
  assert.deepEqual([attempt.last()?.placed, attempt.last()?.epoch?.seq], ['pool', 2])
  assert.ok(!ranIn(room.mainKernel()).includes('print(x)'), 'the attempt ran in the notebook\'s kernel')
})

test('a pool not up a minute after the first attempt says what it waits for, never the card\'s sentence after a colon of its own', async (t) => {
  const room = await poolClass(t)
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  pool.councilOpened(room.id, notebook.CELLS_KEY, room.councilCellId)
  assert.ok(await until(() => fake.councilRuns.export === 1 && room.pool()?.refreezing === false))
  // Its machine never says it holds the epoch.
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => doneStates.has(attempt.last()?.state ?? '')))
  assert.equal(attempt.frames[0]?.note, tr('server.thePoolIsStillStartingThisAttempt.bf84be'))
  assert.equal(room.console()?.note, undefined, 'the console said the pool did not start before a minute')
  room.hand.advance(COUNCIL_POOL_READY_MS)
  await turns()
  assert.equal(room.console()?.note, tr('server.thePoolDidNotStart.80644c', { why: tr('server.theNotebookSStateHasNotReached.461833') }))
  assert.equal(room.console()?.state, 'starting')
})

test('the console hears the pool\'s size, a snapshot\'s start and the teacher\'s cell it takes in, how long the last one took, and the epoch\'s size', async (t) => {
  const room = await readyPool(t, { workers: 2, refresh: 'manual', sources: ['x = 5', '', 'x = 6'] })
  fake.council.buffers = [4096]
  const before = room.console()!
  assert.equal(before.size, 2)
  assert.equal(before.snapshot, undefined)
  assert.equal(typeof before.tookMs, 'number')
  room.run(2)
  assert.ok(await until(() => room.cell(2).state() === 'ok'))
  fake.holdSilent = [{ match: '.export(globals()', name: 'export', kernel: room.mainKernel()! }]
  const asked = room.hand.now
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.holding('export') === 1))
  // «снимок состояния · 0,4 с», «после вашей ячейки 3»: since when, by the server's clock, and which of the teacher's cells.
  assert.deepEqual(room.console()?.snapshot, { since: asked, after: notebook.findCell(room.doc, room.cell(2).id)!.index + 1 })
  room.hand.advance(400)
  fake.holdSilent = []
  fake.release('export')
  assert.ok(await until(() => room.pool()?.refreezing === false))
  room.holdWanted()
  assert.ok(await until(() => room.console()?.epoch?.seq === 2), JSON.stringify(room.console()))
  const after = room.console()!
  assert.equal(after.snapshot, undefined)
  assert.equal(after.tookMs, 400, '«переснимается за 0,4 с»')
  const epoch = epochs.epochOf(room.id, notebook.CELLS_KEY, 2)!
  assert.ok(epoch.bytes > 4096)
  assert.equal(after.epoch?.bytes, epoch.bytes, '«снимок 1,2 ГБ»')
})

test('a worker restarted for what an attempt left it in is the console\'s for a minute; a routine reload is not', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  // A new epoch reloads the worker: routine, said nowhere.
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  room.holdWanted()
  assert.ok(await until(() => room.pool()!.workers.every((worker) => worker.seeded === 2)), JSON.stringify(room.pool()))
  assert.equal(room.console()?.recycled, undefined)
  // An attempt leaves a thread behind: the worker is recycled before it serves again, and the console says so.
  fake.council.threads = 1
  const attempt = room.attempt('p_s1', 'print(x)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'))
  assert.ok(await until(() => room.console()?.recycled === true), JSON.stringify(room.console()))
  fake.council.threads = 0
  room.hand.advance(60_000)
  await turns()
  assert.equal(room.console()?.recycled, undefined, 'the restart was said past its minute')
})

test('a refresh that does not come together leaves the attempts on the previous state, and the console says so with its time', async (t) => {
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  const first = epochs.epochOf(room.id, notebook.CELLS_KEY, 1)!
  fake.council.exportError = 'MemoryError'
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  assert.equal(epochs.epochsOf(room.id, notebook.CELLS_KEY)[0]?.trouble, 'failed')
  assert.deepEqual([room.console()?.state, room.console()?.epoch?.seq], ['ready', 1])
  assert.equal(room.console()?.note, tr('server.theNewStateCouldNotBeTaken.01b6b1', { time: await serverClock(first.at) }))
  fake.council.exportError = null
})

test('names a worker\'s load leaves for a module its machine lacks join the console\'s «Не переносится», and an attempt reading one runs in the notebook\'s kernel', async (t) => {
  fake.council.loadLeft = [{ name: 'model', why: 'module' }]
  const room = await readyPool(t, { workers: 1, refresh: 'manual', sources: ['x = 5\nmodel = 7', ''] })
  assert.deepEqual(epochs.epochOf(room.id, notebook.CELLS_KEY, 1)?.left, [], 'the export carried it')
  assert.deepEqual(room.console()?.epoch?.left, [{ name: 'model', why: tr('server.itsModuleIsOnlyInTheNotebook.49d81a') }])
  const attempt = room.attempt('p_s1', 'print(model)')
  assert.ok(await until(() => attempt.last()?.state === 'ok'), JSON.stringify(attempt.last()))
  assert.equal(attempt.said(), '7\n')
  assert.deepEqual([attempt.last()?.placed, attempt.last()?.note], ['shared', tr('server.runInTheSharedKernelItUses.eaf141', { name: 'model' })])
})

test('a notebook kernel whose container has no PYTHONHASHSEED of the class has the console say sets may come out in another order; one that has it, nothing', async (t) => {
  fake.council.hashSeed = null
  const room = await readyPool(t, { workers: 1, refresh: 'manual' })
  assert.equal(room.console()?.epoch?.seedDiffers, true)
  fake.council.hashSeed = String(classHashSeed(room.id))
  assert.ok(pool.councilRefresh(room.id, notebook.CELLS_KEY))
  assert.ok(await until(() => fake.councilRuns.export === 2 && room.pool()?.refreezing === false))
  room.holdWanted()
  assert.ok(await until(() => room.console()?.epoch?.seq === 2), JSON.stringify(room.console()))
  assert.equal(room.console()?.epoch?.seedDiffers, undefined)
})
