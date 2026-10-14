/**
 * Where a metric runs (decision 2 of docs/architecture/remote-runners.md §12):
 * a competition with a card scores in the light kaggle-base this server has
 * ready, not in its own ten-to-thirteen-gigabyte GPU image; one on the CPU
 * scores in its own pinned image, exactly as before. The run row records the
 * revision every score came from.
 *
 * Each fails quietly. A GPU competition that keeps scoring in its own image
 * makes this server keep every GPU image of every competition only to run
 * pandas over two files. A light image whose revision was recorded but whose
 * image is gone fails every metric with docker's "no such image" instead of
 * falling back. A CPU competition that starts scoring in kaggle-base changes
 * what its teacher's metric imports in the middle of the competition. A
 * score whose image nobody recorded cannot be explained once kaggle-base is
 * rebuilt. And a metric with nowhere to run must say so to the teacher in
 * their language, not as a docker error.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import { getInstanceLanguage } from '../server/src/admin/settings.js'
import type { Competition, Submission } from '../shared/competitions.js'
import type { EnvironmentRevision } from '../shared/dependencies.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  getSubmission,
  leaveQueue,
  listRuns,
  putFile,
  queueRows,
  setQueuePaused,
} from '../server/src/competitions/store.js'
import { bindSubmission, putRevision } from '../server/src/dependencies/store.js'
import { competitionsFs, putOpenFile, putSecretFile, putSubmissionNotebook, resultDir, SUBMISSION_FILE } from '../server/src/competitions/storage.js'
import { SOLUTION_NAME } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type CompetitionRunner, type RunRequest, type ScoreRequest } from '../server/src/competitions/runner-port.js'
import {
  LIGHT_METRIC_ENVIRONMENT,
  drainCompetitionQueue,
  lightMetricRevision,
  rescoreCompetition,
  setQueueSlots,
} from '../server/src/competitions/runner.js'
import { createCapabilityReader, useCompetitionCapabilities } from '../server/src/competitions/capabilities.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { useGpuCardProbe } from '../server/src/kernel/resources.js'

/* ------------------------------------------------------------------ setup */

/** The stand-in runner, keeping every request it was handed. */
class Runner extends FakeCompetitionRunner {
  readonly runs: RunRequest[] = []
  readonly scores: ScoreRequest[] = []

  override async run(request: RunRequest) {
    this.runs.push(request)
    return super.run(request)
  }

  override async score(request: ScoreRequest) {
    this.scores.push(request)
    return super.score(request)
  }
}

const runner = new Runner()
useCompetitionRunner(runner)

function reset(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
  runner.runs.length = 0
  runner.scores.length = 0
  useCompetitionRunner(runner)
  useCompetitionCapabilities(null)
}

let seq = 0
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`

/** A revision as captureRevision records one; `at` decides which of an environment's is the newest. */
function revision(environmentName: string, seed: string, at: number): EnvironmentRevision {
  return putRevision({
    environmentName, imageDigest: digest(seed), pythonVersion: '3.11.16', pythonAbi: 'cp311', platform: 'linux/amd64',
    packages: [{ name: 'pandas', version: '2.2.3' }], baseConstraintsHash: `hash-${seed}`, createdAt: at,
  })
}

function competition(gpu: boolean): Competition {
  seq += 1
  const made = createCompetition({
    slug: `light${seq}`,
    title: `Light ${seq}`,
    blurb: '',
    description: '',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    publicPercent: 30,
    limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 0, ...(gpu ? { gpu: true } : {}) },
    environment: gpu ? 'kaggle-gpu' : 'base',
  })
  assert.ok(made)
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 20, visibility: 'open' })
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  return made
}

/** A submission whose answer is stored already, pinned to `pin` (or to nothing): what a rescore scores. */
function answered(c: Competition, pin: EnvironmentRevision | null): Submission {
  const entrant = createEntrant(`Метрика ${seq}-${randomUUID().slice(0, 6)}`).entrant
  const submission = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100 })
  putSubmissionNotebook(c.id, submission.id, enc('{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}'))
  leaveQueue(submission.id)
  competitionsFs.writeFileSync(path.join(resultDir(c.id, submission.id), SUBMISSION_FILE), enc('id,target\n1,0\n2,0\n'), { mode: 0o600 })
  if (pin) bindSubmission(submission.id, pin.id, null)
  return submission
}

async function rescore(c: Competition): Promise<void> {
  assert.ok(rescoreCompetition(c.id) > 0)
  await drainCompetitionQueue()
}

const metricRun = (submissionId: string) => listRuns(submissionId).filter((run) => run.kind === 'metric').at(-1)

/* ------------------------------------------------------------------ tests */

test('the metric of a competition with a card runs in the newest kaggle-base ready here, and its run row says so', async () => {
  reset()
  const older = revision(LIGHT_METRIC_ENVIRONMENT, 'a', 1_000)
  const newer = revision(LIGHT_METRIC_ENVIRONMENT, 'b', 2_000)
  const gpuImage = revision('kaggle-gpu', 'c', 3_000)
  assert.equal((await lightMetricRevision())?.id, newer.id)
  const g = competition(true)
  const sent = answered(g, gpuImage)
  await rescore(g)
  assert.equal(getSubmission(sent.id)?.state, 'scored')
  const request = runner.scores.find((one) => one.submissionId === sent.id)!
  assert.equal(request.imageDigest, newer.imageDigest, 'kaggle-base, not the GPU image')
  assert.equal(request.competition.environment, LIGHT_METRIC_ENVIRONMENT, 'under the environment that names it')
  assert.equal(request.competition.id, g.id)
  assert.ok(!('gpu' in request), 'and never a card')
  assert.equal(metricRun(sent.id)?.revisionId, newer.id)
  assert.notEqual(older.id, newer.id)
  reset()
})

test('a kaggle-base whose image is gone is passed over at the first metric; with none here the metric is pinned to the submission\'s own image', async () => {
  reset()
  const g = competition(true)
  const gpuImage = revision('kaggle-gpu', 'd', 4_000)
  const kept = revision(LIGHT_METRIC_ENVIRONMENT, 'e', 5_000)
  const gone = revision(LIGHT_METRIC_ENVIRONMENT, 'f', 6_000)
  /** A docker that has exactly these images (a fresh reader each time: it caches what it was told). */
  const dockerWith = (images: string[]) => createCapabilityReader({
    backend: () => 'docker',
    storageAvailable: () => true,
    run: async (args) => {
      if (args[0] === 'version') return '28.1.1'
      if (!images.includes(args.at(-1)!)) throw new Error('No such image')
      return args.at(-1)!
    },
  })
  // The newest kaggle-base's image is gone; the one before it is here.
  useCompetitionCapabilities(dockerWith([kept.imageDigest, gpuImage.imageDigest]))
  assert.notEqual(gone.id, kept.id)
  assert.equal((await lightMetricRevision())?.id, kept.id)
  const first = answered(g, gpuImage)
  await rescore(g)
  assert.equal(runner.scores.find((one) => one.submissionId === first.id)?.imageDigest, kept.imageDigest)
  assert.equal(metricRun(first.id)?.revisionId, kept.id)

  // The pinned kaggle-base gone too: the metric fails in the teacher's words, and is not sent to another image.
  useCompetitionCapabilities(dockerWith([gpuImage.imageDigest]))
  assert.equal(await lightMetricRevision(), null)
  runner.scores.length = 0
  const second = answered(g, gpuImage)
  await rescore(g)
  assert.equal(runner.scores.length, 0, 'no metric container anywhere')
  assert.equal(getSubmission(second.id)?.state, 'metricFailed')
  assert.equal(getSubmission(second.id)?.teacherError, tr('competitions.answer.scoringImageGone', { environment: LIGHT_METRIC_ENVIRONMENT, light: LIGHT_METRIC_ENVIRONMENT }))

  // A competition whose first metric finds no kaggle-base here: its own image, as before the decision.
  const h = competition(true)
  const third = answered(h, gpuImage)
  await rescore(h)
  const request = runner.scores.find((one) => one.submissionId === third.id)!
  assert.equal(request.imageDigest, gpuImage.imageDigest)
  assert.equal(request.competition.environment, 'kaggle-gpu')
  assert.equal(metricRun(third.id)?.revisionId, gpuImage.id)
  reset()
})

test('a competition on the CPU scores in its own pinned image, whatever kaggle-base this server has', async () => {
  reset()
  revision(LIGHT_METRIC_ENVIRONMENT, 'g', 9_000)
  const base = revision('base', 'h', 7_000)
  const c = competition(false)
  const sent = answered(c, base)
  await rescore(c)
  const request = runner.scores.find((one) => one.submissionId === sent.id)!
  assert.equal(request.imageDigest, base.imageDigest)
  assert.deepEqual(request.competition, { id: c.id, environment: 'base', publicPercent: c.publicPercent, splitSeed: c.splitSeed })
  assert.equal(metricRun(sent.id)?.revisionId, base.id, 'its run row names the pin it scored in')
  reset()
})

test('a GPU notebook runs on its card in its own image, and its metric right after in kaggle-base', async () => {
  reset()
  process.env.KERNEL_GPUS = '0'
  process.env.COMPETITION_GPUS = '0'
  useGpuCardProbe(async (devices) => new Map(devices.map((device) => [device, { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }])))
  try {
    const light = revision(LIGHT_METRIC_ENVIRONMENT, 'i', 10_000)
    const gpuImage = revision('kaggle-gpu', 'j', 11_000)
    const g = competition(true)
    const entrant = createEntrant(`Карта ${seq}`).entrant
    const sent = acceptSubmission({ competitionId: g.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100 })
    putSubmissionNotebook(g.id, sent.id, enc('{"cells":[{"cell_type":"code","source":"model.fit()","metadata":{},"outputs":[]}],"metadata":{},"nbformat":4,"nbformat_minor":5}'))
    bindSubmission(sent.id, gpuImage.id, null)
    await drainCompetitionQueue()
    assert.equal(getSubmission(sent.id)?.state, 'scored')
    const run = runner.runs.find((one) => one.submissionId === sent.id)!
    assert.equal(run.imageDigest, gpuImage.imageDigest, 'the notebook keeps its own image')
    assert.equal(run.gpu?.device, '0')
    const score = runner.scores.find((one) => one.submissionId === sent.id)!
    assert.equal(score.imageDigest, light.imageDigest)
    assert.equal(score.attemptId, run.attemptId, 'under the same lease')
    assert.ok(!('gpu' in score))
    const runs = listRuns(sent.id)
    assert.deepEqual(runs.map((one) => [one.kind, one.revisionId ?? null]), [['notebook', null], ['metric', light.id]])
  } finally {
    delete process.env.KERNEL_GPUS
    delete process.env.COMPETITION_GPUS
    useGpuCardProbe(null)
    saveCompetitionSettings({ gpuDevices: null, gpuPerDevice: null })
    reset()
  }
})

test('with nowhere to run the metric, the teacher is told so in their language; a CPU competition keeps its old words', async () => {
  reset()
  // A runner that is not the stand-in: an image is required to score (scoreStep).
  const docker: CompetitionRunner = {
    backend: 'docker',
    run: (request) => runner.run(request),
    score: (request) => runner.score(request),
    kill: (container) => runner.kill(container),
    sweep: () => runner.sweep(),
    capacity: () => runner.capacity(),
  }
  useCompetitionRunner(docker)
  // No kaggle-base is ready here: every one recorded has lost its image.
  useCompetitionCapabilities(createCapabilityReader({
    backend: () => 'docker',
    storageAvailable: () => true,
    run: async (args) => {
      if (args[0] === 'version') return '28.1.1'
      throw new Error('No such image')
    },
  }))
  try {
    const g = competition(true)
    const sent = answered(g, null)
    await rescore(g)
    const done = getSubmission(sent.id)!
    assert.equal(done.state, 'metricFailed')
    assert.equal(done.teacherError, tr('competitions.answer.noScoringImage', { environment: LIGHT_METRIC_ENVIRONMENT }))
    assert.match(done.teacherError ?? '', /kaggle-base/)
    assert.match(done.teacherError ?? '', /Окружения/)
    setLocaleResolver(() => 'en')
    try {
      assert.equal(tr('competitions.answer.noScoringImage', { environment: LIGHT_METRIC_ENVIRONMENT }),
        'There is nowhere to run the metric: no kaggle-base image is ready on this server, and the submission has no pinned environment. Build kaggle-base under Environments and rescore the submission.')
    } finally {
      setLocaleResolver(getInstanceLanguage)
    }
    assert.equal(runner.scores.some((one) => one.submissionId === sent.id), false, 'no metric container for it')
    // The CPU competition's refusal is the one it always was.
    const c = competition(false)
    const plain = answered(c, null)
    await rescore(c)
    assert.equal(getSubmission(plain.id)?.teacherError, 'This legacy submission has no pinned environment. Submit the notebook again before scoring.')
  } finally {
    reset()
  }
})
