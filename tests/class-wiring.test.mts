/**
 * Classes on machines wired whole, in one process (docs/architecture/remote-classes.md
 * §3, §11.2, §17.2): the REAL placement module (kernel/remote/placement.ts),
 * the real kernel hooks (kernel/index.ts), the real sync (competitions/remote/
 * routes.ts), the real tunnel (both of its ends) and the kernel client, with
 * only the machine's agent stood in for: a stand-in that syncs by hand over
 * HTTP (_remote.mts · Machine), dials the tunnel with the agent's own end
 * (runner-agent/tunnel.ts · AgentTunnel), and answers its streams with a fake
 * Jupyter (_fake-jupyter.mjs).
 *
 * WHAT IS PROVED IS THE WIRING, AS THE SERVER HAS IT. Nothing hands the hooks
 * the placements: they take the process's module as it loads, and follow the
 * placements the test installs (as an e2e home does) with their clock — the
 * one the tunnels, the class clock and the machines' liveness run on here
 * (heard.ts · useRemoteClock). A Run goes to the machine and its output lands
 * in the room; the machine falls silent; past the class's failoverSec on that
 * clock, with the path proven, the room reads the failover in words that never
 * name the machine, the lost placement never hears a DELETE, and the next Run
 * computes here.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { tr } from '../shared/i18n.js'
import { CLASS_PLACEMENT_DEFAULT } from '../shared/admin.js'
import { remoteRevisionDigest, type RemoteClassFacts, type RemoteKernelsRequest, type RemotePlacementHeld } from '../shared/remote-kernels.js'
import { tunnelUrl, type TunnelClock } from '../shared/remote-tunnel.js'
import * as notebook from '../shared/notebook.js'
import { app } from '../server/src/app.js'
import { handleUpgrade } from '../server/src/upgrade.js'
import { createSession, setSessionPlacement } from '../server/src/db.js'
import { getRevision } from '../server/src/dependencies/store.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mintRemoteCode, runnerEventsOf } from '../server/src/competitions/remote/store.js'
import { loadClassPort, noteProbe, resetHeard, useRemoteClock } from '../server/src/competitions/remote/heard.js'
import { remoteTick } from '../server/src/competitions/remote/liveness.js'
import { kernelMachineOf, requestRun, shutdownKernels } from '../server/src/kernel/index.js'
import { useDefaultEndpointForTest } from '../server/src/kernel/jupyter.js'
import { MachineTunnels, useMachineTunnels } from '../server/src/kernel/remote/tunnel.js'
import { ClassPlacements, usePlacements } from '../server/src/kernel/remote/placement.js'
import { livePlacement, placementRow } from '../server/src/kernel/remote/placement-store.js'
import { AgentTunnel } from '../server/src/runner-agent/tunnel.js'
import { startFakeJupyter } from './_fake-jupyter.mjs'
import { guardAnswer } from './_guard.mts'
import { Machine, portableRevision, syncRequest } from './_remote.mts'

/* -------------------------------------------------------------- the rig */

/** A clock the test moves: timers run when it passes them, in order, each at its own moment. */
class HandClock implements TunnelClock {
  t = Date.now()
  private seq = 0
  private readonly timers = new Map<number, { at: number; run: () => void }>()
  now = (): number => this.t
  setTimeout = (run: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + Math.max(0, ms), run })
    return id
  }
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }
  advance(ms: number): void {
    const until = this.t + ms
    for (;;) {
      let next: [number, { at: number; run: () => void }] | null = null
      for (const entry of this.timers) if (entry[1].at <= until && (next === null || entry[1].at < next[1].at)) next = entry
      if (next === null) break
      this.timers.delete(next[0])
      this.t = Math.max(this.t, next[1].at)
      next[1].run()
    }
    this.t = until
  }
}

const GOOD: RemoteClassFacts = { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false }
const CONTAINER = 'c'.repeat(64)

/** A server word with its placeholders as patterns: what the room reads, whatever the clock said in it. */
function words(key: string, names: readonly string[]): RegExp {
  const marks = Object.fromEntries(names.map((name, i) => [name, `\u0000${i}\u0000`]))
  const escaped = tr(key, marks).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped.replace(/\u0000\d+\u0000/g, '.+?'))
}

async function until(what: () => boolean, label: string, polls = 400): Promise<void> {
  for (let poll = 0; poll < polls; poll++) {
    if (what()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(what(), `never: ${label}`)
}

const clock = new HandClock()
const quiet = (): void => undefined
const closing: Array<() => unknown> = []

after(async () => {
  for (const close of closing.reverse()) {
    try {
      await close()
    } catch {
      // The rest still closes: a socket or a port left open here would outlive the file.
    }
  }
})

/** The kernels block the stand-in machine sends: what it holds, its facts, its tunnel as its end says it. */
function block(placements: RemotePlacementHeld[], tunnel: 'up' | 'down'): RemoteKernelsRequest {
  return { placements, reports: [], epochs: [], readings: [], tunnel, classes: GOOD }
}

/* ---------------------------------------------------------------- tests */

test('a class set to machines: Run computes on the machine through the real sync and tunnel; silent past failoverSec, it fails over in words and comes back here', async () => {
  // The machines are heard, the tunnels live and the class clock ticks on the test's clock; out of the boot grace.
  useRemoteClock(clock)
  closing.push(() => useRemoteClock(null))
  resetHeard(clock.now() - 10 * 60_000)
  const tunnels = new MachineTunnels({ clock, log: quiet })
  useMachineTunnels(tunnels)
  closing.push(() => {
    useMachineTunnels(null)
    tunnels.shutdown()
  })
  const revision = getRevision(portableRevision('base').id)!
  // The process's placements as an e2e home installs them: its clock, an image the test noted (no docker here). The hooks are
  // handed nothing: they follow the process's placements by themselves.
  usePlacements(new ClassPlacements({ clock, revisionOf: async (environment) => (environment === 'base' ? revision : null), log: quiet }))
  closing.push(() => usePlacements(null))
  await loadClassPort()

  const server = http.createServer(app)
  server.on('upgrade', handleUpgrade)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closing.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // The machine's Jupyter, and this server's own for the slot once it comes back.
  const onMachine = await startFakeJupyter({ guardAnswer, interpreter: true })
  const here = await startFakeJupyter({ guardAnswer, interpreter: true })
  closing.push(() => onMachine.close(), () => here.close())
  useDefaultEndpointForTest({ url: here.url, token: 'here' })
  closing.push(() => useDefaultEndpointForTest(null))
  closing.push(() => shutdownKernels(), () => shutdownCollab())

  // A machine that takes classes, joined and synced: its facts, its image ready, its tunnel up.
  const m = new Machine(base)
  const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, classes: true, approvedSlots: null, namePrefix: 'wiring', createdBy: 'tests' }).code
  assert.equal((await m.join(code)).status, 200)
  const ready = { revisions: [revision.id], data: [], sealed: [], bundles: [] }
  const sync = async (placements: RemotePlacementHeld[], tunnel: 'up' | 'down') => {
    const answer = await m.sync({ ...syncRequest(), holdMs: 0, ready, kernels: block(placements, tunnel) })
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
    const kernels = m.last?.kernels
    assert.ok(kernels, 'a machine with classes gets the kernels block')
    return kernels
  }
  assert.equal((await sync([], 'down')).tunnel, 'reconnect', 'home wants the tunnel of a machine that takes classes')
  let current = 0
  const agent = new AgentTunnel({
    url: tunnelUrl(base),
    authorization: m.credential,
    build: 'dev',
    // The agent's record: the placement it holds, at its gen, on the fake's port; nothing else is reachable.
    resolve: (key, gen) => (key.endsWith(':room') && gen === current ? { port: onMachine.port } : { refused: 'gone' }),
    paceMBps: () => 1000,
    log: quiet,
  })
  closing.push(() => agent.close())
  agent.want('open')
  await until(() => tunnels.isUp(m.runnerId), 'the tunnel up at home')
  assert.equal((await sync([], 'up')).tunnel, 'open')

  // The class: its notebooks on machines, one cell.
  const id = `wiring${randomUUID().slice(0, 8)}`
  createSession(id, 'Wiring', 'base')
  setSessionPlacement(id, { ...CLASS_PLACEMENT_DEFAULT, room: 'machines' })
  const { doc } = getSessionDoc(id)
  const cells = notebook.getCells(doc)
  cells.push([notebook.createCell('code', 'x = 42\nprint(x)')])
  const cell = cells.get(cells.length - 1)
  const said = (): string => notebook.readOutputs(cell).map((output) => (output.kind === 'stream' ? output.text : '')).join('')
  const notes = (): string[] => notebook.getTerminal(doc).toArray().filter((line) => line.get('kind') === 'system').map((line) => String(line.get('text')))
  const run = () => requestRun(id, [notebook.cellId(cell)], 'Teacher', 'p_teacher', undefined, notebook.CELLS_KEY)

  // Run: the pump's start places the slot on the machine, which the next sync tells it.
  run()
  await until(() => livePlacement(id, 'room')?.state === 'starting', 'the slot placed on the machine')
  const placed = livePlacement(id, 'room')!
  assert.equal(placed.runnerId, m.runnerId)
  assert.deepEqual([kernelMachineOf(id, 'room')?.state, kernelMachineOf(id, 'room')?.rttMs], ['starting', null], 'no round trip while it starts')
  current = placed.gen
  const [intent] = (await sync([], 'up')).placements
  assert.equal(intent?.key, `${id}:room`, 'the whole wanted set names the slot')
  assert.equal(intent.gen, placed.gen)
  assert.match(intent.token, /^[0-9a-f]{40}$/)
  // The machine says it is ready, with the echo of the image it was asked for.
  await sync([{ key: intent.key, gen: intent.gen, phase: 'ready', container: CONTAINER, revision: remoteRevisionDigest(revision.registryRef!) }], 'up')
  await until(() => said() === '42\n', 'the output in the room')
  assert.equal(cell.get('state'), 'ok')
  assert.ok(onMachine.requests.some((request) => request.code.includes('print(x)')), 'computed on the machine')
  assert.equal(here.requests.length, 0, 'nothing computed here')
  const entry = notebook.bookKernel(doc, notebook.CELLS_KEY)
  assert.equal(entry.where, 'machine')
  assert.equal(entry.link, 'ok')
  assert.equal(kernelMachineOf(id, 'room')?.state, 'ready', 'staff read where it computes')
  const machineName = kernelMachineOf(id, 'room')!.name

  // The machine goes silent: no sync, and its tunnel gone.
  await agent.close()
  await until(() => !tunnels.isUp(m.runnerId), 'the tunnel down at home')
  await until(() => livePlacement(id, 'room')?.state === 'unreachable', 'the slot unreachable')
  // The class clock's passes, five seconds apart, with this server's own probe passing: the path is proven.
  const failoverMs = CLASS_PLACEMENT_DEFAULT.failoverSec * 1000
  let moved = -1
  for (let at = 5_000; at <= failoverMs + 10_000 && moved < 0; at += 5_000) {
    clock.advance(5_000)
    noteProbe(true, clock.now())
    remoteTick(clock.now())
    if (placementRow(id, 'room')?.state === 'lost') moved = at
  }
  assert.ok(moved >= failoverMs, `failed over at ${moved} ms, never before the class's ${failoverMs} ms`)
  assert.ok(moved <= failoverMs + 5_000, `and within a pass of it (${moved} ms)`)
  assert.equal(placementRow(id, 'room')?.reason, 'silence')
  assert.equal(runnerEventsOf(m.runnerId, ['class_failover'], 0).length, 1, 'one line in the machine’s log')
  const failover = words('server.theMachineHasNotAnsweredSinceThe.aa7fbb', ['since', 'filesAt'])
  await until(() => notes().some((note) => failover.test(note)), 'the failover’s words in the room')
  const room = notes().join('\n')
  assert.ok(notes().includes(tr('server.noConnectionToTheMachineTheKernel.71d94f', { elapsed: '0:10' })), `the unreachable note after ten seconds:\n${room}`)
  assert.ok(!JSON.stringify(doc.toJSON()).includes(machineName), 'the room’s document never names the machine')
  assert.equal(onMachine.calls.filter((call) => call.kind === 'http' && call.method === 'DELETE').length, 0, 'no DELETE ever reached the lost placement')

  // The next Run: the slot comes back to this server, its class's fallback, and computes here.
  run()
  await until(() => here.requests.some((request) => request.code.includes('print(x)')), 'computed here')
  await until(() => cell.get('state') === 'ok' && said() === '42\n', 'the cell done here')
  assert.equal(livePlacement(id, 'room'), null, 'nothing of the class on a machine')
  const back = notebook.bookKernel(doc, notebook.CELLS_KEY)
  assert.equal(back.where, null, 'the kernel says it is here again')
  assert.equal(typeof back.linkSince, 'number', '«переехало в …»')
  assert.ok(notes().includes(tr('server.noMachineCanTakeTheKernelNow.53437e')), 'and the room heard where it went')
  assert.equal(onMachine.calls.filter((call) => call.kind === 'http' && call.method === 'DELETE').length, 0)
})
