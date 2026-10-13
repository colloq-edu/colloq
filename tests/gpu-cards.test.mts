/**
 * The cards behind KERNEL_GPUS, as the inventory remembers them: a size a
 * card has said survives a re-probe that brings none, the cards are asked
 * from one container for all of them, and the inventory is read when the
 * server starts, so that nobody waits for it later.
 *
 * Each rule fails quietly. A forgotten size takes the share away from every
 * GPU run started in the next minute — no allocator cap, no watchdog — on a
 * card whose other runs stay capped to theirs, so one greedy notebook can take
 * the memory they were promised (review of 13 Oct 2026). An inventory nobody
 * reads before the owner opens the Resources tab makes that tab wait for
 * docker after every restart, and a probe container per card makes every
 * refresh in the middle of a class one more container per card on a busy
 * daemon.
 *
 * No docker and no card: the probe, or docker itself, is injected, the local
 * nvidia-smi is made absent, and the clock is moved by hand.
 */
import './_env.mts'
import cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { gpuCards, useDockerInfo, useGpuCardProbe, watchGpuCards } from '../server/src/kernel/resources.js'
import { gpuSliceFor } from '../server/src/competitions/gpu.js'

const RTX = { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }
const A100 = { name: 'NVIDIA A100 80GB PCIe', memoryMb: 81_920 }

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

/** `Date.now` under the test's hand; timers keep real time. */
function handClock(): { advance: (ms: number) => void; restore: () => void } {
  const real = Date.now
  let now = real()
  Date.now = () => now
  return {
    advance: (ms) => {
      now += ms
    },
    restore: () => {
      Date.now = real
    },
  }
}

/** Let a background probe land: its answer is written a few promise turns after it returns. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * No local nvidia-smi, whatever machine runs the suite: on a GPU box the real
 * one would name the cards before the container is asked.
 */
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

/** The `--gpus` value of a `docker run`. */
const gpusOf = (args: string[]): string => args[args.indexOf('--gpus') + 1] ?? ''

/* ------------------------------------------------- a size, once said, stays */

test('a re-probe that brings no size keeps the size the card said, and asks again within a minute', async () => {
  let says: 'size' | 'nothing' | 'throws' | 'another' = 'size'
  let probes = 0
  useGpuCardProbe(async (devices) => {
    probes += 1
    if (says === 'throws') throw new Error('docker run --gpus all: killed after 30 s')
    if (says === 'nothing') return new Map()
    return new Map(devices.map((device) => [device, says === 'another' ? A100 : RTX]))
  })
  const clock = handClock()
  try {
    await withEnv({ COMPETITION_GPU_PER_DEVICE: '4' }, async () => {
      // Measured once: four runs on the 24 GB card are promised, and held to, 6 GB each.
      assert.equal(await gpuSliceFor('0'), 6141)
      assert.equal(probes, 1)

      // Ten minutes on, a page asks and the re-probe behind it brings nothing:
      // the probe container timed out on a daemon busy with the class's runs.
      clock.advance(10 * 60_000)
      says = 'nothing'
      assert.deepEqual(await gpuCards(['0']), [{ id: '0', ...RTX }])
      await settle()
      assert.equal(probes, 2)
      // The size stays, and with it the share of a run that starts right now.
      assert.deepEqual(await gpuCards(['0']), [{ id: '0', ...RTX }])
      assert.equal(await gpuSliceFor('0'), 6141)

      // Unconfirmed, it is asked again within a minute rather than ten...
      clock.advance(59_000)
      await gpuCards(['0'])
      await settle()
      assert.equal(probes, 2)
      clock.advance(1_000)
      says = 'throws'
      await gpuCards(['0'])
      await settle()
      assert.equal(probes, 3)
      // ...and a probe that throws does not erase it either.
      assert.equal(await gpuSliceFor('0'), 6141)

      // A probe that answers with another size is believed, and kept ten minutes.
      clock.advance(60_000)
      says = 'another'
      await gpuCards(['0'])
      await settle()
      assert.equal(probes, 4)
      assert.deepEqual(await gpuCards(['0']), [{ id: '0', ...A100 }])
      assert.equal(await gpuSliceFor('0'), 20_480)
      clock.advance(9 * 60_000)
      await gpuCards(['0'])
      await settle()
      assert.equal(probes, 4)
    })
    // A card that never said its size is unknown after a probe that brought none: nothing is made up.
    says = 'nothing'
    assert.deepEqual(await gpuCards(['1']), [{ id: '1', name: null, memoryMb: null }])
  } finally {
    clock.restore()
    useGpuCardProbe(null)
  }
})

/* ------------------------------------------- one container for every card */

test('inside the app container one container is asked about every card, by index and by UUID; an entry it did not name gets one of its own', async () => {
  const restoreSmi = withoutLocalNvidiaSmi()
  const asked: string[][] = []
  let allCards = {
    code: 0,
    out: [
      // docker's own words share the stream (`run` merges stderr) and are skipped.
      "WARNING: The requested image's platform does not match the detected host platform",
      '0, GPU-6a1e0000, NVIDIA GeForce RTX 4090, 24564',
      '1, GPU-7b2f0000, NVIDIA GeForce RTX 4090, 24564',
      '',
    ].join('\n'),
  }
  useDockerInfo(async (args) => {
    asked.push(args)
    if (args[0] === 'image') return { code: 0, out: 'colloq-kernel:base\ncolloq-kernel:base-gpu\n' }
    if (args[0] === 'run' && gpusOf(args) === 'all') return allCards
    if (args[0] === 'run') return { code: 0, out: 'NVIDIA GeForce RTX 3090, 24576\n' }
    return { code: 1, out: '' }
  })
  const runs = (): string[][] => asked.filter((args) => args[0] === 'run')
  // The real probe, with a fresh memory.
  useGpuCardProbe(null)
  try {
    const cards = await gpuCards(['0', 'GPU-7b2f0000', 'MIG-GPU-6a1e0000/1/0'])
    assert.deepEqual(cards, [
      { id: '0', ...RTX },
      { id: 'GPU-7b2f0000', ...RTX },
      // The query describes the physical card, not the instance cut from it.
      { id: 'MIG-GPU-6a1e0000/1/0', name: null, memoryMb: null },
    ])
    assert.equal(runs().length, 1, runs().map((args) => args.join(' ')).join('\n'))
    const run = runs()[0]!
    const value = (flag: string) => run[run.indexOf(flag) + 1]
    assert.equal(gpusOf(run), 'all')
    assert.ok(run.includes('--rm') && run.includes('--pull=never') && run.includes('--cap-drop=ALL'), run.join(' '))
    assert.equal(value('--network'), 'none')
    assert.equal(value('--entrypoint'), 'nvidia-smi')
    assert.ok(run.includes('colloq-kernel:base-gpu'))
    assert.ok(run.includes('--query-gpu=index,uuid,name,memory.total'), run.join(' '))

    // The all-cards container names card 0 only: card 1 is asked on its own.
    useGpuCardProbe(null)
    asked.length = 0
    allCards = { code: 0, out: '0, GPU-6a1e0000, NVIDIA GeForce RTX 4090, 24564\n' }
    assert.deepEqual((await gpuCards(['0', '1'])).map((card) => card.memoryMb), [24_564, 24_576])
    assert.deepEqual(runs().map(gpusOf), ['all', 'device=1'])

    // It fails outright, or is cut short: what it printed is not read, and
    // each card is asked on its own, as before.
    for (const failure of [
      { code: 125, out: 'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].' },
      { code: -1, out: '0, GPU-6a1e0000, NVIDIA GeForce RTX 4090, 245' },
    ]) {
      useGpuCardProbe(null)
      asked.length = 0
      allCards = failure
      assert.deepEqual((await gpuCards(['0', '1'])).map((card) => card.memoryMb), [24_576, 24_576])
      assert.deepEqual(runs().map(gpusOf), ['all', 'device=0', 'device=1'])
    }
  } finally {
    useDockerInfo(null)
    useGpuCardProbe(null)
    restoreSmi()
  }
})

/* ----------------------------------------------------- read at the start */

test('the inventory is read when the server starts, each card once, and kept warm without anyone asking', async () => {
  const probes: string[][] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  useGpuCardProbe(async (devices) => {
    probes.push([...devices])
    await gate
    return new Map(devices.map((device) => [device, RTX]))
  })
  mock.timers.enable({ apis: ['setInterval'] })
  const clock = handClock()
  let stop = () => {}
  try {
    await withEnv({ KERNEL_BACKEND: 'docker', KERNEL_GPUS: '0, 1, 0' }, async () => {
      stop = watchGpuCards()
      await settle()
      // Asked at once, before anybody needs an answer, and each card once.
      assert.deepEqual(probes, [['0', '1']])
      // A second start is not a second watch.
      watchGpuCards()
      await settle()
      assert.equal(probes.length, 1)

      // The owner opens the Resources tab while that probe still runs: the
      // read (the settings view waits up to 8 s for a card never asked
      // about) joins it instead of starting a probe of its own...
      const read = gpuCards(['0', '1'], { waitMs: 8_000 })
      release()
      assert.deepEqual((await read).map((card) => card.memoryMb), [24_564, 24_564])
      assert.equal(probes.length, 1)
      // ...and the next read answers from memory.
      assert.deepEqual((await gpuCards(['1'], { waitMs: 0 })).map((card) => card.memoryMb), [24_564])
      assert.equal(probes.length, 1)

      // A minute's look at fresh cards asks docker nothing.
      mock.timers.tick(60_000)
      await settle()
      assert.equal(probes.length, 1)
      // Ten minutes on, the look refreshes them in the background, with nobody asking.
      clock.advance(10 * 60_000)
      mock.timers.tick(60_000)
      await settle()
      assert.deepEqual(probes, [['0', '1'], ['0', '1']])
      // A stopped watch looks no more.
      stop()
      clock.advance(10 * 60_000)
      mock.timers.tick(60_000)
      await settle()
      assert.equal(probes.length, 2)
    })
    // Nothing to watch: no cards on the machine, or cards that are not this server's to give out.
    for (const env of [
      { KERNEL_BACKEND: 'docker', KERNEL_GPUS: '' },
      { KERNEL_BACKEND: 'broker', KERNEL_GPUS: '0' },
      { KERNEL_BACKEND: 'test', KERNEL_GPUS: '0' },
      { KERNEL_BACKEND: 'kubernetes', KERNEL_GPUS: '0' },
    ]) {
      await withEnv(env, async () => {
        const nothing = watchGpuCards()
        await settle()
        nothing()
      })
    }
    assert.equal(probes.length, 2)
  } finally {
    stop()
    clock.restore()
    mock.timers.reset()
    useGpuCardProbe(null)
  }
})

test('the server starts the watch once it listens', () => {
  const index = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /import \{ watchGpuCards \} from '\.\/kernel\/resources\.js'/)
  const listen = index.indexOf('server.listen(')
  const call = index.indexOf('watchGpuCards()')
  assert.ok(listen > 0 && call > listen, 'watchGpuCards() is not called once the server listens')
})
