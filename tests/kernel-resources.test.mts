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
import { createSession, db, sessionMemoryMb, setSessionMemoryMb } from '../server/src/db.js'
import {
  applyMemoryLimit,
  memSpec,
  parseMemMb,
  runArgs,
  useDockerForLimits,
} from '../server/src/kernel/pool.js'
import { forgetResources, machineResources, memoryBounds, parseGpus, readMemoryInput } from '../server/src/kernel/resources.js'

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
  const owner = oldestOwner() ?? createTeacher({ name: 'Владелец', email: 'res.owner@hse.ru', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  cookie = mintCookie(owner)
})

after(() => {
  useDockerForLimits(null)
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
  assert.ok(body.memory.availableMb > 0)
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
  assert.equal(listed.alive, false)
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
  const room = { sessionId: 'res-args', mount: '/w/res-args', network: '', gpu: null }
  // Умолчание окружения — то же, что и было.
  assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=4g'))
  const own = runArgs({ ...room, env: 'base', memoryMb: 6144 })
  assert.ok(own.includes('--memory=6144m'), JSON.stringify(own))
  assert.ok(!own.includes('--memory=4g'), 'умолчание окружения осталось рядом со своим числом')
  // Swap ровно по памяти: иначе упёршееся ядро уходит на диск вместо честной
  // смерти, и комната стоит минутами.
  assert.ok(own.includes('--memory-swap=6144m'))
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
})
