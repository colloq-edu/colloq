/**
 * Ход как целое: часы, переписка и вторая кнопка «сделать».
 *
 * Здесь проверяется не инструмент (это `agent-cells`) и не потолок действий
 * (это `agent-step-limit`), а то, что держит ход в рамках, когда модель ведёт
 * себя не так, как в примере из документации: пишет вызов текстом, думает
 * дольше пары, получает отказ и забывает его через десять шагов. Модель —
 * подделка: настоящая отвечала бы каждый раз по-своему, и проверять пришлось
 * бы её.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { work, stopAll } from '../server/src/ai/agent.js'
import { aiRoutes } from '../server/src/routes/ai.js'
import { signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { writeText } from '../server/src/workspace.js'
import { chatAnswer, chatSteps, findChatEntry } from '../shared/notebook.js'
import { getOracleSettings, updateOracleSettings } from '../server/src/admin/settings.js'

/** Что подделка ответит на очередной запрос; `null` — «словами и без вызовов». */
type Reply = { tool: string; args?: unknown } | { text: string } | null

let script: Reply[] = []
let round = 0
/** Тела запросов, как их получил «провайдер»: по ним видно, что доехало. */
let heard: string[] = []
/** Сколько подделка тянет с ответом: так держат ход идущим. */
let delayMs = 0
/** На сколько подделка двигает часы перед ответом: так проверяют срок хода. */
let tickMs = 0
let was = 0

let model: http.Server
let routes: http.Server
let base = ''

before(async () => {
  model = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      heard.push(body)
      const step: Reply = script[round] ?? { text: 'Готово' }
      round += 1
      const message =
        step === null || 'text' in step
          ? { role: 'assistant', content: step === null ? '' : step.text }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call-${round}`,
                  type: 'function',
                  function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
                },
              ],
            }
      // Со второго круга: первый вызов должен успеть выполниться, иначе тест
      // проверял бы «ход не начался», а не «ход кончился по времени».
      if (tickMs > 0 && round > 1) mock.timers.tick(tickMs)
      const send = () => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message }] }))
      }
      if (delayMs > 0) setTimeout(send, delayMs).unref?.()
      else send()
    })
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
  was = getOracleSettings().contextChars
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    apiKey: 'test-only',
    model: 'test-model',
    agentSteps: 0,
  })

  const app = express()
  app.use(express.json())
  app.use(aiRoutes())
  routes = http.createServer(app)
  await new Promise<void>((resolve) => routes.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(routes.address() as { port: number }).port}`
})

after(() => {
  model?.close()
  routes?.close()
  updateOracleSettings({ contextChars: was, agentSteps: 0 })
})

async function turn(id: string, plan: Reply[], message = 'сделай тетрадь') {
  script = plan
  round = 0
  heard = []
  try {
    createSession(id, `Turn ${id}`)
  } catch {
    /* комната уже заведена этим же файлом — так и задумано */
  }
  const entryId = work({
    sessionId: id,
    participantId: 'teacher',
    participantName: 'Teacher',
    participantColor: '#123456',
    role: 'host',
    message,
  })
  const doc = getSessionDoc(id).doc
  // Счётом кругов, а не по часам: один из тестов ниже переводит часы процесса
  // на шесть минут вперёд, и ожидание «до Date.now() + 8 с» кончилось бы
  // раньше, чем ход успел бы ответить.
  for (let waited = 0; waited < 800; waited++) {
    const entry = findChatEntry(doc, entryId)!
    if (entry.get('state') !== 'streaming') {
      return { entry, answer: chatAnswer(entry).toString(), steps: chatSteps(entry) }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  stopAll(id)
  throw new Error('ход не закончился')
}

test('вызов, написанный текстом вместо поля tool_calls, всё равно вызов', async () => {
  const result = await turn('text-call', [
    { text: '```json\n{"name": "list_files", "arguments": {}}\n```' },
    // Дважды: на первый ответ без вызова ход отвечает толчком, а не концом.
    { text: 'Посмотрел папку.' },
    { text: 'Посмотрел папку.' },
  ])
  assert.equal(result.steps.length, 1, 'вызов в тексте остался словами')
  assert.equal(result.steps.get(0)!.get('kind'), 'read')
  assert.equal(result.answer, 'Посмотрел папку.')
})

test('JSON, который не называет известного инструмента, вызовом не становится', async () => {
  const result = await turn('text-data', [{ text: '{"path": "train.py", "lines": 40}' }])
  assert.equal(result.steps.length, 0, 'кусок данных приняли за вызов')
})

test('отказ остаётся в переписке, когда прочитанные файлы из неё уже выпали', async () => {
  const id = 'keep-refusals'
  createSession(id, 'Refusals')
  // Короткими строками, а не одной длинной: чтение идёт постранично, и файл из
  // одной строки на тридцать тысяч знаков приехал бы в переписку одной строкой.
  for (const name of ['a', 'b']) {
    const lines = Array.from({ length: 400 }, (_, i) => `МЕТКА_${name.toUpperCase()} ${i} ${'x'.repeat(50)}`)
    writeText(id, `${name}.py`, lines.join('\n'))
  }
  // Узкое окно: переписка перестаёт помещаться уже после первого чтения.
  updateOracleSettings({ contextChars: 2_000 })
  try {
    const result = await turn(id, [
      { tool: 'read_file', args: { path: 'a.py' } },
      { tool: 'no_such_tool' },
      { tool: 'read_file', args: { path: 'b.py' } },
      { text: 'Готово' },
      { text: 'Готово' },
    ])
    assert.equal(result.steps.length, 3)
    /*
     * Признаками, а не самими телами запросов: `assert.match` по строке в
     * двенадцать тысяч знаков печатает её целиком в отчёт, и на неудаче это
     * вешает сам прогон.
     */
    /*
     * Четвёртый запрос: в нём уже есть и отказ, и свежее чтение, а старое из
     * него выпало. Последний брать нельзя — к нему ход дописывает толчок, и
     * свежая пачка перестаёт быть последней, то есть тоже становится выбрасываемой.
     */
    const last = heard[3] ?? ''
    const kept = {
      refusal: last.includes('no_such_tool'),
      oldRead: last.includes('МЕТКА_A'),
      freshRead: last.includes('МЕТКА_B'),
    }
    assert.deepEqual(kept, { refusal: true, oldRead: false, freshRead: true })
  } finally {
    updateOracleSettings({ contextChars: was })
  }
})

test('ход, не уложившийся в отведённое время, называет сделанное и останавливается', async () => {
  mock.timers.enable({ apis: ['Date'] })
  tickMs = 6 * 60_000
  try {
    const result = await turn('out-of-time', [
      { tool: 'list_files' },
      // Второй круг начнётся уже за отведённым временем: часы двигает сама
      // подделка, между ответом и следующим вопросом.
      { tool: 'list_files', args: { nth: 2 } },
    ])
    assert.equal(result.steps.length, 1, 'ход продолжился после конца отведённого времени')
    assert.match(result.answer, /5 мин/)
  } finally {
    tickMs = 0
    mock.timers.reset()
  }
})

test('второй ход в той же комнате не начинается, пока идёт первый, — и у ведущего тоже', async () => {
  const id = 'one-turn-room'
  createSession(id, 'One turn')
  // `tokenHost`: роль решается на каждом запросе по таблице, а не по токену
  // (routes/sessions.ts · roleFor) — без этой метки ведущий приехал бы участником.
  upsertParticipant({ id: 'teacher', sessionId: id, name: 'Teacher', avatar: null, role: 'host', tokenHost: true })
  const token = signToken({ sessionId: id, participantId: 'teacher', role: 'host' })
  const ask = () =>
    fetch(`${base}/api/sessions/${id}/ai/ask`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'сделай тетрадь', mode: 'agent' }),
    })

  script = [{ tool: 'list_files' }, { text: 'Готово' }]
  round = 0
  heard = []
  delayMs = 600
  try {
    const first = await ask()
    assert.equal(first.status, 202, await first.clone().text())
    const second = await ask()
    assert.equal(second.status, 409)
    const body = (await second.json()) as { error: string }
    assert.match(body.error, /уже выполняет поручение/)
  } finally {
    delayMs = 0
    stopAll(id)
  }
})
