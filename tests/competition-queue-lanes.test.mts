/**
 * The queue with machines that run submissions in it, and the two lanes of
 * this server's pump (docs/architecture/remote-runners.md §5.1–5.3, §5.7).
 *
 * Each of these fails quietly. A row a machine holds that this server counts
 * as its own takes a slot nobody is using, a card share nobody holds, or — at
 * a restart — a run that is still going, which then runs twice. A fair order
 * that counts "has something running" as yes or no puts on the screen a
 * person the executor takes second. A rescore of a hundred submissions after
 * a metric fix, taken in the one lane there used to be, keeps every fresh
 * notebook waiting behind it for the length of a hundred metrics. And a
 * server whose notebooks were switched off that still takes one runs it on
 * the machine the switch was meant to keep free for the class.
 *
 * No machine is needed for any of it: a machine's lease is, to the queue, a
 * running row with a holder, made here the way the take for a machine makes
 * it (state, attempt, holder) and nothing more.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { db } from '../server/src/db.js'
import type { Competition, Submission } from '../shared/competitions.js'
import { SETTINGS_LIMITS } from '../shared/competitions-settings.js'
import { REMOTE_BLOB_MBPS, REMOTE_UPLOADS } from '../shared/remote-runner.js'
import {
  BOOT,
  acceptSubmission,
  createCompetition,
  createEntrant,
  enqueue,
  getSubmission,
  leaveQueue,
  nextQueueRow,
  orphanedRuns,
  putFile,
  queueRow,
  queueRows,
  reclaimQueue,
  requeue,
  runningCount,
  runningRows,
  setQueuePaused,
  takeNext,
  updateSubmission,
  type QueueRow,
} from '../server/src/competitions/store.js'
import { competitionsFs, putOpenFile, putSecretFile, putSubmissionNotebook, resultDir, SUBMISSION_FILE } from '../server/src/competitions/storage.js'
import { SOLUTION_NAME } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type ScoreRequest } from '../server/src/competitions/runner-port.js'
import {
  cancelSubmission,
  drainCompetitionQueue,
  pumpOnce,
  reclaimCompetitionQueue,
  rescoreCompetition,
  setQueueSlots,
  settleCompetitionWork,
  settleSubmission,
} from '../server/src/competitions/runner.js'
import {
  homeNotebooksSetting,
  parseSettingsInput,
  runnerSettings,
  saveCompetitionSettings,
  scoreSlotsSetting,
} from '../server/src/competitions/settings.js'
import { queueForecast } from '../server/src/competitions/forecast.js'
import { fairOrder, runningCounts, scoreOrder } from '../server/src/competitions/panel.js'

/* ------------------------------------------------------------------ setup */

/** The stand-in runner, which also remembers the metric runs asked of it. */
class Runner extends FakeCompetitionRunner {
  readonly scored: string[] = []

  override async score(request: ScoreRequest) {
    this.scored.push(request.submissionId)
    return super.score(request)
  }
}

const runner = new Runner()
useCompetitionRunner(runner)

const MACHINE = 'machine-1'
const MACHINE_SETTINGS = { homeNotebooks: null, scoreSlots: null, runnerBlobMBps: null, runnerUploads: null } as const

/** Everything back as a fresh server has it: an empty queue, one slot, the machines' settings forgotten. */
async function reset(): Promise<void> {
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
  saveCompetitionSettings({ ...MACHINE_SETTINGS })
  runner.availableMb = 65_536
  runner.scored.length = 0
}

let seq = 0
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

function competition(gpu = false): Competition {
  seq += 1
  const made = createCompetition({
    slug: `lanes${seq}`,
    title: `Lanes ${seq}`,
    blurb: '',
    description: '',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    publicPercent: 30,
    limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 0, ...(gpu ? { gpu: true } : {}) },
    environment: gpu ? 'base-gpu' : 'base',
  })
  assert.ok(made)
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 20, visibility: 'open' })
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  return made
}

function person(name: string): string {
  return createEntrant(`${name} ${seq}-${randomUUID().slice(0, 6)}`).entrant.id
}

function send(c: Competition, entrantId: string, source = 'x = 1', at = Date.now()): Submission {
  const submission = acceptSubmission({ competitionId: c.id, entrantId, fileName: 'solution.ipynb', bytes: 100, at })
  putSubmissionNotebook(c.id, submission.id, enc(JSON.stringify({
    cells: [{ cell_type: 'code', source, metadata: {}, outputs: [] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })))
  return submission
}

/**
 * The row as a machine's take leaves it (store.ts · markRunning with a
 * holder): running, a fresh attempt, this server's boot — or another life's,
 * which must not make it an orphan of this one.
 */
function holdOnMachine(submissionId: string, options: { boot?: string; gpu?: string } = {}): QueueRow {
  db.prepare(`UPDATE competition_queue SET state = 'running', started_at = ?, attempts = attempts + 1, boot = ?, attempt_id = ?,
    holder = ?, gpu = ?, gpu_per_device = ? WHERE submission_id = ?`)
    .run(Date.now(), options.boot ?? BOOT, randomUUID().replaceAll('-', ''), MACHINE, options.gpu ?? null, options.gpu ? 1 : null, submissionId)
  updateSubmission(submissionId, { state: 'running', stage: 'notebook' })
  return queueRow(submissionId)!
}

/** A submission scored once, whose stored answer the stand-in's metric then holds on for `holdMs` (its directive travels in the answer). */
async function scoredWithSlowAnswer(c: Competition, holdMs: number): Promise<Submission> {
  const sent = send(c, person('Пересчёт'))
  await drainCompetitionQueue()
  assert.equal(getSubmission(sent.id)?.state, 'scored')
  competitionsFs.writeFileSync(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE), enc(`# colloq-test: {"hold": ${holdMs}}\nid,target\n1,0\n2,0\n`), { mode: 0o600 })
  return sent
}

const HOLD = '# colloq-test: {"hold": 60000}\nmodel.fit()'

/* ----------------------------------------------- a row a machine holds */

test("a row a machine holds is not this server's: not in its running rows, its slots or its takes", async () => {
  await reset()
  const c = competition()
  const there = send(c, person('Там'))
  const here = send(c, person('Здесь'))
  const held = holdOnMachine(there.id)
  assert.equal(held.holder, MACHINE)
  assert.deepEqual(runningRows(), [], 'running here is only what this server runs')
  assert.equal(runningCount(), 0)
  assert.equal(runningCount('notebook'), 0)
  // One slot, and the machine's run takes none of it: the take here goes on.
  const taken = takeNext({ boot: BOOT, slots: 1, lane: 'notebook' })
  assert.equal(taken?.submissionId, here.id)
  assert.equal(taken?.holder, null, 'what this server takes it holds itself')
  assert.equal(takeNext({ boot: BOOT, slots: 1, lane: 'notebook' }), null, 'and its own run does fill its slot')
  // The legacy take counts the same way: every running row of this server, and only those.
  leaveQueue(here.id)
  const third = send(c, person('Третий'))
  assert.equal(takeNext({ boot: BOOT, slots: 1 })?.submissionId, third.id)
  // The machine's row is still the machine's.
  assert.equal(queueRow(there.id)?.holder, MACHINE)
  assert.equal(queueRow(there.id)?.attemptId, held.attemptId)
  await reset()
})

test("a machine's GPU notebook takes no share of this server's cards, nor a place of the cluster's", async () => {
  await reset()
  const g = competition(true)
  const there = send(g, person('ТамГПУ'), 'x = 1', 1)
  const here = send(g, person('ЗдесьГПУ'), 'x = 1', 2)
  // A machine's GPU notebook: no card of this server (gpu NULL), and needing one by the competition's switch.
  holdOnMachine(there.id)
  // Under the cluster one GPU notebook may run at once: the machine's must not be it.
  assert.equal(nextQueueRow(10, { cards: [], cluster: 1 }, 'notebook')?.submissionId, here.id)
  assert.equal(takeNext({ at: 10, boot: BOOT, slots: 8, gpu: { cards: [], cluster: 1 }, lane: 'notebook' })?.submissionId, here.id)
  leaveQueue(here.id)
  // Even a row a machine holds that names a card here (it never should) leaves the card to this server.
  const card = send(g, person('Карта'), 'x = 1', 3)
  leaveQueue(there.id)
  const other = send(g, person('Другая'), 'x = 1', 4)
  holdOnMachine(other.id, { gpu: '0' })
  const taken = takeNext({ at: 20, boot: BOOT, slots: 8, gpu: { cards: [{ id: '0', capacity: 1 }] }, lane: 'notebook' })
  assert.equal(taken?.submissionId, card.id)
  assert.equal(taken?.gpu, '0', 'the one share of card 0 is this server run\'s')
  await reset()
})

test("a restart here reclaims its own orphans and leaves a machine's run running", async () => {
  await reset()
  const c = competition()
  const there = send(c, person('ТамРестарт'))
  const here = send(c, person('ЗдесьРестарт'))
  // Both taken by the previous life of this server; one of them by a machine.
  const previousLife = randomUUID()
  const thisLife = randomUUID()
  const held = holdOnMachine(there.id, { boot: previousLife })
  assert.equal(takeNext({ boot: previousLife, slots: 8 })?.submissionId, here.id)
  updateSubmission(here.id, { state: 'running', stage: 'notebook' })
  assert.deepEqual(orphanedRuns(thisLife).map((row) => row.submissionId), [here.id], 'the machine\'s run is no orphan of this server')
  const { requeued, abandoned } = reclaimQueue(thisLife)
  assert.deepEqual(requeued.map((row) => row.submissionId), [here.id])
  assert.deepEqual(abandoned, [])
  const after = queueRow(there.id)!
  assert.equal(after.state, 'running')
  assert.equal(after.holder, MACHINE)
  assert.equal(after.attemptId, held.attemptId, 'the lease it runs under is untouched')
  assert.equal(getSubmission(there.id)?.state, 'running')
  // The pump's own reclaim at startup, the same.
  leaveQueue(here.id)
  const again = await reclaimCompetitionQueue()
  assert.equal(again.requeued, 0)
  assert.equal(queueRow(there.id)?.state, 'running')
  await reset()
})

test("a row a machine gives back waits with no holder, and new work starts its losses over", async () => {
  await reset()
  const c = competition()
  const sent = send(c, person('Потеря'))
  holdOnMachine(sent.id)
  db.prepare('UPDATE competition_queue SET lost = 2 WHERE submission_id = ?').run(sent.id)
  // Lost by the machine: back to waiting, holder gone, the losses kept for the next loss.
  assert.equal(requeue(sent.id), true)
  assert.equal(queueRow(sent.id)?.holder, null)
  assert.equal(queueRow(sent.id)?.lost, 2)
  // A rerun or a rescore is new work: its losses start at zero.
  enqueue({ submissionId: sent.id, competitionId: c.id, entrantId: sent.entrantId, kind: 'notebook' })
  assert.equal(queueRow(sent.id)?.lost, 0)
  await reset()
})

/* ----------------------------------------------------------- the fair order */

test("the fair order counts a person's runs wherever they run, and the screens count them as the take does", async () => {
  await reset()
  const c = competition()
  const x = person('Икс')
  const y = person('Игрек')
  // X's waiting notebook was sent first (turn 0); then X has two runs going, one of them on a machine.
  const xWaiting = send(c, x, 'a', 1)
  const xThere = send(c, x, 'b', 2)
  const xHere = send(c, x, 'c', 3)
  // Y has one run going here and a notebook waiting (turn 1).
  const yHere = send(c, y, 'd', 4)
  const yWaiting = send(c, y, 'e', 5)
  holdOnMachine(xThere.id)
  for (const id of [xHere.id, yHere.id]) {
    db.prepare(`UPDATE competition_queue SET state = 'running', started_at = ?, attempts = 1, boot = ?, attempt_id = ? WHERE submission_id = ?`)
      .run(Date.now(), BOOT, randomUUID().replaceAll('-', ''), id)
  }
  const waiting = queueRows().filter((row) => row.state === 'waiting')
  const running = queueRows().filter((row) => row.state === 'running')
  assert.equal(running.length, 3)
  // Two runs against one: Y goes first, though X's notebook is older and of an earlier turn.
  const counts = runningCounts(running)
  assert.deepEqual([counts.get(x), counts.get(y)], [2, 1])
  assert.deepEqual(fairOrder(waiting, counts).map((row) => row.submissionId), [yWaiting.id, xWaiting.id])
  // As a yes or no — both "have something running" — the screen would have put X first.
  assert.deepEqual(fairOrder(waiting, new Set([x, y])).map((row) => row.submissionId), [xWaiting.id, yWaiting.id])
  // The take and both screens agree.
  assert.equal(nextQueueRow(Date.now(), undefined, 'notebook')?.submissionId, yWaiting.id)
  const forecast = queueForecast(8, Date.now(), null, { homeNotebooks: true, scoreSlots: 2 })
  assert.deepEqual(forecast.eligible.map((row) => row.submissionId), [yWaiting.id, xWaiting.id])
  assert.equal(forecast.at.get(yWaiting.id)?.place, 1)
  assert.equal(takeNext({ boot: BOOT, slots: 8, lane: 'notebook' })?.submissionId, yWaiting.id)
  for (const id of [xHere.id, yHere.id, yWaiting.id]) leaveQueue(id)
  await reset()
})

/* -------------------------------------------------------------- the lanes */

test('a metric row never blocks a notebook row: rescores queued ahead of a fresh notebook start beside it, in one pass', async () => {
  await reset()
  const c = competition()
  const old = [] as Submission[]
  for (let i = 0; i < 4; i++) old.push(await scoredWithSlowAnswer(c, 60_000))
  // The rescore after a metric fix: every stored answer back in the queue, before the fresh upload.
  assert.equal(rescoreCompetition(c.id), 4)
  const fresh = send(c, person('Свежий'), HOLD)
  assert.equal(scoreSlotsSetting().value, 2, 'two metric places by default')
  assert.equal(await pumpOnce(), 3, 'one notebook in its slot, two metrics in theirs')
  assert.equal(queueRow(fresh.id)?.state, 'running', 'the fresh notebook did not wait behind the rescores')
  assert.equal(runningCount('notebook'), 1)
  assert.equal(runningCount('metric'), 2)
  assert.equal(old.filter((s) => queueRow(s.id)?.state === 'running').length, 2)
  // Full lanes take nothing more, whatever waits.
  assert.equal(await pumpOnce(), 0)
  await reset()
})

test('a full notebook lane keeps no metric waiting, and the metric lane holds to its own places', async () => {
  await reset()
  saveCompetitionSettings({ scoreSlots: 3 })
  const c = competition()
  const rescored = [] as Submission[]
  for (let i = 0; i < 5; i++) rescored.push(await scoredWithSlowAnswer(c, 60_000))
  const busy = send(c, person('Занят'), HOLD)
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(busy.id)?.state, 'running')
  assert.equal(rescoreCompetition(c.id), 5)
  assert.equal(await pumpOnce(), 3, 'the notebook lane is full; the metric lane fills its three places')
  assert.equal(runningCount('metric'), 3)
  assert.equal(rescored.filter((s) => queueRow(s.id)?.state === 'waiting').length, 2)
  await reset()
})

test('the metric lane admits 256 MB and the metric\'s memory, where a notebook needs its larger step', async () => {
  await reset()
  const c = competition()
  const rescore = await scoredWithSlowAnswer(c, 60_000)
  assert.equal(rescoreCompetition(c.id), 1)
  const notebook = send(c, person('Большой'), HOLD)
  // 4 GB notebook + 256 MB does not fit 3000 MB; a 2 GB metric + 256 MB does.
  runner.availableMb = 3000
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(rescore.id)?.state, 'running')
  assert.equal(queueRow(notebook.id)?.state, 'waiting')
  assert.equal(queueRow(notebook.id)?.attempts, 0, 'a notebook refused for memory spends no attempt')
  await reset()
})

test('with notebooks off this server only scores, and the screens give its notebooks no place', async () => {
  await reset()
  const c = competition()
  const rescore = await scoredWithSlowAnswer(c, 60_000)
  saveCompetitionSettings({ homeNotebooks: false })
  assert.equal(homeNotebooksSetting().value, false)
  const notebook = send(c, person('Ждёт'), HOLD)
  assert.equal(rescoreCompetition(c.id), 1)
  assert.equal(await pumpOnce(), 1, 'the metric, and not the notebook')
  assert.equal(queueRow(rescore.id)?.state, 'running')
  assert.equal(queueRow(notebook.id)?.state, 'waiting')
  assert.equal(await pumpOnce(), 0)
  const forecast = queueForecast(4, Date.now(), null)
  assert.equal(forecast.at.has(notebook.id), false, 'no place: nothing here will start it')
  assert.ok(forecast.eligible.some((row) => row.submissionId === notebook.id), 'still listed, after every placed row')
  // Back on: the next pass takes it.
  saveCompetitionSettings({ homeNotebooks: true })
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(notebook.id)?.state, 'running')
  await reset()
})

test('notebooks waiting for the machines cost this server no probe while its own notebooks are off', async () => {
  await reset()
  saveCompetitionSettings({ homeNotebooks: false })
  const c = competition()
  send(c, person('ЖдётМашину'), HOLD)
  const capacity = runner.capacity.bind(runner)
  let asked = 0
  runner.capacity = async () => { asked++; return capacity() }
  try {
    assert.equal(await pumpOnce(), 0)
    assert.equal(asked, 0, 'no lane had work it could take: the machine was not measured')
    // A notebook lane with its work waiting is measured, as always.
    saveCompetitionSettings({ homeNotebooks: true })
    assert.equal(await pumpOnce(), 1)
    assert.equal(asked, 1)
  } finally {
    runner.capacity = capacity
    await reset()
  }
})

test('the metric lane takes a fresh result before every rescore, and the screens number it first', async () => {
  await reset()
  const c = competition()
  const rescores = [await scoredWithSlowAnswer(c, 60_000), await scoredWithSlowAnswer(c, 60_000)]
  const fresh = await scoredWithSlowAnswer(c, 60_000)
  // Two rescores, as rescoreCompetition leaves them: «queued», at the score stage.
  for (const s of rescores) {
    updateSubmission(s.id, { state: 'queued', stage: 'score' })
    enqueue({ submissionId: s.id, competitionId: c.id, entrantId: s.entrantId, kind: 'metric' })
  }
  // A notebook a machine just ran, its metric enqueued after the rescores: its submission still reads «running».
  updateSubmission(fresh.id, { state: 'running', stage: 'score' })
  enqueue({ submissionId: fresh.id, competitionId: c.id, entrantId: fresh.entrantId, kind: 'metric' })
  assert.equal(nextQueueRow(Date.now(), undefined, 'metric')?.submissionId, fresh.id)
  const waiting = queueRows().filter((row) => row.state === 'waiting')
  assert.deepEqual(scoreOrder(waiting, new Map(), (row) => row.submissionId === fresh.id)[0].submissionId, fresh.id)
  const forecast = queueForecast(1, Date.now(), null, { homeNotebooks: true, scoreSlots: 1 })
  assert.equal(forecast.at.get(fresh.id)?.place, 1)
  assert.equal(forecast.at.get(fresh.id)?.startMs, 0)
  assert.ok(rescores.every((s) => (forecast.at.get(s.id)?.startMs ?? 0) > 0), 'the rescores start after it')
  // One place: the pump takes the fresh one.
  saveCompetitionSettings({ scoreSlots: 1 })
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(fresh.id)?.state, 'running')
  await reset()
})

test('the forecast runs a metric in its own lane: a rescore starts now beside a notebook that waits for the slot', async () => {
  await reset()
  const c = competition()
  const rescore = await scoredWithSlowAnswer(c, 60_000)
  const running = send(c, person('Идёт'), HOLD)
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(running.id)?.state, 'running')
  const next = send(c, person('Следующий'), HOLD)
  assert.equal(rescoreCompetition(c.id), 1)
  const forecast = queueForecast(1, Date.now(), null, { homeNotebooks: true, scoreSlots: 2 })
  assert.equal(forecast.at.get(rescore.id)?.startMs, 0, 'the metric lane is free')
  assert.ok((forecast.at.get(next.id)?.startMs ?? 0) > 0, 'the notebook waits for the one slot')
  assert.deepEqual(forecast.eligible.map((row) => row.submissionId), [rescore.id, next.id])
  await reset()
})

/* ------------------------------------------------------------- the settings */

test('the machines\' settings: their defaults, their bounds, a switch that is a switch', async () => {
  await reset()
  assert.deepEqual(runnerSettings(), {
    homeNotebooks: { value: true, source: 'default' },
    scoreSlots: { value: 2, source: 'default' },
    runnerBlobMBps: { value: REMOTE_BLOB_MBPS.default, source: 'default' },
    runnerUploads: { value: REMOTE_UPLOADS.default, source: 'default' },
  })
  assert.deepEqual(SETTINGS_LIMITS.scoreSlots, { min: 1, max: 8, default: 2 })
  assert.equal(SETTINGS_LIMITS.runnerUploads, REMOTE_UPLOADS)
  assert.equal(SETTINGS_LIMITS.runnerBlobMBps, REMOTE_BLOB_MBPS)
  const machine = { cpus: 8, memoryMb: 16_384, reserveMb: 1024 }
  assert.deepEqual(parseSettingsInput({ homeNotebooks: false, scoreSlots: 4, runnerBlobMBps: 20, runnerUploads: 2 }, machine),
    { patch: { homeNotebooks: false, scoreSlots: 4, runnerBlobMBps: 20, runnerUploads: 2 } })
  assert.deepEqual(parseSettingsInput({ homeNotebooks: null, scoreSlots: '', runnerBlobMBps: null, runnerUploads: '' }, machine),
    { patch: { ...MACHINE_SETTINGS } })
  // "false" as a string is the form that would stop this server's notebooks by accident.
  assert.deepEqual(parseSettingsInput({ homeNotebooks: 'false' }, machine), { refusal: { field: 'homeNotebooks', why: 'value' } })
  assert.deepEqual(parseSettingsInput({ homeNotebooks: 0 }, machine), { refusal: { field: 'homeNotebooks', why: 'value' } })
  assert.deepEqual(parseSettingsInput({ scoreSlots: 0 }, machine), { refusal: { field: 'scoreSlots', why: 'range', min: 1, max: 8 } })
  assert.deepEqual(parseSettingsInput({ scoreSlots: 9 }, machine), { refusal: { field: 'scoreSlots', why: 'range', min: 1, max: 8 } })
  assert.deepEqual(parseSettingsInput({ runnerUploads: 9 }, machine), { refusal: { field: 'runnerUploads', why: 'range', min: 1, max: 8 } })
  assert.deepEqual(parseSettingsInput({ runnerBlobMBps: 0 }, machine), { refusal: { field: 'runnerBlobMBps', why: 'range', min: 1, max: 1000 } })
  assert.deepEqual(parseSettingsInput({ runnerBlobMBps: 'fast' }, machine), { refusal: { field: 'runnerBlobMBps', why: 'value' } })
  saveCompetitionSettings({ homeNotebooks: false, scoreSlots: 5, runnerBlobMBps: 40, runnerUploads: 3 })
  assert.deepEqual(runnerSettings(), {
    homeNotebooks: { value: false, source: 'saved' },
    scoreSlots: { value: 5, source: 'saved' },
    runnerBlobMBps: { value: 40, source: 'saved' },
    runnerUploads: { value: 3, source: 'saved' },
  })
  // Forgotten, the defaults answer again.
  saveCompetitionSettings({ ...MACHINE_SETTINGS })
  assert.equal(runnerSettings().homeNotebooks.source, 'default')
  assert.equal(runnerSettings().scoreSlots.value, 2)
  await reset()
})
