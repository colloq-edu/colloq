/**
 * The machine's half of a notebook step, by the numbers (server/src/
 * runner-agent/execute.ts, machine.ts): what it offers home, which card a
 * run takes, why a lease is declined before any container, and whether a run
 * on a shared card was crowded out by a neighbour.
 *
 * Two of these are home's rules copied, because the agent's bundle may not
 * load the queue or the admission behind them (runner.ts, capacity.ts load
 * the database): the neighbour window and the memory floor. They are held to
 * home's own here, case by case, so that a run judged on a machine is judged
 * as it would be at home.
 */
import './_env.mts'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  REMOTE_ATTEMPT_DISK_MB, REMOTE_CONTAINER_CUSHION_MB, REMOTE_DISK_RESERVE_MB, REMOTE_HOST_RESERVE_MB,
  parseRemoteSyncRequest, REMOTE_PROTOCOL,
} from '../shared/remote-runner.ts'
import * as home from '../server/src/competitions/runner.ts'
import { MEMORY_FLOOR_MB } from '../server/src/competitions/capacity.ts'
import * as agent from '../server/src/runner-agent/execute.ts'
import { ADMISSION_FLOOR_MB, cardReport, freeCapacity, machineFacts, memoryFits, pickCard, probeCards } from '../server/src/runner-agent/machine.ts'
import { Cache } from '../server/src/runner-agent/cache.ts'
import { revisionImage } from '../server/src/runner-agent/images.ts'
import type { RunOutcome } from '../server/src/competitions/runner-port.ts'
import { TEST_ROOT } from './_env.mts'
import { REVISION, dataSet, fakeAgentDocker, makeLease } from './_runner-agent-home.mts'

beforeEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'data'), { recursive: true, force: true })
  fs.rmSync(path.join(TEST_ROOT, 'books'), { recursive: true, force: true })
})

test('the neighbour window is home\'s, case by case', () => {
  assert.equal(agent.NEIGHBOUR_WINDOW_MS, home.NEIGHBOUR_WINDOW_MS)
  assert.equal(agent.UNREAD_NEIGHBOUR_WINDOW_MS, home.UNREAD_NEIGHBOUR_WINDOW_MS)
  for (const by of ['gpu', 'gpu-unread'] as const) assert.deepEqual(agent.neighbourStop(1000, by), home.neighbourStop(1000, by))
  const run = { startedAt: 10_000, endedAt: 60_000 }
  const stops = [-30_000, 5_000, 39_999, 40_000, 59_000, 79_000, 80_001, 94_000, 96_000]
  for (const at of stops) {
    for (const by of ['gpu', 'gpu-unread'] as const) {
      for (const now of [60_000, 70_000, 95_000, 200_000]) {
        for (const stays of [true, false]) {
          const list = [home.neighbourStop(at, by)]
          assert.equal(agent.neighbourVerdict(list, run, now, stays), home.neighbourVerdict(list, run, now, stays), JSON.stringify({ at, by, now, stays }))
        }
      }
    }
  }
})

test('a traceback home reads as torch\'s out-of-memory is one the machine waits for a neighbour\'s stop on', () => {
  const tracebacks = [
    'Traceback (most recent call last):\n  File "x", line 1\ntorch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB',
    'torch.cuda.OutOfMemoryError: CUDA out of memory.',
    'OutOfMemoryError: CUDA out of memory\n',
    'ValueError: shapes do not match',
    'RuntimeError: CUDA error: out of memory',
    'KeyError: \'x\'\n  during handling: OutOfMemoryError: later',
    '',
  ]
  for (const detail of tracebacks) {
    // Never fewer: where home would give the run back, the machine has waited for the stop that proves it.
    if (home.errorTypeOf(detail) === 'OutOfMemoryError') assert.ok(agent.diedOfCardMemory(detail), detail)
  }
  assert.equal(agent.diedOfCardMemory('ValueError: shapes do not match'), false)
})

test('the machine\'s memory floor is home\'s admission floor', () => {
  assert.equal(ADMISSION_FLOOR_MB, MEMORY_FLOOR_MB)
})

function outcome(partial: Partial<RunOutcome>): RunOutcome {
  return { status: 'cell_error', cell: 3, cells: 9, wall: 5000, submission: null, detail: 'torch.OutOfMemoryError: CUDA out of memory', log: '', diagnostics: { exit: 1, oomKilled: false, backend: 'docker' }, ...partial }
}

test('crowded: a torch out-of-memory on a shared card beside a neighbour stopped for its share; never alone or on a whole card', async () => {
  const signal = new AbortController().signal
  const card = { device: '0', sliceMb: 12_000, perDevice: 2 }
  const window = new agent.NeighbourWindow()
  // The neighbour went past its share and was stopped; its stop is noted from its own outcome.
  assert.equal(await window.crowded({ outcome: outcome({ status: 'out-of-memory', diagnostics: { exit: 137, oomKilled: false, backend: 'docker', killedBy: 'gpu' } }), card, startedAt: 0, endedAt: 50_000, stays: () => false, signal }), false)
  assert.equal(await window.crowded({ outcome: outcome({}), card, startedAt: 10_000, endedAt: 52_000, stays: () => false, signal }), true)
  // A whole card has no neighbour; another card's stop is not this one's.
  assert.equal(await window.crowded({ outcome: outcome({}), card: { ...card, perDevice: 1 }, startedAt: 10_000, endedAt: 52_000, stays: () => false, signal }), false)
  assert.equal(await window.crowded({ outcome: outcome({}), card: { ...card, device: '1' }, startedAt: 10_000, endedAt: 52_000, stays: () => false, signal }), false)
  // Not torch's out-of-memory: nothing to give back.
  assert.equal(await window.crowded({ outcome: outcome({ detail: 'ValueError: no' }), card, startedAt: 10_000, endedAt: 52_000, stays: () => false, signal }), false)
  // A neighbour still on the card whose stop lands while the run waits for it: crowded.
  const later = new agent.NeighbourWindow()
  let now = 100_000
  setTimeout(() => {
    later.note('0', 101_000, 'gpu')
  }, 30)
  const verdict = await later.crowded({ outcome: outcome({}), card, startedAt: 90_000, endedAt: 100_000, stays: () => true, signal, now: () => (now += 50) })
  assert.equal(verdict, true)
})

test('free capacity is home\'s admission on this machine\'s numbers, and the contract takes it', () => {
  const picture = { memTotalMb: 32_000, memAvailableMb: 30_000, cpus: 8, diskFreeMb: 10_000, diskTotalMb: 100_000 }
  const holding = [{ memoryMb: 4096, cpus: 2 }, { memoryMb: 2048, cpus: 1 }]
  const free = freeCapacity({ picture, holding, heldMb: 500, attempts: 3, gpuShares: 3 })
  const promised = picture.memTotalMb - REMOTE_HOST_RESERVE_MB - (4096 + REMOTE_CONTAINER_CUSHION_MB) - (2048 + REMOTE_CONTAINER_CUSHION_MB) - 500
  assert.equal(free.memoryMb, Math.min(promised, picture.memAvailableMb - ADMISSION_FLOOR_MB))
  assert.equal(free.cpus, 8 - 1 - 3)
  assert.equal(free.diskMb, 10_000 - REMOTE_DISK_RESERVE_MB - 3 * REMOTE_ATTEMPT_DISK_MB)
  assert.equal(free.gpuShares, 3)
  assert.equal(free.slots, Math.min(64 - 3, 4, Math.floor(free.memoryMb / 384), Math.floor(free.diskMb / REMOTE_ATTEMPT_DISK_MB)))
  // MemAvailable is the smaller bound when the machine's memory is taken outside the books; unknown is no bound.
  assert.equal(freeCapacity({ picture: { ...picture, memAvailableMb: 3000 }, holding: [], heldMb: 0, attempts: 0, gpuShares: 0 }).memoryMb, 3000 - ADMISSION_FLOOR_MB)
  assert.equal(freeCapacity({ picture: { ...picture, memAvailableMb: null }, holding: [], heldMb: 0, attempts: 0, gpuShares: 0 }).memoryMb, 32_000 - REMOTE_HOST_RESERVE_MB)
  // A full machine offers nothing, never a negative number the contract would refuse.
  const full = freeCapacity({ picture: { memTotalMb: 1000, memAvailableMb: 100, cpus: 1, diskFreeMb: 100, diskTotalMb: 1000 }, holding, heldMb: 0, attempts: 3, gpuShares: 0 })
  assert.deepEqual(full, { slots: 0, memoryMb: 0, cpus: 0, gpuShares: 0, diskMb: 0 })
  const facts = machineFacts({ version: '0.24.0', info: null, picture, driver: '580.65.06' })
  const sync = { protocol: REMOTE_PROTOCOL, build: 'dev', seq: 0, holdMs: 1000, state: 'active', free, cards: [], ready: { revisions: [], data: [], sealed: [], bundles: [] }, fetching: [], attempts: [], problems: [], facts }
  assert.doesNotThrow(() => parseRemoteSyncRequest(sync))
  // admitJob's two checks, on a lease already counted among what is held.
  assert.equal(memoryFits(picture, holding, 0, { memoryMb: 4096, cpus: 2 }), true)
  assert.equal(memoryFits({ ...picture, memAvailableMb: 4096 }, holding, 0, { memoryMb: 4096, cpus: 2 }), false)
  assert.equal(memoryFits({ ...picture, memTotalMb: 8000 }, holding, 0, { memoryMb: 4096, cpus: 2 }), false)
})

test('cards: the shares busy by head, the free ones by the share each run pinned; the pick is the least loaded card', () => {
  const cards = [{ device: '0', name: 'RTX 4090', memoryMb: 24_564 }, { device: '1', name: 'RTX 4090', memoryMb: 24_564 }]
  // Two runs at two per card on card 0, and home lowered the setting to one since.
  const report = cardReport(cards, 1, [{ device: '0', perDevice: 2 }, { device: '0', perDevice: 2 }])
  assert.deepEqual(report.cards.map((card) => [card.device, card.busyShares, card.perDevice]), [['0', 2, 1], ['1', 0, 1]])
  assert.equal(report.freeShares, 1)
  // At four per card: card 0 has two shares left of four, card 1 four.
  assert.equal(cardReport(cards, 4, [{ device: '0', perDevice: 4 }, { device: '0', perDevice: 4 }]).freeShares, 6)
  // A run taken at one per card holds its whole card, whatever is set now.
  assert.equal(cardReport(cards, 4, [{ device: '1', perDevice: 1 }]).freeShares, 4)
  assert.equal(pickCard(cards, 2, [{ device: '0', perDevice: 2 }]), '1')
  assert.equal(pickCard(cards, 2, [{ device: '0', perDevice: 2 }, { device: '1', perDevice: 2 }]), '0')
  assert.equal(pickCard(cards, 1, [{ device: '0', perDevice: 1 }, { device: '1', perDevice: 1 }]), null)
  // A container awaiting removal still holds its share.
  assert.equal(pickCard(cards, 1, [{ device: '0', perDevice: 1 }], { '1': 1 }), null)
})

test('the cards are probed with the agent\'s own image; a machine without the NVIDIA runtime has none and no problem', async () => {
  const docker = fakeAgentDocker()
  assert.deepEqual(await probeCards(docker, 'ghcr.io/colloq-edu/colloq-server:0.24.0'), { cards: [], driver: null, problem: null })
  docker.cards = '0, GPU-aa, NVIDIA GeForce RTX 4090, 24564\n1, GPU-bb, NVIDIA GeForce RTX 4090, 24564\n'
  const probed = await probeCards(docker, 'ghcr.io/colloq-edu/colloq-server:0.24.0')
  assert.deepEqual(probed.cards.map((card) => [card.device, card.memoryMb]), [['0', 24_564], ['1', 24_564]])
  assert.equal(probed.driver, '580.65.06')
  const run = docker.calls.find((args) => args[0] === 'run')!
  assert.equal(run[run.indexOf('--gpus') + 1], 'all')
  assert.ok(run.includes('ghcr.io/colloq-edu/colloq-server:0.24.0') && run.includes('--pull=never'))
  // A probe that failed for another reason is said, for the owner.
  docker.intercept = (args) => (args[0] === 'run' ? { code: 125, out: 'docker: Error response from daemon: nvidia-container-cli: initialization error: nvml error: driver not loaded' } : undefined)
  const failed = await probeCards(docker, 'img')
  assert.match(failed.problem ?? '', /driver not loaded/)
  // No image to probe with: no cards, nothing asked.
  assert.deepEqual(await probeCards(fakeAgentDocker(), null), { cards: [], driver: null, problem: null })
})

test('a lease is declined before any container for the disk, the memory, the card, the image and the package set, each with its reason', async () => {
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  const dir = path.join(TEST_ROOT, 'data', 'competitions', '.blobs')
  fs.mkdirSync(dir, { recursive: true })
  for (const [sha, body] of set.bodies) fs.writeFileSync(path.join(dir, sha), body)
  const cache = new Cache({ client: { blob: () => { throw new Error('nothing is fetched here') } }, books: path.join(TEST_ROOT, 'books'), log: () => undefined })
  cache.load()
  cache.want([{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }], [])
  const base = {
    receivedAt: Date.now(),
    cache,
    images: { verify: async (): Promise<string | null> => revisionImage(REVISION.id) },
    picture: { memTotalMb: 64_000, memAvailableMb: 60_000, cpus: 16, diskFreeMb: 100_000, diskTotalMb: 200_000 },
    holding: [] as Array<{ memoryMb: number; cpus: number }>,
    heldMb: 0,
    attempts: 1,
    trusted: false,
    cards: [{ device: '0', name: null, memoryMb: 24_564 }],
    claimCard: (): string | null => null,
    described: (_bundleId: string, _signal: AbortSignal): Promise<void> => Promise.resolve(),
    signal: new AbortController().signal,
  }
  const reason = async (input: Partial<typeof base> & { lease: ReturnType<typeof makeLease> }): Promise<string> => {
    const prepared = await agent.prepareRun({ ...base, ...input })
    return prepared.ok ? 'ok' : prepared.decline.reason
  }
  const lease = makeLease({ data: set.manifest })
  assert.equal(await reason({ lease }), 'ok')
  assert.equal(await reason({ lease, picture: { ...base.picture, diskFreeMb: 1000 } }), 'disk')
  assert.equal(await reason({ lease, picture: { ...base.picture, memAvailableMb: 1000 } }), 'memory')
  assert.equal(await reason({ lease, images: { verify: async () => null } }), 'image')
  assert.equal(await reason({ lease: makeLease({ data: set.manifest, gpu: true, perDevice: 2 }) }), 'card')
  assert.equal(await reason({ lease: makeLease({ data: set.manifest, sealed: true, sealedData: set.manifest }) }), 'data')
  // A set home never describes within the preparation's time: `wheels`.
  const waiting = new AbortController()
  setTimeout(() => waiting.abort(), 30)
  assert.equal(await reason({ lease: makeLease({ data: set.manifest, bundle: { id: 'b'.repeat(32), packagesMb: 64 } }), signal: waiting.signal, described: (_bundleId: string, signal: AbortSignal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('not described')))) }), 'wheels')
})
