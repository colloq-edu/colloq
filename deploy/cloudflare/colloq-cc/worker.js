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
// Всё остальное остаётся как есть, и это решение, а не лень. В <head> лежат
// <link rel=canonical>, og:url и hreflang, и все они обязаны и дальше
// указывать на colloq.ru: поисковику полагается видеть ОДИН канонический
// сайт, а не две одинаковые копии, конкурирующие друг с другом. Атрибуты
// href не трогаются вовсе — ссылки либо от корня, либо абсолютные нарочно
// (GitHub, PyPI, почта автора).
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

    const body = NULL_BODY.has(response.status) ? null : response.body
    // Разметку — через замену видимого домена, всё остальное (шрифты,
    // картинки, css, json) не пересобирается вовсе и течёт насквозь.
    const html = (out.get('content-type') || '').toLowerCase().startsWith('text/html')

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

    return body && html
      ? new HTMLRewriter().on(VISIBLE_DOMAIN_SELECTOR, new VisibleDomain()).transform(answer)
      : answer
  },
}
