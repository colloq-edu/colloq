/**
 * What the owner and the console see of the machines (shared/remote-admin.ts,
 * Paper page 16; routes/admin-runners.ts, remote/views.ts): the list and a
 * machine's page, the code minted inside its three commands, a machine's
 * settings and the owner's actions with their audit lines, and what the
 * competition screens add — machine runs and groups in the queue, the
 * reasons a row waits, the places the forecast counts, the GPU door,
 * «Работают сейчас» and «Где считается».
 *
 * The panel is built against these types by someone else at the same time:
 * every field is checked as the type promises it.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE, type RunningKernels } from '../shared/admin.js'
import type { MintRemoteCodeResponse, RemoteMachineDetail, RemoteMachinesResponse } from '../shared/remote-admin.js'
import type { CompetitionLive, CompetitionView, QueueSnapshot } from '../shared/competitions-api.js'
import type { CompetitionSettings } from '../shared/competitions-settings.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { listAdminEvents } from '../server/src/admin/audit-log.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { createCapabilityReader } from '../server/src/competitions/capabilities.js'
import { getLease, getRunner } from '../server/src/competitions/remote/store.js'
import { loseLease } from '../server/src/competitions/remote/release.js'
import { queueForecast } from '../server/src/competitions/forecast.js'
import { queueRow } from '../server/src/competitions/store.js'
import { COLLOQ_VERSION } from '../server/src/version.js'
import { config } from '../server/src/config.js'
import { Machine, close, competition, reset, send, serve, type TestCompetition } from './_remote.mts'

useCompetitionRunner(new FakeCompetitionRunner())

after(() => close())

function staff(role: 'owner' | 'teacher'): string {
  const made = createTeacher({ name: role === 'owner' ? 'Владелица машин' : 'Преподаватель машин', email: `${role}.${Date.now()}.${Math.random()}@example.edu`, role })!
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return `${STAFF_COOKIE}=${value}`
}

const owner = staff('owner')
const teacher = staff('teacher')

async function admin<T>(method: string, path: string, options: { body?: unknown; cookie?: string } = {}): Promise<{ status: number; body: T }> {
  const home = await serve()
  const answer = await fetch(`${home}${path}`, {
    method,
    headers: { cookie: options.cookie ?? owner, ...(options.body !== undefined && method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
    body: options.body === undefined || method === 'GET' ? undefined : JSON.stringify(options.body),
  })
  return { status: answer.status, body: (await answer.json()) as T }
}

/** A machine joined with a code the owner minted in the panel, synced with the competitions' things in place. */
async function machineFor(competitions: TestCompetition[], options: { trusted?: boolean; cards?: number; slots?: number } = {}): Promise<Machine> {
  const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: options.trusted ?? false, approvedSlots: null } })
  assert.equal(minted.status, 200)
  const m = new Machine(await serve())
  assert.equal((await m.join(minted.body.code)).status, 200)
  await syncReady(m, competitions, options)
  return m
}

async function syncReady(m: Machine, competitions: TestCompetition[], options: { cards?: number; slots?: number; attempts?: Parameters<Machine['sync']>[0]['attempts'] } = {}) {
  const first = await m.sync({ cards: cardsOf(options.cards ?? 0) })
  const ids = new Set(competitions.map((c) => c.id))
  const ready = {
    revisions: competitions.map((c) => c.revisionId),
    data: first.body.want.data.filter((entry) => ids.has(entry.competitionId) && !entry.sealed).map((entry) => entry.manifest),
    sealed: first.body.want.data.filter((entry) => ids.has(entry.competitionId) && entry.sealed).map((entry) => entry.manifest),
    bundles: [],
  }
  return m.sync({ ready, cards: cardsOf(options.cards ?? 0), free: { slots: options.slots ?? 4, memoryMb: 32_768, cpus: 16, gpuShares: (options.cards ?? 0) * 2, diskMb: 100_000 }, attempts: options.attempts ?? [] })
}

const cardsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ device: String(i), name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564, perDevice: 2, busyShares: 0 }))

test('the owner\'s doors are the owner\'s: a teacher is refused every one of them', async () => {
  reset()
  for (const [method, path] of [['GET', '/api/admin/runners'], ['GET', '/api/admin/runners/abcdefgh'], ['POST', '/api/admin/runners/codes'], ['PATCH', '/api/admin/runners/abcdefgh'], ['POST', '/api/admin/runners/abcdefgh/drain'], ['POST', '/api/admin/runners/revoke-all']] as const) {
    assert.equal((await admin(method, path, { cookie: teacher, body: {} })).status, 403, `${method} ${path}`)
  }
})

test('a code is minted inside the three join commands, with this server\'s address and its release\'s image', async () => {
  reset()
  const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 3, hours: 12, trusted: true, approvedSlots: 4, namePrefix: 'vast-4090' } })
  assert.equal(minted.status, 200)
  const { code, commands } = minted.body
  assert.match(code, /^[a-f0-9]{32}$/)
  assert.equal(minted.body.machines, 3)
  assert.equal(minted.body.trusted, true)
  assert.ok(minted.body.expiresAt > Date.now() + 11 * 3600_000)
  const image = `ghcr.io/colloq-edu/colloq-server:${COLLOQ_VERSION}`
  // This server's own address, as PUBLIC_URL (or the checkout's .env) names it.
  const home = new URL(config.publicUrl).origin
  assert.equal(commands.docker, [
    'docker run -d --name colloq-runner --restart unless-stopped \\',
    '  -v /var/run/docker.sock:/var/run/docker.sock \\',
    '  -v /var/lib/colloq-runner:/var/lib/colloq-runner \\',
    `  -e COLLOQ_RUNNER_JOIN='${home}#${code}' \\`,
    `  ${image} runner`,
  ].join('\n'))
  assert.equal(commands.bare, [
    'command -v docker || curl -fsSL https://get.docker.com | sh',
    `docker run --rm -v /usr/local/sbin:/host ${image} install-host /host`,
    `colloq-host runner up ${home} ${code}`,
  ].join('\n'))
  assert.equal(commands.vast, `make vast-runner COUNT=3 CODE=${code} URL=${home}`)
  // It joins machines named after its prefix, trusted and capped as minted.
  const m = new Machine(await serve())
  assert.equal((await m.join(code)).status, 200)
  const runner = getRunner(m.runnerId)!
  assert.equal(runner.name, 'vast-4090-1')
  assert.equal(runner.trusted, true)
  assert.equal(runner.approvedSlots, 4)
  // The list keeps the code by its first eight hex digits, never in clear, with what it has enrolled.
  const list = await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')
  const view = list.body.codes.find((one) => one.machines === 3 && one.trusted)
  assert.ok(view)
  assert.equal(view.used, 1)
  assert.ok(!JSON.stringify(list.body).includes(code))
  // The machine's enrollment is the owner's, in the audit log.
  const enrolled = listAdminEvents({ limit: 50 }).events.find((event) => event.action === 'runner.enrolled' && event.target?.id === m.runnerId)
  assert.ok(enrolled)
  assert.equal(enrolled.actor?.role, 'owner')
  for (const body of [{ machines: 0, hours: 1, trusted: false, approvedSlots: null }, { machines: 1, hours: 25, trusted: false, approvedSlots: null }, { machines: 1, hours: 1, trusted: false, approvedSlots: 99 }, { machines: 1, hours: 1, trusted: 'yes', approvedSlots: null }, { machines: 1, hours: 1, trusted: false, approvedSlots: null, namePrefix: 'a b' }]) {
    assert.equal((await admin('POST', '/api/admin/runners/codes', { body })).status, 400, JSON.stringify(body))
  }
})

test('the list and a machine\'s page show it as its last sync said, ready or not for each competition', async () => {
  reset()
  const c = competition()
  send(c)
  const m = await machineFor([], { cards: 1 })
  let list = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body
  let row = list.machines.find((one) => one.id === m.runnerId)!
  assert.equal(row.state, 'online')
  assert.equal(row.compatible, true)
  assert.equal(row.facts.hostname, 'vast-test')
  assert.equal(row.cards.length, 1)
  assert.equal(row.cards[0].sliceMb, 12_282)
  assert.equal(row.places.offered, 4)
  const readiness = row.readiness.find((one) => one.competitionId === c.id)!
  assert.equal(readiness.verdict, 'preparing')
  assert.equal(readiness.image.state, 'waiting')
  assert.equal(list.summary.online >= 1, true)
  assert.equal(list.home.build, 'dev')
  // Ready now, and taking it.
  await syncReady(m, [c], { cards: 1 })
  list = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body
  row = list.machines.find((one) => one.id === m.runnerId)!
  assert.equal(row.readiness.find((one) => one.competitionId === c.id)?.verdict, 'taking')
  const detail = (await admin<RemoteMachineDetail>('GET', `/api/admin/runners/${m.runnerId}`)).body
  assert.equal(detail.runs.length, 1, 'the lease it was given')
  assert.ok(detail.runs[0].entrantName.length > 0)
  assert.ok(detail.events.some((event) => event.kind === 'joined'))
  assert.ok(detail.events.some((event) => event.kind === 'leased' && event.number !== null))
  assert.equal((await admin('GET', '/api/admin/runners/zzzzzzzz')).status, 404)
})

test('a machine\'s settings, its drain and resume, its disconnect, and every machine\'s at once', async () => {
  reset()
  const c = competition({ sealed: true })
  const sent = send(c)
  const m = await machineFor([c], { trusted: true })
  const lease = m.last!.leases[0]
  assert.ok(lease?.sealed, 'a trusted machine takes the hidden test')
  let detail = await admin<RemoteMachineDetail>('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { name: 'Университетская', approvedSlots: 2, perDevice: 3 } })
  assert.equal(detail.status, 200)
  assert.equal(detail.body.name, 'Университетская')
  assert.equal(detail.body.places.approved, 2)
  assert.equal(detail.body.perDevice, 3)
  for (const body of [{ name: '' }, { approvedSlots: 0 }, { perDevice: 9 }, { trusted: 'no' }]) {
    assert.equal((await admin('PATCH', `/api/admin/runners/${m.runnerId}`, { body })).status, 400, JSON.stringify(body))
  }
  // No longer trusted: its run on the hidden test goes back to the queue, with no penalty, and the next sync says so.
  detail = await admin<RemoteMachineDetail>('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { trusted: false } })
  assert.equal(detail.body.trusted, false)
  assert.equal(getLease(lease.attemptId)?.state, 'revoked')
  assert.equal(queueRow(sent.id)?.state, 'waiting')
  assert.equal(queueRow(sent.id)?.lost, 0)
  const told = await m.sync({ seq: lease.seq, attempts: [{ id: lease.attemptId, phase: 'accepted' }] })
  assert.equal(told.body.trusted, false)
  assert.deepEqual(told.body.revoke, [{ id: lease.attemptId, reason: 'cancelled' }])
  assert.ok(listAdminEvents({ limit: 50 }).events.some((event) => event.action === 'runner.trusted' && event.detail?.trusted === false))

  detail = await admin<RemoteMachineDetail>('POST', `/api/admin/runners/${m.runnerId}/drain`)
  assert.equal(detail.body.state, 'draining')
  assert.equal((await m.sync()).body.drain, true)
  detail = await admin<RemoteMachineDetail>('POST', `/api/admin/runners/${m.runnerId}/resume`)
  assert.equal(detail.body.state, 'online')
  detail = await admin<RemoteMachineDetail>('POST', `/api/admin/runners/${m.runnerId}/revoke`)
  assert.equal(detail.body.state, 'revoked')
  assert.equal((await m.sync()).status, 401)
  assert.ok(listAdminEvents({ limit: 50 }).events.some((event) => event.action === 'runner.revoked' && event.target?.id === m.runnerId))
  assert.equal((await admin('POST', `/api/admin/runners/${m.runnerId}/drain`)).status, 409, 'a disconnected machine stays disconnected')

  const two = [await machineFor([]), await machineFor([])]
  const all = await admin<RemoteMachinesResponse>('POST', '/api/admin/runners/revoke-all')
  assert.equal(all.status, 200)
  for (const one of two) assert.equal(all.body.machines.find((row) => row.id === one.runnerId)?.state, 'revoked')
})

test('the console shows a machine\'s run on its machine, groups the grid, and counts the machine\'s places', async () => {
  reset()
  const c = competition()
  // Sent one after the other: the fair order breaks a tie in arrival by id, and the test means the first to go first.
  const sent = send(c, { at: Date.now() - 2000 })
  const waiting = send(c, { at: Date.now() - 1000 })
  const m = await machineFor([c], { slots: 1 })
  const lease = m.last!.leases[0]
  assert.equal(lease.submissionId, sent.id)
  await syncReady(m, [c], { slots: 0, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  const queue = (await admin<QueueSnapshot>('GET', '/api/admin/competitions/queue')).body
  const run = queue.running.find((one) => one.submissionId === sent.id)!
  assert.deepEqual(run.machine, { id: m.runnerId, name: getRunner(m.runnerId)!.name })
  assert.equal(run.remotePhase, 'running')
  assert.ok(queue.groups, 'groups once a machine was ever connected')
  assert.equal(queue.groups![0].machineId, null)
  assert.equal(queue.groups![0].metricsOnly, true, 'this server runs no notebooks here')
  const group = queue.groups!.find((one) => one.machineId === m.runnerId)!
  assert.equal(group.busy, 1)
  assert.equal(queue.slots, 1, 'the machine\'s one place; none of this server\'s with its notebooks off')
  // The waiting one has a place in a queue the machine will take it from.
  const live = (await admin<CompetitionLive>('GET', `/api/admin/competitions/${c.id}/live`)).body
  const row = live.waiting.find((one) => one.submissionId === waiting.id)!
  assert.equal(row.place, 1)
  assert.equal(row.reason, undefined)
})

test('a row no executor that is up can take waits with its reason and no place; one a machine lost waits as returned', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const reasonOf = async (competitionId: string, submissionId: string) => {
    const live = (await admin<CompetitionLive>('GET', `/api/admin/competitions/${competitionId}/live`)).body
    const row = live.waiting.find((one) => one.submissionId === submissionId)!
    return { reason: row.reason, place: row.place, from: row.returnedFrom, why: row.returnedWhy }
  }
  assert.deepEqual(await reasonOf(c.id, sent.id), { reason: 'no_runners', place: null, from: undefined, why: undefined })
  const m = await machineFor([])
  assert.equal((await reasonOf(c.id, sent.id)).reason, 'preparing_image')
  await m.sync({ ready: { revisions: [c.revisionId], data: [], sealed: [], bundles: [] }, free: { slots: 0, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 } })
  assert.equal((await reasonOf(c.id, sent.id)).reason, 'preparing_data')
  // The hidden test and an untrusted fleet; an environment only this server has; a GPU competition and no card anywhere.
  const sealed = competition({ sealed: true })
  assert.equal((await reasonOf(sealed.id, send(sealed).id)).reason, 'needs_trusted')
  const local = competition({ local: true })
  assert.equal((await reasonOf(local.id, send(local).id)).reason, 'home_only_env')
  const gpu = competition({ gpu: true })
  assert.equal((await reasonOf(gpu.id, send(gpu).id)).reason, 'no_gpu_runner')
  // The participant reads «готовится» for all of these, and nothing of which.
  const { queueSlots } = await import('../server/src/competitions/runner.js')
  assert.equal(queueForecast(queueSlots()).at.has(sent.id), false)

  // Taken, then lost to a silence: back with its place, named after the machine.
  await syncReady(m, [c])
  const lease = m.last!.leases.find((one) => one.submissionId === sent.id)!
  assert.ok(lease)
  await syncReady(m, [c], { slots: 0, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  assert.equal(loseLease(lease.attemptId, Date.now(), 'silent'), true)
  // Heard again, everything still in place, and full: the row waits, named after where it came back from.
  await syncReady(m, [c], { slots: 0 })
  const back = await reasonOf(c.id, sent.id)
  assert.equal(back.reason, 'returned')
  assert.equal(back.from, getRunner(m.runnerId)!.name)
  assert.equal(back.why, 'silent')
})

test('with this server\'s notebooks on and no card of its own, a GPU notebook waits for the machines with their reasons', async () => {
  reset({ homeNotebooks: true })
  try {
    const gpu = competition({ gpu: true })
    const sent = send(gpu)
    const waitingRow = async (submissionId: string) => {
      const live = (await admin<CompetitionLive>('GET', `/api/admin/competitions/${gpu.id}/live`)).body
      return live.waiting.find((one) => one.submissionId === submissionId)!
    }
    // A machine joined and not heard yet: no machine with a card is up.
    const m = new Machine(await serve())
    const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: false, approvedSlots: null } })
    assert.equal((await m.join(minted.body.code)).status, 200)
    assert.equal((await waitingRow(sent.id)).reason, 'no_gpu_runner')
    // Heard, with a card, and without the kernel yet: the notebook is the machine's to run, and it waits for the image, with no place.
    await m.sync({ cards: cardsOf(1), free: { slots: 0, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 } })
    const row = await waitingRow(sent.id)
    assert.equal(row.reason, 'preparing_image')
    assert.equal(row.place, null, 'no executor that is up can take it: no place promised')
    // An environment built on this server: a machine cannot run it, and this server has no card for it.
    const local = competition({ gpu: true, local: true })
    const stuck = send(local)
    const localLive = (await admin<CompetitionLive>('GET', `/api/admin/competitions/${local.id}/live`)).body
    assert.equal(localLive.waiting.find((one) => one.submissionId === stuck.id)!.reason, 'home_only_env')
    // A CPU notebook is this server's to run with its notebooks on: no reason, whatever the machines have.
    const cpu = competition()
    const plain = send(cpu)
    const cpuLive = (await admin<CompetitionLive>('GET', `/api/admin/competitions/${cpu.id}/live`)).body
    assert.equal(cpuLive.waiting.find((one) => one.submissionId === plain.id)?.reason, undefined)
  } finally {
    reset()
  }
})

test('a GPU competition takes uploads while a machine with cards was heard within the hour, and promises the smallest share', async () => {
  reset()
  const gpu = competition({ gpu: true })
  const door = createCapabilityReader({ backend: () => 'test' })
  assert.equal((await door('base-gpu', undefined, { gpu: true })).execution.code, 'gpu_unavailable')
  const m = await machineFor([gpu], { cards: 1 })
  assert.equal((await door('base-gpu', undefined, { gpu: true })).execution.available, true)
  // Two runs per card on this machine: a 24 GB card's share is half of it.
  assert.equal((await admin('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { perDevice: 2 } })).status, 200)
  const view = (await admin<CompetitionView>('GET', `/api/admin/competitions/${gpu.id}`)).body
  assert.equal(view.gpuSliceMb, 12_282, 'a 24 GB card over two runs')
  assert.ok(view.where, '«Где считается» once a machine was ever connected')
  assert.equal(view.where!.homeOnly, false)
  assert.equal(view.where!.cards.recent >= 1, true)
  assert.ok(view.where!.registry.includes('base-gpu'))
  // Its last card heard more than an hour ago: the door closes again.
  const { db } = await import('../server/src/db.js')
  const { resetHeard } = await import('../server/src/competitions/remote/heard.js')
  resetHeard(Date.now() - 10 * 60_000)
  db.prepare('UPDATE remote_runners SET last_seen_at = ?').run(Date.now() - 61 * 60_000)
  assert.equal((await door('base-gpu', undefined, { gpu: true })).execution.code, 'gpu_unavailable')
})

test('«Работают сейчас» lists a machine\'s runs under their machine, holding nothing here', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = await machineFor([c], { slots: 1 })
  const lease = m.last!.leases[0]
  assert.equal(lease.submissionId, sent.id)
  const running = (await admin<RunningKernels>('GET', '/api/admin/resources/running')).body
  const entry = running.remote?.find((one) => one.competitionId === c.id)
  assert.ok(entry)
  assert.equal(entry.machines[0].id, m.runnerId)
  assert.equal(entry.machines[0].runs, 1)
  assert.equal(running.runs.some((run) => run.submissionId === sent.id), false, 'not among the runs that hold memory here')
})

test('the settings door returns the machines\' half of its box', async () => {
  reset()
  const settings = (await admin<CompetitionSettings>('GET', '/api/admin/competitions/settings')).body
  assert.ok(settings.runners)
  assert.equal(settings.runners!.homeNotebooks.value, false)
  assert.equal(typeof settings.runners!.scoreSlots.value, 'number')
})
