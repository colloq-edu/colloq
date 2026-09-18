/**
 * Сборка приложения: то, что раньше проверить было нечем.
 *
 * Порядок middleware жил в index.ts вперемешку с сокетами и `listen`, поэтому
 * тесты собирали свой express и КОПИРОВАЛИ в него порядок — «тот же порядок,
 * что в index.ts», говорил комментарий над копией. Копия порядка не ловит
 * расхождения с оригиналом, она их повторяет: переставь `sameOrigin` в
 * index.ts относительно роутеров — юнит-тесты останутся зелёными. Приложение
 * вынесено в server/src/app.ts, и здесь монтируется ОНО, а не его подобие.
 *
 * Ядра, docker и сети тут нет — проверяются двери, а не то, что за ними.
 */
import './_env.mts'
import { tr } from '../shared/i18n.js'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { app } from '../server/src/app.js'
import { createTeacher, linkKeyOf, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import { PUBLIC_PAGES_INDEXED } from '../shared/publish.js'
import { config } from '../server/src/config.js'

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

function call(
  method: string,
  path: string,
  init: { cookie?: string; origin?: string; body?: unknown; raw?: string } = {},
): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  })
}

const teacher = (() => {
  const made = createTeacher({ name: 'Пётр', email: 'petr.wiring@example.edu', role: 'teacher' })
  assert.ok(made, 'не завёлся преподаватель для теста')
  rotateLinkKey(made.id)
  return made
})()

/** Печенье штата возраста `ageMs` — подписанное так же, как настоящее. */
function cookieAged(ageMs: number): string {
  const key = linkKeyOf(teacher.id)
  assert.ok(key)
  const body = Buffer.from(JSON.stringify({ tid: teacher.id, iat: Date.now() - ageMs })).toString(
    'base64url',
  )
  const sig = createHmac('sha256', process.env.SESSION_SECRET as string)
    .update(`${body}.${key}`)
    .digest('base64url')
  return `${STAFF_COOKIE}=${body}.${sig}`
}

function freshCookie(): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

/* --------------------------------------------------- своё происхождение */

test('чужая страница не пишет НИГДЕ, а не только в панель', async () => {
  /*
   * Проверка стояла под `/api/admin`, хотя тем же печеньем авторизуются
   * создание семинара, загрузка файлов в комнату, перезапуск ядра и выдача
   * пульта. Там держал один SameSite — правило браузера, ради недоверия к
   * которому проверка и заведена.
   */
  const made = await call('POST', '/api/sessions', {
    cookie: freshCookie(),
    origin: 'https://evil.example',
    body: { name: 'С чужой страницы' },
  })
  assert.equal(made.status, 403, 'семинар завёлся по запросу с чужого сайта')
  const said = (await made.json()) as { error?: string }
  assert.equal(said.error, tr('server.requestBlockedThisPageUsesADifferent.dd9b4b'))
})

test('свой запрос и запрос без Origin проходят', async () => {
  // Без Origin — это curl и сам сервер: `make host` ходит в собственный API.
  const made = await call('POST', '/api/sessions', {
    cookie: freshCookie(),
    body: { name: 'Обычный семинар' },
  })
  assert.notEqual(made.status, 403)
  assert.ok(made.status < 500, `сервер сломался вместо ответа: ${made.status}`)
})

test('чтение с чужой страницы не отказывают — читать там всё равно нечего', async () => {
  // CORS-заголовков сервер не ставит, ответ на чужую страницу не попадёт, а
  // отказ на GET сломал бы предпросмотр ссылок и зонды.
  const seen = await call('GET', '/api/health', { origin: 'https://evil.example' })
  assert.notEqual(seen.status, 403)
})

/* ------------------------------------------------- печенье продлевается */

test('печенье старше суток переиздаётся на любом запросе к API', async () => {
  /*
   * `iat` ставился один раз при входе и не двигался ни одним маршрутом, так что
   * на тридцать первый день преподаватель посреди пары становился участником
   * своей комнаты — без объяснения и без запасного пути.
   */
  const seen = await call('GET', '/api/nope', { cookie: cookieAged(8 * 24 * 3_600_000) })
  const set = seen.headers.get('set-cookie') ?? ''
  assert.match(set, new RegExp(`${STAFF_COOKIE}=`), 'печенье не продлилось — месяц идёт от входа')
  assert.match(set, /HttpOnly/i)
})

test('свежее печенье не переиздаётся на каждом запросе', async () => {
  const seen = await call('GET', '/api/nope', { cookie: cookieAged(60_000) })
  assert.equal(seen.headers.get('set-cookie'), null, 'Set-Cookie на каждом запросе подряд')
})

test('выход из панели старое печенье не воскрешает', async () => {
  /*
   * Продление стоит ПЕРЕД маршрутами, а выход печенье снимает. Два `Set-Cookie`
   * подряд — обычное дело, но выигрывать обязан последний: «выкинутый из панели
   * посреди семинара преподаватель — это комната без хозяина», и обратное так
   * же верно — не выкинутый, когда просил.
   */
  const seen = await call('POST', '/api/admin/signout', {
    cookie: cookieAged(8 * 24 * 3_600_000),
  })
  assert.ok(seen.status < 400, `выход отказал: ${seen.status}`)
  const set = seen.headers.getSetCookie().filter((one) => one.startsWith(`${STAFF_COOKIE}=`))
  assert.ok(set.length > 0, 'выход ничего не сказал про печенье')
  const last = set[set.length - 1] ?? ''
  assert.match(
    last,
    new RegExp(`^${STAFF_COOKIE}=;`),
    `последним пришло не снятие: ${set.join(' | ')}`,
  )
})

test('чужая страница печенье не продлевает', async () => {
  // Продлевать по запросу, который мы только что решили не выполнять, — значит
  // держать подпись живой чужим сайтом.
  const seen = await call('POST', '/api/sessions', {
    cookie: cookieAged(8 * 24 * 3_600_000),
    origin: 'https://evil.example',
    body: { name: 'нет' },
  })
  assert.equal(seen.status, 403)
  assert.equal(seen.headers.get('set-cookie'), null)
})

/* ------------------------------------------------------ прочая проводка */

test('заголовки безопасности стоят на ответах, а не только в константе', async () => {
  const seen = await call('GET', '/api/nope')
  assert.equal(seen.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(seen.headers.get('x-powered-by'), null, 'сервер представился express')
})

test('несуществующая дверь API — это JSON, а не страница express', async () => {
  const seen = await call('GET', '/api/nope')
  assert.equal(seen.status, 404)
  assert.deepEqual(await seen.json(), { error: tr('common.notFound') })
})

test('кривое тело — 400 словами, а не HTML-страница на 500', async () => {
  const seen = await call('POST', '/api/sessions', { raw: '{не json' })
  assert.equal(seen.status, 400)
  const said = (await seen.json()) as { error?: string }
  assert.equal(said.error, tr('common.badJson'))
})

test('robots.txt и X-Robots-Tag говорят про публикации одно и то же', async () => {
  /*
   * Одна и та же страница вела себя по-разному в зависимости от того, каким
   * адресом её открыли: выгрузка на Pages ставила `noindex`, а robots.txt
   * инстанса закрывал только комнаты и панель, объясняя, что публикации «для
   * того и публикуют». Решение теперь одно на оба носителя и лежит в
   * shared/publish.ts — здесь проверяется, что живая сторона за ним идёт.
   */
  const text = await (await call('GET', '/robots.txt')).text()
  const closed = ['/s/', '/admin', ...(PUBLIC_PAGES_INDEXED ? [] : ['/p/', '/c/'])]
  for (const path of closed) {
    assert.ok(text.includes(`Disallow: ${path}`), `${path} не закрыт в robots.txt:\n${text}`)
  }
  if (PUBLIC_PAGES_INDEXED) assert.ok(!text.includes('Disallow: /p/'))

  // `Disallow` — просьба не заходить; поисковик вправе показать закрытый адрес
  // по чужой ссылке. Отвечает на это только заголовок.
  const wanted = PUBLIC_PAGES_INDEXED ? null : 'noindex, nofollow'
  assert.equal((await call('GET', '/p/whatever')).headers.get('x-robots-tag'), wanted)
  assert.equal((await call('GET', '/c/whatever')).headers.get('x-robots-tag'), wanted)
  // Комната и панель закрыты всегда, лендинг — открыт всегда.
  assert.equal((await call('GET', '/s/abc')).headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal((await call('GET', '/')).headers.get('x-robots-tag'), null)
  // Разворачивателю ссылок комната открыта: и в robots.txt, и заголовком.
  assert.match(text, /User-agent: TelegramBot\n(?:User-agent: [^\n]+\n)*Allow: \//)
  const telegram = await fetch(`${base}/s/abc`, { headers: { 'user-agent': 'TelegramBot (like TwitterBot)' } })
  assert.equal(telegram.headers.get('x-robots-tag'), null)
})

test('здоровье называет адрес, который сервер сейчас пишет в ссылки', async () => {
  /*
   * `config.publicUrl` перечитывает .env не чаще раза в две секунды, и до
   * этого поля узнать, доехал ли новый адрес, было нечем: `scripts/host.sh`
   * ставил на это место `sleep 3` — единственный сон в скрипте, поставленный
   * не потому, что чего-то ждут, а потому, что спросить было некого.
   */
  const said = (await (await call('GET', '/api/health')).json()) as { publicUrl?: string }
  assert.equal(said.publicUrl, config.publicUrl)
  assert.match(said.publicUrl ?? '', /^https?:\/\//)
})
