/**
 * Classes on machines in the teacher's panel (Paper 18 · Z1–Z4, Z7): the
 * words the screens decide by — the «занятия» chip and the class line under
 * a machine's row, the owner's banners, the log's class lines, the machine
 * page's table of classes, the class form's presets, live line and refusals,
 * and «Работают сейчас»'s rows of slots on machines.
 *
 * The decisions live in web/src/admin/runners.ts and admin/running-kernels.ts
 * and are checked here directly, in both languages where a word could slip;
 * the screens are read straight from their files, as admin-runners-ui does.
 *
 * What these guard is what this half of the panel could get wrong quietly: a
 * machine's name where only staff of the class may read it, a «готова» on a
 * machine whose perimeter is not there, a move promised at a time nobody
 * set, the hidden test and classes offered together.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, translate } from '../shared/i18n.js'
import { CLASS_PLACEMENT_DEFAULT, type RunningClass } from '../shared/admin.js'
import type {
  ClassPlacementOutlook,
  RemoteClassBanner,
  RemoteMachine,
  RemoteMachineClasses,
  RemoteMachineClassRow,
  RunningMachineSlot,
} from '../shared/remote-admin.js'
import {
  classBannerText,
  classLine,
  classRowCells,
  classesChip,
  classesGauge,
  connectDefaults,
  elapsedWords,
  eventLine,
  filesLag,
  machineMenu,
  mintRequest,
  outlookLine,
  placementRefusal,
  presetOf,
  presetsFor,
  refusalLocks,
} from '../web/src/admin/runners.js'
import {
  machineStatus,
  onlyOnMachines,
  slotChip,
  slotCpu,
  slotFiles,
  slotMemory,
  slotWorkers,
  stopsLater,
  totals,
  type RunningClassRow,
} from '../web/src/admin/running-kernels.js'

afterEach(() => setLocaleResolver(() => 'ru'))

const plain = (text: string | null | undefined): string | null => (text == null ? null : text.replace(/[  ]/g, ' '))
const read = (rel: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
/** Markup without comments: an explanation is not a promise. */
const code = (source: string): string => source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const flat = (source: string): string => source.replace(/\s+/g, ' ')
const CYRILLIC = /[А-Яа-яЁё]/

const NOW = new Date(2026, 9, 20, 14, 41, 0).getTime()
const SEC = 1000
const GB = 1024

function classes(fields: Partial<RemoteMachineClasses> = {}): RemoteMachineClasses {
  return {
    on: true,
    windingDown: false,
    quarantinedAt: null,
    block: null,
    held: { classes: 3, slots: 5, memoryMb: 30 * GB, card: '0' },
    link: { up: true, since: NOW - 600 * SEC, rttMs: 48, p95Ms: 80 },
    moveAt: null,
    ...fields,
  }
}

function machine(fields: Partial<RemoteMachine> = {}): RemoteMachine {
  return {
    id: 'vast3aaa',
    name: 'vast-3',
    state: 'online',
    trusted: false,
    lastSeenAt: NOW - 2 * SEC,
    silentSince: null,
    address: '185.62.10.4',
    version: '0.25.0',
    compatible: true,
    facts: { hostname: 'C.3', platform: 'linux/amd64', cpus: 32, memoryMb: 60 * GB, diskMb: 500 * GB, docker: '28.4.0', storage: 'overlay2', driver: '580.95.05' },
    cards: [],
    places: { approved: null, offered: 4, busy: 2 },
    perDevice: null,
    readiness: [],
    counts: { scored: 38, lost: 0, declined: 0, requeued: 0 },
    lastTrouble: null,
    createdAt: NOW - 86_400_000,
    classes: classes(),
    ...fields,
  }
}

const block = (reason: NonNullable<RemoteMachineClasses['block']>['reason'], fields: Partial<NonNullable<RemoteMachineClasses['block']>> = {}) =>
  ({ reason, detail: null, percent: null, environment: null, ...fields })

/* ------------------------------------------------------------ Z1 · the row */

test('a machine never opened to classes has no «занятия» chip and no class line; a gone one neither', () => {
  assert.equal(classesChip(machine({ classes: undefined })), null)
  assert.equal(classLine(machine({ classes: undefined }), NOW), null)
  assert.equal(classesChip(machine({ state: 'revoked' })), null)
  assert.equal(classLine(machine({ state: 'left' }), NOW), null)
})

test('the class line of a machine that serves says what it holds and how it answers, as Z1 draws it', () => {
  assert.equal(plain(classLine(machine(), NOW)?.text), '3 класса · 30 из 60 ГБ · карта GPU 0 занята классом · связь 48 мс (p95 80)')
  assert.equal(classLine(machine(), NOW)?.tone, 'ink')
  // Ready and empty: no «0 классов», and no promise of a round trip it never measured.
  const empty = machine({ classes: classes({ held: { classes: 0, slots: 0, memoryMb: 0, card: null }, link: null }) })
  assert.equal(plain(classLine(empty, NOW)?.text), 'готова')
  assert.deepEqual(classesChip(empty), { word: 'занятия', tone: 'neutral', dashed: false })
  setLocaleResolver(() => 'en')
  assert.equal(plain(classLine(machine(), NOW)?.text), '3 classes · 30 of 60 GB · card GPU 0 held by a class · link 48 ms (p95 80)')
})

test('each thing that keeps new classes away has its words and the chip\'s tone (Z1)', () => {
  const cases: Array<[NonNullable<RemoteMachineClasses['block']>, string, string, boolean]> = [
    [block('image', { percent: 45, environment: 'base' }), 'образ ↓ 45 % — возьмёт классы, когда скачает base', 'accent', false],
    [block('host-network'), 'нужен --network host — перезапустите машину командой из панели', 'warning', false],
    [block('perimeter', { detail: 'no-iptables' }), 'периметр: у Docker нет iptables', 'danger', false],
    [block('same-daemon'), 'на этой машине стоит сервер Colloq — занятия нельзя', 'neutral', true],
    [block('canary', { detail: 'egress to 10.0.0.1 open' }), 'проверка допуска не прошла: egress to 10.0.0.1 open', 'danger', false],
  ]
  for (const [blocked, words, tone, dashed] of cases) {
    const one = machine({ classes: classes({ block: blocked }) })
    assert.equal(plain(classLine(one, NOW)?.text), words, blocked.reason)
    assert.deepEqual(classesChip(one), { word: 'занятия', tone, dashed }, blocked.reason)
  }
  // A check that has not run yet is a wait, not a failure: calm, and no agent's word.
  const waits = machine({ classes: classes({ block: block('canary') }) })
  assert.deepEqual(classLine(waits, NOW), { text: 'проверка допуска пройдёт, когда на машине будет образ класса', tone: 'muted' })
  assert.deepEqual(classesChip(waits), { word: 'занятия', tone: 'neutral', dashed: false })
  // The perimeter's other states, never a raw word of the agent's.
  assert.match(classLine(machine({ classes: classes({ block: block('perimeter', { detail: 'refused' }) }) }), NOW)!.text, /nftables/)
  assert.match(classLine(machine({ classes: classes({ block: block('perimeter', { detail: 'failing' }) }) }), NOW)!.text, /вышел из-под контроля/)
})

test('a quarantined machine and a silent one with classes say when, and a silent one when its classes move', () => {
  const quarantined = machine({ classes: classes({ quarantinedAt: new Date(2026, 9, 20, 14, 38).getTime(), block: block('quarantined') }) })
  assert.equal(plain(classLine(quarantined, NOW)?.text), 'на карантине с 14:38 — дважды пропадала за 30 минут; посылки берёт как обычно. Вернуть — в меню ⋯')
  assert.equal(classLine(quarantined, NOW)?.tone, 'danger')
  const silent = machine({
    state: 'silent',
    silentSince: NOW - 41 * SEC,
    classes: classes({ held: { classes: 2, slots: 2, memoryMb: 8 * GB, card: null }, block: block('silent'), moveAt: new Date(2026, 9, 20, 14, 41, 19).getTime() }),
  })
  assert.equal(plain(classLine(silent, NOW)?.text), '2 класса · нет связи 0:41 · перенесём в 14:41:19')
  // «Ждать машину», or a rule too young to promise a time: no time is promised.
  const waiting = machine({ ...silent, classes: { ...silent.classes!, moveAt: null } })
  assert.equal(plain(classLine(waiting, NOW)?.text), '2 класса · нет связи 0:41')
  assert.equal(elapsedWords(3725 * SEC), '1:02:05')
})

test('classes whose tunnel is down say so with their move\'s time long before the machine counts as silent', () => {
  // 70 s into an outage: 0.23 calls the machine silent only at three minutes, the class moves at its own 60 s.
  const down = machine({
    classes: classes({
      held: { classes: 2, slots: 2, memoryMb: 8 * GB, card: null },
      block: block('tunnel'),
      link: { up: false, since: NOW - 70 * SEC, rttMs: 48, p95Ms: 80 },
      moveAt: new Date(2026, 9, 20, 14, 41, 19).getTime(),
    }),
  })
  assert.equal(plain(classLine(down, NOW)?.text), '2 класса · нет связи 1:10 · перенесём в 14:41:19')
  assert.equal(classLine(down, NOW)?.tone, 'warning')
  // With no class on it, the tunnel's own words: new classes wait for it.
  const empty = machine({ classes: classes({ held: { classes: 0, slots: 0, memoryMb: 0, card: null }, block: block('tunnel'), link: { up: false, since: NOW - 70 * SEC, rttMs: null, p95Ms: null } }) })
  assert.equal(plain(classLine(empty, NOW)?.text), 'туннель не поднят — занятия ждут связь')
})

test('the gauge counts machines with classes and their classes, and is absent while none takes classes', () => {
  assert.equal(classesGauge(undefined), null)
  assert.equal(classesGauge({ machines: 0, classes: 0 }), null)
  assert.deepEqual(classesGauge({ machines: 3, classes: 6 }), { value: 3, label: 'ведут занятия · 6 классов' })
})

test('the menu offers classes on a live machine, greys the hidden test against them and them against it (D3)', () => {
  const serving = machineMenu(machine())
  assert.equal(serving.classes, true)
  assert.equal(serving.moveClasses, true, 'it holds slots: they can move')
  assert.deepEqual(serving.locked, { item: 'trust', why: 'нельзя вместе с занятиями' })
  const trusted = machineMenu(machine({ trusted: true, classes: undefined }))
  assert.deepEqual(trusted.locked, { item: 'classes', why: 'нельзя вместе с доверием' })
  assert.equal(trusted.moveClasses, false)
  assert.equal(machineMenu(machine({ classes: classes({ quarantinedAt: NOW - 60_000 }) })).resumeClasses, true)
  assert.equal(machineMenu(machine({ classes: classes({ held: { classes: 0, slots: 0, memoryMb: 0, card: null } }) })).moveClasses, false)
  const gone = machineMenu(machine({ state: 'revoked' }))
  assert.deepEqual([gone.classes, gone.moveClasses, gone.resumeClasses, gone.locked], [false, false, false, null])
})

test('the owner\'s banners say what §13.2 says, the takeover\'s addresses named', () => {
  const banners: RemoteClassBanner[] = [
    { kind: 'quarantined', machineId: 'lab7aaaa', name: 'lab-7', at: NOW },
    { kind: 'tunnel', machineId: 'vast3aaa', name: 'vast-3', count: 4, minutes: 10, addresses: ['5.6.7.8', '9.10.11.12'] },
    { kind: 'perimeter', machineId: 'lab5aaaa', name: 'lab-5', at: NOW },
  ]
  assert.deepEqual(banners.map(classBannerText), [
    'Машина «lab-7» дважды пропадала за 30 минут — занятия на неё больше не отправляются.',
    'Связь машины «vast-3» за 10 минут 4 раза перехватывали с разных адресов: 5.6.7.8, 9.10.11.12. Проверьте, не утёк ли её ключ.',
    'Сеть на машине «lab-5» вышла из-под контроля: ядро остановлено ради безопасности и поднимется заново.',
  ])
  setLocaleResolver(() => 'en')
  for (const banner of banners) assert.doesNotMatch(classBannerText(banner), CYRILLIC)
})

test('the log words every class line, never the server\'s measured English', () => {
  const event = (kind: string, detail: string | null, address: string | null = null) =>
    eventLine({ kind: kind as never, attemptId: null, entrantName: null, number: null, competition: null, detail, address })
  assert.deepEqual(event('tunnel_replaced', '185.62.10.4', '5.6.7.8'), {
    text: 'Связь перехвачена с адреса 5.6.7.8 — прежний туннель с 185.62.10.4 закрыт',
    tone: 'warning',
    detail: null,
  })
  // A machine replacing its own tunnel from the same address is its own doing.
  assert.equal(event('tunnel_replaced', '5.6.7.8', '5.6.7.8').tone, 'muted')
  assert.equal(event('class_failover', 'silence').text, 'Занятия перенесены с машины: не отвечала')
  assert.equal(event('class_failover', 'moved: Ада').text, 'Занятия перенесены с машины вручную: Ада')
  assert.equal(event('unclassed', 'moved 2').text, 'Занятия выключены: перенесено 2 ядра')
  assert.equal(event('classes_quarantined', '2 failovers within 30 min').text, 'Дважды пропадала за 30 минут — занятия на неё не отправляются')
  assert.equal(event('classes_resumed', null).text, 'Владелец вернул машину занятиям')
  for (const kind of ['class_failover', 'classes_quarantined', 'unclassed', 'perimeter_failing']) {
    assert.equal(event(kind, 'the class perimeter failed closed').detail, null, `${kind} shows no raw detail`)
  }
})

/* ----------------------------------------------------------- Z2 · connect */

test('the connect dialog starts without classes, sends them only when asked, and never with the hidden test', () => {
  assert.equal(connectDefaults().classes, false)
  assert.deepEqual(mintRequest({ ...connectDefaults(), classes: true }), { request: { machines: 1, hours: 24, trusted: false, approvedSlots: null, classes: true } })
  assert.deepEqual(mintRequest({ ...connectDefaults(), classes: true, trusted: true }), {
    error: 'Нельзя вместе с занятиями: машине с классами скрытый тест не дают',
  })
})

/* ---------------------------------------------------- Z3 · the machine page */

test('a class on a machine reads its kernels, memory, CPU and files as Z3\'s table does', () => {
  const row: RemoteMachineClassRow = {
    sessionId: 'torch001', name: 'Торч', course: null, environment: 'base-gpu',
    roles: ['room', 'own', 'council'], workers: 3, card: '0',
    memory: { limitMb: 12 * GB, usedMb: 7.1 * GB }, cpuPercent: 120.4,
    files: { pushSeq: 4, pending: 3, pendingBytes: 12 * 1024 ** 2, heldOnly: 0, heldOnlyBytes: 0 },
    waiting: false,
  }
  const cells = classRowCells(row)
  assert.equal(cells.kernels, 'класс · личные · консилиум')
  assert.equal(plain(cells.kernelsDetail), '3 исполнителя · карта GPU 0 у класса')
  assert.equal(plain(cells.memory), '7,1 из 12 ГБ')
  assert.ok(cells.share !== null && Math.abs(cells.share - 7.1 / 12) < 1e-9)
  assert.equal(plain(cells.cpu), '120 %')
  assert.deepEqual(cells.files && { ...cells.files, text: plain(cells.files.text) }, { text: '↑ 3 файла, 12 МБ', tone: 'accent' })
  assert.deepEqual(filesLag({ pending: 0, pendingBytes: 0, heldOnly: 2, heldOnlyBytes: 2 * 1024 ** 3 }), { text: '2 файла только на машине', tone: 'warning' })
  assert.deepEqual(filesLag({ pending: 0, pendingBytes: 0, heldOnly: 0, heldOnlyBytes: 0 }), { text: 'синхронно', tone: 'positive' })
  assert.equal(filesLag(null), null)
  // A slot waiting for the machine says so; unknown use reads as the limit alone.
  const waiting = classRowCells({ ...row, roles: ['own'], workers: null, card: null, waiting: true, memory: { limitMb: 4 * GB, usedMb: null }, cpuPercent: null })
  assert.equal(waiting.kernelsDetail, 'ждёт машину')
  assert.equal(plain(waiting.memory), '4 ГБ')
  assert.equal(waiting.share, null)
  assert.equal(waiting.cpu, null)
})

/* ------------------------------------------------------- Z4 · the class form */

test('the form lights the tile a setting matches, the card\'s tile for a GPU class, and none for a mix', () => {
  assert.equal(presetOf(CLASS_PLACEMENT_DEFAULT, false), 'home')
  assert.equal(presetOf({ room: 'home', own: 'machines', council: 'machines' }, false), 'personal')
  assert.equal(presetOf({ room: 'machines', own: 'machines', council: 'machines' }, false), 'machines')
  assert.equal(presetOf({ room: 'machines', own: 'machines', council: 'machines' }, true), 'gpu')
  assert.equal(presetOf({ room: 'machines', own: 'home', council: 'shared' }, false), null)
  assert.deepEqual(presetsFor(false), ['home', 'personal', 'machines'])
  assert.deepEqual(presetsFor(true), ['home', 'personal', 'gpu'])
})

test('the live line names the machines that fit, far when the nearest is, and each one\'s reason when none fits', () => {
  const outlook = (machines: ClassPlacementOutlook['machines'], refusal: ClassPlacementOutlook['refusal'] = null): ClassPlacementOutlook =>
    ({ refusal, environment: 'base', machines, at: NOW })
  const fits = outlookLine(outlook([
    { name: 'vast-3', refusal: null, freeMb: 22 * GB, cards: 1, rttP95Ms: 80, far: false },
    { name: 'lab-2', refusal: null, freeMb: 18 * GB, cards: 0, rttP95Ms: 14, far: false },
    { name: 'lab-5', refusal: 'perimeter', freeMb: 40 * GB, cards: 0, rttP95Ms: 10, far: false },
  ]))
  assert.equal(plain(fits?.text), 'Подходят: vast-3 (свободно 22 ГБ · 1 карта), lab-2 (18 ГБ)')
  assert.equal(fits?.far, null)
  assert.equal(fits?.tone, 'positive')
  const far = outlookLine(outlook([{ name: 'vast-epyc-128', refusal: null, freeMb: 200 * GB, cards: 0, rttP95Ms: 190, far: true }]))
  assert.equal(plain(far?.text), 'Подходит: vast-epyc-128 (свободно 200 ГБ)')
  assert.equal(plain(far?.far), '· далеко: +190 мс на ячейку')
  const none = outlookLine(outlook([
    { name: 'vast-3', refusal: 'memory', freeMb: 2 * GB, cards: 0, rttP95Ms: 80, far: false },
    { name: 'lab-2', refusal: 'outdated', freeMb: null, cards: 0, rttP95Ms: null, far: false },
  ]))
  assert.equal(plain(none?.text), 'Сейчас не подходит ни одна: vast-3 — мало памяти, lab-2 — устарела')
  assert.equal(none?.tone, 'warning')
  // The class's own refusal takes the line's place; no machine at all, no line.
  assert.equal(outlookLine(outlook([], 'not-portable')), null)
  assert.equal(outlookLine(outlook([])), null)
})

test('the refusals: the class\'s own, and a GPU class with no card here whose class notebooks stay here', () => {
  const ctx = { gpu: false, homeCards: 0, room: 'home' as const }
  assert.equal(placementRefusal({ refusal: 'not-portable' }, ctx), 'not-portable')
  assert.equal(placementRefusal({ refusal: 'no-machines' }, ctx), 'no-machines')
  assert.equal(placementRefusal({ refusal: null }, { ...ctx, gpu: true }), 'gpu')
  assert.equal(placementRefusal({ refusal: null }, { ...ctx, gpu: true, room: 'machines' }), null, 'on a machine with a card already')
  assert.equal(placementRefusal({ refusal: null }, { ...ctx, gpu: true, homeCards: 1 }), null, 'this server has a card')
  assert.equal(placementRefusal(null, ctx), null)
  // A refusal of the class greys «На машинах»; the GPU one only advises a tile.
  assert.equal(refusalLocks('not-portable'), true)
  assert.equal(refusalLocks('no-machines'), true)
  assert.equal(refusalLocks('gpu'), false)
})

/* ----------------------------------------------- Z7 · «Работают сейчас» */

function slot(fields: Partial<RunningMachineSlot> = {}): RunningMachineSlot {
  return {
    role: 'room', machine: 'vast-3', state: 'running', link: 'ok', lostSince: null,
    memoryMb: 4 * GB, usedMb: 3.1 * GB, cpus: 2, cpuPercent: 12, card: null,
    files: { pushSeq: 1, pending: 0, pendingBytes: 0, heldOnly: 0, heldOnlyBytes: 0 }, workers: null, rttMs: 52.4,
    ...fields,
  }
}

function row(fields: Partial<RunningClassRow> = {}): RunningClassRow {
  const base: RunningClass = {
    id: 'torch001', hidden: false, name: 'Торч', course: null, environment: 'base-gpu', gpu: null,
    online: 15, liveSince: new Date(NOW - 30 * 60_000).toISOString(), busy: null, idleSince: null, stopsAt: null,
    room: null, own: null, books: [], canStop: true, idle: false,
  }
  return { ...base, machines: [slot(), slot({ role: 'own' }), slot({ role: 'council', workers: 3 })], ...fields }
}

test('a class all on a machine holds 0 MB here, and its slots read the machine\'s numbers (Z7)', () => {
  const all = row()
  assert.equal(onlyOnMachines(all), true)
  assert.equal(onlyOnMachines(row({ room: { role: 'room', state: 'running', reservedMb: 4096, usedMb: 100, cpus: 2, cpuPercent: 1, startedAt: null } })), false)
  const status = machineStatus(all, NOW)
  assert.equal(plain(status?.first), 'всё на vast-3 · в комнате 15 человек')
  assert.equal(status?.tone, 'accent')
  // How the machine answers, as the room's chip says it (Z7 «в комнате 15 человек · связь 52 мс»).
  assert.match(plain(status?.second) ?? '', / · связь 52 мс$/)
  assert.equal(slotChip(slot()), 'на vast-3')
  assert.equal(slotChip(slot({ machine: null })), 'на машине', 'another class\'s slot is not named')
  assert.equal(plain(slotMemory(slot()).text), '3,1 из 4 ГБ')
  assert.equal(plain(slotCpu(slot())), '12 % ЦП')
  assert.deepEqual(slotFiles(slot()), { text: 'файлы: синхронно', tone: 'positive' })
  assert.deepEqual(slotFiles(slot({ files: { pushSeq: 1, pending: 3, pendingBytes: 12 * 1024 ** 2, heldOnly: 0, heldOnlyBytes: 0 } }))?.tone, 'accent')
  assert.equal(slotFiles(slot({ files: null })), null)
  assert.equal(stopsLater(all), false)
})

test('a class whose machine does not answer says since when and when it moves; its stop waits for the machine', () => {
  const lost = row({
    machines: [slot({ link: 'lost', lostSince: NOW - 41 * SEC })],
    moveAt: new Date(2026, 9, 20, 14, 41, 19).getTime(),
  })
  const status = machineStatus(lost, NOW)
  assert.equal(status?.first, 'нет связи с vast-3 · 0:41')
  assert.equal(status?.second, 'перенесём в 14:41:19')
  assert.equal(status?.tone, 'warning')
  assert.equal(stopsLater(lost), true)
  assert.equal(machineStatus(row({ machines: [slot({ link: 'lost', lostSince: NOW - 5 * SEC })] }), NOW)?.second, 'ждём машину')
  assert.equal(machineStatus(row({ hidden: true, machines: [slot({ machine: null, link: 'lost', lostSince: NOW - 5 * SEC })] }), NOW)?.first, 'нет связи с машиной · 0:05')
  // Back from a machine: calm, with the move's time, until when its files were in step, and from where to staff of the class.
  const filesAt = new Date(2026, 9, 20, 14, 31, 58).getTime()
  const moved = machineStatus(row({ machines: [], moved: { at: new Date(2026, 9, 20, 14, 33).getTime(), from: 'vast-3', filesAt } }), NOW)
  assert.equal(moved?.first, 'на сервере · переехало в 14:33')
  assert.match(moved?.second ?? '', /^файлы — по 14:31:58 · с vast-3 · /)
  const unknown = machineStatus(row({ machines: [], moved: { at: new Date(2026, 9, 20, 14, 33).getTime(), from: 'vast-3', filesAt: null } }), NOW)
  assert.match(unknown?.second ?? '', /^с vast-3 · /, 'a move this server did not see says no files\' moment')
  assert.equal(machineStatus(row({ machines: [] }), NOW), null, 'a class computing here keeps the usual lane')
})

test('a council\'s workers are counted in both languages', () => {
  assert.equal(slotWorkers(slot({ role: 'council', workers: 3 })), '3 исп.')
  setLocaleResolver(() => 'en')
  assert.equal(slotWorkers(slot({ role: 'council', workers: 1 })), '1 worker')
  assert.equal(slotWorkers(slot({ role: 'council', workers: 3 })), '3 workers')
})

test('the header counts the slots on machines apart from what holds memory here', () => {
  const data = {
    backend: 'docker' as const, complete: true, sampledAt: new Date(NOW).toISOString(), usage: 'live' as const,
    reservedMb: 6 * GB, usedMb: 2 * GB, classes: [row()], runs: [], preparations: [],
  }
  const sum = totals(data)
  assert.equal(sum.onMachines, 3)
  assert.equal(sum.containers, 0)
})

/* ------------------------------------------------------------ the screens */

const RUNNERS = flat(code(read('web/src/admin/ui/Runners.svelte')))
const CONNECT = flat(code(read('web/src/admin/ui/ConnectMachine.svelte')))
const PAGE = flat(code(read('web/src/admin/screens/RemoteMachine.svelte')))
const TAB = flat(code(read('web/src/admin/screens/ResourcesTab.svelte')))
const RESOURCES = flat(code(read('web/src/admin/ui/Resources.svelte')))
const RUNNING = flat(code(read('web/src/admin/ui/RunningKernels.svelte')))

test('Z1: every live row carries its roles, the class line spans the row, and the class banners stand over the block', () => {
  assert.match(RUNNERS, /\{#snippet roleChips\(roles: ReturnType<typeof classesChip>\)\} <Badge word=\{tr\('admin\.runners\.chip\.submissions'\)\}/)
  assert.match(RUNNERS, /\{#if !gone\} <p class="rn-roles-row mt-1\.5 flex-wrap items-center gap-1">\{@render roleChips\(roles\)\}<\/p> \{\/if\}/)
  assert.match(RUNNERS, /\{#if classes\} <p class="rn-class min-w-0 break-words text-2xs"> <span class="font-bold text-ink">\{tr\('admin\.runners\.classes\.label'\)\}<\/span>/)
  assert.match(RUNNERS, /'\. class class class class class'/, 'the class line starts at the machine\'s column')
  // On a phone's card (Z10): the roles in the state's line, the class line before the readiness.
  assert.match(RUNNERS, /\{#if !gone\} <span class="rn-roles-card">\{@render roleChips\(roles\)\}<\/span> \{\/if\}/)
  assert.match(RUNNERS, /'places places' 'class class' 'ready ready';/)
  const css = read('web/src/admin/ui/Runners.svelte')
  assert.match(css, /\.rn-roles-card \{\s*display: contents;/)
  assert.match(css, /@container \(min-width: 780px\) \{[\s\S]*\.rn-roles-card \{\s*display: none;[\s\S]*\.rn-roles-row \{\s*display: flex;/)
  assert.match(RUNNERS, /\{#each classBanners as banner \(`\$\{banner\.kind\}:\$\{banner\.machineId\}`\)\}/)
  assert.match(RUNNERS, /\{#if banner\.kind === 'quarantined'\} <button type="button" class="btn-outline shrink-0 max-\[640px\]:min-h-11 max-\[640px\]:w-full" onclick=\{\(\) => resumeClasses\(banner\)\}>/)
  // The flag is asked both ways, and the move is asked: each sends its own door.
  assert.match(RUNNERS, /patch = \(\) => runnersApi\.update\(id, \{ classes: on \}\)/)
  assert.match(RUNNERS, /patch = \(\) => runnersApi\.classAction\(id, 'move'\)/)
  assert.match(RUNNERS, /disabled=\{menu\.locked\?\.item === 'classes'\}/)
  assert.match(RUNNERS, /disabled=\{menu\.locked\?\.item === 'trust'\}/)
})

test('Z2: the classes block greys the hidden test while it is on, with the reason at full strength, and the other way round', () => {
  assert.match(CONNECT, /<Check bind:checked=\{form\.trusted\} disabled=\{minted !== null \|\| form\.classes\} \/>/)
  assert.match(CONNECT, /\{#if form\.classes\} <p class="mt-1 text-2xs text-warning">\{tr\('admin\.runners\.connect\.classesSealed'\)\}<\/p> \{\/if\}/)
  assert.match(CONNECT, /<Check bind:checked=\{form\.classes\} disabled=\{minted !== null \|\| form\.trusted\} \/>/)
  // The label and the box grey, the reason under them never does (Paper Z2: the reason at 100 %).
  assert.match(CONNECT, /<span class=\{cn\('admin-label mb-1\.5 block', form\.classes && 'opacity-\[0\.45\]'\)\}>\{tr\('admin\.runners\.connect\.sealed'\)\}<\/span>/)
  assert.match(CONNECT, /minted === null && !form\.classes && 'cursor-pointer', form\.classes && 'opacity-\[0\.45\]', \)\} > <Check bind:checked=\{form\.trusted\}/)
  assert.match(CONNECT, /<span class=\{cn\('block text-ui font-semibold text-ink', form\.trusted && 'opacity-\[0\.45\]'\)\}>\{tr\('admin\.runners\.connect\.classes'\)\}<\/span>/)
  assert.match(CONNECT, /<span class=\{cn\('mt-1 block text-2xs', form\.trusted \? 'text-warning' : 'text-muted'\)\}>/)
  const column = CONNECT.slice(CONNECT.indexOf("{tr('admin.runners.connect.sealed')}") - 300, CONNECT.indexOf("{tr('admin.runners.connect.classesSealed')}"))
  assert.doesNotMatch(column, /<div class=\{cn\([^)]*opacity/, 'no wrapper greys the reason with the column')
})

test('Z3: the page moves classes, switches them, and lists them; the trust toggle gives way while classes are on', () => {
  assert.match(PAGE, /\{#if menu\.moveClasses\} <button type="button" class="btn-outline max-\[640px\]:flex-1" disabled=\{busy\} onclick=\{\(\) => \(dialog = 'moveClasses'\)\}>/)
  assert.match(PAGE, /aria-checked=\{machine\.classes\?\.on === true\} aria-label=\{tr\('admin\.runners\.menu\.classes'\)\} disabled=\{busy \|\| machine\.trusted\}/)
  assert.match(PAGE, /\{#if !machine\.classes\?\.on\} <div class="min-w-\[240px\] flex-1 basis-\[260px\]"> <span class="admin-label mb-1\.5 block">\{tr\('admin\.runners\.connect\.sealed'\)\}<\/span>/)
  assert.match(PAGE, /\{#each classRows as row \(row\.sessionId\)\} \{@const cells = classRowCells\(row\)\}/)
})

test('Z1: «Занятия на машинах» saves with the page, and the bar names what machines hold', () => {
  assert.match(TAB, /applyClasses\(await runnersApi\.saveClassSettings\(classPatch\)\)/)
  assert.match(TAB, /\{#if classes && !dockerOnlyIgnored\}/)
  assert.match(TAB, /\{#if onMachines > 0\}/)
  assert.match(TAB, /tr\('admin\.resourcesTab\.onMachinesDetail', \{ count: onMachines \}\)/)
})

test('Z1: «Занятия на машинах» that could not be read says so with a retry; only a server from before classes leaves it out', () => {
  assert.match(TAB, /if \(cause instanceof AdminApiError && cause\.status === 404\) return classesErrorText = \(\) => messageFor\(cause\)/)
  assert.match(TAB, /\{#if classesError && !classes && !dockerOnlyIgnored\} <Section title=\{tr\('admin\.classes\.title'\)\} description=\{tr\('admin\.classes\.note'\)\}> <p class="text-ui text-danger" role="alert">\{tr\('admin\.classes\.loadFailed'\)\} \{classesError\}<\/p> <button type="button" class="btn-outline mt-3" onclick=\{\(\) => void readClasses\(\)\}>/)
})

test('Z4: the block greys what it cannot do and saves what it can, at phone width a radio list', () => {
  assert.match(RESOURCES, /disabled=\{!placeable \|\| locked\}/, '«На машинах» greys under a refusal of the class')
  assert.match(RESOURCES, /disabled=\{!placeable \|\| \(locked && preset !== 'home'\)\}/)
  assert.match(RESOURCES, /\{#if !placementEditable\} <p class="flex items-start gap-2 text-2xs text-muted"> <Icon name="lock"/)
  // A radio list with 48 px rows below 720 px of its own width, tiles above (Z10, Z4).
  const css = read('web/src/admin/ui/Resources.svelte')
  assert.match(css, /\.pl-preset \{[^}]*min-height: 48px;/)
  assert.match(css, /\.pl-seg-btn \{[^}]*min-height: 44px;/)
  assert.match(css, /@container \(min-width: 720px\)/)
})

test('Z7: a class all on machines says 0 MB here, its slots are sub-rows, its stop says it waits for the machine', () => {
  assert.match(RUNNING, /\{#if away\}/)
  assert.match(RUNNING, /tr\('admin\.resourcesTab\.running\.machine\.zeroCores'\)/)
  assert.match(RUNNING, /\{#each slots as slot \(slot\.role\)\}/)
  assert.match(RUNNING, /title=\{later \? tr\('admin\.resourcesTab\.running\.machine\.stopLater'\) : label\}/)
  assert.match(RUNNING, /!slots\.some\(\(slot\) => slot\.role === 'own'\)/, 'the personal container is listed once, here or there')
})

test('the class screens speak no Russian of their own, not even in a comment', () => {
  // The two screens written whole in English (the room's notebook and the class form keep older Russian comments of their own).
  for (const rel of ['web/src/admin/ui/Resources.svelte', 'web/src/components/panels/FilesPanel.svelte']) {
    assert.doesNotMatch(read(rel), CYRILLIC, rel)
  }
})
