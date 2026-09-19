/**
 * Оракул о решениях — что он отдаёт преподавателю и кого не пускает.
 *
 * Две вещи ломаются молча. Модель, не умеющая в строгий JSON, отвечает
 * прозой — и сводка, которая на этом падала бы, оставляла преподавателя с
 * красной ошибкой посреди пары; здесь проверяется, что три абзаца остаются, а
 * имена групп просто пустые. И имена: модели уезжают G-номера, а к пульту
 * возвращаются настоящие ключи групп — перепутанный индекс подписал бы группу
 * чужим именем, и ни один тип этого не заметил бы.
 *
 * Шлюз поддельный, комната настоящая; попытки — списком в памяти, потому что
 * таблица попыток живёт у council.ts и меняется отдельно от маршрута.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { createCell, getCells, normalizeAttempt } from '../shared/notebook.js'
import type { CouncilOracle } from '../shared/protocol.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { recordQuestion } from '../server/src/admin/usage.js'
import { signToken } from '../server/src/auth.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import type { CouncilRun } from '../shared/protocol.js'
import {
  groupsOf,
  MAX_ORACLE_ANSWERS,
  normalizeOracle,
  onCouncilOracle,
  parseOracleAnswer,
  statusPrompt,
  type OracleAttempt,
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
  for (let i = 0; i < 200; i++) {
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
): OracleAttempt => ({ participantId, text, submittedAt, run: null, correct: null })

/** Комната с заданием в ячейке, преподавателем и тремя группами решений. */
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
      attempt('p_a', 'def total(xs):\n    return sum(xs)', 100),
      attempt('p_b', 'def total(xs):\n  return sum(xs)  # готово', 200),
      attempt('p_c', 'def total(xs):\n    s = 0\n    for x in xs: s += x\n    return s', 300),
      attempt('p_d', 'def total(xs):\n    return len(xs)', 400),
      attempt('p_e', 'def total(xs):\n    return', null),
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

/* ------------------------------------------------------- кадр о классе */

/** Упавший запуск с заданным именем исключения — им же меряются «топ ошибок». */
const crash = (ename: string, evalue = ''): CouncilRun => ({
  state: 'error',
  outputs: [{ kind: 'error', ename, evalue, traceback: [] }],
  execCount: 1,
  ranMs: 12,
  startedAt: 0,
  by: 'host',
})

/** Лист с временем правки: кадру о классе нужно и оно — по нему считается тишина. */
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

/* --------------------------------------------------------- чистый разбор */

test('группы — только сданные, одинаковый текст сходится по normalizeAttempt', () => {
  const groups = groupsOf([
    attempt('p_a', 'x = 1', 100),
    attempt('p_b', 'x=1  # ответ', 200),
    attempt('p_c', 'x = 2', 300),
    attempt('p_d', 'x = 1', null),
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0].count, 2, 'большая группа первой')
  assert.equal(groups[0].representative, 'p_a', 'представитель — самый ранний сдавший')
  assert.deepEqual(groups[0].members, ['p_a', 'p_b'])
  assert.equal(groups[0].key, normalizeAttempt('x = 1'))
  assert.equal(groups[1].members.length, 1)

  // Состояние группы — по всем членам, как у пульта: отметка или падение у
  // не-представителя иначе делали бы сводку и полосу разными.
  const failed = {
    state: 'error' as const,
    outputs: [{ kind: 'error' as const, ename: 'TypeError', evalue: 'bad', traceback: [] }],
    execCount: 1,
    ranMs: 1,
    startedAt: 0,
    by: 'host' as const,
  }
  const [mixed] = groupsOf([
    attempt('p_a', 'x = 1', 100),
    { ...attempt('p_b', 'x = 1', 200), run: failed },
  ])
  assert.equal(mixed.representative, 'p_a')
  assert.equal(mixed.status, 'failed')
  const [marked] = groupsOf([
    attempt('p_a', 'x = 1', 100),
    { ...attempt('p_b', 'x = 1', 200), run: failed, correct: true },
  ])
  assert.equal(marked.status, 'correct')
})

test('разбор: G-номера возвращаются ключами групп, лишние номера отбрасываются', () => {
  const keys = ['k1', 'k2']
  const parsed = parseOracleAnswer(
    'Вот ответ:\n```json\n' +
      JSON.stringify({
        summary: ['верно', 'ошибка', 'показать'],
        groupLabels: { G1: 'через sum', g2: 'цикл', G7: 'выдумано' },
        drafts: { G2: 'Посмотрите на накопитель.' },
        // Модель может прислать что угодно сверх спрошенного — лишнее просто
        // не разбирается (см. ParsedOracle: «примечательное» больше не просят).
        notable: [{ key: 'G2', why: 'вручную' }],
      }) +
      '\n```',
    keys,
  )
  assert.deepEqual(parsed.summary, ['верно', 'ошибка', 'показать'])
  assert.deepEqual(parsed.groupLabels, { k1: 'через sum', k2: 'цикл' })
  assert.deepEqual(parsed.drafts, { k2: 'Посмотрите на накопитель.' })
})

test('разбор: проза вместо JSON — сводка абзацами, имена и черновики пусты', () => {
  const parsed = parseOracleAnswer(
    'Большинство решило через sum.\n\nТипичная ошибка — len вместо суммы.\n\nПоказать стоит цикл.\n\nЧетвёртый абзац лишний.',
    ['k1'],
  )
  assert.equal(parsed.summary.length, 3)
  assert.match(parsed.summary[1], /len/)
  assert.deepEqual(parsed.groupLabels, {})
  assert.deepEqual(parsed.drafts, {})
})

test('кадр статуса: числа по классу, порядок «сначала проблемные», ни одного id', () => {
  const now = 1_000_000_000_000
  const min = 60_000
  const frame = statusPrompt(
    { source: 'def total(xs):\n    ...', before: 'Напишите сумму списка.', reference: null },
    [
      sheet('p_a', 'def total(xs):\n    return sum(xs)', {
        submittedAt: now - 6 * min,
        updatedAt: now - 3 * min,
        run: crash('KeyError', "'x'"),
      }),
      sheet('p_b', 'def total(xs):\n    s = 0', { updatedAt: now - 9 * min }),
      sheet('p_c', 'def total(xs):\n    return', { updatedAt: now - 20_000 }),
      sheet('p_d', 'def total(xs):\n    return sum(xs)', {
        submittedAt: now - 4 * min,
        updatedAt: now - 4 * min,
        run: { ...crash('KeyError'), state: 'ok', outputs: [] },
        correct: true,
      }),
    ],
    'Кто застрял?',
    now,
    20_000,
  )
  const user = frame.turns[1].content

  assert.deepEqual(frame.basedOn, { submitted: 2, drafts: 2 })
  assert.deepEqual(frame.people, { S1: 'p_a', S2: 'p_b', S3: 'p_c', S4: 'p_d' })
  assert.match(user, /КЛАСС: 4 человека с листом — сдали 2, ещё пишут 2/)
  assert.match(user, /с ошибкой 1 \(KeyError — 1\)/)
  assert.match(user, /ОТМЕТКИ преподавателя: верно 1, неверно 0, без отметки 3/)
  assert.match(user, /ТИШИНА: черновиков без правки дольше 5 минут — 1\./)
  // Номер группы стоит в строке человека: без него «в какой группе ошибка»
  // и «кому о ней сказать» — два ответа, которые модель не может связать.
  assert.match(
    user,
    /S1 · сдал \d\d:\d\d, G1 · запуск упал: KeyError — 'x' · 2 строки · правка 3 мин назад/,
  )
  // Сначала те, кому вероятнее нужна помощь: упавший, потом молчащий, потом
  // те, у кого всё идёт. Порядок — это и есть половина ответа на «кто застрял».
  assert.ok(user.indexOf('\nS1 · ') < user.indexOf('\nS2 · '), 'упавший выше молчащего')
  assert.ok(user.indexOf('\nS2 · ') < user.indexOf('\nS3 · '), 'молчащий выше остальных')
  // Код едет обоими способами: группы сданных и листы тех, у кого что-то было.
  // Дважды — никогда: сданная попытка уже уехала своей группой, и второй её
  // блок стоил бы места, на котором иначе поместился бы чей-то черновик.
  assert.match(user, /### G1 — 2 человека/)
  assert.ok(!user.includes('### S1 —'), 'код S1 уехал дважды: группой и листом')
  assert.match(user, /### S2 — пишет/, 'черновик молчащего в кадр не поехал')
  assert.match(user, /ВОПРОС ПРЕПОДАВАТЕЛЯ:\nКто застрял\?$/)

  // Обещание шапки ai/council.ts: в промпт чужого провайдера не уезжает ничего,
  // по чему человека можно назвать. Имени у попытки нет вовсе, id — есть.
  const whole = JSON.stringify(frame.turns)
  for (const id of ['p_a', 'p_b', 'p_c', 'p_d']) assert.ok(!whole.includes(id), id)
})

test('кадр статуса: хвост списка сворачивается в счёт, когда бюджет кончился', () => {
  const now = 1_000_000_000_000
  const many = Array.from({ length: 20 }, (_, i) =>
    sheet(`p_${String(i).padStart(2, '0')}`, 'x = 1', { updatedAt: now - 1_000 }),
  )
  const task = { source: 'x = ?', before: null, reference: null }

  const roomy = statusPrompt(task, many, 'Как класс?', now, 20_000).turns[1].content
  assert.match(roomy, /\nS20 · пишет/, 'при большом бюджете едут все двадцать')
  assert.ok(!/Ещё \d+ без происшествий/.test(roomy))

  // Бюджет меньше одной только шапки: строк по людям не остаётся ни одной, но
  // модель обязана знать, что класс за кадром есть, — иначе «у всех остальных
  // всё хорошо» она скажет, не имея на это права.
  const tight = statusPrompt(task, many, 'Как класс?', now, 400).turns[1].content
  assert.match(tight, /Ещё 20 без происшествий\./)
  assert.ok(!tight.includes('\nS1 · '))
  assert.match(tight, /КЛАСС: 20 человек с листом/, 'числа едут всегда — на них кадр и держится')
})

test('оракул, записанный до ленты вопросов, читается пустой лентой', () => {
  const stored = {
    state: 'ready',
    askedAt: 5,
    basedOn: 3,
    summary: ['а'],
    groupLabels: {},
    drafts: {},
    error: null,
  } as unknown as CouncilOracle
  const fresh = normalizeOracle(stored)
  assert.deepEqual(fresh.answers, [], 'строка вчерашнего семинара не должна ронять пульт')
  assert.equal(fresh.pending, null)
  assert.deepEqual(fresh.summary, ['а'], 'всё остальное на месте')

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

test('JSON от модели → оракул готов: три абзаца и имена по ключам групп', async () => {
  const r = await room()
  try {
    const answer = JSON.stringify({
      summary: ['Все три группы поняли, что нужна сумма.', 'G3 вернула длину.', 'Показать G2.'],
      groupLabels: { G1: 'через sum()', G2: 'цикл с накопителем', G3: 'len вместо суммы' },
      drafts: { G3: 'Вы вернули длину списка, а не сумму его элементов.' },
    })
    await withEndpoint(answer, async () => {
      const res = await ask(r, r.teacher)
      const started = (await res.json()) as CouncilOracle & { error?: string }
      assert.equal(res.status, 202, started.error ?? '')
      assert.equal(started.state, 'reading')
      // Читала четырёх сдавших; пятый ещё пишет и в счёт не идёт.
      assert.equal(started.basedOn, 4)

      const ready = await settled(r.id, r.cellId)
      assert.equal(ready.state, 'ready', ready.error ?? '')
      assert.equal(ready.error, null)
      assert.equal(ready.summary.length, 3)
      assert.equal(ready.basedOn, 4)

      const sumKey = normalizeAttempt('def total(xs):\n    return sum(xs)')
      const loopKey = normalizeAttempt(
        'def total(xs):\n    s = 0\n    for x in xs: s += x\n    return s',
      )
      const lenKey = normalizeAttempt('def total(xs):\n    return len(xs)')
      assert.deepEqual(ready.groupLabels, {
        [sumKey]: 'через sum()',
        [loopKey]: 'цикл с накопителем',
        [lenKey]: 'len вместо суммы',
      })
      assert.deepEqual(Object.keys(ready.drafts), [lenKey])
      // «Примечательное» с кадра снято целиком — ни промпта, ни разбора, ни
      // поля: нарисовать его было негде, а токены в самом дорогом запросе
      // комнаты оно стоило. Поэтому здесь его больше и не проверяют.
      // Хранилище и рассылка говорят одно и то же.
      assert.deepEqual(r.deps.oracleOf(r.id, r.cellId), ready)
    })
  } finally {
    r.close()
  }
})

test('битый JSON → сводка есть, имена групп пусты, ошибки нет', async () => {
  const r = await room()
  try {
    const answer =
      'Почти все решили через sum.\n\nОдна группа вернула длину — это и есть типичная ошибка.\n\nПокажите цикл: он объясняет, что делает sum.\n{"summary": [оборвано'
    await withEndpoint(answer, async () => {
      assert.equal((await ask(r, r.teacher)).status, 202)
      const ready = await settled(r.id, r.cellId)
      assert.equal(ready.state, 'ready')
      assert.equal(ready.error, null, 'проза вместо JSON — не ошибка')
      assert.ok(
        ready.summary.length >= 1 && ready.summary.length <= 3,
        JSON.stringify(ready.summary),
      )
      assert.match(ready.summary[0], /sum/)
      assert.deepEqual(ready.groupLabels, {})
      assert.deepEqual(ready.drafts, {})
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

test('сдавших нет — не отказ, а вопрос о статусе заготовкой сервера', async () => {
  const r = await room([attempt('p_e', 'x =', null)])
  try {
    await withEndpoint('S1 только начал.', async () => {
      const res = await ask(r, r.teacher)
      assert.equal(res.status, 202, 'ждать сдач, чтобы спросить «кто застрял», — и была жалоба')
      const started = (await res.json()) as CouncilOracle
      assert.equal(started.state, 'reading')
      // Заготовку ставит сервер: она уезжает модели в промпте и обязана быть
      // одной для любого клиента.
      assert.match(started.pending?.question ?? '', /Как идут дела у класса/)
      const ready = await settled(r.id, r.cellId)
      assert.equal(ready.state, 'ready')
      assert.equal(ready.answers.length, 1)
      assert.equal(ready.answers[0].text, 'S1 только начал.')
      assert.deepEqual(ready.answers[0].basedOn, { submitted: 0, drafts: 1 })
    })
  } finally {
    r.close()
  }
})

test('ни одного листа — вот теперь 400, и вопрос из лимита не тратится', async () => {
  const r = await room([])
  try {
    await withEndpoint('{}', async () => {
      const res = await ask(r, r.teacher)
      assert.equal(res.status, 400)
      assert.match(((await res.json()) as { error: string }).error, /никто ничего не написал/)
    })
  } finally {
    r.close()
  }
})

test('свободный вопрос о классе: 202, ответ в ленте и словарь меток к людям', async () => {
  const r = await room()
  try {
    await withEndpoint('Застрял S3: цикл без возврата. Группа G1 в порядке.', async () => {
      const res = await ask(r, r.teacher, 'POST', '  Кто застрял?  ')
      assert.equal(res.status, 202)
      const started = (await res.json()) as CouncilOracle
      assert.equal(started.state, 'reading')
      assert.equal(started.pending?.question, 'Кто застрял?', 'пробелы по краям срезаны')
      /*
       * Вопрос о классе не трогает сводку: «отстала на N» считается разницей с
       * `basedOn`, и сбрасывать этот счёт вопросом про тишину нельзя.
       */
      assert.equal(started.basedOn, 0)

      const ready = await settled(r.id, r.cellId)
      assert.equal(ready.state, 'ready', ready.error ?? '')
      assert.equal(ready.pending, null)
      assert.deepEqual(ready.summary, [], 'сводка по решениям осталась нетронутой')
      assert.equal(ready.answers.length, 1)
      const answer = ready.answers[0]
      assert.ok(answer.id.length > 0)
      assert.equal(answer.question, 'Кто застрял?')
      assert.match(answer.text, /S3/)
      assert.deepEqual(answer.basedOn, { submitted: 4, drafts: 1 })
      // Метки к людям привязывает сервер: по этому словарю пульт делает из
      // «S3» чип с именем и кнопку «открыть работу».
      assert.equal(Object.keys(answer.people).length, 5)
      assert.equal(answer.people.S3, 'p_c')
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

test('лента копит не больше шести ходов и переживает обновление сводки', async () => {
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
    const summary = JSON.stringify({ summary: ['а', 'б', 'в'], groupLabels: {}, drafts: {} })
    await withEndpoint(summary, async () => {
      assert.equal((await ask(r, r.teacher)).status, 202)
      const ready = await settled(r.id, r.cellId)
      assert.deepEqual(ready.summary, ['а', 'б', 'в'])
      assert.equal(ready.basedOn, 4)
      assert.equal(ready.answers.length, MAX_ORACLE_ANSWERS, 'сводка не стирает разговор')
    })
  } finally {
    r.close()
  }
})

test('«Стоп» возвращает прежнее состояние, а не пустоту', async () => {
  const r = await room()
  try {
    // Первый ответ — настоящий, чтобы было что возвращать.
    const answer = JSON.stringify({
      summary: ['а', 'б', 'в'],
      groupLabels: { G1: 'sum' },
      drafts: {},
    })
    await withEndpoint(answer, async () => {
      assert.equal((await ask(r, r.teacher)).status, 202)
      const first = await settled(r.id, r.cellId)
      assert.equal(first.state, 'ready')
    })
    // Второй — к шлюзу, который молчит, пока его не оборвут.
    const app = express()
    const hung: http.ServerResponse[] = []
    app.post('/v1/chat/completions', (_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.write(': keep\n\n')
      hung.push(res)
    })
    const server = http.createServer(app)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    updateOracleSettings({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    })
    try {
      const before = announced.length
      assert.equal((await ask(r, r.teacher)).status, 202)
      // Пока читает — второй вопрос не принимается: один ключ, одна сводка.
      assert.equal((await ask(r, r.teacher)).status, 409)
      assert.equal((await ask(r, r.teacher, 'DELETE')).status, 200)
      const after = await settled(r.id, r.cellId)
      assert.equal(after.state, 'ready')
      assert.deepEqual(after.summary, ['а', 'б', 'в'], 'прежняя сводка потеряна')
      assert.equal(after.error, null, 'остановка рукой — не ошибка')
      assert.ok(announced.length > before)
    } finally {
      for (const res of hung) res.end()
      server.close()
    }
  } finally {
    r.close()
  }
})
