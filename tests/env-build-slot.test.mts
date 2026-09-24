/**
 * The build slot: who is busy while a chain runs.
 *
 * Environment inheritance means that pressing Build on `gpu` also builds
 * `base-gpu` under it. The `startBuild` header promises: "while the chain
 * runs, 'Building' shows on every link of it, and a second Build on the
 * parent will not start in the middle of this build". The promise held only
 * halfway: the slot was taken synchronously only for the name itself, while
 * the parents were registered after `docker compose ps` and the image
 * lookup — hundreds of milliseconds, in which a second panel window managed
 * to start its own `docker build` with the same `-t`. Then the parent's
 * entry got replaced by the child's (the parent's log and Cancel vanished),
 * and the end of the chain deleted it while the parent's own build was still
 * running.
 *
 * Exactly that window is checked here: between the call to `startBuild` and
 * the first `await` inside it. Docker is not needed for this — the build is
 * cancelled before it gets there.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChain,
  buildLog,
  cancelBuild,
  isBuilding,
  startBuild,
} from '../server/src/environments.js'

test('the whole chain is taken at once — a second Build on the parent will not start', async () => {
  // The repository's model chain; if it drifts, the test must say so in
  // words rather than silently check something else.
  assert.deepEqual(buildChain('gpu'), ['base-gpu', 'gpu'])
  assert.equal(isBuilding('base-gpu'), false, 'someone is already building the base before the test starts')

  const first = startBuild('gpu')
  /*
   * Not a single `await` between the start and these lines — that is the
   * window. It used to be `false` here, and the next Build started a second
   * build.
   *
   * The snapshot is taken before `cancelBuild`, and the assertions after:
   * the cancellation must happen in this same tick, otherwise a failed
   * assertion would leave a real `docker build` on the machine for ten
   * minutes.
   */
  const busyChild = isBuilding('gpu')
  const busyParent = isBuilding('base-gpu')
  const second = startBuild('base-gpu')
  const log = buildLog('base-gpu')
  const seen = { done: log?.done, failed: log?.failed, lines: log?.lines.join(' / ') ?? '' }
  cancelBuild('gpu')

  assert.equal(busyChild, true)
  assert.equal(busyParent, true, 'the parent is free while the chain is already on its way to it')
  assert.ok(log, 'the parent has no log — so it does not belong to the running chain')
  assert.equal(seen.done, false)
  assert.equal(seen.failed, false, `the second Build on the parent set something up: ${seen.lines}`)

  await Promise.all([first, second])

  // And it let go: "Building" on a link nobody builds is a locked button and
  // a lie in the row.
  assert.equal(isBuilding('base-gpu'), false, 'the parent stayed busy after the chain ended')
  assert.equal(isBuilding('gpu'), false)
})

test('Build on a link of someone else\'s live chain refuses in words, not silently', async () => {
  const first = startBuild('gpu')
  const second = startBuild('base-gpu')
  const said = buildLog('base-gpu')?.lines.join('\n') ?? ''
  cancelBuild('gpu')
  // The parent's log is the log of the FIRST build, and the second one wrote
  // nothing into it: the refusal is addressed to whoever pressed, not to
  // whoever is already building.
  assert.equal(/уже собирается/.test(said), false)
  await Promise.all([first, second])

  // But the other way round — a chain on top of a busy parent — refuses out
  // loud.
  const parent = startBuild('base-gpu')
  const child = startBuild('gpu')
  const childLog = buildLog('gpu')
  const childSaid = childLog?.lines.join('\n') ?? ''
  const childFailed = childLog?.failed
  cancelBuild('base-gpu')

  assert.ok(childLog)
  assert.match(
    childSaid,
    /«base-gpu».*уже собирается/,
    'the child started building on top of a layer that is being rebuilt at this moment',
  )
  assert.equal(childFailed, true)
  await Promise.all([parent, child])
})
