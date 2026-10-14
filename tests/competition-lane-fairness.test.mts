/**
 * The two lanes of this server's pump over the one memory they share
 * (runner.ts · takeLanes, panel.ts · laneHeadOrder and laneEtas): when it
 * fits only one lane's next work, the one that has waited longer goes first,
 * and the screens promise exactly what the pump will do.
 *
 * Each fails quietly. With the metric lane first, the memory every metric
 * freed went to the next metric, and a notebook sent before a bulk rescore
 * waited for the whole of it — three hundred answers, minutes — while both
 * screens told it «первое место, начнётся сейчас». With the notebooks first
 * it was the other way round: a rescore asked before a backlog of notebooks
 * waited for all of them. A notebook that can never fit next to the rooms,
 * made the head every metric waits behind, would have stopped the metric
 * lane for good. And the forecast, simulating each lane against its places
 * alone, promised a start now to whichever lane the memory held back.
 *
 * No Docker: the stand-in runner holds a run for as long as its directive
 * says, and reports the memory the test gives it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Competition, Submission } from '../shared/competitions.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  getSubmission,
  leaveQueue,
  putFile,
  queueRow,
  queueRows,
  runningCount,
  setQueuePaused,
} from '../server/src/competitions/store.js'
import { competitionsFs, putOpenFile, putSecretFile, putSubmissionNotebook, resultDir, SUBMISSION_FILE } from '../server/src/competitions/storage.js'
import { SOLUTION_NAME } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import {
  cancelSubmission,
  drainCompetitionQueue,
  pumpOnce,
  queueMemory,
  rescoreCompetition,
  runReservationMb,
  setQueueSlots,
  settleCompetitionWork,
  settleSubmission,
} from '../server/src/competitions/runner.js'
import { saveCompetitionSettings, scoreSlotsSetting } from '../server/src/competitions/settings.js'
import { forecastLanes, queueForecast } from '../server/src/competitions/forecast.js'
import { laneEtas, laneHeadOrder } from '../server/src/competitions/panel.js'

/* ------------------------------------------------------------------ setup */

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

/** Everything back as a fresh server has it: an empty queue, one slot, the machines' settings forgotten, memory plenty. */
async function reset(): Promise<void> {
  // A metric names its container a few turns after it is taken: killed before that, it would hold on for its whole minute.
  for (let i = 0; i < 100 && queueRows().some((row) => row.state === 'running' && row.holder === null && !row.container); i++) await sleep(5)
  for (const row of queueRows()) {
    if (row.state === 'running' && row.holder === null) {
      await cancelSubmission(row.submissionId, 'teacher')
      await settleSubmission(row.submissionId, 10_000)
    }
  }
  await settleCompetitionWork()
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
  saveCompetitionSettings({ homeNotebooks: null, scoreSlots: null, runnerBlobMBps: null, runnerUploads: null })
  runner.availableMb = 65_536
}

let seq = 0
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function competition(memoryMb = 4096): Competition {
  seq += 1
  const made = createCompetition({
    slug: `fair${seq}`,
    title: `Fair ${seq}`,
    blurb: '',
    description: '',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    publicPercent: 30,
    limits: { wallSeconds: 600, memoryMb, cpus: 2, perDay: 0 },
    environment: 'base',
  })
  assert.ok(made)
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 20, visibility: 'open' })
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  return made
}

function send(c: Competition, name: string, source = 'x = 1'): Submission {
  const entrantId = createEntrant(`${name} ${seq}-${randomUUID().slice(0, 6)}`).entrant.id
  const submission = acceptSubmission({ competitionId: c.id, entrantId, fileName: 'solution.ipynb', bytes: 100 })
  putSubmissionNotebook(c.id, submission.id, enc(JSON.stringify({
    cells: [{ cell_type: 'code', source, metadata: {}, outputs: [] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })))
  return submission
}

/** A submission scored once, whose stored answer the stand-in's metric then holds on for a minute (its directive travels in the answer). */
async function scoredWithSlowAnswer(c: Competition): Promise<Submission> {
  const sent = send(c, 'Пересчёт')
  await drainCompetitionQueue()
  assert.equal(getSubmission(sent.id)?.state, 'scored')
  competitionsFs.writeFileSync(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE), enc('# colloq-test: {"hold": 60000}\nid,target\n1,0\n2,0\n'), { mode: 0o600 })
  return sent
}

/** Stop a run this server holds, and wait until its memory is free. */
async function stop(id: string): Promise<void> {
  assert.equal(await cancelSubmission(id, 'teacher'), true)
  assert.equal(await settleSubmission(id, 10_000), true)
}

const HOLD = '# colloq-test: {"hold": 60000}\nmodel.fit()'
const state = (s: Submission) => queueRow(s.id)?.state

/* ------------------------------------------------------- the pump's rule */

test('a notebook sent before a bulk rescore takes the memory first, and the screens promise no rescore a start the pump will not make', async () => {
  await reset()
  const c = competition()
  const scoreSlots = scoreSlotsSetting().value
  assert.equal(scoreSlots, 2)
  const old = [] as Submission[]
  for (let i = 0; i < 6; i++) old.push(await scoredWithSlowAnswer(c))
  // A notebook here reserves 256 + 4096 MB, a metric 256 + 2048: either one notebook or two metrics, never both.
  assert.deepEqual([runReservationMb(c, 'notebook'), runReservationMb(c, 'metric')], [4352, 2304])
  runner.availableMb = 6000
  const first = send(c, 'Н1', HOLD)
  assert.equal(await pumpOnce(), 1)
  await sleep(5)
  const second = send(c, 'Н2', HOLD)
  await sleep(5)
  // The teacher fixes the metric: every stored answer back in the queue, after the notebook.
  assert.equal(rescoreCompetition(c.id), 6)
  assert.ok(old.every((s) => queueRow(s.id)!.enqueuedAt > queueRow(second.id)!.enqueuedAt))
  assert.equal(await pumpOnce(), 0, 'the slot is the first notebook\'s, and the metrics have no room beside it')
  // The screens: the notebook goes when the first one ends; no rescore starts before it, nor now.
  const before = queueForecast(1, Date.now(), null, forecastLanes())
  const waits = before.at.get(second.id)!
  assert.ok(waits.startMs > 0, 'it waits for the slot')
  assert.equal(waits.place, 1)
  for (const s of old) {
    const rescore = before.at.get(s.id)!
    assert.ok(rescore.place > waits.place && rescore.startMs >= waits.startMs, 'no rescore is promised the memory before the notebook')
  }
  // The first notebook ends: its memory goes to the notebook that waited longer, not to two rescores.
  await stop(first.id)
  assert.equal(await pumpOnce(), 1)
  assert.equal(state(second), 'running')
  assert.equal(runningCount('metric'), 0)
  const during = queueForecast(1, Date.now(), null, forecastLanes())
  assert.ok(old.every((s) => (during.at.get(s.id)?.startMs ?? 0) > 0), 'while it runs, no rescore is promised a start now')
  // It ends: the rescores take their two places.
  await stop(second.id)
  assert.equal(await pumpOnce(), scoreSlots)
  assert.equal(runningCount('metric'), scoreSlots)
  await reset()
})

test('a rescore asked before a backlog of notebooks takes the memory a notebook frees, and is numbered first', async () => {
  await reset()
  setQueueSlots(2)
  const c = competition()
  const rescore = await scoredWithSlowAnswer(c)
  // Two notebooks fit, with no metric beside both: memory is the limit, not the places.
  runner.availableMb = 9000
  const first = send(c, 'Н1', HOLD)
  const second = send(c, 'Н2', HOLD)
  assert.equal(await pumpOnce(), 2)
  assert.equal(rescoreCompetition(c.id), 1)
  await sleep(5)
  const backlog = [send(c, 'Н3', HOLD)]
  await sleep(5)
  backlog.push(send(c, 'Н4', HOLD))
  assert.equal(await pumpOnce(), 0, 'no room for either')
  const forecast = queueForecast(2, Date.now(), null, forecastLanes())
  assert.equal(forecast.at.get(rescore.id)?.place, 1, 'the rescore waited longer')
  assert.ok((forecast.at.get(rescore.id)?.startMs ?? 0) > 0, 'and it too waits for a notebook to end')
  assert.ok(backlog.every((s) => (forecast.at.get(s.id)?.place ?? 0) > 1))
  // A notebook ends: room for the metric or for the next notebook, not both — and notebooks keep coming.
  await stop(first.id)
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(rescore.id)?.state, 'running', 'the rescore took the freed memory')
  assert.deepEqual(backlog.map(state), ['waiting', 'waiting'])
  // The next end goes to the notebook that waited longest.
  await stop(second.id)
  assert.equal(await pumpOnce(), 1)
  assert.deepEqual(backlog.map(state), ['running', 'waiting'])
  await reset()
})

test('a notebook that can never fit beside the rooms holds up no metric, and is promised no place', async () => {
  await reset()
  const c = competition()
  const rescores = [await scoredWithSlowAnswer(c), await scoredWithSlowAnswer(c)]
  // 4352 MB never fits 4000, whatever ends; one metric of 2304 does, two do not.
  runner.availableMb = 4000
  const big = send(c, 'Большой', HOLD)
  await sleep(5)
  assert.equal(rescoreCompetition(c.id), 2)
  assert.ok(rescores.every((s) => queueRow(s.id)!.enqueuedAt > queueRow(big.id)!.enqueuedAt), 'the notebook waited longer')
  assert.equal(await pumpOnce(), 1)
  assert.equal(state(big), 'waiting')
  assert.equal(runningCount('metric'), 1, 'no run of the queue can make room for it: the metric goes')
  const forecast = queueForecast(1, Date.now(), null, forecastLanes())
  assert.equal(forecast.at.has(big.id), false, 'nothing here will start it')
  assert.ok(forecast.eligible.some((row) => row.submissionId === big.id), 'still listed, after every placed row')
  const waiting = rescores.find((s) => state(s) === 'waiting')!
  assert.equal(forecast.at.get(waiting.id)?.place, 1)
  assert.ok((forecast.at.get(waiting.id)?.startMs ?? 0) > 0, 'the second metric waits for the first')
  await reset()
})

test('with memory for both, both lanes take in one pass, and the screens number the one that waited longer first', async () => {
  await reset()
  const c = competition()
  const rescore = await scoredWithSlowAnswer(c)
  const notebook = send(c, 'Вместе', HOLD)
  await sleep(5)
  assert.equal(rescoreCompetition(c.id), 1)
  const forecast = queueForecast(1, Date.now(), null, forecastLanes())
  assert.deepEqual([forecast.at.get(notebook.id)?.startMs, forecast.at.get(rescore.id)?.startMs], [0, 0])
  assert.deepEqual([forecast.at.get(notebook.id)?.place, forecast.at.get(rescore.id)?.place], [1, 2])
  assert.equal(await pumpOnce(), 2)
  assert.deepEqual([state(notebook), queueRow(rescore.id)?.state], ['running', 'running'])
  await reset()
})

test('the pump\'s memory for the screens: what the queue may hold in all, and what each of its runs holds', async () => {
  await reset()
  const c = competition()
  runner.availableMb = 10_000
  const sent = send(c, 'Память', HOLD)
  assert.equal(await pumpOnce(), 1)
  const memory = queueMemory()
  assert.equal(memory.totalMb, 10_000)
  assert.deepEqual([...memory.jobs.values()], [4352])
  assert.equal(memory.jobs.get(queueRow(sent.id)!.attemptId!), 4352)
  await stop(sent.id)
  assert.equal(queueMemory().jobs.size, 0, 'released with the run')
  await reset()
})

/* ------------------------------------------------------ the simulation */

test('the simulation of both lanes: the head that waited longer first, the other behind it, each lane within its places', () => {
  const job = (id: string, enqueuedAt: number, memoryMb: number, expectedMs = 10_000, late = false) => ({ submissionId: id, enqueuedAt, memoryMb, expectedMs, late })
  // 6000 MB: a notebook (4352) or two metrics (2304), not both. The notebook waited longer.
  const fair = laneEtas({
    memoryMb: 6000,
    notebook: { slots: 1, elsewhere: 0, running: [], waiting: [job('n', 1, 4352)] },
    metric: { slots: 2, running: [], waiting: [job('m1', 2, 2304, 3000), job('m2', 3, 2304, 3000)] },
  })
  assert.deepEqual(fair.notebook, [{ startMs: 0, etaMs: 10_000 }])
  assert.deepEqual(fair.metric, [{ startMs: 10_000, etaMs: 13_000 }, { startMs: 10_000, etaMs: 13_000 }])
  assert.deepEqual(fair.starts, [{ lane: 'notebook', index: 0 }, { lane: 'metric', index: 0 }, { lane: 'metric', index: 1 }])
  // The metrics waited longer: they go, and the notebook waits for both to end.
  const other = laneEtas({
    memoryMb: 6000,
    notebook: { slots: 1, elsewhere: 0, running: [], waiting: [job('n', 9, 4352)] },
    metric: { slots: 2, running: [], waiting: [job('m1', 2, 2304, 3000), job('m2', 3, 2304, 5000)] },
  })
  assert.deepEqual(other.metric.map((eta) => eta?.startMs), [0, 0])
  assert.deepEqual(other.notebook, [{ startMs: 5000, etaMs: 15_000 }])
  // A head that waits for memory holds the younger lane back even where the younger would fit now.
  const held = laneEtas({
    memoryMb: 6000,
    notebook: { slots: 1, elsewhere: 0, running: [], waiting: [job('n', 1, 4352)] },
    metric: { slots: 2, running: [{ expectedMs: 3000, elapsedMs: 0, memoryMb: 2304 }], waiting: [job('m', 2, 2304)] },
  })
  assert.deepEqual(held.notebook, [{ startMs: 5000, etaMs: 15_000 }], 'it waits for the running metric (never sooner than five seconds)')
  assert.equal(held.metric[0]?.startMs, 15_000, 'and the metric that would fit now waits behind it')
  // Unknown memory: nothing waits for it, and each lane fills its places.
  const unknown = laneEtas({
    memoryMb: null,
    notebook: { slots: 1, elsewhere: 0, running: [], waiting: [job('n', 1, 4352)] },
    metric: { slots: 2, running: [], waiting: [job('m1', 2, 2304), job('m2', 3, 2304)] },
  })
  assert.deepEqual([unknown.notebook[0]?.startMs, ...unknown.metric.map((eta) => eta?.startMs)], [0, 0, 0])
  // A notebook that never fits starts nowhere here, and holds up nothing; a machine's place takes it, at no memory here.
  const never = laneEtas({
    memoryMb: 4000,
    notebook: { slots: 1, elsewhere: 0, running: [], waiting: [job('n', 1, 4352)] },
    metric: { slots: 2, running: [], waiting: [job('m', 2, 2304)] },
  })
  assert.deepEqual([never.notebook[0], never.metric[0]?.startMs], [null, 0])
  const away = laneEtas({
    memoryMb: 4000,
    notebook: { slots: 1, elsewhere: 1, running: [], waiting: [job('n', 1, 4352), job('n2', 2, 4352)] },
    metric: { slots: 2, running: [], waiting: [] },
  })
  assert.deepEqual(away.notebook.map((eta) => eta?.startMs ?? null), [0, 10_000], 'one at a time, on the machine\'s one place')
  // A GPU notebook this server has no card for is the machines' alone: it takes neither this server's place nor its memory.
  const theirs = laneEtas({
    memoryMb: 6000,
    notebook: { slots: 1, elsewhere: 0, running: [], waiting: [{ ...job('g', 1, 4352), gpu: true, home: false }, job('n', 4, 4352)], gpuSlots: 1 },
    metric: { slots: 2, running: [], waiting: [job('m1', 2, 2304, 3000), job('m2', 3, 2304, 3000)] },
  })
  assert.equal(theirs.notebook[0], null, 'no machine place: it does not start')
  assert.deepEqual(theirs.metric.map((eta) => eta?.startMs), [0, 0], 'and it holds no memory back from the metrics')
  assert.equal(theirs.notebook[1]?.startMs, 3000, 'the CPU notebook behind it takes this server\'s place when the metrics end')
  // On-time before late, whatever the arrival.
  assert.ok(laneHeadOrder({ submissionId: 'a', enqueuedAt: 1, late: true }, { submissionId: 'b', enqueuedAt: 2 }) > 0)
  assert.ok(laneHeadOrder({ submissionId: 'a', enqueuedAt: 1 }, { submissionId: 'b', enqueuedAt: 2 }) < 0)
})
