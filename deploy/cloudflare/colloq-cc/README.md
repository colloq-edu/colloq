# colloq.cc — a mirror of colloq.ru

`colloq.cc` serves the exact same site as `colloq.ru`: the landing page, the
documentation under `/docs/`, and the published courses under `/c/`. There is
one source of truth — `site/` in this repository, deployed to GitHub Pages by
`.github/workflows/pages.yml` — and this directory only adds a second front
door to it, for the audience that reaches Cloudflare comfortably.

It is a single Cloudflare Worker that reverse-proxies `colloq.cc/*` and
`www.colloq.cc/*` to `https://colloq.ru`, plus the two DNS records and two
routes that put it in front of the domain.

| file            | what it is                                                     |
| --------------- | -------------------------------------------------------------- |
| `worker.js`     | the proxy itself: module syntax, no dependencies                 |
| `wrangler.toml` | name, compatibility date and routes — the single source of truth |
| `deploy.sh`     | deploys all of it with plain `curl`, idempotently                |

## Why a Worker and not a second domain on Pages

**GitHub Pages serves one custom domain per site.** `site/CNAME` says
`colloq.ru`, and Pages dispatches on the `Host` header: a request that arrives
as `Host: colloq.cc` is answered with *"There isn't a GitHub Pages site here"*.
A plain `CNAME colloq.cc -> sleep3r.github.io` therefore cannot work, proxied
or not. Something has to rewrite `Host` to `colloq.ru` on the way to the
origin, and that is the Worker's entire job.

**And `colloq.ru` cannot simply move to Cloudflare.** Cloudflare's edge
addresses do not open from Russia — that is why every record in the `colloq.ru`
zone is deliberately grey-clouded and points straight at GitHub Pages (see the
header of `scripts/dns.sh`). `colloq.ru` has to stay exactly as it is.
`colloq.cc` is the name for everyone else, and it lives orange-clouded.

Nothing dynamic goes through this. Class rooms are not on `colloq.ru`: they run
on teachers' own machines and on `*.colloq.ru` names through the relay. What
the mirror carries is static files only, so no cookies are involved in either
direction.

### Alternatives that were considered

- **A Cloudflare Origin Rule with a Host header override**, i.e. no code at
  all. It would get the `Host` right, but nothing else: the mirror would still
  need a way to rewrite `Location` on redirects (Pages answers `/docs` with a
  literal `https://colloq.ru/docs/`, which would bounce visitors off the
  mirror on their first click), and refusing non-GET methods and setting
  per-asset cache lifetimes would each become another rule to keep in sync.
- **A second Pages project / Cloudflare Pages deployment of `site/`.** That is
  a second build and a second thing to forget to deploy. The Worker keeps one
  origin and one deploy pipeline.
- **Workers Custom Domains** instead of routes + placeholder DNS. Fewer API
  calls, but Cloudflare then owns the DNS entries for the apex, which is harder
  to reason about and to undo than a record you can see in the dashboard.

## What the Worker does, and deliberately does not do

- Passes `GET` and `HEAD` through; answers anything else with `405` and an
  `Allow: GET, HEAD` header. The site is static.
- Preserves path and query exactly, and streams the origin's response back
  with its status untouched — 404s and 5xx included.
- Redirects `www.colloq.cc` to the apex, keeping path and query.
- Rewrites `Location` on redirects from `colloq.ru` to `colloq.cc`, so
  navigation stays on the mirror. A `Location` pointing anywhere else (say
  GitHub) is left alone.
- **Rewrites the domain where the page prints it as visible text**, and
  nothing else in the body — see *The visible domain* below.
- **Serves English link previews**, and only on the landing page — see *Link
  previews* below. `og:`/`twitter:` tags are the only part of `<head>` the
  Worker touches.
- **Leaves the rest of `<head>` alone.** `<title>`, `<meta name="description">`,
  `<link rel="canonical">` and `hreflang` in `site/` all name `colloq.ru` and
  describe the page the origin actually serves; they must keep doing that,
  because search engines should see one canonical site, not two competing
  copies.
- **Leaves `href` alone.** In-site navigation is root-relative, and the
  absolute links (GitHub, PyPI, the author's `mailto:`) are absolute on
  purpose.
- Drops `Cookie` on the way out and `Set-Cookie` on the way back.
- Sends HSTS on every response, including the `405` and the `www` redirect.
- Adds `X-Colloq-Mirror: colloq.ru`, so one `curl -I` answers "is this the
  mirror, or has someone taken over the name?".
- Caches at the edge and in the browser by how much it hurts to be stale:
  a day for fonts and images, an hour for CSS and JS, five minutes for pages.
  Filenames in `site/` carry no content hash — `styles.css` stays
  `styles.css` across deploys — so a long lifetime on code would mean people
  looking at old CSS over new markup. Origin errors are never cached.

## The visible domain

A couple of places print the domain as text rather than linking it: the footer
of the landing page (`<span class="host">colloq.ru</span>`) and the address on
a published course page (`<p class="addr">colloq.ru/c/ml-strong</p>`, produced
by `server/src/publish/render.ts`). People read those and retype them into the
address bar, so on the mirror they have to say `colloq.cc`.

`HTMLRewriter` handles it, on `text/html` responses only, for a closed
allowlist of two selectors:

```
body .host, body .addr
```

The `body` prefix is a structural guarantee rather than decoration — the
replacement cannot reach `<head>` even by accident, so canonical, `og:url` and
`hreflang` stay `colloq.ru` without anyone having to remember that during the
next edit. Attributes are never visited, only text nodes, so `href` and
`mailto:` are untouched.

**Why the allowlist stays this short.** The obvious next candidate is `<code>`,
and it would break the documentation: `site/docs/networking.html` explains that
without `DOMAIN` the script configures the relay for *"the project's own
`colloq.ru` zone, which you do not own"*. That sentence is about a real DNS
zone, not about the address of the page you are reading, and rewriting it would
turn it into a falsehood. `language.html` and `students.html` mention the
domain the same prose way. The two allowlisted classes mean one specific thing
— *the address you are currently at* — and that is the whole rule.

The replacement matches the domain as a whole name, not as a substring:
`hse.colloq.ru` is left alone (relay hostnames live in the `colloq.ru` zone and
do not exist under `.cc`), and so is `colloq.ruby`. It lives in `worker.js` as
the exported pure function `rewriteVisibleDomain`, because those boundaries are
exactly what cannot be inspected on a running Worker.

Text arrives from `HTMLRewriter` in chunks that can split `colloq.ru` down the
middle, so the handler buffers until `lastInTextNode` and replaces once.
Because the body is reassembled, `Content-Length` and `Content-Encoding` are
dropped from rewritten HTML responses; Cloudflare re-compresses at the edge.
Non-HTML responses never enter the rewriter and keep their headers and bytes
exactly as the origin sent them.

The net effect, measured against the live origin: every mirrored page except
the landing differs from `colloq.ru` by exactly one line, and the course page
by exactly one line. The landing also carries the preview tags below.

## Link previews

**The problem.** Telegram, WhatsApp, Slack, iMessage, X, Discord and Facebook
all expand a pasted link by fetching it and reading `og:`/`twitter:` meta tags.
None of them runs JavaScript — and the landing page picks its language with a
script in `<head>`. So a preview bot always got the Russian page, including on
`colloq.cc`, which exists precisely for the audience that does not read
Russian. The one preview image, `site/img/og.png`, was Russian too, and it is
labelled `colloq.ru` in the bottom-left corner.

**What the Worker does.** On the landing root (`/` and `/index.html`) it
replaces the content of every `meta[property^="og:"]` and
`meta[name^="twitter:"]` with the value of the same tag from the page's English
twin. The twin is not hard-coded: it is read from the page's own
`<link rel="alternate" hreflang="en" href="…">`, fetched from the origin, and
cached at the edge for the same five minutes as any page. If the link is
missing, points somewhere other than `colloq.ru`, or the fetch or the parse
fails, **the page is served unchanged** — a page without a preview is still the
page, while half-swapped tags look like they work.

Only the landing root, and that is the point: `/docs/` and the published
courses have no language auto-redirect, so an English preview there would
promise an English page and deliver a Russian one.

`<title>`, `<meta name="description">`, `<link rel="canonical">` and `hreflang`
are never touched. Humans and search engines keep seeing the truth about the
document the origin actually served; the preview tags are for the bots, which
never render the page at all.

**The image.** `scripts/site-og.mts` (`make site-og`) draws three 1200×630
cards from one layout: `og.png` (Russian, labelled `colloq.ru`), `og-en.png`
(English, `colloq.ru`) and `og-cc.png` (English, `colloq.cc`). On the mirror,
any `og:image`/`twitter:image` whose path is `/img/og-en.png` becomes
`https://colloq.cc/img/og-cc.png`, keeping the `?v=` marker — one script draws
both pictures in one commit, so the English marker changes exactly when the
mirror picture does. The rewrite is deliberately conditional on the tag already
pointing at `og-en.png`: before the images ship, the twin still names the old
`og.png` and the mirror shows that, instead of a 404 on a file the origin does
not have yet. This applies to `/en/` as well, which otherwise keeps its own
tags — it is already English.

**`og:url` names the mirror.** This is the one tag a scraper follows:
Facebook, LinkedIn and everything built on their scheme treat `og:url` as the
canonical address and re-scrape *it*. Left as `https://colloq.ru/`, it would
send the bot straight back to the origin, and someone who shared `colloq.cc`
would get the Russian card with the wrong domain under it. So on the mirror
`og:url` is the mirror's own URL of the page being served —
`https://colloq.cc/` for the root, `https://colloq.cc/en/` for the English
page. Re-scraping either one yields exactly the same tags, which is what makes
the preview stable rather than different on the second look. Canonicalisation
for search engines is unaffected: that is `<link rel="canonical">`, and it
still says `colloq.ru`.

**Refreshing a cached preview.** Messengers cache a card for days, and they key
it on the URL, not on the image. After changing tags or pictures:

- **Telegram** — send `https://colloq.cc/` to [@WebpageBot](https://t.me/WebpageBot)
  and it re-fetches the page.
- **Facebook / WhatsApp** — the Sharing Debugger,
  <https://developers.facebook.com/tools/debug/>, *Scrape Again*.
- **LinkedIn** — the Post Inspector, <https://www.linkedin.com/post-inspector/>.
- **Slack, Discord, iMessage** — no manual flush; the `?v=` marker on the image
  and a fresh `og:url` are what eventually move them.

## Deploying

From the repository root:

```sh
make mirror DRY=1   # say what would change, touch nothing
make mirror         # upload the worker, ensure the routes and the DNS records
```

or directly: `deploy/cloudflare/colloq-cc/deploy.sh [--dry-run|--down]`.

The script is idempotent — matching things are left alone, stale things are
removed, missing things are created — so running it twice is how you confirm
that the first run finished. It reads `name`, `main`, `compatibility_date` and
the routes out of `wrangler.toml`, so that file stays the single source of
truth even though `wrangler` itself is never invoked: `npx wrangler` pulls
several dozen packages over the network and wants its own login, and a mirror
usually gets repaired precisely when the network is already unhappy.

It picks the account from the zone, not from `CF_ACCOUNT_ID` in `.env` — the
Worker must live in the account that owns `colloq.cc`, and `CF_ACCOUNT_ID` was
put there for `colloq.ru`.

`wrangler.toml` is still valid for `npx wrangler deploy` if you ever want it;
it will produce the same routes.

### The token

`deploy.sh` reads, in order: `$CF_TOKEN_CC`, `CF_TOKEN_CC` in `.env`,
`$CF_TOKEN`, `CF_TOKEN` in `.env` — through the same `read_env` that
`scripts/dns.sh` uses. Put a dedicated token in `CF_TOKEN_CC` if you would
rather not widen the one that manages the `colloq.ru` zone.

The token never reaches any process's `argv`: `curl` reads the `Authorization`
header from a config file on stdin, written by a shell builtin, so it does not
show up in `ps` or in CI logs.

Permissions needed, all for the **colloq.cc** zone and the account that owns it:

| scope   | permission      | level | what needs it                   |
| ------- | --------------- | ----- | ------------------------------- |
| Account | Workers Scripts | Edit  | uploading `worker.js`           |
| Zone    | Workers Routes  | Edit  | the two `colloq.cc/*` routes    |
| Zone    | DNS             | Edit  | the placeholder records         |
| Zone    | Zone            | Read  | finding the zone and its account |

To widen or create one: Cloudflare dashboard → profile menu → **API Tokens** →
*Create Token* → *Create Custom Token*, add the four rows above, and under
*Zone Resources* include `colloq.cc`. If you extend the existing token instead,
nothing needs to change in `.env`.

If the zone is not visible to the token, `deploy.sh` says so and stops rather
than guessing.

### Why the DNS record looks strange

The apex and `www` get a **proxied `AAAA` pointing at `100::`**. A Worker route
only fires if the name resolves *and* goes through Cloudflare, so the record
exists to make the name orange — the address itself is never dialled. `100::`
is the discard prefix from RFC 6666: if the route is ever removed, requests
fail immediately instead of quietly landing on somebody else's server. `AAAA`
does not exclude IPv4-only visitors, because a proxied name is published as
Cloudflare's own A *and* AAAA records; what sits behind the cloud is only ever
seen by Cloudflare.

`deploy.sh` only ever touches `A`, `AAAA` and `CNAME` on those two names. `MX`,
`TXT` and anything else in the zone — email, verification records — are left
alone.

## Verifying

```sh
curl -sI https://colloq.cc/          | grep -iE 'HTTP|x-colloq-mirror|cache-control'
curl -sI https://colloq.cc/docs      | grep -i location   # -> https://colloq.cc/docs/
curl -sI https://www.colloq.cc/      | grep -i location   # -> https://colloq.cc/
curl -sI https://colloq.cc/fonts/hse-sans-400.woff2 | grep -i 'HTTP\|cache-control'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://colloq.cc/    # -> 405
curl -s https://colloq.cc/ | grep canonical                # -> still colloq.ru
curl -s https://colloq.cc/ | grep 'class="host"'           # -> colloq.cc
curl -s https://colloq.cc/c/ml-strong/ | grep 'class="addr"'  # -> colloq.cc/c/...
```

The previews, as a bot sees them — English on the mirror, Russian on the
origin, and the same tags twice in a row:

```sh
curl -s -A 'TelegramBot (like TwitterBot)' https://colloq.cc/   | grep -i 'og:\|twitter:'
curl -s -A 'TelegramBot (like TwitterBot)' https://colloq.ru/   | grep -i 'og:\|twitter:'
curl -s -A 'facebookexternalhit/1.1'       https://colloq.cc/en/ | grep -i 'og:image\|og:url'
curl -sI https://colloq.cc/img/og-cc.png | head -1              # -> 200
```

The sharpest check for the rest is a diff against the origin — one line per
page, and nothing else besides the landing's preview tags:

```sh
curl -s --compressed https://colloq.ru/docs/ -o /tmp/a && curl -s --compressed https://colloq.cc/docs/ -o /tmp/b
diff /tmp/a /tmp/b
```

Give the edge a minute after the first deploy. If your resolver cached the
name while it did not exist yet, `curl` will keep saying *could not resolve*
long after `dig colloq.cc` answers; pin it to verify in the meantime:

```sh
curl -sI --resolve colloq.cc:443:"$(dig +short colloq.cc A | head -1)" https://colloq.cc/
```

The logic in `worker.js` is covered by `tests/cloudflare-mirror.test.mts`,
which drives it against a mocked origin — run it with `npm test`.

## Taking it down

```sh
deploy/cloudflare/colloq-cc/deploy.sh --down          # or --down --dry-run first
```

That removes the two routes, the two placeholder records and the Worker
itself, in that order, leaving `colloq.cc` resolving to nothing. `colloq.ru` is
not touched by any of it — it never went through Cloudflare's proxy in the
first place, and that is the point.
