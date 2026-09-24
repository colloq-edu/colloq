/**
 * Why the kernel died — and how much memory it was allowed.
 *
 * On 13 Sep 2026 a seminar hit the same cell fifteen times in a row:
 * `resnet18` on a 224×224 batch asked for more than two gigabytes, the cgroup
 * killed python, Jupyter silently started a new one, and each time the room
 * read the same "the kernel restarted". The cause — a two-gigabyte limit —
 * could only be found through `dmesg` on the machine.
 *
 * Both halves of the fix are pinned down here: a limit that can be raised
 * without touching code, and a postmortem that names the cause in numbers.
 * There is no real docker in the suite (see `_env.mts`), so it is faked
 * entirely — with exactly the answers taken from the live machine on the day
 * of the incident.
 */
import './_env.mts'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runArgs } from '../server/src/kernel/pool.js'
import {
  describe,
  explain,
  forgetKills,
  killedByMemory,
  useDockerForPostmortem,
  type MemoryReading,
} from '../server/src/kernel/postmortem.js'
import { setLocaleResolver } from '../shared/i18n.js'

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

const room = { sessionId: 'pvhu2h7f', mount: '/srv/workspace/pvhu2h7f', network: 'colloq-rooms', publish: true, gpu: null }

afterEach(() => {
  useDockerForPostmortem(null)
  forgetKills('pvhu2h7f')
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------ how much memory to give */

test('the room memory limit comes from the environment, and the default stays as it was', () => {
  // Defaults since 13 Sep 2026: 4g for a plain environment, 16g for a GPU one.
  assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=4g'), 'the default changed')
  withEnv({ KERNEL_MEM: '12g' }, () => {
    assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=12g'))
  })
})

test('a heavy environment can get its own limit without raising it for all rooms', () => {
  /*
   * This is what it was all for: a computer vision seminar on `base-gpu` asks
   * for sixteen gigabytes, while ten light rooms next to it, given as much,
   * would eat the machine without ever using that memory.
   */
  withEnv({ KERNEL_MEM: '2g', KERNEL_MEM_BASE_GPU: '16g' }, () => {
    assert.ok(runArgs({ ...room, env: 'base-gpu' }).includes('--memory=16g'), 'the environment did not override the common limit')
    assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=2g'), 'the limit was raised for everyone')
  })
})

/* ------------------------------------------- was it memory — and was it this cell */

const reading = (over: Partial<MemoryReading> = {}): MemoryReading => ({
  limit: 2 * 1024 ** 3,
  peak: 2 * 1024 ** 3,
  current: 117 * 1024 ** 2,
  kills: 16,
  containerOomKilled: true,
  status: 'running',
  exit: 0,
  tail: [],
  ...over,
})

test('the kill counter tells "killed by this cell" from "killed this morning"', () => {
  /*
   * `docker inspect` shows OOMKilled: true even eight hours after the last
   * kill — the container is alive, it was the process inside that got killed.
   * Judging by it means declaring every later kernel death a memory shortage.
   */
  assert.equal(killedByMemory(reading(), 15), true, 'a counter increase was not recognised as a kill')
  assert.equal(killedByMemory(reading(), 16), false, 'a stuck flag was passed off as a fresh kill')
})

test('without a baseline the peak decides: hit the limit means hit the limit', () => {
  // The server was restarted in the middle of class; there is no remembered
  // number.
  assert.equal(killedByMemory(reading({ peak: 2 * 1024 ** 3 + 1_679_360 }), undefined), true)
  assert.equal(
    killedByMemory(reading({ peak: 300 * 1024 ** 2, containerOomKilled: false }), undefined),
    false,
    'a kernel that died far from the limit was declared to have eaten the memory',
  )
})

test('the sentence names the limit, the usage and the cell number — the same one drawn in the room', () => {
  const text = describe(reading(), true, 21)
  assert.match(text, /по памяти/)
  assert.match(text, /2 ГБ/)
  assert.match(text, /ячейке 21/)
  assert.match(text, /KERNEL_MEM/, 'it does not say which knob to turn')
  setLocaleResolver(() => 'en')
  assert.match(describe(reading(), true, 21), /killed by memory/)
  assert.match(describe(reading(), true, 21), /2 GB/)
})

/* ------------------------------------------------------ full postmortem */

const V2 = [
  'limit 2147483648',
  'limit ',
  'peak 2149163008',
  'peak ',
  'current 122683392',
  'current ',
  'kills 16',
  'kills ',
].join('\n')

/** cgroup v1: the same numbers under other names and in a subdirectory. */
const V1 = ['limit ', 'limit 2147483648', 'peak ', 'peak 2149163008', 'current ', 'current 122683392', 'kills 83'].join('\n')

function fakeDocker(cgroup: string, inspect = 'running 0 true 2147483648', logs = ''): Array<string[]> {
  const calls: Array<string[]> = []
  useDockerForPostmortem(async (args) => {
    calls.push(args)
    if (args[0] === 'exec') return { code: 0, out: cgroup }
    if (args[0] === 'logs') return { code: 0, out: logs }
    return { code: 0, out: inspect }
  })
  return calls
}

test('the postmortem reads the cgroup of a live container and explains the kernel death in numbers', async () => {
  const calls = fakeDocker(V2)
  const why = await explain('pvhu2h7f', 21)
  assert.ok(why, 'the postmortem said nothing where everything is known')
  assert.equal(why.oom, true)
  assert.equal(why.reading.limit, 2147483648)
  assert.equal(why.reading.peak, 2149163008)
  assert.match(why.text, /лимит 2 ГБ/)
  assert.match(why.text, /ячейке 21/)
  // The container is queried by the room name, not by something guessed.
  assert.ok(calls.every((args) => args.includes('colloq-room-pvhu2h7f')), JSON.stringify(calls))
})

test('cgroup v1 is read into the same fields', async () => {
  fakeDocker(V1)
  const why = await explain('pvhu2h7f', null)
  assert.ok(why)
  assert.equal(why.reading.limit, 2147483648)
  assert.equal(why.oom, true)
})

test('a second postmortem in a row does not blame memory for a death it did not cause', async () => {
  /*
   * The first call remembers the counter, the second compares against it: the
   * container is the same, there were no more kills — so the kernel died of
   * something else, and yesterday's kill must not be passed off as a memory
   * shortage.
   */
  fakeDocker(V2)
  assert.equal((await explain('pvhu2h7f', 21))?.oom, true)
  const again = await explain('pvhu2h7f', 22)
  assert.equal(again?.oom, false, 'the same counter was passed off as a new kill')
  assert.match(String(again?.text), /не по памяти/)
})

test('a container that went down entirely is explained by its exit code and the tail of its log', async () => {
  fakeDocker(
    'limit 2147483648\npeak 900000000\ncurrent 0\nkills 0',
    'exited 139 false 2147483648',
    ['[I 2026-09-13 12:00:00 ServerApp] Kernel started: 3868f7e5', 'Kernel is running over TCP without encryption.', 'Segmentation fault (core dumped)'].join('\n'),
  )
  const why = await explain('pvhu2h7f', 21)
  assert.ok(why)
  assert.equal(why.oom, false)
  assert.match(why.text, /139/)
  assert.match(why.text, /Segmentation fault/)
  // Nobody needs Jupyter's chatter about encryption in the explanation.
  assert.ok(!/without encryption/.test(why.text), 'noise from the log got into the reason')
})

test('a silent docker stays silent in the room too, instead of inventing a reason', async () => {
  useDockerForPostmortem(async () => ({ code: 1, out: 'Error: No such container' }))
  assert.equal(await explain('pvhu2h7f', 21), null)
})
