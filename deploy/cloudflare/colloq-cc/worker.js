// The colloq.ru mirror on colloq.cc.
//
// Why there is code here at all rather than a second DNS record. GitHub Pages
// serves a site under ONE name of its own: site/CNAME says colloq.ru, and a
// request with the header `Host: colloq.cc` is met by Pages with its own
// "There isn't a GitHub Pages site here" page. A CNAME to colloq-edu.github.io,
// grey or orange, gives exactly that, because Pages goes by the Host. So
// between the visitor and Pages there has to be someone who swaps the Host for
// colloq.ru; that is what the worker does, and that is all of its job.
//
// Why we cannot move to colloq.cc entirely. Cloudflare edge addresses do not
// open from Russia (see the header of scripts/dns.sh and its whole "grey cloud
// everywhere" rule), so colloq.ru must stay grey and point straight at Pages.
// colloq.cc is the name for those who can reach Cloudflare, and it lives
// orange. Two names, one source: site/ in this repository.
//
// EXACTLY ONE thing in the page body is edited: the domain printed on it as
// text (the caption in the footer, the course address); see
// VISIBLE_DOMAIN_SELECTOR below. People read it with their eyes and retype it
// into the address bar, and on the mirror it must name the mirror.
//
// Everything else in the body stays as is, and that is a decision, not
// laziness. href attributes are not touched at all: links are either
// root-relative or absolute on purpose (GitHub, PyPI, the author's email).
//
// In <head> the preview tags are edited, og: and twitter:, and only on the
// landing page; see "link preview" below. <title>, <meta name=description>,
// <link rel=canonical> and hreflang are never touched: a search engine is
// supposed to see ONE canonical site, not two identical copies competing with
// each other.
//
// The only exception is Location on redirects. Pages answers /docs (without a
// trailing slash) with literally `location: https://colloq.ru/docs/`, and
// without the edit a visitor who asked for /docs on the mirror would be sent
// to colloq.ru, that is, to the very place they were sent here from.
//
// There are no class rooms here: they live on the teachers' machines and under
// *.colloq.ru names through the relay, while colloq.ru itself holds only static
// files: the landing page, /docs/ and the published courses /c/. There is no
// dynamic content to proxy, so cookies play no part here at all, in either
// direction.

const ORIGIN = 'colloq.ru'
const MIRROR = 'colloq.cc'

// How long a response lives in the browser and at the Cloudflare edge.
//
// The numbers differ, and they are split apart for one reason: file names in
// site/ do NOT contain a content fingerprint. styles.css stays styles.css
// after a deploy, so a long lifetime on it means not "fast" but "for a day a
// person sees the old styles on top of the new markup".
//
//   media — fonts and pictures. They change together with the design, that
//           is, almost never, and a stale picture is cosmetics, not breakage.
//   code  — css and js. They change with every deploy and break visibly if
//           they drift from the markup: an hour is the ceiling of the drift.
//   page  — html and everything else. Pages itself says max-age=600 about
//           itself; five minutes on the mirror do not make it fresher than
//           the origin.
const TTL = { media: 86400, code: 3600, page: 300 }

const MEDIA = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|webp|avif|gif|svg|ico)$/i
const CODE = /\.(?:css|m?js|map)$/i

// Headers that do not reach Pages.
//
// host — the whole thing was started for its sake: the request URL sets the
//   host itself, and colloq.cc arriving in the header would bring us back to
//   "there is no site here".
// cookie — the mirror has not a single cookie of its own, and there is no
//   reason to carry other people's cookies to Pages (the .cc top-level domain
//   is shared with anyone).
// x-forwarded-* — the client makes them up, and Pages must not take what is
//   made up for the truth about itself.
const DROP_FROM_REQUEST = ['host', 'cookie', 'x-forwarded-host', 'x-forwarded-proto']

// Statuses that never have a body. The Response constructor with a body at
// such a status throws, both in Workers and in node.
const NULL_BODY = new Set([101, 204, 205, 304])

/** How many seconds to keep the response for this path. */
function ttlFor(pathname) {
  if (MEDIA.test(pathname)) return TTL.media
  if (CODE.test(pathname)) return TTL.code
  return TTL.page
}

/**
 * The address from Location, moved to the mirror if it pointed at the origin.
 *
 * Returns null when there is nothing to touch: then Location goes out as it
 * came. Foreign addresses (say, a redirect to github.com) must not be
 * rewritten: that would take the visitor to a nonexistent page on the mirror.
 */
function toMirror(location) {
  let target
  try {
    // The base is needed: Location from Pages can also be relative ("/docs/"),
    // and without a base there is no way to answer "whose address is this".
    target = new URL(location, `https://${ORIGIN}/`)
  } catch {
    return null
  }
  if (target.hostname !== ORIGIN && target.hostname !== `www.${ORIGIN}`) return null
  target.hostname = MIRROR
  return target.toString()
}

// -------------------------------------------------- visible name on the page
//
// There are places in the markup where the domain is PRINTED as text rather
// than being a link: the caption in the landing page footer
// (`<span class="host">colloq.ru</span>`) and the course address on its page
// (`<p class="addr">colloq.ru/c/ml-strong</p>`, built by
// server/src/publish/render.ts). People read them with their eyes and retype
// them into the address bar, so on the mirror they must name the mirror.
//
// The list of classes is closed and short, and that matters more than it
// seems. The temptation to add <code> here breaks the documentation:
// site/docs/networking.html says the script sets up the relay "on the colloq.ru
// project zone, which does not belong to you", a statement about the real DNS
// zone, not about the address of the open page, and the swap would turn it into
// a falsehood. The same goes for language.html and students.html. So exactly
// two classes are edited, and both mean one thing: "the address you are at
// right now".
//
// `body` in front is a structural guarantee, not decoration. <head> holds
// canonical, og:url and hreflang, which are supposed to keep naming colloq.ru;
// with such a selector the replacement simply cannot reach there, and nobody
// has to remember that during the next edit.
export const VISIBLE_DOMAIN_SELECTOR = 'body .host, body .addr'

// The whole name, not a substring: all the subtlety here is in the boundaries.
//
//   colloq.ru        -> colloq.cc      the caption in the footer
//   colloq.ru/c/x    -> colloq.cc/c/x  a course address (a slash on the right is fine)
//   hse.colloq.ru       stays          seminar names are handed out by the relay
//                                      in the colloq.ru zone, and .cc has none
//   colloq.ruby         stays          that is not our domain
//
// So on the left there must be neither a dot nor a letter (otherwise it is a
// subdomain or someone else's word), and on the right neither a letter nor a
// hyphen (otherwise it is another zone).
const VISIBLE_DOMAIN = new RegExp(`(?<![\\w.-])${ORIGIN.replace(/\./g, '\\.')}(?![\\w-])`, 'g')

/**
 * Swap the domain in visible text. A pure function, and it is what the test
 * checks: on a live worker the boundaries of the name cannot be made out.
 */
export function rewriteVisibleDomain(text) {
  return text.replace(VISIBLE_DOMAIN, MIRROR)
}

/**
 * Accumulator of one node's text.
 *
 * HTMLRewriter hands out text in CHUNKS, and a chunk boundary can fall
 * anywhere, including the middle of "colloq.ru". A chunk-by-chunk replacement
 * would silently miss such a name, so the text is accumulated until
 * lastInTextNode and replaced as a whole. The intermediate chunks are removed
 * meanwhile: otherwise they would reach the reader twice, on their own and
 * once more in the accumulated string.
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
    // It arrived in one chunk and there is nothing to change: leave it alone
    // entirely: where there is nothing to swap, the page must arrive byte for
    // byte. The same goes for `<a class="host" href="mailto:…">` in the
    // footer: there is no domain in its text, and it stays itself.
    if (this.split || replaced !== this.buffer) chunk.replace(replaced, { html: false })
    this.buffer = ''
    this.split = false
  }
}

// -------------------------------------------------------------- link preview
//
// Link unfurlers (Telegram, WhatsApp, Slack, iMessage, X, Discord, Facebook)
// do not run JS. The automatic language choice on the landing page is done by
// a script in <head>, and it never reaches the bot at all: the bot fetches
// `/`, reads og: and twitter: and shows the RUSSIAN card, including to someone
// who was given colloq.cc, the name meant precisely for those without Russian.
//
// So on the mirror the landing root serves the preview tags of its English
// twin. The twin is found not by a hard-coded address but by the page itself:
// its <head> has <link rel="alternate" hreflang="en" href="…">, and that is
// exactly the place where the answer to "where is the English version" lives.
// If it moves, the preview moves too.
//
// Only the LANDING page: the root gets the twin's tags, the English page its
// own, since it only needs its own picture and its own address. /docs/ and the
// course pages have no automatic language choice, and an English preview there
// would lead to a Russian page, that is, it would lie; their head is not
// touched by a single tag.
//
// The content of the tags changes, not the markup around them: <title> and
// description stay Russian: a search engine reads them, and it is owed the
// truth about the page it is downloading right now.
//
// og:url is the only tag an unfurler may RE-READ: Facebook and everything
// built on its scheme considers the address from og:url canonical and goes
// for the tags there. Left as colloq.ru, it would take the bot back to the
// origin, and a person who sent colloq.cc would get a Russian card with a
// different domain in the caption. So on the mirror og:url names the mirror,
// and the SAME address that was opened: having re-read it, the bot gets
// exactly these same tags, and the picture does not "move" on the second
// pass. The canonical address stays with colloq.ru meanwhile: it is in
// <link rel=canonical>, and that is exactly the signal by which a search
// engine merges copies.
const LANDING_ROOT = new Set(['/', '/index.html'])
const ENGLISH_LANDING = new Set(['/en/', '/en/index.html'])
const PREVIEW_SELECTOR = 'head meta[property^="og:"], head meta[name^="twitter:"]'

// The preview picture: the English one lies on the origin, the mirror one is
// its own, captioned colloq.cc. Both are drawn by scripts/site-og.mts.
const IMAGE_ORIGIN = '/img/og-en.png'
const IMAGE_MIRROR = '/img/og-cc.png'

/**
 * The address of the English twin, from <link rel="alternate" hreflang="en">.
 *
 * null when there is no link: then there is nothing to swap and the page goes
 * out as is. The order of attributes does not matter: people write them in
 * different orders.
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
 * The preview tags of a page: key (og:title, twitter:card) → content.
 *
 * Only <head> is read: og tags in the body are someone else's quote or an
 * example in the documentation, and they have no business here.
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
 * The preview picture on the mirror, or null if there is nothing to change.
 *
 * EXACTLY the English picture of the origin is swapped: until the owner has
 * published og-en.png, the twin's tags point at the old og.png, the condition
 * does not fire, and the mirror shows the same as the origin. That way the
 * worker can be deployed before the pictures without getting a 404 in the
 * preview.
 *
 * The ?v= mark is carried over as is. It must CHANGE together with the
 * picture, and both are drawn by one script in one commit, so the mark of the
 * English one is good for the mirror one too, and no extra request to the
 * origin is needed for it.
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
 * Swap the content of one preview tag. A pure function, and the whole fork is
 * checked on it: what is taken from the twin, what from the page itself, what
 * from the mirror.
 *
 * `tags` are the tags of the English twin, or null when the page is already
 * English. `ogUrl` is the address of this same page on the mirror.
 */
export function previewContent(key, own, tags, ogUrl) {
  if (key === 'og:url') return ogUrl
  const value = tags && tags.has(key) ? tags.get(key) : own
  if (value === null || value === undefined) return null
  return mirrorPreviewImage(value) ?? value
}

/** An HTMLRewriter handler on top of previewContent. */
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
 * Fetch the preview tags from the English twin of this page.
 *
 * null on any misfire: no link, the wrong host, the origin did not answer, no
 * tags found. Then the page is served untouched: a preview in the wrong
 * language is a problem, while a page without a preview is the same page.
 */
async function twinTags(html) {
  try {
    const href = twinHref(html)
    if (!href) return null
    const target = new URL(href, `https://${ORIGIN}/`)
    // Only the origin: hreflang in foreign markup must not turn into a worker
    // request to anywhere, nor a link to the mirror itself into a loop.
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
 * HSTS on EVERY response, including the 405 and the redirect from www.
 *
 * A header that comes only with pages does not protect the first visit to
 * http://colloq.cc/anything: that is exactly the one request someone manages
 * to read on the way.
 */
function guarded(response) {
  response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
  return response
}

export default {
  async fetch(request) {
    const url = new URL(request.url)

    // Read-only. The site is static: a POST or anything else on the mirror is
    // either a mistake or someone's scanner looking for an admin panel. There
    // is no point forwarding such a thing to Pages, let alone answering for it.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return guarded(
        new Response('Method Not Allowed\n', {
          status: 405,
          headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
        }),
      )
    }

    // www → apex. The mirror has one canonical name, and there are two
    // reasons for that: otherwise Cloudflare keeps two copies of every page in
    // its cache, and a search engine sees yet a THIRD address of the same
    // site, while the whole idea is exactly the opposite. The redirect is
    // built by hand, not with Response.redirect: its headers are immutable,
    // and HSTS cannot be put on it.
    if (url.hostname === `www.${MIRROR}`) {
      const apex = new URL(url)
      apex.hostname = MIRROR
      return guarded(new Response(null, { status: 301, headers: { location: apex.toString() } }))
    }

    // The path and the query are carried over as is, by copying the URL, not
    // by building a string: that way nothing is lost or re-encoded on the way.
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
      // Redirects are handled by hand. Otherwise the Location from Pages would
      // be followed inside the worker, the visitor would get the finished page
      // at an address they did not ask for, and /docs would stay in the
      // address bar forever without the trailing slash, with every relative
      // link on such a page shifted one level up.
      redirect: 'manual',
      // The edge cache. colloq.ru is a zone of the same account, so the cf
      // settings for the subrequest apply. 5xx responses are not cached at
      // all: a minute of Pages being down must not turn into an hour of the
      // mirror being down.
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { '200-299': ttl, '301-302': ttl, '404': 60, '500-599': 0 },
      },
    })

    const out = new Headers(response.headers)
    // Cookies play no part on the mirror, in either direction.
    out.delete('set-cookie')

    const location = response.headers.get('location')
    if (location) {
      const fixed = toMirror(location)
      if (fixed) out.set('location', fixed)
    }

    if (response.status >= 500) {
      // An origin error must not be cached: Pages was down for a minute, and
      // the mirror would keep serving its 5xx to the visitor for five more.
      out.set('cache-control', 'no-store')
    } else if (response.status !== 304) {
      out.set('cache-control', `public, max-age=${ttl}`)
    }

    // So that `curl -sI https://colloq.cc/` answers in one line the question
    // "is this the mirror, or has my DNS been spoofed".
    out.set('x-colloq-mirror', ORIGIN)

    let body = NULL_BODY.has(response.status) ? null : response.body
    // Markup goes through the visible-domain replacement; everything else
    // (fonts, pictures, css, json) is not rebuilt at all and flows straight
    // through.
    const html = (out.get('content-type') || '').toLowerCase().startsWith('text/html')

    // The preview tags are edited on the landing page and only there; the
    // root also needs the English twin, and to find it the page has to be
    // read in full. It is one page for the whole site, and giving up the
    // stream for it is fine: everything else still flows straight through.
    const preview = body && html && response.status === 200
    const root = preview && LANDING_ROOT.has(url.pathname)
    let tags = null
    if (root) {
      body = await response.text()
      tags = await twinTags(body)
    }

    if (body && html) {
      // After the rebuild the headers about SIZE and ENCODING no longer
      // describe the body that arrived: HTMLRewriter emits it anew, as a
      // stream. Even when the length matches by chance (colloq.ru and
      // colloq.cc are both nine bytes), they must not be kept: the next edit
      // of the class list will break that coincidence, and it will look like
      // a truncated page. Compression at the edge is Cloudflare's job, and it
      // does not need these headers.
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
    // The root only when the twin was found: a half-swapped head (Russian
    // tags with the mirror address in og:url) is worse than an untouched one,
    // because it looks like it works. The English page does not need the twin
    // at all: it is the twin, and it only needs its own picture and its own
    // address.
    if ((root && tags) || (preview && ENGLISH_LANDING.has(url.pathname))) {
      rewriter.on(PREVIEW_SELECTOR, new Preview(tags, `https://${MIRROR}${url.pathname}`))
    }
    return rewriter.transform(answer)
  },
}
