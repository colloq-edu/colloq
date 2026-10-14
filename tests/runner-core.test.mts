/**
 * The execution core home shares with the machines that run its submissions
 * (docs/architecture/remote-runners.md §2, §5.2, §5.5), piece by piece: the
 * GPU arithmetic with the card sizes handed in, the meminfo reader, the card
 * probe with its docker handed in, the Docker runner with its memory handed
 * in, and the agent's version read when it runs.
 *
 * Each was moved out of a module that loads the database or the room pool, so
 * that the machine's agent can load it (tests/runner-import-graph.test.mts
 * reads the graph). What is checked here is that the move took the behaviour
 * with it and left home's where it was: the names home imports are the same
 * functions, the probe asks the docker it is given and not the backend's, and
 * the runner home registers still reports home's memory — a picture that
 * quietly went unknown would be admission without a memory check, under a
 * class.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import * as gpuMath from '../server/src/competitions/gpu-math.js'
import * as gpu from '../server/src/competitions/gpu.js'
import { hostMemAvailableMb, parseMeminfo, readMeminfo } from '../server/src/ops/meminfo.js'
import * as capacity from '../server/src/competitions/capacity.js'
import * as cardProbe from '../server/src/kernel/card-probe.js'
import * as resources from '../server/src/kernel/resources.js'
import { DockerCompetitionRunner, provideMachineMemory } from '../server/src/competitions/docker-runner.js'
import { competitionRunner, forgetCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { UNKNOWN_RUNNER_VERSION, runnerVersion } from '../server/src/runner-agent/version.js'
import { dataDir, repoRoot } from '../server/src/data-dir.js'
import { config } from '../server/src/config.js'
import { competitionsDir } from '../server/src/competitions/storage.js'
import { dependencyRoot } from '../server/src/dependencies/files.js'
import { TEST_ROOT } from './_env.mts'

const ROOT = path.resolve(import.meta.dirname, '..')

/* ------------------------------------------------------- the GPU arithmetic */

test('gpu.ts hands out the arithmetic of gpu-math.ts itself, under the names it always had', () => {
  const shared = ['GPU_CONTEXT_MB', 'GPU_TOLERANCE_MB', 'GPU_ALLOCATOR_FLOOR_MB', 'gpuSliceMb', 'gpuAllocatorMb', 'gpuKillAboveMb',
    'sliceOverCards', 'runnerGpuCards', 'cardsInUse', 'placesTaken', 'pickRunnerGpu'] as const
  for (const name of shared) assert.equal(gpu[name], gpuMath[name], `gpu.ts · ${name} is not gpu-math.ts's`)
  // Home's share of a card fills in home's sizes and setting; the rule underneath is the machine's too.
  assert.notEqual(gpu.gpuSliceFor, gpuMath.gpuSliceFor)
})

test('a machine cuts a share from the card sizes it brings, at the runs per card its lease pins', async () => {
  const asked: Array<{ devices: readonly string[]; waitMs?: number }> = []
  const cards: gpuMath.CardSizes = async (devices, options) => {
    asked.push({ devices: [...devices], waitMs: options.waitMs })
    return devices.map((device) => ({ memoryMb: device === '0' ? 24_564 : null }))
  }
  assert.equal(await gpuMath.gpuSliceFor('0', { cards, perDevice: 4, waitMs: 250 }), 6141)
  // A whole card to itself; and a card that did not say its size is promised nothing.
  assert.equal(await gpuMath.gpuSliceFor('0', { cards, perDevice: 1 }), 24_564)
  assert.equal(await gpuMath.gpuSliceFor('1', { cards, perDevice: 2 }), null)
  assert.deepEqual(asked, [{ devices: ['0'], waitMs: 250 }, { devices: ['0'], waitMs: undefined }, { devices: ['1'], waitMs: undefined }])
  // The pick over its own cards needs no setting: card 0 holds a run at two per card, so card 1 is less loaded.
  const own = [{ id: '0', capacity: 2 }, { id: '1', capacity: 2 }]
  assert.equal(gpuMath.pickRunnerGpu(own, gpuMath.cardsInUse(own, [{ device: '0', perDevice: 2 }])), '1')
})

/* ------------------------------------------------------------------ meminfo */

test('meminfo: MemTotal and MemAvailable in MB, rounded down, and null for a line that is not there', () => {
  const sample = 'MemTotal:       65799928 kB\nMemFree:         1048576 kB\nMemAvailable:   51234567 kB\nBuffers:            1024 kB\n'
  assert.deepEqual(parseMeminfo(sample), { totalMb: 64_257, availableMb: 50_033 })
  // A kernel before MemAvailable, and a file that is not meminfo at all.
  assert.deepEqual(parseMeminfo('MemTotal: 2048 kB\nMemAvailableish: 9 kB\n'), { totalMb: 2, availableMb: null })
  assert.deepEqual(parseMeminfo('nothing here'), { totalMb: null, availableMb: null })

  const file = path.join(TEST_ROOT, 'meminfo')
  fs.writeFileSync(file, sample)
  assert.deepEqual(readMeminfo(file), { totalMb: 64_257, availableMb: 50_033 })
  // No /proc of our own (macOS) is "don't know", never an exception.
  assert.equal(readMeminfo(path.join(TEST_ROOT, 'no-such-meminfo')), null)
  assert.equal(hostMemAvailableMb(), readMeminfo()?.availableMb ?? null)
  // The queue's admission reads the same one reader.
  assert.equal(capacity.hostMemAvailableMb, hostMemAvailableMb)
})

/* ------------------------------------------------------------ the card probe */

/** No local nvidia-smi, whatever machine runs the suite: on a GPU box the real one would answer first. */
function withoutLocalNvidiaSmi(): () => void {
  const spawn = cp.spawn
  cp.spawn = ((command: string, args: readonly string[], options?: object) => {
    if (command !== 'nvidia-smi') return (spawn as (...all: unknown[]) => unknown)(command, args, options)
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' })))
    return child
  }) as typeof cp.spawn
  syncBuiltinESMExports()
  return () => {
    cp.spawn = spawn
    syncBuiltinESMExports()
  }
}

const gpusOf = (args: string[]): string => args[args.indexOf('--gpus') + 1] ?? ''

test('the probe asks the docker it is given, whatever backend this process runs', async () => {
  const restore = withoutLocalNvidiaSmi()
  const asked: string[][] = []
  const docker: cardProbe.DockerRead = async (args) => {
    asked.push(args)
    if (args[0] === 'image') return { code: 0, out: 'colloq-kernel:<none>\ncolloq-kernel:base\ncolloq-kernel:base-gpu\n' }
    if (args[0] === 'run' && gpusOf(args) === 'all') return { code: 0, out: '0, GPU-aa, NVIDIA GeForce RTX 4090, 24564\n1, GPU-bb, NVIDIA GeForce RTX 4090, [N/A]\n' }
    if (args[0] === 'run') return { code: 0, out: 'docker: a warning first\nNVIDIA A100 80GB PCIe, 81920\n' }
    return { code: 1, out: '' }
  }
  try {
    // The suite runs the test backend, under which home's own probe makes its card up (resources.ts):
    // the gate is the caller's, and a machine's agent asks its docker.
    assert.equal(process.env.KERNEL_BACKEND, 'test')
    const answer = await cardProbe.probeCards(['0', 'GPU-bb', 'MIG-GPU-aa/1/0', '7'], { docker })
    assert.deepEqual(Object.fromEntries(answer), {
      '0': { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 },
      // Named by its UUID, its size unknown — and an unknown size is not asked again card by card.
      'GPU-bb': { name: 'NVIDIA GeForce RTX 4090', memoryMb: null },
      // An entry the all-cards container did not name is asked on its own.
      '7': { name: 'NVIDIA A100 80GB PCIe', memoryMb: 81_920 },
    })
    assert.deepEqual(asked.filter((args) => args[0] === 'run').map(gpusOf), ['all', 'device=7'])
    assert.ok(asked.filter((args) => args[0] === 'run').every((args) => args.includes('colloq-kernel:base-gpu') && args.includes('--pull=never')))

    // A machine starts the probe from an image of its own choosing, and no `image ls` is asked then.
    asked.length = 0
    await cardProbe.probeCards(['0'], { docker, image: async () => 'colloq-revision:abc123' })
    assert.deepEqual(asked.map((args) => args[0]), ['run'])
    assert.ok(asked[0]!.includes('colloq-revision:abc123'))
    // No image on the machine: no container, and the cards stay unknown.
    asked.length = 0
    assert.equal((await cardProbe.probeCards(['0'], { docker, image: async () => null })).size, 0)
    assert.deepEqual(asked, [])

    // Every card from one container, or nothing when it failed: a line cut short is not a smaller card.
    assert.deepEqual((await cardProbe.cardsInContainer(docker, 'img'))!.map((row) => row.index), ['0', '1'])
    assert.equal(await cardProbe.cardsInContainer(async () => ({ code: 125, out: '0, GPU-aa, NVIDIA GeForce RTX 4090, 245' }), 'img'), null)
    assert.equal(await cardProbe.kernelProbeImage(docker), 'colloq-kernel:base-gpu')
    assert.equal(await cardProbe.kernelProbeImage(async () => ({ code: 1, out: 'daemon down' })), null)
  } finally {
    restore()
  }
})

test('resources.ts still hands out the probe\'s parsers, and home\'s probe answers the test stand without docker', async () => {
  for (const name of ['parseGpus', 'parseCardList', 'parseCardFacts'] as const) assert.equal(resources[name], cardProbe[name])
  resources.useGpuCardProbe(null)
  try {
    assert.deepEqual(await resources.gpuCards(['0']), [{ id: '0', name: 'NVIDIA GeForce RTX 3090', memoryMb: 24_576 }])
  } finally {
    resources.useGpuCardProbe(null)
  }
})

/* ------------------------------------------------------ the runner's memory */

test('a Docker runner built without a memory source reports the memory unknown, and one with a source reports it', async () => {
  assert.deepEqual(await new DockerCompetitionRunner().capacity(), {
    availableMb: null,
    usableMb: null,
    memAvailableMb: null,
    heldMb: 0,
    heldGpus: {},
  })
  const memory = async () => ({ availableMb: 5_000, usableMb: 7_000, memAvailableMb: 6_000 })
  assert.deepEqual(await new DockerCompetitionRunner({ memory }).capacity(), {
    availableMb: 5_000,
    usableMb: 7_000,
    memAvailableMb: 6_000,
    heldMb: 0,
    heldGpus: {},
  })
})

test('the runner home registers reports the admission\'s memory, which capacity.ts hands over when it loads', async () => {
  const before = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = 'docker'
  forgetCompetitionRunner()
  const warn = console.warn
  const warned: string[] = []
  try {
    const runner = competitionRunner()
    assert.equal(runner.backend, 'docker')
    const expected = await capacity.competitionMemory()
    assert.ok(expected.usableMb !== null, 'the test stand has a machine to count')
    const reported = await runner.capacity()
    assert.deepEqual(
      { availableMb: reported.availableMb, usableMb: reported.usableMb, memAvailableMb: reported.memAvailableMb },
      expected,
    )

    // Taken back: unknown, said once in the log, and asked again at the next call rather than kept.
    console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
    provideMachineMemory(null)
    assert.deepEqual((await runner.capacity()).usableMb, null)
    await runner.capacity()
    assert.equal(warned.length, 1)
    assert.match(warned[0]!, /no memory picture/)
    provideMachineMemory(capacity.competitionMemory)
    assert.equal((await runner.capacity()).usableMb, expected.usableMb)
  } finally {
    console.warn = warn
    provideMachineMemory(capacity.competitionMemory)
    if (before === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = before
    forgetCompetitionRunner()
  }
})

/* ---------------------------------------------------------- the data root */

test('the data root is one value for config.ts, the competitions\' storage and the package sets', () => {
  assert.equal(dataDir, path.resolve(process.env.DATA_DIR!))
  assert.equal(config.dataDir, dataDir)
  assert.equal(competitionsDir, path.join(dataDir, 'competitions'))
  assert.equal(dependencyRoot, path.join(dataDir, 'dependencies'))
  // Anchored to the checkout, wherever the process was started from.
  assert.equal(repoRoot, ROOT)
})

/* ------------------------------------------------------- the agent's version */

test('the agent\'s version: the nearest package.json above it, then COLLOQ_VERSION, then plainly no release', () => {
  const root = path.join(TEST_ROOT, 'versions')
  const write = (dir: string, body: unknown): void => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(body))
  }
  // As in the image: server/package.json one level above dist/, two above src/runner-agent/.
  write(path.join(root, 'image/server'), { name: '@colloq/server', version: '0.24.0', type: 'module' })
  fs.mkdirSync(path.join(root, 'image/server/dist'), { recursive: true })
  fs.mkdirSync(path.join(root, 'image/server/src/runner-agent'), { recursive: true })
  const none = { env: {} }
  assert.equal(runnerVersion({ from: path.join(root, 'image/server/dist'), ...none }), '0.24.0')
  assert.equal(runnerVersion({ from: path.join(root, 'image/server/src/runner-agent'), env: { COLLOQ_VERSION: '9.9.9' } }), '0.24.0')

  // A package.json with no version the contract accepts is passed over, and so is such an environment.
  write(path.join(root, 'odd/server'), { name: '@colloq/server', version: 'next' })
  fs.mkdirSync(path.join(root, 'odd/server/dist'), { recursive: true })
  const odd = path.join(root, 'odd/server/dist')
  assert.equal(runnerVersion({ from: odd, env: { COLLOQ_VERSION: ' 0.24.1-rc.1 ' } }), '0.24.1-rc.1')
  assert.equal(runnerVersion({ from: odd, env: { COLLOQ_VERSION: 'latest' } }), UNKNOWN_RUNNER_VERSION)
  assert.equal(runnerVersion({ from: odd, ...none }), UNKNOWN_RUNNER_VERSION)

  // In this checkout: server/package.json, which scripts/version.mts keeps equal to the root's.
  const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/package.json'), 'utf8')).version
  assert.equal(runnerVersion(), own)
  assert.equal(own, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version)
})
