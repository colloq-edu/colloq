/**
 * What a person reads when something goes wrong, and what is left of it in
 * the log.
 *
 * Both came from a live class. A gateway to Gemini refused five times in a row
 * by its own safety filter — without an HTTP status, with the single word
 * SAFETY — and the room read "could not reach the oracle, check the address
 * and the key": the teacher went off to fix the network and the key, both
 * perfectly healthy. And in the same seminar five hundred rows of one and the
 * same participant piled up, because the log could not tell which exact
 * return check had failed.
 *
 * So what is checked here is PHRASES and LINES, not codes: a person reads
 * both, and the cost of a mistake is half a class spent on the wrong thing.
 */
import './_env.mts'
import { after, beforeEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
// These diagnostics assert English copy deliberately; operator log tokens remain stable.
beforeEach(() => setLocaleResolver(() => 'en'))
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { streamChat } from '../server/src/ai/provider.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { journalMinute, seldom, startJournal, stopJournal, tally } from '../server/src/log.js'
import { createSession } from '../server/src/db.js'
import { signToken } from '../server/src/auth.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

/* ------------------------------------------------------------------ oracle */

/**
 * A fake OpenAI-compatible gateway.
 *
 * It answers with real SSE, because what is checked is exactly how the SDK
 * gives birth to the error: it turns a frame with an `error` field into an
 * APIError WITHOUT a status, and by the missing status alone such an error is
 * indistinguishable from "the host did not answer". Only the endpoint can be
 * faked here — the error itself must be assembled by the real SDK.
 */
async function withEndpoint(frames: string[], run: () => Promise<void>): Promise<void> {
  const app = express()
  app.post('/v1/chat/completions', (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    for (const frame of frames) res.write(`data: ${frame}\n\n`)
    res.end()
  })
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'google/gemini-3.7-flash',
    apiKey: 'test-key',
  })
  try {
    await run()
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
}

/** Ask and return what the room will read. */
async function said(): Promise<string> {
  try {
    await streamChat([{ role: 'user', content: 'привет' }], () => {})
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return ''
}

/**
 * Neither the address itself, nor the key itself, nor advice to check them.
 *
 * Saying "it is not the address and not the key" is allowed and needed: that
 * is exactly why the teacher went off to fix a healthy network. But showing
 * their values or sending people to the panel to edit them is the same
 * advice, only in other words.
 */
function blamesNothingLocal(message: string): void {
  assert.doesNotMatch(message, /https?:\/\//i, `the endpoint address is shown: ${message}`)
  assert.doesNotMatch(message, /test-key|OPENAI_API_KEY|admin panel/i, `the key is shown: ${message}`)
  assert.doesNotMatch(message, /\bcheck\b|Could not reach/i, `sent off to fix things: ${message}`)
  assert.doesNotMatch(message, /address|key/i, `the model refusal draws a conclusion about the address or key: ${message}`)
}

test('a safety filter refusal is called a model refusal, not a broken connection', async () => {
  await withEndpoint(['{"error":{"message":"SAFETY"}}'], async () => {
    const message = await said()
    assert.match(message, /declined/i, `it does not say the model declined: ${message}`)
    assert.match(message, /model/i, `it does not say the refusal came from the model: ${message}`)
    assert.match(message, /this request/i, `the refusal is not tied to the current request: ${message}`)
    blamesNothingLocal(message)
  })
})

test('a refusal named by the content_filter code reads the same', async () => {
  const frame = '{"error":{"code":"content_filter","message":"The response was blocked."}}'
  await withEndpoint([frame], async () => {
    const message = await said()
    assert.match(message, /declined/i, `it does not say the model declined: ${message}`)
    blamesNothingLocal(message)
  })
})

test('"broke off mid-sentence" is not the same as "could not reach"', async () => {
  await withEndpoint(['{"error":{"message":"upstream connection reset"}}'], async () => {
    const message = await said()
    assert.match(message, /broke off/i, `a break-off is not called a break-off: ${message}`)
    assert.doesNotMatch(
      message,
      /Could not reach/i,
      `an endpoint that answered is declared unreachable: ${message}`,
    )
  })
})

test('the endpoint really could not be reached — the address and key are still mentioned', async () => {
  // A port known to have nobody on it: this is the one case the phrase about
  // the address and the key exists for at all.
  updateOracleSettings({
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'google/gemini-3.7-flash',
    apiKey: 'test-key',
  })
  const message = await said()
  assert.match(message, /Could not reach/i, `the main thing is not said: ${message}`)
  assert.match(message, /address/i)
})

/* ------------------------------------------------------------ minute summary */

/** One summary: slip in a census, call it by hand, return the line. */
function minuteLine(census: {
  rooms: number
  people: number
  kernels: { live: number; busy: number; dead: number }
}): string | null {
  let line: string | null = null
  const original = console.log
  console.log = (...args: unknown[]) => {
    const text = args.map(String).join(' ')
    if (text.includes('[minute]')) line = text
  }
  try {
    startJournal(() => census)
    journalMinute()
  } finally {
    console.log = original
    stopJournal()
  }
  return line
}

test('the minute summary fits in one line and without zeros', () => {
  // A quiet summary is also the end of the previous minute: the counters of
  // neighbouring tests stay theirs instead of arriving here.
  minuteLine({ rooms: 0, people: 0, kernels: { live: 0, busy: 0, dead: 0 } })
  tally('frames', 1204)
  tally('gate', 3)
  const line = minuteLine({ rooms: 2, people: 41, kernels: { live: 2, busy: 1, dead: 0 } })
  assert.ok(line, 'there is no summary at all')
  assert.match(line!, /rooms 2/)
  assert.match(line!, /people 41/)
  assert.match(line!, /kernels 2 live \(1 busy\)/)
  assert.match(line!, /frames 1204/)
  assert.match(line!, /gate refused 3/)
  // Zero counters are not printed: a short line is one in which everything
  // matters.
  assert.doesNotMatch(line!, /aborted/, `a zero counter in the line: ${line}`)
  assert.doesNotMatch(line!, /dead/, `there are no dead kernels, yet the word is there: ${line}`)
})

test('counters reset every minute instead of piling up all day', () => {
  tally('aborted', 7)
  const first = minuteLine({ rooms: 1, people: 1, kernels: { live: 1, busy: 0, dead: 0 } })
  assert.match(first!, /aborted 7/)
  const second = minuteLine({ rooms: 1, people: 1, kernels: { live: 1, busy: 0, dead: 0 } })
  assert.doesNotMatch(second!, /aborted/, `the previous minute leaked into the next one: ${second}`)
})

test('on an empty machine the summary stays silent — 1440 lines about nothing are the same empty log', () => {
  const line = minuteLine({ rooms: 0, people: 0, kernels: { live: 0, busy: 0, dead: 0 } })
  assert.equal(line, null, `silence was written down as a line: ${line}`)
})

/* ------------------------------------------------------------ quieter than a minute */

test('the same event is reported once a minute, not on every repeat', () => {
  const key = `test-${Date.now()}`
  assert.equal(seldom(key), true, 'the first time must be reported')
  assert.equal(seldom(key), false, 'a second one within the same minute is already a flood')
  assert.equal(seldom(key), false)
  // Another room is another key, and its refusal is not swallowed by the
  // neighbour's silence.
  assert.equal(seldom(`${key}-other`), true)
  // The window has passed — it is reported again: otherwise a rare event
  // would disappear forever.
  assert.equal(seldom(key, 0), true)
})

/* -------------------------------------------------------------------- join */

const app = express()
app.use(express.json())
app.use(sessionRoutes())
const server = app.listen(0, '127.0.0.1')
const base = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`
after(() => server.close())

/** The log lines the join wrote during one call. */
async function joinLines(id: string, body: Record<string, unknown>): Promise<string[]> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    const text = args.map(String).join(' ')
    if (text.includes('[join ')) lines.push(text)
  }
  try {
    await fetch(`${base()}/api/sessions/${id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } finally {
    console.log = original
  }
  return lines
}

test('a join writes one line, and it shows whether the person came back as themselves or was created anew', async () => {
  const id = 'journal-join'
  createSession(id, 'Журнал')

  // The first time, the person was not here: they have nothing to present,
  // and that is "no id".
  const first = await joinLines(id, { name: 'Аня' })
  assert.equal(first.length, 1, `there must be exactly one line: ${JSON.stringify(first)}`)
  assert.match(first[0], /\[join journal-join\]/)
  assert.match(first[0], /\bnew\b/)
  assert.match(first[0], /no id/)
  assert.match(first[0], /participant by link/)
  // Nothing personal: the name does not go into the log.
  assert.doesNotMatch(first[0], /Аня/, 'the participant name got into the log')

  const me = /new (p_[A-Za-z0-9_-]+)/.exec(first[0])?.[1]
  assert.ok(me, `the line has no participant id: ${first[0]}`)

  // The same person with their token: a return as themselves, and no reason
  // to create a row.
  const back = await joinLines(id, {
    name: 'Аня',
    participantId: me,
    token: signToken({ sessionId: id, participantId: me!, role: 'participant' }),
  })
  assert.equal(back.length, 1)
  /*
   * Not `\b`: a participant id ends with any character of its alphabet,
   * including a hyphen, and after a hyphen there is no word boundary — and the
   * test went red on every sixtieth run, when such an id came up. Only one
   * thing is needed here: that the id is whole, not the start of another one.
   */
  assert.match(back[0], new RegExp(`back ${me}(?![A-Za-z0-9_-])`))
  assert.doesNotMatch(back[0], /\bnew\b/)
})

test('the join line names exactly which return check failed', async () => {
  const mine = 'journal-mine'
  const other = 'journal-other'
  createSession(mine, 'Моя')
  createSession(other, 'Чужая')

  const idOnly = await joinLines(mine, { name: 'Б', participantId: 'p_ghost' })
  assert.match(idOnly[0], /no token/, `the missing token is not named: ${idOnly[0]}`)

  const garbage = await joinLines(mine, { name: 'Б', participantId: 'p_ghost', token: 'мусор' })
  assert.match(garbage[0], /bad token/, `an unparsable token is named differently: ${garbage[0]}`)

  const foreign = await joinLines(mine, {
    name: 'Б',
    participantId: 'p_ghost',
    token: signToken({ sessionId: other, participantId: 'p_ghost', role: 'participant' }),
  })
  assert.match(foreign[0], /other room/, `a token of another room is named differently: ${foreign[0]}`)

  const impostor = await joinLines(mine, {
    name: 'Б',
    participantId: 'p_ghost',
    token: signToken({ sessionId: mine, participantId: 'p_someone_else', role: 'participant' }),
  })
  assert.match(impostor[0], /other person/, `a token for someone else is named differently: ${impostor[0]}`)

  // Everything matches, but the row is not in the database: the seminar was
  // cleaned up, and the browser does not know it.
  const gone = await joinLines(mine, {
    name: 'Б',
    participantId: 'p_ghost',
    token: signToken({ sessionId: mine, participantId: 'p_ghost', role: 'participant' }),
  })
  assert.match(gone[0], /row gone/, `a vanished row is named differently: ${gone[0]}`)

  // And none of them contains the token: it is what people sign in with.
  for (const line of [...idOnly, ...garbage, ...foreign, ...impostor, ...gone]) {
    assert.doesNotMatch(line, /eyJ/, `a token went into the log: ${line}`)
  }
})
