/**
 * How much the queue may run at once, when a job may start, and what the
 * participant is promised about the wait.
 *
 * Every rule here fails quietly and by a number: a slot count one too low is a
 * queue twice as long, a double-counted reservation is a machine that admits
 * one submission where four fit, an estimate over the oldest runs is "≈ 15
 * min" for a notebook that takes one. So each rule is pinned by numbers, with
 * the machine injected rather than measured.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { privateBoardAwaits, privateBoardOpen, type Competition } from '../shared/competitions.js'
import {
  admitJob,
  autoSlots,
  CENSUS_TRUST_MS,
  MEMORY_FLOOR_MB,
  resolveSlots,
  slotsResolution,
  slotShape,
  usableMemoryMb,
} from '../server/src/competitions/capacity.js'
import { competitionDefaults, parseSettingsInput, saveCompetitionSettings, saveSlots, uploadsPerMinute } from '../server/src/competitions/settings.js'
import { expectedRunMs, MIN_REMAINING_MS, queueEtas } from '../server/src/competitions/panel.js'
import { queueForecast } from '../server/src/competitions/forecast.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  leaveQueue,
  queueRows,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { queueSlots, setQueueSlots } from '../server/src/competitions/runner.js'
import { harnessDir } from '../server/src/competitions/harness.js'
import { competitionRunner, forgetCompetitionRunner, limitsFor, useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { useDockerForCompetitions } from '../server/src/competitions/docker-runner.js'
import { inputDir, openDir, putSubmissionNotebook, resultDir } from '../server/src/competitions/storage.js'
import { TEST_ROOT } from './_env.mts'

/* ------------------------------------------------------------------ slots */

test('auto slots: one per default submission, after leaving the class two CPUs and two gigabytes', () => {
  // 46 usable CPUs / 2 per slot = 23; (98304 − 2048) / (2048 + 256) = 41 — the CPUs decide.
  assert.equal(autoSlots({ cpus: 48, memoryMb: 96 * 1024 }, { cpus: 2, memoryMb: 2048 }), 23)
  // The test stand's machine with the stock defaults: 14 / 2 = 7 against 71680 / 4352 = 16.
  assert.equal(autoSlots({ cpus: 16, memoryMb: 73_728 }, { cpus: 2, memoryMb: 4096 }), 7)
  // Heavier defaults make fewer, bigger slots: memory decides, 96256 / 16640 = 5.
  assert.equal(autoSlots({ cpus: 48, memoryMb: 96 * 1024 }, { cpus: 4, memoryMb: 16_384 }), 5)
  // A laptop still runs one at a time, never zero.
  assert.equal(autoSlots({ cpus: 2, memoryMb: 4096 }, { cpus: 2, memoryMb: 4096 }), 1)
  assert.equal(autoSlots({ cpus: 4, memoryMb: 8192 }, { cpus: 2, memoryMb: 4096 }), 1)
  // A huge machine stops at 32: past it, a cluster has its own scheduler.
  assert.equal(autoSlots({ cpus: 256, memoryMb: 1024 * 1024 }, { cpus: 2, memoryMb: 4096 }), 32)
  // What the Resources tab prints next to the number comes from the same place.
  assert.deepEqual(slotShape({ cpus: 2, memoryMb: 2048 }), { cpus: 2, memoryMb: 2304 })
})

test('slots: the saved setting, then COMPETITION_SLOTS, then auto', () => {
  const auto = 6
  assert.deepEqual(resolveSlots({ saved: 8, env: '3', auto }), { mode: 'fixed', value: 8, effective: 8, source: 'saved' })
  assert.deepEqual(resolveSlots({ saved: 'auto', env: '3', auto }), { mode: 'auto', value: 6, effective: 6, source: 'saved' })
  assert.deepEqual(resolveSlots({ saved: null, env: '3', auto }), { mode: 'fixed', value: 3, effective: 3, source: 'env' })
  assert.deepEqual(resolveSlots({ saved: null, env: ' auto ', auto }), { mode: 'auto', value: 6, effective: 6, source: 'env' })
  // A typo in .env is ignored, not obeyed as "one slot".
  assert.deepEqual(resolveSlots({ saved: null, env: 'eight', auto }), { mode: 'auto', value: 6, effective: 6, source: 'default' })
  assert.deepEqual(resolveSlots({ saved: null, auto }), { mode: 'auto', value: 6, effective: 6, source: 'default' })
  // Out-of-range environment numbers are clamped where they are used.
  assert.equal(resolveSlots({ saved: null, env: '0', auto }).effective, 1)
  assert.equal(resolveSlots({ saved: null, env: '500', auto }).effective, 64)
})

test('slots live in the shared box: a fixed number, the environment, and back to auto', () => {
  const previous = process.env.COMPETITION_SLOTS
  try {
    assert.equal(setQueueSlots(5), 5)
    assert.equal(queueSlots(), 5)
    assert.equal(slotsResolution().source, 'saved')
    saveSlots(null)
    process.env.COMPETITION_SLOTS = '3'
    assert.deepEqual({ ...slotsResolution(), auto: 0, perSlot: null }, { mode: 'fixed', value: 3, effective: 3, source: 'env', auto: 0, perSlot: null })
    delete process.env.COMPETITION_SLOTS
    const auto = slotsResolution()
    assert.equal(auto.mode, 'auto')
    assert.equal(auto.effective, auto.auto)
    // The test stand's machine (16 CPUs, 72 GB) with the stock defaults.
    assert.equal(auto.auto, 7)
  } finally {
    if (previous === undefined) delete process.env.COMPETITION_SLOTS
    else process.env.COMPETITION_SLOTS = previous
    saveSlots(null)
  }
})

/* -------------------------------------------------------------- admission */

test('admission: promised memory and measured memory, and a running job is never counted twice', () => {
  const need = 4096 + 256
  // Two jobs promised, a third fits into what competitions may promise.
  assert.deepEqual(admitJob({ needMb: need, reservedMb: 2 * need, usableMb: 20_000, memAvailableMb: null }), { ok: true })
  assert.deepEqual(admitJob({ needMb: need, reservedMb: 2 * need, usableMb: 12_000, memAvailableMb: null }), { ok: false, reason: 'reservations' })
  // The floor: MemAvailable must still hold the job and half a gigabyte.
  assert.deepEqual(admitJob({ needMb: need, reservedMb: 0, usableMb: null, memAvailableMb: need + MEMORY_FLOOR_MB - 1 }), { ok: false, reason: 'floor' })
  assert.deepEqual(admitJob({ needMb: need, reservedMb: 0, usableMb: null, memAvailableMb: need + MEMORY_FLOOR_MB }), { ok: true })
  // Unknown is never a refusal.
  assert.deepEqual(admitJob({ needMb: need, reservedMb: 10 * need, usableMb: null, memAvailableMb: null }), { ok: true })
  /*
   * The regression: two submissions running, each already holding ~3.5 GB of
   * real memory, so MemAvailable is 12 GB on a machine where 30 GB are still
   * unpromised. The old check took min(MemAvailable, unpromised) and then
   * subtracted the two reservations AGAIN: 12288 − 8704 = 3584 < 4352, refused.
   */
  assert.deepEqual(admitJob({ needMb: need, reservedMb: 2 * need, usableMb: 30_720, memAvailableMb: 12_288 }), { ok: true })
})

test('usable memory: the machine minus its reserve minus room kernels, and a stale census closes admission', () => {
  const now = 1_000_000
  const census = { memoryMb: 16_384, complete: true, at: now }
  assert.equal(usableMemoryMb({ totalMb: 65_536, census, now }), 65_536 - 1024 - 16_384)
  // One `docker inspect` timed out: the last complete census is believed for a minute...
  const shaky = { memoryMb: 16_384, complete: false, at: now - 30_000 }
  assert.equal(usableMemoryMb({ totalMb: 65_536, census: shaky, now }), 65_536 - 1024 - 16_384)
  // ...and no longer than that.
  const stale = { memoryMb: 16_384, complete: false, at: now - CENSUS_TRUST_MS - 1 }
  assert.equal(usableMemoryMb({ totalMb: 65_536, census: stale, now }), 0)
  assert.equal(usableMemoryMb({ totalMb: null, census, now }), null)
})

/* -------------------------------------------------------------- estimates */

test('the estimate simulates the slots: free slots first, then the earliest to free up', () => {
  const five = Array.from({ length: 5 }, () => ({ expectedMs: 100 }))
  assert.deepEqual(queueEtas({ slots: 3, running: [], waiting: five }), [
    { startMs: 0, etaMs: 100 }, { startMs: 0, etaMs: 100 }, { startMs: 0, etaMs: 100 },
    { startMs: 100, etaMs: 200 }, { startMs: 100, etaMs: 200 },
  ])
  // Each job's result comes after its OWN run time, not a shared average.
  assert.deepEqual(queueEtas({ slots: 1, running: [], waiting: [{ expectedMs: 50 }, { expectedMs: 500 }] }), [
    { startMs: 0, etaMs: 50 }, { startMs: 50, etaMs: 550 },
  ])
  // A job past its expected time frees its slot "soon", never "now".
  assert.deepEqual(queueEtas({ slots: 1, running: [{ expectedMs: 60_000, elapsedMs: 90_000 }], waiting: [{ expectedMs: 1000 }] }), [
    { startMs: MIN_REMAINING_MS, etaMs: MIN_REMAINING_MS + 1000 },
  ])
  // More running than slots (the owner lowered the number): only the last two free a slot.
  const running = [10_000, 20_000, 30_000].map((left) => ({ expectedMs: left, elapsedMs: 0 }))
  assert.deepEqual(queueEtas({ slots: 2, running, waiting: [{ expectedMs: 100_000 }, { expectedMs: 100_000 }] }).map((eta) => eta.startMs), [20_000, 30_000])
  // A busy slot and an idle one: the first waiting job takes the idle one.
  assert.deepEqual(queueEtas({ slots: 2, running: [{ expectedMs: 9000, elapsedMs: 1000 }], waiting: [{ expectedMs: 5 }, { expectedMs: 5 }] }).map((eta) => eta.startMs), [0, 5])
})

test('expected run time: the competition median from three runs, else the instance, else half the limit', () => {
  assert.equal(expectedRunMs({ recent: [30, 10, 20], instance: [999], wallSeconds: 600 }), 20)
  assert.equal(expectedRunMs({ recent: [10, 20], instance: [300, 100, 200], wallSeconds: 600 }), 200)
  assert.equal(expectedRunMs({ recent: [], instance: [], wallSeconds: 600 }), 300_000)
})

test('the forecast reads the NEWEST runs: a competition where the first attempts were slow promises the current speed', () => {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  const c = createCompetition({ slug: 'newest-runs', title: 'Newest runs' })!
  const person = createEntrant('Бегун').entrant
  const start = Date.now() - 100_000
  // Ten slow old runs, then twenty fast recent ones.
  for (let i = 0; i < 30; i++) {
    const done = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'a.ipynb', bytes: 1, at: start + i * 1000 })
    leaveQueue(done.id)
    updateSubmission(done.id, { state: 'scored', durationMs: i < 10 ? 900_000 : 60_000, publicScore: 1 })
  }
  const waiting = acceptSubmission({ competitionId: c.id, entrantId: createEntrant('Ждущий').entrant.id, fileName: 'b.ipynb', bytes: 1 })
  const forecast = queueForecast(1)
  // The oldest twenty would have promised (900k + 60k) / 2 = 8 minutes.
  assert.equal(forecast.at.get(waiting.id)?.etaMs, 60_000)
  assert.equal(forecast.at.get(waiting.id)?.place, 1)
  leaveQueue(waiting.id)
})

/* --------------------------------------------------------------- settings */

test('the settings form: bounds of its own and the machine\'s, and null forgets', () => {
  const machine = { cpus: 8, memoryMb: 16_384, reserveMb: 1024 }
  assert.deepEqual(parseSettingsInput({ slots: 'auto', uploadsPerMinute: 30 }, machine), { patch: { slots: 'auto', uploadsPerMinute: 30 } })
  assert.deepEqual(parseSettingsInput({ slots: 12 }, machine), { patch: { slots: 12 } })
  assert.deepEqual(parseSettingsInput({ slots: null, perDay: '' }, machine), { patch: { slots: null, perDay: null } })
  assert.deepEqual(parseSettingsInput({ slots: 0 }, machine), { refusal: { field: 'slots', why: 'range', min: 1, max: 64 } })
  assert.deepEqual(parseSettingsInput({ slots: 65 }, machine), { refusal: { field: 'slots', why: 'range', min: 1, max: 64 } })
  assert.deepEqual(parseSettingsInput({ slots: 'many' }, machine), { refusal: { field: 'slots', why: 'value' } })
  assert.deepEqual(parseSettingsInput({ uploadsPerMinute: 121 }, machine), { refusal: { field: 'uploadsPerMinute', why: 'range', min: 1, max: 120 } })
  // The machine caps what a default may promise: total minus a gigabyte, and its CPUs.
  assert.deepEqual(parseSettingsInput({ memoryMb: 16_000 }, machine), { refusal: { field: 'memoryMb', why: 'range', min: 512, max: 15_360 } })
  assert.deepEqual(parseSettingsInput({ cpus: 12 }, machine), { refusal: { field: 'cpus', why: 'range', min: 1, max: 8 } })
  assert.deepEqual(parseSettingsInput({ wallSeconds: 20 }, machine), { refusal: { field: 'wallSeconds', why: 'range', min: 30, max: 14_400 } })
})

test('new competitions start from the instance defaults, field by field', () => {
  try {
    saveCompetitionSettings({ wallSeconds: 900, memoryMb: 2048, uploadsPerMinute: 20 })
    assert.deepEqual(competitionDefaults().sources, { wallSeconds: 'saved', memoryMb: 'saved', cpus: 'default', perDay: 'default' })
    assert.deepEqual(uploadsPerMinute(), { value: 20, source: 'saved' })
    const made = createCompetition({ slug: 'defaults-born', title: 'Defaults' })!
    assert.deepEqual(made.limits, { wallSeconds: 900, memoryMb: 2048, cpus: 2, perDay: 5 })
    // What the editor sends still wins over the defaults.
    const explicit = createCompetition({ slug: 'defaults-explicit', title: 'Explicit', limits: { memoryMb: 8192 } })!
    assert.equal(explicit.limits.memoryMb, 8192)
    assert.equal(explicit.limits.wallSeconds, 900)
  } finally {
    saveCompetitionSettings({ wallSeconds: null, memoryMb: null, uploadsPerMinute: null })
  }
  assert.deepEqual(competitionDefaults().limits, { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 })
  assert.deepEqual(uploadsPerMinute(), { value: 12, source: 'default' })
})

/* ---------------------------------------------------------- private board */

test('the automatic release waits for the results; the manual one does not', () => {
  const deadline = Date.UTC(2026, 8, 27, 20, 59)
  const auto = { state: 'live', privateRelease: 'auto', deadlineAt: deadline, privateOpenedAt: null } as Competition
  assert.equal(privateBoardOpen(auto, deadline - 1, 0), false)
  assert.equal(privateBoardAwaits(auto, deadline), true)
  assert.equal(privateBoardOpen(auto, deadline, 3), false, 'opened with results still being counted')
  assert.equal(privateBoardOpen(auto, deadline, 0), true)
  // "Finish now" ends intake too — the board opens once the queue is through.
  const finished = { ...auto, state: 'finished', deadlineAt: deadline + 86_400_000 } as Competition
  assert.equal(privateBoardOpen(finished, deadline, 2), false)
  assert.equal(privateBoardOpen(finished, deadline, 0), true)
  // The teacher's hand opens it whatever the queue holds.
  assert.equal(privateBoardOpen({ ...auto, privateOpenedAt: deadline - 5 }, deadline - 1, 7), true)
  assert.equal(privateBoardOpen({ ...auto, privateRelease: 'manual' }, deadline + 1, 0), false)
})

/* -------------------------------------------------------------- the harness */

test('an orphaned container stops by itself: the supervisor has a deadline of its own', (t) => {
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('no python3 on this machine')
  const root = fs.mkdtempSync(path.join(TEST_ROOT, 'supervisor-'))
  const child = path.join(root, 'child.py')
  const env = { ...process.env, COMP_ATTEMPT_ID: 'orphan', COMP_WALL_SECONDS: '1', COMP_ORPHAN_GRACE_SECONDS: '1' }
  const supervisor = path.join(harnessDir(), 'hold_export.py')
  // A notebook that would run forever: killed at wall + grace, non-zero.
  fs.writeFileSync(child, 'import time\ntime.sleep(60)\n')
  let started = Date.now()
  const hung = spawnSync('python3', [supervisor, path.join(root, 'hung'), child], { env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(hung.status, 124, hung.stderr)
  assert.ok(Date.now() - started < 10_000)
  assert.equal(fs.existsSync(path.join(root, 'hung', '.complete.json')), false)
  // A notebook that finished: its completion is written, and the supervisor still leaves at the deadline.
  fs.writeFileSync(child, 'print("done")\n')
  started = Date.now()
  const done = spawnSync('python3', [supervisor, path.join(root, 'done'), child], { env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(done.status, 125, done.stderr)
  assert.ok(Date.now() - started < 10_000)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'done', '.complete.json'), 'utf8')), { attemptId: 'orphan', exit: 0 })
})

/* --------------------------------------------------------- the watchdog */

test('the watchdog looks inside every three seconds, kills on time, and streams exports without holding them', async () => {
  const c = createCompetition({ slug: 'watchdog', title: 'Watchdog' })!
  const person = createEntrant('Сторож').entrant
  const submission = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'w.ipynb', bytes: 1 })
  leaveQueue(submission.id)
  putSubmissionNotebook(c.id, submission.id, Buffer.from('{"cells":[]}'))
  const previous = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = 'docker'
  useCompetitionRunner(null)
  forgetCompetitionRunner()
  const calls: string[] = []
  try {
    // A notebook that never finishes: only the wall limit ends it.
    useDockerForCompetitions(async (args) => {
      calls.push(args[0] === 'exec' ? `exec ${args[5]}` : args[0])
      if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'running 137 false' }
      if (args[0] === 'exec') return { code: 0, out: '{}' }
      return { code: 0, out: '' }
    })
    const limits = { ...limitsFor(c, 'notebook'), wallSeconds: 3 }
    const started = Date.now()
    const timedOut = await competitionRunner().run({ competition: c, submissionId: submission.id, container: 'watchdog-wall', dataDir: openDir(c.id), inputDir: inputDir(c.id, submission.id), resultDir: resultDir(c.id, submission.id), limits })
    const took = Date.now() - started
    assert.equal(timedOut.status, 'timeout')
    assert.ok(took >= 3000 && took < 4500, `killed ${took} ms into a 3 s limit`)
    const looks = calls.filter((call) => call === 'exec status').length
    assert.ok(looks >= 1 && looks <= 2, `looked inside ${looks} times in three seconds`)
    assert.ok(calls.filter((call) => call === 'inspect').length >= 3, 'liveness is checked every second')
    assert.ok(calls.includes('kill'))

    // A finished one: the export arrives in awkward chunks through the stream,
    // padding split across them, and lands whole under its name.
    const answer = 'id,orders\n1,7\n2,9\n'
    const run = JSON.stringify({ status: 'ok', attemptId: 'streamed', cell: 0, cells: 1 })
    useDockerForCompetitions(async (args, _timeout, _max, sink) => {
      if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'running 0 false' }
      if (args[0] === 'exec' && args[5] === 'status') return { code: 0, out: JSON.stringify({ complete: { attemptId: 'streamed', exit: 0 } }) }
      if (args[0] === 'exec' && sink) {
        const name = args.at(-1)!
        const encoded = Buffer.from(name === 'run.json' ? run : name === 'submission.csv' ? answer : '{}').toString('base64')
        for (let i = 0; i < encoded.length; i += 7) sink.write(Buffer.from(encoded.slice(i, i + 7)))
        sink.end()
        return { code: 0, out: '' }
      }
      return { code: 0, out: '' }
    })
    const exported = resultDir(c.id, submission.id)
    const finished = await competitionRunner().run({ competition: c, submissionId: submission.id, attemptId: 'streamed', container: 'watchdog-export', dataDir: openDir(c.id), inputDir: inputDir(c.id, submission.id), resultDir: exported, limits: limitsFor(c, 'notebook') })
    assert.equal(finished.status, 'ok')
    assert.equal(fs.readFileSync(path.join(exported, 'submission.csv'), 'utf8'), answer)
    assert.equal(fs.readdirSync(exported).some((name) => name.endsWith('.part')), false, 'a half-written export was left behind')
  } finally {
    useDockerForCompetitions(null)
    if (previous === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = previous
    forgetCompetitionRunner()
  }
})

test('a notebook that finishes between two looks, just before its limit, is exported rather than timed out', async () => {
  const c = createCompetition({ slug: 'watchdog-edge', title: 'Watchdog edge' })!
  const person = createEntrant('Финишёр').entrant
  const submission = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'e.ipynb', bytes: 1 })
  leaveQueue(submission.id)
  putSubmissionNotebook(c.id, submission.id, Buffer.from('{"cells":[]}'))
  const previous = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = 'docker'
  useCompetitionRunner(null)
  forgetCompetitionRunner()
  const calls: string[] = []
  const answer = 'id,orders\n1,7\n'
  const run = JSON.stringify({ status: 'ok', attemptId: 'edge', cell: 0, cells: 1 })
  let looks = 0
  try {
    /*
     * The supervisor keeps the container running after the notebook ends, for
     * the export (harness.ts · HOLD_EXPORT). The notebook ends between the
     * second look (at 3 s) and its 5 s limit, and the next scheduled look
     * would come only after the deadline. Counted by looks, not by the clock:
     * timer drift must not move the end in front of a look.
     */
    useDockerForCompetitions(async (args) => {
      calls.push(args[0] === 'exec' ? `exec ${args[5]}` : args[0])
      if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'running 0 false' }
      if (args[0] === 'exec' && args[5] === 'status') {
        return { code: 0, out: ++looks > 2 ? JSON.stringify({ complete: { attemptId: 'edge', exit: 0 } }) : '{}' }
      }
      if (args[0] === 'exec') {
        const name = args.at(-1)!
        return { code: 0, out: Buffer.from(name === 'run.json' ? run : name === 'submission.csv' ? answer : '{}').toString('base64') }
      }
      return { code: 0, out: '' }
    })
    const limits = { ...limitsFor(c, 'notebook'), wallSeconds: 5 }
    const outcome = await competitionRunner().run({ competition: c, submissionId: submission.id, attemptId: 'edge', container: 'watchdog-edge', dataDir: openDir(c.id), inputDir: inputDir(c.id, submission.id), resultDir: resultDir(c.id, submission.id), limits })
    assert.equal(outcome.status, 'ok', `a notebook that finished in time was reported ${outcome.status}`)
    assert.equal(outcome.diagnostics.killedBy, undefined)
    assert.equal(calls.includes('kill'), false, 'a finished notebook was killed for the wall')
    assert.equal(fs.readFileSync(outcome.submission!, 'utf8'), answer)
  } finally {
    useDockerForCompetitions(null)
    if (previous === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = previous
    forgetCompetitionRunner()
  }
})
