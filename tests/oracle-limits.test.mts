/**
 * The oracle question limit is the only thing standing between someone else's
 * key and somebody's bill. The personal limit is bypassed by rejoining: a name
 * in the room is not verified by anything, and a new incognito tab is a new
 * participant with a fresh N questions. So there is a second ceiling, for the
 * whole room; that one is checked, not the personal one, because the hole was
 * exactly here.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import {
  countRecentQuestions,
  countRoomQuestions,
  noteTokens,
  recordQuestion,
} from '../server/src/admin/usage.js'
import { signToken } from '../server/src/auth.js'
import { createSession, db, getRules, setRules, upsertParticipant } from '../server/src/db.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { aiRoutes } from '../server/src/routes/ai.js'

const HOUR = 60 * 60 * 1000

test('rejoining resets the personal count but not the room count', () => {
  const room = 'limits-room'

  // One person asked three questions.
  for (let i = 0; i < 3; i++) {
    recordQuestion({ sessionId: room, participantId: 'p_one', action: 'ask' })
  }
  assert.equal(countRecentQuestions(room, 'p_one', HOUR), 3)
  assert.equal(countRoomQuestions(room, HOUR), 3)

  // The same person rejoined: a new tab is a new participantId, the personal count is empty.
  assert.equal(countRecentQuestions(room, 'p_one_again', HOUR), 0)
  recordQuestion({ sessionId: room, participantId: 'p_one_again', action: 'ask' })

  // But the room remembers everything asked in it, whatever name the asker took.
  assert.equal(countRoomQuestions(room, HOUR), 4)
})

test('the count of one room does not leak into another', () => {
  const a = 'limits-a'
  const b = 'limits-b'
  recordQuestion({ sessionId: a, participantId: 'p_x', action: 'ask' })
  recordQuestion({ sessionId: a, participantId: 'p_y', action: 'ask' })
  assert.equal(countRoomQuestions(a, HOUR), 2)
  assert.equal(countRoomQuestions(b, HOUR), 0)
})

test('the room count counts everyone, including those who will never come back', () => {
  const room = 'limits-crowd'
  for (const who of ['p_a', 'p_b', 'p_c', 'p_d']) {
    recordQuestion({ sessionId: room, participantId: who, action: 'ask' })
  }
  // Exactly how this ceiling differs from the personal one: it is not about a person.
  assert.equal(countRoomQuestions(room, HOUR), 4)
  for (const who of ['p_a', 'p_b', 'p_c', 'p_d']) {
    assert.equal(countRecentQuestions(room, who, HOUR), 1)
  }
})

/* ------------------------------------- the refusal itself, not the counters */

/**
 * The three tests above check the counting, but it was the route that closed
 * the hole — and the route could be deleted entirely without failing any of
 * them. Below, questions are asked the way the panel asks: over HTTP, with a room token.
 */
const app = express()
app.use(express.json())
app.use(aiRoutes())
let base = ''
let server: http.Server

before(async () => {
  // The oracle has to be configured, otherwise the route answers 503 before the ceilings.
  updateOracleSettings({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:1/v1',
  })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
})

function askAs(
  room: string,
  participantId: string,
  options: { mode?: 'agent' } = {},
): Promise<Response> {
  // Older than two minutes: the oracle does not answer newcomers (routes/ai.ts · NEWCOMER_MS).
  const token = signToken({ sessionId: room, participantId, role: 'participant', iat: Date.now() - 3 * 60_000 })
  return fetch(`${base}/api/sessions/${room}/ai/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'почему тут падает?', mode: options.mode }),
  })
}

test('a room hits its ceiling even when everyone asks under their own name', async () => {
  const room = 'limits-route-room'
  createSession(room, 'Room ceiling', null)
  updateOracleSettings({ questionsPerHour: 1 })

  // Thirty personal limits: one question each from thirty "new" tabs.
  for (let i = 0; i < 30; i++) {
    recordQuestion({ sessionId: room, participantId: `p_tab_${i}`, action: 'ask' })
  }

  // The asker has an empty personal count: only the room one can refuse.
  const res = await askAs(room, 'p_fresh')
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '600')
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /Занятие использовало все 30/)
})

test('the personal ceiling says how long until the next question', async () => {
  const room = 'limits-route-person'
  createSession(room, 'Personal ceiling', null)
  updateOracleSettings({ questionsPerHour: 2 })
  recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })
  recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })

  const res = await askAs(room, 'p_ada')
  assert.equal(res.status, 429)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /Вы использовали все 2 вопроса оракулу/)
  // The window slides: the time comes from windowResetAt, not from "the start of the next hour".
  assert.match(body.error, /через 60 минут/)
  assert.ok(Number(res.headers.get('retry-after')) > 0)
})

/* ------------------------------------------------------------ slow mode */

/**
 * The interval between questions is about frequency, not about spending.
 *
 * An hourly ceiling lets twenty questions in a row through: they can be shouted
 * out in twenty seconds, and it is not the shouting that gets punished but the
 * next real question — with an hour without the oracle. Slow mode stands
 * exactly where the spam is, and costs seconds.
 */
test('slow mode lets the first question in and turns the second away, with a time', async () => {
  const room = 'slow-first'
  createSession(room, 'Слоу-мод', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 30 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)

  const denied = await askAs(room, 'p_kid')
  // The same code the hourly ceiling answers with: this route has no second way
  // of saying "not now".
  assert.equal(denied.status, 429, 'the second question went through right after the first')
  const body = (await denied.json()) as { error: string; retryAfter: number }
  assert.match(
    body.error,
    /Между вопросами нужно подождать 30 секунд/,
    `the refusal does not name the interval: ${body.error}`,
  )
  assert.match(body.error, /Повторите через \d+ секунд/, `the refusal does not say how long to wait: ${body.error}`)
  /*
   * The time also arrives as a number. By it the panel dims the button and shows
   * the wait as a calm line rather than a red error; it cannot tell a wait from a
   * failure by the text of a 429.
   */
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 30, `a strange time: ${body.retryAfter}`)
  assert.equal(denied.headers.get('retry-after'), String(body.retryAfter))
})

test('the interval has passed, and the oracle answers again', async () => {
  const room = 'slow-expiry'
  createSession(room, 'Промежуток', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 30 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  assert.equal((await askAs(room, 'p_kid')).status, 429)

  // The clock cannot be moved forward, so the question is moved back instead:
  // slow mode counts by the same usage row as the hourly ceiling.
  db.prepare('UPDATE ai_usage SET created_at = ? WHERE session_id = ?').run(
    Date.now() - 31_000,
    room,
  )
  assert.equal((await askAs(room, 'p_kid')).status, 202, 'the interval has passed, but there is no oracle')
})

test('slow mode does not apply to the teacher', async () => {
  const room = 'slow-host'
  createSession(room, 'Ведущий', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 300 })
  /*
   * The role is decided by the participant row, not by what the token says
   * (routes/sessions.ts · roleFor) — so the host has to be created for real.
   */
  upsertParticipant({
    id: 'p_ada_host',
    sessionId: room,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })

  // The host is running the class: their questions come in a row because the
  // walkthrough goes in a row.
  assert.equal((await askAs(room, 'p_ada_host')).status, 202)
  assert.equal((await askAs(room, 'p_ada_host')).status, 202, 'the host was turned away in their own class')

  // But in the same room a participant gets the same interval as everyone.
  assert.equal((await askAs(room, 'p_kid')).status, 202)
  assert.equal((await askAs(room, 'p_kid')).status, 429)
})

test('neither the personal nor the room ceiling holds the teacher back', async () => {
  /*
   * Both counts protect the instance from the room, and the host is not the
   * room. The personal ceiling would stop them in the middle of a walkthrough,
   * and the room one would stop them for someone else's spending: the class used
   * up the hour, and the very person running this class would go silent. Both
   * cases stand side by side here.
   */
  const room = 'caps-host'
  createSession(room, 'Потолки и ведущий', null)
  updateOracleSettings({ questionsPerHour: 1, slowModeSeconds: 0 })
  upsertParticipant({
    id: 'p_ada_caps',
    sessionId: room,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })

  // The room has used up its hour: thirty personal limits, one question per tab.
  for (let i = 0; i < 30; i++) {
    recordQuestion({ sessionId: room, participantId: `p_tab_${i}`, action: 'ask' })
  }
  // And the host's own personal count is used up too — the limit here is one.
  recordQuestion({ sessionId: room, participantId: 'p_ada_caps', action: 'ask' })

  const before = countRoomQuestions(room, HOUR)
  assert.equal((await askAs(room, 'p_ada_caps')).status, 202, 'a ceiling turned the host away')
  assert.equal((await askAs(room, 'p_ada_caps')).status, 202, 'and turned them away on the second question')

  // The host's questions are not subtracted from the count: instance spending is spending.
  assert.equal(countRoomQuestions(room, HOUR), before + 2)

  // But in the same room a participant hits the room ceiling, as they should.
  const denied = await askAs(room, 'p_kid')
  assert.equal(denied.status, 429)
  assert.match(((await denied.json()) as { error: string }).error, /Занятие использовало все 30/)
})

test('zero means no slow mode at all, and that is the default', async () => {
  const room = 'slow-off'
  createSession(room, 'Выключено', null)
  // More than five minutes cannot be set: that is no longer "do not rush" but "no
  // oracle today", and the setting does not let anyone get there by mistake.
  assert.equal(updateOracleSettings({ slowModeSeconds: 9_999 }).slowModeSeconds, 300)

  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
  for (let i = 0; i < 3; i++) {
    assert.equal((await askAs(room, 'p_kid')).status, 202, 'a disabled slow mode turned a question away')
  }
})

/* --------------------------------------------------- ceilings set by the room */

/**
 * The instance sets the default, and a room tightens it for itself.
 *
 * It cannot be loosened at either end: the model is paid for by whoever runs
 * the instance, and a seminar able to raise its own limit would turn the
 * instance setting from a ceiling into advice. There is one rule for the server
 * and the console — shared/rules.ts · oracleLimitsIn.
 */
test('a room lowers the hourly ceiling below the instance one, and the refusal follows its number', async () => {
  const room = 'limits-room-rule'
  createSession(room, 'Контрольная', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
  setRules(room, { ...getRules(room), questionsPerHour: 1 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  const denied = await askAs(room, 'p_kid')
  assert.equal(denied.status, 429, 'the room hourly ceiling did not work')
  const body = (await denied.json()) as { error: string }
  // The refusal text is the same as for the instance ceiling: what matters to a
  // student is the number, not which of the two places it was set in.
  assert.match(body.error, /использовали свой единственный вопрос оракулу/)
})

test('a room does not raise the instance ceiling', async () => {
  const room = 'limits-room-loose'
  createSession(room, 'Мягче нельзя', null)
  updateOracleSettings({ questionsPerHour: 1, slowModeSeconds: 0 })
  setRules(room, { ...getRules(room), questionsPerHour: 500 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  assert.equal((await askAs(room, 'p_kid')).status, 429, 'the room overrode the instance ceiling')
})

test('a room slow mode longer than the instance one still does not apply to the teacher', async () => {
  const room = 'slow-room-rule'
  createSession(room, 'Комнатный промежуток', null)
  // The instance has no interval at all: all of it comes from the room rules.
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
  setRules(room, { ...getRules(room), slowModeSeconds: 30 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  const denied = await askAs(room, 'p_kid')
  assert.equal(denied.status, 429, 'the room slow mode let a second question in a row through')
  const body = (await denied.json()) as { error: string; retryAfter: number }
  assert.match(body.error, /Между вопросами нужно подождать 30 секунд/)
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 30)

  // The interval does not apply to the host, neither the instance one nor the
  // room one: their questions come in a row because the walkthrough goes in a row.
  upsertParticipant({
    id: 'p_slow_host',
    sessionId: room,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  assert.equal((await askAs(room, 'p_slow_host')).status, 202)
  assert.equal((await askAs(room, 'p_slow_host')).status, 202, 'the host was turned away in their own class')
})

test('a room does not shorten the interval set by the instance', async () => {
  const room = 'slow-room-loose'
  createSession(room, 'Короче нельзя', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 30 })
  setRules(room, { ...getRules(room), slowModeSeconds: 0 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  assert.equal((await askAs(room, 'p_kid')).status, 429, 'the room cancelled the instance slow mode')

  // The instance settings are shared by the whole file: a slow mode left on would
  // turn away the second question in the tests below, which are about something else.
  updateOracleSettings({ slowModeSeconds: 0 })
})

/**
 * A question and a task are different rows in the panel's breakdown.
 *
 * While an "Act" turn was recorded under the same 'ask', the most expensive
 * mode was indistinguishable in the table from "explain": one turn calls the
 * model up to twelve times and drags files along. The key owner saw an even
 * column of questions where a couple of tasks cost half a semester.
 */
test('an "Act" turn is recorded in the usage under its own action, and a question under its own', async () => {
  const room = 'limits-work-action'
  createSession(room, 'Agent action', null)
  updateOracleSettings({ questionsPerHour: 20 })

  // A room with `agent: 'room'` is one where anyone may ask for edits. The
  // teacher's right comes from the staff cookie, and nobody here has one over HTTP.
  setRules(room, { ...getRules(room), agent: 'room' })

  assert.equal((await askAs(room, 'p_ada')).status, 202)
  assert.equal((await askAs(room, 'p_ada', { mode: 'agent' })).status, 202)

  const rows = db
    .prepare('SELECT action FROM ai_usage WHERE session_id = ? ORDER BY id')
    .all(room) as { action: string }[]
  assert.deepEqual(
    rows.map((row) => row.action),
    ['ask', 'work'],
  )
})

/**
 * A turn's spending adds up rather than being overwritten: there is one row per
 * question, and the "Act" mode calls the model up to twelve times. While only
 * the last step was counted, the most expensive mode looked the cheapest in the panel.
 */
test('the tokens of one question add up over its steps', () => {
  const room = 'limits-tokens'
  const id = recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })
  noteTokens(id, 900)
  noteTokens(id, 1_200)
  const spent = db.prepare('SELECT tokens AS n FROM ai_usage WHERE id = ?').get(id) as {
    n: number | null
  }
  assert.equal(spent.n, 2_100)
})
