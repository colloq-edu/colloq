/**
 * Предел вопросов к оракулу — единственное, что стоит между чужим ключом и
 * чьим-то счётом. Личный предел обходится перезаходом: имя в комнате ничем не
 * подтверждено, и новая вкладка инкогнито — это новый участник со свежими N
 * вопросами. Поэтому есть второй потолок, на всю комнату; проверяется он, а
 * не личный, потому что дыра была именно здесь.
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

test('перезаход обнуляет личный счёт и не обнуляет комнатный', () => {
  const room = 'limits-room'

  // Один человек задал три вопроса.
  for (let i = 0; i < 3; i++) {
    recordQuestion({ sessionId: room, participantId: 'p_one', action: 'ask' })
  }
  assert.equal(countRecentQuestions(room, 'p_one', HOUR), 3)
  assert.equal(countRoomQuestions(room, HOUR), 3)

  // Он же перезашёл: новая вкладка — новый participantId, личный счёт пуст.
  assert.equal(countRecentQuestions(room, 'p_one_again', HOUR), 0)
  recordQuestion({ sessionId: room, participantId: 'p_one_again', action: 'ask' })

  // А комната помнит всё, что в ней спросили, кем бы он ни назвался.
  assert.equal(countRoomQuestions(room, HOUR), 4)
})

test('счёт одной комнаты не течёт в другую', () => {
  const a = 'limits-a'
  const b = 'limits-b'
  recordQuestion({ sessionId: a, participantId: 'p_x', action: 'ask' })
  recordQuestion({ sessionId: a, participantId: 'p_y', action: 'ask' })
  assert.equal(countRoomQuestions(a, HOUR), 2)
  assert.equal(countRoomQuestions(b, HOUR), 0)
})

test('комнатный счёт считает всех, включая тех, кто больше не вернётся', () => {
  const room = 'limits-crowd'
  for (const who of ['p_a', 'p_b', 'p_c', 'p_d']) {
    recordQuestion({ sessionId: room, participantId: who, action: 'ask' })
  }
  // Ровно то, чем этот потолок отличается от личного: он не про человека.
  assert.equal(countRoomQuestions(room, HOUR), 4)
  for (const who of ['p_a', 'p_b', 'p_c', 'p_d']) {
    assert.equal(countRecentQuestions(room, who, HOUR), 1)
  }
})

/* ------------------------------------------------- сам отказ, а не счётчики */

/**
 * Три теста выше проверяют счёт, а дыру закрыл маршрут — и его можно было
 * удалить целиком, не уронив ни одного из них. Ниже спрашивают так, как
 * спрашивает панель: через HTTP, с токеном комнаты.
 */
const app = express()
app.use(express.json())
app.use(aiRoutes())
let base = ''
let server: http.Server

before(async () => {
  // Оракул должен быть настроен, иначе маршрут отвечает 503 до потолков.
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
  // Старше двух минут: новичкам оракул не отвечает (routes/ai.ts · NEWCOMER_MS).
  const token = signToken({ sessionId: room, participantId, role: 'participant', iat: Date.now() - 3 * 60_000 })
  return fetch(`${base}/api/sessions/${room}/ai/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'почему тут падает?', mode: options.mode }),
  })
}

test('комната упирается в свой потолок, даже когда каждый спрашивает под своим именем', async () => {
  const room = 'limits-route-room'
  createSession(room, 'Room ceiling', null)
  updateOracleSettings({ questionsPerHour: 1 })

  // Тридцать личных пределов — по одному вопросу от тридцати «новых» вкладок.
  for (let i = 0; i < 30; i++) {
    recordQuestion({ sessionId: room, participantId: `p_tab_${i}`, action: 'ask' })
  }

  // Спрашивает тот, у кого личный счёт пуст: отказать может только комнатный.
  const res = await askAs(room, 'p_fresh')
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '600')
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /Занятие использовало все 30/)
})

test('личный потолок говорит, через сколько можно снова', async () => {
  const room = 'limits-route-person'
  createSession(room, 'Personal ceiling', null)
  updateOracleSettings({ questionsPerHour: 2 })
  recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })
  recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })

  const res = await askAs(room, 'p_ada')
  assert.equal(res.status, 429)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /Вы использовали все 2 вопроса оракулу/)
  // Окно скользит: срок берётся из windowResetAt, а не из «начала следующего часа».
  assert.match(body.error, /через 60 минут/)
  assert.ok(Number(res.headers.get('retry-after')) > 0)
})

/* ------------------------------------------------------------- слоу-мод */

/**
 * Промежуток между вопросами — про частоту, а не про расход.
 *
 * Потолок в час двадцать вопросов подряд пропускает: их можно выкрикнуть за
 * двадцать секунд, и наказан будет не выкрик, а следующий настоящий вопрос —
 * через час без оракула. Слоу-мод стоит ровно там, где спам, и стоит секунды.
 */
test('слоу-мод пускает первый вопрос и разворачивает второй — со сроком', async () => {
  const room = 'slow-first'
  createSession(room, 'Слоу-мод', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 30 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)

  const denied = await askAs(room, 'p_kid')
  // Тот же код, каким отвечает потолок в час: второго способа сказать
  // «не сейчас» у этого маршрута нет.
  assert.equal(denied.status, 429, 'второй вопрос прошёл сразу за первым')
  const body = (await denied.json()) as { error: string; retryAfter: number }
  assert.match(
    body.error,
    /Между вопросами нужно подождать 30 секунд/,
    `отказ не называет промежуток: ${body.error}`,
  )
  assert.match(body.error, /Повторите через \d+ секунд/, `отказ не говорит, сколько ждать: ${body.error}`)
  /*
   * Срок приходит и числом. По нему панель гасит кнопку и показывает ожидание
   * спокойной строкой, а не красной ошибкой; отличить ожидание от аварии по
   * тексту 429 она не может.
   */
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 30, `странный срок: ${body.retryAfter}`)
  assert.equal(denied.headers.get('retry-after'), String(body.retryAfter))
})

test('промежуток прошёл — и оракул снова отвечает', async () => {
  const room = 'slow-expiry'
  createSession(room, 'Промежуток', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 30 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  assert.equal((await askAs(room, 'p_kid')).status, 429)

  // Часы вперёд не перевести, поэтому назад переводится вопрос: слоу-мод
  // считает по той же строке расхода, что и потолок в час.
  db.prepare('UPDATE ai_usage SET created_at = ? WHERE session_id = ?').run(
    Date.now() - 31_000,
    room,
  )
  assert.equal((await askAs(room, 'p_kid')).status, 202, 'промежуток прошёл, а оракула нет')
})

test('преподавателя слоу-мод не касается', async () => {
  const room = 'slow-host'
  createSession(room, 'Ведущий', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 300 })
  /*
   * Роль решается по строке участника, а не по тому, что написано в токене
   * (routes/sessions.ts · roleFor), — поэтому ведущего приходится завести
   * по-настоящему.
   */
  upsertParticipant({
    id: 'p_ada_host',
    sessionId: room,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })

  // Он ведёт занятие: его вопросы идут подряд потому, что подряд идёт разбор.
  assert.equal((await askAs(room, 'p_ada_host')).status, 202)
  assert.equal((await askAs(room, 'p_ada_host')).status, 202, 'ведущего развернули на его же паре')

  // А в той же комнате участнику — тот же промежуток, что и всем.
  assert.equal((await askAs(room, 'p_kid')).status, 202)
  assert.equal((await askAs(room, 'p_kid')).status, 429)
})

test('преподавателя не держат ни личный потолок, ни комнатный', async () => {
  /*
   * Оба счёта держат инстанс от комнаты, а ведущий — не комната. Личный
   * потолок остановил бы его посреди разбора, а комнатный остановил бы за
   * чужой расход: класс выбрал час, и замолчал бы как раз тот, кто эту пару
   * ведёт. Оба случая здесь и стоят рядом.
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

  // Комната выбрала свой час: тридцать личных пределов, по вопросу со вкладки.
  for (let i = 0; i < 30; i++) {
    recordQuestion({ sessionId: room, participantId: `p_tab_${i}`, action: 'ask' })
  }
  // И у самого ведущего личный счёт тоже выбран — предел здесь единица.
  recordQuestion({ sessionId: room, participantId: 'p_ada_caps', action: 'ask' })

  const before = countRoomQuestions(room, HOUR)
  assert.equal((await askAs(room, 'p_ada_caps')).status, 202, 'ведущего развернул потолок')
  assert.equal((await askAs(room, 'p_ada_caps')).status, 202, 'и развернул на втором вопросе')

  // Вопросы ведущего из счёта не вычитаются: расход инстанса — это расход.
  assert.equal(countRoomQuestions(room, HOUR), before + 2)

  // А в той же комнате участник упирается в комнатный потолок, как и должен.
  const denied = await askAs(room, 'p_kid')
  assert.equal(denied.status, 429)
  assert.match(((await denied.json()) as { error: string }).error, /Занятие использовало все 30/)
})

test('ноль — слоу-мода нет вовсе, и это умолчание', async () => {
  const room = 'slow-off'
  createSession(room, 'Выключено', null)
  // Больше пяти минут не поставить: это уже не «не частите», а «сегодня без
  // оракула», и настройка не даёт зайти туда по ошибке.
  assert.equal(updateOracleSettings({ slowModeSeconds: 9_999 }).slowModeSeconds, 300)

  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
  for (let i = 0; i < 3; i++) {
    assert.equal((await askAs(room, 'p_kid')).status, 202, 'выключенный слоу-мод развернул вопрос')
  }
})

/* --------------------------------------------- потолки, поставленные комнатой */

/**
 * Инстанс задаёт умолчание, комната ужесточает его для себя.
 *
 * Ослабить нельзя ни тем, ни другим концом: за модель платит тот, кто держит
 * инстанс, и семинар, умеющий поднять себе предел, превращал бы настройку
 * инстанса из потолка в совет. Правило одно на сервер и на пульт —
 * shared/rules.ts · oracleLimitsIn.
 */
test('комната опускает потолок в час под инстансовый, и отказ идёт по её числу', async () => {
  const room = 'limits-room-rule'
  createSession(room, 'Контрольная', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
  setRules(room, { ...getRules(room), questionsPerHour: 1 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  const denied = await askAs(room, 'p_kid')
  assert.equal(denied.status, 429, 'комнатный потолок в час не сработал')
  const body = (await denied.json()) as { error: string }
  // Текст отказа тот же, что и у инстансового потолка: студенту важно число,
  // а не то, в каком из двух мест его поставили.
  assert.match(body.error, /использовали свой единственный вопрос оракулу/)
})

test('комната не поднимает потолок инстанса', async () => {
  const room = 'limits-room-loose'
  createSession(room, 'Мягче нельзя', null)
  updateOracleSettings({ questionsPerHour: 1, slowModeSeconds: 0 })
  setRules(room, { ...getRules(room), questionsPerHour: 500 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  assert.equal((await askAs(room, 'p_kid')).status, 429, 'комната переписала потолок инстанса')
})

test('комнатный слоу-мод длиннее инстансового — и преподавателя всё так же не касается', async () => {
  const room = 'slow-room-rule'
  createSession(room, 'Комнатный промежуток', null)
  // На инстансе промежутка нет вовсе: весь он приходит из правил комнаты.
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
  setRules(room, { ...getRules(room), slowModeSeconds: 30 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  const denied = await askAs(room, 'p_kid')
  assert.equal(denied.status, 429, 'комнатный слоу-мод пропустил второй вопрос подряд')
  const body = (await denied.json()) as { error: string; retryAfter: number }
  assert.match(body.error, /Между вопросами нужно подождать 30 секунд/)
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 30)

  // Ведущего промежуток не касается — ни инстансовый, ни комнатный: его
  // вопросы идут подряд потому, что подряд идёт разбор.
  upsertParticipant({
    id: 'p_slow_host',
    sessionId: room,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  assert.equal((await askAs(room, 'p_slow_host')).status, 202)
  assert.equal((await askAs(room, 'p_slow_host')).status, 202, 'ведущего развернули на его же паре')
})

test('комната не укорачивает промежуток, поставленный инстансом', async () => {
  const room = 'slow-room-loose'
  createSession(room, 'Короче нельзя', null)
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 30 })
  setRules(room, { ...getRules(room), slowModeSeconds: 0 })

  assert.equal((await askAs(room, 'p_kid')).status, 202)
  assert.equal((await askAs(room, 'p_kid')).status, 429, 'комната отменила слоу-мод инстанса')

  // Настройки инстанса одни на весь файл: оставленный включённым слоу-мод
  // разворачивал бы второй вопрос в тестах ниже, которые про другое.
  updateOracleSettings({ slowModeSeconds: 0 })
})

/**
 * Вопрос и поручение — разные строки в разбивке панели.
 *
 * Пока ход «сделать» писался под тем же 'ask', самый дорогой режим был в
 * таблице неотличим от «объясни»: один ход ходит к модели до двенадцати раз и
 * тащит с собой файлы. Владелец ключа видел ровный столбик вопросов там, где
 * полсеместра стоила пара поручений.
 */
test('ход «сделать» пишется в учёт своим действием, а вопрос — своим', async () => {
  const room = 'limits-work-action'
  createSession(room, 'Agent action', null)
  updateOracleSettings({ questionsPerHour: 20 })

  // Комната с `agent: 'room'` — та, где просить о правках может любой. Право
  // преподавателя даёт кука штата, а её через HTTP здесь ни у кого нет.
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
 * Расход хода складывается, а не перезаписывается: строка одна на вопрос, а
 * режим «сделать» ходит к модели до двенадцати раз. Пока считался последний
 * шаг, самый дорогой режим выглядел в панели самым дешёвым.
 */
test('токены за один вопрос складываются по шагам', () => {
  const room = 'limits-tokens'
  const id = recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })
  noteTokens(id, 900)
  noteTokens(id, 1_200)
  const spent = db.prepare('SELECT tokens AS n FROM ai_usage WHERE id = ?').get(id) as {
    n: number | null
  }
  assert.equal(spent.n, 2_100)
})
