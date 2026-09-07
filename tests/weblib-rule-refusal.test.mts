/**
 * Пульт правил в самой комнате отказывает на языке комнаты.
 *
 * Зеркало admin-17: там окно правил в панели показывало «Правило не сохранилось
 * — The server did not respond», здесь — та же половина фразы на языке, которого
 * в комнате нет нигде. Отказ приезжает по сети и только при отказе, поэтому
 * разметкой это не ловится вовсе: единственный способ — звать причину функцией
 * и проверять её словами (как в tests/admin-rules-language.test.mts).
 *
 * Входы здесь — настоящие `ApiError`, а не выдуманные объекты: комната бросает
 * именно их (lib/api.ts), и проверять надо ту форму, которая до пульта
 * доезжает, вместе с её английским `message`, который наружу выйти не должен.
 *
 * Место вызова стережёт соседний `tests/screens-rule-refusal.test.mts`: пульт
 * правил в комнате зовёт эту функцию, а не показывает `err.message`
 * (SessionScreen.svelte · `setRule`). Здесь — сами слова: разделение такое же,
 * как у панели, где язык окна и язык причины разведены по двум файлам.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../web/src/lib/api.js'
import { ruleRefusal } from '../web/src/lib/rule-refusal.js'
import { SESSION_MISSING } from '../shared/protocol.js'

/** Латиница в видимой строке — след английского хвоста, просочившийся в комнату. */
const PANEL_LANGUAGE = /[A-Za-z]/
const ROOM_LANGUAGE = /[А-Яа-яЁё]/

/**
 * Всё, чем эта дверь вообще умеет отказать, — и рядом то, чем отказывают за
 * неё: прокси, ретранслятор, упавший fetch.
 */
const REFUSALS: ApiError[] = [
  // Отвергнутый fetch: lib/api.ts ставит нулевой код и свою английскую фразу.
  new ApiError('Could not reach the server — check the connection and try again.', 0),
  // Ключ комнаты кончился или его не признают.
  new ApiError('join the session first', 401),
  // Не преподаватель (routes/sessions.ts отвечает по-русски, но полагаться на
  // это нельзя: фраза сервера — не контракт интерфейса).
  new ApiError('Правила этого семинара задаёт преподаватель.', 403),
  // Забаненного разворачивает banDoor — со сроком в теле.
  new ApiError('the teacher closed your access', 403, null, Date.now() + 3600_000),
  // Семинар снесли, и сервер сказал это нашими словами.
  new ApiError(SESSION_MISSING, 404),
  // Тот же код от прокси перед сервером — тела нет, слова чужие.
  new ApiError('Not found (404)', 404),
  // Тело не той формы: ошибка экрана, а не человека.
  new ApiError('rules must be an object', 400),
  new ApiError('The server failed (500)', 500),
  new ApiError('Too many requests (429)', 429, 30),
]

test('причина отказа на пульте правил — по-русски при любом отказе', () => {
  const lines = [
    ...REFUSALS.map((refusal) => ruleRefusal(refusal)),
    // И то, что ApiError'ом вовсе не является: `catch` ловит что угодно.
    ...[null, undefined, 'boom', 7, new Error('Failed to fetch')].map((cause) =>
      ruleRefusal(cause),
    ),
  ]
  for (const line of lines) {
    assert.match(line, ROOM_LANGUAGE, `«${line}» — не на языке комнаты`)
    assert.doesNotMatch(line, PANEL_LANGUAGE, `«${line}» — английский хвост в русской комнате`)
    // Фраза целая: половинчатую («Правило не сохранилось — ») читать не о чем.
    assert.match(line, /^Правило не сохранилось[ ,—].+[.]$/u, `«${line}» — обрывок фразы`)
  }
})

test('фраза сервера не пересказывается — ни своя, ни чужая', () => {
  for (const refusal of REFUSALS) {
    const line = ruleRefusal(refusal)
    assert.notEqual(line, refusal.message, `${refusal.status}: наружу вышел message из ApiError`)
    // И не куском: «Could not reach the server» внутри русской фразы — то же
    // самое двуязычие, только незаметнее.
    const head = refusal.message.split(' ').slice(0, 3).join(' ')
    if (PANEL_LANGUAGE.test(head)) assert.ok(!line.includes(head), `${refusal.status}: ${line}`)
  }
})

test('обрыв связи, отвергнутый вход, бан и «не преподаватель» названы каждый своим', () => {
  const offline = ruleRefusal(new ApiError('Could not reach the server', 0))
  const stranger = ruleRefusal(new ApiError('join the session first', 401))
  const banned = ruleRefusal(new ApiError('closed', 403, null, Date.now() + 1000))
  const notHost = ruleRefusal(new ApiError('nope', 403))
  const unknown = ruleRefusal(null)

  assert.match(offline, /связи/)
  assert.match(stranger, /вход/)
  assert.match(banned, /удалили/)
  assert.match(notHost, /преподаватель/)
  assert.match(unknown, /попробуйте ещё раз/)
  assert.equal(new Set([offline, stranger, banned, notHost, unknown]).size, 5)
})

/*
 * «Семинара больше нет» — это факт, и говорится он только с наших слов.
 *
 * Голый 404 отдаёт ретранслятор без подключённого frpc и статика, отвечающая
 * index.html на всё подряд; по этой фразе преподаватель посреди пары пойдёт
 * заводить второй семинар вместо того, чтобы дождаться связи.
 */
test('404 чужими словами не хоронит семинар', () => {
  const ours = ruleRefusal(new ApiError(SESSION_MISSING, 404))
  const proxied = ruleRefusal(new ApiError('Not found (404)', 404))

  assert.match(ours, /семинара больше нет/)
  assert.doesNotMatch(proxied, /семинара больше нет/)
  assert.match(proxied, /попробуйте ещё раз/)
})

/**
 * Бан читается по сроку, а не по коду: 403 без срока — это «не преподаватель».
 *
 * Тот же признак, тем же способом, читают вход (JoinScreen.svelte) и
 * lib/identity.ts · `verdictOnFailure`; разойдись они — забаненному сказали бы,
 * что он не преподаватель, а преподавателю, что его удалили с занятия.
 */
test('срок бана отличает удалённого от того, кто просто не ведёт', () => {
  const withUntil = ruleRefusal(new ApiError('x', 403, null, Date.now() + 60_000))
  const noUntil = ruleRefusal(new ApiError('x', 403))
  const brokenUntil = ruleRefusal(new ApiError('x', 403, null, Number.NaN))

  assert.match(withUntil, /удалили/)
  assert.doesNotMatch(noUntil, /удалили/)
  // Нечисло в поле — это «срока не назвали», а не бан: лучше сказать про права,
  // чем объявить человеку несуществующее удаление с занятия.
  assert.equal(brokenUntil, noUntil)
})
