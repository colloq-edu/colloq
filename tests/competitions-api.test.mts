/**
 * The panel's doors to competitions: rights, refusals and what does not get
 * out.
 *
 * What is checked is what breaks quietly and expensively. An open competition
 * whose baseline does not pass means a hundred people looking for the bug in
 * their own code. An address taken by a second competition means a link
 * handed out to the class that leads to the wrong place. An answer file that
 * got out through even one door means the end of the competition, and an
 * unnoticed one: the leaderboard looks exactly the same afterwards.
 *
 * Separately and in detail: the panel's pure decisions
 * (`competitions/panel.ts`) and the parsing of what goes into the form
 * (`competitions/intake.ts`): they have a right answer, and checking it over
 * HTTP would mean checking the cookie, routing and JSON along with it.
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

/* ---------------------------------------------- the panel's pure decisions */

const READY: Readiness = {
  openFiles: 3,
  hiddenFiles: 1,
  metricCode: 'def score(a, b): return 0.0',
  baseline: true,
  baselineState: 'scored',
  privateRelease: 'auto',
  deadlineAt: Date.UTC(2026, 8, 27, 20, 59),
}

test('there is nothing to open while something is missing, and the refusal names what', () => {
  assert.equal(openRefusal(READY), null)
  assert.equal(openRefusal({ ...READY, openFiles: 0 }), 'noData')
  assert.equal(openRefusal({ ...READY, hiddenFiles: 0 }), 'noSolution')
  assert.equal(openRefusal({ ...READY, metricCode: '   \n' }), 'noMetric')
  assert.equal(openRefusal({ ...READY, baseline: false }), 'noBaseline')
  // Uploaded does not mean checked: exactly this difference holds the door.
  assert.equal(openRefusal({ ...READY, baselineState: null }), 'baselineNotChecked')
  assert.equal(openRefusal({ ...READY, baselineState: 'notebookFailed' }), 'baselineNotChecked')
  assert.equal(openRefusal({ ...READY, deadlineAt: null }), 'noDeadline')
  // Opening the private leaderboard by hand is exactly the consent to live
  // without a date.
  assert.equal(openRefusal({ ...READY, deadlineAt: null, privateRelease: 'manual' }), null)
})

test('the order of refusals is the order of the form sections, top to bottom', () => {
  // Nothing at all: the person must hear about the first section, not the last
  // one, otherwise they fix the form bottom up.
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

test('what left an answer can be rescored', () => {
  assert.equal(rescorable('scored'), true)
  // An answer rejected by the metric may turn out accepted after the code is
  // fixed.
  assert.equal(rescorable('rejected'), true)
  assert.equal(rescorable('metricFailed'), true)
  for (const state of ['queued', 'running', 'notebookFailed', 'timedOut', 'outOfMemory', 'cancelled'] as const) {
    assert.equal(rescorable(state), false, state)
  }
})

test('the wait estimate is computed per slot, not by multiplying the number', () => {
  // Without an average there is nothing to estimate with — and "≈ 0 min" would
  // be a promise.
  assert.deepEqual(waitEtas(2, { runningLeftMs: [], averageMs: null, slots: 1 }), [null, null])
  assert.deepEqual(
    waitEtas(3, { runningLeftMs: [60_000], averageMs: 120_000, slots: 1 }),
    [60_000, 180_000, 300_000],
  )
  // Two slots: the fifth waits half as long as with one.
  assert.deepEqual(
    waitEtas(4, { runningLeftMs: [0, 0], averageMs: 100, slots: 2 }),
    [0, 0, 100, 100],
  )
  assert.deepEqual(waitEtas(0, { runningLeftMs: [], averageMs: 100, slots: 1 }), [])
})

test('"executed today" counts only finished ones, and only for the day', () => {
  const now = Date.UTC(2026, 8, 20, 18)
  const since = Date.UTC(2026, 8, 20, 0)
  const stats = executedToday(
    [
      { acceptedAt: since + 1000, state: 'scored', durationMs: 120_000 },
      { acceptedAt: since + 2000, state: 'notebookFailed', durationMs: 60_000 },
      // Still running is not "executed".
      { acceptedAt: since + 3000, state: 'running', durationMs: null },
      // Yesterday's.
      { acceptedAt: since - 60_000, state: 'scored', durationMs: 999_000 },
    ],
    since,
    now,
  )
  assert.equal(stats.done, 2)
  assert.equal(stats.averageMs, 90_000)
  assert.equal(executedToday([], since, now).averageMs, null)
})

test('the median is what the summary shows', () => {
  assert.equal(medianOf([]), null)
  assert.equal(medianOf([5]), 5)
  assert.equal(medianOf([3, 1, 2]), 2)
  assert.equal(medianOf([1, 2, 3, 4]), 3)
})

test('the summary counts the baseline neither as a submission nor as an entrant', () => {
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
  // One service entrant, however many attempts it had.
  assert.equal(trimmed.entrants, 28)
  // The best public score is the class's, not the baseline's: in the mockup
  // these are two different lines.
  assert.equal(trimmed.bestPublic, 0.0412)
})

test('the queue is fair: whoever already has something running lets others go ahead', () => {
  const rows = [
    { submissionId: 'b', entrantId: 'anna', turn: 1, enqueuedAt: 200 },
    { submissionId: 'a', entrantId: 'timur', turn: 2, enqueuedAt: 100 },
    { submissionId: 'c', entrantId: 'lev', turn: 1, enqueuedAt: 300 },
  ]
  // Nobody is busy: first attempts in time order first, then the second
  // attempt.
  assert.deepEqual(
    fairOrder(rows, new Set()).map((row) => row.submissionId),
    ['b', 'c', 'a'],
  )
  // Anna already has something running, so her submission goes to the back.
  assert.deepEqual(
    fairOrder(rows, new Set(['anna'])).map((row) => row.submissionId),
    ['c', 'a', 'b'],
  )
})

/* ------------------------------------------------------------ form parsing */

test('the form takes its own piece and leaves the rest alone', () => {
  const parsed = parseCompetitionInput({ blurb: '  одна строка  ', description: 'хвост \n' })
  assert.ok('input' in parsed)
  assert.deepEqual(parsed.input, { blurb: 'одна строка', description: 'хвост \n' })
})

test('a competition address is checked by its letters and against the taken ones', () => {
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

test("the form's numbers are guarded by the server, not by the screen", () => {
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

test('enums and dates: a foreign value does not reach the database', () => {
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

/* ------------------------------------------------------------ file parsing */

test('CSV rows are counted the way pandas will read them', () => {
  const plain = csvShape(Buffer.from('id,orders\n1,5\n2,7\n'))
  assert.deepEqual(plain, { rows: 2, columns: ['id', 'orders'] })
  // Without a trailing newline the last line is still a line.
  assert.equal(csvShape(Buffer.from('id,orders\n1,5'))?.rows, 1)
  assert.equal(csvShape(Buffer.from('id,orders\r\n1,5\r\n'))?.rows, 1)
  assert.deepEqual(csvShape(Buffer.from('id,orders\r\n1,5\r\n'))?.columns, ['id', 'orders'])
  // Blank lines are not rows: otherwise the public share is computed from the
  // wrong number.
  assert.equal(csvShape(Buffer.from('id,orders\n1,5\n\n\n'))?.rows, 1)
  // A newline inside quotes is part of the value, not a new row.
  assert.equal(csvShape(Buffer.from('id,note\n1,"первая\nвторая"\n2,x\n'))?.rows, 2)
  assert.deepEqual(csvShape(Buffer.from('"id","order, count"\n1,5\n'))?.columns, [
    'id',
    'order, count',
  ])
  assert.equal(csvShape(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])), null)
  assert.equal(csvShape(new Uint8Array()), null)
  assert.equal(columnsLine(['id', 'orders']), 'id, orders')
})

test('a notebook is recognized by its cells, not by its extension', () => {
  assert.equal(notebookCells(Buffer.from(JSON.stringify({ cells: [{}, {}] }))), 2)
  assert.equal(notebookCells(Buffer.from(JSON.stringify({ cells: [] }))), 0)
  assert.equal(notebookCells(Buffer.from('{"nbformat": 4}')), null)
  assert.equal(notebookCells(Buffer.from('не json')), null)
})

test('a file name comes without a path, however the browser sends it', () => {
  assert.equal(baseName('C:\\Users\\anna\\train.csv'), 'train.csv')
  assert.equal(baseName('data/train.csv'), 'train.csv')
  assert.equal(baseName('  train.csv '), 'train.csv')
})

/* ------------------------------------------------------------------ doors */

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
  // The whole app is mounted — with the origin check and the cookie: a copy of
  // the middleware order does not catch divergences, it repeats them.
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

test('without a cookie the panel answers nothing', async () => {
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

test('the panel counts the real Usage rows, not a percentage of the file size', async () => {
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

test('any teacher can create a competition, but only one can take an address', async () => {
  const made = await call('POST', '/api/admin/competitions', {
    cookie: teacher,
    body: { slug: 'rohlik', title: 'Rohlik: сколько заказов будет завтра' },
  })
  assert.equal(made.status, 201)
  const view = (await made.json()) as CompetitionView
  assert.equal(view.competition.slug, 'rohlik')
  // It is born a draft: a separate action with a check opens it.
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

test('only the owner can delete a competition', async () => {
  const doomed = createCompetition({ slug: 'doomed', title: 'На снос' })
  assert.ok(doomed)
  const refused = await call('DELETE', `/api/admin/competitions/${doomed.id}`, { cookie: teacher })
  assert.equal(refused.status, 403)
  const body = (await refused.json()) as { reason: string; error: string }
  assert.equal(body.reason, 'forbidden')
  // The refusal names what was refused, not "the teacher list".
  assert.match(body.error, /удалить соревнование/)
  assert.ok(getCompetition(doomed.id))

  const gone = await call('DELETE', `/api/admin/competitions/${doomed.id}`, { cookie: owner })
  assert.equal(gone.status, 204)
  assert.equal(getCompetition(doomed.id), null)
})

test('finishing, removing answers, issuing a new key and dropping a submission are for the owner', async () => {
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

test('the sign-in key is visible in the list: there is no other place to read it', async () => {
  const res = await call('GET', '/api/admin/competitions/entrants', { cookie: teacher })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { entrants: { name: string; key: string | null }[] }
  const anna = body.entrants.find((row) => row.name === 'Анна Ким')
  assert.ok(anna)
  assert.match(String(anna.key), /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/)
})

test('a competition cannot be opened until the baseline has gone the whole way', async () => {
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
  // The name on disk is always the same: the metric container expects it.
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

  // Uploaded but not checked yet: the door must refuse.
  const early = await call('POST', `/api/admin/competitions/${id}/open`, { cookie: teacher })
  assert.equal(early.status, 409)
  assert.match(((await early.json()) as { error: string }).error, /до числа/)

  const check = await call('POST', `/api/admin/competitions/${id}/baseline/check`, {
    cookie: teacher,
  })
  assert.equal(check.status, 202)
  const { submissionId } = (await check.json()) as { submissionId: string }
  // The check runs as a real submission in the shared queue — not as a "check
  // mode".
  const queued = getSubmission(submissionId)
  assert.ok(queued)
  assert.equal(queued.state, 'queued')

  // The executor finished (it is not in this process, so we write what it
  // would have written).
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
  // The baseline is neither an entrant nor one of the class's submissions.
  assert.equal(live.counts.entrants, 0)
  assert.equal(live.counts.submissions, 0)
  assert.equal(live.baseline?.publicScore, 0.0587)

  // There is nothing to open a second time.
  const twice = await call('POST', `/api/admin/competitions/${id}/open`, { cookie: teacher })
  assert.equal(twice.status, 409)
})

test('no door gives the answers out', async () => {
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
  // They are on disk — in the closed directory, not the open one.
  assert.equal(String(readSecretFile(id, 'solution.csv')), answers)

  const view = await call('GET', `/api/admin/competitions/${id}`, { cookie: teacher })
  const text = await view.text()
  // The teacher sees names, rows and columns (that is how A2 is drawn), but
  // not the bytes.
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

  // An open file is given out, and that is exactly what an entrant will
  // download.
  const open = await call('GET', `/api/admin/competitions/${id}/files/test.csv`, {
    cookie: teacher,
  })
  assert.equal(open.status, 200)
  assert.equal(await open.text(), 'id\n1\n2\n')
})

test('a notebook over the limit does not reach the queue', async () => {
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

test('a non-notebook and an invalid file name are refused out loud', async () => {
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

test("the instance's queue pauses and resumes", async () => {
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

test('only what is running can be killed', async () => {
  const res = await call('POST', '/api/admin/competitions/queue/kill', {
    cookie: teacher,
    body: { submissionId: 'нет такой' },
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /не идёт/)
})

test('the submission feed is filtered and marks the baseline', async () => {
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

test('the live state is given as one snapshot', async () => {
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

test("another competition's submission does not open by a direct link", async () => {
  const a = createCompetition({ slug: 'alpha-k', title: 'Альфа' })
  const b = createCompetition({ slug: 'beta-k', title: 'Бета' })
  assert.ok(a && b)
  const res = await call('GET', `/api/admin/competitions/${a.id}/submissions/whatever`, {
    cookie: teacher,
  })
  assert.equal(res.status, 404)
})

test('the row menu: rerun, rescore, drop from counting', async () => {
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

  // A failed notebook left no answer, so there is nothing to rescore.
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
  // The row must show at once that the button worked: it is minutes until the
  // queue gets to it.
  assert.equal(getSubmission(submission.id)?.state, 'queued')

  // The answer landed on disk — that is, the submission reached a score and
  // there is something to score it with.
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
  // And the queue row goes with it: there is no point rescoring something
  // dropped.
  assert.equal(queueRow(submission.id), null)
})

test('there is nothing to rerun if the notebook is no longer on disk', async () => {
  const c = createCompetition({ slug: 'swept', title: 'Убрано уборкой' })
  assert.ok(c)
  const entrant = createEntrant('Платон Г.')
  const submission = acceptSubmission({
    competitionId: c.id,
    entrantId: entrant.entrant.id,
    fileName: 'v1.ipynb',
    bytes: 10,
  })
  // Scores live in the database forever, heavy files go away with the sweep —
  // and "rerun" after it must say so rather than queue emptiness.
  updateSubmission(submission.id, { state: 'scored' })
  const res = await call(
    'POST',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/rerun`,
    { cookie: teacher },
  )
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /убрана с диска|ещё идёт/)
})

test("a submission's whole output: the runs and what is left on disk", async () => {
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
  // There was no container, so there is no executed notebook on disk either.
  assert.deepEqual(body.artifacts, [])

  const missing = await call(
    'GET',
    `/api/admin/competitions/${c.id}/submissions/${submission.id}/file/notebook.ipynb`,
    { cookie: teacher },
  )
  assert.equal(missing.status, 404)
})

test('the live stream gives the state at once, not on a timer', async () => {
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

test('data files are uploaded as a batch and removed one at a time', async () => {
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
  // And from the disk too: a row without a file is data the entrant will not
  // see.
  assert.equal(readOpenFile(c.id, 'train.csv'), null)

  const missing = await call(
    'DELETE',
    `/api/admin/competitions/${c.id}/files/train.csv`,
    { cookie: teacher },
  )
  assert.equal(missing.status, 404)
})

test('admin leaderboard uses all submissions beyond the feed page', async () => {
  const c = createCompetition({ slug: 'authoritative-board', title: 'Board', metric: { direction: 'higher' } })!
  const entrant = createEntrant('Winner').entrant
  const winner = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'best.ipynb', bytes: 2, at: 1 })
  updateSubmission(winner.id, { state: 'scored', publicScore: 999, privateScore: 998 })
  for (let i = 0; i < 205; i++) {
    const s = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'later.ipynb', bytes: 2, at: i + 2 })
    updateSubmission(s.id, { state: 'scored', publicScore: 1, privateScore: 2 })
  }
  const res = await call('GET', `/api/admin/competitions/${c.id}/leaderboard`, { cookie: teacher })
  assert.equal(res.status, 200)
  const board = await res.json()
  assert.equal(board.public[0].submissionId, winner.id)
  assert.equal(board.public[0].score, 999)
  assert.equal(board.private[0].score, 998)
  assert.equal(board.public[0].entrantName, 'Winner')
  assert.equal(typeof board.revision, 'number')
})

test('metric changes invalidate readiness and baseline replacement retains service identity', async () => {
  const c = createCompetition({ slug: 'input-readiness', title: 'Inputs', metric: { code: 'def score(a,b): return 1' }, privateRelease: 'manual' })!
  await upload(`/api/admin/competitions/${c.id}/files`, teacher, [{ name: 'test.csv', body: bytes('id\n1\n2\n') }])
  await upload(`/api/admin/competitions/${c.id}/solution`, teacher, [{ name: 'solution.csv', body: bytes('id,target\n1,1\n2,2\n') }])
  await upload(`/api/admin/competitions/${c.id}/baseline`, teacher, [{ name: 'base.ipynb', body: bytes(NOTEBOOK) }])
  const baseline = createEntrant('Baseline').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: baseline.id, fileName: 'base.ipynb', bytes: 2 })
  updateSubmission(s.id, { state: 'scored', publicScore: 1, privateScore: 1 })
  updateCompetition(c.id, { baselineSubmissionId: s.id })
  assert.equal((await (await call('GET', `/api/admin/competitions/${c.id}`, { cookie: teacher })).json()).ready, null)
  await call('PUT', `/api/admin/competitions/${c.id}/metric`, { cookie: teacher, body: { code: 'def score(a,b): raise Exception()' } })
  assert.equal((await (await call('GET', `/api/admin/competitions/${c.id}`, { cookie: teacher })).json()).ready, 'baselineNotChecked')
  assert.equal((await call('POST', `/api/admin/competitions/${c.id}/open`, { cookie: teacher })).status, 409)
  // A metric-only recheck can certify a changed metric, but cannot certify new
  // notebook inputs that the baseline has never executed against.
  updateSubmission(s.id, { inputRevision: getCompetition(c.id)!.inputRevision })
  assert.equal((await (await call('GET', `/api/admin/competitions/${c.id}`, { cookie: teacher })).json()).ready, null)
  await upload(`/api/admin/competitions/${c.id}/files`, teacher, [{ name: 'new-data.csv', body: bytes('id\n3\n4\n') }])
  updateSubmission(s.id, { inputRevision: getCompetition(c.id)!.inputRevision })
  assert.equal((await (await call('GET', `/api/admin/competitions/${c.id}`, { cookie: teacher })).json()).ready, 'baselineNotChecked')
  await upload(`/api/admin/competitions/${c.id}/baseline`, teacher, [{ name: 'base.ipynb', body: bytes(NOTEBOOK) }])
  const feed = await (await call('GET', `/api/admin/competitions/${c.id}/submissions`, { cookie: teacher })).json()
  assert.equal(feed.rows[0].baseline, true)
})

test('unavailable broker execution is exposed and baseline check refuses before queueing', async () => {
  const c = createCompetition({ slug: 'unsupported-execution', title: 'Unavailable' })!
  const previous = { kernel: process.env.KERNEL_BACKEND, competition: process.env.COMPETITION_BACKEND }
  try {
    process.env.KERNEL_BACKEND = 'broker'
    process.env.COMPETITION_BACKEND = 'broker'
    const view = await (await call('GET', `/api/admin/competitions/${c.id}`, { cookie: teacher })).json()
    assert.equal(view.capabilities.execution.available, false)
    assert.equal(view.capabilities.execution.code, 'broker_unavailable')
    const check = await call('POST', `/api/admin/competitions/${c.id}/baseline/check`, { cookie: teacher })
    assert.equal(check.status, 503)
    assert.match((await check.json()).error, /.+/)
  } finally {
    if (previous.kernel === undefined) delete process.env.KERNEL_BACKEND; else process.env.KERNEL_BACKEND = previous.kernel
    if (previous.competition === undefined) delete process.env.COMPETITION_BACKEND; else process.env.COMPETITION_BACKEND = previous.competition
  }
})
