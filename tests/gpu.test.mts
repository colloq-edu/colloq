/**
 * A GPU slice goes to a room — and this is the only place where that is
 * decided.
 *
 * The university's A100 is cut into MIG slices, two or four of them, while
 * there are more seminars in a day. All that ties a slice to a room is the
 * `colloq.gpu` label on its container: a map in memory dies with the server,
 * while the container of yesterday's class lives on. Hence three rules that
 * break silently and that are pinned down here: a room with its own container
 * gets THE SAME slice (otherwise the container is recreated and the seminar's
 * variables vanish for nothing), a stopped container keeps its slice (it will
 * be brought up by `docker start`), and when none are free — a refusal, not a
 * quiet start on the CPU, where torch wheels built for CUDA will say so only
 * at the first `.cuda()`.
 *
 * There is no real docker in the suite (see `_env.mts`), so what is checked
 * is what does not depend on it: the allocation rule and the `docker run`
 * line we build for it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gpuDevices, gpuRefusal, pickGpu, roomGpuDevices, runArgs, submissionGpuCards } from '../server/src/kernel/pool.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { db } from '../server/src/db.js'

/** Environment variables are read at call time, so they can be swapped. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    body()
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/* ------------------------------------------------- which slices we have */

test('slices are listed comma-separated, in the form docker calls them', () => {
  withEnv({ KERNEL_GPUS: ' MIG-GPU-a1b2/1/0 , 1 ' }, () => {
    assert.deepEqual(gpuDevices(), ['MIG-GPU-a1b2/1/0', '1'])
  })
})

test('no variable or an empty one — nobody asks for a GPU', () => {
  // A machine without a card is an ordinary machine: no room should trip over it.
  withEnv({ KERNEL_GPUS: undefined }, () => assert.deepEqual(gpuDevices(), []))
  withEnv({ KERNEL_GPUS: '  ,, ' }, () => assert.deepEqual(gpuDevices(), []))
})

/* ---------------------------------------------------------- slice allocation */

test('the first room gets a free slice', () => {
  assert.equal(pickGpu(['0', '1'], [], 'seminar'), '0')
})

test('a taken slice does not go to a second room', () => {
  assert.equal(pickGpu(['0', '1'], [{ session: 'первый', gpu: '0' }], 'второй'), '1')
})

test('a room with its own container gets the same slice, not the first free one', () => {
  // A different slice means recreating the container, that is, losing all the
  // seminar's variables in the middle of class, and for nothing at all.
  assert.equal(pickGpu(['0', '1'], [{ session: 'семинар', gpu: '1' }], 'семинар'), '1')
})

test('a stopped container keeps its slice', () => {
  // It will be brought up by `docker start` — with the same variables and the
  // same device, so taken slices are read through `docker ps -a`, not only
  // from live containers.
  assert.equal(pickGpu(['0'], [{ session: 'вчерашний', gpu: '0' }], 'сегодняшний'), null)
})

test('not enough slices — null, not whichever comes first', () => {
  const taken = [
    { session: 'a', gpu: '0' },
    { session: 'b', gpu: '1' },
  ]
  assert.equal(pickGpu(['0', '1'], taken, 'c'), null)
})

test("a slice that is no longer in KERNEL_GPUS does not count as the room's own", () => {
  // The operator rewrote the list: the device may no longer be on the
  // machine, and "the same slice" here would mean a container that will not
  // come up.
  assert.equal(pickGpu(['1'], [{ session: 'семинар', gpu: '0' }], 'семинар'), '1')
})

test('a room without a GPU takes nothing', () => {
  assert.equal(pickGpu(['0'], [{ session: 'обычный', gpu: '' }], 'нейросети'), '0')
})

test('no slices at all — nothing for anyone', () => {
  assert.equal(pickGpu([], [], 'семинар'), null)
})

/* ------------------------------------------------------------------ refusal */

test('the refusal names the environment and says what to do', () => {
  const busy = gpuRefusal('gpu', ['0', '1'])
  assert.match(busy, /«gpu»/)
  // Two ways out, and both can be taken by a person in the room: wait or
  // switch the environment. Promising the CPU is not allowed — the wheels are
  // built for CUDA.
  assert.match(busy, /Подожд/)
  assert.match(busy, /без GPU/)
})

test('on a machine without allocated slices the refusal names the variable', () => {
  const none = gpuRefusal('gpu', [])
  assert.match(none, /KERNEL_GPUS/)
  assert.match(none, /«gpu»/)
})

/* ------------------------------------------ cards given to competitions */

/*
 * A card goes either to classes or to competition submissions, never to both:
 * docker does not refuse a second container on a card, and a submission's
 * runaway training on the lecture's card takes the lecture's video memory
 * with it. So the owner's runner cards leave the rooms' pool — for new
 * holders only: a class already on such a card keeps it until its container
 * ends, since a different card means a recreated container and a lesson's
 * variables gone.
 */

test("a card given to competition submissions leaves the rooms' pool", () => {
  withEnv({ KERNEL_GPUS: '0,1,2', COMPETITION_GPUS: '1' }, () => {
    assert.deepEqual(gpuDevices(), ['0', '1', '2'])
    assert.deepEqual(roomGpuDevices(), ['0', '2'])
  })
  withEnv({ KERNEL_GPUS: '0,1,2', COMPETITION_GPUS: '1' }, () => {
    try {
      // The owner's choice in the Resources tab beats the environment's...
      saveCompetitionSettings({ gpuDevices: ['0', '2'] })
      assert.deepEqual(roomGpuDevices(), ['1'])
      // ...and taking every card back gives every card to the classes again.
      saveCompetitionSettings({ gpuDevices: [] })
      assert.deepEqual(roomGpuDevices(), ['0', '1', '2'])
    } finally {
      saveCompetitionSettings({ gpuDevices: null })
    }
  })
  // Nobody chose: every card is the rooms', exactly as before submissions could have one.
  withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: undefined }, () => {
    assert.deepEqual(roomGpuDevices(), ['0', '1'])
  })
  // Submissions on the cluster use none of this machine's cards: none is withheld for nothing.
  withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: '1', COMPETITION_BACKEND: 'broker' }, () => {
    assert.deepEqual(roomGpuDevices(), ['0', '1'])
  })
})

test('a class keeps the card it holds when that card goes to submissions; a new class never gets it', () => {
  // KERNEL_GPUS is 0,1, and card 1 has just been given to submissions.
  const taken = [{ session: 'лекция', gpu: '1' }]
  assert.equal(pickGpu(['0'], taken, 'лекция', ['0', '1']), '1')
  assert.equal(pickGpu(['0'], taken, 'семинар', ['0', '1']), '0')
  assert.equal(pickGpu(['0'], [...taken, { session: 'семинар', gpu: '0' }], 'третий', ['0', '1']), null)
  // Without the wider "may keep" list a room's card must be in the pool: what
  // a room start did before, and why takeGpu passes all of KERNEL_GPUS.
  assert.equal(pickGpu(['0'], taken, 'лекция'), '0')
})

test("before the queue's table exists no queue row holds a card, and asking is no failure", async () => {
  /*
   * The pool loads with the server's first imports and reads the queue's
   * bindings through the database, not through the queue's store (which
   * imports competitions/gpu.ts, which imports the pool). The store creates
   * the table when it loads; this file never loads it, as a process that
   * starts rooms before competitions would not.
   */
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'competition_queue'")
  assert.equal(table.get(), undefined, 'the competitions store was loaded: this test proves nothing')
  assert.deepEqual(await submissionGpuCards(), [])
})

test('every card went to submissions: the refusal says so and sends the person to the Resources tab, not to .env', () => {
  const all = gpuRefusal('base-gpu', [], 2)
  assert.match(all, /«base-gpu»/)
  assert.match(all, /посылкам соревнований/)
  assert.match(all, /«Ресурсы»/)
  assert.doesNotMatch(all, /KERNEL_GPUS/)
  // Still a refusal, never a quiet start on the CPU.
  assert.match(all, /без GPU/)
  // Nothing configured at all is still the .env refusal.
  assert.match(gpuRefusal('base-gpu', [], 0), /KERNEL_GPUS/)
})

/* ------------------------------------------------- the docker run line */

/** The value of a flag like `--name x`; for `--memory=2g` look at the whole element. */
function valueOf(args: string[], flag: string): string | null {
  const at = args.indexOf(flag)
  return at >= 0 ? (args[at + 1] ?? null) : null
}

const room = { sessionId: 'seminar1', env: 'gpu', mount: '/srv/workspace/seminar1', network: 'colloq-rooms', publish: true }

test('a GPU room gets the device, the label and shared memory', () => {
  const args = runArgs({ ...room, gpu: 'MIG-GPU-a1b2/1/0' })
  assert.equal(valueOf(args, '--gpus'), 'device=MIG-GPU-a1b2/1/0')
  // The label is the only thing that survives a server restart, so it is the
  // answer to the question "who holds the slice".
  assert.ok(args.includes('colloq.gpu=MIG-GPU-a1b2/1/0'), 'there is no label with the slice')
  // docker's default of 64 MB breaks a DataLoader with several workers.
  assert.ok(args.includes('--shm-size=1g'), 'there is no --shm-size')
})

test('an ordinary room starts exactly as before', () => {
  const args = runArgs({ ...room, env: 'cv', gpu: null })
  assert.ok(!args.includes('--gpus'), 'an ordinary room was given a device')
  assert.ok(
    !args.some((arg) => arg.startsWith('--shm-size') || arg.startsWith('colloq.gpu=')),
    'an ordinary room got something extra',
  )
  // Everything from before is in place: the image by environment name, only
  // this room's folder, the host loopback and the limits.
  assert.equal(args[args.length - 1], 'colloq-kernel:cv')
  assert.equal(valueOf(args, '-v'), '/srv/workspace/seminar1:/workspace/seminar1')
  assert.equal(valueOf(args, '-p'), '127.0.0.1:0:8888')
  // The memory default since 13 Sep 2026 is 4g for a plain environment
  // (admin/resource-settings.ts), written in megabytes like every limit.
  assert.ok(args.includes('--memory=4096m') && args.includes('--cpus=2'))
  assert.ok(args.includes('colloq.session=seminar1'))
})

test('in network mode the port is not published at all', () => {
  const args = runArgs({ ...room, network: 'colloq', publish: false, gpu: null })
  assert.equal(valueOf(args, '--network'), 'colloq')
  assert.ok(!args.includes('-p'), "the room's Jupyter was exposed on the host")
})

test('as many threads as allocated cores — for any room', () => {
  // os.cpu_count() inside the container shows the HOST's cores: without these
  // three lines numpy and torch start thirty threads each on two allocated
  // cores.
  withEnv({ KERNEL_CPUS: '4' }, () => {
    for (const gpu of [null, '0']) {
      const args = runArgs({ ...room, gpu })
      for (const name of ['OMP', 'MKL', 'OPENBLAS']) {
        assert.ok(args.includes(`${name}_NUM_THREADS=4`), `${name} with gpu=${gpu}`)
      }
    }
  })
})

test('fractional --cpus do not turn into a fractional number of threads', () => {
  withEnv({ KERNEL_CPUS: '1.5' }, () => {
    const args = runArgs({ ...room, gpu: null })
    assert.ok(args.includes('OMP_NUM_THREADS=1'), 'the number of threads is not a whole number')
    // The docker limit itself stays fractional: that it can do.
    assert.ok(args.includes('--cpus=1.5'))
  })
})

test('the shared memory size is configurable', () => {
  withEnv({ KERNEL_SHM: '4g' }, () => {
    assert.ok(runArgs({ ...room, gpu: '0' }).includes('--shm-size=4g'))
  })
})
