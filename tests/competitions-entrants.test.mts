/**
 * A competition entrant's identity and the public `/k` doors.
 *
 * What is checked is what breaks quietly and expensively. A sign-in key left
 * in the database as plain text. A new key that did not take the power away
 * from the old one — that is, "I lost my key" with no remedy. Two people with
 * the same name on the leaderboard, where they can no longer be told apart.
 * And above all: a door wider than it looks — the metric code, the row-split
 * seed, the private score before results open, someone else's submission,
 * someone else's trace. Any of these lets one win a competition without
 * solving the task, and none of them shows on screen.
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

/** A live competition: open data, hidden answers, the metric code. */
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
  // The seed is issued at birth; we replace it with a recognizable one so that
  // a leak shows up by searching the response body rather than by comparing
  // with a random string.
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

/* --------------------------------------------------------------- helpers */

/** The entrant cookie from a response, as the browser would send it back. */
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

/** Join as a new person and return their cookie along with the key. */
async function join(name: string): Promise<{ cookie: string; key: string; id: string }> {
  const res = await call('/api/k/competitions/rohlik/join', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  assert.equal(res.status, 200, `joining ${name}`)
  const payload = (await res.json()) as { entrant: { id: string }; key: string }
  const cookie = cookieOf(res)
  assert.ok(cookie, 'no entrant cookie was issued')
  return { cookie, key: payload.key, id: payload.entrant.id }
}

/* ------------------------------------------------------------------- key */

test('a key is issued once, and the database keeps only its fingerprint and seal', () => {
  const minted = createEntrant('Хранимый')
  assert.match(minted.key, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/)
  // The record that goes to the browser has no key under any name.
  assert.equal((minted.entrant as unknown as Record<string, unknown>).key, undefined)

  const row = db.prepare('SELECT * FROM entrants WHERE id = ?').get(minted.entrant.id) as Record<string, unknown>
  for (const [column, value] of Object.entries(row)) {
    assert.ok(
      typeof value !== 'string' || !value.includes(minted.key),
      `column ${column} holds the key as plain text`,
    )
  }
  assert.equal(row.key_hash, entrantKeyDigest(minted.key))
  // And it is retrieved through exactly one door — the one that shows the
  // card.
  assert.equal(entrantKeyOf(minted.entrant.id), minted.key)
})

test('a key reads however it is written, but a different letter makes a different key', () => {
  const minted = createEntrant('Диктующий вслух')
  const [a, b, c] = minted.key.split('-')
  // Copied from a phone screen: lower case, spaces instead of hyphens.
  assert.equal(entrantByKey(normalizeEntrantKey(`${a} ${b} ${c}`.toLowerCase())!)?.id, minted.entrant.id)
  // An alphabet without look-alikes: `O`, `0`, `I`, `1` and `L` are never
  // issued.
  assert.equal(normalizeEntrantKey('OOO-111-LLL'), null)
  assert.equal(normalizeEntrantKey(minted.key.slice(0, -1)), null)
  assert.equal(entrantByKey(''), null)
})

test('a seal survives only its own secret and does not give back a tampered string', () => {
  const key = newEntrantKey()
  const sealed = sealEntrantKey(key)
  assert.notEqual(sealed, key)
  assert.equal(unsealEntrantKey(sealed), key)
  // Tampering with any of the three parts is a refusal, not garbage shown as a
  // key.
  const parts = sealed.split('.')
  assert.equal(unsealEntrantKey([parts[0], sealEntrantKey(newEntrantKey()).split('.')[1], parts[2]].join('.')), null)
  assert.equal(unsealEntrantKey('не-печать'), null)
})

test('a new key disables the old one, and the old cookie along with it', async () => {
  const person = await join('Потерявший ключ')
  const before = await call('/api/k/me', { cookie: person.cookie })
  assert.equal(((await before.json()) as { entrant: { id: string } | null }).entrant?.id, person.id)

  const rotated = rotateEntrantKey(person.id)
  assert.ok(rotated)
  assert.notEqual(rotated.key, person.key)

  // The old key no longer lets you in.
  const refused = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: person.key }) })
  assert.equal(refused.status, 404)
  assert.equal(((await refused.json()) as { reason: string }).reason, 'key_unknown')

  /*
   * And the old cookie too: the key fingerprint is part of the signature, so a
   * tab where the person signed in with the previous key stops being them that
   * very minute. Without this, "the old key will be disabled" would refer only
   * to the input field.
   */
  const after = await call('/api/k/me', { cookie: person.cookie })
  assert.equal(((await after.json()) as { entrant: unknown }).entrant, null)

  const good = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: rotated.key }) })
  assert.equal(good.status, 200)
  assert.ok(cookieOf(good), 'signing in with the new key issued no cookie')
})

test('a disabled key and a nonexistent one are refused in DIFFERENT words', async () => {
  const person = await join('Отключаемый')
  setEntrantDisabled(person.id, true)
  const off = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: person.key }) })
  assert.equal(off.status, 403)
  assert.equal(((await off.json()) as { reason: string }).reason, 'key_disabled')

  const nobody = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: 'K7Q-M2X-9FD' }) })
  assert.equal(((await nobody.json()) as { reason: string }).reason, 'key_unknown')
  // And a disabled one does not get in with their cookie either — it was
  // issued before the disabling.
  const me = await call('/api/k/me', { cookie: person.cookie })
  assert.equal(((await me.json()) as { entrant: unknown }).entrant, null)
})

test('the sign-in link leads to /k/t/<key> and brings a person back from another device', async () => {
  const person = await join('Приехавший с телефона')
  const card = await call('/api/k/me', { cookie: person.cookie })
  const shown = (await card.json()) as { key: string; link: string }
  assert.equal(shown.key, person.key)
  assert.ok(shown.link.endsWith(`${ENTRANT_SIGN_IN_PATH}${person.key}`), shown.link)

  // Exactly what the page at this link does: it exchanges the key for a
  // cookie.
  const route = readCompetitionRoute(new URL(shown.link).pathname)
  assert.equal(route?.signInKey, person.key)
  const fresh = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: route!.signInKey }) })
  const cookie = cookieOf(fresh)
  assert.ok(cookie)
  const mine = await call('/api/k/competitions/rohlik/submissions', { cookie })
  assert.equal(mine.status, 200)
})

/* ----------------------------------------------------------------- joining */

test('namesakes do not appear on the leaderboard, and the refusal says so in words', async () => {
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

  // The same person joining again under their own name is not a clash.
  const again = await call('/api/k/competitions/rohlik/join', {
    method: 'POST',
    body: JSON.stringify({ name: 'Анна Ким' }),
    cookie: first.cookie,
  })
  assert.equal(again.status, 200)
})

test('a name is compared the way a person reads it', () => {
  assert.equal(entrantNameKey('  Анна   КИМ '), entrantNameKey('анна ким'))
  // "Артём" and "Артем" in one table are exactly the confusion the rule
  // exists for.
  assert.equal(entrantNameKey('Артём Сухомлин'), entrantNameKey('Артем Сухомлин'))
  assert.notEqual(entrantNameKey('Анна Ким'), entrantNameKey('Анна Кин'))
})

test("a rename is checked across ALL of the person's competitions at once", () => {
  const second = createCompetition({ slug: 'bpm', title: 'BPM' })
  assert.ok(second)
  setCompetitionState(second.id, 'live')
  const one = createEntrant('Первый').entrant
  const two = createEntrant('Второй').entrant
  assert.equal(joinCompetition(second.id, one.id, 'Даниил Орлов'), 'ok')
  assert.equal(joinCompetition(competitionId, two.id, 'Платон Г.'), 'ok')
  // The second one renames himself to the first one's name — but in ANOTHER
  // competition, the one he is joining now. A person has one name, so the
  // refusal applies everywhere.
  assert.equal(joinCompetition(second.id, two.id, 'Даниил Орлов'), 'taken')
  assert.equal(getEntrant(two.id)?.name, 'Платон Г.', 'the name changed even though it was refused')
})

/* ------------------------------------------------------------- sending */

test('before joining, in flight and over the daily quota are three different refusals', async () => {
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

  // The second one, while the first is in flight.
  const busy = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v2.ipynb', notebook())
  assert.equal(busy.status, 409)
  assert.equal(((await busy.json()) as { reason: string }).reason, 'in_flight')

  // The first finished scoring, the second was accepted, and the day's quota
  // ran out.
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

test('a non-notebook, a broken notebook and a non-.ipynb are turned away BEFORE the queue', async () => {
  const person = await join('Присылающий что попало')

  const wrongName = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'model.py', notebook())
  assert.equal(wrongName.status, 400)

  const broken = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v1.ipynb', '{не json')
  assert.equal(broken.status, 400)
  assert.match(((await broken.json()) as { error: string }).error, /не читается|does not read/i)

  const notNotebook = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'v1.ipynb', '{"hello": 1}')
  assert.equal(notNotebook.status, 400)

  // None of the three took a place in the queue or used the day's quota.
  const mine = await call('/api/k/competitions/rohlik/submissions', { cookie: person.cookie })
  const list = (await mine.json()) as { submissions: unknown[]; leftToday: number }
  assert.equal(list.submissions.length, 0)
  assert.equal(list.leftToday, 2)
})

test("parsing the sent file answers about the file, not about the entrant's code", () => {
  assert.equal(whyNotebookRefused(notebook()), null)
  assert.match(whyNotebookRefused('{')!, /не читается|does not read/i)
  assert.match(whyNotebookRefused('[]')!, /ячеек|cells/i)
  assert.match(whyNotebookRefused('{"cells": [{}]}')!, /повреждена|damaged/i)
  // A sent notebook has its own ceiling, and it is lower than the room's file
  // ceiling.
  assert.equal(LIMITS.notebookBytes, 20 * 1024 * 1024)
})

test('after the deadline submissions are closed, before the start they are not open yet', async () => {
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

test('nobody joins a finished competition: the table is already computed', async () => {
  const closed = createCompetition({ slug: 'cmi', title: 'CMI' })
  assert.ok(closed)
  setCompetitionState(closed.id, 'finished')
  const res = await call('/api/k/competitions/cmi/join', {
    method: 'POST',
    body: JSON.stringify({ name: 'Поздний' }),
  })
  assert.equal(res.status, 403)
  assert.equal(((await res.json()) as { reason: string }).reason, 'closed')
  // But a finished one's leaderboard can be read: that is exactly what people
  // come there for.
  const board = await call('/api/k/competitions/cmi/leaderboard')
  assert.equal(board.status, 200)
})

/* --------------------------------------------------------------- rights */

test("someone else's submission can be neither chosen as counted nor downloaded", async () => {
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

  // But one's own can be chosen and downloaded.
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

test('without a cookie the submission doors answer "sign in", not "no such thing"', async () => {
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

test('a draft does not exist on /k through any door', async () => {
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

/* ------------------------------------------------------ what leaks nowhere */

test('no /k door gives out the metric code, the seed, the answers or the private score', async () => {
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
    assert.ok(!text.includes('def score'), `${path} gave out the metric code`)
    assert.ok(!text.includes(SEED_MARK), `${path} gave out the row-split seed`)
    assert.ok(!text.includes('ZeroDivisionError'), `${path} gave out the teacher's trace`)
    assert.ok(!text.includes('0.4402'), `${path} gave out the private score before results opened`)
  }

  // Hidden answers cannot be downloaded either under their own name or by path
  // traversal.
  for (const name of ['solution.csv', '..%2Fsecret%2Fsolution.csv', '%2E%2E%2Fsecret%2Fsolution.csv']) {
    const res = await call(`/api/k/competitions/rohlik/files/${name}`)
    assert.equal(res.status, 404, name)
  }
  // But an open file downloads, otherwise the check checks nothing.
  const open = await call('/api/k/competitions/rohlik/files/test.csv')
  assert.equal(open.status, 200)
  assert.match(await open.text(), /^id\n/)
})

test('the private leaderboard is silent before opening and speaks after', async () => {
  const person = await join('Ждущий итогов')
  const sent = await send('/api/k/competitions/rohlik/submissions', person.cookie, 'final.ipynb', notebook())
  const { submission } = (await sent.json()) as { submission: { id: string } }
  updateSubmission(submission.id, { state: 'scored', publicScore: 0.39, privateScore: 0.3901 })

  const closed = await call('/api/k/competitions/rohlik/leaderboard', { cookie: person.cookie })
  const before = (await closed.json()) as { public: unknown[]; private: unknown[] | null; privateOpen: boolean }
  assert.ok(before.public.length > 0)
  assert.equal(before.private, null)
  assert.equal(before.privateOpen, false)

  // The deadline passed and the private one opens by itself — mockup A2,
  // "open by itself after the deadline".
  updateCompetition(competitionId, { deadlineAt: Date.now() - 1000, privateRelease: 'auto' })
  const opened = await call('/api/k/competitions/rohlik/leaderboard', { cookie: person.cookie })
  const after = (await opened.json()) as { private: { score: number }[] | null; privateOpen: boolean }
  assert.equal(after.privateOpen, true)
  assert.ok(after.private && after.private.length > 0)
  // And now the submission's private score is visible to its author — but not
  // earlier.
  const mine = await call('/api/k/competitions/rohlik/submissions', { cookie: person.cookie })
  const list = (await mine.json()) as { submissions: { id: string; privateScore: number | null }[] }
  assert.equal(list.submissions.find((s) => s.id === submission.id)?.privateScore, 0.3901)
  updateCompetition(competitionId, { deadlineAt: null, privateRelease: 'manual' })
})

/* ---------------------------------------------------------- addresses */

test('competition addresses are parsed, and a key does not clash with a competition name', () => {
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
  // Not competitions and not our addresses.
  assert.equal(readCompetitionRoute('/kk'), null)
  assert.equal(readCompetitionRoute('/k/Rohlik'), null, 'a competition address is lower case')
  assert.equal(readCompetitionRoute('/s/abc'), null)
  assert.equal(readCompetitionRoute('/k/rohlik/settings'), null)
})

test('too frequent sign-ins from one address are turned away', async () => {
  let refused = 0
  for (let i = 0; i < 60; i++) {
    const res = await call('/api/k/sign-in', { method: 'POST', body: JSON.stringify({ key: 'K7Q-M2X-9FE' }) })
    if (res.status === 429) refused += 1
    await res.text()
  }
  assert.ok(refused > 0, 'brute-forcing keys from one address is not limited at all')
})

/* ------------------------------------------------------------ summary */

test('the competition page knows what a person sees about themselves', async () => {
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
  // Open files yes, hidden ones no: there is one list, but it is taken by
  // visibility.
  assert.deepEqual(body.files.map((file) => file.name), ['test.csv'])
  assert.equal(body.mine.joined, true)
  assert.equal(body.mine.place, 1, 'the best public result is first place')
  assert.equal(body.mine.submissions, 1)

  // Without a cookie the same answer, but without the "YOU" block.
  const anon = await call('/api/k/competitions/rohlik')
  assert.equal(((await anon.json()) as { mine: unknown }).mine, null)
})

test('a submission accepted without joining still makes the person an entrant', () => {
  const person = createEntrant('Старожил').entrant
  acceptSubmission({ competitionId, entrantId: person.id, fileName: 'old.ipynb', bytes: 10 })
  assert.equal(joinedAt(competitionId, person.id), null)
  // Entrant lists and the summary count them as an entrant: they have a
  // submission.
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

test('public page explains unavailable broker execution and upload refuses before parsing its body', async () => {
  const c = createCompetition({ slug: 'no-public-runtime', title: 'No runtime' })!
  setCompetitionState(c.id, 'live')
  const joined = await call(`/api/k/competitions/${c.slug}/join`, { method: 'POST', body: JSON.stringify({ name: 'Waiting entrant' }) })
  const cookie = cookieOf(joined)
  const previous = { kernel: process.env.KERNEL_BACKEND, competition: process.env.COMPETITION_BACKEND }
  try {
    process.env.KERNEL_BACKEND = 'broker'
    process.env.COMPETITION_BACKEND = 'broker'
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
