/**
 * The two halves of «машины для посылок» together, for real
 * (docs/architecture/remote-runners.md §2, §3, §10.1): the home app of this
 * process (tests/_remote-e2e-home.mts) and the agent of a machine as a process
 * of its own (tests/_remote-e2e-agent.mts), talking over loopback HTTP, the
 * agent's Docker a fake at the process boundary (tests/_remote-e2e-docker.mjs)
 * under the unchanged DockerCompetitionRunner.
 *
 * Each half has tests of its own against a stand-in of the other
 * (tests/_remote.mts, tests/_runner-agent-home.mts). Those prove each half
 * keeps the contract as its author read it; this proves the two readings
 * meet: a submission sent through the participant's door is leased to a real
 * agent, run by the real runner, uploaded, applied, scored by this server's
 * metric lane and shown to the participant — and so are the ways it can go
 * wrong on the way. Every scenario asserts what the participant and the owner
 * see, through their own doors, and what the database holds.
 *
 * Each scenario has machines of its own, joined with codes the owner mints,
 * and a competition of its own; when it is done (or fails) the owner
 * disconnects its machines — an agent revoked hears 401 and exits by itself —
 * and the competition ends, so the next scenario's machines are not asked to
 * prepare it. Nothing waits on a production timeout: the runs end on a gate
 * the test opens (the fake docker's `gate` directive) or at once, and the one
 * wall a scenario needs is its competition's own three seconds.
 */
import './_remote-e2e-home.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { CompetitionLive, QueueSnapshot } from '../shared/competitions-api.js'
import type { RemoteMachinesResponse } from '../shared/remote-admin.js'
import { isTerminal } from '../shared/competitions.js'
import { tr } from '../shared/i18n.js'
import { getSubmission, listRuns, queueRow, setCompetitionState } from '../server/src/competitions/store.js'
import { resultDir, SUBMISSION_FILE, EXECUTED_FILE, competitionsFs } from '../server/src/competitions/storage.js'
import { db } from '../server/src/db.js'
import { stableScore } from '../server/src/competitions/fake-runner.js'
import { applyCounts } from '../server/src/competitions/remote/apply.js'
import { forgetStock } from '../server/src/competitions/remote/want.js'
import { useHomeRunnerBuild } from '../server/src/competitions/remote/store.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { REMOTE_BLOB_MBPS, parseRemoteAuthorization } from '../shared/remote-runner.js'
import { Agent, createFleet, killAgents, openGate, type Fleet } from './_remote-e2e-agent.mts'
import { Entrant, HIDDEN, Home, competition, homeNotebooks, homeRunner, notebook, quietQueue, sha256, sleep, until, type E2eCompetition } from './_remote-e2e-home.mts'

const home = new Home()
let fleet: Fleet

before(async () => {
  fleet = createFleet()
  await home.start()
})

after(async () => {
  await killAgents()
  await home.close()
  // Kept with the machines' trees (COLLOQ_E2E_KEEP=1): every request home took, for a look after a red run.
  if (process.env.COLLOQ_E2E_KEEP) fs.writeFileSync(path.join(fleet.root, 'home-requests.json'), JSON.stringify(home.requests, null, 1))
})

/* ------------------------------------------------------------- the database */

interface LeaseLine {
  attemptId: string
  runnerId: string
  submissionId: string
  state: string
  cause: string | null
  reason: string | null
  offeredAt: number
  acceptedAt: number | null
  startedAt: number | null
  endedAt: number | null
}

const LEASE_COLUMNS = `attempt_id AS attemptId, runner_id AS runnerId, submission_id AS submissionId, state, cause, reason,
  offered_at AS offeredAt, accepted_at AS acceptedAt, started_at AS startedAt, ended_at AS endedAt`

function leasesOf(submissionId: string): LeaseLine[] {
  return db.prepare(`SELECT ${LEASE_COLUMNS} FROM remote_leases WHERE submission_id = ? ORDER BY offered_at, seq`).all(submissionId) as LeaseLine[]
}

function leasesOfRunner(runnerId: string): LeaseLine[] {
  return db.prepare(`SELECT ${LEASE_COLUMNS} FROM remote_leases WHERE runner_id = ? ORDER BY offered_at, seq`).all(runnerId) as LeaseLine[]
}

function eventsOf(runnerId: string): Array<{ kind: string; attemptId: string | null; detail: string | null }> {
  return db.prepare('SELECT kind, attempt_id AS attemptId, detail FROM remote_events WHERE runner_id = ? ORDER BY id').all(runnerId) as Array<{ kind: string; attemptId: string | null; detail: string | null }>
}

function runsOf(submissionId: string): Array<[string, string | null]> {
  return listRuns(submissionId).map((run) => [run.kind, run.verdict])
}

/* ------------------------------------------------------- the owner's doors */

/** The owner's view of one machine (GET /api/admin/runners). */
async function machineRow(agent: Agent) {
  const list = await home.admin<RemoteMachinesResponse>('GET', '/api/admin/runners')
  return list.body.machines.find((one) => one.id === agent.identity()?.runnerId) ?? null
}

/** The owner's list says what the machine makes of a competition («берёт», «нужна доверенная», «устарела»…). */
async function readyFor(agent: Agent, c: E2eCompetition, verdict = 'taking'): Promise<void> {
  await until(`${agent.name} to be ${verdict} for ${c.slug}`, async () => {
    const mine = await machineRow(agent)
    return mine?.readiness.find((entry) => entry.competitionId === c.id)?.verdict === verdict
  }, 20_000, () => agent.log())
}

/** The console's word for a waiting row (GET /api/admin/competitions/:id/live). */
async function waitingRow(c: E2eCompetition, submissionId: string) {
  const live = (await home.admin<CompetitionLive>('GET', `/api/admin/competitions/${c.id}/live`)).body
  return live.waiting.find((one) => one.submissionId === submissionId) ?? null
}

/* ------------------------------------------------------ the participant's */

/** The submission as its author sees it once it has ended, whatever the ending. */
async function settled(entrant: Entrant, id: string, timeoutMs = 20_000) {
  return until(`submission ${id} to end`, async () => {
    const seen = await entrant.submission(id)
    return isTerminal(seen.state) ? seen : null
  }, timeoutMs)
}

async function scored(entrant: Entrant, id: string, timeoutMs = 20_000) {
  const seen = await settled(entrant, id, timeoutMs)
  assert.equal(seen.state, 'scored', `submission ${id} ended ${seen.state}: ${seen.participantError ?? ''} / ${getSubmission(id)?.teacherError ?? ''}`)
  return seen
}

/** What a participant reads of an ended submission, field by field, and what the teacher reads of it. */
function words(id: string, seen: Awaited<ReturnType<Entrant['submission']>>) {
  const row = getSubmission(id)!
  return {
    participant: { state: seen.state, stage: seen.stage, participantError: seen.participantError, cellsDone: seen.cellsDone, cellsTotal: seen.cellsTotal, publicScore: seen.publicScore },
    errorType: row.errorType ?? null,
    teacherError: row.teacherError,
  }
}

/** A lease of the submission the machine has started (its sync said `running`). */
async function runningLease(agent: Agent, submissionId: string): Promise<LeaseLine> {
  return until(`the run of ${submissionId} to start on ${agent.name}`, () => leasesOf(submissionId).find((lease) => lease.state === 'running' && lease.startedAt !== null), 20_000, () => agent.log())
}

/* --------------------------------------------------------------- a scenario */

/** What one scenario made, ended with it whatever happens to it. */
class Scene {
  private readonly agents: Agent[] = []
  private readonly competitions: E2eCompetition[] = []

  competition(options: Parameters<typeof competition>[1] = {}): E2eCompetition {
    const made = competition(fleet, options)
    this.competitions.push(made)
    return made
  }

  /** A machine joined with a code the owner minted, its agent running, the competitions' image and data in place there. */
  async machine(name: string, ready: E2eCompetition[], options: { trusted?: boolean; approvedSlots?: number | null; build?: string } = {}): Promise<Agent> {
    const code = await home.mintCode({ trusted: options.trusted, approvedSlots: options.approvedSlots })
    const agent = new Agent(fleet, name, { join: home.joinTarget(code), build: options.build })
    this.agents.push(agent)
    agent.start()
    await until(`${name} to join`, () => agent.identity()?.runnerId, 20_000, () => agent.log())
    for (const c of ready) await readyFor(agent, c)
    return agent
  }

  /**
   * The owner disconnects the machines: each agent hears 401 and exits by
   * itself, with 0 (asserted when the scenario passed; killed regardless). The
   * competitions end, so no machine of a later scenario prepares them.
   */
  async end(passed: boolean): Promise<void> {
    if (!home.up) await home.restart()
    for (const agent of this.agents) {
      const id = agent.identity()?.runnerId
      if (id) await home.admin('POST', `/api/admin/runners/${id}/revoke`).catch(() => undefined)
    }
    for (const agent of this.agents) {
      if (!agent.running) continue
      const exit = await agent.exit(15_000)
      if (passed) assert.equal(exit.code, 0, `${agent.name} stops by itself once disconnected:\n${agent.log()}`)
    }
    for (const c of this.competitions) setCompetitionState(c.id, 'finished')
    forgetStock()
    quietQueue()
  }
}

/**
 * One scenario: its own machines and competition, ended whatever happens. A
 * `defect` names a product defect the scenario shows and that is not fixed
 * yet: the scenario still runs, and node:test reports it as a TODO rather than
 * a failure, until the fix lands and the flag goes.
 */
function scenario(name: string, timeoutMs: number, body: (scene: Scene) => Promise<void>, defect?: string): void {
  test(name, { timeout: timeoutMs, ...(defect ? { todo: defect } : {}) }, async () => {
    if (!home.up) await home.restart()
    quietQueue()
    const scene = new Scene()
    let passed = false
    try {
      await body(scene)
      passed = true
    } finally {
      await scene.end(passed)
    }
  })
}

/* ---------------------------------------------------------------- scenarios */

scenario('a CPU submission runs on a machine — shown under it in the console while it runs — and is scored by this server\'s metric', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 3 })
  const agent = await scene.machine('cpu', [c])
  const runnerId = agent.runnerId
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook({ gate: 'cpu-1' }, 3))

  // Running on the machine: the console's grid has it under the machine, the participant sees it running.
  const running = await until('the run to show on the machine in the console', async () => {
    const queue = (await home.admin<QueueSnapshot>('GET', '/api/admin/competitions/queue')).body
    const run = queue.running.find((one) => one.submissionId === sent.id)
    return run?.remotePhase === 'running' ? { run, queue } : null
  }, 20_000, () => agent.log())
  assert.equal(running.run.machine?.id, runnerId, 'the run is the machine\'s')
  assert.equal(running.queue.groups?.[0]?.machineId, null, 'this server\'s group comes first')
  assert.equal(running.queue.groups?.find((one) => one.machineId === runnerId)?.busy, 1, 'the machine\'s group counts the run')
  const live = await entrant.submissions()
  assert.equal(live.submissions.find((one) => one.id === sent.id)?.state, 'running')
  assert.ok(live.live.find((one) => one.submissionId === sent.id)?.startedAt, 'the participant\'s clock runs from the container\'s start')
  assert.equal(agent.containers().length, 1, 'one container on the machine')
  const status = agent.status()!
  assert.deepEqual([status.joined, status.state, status.compatible, status.trusted, status.held], [true, 'active', true, false, 1], 'the machine\'s own status says it works for its home')
  // Its progress reaches the participant within a busy sync's hold (REMOTE_HOLD_BUSY_MS): the fake notebook sits in its last cell.
  await until('the machine\'s progress to reach the participant', async () => {
    const seen = await entrant.submission(sent.id)
    return seen.stage === 'notebook' && seen.cellsTotal === 3 && seen.cellsDone === 3
  }, 15_000, () => agent.log())

  const gateAt = Date.now()
  openGate(fleet, 'cpu-1')
  const done = await scored(entrant, sent.id)
  assert.equal(done.participantError, null)
  assert.deepEqual([done.cellsDone, done.cellsTotal], [3, 3])
  assert.equal(typeof done.publicScore, 'number')
  assert.equal(done.notebook, 'executed', 'the participant downloads the executed notebook')
  const leaseStart = leasesOf(sent.id)[0]!.startedAt!
  assert.ok(done.durationMs! >= gateAt - leaseStart - 1500 && done.durationMs! <= Date.now() - leaseStart + 1000, `the run time is the notebook's on the machine and the metric's here: ${done.durationMs} ms`)

  // The metric ran here, on the answer the machine sent: the stand-in's score of exactly those bytes.
  const answer = competitionsFs.readFileSync(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE)) as Buffer
  assert.ok(answer.toString('utf8').includes('# colloq-run: '), 'the machine\'s answer is the one kept')
  assert.equal(done.publicScore, stableScore(`${sha256(answer)}:public`, 0.5, 1))
  assert.ok(competitionsFs.existsSync(path.join(resultDir(c.id, sent.id), EXECUTED_FILE)), 'the executed notebook came back')
  assert.deepEqual(runsOf(sent.id), [['notebook', 'ok'], ['metric', 'ok']])
  const leases = leasesOf(sent.id)
  assert.deepEqual(leases.map((lease) => [lease.runnerId, lease.state]), [[runnerId, 'applied']])
  assert.equal(queueRow(sent.id), null)

  // The machine fetched the open data and nothing else: no answer key, no metric ever leaves home.
  const blobs = home.requestsOf(runnerId).filter((one) => one.path.includes('/blobs/')).map((one) => one.path.split('/').pop())
  assert.deepEqual(new Set(blobs), new Set(Object.values(c.open)))
  assert.ok(!blobs.includes(c.solutionSha))

  // And it cleaned up: no container, no lease file, no attempt tree.
  await until('the machine to clean up', () => agent.containers().length === 0 && agent.leaseFiles().length === 0 && !agent.holdsAttemptTree(c.id, sent.id, leases[0]!.attemptId), 10_000, () => agent.log())
  assert.equal(agent.sandboxRuns().length, 1)
  assert.equal((await entrant.submissions()).leftToday, 2, 'one score, one of the day spent')
})

scenario('a failed notebook and a timed-out one read on a machine exactly as they read when this server runs them', 90_000, async (scene) => {
  const c = scene.competition({ wallSeconds: 3, perDay: 3 })
  const failing = notebook({ status: 'cell_error', cell: 1, detail: 'Traceback (most recent call last):\n  Cell In[2], line 1\n    1 / 0\nZeroDivisionError: division by zero' }, 3)
  // Never ends by itself: here the stand-in says `timeout`, on the machine the runner's own wall kills it at three seconds.
  const endless = notebook({ status: 'timeout', cell: 1 }, 3)

  // This server runs them, with no machine connected.
  homeNotebooks(true)
  const hereFail = await new Entrant(home, c).join()
  const hereSlow = await new Entrant(home, c).join()
  const hf = await hereFail.submit(failing)
  const hs = await hereSlow.submit(endless)
  const here = { fail: words(hf.id, await settled(hereFail, hf.id)), slow: words(hs.id, await settled(hereSlow, hs.id)) }
  assert.equal(here.fail.participant.state, 'notebookFailed')
  assert.equal(here.slow.participant.state, 'timedOut')
  assert.deepEqual(leasesOf(hf.id), [], 'this server ran it')
  homeNotebooks(false)

  // A machine runs the same two notebooks.
  const agent = await scene.machine('texts', [c])
  const thereFail = await new Entrant(home, c).join()
  const thereSlow = await new Entrant(home, c).join()
  const tf = await thereFail.submit(failing)
  const ts = await thereSlow.submit(endless)
  const there = { fail: words(tf.id, await settled(thereFail, tf.id)), slow: words(ts.id, await settled(thereSlow, ts.id, 30_000)) }
  for (const id of [tf.id, ts.id]) assert.deepEqual(leasesOf(id).map((lease) => [lease.runnerId, lease.state]), [[agent.runnerId, 'applied']], 'it ran on the machine')

  assert.deepEqual(there.fail.participant, here.fail.participant, 'the failed cell: the same state, stage, cells and words')
  assert.equal(there.fail.errorType, 'ZeroDivisionError')
  assert.equal(there.fail.errorType, here.fail.errorType)
  assert.equal(there.fail.teacherError, here.fail.teacherError, 'and the same for the teacher')
  assert.deepEqual(there.slow.participant, here.slow.participant, 'the timeout: the same state, stage, cells and words')
  assert.ok(there.slow.participant.participantError?.length, 'the timeout is explained')
  // The teacher's line names the runner's kill, which only a real wall gives (the stand-in here only says `timeout`).
  assert.equal(here.slow.teacherError, 'timeout · exit 137')
  assert.equal(there.slow.teacherError, 'timeout · exit 137 · killed by wall')
  assert.deepEqual(runsOf(tf.id), [['notebook', 'cell_error']], 'a failed notebook gets no metric row')
  assert.deepEqual(runsOf(ts.id), [['notebook', 'timeout']])
  assert.equal(agent.dockerCalls().filter((call) => call.args[0] === 'kill').length, 1, 'the runner\'s wall killed the endless notebook on the machine')

  // Failures are free, and each is the day's failed attempt, here and there alike.
  for (const entrant of [hereFail, hereSlow, thereFail, thereSlow]) {
    const mine = await entrant.submissions()
    assert.equal(mine.leftToday, 3)
    assert.equal(mine.failedAttempts?.used, 1)
  }
})

scenario('the hidden test is leased only to a trusted machine: an untrusted one is never offered it and never asks for its files', 60_000, async (scene) => {
  const c = scene.competition({ sealed: true, perDay: 3 })
  const hiddenSha = c.sealed['test.csv']!
  const untrusted = await scene.machine('untrusted', [])
  await readyFor(untrusted, c, 'needs_trusted')
  await until('the untrusted machine to hold the open data', async () => (await machineRow(untrusted))?.readiness.find((entry) => entry.competitionId === c.id)?.data.state === 'ready', 20_000, () => untrusted.log())
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook({ read: 'test.csv', gate: 'sealed-1' }, 2))

  // The upload wakes the untrusted machine's sync: it is offered nothing, and the console says why the row waits.
  await until('the console to say the row needs a trusted machine', async () => (await waitingRow(c, sent.id))?.reason === 'needs_trusted', 10_000)
  await sleep(1500)
  assert.deepEqual(leasesOf(sent.id), [], 'never leased to the untrusted machine')

  const trusted = await scene.machine('trusted', [c], { trusted: true })
  const lease = await runningLease(trusted, sent.id)
  assert.equal(lease.runnerId, trusted.runnerId)
  openGate(fleet, 'sealed-1')
  const done = await scored(entrant, sent.id)
  assert.equal(done.blind, true, 'a run on the hidden test is shown briefly')

  // The run read the hidden test: its answer carries the rows the notebook read from data/test.csv.
  const answer = (competitionsFs.readFileSync(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE)) as Buffer).toString('utf8')
  assert.ok(answer.includes(HIDDEN), 'the trusted machine ran it on the hidden test')

  // The hidden test's file: fetched by the trusted machine, never asked for by the other, not even refused.
  const asked = (agent: Agent) => home.requestsOf(agent.runnerId).filter((one) => one.path.endsWith(`/blobs/${hiddenSha}`))
  assert.ok(asked(trusted).length >= 1, 'the trusted machine fetched it')
  assert.deepEqual(asked(untrusted), [], 'the untrusted machine never asked for it')
  assert.deepEqual(untrusted.sealedBlobs(), [], 'nor holds any of it')
  assert.ok(eventsOf(trusted.runnerId).some((event) => event.kind === 'sealed_fetched'), 'the fetch is in the trusted machine\'s log')
  assert.ok(!eventsOf(untrusted.runnerId).some((event) => event.kind === 'sealed_fetched'))
  assert.deepEqual(leasesOfRunner(untrusted.runnerId), [], 'the untrusted machine held no lease at all')
})

scenario('a participant\'s cancel reaches the machine mid-run: its container is killed and removed, and no quota is spent', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const agent = await scene.machine('cancel', [c])
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook({ gate: 'never-opened' }, 2))
  const lease = await runningLease(agent, sent.id)
  const container = await until('the container to run on the machine', () => agent.containers().find((one) => one.attemptId === lease.attemptId), 10_000)
  assert.equal((await entrant.submissions()).leftToday, 1, 'a running submission holds a place of the day')

  const cancelledAt = Date.now()
  assert.equal(await entrant.cancel(sent.id), 200)
  assert.equal((await entrant.submission(sent.id)).state, 'cancelled', 'cancelled at once, whatever the machine is doing')

  // The machine hears it in the reply to its held sync: the container dies within about a round trip.
  await until('the container to be removed from the machine', () => !agent.containers().some((one) => one.name === container.name), 10_000, () => agent.log())
  const took = Date.now() - cancelledAt
  assert.ok(took < 5_000, `the kill reached the machine in ${took} ms`)
  const calls = agent.dockerCalls().filter((call) => call.at >= cancelledAt).map((call) => call.args.join(' '))
  assert.ok(calls.includes(`kill --signal=KILL ${container.name}`), 'the run was killed')
  assert.ok(calls.includes(`rm -f ${container.name}`), 'and its container removed')
  await until('the machine to drop the attempt', () => agent.leaseFiles().length === 0 && !agent.holdsAttemptTree(c.id, sent.id, lease.attemptId), 10_000, () => agent.log())

  const [revoked] = leasesOf(sent.id)
  assert.deepEqual([revoked!.state, revoked!.cause], ['revoked', 'cancelled'])
  assert.deepEqual(runsOf(sent.id), [['notebook', 'exit']])
  assert.equal(listRuns(sent.id)[0]!.teacherError, tr('competitions.answer.killedByEntrant'))
  assert.ok(!home.requestsOf(agent.runnerId).some((one) => one.path.includes(`/attempts/${lease.attemptId}/`)), 'nothing of the cancelled run was uploaded')
  const mine = await entrant.submissions()
  assert.equal(mine.leftToday, 2, 'a cancelled run spends nothing of the day')
  assert.equal(mine.failedAttempts?.used ?? 0, 0, 'and is no failed attempt')
  assert.equal(queueRow(sent.id), null)
})

scenario('a machine killed mid-run and started again: its lease is lost at once, the run goes back in its place, and is scored exactly once', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const agent = await scene.machine('crashy', [c])
  const runnerId = agent.runnerId
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook({ gate: 'crash-1' }, 2))
  const first = await runningLease(agent, sent.id)
  const enqueuedAt = queueRow(sent.id)!.enqueuedAt
  const leftover = await until('the container to run', () => agent.containers().find((one) => one.attemptId === first.attemptId), 10_000)

  await agent.kill()
  // A dead agent leaves its container running, as a daemon does; home has heard nothing yet.
  assert.ok(agent.containers().some((one) => one.name === leftover.name))
  assert.equal(leasesOf(sent.id)[0]!.state, 'running')

  const restartedAt = Date.now()
  agent.start()
  // Its first sync lists nothing: home loses the lease at once (§3.4 "Agent restart"), not after the silence.
  const lost = await until('the lease to be lost', () => leasesOf(sent.id).find((lease) => lease.attemptId === first.attemptId && lease.state === 'lost'), 15_000, () => agent.log())
  assert.equal(lost.cause, 'missing')
  assert.ok(lost.endedAt! - restartedAt < 10_000, `lost ${lost.endedAt! - restartedAt} ms after the restart`)
  const swept = agent.dockerCalls().find((call) => call.at >= restartedAt && call.args[0] === 'rm' && call.args.includes(leftover.id.slice(0, 12)))
  assert.ok(swept, 'the new life removed the container the old one left')
  assert.ok(agent.lines.some((line) => line.includes('1 lease(s) dropped')), agent.log())

  // Back in the queue in its place, with no penalty, and taken again.
  const second = await until('the run to be taken again', () => leasesOf(sent.id).find((lease) => lease.attemptId !== first.attemptId && lease.state === 'running'), 20_000, () => agent.log())
  assert.equal(second.runnerId, runnerId)
  assert.equal(queueRow(sent.id)!.enqueuedAt, enqueuedAt, 'it kept its place')
  assert.equal(queueRow(sent.id)!.lost, 1, 'one loss counted, after its container started')
  openGate(fleet, 'crash-1')
  const done = await scored(entrant, sent.id)
  assert.equal(done.participantError, null)

  assert.deepEqual(leasesOf(sent.id).map((lease) => lease.state), ['lost', 'applied'])
  assert.deepEqual(runsOf(sent.id), [['notebook', 'unknown'], ['notebook', 'ok'], ['metric', 'ok']], 'the lost run, the run, the metric: scored once')
  const machineName = (await machineRow(agent))!.name
  assert.ok(listRuns(sent.id)[0]!.teacherError?.includes(machineName), `the lost run names its machine: ${listRuns(sent.id)[0]!.teacherError}`)
  assert.equal((await entrant.submissions()).leftToday, 1, 'the loss spent nothing: one score, one of the day')
  assert.equal((await machineRow(agent))?.state, 'online', 'one restart is no quarantine')
  assert.equal(agent.containers().length, 0)
})

scenario('this server crashes while applying a machine\'s result and restarts on the same DATA_DIR: the result is driven again once, at boot, and scored once', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const agent = await scene.machine('restart', [c])
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook({ gate: 'restart-1' }, 2))
  const lease = await runningLease(agent, sent.id)

  /*
   * The crash, in the apply: the settle has finished the run row and published
   * the executed notebook, and the answer's promotion into out/ is where the
   * process dies (§3.6 "Re-drive after a crash"). Nothing of it is answered:
   * the port is closed and every connection cut under the machine's post.
   */
  const rename = competitionsFs.renameSync
  let crashed: Promise<void> | null = null
  competitionsFs.renameSync = ((from: string, to: string) => {
    if (!crashed && to === path.join(resultDir(c.id, sent.id), SUBMISSION_FILE)) {
      crashed = home.crash()
      throw Object.assign(new Error('the e2e home crashes here'), { code: 'EIO' })
    }
    return rename.call(competitionsFs, from, to)
  }) as typeof rename
  const redriven = applyCounts.redriven
  try {
    openGate(fleet, 'restart-1')
    await until('the home to crash while applying', () => crashed !== null, 20_000, () => agent.log())
    await crashed
  } finally {
    competitionsFs.renameSync = rename
  }
  assert.deepEqual(leasesOf(sent.id).map((one) => one.state), ['applying'], 'the crash left the result applying')
  assert.equal(listRuns(sent.id).find((run) => run.kind === 'notebook')?.verdict, 'ok', 'the first drive had settled the run')
  // The machine, cut off mid-post, keeps posting into the dark for a moment.
  await sleep(500)

  await home.restart()
  const done = await scored(entrant, sent.id)
  assert.equal(done.participantError, null)
  assert.equal(applyCounts.redriven - redriven, 1, 'driven again once, by the boot')
  assert.deepEqual(leasesOf(sent.id).map((one) => [one.attemptId, one.state]), [[lease.attemptId, 'applied']])
  assert.deepEqual(runsOf(sent.id), [['notebook', 'ok'], ['metric', 'ok']], 'one run row per step: the second drive settled nothing twice')
  assert.ok(competitionsFs.existsSync(path.join(resultDir(c.id, sent.id), EXECUTED_FILE)), 'the executed notebook the first drive published is still there')
  assert.ok(competitionsFs.existsSync(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE)), 'and the answer was promoted')
  // The machine's post, repeated through the outage, got the applied result: it ran the notebook once and cleaned up.
  await until('the machine to clean up', () => agent.leaseFiles().length === 0 && !agent.holdsAttemptTree(c.id, sent.id, lease.attemptId), 20_000, () => agent.log())
  assert.equal(agent.sandboxRuns().length, 1, 'the notebook ran once')
  assert.equal((await entrant.submissions()).leftToday, 1)
})

scenario('a machine whose image is gone declines the lease: the run comes back with nothing spent, the machine is not offered it again, and this server runs it', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const agent = await scene.machine('decliner', [c])
  const runnerId = agent.runnerId
  // An operator prunes the machine's images: the agent still has the revision written down as ready.
  agent.dropImage(`colloq-revision:${c.revisionId}`)
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook(null, 2))
  const enqueuedAt = queueRow(sent.id)!.enqueuedAt

  const declined = await until('the machine to decline the lease', () => leasesOf(sent.id).find((lease) => lease.state === 'declined'), 20_000, () => agent.log())
  assert.equal(declined.runnerId, runnerId)
  assert.equal(declined.cause, 'image')
  assert.equal(declined.startedAt, null, 'declined before any container')
  assert.equal(agent.sandboxRuns().length, 0)
  assert.deepEqual(runsOf(sent.id), [], 'the run row the take started is gone: nothing ran')
  const back = queueRow(sent.id)!
  assert.deepEqual([back.state, back.holder, back.enqueuedAt, back.lost], ['waiting', null, enqueuedAt, 0], 'waiting again, in its place, no loss')
  assert.equal((await entrant.submission(sent.id)).state, 'queued')

  // The machine pulls its image back into shape, and still is not offered this submission (the decline's skip).
  await until('the machine to have its image back', () => agent.hasImage(`colloq-revision:${c.revisionId}`), 20_000, () => agent.log())
  await readyFor(agent, c)
  await sleep(1500)
  assert.deepEqual(leasesOf(sent.id).map((lease) => lease.state), ['declined'], 'not offered to the machine that declined it')
  assert.equal((await machineRow(agent))?.counts.declined, 1)

  // This server runs notebooks again: it takes the run.
  homeNotebooks(true)
  const done = await scored(entrant, sent.id)
  homeNotebooks(false)
  assert.ok(homeRunner.notebookRuns.some((one) => one.submissionId === sent.id), 'this server ran it')
  assert.deepEqual(runsOf(sent.id), [['notebook', 'ok'], ['metric', 'ok']])
  assert.equal(typeof done.publicScore, 'number')
  assert.equal((await entrant.submissions()).leftToday, 1, 'the decline spent nothing')
})

scenario('two machines take a burst of twenty submissions in fair order, within their places, and every one is scored exactly once', 120_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const machines = [await scene.machine('burst-a', [c], { approvedSlots: 2 }), await scene.machine('burst-b', [c], { approvedSlots: 2 })]
  const entrants = await Promise.all(Array.from({ length: 20 }, () => new Entrant(home, c).join()))
  const sent: string[] = []
  for (const entrant of entrants) sent.push((await entrant.submit(notebook(null, 2))).id)

  await Promise.all(entrants.map((entrant, index) => scored(entrant, sent[index]!, 90_000)))
  for (const id of sent) {
    const leases = leasesOf(id)
    assert.equal(leases.length, 1, `submission ${id} was leased once: ${JSON.stringify(leases)}`)
    assert.equal(leases[0]!.state, 'applied')
    assert.deepEqual(runsOf(id), [['notebook', 'ok'], ['metric', 'ok']], `submission ${id}: one run, one metric`)
  }
  const runs = machines.map((agent) => agent.sandboxRuns().length)
  assert.equal(runs[0]! + runs[1]!, 20, 'twenty containers in all')
  assert.ok(runs.every((count) => count >= 3), `both machines took work: ${runs.join(' + ')}`)

  // Fair order: leased in the order they were sent, across both machines.
  const offered = sent.map((id) => leasesOf(id)[0]!.offeredAt)
  for (let i = 1; i < offered.length; i++) assert.ok(offered[i]! >= offered[i - 1]!, `submission ${i + 1} was leased before submission ${i}`)
  // Within their places: never more than two runs out to a machine at once.
  for (const agent of machines) {
    const spans = leasesOfRunner(agent.runnerId).map((lease) => [lease.offeredAt, lease.endedAt ?? Infinity] as const)
    const most = Math.max(...spans.map(([start]) => spans.filter(([from, to]) => from <= start && start < to).length))
    assert.ok(most <= 2, `${agent.name} held ${most} runs at once with 2 places`)
  }
  for (const entrant of entrants) assert.equal((await entrant.submissions()).leftToday, 1)
})

scenario('a machine of another runner build gets no new work and shows as outdated, while one of this server\'s build takes it', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const old = await scene.machine('outdated', [], { build: 'e'.repeat(64) })
  await readyFor(old, c, 'outdated')
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook(null, 2))
  // Its held sync is woken by the upload and answered again: a take for it is never even tried (routes.ts · syncReply).
  await until('the outdated machine to have heard it is outdated', () => old.status()?.compatible === false, 20_000, () => old.log())
  await sleep(1500)
  assert.deepEqual(leasesOf(sent.id), [], 'no work for a machine of another build')
  const row = await machineRow(old)
  assert.equal(row?.state, 'outdated')
  assert.equal(row?.compatible, false)
  assert.equal(old.status()?.compatible, false, 'the machine knows it is outdated')
  assert.match(String(old.status()?.problem ?? ''), /build/)
  assert.equal((await waitingRow(c, sent.id))?.place ?? null, null, 'the row waits with no place: nobody takes it')

  const current = await scene.machine('current', [c])
  await scored(entrant, sent.id)
  assert.deepEqual(leasesOf(sent.id).map((lease) => [lease.runnerId, lease.state]), [[current.runnerId, 'applied']])
  assert.deepEqual(leasesOfRunner(old.runnerId), [], 'the outdated machine never held a lease')
  assert.deepEqual(old.leaseFiles(), [])
  assert.equal(old.sandboxRuns().length, 0)
})

scenario('a machine killed after its run ended, before home heard the result: started again, it delivers the outcome it wrote down, and nothing runs twice', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const agent = await scene.machine('recover', [c])
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook({ gate: 'recover-1' }, 2))
  const lease = await runningLease(agent, sent.id)

  // Its uploads go into a path that takes them and never answers: the result is on the machine, written down, and home has none of it.
  home.stall = (req) => (req.url ?? '').includes(`/attempts/${lease.attemptId}/`)
  try {
    openGate(fleet, 'recover-1')
    await until('the machine to write its outcome down', () => agent.hasOutcome(lease.attemptId), 20_000, () => agent.log())
    await until('its upload to be under way', () => home.requests.some((one) => one.path.includes(`/attempts/${lease.attemptId}/files/`)), 10_000, () => agent.log())
    await agent.kill()
  } finally {
    home.stall = null
  }
  assert.equal(leasesOf(sent.id)[0]!.state, 'running', 'home has heard nothing of the result')

  const restartedAt = Date.now()
  agent.start()
  const done = await scored(entrant, sent.id)
  assert.equal(done.participantError, null)
  assert.ok(agent.lines.some((line) => line.includes('1 outcome(s) to upload, 0 lease(s) dropped')), agent.log())
  assert.deepEqual(leasesOf(sent.id).map((one) => [one.attemptId, one.state]), [[lease.attemptId, 'applied']], 'the same lease, applied: recovered, not lost')
  assert.deepEqual(runsOf(sent.id), [['notebook', 'ok'], ['metric', 'ok']])
  assert.equal(agent.sandboxRuns().length, 1, 'the notebook ran once')
  const delivered = home.requestsOf(agent.runnerId).filter((one) => one.at >= restartedAt && one.path.includes(`/attempts/${lease.attemptId}/`) && one.status === 200)
  assert.deepEqual(new Set(delivered.map((one) => one.path.split('/').pop())), new Set(['submission.csv', 'executed.ipynb', 'outcome']), 'the new life uploaded both files and the outcome')
  await until('the machine to clean up', () => !agent.hasOutcome(lease.attemptId) && agent.leaseFiles().length === 0, 10_000, () => agent.log())
  assert.equal((await entrant.submissions()).leftToday, 1)
})

scenario('home moves to another runner build while a machine runs: the run in flight finishes and is scored, and the machine, outdated, gets nothing new until the builds match again', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const agent = await scene.machine('inflight', [c])
  const first = await new Entrant(home, c).join()
  const a = await first.submit(notebook({ gate: 'inflight-1' }, 2))
  await runningLease(agent, a.id)

  // This server is now of a release whose runner differs (decision 5): the machine finishes what it holds and takes nothing new.
  useHomeRunnerBuild('f'.repeat(64))
  let b: { id: string }
  const second = await new Entrant(home, c).join()
  try {
    b = await second.submit(notebook(null, 2))
    await until('the machine to hear it is outdated', () => agent.status()?.compatible === false, 20_000, () => agent.log())
    assert.equal((await machineRow(agent))?.state, 'outdated')
    openGate(fleet, 'inflight-1')
    await scored(first, a.id)
    await sleep(1500)
    assert.deepEqual(leasesOf(b.id), [], 'nothing new for a machine of another build')
    assert.equal(queueRow(b.id)?.state, 'waiting')
  } finally {
    useHomeRunnerBuild(null)
  }
  // The builds match again (the machine updated, or home rolled back): the owner's next save wakes the machines, and it takes the work.
  homeNotebooks(false)
  await scored(second, b!.id)
  assert.deepEqual(leasesOf(b!.id).map((lease) => [lease.runnerId, lease.state]), [[agent.runnerId, 'applied']])
  assert.equal(agent.status()?.compatible, true)
})

scenario('on the hidden test a failure reads the same brief words on a machine as here, and the hidden rows in its traceback never reach the participant', 60_000, async (scene) => {
  const c = scene.competition({ sealed: true, perDay: 3 })
  // The notebook prints the hidden file into its traceback (fake-runner.ts · detailFrom), as a careless one would.
  const leaky = notebook({ status: 'cell_error', cell: 1, detailFrom: 'test.csv' }, 3)

  homeNotebooks(true)
  const hereEntrant = await new Entrant(home, c).join()
  const h = await hereEntrant.submit(leaky)
  const here = await settled(hereEntrant, h.id)
  homeNotebooks(false)
  assert.deepEqual(leasesOf(h.id), [], 'this server ran it')

  const trusted = await scene.machine('blind', [c], { trusted: true })
  const thereEntrant = await new Entrant(home, c).join()
  const t = await thereEntrant.submit(leaky)
  const there = await settled(thereEntrant, t.id)
  assert.deepEqual(leasesOf(t.id).map((lease) => [lease.runnerId, lease.state]), [[trusted.runnerId, 'applied']], 'it ran on the trusted machine')

  const seen = (one: typeof here) => ({ state: one.state, stage: one.stage, participantError: one.participantError, cellsDone: one.cellsDone, cellsTotal: one.cellsTotal, blind: one.blind })
  assert.deepEqual(seen(there), seen(here), 'the same brief words, the same cells')
  assert.equal(there.state, 'notebookFailed')
  assert.equal(there.blind, true)
  assert.ok(there.participantError, 'the participant is told the cell failed')
  assert.ok(!there.participantError!.includes('hidden-row'), `the hidden rows are not in what the participant reads: ${there.participantError}`)
  // The teacher keeps the whole traceback, hidden rows and all, from the machine as from here.
  assert.ok(getSubmission(t.id)!.participantError?.includes('hidden-row'), 'the full words are kept for the teacher')
  assert.equal(getSubmission(t.id)!.participantError, getSubmission(h.id)!.participantError)
  assert.equal(getSubmission(t.id)!.errorType, 'ValueError')
})

scenario('the owner disconnects a machine in the middle of a run: its agent kills the run and stops, and the run, given back with no penalty, is scored on another machine', 60_000, async (scene) => {
  const c = scene.competition({ perDay: 2 })
  const doomed = await scene.machine('disconnected', [c])
  const entrant = await new Entrant(home, c).join()
  const sent = await entrant.submit(notebook({ gate: 'revoke-1' }, 2))
  const lease = await runningLease(doomed, sent.id)
  const container = await until('the container to run', () => doomed.containers().find((one) => one.attemptId === lease.attemptId), 10_000)
  const enqueuedAt = queueRow(sent.id)!.enqueuedAt

  // «Отключить»: the machine's next call is refused, and the agent ends what it holds and exits by itself.
  assert.equal((await home.admin('POST', `/api/admin/runners/${doomed.runnerId}/revoke`)).status, 200)
  const exit = await doomed.exit(20_000)
  assert.equal(exit.code, 0, doomed.log())
  assert.ok(!doomed.containers().some((one) => one.name === container.name), 'its container is gone with it')
  assert.ok(doomed.dockerCalls().some((call) => call.args.join(' ') === `kill --signal=KILL ${container.name}`), 'the run was killed')
  assert.equal(doomed.status()?.state, 'revoked')

  // Home gave the run back at once: in its place, no loss counted, our words to the participant.
  const [given] = leasesOf(sent.id)
  assert.deepEqual([given!.state, given!.cause], ['revoked', 'revoked'])
  const back = queueRow(sent.id)!
  assert.deepEqual([back.state, back.holder, back.enqueuedAt, back.lost], ['waiting', null, enqueuedAt, 0])
  const waiting = await entrant.submission(sent.id)
  assert.equal(waiting.state, 'queued')
  assert.equal(waiting.participantError, tr('server.runners.returned'))

  const other = await scene.machine('takes-over', [c])
  openGate(fleet, 'revoke-1')
  await scored(entrant, sent.id)
  assert.deepEqual(leasesOf(sent.id).map((one) => [one.runnerId, one.state]), [[doomed.runnerId, 'revoked'], [other.runnerId, 'applied']])
  assert.deepEqual(runsOf(sent.id), [['notebook', 'unknown'], ['notebook', 'ok'], ['metric', 'ok']])
  assert.equal((await entrant.submissions()).leftToday, 1, 'the run taken back spent nothing')
})

scenario('this server restarts while a machine fetches a competition\'s data: once home is back, it serves the machine what it asks for and the machine takes the competition\'s work', 60_000, async (scene) => {
  // «Скорость раздачи» at its least, so that a one-megabyte file is still on its way when home goes down.
  saveCompetitionSettings({ runnerBlobMBps: REMOTE_BLOB_MBPS.min })
  try {
    const c = scene.competition({ perDay: 2, bigFileBytes: 1024 * 1024 })
    const agent = await scene.machine('prefetch', [])
    const runnerId = agent.runnerId
    const big = c.open['big.csv']!
    await until('the machine to be fetching the big file', () => home.requests.some((one) => one.runnerId === runnerId && one.path.endsWith(`/blobs/${big}`) && one.status === null), 20_000, () => agent.log())

    /*
     * Home goes down mid-download and comes back on the same DATA_DIR and port.
     * The machine's downloads and its sync each wait out a random backoff
     * before they try again, and here a download comes back before the sync
     * does (the sync is held back for its first four seconds; left to chance,
     * the downloads came back first in three runs of three as well). Whatever
     * the order, home must not refuse a machine what the competitions it was
     * asked to hold are made of: a refused blob is not asked for again for
     * five minutes (runner-agent/cache.ts · REFUSED_WAIT_MS).
     */
    await home.crash()
    let first = true
    home.stall = (req) => {
      if (!first || !(req.url ?? '').endsWith('/sync') || parseRemoteAuthorization(req.headers.authorization)?.runnerId !== runnerId) return false
      first = false
      return 4_000
    }
    const restartedAt = Date.now()
    await home.restart()
    const since = () => home.requestsOf(runnerId).filter((one) => one.at >= restartedAt && one.path.includes('/blobs/'))
    const said = () => since().map((one) => `${one.method} ${one.path.split('/').pop()!.slice(0, 12)} → ${one.status}`).join(', ')
    try {
      // A fixed home gets the backoff's whole width (up to 30 s after a streak of failures) to be asked again.
      await until('the machine to hold the competition\'s data again', async () => {
        const refused = since().filter((one) => one.status === 404)
        if (refused.length > 0) throw new Error(`home refused the machine ${refused.length} blob(s) of a competition it was asked to hold: ${said()}\n${agent.log()}`)
        return (await machineRow(agent))?.readiness.find((entry) => entry.competitionId === c.id)?.verdict === 'taking'
      }, 40_000, () => `blob requests since the restart: ${said()}\n${agent.log()}`)
    } finally {
      home.stall = null
    }
    const entrant = await new Entrant(home, c).join()
    const sent = await entrant.submit(notebook(null, 2))
    await scored(entrant, sent.id)
    assert.deepEqual(leasesOf(sent.id).map((lease) => [lease.runnerId, lease.state]), [[runnerId, 'applied']])
  } finally {
    saveCompetitionSettings({ runnerBlobMBps: REMOTE_BLOB_MBPS.default })
  }
}, 'product defect: after a restart the blob route has no want scope for a machine until its first sync of the new life is answered (remote/blobs.ts · scopedSources reads only the in-memory wantScopes), so the downloads it resumes first get 404, and the agent asks for a refused blob again only after cache.ts · REFUSED_WAIT_MS (5 min): the machine holds no data, and takes none of the competition\'s work, for five minutes')
