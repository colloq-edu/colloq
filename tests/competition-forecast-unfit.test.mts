/**
 * A notebook whose package set no longer fits its memory is refused before
 * any container (runner.ts · unfitOutcome) — by this server's pump when it
 * takes the row, by the clock with its notebooks off (liveness.ts ·
 * settleUnfit) — and no machine ever leases it (remote/fit.ts · rowNeeds).
 *
 * A GPU notebook on a server with its notebooks on and no card for
 * submissions fell between them: the pump passes GPU work over without a
 * share, the clock settles only with the notebooks off, and the wait reasons
 * left it to "its own pump". It waited for ever with place 1, «начнётся
 * сейчас» and no reason. The screens now say what is true: no executor can
 * fit it (`no_fit`), and it has no place.
 *
 * No Docker and no machine: the forecast and the pump over the queue rows.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Competition } from '../shared/competitions.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { pumpOnce, queueSlots, settleCompetitionWork } from '../server/src/competitions/runner.js'
import { getSubmission, queueRow, setQueuePaused, updateCompetition } from '../server/src/competitions/store.js'
import { bindSubmission, completeBundle, createBundle, setPolicy } from '../server/src/dependencies/store.js'
import { runnerGpuDevices } from '../server/src/competitions/gpu.js'
import { queueForecast } from '../server/src/competitions/forecast.js'
import { competition, reset, send, type TestCompetition } from './_remote.mts'

for (const key of ['KERNEL_GPUS', 'COMPETITION_GPUS', 'COMPETITION_GPU_PER_DEVICE']) delete process.env[key]

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)
after(() => setQueuePaused(false))

const MiB = 1024 * 1024

/** A submission whose package set fitted when it was attached, and no longer does: the teacher lowered the memory to 512 MB. */
function unfitSubmission(c: TestCompetition) {
  setPolicy(c.id, { enabled: true })
  const sent = send(c, { cells: ['import catboost'], revisionId: null })
  const set = createBundle(c.id, sent.entrantId, c.revisionId, 'catboost')
  completeBundle(set.id, {
    normalizedRequirements: ['catboost'], downloadBytes: 1, installedBytes: 315 * MiB, contentHash: '3'.repeat(64),
    packages: [{ name: 'catboost', version: '1.2.10', fileName: 'catboost-1.2.10-py3-none-any.whl', sha256: '4'.repeat(64), bytes: 1 }],
    lock: `catboost==1.2.10 --hash=sha256:${'4'.repeat(64)}\n`,
  })
  bindSubmission(sent.id, c.revisionId, set.id)
  updateCompetition(c.id, { limits: { ...c.limits, memoryMb: 512 } })
  return sent
}

test('a GPU notebook whose set no longer fits, on a server with its notebooks on and no card, waits with a reason and no place', async () => {
  reset({ homeNotebooks: true })
  assert.deepEqual(runnerGpuDevices(), [], 'no card of this server is given to submissions')
  const g: Competition & { revisionId: string } = competition({ gpu: true, memoryMb: 2048 })
  const sent = unfitSubmission(g)
  assert.equal(await pumpOnce(), 0, 'this server takes no GPU notebook without a card')
  const forecast = queueForecast(queueSlots(), Date.now())
  assert.deepEqual(forecast.reasons.get(sent.id), { reason: 'no_fit' })
  assert.equal(forecast.at.has(sent.id), false, 'no executor will start it')
  assert.ok(forecast.eligible.some((row) => row.submissionId === sent.id), 'still listed')
  // The same on the CPU: this server's pump takes it and refuses it at once, so it waits with a place, for a moment.
  const c = competition({ memoryMb: 2048 })
  const cpu = unfitSubmission(c)
  const before = queueForecast(queueSlots(), Date.now())
  assert.equal(before.reasons.has(cpu.id), false)
  assert.equal(before.at.get(cpu.id)?.place, 1)
  assert.equal(await pumpOnce(), 1)
  await settleCompetitionWork()
  assert.equal(getSubmission(cpu.id)?.state, 'rejected')
  assert.equal(queueRow(cpu.id), null)
  reset()
})
