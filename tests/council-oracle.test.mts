/**
 * Оракул о классе — что он отдаёт преподавателю, кого не пускает и чем
 * кончается, когда провайдер молчит.
 *
 * Три вещи ломаются молча, и все три проверяются здесь.
 *
 * ИМЕНА. В кадр уезжают настоящие имена — это выбор владельца, и обещание
 * обратного стояло в шапке ai/council.ts, в подписи пульта и в документации.
 * Выключенная настройка инстанса возвращает метки S1…SN, и тогда в промпт не
 * должно попасть ни имени, ни participantId. Обе стороны проверяются, потому
 * что «включили и не заметили» и «выключили, а оно уехало» — одинаково плохо.
 *
 * МОЛЧАНИЕ. Провайдер, который открыл поток и замолчал (или не открыл вовсе),
 * повесил живое занятие 20.09: ни ответа, ни ошибки, ни строки в журнале, а
 * ячейка осталась запертой на 409 до перезапуска сервера. Сроки сторожа тест
 * подставляет короткие — иначе проверка стоила бы трёх минут ожидания.
 *
 * ГРУПП НЕТ. Ни G-номеров в кадре, ни подписей группам, ни черновика письма
 * группе: преподаватель читает класс поимённо.
 *
 * Шлюз поддельный, комната настоящая; попытки — списком в памяти, потому что
 * таблица попыток живёт у council.ts и меняется отдельно от маршрута.
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

/* ------------------------------------------------------------ подделки */

/**
 * Поддельный OpenAI-совместимый шлюз: отдаёт заданный текст одним кадром SSE.
 * Настоящий SDK разбирает его сам — подделывается только эндпоинт.
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
 * Шлюз, который ведёт себя плохо: либо не отвечает вовсе, либо начинает ответ
 * и замолкает на середине. Ровно те два случая, ради которых заведён сторож.
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

/** Хранилище в памяти вместо council.ts: попытки по ячейке и оракул по ячейке. */
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

/** Что приехало бы хосту сокетом: все состояния по порядку. */
const announced: { sessionId: string; cellId: string; oracle: CouncilOracle }[] = []
onCouncilOracle((sessionId, cellId, oracle) => announced.push({ sessionId, cellId, oracle }))

/** Дождаться, пока оракул выйдет из «читает». */
async function settled(sessionId: string, cellId: string): Promise<CouncilOracle> {
  for (let i = 0; i < 400; i++) {
    const last = announced.filter((a) => a.sessionId === sessionId && a.cellId === cellId).at(-1)
    if (last && last.oracle.state !== 'reading') return last.oracle
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('оракул так и не дочитал')
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

/** Комната с заданием в ячейке, преподавателем и пятью листами. */
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

/* ---------------------------------------------------------------- кадр */

/** Упавший запуск с заданным именем исключения — им же меряются «топ ошибок». */
const crash = (ename: string, evalue = ''): CouncilRun => ({
  state: 'error',
  outputs: [{ kind: 'error', ename, evalue, traceback: [] }],
  execCount: 1,
  ranMs: 12,
  startedAt: 0,
  by: 'host',
})

/** Лист с временем правки: кадру нужно и оно — по нему считается тишина. */
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

test('кадр с именами: числа по классу, люди поимённо, решения под их именами', () => {
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
  // Сначала те, кому вероятнее нужна помощь: упавший, потом молчащий, потом
  // те, у кого всё идёт. Порядок — это и есть половина ответа на «кто застрял».
  assert.ok(user.indexOf('\nАнна Белова · ') < user.indexOf('\nБорис Гай · '), 'упавший выше молчащего')
  assert.ok(user.indexOf('\nБорис Гай · ') < user.indexOf('\nГлеб Орлов · '), 'молчащий выше спокойных')
  // Решения — поимённо, а не группами: ни одного G-номера в кадре.
  assert.match(user, /РЕШЕНИЯ ПОИМЁННО:/)
  assert.match(user, /### Анна Белова — сдал /)
  assert.ok(!/### G\d/.test(user), 'в кадре остались группы')
  assert.ok(!/ГРУППАМИ/.test(user), 'в кадре остались группы')
  assert.match(user, /ВОПРОС ПРЕПОДАВАТЕЛЯ:\nКто застрял\?$/)

  // Словарь — по подписи, которая стояла в кадре: по нему пульт делает чип.
  assert.equal(frame.people['Анна Белова'], 'p_a')
  assert.equal(Object.keys(frame.people).length, 4)

  // Системный кадр велит звать людей по имени и запрещает выдумывать.
  assert.match(frame.turns[0].content, /ИМЕНАМИ/)
  // participantId по-прежнему не уезжает: он не имя, а разметка чужих работ.
  const whole = JSON.stringify(frame.turns)
  for (const id of ['p_a', 'p_b', 'p_c', 'p_d']) assert.ok(!whole.includes(id), id)
})

test('кадр без имён: метки S1…SN, и ни одного имени в промпте', () => {
  const frame = oraclePrompt(TASK, CLASS, 'Кто застрял?', {
    now: NOW,
    budget: 20_000,
    names: false,
  })
  const whole = JSON.stringify(frame.turns)
  assert.deepEqual(frame.people, { S1: 'p_a', S2: 'p_b', S3: 'p_c', S4: 'p_d' })
  assert.match(frame.turns[1].content, /S1 · сдал /)
  for (const name of ['Анна', 'Белова', 'Борис', 'Вера', 'Глеб']) {
    assert.ok(!whole.includes(name), `имя ${name} уехало при выключенной настройке`)
  }
  for (const id of ['p_a', 'p_b', 'p_c', 'p_d']) assert.ok(!whole.includes(id), id)
})

test('тёзки различимы: второй Анне дописан номер, и он же стоит в словаре', () => {
  const twins = [
    sheet('p_1', 'x = 1', { name: 'Анна Иванова', submittedAt: 1 }),
    sheet('p_2', 'x = 2', { name: 'Анна Иванова', submittedAt: 2 }),
  ]
  const frame = oraclePrompt(TASK, twins, 'Кто?', { now: NOW, budget: 20_000, names: true })
  assert.deepEqual(frame.people, { 'Анна Иванова': 'p_1', 'Анна Иванова (2)': 'p_2' })
  assert.match(frame.turns[1].content, /Анна Иванова \(2\) · сдал /)
})

test('человек без имени в кадре с именами всё равно зовётся меткой', () => {
  const frame = oraclePrompt(
    TASK,
    [sheet('p_1', 'x = 1', { name: 'Анна Белова' }), sheet('p_2', 'x = 2', { name: null })],
    'Кто?',
    { now: NOW, budget: 20_000, names: true },
  )
  assert.equal(frame.people['Анна Белова'], 'p_1')
  assert.equal(frame.people.S2, 'p_2', 'безымянный получает метку, а не пустую строку')
})

test('бюджет считает и голову кадра, а хвост списка сворачивается в счёт', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    sheet(`p_${String(i).padStart(2, '0')}`, 'x = 1', { updatedAt: NOW - 1_000 }),
  )
  const task = { source: 'x = ?', before: null, reference: null }

  const roomy = oraclePrompt(task, many, 'Как класс?', { now: NOW, budget: 20_000, names: false })
  assert.match(roomy.turns[1].content, /\nS20 · пишет/, 'при большом бюджете едут все двадцать')
  assert.ok(!/Ещё \d+ без происшествий/.test(roomy.turns[1].content))

  // Бюджет меньше одной только шапки: строк по людям не остаётся ни одной, но
  // модель обязана знать, что класс за кадром есть, — иначе «у всех остальных
  // всё хорошо» она скажет, не имея на это права.
  const tight = oraclePrompt(task, many, 'Как класс?', { now: NOW, budget: 400, names: false })
  assert.match(tight.turns[1].content, /Ещё 20 без происшествий\./)
  assert.ok(!tight.turns[1].content.includes('\nS1 · '))
  assert.match(tight.turns[1].content, /КЛАСС: 20 человек с листом/, 'числа едут всегда')

  /*
   * Голова кадра — в бюджете. Раньше она не считалась вовсе: задание на четыре
   * тысячи знаков уезжало СВЕРХ потолка, и преподаватель, опустивший
   * contextChars под маленькую модель, получал запрос вдвое больше названного.
   */
  const big = { source: 'y = 2\n'.repeat(1_000), before: null, reference: null }
  const framed = oraclePrompt(big, many, 'Как класс?', { now: NOW, budget: 6_000, names: false })
  assert.ok(framed.chars <= 6_000 + 200, `кадр вылез за бюджет: ${framed.chars}`)
  assert.equal(framed.chars, framed.turns[0].content.length + framed.turns[1].content.length)
})

test('уровень «сразу» кладёт просьбу в системный кадр, «обычно» — ничего', () => {
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
    '«подробно» — это параметр провайдера, а не строка в кадре',
  )
})

test('строка вчерашнего семинара читается без полей, которых больше нет', () => {
  const stored = {
    state: 'ready',
    askedAt: 5,
    basedOn: 3,
    // Поля прежней сводки: их больше нет ни в протоколе, ни на экране.
    summary: ['а'],
    groupLabels: { k: 'через sum' },
    drafts: { k: 'письмо' },
    error: null,
  } as unknown as CouncilOracle
  const fresh = normalizeOracle(stored)
  assert.deepEqual(fresh.answers, [], 'строка вчерашнего семинара не должна ронять пульт')
  assert.equal(fresh.pending, null)
  assert.equal(fresh.basedOn, 3, 'всё, что осталось в кадре, на месте')
  assert.ok(!('summary' in fresh), 'сводка не должна протаскиваться через нормализацию')
  assert.ok(!('groupLabels' in fresh))
  assert.ok(!('drafts' in fresh))

  // Потолок держится и у строки, записанной версией, считавшей иначе.
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
  assert.equal(long.answers[0].id, 'a3', 'вытесняются самые старые')
})

/* ------------------------------------------------------------- маршрут */

test('ответ ложится в ленту, с именами и словарём подписей к людям', async () => {
  const r = await room()
  try {
    await withEndpoint('Застряла Вера Ким: цикл без возврата. У Анны Беловой всё считается.', async () => {
      const res = await ask(r, r.teacher, 'POST', '  Кто застрял?  ')
      const started = (await res.json()) as CouncilOracle & { error?: string }
      assert.equal(res.status, 202, started.error ?? '')
      assert.equal(started.state, 'reading')
      assert.equal(started.pending?.question, 'Кто застрял?', 'пробелы по краям срезаны')
      assert.equal(started.basedOn, 4, 'читала четверых сдавших')

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
      assert.equal(answer.people['Вера Ким'], 'p_c', 'по словарю пульт делает чип и кнопку')
      // Хранилище и рассылка говорят одно и то же.
      assert.deepEqual(r.deps.oracleOf(r.id, r.cellId), ready)
    })
  } finally {
    r.close()
  }
})

test('выключенные имена: в ленту приезжают метки, а не имена', async () => {
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

test('ни одного листа — 202, а не отказ: спросить о задании можно всегда', async () => {
  const r = await room([])
  try {
    await withEndpoint('Задание про сумму списка; начните с цикла.', async () => {
      const res = await ask(r, r.teacher, 'POST', 'Что это за задание?')
      assert.equal(res.status, 202, 'отказ «никто ничего не написал» снят')
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

test('без вопроса — заготовка сервера, одна для любого клиента', async () => {
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

test('участнику — 403 теми же словами, что и признак в пульте', async () => {
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

test('комнатный потолок держит и преподавателя — 429 с числом', async () => {
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

test('оракул выключен на инстансе — отказ словами, без похода к модели', async () => {
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

test('вопрос длиннее 500 знаков режется на приёме, а не в браузере', async () => {
  const r = await room()
  try {
    await withEndpoint('коротко', async () => {
      const res = await ask(r, r.teacher, 'POST', 'я'.repeat(900))
      assert.equal(res.status, 202)
      const started = (await res.json()) as CouncilOracle
      assert.equal(started.pending?.question.length, 500, 'maxlength держит клавиатуру, не вставку')
      await settled(r.id, r.cellId)
    })
  } finally {
    r.close()
  }
})

test('лента копит не больше шести ходов', async () => {
  const r = await room()
  try {
    await withEndpoint('ответ', async () => {
      for (let i = 1; i <= MAX_ORACLE_ANSWERS + 1; i++) {
        assert.equal((await ask(r, r.teacher, 'POST', `вопрос ${i}`)).status, 202)
        await settled(r.id, r.cellId)
      }
      const full = r.deps.oracleOf(r.id, r.cellId)
      assert.equal(full?.answers.length, MAX_ORACLE_ANSWERS)
      assert.equal(full?.answers[0].question, 'вопрос 2', 'самый старый ход вытеснен')
      assert.equal(full?.answers.at(-1)?.question, `вопрос ${MAX_ORACLE_ANSWERS + 1}`)
    })
  } finally {
    r.close()
  }
})

/* ---------------------------------------------------------- «Стоп» и сроки */

test('«Стоп» сохраняет ленту, не красит ошибкой и отпускает ячейку', async () => {
  const r = await room()
  try {
    await withEndpoint('первый ответ', async () => {
      assert.equal((await ask(r, r.teacher, 'POST', 'первый вопрос')).status, 202)
      assert.equal((await settled(r.id, r.cellId)).state, 'ready')
    })
    await withStuckEndpoint('silent', async () => {
      const before = announced.length
      assert.equal((await ask(r, r.teacher, 'POST', 'второй вопрос')).status, 202)
      // Пока читает — второй вопрос не принимается: один ключ, одно чтение.
      assert.equal((await ask(r, r.teacher, 'POST', 'третий')).status, 409)
      assert.equal((await ask(r, r.teacher, 'DELETE')).status, 200)
      const after = await settled(r.id, r.cellId)
      assert.equal(after.state, 'ready')
      assert.equal(after.answers.length, 1, 'прежний разговор потерян')
      assert.equal(after.answers[0].question, 'первый вопрос')
      assert.equal(after.error, null, 'остановка рукой — не ошибка')
      assert.ok(announced.length > before)
      // И сразу после «Стоп» спросить можно: 409 больше не запирает ячейку.
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

test('«Стоп» приводит в порядок ячейку, застрявшую в «читает» без чтения', () => {
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
  // Обрывать нечего — и это как раз тот случай, ради которого «Стоп» и жмут:
  // до правки он не делал ничего, а следующий вопрос получал 409 навсегда.
  assert.equal(stopCouncilOracle('ghost', 'c1', store), false)
  assert.equal(store.oracle?.state, 'idle')
  assert.equal(store.oracle?.pending, null)
})

test('провайдер молчит — понятная ошибка в ленте, в пределах срока', async () => {
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
    assert.notEqual(store.oracle?.state, 'reading', 'повисло вместо отказа')
    assert.ok(Date.now() - began < 2_000, 'сторож не сработал в срок')
    // Вопрос остаётся в ленте вместе с причиной: повторить есть что.
    const last = store.oracle?.answers.at(-1)
    assert.equal(last?.question, 'Как класс?')
    assert.match(last?.failed ?? '', /не ответила за отведённое время/)
    assert.match(store.oracle?.error ?? '', /не ответила за отведённое время/)
    assert.equal(isOracleReading('quiet', 'c1'), false, 'запись в карте `reading` осталась')
    // Потраченный впустую вопрос не съедает часовой лимит комнаты.
    assert.equal(countRoomQuestions('quiet', 3_600_000), before - 1)
  })
})

test('провайдер замолк на середине — другая фраза, и тоже в срок', async () => {
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
    assert.notEqual(store.oracle?.state, 'reading', 'повисло вместо отказа')
    const last = store.oracle?.answers.at(-1)
    assert.match(
      last?.failed ?? '',
      /перестала отправлять ответ/,
      'открытый и замолчавший поток — не то же самое, что неоткрытый',
    )
    assert.equal(isOracleReading('half', 'c1'), false)
  })
})

test('настройка имён по умолчанию включена — так просил владелец', () => {
  assert.equal(getOracleSettings().sendNames, true)
})
