import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { normalizeLocale, type Locale } from '@shared/i18n'
import type { Encoding } from './http-encoding.js'

const brotliCompress = promisify(zlib.brotliCompress)
const gzipCompress = promisify(zlib.gzip)

/**
 * Что в странице зависит от адреса: заголовок вкладки и теги карточки ссылки.
 *
 * Собранный index.html один на все адреса, а мессенджеру, который разворачивает
 * ссылку на комнату, нужно имя занятия — его знает только сервер
 * (link-preview.ts). `head` вставляется перед `</head>` как есть: экранирует
 * тот, кто его собрал.
 */
export interface PageExtras {
  readonly title?: string
  readonly head?: string
}

/** Small public bootstrap data: the browser need not fetch it before mounting. */
export function withInitialLanguage(html: string, language: Locale, extras: PageExtras = {}): string {
  const locale = normalizeLocale(language)
  const meta = `<meta name="colloq-language" content="${locale}">`
  if (extras.title !== undefined) {
    const title = extras.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    html = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${title}</title>`)
  }
  /*
   * Карточка ссылки — в самое начало head, сразу за кодировкой: у собранной
   * страницы до `</head>` двенадцать килобайт стилей и скриптов, а сколько
   * читает разворачиватель ссылок в чате, нигде не написано.
   */
  if (extras.head) {
    html = /<meta\s+charset=[^>]*>/i.test(html)
      ? html.replace(/<meta\s+charset=[^>]*>/i, (charset) => charset + extras.head)
      : /<head\b[^>]*>/i.test(html)
        ? html.replace(/<head\b[^>]*>/i, (head) => head + extras.head)
        : extras.head + html
  }
  const localized = html.replace(/<html\b([^>]*)>/i, (_tag, attributes: string) => {
    const next = /\blang\s*=/i.test(attributes)
      ? attributes.replace(/\blang\s*=\s*(['"])[^'"]*\1/i, `lang="${locale}"`)
      : `${attributes} lang="${locale}"`
    return `<html${next}>`
  })
  return /<\/head>/i.test(localized)
    ? localized.replace(/<\/head>/i, `${meta}</head>`)
    : meta + localized
}

/**
 * Готовая страница: байты, сильный ETag и обе кодировки.
 *
 * Раньше каждая навигация — а это КАЖДЫЙ вход в комнату — читала index.html с
 * диска, склеивала в него язык, считала по нему ETag и уходила в потоковый
 * brotli качества 5. На собранном index.html в 26 КБ это 1.74 мс
 * процессорного времени на запрос, и почти всё оно — сжатие одного и того же
 * файла заново. Двести человек по звонку — двести таких пересжатий подряд, на
 * той же машине, где в этот момент поднимаются ядра комнат.
 *
 * Между двумя запросами файл меняет только выкладка, а язык инстанса — только
 * админ. Значит вариантов ровно два на язык, и считаются они по разу: brotli
 * здесь качества 11 (офлайн-настройка, за неё платят единожды), gzip девятого
 * уровня. Дальше ответ — это копия буфера в сокет.
 *
 * Ключ — mtime и размер файла, а не его содержимое: хэшировать значило бы
 * читать файл на каждый запрос, то есть ровно то, от чего уходим. Выкладка
 * меняет и то, и другое, а stat стоит микросекунды.
 */
export interface FrontendPage {
  readonly body: Buffer
  readonly etag: string
  readonly encoded: Readonly<Partial<Record<Encoding, Buffer>>>
}

const pages = new Map<string, { stamp: string; page: Promise<FrontendPage> }>()
/*
 * Потолок кэша. Вариантов страницы стало не два на язык, а по одному на
 * комнату (заголовок и карточка ссылки — свои у каждой), и без потолка
 * инстанс с тысячей семинаров за семестр держал бы тысячу сжатых копий
 * одного файла. Вытесняется самая давняя; на курсе в десяток текущих комнат
 * до вытеснения дело не доходит.
 */
const MAX_PAGES = 256
let builds = 0

/** Сколько раз страницу действительно собирали: этим тест и ловит пересжатие. */
export function frontendPageBuilds(): number {
  return builds
}

export async function frontendPage(
  file: string,
  language: Locale,
  extras: PageExtras = {},
): Promise<FrontendPage> {
  const locale = normalizeLocale(language)
  const info = await stat(file)
  const stamp = `${info.mtimeMs}:${info.size}`
  const key = `${file} ${locale} ${extras.title ?? ''}\u0000${extras.head ?? ''}`
  const known = pages.get(key)
  if (known && known.stamp === stamp) return known.page
  const page = buildPage(file, locale, extras)
  if (pages.size >= MAX_PAGES) {
    const oldest = pages.keys().next().value
    if (oldest !== undefined) pages.delete(oldest)
  }
  pages.set(key, { stamp, page })
  // Отказ чтения не должен запомниться навсегда: следующий запрос спросит снова.
  page.catch(() => {
    if (pages.get(key)?.page === page) pages.delete(key)
  })
  return page
}

async function buildPage(file: string, locale: Locale, extras: PageExtras): Promise<FrontendPage> {
  const body = Buffer.from(withInitialLanguage(await readFile(file, 'utf8'), locale, extras), 'utf8')
  const [br, gzip] = await Promise.all([
    brotliCompress(body, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    }),
    gzipCompress(body, { level: 9 }),
  ])
  const encoded: Partial<Record<Encoding, Buffer>> = {}
  if (br.length < body.length) encoded.br = br
  if (gzip.length < body.length) encoded.gzip = gzip
  builds += 1
  // Сильный тег, а не слабый: байты этого ответа лежат здесь целиком, и
  // «примерно те же» тут не бывает. Express ставил слабый (W/...), потому что
  // считал его на лету и не знал, что отдаст.
  const etag = `"${body.length.toString(16)}-${createHash('sha1').update(body).digest('base64url')}"`
  return { body, etag, encoded }
}

/** Держит ли браузер уже эти самые байты (If-None-Match). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  for (const part of header.split(',')) {
    // Слабый префикс снимается: для 304 хватает слабого сравнения, а прокси по
    // дороге вправе ослабить сильный тег.
    const tag = part.trim().replace(/^W\//, '')
    if (tag === '*' || tag === etag) return true
  }
  return false
}
