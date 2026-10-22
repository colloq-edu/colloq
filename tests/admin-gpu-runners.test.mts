/**
 * Video cards for competition submissions, as the teacher's panel says them
 * (Paper 15 · G1–G3): the owner's «Видеокарты для посылок» block and the
 * cards' bar on the Resources tab, the editor's «ВИДЕОКАРТА» row, the
 * console's chips and waiting words, and «Работают сейчас».
 *
 * What these guard is a promise the panel may make only because the server
 * keeps it: a share of video memory. A share computed by another rule than
 * the server's is a number the owner gives a card away by and a participant
 * then dies short of; a share drawn where the server holds none (a card that
 * did not say its size, the cluster's card) is a promise nobody keeps. And
 * the words that tell a teacher why a notebook waits — for a slot or for a
 * card — or why a GPU competition takes no submissions at all.
 *
 * The decisions live in plain modules (admin/runner-cards.ts,
 * admin/competitions.ts, admin/running-kernels.ts) and are checked here; the
 * screens are read straight from their files, as in admin-scale.test.mts: a
 * test with its own copy of the rule passes forever while the file drifts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import type { CompetitionGpuCard, CompetitionGpuSettings } from '../shared/competitions-settings.js'
import type { QueueSnapshot } from '../shared/competitions-api.js'
import {
  cardFacts,
  cardHolder,
  cardsBar,
  cardsFallback,
  gpuPlacesNote,
  gpuRowState,
  gpuSwitchWord,
  holderWord,
  perDeviceFallback,
  shareDetail,
  shareGauge,
  shareGb,
  shareLines,
  shareReadout,
  sizesUnknown,
  withCardFacts,
} from '../web/src/admin/runner-cards.js'
import type { CompetitionCapabilities } from '../shared/capabilities.js'
import { cardWord } from '../web/src/admin/running-kernels.js'
import { lastResultWords, metricWorkAvailable, noPlaceOnCards, runnerLine, waitingWords, waitsForCard } from '../web/src/admin/competitions.js'

afterEach(() => setLocaleResolver(() => 'ru'))

/** The copy keeps non-breaking spaces between a number and its unit; compare the words. */
const plain = (text: string): string => text.replace(/[\u00a0\u202f]/g, ' ')

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

/** Two RTX 4090s as nvidia-smi reports them: 24 564 MiB each. */
const RTX = 24_564
function card(id: string, fields: Partial<CompetitionGpuCard> = {}): CompetitionGpuCard {
  return { id, name: 'NVIDIA GeForce RTX 4090', memoryMb: RTX, holder: 'free', heldByRoom: false, heldBySubmission: false, ...fields }
}

function settings(fields: Partial<CompetitionGpuSettings> = {}): CompetitionGpuSettings {
  return {
    cards: [card('0', { holder: 'runners' }), card('1', { holder: 'rooms', heldByRoom: true })],
    devices: ['0'],
    perDevice: 4,
    sliceMb: Math.floor(RTX / 4),
    source: { devices: 'saved', perDevice: 'saved' },
    bounds: { perDevice: { min: 1, max: 8 } },
    managed: false,
    ...fields,
  }
}

/* ------------------------------------------------------- the owner's block */

test('a card is named the way the panel names it everywhere', () => {
  assert.equal(plain(cardWord('0')), 'GPU 0')
  assert.equal(cardWord(''), 'GPU', 'the cluster\'s card has no id of ours')
  // A UUID says what it is by its prefix; forty characters would push the row's numbers off the line.
  assert.equal(cardWord('GPU-6540c1d2-8f3e-4b8a-9d1c-0123456789ab'), 'GPU-6540c1d2…')
  assert.equal(cardWord('MIG-1g.10gb'), 'MIG-1g.10gb')
  assert.equal(plain(cardFacts(card('0'))), 'NVIDIA GeForce RTX 4090 · 24 ГБ')
  assert.equal(cardFacts(card('0', { name: null, memoryMb: null })), 'объём неизвестен')
  setLocaleResolver(() => 'en')
  assert.equal(plain(cardFacts(card('0'))), 'NVIDIA GeForce RTX 4090 · 24 GB')
})

test('who a card is for follows the ticks, and a class keeps the card it holds until it ends', () => {
  assert.equal(cardHolder(card('0'), true), 'runners')
  assert.equal(cardHolder(card('0', { heldByRoom: true }), true), 'leaving')
  assert.equal(cardHolder(card('0', { heldByRoom: true }), false), 'rooms')
  assert.equal(cardHolder(card('0'), false), 'free')
  assert.deepEqual(
    (['runners', 'leaving', 'rooms', 'free'] as const).map(holderWord),
    ['у посылок', 'у класса, пока он открыт', 'у классов', 'свободна'],
  )
})

test('a card given back to classes while a submission still runs on it reads as the submission\'s until the run ends, not «свободна»', () => {
  // The server says a submission's container is on it (heldBySubmission): no class can start there meanwhile.
  assert.equal(cardHolder(card('1', { holder: 'runners', heldBySubmission: true }), false), 'finishing')
  // Ticked again, it is simply the submissions'; a class on it says so first, as the server does.
  assert.equal(cardHolder(card('1', { heldBySubmission: true }), true), 'runners')
  assert.equal(cardHolder(card('1', { heldByRoom: true, heldBySubmission: true }), false), 'rooms')
  // A server from before the field says nothing about it: the card is free as it was.
  const { heldBySubmission: _absent, ...older } = card('1')
  assert.equal(cardHolder(older as CompetitionGpuCard, false), 'free')
  assert.equal(holderWord('finishing'), 'у посылки, пока она не досчитается')
  setLocaleResolver(() => 'en')
  assert.equal(holderWord('finishing'), 'a submission has it until its run ends')
})

test('the share is the server\'s: the smallest ticked card over the runs sharing it', () => {
  const cards = [card('0'), card('1', { memoryMb: 16_384 })]
  // One 24 GB card, four runs: ≈ 6 GB each, four places (Paper 15 · G1).
  const four = shareReadout(cards, ['0'], 4)
  assert.deepEqual(four, { chosen: 1, perDevice: 4, places: 4, whole: false, sliceMb: 6141 })
  assert.equal(plain(shareGauge(four)), '≈ 6 ГБ')
  assert.equal(plain(shareDetail(four)), 'видеопамяти на посылку · 4 места на картах')
  const lines = shareLines(four)
  assert.equal(lines.tone, 'ink')
  // What the participant is told is true under every output policy: on a
  // hidden test with the brief one the server names the share and not the
  // amount (runner.ts · gpuKillNote), so the panel promises no amount.
  assert.equal(
    plain(lines.lead),
    'Срез держится честно: torch в посылке не возьмёт больше 6 ГБ, а посылку, которая всё же заняла больше, сервер остановит и скажет участнику, что она вышла за свой срез.',
  )
  assert.doesNotMatch(lines.lead, /сколько/)
  assert.match(lines.note ?? '', /срез бережёт память соседей, а не скорость — 4 посылки на одной карте считают медленнее, чем одна/)
  // Two cards of different sizes: whichever card a run lands on, it gets at least the smaller share.
  assert.equal(shareReadout(cards, ['0', '1'], 2).sliceMb, 8192)
  assert.equal(shareReadout(cards, ['0', '1'], 2).places, 4)
  // An untyped number is no reason for a fraction of a run.
  assert.equal(shareReadout(cards, ['0'], 2.7).perDevice, 2)
  setLocaleResolver(() => 'en')
  assert.equal(plain(`${shareGauge(four)} ${shareDetail(four)}`), '≈ 6 GB of GPU memory per submission · 4 places on the cards')
  assert.doesNotMatch(shareLines(four).lead, /how much/)
})

test('one run per card is the whole card, and a size nobody said promises nothing', () => {
  const whole = shareReadout([card('0')], ['0'], 1)
  assert.equal(whole.whole, true)
  assert.equal(shareGauge(whole), 'вся карта')
  assert.equal(plain(shareDetail(whole)), '1 место на картах')
  assert.equal(shareLines(whole).lead, 'Каждая посылка получает карту целиком.')

  // A MIG instance or a card the probe has not reached: no share, no cap, and the readout says so.
  const unknown = shareReadout([card('0'), card('1', { memoryMb: null })], ['0', '1'], 4)
  assert.equal(unknown.sliceMb, null)
  assert.equal(shareGauge(unknown), '—')
  assert.equal(plain(shareDetail(unknown)), '8 мест на картах')
  assert.deepEqual(
    { tone: shareLines(unknown).tone, lead: shareLines(unknown).lead },
    { tone: 'warning', lead: 'Объём карты неизвестен: доля видеопамяти не ограничена.' },
  )

  const none = shareReadout([card('0')], [], 4)
  assert.equal(none.chosen, 0)
  assert.equal(shareLines(none).lead, 'Посылкам не отдана ни одна карта: соревнование с видеокартой не примет посылки.')
})

test('«вернуть …» on the cards falls back to .env or the default, and the form can show which before Save', () => {
  // COMPETITION_GPUS="1" COMPETITION_GPU_PER_DEVICE="2" (deploy/vast/onstart.sh), and the owner saved card 0 at four a card.
  const fromEnv = settings({ fallback: { devices: ['1', 'GPU-gone'], perDevice: 2, source: { devices: 'env', perDevice: 'env' } } })
  assert.deepEqual(cardsFallback(fromEnv), { devices: ['1'], source: 'env' }, 'only the cards this machine lists')
  assert.deepEqual(perDeviceFallback(fromEnv), { perDevice: 2, source: 'env' })
  // The share the form then shows is the fallback's: card 1 at two a card, ≈ 12 GB, two places.
  assert.deepEqual(shareReadout(fromEnv.cards, cardsFallback(fromEnv)!.devices, perDeviceFallback(fromEnv)!.perDevice), {
    chosen: 1, perDevice: 2, places: 2, whole: false, sliceMb: 12_282,
  })
  // Nothing in .env: no card, one run per card.
  const bare = settings({ fallback: { devices: [], perDevice: 1, source: { devices: 'default', perDevice: 'default' } } })
  assert.deepEqual(cardsFallback(bare), { devices: [], source: 'default' })
  assert.deepEqual(perDeviceFallback(bare), { perDevice: 1, source: 'default' })
  // A server that does not say, and the cluster's cards: nothing to show.
  assert.equal(cardsFallback(settings()), null)
  assert.equal(perDeviceFallback(settings()), null)
  assert.equal(cardsFallback(settings({ managed: true, fallback: bare.fallback })), null)
  assert.equal(perDeviceFallback(null), null)
})

test('sizes the server had not read yet are taken from a later answer, and nothing else is', () => {
  const unread = settings({
    cards: [card('0', { holder: 'runners', name: null, memoryMb: null }), card('1', { holder: 'rooms', heldByRoom: true, name: null, memoryMb: null })],
    sliceMb: null,
  })
  assert.equal(sizesUnknown(unread), true)
  assert.equal(sizesUnknown(settings()), false)
  assert.equal(sizesUnknown(settings({ managed: true, cards: [], devices: [] })), false, 'the cluster has no sizes to ask')
  assert.equal(sizesUnknown(null), false)
  // The later answer knows the sizes — and a save made elsewhere meanwhile gave card 1 too, at two a card.
  const later = settings({ cards: [card('0', { holder: 'runners' }), card('1', { holder: 'runners' })], devices: ['0', '1'], perDevice: 2, sliceMb: 12_282 })
  const merged = withCardFacts(unread, later)
  assert.deepEqual(
    merged.cards.map((one) => [one.id, one.name, one.memoryMb, one.holder]),
    [['0', 'NVIDIA GeForce RTX 4090', RTX, 'runners'], ['1', 'NVIDIA GeForce RTX 4090', RTX, 'rooms']],
  )
  assert.deepEqual([merged.devices, merged.perDevice], [['0'], 4], 'the saved choice the edits are measured against stays')
  assert.equal(merged.sliceMb, null, 'the share of another choice is not this one')
  assert.equal(sizesUnknown(merged), false)
  // The same choice: its share comes too.
  assert.equal(withCardFacts(unread, settings()).sliceMb, 6141)
  // A size the form already knows is kept.
  assert.equal(withCardFacts(settings(), settings({ cards: [card('0', { memoryMb: null }), card('1', { memoryMb: null })] })).cards[0].memoryMb, RTX)
})

/* --------------------------------------------------------- the machine bar */

test('the cards\' bar counts cards, says who has them, and stays away where there are none', () => {
  assert.equal(cardsBar(null, null), null, 'the cluster has the cards')
  assert.equal(cardsBar({ total: 0, rooms: 0, runners: 0 }, null), null, 'a machine without any')
  const both = cardsBar({ total: 2, rooms: 1, runners: 1 }, settings())!
  assert.equal(both.free, 0)
  assert.equal(both.status, 'свободных нет — обе при деле')
  assert.equal(plain(both.roomsDetail), '1 карта · целиком на класс')
  assert.equal(plain(both.runnersDetail), '1 карта · по 4 сразу · срез ≈ 6 ГБ')
  assert.equal(plain(both.freeDetail), '0 карт')
  assert.equal(cardsBar({ total: 3, rooms: 1, runners: 1 }, settings())!.status, 'свободна 1 карта')
  assert.equal(cardsBar({ total: 1, rooms: 1, runners: 0 }, null)!.status, 'свободной нет — карта при деле')
  assert.equal(cardsBar({ total: 4, rooms: 2, runners: 2 }, null)!.status, 'свободных нет — все при деле')
  // One run per card, and the share of a card nobody measured: no number.
  assert.equal(plain(cardsBar({ total: 2, rooms: 0, runners: 2 }, settings({ perDevice: 1 }))!.runnersDetail), '2 карты · каждой посылке целиком')
  assert.equal(plain(cardsBar({ total: 2, rooms: 0, runners: 1 }, settings({ sliceMb: null }))!.runnersDetail), '1 карта · по 4 сразу')
  setLocaleResolver(() => 'en')
  assert.equal(cardsBar({ total: 2, rooms: 1, runners: 1 }, settings())!.status, 'none free — both are in use')
})

/* ------------------------------------------------------- the editor's row */

test('the editor\'s row: a CPU environment, a GPU one left off, a card on, and no card to be on', () => {
  assert.equal(gpuRowState({ environmentGpu: false, on: false, noCards: false }), 'cpu')
  assert.equal(gpuRowState({ environmentGpu: false, on: true, noCards: true }), 'cpu', 'the environment decides first')
  assert.equal(gpuRowState({ environmentGpu: true, on: false, noCards: true }), 'off')
  assert.equal(gpuRowState({ environmentGpu: null, on: false, noCards: false }), 'unknown')
  assert.equal(gpuRowState({ environmentGpu: true, on: true, noCards: false }), 'on')
  assert.equal(gpuRowState({ environmentGpu: true, on: true, noCards: true }), 'noCards')
  assert.equal(gpuRowState({ environmentGpu: null, on: true, noCards: false }), 'on', 'a saved card stays on while the list loads')
})

test('work that runs only the metric goes when all the executor lacks is the competition\'s card', () => {
  const verdict = (code: string, available = false): CompetitionCapabilities => {
    const execution = { available, code, reason: available ? null : 'no' }
    return { execution, preparation: execution }
  }
  assert.equal(metricWorkAvailable(verdict('available', true)), true)
  // The metric never gets a card: the server's metric check and rescores take it without one.
  assert.equal(metricWorkAvailable(verdict('gpu_unavailable')), true)
  // Anything more basic stops the metric as surely as the notebook.
  for (const code of ['docker_unavailable', 'image_unavailable', 'storage_unavailable', 'broker_unavailable']) {
    assert.equal(metricWorkAvailable(verdict(code)), false, code)
  }
  // No verdict (a server from before it) refuses nothing, as the button never did.
  assert.equal(metricWorkAvailable(undefined), true)
})

test('the switch names the share a run gets, and the line under it the places (Paper 15 · G2)', () => {
  assert.equal(plain(gpuSwitchWord(settings())), 'срез ≈ 6 ГБ')
  assert.equal(gpuSwitchWord(settings({ perDevice: 1, sliceMb: RTX })), 'вся карта')
  assert.equal(gpuSwitchWord(settings({ sliceMb: null })), 'срез')
  assert.equal(gpuSwitchWord(settings({ devices: [] })), 'срез', 'no card given: no share to name')
  assert.equal(gpuSwitchWord(settings({ managed: true, cards: [], devices: [] })), 'срез', 'the cluster decides it')
  assert.equal(gpuSwitchWord(null), 'срез')
  assert.equal(
    plain(gpuPlacesNote(settings(), 4096)),
    'На картах для посылок 4 места: GPU 0 по 4 посылки, срез ≈ 6 ГБ. Память 4 ГБ — это память машины для данных и torch, видеопамять считается отдельно.',
  )
  assert.equal(
    plain(gpuPlacesNote(settings({ devices: ['0', '1'], perDevice: 1, sliceMb: RTX }), 2048)),
    'На картах для посылок 2 места: GPU 0, GPU 1 по 1 посылке, карта целиком. Память 2 ГБ — это память машины для данных и torch, видеопамять считается отдельно.',
  )
  assert.equal(
    plain(gpuPlacesNote(settings({ managed: true, cards: [], devices: [] }), 4096)),
    'Память 4 ГБ — это память машины для данных и torch, видеопамять считается отдельно.',
  )
  setLocaleResolver(() => 'en')
  assert.equal(plain(gpuSwitchWord(settings())), 'share ≈ 6 GB')
  assert.equal(
    plain(gpuPlacesNote(settings(), 4096)),
    '4 places on the submission cards (GPU 0, 4 runs each), share ≈ 6 GB. Memory 4 GB is the machine\'s memory for data and torch; GPU memory is counted separately.',
  )
  assert.equal(shareGb(6141), '6')
  assert.equal(shareGb(20_389), '19.9')
})

/* --------------------------------------------------------- the console */

function queue(over: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return { paused: false, pausedAt: null, running: [], waiting: 0, slots: 22, doneToday: 0, averageMs: null, gpu: null, ...over }
}

test('a notebook waits for a card only when it needs one and every share is taken', () => {
  const full = queue({ gpu: { slots: 4, busy: 4, sliceMb: 6141 } })
  assert.equal(waitsForCard({ gpu: true, resourcePending: false }, full), true)
  assert.equal(waitsForCard({ gpu: false, resourcePending: false }, full), false, 'CPU work waits for a slot')
  assert.equal(waitsForCard({ gpu: true, resourcePending: true }, full), false, 'a resource retry waits for that')
  assert.equal(waitsForCard({ gpu: true, resourcePending: false }, queue({ gpu: { slots: 4, busy: 3, sliceMb: 6141 } })), false)
  // Every runner card still held by a class, or none given: no share to take at all.
  assert.equal(waitsForCard({ gpu: true, resourcePending: false }, queue({ gpu: { slots: 0, busy: 0, sliceMb: null } })), true)
  // The cluster places GPU work itself, and older servers send no flag.
  assert.equal(waitsForCard({ gpu: true, resourcePending: false }, queue()), false)
  assert.equal(waitsForCard({ resourcePending: false }, full), false)
  assert.equal(waitsForCard({ gpu: true, resourcePending: false }, null), false)
  // No card given, from a server that sends no picture then: the forecast gave
  // the GPU notebook no place, since it starts nowhere — it waits for a card.
  assert.equal(waitsForCard({ gpu: true, resourcePending: false, place: null }, queue()), true)
  // Under the cluster the forecast places GPU work like any other: a slot is its wait.
  assert.equal(waitsForCard({ gpu: true, resourcePending: false, place: 3 }, queue()), false)
  assert.equal(waitsForCard({ gpu: false, resourcePending: false, place: null }, queue()), false)
  assert.equal(waitsForCard({ gpu: true, resourcePending: true, place: null }, queue()), false, 'a retry has no place either')
})

test('GPU work with no place on any card says why in the console, and only then', () => {
  const rows = [
    { gpu: true, resourcePending: false, place: null },
    { gpu: false, resourcePending: false, place: 1 },
  ]
  // No card given: a server that sends no picture, and one that sends zero places.
  assert.equal(noPlaceOnCards(rows, queue()), true)
  assert.equal(noPlaceOnCards(rows, queue({ gpu: { slots: 0, busy: 0, sliceMb: null } })), true)
  // Every share busy for the moment: the rows' «ждёт место на видеокарте» says it all.
  assert.equal(noPlaceOnCards(rows, queue({ gpu: { slots: 4, busy: 4, sliceMb: 6141 } })), false)
  // Nothing waits for a card: a retry, the cluster's GPU work in its place, an empty list.
  assert.equal(noPlaceOnCards([{ gpu: true, resourcePending: true, place: null }], queue({ gpu: { slots: 0, busy: 0, sliceMb: null } })), false)
  assert.equal(noPlaceOnCards([{ gpu: true, resourcePending: false, place: 2 }], queue()), false)
  assert.equal(noPlaceOnCards([], queue({ gpu: { slots: 0, busy: 0, sliceMb: null } })), false)
  assert.equal(noPlaceOnCards(rows, null), false)
})

test('the console counts the jobs waiting for a card inside the queue\'s count', () => {
  assert.equal(waitingWords(4, 0), '4 ждут')
  assert.equal(waitingWords(4, 1), '4 ждут, одна из них — видеокарту')
  assert.equal(waitingWords(5, 2), '5 ждут, 2 из них — видеокарту')
  // Russian puts 21, 31 and 101 in the plural form of 1: «одна» is for one alone.
  assert.equal(waitingWords(23, 21), '23 ждут, 21 из них — видеокарту')
  assert.equal(waitingWords(32, 31), '32 ждут, 31 из них — видеокарту')
  assert.equal(waitingWords(102, 101), '102 ждут, 101 из них — видеокарту')
  assert.equal(waitingWords(2, 2), '2 ждут видеокарту')
  assert.equal(waitingWords(1, 1), '1 ждёт видеокарту')
  assert.equal(waitingWords(21, 21), '21 ждёт видеокарту')
  setLocaleResolver(() => 'en')
  assert.equal(waitingWords(4, 1), '4 waiting, one of them for a GPU')
  assert.equal(waitingWords(23, 21), '23 waiting, 21 of them for a GPU')
  assert.equal(waitingWords(3, 3), '3 waiting for a GPU')
})

test('the status line names the last result with one «≈», and under a minute in a sentence of its own', () => {
  assert.equal(plain(lastResultWords(90_000)), 'последняя досчитается ≈ через 1 мин')
  assert.equal(plain(lastResultWords(5 * 60_000)), 'последняя досчитается ≈ через 5 мин')
  assert.equal(lastResultWords(20_000), 'последняя досчитается вот-вот')
  setLocaleResolver(() => 'en')
  assert.equal(plain(lastResultWords(150_000)), 'the last result in ≈ 2 min')
  assert.equal(lastResultWords(20_000), 'the last result any moment now')
})

test('the runner strip counts the places on the cards when cards are given, and only then', () => {
  const withCards = runnerLine(queue({ running: [{} as never, {} as never], waiting: 1, gpu: { slots: 4, busy: 1, sliceMb: 6141 } }))
  assert.equal(withCards.head, 'исполняет 2 посылки · видеокарты 1 из 4 · 1 ждёт')
  const without = runnerLine(queue({ running: [{} as never], waiting: 1 }))
  assert.equal(without.head, 'исполняет 1 посылку · 1 ждёт')
  // A snapshot from a server before cards has no field at all.
  const { gpu: _gpu, ...older } = queue({ waiting: 0 })
  assert.equal(runnerLine(older as QueueSnapshot).head, 'ничего не исполняется')
  setLocaleResolver(() => 'en')
  assert.equal(runnerLine(queue({ gpu: { slots: 4, busy: 0, sliceMb: null } })).head, 'nothing is running · GPUs 0 of 4')
})

/* ------------------------------------------------------------ the screens */

const RESOURCES = flat(code(read('web/src/admin/screens/ResourcesTab.svelte')))
const EDITOR = flat(code(read('web/src/admin/screens/competitions/Editor.svelte')))
const LIVE = flat(code(read('web/src/admin/screens/competitions/Live.svelte')))
const RUNNING = flat(code(read('web/src/admin/ui/RunningKernels.svelte')))

test('the Resources tab gives cards inside «Соревнования», saved through the competitions door', () => {
  const section = RESOURCES.slice(RESOURCES.indexOf("tr('admin.resourcesTab.competitionsTitle')"), RESOURCES.indexOf("tr('admin.resourcesTab.filesTitle')"))
  assert.match(section, /\{@render runnerCards\(competitions\.gpu\)\}/, 'the block stands in the competitions section')
  const block = RESOURCES.slice(RESOURCES.indexOf('{#snippet runnerCards('), RESOURCES.indexOf('{#snippet actions()'))
  assert.match(block, /\{#if gpu\.managed\} <p [^>]*>\{tr\('admin\.resourcesTab\.gpuCluster'\)\}/, 'under the cluster: a note, no fields')
  assert.match(block, /\{:else if gpu\.cards\.length === 0\} <p [^>]*>\{tr\('admin\.resourcesTab\.gpuNoCards'\)\}/)
  assert.match(block, /<Check checked=\{picked\} [^>]*onchange=\{\(on\) => pickCard\(card\.id, on\)\}/, 'a real checkbox per card')
  assert.match(block, /\{@render field\( 'c\.gpuPerDevice',/, 'runs per card is a field like the others, with its source line')
  assert.match(block, /\{@render sourceLine\('c\.gpuDevices', sourceOf\('c\.gpuDevices'\)\)\}/, 'and so is the list of cards')
  // The owner-only fieldset greys the block for a teacher, like the rest of the form.
  assert.ok(RESOURCES.indexOf('<fieldset') < RESOURCES.indexOf('{@render runnerCards('))
  // Both halves go in one body; the cards as a list, never through the number loop.
  assert.match(RESOURCES, /competitionPatch\.gpuDevices = forgotten\.includes\(key\) \? null : \[\.\.\.gpuChosen\]/)
  assert.match(RESOURCES, /competitionPatch\.gpuPerDevice = forgotten\.includes\(key\) \? null : valueOf\(key\)/)
})

test('every source line names its own variable: the competition fields were all COMPETITION_SLOTS', () => {
  assert.doesNotMatch(RESOURCES, /\?\? 'COMPETITION_SLOTS'/)
  assert.match(RESOURCES, /'c\.slots': 'COMPETITION_SLOTS'/)
  assert.match(RESOURCES, /'c\.gpuDevices': 'COMPETITION_GPUS'/)
  assert.match(RESOURCES, /'c\.gpuPerDevice': 'COMPETITION_GPU_PER_DEVICE'/)
  assert.match(RESOURCES, /\{tr\('admin\.resourcesTab\.sourceEnv'\)\} <span class="font-mono">\{envNameOf\(key\) \?\? ''\}<\/span>/)
})

test('forgetting the saved cards shows at once what answers instead, and the button names it', () => {
  // «вернуть умолчание» was every competition field's word, and on the cards
  // it gave the COMPETITION_GPUS cards back while the ticks and the share
  // went on showing the saved ones until Save.
  assert.doesNotMatch(RESOURCES, /key\.startsWith\('c\.'\) \|\| !loaded\?\.settings/)
  assert.match(RESOURCES, /onclick=\{\(\) => forget\(key\)\}> \{backWord\(key\)\} <\/button>/)
  const word = RESOURCES.slice(RESOURCES.indexOf('function backWord('), RESOURCES.indexOf('function typed('))
  assert.match(word, /key === 'c\.gpuDevices' \? cardsFallback\(competitions\?\.gpu \?\? null\)\?\.source === 'env'/)
  assert.match(word, /key === 'c\.gpuPerDevice' \? perDeviceFallback\(competitions\?\.gpu \?\? null\)\?\.source === 'env'/)
  assert.match(word, /: !key\.startsWith\('c\.'\) && !!loaded\?\.settings\[key as ResourceSettingName\]\.envName/)
  const forget = RESOURCES.slice(RESOURCES.indexOf('function forget('), RESOURCES.indexOf('function backWord('))
  // The ticks (and with them the holders and the share) become the fallback's; runs per card its number.
  assert.match(forget, /if \(key === 'c\.gpuDevices'\) \{ const fallback = cardsFallback\(competitions\?\.gpu \?\? null\) if \(fallback\) gpuChosen = fallback\.devices return \}/)
  assert.match(forget, /if \(key === 'c\.gpuPerDevice'\) \{ const fallback = perDeviceFallback\(competitions\?\.gpu \?\? null\) texts\[key\] = fallback \? display\(key, fallback\.perDevice\) : '' return \}/)
  // Forgotten, both still go as null — the saved row goes, .env or the default answers.
  assert.match(RESOURCES, /competitionPatch\.gpuDevices = forgotten\.includes\(key\) \? null : \[\.\.\.gpuChosen\]/)
  assert.match(RESOURCES, /competitionPatch\.gpuPerDevice = forgotten\.includes\(key\) \? null : valueOf\(key\)/)
})

test('the Resources tab draws as soon as the rooms half lands, and asks again for sizes the cards have not said', () => {
  const load = RESOURCES.slice(RESOURCES.indexOf('async function load()'), RESOURCES.indexOf('const SIZE_ASKS'))
  // Both halves awaited together kept «Работают сейчас» behind the card probe.
  assert.doesNotMatch(load, /await Promise\.allSettled\(\[adminApi\.resourceSettings\(\), adminApi\.competitionSettings\(\)\]\)/)
  assert.match(load, /adminApi\.resourceSettings\(\)\.then\( \(response\) => \{ applyResources\(response\) loadErrorText = null \}/)
  assert.match(load, /adminApi\.competitionSettings\(\)\.then\( \(settings\) => \{ applyCompetitions\(settings\) competitionErrorText = null askSizesLater\(\) \}/)
  assert.match(RESOURCES, /const ready = \$derived\(loaded !== null\)/, 'the page waits for the rooms half only')
  // Until its half lands the competitions section stands on its own placeholder under its own title.
  const section = RESOURCES.slice(RESOURCES.indexOf("tr('admin.resourcesTab.competitionsTitle')"), RESOURCES.indexOf("tr('admin.resourcesTab.filesTitle')"))
  assert.match(section, /\{@render runnerCards\(competitions\.gpu\)\} \{:else\} <div role="status" aria-busy="true" aria-label=\{tr\('common\.loading'\)\}>/)
  // The later asks: a few, while a size is unknown, taking only the cards' own facts.
  const asks = RESOURCES.slice(RESOURCES.indexOf('function askSizesLater('), RESOURCES.indexOf('async function refreshBudget('))
  assert.match(asks, /if \(disposed \|\| attempt >= SIZE_ASKS \|\| !sizesUnknown\(competitions\?\.gpu \?\? null\)\) return/)
  assert.match(asks, /if \(competitions\) competitions = \{ \.\.\.competitions, gpu: withCardFacts\(competitions\.gpu, fresh\.gpu\) \}/)
  assert.match(asks, /\.finally\(\(\) => askSizesLater\(attempt \+ 1\)\)/)
  assert.match(RESOURCES, /disposed = true clearTimeout\(sizesTimer\)/, 'and none after the tab is gone')
})

test('the machine\'s cards are a bar of their own, with the panel\'s legend', () => {
  const machine = RESOURCES.slice(RESOURCES.indexOf("tr('admin.resourcesTab.machineTitle')"), RESOURCES.indexOf("tr('admin.resourcesTab.running.title')"))
  assert.match(machine, /\{#if gpuBar\}/)
  assert.match(machine, /\{@render legend\('bg-primary', tr\('admin\.resourcesTab\.gpuClasses'\), gpuBar\.roomsDetail\)\}/)
  assert.match(machine, /\{@render legend\('bg-accent', tr\('admin\.resourcesTab\.gpuSubmissions'\), gpuBar\.runnersDetail\)\}/)
  assert.match(RESOURCES, /const gpuBar = \$derived\(cardsBar\(loaded\?\.budget\.gpus, competitions\?\.gpu \?\? null\)\)/)
})

test('the editor marks a GPU environment and draws the card as a row under the tiles', () => {
  assert.match(EDITOR, /\{#if environmentGpu\} <Badge word="GPU" tone="accent" \/> \{\/if\}/)
  // A CPU environment picked takes the card away in the form, as the server would refuse the pair.
  assert.match(EDITOR, /bind:value=\{environment\} onchange=\{\(event\) => environmentPicked\(event\.currentTarget\.value\)\}/)
  assert.match(EDITOR, /if \(picked && !picked\.gpu && limits\.gpu === true\) limits\.gpu = false/)
  const row = EDITOR.slice(EDITOR.indexOf("tr('admin.competitions.limit.gpu')") - 200, EDITOR.indexOf('{#if gpuNote}'))
  assert.match(row, /<span class=\{cn\(HEAD, 'w-\[110px\] shrink-0', gpuLook\.head\)\}>/, 'the panel\'s label voice, like the tiles')
  // With machines that have cards, their share too (admin-runners-ui-review.test.mts).
  assert.match(row, /<Choice size="lg" options=\{\[ \{ value: 'off', label: tr\('admin\.competitions\.gpuOff'\) \}, \{ value: 'on', label: gpuSwitchWord\(runnerCards, machineShare\) \}, \]\}/)
  assert.match(row, /disabled=\{gpuState === 'cpu' && !gpuOn\}/, 'a card left on a CPU environment can still be turned off')
  assert.match(row, /onchange=\{\(value\) => \(limits\.gpu = value === 'on'\)\}/)
  // No card for submissions: the owner gets the way to «Ресурсы», a teacher the name of who can.
  // In a new tab: this one holds the form, and leaving it dropped every unsaved
  // field — the switch just turned on, the description, the metric's code.
  assert.match(row, /\{#if adminAuth\.isOwner && !gpuCluster\} <a class="btn-outline shrink-0" href="\/admin\/resources" target="_blank" rel="noreferrer"> \{tr\('admin\.competitions\.openResources'\)\} <\/a>/)
  assert.doesNotMatch(row, /navigate\(/, 'nothing in the row leaves the form')
  assert.match(row, /tr\('admin\.competitions\.gpuNoCardsTeacher'\)/)
  assert.doesNotMatch(row, /admin-affix/, 'a switch, not a third prefixed field')
  // The environments door's cards are kept, not dropped (runners decide «no card» before the settings answer).
  assert.match(EDITOR, /environmentGpus = state\.gpus/)
})

test('without a card for submissions the metric check stays on, while the baseline check and opening stay off', () => {
  // The metric check: the button and its own guard ask the metric's question, not the notebook's.
  assert.match(EDITOR, /async function checkMetric\(\): Promise<void> \{ if \(!metricWorkAvailable\(view\.capabilities\)\) return/)
  assert.match(EDITOR, /disabled=\{busy \|\| !view\.baseline \|\| !metricWorkAvailable\(view\.capabilities\)\} onclick=\{\(\) => void checkMetric\(\)\}/)
  // The baseline check and opening run the notebook, which needs the card.
  assert.match(EDITOR, /async function checkBaseline\(\): Promise<void> \{ if \(view\.capabilities\?\.execution\.available === false\) return/)
  assert.match(EDITOR, /disabled=\{busy \|\| baselineInFlight \|\| view\.capabilities\?\.execution\.available === false\} onclick=\{\(\) => void checkBaseline\(\)\}/)
  assert.equal(
    EDITOR.match(/disabled=\{busy \|\| refusal !== null \|\| view\.capabilities\?\.execution\.available === false\}/g)?.length,
    2,
    'both open buttons',
  )
  // The console's rescores were never held by the notebook's verdict, and stay so.
  const item = LIVE.slice(LIVE.lastIndexOf('<button', LIVE.indexOf('void rescoreOne(s.id)')), LIVE.indexOf("tr('admin.competitions.menu.rescore')"))
  assert.match(item, /^<button type="button" role="menuitem" class="admin-menu-item" onclick=\{\(\) => \{ openMenu = null void rescoreOne\(s\.id\) \}\} > \{$/)
  assert.match(LIVE, /disabled=\{busy\} onclick=\{\(\) => void rescoreAll\(\)\}/)
})

test('under the cluster the owner reads which setting gives submissions a GPU; a teacher reads what a participant reads', () => {
  const box = EDITOR.slice(EDITOR.indexOf("{#if gpuState === 'noCards'}"), EDITOR.indexOf('{#if gpuNote}'))
  assert.match(
    box,
    /\{#if gpuCluster && adminAuth\.isOwner\} \{tr\('admin\.competitions\.gpuNoCardsClusterOwner'\)\} \{:else if gpuCluster\} \{view\.capabilities\?\.execution\.reason \?\? tr\('runtime\.gpuUnavailableCluster'\)\}/,
  )
  // The owner's words name the Helm value and the broker's variable, and an older broker.
  const owner = tr('admin.competitions.gpuNoCardsClusterOwner')
  assert.match(owner, /gpu\.competitions\.resource/)
  assert.match(owner, /RUNTIME_COMPETITION_GPU_RESOURCE/)
  assert.match(owner, /обновите брокер/)
  // A participant's (and a teacher's) words name no setting at all.
  assert.doesNotMatch(tr('runtime.gpuUnavailableCluster'), /RUNTIME_|gpu\.competitions/)
  setLocaleResolver(() => 'en')
  const english = tr('admin.competitions.gpuNoCardsClusterOwner')
  assert.match(english, /set gpu\.competitions\.resource in Helm \(RUNTIME_COMPETITION_GPU_RESOURCE on the broker\)/)
  assert.match(english, /update the broker if it is older than the app/)
  assert.doesNotMatch(tr('runtime.gpuUnavailableCluster'), /RUNTIME_|gpu\.competitions/)
})

test('the owner\'s card list paints a card a submission is finishing on in amber, like one a class still holds', () => {
  const tone = RESOURCES.slice(RESOURCES.indexOf('const HOLDER_TONE'), RESOURCES.indexOf('const LINE_TONE'))
  assert.match(tone, /leaving: 'font-semibold text-warning'/)
  assert.match(tone, /finishing: 'font-semibold text-warning'/)
  assert.match(RESOURCES, /\{@const holder = cardHolder\(card, picked\)\}/)
  assert.match(RESOURCES, /HOLDER_TONE\[holder\]\)\}>\{holderWord\(holder\)\}/)
})

test('back from «Ресурсы» in the other tab, the editor reads the cards again and keeps the form', () => {
  const reread = EDITOR.slice(EDITOR.indexOf('const rereadCards'), EDITOR.indexOf("window.addEventListener('focus', rereadCards)"))
  assert.match(reread, /if \(document\.visibilityState !== 'visible' \|\| Date\.now\(\) - readAt < 2_000\) return/)
  // The cards, and the same answer whole for the cores line (queueSettings).
  assert.match(reread, /void adminApi \.competitionSettings\(\) \.then\(\(settings\) => \{ runnerCards = settings\.gpu queueSettings = settings \}\)/)
  // Only the cards: the drafts are keyed to the competition and stay as typed.
  assert.doesNotMatch(reread, /onview|limits\s*=|drafted/)
  assert.match(EDITOR, /window\.addEventListener\('focus', rereadCards\) document\.addEventListener\('visibilitychange', rereadCards\)/)
  assert.match(EDITOR, /window\.removeEventListener\('focus', rereadCards\) document\.removeEventListener\('visibilitychange', rereadCards\)/)
  assert.equal(tr('admin.competitions.openResources'), 'Открыть «Ресурсы» в новой вкладке')
})

test('the GPU mark beside the environment does not wait for the list to name the environment', () => {
  // A live competition's Settings tab is the same editor: the mark stands
  // apart from the list's own badges, and a saved card says it too.
  const select = EDITOR.slice(EDITOR.indexOf("aria-label={tr('admin.competitions.environmentLabel')}"), EDITOR.indexOf("tr('admin.competitions.sameAsRoom')"))
  assert.match(select, /\{\/if\} \{#if environmentGpu\} <Badge word="GPU" tone="accent" \/> \{\/if\} \{#if chosenEnvironment\}/)
  assert.doesNotMatch(select, /chosenEnvironment\.gpu/)
  assert.match(
    EDITOR,
    /const environmentGpu = \$derived\( chosenEnvironment \? chosenEnvironment\.gpu === true : environment === c\.environment && c\.limits\.gpu === true \? true : null, \)/,
  )
})

test('the console shows the card a run holds and what a waiting notebook waits for', () => {
  assert.match(LIVE, /\{#if run\.gpu\} <span class="inline-flex shrink-0" title=\{run\.gpu\.device \|\| undefined\}> <Badge word=\{cardWord\(run\.gpu\.device\)\} tone="accent" case="lower" class="font-mono" \/>/)
  // The busy places are notebook runs on executors that give places (admin/runners.ts · consoleLoad, admin-runners-ui-r2.test.mts).
  assert.match(LIVE, /tr\('admin\.competitions\.slotsHeadGpu', \{ busy: load\.busy, count: slots, gpuBusy: queue\.gpu\.busy, gpuCount: queue\.gpu\.slots, \}\)/)
  // The card a waiting notebook waits for, after a machine's reason when it has one
  // (admin/runners.ts · waitingLine, admin-runners-ui-review.test.mts).
  assert.match(LIVE, /\{@const line = waitingLine\(row, waitsForCard\(row, queue\), homeWord\)\}/)
  assert.match(LIVE, /waitingWords\(queue\?\.waiting \?\? waiting\.length, onCards\)/)
  // With no share on any card, the list under «ЖДУТ» says why before its rows.
  assert.match(LIVE, /const cardless = \$derived\(noPlaceOnCards\(waiting, queue\)\)/)
  assert.match(
    LIVE,
    /\{#if cardless\} <p class="text-2xs leading-snug text-warning">\{cardlessWarning\(machineGroups !== null\)\}<\/p> \{\/if\} \{#each waiting as row \(row\.submissionId\)\}/,
  )
  // The status line's last result has one «≈» (lastResultWords), not etaWords inside a sentence with its own.
  assert.match(LIVE, /lastEtaMs !== null \? lastResultWords\(lastEtaMs\) : null/)
  assert.doesNotMatch(LIVE, /tr\('admin\.competitions\.lastResult'/)
})

test('«Работают сейчас» shows a run\'s card where it used to print a dash', () => {
  const runs = RUNNING.slice(RUNNING.indexOf('{#each data.runs as run'), RUNNING.indexOf('{#each data.preparations'))
  assert.match(runs, /\{#if run\.gpu\} <span class="rk-cores whitespace-nowrap font-mono text-micro text-muted" title=\{run\.gpu\}>\{cardWord\(run\.gpu\)\}<\/span>/)
  // On a phone card a run on a card keeps its meta line; one on the CPU stays as quiet as before.
  assert.match(runs, /<div class=\{cn\('rk-row', !run\.gpu && 'rk-row-end'\)\}>/)
  assert.match(runs, /<div class=\{cn\('rk-meta', !run\.gpu && 'rk-meta-quiet'\)\}>/)
})
