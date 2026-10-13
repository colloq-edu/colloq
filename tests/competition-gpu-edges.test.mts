/**
 * The edges of a card for submissions, where one part of the server hands a
 * run or a card to another: the owner takes a card back between the queue's
 * take and `docker run`; a run is stopped because its card could not be read,
 * and its neighbours and a blind participant are told; the owner's form asks
 * about a card the server has not heard from yet.
 *
 * Each fails quietly. A run started on a card the owner had just given back
 * to classes keeps that card from the class for its whole time limit. A run
 * that ran out of video memory while a neighbour nobody could read held the
 * card is judged a failure of its own and told to shrink a model that fit. A
 * blind participant whose run we stopped reads "the notebook failed, the
 * output is hidden", with nothing to act on. And a form that waits eight
 * seconds for a card the server asks about at its start anyway is a blank tab
 * for nothing.
 *
 * No docker and no card: the stand-in runner holds runs as long as a test
 * needs them (and stops one "for an unreadable card" when told to), the cards
 * are named by KERNEL_GPUS and COMPETITION_GPUS, and the card probe is
 * injected.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import { getInstanceLanguage } from '../server/src/admin/settings.js'
import type { Competition, Submission } from '../shared/competitions.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  getSubmission,
  leaveQueue,
  listRuns,
  nextQueueRow,
  putFile,
  queueRow,
  queueRows,
  runningRows,
  setQueuePaused,
} from '../server/src/competitions/store.js'
import { putOpenFile, putSecretFile, putSubmissionNotebook } from '../server/src/competitions/storage.js'
import { SOLUTION_NAME, VRAM_UNREAD_LIMIT, unreadCardNotes } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type RunOutcome, type RunRequest } from '../server/src/competitions/runner-port.js'
import {
  NEIGHBOUR_WINDOW_MS,
  UNREAD_NEIGHBOUR_WINDOW_MS,
  briefNote,
  cancelSubmission,
  errorTypeOf,
  neighbourStop,
  neighbourVerdict,
  pumpOnce,
  setQueueSlots,
  settleSubmission,
} from '../server/src/competitions/runner.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { gpuSettingsView } from '../server/src/competitions/gpu.js'
import { useGpuCardProbe } from '../server/src/kernel/resources.js'
import { blindAdvice } from '../web/src/lib/competition-words.js'

/* ------------------------------------------------------------------ setup */

/**
 * The stand-in runner, which can also end a run the way the docker runner
 * ends one whose card stopped answering (docker-runner.ts · watch,
 * `gpu-unread`): a failed cell with our sentence where the traceback goes.
 */
class Runner extends FakeCompetitionRunner {
  /** Submissions whose run ends stopped for an unreadable card. */
  readonly unread = new Set<string>()

  override async run(request: RunRequest): Promise<RunOutcome> {
    const outcome = await super.run(request)
    if (!this.unread.has(request.submissionId)) return outcome
    const words = unreadCardNotes({ device: request.gpu?.device ?? '', sliceMb: request.gpu?.sliceMb ?? 0, failures: VRAM_UNREAD_LIMIT, lastFailure: null, answered: true })
    return {
      ...outcome,
      status: 'cell_error',
      submission: null,
      detail: words.participant ?? '',
      log: words.teacher,
      diagnostics: { ...outcome.diagnostics, exit: 137, killedBy: 'gpu-unread', gpuPeakMb: 450, gpuSamplesMb: [450] },
    }
  }
}

const runner = new Runner()
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

/** One queue per instance: every check starts from an empty one, and from no saved card. */
function reset(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(8)
  runner.heldGpus = {}
  runner.unread.clear()
  runner.notebookRuns.length = 0
  saveCompetitionSettings({ gpuDevices: null, gpuPerDevice: null })
}

let seq = 0
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A competition with its card on, on a GPU environment. */
function gpuCompetition(): Competition {
  seq += 1
  const made = createCompetition({
    slug: `edge${seq}`,
    title: `Edge ${seq}`,
    blurb: '',
    description: '',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    publicPercent: 30,
    limits: { wallSeconds: 600, memoryMb: 2048, cpus: 2, perDay: 0, gpu: true },
    environment: 'base-gpu',
  })
  assert.ok(made, 'the competition must be created')
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 24, visibility: 'open' })
  return made
}

/** One notebook from a person of its own, sent at `at`. */
function send(competition: Competition, name: string, at: number, source: string): Submission {
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
/** torch's own out-of-memory in a participant's cell, as the harness reports it. */
const TORCH_OOM = '# colloq-test: {"status": "cell_error", "hold": 100, "detail": "Traceback (most recent call last):\\n  Cell In[3], line 1\\nOutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB."}\nmodel.fit()'
/** A neighbour that runs a little longer; the stand-in then stops it for an unreadable card (Runner.unread). */
const NEIGHBOUR = '# colloq-test: {"hold": 600}\nmodel.fit()'

const RTX = { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }

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

/** Words in one language, then back to the instance's whatever happens. */
function inLocale<T>(locale: 'ru' | 'en', body: () => T): T {
  setLocaleResolver(() => locale)
  try {
    return body()
  } finally {
    setLocaleResolver(getInstanceLanguage)
  }
}

/* ------------------------------------------- a card taken back before the start */

test('a card the owner gives back to classes between the take and the start gets no run: the run goes back to the queue, in our words', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0' }, async () => {
    reset()
    // The card says its size only when the test lets it: the run waits for it between the take and the start.
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    useGpuCardProbe(async (devices) => {
      await gate
      return new Map(devices.map((device) => [device, RTX]))
    })
    const g = gpuCompetition()
    const sent = send(g, 'Возврат', 1, HOLD)
    try {
      assert.equal(await pumpOnce(), 1)
      assert.equal(queueRow(sent.id)?.gpu, '0', 'taken onto the one card given')
      // The owner gives the card back to classes while the run waits for its size.
      saveCompetitionSettings({ gpuDevices: [] })
      release()
      await until(() => queueRow(sent.id)?.state === 'waiting')
      assert.ok(!runner.notebookRuns.some((run) => run.submissionId === sent.id), 'no run was started on the card the classes have now')
      const row = queueRow(sent.id)!
      assert.equal(row.gpu, null, 'the card went with the attempt')
      assert.equal(row.resourceRetries, 1, 'a resource deferral, which counts toward nothing')
      assert.deepEqual(runningRows().filter((running) => running.gpu === '0'), [], 'nothing of the queue holds the card')
      assert.deepEqual(listRuns(sent.id), [], 'the run that never began left no record')
      const waiting = getSubmission(sent.id)!
      assert.equal(waiting.state, 'queued')
      assert.equal(waiting.participantError, tr('competitions.runtime.resourcesWaiting'))
      assert.equal(waiting.briefError, tr('competitions.runtime.resourcesWaiting'))
      assert.equal(waiting.teacherError, tr('competitions.answer.gpuWithdrawnTeacher', { device: '0' }))
      assert.doesNotMatch(waiting.teacherError ?? '', /Pod/, 'not the cluster\'s words on a machine with its own cards')
      // A card given to submissions again takes it, once its short backoff is over.
      saveCompetitionSettings({ gpuDevices: ['0'] })
      assert.equal(nextQueueRow(Date.now() + 60_000, { cards: [{ id: '0', capacity: 1 }] })?.submissionId, sent.id)
    } finally {
      release()
      if (queueRow(sent.id)?.state === 'running') await stop(sent)
      leaveQueue(sent.id)
      useGpuCardProbe(null)
      reset()
    }
  })
})

test('a run cancelled while it waited for its card stays cancelled when the card is taken back too', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0' }, async () => {
    reset()
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    useGpuCardProbe(async (devices) => {
      await gate
      return new Map(devices.map((device) => [device, RTX]))
    })
    const g = gpuCompetition()
    const sent = send(g, 'Снята', 1, HOLD)
    try {
      assert.equal(await pumpOnce(), 1)
      // The teacher takes the run down, and the owner the card, both while the run waits for the card's size.
      assert.equal(await cancelSubmission(sent.id, 'teacher'), true)
      saveCompetitionSettings({ gpuDevices: [] })
      release()
      await until(() => queueRow(sent.id) === null)
      assert.equal(getSubmission(sent.id)?.state, 'cancelled', 'not put back in the queue')
      assert.ok(!runner.notebookRuns.some((run) => run.submissionId === sent.id))
    } finally {
      release()
      leaveQueue(sent.id)
      useGpuCardProbe(null)
      reset()
    }
  })
})

test('a card still given when the run starts is run on, as before', async () => {
  await withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: '0,1' }, async () => {
    reset()
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    useGpuCardProbe(async (devices) => {
      await gate
      return new Map(devices.map((device) => [device, RTX]))
    })
    const g = gpuCompetition()
    const sent = send(g, 'Остаётся', 1, HOLD)
    try {
      assert.equal(await pumpOnce(), 1)
      assert.equal(queueRow(sent.id)?.gpu, '0')
      // The owner takes the OTHER card back meanwhile: this run's card is still the submissions'.
      saveCompetitionSettings({ gpuDevices: ['0'] })
      release()
      await until(() => runner.notebookRuns.some((run) => run.submissionId === sent.id))
      assert.deepEqual(runner.notebookRuns.find((run) => run.submissionId === sent.id)?.gpu, { device: '0', sliceMb: RTX.memoryMb, perDevice: 1 })
      assert.equal(queueRow(sent.id)?.state, 'running')
    } finally {
      release()
      if (queueRow(sent.id)?.state === 'running') await stop(sent)
      useGpuCardProbe(null)
      reset()
    }
  })
})

/* ------------------------------------------------- a card nobody could read */

test('a run that runs out of video memory while its neighbour is stopped for a card nobody could read goes back to the queue once', async () => {
  await withEnv({ KERNEL_GPUS: '0', COMPETITION_GPUS: '0', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    reset()
    const g = gpuCompetition()
    const victim = send(g, 'Сосед1', 1, TORCH_OOM)
    const unreadable = send(g, 'Сосед2', 2, NEIGHBOUR)
    runner.unread.add(unreadable.id)
    try {
      assert.equal(await pumpOnce(), 2)
      assert.deepEqual([queueRow(victim.id)?.gpu, queueRow(unreadable.id)?.gpu], ['0', '0'])
      // The victim fails first; the stop of its unreadable neighbour lands half a second later, and is waited for.
      await until(() => queueRow(unreadable.id) === null && queueRow(victim.id)?.state === 'waiting')
      assert.equal(getSubmission(unreadable.id)?.state, 'notebookFailed', 'the unreadable run is judged as the docker runner judges it')
      const requeued = getSubmission(victim.id)!
      assert.equal(requeued.state, 'queued')
      assert.equal(requeued.participantError, tr('competitions.answer.gpuNeighbourRetry'))
      assert.equal(requeued.briefError, tr('competitions.answer.gpuNeighbourRetry'))
      assert.equal(requeued.teacherError, tr('competitions.answer.gpuNeighbourRetryTeacher', { device: '0' }))
      assert.equal(queueRow(victim.id)?.resourceRetries, 1)
    } finally {
      for (const submission of [victim, unreadable]) if (queueRow(submission.id)?.state === 'running') await stop(submission)
      reset()
    }
  })
})

test('an unreadable neighbour may have crowded a run out longer after its end than a burst the watchdog saw, and the run waits that long for it', () => {
  const run = { startedAt: 1_000, endedAt: 100_000 }
  const overShare = (at: number) => neighbourStop(at, 'gpu')
  const unreadable = (at: number) => neighbourStop(at, 'gpu-unread')
  assert.ok(UNREAD_NEIGHBOUR_WINDOW_MS > NEIGHBOUR_WINDOW_MS)
  assert.deepEqual([overShare(1).windowMs, unreadable(1).windowMs], [NEIGHBOUR_WINDOW_MS, UNREAD_NEIGHBOUR_WINDOW_MS])
  // Within the base window either way: crowded out, whatever stopped the neighbour.
  assert.equal(neighbourVerdict([overShare(110_000)], run, 110_000, true), 'crowded')
  assert.equal(neighbourVerdict([unreadable(110_000)], run, 110_000, true), 'crowded')
  // Stopped 25 s after the run ended: a burst seen over the share was stopped
  // within seconds of starting, so it was no cause of this run's end; a run
  // nobody could read held what it held for up to the whole unread stretch.
  assert.equal(neighbourVerdict([overShare(125_000)], run, 125_000, false), 'own')
  assert.equal(neighbourVerdict([unreadable(125_000)], run, 125_000, false), 'crowded')
  // Neither counts before the run was taken, or long before it ended: the memory was free again by then.
  assert.equal(neighbourVerdict([unreadable(500)], run, 100_000, false), 'own')
  assert.equal(neighbourVerdict([unreadable(70_000)], run, 100_000, false), 'own')
  // While another run stays on the card, an unread stop may still come past the base window: the run waits for it...
  assert.equal(neighbourVerdict([], run, 100_000 + NEIGHBOUR_WINDOW_MS + 5_000, true), 'wait')
  // ...and no longer than an unread stop could take, nor once nobody else is on the card.
  assert.equal(neighbourVerdict([], run, 100_000 + UNREAD_NEIGHBOUR_WINDOW_MS, true), 'own')
  assert.equal(neighbourVerdict([], run, 100_000, false), 'own')
})

/** A run on the hidden test stopped because its card could not be read: cell 5 of 9, our sentence in place of a traceback. */
function unreadOutcome(detail: string): RunOutcome {
  return {
    status: 'cell_error', cell: 4, cells: 9, wall: 31_000, submission: null, detail, log: '',
    diagnostics: { exit: 137, oomKilled: false, backend: 'docker', killedBy: 'gpu-unread', gpuPeakMb: 450, gpuSamplesMb: [450] },
  }
}

const COMPETITION = { limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5, gpu: true } } as Competition
const SHARED: NonNullable<RunRequest['gpu']> = { device: '0', sliceMb: 6144, perDevice: 4 }

test('a blind participant whose run was stopped for an unreadable card reads our sentence about it, not only "the output is hidden"', () => {
  const heads = {
    ru: 'Тетрадь упала на ячейке 5 из 9. Текст ошибки и вывод скрыты — проверка шла на скрытом тесте.',
    en: 'The notebook failed at cell 5 of 9. The error text and outputs are hidden: the check ran on the hidden test.',
  }
  for (const locale of ['ru', 'en'] as const) {
    inLocale(locale, () => {
      // The count the docker runner says: the limit, or one more for a sample still in flight at the stop.
      for (const failures of [VRAM_UNREAD_LIMIT, VRAM_UNREAD_LIMIT + 1]) {
        const sentence = unreadCardNotes({ device: '0', sliceMb: 6144, failures, lastFailure: null, answered: true }).participant!
        const outcome = unreadOutcome(sentence)
        assert.equal(errorTypeOf(outcome.detail), null, 'our sentence names no exception')
        const brief = briefNote(outcome, COMPETITION, errorTypeOf(outcome.detail), SHARED)
        assert.equal(brief, `${heads[locale]}\n\n${sentence}`)
        // The blind row shows exactly that sentence under its head.
        assert.equal(blindAdvice({ state: 'notebookFailed', participantError: brief }), sentence)
      }
    })
  }
})

test('under the brief policy nothing but our own sentence passes, whatever the stop is called', () => {
  inLocale('en', () => {
    const head = 'The notebook failed at cell 5 of 9. The error text and outputs are hidden: the check ran on the hidden test.'
    const ours = unreadCardNotes({ device: '0', sliceMb: 6144, failures: VRAM_UNREAD_LIMIT, lastFailure: null, answered: true }).participant!
    // A detail that is not word for word ours — a traceback, ours with anything after it — stays hidden.
    const traceback = 'Traceback (most recent call last):\n  Cell In[5], line 1\nValueError: 4,0.31\n5,0.77'
    assert.equal(briefNote(unreadOutcome(traceback), COMPETITION, null, SHARED), head)
    assert.equal(briefNote(unreadOutcome(`${ours}\n4,0.31`), COMPETITION, null, SHARED), head)
    assert.equal(briefNote(unreadOutcome(''), COMPETITION, null, SHARED), head)
    // The same sentence on a run stopped for anything else is not ours to pass on either.
    const other: RunOutcome = { ...unreadOutcome(ours), diagnostics: { exit: 1, oomKilled: false, backend: 'docker' } }
    assert.equal(briefNote(other, COMPETITION, null, SHARED), head)
  })
})

/* ------------------------------------------------- the owner's form */

test('the owner\'s form waits for a card never asked about no longer than a page does, and has the size on the next answer', async () => {
  await withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: '0' }, async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    useGpuCardProbe(async (devices) => {
      await gate
      return new Map(devices.map((device) => [device, RTX]))
    })
    // The wait's own deadline does not hold the process open (resources.ts ·
    // within); in the server its sockets do, and this stands in for them.
    const alive = setInterval(() => {}, 1_000)
    try {
      const started = Date.now()
      const first = await gpuSettingsView()
      const waited = Date.now() - started
      // It was eight seconds: a blank Resources tab on the first open after a restart.
      assert.ok(waited < 4_000, `the form waited ${waited} ms for the probe`)
      assert.deepEqual(first.cards.map((card) => card.memoryMb), [null, null], 'unknown on this answer')
      assert.equal(first.sliceMb, null, 'and no share promised on a size nobody said')
      release()
      const next = await gpuSettingsView()
      assert.deepEqual(next.cards.map((card) => card.memoryMb), [RTX.memoryMb, RTX.memoryMb])
      assert.equal(next.sliceMb, RTX.memoryMb)
    } finally {
      clearInterval(alive)
      release()
      useGpuCardProbe(null)
    }
  })
})
