/**
 * Личность участника соревнований и публичные двери `/k`.
 *
 * Проверяется то, что ломается тихо и дорого. Ключ входа, оставшийся в базе
 * открытым текстом. Новый ключ, не отобравший силу у старого, — то есть
 * «потерял ключ» без ответа. Два человека с одним именем в лидерборде, где их
 * уже не различить. И главное: дверь, которая шире, чем кажется, — код
 * метрики, зерно деления строк, приватное число до открытия итогов, чужая
 * посылка, чужой трейс. Любое из этого позволяет выиграть соревнование, не
 * решая задачу, и ни одно не видно на экране.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENTRANT_COOKIE,
  ENTRANT_SIGN_IN_PATH,
  entrantNameKey,
  normalizeEntrantKey,
  submissionsOpen,
  whyNotebookRefused,
  LIMITS,
} from '../shared/competitions.js'
import { readCompetitionRoute } from '../web/src/lib/routes.js'
import { entrantKeyDigest, newEntrantKey, sealEntrantKey, unsealEntrantKey } from '../server/src/competitions/key.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  entrantByKey,
  entrantKeyOf,
  getEntrant,
  joinCompetition,
  joinedAt,
  putFile,
  rotateEntrantKey,
  setCompetitionState,
  setEntrantDisabled,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSecretFile } from '../server/src/competitions/storage.js'
import { db } from '../server/src/db.js'
import { app } from '../server/src/app.js'

let base = ''
let server: http.Server

/** Соревнование, которое идёт: открытые данные, скрытые ответы, код метрики. */
const METRIC_CODE = 'def score(solution, submission):\n    return 0.5\n'
const SEED_MARK = 'zerno-kotoroe-nelzya-otdavat'

let competitionId = ''

before(async () => {
  const made = createCompetition({
    slug: 'rohlik',
    title: 'Rohlik: сколько заказов будет завтра',
    blurb: 'Спрогнозируйте число заказов по складам.',
    description: '## Задача\nПосчитайте orders.',
    metric: { name: 'MAPE', direction: 'lower', code: METRIC_CODE },
    limits: { perDay: 2 },
  })
  assert.ok(made)
  competitionId = made.id
  // Зерно выдаётся при рождении; подменяем на узнаваемое, чтобы его утечку
  // было видно поиском по телу ответа, а не сравнением со случайной строкой.
  db.prepare('UPDATE competitions SET split_seed = ? WHERE id = ?').run(SEED_MARK, competitionId)
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

/** Печенье участника из ответа — в том виде, в каком его вернёт браузер. */
function cookieOf(res: Response): string | null {
  const raw = res.headers.getSetCookie?.() ?? []
  for (const line of raw) {
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

const notebook = (source = 'print(1)') =>
  JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source, outputs: [], metadata: {}, execution_count: null }] })

async function send(path: string, cookie: string | null, name: string, body: string) {
  const form = new FormData()
  form.append('file', new Blob([body]), name)
  return call(path, { method: 'POST', body: form, cookie })
}

/** Вступить новым человеком и вернуть его печенье вместе с ключом. */
async function join(name: string): Promise<{ cookie: string; key: string; id: string }> {
  const res = await call('/api/k/competitions/rohlik/join', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  assert.equal(res.status, 200, `вступление ${name}`)
  const payload = (await res.json()) as { entrant: { id: string }; key: string }
  const cookie = cookieOf(res)
  assert.ok(cookie, 'печенье участника не выдано')
  return { cookie, key: payload.key, id: payload.entrant.id }
}

/* ------------------------------------------------------------------ ключ */

test('ключ выдаётся один раз, а в базе от него остаются только отпечаток и печать', () => {
  const minted = createEntrant('Хранимый')
  assert.match(minted.key, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/)
  // В записи, которая уезжает в браузер, ключа нет ни под каким именем.
  assert.equal((minted.entrant as unknown as Record<string, unknown>).key, undefined)

  const row = db.prepare('SELECT * FROM entrants WHERE id = ?').get(minted.entrant.id) as Record<string, unknown>
  for (const [column, value] of Object.entries(row)) {
    assert.ok(
      typeof value !== 'string' || !value.includes(minted.key),
      `столбец ${column} держит ключ открытым текстом`,
    )
  }
  assert.equal(row.key_hash, entrantKeyDigest(minted.key))
  // И обратно он достаётся ровно одной дверью — той, что показывает карточку.
  assert.equal(entrantKeyOf(minted.entrant.id), minted.key)
})

test('ключ читается как угодно написанным, но чужая буква — это другой ключ', () => {
  const minted = createEntrant('Диктующий вслух')
  const [a, b, c] = minted.key.split('-')
  // Переписанный с экрана телефона: нижний регистр, пробелы вместо дефисов.
  assert.equal(entrantByKey(normalizeEntrantKey(`${a} ${b} ${c}`.toLowerCase())!)?.id, minted.entrant.id)
  // Алфавит без похожих знаков: `O`, `0`, `I`, `1` и `L` не выпускаются вовсе.
  assert.equal(normalizeEntrantKey('OOO-111-LLL'), null)
  assert.equal(normalizeEntrantKey(minted.key.slice(0, -1)), null)
  assert.equal(entrantByKey(''), null)
})

test('печать переживает только свой секрет и не отдаёт подменённую строку', () => {
  const key = newEntrantKey()
  const sealed = sealEntrantKey(key)
  assert.notEqual(sealed, key)
  assert.equal(unsealEntrantKey(sealed), key)
  // Подмена любой из трёх частей — отказ, а не мусор, показанный как ключ.
  const parts = sealed.split('.')
  assert.equal(unsealEntrantKey([parts[0], sealEntrantKey(newEntrantKey()).split('.')[1], parts[2]].join('.')), null)
  assert.equal(unsealEntrantKey('не-печать'), null)
})

test('новый ключ отключает старый — и старое печенье вместе с ним', async () => {
  const person = await join('Потерявший ключ')
  const before = await call('/api/k/me', { cookie: person.cookie })
  assert.equal(((await before.json()) as { entrant: { id: string } | null }).entrant?.id, person.id)

  const rotated = rotateEntrantKey(person.id)
  assert.ok(rotated)
  assert.notEqual(rotated.key, person.key)

  // Старый ключ больше не вход.
  const refused = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: person.key }) })
  assert.equal(refused.status, 404)
  assert.equal(((await refused.json()) as { reason: string }).reason, 'key_unknown')

  /*
   * И старое печенье тоже: отпечаток ключа входит в подпись, поэтому вкладка,
   * в которой человек вошёл прежним ключом, перестаёт быть им в ту же минуту.
   * Без этого «старый ключ будет отключён» означало бы только поле ввода.
   */
  const after = await call('/api/k/me', { cookie: person.cookie })
  assert.equal(((await after.json()) as { entrant: unknown }).entrant, null)

  const good = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: rotated.key }) })
  assert.equal(good.status, 200)
  assert.ok(cookieOf(good), 'вход по новому ключу не выдал печенья')
})

test('отключённый ключ и несуществующий отказывают РАЗНЫМИ словами', async () => {
  const person = await join('Отключаемый')
  setEntrantDisabled(person.id, true)
  const off = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: person.key }) })
  assert.equal(off.status, 403)
  assert.equal(((await off.json()) as { reason: string }).reason, 'key_disabled')

  const nobody = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: 'K7Q-M2X-9FD' }) })
  assert.equal(((await nobody.json()) as { reason: string }).reason, 'key_unknown')
  // И отключённый не ходит по своему печенью — оно выдано до отключения.
  const me = await call('/api/k/me', { cookie: person.cookie })
  assert.equal(((await me.json()) as { entrant: unknown }).entrant, null)
})

test('ссылка для входа ведёт на /k/t/<ключ> и возвращает человека с другого устройства', async () => {
  const person = await join('Приехавший с телефона')
  const card = await call('/api/k/me', { cookie: person.cookie })
  const shown = (await card.json()) as { key: string; link: string }
  assert.equal(shown.key, person.key)
  assert.ok(shown.link.endsWith(`${ENTRANT_SIGN_IN_PATH}${person.key}`), shown.link)

  // Ровно то, что делает страница по этой ссылке: меняет ключ на печенье.
  const route = readCompetitionRoute(new URL(shown.link).pathname)
  assert.equal(route?.signInKey, person.key)
  const fresh = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: route!.signInKey }) })
  const cookie = cookieOf(fresh)
  assert.ok(cookie)
  const mine = await call('/api/k/competitions/rohlik/submissions', { cookie })
  assert.equal(mine.status, 200)
})

/* -------------------------------------------------------------- вступление */

test('тёзки в лидерборде не заводятся, и отказ говорит об этом словами', async () => {
  const first = await join('Анна Ким')
  assert.ok(joinedAt(competitionId, first.id))

  const clash = await call('/api/k/competitions/rohlik/join', {
    method: 'POST',
    body: JSON.stringify({ name: 'анна   ким' }),
  })
  assert.equal(clash.status, 409)
  const body = (await clash.json()) as { reason: string; error: string }
  assert.equal(body.reason, 'name_taken')
  assert.match(body.error, /именем/i)

  // Тот же человек вступает повторно своим же именем — это не столкновение.
  const again = await call('/api/k/competitions/rohlik/join', {
    method: 'POST',
    body: JSON.stringify({ name: 'Анна Ким' }),
    cookie: first.cookie,
  })
  assert.equal(again.status, 200)
})

test('имя сравнивается так, как его читает человек', () => {
  assert.equal(entrantNameKey('  Анна   КИМ '), entrantNameKey('анна ким'))
  // «Артём» и «Артем» в одной таблице — ровно та путаница, ради которой
  // правило и заведено.
  assert.equal(entrantNameKey('Артём Сухомлин'), entrantNameKey('Артем Сухомлин'))
  assert.notEqual(entrantNameKey('Анна Ким'), entrantNameKey('Анна Кин'))
})

test('переименование проверяется во ВСЕХ соревнованиях человека сразу', () => {
  const second = createCompetition({ slug: 'bpm', title: 'BPM' })
  assert.ok(second)
  setCompetitionState(second.id, 'live')
  const one = createEntrant('Первый').entrant
  const two = createEntrant('Второй').entrant
  assert.equal(joinCompetition(second.id, one.id, 'Даниил Орлов'), 'ok')
  assert.equal(joinCompetition(competitionId, two.id, 'Платон Г.'), 'ok')
  // Второй переименовывается в тёзку первого — но в ДРУГОМ соревновании,
  // куда он вступает сейчас. Имя одно на человека, поэтому отказ общий.
  assert.equal(joinCompetition(second.id, two.id, 'Даниил Орлов'), 'taken')
  assert.equal(getEntrant(two.id)?.name, 'Платон Г.', 'имя уехало вместе с отказом')
})

/* ------------------------------------------------------------ отправка */

test('до вступления, в полёте и сверх дневной нормы — три разных отказа', async () => {
  const outsider = createEntrant('Не вступавший')
  const signed = await call('/api/k/sign-in', {
    method: 'POST',
    body: JSON.stringify({ key: outsider.key }),
  })
  const outsiderCookie = cookieOf(signed)
  const notJoined = await send('/api/k/competitions/rohlik/submissions', outsiderCookie, 'a.ipynb', notebook())
  assert.equal(notJoined.status, 403)
  assert.equal(((await notJoined.json()) as { reason: string }).reason, 'not_joined')

  const person = await join('Присылающий по одной')
  const first = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v1.ipynb', notebook())
  assert.equal(first.status, 200)
  const accepted = (await first.json()) as { submission: { id: string; number: number }; leftToday: number }
  assert.equal(accepted.leftToday, 1)

  // Вторая — пока первая в полёте.
  const busy = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v2.ipynb', notebook())
  assert.equal(busy.status, 409)
  assert.equal(((await busy.json()) as { reason: string }).reason, 'in_flight')

  // Первая досчиталась — вторую приняли, и норма дня кончилась.
  updateSubmission(accepted.submission.id, { state: 'scored', publicScore: 0.4, privateScore: 0.3 })
  const second = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v2.ipynb', notebook())
  assert.equal(second.status, 200)
  const secondBody = (await second.json()) as { submission: { id: string }; leftToday: number }
  assert.equal(secondBody.leftToday, 0)
  updateSubmission(secondBody.submission.id, { state: 'scored', publicScore: 0.5 })

  const spent = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v3.ipynb', notebook())
  assert.equal(spent.status, 429)
  assert.equal(((await spent.json()) as { reason: string }).reason, 'quota')
})

test('не тетрадь, битая тетрадь и не .ipynb разворачиваются ДО очереди', async () => {
  const person = await join('Присылающий что попало')

  const wrongName = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'model.py', notebook())
  assert.equal(wrongName.status, 400)

  const broken = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v1.ipynb', '{не json')
  assert.equal(broken.status, 400)
  assert.match(((await broken.json()) as { error: string }).error, /не читается|does not read/i)

  const notNotebook = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v1.ipynb', '{"hello": 1}')
  assert.equal(notNotebook.status, 400)

  // Ни одна из трёх не заняла места в очереди и не потратила дневной нормы.
  const mine = await call('/api/k/competitions/rohlik/submissions', { cookie: person.cookie })
  const list = (await mine.json()) as { submissions: unknown[]; leftToday: number }
  assert.equal(list.submissions.length, 0)
  assert.equal(list.leftToday, 2)
})

test('разбор присланного файла отвечает про файл, а не про код участника', () => {
  assert.equal(whyNotebookRefused(notebook()), null)
  assert.match(whyNotebookRefused('{')!, /не читается|does not read/i)
  assert.match(whyNotebookRefused('[]')!, /ячеек|cells/i)
  assert.match(whyNotebookRefused('{"cells": [{}]}')!, /повреждена|damaged/i)
  // Потолок присланной тетради — свой, и он меньше потолка файлов комнаты.
  assert.equal(LIMITS.notebookBytes, 20 * 1024 * 1024)
})

test('после дедлайна приём закрыт, до открытия — ещё не открыт', async () => {
  const now = Date.now()
  assert.equal(submissionsOpen({ state: 'live', startsAt: null, deadlineAt: null }, now), 'open')
  assert.equal(submissionsOpen({ state: 'live', startsAt: now + 1000, deadlineAt: null }, now), 'not_open')
  assert.equal(submissionsOpen({ state: 'live', startsAt: null, deadlineAt: now - 1 }, now), 'closed')
  assert.equal(submissionsOpen({ state: 'finished', startsAt: null, deadlineAt: null }, now), 'closed')
  assert.equal(submissionsOpen({ state: 'draft', startsAt: null, deadlineAt: null }, now), 'not_open')

  const person = await join('Опоздавший')
  updateCompetition(competitionId, { deadlineAt: Date.now() - 1000 })
  const late = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'late.ipynb', notebook())
  assert.equal(late.status, 403)
  assert.equal(((await late.json()) as { reason: string }).reason, 'closed')
  updateCompetition(competitionId, { deadlineAt: null })
})

test('в завершённое соревнование не вступают: таблица уже посчитана', async () => {
  const closed = createCompetition({ slug: 'cmi', title: 'CMI' })
  assert.ok(closed)
  setCompetitionState(closed.id, 'finished')
  const res = await call('/api/k/competitions/cmi/join', {
    method: 'POST',
    body: JSON.stringify({ name: 'Поздний' }),
  })
  assert.equal(res.status, 403)
  assert.equal(((await res.json()) as { reason: string }).reason, 'closed')
  // А лидерборд завершённого читается: именно за ним туда и приходят.
  const board = await call('/api/k/competitions/cmi/leaderboard')
  assert.equal(board.status, 200)
})

/* ---------------------------------------------------------------- право */

test('чужую посылку не выбрать в зачёт и не скачать', async () => {
  const mine = await join('Свой')
  const other = await join('Чужой')
  const sent = await send('/api/k/competitions/rohlik/submissions', mine.cookie, 'ok.ipynb', notebook())
  const { submission } = (await sent.json()) as { submission: { id: string } }
  updateSubmission(submission.id, { state: 'scored', publicScore: 0.41, privateScore: 0.44 })

  const stolen = await call(`/api/k/competitions/rohlik/submissions/${submission.id}/choose`, {
    method: 'POST',
    cookie: other.cookie,
  })
  assert.equal(stolen.status, 403)
  assert.equal(((await stolen.json()) as { reason: string }).reason, 'forbidden')

  const peek = await call(`/api/k/competitions/rohlik/submissions/${submission.id}/notebook`, {
    cookie: other.cookie,
  })
  assert.equal(peek.status, 403)

  // А своя — выбирается и скачивается.
  const chosen = await call(`/api/k/competitions/rohlik/submissions/${submission.id}/choose`, {
    method: 'POST',
    cookie: mine.cookie,
  })
  assert.equal(chosen.status, 200)
  const own = await call(`/api/k/competitions/rohlik/submissions/${submission.id}/notebook`, {
    cookie: mine.cookie,
  })
  assert.equal(own.status, 200)
  assert.match(await own.text(), /cell_type/)
})

test('без печенья двери посылок отвечают «войдите», а не «нет такого»', async () => {
  for (const path of [
    '/api/k/competitions/rohlik/submissions',
  ]) {
    const res = await call(path)
    assert.equal(res.status, 401, path)
    assert.equal(((await res.json()) as { reason: string }).reason, 'unauthenticated')
  }
  const post = await send('/api/k/competitions/rohlik/submissions', null, 'a.ipynb', notebook())
  assert.equal(post.status, 401)
})

test('черновик на /k не существует ни одной дверью', async () => {
  const draft = createCompetition({ slug: 'cherno', title: 'Черновик' })
  assert.ok(draft)
  for (const path of [
    '/api/k/competitions/cherno',
    '/api/k/competitions/cherno/leaderboard',
    '/api/k/competitions/cherno/files/test.csv',
  ]) {
    const res = await call(path)
    assert.equal(res.status, 404, path)
  }
  const list = await call('/api/k/competitions')
  const shown = (await list.json()) as { competitions: { competition: { slug: string } }[] }
  assert.ok(!shown.competitions.some((row) => row.competition.slug === 'cherno'))
})

/* --------------------------------------------------- что не утекает никуда */

test('ни одна дверь /k не отдаёт кода метрики, зерна, ответов и приватного числа', async () => {
  const person = await join('Любопытный')
  const sent = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'peek.ipynb', notebook())
  const { submission } = (await sent.json()) as { submission: { id: string } }
  updateSubmission(submission.id, {
    state: 'scored',
    publicScore: 0.41,
    privateScore: 0.4402,
    teacherError: 'ZeroDivisionError: float division by zero',
  })

  const doors = [
    '/api/k/competitions',
    '/api/k/competitions/rohlik',
    '/api/k/competitions/rohlik/leaderboard',
    '/api/k/competitions/rohlik/submissions',
    '/api/k/me',
  ]
  for (const path of doors) {
    const res = await call(path, { cookie: person.cookie })
    assert.equal(res.status, 200, path)
    const text = await res.text()
    assert.ok(!text.includes('def score'), `${path} отдал код метрики`)
    assert.ok(!text.includes(SEED_MARK), `${path} отдал зерно деления строк`)
    assert.ok(!text.includes('ZeroDivisionError'), `${path} отдал трейс преподавателя`)
    assert.ok(!text.includes('0.4402'), `${path} отдал приватное число до открытия итогов`)
  }

  // Скрытые ответы не скачиваются ни под своим именем, ни обходом по пути.
  for (const name of ['solution.csv', '..%2Fsecret%2Fsolution.csv', '%2E%2E%2Fsecret%2Fsolution.csv']) {
    const res = await call(`/api/k/competitions/rohlik/files/${name}`)
    assert.equal(res.status, 404, name)
  }
  // А открытый файл — скачивается, иначе проверка ничего не проверяет.
  const open = await call('/api/k/competitions/rohlik/files/test.csv')
  assert.equal(open.status, 200)
  assert.match(await open.text(), /^id\n/)
})

test('приватный лидерборд молчит до открытия и говорит после', async () => {
  const person = await join('Ждущий итогов')
  const sent = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'final.ipynb', notebook())
  const { submission } = (await sent.json()) as { submission: { id: string } }
  updateSubmission(submission.id, { state: 'scored', publicScore: 0.39, privateScore: 0.3901 })

  const closed = await call('/api/k/competitions/rohlik/leaderboard', { cookie: person.cookie })
  const before = (await closed.json()) as { public: unknown[]; private: unknown[] | null; privateOpen: boolean }
  assert.ok(before.public.length > 0)
  assert.equal(before.private, null)
  assert.equal(before.privateOpen, false)

  // Дедлайн прошёл и приватный открывается сам — макет A2, «открыть сам после дедлайна».
  updateCompetition(competitionId, { deadlineAt: Date.now() - 1000, privateRelease: 'auto' })
  const opened = await call('/api/k/competitions/rohlik/leaderboard', { cookie: person.cookie })
  const after = (await opened.json()) as { private: { score: number }[] | null; privateOpen: boolean }
  assert.equal(after.privateOpen, true)
  assert.ok(after.private && after.private.length > 0)
  // И теперь приватное число посылки видно её автору — но не раньше.
  const mine = await call('/api/k/competitions/rohlik/submissions', { cookie: person.cookie })
  const list = (await mine.json()) as { submissions: { id: string; privateScore: number | null }[] }
  assert.equal(list.submissions.find((s) => s.id === submission.id)?.privateScore, 0.3901)
  updateCompetition(competitionId, { deadlineAt: null, privateRelease: 'manual' })
})

/* ------------------------------------------------------------- адреса */

test('адреса соревнований разбираются, а ключ не спорит с именем соревнования', () => {
  assert.deepEqual(readCompetitionRoute('/k'), { slug: null, view: 'list', signInKey: null })
  assert.deepEqual(readCompetitionRoute('/k/'), { slug: null, view: 'list', signInKey: null })
  assert.deepEqual(readCompetitionRoute('/k/rohlik'), { slug: 'rohlik', view: 'task', signInKey: null })
  assert.equal(readCompetitionRoute('/k/rohlik/submissions')?.view, 'submissions')
  assert.equal(readCompetitionRoute('/k/rohlik/leaderboard')?.view, 'leaderboard')
  assert.equal(readCompetitionRoute('/k/rohlik/leaderboard/screen')?.view, 'screen')
  assert.deepEqual(readCompetitionRoute('/k/t/K7Q-M2X-9FD'), {
    slug: null,
    view: 'list',
    signInKey: 'K7Q-M2X-9FD',
  })
  // Не соревнования и не наши адреса.
  assert.equal(readCompetitionRoute('/kk'), null)
  assert.equal(readCompetitionRoute('/k/Rohlik'), null, 'адрес соревнования — строчными')
  assert.equal(readCompetitionRoute('/s/abc'), null)
  assert.equal(readCompetitionRoute('/k/rohlik/settings'), null)
})

test('слишком частый вход с одного адреса разворачивается', async () => {
  let refused = 0
  for (let i = 0; i < 60; i++) {
    const res = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: 'K7Q-M2X-9FE' }) })
    if (res.status === 429) refused += 1
    await res.text()
  }
  assert.ok(refused > 0, 'перебор ключей с одного адреса ничем не ограничен')
})

/* ------------------------------------------------------------- сводка */

test('страница соревнования знает, что человек о себе видит', async () => {
  const person = await join('Считающий место')
  const sent = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'place.ipynb', notebook())
  const { submission } = (await sent.json()) as { submission: { id: string } }
  updateSubmission(submission.id, { state: 'scored', publicScore: 0.2 })

  const page = await call('/api/k/competitions/rohlik', { cookie: person.cookie })
  const body = (await page.json()) as {
    competition: { slug: string; metric: { name: string } }
    files: { name: string }[]
    mine: { joined: boolean; place: number | null; submissions: number; leftToday: number | null }
  }
  assert.equal(body.competition.slug, 'rohlik')
  assert.equal(body.competition.metric.name, 'MAPE')
  // Открытые файлы — да, скрытые — нет: список один, но берётся он по видимости.
  assert.deepEqual(body.files.map((file) => file.name), ['test.csv'])
  assert.equal(body.mine.joined, true)
  assert.equal(body.mine.place, 1, 'лучший публичный результат — первое место')
  assert.equal(body.mine.submissions, 1)

  // Без печенья тот же ответ, но без блока «ВЫ».
  const anon = await call('/api/k/competitions/rohlik')
  assert.equal(((await anon.json()) as { mine: unknown }).mine, null)
})

test('посылка, принятая мимо вступления, всё равно делает человека участником', () => {
  const person = createEntrant('Старожил').entrant
  acceptSubmission({ competitionId, entrantId: person.id, fileName: 'old.ipynb', bytes: 10 })
  assert.equal(joinedAt(competitionId, person.id), null)
  // Списки участников и сводка считают его участником — у него есть посылка.
  const summary = db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE competition_id = ? AND entrant_id = ?")
    .get(competitionId, person.id) as { n: number }
  assert.equal(summary.n, 1)
})

for (const scoring of ['bestPublic', 'last'] as const) test(`API refuses manual choices under ${scoring}`, async () => {
  const c = createCompetition({ slug: `automatic-${scoring.toLowerCase()}`, title: 'Automatic', scoring })!
  setCompetitionState(c.id, 'live')
  const joined = await call(`/api/k/competitions/${c.slug}/join`, { method: 'POST', body: JSON.stringify({ name: 'Automatic entrant' }) })
  const cookie = cookieOf(joined)
  const person = await joined.json()
  const submission = acceptSubmission({ competitionId: c.id, entrantId: person.entrant.id, fileName: 'model.ipynb', bytes: 2 })
  updateSubmission(submission.id, { state: 'scored', publicScore: 1 })
  const response = await call(`/api/k/competitions/${c.slug}/submissions/${submission.id}/choose`, { method: 'POST', cookie })
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /автоматически|automatically/)
})

test('public page explains unsupported execution and upload refuses before parsing its body', async () => {
  const c = createCompetition({ slug: 'no-public-runtime', title: 'No runtime' })!
  setCompetitionState(c.id, 'live')
  const joined = await call(`/api/k/competitions/${c.slug}/join`, { method: 'POST', body: JSON.stringify({ name: 'Waiting entrant' }) })
  const cookie = cookieOf(joined)
  const previous = { kernel: process.env.KERNEL_BACKEND, competition: process.env.COMPETITION_BACKEND }
  try {
    process.env.KERNEL_BACKEND = 'broker'
    process.env.COMPETITION_BACKEND = 'docker'
    const page = await (await call(`/api/k/competitions/${c.slug}`, { cookie })).json()
    assert.equal(page.capabilities.execution.available, false)
    const response = await call(`/api/k/competitions/${c.slug}/submissions`, { method: 'POST', cookie, body: JSON.stringify({ definitely: 'not a notebook upload' }) })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).reason, 'unavailable')
  } finally {
    if (previous.kernel === undefined) delete process.env.KERNEL_BACKEND; else process.env.KERNEL_BACKEND = previous.kernel
    if (previous.competition === undefined) delete process.env.COMPETITION_BACKEND; else process.env.COMPETITION_BACKEND = previous.competition
  }
})
