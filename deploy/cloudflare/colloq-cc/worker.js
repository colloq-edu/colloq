// Зеркало colloq.ru на colloq.cc.
//
// Зачем здесь вообще код, а не вторая запись в DNS. GitHub Pages отдаёт сайт
// по ОДНОМУ собственному имени: в site/CNAME написано colloq.ru, и запрос с
// заголовком `Host: colloq.cc` Pages встречает своей страницей «There isn't a
// GitHub Pages site here». CNAME на sleep3r.github.io — хоть серый, хоть
// оранжевый — даёт ровно это, потому что Pages разбирает именно Host. Значит,
// между посетителем и Pages нужен кто-то, кто подменит Host на colloq.ru;
// этим воркер и занят, и в этом вся его работа.
//
// Почему нельзя переехать на colloq.cc целиком. Пограничные адреса Cloudflare
// из России не открываются (об этом шапка scripts/dns.sh и весь тамошний
// «серое облако везде»), поэтому colloq.ru обязан остаться серым и смотреть
// прямо на Pages. colloq.cc — имя для тех, кому Cloudflare доступен, и живёт
// оно оранжевым. Два имени, один источник: site/ в этом репозитории.
//
// Из тела страницы правится РОВНО ОДНО: домен, напечатанный на ней текстом
// (подпись в подвале, адрес курса) — см. VISIBLE_DOMAIN_SELECTOR ниже. Его
// читают глазами и переписывают в адресную строку, и на зеркале он обязан
// называть зеркало.
//
// Всё остальное в теле остаётся как есть, и это решение, а не лень. Атрибуты
// href не трогаются вовсе — ссылки либо от корня, либо абсолютные нарочно
// (GitHub, PyPI, почта автора).
//
// В <head> правятся теги превью — og: и twitter:, и только на лендинге; см.
// «превью ссылки» ниже. <title>, <meta name=description>, <link rel=canonical>
// и hreflang не трогаются никогда: поисковику полагается видеть ОДИН
// канонический сайт, а не две одинаковые копии, конкурирующие друг с другом.
//
// Единственное исключение — Location у редиректов. Pages отвечает на /docs
// (без косой черты) буквально `location: https://colloq.ru/docs/`, и без
// правки посетитель, попросивший /docs на зеркале, уезжал бы на colloq.ru —
// то есть туда, откуда его сюда и отправили.
//
// Комнат занятий здесь нет: они живут на машинах преподавателей и на именах
// *.colloq.ru через ретранслятор, а на самом colloq.ru лежит только статика —
// лендинг, /docs/ и опубликованные курсы /c/. Проксировать динамику не нужно,
// поэтому и куки здесь не участвуют вовсе: ни туда, ни обратно.

const ORIGIN = 'colloq.ru'
const MIRROR = 'colloq.cc'

// Сколько ответ живёт у браузера и на границе Cloudflare.
//
// Числа разные, и разведены они по одной причине: имена файлов в site/ НЕ
// содержат отпечатка содержимого. styles.css после выкладки остаётся
// styles.css, поэтому долгий срок жизни на нём — это не «быстро», а «человек
// сутки видит старую вёрстку поверх новой разметки».
//
//   media — шрифты и картинки. Меняются вместе с дизайном, то есть почти
//           никогда, а устаревшая картинка — это косметика, не поломка.
//   code  — css и js. Меняются каждой выкладкой и ломаются заметно, если
//           разъедутся с разметкой: час — потолок расхождения.
//   page  — html и всё остальное. Сам Pages говорит про себя max-age=600;
//           пять минут на зеркале не делают его свежее источника.
const TTL = { media: 86400, code: 3600, page: 300 }

const MEDIA = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|webp|avif|gif|svg|ico)$/i
const CODE = /\.(?:css|m?js|map)$/i

// Заголовки, которые до Pages не доезжают.
//
// host — ради него всё и затевалось: адрес запроса задаёт хост сам, а
//   пришедший colloq.cc в заголовке вернул бы нас к «сайта здесь нет».
// cookie — у зеркала нет ни одной своей куки, и возить на Pages чужие (домен
//   верхнего уровня .cc делят с кем угодно) незачем.
// x-forwarded-* — их сочиняет клиент, и Pages не должен принимать сочинённое
//   за правду о себе.
const DROP_FROM_REQUEST = ['host', 'cookie', 'x-forwarded-host', 'x-forwarded-proto']

// Статусы, у которых тела не бывает. Конструктор Response с телом при таком
// статусе бросает исключение — и в Workers, и в node.
const NULL_BODY = new Set([101, 204, 205, 304])

/** Сколько секунд держать ответ на этот путь. */
function ttlFor(pathname) {
  if (MEDIA.test(pathname)) return TTL.media
  if (CODE.test(pathname)) return TTL.code
  return TTL.page
}

/**
 * Адрес из Location — на зеркало, если он указывал на источник.
 *
 * Возвращает null, когда трогать нечего: тогда Location уезжает как приехал.
 * Чужие адреса (скажем, редирект на github.com) переписывать нельзя — это
 * увело бы посетителя на несуществующую страницу зеркала.
 */
function toMirror(location) {
  let target
  try {
    // База нужна: Location у Pages бывает и относительным («/docs/»), а без
    // базы на вопрос «чей это адрес» ответить нечем.
    target = new URL(location, `https://${ORIGIN}/`)
  } catch {
    return null
  }
  if (target.hostname !== ORIGIN && target.hostname !== `www.${ORIGIN}`) return null
  target.hostname = MIRROR
  return target.toString()
}

// ------------------------------------------------- видимое имя на странице
//
// В разметке есть места, где домен НАПЕЧАТАН текстом, а не стоит ссылкой:
// подпись в подвале лендинга (`<span class="host">colloq.ru</span>`) и адрес
// курса на его странице (`<p class="addr">colloq.ru/c/ml-strong</p>`, его
// собирает server/src/publish/render.ts). Их читают глазами и переписывают в
// адресную строку — значит, на зеркале они обязаны называть зеркало.
//
// Список классов закрытый и короткий, и это важнее, чем кажется. Соблазн
// дописать сюда <code> ломает документацию: в site/docs/networking.html
// сказано, что скрипт настраивает ретранслятор «на зону проекта colloq.ru,
// которая вам не принадлежит», — это утверждение про настоящую зону DNS, а не
// про адрес открытой страницы, и подмена превратила бы его в неправду. То же
// в language.html и students.html. Поэтому правятся ровно два класса, и оба
// означают одно: «адрес, по которому вы сейчас находитесь».
//
// `body` впереди — структурная гарантия, а не украшение. В <head> лежат
// canonical, og:url и hreflang, которым положено и дальше звать colloq.ru;
// с таким селектором замена просто не может туда дотянуться, и это не нужно
// помнить при следующей правке.
export const VISIBLE_DOMAIN_SELECTOR = 'body .host, body .addr'

// Имя целиком, а не подстрока: вся тонкость здесь в границах.
//
//   colloq.ru        -> colloq.cc      подпись в подвале
//   colloq.ru/c/x    -> colloq.cc/c/x  адрес курса (косая черта справа — можно)
//   hse.colloq.ru       остаётся       имена семинаров раздаёт ретранслятор в
//                                      зоне colloq.ru, и в .cc их нет вовсе
//   colloq.ruby         остаётся       это не наш домен
//
// Слева поэтому не должно быть ни точки, ни буквы (иначе это поддомен или
// чужое слово), справа — ни буквы, ни дефиса (иначе другая зона).
const VISIBLE_DOMAIN = new RegExp(`(?<![\\w.-])${ORIGIN.replace(/\./g, '\\.')}(?![\\w-])`, 'g')

/**
 * Подменить домен в видимом тексте. Чистая функция — её и проверяют тестом:
 * на живом воркере границы имени не разглядеть.
 */
export function rewriteVisibleDomain(text) {
  return text.replace(VISIBLE_DOMAIN, MIRROR)
}

/**
 * Накопитель текста одного узла.
 *
 * HTMLRewriter отдаёт текст КУСКАМИ, и граница куска приходится куда угодно —
 * в том числе на середину «colloq.ru». Замена покусочно пропустила бы такое
 * имя молча, поэтому текст копится до lastInTextNode и подменяется целиком.
 * Промежуточные куски при этом убираются: иначе они уедут читателю дважды —
 * сами по себе и ещё раз в накопленной строке.
 */
class VisibleDomain {
  constructor() {
    this.buffer = ''
    this.split = false
  }

  text(chunk) {
    this.buffer += chunk.text
    if (!chunk.lastInTextNode) {
      chunk.remove()
      this.split = true
      return
    }
    const replaced = rewriteVisibleDomain(this.buffer)
    // Пришло одним куском и менять нечего — не трогаем вовсе: там, где
    // подменять нечего, страница обязана доехать байт в байт. Это же и про
    // `<a class="host" href="mailto:…">` в подвале: домена в её тексте нет,
    // и она остаётся собой.
    if (this.split || replaced !== this.buffer) chunk.replace(replaced, { html: false })
    this.buffer = ''
    this.split = false
  }
}

// ------------------------------------------------------- превью ссылки
//
// Разворачиватель ссылок (Telegram, WhatsApp, Slack, iMessage, X, Discord,
// Facebook) не исполняет JS. Автовыбор языка на лендинге сделан скриптом в
// <head>, и до бота он не доезжает вовсе: бот забирает `/`, читает og: и
// twitter: и показывает РУССКУЮ карточку — в том числе тому, кому дали
// colloq.cc, имя как раз для тех, у кого русского нет.
//
// Поэтому на зеркале корень лендинга отдаёт теги превью своего английского
// близнеца. Близнец ищется не по зашитому адресу, а по самой странице: в её
// <head> стоит <link rel="alternate" hreflang="en" href="…">, и это ровно то
// место, где живёт ответ на вопрос «а где английская версия». Переедет —
// переедет и превью.
//
// Только ЛЕНДИНГ: корню подставляются теги близнеца, английской странице —
// её собственные, ей нужны лишь своя картинка и свой адрес. У /docs/ и у
// страниц курсов автовыбора языка нет, и английское превью привело бы там на
// русскую страницу, то есть соврало бы; их голова не трогается ни тегом.
//
// Меняется содержимое тегов, а не разметка вокруг: <title> и description
// остаются русскими — их читает поисковик, и ему полагается правда про
// страницу, которую он сейчас качает.
//
// og:url — единственный тег, который разворачиватель может ПЕРЕЧИТАТЬ:
// Facebook и всё, что построено на его схеме, считает адрес из og:url
// каноническим и идёт за тегами уже туда. Оставленный colloq.ru он увёл бы
// бота обратно на источник — и человек, приславший colloq.cc, получил бы
// русскую карточку с чужим доменом в подписи. Поэтому на зеркале og:url
// называет зеркало, причём ТОТ ЖЕ адрес, который открыли: перечитав его, бот
// получит ровно эти же теги, и картинка не «переедет» со второго захода.
// Канон при этом остаётся у colloq.ru — он в <link rel=canonical>, и это
// именно тот сигнал, по которому поисковик склеивает копии.
const LANDING_ROOT = new Set(['/', '/index.html'])
const ENGLISH_LANDING = new Set(['/en/', '/en/index.html'])
const PREVIEW_SELECTOR = 'head meta[property^="og:"], head meta[name^="twitter:"]'

// Картинка превью: английская лежит на источнике, зеркальная — своя, с
// подписью colloq.cc. Обе рисует scripts/site-og.mts.
const IMAGE_ORIGIN = '/img/og-en.png'
const IMAGE_MIRROR = '/img/og-cc.png'

/**
 * Адрес английского близнеца — из <link rel="alternate" hreflang="en">.
 *
 * null, когда ссылки нет: тогда подменять нечего и страница едет как есть.
 * Порядок атрибутов не важен — их и пишут по-разному.
 */
export function twinHref(html) {
  const head = html.slice(0, html.indexOf('</head>') + 1 || undefined)
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\srel=["']?alternate["']?/i.test(tag)) continue
    if (!/\shreflang=["']?en["']?/i.test(tag)) continue
    const href = /\shref="([^"]*)"/i.exec(tag) || /\shref='([^']*)'/i.exec(tag)
    if (href) return href[1]
  }
  return null
}

/**
 * Теги превью страницы: ключ (og:title, twitter:card) → содержимое.
 *
 * Читается только <head>: og-теги в теле — это чужая цитата или пример в
 * документации, и им здесь делать нечего.
 */
export function previewTags(html) {
  const head = html.slice(0, html.indexOf('</head>') + 1 || undefined)
  const tags = new Map()
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key =
      (/\sproperty="([^"]*)"/i.exec(tag) || /\sproperty='([^']*)'/i.exec(tag) || [])[1] ||
      (/\sname="([^"]*)"/i.exec(tag) || /\sname='([^']*)'/i.exec(tag) || [])[1]
    if (!key || !(key.startsWith('og:') || key.startsWith('twitter:'))) continue
    const content = /\scontent="([^"]*)"/i.exec(tag) || /\scontent='([^']*)'/i.exec(tag)
    if (content) tags.set(key, content[1])
  }
  return tags
}

/**
 * Картинка превью на зеркале — или null, если менять нечего.
 *
 * Подменяется РОВНО английская картинка источника: пока owner не выложил
 * og-en.png, теги близнеца зовут старый og.png, условие не срабатывает, и
 * зеркало показывает то же, что источник. Так воркер можно поставить раньше
 * картинок и не получить 404 в превью.
 *
 * Метка ?v= переносится как есть. Она обязана МЕНЯТЬСЯ вместе с картинкой, а
 * обе рисует один скрипт в одном коммите — значит, метка английской годится и
 * для зеркальной, и лишнего запроса к источнику за ней не нужно.
 */
export function mirrorPreviewImage(content) {
  let target
  try {
    target = new URL(content, `https://${ORIGIN}/`)
  } catch {
    return null
  }
  if (target.hostname !== ORIGIN && target.hostname !== MIRROR) return null
  if (target.pathname !== IMAGE_ORIGIN) return null
  target.protocol = 'https:'
  target.hostname = MIRROR
  target.pathname = IMAGE_MIRROR
  return target.toString()
}

/**
 * Подменить содержимое одного тега превью. Чистая функция — ей и проверяется
 * вся развилка: что берётся у близнеца, что у самой страницы, что у зеркала.
 *
 * `tags` — теги английского близнеца или null, когда страница уже английская.
 * `ogUrl` — адрес этой же страницы на зеркале.
 */
export function previewContent(key, own, tags, ogUrl) {
  if (key === 'og:url') return ogUrl
  const value = tags && tags.has(key) ? tags.get(key) : own
  if (value === null || value === undefined) return null
  return mirrorPreviewImage(value) ?? value
}

/** Обработчик HTMLRewriter поверх previewContent. */
class Preview {
  constructor(tags, ogUrl) {
    this.tags = tags
    this.ogUrl = ogUrl
  }

  element(el) {
    const key = el.getAttribute('property') ?? el.getAttribute('name')
    if (!key) return
    const own = el.getAttribute('content')
    const value = previewContent(key, own, this.tags, this.ogUrl)
    if (value !== null && value !== own) el.setAttribute('content', value)
  }
}

/**
 * Забрать теги превью у английского близнеца этой страницы.
 *
 * null при любой осечке — нет ссылки, не тот хост, источник не ответил,
 * тегов не нашлось. Тогда страница отдаётся нетронутой: превью на чужом языке
 * — беда, а страница без превью — та же страница.
 */
async function twinTags(html) {
  try {
    const href = twinHref(html)
    if (!href) return null
    const target = new URL(href, `https://${ORIGIN}/`)
    // Только источник: hreflang в чужой разметке не должен превращаться в
    // запрос воркера куда попало, а ссылка на само зеркало — в петлю.
    if (target.hostname !== ORIGIN) return null
    const answer = await fetch(target.toString(), {
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': TTL.page, '300-599': 0 } },
    })
    if (!answer.ok) return null
    const tags = previewTags(await answer.text())
    return tags.size ? tags : null
  } catch {
    return null
  }
}

/**
 * HSTS — на КАЖДЫЙ ответ, включая 405 и редирект с www.
 *
 * Заголовок, который приходит только со страницами, не защищает первый заход
 * на http://colloq.cc/что-угодно: именно он и есть тот единственный запрос,
 * который успевают прочитать по дороге.
 */
function guarded(response) {
  response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
  return response
}

export default {
  async fetch(request) {
    const url = new URL(request.url)

    // Только чтение. Сайт статический: POST и всё остальное на зеркале — это
    // либо ошибка, либо чужой сканер, ищущий админку. Пересылать такое на
    // Pages смысла нет, а отвечать за него — тем более.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return guarded(
        new Response('Method Not Allowed\n', {
          status: 405,
          headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
        }),
      )
    }

    // www → апекс. Одно каноническое имя у зеркала, и причин тому две:
    // Cloudflare иначе держит в кеше две копии каждой страницы, а поисковик
    // видит уже ТРЕТИЙ адрес того же сайта — при том что вся затея ровно в
    // обратном. Редирект собирается руками, а не через Response.redirect:
    // у того заголовки неизменяемы, и HSTS на него не повесить.
    if (url.hostname === `www.${MIRROR}`) {
      const apex = new URL(url)
      apex.hostname = MIRROR
      return guarded(new Response(null, { status: 301, headers: { location: apex.toString() } }))
    }

    // Путь и запрос переносятся как есть — копией адреса, а не сборкой строки:
    // так ничего не теряется и не перекодируется по дороге.
    const upstream = new URL(url)
    upstream.protocol = 'https:'
    upstream.hostname = ORIGIN
    upstream.port = ''

    const headers = new Headers(request.headers)
    for (const name of DROP_FROM_REQUEST) headers.delete(name)

    const ttl = ttlFor(url.pathname)

    const response = await fetch(upstream.toString(), {
      method: request.method,
      headers,
      // Ручной разбор редиректов. Иначе Location от Pages отработает внутри
      // воркера, посетитель получит готовую страницу по адресу, которого не
      // просил, и /docs навсегда останется в адресной строке без косой черты —
      // а все относительные ссылки на такой странице съедут на этаж выше.
      redirect: 'manual',
      // Кеш на границе. colloq.ru — зона того же аккаунта, поэтому настройки
      // cf для подзапроса действуют. Пятисотки не кешируются вовсе: минута
      // лежачего Pages не должна превращаться в час лежачего зеркала.
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { '200-299': ttl, '301-302': ttl, '404': 60, '500-599': 0 },
      },
    })

    const out = new Headers(response.headers)
    // Куки у зеркала не участвуют ни в одну сторону.
    out.delete('set-cookie')

    const location = response.headers.get('location')
    if (location) {
      const fixed = toMirror(location)
      if (fixed) out.set('location', fixed)
    }

    if (response.status >= 500) {
      // Ошибку источника кешировать нельзя: Pages полежал минуту — зеркало
      // держало бы его пятисотку у посетителя ещё пять.
      out.set('cache-control', 'no-store')
    } else if (response.status !== 304) {
      out.set('cache-control', `public, max-age=${ttl}`)
    }

    // Чтобы `curl -sI https://colloq.cc/` одной строкой отвечал на вопрос
    // «это зеркало или мне подменили DNS».
    out.set('x-colloq-mirror', ORIGIN)

    let body = NULL_BODY.has(response.status) ? null : response.body
    // Разметку — через замену видимого домена, всё остальное (шрифты,
    // картинки, css, json) не пересобирается вовсе и течёт насквозь.
    const html = (out.get('content-type') || '').toLowerCase().startsWith('text/html')

    // Теги превью правятся на лендинге и только на нём; корню вдобавок нужен
    // английский близнец, а чтобы его найти, страницу приходится прочитать
    // целиком. Это одна страница на весь сайт, и ради неё поток не жалко:
    // всё остальное по-прежнему течёт насквозь.
    const preview = body && html && response.status === 200
    const root = preview && LANDING_ROOT.has(url.pathname)
    let tags = null
    if (root) {
      body = await response.text()
      tags = await twinTags(body)
    }

    if (body && html) {
      // После пересборки заголовки о РАЗМЕРЕ и УПАКОВКЕ описывают уже не то
      // тело, что приехало: HTMLRewriter отдаёт его потоком и заново. Даже
      // когда длина совпала случайно (colloq.ru и colloq.cc — оба девять
      // байт), оставлять их нельзя: следующая правка списка классов эту
      // случайность сломает, а выглядеть это будет как оборванная страница.
      // Сжатием на границе занимается Cloudflare, ему эти заголовки не нужны.
      out.delete('content-length')
      out.delete('content-encoding')
    }

    const answer = guarded(
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: out,
      }),
    )

    if (!body || !html) return answer

    const rewriter = new HTMLRewriter().on(VISIBLE_DOMAIN_SELECTOR, new VisibleDomain())
    // Корень — только когда близнец нашёлся: наполовину подменённая голова
    // (русские теги с адресом зеркала в og:url) хуже нетронутой, потому что
    // выглядит рабочей. Английская страница в близнеце не нуждается вовсе —
    // она уже он, и ей нужна только своя картинка и свой адрес.
    if ((root && tags) || (preview && ENGLISH_LANDING.has(url.pathname))) {
      rewriter.on(PREVIEW_SELECTOR, new Preview(tags, `https://${MIRROR}${url.pathname}`))
    }
    return rewriter.transform(answer)
  },
}
