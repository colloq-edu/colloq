/**
 * The council's side of a class machine (server/src/runner-agent/council.ts,
 * docs/architecture/remote-classes.md §9.2, §9.5, §9.7, §17.1 row
 * runner-agent-council): the council container's folders, the epochs in the
 * CAS and as hard links in the class's read-only epochs folder, an export
 * read off the notebook kernel's own container, the files of an export sent
 * home, an attempt's files collected within their caps, and what goes when.
 * Against the agent's own CAS (cache.ts) and a home of the test's own, a fake
 * docker, and a clock the waits move, never a daemon.
 *
 * What is held here is what a class would lose, or leak. A container with a
 * card or a folder of the agent's in it is a sandbox that is not; an epoch
 * file a worker could write is every other worker's data changed under it; an
 * export read from another class's container, or a file of it taken by its
 * name, is someone else's state in this class's attempts; a link followed out
 * of a scratch folder is the machine's secret on its way to a card at home;
 * an epoch evicted while a pool loads it is a pool that cannot seed; and an
 * attempt's folder never removed is a disk that fills over a term.
 */
import './_env.mts'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http, { type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import {
  CLASS_PACE_BURST_BYTES,
  COUNCIL_EPOCHS_MOUNT,
  COUNCIL_EPOCH_DIR,
  COUNCIL_GATE_CONFIG_MOUNT,
  COUNCIL_GATE_MOUNT,
  COUNCIL_SCRATCH_MOUNT,
  parseRemoteKernelsReply,
  parseRemoteKernelsRequest,
  type RemoteEpochIntent,
  type RemoteKernelsReply,
  type RemotePlacementIntent,
} from '../shared/remote-kernels.ts'
import { REMOTE_API_BASE, REMOTE_BYTES_HEADER, REMOTE_MARKER, REMOTE_MARKER_HEADER, REMOTE_SHA256_HEADER } from '../shared/remote-runner.ts'
import { CLASS_KERNEL_LABEL, machineRoomContainer, machineRoomRunArgs } from '../server/src/kernel/room-spec.ts'
import { Cache, Pacer } from '../server/src/runner-agent/cache.ts'
import { Backoff, RemoteClient } from '../server/src/runner-agent/client.ts'
import { COUNCIL_TIMINGS, CouncilHost, councilDir, councilGate, councilMounts, councilUploader, scratchHelperArgs, scratchHelperNames, type CouncilPut, type CouncilTimings } from '../server/src/runner-agent/council.ts'
import { COUNCIL_GATE_CONFIG, COUNCIL_GATE_DIGEST, COUNCIL_GATE_FILE, COUNCIL_GATE_PYTHON } from '../server/src/kernel/council-gate.ts'
import type { Docker } from '../server/src/runner-agent/docker.ts'
import { INSTANCE_LABEL, revisionImage } from '../server/src/runner-agent/images.ts'
import { KernelHost } from '../server/src/runner-agent/kernels.ts'
import type { RoomUploadAnswer } from '../server/src/runner-agent/room-files.ts'
import { Agent } from '../server/src/runner-agent/sync.ts'
import { stateLayout, type StateLayout } from '../server/src/runner-agent/state.ts'
import { competitionsDir, competitionsFs } from '../server/src/competitions/storage.ts'
import { TEST_ROOT } from './_env.mts'
import { DIFF_IDS, FakeSeam, LAYERS, REVISION, classContainer, fakeAgentDocker, fakeHome, syncReply, waitFor, type FakeHome } from './_runner-agent-home.mts'

/* ---------------------------------------------------------------- fixtures */

const sha = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex')
const MIB = 1024 * 1024
const ROOM_CONTAINER = 'a'.repeat(64)
const OTHER_CONTAINER = 'b'.repeat(64)
const COUNCIL_CONTAINER = 'c'.repeat(64)
const OWN_CONTAINER = 'd'.repeat(64)

beforeEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'data'), { recursive: true, force: true })
  // storage.ts holds the competitions folder open: closed, it opens the new one (runner-agent-cache.test.mts says why).
  competitionsFs.close()
})

function placement(partial: Partial<RemotePlacementIntent> = {}): RemotePlacementIntent {
  return {
    key: 's1:council', gen: 2, environment: 'base', revision: { id: REVISION.id, ref: REVISION.ref, layers: LAYERS },
    memoryMb: 6144, cpus: 4, pids: 2048, gpu: false, network: 'blocked', blockedCidrs: [], token: 'e'.repeat(40), hashSeed: 7, shm: '1g', workers: 4,
    ...partial,
  }
}

/** Home's block as the agent's parser takes it: what a test writes must be what home may send. */
function block(partial: Partial<RemoteKernelsReply> = {}, placements: RemotePlacementIntent[] = [placement()]): RemoteKernelsReply {
  return parseRemoteKernelsReply({
    placements, pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [],
    rates: { classBulkMBps: 4, machinePaceMBps: 6 }, tunnel: 'open', ...partial,
  })
}

/** An epoch's intent of the class notebook: its manifest, its other files, and where they come from. */
function epoch(seq: number, manifest: Buffer, files: Buffer[], from: RemoteEpochIntent['from'] = 'home', ship?: string[]): RemoteEpochIntent {
  return {
    sessionId: 's1', root: 'cells', seq, manifest: { sha256: sha(manifest), bytes: manifest.length },
    buffers: files.map((file) => ({ sha256: sha(file), bytes: file.length })), from, ...(ship ? { ship } : {}),
  }
}

const exportFrom = (seq: number, container = ROOM_CONTAINER) => ({ container, dir: `${COUNCIL_EPOCH_DIR}/${seq}` })

interface Rig {
  layout: StateLayout
  home: FakeHome
  cache: Cache
  council: CouncilHost
  clock: { now: number }
  /** The class containers docker holds here: id → whose, and the folder its own filesystem is (an export's /tmp). */
  containers: Map<string, { sessionId: string; role: 'room' | 'own' | 'council'; gen: number; root: string }>
  docker: Docker & { calls: string[][] }
  /** What each PUT home took: its door, whether gzipped, its headers' numbers and its bytes as sent. */
  uploads: Array<{ put: Omit<CouncilPut, 'body' | 'signal'>; body: Buffer }>
  answer: (put: CouncilPut) => RoomUploadAnswer
  /** The blobs the CAS was asked for, with the pace and urgency they were asked at. */
  asked: Array<{ sha: string; pace: number; urgent: boolean }>
  /** While set, every blob fetch waits for it (a big buffer on its way), or for its signal to give up. */
  fetching: Promise<void> | null
  /** Copies out of a container held until the test lets them go (gigabytes off a disk), by the path inside. */
  copying: Map<string, Promise<void>>
  sleeps: number[]
  urgent: number
  logs: string[]
  /** The bucket the host's uploads are paced through, as sync.ts shares it with the class folders' (RoomFilesOptions.pacer). */
  pacer: Pacer
  /** What the scratch space's helper was asked (kernels.ts · councilScratch): each class and action, in order. */
  scratchRuns: Array<{ sessionId: string; action: string }>
  close(): Promise<void>
}

/**
 * A council host over the agent's own CAS, fed by a home of the test's own,
 * with a fake docker that copies an export out of a container's folder and
 * removes it there, an upload door that keeps what it took, and a clock that
 * only the waits move.
 */
async function rig(timings: Partial<CouncilTimings> = {}, shared?: Pick<Rig, 'layout' | 'home' | 'containers'>): Promise<Rig> {
  const home = shared?.home ?? await fakeHome()
  const layout = shared?.layout ?? stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'council-')))
  const containers = shared?.containers ?? new Map()
  const r = {
    layout, home, containers, clock: { now: 1_800_000_000_000 }, uploads: [], asked: [], fetching: null, copying: new Map(), sleeps: [], urgent: 0, logs: [],
    answer: () => ({ kind: 'ok' }), scratchRuns: [],
  } as unknown as Rig
  const docker = (async (args: string[]) => {
    docker.calls.push(args)
    if (args[0] === 'cp') {
      const [, from, to] = args
      const [id, inside] = from!.split(':') as [string, string]
      await r.copying.get(inside)
      const held = containers.get(id)
      const source = held ? path.join(held.root, inside) : null
      if (!source || !fs.existsSync(source)) return { code: 1, out: `Error response from daemon: Could not find the file ${inside} in container ${id}` }
      // As docker copies a folder: links as links, a name that is not there yet made the folder's copy.
      fs.cpSync(source, to!, { recursive: true, verbatimSymlinks: true })
      return { code: 0, out: '' }
    }
    if (args[0] === 'exec' && args[2] === 'rm') {
      const held = containers.get(args[1]!)
      if (!held) return { code: 1, out: `Error response from daemon: No such container: ${args[1]}` }
      fs.rmSync(path.join(held.root, args[args.length - 1]!), { recursive: true, force: true })
      return { code: 0, out: '' }
    }
    return { code: 1, out: `fake docker: ${args.join(' ')}` }
  }) as Rig['docker']
  docker.calls = []
  r.docker = docker
  r.pacer = new Pacer(() => r.clock.now, CLASS_PACE_BURST_BYTES)
  const client = new RemoteClient({ home: home.url, build: 'dev', credential: () => null })
  let council: CouncilHost | undefined
  r.cache = new Cache({ client, books: path.join(layout.root, 'books'), backoff: new Backoff(() => 0, 5, 20), idleMs: 2_000, log: () => undefined, pinned: () => council?.pinned() ?? new Set() })
  r.cache.load()
  council = new CouncilHost({
    layout,
    docker,
    cas: {
      blob: async (hash, bytes, options) => {
        r.asked.push({ sha: hash, pace: options.pace(), urgent: options.urgent() })
        if (r.fetching) await Promise.race([r.fetching, new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))])
        if (options.signal.aborted) throw new Error('cancelled')
        return r.cache.blob(hash, bytes, options)
      },
      has: (hash) => r.cache.has(hash),
      adopt: (file, hash) => r.cache.adopt(file, hash),
      place: (hash, to) => r.cache.place(hash, to),
      path: (hash) => r.cache.blobPath(hash, false),
      release: (hash) => r.cache.release(hash),
    },
    upload: async (put) => {
      const chunks: Buffer[] = []
      for await (const chunk of put.body) chunks.push(Buffer.from(chunk))
      r.uploads.push({ put: { door: put.door, sha256: put.sha256, bytes: put.bytes, gzip: put.gzip }, body: Buffer.concat(chunks) })
      return r.answer(put)
    },
    held: (sessionId) => [...containers.values()].filter((held) => held.sessionId === sessionId).map(({ role, gen }) => ({ role, gen })),
    containerOf: (id) => {
      const held = containers.get(id)
      return held ? { sessionId: held.sessionId, role: held.role, gen: held.gen } : null
    },
    diskFreeMb: () => 500_000,
    diskFloorMb: 8192,
    onChange: (urgent) => {
      if (urgent) r.urgent++
    },
    log: (line) => r.logs.push(line),
    now: () => r.clock.now,
    sleep: async (ms) => {
      r.sleeps.push(ms)
      r.clock.now += ms
    },
    random: () => 0,
    timings: { beatMs: 0, ...timings },
    pacer: r.pacer,
    // The helper as root does it: it reads the folder whatever its mode (a test takes the listing away from this process).
    scratch: async (sessionId, action) => {
      r.scratchRuns.push({ sessionId, action })
      const folder = scratchOf(layout, sessionId)
      const mode = fs.statSync(folder).mode & 0o7777
      fs.chmodSync(folder, mode | 0o700)
      try {
        const names = fs.readdirSync(folder)
        if (action === 'remove') for (const name of names) fs.rmSync(path.join(folder, name), { recursive: true, force: true })
        return { ok: true, out: `${action === 'list' ? names.map((name) => `/s/${name}\0`).join('') + '\n' : ''}colloq-scratch: ok` }
      } finally {
        fs.chmodSync(folder, mode)
      }
    },
  })
  r.council = council
  r.close = async () => {
    council!.stop()
    r.cache.stop()
    if (!shared) await home.close()
  }
  return r
}

/** A class container of this machine, with the folder its own filesystem is. */
function hold(r: Pick<Rig, 'containers' | 'layout'>, id: string, sessionId: string, role: 'room' | 'own' | 'council', gen: number): string {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, `container-${role}-`))
  r.containers.set(id, { sessionId, role, gen, root })
  return root
}

/** An export as the notebook's kernel leaves it in its own container: files by any names. */
function exported(root: string, seq: number, files: Record<string, Buffer>): string {
  const dir = path.join(root, COUNCIL_EPOCH_DIR, String(seq))
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

const epochsOf = (layout: StateLayout, sessionId = 's1') => path.join(councilDir(layout, sessionId), 'epochs')
const scratchOf = (layout: StateLayout, sessionId = 's1') => path.join(councilDir(layout, sessionId), 'scratch')
/** The workers' gate as the agent keeps it (council.ts · councilGate): one folder for every class, named by its texts. */
const gateOf = (layout: StateLayout) => path.join(layout.root, 'council', '.gate', COUNCIL_GATE_DIGEST)
const sameInode = (a: string, b: string): boolean => {
  const x = fs.lstatSync(a)
  const y = fs.lstatSync(b)
  return x.dev === y.dev && x.ino === y.ino
}
const blobGets = (home: FakeHome, hash: string): number => home.calls.filter((call) => call.method === 'GET' && call.path.endsWith(`/blobs/${hash}`)).length

/** What the host says in a sync, through home's own strict parser: a field it may not carry fails the test that said it. */
function said(council: CouncilHost) {
  const collected = council.collectedNow()
  return parseRemoteKernelsRequest({
    placements: [], reports: [], epochs: council.epochsNow(), readings: [], tunnel: 'up',
    classes: { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false },
    ...(collected.length > 0 ? { collected } : {}),
  })
}

/* --------------------------------------------------- the council container */

/** A kernel host that has heard of classes: its facts found, the perimeter in place, the canary passed. */
async function kernelHost() {
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'council-host-')))
  const docker = fakeAgentDocker()
  const images = {
    verify: async (revision: { id: string }) => revisionImage(revision.id),
    isReady: () => true,
    problemWith: () => null,
    readyIds: () => [REVISION.id],
  }
  const logs: string[] = []
  const host: KernelHost = new KernelHost({
    layout, docker, images, container: 'colloq-runner', image: null, env: {},
    cards: () => [], cardRuns: () => host.cardRuns(), heldGpus: () => ({}), diskFreeMb: () => 500_000, diskFloorMb: 8192,
    heardAt: () => Date.now(), onChange: () => undefined, log: (line) => logs.push(line), probe: async () => true, sleep: async () => undefined,
    timings: { censusMs: 3_600_000 },
  })
  host.reconcile(block({}, []))
  await host.idle()
  return { layout, docker, host, logs }
}

test('a council container sees the class folder and its epochs read-only and its scratch space read-write, and nothing else: no card, no socket, no state of the agent\'s', async () => {
  const { layout, docker, host, logs } = await kernelHost()
  let scratchAtRun = null as fs.Stats | null
  docker.intercept = (args) => {
    if (args[0] === 'run' && args.includes(CLASS_KERNEL_LABEL)) scratchAtRun = fs.statSync(scratchOf(layout))
  }
  // Even an intent that asks for a card gives none to the pool: home's parser refuses it, and the argv would not hold one.
  assert.throws(() => block({}, [placement({ gpu: true })]), /card/)
  host.reconcile(block())
  await host.idle()
  const name = machineRoomContainer(INSTANCE_LABEL, 's1', 'council')
  const container = docker.classes.get(name)!
  assert.ok(container, logs.join('\n'))
  const mounts = [
    { source: epochsOf(layout), target: COUNCIL_EPOCHS_MOUNT, readOnly: true },
    { source: scratchOf(layout), target: COUNCIL_SCRATCH_MOUNT, readOnly: false },
    { source: path.join(gateOf(layout), 'module'), target: COUNCIL_GATE_MOUNT, readOnly: true },
    { source: path.join(gateOf(layout), 'ipython_kernel_config.py'), target: COUNCIL_GATE_CONFIG_MOUNT, readOnly: true },
  ]
  // Home's own argv for the slot, laid out for this machine, with the council's two folders and its gate (§9.6), nothing more.
  assert.deepEqual(container.args, machineRoomRunArgs({
    role: 'council', sessionId: 's1', environment: 'base', image: revisionImage(REVISION.id), mount: path.join(layout.roomsDir, 's1'), extraMounts: mounts,
    gpu: null, memoryMb: 6144, cpus: 4, pids: 2048, mode: 'blocked', profile: '1', token: 'e'.repeat(40), hashSeed: 7, shm: '1g',
  }, { instanceLabel: INSTANCE_LABEL, gen: 2 }))
  assert.deepEqual(container.mounts, [
    `${path.join(layout.roomsDir, 's1')}:/workspace/s1:ro`, `${epochsOf(layout)}:/colloq/epochs:ro`, `${scratchOf(layout)}:/colloq/scratch`,
    `${path.join(gateOf(layout), 'module')}:/colloq/gate:ro`, `${path.join(gateOf(layout), 'ipython_kernel_config.py')}:/etc/ipython/ipython_kernel_config.py:ro`,
  ])
  assert.ok(!container.args.some((arg) => /--gpus|docker\.sock|--privileged/.test(arg)))
  assert.ok(!container.mounts.some((mount) => mount.startsWith(`${layout.root}:`) || mount.includes(layout.placementsDir) || mount.includes(path.join(layout.root, 'data'))))
  // The scratch space was there before docker could make it, and its helper made it root's at 1733 before the container ran:
  // the kernels' to make a run's folder in, never to list, to empty of another's, nor to change the mode of — which its owner
  // could, and the agent shares the kernels' uid (K7a #17, K12b). The agent's own image, as root, the folder alone mounted.
  assert.ok(scratchAtRun && scratchAtRun.isDirectory() && (scratchAtRun.mode & 0o7777) === 0o1733, `mode ${scratchAtRun?.mode.toString(8)}`)
  assert.deepEqual(docker.scratchRuns.map((run) => run.folder), [scratchOf(layout)])
  const helped = docker.calls.findIndex((args) => args.includes('colloq.kind=council-scratch'))
  assert.deepEqual(docker.calls[helped], scratchHelperArgs(docker.selfImage, scratchOf(layout), 'fresh'))
  assert.ok(helped >= 0 && helped < docker.calls.findIndex((args) => args[0] === 'run' && args.includes(CLASS_KERNEL_LABEL)), 'the container ran on a space its workers could list')
  assert.match(docker.scratchRuns[0]!.script, /chown 0:0 \/s; chmod 1733 \/s/)
  for (const flag of ['--network=none', '--user=0:0', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never']) assert.ok(docker.calls[helped]!.includes(flag), flag)
  assert.ok(!docker.calls[helped]!.some((arg) => /--privileged|docker\.sock|--pid=host/.test(arg)))
  // A bigger pool: home's numbers for six workers, applied to the running container by docker update, never a new one.
  host.reconcile(block({}, [placement({ memoryMb: 9216, cpus: 6, workers: 6 })]))
  await host.idle()
  assert.ok(docker.calls.some((args) => args[0] === 'update' && args.includes('--memory=9216m') && args.includes('--cpus=6') && args.at(-1) === container.id), docker.calls.map((args) => args.join(' ')).join('\n'))
  assert.equal(docker.classes.get(name)!.id, container.id)
  assert.equal(host.held()[0]!.resized, 'applied')
  assert.equal(docker.calls.filter((args) => args[0] === 'run' && args.includes(CLASS_KERNEL_LABEL)).length, 1)
})

test('the workers\' gate is written once into a folder named by its texts, 0644 in 0755, read-only into every council container; a folder not what its name says, and a half-made one, are made again', () => {
  const layout = stateLayout(path.join(TEST_ROOT, 'data', 'gate'))
  const first = councilMounts(layout, 's1')
  const second = councilMounts(layout, 's2')
  const gate = gateOf(layout)
  const module = path.join(gate, 'module', COUNCIL_GATE_FILE)
  const config = path.join(gate, 'ipython_kernel_config.py')
  // The same two files for every class: the module's folder (the module alone in it) and the config, both read-only.
  for (const mounts of [first, second]) {
    assert.deepEqual(mounts.slice(2), [
      { source: path.join(gate, 'module'), target: COUNCIL_GATE_MOUNT, readOnly: true },
      { source: config, target: COUNCIL_GATE_CONFIG_MOUNT, readOnly: true },
    ])
  }
  assert.deepEqual(fs.readdirSync(path.join(gate, 'module')), [COUNCIL_GATE_FILE])
  assert.equal(fs.readFileSync(module, 'utf8'), COUNCIL_GATE_PYTHON)
  assert.equal(fs.readFileSync(config, 'utf8'), COUNCIL_GATE_CONFIG)
  assert.equal(COUNCIL_GATE_DIGEST, sha(Buffer.concat([Buffer.from(COUNCIL_GATE_PYTHON), Buffer.from('\0'), Buffer.from(COUNCIL_GATE_CONFIG)])), 'named by its texts')
  for (const [at, mode] of [[module, 0o644], [config, 0o644], [path.join(gate, 'module'), 0o755], [gate, 0o755], [path.dirname(gate), 0o755]] as const) {
    assert.equal(fs.statSync(at).mode & 0o7777, mode, `${path.relative(layout.root, at)}: ${(fs.statSync(at).mode & 0o7777).toString(8)}`)
  }
  // Written once: a container keeps the very files it was started with.
  const inode = fs.statSync(module).ino
  councilMounts(layout, 's1')
  assert.equal(fs.statSync(module).ino, inode)
  // Not a class: the sweeps that take a class's folder by its name never take the gate's (a dot is in no class's id).
  assert.throws(() => councilDir(layout, '.gate'), /Invalid class id/)
  // A folder that is not what its name says (a text changed in place), and what a life that ended midway left beside it.
  fs.writeFileSync(module, 'tampered')
  fs.mkdirSync(path.join(path.dirname(gate), '.tmp-0123456789ab', 'module'), { recursive: true })
  councilGate(layout)
  assert.equal(fs.readFileSync(module, 'utf8'), COUNCIL_GATE_PYTHON)
  assert.deepEqual(fs.readdirSync(path.dirname(gate)), [COUNCIL_GATE_DIGEST])
  // Nor does a link stand in for a file of it.
  fs.rmSync(config)
  fs.symlinkSync(module, config)
  councilGate(layout)
  assert.ok(fs.lstatSync(config).isFile())
  assert.equal(fs.readFileSync(config, 'utf8'), COUNCIL_GATE_CONFIG)
})

test('a new council container finds no attempt of the one before it; one taken as it runs keeps its attempts\' folders', async () => {
  const { layout, docker, host } = await kernelHost()
  // What an earlier container's attempt left (the container gone, its folder not).
  councilMounts(layout, 's1')
  fs.mkdirSync(path.join(scratchOf(layout), 'r_old', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(scratchOf(layout), 'r_old', 'sub', 'out.csv'), 'a,b\n')
  // A secret beside the tree, linked from a stale folder: emptying the scratch space removes the link, never its target.
  const secret = path.join(layout.root, 'runner.json')
  fs.writeFileSync(secret, '{"secret":"x"}')
  fs.symlinkSync(secret, path.join(scratchOf(layout), 'link.json'))
  // A council of another class that runs on through this life: taken as it runs, its live attempt kept.
  councilMounts(layout, 's2')
  fs.mkdirSync(path.join(scratchOf(layout, 's2'), 'r_live'), { recursive: true })
  classContainer(docker, { name: machineRoomContainer(INSTANCE_LABEL, 's2', 'council'), labels: [CLASS_KERNEL_LABEL, INSTANCE_LABEL, 'colloq.placement=s2:council:1'] })
  host.reconcile(block({}, [placement(), placement({ key: 's2:council', gen: 1 })]))
  await host.idle()
  assert.deepEqual(host.held().map((held) => [held.key, held.phase]).sort(), [['s1:council', 'ready'], ['s2:council', 'ready']])
  assert.deepEqual(fs.readdirSync(scratchOf(layout)), [])
  assert.equal(fs.readFileSync(secret, 'utf8'), '{"secret":"x"}')
  assert.deepEqual(fs.readdirSync(scratchOf(layout, 's2')), ['r_live'])
})

test('a scratch space the helper cannot make root\'s keeps the council\'s container from starting, in words; one an earlier build left open is mended at the next start', async () => {
  const { layout, docker, host } = await kernelHost()
  // As 0.26's first builds made it: setgid and listable by the kernels, and the agent's own.
  fs.mkdirSync(path.join(scratchOf(layout), 'r_old'), { recursive: true })
  fs.chmodSync(scratchOf(layout), 0o2775)
  docker.scratchFails = { code: 125, out: 'docker: Error response from daemon: No such image: sha256:5555.' }
  host.reconcile(block())
  await host.idle()
  const [held] = host.held()
  assert.match(held?.failure?.detail ?? '', /^the council's scratch space: docker: Error response from daemon: No such image/, JSON.stringify(held))
  assert.ok(!docker.calls.some((args) => args[0] === 'run' && args.includes(CLASS_KERNEL_LABEL)), 'a council container ran on a space its workers could list')
  // The helper back: the start goes on, on a space root's again and empty of the attempts before.
  docker.scratchFails = null
  host.reconcile(block({}, [placement({ gen: 3 })]))
  await host.idle()
  assert.ok(docker.calls.some((args) => args[0] === 'run' && args.includes(CLASS_KERNEL_LABEL)))
  assert.equal((fs.statSync(scratchOf(layout)).mode & 0o7777).toString(8), '1733')
  assert.deepEqual(fs.readdirSync(scratchOf(layout)), [])
  // What the helper lists is read by name, the folder's path off it, nothing docker said beside it.
  assert.deepEqual(scratchHelperNames('/s/aa\0/s/b c\0/s/x/y\0WARNING: something\n/s/zz\0\ncolloq-scratch: ok\n'), ['aa', 'b c', 'zz'])
  assert.deepEqual(scratchHelperNames('colloq-scratch: ok'), [])
})

/* ------------------------------------------------------------------ epochs */

test('an epoch from home: each file fetched once by its hash at the class\'s rate, hard-linked into the read-only epochs folder, ready; a refreeze fetches only what changed, and the older epoch goes after its grace', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const [manifest1, stream1, big] = [Buffer.from('{"manifest":1}'), randomBytes(1000), randomBytes(70_000)]
    const [manifest2, stream2] = [Buffer.from('{"manifest":2}'), randomBytes(1200)]
    for (const body of [manifest1, stream1, big, manifest2, stream2]) r.home.blobs.set(sha(body), body)
    r.council.reconcile(block({ epochs: [epoch(1, manifest1, [stream1, big])] }))
    await r.council.idle()
    assert.deepEqual(said(r.council).epochs, [{ sessionId: 's1', root: 'cells', seq: 1, ready: true }])
    assert.ok(r.urgent > 0, 'a ready epoch did not cut the held sync short: a dispatch waits on it')
    // Down the agent's one stream at the class's rate, never ahead of a run waiting on its push.
    assert.ok(r.asked.every((ask) => ask.pace === 4 * MIB && ask.urgent === false), JSON.stringify(r.asked))
    for (const body of [manifest1, stream1, big]) {
      const link = path.join(epochsOf(r.layout), sha(body))
      assert.ok(sameInode(link, r.cache.blobPath(sha(body), false)), 'a file of the epochs folder is not the CAS\'s own blob')
      assert.equal(fs.readFileSync(link).compare(body), 0)
      assert.equal(blobGets(r.home, sha(body)), 1)
    }
    // A refreeze: a new manifest and stream, the big buffer the same — taken from the CAS, never fetched again.
    r.council.reconcile(block({ epochs: [epoch(2, manifest2, [stream2, big])] }))
    await r.council.idle()
    assert.equal(blobGets(r.home, sha(big)), 1)
    assert.deepEqual(said(r.council).epochs.map((state) => [state.seq, state.ready]), [[2, true], [1, true]])
    // Its grace over, the older one goes: what only it named leaves the folder and the CAS, the shared buffer stays.
    r.clock.now += COUNCIL_TIMINGS.graceMs
    await r.council.tick()
    assert.deepEqual(said(r.council).epochs.map((state) => [state.seq, state.ready]), [[2, true]])
    assert.deepEqual(fs.readdirSync(epochsOf(r.layout)).sort(), [sha(manifest2), sha(stream2), sha(big)].sort())
    assert.equal(r.cache.has(sha(stream1)), false)
    assert.equal(r.cache.has(sha(big)), true)
  } finally {
    await r.close()
  }
})

test('the files of an epoch held are pinned: the CAS neither evicts nor releases them, and lets them go once no epoch names them', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const [manifest, stream, other] = [Buffer.from('{"m":1}'), randomBytes(2000), randomBytes(3000)]
    for (const body of [manifest, stream, other]) r.home.blobs.set(sha(body), body)
    await r.cache.blob(sha(other), other.length)
    r.council.reconcile(block({ epochs: [epoch(1, manifest, [stream])] }))
    await r.council.idle()
    // A disk far below its floor: eviction takes what nobody keeps, and nothing an epoch names.
    r.cache.evict({ manifests: new Set(), bundles: new Set(), blobs: new Set() }, () => 0, 1)
    assert.equal(r.cache.has(sha(other)), false, 'eviction did not run')
    assert.ok(r.cache.has(sha(stream)) && r.cache.has(sha(manifest)))
    // A class file copied out of the CAS lets its blob go (room-files.ts): never one an epoch names.
    r.cache.release(sha(stream))
    assert.ok(r.cache.has(sha(stream)))
    // The class leaves the machine: its epochs go, and with them the pins.
    r.containers.clear()
    r.council.reconcile(block({}, []))
    await r.council.idle()
    assert.equal(r.cache.has(sha(stream)), false)
    assert.ok(!fs.existsSync(councilDir(r.layout, 's1')))
  } finally {
    await r.close()
  }
})

test('an export on this machine: copied off the notebook kernel\'s own container, its files taken by content and hash, never by name or through a link, and its folder removed there', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const kernel = hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    const [manifest, stream, big, linked] = [Buffer.from('{"m":4}'), randomBytes(1500), randomBytes(5000), randomBytes(800)]
    // The big buffer came with an earlier epoch: the CAS has it, and the export does not rewrite it.
    r.home.blobs.set(sha(big), big)
    await r.cache.blob(sha(big), big.length)
    // The file a link in the export points at has the bytes of a file the epoch needs: only home's copy of it is taken.
    r.home.blobs.set(sha(linked), linked)
    const decoy = path.join(r.layout.root, 'decoy.bin')
    fs.writeFileSync(decoy, linked)
    const dir = exported(kernel, 4, {
      [`manifest-${sha(manifest)}.json`]: manifest,
      [`stream-${sha(stream)}.pkl`]: stream,
      // Of a length the epoch needs, and another content: no file of it.
      'notes.txt': randomBytes(1500),
    })
    fs.symlinkSync(decoy, path.join(dir, `buffer-${sha(linked)}`))
    r.council.reconcile(block({ epochs: [epoch(4, manifest, [stream, big, linked], exportFrom(4))] }, [placement(), placement({ key: 's1:room', gen: 3, workers: undefined })]))
    await r.council.idle()
    assert.deepEqual(said(r.council).epochs, [{ sessionId: 's1', root: 'cells', seq: 4, ready: true }], r.logs.join('\n'))
    const copies = r.docker.calls.filter((args) => args[0] === 'cp')
    assert.equal(copies.length, 1)
    assert.equal(copies[0]![1], `${ROOM_CONTAINER}:${COUNCIL_EPOCH_DIR}/4`)
    assert.ok(copies[0]![2]!.startsWith(path.join(councilDir(r.layout, 's1'), '.staging')), 'the export was copied somewhere a container may reach')
    // Taken from the export: nothing of it asked of home; the linked one fetched from home, never read through the link.
    assert.equal(blobGets(r.home, sha(manifest)) + blobGets(r.home, sha(stream)), 0)
    assert.equal(blobGets(r.home, sha(linked)), 1)
    assert.ok(!fs.lstatSync(r.cache.blobPath(sha(linked), false)).isSymbolicLink())
    assert.equal(fs.readFileSync(decoy).compare(linked), 0, 'the link\'s target was moved')
    for (const body of [manifest, stream, big, linked]) assert.ok(sameInode(path.join(epochsOf(r.layout), sha(body)), r.cache.blobPath(sha(body), false)))
    // The stray is no file of the CAS, the staging is gone, and the export's folder is gone from its container.
    assert.deepEqual(fs.readdirSync(path.join(councilDir(r.layout, 's1'), '.staging')), [])
    assert.ok(!fs.existsSync(dir))
    assert.ok(r.docker.calls.some((args) => args.join(' ') === `exec ${ROOM_CONTAINER} rm -rf -- ${COUNCIL_EPOCH_DIR}/4`))
  } finally {
    await r.close()
  }
})

test('an export that does not hash to its report, or that lies in a container that is not the class\'s own notebook kernel, cannot be had: said so, never fetched or read from anywhere else', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const kernel = hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    const stranger = hold(r, OTHER_CONTAINER, 's2', 'room', 1)
    const [manifest, stream] = [Buffer.from('{"m":5}'), randomBytes(900)]
    exported(kernel, 5, { manifest: manifest, stream: randomBytes(900) })
    exported(stranger, 6, { manifest, stream })
    exported(r.containers.get(COUNCIL_CONTAINER)!.root, 7, { manifest, stream })
    const placements = [placement(), placement({ key: 's1:room', gen: 3, workers: undefined })]
    const wrong = { ...epoch(6, manifest, [stream], exportFrom(6, OTHER_CONTAINER)), root: 'nb:b_other' }
    const own = { ...epoch(7, manifest, [stream], exportFrom(7, COUNCIL_CONTAINER)), root: 'nb:b_pool' }
    r.council.reconcile(block({ epochs: [epoch(5, manifest, [stream], exportFrom(5)), wrong, own] }, placements))
    await r.council.idle()
    const states = said(r.council).epochs
    assert.deepEqual(states.map((state) => [state.root, state.seq, state.ready, state.failed]).sort(), [['cells', 5, false, 'files'], ['nb:b_other', 6, false, 'source'], ['nb:b_pool', 7, false, 'source']])
    // Another class's container and the pool's own were never read.
    assert.deepEqual(r.docker.calls.filter((args) => args[0] === 'cp').map((args) => args[1]), [`${ROOM_CONTAINER}:${COUNCIL_EPOCH_DIR}/5`])
    assert.equal(r.cache.has(sha(stream)), false)
    // A failure is said only of an epoch home named in this life: a home without the word never meets it.
    const restarted = await rig({}, r)
    try {
      restarted.council.load()
      assert.ok(said(restarted.council).epochs.every((state) => state.failed === undefined))
    } finally {
      await restarted.close()
    }
  } finally {
    await r.close()
  }
})

test('an export that is a link where its folder should be is no export: nothing is read through it, and the epoch cannot be had', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const kernel = hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    // Another class's folder on this machine, with a dataset every class of a course has: its hash is no secret.
    const theirs = path.join(r.layout.roomsDir, 's2')
    fs.mkdirSync(theirs, { recursive: true })
    const dataset = randomBytes(4321)
    fs.writeFileSync(path.join(theirs, 'titanic.csv'), dataset)
    // The kernel's code made its export folder a link there (docker copies a link as a link), and its report names the dataset.
    fs.mkdirSync(path.join(kernel, COUNCIL_EPOCH_DIR), { recursive: true })
    fs.symlinkSync(theirs, path.join(kernel, COUNCIL_EPOCH_DIR, '4'))
    r.council.reconcile(block({ epochs: [epoch(4, Buffer.from('{"m":"forged"}'), [dataset], exportFrom(4))] }, [placement(), placement({ key: 's1:room', gen: 3, workers: undefined })]))
    await r.council.idle()
    assert.ok(fs.existsSync(path.join(theirs, 'titanic.csv')), 'a file was taken through the link, out of another class\'s folder')
    assert.equal(r.cache.has(sha(dataset)), false)
    assert.deepEqual(said(r.council).epochs.map((state) => [state.seq, state.ready, state.failed]), [[4, false, 'source']])
  } finally {
    await r.close()
  }
})

test('a refreeze named before the export ahead of it was read: that export is read first and to the end — the refreeze wrote only what changed — never fetched from home, and every folder leaves its container', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const kernel = hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    const own = hold(r, OWN_CONTAINER, 's1', 'own', 4)
    const placements = [placement(), placement({ key: 's1:room', gen: 3, workers: undefined }), placement({ key: 's1:own', gen: 4, workers: undefined })]
    // A personal notebook's export, its copy under way, holds the class's work: the class notebook's exports wait their turn.
    const [x5, y5, x6, y6] = [Buffer.from('{"x":5}'), randomBytes(500), Buffer.from('{"x":6}'), randomBytes(600)]
    const ownFolders = [exported(own, 5, { a: x5, b: y5 }), exported(own, 6, { a: x6, b: y6 })]
    let release!: () => void
    r.copying.set(`${COUNCIL_EPOCH_DIR}/5`, new Promise<void>((resolve) => { release = resolve }))
    // Each export writes only what changed since the one before it (§9.3): `big` is in the first folder alone, `old` in one this machine never read.
    const [m1, s1, big, old, m2, s2] = [Buffer.from('{"m":1}'), randomBytes(1000), randomBytes(70_000), randomBytes(2000), Buffer.from('{"m":2}'), randomBytes(1100)]
    const folders = [exported(kernel, 1, { a: m1, b: s1, c: big }), exported(kernel, 2, { a: m2, b: s2 })]
    const personal = (intent: RemoteEpochIntent): RemoteEpochIntent => ({ ...intent, root: 'nb:b_own' })
    r.council.reconcile(block({ epochs: [personal(epoch(5, x5, [y5], exportFrom(5, OWN_CONTAINER))), epoch(1, m1, [s1, big, old], exportFrom(1))] }, placements))
    // Home refroze both notebooks before this machine said either ready: its reply names the newer ones only.
    r.council.reconcile(block({ epochs: [personal(epoch(6, x6, [y6], exportFrom(6, OWN_CONTAINER))), epoch(2, m2, [s2, big], exportFrom(2))] }, placements))
    release()
    await r.council.idle()
    // The copy under way went to the end (and the personal notebook's older epoch is ready for its grace); the class notebook's newer one is whole.
    assert.deepEqual(said(r.council).epochs.map((state) => [state.root, state.seq, state.ready]).sort(), [['cells', 2, true], ['nb:b_own', 5, true], ['nb:b_own', 6, true]], r.logs.join('\n'))
    assert.equal(blobGets(r.home, sha(big)) + blobGets(r.home, sha(old)), 0)
    const copies = r.docker.calls.filter((args) => args[0] === 'cp').map((args) => args[1])
    assert.deepEqual(copies.filter((from) => from!.startsWith(ROOM_CONTAINER)), [`${ROOM_CONTAINER}:${COUNCIL_EPOCH_DIR}/1`, `${ROOM_CONTAINER}:${COUNCIL_EPOCH_DIR}/2`])
    for (const folder of [...ownFolders, ...folders]) assert.ok(!fs.existsSync(folder), `${folder} stayed in its container`)
  } finally {
    await r.close()
  }
})

test('an epoch let go before its export was read has that export removed from its container all the same: nothing will read it now', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const kernel = hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    const own = hold(r, OWN_CONTAINER, 's1', 'own', 4)
    const placements = [placement(), placement({ key: 's1:room', gen: 3, workers: undefined }), placement({ key: 's1:own', gen: 4, workers: undefined })]
    // A personal notebook's export, its copy under way, holds the class's work meanwhile.
    const [x5, y5] = [Buffer.from('{"x":5}'), randomBytes(500)]
    exported(own, 5, { a: x5, b: y5 })
    let release!: () => void
    r.copying.set(`${COUNCIL_EPOCH_DIR}/5`, new Promise<void>((resolve) => { release = resolve }))
    const personal = (intent: RemoteEpochIntent): RemoteEpochIntent => ({ ...intent, root: 'nb:b_own' })
    // The class notebook's first export, and a refreeze that wrote every buffer again (a full one): it needs nothing of the first.
    const [m1, s1, m2, s2] = [Buffer.from('{"m":1}'), randomBytes(1000), Buffer.from('{"m":2}'), randomBytes(1100)]
    const [first, second] = [exported(kernel, 1, { a: m1, b: s1 }), exported(kernel, 2, { a: m2, b: s2 })]
    r.council.reconcile(block({ epochs: [personal(epoch(5, x5, [y5], exportFrom(5, OWN_CONTAINER))), epoch(1, m1, [s1], exportFrom(1))] }, placements))
    r.council.reconcile(block({ epochs: [epoch(2, m2, [s2], exportFrom(2))] }, placements))
    release()
    await r.council.idle()
    assert.deepEqual(said(r.council).epochs.filter((state) => state.root === 'cells').map((state) => [state.seq, state.ready]), [[2, true]], r.logs.join('\n'))
    // The first was never copied, and its folder left the container nonetheless.
    assert.ok(!r.docker.calls.some((args) => args[0] === 'cp' && args[1] === `${ROOM_CONTAINER}:${COUNCIL_EPOCH_DIR}/1`))
    assert.ok(r.docker.calls.some((args) => args.join(' ') === `exec ${ROOM_CONTAINER} rm -rf -- ${COUNCIL_EPOCH_DIR}/1`), r.docker.calls.map((args) => args.join(' ')).join('\n'))
    for (const folder of [first, second]) assert.ok(!fs.existsSync(folder), `${folder} stayed in its container`)
  } finally {
    await r.close()
  }
})

test('a newer epoch that cannot be had never shadows the older one home names after it: the older one is had, the newer still said failed', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const kernel = hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    const placements = [placement(), placement({ key: 's1:room', gen: 3, workers: undefined })]
    const [m5, s5, m6, s6] = [Buffer.from('{"m":5}'), randomBytes(700), Buffer.from('{"m":6}'), randomBytes(800)]
    exported(kernel, 5, { a: m5, b: s5 })
    // The newer export is not in the container (its /tmp emptied): it cannot be had.
    r.council.reconcile(block({ epochs: [epoch(6, m6, [s6], exportFrom(6))] }, placements))
    await r.council.idle()
    assert.deepEqual(said(r.council).epochs.map((state) => [state.seq, state.ready, state.failed]), [[6, false, 'source']])
    // Home hears it failed and wants the one before it instead, which this machine no longer held.
    r.council.reconcile(block({ epochs: [epoch(5, m5, [s5], exportFrom(5))] }, placements))
    await r.council.idle()
    assert.deepEqual(said(r.council).epochs.map((state) => [state.seq, state.ready, state.failed]), [[6, false, 'source'], [5, true, undefined]], r.logs.join('\n'))
  } finally {
    await r.close()
  }
})

test('the files of an export read here go home as home asks for them: raw, under the gen of the placement they came from, once, and again only if home still asks after a while', async () => {
  const r = await rig()
  try {
    const kernel = hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    const [manifest, stream] = [Buffer.from('{"m":8}'), randomBytes(4000)]
    exported(kernel, 8, { m: manifest, s: stream })
    const named = (seq = 8) => block({ epochs: [epoch(seq, manifest, [stream], exportFrom(seq), [sha(stream)])] }, [placement({ key: 's1:room', gen: 3, workers: undefined })])
    r.answer = () => ({ kind: 'refused', status: 409, error: 'revoked', detail: 'stale' })
    r.council.reconcile(named())
    await r.council.idle()
    assert.equal(r.uploads.length, 1, r.logs.join('\n'))
    const [sent] = r.uploads
    assert.deepEqual(sent!.put, { door: `epochs/${sha(stream)}?session=s1&gen=3`, sha256: sha(stream), bytes: stream.length, gzip: false })
    assert.equal(sent!.body.compare(stream), 0)
    // Home's refusal is its word: the same reply again sends nothing...
    r.council.reconcile(named())
    await r.council.idle()
    assert.equal(r.uploads.length, 1)
    // ...until home still asks a while later (its reply had crossed the PUT): then once more.
    r.answer = () => ({ kind: 'ok' })
    r.clock.now += COUNCIL_TIMINGS.repeatMs
    r.council.reconcile(named())
    await r.council.idle()
    assert.equal(r.uploads.length, 2)
    // A reply that names the epoch no more asks for nothing more of it.
    r.clock.now += COUNCIL_TIMINGS.repeatMs
    r.council.reconcile(block({}, [placement({ key: 's1:room', gen: 3, workers: undefined })]))
    await r.council.tick()
    await r.council.idle()
    assert.equal(r.uploads.length, 2)
  } finally {
    await r.close()
  }
})

test('an agent restarted keeps its epochs: written down, their links checked against the CAS and made again, pinned before home speaks', async () => {
  const home = await fakeHome()
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'council-')))
  const containers: Rig['containers'] = new Map()
  try {
    const first = await rig({}, { home, layout, containers })
    hold(first, COUNCIL_CONTAINER, 's1', 'council', 2)
    const [manifest, stream] = [Buffer.from('{"m":9}'), randomBytes(2500)]
    for (const body of [manifest, stream]) home.blobs.set(sha(body), body)
    first.council.reconcile(block({ epochs: [epoch(9, manifest, [stream])] }))
    await first.council.idle()
    await first.close()
    // Between the lives: a link gone, and a file planted where the other was, of the right length and no blob of the CAS.
    fs.rmSync(path.join(epochsOf(layout), sha(manifest)))
    fs.rmSync(path.join(epochsOf(layout), sha(stream)))
    fs.writeFileSync(path.join(epochsOf(layout), sha(stream)), randomBytes(2500))
    fs.writeFileSync(path.join(epochsOf(layout), 'stray'), 'x')
    const second = await rig({}, { home, layout, containers })
    try {
      second.council.load()
      assert.deepEqual(said(second.council).epochs, [{ sessionId: 's1', root: 'cells', seq: 9, ready: true }])
      assert.deepEqual(fs.readdirSync(epochsOf(layout)).sort(), [sha(manifest), sha(stream)].sort())
      for (const body of [manifest, stream]) assert.ok(sameInode(path.join(epochsOf(layout), sha(body)), second.cache.blobPath(sha(body), false)))
      second.cache.evict({ manifests: new Set(), bundles: new Set(), blobs: new Set() }, () => 0, 1)
      assert.ok(second.cache.has(sha(stream)), 'an epoch an earlier life held was not pinned before home spoke')
      assert.equal(blobGets(home, sha(stream)), 1)
    } finally {
      await second.close()
    }
  } finally {
    await home.close()
  }
})

/* --------------------------------------------------------------- artifacts */

test('an attempt\'s files go home within their caps, each the regular file home named and never through a link, paced; then its folder goes, and the collection is said over until home heard it', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    councilMounts(r.layout, 's1')
    const run = path.join(scratchOf(r.layout), 'r_1')
    fs.mkdirSync(path.join(run, 'figs'), { recursive: true })
    const out = randomBytes(600 * 1024)
    const fig = Buffer.from('PNG…')
    fs.writeFileSync(path.join(run, 'out.csv'), out)
    fs.writeFileSync(path.join(run, 'figs', 'fig.png'), fig)
    // The machine's secret, and a link to it under the name and with the hash and length home was told.
    const secret = path.join(r.layout.root, 'runner.json')
    fs.writeFileSync(secret, '{"secret":"cr1.runnerab.cccc"}')
    fs.symlinkSync(secret, path.join(run, 'stolen.json'))
    fs.symlinkSync(r.layout.root, path.join(run, 'tree'))
    // Rewritten since `leave` listed it: not the file home named.
    fs.writeFileSync(path.join(run, 'changed.csv'), 'now')
    const named = [
      { name: 'out.csv', sha256: sha(out), bytes: out.length },
      { name: 'figs/fig.png', sha256: sha(fig), bytes: fig.length },
      { name: 'stolen.json', sha256: sha(fs.readFileSync(secret)), bytes: fs.statSync(secret).size },
      { name: 'tree/runner.json', sha256: sha(fs.readFileSync(secret)), bytes: fs.statSync(secret).size },
      { name: 'changed.csv', sha256: sha('then'), bytes: 4 },
    ]
    r.council.reconcile(block({ collect: [{ sessionId: 's1', runId: 'r_1', files: named }], rates: { classBulkMBps: 1, machinePaceMBps: 6 } }))
    await r.council.idle()
    assert.deepEqual(r.uploads.map((upload) => upload.put), [
      { door: 'council/s1/runs/r_1/files/out.csv?gen=2', sha256: sha(out), bytes: out.length, gzip: true },
      { door: `council/s1/runs/r_1/files/${encodeURIComponent('figs/fig.png')}?gen=2`, sha256: sha(fig), bytes: fig.length, gzip: true },
    ])
    assert.equal(zlib.gunzipSync(r.uploads[0]!.body).compare(out), 0)
    // At the class's rate (1 MB/s here), through a bucket of CLASS_PACE_BURST_BYTES: the rest of the bytes waited for it.
    const waited = r.sleeps.reduce((sum, ms) => sum + ms, 0)
    const sentBytes = r.uploads.reduce((sum, upload) => sum + upload.body.length, 0)
    assert.ok(waited >= ((sentBytes - CLASS_PACE_BURST_BYTES) / MIB) * 1000 - 50, `waited ${waited} ms for ${sentBytes} bytes`)
    // Its folder gone, the secret where it was, and the collection said over — until a sync that said it was answered.
    assert.ok(!fs.existsSync(run))
    assert.equal(fs.readFileSync(secret, 'utf8'), '{"secret":"cr1.runnerab.cccc"}')
    assert.deepEqual(said(r.council).collected, [{ sessionId: 's1', runId: 'r_1' }])
    r.council.said({ collected: [{ sessionId: 's1', runId: 'r_1' }] })
    assert.equal(said(r.council).collected, undefined)
    // Home names it again (its reply crossed that sync): said again, never sent again.
    r.council.reconcile(block({ collect: [{ sessionId: 's1', runId: 'r_1', files: named }] }))
    await r.council.idle()
    assert.deepEqual(said(r.council).collected, [{ sessionId: 's1', runId: 'r_1' }])
    assert.equal(r.uploads.length, 2)
  } finally {
    await r.close()
  }
})

test('an attempt\'s files go home through the bucket the class folders\' uploads go through: what those sent a moment ago holds them back', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    councilMounts(r.layout, 's1')
    fs.mkdirSync(path.join(scratchOf(r.layout), 'r_1'), { recursive: true })
    const out = Buffer.from('a,b\n1,2\n')
    fs.writeFileSync(path.join(scratchOf(r.layout), 'r_1', 'out.csv'), out)
    // The class folders sent four mebibytes home just now, at the class's 4 MiB/s: a second's worth of the class's rate.
    r.pacer.delay(4 * MIB, 4 * MIB)
    r.council.reconcile(block({ collect: [{ sessionId: 's1', runId: 'r_1', files: [{ name: 'out.csv', sha256: sha(out), bytes: out.length }] }] }))
    await r.council.idle()
    assert.equal(r.uploads.length, 1)
    // Nearly that second, less the bucket's burst: the two together keep to the class's rate.
    assert.ok(r.sleeps.some((ms) => ms >= 1000 - (CLASS_PACE_BURST_BYTES / (4 * MIB)) * 1000 - 5), `the attempt's file went at once: ${r.sleeps.join(', ')}`)
  } finally {
    await r.close()
  }
})

test('a gen home fences takes nothing more of a collection; with no council placement here nothing is sent, and the folder goes all the same', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    councilMounts(r.layout, 's1')
    const files = ['a.csv', 'b.csv'].map((name) => {
      const body = randomBytes(100)
      fs.mkdirSync(path.join(scratchOf(r.layout), 'r_2'), { recursive: true })
      fs.writeFileSync(path.join(scratchOf(r.layout), 'r_2', name), body)
      return { name, sha256: sha(body), bytes: body.length }
    })
    r.answer = () => ({ kind: 'refused', status: 409, error: 'revoked', detail: 'a newer gen' })
    r.council.reconcile(block({ collect: [{ sessionId: 's1', runId: 'r_2', files }] }))
    await r.council.idle()
    assert.equal(r.uploads.length, 1)
    assert.ok(!fs.existsSync(path.join(scratchOf(r.layout), 'r_2')))
    assert.deepEqual(said(r.council).collected, [{ sessionId: 's1', runId: 'r_2' }])
    // The class's council no longer here (the pool went), its room still is: nothing sent, the folder gone.
    r.containers.delete(COUNCIL_CONTAINER)
    hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    fs.mkdirSync(path.join(scratchOf(r.layout), 'r_3'), { recursive: true })
    fs.writeFileSync(path.join(scratchOf(r.layout), 'r_3', 'a.csv'), 'x')
    r.council.reconcile(block({ collect: [{ sessionId: 's1', runId: 'r_3', files: [{ name: 'a.csv', sha256: sha('x'), bytes: 1 }] }] }, [placement({ key: 's1:room', gen: 3, workers: undefined })]))
    await r.council.idle()
    assert.equal(r.uploads.length, 1)
    assert.ok(!fs.existsSync(path.join(scratchOf(r.layout), 'r_3')))
  } finally {
    await r.close()
  }
})

test('home out of reach while an attempt\'s files go: the folder stays and the attempt is not said collected; what did not go goes in a later round, what home took never again', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    councilMounts(r.layout, 's1')
    const run = path.join(scratchOf(r.layout), 'r_4')
    fs.mkdirSync(run, { recursive: true })
    const [a, b] = [randomBytes(300), randomBytes(400)]
    fs.writeFileSync(path.join(run, 'a.csv'), a)
    fs.writeFileSync(path.join(run, 'b.csv'), b)
    const collect = block({ collect: [{ sessionId: 's1', runId: 'r_4', files: [{ name: 'a.csv', sha256: sha(a), bytes: a.length }, { name: 'b.csv', sha256: sha(b), bytes: b.length }] }] })
    const puts = (name: string): number => r.uploads.filter((upload) => upload.put.door.includes(`/files/${name}?`)).length
    // Home takes the first file, then goes (a restart, the relay cut for minutes): nothing after it is answered.
    r.answer = () => (puts('b.csv') > 0 ? { kind: 'transient', reason: 'home answered 503', retryAfterMs: null } : { kind: 'ok' })
    r.council.reconcile(collect)
    await r.council.idle()
    assert.deepEqual([puts('a.csv'), puts('b.csv')], [1, 5])
    assert.ok(fs.existsSync(path.join(run, 'b.csv')), 'the folder went with a file home never had')
    assert.equal(said(r.council).collected, undefined)
    // Still out of reach at the next round: still waited for.
    r.clock.now += COUNCIL_TIMINGS.retryMs.first
    await r.council.tick()
    await r.council.idle()
    assert.equal(puts('b.csv'), 10)
    assert.equal(said(r.council).collected, undefined)
    // Home is back and still names the attempt: the file it lacks goes, the one it has never again; then the folder goes.
    r.answer = () => ({ kind: 'ok' })
    r.clock.now += COUNCIL_TIMINGS.retryMs.last
    r.council.reconcile(collect)
    await r.council.idle()
    assert.deepEqual([puts('a.csv'), puts('b.csv')], [1, 11])
    assert.ok(!fs.existsSync(run))
    assert.deepEqual(said(r.council).collected, [{ sessionId: 's1', runId: 'r_4' }])
  } finally {
    await r.close()
  }
})

test('a scratch folder no collection names goes once it is old, and a class no longer here goes whole once nothing of it runs', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    councilMounts(r.layout, 's1')
    fs.mkdirSync(path.join(scratchOf(r.layout), 'r_lost', 'deep'), { recursive: true })
    r.council.reconcile(block())
    await r.council.tick()
    assert.ok(fs.existsSync(path.join(scratchOf(r.layout), 'r_lost')), 'a folder went before its time: its attempt may still run')
    r.clock.now += COUNCIL_TIMINGS.scratchKeepMs
    await r.council.tick()
    assert.ok(!fs.existsSync(path.join(scratchOf(r.layout), 'r_lost')))
    // Home no longer names the class, but its container still goes: its mounts stay until it is gone.
    r.council.reconcile(block({}, []))
    await r.council.idle()
    assert.ok(fs.existsSync(councilDir(r.layout, 's1')))
    r.containers.clear()
    await r.council.tick()
    assert.ok(!fs.existsSync(councilDir(r.layout, 's1')))
  } finally {
    await r.close()
  }
})

test('a scratch space root\'s, which the agent cannot list: a collection reaches its run\'s folder by name, the sweep lists it through the helper now and then while its council runs, the class\'s going empties it through the helper', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    councilMounts(r.layout, 's1')
    const run = path.join(scratchOf(r.layout), 'r_1')
    fs.mkdirSync(run)
    const out = Buffer.from('a,b\n1,2\n')
    fs.writeFileSync(path.join(run, 'out.csv'), out)
    fs.mkdirSync(path.join(scratchOf(r.layout), 'r_lost', 'deep'), { recursive: true })
    // As root's 1733 is to the agent: no listing, a folder reached and removed by its name (here: the owner's bits taken away).
    fs.chmodSync(scratchOf(r.layout), 0o1333)
    assert.throws(() => fs.readdirSync(scratchOf(r.layout)), /EACCES/)
    r.council.reconcile(block({ collect: [{ sessionId: 's1', runId: 'r_1', files: [{ name: 'out.csv', sha256: sha(out), bytes: out.length }] }] }))
    await r.council.idle()
    assert.deepEqual(r.uploads.map((upload) => upload.put.door), ['council/s1/runs/r_1/files/out.csv?gen=2'])
    assert.ok(!fs.existsSync(run), 'the run\'s folder stayed')
    assert.deepEqual(said(r.council).collected, [{ sessionId: 's1', runId: 'r_1' }])
    // The sweep: the helper lists it, the stray is first seen…
    await r.council.tick()
    await r.council.idle()
    assert.deepEqual(r.scratchRuns, [{ sessionId: 's1', action: 'list' }])
    assert.ok(fs.existsSync(path.join(scratchOf(r.layout), 'r_lost')))
    // …not again within its quarter of an hour, however many beats…
    r.clock.now += 60_000
    await r.council.tick()
    await r.council.idle()
    assert.equal(r.scratchRuns.length, 1)
    // …and once it is old, gone by its name.
    r.clock.now += COUNCIL_TIMINGS.scratchKeepMs
    await r.council.tick()
    await r.council.idle()
    assert.equal(r.scratchRuns.length, 2)
    assert.ok(!fs.existsSync(path.join(scratchOf(r.layout), 'r_lost')))
    // No council container here: nothing is listed (nothing writes there; the next one's start empties it).
    r.containers.clear()
    hold(r, ROOM_CONTAINER, 's1', 'room', 3)
    r.clock.now += 60 * 60_000
    await r.council.tick()
    await r.council.idle()
    assert.equal(r.scratchRuns.length, 2)
    // The class gone from the machine: the helper empties the space, and the class's folder goes whole.
    fs.mkdirSync(path.join(scratchOf(r.layout), 'r_late'))
    r.containers.clear()
    r.council.reconcile(block({}, []))
    await r.council.tick()
    await r.council.idle()
    assert.deepEqual(r.scratchRuns.at(-1), { sessionId: 's1', action: 'remove' })
    assert.ok(!fs.existsSync(councilDir(r.layout, 's1')), r.logs.join('\n'))
  } finally {
    await r.close()
  }
})

test('a class let go while its epoch was on its way, and placed here again before it went: its epoch comes all the same', async () => {
  const r = await rig()
  try {
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 2)
    const [manifest, stream] = [Buffer.from('{"m":11}'), randomBytes(1000)]
    for (const body of [manifest, stream]) r.home.blobs.set(sha(body), body)
    const intent = epoch(11, manifest, [stream])
    let release!: () => void
    r.fetching = new Promise<void>((resolve) => { release = resolve })
    r.council.reconcile(block({ epochs: [intent] }))
    // The pool leaves this machine mid-fetch (its container gone, home names the class nowhere here): the fetch is given up.
    r.containers.clear()
    r.council.reconcile(block({}, []))
    await r.council.idle()
    assert.deepEqual(said(r.council).epochs.map((state) => [state.seq, state.ready]), [[11, false]])
    // Placed here again at once, the epoch still named: it comes.
    r.fetching = null
    release()
    hold(r, COUNCIL_CONTAINER, 's1', 'council', 3)
    r.council.reconcile(block({ epochs: [intent] }, [placement({ gen: 3 })]))
    await r.council.idle()
    assert.deepEqual(said(r.council).epochs, [{ sessionId: 's1', root: 'cells', seq: 11, ready: true }], r.logs.join('\n'))
  } finally {
    await r.close()
  }
})

/* -------------------------------------------------------------- the doors */

test('home\'s council doors are called as the agent calls home: the credential, the hash and length, gzip only for an attempt\'s files, and a proxy\'s 413 a refusal', async () => {
  const seen: Array<{ path: string; headers: IncomingMessage['headers']; body: Buffer }> = []
  let status = 200
  let marker = true
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    seen.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
    res.writeHead(status, { 'Content-Type': 'application/json', ...(marker ? { [REMOTE_MARKER_HEADER]: REMOTE_MARKER } : {}) })
    res.end(status === 200 ? '{}' : JSON.stringify({ error: status === 409 ? 'revoked' : 'too_large' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const home = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const upload = councilUploader({ home, credential: () => 'cr1.runnerab.secret' })
  const body = (bytes: Buffer) => new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(bytes); controller.close() } })
  try {
    const raw = randomBytes(64)
    assert.deepEqual(await upload({ door: `epochs/${sha(raw)}?session=s1&gen=3`, sha256: sha(raw), bytes: raw.length, gzip: false, body: body(raw), signal: AbortSignal.timeout(5_000) }), { kind: 'ok' })
    const [epochPut] = seen
    assert.equal(epochPut!.path, `${REMOTE_API_BASE}/epochs/${sha(raw)}?session=s1&gen=3`)
    assert.equal(epochPut!.headers.authorization, 'Bearer cr1.runnerab.secret')
    assert.equal(epochPut!.headers[REMOTE_SHA256_HEADER.toLowerCase()], sha(raw))
    assert.equal(epochPut!.headers[REMOTE_BYTES_HEADER.toLowerCase()], String(raw.length))
    assert.equal(epochPut!.headers['content-encoding'], undefined)
    assert.equal(epochPut!.body.compare(raw), 0)
    const zipped = zlib.gzipSync(raw)
    await upload({ door: 'council/s1/runs/r_1/files/out.csv?gen=2', sha256: sha(raw), bytes: raw.length, gzip: true, body: body(zipped), signal: AbortSignal.timeout(5_000) })
    assert.equal(seen[1]!.headers['content-encoding'], 'gzip')
    status = 409
    assert.deepEqual(await upload({ door: 'council/s1/runs/r_1/files/out.csv?gen=1', sha256: sha(raw), bytes: raw.length, gzip: true, body: body(zipped), signal: AbortSignal.timeout(5_000) }), { kind: 'refused', status: 409, error: 'revoked', detail: '' })
    status = 413
    marker = false
    const proxy = await upload({ door: 'council/s1/runs/r_1/files/out.csv?gen=2', sha256: sha(raw), bytes: raw.length, gzip: true, body: body(zipped), signal: AbortSignal.timeout(5_000) })
    assert.equal(proxy.kind === 'refused' && proxy.proxy, true)
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  }
})

/* ----------------------------------------------------------- through the sync */

test('the agent\'s sync says its epochs and the collections over, of what home named only: a home that names none never meets the new keys', async () => {
  const home = await fakeHome()
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'council-agent-')))
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const [manifest, stream] = [Buffer.from('{"m":10}'), randomBytes(3000)]
  for (const body of [manifest, stream]) home.blobs.set(sha(body), body)
  const room = placement({ key: 's1:room', gen: 1, memoryMb: 4096, cpus: 2, pids: 512, workers: undefined })
  // First a home whose block names no epoch and no attempt.
  let council = false
  home.onSync = () => ({
    json: syncReply({
      want: { revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }], data: [], bundles: [] },
      kernels: block(council ? { epochs: [epoch(10, manifest, [stream])], collect: [{ sessionId: 's1', runId: 'r_9', files: [] }] } : {}, [room]),
    }),
    delayMs: 20,
  })
  const agent = new Agent({
    layout, join: { home: home.url, code: '0123456789abcdef0123456789abcdef' }, build: 'dev', version: '0.26.0', container: 'colloq-runner',
    image: 'ghcr.io/colloq-edu/colloq-server:0.26.0', docker, runner: new FakeSeam(),
    machine: () => ({ memTotalMb: 16_000, memAvailableMb: 15_000, cpus: 16, diskFreeMb: 500_000, diskTotalMb: 1_000_000 }),
    backoffMs: { min: 5, max: 20 }, stopMs: 2_000, log: () => undefined,
    tunnel: () => ({ want: () => undefined, state: () => ({ up: false, rttMs: null, since: 0 }), close: async () => undefined }),
    classes: { probe: async () => true, timings: { censusMs: 3_600_000 } },
    council: { beatMs: 50 },
  })
  // One bucket for every byte of the classes going home: the class folders' and the council's (sync.ts).
  const buckets = agent as unknown as { files: { upPacer: unknown }; council: { pacer: unknown } }
  assert.ok(buckets.files.upPacer instanceof Pacer && buckets.files.upPacer === buckets.council.pacer)
  const running = agent.run()
  try {
    await waitFor(() => home.syncs().filter((sync) => sync.kernels).length >= 3, 'blocks from a home that names no epoch')
    assert.ok(home.syncs().every((sync) => !sync.kernels || (sync.kernels.epochs.length === 0 && !('collected' in sync.kernels))))
    council = true
    const ready = await waitFor(() => home.syncs().find((sync) => sync.kernels?.epochs.some((state) => state.ready)), 'an epoch said ready', 20_000)
    assert.deepEqual(ready.kernels!.epochs, [{ sessionId: 's1', root: 'cells', seq: 10, ready: true }])
    await waitFor(() => home.syncs().find((sync) => sync.kernels?.collected?.some((entry) => entry.runId === 'r_9')), 'the collection said over')
    // The sync's own parse at home took every block: close() fails on any it refused.
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})
