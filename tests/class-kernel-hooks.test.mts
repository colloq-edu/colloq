/**
 * The kernel hooks of a class whose kernels compute on a machine
 * (docs/architecture/remote-classes.md §5, §6.8, §10, §11.2, §13.1): what
 * kernel/index.ts and control.ts do differently when the kernel is over
 * there, and that a class here notices none of it.
 *
 * The placement module (kernel/remote/placement.ts) is a fake, handed in
 * through the same door the real one comes by (`useClassPlacements`), with a
 * clock the test moves by hand. The machine's kernel is the fake Jupyter
 * behind a road the test opens and closes (tests/_fake-jupyter.mjs ·
 * startFakeLink), which is all a placement's endpoint is to this server.
 * Notes are counted after the clock is moved, never by waiting; everything
 * else is polled for.
 */
import './_env.mts'
import { after, afterEach, before, beforeEach, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { guardAnswer } from './_guard.mts'
import { GUARD_MODULE, startFakeJupyter, startFakeLink } from './_fake-jupyter.mjs'
import type { ClassClock, ClassPlacements, PlacementEvent, PlacementView } from '../server/src/kernel/index.js'
import type { TokenPayload } from '../server/src/auth.js'
import type { ControlClientMessage, ControlServerMessage, CouncilRun } from '../shared/protocol.js'
import { durationWords } from '../shared/text.js'

// Reacting in milliseconds rather than the ten seconds a real room can afford, as kernel.test.mts does.
process.env.KERNEL_QUIET_MS = '150'
process.env.KERNEL_WATCHDOG_MS = '50'

let kernel: typeof import('../server/src/kernel/index.js')
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
  jupyter = await import('../server/src/kernel/jupyter.js')
  notebook = await import('../shared/notebook.js')
  db = await import('../server/src/db.js')
  collab = await import('../server/src/collab/index.js')
  control = await import('../server/src/control.js')
  tr = (await import('../shared/i18n.js')).tr
})

beforeEach(async () => {
  const { setInstanceLanguage } = await import('../server/src/admin/settings.js')
  setInstanceLanguage('ru')
})

afterEach(() => {
  fake.reset()
  kernel.useClassPlacements(null)
  jupyter.useDefaultEndpointForTest(null)
})

after(async () => {
  await kernel.shutdownKernels()
  await fake.close()
  collab.shutdownCollab()
})

/* ------------------------------------------------------------------ helpers */

const NAME = 'vast-3'
const NOTE_MS = 10_000

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

/** A clock the test moves: the hooks' timers fire as it passes them, in order. */
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

type MachineView = Extract<PlacementView, { where: 'machine' }>

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
  const gates: Array<{ key: string; resolve: () => void; reject: (err: unknown) => void }> = []
  const moved: Array<{ sessionId: string; role: string | null; by: string }> = []
  const asked = { gates: 0, pads: 0 }
  let pad = 0
  let refusal: string | null = null
  const key = (sessionId: string, role: string) => `${sessionId}:${role}`
  const impl: ClassPlacements = {
    placementOf: (sessionId, role) => views.get(key(sessionId, role)) ?? { where: 'home' },
    placementGate: (sessionId, role, signal) => {
      asked.gates++
      const view = views.get(key(sessionId, role))
      if (!view || view.where !== 'machine' || view.state !== 'unreachable') return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        gates.push({ key: key(sessionId, role), resolve, reject })
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
    onPlacementChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    moveNow: async (sessionId, role, by) => {
      if (refusal !== null) return { refused: refusal }
      moved.push({ sessionId, role, by })
      return { ok: true }
    },
    helpPadMs: () => {
      asked.pads++
      return pad
    },
    PlacementLost,
  }
  const settle = (sessionId: string, role: string, how: (gate: (typeof gates)[number]) => void) => {
    const mine = gates.filter((gate) => gate.key === key(sessionId, role))
    for (const gate of mine) {
      gates.splice(gates.indexOf(gate), 1)
      how(gate)
    }
    return mine.length
  }
  return {
    impl,
    gates,
    moved,
    asked,
    set: (sessionId: string, role: string, view: PlacementView) => views.set(key(sessionId, role), view),
    emit: (event: PlacementEvent) => {
      for (const listener of [...listeners]) listener(event)
    },
    open: (sessionId: string, role = 'room') => settle(sessionId, role, (gate) => gate.resolve()),
    lose: (sessionId: string, role = 'room', cause = 'silence') =>
      settle(sessionId, role, (gate) => gate.reject(new PlacementLost(`staff: ${NAME} is gone`, cause))),
    pad: (ms: number) => {
      pad = ms
    },
    refuse: (words: string | null) => {
      refusal = words
    },
  }
}

let seq = 0

/** A class with code cells of these sources (beside the first one of its notebook). */
async function seminar(sources: string[] = []) {
  const id = `hooks${seq++}`
  db.createSession(id, `Hooks ${id}`)
  const { doc } = collab.getSessionDoc(id)
  const cells = notebook.getCells(doc)
  for (const source of sources) cells.push([notebook.createCell('code', source)])
  const code = cells.toArray().filter((cell) => notebook.cellType(cell) === 'code')
  const cell = (index: number) => {
    const one = code[index]!
    return {
      id: notebook.cellId(one),
      state: () => one.get('state') as string,
      type(source: string) {
        const text = notebook.cellSource(one)
        text.delete(0, text.length)
        text.insert(0, source)
      },
      said: () =>
        notebook
          .readOutputs(one)
          .map((output) => (output.kind === 'stream' ? output.text : output.kind === 'error' ? output.evalue : ''))
          .join(''),
    }
  }
  return {
    id,
    doc,
    cell,
    notes: () =>
      notebook
        .getTerminal(doc)
        .toArray()
        .filter((line) => line.get('kind') === 'system')
        .map((line) => String(line.get('text'))),
    entry: () => notebook.bookKernel(doc, notebook.CELLS_KEY),
    run: (...indices: number[]) =>
      kernel.requestRun(id, indices.map((index) => cell(index).id), 'Teacher', 'p_teacher', undefined, notebook.CELLS_KEY),
  }
}

type Room = Awaited<ReturnType<typeof seminar>>

/**
 * A class whose kernels compute on a pretend machine «vast-3»: its slot is
 * placed there and ready, and every kernel it starts is the fake behind a
 * road of its own, with the identity of that placement.
 */
async function machineClass(t: TestContext, sources: string[] = [], gen = 1) {
  const hand = handClock()
  const places = fakePlacements()
  kernel.useClassPlacements(places.impl, hand.clock)
  const road = await startFakeLink({ target: fake.port })
  jupyter.useDefaultEndpointForTest({ url: road.url, token: 'fake', link: road.link, identity: `machine:r1:c1:${gen}` })
  const room = await seminar(sources)
  const view = (over: Partial<MachineView> = {}): MachineView => ({
    where: 'machine',
    runnerId: 'r1',
    name: NAME,
    gen,
    state: 'ready',
    link: road.link,
    since: hand.now,
    failover: 'auto',
    failoverAt: null,
    ...over,
  })
  places.set(room.id, 'room', view())
  t.after(async () => {
    await kernel.shutdownSession(room.id).catch(() => {})
    await road.close()
  })
  return { hand, places, road, room, view }
}

/** The moment as the room's notes write it: the instance's zone, HH:MM:SS. */
async function clockTime(at: number): Promise<string> {
  const { instanceTimeZone } = await import('../server/src/time-zone.js')
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: instanceTimeZone(),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(at)
}

/** Requests of one kind the fake received: HTTP by method and path. */
const http = (method: string, path: RegExp) =>
  fake.calls.filter((call) => call.kind === 'http' && call.method === method && path.test(call.path)).length

/** Whether the room's document names the machine anywhere at all. */
const names = (room: Room) => JSON.stringify(room.doc.toJSON()).includes(NAME)

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
const student = (sessionId: string): TokenPayload => ({ sessionId, participantId: 'p_student', role: 'participant' })

/** What one socket was told as errors, in order. */
const errorsOf = (heard: ControlServerMessage[]) =>
  heard.flatMap((message) => (message.t === 'error' ? [message.message] : []))

/* ----------------------------------------------------------- the gate §5.3 */

test('a run waits at the gate of a machine that does not answer, the room hears of it after ten seconds, and the cell runs once it is back', async (t) => {
  const { hand, places, room, view } = await machineClass(t)
  places.set(room.id, 'room', view({ state: 'unreachable', since: hand.now }))
  const cell = room.cell(0)
  cell.type('print("hi")')
  room.run(0)
  assert.equal(places.gates.length, 1, 'the run did not wait at the gate')
  assert.equal(cell.state(), 'queued')
  // The chip turns amber at once, and the waiting cell reads «ждёт машину» from it.
  assert.equal(room.entry().where, 'machine')
  assert.equal(room.entry().link, 'lost')

  const unreachable = tr('server.noConnectionToTheMachineTheKernel.71d94f', { elapsed: '0:10' })
  hand.advance(NOTE_MS - 1)
  assert.ok(!room.notes().includes(unreachable), 'a blip shorter than ten seconds was announced')
  hand.advance(1)
  assert.equal(room.notes().filter((note) => note === unreachable).length, 1)
  assert.equal(cell.state(), 'queued', 'the cell left the queue while its machine did not answer')
  assert.ok(!names(room), 'the room’s document named the machine')

  hand.advance(27_000)
  const back = view({ state: 'ready', since: hand.now })
  places.set(room.id, 'room', back)
  places.emit({ sessionId: room.id, role: 'room', kind: 'back', view: back, at: hand.now })
  places.open(room.id)
  assert.ok(await until(() => cell.state() === 'ok'), `the cell is ${cell.state()}`)
  assert.equal(cell.said(), 'hi\n')
  const returned = tr('server.theConnectionToTheMachineCameBack.d517ba', { seconds: 37 })
  assert.equal(room.notes().filter((note) => note === returned).length, 1, 'the return was said twice, or not at all')
  assert.equal(room.entry().link, 'ok')
})

test('a blip shorter than ten seconds says nothing, neither that it went nor that it came back', async (t) => {
  const { hand, places, room, view } = await machineClass(t)
  room.cell(0).type('print("first")')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const before = room.notes().length
  const quiet = view({ state: 'unreachable', since: hand.now })
  places.emit({ sessionId: room.id, role: 'room', kind: 'unreachable', view: quiet, at: hand.now })
  assert.equal(room.entry().link, 'lost')
  hand.advance(NOTE_MS - 1)
  places.emit({ sessionId: room.id, role: 'room', kind: 'back', view: view({ since: hand.now }), at: hand.now })
  hand.advance(NOTE_MS)
  assert.deepEqual(room.notes().slice(before), [])
  assert.equal(room.entry().link, 'ok')
})

test('an outage that began before anyone of the class was here is told to the first notebook that waits for it', async (t) => {
  const { hand, places, room, view } = await machineClass(t)
  // The machine goes quiet while this process holds nothing of the class: before class, or after a restart of this server.
  const quiet = view({ state: 'unreachable', since: hand.now })
  places.set(room.id, 'room', quiet)
  places.emit({ sessionId: room.id, role: 'room', kind: 'unreachable', view: quiet, at: hand.now })
  hand.advance(NOTE_MS + 20_000)
  assert.deepEqual(room.notes(), [])
  // A Run then waits for the machine: the room hears of it at once, with the time since the machine went quiet.
  room.cell(0).type('print("hi")')
  room.run(0)
  assert.equal(places.gates.length, 1)
  const unreachable = tr('server.noConnectionToTheMachineTheKernel.71d94f', { elapsed: '0:30' })
  assert.deepEqual(room.notes(), [unreachable])
  hand.advance(5 * 60_000)
  assert.deepEqual(room.notes(), [unreachable], 'the outage was told twice')
  places.set(room.id, 'room', view({ since: hand.now }))
  places.open(room.id)
  assert.ok(await until(() => room.cell(0).state() === 'ok'), room.cell(0).state())
})

test('a slot that stops while its machine is away leaves the outage: the other one’s return is said, and the next outage is told afresh', async (t) => {
  const { hand, places, room, view } = await machineClass(t)
  room.cell(0).type('x = 1')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const count = (words: string) => room.notes().filter((note) => note === words).length
  const unreachable = tr('server.noConnectionToTheMachineTheKernel.71d94f', { elapsed: '0:10' })
  // Both slots of the class on the machine go quiet together: one note.
  const quiet = view({ state: 'unreachable', since: hand.now })
  places.emit({ sessionId: room.id, role: 'room', kind: 'unreachable', view: quiet, at: hand.now })
  places.emit({ sessionId: room.id, role: 'own', kind: 'unreachable', view: quiet, at: hand.now })
  hand.advance(NOTE_MS)
  assert.equal(count(unreachable), 1)
  // The personal notebooks' slot is stopped meanwhile (placement.ts says so, and never that it is back); then the class notebooks' machine answers.
  hand.advance(5_000)
  places.emit({ sessionId: room.id, role: 'own', kind: 'stopping', view: view({ state: 'stopping', since: hand.now }), at: hand.now })
  places.emit({ sessionId: room.id, role: 'room', kind: 'back', view: view({ since: hand.now }), at: hand.now })
  assert.equal(count(tr('server.theConnectionToTheMachineCameBack.d517ba', { seconds: 15 })), 1, room.notes().join('\n'))

  // Another outage, and this time the slot itself is stopped in it: its record goes with it.
  hand.advance(60_000)
  places.emit({ sessionId: room.id, role: 'room', kind: 'unreachable', view: view({ state: 'unreachable', since: hand.now }), at: hand.now })
  hand.advance(NOTE_MS)
  assert.equal(count(unreachable), 2)
  places.emit({ sessionId: room.id, role: 'room', kind: 'stopped', view: { where: 'home' }, at: hand.now })
  // An hour later the class's next placement on that machine goes quiet for twenty seconds: told, and back after its own twenty.
  hand.advance(60 * 60_000)
  places.emit({ sessionId: room.id, role: 'room', kind: 'unreachable', view: view({ gen: 2, state: 'unreachable', since: hand.now }), at: hand.now })
  hand.advance(NOTE_MS)
  assert.equal(count(unreachable), 3, 'the next outage was never said')
  hand.advance(10_000)
  places.emit({ sessionId: room.id, role: 'room', kind: 'back', view: view({ gen: 2, since: hand.now }), at: hand.now })
  assert.equal(count(tr('server.theConnectionToTheMachineCameBack.d517ba', { seconds: 20 })), 1, room.notes().join('\n'))
})

test('a gate opened by the machine starting its kernel anew is no return: the return is said once the machine reports it ready', async (t) => {
  const { hand, places, room, view } = await machineClass(t)
  places.set(room.id, 'room', view({ state: 'unreachable', since: hand.now }))
  room.cell(0).type('print("after")')
  room.run(0)
  hand.advance(NOTE_MS)
  const back = (seconds: number) => room.notes().filter((note) => note === tr('server.theConnectionToTheMachineCameBack.d517ba', { seconds }))
  // Its syncs say the container is gone, and it starts it anew at the same gen: placement.ts opens the gates (restarting).
  const anew = view({ state: 'starting', since: hand.now })
  places.set(room.id, 'room', anew)
  places.emit({ sessionId: room.id, role: 'room', kind: 'restarting', view: anew, at: hand.now })
  places.open(room.id)
  await turns()
  assert.deepEqual(back(10), [], 'a machine that never answered was said to be back')
  hand.advance(20_000)
  const ready = view({ since: hand.now })
  places.set(room.id, 'room', ready)
  places.emit({ sessionId: room.id, role: 'room', kind: 'ready', view: ready, at: hand.now })
  assert.equal(back(30).length, 1, room.notes().join('\n'))
  assert.ok(await until(() => room.cell(0).state() === 'ok'), room.cell(0).state())
})

test('a class here never meets the gate: no wait, no question about its placement’s pad', async (t) => {
  const places = fakePlacements()
  kernel.useClassPlacements(places.impl, handClock().clock)
  jupyter.useDefaultEndpointForTest({ url: fake.url, token: 'fake' })
  const room = await seminar()
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  room.cell(0).type('x = 1')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  await kernel.inspectIn(room.id, 'x', 1)
  assert.equal(places.asked.gates, 0)
  assert.equal(places.asked.pads, 0, 'a kernel here asked the placement for a pad')
  // And its notebook's entry says nothing of machines.
  const entry = notebook.kernelsMap(room.doc)?.get(notebook.CELLS_KEY) as Y.Map<unknown>
  assert.ok(!entry.has(notebook.KERNEL_WHERE_FIELD) && !entry.has(notebook.KERNEL_LINK_FIELD))
})

/* --------------------------------------------------------- failover §11.2 */

test('a failover ends the kernel without a DELETE: the running cell’s fate is unknown, the queue goes with one note, and the next run detaches', async (t) => {
  const { hand, places, road, room, view } = await machineClass(t, ['print("b")', 'print("c")'])
  const [a, b, c] = [room.cell(0), room.cell(1), room.cell(2)]
  a.type('HOLD a')
  room.run(0, 1, 2)
  assert.ok(await until(() => fake.holding('a') === 1))
  const deletes = http('DELETE', /./)
  // The machine stops answering; a minute later the placement module fails the slot over.
  const quiet = view({ state: 'unreachable', since: hand.now })
  places.set(room.id, 'room', quiet)
  places.emit({ sessionId: room.id, role: 'room', kind: 'unreachable', view: quiet, at: hand.now })
  hand.advance(60_000)
  road.lose({ cut: false })
  places.set(room.id, 'room', { where: 'home' })
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'silence', words: `staff: ${NAME}`, at: hand.now })

  assert.ok(await until(() => a.state() === 'error'), `the running cell is ${a.state()}`)
  assert.equal(a.said(), tr('server.thisCellWasRunningOnTheMachine.8d1959'))
  assert.equal(b.state(), 'idle')
  assert.equal(c.state(), 'idle')
  const failover = tr('server.theMachineHasNotAnsweredSinceThe.ee52e1', { since: await clockTime(quiet.since) })
  const notes = room.notes()
  assert.equal(notes.filter((note) => note === failover).length, 1, notes.join('\n'))
  assert.equal(notes.filter((note) => note === tr('server.theQueueWasClearedItsCellsCounted.c77303')).length, 1)
  // Neither a crash's words nor its count: nothing in the room broke.
  assert.ok(!notes.some((note) => note.startsWith(tr('server.theKernelStoppedDuringExecutionQueuedCells.74ec64'))))
  assert.equal(room.entry().status, 'off')
  assert.equal(room.entry().where, null)
  assert.ok(!names(room))
  assert.equal(http('DELETE', /./), deletes, 'a DELETE went to the lost machine’s port')

  // The next run lets go of the ended kernel and starts one where the class computes now: here.
  fake.release('a')
  jupyter.useDefaultEndpointForTest({ url: fake.url, token: 'fake' })
  b.type('print("again")')
  room.run(1)
  assert.ok(await until(() => b.state() === 'ok'), `the next run is ${b.state()}`)
  assert.equal(b.said(), 'again\n')
  assert.equal(http('DELETE', /./), deletes, 'the ended kernel was disposed of instead of let go')
  assert.equal(room.entry().where, null)
})

test('a cell on its way to a machine that is then lost reads that it is lost, and is not run again somewhere else', async (t) => {
  const { hand, places, road, room } = await machineClass(t)
  room.cell(0).type('x = 1')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  // The road closes before the placement module notices: the cell passes the gate and waits for the road.
  road.down()
  const cell = room.cell(0)
  cell.type('print("once")')
  room.run(0)
  assert.ok(await until(() => cell.state() === 'running' && road.waiting > 0))
  const sessions = http('POST', /^\/api\/sessions$/)
  road.lose()
  places.set(room.id, 'room', { where: 'home' })
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'silence', at: hand.now })
  assert.ok(await until(() => cell.state() === 'error'), `the cell is ${cell.state()}`)
  assert.equal(cell.said(), tr('server.thisCellWasRunningOnTheMachine.8d1959'))
  await turns()
  assert.equal(http('POST', /^\/api\/sessions$/), sessions, 'the cell was run again on a kernel started behind the room’s back')
  assert.ok(!room.notes().includes(tr('server.theKernelHadStoppedStartingAFresh.65e2e2')))
})

test('a failover told by the news and then by the gate is said once, in the order the placement module tells it', async (t) => {
  const { hand, places, room, view } = await machineClass(t, ['print("b")'])
  const quiet = view({ state: 'unreachable', since: hand.now })
  places.set(room.id, 'room', quiet)
  room.run(0)
  room.run(1)
  assert.equal(places.gates.length, 1)
  hand.advance(60_000)
  places.set(room.id, 'room', { where: 'home' })
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'silence', at: hand.now })
  assert.equal(places.lose(room.id), 1)
  assert.ok(await until(() => room.cell(0).state() === 'idle' && room.cell(1).state() === 'idle'))
  await turns()
  const failover = tr('server.theMachineHasNotAnsweredSinceThe.ee52e1', { since: await clockTime(quiet.since) })
  const notes = room.notes()
  assert.equal(notes.filter((note) => note === failover).length, 1, notes.join('\n'))
  assert.equal(notes.filter((note) => note === tr('server.theQueueWasClearedItsCellsCounted.c77303')).length, 1)
})

test('a failover heard first at the gate, and then in the news, drops the queue once', async (t) => {
  const { hand, places, room, view } = await machineClass(t, ['print("b")'])
  const quiet = view({ state: 'unreachable', since: hand.now })
  places.set(room.id, 'room', quiet)
  room.run(0)
  room.run(1)
  assert.equal(places.gates.length, 1)
  hand.advance(60_000)
  assert.equal(places.lose(room.id), 1)
  assert.ok(await until(() => room.cell(0).state() === 'idle' && room.cell(1).state() === 'idle'))
  // The placement module's event after it changes nothing more.
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'silence', at: hand.now })
  await turns()
  const failover = tr('server.theMachineHasNotAnsweredSinceThe.ee52e1', { since: await clockTime(quiet.since) })
  const notes = room.notes()
  assert.equal(notes.filter((note) => note === failover).length, 1, notes.join('\n'))
  assert.equal(notes.filter((note) => note === tr('server.theQueueWasClearedItsCellsCounted.c77303')).length, 1)
  assert.equal(room.entry().status, 'off', 'a notebook that never had a kernel was called dead')
})

test('an owner’s action reads as the owner’s words, without the machine’s name; staff read it named', async (t) => {
  const { hand, places, road, room } = await machineClass(t)
  room.cell(0).type('x = 5')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const teacher = socket()
  control.handleControlSocket(teacher.ws, room.id, host(room.id))
  t.after(() => control.closeControlRoom(room.id))
  road.lose({ cut: false })
  places.set(room.id, 'room', { where: 'home' })
  const named = `${tr('server.theOwnerDisconnectedMachine.1a3061', { machine: NAME })} ${tr('server.theKernelWillStartAgainTheVariables.a76610')}`
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'revoked', words: named, at: hand.now })
  const words = `${tr('server.theOwnerDisconnectedTheMachine.0660fa')} ${tr('server.theKernelWillStartAgainTheVariables.a76610')}`
  assert.equal(room.notes().filter((note) => note === words).length, 1)
  assert.ok(!room.notes().some((note) => note.startsWith(tr('server.theKernelStoppedRestartItToRun.911803'))), 'a failover read as a crash')
  // An idle kernel ended so is «не запущено», not «ядро остановлено»: the next Run brings one up.
  assert.equal(room.entry().status, 'off')
  assert.ok(!names(room))
  const told = teacher.heard.flatMap((message) => (message.t === 'kernel:machine' && message.note ? [message.note] : []))
  assert.deepEqual(told, [named])
})

const QUEUE_DROPPED = 'server.theQueueWasClearedItsCellsCounted.c77303'

test('a start its machine is lost under is that failover: the room never reads the machine’s name, the queue goes with one note, the chip is «не запущено»', async (t) => {
  const { hand, places, room, view } = await machineClass(t, ['print("b")'])
  const teacher = socket()
  control.handleControlSocket(teacher.ws, room.id, host(room.id))
  t.after(() => control.closeControlRoom(room.id))
  places.set(room.id, 'room', view({ state: 'starting' }))
  // The start waits for its machine's ready report (placement.ts · whenReady).
  let reject: (err: unknown) => void = () => {}
  const connect = t.mock.method(jupyter.JupyterKernel, 'connect', () => new Promise<never>((_, no) => (reject = no)))
  room.cell(0).type('print(1)')
  room.run(0, 1)
  assert.ok(await until(() => connect.mock.callCount() === 1 && room.entry().status === 'starting'), room.entry().status)
  // The owner revokes the machine: the start is rejected with words that name it, before any news of the loss.
  const named = `${tr('server.theOwnerDisconnectedMachine.1a3061', { machine: NAME })} ${tr('server.theKernelWillStartAgainTheVariables.a76610')}`
  places.set(room.id, 'room', { where: 'home' })
  reject(new PlacementLost(named, 'revoked'))
  assert.ok(await until(() => room.entry().status === 'off'), room.entry().status)
  // The news after it changes nothing more.
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'revoked', words: named, at: hand.now })
  await turns()

  const words = `${tr('server.theOwnerDisconnectedTheMachine.0660fa')} ${tr('server.theKernelWillStartAgainTheVariables.a76610')}`
  const notes = room.notes()
  assert.equal(notes.filter((note) => note === words).length, 1, notes.join('\n'))
  assert.equal(notes.filter((note) => note === tr(QUEUE_DROPPED)).length, 1)
  assert.deepEqual([room.cell(0).state(), room.cell(1).state()], ['idle', 'idle'])
  assert.equal(room.cell(0).said(), '', 'the start’s own words went into the cell')
  assert.ok(!names(room), 'the room’s document named the machine')
  assert.equal(room.entry().status, 'off')
  const toStaff = teacher.heard.flatMap((message) => (message.t === 'kernel:machine' && message.note ? [message.note] : []))
  assert.ok(toStaff.includes(named), JSON.stringify(toStaff))
})

test('a start on a machine that fails in words naming the machine reads unnamed in the room; staff hear the words', async (t) => {
  const { places, room, view } = await machineClass(t)
  const teacher = socket()
  control.handleControlSocket(teacher.ws, room.id, host(room.id))
  t.after(() => control.closeControlRoom(room.id))
  places.set(room.id, 'room', view({ state: 'starting' }))
  // As placement.ts says a start that ran out of time (whenReady).
  const named = `The kernel did not start on machine ${NAME} within 180 s`
  t.mock.method(jupyter.JupyterKernel, 'connect', async () => {
    throw new Error(named)
  })
  room.cell(0).type('print(1)')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'error'), room.cell(0).state())
  const unnamed = tr('server.theKernelDidNotStartOnThe.8ad0fb')
  assert.deepEqual(room.notes(), [unnamed])
  assert.equal(room.cell(0).said(), unnamed)
  assert.ok(!names(room), 'the room’s document named the machine')
  const toStaff = teacher.heard.flatMap((message) => (message.t === 'kernel:machine' && message.note ? [message.note] : []))
  assert.ok(toStaff.includes(named), JSON.stringify(toStaff))
})

test('a failover while the kernel still comes up on the road is the failover: one note, the queue dropped with its line, nothing of the start’s own error', async (t) => {
  const { hand, places, road, room, view } = await machineClass(t, ['print("b")'])
  // The machine answered when the run passed the gate; the road closes while the kernel comes up.
  road.down()
  room.cell(0).type('print(1)')
  room.run(0, 1)
  assert.ok(await until(() => room.entry().status === 'starting' && road.waiting > 0), `${room.entry().status} ${road.waiting}`)
  const quiet = view({ state: 'unreachable', since: hand.now })
  places.set(room.id, 'room', quiet)
  places.emit({ sessionId: room.id, role: 'room', kind: 'unreachable', view: quiet, at: hand.now })
  hand.advance(60_000)
  // placement.ts · failoverRow: the news, and the link answering lost.
  places.set(room.id, 'room', { where: 'home' })
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'silence', at: hand.now })
  road.lose()
  assert.ok(await until(() => room.entry().status === 'off'), room.entry().status)
  await turns()

  const failover = tr('server.theMachineHasNotAnsweredSinceThe.ee52e1', { since: await clockTime(quiet.since) })
  const notes = room.notes()
  assert.equal(notes.filter((note) => note === failover).length, 1, notes.join('\n'))
  assert.equal(notes.filter((note) => note === tr(QUEUE_DROPPED)).length, 1)
  assert.ok(!notes.includes(tr('server.lostTheConnectionToThePythonKernel.c46ec2')), 'the start’s own error went into the room')
  assert.deepEqual([room.cell(0).state(), room.cell(1).state()], ['idle', 'idle'])
  assert.equal(room.cell(0).said(), '')
  assert.ok(!names(room))
})

test('a kernel already dead when its machine is lost is «не запущено» after the failover, said once', async (t) => {
  const { hand, places, room } = await machineClass(t)
  room.cell(0).type('HOLD gone')
  room.run(0)
  assert.ok(await until(() => fake.holding('gone') === 1))
  // Its process is gone on the machine (Jupyter no longer knows it): the room has heard of that death already.
  fake.kernels.get(fake.kernelAt(jupyter.jupyterSessionPath(room.id, notebook.CELLS_KEY))!).alive = false
  assert.ok(await until(() => room.entry().status === 'dead'), room.entry().status)
  fake.release('gone')
  places.set(room.id, 'room', { where: 'home' })
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'revoked', at: hand.now })
  const words = `${tr('server.theOwnerDisconnectedTheMachine.0660fa')} ${tr('server.theKernelWillStartAgainTheVariables.a76610')}`
  assert.equal(room.notes().filter((note) => note === words).length, 1)
  // The next Run brings a kernel up wherever the class computes now: nothing in the room is broken.
  assert.equal(room.entry().status, 'off')
})

test('a machine the personal notebooks alone compute on is told as theirs: the class notebook neither waits nor loses anything', async (t) => {
  const { hand, places, room, view } = await machineClass(t)
  // D31: the class notebook here, the personal notebooks on the machine.
  places.set(room.id, 'room', { where: 'home' })
  places.set(room.id, 'own', view())
  const book = notebook.addBook(room.doc, 'Аким.ipynb')
  db.setRules(room.id, { ...db.storedRules(room.id), books: { [book.root]: { access: 'owner', owner: 'p_akim', ownerName: 'Аким' } } })
  await kernel.ensureKernel(room.id, book.root)
  assert.equal(notebook.bookKernel(room.doc, book.root).where, 'machine')
  const quiet = view({ state: 'unreachable', since: hand.now })
  places.set(room.id, 'own', quiet)
  places.emit({ sessionId: room.id, role: 'own', kind: 'unreachable', view: quiet, at: hand.now })
  hand.advance(NOTE_MS)
  assert.deepEqual(room.notes(), [tr('server.noConnectionToThePersonalNotebooksMachine.d2ae75', { elapsed: '0:10' })])
  // The class notebook runs on, here.
  room.cell(0).type('print("here")')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'), room.cell(0).state())
  hand.advance(50_000)
  places.set(room.id, 'own', { where: 'home' })
  places.emit({ sessionId: room.id, role: 'own', kind: 'lost', view: { where: 'home' }, cause: 'silence', at: hand.now })
  const since = await clockTime(quiet.since)
  assert.deepEqual(room.notes().slice(1), [tr('server.thePersonalNotebooksMachineHasNotAnswered.69b338', { since })])
  assert.equal(notebook.bookKernel(room.doc, book.root).status, 'off')
  assert.equal(room.entry().status, 'idle', 'the class notebook’s kernel went with the personal ones')
  // A machine only the council's pool is on is the console's news: nothing in the room's log.
  const pool = view({ runnerId: 'r2', name: 'lab-2', state: 'unreachable', since: hand.now })
  places.emit({ sessionId: room.id, role: 'council', kind: 'unreachable', view: pool, at: hand.now })
  hand.advance(NOTE_MS)
  assert.equal(room.notes().length, 2, room.notes().join('\n'))
})

test('a failover that lands on a restart in flight is the failover, not a failed restart', async (t) => {
  const { hand, places, road, room } = await machineClass(t)
  room.cell(0).type('x = 1')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  fake.restarts = 'unanswered'
  const posted = http('POST', /\/restart$/)
  const restarting = kernel.restartSession(room.id, 'Teacher')
  assert.ok(await until(() => http('POST', /\/restart$/) > posted), 'the restart did not reach the machine')
  // «Перенести на сервер» on the machine that answers: its road closes, and the slot is lost.
  places.set(room.id, 'room', { where: 'home' })
  road.lose()
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'moved', at: hand.now })
  await restarting
  const notes = room.notes()
  assert.ok(!notes.includes(tr('server.theKernelDidNotComeBackAfter.cadaf5')), notes.join('\n'))
  assert.equal(notes.filter((note) => note === tr('server.theKernelWillStartAgainTheVariables.a76610')).length, 1)
  assert.equal(room.entry().status, 'off')
})

test('a council attempt cut off by a failover reads that it was lost on the machine, not that the kernel died', async (t) => {
  const { hand, places, road, room } = await machineClass(t)
  room.cell(0).type('x = 1')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  let last: CouncilRun | null = null
  kernel.requestCouncilRun(
    room.id,
    { cellId: room.cell(0).id, participantId: 'p_student', source: 'HOLD attempt', by: 'host', limitSec: null, onChange: (run) => (last = run) },
    'Teacher',
    'p_teacher',
  )
  assert.ok(await until(() => fake.holding('attempt') === 1))
  road.lose({ cut: false })
  places.set(room.id, 'room', { where: 'home' })
  places.emit({ sessionId: room.id, role: 'room', kind: 'lost', view: { where: 'home' }, cause: 'revoked', at: hand.now })
  assert.ok(await until(() => last?.state === 'error'), JSON.stringify(last))
  const errors = (last as CouncilRun | null)?.outputs.flatMap((output) => (output.kind === 'error' ? [output] : [])) ?? []
  assert.deepEqual(
    errors.map((output) => [output.ename, output.evalue]),
    [['', tr('server.thisCellWasRunningOnTheMachine.8d1959')]],
  )
  fake.release('attempt')
})

/* ---------------------------------------------- refusals while unreachable §5.4 */

test('restart and interrupt are refused while the machine does not answer, and nothing is touched', async (t) => {
  const { places, road, room } = await machineClass(t, ['print("b")'])
  db.setRules(room.id, { ...db.storedRules(room.id), restart: 'room' })
  const [a, b] = [room.cell(0), room.cell(1)]
  a.type('HOLD pressed')
  room.run(0)
  room.run(1)
  assert.ok(await until(() => fake.holding('pressed') === 1))
  road.down()
  const restarts = http('POST', /\/restart$/)
  const interrupts = http('POST', /\/interrupt$/)

  const refused = await kernel.restartSession(room.id, 'Teacher').then(
    () => null,
    (err: unknown) => err,
  )
  assert.ok(refused instanceof kernel.MachineUnreachable, String(refused))
  assert.equal(refused.message, tr('server.noConnectionToTheMachineARestart.f05d30'))
  assert.equal(refused.named, tr('server.noConnectionToMachineARestartWould.406486', { machine: NAME }))
  await assert.rejects(kernel.interruptSession(room.id, a.id), {
    message: tr('server.noConnectionToTheMachineTheCell.b76132'),
  })
  // Through the socket: staff read which machine; a student reads that a machine does not answer.
  const teacher = socket()
  const pupil = socket()
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'restart' })
  control.dispatch(pupil.ws, room.id, student(room.id), { t: 'restart' })
  assert.ok(await until(() => errorsOf(teacher.heard).length > 0 && errorsOf(pupil.heard).length > 0))
  assert.deepEqual(errorsOf(teacher.heard), [refused.named])
  assert.deepEqual(errorsOf(pupil.heard), [refused.message])

  assert.equal(a.state(), 'running')
  assert.equal(b.state(), 'queued', 'a refused press dropped the queue')
  assert.equal(room.entry().status, 'busy')
  assert.equal(http('POST', /\/restart$/), restarts)
  assert.equal(http('POST', /\/interrupt$/), interrupts)
  assert.equal(places.gates.length, 0)

  road.up()
  fake.release('pressed')
  assert.ok(await until(() => a.state() === 'ok' && b.state() === 'ok'))
})

test('no kernel starts for a slot whose machine does not answer: the join’s warm-up and a hover’s wake touch nothing', async (t) => {
  const { hand, places, room, view } = await machineClass(t)
  places.set(room.id, 'room', view({ state: 'unreachable', since: hand.now }))
  const sessions = http('POST', /^\/api\/sessions$/)
  // What the join's warm-up does (routes/sessions.ts): refused in words, before anything.
  await assert.rejects(kernel.ensureKernel(room.id), (err: unknown) => {
    assert.ok(err instanceof kernel.MachineUnreachable, String(err))
    assert.equal(err.message, tr('server.noConnectionToTheMachineTheKernel.67a40e'))
    return true
  })
  assert.deepEqual(await kernel.inspectIn(room.id, 'x', 1, notebook.CELLS_KEY, { mayWake: true }), {
    found: false,
    text: null,
    reason: 'busy',
    unreachable: true,
  })
  await turns()
  assert.equal(room.entry().status, 'off', 'the chip said the kernel was starting')
  assert.equal(http('POST', /^\/api\/sessions$/), sessions, 'a kernel was asked for on the closed road')
  assert.deepEqual(room.notes(), [])
})

test('a road that closes under a restart’s press leaves the kernel as it was: not restarted, and said so', async (t) => {
  const { road, room } = await machineClass(t, ['print(y)'])
  room.cell(0).type('y = 7')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok' && room.entry().status === 'idle'))
  const restarts = http('POST', /\/restart$/)
  // It closes in the very moment between the press's look at the road and the request, which looks again (jupyter.ts · restart).
  const close = () => {
    if (room.entry().status === 'restarting') road.down()
  }
  room.doc.on('afterTransaction', close)
  t.after(() => room.doc.off('afterTransaction', close))
  await kernel.restartSession(room.id, 'Teacher')
  room.doc.off('afterTransaction', close)
  assert.equal(http('POST', /\/restart$/), restarts)
  assert.equal(room.entry().status, 'idle')
  assert.ok(room.notes().includes(tr('server.noConnectionToTheMachineARestart.f05d30')), room.notes().join('\n'))
  assert.ok(!room.notes().includes(tr('server.theKernelDidNotComeBackAfter.cadaf5')))
  // The variables are where they were, once the road is back and the kernel's channel with it.
  const id = fake.kernelAt(jupyter.jupyterSessionPath(room.id, notebook.CELLS_KEY))!
  assert.ok(await until(() => fake.online(id) === 0))
  road.up()
  assert.ok(await until(() => fake.online(id) === 1))
  room.run(1)
  assert.ok(await until(() => room.cell(1).state() === 'ok'), `${room.cell(1).state()}: ${room.cell(1).said()}`)
  assert.equal(room.cell(1).said(), '7\n')
})

/* ------------------------------------------------- a restart unknown §5.4 */

/**
 * Press Restart on a machine's kernel, and let the road eat its answer. The
 * restart itself is handed back in a box: it settles only once the road is
 * back, and an async function returning it bare would wait for it.
 */
async function restartCut(room: Room, road: Awaited<ReturnType<typeof startFakeLink>>): Promise<{ restarting: Promise<void> }> {
  const posted = http('POST', /\/restart$/)
  const restarting = kernel.restartSession(room.id, 'Teacher')
  assert.ok(await until(() => http('POST', /\/restart$/) > posted), 'the restart did not reach the machine')
  road.down()
  const unknown = tr('server.theRestartWasSentButNoAnswer.17cbbc')
  assert.ok(await until(() => room.notes().includes(unknown)), room.notes().join('\n'))
  return { restarting }
}

test('a restart whose answer was lost waits for the machine, sends no cell meanwhile, and is settled as happened by a fresh process', async (t) => {
  const { road, room } = await machineClass(t, ['print(x)'])
  room.cell(0).type('x = 5')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const guards = () => fake.requests.filter((request) => request.code.includes(GUARD_MODULE)).length
  const guarded = guards()
  fake.restarts = 'unanswered'
  const { restarting } = await restartCut(room, road)
  assert.equal(room.entry().status, 'restarting')
  room.run(1)
  await turns()

  assert.ok(!fake.requests.some((request) => request.code === 'print(x)'), 'a cell went to the kernel before the restart was settled')
  assert.equal(room.cell(1).state(), 'queued')

  road.up()
  await restarting
  assert.ok(room.notes().includes(tr('server.theRestartWentThroughTheVariablesWere.96b635')))
  assert.equal(room.cell(0).state(), 'idle', 'the numbers of the old process were left standing')
  assert.ok(guards() > guarded, 'the fresh process was not given the guard')
  // The variables are gone: the fresh process says so.
  assert.ok(await until(() => room.cell(1).state() === 'error'), `the cell is ${room.cell(1).state()}`)
  assert.match(room.cell(1).said(), /x/)
})

test('a restart that never reached the kernel is settled as missed: the variables are still there', async (t) => {
  const { road, room } = await machineClass(t, ['print(x)'])
  room.cell(0).type('x = 41 + 1')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  fake.restarts = 'ignored'
  const { restarting } = await restartCut(room, road)
  road.up()
  await restarting
  assert.ok(room.notes().includes(tr('server.theRestartDidNotGetThroughThe.92177b')))
  assert.ok(!room.notes().includes(tr('server.theRestartWentThroughTheVariablesWere.96b635')))
  assert.equal(room.entry().status, 'idle')
  room.run(1)
  assert.ok(await until(() => room.cell(1).state() === 'ok'))
  assert.equal(room.cell(1).said(), '42\n')
})

/* ----------------------------------------- the run limit's SIGINT §5.8 */

test('a limit’s signal that could not reach the machine goes again once it is back, to the same cell only', async (t) => {
  const { road, room } = await machineClass(t, ['print("dropped")', 'print("b")'])
  kernel.setCouncilLimitTick(250)
  t.after(() => kernel.setCouncilLimitTick(1000))
  db.setRules(room.id, { ...db.storedRules(room.id), cellLimitSec: 1 })
  const [a, dropped, b] = [room.cell(0), room.cell(1), room.cell(2)]
  a.type('HOLD limited')
  room.run(0, 1)
  room.run(2)
  assert.ok(await until(() => fake.holding('limited') === 1))
  // The limit is armed; its second signal, five ticks after the first, now lands only in minutes.
  kernel.setCouncilLimitTick(60_000)
  road.down()
  const interrupts = http('POST', /\/interrupt$/)
  // The limit fires in the cut: its own batch goes at once, its signal waits for the road.
  assert.ok(await until(() => dropped.state() === 'idle'), 'the limit did not fire')
  await turns()
  assert.equal(http('POST', /\/interrupt$/), interrupts, 'a signal was sent into a closed road')
  assert.equal(a.state(), 'running')

  road.up()
  assert.ok(await until(() => a.state() === 'error'), `the limited cell is ${a.state()}`)
  assert.equal(a.said(), tr('server.cell.stoppedByLimit', { p0: durationWords(1) }))
  assert.ok(http('POST', /\/interrupt$/) > interrupts)
  // The cell behind it is someone else's work: it runs, untouched.
  assert.ok(await until(() => b.state() === 'ok'), `the next cell is ${b.state()}`)
  assert.equal(b.said(), 'b\n')
})

test('a limit’s signal owed to a cell that finished in the cut never reaches the next one', async (t) => {
  const { road, room } = await machineClass(t, ['print("dropped")', 'print("b")'])
  kernel.setCouncilLimitTick(250)
  t.after(() => kernel.setCouncilLimitTick(1000))
  db.setRules(room.id, { ...db.storedRules(room.id), cellLimitSec: 1 })
  const [a, dropped, b] = [room.cell(0), room.cell(1), room.cell(2)]
  a.type('HOLD done')
  room.run(0, 1)
  room.run(2)
  assert.ok(await until(() => fake.holding('done') === 1))
  road.down()
  assert.ok(await until(() => dropped.state() === 'idle'), 'the limit did not fire')
  // It ends on the machine while the road is cut; its end waits there for the channel.
  fake.release('done')
  road.up()
  assert.ok(await until(() => b.state() === 'ok'), `the next cell is ${b.state()}`)
  assert.equal(a.state(), 'ok', 'a cell that finished by itself was called stopped')
  assert.equal(b.said(), 'b\n', 'the owed signal stopped the next cell')
})

/** The limit's clock for the next three: a "second" is this long, and the signals follow it (LIMIT_RETRY_TICKS = 5). */
const TICK_MS = 100

/** Past every step a limit takes after its first signal: the second five ticks later, the deaf check five more. */
const pastLimitSteps = () => new Promise((resolve) => setTimeout(resolve, 12 * TICK_MS))

test('a second limit signal waits for the first one stuck in a cut: one SIGINT once the machine is back', async (t) => {
  const { road, room } = await machineClass(t, ['print("dropped")', 'print("b")'])
  kernel.setCouncilLimitTick(TICK_MS)
  t.after(() => kernel.setCouncilLimitTick(1000))
  db.setRules(room.id, { ...db.storedRules(room.id), cellLimitSec: 5 })
  const [a, dropped, b] = [room.cell(0), room.cell(1), room.cell(2)]
  a.type('HOLD stuck')
  room.run(0, 1)
  room.run(2)
  assert.ok(await until(() => fake.holding('stuck') === 1))
  road.down()
  const interrupts = http('POST', /\/interrupt$/)
  // The limit fires in the cut: its batch goes at once, its signal waits for the road.
  assert.ok(await until(() => dropped.state() === 'idle'), 'the limit did not fire')
  // Its second step comes in the cut too, and waits for the first signal to land.
  await pastLimitSteps()
  assert.equal(http('POST', /\/interrupt$/), interrupts)
  road.up()
  // Once the next cell ran, every signal owed to the first one is out (the pump's barrier waits for them).
  assert.ok(await until(() => b.state() === 'ok'), `the next cell is ${b.state()}`)
  assert.equal(a.said(), tr('server.cell.stoppedByLimit', { p0: durationWords(5) }))
  assert.equal(http('POST', /\/interrupt$/) - interrupts, 1, 'the second signal went out behind the first')
  assert.ok(!room.notes().includes(tr('server.kernel.deafToInterrupt')))
})

test('the deaf check waits for a signal stuck in a cut: no «не реагирует» while the machine is away', async (t) => {
  const { road, room } = await machineClass(t)
  kernel.setCouncilLimitTick(TICK_MS)
  t.after(() => kernel.setCouncilLimitTick(1000))
  db.setRules(room.id, { ...db.storedRules(room.id), cellLimitSec: 1 })
  const a = room.cell(0)
  a.type('HOLD deaf')
  // The machine takes both signals and keeps computing: their answers do not come back.
  fake.holdInterrupts = true
  room.run(0)
  assert.ok(await until(() => fake.pendingInterrupts.length === 2), `${fake.pendingInterrupts.length} signals arrived`)
  // Then the road closes under both: the second one's deaf check comes in the cut.
  road.down()
  await pastLimitSteps()
  assert.ok(!room.notes().includes(tr('server.kernel.deafToInterrupt')), 'a kernel out of reach was called deaf')
  fake.holdInterrupts = false
  road.up()
  assert.ok(await until(() => a.state() === 'error'), `the cell is ${a.state()}`)
  await pastLimitSteps()
  assert.ok(!room.notes().includes(tr('server.kernel.deafToInterrupt')))
})

test('a signal owed to a notebook closed in the cut stops waiting for the road', async (t) => {
  const { road, room } = await machineClass(t, ['print("dropped")'])
  kernel.setCouncilLimitTick(TICK_MS)
  t.after(() => kernel.setCouncilLimitTick(1000))
  db.setRules(room.id, { ...db.storedRules(room.id), cellLimitSec: 5 })
  room.cell(0).type('HOLD closed')
  room.run(0, 1)
  assert.ok(await until(() => fake.holding('closed') === 1))
  road.down()
  assert.ok(await until(() => room.cell(1).state() === 'idle'), 'the limit did not fire')
  await kernel.shutdownSession(room.id)
  // The road says nothing for a while (a link's own wait running out): nothing of the closed room waits on it after that.
  road.expire()
  await turns()
  assert.equal(road.waiting, 0, 'a signal for the closed room went on waiting for the road')
})

/* ------------------------------------------------------------ help §5.6 */

test('help waits the road’s pad on a machine, and nothing more here', async (t) => {
  const { hand, places, room } = await machineClass(t)
  places.pad(700)
  room.cell(0).type('x = 5')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok' && room.entry().status === 'idle'))
  const inspect = t.mock.method(jupyter.JupyterKernel.prototype, 'inspect')
  await kernel.inspectIn(room.id, 'x', 1)
  assert.equal(inspect.mock.calls.at(-1)?.arguments[3], 700)

  // The value line waits its 400 ms plus the pad, on the hooks' clock; so do a module's facts and jedi's static help.
  const execute = jupyter.JupyterKernel.prototype.execute
  let quiet = 0
  t.mock.method(jupyter.JupyterKernel.prototype, 'execute', function (this: InstanceType<typeof jupyter.JupyterKernel>, ...args: Parameters<typeof execute>) {
    // The question is never answered: only its wait decides.
    if (args[2]?.quiet) {
      quiet++
      return new Promise(() => {})
    }
    return execute.apply(this, args)
  })
  /** A help question that is never answered, against its wait on the hooks' clock: not over at `wait`, over at `wait` + the pad. */
  const waitsOutPad = async <T,>(ask: () => Promise<T>, wait: number, what: string): Promise<T> => {
    const before = quiet
    let answered = false
    const asked = ask().then((value) => {
      answered = true
      return value
    })
    // Its wait begins when the silent question goes to the kernel, after whatever it asked first.
    assert.ok(await until(() => quiet > before), `${what} asked the kernel nothing`)
    hand.advance(wait)
    await turns()
    assert.equal(answered, false, `${what} gave up without the road’s pad`)
    hand.advance(700)
    return asked
  }
  assert.equal(await waitsOutPad(() => kernel.briefIn(room.id, 'x'), 400, 'the value line'), null)
  // A module's facts after the live help (MODULE_FACTS_WAIT_MS 500), and jedi's static help (INSPECT_BUDGET_SEC + 1 s).
  const facts = await waitsOutPad(() => kernel.inspectIn(room.id, 'MODULE', 6), 500, 'the module’s facts')
  assert.equal(facts.found, true)
  const statics = await waitsOutPad(() => kernel.inspectIn(room.id, 'NOTFOUND', 8), 3500, 'the static help')
  assert.equal(statics.reason, 'thinking')

  // Here: the same questions, no pad, and the placement module not even asked.
  t.mock.restoreAll()
  jupyter.useDefaultEndpointForTest({ url: fake.url, token: 'fake' })
  const here = await seminar()
  t.after(() => kernel.shutdownSession(here.id).catch(() => {}))
  here.cell(0).type('y = 1')
  here.run(0)
  assert.ok(await until(() => here.cell(0).state() === 'ok' && here.entry().status === 'idle'))
  const pads = places.asked.pads
  const inspectHere = t.mock.method(jupyter.JupyterKernel.prototype, 'inspect')
  await kernel.inspectIn(here.id, 'y', 1)
  assert.equal(inspectHere.mock.calls.at(-1)?.arguments[3], 0)
  assert.equal(places.asked.pads, pads)
})

test('help is not asked of a machine that does not answer: the hover says so', async (t) => {
  const { road, room } = await machineClass(t)
  room.cell(0).type('x = 5')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok' && room.entry().status === 'idle'))
  road.down()
  const asked = fake.calls.filter((call) => call.kind === 'shell' && call.msgType === 'inspect_request').length
  assert.deepEqual(await kernel.inspectIn(room.id, 'x', 1, notebook.CELLS_KEY, { mayWake: true }), {
    found: false,
    text: null,
    reason: 'busy',
    unreachable: true,
  })
  assert.equal(await kernel.briefIn(room.id, 'x'), null)
  // Over the socket: a tab that knows the flag says the machine does not answer.
  const teacher = socket()
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'inspect', id: 7, code: 'x', cursor: 1 } as ControlClientMessage)
  assert.ok(await until(() => teacher.heard.some((message) => message.t === 'inspect:reply')))
  const reply = teacher.heard.find((message) => message.t === 'inspect:reply')
  assert.deepEqual(reply, { t: 'inspect:reply', id: 7, found: false, reason: 'busy', unreachable: true })
  assert.equal(fake.calls.filter((call) => call.kind === 'shell' && call.msgType === 'inspect_request').length, asked)
  road.up()
})

/* -------------------------------------------------- warm start §6.8 */

test('the first participant has the placement module warm the personal notebooks’ slot on a machine; opening a room starts nothing here', async (t) => {
  const { hand, places, room } = await machineClass(t)
  const [over, plain] = [await seminar(), await seminar()]
  db.setFinished(over.id, Date.now())
  t.after(async () => {
    for (const one of [over, plain]) {
      control.closeControlRoom(one.id)
      await kernel.shutdownSession(one.id).catch(() => {})
    }
    control.closeControlRoom(room.id)
  })
  const warmed: string[] = []
  const asked: string[] = []
  // Every class here wants its personal notebooks on machines; the module answers for what it can promise.
  const machines = {
    ...places.impl,
    machinePlaced: (sessionId: string, role: string) => {
      asked.push(`${sessionId}:${role}`)
      return role === 'own'
    },
  }
  kernel.useClassPlacements({ ...machines, warmSlot: (sessionId, role) => warmed.push(`${sessionId}:${role}`) }, hand.clock)
  control.handleControlSocket(socket().ws, room.id, student(room.id))
  assert.ok(await until(() => warmed.length === 1))
  assert.deepEqual(warmed, [`${room.id}:own`])
  // A second person warms nothing more, a finished class nothing at all.
  control.handleControlSocket(socket().ws, room.id, student(room.id))
  control.handleControlSocket(socket().ws, over.id, student(over.id))
  await turns()
  assert.deepEqual(warmed, [`${room.id}:own`])
  // Opening a room brought no kernel up: the class notebook's comes with the join's own warm-up, wherever it computes.
  assert.equal(fake.kernelAt(jupyter.jupyterSessionPath(room.id, notebook.CELLS_KEY)), null)

  // A module that cannot promise a machine (no warmSlot) is not even asked: nothing may fall back to this server for an open room.
  kernel.useClassPlacements(machines, hand.clock)
  asked.length = 0
  control.handleControlSocket(socket().ws, plain.id, student(plain.id))
  await turns()
  assert.deepEqual(asked, [])
  assert.equal(fake.kernelAt(jupyter.jupyterSessionPath(plain.id, notebook.CELLS_KEY)), null)
  assert.equal(plain.entry().status, 'off')
})

test('an empty class on a machine goes after the room setting, as one here does', async (t) => {
  const { room } = await machineClass(t)
  room.cell(0).type('x = 1')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const deletes = http('DELETE', /^\/api\/sessions\//)
  const now = Date.now()
  await kernel.sweepIdleKernels(now)
  assert.ok(kernel.kernelClasses().includes(room.id), 'the first look took the class down')
  await kernel.sweepIdleKernels(now + 121 * 60_000)
  assert.ok(!kernel.kernelClasses().includes(room.id), 'the idle class kept its kernel on the machine')
  assert.ok(http('DELETE', /^\/api\/sessions\//) > deletes, 'its kernel was not ended')
})

/* ---------------------------------------------- what the room and staff see §13.1 */

test('the kernels map says where and how the machine answers; staff hear its name over the control socket, students never', async (t) => {
  const { hand, places, road, room, view } = await machineClass(t)
  room.cell(0).type('x = 1')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  assert.deepEqual(
    { where: room.entry().where, link: room.entry().link, linkSince: room.entry().linkSince },
    { where: 'machine', link: 'ok', linkSince: road.link.since },
  )
  const teacher = socket()
  const pupil = socket()
  control.handleControlSocket(teacher.ws, room.id, host(room.id))
  control.handleControlSocket(pupil.ws, room.id, student(room.id))
  t.after(() => control.closeControlRoom(room.id))
  const frames = (heard: ControlServerMessage[]) => heard.filter((message) => message.t === 'kernel:machine')
  assert.deepEqual(frames(teacher.heard), [
    { t: 'kernel:machine', role: 'room', machine: { name: NAME, state: 'ready', since: view().since, rttMs: road.link.rttMs, failover: 'auto', failoverAt: null } },
  ])
  assert.deepEqual(frames(pupil.heard), [])

  const quiet = view({ state: 'unreachable', since: hand.now, failoverAt: hand.now + 60_000 })
  places.set(room.id, 'room', quiet)
  places.emit({ sessionId: room.id, role: 'room', kind: 'unreachable', view: quiet, at: hand.now })
  assert.deepEqual([room.entry().link, room.entry().linkSince], ['lost', quiet.since])
  hand.advance(NOTE_MS)
  const named = tr('server.machineHasNotAnsweredSinceWaitingUntil.1d012e', {
    machine: NAME,
    since: await clockTime(quiet.since),
    until: await clockTime(quiet.failoverAt!),
  })
  assert.ok(frames(teacher.heard).some((message) => message.t === 'kernel:machine' && message.note === named && message.machine?.state === 'unreachable'))
  assert.deepEqual(frames(pupil.heard), [])
  assert.ok(!names(room), 'the room’s document named the machine')

  // «Ждать машину» saved meanwhile (the seminar PATCH): staff read the class's new plan at once, with no news of the machine's.
  const from = teacher.heard.length
  places.set(room.id, 'room', { ...quiet, failover: 'wait', failoverAt: null })
  kernel.kernelMachinesChanged(room.id)
  const waiting = tr('server.machineHasNotAnsweredSinceWaitingFor.5afc55', { machine: NAME, since: await clockTime(quiet.since) })
  const again = frames(teacher.heard.slice(from))
  assert.ok(again.some((message) => message.t === 'kernel:machine' && message.note === waiting), JSON.stringify(again))
  assert.ok(again.every((message) => message.t !== 'kernel:machine' || message.machine?.failover === 'wait'), 'every frame says the class waits now')
  assert.deepEqual(frames(pupil.heard), [])
})

test('a machine’s link as the last process saw it is nobody’s news after a restart: «нет связи» and «переносим» go, «на машине» stays', () => {
  const doc = new Y.Doc()
  const roots = { 'nb:lost': 'lost', 'nb:moving': 'moving', 'nb:ok': 'ok' }
  doc.transact(() => {
    for (const [root, link] of Object.entries(roots)) {
      const entry = notebook.kernelEntry(doc, root)
      entry.set(notebook.KERNEL_STATUS_FIELD, 'idle')
      entry.set(notebook.KERNEL_WHERE_FIELD, 'machine')
      entry.set(notebook.KERNEL_LINK_FIELD, link)
      entry.set(notebook.KERNEL_LINK_SINCE_FIELD, 1)
    }
  })
  notebook.clearStaleWork(doc)
  assert.deepEqual(
    Object.keys(roots).map((root) => {
      const entry = notebook.bookKernel(doc, root)
      return [entry.where, entry.link]
    }),
    [['machine', null], ['machine', null], ['machine', 'ok']],
  )
})

test('kernel:move is staff’s: the slot moves, and every refusal is said in words to whoever pressed', async (t) => {
  const { places, room } = await machineClass(t)
  const teacher = socket()
  const pupil = socket()
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'kernel:move' })
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'kernel:move', root: notebook.CELLS_KEY })
  assert.ok(await until(() => places.moved.length === 2))
  assert.deepEqual(
    places.moved.map(({ role }) => role),
    [null, 'room'],
  )
  control.dispatch(pupil.ws, room.id, student(room.id), { t: 'kernel:move' })
  assert.deepEqual(errorsOf(pupil.heard), [tr('server.onlyTheTeacherCanMoveTheKernel.9a2c10')])
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'kernel:move', root: 'nb:missing' })
  assert.equal(errorsOf(teacher.heard).length, 1, 'a notebook not in the room was moved')
  places.refuse('Nothing of this class runs on a machine now')
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'kernel:move' })
  assert.ok(await until(() => errorsOf(teacher.heard).length === 2))
  assert.equal(errorsOf(teacher.heard)[1], 'Nothing of this class runs on a machine now')
  // With no placement module at all, every slot is here: nothing to move.
  kernel.useClassPlacements(null)
  control.dispatch(teacher.ws, room.id, host(room.id), { t: 'kernel:move' })
  assert.ok(await until(() => errorsOf(teacher.heard).length === 3))
  assert.equal(errorsOf(teacher.heard)[2], tr('server.thisClassSKernelsRunOnThis.d5eaa3'))
  assert.equal(places.moved.length, 2)
})

/* ----------------------------------------------- personal notebooks §10 */

test('the personal kernel ceiling counts the kernels on a machine', async (t) => {
  const { room } = await machineClass(t)
  const first = notebook.addBook(room.doc, 'Аким.ipynb')
  const second = notebook.addBook(room.doc, 'Борис.ipynb')
  db.setRules(room.id, {
    ...db.storedRules(room.id),
    books: {
      [first.root]: { access: 'owner', owner: 'p_akim', ownerName: 'Аким' },
      [second.root]: { access: 'owner', owner: 'p_boris', ownerName: 'Борис' },
    },
  })
  const previous = process.env.KERNEL_OWN_MAX
  process.env.KERNEL_OWN_MAX = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.KERNEL_OWN_MAX
    else process.env.KERNEL_OWN_MAX = previous
  })
  await kernel.ensureKernel(room.id, first.root)
  assert.equal(notebook.bookKernel(room.doc, first.root).where, 'machine')
  await assert.rejects(kernel.ensureKernel(room.id, second.root), { message: tr('server.kernel.ownFull', { p0: 1 }) })
})

/* ------------------------------------------- a process replaced in a cut §5.5 */

test('a kernel killed for memory while the road was cut is the unexpected restart it is: queue dropped, its words, the guard again', async (t) => {
  const { road, room } = await machineClass(t, ['print("b")'])
  room.cell(0).type('x = 5')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  const id = fake.kernelAt(jupyter.jupyterSessionPath(room.id, notebook.CELLS_KEY))!
  const guards = () => fake.requests.filter((request) => request.code.includes(GUARD_MODULE)).length
  const guarded = guards()
  room.cell(0).type('HOLD big\nOOM')
  room.run(0)
  room.run(1)
  assert.ok(await until(() => fake.holding('big') === 1))
  road.down()
  assert.ok(await until(() => fake.online(id) === 0))
  const incarnation = fake.kernels.get(id).process
  fake.release('big')
  assert.ok(await until(() => fake.kernels.get(id).process === incarnation + 1))
  road.up()
  assert.ok(await until(() => room.cell(0).state() === 'error'), `the cell is ${room.cell(0).state()}`)
  assert.equal(room.cell(1).state(), 'idle', 'the queue outlived the variables it counted on')
  // The existing unexpected branch, with what was running at the time after its sentence.
  const restarted = tr('server.theKernelRestartedUnexpectedlyVariablesWereReset.f87dd9')
  assert.ok(room.notes().some((note) => note.startsWith(restarted)), room.notes().join('\n'))
  room.cell(1).type('print("after")')
  room.run(1)
  assert.ok(await until(() => room.cell(1).state() === 'ok'))
  assert.ok(guards() > guarded, 'the replaced process ran a cell without the guard')
})

/* ------------------------------------------------- wiring the hooks (2b) */

test('the whole class’s stop pauses its council pool’s starts with the rest; stopping the personal notebooks pauses theirs alone', async (t) => {
  const { kernelStartsPaused } = await import('../server/src/kernel/retirement.js')
  jupyter.useDefaultEndpointForTest({ url: fake.url, token: 'fake' })
  const room = await seminar()
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  const own = kernel.stopKernelsByOwner(room.id, 'own', { force: true })
  // The same tick the gate went up in.
  assert.deepEqual([kernelStartsPaused(room.id, 'own'), kernelStartsPaused(room.id, 'council')], [true, false])
  await own
  const whole = kernel.stopKernelsByOwner(room.id, 'class', { force: true })
  assert.deepEqual(
    (['room', 'own', 'council'] as const).map((role) => kernelStartsPaused(room.id, role)),
    [true, true, true],
    'a pool started in the gap would be removed under it (pool.ts · dropRoomKernel drops the council slot too)',
  )
  await whole
  assert.equal(kernelStartsPaused(room.id, 'council'), false)
})

test('a dead process’s scopes, abandoned for a home that crashes: no DELETE, the computing cell left as it was, and the next run attaches by its path with the variables', async (t) => {
  jupyter.useDefaultEndpointForTest({ url: fake.url, token: 'fake' })
  const room = await seminar(['HOLD crash', 'print(x)'])
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  room.cell(0).type('x = 5')
  room.run(0)
  assert.ok(await until(() => room.cell(0).state() === 'ok'))
  room.run(1)
  assert.ok(await until(() => fake.holding('crash') === 1))
  const deletes = http('DELETE', /./)
  const before = { state: room.cell(1).state(), doc: JSON.stringify(room.doc.toJSON()) }
  kernel.abandonKernelsForTest()
  await turns()
  assert.equal(http('DELETE', /./), deletes, 'nothing is deleted: the kernel is the next life’s')
  assert.equal(room.cell(1).state(), before.state, 'the cell is left computing, as a crash leaves it')
  assert.equal(JSON.stringify(room.doc.toJSON()), before.doc, 'nothing is written to the document')
  // The next life: the same kernel by the session's path, its orphaned work let go, its variables kept.
  room.run(2)
  assert.ok(await until(() => room.cell(2).said() === '5\n'), `the run said ${JSON.stringify(room.cell(2).said())}`)
  assert.ok(room.notes().includes(tr('server.reconnectedToTheExistingKernelTheRunning.a20941')))
  assert.equal(http('DELETE', /./), deletes)
})

test('the hooks follow the placement module from the moment it loads, unless a suite handed them others first', async () => {
  const { offerPlacementHooks } = await import('../server/src/kernel/remote/placement-store.js')
  const placement = await import('../server/src/kernel/remote/placement.js')
  const places = fakePlacements()
  kernel.useClassPlacements(places.impl, handClock().clock)
  const room = await seminar()
  places.set(room.id, 'room', { where: 'machine', runnerId: 'r1', name: NAME, gen: 1, state: 'ready', link: null, since: Date.now(), failover: 'auto', failoverAt: null })
  // The module handing itself over again (a second load): the suite's choice stands.
  offerPlacementHooks({
    placements: { ...placement, PlacementLost: placement.PlacementLost },
    clock: placement.placementClock,
  })
  assert.equal(kernel.kernelMachineOf(room.id, 'room')?.name, NAME, 'the fake still answers')
  kernel.useClassPlacements(null)
  assert.equal(kernel.kernelMachineOf(room.id, 'room'), null, 'and null puts every slot here')
})
