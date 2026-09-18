/**
 * Зеркало colloq.cc должно оставаться зеркалом, а не вторым сайтом.
 *
 * Воркер из deploy/cloudflare/colloq-cc/ живёт на границе Cloudflare, и
 * увидеть его поломку иначе как по жалобе посетителя нельзя: журналов у него
 * нет, выкладка занимает секунду, а ошибки у него ровно того сорта, что
 * выглядят как рабочий сайт. Поэтому здесь проверяется не «отвечает», а четыре
 * свойства, каждое из которых уже стоило бы отдельного разбирательства.
 *
 * 1. Посетитель с зеркала не уезжает. GitHub Pages отвечает на /docs (без
 *    косой черты) редиректом на АБСОЛЮТНЫЙ https://colloq.ru/docs/ — и без
 *    правки Location человек, которому дали ссылку на colloq.cc, оказывается
 *    на colloq.ru после первого же клика. Именно из-за этого зеркало и не
 *    делается одной записью в DNS.
 *
 * 2. Поисковик видит ОДИН сайт. Тело страницы не правится ни байтом, и
 *    <link rel=canonical>, og:url и hreflang в ней и дальше называют colloq.ru.
 *    Соблазн «раз уж переписываем Location, перепишем и canonical» кончается
 *    двумя одинаковыми сайтами, конкурирующими друг с другом в выдаче.
 *
 * 3. Чужой адрес в Location не трогается. Правило «заменить colloq.ru на
 *    colloq.cc» в лоб увело бы редирект на github.com в несуществующую
 *    страницу зеркала.
 *
 * 4. Ошибка источника не застревает в кеше. Pages полежал минуту — зеркало не
 *    должно держать его пятисотку ещё пять.
 *
 * Оно же сторожит и мелочи, которые чинить потом дороже: что Host не уезжает
 * на Pages (а уехал бы — Pages отдал бы «There isn't a GitHub Pages site
 * here», потому что имя в site/CNAME одно), что условный запрос доживает до
 * источника (иначе 304 не случится никогда), и что кроме GET с HEAD зеркало не
 * умеет ничего.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = resolve(ROOT, 'deploy/cloudflare/colloq-cc/worker.js')

// Динамическим импортом, а не обычным: worker.js — настоящий .js без типов, и
// так его берут другие тесты, которым нужен модуль не на TypeScript.
const mod = (await import(pathToFileURL(WORKER).href)) as {
  default: { fetch(request: Request): Promise<Response> }
  rewriteVisibleDomain(text: string): string
  VISIBLE_DOMAIN_SELECTOR: string
}
const worker = mod.default
const { rewriteVisibleDomain, VISIBLE_DOMAIN_SELECTOR } = mod

type Call = { url: string; headers: Headers; method: string; cf: Record<string, unknown> }

const realFetch = globalThis.fetch

/**
 * Спросить зеркало, подсунув ему вместо настоящего colloq.ru свой ответ.
 *
 * Возвращает и ответ посетителю, и то, с чем воркер ходил на источник:
 * половина здешних проверок — как раз про второе.
 */
async function ask(
  target: string,
  upstream: (url: URL) => Response,
  init: RequestInit = {},
): Promise<{ response: Response; calls: Call[] }> {
  const calls: Call[] = []
  globalThis.fetch = (async (input: unknown, opts: Record<string, unknown> = {}) => {
    calls.push({
      url: String(input),
      headers: new Headers((opts.headers as HeadersInit) ?? {}),
      method: String(opts.method ?? 'GET'),
      cf: (opts.cf as Record<string, unknown>) ?? {},
    })
    return upstream(new URL(String(input)))
  }) as unknown as typeof fetch
  try {
    return { response: await worker.fetch(new Request(target, init)), calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

const page = (body = '<html></html>', init: ResponseInit = {}) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })

/**
 * Заглушка HTMLRewriter — ровно настолько, чтобы проверить ПРОВОДКУ.
 *
 * Настоящий HTMLRewriter живёт только на границе Cloudflare, а проверить надо
 * не его, а то, как воркер с ним разговаривает: тот ли селектор, правильно ли
 * склеиваются куски текста, не уезжает ли замена в <head>. Поэтому заглушка
 * повторяет его договор в двух местах, где у воркера есть шанс ошибиться.
 *
 * Первое: `body .host` действительно означает «только внутри body». Если из
 * селектора однажды уберут `body`, подпись в <head> начнёт подменяться — и
 * тест об этом скажет.
 *
 * Второе: текст приходит КУСКАМИ. Заглушка рубит его нарочно мелко, по четыре
 * символа, чтобы «colloq.ru» гарантированно оказался разорван границей. Так
 * накопитель в воркере проверяется, а не обходится.
 */
type Chunk = {
  text: string
  lastInTextNode: boolean
  replace(text: string, options?: { html?: boolean }): void
  remove(): void
}

const everyFour = (s: string): string[] => s.match(/[\s\S]{1,4}/g) ?? ['']

class ShimHTMLRewriter {
  private handlers: Array<{ classes: string[]; handler: { text(chunk: Chunk): void } }> = []

  on(selector: string, handler: { text(chunk: Chunk): void }): this {
    const classes: string[] = []
    for (const part of selector.split(',')) {
      const one = part.trim()
      // Всё, что не начинается с «body », заглушка не поддерживает намеренно:
      // молча расширить область замены она не должна.
      assert.ok(one.startsWith('body .'), `селектор должен быть внутри body: ${one}`)
      classes.push(one.slice('body .'.length))
    }
    this.handlers.push({ classes, handler })
    return this
  }

  transform(response: Response): Response {
    const handlers = this.handlers
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const html = await response.text()
        // Замена — только внутри body, как и просит селектор.
        const at = html.indexOf('<body')
        const head = at === -1 ? '' : html.slice(0, at)
        const rest = at === -1 ? html : html.slice(at)
        controller.enqueue(new TextEncoder().encode(head + ShimHTMLRewriter.apply(rest, handlers)))
        controller.close()
      },
    })
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  private static apply(
    html: string,
    handlers: Array<{ classes: string[]; handler: { text(chunk: Chunk): void } }>,
  ): string {
    return html.replace(
      /<([a-z]+)([^>]*\sclass="([^"]*)"[^>]*)>([^<]*)<\/\1>/gi,
      (whole, tag: string, attrs: string, cls: string, inner: string) => {
        const names = cls.split(/\s+/)
        const found = handlers.find((h) => h.classes.some((c) => names.includes(c)))
        if (!found) return whole
        const pieces = everyFour(inner)
        let out = ''
        pieces.forEach((piece, i) => {
          let emitted = piece
          found.handler.text({
            text: piece,
            lastInTextNode: i === pieces.length - 1,
            replace: (text: string) => { emitted = text },
            remove: () => { emitted = '' },
          })
          out += emitted
        })
        return `<${tag}${attrs}>${out}</${tag}>`
      },
    )
  }
}

// Воркер зовёт HTMLRewriter как глобальную величину — так он и объявлен в
// Workers. Подставляется заглушка один раз на весь файл.
;(globalThis as Record<string, unknown>).HTMLRewriter = ShimHTMLRewriter

test('путь и запрос доезжают до источника как есть, а Host — нет', async () => {
  const { response, calls } = await ask(
    'https://colloq.cc/docs/en/install.html?q=%D1%8F%D0%B4%D1%80%D0%BE&v=2#top',
    () => page(),
    { headers: { cookie: 'a=1', 'x-forwarded-host': 'evil.example', 'if-none-match': '"abc"' } },
  )
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)

  const asked = new URL(calls[0].url)
  assert.equal(asked.hostname, 'colloq.ru', 'ходить надо на источник, а не на само зеркало')
  assert.equal(asked.pathname, '/docs/en/install.html')
  assert.equal(asked.search, '?q=%D1%8F%D0%B4%D1%80%D0%BE&v=2')

  // Host задаётся адресом подзапроса; пришедший colloq.cc до Pages доезжать не
  // должен — он и есть тот единственный заголовок, из-за которого Pages
  // ответил бы «сайта здесь нет».
  assert.equal(calls[0].headers.get('host'), null)
  assert.equal(calls[0].headers.get('x-forwarded-host'), null)
  // Куки у зеркала не участвуют вовсе: ни своих нет, ни чужие возить незачем.
  assert.equal(calls[0].headers.get('cookie'), null)
  // А вот условный запрос обязан дожить до источника, иначе 304 не будет
  // никогда и зеркало станет качать страницу заново каждому нажатию F5.
  assert.equal(calls[0].headers.get('if-none-match'), '"abc"')
})

test('Location редиректа переписывается на зеркало, а чужой — нет', async () => {
  // Ровно то, чем Pages отвечает на /docs: абсолютный адрес источника.
  const absolute = await ask('https://colloq.cc/docs', () =>
    new Response(null, { status: 301, headers: { location: 'https://colloq.ru/docs/' } }))
  assert.equal(absolute.response.status, 301)
  assert.equal(absolute.response.headers.get('location'), 'https://colloq.cc/docs/')

  // Относительный Location тоже считается «своим»: без базы на вопрос «чей это
  // адрес» ответить нечем, и оставленный как есть он увёл бы браузер по
  // адресу зеркала — но проверить это надо, а не надеяться.
  const relative = await ask('https://colloq.cc/docs', () =>
    new Response(null, { status: 301, headers: { location: '/docs/' } }))
  assert.equal(relative.response.headers.get('location'), 'https://colloq.cc/docs/')

  // Запрос при переписывании не теряется.
  const withQuery = await ask('https://colloq.cc/x', () =>
    new Response(null, { status: 302, headers: { location: 'https://colloq.ru/y?a=1' } }))
  assert.equal(withQuery.response.headers.get('location'), 'https://colloq.cc/y?a=1')

  // Чужой адрес — чужой: замена подстроки в лоб отправила бы человека на
  // несуществующую страницу зеркала.
  const foreign = await ask('https://colloq.cc/x', () =>
    new Response(null, { status: 302, headers: { location: 'https://github.com/sleep3r/colloq' } }))
  assert.equal(foreign.response.headers.get('location'), 'https://github.com/sleep3r/colloq')
})

// Настоящий подвал лендинга и настоящий адрес курса, слово в слово из site/.
const LANDING = [
  '<html><head>',
  '<link rel="canonical" href="https://colloq.ru/" />',
  '<meta property="og:url" content="https://colloq.ru/" />',
  '<meta property="og:image" content="https://colloq.ru/img/og.png?v=30b2e08a" />',
  '<link rel="alternate" hreflang="en" href="https://colloq.ru/docs/en/" />',
  // Подпись с тем же классом, но в шапке: сюда замена дотянуться не должна.
  '<span class="host">colloq.ru</span>',
  '</head><body>',
  '<a href="https://github.com/sleep3r/colloq">GitHub</a>',
  '<a class="host" href="mailto:sleep3r@icloud.com">sleep3r@icloud.com</a>',
  '<span class="host">colloq.ru</span>',
  '<p class="note">Семинар открывается на hse.colloq.ru</p>',
  '</body></html>',
].join('\n')

test('видимый домен становится зеркалом, а голова страницы — нет', async () => {
  const { response } = await ask('https://colloq.cc/', () => page(LANDING))
  const out = await response.text()

  // Подпись в подвале — единственное, что поменялось.
  assert.ok(out.includes('<body>\n<a href="https://github.com/sleep3r/colloq">GitHub</a>'))
  assert.ok(out.includes('<span class="host">colloq.cc</span>'), 'подвал должен звать зеркало')

  // Голова не тронута ни в одной строке: поисковику полагается видеть ОДИН
  // канонический сайт, а не две одинаковые копии.
  const head = out.slice(0, out.indexOf('<body'))
  assert.ok(head.includes('<link rel="canonical" href="https://colloq.ru/" />'))
  assert.ok(head.includes('<meta property="og:url" content="https://colloq.ru/" />'))
  assert.ok(head.includes('content="https://colloq.ru/img/og.png?v=30b2e08a"'))
  assert.ok(head.includes('hreflang="en" href="https://colloq.ru/docs/en/"'))
  assert.ok(head.includes('<span class="host">colloq.ru</span>'), 'в <head> замены быть не должно')

  // Ссылки не трогаются: они либо от корня, либо абсолютные нарочно.
  assert.ok(out.includes('href="https://github.com/sleep3r/colloq"'))
  // Почта автора носит тот же класс, но домена в её тексте нет — и она
  // остаётся собой целиком, вместе с адресом.
  assert.ok(out.includes('<a class="host" href="mailto:sleep3r@icloud.com">sleep3r@icloud.com</a>'))
  // Имя семинара живёт в зоне colloq.ru у ретранслятора, и в .cc его нет.
  assert.ok(out.includes('hse.colloq.ru'), 'поддомен ретранслятора подменять нельзя')

  // И построчно: кроме одной строки подвала не изменилось ничего.
  const before = LANDING.split('\n')
  const after = out.split('\n')
  assert.equal(after.length, before.length)
  const changed = before.map((line, i) => [i, line, after[i]] as const).filter(([, a, b]) => a !== b)
  assert.deepEqual(changed, [[9, '<span class="host">colloq.ru</span>', '<span class="host">colloq.cc</span>']])
})

test('адрес курса на его странице тоже становится адресом зеркала', async () => {
  const course = '<html><head></head><body><p class="addr">colloq.ru/c/ml-strong</p></body></html>'
  const { response } = await ask('https://colloq.cc/c/ml-strong/', () => page(course))
  assert.equal(
    await response.text(),
    '<html><head></head><body><p class="addr">colloq.cc/c/ml-strong</p></body></html>',
  )
})

test('замена переживает разрыв текста между кусками', async () => {
  // Заглушка режет текст по четыре символа, так что «colloq.ru» гарантированно
  // разорван: без накопителя замена не случилась бы вовсе, а без chunk.remove()
  // начало строки уехало бы читателю дважды.
  const html = '<html><head></head><body><p class="addr">пиши на colloq.ru/docs/ сюда</p></body></html>'
  const { response } = await ask('https://colloq.cc/', () => page(html))
  assert.equal(
    await response.text(),
    '<html><head></head><body><p class="addr">пиши на colloq.cc/docs/ сюда</p></body></html>',
  )
})

test('замена домена знает границы имени', () => {
  // Проверяется отдельно от разметки: на живом воркере эти границы не
  // разглядеть, а ошибка в любой из них тихо ломает либо подпись, либо
  // инструкцию про ретранслятор.
  assert.equal(rewriteVisibleDomain('colloq.ru'), 'colloq.cc')
  assert.equal(rewriteVisibleDomain('colloq.ru/c/ml-strong'), 'colloq.cc/c/ml-strong')
  assert.equal(rewriteVisibleDomain('colloq.ru/docs/'), 'colloq.cc/docs/')
  assert.equal(rewriteVisibleDomain('открой colloq.ru, там всё'), 'открой colloq.cc, там всё')
  assert.equal(rewriteVisibleDomain('colloq.ru и colloq.ru'), 'colloq.cc и colloq.cc')
  // Поддомены ретранслятора — чужая зона, их в .cc нет.
  assert.equal(rewriteVisibleDomain('hse.colloq.ru'), 'hse.colloq.ru')
  assert.equal(rewriteVisibleDomain('*.colloq.ru'), '*.colloq.ru')
  // Слово, которое просто начинается так же.
  assert.equal(rewriteVisibleDomain('colloq.ruby'), 'colloq.ruby')
  assert.equal(rewriteVisibleDomain('xcolloq.ru'), 'xcolloq.ru')
  // Менять нечего — строка обязана вернуться той же самой.
  assert.equal(rewriteVisibleDomain('sleep3r@icloud.com'), 'sleep3r@icloud.com')
})

test('замена не может дотянуться до головы страницы по построению', () => {
  // Не «мы проверили одну страницу», а «селектор физически ограничен body».
  for (const part of VISIBLE_DOMAIN_SELECTOR.split(',')) {
    assert.match(part.trim(), /^body \./, `селектор обязан начинаться с body: ${part}`)
  }
})

test('всё, что не разметка, течёт насквозь байт в байт', async () => {
  // Шрифт, картинка, css, json через HTMLRewriter не ходят вовсе — и длина с
  // упаковкой у них остаются те, что приехали от источника.
  const css = 'body{--host:"colloq.ru"}'
  const { response } = await ask('https://colloq.cc/styles.css', () =>
    new Response(css, {
      headers: { 'content-type': 'text/css; charset=utf-8', 'content-length': String(css.length) },
    }))
  assert.equal(await response.text(), css, 'css не должен подменяться')
  assert.equal(response.headers.get('content-length'), String(css.length))
})

test('после пересборки разметки длина и упаковка не остаются от источника', async () => {
  const { response } = await ask('https://colloq.cc/', () =>
    page(LANDING, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(LANDING.length),
        'content-encoding': 'gzip',
      },
    }))
  // Они описывали ПРЕЖНЕЕ тело. Даже когда длина совпала случайно (colloq.ru и
  // colloq.cc — оба девять байт), оставлять их нельзя: правка списка классов
  // эту случайность сломает, а выглядеть это будет как оборванная страница.
  assert.equal(response.headers.get('content-length'), null)
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
})

test('кроме GET и HEAD зеркало не умеет ничего', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const { response, calls } = await ask('https://colloq.cc/', () => page(), { method })
    assert.equal(response.status, 405, `${method} должен получить 405`)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
    assert.equal(calls.length, 0, `${method} не должен доезжать до источника`)
  }

  const head = await ask('https://colloq.cc/', () => page(), { method: 'HEAD' })
  assert.equal(head.response.status, 200)
  assert.equal(head.calls[0].method, 'HEAD')
})

test('www разворачивается на апекс, не тревожа источник', async () => {
  const { response, calls } = await ask('https://www.colloq.cc/docs/?a=1', () => page())
  assert.equal(response.status, 301)
  assert.equal(response.headers.get('location'), 'https://colloq.cc/docs/?a=1')
  assert.equal(calls.length, 0, 'за редиректом на источник ходить незачем')
})

test('ответ источника проходит насквозь, а его ошибка не остаётся в кеше', async () => {
  const missing = await ask('https://colloq.cc/nope', () => page('not found', { status: 404 }))
  assert.equal(missing.response.status, 404)
  assert.equal(await missing.response.text(), 'not found')
  // Ненайденное кешируется, но коротко: страница могла появиться выкладкой.
  assert.equal((missing.calls[0].cf.cacheTtlByStatus as Record<string, number>)['404'], 60)

  const broken = await ask('https://colloq.cc/', () => page('oops', { status: 502 }))
  assert.equal(broken.response.status, 502)
  assert.equal(broken.response.headers.get('cache-control'), 'no-store')
  assert.equal((broken.calls[0].cf.cacheTtlByStatus as Record<string, number>)['500-599'], 0)
})

test('свои куки источник тоже не раздаёт через зеркало', async () => {
  const { response } = await ask('https://colloq.cc/', () =>
    page('<html></html>', { headers: { 'set-cookie': 'session=1' } }))
  assert.equal(response.headers.get('set-cookie'), null)
})

test('сроки жизни развёрстаны по тому, как больно устареть', async () => {
  // Имена файлов в site/ без отпечатка содержимого: styles.css после выкладки
  // остаётся styles.css. Поэтому долго живут только шрифты и картинки, css с
  // js — час, разметка — пять минут.
  const cases: Array<[string, number]> = [
    ['/fonts/hse-sans-400.woff2', 86400],
    ['/img/workspace.webp', 86400],
    ['/img/og.png?v=30b2e08a', 86400],
    ['/styles.css', 3600],
    ['/docs/docs.js', 3600],
    ['/docs/', 300],
    ['/c/ml-strong/', 300],
    ['/docs/search-index.json', 300],
  ]
  for (const [path, seconds] of cases) {
    const { response, calls } = await ask(`https://colloq.cc${path}`, () => page())
    assert.equal(
      response.headers.get('cache-control'),
      `public, max-age=${seconds}`,
      `${path} должен жить ${seconds} с`,
    )
    // И то же число — границе Cloudflare, иначе кеш есть только у браузера,
    // а каждый новый посетитель по-прежнему ждёт ответа Pages.
    assert.equal(calls[0].cf.cacheEverything, true)
    assert.equal((calls[0].cf.cacheTtlByStatus as Record<string, number>)['200-299'], seconds)
  }
})

test('HSTS есть на каждом ответе, включая 405 и редирект с www', async () => {
  const expected = 'max-age=31536000; includeSubDomains'
  const answers = await Promise.all([
    ask('https://colloq.cc/', () => page()),
    ask('https://colloq.cc/', () => page(), { method: 'POST' }),
    ask('https://www.colloq.cc/', () => page()),
    ask('https://colloq.cc/nope', () => page('', { status: 404 })),
  ])
  for (const { response } of answers) {
    // Заголовок, который приходит только со страницами, не защищает первый
    // заход по http — а он и есть единственный, который успевают прочитать.
    assert.equal(response.headers.get('strict-transport-security'), expected)
  }
})

test('по ответу видно, что это зеркало, а не подменённый DNS', async () => {
  const { response } = await ask('https://colloq.cc/', () => page())
  assert.equal(response.headers.get('x-colloq-mirror'), 'colloq.ru')
})
