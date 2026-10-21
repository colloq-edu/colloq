/**
 * The council's pool where people read it (Paper 18 · Z8, Z8b, Z9; docs/
 * architecture/remote-classes.md §9, §13.1): the strip under the console's
 * header, the line of what a snapshot could not carry, the two rules of the
 * sheet, the queue tab while a snapshot is taken, every card's footnote and
 * files — the console's work and the author's sheet — and the class form's
 * «Консилиум» part now that the pool is there.
 *
 * The words are decided in web/src/lib/council-pult.ts and checked here
 * directly, in both languages where a word could slip; the components are
 * rendered on the server with their session and their parts standing in, as
 * the room's other component tests render theirs, and what a press sends is
 * read from their files.
 *
 * What these guard is what the console could get wrong quietly: a pool's
 * attempt drawn as the notebook's current run, a stop that names the cell
 * alone and so interrupts the teacher's cell instead, a count the data does
 * not carry, an amber footnote on an attempt that computed as meant, a rule
 * row offered to a class whose council never leaves the notebook's kernel.
 */
import fs from 'node:fs'
import path from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { messages, setLocaleResolver, translate } from '../shared/i18n.js'
import { CLASS_PLACEMENT_DEFAULT, COUNCIL_POOL, type ClassPlacement } from '../shared/admin.js'
import { DEFAULT_COUNCIL, type CouncilSettings } from '../shared/notebook.js'
import { COUNCIL_ARTIFACTS } from '../shared/remote-kernels.js'
import type { CouncilAttempt, CouncilBoard, CouncilKernel, CouncilPool, CouncilRun } from '../shared/protocol.js'
import {
  ATTEMPT_FILE_CAPS,
  attemptFiles,
  attemptFootnote,
  kernelAhead,
  kernelView,
  poolLeftKeys,
  poolLeftLine,
  poolLeftNew,
  poolStrip,
  pultClock,
  runStats,
} from '../web/src/lib/council-pult.js'

const web = (rel: string) => new URL(`../web/src/${rel}`, import.meta.url).href
const shared = (rel: string) => new URL(`../shared/${rel}`, import.meta.url).href
const read = (rel: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
/** Markup without comments: an explanation is not a promise. */
const code = (source: string): string => source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim()

/** 14:05 today, by this machine's clock: what the console's clock (pultClock) says of it. */
const AT = new Date(2026, 9, 21, 14, 5, 0).getTime()

afterEach(() => setLocaleResolver(() => 'ru'))

/* ------------------------------------------------------------- fixtures */

function pool(over: Partial<CouncilPool> = {}): CouncilPool {
  return {
    state: 'ready',
    machine: 'vast-3',
    workers: 8,
    busy: 6,
    queued: 0,
    size: 8,
    refreezing: false,
    epoch: { seq: 4, at: AT, bytes: 1288490189, carried: 12, left: [], behind: 0 },
    ...over,
  }
}

function run(over: Partial<CouncilRun> = {}): CouncilRun {
  return { state: 'ok', outputs: [], execCount: 1, ranMs: 400, startedAt: AT, by: 'host', ...over }
}

function attempt(id: string, over: Partial<CouncilAttempt> = {}): CouncilAttempt {
  return {
    participantId: id,
    name: id,
    color: '#336699',
    avatar: null,
    text: `print(${id})`,
    submittedAt: AT,
    updatedAt: AT,
    status: 'ran',
    run: null,
    reply: null,
    correct: null,
    shown: false,
    groupKey: id,
    ...over,
  }
}

function board(attempts: CouncilAttempt[], settings: Partial<CouncilSettings> = {}, lock: CouncilBoard['lock'] = 'council'): CouncilBoard {
  return {
    lock,
    settings: { ...DEFAULT_COUNCIL, ...settings },
    counts: { attempts: attempts.length, submitted: attempts.length, writing: 0, groups: 0 },
    attempts,
    groups: [],
    oracle: null,
  }
}

/** The server's sentences a card's note is written in (shared/locales/server.ts), in the room's language. */
const server = (key: string, params?: Record<string, string | number>) => translate('ru', key, params)

/* -------------------------------------------------------- the pool strip */

test('the strip is drawn only for a class whose council is on machines, and a shared lane says only that', () => {
  assert.equal(poolStrip(null, DEFAULT_COUNCIL), null, 'no pool in the kernel frame: the console as before')
  assert.equal(poolStrip(undefined, DEFAULT_COUNCIL), null)
  assert.deepEqual(poolStrip(pool(), { lane: 'shared', refresh: 'auto' }), { kind: 'lane' })
})

test('a ready pool: free workers first, then those computing, its machine, its snapshot and how it changes', () => {
  const strip = poolStrip(pool({ workers: 8, busy: 6, queued: 5, refreezing: true }), { lane: 'pool', refresh: 'manual' })
  assert.ok(strip?.kind === 'ready')
  assert.deepEqual(strip.bars, ['ready', 'ready', 'busy', 'busy', 'busy', 'busy', 'busy', 'busy'])
  assert.deepEqual([strip.ready, strip.busy, strip.queued, strip.machine, strip.at, strip.refresh, strip.refreezing, strip.note, strip.recycled], [2, 6, 5, 'vast-3', AT, 'manual', true, null, false])
  // A worker restarted in the last minute for what an attempt left it in.
  const recycled = poolStrip(pool({ recycled: true }), DEFAULT_COUNCIL)
  assert.ok(recycled?.kind === 'ready' && recycled.recycled)
  // No snapshot yet: no time is said.
  const first = poolStrip(pool({ epoch: null }), DEFAULT_COUNCIL)
  assert.ok(first?.kind === 'ready' && first.at === null)
  // The server's note about a newer snapshot that does not fit travels with it.
  const late = poolStrip(pool({ note: server('server.theNewStateDoesNotFit.1c7533', { time: '14:05' }) }), DEFAULT_COUNCIL)
  assert.ok(late?.kind === 'ready' && late.note === 'Новое состояние не помещается — попытки на состоянии 14:05.')
  // A pool of 32 draws 32 bars, never more.
  const big = poolStrip(pool({ workers: 40, busy: 40 }), DEFAULT_COUNCIL)
  assert.ok(big?.kind === 'ready' && big.bars.length === 32 && big.busy === 40)
})

test('starting, stalled and shared say why the attempts run in the shared kernel, in the server\'s words', () => {
  // Three up of the four it is to have: green for those up, grey for the one coming (Z8b «готовы 3 из 4»).
  const starting = poolStrip(pool({ state: 'starting', workers: 3, busy: 0, size: 4, epoch: null }), DEFAULT_COUNCIL)
  assert.deepEqual(starting, { kind: 'starting', bars: ['ready', 'ready', 'ready', 'pending'], machine: 'vast-3', up: 3, size: 4 })
  // Its size not known yet (no pool made): every one up grey, no «из».
  assert.deepEqual(poolStrip(pool({ state: 'starting', workers: 2, busy: 0, size: 0, epoch: null }), DEFAULT_COUNCIL), { kind: 'starting', bars: ['pending', 'pending'], machine: 'vast-3', up: 2, size: 0 })
  // Not up a minute after the first attempt: «Пул не поднялся:» leads, the machine's words follow.
  const why = 'на vast-3 не хватает памяти — свободно 1,2 ГБ, нужно 4,5 ГБ'
  const stalled = poolStrip(pool({ state: 'starting', note: server('server.thePoolDidNotStart.80644c', { why }) }), DEFAULT_COUNCIL)
  assert.deepEqual(stalled, { kind: 'stalled', lead: 'Пул не поднялся:', why })
  // A note in English on a Russian console is the same sentence: the server wrote it in the instance's language.
  const english = poolStrip(pool({ state: 'starting', note: translate('en', 'server.thePoolDidNotStart.80644c', { why: 'its workers did not start' }) }), DEFAULT_COUNCIL)
  assert.deepEqual(english, { kind: 'stalled', lead: 'The pool did not start:', why: 'its workers did not start' })
  const gpu = server('server.theNotebookSStateHoldsDataOn.2ac2bc')
  assert.deepEqual(poolStrip(pool({ state: 'shared', note: gpu }), DEFAULT_COUNCIL), { kind: 'shared', note: gpu, refreezing: false })
  // Every worker failed to come up: the server says the same sentence with `shared`, until its retry — the same strip.
  const broken = poolStrip(pool({ state: 'shared', workers: 0, busy: 0, note: server('server.thePoolDidNotStart.80644c', { why }) }), DEFAULT_COUNCIL)
  assert.deepEqual(broken, { kind: 'stalled', lead: 'Пул не поднялся:', why })
})

test('a time the server wrote into its sentence is said on the console\'s clock, as the strip\'s own', () => {
  // The instance's zone said 11:05 for the snapshot this browser's clock calls 14:05 (pultClock(AT)).
  const late = poolStrip(pool({ note: server('server.theNewStateDoesNotFit.1c7533', { time: '11:05' }) }), DEFAULT_COUNCIL)
  assert.ok(late?.kind === 'ready')
  assert.equal(late.note, 'Новое состояние не помещается — попытки на состоянии 14:05.')
  assert.equal(pultClock(late.at!), '14:05')
  const older = attemptFootnote(run({ placed: 'pool', epoch: { seq: 3, at: AT, behind: 2 }, note: server('server.stateAsOfWithoutCells.44aa0a', { time: '11:05', cells: '8–9' }) }))
  assert.deepEqual(older, { short: 'состояние 14:05 — без ячеек 8–9', full: 'Состояние 14:05 — без ячеек 8–9.', tone: 'warning' })
  // Written in English, read in Russian: in the room's words, on its clock.
  const one = attemptFootnote(run({ placed: 'pool', epoch: { seq: 3, at: AT, behind: 1 }, note: translate('en', 'server.stateAsOfWithoutCell.30d8e4', { time: '11:05', cells: '9' }) }))
  assert.equal(one?.full, 'Состояние 14:05 — без ячейки 9.')
  // Any other sentence stays as it came.
  const odd = attemptFootnote(run({ placed: 'pool', epoch: { seq: 3, at: AT, behind: 1 }, note: 'Something else at 11:05.' }))
  assert.equal(odd?.full, 'Something else at 11:05.')
})

test('the left names, once per snapshot: the server\'s reasons, a long list cut on the line and whole in its hover', () => {
  const left = [{ name: 'conn', why: 'соединение с базой' }, { name: 'batches', why: 'генератор' }]
  assert.equal(poolLeftLine(left), 'Не переносится: conn (соединение с базой), batches (генератор).')
  assert.equal(poolLeftLine([]), null)
  const many = Array.from({ length: 14 }, (_, i) => ({ name: `f${i}`, why: 'открытый файл' }))
  assert.match(poolLeftLine(many)!, /f11 \(открытый файл\), …\.$/)
  assert.doesNotMatch(poolLeftLine(many)!, /f12/)
  assert.match(poolLeftLine(many, true)!, /f13 \(открытый файл\)\.$/)
  setLocaleResolver(() => 'en')
  assert.equal(poolLeftLine([{ name: 'conn', why: 'database connection' }]), 'Not carried over: conn (database connection).')
})

/* ------------------------------------------------------- card footnotes */

test('a card says where it computed: apart on a snapshot in grey, and amber for an older snapshot', () => {
  const apart = attemptFootnote(run({ placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 }, runId: 'r1' }))
  assert.deepEqual(apart, {
    short: `посчитано отдельно · состояние ${pultClock(AT)}`,
    full: `Посчитано отдельно от тетради, на её состоянии в ${pultClock(AT)}.`,
    tone: 'muted',
  })
  assert.equal(pultClock(AT), '14:05')
  const older = attemptFootnote(run({ placed: 'pool', epoch: { seq: 3, at: AT, behind: 2 }, note: server('server.stateAsOfWithoutCells.44aa0a', { time: '14:05', cells: '8–9' }) }))
  assert.deepEqual(older, { short: 'состояние 14:05 — без ячеек 8–9', full: 'Состояние 14:05 — без ячеек 8–9.', tone: 'warning' })
  // Waiting for a worker, or computing on one: where it computes may still change (its entry may send it to the
  // shared kernel, its machine may go), so nothing is said until it ends.
  assert.equal(attemptFootnote(run({ state: 'queued', placed: 'pool' })), null)
  assert.equal(attemptFootnote(run({ state: 'running', placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 } })), null)
  assert.equal(attemptFootnote(run({ state: 'queued', placed: 'shared', note: server('server.theMachineWasLostInTheMiddle.b5f5c5') })), null)
  assert.equal(attemptFootnote(run({ state: 'error', placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 } }))?.tone, 'muted', 'an error of the code is no less computed apart')
  // A class whose council is not on machines: its cards say nothing new.
  assert.equal(attemptFootnote(run()), null)
  assert.equal(attemptFootnote(null), null)
})

test('a run in the shared kernel: Z9\'s three short lines, and the server\'s sentence for any other reason', () => {
  const starting = server('server.thePoolIsStillStartingThisAttempt.bf84be')
  assert.deepEqual(attemptFootnote(run({ placed: 'shared', note: starting })), { short: 'в общем ядре: пул поднимается', full: starting, tone: 'muted' })
  const uses = server('server.runInTheSharedKernelItUses.eaf141', { name: 'conn' })
  assert.deepEqual(attemptFootnote(run({ placed: 'shared', note: uses })), { short: 'в общем ядре: использует conn', full: uses, tone: 'warning' })
  const lost = server('server.theMachineWasLostInTheMiddle.b5f5c5')
  assert.deepEqual(attemptFootnote(run({ placed: 'shared', note: lost })), { short: 'пересчитано в общем ядре: машина пропала', full: lost, tone: 'warning' })
  const away = server('server.thePoolSMachineDoesNotAnswer.16922d')
  assert.deepEqual(attemptFootnote(run({ placed: 'shared', note: away })), { short: 'машина пула не отвечает — эта попытка посчитана в общем ядре', full: away, tone: 'warning' })
  // Written in English, read in Russian: still known, and said in the room's language.
  assert.equal(attemptFootnote(run({ placed: 'shared', note: translate('en', 'server.runInTheSharedKernelItUses.eaf141', { name: 'db' }) }))?.short, 'в общем ядре: использует db')
  // No reason given: no footnote.
  assert.equal(attemptFootnote(run({ placed: 'shared' })), null)
  setLocaleResolver(() => 'en')
  assert.equal(attemptFootnote(run({ placed: 'shared', note: uses }))?.short, 'in the shared kernel: uses conn')
})

test('an attempt\'s files on its card: kept ones with their sizes, the rest counted, «больше 1 МБ» only when it is true', () => {
  assert.deepEqual(ATTEMPT_FILE_CAPS, COUNCIL_ARTIFACTS, 'the console\'s copy of the contract\'s numbers')
  assert.equal(attemptFiles(run()), null)
  assert.equal(attemptFiles(run({ files: [] })), null)
  const sha = 'a'.repeat(64)
  const two = attemptFiles(run({ files: [{ name: 'out.csv', bytes: 12 * 1024, kept: true, sha256: sha }, { name: 'fig.png', bytes: 40 * 1024, kept: true, sha256: 'b'.repeat(64) }] }))
  assert.deepEqual(two, { brought: [{ name: 'out.csv', size: '12 КБ', coming: false, sha256: sha }, { name: 'fig.png', size: '40 КБ', coming: false, sha256: 'b'.repeat(64) }], dropped: null, droppedNames: '' })
  const big = attemptFiles(run({
    files: [
      { name: 'out.csv', bytes: 12 * 1024, kept: true },
      { name: 'model.pt', bytes: 3 * 1024 * 1024, kept: false },
      { name: 'big.csv', bytes: 2 * 1024 * 1024, kept: false },
      { name: 'x.npy', bytes: 5 * 1024 * 1024, kept: false },
    ],
  }))
  assert.equal(big?.dropped, 'ещё 3 файла не сохранены: больше 1 МБ')
  assert.equal(big?.droppedNames, 'model.pt 3,0 МБ, big.csv 2,0 МБ, x.npy 5,0 МБ')
  // A small file left past the count (20) or the total (5 MB), or that its machine never sent: no reason is better than a wrong one.
  const small = (count: number, bytes: number, kept: number) =>
    Array.from({ length: count }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}.txt`, bytes, kept: i < kept }))
  assert.equal(attemptFiles(run({ files: small(21, 10, 20) }))?.dropped, 'ещё 1 файл не сохранён', 'the 21st')
  assert.equal(attemptFiles(run({ files: small(6, 1024 * 1024, 5) }))?.dropped, 'ещё 1 файл не сохранён', 'past 5 MB in all')
  assert.equal(attemptFiles(run({ files: small(2, 10, 1) }))?.dropped, 'ещё 1 файл не сохранён', 'its collection ended without it')
  const none = attemptFiles(run({ files: [{ name: 'big.bin', bytes: 2 * 1024 * 1024, kept: false }] }))
  assert.equal(none?.dropped, '1 файл не сохранён: больше 1 МБ')
  setLocaleResolver(() => 'en')
  assert.equal(attemptFiles(run({ files: [{ name: 'a', bytes: 1, kept: true }, { name: 'b', bytes: 2e6, kept: false }, { name: 'c', bytes: 2e6, kept: false }] }))?.dropped, '2 more files not kept: over 1 MB')
})

test('the files of an attempt that just ended are on their way, not left behind', () => {
  // The run's end names those it brings `kept: null` (epochs.ts · attemptCardFiles); each turns kept as it lands.
  const atEnd = attemptFiles(run({ files: [{ name: 'out.csv', bytes: 12 * 1024, kept: null, sha256: 'a'.repeat(64) }, { name: 'fig.png', bytes: 40 * 1024, kept: null, sha256: 'b'.repeat(64) }] }))
  assert.deepEqual(atEnd, { brought: [{ name: 'out.csv', size: '12 КБ', coming: true, sha256: null }, { name: 'fig.png', size: '40 КБ', coming: true, sha256: null }], dropped: null, droppedNames: '' })
  const one = attemptFiles(run({ files: [{ name: 'out.csv', bytes: 12 * 1024, kept: true, sha256: 'a'.repeat(64) }, { name: 'fig.png', bytes: 40 * 1024, kept: null }] }))
  assert.deepEqual(one?.brought.map((file) => [file.coming, file.sha256 !== null]), [[false, true], [true, false]], 'only one here is taken')
  // The one past the caps is left behind from the start; the rest come.
  const mixed = attemptFiles(run({ files: [{ name: 'a.csv', bytes: 10, kept: null }, { name: 'model.pt', bytes: 3 * 1024 * 1024, kept: false }, { name: 'b.csv', bytes: 10, kept: null }] }))
  assert.deepEqual(mixed?.brought.map((file) => file.name), ['a.csv', 'b.csv'])
  assert.equal(mixed?.dropped, 'ещё 1 файл не сохранён: больше 1 МБ')
})

test('the kernel ahead of an attempt\'s snapshot is said only where the console knows the count', () => {
  const onFour = run({ placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 } })
  const epoch = (seq: number, behind: number) => ({ seq, at: AT, bytes: 1, carried: 1, left: [], behind })
  assert.equal(kernelAhead(onFour, pool({ epoch: epoch(4, 3) })), 3)
  assert.equal(kernelAhead(onFour, pool({ epoch: epoch(4, 0) })), null, 'the kernel is where the snapshot was')
  assert.equal(kernelAhead(onFour, pool({ epoch: epoch(5, 0) })), null, 'an older snapshot: the server counts at the adoption')
  assert.equal(kernelAhead(run({ placed: 'shared' }), pool({ epoch: epoch(4, 3) })), null, 'the shared kernel computed on its live state')
  assert.equal(kernelAhead(onFour, null), null)
  assert.equal(kernelAhead(run({ state: 'running', placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 } }), pool({ epoch: epoch(4, 3) })), null, 'no result yet to differ')
  assert.match(translate('ru', 'server.theKernelHasRunCellsSinceThe.e29733', { count: 3 }), /^Ядро ушло вперёд на 3 ячейки после снимка — результат в тетради может отличаться\.$/)
})

/* --------------------------------------------------------- the queue */

test('the notebook\'s queue holds no pool\'s attempt: a worker\'s run is neither the current one nor waiting there', () => {
  const book: CouncilKernel = { busy: null, queued: 1, pool: pool() }
  const view = kernelView([
    attempt('worker', { run: run({ state: 'running', placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 } }) }),
    attempt('waits', { run: run({ state: 'queued', placed: 'pool', startedAt: AT + 1 }) }),
    attempt('shared', { run: run({ state: 'queued', placed: 'shared', note: 'x', startedAt: AT + 2 }) }),
    attempt('old', { run: run({ state: 'queued', startedAt: AT + 3 }) }),
  ], book)
  assert.equal(view.running, null, 'a pool\'s attempt is not the notebook\'s current run')
  assert.deepEqual(view.queued.map((one) => one.participantId), ['shared', 'old'])
  assert.equal(view.pool, book.pool)
  assert.equal(kernelView([attempt('a', { run: run({ state: 'running' }) })]).running?.participantId, 'a', 'a run that says nothing is the notebook\'s, as before')
  assert.equal(kernelView([]).pool, null)
})

test('where this cell\'s runs computed, counted for the rules sheet, with the names that sent some to the shared kernel', () => {
  assert.equal(runStats([]), null)
  assert.deepEqual(runStats([attempt('a', { run: run({ ranMs: 800 }) })]), { median: 800, max: 800, count: 1 }, 'no run says where: nothing about it')
  const stats = runStats([
    attempt('a', { run: run({ placed: 'pool', ranMs: 400 }) }),
    attempt('b', { run: run({ placed: 'pool', state: 'running', ranMs: null }) }),
    attempt('c', { run: run({ placed: 'shared', ranMs: 900, note: server('server.runInTheSharedKernelItUses.eaf141', { name: 'conn' }) }) }),
    attempt('d', { run: run({ placed: 'shared', ranMs: 300, note: server('server.thePoolIsStillStartingThisAttempt.bf84be') }) }),
  ])
  assert.deepEqual(stats, { median: 400, max: 900, count: 3, placed: { apart: 2, shared: 2, names: ['conn'] } })
  // Only running ones so far: where, yes; how long, not yet.
  assert.deepEqual(runStats([attempt('a', { run: run({ placed: 'pool', state: 'running', ranMs: null }) })]), { median: 0, max: 0, count: 0, placed: { apart: 1, shared: 0, names: [] } })
})

test('the console\'s window hands its cell to the work and its pool to the rules sheet: no part looks for them', () => {
  const window = code(read('web/src/components/council/pult/PultWindow.svelte'))
  assert.match(window, /<PultWork\s+attempt=\{current\}\s+\{cellId\}/)
  assert.match(window, /<PultRules[\s\S]{0,400}pool=\{kernel\.pool\}/)
  for (const part of ['PultWork', 'PultRules']) {
    const source = code(read(`web/src/components/council/pult/${part}.svelte`))
    assert.doesNotMatch(source, /boardOf(Attempt|Settings)/, `${part} still looks for its cell`)
  }
  assert.doesNotMatch(read('web/src/lib/council-pult.ts'), /export function boardOf/)
})

/* ------------------------------------------------------------- words */

test('every word of the pool is in both languages, the English free of Cyrillic, the Russian as §13.2 spells it', () => {
  const keys = Object.keys(messages).filter((key) => key.startsWith('room.pult.pool.') || key.startsWith('room.council.pool.'))
  assert.ok(keys.length >= 40, `${keys.length} words`)
  for (const key of keys) {
    const en = JSON.stringify(messages[key]!.en)
    assert.doesNotMatch(en, /[А-Яа-яЁё]/, `${key} has Cyrillic in English`)
  }
  const ru = (key: string, params?: Record<string, string | number>) => translate('ru', key, params)
  assert.equal(ru('room.pult.pool.left', { names: 'conn (соединение с базой), batches (генератор)' }), 'Не переносится: conn (соединение с базой), batches (генератор).')
  assert.equal(ru('room.pult.pool.rules.laneTitle'), 'Попытки считаются')
  assert.equal(ru('room.pult.pool.rules.refreshTitle'), 'Состояние для попыток')
  assert.equal(ru('room.pult.pool.refresh'), 'Обновить')
  assert.equal(ru('room.pult.pool.snapshot'), 'снимок состояния')
  assert.deepEqual([0, 1, 2, 5, 21].map((count) => ru('room.pult.pool.ready', { count })), ['0 готовы', '1 готов', '2 готовы', '5 готовы', '21 готов'])
  assert.deepEqual([1, 8].map((count) => ru('room.pult.pool.busy', { count })), ['1 считает', '8 считают'])
  assert.deepEqual([1, 5].map((count) => ru('room.pult.pool.queued', { count })), ['1 ждёт', '5 ждут'])
  assert.deepEqual([1, 2, 31].map((count) => ru('room.pult.pool.rules.attempts', { count })), ['1 попытка', '2 попытки', '31 попытка'])
})

/* --------------------------------------------------- the components */

let dir: string
let Header: Component<any>
let Rules: Component<any>
let Queue: Component<any>
let Work: Component<any>
let OnScreen: Component<any>
let Resources: Component<any>

/** The session the console's parts read (lib/session.svelte.ts · getSessionState): its piles, its kernel frames, its sends. */
interface FakeSession {
  connected: boolean
  me: { role: string; id: string }
  session: { id: string }
  token: string
  /** Browser clock minus the server's (lib/session.svelte.ts · clockSkewMs). */
  clockSkewMs: number
  council: { boards: Record<string, CouncilBoard>; kernels: Record<string, CouncilKernel>; adopt: (...args: unknown[]) => void }
  sent: unknown[]
  send: (message: unknown) => void
}

function session(boards: Record<string, CouncilBoard>, kernels: Record<string, CouncilKernel>, role = 'host', clockSkewMs = 0): FakeSession {
  const fake: FakeSession = {
    connected: true,
    me: { role, id: 'p_teacher' },
    session: { id: 'room1' },
    token: 't',
    clockSkewMs,
    council: { boards, kernels, adopt: () => undefined },
    sent: [],
    send: (message) => fake.sent.push(message),
  }
  ;(globalThis as { __pult?: FakeSession }).__pult = fake
  return fake
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-classes-council-'))
  const stub = async (name: string, body: string) => {
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, body)
    return pathToFileURL(file).href
  }
  const component = await stub('component', 'export default function Stub() {}\n')
  const sessionStub = await stub('session', 'export function getSessionState() { return globalThis.__pult }\n')
  // Taking a file is the browser's (an anchor): the press is read from the source, as the others are.
  const filesStub = await stub('council-files', 'export async function takeAttemptFile() { return null }\n')
  const historyStub = await stub('history', 'export function clock() { return "14:05" }\n')
  const build = async (rel: string, out: string, extra: Array<[string, string]>): Promise<Component<any>> => {
    const source = await readFile(new URL(`../web/src/${rel}`, import.meta.url), 'utf8')
    let js = compile(source, { filename: path.basename(rel), generate: 'server' }).js.code
    for (const [from, to] of [
      ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
      ['svelte', import.meta.resolve('svelte')],
      ['@shared/i18n', shared('i18n.ts')],
      ['@shared/notebook', shared('notebook.ts')],
      ['@shared/protocol', shared('protocol.ts')],
      ['@shared/admin', shared('admin.ts')],
      ['@/lib/council-pult', web('lib/council-pult.ts')],
      ['@/lib/council-footnote', web('lib/council-footnote.ts')],
      ['@/lib/council-files', filesStub],
      ['@/lib/session.svelte', sessionStub],
      ['@/lib/utils', web('lib/utils.ts')],
      ['@/components/ui/Icon.svelte', component],
      ['@/components/ui/Avatar.svelte', component],
      ...extra,
    ] as Array<[string, string]>) js = js.replaceAll(`'${from}'`, JSON.stringify(to))
    const file = path.join(dir, `${out}.mjs`)
    await writeFile(file, js)
    return (await import(pathToFileURL(file).href)).default
  }
  Header = await build('components/council/pult/PultHeader.svelte', 'PultHeader', [
    ['@/components/lecture/ConsoleLink.svelte', component],
    ['./PultCells.svelte', component],
  ])
  Rules = await build('components/council/pult/PultRules.svelte', 'PultRules', [])
  Queue = await build('components/council/pult/PultQueueStrip.svelte', 'PultQueueStrip', [
    ['@/components/ui/ContextMenu.svelte', component],
  ])
  Work = await build('components/council/pult/PultWork.svelte', 'PultWork', [
    ['@/components/notebook/CellOutputs.svelte', component],
    ['@/components/ui/Code.svelte', component],
    ['./PultActions.svelte', component],
    ['./PultLetters.svelte', component],
    ['./PultReply.svelte', component],
  ])
  OnScreen = await build('components/council/pult/PultOnScreen.svelte', 'PultOnScreen', [
    ['@/lib/history', historyStub],
  ])
  Resources = await build('admin/ui/Resources.svelte', 'Resources', [
    ['@/admin/ui/Check.svelte', component],
    ['@/components/ui/Skeleton.svelte', component],
    ['@/admin/runners', web('admin/runners.ts')],
  ])
})

after(async () => {
  delete (globalThis as { __pult?: FakeSession }).__pult
  if (dir) await rm(dir, { recursive: true, force: true })
})

const noop = () => undefined

/** The console's header for cell c1, with the session as given. */
function header(boards: Record<string, CouncilBoard>, kernels: Record<string, CouncilKernel>, openRule: string | null = null): string {
  session(boards, kernels)
  return render(Header, {
    props: { cellId: 'c1', cells: [], title: 'Класс', rules: [], openRule, onrules: noop, onpick: noop, onexit: noop },
  }).body
}

test('Z8 · the strip under the header: workers, machine, snapshot, how it changes, «Обновить»', () => {
  const html = header({ c1: board([]) }, { c1: { busy: null, queued: 0, pool: pool({ workers: 8, busy: 8, queued: 5 }) } })
  const strip = text(html.slice(html.indexOf('data-pult-pool=')))
  assert.match(strip, /^.*0 готовы · 8 считают · 5 ждут · vast-3 · состояние 14:05 · следует за ядром Обновить/)
  assert.match(html, /data-pult-pool="ready"/)
  assert.equal(html.match(/class="pool-bar[^"]*"[^>]*data-bar="busy"/g)?.length, 8)
  assert.match(html, /data-pult-pool-value="refresh"[^>]*aria-expanded="false"/)
  // The sheet open on its row: the value says so, as the sentence's do.
  assert.match(header({ c1: board([]) }, { c1: { busy: null, queued: 0, pool: pool() } }, 'refresh'), /data-pult-pool-value="refresh"[^>]*aria-expanded="true"/)
  // «По кнопке», and a snapshot being taken.
  const manual = text(header({ c1: board([], { refresh: 'manual' }) }, { c1: { busy: null, queued: 0, pool: pool({ refreezing: true }) } }))
  assert.match(manual, /по кнопке · снимок состояния Обновить/)
})

test('Z8b · the strip\'s other states: starting, not up, shared, and a cell sent to the shared kernel', () => {
  const kernels = (over: Partial<CouncilPool>) => ({ c1: { busy: null, queued: 0, pool: pool(over) } })
  assert.match(text(header({ c1: board([]) }, kernels({ state: 'starting', workers: 2, busy: 0, size: 4, epoch: null }))), /Пул поднимается · готовы 2 из 4 · vast-3 · пока попытки — в общем ядре/)
  assert.match(text(header({ c1: board([]) }, kernels({ state: 'starting', workers: 0, busy: 0, size: 0, machine: null, epoch: null }))), /Пул поднимается · пока попытки — в общем ядре/, 'no size yet: no «из»')
  const stalled = header({ c1: board([]) }, kernels({ state: 'starting', note: server('server.thePoolDidNotStart.80644c', { why: 'исполнители не запустились' }) }))
  assert.match(stalled, /<strong class="pool-lead[^"]*">Пул не поднялся:<\/strong>/)
  assert.match(text(stalled), /Пул не поднялся: исполнители не запустились · попытки — в общем ядре/)
  // Every worker broken (`shared`): the same strip, and no «Обновить» — a snapshot would not start them.
  const broken = header({ c1: board([]) }, kernels({ state: 'shared', workers: 0, busy: 0, note: server('server.thePoolDidNotStart.80644c', { why: 'исполнители не запустились' }) }))
  assert.match(broken, /data-pult-pool="stalled"/)
  assert.match(text(broken), /Пул не поднялся: исполнители не запустились · попытки — в общем ядре/)
  assert.doesNotMatch(broken, /data-pult-pool-refresh/)
  const shared = text(header({ c1: board([]) }, kernels({ state: 'shared', note: server('server.theNotebookSStateDoesNotFit.c67b68') })))
  assert.match(shared, /Состояние тетради не помещается — попытки считаются в общем ядре\. Обновить/)
  const lane = header({ c1: board([], { lane: 'shared' }) }, kernels({}))
  assert.match(text(lane), /Попытки — в общем ядре, по очереди · вместе с вашими ячейками, по одной/)
  assert.match(lane, /data-pult-pool-value="lane"/)
  assert.doesNotMatch(text(lane), /Обновить|vast-3/, 'the pool is not this cell\'s: nothing of it')
})

test('Z8 · «исполнитель перезапущен» for a minute after an attempt left a worker unfit, before «Обновить»', () => {
  const html = header({ c1: board([]) }, { c1: { busy: null, queued: 0, pool: pool({ recycled: true }) } })
  assert.match(html, /<span class="pool-recycled[^"]*" role="status" title="Попытка оставила исполнителя в негодном виде/)
  assert.match(text(html), /следует за ядром исполнитель перезапущен Обновить/)
  assert.doesNotMatch(header({ c1: board([]) }, { c1: { busy: null, queued: 0, pool: pool() } }), /data-pult-pool-recycled/)
})

test('Z9 · the hash seed\'s note, once a room: a notebook kernel older than the class\'s seed, until the teacher hides it', () => {
  const differs = (over: Partial<CouncilSettings> = {}) =>
    header({ c1: board([], over) }, { c1: { busy: null, queued: 0, pool: pool({ epoch: { seq: 4, at: AT, bytes: 1, carried: 3, left: [], behind: 0, seedDiffers: true } }) } })
  assert.match(text(differs()), /Порядок множеств в попытках может отличаться от тетради: её ядро запущено до обновления\./)
  assert.match(differs(), /data-pult-pool-seed/)
  assert.doesNotMatch(differs({ lane: 'shared' }), /data-pult-pool-seed/, 'attempts in the notebook\'s kernel hash as it does')
  assert.doesNotMatch(header({ c1: board([]) }, { c1: { busy: null, queued: 0, pool: pool() } }), /data-pult-pool-seed/)
  const source = code(read('web/src/components/council/pult/PultHeader.svelte'))
  assert.match(source, /const hiddenSeed = new Set<string>\(\)/)
  assert.match(source, /function hideSeed\(\): void \{\s*hiddenSeed\.add\(session\.session\.id\)/)
  assert.match(source, /onclick=\{hideSeed\}/)
})

test('no strip where the class\'s council is not on machines, nor for a closed council', () => {
  assert.doesNotMatch(header({ c1: board([]) }, { c1: { busy: null, queued: 0 } }), /data-pult-pool/)
  assert.doesNotMatch(header({ c1: board([]) }, {}), /data-pult-pool/)
  assert.doesNotMatch(header({ c1: board([], {}, 'closed') }, { c1: { busy: null, queued: 0, pool: pool() } }), /data-pult-pool/)
})

test('Z8 · «Не переносится: …» under the strip, with what it means for such attempts, and a way to hide it', () => {
  const left = [{ name: 'conn', why: 'соединение с базой' }, { name: 'batches', why: 'генератор' }]
  const html = header({ c1: board([]) }, { c1: { busy: null, queued: 0, pool: pool({ epoch: { seq: 4, at: AT, bytes: 1, carried: 3, left, behind: 0 } }) } })
  assert.match(text(html), /Не переносится: conn \(соединение с базой\), batches \(генератор\)\. такие попытки — в общем ядре/)
  assert.match(html, /data-pult-pool-left/)
  // A cell whose attempts go to the shared kernel anyway: the line would say nothing to it.
  const lane = header({ c1: board([], { lane: 'shared' }) }, { c1: { busy: null, queued: 0, pool: pool({ epoch: { seq: 4, at: AT, bytes: 1, carried: 3, left, behind: 0 } }) } })
  assert.doesNotMatch(lane, /data-pult-pool-left/)
  // Hidden by its names, for the room's cell: a cell switch remounts the console, and the line stays hidden.
  const source = code(read('web/src/components/council/pult/PultHeader.svelte'))
  assert.match(source, /<script module lang="ts">[\s\S]*const hiddenLeft = new Map<string, ReadonlySet<string>>\(\)/)
  assert.match(source, /const leftScope = \$derived\(`\$\{session\.session\.id\}\\u0000\$\{cellId\}`\)/)
  assert.match(source, /poolLeftNew\(pool\.epoch\.left, hidden\.get\(leftScope\) \?\? NONE_HIDDEN\)/)
  assert.match(source, /hiddenLeft\.set\(leftScope, new Set\(\[\.\.\.\(hiddenLeft\.get\(leftScope\) \?\? \[\]\), \.\.\.poolLeftKeys\(pool\.epoch\.left\)\]\)\)/)
  assert.match(source, /onclick=\{hideLeft\}/)
})

test('a hidden «Не переносится» line stays hidden across snapshots with the same names, and a new name brings it back', () => {
  const conn = { name: 'conn', why: 'соединение с базой' }
  const batches = { name: 'batches', why: 'генератор' }
  const hidden = new Set(poolLeftKeys([conn, batches]))
  // A cell that follows the kernel: the next snapshot leaves the same two behind.
  assert.equal(poolLeftNew([conn, batches], hidden), false)
  assert.equal(poolLeftNew([batches], hidden), false, 'fewer of them: nothing new to say')
  assert.equal(poolLeftNew([conn, batches, { name: 'f', why: 'открытый файл' }], hidden), true, 'a new name')
  assert.equal(poolLeftNew([{ name: 'conn', why: 'поток' }], hidden), true, 'the same name for another reason')
  assert.equal(poolLeftNew([conn], new Set()), true)
})

test('the strip\'s presses: «Обновить» asks the server for a snapshot of this cell, a value opens the sheet on its row', () => {
  const source = code(read('web/src/components/council/pult/PultHeader.svelte'))
  assert.match(source, /session\.send\(\{ t: 'council:epoch', cellId \}\)/)
  assert.match(source, /data-pult-pool-refresh disabled=\{idle\}[\s\S]{0,80}onclick=\{refresh\}/)
  assert.match(source, /onclick=\{\(event\) => onrules\('refresh', event\.currentTarget\)\}/)
  assert.match(source, /onclick=\{\(event\) => onrules\('lane', event\.currentTarget\)\}/)
  // Offline, or not the teacher: the button greys, and a press sends nothing.
  assert.match(source, /const idle = \$derived\(!session\.connected \|\| session\.me\.role !== 'host'\)/)
  assert.match(source, /function refresh\(\): void \{\s*if \(idle\) return/)
})

/** The rules sheet for cell c1 with these rules. */
function rules(settings: CouncilSettings, kernels: Record<string, CouncilKernel>, stats: ReturnType<typeof runStats> = null, rule = 'lane'): string {
  return render(Rules, {
    props: { settings, rule, pending: 0, stats, cellLimit: 30, disabled: false, top: 56, pool: kernels.c1?.pool ?? null, onchange: noop, onclose: noop },
  }).body
}

test('Z8b · the sheet\'s two rows for the pool, their notes, and what an attempt sees', () => {
  const settings = { ...DEFAULT_COUNCIL }
  const stats = runStats([
    ...Array.from({ length: 31 }, (_, i) => attempt(`a${i}`, { run: run({ placed: 'pool' }) })),
    attempt('s1', { run: run({ placed: 'shared', note: server('server.runInTheSharedKernelItUses.eaf141', { name: 'conn' }) }) }),
    attempt('s2', { run: run({ placed: 'shared', note: server('server.runInTheSharedKernelItUses.eaf141', { name: 'conn' }) }) }),
  ])
  const html = rules(settings, { c1: { busy: null, queued: 0, pool: pool({ workers: 8 }) } }, stats)
  const sheet = text(html)
  assert.match(sheet, /Попытки считаются Отдельно, параллельно ✓ В общем ядре по очереди Каждая попытка — в своём исполнителе на снимке тетради: 8 одновременно на vast-3, ваши ячейки их не держат\./)
  assert.match(sheet, /Сегодня: 31 попытка отдельно · 2 в общем ядре \(conn\)/)
  assert.match(sheet, /Состояние для попыток Следует за ядром ✓ По кнопке Вы выполнили ячейку — следующая попытка сначала ждёт новый снимок, до 5 с\./)
  // The snapshot's time and size, and how long the last one took (Z8b): «снимок 1,2 ГБ, переснимается за 0,4 с».
  assert.match(sheet, /Сейчас: состояние 14:05 · снимок 1,2 ГБ$|Сейчас: состояние 14:05 · снимок 1,2 ГБ /)
  assert.match(text(rules(settings, { c1: { busy: null, queued: 0, pool: pool({ tookMs: 400 }) } })), /Сейчас: состояние 14:05 · снимок 1,2 ГБ, переснимается за 0,4 с/)
  assert.match(text(rules(settings, { c1: { busy: null, queued: 0, pool: pool({ tookMs: 400, epoch: { seq: 1, at: AT, bytes: 0, carried: 0, left: [], behind: 0 } }) } })), /Сейчас: состояние 14:05 (?!·)/, 'an empty snapshot has no size to say')
  assert.match(sheet, /Попытка видит переменные снимка и файлы занятия только для чтения; свои файлы она пишет в личную папку\. Общее состояние меняет только «В ячейку и запустить»\./)
  assert.doesNotMatch(sheet, /Решения выполняются по очереди в ядре этой тетради/, 'the shared kernel\'s note is not the pool\'s')
  assert.match(html, /data-pult-rules-row="lane"[^>]*class="rules-row[^"]*here|class="rules-row[^"]*here[^"]*"[^>]*data-pult-rules-row="lane"/, 'the row it was opened on is lit')
  // The cell sent to the shared kernel: the rows stay — the way back is one press — and the footer is the shared kernel's.
  const lane = text(rules({ ...DEFAULT_COUNCIL, lane: 'shared' }, { c1: { busy: null, queued: 0, pool: pool() } }))
  assert.match(lane, /Отдельно, параллельно В общем ядре по очереди ✓/)
  assert.match(lane, /Решения выполняются по очереди в ядре этой тетради/)
  // A pool not up yet: no number nobody knows.
  assert.match(text(rules(settings, { c1: { busy: null, queued: 0, pool: pool({ state: 'starting', workers: 0, machine: null, epoch: null }) } })), /Каждая попытка — в своём исполнителе на снимке тетради, ваши ячейки их не держат\./)
  // «Все по очереди» on the pool: one kernel, one at a time, is no longer what happens.
  const everyone = text(rules({ ...DEFAULT_COUNCIL, studentRun: true }, { c1: { busy: null, queued: 0, pool: pool() } }, null, 'studentRun'))
  assert.match(everyone, /Студент запускает свою попытку сам; в пуле попытки считаются одновременно, каждая в своём исполнителе\./)
  assert.match(text(rules({ ...DEFAULT_COUNCIL, studentRun: true, lane: 'shared' }, { c1: { busy: null, queued: 0, pool: pool() } }, null, 'studentRun')), /ядро одно, поэтому по одному за раз/)
})

test('a class whose council is not on machines has its four rules alone', () => {
  const sheet = text(rules({ ...DEFAULT_COUNCIL }, { c1: { busy: null, queued: 0 } }, null, 'studentRun'))
  assert.doesNotMatch(sheet, /Попытки считаются|Состояние для попыток/)
  assert.match(sheet, /Решения выполняются по очереди в ядре этой тетради/)
  // The limit's numbers stay those of finished runs: none finished yet, none said.
  const running = runStats([attempt('a', { run: run({ placed: 'pool', state: 'running', ranMs: null }) })])
  assert.doesNotMatch(text(rules({ ...DEFAULT_COUNCIL }, { c1: { busy: null, queued: 0, pool: pool() } }, running, 'runLimit')), /обычно|typically/)
})

/** The queue tab with this kernel frame and these rules; the browser's clock `skew` ms ahead of the server's. */
function queue(kernel: CouncilKernel | null, settings: Partial<CouncilSettings> = {}, skew = 0): string {
  session({}, {}, 'host', skew)
  return render(Queue, {
    props: {
      kernel: kernelView([], kernel),
      settings: { ...DEFAULT_COUNCIL, ...settings },
      attempts: [],
      names: true,
      now: AT,
      open: true,
      disabled: false,
      ontoggle: noop, oninterrupt: noop, onrestart: noop, onapprove: noop, ondecline: noop, onapproveall: noop, onopen: noop, ondrop: noop, onremove: noop,
    },
  }).body
}

test('Z8b · the queue tab with the pool: the notebook\'s queue by name, and the snapshot while it is taken', () => {
  const taking = queue({ busy: null, queued: 2, pool: pool({ refreezing: true, epoch: { seq: 4, at: AT, bytes: 1, carried: 3, left: [], behind: 2 } }) })
  assert.match(text(taking), /Очередь тетради · ячейки и попытки в общем ядре — по одной/)
  // The snapshot is the one run the card says is running, and the count over it says so too (Z8b).
  assert.match(text(taking), /1 выполняется · 2 в очереди тетради/)
  assert.match(text(taking), /Сейчас выполняется снимок состояния следующие попытки ждут его, до 5 с/)
  assert.match(taking, /class="running-card[^"]*is-running/)
  assert.doesNotMatch(taking, /pult-button--danger/, 'no stop beside it: a stop never reaches the snapshot')
  // Timed from when the server asked it (CouncilPool.snapshot), on its clock: a tab opened late, or again, says the same.
  const timed = queue({ busy: null, queued: 0, pool: pool({ refreezing: true, snapshot: { since: AT - 400, after: 9 }, epoch: { seq: 4, at: AT, bytes: 1, carried: 3, left: [], behind: 2 } }) })
  assert.match(text(timed), /Сейчас выполняется снимок состояния · 0,4 с после вашей ячейки 9 · следующие попытки ждут его, до 5 с/)
  // The browser's clock two seconds ahead of the server's: the same 0,4 с.
  const skewed = queue({ busy: null, queued: 0, pool: pool({ refreezing: true, snapshot: { since: AT - 2400, after: null }, epoch: { seq: 4, at: AT, bytes: 1, carried: 3, left: [], behind: 2 } }) }, {}, 2000)
  assert.match(text(skewed), /снимок состояния · 0,4 с следующие попытки ждут его, до 5 с/)
  assert.doesNotMatch(code(read('web/src/components/council/pult/PultQueueStrip.svelte')), /Date\.now\(\)|snapshotSince/, 'never from the tab\'s own opening')
  // «По кнопке», or a snapshot of an unchanged state: the next attempts do not wait for it.
  assert.doesNotMatch(text(queue({ busy: null, queued: 0, pool: pool({ refreezing: true, epoch: { seq: 4, at: AT, bytes: 1, carried: 3, left: [], behind: 2 } }) }, { refresh: 'manual' })), /ждут его/)
  assert.doesNotMatch(text(queue({ busy: null, queued: 0, pool: pool({ refreezing: true }) })), /ждут его/)
  // A cell deaf to its interrupts: the restart's cost is named, and with the pool what the restart leaves alone.
  const deaf = (over: Partial<CouncilSettings> = {}) => text(queue({ busy: { kind: 'cell', index: 3, name: 'Ада', participantId: null, here: false, startedAt: AT - 60_000, limitSec: 30, stuck: true }, queued: 0, pool: pool() }, over))
  assert.match(deaf(), /Переменные сбросятся у всех, кто работает в этой тетради, — и у вас\. Пул консилиума это не трогает: попытки считаются на прежнем снимке, пока вы снова не выполните ячейки\./)
  assert.doesNotMatch(deaf({ lane: 'shared' }), /Пул консилиума это не трогает/, 'a cell on the shared kernel loses its attempts\' state with the rest')
  // Not taking one: the kernel is free, as before; a cell sent to the shared kernel reads the notebook's queue as before.
  assert.match(text(queue({ busy: null, queued: 0, pool: pool() })), /Ядро этой тетради свободно/)
  assert.match(text(queue({ busy: null, queued: 0, pool: pool() }, { lane: 'shared' })), /Очередь ядра этой тетради · код выполняется по одному/)
  assert.match(text(queue({ busy: null, queued: 0 })), /Очередь ядра этой тетради · код выполняется по одному/)
})

/** The console's work on one attempt of cell c1. */
function work(one: CouncilAttempt, kernels: Record<string, CouncilKernel> = {}, onScreen = false): string {
  session({ c1: board([one]) }, kernels)
  return render(Work, {
    props: {
      attempt: one, cellId: 'c1', presence: 'online', index: 1, total: 1, onstep: noop, variant: 1, names: true, now: AT, onScreen, shownAt: null,
      disabled: false, limit: 30, phone: false, onrules: noop, reply: '', replyFromOracle: false, onshow: noop, onclear: noop,
      onrun: noop, oninterrupt: noop, onmark: noop, onreplychange: noop, onreplysend: noop, onreplyfocus: noop, onreplyblur: noop, onremove: noop,
    },
  }).body
}

test('Z9 · the work\'s run line gets its second line, and the attempt\'s files come under the output', () => {
  const one = attempt('anya', {
    run: run({ placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 }, runId: 'r1', files: [{ name: 'out.csv', bytes: 12 * 1024, kept: true, sha256: 'a'.repeat(64) }, { name: 'fig.png', bytes: 40 * 1024, kept: true, sha256: 'b'.repeat(64) }] }),
  })
  const html = work(one)
  assert.match(html, /<p class="work-footnote[^"]*" data-tone="muted" title="Посчитано отдельно от тетради, на её состоянии в 14:05\." data-pult-footnote/)
  assert.match(text(html), /посчитано отдельно · состояние 14:05 файлы попытки: out\.csv 12 КБ ↓ fig\.png 40 КБ ↓/)
  // Each one here is taken from its chip (GET …/council/c1/files): a button, its arrow drawn.
  assert.match(html, /<button type="button" class="work-file work-file-take[^"]*" data-pult-file-take="out\.csv" title="Скачать out\.csv"/)
  assert.match(code(read('web/src/components/council/pult/PultWork.svelte')), /takeAttemptFile\(session\.session\.id, session\.token, cellId, attempt\.participantId, name\)/)
  // The second line of the run's header: after the run line, before the output.
  assert.ok(html.indexOf('work-execution-head') < html.indexOf('data-pult-footnote') && html.indexOf('data-pult-footnote') < html.indexOf('data-pult-files'))
  // A file still on its way is drawn as such, not as one left behind — and is no button yet.
  const coming = work(attempt('anya', { run: run({ placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 }, files: [{ name: 'out.csv', bytes: 12 * 1024, kept: null }] }) }))
  assert.match(coming, /class="work-file[^"]*" data-coming="yes"/)
  assert.match(text(coming), /файлы попытки: out\.csv 12 КБ в пути/)
  assert.doesNotMatch(text(coming), /не сохран/)
  assert.doesNotMatch(coming, /data-pult-file-take/)
  // Amber, the whole sentence kept for a phone.
  const uses = server('server.runInTheSharedKernelItUses.eaf141', { name: 'conn' })
  const shared = work(attempt('petya', { run: run({ placed: 'shared', note: uses }) }))
  assert.match(shared, /data-tone="warning"/)
  assert.match(text(shared), new RegExp(`в общем ядре: использует conn ${uses.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.doesNotMatch(work(attempt('old', { run: run() })), /data-pult-footnote|data-pult-files/, 'a class without the pool: as before')
})

test('Z8 · the kernel ahead of the work\'s snapshot, before «В ячейку и запустить» — the button only for the work on screen', () => {
  const one = attempt('anya', { run: run({ placed: 'pool', epoch: { seq: 4, at: AT, behind: 0 } }) })
  const kernels = { c1: { busy: null, queued: 0, pool: pool({ epoch: { seq: 4, at: AT, bytes: 1, carried: 3, left: [], behind: 3 } }) } }
  const off = work(one, kernels)
  assert.match(text(off), /Ядро ушло вперёд на 3 ячейки после снимка — результат в тетради может отличаться\./)
  assert.doesNotMatch(text(off), /В ячейку и запустить/, 'the server puts in the cell only the work on screen')
  assert.match(text(work(one, kernels, true)), /Ядро ушло вперёд на 3 ячейки после снимка — результат в тетради может отличаться\. В ячейку и запустить/)
  assert.doesNotMatch(work(one, { c1: { busy: null, queued: 0, pool: pool() } }), /data-pult-ahead/, 'the kernel is where the snapshot was')
})

test('a pool\'s attempt is stopped on its worker by name, never by a stop of the cell alone', () => {
  const source = code(read('web/src/components/council/pult/PultWork.svelte'))
  assert.match(source, /oninterrupt=\{stop\}/, 'the actions\' stop goes through the work')
  assert.match(source, /run\?\.placed === 'pool'\) \{\s*if \(!disabled\) session\.send\(\{ t: 'interrupt', cellId, participantId: attempt\.participantId \}\)\s*return/)
  assert.match(source, /oninterrupt\(\)\s*\}/, 'the notebook\'s kernel as before for any other')
  assert.match(source, /session\.council\.adopt\(cellId, attempt\.participantId, true\)/)
  assert.match(source, /if \(disabled \|\| !attempt \|\| !onScreen\) return/)
})

test('a run waiting for the pool is taken off the queue from its work: the queue tab lists the notebook\'s queue alone', () => {
  const source = code(read('web/src/components/council/pult/PultWork.svelte'))
  // The work's menu offers it for a waiting run, beside «Удалить из класса».
  assert.match(source, /\{#if run\?\.state === 'queued'\}\s*<button type="button" role="menuitem" class="work-drop"[^>]*data-pult-drop onclick=\{\(\) => \{ menuOpen = false; dropRun\(\) \}\}>\{tr\('room\.pult\.v3\.queue\.drop'\)\}/)
  assert.match(source, /function dropRun\(\): void \{\s*if \(disabled \|\| !attempt \|\| run\?\.state !== 'queued'\) return\s*session\.council\.dropRun\(cellId, attempt\.participantId\)/)
  // What it lost: the queue tab no longer lists a pool's waiting run.
  assert.deepEqual(kernelView([attempt('waits', { run: run({ state: 'queued', placed: 'pool' }) })]).queued, [])
})

test('Z9 · the author\'s sheet: the footnote right under the output, the files under it, before who ran it', () => {
  const cell = code(read('web/src/components/notebook/CellView.svelte'))
  // From the small module, never the console's: CellView is in the room's chunk every student downloads (K9b review, finding 10).
  assert.match(cell, /import \{ attemptFiles, attemptFootnote \} from '@\/lib\/council-footnote'/)
  assert.doesNotMatch(cell, /@\/lib\/council-pult'/)
  assert.doesNotMatch(read('web/src/lib/council-footnote.ts'), /from '@\/lib\/(council-pult|api|session)/, 'the small module drags nothing of the console\'s in')
  // The author takes a file kept here from the sheet.
  assert.match(cell, /takeAttemptFile\(session\.session\.id, session\.token, id, session\.me\.id, name\)/)
  const block = cell.slice(cell.indexOf('<CellOutputs outputs={attemptRun.outputs} />'), cell.indexOf('{ranByLine(attemptRun, spell)}'))
  assert.ok(block.length > 0)
  assert.ok(block.indexOf('data-council-footnote') > 0 && block.indexOf('data-council-footnote') < block.indexOf('data-council-files'))
  assert.match(block, /title=\{attemptNote\.full\}/)
  assert.match(block, /attemptNote\.tone === 'warning' && tightFooter \? attemptNote\.full : attemptNote\.short/, 'a narrow sheet reads the whole sentence')
  assert.match(block, /tr\('room\.council\.pool\.files'\)/)
})

test('Z8 · «В ячейку и запустить» of an attempt on an older snapshot: the server\'s warning right under the success line', () => {
  const shown = { participantId: 'anya', variant: 1, name: 'Аня', color: '#123456', avatar: null, shownBy: 'Ада', shownAt: AT, text: 'print(x)', run: null, alsoWrote: 0, correct: null }
  const warning = server('server.theKernelHasRunCellsSinceThe.e29733', { count: 3 })
  const html = render(OnScreen, { props: { shown, now: AT, disabled: false, onclear: noop, adopted: { participantId: 'anya', run: true, at: AT, warning }, onadopt: noop, onundo: noop } }).body
  assert.match(html, /<p class="projection-warning[^"]*" role="status" data-pult-adopt-warning="">Ядро ушло вперёд на 3 ячейки после снимка — результат в тетради может отличаться\.<\/p>/)
  assert.ok(html.indexOf('data-pult-onscreen') < html.indexOf('data-pult-adopt-warning'), 'under the line, not in it')
  // No warning, or the line about another attempt: nothing.
  assert.doesNotMatch(render(OnScreen, { props: { shown, now: AT, disabled: false, onclear: noop, adopted: { participantId: 'anya', run: true, at: AT } } }).body, /data-pult-adopt-warning/)
  assert.doesNotMatch(render(OnScreen, { props: { shown, now: AT, disabled: false, onclear: noop, adopted: { participantId: 'petya', run: true, at: AT, warning } } }).body, /data-pult-adopt-warning/)
})

/* ------------------------------------------------------------ the form */

function form(placement: ClassPlacement): string {
  return render(Resources, {
    props: {
      part: 'placement', resources: null, loading: false, environment: 'base', memoryMb: null, cpus: null,
      onmemory: noop, oncpus: noop, placement, placementEditable: true, placementBusy: false, onplacement: noop, outlook: null, owner: true,
    },
  }).body
}

test('Z4 · the form\'s «Консилиум» part with the pool: its two places, its two numbers while it is on machines, the preset named for it', () => {
  assert.equal(COUNCIL_POOL, true)
  const on = text(form({ ...CLASS_PLACEMENT_DEFAULT, own: 'machines', council: 'machines', workers: 'auto', attemptMb: 1024 }))
  assert.match(on, /Консилиум и личные тетради — на машинах/)
  assert.match(on, /Консилиум Попытки считаются параллельно на снимке тетради, а не по очереди в её ядре\. В общем ядре На машинах/)
  assert.match(on, /Попыток одновременно авто своё число От 2 до 16 исполнителей — сколько поместится\. Лишние попытки ждут\./)
  assert.match(on, /Память на попытку/)
  // In the shared kernel the numbers mean nothing: none drawn.
  const shared = text(form({ ...CLASS_PLACEMENT_DEFAULT, council: 'shared' }))
  assert.match(shared, /Консилиум .* В общем ядре На машинах/)
  assert.doesNotMatch(shared, /Попыток одновременно|Память на попытку/)
  setLocaleResolver(() => 'en')
  assert.match(text(form({ ...CLASS_PLACEMENT_DEFAULT, own: 'machines', council: 'machines' })), /Council and personal notebooks on machines/)
})
