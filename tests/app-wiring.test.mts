/**
 * The app assembly: what there used to be nothing to check with.
 *
 * The middleware order lived in index.ts mixed with sockets and `listen`, so
 * tests built their own express and COPIED the order into it ("the same
 * order as in index.ts", said the comment above the copy). A copy of the
 * order does not catch divergences from the original, it repeats them: move
 * `sameOrigin` in index.ts relative to the routers, and the unit tests stay
 * green. The app has been moved out to server/src/app.ts, and IT is mounted
 * here, not a lookalike.
 *
 * There is no kernel, docker or network here: the doors are checked, not
 * what is behind them.
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
  assert.ok(made, 'the teacher for the test was not created')
  rotateLinkKey(made.id)
  return made
})()

/** A staff cookie of age `ageMs`, signed the same way as a real one. */
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

/* ---------------------------------------------------------- same origin */

test('a foreign page writes NOWHERE, not only into the panel', async () => {
  /*
   * The check sat under `/api/admin`, although the same cookie authorizes
   * creating a seminar, uploading files into a room, restarting the kernel
   * and handing out the console. There only SameSite held, a browser rule
   * that the check was introduced precisely out of distrust for.
   */
  const made = await call('POST', '/api/sessions', {
    cookie: freshCookie(),
    origin: 'https://evil.example',
    body: { name: 'С чужой страницы' },
  })
  assert.equal(made.status, 403, 'a seminar was created by a request from a foreign site')
  const said = (await made.json()) as { error?: string }
  assert.equal(said.error, tr('server.requestBlockedThisPageUsesADifferent.dd9b4b'))
})

test('a same-origin request and a request without Origin get through', async () => {
  // Without Origin means curl and the server itself: `make host` calls its own API.
  const made = await call('POST', '/api/sessions', {
    cookie: freshCookie(),
    body: { name: 'Обычный семинар' },
  })
  assert.notEqual(made.status, 403)
  assert.ok(made.status < 500, `the server broke instead of answering: ${made.status}`)
})

test('reads from a foreign page are not refused: there is nothing to read there anyway', async () => {
  // The server sets no CORS headers, so the response will not reach a
  // foreign page, and refusing a GET would break link previews and probes.
  const seen = await call('GET', '/api/health', { origin: 'https://evil.example' })
  assert.notEqual(seen.status, 403)
})

/* --------------------------------------------- the cookie gets extended */

test('a cookie older than a day is reissued on any API request', async () => {
  /*
   * `iat` was set once at sign-in and was not moved by any route, so on the
   * thirty-first day the teacher became a participant of their own room in
   * the middle of a class, with no explanation and no fallback.
   */
  const seen = await call('GET', '/api/nope', { cookie: cookieAged(8 * 24 * 3_600_000) })
  const set = seen.headers.get('set-cookie') ?? ''
  assert.match(set, new RegExp(`${STAFF_COOKIE}=`), 'the cookie was not extended: the month runs from sign-in')
  assert.match(set, /HttpOnly/i)
})

test('a fresh cookie is not reissued on every request', async () => {
  const seen = await call('GET', '/api/nope', { cookie: cookieAged(60_000) })
  assert.equal(seen.headers.get('set-cookie'), null, 'Set-Cookie on every request in a row')
})

test('signing out of the panel does not resurrect the old cookie', async () => {
  /*
   * The extension stands BEFORE the routes, and signing out removes the
   * cookie. Two `Set-Cookie` headers in a row are normal, but the last one
   * must win: "a teacher thrown out of the panel in the middle of a seminar
   * is a room without its owner", and the reverse is just as true: not
   * thrown out when they asked to be.
   */
  const seen = await call('POST', '/api/admin/signout', {
    cookie: cookieAged(8 * 24 * 3_600_000),
  })
  assert.ok(seen.status < 400, `signing out refused: ${seen.status}`)
  const set = seen.headers.getSetCookie().filter((one) => one.startsWith(`${STAFF_COOKIE}=`))
  assert.ok(set.length > 0, 'signing out said nothing about the cookie')
  const last = set[set.length - 1] ?? ''
  assert.match(
    last,
    new RegExp(`^${STAFF_COOKIE}=;`),
    `the last one to arrive was not the removal: ${set.join(' | ')}`,
  )
})

test('a foreign page does not extend the cookie', async () => {
  // Extending on a request we have just decided not to carry out would mean
  // keeping the signature alive through a foreign site.
  const seen = await call('POST', '/api/sessions', {
    cookie: cookieAged(8 * 24 * 3_600_000),
    origin: 'https://evil.example',
    body: { name: 'нет' },
  })
  assert.equal(seen.status, 403)
  assert.equal(seen.headers.get('set-cookie'), null)
})

/* --------------------------------------------------------- other wiring */

test('security headers are set on responses, not only in a constant', async () => {
  const seen = await call('GET', '/api/nope')
  assert.equal(seen.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(seen.headers.get('x-powered-by'), null, 'the server introduced itself as express')
})

test('a nonexistent API door is JSON, not an express page', async () => {
  const seen = await call('GET', '/api/nope')
  assert.equal(seen.status, 404)
  assert.deepEqual(await seen.json(), { error: tr('common.notFound') })
})

test('a malformed body is a 400 in words, not an HTML page with a 500', async () => {
  const seen = await call('POST', '/api/sessions', { raw: '{не json' })
  assert.equal(seen.status, 400)
  const said = (await seen.json()) as { error?: string }
  assert.equal(said.error, tr('common.badJson'))
})

test('robots.txt and X-Robots-Tag say the same thing about publications', async () => {
  /*
   * The same page behaved differently depending on which address it was
   * opened at: the Pages export set `noindex`, while the instance's
   * robots.txt closed only the rooms and the panel, explaining that
   * publications are "published for exactly that". The decision is now one
   * for both carriers and lives in shared/publish.ts; here we check that the
   * live side follows it.
   */
  const text = await (await call('GET', '/robots.txt')).text()
  const closed = ['/s/', '/admin', ...(PUBLIC_PAGES_INDEXED ? [] : ['/p/', '/c/'])]
  for (const path of closed) {
    assert.ok(text.includes(`Disallow: ${path}`), `${path} is not closed in robots.txt:\n${text}`)
  }
  if (PUBLIC_PAGES_INDEXED) assert.ok(!text.includes('Disallow: /p/'))

  // `Disallow` is a request not to come in; a search engine may still show
  // a closed address from someone else's link. Only the header answers that.
  const wanted = PUBLIC_PAGES_INDEXED ? null : 'noindex, nofollow'
  assert.equal((await call('GET', '/p/whatever')).headers.get('x-robots-tag'), wanted)
  assert.equal((await call('GET', '/c/whatever')).headers.get('x-robots-tag'), wanted)
  // The room and the panel are always closed, the landing is always open.
  assert.equal((await call('GET', '/s/abc')).headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal((await call('GET', '/')).headers.get('x-robots-tag'), null)
  // A link unfurler has the room open: both in robots.txt and by header.
  assert.match(text, /User-agent: TelegramBot\n(?:User-agent: [^\n]+\n)*Allow: \//)
  const telegram = await fetch(`${base}/s/abc`, { headers: { 'user-agent': 'TelegramBot (like TwitterBot)' } })
  assert.equal(telegram.headers.get('x-robots-tag'), null)
})

test('health names the address the server currently writes into links', async () => {
  /*
   * `config.publicUrl` rereads .env no more than once every two seconds, and
   * before this field there was no way to learn whether the new address had
   * arrived: `scripts/host.sh` put a `sleep 3` in this place, the only sleep
   * in the script put there not because something is awaited but because
   * there was nobody to ask.
   */
  const said = (await (await call('GET', '/api/health')).json()) as { publicUrl?: string }
  assert.equal(said.publicUrl, config.publicUrl)
  assert.match(said.publicUrl ?? '', /^https?:\/\//)
})
