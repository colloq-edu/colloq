/**
 * Where the shared terminal goes.
 *
 * The Jupyter address is a property of the room, not of the process: that is
 * why two seminars can sit on different Pythons at the same time. The kernel
 * honoured this from the very appearance of environments, while the terminal
 * read the global setting — and in a seminar with a chosen environment
 * `pip install` went into a container this room's Python does not see. The
 * command ran, wrote "successfully installed" and changed nothing that could
 * be imported from a cell.
 *
 * The check goes by the source, not by behaviour, and this is deliberate: to
 * catch this bug coming back at run time, you need two live Jupyter containers
 * and a terminado socket to each — that is, a check that will not be in CI and
 * will not run on a laptop without Docker. And the whole bug is in one line:
 * the address was taken from the wrong place. Such a line is visible by
 * reading.
 */
import './_env.mts'
import assert from 'node:assert/strict'
import test, { after, before, beforeEach, type TestContext } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tr } from '../shared/i18n.js'
import { getTerminal, terminalText } from '../shared/notebook.js'
import { startFakeJupyter, startFakeLink } from './_fake-jupyter.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

test('the terminal does not read the Jupyter address from the instance settings', () => {
  const source = read('server/src/kernel/terminal.ts')
  const offenders = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter(({ line }) => line.includes('config.jupyter'))

  assert.deepEqual(
    offenders,
    [],
    `the terminal takes the address from config.jupyter again — in a room with its own environment ` +
      `it will go into someone else's container:\n` +
      offenders.map(({ no, line }) => `  terminal.ts:${no}  ${line}`).join('\n'),
  )
})

test('the terminal asks the room itself for the address', () => {
  const source = read('server/src/kernel/terminal.ts')
  assert.ok(
    source.includes('endpointForSession(sessionId,'),
    'the terminal must resolve the address through the room container, as the kernel does',
  )
})

test('the kernel and the terminal resolve the address the same way', () => {
  /*
   * Two subsystems, one rule. If one of them ever starts computing the address
   * its own way, they will drift apart silently: both will keep working, just
   * in different containers, and the one to notice is a student whose import
   * cannot find a package that was just installed.
   */
  const kernel = read('server/src/kernel/index.ts')
  const terminal = read('server/src/kernel/terminal.ts')

  /*
   * The rule is checked, not the letter.
   *
   * Previously the exact expression
   * `endpointForEnvironment(sessionEnvironment(sessionId))` stood here, and the
   * test broke on an edit that changed nothing in meaning: the environment
   * name was needed a second time — to forget a stale address on a refusal —
   * and moved into a variable. The rule itself stayed the same, but the check
   * did not survive it.
   */
  for (const [name, source] of [
    ['the kernel', kernel],
    ['the terminal', terminal],
  ] as const) {
    /*
     * One room — one container, and the shell must get into the same one
     * where the cells are computed: `!pip install` in the terminal and
     * `import` in a cell must talk about the same Python. Previously the rule
     * was "through the environment"; now it is stricter — through the room
     * itself.
     */
    assert.ok(
      source.includes('endpointForSession(sessionId,'),
      `${name} no longer resolves the address through the room container`,
    )
    assert.ok(
      source.includes('sessionEnvironment(sessionId)'),
      `${name} no longer asks the seminar for its environment`,
    )
    /*
     * There is no check on defaultEndpoint() here, and this is deliberate: in
     * terminal.ts it stands as a placeholder in a freshly created record,
     * before the terminal was ever opened. The real address is asked for in
     * openTerminal. A ban on the mere mention would catch this line and
     * improve nothing.
     */
  }
})

test('a change of address invalidates the remembered pty name', () => {
  /*
   * A pty named "1" exists in every container. Having remembered the name
   * from one and connected with it to another, the terminal would lead the
   * room into someone else's shell — not its own, but not into nothing
   * either, which is worse than an error.
   */
  const source = read('server/src/kernel/terminal.ts')
  assert.ok(
    /if \(endpointIdentity\(endpoint\) !== endpointIdentity\(term\.endpoint\)\) term\.name = null/.test(source),
    'the pty name must be reset when the address or the Pod UID changes',
  )
})

test('incarnation identity changes when a Pod is replaced behind the same Service URL', async () => {
  const { endpointIdentity } = await import('../server/src/kernel/jupyter.js')
  const first = { url: 'http://room.colloq.svc:8888', token: 'private', instanceId: 'uid-one' }
  assert.notEqual(endpointIdentity(first), endpointIdentity({ ...first, instanceId: 'uid-two' }))
  assert.equal(endpointIdentity(first), endpointIdentity({ ...first, token: 'rotated' }))
})

test('a machine’s endpoint is its identity, whatever port it is reached at', async () => {
  /*
   * A machine's kernel is reached through a loopback port of this server, and
   * a restart of the server gives it another one; the container and the pty
   * in it stay where they were. The identity names the placement and its gen
   * (remote-classes.md §4.5): the same across ports, another after a failover.
   */
  const { endpointIdentity } = await import('../server/src/kernel/jupyter.js')
  const before = { url: 'http://127.0.0.1:41001', token: 'room', instanceId: 'r1:c1:1', identity: 'machine:r1:c1:1' }
  assert.equal(endpointIdentity(before), endpointIdentity({ ...before, url: 'http://127.0.0.1:52002' }))
  assert.notEqual(endpointIdentity(before), endpointIdentity({ ...before, identity: 'machine:r1:c1:2' }))
})

/* ------------------------------------------------- a kernel on a machine */

/*
 * A machine's kernel is reached through a road that closes and opens
 * (remote-classes.md §5.1, §5.7), and its terminal rides the same drops as
 * its kernel: it waits for the road instead of spending its six tries, asks
 * for the address again on every reconnect (a failover moves the gen, a
 * restart of this server the port), and gives a jittery road a moment more
 * before it calls a command finished. These run for real, against the fake
 * Jupyter's terminado behind a road (tests/_fake-jupyter.mjs), with the
 * room's endpoint put on that road (jupyter.ts · useDefaultEndpointForTest).
 */

let fake: Awaited<ReturnType<typeof startFakeJupyter>>

before(async () => {
  // No idle connection outlives a request: tests here mock the clock and then cut the road.
  fake = await startFakeJupyter({ keepAlive: false })
})

beforeEach(async () => {
  const { setInstanceLanguage } = await import('../server/src/admin/settings.js')
  setInstanceLanguage('en')
})

after(async () => {
  const { shutdownTerminals } = await import('../server/src/kernel/terminal.js')
  const { useDefaultEndpointForTest } = await import('../server/src/kernel/jupyter.js')
  const { shutdownCollab } = await import('../server/src/collab/index.js')
  await shutdownTerminals()
  useDefaultEndpointForTest(null)
  await fake.close()
  shutdownCollab()
})

/** Poll until `what` holds, counting polls rather than reading the clock. */
async function until(what: () => boolean, polls = 400): Promise<boolean> {
  for (let poll = 0; poll < polls; poll++) {
    if (what()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return what()
}

/** Turn the event loop without timers: what a test that mocks setTimeout can wait with. */
async function turnsUntil(what: () => boolean, turns = 20_000): Promise<boolean> {
  for (let turn = 0; turn < turns && !what(); turn++) await new Promise((resolve) => setImmediate(resolve))
  return what()
}

let seq = 0

const who = { name: 'Maria', color: '#7e82f0', participantId: 'p_maria' }

/** A room whose kernel, and so whose shell, is on a pretend machine behind a road of its own. */
async function machineRoom(t: TestContext, identity?: string) {
  const { useDefaultEndpointForTest } = await import('../server/src/kernel/jupyter.js')
  const { closeTerminal } = await import('../server/src/kernel/terminal.js')
  const { createSession } = await import('../server/src/db.js')
  const road = await startFakeLink({ target: fake.port })
  const id = `term-link${seq++}`
  createSession(id, id)
  useDefaultEndpointForTest({ url: road.url, token: 'fake', link: road.link, identity: identity ?? `machine:r1:${id}:1` })
  t.after(async () => {
    await closeTerminal(id)
    useDefaultEndpointForTest(null)
    await road.close()
  })
  return { id, road }
}

/** The same with its shell open and settled: the greeting done, and one command run through. */
async function machineShell(t: TestContext, identity?: string) {
  const { openTerminal, runCommand, terminalPhase } = await import('../server/src/kernel/terminal.js')
  const room = await machineRoom(t, identity)
  await openTerminal(room.id)
  let finished = false
  runCommand(room.id, 'true', who, (result) => (finished = result.finished))
  assert.ok(await until(() => finished), `the shell is ${terminalPhase(room.id)}`)
  return room
}

const ptySockets = () => fake.calls.filter((call) => call.kind === 'upgrade' && call.path.startsWith('/terminals/')).length
/** Sockets that opened and began their greeting: each sends the shell its size first. */
const greetings = () => fake.calls.filter((call) => call.kind === 'size').length
/** The silence that ends a greeting (terminal.ts · PRIME_QUIET_MS). */
const PRIME_QUIET_MS = 350

async function transcript(id: string): Promise<string[]> {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  return getTerminal(getSessionDoc(id).doc)
    .toArray()
    .map((line) => terminalText(line).toString())
}

test('a machine kernel’s shell waits for its road, spends none of its tries and never dies of it', async (t) => {
  const { runCommand, terminalPhase } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t)
  const sockets = ptySockets()
  road.down()
  assert.ok(await until(() => road.waiting > 0), 'the shell did not wait for the road')
  assert.equal(terminalPhase(id), 'starting')
  // Typed during the outage: it waits for the shell, and the shell for the road.
  runCommand(id, 'echo during', who)
  // Three times as many rounds of outage as the six tries a shell gets.
  for (let round = 0; round < 18; round++) {
    road.expire()
    assert.ok(await until(() => road.waiting > 0), `the shell stopped waiting after ${round} rounds`)
  }
  assert.equal(road.counts.refused, 0, 'a reconnect was tried on a closed road')
  assert.equal(ptySockets(), sockets)
  road.up()
  assert.ok(await until(() => fake.calls.some((call) => call.kind === 'stdin' && call.data.includes('echo during'))))
  assert.notEqual(terminalPhase(id), 'dead')
  assert.equal(ptySockets(), sockets + 1, 'more than one socket once the road was open')
  const lost = tr('server.theConnectionToTheSharedShellWas.94c77c')
  assert.ok(!(await transcript(id)).some((text) => text.includes(lost)), 'the room was told the shell was lost')
})

test('a machine kernel’s shell opened while its road is down waits for the road, and a lost road fails the open', async (t) => {
  const { openTerminal, terminalPhase } = await import('../server/src/kernel/terminal.js')
  const watch = (opening: Promise<void>) => {
    const seen: { ended: true | Error | null } = { ended: null }
    opening.then(
      () => (seen.ended = true),
      (err: Error) => (seen.ended = err),
    )
    return seen
  }
  const { id, road } = await machineRoom(t)
  road.down()
  const opened = watch(openTerminal(id))
  assert.ok(await until(() => road.waiting > 0), 'the open did not wait for the road')
  road.expire()
  assert.ok(await until(() => road.waiting > 0), 'the open gave up on the road')
  assert.equal(road.counts.refused, 0, 'the open knocked on a closed road')
  assert.equal(terminalPhase(id), 'starting')
  road.up()
  assert.ok(await until(() => opened.ended !== null))
  assert.equal(opened.ended, true, String(opened.ended))
  assert.ok(await until(() => terminalPhase(id) === 'idle'), `the shell is ${terminalPhase(id)}`)

  const other = await machineRoom(t)
  other.road.down()
  const doomed = watch(openTerminal(other.id))
  assert.ok(await until(() => other.road.waiting > 0))
  other.road.lose()
  assert.ok(await until(() => doomed.ended !== null))
  assert.ok(doomed.ended instanceof Error, 'an open on a lost road went through')
  assert.equal(terminalPhase(other.id), 'dead')
  assert.equal(other.road.counts.refused, 0)
})

test('a reconnect the road cuts off mid-handshake is not one of the shell’s tries', async (t) => {
  const { terminalPhase } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t)
  // Every handshake hangs until the road cuts it.
  fake.upgradeDelayMs = 60_000
  t.after(() => {
    fake.upgradeDelayMs = 0
    fake.refuseUpgrades = 0
  })
  road.down()
  // Eight handshakes cut by the road, two more than the tries a shell gets.
  for (let cut = 0; cut < 8; cut++) {
    assert.ok(await until(() => road.waiting > 0), `the shell stopped waiting for the road after ${cut} cuts`)
    const before = ptySockets()
    road.up()
    assert.ok(await until(() => ptySockets() > before), `no handshake once the road opened (${cut})`)
    road.down()
  }
  // With the road open for good, one real failure is one try, not the seventh.
  fake.upgradeDelayMs = 0
  fake.refuseUpgrades = 1
  assert.ok(await until(() => road.waiting > 0))
  road.up()
  assert.ok(await until(() => terminalPhase(id) === 'idle'), `the shell is ${terminalPhase(id)}`)
})

test('nor is a socket the road closes in the shell’s greeting, after it opened', async (t) => {
  const { terminalPhase } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t)
  // No timer fires from here: every greeting stays under way until the test ends it.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  road.down()
  // Seven sockets closed by the road in their greeting, one more than the tries a shell gets.
  for (let cut = 0; cut < 7; cut++) {
    assert.ok(await turnsUntil(() => road.waiting > 0), `the shell stopped waiting for the road after ${cut} cuts`)
    const before = greetings()
    road.up()
    assert.ok(await turnsUntil(() => greetings() > before), `no socket once the road opened (${cut})`)
    road.down()
  }
  assert.ok(await turnsUntil(() => road.waiting > 0))
  const before = greetings()
  road.up()
  assert.ok(await turnsUntil(() => greetings() > before))
  // One more close, seen with the road already back (a tunnel replaced at once): a real try, and the first.
  road.down()
  road.up()
  await turnsUntil(() => false, 2000)
  assert.notEqual(terminalPhase(id), 'dead', 'the shell spent its tries on greetings the road cut')
  const after = greetings()
  t.mock.timers.tick(5000)
  assert.ok(await turnsUntil(() => greetings() > after), 'the shell did not try again')
  await turnsUntil(() => false, 2000)
  t.mock.timers.tick(PRIME_QUIET_MS)
  assert.ok(await turnsUntil(() => terminalPhase(id) === 'idle'), `the shell is ${terminalPhase(id)}`)
})

test('a machine kernel’s shell asks for its address again on reconnect, and a new identity ends it in words', async (t) => {
  const { useDefaultEndpointForTest } = await import('../server/src/kernel/jupyter.js')
  const { terminalPhase } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t, 'machine:r1:moved:1')
  road.down()
  assert.ok(await until(() => road.waiting > 0))
  // A failover placed the class again: a new gen, behind a new port.
  const next = await startFakeLink({ target: fake.port })
  t.after(() => next.close())
  useDefaultEndpointForTest({ url: next.url, token: 'fake', link: next.link, identity: 'machine:r1:moved:2' })
  road.up()
  assert.ok(await until(() => terminalPhase(id) === 'dead'), `the shell is ${terminalPhase(id)}`)
  const replaced = tr('server.theSeminarKernelWasReplacedThePrevious.bacb22')
  assert.ok((await transcript(id)).some((text) => text.includes(replaced)), 'the room was not told why')
  assert.equal(next.counts.accepted, 0, 'the old pty was looked for in the new container')
})

test('a road declared lost ends a machine kernel’s shell in the same words, and nothing keeps asking', async (t) => {
  const { terminalPhase } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t)
  road.down()
  assert.ok(await until(() => road.waiting > 0))
  road.lose()
  assert.ok(await until(() => terminalPhase(id) === 'dead'), `the shell is ${terminalPhase(id)}`)
  const replaced = tr('server.theSeminarKernelWasReplacedThePrevious.bacb22')
  assert.ok((await transcript(id)).some((text) => text.includes(replaced)), 'the room was not told why')
  const asked = road.counts.asked
  await turnsUntil(() => false, 50)
  assert.equal(road.counts.asked, asked, 'something keeps asking a lost road')
  assert.equal(road.counts.refused, 0)
})

test('a jittery road gives a command twice its jitter more silence before it counts as finished', async (t) => {
  const { quietPadMs, useLinkJitter, runCommand, terminalBusy } = await import('../server/src/kernel/terminal.js')
  const road = await startFakeLink({ target: 1 })
  t.after(() => road.close())
  const link = road.link
  const at = (rttMs: number | null) => {
    road.setRtt(rttMs as number)
    return quietPadMs({ url: 'http://127.0.0.1:1', token: 't', link })
  }
  // Twice the jitter, the link's round trip standing in for it; at most 600 ms; none without a link.
  assert.equal(at(120), 240)
  assert.equal(at(250), 500)
  assert.equal(at(400), 600)
  assert.equal(at(null), 0)
  assert.equal(quietPadMs({ url: 'http://127.0.0.1:1', token: 't' }, 250), 0)
  // Whoever measures the jitter itself says so in its place.
  useLinkJitter(() => 70)
  t.after(() => useLinkJitter(null))
  assert.equal(at(400), 140)
  useLinkJitter(null)

  // And the shell waits for it: 400 ms of silence and a prompt are not the end yet on a 300 ms road.
  const { id, road: shellRoad } = await machineShell(t)
  shellRoad.setRtt(300)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const typed = fake.calls.length
  runCommand(id, 'echo padded', who)
  assert.ok(await turnsUntil(() => fake.calls.slice(typed).some((call) => call.kind === 'stdin' && call.data.includes('echo padded'))))
  // The echo, the output and the prompt come back in one burst, all before the clock moves.
  await turnsUntil(() => false, 2000)
  t.mock.timers.tick(400 + 100)
  assert.equal(terminalBusy(id), true, 'the command was called finished inside the pad')
  t.mock.timers.tick(600)
  assert.equal(terminalBusy(id), false, 'the command never finished')
})

test('a command running when the road is cut is not called finished in the silence that follows', async (t) => {
  const { runCommand, terminalBusy } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const typed = fake.calls.length
  // Its output stops on a line that looks like a prompt: a progress figure.
  runCommand(id, 'printf 45% && sleep 30', who)
  assert.ok(await turnsUntil(() => fake.calls.slice(typed).some((call) => call.kind === 'stdin' && call.data.includes('printf'))))
  await turnsUntil(() => false, 2000)
  road.down()
  assert.ok(await turnsUntil(() => road.waiting > 0), 'the shell did not wait for the road')
  t.mock.timers.tick(10_000)
  assert.equal(terminalBusy(id), true, 'the silence of a cut road ended the command')
})

test('nor in the moment after a short cut, on the silence from before it', async (t) => {
  const { runCommand, terminalBusy } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const typed = fake.calls.length
  runCommand(id, 'printf 45% && sleep 30', who)
  assert.ok(await turnsUntil(() => fake.calls.slice(typed).some((call) => call.kind === 'stdin' && call.data.includes('printf'))))
  await turnsUntil(() => false, 2000)
  // The output is in the transcript, `45%` the last of it.
  t.mock.timers.tick(60)
  // A cut shorter than the 480 ms of quiet the command was given on a 40 ms road.
  road.down()
  assert.ok(await turnsUntil(() => road.waiting > 0))
  t.mock.timers.tick(300)
  const sockets = ptySockets()
  road.up()
  assert.ok(await turnsUntil(() => ptySockets() > sockets), 'the shell did not reconnect')
  await turnsUntil(() => false, 2000)
  // The road is up again and the old quiet would be due now, before the new socket's greeting is over.
  t.mock.timers.tick(200)
  assert.equal(terminalBusy(id), true, 'a silence from before the cut ended the command')
})

test('nor while the road stalls with its socket kept, as a resumable tunnel keeps it', async (t) => {
  const { runCommand, terminalBusy } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const typed = fake.calls.length
  runCommand(id, 'printf 45% && sleep 30', who)
  assert.ok(await turnsUntil(() => fake.calls.slice(typed).some((call) => call.kind === 'stdin' && call.data.includes('printf'))))
  await turnsUntil(() => false, 2000)
  road.stall()
  t.mock.timers.tick(10_000)
  assert.equal(terminalBusy(id), true, 'the silence of a stalled road ended the command')
  t.mock.timers.reset()
  road.up()
})

test('but a command that ends around a cut is finished once the shell is back, and the next one runs', async (t) => {
  const { runCommand, terminalBusy } = await import('../server/src/kernel/terminal.js')
  for (const when of ['before', 'during'] as const) {
    const { id, road } = await machineShell(t)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const command = when === 'before' ? 'echo hi' : 'sleep 1'
    let finished: boolean | null = null
    const typed = fake.calls.length
    runCommand(id, command, who, (result) => (finished = result.finished))
    assert.ok(await turnsUntil(() => fake.calls.slice(typed).some((call) => call.kind === 'stdin' && call.data.includes(command))))
    await turnsUntil(() => false, 2000)
    // What the shell printed is in the transcript; the quiet that would judge it is still to come.
    t.mock.timers.tick(60)
    road.down()
    assert.ok(await turnsUntil(() => road.waiting > 0), `${when}: the shell did not wait for the road`)
    // `sleep 1` ends in the outage: its prompt goes only into the scrollback the next greeting throws away.
    if (when === 'during') t.mock.timers.tick(1000)
    const before = greetings()
    road.up()
    assert.ok(await turnsUntil(() => greetings() > before), `${when}: the shell did not come back`)
    await turnsUntil(() => false, 2000)
    t.mock.timers.tick(PRIME_QUIET_MS)
    // The greeting over, the shell is asked whether it is free, and a free one answers with a prompt.
    const asked = (call: { kind: string; data?: string }) => call.kind === 'stdin' && call.data === '\n'
    assert.ok(await turnsUntil(() => fake.calls.slice(typed).some(asked)), `${when}: the shell was not asked`)
    await turnsUntil(() => false, 2000)
    t.mock.timers.tick(1500)
    assert.equal(finished, true, `the command that ended ${when} the cut was left running`)
    assert.equal(terminalBusy(id), false)
    const next = fake.calls.length
    runCommand(id, 'echo next', who)
    assert.ok(
      await turnsUntil(() => fake.calls.slice(next).some((call) => call.kind === 'stdin' && call.data.includes('echo next'))),
      `${when}: the next command never reached the shell`,
    )
    t.mock.timers.reset()
  }
})

test('and one that ended just before the road stalled is finished once the road is back', async (t) => {
  const { runCommand, terminalBusy } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineShell(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finished: boolean | null = null
  const typed = fake.calls.length
  runCommand(id, 'echo hi', who, (result) => (finished = result.finished))
  assert.ok(await turnsUntil(() => fake.calls.slice(typed).some((call) => call.kind === 'stdin' && call.data.includes('echo hi'))))
  await turnsUntil(() => false, 2000)
  t.mock.timers.tick(60)
  // The prompt is in, and the road stalls before the quiet that would end the command.
  road.stall()
  t.mock.timers.tick(10_000)
  assert.equal(finished, null, 'the silence of a stalled road ended the command')
  road.up()
  await turnsUntil(() => false, 50)
  // A full quiet from the moment the road is back, and the prompt that was in all along ends it.
  t.mock.timers.tick(1000)
  assert.equal(finished, true, 'the command was left running after the stall')
  assert.equal(terminalBusy(id), false)
})

test('a cut in the middle of the shell’s greeting does not finish it in the outage, and what was typed waits', async (t) => {
  const { openTerminal, runCommand, terminalPhase } = await import('../server/src/kernel/terminal.js')
  const { id, road } = await machineRoom(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  void openTerminal(id).catch(() => {})
  assert.ok(await turnsUntil(() => fake.calls.some((call) => call.kind === 'stdin' && call.data.startsWith('cd '))))
  // Typed while the shell is still greeting: it waits for the greeting to end.
  runCommand(id, 'echo typed-early', who)
  await turnsUntil(() => false, 2000)
  road.down()
  assert.ok(await turnsUntil(() => road.waiting > 0), 'the shell did not wait for the road')
  // Far past the greeting's 350 ms of quiet and its 4 s ceiling.
  t.mock.timers.tick(10_000)
  assert.equal(terminalPhase(id), 'starting', 'the greeting of a socket that is gone was finished')
  t.mock.timers.reset()
  road.up()
  assert.ok(
    await until(() => fake.calls.some((call) => call.kind === 'stdin' && call.data.includes('typed-early'))),
    `what was typed never reached the shell; it is ${terminalPhase(id)}`,
  )
})
