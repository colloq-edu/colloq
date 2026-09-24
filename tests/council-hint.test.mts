/**
 * The oracle "hint" for a student in the council — the whole path, not just
 * the answer.
 *
 * Four promises, each of which breaks silently.
 *
 * PRIVACY. Council texts are seen by two people: the author and the teacher.
 * The question "why does mine crash", together with the attempt's code, must
 * not end up in the room's shared thread (`/ai/ask` writes there, and the
 * whole class reads it) and must not reach anyone else's socket. Real sockets
 * check this here: the neighbour in the room has a second frame parser, and
 * nothing shows up in it after the hint.
 *
 * TRIGGER. A hint is given for a FAILED run. Without a traceback the question
 * would degenerate into "look at my code and tell me if it is right", that is,
 * into solving it for the student — exactly what the council is guarded from.
 *
 * LIMIT. A question to the model is the same whoever asks it, and it must be
 * counted in the same table (`ai_usage`) and hit the same ceiling as the
 * questions in the feed. A door of its own for the hint would mean getting
 * past the limit through a second entrance.
 *
 * MEMORY. The answer is a letter inside the attempt, not a line on the
 * screen: a page reload must not lose it.
 *
 * One layer is faked — the gateway to the model (as in oracle-flow.test.mts).
 * The room, the document, the attempts table and frame parsing are real.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { WebSocket } from 'ws'
import { cellId as nameOf, createCell, getCells, getChat } from '../shared/notebook.js'
import { councilLetters, type ControlServerMessage } from '../shared/protocol.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { summariseUsage } from '../server/src/admin/usage.js'
import { dispatch } from '../server/src/control.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { attemptOf, recordRun, saveDraft } from '../server/src/council.js'
import { createSession, setRules } from '../server/src/db.js'
import { hintPrompt, tracebackOf } from '../server/src/ai/hint.js'
import { signToken, type TokenPayload } from '../server/src/auth.js'
import { aiRoutes } from '../server/src/routes/ai.js'

/*
 * Gateways are closed here, not in the test body: a failed assertion takes
 * `close()` away together with the rest of the test, and after that the
 * process does not exit at all — the suite hangs without a single line about
 * the cause. The list is shared, closing is idempotent.
 */
const gateways: (() => Promise<void>)[] = []

after(async () => {
  for (const close of gateways.splice(0)) await close()
  shutdownCollab()
})

/* ----------------------------------------------------------------- fakes */

interface Gateway {
  seen: Record<string, unknown>[]
  close: () => Promise<void>
}

/** An OpenAI-compatible gateway that answers with one prepared line. */
async function gateway(answer: string, wait?: Promise<void>): Promise<Gateway> {
  const seen: Record<string, unknown>[] = []
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.post('/v1/chat/completions', async (req, res) => {
    seen.push(req.body as Record<string, unknown>)
    if (wait) await wait
    res.setHeader('content-type', 'text/event-stream')
    if (answer) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    apiKey: 'test-key',
    questionsPerHour: 20,
    slowModeSeconds: 0,
  })
  /*
   * `closeAllConnections` before `close`, otherwise it never closes: the
   * stream to the model runs over keep-alive, the connection stays open, and
   * `close` waits for exactly that connection — the process did not exit
   * after the suite at all and hung silently.
   */
  const close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    })
  gateways.push(close)
  return { seen, close }
}

/** Exactly what `send` reads: the state and taking a frame. */
function socket(): { ws: WebSocket; said: ControlServerMessage[] } {
  const said: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (frame: string) => said.push(JSON.parse(frame) as ControlServerMessage),
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

/** A lecture room with a council cell and a student's failed attempt. */
function room(): { id: string; cellId: string } {
  const id = `hint-${++rooms}`
  createSession(id, 'Консилиум', null)
  setRules(id, LECTURE_ROOM)
  const { doc } = getSessionDoc(id)
  const made = createCell('code', 'imp = ...')
  doc.transact(() => {
    made.set('open', 'council')
    getCells(doc).push([made])
  })
  return { id, cellId: nameOf(made) }
}

function who(role: 'host' | 'participant', sessionId: string, participantId: string): TokenPayload {
  // A token older than two minutes: a newcomer waits (ai/door.ts ·
  // NEWCOMER_MS), and that rule is not tested here — everything else is.
  return { sessionId, participantId, role, iat: Date.now() - 600_000 }
}

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "<ipython-input-3>", line 2, in <module>',
  '    top = sorted(zip(imp, cols), reverse=True)[:5]',
  "AttributeError: 'DecisionTreeClassifier' object has no attribute 'feature_importance'",
]

/** A student's attempt with a failed run — the reason a hint is asked for. */
function failedAttempt(sessionId: string, cellId: string, participantId: string): void {
  saveDraft(sessionId, cellId, participantId, 'imp = clf.feature_importance', Date.now())
  /*
   * "Queued" first: the first frame of a run is the request, and from it the
   * store remembers UNDER WHICH text the run started (council.ts · runFor). A
   * result frame without it is not accepted at all — that is how run frames
   * whose text has since been rewritten are filtered out.
   */
  recordRun(sessionId, cellId, participantId, {
    state: 'queued',
    outputs: [],
    execCount: null,
    ranMs: null,
    startedAt: Date.now(),
    by: 'author',
  })
  recordRun(sessionId, cellId, participantId, {
    state: 'error',
    outputs: [
      {
        kind: 'error',
        ename: 'AttributeError',
        evalue: "'DecisionTreeClassifier' object has no attribute 'feature_importance'",
        traceback: TRACEBACK,
      },
    ],
    execCount: 3,
    ranMs: 12,
    startedAt: Date.now(),
    by: 'author',
  })
}

/** Wait for a frame that arrives after the trip to the model. */
async function settle(
  said: ControlServerMessage[],
  want: (frame: ControlServerMessage) => boolean,
): Promise<ControlServerMessage> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const found = said.find(want)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('the frame never arrived: ' + JSON.stringify(said.map((f) => f.t)))
}

/* ----------------------------------------------------------------- frame */

test('the model frame carries the task, the code and the traceback — and no name', () => {
  const turns = hintPrompt({
    before: 'Достаньте пять самых важных признаков.',
    stub: '# ваш код здесь',
    attempt: 'imp = clf.feature_importance',
    run: {
      state: 'error',
      outputs: [
        { kind: 'error', ename: 'AttributeError', evalue: 'no attribute', traceback: TRACEBACK },
      ],
      execCount: 1,
      ranMs: 1,
      startedAt: 0,
      by: 'author',
    },
  })
  const user = turns[1].content
  assert.match(user, /Достаньте пять самых важных признаков/)
  assert.match(user, /# ваш код здесь/)
  assert.match(user, /imp = clf\.feature_importance/)
  assert.match(user, /AttributeError/)
  // The model must not write a finished solution — that is stated in the
  // system frame, and it is the only thing the rule rests on at all.
  assert.match(turns[0].content, /НЕ пиши исправленный код/)
  assert.match(turns[0].content, /не больше ОДНОГО конкретного совета/)
})

test('the traceback travels without terminal colouring and with the exception name', () => {
  const text = tracebackOf([
    {
      kind: 'error',
      ename: 'ValueError',
      evalue: 'bad',
      traceback: ['[0;31mValueError[0m: bad', '  at line 2'],
    },
  ])
  assert.doesNotMatch(text, //, 'ANSI colouring reached the model')
  assert.match(text, /ValueError/)
})

/* ------------------------------------------------------- the whole path */

test('the hint arrives as a letter in the attempt — and only to its author', async () => {
  const gate = await gateway('Ошибка в строке 2: у модели нет атрибута feature_importance.')
  const { id, cellId } = room()
  failedAttempt(id, cellId, 'p_anya')
  // A council neighbour with the same failed attempt: if the hint leaks, it
  // leaks to them — both into their attempt and onto their socket.
  failedAttempt(id, cellId, 'p_petya')

  const anya = socket()
  const petya = socket()
  dispatch(petya.ws, id, who('participant', id, 'p_petya'), { t: 'ping' })
  const quietBefore = petya.said.length

  dispatch(anya.ws, id, who('participant', id, 'p_anya'), { t: 'council:hint', cellId })

  // First of all, "thinking": the button goes dark before the trip to the
  // model, otherwise it gets pressed a second time and spends a second
  // question from the limit.
  const asking = anya.said.find((f) => f.t === 'council:hint:state')
  assert.ok(asking && 'asking' in asking && asking.asking === true, 'the "thinking" frame did not arrive')

  const done = await settle(
    anya.said,
    (f) => f.t === 'council:hint:state' && 'asking' in f && f.asking === false,
  ) as Extract<ControlServerMessage, { t: 'council:hint:state' }>
  assert.equal(done.error, undefined, 'the hint ended in a refusal: ' + done.error)

  const letters = councilLetters(attemptOf(id, cellId, 'p_anya'))
  assert.equal(letters.length, 1, 'the hint did not land in the attempt')
  assert.equal(letters[0].to, 'oracle', 'the hint was recorded as a letter from the teacher')
  assert.match(letters[0].text, /feature_importance/)
  assert.equal(letters[0].by, 'Оракул')

  /* --- privacy, three locks */

  // The neighbour received not a single frame.
  assert.equal(petya.said.length, quietBefore, 'the hint went to someone else\'s socket')
  // And nothing landed in their attempt: the letter belongs to the one it was
  // asked about.
  assert.deepEqual(councilLetters(attemptOf(id, cellId, 'p_petya')), [])
  // And the room's shared thread is untouched: `/ai/ask` writes there, and the
  // class watches it.
  assert.equal(getChat(getSessionDoc(id).doc).length, 0, 'the question went to the shared feed')

  // Exactly one question went to the model, and it has neither a name nor a
  // participantId.
  assert.equal(gate.seen.length, 1)
  const body = JSON.stringify(gate.seen[0])
  assert.doesNotMatch(body, /p_anya/, 'a participantId got into the model frame')
  assert.match(body, /feature_importance/, 'the model did not see the attempt\'s code')

  // Usage is counted under an action of its own: in the panel's breakdown the
  // hint does not hide among "asked".
  assert.equal(summariseUsage(3_600_000).byAction.hint, 1)
  await gate.close()
})

test('without a failed run no hint is given, and the reason is stated', async () => {
  const gate = await gateway('must not arrive')
  const { id, cellId } = room()
  saveDraft(id, cellId, 'p_anya', 'imp = 1', Date.now())

  const { ws, said } = socket()
  dispatch(ws, id, who('participant', id, 'p_anya'), { t: 'council:hint', cellId })
  const answer = said.find((f) => f.t === 'council:hint:state')
  assert.ok(answer && 'error' in answer && typeof answer.error === 'string')
  assert.match((answer as { error: string }).error, /упавшему запуску/)
  assert.equal(gate.seen.length, 0, 'the model was asked for no reason')
  await gate.close()
})

test('outside the council there is no hint at all', async () => {
  const gate = await gateway('must not arrive')
  const id = `hint-plain-${++rooms}`
  createSession(id, 'Обычная', null)
  setRules(id, LECTURE_ROOM)
  const { doc } = getSessionDoc(id)
  const made = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([made]))

  const { ws, said } = socket()
  dispatch(ws, id, who('participant', id, 'p_anya'), { t: 'council:hint', cellId: nameOf(made) })
  const answer = said.find((f) => f.t === 'council:hint:state')
  assert.ok(answer && 'error' in answer, 'a silent refusal: the button would have stayed dark')
  assert.equal(gate.seen.length, 0)
  await gate.close()
})

test('out of questions — the hint refuses in the same words as the feed', async () => {
  const gate = await gateway('must not arrive')
  const { id, cellId } = room()
  failedAttempt(id, cellId, 'p_anya')
  // A limit of one question, and it is already spent: there is one door for
  // both entrances (ai/door.ts), and the hint has to run into it just as
  // `/ai/ask` does.
  updateOracleSettings({ questionsPerHour: 1 })
  const { ws, said } = socket()
  dispatch(ws, id, who('participant', id, 'p_anya'), { t: 'council:hint', cellId })
  await settle(said, (f) => f.t === 'council:hint:state')
  const second = socket()
  dispatch(second.ws, id, who('participant', id, 'p_anya'), { t: 'council:hint', cellId })
  const answer = second.said.find((f) => f.t === 'council:hint:state')
  assert.ok(answer && 'error' in answer && typeof answer.error === 'string')
  assert.match((answer as { error: string }).error, /вопрос|question/i)
  updateOracleSettings({ questionsPerHour: 20 })
  await gate.close()
})

test('hints share the room\'s limit on concurrent requests and free their slot', async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  const gate = await gateway('Проверьте имя атрибута.', wait)
  const api = http.createServer(express().use(express.json()).use(aiRoutes()))
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  const apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`
  const { id, cellId } = room()
  const reading = Array.from({ length: 12 }, (_, i) => {
    const author = `capacity-${i}`
    failedAttempt(id, cellId, author)
    const client = socket()
    dispatch(client.ws, id, who('participant', id, author), { t: 'council:hint', cellId })
    assert.ok(client.said.some((f) => f.t === 'council:hint:state' && f.asking))
    return client
  })
  try {
    failedAttempt(id, cellId, 'overflow')
    const overflow = socket()
    dispatch(overflow.ws, id, who('participant', id, 'overflow'), { t: 'council:hint', cellId })
    assert.ok(overflow.said.some((f) => f.t === 'council:hint:state' && !f.asking && f.error),
      'thirteenth request must be refused before reaching the provider')
    const publicQuestion = await fetch(`${apiBase}/api/sessions/${id}/ai/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken(who('participant', id, 'http-overflow'))}` },
      body: JSON.stringify({ message: 'Почему падает код?' }),
    })
    assert.equal(publicQuestion.status, 429, 'HTTP must count pending private hints too')
    assert.equal(publicQuestion.headers.get('retry-after'), '5')
    release()
    for (const client of reading)
      await settle(client.said, (f) => f.t === 'council:hint:state' && !f.asking)
    assert.equal(gate.seen.length, 12)
    dispatch(overflow.ws, id, who('participant', id, 'overflow'), { t: 'council:hint', cellId })
    assert.ok(overflow.said.some((f) => f.t === 'council:hint:state' && f.asking))
    await settle(overflow.said, (f) => f.t === 'council:hint:state' && !f.asking && !f.error)
    assert.equal(gate.seen.length, 13)
  } finally {
    release()
    await gate.close()
    api.closeAllConnections()
    await new Promise<void>((resolve) => api.close(() => resolve()))
  }
})
