/**
 * Video cards for competition submissions: which cards the owner gives them,
 * what each run is promised, which card the next run takes, and the doors
 * that refuse a card nobody can give.
 *
 * Every rule here fails quietly. A card listed twice under two names is one
 * card handed to a lecture and to a submission at once, with no wall between
 * their video memory. A share computed from an unknown size is a promise the
 * watchdog then enforces against a number nobody measured. A queue that picks
 * "the first card with room" runs two notebooks at half speed while the
 * second card idles. A competition whose environment cannot use a card holds
 * one for nothing. And a GPU competition on a machine with no card for
 * submissions used to sit in the queue forever, or fail "in the metric" on
 * the broker — so the door must refuse it, in words.
 *
 * No docker and no card: the probe of the cards is injected, and so is the
 * census of the rooms' containers; the rest is the real settings box, the
 * real store and the real doors.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { tr } from '../shared/i18n.js'
import { STAFF_COOKIE, type EnvironmentsState, type ResourceSettingsResponse } from '../shared/admin.js'
import type { Competition } from '../shared/competitions.js'
import type { CompetitionView } from '../shared/competitions-api.js'
import type { CompetitionSettings } from '../shared/competitions-settings.js'
import {
  gpuPerDeviceSetting,
  parseSettingsInput,
  resolveGpuPerDevice,
  resolveRunnerGpus,
  runnerGpuSetting,
  saveCompetitionSettings,
} from '../server/src/competitions/settings.js'
import {
  GPU_CONTEXT_MB,
  GPU_TOLERANCE_MB,
  competitionGpuSliceMb,
  environmentNeedsGpu,
  gpuAllocatorMb,
  gpuKillAboveMb,
  gpuSettingsView,
  gpuSliceFor,
  gpuSliceMb,
  pickRunnerGpu,
  runnerGpuDevices,
  runnerGpuPerDevice,
  runnerGpuState,
  sliceOverCards,
} from '../server/src/competitions/gpu.js'
import { gpuCards, parseCardFacts, parseCardList, useDockerInfo, useGpuCardProbe } from '../server/src/kernel/resources.js'
import { gpuBusy, submissionGpuCards } from '../server/src/kernel/pool.js'
import { fakeDocker } from './_fake-docker.mts'
import { gpuEnvironmentRefusal, parseCompetitionInput } from '../server/src/competitions/panel.js'
import { createCompetition, setCompetitionState, updateCompetition } from '../server/src/competitions/store.js'
import { app } from '../server/src/app.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'

/** Environment variables are read at call time, so they can be swapped for one body. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return await body()
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** No card setting from the developer's shell may leak into a test. */
const CLEAN = { KERNEL_GPUS: undefined, COMPETITION_GPUS: undefined, COMPETITION_GPU_PER_DEVICE: undefined, COMPETITION_BACKEND: undefined }

/** Forget whatever a test saved: the next one starts from the environment. */
function forgetSaved(): void {
  saveCompetitionSettings({ gpuDevices: null, gpuPerDevice: null })
}

/** Two 4090s and a smaller card, by id; the order of the answer does not matter. */
const RTX = { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }
function cardsAre(sizes: Record<string, number | null>): void {
  useGpuCardProbe(async (devices) => new Map(devices.map((device) => [device, { name: RTX.name, memoryMb: sizes[device] ?? null }])))
}

/* The doors below are the real app, on a port of its own. */
let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  useGpuCardProbe(null)
  server?.close()
})

/* --------------------------------------------------------- the setting */

test('runner cards: the saved list, then COMPETITION_GPUS, then none', () => {
  assert.deepEqual(resolveRunnerGpus({ saved: ['1'], env: '0,1' }), { devices: ['1'], source: 'saved' })
  // A saved "none" is an answer: .env does not hand the cards out again.
  assert.deepEqual(resolveRunnerGpus({ saved: [], env: '0,1' }), { devices: [], source: 'saved' })
  // Written as KERNEL_GPUS is: comma-separated, trimmed, each card once.
  assert.deepEqual(resolveRunnerGpus({ saved: null, env: ' 0 , 1,1 ,' }), { devices: ['0', '1'], source: 'env' })
  assert.deepEqual(resolveRunnerGpus({ saved: null, env: ' , ' }), { devices: [], source: 'default' })
  // No card by default: a machine with cards keeps giving them all to classes.
  assert.deepEqual(resolveRunnerGpus({ saved: null }), { devices: [], source: 'default' })
})

test('runs per card: the saved number, then COMPETITION_GPU_PER_DEVICE, then one', () => {
  assert.deepEqual(resolveGpuPerDevice({ saved: 3, env: '2' }), { value: 3, source: 'saved' })
  assert.deepEqual(resolveGpuPerDevice({ saved: null, env: ' 2 ' }), { value: 2, source: 'env' })
  // A typo is passed over, not obeyed; a number past the bounds is pulled into them.
  assert.deepEqual(resolveGpuPerDevice({ saved: null, env: 'two' }), { value: 1, source: 'default' })
  assert.deepEqual(resolveGpuPerDevice({ saved: null, env: '20' }), { value: 8, source: 'env' })
  assert.deepEqual(resolveGpuPerDevice({ saved: null, env: '0' }), { value: 1, source: 'env' })
  assert.deepEqual(resolveGpuPerDevice({ saved: null }), { value: 1, source: 'default' })
})

test('the box: a saved choice beats the environment, and only cards KERNEL_GPUS lists are given', async () => {
  await withEnv({ ...CLEAN, KERNEL_GPUS: '0,1,2', COMPETITION_GPUS: '2, 7', COMPETITION_GPU_PER_DEVICE: '2' }, () => {
    try {
      assert.deepEqual(runnerGpuSetting(), { devices: ['2', '7'], source: 'env' })
      // `7` is not on this machine: it is never handed to `docker run`.
      assert.deepEqual(runnerGpuDevices(), ['2'])
      assert.deepEqual(gpuPerDeviceSetting(), { value: 2, source: 'env' })
      saveCompetitionSettings({ gpuDevices: ['1', '0'], gpuPerDevice: 3 })
      assert.deepEqual(runnerGpuSetting(), { devices: ['1', '0'], source: 'saved' })
      // In KERNEL_GPUS order, whatever order they were saved in.
      assert.deepEqual(runnerGpuDevices(), ['0', '1'])
      assert.equal(runnerGpuPerDevice(), 3)
      // Taking every card back is saved too, and .env does not undo it.
      saveCompetitionSettings({ gpuDevices: [] })
      assert.deepEqual(runnerGpuDevices(), [])
    } finally {
      forgetSaved()
    }
    assert.deepEqual(runnerGpuSetting(), { devices: ['2', '7'], source: 'env' })
  })
})

test('the form: only entries of KERNEL_GPUS, spelled as there, and one to eight runs per card', () => {
  const machine = { cpus: 8, memoryMb: 16_384, reserveMb: 1024, gpus: ['0', '1', 'MIG-GPU-a1b2/1/0'] }
  assert.deepEqual(parseSettingsInput({ gpuDevices: ['1', '0', '1'], gpuPerDevice: 2 }, machine), { patch: { gpuDevices: ['0', '1'], gpuPerDevice: 2 } })
  assert.deepEqual(parseSettingsInput({ gpuDevices: ['MIG-GPU-a1b2/1/0'] }, machine), { patch: { gpuDevices: ['MIG-GPU-a1b2/1/0'] } })
  assert.deepEqual(parseSettingsInput({ gpuDevices: [] }, machine), { patch: { gpuDevices: [] } })
  assert.deepEqual(parseSettingsInput({ gpuDevices: null, gpuPerDevice: '' }, machine), { patch: { gpuDevices: null, gpuPerDevice: null } })
  // The same card under another name would be one card given twice.
  assert.deepEqual(parseSettingsInput({ gpuDevices: ['GPU-8f00'] }, machine), { refusal: { field: 'gpuDevices', why: 'device', device: 'GPU-8f00' } })
  assert.deepEqual(parseSettingsInput({ gpuDevices: '0,1' }, machine), { refusal: { field: 'gpuDevices', why: 'value' } })
  assert.deepEqual(parseSettingsInput({ gpuDevices: ['0', ''] }, machine), { refusal: { field: 'gpuDevices', why: 'value' } })
  assert.deepEqual(parseSettingsInput({ gpuDevices: [0] }, machine), { refusal: { field: 'gpuDevices', why: 'value' } })
  assert.deepEqual(parseSettingsInput({ gpuPerDevice: 9 }, machine), { refusal: { field: 'gpuPerDevice', why: 'range', min: 1, max: 8 } })
  assert.deepEqual(parseSettingsInput({ gpuPerDevice: 0 }, machine), { refusal: { field: 'gpuPerDevice', why: 'range', min: 1, max: 8 } })
  assert.deepEqual(parseSettingsInput({ gpuPerDevice: 'many' }, machine), { refusal: { field: 'gpuPerDevice', why: 'value' } })
  // A machine without KERNEL_GPUS has nothing to give.
  assert.deepEqual(parseSettingsInput({ gpuDevices: ['0'] }, { cpus: 8, memoryMb: 16_384, reserveMb: 1024 }), { refusal: { field: 'gpuDevices', why: 'device', device: '0' } })
})

test('under Kubernetes the form gives no cards: the cluster has them', () => {
  const machine = { cpus: 8, memoryMb: 16_384, reserveMb: 1024, gpus: ['0'], gpuManaged: true }
  assert.deepEqual(parseSettingsInput({ gpuDevices: ['0'] }, machine), { refusal: { field: 'gpuDevices', why: 'managed' } })
  assert.deepEqual(parseSettingsInput({ gpuPerDevice: 2 }, machine), { refusal: { field: 'gpuPerDevice', why: 'managed' } })
  // Forgetting a value changes nothing there and is not refused.
  assert.deepEqual(parseSettingsInput({ gpuDevices: null, gpuPerDevice: null }, machine), { patch: { gpuDevices: null, gpuPerDevice: null } })
})

/* ------------------------------------------------------------ the share */

test("a run's share: the card over the runs on it, the smallest card for the promise, nothing for an unknown size", () => {
  assert.equal(gpuSliceMb(24_564, 1), 24_564)
  assert.equal(gpuSliceMb(24_564, 2), 12_282)
  assert.equal(gpuSliceMb(24_564, 3), 8188)
  assert.equal(gpuSliceMb(null, 2), null)
  assert.equal(gpuSliceMb(0, 2), null)
  // Whichever card a run lands on, it gets at least the smallest share.
  assert.equal(sliceOverCards([{ memoryMb: 24_564 }, { memoryMb: 12_288 }], 2), 6144)
  // A promise that holds on some cards only is not one.
  assert.equal(sliceOverCards([{ memoryMb: 24_564 }, { memoryMb: null }], 2), null)
  assert.equal(sliceOverCards([], 2), null)
  // The allocator leaves the CUDA context room inside the share, never below
  // its floor; the watchdog allows a tolerance above the share.
  assert.equal(GPU_CONTEXT_MB, 512)
  assert.equal(GPU_TOLERANCE_MB, 256)
  assert.equal(gpuAllocatorMb(12_282), 11_770)
  assert.equal(gpuAllocatorMb(600), 256)
  assert.equal(gpuKillAboveMb(12_282), 12_538)
})

test('a competition says its share only when it runs with a card, and only a size someone measured', async () => {
  await withEnv({ ...CLEAN, KERNEL_GPUS: '0,1', COMPETITION_GPUS: '0,1', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    try {
      cardsAre({ '0': 24_564, '1': 12_288 })
      assert.equal(await competitionGpuSliceMb({ limits: { gpu: true } }), 6144)
      assert.equal(await competitionGpuSliceMb({ limits: { gpu: false } }), null)
      assert.equal(await competitionGpuSliceMb({ limits: {} }), null)
      // A run is capped to ITS card's share, not the smallest one.
      assert.equal(await gpuSliceFor('0'), 12_282)
      assert.equal(await gpuSliceFor('1'), 6144)
      cardsAre({ '0': 24_564, '1': null })
      assert.equal(await competitionGpuSliceMb({ limits: { gpu: true } }), null)
      assert.equal(await gpuSliceFor('1'), null)
    } finally {
      useGpuCardProbe(null)
    }
  })
})

/* ------------------------------------------------------- the queue's numbers */

test('the next GPU run takes the least loaded card with room, the first one on a tie', () => {
  const cards = [{ id: '0', capacity: 2 }, { id: '1', capacity: 2 }]
  assert.equal(pickRunnerGpu(cards, new Map()), '0')
  // Not "the first with room": that would time-share card 0 while card 1 idles.
  assert.equal(pickRunnerGpu(cards, new Map([['0', 1]])), '1')
  assert.equal(pickRunnerGpu(cards, new Map([['0', 1], ['1', 1]])), '0')
  assert.equal(pickRunnerGpu(cards, new Map([['0', 2], ['1', 1]])), '1')
  assert.equal(pickRunnerGpu(cards, new Map([['0', 2], ['1', 2]])), null)
  // A card a class still holds has no room for anyone.
  assert.equal(pickRunnerGpu([{ id: '0', capacity: 0 }, { id: '1', capacity: 1 }], new Map()), '1')
  assert.equal(pickRunnerGpu([{ id: '0', capacity: 0 }], new Map()), null)
  assert.equal(pickRunnerGpu([], new Map()), null)
  // A count for a card that is no longer a runner card changes nothing.
  assert.equal(pickRunnerGpu(cards, new Map([['7', 5]])), '0')
})

test('a runner card a class still holds has no room for submissions until the class lets it go', async () => {
  await withEnv({ ...CLEAN, KERNEL_GPUS: '0,1', COMPETITION_GPUS: '0,1', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    const state = await runnerGpuState({ busy: new Map([['1', 1]]), held: async () => new Set(['0']) })
    assert.deepEqual(state.cards, [
      { id: '0', capacity: 0, busy: 0 },
      { id: '1', capacity: 2, busy: 1 },
    ])
    assert.equal(state.slots, 2)
    assert.equal(state.busy, 1)
    assert.equal(state.perDevice, 2)
    assert.equal(state.census, true)
    // What the queue does with it: the next run goes to card 1.
    assert.equal(pickRunnerGpu(state.cards, new Map([['1', 1]])), '1')
    // Docker did not say who holds what: wait, rather than land on a lecture's card.
    const blind = await runnerGpuState({ held: async () => null })
    assert.deepEqual(blind.cards.map((card) => card.capacity), [0, 0])
    assert.equal(blind.census, false)
    assert.equal(blind.slots, 0)
    // Without docker rooms there is no room container to hold anything.
    const free = await runnerGpuState()
    assert.deepEqual(free.cards.map((card) => card.capacity), [2, 2])
    assert.equal(free.census, true)
  })
  // No card given: nothing to wait for, and the census is not even asked.
  await withEnv({ ...CLEAN, KERNEL_GPUS: '0,1' }, async () => {
    const none = await runnerGpuState({ held: async () => assert.fail('the census was asked for no card') })
    assert.deepEqual(none, { cards: [], perDevice: 1, slots: 0, busy: 0, census: true })
  })
})

test("the census reads docker's labels: a class on a runner card blocks it for submissions, a submission on a card blocks it for new classes", async () => {
  const fake = fakeDocker()
  try {
    Object.assign(process.env, { KERNEL_GPUS: '0,1,2', COMPETITION_GPUS: '0' })
    delete process.env.COMPETITION_GPU_PER_DEVICE
    // The lecture took card 0 before the owner gave it to submissions.
    fake.add('lecture', 'room', { gpu: '0' })
    // And a submission still runs on card 1, which the owner has just given back to classes.
    fake.intercept = (args) =>
      args[0] === 'ps' && args.includes('label=colloq.kind=competition-run') ? { code: 0, out: '1\n<no value>\n\n' } : undefined
    assert.deepEqual(await submissionGpuCards(), ['1'])
    // The rooms' own census stays the rooms' own: the panel counts classes there.
    assert.deepEqual(await gpuBusy(), ['0'])
    const state = await runnerGpuState()
    assert.deepEqual(state.cards, [{ id: '0', capacity: 0, busy: 0 }])
    assert.equal(state.census, true)
    // The daemon stops answering: submissions wait rather than guess, and new
    // classes are not held back by a census that did not come.
    fake.intercept = (args) => (args[0] === 'ps' ? { code: 1, out: 'Cannot connect to the Docker daemon' } : undefined)
    const blind = await runnerGpuState()
    assert.equal(blind.census, false)
    assert.deepEqual(blind.cards.map((card) => card.capacity), [0])
    assert.deepEqual(await submissionGpuCards(), [])
  } finally {
    fake.restore()
  }
})

test('the panel counts what the allocator does: a card a submission still runs on is promised to no class, and the bar counts each card once', async () => {
  const owner = staffCookie('Хозяйка машины', 'owner.gpu.machine@example.edu', 'owner')
  const fake = fakeDocker()
  try {
    Object.assign(process.env, { KERNEL_GPUS: '0,1,2', COMPETITION_GPUS: '0' })
    delete process.env.COMPETITION_GPU_PER_DEVICE
    // Card 0 is the submissions'; a lecture is on card 2; card 1 was given
    // back to classes while a submission still runs on it.
    fake.add('lecture', 'room', { gpu: '2' })
    fake.intercept = (args) =>
      args[0] === 'ps' && args.includes('label=colloq.kind=competition-run') ? { code: 0, out: '1\n' } : undefined
    const environments = await call('/api/admin/environments', { cookie: owner })
    assert.equal(environments.status, 200)
    // The rooms' pool is cards 1 and 2, and neither is free to promise a seminar.
    assert.deepEqual(((await environments.json()) as EnvironmentsState).gpus, { total: 2, free: 0, runners: 1 })
    const resources = await call('/api/admin/resources', { cookie: owner })
    assert.equal(resources.status, 200)
    assert.deepEqual(((await resources.json()) as ResourceSettingsResponse).budget.gpus, { total: 3, rooms: 1, runners: 2 })
  } finally {
    fake.restore()
  }
})

test("the owner's block says a card given back to classes is still the submission's while a submission runs on it, not «свободна»", async () => {
  const fake = fakeDocker()
  cardsAre({ '0': 24_564, '1': 24_564, '2': 24_564 })
  try {
    Object.assign(process.env, { KERNEL_GPUS: '0,1,2', COMPETITION_GPUS: '0' })
    delete process.env.COMPETITION_GPU_PER_DEVICE
    // The same machine as above: a lecture on card 2, a submission still on card 1, which the owner gave back.
    fake.add('lecture', 'room', { gpu: '2' })
    fake.intercept = (args) =>
      args[0] === 'ps' && args.includes('label=colloq.kind=competition-run') ? { code: 0, out: '1\n' } : undefined
    const view = await gpuSettingsView()
    assert.deepEqual(
      view.cards.map((card) => [card.id, card.holder, card.heldByRoom, card.heldBySubmission]),
      [['0', 'runners', false, false], ['1', 'runners', false, true], ['2', 'rooms', true, false]],
    )
    // Given back all the same: the run keeps it, nothing more is given.
    assert.deepEqual(view.devices, ['0'])
  } finally {
    fake.restore()
    useGpuCardProbe(null)
  }
})

/* ------------------------------------------------------- the card inventory */

test('the card inventory: asked once for everyone, remembered, and never a reason to fail', async () => {
  let calls = 0
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  useGpuCardProbe(async (devices) => {
    calls += 1
    await gate
    return new Map(devices.map((device) => [device, RTX]))
  })
  try {
    // A page does not wait past its deadline: the size is unknown on this answer...
    const early = await gpuCards(['0', '1'], { waitMs: 10 })
    assert.deepEqual(early.map((card) => card.memoryMb), [null, null])
    // ...and everyone who asks meanwhile joins the same probe.
    const waiting = Promise.all([gpuCards(['0']), gpuCards(['1', '0'])])
    release()
    const [one, both] = await waiting
    assert.equal(calls, 1)
    assert.deepEqual(one, [{ id: '0', ...RTX }])
    assert.deepEqual(both.map((card) => card.id), ['1', '0'])
    // Remembered: the next page asks nobody.
    await gpuCards(['0', '1'])
    assert.equal(calls, 1)
  } finally {
    useGpuCardProbe(null)
  }
  // A probe that throws is a card of unknown size, not a failed page.
  useGpuCardProbe(async () => {
    throw new Error('nvidia-smi hung')
  })
  try {
    assert.deepEqual(await gpuCards(['0']), [{ id: '0', name: null, memoryMb: null }])
  } finally {
    useGpuCardProbe(null)
  }
})

test('inside the app container a card is asked from a throwaway container, never pulled; a MIG instance stays unknown', async () => {
  const asked: string[][] = []
  useDockerInfo(async (args) => {
    asked.push(args)
    if (args[0] === 'image') return { code: 0, out: 'colloq-kernel:base\ncolloq-kernel:base-gpu\ncolloq-kernel:<none>\n' }
    // One container is given every card and lists them as the local nvidia-smi would.
    if (args[0] === 'run' && args[args.indexOf('--gpus') + 1] === 'all') return { code: 0, out: '0, GPU-6a1e0000, NVIDIA GeForce RTX 4090, 24564\n' }
    if (args[0] === 'run') return { code: 0, out: 'NVIDIA GeForce RTX 4090, 24564\n' }
    return { code: 1, out: '' }
  })
  // The real probe, with a fresh memory. These ids match no card a local
  // nvidia-smi could list, so the container is what answers.
  useGpuCardProbe(null)
  try {
    const cards = await gpuCards(['GPU-6a1e0000', 'MIG-GPU-6a1e0000/1/0'])
    assert.deepEqual(cards, [
      { id: 'GPU-6a1e0000', ...RTX },
      // The per-card query describes the physical card, not the instance cut from it.
      { id: 'MIG-GPU-6a1e0000/1/0', name: null, memoryMb: null },
    ])
    const runs = asked.filter((args) => args[0] === 'run')
    assert.equal(runs.length, 1, 'a container was started for the MIG instance')
    const run = runs[0]
    const value = (flag: string) => run[run.indexOf(flag) + 1]
    assert.ok(run.includes('--rm') && run.includes('--pull=never'), run.join(' '))
    assert.equal(value('--gpus'), 'all')
    assert.equal(value('--network'), 'none')
    assert.equal(value('--entrypoint'), 'nvidia-smi')
    // The image a GPU machine surely has.
    assert.ok(run.includes('colloq-kernel:base-gpu'))
  } finally {
    useDockerInfo(null)
    useGpuCardProbe(null)
  }
})

test("nvidia-smi's lines: by index and UUID, an unknown size is unknown, docker's own words are skipped", () => {
  assert.deepEqual(parseCardList('0, GPU-8f, NVIDIA GeForce RTX 4090, 24564\n1, GPU-9a, NVIDIA A100-SXM4-80GB, [N/A]\n\nbroken line\n'), [
    { index: '0', uuid: 'GPU-8f', name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 },
    { index: '1', uuid: 'GPU-9a', name: 'NVIDIA A100-SXM4-80GB', memoryMb: null },
  ])
  assert.deepEqual(parseCardFacts('WARNING: something docker said\nNVIDIA GeForce RTX 4090, 24564\n'), RTX)
  assert.equal(parseCardFacts('docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].'), null)
  assert.equal(parseCardFacts(''), null)
})

/* ------------------------------------------------------- the owner's block */

test("the owner's block: every card with its holder and size, the share it makes, nothing to give under the cluster", async () => {
  await withEnv({ ...CLEAN, KERNEL_GPUS: '0,1,2' }, async () => {
    cardsAre({ '0': 24_564, '1': 12_288, '2': 24_564 })
    try {
      saveCompetitionSettings({ gpuDevices: ['0', '1'], gpuPerDevice: 2 })
      const view = await gpuSettingsView()
      assert.deepEqual(
        view.cards.map((card) => [card.id, card.holder, card.heldByRoom, card.memoryMb]),
        [['0', 'runners', false, 24_564], ['1', 'runners', false, 12_288], ['2', 'free', false, 24_564]],
      )
      assert.deepEqual(view.devices, ['0', '1'])
      assert.equal(view.perDevice, 2)
      // The promise holds on either card: the smaller one decides.
      assert.equal(view.sliceMb, 6144)
      assert.deepEqual(view.source, { devices: 'saved', perDevice: 'saved' })
      assert.deepEqual(view.bounds, { perDevice: { min: 1, max: 8 } })
      assert.equal(view.managed, false)
      // Under Kubernetes: nothing listed, nothing given, nothing promised.
      await withEnv({ COMPETITION_BACKEND: 'broker' }, async () => {
        const managed = await gpuSettingsView()
        assert.equal(managed.managed, true)
        assert.deepEqual(managed.cards, [])
        assert.deepEqual(managed.devices, [])
        assert.equal(managed.sliceMb, null)
        assert.deepEqual(runnerGpuDevices(), [])
      })
    } finally {
      forgetSaved()
      useGpuCardProbe(null)
    }
  })
})

/* ---------------------------------------------- the competition's switch */

test('a card is for an environment that needs one: both ways in are closed', () => {
  const needs = (environment: string) => environment === 'base-gpu'
  assert.deepEqual(parseCompetitionInput({ limits: { gpu: true } }), { input: { limits: { gpu: true } } })
  // A switch is true or false: "true" as a string is the form turning it on by accident.
  assert.deepEqual(parseCompetitionInput({ limits: { gpu: 'true' } }), { refusal: { field: 'limits.gpu', why: 'value' } })
  // A new competition is born on `base`, which runs on the CPU.
  assert.deepEqual(gpuEnvironmentRefusal({ limits: { gpu: true } }, null, needs), { field: 'limits.gpu', why: 'cpuEnvironment', environment: 'base' })
  assert.equal(gpuEnvironmentRefusal({ environment: 'base-gpu', limits: { gpu: true } }, null, needs), null)
  const withCard = { environment: 'base-gpu', limits: { gpu: true } }
  // Moving a competition that has a card to a CPU environment...
  assert.deepEqual(gpuEnvironmentRefusal({ environment: 'kaggle-base' }, withCard, needs), { field: 'limits.gpu', why: 'cpuEnvironment', environment: 'kaggle-base' })
  // ...unless the card goes off in the same edit.
  assert.equal(gpuEnvironmentRefusal({ environment: 'kaggle-base', limits: { gpu: false } }, withCard, needs), null)
  // A GPU environment without the card runs on the CPU, exactly as before.
  assert.equal(gpuEnvironmentRefusal({ environment: 'base-gpu', limits: { gpu: false } }, null, needs), null)
  // An edit that touches neither is not judged.
  const stale = { environment: 'base', limits: { gpu: true } }
  assert.equal(gpuEnvironmentRefusal({ title: 'x' }, stale, needs), null)
  assert.equal(gpuEnvironmentRefusal({ limits: { cpus: 4 } }, stale, needs), null)
  // The real rule reads the environment's own file, and an unknown name is "no", not an exception.
  assert.equal(environmentNeedsGpu('base-gpu'), true)
  assert.equal(environmentNeedsGpu('base'), false)
  assert.equal(environmentNeedsGpu('no-such-environment'), false)
})

test('turning the card on or off makes the sample check stale, the way a changed CPU count does', () => {
  const made = createCompetition({ slug: 'gpu-revisions', title: 'GPU', environment: 'base-gpu' })!
  assert.equal(made.limits.gpu, false)
  const on = updateCompetition(made.id, { limits: { gpu: true } }) as Competition
  assert.equal(on.limits.gpu, true)
  assert.equal(on.inputRevision, made.inputRevision! + 1)
  assert.equal(on.notebookInputRevision, made.notebookInputRevision! + 1)
  // Saving the same value again is not a change.
  const same = updateCompetition(made.id, { limits: { gpu: true }, title: 'GPU, renamed' }) as Competition
  assert.equal(same.inputRevision, on.inputRevision)
  assert.equal(same.notebookInputRevision, on.notebookInputRevision)
  const off = updateCompetition(made.id, { limits: { gpu: false } }) as Competition
  assert.equal(off.limits.gpu, false)
  assert.equal(off.inputRevision, on.inputRevision! + 1)
  assert.equal(off.notebookInputRevision, on.notebookInputRevision! + 1)
  // The same as the CPUs do.
  const cpus = updateCompetition(made.id, { limits: { cpus: 3 } }) as Competition
  assert.equal(cpus.inputRevision, off.inputRevision! + 1)
  // Created with the card on, it stays on.
  const born = createCompetition({ slug: 'gpu-born', title: 'GPU born', environment: 'base-gpu', limits: { gpu: true } })!
  assert.equal(born.limits.gpu, true)
})

/* -------------------------------------------------------------- the doors */

function staffCookie(name: string, email: string, role: 'owner' | 'teacher'): string {
  const teacher = createTeacher({ name, email, role })
  assert.ok(teacher, email)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, { ...init, headers })
}

test('the settings door: the owner gives cards and gets the block back; a card KERNEL_GPUS lacks is refused in words', async () => {
  const owner = staffCookie('Хозяйка карт', 'owner.gpu@example.edu', 'owner')
  const teacher = staffCookie('Преподаватель', 'teacher.gpu@example.edu', 'teacher')
  const put = (cookie: string, body: unknown) => call('/api/admin/competitions/settings', { method: 'PUT', cookie, body: JSON.stringify(body) })
  await withEnv({ ...CLEAN, KERNEL_GPUS: '0,1' }, async () => {
    cardsAre({ '0': 24_564, '1': 24_564 })
    try {
      const read = await call('/api/admin/competitions/settings', { cookie: teacher })
      assert.equal(read.status, 200)
      const shown = (await read.json()) as CompetitionSettings
      assert.deepEqual(shown.gpu.cards.map((card) => [card.id, card.holder]), [['0', 'free'], ['1', 'free']])
      assert.equal(shown.gpu.sliceMb, null)
      assert.equal(shown.gpu.managed, false)

      assert.equal((await put(teacher, { gpuDevices: ['1'] })).status, 403)

      const saved = await put(owner, { gpuDevices: ['1'], gpuPerDevice: 2 })
      assert.equal(saved.status, 200)
      const now = (await saved.json()) as CompetitionSettings
      assert.deepEqual(now.gpu.devices, ['1'])
      assert.equal(now.gpu.perDevice, 2)
      assert.equal(now.gpu.sliceMb, 12_282)
      assert.deepEqual(now.gpu.source, { devices: 'saved', perDevice: 'saved' })
      assert.deepEqual(now.gpu.cards.map((card) => [card.id, card.holder]), [['0', 'free'], ['1', 'runners']])
      // The other settings are untouched by a card.
      assert.equal(now.slots.effective, shown.slots.effective)

      const unknown = await put(owner, { gpuDevices: ['GPU-8f00'] })
      assert.equal(unknown.status, 400)
      assert.equal(((await unknown.json()) as { error: string }).error, tr('server.competitions.gpuUnknownDevice', { device: 'GPU-8f00' }))
      const tooMany = await put(owner, { gpuPerDevice: 9 })
      assert.equal(tooMany.status, 400)

      // Under Kubernetes the cluster has the cards: a value is refused, the box is not touched.
      await withEnv({ COMPETITION_BACKEND: 'broker' }, async () => {
        const managed = await put(owner, { gpuDevices: ['0'] })
        assert.equal(managed.status, 409)
        assert.equal(((await managed.json()) as { error: string }).error, tr('server.competitions.gpuManaged'))
      })
      assert.deepEqual(runnerGpuSetting().devices, ['1'])

      const reset = await put(owner, { gpuDevices: null, gpuPerDevice: null })
      assert.equal(reset.status, 200)
      const back = (await reset.json()) as CompetitionSettings
      assert.deepEqual(back.gpu.devices, [])
      assert.deepEqual(back.gpu.source, { devices: 'default', perDevice: 'default' })
    } finally {
      forgetSaved()
      useGpuCardProbe(null)
    }
  })
})

test('the editor: a card on a CPU environment is refused, and a GPU competition with no card for submissions is refused at the door', async () => {
  const owner = staffCookie('Хозяйка соревнований', 'owner.gpu.editor@example.edu', 'owner')
  const create = (body: unknown) => call('/api/admin/competitions', { method: 'POST', cookie: owner, body: JSON.stringify(body) })
  await withEnv({ ...CLEAN }, async () => {
    try {
      // Born on `base`: a card would be held for nothing.
      const refused = await create({ slug: 'gpu-on-cpu', title: 'GPU on CPU', limits: { gpu: true } })
      assert.equal(refused.status, 400)
      assert.equal(((await refused.json()) as { error: string }).error, tr('server.competitions.gpuCpuEnvironment', { environment: 'base' }))

      const made = await create({ slug: 'gpu-letters', title: 'Letters', environment: 'base-gpu', limits: { gpu: true } })
      assert.equal(made.status, 201)
      const view = (await made.json()) as CompetitionView
      assert.equal(view.competition.limits.gpu, true)
      // No card is given to submissions here: execution is refused with its own code, preparation is not.
      assert.equal(view.capabilities?.execution.code, 'gpu_unavailable')
      assert.equal(view.capabilities?.execution.reason, tr('runtime.gpuUnavailable'))
      assert.equal(view.capabilities?.preparation.available, true)
      assert.equal(view.gpuSliceMb, null)
      const id = view.competition.id

      // Moving it to a CPU environment with the card on is refused the same way.
      const moved = await call(`/api/admin/competitions/${id}`, { method: 'PATCH', cookie: owner, body: JSON.stringify({ environment: 'base' }) })
      assert.equal(moved.status, 400)
      assert.equal(((await moved.json()) as { error: string }).error, tr('server.competitions.gpuCpuEnvironment', { environment: 'base' }))

      // The baseline check is refused at the door, in the same words: never queued for a card nobody gave.
      const check = await call(`/api/admin/competitions/${id}/baseline/check`, { method: 'POST', cookie: owner })
      assert.equal(check.status, 503)
      assert.equal(((await check.json()) as { error: string }).error, tr('runtime.gpuUnavailable'))

      // And a participant's upload, at the door too.
      setCompetitionState(id, 'live')
      const joined = await call('/api/k/competitions/gpu-letters/join', { method: 'POST', body: JSON.stringify({ name: '@gpu_student' }) })
      assert.equal(joined.status, 200)
      const cookie = (joined.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ')
      const page = await call('/api/k/competitions/gpu-letters', { cookie })
      assert.equal(page.status, 200)
      const entrantView = (await page.json()) as { capabilities?: { execution: { code: string } }; gpuSliceMb: number | null; gpuWholeCard?: boolean }
      assert.equal(entrantView.capabilities?.execution.code, 'gpu_unavailable')
      assert.equal(entrantView.gpuSliceMb, null)
      assert.equal(entrantView.gpuWholeCard, false, 'no card given: not a whole one either')
      const form = new FormData()
      form.append('file', new Blob([JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] })]), 'mine.ipynb')
      const upload = await call('/api/k/competitions/gpu-letters/submissions', { method: 'POST', body: form, cookie })
      assert.equal(upload.status, 503)
      assert.equal(((await upload.json()) as { error: string }).error, tr('runtime.gpuUnavailable'))

      // A card given to submissions opens the door, and the page states the share.
      await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0' }, async () => {
        cardsAre({ '0': 24_564 })
        const open = (await (await call(`/api/admin/competitions/${id}`, { cookie: owner })).json()) as CompetitionView
        assert.equal(open.capabilities?.execution.available, true)
        // One run per card: the whole card.
        assert.equal(open.gpuSliceMb, 24_564)
        const participant = (await (await call('/api/k/competitions/gpu-letters', { cookie })).json()) as { gpuSliceMb: number | null; gpuWholeCard?: boolean }
        assert.equal(participant.gpuSliceMb, 24_564)
        // The participant's conditions say «вся карта», not «срез ≈ 24 ГБ» (Paper 15 · G4).
        assert.equal(participant.gpuWholeCard, true)
        await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0', COMPETITION_GPU_PER_DEVICE: '4' }, async () => {
          const shared = (await (await call('/api/k/competitions/gpu-letters', { cookie })).json()) as { gpuSliceMb: number | null; gpuWholeCard?: boolean }
          assert.equal(shared.gpuWholeCard, false)
          assert.equal(shared.gpuSliceMb, 6141)
        })
      })

      // Turning the card off is always allowed, and a CPU competition promises no share.
      const off = await call(`/api/admin/competitions/${id}`, { method: 'PATCH', cookie: owner, body: JSON.stringify({ limits: { gpu: false } }) })
      assert.equal(off.status, 200)
      const cpu = (await off.json()) as CompetitionView
      assert.equal(cpu.competition.limits.gpu, false)
      assert.equal(cpu.capabilities?.execution.available, true)
      assert.equal(cpu.gpuSliceMb, null)
    } finally {
      useGpuCardProbe(null)
    }
  })
})
