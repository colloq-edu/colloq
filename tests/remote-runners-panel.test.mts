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
import { getLease, getRunner, mintRemoteCode } from '../server/src/competitions/remote/store.js'
import { loseLease } from '../server/src/competitions/remote/release.js'
import { queueForecast } from '../server/src/competitions/forecast.js'
import { getSubmission, queueRow } from '../server/src/competitions/store.js'
import { tr } from '../shared/i18n.js'
import { COLLOQ_VERSION } from '../server/src/version.js'
import { config } from '../server/src/config.js'
import { ANSWER, FACTS, Machine, close, competition, finished, reset, send, serve, type TestCompetition } from './_remote.mts'

const FACTS_FOR_PANEL = FACTS
const getSubmissionState = (id: string) => getSubmission(id)?.state

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
    // Per manifest, as an agent reports it: competitions with the same files share one.
    data: [...new Set(first.body.want.data.filter((entry) => ids.has(entry.competitionId) && !entry.sealed).map((entry) => entry.manifest))],
    sealed: [...new Set(first.body.want.data.filter((entry) => ids.has(entry.competitionId) && entry.sealed).map((entry) => entry.manifest))],
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
    'docker run -d --name colloq-runner --restart unless-stopped --network host --stop-timeout 90 \\',
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

test('a machine joined with a code minted on the console is enrolled by the console in the audit log, not by nobody', async () => {
  reset()
  // The row colloq-host runner-code writes (ops/runner-code.ts): the same minter, with the console as its maker.
  const minted = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, namePrefix: null, createdBy: 'colloq-host' })
  const m = new Machine(await serve())
  assert.equal((await m.join(minted.code)).status, 200)
  const enrolled = listAdminEvents({ limit: 50 }).events.find((event) => event.action === 'runner.enrolled' && event.target?.id === m.runnerId)
  assert.ok(enrolled)
  assert.equal(enrolled.actor, null)
  assert.equal(enrolled.detail?.source, 'colloq-host')
  // A code from the panel names its owner and says nothing of a console.
  const fromPanel = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: false, approvedSlots: null } })
  assert.equal(fromPanel.status, 200)
  const other = new Machine(await serve())
  assert.equal((await other.join(fromPanel.body.code)).status, 200)
  const owned = listAdminEvents({ limit: 50 }).events.find((event) => event.action === 'runner.enrolled' && event.target?.id === other.runnerId)
  assert.equal(owned?.actor?.role, 'owner')
  assert.equal(owned?.detail?.source, undefined)
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

test('the settings door returns the machines\' half of its box, each value with its source', async () => {
  reset()
  const settings = (await admin<CompetitionSettings>('GET', '/api/admin/competitions/settings')).body
  assert.ok(settings.runners)
  assert.deepEqual(settings.runners!.homeNotebooks, { value: false, source: 'saved' }, 'saved by the owner (here, by the tests)')
  assert.equal(typeof settings.runners!.scoreSlots.value, 'number')
  assert.equal(settings.runners!.scoreSlots.source, 'default', 'never saved: the default answers, and the form offers no «вернуть умолчание»')
  for (const key of ['runnerBlobMBps', 'runnerUploads'] as const) assert.ok(['saved', 'default'].includes(settings.runners![key].source), key)
})

test('a notebook no live machine can ever fit waits as no_fit, with no place, by the take\'s own rules', async () => {
  reset()
  const big = competition({ memoryMb: 32_768 })
  const wide = competition({ cpus: 8 })
  const fits = competition()
  const tooBig = send(big, { at: Date.now() - 4000 })
  const tooWide = send(wide, { at: Date.now() - 3000 })
  const gone = send(fits, { at: Date.now() - 2000 })
  const ok = send(fits, { at: Date.now() - 1000 })
  // A notebook gone from disk before anything read it: no lease could carry it.
  const { competitionsFs, inputDir, NOTEBOOK_FILE } = await import('../server/src/competitions/storage.js')
  const path = await import('node:path')
  competitionsFs.rmSync(path.join(inputDir(fits.id, gone.id), NOTEBOOK_FILE), { force: true })
  const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: false, approvedSlots: null } })
  const m = new Machine(await serve())
  assert.equal((await m.join(minted.body.code)).status, 200)
  const first = await m.sync()
  const ids = new Set([big.id, wide.id, fits.id])
  const ready = {
    revisions: [big.revisionId, wide.revisionId, fits.revisionId],
    // What is ready is per manifest, and these three competitions share theirs: one report of it.
    data: [...new Set(first.body.want.data.filter((entry) => ids.has(entry.competitionId) && !entry.sealed).map((entry) => entry.manifest))],
    sealed: [], bundles: [],
  }
  // Sixteen gigabytes and four CPUs, everything in place, no place free yet: nothing taken while the reasons are read.
  const small = { slots: 0, memoryMb: 16_000, cpus: 4, gpuShares: 0, diskMb: 100_000 }
  assert.equal((await m.sync({ ready, free: small })).status, 200)
  const waiting = async (c: TestCompetition, id: string) =>
    (await admin<CompetitionLive>('GET', `/api/admin/competitions/${c.id}/live`)).body.waiting.find((one) => one.submissionId === id)!
  for (const [c, sent] of [[big, tooBig], [wide, tooWide], [fits, gone]] as const) {
    assert.equal((await waiting(c, sent.id)).reason, 'no_fit', `${c.slug}: no machine can ever run it as it is`)
  }
  assert.equal((await waiting(fits, ok.id)).reason, undefined, 'the one that fits waits for its turn')
  // The take passes over exactly those: given places, the machine is leased the one that fits and no other.
  const leased = await m.sync({ ready, free: { ...small, slots: 4 } })
  assert.deepEqual(leased.body.leases.map((lease) => lease.submissionId), [ok.id])
  // Places free on the machine, and still none of them promised to a row it will never take.
  const held = leased.body.leases[0]
  assert.deepEqual((await m.sync({ ready, seq: held.seq, free: { ...small, slots: 3 }, attempts: [{ id: held.attemptId, phase: 'accepted' }] })).body.leases, [])
  for (const [c, sent] of [[big, tooBig], [wide, tooWide], [fits, gone]] as const) {
    const row = await waiting(c, sent.id)
    assert.equal(row.reason, 'no_fit')
    assert.equal(row.place, null, `${c.slug}: no place and no ETA from places it can never have`)
  }
  // A bigger machine that is still pulling the images: the reason is the nearest machine's, not the smallest one's.
  const bigger = new Machine(await serve())
  const again = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: false, approvedSlots: null } })
  assert.equal((await bigger.join(again.body.code)).status, 200)
  await bigger.sync({ ready: { ...ready, revisions: [] }, free: { slots: 0, memoryMb: 128_000, cpus: 32, gpuShares: 0, diskMb: 100_000 } })
  assert.equal((await waiting(big, tooBig.id)).reason, 'preparing_image')
  assert.equal((await waiting(wide, tooWide.id)).reason, 'preparing_image')
  assert.equal((await waiting(fits, gone.id)).reason, 'no_fit', 'a notebook gone from disk fits no machine, however big')
})

test('with no card of its own, this server\'s missing share never hides the machines\' known one in the console', async () => {
  reset({ homeNotebooks: true })
  try {
    const gpu = competition({ gpu: true })
    // A GPU notebook waits: this server, with no card, says so with zero GPU places of its own.
    send(gpu)
    const m = await machineFor([], { cards: 1 })
    assert.equal((await admin('PATCH', `/api/admin/runners/${m.runnerId}`, { body: { perDevice: 2 } })).status, 200)
    await syncReady(m, [], { cards: 1, slots: 0 })
    const queue = (await admin<QueueSnapshot>('GET', '/api/admin/competitions/queue')).body
    assert.ok(queue.gpu)
    assert.equal(queue.gpu!.slots, 2, 'the machine\'s two shares, none of this server\'s')
    assert.equal(queue.gpu!.sliceMb, 12_282, 'a 24 GB card over two runs, known')
  } finally {
    reset()
  }
})

test('a competition whose environment is this server\'s alone reads «только на этом сервере» on every machine', async () => {
  reset()
  const local = competition({ local: true })
  send(local)
  const m = await machineFor([])
  const list = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body
  const readiness = list.machines.find((one) => one.id === m.runnerId)!.readiness.find((one) => one.competitionId === local.id)
  assert.ok(readiness, 'it is on the machine\'s list')
  assert.equal(readiness.verdict, 'home_only')
  assert.equal(readiness.image.state, 'not_needed')
  // And the machine is asked for nothing of it.
  assert.equal(m.last!.want.data.some((entry) => entry.competitionId === local.id), false)
})

test('a minted code says which code it is, warns of a loopback address, names this server\'s own image, and takes up to a hundred machines', async () => {
  reset()
  const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 100, hours: 2, trusted: false, approvedSlots: null } })
  assert.equal(minted.status, 200, 'a hundred machines, as colloq-host runner-code --machines allows')
  assert.equal((await admin('POST', '/api/admin/runners/codes', { body: { machines: 101, hours: 2, trusted: false, approvedSlots: null } })).status, 400)
  // Its id is the list's id of that code: the dialog counts only the machines that joined with it.
  const list = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body
  const view = list.codes.find((one) => one.id === minted.body.id)
  assert.ok(view, 'the same id in the list')
  assert.equal(view.machines, 100)
  assert.equal(view.used, 0)
  const m = new Machine(await serve())
  assert.equal((await m.join(minted.body.code)).status, 200)
  assert.equal((await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body.codes.find((one) => one.id === minted.body.id)?.used, 1)
  // The tests' PUBLIC_URL is this machine's loopback: no machine anywhere else can reach it, and the answer says so.
  assert.equal(minted.body.loopback, true)
  const { loopbackAddress } = await import('../server/src/competitions/remote/origin.js')
  assert.equal(loopbackAddress('https://vsos.colloq.ru'), false)
  // An instance on an image of its own (colloq-host passes it as COLLOQ_SERVER_IMAGE) names that very image, and no Vast command.
  const before = process.env.COLLOQ_SERVER_IMAGE
  process.env.COLLOQ_SERVER_IMAGE = 'registry.example.org/colloq/colloq-vast:0.24.0-campus'
  try {
    const own = (await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: false, approvedSlots: null } })).body
    assert.ok(own.commands.docker.includes('  registry.example.org/colloq/colloq-vast:0.24.0-campus runner'))
    assert.equal(own.commands.vast, '')
  } finally {
    if (before === undefined) delete process.env.COLLOQ_SERVER_IMAGE
    else process.env.COLLOQ_SERVER_IMAGE = before
  }
})

test('a machine that joined and never synced was never «на связи»; it counts as scored only what got a score; its log is in this server\'s words', async () => {
  reset()
  const c = competition()
  const scored = send(c, { at: Date.now() - 2000 })
  const failed = send(c, { at: Date.now() - 1000 })
  const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 1, hours: 1, trusted: false, approvedSlots: null } })
  const m = new Machine(await serve())
  // A hostname with a marker in it: what a machine says is shown as this server says it, never raw.
  const { remoteTextMarker, REMOTE_TEXT_OPEN } = await import('../shared/remote-runner.js')
  assert.equal((await m.join(minted.body.code, { ...FACTS_FOR_PANEL, hostname: `vast ${remoteTextMarker('server.runners.why.silent')}` })).status, 200)
  const joined = (await admin<RemoteMachineDetail>('GET', `/api/admin/runners/${m.runnerId}`)).body
  assert.equal(joined.lastSeenAt, null, 'joined and never synced')
  const line = joined.events.find((event) => event.kind === 'joined')!
  assert.ok(!(line.detail ?? '').includes(REMOTE_TEXT_OPEN), 'no raw marker reaches the panel')
  assert.ok((line.detail ?? '').includes(tr('server.runners.why.silent')))
  // Synced: heard now; then two runs, one scored and one whose notebook failed.
  await syncReady(m, [c], { slots: 2 })
  assert.ok((await admin<RemoteMachineDetail>('GET', `/api/admin/runners/${m.runnerId}`)).body.lastSeenAt !== null)
  const leases = m.last!.leases
  const ready = { revisions: [c.revisionId], data: [...new Set(m.last!.want.data.filter((entry) => entry.competitionId === c.id).map((entry) => entry.manifest))], sealed: [], bundles: [] }
  await m.sync({ seq: Math.max(...leases.map((one) => one.seq)), ready, free: { slots: 0, memoryMb: 30_000, cpus: 12, gpuShares: 0, diskMb: 100_000 }, attempts: leases.map((one) => ({ id: one.attemptId, phase: 'running' as const, runningMs: 10 })) })
  for (const lease of leases) {
    if (lease.submissionId === scored.id) {
      assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
      await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))
    } else {
      assert.equal(lease.submissionId, failed.id)
      await m.outcome(lease.attemptId, finished(lease.attemptId, [], { status: 'cell_error', produced: false, detail: 'Traceback\nValueError', diagnostics: { exit: 1, oomKilled: false, backend: 'docker' } }))
    }
  }
  const { drainCompetitionQueue } = await import('../server/src/competitions/runner.js')
  await drainCompetitionQueue()
  assert.equal(getSubmissionState(scored.id), 'scored')
  assert.equal(getSubmissionState(failed.id), 'notebookFailed')
  const counted = (await admin<RemoteMachineDetail>('GET', `/api/admin/runners/${m.runnerId}`)).body.counts
  assert.equal(counted.scored, 1, 'the failed notebook was applied, and is no score')
})

test('the console\'s group of this server names its version, and with no notebooks here its metric lane\'s places; «Работают сейчас» lists the machines\' runs to stop; «Где считается» knows the machines\' share', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = await machineFor([c], { slots: 1 })
  const lease = m.last!.leases[0]
  assert.equal(lease.submissionId, sent.id)
  await syncReady(m, [c], { slots: 0, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  const { homeVersion } = await import('../server/src/competitions/remote/store.js')
  const { scoreSlotsSetting } = await import('../server/src/competitions/settings.js')
  let queue = (await admin<QueueSnapshot>('GET', '/api/admin/competitions/queue')).body
  const home = queue.groups![0]
  assert.equal(home.machineId, null)
  assert.equal(home.version, homeVersion(), 'the other half of «на ней 0.23.0, на сервере 0.24.0»')
  assert.equal(home.metricsOnly, true)
  assert.deepEqual(home.metric, { places: scoreSlotsSetting().value, busy: 0 }, '«только метрики · 0 из 2»: the metric lane\'s')
  assert.deepEqual([home.places, home.busy], [0, 0], 'no notebook places here, and none taken')
  // «Работают сейчас»: the run on the machine, by submission, for a stop through the console's kill door.
  const running = (await admin<RunningKernels>('GET', '/api/admin/resources/running')).body
  const entry = running.remote!.find((one) => one.competitionId === c.id)!
  assert.deepEqual(entry.submissionIds, [sent.id])
  const killed = await admin<{ killed: boolean }>('POST', '/api/admin/competitions/queue/kill', { body: { submissionId: sent.id } })
  assert.equal(killed.status, 200)
  assert.equal(getLease(lease.attemptId)?.state, 'revoked', 'a durable cancel of the machine\'s run')
  assert.deepEqual((await m.sync({ seq: lease.seq, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 50 }] })).body.revoke, [{ id: lease.attemptId, reason: 'cancelled' }])
  // With this server's notebooks on, its group is notebook places, and a metric is no notebook's.
  const { saveCompetitionSettings } = await import('../server/src/competitions/settings.js')
  saveCompetitionSettings({ homeNotebooks: true })
  try {
    queue = (await admin<QueueSnapshot>('GET', '/api/admin/competitions/queue')).body
    assert.equal(queue.groups![0].metricsOnly, undefined)
    assert.equal(queue.groups![0].metric, undefined)
  } finally {
    saveCompetitionSettings({ homeNotebooks: false })
  }
  // A GPU competition: the share a run gets on the machines' smallest card, for the editor's «срез ≈ 12 ГБ».
  const gpu = competition({ gpu: true })
  const carded = await machineFor([gpu], { cards: 1 })
  assert.equal((await admin('PATCH', `/api/admin/runners/${carded.runnerId}`, { body: { perDevice: 2 } })).status, 200)
  const view = (await admin<CompetitionView>('GET', `/api/admin/competitions/${gpu.id}`)).body
  assert.equal(view.where!.cards.sliceMb, 12_282)
})

test('a forecast reads the machines\' leases a fixed number of times, however many rows wait and machines take work', async () => {
  reset()
  const c = competition()
  const machines = [await machineFor([c], { slots: 0 }), await machineFor([c], { slots: 0 }), await machineFor([c], { slots: 0 })]
  // Rows that came back from a machine, and rows that never went to one: the wait reasons ask about every one.
  const rows = Array.from({ length: 24 }, (_, i) => send(c, { at: Date.now() - 10_000 + i }))
  void rows
  void machines
  const { db } = await import('../server/src/db.js')
  const { queueSlots } = await import('../server/src/competitions/runner.js')
  const prepare = db.prepare.bind(db)
  let reads = 0
  ;(db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    if (sql.includes('remote_leases')) reads++
    return prepare(sql)
  }) as typeof db.prepare
  let forecast: ReturnType<typeof queueForecast>
  try {
    forecast = queueForecast(queueSlots())
  } finally {
    ;(db as { prepare: typeof db.prepare }).prepare = prepare
  }
  assert.equal(forecast.eligible.filter((row) => row.competitionId === c.id).length, 24)
  assert.ok(reads <= 3, `one read of the live leases, one of the waiting rows' last leases: ${reads} reads for 24 rows and 3 machines`)
})
