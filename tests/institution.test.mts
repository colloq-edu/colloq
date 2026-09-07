/**
 * Кто развернул этот инстанс.
 *
 * Строка рядом с логотипом была зашита в вёрстку и называла один конкретный
 * университет. Продукт разворачивают разные организации: на одном адресе это
 * ВШЭ, на другом банк, на третьем не нужно ничего, — и на чужом адресе зашитая
 * строка была не умолчанием, а чужим именем в шапке каждой комнаты и на экране
 * входа. Теперь это `INSTITUTION`, и умолчание — пусто.
 *
 * Проверяется то, что видно без браузера: строка едет в карточке семинара — то
 * есть на все экраны комнаты и на экран входа, без единого лишнего запроса, —
 * и обрезана потолком раньше, чем попадёт в вёрстку.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

/**
 * Длиннее потолка — иначе обрезать нечего.
 *
 * Присваивается ДО того, как загружен хоть один модуль сервера: `config` читает
 * окружение один раз, на импорте. Импорты выше безобидны — ни один из них про
 * окружение ничего не знает, — а всё, что знает, приезжает динамическим
 * импортом ниже, потому что статический был бы поднят выше этой строки и она
 * опоздала бы ровно на всё.
 */
const LONG =
  'Национальный исследовательский университет имени очень длинного названия · Факультет чего-нибудь'
process.env.INSTITUTION = LONG

const { config } = await import('../server/src/config.js')
const { createSession, getSession } = await import('../server/src/db.js')
// Приложение целиком (server/src/app.ts): порядок middleware у него тот же,
// что на паре, а собранный рядом свой — только похожий.
const { app } = await import('../server/src/app.js')

/* ------------------------------------------------------------------ потолок */

test('длинное название обрезано потолком, а не вёрсткой', () => {
  /*
   * Восемьдесят символов — тот же потолок, что у названия модели в правилах
   * комнаты (shared/rules.ts). Обрезать в вёрстке было бы поздно: строка едет в
   * каждом ответе про семинар и ложится в localStorage каждого браузера как
   * часть карточки комнаты.
   */
  assert.ok(LONG.length > 80, 'подопытная строка короче потолка — проверять нечего')
  assert.equal(config.institution.length, 80)
  assert.equal(config.institution, LONG.slice(0, 80))
})

/* ------------------------------------------------------------ карточка комнаты */

test('и новая комната, и прочитанная из базы называют организацию одинаково', () => {
  const id = 'inst-card'
  /*
   * Свойство инстанса, а не поле в строке таблицы: обе сборки карточки берут
   * его из конфига. Сменив INSTITUTION, оператор меняет надпись сразу во всех
   * комнатах, включая прошлогодние, — а не только в тех, что создадут дальше.
   */
  assert.equal(createSession(id, 'Комната', null).institution, config.institution)
  assert.equal(getSession(id)?.institution, config.institution)
})

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

test('экран входа узнаёт организацию из той же карточки комнаты', async () => {
  const id = 'inst-route'
  createSession(id, 'Комната', null)

  const res = await fetch(`${base}/api/sessions/${id}`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { institution: string }
  // В этом и весь выбор доставки: постер входа рисуется по этому ответу и ни за
  // чем больше не ходит.
  assert.equal(body.institution, config.institution)
})
