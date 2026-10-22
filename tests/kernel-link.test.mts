/**
 * A kernel on a machine, as this server's Jupyter client sees it: behind a
 * road that closes and opens (remote-classes.md §5).
 *
 * A machine's kernel is reached through a tunnel the machine dials, and the
 * tunnel drops for reasons that say nothing about the kernel. The client has
 * to ride every such drop without spending its reconnect budget, without
 * declaring a death and without a DELETE; settle a reply the drop ate, and a
 * restart whose answer it ate; and find a machine kernel's shell again behind
 * the new port a restart of this server gives it.
 *
 * The road is a TCP relay in front of the fake Jupyter that the test opens and
 * closes (tests/_fake-jupyter.mjs · startFakeLink), with the KernelLink that
 * reports on it; the real tunnel is kernel/remote/tunnel.ts, with a suite of
 * its own. The fake runs its small interpreter and keeps what a session
 * misses, as jupyter_server does. Nothing here waits on the clock: the tests
 * count polls and the link's own answers, and where a deadline matters the
 * clock is moved by hand.
 */
import './_env.mts'
import { after, before, beforeEach, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { tr } from '../shared/i18n.js'
import { CELLS_KEY } from '../shared/notebook.js'
import { config } from '../server/src/config.js'
import { guardAnswer } from './_guard.mts'
import { startFakeJupyter, startFakeLink } from './_fake-jupyter.mjs'
import {
  JupyterKernel,
  RestartUnknown,
  jupyterSessionPath,
  useDefaultEndpointForTest,
  type ExecuteHandlers,
} from '../server/src/kernel/jupyter.js'
import { GUARD_REPORT_EXPR, GUARD_REPORT_KEY, guardPolicySource, parseGuardReport } from '../server/src/kernel/danger.js'

let fake: Awaited<ReturnType<typeof startFakeJupyter>>

before(async () => {
  // No idle connection outlives a request: tests here mock the clock and then cut the road.
  fake = await startFakeJupyter({ guardAnswer, interpreter: true, buffer: true, keepAlive: false })
})

beforeEach(async () => {
  const { setInstanceLanguage } = await import('../server/src/admin/settings.js')
  setInstanceLanguage('en')
  fake.restarts = 'normal'
})

after(async () => {
  const { shutdownTerminals } = await import('../server/src/kernel/terminal.js')
  const { shutdownCollab } = await import('../server/src/collab/index.js')
  await shutdownTerminals()
  useDefaultEndpointForTest(null)
  await fake.close()
  shutdownCollab()
})

/* ------------------------------------------------------------------ helpers */

/**
 * Poll until `what` holds, counting polls rather than reading the clock: a
 * test that moves the clock by hand must not move its own deadlines with it.
 */
async function until(what: () => boolean, polls = 400): Promise<boolean> {
  for (let poll = 0; poll < polls; poll++) {
    if (what()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return what()
}

/** Let the event loop turn: a loop that keeps asking would show in that time. */
async function turns(count = 50): Promise<void> {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve))
}

/** Turn the event loop until `what` holds, with no timer: what a test that mocks setTimeout can wait with. */
async function turnsUntil(what: () => boolean, count = 20_000): Promise<boolean> {
  for (let turn = 0; turn < count && !what(); turn++) await new Promise((resolve) => setImmediate(resolve))
  return what()
}

/**
 * Wait for a promise the way `until` waits for a condition: a run that never
 * ends fails its test instead of holding the suite.
 */
async function outcome<T>(promise: Promise<T>, what = 'it never settled'): Promise<T> {
  let done = false
  let failed = false
  let value: T | undefined
  let failure: unknown
  promise.then(
    (result) => {
      done = true
      value = result
    },
    (err: unknown) => {
      done = true
      failed = true
      failure = err
    },
  )
  assert.ok(await until(() => done), what)
  if (failed) throw failure
  return value as T
}

function handlers(seen: string[] = [], errors: Array<[string, string]> = []): ExecuteHandlers {
  return {
    onExecuteInput: () => {},
    onStream: (_name, text) => seen.push(text),
    onData: () => {},
    onError: (ename, evalue) => errors.push([ename, evalue]),
    onClear: () => {},
  }
}

let seq = 0

/** A kernel on a pretend machine: the fake behind a road of its own. */
async function machineKernel(t: TestContext) {
  const road = await startFakeLink({ target: fake.port })
  const sessionId = `link${seq++}`
  const kernel = await JupyterKernel.connect(sessionId, {
    url: road.url,
    token: 'fake',
    link: road.link,
    identity: `machine:r1:${sessionId}:1`,
  })
  const id = fake.kernelAt(jupyterSessionPath(sessionId, CELLS_KEY))
  assert.ok(id, 'the fake has no kernel for the session')
  t.after(async () => {
    kernel.detach()
    await road.close()
  })
  return { kernel, road, id }
}

const callsOf = (kernel: string, msgType: string) =>
  fake.calls.filter((call) => call.kind === 'shell' && call.kernel === kernel && call.msgType === msgType).length

/** The guard, installed the way kernel/index.ts installs it on every start: the old process has it, a fresh one does not. */
async function installGuard(kernel: JupyterKernel): Promise<void> {
  let raw: unknown = null
  await outcome(
    kernel.execute(
      guardPolicySource(true),
      { ...handlers(), onUserExpressions: (values) => (raw = values[GUARD_REPORT_KEY]) },
      { silent: true, storeHistory: false, userExpressions: { [GUARD_REPORT_KEY]: GUARD_REPORT_EXPR } },
    ),
  )
  assert.equal(parseGuardReport(raw)?.policy, true, 'the fake did not confirm the guard')
}

/* ------------------------------------------------------- the reconnect */

test('a channel cut while the road is down waits for the road, knocks on nothing and never dies', async (t) => {
  const { kernel, road } = await machineKernel(t)
  const channels = () => fake.calls.filter((call) => call.kind === 'channel').length
  const opened = channels()
  road.down()
  assert.ok(await until(() => road.waiting > 0), 'the reconnect did not wait for the road')
  // Three times as many rounds of outage as the eight tries a kernel gets.
  for (let round = 0; round < 24; round++) {
    road.expire()
    assert.ok(await until(() => road.waiting > 0), `the kernel stopped waiting after ${round} rounds`)
  }
  assert.equal(road.counts.refused, 0, 'a reconnect was tried on a closed road')
  assert.equal(channels(), opened)
  assert.notEqual(kernel.phase, 'dead')

  road.up()
  const seen: string[] = []
  assert.equal(await outcome(kernel.execute('print("back")', handlers(seen))), 'ok')
  assert.deepEqual(seen, ['back\n'])
  assert.equal(channels(), opened + 1, 'more than one channel once the road was open')

  // Without a link, the same road is knocked on as it always has been.
  const plainRoad = await startFakeLink({ target: fake.port })
  const plain = await JupyterKernel.connect(`plain${seq++}`, { url: plainRoad.url, token: 'fake' })
  t.after(async () => {
    plain.detach()
    await plainRoad.close()
  })
  plainRoad.down()
  assert.ok(await until(() => plainRoad.counts.refused > 0), 'a kernel without a link stopped reconnecting')
})

test('a kernel brought up while its road is down waits for the road, not out its minute', async (t) => {
  const road = await startFakeLink({ target: fake.port })
  t.after(() => road.close())
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  road.down()
  const sessionId = `link${seq++}`
  const connecting = JupyterKernel.connect(sessionId, { url: road.url, token: 'fake', link: road.link })
  assert.ok(await until(() => road.waiting === 1), 'the start did not wait for the road')
  // Five minutes on the clock, far past the minute a start gets.
  t.mock.timers.tick(5 * 60_000)
  road.expire()
  assert.ok(await until(() => road.waiting === 1), 'the start gave up on the road')
  assert.equal(road.counts.refused, 0, 'the start knocked on a closed road')
  road.up()
  const kernel = await outcome(connecting)
  t.after(() => kernel.detach())
  assert.equal(kernel.phase, 'idle')

  // Lost while it waits: the start ends there, with nothing asked.
  const lostRoad = await startFakeLink({ target: fake.port })
  t.after(() => lostRoad.close())
  lostRoad.down()
  const doomed = JupyterKernel.connect(`link${seq++}`, { url: lostRoad.url, token: 'fake', link: lostRoad.link })
  assert.ok(await until(() => lostRoad.waiting === 1))
  lostRoad.lose()
  await assert.rejects(outcome(doomed), { message: tr('server.lostTheConnectionToThePythonKernel.c46ec2') })
  assert.equal(lostRoad.counts.refused, 0)
})

test('a road that closes under a start’s first handshake is waited out, and the kernel comes up', async (t) => {
  const road = await startFakeLink({ target: fake.port })
  t.after(() => road.close())
  const upgrades = () => fake.calls.filter((call) => call.kind === 'upgrade').length
  // The session is made; the channel's handshake hangs until the road cuts it.
  fake.upgradeDelayMs = 60_000
  t.after(() => {
    fake.upgradeDelayMs = 0
  })
  const before = upgrades()
  const connecting = JupyterKernel.connect(`link${seq++}`, { url: road.url, token: 'fake', link: road.link })
  assert.ok(await until(() => upgrades() > before), 'the start sent no handshake')
  road.down()
  assert.ok(await until(() => road.waiting === 1), 'the start did not wait for the road')
  fake.upgradeDelayMs = 0
  road.up()
  const kernel = await outcome(connecting)
  t.after(() => kernel.detach())
  assert.equal(kernel.phase, 'idle')
  assert.equal(road.counts.refused, 0, 'the start knocked on a closed road')
  assert.equal(await outcome(kernel.execute('print("up")', handlers())), 'ok')
})

test('the moment its road closes, a kernel waits for the road itself, with no backoff timer in front', async (t) => {
  const { kernel, road } = await machineKernel(t)
  // From here no timer fires: a reconnect that sat on its backoff timer would never reach the road.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  road.down()
  let turned = 0
  while (road.waiting === 0 && turned++ < 20_000) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(road.waiting, 1, 'the reconnect waited on a timer, not on the road')
  t.mock.timers.reset()
  road.up()
  assert.equal(await outcome(kernel.execute('print("at once")', handlers())), 'ok')
})

test('a cell run the instant the road closes waits for the road instead of going into the dying socket', async (t) => {
  const { kernel, road } = await machineKernel(t)
  const seen: string[] = []
  const errors: Array<[string, string]> = []
  road.down()
  // The socket still looks open here: the cut has not reached it yet.
  const run = kernel.execute('print("kept")', handlers(seen, errors))
  assert.ok(await until(() => road.waiting === 2), 'the run did not wait for the road')
  road.up()
  assert.equal(await outcome(run), 'ok')
  assert.deepEqual(seen, ['kept\n'])
  assert.deepEqual(errors, [])
})

test('help asked the instant the road closes is refused at once, and works again once it opens', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  road.down()
  // No timer fires from here: a refusal that waited out its timeout would never come.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let refused = false
  kernel.complete('df.', 3).catch(() => (refused = true))
  let turned = 0
  while (!refused && turned++ < 20_000) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(refused, 'help was sent into a socket the road had already cut')
  t.mock.timers.reset()
  // Both ends have seen the cut before the road opens again, as with a real tunnel.
  assert.ok(await until(() => road.waiting > 0 && fake.online(id) === 0))
  road.up()
  assert.equal(await outcome(kernel.execute('print("channel")', handlers())), 'ok')
  const answer = await outcome(kernel.complete('df.', 3))
  assert.deepEqual(
    answer.matches.map((match) => match.text),
    ['df.head', 'df.describe'],
  )
})

test('an attempt the road cuts off mid-handshake is the road’s failure, not one of the kernel’s tries', async (t) => {
  const { kernel, road } = await machineKernel(t)
  const upgrades = () => fake.calls.filter((call) => call.kind === 'upgrade').length
  // Every handshake hangs until the road cuts it.
  fake.upgradeDelayMs = 60_000
  t.after(() => {
    fake.upgradeDelayMs = 0
  })
  road.down()
  // Ten handshakes cut by the road, two more than the tries a kernel gets.
  for (let cut = 0; cut < 10; cut++) {
    assert.ok(await until(() => road.waiting > 0), `the kernel stopped waiting for the road after ${cut} cuts`)
    const before = upgrades()
    road.up()
    assert.ok(await until(() => upgrades() > before), `no handshake once the road opened (${cut})`)
    road.down()
  }
  assert.notEqual(kernel.phase, 'dead')

  fake.upgradeDelayMs = 0
  assert.ok(await until(() => road.waiting > 0))
  road.up()
  assert.equal(await outcome(kernel.execute('print(1)', handlers())), 'ok')
})

test('a run waits out the road however far past its deadline the outage goes', async (t) => {
  const { kernel, road } = await machineKernel(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  road.down()
  assert.ok(await until(() => road.waiting === 1), 'the reconnect did not wait for the road')
  const seen: string[] = []
  const run = kernel.execute('print("after the outage")', handlers(seen))
  assert.ok(await until(() => road.waiting === 2), 'the run did not wait for the road')
  // Ten minutes of outage on the clock, far past the 45 s a run waits for its channel.
  t.mock.timers.tick(10 * 60_000)
  road.expire()
  assert.ok(await until(() => road.waiting === 2), 'the run gave up on the road')
  road.up()
  assert.equal(await outcome(run), 'ok')
  assert.deepEqual(seen, ['after the outage\n'])
})

test('a kernel coming back from an OOM restart is not given up while its road is down', async (t) => {
  const { kernel, road } = await machineKernel(t)
  fake.slowRevival = true
  t.after(() => {
    fake.slowRevival = false
    fake.revive()
  })
  const phases: string[] = []
  kernel.onPhaseChange((phase) => phases.push(phase))
  assert.equal(await outcome(kernel.execute('OOM', handlers())), 'abort')
  assert.equal(kernel.phase, 'restarting')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  road.down()
  // The comeback and the reconnect both wait for the road.
  assert.ok(await until(() => road.waiting === 2), 'the comeback did not wait for the road')
  // Five minutes on the clock, far past the minute a comeback gets.
  t.mock.timers.tick(5 * 60_000)
  road.up()
  fake.revive()
  assert.ok(await until(() => kernel.phase === 'idle'), `the kernel ended ${kernel.phase}`)
  assert.ok(!phases.includes('dead'), `phases: ${phases.join(', ')}`)
})

test('a road declared lost stops the reconnects, and every wait on it ends', async (t) => {
  const { kernel, road } = await machineKernel(t)
  road.down()
  assert.ok(await until(() => road.waiting === 1))
  const waiting = kernel.execute('print(1)', handlers())
  assert.ok(await until(() => road.waiting === 2))
  road.lose()
  const lost = { message: tr('server.lostTheConnectionToThePythonKernel.c46ec2') }
  await assert.rejects(outcome(waiting), lost)
  await assert.rejects(outcome(kernel.execute('print(2)', handlers())), lost)
  const asked = road.counts.asked
  await turns()
  assert.equal(road.counts.asked, asked, 'something keeps asking a lost road')
  assert.equal(road.counts.refused, 0, 'a lost road was knocked on')
  // The phase is the failover's to set, with its words (endFromOutside).
  assert.notEqual(kernel.phase, 'dead')
})

/* --------------------------------------- the question after a quiet spell */

/*
 * A run after config.kernelQuietMs of silence asks Jupyter whether the kernel
 * is there at all (send · confirmAlive). A machine's kernel is asked beside
 * the run, so the tunnel's round trip is not put in front of the cell; at
 * home the question still comes first. The fake holds its answer to the GET
 * (`holdKernelGets`), and the clock is moved past the quiet by hand.
 */

/** Silence long enough for the next run to ask. */
function quietSpell(t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(config.kernelQuietMs + 1)
}

/** The questions about one kernel the fake received: its GETs. */
const asksOf = (kernel: string) =>
  fake.calls.filter((call) => call.method === 'GET' && call.path === `/api/kernels/${kernel}`).length

test('after a quiet spell a machine’s kernel runs the cell before Jupyter answers the question beside it, one question for two runs', async (t) => {
  const { kernel, id } = await machineKernel(t)
  quietSpell(t)
  fake.holdKernelGets = true
  t.after(() => fake.releaseKernelGets())
  const asked = asksOf(id)
  const seen: string[] = []
  const first = kernel.execute('print(1)', handlers(seen))
  const second = kernel.execute('print(2)', handlers(seen))
  assert.ok(await until(() => asksOf(id) === asked + 1), 'the quiet kernel was not asked about')
  // Both answered while the question waits: its round trip is not in front of the cells.
  assert.equal(await outcome(first), 'ok')
  assert.equal(await outcome(second), 'ok')
  assert.deepEqual(seen, ['1\n', '2\n'])
  await turns()
  assert.equal(asksOf(id), asked + 1, 'two runs in a row asked twice')
  fake.releaseKernelGets()
  assert.equal(await outcome(kernel.execute('print(3)', handlers())), 'ok')
  assert.notEqual(kernel.phase, 'dead')
})

test('a machine’s kernel the question beside its run finds gone ends the run as one found gone before it, and nothing more goes to it', async (t) => {
  const { kernel, id } = await machineKernel(t)
  const heard: Array<[string, boolean]> = []
  kernel.onPhaseChange((phase, expected) => heard.push([phase, expected]))
  quietSpell(t)
  fake.holdKernelGets = true
  t.after(() => fake.releaseKernelGets())
  // Gone with its channel left open, as Jupyter leaves it: what goes in is never answered.
  fake.kernels.get(id).alive = false
  const sent = callsOf(id, 'execute_request')
  const run = kernel.execute('print(1)', handlers())
  assert.ok(await until(() => callsOf(id, 'execute_request') === sent + 1), 'the run waited for the question')
  fake.releaseKernelGets()
  const gone = { message: tr('server.thePythonKernelIsNotRunning.a9cde2') }
  // Refused, not aborted: what a room runs again on a fresh kernel (kernel/index.ts · runOnKernel).
  await assert.rejects(outcome(run), gone)
  assert.equal(kernel.phase, 'dead')
  assert.deepEqual(heard, [['dead', true]], 'the death was not the one found by asking')
  await assert.rejects(outcome(kernel.execute('print(2)', handlers())), gone)
  await turns()
  assert.equal(callsOf(id, 'execute_request'), sent + 1, 'a run went to the kernel found gone')
})

test('a run the kernel was heard on is the kernel’s: the 404 beside it then is a death mid-run, never a refusal', async (t) => {
  const { kernel, id } = await machineKernel(t)
  const heard: Array<[string, boolean]> = []
  kernel.onPhaseChange((phase, expected) => heard.push([phase, expected]))
  quietSpell(t)
  fake.holdKernelGets = true
  t.after(() => {
    fake.releaseKernelGets()
    fake.release('heard')
  })
  const seen: string[] = []
  const run = kernel.execute('print("started")\nHOLD heard', handlers(seen))
  assert.ok(await until(() => fake.holding('heard') === 1 && seen.length === 1), 'the cell did not start')
  fake.kernels.get(id).alive = false
  fake.releaseKernelGets()
  // Refused, a room would run it a second time on a fresh kernel, and it has run here already.
  assert.equal(await outcome(run), 'abort')
  assert.deepEqual(seen, ['started\n'])
  assert.equal(kernel.phase, 'dead')
  // Not the death found by asking: nobody runs it again, so the room is the one to say it.
  assert.deepEqual(heard.filter(([phase]) => phase === 'dead'), [['dead', false]])
})

test('a 404 beside a run while the kernel has an earlier one is a death mid-run for both, refusing neither', async (t) => {
  const { kernel, id } = await machineKernel(t)
  const heard: Array<[string, boolean]> = []
  kernel.onPhaseChange((phase, expected) => heard.push([phase, expected]))
  t.after(() => fake.release('first'))
  const first = kernel.execute('HOLD first', handlers())
  assert.ok(await until(() => fake.holding('first') === 1))
  quietSpell(t)
  fake.holdKernelGets = true
  t.after(() => fake.releaseKernelGets())
  const sent = callsOf(id, 'execute_request')
  // Queued behind the held cell: the kernel says nothing of it while its question is out.
  const later = kernel.execute('print("later")', handlers())
  assert.ok(await until(() => callsOf(id, 'execute_request') === sent + 1))
  fake.kernels.get(id).alive = false
  fake.releaseKernelGets()
  // Refused, it would be run again beside a death the room is told of: all of it is aborted instead.
  assert.equal(await outcome(later), 'abort')
  assert.equal(await outcome(first), 'abort')
  assert.deepEqual(heard.filter(([phase]) => phase === 'dead'), [['dead', false]])
})

test('a run whose question said the kernel is there is the kernel’s: a later question’s 404 is a death mid-run', async (t) => {
  const { kernel, id } = await machineKernel(t)
  const heard: Array<[string, boolean]> = []
  kernel.onPhaseChange((phase, expected) => heard.push([phase, expected]))
  quietSpell(t)
  fake.holdKernelGets = true
  t.after(() => fake.releaseKernelGets())
  const asked = asksOf(id)
  const sent = callsOf(id, 'execute_request')
  // Lost on its way into the kernel, which then says not a word about it, though Jupyter says it is there.
  fake.kernels.get(id).alive = false
  const later = kernel.execute('print("later")', handlers())
  assert.ok(await until(() => asksOf(id) === asked + 1 && callsOf(id, 'execute_request') === sent + 1))
  await turns()
  fake.kernels.get(id).alive = true
  fake.releaseKernelGets()
  // The answer crosses the loopback road in a few turns.
  await turns()
  t.mock.timers.tick(config.kernelQuietMs + 1)
  fake.kernels.get(id).alive = false
  const third = kernel.execute('print(3)', handlers())
  // Sent beside a question that said yes, it counts as sent after an awaited one: the kernel's, and lost with it.
  assert.equal(await outcome(later), 'abort')
  assert.equal(await outcome(third), 'abort')
  assert.equal(asksOf(id), asked + 2, 'the third run did not ask a question of its own')
  assert.deepEqual(heard, [['dead', false]])
})

test('at home the question after a quiet spell still comes before the run', async (t) => {
  const sessionId = `plain${seq++}`
  const kernel = await JupyterKernel.connect(sessionId, { url: fake.url, token: 'fake' })
  t.after(() => kernel.detach())
  const id = fake.kernelAt(jupyterSessionPath(sessionId, CELLS_KEY)) ?? ''
  quietSpell(t)
  fake.holdKernelGets = true
  t.after(() => fake.releaseKernelGets())
  const asked = asksOf(id)
  const sent = callsOf(id, 'execute_request')
  const run = kernel.execute('print(1)', handlers())
  assert.ok(await until(() => asksOf(id) === asked + 1), 'the quiet kernel was not asked about')
  // Help goes on the same channel at once: a run sent before it would have reached the kernel first.
  await outcome(kernel.complete('df.', 3))
  assert.equal(callsOf(id, 'execute_request'), sent, 'the run went before Jupyter answered')
  fake.releaseKernelGets()
  assert.equal(await outcome(run), 'ok')
  assert.equal(callsOf(id, 'execute_request'), sent + 1)
})

/* ------------------------------------------------- ended from outside */

test('a kernel ended from outside is dead with its words, never sent a DELETE, and asks Jupyter nothing more', async (t) => {
  const deletes = () => fake.calls.filter((call) => call.method === 'DELETE').length
  for (const cause of ['lost', 'fenced'] as const) {
    const { kernel, road, id } = await machineKernel(t)
    // What reaches the fake about this kernel. A fenced placement's road is still up, so a request would.
    const asks = () => fake.calls.filter((call) => call.kind === 'http' && call.path.includes(id)).length
    const heard: Array<[string, boolean, string | undefined]> = []
    kernel.onPhaseChange((phase, expected) => heard.push([phase, expected, kernel.endedBy?.words]))
    const seen: string[] = []
    const run = kernel.execute(`print("started")\nHOLD ${cause}`, handlers(seen))
    assert.ok(await until(() => fake.holding(cause) === 1))
    const before = deletes()
    if (cause === 'lost') road.lose()
    kernel.endFromOutside(cause, `the words for ${cause}`)
    assert.equal(await outcome(run), 'abort')
    assert.equal(kernel.phase, 'dead')
    assert.deepEqual(kernel.endedBy, { cause, words: `the words for ${cause}` })
    // Unexpected, and whoever hears `dead` can already read why.
    assert.deepEqual(heard.at(-1), ['dead', false, `the words for ${cause}`])
    const asked = asks()
    await assert.rejects(outcome(kernel.execute('print(1)', handlers())))
    // Nor a restart or an interrupt: the port that led to the kernel may lead elsewhere by now.
    await assert.rejects(outcome(kernel.restart()))
    await assert.rejects(outcome(kernel.interrupt()))
    assert.equal(kernel.phase, 'dead', `a restart brought a kernel ended as ${cause} back`)
    // A careless dispose() lets go of it all the same.
    const accepted = road.counts.accepted
    await kernel.dispose()
    await turns()
    assert.equal(asks(), asked, `a kernel ended as ${cause} still asked Jupyter something`)
    assert.equal(deletes(), before, `a kernel ended as ${cause} was sent a DELETE`)
    assert.equal(road.counts.accepted, accepted, `a kernel ended as ${cause} went on reconnecting`)
    fake.release(cause)
  }

  // An ordinary kernel's dispose does send one: the count above would see it.
  const road = await startFakeLink({ target: fake.port })
  t.after(() => road.close())
  const plain = await JupyterKernel.connect(`plain${seq++}`, { url: road.url, token: 'fake' })
  const before = deletes()
  await plain.dispose()
  assert.equal(deletes(), before + 1)
})

test('a channel that opens after its kernel was let go of or ended is closed at once, never taken in', async (t) => {
  const upgrades = () => fake.calls.filter((call) => call.kind === 'upgrade').length
  t.after(() => {
    fake.upgradeDelayMs = 0
    fake.releaseUpgrades()
  })
  for (const end of ['detach', 'endFromOutside'] as const) {
    const { kernel, road, id } = await machineKernel(t)
    // A blip, and the reconnect's handshake is held while the kernel is given up.
    fake.upgradeDelayMs = 60_000
    road.down()
    assert.ok(await until(() => road.waiting > 0))
    const before = upgrades()
    road.up()
    assert.ok(await until(() => upgrades() > before), `${end}: no reconnect`)
    if (end === 'detach') kernel.detach()
    else kernel.endFromOutside('fenced', 'the placement moved')
    const landed = fake.sockets.length
    fake.upgradeDelayMs = 0
    fake.releaseUpgrades()
    assert.ok(await until(() => fake.sockets.length > landed), `${end}: the handshake never landed`)
    // Taken in, it would be a live second connection to a kernel nobody holds, for as long as the process lives.
    assert.ok(await until(() => fake.online(id) === 0), `${end}: the channel that opened late stayed open`)
  }
})

/* ---------------------------------------------- what a cut ate (§5.5) */

test('a reply that survived the cut is replayed, and nothing is settled on top of it', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  const seen: string[] = []
  const errors: Array<[string, string]> = []
  const run = kernel.execute('print("before")\nHOLD replay\nprint("after")', handlers(seen, errors))
  assert.ok(await until(() => fake.holding('replay') === 1))
  road.down()
  assert.ok(await until(() => fake.online(id) === 0), 'the fake did not see the channel go')
  // The cell ends while the road is down, and jupyter_server keeps what it said.
  fake.release('replay')
  assert.ok(await until(() => fake.buffered(id) > 0))
  const phases: string[] = []
  kernel.onPhaseChange((phase) => phases.push(phase))
  const asked = callsOf(id, 'kernel_info_request')
  road.up()
  assert.equal(await outcome(run), 'ok')
  assert.deepEqual(seen, ['before\n', 'after\n'])
  assert.deepEqual(errors, [], 'a replayed reply was settled as lost')
  assert.ok(await until(() => callsOf(id, 'kernel_info_request') === asked + 1), 'the reconnect asked no question')
  // The replayed idle moves the phase; the reconnect's own question does not blink it.
  await turns()
  assert.deepEqual(phases, ['idle'])
})

test('a reply the cut ate is settled as lost once the replay is in, and the kernel is idle again', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  const seen: string[] = []
  const errors: Array<[string, string]> = []
  const run = kernel.execute('print("ran")\nLOSE', handlers(seen, errors))
  assert.ok(await until(() => fake.calls.some((call) => call.kind === 'lost' && call.kernel === id)))
  assert.equal(kernel.phase, 'busy')
  road.down()
  assert.ok(await until(() => road.waiting > 0))
  road.up()
  assert.equal(await outcome(run), 'error')
  assert.deepEqual(seen, ['ran\n'])
  assert.deepEqual(errors, [['', tr('server.theConnectionToTheMachineBrokeThe.5504d1')]])
  assert.equal(kernel.phase, 'idle')
  assert.equal(await outcome(kernel.execute('print("next")', handlers())), 'ok')
})

test('work sent after the reconnect is not settled, and a kernel busy with it is asked again', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  const errors: Array<[string, string]> = []
  const lost = kernel.execute('LOSE', handlers([], errors))
  assert.ok(await until(() => fake.calls.some((call) => call.kind === 'lost' && call.kernel === id)))
  road.down()
  assert.ok(await until(() => road.waiting > 0))
  // The reconnect's question is answered only once a newer cell is queued behind it.
  fake.holdKernelInfo = true
  t.after(() => fake.releaseKernelInfo())
  const asked = callsOf(id, 'kernel_info_request')
  road.up()
  assert.ok(await until(() => callsOf(id, 'kernel_info_request') === asked + 1))
  const sent = callsOf(id, 'execute_request')
  const seen: string[] = []
  const later = kernel.execute('print("later")\nHOLD later', handlers(seen))
  assert.ok(await until(() => callsOf(id, 'execute_request') === sent + 1))
  fake.releaseKernelInfo()
  // Jupyter says busy with the newer cell: asked again, and that question waits behind it.
  assert.ok(await until(() => fake.holding('later') === 1))
  assert.ok(await until(() => callsOf(id, 'kernel_info_request') === asked + 2), 'busy was not asked again')
  assert.deepEqual(errors, [], 'settled while the kernel was busy')
  fake.release('later')
  assert.equal(await outcome(later), 'ok')
  assert.deepEqual(seen, ['later\n'])
  assert.equal(await outcome(lost), 'error')
  assert.deepEqual(errors, [['', tr('server.theConnectionToTheMachineBrokeThe.5504d1')]])
})

test('only what was out at the cut is settled: what the new channel sent is its own', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  const losses = () => fake.calls.filter((call) => call.kind === 'lost' && call.kernel === id).length
  const old = kernel.execute('LOSE', handlers())
  assert.ok(await until(() => losses() === 1))
  road.down()
  assert.ok(await until(() => road.waiting > 0))
  fake.holdKernelInfo = true
  t.after(() => fake.releaseKernelInfo())
  const asked = callsOf(id, 'kernel_info_request')
  road.up()
  assert.ok(await until(() => callsOf(id, 'kernel_info_request') === asked + 1))
  // Sent on the new channel, with its reply lost as well: whatever lost it, the cut did not.
  let newerDone = false
  void kernel.execute('LOSE', handlers()).then(() => (newerDone = true))
  assert.ok(await until(() => losses() === 1 && callsOf(id, 'execute_request') > 1))
  fake.releaseKernelInfo()
  assert.equal(await outcome(old), 'error')
  await turns()
  assert.equal(newerDone, false, 'work sent after the reconnect was settled as the cut’s')
})

test('a reply from the process that took the work out at a cut settles what went before it unanswered, the reconnect\'s question still unanswered', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  const errors: Array<[string, string]> = []
  const lost = kernel.execute('LOSE', handlers([], errors))
  const seen: string[] = []
  const behind = kernel.execute('HOLD behind\nprint("behind")', handlers(seen))
  assert.ok(await until(() => fake.calls.some((call) => call.kind === 'lost' && call.kernel === id) && fake.holding('behind') === 1))
  road.down()
  assert.ok(await until(() => road.waiting > 0))
  // The reconnect's question is answered only after the work queued before it: here, never.
  fake.holdKernelInfo = true
  t.after(() => fake.releaseKernelInfo())
  const asked = callsOf(id, 'kernel_info_request')
  road.up()
  assert.ok(await until(() => callsOf(id, 'kernel_info_request') === asked + 1))
  await turns()
  assert.deepEqual(errors, [], 'settled while the work behind it was computing')
  // Shell is answered in order: the reply of the work behind it says its reply will never come.
  fake.release('behind')
  assert.equal(await outcome(behind), 'ok')
  assert.deepEqual(seen, ['behind\n'])
  assert.equal(await outcome(lost), 'error')
  assert.deepEqual(errors, [['', tr('server.theConnectionToTheMachineBrokeThe.5504d1')]])
})

test('a process killed for memory while the road was cut is a restart heard late, never a reply lost', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  await installGuard(kernel)
  await outcome(kernel.execute('x = 5', handlers()))
  const heard: Array<[string, boolean]> = []
  kernel.onPhaseChange((phase, expected) => heard.push([phase, expected]))
  const errors: Array<[string, string]> = []
  const run = kernel.execute('HOLD big\nOOM', handlers([], errors))
  assert.ok(await until(() => fake.holding('big') === 1))
  road.down()
  assert.ok(await until(() => road.waiting > 0 && fake.online(id) === 0), 'the fake did not see the channel go')
  // jupyter_server restarts it with nobody connected, and its word of it reaches no channel.
  const incarnation = fake.kernels.get(id).process
  fake.release('big')
  assert.ok(await until(() => fake.kernels.get(id).process === incarnation + 1))
  road.up()
  assert.equal(await outcome(run), 'abort')
  assert.deepEqual(errors, [], 'the room was told its variables are intact')
  // Unexpected, as the live word is: the room drops its queue, says why and installs its guard again.
  assert.deepEqual(heard.find(([phase]) => phase === 'restarting'), ['restarting', false])
  assert.ok(await until(() => kernel.phase === 'idle'), `the kernel is ${kernel.phase}`)
  assert.equal((await outcome(kernel.evaluate('x'))).status, 'error', 'the old process’s variables are still there')
})

/* ------------------------------------------------- restart (§5.4) */

/** Press Restart, and let the road eat what comes back. */
async function restartCut(kernel: JupyterKernel, road: Awaited<ReturnType<typeof startFakeLink>>, id: string) {
  const restarted = kernel.restart().then(
    () => null,
    (err: unknown) => err,
  )
  assert.ok(
    await until(() => fake.calls.some((call) => call.method === 'POST' && call.path === `/api/kernels/${id}/restart`)),
    'the restart did not reach the fake',
  )
  road.down()
  return restarted
}

test('a restart whose answer the road ate is RestartUnknown, and a fresh process settles it as happened', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  await installGuard(kernel)
  fake.restarts = 'unanswered'
  const failure = await outcome(restartCut(kernel, road, id))
  assert.ok(failure instanceof RestartUnknown, `the restart ended with ${String(failure)}`)
  assert.equal(failure.message, tr('server.theRestartWasSentButNoAnswer.17cbbc'))
  // Not dead: restarting, as asked for, until somebody looks.
  assert.equal(kernel.phase, 'restarting')
  assert.equal(kernel.phaseExpected, true)
  road.up()
  // The guard goes into the fresh process before anyone looks, as a rule change sends it: the old process's mark, now in the new one.
  await installGuard(kernel)
  assert.equal(await outcome(kernel.settleRestart()), 'happened')
  assert.equal(kernel.phase, 'idle')
})

test('a restart that never reached the kernel is settled as missed: the old process answers', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  await installGuard(kernel)
  await outcome(kernel.execute('x = 41 + 1', handlers()))
  fake.restarts = 'ignored'
  assert.ok((await outcome(restartCut(kernel, road, id))) instanceof RestartUnknown)
  road.up()
  assert.equal(await outcome(kernel.settleRestart()), 'missed')
  assert.equal(kernel.phase, 'idle')
  const seen: string[] = []
  assert.equal(await outcome(kernel.execute('print(x)', handlers(seen))), 'ok')
  assert.deepEqual(seen, ['42\n'], 'the variables did not survive the restart that did not happen')
})

test('an old process still computing leaves the question unanswered: missed, and busy', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  await installGuard(kernel)
  void kernel.execute('HOLD stuck', handlers())
  assert.ok(await until(() => fake.holding('stuck') === 1))
  fake.restarts = 'ignored'
  assert.ok((await outcome(restartCut(kernel, road, id))) instanceof RestartUnknown)
  road.up()
  assert.equal(await outcome(kernel.settleRestart(200)), 'missed')
  assert.equal(kernel.phase, 'busy')
  fake.release('stuck')
})

test('a restarted kernel whose machine is lost before its channel is back is left to the failover to end', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  const heard: Array<[string, string | undefined]> = []
  kernel.onPhaseChange((phase) => heard.push([phase, kernel.endedBy?.words]))
  fake.restarts = 'held'
  const restarted = kernel.restart().then(
    () => null,
    (err: unknown) => err,
  )
  assert.ok(await until(() => fake.calls.some((call) => call.method === 'POST' && call.path === `/api/kernels/${id}/restart`)))
  // Home declares the machine lost; the restart's answer still makes it through.
  road.lose({ cut: false })
  fake.answerRestarts()
  const failure = await outcome(restarted)
  assert.ok(failure instanceof Error && !(failure instanceof RestartUnknown), String(failure))
  assert.equal(kernel.phase, 'restarting', 'a generic death came before the failover’s words')
  kernel.endFromOutside('lost', 'the failover’s words')
  assert.deepEqual(heard.at(-1), ['dead', 'the failover’s words'])
  assert.equal(heard.filter(([phase]) => phase === 'dead').length, 1)
})

test('a restart is not even sent while the road is down, and nothing is touched', async (t) => {
  const { kernel, road, id } = await machineKernel(t)
  const run = kernel.execute('HOLD pressed', handlers())
  assert.ok(await until(() => fake.holding('pressed') === 1))
  road.down()
  assert.ok(await until(() => fake.online(id) === 0), 'the fake did not see the channel go')
  const refused = await kernel.restart().then(
    () => null,
    (err: unknown) => err,
  )
  assert.ok(refused instanceof Error && !(refused instanceof RestartUnknown), String(refused))
  assert.equal(kernel.phase, 'busy', 'the refused restart moved the phase')
  assert.ok(!fake.calls.some((call) => call.path === `/api/kernels/${id}/restart`))
  // The running cell's wait was left alone: its end still arrives.
  fake.release('pressed')
  road.up()
  assert.equal(await outcome(run), 'ok')
})

test('without a link, a restart request that fails is the error it always was', async (t) => {
  const road = await startFakeLink({ target: fake.port })
  const sessionId = `plain${seq++}`
  const kernel = await JupyterKernel.connect(sessionId, { url: road.url, token: 'fake' })
  t.after(async () => {
    kernel.detach()
    await road.close()
  })
  const id = fake.kernelAt(jupyterSessionPath(sessionId, CELLS_KEY)) ?? ''
  fake.restarts = 'unanswered'
  const failure = await outcome(restartCut(kernel, road, id))
  assert.ok(failure instanceof Error && !(failure instanceof RestartUnknown), String(failure))
})

/* ------------------------------------------------ evaluate, identity */

test('a silent evaluation answers for its expression alone, and leaves nothing in history or on the indicator', async (t) => {
  const { kernel } = await machineKernel(t)
  await outcome(kernel.execute('x = 5', handlers()))
  const phases: string[] = []
  kernel.onPhaseChange((phase) => phases.push(phase))
  const before = fake.requests.length
  const known = await outcome(kernel.evaluate('x'))
  assert.equal(known.status, 'ok')
  assert.equal((known.value?.data as Record<string, string> | undefined)?.['text/plain'], '5')
  const unknown = await outcome(kernel.evaluate('nope'))
  assert.equal(unknown.status, 'error')
  assert.equal(unknown.value?.ename, 'NameError')
  assert.deepEqual(
    fake.requests.slice(before).map((asked) => [asked.code, asked.silent, asked.store_history]),
    [
      ['', true, false],
      ['', true, false],
    ],
  )
  assert.deepEqual(phases, [], 'the evaluation blinked the indicator')
  // Behind a computing cell the question waits, and comes back unanswered.
  const held = kernel.execute('HOLD busy', handlers())
  assert.ok(await until(() => fake.holding('busy') === 1))
  assert.deepEqual(await outcome(kernel.evaluate('x', 200)), { status: 'unanswered', value: null })
  const later: string[] = []
  kernel.onPhaseChange((phase) => later.push(phase))
  fake.release('busy')
  assert.equal(await outcome(held), 'ok')
  // Asked behind the late answer, so answered after it: by then that one is in, and as quiet.
  assert.equal((await outcome(kernel.evaluate('x'))).status, 'ok')
  assert.deepEqual(later, ['idle'], 'the late answer blinked the indicator')
})

test('help from a distant machine waits as long as its caller pads it, and only a real duration pads it', async (t) => {
  const { kernel } = await machineKernel(t)
  // A computing cell keeps help waiting behind it, as ipykernel does.
  const held = kernel.execute('HOLD far', handlers())
  assert.ok(await until(() => fake.holding('far') === 1))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ended: Record<string, string> = {}
  const watch = (name: string, help: Promise<unknown>) =>
    void help.then(
      () => (ended[name] = 'answered'),
      () => (ended[name] = 'refused'),
    )
  watch('plain', kernel.complete('df.', 3))
  watch('padded', kernel.complete('df.', 3, 1000))
  watch('help', kernel.inspect('df.head', 7, 0, 1000))
  watch('nonsense', kernel.complete('df.', 3, Number.NaN))
  await turns()
  t.mock.timers.tick(2_400)
  await turns()
  assert.deepEqual({ ...ended }, {}, 'help was refused before its wait was out')
  // Past the 2.5 s every question gets: the unpadded give up, as they always have.
  t.mock.timers.tick(200)
  await turns()
  assert.deepEqual({ ...ended }, { plain: 'refused', nonsense: 'refused' })
  // The cell ends inside the pad, and the padded questions get their answers.
  fake.release('far')
  assert.ok(await turnsUntil(() => ended.padded !== undefined && ended.help !== undefined), JSON.stringify(ended))
  assert.deepEqual(ended, { plain: 'refused', nonsense: 'refused', padded: 'answered', help: 'answered' })
  t.mock.timers.reset()
  assert.equal(await outcome(held), 'ok')
})

test('the shell of a machine’s kernel is found again behind the new port a restart gives it', async (t) => {
  const { openTerminal, shutdownTerminals, terminalPhase } = await import('../server/src/kernel/terminal.js')
  const { createSession } = await import('../server/src/db.js')
  const first = await startFakeLink({ target: fake.port })
  const second = await startFakeLink({ target: fake.port })
  t.after(async () => {
    useDefaultEndpointForTest(null)
    await shutdownTerminals()
    await first.close()
    await second.close()
  })
  const identity = 'machine:r1:c0ffee:1'
  useDefaultEndpointForTest({ url: first.url, token: 'fake', link: first.link, identity })
  const id = `link-pty${seq++}`
  createSession(id, id)
  await openTerminal(id)
  assert.ok(await until(() => terminalPhase(id) === 'idle'), `the shell is ${terminalPhase(id)}`)
  const shells = fake.terminals().length

  // This server restarts: it forgets the shell, and the container keeps it.
  await shutdownTerminals()
  useDefaultEndpointForTest({ url: second.url, token: 'fake', link: second.link, identity })
  const through = second.counts.accepted
  await openTerminal(id)
  assert.ok(await until(() => terminalPhase(id) === 'idle'), `the shell is ${terminalPhase(id)}`)
  assert.equal(fake.terminals().length, shells, 'a new shell was made for the same container')
  assert.ok(second.counts.accepted > through, 'the shell was not reached through the new port')

  // A new gen is another container, and its shell is a new one.
  await shutdownTerminals()
  useDefaultEndpointForTest({ url: second.url, token: 'fake', link: second.link, identity: 'machine:r1:c0ffee:2' })
  await openTerminal(id)
  assert.equal(fake.terminals().length, shells + 1)
})

test('the fake also runs as a process of its own, as a class container’s Jupyter does in the e2e harness', async (t) => {
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fake-jupyter-cli-'))
  const entry = fileURLToPath(new URL('./_fake-jupyter.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry, '--port', '0', '--cwd', dir, '--token', 'cli-token'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    // Only the process this test started, by its own handle.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  })
  const port = await outcome(
    new Promise<number>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('\n')) resolve(Number(out.split('\n')[0]))
      })
      child.once('exit', (code) => reject(new Error(`the fake exited with ${code}`)))
    }),
    'the fake printed no port',
  )
  const base = `http://127.0.0.1:${port}`
  assert.equal((await fetch(`${base}/api/status`)).status, 403, 'the token is not checked')
  assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: 'token cli-token' } })).status, 200)

  const kernel = await JupyterKernel.connect(`cli${seq++}`, { url: base, token: 'cli-token' })
  const seen: string[] = []
  const program = 'x = 5\nWRITE out.txt hello\nprint(x)\nREAD out.txt\nCOUNT'
  assert.equal(await outcome(kernel.execute(program, handlers(seen))), 'ok')
  assert.deepEqual(seen, ['5\n', 'hello', '1\n'])
  assert.equal(readFileSync(path.join(dir, 'out.txt'), 'utf8'), 'hello')
  const calls = (await (await fetch(`${base}/_fake/calls`)).json()) as Array<{ kind: string; value?: number }>
  assert.ok(calls.some((call) => call.kind === 'count' && call.value === 1))
  kernel.detach()

  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await outcome(exited, 'the fake did not stop on SIGTERM')
})
