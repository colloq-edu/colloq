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
  HELD_LEASE_STATES,
  acceptSubmission,
  continueQueueAsMetric,
  createCompetition,
  createEntrant,
  deferResourceAttempt,
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
import { LIVE_LEASE_STATES } from '../server/src/competitions/remote/store.js'
import { competitionsFs, putOpenFile, putSecretFile, putSubmissionNotebook, resultDir, SUBMISSION_FILE } from '../server/src/competitions/storage.js'
import { SOLUTION_NAME } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { CompetitionResourcePending } from '../server/src/competitions/broker-runner.js'
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
  /** Submissions whose next metric Pod the cluster cannot place (CompetitionResourcePending), once each. */
  readonly unplaced = new Set<string>()

  override async score(request: ScoreRequest) {
    if (this.unplaced.delete(request.submissionId)) throw new CompetitionResourcePending('memory', 'metric')
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

/**
 * The machine's lease behind a row it holds (remote_leases), in `state`, as
 * the take for a machine writes it: what tells a restart here that the run is
 * still the machine's (store.ts · orphanedRuns).
 */
function leaseFor(row: QueueRow, state: string): void {
  db.prepare(`INSERT INTO remote_leases (attempt_id, runner_id, competition_id, submission_id, run_id, state, seq, sealed, provenance, manifest, container, offered_at, deadline_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, '{}', '{}', 'colloq-comp-lease-run', ?, ?)`)
    .run(row.attemptId, row.holder, row.competitionId, row.submissionId, randomUUID(), state, Date.now(), Date.now() + 3_600_000)
}

/**
 * A notebook a machine ran, turned into this server's metric work the way an
 * applied outcome turns it (store.ts · continueQueueAsMetric): a fresh result.
 */
function freshFromMachine(s: Submission): QueueRow {
  enqueue({ submissionId: s.id, competitionId: s.competitionId, entrantId: s.entrantId, kind: 'notebook' })
  assert.equal(continueQueueAsMetric(holdOnMachine(s.id), { durationMs: 4200, cellsDone: 1, cellsTotal: 1 }), 'metric')
  const row = queueRow(s.id)!
  assert.deepEqual([row.state, row.kind, row.fresh], ['waiting', 'metric', true])
  return row
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Stop a notebook this server runs, and wait until its memory is free. */
async function stop(s: Submission): Promise<void> {
  assert.equal(await cancelSubmission(s.id, 'teacher'), true)
  assert.equal(await settleSubmission(s.id, 10_000), true)
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
  // Both taken by the previous life of this server; one of them by a machine, whose lease is live.
  const previousLife = randomUUID()
  const thisLife = randomUUID()
  const held = holdOnMachine(there.id, { boot: previousLife })
  leaseFor(held, 'running')
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
  const held = holdOnMachine(sent.id)
  db.prepare('UPDATE competition_queue SET lost = 2 WHERE submission_id = ?').run(sent.id)
  // Lost by the machine: back to waiting, holder gone, the losses kept for the next loss.
  assert.equal(requeue(sent.id, held.attemptId!, true), true)
  assert.equal(queueRow(sent.id)?.holder, null)
  assert.equal(queueRow(sent.id)?.lost, 2)
  // A rerun or a rescore is new work: its losses start at zero.
  enqueue({ submissionId: sent.id, competitionId: c.id, entrantId: sent.entrantId, kind: 'notebook' })
  assert.equal(queueRow(sent.id)?.lost, 0)
  await reset()
})

test('a give-back is fenced on its attempt: one that comes late changes nothing, and a run that never started is refunded', async () => {
  await reset()
  const c = competition()
  const sent = send(c, person('Поздно'))
  const offered = holdOnMachine(sent.id)
  assert.equal(queueRow(sent.id)?.attempts, 1)
  // Withdrawn before any container started: back to waiting, the take refunded.
  assert.equal(requeue(sent.id, offered.attemptId!, false), true)
  assert.deepEqual([queueRow(sent.id)?.state, queueRow(sent.id)?.attempts, queueRow(sent.id)?.holder], ['waiting', 0, null])
  // Taken again here; the machine's give-back of its old attempt arrives after that.
  const again = takeNext({ boot: BOOT, slots: 8, lane: 'notebook' })!
  assert.equal(again.submissionId, sent.id)
  assert.equal(requeue(sent.id, offered.attemptId!, false), false, 'another attempt runs now: nothing changes')
  assert.deepEqual([queueRow(sent.id)?.state, queueRow(sent.id)?.attemptId, queueRow(sent.id)?.attempts], ['running', again.attemptId, 1])
  // Given back after its container started: the attempt stays counted toward the restarts.
  assert.equal(requeue(sent.id, again.attemptId!, true), true)
  assert.deepEqual([queueRow(sent.id)?.state, queueRow(sent.id)?.attempts], ['waiting', 1])
  // A waiting row is no run to give back.
  assert.equal(requeue(sent.id, again.attemptId!, true), false)
  await reset()
})

test("a machine's row with no live lease is this server's orphan at a restart, and goes back with no penalty", async () => {
  await reset()
  const c = competition()
  const previousLife = randomUUID()
  const thisLife = randomUUID()
  // Its lease is over, yet the row still names the machine: a rollback past the leases, or a hand in the database.
  const over = send(c, person('ЛизЗакончен'))
  leaseFor(holdOnMachine(over.id, { boot: previousLife }), 'lost')
  // Carried through 0.22, which ran it itself under an attempt no lease has and kept the holder it does not know.
  const carried = send(c, person('Через022'))
  holdOnMachine(carried.id, { boot: previousLife })
  db.prepare('UPDATE competition_queue SET attempts = 2, attempt_id = ? WHERE submission_id = ?').run(randomUUID().replaceAll('-', ''), carried.id)
  // A lease that is live, in any of its live states, keeps its row the machine's.
  const live = LIVE_LEASE_STATES.map((state) => {
    const sent = send(c, person(`Лиз ${state}`))
    leaseFor(holdOnMachine(sent.id, { boot: previousLife }), state)
    return sent
  })
  assert.deepEqual(orphanedRuns(thisLife).map((row) => row.submissionId).sort(), [over.id, carried.id].sort())
  const { requeued, abandoned } = reclaimQueue(thisLife)
  assert.deepEqual(requeued.map((row) => row.submissionId).sort(), [over.id, carried.id].sort())
  assert.deepEqual(abandoned, [], 'never given up: no restart of this server cut them off, whatever their attempts')
  for (const id of [over.id, carried.id]) {
    const row = queueRow(id)!
    assert.deepEqual([row.state, row.holder, row.attemptId, row.lost], ['waiting', null, null, 0], id)
  }
  assert.equal(queueRow(over.id)?.attempts, 0, "the machine's take is refunded")
  assert.equal(queueRow(carried.id)?.attempts, 1)
  for (const sent of live) assert.deepEqual([queueRow(sent.id)?.state, queueRow(sent.id)?.holder], ['running', MACHINE])
  for (const sent of live) leaveQueue(sent.id)
  await reset()
})

test('on a database without the leases every row a machine holds is an orphan of a restart', async () => {
  await reset()
  const c = competition()
  const sent = send(c, person('БезТаблицы'))
  leaseFor(holdOnMachine(sent.id, { boot: randomUUID() }), 'running')
  assert.deepEqual(orphanedRuns(randomUUID()), [], 'a live lease: the machine\'s')
  // As a release without the machines' tables reads it: the leases are not there to ask.
  db.exec('ALTER TABLE remote_leases RENAME TO remote_leases_away')
  try {
    assert.deepEqual(orphanedRuns(randomUUID()).map((row) => row.submissionId), [sent.id])
  } finally {
    db.exec('ALTER TABLE remote_leases_away RENAME TO remote_leases')
  }
  assert.deepEqual(orphanedRuns(randomUUID()), [])
  leaveQueue(sent.id)
  await reset()
})

test('the queue\'s live lease states are the machines\' own', () => {
  assert.deepEqual([...HELD_LEASE_STATES], [...LIVE_LEASE_STATES])
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
  // A submission that merely reads «running» is no fresh result: the queue row says what it is.
  updateSubmission(rescores[0].id, { state: 'running', stage: 'score' })
  await sleep(5)
  // A notebook a machine just ran, its metric enqueued after the rescores.
  freshFromMachine(fresh)
  assert.equal(nextQueueRow(Date.now(), undefined, 'metric')?.submissionId, fresh.id)
  const waiting = queueRows().filter((row) => row.state === 'waiting')
  const order = scoreOrder(waiting, new Map(), (row) => row.fresh).map((row) => row.submissionId)
  assert.equal(order[0], fresh.id)
  assert.deepEqual(order.slice(1).sort(), rescores.map((s) => s.id).sort())
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

/* ------------------------------------------- one memory for both lanes */

test('memory a notebook frees goes to waiting metric work first: a rescore does not wait for the notebook backlog', async () => {
  await reset()
  setQueueSlots(2)
  // A notebook here reserves 256 + 4096 MB; a metric 256 + 2048.
  const c = competition()
  const rescore = await scoredWithSlowAnswer(c, 60_000)
  // Two notebooks fit, with no metric beside both: memory is the limit, not the places.
  runner.availableMb = 9000
  const first = send(c, person('Н1'), HOLD)
  const second = send(c, person('Н2'), HOLD)
  assert.equal(await pumpOnce(), 2)
  assert.equal(rescoreCompetition(c.id), 1)
  await sleep(5)
  const backlog = send(c, person('Н3'), HOLD)
  assert.equal(await pumpOnce(), 0, 'no room for either')
  // A notebook ends: room for the metric or for the next notebook, not both.
  await stop(first)
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(rescore.id)?.state, 'running', 'the rescore took the freed memory')
  assert.equal(queueRow(backlog.id)?.state, 'waiting', 'the next notebook waits for the next one to end')
  // Bounded: the metric lane holds no more than its own places, and the notebook takes the next notebook's memory.
  await stop(second)
  assert.equal(await pumpOnce(), 1)
  assert.equal(queueRow(backlog.id)?.state, 'running')
  await reset()
})

test('the screens number a metric and a notebook that start at one moment as a pass takes them: the metric first', async () => {
  await reset()
  const c = competition()
  const rescore = await scoredWithSlowAnswer(c, 60_000)
  const notebook = send(c, person('Вместе'), HOLD)
  assert.equal(rescoreCompetition(c.id), 1)
  const forecast = queueForecast(1, Date.now(), null, { homeNotebooks: true, scoreSlots: 1 })
  assert.deepEqual([forecast.at.get(rescore.id)?.startMs, forecast.at.get(notebook.id)?.startMs], [0, 0])
  assert.deepEqual([forecast.at.get(rescore.id)?.place, forecast.at.get(notebook.id)?.place], [1, 2])
  await reset()
})

/* -------------------------------------------- a fresh result stays fresh */

test('a fresh result whose metric a restart here cut off stays ahead of the rescores, and its participant still reads it running', async () => {
  await reset()
  const c = competition()
  const rescores = [await scoredWithSlowAnswer(c, 60_000), await scoredWithSlowAnswer(c, 60_000)]
  const fresh = await scoredWithSlowAnswer(c, 60_000)
  assert.equal(rescoreCompetition(c.id), 3)
  await sleep(5)
  freshFromMachine(fresh)
  // The metric lane takes it first, and the previous life of this server runs it when it goes down.
  const taken = takeNext({ boot: randomUUID(), slots: 2, lane: 'metric' })!
  assert.equal(taken.submissionId, fresh.id)
  updateSubmission(fresh.id, { state: 'running', stage: 'score' })
  assert.equal((await reclaimCompetitionQueue()).requeued, 1)
  assert.deepEqual([queueRow(fresh.id)?.state, queueRow(fresh.id)?.fresh], ['waiting', true])
  assert.deepEqual([getSubmission(fresh.id)?.state, getSubmission(fresh.id)?.stage], ['running', 'score'])
  assert.equal(nextQueueRow(Date.now(), undefined, 'metric')?.submissionId, fresh.id)
  const forecast = queueForecast(1, Date.now(), null, { homeNotebooks: true, scoreSlots: 1 })
  assert.equal(forecast.at.get(fresh.id)?.place, 1)
  assert.ok(rescores.every((s) => (forecast.at.get(s.id)?.place ?? 0) > 1))
  await reset()
})

test('a fresh result whose metric is put off keeps its place and its «running»; a rescore put off waits as queued', async () => {
  await reset()
  const c = competition()
  const rescore = await scoredWithSlowAnswer(c, 60_000)
  const fresh = await scoredWithSlowAnswer(c, 60_000)
  assert.equal(rescoreCompetition(c.id), 2)
  freshFromMachine(fresh)
  // The cluster could not place either metric's Pod.
  for (const id of [fresh.id, rescore.id]) {
    const taken = takeNext({ boot: BOOT, slots: 2, lane: 'metric' })!
    assert.equal(taken.submissionId, id)
    updateSubmission(id, { state: 'running', stage: 'score' })
    assert.notEqual(deferResourceAttempt(taken, 'later'), null)
  }
  assert.deepEqual([queueRow(fresh.id)?.state, queueRow(fresh.id)?.kind, queueRow(fresh.id)?.fresh], ['waiting', 'metric', true])
  assert.deepEqual([getSubmission(fresh.id)?.state, getSubmission(fresh.id)?.stage], ['running', 'score'])
  assert.deepEqual([queueRow(rescore.id)?.fresh, getSubmission(rescore.id)?.state, getSubmission(rescore.id)?.stage], [false, 'queued', 'queue'])
  // A notebook of ours that ran, whose metric could not start: its result is as fresh as a machine's.
  const ours = send(c, person('НашМетрика'))
  const run = takeNext({ boot: BOOT, slots: 8, lane: 'notebook' })!
  assert.equal(run.submissionId, ours.id)
  updateSubmission(ours.id, { state: 'running', stage: 'score' })
  assert.notEqual(deferResourceAttempt(run, 'later', Date.now(), 'later', 'metric'), null)
  assert.deepEqual([queueRow(ours.id)?.kind, queueRow(ours.id)?.fresh, getSubmission(ours.id)?.state], ['metric', true, 'running'])
  // The same notebook put off before its metric is no result at all.
  enqueue({ submissionId: ours.id, competitionId: c.id, entrantId: ours.entrantId, kind: 'notebook' })
  assert.equal(queueRow(ours.id)?.fresh, false, 'new work is no fresh result')
  const again = takeNext({ boot: BOOT, slots: 8, lane: 'notebook' })!
  assert.notEqual(deferResourceAttempt(again, 'later'), null)
  assert.deepEqual([queueRow(ours.id)?.kind, queueRow(ours.id)?.fresh, getSubmission(ours.id)?.state], ['notebook', false, 'queued'])
  await reset()
})

test("a notebook that ran here, only its metric put off, keeps what it did, and its score counts the notebook's time", async () => {
  await reset()
  const c = competition()
  const sent = send(c, person('ОтложенаМетрика'), '# colloq-test: {"hold": 30}\nx = 1')
  runner.unplaced.add(sent.id)
  assert.equal(await pumpOnce(), 1)
  await settleCompetitionWork()
  assert.deepEqual([queueRow(sent.id)?.state, queueRow(sent.id)?.kind, queueRow(sent.id)?.fresh], ['waiting', 'metric', true])
  const waiting = getSubmission(sent.id)!
  assert.deepEqual([waiting.state, waiting.stage, waiting.cellsDone, waiting.cellsTotal], ['running', 'score', 1, 1])
  const wall = waiting.durationMs ?? 0
  assert.ok(wall >= 30, `the notebook's wall stays: ${wall}`)
  // The cluster places the metric now.
  db.prepare('UPDATE competition_queue SET not_before = 0 WHERE submission_id = ?').run(sent.id)
  await drainCompetitionQueue()
  const scored = getSubmission(sent.id)!
  assert.equal(scored.state, 'scored')
  assert.deepEqual([scored.cellsDone, scored.cellsTotal], [1, 1])
  assert.ok((scored.durationMs ?? 0) >= wall, 'the notebook and the metric together')
  await reset()
})

test("'rescore all' leaves metric work already waiting where it is: a fresh result keeps its place and its «running»", async () => {
  await reset()
  const c = competition()
  const old = await scoredWithSlowAnswer(c, 60_000)
  const fresh = await scoredWithSlowAnswer(c, 60_000)
  freshFromMachine(fresh)
  const before = queueRow(fresh.id)!
  await sleep(5)
  assert.equal(rescoreCompetition(c.id), 2, 'both count as queued')
  const after = queueRow(fresh.id)!
  assert.deepEqual([after.enqueuedAt, after.turn, after.kind, after.fresh], [before.enqueuedAt, before.turn, 'metric', true])
  assert.deepEqual([getSubmission(fresh.id)?.state, getSubmission(fresh.id)?.stage], ['running', 'score'])
  assert.equal(nextQueueRow(Date.now(), undefined, 'metric')?.submissionId, fresh.id)
  // A rescore waiting already is left where it is too: it will score with the metric in force when it starts.
  const waiting = queueRow(old.id)!
  await sleep(5)
  assert.equal(rescoreCompetition(c.id), 2)
  assert.equal(queueRow(old.id)?.enqueuedAt, waiting.enqueuedAt)
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
