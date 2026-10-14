/**
 * The kernels a machine runs (server/src/runner-agent/images.ts): pulled by
 * digest, checked against the pinned layers, smoke-tested on a card when they
 * are GPU kernels, tagged colloq-revision:<id>, and evicted when nobody wanted
 * them for a day and the disk runs low.
 *
 * What each check stops: an image whose layers are not the pin is not what
 * home scored the other submissions in; a ref that cannot be pulled (a local
 * build named for a registry and never pushed, §13 note 6) must never read as
 * ready; a GPU kernel on a driver older than CUDA 13 wants fails every
 * notebook on its first `.cuda()`, each a participant's attempt.
 */
import './_env.mts'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REMOTE_DRIVER_MIN, REMOTE_EVICT_AFTER_MS } from '../shared/remote-runner.ts'
import { CHECK_LABEL, INSTANCE_LABEL, Images, SOON_MS, revisionImage } from '../server/src/runner-agent/images.ts'
import { TEST_ROOT } from './_env.mts'
import { DIFF_IDS, LAYERS, REVISION, fakeAgentDocker, waitFor } from './_runner-agent-home.mts'

const DIR = path.join(TEST_ROOT, 'books', 'revisions')

beforeEach(() => fs.rmSync(DIR, { recursive: true, force: true }))

function imagesFor(docker: ReturnType<typeof fakeAgentDocker>, cards = { count: 0, driver: null as string | null }, now = () => Date.now()): Images {
  return new Images({ docker, dir: DIR, cards: () => cards, now, log: () => undefined })
}

const want = (gpu = false, id = REVISION.id, ref = REVISION.ref, layers = LAYERS) => [{ id, ref, layers, gpu }]

test('a revision is pulled by its ref, its layers checked against the pin, tagged, and only then ready', async () => {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const images = imagesFor(docker)
  images.want(want())
  await images.idle()
  assert.deepEqual(images.readyIds(), [REVISION.id])
  assert.deepEqual(images.problemList(), [])
  const commands = docker.calls.map((args) => args.slice(0, 2).join(' '))
  assert.deepEqual(commands.filter((command) => !command.startsWith('image inspect')), [`pull ${REVISION.ref}`, `tag ${REVISION.ref}`])
  assert.ok(docker.images.has(revisionImage(REVISION.id)))
  // The lease's run is checked once more, against the lease's own pin.
  assert.equal(await images.verify({ id: REVISION.id, layers: LAYERS }), revisionImage(REVISION.id))
  assert.equal(await images.verify({ id: REVISION.id, layers: 'e'.repeat(64) }), null)
  // A tag whose image changed under it (an operator's retag) is not the pin any more.
  docker.images.set(revisionImage(REVISION.id), { diffIds: [`sha256:${'9'.repeat(64)}`] })
  assert.equal(await images.verify({ id: REVISION.id, layers: LAYERS }), null)
  assert.deepEqual(images.readyIds(), [])
  images.stop()
})

test('an image whose layers are not the pin is a `layers` problem and never ready; a ref that cannot be pulled is an `image` problem', async () => {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: [`sha256:${'8'.repeat(64)}`] })
  const images = imagesFor(docker)
  images.want(want())
  await images.idle()
  assert.deepEqual(images.readyIds(), [])
  assert.deepEqual(images.problemList().map((problem) => [problem.code, problem.revisionId]), [['layers', REVISION.id]])
  assert.ok(!docker.calls.some((args) => args[0] === 'tag'), 'an image not the pin was tagged')

  // The containerd caveat: a ref recorded for a local build that was never pushed. The pull fails, and it says so.
  const unpushed = { id: 'b'.repeat(32), ref: `ghcr.io/colloq-edu/colloq-kernel@sha256:${'7'.repeat(64)}` }
  images.want(want(false, unpushed.id, unpushed.ref))
  await images.idle()
  const problem = images.problemList().find((found) => found.revisionId === unpushed.id)
  assert.equal(problem?.code, 'image')
  assert.match(problem!.detail, /manifest unknown/)
  // The problem of a revision home no longer wants is nobody's.
  assert.ok(!images.problemList().some((found) => found.revisionId === REVISION.id))
  images.stop()
})

test('a GPU revision is ready only after torch used card 0 in it; a driver older than CUDA 13 wants fails before a pull', async () => {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const cards = { count: 2, driver: '535.104.05' as string | null }
  const images = imagesFor(docker, cards)
  images.want(want(true))
  await images.idle()
  const problem = images.problemList()[0]
  assert.equal(problem?.code, 'smoke')
  assert.match(problem!.detail, new RegExp(`535\\.104\\.05.*${REMOTE_DRIVER_MIN}`))
  assert.ok(!docker.calls.some((args) => args[0] === 'pull'), 'gigabytes were pulled for an answer known in advance')
  images.stop()

  // A driver new enough: pulled, and the smoke test decides.
  const second = fakeAgentDocker()
  second.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  second.smoke = { code: 3, out: 'cuda-missing' }
  const failing = imagesFor(second, { count: 2, driver: '580.65.06' })
  failing.want(want(true))
  await failing.idle()
  assert.deepEqual(failing.readyIds(), [])
  assert.equal(failing.problemList()[0]?.code, 'smoke')
  assert.match(failing.problemList()[0]!.detail, /no CUDA device/)
  const smoke = second.calls.find((args) => args[0] === 'run')!
  // On card 0, under the hardening a check of someone else's image deserves, never pulled again.
  for (const flag of ['--rm', '--pull=never', '--network', '--cap-drop=ALL', '--read-only', '--user=1000:1000']) assert.ok(smoke.includes(flag), flag)
  assert.equal(smoke[smoke.indexOf('--gpus') + 1], 'device=0')
  failing.stop()

  const third = fakeAgentDocker()
  third.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const passing = imagesFor(third, { count: 1, driver: '580.65.06' })
  passing.want(want(true))
  await passing.idle()
  assert.deepEqual(passing.readyIds(), [REVISION.id])
  passing.stop()

  // A machine without cards is not asked for a GPU kernel, and does not pull one if it is.
  const none = fakeAgentDocker()
  none.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const cpu = imagesFor(none, { count: 0, driver: null })
  cpu.want(want(true))
  await cpu.idle()
  assert.ok(!none.calls.some((args) => args[0] === 'pull'))
  cpu.stop()
})

test('a pull\'s progress is its layers in place; a failed revision waits before it is tried again', async () => {
  const docker = fakeAgentDocker()
  const seen: number[] = []
  let images!: Images
  docker.intercept = (args) => {
    if (args[0] === 'pull') {
      docker.images.set(args[1]!, { diffIds: DIFF_IDS })
      return undefined
    }
    return undefined
  }
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  images = new Images({ docker, dir: DIR, cards: () => ({ count: 0, driver: null }), onChange: () => {
    const fetching = images.fetchingList()
    if (fetching[0]) seen.push(fetching[0].percent)
  } })
  images.want(want())
  await images.idle()
  assert.deepEqual(images.readyIds(), [REVISION.id])
  assert.ok(seen.includes(0), seen.join())
  assert.deepEqual(images.fetchingList(), [])

  // Another revision whose pull fails: asked again only after its wait, not in a loop.
  const other = { id: 'c'.repeat(32), ref: `ghcr.io/colloq-edu/colloq-kernel@sha256:${'6'.repeat(64)}` }
  images.want([...want(), ...want(false, other.id, other.ref)])
  await images.idle()
  images.want([...want(), ...want(false, other.id, other.ref)])
  await images.idle()
  assert.equal(docker.calls.filter((args) => args[0] === 'pull' && args[1] === other.ref).length, 1)
  images.stop()
})

test('a revision ready in an earlier life is ready again only with its tag in place; below the floor, revisions not wanted for a day go', async () => {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  let now = Date.now()
  const first = imagesFor(docker, undefined, () => now)
  first.want(want())
  await first.idle()
  first.stop()

  // The next life: the tag is still there.
  const second = imagesFor(docker, undefined, () => now)
  await second.load()
  assert.deepEqual(second.readyIds(), [REVISION.id])
  // Someone pruned it meanwhile.
  docker.images.delete(revisionImage(REVISION.id))
  const third = imagesFor(docker, undefined, () => now)
  await third.load()
  assert.deepEqual(third.readyIds(), [])
  third.stop()
  second.stop()

  // Eviction: wanted, or held by a lease, or wanted within a day, stays.
  docker.images.set(revisionImage(REVISION.id), { diffIds: DIFF_IDS })
  const fourth = imagesFor(docker, undefined, () => now)
  await fourth.load()
  let free = 100
  assert.equal(await fourth.evict(new Set(), () => free, 1000), 0, 'a revision wanted an hour ago was evicted')
  now += REMOTE_EVICT_AFTER_MS + 60_000
  assert.equal(await fourth.evict(new Set([REVISION.id]), () => free, 1000), 0, 'a revision a lease runs in was evicted')
  fourth.want([])
  assert.equal(await fourth.evict(new Set(), () => free, 1000), 1)
  assert.ok(docker.calls.some((args) => args[0] === 'rmi' && args[1] === revisionImage(REVISION.id)))
  assert.ok(docker.calls.some((args) => args[0] === 'rmi' && args[1] === REVISION.ref))
  assert.deepEqual(fourth.readyIds(), [])
  // Above the floor nothing goes, however old.
  free = 5000
  assert.equal(await fourth.evict(new Set(), () => free, 1000), 0)
  fourth.stop()
  await waitFor(() => true, 'nothing')
})

test('no pull starts while the disk Docker keeps images on is below its floor; a pull that runs out of disk is the machine\'s disk, not the image\'s', async () => {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  let room = false
  let clock = Date.now()
  const fulls: string[] = []
  const images = new Images({ docker, dir: DIR, cards: () => ({ count: 0, driver: null }), now: () => clock, diskGate: async () => room, onDiskFull: (detail) => fulls.push(detail), log: () => undefined })
  try {
    images.want(want())
    await images.idle()
    assert.ok(!docker.calls.some((args) => args[0] === 'pull'), 'a pull started below the floor')
    assert.deepEqual(images.problemList(), [], 'a disk below its floor was said as a problem of the image')
    assert.deepEqual(images.readyIds(), [])
    // Room, but the pull runs out of it midway: the daemon's words, said as the disk's.
    room = true
    docker.intercept = (args) => (args[0] === 'pull' ? { code: 1, out: 'failed to register layer: write /var/lib/docker/overlay2/x/diff/usr/lib/libtorch.so: no space left on device' } : undefined)
    clock += 61_000
    images.want(want())
    await images.idle()
    assert.equal(fulls.length, 1)
    assert.match(fulls[0]!, /no space left on device/)
    assert.deepEqual(images.problemList(), [], 'a pull that ran out of disk was said as a bad image')
    // A minute later, with room again: pulled, checked, ready.
    docker.intercept = null
    clock += 61_000
    images.want(want())
    await images.idle()
    assert.deepEqual(images.readyIds(), [REVISION.id])
  } finally {
    images.stop()
  }
})

test('the smoke test is labelled for this tree as well as for its kind, and named for it: another agent on the daemon sweeps none of it', async () => {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const images = imagesFor(docker, { count: 1, driver: '580.65.06' })
  images.want(want(true))
  await images.idle()
  images.stop()
  const smoke = docker.calls.find((args) => args[0] === 'run' && args.includes('python'))!
  const labels = smoke.flatMap((arg, index) => (smoke[index - 1] === '--label' ? [arg] : []))
  assert.deepEqual(labels.sort(), [CHECK_LABEL, INSTANCE_LABEL].sort())
  assert.match(INSTANCE_LABEL, /^ru\.colloq\.competition-instance=[a-f0-9]{16}$/)
  const name = smoke[smoke.indexOf('--name') + 1]!
  assert.ok(name.includes(INSTANCE_LABEL.split('=')[1]!.slice(0, 8)), name)
})

test('an inspect that fails without saying why is asked again before it is believed: a hiccup neither fails the check before a run nor unreadies the revision, nor does it at a start', async () => {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const options = { docker, dir: DIR, cards: () => ({ count: 0, driver: null }), inspectRetryMs: [5, 5, 5], log: () => undefined }
  const images = new Images(options)
  images.want(want())
  await images.idle()
  assert.deepEqual(images.readyIds(), [REVISION.id])
  const tag = revisionImage(REVISION.id)
  const tagInspects = (): number => docker.calls.filter((args) => args[0] === 'image' && args[1] === 'inspect' && args[2] === tag).length
  // A daemon under a burst, in its three ways of saying nothing: an error of its own, a CLI killed at its timeout, a socket that refused.
  for (const hiccup of [
    { code: 1, out: 'Error response from daemon: context deadline exceeded' },
    { code: -1, out: '' },
    { code: 1, out: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' },
  ]) {
    let failed = 0
    docker.intercept = (args) => (args[0] === 'image' && args[1] === 'inspect' && args[2] === tag && failed++ === 0 ? hiccup : undefined)
    assert.equal(await images.verify({ id: REVISION.id, layers: LAYERS }), tag, `one failed inspect (${JSON.stringify(hiccup)}) declined the run`)
    assert.equal(failed, 2, 'the failed inspect was not asked again')
    assert.deepEqual(images.readyIds(), [REVISION.id], 'one failed inspect unreadied the revision')
  }
  // An answer is believed at once: "no such image" is the image gone, not asked again.
  docker.intercept = null
  docker.images.delete(tag)
  const before = tagInspects()
  assert.equal(await images.verify({ id: REVISION.id, layers: LAYERS }), null)
  assert.equal(tagInspects() - before, 1)
  assert.deepEqual(images.readyIds(), [])
  await images.idle()
  // Made ready again from its ref, as before.
  assert.deepEqual(images.readyIds(), [REVISION.id])
  images.stop()

  // A start with one hiccup: still ready. A start with a daemon that fails every try: the book's word stands for the check before a run.
  let failedAtStart = 0
  docker.intercept = (args) => (args[0] === 'image' && args[1] === 'inspect' && args[2] === tag && failedAtStart++ === 0 ? { code: 1, out: 'Error response from daemon: context deadline exceeded' } : undefined)
  const second = new Images(options)
  await second.load()
  assert.deepEqual(second.readyIds(), [REVISION.id], 'one failed inspect at a start unreadied the revision')
  second.stop()
  docker.intercept = (args) => (args[0] === 'image' && args[1] === 'inspect' && args[2] === tag ? { code: 1, out: 'Error response from daemon: context deadline exceeded' } : undefined)
  const third = new Images(options)
  await third.load()
  assert.deepEqual(third.readyIds(), [REVISION.id], 'a daemon that did not answer at a start unreadied the revision')
  // Right before a run, every try failing: the lease is not run on it, and the revision is checked again before it is ready.
  const tries = tagInspects()
  assert.equal(await third.verify({ id: REVISION.id, layers: LAYERS }), null)
  assert.equal(tagInspects() - tries, 4, 'the check before a run was not asked again the backoff\'s three times')
  assert.deepEqual(third.readyIds(), [])
  // A lease that stops waiting stops the tries, and unreadies nothing.
  await third.idle()
  docker.intercept = null
  third.want(want())
  await third.idle()
  assert.deepEqual(third.readyIds(), [REVISION.id])
  docker.intercept = (args) => (args[0] === 'image' && args[1] === 'inspect' && args[2] === tag ? { code: 1, out: 'Error response from daemon: context deadline exceeded' } : undefined)
  const stopped = new AbortController()
  stopped.abort()
  assert.equal(await third.verify({ id: REVISION.id, layers: LAYERS }, stopped.signal), null)
  assert.deepEqual(third.readyIds(), [REVISION.id], 'a lease that stopped waiting unreadied the revision')
  third.stop()
})

test('a GPU revision\'s check runs on the card with room it is given, held while it runs; no card with room, or one a burst filled under it, is a short wait and says nothing against the revision', async () => {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  let clock = Date.now()
  let free: string | null = null
  const held: string[] = []
  const released: string[] = []
  const images = new Images({
    docker,
    dir: DIR,
    now: () => clock,
    cards: () => ({ count: 2, driver: '580.65.06' }),
    smokeCard: () => {
      if (free === null) return null
      const device = free
      held.push(device)
      return { device, release: () => released.push(device) }
    },
    log: () => undefined,
  })
  const checks = (): string[][] => docker.calls.filter((args) => args[0] === 'run' && args.includes('python'))
  try {
    // Every share of every card taken (a burst): no check at all, and nothing said against the revision.
    images.want(want(true))
    await images.idle()
    assert.equal(checks().length, 0, 'a GPU check ran with no card that had room for it')
    assert.deepEqual(images.problemList(), [])
    assert.deepEqual(images.readyIds(), [])
    // A share frees on card 1, and a run fills the card before the check gets its context: CUDA out of memory, still no verdict.
    free = '1'
    docker.smoke = { code: 1, out: 'Traceback (most recent call last):\n  File "<string>", line 7, in <module>\ntorch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 MiB' }
    clock += SOON_MS + 1
    images.want(want(true))
    await images.idle()
    assert.equal(checks().length, 1)
    assert.equal(checks()[0]![checks()[0]!.indexOf('--gpus') + 1], 'device=1', 'the check did not run on the card it was given')
    assert.deepEqual({ held, released }, { held: ['1'], released: ['1'] }, 'the check\'s share was not held and given back')
    assert.deepEqual(images.problemList(), [], 'a card full of runs was said as a broken revision')
    assert.deepEqual(images.readyIds(), [])
    // Asked again after the short wait, not two minutes doubling to thirty: the card has room now.
    docker.smoke = { code: 0, out: 'cuda-ok 13.0' }
    clock += SOON_MS - 2_000
    images.want(want(true))
    await images.idle()
    assert.equal(checks().length, 1, 'asked again before its wait was over')
    clock += 3_000
    images.want(want(true))
    await images.idle()
    assert.equal(checks().length, 2)
    assert.deepEqual(images.readyIds(), [REVISION.id])
  } finally {
    images.stop()
  }
})
