/**
 * What the queue promises about a notebook this server leaves to the
 * machines for its size (runner.ts · leftToMachines): more memory than it
 * could ever reserve, or more cores than it has while a machine will take it.
 *
 * The pump passes such a notebook over, and the forecast used to read it as
 * one this server takes: its free slot gave it place 1 and «начнётся
 * сейчас», with no reason, for as long as a machine pulled its image or ran
 * the notebook before it — and with no machine at all it waited for ever
 * with the same promise. The forecast and the wait reasons now ask the
 * pump's own question with the same machines (forecast.ts · queueForecast,
 * remote/views.ts · waitReasons): no place of this server's for it, the
 * machines' places and reasons instead, and with none on line `no_runners`,
 * said as this server being too small — not as a server that only scores,
 * and not as a missing card.
 *
 * The first test runs before any machine joins: a server that never had
 * one says nothing of machines, except of these notebooks.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { useHomeRunRoom } from '../server/src/competitions/executors.js'
import { queueForecast } from '../server/src/competitions/forecast.js'
import { leftToMachines, pumpOnce, setQueueSlots, settleCompetitionWork } from '../server/src/competitions/runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { getSubmission, queueRow } from '../server/src/competitions/store.js'
import { anyRunnerEver } from '../server/src/competitions/remote/store.js'
import { dataNow } from '../server/src/competitions/remote/want.js'
import { setLocaleResolver, translate } from '../shared/i18n.js'
import type { CompetitionLive } from '../shared/competitions-api.js'
import { waitingLine } from '../web/src/admin/runners.js'
import { FACTS, Machine, close, code, competition, reset, send, serve, type TestCompetition } from './_remote.mts'
import { call, staffMember } from './_scoping.mts'

// A checkout's .env must not give this server cards: the GPU notebook below is one it has no card for.
for (const key of ['KERNEL_GPUS', 'COMPETITION_GPUS', 'COMPETITION_GPU_PER_DEVICE']) delete process.env[key]

const owner = staffMember('Владелица Очереди', 'owner')
const CYRILLIC = /[а-яё]/i

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

after(() => {
  useCompetitionRunner(null)
  useHomeRunRoom(null)
  setLocaleResolver(() => 'ru')
  reset()
  close()
})

/** What a machine has in place for a competition: its image and its open data. */
function readyFor(c: TestCompetition) {
  const sets = dataNow(c.id)
  return { revisions: [c.revisionId], data: sets.open ? [sets.open.manifest] : [], sealed: [] as string[], bundles: [] as string[] }
}

async function live(competitionId: string): Promise<CompetitionLive> {
  const res = await call(await serve(), 'GET', `/api/admin/competitions/${competitionId}/live`, { cookie: owner.cookie })
  assert.equal(res.status, 200)
  return (await res.json()) as CompetitionLive
}

test('never a machine: a notebook too big for this server waits as no_runners, with no place, in the words of its size', async () => {
  reset({ homeNotebooks: true })
  setQueueSlots(4)
  assert.equal(anyRunnerEver(), false, 'this file\'s server has never had a machine')
  // A server of sixteen gigabytes: fifteen for competition work.
  useHomeRunRoom({ cpus: 16, memoryMb: 15_360 })
  try {
    const big = competition({ memoryMb: 49_152 })
    const huge = send(big, { at: Date.now() - 1000 })
    const small = send(competition({ memoryMb: 2048 }))
    assert.deepEqual(leftToMachines(), [huge.id])

    const forecast = queueForecast(4, Date.now())
    assert.deepEqual(forecast.reasons.get(huge.id), { reason: 'no_runners', tooBig: true })
    assert.equal(forecast.at.has(huge.id), false, 'no slot of this server will ever take it')
    assert.ok(forecast.eligible.some((row) => row.submissionId === huge.id), 'still listed')
    // The rest of the queue is still the queue as it was: no word of machines, and the notebook behind starts first.
    assert.equal(forecast.reasons.has(small.id), false)
    assert.equal(forecast.at.get(small.id)?.place, 1)
    assert.equal(forecast.at.get(small.id)?.startMs, 0)

    // The console reads the same: no place, no estimate, the reason and its size.
    const row = (await live(big.id)).waiting.find((one) => one.submissionId === huge.id)!
    assert.equal(row.place, null)
    assert.equal(row.etaMs, null)
    assert.equal(row.reason, 'no_runners')
    assert.equal(row.tooBig, true)
    setLocaleResolver(() => 'ru')
    assert.equal(waitingLine(row, false, null)?.text, 'некому считать: для этого сервера посылка велика, а машины работу не берут')
    // A server that only scores keeps its own words.
    assert.equal(waitingLine({ reason: 'no_runners' }, false, null)?.text, translate('ru', 'admin.competitions.fleet.reason.no_runners'))

    // And the pump agrees: it passes the notebook over and runs the one behind it.
    await pumpOnce()
    await settleCompetitionWork()
    assert.equal(queueRow(huge.id)?.state, 'waiting')
    assert.equal(getSubmission(small.id)?.state, 'scored')
  } finally {
    useHomeRunRoom(null)
    reset({ homeNotebooks: true })
  }
})

test('a notebook left to a machine gets the machine\'s place and reasons, never a start from this server\'s free slot', async () => {
  reset({ homeNotebooks: true })
  setQueueSlots(4)
  try {
    // The test stand has 16 cores; a machine of 32 gives a run 31.
    const c = competition({ cpus: 24 })
    const first = send(c, { at: Date.now() - 2000 })
    const second = send(c, { at: Date.now() - 1000 })
    const machine = new Machine(await serve())
    assert.equal((await machine.join(code(), { ...FACTS, cpus: 32 })).status, 200)

    // On line, still pulling the image: it will run them, this server will not — «готовится», no place.
    const free = { slots: 1, memoryMb: 32_768, cpus: 31, gpuShares: 0, diskMb: 100_000 }
    assert.equal((await machine.sync({ free })).status, 200)
    assert.deepEqual(leftToMachines(), [first.id, second.id])
    let forecast = queueForecast(4, Date.now())
    assert.deepEqual(forecast.reasons.get(first.id), { reason: 'preparing_image', tooBig: true })
    assert.equal(forecast.at.has(first.id), false, 'four free slots here, and not one of them takes it')

    // The image in place: the machine leases the first and runs it in its only place.
    const ready = readyFor(c)
    const lease = (await machine.sync({ ready, free })).body.leases[0]
    assert.equal(lease?.submissionId, first.id)
    await machine.sync({ seq: lease.seq, ready, free: { ...free, slots: 0, cpus: 7 }, attempts: [{ id: lease.attemptId, phase: 'running' }] })
    assert.equal(queueRow(first.id)?.state, 'running')
    assert.deepEqual(leftToMachines(), [second.id], 'the machine still fits it, once its place is free')

    // The second waits for that place: this server's four free slots promise it nothing.
    forecast = queueForecast(4, Date.now())
    assert.equal(forecast.reasons.has(second.id), false, 'a machine will run it: its turn is all it waits for')
    const spot = forecast.at.get(second.id)
    assert.equal(spot?.place, 1)
    assert.ok((spot?.startMs ?? 0) > 0, `it starts when the machine's run ends, not now (${spot?.startMs})`)
    await pumpOnce()
    await settleCompetitionWork()
    assert.equal(queueRow(second.id)?.state, 'waiting', 'nor does the pump take it')

    // The machine gone, and a GPU notebook too big for this server: no card here and no machine — the card's reason, not its size.
    reset({ homeNotebooks: true })
    useHomeRunRoom({ cpus: 16, memoryMb: 15_360 })
    const gpu = send(competition({ gpu: true, memoryMb: 49_152 }))
    const huge = send(competition({ memoryMb: 49_152 }))
    assert.deepEqual(leftToMachines().sort(), [gpu.id, huge.id].sort())
    forecast = queueForecast(4, Date.now())
    assert.deepEqual(forecast.reasons.get(gpu.id), { reason: 'no_gpu_runner' })
    assert.deepEqual(forecast.reasons.get(huge.id), { reason: 'no_runners', tooBig: true }, 'not no_gpu_runner: it asks no card')
  } finally {
    useHomeRunRoom(null)
    reset({ homeNotebooks: true })
  }
})

test('the console says what is too big for this server in both languages, and the English has no Russian in it', () => {
  const tooBig = { tooBig: true }
  const cases = [
    [{ reason: 'no_runners' as const, ...tooBig }, 'admin.competitions.fleet.reason.no_runnersTooBig'],
    [{ reason: 'home_only_env' as const, ...tooBig }, 'admin.competitions.fleet.reason.home_only_envTooBig'],
    [{ reason: 'no_fit' as const, ...tooBig }, 'admin.competitions.fleet.reason.no_fitTooBig'],
  ] as const
  for (const lang of ['ru', 'en'] as const) {
    setLocaleResolver(() => lang)
    for (const [row, key] of cases) {
      const said = waitingLine(row, false, { notebooks: true })?.text ?? ''
      assert.equal(said, translate(lang, key), `${row.reason} (${lang})`)
      assert.notEqual(said, key)
      if (lang === 'en') assert.doesNotMatch(said, CYRILLIC, key)
    }
    // Without the size, the causes they always had: the card with this server's notebooks on, the switch with them off.
    assert.equal(waitingLine({ reason: 'home_only_env' }, false, { notebooks: true })?.text, translate(lang, 'admin.competitions.fleet.reason.home_only_envNoCard'))
    assert.equal(waitingLine({ reason: 'home_only_env' }, false, { notebooks: false })?.text, translate(lang, 'admin.competitions.fleet.reason.home_only_env'))
    assert.equal(waitingLine({ reason: 'no_fit' }, false, null)?.text, translate(lang, 'admin.competitions.fleet.reason.no_fit'))
  }
  setLocaleResolver(() => 'ru')
})
