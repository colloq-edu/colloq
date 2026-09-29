/**
 * Instance-wide resource settings: what a room, its personal-notebook
 * container and an upload get when nothing more specific was said.
 *
 * They lived only in environment variables, changeable over ssh and with a
 * restart. Now the owner saves them in the panel, and three promises are
 * pinned down here: the resolution order (saved, then the environment, then
 * the built-in default, and `null` hands a value back), the bounds (types
 * refused, numbers clamped, the file space never below one upload), and that
 * every consumer reads the value at the moment of use, so a change needs no
 * restart. Plus the door: staff read, only the owner writes.
 *
 * And one regression that came with it: the live update of the
 * personal-notebook container resolved its defaults differently from
 * `docker run`, so a rules change shrank a GPU class's container from sixteen
 * gigabytes to four.
 */
import './_env.mts'
import http from 'node:http'
import cp from 'node:child_process'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import {
  STAFF_COOKIE,
  type InstanceResources,
  type InstanceState,
  type ResourceSettingName,
  type ResourceSettingsResponse,
} from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner, rotateLinkKey } from '../server/src/admin/store.js'
import {
  parseResourcePatch,
  perEnvironmentMemoryMb,
  RESOURCE_SETTING_NAMES,
  ResourceRefusal,
  resourceSettings,
  resourceValue,
  sessionLimitBytes,
  updateResourceSettings,
  uploadLimitBytes,
} from '../server/src/admin/resource-settings.js'
import { putSettingRow } from '../server/src/admin/settings.js'
import { app } from '../server/src/app.js'
import { signToken } from '../server/src/auth.js'
import { config } from '../server/src/config.js'
import {
  createSession,
  setRules,
  setSessionCpus,
  setSessionMemoryMb,
  storedRules,
  upsertParticipant,
} from '../server/src/db.js'
import {
  applyOwnLimits,
  defaultCpus,
  defaultMemoryMb,
  kernelLimits,
  memoryLimitMb,
  ownIdleMinutes,
  ownKernelMax,
  runArgs,
  useDockerForLimits,
} from '../server/src/kernel/pool.js'
import { ownPidsLimit, pidsLimit } from '../server/src/kernel/perimeter.js'
import { forgetResources, useDockerInfo } from '../server/src/kernel/resources.js'

const MB = 1024 * 1024

/*
 * The variables this file is about are cleared once for all of it: a
 * developer's shell or .env must not decide what "the default" is here. The
 * tests that need one hand it in (`resourceValue(name, env)`) or set it with
 * `withEnv`.
 */
const VARIABLES = [
  'KERNEL_MEM', 'KERNEL_MEM_BASE', 'KERNEL_MEM_BASE_GPU', 'KERNEL_CPUS', 'KERNEL_OWN_MAX',
  'KERNEL_OWN_IDLE_MIN', 'KERNEL_OWN_PIDS', 'KERNEL_PIDS',
]
for (const name of VARIABLES) delete process.env[name]

/** The test backend's machine (kernel/resources.ts): 72 GB, a gigabyte kept back, sixteen cores. */
const MACHINE = { memory: { min: 512, max: 73_728 - 1024 }, cpus: { min: 1, max: 16 } }

/** Forget every saved row: each test starts from the environment and the defaults. */
function forgetAll(): void {
  updateResourceSettings(
    Object.fromEntries(RESOURCE_SETTING_NAMES.map((name) => [name, null])) as Record<ResourceSettingName, null>,
    MACHINE,
  )
}

async function withEnv<T>(vars: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return await body()
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

let base = ''
let server: http.Server
let ownerCookie = ''
let teacherCookie = ''

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = oldestOwner() ?? createTeacher({ name: 'Владелец', email: 'resources.owner@example.edu', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  ownerCookie = mintCookie(owner)
  const teacher = createTeacher({ name: 'Преподаватель', email: 'resources.teacher@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  teacherCookie = mintCookie(teacher)
})

afterEach(() => {
  forgetAll()
  useDockerForLimits(null)
  forgetResources()
})

after(() => server?.close())

function call(
  method: string,
  path: string,
  init: { cookie?: string; body?: unknown } = {},
): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

/* ------------------------------------------------------------ resolution */

test('with nothing saved and nothing in the environment, every setting is its built-in default', () => {
  const settings = resourceSettings({})
  const defaults: Record<ResourceSettingName, number | null> = {
    roomMemoryMb: 4096,
    gpuRoomMemoryMb: 16384,
    roomCpus: 2,
    ownMemoryMb: null,
    ownCpus: null,
    ownMax: 60,
    ownIdleMin: 30,
    ownPids: 2048,
    roomPids: 512,
    uploadMb: 50,
    sessionMb: 1024,
  }
  for (const name of RESOURCE_SETTING_NAMES) {
    assert.equal(settings[name].default, defaults[name], name)
    assert.equal(settings[name].source, 'default', name)
  }
  for (const name of ['roomMemoryMb', 'roomCpus', 'ownMax', 'ownIdleMin', 'ownPids', 'roomPids'] as const) {
    assert.equal(settings[name].value, defaults[name], name)
  }
  // The upload pair answers from config, which holds the same default read at boot.
  assert.equal(settings.uploadMb.value, config.maxUploadBytes / MB)
  assert.equal(settings.sessionMb.value, config.maxSessionBytes / MB)
  // A setting with a variable names it; one without leaves both fields out.
  assert.equal(settings.roomMemoryMb.envName, 'KERNEL_MEM')
  assert.equal(settings.roomMemoryMb.env, null)
  assert.equal('env' in settings.gpuRoomMemoryMb, false)
  assert.equal('envName' in settings.ownMemoryMb, false)
})

test('saved beats the environment, the environment beats the default, and null hands it back', () => {
  const env = {
    KERNEL_OWN_MAX: '45',
    KERNEL_CPUS: '1.5',
    KERNEL_MEM: '6g',
    KERNEL_OWN_IDLE_MIN: '0',
    KERNEL_PIDS: '1024',
    KERNEL_OWN_PIDS: '4096',
  }
  let settings = resourceSettings(env)
  assert.deepEqual([settings.ownMax.value, settings.ownMax.source, settings.ownMax.env], [45, 'env', 45])
  // Fractional cores are what docker takes, and the variable keeps them.
  assert.deepEqual([settings.roomCpus.value, settings.roomCpus.source], [1.5, 'env'])
  assert.deepEqual([settings.roomMemoryMb.value, settings.roomMemoryMb.source], [6144, 'env'])
  // Zero is meaningful for idle minutes: "never stop".
  assert.deepEqual([settings.ownIdleMin.value, settings.ownIdleMin.source], [0, 'env'])
  assert.equal(settings.roomPids.value, 1024)
  assert.equal(settings.ownPids.value, 4096)

  updateResourceSettings({ ownMax: 12, roomCpus: 4, roomMemoryMb: 8192, ownIdleMin: 15 }, MACHINE)
  settings = resourceSettings(env)
  // The variable is still reported next to the value that beat it.
  assert.deepEqual([settings.ownMax.value, settings.ownMax.source, settings.ownMax.env], [12, 'saved', 45])
  assert.deepEqual([settings.roomCpus.value, settings.roomCpus.source], [4, 'saved'])
  assert.deepEqual([settings.roomMemoryMb.value, settings.roomMemoryMb.source], [8192, 'saved'])
  assert.deepEqual([settings.ownIdleMin.value, settings.ownIdleMin.source], [15, 'saved'])

  updateResourceSettings({ ownMax: null, roomCpus: null }, MACHINE)
  settings = resourceSettings(env)
  assert.deepEqual([settings.ownMax.value, settings.ownMax.source], [45, 'env'])
  assert.deepEqual([settings.roomCpus.value, settings.roomCpus.source], [1.5, 'env'])
  // What the patch did not name keeps its saved row.
  assert.equal(settings.roomMemoryMb.source, 'saved')
  // And without the variable, the default answers.
  assert.deepEqual([resourceSettings({}).ownMax.value, resourceSettings({}).ownMax.source], [60, 'default'])
})

test('an environment variable keeps the parse it always had: junk reads as unset', () => {
  for (const bad of ['0', '-1', 'сорок', '1.5', '']) {
    assert.equal(resourceValue('ownMax', { KERNEL_OWN_MAX: bad }), 60, bad)
  }
  // Below the floor is junk too, not a ceiling to clamp to.
  for (const bad of ['10', 'много', '1.5']) assert.equal(resourceValue('roomPids', { KERNEL_PIDS: bad }), 512, bad)
  assert.equal(resourceValue('roomMemoryMb', { KERNEL_MEM: '4 gigs' }), 4096)
  assert.equal(resourceValue('roomCpus', { KERNEL_CPUS: '0' }), 2)
  assert.equal(resourceValue('ownIdleMin', { KERNEL_OWN_IDLE_MIN: ' 0 ' }), 0)
  assert.equal(resourceValue('ownIdleMin', { KERNEL_OWN_IDLE_MIN: 'полчаса' }), 30)
  // KERNEL_MEM speaks for ordinary environments; a GPU room keeps its sixteen.
  assert.equal(resourceValue('gpuRoomMemoryMb', { KERNEL_MEM: '2g' }), 16384)
  // One environment's own number is read from its own variable, and only there.
  assert.equal(perEnvironmentMemoryMb('base-gpu', { KERNEL_MEM_BASE_GPU: '12g' }), 12288)
  assert.equal(perEnvironmentMemoryMb('base-gpu', { KERNEL_MEM_BASE_GPU: '' }), null)
  assert.equal(perEnvironmentMemoryMb('base', { KERNEL_MEM_BASE_GPU: '12g' }), null)
})

/* ----------------------------------------------------------------- bounds */

test('a patch is refused by shape: not an object, an unknown field, a fraction, text', () => {
  for (const body of [null, [1], 'ownMax=5', 7]) assert.ok('error' in parseResourcePatch(body), JSON.stringify(body))
  const typo = parseResourcePatch({ ownmax: 5 })
  assert.ok('error' in typo && typo.error.includes('ownmax'), 'a typo must be named, not silently ignored')
  assert.ok('error' in parseResourcePatch({ ownMax: 1.5 }))
  assert.ok('error' in parseResourcePatch({ ownMax: '5' }))
  assert.ok('error' in parseResourcePatch({ roomMemoryMb: Number.NaN }))
  assert.deepEqual(parseResourcePatch({ ownMax: 5, ownMemoryMb: null }), { patch: { ownMax: 5, ownMemoryMb: null } })
  assert.deepEqual(parseResourcePatch({}), { patch: {} })
})

test('an out-of-range number is clamped into its bounds, the machine ones included', () => {
  updateResourceSettings(
    {
      ownMax: 100_000,
      roomPids: 10,
      ownPids: 1_000_000,
      ownIdleMin: -5,
      roomMemoryMb: 100,
      gpuRoomMemoryMb: 10_000_000,
      roomCpus: 99,
      ownCpus: 0,
      uploadMb: 0,
      sessionMb: 100_000,
    },
    MACHINE,
  )
  assert.equal(resourceValue('ownMax', {}), 500)
  assert.equal(resourceValue('roomPids', {}), 64)
  assert.equal(resourceValue('ownPids', {}), 32768)
  assert.equal(resourceValue('ownIdleMin', {}), 0)
  assert.equal(resourceValue('roomMemoryMb', {}), 512)
  assert.equal(resourceValue('gpuRoomMemoryMb', {}), MACHINE.memory.max)
  assert.equal(resourceValue('roomCpus', {}), 16)
  assert.equal(resourceValue('ownCpus', {}), 1)
  assert.equal(resourceValue('uploadMb', {}), 1)
  assert.equal(resourceValue('sessionMb', {}), 65536)
})

test('the file space never drops below one upload, and a refused patch saves nothing at all', () => {
  updateResourceSettings({ sessionMb: 100 }, MACHINE)
  assert.throws(
    () => updateResourceSettings({ uploadMb: 200, ownMax: 7 }, MACHINE),
    (err: unknown) => err instanceof ResourceRefusal && /100/.test(err.message) && /200/.test(err.message),
  )
  // One transaction: the unrelated field in the same patch did not land either.
  assert.equal(resourceValue('ownMax', {}), 60)
  assert.equal(uploadLimitBytes(), config.maxUploadBytes)

  // A consistent pair in one patch is fine.
  updateResourceSettings({ uploadMb: 200, sessionMb: 400 }, MACHINE)
  assert.equal(uploadLimitBytes(), 200 * MB)
  assert.equal(sessionLimitBytes(), 400 * MB)

  // Forgetting the file space is checked the same way: the environment's
  // ceiling would be below the saved upload.
  updateResourceSettings({ uploadMb: 2000, sessionMb: 4000 }, MACHINE)
  assert.throws(() => updateResourceSettings({ sessionMb: null }, MACHINE), ResourceRefusal)
  assert.equal(sessionLimitBytes(), 4000 * MB)
})

test('a hand-edited row that does not parse is ignored, and one out of bounds is clamped on read', () => {
  putSettingRow('resources.ownMax', 'lots')
  assert.equal(resourceValue('ownMax', {}), 60)
  putSettingRow('resources.ownMax', '9999')
  assert.equal(resourceValue('ownMax', {}), 500)
  putSettingRow('resources.ownMax', null)
})

/* -------------------------------------------------- personal-notebook chain */

test('the personal-notebook container: the class rule, then the instance default, then the room', () => {
  const id = 'res-own-chain'
  createSession(id, 'Цепочка', 'base')
  setSessionMemoryMb(id, 8192)
  setSessionCpus(id, 6)
  // Nothing named for personal notebooks: exactly the room's numbers.
  assert.deepEqual(kernelLimits(id, 'base', 'own'), { memoryMb: 8192, cpus: 6 })

  updateResourceSettings({ ownMemoryMb: 2048, ownCpus: 1 }, MACHINE)
  assert.deepEqual(kernelLimits(id, 'base', 'own'), { memoryMb: 2048, cpus: 1 })
  // The instance's personal-notebook default does not touch the room itself.
  assert.deepEqual(kernelLimits(id, 'base', 'room'), { memoryMb: 8192, cpus: 6 })

  setRules(id, { ...storedRules(id), ownMemoryMb: 3072, ownCpus: 2 })
  assert.deepEqual(kernelLimits(id, 'base', 'own'), { memoryMb: 3072, cpus: 2 })
  // A rule that names only memory leaves the cores to the instance default.
  setRules(id, { ...storedRules(id), ownMemoryMb: 3072, ownCpus: null })
  assert.deepEqual(kernelLimits(id, 'base', 'own'), { memoryMb: 3072, cpus: 1 })

  // And `docker run` is built from exactly these numbers.
  const args = runArgs({
    sessionId: id, env: 'base', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null,
    role: 'own', ...kernelLimits(id, 'base', 'own'),
  })
  assert.ok(args.includes('--memory=3072m') && args.includes('--cpus=1'), JSON.stringify(args))
})

test("a rules change gives a GPU class's personal-notebook container what docker run gave it, not four gigabytes", async () => {
  const id = 'res-gpu-own'
  createSession(id, 'Зрение на карте', 'base-gpu')
  const calls: string[][] = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  await withEnv({ KERNEL_MEM: '4g' }, async () => {
    const created = runArgs({
      sessionId: id, env: 'base-gpu', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null,
      role: 'own', ...kernelLimits(id, 'base-gpu', 'own'),
    })
    assert.ok(created.includes('--memory=16384m'), JSON.stringify(created))
    // The update used to fall back to KERNEL_MEM (or 4g) here, whatever the environment.
    assert.equal(await applyOwnLimits(id), 'applied')
    assert.equal(calls.length, 1, JSON.stringify(calls))
    assert.equal(calls[0].at(-1), `colloq-room-${id}-own`)
    assert.ok(calls[0].includes('--memory=16384m'), JSON.stringify(calls[0]))
  })
  // One environment's own number reaches both paths the same way.
  calls.length = 0
  await withEnv({ KERNEL_MEM_BASE_GPU: '12g' }, async () => {
    assert.equal(kernelLimits(id, 'base-gpu', 'own').memoryMb, 12288)
    assert.equal(await applyOwnLimits(id), 'applied')
    assert.ok(calls[0].includes('--memory=12288m'), JSON.stringify(calls[0]))
  })
})

/* ------------------------------------------------------------------- live */

test('every consumer reads the saved value at the moment of use, without a restart', () => {
  updateResourceSettings(
    { ownMax: 3, ownIdleMin: 0, roomPids: 1024, ownPids: 8192, roomCpus: 3, roomMemoryMb: 6144, gpuRoomMemoryMb: 20480 },
    MACHINE,
  )
  assert.equal(ownKernelMax(), 3)
  assert.equal(ownIdleMinutes(), 0)
  assert.equal(pidsLimit(), 1024)
  assert.equal(ownPidsLimit(), 8192)
  assert.equal(defaultCpus(), 3)
  assert.equal(defaultMemoryMb(false), 6144)
  assert.equal(defaultMemoryMb(true), 20480)
  assert.equal(memoryLimitMb('base'), 6144)
  assert.equal(memoryLimitMb('base-gpu'), 20480)
  const room = { sessionId: 'res-live-args', env: 'base', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null }
  const args = runArgs(room)
  for (const flag of ['--pids-limit=1024', '--memory=6144m', '--memory-swap=6144m', '--cpus=3', 'OMP_NUM_THREADS=3']) {
    assert.ok(args.includes(flag), `${flag}: ${JSON.stringify(args)}`)
  }
  assert.ok(runArgs({ ...room, role: 'own' }).includes('--pids-limit=8192'))

  forgetAll()
  assert.equal(ownKernelMax(), 60)
  assert.ok(runArgs(room).includes('--pids-limit=512'))
})

test('the upload ceiling follows the panel on the very next request', async () => {
  const id = 'res-upload'
  createSession(id, 'Загрузки', null)
  upsertParticipant({ id: 'p_host', sessionId: id, name: 'Преподаватель', avatar: null, role: 'host', tokenHost: true })
  const token = signToken({ sessionId: id, participantId: 'p_host', role: 'host' })
  const upload = async (name: string, bytes: number): Promise<globalThis.Response> => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.alloc(bytes, 97)]), name)
    return fetch(`${base}/api/sessions/${id}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
  }

  updateResourceSettings({ uploadMb: 1 }, MACHINE)
  const refused = await upload('big.csv', 1.5 * MB)
  assert.equal(refused.status, 413)
  assert.match(((await refused.json()) as { error: string }).error, /\b1\b/)
  // The creation form prints the same number, read per request.
  const state = (await (await call('GET', '/api/admin/state')).json()) as InstanceState
  assert.equal(state.maxUploadBytes, MB)

  updateResourceSettings({ uploadMb: null }, MACHINE)
  const taken = await upload('big.csv', 1.5 * MB)
  assert.ok(taken.ok, `the default ceiling did not come back: ${taken.status}`)
})

/* ------------------------------------------------------------------ door */

test('staff read the resources, only the owner writes them', async () => {
  assert.equal((await call('GET', '/api/admin/resources')).status, 401)

  const read = await call('GET', '/api/admin/resources', { cookie: teacherCookie })
  assert.equal(read.status, 200)
  assert.equal(read.headers.get('cache-control'), 'no-store')
  const body = (await read.json()) as ResourceSettingsResponse
  assert.deepEqual(
    [body.settings.ownMax.value, body.settings.ownMax.source, body.settings.ownMax.appliesTo],
    [60, 'default', 'live'],
  )
  assert.equal(body.settings.roomMemoryMb.appliesTo, 'new-containers')
  assert.equal(body.settings.roomMemoryMb.dockerOnly, true)
  assert.equal(body.settings.uploadMb.dockerOnly, false)
  assert.equal(body.backend, 'test')
  assert.deepEqual(body.bounds.ownMax, { min: 1, max: 500 })
  // Memory and cores are bounded by the machine, the same numbers the class form gets.
  assert.deepEqual(body.bounds.roomMemoryMb, { min: body.machine.limits.min, max: body.machine.limits.max })
  assert.deepEqual(body.bounds.roomCpus, body.machine.limits.cpus)
  assert.deepEqual(body.perEnvironmentMemory, [])

  const refused = await call('PUT', '/api/admin/resources', { cookie: teacherCookie, body: { ownMax: 5 } })
  assert.equal(refused.status, 403)
  const why = (await refused.json()) as { error: string; reason: string }
  assert.equal(why.reason, 'forbidden')
  assert.match(why.error, /ресурсы сервера|instance resources/, 'the refusal names what was refused')
  assert.equal(resourceValue('ownMax'), 60, "a teacher's write landed")

  const saved = await call('PUT', '/api/admin/resources', { cookie: ownerCookie, body: { ownMax: 5, roomCpus: 999 } })
  assert.equal(saved.status, 200)
  const after = (await saved.json()) as ResourceSettingsResponse
  assert.deepEqual([after.settings.ownMax.value, after.settings.ownMax.source], [5, 'saved'])
  // The answer shows what the number was clamped to, so the panel never guesses.
  assert.equal(after.settings.roomCpus.value, after.bounds.roomCpus.max)
  assert.equal(ownKernelMax(), 5)

  for (const bad of [{ ownMax: 'five' }, { ownmax: 5 }, { uploadMb: 2048 }]) {
    const res = await call('PUT', '/api/admin/resources', { cookie: ownerCookie, body: bad })
    assert.equal(res.status, 400, JSON.stringify(bad))
    assert.equal(((await res.json()) as { reason: string }).reason, 'invalid')
  }

  const reset = await call('PUT', '/api/admin/resources', { cookie: ownerCookie, body: { ownMax: null, roomCpus: null } })
  assert.equal(((await reset.json()) as ResourceSettingsResponse).settings.ownMax.source, 'default')
})

test('new classes are sized and labelled by the instance defaults, explicit ones keep their numbers', async () => {
  const saved = await call('PUT', '/api/admin/resources', {
    cookie: ownerCookie,
    body: { roomMemoryMb: 6144, gpuRoomMemoryMb: 24576, roomCpus: 4 },
  })
  assert.equal(saved.status, 200)
  // The class form reads its labels here; the PUT dropped the ten-second cache.
  const resources = (await (await call('GET', '/api/instance/resources', { cookie: ownerCookie })).json()) as InstanceResources
  assert.equal(resources.kernel.defaultMemoryMb, 6144)
  assert.equal(resources.kernel.gpuDefaultMemoryMb, 24576)
  assert.equal(resources.kernel.defaultCpus, 4)
  assert.equal(resources.kernel.perEnvironment.base?.memoryMb, 6144)
  assert.equal(resources.kernel.perEnvironment['base-gpu']?.memoryMb, 24576)

  const plain = await call('POST', '/api/admin/seminars', { cookie: ownerCookie, body: { name: 'По умолчанию', environment: 'base' } })
  const own = await call('POST', '/api/admin/seminars', { cookie: ownerCookie, body: { name: 'Своё', environment: 'base', memoryMb: 2048, cpus: 1 } })
  const plainId = ((await plain.json()) as { id: string }).id
  const ownId = ((await own.json()) as { id: string }).id
  assert.deepEqual(kernelLimits(plainId, 'base', 'room'), { memoryMb: 6144, cpus: 4 })
  assert.deepEqual(kernelLimits(ownId, 'base', 'room'), { memoryMb: 2048, cpus: 1 })
})

/* ---------------------------------------------------------------- budget */

/**
 * The competitions segment is read from the competitions side's own settings
 * (routes/admin-resources.ts · competitionShare): either all three numbers,
 * slots times one submission's defaults, or all three unknown.
 */
function assertCompetitionShare(share: ResourceSettingsResponse['budget']['competitions']): void {
  if (share.slots === null) {
    assert.deepEqual(share, { slots: null, memoryMb: null, cpus: null })
    return
  }
  assert.ok(Number.isInteger(share.slots) && share.slots >= 1, JSON.stringify(share))
  assert.ok(share.memoryMb !== null && share.memoryMb > 0 && share.memoryMb % share.slots === 0, JSON.stringify(share))
  assert.ok(share.cpus !== null && share.cpus > 0 && share.cpus % share.slots === 0, JSON.stringify(share))
}

/** Docker, faked at the process boundary: the pool and resources.ts spawn it. */
function fakeDocker(answer: (args: string[]) => { code: number; out: string }): () => void {
  const spawn = cp.spawn
  const exists = fs.existsSync
  const env = { ...process.env }
  Object.assign(process.env, { KERNEL_BACKEND: 'docker', KERNEL_ISOLATION: 'required', KERNEL_NETWORK: 'budget-network' })
  // "The server runs in a container": the room network is then KERNEL_NETWORK, asked of the fake.
  fs.existsSync = ((p: fs.PathLike) => p === '/.dockerenv' || exists(p)) as typeof fs.existsSync
  cp.spawn = ((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    const result = command === 'docker' ? answer(args) : { code: 1, out: '' }
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(result.out))
      child.emit('close', result.code)
    })
    return child
  }) as unknown as typeof cp.spawn
  syncBuiltinESMExports()
  return () => {
    cp.spawn = spawn
    fs.existsSync = exists
    syncBuiltinESMExports()
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env)
  }
}

test('the budget counts running containers by the limits docker holds them to', async () => {
  // On an ordinary environment whatever the instance's active one is.
  createSession('bud-a', 'Бюджет А', 'base')
  createSession('bud-b', 'Бюджет Б', 'base')
  const sizes: Record<string, string> = {
    'colloq-room-bud-a': `${8192 * MB} 4000000000`,
    'colloq-room-bud-a-own': `${2048 * MB} 1000000000`,
    // Docker says nothing useful: counted by the numbers it would be started with.
    'colloq-room-bud-b': '0 0',
  }
  const restore = fakeDocker((args) => {
    if (args[0] === 'version') return { code: 0, out: '28.0.0' }
    if (args[0] === 'network') return { code: 0, out: 'network-id' }
    if (args[0] === 'ps') {
      return {
        code: 0,
        out: ['bud-a\t\trunning\troom', 'bud-a\t\trunning\town', 'bud-b\t\trunning\t', 'bud-c\t\texited\troom'].join('\n'),
      }
    }
    if (args[0] === 'inspect' && args.at(-1)!.includes('HostConfig.Memory')) return { code: 0, out: sizes[args[1]!] ?? '0 0' }
    return { code: 1, out: 'Error: No such object' }
  })
  useDockerInfo(async () => ({ code: 0, out: '12514811904 10' }))
  try {
    forgetResources()
    const res = await call('GET', '/api/admin/resources', { cookie: ownerCookie })
    assert.equal(res.status, 200)
    const { budget, machine, backend } = (await res.json()) as ResourceSettingsResponse
    assert.equal(backend, 'docker')
    // The stopped container holds nothing; the unlabelled one is a room's.
    assert.deepEqual(budget.rooms, { count: 2, memoryMb: 8192 + 4096, cpus: 4 + 2 })
    assert.deepEqual(budget.own, { count: 1, memoryMb: 2048, cpus: 1 })
    assertCompetitionShare(budget.competitions)
    assert.equal(budget.totalMb, machine.memory.totalMb)
    assert.equal(budget.totalCpus, machine.cpus)
    assert.equal(budget.reserveMb, 1024)
    const promised = 8192 + 4096 + 2048 + (budget.competitions.memoryMb ?? 0)
    assert.equal(budget.freeMb, Math.max(0, budget.totalMb - 1024 - promised))
    assert.equal(budget.overcommitted, promised > budget.totalMb - 1024)
    assert.equal(budget.complete, true)
  } finally {
    useDockerInfo(null)
    restore()
    forgetResources()
  }
})

test('under the test backend no kernel runs: only the reserve and the competition slots are promised', async () => {
  const { budget } = (await (await call('GET', '/api/admin/resources', { cookie: ownerCookie })).json()) as ResourceSettingsResponse
  assert.deepEqual(budget.rooms, { count: 0, memoryMb: 0, cpus: 0 })
  assert.deepEqual(budget.own, { count: 0, memoryMb: 0, cpus: 0 })
  assertCompetitionShare(budget.competitions)
  const promised = budget.competitions.memoryMb ?? 0
  assert.equal(budget.freeMb, Math.max(0, budget.totalMb - budget.reserveMb - promised))
  assert.equal(budget.overcommitted, promised > budget.totalMb - budget.reserveMb)
  assert.equal(budget.complete, true)
})
