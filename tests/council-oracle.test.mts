/**
 * The oracle on the class — what it gives the teacher, whom it keeps out, and
 * how it ends when the provider goes silent.
 *
 * Three things break silently, and all three are checked here.
 *
 * NAMES. Real names go into the frame — that is the owner's choice, and the
 * promise of the opposite used to stand in the header of ai/council.ts, in the
 * console caption and in the documentation. Turning the instance setting off
 * brings back the labels S1…SN, and then neither a name nor a participantId
 * may get into the prompt. Both sides are checked, because "turned it on and
 * did not notice" and "turned it off, and it leaked anyway" are equally bad.
 *
 * SILENCE. A provider that opened the stream and went quiet (or never opened
 * it) hung a live class on 20 Sep 2026: no answer, no error, not a line in the
 * log, and the cell stayed locked at 409 until the server restarted. The test
 * substitutes short watchdog deadlines — otherwise the check would cost three
 * minutes of waiting.
 *
 * NO GROUPS. No G-numbers in the frame, no group labels, no draft of a letter
 * to a group: the teacher reads the class by name.
 *
 * The gateway is fake, the room is real; the attempts are a list in memory,
 * because the attempts table lives in council.ts and changes separately from
 * the route.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { createCell, getCells } from '../shared/notebook.js'
import type { CouncilOracle } from '../shared/protocol.js'
import { getOracleSettings, updateOracleSettings } from '../server/src/admin/settings.js'
import { countRoomQuestions, recordQuestion } from '../server/src/admin/usage.js'
import { signToken } from '../server/src/auth.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import type { CouncilRun } from '../shared/protocol.js'
import {
  askCouncilOracle,
  isOracleReading,
  MAX_ORACLE_ANSWERS,
  normalizeOracle,
  onCouncilOracle,
  oraclePrompt,
  stopCouncilOracle,
  type OracleAttempt,
  type OracleStore,
} from '../server/src/ai/council.js'
import { councilRoutes, type CouncilOracleDeps } from '../server/src/routes/council.js'

after(() => shutdownCollab())

/* --------------------------------------------------------------- fakes */

/**
 * A fake OpenAI-compatible gateway: returns the given text as one SSE frame.
 * The real SDK parses it itself — only the endpoint is faked.
 */
async function withEndpoint(answer: string, run: () => Promise<void>): Promise<void> {
  const app = express()
  app.post('/v1/chat/completions', (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`)
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
  try {
    await run()
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
}

/**
 * A gateway that misbehaves: it either does not answer at all, or starts an
 * answer and goes quiet halfway. Exactly the two cases the watchdog exists
 * for.
 */
async function withStuckEndpoint(
  mode: 'silent' | 'half',
  run: () => Promise<void>,
): Promise<void> {
  const app = express()
  const hung: http.ServerResponse[] = []
  app.post('/v1/chat/completions', (_req, res) => {
    hung.push(res)
    if (mode === 'silent') return
    res.setHeader('content-type', 'text/event-stream')
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'нача' } }] })}\n\n`)
  })
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    apiKey: 'test-key',
  })
  try {
    await run()
  } finally {
    for (const res of hung) res.destroy()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

/** An in-memory store instead of council.ts: attempts per cell and an oracle per cell. */
function memoryDeps(attempts: Record<string, OracleAttempt[]>): CouncilOracleDeps & {
  oracles: Map<string, CouncilOracle>
} {
  const oracles = new Map<string, CouncilOracle>()
  return {
    oracles,
    attemptsOf: (_sessionId, cellId) => attempts[cellId] ?? [],
    oracleOf: (sessionId, cellId) => oracles.get(`${sessionId}:${cellId}`) ?? null,
    setOracle: (sessionId, cellId, oracle) => {
      oracles.set(`${sessionId}:${cellId}`, oracle)
    },
  }
}

/** What would reach the host over the socket: every state, in order. */
const announced: { sessionId: string; cellId: string; oracle: CouncilOracle }[] = []
onCouncilOracle((sessionId, cellId, oracle) => announced.push({ sessionId, cellId, oracle }))

/** Wait until the oracle leaves "reading". */
async function settled(sessionId: string, cellId: string): Promise<CouncilOracle> {
  for (let i = 0; i < 400; i++) {
    const last = announced.filter((a) => a.sessionId === sessionId && a.cellId === cellId).at(-1)
    if (last && last.oracle.state !== 'reading') return last.oracle
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('the oracle never finished reading')
}

let seq = 0

interface Room {
  id: string
  cellId: string
  teacher: string
  student: string
  base: string
  deps: ReturnType<typeof memoryDeps>
  close: () => void
}

const attempt = (
  participantId: string,
  text: string,
  submittedAt: number | null = 1_000,
  name?: string,
): OracleAttempt => ({ participantId, text, submittedAt, run: null, correct: null, name })

/** A room with a task in a cell, a teacher and five sheets. */
async function room(attempts?: OracleAttempt[]): Promise<Room> {
  const id = `oracle-${++seq}`
  createSession(id, 'Консилиум', null)
  const teacher = `p_teacher_${seq}`
  upsertParticipant({
    id: teacher,
    sessionId: id,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  const student = `p_student_${seq}`
  upsertParticipant({
    id: student,
    sessionId: id,
    name: 'Петя',
    avatar: null,
    role: 'participant',
    tokenHost: false,
  })
  const cellId = `c_task_${seq}`
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    getCells(doc).push([
      createCell('markdown', 'Напишите функцию, возвращающую сумму списка.'),
      createCell('code', 'def total(xs):\n    ...', cellId),
    ])
  })
  const deps = memoryDeps({
    [cellId]: attempts ?? [
      attempt('p_a', 'def total(xs):\n    return sum(xs)', 100, 'Анна Белова'),
      attempt('p_b', 'def total(xs):\n  return sum(xs)  # готово', 200, 'Борис Гай'),
      attempt('p_c', 'def total(xs):\n    s = 0\n    for x in xs: s += x\n    return s', 300, 'Вера Ким'),
      attempt('p_d', 'def total(xs):\n    return len(xs)', 400, 'Глеб Орлов'),
      attempt('p_e', 'def total(xs):\n    return', null, 'Дина Рей'),
    ],
  })
  const app = express()
  app.use(councilRoutes(deps))
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  return {
    id,
    cellId,
    teacher,
    student,
    deps,
    base: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  }
}

function ask(r: Room, who: string, method = 'POST', question?: string): Promise<Response> {
  const token = signToken({ sessionId: r.id, participantId: who, role: 'participant' })
  return fetch(`${r.base}/api/sessions/${r.id}/council/${r.cellId}/oracle`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify(question === undefined ? {} : { question }) : undefined,
  })
}

/* --------------------------------------------------------------- frame */

/** A failed run with the given exception name — the "top errors" are measured by it too. */
const crash = (ename: string, evalue = ''): CouncilRun => ({
  state: 'error',
  outputs: [{ kind: 'error', ename, evalue, traceback: [] }],
  execCount: 1,
  ranMs: 12,
  startedAt: 0,
  by: 'host',
})

/** A sheet with an edit time: the frame needs it too — silence is counted by it. */
const sheet = (
  participantId: string,
  text: string,
  extra: Partial<OracleAttempt> = {},
): OracleAttempt => ({
  participantId,
  text,
  submittedAt: null,
  updatedAt: 0,
  run: null,
  correct: null,
  ...extra,
})

const NOW = 1_000_000_000_000
const MIN = 60_000

const CLASS: OracleAttempt[] = [
  sheet('p_a', 'def total(xs):\n    return sum(xs)', {
    name: 'Анна Белова',
    submittedAt: NOW - 6 * MIN,
    updatedAt: NOW - 3 * MIN,
    run: crash('KeyError', "'x'"),
  }),
  sheet('p_b', 'def total(xs):\n    s = 0', { name: 'Борис Гай', updatedAt: NOW - 9 * MIN }),
  sheet('p_c', 'def total(xs):\n    return', { name: 'Вера Ким', updatedAt: NOW - 20_000 }),
  sheet('p_d', 'def total(xs):\n    return sum(xs)', {
    name: 'Глеб Орлов',
    submittedAt: NOW - 4 * MIN,
    updatedAt: NOW - 4 * MIN,
    run: { ...crash('KeyError'), state: 'ok', outputs: [] },
    correct: true,
  }),
]

const TASK = {
  source: 'def total(xs):\n    ...',
  before: 'Напишите сумму списка.',
  reference: null,
}

test('frame with names: numbers for the class, people by name, solutions under their names', () => {
  const frame = oraclePrompt(TASK, CLASS, 'Кто застрял?', {
    now: NOW,
    budget: 20_000,
    names: true,
  })
  const user = frame.turns[1].content

  assert.deepEqual(frame.basedOn, { submitted: 2, drafts: 2 })
  assert.match(user, /КЛАСС: 4 человека с листом — сдали 2, ещё пишут 2/)
  assert.match(user, /с ошибкой 1 \(KeyError — 1\)/)
  assert.match(user, /ОТМЕТКИ преподавателя: верно 1, неверно 0, без отметки 3/)
  assert.match(user, /ТИШИНА: черновиков без правки дольше 5 минут — 1\./)
  assert.match(
    user,
    /Анна Белова · сдал \d\d:\d\d · запуск упал: KeyError — 'x' · 2 строки · правка 3 мин назад/,
  )
  // First those who most likely need help: the failed one, then the silent
  // one, then those for whom everything is going fine. The order is half of
  // the answer to "who is stuck".
  assert.ok(user.indexOf('\nАнна Белова · ') < user.indexOf('\nБорис Гай · '), 'the failed one is above the silent one')
  assert.ok(user.indexOf('\nБорис Гай · ') < user.indexOf('\nГлеб Орлов · '), 'the silent one is above the calm ones')
  // Solutions go by name, not by group: not a single G-number in the frame.
  assert.match(user, /РЕШЕНИЯ ПОИМЁННО:/)
  assert.match(user, /### Анна Белова — сдал /)
  assert.ok(!/### G\d/.test(user), 'groups are left in the frame')
  assert.ok(!/ГРУППАМИ/.test(user), 'groups are left in the frame')
  assert.match(user, /ВОПРОС ПРЕПОДАВАТЕЛЯ:\nКто застрял\?$/)

  // The dictionary goes by the label that stood in the frame: the console
  // makes a chip from it.
  assert.equal(frame.people['Анна Белова'], 'p_a')
  assert.equal(Object.keys(frame.people).length, 4)

  // The system frame tells the model to call people by name and forbids
  // making things up.
  assert.match(frame.turns[0].content, /ИМЕНАМИ/)
  // participantId still does not leave: it is not a name, it is how other
  // people's work is tagged.
  const whole = JSON.stringify(frame.turns)
  for (const id of ['p_a', 'p_b', 'p_c', 'p_d']) assert.ok(!whole.includes(id), id)
})

test('frame without names: labels S1…SN, and not a single name in the prompt', () => {
  const frame = oraclePrompt(TASK, CLASS, 'Кто застрял?', {
    now: NOW,
    budget: 20_000,
    names: false,
  })
  const whole = JSON.stringify(frame.turns)
  assert.deepEqual(frame.people, { S1: 'p_a', S2: 'p_b', S3: 'p_c', S4: 'p_d' })
  assert.match(frame.turns[1].content, /S1 · сдал /)
  for (const name of ['Анна', 'Белова', 'Борис', 'Вера', 'Глеб']) {
    assert.ok(!whole.includes(name), `name ${name} leaked with the setting off`)
  }
  for (const id of ['p_a', 'p_b', 'p_c', 'p_d']) assert.ok(!whole.includes(id), id)
})

test('namesakes are distinguishable: the second Anna gets a number, and the same one is in the dictionary', () => {
  const twins = [
    sheet('p_1', 'x = 1', { name: 'Анна Иванова', submittedAt: 1 }),
    sheet('p_2', 'x = 2', { name: 'Анна Иванова', submittedAt: 2 }),
  ]
  const frame = oraclePrompt(TASK, twins, 'Кто?', { now: NOW, budget: 20_000, names: true })
  assert.deepEqual(frame.people, { 'Анна Иванова': 'p_1', 'Анна Иванова (2)': 'p_2' })
  assert.match(frame.turns[1].content, /Анна Иванова \(2\) · сдал /)
})

test('a person without a name in a frame with names is still called by a label', () => {
  const frame = oraclePrompt(
    TASK,
    [sheet('p_1', 'x = 1', { name: 'Анна Белова' }), sheet('p_2', 'x = 2', { name: null })],
    'Кто?',
    { now: NOW, budget: 20_000, names: true },
  )
  assert.equal(frame.people['Анна Белова'], 'p_1')
  assert.equal(frame.people.S2, 'p_2', 'the nameless one gets a label, not an empty string')
})

test('the budget counts the frame head too, and the tail of the list folds into a count', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    sheet(`p_${String(i).padStart(2, '0')}`, 'x = 1', { updatedAt: NOW - 1_000 }),
  )
  const task = { source: 'x = ?', before: null, reference: null }

  const roomy = oraclePrompt(task, many, 'Как класс?', { now: NOW, budget: 20_000, names: false })
  assert.match(roomy.turns[1].content, /\nS20 · пишет/, 'with a large budget all twenty go')
  assert.ok(!/Ещё \d+ без происшествий/.test(roomy.turns[1].content))

  // A budget smaller than the header alone: not a single line about people is
  // left, but the model must know that the class exists off-frame — otherwise
  // it would say "everyone else is fine" without having the right to.
  const tight = oraclePrompt(task, many, 'Как класс?', { now: NOW, budget: 400, names: false })
  assert.match(tight.turns[1].content, /Ещё 20 без происшествий\./)
  assert.ok(!tight.turns[1].content.includes('\nS1 · '))
  assert.match(tight.turns[1].content, /КЛАСС: 20 человек с листом/, 'the numbers always go')

  /*
   * The frame head is within the budget. It used not to be counted at all: a
   * four-thousand-character task went ON TOP of the ceiling, and a teacher who
   * lowered contextChars for a small model got a request twice the stated
   * size.
   */
  const big = { source: 'y = 2\n'.repeat(1_000), before: null, reference: null }
  const framed = oraclePrompt(big, many, 'Как класс?', { now: NOW, budget: 6_000, names: false })
  assert.ok(framed.chars <= 6_000 + 200, `the frame went over the budget: ${framed.chars}`)
  assert.equal(framed.chars, framed.turns[0].content.length + framed.turns[1].content.length)
})

test('the "instant" level puts a request into the system frame, "normal" puts nothing', () => {
  const plain = oraclePrompt(TASK, CLASS, 'Как класс?', { now: NOW, names: true })
  const fast = oraclePrompt(TASK, CLASS, 'Как класс?', {
    now: NOW,
    names: true,
    effort: 'instant',
  })
  const deep = oraclePrompt(TASK, CLASS, 'Как класс?', { now: NOW, names: true, effort: 'deep' })
  assert.match(fast.turns[0].content, /Отвечай СРАЗУ/)
  assert.ok(!/Отвечай СРАЗУ/.test(plain.turns[0].content))
  assert.equal(
    deep.turns[0].content,
    plain.turns[0].content,
    '"thorough" is a provider parameter, not a line in the frame',
  )
})

test('a row from yesterday\'s seminar is read without the fields that are gone', () => {
  const stored = {
    state: 'ready',
    askedAt: 5,
    basedOn: 3,
    // Fields of the old summary: they are gone from both the protocol and the
    // screen.
    summary: ['а'],
    groupLabels: { k: 'через sum' },
    drafts: { k: 'письмо' },
    error: null,
  } as unknown as CouncilOracle
  const fresh = normalizeOracle(stored)
  assert.deepEqual(fresh.answers, [], 'a row from yesterday\'s seminar must not bring the console down')
  assert.equal(fresh.pending, null)
  assert.equal(fresh.basedOn, 3, 'everything that stayed in the frame is in place')
  assert.ok(!('summary' in fresh), 'the summary must not be dragged through normalization')
  assert.ok(!('groupLabels' in fresh))
  assert.ok(!('drafts' in fresh))

  // The ceiling holds for a row written by a version that counted differently
  // too.
  const long = normalizeOracle({
    ...fresh,
    answers: Array.from({ length: 9 }, (_, i) => ({
      id: `a${i}`,
      question: `в${i}`,
      text: 'ответ',
      askedAt: i,
      basedOn: { submitted: 0, drafts: 0 },
      people: {},
    })),
  })
  assert.equal(long.answers.length, MAX_ORACLE_ANSWERS)
  assert.equal(long.answers[0].id, 'a3', 'the oldest are pushed out')
})

/* --------------------------------------------------------------- route */

test('the answer lands in the feed, with names and a dictionary of labels to people', async () => {
  const r = await room()
  try {
    await withEndpoint('Застряла Вера Ким: цикл без возврата. У Анны Беловой всё считается.', async () => {
      const res = await ask(r, r.teacher, 'POST', '  Кто застрял?  ')
      const started = (await res.json()) as CouncilOracle & { error?: string }
      assert.equal(res.status, 202, started.error ?? '')
      assert.equal(started.state, 'reading')
      assert.equal(started.pending?.question, 'Кто застрял?', 'whitespace at the edges is trimmed')
      assert.equal(started.basedOn, 4, 'it read the four who submitted')

      const ready = await settled(r.id, r.cellId)
      assert.equal(ready.state, 'ready', ready.error ?? '')
      assert.equal(ready.error, null)
      assert.equal(ready.pending, null)
      assert.equal(ready.answers.length, 1)
      const answer = ready.answers[0]
      assert.ok(answer.id.length > 0)
      assert.equal(answer.question, 'Кто застрял?')
      assert.equal(answer.failed, null)
      assert.match(answer.text, /Вера Ким/)
      assert.deepEqual(answer.basedOn, { submitted: 4, drafts: 1 })
      assert.equal(answer.people['Вера Ким'], 'p_c', 'the console makes the chip and the button from the dictionary')
      // The store and the broadcast say the same thing.
      assert.deepEqual(r.deps.oracleOf(r.id, r.cellId), ready)
    })
  } finally {
    r.close()
  }
})

test('names turned off: labels, not names, arrive in the feed', async () => {
  const r = await room()
  try {
    updateOracleSettings({ sendNames: false })
    await withEndpoint('Застрял S3.', async () => {
      assert.equal((await ask(r, r.teacher, 'POST', 'Кто застрял?')).status, 202)
      const ready = await settled(r.id, r.cellId)
      assert.equal(ready.answers[0].people.S3, 'p_c')
      assert.ok(!('Вера Ким' in ready.answers[0].people))
    })
  } finally {
    updateOracleSettings({ sendNames: true })
    r.close()
  }
})

test('not a single sheet — 202, not a refusal: one can always ask about the task', async () => {
  const r = await room([])
  try {
    await withEndpoint('Задание про сумму списка; начните с цикла.', async () => {
      const res = await ask(r, r.teacher, 'POST', 'Что это за задание?')
      assert.equal(res.status, 202, 'the "nobody has written anything" refusal is gone')
      const ready = await settled(r.id, r.cellId)
      assert.equal(ready.state, 'ready', ready.error ?? '')
      assert.equal(ready.answers.length, 1)
      assert.match(ready.answers[0].text, /сумму списка/)
      assert.deepEqual(ready.answers[0].basedOn, { submitted: 0, drafts: 0 })
    })
  } finally {
    r.close()
  }
})

test('without a question — the server\'s preset, one for any client', async () => {
  const r = await room([attempt('p_e', 'x =', null, 'Дина Рей')])
  try {
    await withEndpoint('Дина Рей только начала.', async () => {
      const res = await ask(r, r.teacher)
      assert.equal(res.status, 202)
      const started = (await res.json()) as CouncilOracle
      assert.match(started.pending?.question ?? '', /Как идут дела у класса/)
      const ready = await settled(r.id, r.cellId)
      assert.equal(ready.answers.length, 1)
      assert.equal(ready.answers[0].text, 'Дина Рей только начала.')
    })
  } finally {
    r.close()
  }
})

test('a participant gets 403 in the same words as the sign in the console', async () => {
  const r = await room()
  try {
    await withEndpoint('{}', async () => {
      const res = await ask(r, r.student)
      assert.equal(res.status, 403)
      const body = (await res.json()) as { error: string }
      assert.equal(body.error, 'Консилиум ведёт преподаватель')
    })
  } finally {
    r.close()
  }
})

test('the room ceiling holds the teacher too — 429 with a number', async () => {
  const r = await room()
  try {
    await withEndpoint('{}', async () => {
      updateOracleSettings({ questionsPerHour: 1 })
      for (let i = 0; i < 30; i++) {
        recordQuestion({ sessionId: r.id, participantId: `p_tab_${i}`, action: 'ask' })
      }
      const res = await ask(r, r.teacher)
      assert.equal(res.status, 429)
      assert.equal(res.headers.get('retry-after'), '600')
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /лимит занятия: 30 вопросов/)
      updateOracleSettings({ questionsPerHour: 20 })
    })
  } finally {
    r.close()
  }
})

test('the oracle is off on the instance — a refusal in words, without a trip to the model', async () => {
  const r = await room()
  try {
    await withEndpoint('{}', async () => {
      updateOracleSettings({ defaultMode: 'off' })
      const res = await ask(r, r.teacher)
      assert.equal(res.status, 403)
      assert.match(((await res.json()) as { error: string }).error, /отключён/)
      updateOracleSettings({ defaultMode: 'full' })
    })
  } finally {
    r.close()
  }
})

test('a question longer than 500 characters is cut on receipt, not in the browser', async () => {
  const r = await room()
  try {
    await withEndpoint('коротко', async () => {
      const res = await ask(r, r.teacher, 'POST', 'я'.repeat(900))
      assert.equal(res.status, 202)
      const started = (await res.json()) as CouncilOracle
      assert.equal(started.pending?.question.length, 500, 'maxlength holds the keyboard, not a paste')
      await settled(r.id, r.cellId)
    })
  } finally {
    r.close()
  }
})

test('the feed keeps no more than six turns', async () => {
  const r = await room()
  try {
    await withEndpoint('ответ', async () => {
      for (let i = 1; i <= MAX_ORACLE_ANSWERS + 1; i++) {
        assert.equal((await ask(r, r.teacher, 'POST', `вопрос ${i}`)).status, 202)
        await settled(r.id, r.cellId)
      }
      const full = r.deps.oracleOf(r.id, r.cellId)
      assert.equal(full?.answers.length, MAX_ORACLE_ANSWERS)
      assert.equal(full?.answers[0].question, 'вопрос 2', 'the oldest turn is pushed out')
      assert.equal(full?.answers.at(-1)?.question, `вопрос ${MAX_ORACLE_ANSWERS + 1}`)
    })
  } finally {
    r.close()
  }
})

/* ---------------------------------------------------- "Stop" and deadlines */

test('"Stop" keeps the feed, does not paint it as an error and releases the cell', async () => {
  const r = await room()
  try {
    await withEndpoint('первый ответ', async () => {
      assert.equal((await ask(r, r.teacher, 'POST', 'первый вопрос')).status, 202)
      assert.equal((await settled(r.id, r.cellId)).state, 'ready')
    })
    await withStuckEndpoint('silent', async () => {
      const before = announced.length
      assert.equal((await ask(r, r.teacher, 'POST', 'второй вопрос')).status, 202)
      // While it reads, a second question is not accepted: one key, one
      // reading.
      assert.equal((await ask(r, r.teacher, 'POST', 'третий')).status, 409)
      assert.equal((await ask(r, r.teacher, 'DELETE')).status, 200)
      const after = await settled(r.id, r.cellId)
      assert.equal(after.state, 'ready')
      assert.equal(after.answers.length, 1, 'the earlier conversation is lost')
      assert.equal(after.answers[0].question, 'первый вопрос')
      assert.equal(after.error, null, 'stopping by hand is not an error')
      assert.ok(announced.length > before)
      // And right after "Stop" one can ask: 409 no longer locks the cell.
      assert.equal(isOracleReading(r.id, r.cellId), false)
    })
    await withEndpoint('третий ответ', async () => {
      assert.equal((await ask(r, r.teacher, 'POST', 'снова')).status, 202)
      const again = await settled(r.id, r.cellId)
      assert.equal(again.answers.at(-1)?.text, 'третий ответ')
    })
  } finally {
    r.close()
  }
})

test('"Stop" tidies up a cell stuck in "reading" with no reading going on', () => {
  const store: OracleStore & { oracle: CouncilOracle | null } = {
    oracle: {
      state: 'reading',
      askedAt: 1,
      basedOn: 2,
      error: null,
      answers: [],
      pending: { question: 'повисший вопрос', askedAt: 1 },
    },
    oracleOf: () => store.oracle,
    setOracle: (_s, _c, oracle) => {
      store.oracle = oracle
    },
  }
  // There is nothing to abort — and that is exactly the case "Stop" gets
  // pressed for: before the fix it did nothing, and the next question got 409
  // forever.
  assert.equal(stopCouncilOracle('ghost', 'c1', store), false)
  assert.equal(store.oracle?.state, 'idle')
  assert.equal(store.oracle?.pending, null)
})

test('the provider is silent — a clear error in the feed, within the deadline', async () => {
  const store: OracleStore & { oracle: CouncilOracle | null } = {
    oracle: null,
    oracleOf: () => store.oracle,
    setOracle: (_s, _c, oracle) => {
      store.oracle = oracle
    },
  }
  await withStuckEndpoint('silent', async () => {
    const usageId = recordQuestion({ sessionId: 'quiet', participantId: 'p_t', action: 'council' })
    const before = countRoomQuestions('quiet', 3_600_000)
    const began = Date.now()
    askCouncilOracle({
      sessionId: 'quiet',
      cellId: 'c1',
      task: TASK,
      attempts: CLASS,
      store,
      usageId,
      question: 'Как класс?',
      times: { openingMs: 200, silenceMs: 100, capMs: 500 },
    })
    for (let i = 0; i < 200 && store.oracle?.state === 'reading'; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.notEqual(store.oracle?.state, 'reading', 'it hung instead of refusing')
    assert.ok(Date.now() - began < 2_000, 'the watchdog did not fire in time')
    // The question stays in the feed together with the cause: there is
    // something to repeat.
    const last = store.oracle?.answers.at(-1)
    assert.equal(last?.question, 'Как класс?')
    assert.match(last?.failed ?? '', /не ответила за отведённое время/)
    assert.match(store.oracle?.error ?? '', /не ответила за отведённое время/)
    assert.equal(isOracleReading('quiet', 'c1'), false, 'the entry in the `reading` map remained')
    // A question wasted for nothing does not eat into the room's hourly limit.
    assert.equal(countRoomQuestions('quiet', 3_600_000), before - 1)
  })
})

test('the provider went quiet halfway — a different phrase, and also within the deadline', async () => {
  const store: OracleStore & { oracle: CouncilOracle | null } = {
    oracle: null,
    oracleOf: () => store.oracle,
    setOracle: (_s, _c, oracle) => {
      store.oracle = oracle
    },
  }
  await withStuckEndpoint('half', async () => {
    askCouncilOracle({
      sessionId: 'half',
      cellId: 'c1',
      task: TASK,
      attempts: CLASS,
      store,
      question: 'Как класс?',
      times: { openingMs: 2_000, silenceMs: 150, capMs: 3_000 },
    })
    for (let i = 0; i < 200 && store.oracle?.state === 'reading'; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.notEqual(store.oracle?.state, 'reading', 'it hung instead of refusing')
    const last = store.oracle?.answers.at(-1)
    assert.match(
      last?.failed ?? '',
      /перестала отправлять ответ/,
      'an opened stream that went quiet is not the same as one never opened',
    )
    assert.equal(isOracleReading('half', 'c1'), false)
  })
})

test('the names setting is on by default — the owner asked for it', () => {
  assert.equal(getOracleSettings().sendNames, true)
})
