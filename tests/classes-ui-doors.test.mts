/**
 * The panel's doors for classes on machines (docs/architecture/remote-classes.md
 * §15 «Staff doors», Paper 18): «Принимает занятия» on a machine and on a
 * code, «Вернуть» and «Перенести занятия», the owner's «Занятия на машинах»,
 * the class form's live line, and what the machines list, a machine's page
 * and «Работают сейчас» say of the classes (routes/admin-runners.ts,
 * admin-resources.ts, admin-instance.ts, admin-running.ts, remote/views.ts).
 *
 * What these guard: the hidden test never goes beside classes (D3) — the
 * trust is refused in words before anything of the patch is written; the
 * owner's switches refuse a teacher at the door, not only in the panel; a
 * machine's classes move before its flag goes off; and a machine's name
 * reaches only staff of the class.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE, type AdminSeminar, type RunningKernels } from '../shared/admin.js'
import type {
  ClassMachineSettingsResponse,
  ClassPlacementOutlook,
  MintRemoteCodeResponse,
  RemoteMachineDetail,
  RemoteMachinesResponse,
  RunningClassMachines,
} from '../shared/remote-admin.js'
import type { RemoteKernelsRequest } from '../shared/remote-kernels.js'
import { translate } from '../shared/i18n.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { listAdminEvents } from '../server/src/admin/audit-log.js'
import { useDockerForRevisions } from '../server/src/dependencies/revisions.js'
import { loadClassPort, noteSync } from '../server/src/competitions/remote/heard.js'
import { getRunner, remoteEvent, runnerEventsOf, updateRunner } from '../server/src/competitions/remote/store.js'
import { classBanners, machineClasses, type ClassSight } from '../server/src/competitions/remote/views.js'
import { placementRow, writePlacement } from '../server/src/kernel/remote/placement-store.js'
import { noteKernelsReport } from '../server/src/kernel/remote/placement.js'
import { useMachineTunnels } from '../server/src/kernel/remote/tunnel.js'
import { Machine, close, reset, serve, syncRequest } from './_remote.mts'

/* This process has no Docker, and never the developer's: a class's image is looked up and not found. */
useDockerForRevisions(async () => {
  throw new Error('there is no docker daemon in these tests')
})

before(async () => {
  // As the machines' clock loads them at boot (liveness.ts · startRemoteRunners): turning classes off moves them first.
  await loadClassPort()
})

after(() => close())

function staff(role: 'owner' | 'teacher', name = role === 'owner' ? 'Владелица классов' : 'Преподаватель классов'): { cookie: string; id: string; name: string } {
  const made = createTeacher({ name, email: `${role}.${Date.now()}.${Math.random()}@example.edu`, role })!
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return { cookie: `${STAFF_COOKIE}=${value}`, id: made.id, name }
}

const owner = staff('owner')
const teacher = staff('teacher')

async function call<T>(method: string, path: string, options: { body?: unknown; cookie?: string } = {}): Promise<{ status: number; body: T }> {
  const home = await serve()
  const answer = await fetch(`${home}${path}`, {
    method,
    headers: { cookie: options.cookie ?? owner.cookie, ...(options.body !== undefined && method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
    body: options.body === undefined || method === 'GET' ? undefined : JSON.stringify(options.body),
  })
  const text = await answer.text()
  return { status: answer.status, body: (text ? JSON.parse(text) : null) as T }
}

/** A machine joined with a code the owner minted in the panel, with classes or trusted as asked. */
async function machine(options: { classes?: boolean; trusted?: boolean } = {}): Promise<Machine> {
  const minted = await call<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', {
    body: { machines: 1, hours: 1, trusted: options.trusted ?? false, approvedSlots: null, classes: options.classes ?? false },
  })
  assert.equal(minted.status, 200, JSON.stringify(minted.body))
  const m = new Machine(await serve())
  assert.equal((await m.join(minted.body.code)).status, 200)
  return m
}

/** A class made in the panel, as the owner makes one. */
async function makeClass(name = `Класс ${Math.random().toString(36).slice(2, 7)}`): Promise<string> {
  const made = await call<AdminSeminar>('POST', '/api/admin/seminars', { body: { name } })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  return made.body.id
}

/** A slot of a class placed on a machine, as the placements write one (placement-store.ts). */
function place(sessionId: string, runnerId: string, role: 'room' | 'own' | 'council', state: 'ready' | 'unreachable' = 'ready') {
  return writePlacement({
    sessionId, role, runnerId, state, environment: 'base',
    revision: { id: 'rev1', ref: 'ghcr.io/colloq-edu/colloq-kernel:base@sha256:' + 'a'.repeat(64), layers: 'l'.repeat(64) },
    memoryMb: 4096, cpus: 2, gpu: null, workers: role === 'council' ? 4 : null, container: 'c'.repeat(64),
    readyAt: Date.now(), endedAt: null, reason: null, createdAt: Date.now(),
  })
}

/* ------------------------------------------------------------- the doors */

test('the class doors that change something are the owner\'s: a teacher is refused at the door, and reads the settings', async () => {
  reset()
  const m = await machine({ classes: true })
  for (const [method, path, body] of [
    ['PATCH', `/api/admin/runners/${m.runnerId}`, { classes: false }],
    ['POST', `/api/admin/runners/${m.runnerId}/classes/resume`, {}],
    ['POST', `/api/admin/runners/${m.runnerId}/classes/move`, {}],
    ['POST', '/api/admin/runners/codes', { machines: 1, hours: 1, trusted: false, approvedSlots: null, classes: true }],
    ['PUT', '/api/admin/resources/classes', { teachers: false }],
  ] as const) {
    assert.equal((await call(method, path, { cookie: teacher.cookie, body })).status, 403, `${method} ${path}`)
  }
  assert.equal(getRunner(m.runnerId)?.classes, true, 'nothing a teacher sent changed the machine')
  const read = await call<ClassMachineSettingsResponse>('GET', '/api/admin/resources/classes', { cookie: teacher.cookie })
  assert.equal(read.status, 200)
  assert.equal(read.body.settings.teachers, true, 'a teacher\'s class form reads the switch')
})

test('the class settings say which backend runs the kernels: under the broker no class form draws «Где считается» (D26)', async () => {
  assert.equal((await call<ClassMachineSettingsResponse>('GET', '/api/admin/resources/classes', { cookie: teacher.cookie })).body.backend, 'test')
  process.env.KERNEL_BACKEND = 'broker'
  try {
    assert.equal((await call<ClassMachineSettingsResponse>('GET', '/api/admin/resources/classes', { cookie: teacher.cookie })).body.backend, 'broker')
  } finally {
    process.env.KERNEL_BACKEND = 'test'
  }
})

test('trusting a machine that takes classes is refused in words, before anything of the patch is written (D3)', async () => {
  reset()
  const m = await machine({ classes: true })
  const before = getRunner(m.runnerId)!
  const refused = await call<{ error: string }>('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { name: 'renamed-before-trust', approvedSlots: 3, trusted: true } })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, translate('ru', 'admin.runners.classes.trustRefused'))
  const after = getRunner(m.runnerId)!
  assert.deepEqual(
    [after.name, after.approvedSlots, after.trusted, after.classes],
    [before.name, before.approvedSlots, false, true],
    'a refused trust left no half of the patch behind',
  )
  assert.equal(runnerEventsOf(m.runnerId, ['renamed', 'trusted'] as never, 0).length, 0)
  assert.equal(listAdminEvents({ limit: 50 }).events.some((event) => event.action === 'runner.trusted' && event.target.id === m.runnerId), false)
  // Even with classes turned off in the same patch: off first, then trust, in two presses.
  assert.equal((await call('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { classes: false, trusted: true } })).status, 409)
  assert.equal(getRunner(m.runnerId)?.classes, true)
})

test('a trusted machine is not opened to classes, unless the same patch takes its trust away first', async () => {
  reset()
  const m = await machine({ trusted: true })
  const refused = await call<{ error: string }>('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { classes: true } })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, translate('ru', 'admin.runners.classes.trustedRefused'))
  assert.equal(getRunner(m.runnerId)?.classes, false)
  const both = await call<RemoteMachineDetail>('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { trusted: false, classes: true } })
  assert.equal(both.status, 200)
  assert.deepEqual([getRunner(m.runnerId)?.trusted, getRunner(m.runnerId)?.classes], [false, true])
  assert.equal(both.body.classes?.on, true, 'the page answered with its classes')
  assert.equal((await call('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { classes: 'yes' } })).status, 400)
})

test('a code for classes carries the flag to its machines and tells runner up to check; with the hidden test it is refused', async () => {
  reset()
  const minted = await call<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 2, hours: 1, trusted: false, approvedSlots: null, classes: true } })
  assert.equal(minted.status, 200)
  assert.equal(minted.body.classes, true)
  assert.match(minted.body.commands.bare, / --classes$/)
  assert.match(minted.body.commands.docker, /--network host/)
  const list = await call<RemoteMachinesResponse>('GET', '/api/admin/runners')
  assert.equal(list.body.codes.find((code) => code.id === minted.body.id)?.classes, true)
  const m = new Machine(await serve())
  assert.equal((await m.join(minted.body.code)).status, 200)
  assert.equal(getRunner(m.runnerId)?.classes, true)
  const both = await call<{ error: string }>('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: true, approvedSlots: null, classes: true } })
  assert.equal(both.status, 400)
  assert.equal(both.body.error, translate('ru', 'admin.runners.connect.classesSealed'))
  assert.equal((await call('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: false, approvedSlots: null, classes: 1 } })).status, 400)
  // The audit says how wide the door was opened.
  const audit = listAdminEvents({ limit: 50 }).events.find((event) => event.action === 'runner.code_minted' && event.target.id === minted.body.id)
  assert.equal((audit?.detail as { classes?: boolean } | null)?.classes, true)
})

test('turning classes off moves the machine\'s classes first, says so in its log, and starts the wind-down', async () => {
  reset()
  const m = await machine({ classes: true })
  const sessionId = await makeClass()
  place(sessionId, m.runnerId, 'own')
  const off = await call<RemoteMachineDetail>('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { classes: false } })
  assert.equal(off.status, 200)
  assert.equal(placementRow(sessionId, 'own')?.state, 'lost', 'the class moved before the flag went off')
  const runner = getRunner(m.runnerId)!
  assert.deepEqual([runner.classes, runner.classesWindingDown], [false, true])
  assert.equal(runnerEventsOf(m.runnerId, ['unclassed'], 0).at(-1)?.detail, 'moved 1')
  assert.equal(off.body.classes?.block?.reason, 'winding', '«убирает занятия» while the machine still may hold them')
  // On again: the wind-down ends with it.
  assert.equal((await call('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { classes: true } })).status, 200)
  assert.deepEqual([getRunner(m.runnerId)?.classes, getRunner(m.runnerId)?.classesWindingDown], [true, false])
  // Both are the owner's audit: who opened the machine to the classes, and who took them off it (§12).
  const audited = listAdminEvents({ limit: 50 }).events.filter((event) => event.action === 'runner.classes' && event.target?.id === m.runnerId)
  assert.deepEqual(audited.map((event) => [event.actor?.name, (event.detail as { classes?: boolean } | null)?.classes]), [[owner.name, true], [owner.name, false]])
})

test('«Вернуть» lifts the class quarantine, writes it in the log, and its banner goes from the list', async () => {
  reset()
  const m = await machine({ classes: true })
  updateRunner(m.runnerId, { classesQuarantinedAt: Date.now() - 60_000 })
  const listed = await call<RemoteMachinesResponse>('GET', '/api/admin/runners')
  assert.ok(listed.body.classBanners?.some((banner) => banner.kind === 'quarantined' && banner.machineId === m.runnerId))
  assert.equal(listed.body.machines.find((one) => one.id === m.runnerId)?.classes?.block?.reason, 'quarantined')
  const resumed = await call<RemoteMachineDetail>('POST', `/api/admin/runners/${m.runnerId}/classes/resume`)
  assert.equal(resumed.status, 200)
  const runner = getRunner(m.runnerId)!
  assert.equal(runner.classesQuarantinedAt, null)
  assert.ok(runner.classesResumedAt !== null)
  assert.equal(runnerEventsOf(m.runnerId, ['classes_resumed'], 0).length, 1)
  const again = await call<RemoteMachinesResponse>('GET', '/api/admin/runners')
  assert.equal(again.body.classBanners?.some((banner) => banner.kind === 'quarantined' && banner.machineId === m.runnerId) ?? false, false)
  // Nothing to lift: no second line, in the machine's log or the owner's audit.
  await call('POST', `/api/admin/runners/${m.runnerId}/classes/resume`)
  assert.equal(runnerEventsOf(m.runnerId, ['classes_resumed'], 0).length, 1)
  assert.equal(listAdminEvents({ limit: 50 }).events.filter((event) => event.action === 'runner.classes_resumed' && event.target?.id === m.runnerId).length, 1)
})

test('«Перенести занятия» moves every class slot off the machine now, by the owner\'s hand; nothing to move is refused in words', async () => {
  reset()
  const m = await machine({ classes: true })
  const empty = await call<{ error: string }>('POST', `/api/admin/runners/${m.runnerId}/classes/move`)
  assert.equal(empty.status, 409)
  assert.equal(empty.body.error, translate('ru', 'admin.runners.classes.nothingToMove'))
  const sessionId = await makeClass()
  place(sessionId, m.runnerId, 'room')
  place(sessionId, m.runnerId, 'own')
  const moved = await call<RemoteMachineDetail>('POST', `/api/admin/runners/${m.runnerId}/classes/move`)
  assert.equal(moved.status, 200)
  assert.deepEqual([placementRow(sessionId, 'room')?.state, placementRow(sessionId, 'own')?.state], ['lost', 'lost'])
  assert.equal(placementRow(sessionId, 'room')?.reason, 'moved')
  assert.equal(runnerEventsOf(m.runnerId, ['class_failover'], 0).at(-1)?.detail, `moved: ${owner.name}`)
  assert.equal(getRunner(m.runnerId)?.classes, true, 'it keeps taking classes')
  const audited = listAdminEvents({ limit: 50 }).events.filter((event) => event.action === 'runner.classes_moved' && event.target?.id === m.runnerId)
  assert.deepEqual(audited.map((event) => [event.actor?.name, (event.detail as { slots?: number } | null)?.slots]), [[owner.name, 2]], 'the move with nothing to move is no event')
})

test('the owner\'s «Занятия на машинах»: read by staff, changed by the owner as one patch, recorded, a bad field refused', async () => {
  const read = await call<ClassMachineSettingsResponse>('GET', '/api/admin/resources/classes')
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.defaults, { teachers: true, newClasses: 'home', failoverSec: 60, machineFileMb: 200, classBulkMBps: 4, competitionMBps: 2 })
  const saved = await call<ClassMachineSettingsResponse>('PUT', '/api/admin/resources/classes', { body: { teachers: false, newClasses: 'personal', failoverSec: 90 } })
  assert.equal(saved.status, 200)
  assert.deepEqual([saved.body.settings.teachers, saved.body.settings.newClasses, saved.body.settings.failoverSec], [false, 'personal', 90])
  const audit = listAdminEvents({ limit: 50 }).events.find((event) => event.action === 'settings.resources_changed' && event.target.id === 'classes')
  assert.deepEqual((audit?.detail as { changed?: string[] } | null)?.changed, ['classes.teachers', 'classes.newClasses', 'classes.failoverSec'])
  assert.equal((await call('PUT', '/api/admin/resources/classes', { body: { failoverSec: 'soon' } })).status, 400)
  assert.equal((await call('PUT', '/api/admin/resources/classes', { body: { nonsense: 1 } })).status, 400)
  const back = await call<ClassMachineSettingsResponse>('PUT', '/api/admin/resources/classes', { body: { teachers: null, newClasses: null, failoverSec: null } })
  assert.deepEqual(back.body.settings, back.body.defaults)
})

test('the class form\'s live line answers the class\'s staff, and a teacher of another class learns nothing', async () => {
  const sessionId = await makeClass()
  const outlook = await call<ClassPlacementOutlook>('GET', `/api/admin/seminars/${sessionId}/placement`)
  assert.equal(outlook.status, 200)
  assert.ok(Array.isArray(outlook.body.machines))
  assert.equal(typeof outlook.body.environment, 'string')
  assert.ok(Math.abs(outlook.body.at - Date.now()) < 60_000)
  // With no image of its environment to be found (no daemon here), the class can run nowhere but here.
  assert.equal(outlook.body.refusal, 'not-portable')
  assert.equal((await call('GET', `/api/admin/seminars/${sessionId}/placement`, { cookie: teacher.cookie })).status, 404)
})

test('the live line also says whether the class moves by itself and whether this viewer may change it: what the room\'s banner offers by', async () => {
  const sessionId = await makeClass()
  const first = await call<ClassPlacementOutlook>('GET', `/api/admin/seminars/${sessionId}/placement`)
  assert.deepEqual([first.body.failover, first.body.editable], ['auto', true])
  assert.equal((await call('PATCH', `/api/admin/seminars/${sessionId}`, { body: { placement: { failover: 'wait' } } })).status, 200)
  const waits = await call<ClassPlacementOutlook>('GET', `/api/admin/seminars/${sessionId}/placement`)
  assert.equal(waits.body.failover, 'wait')
  // A teacher of the class while the owner's switch keeps teachers out: reads it, may not change it.
  const own = staff('teacher', 'Ведущая класса')
  assert.equal((await call('POST', `/api/admin/seminars/${sessionId}/teachers`, { body: { staffId: own.id } })).status < 300, true)
  await call('PUT', '/api/admin/resources/classes', { body: { teachers: false } })
  try {
    const kept = await call<ClassPlacementOutlook>('GET', `/api/admin/seminars/${sessionId}/placement`, { cookie: own.cookie })
    assert.equal(kept.status, 200)
    assert.deepEqual([kept.body.failover, kept.body.editable], ['wait', false])
  } finally {
    await call('PUT', '/api/admin/resources/classes', { body: { teachers: null } })
  }
})

/* ------------------------------------------------------------- the views */

/** The classes' sight of a test: a tunnel up or not, its round trip, a takeover alert, the images a machine is asked for. */
function sight(fields: { up?: boolean; alert?: boolean; wanted?: string[]; failoverAt?: number | null } = {}): ClassSight {
  return {
    tunnels: {
      isUp: () => fields.up ?? true,
      since: () => Date.now() - 60_000,
      rtt: () => ({ ewmaMs: 48, p95Ms: 80 }),
      tunnelReplacementAlert: () => fields.alert ?? false,
    },
    failoverAt: () => fields.failoverAt ?? null,
    revisionsWanted: () => (fields.wanted ?? []).map((id) => ({ id })),
  }
}

/** A sync with a kernels block, as the machine's agent sends one, noted the way the sync door notes it. */
function synced(m: Machine, classes: Partial<RemoteKernelsRequest['classes']> = {}, held: RemoteKernelsRequest['placements'] = []): void {
  noteSync(m.runnerId, syncRequest({
    kernels: {
      placements: held, reports: [], epochs: [], readings: [], tunnel: 'up',
      classes: { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false, ...classes },
    },
  }), Date.now(), m.address)
}

test('a machine\'s classes in the list: the one thing that keeps a new class away, in the owner\'s order', async () => {
  reset()
  const m = await machine({ classes: true })
  const view = (over: Parameters<typeof sight>[0] = {}) => machineClasses(getRunner(m.runnerId)!, Date.now(), sight(over))
  synced(m)
  assert.equal(view()?.block, null, 'it takes classes')
  assert.equal(view({ up: false })?.block?.reason, 'tunnel')
  synced(m, { canary: 'egress open' })
  assert.deepEqual([view()?.block?.reason, view()?.block?.detail], ['canary', 'egress open'])
  // A canary still to run (kernels.ts · runCanary «pending: …») is a wait with no failure named, behind the tunnel and the image.
  synced(m, { canary: 'pending: no class image is ready here yet' })
  assert.deepEqual([view()?.block?.reason, view()?.block?.detail], ['canary', null])
  assert.equal(view({ up: false })?.block?.reason, 'tunnel')
  synced(m, { perimeter: 'no-iptables' })
  assert.deepEqual([view()?.block?.reason, view()?.block?.detail], ['perimeter', 'no-iptables'])
  synced(m, { hostNetwork: false, perimeter: 'no-iptables' })
  assert.equal(view()?.block?.reason, 'host-network')
  synced(m, { sameDaemon: true, hostNetwork: false })
  assert.equal(view()?.block?.reason, 'same-daemon')
  updateRunner(m.runnerId, { classesQuarantinedAt: Date.now() })
  assert.equal(view()?.block?.reason, 'quarantined', 'the owner\'s quarantine comes before what the machine says')
  updateRunner(m.runnerId, { classesQuarantinedAt: null })
  // A machine opened to classes that has not said what it can do yet.
  const fresh = await machine({ classes: true })
  assert.equal(machineClasses(getRunner(fresh.runnerId)!, Date.now(), sight())?.block?.reason, 'facts')
  // A machine never opened to classes has no class view at all.
  const plain = await machine()
  assert.equal(machineClasses(getRunner(plain.runnerId)!, Date.now(), sight()), undefined)
})

test('what a machine holds for classes, from its placements and its own census, and when a silent one\'s classes move', async () => {
  reset()
  const m = await machine({ classes: true })
  const one = await makeClass()
  const two = await makeClass()
  const room = place(one, m.runnerId, 'room')
  place(one, m.runnerId, 'own')
  place(two, m.runnerId, 'own')
  synced(m, {}, [{ key: `${one}:room`, gen: room.gen, phase: 'ready', usage: { usedMb: 1000, limitMb: 6144, cpus: 2, cpuPercent: 12, startedAt: Date.now(), oomKills: 0 }, card: { device: '0', usedMb: 900 } }])
  const view = machineClasses(getRunner(m.runnerId)!, Date.now(), sight())!
  assert.deepEqual(view.held, { classes: 2, slots: 3, memoryMb: 6144 + 4096 + 4096, card: '0' })
  assert.deepEqual(view.link, { up: true, since: view.link?.since ?? null, rttMs: 48, p95Ms: 80 })
  // Silent: when the first of its classes moves by itself.
  const later = Date.now() + 10 * 60_000
  const silent = machineClasses(getRunner(m.runnerId)!, later, sight({ failoverAt: later + 19_000 }))!
  assert.equal(silent.block?.reason, 'silent')
  assert.equal(silent.moveAt, later + 19_000)
  // Its tunnel down a minute, the machine heard just now and far from 0.23's three silent minutes: the classes' move is said all the same.
  const soon = Date.now() + 2_000
  const down = machineClasses(getRunner(m.runnerId)!, Date.now(), sight({ up: false, failoverAt: soon }))!
  assert.equal(down.block?.reason, 'tunnel')
  assert.equal(down.moveAt, soon)
  assert.equal(machineClasses(getRunner(m.runnerId)!, Date.now(), sight({ failoverAt: soon }))!.moveAt, null, 'nothing moves while the tunnel is up')
})

test('the block counts a class once, whatever number of machines hold its slots', async () => {
  reset()
  const one = await machine({ classes: true })
  const two = await machine({ classes: true })
  const sessionId = await makeClass()
  place(sessionId, one.runnerId, 'own')
  place(sessionId, two.runnerId, 'council')
  const list = await call<RemoteMachinesResponse>('GET', '/api/admin/runners')
  assert.deepEqual(list.body.classMachines, { machines: 2, classes: 1 })
})

test('the owner\'s class banners: a takeover with its addresses, a perimeter that failed closed', async () => {
  reset()
  const m = await machine({ classes: true })
  for (const from of ['5.6.7.8', '9.10.11.12', '5.6.7.8', '9.10.11.12']) remoteEvent(m.runnerId, 'tunnel_replaced', { address: from, detail: '185.62.10.4' })
  const banners = classBanners([getRunner(m.runnerId)!], Date.now(), sight({ alert: true }))
  assert.deepEqual(banners.find((banner) => banner.kind === 'tunnel'), { kind: 'tunnel', machineId: m.runnerId, name: getRunner(m.runnerId)!.name, count: 4, minutes: 10, addresses: ['5.6.7.8', '9.10.11.12'] })
  assert.equal(classBanners([getRunner(m.runnerId)!], Date.now(), sight({ alert: false })).some((banner) => banner.kind === 'tunnel'), false)
  remoteEvent(m.runnerId, 'perimeter_failing', { detail: 'the class perimeter failed closed' })
  assert.ok(classBanners([getRunner(m.runnerId)!], Date.now(), sight()).some((banner) => banner.kind === 'perimeter'))
  // The page words the takeover with both addresses.
  const page = await call<RemoteMachineDetail>('GET', `/api/admin/runners/${m.runnerId}`)
  const line = page.body.events.find((event) => event.kind === 'tunnel_replaced')
  assert.deepEqual([line?.address, line?.detail], ['9.10.11.12', '185.62.10.4'])
})

test('a machine\'s page lists the classes on it, a row each, with their slots there', async () => {
  reset()
  const m = await machine({ classes: true })
  const sessionId = await makeClass('Торч: тензоры')
  place(sessionId, m.runnerId, 'room')
  place(sessionId, m.runnerId, 'council')
  const page = await call<RemoteMachineDetail>('GET', `/api/admin/runners/${m.runnerId}`)
  assert.equal(page.status, 200)
  const row = page.body.classRows?.find((one) => one.sessionId === sessionId)
  assert.ok(row)
  assert.equal(row.name, 'Торч: тензоры')
  assert.deepEqual(row.roles, ['room', 'council'])
  assert.equal(row.workers, 4)
  assert.equal(row.memory.limitMb, 8192)
})

test('«Работают сейчас» says how the machine answers, and for a slot back from one until when its files were in step', async () => {
  reset()
  const m = await machine({ classes: true })
  const other = await machine({ classes: true })
  const sessionId = await makeClass()
  place(sessionId, other.runnerId, 'room')
  const own = place(sessionId, m.runnerId, 'own')
  // The machine's last report of the slot (what the files are as of), then the owner's move: the failover's own moment.
  const reported = Date.now() - 30_000
  noteKernelsReport(m.runnerId, {
    placements: [{ key: `${sessionId}:own`, gen: own.gen, phase: 'ready', container: 'c'.repeat(64), revision: 'a'.repeat(64) }], reports: [], epochs: [], readings: [], tunnel: 'up',
    classes: { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false },
  }, reported)
  assert.equal((await call('POST', `/api/admin/runners/${m.runnerId}/classes/move`)).status, 200)
  // The class still computes partly on the other machine, whose tunnel answers in 52 ms.
  const tunnels = {
    isUp: () => true, since: () => Date.now(), rtt: () => ({ ewmaMs: 52.4, p95Ms: 80 }), tunnelReplacementAlert: () => false,
    onChange: () => () => undefined, listen: async () => ({ port: 0, close() {} }), link: () => null, lost: () => undefined,
  }
  useMachineTunnels(tunnels as never)
  try {
    const seen = await call<RunningKernels>('GET', '/api/admin/resources/running')
    const row = seen.body.classes.find((one) => one.id === sessionId) as (RunningKernels['classes'][number] & RunningClassMachines) | undefined
    assert.ok(row, 'the class is listed by its slot on the other machine')
    assert.equal(row.machines?.[0]?.rttMs, 52.4)
    assert.deepEqual([row.moved?.from, row.moved?.filesAt], [getRunner(m.runnerId)?.name, reported])
  } finally {
    useMachineTunnels(null)
  }
})

test('«Работают сейчас» lists a class on a machine as its slots at 0 MB here, the machine named only to the class\'s staff', async () => {
  reset()
  const m = await machine({ classes: true })
  const sessionId = await makeClass()
  place(sessionId, m.runnerId, 'own')
  const seen = await call<RunningKernels>('GET', '/api/admin/resources/running')
  const row = seen.body.classes.find((one) => one.id === sessionId) as (RunningKernels['classes'][number] & RunningClassMachines) | undefined
  assert.ok(row, 'the class is listed')
  assert.equal(row.own, null, 'none of this server\'s memory')
  assert.equal(row.machines?.[0]?.role, 'own')
  assert.equal(row.machines?.[0]?.machine, getRunner(m.runnerId)?.name)
  assert.equal(row.machines?.[0]?.memoryMb, 4096)
  // A teacher who does not teach the class reads numbers, never the machine.
  const other = await call<RunningKernels>('GET', '/api/admin/resources/running', { cookie: teacher.cookie })
  const hidden = other.body.classes.find((one) => one.hidden && (one as RunningClassMachines).machines?.length) as RunningClassMachines | undefined
  assert.ok(hidden?.machines?.every((slot) => slot.machine === null && slot.files === null))
  // The bar counts it apart from this server's rooms.
  const resources = await call<{ budget: { rooms: { count: number }; own: { count: number }; onMachines?: { containers: number } } }>('GET', '/api/admin/resources')
  assert.ok((resources.body.budget.onMachines?.containers ?? 0) >= 1)
})

test('under the broker a seminar says nothing of where it computes, and a change of it is refused (D26)', async () => {
  const sessionId = await makeClass()
  process.env.KERNEL_BACKEND = 'broker'
  try {
    const renamed = await call<AdminSeminar & { error?: string }>('PATCH', `/api/admin/seminars/${sessionId}`, { body: { name: 'Класс под брокером' } })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
    assert.equal('placement' in renamed.body, false)
    assert.equal('placementEditable' in renamed.body, false)
    const refused = await call<{ error: string }>('PATCH', `/api/admin/seminars/${sessionId}`, { body: { placement: { room: 'machines' } } })
    assert.equal(refused.status, 400, JSON.stringify(refused.body))
  } finally {
    process.env.KERNEL_BACKEND = 'test'
  }
  const back = await call<AdminSeminar>('PATCH', `/api/admin/seminars/${sessionId}`, { body: { name: 'Класс снова здесь' } })
  assert.equal(back.body.placement?.room, 'home', 'the refused change wrote nothing')
  assert.equal(back.body.placementEditable, true)
})

test('a change of where the class computes tells its staff of its slots on machines again: «Ждать машину» in one tab is every tab\'s', async () => {
  reset()
  const { onKernelMachineChange } = await import('../server/src/kernel/index.js')
  const m = await machine({ classes: true })
  const sessionId = await makeClass()
  place(sessionId, m.runnerId, 'room')
  const told: Array<[string, string, string | null]> = []
  onKernelMachineChange((id, role, note) => {
    if (id === sessionId) told.push([id, role, note])
  })
  assert.equal((await call('PATCH', `/api/admin/seminars/${sessionId}`, { body: { placement: { failover: 'wait' } } })).status, 200)
  assert.deepEqual(told, [[sessionId, 'room', null]], 'the room slot, the one on a machine')
  // The same setting again changes nothing, and tells nothing.
  assert.equal((await call('PATCH', `/api/admin/seminars/${sessionId}`, { body: { placement: { failover: 'wait' } } })).status, 200)
  assert.equal(told.length, 1)
})

test('a memory raise the class\'s machine has no room for is said in the room\'s kernel log: the kernel gets it at its next start', async () => {
  reset()
  const m = await machine({ classes: true })
  const sessionId = await makeClass()
  place(sessionId, m.runnerId, 'room')
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { getTerminal, readTerminalLine } = await import('../shared/notebook.js')
  const { doc } = getSessionDoc(sessionId)
  const notes = (): string[] => getTerminal(doc).toArray().map(readTerminalLine).filter((line) => line.kind === 'system').map((line) => line.text)
  const word = translate('ru', 'server.theNewMemoryLimitDidNotReach.570077')
  // The machine has said nothing of what it has free: no raise is taken there (placement.ts · resize).
  assert.equal((await call('PATCH', `/api/admin/seminars/${sessionId}`, { body: { memoryMb: 8192 } })).status, 200)
  for (let poll = 0; poll < 200 && !notes().includes(word); poll++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(notes().filter((note) => note === word), [word])
  assert.equal(placementRow(sessionId, 'room')?.memoryMb, 4096, 'the placement keeps what its container has')
})
