/**
 * The second review of «Машины для посылок» in the panel (Paper 16 · M1–M7):
 * each test is one finding (review-r2 #N) and fails on the code as it stood
 * before its fix.
 *
 * As in admin-runners-ui.test.mts, the decisions live in
 * web/src/admin/runners.ts and web/src/admin/competitions.ts and are checked
 * directly, in both languages where a word could slip; the screens are read
 * from their files, comments stripped, for the wiring. Where a finding is
 * about what the panel says over what the server holds, the server is the
 * real one (the app over HTTP, a stand-in machine speaking the contract,
 * tests/_remote.mts) and the panel's own words are asked about its answer:
 * a test with its own copy of the server's picture passes forever while the
 * two drift.
 *
 * What these guard is a screen that acted, or spoke, past what is so: a
 * stop that threw a finished result away, «3 из 1» places, «посчитает
 * сервер» over a server with no card for the competition, a resume that
 * resumes nothing, «Ждём первую машину» over the machine that joined, a
 * copy button over an empty command, a code said to be gone that stays
 * valid for a day.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { setLocaleResolver, translate } from '../shared/i18n.js'
import { STAFF_COOKIE, type RunningKernels } from '../shared/admin.js'
import type {
  MintRemoteCodeResponse,
  RemoteCodeView,
  RemoteCompetitionWhere,
  RemoteConsoleGroup,
  RemoteMachine,
  RemoteMachinesResponse,
  RemoteWhereMachine,
} from '../shared/remote-admin.js'
import type { CompetitionLive, CompetitionView, QueueSnapshot, RunningNow } from '../shared/competitions-api.js'
import type { CompetitionSettings } from '../shared/competitions-settings.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { getSubmission, queueRow } from '../server/src/competitions/store.js'
import { getLease } from '../server/src/competitions/remote/store.js'
import { AdminApiError, adminApi } from '../web/src/lib/adminApi.js'
import {
  codeMachines,
  codeWords,
  connectProgress,
  consoleLoad,
  homeOnlyBox,
  homeRuns,
  joinCommands,
  machineMenu,
  metricLaneHead,
  readinessLine,
  runnersApi,
  sealedWarning,
  stopRemoteRuns,
  stoppableOnMachine,
  waitReason,
  waitingLine,
  whereRow,
} from '../web/src/admin/runners.js'
import { metricImageGone, metricImageNote, moveMetricOutcome, moveMetricQuestion } from '../web/src/admin/competitions.js'
import { ANSWER, Machine, close, competition, finished, reset, send, serve, type TestCompetition } from './_remote.mts'

useCompetitionRunner(new FakeCompetitionRunner())

after(() => close())
afterEach(() => setLocaleResolver(() => 'ru'))

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const flat = (source: string): string => source.replace(/\s+/g, ' ')
/** The copy keeps non-breaking spaces between numbers and units; compare the words. */
const plain = (text: string | null | undefined): string | null => (text == null ? null : text.replace(/[  ]/g, ' '))
const CYRILLIC = /[А-Яа-яЁё]/

const LIVE = flat(code(read('web/src/admin/screens/competitions/Live.svelte')))
const EDITOR = flat(code(read('web/src/admin/screens/competitions/Editor.svelte')))
const RUNNERS = flat(code(read('web/src/admin/ui/Runners.svelte')))
const CONNECT = flat(code(read('web/src/admin/ui/ConnectMachine.svelte')))
const PAGE = flat(code(read('web/src/admin/screens/RemoteMachine.svelte')))
const RUNNING = flat(code(read('web/src/admin/ui/RunningKernels.svelte')))
const RESOURCES = flat(code(read('web/src/admin/screens/ResourcesTab.svelte')))

/* ------------------------------------------------------------- the owner */

function staff(role: 'owner' | 'teacher'): string {
  const made = createTeacher({ name: role === 'owner' ? 'Владелица r2' : 'Преподаватель r2', email: `${role}.r2.${Date.now()}.${Math.random()}@example.edu`, role })!
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return `${STAFF_COOKIE}=${value}`
}

const owner = staff('owner')

async function admin<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const home = await serve()
  const answer = await fetch(`${home}${path}`, {
    method,
    headers: { cookie: owner, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: answer.status, body: (await answer.json()) as T }
}

/** The panel's kill, as adminApi.killCompetitionRun sends it, against the real door: a refusal is an AdminApiError, as the panel reads it. */
function killer(onMachine: boolean): (id: string) => Promise<unknown> {
  return async (id) => {
    const answer = await admin<{ error?: string; reason?: string }>('POST', '/api/admin/competitions/queue/kill', onMachine ? { submissionId: id, onMachine: true } : { submissionId: id })
    if (answer.status !== 200) throw new AdminApiError(answer.body.error ?? 'refused', answer.status, (answer.body.reason ?? 'conflict') as never)
    return answer.body
  }
}

const cardsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ device: String(i), name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564, perDevice: 2, busyShares: 0 }))

/** A machine joined with a code the owner minted in the panel, its first sync's wants for `c` in place. */
async function machineFor(c: TestCompetition | null, options: { trusted?: boolean; cards?: number } = {}): Promise<{ m: Machine; minted: MintRemoteCodeResponse; ready: { revisions: string[]; data: string[]; sealed: string[]; bundles: string[] } }> {
  const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { machines: 1, hours: 1, trusted: options.trusted ?? false, approvedSlots: null })
  assert.equal(minted.status, 200)
  const m = new Machine(await serve())
  assert.equal((await m.join(minted.body.code)).status, 200)
  const first = await m.sync({ cards: cardsOf(options.cards ?? 0) })
  const ready = {
    revisions: c ? [c.revisionId] : [],
    data: c ? [...new Set(first.body.want.data.filter((entry) => entry.competitionId === c.id && !entry.sealed).map((entry) => entry.manifest))] : [],
    sealed: c ? [...new Set(first.body.want.data.filter((entry) => entry.competitionId === c.id && entry.sealed).map((entry) => entry.manifest))] : [],
    bundles: [] as string[],
  }
  return { m, minted: minted.body, ready }
}

/* ------------------------------------------------------ fetch, stubbed */

interface Call {
  url: string
  method: string
  body: unknown
}

/** fetch replaced for one test: every call recorded, every answer the one given. */
function stubFetch(answer: (call: Call) => Response): { calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

/* =========================================== #32 / #37 — the console's places */

function run(id: string, fields: Partial<RunningNow> = {}): RunningNow {
  return {
    submissionId: id, competitionId: 'c', competitionSlug: 'c', entrantId: `e-${id}`, entrantName: id, number: 1,
    fileName: 'solution.ipynb', kind: 'notebook', cellsDone: 0, cellsTotal: 14, startedAt: 0, limitMs: 60_000, container: null,
    baseline: false, gpu: null, ...fields,
  }
}

// First in the file: a server that never had a machine (no console groups), as every single server is.
test('#32 #37 a single server counts its notebook places by notebooks, and the metric lane apart: never «3 ИЗ 1»', async () => {
  const { setQueuePaused } = await import('../server/src/competitions/store.js')
  const { setQueueSlots } = await import('../server/src/competitions/runner.js')
  const { anyRunnerEver } = await import('../server/src/competitions/remote/store.js')
  const { db } = await import('../server/src/db.js')
  assert.equal(anyRunnerEver(), false, 'no machine yet in this file')
  reset({ homeNotebooks: true })
  setQueuePaused(true)
  setQueueSlots(1)
  try {
    const c = competition()
    const notebook = send(c)
    const rescores = [send(c), send(c)]
    const now = Date.now()
    db.prepare("UPDATE competition_queue SET state = 'running', kind = 'notebook', started_at = ?, attempt_id = 'a-notebook' WHERE submission_id = ?").run(now, notebook.id)
    rescores.forEach((one, i) => db.prepare("UPDATE competition_queue SET state = 'running', kind = 'metric', started_at = ?, attempt_id = ? WHERE submission_id = ?").run(now, `a-metric-${i}`, one.id))
    const queue = (await admin<QueueSnapshot>('GET', '/api/admin/competitions/queue')).body
    assert.equal(queue.groups, undefined)
    assert.equal(queue.slots, 1)
    assert.equal(queue.running.length, 3, 'the metric lane\'s runs are in the snapshot too')
    const load = consoleLoad(queue.running, queue.groups ?? null)
    // The header: one notebook place, one taken; the two metrics beside it.
    assert.equal(plain(translate('ru', 'admin.competitions.slotsHead', { busy: load.busy, count: queue.slots })), 'ИСПОЛНИТЕЛИ · 1 ИЗ 1 ЗАНЯТ')
    assert.equal(metricLaneHead(load), 'МЕТРИКИ · 2')
    // The plain grid: free notebook cells from notebook runs only.
    assert.equal(Math.max(0, 3 - load.homeNotebooks), 2, 'three places, one notebook, two metrics: two free cells')
  } finally {
    setQueuePaused(false)
    setQueueSlots('auto')
  }
  // The screen counts by it.
  assert.match(LIVE, /const load = \$derived\(consoleLoad\(running, machineGroups\)\)/)
  assert.match(LIVE, /const freeSlots = \$derived\(Math\.max\(0, slots - load\.homeNotebooks\)\)/)
  assert.match(LIVE, /tr\('admin\.competitions\.slotsHead', \{ busy: load\.busy, count: slots \}\)/)
  assert.match(LIVE, /busy: load\.busy, count: slots, gpuBusy: queue\.gpu\.busy, gpuCount: queue\.gpu\.slots,/)
  assert.match(LIVE, /\{#if metricHead\} <span class="admin-label text-positive">\{metricHead\}<\/span> \{\/if\}/)
  assert.doesNotMatch(LIVE, /busy: running\.length/, 'no header counts every run against the notebook places')
})

test('#37 with machines the header counts this server\'s notebooks and live machines\' runs; the metric lane\'s places when the server says them', () => {
  const home: RemoteConsoleGroup = { machineId: null, name: null, state: null, places: 2, busy: 1, cards: null }
  const groups: RemoteConsoleGroup[] = [
    home,
    { machineId: 'live', name: 'vast-1', state: 'online', places: 4, busy: 2, cards: null },
    { machineId: 'quiet', name: 'vast-2', state: 'silent', places: 0, busy: 1, cards: null },
  ]
  const running = [
    run('n1'),
    run('m1', { kind: 'metric' }),
    run('r1', { machine: { id: 'live', name: 'vast-1' } }),
    run('r2', { machine: { id: 'live', name: 'vast-1' } }),
    run('s1', { machine: { id: 'quiet', name: 'vast-2' } }),
  ]
  // slots = 2 here + 4 on the live machine: a silent machine's run is not in them, nor a metric.
  assert.deepEqual(consoleLoad(running, groups), { busy: 3, homeNotebooks: 1, metrics: 1, metricPlaces: null })
  // This server only scores: its notebook places are none, and the metric lane's are said.
  const scoring: RemoteConsoleGroup = { ...home, places: 0, busy: 0, metricsOnly: true, metric: { places: 2, busy: 1 } }
  const onlyMetrics = consoleLoad([run('m1', { kind: 'metric' }), run('r1', { machine: { id: 'live', name: 'vast-1' } })], [scoring, groups[1]])
  assert.deepEqual(onlyMetrics, { busy: 1, homeNotebooks: 0, metrics: 1, metricPlaces: 2 })
  assert.equal(metricLaneHead(onlyMetrics), 'МЕТРИКИ · 1 ИЗ 2')
  assert.equal(metricLaneHead({ metrics: 0, metricPlaces: 2 }), null, 'nothing in the lane, nothing said')
  setLocaleResolver(() => 'en')
  assert.equal(metricLaneHead(onlyMetrics), 'METRICS · 1 OF 2')
})

/* ================================== #35 — a stop only reaches runs still on a machine */

test('#35 «Остановить» over a run whose notebook finished meanwhile counts it as ended, and its result is scored, not cancelled', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, ready } = await machineFor(c)
  const lease = (await m.sync({ ready })).body.leases[0]
  assert.equal(lease.submissionId, sent.id)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 1000 }] })
  // «Работают сейчас» read while the run was on the machine: the dialog keeps these ids.
  const running = (await admin<RunningKernels>('GET', '/api/admin/resources/running')).body
  const ids = [...running.remote!.find((one) => one.competitionId === c.id)!.submissionIds]
  assert.deepEqual(ids, [sent.id])
  // The notebook finishes on the machine and its result is applied: a metric row waiting here.
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  assert.equal(((await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))).body as { result: string }).result, 'applied')
  assert.deepEqual([queueRow(sent.id)?.kind, queueRow(sent.id)?.state, queueRow(sent.id)?.holder], ['metric', 'waiting', null])
  // The owner confirms the stale dialog, through the door as the panel calls it.
  const tally = await stopRemoteRuns(ids, killer(true))
  assert.deepEqual(tally, { stopped: 0, ended: 1, error: null })
  assert.notEqual(getSubmission(sent.id)?.state, 'cancelled', 'the finished notebook\'s result is not thrown away')
  assert.equal(queueRow(sent.id)?.kind, 'metric')
  const { drainCompetitionQueue } = await import('../server/src/competitions/runner.js')
  await drainCompetitionQueue()
  assert.equal(getSubmission(sent.id)?.state, 'scored')
})

test('#35 a stop on a machine still reaches a run there, and refuses one past its container (exporting, uploading)', async () => {
  reset()
  const c = competition()
  const first = send(c)
  const second = send(c)
  const { m, ready } = await machineFor(c)
  const leases = (await m.sync({ ready })).body.leases
  assert.equal(leases.length, 2)
  const [running, uploading] = leases
  await m.sync({
    seq: Math.max(...leases.map((one) => one.seq)),
    ready,
    attempts: [
      { id: running.attemptId, phase: 'running', runningMs: 1000 },
      { id: uploading.attemptId, phase: 'uploading', runningMs: 2000 },
    ],
  })
  const tally = await stopRemoteRuns([running.submissionId, uploading.submissionId], killer(true))
  assert.deepEqual(tally, { stopped: 1, ended: 1, error: null })
  assert.equal(getLease(running.attemptId)?.state, 'revoked', 'a durable cancel of the run still on the machine')
  assert.notEqual(getLease(uploading.attemptId)?.state, 'revoked', 'its answer is on the way: left to arrive')
  assert.notEqual(getSubmission(uploading.submissionId)?.state, 'cancelled')
  // The refusal says why, in words.
  const refused = await admin<{ error: string }>('POST', '/api/admin/competitions/queue/kill', { submissionId: uploading.submissionId, onMachine: true })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, translate('ru', 'competitions.refusal.notOnMachine'))
  // The console's own kill, without the flag, is as it always was.
  assert.equal((await killer(false)(uploading.submissionId) as { killed: boolean }).killed, true)
  void first
  void second
})

test('#35 the panel sends the flag from every stop aimed at a machine, and offers none past a container', async () => {
  const fake = stubFetch(() => json({ killed: true }))
  try {
    await adminApi.killCompetitionRun('s1', { onMachine: true })
    await adminApi.killCompetitionRun('s2')
  } finally {
    fake.restore()
  }
  assert.deepEqual(fake.calls.map((call) => [call.method, call.url, call.body]), [
    ['POST', '/api/admin/competitions/queue/kill', { submissionId: 's1', onMachine: true }],
    ['POST', '/api/admin/competitions/queue/kill', { submissionId: 's2' }],
  ])
  for (const phase of ['accepted', 'preparing', 'running', undefined, null] as const) assert.equal(stoppableOnMachine(phase), true, String(phase))
  for (const phase of ['exporting', 'uploading'] as const) assert.equal(stoppableOnMachine(phase), false, phase)
  // «Работают сейчас», a machine's page, a machine's cell in the console.
  assert.match(RUNNING, /stopRemoteRuns\(current\.ids, \(id\) => adminApi\.killCompetitionRun\(id, \{ onMachine: true \}\)\)/)
  assert.match(PAGE, /adminApi\.killCompetitionRun\(item\.submissionId, \{ onMachine: true \}\)/)
  assert.match(PAGE, /\{#if stoppableOnMachine\(item\.phase\)\} <button/)
  assert.match(LIVE, /adminApi\.killCompetitionRun\(run\.submissionId, \{ onMachine: !!run\.machine \}\)/)
  assert.match(LIVE, /\{#if !run\.hidden && \(!run\.machine \|\| stoppableOnMachine\(run\.remotePhase\)\)\}/)
  assert.match(LIVE, /onclick=\{\(\) => void kill\(run\)\}/)
})

/* ======================== #36 — no «посчитает сервер» over a server with no card */

const WHERE: RemoteCompetitionWhere = {
  home: { notebooks: true, places: 7 },
  machines: [{ id: 'vastroaa', name: 'vast-4090-ro', verdict: 'home_only', places: 4, cards: 2, trusted: true }],
  registry: ['base', 'base-gpu', 'kaggle-gpu'],
  homeOnly: true,
  cards: { recent: 1, last: { name: 'vast-4090-ro', at: Date.now() }, sliceMb: 12_282 },
}

test('#36 a GPU competition on a server with no card of its own: nobody runs an environment only it has, and the hidden test waits', () => {
  // The server's rule (remote/views.ts · blockedBy): with the card on and no card here, this server runs none of them.
  assert.equal(homeRuns(WHERE, { gpu: true, homeCards: 0 }), false)
  assert.equal(homeRuns(WHERE, { gpu: true, homeCards: 2 }), true)
  assert.equal(homeRuns(WHERE, { gpu: false, homeCards: 0 }), true, 'a CPU competition needs no card')
  assert.equal(homeRuns(WHERE, { gpu: true, homeCards: null }), true, 'not known yet: the server\'s word stands')
  const box = homeOnlyBox(WHERE, 'my-gpu', { gpu: true, homeCards: 0 })
  assert.doesNotMatch(box, /Посылки посчитает сервер/)
  assert.match(box, /^Эти посылки никто не посчитает: на этом сервере нет карты для посылок, а машины среду my-gpu не получат\. Выберите среду из реестра — base, base-gpu и kaggle-gpu —/)
  assert.match(homeOnlyBox({ ...WHERE, registry: [] }, 'my-gpu', { gpu: true, homeCards: 0 }), /Нужна среда, образ которой есть в реестре/)
  // With a card here, as before.
  assert.match(homeOnlyBox(WHERE, 'my-gpu', { gpu: true, homeCards: 1 }), /^Посылки посчитает сервер: 7 мест/)
  // The row's chip: this server only scores this competition.
  assert.equal(whereRow(WHERE, { gpu: true, draft: false, homeOnly: true, homeCards: 0 }).home, 'сервер · метрика')
  assert.equal(whereRow(WHERE, { gpu: true, draft: false, homeOnly: true, homeCards: 1 }).home, 'только этот сервер')
  // Warning 2: nobody runs the hidden test here, so it waits — in red, not «посчитает только сервер».
  const sealed = sealedWarning(WHERE, { homeOnly: true, gpu: true, homeCards: 0 })
  assert.deepEqual(sealed, { trusted: [], text: translate('ru', 'admin.competitions.where.sealedWaitsNoCard'), tone: 'danger' })
  // A registry environment and a trusted machine taking it: the machines alone, not «сервер и доверенные машины».
  const taking: RemoteCompetitionWhere = { ...WHERE, homeOnly: false, machines: [{ ...WHERE.machines[0], verdict: 'taking' }] }
  assert.equal(sealedWarning(taking, { gpu: true, homeCards: 0 }).text, translate('ru', 'admin.competitions.where.sealedTrusted'))
  assert.equal(sealedWarning(taking, { gpu: true, homeCards: 1 }).text, translate('ru', 'admin.competitions.where.sealedTrustedHome'))
  setLocaleResolver(() => 'en')
  assert.match(homeOnlyBox(WHERE, 'my-gpu', { gpu: true, homeCards: 0 }), /^Nobody will run these submissions: this server gives no GPU to submissions/)
  // The editor tells the warnings how many cards this server gives submissions.
  assert.match(EDITOR, /const homeCards = \$derived\(runnerCards\?\.devices\.length \?\? environmentGpus\?\.runners \?\? null\)/)
  assert.match(EDITOR, /whereRow\(where, \{ gpu: gpuOn, draft: draftState, homeOnly, unsaved: environmentUnsaved, homeCards \}\)/)
  assert.match(EDITOR, /sealedWarning\(where, \{ homeOnly, unsaved: environmentUnsaved, gpu: gpuOn, homeCards \}\)/)
  assert.match(EDITOR, /\{homeOnlyBox\(where, environment, \{ gpu: gpuOn, homeCards \}\)\}/)
})

test('#36 on the real server: notebooks on, no card here, a machine with cards online — the editor no longer says this server runs them', async () => {
  reset({ homeNotebooks: true })
  try {
    const { runnerGpuDevices } = await import('../server/src/competitions/gpu.js')
    assert.equal(runnerGpuDevices().length, 0)
    const c = competition({ gpu: true, local: true, sealed: true })
    const { m } = await machineFor(null, { trusted: true, cards: 2 })
    await m.sync({ cards: cardsOf(2), free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 4, diskMb: 100_000 } })
    const view = (await admin<CompetitionView>('GET', `/api/admin/competitions/${c.id}`)).body
    const settings = (await admin<CompetitionSettings>('GET', '/api/admin/competitions/settings')).body
    const where = view.where!
    assert.equal(where.home.notebooks, true, 'the server\'s picture: notebooks on')
    const homeCards = settings.gpu.devices.length
    assert.equal(homeCards, 0)
    assert.doesNotMatch(homeOnlyBox(where, c.environment, { gpu: true, homeCards }), /Посылки посчитает сервер/)
    assert.doesNotMatch(sealedWarning(where, { homeOnly: where.homeOnly, gpu: true, homeCards }).text, /посчитает только сервер/)
    assert.equal(whereRow(where, { gpu: true, draft: false, homeOnly: where.homeOnly, homeCards }).home, 'сервер · метрика')
  } finally {
    reset()
  }
})

/* ================== #38 — home_only_env names the cause the server meant */

test('#38 «только метрики» is said only over a server that runs no notebooks; with them on, the cause is the card', async () => {
  assert.equal(waitReason({ reason: 'home_only_env' }, { notebooks: true })?.text, 'среда есть только на сервере, а карты для посылок здесь нет')
  assert.equal(waitReason({ reason: 'home_only_env' }, { notebooks: false })?.text, 'среда есть только на сервере, а он считает только метрики')
  assert.equal(waitReason({ reason: 'home_only_env' })?.text, 'среда есть только на сервере, а он считает только метрики', 'no groups: reasons come only with notebooks off')
  assert.equal(waitingLine({ reason: 'home_only_env' }, true, { notebooks: true })?.text, 'среда есть только на сервере, а карты для посылок здесь нет')
  // On the real server: the row's reason, and this server's group as the console reads it.
  reset({ homeNotebooks: true })
  try {
    const c = competition({ gpu: true, local: true })
    const { m } = await machineFor(null, { cards: 2 })
    await m.sync({ cards: cardsOf(2), free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 4, diskMb: 100_000 } })
    const sent = send(c)
    const live = (await admin<CompetitionLive>('GET', `/api/admin/competitions/${c.id}/live`)).body
    const row = live.waiting.find((one) => one.submissionId === sent.id)!
    assert.equal(row.reason, 'home_only_env')
    const home = live.queue.groups!.find((group) => group.machineId === null)!
    assert.doesNotMatch(waitReason(row, { notebooks: home.metricsOnly !== true })!.text, /только метрики/)
  } finally {
    reset()
  }
  assert.match(LIVE, /const homeWord = \$derived\(homeGroup \? \{ notebooks: homeGroup\.metricsOnly !== true \} : null\)/)
  assert.match(LIVE, /waitingLine\(row, waitsForCard\(row, queue\), homeWord\)/)
  setLocaleResolver(() => 'en')
  assert.equal(waitReason({ reason: 'home_only_env' }, { notebooks: true })?.text, 'its environment is on this server only, and this server gives no GPU to submissions')
})

/* ===================== #39 — a machine that drains itself is not «returned to work» */

test('#39 a machine draining by its own word offers «Осушить», not a resume that changes nothing; the owner\'s drain still offers resume', async () => {
  reset()
  const { m } = await machineFor(null)
  await m.sync({ state: 'draining' })
  let machine = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body.machines.find((one) => one.id === m.runnerId)!
  assert.equal(machine.state, 'draining')
  assert.equal(machine.selfDrain, 'draining')
  assert.deepEqual([machineMenu(machine).resume, machineMenu(machine).drain], [false, true])
  const line = readinessLine(machine, null, null)
  assert.equal(line.lead, 'останавливается сама: новых посылок не берёт')
  assert.doesNotMatch(line.detail ?? '', /вернуть в работу/)
  // The owner drains it as well: the drain is theirs now, and so is the resume.
  assert.equal((await admin('POST', `/api/admin/runners/${m.runnerId}/drain`)).status, 200)
  machine = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body.machines.find((one) => one.id === m.runnerId)!
  assert.equal(machine.selfDrain, undefined)
  assert.deepEqual([machineMenu(machine).resume, machineMenu(machine).drain], [true, false])
  // Resumed by the owner while the machine still drains itself: the machine's own drain again, no resume to offer.
  assert.equal((await admin('POST', `/api/admin/runners/${m.runnerId}/resume`)).status, 200)
  await m.sync({ state: 'draining' })
  machine = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body.machines.find((one) => one.id === m.runnerId)!
  assert.equal(machine.selfDrain, 'draining')
  assert.equal(machineMenu(machine).resume, false)
  // Active again: nothing of the kind.
  await m.sync({ state: 'active' })
  machine = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body.machines.find((one) => one.id === m.runnerId)!
  assert.deepEqual([machine.state, machine.selfDrain], ['online', undefined])
})

test('#39 a machine leaving with a run held says so, and its page offers no resume either', async () => {
  reset()
  const c = competition()
  send(c)
  const { m, ready } = await machineFor(c)
  const lease = (await m.sync({ ready })).body.leases[0]
  await m.sync({ state: 'leaving', seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 10 }] })
  const detail = (await admin<RemoteMachine>('GET', `/api/admin/runners/${m.runnerId}`)).body
  assert.deepEqual([detail.state, detail.selfDrain], ['draining', 'leaving'])
  assert.equal(machineMenu(detail).resume, false)
  assert.equal(readinessLine(detail, null, null).lead, 'уходит сама: досчитает начатые (1) и отключится')
  setLocaleResolver(() => 'en')
  assert.equal(readinessLine(detail, null, null).lead, 'leaving by itself: finishes the 1 it holds, then disconnects')
  // The page's header takes the same menu.
  assert.match(PAGE, /const menu = \$derived\(machine \? machineMenu\(machine\) : null\)/)
})

/* =============== #42 — «Ждём первую машину» leaves once this code's machine joined */

function newcomer(id: string, codeId: string | null | undefined, createdAt = Date.now()): RemoteMachine {
  return {
    id, name: `vast-${id}`, state: 'online', trusted: false, lastSeenAt: createdAt, silentSince: null, address: null, version: '0.24.0', compatible: true,
    facts: { hostname: null, platform: null, cpus: 8, memoryMb: 32_768, diskMb: null, docker: null, storage: null, driver: null },
    cards: [], places: { approved: null, offered: 4, busy: 0 }, perDevice: null, readiness: [],
    counts: { scored: 0, lost: 0, declined: 0, requeued: 0 }, lastTrouble: null, createdAt,
    ...(codeId === undefined ? {} : { codeId }),
  }
}

test('#42 a one-machine code spent before any read showed it: the dialog names the machine that joined with it', () => {
  const now = Date.now()
  const minted = { id: 'c0de1234c0de1234', machines: 1, expiresAt: now + 24 * 3_600_000 }
  const known = new Set(['oldmachn'])
  // Never seen in the list (spent at once), the code gone from it: its own machine counts.
  const progress = connectProgress(minted, known, [newcomer('oldmachn', 'aaaaaaaaaaaaaaaa'), newcomer('newmachn', minted.id)], [], now, false)
  assert.equal(progress.joined, 1)
  assert.equal(progress.title, 'Все машины подключились')
  assert.match(progress.text, /^Подключилась 1 из 1: vast-newmachn — /)
  // Another code's machine is not this code's, however new.
  const other = connectProgress({ ...minted, machines: 2 }, known, [newcomer('newmachn', minted.id), newcomer('stranger', 'bbbbbbbbbbbbbbbb')], [], now, false)
  assert.deepEqual([other.joined, other.title], [1, 'Ждём остальные машины…'])
  assert.doesNotMatch(other.text, /vast-stranger/)
  // A server that does not say a machine's code: the count of uses, as before.
  assert.equal(codeMachines(minted, [newcomer('newmachn', undefined)]), null)
  assert.equal(connectProgress(minted, known, [newcomer('newmachn', undefined)], [{ id: minted.id, used: 0 }], now, true).joined, 0)
  // The dialog draws by it, and its close asks nothing once its machines joined.
  assert.match(CONNECT, /const progress = \$derived\(minted \? connectProgress\(minted, known, machines, codes, Date\.now\(\), codeSeen\) : null\)/)
  assert.match(CONNECT, /if \(minted && \(progress\?\.joined \?\? 0\) < minted\.machines && !window\.confirm\(tr\('admin\.runners\.connect\.closeConfirm'\)\)\) return/)
})

test('#42 on the real server: a machine carries the id of the code it joined with, and the spent code leaves the list', async () => {
  reset()
  const { m, minted } = await machineFor(null)
  const list = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body
  const joined = list.machines.find((one) => one.id === m.runnerId)!
  assert.equal(joined.codeId, minted.id, 'the machine names its code by the list\'s own id')
  assert.equal(list.codes.some((one) => one.id === minted.id), false, 'a one-machine code is spent')
  const progress = connectProgress(minted, new Set(), list.machines, list.codes, Date.now(), false)
  assert.deepEqual([progress.joined, progress.title], [1, 'Все машины подключились'])
})

/* =============================== #43 #53 — no empty «Арендовать на vast» box */

test('#43 #53 the dialog draws only the commands the server filled in, and says why make vast-runner is missing', () => {
  const own = joinCommands({ docker: 'docker run …', bare: 'curl … | sh', vast: '' })
  assert.deepEqual(own.commands.map((one) => one.key), ['docker', 'bare'])
  assert.equal(own.vastLeftOut, true)
  const all = joinCommands({ docker: 'docker run …', bare: 'curl … | sh', vast: 'make vast-runner COUNT=1 CODE=x URL=y' })
  assert.deepEqual(all.commands.map((one) => one.key), ['docker', 'bare', 'vast'])
  assert.equal(all.vastLeftOut, false)
  assert.ok(all.commands.every((one) => one.text !== ''), 'no box without a command')
  assert.match(CONNECT, /const shown = \$derived\(minted \? joinCommands\(minted\.commands\) : null\)/)
  assert.match(CONNECT, /const COMMANDS = \$derived\(shown\?\.commands \?\? \[\]\)/)
  assert.match(CONNECT, /\{#if shown\?\.vastLeftOut\} <p class="text-2xs text-muted">\{tr\('admin\.runners\.connect\.vastLeftOut'\)\}<\/p> \{\/if\}/)
  assert.match(translate('ru', 'admin.runners.connect.vastLeftOut'), /make vast-runner/)
  assert.doesNotMatch(translate('en', 'admin.runners.connect.vastLeftOut'), CYRILLIC)
})

/* ================================ #45 — Kubernetes with notebooks off */

test('#45 on a broker home with notebooks off, the competitions section says nothing runs and puts the switch back on', () => {
  assert.match(
    RESOURCES,
    /\{#if dockerOnlyIgnored && competitions\.runners\?\.homeNotebooks\.value === false\} <div [^>]*role="status"> <Icon name="alert" size=\{15\} class="shrink-0 text-warning" \/> <p [^>]*> \{homeChoice === true \? tr\('admin\.resourcesTab\.brokerNotebooksPending'\) : tr\('admin\.resourcesTab\.brokerNotebooksOff'\)\} <\/p> \{#if homeChoice !== true\} <button [^>]*onclick=\{\(\) => \{ homeChoice = true typed\('c\.homeNotebooks'\) \}\} > \{tr\('admin\.resourcesTab\.brokerNotebooksOn'\)\} <\/button> \{\/if\} <\/div> \{\/if\}/,
  )
  // Inside the competitions section, which Kubernetes draws; the machines block stays hidden there.
  const section = RESOURCES.slice(RESOURCES.indexOf("tr('admin.resourcesTab.competitionsTitle')"), RESOURCES.indexOf("tr('admin.runners.title')"))
  assert.match(section, /brokerNotebooksOff/)
  assert.match(RESOURCES, /\{#if isOwner && !dockerOnlyIgnored\} <Section title=\{tr\('admin\.runners\.title'\)\}/)
  // What it turns on is what the Save sends: the switch's own field.
  assert.match(RESOURCES, /if \(key === 'c\.homeNotebooks' && homeChoice !== null\) competitionPatch\.homeNotebooks = forgotten\.includes\(key\) \? null : homeChoice/)
  assert.match(translate('ru', 'admin.resourcesTab.brokerNotebooksOff'), /Kubernetes/)
  assert.doesNotMatch(translate('en', 'admin.resourcesTab.brokerNotebooksOff'), CYRILLIC)
})

/* ========================== #29 — the metric's image can be moved from the panel */

test('#29 a metric failed for its gone image is recognised in both languages, and moving it is asked first', () => {
  for (const locale of ['ru', 'en'] as const) {
    assert.equal(metricImageGone(translate(locale, 'competitions.answer.scoringImageGone', { environment: 'kaggle-base', light: 'kaggle-base' })), true, locale)
    assert.equal(metricImageGone(translate(locale, 'competitions.answer.ownScoringImageGone', { environment: 'kaggle-base' })), true, locale)
    assert.equal(metricImageGone(translate(locale, 'competitions.answer.noScoringImage', { environment: 'kaggle-base' })), false, `${locale}: building kaggle-base is that one's advice`)
  }
  assert.equal(metricImageGone('Traceback (most recent call last):\n  File "metric.py", line 9\nKeyError: target'), false)
  assert.equal(metricImageGone(null), false)
  assert.equal(metricImageGone(''), false)
  assert.match(moveMetricQuestion('Буквы на сетке'), /^Перевести метрику «Буквы на сетке» на текущий kaggle-base\? Все посылки соревнования пересчитаются/)
  assert.equal(moveMetricOutcome({ queued: 3 }), 'Метрика переведена на текущий kaggle-base: пересчитываются 3 посылки.')
  assert.equal(moveMetricOutcome({ queued: 1 }), 'Метрика переведена на текущий kaggle-base: пересчитывается 1 посылка.')
  setLocaleResolver(() => 'en')
  assert.equal(moveMetricOutcome({ queued: 5 }), 'The metric now runs in the current kaggle-base: 5 submissions are being rescored.')
})

test('#29 the console and the metric section call the move door, and the client reaches the server\'s door', async () => {
  const fake = stubFetch(() => json({ revisionId: 'rev1', queued: 4 }, 202))
  let answer: { revisionId: string; queued: number }
  try {
    answer = await adminApi.moveCompetitionMetricImage('a/b')
  } finally {
    fake.restore()
  }
  assert.deepEqual(answer, { revisionId: 'rev1', queued: 4 })
  assert.deepEqual([fake.calls[0].method, fake.calls[0].url], ['POST', '/api/admin/competitions/a%2Fb/metric/image'])
  assert.match(read('server/src/routes/admin-competitions.ts'), /router\.post\('\/api\/admin\/competitions\/:id\/metric\/image', requireStaff/)
  // The console: next to a metric that failed for its image, beside the rescore, asked first.
  assert.match(LIVE, /\{#if metricImageGone\(s\.teacherError\)\} <button type="button" class="btn-primary max-w-full text-left" disabled=\{busy\} onclick=\{\(\) => void moveMetric\(\)\} > \{tr\('admin\.competitions\.metricImage\.rowMove'\)\} <\/button> \{\/if\}/)
  assert.match(LIVE, /if \(busy \|\| !window\.confirm\(moveMetricQuestion\(c\.title\)\)\) return const moved = await act\(\(\) => adminApi\.moveCompetitionMetricImage\(id\)\)/)
  assert.match(LIVE, /\{:else if metricMoved\} <p class="pt-4 text-ui text-positive" role="status">\{metricMoved\}<\/p>/)
  // The editor's metric section, wherever the metric scores in its pin, with the refusal said in place.
  assert.match(EDITOR, /\{#if metricImage !== null\} <div [^>]*> <span class=\{cn\(HEAD, 'w-\[110px\] shrink-0'\)\}>\{tr\('admin\.competitions\.metricImage\.head'\)\}<\/span> <p [^>]*>\{metricImage\}<\/p>/)
  assert.match(EDITOR, /onclick=\{\(\) => void moveMetric\(\)\}> \{tr\('admin\.competitions\.metricImage\.move'\)\}/)
  assert.match(EDITOR, /const moved = await act\(\(\) => adminApi\.moveCompetitionMetricImage\(id\), 'metric'\)/)
  assert.match(EDITOR, /\{#if error && errorAt === 'metric'\} <p class="text-ui text-danger" role="alert">\{error\}<\/p>/)
  const metricSection = EDITOR.slice(EDITOR.indexOf("tr('admin.competitions.section.metric')"), EDITOR.indexOf("tr('admin.competitions.section.run')"))
  assert.match(metricSection, /metricImage\.move/, 'in the metric section')
})

test('#29 the metric section keeps its row while the metric scores in its pin, and with the card turned off it says why', () => {
  // The server's reading (runner.ts · scoresInPin, CompetitionView.metricScoresInPin): the row was drawn by the
  // card switch, and a competition whose card was turned off after its metric was pinned had no way to move it.
  const view = (gpu: boolean, metricScoresInPin: boolean): Pick<CompetitionView, 'competition' | 'metricScoresInPin'> => ({
    competition: { limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5, gpu } } as unknown as CompetitionView['competition'],
    metricScoresInPin,
  })
  for (const locale of ['ru', 'en'] as const) {
    setLocaleResolver(() => locale)
    assert.equal(metricImageNote(view(true, true)), translate(locale, 'admin.competitions.metricImage.note'), locale)
    const off = metricImageNote(view(false, true))
    assert.equal(off, translate(locale, 'admin.competitions.metricImage.noteCardOff'), locale)
    assert.notEqual(off, 'admin.competitions.metricImage.noteCardOff', `${locale}: a word, not its key`)
    assert.match(off!, /kaggle-base/, locale)
    // Never pinned, on the CPU: its metric scores in its own pin, and the move door refuses it.
    assert.equal(metricImageNote(view(false, false)), null, locale)
  }
  assert.doesNotMatch(translate('en', 'admin.competitions.metricImage.noteCardOff'), CYRILLIC)
  // The editor asks the helper, by the view the server sent, and draws its words; the switch alone no longer decides.
  assert.match(EDITOR, /const metricImage = \$derived\(metricImageNote\(view\)\)/)
  assert.doesNotMatch(EDITOR, /\{#if c\.limits\.gpu === true\} <div [^>]*> <span class=\{cn\(HEAD, 'w-\[110px\] shrink-0'\)\}>\{tr\('admin\.competitions\.metricImage\.head'\)\}/)
  assert.doesNotMatch(EDITOR, /tr\('admin\.competitions\.metricImage\.note'\)/, 'the note comes through the helper')
})

/* =================================== #0 — codes, as long as they are valid */

test('#0 the machines block lists the codes still valid, each with «Отменить», through the owner\'s code door', async () => {
  const at = new Date(2026, 9, 14, 23, 41).getTime()
  const listed: RemoteCodeView = { id: 'c0de1234c0de1234', createdAt: at - 3_600_000, expiresAt: at, machines: 3, used: 1, trusted: true, approvedSlots: null }
  assert.equal(plain(codeWords(listed, at - 60_000)), 'на 3 машины, подключилось 1 · действует до 23:41')
  assert.equal(plain(codeWords({ ...listed, machines: 1, approvedSlots: 8 }, at - 60_000)), 'на 1 машину, подключилось 1 · 8 мест на машину · действует до 23:41')
  // Whose it is, when the server says.
  assert.equal(plain(codeWords({ ...listed, createdBy: 'Анна Ким' }, at - 60_000)), 'на 3 машины, подключилось 1 · действует до 23:41 · выпуск: Анна Ким')
  assert.equal(plain(codeWords({ ...listed, createdBy: 'Анна Ким', console: true }, at - 60_000)), 'на 3 машины, подключилось 1 · действует до 23:41 · выпущен на консоли сервера')
  const fake = stubFetch(() => new Response(null, { status: 204 }))
  try {
    await runnersApi.cancelCode('c0de1234c0de1234')
  } finally {
    fake.restore()
  }
  assert.deepEqual([fake.calls[0].method, fake.calls[0].url], ['DELETE', '/api/admin/runners/codes/c0de1234c0de1234'])
  assert.match(RUNNERS, /\{#if data\.codes\.length > 0\}/)
  assert.match(RUNNERS, /\{#each data\.codes as code \(code\.id\)\}/)
  assert.match(RUNNERS, /onclick=\{\(\) => ask\(\{ kind: 'cancelCode', code \}\)\}/)
  assert.match(RUNNERS, /\} else if \(current\.kind === 'cancelCode'\) \{ const id = current\.code\.id patch = \(\) => runnersApi\.cancelCode\(id\) \}/)
  // Asked first, and the way out of the question keeps the code.
  assert.match(RUNNERS, /current\.kind === 'cancelCode' \? tr\('admin\.runners\.codes\.cancelTitle', \{ id: current\.code\.id \}\)/)
  assert.match(RUNNERS, /\{current\.kind === 'cancelCode' \? tr\('admin\.runners\.codes\.keep'\) : tr\('admin\.cancel'\)\}/)
  // Outside the machines' own list: drawn with no machine yet too.
  assert.ok(RUNNERS.indexOf('{#if data.codes.length > 0}') > RUNNERS.indexOf("tr('admin.runners.empty.title')"))
  setLocaleResolver(() => 'en')
  assert.match(plain(codeWords(listed, at - 60_000)) ?? '', /^for 3 machines, 1 joined · valid until 11:41\sPM$/)
})

test('#0 on the real server: «Отменить» through the panel\'s path ends the code, and «Отключить все» ends every live one, as the dialogs say', async () => {
  reset()
  const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { machines: 3, hours: 24, trusted: true, approvedSlots: null })
  assert.equal(minted.status, 200)
  let list = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body
  assert.ok(list.codes.some((one) => one.id === minted.body.id), 'listed by the id the dialog was given')
  // The path the panel's client asks (runnersApi.cancelCode), against the real door.
  const fake = stubFetch(() => json({}))
  try {
    await runnersApi.cancelCode(minted.body.id)
  } finally {
    fake.restore()
  }
  const asked = fake.calls[0]
  const cancelled = await fetch(`${await serve()}${asked.url}`, { method: asked.method, headers: { cookie: owner } })
  assert.equal(cancelled.status, 200)
  list = (await cancelled.json()) as RemoteMachinesResponse
  assert.equal(list.codes.some((one) => one.id === minted.body.id), false)
  assert.notEqual((await new Machine(await serve()).join(minted.body.code)).status, 200, 'a cancelled code joins no machine')
  // «Отключить все»: the machines go, and the codes with them (admin.runners.revokeAll.body).
  const again = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { machines: 3, hours: 24, trusted: false, approvedSlots: null })
  assert.equal((await new Machine(await serve()).join(again.body.code)).status, 200)
  const all = (await admin<RemoteMachinesResponse>('POST', '/api/admin/runners/revoke-all')).body
  assert.deepEqual(all.codes, [])
  assert.notEqual((await new Machine(await serve()).join(again.body.code)).status, 200, 'its two uses left are gone too')
  // One machine disconnected: its code stays (admin.runners.revoke.body says so).
  const one = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { machines: 2, hours: 1, trusted: false, approvedSlots: null })
  const first = new Machine(await serve())
  assert.equal((await first.join(one.body.code)).status, 200)
  assert.equal((await admin('POST', `/api/admin/runners/${first.runnerId}/revoke`)).status, 200)
  assert.ok((await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body.codes.some((code) => code.id === one.body.id))
})

test('#0 the dialog and the disconnects say what becomes of a code: valid until it expires, is used up or is cancelled', () => {
  for (const locale of ['ru', 'en'] as const) {
    const close = translate(locale, 'admin.runners.connect.closeConfirm')
    assert.doesNotMatch(close, /the code is gone|код пропадёт/i, locale)
    assert.match(close, locale === 'ru' ? /пока не истечёт, не израсходуется или пока вы не отмените его/ : /until it expires, is used up, or you cancel it/, locale)
    // One machine disconnected: its code is not, and the text says so instead of «only a new code».
    const one = translate(locale, 'admin.runners.revoke.body')
    assert.doesNotMatch(one, /только новым кодом|only join again with a new code/, locale)
    assert.match(one, locale === 'ru' ? /код, с которым она пришла, действует/ : /the code it joined with stays valid/, locale)
    // All of them: every live code ends with them (routes/admin-runners.ts · revoke-all).
    assert.match(translate(locale, 'admin.runners.revokeAll.body'), locale === 'ru' ? /действующие коды подключения тоже отменятся/ : /Every join code still valid is cancelled too/, locale)
  }
  assert.match(translate('ru', 'admin.runners.codes.note'), /пока не истечёт, не израсходуется или пока вы его не отмените/)
})

test('#0 the hidden test is said to go only to trusted machines that are online', () => {
  const machine = (fields: Partial<RemoteWhereMachine>): RemoteWhereMachine => ({ id: 'm', name: 'vast-1', verdict: 'taking', places: 4, cards: 0, trusted: true, ...fields })
  const where: RemoteCompetitionWhere = {
    home: { notebooks: false, places: 0 },
    machines: [machine({ id: 'a', name: 'vast-on', state: 'online' }), machine({ id: 'b', name: 'vast-quiet', state: 'silent' }), machine({ id: 'c', name: 'vast-old', state: 'outdated' })],
    registry: ['base'],
    homeOnly: false,
    cards: { recent: 0, last: null, sliceMb: null },
  }
  assert.deepEqual(sealedWarning(where).trusted, ['vast-on'])
  // None online: the warning is the one that says the hidden test waits.
  const quiet = { ...where, machines: where.machines.slice(1) }
  assert.deepEqual(sealedWarning(quiet), { trusted: [], text: translate('ru', 'admin.competitions.where.sealedWaits'), tone: 'danger' })
  // A server that does not say the state: the verdict, as before.
  assert.deepEqual(sealedWarning({ ...where, machines: [machine({ name: 'vast-any' })] }).trusted, ['vast-any'])
})

test('#0 the bare machine\'s command says what colloq-host does: Docker, the NVIDIA Container Toolkit and a driver check — no driver install', () => {
  const ru = translate('ru', 'admin.runners.connect.bare', { min: 580 })
  assert.doesNotMatch(ru, /поставит Docker и драйвер карт/)
  assert.match(ru, /Container Toolkit/)
  assert.match(ru, /драйвер 580\+/)
  const en = translate('en', 'admin.runners.connect.bare', { min: 580 })
  assert.match(en, /NVIDIA GPUs, the Container Toolkit, and checks for driver 580\+/)
  assert.doesNotMatch(en, CYRILLIC)
  // The label carries the floor the agent checks (shared/remote-runner.ts · REMOTE_DRIVER_MIN).
  assert.match(flat(code(read('web/src/admin/runners.ts'))), /label: tr\('admin\.runners\.connect\.bare', \{ min: REMOTE_DRIVER_MIN \}\)/)
})

/* ------------------------------------------------------------- the words */

test('every word this review added has both languages, and the English has no Russian in it', () => {
  const keys = [
    'admin.runners.ready.stopping', 'admin.runners.ready.stoppingIdle', 'admin.runners.ready.stoppingHint',
    'admin.runners.ready.leaving', 'admin.runners.ready.leavingIdle', 'admin.runners.ready.leavingHint',
    'admin.competitions.fleet.reason.home_only_envNoCard', 'admin.competitions.fleet.metricLane', 'admin.competitions.fleet.metricLaneBare',
    'admin.competitions.where.homeOnlyNoCard', 'admin.competitions.where.homeOnlyNoCardBare', 'admin.competitions.where.sealedWaitsNoCard',
    'admin.runners.connect.vastLeftOut', 'admin.runners.codes.title', 'admin.runners.codes.uses', 'admin.runners.codes.places',
    'admin.runners.codes.until', 'admin.runners.codes.by', 'admin.runners.codes.console', 'admin.runners.codes.note', 'admin.runners.codes.cancel', 'admin.runners.codes.cancelLabel',
    'admin.runners.codes.cancelTitle', 'admin.runners.codes.cancelBody', 'admin.runners.codes.cancelConfirm', 'admin.runners.codes.keep',
    'admin.competitions.metricImage.head', 'admin.competitions.metricImage.note', 'admin.competitions.metricImage.move',
    'admin.competitions.metricImage.rowMove', 'admin.competitions.metricImage.question', 'admin.competitions.metricImage.moved',
    'admin.resourcesTab.brokerNotebooksOff', 'admin.resourcesTab.brokerNotebooksOn', 'admin.resourcesTab.brokerNotebooksPending',
    'competitions.refusal.notOnMachine',
  ]
  for (const key of keys) {
    const ru = translate('ru', key, { count: 2, used: 1, busy: 1, id: 'x', title: 't', time: '1', environment: 'e', list: 'l', min: 580, name: 'n' })
    const en = translate('en', key, { count: 2, used: 1, busy: 1, id: 'x', title: 't', time: '1', environment: 'e', list: 'l', min: 580, name: 'n' })
    assert.notEqual(ru, key, `${key}: ru`)
    assert.notEqual(en, key, `${key}: en`)
    assert.doesNotMatch(en, CYRILLIC, key)
  }
  // The screens touched speak no Russian of their own.
  for (const rel of ['web/src/admin/ui/Runners.svelte', 'web/src/admin/ui/ConnectMachine.svelte', 'web/src/admin/screens/RemoteMachine.svelte']) {
    assert.doesNotMatch(read(rel), CYRILLIC, rel)
  }
})
