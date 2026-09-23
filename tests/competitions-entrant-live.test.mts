/**
 * Живые двери участника: поток состояния, отмена своей посылки и то, что
 * лидерборд теперь рассказывает про посылку в зачёте.
 *
 * Всё это — право, а не украшение. Поток отдаёт СВОИ посылки: он открыт весь
 * прогон, и лишнее поле в нём уезжает не однажды, а каждую секунду. Отмена
 * убивает контейнер — чужую посылку ею снимать нельзя тем более. А колонка
 * «ПОСЫЛКА В ЗАЧЁТ» (P3) добавила в строку лидерборда номер и выбор автора, и
 * ровно там легче всего прицепить к ним приватное число.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { ENTRANT_COOKIE } from '../shared/competitions.js'
import { db } from '../server/src/db.js'
import type { EntrantLeaderboard, EntrantSubmissions } from '../shared/competitions-entrant.js'
import {
  acceptSubmission,
  chooseSubmission,
  createCompetition,
  getSubmission,
  putFile,
  queueRow,
  setCompetitionState,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSecretFile } from '../server/src/competitions/storage.js'
import { app } from '../server/src/app.js'

let base = ''
let server: http.Server
let competitionId = ''

const METRIC_CODE = 'def score(solution, submission):\n    return 0.5\n'
const SEED_MARK = 'zerno-kotoroe-nelzya-otdavat'

before(async () => {
  const made = createCompetition({
    slug: 'live-k',
    title: 'Живое соревнование',
    blurb: 'Проверка живых дверей.',
    description: 'Задача.',
    metric: { name: 'MAPE', direction: 'lower', code: METRIC_CODE },
    limits: { perDay: 20 },
  })
  assert.ok(made)
  competitionId = made.id
  setCompetitionState(competitionId, 'live')
  ensureCompetition(competitionId)
  putOpenFile(competitionId, 'test.csv', new TextEncoder().encode('id\n1\n2\n'))
  putFile({ competitionId, name: 'test.csv', bytes: 6, rows: 2, visibility: 'open' })
  putSecretFile(competitionId, 'solution.csv', new TextEncoder().encode('id,orders\n1,7\n2,9\n'))
  putFile({ competitionId, name: 'solution.csv', bytes: 18, rows: 2, visibility: 'hidden' })

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

/* ------------------------------------------------------------- помощники */

function cookieOf(res: Response): string | null {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    if (line.startsWith(`${ENTRANT_COOKIE}=`)) return line.split(';')[0]
  }
  return null
}

function call(path: string, init: RequestInit & { cookie?: string | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
}

async function join(name: string): Promise<{ cookie: string; id: string }> {
  const res = await call('/api/k/competitions/live-k/join', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  assert.equal(res.status, 200, `вступление ${name}`)
  const payload = (await res.json()) as { entrant: { id: string } }
  const cookie = cookieOf(res)
  assert.ok(cookie)
  return { cookie, id: payload.entrant.id }
}

/** Посылка, поставленная в очередь напрямую: прогонщика в сюите нет. */
function queue(entrantId: string, fileName: string, at = Date.now()) {
  return acceptSubmission({ competitionId, entrantId, fileName, bytes: 100, at })
}

/** Первый кадр `event: state` из потока — и поток сразу закрывается. */
async function firstFrame(cookie: string | null): Promise<{ status: number; data: string }> {
  const control = new AbortController()
  const res = await call('/api/k/competitions/live-k/stream', { cookie, signal: control.signal })
  if (!res.ok || !res.body) {
    control.abort()
    return { status: res.status, data: await res.text().catch(() => '') }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!buffer.includes('\n\n')) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    control.abort()
  }
  const frame = buffer.split('\n\n')[0]
  const line = frame.split('\n').find((part) => part.startsWith('data: ')) ?? ''
  return { status: res.status, data: line.slice('data: '.length) }
}

/* -------------------------------------------------------------- поток */

test('живой поток требует печенья участника', async () => {
  const anonymous = await firstFrame(null)
  assert.equal(anonymous.status, 401)
})

test('живой поток несуществующего соревнования — 404, а не пустой поток', async () => {
  const person = await join('Поток Первый')
  const control = new AbortController()
  const res = await call('/api/k/competitions/net-takogo/stream', {
    cookie: person.cookie,
    signal: control.signal,
  })
  control.abort()
  assert.equal(res.status, 404)
})

test('поток отдаёт свои посылки, место в очереди и ни одного чужого поля', async () => {
  const person = await join('Поток Второй')
  const mine = queue(person.id, 'mine.ipynb')
  // Чужая посылка, поставленная РАНЬШЕ: она и займёт первое место в очереди.
  const other = await join('Поток Третий')
  queue(other.id, 'other.ipynb')

  const frame = await firstFrame(person.cookie)
  assert.equal(frame.status, 200)
  const body = JSON.parse(frame.data) as EntrantSubmissions
  assert.equal(body.submissions.length, 1)
  assert.equal(body.submissions[0].id, mine.id)
  assert.equal(body.live.length, 1)
  assert.equal(body.live[0].submissionId, mine.id)
  assert.ok((body.live[0].place ?? 0) >= 1, 'место в очереди не названо')
  // Впереди только чужая работа — её номер участнику не показывают.
  assert.equal(body.live[0].aheadNumber, null)
  assert.equal(body.paused, false)

  // Ни трейса преподавателя, ни приватного числа, ни зерна деления строк.
  assert.doesNotMatch(frame.data, /teacherError/)
  assert.doesNotMatch(frame.data, /"privateScore":[^n]/)
  assert.doesNotMatch(frame.data, new RegExp(SEED_MARK))
  assert.doesNotMatch(frame.data, /def score/)
})

test('в списке посылок место и оценка ожидания считаются тем же порядком, что у исполнителя', async () => {
  const person = await join('Очередь Моя')
  // Законченная посылка даёт среднюю длительность — без неё оценки нет вовсе.
  const done = queue(person.id, 'done.ipynb')
  updateSubmission(done.id, { state: 'scored', stage: 'score', durationMs: 120_000, publicScore: 0.5 })

  const waiting = queue(person.id, 'waiting.ipynb')
  const res = await call('/api/k/competitions/live-k/submissions', { cookie: person.cookie })
  assert.equal(res.status, 200)
  const body = (await res.json()) as EntrantSubmissions
  const live = body.live.find((row) => row.submissionId === waiting.id)
  assert.ok(live, 'ждущая посылка не попала в живое состояние')
  assert.ok((live.place ?? 0) >= 1)
  assert.ok(live.etaMs !== null && live.etaMs >= 0, 'оценка ожидания не посчитана')
  assert.equal(live.limitMs, 600_000)
  assert.equal(live.startedAt, null)
})

test('отложенный из-за ресурсов Pod не получает ложное место и время в очереди', async () => {
  const person = await join('Ожидание ресурсов')
  const deferred = queue(person.id, 'deferred.ipynb')
  db.prepare('UPDATE competition_queue SET resource_retries=1, not_before=? WHERE submission_id=?')
    .run(Date.now() + 60_000, deferred.id)
  const res = await call('/api/k/competitions/live-k/submissions', { cookie: person.cookie })
  assert.equal(res.status, 200)
  const body = (await res.json()) as EntrantSubmissions
  const live = body.live.find((row) => row.submissionId === deferred.id)
  assert.ok(live)
  assert.equal(live.resourcePending, true)
  assert.equal(live.place, null)
  assert.equal(live.etaMs, null)
})

/* -------------------------------------------------------------- отмена */

test('отменить посылку может только её автор и только пока она не кончилась', async () => {
  const person = await join('Отменяющий')
  const stranger = await join('Посторонний')
  const submission = queue(person.id, 'cancel-me.ipynb')

  const anonymous = await call(`/api/k/competitions/live-k/submissions/${submission.id}/cancel`, {
    method: 'POST',
  })
  assert.equal(anonymous.status, 401, 'без печенья отмена прошла')

  const alien = await call(`/api/k/competitions/live-k/submissions/${submission.id}/cancel`, {
    method: 'POST',
    cookie: stranger.cookie,
  })
  assert.equal(alien.status, 403, 'чужую посылку сняли')
  assert.ok(queueRow(submission.id), 'чужая отмена всё-таки тронула очередь')

  const own = await call(`/api/k/competitions/live-k/submissions/${submission.id}/cancel`, {
    method: 'POST',
    cookie: person.cookie,
  })
  assert.equal(own.status, 200)
  const body = (await own.json()) as EntrantSubmissions
  assert.equal(body.submissions.find((s) => s.id === submission.id)?.state, 'cancelled')
  assert.equal(queueRow(submission.id), null, 'снятая посылка осталась в очереди')
  // Трейс отмены — поле преподавателя, и в ответе участнику его быть не должно.
  assert.doesNotMatch(JSON.stringify(body), /teacherError/)

  const again = await call(`/api/k/competitions/live-k/submissions/${submission.id}/cancel`, {
    method: 'POST',
    cookie: person.cookie,
  })
  assert.equal(again.status, 409, 'отмена кончившейся посылки притворилась удачной')
})

/* --------------------------------------------------------- лидерборд */

test('строка лидерборда несёт номер посылки и выбор автора — и ни одного приватного числа', async () => {
  const person = await join('Лидер Списка')
  const first = queue(person.id, 'a.ipynb')
  updateSubmission(first.id, {
    state: 'scored',
    stage: 'score',
    publicScore: 0.2,
    privateScore: 0.9,
    durationMs: 60_000,
  })
  const second = queue(person.id, 'b.ipynb')
  updateSubmission(second.id, {
    state: 'scored',
    stage: 'score',
    publicScore: 0.4,
    privateScore: 0.1,
    durationMs: 60_000,
  })
  assert.ok(chooseSubmission(competitionId, person.id, second.id))

  // Базовое решение — посылка служебного участника, отмеченная соревнованием.
  const baseline = await join('Базовый Прогон')
  const baseRun = queue(baseline.id, 'baseline.ipynb')
  updateSubmission(baseRun.id, {
    state: 'scored',
    stage: 'score',
    publicScore: 0.9,
    privateScore: 0.95,
    durationMs: 30_000,
  })
  updateCompetition(competitionId, { baselineSubmissionId: baseRun.id })

  const res = await call('/api/k/competitions/live-k/leaderboard', { cookie: person.cookie })
  assert.equal(res.status, 200)
  const raw = await res.text()
  const body = JSON.parse(raw) as EntrantLeaderboard
  const mine = body.public.find((line) => line.you)
  assert.ok(mine, 'своей строки в лидерборде нет')
  // В зачёт пошла выбранная, а не лучшая по числу: это и есть правило «chosen».
  assert.equal(mine.number, getSubmission(second.id)?.number)
  assert.equal(mine.chosen, true)
  assert.equal(mine.baseline, false)
  const base = body.public.find((line) => line.baseline)
  assert.ok(base, 'базовое решение не отмечено')
  assert.equal(base.you, false)

  // Место в карточке P1 считается среди ЛЮДЕЙ: базовое решение идёт лучше
  // всех, и место из общей таблицы показало бы человеку «2» там, где он один.
  const card = await call('/api/k/competitions/live-k', { cookie: person.cookie })
  const view = (await card.json()) as { entrants: number; mine: { place: number | null } }
  assert.equal(view.mine.place, 1, 'базовое решение отняло место у человека')
  assert.equal(view.entrants >= 1, true)

  // Итоги закрыты — приватной таблицы нет вовсе, а не «нулевая».
  assert.equal(body.private, null)
  assert.equal(body.privateOpen, false)
  assert.doesNotMatch(raw, /0\.95/)
  assert.doesNotMatch(raw, /teacherError/)
})

/**
 * Прошедший дедлайн закрывает приём, НЕ трогая состояние соревнования.
 *
 * `state` переводит в `finished` только преподаватель кнопкой «Завершить
 * сейчас», а на разборе до неё доходят не сразу. Шапка страницы участника
 * (components/competitions/PageHeader.svelte) именно поэтому смотрит на
 * `accepting`, а не на `competition.state`: пока она смотрела на состояние,
 * закрытое соревнование показывало плашку «ИДЁТ» рядом с часами «00:00», а
 * макет P3 рисует здесь «ЗАВЕРШЕНО». Этим полем связаны дверь и экран, поэтому
 * оно проверяется на настоящем ответе, а не на чистой функции рядом.
 */
test('дедлайн прошёл: приём закрыт, хотя соревнование ещё `live`', async () => {
  const person = await join('Дедлайн Дедлайнович')
  const before = (await (await call('/api/k/competitions/live-k', { cookie: person.cookie })).json()) as {
    competition: { state: string }
    accepting: string
  }
  assert.equal(before.accepting, 'open')

  updateCompetition(competitionId, { deadlineAt: Date.now() - 60_000 })
  try {
    const res = await call('/api/k/competitions/live-k', { cookie: person.cookie })
    const after = (await res.json()) as { competition: { state: string }; accepting: string }
    assert.equal(after.competition.state, 'live', 'дедлайн не должен сам менять состояние')
    assert.equal(after.accepting, 'closed', 'приём обязан закрыться сам')

    // И дверь отправки говорит то же самое: два ответа на один вопрос — хуже
    // одного неверного, и расходятся они молча.
    const form = new FormData()
    form.append('file', new File([JSON.stringify({ nbformat: 4, cells: [] })], 'late.ipynb'), 'late.ipynb')
    const sent = await call('/api/k/competitions/live-k/submissions', {
      method: 'POST',
      cookie: person.cookie,
      body: form,
    })
    assert.equal(sent.status, 403)
    assert.equal(((await sent.json()) as { reason: string }).reason, 'closed')
  } finally {
    updateCompetition(competitionId, { deadlineAt: null })
  }
})

/**
 * После дедлайна зачётную посылку не переставить — даже своей рукой.
 *
 * Итоги открываются на дедлайне, и в «моих посылках» человек видит приватное
 * число КАЖДОЙ своей посылки. Пока выбор оставался открытым, любой, кто
 * прислал больше одной, просто ставил в зачёт лучшую по скрытой части: не
 * обход правила, а прямая подгонка под неё — ровно то, ради чего приватная
 * часть и заведена. Дверь считает это отказом `closed`, а не «нет права».
 */
test('после дедлайна зачётную посылку не переставить', async () => {
  const person = await join('Поздний Выбор')
  const first = queue(person.id, 'a.ipynb')
  const second = queue(person.id, 'b.ipynb')
  for (const one of [first, second]) {
    updateSubmission(one.id, { state: 'scored', publicScore: 0.4, privateScore: 0.4 })
  }

  // До дедлайна выбор работает и меняется сколько угодно раз.
  const early = await call(`/api/k/competitions/live-k/submissions/${first.id}/choose`, {
    method: 'POST',
    cookie: person.cookie,
  })
  assert.equal(early.status, 200)
  assert.equal(getSubmission(first.id)?.chosen, true)

  updateCompetition(competitionId, { deadlineAt: Date.now() - 60_000 })
  try {
    const late = await call(`/api/k/competitions/live-k/submissions/${second.id}/choose`, {
      method: 'POST',
      cookie: person.cookie,
    })
    assert.equal(late.status, 403)
    assert.equal(((await late.json()) as { reason: string }).reason, 'closed')
    // Главное: в зачёте осталась ТА посылка, что была выбрана до дедлайна.
    assert.equal(getSubmission(first.id)?.chosen, true)
    assert.equal(getSubmission(second.id)?.chosen, false)
  } finally {
    updateCompetition(competitionId, { deadlineAt: null })
  }
})
