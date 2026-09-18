/**
 * Сколько машины достаётся комнате — и кто это решает.
 *
 * 13.09 ядро семинара убили по памяти шестнадцать раз подряд: лимит был один
 * на все комнаты, жил в переменной окружения и нигде в продукте не
 * показывался. Здесь закреплена вся починка целиком — числа о машине, своё
 * число у комнаты, границы, в которых его принимают, и `docker update`,
 * который применяет его к живой комнате, не убивая её Python.
 *
 * Настоящего docker в сюите нет (см. `_env.mts`), поэтому он подделывается
 * ровно там, где без него нельзя.
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

/* ------------------------------------------------------------- разбор */

test('«4g», «512m» и «2048» — одно и то же число, и обратно тоже', () => {
  assert.equal(parseMemMb('4g'), 4096)
  assert.equal(parseMemMb('512m'), 512)
  assert.equal(parseMemMb('16G'), 16384)
  assert.equal(parseMemMb('1073741824'), 1024)
  // Мусор — это «не знаю», а не ноль: ноль уехал бы в `--memory=0m`.
  assert.equal(parseMemMb('много'), null)
  assert.equal(parseMemMb(''), null)
  assert.equal(memSpec(6144), '6144m')
})

test('«12514811904 10» — это память и ядра демона docker, а мусор — «не знаю»', () => {
  assert.deepEqual(parseDaemonInfo('12514811904 10'), { totalMb: 11935, cpus: 10 })
  // Ядер демон может и не назвать — память всё равно ответ.
  assert.deepEqual(parseDaemonInfo('12514811904'), { totalMb: 11935, cpus: 0 })
  assert.equal(parseDaemonInfo(''), null)
  assert.equal(parseDaemonInfo('<no value> 10'), null)
  assert.equal(parseDaemonInfo('0 10'), null)
})

/**
 * 18.09 форма занятия на Маке с 36 ГБ сказала «свободно 0,5 ГБ» и покрасила
 * поле предупреждением на любом лимите. Две неправды разом: `os.freemem()` на
 * macOS считает свободной только память, не занятую НИЧЕМ, а ядра комнат на
 * этой машине живут не в ней, а в виртуалке колимы с двенадцатью гигабайтами.
 */
test('память Мака — не потолок комнаты: его ставит демон docker', () => {
  const vm = memoryPicture({
    daemonTotalMb: 11_935,
    hostTotalMb: 36_864,
    hostAvailableMb: null,
    takenMb: 4096,
  })
  assert.equal(vm.source, 'docker')
  assert.equal(vm.totalMb, 11_935, 'потолком названа память Мака, а не докера')
  // Гигабайт самому демону — то же правило, что в границах, — и память,
  // которую уже держат живые комнаты.
  assert.equal(vm.availableMb, 11_935 - 1024 - 4096)

  // Нативный демон на Linux — та же машина: тогда числа ядра, а не арифметика.
  const native = memoryPicture({
    daemonTotalMb: 73_700,
    hostTotalMb: 73_728,
    hostAvailableMb: 51_200,
    takenMb: 8192,
  })
  assert.equal(native.source, 'host')
  assert.equal(native.totalMb, 73_728)
  assert.equal(native.availableMb, 51_200)

  // Докера не видно — остаётся машина; свободного у macOS не спросить, и
  // честный ответ здесь `null`, а не пугающий ноль с половиной.
  assert.deepEqual(
    memoryPicture({ daemonTotalMb: null, hostTotalMb: 36_864, hostAvailableMb: null, takenMb: 0 }),
    { totalMb: 36_864, availableMb: null, source: 'host' },
  )

  // Роздано больше, чем есть: «свободно 0», а не отрицательное число.
  assert.equal(
    memoryPicture({ daemonTotalMb: 8192, hostTotalMb: 36_864, hostAvailableMb: null, takenMb: 16_384 })
      .availableMb,
    0,
  )
})

test('границы поля считаются по демону docker, а не по памяти машины', async () => {
  const previous = process.env.KERNEL_BACKEND
  process.env.KERNEL_BACKEND = 'docker'
  useDockerInfo(async () => ({ code: 0, out: '12514811904 10' }))
  try {
    forgetResources()
    assert.deepEqual(await readDaemon(), { totalMb: 11_935, cpus: 10 })
    assert.equal(memoryBounds().max, 11_935 - 1024)
    // Шестнадцать гигабайт в двенадцатигигабайтной виртуалке — отказ здесь и
    // сейчас, а не ядро, убитое по памяти на первой тяжёлой ячейке.
    assert.deepEqual(readMemoryInput(16_384), { ok: false, error: 'range' })
    assert.equal(machineCpus(), 10, 'ядра посчитаны по машине, а не по докеру')
    assert.equal(cpuBounds().max, 10)
    assert.deepEqual(readCpuInput(12), { ok: false, error: 'range' })
  } finally {
    useDockerInfo(null)
    if (previous === undefined) delete process.env.KERNEL_BACKEND
    else process.env.KERNEL_BACKEND = previous
    forgetResources()
  }
})

test('неотвечающий демон — не отказ: остаются числа машины', async () => {
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

test('строки nvidia-smi читаются по карте на строку, а мусор пропускается', () => {
  const cards = parseGpus('0, NVIDIA GeForce RTX 3090, 24576\n\nмусор\n1, NVIDIA A100, 81920\n')
  assert.deepEqual(cards, [
    { index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMb: 24576 },
    { index: 1, name: 'NVIDIA A100', memoryMb: 81920 },
  ])
})

/* ------------------------------------------------------- дверь ресурсов */

test('описание машины — только штату, и в нём есть всё, чем подписано поле памяти', async () => {
  const anonymous = await call('GET', '/api/instance/resources')
  assert.equal(anonymous.status, 401, 'описание машины отдали кому попало')

  const res = await call('GET', '/api/instance/resources', { cookie })
  assert.equal(res.status, 200)
  const body = (await res.json()) as InstanceResources
  // Под тестовым бэкендом числа выдуманные — но правдоподобные и полные,
  // иначе форму занятия нельзя было бы ни посмотреть, ни проверить.
  assert.ok(body.memory.totalMb > 0)
  assert.ok((body.memory.availableMb ?? 0) > 0)
  // Чьи это числа — сказано вслух: подпись под полем на Маке обязана назвать
  // виртуалку докера, а не машину, которой эти гигабайты не принадлежат.
  assert.ok(body.memory.source === 'host' || body.memory.source === 'docker')
  assert.ok(body.cpus > 0)
  assert.ok(Array.isArray(body.gpus))
  assert.ok(body.kernel.defaultMemoryMb >= 512)
  assert.ok(body.kernel.gpuDefaultMemoryMb >= body.kernel.defaultMemoryMb)
  assert.equal(typeof body.kernel.perEnvironment, 'object')
  assert.ok(Array.isArray(body.rooms))
  // Границы едут с числами: вторая копия правила «оставь машине гигабайт» в
  // браузере разошлась бы с серверной на первом же её изменении.
  assert.equal(body.limits.min, 512)
  assert.equal(body.limits.max, body.memory.totalMb - 1024)
  // Ядра: умолчание инстанса и свои границы рядом с памятью.
  assert.ok(body.kernel.defaultCpus >= 1)
  assert.equal(body.limits.cpus.min, 1)
  assert.equal(body.limits.cpus.max, body.cpus)
})

test('комната со своим числом попадает в список тех, кто держит память', async () => {
  const room = 'res-listed'
  createSession(room, 'Зрение', null)
  setSessionMemoryMb(room, 6144)
  forgetResources()
  const body = await machineResources()
  const listed = body.rooms.find((r) => r.id === room)
  assert.ok(listed, 'комната с заданным лимитом не названа')
  assert.equal(listed.memoryMb, 6144)
  assert.equal(listed.cpus, 2, 'комната без своих ядер показана не умолчанием инстанса')
  assert.equal(listed.alive, false)

  // Комната, которой задали ТОЛЬКО ядра, тоже держит машину — и тоже названа.
  const cores = 'res-cores'
  createSession(cores, 'Потоки', null)
  setSessionCpus(cores, 6)
  forgetResources()
  const again = await machineResources()
  assert.equal(again.rooms.find((r) => r.id === cores)?.cpus, 6)
  forgetResources()
})

/* ----------------------------------------------------------- границы */

test('число принимают только целым и только в границах машины', () => {
  const { min, max } = memoryBounds()
  assert.equal(min, 512)
  assert.deepEqual(readMemoryInput(4096), { ok: true, mb: 4096 })
  // null — законный ответ: так комнату возвращают к умолчанию окружения.
  assert.deepEqual(readMemoryInput(null), { ok: true, mb: null })
  assert.deepEqual(readMemoryInput(undefined), { ok: true, mb: null })
  assert.deepEqual(readMemoryInput('6g'), { ok: false, error: 'type' })
  assert.deepEqual(readMemoryInput(1024.5), { ok: false, error: 'type' })
  assert.deepEqual(readMemoryInput(256), { ok: false, error: 'range' })
  assert.deepEqual(readMemoryInput(max + 1), { ok: false, error: 'range' })
})

test('ядер принимают от одного до всех, что есть на машине', () => {
  const { min, max } = cpuBounds()
  assert.equal(min, 1)
  assert.ok(max >= 1)
  assert.deepEqual(readCpuInput(4), { ok: true, cpus: 4 })
  // null — «как у инстанса», тем же правилом, что и у памяти.
  assert.deepEqual(readCpuInput(null), { ok: true, cpus: null })
  assert.deepEqual(readCpuInput(undefined), { ok: true, cpus: null })
  assert.deepEqual(readCpuInput('4'), { ok: false, error: 'type' })
  assert.deepEqual(readCpuInput(1.5), { ok: false, error: 'type' })
  assert.deepEqual(readCpuInput(0), { ok: false, error: 'range' })
  assert.deepEqual(readCpuInput(max + 1), { ok: false, error: 'range' })
})

test('панель заводит комнату с её ядрами и меняет их число', async () => {
  const created = await call('POST', '/api/admin/seminars', {
    cookie,
    body: { name: 'Численные методы', cpus: 4 },
  })
  assert.equal(created.status, 201)
  const seminar = (await created.json()) as { id: string; cpus: number | null }
  assert.equal(seminar.cpus, 4, 'число ядер не доехало до карточки')
  assert.equal(sessionCpus(seminar.id), 4)

  const raised = await call('PATCH', `/api/admin/seminars/${seminar.id}`, {
    cookie,
    body: { cpus: 6 },
  })
  assert.equal(raised.status, 200)
  assert.equal(((await raised.json()) as { cpus: number | null }).cpus, 6)
  assert.equal(sessionCpus(seminar.id), 6)

  // null возвращает комнату к умолчанию инстанса.
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

test('сброс ядер в панели возвращает живому контейнеру лимит инстанса', async () => {
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
    assert.deepEqual(calls, [['update', '--cpus=1.5', `colloq-room-${id}`]])
  } finally {
    useDockerForLimits(null)
    if (previous === undefined) delete process.env.KERNEL_CPUS
    else process.env.KERNEL_CPUS = previous
  }
})

test('панель заводит комнату с её памятью и меняет число, не трогая остального', async () => {
  const created = await call('POST', '/api/admin/seminars', {
    cookie,
    body: { name: 'Компьютерное зрение', memoryMb: 6144 },
  })
  assert.equal(created.status, 201)
  const seminar = (await created.json()) as { id: string; memoryMb: number | null; name: string }
  assert.equal(seminar.memoryMb, 6144, 'число не доехало до карточки')
  assert.equal(sessionMemoryMb(seminar.id), 6144)

  const raised = await call('PATCH', `/api/admin/seminars/${seminar.id}`, {
    cookie,
    body: { memoryMb: 8192 },
  })
  assert.equal(raised.status, 200)
  assert.equal(((await raised.json()) as { memoryMb: number | null }).memoryMb, 8192)
  assert.equal(sessionMemoryMb(seminar.id), 8192)

  // null возвращает комнату к умолчанию окружения — без второго поля рядом.
  const reset = await call('PATCH', `/api/admin/seminars/${seminar.id}`, {
    cookie,
    body: { memoryMb: null },
  })
  assert.equal(reset.status, 200)
  assert.equal(sessionMemoryMb(seminar.id), null)
})

test('отказ называет границы числами, а не «неверное значение»', async () => {
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

test('скриптовая дверь не даёт гостю раздавать память машины', async () => {
  // Без печенья штата: на открытом инстансе эту дверь толкает кто угодно.
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

/* ------------------------------------------------------ аргументы docker */

test('своё число комнаты сильнее умолчания окружения', () => {
  const room = { sessionId: 'res-args', mount: '/w/res-args', network: 'colloq-rooms', publish: true, gpu: null }
  // Умолчание окружения — то же, что и было.
  assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=4g'))
  const own = runArgs({ ...room, env: 'base', memoryMb: 6144 })
  assert.ok(own.includes('--memory=6144m'), JSON.stringify(own))
  assert.ok(!own.includes('--memory=4g'), 'умолчание окружения осталось рядом со своим числом')
  // Swap ровно по памяти: иначе упёршееся ядро уходит на диск вместо честной
  // смерти, и комната стоит минутами.
  assert.ok(own.includes('--memory-swap=6144m'))
})

test('своё число ядер уезжает и в --cpus, и в потоки численных библиотек', () => {
  const room = { sessionId: 'res-cpu-args', mount: '/w/res-cpu-args', network: 'colloq-rooms', publish: true, gpu: null, env: 'base' }
  // Умолчание инстанса — то же, что и было: два ядра и два потока.
  const plain = runArgs(room)
  assert.ok(plain.includes('--cpus=2'), JSON.stringify(plain))
  assert.ok(plain.includes('OMP_NUM_THREADS=2'))

  const own = runArgs({ ...room, cpus: 6 })
  assert.ok(own.includes('--cpus=6'), JSON.stringify(own))
  assert.ok(!own.includes('--cpus=2'), 'умолчание инстанса осталось рядом со своим числом')
  /*
   * Главное здесь — вторая половина: `os.cpu_count()` внутри контейнера
   * показывает ядра ХОСТА, и комната с шестью выданными поднимала бы по
   * тридцать потоков numpy на них, считая медленнее, чем в один.
   */
  for (const name of ['OMP', 'MKL', 'OPENBLAS', 'NUMEXPR']) {
    assert.ok(own.includes(`${name}_NUM_THREADS=6`), `${name} остался с числом инстанса`)
  }
})

test('живой комнате ядра меняют docker update --cpus', async () => {
  const calls: Array<string[]> = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  assert.equal(await applyCpuLimit('res-live-cpu', 6), 'applied')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'update')
  assert.ok(calls[0].includes('--cpus=6'), JSON.stringify(calls[0]))
  assert.ok(calls[0].includes('colloq-room-res-live-cpu'), JSON.stringify(calls[0]))
  useDockerForLimits(null)
})

test('сброс ядер под docker — это docker update к KERNEL_CPUS, прямо живому контейнеру', async () => {
  // Маршрут теперь шлёт `null` как есть: чьё умолчание, решает пул.
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

test('под брокером ядра живой комнате меняет PATCH брокера, а не ранний pending', async () => {
  /*
   * До 18.09 пул отвечал здесь `pending`, не спросив брокера: подсказка
   * обещала ядра «после перезапуска ядра», а на деле Pod сносился на
   * следующем подъёме — вместе со всеми переменными семинара.
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
  // Сюита гасит изоляцию для тестового бэкенда; брокер без неё не заговорит.
  delete process.env.KERNEL_ISOLATION
  process.env.KERNEL_BACKEND = 'broker'
  process.env.KERNEL_RUNTIME_URL = `http://127.0.0.1:${(broker.address() as { port: number }).port}`
  process.env.KERNEL_RUNTIME_TOKEN = 'a'.repeat(64)
  try {
    assert.equal(await applyCpuLimit('res-broker-cpu', 6), 'applied')
    assert.deepEqual(seen.map((r) => [r.method, JSON.parse(r.body)]), [['PATCH', { cpus: 6 }]])
    // Сброс едет брокеру `null`-ом: умолчание у него своё, не KERNEL_CPUS веба.
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

test('живой комнате память меняют docker update, обоими флагами сразу', async () => {
  const calls: Array<string[]> = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  assert.equal(await applyMemoryLimit('res-live', 8192), 'applied')
  assert.equal(calls.length, 1)
  const args = calls[0]
  assert.equal(args[0], 'update')
  /*
   * Оба флага вместе, и это не перестраховка: `--memory` без `--memory-swap`
   * docker отвергает всякий раз, когда новая память больше старого swap, — то
   * есть ровно тогда, когда лимит поднимают после смерти ядра по памяти.
   */
  assert.ok(args.includes('--memory=8192m'), JSON.stringify(args))
  assert.ok(args.includes('--memory-swap=8192m'), JSON.stringify(args))
  // Контейнер спрашивается по имени комнаты, а не по чему-то угаданному.
  assert.ok(args.includes('colloq-room-res-live'), JSON.stringify(args))
  useDockerForLimits(null)
})

test('комнаты без контейнера — не ошибка: число возьмёт следующий пуск', async () => {
  useDockerForLimits(async () => ({ code: 1, out: 'Error: No such container: colloq-room-res-cold' }))
  assert.equal(await applyMemoryLimit('res-cold', 4096), 'pending')
  useDockerForLimits(async () => ({ code: 1, out: 'permission denied while trying to connect' }))
  assert.equal(await applyMemoryLimit('res-cold', 4096), 'failed')
  useDockerForLimits(null)
})

test('сброс памяти к умолчанию под docker ждёт следующего пуска и демона не зовёт', async () => {
  // Маршрут шлёт `null` ради брокера; docker-путь обязан остаться прежним.
  const calls: Array<string[]> = []
  useDockerForLimits(async (args) => {
    calls.push(args)
    return { code: 0, out: '' }
  })
  assert.equal(await applyMemoryLimit('res-reset', null), 'pending')
  assert.equal(calls.length, 0)
  useDockerForLimits(null)
})

/* ------------------------------------------------------------ миграция */

test('столбец памяти заводится один раз и переживает второй запуск', () => {
  const columns = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).filter(
    (c) => c.name === 'memory_mb',
  )
  assert.equal(columns.length, 1, 'столбца нет или их два')
  /*
   * И ровно поэтому он заводится под охраной `table_info`: у SQLite нет ADD
   * COLUMN IF NOT EXISTS, и безусловный ALTER уронил бы сервер на втором
   * запуске — не на том, где эту строку писали.
   */
  assert.throws(() => db.exec('ALTER TABLE sessions ADD COLUMN memory_mb INTEGER'))

  const cores = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).filter(
    (c) => c.name === 'cpus',
  )
  assert.equal(cores.length, 1, 'столбца ядер нет или их два')
  assert.throws(() => db.exec('ALTER TABLE sessions ADD COLUMN cpus INTEGER'))
})
