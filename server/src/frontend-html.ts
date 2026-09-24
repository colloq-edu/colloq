import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { normalizeLocale, type Locale } from '@shared/i18n'
import type { Encoding } from './http-encoding.js'

const brotliCompress = promisify(zlib.brotliCompress)
const gzipCompress = promisify(zlib.gzip)

/**
 * What in the page depends on the address: the tab title and the link card
 * tags.
 *
 * The built index.html is the same for every address, but a messenger that
 * unfurls a link to a room needs the class name, and only the server knows it
 * (link-preview.ts). `head` is inserted before `</head>` as is: escaping is
 * the job of whoever built it.
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
   * The link card goes at the very start of head, right after the charset:
   * the built page has twelve kilobytes of styles and scripts before
   * `</head>`, and how much a chat's link unfurler reads is written nowhere.
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
 * A ready page: the bytes, a strong ETag and both encodings.
 *
 * Previously every navigation (and that is EVERY entry into a room) read
 * index.html from disk, spliced the language into it, computed an ETag over it
 * and went into streaming brotli at quality 5. On the built 26 KB index.html
 * that is 1.74 ms of CPU time per request, and almost all of it is compressing
 * the same file over again. Two hundred people at the bell means two hundred
 * such recompressions in a row, on the same machine where the rooms' kernels
 * are starting up at that moment.
 *
 * Between two requests the file is changed only by a deploy, and the instance
 * language only by an admin. So there are exactly two variants per language,
 * and each is computed once: brotli here runs at quality 11 (an offline
 * setting, paid for once), gzip at level nine. After that a response is a
 * copy of a buffer into the socket.
 *
 * The key is the file's mtime and size, not its content: hashing would mean
 * reading the file on every request, which is exactly what we are getting away
 * from. A deploy changes both, and stat costs microseconds.
 */
export interface FrontendPage {
  readonly body: Buffer
  readonly etag: string
  readonly encoded: Readonly<Partial<Record<Encoding, Buffer>>>
}

const pages = new Map<string, { stamp: string; page: Promise<FrontendPage> }>()
/*
 * The cache ceiling. Page variants are no longer two per language but one per
 * room (each has its own title and link card), and without a ceiling an
 * instance with a thousand seminars a semester would hold a thousand
 * compressed copies of one file. The oldest one is evicted; a course with a
 * dozen current rooms never gets as far as eviction.
 */
const MAX_PAGES = 256
let builds = 0

/** Times the page was actually built: the test catches recompression by it. */
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
  // A failed read must not be remembered forever: the next request asks again.
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
  // A strong tag, not a weak one: the bytes of this response are all here, and
  // "roughly the same" does not happen here. Express set a weak one (W/...)
  // because it computed it on the fly and did not know what it would send.
  const etag = `"${body.length.toString(16)}-${createHash('sha1').update(body).digest('base64url')}"`
  return { body, etag, encoded }
}

/** Whether the browser already holds these very bytes (If-None-Match). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  for (const part of header.split(',')) {
    // The weak prefix is stripped: weak comparison is enough for a 304, and a
    // proxy along the way is allowed to weaken a strong tag.
    const tag = part.trim().replace(/^W\//, '')
    if (tag === '*' || tag === etag) return true
  }
  return false
}
