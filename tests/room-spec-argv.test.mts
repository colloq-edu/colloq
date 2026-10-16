/**
 * A class kernel's `docker run` is the same on a machine as at home
 * (docs/architecture/remote-classes.md §7.1, §12 «Kept invariants»): home's
 * pool (kernel/pool.ts · runArgs) and a machine's agent (kernel/room-spec.ts ·
 * machineRoomRunArgs) lay it out with one function, and this file holds the
 * two argvs equal flag for flag.
 *
 * BOTH SIDES ARE BUILT BY THEIR OWN CODE: home's from its own wrapper, which
 * reads its settings and derives its token; the machine's from a spec the way
 * an intent fills it. Only what is not the sandbox may differ, and each
 * difference is named: the container's name, its image (home runs the
 * environment's tag, a machine the pinned revision's), its class folder's
 * source and its extra folders (the machine's copy, the council's epochs and
 * scratch), its token, its network (the machine's own bridge), the kind label
 * (`class-kernel`, which home's census never reads), the placement and
 * instance labels, `--pull=never`, the log caps, and the publishing when home
 * itself runs in a container. A flag lost on one side — the process ceiling,
 * `--cap-drop=ALL`, a thread variable, the hash seed — is a sandbox that
 * differs where nobody looks.
 *
 * And PYTHONHASHSEED (D28): the seventh variable of every class container,
 * one number per class, which never makes home recreate a container that was
 * started without it. And a dead kernel's reading (§7.4): a machine asks its
 * container home's three questions and parses the answers as home does
 * (kernel/postmortem-core.ts).
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { createSession } from '../server/src/db.js'
import { dropRoomKernel, endpointForSession, forgetSessionKernel, roomContainer, roomShm, runArgs } from '../server/src/kernel/pool.js'
import { forgetPerimeter, ownPidsLimit, pidsLimit, roomNetworkMode, roomProfile } from '../server/src/kernel/perimeter.js'
import { machinePerimeter, profileFor } from '../server/src/kernel/perimeter-core.js'
import {
  CLASS_KERNEL_LABEL,
  HASH_SEED_MAX,
  MACHINE_ROOM_FLAGS,
  ROOM_KERNEL_LABEL,
  ROOM_SHM,
  classHashSeed,
  machineRoomContainer,
  machineRoomRunArgs,
  placementLabel,
  roomRunArgs,
  slotOfPlacementLabel,
  type MachineRoomSpec,
  type RoomMount,
  type RoomRole,
} from '../server/src/kernel/room-spec.js'
import { readContainer, useDockerForPostmortem } from '../server/src/kernel/postmortem.js'
import { CGROUP_SCRIPT, killedByMemory, parseReading, readingArgs } from '../server/src/kernel/postmortem-core.js'
import { forgetResources, useDockerInfo } from '../server/src/kernel/resources.js'
import { INSTANCE_LABEL } from '../server/src/runner-agent/images.js'
import { RUNTIME_SESSION_ID } from '../shared/runtime.js'

function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  const restore = () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const out = body()
    if (out instanceof Promise) return out.finally(restore) as T
    restore()
    return out
  } catch (err) {
    restore()
    throw err
  }
}

/** The defaults every case starts from: no setting of the instance's own. */
const DEFAULTS = {
  KERNEL_MEM: undefined,
  KERNEL_CPUS: undefined,
  KERNEL_PIDS: undefined,
  KERNEL_OWN_PIDS: undefined,
  KERNEL_SHM: undefined,
  COLLOQ_ROOM_NETWORK: undefined,
}

/** A machine's instance label, in the agent's shape (runner-agent/images.ts · INSTANCE_LABEL). */
const LABEL = 'ru.colloq.competition-instance=a1b2c3d4e5f60718'
const I6 = 'a1b2c3'
const BRIDGE = `colloq-mrooms-${I6}`
const HOME_MOUNT = '/srv/workspace/cl1'
const MACHINE_MOUNT = '/var/lib/colloq-runner/rooms/cl1'
const MACHINE_IMAGE = 'colloq-revision:rev-7f3a'
/** What home's placementToken would be: 40 hex characters of its own (§6.9). */
const MACHINE_TOKEN = 'f'.repeat(40)
const GEN = 3
const COUNCIL_MOUNTS: readonly RoomMount[] = [
  { source: '/var/lib/colloq-runner/council/cl1/epochs', target: '/colloq/epochs', readOnly: true },
  { source: '/var/lib/colloq-runner/council/cl1/scratch', target: '/colloq/scratch', readOnly: false },
]

/** The flags that take a value as the next element. */
const PAIRED = new Set(['--name', '--network', '-p', '-e', '-v', '--label', '--gpus'])

/** An argv as flags: `-e X` is one flag, `--memory=4096m` is one, the image is the last. */
function flags(args: readonly string[]): string[] {
  const out: string[] = []
  for (let at = 0; at < args.length; at++) {
    if (PAIRED.has(args[at]!)) {
      out.push(`${args[at]} ${args[at + 1]}`)
      at++
    } else out.push(args[at]!)
  }
  return out
}

/** The container's environment, in order. */
const envOf = (args: readonly string[]): string[] => flags(args).filter((flag) => flag.startsWith('-e ')).map((flag) => flag.slice(3))

interface Case {
  what: string
  role: RoomRole
  env: string
  gpu: string | null
  mode?: 'none'
  /** Home's KERNEL_SHM. */
  shm?: string
  /** Home's server in a container: KERNEL_NETWORK by name, the port not published. */
  containerForm?: boolean
}

const CASES: Case[] = [
  { what: 'the class notebooks', role: 'room', env: 'base', gpu: null },
  { what: 'the personal notebooks', role: 'own', env: 'base', gpu: null },
  { what: 'the council', role: 'council', env: 'base', gpu: null },
  { what: 'a GPU room', role: 'room', env: 'base-gpu', gpu: '1' },
  { what: 'a GPU room on a home with KERNEL_SHM', role: 'room', env: 'base-gpu', gpu: '1', shm: '4g' },
  { what: 'the none mode', role: 'room', env: 'base', gpu: null, mode: 'none' },
  { what: 'a home in a container', role: 'room', env: 'base', gpu: null, containerForm: true },
]

/** Home's argv for a case, from its own wrapper; and the numbers the machine's intent would carry for it. */
function homeSide(c: Case): { args: string[]; pids: number; memoryMb: number; cpus: number; shm: string } {
  return withEnv({ ...DEFAULTS, COLLOQ_ROOM_NETWORK: c.mode, KERNEL_SHM: c.shm }, () => ({
    args: runArgs({
      sessionId: 'cl1',
      env: c.env,
      mount: HOME_MOUNT,
      network: c.containerForm ? 'colloq' : 'colloq-rooms',
      publish: !c.containerForm,
      gpu: c.gpu,
      role: c.role,
      memoryMb: 6144,
      cpus: 3,
    }),
    pids: c.role === 'room' ? pidsLimit() : ownPidsLimit(),
    memoryMb: 6144,
    cpus: 3,
    // Part of the class container's memory, not of the host: the intent carries home's value.
    shm: roomShm(),
  }))
}

/** The machine's spec for the same case, as an intent fills it. */
function machineSpec(c: Case, home: { pids: number; memoryMb: number; cpus: number; shm: string }): MachineRoomSpec {
  const mode = c.mode ?? 'blocked'
  return {
    role: c.role,
    sessionId: 'cl1',
    environment: c.env,
    image: MACHINE_IMAGE,
    mount: MACHINE_MOUNT,
    extraMounts: c.role === 'council' ? COUNCIL_MOUNTS : [],
    gpu: c.gpu,
    memoryMb: home.memoryMb,
    cpus: home.cpus,
    pids: home.pids,
    mode,
    profile: profileFor(mode),
    token: MACHINE_TOKEN,
    hashSeed: classHashSeed('cl1'),
    shm: home.shm,
  }
}

const mountFlag = (mount: RoomMount) => `-v ${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`

for (const c of CASES) {
  test(`${c.what}: the machine's docker run is home's, flag for flag, but for the named differences`, () => {
    const home = homeSide(c)
    const machine = machineRoomRunArgs(machineSpec(c, home), { instanceLabel: LABEL, gen: GEN })
    const ro = c.role === 'council' ? ':ro' : ''
    const homeName = roomContainer('cl1', c.role)
    const machineName = `colloq-class-${I6}-cl1-${c.role}`

    /*
     * Home's flags, each named difference put in its place: what is replaced
     * where it stands, what is added right after what it belongs to. Every
     * other flag must be in the machine's argv exactly as at home, in the
     * same order.
     */
    const expected = flags(home.args).flatMap((flag): string[] => {
      if (flag === `--name ${homeName}`) return [`--name ${machineName}`]
      if (flag === `--network ${c.containerForm ? 'colloq' : 'colloq-rooms'}`) {
        return c.containerForm ? [`--network ${BRIDGE}`, '-p 127.0.0.1:0:8888'] : [`--network ${BRIDGE}`]
      }
      if (flag.startsWith('-e JUPYTER_TOKEN=')) return [`-e JUPYTER_TOKEN=${MACHINE_TOKEN}`]
      if (flag === `-v ${HOME_MOUNT}:/workspace/cl1${ro}`) {
        return [`-v ${MACHINE_MOUNT}:/workspace/cl1${ro}`, ...(c.role === 'council' ? COUNCIL_MOUNTS.map(mountFlag) : [])]
      }
      if (flag === `--label ${ROOM_KERNEL_LABEL}`) return [`--label ${CLASS_KERNEL_LABEL}`]
      if (flag === `colloq-kernel:${c.env}`) {
        return [`--label colloq.placement=cl1:${c.role}:${GEN}`, `--label ${LABEL}`, ...MACHINE_ROOM_FLAGS, MACHINE_IMAGE]
      }
      return [flag]
    })
    assert.deepEqual(flags(machine), expected)

    // The differences, listed: exactly the named ones, and nothing else either way.
    const only = (a: string[], b: string[]) => a.filter((flag) => !b.includes(flag))
    const homeFlags = flags(home.args)
    const machineFlags = flags(machine)
    assert.deepEqual(only(homeFlags, machineFlags), [
      `--name ${homeName}`,
      `--network ${c.containerForm ? 'colloq' : 'colloq-rooms'}`,
      homeFlags.find((flag) => flag.startsWith('-e JUPYTER_TOKEN='))!,
      `-v ${HOME_MOUNT}:/workspace/cl1${ro}`,
      `--label ${ROOM_KERNEL_LABEL}`,
      `colloq-kernel:${c.env}`,
    ])
    assert.deepEqual(only(machineFlags, homeFlags), [
      `--name ${machineName}`,
      `--network ${BRIDGE}`,
      ...(c.containerForm ? ['-p 127.0.0.1:0:8888'] : []),
      `-e JUPYTER_TOKEN=${MACHINE_TOKEN}`,
      `-v ${MACHINE_MOUNT}:/workspace/cl1${ro}`,
      ...(c.role === 'council' ? COUNCIL_MOUNTS.map(mountFlag) : []),
      `--label ${CLASS_KERNEL_LABEL}`,
      `--label colloq.placement=cl1:${c.role}:${GEN}`,
      `--label ${LABEL}`,
      ...MACHINE_ROOM_FLAGS,
      MACHINE_IMAGE,
    ])

    // PYTHONHASHSEED is the seventh variable on both sides, with the class's one number.
    for (const args of [home.args, machine]) {
      const env = envOf(args)
      assert.equal(env.length, 7, JSON.stringify(env))
      assert.equal(env[6], `PYTHONHASHSEED=${classHashSeed('cl1')}`)
      // A card's /dev/shm is the class's on both sides, home's KERNEL_SHM included; no card, none.
      assert.deepEqual(args.filter((arg) => arg.startsWith('--shm-size')), c.gpu ? [`--shm-size=${c.shm ?? ROOM_SHM}`] : [])
    }
  })
}

test('the seven variables are the six of before plus the class hash seed, in that order', () => {
  const args = withEnv(DEFAULTS, () => runArgs({ sessionId: 'cl1', env: 'base', mount: HOME_MOUNT, network: 'colloq-rooms', publish: true, gpu: null }))
  const env = envOf(args)
  assert.match(env[0]!, /^JUPYTER_TOKEN=[0-9a-f]{40}$/)
  assert.deepEqual(env.slice(1), [
    'OMP_NUM_THREADS=2',
    'MKL_NUM_THREADS=2',
    'OPENBLAS_NUM_THREADS=2',
    'NUMEXPR_NUM_THREADS=2',
    'PLOTLY_RENDERER=plotly_mimetype',
    `PYTHONHASHSEED=${classHashSeed('cl1')}`,
  ])
  // The variable sits with the others: before the folder, after the token and the threads.
  assert.ok(args.indexOf(`PYTHONHASHSEED=${classHashSeed('cl1')}`) < args.indexOf('-v'))
})

test("one seed per class: the room's, the personal notebooks' and the council's containers share it, another class has another", () => {
  const seedOf = (sessionId: string, role: RoomRole) =>
    envOf(withEnv(DEFAULTS, () => runArgs({ sessionId, env: 'base', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null, role }))).at(-1)
  const seeds = (['room', 'own', 'council'] as const).map((role) => seedOf('cl1', role))
  assert.deepEqual(seeds, Array(3).fill(`PYTHONHASHSEED=${classHashSeed('cl1')}`))
  assert.notEqual(seedOf('cl2', 'room'), seeds[0])
})

test('classHashSeed is 1 + (sha256("colloq-hashseed:" + id) mod 4294967295): never 0, never past what Python takes', () => {
  // The number, pinned: a class keeps its seed across releases, at home and on every machine.
  assert.equal(classHashSeed('r1'), 3677742916)
  assert.equal(HASH_SEED_MAX, 4294967295)
  const ids = ['', 'r1', 'pvhu2h7f', 'x'.repeat(64), ...Array.from({ length: 300 }, (_, i) => `class-${i}`)]
  const seen = new Set<number>()
  for (const id of ids) {
    const digest = BigInt(`0x${createHash('sha256').update(`colloq-hashseed:${id}`).digest('hex')}`)
    const seed = classHashSeed(id)
    assert.equal(seed, Number(digest % 4294967295n) + 1, id)
    assert.ok(Number.isSafeInteger(seed) && seed >= 1 && seed <= HASH_SEED_MAX, `${id}: ${seed}`)
    assert.equal(classHashSeed(id), seed, 'not deterministic')
    seen.add(seed)
  }
  assert.equal(seen.size, ids.length, 'two classes of this list share a seed')
})

test("pool.ts · runArgs is a wrapper: the core's argv for the spec home's own sources give", () => {
  withEnv({ ...DEFAULTS, KERNEL_PIDS: '1024', KERNEL_OWN_PIDS: '4096', KERNEL_SHM: '2g', COLLOQ_ROOM_NETWORK: 'none' }, () => {
    for (const role of ['room', 'own', 'council'] as const) {
      const home = runArgs({ sessionId: 'cl1', env: 'base-gpu', mount: HOME_MOUNT, network: 'colloq-rooms', publish: true, gpu: '0', role, memoryMb: 8192, cpus: 2.5 })
      const token = envOf(home)[0]!.slice('JUPYTER_TOKEN='.length)
      assert.deepEqual(home, roomRunArgs({
        name: roomContainer('cl1', role),
        role,
        sessionId: 'cl1',
        environment: 'base-gpu',
        image: 'colloq-kernel:base-gpu',
        mount: HOME_MOUNT,
        extraMounts: [],
        network: 'colloq-rooms',
        publish: true,
        gpu: '0',
        memoryMb: 8192,
        cpus: 2.5,
        pids: role === 'room' ? 1024 : 4096,
        mode: roomNetworkMode(),
        profile: roomProfile(),
        token,
        hashSeed: classHashSeed('cl1'),
        shm: '2g',
        labels: [],
      }), role)
    }
  })
})

test('every container of a class has a token of its own: a line in a draft or an attempt never opens the lecture', () => {
  const tokenOf = (role: RoomRole) =>
    envOf(withEnv(DEFAULTS, () => runArgs({ sessionId: 'cl1', env: 'base', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null, role })))[0]
  const tokens = (['room', 'own', 'council'] as const).map(tokenOf)
  assert.equal(new Set(tokens).size, 3, JSON.stringify(tokens))
  assert.equal(roomContainer('cl1', 'council'), 'colloq-room-cl1-council')
})

/* ------------------------------------------------------------ the machine's */

const spec = (over: Partial<MachineRoomSpec> = {}): MachineRoomSpec => ({
  role: 'room',
  sessionId: 'cl1',
  environment: 'base',
  image: MACHINE_IMAGE,
  mount: MACHINE_MOUNT,
  extraMounts: [],
  gpu: null,
  memoryMb: 4096,
  cpus: 2,
  pids: 512,
  mode: 'blocked',
  profile: '1',
  token: MACHINE_TOKEN,
  hashSeed: classHashSeed('cl1'),
  shm: ROOM_SHM,
  ...over,
})

test("a machine's class container: its name, its bridge, Jupyter on 127.0.0.1 only, its labels and never a pull", () => {
  for (const role of ['room', 'own', 'council'] as const) {
    const args = machineRoomRunArgs(spec({ role }), { instanceLabel: LABEL, gen: 9 })
    assert.equal(args[args.indexOf('--name') + 1], `colloq-class-${I6}-cl1-${role}`)
    assert.equal(machineRoomContainer(LABEL, 'cl1', role), `colloq-class-${I6}-cl1-${role}`)
    assert.equal(args[args.indexOf('--network') + 1], BRIDGE)
    // Published on the loopback alone: a rented VM's public address never sees port 8888.
    assert.deepEqual(flags(args).filter((flag) => flag.startsWith('-p ')), ['-p 127.0.0.1:0:8888'])
    const labels = flags(args).filter((flag) => flag.startsWith('--label ')).map((flag) => flag.slice(8))
    assert.deepEqual(labels, [
      'colloq.profile=1',
      'colloq.kind=class-kernel',
      'colloq.session=cl1',
      'colloq.environment=base',
      `colloq.role=${role}`,
      `colloq.placement=cl1:${role}:9`,
      LABEL,
    ])
    // Home's census looks for room-kernel and must never meet a machine's container.
    assert.ok(!args.includes(ROOM_KERNEL_LABEL), JSON.stringify(args))
    // Never a pull, and the submission runs' log caps, once each, right before the image.
    assert.deepEqual(args.slice(-MACHINE_ROOM_FLAGS.length - 1), [...MACHINE_ROOM_FLAGS, MACHINE_IMAGE])
    assert.deepEqual(MACHINE_ROOM_FLAGS, ['--pull=never', '--log-driver=local', '--log-opt=max-size=8m', '--log-opt=max-file=2'])
  }
})

test("the card goes to the class's own container only, and with it its label and its shared memory", () => {
  const room = machineRoomRunArgs(spec({ environment: 'base-gpu', gpu: '1' }), { instanceLabel: LABEL, gen: 1 })
  assert.equal(room[room.indexOf('--gpus') + 1], 'device=1')
  assert.ok(room.includes('colloq.gpu=1') && room.includes(`--shm-size=${ROOM_SHM}`), JSON.stringify(room))
  // A card passed for the personal notebooks or the council is a caller's mistake, and gives them nothing.
  for (const role of ['own', 'council'] as const) {
    const args = machineRoomRunArgs(spec({ role, environment: 'base-gpu', gpu: '1' }), { instanceLabel: LABEL, gen: 1 })
    assert.ok(!args.includes('--gpus'), `${role}: ${JSON.stringify(args)}`)
    assert.ok(!args.some((arg) => arg.startsWith('colloq.gpu=') || arg.startsWith('--shm-size')), `${role}: ${JSON.stringify(args)}`)
    const home = withEnv(DEFAULTS, () => runArgs({ sessionId: 'cl1', env: 'base-gpu', mount: '/m', network: 'colloq-rooms', publish: true, gpu: '0', role }))
    assert.ok(!home.includes('--gpus') && !home.some((arg) => arg.startsWith('colloq.gpu=')), `${role} at home: ${JSON.stringify(home)}`)
  }
})

test('the council sees the class folder read-only, and its epochs and scratch as it is given them', () => {
  const council = machineRoomRunArgs(spec({ role: 'council', pids: 2048, extraMounts: COUNCIL_MOUNTS }), { instanceLabel: LABEL, gen: 2 })
  assert.deepEqual(flags(council).filter((flag) => flag.startsWith('-v ')), [
    `-v ${MACHINE_MOUNT}:/workspace/cl1:ro`,
    '-v /var/lib/colloq-runner/council/cl1/epochs:/colloq/epochs:ro',
    '-v /var/lib/colloq-runner/council/cl1/scratch:/colloq/scratch',
  ])
  assert.ok(council.includes('--pids-limit=2048'))
  // The class's and the personal notebooks' containers write the class folder, as at home.
  for (const role of ['room', 'own'] as const) {
    const args = machineRoomRunArgs(spec({ role }), { instanceLabel: LABEL, gen: 2 })
    assert.deepEqual(flags(args).filter((flag) => flag.startsWith('-v ')), [`-v ${MACHINE_MOUNT}:/workspace/cl1`])
  }
})

test('the none mode reaches a machine container as it reaches home: the blackhole resolver and its profile label', () => {
  const args = machineRoomRunArgs(spec({ mode: 'none', profile: profileFor('none') }), { instanceLabel: LABEL, gen: 1 })
  assert.ok(args.includes('--dns=192.0.2.1') && args.includes('colloq.profile=1-none'), JSON.stringify(args))
  assert.ok(!machineRoomRunArgs(spec(), { instanceLabel: LABEL, gen: 1 }).some((arg) => arg.startsWith('--dns')))
})

test("the agent's own instance label names its containers and its bridge by its first six hex characters", () => {
  const i6 = /=([0-9a-f]{6})/.exec(INSTANCE_LABEL)![1]!
  assert.equal(machineRoomContainer(INSTANCE_LABEL, 'cl1', 'own'), `colloq-class-${i6}-cl1-own`)
  assert.equal(machinePerimeter(INSTANCE_LABEL).network, `colloq-mrooms-${i6}`)
  const args = machineRoomRunArgs(spec(), { instanceLabel: INSTANCE_LABEL, gen: 4 })
  assert.ok(args.includes(INSTANCE_LABEL), JSON.stringify(args))
})

test('the placement label reads back as the slot it names, and anything else reads as none', () => {
  for (const role of ['room', 'own', 'council'] as const) {
    const label = placementLabel({ sessionId: 'cl_1-x', role, gen: 12 })
    assert.equal(label, `colloq.placement=cl_1-x:${role}:12`)
    assert.deepEqual(slotOfPlacementLabel(label.slice('colloq.placement='.length)), { sessionId: 'cl_1-x', role, gen: 12 })
  }
  for (const junk of ['', 'cl1', 'cl1:room', 'cl1:room:0', 'cl1:room:-1', 'cl1:room:1.5', 'cl1:guest:1', 'c l1:room:1', 'cl1:room:1:2', `cl1:room:${'9'.repeat(17)}`]) {
    assert.equal(slotOfPlacementLabel(junk), null, junk)
  }
  // The id alphabet is the broker's own, which a container name and a label can carry as is.
  for (const id of ['cl1', 'A-b_9', 'x'.repeat(64)]) assert.ok(RUNTIME_SESSION_ID.test(id) && slotOfPlacementLabel(`${id}:room:1`) !== null, id)
  for (const id of ['x'.repeat(65), 'a/b', 'a:b', '../a', '']) {
    assert.equal(RUNTIME_SESSION_ID.test(id), false, id)
    assert.throws(() => machineRoomContainer(LABEL, id, 'room'), /not a class id/, id)
  }
})

test('a spec that would leave a container without a ceiling is refused, never laid out', () => {
  const placement = { instanceLabel: LABEL, gen: 1 }
  // Docker reads 0 as "no limit" for memory, CPUs and processes; Python does not start past its seed range.
  for (const [field, value] of [['memoryMb', 0], ['memoryMb', 0.5], ['memoryMb', NaN], ['cpus', 0], ['cpus', -1], ['pids', 0], ['pids', 1.5], ['hashSeed', -1], ['hashSeed', HASH_SEED_MAX + 1], ['hashSeed', 0.5]] as const) {
    assert.throws(() => machineRoomRunArgs(spec({ [field]: value } as Partial<MachineRoomSpec>), placement), new RegExp(`out of range: ${field}`), `${field} ${value}`)
  }
  assert.throws(() => machineRoomRunArgs(spec(), { instanceLabel: 'colloq.kind=runner-check', gen: 1 }), /not an agent instance label/)
  assert.throws(() => machineRoomRunArgs(spec(), { instanceLabel: LABEL, gen: 0 }), /not a placement generation/)
  assert.throws(() => machineRoomRunArgs(spec({ role: 'guest' as RoomRole }), placement), /not a class container role/)
  assert.throws(() => machineRoomRunArgs(spec({ sessionId: 'a:b' }), placement), /not a class id/)
})

/* --------------------------------------------------------- a dead kernel */

test('a dead kernel is read on a machine as home reads it: the same three questions, the answers parsed the same', async () => {
  const answers = {
    inspect: { code: 0, out: 'exited 137 true 2147483648' },
    cgroup: { code: 0, out: 'limit 2147483648\nlimit \npeak 2149163008\ncurrent 0\nkills 3\nkills ' },
    logs: { code: 0, out: 'Kernel is running over TCP without encryption.\n\nKilled\n' },
  }
  const asked: string[][] = []
  useDockerForPostmortem(async (args) => {
    asked.push(args)
    return args[0] === 'exec' ? answers.cgroup : args[0] === 'logs' ? answers.logs : answers.inspect
  })
  try {
    const home = await readContainer('cl1', 'own')
    const questions = readingArgs(roomContainer('cl1', 'own'))
    assert.deepEqual(asked, [questions.inspect, questions.cgroup, questions.logs])
    assert.deepEqual(parseReading(answers), home)
    assert.deepEqual(home, {
      limit: 2147483648, peak: 2149163008, current: null, kills: 3,
      containerOomKilled: true, status: 'exited', exit: 137, tail: ['Killed'],
    })
  } finally {
    useDockerForPostmortem(null)
  }
  // A machine's container is asked the same, by its own name, and judged by home's rule.
  const name = machineRoomContainer(LABEL, 'cl1', 'room')
  assert.deepEqual(readingArgs(name), {
    inspect: ['inspect', name, '--format', '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.HostConfig.Memory}}'],
    cgroup: ['exec', name, 'sh', '-c', CGROUP_SCRIPT],
    logs: ['logs', '--tail', '40', name],
  })
  assert.equal(killedByMemory(parseReading(answers), 2), true)
  assert.equal(killedByMemory(parseReading(answers), 3), false)
  // Nothing answered: a reading of nothing, never a guess.
  const silent = { code: 1, out: 'Error: No such container' }
  assert.deepEqual(parseReading({ inspect: silent, cgroup: silent, logs: silent }), {
    limit: null, peak: null, current: null, kills: null, containerOomKilled: false, status: '', exit: null, tail: [],
  })
})

/* ------------------------------------------------------------- home's pool */

const SERVER_IMAGE = `sha256:${'9'.repeat(64)}`
type Reply = { code: number; out: string }

/**
 * The server in a container on `room-net`, with one room container of the
 * given state, started before PYTHONHASHSEED: its environment has the six
 * variables of before, and the fake says so whenever it is asked.
 */
function fakeDocker(container: { name: string; state: 'exited' | 'running' }) {
  const old = { ...process.env }, oldSpawn = cp.spawn, oldFetch = globalThis.fetch, exists = fs.existsSync
  Object.assign(process.env, { KERNEL_BACKEND: 'docker', KERNEL_ISOLATION: 'required', KERNEL_NETWORK: 'room-net', COLLOQ_CONTAINER: 'colloq-app' })
  delete process.env.COLLOQ_ROOM_NETWORK
  fs.existsSync = ((p: fs.PathLike) => p === '/.dockerenv' || exists(p)) as typeof fs.existsSync
  const live = new Map([[container.name, { ...container }]])
  const oldEnv = ['JUPYTER_TOKEN=x', 'OMP_NUM_THREADS=2', 'MKL_NUM_THREADS=2', 'OPENBLAS_NUM_THREADS=2', 'NUMEXPR_NUM_THREADS=2', 'PLOTLY_RENDERER=plotly_mimetype']
  const calls: string[][] = []
  const answer = (args: string[]): Reply => {
    calls.push(args)
    if (args[0] === 'network') return { code: 0, out: args.at(-1)!.includes('Subnet') ? '10.213.0.0/22' : 'ready' }
    if (args[0] === 'version' || args[0] === 'image') return { code: 0, out: 'ready' }
    if (args[0] === 'ps') return { code: 0, out: '' }
    if (args[0] === 'inspect' && args[1] === '--type') {
      return args.at(-1) === 'colloq-app' ? { code: 0, out: SERVER_IMAGE } : { code: 1, out: 'No such container' }
    }
    if (args[0] === 'inspect') {
      const found = live.get(args[1]!)
      if (!found) return { code: 1, out: 'No such container' }
      const format = args.join(' ')
      if (format.includes('Env')) return { code: 0, out: JSON.stringify(oldEnv) }
      if (format.includes('HostConfig.Memory')) return { code: 0, out: `${4096 * 1024 ** 2} 2000000000` }
      if (format.includes('State')) return { code: 0, out: found.state }
      if (format.includes('.Image')) return { code: 0, out: 'ready' }
      if (format.includes('profile')) return { code: 0, out: '1' }
      if (format.includes('NetworkMode')) return { code: 0, out: 'room-net' }
      return { code: 0, out: '' }
    }
    if (args[0] === 'run') {
      if (args.includes('--privileged')) return { code: 0, out: 'colloq-perimeter: ok' }
      const name = args[args.indexOf('--name') + 1]!
      live.set(name, { name, state: 'running' })
      return { code: 0, out: name }
    }
    if (args[0] === 'start') { live.get(args[1]!)!.state = 'running'; return { code: 0, out: args[1]! } }
    if (args[0] === 'rm') { live.delete(args.at(-1)!); return { code: 0, out: '' } }
    if (args[0] === 'update') return { code: 0, out: '' }
    return { code: 1, out: `unexpected: docker ${args.join(' ')}` }
  }
  cp.spawn = ((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    const result = command === 'docker' ? answer(args) : { code: 1, out: '' }
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(result.out)); child.emit('close', result.code) })
    return child
  }) as unknown as typeof cp.spawn
  syncBuiltinESMExports()
  // Jupyter inside the room answers at once.
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
  useDockerInfo(async () => ({ code: 0, out: `${16384 * 1024 ** 2} 8` })); forgetResources(); forgetPerimeter()
  return {
    calls, live,
    async restore(id: string) {
      await dropRoomKernel(id).catch(() => {})
      cp.spawn = oldSpawn; globalThis.fetch = oldFetch; fs.existsSync = exists; syncBuiltinESMExports()
      for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
      Object.assign(process.env, old); useDockerInfo(null); forgetResources(); forgetPerimeter()
    },
  }
}

const recreated = (calls: string[][]) => calls.filter((args) => args[0] === 'rm' || (args[0] === 'run' && args.includes('--name')))

test('a live container started before PYTHONHASHSEED keeps its kernel: the seed is not part of the recreate check', async () => {
  const id = 'seed-live'
  createSession(id, id)
  const docker = fakeDocker({ name: `colloq-room-${id}`, state: 'running' })
  try {
    const endpoint = await endpointForSession(id, 'base')
    assert.equal(endpoint.url, `http://colloq-room-${id}:8888`)
    assert.deepEqual(recreated(docker.calls), [], 'a live room lost its variables for a variable it lacks')
    assert.equal(docker.live.size, 1)
  } finally { await docker.restore(id) }
})

test('a stopped container started before PYTHONHASHSEED is started again as it is, not recreated', async () => {
  const id = 'seed-stopped'
  createSession(id, id)
  const docker = fakeDocker({ name: `colloq-room-${id}`, state: 'exited' })
  try {
    await endpointForSession(id, 'base')
    assert.deepEqual(recreated(docker.calls), [])
    assert.ok(docker.calls.some((args) => args[0] === 'start' && args[1] === `colloq-room-${id}`), JSON.stringify(docker.calls))
  } finally { await docker.restore(id) }
})

test("a new container gets the seed: the next start of a class's container carries it", async () => {
  const id = 'seed-new'
  createSession(id, id)
  const docker = fakeDocker({ name: 'someone-else', state: 'running' })
  try {
    await endpointForSession(id, 'base')
    const created = docker.calls.find((args) => args[0] === 'run' && args[args.indexOf('--name') + 1] === `colloq-room-${id}`)
    assert.ok(created, JSON.stringify(docker.calls))
    assert.ok(created.includes(`PYTHONHASHSEED=${classHashSeed(id)}`), JSON.stringify(created))
  } finally { await docker.restore(id) }
})

test("the council's slot is its own: forgetting it leaves the room's address where it was", async () => {
  const id = 'seed-slot'
  createSession(id, id)
  const docker = fakeDocker({ name: `colloq-room-${id}`, state: 'running' })
  try {
    await endpointForSession(id, 'base')
    const asked = docker.calls.length
    // A council slot keyed like the room's would drop the room's address, and the next Run would ask docker again.
    forgetSessionKernel(id, 'council')
    await endpointForSession(id, 'base')
    assert.equal(docker.calls.length, asked, JSON.stringify(docker.calls.slice(asked)))
    forgetSessionKernel(id, 'room')
    await endpointForSession(id, 'base')
    assert.ok(docker.calls.length > asked, 'the control: forgetting the room makes it ask again')
  } finally { await docker.restore(id) }
})

test('neither backend of this server starts a council: a plain refusal before docker or the broker hears of it', async () => {
  const id = 'seed-council'
  createSession(id, id)
  const docker = fakeDocker({ name: `colloq-room-${id}`, state: 'running' })
  try {
    await assert.rejects(endpointForSession(id, 'base', 'council'), /council worker pool runs only on machines/)
    assert.deepEqual(docker.calls, [], 'the refusal went as far as docker')
  } finally { await docker.restore(id) }
  const fetched: string[] = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input))
    return new Response('{}', { status: 500 })
  }) as typeof fetch
  try {
    await withEnv({ KERNEL_BACKEND: 'broker', KERNEL_ISOLATION: 'required' }, () =>
      assert.rejects(endpointForSession(id, 'base', 'council'), /council worker pool runs only on machines/))
    assert.deepEqual(fetched, [], 'the refusal reached the broker')
  } finally { globalThis.fetch = oldFetch }
})
