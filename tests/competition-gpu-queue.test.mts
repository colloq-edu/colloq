/**
 * The queue with runner cards: which work takes a share of which card, what
 * waits for one and what never does, the pump that ties it together, and the
 * places and estimates both screens draw from it.
 *
 * Every rule here fails quietly. A GPU notebook at the head of the queue that
 * waits for a card while the CPU work behind it waits too is a class whose
 * every submission stops because one competition has a card. CPU work that
 * keeps a GPU notebook from a free card is the same in reverse. Two runs on
 * one card while the second card idles is half the speed for nothing. A card
 * a lecture still holds, or a container that would not be removed, given to a
 * new run is two programs sharing memory nobody divided. A card kept in a row
 * that left 'running' is a share lost until the next restart. And a place
 * computed as if a GPU notebook started in its turn is "you are first" for a
 * notebook that starts tenth.
 *
 * No docker and no card: the stand-in runner holds runs as long as a test
 * needs them, the cards are named by KERNEL_GPUS and COMPETITION_GPUS, and
 * the test backend's card is the made-up 24 GB one (kernel/resources.ts).
 */
import './_env.mts'
import http from 'node:http'
import { db } from '../server/src/db.js'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE, type RunningKernels } from '../shared/admin.js'
import type { Competition, Submission } from '../shared/competitions.js'
import type { CompetitionLive, QueueSnapshot } from '../shared/competitions-api.js'
import { tr } from '../shared/i18n.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  deferResourceAttempt,
  deleteCompetition,
  enqueue,
  finishQueueAttempt,
  getCompetition,
  getSubmission,
  leaveQueue,
  nextQueueRow,
  putFile,
  queueRow,
  queueRows,
  reclaimQueue,
  requeue,
  runningRows,
  setQueuePaused,
  takeNext,
  type QueueGpu,
} from '../server/src/competitions/store.js'
import { putOpenFile, putSecretFile, putSubmissionNotebook } from '../server/src/competitions/storage.js'
import { SOLUTION_NAME } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type RunOutcome, type RunRequest } from '../server/src/competitions/runner-port.js'
import { CompetitionResourcePending } from '../server/src/competitions/broker-runner.js'
import {
  cancelSubmission,
  competitionExecutionDiagnostics,
  pumpOnce,
  setQueueSlots,
  settleSubmission,
  teacherNote,
} from '../server/src/competitions/runner.js'
import { evaluateCapabilities, useCompetitionCapabilities } from '../server/src/competitions/capabilities.js'
import { queueEtas } from '../server/src/competitions/panel.js'
import { forecastGpuSlots, queueForecast, refreshRunnerGpuPicture, runnerGpuPicture } from '../server/src/competitions/forecast.js'
import { cardsInUse, noteClusterGpuSlots, pickRunnerGpu, placesTaken, runnerGpuCards } from '../server/src/competitions/gpu.js'
import { useGpuCardProbe } from '../server/src/kernel/resources.js'
import { app } from '../server/src/app.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { waitsForCard } from '../web/src/admin/competitions.js'

/* ------------------------------------------------------------------ setup */

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

/** No card setting from the developer's shell may leak into a test. */
const CLEAN = { KERNEL_GPUS: undefined, COMPETITION_GPUS: undefined, COMPETITION_GPU_PER_DEVICE: undefined, COMPETITION_BACKEND: undefined }

/** Environment variables are read at call time, so they can be swapped for one body. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
  const all = { ...CLEAN, ...vars }
  const saved = new Map(Object.keys(all).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(all)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return await body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** One queue per instance: every check starts from an empty one. */
function reset(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(8)
  runner.heldGpus = {}
}

let seq = 0
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A competition with its card on (on a GPU environment) or a plain one. */
function makeCompetition(gpu: boolean): Competition {
  seq += 1
  const made = createCompetition({
    slug: `g${seq}`,
    title: `GPU ${seq}`,
    blurb: '',
    description: '',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    publicPercent: 30,
    limits: { wallSeconds: 600, memoryMb: 2048, cpus: 2, perDay: 0, gpu },
    environment: gpu ? 'base-gpu' : 'base',
  })
  assert.ok(made, 'the competition must be created')
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 24, visibility: 'open' })
  return made
}

/** One notebook from a person of its own (fairness must not reorder what is checked), sent at `at`. */
function send(competition: Competition, name: string, at: number, source = 'print(1)'): Submission {
  const entrant = createEntrant(name).entrant
  const submission = acceptSubmission({ competitionId: competition.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100, at })
  putSubmissionNotebook(competition.id, submission.id, enc(JSON.stringify({
    cells: [{ cell_type: 'code', source, metadata: {}, outputs: [] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })))
  return submission
}

/** A run the stand-in holds until it is cancelled. */
const HOLD = '# colloq-test: {"hold": 60000}\nmodel.fit()'

async function until(reached: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!reached()) {
    if (Date.now() > deadline) throw new Error('the condition was never reached')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

/** Take a held run down and wait until the queue has let it go. */
async function stop(submission: Submission): Promise<void> {
  await cancelSubmission(submission.id, 'teacher')
  assert.ok(await settleSubmission(submission.id, 10_000), `${submission.id} never ended`)
}

const cardsOf = (submissions: Submission[]) => submissions.map((submission) => queueRow(submission.id)?.gpu ?? null)

/* The console's doors are the real app, on a port of its own. */
let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
})

function staffCookie(name: string, email: string): string {
  const teacher = createTeacher({ name, email, role: 'owner' })
  assert.ok(teacher, email)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

async function read<T>(path: string, cookie: string): Promise<T> {
  const response = await fetch(`${base}${path}`, { headers: { cookie } })
  assert.equal(response.status, 200, path)
  return (await response.json()) as T
}

/* ------------------------------------------------------------- the queue */

test('a GPU notebook waits for a share while the CPU work behind it flows, and takes the first share that frees', () => {
  reset()
  const g = makeCompetition(true), c = makeCompetition(false)
  const g1 = send(g, 'Г1', 1), g2 = send(g, 'Г2', 2), c1 = send(c, 'Ц1', 3)
  const one: QueueGpu = { cards: [{ id: '0', capacity: 1 }] }
  const first = takeNext({ at: 10, slots: 8, gpu: one })!
  assert.equal(first.submissionId, g1.id)
  assert.equal(first.gpu, '0')
  // The card is full: the second GPU notebook is passed over, not waited behind.
  const second = takeNext({ at: 11, slots: 8, gpu: one })!
  assert.equal(second.submissionId, c1.id)
  assert.equal(second.gpu, null, 'CPU work never takes a card, whatever is free')
  assert.equal(takeNext({ at: 12, slots: 8, gpu: one }), null)
  assert.equal(queueRow(g2.id)?.state, 'waiting')
  assert.ok(finishQueueAttempt(first))
  const third = takeNext({ at: 13, slots: 8, gpu: one })!
  assert.equal(third.submissionId, g2.id)
  assert.equal(third.gpu, '0')
})

test('CPU work never makes a GPU notebook wait for more than a general slot', () => {
  reset()
  const g = makeCompetition(true), c = makeCompetition(false)
  const c1 = send(c, 'Ц1', 1), g1 = send(g, 'Г1', 2), c2 = send(c, 'Ц2', 3)
  const free: QueueGpu = { cards: [{ id: '0', capacity: 1 }] }
  assert.equal(takeNext({ at: 10, slots: 2, gpu: free })?.submissionId, c1.id)
  // A share is free: the GPU notebook goes in its own place, ahead of the CPU work sent after it.
  assert.equal(takeNext({ at: 11, slots: 2, gpu: free })?.submissionId, g1.id)
  // And then both kinds wait for the same thing: a general slot.
  assert.equal(takeNext({ at: 12, slots: 2, gpu: free }), null)
  assert.equal(queueRow(c2.id)?.state, 'waiting')
})

test('the least loaded card first, ties in KERNEL_GPUS order, and a full set waits', () => {
  reset()
  const g = makeCompetition(true)
  const sent = [1, 2, 3, 4, 5].map((n) => send(g, `Г${n}`, n))
  const two: QueueGpu = { cards: [{ id: '0', capacity: 2 }, { id: '1', capacity: 2 }] }
  for (let n = 0; n < 5; n++) takeNext({ at: 10 + n, slots: 8, gpu: two })
  assert.deepEqual(cardsOf(sent), ['0', '1', '0', '1', null])
  assert.equal(queueRow(sent[4].id)?.state, 'waiting')
})

test('a card a class still holds takes no run, and neither does any card while the census is unread', () => {
  reset()
  const g = makeCompetition(true)
  const sent = [1, 2, 3].map((n) => send(g, `Г${n}`, n))
  const held: QueueGpu = { cards: runnerGpuCards({ devices: ['0', '1'], perDevice: 2, heldByRooms: new Set(['0']) }) }
  for (let n = 0; n < 3; n++) takeNext({ at: 10 + n, slots: 8, gpu: held })
  assert.deepEqual(cardsOf(sent), ['1', '1', null])

  reset()
  const blind: QueueGpu = { cards: runnerGpuCards({ devices: ['0', '1'], perDevice: 2, heldByRooms: null }) }
  const waiting = send(g, 'Г4', 20)
  assert.equal(takeNext({ at: 21, slots: 8, gpu: blind }), null)
  assert.equal(queueRow(waiting.id)?.state, 'waiting')
})

test('a container still awaiting removal holds its share like a running row', () => {
  reset()
  const g = makeCompetition(true)
  const sent = [1, 2].map((n) => send(g, `Г${n}`, n))
  const stuck: QueueGpu = { cards: [{ id: '0', capacity: 1 }, { id: '1', capacity: 1 }], held: { '0': 1 } }
  takeNext({ at: 10, slots: 8, gpu: stuck })
  takeNext({ at: 11, slots: 8, gpu: stuck })
  assert.deepEqual(cardsOf(sent), ['1', null])
})

test('a rescore, a competition with its card off, and the cluster never wait for a card here', () => {
  reset()
  const g = makeCompetition(true), plain = makeCompetition(false)
  const none: QueueGpu = { cards: [] }
  // A rescore runs only the metric, and the metric never gets a card.
  const scored = send(g, 'Г1', 1)
  leaveQueue(scored.id)
  enqueue({ submissionId: scored.id, competitionId: g.id, entrantId: scored.entrantId, kind: 'metric', at: 2 })
  const rescore = takeNext({ at: 10, slots: 8, gpu: none })!
  assert.equal(rescore.submissionId, scored.id)
  assert.equal(rescore.gpu, null)
  const cpu = send(plain, 'Ц1', 3)
  assert.equal(takeNext({ at: 11, slots: 8, gpu: none })?.submissionId, cpu.id)

  // Without cards to count — the cluster places the Pod itself — GPU work goes in its turn and holds no card here.
  reset()
  const clustered = send(g, 'Г2', 4)
  const taken = takeNext({ at: 12, slots: 8 })!
  assert.equal(taken.submissionId, clustered.id)
  assert.equal(taken.gpu, null)
})

test('nextQueueRow names exactly the work takeNext takes, card or no card', () => {
  reset()
  const g = makeCompetition(true), c = makeCompetition(false)
  const g1 = send(g, 'Г1', 1)
  const c1 = send(c, 'Ц1', 2)
  const g2 = send(g, 'Г2', 3)
  const c2 = send(c, 'Ц2', 4)
  const one: QueueGpu = { cards: [{ id: '0', capacity: 1 }] }
  const order: string[] = []
  // A share, then the card full twice over, then the cluster's way: no card to count.
  for (const gpu of [one, one, one, undefined]) {
    const named = nextQueueRow(20, gpu)
    const taken = takeNext({ at: 20, slots: 8, gpu })
    assert.ok(taken)
    assert.equal(taken.submissionId, named?.submissionId)
    order.push(taken.submissionId)
  }
  assert.deepEqual(order, [g1.id, c1.id, c2.id, g2.id])
})

test('every way out of running lets the card go', () => {
  reset()
  const g = makeCompetition(true)
  const card: QueueGpu = { cards: [{ id: '0', capacity: 4 }] }
  const [a, b, c] = [1, 2, 3].map((n) => send(g, `Г${n}`, n))
  const rowA = takeNext({ at: 10, slots: 8, gpu: card })!
  const rowB = takeNext({ at: 11, slots: 8, gpu: card })!
  const rowC = takeNext({ at: 12, slots: 8, gpu: card })!
  assert.deepEqual([rowA.gpu, rowB.gpu, rowC.gpu], ['0', '0', '0'])

  // A rescore asked while it ran: back to waiting for the metric, without the card.
  enqueue({ submissionId: a.id, competitionId: g.id, entrantId: a.entrantId, kind: 'metric' })
  assert.ok(finishQueueAttempt(rowA))
  assert.deepEqual([queueRow(a.id)?.state, queueRow(a.id)?.kind, queueRow(a.id)?.gpu], ['waiting', 'metric', null])
  // A Pod the scheduler refused.
  assert.notEqual(deferResourceAttempt(rowB, 'later'), null)
  assert.deepEqual([queueRow(b.id)?.state, queueRow(b.id)?.gpu], ['waiting', null])
  // Put back by hand, fenced on the attempt it ran under; its container had started.
  assert.ok(requeue(c.id, rowC.attemptId!, true))
  assert.deepEqual([queueRow(c.id)?.state, queueRow(c.id)?.gpu], ['waiting', null])

  // A run of the previous life of the process, picked up again after a restart.
  reset()
  const again = send(g, 'Г5', 21)
  const old = takeNext({ at: 22, slots: 8, gpu: card, boot: 'the-previous-life' })!
  assert.equal(old.submissionId, again.id)
  assert.equal(old.gpu, '0')
  const { requeued } = reclaimQueue('this-life')
  assert.ok(requeued.some((row) => row.submissionId === again.id))
  assert.deepEqual([queueRow(again.id)?.state, queueRow(again.id)?.gpu], ['waiting', null])
})

/* --------------------------------------------------------------- the pump */

test('the pump: two cards × two runs each, five GPU notebooks and two CPU ones', async () => {
  await withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: '0,1', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    reset()
    runner.notebookRuns.length = 0
    const g = makeCompetition(true), c = makeCompetition(false)
    const gpu = [1, 2, 3, 4, 5].map((n) => send(g, `Г${n}`, n, HOLD))
    const cpu = [6, 7].map((n) => send(c, `Ц${n}`, n))
    try {
      assert.equal(await pumpOnce(), 6, 'four GPU notebooks on four shares, and the CPU work past the fifth')
      await until(() => runner.notebookRuns.length >= 6)
      assert.deepEqual(cardsOf(gpu), ['0', '1', '0', '1', null])
      assert.equal(queueRow(gpu[4].id)?.state, 'waiting')
      const given = new Map(runner.notebookRuns.map((run) => [run.submissionId, run.gpu]))
      // The made-up 24 GB card of the test stand, shared by two: 12 GB each.
      assert.deepEqual(given.get(gpu[0].id), { device: '0', sliceMb: 12_288, perDevice: 2 })
      assert.deepEqual(given.get(gpu[1].id), { device: '1', sliceMb: 12_288, perDevice: 2 })
      for (const submission of cpu) assert.equal(given.get(submission.id), null, 'a CPU notebook gets no card')
      await until(() => cpu.every((submission) => getSubmission(submission.id)?.state === 'scored'))

      // A share frees on the second card: the fifth takes exactly that one.
      await stop(gpu[1])
      assert.equal(await pumpOnce(), 1)
      await until(() => runner.notebookRuns.some((run) => run.submissionId === gpu[4].id))
      assert.equal(queueRow(gpu[4].id)?.gpu, '1')
      assert.deepEqual(runner.notebookRuns.find((run) => run.submissionId === gpu[4].id)?.gpu, { device: '1', sliceMb: 12_288, perDevice: 2 })
    } finally {
      for (const submission of gpu) if (queueRow(submission.id)?.state === 'running') await stop(submission)
    }
  })
})

test('the pump counts a card a stuck container still holds', async () => {
  await withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: '0,1' }, async () => {
    reset()
    runner.notebookRuns.length = 0
    runner.heldGpus = { '0': 1 }
    const g = makeCompetition(true)
    const sent = [1, 2].map((n) => send(g, `Г${n}`, n, HOLD))
    try {
      assert.equal(await pumpOnce(), 1)
      assert.deepEqual(cardsOf(sent), ['1', null])
    } finally {
      runner.heldGpus = {}
      for (const submission of sent) if (queueRow(submission.id)?.state === 'running') await stop(submission)
    }
  })
})

test('without a card given to submissions, GPU notebooks wait and CPU work goes on', async () => {
  await withEnv({ KERNEL_GPUS: '0' }, async () => {
    reset()
    const g = makeCompetition(true), c = makeCompetition(false)
    const waiting = send(g, 'Г1', 1, HOLD)
    const cpu = send(c, 'Ц1', 2)
    assert.equal(await pumpOnce(), 1)
    await until(() => getSubmission(cpu.id)?.state === 'scored')
    assert.equal(queueRow(waiting.id)?.state, 'waiting')
    leaveQueue(waiting.id)
  })
})

test('under the cluster a GPU notebook holds no card here and asks the cluster for one, and no more ask at once than the broker has units for', async () => {
  // Cards here would allow two runs at once; the cluster decides for itself.
  await withEnv({ COMPETITION_BACKEND: 'broker', KERNEL_GPUS: '0,1', COMPETITION_GPUS: '0,1' }, async () => {
    const available = { available: true, code: 'available', reason: null }
    // A broker that does not say how many units it has: one GPU notebook asks at a time.
    useCompetitionCapabilities(async () => ({ execution: available, preparation: available }))
    reset()
    runner.notebookRuns.length = 0
    const g = makeCompetition(true), c = makeCompetition(false)
    const gpu = [1, 2, 3].map((n) => send(g, `Б${n}`, n, HOLD))
    const cpu = send(c, 'Ц1', 4, HOLD)
    try {
      // Eight slots: the first GPU notebook, and the CPU one past the other two
      // (taken in their turn, they held a slot each while their Pods waited).
      assert.equal(await pumpOnce(), 2)
      await until(() => runner.notebookRuns.length >= 2)
      assert.deepEqual([...gpu, cpu].map((submission) => queueRow(submission.id)?.state), ['running', 'waiting', 'waiting', 'running'])
      assert.deepEqual(cardsOf([...gpu, cpu]), [null, null, null, null])
      const given = new Map(runner.notebookRuns.map((run) => [run.submissionId, run.gpu]))
      assert.deepEqual(given.get(gpu[0].id), { device: '', sliceMb: null, perDevice: 1 })
      assert.equal(given.get(cpu.id), null, 'a CPU notebook sends no card: an older broker refuses the key')
      // Nothing to count here: the console shows no cards of this machine, and the forecast the cluster's one place.
      assert.equal(runnerGpuPicture(), null)
      assert.equal(forecastGpuSlots(), 1)
      // Free slots are not free places: the second GPU notebook is expected when the first ends.
      assert.ok(queueForecast(8).at.get(gpu[1].id)!.startMs > 0)
      const owner = staffCookie('Хозяйка кластера', 'owner.gpu.cluster@example.edu')
      const snapshot = await read<QueueSnapshot>('/api/admin/competitions/queue', owner)
      assert.equal(snapshot.gpu, null)
      const shown = new Map(snapshot.running.map((run) => [run.submissionId, run.gpu]))
      assert.deepEqual(shown.get(gpu[0].id), { device: '', sliceMb: null })
      assert.equal(shown.get(cpu.id), null)

      // A broker that says it has three units: the other two ask too.
      useCompetitionCapabilities(async () => ({ execution: available, preparation: available, gpuSlots: 3 }))
      assert.equal(await pumpOnce(), 2)
      assert.deepEqual(gpu.map((submission) => queueRow(submission.id)?.state), ['running', 'running', 'running'])
      assert.equal(forecastGpuSlots(), 3)
    } finally {
      for (const submission of [...gpu, cpu]) if (queueRow(submission.id)?.state === 'running') await stop(submission)
      useCompetitionCapabilities(null)
      noteClusterGpuSlots(undefined)
    }
  })
})

/** The cluster with no free unit: every GPU notebook comes back unscheduled, the way the broker runner throws it. */
class ClusterWithoutUnits extends FakeCompetitionRunner {
  override async run(request: RunRequest): Promise<RunOutcome> {
    if (request.gpu) throw new CompetitionResourcePending('gpu')
    return super.run(request)
  }
}

test('under the cluster, a GPU notebook sent back for want of a unit keeps the other GPU notebooks out until its backoff ends, and the CPU work takes the slot', async () => {
  await withEnv({ COMPETITION_BACKEND: 'broker' }, async () => {
    const available = { available: true, code: 'available', reason: null }
    useCompetitionCapabilities(async () => ({ execution: available, preparation: available, gpuSlots: 2 }))
    const cluster = new ClusterWithoutUnits()
    useCompetitionRunner(cluster)
    reset()
    setQueueSlots(1)
    const g = makeCompetition(true), c = makeCompetition(false)
    const [g1, g2] = [1, 2].map((n) => send(g, `Р${n}`, n, HOLD))
    const cpu = send(c, 'Ц1', 3, HOLD)
    try {
      // One slot: the first GPU notebook asks, and the cluster sends it back.
      assert.equal(await pumpOnce(), 1)
      await until(() => queueRow(g1.id)?.state === 'waiting')
      assert.ok(queueRow(g1.id)!.notBefore > Date.now(), 'it waits out its own backoff')
      assert.equal(getSubmission(g1.id)?.participantError, tr('competitions.runtime.resourcesWaiting'))
      // The cluster has just said it has no unit: the next GPU notebook, first
      // in the order, does not ask; the CPU work behind it takes the slot.
      assert.equal(await pumpOnce(), 1)
      assert.equal(queueRow(cpu.id)?.state, 'running')
      assert.equal(queueRow(g2.id)?.state, 'waiting')
    } finally {
      for (const submission of [g1, g2, cpu]) {
        if (queueRow(submission.id)?.state === 'running') {
          await cancelSubmission(submission.id, 'teacher')
          await settleSubmission(submission.id, 10_000)
        }
      }
      useCompetitionRunner(runner)
      useCompetitionCapabilities(null)
      noteClusterGpuSlots(undefined)
      reset()
    }
  })
})

test('the broker\'s number of units reaches the pump, and anything but a positive whole number reads as one', () => {
  const available = { available: true, code: 'available', reason: null }
  const broker = { execution: available, preparation: available, gpu: available, gpuSlots: 3 }
  assert.equal(evaluateCapabilities({ backend: 'broker', brokerCapabilities: broker, imageAvailable: true, storageAvailable: true }).gpuSlots, 3)
  // Not a verdict: a GPU competition is judged by `gpu`, as before.
  assert.equal(evaluateCapabilities({ backend: 'broker', brokerCapabilities: broker, imageAvailable: true, storageAvailable: true, gpu: true }).execution.available, true)
  // Docker has no such number, and a broker from before it sends none.
  assert.equal('gpuSlots' in evaluateCapabilities({ backend: 'docker', dockerVersion: '28.1.1', imageAvailable: true, storageAvailable: true }), false)
  assert.equal('gpuSlots' in evaluateCapabilities({ backend: 'broker', brokerCapabilities: { execution: available, preparation: available }, imageAvailable: true, storageAvailable: true }), false)
  for (const [reported, slots] of [[3, 3], [undefined, 1], [null, 1], [0, 1], [-2, 1], [1.5, 1], ['4', 1], [1000, 256]] as const) {
    assert.equal(noteClusterGpuSlots(reported), slots, String(reported))
  }
  noteClusterGpuSlots(undefined)
})

/* ----------------------------------------------------------- the forecast */

test('the simulation takes card shares as the queue does', () => {
  // One share, two slots: the second GPU notebook waits for the first, the CPU one does not.
  assert.deepEqual(
    queueEtas({ slots: 2, running: [], waiting: [{ expectedMs: 100, gpu: true }, { expectedMs: 100, gpu: true }, { expectedMs: 100 }], gpuSlots: 1 }),
    [{ startMs: 0, etaMs: 100 }, { startMs: 100, etaMs: 200 }, { startMs: 0, etaMs: 100 }],
  )
  // A running GPU run holds the share until it ends.
  assert.deepEqual(
    queueEtas({ slots: 4, running: [{ expectedMs: 60_000, elapsedMs: 0, gpu: true }], waiting: [{ expectedMs: 1000, gpu: true }, { expectedMs: 1000 }], gpuSlots: 1 }),
    [{ startMs: 60_000, etaMs: 61_000 }, { startMs: 0, etaMs: 1000 }],
  )
  // No share at all: the GPU notebook starts nowhere, and says so.
  assert.deepEqual(
    queueEtas({ slots: 2, running: [], waiting: [{ expectedMs: 100, gpu: true }, { expectedMs: 100 }], gpuSlots: 0 }),
    [null, { startMs: 0, etaMs: 100 }],
  )
  // The cluster's cards: the flag changes nothing, the CPU answer exactly.
  const plain = queueEtas({ slots: 1, running: [{ expectedMs: 9000, elapsedMs: 1000 }], waiting: [{ expectedMs: 100 }, { expectedMs: 100 }] })
  assert.deepEqual(queueEtas({ slots: 1, running: [{ expectedMs: 9000, elapsedMs: 1000, gpu: true }], waiting: [{ expectedMs: 100, gpu: true }, { expectedMs: 100 }] }), plain)
  assert.deepEqual(plain, [{ startMs: 8000, etaMs: 8100 }, { startMs: 8100, etaMs: 8200 }])
})

test('places on both screens follow the simulated starts, and a GPU notebook without a card has none', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0' }, async () => {
    reset()
    const g = makeCompetition(true), c = makeCompetition(false)
    const now = Date.now()
    send(g, 'Г1', now - 3000)
    const g2 = send(g, 'Г2', now - 2000)
    const c1 = send(c, 'Ц1', now - 1000)
    // The one share is taken: the second GPU notebook, first in the order, starts after the CPU one.
    takeNext({ at: now, slots: 4, gpu: { cards: [{ id: '0', capacity: 1 }] } })
    await refreshRunnerGpuPicture()
    for (const forecast of [queueForecast(4, now, 1), queueForecast(4, now)]) {
      assert.deepEqual(forecast.eligible.map((row) => row.submissionId), [c1.id, g2.id])
      assert.equal(forecast.at.get(c1.id)?.place, 1)
      assert.equal(forecast.at.get(g2.id)?.place, 2)
      assert.ok(forecast.at.get(g2.id)!.startMs > forecast.at.get(c1.id)!.startMs)
    }
    // No card given to submissions: the GPU notebook keeps its row but gets neither a place nor an estimate.
    const cardless = queueForecast(4, now, 0)
    assert.equal(cardless.at.get(g2.id), undefined)
    assert.equal(cardless.at.get(c1.id)?.place, 1)
    assert.deepEqual(cardless.eligible.map((row) => row.submissionId), [c1.id, g2.id])
    // The cluster's cards: simulated like any other work, in the queue's own order.
    const clustered = queueForecast(4, now, null)
    assert.equal(clustered.at.get(g2.id)?.place, 1)
    assert.equal(clustered.at.get(c1.id)?.place, 2)
  })
  // And with no card configured the screens count no slots for GPU work at all.
  await withEnv({ KERNEL_GPUS: '0' }, () => {
    assert.equal(runnerGpuPicture(), null)
    assert.equal(forecastGpuSlots(), 0)
  })
})

/* ---------------------------------------------------- the console's numbers */

test('the console shows the GPU slots, the busy ones, the share, and the card of each run', async () => {
  await withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: '1', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    reset()
    const g = makeCompetition(true), c = makeCompetition(false)
    const gpu = send(g, 'Г1', 1, HOLD)
    const cpu = send(c, 'Ц1', 2, HOLD)
    try {
      assert.equal(await pumpOnce(), 2)
      assert.equal(queueRow(gpu.id)?.gpu, '1')
      // The run's share goes into its row once the card has said its size, before the run starts.
      await until(() => runner.notebookRuns.some((run) => run.submissionId === gpu.id))
      await refreshRunnerGpuPicture()
      const owner = staffCookie('Хозяйка карт', 'owner.gpu.console@example.edu')
      const snapshot = await read<QueueSnapshot>('/api/admin/competitions/queue', owner)
      assert.deepEqual(snapshot.gpu, { slots: 2, busy: 1, sliceMb: 12_288 })
      const shown = new Map(snapshot.running.map((run) => [run.submissionId, run.gpu]))
      assert.deepEqual(shown.get(gpu.id), { device: '1', sliceMb: 12_288 })
      assert.equal(shown.get(cpu.id), null)
      const running = await read<RunningKernels>('/api/admin/resources/running', owner)
      const runs = new Map(running.runs.map((run) => [run.submissionId, run.gpu]))
      assert.equal(runs.get(gpu.id), '1')
      assert.equal(runs.get(cpu.id), null)
    } finally {
      for (const submission of [gpu, cpu]) if (queueRow(submission.id)?.state === 'running') await stop(submission)
    }
    // No card given to submissions and no GPU work waiting: no GPU block at all.
    await withEnv({ KERNEL_GPUS: '0,1' }, async () => {
      const owner = staffCookie('Хозяйка без карт', 'owner.gpu.none@example.edu')
      assert.equal((await read<QueueSnapshot>('/api/admin/competitions/queue', owner)).gpu, null)
    })
  })
})

test('GPU notebooks waiting with no card given at all are shown waiting for a card, not as plain waiting', async () => {
  // The owner took the last card back (or the switch went on after they were sent): the queue passes them over at every take.
  await withEnv({ KERNEL_GPUS: '0,1' }, async () => {
    reset()
    const g = makeCompetition(true), c = makeCompetition(false)
    const now = Date.now()
    const waiting = send(g, 'Г1', now - 2000)
    send(c, 'Ц1', now - 1000)
    try {
      const owner = staffCookie('Хозяйка без карт и с очередью', 'owner.gpu.none.waiting@example.edu')
      const live = await read<CompetitionLive>(`/api/admin/competitions/${g.id}/live`, owner)
      // Zero places, none taken: the console's own rule then says «ждёт место на видеокарте».
      assert.deepEqual(live.queue.gpu, { slots: 0, busy: 0, sliceMb: null })
      const row = live.waiting.find((one) => one.submissionId === waiting.id)!
      assert.equal(row.place, null)
      assert.equal(waitsForCard(row, live.queue), true)
    } finally {
      reset()
    }
  })
})

/* ----------------------------------------------- shares pinned at the take */

test('a card keeps the shares its runs were taken at: a raise of runs per card waits for the card to drain, a cut too', () => {
  reset()
  const g = makeCompetition(true)
  const sent = [1, 2, 3, 4, 5, 6].map((n) => send(g, `Д${n}`, n))
  const at = (perDevice: number): QueueGpu => ({ cards: [{ id: '0', capacity: perDevice }] })
  // One run per card: the first run has the whole card, uncapped.
  const whole = takeNext({ at: 10, slots: 8, gpu: at(1) })!
  assert.deepEqual([whole.gpu, whole.gpuPerDevice], ['0', 1])
  // The owner raises it to two: the card is still whole the first run's, so nothing joins it.
  assert.equal(takeNext({ at: 11, slots: 8, gpu: at(2) }), null)
  assert.ok(finishQueueAttempt(whole))
  const halves = [takeNext({ at: 12, slots: 8, gpu: at(2) })!, takeNext({ at: 13, slots: 8, gpu: at(2) })!]
  assert.deepEqual(halves.map((row) => [row.gpu, row.gpuPerDevice]), [['0', 2], ['0', 2]])
  // Raised to four with two halves on the card: 12 + 12 GB of 24 leave no room for a quarter.
  assert.equal(takeNext({ at: 14, slots: 8, gpu: at(4) }), null)
  assert.ok(finishQueueAttempt(halves[0]))
  // One half went: two quarters fit beside the other half, and a third does not.
  const quarters = [takeNext({ at: 15, slots: 8, gpu: at(4) })!, takeNext({ at: 16, slots: 8, gpu: at(4) })!]
  assert.deepEqual(quarters.map((row) => row.gpuPerDevice), [4, 4])
  assert.equal(takeNext({ at: 17, slots: 8, gpu: at(4) }), null)
  // Cut back to two: a half does not fit beside a half and two quarters, nor beside a half and one.
  assert.ok(finishQueueAttempt(quarters[0]))
  assert.equal(takeNext({ at: 18, slots: 8, gpu: at(2) }), null)
  assert.ok(finishQueueAttempt(quarters[1]))
  const half = takeNext({ at: 19, slots: 8, gpu: at(2) })!
  assert.deepEqual([half.submissionId, half.gpuPerDevice], [sent[5].id, 2])
  // A row put back lets its pinned share go with its card.
  const back = runningRows().find((row) => row.gpuPerDevice === 2)!
  assert.ok(requeue(back.submissionId, back.attemptId!, true))
  assert.deepEqual([queueRow(back.submissionId)?.gpu, queueRow(back.submissionId)?.gpuPerDevice, queueRow(back.submissionId)?.gpuSliceMb], [null, null, null])
  reset()
})

test('the places a card has left are counted in the shares its runs hold', () => {
  const card = [{ id: '0', capacity: 4 }, { id: '1', capacity: 4 }]
  // Every run at the number in force: a head count, exactly as before.
  assert.deepEqual(cardsInUse(card, [{ device: '0', perDevice: 4 }, { device: '0', perDevice: 4 }]), new Map([['0', 2]]))
  // A whole-card run fills a card whatever the number now; a half takes two quarters' places.
  assert.deepEqual(cardsInUse(card, [{ device: '0', perDevice: 1 }, { device: '1', perDevice: 2 }]), new Map([['0', 4], ['1', 2]]))
  // A row from before the pin and a container awaiting removal: one share at the number in force.
  assert.deepEqual(cardsInUse(card, [{ device: '1', perDevice: null }], { '1': 1 }), new Map([['1', 2]]))
  assert.equal(pickRunnerGpu(card, cardsInUse(card, [{ device: '0', perDevice: 1 }, { device: '1', perDevice: 2 }])), '1')
  // The console's count: places taken on the cards that take runs, and a run on any other card is a run.
  assert.equal(placesTaken(card, [{ device: '0', perDevice: 1 }, { device: '1', perDevice: 4 }, { device: '7', perDevice: 2 }]), 4 + 1 + 1)
  assert.equal(placesTaken([], [{ device: '0', perDevice: 2 }]), 1)
})

test('the pump builds a run from the share its row was taken at, and the console shows each run its own share', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    reset()
    runner.notebookRuns.length = 0
    // The card says its size only when the test lets it: the run waits for it between the take and the start.
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    useGpuCardProbe(async (devices) => {
      await gate
      return new Map(devices.map((device) => [device, { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_576 }]))
    })
    const g = makeCompetition(true)
    const [first, second, third] = [1, 2, 3].map((n) => send(g, `П${n}`, n, HOLD))
    try {
      assert.equal(await pumpOnce(), 2)
      // The owner changes the number while the runs wait for the card's size: they were taken at two.
      process.env.COMPETITION_GPU_PER_DEVICE = '1'
      release()
      await until(() => runner.notebookRuns.length >= 2)
      const given = new Map(runner.notebookRuns.map((run) => [run.submissionId, run.gpu]))
      assert.deepEqual(given.get(first.id), { device: '0', sliceMb: 12_288, perDevice: 2 })
      assert.deepEqual(given.get(second.id), { device: '0', sliceMb: 12_288, perDevice: 2 })
      // One run per card now, and the card holds two halves: the third waits.
      assert.equal(await pumpOnce(), 0)
      assert.equal(queueRow(third.id)?.state, 'waiting')

      // Raised to four instead: still no room — and the console shows the halves, not quarters.
      process.env.COMPETITION_GPU_PER_DEVICE = '4'
      assert.equal(await pumpOnce(), 0)
      await refreshRunnerGpuPicture()
      const owner = staffCookie('Хозяйка срезов', 'owner.gpu.shares@example.edu')
      const snapshot = await read<QueueSnapshot>('/api/admin/competitions/queue', owner)
      assert.deepEqual(snapshot.gpu, { slots: 4, busy: 4, sliceMb: 6144 })
      const shown = new Map(snapshot.running.map((run) => [run.submissionId, run.gpu]))
      assert.deepEqual(shown.get(first.id), { device: '0', sliceMb: 12_288 })
      // A half ends: the third takes a quarter beside the other half.
      await stop(first)
      assert.equal(await pumpOnce(), 1)
      await until(() => runner.notebookRuns.some((run) => run.submissionId === third.id))
      assert.deepEqual(runner.notebookRuns.find((run) => run.submissionId === third.id)?.gpu, { device: '0', sliceMb: 6144, perDevice: 4 })
      assert.deepEqual([queueRow(second.id)?.gpuSliceMb, queueRow(third.id)?.gpuSliceMb], [12_288, 6144])
    } finally {
      release()
      for (const submission of [first, second, third]) if (queueRow(submission.id)?.state === 'running') await stop(submission)
      useGpuCardProbe(null)
    }
  })
})

/* ------------------------------------------------- a competition deleted */

test('deleting a competition stops its runs first, so their card is not handed to the next notebook while a container still fills it', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0' }, async () => {
    reset()
    runner.notebookRuns.length = 0
    const doomed = makeCompetition(true), other = makeCompetition(true)
    const running = send(doomed, 'У1', 1, HOLD)
    const queued = send(doomed, 'У2', 2, HOLD)
    const next = send(other, 'Н1', 3, HOLD)
    try {
      assert.equal(await pumpOnce(), 1)
      const attempt = queueRow(running.id)!.attemptId!
      assert.equal(queueRow(running.id)?.gpu, '0')
      // The store alone refuses while a run of it is going: its row is what holds the card.
      assert.equal(deleteCompetition(doomed.id), 'running')
      assert.ok(getCompetition(doomed.id))

      const owner = staffCookie('Хозяйка удаления', 'owner.gpu.delete@example.edu')
      const response = await fetch(`${base}/api/admin/competitions/${doomed.id}`, { method: 'DELETE', headers: { cookie: owner } })
      assert.equal(response.status, 204)
      assert.equal(getCompetition(doomed.id), null)
      assert.equal(queueRow(queued.id), null)
      // The run was taken down and waited for before its row went.
      assert.ok(!competitionExecutionDiagnostics().activeAttemptIds.includes(attempt), 'the deleted competition\'s run is still going')
      assert.equal(await pumpOnce(), 1)
      assert.equal(queueRow(next.id)?.gpu, '0')
    } finally {
      for (const submission of [running, queued, next]) if (queueRow(submission.id)?.state === 'running') await stop(submission)
    }
  })
})

/* ------------------------------------------------- a neighbour's burst */

/** torch's own out-of-memory in a participant's cell, as the harness reports it. */
const TORCH_OOM = '# colloq-test: {"status": "cell_error", "hold": 100, "detail": "Traceback (most recent call last):\\n  Cell In[3], line 1\\nOutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB."}\nmodel.fit()'
/** A neighbour the watchdog stops for going past its share, a moment after the victim's error. */
const OVER_SHARE = '# colloq-test: {"status": "oom", "killedBy": "gpu", "hold": 600}\nmodel.fit()'

test('a run that runs out of video memory while the watchdog stops its neighbour on the card goes back to the queue once, in our words', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    reset()
    const g = makeCompetition(true)
    const victim = send(g, 'Ж1', 1, TORCH_OOM)
    const culprit = send(g, 'Ж2', 2, OVER_SHARE)
    try {
      assert.equal(await pumpOnce(), 2)
      assert.deepEqual(cardsOf([victim, culprit]), ['0', '0'])
      // The victim fails first; the kill lands half a second later, and it is waited for.
      await until(() => queueRow(culprit.id) === null && queueRow(victim.id)?.state === 'waiting')
      assert.equal(getSubmission(culprit.id)?.state, 'outOfMemory')
      const requeued = getSubmission(victim.id)!
      assert.equal(requeued.state, 'queued')
      // Our own words, the same for a blind participant: nothing in them came from the notebook.
      assert.equal(requeued.participantError, tr('competitions.answer.gpuNeighbourRetry'))
      assert.equal(requeued.briefError, tr('competitions.answer.gpuNeighbourRetry'))
      assert.equal(requeued.teacherError, tr('competitions.answer.gpuNeighbourRetryTeacher', { device: '0' }))
      assert.equal(queueRow(victim.id)?.resourceRetries, 1)
      assert.equal(queueRow(victim.id)?.gpu, null, 'its card went with the attempt')

      // Once: the same error a second time is judged like any other, with the share it had.
      // The retry's backoff waited out at once.
      assert.equal(db.prepare('UPDATE competition_queue SET not_before = 0 WHERE submission_id = ? AND state = ?').run(victim.id, 'waiting').changes, 1)
      assert.equal(await pumpOnce(), 1)
      await until(() => queueRow(victim.id) === null)
      const judged = getSubmission(victim.id)!
      assert.equal(judged.state, 'notebookFailed')
      assert.ok(judged.participantError?.endsWith(tr('competitions.answer.gpuOomShare', { slice: '12' })), judged.participantError ?? '')
    } finally {
      for (const submission of [victim, culprit]) if (queueRow(submission.id)?.state === 'running') await stop(submission)
      reset()
    }
  })
})

test('an out-of-memory beside a neighbour that ends on its own is the run\'s own, and is judged as soon as the neighbour leaves', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    reset()
    const g = makeCompetition(true)
    const victim = send(g, 'О1', 1, TORCH_OOM)
    const neighbour = send(g, 'О2', 2, '# colloq-test: {"hold": 400}\nmodel.fit()')
    try {
      assert.equal(await pumpOnce(), 2)
      const started = Date.now()
      await until(() => queueRow(victim.id) === null)
      assert.equal(getSubmission(victim.id)?.state, 'notebookFailed')
      assert.ok(Date.now() - started < 5_000, 'it did not wait out the whole window')
      await until(() => queueRow(neighbour.id) === null)
      assert.equal(getSubmission(neighbour.id)?.state, 'scored')
    } finally {
      for (const submission of [victim, neighbour]) if (queueRow(submission.id)?.state === 'running') await stop(submission)
      reset()
    }
  })
})

/* ------------------------------------------------------------- the words */

test('the teacher reads that a watched run\'s peak was not measured, never "peak 0 MB"', () => {
  const failed: RunOutcome = {
    status: 'cell_error', cell: 4, cells: 9, wall: 61_000, submission: null, detail: '', log: 'Killed',
    diagnostics: { exit: 1, oomKilled: false, backend: 'docker', gpuPeakMb: 0, gpuSamplesMb: [0, 0] },
  }
  const share = { device: '0', sliceMb: 6141, perDevice: 4 }
  const unmeasured = tr('competitions.answer.gpuPeakUnmeasured', { device: '0', slice: 6141 })
  assert.equal(teacherNote(failed, share), `cell_error · exit 1\n${unmeasured}\nKilled`)
  assert.ok(!teacherNote(failed, share)!.includes(tr('competitions.answer.gpuPeak', { device: '0', peak: 0, slice: 6141 })))
  // No sample answered at all: not measured either.
  assert.equal(teacherNote({ ...failed, diagnostics: { ...failed.diagnostics, gpuPeakMb: null, gpuSamplesMb: [] } }, share), `cell_error · exit 1\n${unmeasured}\nKilled`)
  // A measured peak keeps its number; a run nobody watched says nothing of a card.
  assert.equal(teacherNote({ ...failed, diagnostics: { ...failed.diagnostics, gpuPeakMb: 5900 } }, share), `cell_error · exit 1\n${tr('competitions.answer.gpuPeak', { device: '0', peak: 5900, slice: 6141 })}\nKilled`)
  assert.equal(teacherNote({ ...failed, diagnostics: { exit: 1, oomKilled: false, backend: 'docker' } }, share), 'cell_error · exit 1\nKilled')
})

test('the console\'s waiting rows say which job needs a card, so a wait for a card reads apart from a wait for a slot', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0' }, async () => {
    reset()
    const g = makeCompetition(true), c = makeCompetition(false)
    const now = Date.now()
    send(g, 'Г1', now - 3000)
    const g2 = send(g, 'Г2', now - 2000)
    const c1 = send(c, 'Ц1', now - 1000)
    try {
      // The one share is taken; nothing else is started, so both others wait.
      assert.equal(takeNext({ at: now, slots: 4, gpu: { cards: [{ id: '0', capacity: 1 }] } })?.gpu, '0')
      await refreshRunnerGpuPicture()
      const owner = staffCookie('Хозяйка ожидающих', 'owner.gpu.waiting@example.edu')
      const onCard = await read<CompetitionLive>(`/api/admin/competitions/${g.id}/live`, owner)
      assert.deepEqual([onCard.queue.gpu?.slots, onCard.queue.gpu?.busy], [1, 1])
      const gpuRow = onCard.waiting.find((row) => row.submissionId === g2.id)!
      assert.equal(gpuRow.gpu, true)
      assert.equal(waitsForCard(gpuRow, onCard.queue), true, 'the console says «ждёт место на видеокарте»')
      const onCpu = await read<CompetitionLive>(`/api/admin/competitions/${c.id}/live`, owner)
      const cpuRow = onCpu.waiting.find((row) => row.submissionId === c1.id)!
      assert.equal(cpuRow.gpu, false)
      assert.equal(waitsForCard(cpuRow, onCpu.queue), false)
    } finally {
      reset()
    }
  })
})
