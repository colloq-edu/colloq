/**
 * «Подсказка оракула» студенту в консилиуме — весь путь, а не только ответ.
 *
 * Четыре обещания, каждое из которых ломается молча.
 *
 * ЧАСТНОСТЬ. Тексты консилиума видят двое: автор и преподаватель. Вопрос
 * «почему у меня падает» вместе с кодом попытки не должен уехать в общий тред
 * комнаты (`/ai/ask` пишет туда, и это читает весь класс) и не должен прийти
 * ни на один чужой сокет. Здесь это проверяется настоящими сокетами: у соседа
 * по комнате — второй разборщик, и в нём после подсказки не появляется ничего.
 *
 * ПОВОД. Подсказку дают по УПАВШЕМУ запуску. Без трейсбека вопрос выродился бы
 * в «посмотри мой код и скажи, верно ли», то есть в решение за студента, —
 * ровно то, от чего консилиум и защищают.
 *
 * ЛИМИТ. Вопрос к модели один и тот же, чей бы он ни был, и считаться должен в
 * ту же таблицу (`ai_usage`) и упираться в тот же потолок, что вопросы в ленте.
 * Своя дверь у подсказки означала бы обход предела через второй вход.
 *
 * ПАМЯТЬ. Ответ — письмо внутри попытки, а не строка на экране: перезагрузка
 * страницы не должна его терять.
 *
 * Подделан один слой — шлюз к модели (как в oracle-flow.test.mts). Комната,
 * документ, таблица попыток и разбор кадров настоящие.
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
 * Шлюзы закрываются здесь, а не в теле теста: упавшее утверждение уносит
 * `close()` вместе с остатком теста, и процесс после этого не выходит вовсе —
 * сюита висит без единой строки о причине. Список общий, закрытие идемпотентно.
 */
const gateways: (() => Promise<void>)[] = []

after(async () => {
  for (const close of gateways.splice(0)) await close()
  shutdownCollab()
})

/* -------------------------------------------------------------- подделки */

interface Gateway {
  seen: Record<string, unknown>[]
  close: () => Promise<void>
}

/** OpenAI-совместимый шлюз, отвечающий одной заготовленной строкой. */
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
   * `closeAllConnections` перед `close`, иначе не закроется никогда: поток к
   * модели идёт через keep-alive, соединение остаётся открытым, а `close`
   * ждёт именно его — процесс после сюиты не выходил вовсе и висел молча.
   */
  const close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    })
  gateways.push(close)
  return { seen, close }
}

/** Ровно то, что читает `send`: состояние и приём кадра. */
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

/** Лекционная комната с ячейкой в консилиуме и упавшей попыткой студента. */
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
  // Токен постарше двух минут: новичок ждёт (ai/door.ts · NEWCOMER_MS), и это
  // правило здесь не проверяется — проверяется всё остальное.
  return { sessionId, participantId, role, iat: Date.now() - 600_000 }
}

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "<ipython-input-3>", line 2, in <module>',
  '    top = sorted(zip(imp, cols), reverse=True)[:5]',
  "AttributeError: 'DecisionTreeClassifier' object has no attribute 'feature_importance'",
]

/** Попытка студента с упавшим запуском — то, из-за чего подсказку и просят. */
function failedAttempt(sessionId: string, cellId: string, participantId: string): void {
  saveDraft(sessionId, cellId, participantId, 'imp = clf.feature_importance', Date.now())
  /*
   * Сперва «в очереди»: первый кадр запуска — это заявка, и по ней хранилище
   * запоминает, ПОД КАКИМ текстом он пошёл (council.ts · runFor). Кадр с
   * результатом без неё не принимается вовсе — так отсеиваются кадры запуска,
   * чей текст успели переписать.
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

/** Дождаться кадра, который приезжает после похода к модели. */
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
  assert.fail('кадра так и не дождались: ' + JSON.stringify(said.map((f) => f.t)))
}

/* ------------------------------------------------------------------ кадр */

test('кадр модели несёт задание, код и трейсбек — и не несёт имени', () => {
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
  // Готового решения модель писать не должна — это стоит в системном кадре, и
  // это единственное, чем правило вообще держится.
  assert.match(turns[0].content, /НЕ пиши исправленный код/)
  assert.match(turns[0].content, /не больше ОДНОГО конкретного совета/)
})

test('трейсбек едет без раскраски терминала и с именем исключения', () => {
  const text = tracebackOf([
    {
      kind: 'error',
      ename: 'ValueError',
      evalue: 'bad',
      traceback: ['[0;31mValueError[0m: bad', '  at line 2'],
    },
  ])
  assert.doesNotMatch(text, //, 'ANSI-раскраска уехала модели')
  assert.match(text, /ValueError/)
})

/* ------------------------------------------------------------ весь путь */

test('подсказка приходит письмом в попытку — и только её автору', async () => {
  const gate = await gateway('Ошибка в строке 2: у модели нет атрибута feature_importance.')
  const { id, cellId } = room()
  failedAttempt(id, cellId, 'p_anya')
  // Сосед по консилиуму с такой же упавшей попыткой: если подсказка утечёт,
  // утечёт она ему — и в его попытку, и на его сокет.
  failedAttempt(id, cellId, 'p_petya')

  const anya = socket()
  const petya = socket()
  dispatch(petya.ws, id, who('participant', id, 'p_petya'), { t: 'ping' })
  const quietBefore = petya.said.length

  dispatch(anya.ws, id, who('participant', id, 'p_anya'), { t: 'council:hint', cellId })

  // Первым делом — «думаю»: кнопка гаснет до похода к модели, иначе её жмут
  // второй раз и тратят второй вопрос из лимита.
  const asking = anya.said.find((f) => f.t === 'council:hint:state')
  assert.ok(asking && 'asking' in asking && asking.asking === true, 'кадр «думаю» не пришёл')

  const done = await settle(
    anya.said,
    (f) => f.t === 'council:hint:state' && 'asking' in f && f.asking === false,
  ) as Extract<ControlServerMessage, { t: 'council:hint:state' }>
  assert.equal(done.error, undefined, 'подсказка кончилась отказом: ' + done.error)

  const letters = councilLetters(attemptOf(id, cellId, 'p_anya'))
  assert.equal(letters.length, 1, 'подсказка не легла в попытку')
  assert.equal(letters[0].to, 'oracle', 'подсказка записана как письмо преподавателя')
  assert.match(letters[0].text, /feature_importance/)
  assert.equal(letters[0].by, 'Оракул')

  /* --- приватность, три замка */

  // Соседу не приехало ни одного кадра.
  assert.equal(petya.said.length, quietBefore, 'подсказка ушла чужому сокету')
  // И в его попытку ничего не легло: письмо принадлежит той, о которой спросили.
  assert.deepEqual(councilLetters(attemptOf(id, cellId, 'p_petya')), [])
  // И общий тред комнаты не тронут: туда пишет `/ai/ask`, и туда смотрит класс.
  assert.equal(getChat(getSessionDoc(id).doc).length, 0, 'вопрос ушёл в общую ленту')

  // Вопрос ушёл модели ровно один, и в нём нет ни имени, ни participantId.
  assert.equal(gate.seen.length, 1)
  const body = JSON.stringify(gate.seen[0])
  assert.doesNotMatch(body, /p_anya/, 'в кадр модели попал participantId')
  assert.match(body, /feature_importance/, 'модель не увидела кода попытки')

  // Расход посчитан своим действием: подсказка в разбивке панели не прячется
  // среди «спросили».
  assert.equal(summariseUsage(3_600_000).byAction.hint, 1)
  await gate.close()
})

test('без упавшего запуска подсказку не дают, и говорят почему', async () => {
  const gate = await gateway('не должно дойти')
  const { id, cellId } = room()
  saveDraft(id, cellId, 'p_anya', 'imp = 1', Date.now())

  const { ws, said } = socket()
  dispatch(ws, id, who('participant', id, 'p_anya'), { t: 'council:hint', cellId })
  const answer = said.find((f) => f.t === 'council:hint:state')
  assert.ok(answer && 'error' in answer && typeof answer.error === 'string')
  assert.match((answer as { error: string }).error, /упавшему запуску/)
  assert.equal(gate.seen.length, 0, 'к модели сходили без повода')
  await gate.close()
})

test('вне консилиума подсказки нет вовсе', async () => {
  const gate = await gateway('не должно дойти')
  const id = `hint-plain-${++rooms}`
  createSession(id, 'Обычная', null)
  setRules(id, LECTURE_ROOM)
  const { doc } = getSessionDoc(id)
  const made = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([made]))

  const { ws, said } = socket()
  dispatch(ws, id, who('participant', id, 'p_anya'), { t: 'council:hint', cellId: nameOf(made) })
  const answer = said.find((f) => f.t === 'council:hint:state')
  assert.ok(answer && 'error' in answer, 'молчаливый отказ: кнопка осталась бы погашенной')
  assert.equal(gate.seen.length, 0)
  await gate.close()
})

test('кончились вопросы — подсказка отказывает теми же словами, что и лента', async () => {
  const gate = await gateway('не должно дойти')
  const { id, cellId } = room()
  failedAttempt(id, cellId, 'p_anya')
  // Предел в один вопрос — и он уже потрачен: дверь одна на оба входа
  // (ai/door.ts), и подсказка обязана упереться в неё так же, как `/ai/ask`.
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

test('подсказки делят предел одновременных запросов комнаты и освобождают место', async () => {
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
