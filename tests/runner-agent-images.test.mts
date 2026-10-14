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
import { Images, revisionImage } from '../server/src/runner-agent/images.ts'
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
