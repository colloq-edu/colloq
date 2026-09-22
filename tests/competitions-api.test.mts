/**
 * Двери панели к соревнованиям: право, отказы и то, что наружу не уезжает.
 *
 * Проверяется то, что ломается тихо и дорого. Открытое соревнование, у
 * которого базовое решение не проходит, — это сто человек, ищущих ошибку у
 * себя. Адрес, занятый вторым соревнованием, — это розданная классу ссылка,
 * ведущая не туда. Файл ответов, уехавший наружу хоть одной дверью, — это
 * конец соревнования, причём незаметный: лидерборд после такого выглядит
 * ровно так же.
 *
 * Отдельно и подробно — чистые решения панели (`competitions/panel.ts`) и
 * разбор того, что кладут в форму (`competitions/intake.ts`): у них есть
 * правильный ответ, и проверять его через HTTP значит проверять заодно
 * печенье, маршрутизацию и JSON.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { LIMITS } from '../shared/competitions.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { app } from '../server/src/app.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  finishRun,
  getCompetition,
  getSubmission,
  listFiles,
  queueRow,
  startRun,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import path from 'node:path'
import {
  competitionsFs,
  putSubmissionNotebook,
  readOpenFile,
  readSecretFile,
  resultDir,
} from '../server/src/competitions/storage.js'
import {
  executedToday,
  fairOrder,
  medianOf,
  openRefusal,
  parseCompetitionInput,
  rescorable,
  waitEtas,
  withoutBaseline,
  type Readiness,
} from '../server/src/competitions/panel.js'
import { baseName, columnsLine, csvShape, notebookCells } from '../server/src/competitions/intake.js'
import type { CompetitionView } from '../shared/competitions-api.js'

/* --------------------------------------------------- чистые решения панели */

const READY: Readiness = {
  openFiles: 3,
  hiddenFiles: 1,
  metricCode: 'def score(a, b): return 0.0',
  baseline: true,
  baselineState: 'scored',
  privateRelease: 'auto',
  deadlineAt: Date.UTC(2026, 8, 27, 20, 59),
}

test('открывать нечего, пока чего-то не хватает, и отказ называет что', () => {
  assert.equal(openRefusal(READY), null)
  assert.equal(openRefusal({ ...READY, openFiles: 0 }), 'noData')
  assert.equal(openRefusal({ ...READY, hiddenFiles: 0 }), 'noSolution')
  assert.equal(openRefusal({ ...READY, metricCode: '   \n' }), 'noMetric')
  assert.equal(openRefusal({ ...READY, baseline: false }), 'noBaseline')
  // Загружена — не значит проверена: ровно эта разница и держит дверь.
  assert.equal(openRefusal({ ...READY, baselineState: null }), 'baselineNotChecked')
  assert.equal(openRefusal({ ...READY, baselineState: 'notebookFailed' }), 'baselineNotChecked')
  assert.equal(openRefusal({ ...READY, deadlineAt: null }), 'noDeadline')
  // Открывать приватный лидерборд рукой — это и есть согласие жить без даты.
  assert.equal(openRefusal({ ...READY, deadlineAt: null, privateRelease: 'manual' }), null)
})

test('порядок отказов — порядок секций формы, сверху вниз', () => {
  // Нет вообще ничего: человек должен услышать про первую секцию, а не про
  // последнюю, иначе он чинит форму снизу вверх.
  assert.equal(
    openRefusal({
      openFiles: 0,
      hiddenFiles: 0,
      metricCode: '',
      baseline: false,
      baselineState: null,
      privateRelease: 'auto',
      deadlineAt: null,
    }),
    'noData',
  )
})

test('пересчитать можно то, что оставило ответ', () => {
  assert.equal(rescorable('scored'), true)
  // Отвергнутый метрикой ответ после правки кода может оказаться принятым.
  assert.equal(rescorable('rejected'), true)
  assert.equal(rescorable('metricFailed'), true)
  for (const state of ['queued', 'running', 'notebookFailed', 'timedOut', 'outOfMemory', 'cancelled'] as const) {
    assert.equal(rescorable(state), false, state)
  }
})

test('оценка ожидания считается по местам, а не умножением номера', () => {
  // Без среднего оценивать нечем — и «≈ 0 мин» было бы обещанием.
  assert.deepEqual(waitEtas(2, { runningLeftMs: [], averageMs: null, slots: 1 }), [null, null])
  assert.deepEqual(
    waitEtas(3, { runningLeftMs: [60_000], averageMs: 120_000, slots: 1 }),
    [60_000, 180_000, 300_000],
  )
  // Два места — пятый ждёт вдвое меньше, чем при одном.
  assert.deepEqual(
    waitEtas(4, { runningLeftMs: [0, 0], averageMs: 100, slots: 2 }),
    [0, 0, 100, 100],
  )
  assert.deepEqual(waitEtas(0, { runningLeftMs: [], averageMs: 100, slots: 1 }), [])
})

test('«сегодня исполнено» считает только законченное и только за сутки', () => {
  const now = Date.UTC(2026, 8, 20, 18)
  const since = Date.UTC(2026, 8, 20, 0)
  const stats = executedToday(
    [
      { acceptedAt: since + 1000, state: 'scored', durationMs: 120_000 },
      { acceptedAt: since + 2000, state: 'notebookFailed', durationMs: 60_000 },
      // Ещё идёт — не «исполнено».
      { acceptedAt: since + 3000, state: 'running', durationMs: null },
      // Вчерашняя.
      { acceptedAt: since - 60_000, state: 'scored', durationMs: 999_000 },
    ],
    since,
    now,
  )
  assert.equal(stats.done, 2)
  assert.equal(stats.averageMs, 90_000)
  assert.equal(executedToday([], since, now).averageMs, null)
})

test('медиана — то, что показывают в сводке', () => {
  assert.equal(medianOf([]), null)
  assert.equal(medianOf([5]), 5)
  assert.equal(medianOf([3, 1, 2]), 2)
  assert.equal(medianOf([1, 2, 3, 4]), 3)
})

test('сводка не считает базовое решение ни посылкой, ни участником', () => {
  const counts = {
    submissions: 143,
    scored: 101,
    notebookFailed: 27,
    rejected: 9,
    timedOut: 6,
    outOfMemory: 0,
    metricFailed: 0,
    cancelled: 0,
    entrants: 29,
    bestPublic: 0.0587,
  }
  const trimmed = withoutBaseline(
    counts,
    [{ state: 'scored' }, { state: 'notebookFailed' }],
    0.0412,
  )
  assert.equal(trimmed.submissions, 141)
  assert.equal(trimmed.scored, 100)
  assert.equal(trimmed.notebookFailed, 26)
  // Один служебный участник, сколько бы заходов у него ни было.
  assert.equal(trimmed.entrants, 28)
  // Лучший публичный — класса, а не бейзлайна: в макете это две разные строки.
  assert.equal(trimmed.bestPublic, 0.0412)
})

test('очередь честная: у кого уже что-то идёт, тот пропускает вперёд', () => {
  const rows = [
    { submissionId: 'b', entrantId: 'anna', turn: 1, enqueuedAt: 200 },
    { submissionId: 'a', entrantId: 'timur', turn: 2, enqueuedAt: 100 },
    { submissionId: 'c', entrantId: 'lev', turn: 1, enqueuedAt: 300 },
  ]
  // Никто не занят: сперва первые заходы по времени, потом второй заход.
  assert.deepEqual(
    fairOrder(rows, new Set()).map((row) => row.submissionId),
    ['b', 'c', 'a'],
  )
  // У Анны уже что-то исполняется — её посылка уходит в хвост.
  assert.deepEqual(
    fairOrder(rows, new Set(['anna'])).map((row) => row.submissionId),
    ['c', 'a', 'b'],
  )
})

/* ------------------------------------------------------------ разбор формы */

test('форма принимает свой кусок и не трогает остального', () => {
  const parsed = parseCompetitionInput({ blurb: '  одна строка  ', description: 'хвост \n' })
  assert.ok('input' in parsed)
  assert.deepEqual(parsed.input, { blurb: 'одна строка', description: 'хвост \n' })
})

test('адрес соревнования проверяется буквами и списком занятых', () => {
  for (const [slug, why] of [
    ['', 'empty'],
    ['Rohlik!', 'chars'],
    ['t', 'reserved'],
  ] as const) {
    const parsed = parseCompetitionInput({ slug, title: 'x' }, { creating: true })
    assert.ok('refusal' in parsed, slug)
    assert.deepEqual(parsed.refusal, { field: 'slug', why })
  }
  const ok = parseCompetitionInput({ slug: ' ROHLIK ', title: 'x' }, { creating: true })
  assert.ok('input' in ok)
  assert.equal(ok.input.slug, 'rohlik')
})

test('числа формы сторожит сервер, а не экран', () => {
  const low = parseCompetitionInput({ publicPercent: 0 })
  assert.ok('refusal' in low)
  assert.deepEqual(low.refusal, {
    field: 'publicPercent',
    why: 'range',
    min: LIMITS.publicPercent.min,
    max: LIMITS.publicPercent.max,
  })
  const memory = parseCompetitionInput({ limits: { memoryMb: 64 } })
  assert.ok('refusal' in memory)
  assert.equal((memory.refusal as { field: string }).field, 'limits.memoryMb')
  const good = parseCompetitionInput({ publicPercent: 30, limits: { perDay: 5 } })
  assert.ok('input' in good)
  assert.deepEqual(good.input, { publicPercent: 30, limits: { perDay: 5 } })
})

test('перечисления и даты: чужое значение не доезжает до базы', () => {
  const direction = parseCompetitionInput({ metric: { direction: 'sideways' } })
  assert.ok('refusal' in direction)
  assert.equal((direction.refusal as { field: string }).field, 'metric.direction')
  const scoring = parseCompetitionInput({ scoring: 'whatever' })
  assert.ok('refusal' in scoring)
  const cleared = parseCompetitionInput({ deadlineAt: null })
  assert.ok('input' in cleared)
  assert.equal(cleared.input.deadlineAt, null)
  const broken = parseCompetitionInput({ deadlineAt: 'завтра' })
  assert.ok('refusal' in broken)
})

/* ----------------------------------------------------------- разбор файлов */

test('строки CSV считаются так же, как их прочтёт pandas', () => {
  const plain = csvShape(Buffer.from('id,orders\n1,5\n2,7\n'))
  assert.deepEqual(plain, { rows: 2, columns: ['id', 'orders'] })
  // Без перевода строки в конце — последняя строка всё равно строка.
  assert.equal(csvShape(Buffer.from('id,orders\n1,5'))?.rows, 1)
  assert.equal(csvShape(Buffer.from('id,orders\r\n1,5\r\n'))?.rows, 1)
  assert.deepEqual(csvShape(Buffer.from('id,orders\r\n1,5\r\n'))?.columns, ['id', 'orders'])
  // Пустые строки не строки: иначе доля публичной части считается не от того.
  assert.equal(csvShape(Buffer.from('id,orders\n1,5\n\n\n'))?.rows, 1)
  // Перевод строки внутри кавычек — часть значения, а не новая строка.
  assert.equal(csvShape(Buffer.from('id,note\n1,"первая\nвторая"\n2,x\n'))?.rows, 2)
  assert.deepEqual(csvShape(Buffer.from('"id","order, count"\n1,5\n'))?.columns, [
    'id',
    'order, count',
  ])
  assert.equal(csvShape(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])), null)
  assert.equal(csvShape(new Uint8Array()), null)
  assert.equal(columnsLine(['id', 'orders']), 'id, orders')
})

test('тетрадь узнаётся по ячейкам, а не по расширению', () => {
  assert.equal(notebookCells(Buffer.from(JSON.stringify({ cells: [{}, {}] }))), 2)
  assert.equal(notebookCells(Buffer.from(JSON.stringify({ cells: [] }))), 0)
  assert.equal(notebookCells(Buffer.from('{"nbformat": 4}')), null)
  assert.equal(notebookCells(Buffer.from('не json')), null)
})

test('имя файла — без пути, каким бы его ни прислал браузер', () => {
  assert.equal(baseName('C:\\Users\\anna\\train.csv'), 'train.csv')
  assert.equal(baseName('data/train.csv'), 'train.csv')
  assert.equal(baseName('  train.csv '), 'train.csv')
})

/* ------------------------------------------------------------------ двери */

let base = ''
let server: http.Server

function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function staff(name: string, email: string, role: 'owner' | 'teacher') {
  const teacher = createTeacher({ name, email, role })
  assert.ok(teacher, email)
  rotateLinkKey(teacher.id)
  return mintCookie(teacher)
}

let owner = ''
let teacher = ''

before(async () => {
  // Монтируется приложение целиком — вместе с проверкой происхождения и
  // печеньем: копия порядка middleware расхождений не ловит, она их повторяет.
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  owner = staff('Хозяйка', 'owner.k@example.edu', 'owner')
  teacher = staff('Преподаватель', 'teacher.k@example.edu', 'teacher')
})

after(() => server?.close())

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

function upload(
  path: string,
  cookie: string,
  files: { name: string; body: Uint8Array }[],
): Promise<globalThis.Response> {
  const form = new FormData()
  for (const file of files) form.append('file', new Blob([file.body]), file.name)
  return fetch(`${base}${path}`, { method: 'POST', headers: { cookie }, body: form })
}

const bytes = (text: string) => new TextEncoder().encode(text)
const NOTEBOOK = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', source: 'pass' }] })

test('без печенья панель не отвечает ничем', async () => {
  for (const [method, path] of [
    ['GET', '/api/admin/competitions'],
    ['GET', '/api/admin/competitions/queue'],
    ['GET', '/api/admin/competitions/entrants'],
    ['POST', '/api/admin/competitions'],
  ] as const) {
    const res = await call(method, path, { body: method === 'POST' ? {} : undefined })
    assert.equal(res.status, 401, `${method} ${path}`)
    assert.equal(((await res.json()) as { reason: string }).reason, 'unauthenticated')
  }
})

test('панель считает реальные строки Usage, а не процент от размера файла', async () => {
  const c = createCompetition({ slug: 'usage-counts', title: 'Разметка строк', publicPercent: 30 })
  for (const [usage, expected] of [
    ['Public,Private,Public,Public', { total: 4, publicRows: 3, privateRows: 1, byUsage: true }],
    ['Public,Private,unknown,Public', { total: 4, publicRows: 1, privateRows: 3, byUsage: false }],
  ] as const) {
    const rows = usage.split(',').map((part, i) => `${i},"строка, с\\nпереносом",${part}`.replace('\\n', '\n'))
    const response = await upload(`/api/admin/competitions/${c.id}/solution`, teacher, [
      { name: 'solution.csv', body: bytes(`id,target,Usage\n${rows.join('\n')}\n`) },
    ])
    assert.equal(response.status, 200)
    assert.deepEqual(((await response.json()) as CompetitionView).split, expected)
  }
})

test('соревнование заводит любой преподаватель, а адрес занимает один', async () => {
  const made = await call('POST', '/api/admin/competitions', {
    cookie: teacher,
    body: { slug: 'rohlik', title: 'Rohlik: сколько заказов будет завтра' },
  })
  assert.equal(made.status, 201)
  const view = (await made.json()) as CompetitionView
  assert.equal(view.competition.slug, 'rohlik')
  // Родится черновиком: открывает его отдельное действие с проверкой.
  assert.equal(view.competition.state, 'draft')
  assert.equal(view.ready, 'noData')

  const again = await call('POST', '/api/admin/competitions', {
    cookie: teacher,
    body: { slug: 'rohlik', title: 'Второе с тем же адресом' },
  })
  assert.equal(again.status, 409)
  assert.equal(((await again.json()) as { reason: string }).reason, 'exists')

  const badSlug = await call('POST', '/api/admin/competitions', {
    cookie: teacher,
    body: { slug: 't', title: 'Вход по ключу' },
  })
  assert.equal(badSlug.status, 400)
})

test('удалить соревнование может только владелец', async () => {
  const doomed = createCompetition({ slug: 'doomed', title: 'На снос' })
  assert.ok(doomed)
  const refused = await call('DELETE', `/api/admin/competitions/${doomed.id}`, { cookie: teacher })
  assert.equal(refused.status, 403)
  const body = (await refused.json()) as { reason: string; error: string }
  assert.equal(body.reason, 'forbidden')
  // Отказ называет то, что отказано, а не «список преподавателей».
  assert.match(body.error, /удалить соревнование/)
  assert.ok(getCompetition(doomed.id))

  const gone = await call('DELETE', `/api/admin/competitions/${doomed.id}`, { cookie: owner })
  assert.equal(gone.status, 204)
  assert.equal(getCompetition(doomed.id), null)
})

test('завершить, снять ответы, выдать новый ключ и снять посылку — владельцем', async () => {
  const c = createCompetition({ slug: 'owneronly', title: 'Право' })
  assert.ok(c)
  const doors: [string, string][] = [
    ['POST', `/api/admin/competitions/${c.id}/finish`],
    ['DELETE', `/api/admin/competitions/${c.id}/solution/solution.csv`],
  ]
  for (const [method, path] of doors) {
    const res = await call(method, path, { cookie: teacher })
    assert.equal(res.status, 403, path)
  }
  const made = await call('POST', '/api/admin/competitions/entrants', {
    cookie: teacher,
    body: { name: 'Анна Ким' },
  })
  assert.equal(made.status, 201)
  const { entrant } = (await made.json()) as { entrant: { id: string; key: string | null } }
  const rotate = await call(
    'POST',
    `/api/admin/competitions/entrants/${entrant.id}/rotate`,
    { cookie: teacher },
  )
  assert.equal(rotate.status, 403)
  const rotated = await call(
    'POST',
    `/api/admin/competitions/entrants/${entrant.id}/rotate`,
    { cookie: owner },
  )
  assert.equal(rotated.status, 200)
  const minted = (await rotated.json()) as { key: string }
  assert.notEqual(minted.key, entrant.key)
})

test('ключ входа виден в списке — другого места, где его прочесть, нет', async () => {
  const res = await call('GET', '/api/admin/competitions/entrants', { cookie: teacher })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { entrants: { name: string; key: string | null }[] }
  const anna = body.entrants.find((row) => row.name === 'Анна Ким')
  assert.ok(anna)
  assert.match(String(anna.key), /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/)
})

test('соревнование не открыть, пока базовое решение не прошло весь путь', async () => {
  const c = createCompetition({ slug: 'bpm', title: 'BPM: что даёт базовый прогноз' })
  assert.ok(c)
  const id = c.id

  const noData = await call('POST', `/api/admin/competitions/${id}/open`, { cookie: teacher })
  assert.equal(noData.status, 409)
  const said = (await noData.json()) as { reason: string; error: string }
  assert.equal(said.reason, 'not_ready')
  assert.match(said.error, /файла данных/)

  const data = await upload(`/api/admin/competitions/${id}/files`, teacher, [
    { name: 'test.csv', body: bytes('id,orders\n1,5\n2,7\n3,9\n') },
  ])
  assert.equal(data.status, 200)
  const withData = (await data.json()) as CompetitionView
  assert.equal(withData.openFiles.length, 1)
  assert.equal(withData.openFiles[0].rows, 3)
  assert.deepEqual(withData.openFiles[0].columns, ['id', 'orders'])
  assert.equal(withData.ready, 'noSolution')

  const solution = await upload(`/api/admin/competitions/${id}/solution`, teacher, [
    { name: 'answers.csv', body: bytes('id,orders\n1,5\n2,7\n3,9\n') },
  ])
  assert.equal(solution.status, 200)
  const withSolution = (await solution.json()) as CompetitionView
  // Имя на диске всегда одно: его ждёт контейнер метрики.
  assert.equal(withSolution.hiddenFiles[0].name, 'solution.csv')
  assert.equal(withSolution.split?.total, 3)
  assert.equal(withSolution.split?.publicRows, 1)
  assert.equal(withSolution.split?.privateRows, 2)
  assert.equal(withSolution.ready, 'noMetric')

  const metric = await call('PUT', `/api/admin/competitions/${id}/metric`, {
    cookie: teacher,
    body: { name: 'RMSE', direction: 'lower', code: 'def score(solution, submission): return 0.0' },
  })
  assert.equal(metric.status, 200)
  assert.equal(((await metric.json()) as CompetitionView).ready, 'noBaseline')

  const baseline = await upload(`/api/admin/competitions/${id}/baseline`, teacher, [
    { name: 'baseline.ipynb', body: bytes(NOTEBOOK) },
  ])
  assert.equal(baseline.status, 200)
  const withBaseline = (await baseline.json()) as CompetitionView
  assert.equal(withBaseline.baseline?.cells, 1)
  assert.equal(withBaseline.ready, 'baselineNotChecked')

  // Загружена — но ещё не проверена: дверь обязана отказать.
  const early = await call('POST', `/api/admin/competitions/${id}/open`, { cookie: teacher })
  assert.equal(early.status, 409)
  assert.match(((await early.json()) as { error: string }).error, /до числа/)

  const check = await call('POST', `/api/admin/competitions/${id}/baseline/check`, {
    cookie: teacher,
  })
  assert.equal(check.status, 202)
  const { submissionId } = (await check.json()) as { submissionId: string }
  // Проверка идёт настоящей посылкой в общей очереди — не «режимом проверки».
  const queued = getSubmission(submissionId)
  assert.ok(queued)
  assert.equal(queued.state, 'queued')

  // Исполнитель досчитал (в этом процессе его нет — пишем то же, что написал бы он).
  updateSubmission(submissionId, { state: 'scored', publicScore: 0.0587, privateScore: 0.0601 })

  const noDeadline = await call('POST', `/api/admin/competitions/${id}/open`, { cookie: teacher })
  assert.equal(noDeadline.status, 409)
  assert.match(((await noDeadline.json()) as { error: string }).error, /дедлайн/i)

  updateCompetition(id, { deadlineAt: Date.now() + 86_400_000 })
  const opened = await call('POST', `/api/admin/competitions/${id}/open`, { cookie: teacher })
  assert.equal(opened.status, 200)
  const live = (await opened.json()) as CompetitionView
  assert.equal(live.competition.state, 'live')
  assert.equal(live.ready, null)
  // Базовое решение — не участник и не посылка класса.
  assert.equal(live.counts.entrants, 0)
  assert.equal(live.counts.submissions, 0)
  assert.equal(live.baseline?.publicScore, 0.0587)

  // Второй раз открывать нечего.
  const twice = await call('POST', `/api/admin/competitions/${id}/open`, { cookie: teacher })
  assert.equal(twice.status, 409)
})

test('ответы не отдаёт наружу ни одна дверь', async () => {
  const c = createCompetition({ slug: 'secrets', title: 'Ответы' })
  assert.ok(c)
  const id = c.id
  const answers = 'id,orders\n1,5\n2,7\n'
  await upload(`/api/admin/competitions/${id}/files`, teacher, [
    { name: 'test.csv', body: bytes('id\n1\n2\n') },
  ])
  await upload(`/api/admin/competitions/${id}/solution`, teacher, [
    { name: 'solution.csv', body: bytes(answers) },
  ])
  // На диске они есть — и лежат в закрытом каталоге, не в открытом.
  assert.equal(String(readSecretFile(id, 'solution.csv')), answers)

  const view = await call('GET', `/api/admin/competitions/${id}`, { cookie: teacher })
  const text = await view.text()
  // Имена, строки и колонки преподаватель видит (так нарисован A2), байты — нет.
  assert.ok(text.includes('solution.csv'))
  assert.equal(text.includes('\\n1,5'), false)

  const direct = await call('GET', `/api/admin/competitions/${id}/files/solution.csv`, {
    cookie: owner,
  })
  assert.equal(direct.status, 404)
  const sideways = await call(
    'GET',
    `/api/admin/competitions/${id}/files/${encodeURIComponent('../secret/solution.csv')}`,
    { cookie: owner },
  )
  assert.equal(sideways.status, 404)
  assert.equal((await sideways.text()).includes('1,5'), false)

  // Открытый файл — отдаётся, и это ровно то, что скачает участник.
  const open = await call('GET', `/api/admin/competitions/${id}/files/test.csv`, {
    cookie: teacher,
  })
  assert.equal(open.status, 200)
  assert.equal(await open.text(), 'id\n1\n2\n')
})

test('тетрадь больше предела не доезжает до очереди', async () => {
  const c = createCompetition({ slug: 'toobig', title: 'Предел' })
  assert.ok(c)
  const huge = new Uint8Array(LIMITS.notebookBytes + 4096).fill(0x61)
  const res = await upload(`/api/admin/competitions/${c.id}/baseline`, teacher, [
    { name: 'baseline.ipynb', body: huge },
  ])
  assert.equal(res.status, 413)
  const body = (await res.json()) as { reason: string; error: string }
  assert.equal(body.reason, 'too_long')
  assert.match(body.error, /20 МБ/)
})

test('не тетрадь и негодное имя файла отказываются вслух', async () => {
  const c = createCompetition({ slug: 'names', title: 'Имена' })
  assert.ok(c)
  const notNotebook = await upload(`/api/admin/competitions/${c.id}/baseline`, teacher, [
    { name: 'baseline.ipynb', body: bytes('{"nbformat": 4}') },
  ])
  assert.equal(notNotebook.status, 400)

  const hidden = await upload(`/api/admin/competitions/${c.id}/files`, teacher, [
    { name: '.bashrc', body: bytes('id\n1\n') },
  ])
  assert.equal(hidden.status, 400)
  assert.equal(listFiles(c.id, 'open').length, 0)

  const empty = await upload(`/api/admin/competitions/${c.id}/files`, teacher, [])
  assert.equal(empty.status, 400)

  const notForm = await call('POST', `/api/admin/competitions/${c.id}/files`, {
    cookie: teacher,
    body: { file: 'train.csv' },
  })
  assert.equal(notForm.status, 400)
})

test('очередь инстанса приостанавливается и пускается обратно', async () => {
  const paused = await call('POST', '/api/admin/competitions/queue/pause', {
    cookie: teacher,
    body: { paused: true },
  })
  assert.equal(paused.status, 200)
  assert.equal(((await paused.json()) as { paused: boolean }).paused, true)

  const seen = await call('GET', '/api/admin/competitions/queue', { cookie: teacher })
  assert.equal(((await seen.json()) as { paused: boolean }).paused, true)

  const resumed = await call('POST', '/api/admin/competitions/queue/pause', {
    cookie: teacher,
    body: { paused: false },
  })
  assert.equal(((await resumed.json()) as { paused: boolean }).paused, false)
})

test('убить можно только то, что идёт', async () => {
  const res = await call('POST', '/api/admin/competitions/queue/kill', {
    cookie: teacher,
    body: { submissionId: 'нет такой' },
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /не идёт/)
})

test('лента посылок фильтруется и помечает базовое решение', async () => {
  const c = getCompetition(
    (await (await call('GET', '/api/admin/competitions', { cookie: teacher })).json() as {
      competitions: { competition: { id: string; slug: string } }[]
    }).competitions.find((row) => row.competition.slug === 'bpm')!.competition.id,
  )
  assert.ok(c)
  const feed = await call(`GET`, `/api/admin/competitions/${c.id}/submissions`, { cookie: teacher })
  assert.equal(feed.status, 200)
  const body = (await feed.json()) as {
    total: number
    rows: { baseline: boolean; submission: { state: string } }[]
  }
  assert.equal(body.total, 1)
  assert.equal(body.rows[0].baseline, true)

  const filtered = await call(
    'GET',
    `/api/admin/competitions/${c.id}/submissions?state=notebookFailed`,
    { cookie: teacher },
  )
  assert.equal(((await filtered.json()) as { total: number }).total, 0)
})

test('живое состояние отдаётся одним снимком', async () => {
  const list = (await (await call('GET', '/api/admin/competitions', { cookie: teacher })).json()) as {
    competitions: { competition: { id: string; slug: string } }[]
    queue: { slots: number; running: unknown[] }
  }
  assert.equal(list.queue.slots, 1)
  const bpm = list.competitions.find((row) => row.competition.slug === 'bpm')
  assert.ok(bpm)
  const live = await call('GET', `/api/admin/competitions/${bpm.competition.id}/live`, {
    cookie: teacher,
  })
  assert.equal(live.status, 200)
  const body = (await live.json()) as { counts: { submissions: number }; queue: { paused: boolean } }
  assert.equal(body.counts.submissions, 0)
  assert.equal(body.queue.paused, false)
})

test('чужая посылка по прямой ссылке не открывается', async () => {
  const a = createCompetition({ slug: 'alpha-k', title: 'Альфа' })
  const b = createCompetition({ slug: 'beta-k', title: 'Бета' })
  assert.ok(a && b)
  const res = await call('GET', `/api/admin/competitions/${a.id}/submissions/whatever`, {
    cookie: teacher,
  })
  assert.equal(res.status, 404)
})

test('меню строки: исполнить заново, пересчитать, не засчитывать', async () => {
  const c = createCompetition({ slug: 'rowmenu', title: 'Меню строки' })
  assert.ok(c)
  const entrant = createEntrant('Тимур Ахметов')
  const submission = acceptSubmission({
    competitionId: c.id,
    entrantId: entrant.entrant.id,
    fileName: 'lgbm_lags_v3.ipynb',
    bytes: 1024,
  })
  putSubmissionNotebook(c.id, submission.id, bytes(NOTEBOOK))
  updateSubmission(submission.id, { state: 'notebookFailed', cellsDone: 7, durationMs: 41_000 })

  // Упавшая тетрадь ответа не оставила — пересчитывать нечего.
  const noAnswer = await call(
    'POST',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/rescore`,
    { cookie: teacher },
  )
  assert.equal(noAnswer.status, 409)

  const rerun = await call(
    'POST',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/rerun`,
    { cookie: teacher },
  )
  assert.equal(rerun.status, 202)
  // Строка обязана сразу показать, что кнопка сработала: до очереди минуты.
  assert.equal(getSubmission(submission.id)?.state, 'queued')

  // Ответ лёг на диск — то есть посылка дошла до числа и её есть чем считать.
  updateSubmission(submission.id, { state: 'scored', publicScore: 0.44, privateScore: 0.45 })
  competitionsFs.writeFileSync(
    path.join(resultDir(c.id, submission.id), 'submission.csv'),
    Buffer.from('id,orders\n1,5\n'),
  )
  const rescore = await call(
    'POST',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/rescore`,
    { cookie: teacher },
  )
  assert.equal(rescore.status, 202)

  const all = await call('POST', `/api/admin/competitions/${c.id}/rescore`, { cookie: teacher })
  assert.equal(all.status, 202)
  assert.equal(((await all.json()) as { queued: number }).queued, 1)

  updateSubmission(submission.id, { state: 'scored' })
  const refused = await call(
    'POST',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/drop`,
    { cookie: teacher },
  )
  assert.equal(refused.status, 403)
  assert.match(((await refused.json()) as { error: string }).error, /снять посылку с зачёта/)
  assert.equal(getSubmission(submission.id)?.state, 'scored')

  const dropped = await call(
    'POST',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/drop`,
    { cookie: owner },
  )
  assert.equal(dropped.status, 200)
  assert.equal(getSubmission(submission.id)?.state, 'cancelled')
  // И строка очереди уходит вместе с ней: пересчитывать снятое незачем.
  assert.equal(queueRow(submission.id), null)
})

test('исполнить заново нечего, если тетради на диске уже нет', async () => {
  const c = createCompetition({ slug: 'swept', title: 'Убрано уборкой' })
  assert.ok(c)
  const entrant = createEntrant('Платон Г.')
  const submission = acceptSubmission({
    competitionId: c.id,
    entrantId: entrant.entrant.id,
    fileName: 'v1.ipynb',
    bytes: 10,
  })
  // Числа в базе живут вечно, тяжёлое уходит уборкой — и «исполнить заново»
  // после неё обязано сказать об этом, а не поставить в очередь пустоту.
  updateSubmission(submission.id, { state: 'scored' })
  const res = await call(
    'POST',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/rerun`,
    { cookie: teacher },
  )
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /убрана с диска|ещё идёт/)
})

test('весь вывод посылки — прогоны и то, что осталось на диске', async () => {
  const c = createCompetition({ slug: 'output', title: 'Вывод' })
  assert.ok(c)
  const entrant = createEntrant('Марфа Соколова')
  const submission = acceptSubmission({
    competitionId: c.id,
    entrantId: entrant.entrant.id,
    fileName: 'v3.ipynb',
    bytes: 10,
  })
  const run = startRun({ submissionId: submission.id, kind: 'notebook', container: 'zz-comp-x' })
  finishRun(run.id, { verdict: 'ok', teacherError: 'трейс только преподавателю' })

  const res = await call(
    'GET',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}`,
    { cookie: teacher },
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    entrant: { name: string }
    runs: { container: string | null; teacherError: string | null }[]
    artifacts: unknown[]
  }
  assert.equal(body.entrant.name, 'Марфа Соколова')
  assert.equal(body.runs.length, 1)
  assert.equal(body.runs[0].container, 'zz-comp-x')
  // Контейнера не было — исполненной тетради на диске тоже нет.
  assert.deepEqual(body.artifacts, [])

  const missing = await call(
    'GET',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/file/notebook.ipynb`,
    { cookie: teacher },
  )
  assert.equal(missing.status, 404)
})

test('живой поток отдаёт состояние сразу, а не по таймеру', async () => {
  const c = createCompetition({ slug: 'stream', title: 'Поток' })
  assert.ok(c)
  const res = await fetch(`${base}/api/admin/competitions/${c.id}/stream`, {
    headers: { cookie: teacher },
  })
  assert.equal(res.status, 200)
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/)
  const reader = res.body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /^event: state\ndata: \{/)
  assert.ok(JSON.parse(first.slice(first.indexOf('{'), first.lastIndexOf('}') + 1)))
  await reader.cancel()
})

test('файлы данных кладутся пачкой и снимаются по одному', async () => {
  const c = createCompetition({ slug: 'dataset', title: 'Данные' })
  assert.ok(c)
  const put = await upload(`/api/admin/competitions/${c.id}/files`, teacher, [
    { name: 'train.csv', body: bytes('id,orders\n1,5\n2,7\n') },
    { name: 'sample_submission.csv', body: bytes('id,orders\n1,0\n') },
  ])
  assert.equal(put.status, 200)
  const view = (await put.json()) as CompetitionView
  assert.deepEqual(
    view.openFiles.map((file) => [file.name, file.rows]).sort(),
    [
      ['sample_submission.csv', 1],
      ['train.csv', 2],
    ],
  )
  assert.equal(view.dataBytes, 18 + 14)

  const dropped = await call(
    'DELETE',
    `/api/admin/competitions/${c.id}/files/train.csv`,
    { cookie: teacher },
  )
  assert.equal(dropped.status, 200)
  const left = (await dropped.json()) as CompetitionView
  assert.deepEqual(left.openFiles.map((file) => file.name), ['sample_submission.csv'])
  // И с диска тоже: строка без файла — это данные, которых участник не увидит.
  assert.equal(readOpenFile(c.id, 'train.csv'), null)

  const missing = await call(
    'DELETE',
    `/api/admin/competitions/${c.id}/files/train.csv`,
    { cookie: teacher },
  )
  assert.equal(missing.status, 404)
})
