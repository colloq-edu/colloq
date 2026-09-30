/**
 * SHARED_ADDRESSES: a campus NAT is hundreds of people, not one script.
 *
 * Each per-address ceiling is driven past its number from an address the
 * operator named as shared, next to the same run from an ordinary address,
 * so that "it passed" cannot mean "the ceiling was never reached". And each
 * time the limit that is NOT about the address is shown still refusing: the
 * room's own ceiling on newcomers, the oracle's personal and room limits, the
 * per-person upload ceiling. The addresses arrive the way they do behind the
 * relay: X-Forwarded-For from a loopback peer (the default TRUSTED_PROXIES).
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { tr } from '../shared/i18n.js'
import { ENTRANT_COOKIE } from '../shared/competitions.js'
import { app } from '../server/src/app.js'
import { signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { countRoomQuestions, recordQuestion } from '../server/src/admin/usage.js'
import { roomQuestionCeiling } from '../server/src/ai/door.js'
import { createCompetition, putFile, setCompetitionState } from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSecretFile } from '../server/src/competitions/storage.js'
import { parseInboundPolicy, useInboundPolicy } from '../server/src/net/inbound.js'

/** The campus NAT as the server sees it. */
const SHARED = '198.51.100.0/24'

let base = ''
let server: http.Server

before(async () => {
  useInboundPolicy(parseInboundPolicy({ SHARED_ADDRESSES: SHARED }))
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  useInboundPolicy(null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
})

function post(path: string, address: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': address, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
}

/* ------------------------------------------------------------------ rooms */

test('a room lets newcomers from a shared address past sixty, and its own ceiling still holds', async () => {
  const refusal = tr('server.tooManyPeopleAreJoiningThisSeminar.11739b')
  const join = (room: string, i: number, address: string) => post(`/api/sessions/${room}/join`, address, { name: `Гость ${i}` })

  createSession('shared-join-plain', 'Обычный адрес', null)
  for (let i = 0; i < 60; i++) assert.equal((await join('shared-join-plain', i, '203.0.113.10')).status, 200, `plain join ${i}`)
  const sixtyFirst = await join('shared-join-plain', 60, '203.0.113.10')
  assert.equal(sixtyFirst.status, 429)
  assert.equal(((await sixtyFirst.json()) as { error: string }).error, refusal)

  // Behind the campus NAT: the whole cohort, up to the room's own ceiling.
  createSession('shared-join-nat', 'Кампус', null)
  for (let i = 0; i < 600; i++) {
    const res = await join('shared-join-nat', i, '198.51.100.7')
    assert.equal(res.status, 200, `shared join ${i}: ${await res.text()}`)
  }
  const beyond = await join('shared-join-nat', 600, '198.51.100.7')
  assert.equal(beyond.status, 429, 'the per-room ceiling no longer holds')
  assert.equal(((await beyond.json()) as { error: string }).error, refusal)
})

/* ----------------------------------------------------------------- oracle */

test('the oracle does not count a shared address; the personal and room limits still hold', async () => {
  updateOracleSettings({ apiKey: 'test-key', model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', questionsPerHour: 1, slowModeSeconds: 0 })
  const byAddress = tr('server.tooManyQuestionsFromYourAddress.5e2b8d')
  const settled = Date.now() - 3 * 60_000
  const ask = (room: string, participantId: string, address: string) =>
    fetch(`${base}/api/sessions/${room}/ai/ask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${signToken({ sessionId: room, participantId, role: 'participant', iat: settled })}`,
        'x-forwarded-for': address,
      },
      body: JSON.stringify({ message: 'что такое DataFrame?' }),
    })
  const person = (room: string, id: string) => upsertParticipant({ id, sessionId: room, name: id, avatar: null, role: 'participant' })

  createSession('shared-oracle-plain', 'Обычный адрес', null)
  for (let i = 0; i < 20; i++) {
    person('shared-oracle-plain', `p_plain${i}`)
    assert.ok(!(await (await ask('shared-oracle-plain', `p_plain${i}`, '203.0.113.20')).text()).includes(byAddress), `plain ${i}`)
  }
  person('shared-oracle-plain', 'p_plain20')
  assert.ok((await (await ask('shared-oracle-plain', 'p_plain20', '203.0.113.20')).text()).includes(byAddress))

  const room = 'shared-oracle-nat'
  createSession(room, 'Кампус', null)
  for (let i = 0; i < 22; i++) {
    person(room, `p_nat${i}`)
    // The room queue may say "wait" while the stand-in model fails: that is not the address.
    assert.ok(!(await (await ask(room, `p_nat${i}`, '198.51.100.20')).text()).includes(byAddress), `shared ${i}`)
  }
  // Per person: the first one's second question is over their hourly limit of one.
  const again = await ask(room, 'p_nat0', '198.51.100.20')
  assert.equal(again.status, 429)
  assert.ok(((await again.json()) as { error: string }).error.includes(tr('server.youHaveUsedYourOneOracleQuestion.61ab29')))
  // Per room: once the room has spent its ceiling, a fresh person behind the NAT waits too.
  const ceiling = roomQuestionCeiling(room, 1)
  for (let used = countRoomQuestions(room, 3_600_000); used < ceiling; used++) {
    recordQuestion({ sessionId: room, participantId: 'p_filler', action: 'ask' })
  }
  person(room, 'p_late')
  const late = await ask(room, 'p_late', '198.51.100.20')
  assert.equal(late.status, 429)
  assert.equal(((await late.json()) as { error: string }).error, tr('server.thisSeminarHasUsedAllOracleQuestions.5ff314', { p0: ceiling }))
})

/* ----------------------------------------------------------- competitions */

function liveCompetition(slug: string): string {
  const made = createCompetition({
    slug,
    title: slug,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 0.5\n' },
    limits: { perDay: 3 },
    privateRelease: 'auto',
  })
  assert.ok(made)
  ensureCompetition(made.id)
  const sample = new TextEncoder().encode('id,orders\n1,0\n')
  putOpenFile(made.id, 'sample_submission.csv', sample)
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: sample.length, rows: 1, visibility: 'open' })
  const solution = new TextEncoder().encode('id,orders\n1,7\n')
  putSecretFile(made.id, 'solution.csv', solution)
  putFile({ competitionId: made.id, name: 'solution.csv', bytes: solution.length, rows: 1, visibility: 'hidden' })
  setCompetitionState(made.id, 'live')
  return made.id
}

async function joinCompetition(slug: string, name: string, address: string): Promise<Response> {
  return post(`/api/k/competitions/${slug}/join`, address, { name })
}

async function entrantCookie(slug: string, name: string, address: string): Promise<string> {
  const res = await joinCompetition(slug, name, address)
  assert.equal(res.status, 200, `joining ${name}: ${await res.clone().text()}`)
  const cookie = (res.headers.getSetCookie?.() ?? []).find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))?.split(';')[0]
  assert.ok(cookie, 'no entrant cookie')
  return cookie
}

const reasonOf = async (res: Response): Promise<string | undefined> =>
  ((await res.json()) as { reason?: string }).reason

test('key sign-ins from a shared address are not counted per address', async () => {
  const signIn = (address: string) => post('/api/k/sign-in', address, { key: 'nosuchkey' })
  for (let i = 0; i < 40; i++) assert.equal((await signIn('203.0.113.50')).status, 404, `plain ${i}`)
  const plain = await signIn('203.0.113.50')
  assert.equal(plain.status, 429)
  assert.equal(await reasonOf(plain), 'too_often')
  for (let i = 0; i < 45; i++) assert.equal((await signIn('198.51.100.50')).status, 404, `shared ${i}`)
})

test('competition joins from a shared address are not counted per address', async () => {
  liveCompetition('shared-joins')
  for (let i = 0; i < 60; i++) assert.equal((await joinCompetition('shared-joins', `@plain_${i}`, '203.0.113.30')).status, 200, `plain ${i}`)
  const plain = await joinCompetition('shared-joins', '@plain_60', '203.0.113.30')
  assert.equal(plain.status, 429)
  assert.equal(await reasonOf(plain), 'too_often')
  for (let i = 0; i < 65; i++) assert.equal((await joinCompetition('shared-joins', `@nat_${i}`, '198.51.100.30')).status, 200, `shared ${i}`)
})

test('uploads from a shared address skip the per-address ceiling; the per-person one still holds', async () => {
  liveCompetition('shared-uploads')
  /*
   * Empty bodies: the ceilings are counted before the notebook is read, so a
   * request that fails later still spends one, and three hundred of them
   * cost milliseconds each instead of three hundred parsed notebooks.
   */
  const send = (cookie: string, address: string) => post('/api/k/competitions/shared-uploads/submissions', address, {}, cookie)
  const perPerson = 12
  const fill = async (address: string, tag: string): Promise<void> => {
    // Twenty-five people at the per-person ceiling: three hundred, the per-address one.
    for (let person = 0; person < 25; person++) {
      const cookie = await entrantCookie('shared-uploads', `@${tag}_${person}`, address)
      for (let i = 0; i < perPerson; i++) {
        const res = await send(cookie, address)
        assert.notEqual(res.status, 429, `${tag} person ${person} upload ${i}: ${await res.text()}`)
      }
    }
  }

  await fill('203.0.113.40', 'plain')
  const plain = await send(await entrantCookie('shared-uploads', '@plain_last', '203.0.113.40'), '203.0.113.40')
  assert.equal(plain.status, 429, 'the per-address ceiling was never reached: this test proves nothing')
  assert.equal(await reasonOf(plain), 'too_often')

  await fill('198.51.100.40', 'nat')
  const lastCookie = await entrantCookie('shared-uploads', '@nat_last', '198.51.100.40')
  const shared = await send(lastCookie, '198.51.100.40')
  assert.notEqual(shared.status, 429, await shared.text())
  // The same person, past their own ceiling, is refused whatever the address.
  for (let i = 1; i < perPerson; i++) assert.notEqual((await send(lastCookie, '198.51.100.40')).status, 429, `own ${i}`)
  const own = await send(lastCookie, '198.51.100.40')
  assert.equal(own.status, 429)
  assert.equal(await reasonOf(own), 'too_often')
})
