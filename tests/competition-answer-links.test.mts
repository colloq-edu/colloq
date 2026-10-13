/**
 * The metric reads the answer key and the participant's answer through hard
 * links, not copies.
 *
 * Every job used to copy the answer key into its own snapshot, up to two
 * hundred megabytes read and written per submission on the disk the class
 * works from, and the answer again into the metric's folder. A link is one
 * metadata operation and holds the same promise a copy did: the bytes the job
 * started with, whatever the teacher uploads meanwhile. Where the volume
 * refuses links, the copy is still there; and a link error that is not a
 * refusal is our breakage, said as such.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
import {
  inputLinks,
  putOpenFile,
  putSecretFile,
  putSubmissionNotebook,
  resultDir,
  secretDir,
  submissionDir,
  SOLUTION_FILE,
  SUBMISSION_FILE,
} from '../server/src/competitions/storage.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type RunOutcome, type RunRequest, type ScoreOutcome, type ScoreRequest } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue, setQueueSlots } from '../server/src/competitions/runner.js'
import type { Competition } from '../shared/competitions.js'

const KEY = 'id,target\n1,1\n2,2\n'
const enc = (text: string) => new TextEncoder().encode(text)

/** What the metric was handed, looked at while it ran. */
interface Seen {
  keyIno: number
  masterKeyIno: number
  key: string
  answerIno: number
  storedAnswerIno: number
  answer: string
}

class Watching extends FakeCompetitionRunner {
  seen: Seen[] = []
  /** Something to do while the notebook runs, before the metric starts. */
  duringRun: ((request: RunRequest) => void) | null = null
  override async run(request: RunRequest): Promise<RunOutcome> {
    this.duringRun?.(request)
    return super.run(request)
  }
  override async score(request: ScoreRequest): Promise<ScoreOutcome> {
    const key = path.join(request.secretDir, SOLUTION_FILE)
    const answer = path.join(request.submissionDir, SUBMISSION_FILE)
    this.seen.push({
      keyIno: fs.statSync(key).ino,
      masterKeyIno: fs.statSync(path.join(secretDir(request.competition.id), SOLUTION_FILE)).ino,
      key: fs.readFileSync(key, 'utf8'),
      answerIno: fs.statSync(answer).ino,
      storedAnswerIno: fs.statSync(path.join(resultDir(request.competition.id, request.submissionId), SUBMISSION_FILE)).ino,
      answer: fs.readFileSync(answer, 'utf8'),
    })
    return super.score(request)
  }
}

const runner = new Watching()
useCompetitionRunner(runner)

let seq = 0
function setup(): { competition: Competition; send: () => string } {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
  runner.seen = []
  runner.duringRun = null
  const competition = createCompetition({
    slug: `links-${++seq}`,
    title: `Links ${seq}`,
    metric: { name: 'MAE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 0 },
  })!
  putOpenFile(competition.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putFile({ competitionId: competition.id, name: 'sample_submission.csv', bytes: 18, visibility: 'open' })
  putSecretFile(competition.id, SOLUTION_FILE, enc(KEY))
  const send = () => {
    const entrant = createEntrant(`Links ${seq}-${Math.random().toString(36).slice(2, 8)}`).entrant
    const submission = acceptSubmission({ competitionId: competition.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100 })
    putSubmissionNotebook(competition.id, submission.id, enc(JSON.stringify({
      cells: [{ cell_type: 'code', source: 'pass', metadata: {}, outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5,
    })))
    return submission.id
  }
  return { competition, send }
}

/** With links refused the way a volume refuses them, for the length of `body`. */
async function withoutLinks<T>(body: () => Promise<T>, code = 'EXDEV'): Promise<T> {
  const link = inputLinks.link
  inputLinks.link = () => { throw Object.assign(new Error(`link refused (${code})`), { code }) }
  try {
    return await body()
  } finally {
    inputLinks.link = link
  }
}

test('the metric reads the answer key and the answer through hard links to the files the server keeps', async () => {
  const { competition, send } = setup()
  const id = send()
  await drainCompetitionQueue()
  assert.equal(getSubmission(id)?.state, 'scored')
  const [seen] = runner.seen
  assert.ok(seen, 'the metric ran')
  assert.equal(seen.keyIno, seen.masterKeyIno, 'the answer key was copied, not linked')
  assert.equal(seen.answerIno, seen.storedAnswerIno, 'the answer was copied, not linked')
  assert.equal(seen.key, KEY)
  // Gone with the attempt; what they linked to stays whole.
  assert.deepEqual(fs.readdirSync(path.join(submissionDir(competition.id, id), 'attempts')), [])
  assert.equal(fs.readFileSync(path.join(secretDir(competition.id), SOLUTION_FILE), 'utf8'), KEY)
  assert.equal(fs.readFileSync(path.join(resultDir(competition.id, id), SUBMISSION_FILE), 'utf8'), seen.answer)
})

test('where the volume refuses links, both are copied, byte for byte', async () => {
  const { send } = setup()
  const id = send()
  await withoutLinks(() => drainCompetitionQueue())
  assert.equal(getSubmission(id)?.state, 'scored')
  const [seen] = runner.seen
  assert.notEqual(seen.keyIno, seen.masterKeyIno)
  assert.notEqual(seen.answerIno, seen.storedAnswerIno)
  assert.equal(seen.key, KEY)
})

test('an answer key replaced while the notebook runs leaves the job the one it started with, linked or copied', async () => {
  for (const linked of [true, false]) {
    const { competition, send } = setup()
    const id = send()
    runner.duringRun = () => putSecretFile(competition.id, SOLUTION_FILE, enc('id,target\n1,9\n2,9\n'))
    if (linked) await drainCompetitionQueue()
    else await withoutLinks(() => drainCompetitionQueue())
    assert.equal(getSubmission(id)?.state, 'scored', linked ? 'linked' : 'copied')
    assert.equal(runner.seen[0]?.key, KEY, linked ? 'linked' : 'copied')
    // The new key is the one the next job snapshots.
    assert.equal(fs.readFileSync(path.join(secretDir(competition.id), SOLUTION_FILE), 'utf8'), 'id,target\n1,9\n2,9\n')
  }
})

test('a link error that is no refusal of links fails the submission as our breakage, never quietly', async () => {
  const { send } = setup()
  const id = send()
  await withoutLinks(() => drainCompetitionQueue(), 'EACCES')
  const done = getSubmission(id)
  assert.equal(done?.state, 'metricFailed')
  assert.match(done?.teacherError ?? '', /link refused \(EACCES\)/)
  assert.equal(runner.seen.length, 0, 'the metric ran without its answer key')
})
