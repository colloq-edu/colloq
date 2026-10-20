/**
 * «Воркеру нельзя дать больше 8 ядер?» — how many cores (and how much memory)
 * one submission may be given, by whom, and what this server does with a
 * notebook that asks more than it has.
 *
 * Until 0.25 the defaults in «Ресурсы» were bounded by this server alone,
 * min(32, its CPUs): vsos has eight, its machines that run submissions
 * thirty-two, and no default could ask for more than eight. And a
 * competition's own limits, which the editor takes up to 32, met `docker run
 * --cpus=16` on that server as a refusal before the first cell — while a
 * machine that could run it stood idle. So:
 *
 *  - the CPUs' bound is the biggest executor's (settings.ts ·
 *    submissionCeiling): this server while it runs notebooks, and every
 *    machine not revoked, by what one run can be given there (executors.ts);
 *    the memory's stays this server's while it runs notebooks — past it a
 *    notebook is one this server never runs — and leaves the 256 MB the
 *    pump reserves on top of every run (executors.ts · homeLimitRoom): at
 *    the room itself the form took a default the pump then passed over;
 *  - a save is checked against the bound of the switch it leaves, and what a
 *    new competition gets — its cores and memory, and the slots the budget
 *    promises — keeps to the bounds whatever defaults are stored past them
 *    (executors.ts · newCompetitionDefaults), which «Ресурсы» shows at the
 *    bound and says so: one Save that turned this server's notebooks on took
 *    the machines' memory, and the old bound stays stored;
 *  - this server passes over a notebook it could never give the memory of,
 *    and leaves one with more CPUs than it has to a machine that will take
 *    it (runner.ts · leftToMachines), and the rest of the queue goes on here;
 *  - with no such machine — none live, none with a place, the only one that
 *    fits declining it — it runs the notebook on its own cores, its metric
 *    too, and the run row says so (runner.ts · homeLimits, coresNote).
 *
 * The test stand's server has 16 CPUs and 72 GB (kernel/resources.ts ·
 * machineCpus under KERNEL_BACKEND=test): «more than this server» is 24 here.
 * A smaller one is put in its place where memory is the question
 * (executors.ts · useHomeRunRoom): no competition asks more than 64 GB.
 */
import './_env.mts'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSettingsInput, saveCompetitionSettings, submissionCeiling } from '../server/src/competitions/settings.js'
import { homeLimitRoom, homeRunRoom, machineRunRoom, useHomeRunRoom } from '../server/src/competitions/executors.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type RunOutcome, type RunRequest, type ScoreOutcome, type ScoreRequest } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue, leftToMachines, pumpOnce, runReservationMb, setQueueSlots, settleCompetitionWork } from '../server/src/competitions/runner.js'
import { getSubmission, listRuns, queueRow, queueRows } from '../server/src/competitions/store.js'
import { joinRunner } from '../server/src/competitions/remote/store.js'
import { remoteFleet } from '../server/src/competitions/remote/views.js'
import { dataNow } from '../server/src/competitions/remote/want.js'
import { db } from '../server/src/db.js'
import { setLocaleResolver } from '../shared/i18n.js'
import type { ResourceSettingsResponse } from '../shared/admin.js'
import type { CompetitionView } from '../shared/competitions-api.js'
import type { CompetitionSettings } from '../shared/competitions-settings.js'
import { ceilingNote, coresNote, defaultsNow, memoryNote, pastBoundNote } from '../web/src/admin/competition-materials.js'
import { FACTS, Machine, close, code, competition, reset, send, serve, type TestCompetition } from './_remote.mts'
import { call, staffMember } from './_scoping.mts'

const owner = staffMember('Владелица Ядер', 'owner')
const teacher = staffMember('Учитель Ядер')

after(() => {
  useHomeRunRoom(null)
  saveCompetitionSettings({ cpus: null, memoryMb: null, homeNotebooks: null })
  reset()
  close()
})

/** A machine that said what it is, joined the way a code joins one; not online until it syncs. */
function joined(cpus: number, memoryMb = FACTS.memoryMb) {
  const made = joinRunner({ code: code(), joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: { ...FACTS, cpus, memoryMb }, address: null }, Date.now())
  assert.ok(made.ok)
  return made.runner
}

async function settings(cookie: string): Promise<CompetitionSettings> {
  const res = await call(await serve(), 'GET', '/api/admin/competitions/settings', { cookie })
  assert.equal(res.status, 200)
  return (await res.json()) as CompetitionSettings
}

const put = async (body: unknown) => call(await serve(), 'PUT', '/api/admin/competitions/settings', { cookie: owner.cookie, body })

/** What a machine has in place for a competition: its image and its open data, so that its take can lease the competition's rows. */
function readyFor(c: TestCompetition) {
  const sets = dataNow(c.id)
  return { revisions: [c.revisionId], data: sets.open ? [sets.open.manifest] : [], sealed: [] as string[], bundles: [] as string[] }
}

/* ------------------------------------------------------------- the rule */

test('the CPUs\' ceiling is the biggest executor\'s; the memory\'s stays this server\'s while it runs notebooks', () => {
  const home = { cpus: 8, memoryMb: 15_360 }
  // No machine: this server's own, the bounds the form always had.
  assert.deepEqual(submissionCeiling({ home, homeNotebooks: true, machines: [] }), { cpus: { max: 8, machine: null }, memoryMb: { max: 15_360, machine: null } })
  // A machine with more cores: the cores are its, the memory stays this server's.
  assert.deepEqual(submissionCeiling({ home, homeNotebooks: true, machines: [{ name: 'vast-1', cpus: 31, memoryMb: 12_000 }] }), {
    cpus: { max: 31, machine: 'vast-1' },
    memoryMb: { max: 15_360, machine: null },
  })
  // The biggest of several for the cores; a machine with more memory than this server changes nothing while it runs notebooks.
  assert.deepEqual(submissionCeiling({ home, homeNotebooks: true, machines: [{ name: 'cores', cpus: 23, memoryMb: 8_000 }, { name: 'memory', cpus: 4, memoryMb: 60_000 }] }), {
    cpus: { max: 23, machine: 'cores' },
    memoryMb: { max: 15_360, machine: null },
  })
  // Never above the editor's own bounds: 32 CPUs and 64 GB.
  assert.deepEqual(submissionCeiling({ home, homeNotebooks: true, machines: [{ name: 'huge', cpus: 95, memoryMb: 500_000 }] }).cpus, { max: 32, machine: 'huge' })
  // This server's notebooks off: it runs none, and only the machines count — a smaller one too, for the memory as well.
  assert.deepEqual(submissionCeiling({ home, homeNotebooks: false, machines: [{ name: 'small', cpus: 7, memoryMb: 30_000 }] }), {
    cpus: { max: 7, machine: 'small' },
    memoryMb: { max: 30_000, machine: 'small' },
  })
  assert.deepEqual(submissionCeiling({ home, homeNotebooks: false, machines: [{ name: 'cores', cpus: 23, memoryMb: 8_000 }, { name: 'memory', cpus: 4, memoryMb: 60_000 }] }), {
    cpus: { max: 23, machine: 'cores' },
    memoryMb: { max: 60_000, machine: 'memory' },
  })
  // ...and with none at all nothing runs a notebook: the ceiling stays this server's.
  assert.deepEqual(submissionCeiling({ home, homeNotebooks: false, machines: [] }), submissionCeiling({ home, homeNotebooks: true, machines: [] }))
  // A tie goes to this server.
  assert.deepEqual(submissionCeiling({ home, homeNotebooks: true, machines: [{ name: 'twin', cpus: 8, memoryMb: 15_360 }] }).cpus, { max: 8, machine: null })
})

test('past the editor\'s bounds every executor is the bound, and the tie is this server\'s', () => {
  // This server and a machine both past 32 CPUs and 64 GB: the bound is 32 and 64 GB either way, and it is named as this server's.
  const big = { cpus: 40, memoryMb: 72_704 }
  assert.deepEqual(submissionCeiling({ home: big, homeNotebooks: true, machines: [{ name: 'big-iron', cpus: 63, memoryMb: 128_000 }] }), {
    cpus: { max: 32, machine: null },
    memoryMb: { max: 65_536, machine: null },
  })
  // Among machines alone, the first named.
  assert.deepEqual(submissionCeiling({ home: big, homeNotebooks: false, machines: [{ name: 'first', cpus: 48, memoryMb: 100_000 }, { name: 'second', cpus: 96, memoryMb: 300_000 }] }), {
    cpus: { max: 32, machine: 'first' },
    memoryMb: { max: 65_536, machine: 'first' },
  })
})

test('what one run can be given: a machine keeps a core and the host\'s reserve, this server keeps its reserve', () => {
  // As the agent offers it idle (runner-agent/machine.ts · freeCapacity), less the cushion a claim adds.
  assert.deepEqual(machineRunRoom({ cpus: 32, memoryMb: 65_536 }), { cpus: 31, memoryMb: 65_536 - 2048 - 256 })
  assert.deepEqual(machineRunRoom({ cpus: 1, memoryMb: 1024 }), { cpus: 0, memoryMb: 0 })
  assert.deepEqual(homeRunRoom(), { cpus: 16, memoryMb: 73_728 - 1024 })
  // A run's own limits leave the headroom its reservation adds (runner.ts · runReservationMb).
  assert.deepEqual(homeLimitRoom(), { cpus: 16, memoryMb: 73_728 - 1024 - 256 })
  useHomeRunRoom({ cpus: 8, memoryMb: 15_360 })
  try {
    assert.deepEqual(homeRunRoom(), { cpus: 8, memoryMb: 15_360 }, 'a stand-in server for the tests')
    assert.deepEqual(homeLimitRoom(), { cpus: 8, memoryMb: 15_360 - 256 })
  } finally {
    useHomeRunRoom(null)
  }
})

test('the form\'s parser takes the ceiling for the CPUs and the memory, and keeps the machine\'s without one', () => {
  const machine = { cpus: 8, memoryMb: 16_384, reserveMb: 1024 }
  assert.deepEqual(parseSettingsInput({ cpus: 16 }, machine), { refusal: { field: 'cpus', why: 'range', min: 1, max: 8 } })
  assert.deepEqual(parseSettingsInput({ cpus: 16 }, { ...machine, ceiling: { cpus: 31, memoryMb: 63_232 } }), { patch: { cpus: 16 } })
  assert.deepEqual(parseSettingsInput({ cpus: 32 }, { ...machine, ceiling: { cpus: 31, memoryMb: 63_232 } }), { refusal: { field: 'cpus', why: 'range', min: 1, max: 31 } })
  assert.deepEqual(parseSettingsInput({ memoryMb: 32_768 }, { ...machine, ceiling: { cpus: 31, memoryMb: 63_232 } }), { patch: { memoryMb: 32_768 } })
})

/* ------------------------------------------------------------- the form */

test('the defaults\' bound follows the machines: 24 cores accepted with a 32-core machine, refused without one', async () => {
  reset({ homeNotebooks: true })
  // No machine: this server's 16, said as this server's.
  let read = await settings(owner.cookie)
  assert.equal(read.bounds.cpus.max, 16)
  assert.deepEqual(read.ceiling, { cpus: { from: 'home' }, memoryMb: { from: 'home' } })
  let refused = await put({ cpus: 24 })
  assert.equal(refused.status, 400)
  assert.match(((await refused.json()) as { error: string }).error, /16/)

  // A machine of 32 CPUs gives a run 31: the bound is its, by name for the owner only.
  const machine = joined(32)
  read = await settings(owner.cookie)
  assert.equal(read.bounds.cpus.max, 31)
  assert.deepEqual(read.ceiling?.cpus, { from: 'machine', name: machine.name })
  assert.deepEqual((await settings(teacher.cookie)).ceiling?.cpus, { from: 'machine', name: null }, 'a teacher is not told the owner\'s machines')
  const accepted = await put({ cpus: 24 })
  assert.equal(accepted.status, 200)
  assert.equal(((await accepted.json()) as CompetitionSettings).defaults.cpus, 24)
  assert.equal((await put({ cpus: 32 })).status, 400, 'still not past what the biggest gives')

  // Revoked, it gives nothing: back to this server's 16.
  db.prepare("UPDATE remote_runners SET state = 'revoked' WHERE id = ?").run(machine.id)
  assert.equal((await settings(owner.cookie)).bounds.cpus.max, 16)
  refused = await put({ cpus: 24 })
  assert.equal(refused.status, 400)

  // This server's notebooks off: a machine of 8 CPUs is the only executor, and the bound is its 7.
  saveCompetitionSettings({ cpus: null, homeNotebooks: false })
  const small = joined(8)
  read = await settings(owner.cookie)
  assert.equal(read.bounds.cpus.max, 7)
  assert.deepEqual(read.ceiling?.cpus, { from: 'machine', name: small.name })
  assert.equal((await put({ cpus: 8 })).status, 400)
  saveCompetitionSettings({ cpus: null, homeNotebooks: true })
  reset({ homeNotebooks: true })
})

test('the defaults\' memory stays within this server while it runs notebooks, a bigger machine or not', async () => {
  reset({ homeNotebooks: true })
  // A server of sixteen gigabytes and a machine of sixty-four.
  useHomeRunRoom({ cpus: 8, memoryMb: 15_360 })
  try {
    const machine = joined(32, 65_536)
    let read = await settings(owner.cookie)
    // Its fifteen gigabytes less the 256 MB the pump reserves on top of every run (executors.ts · homeLimitRoom).
    assert.equal(read.bounds.memoryMb.max, 15_360 - 256)
    assert.deepEqual(read.ceiling, { cpus: { from: 'machine', name: machine.name }, memoryMb: { from: 'home' } })
    // Every new competition would start from it, and this server could run none of their notebooks.
    assert.equal((await put({ memoryMb: 32_768 })).status, 400)
    assert.equal((await put({ memoryMb: 15_360 - 256, cpus: 24 })).status, 200, 'the cores follow the machine still')

    // Its notebooks off, only the machines run them: the memory is the machine's too.
    saveCompetitionSettings({ homeNotebooks: false })
    read = await settings(owner.cookie)
    assert.equal(read.bounds.memoryMb.max, 65_536 - 2048 - 256)
    assert.deepEqual(read.ceiling?.memoryMb, { from: 'machine', name: machine.name })
    assert.equal((await put({ memoryMb: 32_768 })).status, 200)
  } finally {
    useHomeRunRoom(null)
    saveCompetitionSettings({ cpus: null, memoryMb: null, homeNotebooks: true })
    reset({ homeNotebooks: true })
  }
})

test('a memory the form accepts is one this server runs, and a default saved under the old bound still reads as saved', async () => {
  reset({ homeNotebooks: true })
  setQueueSlots(4)
  // A server of sixteen gigabytes: fifteen for competition work, as its admission measures it.
  useHomeRunRoom({ cpus: 16, memoryMb: 15_360 })
  const runner = new Recording()
  runner.availableMb = 15_360
  useCompetitionRunner(runner)
  try {
    const bound = (await settings(owner.cookie)).bounds.memoryMb.max
    assert.equal(bound, 15_360 - 256)
    // The old bound, the room itself, is refused now: its reservation is 256 MB past what this server could ever give.
    const refused = await put({ memoryMb: 15_360 })
    assert.equal(refused.status, 400)
    assert.match(((await refused.json()) as { error: string }).error, new RegExp(String(bound)))
    assert.equal((await put({ memoryMb: bound })).status, 200)

    // A competition at the bound runs here; one at the old bound is passed over for ever.
    const fits = send(competition({ memoryMb: bound }))
    const over = send(competition({ memoryMb: 15_360 }))
    assert.deepEqual(leftToMachines(), [over.id])
    await drainCompetitionQueue()
    assert.equal(getSubmission(fits.id)?.state, 'scored')
    assert.equal(queueRow(over.id)?.state, 'waiting')

    // A default saved under the old bound is the owner's still: read as saved, as it was, and a save of another field keeps it.
    saveCompetitionSettings({ memoryMb: 15_360 })
    let read = await settings(owner.cookie)
    assert.equal(read.defaults.memoryMb, 15_360)
    assert.equal(read.defaultSources.memoryMb, 'saved')
    assert.equal((await put({ perDay: 4 })).status, 200)
    read = await settings(owner.cookie)
    assert.equal(read.defaults.memoryMb, 15_360)
    assert.equal(read.defaultSources.memoryMb, 'saved')
  } finally {
    useCompetitionRunner(null)
    useHomeRunRoom(null)
    saveCompetitionSettings({ memoryMb: null, perDay: null })
    reset({ homeNotebooks: true })
  }
})

test('one save that turns this server\'s notebooks on or off is checked against the bound it leaves', async () => {
  reset({ homeNotebooks: false })
  // A server of sixteen gigabytes and sixteen cores; a machine of sixty-four gigabytes and eight.
  useHomeRunRoom({ cpus: 16, memoryMb: 15_360 })
  try {
    joined(8, 65_536)
    // On, in the same body as a memory only the machine gives: this server's bound, and nothing of the body saved.
    const refused = await put({ homeNotebooks: true, memoryMb: 32_768 })
    assert.equal(refused.status, 400)
    assert.match(((await refused.json()) as { error: string }).error, new RegExp(String(15_360 - 256)))
    let read = await settings(owner.cookie)
    assert.equal(read.runners?.homeNotebooks.value, false)
    assert.equal(read.defaultSources.memoryMb, 'default')
    // Forgotten, the switch is its default, on: the same bound.
    assert.equal((await put({ homeNotebooks: null, memoryMb: 32_768 })).status, 400)
    assert.equal((await put({ homeNotebooks: true, memoryMb: 15_360 - 256 })).status, 200)
    read = await settings(owner.cookie)
    assert.equal(read.runners?.homeNotebooks.value, true)
    assert.equal(read.defaults.memoryMb, 15_360 - 256)

    // Off, in the same body: the machine's bound — a memory only it gives is taken...
    const off = await put({ homeNotebooks: false, memoryMb: 32_768 })
    assert.equal(off.status, 200)
    assert.equal(((await off.json()) as CompetitionSettings).defaults.memoryMb, 32_768)
    // ...and cores past its seven are not, though this server has sixteen.
    saveCompetitionSettings({ homeNotebooks: true, memoryMb: null })
    assert.equal((await put({ homeNotebooks: false, cpus: 12 })).status, 400)
    assert.equal((await settings(owner.cookie)).runners?.homeNotebooks.value, true, 'refused whole')
    assert.equal((await put({ homeNotebooks: false, cpus: 7 })).status, 200)
  } finally {
    useHomeRunRoom(null)
    saveCompetitionSettings({ cpus: null, memoryMb: null, homeNotebooks: true })
    reset({ homeNotebooks: true })
  }
})

test('a new competition starts within the bounds, whatever defaults are stored past them', async () => {
  reset({ homeNotebooks: true })
  useHomeRunRoom({ cpus: 16, memoryMb: 15_360 })
  const create = async (limits?: { memoryMb?: number; cpus?: number }) => {
    const res = await call(await serve(), 'POST', '/api/admin/competitions', {
      cookie: owner.cookie,
      body: { slug: `bound-${randomUUID().slice(0, 8)}`, title: 'Новая', ...(limits ? { limits } : {}) },
    })
    assert.equal(res.status, 201)
    return ((await res.json()) as CompetitionView).competition
  }
  try {
    const bound = 15_360 - 256
    // The bound before 0.25, the machine less a gigabyte: the owner's still in «Ресурсы», and no new competition starts with it.
    saveCompetitionSettings({ memoryMb: 15_360 })
    const read = await settings(owner.cookie)
    assert.deepEqual([read.defaults.memoryMb, read.defaultSources.memoryMb], [15_360, 'saved'])
    const made = await create()
    assert.equal(made.limits.memoryMb, bound)
    assert.equal(runReservationMb(made, 'notebook') <= homeRunRoom().memoryMb, true, 'a notebook this server can reserve')

    // Saved while only a machine of sixty-four gigabytes ran notebooks: its own then, this server's once they run here again.
    joined(32, 65_536)
    saveCompetitionSettings({ homeNotebooks: false, memoryMb: 32_768 })
    assert.equal((await create()).limits.memoryMb, 32_768)
    saveCompetitionSettings({ homeNotebooks: true })
    assert.equal((await create()).limits.memoryMb, bound)

    // A default within the bound is what it says; a limit the request names is the teacher's own.
    saveCompetitionSettings({ memoryMb: 8192 })
    assert.equal((await create()).limits.memoryMb, 8192)
    assert.equal((await create({ memoryMb: 32_768 })).limits.memoryMb, 32_768)

    // The cores the same way: 24 saved while a machine of 32 gave them, the machine revoked since.
    reset({ homeNotebooks: true })
    const big = joined(32)
    assert.equal((await put({ cpus: 24 })).status, 200)
    assert.equal((await create()).limits.cpus, 24, 'the machine gives them')
    db.prepare("UPDATE remote_runners SET state = 'revoked' WHERE id = ?").run(big.id)
    assert.equal((await create()).limits.cpus, 16, 'this server\'s, not 24 run on 16 with a note in every run')
    assert.equal((await create({ cpus: 24 })).limits.cpus, 24)
  } finally {
    useHomeRunRoom(null)
    saveCompetitionSettings({ cpus: null, memoryMb: null, homeNotebooks: true })
    reset({ homeNotebooks: true })
  }
})

test('the memory budget promises a slot what a new competition gets, not a default stored past the bound', async () => {
  reset({ homeNotebooks: true })
  setQueueSlots(3)
  useHomeRunRoom({ cpus: 16, memoryMb: 15_360 })
  try {
    // Saved while only a machine ran notebooks, this server's notebooks back on since.
    saveCompetitionSettings({ memoryMb: 32_768 })
    const res = await call(await serve(), 'GET', '/api/admin/resources', { cookie: owner.cookie })
    assert.equal(res.status, 200)
    const { competitions } = ((await res.json()) as ResourceSettingsResponse).budget
    assert.deepEqual(competitions, { slots: 3, memoryMb: 3 * (15_360 - 256), cpus: 3 * 2 })
  } finally {
    useHomeRunRoom(null)
    saveCompetitionSettings({ memoryMb: null })
    reset({ homeNotebooks: true })
  }
})

test('a default stored past its bound reads as what a new competition gets, and the line under the fields says so', () => {
  const base = { defaults: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 }, bounds: { cpus: { min: 1, max: 7 }, memoryMb: { min: 512, max: 14_080 } } } as unknown as CompetitionSettings
  assert.deepEqual(defaultsNow(base), { cpus: 2, memoryMb: 4096 })
  assert.equal(pastBoundNote(base), null, 'within the bounds, nothing to say')
  const memory = { ...base, defaults: { ...base.defaults, memoryMb: 32_768 } } as CompetitionSettings
  const both = { ...base, defaults: { ...base.defaults, memoryMb: 32_768, cpus: 12 } } as CompetitionSettings
  const cores = { ...base, defaults: { ...base.defaults, cpus: 24 } } as CompetitionSettings
  assert.deepEqual(defaultsNow(both), { cpus: 7, memoryMb: 14_080 })
  try {
    setLocaleResolver(() => 'ru')
    assert.equal(pastBoundNote(memory), 'Сохранено 32 ГБ памяти — больше, чем посылке можно дать сейчас; пока так, новое соревнование получает то, что в полях.')
    assert.equal(pastBoundNote(both), 'Сохранено 12 ядер и 32 ГБ памяти — больше, чем посылке можно дать сейчас; пока так, новое соревнование получает то, что в полях.')
    assert.equal(pastBoundNote(cores), 'Сохранено 24 ядра — больше, чем посылке можно дать сейчас; пока так, новое соревнование получает то, что в полях.')
    assert.equal(pastBoundNote({ ...memory, defaults: { ...memory.defaults, memoryMb: 15_360 } } as CompetitionSettings), 'Сохранено 15 ГБ памяти — больше, чем посылке можно дать сейчас; пока так, новое соревнование получает то, что в полях.')
    setLocaleResolver(() => 'en')
    assert.equal(pastBoundNote(both), 'Saved: 12 cores and 32 GB of memory, more than a submission can be given now; until that changes, a new competition gets what the fields show.')
  } finally {
    setLocaleResolver(() => 'ru')
  }
})

test('the form says where the bound comes from, and the editor what happens past this server', () => {
  setLocaleResolver(() => 'ru')
  const base = {
    bounds: { cpus: { min: 1, max: 31 }, memoryMb: { min: 512, max: 15_360 } },
    machine: { cpus: 8, memoryMb: 16_384 },
    runners: { homeNotebooks: { value: true, source: 'default' } },
    gpu: { managed: false, devices: [] },
  } as unknown as CompetitionSettings
  const named = { ...base, ceiling: { cpus: { from: 'machine', name: 'vast-1' }, memoryMb: { from: 'home' } } } as CompetitionSettings
  assert.equal(ceilingNote(named), 'На посылку — не больше 31 ядра (машина vast-1) и 15 ГБ памяти (этот сервер).')
  const home = { ...base, bounds: { ...base.bounds, cpus: { min: 1, max: 8 } }, ceiling: { cpus: { from: 'home' }, memoryMb: { from: 'home' } } } as CompetitionSettings
  assert.equal(ceilingNote(home), 'На посылку — не больше 8 ядер и 15 ГБ памяти: столько есть у этого сервера.')
  const machine = { ...base, ceiling: { cpus: { from: 'machine', name: 'vast-1' }, memoryMb: { from: 'machine', name: 'vast-1' } } } as CompetitionSettings
  assert.match(ceilingNote(machine) ?? '', /машина vast-1, самая большая из машин для посылок/)
  const unnamed = { ...base, ceiling: { cpus: { from: 'machine', name: null }, memoryMb: { from: 'home' } } } as CompetitionSettings
  assert.equal(ceilingNote(unnamed), 'На посылку — не больше 31 ядра (самая большая машина для посылок) и 15 ГБ памяти (этот сервер).')
  assert.equal(ceilingNote({ ...base, ceiling: undefined }), null, 'a server from before says nothing')

  // The editor's line about the cores: within this server, past it, past every executor.
  assert.equal(coresNote(8, named), null)
  assert.deepEqual(coresNote(16, named), {
    text: 'Ядер больше, чем у этого сервера (8): такие посылки возьмёт машина для посылок, а если подходящей нет на связи — их выполнит этот сервер на своих 8 ядрах.',
    tone: 'note',
  })
  assert.deepEqual(coresNote(32, named), {
    text: 'Столько ядер не даёт ни этот сервер, ни машины для посылок (самое большее 31 — машина vast-1): такие посылки выполнит этот сервер на своих 8 ядрах, медленнее, чем рассчитано.',
    tone: 'warning',
  })
  assert.match(coresNote(4, { ...named, machine: { cpus: 1, memoryMb: 4096 } } as CompetitionSettings)?.text ?? '', /на своём 1 ядре\.$/)
  // With this server's notebooks off the machines take it, and past the biggest of them nothing does.
  const off = { ...named, runners: { homeNotebooks: { value: false, source: 'saved' } } } as CompetitionSettings
  assert.equal(coresNote(16, off), null, 'with this server\'s notebooks off the machines take it, nothing to say')
  assert.equal(
    coresNote(32, off)?.text,
    'Столько ядер не даёт ни одна машина для посылок (самое большее 31 — машина vast-1): такие посылки не запустятся, пока не подключится машина побольше.',
  )
  // The card on, and no card for submissions here: this server never takes these notebooks, whatever the cores.
  assert.equal(coresNote(16, named, true), null, 'no word of this server\'s cores for notebooks it never runs')
  assert.match(coresNote(32, named, true)?.text ?? '', /не запустятся, пока не подключится машина побольше/)
  const cards = { ...named, gpu: { managed: false, devices: ['0'] } } as unknown as CompetitionSettings
  assert.equal(coresNote(16, cards, true)?.tone, 'note', 'with a card of its own, this server runs them after all')
  // A bound of this server's says nothing of the machines: no warning drawn from it.
  assert.equal(coresNote(32, { ...off, ceiling: { cpus: { from: 'home' }, memoryMb: { from: 'home' } } } as CompetitionSettings), null)
  assert.equal(coresNote(32, { ...named, gpu: { managed: true, devices: [] } } as unknown as CompetitionSettings), null, 'the cluster sizes its own Pods')
  assert.equal(coresNote(32, null), null)

  // The memory: past this server it is the machines' alone, past every machine it runs nowhere.
  assert.equal(memoryNote(15_360, named), null)
  assert.deepEqual(memoryNote(16_384, named), {
    text: 'Столько памяти этот сервер посылке не даст (самое большее 15 ГБ): такие посылки он не выполнит — их возьмёт машина для посылок, которой хватит памяти, а пока такой нет на связи, они ждут в очереди.',
    tone: 'warning',
  })
  const offMemory = { ...off, bounds: { ...base.bounds, memoryMb: { min: 512, max: 63_232 } }, ceiling: { cpus: { from: 'machine', name: 'vast-1' }, memoryMb: { from: 'machine', name: 'vast-1' } } } as CompetitionSettings
  assert.equal(memoryNote(32_768, offMemory), null)
  assert.equal(
    memoryNote(65_536, offMemory)?.text,
    'Столько памяти не даёт ни одна машина для посылок (самое большее 61,7 ГБ — машина vast-1): такие посылки не запустятся, пока не подключится машина побольше.',
  )
  assert.equal(memoryNote(16_384, named, true), null, 'with the card on and no card here, this server\'s memory is not the question')
  assert.equal(memoryNote(65_536, { ...named, gpu: { managed: true, devices: [] } } as unknown as CompetitionSettings), null)
})

/* ------------------------------------------------------------- the pump */

class Recording extends FakeCompetitionRunner {
  readonly cpus = new Map<string, { notebook?: number; metric?: number }>()
  override async run(request: RunRequest): Promise<RunOutcome> {
    this.cpus.set(request.submissionId, { ...this.cpus.get(request.submissionId), notebook: request.limits.cpus })
    return super.run(request)
  }
  override async score(request: ScoreRequest): Promise<ScoreOutcome> {
    this.cpus.set(request.submissionId, { ...this.cpus.get(request.submissionId), metric: request.limits.cpus })
    return super.score(request)
  }
}

test('a notebook bigger than this server is left to a machine that can run it, and runs here on its cores when none can', async () => {
  reset({ homeNotebooks: true })
  setQueueSlots(4)
  const runner = new Recording()
  useCompetitionRunner(runner)
  try {
    const big = competition({ cpus: 24 })
    const small = competition({ cpus: 2 })
    const wide = send(big)
    const narrow = send(small)
    // No machine live: nothing to leave it to.
    assert.deepEqual(leftToMachines(), [])

    // A live machine of 32 CPUs, still fetching the image: it will run the notebook, this server must not.
    const machine = new Machine(await serve())
    assert.equal((await machine.join(code(), { ...FACTS, cpus: 32 })).status, 200)
    assert.equal((await machine.sync({ free: { slots: 4, memoryMb: 32_768, cpus: 31, gpuShares: 0, diskMb: 100_000 } })).status, 200)
    assert.deepEqual(leftToMachines(), [wide.id])
    await pumpOnce()
    await settleCompetitionWork()
    assert.equal(queueRow(wide.id)?.state, 'waiting', 'left to the machine')
    assert.equal(runner.cpus.has(wide.id), false, 'never started here')
    assert.equal(getSubmission(narrow.id)?.state, 'scored', 'the rest of the queue goes on here')

    // A machine too small for it is no reason to wait.
    db.prepare("UPDATE remote_runners SET state = 'revoked' WHERE id = ?").run(machine.runnerId)
    const tiny = new Machine(await serve())
    assert.equal((await tiny.join(code(), { ...FACTS, cpus: 8 })).status, 200)
    assert.equal((await tiny.sync({ free: { slots: 4, memoryMb: 32_768, cpus: 7, gpuShares: 0, diskMb: 100_000 } })).status, 200)
    assert.deepEqual(leftToMachines(), [])

    // So this server runs it after all, on its own 16 cores, the metric too, and the run row says so.
    await drainCompetitionQueue()
    assert.equal(getSubmission(wide.id)?.state, 'scored')
    assert.deepEqual(runner.cpus.get(wide.id), { notebook: 16, metric: 16 })
    assert.deepEqual(runner.cpus.get(narrow.id), { notebook: 2, metric: 2 }, 'a notebook that fits keeps its own')
    const run = listRuns(wide.id).find((one) => one.kind === 'notebook')!
    assert.match(run.teacherError ?? '', /^Запущена на этом сервере с 16 ядрами вместо 24/)
    assert.equal(listRuns(narrow.id).find((one) => one.kind === 'notebook')?.teacherError ?? null, null)
  } finally {
    useCompetitionRunner(null)
    reset({ homeNotebooks: true })
  }
})

test('the only machine that fits declines the notebook: this server runs it at once, on its own cores', async () => {
  reset({ homeNotebooks: true })
  setQueueSlots(4)
  const runner = new Recording()
  useCompetitionRunner(runner)
  try {
    const c = competition({ cpus: 24 })
    const sent = send(c)
    const machine = new Machine(await serve())
    assert.equal((await machine.join(code(), { ...FACTS, cpus: 32 })).status, 200)
    const free = { slots: 1, memoryMb: 32_768, cpus: 31, gpuShares: 0, diskMb: 100_000 }
    const ready = readyFor(c)
    const lease = (await machine.sync({ ready, free })).body.leases[0]
    assert.equal(lease?.submissionId, sent.id, 'leased to the machine first')
    await machine.sync({ seq: lease.seq, ready, free: { ...free, slots: 0 }, attempts: [{ id: lease.attemptId, phase: 'accepted' }] })
    const declined = await machine.outcome(lease.attemptId, { protocol: 1, build: 'dev', free: { ...free, slots: 0 }, kind: 'declined', reason: 'wheels', detail: 'the set did not install' })
    assert.equal((declined.body as { result: string }).result, 'applied')
    assert.equal(queueRow(sent.id)?.state, 'waiting', 'back in the queue')
    // Live, big enough, a place free — and skipping this very submission for its decline.
    assert.ok(remoteFleet().machines.some((one) => one.declined.has(sent.id)))
    assert.deepEqual(leftToMachines(), [], 'a machine that declined it is no machine to wait for')
    await pumpOnce()
    await settleCompetitionWork()
    assert.equal(getSubmission(sent.id)?.state, 'scored')
    assert.deepEqual(runner.cpus.get(sent.id), { notebook: 16, metric: 16 })
  } finally {
    useCompetitionRunner(null)
    reset({ homeNotebooks: true })
  }
})

test('a live machine that offers no places takes nothing: this server runs the notebook', async () => {
  reset({ homeNotebooks: true })
  setQueueSlots(4)
  const runner = new Recording()
  useCompetitionRunner(runner)
  try {
    const c = competition({ cpus: 24 })
    const sent = send(c)
    const machine = new Machine(await serve())
    assert.equal((await machine.join(code(), { ...FACTS, cpus: 32 })).status, 200)
    // Ready for the competition, room enough — and not one place (its agent says so: the disk, a drain of its own making).
    const reply = await machine.sync({ ready: readyFor(c), free: { slots: 0, memoryMb: 32_768, cpus: 31, gpuShares: 0, diskMb: 100_000 } })
    assert.equal(reply.body.leases.length, 0)
    assert.equal(remoteFleet().machines.find((one) => one.runner.id === machine.runnerId)?.cap, 0)
    assert.deepEqual(leftToMachines(), [])
    await pumpOnce()
    await settleCompetitionWork()
    assert.equal(getSubmission(sent.id)?.state, 'scored')
    assert.deepEqual(runner.cpus.get(sent.id), { notebook: 16, metric: 16 })
  } finally {
    useCompetitionRunner(null)
    reset({ homeNotebooks: true })
  }
})

test('a notebook this server could never give the memory of is passed over, and the notebooks behind it run', async () => {
  reset({ homeNotebooks: true })
  setQueueSlots(4)
  // A server of sixteen gigabytes: fifteen for competition work, as its admission measures it.
  useHomeRunRoom({ cpus: 16, memoryMb: 15_360 })
  const runner = new Recording()
  runner.availableMb = 15_360
  useCompetitionRunner(runner)
  try {
    const huge = send(competition({ memoryMb: 49_152 }), { at: Date.now() - 1000 })
    const small = send(competition({ memoryMb: 2048 }))
    // No machine on line at all (reset revoked them): it is passed over all the same — no end of anything here makes it fit.
    assert.deepEqual(remoteFleet().machines, [])
    assert.deepEqual(leftToMachines(), [huge.id])
    for (let pass = 0; pass < 3; pass++) {
      await pumpOnce()
      await settleCompetitionWork()
    }
    assert.equal(getSubmission(small.id)?.state, 'scored', 'the lane is not held by a head that can never start')
    assert.equal(queueRow(huge.id)?.state, 'waiting', 'it waits for a machine with that much memory')
    assert.equal(runner.cpus.has(huge.id), false)
  } finally {
    useCompetitionRunner(null)
    useHomeRunRoom(null)
    reset({ homeNotebooks: true })
  }
})

test('more memory than this server could ever reserve is left to the machines, a hidden test or not', async () => {
  reset({ homeNotebooks: true })
  const c = competition({ memoryMb: 16_384 })
  const sent = send(c)
  const machine = new Machine(await serve())
  assert.equal((await machine.join(code())).status, 200)
  assert.equal((await machine.sync()).status, 200)
  // A server of eight gigabytes: 16 GB and the cushion are past it.
  assert.deepEqual(leftToMachines(queueRows(), { home: { cpus: 16, memoryMb: 8192 } }), [sent.id])
  // Enough here, nothing is left.
  assert.deepEqual(leftToMachines(queueRows(), { home: { cpus: 16, memoryMb: 32_768 } }), [])
  // A hidden test goes to trusted machines only, and this one is not: still nothing this server could run — it waits.
  const secret = send(competition({ memoryMb: 16_384, sealed: true }))
  assert.ok(leftToMachines(queueRows(), { home: { cpus: 16, memoryMb: 8192 } }).includes(secret.id))
  reset({ homeNotebooks: true })
})
