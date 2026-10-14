/**
 * The review of «Машины для посылок» in the panel (Paper 16 · M1–M7) and of
 * the participant's page, after the machines' first build: each test here is
 * one finding, and fails on the code as it stood before its fix.
 *
 * As in admin-runners-ui.test.mts, the decisions live in
 * web/src/admin/runners.ts and web/src/lib/competition-words.ts and are
 * checked directly, in both languages where a word could slip; the screens
 * are read from their files, comments stripped, for the wiring — a test with
 * its own copy of a rule passes forever while the screen drifts.
 *
 * What these guard is advice the screens gave that nobody could take: give
 * this server a card it does not have, a switch on Kubernetes that stops
 * every notebook, a stale read that undoes a Save, a code lost to a reflex
 * Escape, a hidden test said to go to a machine that is not there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, translate } from '../shared/i18n.js'
import type { AdminAuditEvent } from '../shared/admin.js'
import type { EntrantSubmission } from '../shared/competitions.js'
import type { SubmissionLive } from '../shared/competitions-entrant.js'
import type { RemoteCompetitionWhere, RemoteConsoleGroup, RemoteMachine } from '../shared/remote-admin.js'
import type { RunningNow, WaitingRow } from '../shared/competitions-api.js'
import { auditActionLabel, auditDetail } from '../web/src/admin/audit.js'
import { AdminApiError } from '../web/src/lib/adminApi.js'
import { gpuSwitchWord } from '../web/src/admin/runner-cards.js'
import type { CompetitionGpuSettings } from '../shared/competitions-settings.js'
import {
  MACHINES_BOUNDS,
  cardlessWarning,
  codeJoined,
  freePlaces,
  groupLine,
  joinProgress,
  notebooksOffQuestion,
  readOrder,
  remoteStopOutcome,
  sealedWarning,
  stopRemoteRuns,
  waitReason,
  waitingLine,
  whereRow,
} from '../web/src/admin/runners.js'
import { queueNote, rowWords } from '../web/src/lib/competition-words.js'

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

const CYRILLIC = /[А-Яа-яЁё]/

function waitingRow(fields: Partial<WaitingRow> = {}): WaitingRow {
  return { submissionId: 's', competitionId: 'bukvynas', entrantId: 'e', entrantName: 'Денис Ким', number: 6, place: null, etaMs: null, resourcePending: false, baseline: false, gpu: true, ...fields }
}

/* ------------------------------------------------- the console's waiting list */

test('a waiting row says the machine\'s reason before the card it waits for', () => {
  // vsos without cards, its GPU machines gone: every GPU row is the machines', and none can come.
  assert.deepEqual(waitingLine(waitingRow({ reason: 'no_gpu_runner' }), true), {
    text: 'ждёт карту: её нет ни здесь, ни на машинах',
    tone: 'warning',
  })
  // Back from a silent machine while every share is busy: the return is still said.
  assert.equal(waitingLine(waitingRow({ reason: 'returned', returnedFrom: 'vast-1', returnedWhy: 'silent', place: 1 }), true)?.text, 'вернулась: vast-1 замолчала')
  // No reason: the card it waits for, as before machines.
  assert.deepEqual(waitingLine(waitingRow({ place: 2 }), true), { text: 'ждёт место на видеокарте', tone: 'accent' })
  assert.equal(waitingLine(waitingRow({ place: 2 }), false), null, 'a plain turn needs no words')
  assert.equal(waitingLine(waitingRow({ gpu: false, scoring: true }), false)?.text, 'оценивается')
  setLocaleResolver(() => 'en')
  assert.equal(waitingLine(waitingRow({ reason: 'no_gpu_runner' }), true)?.text, 'waiting for a GPU: none here or on the machines')
})

test('with machines, the cardless warning sends the owner to a machine with cards, not to a card this server may not have', () => {
  assert.equal(cardlessWarning(false), translate('ru', 'admin.competitions.gpuNoPlace'))
  const fleet = cardlessWarning(true)
  assert.match(fleet, /ни на этом сервере, ни на машинах на связи/)
  assert.match(fleet, /Машину с картами подключает владелец/)
  assert.doesNotMatch(fleet, /отдаёт владелец/, 'no «give this server a card»')
  setLocaleResolver(() => 'en')
  assert.match(cardlessWarning(true), /connects a machine with GPUs/)
  assert.doesNotMatch(cardlessWarning(true), CYRILLIC)
})

const LIVE = flat(code(read('web/src/admin/screens/competitions/Live.svelte')))

test('the console draws the waiting line and the warning by those rules', () => {
  assert.match(LIVE, /\{@const line = waitingLine\(row, waitsForCard\(row, queue\)\)\}/)
  assert.match(LIVE, /\{#if line\} <span class=\{cn\('text-micro', REASON_TONE\[line\.tone\]\)\}>\{line\.text\}<\/span> \{\/if\}/)
  assert.match(LIVE, /\{#if cardless\} <p class="text-2xs leading-snug text-warning">\{cardlessWarning\(machineGroups !== null\)\}<\/p> \{\/if\}/)
  assert.doesNotMatch(LIVE, /\{#if waitsForCard\(row, queue\)\}/, 'the card no longer goes before the reason')
})

function run(id: string, fields: Partial<RunningNow> = {}): RunningNow {
  return {
    submissionId: id, competitionId: 'bukvynas', competitionSlug: 'bukvy', entrantId: `e-${id}`, entrantName: id, number: 1,
    fileName: 'solution.ipynb', kind: 'notebook', cellsDone: 0, cellsTotal: 14, startedAt: 0, limitMs: 60_000, container: null,
    baseline: false, gpu: null, ...fields,
  }
}

test('the metric lane\'s runs never take this server\'s free notebook cells, and the header counts the queue\'s places', () => {
  const home: RemoteConsoleGroup = { machineId: null, name: null, state: null, places: 4, busy: 2, cards: null }
  // Two notebooks and two rescores here: two of the four notebook places are free.
  assert.equal(freePlaces(home, [run('a'), run('b'), run('m1', { kind: 'metric' }), run('m2', { kind: 'metric' })]), 2)
  assert.equal(freePlaces(home, [run('a'), run('b'), run('c'), run('d'), run('e')]), 0, 'never below zero')
  // This server only scores: no notebook place to draw, whatever the group says.
  assert.equal(freePlaces({ ...home, places: 3, metricsOnly: true }, [run('m1', { kind: 'metric' })]), 0)
  assert.equal(freePlaces({ machineId: 'v', name: 'vast-1', state: 'online', places: 16, busy: 3, cards: null }, [run('x'), run('y'), run('z')]), 13)
  assert.match(LIVE, /\{@const free = freePlaces\(group, entry\.runs\)\}/)
  // The header's places are the queue's own (the forecast's), not a sum over the groups.
  assert.match(LIVE, /const slots = \$derived\(queue\?\.slots \?\? running\.length\)/)
  assert.doesNotMatch(LIVE, /fleetPlaces/)
})

test('an outdated machine\'s versions name the server\'s release as the server said it, never the panel bundle\'s', () => {
  assert.match(LIVE, /const homeVersion = \$derived\(machineGroups\?\.find\(\(group\) => group\.machineId === null\)\?\.version \?\? null\)/)
  assert.equal([...LIVE.matchAll(/groupLine\(group, [^)]*\), homeVersion\)|groupLine\(group, 0, homeVersion\)/g)].length, 2)
  assert.doesNotMatch(LIVE, /__COLLOQ_VERSION__/)
})

/* --------------------------------------------------------- the Resources tab */

const RESOURCES = flat(code(read('web/src/admin/screens/ResourcesTab.svelte')))
const RUNNERS = flat(code(read('web/src/admin/ui/Runners.svelte')))

test('the machines block is not drawn under Kubernetes, where «только метрики» would stop every notebook', () => {
  assert.match(
    RESOURCES,
    /\{#if isOwner && !dockerOnlyIgnored\} <Section title=\{tr\('admin\.runners\.title'\)\} description=\{tr\('admin\.runners\.note'\)\}> <Runners \{navigate\} settings=\{runnerSettings\}/,
  )
  assert.match(RESOURCES, /const dockerOnlyIgnored = \$derived\(loaded !== null && loaded\.backend === 'broker'\)/)
})

test('saving «только метрики» with no machine online is asked first, and an unread list is said as unread', () => {
  assert.equal(notebooksOffQuestion(false, 0), translate('ru', 'admin.runners.homeNotebooks.offConfirm'))
  assert.match(notebooksOffQuestion(false, 0) ?? '', /^Ни одной машины на связи нет\./)
  assert.match(notebooksOffQuestion(false, null) ?? '', /^Список машин не загрузился/)
  assert.equal(notebooksOffQuestion(false, 2), null, 'a machine online runs them')
  assert.equal(notebooksOffQuestion(true, 0), null, 'turning notebooks on asks nothing')
  assert.equal(notebooksOffQuestion(null, 0), null, 'forgotten back to the default, which is on')
  assert.equal(notebooksOffQuestion(undefined, 0), null, 'not sent at all')
  setLocaleResolver(() => 'en')
  assert.match(notebooksOffQuestion(false, 0) ?? '', /^No machine is online\./)
  // The form asks before it saves, with the count the block reported.
  assert.match(RESOURCES, /const question = notebooksOffQuestion\(competitionPatch\.homeNotebooks, machinesOnline\) if \(question !== null && !window\.confirm\(question\)\) return/)
  assert.ok(RESOURCES.indexOf('notebooksOffQuestion(competitionPatch.homeNotebooks') < RESOURCES.indexOf('saving = true'), 'asked before anything is sent')
  assert.match(RESOURCES, /onfleet=\{\(fleet\) => \(machinesOnline = fleet\.online\)\}/)
  assert.match(RUNNERS, /onfleet\?\.\(\{ online: answer\.summary\.online \}\)/)
  // And the warning follows the switch as it stands, not only after Save.
  assert.match(RESOURCES, /\{#if !homeOn && machinesOnline === 0\} <p [^>]*role="status"> <Icon name="alert" size=\{14\} class="mt-0\.5 shrink-0" \/> <span>\{tr\('admin\.runners\.nobodyRuns'\)\}<\/span>/)
  assert.doesNotMatch(RUNNERS, /data\.homeNotebooks/)
})

test('the two machine settings come from the settings door with their sources, and can go back to the default', () => {
  assert.match(RESOURCES, /if \(key === 'c\.scoreSlots'\) return competitions\?\.runners\?\.scoreSlots\.value \?\? null/)
  assert.match(RESOURCES, /if \(key === 'c\.scoreSlots'\) return queue\.runners\?\.scoreSlots\.source \?\? null if \(key === 'c\.homeNotebooks'\) return queue\.runners\?\.homeNotebooks\.source \?\? null/)
  assert.match(RESOURCES, /if \(settings\.runners\) \{ texts\['c\.scoreSlots'\] = String\(settings\.runners\.scoreSlots\.value\) homeChoice = settings\.runners\.homeNotebooks\.value \}/)
  // The source line under each, with «вернуть умолчание» for a saved one.
  assert.match(RESOURCES, /\{@render sourceLine\('c\.homeNotebooks', sourceOf\('c\.homeNotebooks'\)\)\}/)
  assert.match(RESOURCES, /\{@render sourceLine\('c\.scoreSlots', sourceOf\('c\.scoreSlots'\)\)\}/)
  // Forgetting shows the default at once and sends null.
  assert.match(RESOURCES, /if \(key === 'c\.scoreSlots'\) \{ texts\[key\] = String\(SETTINGS_LIMITS\.scoreSlots\.default\) return \}/)
  assert.match(RESOURCES, /if \(key === 'c\.homeNotebooks'\) \{ homeChoice = SETTINGS_LIMITS\.homeNotebooks\.default return \}/)
  assert.match(RESOURCES, /competitionPatch\.homeNotebooks = forgotten\.includes\(key\) \? null : homeChoice/)
  assert.match(RESOURCES, /competitionPatch\.scoreSlots = forgotten\.includes\(key\) \? null : valueOf\(key\)/)
  // The machines list no longer feeds the form: a read of it cannot undo a Save.
  assert.doesNotMatch(RESOURCES, /runnerSaved|applyRunner|onsettings/)
})

test('overlapping reads of the machines list: an older answer never replaces a newer one, nor the state after a write', () => {
  // The timer's read leaves, then the form saves and asks again: the old answer lands last.
  const order = readOrder()
  const timer = order.ask()
  const afterSave = order.ask(true)
  assert.equal(order.accept(afterSave), true)
  assert.equal(order.accept(timer), false, 'the pre-Save answer is dropped')
  // ...or lands first: dropped all the same, since it left before the write.
  const second = readOrder()
  const early = second.ask()
  const fresh = second.ask(true)
  assert.equal(second.accept(early), false)
  assert.equal(second.accept(fresh), true)
  // Plain timer reads: the newest shown wins, an older one landing late is dropped.
  const third = readOrder()
  const a = third.ask()
  const b = third.ask()
  assert.equal(third.accept(b), true)
  assert.equal(third.accept(a), false)
  const c = third.ask()
  assert.equal(third.accept(c), true, 'the next read is shown again')
  // The block numbers its reads, and re-reads after every write as one.
  assert.match(RUNNERS, /const reads = readOrder\(\)/)
  assert.match(RUNNERS, /const ticket = reads\.ask\(afterWrite\)/)
  assert.match(RUNNERS, /if \(disposed \|\| !reads\.accept\(ticket\)\) return/)
  assert.equal([...RUNNERS.matchAll(/await load\(true\)/g)].length, 2, 'after a menu action and after a dialog')
  assert.match(RUNNERS, /if \(reload > 0\) void load\(true\)/)
})

test('the row menu\'s items are a finger\'s size on a phone', () => {
  const raw = read('web/src/admin/ui/Runners.svelte')
  assert.match(RUNNERS, /class="rn-menu row-menu admin-menu absolute right-0 top-full z-20 mt-1 w-\[260px\]"/)
  assert.match(flat(raw), /@media \(max-width: 640px\) \{ \.rn-menu \.admin-menu-item \{ display: flex; align-items: center; min-height: 44px; \} \}/)
})

/* --------------------------------------------------------- the connect dialog */

test('once the code is shown, Escape and the cross ask before closing; Done does not', () => {
  const connect = flat(code(read('web/src/admin/ui/ConnectMachine.svelte')))
  assert.match(connect, /if \(event\.key === 'Escape' && !busy\) requestClose\(\)/)
  assert.match(
    connect,
    /function requestClose\(\): void \{ if \(minted && \(progress\?\.joined \?\? 0\) < minted\.machines && !window\.confirm\(tr\('admin\.runners\.connect\.closeConfirm'\)\)\) return onclose\(\) \}/,
  )
  assert.match(connect, /aria-label=\{tr\('admin\.close'\)\} disabled=\{busy\} onclick=\{requestClose\}/)
  assert.match(connect, /<button type="button" class="btn-outline shrink-0 max-\[640px\]:w-full" onclick=\{onclose\}>\{tr\('admin\.runners\.connect\.done'\)\}<\/button>/)
  assert.match(translate('ru', 'admin.runners.connect.closeConfirm'), /^Код показан только в этом окне/)
  assert.doesNotMatch(translate('en', 'admin.runners.connect.closeConfirm'), CYRILLIC)
})

/* ---------------------------------------------------------- the machine page */

test('the machine page stops reading after a 404 or a 403, and its trust switch has a 44 px row', () => {
  const page = flat(code(read('web/src/admin/screens/RemoteMachine.svelte')))
  assert.match(page, /if \(cause instanceof AdminApiError && cause\.status === 404\) \{ missing = true machine = null stopped = true return \}/)
  assert.match(page, /if \(cause instanceof AdminApiError && cause\.status === 403\) \{ machine = null stopped = true loadErrorText = \(\) => messageFor\(cause\) return \}/)
  assert.match(page, /if \(!stopped && document\.visibilityState === 'visible'\) void load\(\)/)
  // An answer resumes it (after "Try again").
  assert.match(page, /machine = fresh missing = false stopped = false/)
  // The switch sits in a label that is the whole 44 px row on a phone.
  assert.match(page, /<label class=\{cn\('flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 max-\[640px\]:min-h-11', !busy && 'cursor-pointer'\)\}> <button type="button" role="switch"/)
})

/* -------------------------------------------------------------- the editor */

const WHERE: RemoteCompetitionWhere = {
  home: { notebooks: false, places: 8 },
  machines: [
    { id: 'vastroaa', name: 'vast-4090-ro', verdict: 'home_only', places: 16, cards: 2, trusted: true },
    { id: 'unigpuaa', name: 'uni-gpu-1', verdict: 'home_only', places: 12, cards: 1, trusted: false },
    { id: 'epycaaaa', name: 'vast-epyc-128', verdict: 'needs_card', places: 32, cards: 0, trusted: true },
  ],
  registry: ['base', 'kaggle-base', 'kaggle-gpu'],
  homeOnly: true,
  cards: { recent: 2, last: null },
}

test('«Где считается» recomputes when the form picks a registry environment over one built here, before Save', () => {
  const row = whereRow(WHERE, { gpu: true, draft: false, homeOnly: false, unsaved: true })
  assert.deepEqual(row.machines, ['vast-4090-ro', 'uni-gpu-1'])
  assert.equal(row.text, 'vast-4090-ro и uni-gpu-1 подготовятся после сохранения; vast-epyc-128 не подходит — у неё нет карт')
  assert.doesNotMatch(row.text, /ни одна машина пока не берёт/)
  // A draft is prefetched only once it opens, whatever the form names.
  assert.match(whereRow(WHERE, { gpu: true, draft: true, homeOnly: false, unsaved: true }).text, /^vast-4090-ro и uni-gpu-1 подготовятся к открытию/)
  // Saved as it is: the server's verdicts stand.
  const taking = { ...WHERE, homeOnly: false, machines: WHERE.machines.map((one) => ({ ...one, verdict: 'taking' as const })) }
  assert.match(whereRow(taking, { gpu: false, draft: false, homeOnly: false }).text, /^3 машины, 60 мест/)
  setLocaleResolver(() => 'en')
  assert.match(whereRow(WHERE, { gpu: true, draft: false, homeOnly: false, unsaved: true }).text, /^vast-4090-ro and uni-gpu-1 prepare once this is saved/)
  // The editor tells the row (and the hidden-test warning) when the environment is not saved yet.
  const editor = flat(code(read('web/src/admin/screens/competitions/Editor.svelte')))
  assert.match(editor, /const environmentUnsaved = \$derived\(environment !== c\.environment\)/)
  assert.match(editor, /whereRow\(where, \{ gpu: gpuOn, draft: draftState, homeOnly, unsaved: environmentUnsaved \}\)/)
  assert.match(editor, /sealedWarning\(where, \{ homeOnly, unsaved: environmentUnsaved, gpu: gpuOn \}\)/)
})

test('the hidden test is said to go only to trusted machines that take the competition, and to this server when it runs notebooks', () => {
  const saved = { ...WHERE, homeOnly: false, machines: WHERE.machines.map((one) => (one.verdict === 'home_only' ? { ...one, verdict: 'taking' as const } : one)) }
  // vast-epyc-128 is trusted but has no card for this GPU competition: it runs none of them.
  assert.deepEqual(sealedWarning(saved).trusted, ['vast-4090-ro'])
  assert.equal(sealedWarning(saved).text, 'посылки этого соревнования считают только доверенные машины: скрытый тест на другие не уезжает')
  const withHome = { ...saved, home: { notebooks: true, places: 8 } }
  assert.equal(sealedWarning(withHome).text, 'посылки этого соревнования считают сервер и доверенные машины: скрытый тест на другие не уезжает')
  // An environment only this server has goes to no machine at all.
  assert.deepEqual(sealedWarning(withHome, { homeOnly: true }), {
    trusted: [],
    text: 'ни одна доверенная машина их не возьмёт — посылки со скрытым тестом посчитает только сервер',
    tone: 'warning',
  })
  // An unsaved registry pick over one built here: the trusted machine will take it after Save.
  assert.deepEqual(sealedWarning(WHERE, { unsaved: true }).trusted, ['vast-4090-ro'])
  assert.equal(sealedWarning({ ...saved, machines: [saved.machines[2]] }).tone, 'danger', 'none takes it and this server only scores')
  setLocaleResolver(() => 'en')
  assert.equal(sealedWarning(withHome).text, 'this server and trusted machines run this competition\'s submissions: the hidden test goes nowhere else')
})

/* ---------------------------------------------------------- the participant */

function submission(fields: Partial<EntrantSubmission> = {}): EntrantSubmission {
  return {
    id: 'sub1', number: 12, fileName: 'solution.ipynb', acceptedAt: new Date(2026, 9, 14, 12, 3).getTime(), state: 'queued', stage: 'queue',
    cellsDone: 0, cellsTotal: 0, durationMs: null, publicScore: null, chosen: false, participantError: null,
    ...fields,
  } as EntrantSubmission
}

function live(fields: Partial<SubmissionLive> = {}): SubmissionLive {
  return { submissionId: 'sub1', place: null, etaMs: null, startedAt: null, limitMs: 600_000, aheadNumber: null, stage: 'queue', cellsDone: 0, cellsTotal: 0, ...fields }
}

const NOW = new Date(2026, 9, 14, 12, 5).getTime()

test('the participant reads «готовится» where no executor can take the submission yet, never a place or a machine', () => {
  const words = rowWords({ submission: submission(), live: live({ preparing: true }), best: false, paused: false, now: NOW })
  assert.deepEqual(words.lines, ['готовится: место в очереди появится, когда её будет где посчитать'])
  assert.equal(rowWords({ submission: submission(), live: live({ preparing: true }), best: false, paused: false, now: NOW, phone: true }).lines[0], 'готовится')
  // A place still reads as before.
  assert.deepEqual(rowWords({ submission: submission(), live: live({ place: 3 }), best: false, paused: false, now: NOW }).lines, ['Третья в очереди'])
  assert.equal(queueNote({ place: null, aheadNumber: null, paused: true, preparing: true }), 'готовится: место в очереди появится, когда её будет где посчитать · очередь приостановлена преподавателем')
  setLocaleResolver(() => 'en')
  assert.equal(queueNote({ place: null, aheadNumber: null, paused: false, preparing: true, short: true }), 'getting ready')
})

test('a submission whose notebook has run and whose metric waits reads «оценивается», not a stuck last cell', () => {
  const scoring = submission({ state: 'running', stage: 'score', cellsDone: 14, cellsTotal: 14 })
  const words = rowWords({ submission: scoring, live: live({ scoring: true, stage: 'score', cellsDone: 14, cellsTotal: 14 }), best: false, paused: false, now: NOW })
  assert.equal(words.lines.length, 1)
  assert.match(words.lines[0], /^оценивается: тетрадь выполнена, осталось посчитать метрику · отправлена в \d\d:\d\d$/)
  assert.doesNotMatch(words.lines[0], /Ячейка 14 из 14/)
  assert.deepEqual(rowWords({ submission: scoring, live: live({ scoring: true }), best: false, paused: false, now: NOW, phone: true }).lines, ['оценивается'])
  // Without the flag, a running submission keeps its cells.
  assert.match(rowWords({ submission: scoring, live: live({ stage: 'notebook' }), best: false, paused: false, now: NOW }).lines[0], /^Ячейка 14 из 14/)
  setLocaleResolver(() => 'en')
  assert.match(rowWords({ submission: scoring, live: live({ scoring: true }), best: false, paused: false, now: NOW }).lines[0], /^being scored: the notebook has run, the metric is next · sent at /)
})

/* ---------------------------------------------------------- the audit log */

function event(detail: AdminAuditEvent['detail']): AdminAuditEvent {
  return { id: 1, at: 0, actor: null, action: 'runner.trusted', target: { type: 'runner', id: 'vastroaa', label: 'vast-4090-ro' }, detail, ip: null }
}

test('the audit log words a change of a machine\'s trust for both directions', () => {
  // The label is neither the grant nor the removal; the detail says which.
  assert.doesNotMatch(auditActionLabel('runner.trusted'), /^Машине доверен/)
  assert.equal(auditActionLabel('runner.trusted'), 'Изменено доверие машине: скрытый тест')
  assert.equal(auditDetail(event({ trusted: true })), 'доверен скрытый тест')
  assert.equal(auditDetail(event({ trusted: false })), 'доверие снято: скрытый тест машине больше не уходит, и она его удалит')
  // A detail of another shape reads as its pairs, as every other setting does.
  assert.equal(auditDetail(event({ note: 'x' })), 'note: x')
  setLocaleResolver(() => 'en')
  assert.equal(auditActionLabel('runner.trusted'), 'Machine\'s hidden-test trust changed')
  assert.equal(auditDetail(event({ trusted: false })), 'trust removed: the hidden test no longer goes to the machine, and it deletes its copy')
})

/* ------------------------------------------------- joined with THIS code */

function joiner(id: string, name: string, createdAt: number): RemoteMachine {
  return {
    id, name, state: 'online', trusted: false, lastSeenAt: createdAt, silentSince: null, address: null, version: '0.24.0', compatible: true,
    facts: { hostname: null, platform: null, cpus: 8, memoryMb: 32_768, diskMb: null, docker: null, storage: null, driver: null },
    cards: [], places: { approved: null, offered: 4, busy: 0 }, perDevice: null, readiness: [],
    counts: { scored: 0, lost: 0, declined: 0, requeued: 0 }, lastTrouble: null, createdAt,
  }
}

test('«ждём первую машину» counts the machines that joined with this code, and names them only when it can tell which', () => {
  const known = new Set(['oldmachn'])
  const mine = joiner('mine0001', 'vast-1', NOW)
  const other = joiner('other001', 'uni-gpu-2', NOW + 1)
  // Another code's machine joined while this dialog was open: the code says none of its own did.
  assert.equal(joinProgress(known, [mine, other].slice(1), 3, 0).title, 'Ждём первую машину…')
  // One of each: the code's count, with no name it cannot vouch for.
  const both = joinProgress(known, [mine, other], 3, 1)
  assert.deepEqual([both.title, both.joined], ['Ждём остальные машины…', 1])
  assert.equal(both.text, 'Подключилась 1 из 3. Окно можно закрыть: машины появятся в списке сами.')
  assert.doesNotMatch(both.text, /uni-gpu-2|vast-1/)
  // As many newcomers as the code counts: they are its machines, by name.
  assert.match(joinProgress(known, [mine], 3, 1).text, /^Подключилась 1 из 3: vast-1 — /)
  // The code spent (all joined): the title says so.
  assert.equal(joinProgress(known, [mine, other], 2, 2).title, 'Все машины подключились')
  // A server that does not count by code: every newcomer, as before.
  assert.equal(joinProgress(known, [mine, other], 3).joined, 2)
  setLocaleResolver(() => 'en')
  assert.equal(joinProgress(known, [mine, other], 3, 1).text, '1 of 3 joined. You can close this window; the machines appear in the list by themselves.')
})

/* --------------------------------------- stopping runs on machines (M5) */

const refusal = (status: number) => new AdminApiError('no', status, status === 409 ? 'conflict' : 'forbidden')

test('stopping a competition\'s runs on machines goes through the kill door once per run, and says what became of each', async () => {
  const asked: string[] = []
  const tally = await stopRemoteRuns(['a', 'b', 'c', 'd'], async (id) => {
    asked.push(id)
    if (id === 'c') throw refusal(409)
    return { killed: true }
  })
  assert.deepEqual(asked, ['a', 'b', 'c', 'd'], 'every run is asked, one request each')
  assert.deepEqual(tally, { stopped: 3, ended: 1, error: null })
  assert.deepEqual(remoteStopOutcome('Буквы на сетке', tally), { tone: 'positive', text: 'В «Буквы на сетке» сняты 3 посылки на машинах. Уже закончились сами: 1.' })
  // Everything had ended between the list and the press: no «сняты» over runs that were over.
  assert.deepEqual(remoteStopOutcome('Буквы на сетке', { stopped: 0, ended: 2, error: null }), {
    tone: 'positive',
    text: 'Посылки «Буквы на сетке» на машинах уже закончились.',
  })
  // One request failed for another reason: the rest still stop, and the line says to press again.
  const broken = await stopRemoteRuns(['a', 'b'], async (id) => {
    if (id === 'b') throw new TypeError('Failed to fetch')
    return { killed: true }
  })
  assert.equal(broken.stopped, 1)
  assert.ok(broken.error instanceof TypeError)
  assert.deepEqual(remoteStopOutcome('Буквы на сетке', broken), {
    tone: 'warning',
    text: 'В «Буквы на сетке» снята 1 посылка на машинах. Не все ответили — нажмите «Остановить» ещё раз.',
  })
  assert.equal(remoteStopOutcome('X', { stopped: 5, ended: 0, error: null }).text, 'В «X» снято 5 посылок на машинах.')
  setLocaleResolver(() => 'en')
  assert.equal(remoteStopOutcome('Letters', tally).text, '3 submissions of “Letters” on machines cancelled. Already over: 1.')
})

/* ------------------------------------------- what the server added for these */

test('a row no machine can fit says so before the card it would wait for', () => {
  assert.deepEqual(waitReason(waitingRow({ reason: 'no_fit' })), { text: 'не помещается ни на одну машину на связи', tone: 'warning' })
  assert.equal(waitingLine(waitingRow({ reason: 'no_fit' }), true)?.text, 'не помещается ни на одну машину на связи')
  setLocaleResolver(() => 'en')
  assert.equal(waitReason(waitingRow({ reason: 'no_fit' }))?.text, 'fits no machine online')
})

test('this server with notebooks off counts the metric lane\'s places, and says no number it was not given', () => {
  // As the server sends it: the notebook lane's zeros, the metric lane apart.
  const home: RemoteConsoleGroup = { machineId: null, name: null, state: null, places: 0, busy: 0, cards: null, metricsOnly: true, metric: { places: 2, busy: 2 } }
  assert.equal(groupLine(home, 0, '0.24.0'), 'только метрики · 2 из 2')
  assert.equal(groupLine({ ...home, metric: undefined }, 0, '0.24.0'), 'только метрики', 'never «0 из 0» over metrics that run')
  // Notebooks on: the notebook lane's numbers, as before.
  assert.equal(groupLine({ ...home, metricsOnly: false, places: 4, busy: 1, metric: undefined }, 0, '0.24.0'), '1 из 4')
  setLocaleResolver(() => 'en')
  assert.equal(groupLine(home, 0, null), 'metrics only · 2 of 2')
})

function gpuSettings(fields: Partial<CompetitionGpuSettings> = {}): CompetitionGpuSettings {
  return {
    cards: [], devices: ['0'], perDevice: 4, sliceMb: 6141, source: { devices: 'saved', perDevice: 'saved' },
    bounds: { perDevice: { min: 1, max: 8 } }, managed: false, ...fields,
  }
}

test('the GPU switch names the share a run gets on the machines when this server gives none, and the smaller of the two beside its own', () => {
  const none = gpuSettings({ devices: [], sliceMb: null })
  // vsos: no card of its own, a machine with 2 × 4090 at 8 a card.
  assert.equal(gpuSwitchWord(none, { sliceMb: 3070 }).replace(/[  ]/g, ' '), 'срез ≈ 3 ГБ')
  assert.equal(gpuSwitchWord(none, { sliceMb: null }), 'срез', 'a card that did not say its size: no promise')
  assert.equal(gpuSwitchWord(none, null), 'срез', 'no machine with cards within the hour: as before')
  // Beside this server's own cards the smaller share wins, whole card or not.
  assert.equal(gpuSwitchWord(gpuSettings(), { sliceMb: 3070 }).replace(/[  ]/g, ' '), 'срез ≈ 3 ГБ')
  assert.equal(gpuSwitchWord(gpuSettings({ perDevice: 1, sliceMb: 24_564 }), { sliceMb: 3070 }).replace(/[  ]/g, ' '), 'срез ≈ 3 ГБ')
  assert.equal(gpuSwitchWord(gpuSettings({ sliceMb: null }), { sliceMb: 3070 }), 'срез', 'half of the picture is no promise')
  // Without machines, exactly as before.
  assert.equal(gpuSwitchWord(gpuSettings({ perDevice: 1, sliceMb: 24_564 })), 'вся карта')
  const editor = flat(code(read('web/src/admin/screens/competitions/Editor.svelte')))
  assert.match(editor, /const machineShare = \$derived\(where !== null && where\.cards\.recent > 0 \? where\.cards : null\)/)
  assert.match(editor, /\{ value: 'on', label: gpuSwitchWord\(runnerCards, machineShare\) \}/)
})

test('the join count is this code\'s own, and a code gone from the list is spent only once the list had shown it', () => {
  const minted = { id: 'c0de1234', machines: 3, expiresAt: NOW + 60 * 60_000 }
  const listed = [{ id: 'other999', used: 4 }, { id: 'c0de1234', used: 1 }]
  assert.equal(codeJoined(minted, listed, NOW, true), 1)
  // The list read before the code existed: nothing joined yet, never «all of them».
  assert.equal(codeJoined(minted, [{ id: 'other999', used: 4 }], NOW, false), 0)
  // Shown before and gone now, still valid: spent, every machine joined.
  assert.equal(codeJoined(minted, [], NOW, true), 3)
  // Expired: the list cannot say; the dialog falls back to the newcomers.
  assert.equal(codeJoined(minted, [], NOW + 2 * 60 * 60_000, true), null)
  assert.equal(codeJoined({ ...minted, id: '' }, listed, NOW, true), null, 'a server that gives no id')
  const connect = flat(code(read('web/src/admin/ui/ConnectMachine.svelte')))
  assert.match(connect, /\$effect\(\(\) => \{ const id = minted\?\.id if \(id && codes\.some\(\(code\) => code\.id === id\)\) codeSeen = true \}\)/)
  assert.match(connect, /joinProgress\(known, machines, minted\.machines, codeJoined\(minted, codes, Date\.now\(\), codeSeen\)\)/)
})

test('the dialog says when its commands carry this server\'s loopback, and takes as many machines as the server does', () => {
  const connect = flat(code(read('web/src/admin/ui/ConnectMachine.svelte')))
  assert.match(connect, /\{#if minted\.loopback\} <p [^>]*role="alert"> <Icon name="alert" size=\{14\} class="mt-0\.5 shrink-0" \/> <span>\{tr\('admin\.runners\.connect\.loopback'\)\}<\/span> <\/p> \{\/if\}/)
  assert.match(translate('ru', 'admin.runners.connect.loopback'), /PUBLIC_URL/)
  assert.doesNotMatch(translate('en', 'admin.runners.connect.loopback'), CYRILLIC)
  // The door's bound and colloq-host's: the dialog refuses nothing they allow.
  const store = read('server/src/competitions/remote/store.ts')
  const max = Number(/export const REMOTE_CODE_MACHINES_MAX = (\d+)/.exec(store)?.[1])
  assert.ok(max > 0)
  assert.equal(MACHINES_BOUNDS.max, max)
})

test('«Работают сейчас» stops a competition\'s runs on machines with the ids the server sent, asked first', () => {
  const running = flat(code(read('web/src/admin/ui/RunningKernels.svelte')))
  assert.match(running, /\{#if !entry\.hidden && entry\.submissionIds\.length > 0\} <button type="button" class="rk-stop admin-icon-btn/)
  assert.match(running, /onclick=\{\(\) => open\(\{ kind: 'remote', name: entry\.competition, ids: \[\.\.\.entry\.submissionIds\] \}\)\}/)
  assert.match(running, /const tally = await stopRemoteRuns\(current\.ids, \(id\) => adminApi\.killCompetitionRun\(id\)\)/)
  assert.match(running, /if \(tally\.stopped === 0 && tally\.ended === 0 && tally\.error !== null\) throw tally\.error await settle\(remoteStopOutcome\(current\.name, tally\)\)/)
  assert.match(running, /\{:else if dialog\.kind === 'remote'\} <h2 [^>]*>\s*\{tr\('admin\.resourcesTab\.running\.remote\.stopTitle', \{ name: shortName\(dialog\.name\) \}\)\}/)
  assert.match(running, /\{tr\('admin\.resourcesTab\.running\.remote\.stopBody', \{ count: dialog\.ids\.length \}\)\}/)
  assert.equal(translate('ru', 'admin.resourcesTab.running.remote.stopTitle').includes('{name}'), true)
})

test('with the card switched on before Save, a machine without cards is no longer counted as taking the competition', () => {
  const cpu: RemoteCompetitionWhere = {
    ...WHERE,
    homeOnly: false,
    machines: [
      { id: 'vastroaa', name: 'vast-4090-ro', verdict: 'taking', places: 16, cards: 2, trusted: true },
      { id: 'epycaaaa', name: 'vast-epyc-128', verdict: 'taking', places: 32, cards: 0, trusted: true },
    ],
  }
  // Saved as a CPU competition: both take it.
  assert.equal(whereRow(cpu, { gpu: false, draft: false, homeOnly: false }).text, '2 машины, 48 мест')
  // The form turns the card on: the machine with none does not fit, and «с картами» counts only the one that has them.
  const gpu = whereRow(cpu, { gpu: true, draft: false, homeOnly: false })
  assert.deepEqual(gpu.machines, ['vast-4090-ro'])
  assert.equal(gpu.text, '1 машина с картами, 16 мест; vast-epyc-128 не подходит — у неё нет карт')
  // The hidden test then goes to the trusted machine with cards only.
  assert.deepEqual(sealedWarning(cpu, { gpu: true }).trusted, ['vast-4090-ro'])
  // Outdated code is the first reason whatever the form says.
  assert.match(whereRow({ ...cpu, machines: [{ ...cpu.machines[1], verdict: 'outdated' }] }, { gpu: true, draft: false, homeOnly: false }).text, /её код устарел/)
})
