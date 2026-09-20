/**
 * Рамка, в которой рисуется чужой график, и её политика.
 *
 * Здесь проверяется ровно то, что делает рамку песочницей, а не просто вторым
 * `<div>`: заголовок. Отказ тут молчалив вдвойне — страница продолжит
 * показывать графики как ни в чём не бывало, просто чужой код снова окажется
 * рядом с токеном комнаты. Поэтому директивы проверяются по одной и с
 * объяснением, за что каждая отвечает.
 *
 * Что сама песочница работает — свойство браузера, и оно измерено вживую:
 * в рамке `window.origin === "null"`, а `document.cookie`, `localStorage` и
 * `window.parent.document` бросают SecurityError. Заголовок оттуда же:
 * `img-src data: blob:` отказал картинке фигуры с чужого адреса.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { app } from '../server/src/app.js'
import { FRAME_HTML, frameOrigin, framePolicy } from '../server/src/plotly-frame.js'
import { CONTENT_SECURITY_POLICY } from '../server/src/headers.js'
import {
  PLOTLY_BUNDLE_PATH,
  PLOTLY_FRAME_PATH,
  PLOTLY_MSG,
  PLOTLY_ORIGIN_PARAM,
} from '../shared/plotly.js'

const ORIGIN = 'http://localhost:5173'
const policy = framePolicy(ORIGIN)
const directives = new Map(
  policy.split('; ').map((one) => {
    const at = one.indexOf(' ')
    return at < 0 ? [one, ''] : [one.slice(0, at), one.slice(at + 1)]
  }),
)

/* ------------------------------------------------------------- политика */

test('origin рамки непрозрачен — и это делает заголовок, а не атрибут', () => {
  /*
   * `sandbox` из заголовка действует даже тогда, когда адрес открыли прямо в
   * отдельной вкладке (проверено вживую: там тоже `window.origin === "null"`).
   * Атрибут `sandbox` у `<iframe>` стоит тоже, но он — вторая линия: его
   * видно из DOM страницы, а заголовок — нет.
   */
  assert.ok(directives.has('sandbox'), 'без sandbox origin рамки остаётся нашим')
  assert.match(directives.get('sandbox')!, /\ballow-scripts\b/)
  // `allow-same-origin` здесь был бы отменой всей затеи: он возвращает рамке
  // наш origin, а с ним куки, localStorage и доступ к DOM страницы.
  assert.ok(!/allow-same-origin/.test(directives.get('sandbox')!))
})

test('скриптов ровно два: наш загрузчик по хэшу и бандл по точному адресу', () => {
  const scripts = directives.get('script-src')!.split(' ')
  assert.equal(scripts.length, 2, `в script-src ${scripts.length} источников: ${scripts.join(' ')}`)
  assert.match(scripts[0], /^'sha256-[A-Za-z0-9+/=]+'$/, 'загрузчик пущен не по хэшу')
  assert.equal(scripts[1], `${ORIGIN}${PLOTLY_BUNDLE_PATH}`)
  /*
   * `'self'` тут нет намеренно. В песочнице origin непрозрачный, опираться
   * этому слову не на что — а где оно всё-таки совпадает (Chrome читает его
   * от АДРЕСА ответа, это измерено), оно пускает в рамку любой файл нашего
   * инстанса, включая то, что в комнату загрузили студенты.
   */
  assert.ok(!/'self'/.test(directives.get('script-src')!))
  assert.ok(!/unsafe-eval/.test(policy), 'strict-сборка plotly не требует eval — и не должна получать его')
  assert.ok(!/unsafe-inline/.test(directives.get('script-src')!))
})

test('хэш загрузчика считается от того самого текста, который уедет в разметку', () => {
  const inline = /<script>([\s\S]*?)<\/script>/.exec(FRAME_HTML)
  assert.ok(inline, 'в разметке рамки нет инлайнового загрузчика')
  const hash = directives.get('script-src')!.split(' ')[0].slice(1, -1) // без кавычек
  const [algorithm, digest] = hash.split('-')
  assert.equal(algorithm, 'sha256')
  // Байт в байт: расхождение здесь — это рамка, которая молча перестала
  // рисовать вообще всё, и ошибка про CSP в консоли одного человека.
  assert.equal(crypto.createHash('sha256').update(inline[1], 'utf8').digest('base64'), digest)
})

test('из рамки не уходит ни один запрос — ни за данными, ни за картинкой', () => {
  assert.equal(directives.get('default-src'), "'none'")
  assert.equal(directives.get('connect-src'), "'none'")
  /*
   * Картинки только `data:` и `blob:`. НЕ `https:` — и это не педантизм:
   * `layout.images` с чужим адресом выдал бы автору фигуры IP каждого, кто
   * её открыл, то есть всей аудитории. Цена известна и принята: фигура с
   * картинкой по ссылке покажется без неё.
   */
  assert.equal(directives.get('img-src'), 'data: blob:')
  assert.ok(!/https?:/.test(directives.get('img-src')!))
})

test('оформление plotly пускается, чужая навигация — нет', () => {
  // plotly раскладывает график инлайновыми стилями и своим <style>: без
  // 'unsafe-inline' в style-src не рисуется вообще ничего.
  assert.equal(directives.get('style-src'), "'unsafe-inline'")
  assert.equal(directives.get('base-uri'), "'none'")
  assert.equal(directives.get('form-action'), "'none'")
  // Встроить рамку может только сам инстанс. `'none'`, как в общем заголовке,
  // здесь был бы запретом и для НАШЕЙ тетради.
  assert.equal(directives.get('frame-ancestors'), "'self'")
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/)
})

/* --------------------------------------------------------------- origin */

test('origin в заголовок попадает только по белому списку формы', () => {
  assert.equal(frameOrigin('http://localhost:5173'), 'http://localhost:5173')
  assert.equal(frameOrigin('https://hse.colloq.ru'), 'https://hse.colloq.ru')
  // Значение уезжает в Content-Security-Policy, где точка с запятой и перевод
  // строки — не мусор, а ВТОРАЯ директива. Поэтому не экранирование, а форма.
  assert.equal(frameOrigin('https://ok.ru; script-src *'), null)
  assert.equal(frameOrigin('https://ok.ru\nX-Frame-Options: none'), null)
  assert.equal(frameOrigin('javascript:alert(1)'), null)
  assert.equal(frameOrigin('https://ok.ru/path'), null)
  assert.equal(frameOrigin(undefined), null)
  assert.equal(frameOrigin('x'.repeat(400)), null)
})

/* -------------------------------------------------------------- маршрут */

let server: http.Server | undefined
let base = ''

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

const frameUrl = (origin: string) =>
  `${base}${PLOTLY_FRAME_PATH}?${PLOTLY_ORIGIN_PARAM}=${encodeURIComponent(origin)}`

test('рамка отдаётся своей политикой вместо общей и без удостоверения', async () => {
  const res = await fetch(frameUrl(ORIGIN))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-security-policy'), policy)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  const body = await res.text()
  // Страница пустая: показать она может только то, что ей пришлют
  // postMessage, то есть только то, что человек и так видит в своей тетради.
  assert.ok(body.includes(PLOTLY_MSG))
  assert.ok(body.includes(PLOTLY_BUNDLE_PATH))
  assert.ok(!body.includes('<script src='), 'бандл цепляется скриптом, а не тегом в разметке')
})

test('без origin рамки нет: политику собрать не из чего', async () => {
  assert.equal((await fetch(`${base}${PLOTLY_FRAME_PATH}`)).status, 400)
  assert.equal((await fetch(frameUrl('ftp://nope'))).status, 400)
})

test('загрузчик рамки сверяет источник сообщения, а не его origin', () => {
  /*
   * Origin песочницы — строка «null», и он ОДИНАКОВ у любой другой песочницы
   * на странице: сверять его бессмысленно. Сверяется окно-источник, и этого
   * достаточно — чужая рамка не станет нашим `window.parent`.
   */
  assert.match(FRAME_HTML, /e\.source!==window\.parent/)
  assert.match(FRAME_HTML, /msg\.colloq!==TAG/)
  // Прозрачный фон — против белой вспышки: подложку рисует тетрадь.
  assert.match(FRAME_HTML, /background:transparent/)
})
