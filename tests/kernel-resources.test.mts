/**
 * How much of the machine a room gets — and who decides.
 *
 * On 13 Sep 2026 a seminar's kernel was killed for memory sixteen times in a
 * row: there was one limit for all rooms, it lived in an environment variable
 * and was shown nowhere in the product. The whole fix is pinned down here —
 * the numbers about the machine, a room's own number, the bounds within which
 * it is accepted, and the `docker update` that applies it to a live room
 * without killing its Python.
 *
 * There is no real docker in the suite (see `_env.mts`), so it is faked
 * exactly where it cannot be done without.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE, type InstanceResources } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner, rotateLinkKey } from '../server/src/admin/store.js'
import { app } from '../server/src/app.js'
import {
  createSession,
  db,
  sessionCpus,
  sessionMemoryMb,
  setSessionCpus,
  setSessionMemoryMb,
} from '../server/src/db.js'
import {
  applyCpuLimit,
  applyMemoryLimit,
  memSpec,
  parseMemMb,
  runArgs,
  useDockerForLimits,
} from '../server/src/kernel/pool.js'
import {
  cpuBounds,
  forgetResources,
  machineCpus,
  machineResources,
  memoryBounds,
  memoryPicture,
  parseDaemonInfo,
  parseGpus,
  readCpuInput,
  readDaemon,
  readMemoryInput,
  useDockerInfo,
} from '../server/src/kernel/resources.js'

function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

let base = ''
let server: http.Server
let cookie = ''

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = oldestOwner() ?? createTeacher({ name: 'Владелец', email: 'res.owner@example.edu', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  cookie = mintCookie(owner)
})

after(() => {
  useDockerForLimits(null)
  useDockerInfo(null)
  server?.close()
})

function call(
  method: string,
  path: string,
  init: { cookie?: string; body?: unknown } = {},
): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

/* ------------------------------------------------------------- parsing */

test('"4g", "512m" and "2048" all parse into the same kind of number, and back again', () => {
  assert.equal(parseMemMb('4g'), 4096)
  assert.equal(parseMemMb('512m'), 512)
  assert.equal(parseMemMb('16G'), 16384)
  assert.equal(parseMemMb('1073741824'), 1024)
  // Junk means "I do not know", not zero: a zero would go into `--memory=0m`.
  assert.equal(parseMemMb('много'), null)
  assert.equal(parseMemMb(''), null)
  assert.equal(memSpec(6144), '6144m')
})

test('"12514811904 10" is the memory and cores of the docker daemon, and junk is "I do not know"', () => {
  assert.deepEqual(parseDaemonInfo('12514811904 10'), { totalMb: 11935, cpus: 10 })
  // The daemon may not name the cores — the memory is still an answer.
  assert.deepEqual(parseDaemonInfo('12514811904'), { totalMb: 11935, cpus: 0 })
  assert.equal(parseDaemonInfo(''), null)
  assert.equal(parseDaemonInfo('<no value> 10'), null)
  assert.equal(parseDaemonInfo('0 10'), null)
})

/**
 * On 18 Sep 2026 the class form on a 36 GB Mac said "0.5 GB free" and painted
 * the field with a warning at any limit. Two untruths at once: on macOS
 * `os.freemem()` counts as free only memory taken by NOTHING, and the room
 * kernels on this machine live not in it but in a colima VM with twelve
 * gigabytes.
 */
test("the Mac's memory is not the room ceiling: the docker daemon sets it", () => {
  const vm = memoryPicture({
    daemonTotalMb: 11_935,
    hostTotalMb: 36_864,
    hostAvailableMb: null,
    takenMb: 4096,
  })
  assert.equal(vm.source, 'docker')
  assert.equal(vm.totalMb, 11_935, 'the ceiling was taken from the Mac memory, not from docker')
  // A gigabyte for the daemon itself — the same rule as in the bounds — and
  // the memory that live rooms already hold.
  assert.equal(vm.availableMb, 11_935 - 1024 - 4096)

  // A native daemon on Linux is the same machine: then it is the OS kernel's
  // numbers, not arithmetic.
  const native = memoryPicture({
    daemonTotalMb: 73_700,
    hostTotalMb: 73_728,
    hostAvailableMb: 51_200,
    takenMb: 8192,
  })
  assert.equal(native.source, 'host')
  assert.equal(native.totalMb, 73_728)
  assert.equal(native.availableMb, 51_200)

  // Docker is not visible — the machine remains; macOS cannot be asked for
  // free memory, and the honest answer here is `null`, not a scary zero point
  // five.
  assert.deepEqual(
    memoryPicture({ daemonTotalMb: null, hostTotalMb: 36_864, hostAvailableMb: null, takenMb: 0 }),
    { totalMb: 36_864, availableMb: null, source: 'host' },
  )

  // More was handed out than exists: "0 free", not a negative number.
  assert.equal(
    memoryPicture({ daemonTotalMb: 8192, hostTotalMb: 36_864, hostAvailableMb: null, takenMb: 16_384 })
      .availableMb,
    0,
  )
})

test('the field bounds are computed from the docker daemon, not from the machine memory', async () => {
  const previous = process.env.KERNEL_BACKEND
  process.env.KERNEL_BACKEND = 'docker'
  useDockerInfo(async () => ({ code: 0, out: '12514811904 10' }))
  try {
    forgetResources()
    assert.deepEqual(await readDaemon(), { totalMb: 11_935, cpus: 10 })
    assert.equal(memoryBounds().max, 11_935 - 1024)
    // Sixteen gigabytes in a twelve-gigabyte VM is a refusal here and now, not
    // a kernel killed for memory on the first heavy cell.
    assert.deepEqual(readMemoryInput(16_384), { ok: false, error: 'range' })
    assert.equal(machineCpus(), 10, 'the cores were counted from the machine, not from docker')
    assert.equal(cpuBounds().max, 10)
    assert.deepEqual(readCpuInput(12), { ok: false, error: 'range' })
  } finally {
    useDockerInfo(null)
    if (previous === undefined) delete process.env.KERNEL_BACKEND
    else process.env.KERNEL_BACKEND = previous
    forgetResources()
  }
})

test('an unresponsive daemon is not a refusal: the machine numbers remain', async () => {
  const previous = process.env.KERNEL_BACKEND
  process.env.KERNEL_BACKEND = 'docker'
  useDockerInfo(async () => ({ code: 1, out: 'Cannot connect to the Docker daemon' }))
  try {
    forgetResources()
    assert.equal(await readDaemon(), null)
    assert.ok(memoryBounds().max >= 512)
    assert.ok(machineCpus() >= 1)
  } finally {
    useDockerInfo(null)
    if (previous === undefined) delete process.env.KERNEL_BACKEND
    else process.env.KERNEL_BACKEND = previous
    forgetResources()
  }
})

test('nvidia-smi lines are read one card per line, and junk is skipped', () => {
  const cards = parseGpus('0, NVIDIA GeForce RTX 3090, 24576\n\nмусор\n1, NVIDIA A100, 81920\n')
  assert.deepEqual(cards, [
    { index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMb: 24576 },
    { index: 1, name: 'NVIDIA A100', memoryMb: 81920 },
  ])
})

/* ------------------------------------------------------- resources door */

test('the machine description is for staff only, and it has everything the memory field is labelled with', async () => {
  const anonymous = await call('GET', '/api/instance/resources')
  assert.equal(anonymous.status, 401, 'the machine description was given to just anyone')

  const res = await call('GET', '/api/instance/resources', { cookie })
  assert.equal(res.status, 200)
  const body = (await res.json()) as InstanceResources
  // Under the test backend the numbers are made up — but plausible and
  // complete, otherwise the class form could be neither viewed nor checked.
  assert.ok(body.memory.totalMb > 0)
  assert.ok((body.memory.availableMb ?? 0) > 0)
  // Whose numbers these are is said out loud: the label under the field on a
  // Mac must name docker's VM, not the machine these gigabytes do not belong
  // to.
  assert.ok(body.memory.source === 'host' || body.memory.source === 'docker')
  assert.ok(body.cpus > 0)
  assert.ok(Array.isArray(body.gpus))
  assert.ok(body.kernel.defaultMemoryMb >= 512)
  assert.ok(body.kernel.gpuDefaultMemoryMb >= body.kernel.defaultMemoryMb)
  assert.equal(typeof body.kernel.perEnvironment, 'object')
  assert.ok(Array.isArray(body.rooms))
  // The bounds travel with the numbers: a second copy of the rule "leave the
  // machine a gigabyte" in the browser would drift from the server's on its
  // very first change.
  assert.equal(body.limits.min, 512)
  assert.equal(body.limits.max, body.memory.totalMb - 1024)
  // Cores: the instance default and their own bounds next to the memory.
  assert.ok(body.kernel.defaultCpus >= 1)
  assert.equal(body.limits.cpus.min, 1)
  assert.equal(body.limits.cpus.max, body.cpus)
})

test('a room with its own number gets into the list of those holding memory', async () => {
  const room = 'res-listed'
  createSession(room, 'Зрение', null)
  setSessionMemoryMb(room, 6144)
  forgetResources()
  const body = await machineResources()
  const listed = body.rooms.find((r) => r.id === room)
  assert.ok(listed, 'a room with a set limit is not named')
  assert.equal(listed.memoryMb, 6144)
  assert.equal(listed.cpus, 2, 'a room without its own cores is not shown with the instance default')
  assert.equal(listed.alive, false)

  // A room given ONLY cores holds the machine too — and is named too.
  const cores = 'res-cores'
  createSession(cores, 'Потоки', null)
  setSessionCpus(cores, 6)
  forgetResources()
  const again = await machineResources()
  assert.equal(again.rooms.find((r) => r.id === cores)?.cpus, 6)
  forgetResources()
})

/* ----------------------------------------------------------- bounds */

test('the number is accepted only as an integer and only within the machine bounds', () => {
  const { min, max } = memoryBounds()
  assert.equal(min, 512)
  assert.deepEqual(readMemoryInput(4096), { ok: true, mb: 4096 })
  // null is a legitimate answer: that is how a room goes back to the
  // environment default.
  assert.deepEqual(readMemoryInput(null), { ok: true, mb: null })
  assert.deepEqual(readMemoryInput(undefined), { ok: true, mb: null })
  assert.deepEqual(readMemoryInput('6g'), { ok: false, error: 'type' })
  assert.deepEqual(readMemoryInput(1024.5), { ok: false, error: 'type' })
  assert.deepEqual(readMemoryInput(256), { ok: false, error: 'range' })
  assert.deepEqual(readMemoryInput(max + 1), { ok: false, error: 'range' })
})

test('cores are accepted from one up to all the machine has', () => {
  const { min, max } = cpuBounds()
  assert.equal(min, 1)
  assert.ok(max >= 1)
  assert.deepEqual(readCpuInput(4), { ok: true, cpus: 4 })
  // null means "as the instance has", by the same rule as for memory.
  assert.deepEqual(readCpuInput(null), { ok: true, cpus: null })
  assert.deepEqual(readCpuInput(undefined), { ok: true, cpus: null })
  assert.deepEqual(readCpuInput('4'), { ok: false, error: 'type' })
  assert.deepEqual(readCpuInput(1.5), { ok: false, error: 'type' })
  assert.deepEqual(readCpuInput(0), { ok: false, error: 'range' })
  assert.deepEqual(readCpuInput(max + 1), { ok: false, error: 'range' })
})

test('the panel creates a room with its cores and changes their number', async () => {
  const created = await call('POST', '/api/admin/seminars', {
    cookie,
    body: { name: 'Численные методы', cpus: 4 },
  })
  assert.equal(created.status, 201)
  const seminar = (await created.json()) as { id: string; cpus: number | null }
  assert.equal(seminar.cpus, 4, 'the number of cores did not reach the card')
  assert.equal(sessionCpus(seminar.id), 4)

  const raised = await call('PATCH', `/api/admin/seminars/${seminar.id}`, {
    cookie,
    body: { cpus: 6 },
  })
  assert.equal(raised.status, 200)
  assert.equal(((await raised.json()) as { cpus: number | null }).cpus, 6)
  assert.equal(sessionCpus(seminar.id), 6)

  // null returns the room to the instance default.
  const reset = await call('PATCH', `/api/admin/seminars/${seminar.id}`, {
    cookie,
    body: { cpus: null },
  })
  assert.equal(reset.status, 200)
  assert.equal(sessionCpus(seminar.id), null)

  const refused = await call('PATCH', `/api/admin/seminars/${seminar.id}`, {
    cookie,
    body: { cpus: cpuBounds().max + 1 },
  })
  assert.equal(refused.status, 400)
  assert.match(((await refused.json()) as { error: string }).error, /1/)
})

test('resetting cores in the panel gives the live container the instance limit back', async () => {
  const calls: string[][] = []
  const previous = process.env.KERNEL_CPUS
  process.env.KERNEL_CPUS = '1.5'
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  try {
    const created = await call('POST', '/api/admin/seminars', {
      cookie,
      body: { name: 'Сброс процессора', cpus: 6 },
    })
    assert.equal(created.status, 201)
    const { id } = await created.json() as { id: string }
    const reset = await call('PATCH', `/api/admin/seminars/${id}`, {
      cookie,
      body: { cpus: null },
    })
    assert.equal(reset.status, 200)
    assert.equal(sessionCpus(id), null)
    // To both of the room's containers: the personal notebooks have their own
    // cgroup, and a reset that reached only one would leave the other on the
    // old number.
    assert.deepEqual(calls, [
      ['update', '--cpus=1.5', `colloq-room-${id}`],
      ['update', '--cpus=1.5', `colloq-room-${id}-own`],
    ])
  } finally {
    useDockerForLimits(null)
    if (previous === undefined) delete process.env.KERNEL_CPUS
    else process.env.KERNEL_CPUS = previous
  }
})

test('the panel creates a room with its memory and changes the number without touching the rest', async () => {
  const created = await call('POST', '/api/admin/seminars', {
    cookie,
    body: { name: 'Компьютерное зрение', memoryMb: 6144 },
  })
  assert.equal(created.status, 201)
  const seminar = (await created.json()) as { id: string; memoryMb: number | null; name: string }
  assert.equal(seminar.memoryMb, 6144, 'the number did not reach the card')
  assert.equal(sessionMemoryMb(seminar.id), 6144)

  const raised = await call('PATCH', `/api/admin/seminars/${seminar.id}`, {
    cookie,
    body: { memoryMb: 8192 },
  })
  assert.equal(raised.status, 200)
  assert.equal(((await raised.json()) as { memoryMb: number | null }).memoryMb, 8192)
  assert.equal(sessionMemoryMb(seminar.id), 8192)

  // null returns the room to the environment default — without a second
  // field next to it.
  const reset = await call('PATCH', `/api/admin/seminars/${seminar.id}`, {
    cookie,
    body: { memoryMb: null },
  })
  assert.equal(reset.status, 200)
  assert.equal(sessionMemoryMb(seminar.id), null)
})

test('the refusal names the bounds in numbers, not "invalid value"', async () => {
  const { max } = memoryBounds()
  const tiny = await call('POST', '/api/admin/seminars', {
    cookie,
    body: { name: 'Мало', memoryMb: 128 },
  })
  assert.equal(tiny.status, 400)
  const said = ((await tiny.json()) as { error: string }).error
  assert.match(said, /512/)
  assert.match(said, new RegExp(String(max)))

  const huge = await call('POST', '/api/admin/seminars', {
    cookie,
    body: { name: 'Много', memoryMb: max + 1 },
  })
  assert.equal(huge.status, 400)

  const words = await call('POST', '/api/admin/seminars', {
    cookie,
    body: { name: 'Словами', memoryMb: '6g' },
  })
  assert.equal(words.status, 400)
})

test('the scripting door does not let a guest hand out the machine memory', async () => {
  // Without the staff cookie: on an open instance anyone can push this door.
  const guest = await call('POST', '/api/sessions', { body: { name: 'Гость', memoryMb: 8192 } })
  assert.equal(guest.status, 403)

  const staff = await call('POST', '/api/sessions', {
    cookie,
    body: { name: 'Свой', memoryMb: 8192 },
  })
  assert.equal(staff.status, 201)
  const made = (await staff.json()) as { session: { id: string } }
  assert.equal(sessionMemoryMb(made.session.id), 8192)
})

/* ------------------------------------------------------ docker arguments */

test("a room's own number beats the environment default", () => {
  const room = { sessionId: 'res-args', mount: '/w/res-args', network: 'colloq-rooms', publish: true, gpu: null }
  // The environment default is the same as before.
  assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=4g'))
  const own = runArgs({ ...room, env: 'base', memoryMb: 6144 })
  assert.ok(own.includes('--memory=6144m'), JSON.stringify(own))
  assert.ok(!own.includes('--memory=4g'), "the environment default stayed next to the room's own number")
  // Swap exactly equal to memory: otherwise a kernel that hits the limit goes
  // to disk instead of dying honestly, and the room stalls for minutes.
  assert.ok(own.includes('--memory-swap=6144m'))
})

test("the room's own core count goes both into --cpus and into the threads of the numeric libraries", () => {
  const room = { sessionId: 'res-cpu-args', mount: '/w/res-cpu-args', network: 'colloq-rooms', publish: true, gpu: null, env: 'base' }
  // The instance default is the same as before: two cores and two threads.
  const plain = runArgs(room)
  assert.ok(plain.includes('--cpus=2'), JSON.stringify(plain))
  assert.ok(plain.includes('OMP_NUM_THREADS=2'))

  const own = runArgs({ ...room, cpus: 6 })
  assert.ok(own.includes('--cpus=6'), JSON.stringify(own))
  assert.ok(!own.includes('--cpus=2'), "the instance default stayed next to the room's own number")
  /*
   * The main thing here is the second half: `os.cpu_count()` inside the
   * container shows the HOST's cores, and a room with six allocated would
   * start thirty numpy threads on them, computing slower than with one.
   */
  for (const name of ['OMP', 'MKL', 'OPENBLAS', 'NUMEXPR']) {
    assert.ok(own.includes(`${name}_NUM_THREADS=6`), `${name} stayed at the instance number`)
  }
})

test('cores of a live room are changed with docker update --cpus', async () => {
  const calls: Array<string[]> = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  assert.equal(await applyCpuLimit('res-live-cpu', 6), 'applied')
  /*
   * BOTH of the room's containers, and that is exactly what this field in the
   * class form promises.
   *
   * A room has two containers: its own and the container for its students'
   * personal notebooks (pool.ts · KernelRole). Their cgroups are separate —
   * that is the point of the second one — so "give the room six cores" is two
   * `docker update` calls, not one. Giving them to one would leave the
   * students' drafts on the instance number, which the form says not a word
   * about.
   */
  assert.deepEqual(
    calls.map((args) => args.at(-1)),
    ['colloq-room-res-live-cpu', 'colloq-room-res-live-cpu-own'],
  )
  for (const args of calls) {
    assert.equal(args[0], 'update')
    assert.ok(args.includes('--cpus=6'), JSON.stringify(args))
  }
  useDockerForLimits(null)
})

test('a core reset under docker is a docker update to KERNEL_CPUS, right on the live container', async () => {
  // The route now sends `null` as is: whose default applies is up to the pool.
  const calls: Array<string[]> = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  const previous = process.env.KERNEL_CPUS
  process.env.KERNEL_CPUS = '3'
  try {
    assert.equal(await applyCpuLimit('res-cpu-reset', null), 'applied')
    assert.ok(calls[0].includes('--cpus=3'), JSON.stringify(calls[0]))
  } finally {
    if (previous === undefined) delete process.env.KERNEL_CPUS
    else process.env.KERNEL_CPUS = previous
    useDockerForLimits(null)
  }
})

test("under the broker a live room's cores are changed by a broker PATCH, not an early pending", async () => {
  /*
   * Until 18 Sep 2026 the pool answered `pending` here without asking the
   * broker: the hint promised the cores "after the kernel restarts", while in
   * fact the Pod was torn down on the next start — together with all the
   * seminar's variables.
   */
  const seen: Array<{ method?: string; body: string }> = []
  let reply: unknown = { outcome: 'applied', cpus: 6 }
  const broker = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method, body })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(reply))
  })
  await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
  const saved = ['KERNEL_BACKEND', 'KERNEL_RUNTIME_URL', 'KERNEL_RUNTIME_TOKEN', 'KERNEL_ISOLATION'].map(
    (k) => [k, process.env[k]] as const,
  )
  // The suite turns isolation off for the test backend; the broker will not
  // talk without it.
  delete process.env.KERNEL_ISOLATION
  process.env.KERNEL_BACKEND = 'broker'
  process.env.KERNEL_RUNTIME_URL = `http://127.0.0.1:${(broker.address() as { port: number }).port}`
  process.env.KERNEL_RUNTIME_TOKEN = 'a'.repeat(64)
  try {
    assert.equal(await applyCpuLimit('res-broker-cpu', 6), 'applied')
    assert.deepEqual(seen.map((r) => [r.method, JSON.parse(r.body)]), [['PATCH', { cpus: 6 }]])
    // The reset reaches the broker as `null`: it has its own default, not the
    // web side's KERNEL_CPUS.
    reply = { outcome: 'absent' }
    assert.equal(await applyCpuLimit('res-broker-cpu', null), 'pending')
    assert.deepEqual(JSON.parse(seen[1].body), { cpus: null })
    reply = { outcome: 'pending', cpus: 2 }
    assert.equal(await applyCpuLimit('res-broker-cpu', 8), 'pending')
    reply = { error: 'Room resize is infeasible on this node' }
    broker.removeAllListeners('request')
    broker.on('request', (_req, res) => {
      res.statusCode = 409
      res.end(JSON.stringify(reply))
    })
    assert.equal(await applyCpuLimit('res-broker-cpu', 64), 'failed')
  } finally {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v
    await new Promise<void>((resolve) => broker.close(() => resolve()))
  }
})

test('the memory of a live room is changed with docker update, both flags at once', async () => {
  const calls: Array<string[]> = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  assert.equal(await applyMemoryLimit('res-live', 8192), 'applied')
  // To both of the room's containers — by the argument in the cores test above.
  assert.deepEqual(
    calls.map((args) => args.at(-1)),
    ['colloq-room-res-live', 'colloq-room-res-live-own'],
  )
  for (const args of calls) {
    assert.equal(args[0], 'update')
    /*
     * Both flags together, and this is not overcaution: docker rejects
     * `--memory` without `--memory-swap` whenever the new memory is larger than
     * the old swap — that is, exactly when the limit is raised after a kernel
     * died for memory.
     */
    assert.ok(args.includes('--memory=8192m'), JSON.stringify(args))
    assert.ok(args.includes('--memory-swap=8192m'), JSON.stringify(args))
  }
  useDockerForLimits(null)
})

test('rooms without a container are not an error: the next start will take the number', async () => {
  useDockerForLimits(async () => ({ code: 1, out: 'Error: No such container: colloq-room-res-cold' }))
  // Not a single container — neither the room's nor the personal notebooks':
  // the number waits for a start.
  assert.equal(await applyMemoryLimit('res-cold', 4096), 'pending')
  useDockerForLimits(async () => ({ code: 1, out: 'permission denied while trying to connect' }))
  assert.equal(await applyMemoryLimit('res-cold', 4096), 'failed')
  useDockerForLimits(null)
})

test('resetting memory to the default under docker waits for the next start and does not call the daemon', async () => {
  // The route sends `null` for the broker's sake; the docker path must stay
  // as it was.
  const calls: Array<string[]> = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  assert.equal(await applyMemoryLimit('res-reset', null), 'pending')
  assert.equal(calls.length, 0)
  useDockerForLimits(null)
})

/* ------------------------------------------------------------ migration */

test('the memory column is created once and survives a second start', () => {
  const columns = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).filter(
    (c) => c.name === 'memory_mb',
  )
  assert.equal(columns.length, 1, 'the column is missing or there are two')
  /*
   * And that is exactly why it is created under the guard of `table_info`:
   * SQLite has no ADD COLUMN IF NOT EXISTS, and an unconditional ALTER would
   * crash the server on the second start — not the one where this line was
   * written.
   */
  assert.throws(() => db.exec('ALTER TABLE sessions ADD COLUMN memory_mb INTEGER'))

  const cores = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).filter(
    (c) => c.name === 'cpus',
  )
  assert.equal(cores.length, 1, 'the cores column is missing or there are two')
  assert.throws(() => db.exec('ALTER TABLE sessions ADD COLUMN cpus INTEGER'))
})

test("the personal notebooks' own number changes only their container", async () => {
  const { setRules, storedRules } = await import('../server/src/db.js')
  const { applyMemoryLimit, applyCpuLimit, applyOwnLimits } = await import('../server/src/kernel/pool.js')
  const id = 'res-own-rules'
  createSession(id, 'Личные числа')
  setRules(id, { ...storedRules(id), ownBooks: 'on', ownMemoryMb: 2048, ownCpus: 1 })

  const calls: string[][] = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  try {
    /*
     * The class "Memory" field is raised to eight gigabytes — the room gets
     * eight, the personal notebooks stay at their two. Otherwise one press in
     * the class settings would silently cancel what the teacher chose for the
     * students separately.
     */
    assert.equal(await applyMemoryLimit(id, 8192), 'applied')
    assert.deepEqual(
      calls.map((args) => [args.at(-1), args.find((a) => a.startsWith('--memory='))]),
      [[`colloq-room-${id}`, '--memory=8192m'], [`colloq-room-${id}-own`, '--memory=2048m']],
    )

    calls.length = 0
    assert.equal(await applyCpuLimit(id, 6), 'applied')
    assert.deepEqual(
      calls.map((args) => [args.at(-1), args.find((a) => a.startsWith('--cpus='))]),
      [[`colloq-room-${id}`, '--cpus=6'], [`colloq-room-${id}-own`, '--cpus=1']],
    )

    /*
     * And changing the rule itself touches ONLY their container: the room's
     * numbers are its own field, and changing it from here would hand the
     * teacher's memory to the students with the very press the teacher used to
     * limit it.
     */
    calls.length = 0
    setRules(id, { ...storedRules(id), ownMemoryMb: 4096, ownCpus: 2 })
    assert.equal(await applyOwnLimits(id), 'applied')
    assert.equal(calls.length, 1, JSON.stringify(calls))
    assert.equal(calls[0].at(-1), `colloq-room-${id}-own`)
    assert.ok(calls[0].includes('--memory=4096m'), JSON.stringify(calls[0]))
    assert.ok(calls[0].includes('--cpus=2'), JSON.stringify(calls[0]))
  } finally {
    useDockerForLimits(null)
  }
})
