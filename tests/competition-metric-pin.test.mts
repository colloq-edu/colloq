/**
 * The metric of a competition with a card scores in ONE image for the
 * competition's whole life (decision 2 of docs/architecture/remote-runners.md
 * §12; §4.4): the kaggle-base it was pinned to when its metric first ran, or,
 * where its scores came from before the pins, each submission's own image —
 * and it moves only when the teacher moves it, with a rescore of everything.
 *
 * Each fails quietly. A metric that took the newest kaggle-base recorded
 * anywhere scored a live competition's later results and rescores in another
 * image the moment another competition refreshed its base, and a metric
 * checked in the competition's own image began failing for every new result
 * once kaggle-base came. A daemon that stalled read as an image gone, and one
 * submission scored in an older image. The rescore doors asked about the
 * competition's own GPU image and refused once the owner removed it, though
 * the metric would have run. And on a server with only GPU competitions
 * nothing recorded kaggle-base, so the advice to build it and rescore changed
 * nothing.
 */
import './_env.mts'
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { tr } from '../shared/i18n.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { Competition, Submission } from '../shared/competitions.js'
import type { CompetitionView } from '../shared/competitions-api.js'
import type { EnvironmentRevision } from '../shared/dependencies.js'
import { db } from '../server/src/db.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  finishRun,
  getCompetition,
  getSubmission,
  leaveQueue,
  listRuns,
  putFile,
  queueRow,
  queueRows,
  setQueuePaused,
  startRun,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { bindSubmission, metricPin, putRevision, revisions, selectRevision } from '../server/src/dependencies/store.js'
import { useDockerForRevisions } from '../server/src/dependencies/revisions.js'
import { competitionsFs, putOpenFile, putSecretFile, putSubmissionNotebook, resultDir, SUBMISSION_FILE } from '../server/src/competitions/storage.js'
import { SOLUTION_NAME } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type CompetitionRunner, type ScoreRequest } from '../server/src/competitions/runner-port.js'
import {
  LIGHT_METRIC_ENVIRONMENT,
  drainCompetitionQueue,
  metricScoringImage,
  moveMetricToLightImage,
  rescoreCompetition,
  setQueueSlots,
} from '../server/src/competitions/runner.js'
import { createCapabilityReader, useCompetitionCapabilities } from '../server/src/competitions/capabilities.js'
import { app } from '../server/src/app.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'

for (const key of ['KERNEL_GPUS', 'COMPETITION_GPUS', 'COMPETITION_GPU_PER_DEVICE']) delete process.env[key]

/* ------------------------------------------------------------------ setup */

/** The stand-in runner, keeping every metric asked of it. */
class Runner extends FakeCompetitionRunner {
  readonly scores: ScoreRequest[] = []

  override async score(request: ScoreRequest) {
    this.scores.push(request)
    return super.score(request)
  }
}

const runner = new Runner()
useCompetitionRunner(runner)

/** The stand-in under docker's name: an image is then required to score, and kaggle-base may be recorded (runner.ts · scoreStep). */
const asDocker: CompetitionRunner = {
  backend: 'docker',
  run: (request) => runner.run(request),
  score: (request) => runner.score(request),
  kill: (container) => runner.kill(container),
  sweep: () => runner.sweep(),
  capacity: () => runner.capacity(),
}

function reset(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
  runner.scores.length = 0
  useCompetitionRunner(runner)
  useCompetitionCapabilities(null)
  useDockerForRevisions(null)
}

let seq = 0
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`

/** A revision as captureRevision records one; `at` decides which of an environment's is the newest. */
function revision(environmentName: string, seed: string, at: number): EnvironmentRevision {
  return putRevision({
    environmentName, imageDigest: digest(seed), pythonVersion: '3.11.16', pythonAbi: 'cp311', platform: 'linux/amd64',
    packages: [{ name: 'pandas', version: '3.0.6' }], baseConstraintsHash: `hash-${seed}`, createdAt: at,
  })
}

function competition(gpu: boolean): Competition {
  seq += 1
  const made = createCompetition({
    slug: `pin${seq}`,
    title: `Pin ${seq}`,
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
  const entrant = createEntrant(`Пин ${seq}-${randomUUID().slice(0, 6)}`).entrant
  const submission = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100 })
  putSubmissionNotebook(c.id, submission.id, enc('{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}'))
  leaveQueue(submission.id)
  competitionsFs.writeFileSync(path.join(resultDir(c.id, submission.id), SUBMISSION_FILE), enc('id,target\n1,0\n2,0\n'), { mode: 0o600 })
  if (pin) bindSubmission(submission.id, pin.id, null)
  return updateSubmission(submission.id, { state: 'scored', publicScore: 1, privateScore: 1 })!
}

async function rescore(c: Competition): Promise<void> {
  assert.ok(rescoreCompetition(c.id) > 0)
  await drainCompetitionQueue()
}

const metricRun = (submissionId: string) => listRuns(submissionId).filter((run) => run.kind === 'metric').at(-1)

/** A docker that has exactly these images (a fresh reader each time: it caches what it was told). `stalls` time out instead. */
function dockerWith(images: string[], stalls: string[] = []) {
  return createCapabilityReader({
    backend: () => 'docker',
    storageAvailable: () => true,
    run: async (args) => {
      if (args[0] === 'version') return '28.1.1'
      const image = args.at(-1)!
      if (stalls.includes(image)) throw Object.assign(new Error(`Command failed: docker image inspect ${image}`), { killed: true, signal: 'SIGTERM', code: null })
      if (!images.includes(image)) throw new Error(`Error: No such image: ${image}`)
      return image
    },
  })
}

/* ------------------------------------------------------------------ tests */

test('a competition keeps the kaggle-base its metric was pinned to when a newer one is recorded, and a new competition takes the newer', async () => {
  reset()
  const first = revision(LIGHT_METRIC_ENVIRONMENT, 'p', 1_000)
  const gpuPin = revision('kaggle-gpu', 'q', 1_500)
  const g = competition(true)
  const early = answered(g, gpuPin)
  await rescore(g)
  assert.equal(metricRun(early.id)?.revisionId, first.id)
  assert.deepEqual(metricPin(g.id), { revisionId: first.id })
  // Another competition refreshes its base: a newer kaggle-base is recorded on this server.
  const newer = revision(LIGHT_METRIC_ENVIRONMENT, 'r', 2_000)
  const late = answered(g, gpuPin)
  await rescore(g)
  assert.equal(metricRun(late.id)?.revisionId, first.id, 'a fresh result scores where the rest did')
  assert.equal(metricRun(early.id)?.revisionId, first.id, 'and a rescore reproduces the image a score came from')
  assert.ok(runner.scores.every((one) => one.imageDigest === first.imageDigest))
  // A competition whose metric runs for the first time now takes the newer one.
  const h = competition(true)
  const other = answered(h, gpuPin)
  await rescore(h)
  assert.equal(metricRun(other.id)?.revisionId, newer.id)
  reset()
})

test('a competition whose metrics ran before the pins keeps scoring where they ran', async () => {
  reset()
  const gpuPin = revision('kaggle-gpu', 's', 3_000)
  const older = revision(LIGHT_METRIC_ENVIRONMENT, 't', 3_100)
  revision(LIGHT_METRIC_ENVIRONMENT, 'u', 3_200)
  // Scored by 0.22: a metric run with no revision recorded, in the submission's own image.
  const g = competition(true)
  const scored = answered(g, gpuPin)
  const legacy = startRun({ submissionId: scored.id, kind: 'metric', container: 'colloq-comp-legacy-score', at: 1 })
  finishRun(legacy.id, { finishedAt: 2, verdict: 'ok', publicScore: 1, privateScore: 1 })
  await rescore(g)
  assert.deepEqual(metricPin(g.id), { revisionId: null })
  assert.equal(metricRun(scored.id)?.revisionId, gpuPin.id, 'its own image, though kaggle-base is here')
  assert.equal(runner.scores.at(-1)?.competition.environment, 'kaggle-gpu')
  // Scored in an older kaggle-base before the pins: that one, not the newest.
  const k = competition(true)
  const before = answered(k, gpuPin)
  const earlier = startRun({ submissionId: before.id, kind: 'metric', container: 'colloq-comp-earlier-score', at: 1, revisionId: older.id })
  finishRun(earlier.id, { finishedAt: 2, verdict: 'ok', publicScore: 1, privateScore: 1 })
  await rescore(k)
  assert.deepEqual(metricPin(k.id), { revisionId: older.id })
  assert.equal(metricRun(before.id)?.revisionId, older.id)
  reset()
})

test('a probe docker did not answer puts the metric off, and it is never scored in another image', async () => {
  reset()
  const pinned = revision(LIGHT_METRIC_ENVIRONMENT, 'v', 4_000)
  const gpuPin = revision('kaggle-gpu', 'w', 4_100)
  const g = competition(true)
  const sent = answered(g, gpuPin)
  await rescore(g)
  assert.deepEqual(metricPin(g.id), { revisionId: pinned.id })
  // A newer kaggle-base is here, and the inspect of the pinned one times out.
  const newer = revision(LIGHT_METRIC_ENVIRONMENT, 'x', 4_200)
  useCompetitionCapabilities(dockerWith([newer.imageDigest, gpuPin.imageDigest], [pinned.imageDigest]))
  runner.scores.length = 0
  await rescore(g)
  assert.equal(runner.scores.length, 0, 'no metric container, in the pinned image or any other')
  const row = queueRow(sent.id)!
  assert.deepEqual([row.state, row.kind, row.resourceRetries], ['waiting', 'metric', 1])
  assert.ok(row.notBefore > Date.now())
  assert.equal(getSubmission(sent.id)?.teacherError, tr('competitions.answer.scoringImageUnchecked'))
  // Docker answers again: the metric runs where it is pinned.
  useCompetitionCapabilities(dockerWith([pinned.imageDigest, newer.imageDigest, gpuPin.imageDigest]))
  db.prepare('UPDATE competition_queue SET not_before = 0 WHERE submission_id = ?').run(sent.id)
  await drainCompetitionQueue()
  assert.equal(getSubmission(sent.id)?.state, 'scored')
  assert.deepEqual(runner.scores.map((one) => one.imageDigest), [pinned.imageDigest])
  reset()
})

test('with no kaggle-base at its first metric a competition keeps its own image, and the teacher moves it to kaggle-base with a rescore of everything', async () => {
  reset()
  const gpuPin = revision('kaggle-gpu', 'y', 5_000)
  // Every kaggle-base recorded so far has lost its image: none is here.
  useCompetitionCapabilities(dockerWith([gpuPin.imageDigest]))
  const g = competition(true)
  const early = answered(g, gpuPin)
  await rescore(g)
  assert.deepEqual(metricPin(g.id), { revisionId: null })
  assert.equal(metricRun(early.id)?.revisionId, gpuPin.id)
  // kaggle-base comes later: it does not move a competition that scored elsewhere.
  const light = revision(LIGHT_METRIC_ENVIRONMENT, 'z', 5_100)
  useCompetitionCapabilities(dockerWith([gpuPin.imageDigest, light.imageDigest]))
  const late = answered(g, gpuPin)
  await rescore(g)
  assert.equal(metricRun(late.id)?.revisionId, gpuPin.id)
  // The teacher moves it: pinned anew, every submission rescored there, the inputs moved on.
  const inputs = getCompetition(g.id)!.inputRevision ?? 0
  const moved = await moveMetricToLightImage(getCompetition(g.id)!)
  assert.ok(typeof moved === 'object')
  assert.equal(moved.revision.id, light.id)
  assert.equal(moved.queued, 2)
  assert.deepEqual(metricPin(g.id), { revisionId: light.id })
  assert.equal(getCompetition(g.id)!.inputRevision, inputs + 1)
  await drainCompetitionQueue()
  for (const s of [early, late]) assert.equal(metricRun(s.id)?.revisionId, light.id)
  // Not for a competition on the CPU, and not without a kaggle-base here.
  assert.equal(await moveMetricToLightImage(competition(false)), 'cpu')
  useCompetitionCapabilities(dockerWith([gpuPin.imageDigest]))
  assert.equal(await moveMetricToLightImage(competition(true)), 'none')
  reset()
})

test('on a server with only GPU competitions kaggle-base is recorded the first time a metric needs it, so building it and rescoring is enough', async () => {
  reset()
  const built = digest('e')
  useCompetitionRunner(asDocker)
  // Built under «Окружения»: the image is here under its name, and no revision records it.
  useCompetitionCapabilities(dockerWith(['colloq-kernel:kaggle-base', built]))
  useDockerForRevisions(async (args) => {
    if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Id: built, Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [] }, RepoDigests: [] }])
    if (args[0] === 'run') return JSON.stringify({ python: '3.11.16', abi: 'cpython-311-x86_64-linux-gnu', packages: [{ name: 'pandas', version: '3.0.6' }] })
    return ''
  })
  try {
    assert.ok(!revisions().some((one) => one.imageDigest === built))
    const g = competition(true)
    const legacy = answered(g, null)
    await rescore(g)
    assert.equal(getSubmission(legacy.id)?.state, 'scored', getSubmission(legacy.id)?.teacherError ?? '')
    const recorded = revisions().find((one) => one.environmentName === LIGHT_METRIC_ENVIRONMENT && one.imageDigest === built)
    assert.ok(recorded, 'kaggle-base recorded on demand')
    assert.deepEqual(metricPin(g.id), { revisionId: recorded.id })
    assert.equal(runner.scores.at(-1)?.imageDigest, built)
  } finally {
    reset()
  }
})

/* --------------------------------------------------------------- the doors */

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.closeAllConnections?.()
  server?.close()
})

function ownerCookie(email: string): string {
  const teacher = createTeacher({ name: 'Хозяйка метрики', email, role: 'owner' })
  assert.ok(teacher, email)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function post(url: string, cookie: string) {
  return fetch(`${base}${url}`, { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(10_000) })
}

/** The competition as the editor loads it (GET /api/admin/competitions/:id). */
async function editorView(id: string, cookie: string): Promise<CompetitionView> {
  const response = await fetch(`${base}/api/admin/competitions/${id}`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()) as CompetitionView
}

test('the metric-only doors of a GPU competition check the kaggle-base its metric runs in, not its own GPU image', async () => {
  reset()
  const owner = ownerCookie('owner.metric.pin@example.edu')
  const gpuImage = revision('kaggle-gpu', 'g', 6_000)
  const light = revision(LIGHT_METRIC_ENVIRONMENT, 'h', 6_100)
  const g = competition(true)
  selectRevision(g.id, gpuImage.id)
  const baseline = answered(g, gpuImage)
  updateCompetition(g.id, { baselineSubmissionId: baseline.id })
  const student = answered(g, gpuImage)
  // The owner removed the thirteen-gigabyte GPU image to free the disk; kaggle-base is here.
  useCompetitionCapabilities(dockerWith([light.imageDigest]))
  const doors = `/api/admin/competitions/${g.id}`
  try {
    const one = await post(`${doors}/submissions/${student.id}/rescore`, owner)
    assert.equal(one.status, 202, await one.clone().text())
    const all = await post(`${doors}/rescore`, owner)
    assert.equal(all.status, 202, await all.clone().text())
    leaveQueue(baseline.id)
    updateSubmission(baseline.id, { state: 'scored' })
    const check = await post(`${doors}/metric/check`, owner)
    assert.equal(check.status, 202, await check.clone().text())
    // A competition on the CPU still checks its own pin, which is where its metric runs.
    const c = competition(false)
    const cpuImage = revision('base', 'i', 6_200)
    selectRevision(c.id, cpuImage.id)
    answered(c, cpuImage)
    const refused = await post(`/api/admin/competitions/${c.id}/rescore`, owner)
    assert.equal(refused.status, 503)
    assert.equal(((await refused.json()) as { error: string }).error, tr('runtime.imageUnavailable'))
  } finally {
    reset()
  }
})

test('the door that moves a GPU competition\'s metric to kaggle-base rescores everything; a CPU one, or one without kaggle-base, is refused in words', async () => {
  reset()
  const owner = ownerCookie('owner.metric.move@example.edu')
  const gpuImage = revision('kaggle-gpu', 'j', 7_000)
  const light = revision(LIGHT_METRIC_ENVIRONMENT, 'l', 7_100)
  const g = competition(true)
  const a = answered(g, gpuImage)
  const b = answered(g, gpuImage)
  useCompetitionCapabilities(dockerWith([gpuImage.imageDigest, light.imageDigest]))
  try {
    const moved = await post(`/api/admin/competitions/${g.id}/metric/image`, owner)
    assert.equal(moved.status, 202, await moved.clone().text())
    assert.deepEqual(await moved.json(), { revisionId: light.id, queued: 2 })
    assert.deepEqual(metricPin(g.id), { revisionId: light.id })
    for (const s of [a, b]) assert.deepEqual([queueRow(s.id)?.state, queueRow(s.id)?.kind], ['waiting', 'metric'])
    const cpu = await post(`/api/admin/competitions/${competition(false).id}/metric/image`, owner)
    assert.equal(cpu.status, 409)
    assert.equal(((await cpu.json()) as { error: string }).error, tr('competitions.refusal.metricImageCpu'))
    useCompetitionCapabilities(dockerWith([gpuImage.imageDigest]))
    const none = await post(`/api/admin/competitions/${competition(true).id}/metric/image`, owner)
    assert.equal(none.status, 503)
    assert.equal(((await none.json()) as { error: string }).error, tr('competitions.refusal.noMetricImage', { environment: LIGHT_METRIC_ENVIRONMENT }))
  } finally {
    reset()
  }
})

/* ------------------------------------------------ the pin and the switch */

test("turning a GPU competition's card off keeps its metric in the pinned kaggle-base, and the door still moves it", async () => {
  reset()
  const light = revision(LIGHT_METRIC_ENVIRONMENT, 'm', 8_000)
  const gpuImage = revision('kaggle-gpu', 'n', 8_100)
  // Only these images are here: a kaggle-base recorded by another test of this file must not be taken for the current one.
  useCompetitionCapabilities(dockerWith([light.imageDigest, gpuImage.imageDigest]))
  try {
    const g = competition(true)
    selectRevision(g.id, gpuImage.id)
    const early = answered(g, gpuImage)
    await rescore(g)
    assert.deepEqual(metricPin(g.id), { revisionId: light.id })
    assert.equal(metricRun(early.id)?.revisionId, light.id)
    // The machines with cards are gone: the teacher turns the card off for the waiting notebooks to go on the CPU.
    updateCompetition(g.id, { limits: { ...g.limits, gpu: false } })
    const off = getCompetition(g.id)!
    assert.equal(off.limits.gpu, false)
    const late = answered(off, gpuImage)
    runner.scores.length = 0
    await rescore(off)
    assert.deepEqual(metricPin(g.id), { revisionId: light.id })
    for (const s of [early, late]) assert.equal(metricRun(s.id)?.revisionId, light.id, 'one board, one image')
    assert.ok(runner.scores.length === 2 && runner.scores.every((one) => one.imageDigest === light.imageDigest && one.competition.environment === LIGHT_METRIC_ENVIRONMENT))
    // The doors that run only the metric check the image it runs in.
    assert.deepEqual(await metricScoringImage(off), { environment: LIGHT_METRIC_ENVIRONMENT, imageDigest: light.imageDigest })
    // A newer kaggle-base: the teacher's door moves the pin with the card off as with it on.
    const newer = revision(LIGHT_METRIC_ENVIRONMENT, 'o', 8_200)
    useCompetitionCapabilities(dockerWith([light.imageDigest, newer.imageDigest, gpuImage.imageDigest]))
    const moved = await moveMetricToLightImage(off)
    assert.ok(typeof moved === 'object', String(moved))
    assert.deepEqual([moved.revision.id, moved.queued], [newer.id, 2])
    await drainCompetitionQueue()
    for (const s of [early, late]) assert.equal(metricRun(s.id)?.revisionId, newer.id)
    // A competition on the CPU that was never pinned scores in its own pin, and the door says so.
    assert.equal(await moveMetricToLightImage(competition(false)), 'cpu')
  } finally {
    reset()
  }
})

test('a competition checked on the CPU and then given a card pins kaggle-base at its first metric with the card', async () => {
  reset()
  const light = revision(LIGHT_METRIC_ENVIRONMENT, 'k', 9_000)
  const cpuImage = revision('base', 'f', 9_100)
  const gpuImage = revision('kaggle-gpu', 'd', 9_200)
  useCompetitionCapabilities(dockerWith([light.imageDigest, cpuImage.imageDigest, gpuImage.imageDigest]))
  try {
    // Born on base: the teacher uploads a baseline and checks it there — a metric run under the base revision.
    const c = competition(false)
    selectRevision(c.id, cpuImage.id)
    const baseline = answered(c, cpuImage)
    updateCompetition(c.id, { baselineSubmissionId: baseline.id })
    await rescore(c)
    assert.equal(metricRun(baseline.id)?.revisionId, cpuImage.id)
    assert.equal(metricPin(c.id), null, 'a competition on the CPU pins nothing')
    // Then kaggle-gpu and a card.
    updateCompetition(c.id, { environment: 'kaggle-gpu', limits: { ...c.limits, gpu: true } })
    selectRevision(c.id, gpuImage.id)
    const student = answered(getCompetition(c.id)!, gpuImage)
    await rescore(getCompetition(c.id)!)
    assert.deepEqual(metricPin(c.id), { revisionId: light.id }, 'not each submission\'s own GPU image')
    assert.equal(metricRun(student.id)?.revisionId, light.id)

    // Scored by 0.22 (no revision recorded): its baseline's check and a metric that failed tie no board to an image.
    const k = competition(true)
    const check = answered(k, gpuImage)
    updateCompetition(k.id, { baselineSubmissionId: check.id })
    const checked = startRun({ submissionId: check.id, kind: 'metric', container: 'colloq-comp-check-score', at: 1 })
    finishRun(checked.id, { finishedAt: 2, verdict: 'ok', publicScore: 1, privateScore: 1 })
    const broken = answered(k, gpuImage)
    const failed = startRun({ submissionId: broken.id, kind: 'metric', container: 'colloq-comp-broken-score', at: 3 })
    finishRun(failed.id, { finishedAt: 4, verdict: 'metric_error' })
    await rescore(k)
    assert.deepEqual(metricPin(k.id), { revisionId: light.id })
    // A score 0.22 put on its board does: that competition keeps scoring in each submission's own image.
    const scored = competition(true)
    const board = answered(scored, gpuImage)
    const legacy = startRun({ submissionId: board.id, kind: 'metric', container: 'colloq-comp-board-score', at: 1 })
    finishRun(legacy.id, { finishedAt: 2, verdict: 'ok', publicScore: 1, privateScore: 1 })
    await rescore(scored)
    assert.deepEqual(metricPin(scored.id), { revisionId: null })
    assert.equal(metricRun(board.id)?.revisionId, gpuImage.id)
  } finally {
    reset()
  }
})

test('the editor is told the metric scores in its pin with the card turned off, and not for a competition never pinned on the CPU', async () => {
  reset()
  const owner = ownerCookie('owner.metric.view@example.edu')
  const light = revision(LIGHT_METRIC_ENVIRONMENT, 'a', 10_000)
  const gpuImage = revision('kaggle-gpu', 'b', 10_100)
  useCompetitionCapabilities(dockerWith([light.imageDigest, gpuImage.imageDigest]))
  try {
    const g = competition(true)
    selectRevision(g.id, gpuImage.id)
    // With the card the row is there before any metric ran: the first one takes the pin.
    assert.equal((await editorView(g.id, owner)).metricScoresInPin, true)
    answered(g, gpuImage)
    await rescore(g)
    assert.deepEqual(metricPin(g.id), { revisionId: light.id })
    // The card turned off: the metric still scores in the pin, and the editor keeps the row that moves it.
    updateCompetition(g.id, { limits: { ...g.limits, gpu: false } })
    const off = await editorView(g.id, owner)
    assert.equal(off.competition.limits.gpu, false)
    assert.equal(off.metricScoresInPin, true)
    // Never pinned, on the CPU: its metric scores in its own pin, the move door refuses it, and there is no row.
    const cpu = competition(false)
    assert.equal((await editorView(cpu.id, owner)).metricScoresInPin, false)
    assert.equal(await moveMetricToLightImage(cpu), 'cpu')
  } finally {
    reset()
  }
})
