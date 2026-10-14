/**
 * The notebook step in two halves (runner.ts · prepareNotebook and
 * settleNotebook): a run on this server writes, write by write, exactly what
 * the one function before the split (runNotebookThenScore) wrote.
 *
 * Why a recorded log and not a few asserts. The split moves every line of the
 * step — the run row, the stage bar, the clamps of a blind run, the texts of
 * three readers, the card's share, the neighbour's retry, the cancellation
 * checks — into two functions that a machine's outcome will call apart, hours
 * later. A missed line fails quietly: a stage the bar never shows, a run row
 * left unfinished, a blind participant handed one number too many. Final
 * states hide most of that (a stage written and overwritten looks like one
 * never written), so what is compared is the whole sequence of writes to the
 * three tables a run touches, each one a row of a log the triggers below keep.
 *
 * THE FIXTURE (fixtures/competition-notebook-split.json) was recorded from
 * runNotebookThenScore at 03a65bb, before the split, by running this file
 * with RECORD_NOTEBOOK_SPLIT=1, over the stand-in runner's own directives —
 * the fixtures the rest of the suite runs on. Re-record it only for a change
 * meant to alter what a run writes (a reworded sentence, a new column the run
 * fills), and say so in that change: the point of the file is that the split
 * itself changed nothing. Columns added since are not in the fixture; what
 * they must hold on a run of this server is asserted on their own here
 * (holder, lost, revision_id).
 *
 * The clock is frozen for the whole file, so a timestamp is the same number
 * on every run and a duration is zero; ids are random, so each is replaced by
 * its kind and the order it first appeared in (<sub1>, <att2>, ...).
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { db } from '../server/src/db.js'
import type { Competition, Submission } from '../shared/competitions.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  getSubmission,
  leaveQueue,
  putFile,
  queueRow,
  queueRows,
  setCompetitionState,
  setQueuePaused,
  updateCompetition,
} from '../server/src/competitions/store.js'
import { bindSubmission, completeBundle, createBundle, putRevision, selectRevision, setPolicy } from '../server/src/dependencies/store.js'
import { competitionsFs, putOpenFile, putSealedFile, putSecretFile, putSubmissionNotebook, submissionDir } from '../server/src/competitions/storage.js'
import { SOLUTION_NAME, VRAM_UNREAD_LIMIT, unreadCardNotes } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type RunOutcome, type RunRequest } from '../server/src/competitions/runner-port.js'
import {
  cancelSubmission,
  drainCompetitionQueue,
  pumpOnce,
  rerunSubmission,
  rescoreCompetition,
  setQueueSlots,
  settleCompetitionWork,
} from '../server/src/competitions/runner.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { useGpuCardProbe } from '../server/src/kernel/resources.js'

const RECORD = process.env.RECORD_NOTEBOOK_SPLIT === '1'
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'competition-notebook-split.json')
const TABLES = ['submissions', 'submission_runs', 'competition_queue'] as const
type Table = (typeof TABLES)[number]

/* ------------------------------------------------------------- the clock */

/** Any moment will do; it is the same one on every run of the file. */
const NOW = 1_790_000_000_000
const realNow = Date.now

before(() => {
  Date.now = () => NOW
})
after(() => {
  Date.now = realNow
})

/** Wait on real time: Date.now does not move in this file. */
async function until(reached: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!reached()) {
    if (performance.now() > deadline) throw new Error('the condition was never reached')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

/* ---------------------------------------------------------------- the log */

/*
 * Every write to the three tables, in order, as the row stood after it (the
 * key alone for a delete). Columns are listed as the schema has them when the
 * file starts, so the log of a newer schema carries its new columns too; the
 * comparison reads only the fixture's.
 */
db.exec('CREATE TABLE IF NOT EXISTS notebook_split_log (n INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)')
const COLUMNS = Object.fromEntries(TABLES.map((table) => [
  table,
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name),
])) as Record<Table, string[]>
const KEY: Record<Table, string> = { submissions: 'id', submission_runs: 'id', competition_queue: 'submission_id' }
for (const table of TABLES) {
  const row = (side: 'NEW' | 'OLD') => `json_object(${COLUMNS[table].map((column) => `'${column}', ${side}.${column}`).join(', ')})`
  for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const body = operation === 'DELETE' ? `json_object('${KEY[table]}', OLD.${KEY[table]})` : row('NEW')
    db.exec(`CREATE TRIGGER IF NOT EXISTS notebook_split_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      BEGIN INSERT INTO notebook_split_log (entry) VALUES (json_object('table', '${table}', 'op', '${operation}', 'row', ${body})); END`)
  }
}

interface Logged { table: Table; op: 'INSERT' | 'UPDATE' | 'DELETE'; row: Record<string, unknown> }

const mark = (): number => (db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM notebook_split_log').get() as { n: number }).n
const loggedSince = (from: number): Logged[] =>
  (db.prepare('SELECT entry FROM notebook_split_log WHERE n > ? ORDER BY n').all(from) as { entry: string }[]).map((row) => JSON.parse(row.entry) as Logged)

/** How each id-bearing column is named in the fixture. */
const ID_KIND: Record<string, string> = {
  id: '', submission_id: 'sub', competition_id: 'comp', entrant_id: 'ent', attempt_id: 'att', boot: 'boot',
}

/**
 * The log as the fixture keeps it: ids by kind and first appearance, the
 * frozen moment as <t> (and <t+N> for a moment after it), and each update as
 * the columns it changed — `{}` for a write that changed nothing, which is
 * still a write. `base` holds the rows as they stood before the first entry
 * (the submission and its queue row as the upload left them), so the first
 * update is a difference too.
 */
function normalize(entries: readonly Logged[], base: ReadonlyMap<string, Record<string, unknown>>, columns: Record<Table, readonly string[]>): unknown[] {
  const names = new Map<string, string>()
  const counts = new Map<string, number>()
  const nameOf = (kind: string, value: string): string => {
    const key = `${kind}:${value}`
    let known = names.get(key)
    if (!known) {
      const next = (counts.get(kind) ?? 0) + 1
      counts.set(kind, next)
      known = `<${kind}${next}>`
      names.set(key, known)
    }
    return known
  }
  const value = (table: Table, column: string, raw: unknown): unknown => {
    if (raw === null || raw === undefined) return null
    if (typeof raw === 'number' && Math.abs(raw - NOW) < 1e9) return raw === NOW ? '<t>' : `<t${raw > NOW ? '+' : '-'}${Math.abs(raw - NOW)}>`
    if (typeof raw !== 'string') return raw
    if (column === 'container') {
      const parts = /^colloq-comp-([A-Za-z0-9_-]+)-([a-f0-9]{8})-(run|score)$/.exec(raw)
      return parts ? `colloq-comp-${nameOf('sub', parts[1])}-${nameOf('tok', parts[2])}-${parts[3]}` : raw
    }
    const kind = column === 'id' ? (table === 'submissions' ? 'sub' : 'run') : ID_KIND[column]
    return kind ? nameOf(kind, raw) : raw
  }
  const state = new Map(base)
  const out: unknown[] = []
  for (const entry of entries) {
    const key = String(entry.row[KEY[entry.table]])
    const at = `${entry.table}:${key}`
    if (entry.op === 'DELETE') {
      state.delete(at)
      out.push([entry.table, 'DELETE', value(entry.table, KEY[entry.table], key)])
      continue
    }
    const previous = entry.op === 'UPDATE' ? state.get(at) : undefined
    const changed: Record<string, unknown> = {}
    for (const column of columns[entry.table]) {
      if (previous && Object.is(previous[column], entry.row[column])) continue
      changed[column] = value(entry.table, column, entry.row[column])
    }
    state.set(at, entry.row)
    out.push([entry.table, entry.op, value(entry.table, KEY[entry.table], key), changed])
  }
  return out
}

/** The submission's files as the run left them: path within its folder and the bytes' digest. */
function filesOf(competitionId: string, submissionId: string): Record<string, string> {
  const root = submissionDir(competitionId, submissionId)
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of (competitionsFs.readdirSync(dir) as string[]).sort()) {
      const file = path.join(dir, name)
      if (competitionsFs.statSync(file).isDirectory()) walk(file)
      else out[path.relative(root, file)] = createHash('sha256').update(competitionsFs.readFileSync(file) as Buffer).digest('hex').slice(0, 16)
    }
  }
  try { walk(root) } catch { /* no folder at all */ }
  return out
}

/* ---------------------------------------------------- the stand-in runner */

/**
 * The suite's stand-in runner, which can also end a run as the docker runner
 * ends one whose shared card stopped answering (competition-gpu-edges.test.mts).
 */
class Runner extends FakeCompetitionRunner {
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

/* ------------------------------------------------------------- fixtures */

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const RTX = { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }
const GPU_ENV = ['KERNEL_GPUS', 'COMPETITION_GPUS', 'COMPETITION_GPU_PER_DEVICE'] as const

function reset(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
  runner.availableMb = 65_536
  runner.unread.clear()
  runner.notebookRuns.length = 0
  for (const name of GPU_ENV) delete process.env[name]
  saveCompetitionSettings({ gpuDevices: null, gpuPerDevice: null })
  useGpuCardProbe(null)
}

let seq = 0

/** A competition with the open example, its sample answer and the answers; `sealed` adds a hidden test. */
function competition(options: { sealed?: boolean; gpu?: boolean; memoryMb?: number } = {}): Competition {
  seq += 1
  const made = createCompetition({
    slug: `split${seq}`,
    title: `Split ${seq}`,
    blurb: '',
    description: '',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    publicPercent: 30,
    limits: { wallSeconds: 600, memoryMb: options.memoryMb ?? 4096, cpus: 2, perDay: 0, ...(options.gpu ? { gpu: true } : {}) },
    environment: options.gpu ? 'base-gpu' : 'base',
  })
  assert.ok(made)
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 20, visibility: 'open' })
  putOpenFile(made.id, 'test.csv', enc('id,feature\n1,0.5\n2,0.7\n'))
  putFile({ competitionId: made.id, name: 'test.csv', bytes: 23, visibility: 'open' })
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  if (options.sealed) {
    putSealedFile(made.id, 'test.csv', enc('id,feature\n101,KANAREIKA-a\n102,KANAREIKA-b\n'))
    putFile({ competitionId: made.id, name: 'test.csv', bytes: 44, visibility: 'sealed' })
  }
  return made
}

/** A notebook of plain code cells, sent by a person of its own at `at`. */
function send(c: Competition, sources: string[], at = NOW): Submission {
  const entrant = createEntrant(`Участник ${seq}-${sources.length}-${at}`).entrant
  const submission = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100, at })
  putSubmissionNotebook(c.id, submission.id, enc(JSON.stringify({
    cells: sources.map((source) => ({ cell_type: 'code', source, metadata: {}, outputs: [] })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })))
  return submission
}

/* ------------------------------------------------- recording and comparing */

interface Fixture {
  recordedFrom: string
  columns: Record<Table, string[]>
  scenarios: Record<string, { writes: unknown[]; files: Record<string, Record<string, string>> }>
}

const recorded: Fixture = { recordedFrom: 'runNotebookThenScore at 03a65bb, before the split', columns: COLUMNS, scenarios: {} }
const fixture: Fixture | null = RECORD ? null : JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture

after(() => {
  if (!RECORD) return
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
  const lines = Object.entries(recorded.scenarios).map(([name, scenario]) =>
    `    ${JSON.stringify(name)}: {\n      "writes": [\n${scenario.writes.map((write) => `        ${JSON.stringify(write)}`).join(',\n')}\n      ],\n      "files": ${JSON.stringify(scenario.files)}\n    }`)
  fs.writeFileSync(FIXTURE, `{\n  "recordedFrom": ${JSON.stringify(recorded.recordedFrom)},\n  "columns": ${JSON.stringify(recorded.columns)},\n  "scenarios": {\n${lines.join(',\n')}\n  }\n}\n`)
})

/**
 * One scenario: `setup` makes the submissions (their upload is not what is
 * compared), `body` runs them, and the writes from the first take to the end
 * are compared with the fixture — or recorded into it.
 */
function scenario(name: string, setup: () => Submission[] | Promise<Submission[]>, body: (sent: Submission[]) => Promise<void>): void {
  test(`a run here writes what it wrote before the split: ${name}`, async () => {
    reset()
    try {
      const sent = await setup()
      const from = mark()
      const base = new Map<string, Record<string, unknown>>()
      for (const submission of sent) {
        base.set(`submissions:${submission.id}`, db.prepare('SELECT * FROM submissions WHERE id = ?').get(submission.id) as Record<string, unknown>)
        const queued = db.prepare('SELECT * FROM competition_queue WHERE submission_id = ?').get(submission.id) as Record<string, unknown> | undefined
        if (queued) base.set(`competition_queue:${submission.id}`, queued)
      }
      await body(sent)
      await settleCompetitionWork()
      const entries = loggedSince(from)
      const files = Object.fromEntries(sent.map((submission, index) => [`#${index + 1}`, filesOf(submission.competitionId, submission.id)]))
      if (RECORD) {
        recorded.scenarios[name] = { writes: normalize(entries, base, COLUMNS), files }
        return
      }
      const expected = fixture!.scenarios[name]
      assert.ok(expected, `the fixture has no scenario "${name}"`)
      assert.deepEqual(normalize(entries, base, fixture!.columns), expected.writes)
      assert.deepEqual(files, expected.files)
      /*
       * What the columns added since the recording must hold on a run of this
       * server: no machine holds its row and none lost it (competition_queue
       * holder, lost), and no notebook run names a revision (submission_runs
       * revision_id names only the one a metric scored in).
       */
      for (const entry of entries) {
        if (entry.op === 'DELETE') continue
        if (entry.table === 'competition_queue') {
          assert.equal(entry.row.holder ?? null, null, 'a row this server runs has no holder')
          assert.equal(entry.row.lost ?? 0, 0, 'and nothing lost it')
        }
        if (entry.table === 'submission_runs' && entry.row.kind === 'notebook') assert.equal(entry.row.revision_id ?? null, null)
      }
    } finally {
      reset()
    }
  })
}

/** Run everything the queue holds, the way the pump does. */
const drain = async () => {
  await drainCompetitionQueue()
}

/** Directives of the stand-in runner (fake-runner.ts), one per notebook. */
const directive = (asked: Record<string, unknown>): string => `# colloq-test: ${JSON.stringify(asked)}`

/* ------------------------------------------------------- on the CPU, open data */

scenario('scored, with an executed notebook', () => [send(competition(), [directive({ executed: true }), 'x = 1', 'y = 2'])], drain)
scenario('a cell fails with its traceback', () => [send(competition(), [directive({ status: 'cell_error', cell: 4, detail: 'Traceback (most recent call last):\n  Cell In[5], line 1\nZeroDivisionError: division by zero' }), 'a', 'b', 'c', 'd', 'e'])], drain)
scenario('a cell fails on a module that is not there', () => [send(competition(), [directive({
  status: 'cell_error', cell: 3,
  detail: "---------------------------------------------------------------------------\nModuleNotFoundError                       Traceback (most recent call last)\nCell In[4], line 1\n----> 1 import lightgbm as lgb\n\nModuleNotFoundError: No module named 'lightgbm'",
}), 'a', 'b', 'import lightgbm as lgb'])], drain)
scenario('the time limit', () => [send(competition(), [directive({ status: 'timeout', cell: 6 }), 'a'])], drain)
scenario('stopped early at its limit', () => [send(competition(), [directive({ status: 'cell_timeout', cell: 2 }), 'a', 'b'])], drain)
scenario('out of memory', () => [send(competition(), [directive({ status: 'oom', cell: 2 }), 'a', 'b'])], drain)
scenario('the kernel died before the first cell', () => [send(competition(), [directive({ status: 'kernel_died', cell: -1 })])], drain)
scenario('the notebook exited', () => [send(competition(), [directive({ status: 'exit', cell: 1 }), 'a'])], drain)
scenario('no answer written', () => [send(competition(), [directive({ status: 'no_submission' }), 'a'])], drain)
scenario('an answer too large', () => [send(competition(), [directive({ status: 'target_too_large' }), 'a'])], drain)
scenario('an answer that does not parse', () => [send(competition(), [directive({ status: 'target_unreadable', detail: 'Error tokenizing data. C error: Expected 2 fields in line 3, saw 4' }), 'a'])], drain)
scenario('the harness failed', () => [send(competition(), [directive({ status: 'harness_error' }), 'a'])], drain)
scenario('the metric refuses the answer', () => [send(competition(), [directive({ metric: 'participant_error' }), 'a'])], drain)
scenario('the metric crashes', () => [send(competition(), [directive({ metric: 'metric_error' }), 'a'])], drain)

scenario('cancelled by the teacher while it runs', () => [send(competition(), [directive({ hold: 60_000 }), 'a'])], async ([sent]) => {
  assert.equal(await pumpOnce(), 1)
  await until(() => runner.notebookRuns.some((run) => run.submissionId === sent.id))
  assert.equal(await cancelSubmission(sent.id, 'teacher'), true)
  await settleCompetitionWork()
})

scenario('a rescore', async () => {
  const sent = send(competition(), ['x = 1'])
  await drainCompetitionQueue()
  assert.equal(getSubmission(sent.id)?.state, 'scored')
  return [sent]
}, async ([sent]) => {
  assert.equal(rescoreCompetition(sent.competitionId), 1)
  await drain()
})

scenario('a rescore asked while a rerun of the notebook runs', async () => {
  const sent = send(competition(), [directive({ hold: 300 }), 'x = 1'])
  await drainCompetitionQueue()
  assert.equal(getSubmission(sent.id)?.state, 'scored')
  return [sent]
}, async ([sent]) => {
  assert.equal(rerunSubmission(sent.id), true)
  assert.equal(await pumpOnce(), 1)
  await until(() => runner.notebookRuns.filter((run) => run.submissionId === sent.id).length === 2)
  assert.equal(rescoreCompetition(sent.competitionId), 1)
  assert.equal(queueRow(sent.id)?.pendingKind, 'metric')
  await settleCompetitionWork()
  await drain()
})

/* ------------------------------------------------------------ the hidden test */

scenario('on the hidden test: scored', () => [send(competition({ sealed: true }), [directive({ read: 'test.csv' }), 'a'])], drain)
scenario('on the hidden test: a traceback that would carry the hidden rows', () => [send(competition({ sealed: true }), [directive({ status: 'cell_error', cell: 0, detailFrom: 'test.csv' }), 'a'])], drain)
scenario('on the hidden test: numbers held to the notebook sent', () => [send(competition({ sealed: true }), [directive({ status: 'cell_error', cell: 99, detail: 'ValueError: 48213 of 99999' }), 'a'])], drain)
scenario('on the hidden test: the metric refuses the answer', () => [send(competition({ sealed: true }), [directive({ metric: 'participant_error', echo: true }), 'a'])], drain)

/* ---------------------------------------------------------------- package sets */

scenario('a package set that no longer fits the submission', () => {
  const MiB = 1024 * 1024
  const c = competition({ memoryMb: 2048 })
  setCompetitionState(c.id, 'live')
  const revision = putRevision({
    environmentName: 'base', imageDigest: `sha256:${'e'.repeat(64)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/arm64', packages: [{ name: 'numpy', version: '2.4.6' }], baseConstraintsHash: 'hash',
  })
  selectRevision(c.id, revision.id)
  setPolicy(c.id, { enabled: true })
  const sent = send(c, ['import catboost'])
  const set = createBundle(c.id, sent.entrantId, revision.id, 'catboost')
  completeBundle(set.id, {
    normalizedRequirements: ['catboost'], downloadBytes: 1, installedBytes: 315 * MiB, contentHash: '3'.repeat(64),
    packages: [{ name: 'catboost', version: '1.2.10', fileName: 'catboost-1.2.10-py3-none-any.whl', sha256: '4'.repeat(64), bytes: 1 }],
    lock: `catboost==1.2.10 --hash=sha256:${'4'.repeat(64)}\n`,
  })
  bindSubmission(sent.id, revision.id, set.id)
  updateCompetition(c.id, { limits: { ...c.limits, memoryMb: 512 } })
  return [sent]
}, drain)

/* --------------------------------------------------------------------- cards */

/** One card, shared by `perDevice` runs, that says its size when `gate` lets it. */
function cards(perDevice: number, gate: Promise<void> = Promise.resolve()): void {
  process.env.KERNEL_GPUS = '0'
  process.env.COMPETITION_GPUS = '0'
  process.env.COMPETITION_GPU_PER_DEVICE = String(perDevice)
  useGpuCardProbe(async (devices) => {
    await gate
    return new Map(devices.map((device) => [device, RTX]))
  })
}

scenario('on a shared card: scored', () => {
  cards(2)
  return [send(competition({ gpu: true }), ['model.fit()'])]
}, drain)

scenario('on a shared card: stopped for going past its share', () => {
  cards(2)
  return [send(competition({ gpu: true }), [directive({ status: 'oom', killedBy: 'gpu', cell: 0 }), 'model.fit()'])]
}, drain)

scenario('on a shared card: crowded out by a neighbour nobody could read, back to the queue once', () => {
  cards(2)
  setQueueSlots(8)
  const c = competition({ gpu: true })
  const victim = send(c, [directive({ status: 'cell_error', hold: 100, detail: 'Traceback (most recent call last):\n  Cell In[3], line 1\nOutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB.' }) + '\nmodel.fit()'], NOW + 1)
  const neighbour = send(c, [directive({ hold: 600 }) + '\nmodel.fit()'], NOW + 2)
  runner.unread.add(neighbour.id)
  return [victim, neighbour]
}, async ([victim, neighbour]) => {
  assert.equal(await pumpOnce(), 2)
  await until(() => queueRow(neighbour.id) === null && queueRow(victim.id)?.state === 'waiting')
})

let releaseCard = () => {}
scenario('on a card the owner takes back before the start', () => {
  const gate = new Promise<void>((resolve) => (releaseCard = resolve))
  cards(1, gate)
  return [send(competition({ gpu: true }), [directive({ hold: 60_000 }), 'model.fit()'])]
}, async ([sent]) => {
  assert.equal(await pumpOnce(), 1)
  saveCompetitionSettings({ gpuDevices: [] })
  releaseCard()
  await until(() => queueRow(sent.id)?.state === 'waiting')
})

scenario('cancelled while it waits for its card', () => {
  const gate = new Promise<void>((resolve) => (releaseCard = resolve))
  cards(1, gate)
  return [send(competition({ gpu: true }), [directive({ hold: 60_000 }), 'model.fit()'])]
}, async ([sent]) => {
  assert.equal(await pumpOnce(), 1)
  assert.equal(await cancelSubmission(sent.id, 'teacher'), true)
  releaseCard()
  await until(() => queueRow(sent.id) === null)
})
