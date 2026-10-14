/**
 * «Машины для посылок» in the teacher's panel (Paper 16 · M1–M7): the owner's
 * client of /api/admin/runners, and the words the screens decide by —
 * whether a machine answers, what it holds, whether it is ready for the
 * competition the fleet is busy with, why a submission waits, where a run
 * is, and what the editor warns about.
 *
 * The decisions live in web/src/admin/runners.ts and are checked here
 * directly, in both languages where a word could slip; the screens are read
 * straight from their files, as in admin-gpu-runners.test.mts: a test with
 * its own copy of the rule passes forever while the file drifts.
 *
 * What these guard is the one thing this block could get wrong quietly: a
 * claim about a machine the server did not make — «замолчала» about one that
 * refused a notebook, «готова» about one still pulling twelve gigabytes,
 * «2 из 0» places, a run on a disconnected machine dropped from the grid.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDate, setLocaleResolver, translate } from '../shared/i18n.js'
import { adminMessages } from '../shared/locales/admin.js'
import type {
  RemoteCompetitionWhere,
  RemoteConsoleGroup,
  RemoteMachine,
  RemoteMachineCard,
  RemoteReadiness,
  RemoteReadinessItem,
  RunningRemote,
} from '../shared/remote-admin.js'
import type { RunningNow, WaitingRow } from '../shared/competitions-api.js'
import { AdminApiError } from '../web/src/lib/adminApi.js'
import {
  cardsFacts,
  cardsLine,
  cellPhaseWord,
  connectDefaults,
  consoleGroups,
  eventLine,
  fleetPlaces,
  fleetWords,
  focusCompetition,
  groupChip,
  groupLine,
  heardLine,
  homeOnlyBox,
  joinProgress,
  listOrder,
  machineLede,
  machineMenu,
  machinePagePath,
  machinePlaces,
  machineSliceMb,
  machinesListPath,
  mintRequest,
  noCardsBox,
  placesWords,
  readinessCells,
  readinessLine,
  remoteRow,
  resourcesLine,
  returnedFrom,
  runnersApi,
  sealedWarning,
  shortCardName,
  sizeWords,
  stateChip,
  summaryGauges,
  waitReason,
  whereHomeOnly,
  whereRow,
  wholeOrAuto,
} from '../web/src/admin/runners.js'

afterEach(() => setLocaleResolver(() => 'ru'))

/** The copy keeps non-breaking spaces between numbers and units; compare the words. */
const plain = (text: string | null | undefined): string | null => (text == null ? null : text.replace(/[\u00a0\u202f]/g, ' '))

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

/** Static `tr('key')` calls with no parameters, in one language (as admin-address.test.mts does). */
function localized(source: string, locale: 'ru' | 'en'): string {
  return source.replace(/\btr\(\s*['"]([^'"]+)['"]\s*\)/g, (_match, key: string) => translate(locale, key))
}

const CYRILLIC = /[А-Яа-яЁё]/

/** Midday of a local day, so «today» never straddles midnight wherever the test runs. */
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()
const MIN = 60_000
const HOUR = 60 * MIN
const GB = 1024 ** 3
const MB = 1024 ** 2

function item(fields: Partial<RemoteReadinessItem> = {}): RemoteReadinessItem {
  return { state: 'ready', percent: null, bytes: null, problem: null, ...fields }
}

function readiness(fields: Partial<RemoteReadiness> = {}): RemoteReadiness {
  return {
    competitionId: 'bukvynas',
    title: 'Буквы на сетке',
    environment: 'kaggle-gpu',
    gpu: true,
    sealed: false,
    verdict: 'taking',
    image: item({ bytes: 12.7 * GB }),
    data: item({ bytes: 0.9 * MB }),
    sealedData: item({ state: 'not_needed' }),
    running: 0,
    ...fields,
  }
}

function card(device: string, fields: Partial<RemoteMachineCard> = {}): RemoteMachineCard {
  return { device, name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564, perDevice: 8, busyShares: 0, sliceMb: 3070, ...fields }
}

function machine(fields: Partial<RemoteMachine> = {}): RemoteMachine {
  return {
    id: 'vastroaa',
    name: 'vast-4090-ro',
    state: 'online',
    trusted: true,
    lastSeenAt: NOW - 2_000,
    silentSince: null,
    address: '92.180.27.83',
    version: '0.24.0',
    compatible: true,
    facts: {
      hostname: 'C.24601',
      platform: 'linux/amd64',
      cpus: 64,
      memoryMb: 126 * 1024,
      diskMb: 1024 * 1024,
      docker: '28.4.0',
      storage: 'overlay2',
      driver: '580.95.05',
    },
    cards: [card('0'), card('1')],
    places: { approved: null, offered: 16, busy: 14 },
    perDevice: null,
    readiness: [readiness()],
    counts: { scored: 212, lost: 0, declined: 1, requeued: 0 },
    lastTrouble: null,
    createdAt: NOW - 20 * HOUR,
    ...fields,
  }
}

/* ------------------------------------------------------------------ client */

interface Call {
  url: string
  method: string
  body: unknown
  credentials: RequestCredentials | undefined
}

/** fetch replaced for one test: every call recorded, every answer the one given. */
function stubFetch(answer: (call: Call) => Response): { calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      credentials: init?.credentials,
    }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

test('the client calls the owner doors the types name, with the panel cookie', async () => {
  const fake = stubFetch((call) => (call.method === 'GET' ? json({ ok: call.url }) : new Response(null, { status: 204 })))
  try {
    await runnersApi.list()
    await runnersApi.machine('vastroaa')
    await runnersApi.mintCode({ machines: 3, hours: 24, trusted: false, approvedSlots: null })
    await runnersApi.update('vastroaa', { approvedSlots: 12, trusted: true })
    await runnersApi.act('vastroaa', 'drain')
    await runnersApi.act('vastroaa', 'resume')
    await runnersApi.act('vastroaa', 'revoke')
    await runnersApi.revokeAll()
  } finally {
    fake.restore()
  }
  assert.deepEqual(
    fake.calls.map((call) => `${call.method} ${call.url}`),
    [
      'GET /api/admin/runners',
      'GET /api/admin/runners/vastroaa',
      'POST /api/admin/runners/codes',
      'PATCH /api/admin/runners/vastroaa',
      'POST /api/admin/runners/vastroaa/drain',
      'POST /api/admin/runners/vastroaa/resume',
      'POST /api/admin/runners/vastroaa/revoke',
      'POST /api/admin/runners/revoke-all',
    ],
  )
  assert.deepEqual(fake.calls[2].body, { machines: 3, hours: 24, trusted: false, approvedSlots: null })
  assert.deepEqual(fake.calls[3].body, { approvedSlots: 12, trusted: true })
  assert.ok(fake.calls.every((call) => call.credentials === 'include'), 'the staff cookie is HttpOnly: only the browser attaches it')
})

test('an id in a path is encoded, and a refusal comes back as the panel reads every refusal', async () => {
  const fake = stubFetch(() => json({ error: 'Only the owner can do that.', reason: 'forbidden' }, 403))
  try {
    await assert.rejects(runnersApi.machine('a/b'), (cause: unknown) => {
      assert.ok(cause instanceof AdminApiError)
      assert.equal(cause.status, 403)
      assert.equal(cause.reason, 'forbidden')
      assert.equal(cause.message, 'Only the owner can do that.')
      return true
    })
  } finally {
    fake.restore()
  }
  assert.equal(fake.calls[0].url, '/api/admin/runners/a%2Fb')
})

test('a machine page and the machines block are addresses the admin router reads back', () => {
  assert.equal(machinePagePath('vastroaa'), '/admin/resources/machines/vastroaa')
  assert.equal(machinesListPath(), '/admin/resources?machines')
  assert.equal(machinesListPath(true), '/admin/resources?machines=connect')
  const screen = code(read('web/src/screens/AdminScreen.svelte'))
  const route = /const openMachine = \$derived\((\/.+\/)\.exec\(path\)\?\.\[1\] \?\? null\)/.exec(screen)
  assert.ok(route, 'AdminScreen reads the machine route')
  const pattern = new RegExp(route[1].slice(1, -1))
  assert.equal(pattern.exec(machinePagePath('vastroaa'))?.[1], 'vastroaa')
  assert.equal(pattern.exec('/admin/resources'), null)
  // Under the resources tab, so the rail keeps «Ресурсы» lit on the machine's page.
  assert.match(flat(screen), /\{:else if tab === 'resources'\} \{#if openMachine\} \{#key openMachine\}<RemoteMachine id=\{openMachine\} \{navigate\} \/>\{\/key\} \{:else\} <ResourcesTab \{navigate\} \/> \{\/if\}/)
})

/* ---------------------------------------------------------------- the chip */

test('a machine\'s state reads as the server decided it, feminine, with a silence counted from when it began', () => {
  assert.deepEqual(stateChip('online', null, NOW), { word: 'на связи', tone: 'positive' })
  assert.equal(plain(stateChip('silent', NOW - 4 * MIN - 5_000, NOW).word), 'молчит 4 мин')
  assert.equal(plain(stateChip('silent', NOW - 20_000, NOW).word), 'молчит 1 мин', 'a fresh silence is a minute, not zero')
  assert.equal(plain(stateChip('silent', NOW - 2 * HOUR - 1, NOW).word), 'молчит 2 ч')
  // Since when unknown: the chip says so, and no number from when the page loaded.
  assert.equal(stateChip('silent', null, NOW).word, 'молчит')
  assert.deepEqual(stateChip('outdated', null, NOW), { word: 'устарела', tone: 'warning' })
  assert.deepEqual(stateChip('quarantined', null, NOW), { word: 'на карантине', tone: 'danger' })
  assert.deepEqual(stateChip('revoked', null, NOW), { word: 'отключена', tone: 'neutral' })
  assert.equal(stateChip('draining', null, NOW).word, 'осушается')
  assert.equal(stateChip('left', null, NOW).word, 'ушла')
  setLocaleResolver(() => 'en')
  assert.equal(plain(stateChip('silent', NOW - 4 * MIN, NOW).word), 'silent 4 min')
  assert.equal(stateChip('outdated', null, NOW).word, 'outdated')
})

test('when it was heard: seconds while it is seconds, and a silent one says when it was last heard', () => {
  assert.equal(plain(heardLine(machine({ lastSeenAt: NOW - 2_000 }), NOW)), '2 с назад')
  assert.equal(plain(heardLine(machine({ lastSeenAt: NOW - 4 * MIN }), NOW)), '4 мин назад')
  assert.equal(heardLine(machine({ lastSeenAt: null }), NOW), 'ещё не выходила на связь')
  const at = NOW - 19 * MIN
  assert.equal(
    heardLine(machine({ state: 'silent', lastSeenAt: at, silentSince: at }), NOW),
    `была в ${formatDate(at, { hour: '2-digit', minute: '2-digit' })}`,
  )
})

/* ------------------------------------------------------------ what it has */

test('what a machine has reads as one line, its cards by model with the vendor\'s words cut', () => {
  assert.equal(plain(resourcesLine(machine().facts)), '64 ядра · 126 ГБ')
  assert.equal(plain(resourcesLine({ cpus: 1, memoryMb: 7.5 * 1024 })), '1 ядро · 7,5 ГБ')
  assert.equal(resourcesLine({ cpus: null, memoryMb: null }), '—')
  assert.equal(shortCardName('NVIDIA GeForce RTX 4090'), 'RTX 4090')
  assert.equal(shortCardName('NVIDIA A100-SXM4-80GB'), 'A100-SXM4-80GB')
  assert.equal(shortCardName(null), 'GPU')
  assert.equal(cardsLine([card('0'), card('1')]), '2 × RTX 4090 · по 8')
  assert.equal(cardsLine([]), 'без карт')
  assert.equal(
    cardsLine([card('0', { name: 'NVIDIA GeForce RTX 3090', perDevice: 4 }), card('1', { name: 'NVIDIA A100-SXM4-80GB', perDevice: 2 })]),
    '1 × RTX 3090 + 1 × A100-SXM4-80GB · по 4',
  )
  assert.equal(plain(cardsFacts([card('0'), card('1')])), '2 × RTX 4090 · 24 ГБ')
  // The machine's own share rule: the smallest card over the runs per card, nothing when a size is unknown.
  assert.equal(machineSliceMb([card('0'), card('1', { memoryMb: 12_000 })], 4), 3000)
  assert.equal(machineSliceMb([card('0', { memoryMb: null })], 4), null)
  setLocaleResolver(() => 'en')
  assert.equal(plain(resourcesLine(machine().facts)), '64 cores · 126 GB')
  assert.equal(cardsLine([card('0'), card('1')]), '2 × RTX 4090 · 8 per card')
})

test('a machine\'s places are the owner\'s cap or what it offers, never drawn below what is busy', () => {
  assert.deepEqual(machinePlaces({ approved: null, offered: 16, busy: 14 }), { busy: 14, total: 16, share: 14 / 16 })
  assert.equal(machinePlaces({ approved: 10, offered: 16, busy: 4 }).total, 10, 'the owner\'s cap')
  assert.equal(machinePlaces({ approved: 20, offered: 16, busy: 4 }).total, 16, 'never more than it offers')
  // A machine gone quiet offers nothing, yet still holds two runs: «2 из 0» is a bar past its own end.
  assert.deepEqual(machinePlaces({ approved: null, offered: 0, busy: 2 }), { busy: 2, total: 2, share: 1 })
  assert.deepEqual(machinePlaces({ approved: null, offered: 0, busy: 0 }), { busy: 0, total: 0, share: 0 })
  assert.equal(placesWords({ busy: 14, total: 16 }), '14 из 16')
})

test('the three numbers above the list, the cards\' only with a card that takes work', () => {
  const summary = { online: 3, total: 5, places: 60, busy: 32, cards: 2, perDevice: 8, sliceMb: 3070 }
  assert.deepEqual(
    summaryGauges(summary).map((gauge) => [gauge.value, plain(gauge.label)]),
    [
      [3, 'на связи из 5'],
      [60, 'мест · 32 заняты'],
      [2, 'карты × 8 · срез ≈ 3 ГБ'],
    ],
  )
  assert.equal(summaryGauges({ ...summary, cards: 0 }).length, 2)
  assert.equal(plain(summaryGauges({ ...summary, places: 1, busy: 1 })[1].label), 'место · 1 занято')
  setLocaleResolver(() => 'en')
  assert.deepEqual(
    summaryGauges(summary).map((gauge) => plain(gauge.label)),
    ['online of 5', 'places · 32 busy', 'GPUs × 8 · share ≈ 3 GB'],
  )
})

/* ------------------------------------------------------------- readiness */

test('the readiness column is about the competition the fleet is busy with', () => {
  const a = readiness({ competitionId: 'aaaaaaaa', title: 'A', running: 2 })
  const b = readiness({ competitionId: 'bbbbbbbb', title: 'B', running: 5 })
  assert.deepEqual(focusCompetition([machine({ readiness: [a, b] })]), { competitionId: 'bbbbbbbb', title: 'B' })
  // While nothing runs, the server's order: what a machine fetches first.
  const idle = [machine({ readiness: [{ ...a, running: 0 }, { ...b, running: 0 }] })]
  assert.equal(focusCompetition(idle)?.competitionId, 'aaaaaaaa')
  // A disconnected machine's runs are history, not the fleet's business now.
  assert.equal(
    focusCompetition([machine({ state: 'revoked', readiness: [{ ...a, running: 9 }] }), machine({ readiness: [{ ...b, running: 1 }] })])?.competitionId,
    'bbbbbbbb',
  )
  assert.equal(focusCompetition([machine({ readiness: [] })]), null)
})

const focus = { competitionId: 'bukvynas', title: 'Буквы на сетке' }

test('a ready machine says so with what it holds, a preparing one how far it got', () => {
  const ready = readinessLine(machine(), focus, '0.24.0')
  assert.equal(ready.lead, 'образ ✓ · данные ✓ · готова')
  assert.equal(ready.tone, 'positive')
  assert.equal(plain(ready.detail), 'kaggle-gpu 12,7 ГБ · данные 0,9 МБ')

  const fetching = machine({
    readiness: [readiness({ verdict: 'preparing', image: item({ state: 'fetching', percent: 45.6, bytes: 4.6 * GB }) })],
    places: { approved: null, offered: 32, busy: 18 },
  })
  const line = readinessLine(fetching, focus, '0.24.0')
  assert.equal(plain(line.lead), 'образ ↓ 45 % · данные ✓')
  assert.equal(line.tone, 'accent')
  assert.equal(line.detail, 'посылки «Буквы на сетке» возьмёт, когда скачает всё нужное; другие уже считает')
  // Nothing else runs on it: no «другие уже считает» about a machine that runs nothing.
  const quiet = machine({ readiness: fetching.readiness, places: { approved: null, offered: 32, busy: 0 } })
  assert.equal(readinessLine(quiet, focus, '0.24.0').detail, 'посылки «Буквы на сетке» возьмёт, когда скачает всё нужное')
  // A hidden test on a trusted machine is a third item.
  const sealed = machine({ readiness: [readiness({ sealed: true, sealedData: item({ state: 'fetching', percent: 10 }) })] })
  assert.equal(plain(readinessLine(sealed, focus, null).lead), 'образ ✓ · данные ✓ · тест ↓ 10 % · готова')
})

test('a failed GPU smoke test on an old driver is named by the driver, the machine\'s own words under it', () => {
  const smoke = item({ state: 'problem', problem: { code: 'smoke', detail: 'torch.cuda.is_available() returned False' } })
  const old = machine({
    facts: { ...machine().facts, driver: '535.104.05' },
    readiness: [readiness({ verdict: 'problem', image: smoke })],
  })
  const line = readinessLine(old, focus, '0.24.0')
  assert.equal(line.lead, 'драйвер 535, нужен 580+ — GPU-образ не запустится')
  assert.equal(line.tone, 'danger')
  assert.equal(line.detail, 'torch.cuda.is_available() returned False')
  // A current driver: the failure is CUDA's, not the driver's.
  const fresh = machine({ readiness: old.readiness })
  assert.equal(readinessLine(fresh, focus, '0.24.0').lead, 'torch не видит CUDA — GPU-образ не запустится')
  // Quarantined for it: the same words, and the way back.
  const held = machine({ ...old, state: 'quarantined' })
  assert.deepEqual(readinessLine(held, focus, '0.24.0'), {
    lead: 'драйвер 535, нужен 580+ — GPU-образ не запустится',
    tone: 'danger',
    detail: 'вернуть в работу — когда причина устранена, в меню ⋯',
  })
  // Quarantined with no problem on the item: the last trouble the server kept.
  const declined = machine({ state: 'quarantined', lastTrouble: 'docker did not answer in 30 s' })
  assert.equal(readinessLine(declined, focus, '0.24.0').lead, 'на карантине: docker did not answer in 30 s')
  setLocaleResolver(() => 'en')
  assert.equal(readinessLine(old, focus, '0.24.0').lead, 'driver 535, 580+ needed: the GPU image will not start')
})

test('an outdated machine names both releases only when they differ, and what it still finishes', () => {
  const old = machine({ state: 'outdated', compatible: false, version: '0.23.0', places: { approved: null, offered: 4, busy: 2 } })
  assert.deepEqual(readinessLine(old, focus, '0.24.0'), {
    lead: 'код 0.23.0, сервер 0.24.0 — новых посылок не берёт',
    tone: 'warning',
    detail: 'досчитает начатые (2); make runners-update обновит все машины',
  })
  // The same release and still another build (a rebuilt image, make dev): two
  // equal numbers are not the reason, so the line says the code differs.
  assert.equal(readinessLine({ ...old, version: '0.24.0' }, focus, '0.24.0').lead, 'код машины не совпадает с сервером — новых посылок не берёт')
  assert.equal(readinessLine({ ...old, places: { approved: null, offered: 4, busy: 0 } }, focus, '0.24.0').detail, 'make runners-update обновит все машины')
})

test('silent, draining, gone: the state speaks before the competition does', () => {
  const silent = readinessLine(machine({ state: 'silent', silentSince: NOW - 4 * MIN }), focus, '0.24.0')
  assert.equal(silent.lead, 'образ ✓ · данные ✓ · не отвечает')
  assert.equal(silent.tone, 'warning')
  // What will happen, not what may not have happened yet (home decides on path evidence).
  assert.equal(silent.detail, 'если не ответит, её посылки вернутся в очередь и их посчитают другие; лимит не тратится')
  assert.equal(readinessLine(machine({ state: 'draining', places: { approved: null, offered: 16, busy: 3 } }), focus, null).lead, 'осушается: досчитает начатые (3), новых не берёт')
  assert.equal(readinessLine(machine({ state: 'draining', places: { approved: null, offered: 16, busy: 0 } }), focus, null).lead, 'осушена: новых посылок не берёт')
  assert.equal(readinessLine(machine({ state: 'revoked' }), focus, null).lead, 'отключена — посылок не берёт')
  assert.equal(readinessLine(machine({ state: 'left' }), focus, null).lead, 'ушла сама — посылок не берёт')
  assert.equal(readinessLine(machine({ readiness: [] }), null, null).lead, 'готовиться пока не к чему')
  assert.equal(readinessLine(machine({ readiness: [] }), focus, null).lead, 'о «Буквы на сетке» машина ничего не сообщила')
  assert.equal(
    readinessLine(machine({ readiness: [readiness({ verdict: 'needs_card' })] }), focus, null).lead,
    'без карт — посылки «Буквы на сетке» не возьмёт',
  )
  const homeOnly = readinessLine(machine({ readiness: [readiness({ verdict: 'home_only', environment: 'nlp-course' })] }), focus, null)
  assert.deepEqual([homeOnly.lead, homeOnly.detail], ['считает только сервер', 'среду nlp-course собрали здесь — её образа нет в реестре'])
})

test('the machine page\'s table: progress by size, an environment built here, the hidden test only for the trusted', () => {
  const fetching = readinessCells(
    readiness({ environment: 'kaggle-base', gpu: false, verdict: 'preparing', image: item({ state: 'fetching', percent: 45, bytes: 4.6 * GB }), data: item({ bytes: 210 * MB }) }),
    { driver: null },
  )
  assert.equal(fetching.about, 'без карты')
  assert.equal(plain(fetching.image.lead), 'kaggle-base ↓ 45 %')
  assert.equal(fetching.image.percent, 45)
  assert.equal(plain(fetching.image.detail), '2,1 ГБ из 4,6 ГБ')
  assert.equal(plain(fetching.data.lead), '✓ 210 МБ')
  assert.deepEqual([fetching.result.lead, fetching.result.tone], ['возьмёт, когда скачает', 'ink'])

  const local = readinessCells(readiness({ environment: 'nlp-course', gpu: false, verdict: 'home_only', image: item({ state: 'not_needed' }) }), { driver: null })
  assert.deepEqual([local.image.lead, local.image.detail], ['nlp-course', 'собрана на этом сервере'])
  assert.equal(local.result.lead, 'считает только сервер')

  const untrusted = readinessCells(readiness({ sealed: true, verdict: 'needs_trusted', sealedData: item({ state: 'not_needed' }) }), { driver: null })
  assert.equal(untrusted.about, 'видеокарта · скрытый тест')
  assert.equal(untrusted.data.detail, 'тест — только доверенным')
  assert.equal(untrusted.result.lead, 'не берёт: скрытый тест')
  const trusted = readinessCells(readiness({ sealed: true, running: 14, sealedData: item() }), { driver: null })
  assert.equal(trusted.data.detail, 'тест ✓')
  assert.deepEqual([trusted.result.lead, trusted.result.detail], ['берёт посылки', 'сейчас считает 14'])
})

/* --------------------------------------------------------------- the menu */

test('the menu offers what applies to the machine as it stands, and nothing to a gone one', () => {
  assert.deepEqual(machineMenu(machine()), { places: true, perDevice: true, trust: true, drain: true, resume: false, revoke: true })
  assert.equal(machineMenu(machine({ cards: [] })).perDevice, false, 'runs per card means nothing without a card')
  for (const state of ['draining', 'quarantined'] as const) {
    const menu = machineMenu(machine({ state }))
    assert.deepEqual([menu.drain, menu.resume], [false, true], state)
  }
  for (const state of ['silent', 'outdated'] as const) assert.equal(machineMenu(machine({ state })).drain, true, state)
  for (const state of ['revoked', 'left'] as const) {
    assert.deepEqual(machineMenu(machine({ state })), { places: false, perDevice: false, trust: false, drain: false, resume: false, revoke: false })
  }
  // Gone machines go to the end of the list, the rest keep the server's order.
  const order = listOrder([machine({ id: 'a', state: 'revoked' }), machine({ id: 'b' }), machine({ id: 'c', state: 'left' }), machine({ id: 'd', state: 'silent' })])
  assert.deepEqual(order.map((one) => one.id), ['b', 'd', 'a', 'c'])
})

/* ------------------------------------------------------------ the dialog */

test('a number field takes a whole number in bounds, or empty — and the word its placeholder shows', () => {
  assert.deepEqual(wholeOrAuto('', 1, 64), { value: null })
  assert.deepEqual(wholeOrAuto(' 12 ', 1, 64), { value: 12 })
  assert.deepEqual(wholeOrAuto('авто', 1, 64), { value: null })
  assert.deepEqual(wholeOrAuto('Auto', 1, 64), { value: null })
  for (const bad of ['0', '65', '1.5', '-3', 'abc']) assert.deepEqual(wholeOrAuto(bad, 1, 64), { error: true }, bad)
  setLocaleResolver(() => 'en')
  assert.deepEqual(wholeOrAuto('auto', 1, 8), { value: null })
})

test('the connect dialog starts on one machine, a day, auto places, and no hidden test', () => {
  assert.deepEqual(connectDefaults(), { machines: '1', hours: '24', places: '', trusted: false })
  assert.deepEqual(mintRequest(connectDefaults()), { request: { machines: 1, hours: 24, trusted: false, approvedSlots: null } })
  assert.deepEqual(mintRequest({ machines: '3', hours: '6', places: '8', trusted: true }), {
    request: { machines: 3, hours: 6, trusted: true, approvedSlots: 8 },
  })
  assert.deepEqual(mintRequest({ ...connectDefaults(), machines: '0' }), { error: 'Машин — от 1 до 50.' })
  assert.deepEqual(mintRequest({ ...connectDefaults(), hours: '25' }), { error: 'Код действует от 1 до 24 часов.' })
  assert.deepEqual(mintRequest({ ...connectDefaults(), places: '100' }), { error: 'Мест — от 1 до 64, или пусто: авто.' })
})

test('«ждём первую машину» names the machines that joined since the code was shown, and what the latest does', () => {
  const before = new Set(['oldmachn'])
  const known = machine({ id: 'oldmachn', name: 'uni-gpu-1' })
  assert.deepEqual(joinProgress(before, [known], 3), {
    title: 'Ждём первую машину…',
    text: 'Выполните команду на машине — она появится здесь сама. Окно можно закрыть: машины появятся в списке.',
    joined: 0,
  })
  const pulling = machine({
    id: 'newmachn',
    createdAt: NOW - MIN,
    readiness: [readiness({ verdict: 'preparing', image: item({ state: 'fetching', percent: 3, bytes: 12.7 * GB }) })],
  })
  const one = joinProgress(before, [known, pulling], 3)
  assert.equal(one.title, 'Ждём остальные машины…')
  assert.equal(
    plain(one.text),
    'Подключилась 1 из 3: vast-4090-ro — качает образ kaggle-gpu, 12,7 ГБ. Окно можно закрыть: машины появятся в списке сами.',
  )
  const all = joinProgress(before, [known, pulling, machine({ id: 'm2', name: 'vast-2', createdAt: NOW }), machine({ id: 'm3', name: 'vast-3', createdAt: NOW + 1 })], 3)
  assert.equal(all.title, 'Все машины подключились')
  assert.match(all.text, /^Подключились 3 из 3: vast-4090-ro, vast-2, vast-3 — готова к посылкам\./)
  setLocaleResolver(() => 'en')
  assert.match(joinProgress(before, [known, pulling], 3).text, /^1 of 3 joined: vast-4090-ro, downloading the kaggle-gpu image/)
})

/* -------------------------------------------------------------- the page */

test('the machine\'s log is worded per kind, with what was measured under it as it came', () => {
  const declined = eventLine({ kind: 'declined', attemptId: 'a1', entrantName: 'Юра Т.', number: 2, competition: 'Буквы на сетке', detail: 'docker did not answer in 30 s' })
  assert.deepEqual(declined, {
    text: 'Отказ: посылка Юра Т. · #2 не запустилась — вернулась в очередь, лимит не потрачен',
    tone: 'warning',
    detail: '«Буквы на сетке» · docker did not answer in 30 s',
  })
  assert.equal(eventLine({ kind: 'lost', attemptId: 'a2', entrantName: 'Ника Р.', number: 14, competition: null, detail: null }).tone, 'danger')
  assert.equal(
    eventLine({ kind: 'revoked', attemptId: null, entrantName: null, number: null, competition: null, detail: null }).text,
    'Отключена: посылки вернулись в очередь, поздние ответы не примутся',
  )
  assert.equal(
    eventLine({ kind: 'revoked', attemptId: 'a3', entrantName: 'Ира С.', number: 10, competition: null, detail: null }).text,
    'Посылка Ира С. · #10 отменена на машине',
  )
  // A submission erased since: the log keeps its line.
  assert.equal(eventLine({ kind: 'leased', attemptId: 'a4', entrantName: null, number: null, competition: null, detail: null }).text, 'Взяла посылку (удалена)')
  // A kind a newer server writes shows by its own name rather than disappearing.
  const future = eventLine({ kind: 'teleported' as never, attemptId: null, entrantName: null, number: null, competition: null, detail: 'x' })
  assert.deepEqual([future.text, future.tone, future.detail], ['teleported', 'muted', 'x'])
  setLocaleResolver(() => 'en')
  assert.equal(eventLine({ kind: 'applied', attemptId: 'a5', entrantName: 'Nika R.', number: 14, competition: 'Letters', detail: '38 s on GPU 0' }).detail, '“Letters” · 38 s on GPU 0')
})

test('the page\'s lede: address, release, code, when it joined and was heard', () => {
  const lede = plain(machineLede(machine(), NOW)) ?? ''
  assert.match(lede, /^92\.180\.27\.83 · colloq 0\.24\.0, код совпадает с сервером · подключена .+ · на связи 2 с назад$/)
  const silentAt = NOW - 19 * MIN
  assert.match(machineLede(machine({ state: 'silent', lastSeenAt: silentAt, compatible: false }), NOW), /код отличается от сервера · .* · была на связи в \d\d:\d\d$/)
})

/* ------------------------------------------------------------ the console */

function run(id: string, fields: Partial<RunningNow> = {}): RunningNow {
  return {
    submissionId: id,
    competitionId: 'bukvynas',
    competitionSlug: 'bukvy',
    entrantId: `e-${id}`,
    entrantName: `Name ${id}`,
    number: 1,
    fileName: 'solution.ipynb',
    kind: 'notebook',
    cellsDone: 0,
    cellsTotal: 14,
    startedAt: NOW - MIN,
    limitMs: 2 * MIN,
    container: null,
    baseline: false,
    gpu: null,
    ...fields,
  }
}

const HOME: RemoteConsoleGroup = { machineId: null, name: null, state: null, places: 2, busy: 1, cards: null, metricsOnly: true }
const VAST: RemoteConsoleGroup = { machineId: 'vastroaa', name: 'vast-4090-ro', state: 'online', places: 16, busy: 2, cards: { count: 2, perDevice: 8 } }

test('the console groups runs by where they are, and never drops a run whose machine the groups do not name', () => {
  const grid = consoleGroups([HOME, VAST], [
    run('h1', { kind: 'metric' }),
    run('v1', { machine: { id: 'vastroaa', name: 'vast-4090-ro' } }),
    run('v2', { machine: { id: 'vastroaa', name: 'vast-4090-ro' } }),
    run('o1', { machine: { id: 'gonemach', name: 'vast-gone' } }),
  ])
  assert.deepEqual(grid.map((entry) => [entry.key, entry.runs.map((one) => one.submissionId)]), [
    ['home', ['h1']],
    ['vastroaa', ['v1', 'v2']],
    ['gonemach', ['o1']],
  ])
  assert.deepEqual(
    [grid[2].group.name, grid[2].group.state, grid[2].group.busy, grid[2].group.places],
    ['vast-gone', null, 1, 1],
    'a made-up group counts its own runs',
  )
  // This server's run with no server group: it still leads the grid.
  const homeless = consoleGroups([VAST], [run('h2')])
  assert.deepEqual(homeless.map((entry) => entry.key), ['home', 'vastroaa'])
  assert.deepEqual(fleetPlaces([HOME, VAST], [run('a'), run('b'), run('c')]), { busy: 3, count: 18 })
})

test('the console\'s header and group lines: where the fleet is, and what each part of it does', () => {
  assert.equal(fleetWords([HOME, VAST]), 'на 1 машине', 'a server that only scores runs no notebooks')
  assert.equal(fleetWords([{ ...HOME, metricsOnly: false }, VAST, { ...VAST, machineId: 'm2' }]), 'на сервере и 2 машинах')
  assert.equal(fleetWords([HOME]), null)
  assert.equal(groupLine(HOME, 0, '0.24.0'), 'только метрики · 1 из 2')
  assert.equal(groupLine({ ...HOME, metricsOnly: false }, 0, '0.24.0'), '1 из 2')
  assert.equal(groupLine(VAST, 0, '0.24.0'), '2 из 16 · 2 карты по 8')
  assert.equal(
    groupLine({ ...VAST, state: 'outdated', version: '0.23.0' }, 0, '0.24.0'),
    'досчитывает 2 · новых не берёт: на ней 0.23.0, на сервере 0.24.0',
  )
  assert.equal(groupLine({ ...VAST, state: 'outdated', version: null }, 0, '0.24.0'), 'досчитывает 2 · новых не берёт')
  assert.equal(groupLine({ ...VAST, state: 'draining', busy: 0 }, 0, null), 'новых посылок не берёт')
  const silent: RemoteConsoleGroup = { ...VAST, state: 'silent', busy: 0, silentSince: NOW - 4 * MIN }
  assert.equal(groupLine(silent, 3, null), 'её 3 посылки вернулись в начало очереди; лимит участников не потрачен')
  assert.equal(groupLine(silent, 0, null), 'не отвечает: если не ответит, её посылки вернутся в начало очереди')
  assert.equal(plain(groupChip(silent, NOW)?.word), 'молчит 4 мин')
  assert.equal(groupChip(HOME, NOW), null)
  setLocaleResolver(() => 'en')
  assert.equal(fleetWords([{ ...HOME, metricsOnly: false }, VAST]), 'on this server and 1 machine')
  assert.equal(groupLine(VAST, 0, null), '2 of 16 · 2 GPUs, 8 a card')
})

function waitingRow(fields: Partial<WaitingRow> = {}): WaitingRow {
  return { submissionId: 's', competitionId: 'bukvynas', entrantId: 'e', entrantName: 'Денис Ким', number: 6, place: 1, etaMs: 10_000, resourcePending: false, baseline: false, ...fields }
}

test('a waiting row says why a machine has not taken it, and why it came back only when the server said why', () => {
  const back = waitingRow({ reason: 'returned', returnedFrom: 'uni-gpu-1' })
  assert.deepEqual(waitReason({ ...back, returnedWhy: 'silent' }), { text: 'вернулась: uni-gpu-1 замолчала', tone: 'warning' })
  assert.equal(waitReason({ ...back, returnedWhy: 'declined' })?.text, 'вернулась: uni-gpu-1 не смогла её запустить')
  assert.equal(waitReason({ ...back, returnedWhy: 'released' })?.text, 'вернулась: uni-gpu-1 её отпустила')
  // Not told why: the machine is named, and no cause is made up for it.
  assert.equal(waitReason(back)?.text, 'вернулась с машины uni-gpu-1')
  assert.equal(waitReason(waitingRow({ reason: 'returned' }))?.text, 'вернулась в очередь с машины')
  assert.deepEqual(waitReason(waitingRow({ reason: 'preparing_image' })), { text: 'машины качают образ', tone: 'accent' })
  assert.deepEqual(waitReason(waitingRow({ reason: 'needs_trusted' })), { text: 'ждёт доверенную машину: скрытый тест', tone: 'warning' })
  assert.equal(waitReason(waitingRow({ reason: 'no_runners' }))?.text, 'некому считать: сервер считает только метрики, а машины работу не берут')
  assert.equal(waitReason(waitingRow({ reason: 'home_only_env' }))?.text, 'среда есть только на сервере, а он считает только метрики')
  assert.equal(waitReason(waitingRow({ reason: 'no_gpu_runner' }))?.text, 'ждёт карту: её нет ни здесь, ни на машинах')
  assert.deepEqual(waitReason(waitingRow({ scoring: true })), { text: 'оценивается', tone: 'accent' })
  assert.equal(waitReason(waitingRow()), null, 'a plain turn needs no words')
  assert.equal(returnedFrom([back, back, waitingRow({ reason: 'returned', returnedFrom: 'vast-2' }), waitingRow()], 'uni-gpu-1'), 2)
  assert.equal(returnedFrom([back], null), 0)
  setLocaleResolver(() => 'en')
  assert.equal(waitReason({ ...back, returnedWhy: 'silent' })?.text, 'back: uni-gpu-1 went silent')
})

test('a cell on a machine whose container has not started says where it is instead of a cell count', () => {
  const remote = { machine: { id: 'vastroaa', name: 'vast-4090-ro' } }
  assert.equal(cellPhaseWord({ ...remote, remotePhase: 'accepted' }), 'принята машиной')
  assert.equal(cellPhaseWord({ ...remote, remotePhase: 'preparing' }), 'готовится на машине')
  assert.equal(cellPhaseWord({ ...remote, remotePhase: 'uploading' }), 'возвращает ответ')
  assert.equal(cellPhaseWord({ ...remote, remotePhase: 'running' }), null, 'a running container keeps its cells')
  assert.equal(cellPhaseWord({ machine: null, remotePhase: 'preparing' }), null, 'this server\'s runs are unchanged')
})

/* ------------------------------------------------------ «Работают сейчас» */

test('a competition on machines holds no memory here, and each machine says so', () => {
  const remote: RunningRemote = {
    competitionId: 'bukvynas',
    competition: 'Буквы на сетке',
    hidden: false,
    machines: [
      { id: 'vastroaa', name: 'vast-4090-ro', runs: 16, devices: ['0', '1'] },
      { id: 'vastusaa', name: 'vast-3090-us', runs: 2, devices: [] },
    ],
    scoring: 2,
  }
  const row = remoteRow(remote)
  assert.equal(row.lead, '18 посылок на машинах')
  assert.equal(row.detail, 'здесь только метрика: 2 ответа')
  assert.deepEqual(row.lines.map((line) => [line.name, line.chip, plain(line.text)]), [
    ['метрика · здесь', 'считает', '2 ответа с машин'],
    ['vast-4090-ro', 'на машине', '16 посылок · GPU 0 и GPU 1 · здесь 0 МБ'],
    ['vast-3090-us', 'на машине', '2 посылки · здесь 0 МБ'],
  ])
  const quiet = remoteRow({ ...remote, scoring: 0 })
  assert.equal(quiet.detail, 'здесь — только их строки в очереди')
  assert.equal(quiet.lines.length, 2, 'no metric line without a metric here')
  setLocaleResolver(() => 'en')
  assert.equal(plain(remoteRow(remote).lines[1].text), '16 submissions · GPU 0 and GPU 1 · 0 MB here')
})

/* ------------------------------------------------------------- the editor */

const WHERE: RemoteCompetitionWhere = {
  home: { notebooks: false, places: 8 },
  machines: [
    { id: 'vastroaa', name: 'vast-4090-ro', verdict: 'taking', places: 16, cards: 2, trusted: true },
    { id: 'unigpuaa', name: 'uni-gpu-1', verdict: 'taking', places: 12, cards: 1, trusted: true },
    { id: 'epycaaaa', name: 'vast-epyc-128', verdict: 'needs_card', places: 32, cards: 0, trusted: false },
  ],
  registry: ['base', 'kaggle-base', 'kaggle-gpu'],
  homeOnly: false,
  cards: { recent: 2, last: { name: 'vast-4090-ro', at: NOW - 2 * HOUR } },
}

test('«Где считается» lists who takes the competition and names the first machine that does not fit', () => {
  assert.deepEqual(whereRow(WHERE, { gpu: true, draft: false, homeOnly: false }), {
    home: 'сервер · метрика',
    homeOnly: false,
    machines: ['vast-4090-ro', 'uni-gpu-1'],
    text: '2 машины с картами, 28 мест; vast-epyc-128 не подходит — у неё нет карт',
  })
  const drafting = whereRow(
    { ...WHERE, home: { notebooks: true, places: 8 }, machines: [{ ...WHERE.machines[0], verdict: 'preparing' }] },
    { gpu: false, draft: true, homeOnly: false },
  )
  assert.deepEqual([drafting.home, drafting.machines, drafting.text], ['сервер', ['vast-4090-ro'], 'vast-4090-ro подготовится к открытию'])
  assert.equal(whereRow({ ...WHERE, machines: [] }, { gpu: false, draft: false, homeOnly: false }).text, 'машин нет')
  const local = whereRow(WHERE, { gpu: false, draft: false, homeOnly: true })
  assert.deepEqual([local.home, local.homeOnly, local.machines], ['только этот сервер', true, []])
  setLocaleResolver(() => 'en')
  assert.equal(whereRow(WHERE, { gpu: true, draft: false, homeOnly: false }).text, '2 machines with GPUs, 28 places; vast-epyc-128 does not fit: it has no GPU')
})

test('warning 1 follows the environment the form names, saved or not', () => {
  assert.equal(whereHomeOnly(WHERE, 'kaggle-gpu', 'kaggle-gpu'), false, 'the saved verdict')
  assert.equal(whereHomeOnly({ ...WHERE, homeOnly: true }, 'nlp-course', 'nlp-course'), true)
  assert.equal(whereHomeOnly(WHERE, 'nlp-course', 'kaggle-gpu'), true, 'an unsaved pick outside the registry')
  assert.equal(whereHomeOnly({ ...WHERE, homeOnly: true }, 'base', 'nlp-course'), false, 'an unsaved pick from the registry')
  assert.equal(
    homeOnlyBox({ ...WHERE, home: { notebooks: true, places: 8 } }, 'nlp-course'),
    'Посылки посчитает сервер: 8 мест. Чтобы помогали машины, выберите среду из реестра — base, kaggle-base и kaggle-gpu: их образы машины берут сами.',
  )
  // A server that runs no notebooks and an environment only it has: nobody runs these.
  assert.match(homeOnlyBox(WHERE, 'nlp-course'), /^Эти посылки никто не посчитает: тетради на этом сервере выключены, а машины среду nlp-course не получат\./)
  assert.match(homeOnlyBox({ ...WHERE, registry: [] }, 'nlp-course'), /Включите «Тетради на этом сервере»/)
})

test('warnings 2 and 3: the hidden test goes to trusted machines only, and no card anywhere names the last one seen', () => {
  assert.deepEqual(sealedWarning(WHERE), {
    trusted: ['vast-4090-ro', 'uni-gpu-1'],
    text: 'посылки этого соревнования считают только доверенные машины: скрытый тест на другие не уезжает',
    tone: 'muted',
  })
  const untrusted = { ...WHERE, machines: WHERE.machines.map((one) => ({ ...one, trusted: false })) }
  assert.deepEqual(
    [sealedWarning({ ...untrusted, home: { notebooks: true, places: 8 } }).tone, sealedWarning(untrusted).tone],
    ['warning', 'danger'],
    'no trusted machine: only this server runs them, or, on a server that only scores, they wait',
  )
  assert.equal(
    plain(noCardsBox({ cards: { recent: 0, last: { name: 'vast-4090-ro', at: NOW - 2 * HOUR } } }, NOW, true)),
    'Посылки не примутся, пока не подключится машина с картами: участник увидит, что видеокарт для посылок нет. Последняя машина с картами, vast-4090-ro, была на связи 2 ч назад.',
  )
  assert.match(noCardsBox({ cards: { recent: 0, last: null } }, NOW, false), /Попросите владельца подключить машину с картами\.$/)
})

test('sizes read as the panel reads them, and a size nobody said is left out', () => {
  assert.equal(plain(sizeWords(12.7 * GB)), '12,7 ГБ')
  assert.equal(plain(sizeWords(0.9 * MB)), '0,9 МБ')
  assert.equal(plain(sizeWords(210 * MB)), '210 МБ')
  assert.equal(sizeWords(null), null)
})

/* ------------------------------------------------------------- the words */

test('every word of the machines\' screens has both languages, and the English has no Russian in it', () => {
  const prefixes = ['admin.runners.', 'admin.competitions.fleet.', 'admin.competitions.where.', 'admin.resourcesTab.running.remote.']
  const keys = Object.keys(adminMessages).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
  assert.ok(keys.length > 200, `${keys.length} keys`)
  for (const key of keys) {
    const pair = adminMessages[key]
    const english = typeof pair.en === 'string' ? [pair.en] : Object.values(pair.en)
    for (const text of english) assert.doesNotMatch(text, CYRILLIC, key)
    if (typeof pair.ru !== 'string') assert.ok(pair.ru.one && pair.ru.few && pair.ru.many, `${key}: Russian needs one, few and many`)
  }
  // The audit log names what the machines' doors record (§6), in both languages.
  for (const action of ['runner.enrolled', 'runner.trusted', 'runner.revoked']) {
    assert.notEqual(translate('ru', `admin.audit.action.${action}`), `admin.audit.action.${action}`)
    assert.doesNotMatch(translate('en', `admin.audit.action.${action}`), CYRILLIC)
  }
})

/* ------------------------------------------------------------ the screens */

const RESOURCES = flat(code(read('web/src/admin/screens/ResourcesTab.svelte')))
const RUNNERS = flat(code(read('web/src/admin/ui/Runners.svelte')))
const CONNECT = flat(code(read('web/src/admin/ui/ConnectMachine.svelte')))
const PAGE = flat(code(read('web/src/admin/screens/RemoteMachine.svelte')))
const LIVE = flat(code(read('web/src/admin/screens/competitions/Live.svelte')))
const RUNNING = flat(code(read('web/src/admin/ui/RunningKernels.svelte')))
const EDITOR = flat(code(read('web/src/admin/screens/competitions/Editor.svelte')))

test('the new screens speak no Russian of their own, and every screen they touch follows the language', () => {
  for (const rel of ['web/src/admin/ui/Runners.svelte', 'web/src/admin/ui/ConnectMachine.svelte', 'web/src/admin/screens/RemoteMachine.svelte']) {
    assert.doesNotMatch(read(rel), CYRILLIC, `${rel}: not even in a comment`)
  }
  for (const rel of [
    'web/src/admin/ui/Runners.svelte',
    'web/src/admin/ui/ConnectMachine.svelte',
    'web/src/admin/screens/RemoteMachine.svelte',
    'web/src/admin/screens/ResourcesTab.svelte',
    'web/src/admin/screens/competitions/Live.svelte',
    'web/src/admin/screens/competitions/Editor.svelte',
    'web/src/admin/ui/RunningKernels.svelte',
  ]) {
    assert.doesNotMatch(localized(code(read(rel)), 'en'), CYRILLIC, rel)
  }
  assert.doesNotMatch(localized(code(read('web/src/admin/runners.ts')), 'en'), CYRILLIC, 'the words module has no Russian literal')
})

test('the machines block stands in «Ресурсы» for the owner, and its two settings are the form\'s', () => {
  assert.match(
    RESOURCES,
    /\{#if isOwner\} <Section title=\{tr\('admin\.runners\.title'\)\} description=\{tr\('admin\.runners\.note'\)\}> <Runners \{navigate\} settings=\{runnerSettings\} onsettings=\{applyRunner\} reload=\{runnersReload\} \/> <\/Section> \{\/if\}/,
  )
  // Beside the queue's settings, after the competitions section and before files.
  const machines = RESOURCES.indexOf('<Runners ')
  assert.ok(RESOURCES.indexOf("tr('admin.resourcesTab.competitionsTitle')") < machines && machines < RESOURCES.indexOf("tr('admin.resourcesTab.filesTitle')"))
  // Saved by the page's Save, through the competitions door, as the third half of its body.
  assert.match(RESOURCES, /if \(key === 'c\.homeNotebooks' && homeChoice !== null\) competitionPatch\.homeNotebooks = homeChoice/)
  assert.match(RESOURCES, /if \(key === 'c\.scoreSlots'\) competitionPatch\.scoreSlots = valueOf\(key\)/)
  assert.match(RESOURCES, /const dirtyCount = \$derived\(resourceDirty\.length \+ competitionDirty\.length \+ runnerDirty\.length\)/)
  assert.match(RESOURCES, /if \(key === 'c\.scoreSlots'\) return SETTINGS_LIMITS\.scoreSlots/)
  // A read of the list never wipes what the owner is typing.
  const apply = RESOURCES.slice(RESOURCES.indexOf('function applyRunner('), RESOURCES.indexOf('function pickCard('))
  assert.match(apply, /const scoreEdited = runnerSaved !== null && isDirty\('c\.scoreSlots'\)/)
  assert.match(apply, /if \(!scoreEdited\) texts\['c\.scoreSlots'\] = String\(saved\.scoreSlots\) if \(!homeEdited\) homeChoice = saved\.homeNotebooks/)
  // And the block reports the server's values on every read.
  assert.match(RUNNERS, /onsettings\?\.\(\{ homeNotebooks: fresh\.homeNotebooks, scoreSlots: fresh\.scoreSlots \}\)/)
  assert.match(RUNNERS, /\{#if settings\} \{@render settings\(\)\} \{\/if\}/)
  // Notebooks off here and no machine online: every submission waits, said where the switch is.
  assert.match(
    RUNNERS,
    /\{#if !data\.homeNotebooks && data\.summary\.online === 0\} <p [^>]*role="status"> <Icon name="alert" size=\{14\} class="mt-0\.5 shrink-0" \/> <span>\{tr\('admin\.runners\.nobodyRuns'\)\}<\/span>/,
  )
  // No machine at all: the empty state carries the button, and no row of zeros stands above it.
  assert.match(RUNNERS, /\{#if machines\.length > 0\} <div class="mb-5 flex flex-wrap items-center gap-x-7 gap-y-3"> \{#each gauges as gauge, index \(index\)\}/)
})

test('the list is read again while it is on screen, faster while a machine is expected to join', () => {
  assert.match(RUNNERS, /if \(Date\.now\(\) - loadedAt >= \(connecting \? 3_000 : 10_000\)\) void load\(\)/)
  assert.match(RUNNERS, /if \(document\.visibilityState !== 'visible'\) return/)
  // The connect dialog sees the same list and counts from the ids known when the code was shown.
  assert.match(RUNNERS, /<ConnectMachine machines=\{data\.machines\} onclose=\{\(\) => \(connecting = false\)\} \/>/)
  assert.match(CONNECT, /known = new Set\(machines\.map\(\(machine\) => machine\.id\)\) minted = await runnersApi\.mintCode\(asked\.request\)/)
  assert.match(CONNECT, /const progress = \$derived\(minted \? joinProgress\(known, machines, minted\.machines\) : null\)/)
  for (const kind of ['docker', 'bare', 'vast']) assert.match(CONNECT, new RegExp(`text: minted\\.commands\\.${kind}`))
  // On a phone the commands wrap instead of scrolling sideways, and Copy is a finger's size.
  assert.match(CONNECT, /<pre class="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono/)
  assert.match(CONNECT, /max-\[640px\]:min-h-11"/)
  // Linked from elsewhere: ?machines scrolls to the block, =connect opens the dialog for the owner.
  assert.match(RUNNERS, /if \(asked === 'connect' && adminAuth\.isOwner\) connecting = true/)
})

test('the row menu acts at once where it can be undone, and asks where it cannot', () => {
  assert.match(RUNNERS, /if \(machine\.trusted\) void act\(\(\) => runnersApi\.update\(machine\.id, \{ trusted: false \}\)\) else ask\(\{ kind: 'trust', machine \}\)/)
  assert.match(RUNNERS, /onclick=\{\(\) => void act\(\(\) => runnersApi\.act\(machine\.id, 'drain'\)\)\}/)
  assert.match(RUNNERS, /onclick=\{\(\) => void act\(\(\) => runnersApi\.act\(machine\.id, 'resume'\)\)\}/)
  assert.match(RUNNERS, /onclick=\{\(\) => ask\(\{ kind: 'revoke', machine \}\)\}/)
  assert.match(RUNNERS, /onclick=\{\(\) => ask\(\{ kind: 'revokeAll', count: live\.length \}\)\}/)
  assert.match(RUNNERS, /patch = \(\) => runnersApi\.revokeAll\(\)/)
  // The table is the M1 grid from 780 px of its own width, a card below (M7).
  assert.match(read('web/src/admin/ui/Runners.svelte'), /@container \(min-width: 780px\)/)
  assert.match(RUNNERS, /class="rn-more admin-icon-btn"/, 'the menu is the panel\'s 44 px target on a phone')
})

test('a machine\'s page saves each setting as it is committed, and stops a run through the console\'s door', () => {
  assert.match(PAGE, /const fresh = await runnersApi\.machine\(asked\)/)
  assert.match(PAGE, /if \(cause instanceof AdminApiError && cause\.status === 404\) \{ missing = true/)
  assert.match(PAGE, /run\(\(\) => runnersApi\.update\(machineId, \{ approvedSlots: parsed\.value \}\)\)/)
  assert.match(PAGE, /run\(\(\) => runnersApi\.update\(machineId, \{ perDevice: parsed\.value \}\)\)/)
  assert.match(PAGE, /if \(machine\.trusted\) \{ void run\(\(\) => runnersApi\.update\(machineId, \{ trusted: false \}\)\)/)
  assert.match(PAGE, /adminApi\.killCompetitionRun\(item\.submissionId\)/)
  assert.match(PAGE, /\{#each showAll \? machine\.events : machine\.events\.slice\(0, EVENTS_SHOWN\) as event, index/)
  assert.match(PAGE, /role="switch" aria-checked=\{machine\.trusted\}/)
})

test('the console groups its grid by machine only when there are machines, with one copy of a cell', () => {
  assert.match(LIVE, /const machineGroups = \$derived\(queue\?\.groups && queue\.groups\.length > 0 \? queue\.groups : null\)/)
  assert.match(LIVE, /const grouped = \$derived\(machineGroups \? consoleGroups\(machineGroups, running\) : null\)/)
  assert.match(LIVE, /const slots = \$derived\(fleet\?\.count \?\? queue\?\.slots \?\? running\.length\)/)
  assert.equal([...LIVE.matchAll(/\{@render runCell\(run\)\}/g)].length, 2, 'the grouped grid and the plain one draw the same cell')
  assert.equal([...LIVE.matchAll(/\{#snippet runCell\(run: RunningNow\)\}/g)].length, 1)
  assert.match(LIVE, /\{#if grouped\}/)
  // Free places: this server's as outlines, a machine's as one count.
  assert.match(LIVE, /tr\('admin\.competitions\.fleet\.free', \{ count: free \}\)/)
  assert.match(LIVE, /\{#if !home && entry\.runs\.length > GROUP_CELLS\}/)
  // The waiting rows say the machines' reasons after the card's.
  assert.match(LIVE, /\{#each waiting as row \(row\.submissionId\)\} \{@const reason = waitReason\(row\)\}/)
  assert.match(LIVE, /\{:else if reason\} <span class=\{cn\('text-micro', REASON_TONE\[reason\.tone\]\)\}>\{reason\.text\}<\/span> \{\/if\}/)
  assert.match(LIVE, /machineGroups \? fleetWords\(machineGroups\) : null,/)
  // Under the waiting list: the queue is the fleet's, and a return from a machine goes first.
  assert.match(LIVE, /\{tr\('admin\.competitions\.fairQueueSlots', \{ count: slots \}\)\} \{#if machineGroups\}\{tr\('admin\.competitions\.fleet\.queueNote'\)\}\{\/if\}/)
  // A machine's page is the owner's; the kill is a finger's size on a phone.
  assert.match(LIVE, /\{#if adminAuth\.isOwner && group\.machineId\}/)
  assert.match(LIVE, /disabled:opacity-40 max-\[640px\]:size-11"/)
})

test('«Работают сейчас» lists competitions on machines at 0 MB, and is not empty while one runs there', () => {
  assert.match(RUNNING, /const remote = \$derived\(data\?\.remote \?\? \[\]\)/)
  assert.match(RUNNING, /data\.preparations\.length === 0 && remote\.length === 0,/)
  assert.match(RUNNING, /\{#each remote as entry, index \(entry\.competitionId \?\? `remote-\$\{index\}`\)\} \{@const row = remoteRow\(entry\)\}/)
  assert.match(RUNNING, /<span class="admin-num font-bold">\{tr\('admin\.resourcesTab\.running\.remote\.zero'\)\}<\/span>/)
  assert.match(RUNNING, /\{#if remote\.length > 0\} <p class="pt-1\.5 text-2xs text-muted">\{tr\('admin\.resourcesTab\.running\.remote\.footnote'\)\}<\/p> \{\/if\}/)
})

test('the editor counts a machine with cards as a card, and draws «Где считается» with its warnings', () => {
  assert.match(EDITOR, /const where = \$derived\(view\.where && !gpuCluster \? view\.where : null\)/)
  assert.match(EDITOR, /const machineCards = \$derived\(where !== null && where\.cards\.recent > 0\)/)
  assert.match(EDITOR, /: homeCards === 0 && !machineCards,/, 'the GPU door is open while a machine with cards was heard within the hour')
  assert.match(EDITOR, /const homeOnly = \$derived\(where \? whereHomeOnly\(where, environment, c\.environment\) : false\)/)
  assert.match(EDITOR, /\{#if where && whereLine\}/)
  assert.match(EDITOR, /<p class="min-w-0 flex-1 basis-\[280px\] text-2xs text-ink">\{homeOnlyBox\(where, environment\)\}<\/p> <button type="button" class="btn-outline shrink-0" onclick=\{changeEnvironment\}>/)
  assert.match(EDITOR, /const sealedNote = \$derived\(where && \(view\.sealedFiles\?\.length \?\? 0\) > 0 \? sealedWarning\(where\) : null\)/)
  // No card anywhere: the owner connects a machine in a new tab, the form keeps its fields.
  assert.match(
    EDITOR,
    /\{#if gpuState === 'noCards'\} \{#if where\} <div [^>]*> <p [^>]*>\{noCardsBox\(where, now, adminAuth\.isOwner\)\}<\/p> \{#if adminAuth\.isOwner\} <a class="btn-outline shrink-0" href=\{machinesListPath\(true\)\} target="_blank" rel="noreferrer">/,
  )
  assert.match(EDITOR, /<select id="competition-environment" class="field w-auto min-w-0 font-mono"/)
})
