/**
 * Что человек читает, когда что-то пошло не так, и что об этом остаётся в журнале.
 *
 * Оба поводом стали живой парой. Шлюз с Gemini пять раз подряд отказал по
 * своему фильтру безопасности — без HTTP-статуса, одним словом SAFETY, — а
 * комната прочитала «не удалось достучаться до оракула, проверьте адрес и
 * ключ»: преподаватель ушёл чинить сеть и ключ, оба совершенно здоровые. И в
 * том же семинаре набралось пятьсот строк одного и того же участника, потому
 * что по журналу нельзя было сказать, какая именно проверка возврата не прошла.
 *
 * Поэтому здесь проверяются ФРАЗЫ и СТРОКИ, а не коды: и то и другое читает
 * человек, и цена ошибки — полпары, потраченные не на то.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { streamChat } from '../server/src/ai/provider.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { journalMinute, seldom, startJournal, stopJournal, tally } from '../server/src/log.js'
import { createSession } from '../server/src/db.js'
import { signToken } from '../server/src/auth.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

/* ------------------------------------------------------------------ оракул */

/**
 * Поддельный OpenAI-совместимый шлюз.
 *
 * Отвечает настоящим SSE, потому что проверяется именно то, как ошибку рождает
 * SDK: кадр с полем `error` он превращает в APIError БЕЗ статуса, и по одному
 * отсутствию статуса такая ошибка неотличима от «хост не ответил». Подделать
 * тут можно только эндпоинт — саму ошибку должен собрать настоящий SDK.
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

/** Спросить и вернуть то, что прочитает комната. */
async function said(): Promise<string> {
  try {
    await streamChat([{ role: 'user', content: 'привет' }], () => {})
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return ''
}

/**
 * Ни самого адреса, ни самого ключа, ни совета их проверить.
 *
 * Сказать «дело не в адресе и не в ключе» — можно и нужно: ровно за этим
 * преподаватель и уходил чинить здоровую сеть. А вот показать их значения или
 * послать в панель их править — это тот же совет, только другими словами.
 */
function blamesNothingLocal(message: string): void {
  assert.doesNotMatch(message, /https?:\/\//i, `адрес эндпоинта показан: ${message}`)
  assert.doesNotMatch(message, /test-key|OPENAI_API_KEY|admin panel/i, `ключ показан: ${message}`)
  assert.doesNotMatch(message, /\bcheck\b|Could not reach/i, `послали чинить: ${message}`)
  assert.match(message, /not the address or the key/i, `не сказано, где искать НЕ надо: ${message}`)
}

test('отказ фильтра безопасности назван отказом модели, а не поломкой связи', async () => {
  await withEndpoint(['{"error":{"message":"SAFETY"}}'], async () => {
    const message = await said()
    assert.match(message, /refus/i, `не сказано, что модель отказалась: ${message}`)
    assert.match(message, /safety/i, `не названа причина: ${message}`)
    assert.match(message, /different way|again/i, `не сказано, что делать: ${message}`)
    blamesNothingLocal(message)
  })
})

test('отказ, названный кодом content_filter, читается так же', async () => {
  const frame = '{"error":{"code":"content_filter","message":"The response was blocked."}}'
  await withEndpoint([frame], async () => {
    const message = await said()
    assert.match(message, /refus/i, `не сказано, что модель отказалась: ${message}`)
    blamesNothingLocal(message)
  })
})

test('«прекратил на полуслове» — не то же, что «не достучались»', async () => {
  await withEndpoint(['{"error":{"message":"upstream connection reset"}}'], async () => {
    const message = await said()
    assert.match(message, /broke off/i, `обрыв не назван обрывом: ${message}`)
    assert.doesNotMatch(
      message,
      /Could not reach/i,
      `ответивший эндпоинт объявлен недостижимым: ${message}`,
    )
  })
})

test('до эндпоинта правда не достучались — про адрес и ключ говорят по-прежнему', async () => {
  // Порт, на котором заведомо никого нет: этот случай и есть тот единственный,
  // ради которого фраза про адрес и ключ вообще существует.
  updateOracleSettings({
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'google/gemini-3.7-flash',
    apiKey: 'test-key',
  })
  const message = await said()
  assert.match(message, /Could not reach/i, `не сказано главное: ${message}`)
  assert.match(message, /address/i)
})

/* ------------------------------------------------------------ сводка минуты */

/** Одна сводка: подсунуть перепись, позвать её руками, вернуть строку. */
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

test('сводка минуты складывается в одну строку и без нулей', () => {
  // Тихая сводка — она же и конец предыдущей минуты: счётчики соседних тестов
  // остаются им, а не приезжают сюда.
  minuteLine({ rooms: 0, people: 0, kernels: { live: 0, busy: 0, dead: 0 } })
  tally('frames', 1204)
  tally('gate', 3)
  const line = minuteLine({ rooms: 2, people: 41, kernels: { live: 2, busy: 1, dead: 0 } })
  assert.ok(line, 'сводки нет вовсе')
  assert.match(line!, /rooms 2/)
  assert.match(line!, /people 41/)
  assert.match(line!, /kernels 2 live \(1 busy\)/)
  assert.match(line!, /frames 1204/)
  assert.match(line!, /gate refused 3/)
  // Нулевые счётчики не печатаются: короткая строка — та, в которой всё важно.
  assert.doesNotMatch(line!, /aborted/, `нулевой счётчик в строке: ${line}`)
  assert.doesNotMatch(line!, /dead/, `мёртвых ядер нет, а слово есть: ${line}`)
})

test('счётчики обнуляются каждую минуту, а не копятся весь день', () => {
  tally('aborted', 7)
  const first = minuteLine({ rooms: 1, people: 1, kernels: { live: 1, busy: 0, dead: 0 } })
  assert.match(first!, /aborted 7/)
  const second = minuteLine({ rooms: 1, people: 1, kernels: { live: 1, busy: 0, dead: 0 } })
  assert.doesNotMatch(second!, /aborted/, `прошлая минута протекла в следующую: ${second}`)
})

test('на пустой машине сводка молчит — 1440 строк ни о чём это тот же пустой журнал', () => {
  const line = minuteLine({ rooms: 0, people: 0, kernels: { live: 0, busy: 0, dead: 0 } })
  assert.equal(line, null, `тишину записали строкой: ${line}`)
})

/* ------------------------------------------------------------ тише минуты */

test('одно и то же событие говорится раз в минуту, а не на каждый повтор', () => {
  const key = `test-${Date.now()}`
  assert.equal(seldom(key), true, 'первый раз обязан быть сказан')
  assert.equal(seldom(key), false, 'второй за ту же минуту — уже поток')
  assert.equal(seldom(key), false)
  // Другая комната — другой ключ, и её отказ молчанием соседа не съедается.
  assert.equal(seldom(`${key}-other`), true)
  // Окно прошло — снова говорится: иначе редкое событие пропало бы навсегда.
  assert.equal(seldom(key, 0), true)
})

/* -------------------------------------------------------------------- вход */

const app = express()
app.use(express.json())
app.use(sessionRoutes())
const server = app.listen(0, '127.0.0.1')
const base = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`
after(() => server.close())

/** Строки журнала, которые написал вход, за время одного вызова. */
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

test('вход пишет одну строку, и по ней видно — вернулся собой или заведён заново', async () => {
  const id = 'journal-join'
  createSession(id, 'Журнал')

  // Первый раз человека здесь не было: сказать ему нечего, и это «no id».
  const first = await joinLines(id, { name: 'Аня' })
  assert.equal(first.length, 1, `строка обязана быть ровно одна: ${JSON.stringify(first)}`)
  assert.match(first[0], /\[join journal-join\]/)
  assert.match(first[0], /\bnew\b/)
  assert.match(first[0], /no id/)
  assert.match(first[0], /participant by link/)
  // Ничего личного: имя в журнал не едет.
  assert.doesNotMatch(first[0], /Аня/, 'имя участника попало в журнал')

  const me = /new (p_[A-Za-z0-9_-]+)/.exec(first[0])?.[1]
  assert.ok(me, `в строке нет идентификатора участника: ${first[0]}`)

  // Он же, со своим токеном: возврат собой, и повода заводить строку нет.
  const back = await joinLines(id, {
    name: 'Аня',
    participantId: me,
    token: signToken({ sessionId: id, participantId: me!, role: 'participant' }),
  })
  assert.equal(back.length, 1)
  /*
   * Не `\b`: имя участника кончается любым знаком своей азбуки, в том числе
   * дефисом, а после дефиса границы слова нет — и тест краснел на каждом
   * шестидесятом прогоне, когда такое имя выпадало. Здесь нужно ровно одно:
   * что имя целое, а не начало другого.
   */
  assert.match(back[0], new RegExp(`back ${me}(?![A-Za-z0-9_-])`))
  assert.doesNotMatch(back[0], /\bnew\b/)
})

test('строка входа называет, какая именно проверка возврата не прошла', async () => {
  const mine = 'journal-mine'
  const other = 'journal-other'
  createSession(mine, 'Моя')
  createSession(other, 'Чужая')

  const idOnly = await joinLines(mine, { name: 'Б', participantId: 'p_ghost' })
  assert.match(idOnly[0], /no token/, `не назван недостающий токен: ${idOnly[0]}`)

  const garbage = await joinLines(mine, { name: 'Б', participantId: 'p_ghost', token: 'мусор' })
  assert.match(garbage[0], /bad token/, `неразобранный токен назван иначе: ${garbage[0]}`)

  const foreign = await joinLines(mine, {
    name: 'Б',
    participantId: 'p_ghost',
    token: signToken({ sessionId: other, participantId: 'p_ghost', role: 'participant' }),
  })
  assert.match(foreign[0], /other room/, `токен чужой комнаты назван иначе: ${foreign[0]}`)

  const impostor = await joinLines(mine, {
    name: 'Б',
    participantId: 'p_ghost',
    token: signToken({ sessionId: mine, participantId: 'p_someone_else', role: 'participant' }),
  })
  assert.match(impostor[0], /other person/, `токен на другого назван иначе: ${impostor[0]}`)

  // Всё сходится, а строки в базе нет: семинар чистили, а браузер этого не знает.
  const gone = await joinLines(mine, {
    name: 'Б',
    participantId: 'p_ghost',
    token: signToken({ sessionId: mine, participantId: 'p_ghost', role: 'participant' }),
  })
  assert.match(gone[0], /row gone/, `исчезнувшая строка названа иначе: ${gone[0]}`)

  // И ни в одной из них — токена: по нему входят.
  for (const line of [...idOnly, ...garbage, ...foreign, ...impostor, ...gone]) {
    assert.doesNotMatch(line, /eyJ/, `в журнал уехал токен: ${line}`)
  }
})
