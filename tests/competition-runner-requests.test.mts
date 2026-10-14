/**
 * What a runner is handed, and what docker is told.
 *
 * A notebook run and a metric run carry only the fields of the competition
 * they read, picked one by one: the request is what a machine that runs
 * submissions for this server will be given as a small JSON, and the whole
 * row would hand it the metric code and the seed that splits the answer key.
 * And both containers start with `--pull=never`: the image is the revision the
 * submission was pinned to, here or not at all, and a missing one is docker's
 * plain "No such image" at once, never a pull under the launch's deadline.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  getSubmission,
  leaveQueue,
  putFile,
  queueRows,
  setQueuePaused,
} from '../server/src/competitions/store.js'
import { putOpenFile, putSecretFile, putSubmissionNotebook, SOLUTION_FILE } from '../server/src/competitions/storage.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { runArgs, scoreArgs, useDockerForCompetitions } from '../server/src/competitions/docker-runner.js'
import {
  competitionRunner,
  forgetCompetitionRunner,
  limitsFor,
  runCompetition,
  scoreCompetition,
  useCompetitionRunner,
  type RunOutcome,
  type RunRequest,
  type ScoreOutcome,
  type ScoreRequest,
} from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue, setQueueSlots } from '../server/src/competitions/runner.js'
import type { Competition } from '../shared/competitions.js'

const enc = (text: string) => new TextEncoder().encode(text)
const METRIC = 'def score(solution, submission):\n    return 0.25  # the teacher\'s own code\n'

class Recording extends FakeCompetitionRunner {
  runs: RunRequest['competition'][] = []
  scores: ScoreRequest['competition'][] = []
  override async run(request: RunRequest): Promise<RunOutcome> {
    this.runs.push(request.competition)
    return super.run(request)
  }
  override async score(request: ScoreRequest): Promise<ScoreOutcome> {
    this.scores.push(request.competition)
    return super.score(request)
  }
}

test('a notebook run and a metric run carry only the fields of the competition they read', async () => {
  const runner = new Recording()
  useCompetitionRunner(runner)
  try {
    for (const row of queueRows()) leaveQueue(row.submissionId)
    setQueuePaused(false)
    setQueueSlots(1)
    const c = createCompetition({ slug: 'requests', title: 'Requests', description: 'The teacher\'s long description', metric: { name: 'MAE', direction: 'lower', code: METRIC }, publicPercent: 40 })!
    putOpenFile(c.id, 'sample_submission.csv', enc('id,target\n1,0\n'))
    putFile({ competitionId: c.id, name: 'sample_submission.csv', bytes: 14, visibility: 'open' })
    putSecretFile(c.id, SOLUTION_FILE, enc('id,target\n1,1\n'))
    const entrant = createEntrant('Request watcher').entrant
    const submission = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'n.ipynb', bytes: 10 })
    putSubmissionNotebook(c.id, submission.id, enc(JSON.stringify({ cells: [{ cell_type: 'code', source: 'pass', metadata: {}, outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 })))
    await drainCompetitionQueue()
    assert.equal(getSubmission(submission.id)?.state, 'scored')
    assert.deepEqual(runner.runs, [{ id: c.id, environment: c.environment }])
    assert.deepEqual(runner.scores, [{ id: c.id, environment: c.environment, publicPercent: 40, splitSeed: c.splitSeed }])
    // Nothing else of the row rides along: not the metric, not the texts.
    for (const sent of [...runner.runs, ...runner.scores]) {
      const text = JSON.stringify(sent)
      assert.ok(!text.includes('the teacher') && !text.includes('long description'), text)
    }
    assert.ok(!JSON.stringify(runner.runs).includes(c.splitSeed), 'the seed that splits the answer key travels with a notebook')
  } finally {
    useCompetitionRunner(null)
  }
})

test('the request fields are picked one by one, not the row passed under a narrower type', () => {
  const row = { id: 'abcdefgh', environment: 'kaggle-base', publicPercent: 30, splitSeed: 'seed', metric: { code: METRIC }, title: 't' } as unknown as Competition
  assert.deepEqual(Object.keys(runCompetition(row)).sort(), ['environment', 'id'])
  assert.deepEqual(Object.keys(scoreCompetition(row)).sort(), ['environment', 'id', 'publicPercent', 'splitSeed'])
})

const LIMITS = limitsFor({ limits: { wallSeconds: 60, memoryMb: 4096, cpus: 2, perDay: 5 } } as Competition, 'notebook')

test('both containers start with --pull=never, ahead of the image', () => {
  const run = runArgs({ container: 'c-run', image: 'sha256:notebook', dataDir: '/data/open', inputDir: '/data/in', resultDir: '/data/result', limits: LIMITS, target: 'submission.csv' })
  const score = scoreArgs({ container: 'c-score', image: 'sha256:scorer', secretDir: '/data/secret', submissionDir: '/data/answer', outDir: '/data/score', limits: limitsFor({ limits: { wallSeconds: 60, memoryMb: 4096, cpus: 2, perDay: 5 } } as Competition, 'metric'), solutionFile: 'solution.csv', metricFile: 'metric.py', idColumn: 'id', publicPercent: 30, splitSeed: 'seed' })
  for (const [args, image] of [[run, 'sha256:notebook'], [score, 'sha256:scorer']] as const) {
    assert.equal(args[0], 'run')
    assert.ok(args.includes('--pull=never'), args.join(' '))
    assert.ok(args.indexOf('--pull=never') < args.indexOf(image), 'a flag after the image is an argument of the program')
    assert.ok(!args.some((arg) => /^--pull=(?!never)/.test(arg)))
  }
})

test("a missing image fails the launch at once with docker's own words, and nothing is pulled", async () => {
  const before = process.env.COMPETITION_BACKEND
  const commands: string[][] = []
  const missing = 'docker: Error response from daemon: No such image: sha256:0000000000000000000000000000000000000000000000000000000000000000.'
  process.env.COMPETITION_BACKEND = 'docker'
  useCompetitionRunner(null)
  forgetCompetitionRunner()
  useDockerForCompetitions(async (args) => {
    commands.push(args)
    // A daemon without the image: without the flag it goes looking in a registry instead.
    if (args[0] === 'run') return args.includes('--pull=never') ? { code: 125, out: missing } : { code: 125, out: "Unable to find image locally\nPulling from docker.io/library/..." }
    return { code: 0, out: '' }
  })
  try {
    const actual = competitionRunner()
    const competition = { id: 'abcdefgh', environment: 'base', publicPercent: 30, splitSeed: 's' }
    const image = `sha256:${'0'.repeat(64)}`
    const run = await actual.run({ competition, imageDigest: image, submissionId: 's', container: 'c-run', dataDir: '/data/open', inputDir: '/data/in', resultDir: '/data/result', limits: LIMITS })
    assert.equal(run.status, 'harness_error')
    assert.match(run.log, /No such image/)
    const score = await actual.score({ competition, imageDigest: image, submissionId: 's', container: 'c-score', secretDir: '/data/secret', submissionDir: '/data/answer', outDir: '/data/score', limits: LIMITS })
    assert.equal(score.status, 'metric_error')
    assert.match(score.teacherOnly ?? '', /No such image/)
    assert.ok(!commands.some((args) => args[0] === 'pull'), 'something was pulled')
    assert.equal(commands.filter((args) => args[0] === 'run').length, 2)
  } finally {
    useDockerForCompetitions(null)
    forgetCompetitionRunner()
    if (before === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = before
  }
})
