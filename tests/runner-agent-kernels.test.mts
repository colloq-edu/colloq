/**
 * A machine's class kernels (server/src/runner-agent/kernels.ts,
 * docs/architecture/remote-classes.md §7): one container per slot of a class,
 * started with home's argv behind home's perimeter, held across the agent's
 * restarts, measured, and said in every sync — against a fake docker and a
 * clock of the test's own, never a daemon and never the wall clock.
 *
 * What is held here is what a class would lose. A container started before
 * its perimeter is a kernel that reaches the machine's LAN; one started on a
 * card a submission holds is two runs on one card; a start that a removal
 * cannot stop is a class kernel nobody wants, on somebody's rented machine;
 * an agent restart that recreates its kernels is a class that loses every
 * variable to a fleet update; a sweep that takes them is the same, every
 * restart; a census that asks docker once per container is a machine busy
 * watching itself; a perimeter that fails open is the hole the perimeter
 * closes; and an echo home cannot check is a placement home never opens.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  PERIMETER_FAILURES_MAX,
  parseRemoteKernelsReply,
  parseRemoteKernelsRequest,
  remoteRevisionDigest,
  type RemoteKernelsReply,
  type RemotePlacementIntent,
} from '../shared/remote-kernels.ts'
import { DockerCompetitionRunner, useDockerForCompetitions } from '../server/src/competitions/docker-runner.ts'
import { CLASS_KERNEL_LABEL, machineRoomContainer, machineRoomRunArgs } from '../server/src/kernel/room-spec.ts'
import { machinePerimeter, profileFor } from '../server/src/kernel/perimeter-core.ts'
import { INSTANCE_LABEL, revisionImage } from '../server/src/runner-agent/images.ts'
import {
  CANARY_CHECKS,
  KERNEL_TIMINGS,
  KernelHost,
  canaryScript,
  hostNetworkOf,
  parseCanary,
  parsePort,
  specDigest,
  startFailureOf,
  type KernelHostOptions,
} from '../server/src/runner-agent/kernels.ts'
import { cardReport, pickWholeCard, type CardRun, type ProbedCard } from '../server/src/runner-agent/machine.ts'
import { dropPlacement, readPlacements, stateLayout, writePlacement } from '../server/src/runner-agent/state.ts'
import { TEST_ROOT } from './_env.mts'
import { LAYERS, REVISION, classContainer, fakeAgentDocker, type FakeAgentDocker } from './_runner-agent-home.mts'

/* ---------------------------------------------------------------- fixtures */

const SCOPE = machinePerimeter(INSTANCE_LABEL)
const TOKEN = 'e'.repeat(40)

function intent(partial: Partial<RemotePlacementIntent> = {}): RemotePlacementIntent {
  return {
    key: 's1:room', gen: 1, environment: 'base', revision: { id: REVISION.id, ref: REVISION.ref, layers: LAYERS },
    memoryMb: 4096, cpus: 2, pids: 512, gpu: false, network: 'blocked', blockedCidrs: [], token: TOKEN, hashSeed: 7, shm: '1g',
    ...partial,
  }
}

/** A reply's block as the agent's parser takes it: what a test writes must be what home may send. */
function reply(placements: RemotePlacementIntent[], partial: Partial<RemoteKernelsReply> = {}): RemoteKernelsReply {
  return parseRemoteKernelsReply({
    placements, pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [],
    rates: { classBulkMBps: 4, machinePaceMBps: 6 }, tunnel: 'open', ...partial,
  })
}

/** What the host says in a sync, through home's own strict parser: a field it may not carry fails the test that said it. */
function said(host: KernelHost) {
  return parseRemoteKernelsRequest({ placements: host.held(), reports: [], epochs: [], readings: host.readingsNow(), tunnel: 'down', classes: host.facts() })
}

/** The agent's images, as the host asks them: ready by the book, verified, a problem said. */
function fakeImages(events: string[]) {
  const images = {
    ready: new Set<string>([REVISION.id]),
    problems: new Map<string, string>(),
    async verify(revision: { id: string }) {
      events.push('verify')
      return images.ready.has(revision.id) ? revisionImage(revision.id) : null
    },
    isReady: (id: string) => images.ready.has(id),
    problemWith: (id: string) => images.problems.get(id) ?? null,
    readyIds: () => [...images.ready],
  }
  return images
}

/** One step of what docker was asked, in words a test compares. */
function step(args: string[]): string {
  if (args[0] === 'run' && args.includes('--privileged')) return 'helper'
  if (args[0] === 'run' && args.some((arg) => arg.startsWith('colloq-runner-canary-'))) return 'canary'
  if (args[0] === 'run' && args.includes(CLASS_KERNEL_LABEL)) return 'run'
  if (args[0] === 'inspect' && args[1] === '--type' && args[4]?.startsWith('{{.Id}}')) return 'inspect name'
  if (args[0] === 'inspect' && args[1] === '--format' && args[2]?.startsWith('{{.Name}}')) return 'census inspect'
  if (args[0] === 'start' || args[0] === 'port') return args[0]
  return args.slice(0, 2).join(' ')
}

interface Rig {
  host: KernelHost
  layout: ReturnType<typeof stateLayout>
  docker: FakeAgentDocker
  images: ReturnType<typeof fakeImages>
  clock: { now: number }
  events: string[]
  logs: string[]
  state: { disk: number | null; cards: ProbedCard[]; runs: CardRun[]; heard: number; probes: number; diskLow: number; probe: (port: number, token: string, signal: AbortSignal) => Promise<boolean> }
}

/** A host on a tree of its own, a fake docker, the agent's images, and a clock its waits advance. */
function rig(partial: Partial<KernelHostOptions> = {}, shared?: Pick<Rig, 'layout' | 'docker' | 'clock'>): Rig {
  const layout = shared?.layout ?? stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'host-')))
  const docker = shared?.docker ?? fakeAgentDocker()
  const clock = shared?.clock ?? { now: 1_800_000_000_000 }
  const events: string[] = []
  const logs: string[] = []
  const images = fakeImages(events)
  docker.intercept = (args) => {
    events.push(step(args))
  }
  const state: Rig['state'] = { disk: 500_000, cards: [], runs: [], heard: clock.now, probes: 0, diskLow: 0, probe: async () => true }
  const host: KernelHost = new KernelHost({
    layout, docker, images, container: 'colloq-runner', image: null, env: {},
    cards: () => state.cards,
    cardRuns: () => [...state.runs, ...host.cardRuns()],
    heldGpus: () => ({}),
    diskFreeMb: () => state.disk,
    diskFloorMb: 8192,
    onDiskLow: () => state.diskLow++,
    heardAt: () => state.heard,
    onChange: () => undefined,
    log: (line) => logs.push(line),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms
    },
    probe: async (port, token, signal) => {
      state.probes++
      return state.probe(port, token, signal)
    },
    ...partial,
    // The host's own beat never fires by the wall clock here: a test calls tick() and census() itself.
    timings: { censusMs: 3_600_000, ...partial.timings },
  })
  return { host, layout, docker, images, clock, events, logs, state }
}

/** The host once home has spoken of classes: its facts found out, the perimeter in place, the canary passed. */
async function activated(partial: Partial<KernelHostOptions> = {}): Promise<Rig> {
  const r = rig(partial)
  r.host.reconcile(reply([]))
  await r.host.idle()
  assert.deepEqual(r.host.facts(), { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false })
  r.events.length = 0
  return r
}

/** A placement ready on a host, and the container docker made for it. */
async function ready(r: Rig, wanted: RemotePlacementIntent[] = [intent()]): Promise<void> {
  r.host.reconcile(reply(wanted))
  await r.host.idle()
  for (const placement of wanted) assert.equal(r.host.held().find((held) => held.key === placement.key)?.phase, 'ready', r.logs.join('\n'))
}

const nameOf = (key: string): string => {
  const [sessionId, role] = key.split(':') as [string, 'room' | 'own' | 'council']
  return machineRoomContainer(INSTANCE_LABEL, sessionId, role)
}

/* ------------------------------------------------------------------- start */

test('a class container starts in the order of §7.2, and is said ready with the echoes home checks', async () => {
  const r = await activated()
  // The perimeter's minute is over: this start puts it in place again before docker runs anything.
  r.clock.now += KERNEL_TIMINGS.recheckMs
  await ready(r)
  const order = r.events.filter((event) => ['verify', 'network inspect', 'helper', 'inspect name', 'run', 'port'].includes(event))
  assert.deepEqual(order, ['verify', 'network inspect', 'helper', 'inspect name', 'run', 'port'], r.events.join(' · '))

  const container = r.docker.classes.get(nameOf('s1:room'))!
  const held = said(r.host).placements
  assert.deepEqual(held, [{ key: 's1:room', gen: 1, phase: 'ready', container: container.id, revision: remoteRevisionDigest(REVISION.ref) }])
  assert.notEqual(held[0]!.revision, revisionImage(REVISION.id), 'the echo is the pin\'s digest, never a docker name')
  // Home's own argv, laid out by room-spec.ts for this machine, flag for flag.
  assert.deepEqual(container.args, machineRoomRunArgs({
    role: 'room', sessionId: 's1', environment: 'base', image: revisionImage(REVISION.id), mount: path.join(r.layout.roomsDir, 's1'), extraMounts: [],
    gpu: null, memoryMb: 4096, cpus: 2, pids: 512, mode: 'blocked', profile: '1', token: TOKEN, hashSeed: 7, shm: '1g',
  }, { instanceLabel: INSTANCE_LABEL, gen: 1 }))
  assert.ok(container.labels.includes('colloq.placement=s1:room:1') && container.labels.includes(INSTANCE_LABEL) && container.labels.includes(CLASS_KERNEL_LABEL))
  // Written down, under its slot's name, with what docker made of it.
  assert.ok(fs.existsSync(path.join(r.layout.placementsDir, 's1-room.json')))
  const [record] = readPlacements(r.layout)
  assert.equal(record!.container, container.id)
  assert.equal(record!.image, revisionImage(REVISION.id))
  assert.equal(record!.spec, specDigest(intent(), 'blocked'))
  assert.deepEqual(record!.limits, { memoryMb: 4096, cpus: 2 })
  assert.equal(fs.statSync(path.join(r.layout.placementsDir, 's1-room.json')).mode & 0o777, 0o600)
  // The class folder: made empty, uid 1000's, 2775 as home's sessionDir makes it.
  const folder = fs.statSync(path.join(r.layout.roomsDir, 's1'))
  assert.ok(folder.isDirectory())
  assert.equal(folder.mode & 0o777, 0o775)
  if (process.platform === 'linux') assert.equal(folder.mode & 0o2000, 0o2000)
  assert.deepEqual(fs.readdirSync(path.join(r.layout.roomsDir, 's1')), [])
  // What it holds is out of `free`, as an attempt's is; the tunnel finds its port and nothing else.
  assert.deepEqual(r.host.holding(), [{ memoryMb: 4096, cpus: 2 }])
  assert.deepEqual(r.host.resolve('s1:room', 1), { port: container.port })
  assert.deepEqual(r.host.resolve('s1:room', 0), { refused: 'stale' })
  assert.deepEqual(r.host.resolve('s1:room', 2), { refused: 'starting' })
  assert.deepEqual(r.host.resolve('s1:own', 1), { refused: 'gone' })
  assert.deepEqual(r.host.counts(), { room: 1, own: 0, council: 0 })
})

test('the ready echo is the digest of the revision the container was made from, whatever a later intent of its gen says', async () => {
  const r = await activated()
  await ready(r)
  r.events.length = 0
  // An intent of the same gen naming another pin: the live container is no other image for it, and home's check says so.
  const repinned = `ghcr.io/colloq-edu/colloq-kernel@sha256:${'9'.repeat(64)}`
  r.host.reconcile(reply([intent({ revision: { id: REVISION.id, ref: repinned, layers: LAYERS } })]))
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.revision, remoteRevisionDigest(REVISION.ref))
  assert.equal(readPlacements(r.layout)[0]!.intent.revision.ref, REVISION.ref, 'the record forgot what its container runs')
  assert.ok(!r.events.includes('run'), 'a live container was recreated for a new pin')
})

test('a placement waits pulling for its revision, says the image\'s own problem, and starts once the revision is ready', async () => {
  const r = await activated()
  r.images.ready.clear()
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  assert.deepEqual(said(r.host).placements, [{ key: 's1:room', gen: 1, phase: 'pulling' }])
  assert.ok(!r.events.includes('verify') && !r.events.includes('run'), 'a start went on without its image')
  r.images.problems.set(REVISION.id, 'docker pull failed: manifest unknown')
  r.host.imagesChanged()
  const failed = said(r.host).placements[0]!
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.failure!.unschedulable, 'other')
  assert.match(failed.failure!.detail!, /manifest unknown/)
  // Pulled at last: what waited starts by itself.
  r.images.problems.clear()
  r.images.ready.add(REVISION.id)
  r.host.imagesChanged()
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.phase, 'ready')
})

test('below the disk\'s floor with room for the class folder nothing is fenced or run, and the disk is asked to make room', async () => {
  const r = await activated()
  // Above the floor, short of the folder's room.
  r.state.disk = 8192 + 512
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  const held = said(r.host).placements[0]!
  assert.equal(held.phase, 'failed')
  assert.equal(held.failure!.unschedulable, 'other')
  assert.match(held.failure!.detail!, /floor/)
  assert.deepEqual(r.events, ['verify'], 'something came after the disk said no')
  assert.equal(r.state.diskLow, 1)
  // Tried again only after its wait, while home still asks.
  r.state.disk = 500_000
  await r.host.tick()
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.phase, 'failed', 'a failed start was tried again before its wait')
  r.clock.now += KERNEL_TIMINGS.retryMs.first
  await r.host.tick()
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.phase, 'ready')
})

test('a GPU room takes a whole card no run holds, before its perimeter, and every share of it is busy for submissions', async () => {
  const r = await activated()
  r.state.cards = [{ device: '0', name: 'RTX 4090', memoryMb: 24_564 }, { device: '1', name: 'RTX 4090', memoryMb: 24_564 }]
  // A submission's run on card 0, at two a card: half of it.
  r.state.runs = [{ device: '0', perDevice: 2 }]
  await ready(r, [intent({ gpu: true })])
  const container = r.docker.classes.get(nameOf('s1:room'))!
  assert.ok(container.args.includes('device=1') && container.args.includes('colloq.gpu=1') && container.args.includes('--shm-size=1g'), container.args.join(' '))
  assert.deepEqual(r.host.cardRuns(), [{ device: '1', perDevice: 1 }])
  assert.deepEqual(said(r.host).placements[0]!.card, { device: '1', usedMb: null })
  // The sync's cards: card 1 has every share busy, and only card 0's last share is free.
  const report = cardReport(r.state.cards, 2, [...r.state.runs, ...r.host.cardRuns()], {}, r.host.wholeCards())
  assert.deepEqual(report.cards.map((card) => [card.device, card.busyShares]), [['0', 1], ['1', 2]])
  assert.equal(report.freeShares, 1)
  assert.equal(pickWholeCard(r.state.cards, [...r.state.runs, ...r.host.cardRuns()]), null, 'a card with a run on it was free for a class')

  // A second GPU class: no card is free of everything, and nothing is fenced or run for it.
  r.events.length = 0
  r.clock.now += KERNEL_TIMINGS.recheckMs
  r.host.reconcile(reply([intent({ gpu: true }), intent({ key: 's2:room', gpu: true })]))
  await r.host.idle()
  const second = said(r.host).placements.find((held) => held.key === 's2:room')!
  assert.equal(second.phase, 'failed')
  assert.equal(second.failure!.unschedulable, 'gpu')
  assert.ok(!r.events.includes('helper') && !r.events.includes('run'), r.events.join(' · '))
  // Gone, the room's card is free again.
  r.host.reconcile(reply([]))
  await r.host.idle()
  assert.deepEqual(r.host.cardRuns(), [])
})

test('a perimeter that is not in place fails the start closed, and says why in the facts', async () => {
  for (const [code, perimeter] of [[21, 'no-iptables'], [20, 'no-dockerd'], [22, 'refused']] as const) {
    const r = rig()
    r.docker.perimeter = { code, out: 'colloq-perimeter: no DOCKER-USER chain' }
    r.host.reconcile(reply([intent()]))
    await r.host.idle()
    assert.equal(r.host.facts().perimeter, perimeter)
    const held = said(r.host).placements[0]!
    assert.equal(held.phase, 'failed')
    assert.match(held.failure!.detail!, /perimeter/)
    assert.ok(!r.events.includes('run'), `a container ran without its perimeter (exit ${code})`)
  }
  // No image of the agent's own to run the helper from: refused, never a kernel image's.
  const bare = rig({ container: null, image: null })
  bare.host.reconcile(reply([intent()]))
  await bare.host.idle()
  assert.equal(bare.host.facts().perimeter, 'refused')
  assert.ok(!bare.events.includes('helper') && !bare.events.includes('run'))
})

test('the helper runs from the agent\'s own image by its id, with home\'s floor and the machine\'s own ranges on the agent\'s bridge and chains', async () => {
  const r = rig({ env: { KERNEL_BLOCKED_CIDRS: '198.51.100.0/24' } })
  r.host.reconcile(reply([intent({ blockedCidrs: ['203.0.113.0/24'] })]))
  await r.host.idle()
  const helper = r.docker.calls.find((args) => args[0] === 'run' && args.includes('--privileged'))!
  assert.equal(helper[helper.indexOf('--entrypoint=sh') + 1], r.docker.selfImage)
  const script = r.docker.helperScripts.at(-1)!
  for (const range of ['203.0.113.0/24', '198.51.100.0/24']) assert.ok(script.includes(`-d ${range} -j ${SCOPE.chains}-DENY`), range)
  assert.ok(script.includes(`-s ${r.docker.networks.get(SCOPE.network)}`), 'the rules fence another subnet than the bridge has')
  assert.ok(script.includes(`--comment ${SCOPE.tag}`) && !script.includes('COLLOQ-ROOMS'), 'the machine\'s rules went under home\'s names')
  // The bridge is the agent's own, made with its labels.
  const made = r.docker.calls.find((args) => args[0] === 'network' && args[1] === 'create')!
  assert.equal(made.at(-1), SCOPE.network)
  assert.ok(made.includes(INSTANCE_LABEL) && made.includes('com.docker.network.bridge.enable_icc=false'))
  // Home's `none` is the floor: the whole plan goes `none`, and the container resolves nowhere.
  const strict = rig()
  await ready(strict, [intent({ network: 'none' })])
  const subnet = strict.docker.networks.get(SCOPE.network)
  assert.ok(strict.docker.helperScripts.at(-1)!.includes(`-A ${SCOPE.chains}-FWD -s ${subnet} -j ${SCOPE.chains}-DENY`), 'no `none` rules')
  assert.ok(!strict.docker.helperScripts.at(-1)!.includes('--dport 53'), 'a `none` plan let DNS out')
  assert.ok(strict.docker.classes.get(nameOf('s1:room'))!.args.includes('--dns=192.0.2.1'))
  // The facts' mode is the machine's own floor, not the last plan's: home's mode rides each intent, and a `none` home must not
  // find every `blocked` machine short of its floor before it ever placed a class there.
  assert.equal(strict.host.facts().mode, 'blocked')
  const own = rig({ env: { COLLOQ_ROOM_NETWORK: 'none' } })
  assert.equal(own.host.facts().mode, 'none', 'a machine whose owner keeps classes off the internet said otherwise before any intent')
})

/* -------------------------------------------------------------- readiness */

test('ready is an authenticated GET /api/status on the host\'s loopback: a wrong token is never ready', async () => {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.url} ${req.headers.authorization}`)
    res.statusCode = req.url === '/api/status' && req.headers.authorization === `token ${TOKEN}` ? 200 : 403
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  try {
    // The probe the agent ships (no stand-in): fetch to the port docker publishes.
    const r = rig({ probe: undefined })
    r.docker.nextPort = port
    await ready(r)
    assert.deepEqual(hits, [`/api/status token ${TOKEN}`])
    // Another token than the container's: 403 every time, until its 90 s are up.
    const wrong = rig({ probe: undefined, timings: { readyMs: 2_000, readyPollMs: 500 } })
    wrong.docker.nextPort = port
    wrong.host.reconcile(reply([intent({ token: 'f'.repeat(40) })]))
    await wrong.host.idle()
    const held = said(wrong.host).placements[0]!
    assert.equal(held.phase, 'failed')
    assert.match(held.failure!.detail!, /did not answer within 2 s/)
    assert.ok(hits.filter((hit) => hit.endsWith('ffff')).length >= 4)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a Jupyter that never answers fails its start after 90 s by the clock, and nothing of it is left behind', async () => {
  const r = await activated()
  r.state.probe = async () => false
  const began = r.clock.now
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  const held = said(r.host).placements[0]!
  assert.equal(held.phase, 'failed')
  assert.equal(held.failure!.unschedulable, 'other')
  assert.match(held.failure!.detail!, /did not answer within 90 s/)
  assert.ok(r.clock.now - began >= KERNEL_TIMINGS.readyMs, 'gave up before its time')
  assert.equal(r.state.probes, KERNEL_TIMINGS.readyMs / KERNEL_TIMINGS.readyPollMs + 1)
  assert.equal(r.docker.classes.size, 0, 'the container of a failed start stayed')
  assert.deepEqual(readPlacements(r.layout), [])
  assert.deepEqual(r.host.holding(), [], 'a failed start holds memory')
})

test('a container that ends while starting is said at once, out of memory as such, not after a minute and a half', async () => {
  const r = await activated()
  r.state.probe = async () => {
    const container = r.docker.classes.get(nameOf('s1:room'))!
    Object.assign(container, { status: 'exited', exit: 137, oomKilled: true, logs: ['[I ServerApp] Jupyter Server 2.14 is running', 'Killed'] })
    return false
  }
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  const held = said(r.host).placements[0]!
  assert.equal(held.phase, 'failed')
  assert.deepEqual({ ...held.failure, detail: undefined }, { unschedulable: 'memory', memoryMb: 4096, detail: undefined })
  assert.match(held.failure!.detail!, /ended while starting \(exited 137, out of memory\): Killed/)
  assert.ok(r.state.probes <= 4, `${r.state.probes} probes of a dead container`)
})

/* ------------------------------------------------------------- failures */

test('a docker run that fails is said in the broker\'s words, its detail cut to a reason\'s length', async () => {
  const words = (out: string) => startFailureOf({ code: 125, out }, { memoryMb: 4096, cpus: 2 })
  assert.deepEqual(words('docker: Error response from daemon: Range of CPUs is from 0.01 to 4.00, as there are only 4 CPUs available.'), {
    unschedulable: 'cpu', cpus: 2, detail: 'docker run: docker: Error response from daemon: Range of CPUs is from 0.01 to 4.00, as there are only 4 CPUs available.',
  })
  assert.equal(words('docker: Error response from daemon: Minimum memory limit allowed is 6MB.').unschedulable, 'memory')
  assert.equal(words('docker: Error response from daemon: Minimum memory limit allowed is 6MB.').memoryMb, 4096)
  assert.equal(words('docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].').unschedulable, 'gpu')
  assert.equal(words('docker: Error response from daemon: failed to create task: unknown.').unschedulable, 'other')

  const r = await activated()
  r.docker.runFails = { code: 125, out: `docker: Error response from daemon: Range of CPUs is from 0.01 to 1.00, as there are only 1 CPUs available.${' x'.repeat(400)}` }
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  const held = said(r.host).placements[0]!
  assert.equal(held.failure!.unschedulable, 'cpu')
  assert.equal(held.failure!.cpus, 2)
  assert.ok(held.failure!.detail!.length <= 300)
  assert.deepEqual(readPlacements(r.layout), [], 'a run that failed left its record')
})

/* ------------------------------------------------------------ stop, resize */

/** A probe that hangs, as a Jupyter still coming up does, until its start is given up; `probed` says it was reached. */
function hanging(r: Rig, times = Infinity): { probed: Promise<void> } {
  let reached!: () => void
  const probed = new Promise<void>((resolve) => (reached = resolve))
  let left = times
  r.state.probe = (_port, _token, signal) => {
    if (left-- <= 0) return Promise.resolve(true)
    reached()
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }))
  }
  return { probed }
}

test('a removal that arrives during a start is finished by the start: what it made goes, and nothing starts again', async () => {
  const r = await activated()
  const first = hanging(r)
  r.host.reconcile(reply([intent()]))
  await first.probed
  assert.equal(r.docker.classes.size, 1)
  r.host.reconcile(reply([]))
  await r.host.idle()
  assert.equal(r.docker.classes.size, 0)
  assert.deepEqual(said(r.host).placements, [])
  assert.deepEqual(readPlacements(r.layout), [])
  assert.equal(r.events.filter((event) => event === 'run').length, 1, 'a start went again after it was given up')
  assert.ok(r.logs.some((line) => /start was given up/.test(line)))

  // Another gen arriving during a start: the old one gives up, then the new one starts, under the same name.
  const second = hanging(r, 1)
  r.host.reconcile(reply([intent()]))
  await second.probed
  r.host.reconcile(reply([intent({ gen: 2 })]))
  await r.host.idle()
  assert.deepEqual(said(r.host).placements.map((entry) => [entry.key, entry.gen, entry.phase]), [['s1:room', 2, 'ready']])
  assert.ok(r.docker.classes.get(nameOf('s1:room'))!.labels.includes('colloq.placement=s1:room:2'))
  assert.equal(readPlacements(r.layout)[0]!.intent.gen, 2)
})

test('a live container is resized with docker update, memory and swap together; a gone one is absent, a refused size waits for its next start', async () => {
  const r = await activated()
  await ready(r)
  r.events.length = 0
  r.host.reconcile(reply([intent({ memoryMb: 8192, cpus: 4 })]))
  await r.host.idle()
  const update = r.docker.calls.filter((args) => args[0] === 'update').at(-1)!
  assert.deepEqual(update.slice(0, 4), ['update', '--memory=8192m', '--memory-swap=8192m', '--cpus=4'])
  assert.equal(said(r.host).placements[0]!.resized, 'applied')
  assert.deepEqual(r.host.holding(), [{ memoryMb: 8192, cpus: 4 }])
  assert.deepEqual(readPlacements(r.layout)[0]!.limits, { memoryMb: 8192, cpus: 4 })
  assert.ok(!r.events.includes('run'), 'a resize recreated the container')

  // Docker keeps the old numbers (lower than in use): pending, and not asked again for the same.
  r.docker.intercept = (args) => (args[0] === 'update' ? { code: 1, out: 'Error response from daemon: Cannot update container: memory limit should be larger than usage' } : undefined)
  r.host.reconcile(reply([intent({ memoryMb: 1024, cpus: 4 })]))
  await r.host.idle()
  r.host.reconcile(reply([intent({ memoryMb: 1024, cpus: 4 })]))
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.resized, 'pending')
  assert.equal(r.docker.calls.filter((args) => args[0] === 'update').length, 2)
  assert.deepEqual(r.host.holding(), [{ memoryMb: 8192, cpus: 4 }], 'a refused resize changed what is held')

  // The container is gone: absent, and started again with the numbers home wants.
  r.docker.intercept = null
  r.docker.classes.clear()
  r.host.reconcile(reply([intent({ memoryMb: 2048, cpus: 2 })]))
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.phase, 'ready')
  assert.equal(r.docker.classes.get(nameOf('s1:room'))!.memoryMb, 2048)
})

test('a placement home no longer names is removed with its record, and the class folder stays for its next start', async () => {
  const r = await activated()
  await ready(r)
  fs.writeFileSync(path.join(r.layout.roomsDir, 's1', 'out.csv'), 'a,b\n')
  r.host.reconcile(reply([]))
  await r.host.idle()
  assert.equal(r.docker.classes.size, 0)
  assert.deepEqual(said(r.host).placements, [])
  assert.deepEqual(readPlacements(r.layout), [])
  assert.deepEqual(r.host.holding(), [])
  assert.ok(fs.existsSync(path.join(r.layout.roomsDir, 's1', 'out.csv')), 'a stop took the warm copy')
})

/* ---------------------------------------------------------------- adoption */

test('after the agent\'s restart its class containers are adopted as they run, and only what no record names goes', async () => {
  const first = await activated()
  await ready(first, [intent(), intent({ key: 's1:own', memoryMb: 8192 })])
  const room = first.docker.classes.get(nameOf('s1:room'))!
  first.host.stop()
  // Left by others: a container of no placement, one of a gen no record has, and a record whose container is gone.
  classContainer(first.docker, { name: nameOf('ghost:room'), labels: [CLASS_KERNEL_LABEL, INSTANCE_LABEL, 'colloq.placement=ghost:room:1'] })
  first.docker.classes.get(nameOf('s1:own'))!.labels = [CLASS_KERNEL_LABEL, INSTANCE_LABEL, 'colloq.placement=s1:own:7']
  // Another tree's class container on the same daemon is that agent's, never this one's.
  const theirs = classContainer(first.docker, { name: 'colloq-class-ffffff-s9-room', labels: [CLASS_KERNEL_LABEL, 'ru.colloq.competition-instance=ffffffffffffffff', 'colloq.placement=s9:room:1'] })

  const second = rig({}, first)
  await second.host.adopt()
  assert.deepEqual(said(second.host).placements, [{ key: 's1:room', gen: 1, phase: 'ready', container: room.id, revision: remoteRevisionDigest(REVISION.ref) }])
  assert.deepEqual(second.host.resolve('s1:room', 1), { port: room.port })
  assert.deepEqual([...second.docker.classes.keys()].sort(), [nameOf('s1:room'), theirs.name].sort())
  assert.deepEqual(readPlacements(second.layout).map((record) => record.intent.key), ['s1:room'])
  assert.deepEqual(second.host.holding(), [{ memoryMb: 4096, cpus: 2 }], 'an adopted kernel holds nothing before home speaks')
  // Home names it again at its gen: kept as it runs, its Python with it.
  second.host.reconcile(reply([intent()]))
  await second.host.idle()
  assert.ok(!second.events.includes('run') && !second.events.includes('start'), second.events.join(' · '))
  assert.equal(said(second.host).placements[0]!.container, room.id)
})

test('before home has said anything of its classes in this life, an adopted kernel is kept through every beat', async () => {
  const first = await activated()
  await ready(first)
  first.host.stop()
  const room = first.docker.classes.get(nameOf('s1:room'))!
  const second = rig({}, first)
  await second.host.adopt()
  // Home is away: beats come and go, the census measures, and nothing is removed for a reply that never came.
  for (let beat = 0; beat < 3; beat++) {
    second.clock.now += KERNEL_TIMINGS.censusMs
    await second.host.tick()
    await second.host.idle()
  }
  assert.equal(second.docker.classes.get(nameOf('s1:room')), room)
  assert.equal(said(second.host).placements[0]!.phase, 'ready')
  assert.equal(readPlacements(second.layout).length, 1)
  assert.ok(!second.docker.calls.some((args) => args[0] === 'rm' && args.includes(nameOf('s1:room'))))
})

test('an adopted container that exited is started again as it was for the same spec, and made anew for another', async () => {
  const first = await activated()
  await ready(first)
  first.host.stop()
  const room = first.docker.classes.get(nameOf('s1:room'))!
  room.status = 'exited'
  const second = rig({}, first)
  await second.host.adopt()
  assert.equal(said(second.host).placements[0]!.phase, 'starting')
  second.host.reconcile(reply([intent()]))
  await second.host.idle()
  assert.ok(second.events.includes('start'), second.events.join(' · '))
  assert.ok(!second.events.includes('run'))
  assert.equal(second.docker.classes.get(nameOf('s1:room'))!.id, room.id, 'the container the packages were installed in was recreated')
  assert.equal(said(second.host).placements[0]!.phase, 'ready')

  // Exited again, and home's spec for the gen is another (its process ceiling): the old container goes, a new one is made.
  second.host.stop()
  second.docker.classes.get(nameOf('s1:room'))!.status = 'exited'
  const third = rig({}, first)
  await third.host.adopt()
  third.host.reconcile(reply([intent({ pids: 1024 })]))
  await third.host.idle()
  assert.ok(third.events.includes('run'))
  assert.notEqual(third.docker.classes.get(nameOf('s1:room'))!.id, room.id)
})

test('a docker that does not list at the start keeps the records, and a running kernel is taken as it is, never removed on a guess', async () => {
  const first = await activated()
  await ready(first)
  first.host.stop()
  const room = first.docker.classes.get(nameOf('s1:room'))!
  const second = rig({}, first)
  let refuse = true
  let slow = 1
  second.docker.intercept = (args) => {
    second.events.push(step(args))
    if (refuse && args[0] === 'ps') return { code: 1, out: 'Cannot connect to the Docker daemon' }
    // And the look by its name, once: a daemon that did not say is no "none".
    if (step(args) === 'inspect name' && slow-- > 0) return { code: 1, out: 'Error response from daemon: context deadline exceeded' }
  }
  const before = second.docker.calls.length
  await second.host.adopt()
  assert.equal(readPlacements(second.layout).length, 1, 'a record went for a docker that did not answer')
  refuse = false
  second.host.reconcile(reply([intent()]))
  await second.host.idle()
  const failed = said(second.host).placements[0]!
  assert.equal(failed.phase, 'failed')
  assert.match(failed.failure!.detail!, /docker did not answer/)
  second.clock.now += KERNEL_TIMINGS.retryMs.first
  await second.host.tick()
  await second.host.idle()
  assert.equal(second.docker.classes.get(nameOf('s1:room'))!.id, room.id)
  assert.ok(!second.docker.calls.slice(before).some((args) => (args[0] === 'rm' && args.some((arg) => arg === room.id || arg === nameOf('s1:room'))) || step(args) === 'run'), 'a running kernel was removed or made anew')
  assert.equal(said(second.host).placements[0]!.phase, 'ready')
})

test('the 0.23 sweeps never touch class containers: the Docker runner\'s and the agent\'s own go by labels a class container never has', async () => {
  const r = await activated()
  await ready(r)
  const room = r.docker.classes.get(nameOf('s1:room'))!
  useDockerForCompetitions((args, timeoutMs) => r.docker(args, { timeoutMs }))
  try {
    assert.equal(await new DockerCompetitionRunner().sweep(), 0)
  } finally {
    useDockerForCompetitions(null)
  }
  assert.equal(r.docker.classes.get(nameOf('s1:room')), room, 'the Docker runner\'s sweep took a class container')
  for (const label of ['colloq.kind=competition-run', 'colloq.kind=competition-score', 'colloq.kind=runner-check']) assert.ok(!room.labels.includes(label), label)
})

/* ----------------------------------------------------------------- census */

test('the census asks docker once for all class containers, and an exec of each one\'s counters at most once a minute', async () => {
  const r = await activated()
  await ready(r, [intent(), intent({ key: 's1:own', memoryMb: 8192, cpus: 4 }), intent({ key: 's2:room' })])
  Object.assign(r.docker.classes.get(nameOf('s1:own'))!, { usedMb: 3100, cpuPercent: 12.4, kills: 2 })
  r.events.length = 0
  await r.host.census()
  assert.equal(r.events.filter((event) => event === 'census inspect').length, 1)
  assert.equal(r.events.filter((event) => event.startsWith('stats')).length, 1)
  const inspect = r.docker.calls.find((args) => step(args) === 'census inspect')!
  assert.deepEqual(inspect.slice(3).sort(), [nameOf('s1:own'), nameOf('s1:room'), nameOf('s2:room')].sort())
  assert.equal(r.events.filter((event) => event.startsWith('exec')).length, 3)
  const own = said(r.host).placements.find((held) => held.key === 's1:own')!
  assert.deepEqual({ ...own.usage, startedAt: 0 }, { usedMb: 3100, limitMb: 8192, cpus: 4, cpuPercent: 12, startedAt: 0, oomKills: 2 })
  assert.ok(own.usage!.startedAt > 0)
  // The next beat, within the minute: the batched pair again, no exec.
  r.events.length = 0
  r.clock.now += KERNEL_TIMINGS.censusMs
  await r.host.census()
  assert.deepEqual(r.events.filter((event) => !event.startsWith('exec')).sort(), ['census inspect', 'stats --no-stream'])
  assert.ok(!r.events.some((event) => event.startsWith('exec')))
  r.clock.now += KERNEL_TIMINGS.countersMs
  await r.host.census()
  assert.equal(r.events.filter((event) => event.startsWith('exec')).length, 3)
})

test('a GPU room\'s card memory comes with its counters', async () => {
  const r = await activated()
  r.state.cards = [{ device: '0', name: 'RTX 4090', memoryMb: 24_564 }]
  await ready(r, [intent({ gpu: true })])
  r.docker.classes.get(nameOf('s1:room'))!.cardMb = 1200
  await r.host.census()
  assert.deepEqual(said(r.host).placements[0]!.card, { device: '0', usedMb: 1200 })
})

test('a container the census finds dead is read for home, started again at its gen, and home\'s next question gets what it said dying', async () => {
  const r = await activated()
  await ready(r)
  const room = r.docker.classes.get(nameOf('s1:room'))!
  Object.assign(room, { status: 'exited', exit: 137, oomKilled: true, logs: ['Killed'] })
  r.events.length = 0
  await r.host.census()
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.phase, 'ready')
  assert.ok(r.events.includes('start') && !r.events.includes('run'), r.events.join(' · '))
  assert.equal(r.docker.classes.get(nameOf('s1:room'))!.id, room.id)
  // Started again, docker forgot the death (a new cgroup, the flag reset): home's question is answered with the reading taken then.
  Object.assign(room, { oomKilled: false, exit: 0, logs: [] })
  r.host.reconcile(reply([intent()], { postmortem: ['s1:room'] }))
  await r.host.idle()
  const [dying] = said(r.host).readings
  assert.deepEqual({ key: dying!.key, gen: dying!.gen, status: dying!.reading.status, exit: dying!.reading.exit, oom: dying!.reading.containerOomKilled, tail: dying!.reading.tail },
    { key: 's1:room', gen: 1, status: 'exited', exit: 137, oom: true, tail: ['Killed'] })
  // A later question reads the container as it is.
  r.host.readingsSaid(r.host.readingsNow())
  r.clock.now += 10_000
  r.host.reconcile(reply([intent()], { postmortem: ['s1:room'] }))
  await r.host.idle()
  assert.equal(said(r.host).readings[0]!.reading.status, 'running')
})

test('home\'s post-mortem question is answered by home\'s own three questions, said until a sync carried it, and asked at most every few seconds', async () => {
  const r = await activated()
  await ready(r)
  Object.assign(r.docker.classes.get(nameOf('s1:room'))!, { kills: 1, logs: ['x'.repeat(900), 'KernelRestarter: restarting kernel'] })
  const before = r.docker.calls.length
  r.host.reconcile(reply([intent()], { postmortem: ['s1:room', 's7:room'] }))
  await r.host.idle()
  const asked = r.docker.calls.slice(before).map((args) => args[0])
  assert.deepEqual(['inspect', 'exec', 'logs'].map((command) => asked.filter((entry) => entry === command).length), [1, 1, 1])
  const block = said(r.host)
  assert.equal(block.readings.length, 1, 'a key the machine does not hold was read')
  const { reading } = block.readings[0]!
  assert.equal(reading.kills, 1)
  assert.equal(reading.containerOomKilled, false)
  assert.equal(reading.status, 'running')
  assert.equal(reading.tail.length, 2)
  assert.ok(reading.tail.every((line) => line.length <= 500))
  // Asked again at once: not read again; said until a sync carried it.
  r.host.reconcile(reply([intent()], { postmortem: ['s1:room'] }))
  await r.host.idle()
  assert.equal(r.docker.calls.filter((args) => args[0] === 'logs').length, 1)
  assert.equal(r.host.readingsNow().length, 1)
  r.host.readingsSaid(r.host.readingsNow())
  assert.deepEqual(r.host.readingsNow(), [])
})

/* ------------------------------------------------------------- perimeter */

test('while class containers live the perimeter is installed again every minute, and three failures in a row stop every one of them', async () => {
  const r = await activated()
  await ready(r, [intent(), intent({ key: 's1:own' })])
  const helpers = (): number => r.docker.helperScripts.length
  const before = helpers()
  // Within the minute: no helper.
  await r.host.tick()
  assert.equal(helpers(), before)
  // The minute is up: the rules again, a missing one put back by the same script.
  r.clock.now += KERNEL_TIMINGS.recheckMs
  await r.host.tick()
  assert.equal(helpers(), before + 1)
  // The helper fails: twice is a warning, the third time every class container goes and the facts say `failing`.
  r.docker.perimeter = { code: 22, out: 'colloq-perimeter: iptables-restore refused the rules' }
  for (let round = 1; round <= PERIMETER_FAILURES_MAX; round++) {
    r.clock.now += KERNEL_TIMINGS.recheckMs
    await r.host.tick()
    await r.host.idle()
    if (round < PERIMETER_FAILURES_MAX) assert.equal(r.docker.classes.size, 2, `stopped after ${round}`)
  }
  assert.equal(r.docker.classes.size, 0)
  assert.equal(r.host.facts().perimeter, 'failing')
  assert.deepEqual(said(r.host).placements, [])
  assert.deepEqual(readPlacements(r.layout), [])
  // Nothing starts again on the reply that was in flight while the rules are still refused, and `failing` stays said.
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  assert.equal(r.docker.classes.size, 0)
  assert.equal(r.host.facts().perimeter, 'failing')
  // The rules hold again: `ok`, and home's next ask starts the class anew.
  r.docker.perimeter = { code: 0, out: 'colloq-perimeter: ok' }
  r.clock.now += KERNEL_TIMINGS.retryMs.last
  await r.host.tick()
  await r.host.idle()
  assert.equal(r.host.facts().perimeter, 'ok')
  assert.equal(said(r.host).placements[0]!.phase, 'ready')
})

/* ---------------------------------------------------------------- orphans */

test('home silent about its classes for the idle time stops only containers idle in the census', async () => {
  const r = await activated({ timings: { orphanMs: 120 * 60_000, orphanQuietMs: 5 * 60_000 } })
  await ready(r, [intent(), intent({ key: 's2:room' })])
  r.docker.classes.get(nameOf('s2:room'))!.cpuPercent = 85
  // Heard lately: nothing stops, however idle.
  r.clock.now += 10 * 60_000
  await r.host.census()
  await r.host.orphans()
  assert.equal(r.docker.classes.size, 2)
  // Silent for two hours: the idle one goes, the one computing stays.
  r.clock.now += 120 * 60_000
  await r.host.census()
  await r.host.orphans()
  await r.host.idle()
  assert.deepEqual([...r.docker.classes.keys()], [nameOf('s2:room')])
  assert.ok(r.logs.some((line) => /said nothing of its classes/.test(line)))
  // Its cell ends; once idle long enough in the census, it goes too, and no beat starts it again.
  r.docker.classes.get(nameOf('s2:room'))!.cpuPercent = 0.4
  await r.host.census()
  r.clock.now += 5 * 60_000
  await r.host.census()
  await r.host.tick()
  await r.host.idle()
  assert.equal(r.docker.classes.size, 0)
  await r.host.tick()
  await r.host.idle()
  assert.equal(r.docker.classes.size, 0, 'a beat started what the orphan rule stopped')
})

/* -------------------------------------------------- facts and the canary */

test('the canary\'s word: ok when every check held, the failed ones named otherwise', () => {
  const all = Object.fromEntries(CANARY_CHECKS.map((check) => [check, true]))
  assert.equal(parseCanary(`[I] noise\ncolloq-canary: ${JSON.stringify(all)}\n`), 'ok')
  assert.equal(parseCanary(`colloq-canary: ${JSON.stringify({ ...all, hostRefused: false, ipv6Refused: 'yes' })}`), 'failed: hostRefused, ipv6Refused')
  assert.equal(parseCanary(`colloq-canary: ${JSON.stringify({ uid: true })}`).startsWith('failed: capEff, noNewPrivs'), true)
  assert.match(parseCanary('Traceback (most recent call last):\nPermissionError: denied'), /^failed: the canary said nothing readable \(PermissionError: denied\)$/)
  assert.match(parseCanary('colloq-canary: {not json'), /^failed: the canary said nothing readable/)
  assert.ok(parseCanary(`x\n${'y'.repeat(1000)}`).length <= 300)
})

test('the canary is a Python the class images run, and checks from the inside what §7.6 lists', (t) => {
  const python = spawnSync('python3', ['--version'])
  if (python.error || python.status !== 0) return t.skip('no python3 here')
  const script = canaryScript({ seed: 'abc', ports: [41_001, 41_002], lan: ['192.168.1.10'], state: '/var/lib/colloq-runner' })
  // Parsed by Python itself, not run: what it reads exists in a class container, not here.
  const parsed = spawnSync('python3', ['-I', '-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: script })
  assert.equal(parsed.status, 0, parsed.stderr.toString())
  for (const check of CANARY_CHECKS) assert.ok(script.includes(`r["${check}"]`), check)
  for (const needle of ['169.254.169.254', '/var/run/docker.sock', '/var/lib/colloq-runner', '192.168.1.10', '41001', '41002', 'AF_INET6', '/workspace/canary/seed']) assert.ok(script.includes(needle), needle)
})

test('the canary runs with the class\'s hardening behind the class bridge, and a folder that does not take a file both ways fails it', async () => {
  const r = rig()
  r.docker.canary = { code: 0, out: `colloq-canary: ${JSON.stringify(Object.fromEntries(CANARY_CHECKS.map((check) => [check, true])))}` }
  r.host.reconcile(reply([]))
  await r.host.idle()
  // Its own fake said every check held, and wrote nothing back into the folder: the agent's own look says no.
  assert.equal(r.host.facts().canary, 'failed: folderRoundTrip')
  const canary = r.docker.calls.find((args) => step(args) === 'canary')!
  for (const flag of ['--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never', 'colloq.kind=runner-check', INSTANCE_LABEL]) assert.ok(canary.includes(flag), flag)
  assert.equal(canary[canary.indexOf('--network') + 1], SCOPE.network)
  // One folder in it, the canary's own: no socket, no tree of the agent's.
  assert.deepEqual(canary.flatMap((arg, i) => (canary[i - 1] === '-v' ? [arg.split(':')[1]] : [])), ['/workspace/canary'])
  // No start goes on a canary that failed.
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  const held = said(r.host).placements[0]!
  assert.equal(held.phase, 'failed')
  assert.match(held.failure!.detail!, /canary: failed: folderRoundTrip/)
  assert.ok(!r.docker.calls.some((args) => step(args) === 'run'))
  assert.ok(!fs.readdirSync(r.layout.roomsDir).some((name) => name.startsWith('.canary-')), 'the canary\'s folder stayed')
})

test('host networking is read from the agent\'s own container, and an agent off the host\'s network runs no canary and no class', async () => {
  assert.equal(hostNetworkOf('host\n'), true)
  assert.equal(hostNetworkOf('bridge'), false)
  assert.equal(hostNetworkOf('container:abc'), false)
  const off = rig()
  off.docker.selfNetwork = 'bridge'
  off.host.reconcile(reply([intent()]))
  await off.host.idle()
  assert.equal(off.host.facts().hostNetwork, false)
  assert.match(off.host.facts().canary, /^not run: the agent is not on the host's network/)
  assert.ok(off.docker.calls.some((args) => args.join(' ') === 'inspect --type container --format {{.HostConfig.NetworkMode}} colloq-runner'))
  assert.ok(!off.docker.calls.some((args) => step(args) === 'run' || step(args) === 'canary'))
  // No container of its own (make runner-dev): a process on the host, which is that network.
  const dev = rig({ container: null, image: 'ghcr.io/colloq-edu/colloq-server:0.25.0' })
  dev.host.reconcile(reply([]))
  await dev.host.idle()
  assert.equal(dev.host.facts().hostNetwork, true)
  assert.ok(!dev.docker.calls.some((args) => args[0] === 'inspect' && args[1] === '--type'), 'inspected a container by a name that could be anyone\'s')
  assert.equal(dev.host.facts().canary, 'ok')
})

test('a Colloq home on this docker takes the machine out of classes (D20): no perimeter of the machine\'s on it, no class', async () => {
  // Each sign on its own: its server's container, or — a home on the host itself (make dev, the pip CLI) — only its rooms or their network.
  for (const sign of ['homeHere', 'homeRoomsHere', 'homeNetworkHere'] as const) {
    const r = rig()
    r.docker[sign] = true
    r.host.reconcile(reply([intent()]))
    await r.host.idle()
    assert.equal(r.host.facts().sameDaemon, true, sign)
    assert.match(r.host.facts().canary, /^not run: a Colloq home runs on this Docker/, sign)
    assert.equal(said(r.host).placements[0]!.phase, 'failed', sign)
    assert.ok(!r.docker.calls.some((args) => step(args) === 'run' || step(args) === 'helper'), sign)
  }
})

test('a docker that does not say whether a home runs on it is taken for one: the facts keep classes off, as the start does', async () => {
  const r = rig()
  r.docker.intercept = (args) => (args[0] === 'ps' && args.includes('label=colloq.kind=app') ? { code: 1, out: 'Error response from daemon: context deadline exceeded' } : undefined)
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  assert.equal(r.host.facts().sameDaemon, true, 'an unknown answer read as no home on this docker')
  const held = said(r.host).placements[0]!
  assert.equal(held.phase, 'failed')
  assert.match(held.failure!.detail!, /did not say whether a Colloq home runs/)
})

test('the port is the host\'s loopback one, and nothing else is taken for it', () => {
  assert.equal(parsePort('127.0.0.1:49153\n'), 49153)
  assert.equal(parsePort('0.0.0.0:49153\n[::]:49153'), null)
  assert.equal(parsePort('127.0.0.1:0'), null)
  assert.equal(parsePort(''), null)
})

test('a revocation, a leave or another home removes every class container of the tree and every class folder', async () => {
  const r = await activated()
  await ready(r, [intent(), intent({ key: 's1:own' })])
  const theirs = classContainer(r.docker, { name: 'colloq-class-ffffff-s9-room', labels: [CLASS_KERNEL_LABEL, 'ru.colloq.competition-instance=ffffffffffffffff', 'colloq.placement=s9:room:1'] })
  // One an earlier life left that no record names: by docker's list, not the records.
  classContainer(r.docker, { name: nameOf('old:own'), labels: [CLASS_KERNEL_LABEL, INSTANCE_LABEL, 'colloq.placement=old:own:3'] })
  await r.host.removeAll('home revoked this machine')
  assert.deepEqual([...r.docker.classes.values()], [theirs])
  assert.ok(!fs.existsSync(r.layout.roomsDir) && !fs.existsSync(r.layout.placementsDir))
  assert.deepEqual(said(r.host).placements, [])
  assert.deepEqual(r.host.holding(), [])
})

/* ------------------------------------------- what must not strand a slot */

/** Event-loop turns until `until` holds, at most `most` of them: a wait counted in turns, never in milliseconds. */
async function turns(until: () => boolean, most = 200): Promise<void> {
  for (let turn = 0; turn < most && !until(); turn++) await new Promise((resolve) => setImmediate(resolve))
}

test('a start that failed holds up neither its removal nor the next gen: its backoff is the start\'s alone', async () => {
  const r = await activated()
  // Below the floor: the start fails, and is tried again only after a while.
  r.state.disk = 8192 + 100
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.phase, 'failed')
  // Home places the slot anew (gen 2) on a disk with room again: the new gen starts now, not after the old one's backoff.
  r.state.disk = 500_000
  r.host.reconcile(reply([intent({ gen: 2 })]))
  await r.host.idle()
  assert.deepEqual(said(r.host).placements.map((entry) => [entry.key, entry.gen, entry.phase]), [['s1:room', 2, 'ready']])
  // And a slot whose start failed goes at once when home drops it: no longer said failed, no longer turning the hidden test away.
  r.state.disk = 8192 + 100
  r.host.reconcile(reply([intent({ gen: 2 }), intent({ key: 's2:room' })]))
  await r.host.idle()
  assert.equal(said(r.host).placements.find((entry) => entry.key === 's2:room')?.phase, 'failed')
  r.host.reconcile(reply([intent({ gen: 2 })]))
  await r.host.idle()
  assert.deepEqual(said(r.host).placements.map((entry) => entry.key), ['s1:room'])
})

test('a running container a start took as it ran still holds its memory when that start fails, and is taken up by the retry', async () => {
  const first = await activated()
  await ready(first, [intent({ memoryMb: 8192, cpus: 4 })])
  first.host.stop()
  const room = first.docker.classes.get(nameOf('s1:room'))!
  const second = rig({}, first)
  const before = second.docker.calls.length
  // Docker's port read fails at the adoption, and Jupyter, busy with a student's cell, does not answer in time.
  let portFails = 1
  second.docker.intercept = (args) => (args[0] === 'port' && portFails-- > 0 ? { code: 1, out: 'Error response from daemon: context deadline exceeded' } : undefined)
  second.state.probe = async () => false
  await second.host.adopt()
  second.host.reconcile(reply([intent({ memoryMb: 8192, cpus: 4 })]))
  await second.host.idle()
  assert.equal(said(second.host).placements[0]!.phase, 'failed')
  assert.equal(second.docker.classes.get(nameOf('s1:room'))!.status, 'running', 'a start that failed removed a kernel it did not make')
  assert.deepEqual(second.host.holding(), [{ memoryMb: 8192, cpus: 4 }], 'a kernel that runs was left out of what the machine holds')
  second.state.probe = async () => true
  second.clock.now += KERNEL_TIMINGS.retryMs.first
  await second.host.tick()
  await second.host.idle()
  assert.equal(said(second.host).placements[0]!.phase, 'ready')
  assert.equal(second.docker.classes.get(nameOf('s1:room'))!.id, room.id)
  assert.ok(!second.docker.calls.slice(before).some((args) => step(args) === 'run'), 'the kernel was made anew')
})

test('home silent for the idle time removes what does not run as well, and a docker that did not list at the start is asked again at a beat', async () => {
  const first = await activated()
  await ready(first, [intent(), intent({ key: 's2:room' })])
  first.host.stop()
  // One of them exited since, and the next life's docker does not list at its start.
  first.docker.classes.get(nameOf('s1:room'))!.status = 'exited'
  const second = rig({ timings: { orphanMs: 120 * 60_000, orphanQuietMs: 5 * 60_000 } }, first)
  let refuse = true
  second.docker.intercept = (args) => {
    second.events.push(step(args))
    if (refuse && args[0] === 'ps' && args.includes(`label=${CLASS_KERNEL_LABEL}`)) return { code: 1, out: 'Cannot connect to the Docker daemon' }
  }
  await second.host.adopt()
  await second.host.idle()
  assert.deepEqual(said(second.host).placements.map((entry) => entry.phase), ['starting', 'starting'])
  // A beat once docker answers: the running one is found running (and measured), the exited one held as it is.
  refuse = false
  second.clock.now += KERNEL_TIMINGS.censusMs
  await second.host.tick()
  await second.host.idle()
  assert.deepEqual(said(second.host).placements.map((entry) => [entry.key, entry.phase]), [['s1:room', 'starting'], ['s2:room', 'ready']])
  // Home never speaks of classes (rolled back to a release without them): past the idle time both go, the idle one and the one that does not run.
  for (let beat = 0; beat < 13; beat++) {
    second.clock.now += 10 * 60_000
    await second.host.tick()
    await second.host.idle()
  }
  assert.equal(second.docker.classes.size, 0)
  assert.deepEqual(second.host.holding(), [])
  assert.equal(second.host.holdsAny(), false, 'an exited kernel nobody wants kept the hidden test away')
  assert.deepEqual(readPlacements(second.layout), [])
})

test('a record of a shape this build cannot read keeps its container: held, not ready, until home names its slot, then taken up as it runs', async () => {
  const first = await activated()
  await ready(first)
  first.host.stop()
  const room = first.docker.classes.get(nameOf('s1:room'))!
  // As another build wrote it: a field this one requires is not there.
  const file = path.join(first.layout.placementsDir, 's1-room.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { intent: Record<string, unknown> }
  delete record.intent.shm
  fs.writeFileSync(file, JSON.stringify(record))
  const second = rig({}, first)
  await second.host.adopt()
  await second.host.idle()
  assert.equal(second.docker.classes.get(nameOf('s1:room')), room, 'an update removed a kernel whose record it could not read')
  assert.deepEqual(said(second.host).placements, [{ key: 's1:room', gen: 1, phase: 'starting', container: room.id }])
  assert.deepEqual(second.host.holding(), [{ memoryMb: 4096, cpus: 2 }])
  assert.ok(fs.existsSync(file), 'the record was deleted')
  // Home names it at its gen: taken up as it runs, its Python with it, and written down again in this build's shape.
  second.events.length = 0
  second.host.reconcile(reply([intent()]))
  await second.host.idle()
  assert.ok(!second.events.includes('run') && !second.events.includes('start'), second.events.join(' · '))
  assert.deepEqual(said(second.host).placements, [{ key: 's1:room', gen: 1, phase: 'ready', container: room.id, revision: remoteRevisionDigest(REVISION.ref) }])
  assert.equal(readPlacements(second.layout)[0]!.intent.shm, '1g')
})

test('a record is dropped only for its own gen: a late end of an older start never takes a newer one\'s', () => {
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'drop-')))
  writePlacement(layout, { intent: intent({ gen: 2 }), container: null, image: revisionImage(REVISION.id), spec: specDigest(intent({ gen: 2 }), 'blocked'), limits: { memoryMb: 4096, cpus: 2 }, card: null })
  dropPlacement(layout, 's1:room', 1)
  assert.equal(readPlacements(layout)[0]?.intent.gen, 2)
  dropPlacement(layout, 's1:room', 2)
  assert.deepEqual(readPlacements(layout), [])
})

test('an exited container made with other hardening is made anew, never started again with the rights of an older build', async () => {
  for (const older of ['digest', 'label'] as const) {
    const first = await activated()
    await ready(first)
    first.host.stop()
    const room = first.docker.classes.get(nameOf('s1:room'))!
    room.status = 'exited'
    if (older === 'label') {
      // Its label names an earlier profile, whatever its record says.
      room.labels = room.labels.map((label) => (label.startsWith('colloq.profile=') ? 'colloq.profile=0' : label))
    } else {
      // Its record is an earlier build's: that digest knew nothing of the profile or of the flags a machine adds.
      const file = path.join(first.layout.placementsDir, 's1-room.json')
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { spec: string }
      const { environment, revision, pids, gpu, token, hashSeed, shm } = intent()
      record.spec = createHash('sha256').update(JSON.stringify([environment, revision.id, revision.ref, revision.layers, pids, gpu, 'blocked', token, hashSeed, shm, null])).digest('hex')
      fs.writeFileSync(file, JSON.stringify(record))
    }
    const second = rig({}, first)
    await second.host.adopt()
    second.events.length = 0
    second.host.reconcile(reply([intent()]))
    await second.host.idle()
    assert.ok(second.events.includes('run') && !second.events.includes('start'), `${older}: ${second.events.join(' · ')}`)
    const made = second.docker.classes.get(nameOf('s1:room'))!
    assert.notEqual(made.id, room.id)
    assert.ok(made.labels.includes(`colloq.profile=${profileFor('blocked')}`))
  }
})

/* ------------------------------------------------ resizes and readings */

test('a size docker refused is asked again of the fresh Python once the container is started again', async () => {
  const r = await activated()
  await ready(r, [intent({ memoryMb: 8192 })])
  r.docker.intercept = (args) => (args[0] === 'update' ? { code: 1, out: 'Error response from daemon: Cannot update container: memory limit should be larger than usage' } : undefined)
  r.host.reconcile(reply([intent({ memoryMb: 2048 })]))
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.resized, 'pending')
  r.docker.intercept = null
  // The kernel dies; the census starts the same container again, and its fresh Python takes the smaller size.
  Object.assign(r.docker.classes.get(nameOf('s1:room'))!, { status: 'exited', exit: 137 })
  await r.host.census()
  await r.host.idle()
  const held = said(r.host).placements[0]!
  assert.equal(held.phase, 'ready')
  assert.equal(held.resized, 'applied')
  assert.equal(r.docker.classes.get(nameOf('s1:room'))!.memoryMb, 2048)
  assert.deepEqual(r.host.holding(), [{ memoryMb: 2048, cpus: 2 }])
})

test('a resize\'s outcome is said for the numbers it answers: a new size never reads the last one\'s `applied`', async () => {
  const r = await activated()
  await ready(r)
  r.host.reconcile(reply([intent({ memoryMb: 8192 })]))
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.resized, 'applied')
  // Docker takes its time with the next one: a sync built meanwhile says no outcome for the new numbers.
  let release!: () => void
  const slow = new Promise<void>((resolve) => (release = resolve))
  r.docker.intercept = async (args) => {
    if (args[0] === 'update') await slow
  }
  r.host.reconcile(reply([intent({ memoryMb: 6144 })]))
  assert.equal(said(r.host).placements[0]!.resized, undefined)
  release()
  await r.host.idle()
  assert.equal(said(r.host).placements[0]!.resized, 'applied')
  assert.equal(r.docker.classes.get(nameOf('s1:room'))!.memoryMb, 6144)
})

test('a death home asked about before the census saw it is that question\'s, and a reading kept from a death answers no later question', async () => {
  const r = await activated()
  await ready(r)
  const room = r.docker.classes.get(nameOf('s1:room'))!
  const what = (reading: { status: string; exit: number | null; containerOomKilled: boolean }) => ({ status: reading.status, exit: reading.exit, oom: reading.containerOomKilled })
  // The container dies of memory; home's kernel client sees it first and asks.
  Object.assign(room, { status: 'exited', exit: 137, oomKilled: true, logs: ['Killed'] })
  r.host.reconcile(reply([intent()], { postmortem: ['s1:room'] }))
  await r.host.idle()
  assert.deepEqual(what(said(r.host).readings[0]!.reading), { status: 'exited', exit: 137, oom: true })
  r.host.readingsSaid(r.host.readingsNow())
  // That was the death: started again at once, and the census after it finds nothing to keep.
  assert.equal(said(r.host).placements[0]!.phase, 'ready')
  await r.host.census()
  await r.host.idle()
  // Half a minute on, a kernel inside the live container dies of something else, and home asks: the container as it is.
  r.clock.now += 30_000
  Object.assign(room, { oomKilled: false, exit: 0, logs: ['Segmentation fault'] })
  r.host.reconcile(reply([intent()], { postmortem: ['s1:room'] }))
  await r.host.idle()
  assert.equal(said(r.host).readings[0]!.reading.status, 'running', 'a later question got an earlier death')
  r.host.readingsSaid(r.host.readingsNow())
  // A death the census saw and home never asked about: its reading answers no question ten minutes on.
  Object.assign(room, { status: 'exited', exit: 137, oomKilled: true, logs: ['Killed'] })
  await r.host.census()
  await r.host.idle()
  Object.assign(room, { oomKilled: false, exit: 0, logs: [] })
  r.clock.now += 10 * 60_000
  r.host.reconcile(reply([intent()], { postmortem: ['s1:room'] }))
  await r.host.idle()
  assert.equal(said(r.host).readings[0]!.reading.status, 'running', 'a reading kept from a death answered a question long after it')
})

/* --------------------------------------------------- perimeter and facts */

test('three failures of the perimeter in a row means in a row: an install that held between them starts the count again', async () => {
  const r = await activated()
  await ready(r)
  const fail = { code: 22, out: 'colloq-perimeter: iptables-restore refused the rules' }
  r.docker.perimeter = fail
  for (let round = 1; round < PERIMETER_FAILURES_MAX; round++) {
    r.clock.now += KERNEL_TIMINGS.recheckMs
    await r.host.tick()
    await r.host.idle()
  }
  // The rules hold again for the start of another class (no re-check of its own ran): the streak is broken.
  r.docker.perimeter = { code: 0, out: 'colloq-perimeter: ok' }
  r.clock.now += KERNEL_TIMINGS.recheckMs
  await ready(r, [intent(), intent({ key: 's2:room' })])
  r.docker.perimeter = fail
  r.clock.now += KERNEL_TIMINGS.recheckMs
  await r.host.tick()
  await r.host.idle()
  assert.equal(r.docker.classes.size, 2, 'one failure after an install that held stopped every class')
  assert.notEqual(r.host.facts().perimeter, 'failing')
})

test('a perimeter that failed closed holds what docker would not remove, says it stopping, and removes it again at every beat', async () => {
  const r = await activated()
  await ready(r)
  const room = r.docker.classes.get(nameOf('s1:room'))!
  r.docker.perimeter = { code: 22, out: 'colloq-perimeter: iptables-restore refused the rules' }
  // A wedged daemon (which may be why the helper fails): it refuses to remove the class container.
  let refuse = true
  r.docker.intercept = (args) => {
    r.events.push(step(args))
    if (refuse && args[0] === 'rm' && args.some((arg) => arg === room.id || arg === room.name)) return { code: 1, out: 'Error response from daemon: removal of container is already in progress' }
  }
  for (let round = 1; round <= PERIMETER_FAILURES_MAX; round++) {
    r.clock.now += KERNEL_TIMINGS.recheckMs
    await r.host.tick()
    await r.host.idle()
  }
  assert.equal(r.host.facts().perimeter, 'failing')
  assert.equal(room.status, 'running')
  assert.deepEqual(said(r.host).placements.map((entry) => [entry.key, entry.phase, entry.container]), [['s1:room', 'stopping', room.id]], 'a container that runs was forgotten')
  assert.equal(readPlacements(r.layout).length, 1)
  // Home, not yet told, asks for it again: nothing is taken up behind rules that do not hold.
  r.events.length = 0
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  assert.ok(!['start', 'run', 'port'].some((event) => r.events.includes(event)), r.events.join(' · '))
  // Docker removes it at last: gone at the next beat, its record with it.
  refuse = false
  r.clock.now += KERNEL_TIMINGS.retryMs.first
  await r.host.tick()
  await r.host.idle()
  assert.equal(r.docker.classes.size, 0)
  assert.deepEqual(said(r.host).placements, [])
  assert.deepEqual(readPlacements(r.layout), [])
})

test('one perimeter helper at a time: a newer plan waits for the install under way, then goes in after it', async () => {
  const r = await activated()
  r.clock.now += KERNEL_TIMINGS.recheckMs
  const helpers: Array<() => void> = []
  r.docker.intercept = async (args) => {
    r.events.push(step(args))
    if (args[0] === 'run' && args.includes('--privileged')) await new Promise<void>((release) => helpers.push(release))
  }
  // A class whose home blocks one range starts; its helper is under way.
  r.host.reconcile(reply([intent({ blockedCidrs: ['203.0.113.0/24'] })]))
  await turns(() => helpers.length === 1)
  assert.equal(helpers.length, 1)
  // Meanwhile a second class, whose intent blocks another range: its plan waits, never beside the first.
  r.host.reconcile(reply([intent({ blockedCidrs: ['203.0.113.0/24'] }), intent({ key: 's2:room', blockedCidrs: ['198.51.100.0/24'] })]))
  await turns(() => helpers.length > 1)
  assert.equal(helpers.length, 1, 'two helpers ran side by side: the rules in force are whichever ends last')
  helpers[0]!()
  await turns(() => helpers.length === 2)
  helpers[1]!()
  await r.host.idle()
  const last = r.docker.helperScripts.at(-1)!
  for (const range of ['203.0.113.0/24', '198.51.100.0/24']) assert.ok(last.includes(`-d ${range} -j ${SCOPE.chains}-DENY`), `the rules in force lack ${range}`)
  assert.equal(said(r.host).placements.find((entry) => entry.key === 's2:room')?.phase, 'ready')
})

test('a life that adopts class containers finds its facts out before home speaks: an update under a class never says them off the host\'s network, unfenced', async () => {
  const first = await activated()
  await ready(first)
  first.host.stop()
  const helpers = first.docker.helperScripts.length
  const second = rig({}, first)
  // Known by the time adopt() lets the first sync go.
  await second.host.adopt()
  assert.deepEqual(second.host.facts(), { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false })
  assert.equal(second.docker.helperScripts.length, helpers + 1, 'the rules of the live class were not put back at once')
})

test('a canary whose second listener fails leaves no port of the first open on the host\'s network', async () => {
  const opened: net.Server[] = []
  const create = net.createServer
  net.createServer = ((...args: Parameters<typeof net.createServer>) => {
    const server = create(...args)
    opened.push(server)
    if (opened.length === 2) {
      server.listen = function (this: net.Server) {
        process.nextTick(() => this.emit('error', Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })))
        return this
      } as typeof server.listen
    }
    return server
  }) as typeof net.createServer
  try {
    const r = rig()
    r.host.reconcile(reply([]))
    await r.host.idle()
    assert.match(r.host.facts().canary, /^failed: .*EADDRINUSE/)
  } finally {
    net.createServer = create
    for (const server of opened) if (server.listening) server.close()
  }
  assert.equal(opened.length, 2)
  assert.ok(opened.every((server) => !server.listening), 'the first listener stayed open')
})

/* ------------------------------------------------------- D3, and the end */

test('a machine that holds the hidden test starts no class container beside it, whatever home asks (D3)', async () => {
  const r = await activated({ sealed: () => true })
  r.host.reconcile(reply([intent()]))
  await r.host.idle()
  const held = said(r.host).placements[0]!
  assert.equal(held.phase, 'failed')
  assert.match(held.failure!.detail!, /hidden test/)
  assert.ok(!r.docker.calls.some((args) => step(args) === 'run'))
})

test('a removal of everything starts nothing meanwhile, goes by docker\'s list after its rm, and takes a folder a kernel locked', async () => {
  const r = await activated()
  await ready(r)
  // A second class whose start failed, its retry due just as the removal begins.
  r.docker.runFails = { code: 125, out: 'docker: Error response from daemon: failed to create task: unknown.' }
  r.host.reconcile(reply([intent(), intent({ key: 's2:room' })]))
  await r.host.idle()
  r.docker.runFails = null
  r.clock.now += KERNEL_TIMINGS.retryMs.first
  // A kernel runs as the agent's own uid, and took a folder's bits away.
  const locked = path.join(r.layout.roomsDir, 's1', 'locked')
  fs.mkdirSync(path.join(locked, 'deep'), { recursive: true })
  fs.writeFileSync(path.join(locked, 'deep', 'data.csv'), 'a\n')
  fs.chmodSync(locked, 0o000)
  // Docker refuses its first removal.
  let refusals = 1
  r.docker.intercept = (args) => {
    r.events.push(step(args))
    if (args[0] === 'rm' && args.some((arg) => /^[a-f0-9]{64}$/.test(arg)) && refusals-- > 0) return { code: 1, out: 'Error response from daemon: removal of container is already in progress' }
  }
  r.events.length = 0
  try {
    const removal = r.host.removeAll('home revoked this machine')
    // The host's own beat and a revision ready, both just as it begins.
    await r.host.tick()
    r.host.imagesChanged()
    assert.equal(await removal, 0)
    await r.host.idle()
    assert.ok(!r.events.includes('run'), `a class container was started during the removal: ${r.events.join(' · ')}`)
    assert.equal(r.docker.classes.size, 0)
    assert.ok(!fs.existsSync(r.layout.roomsDir), 'a folder a kernel locked kept the class folders')
    assert.ok(!fs.existsSync(r.layout.placementsDir))
    assert.deepEqual(said(r.host).placements, [])
  } finally {
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700)
  }
  // A docker that never removes them: said as such, never taken for done.
  const stuck = await activated()
  await ready(stuck)
  stuck.docker.intercept = (args) => (args[0] === 'rm' ? { code: 1, out: 'Cannot connect to the Docker daemon' } : undefined)
  assert.equal(await stuck.host.removeAll('home revoked this machine'), 1)
  assert.ok(stuck.logs.some((line) => /1 still there/.test(line)), stuck.logs.join('\n'))
})
