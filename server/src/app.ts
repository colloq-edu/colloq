import { competitionCapabilities } from './competitions/capabilities.js'
import {tr} from '@shared/i18n'
import { kernelBackend, requireKernelIsolation, kernelRuntimeClient, loadRuntimeCatalog, runtimeDefaultEnvironment } from './kernel/runtime-client.js'
/**
 * The whole application: middleware, routes, static files — and nothing about
 * the process.
 *
 * It lived in index.ts mixed with sockets and signals, and that cost coverage:
 * importing index.ts means starting the server on a port, so the tests built
 * their own express and COPIED the middleware order into it — "the same order
 * as in index.ts", said the comment above the copy. A copy of the order does
 * not catch divergence from the original; it repeats it. Here there is one
 * order, and both the product and the test mount it.
 *
 * Sockets, `listen`, signals and cleanup stay in index.ts: the process has a
 * life of its own, and it must not start from a single `import`.
 */
import path from 'node:path'
import zlib from 'node:zlib'
import { preferredEncodings, type Encoding } from './http-encoding.js'
import { precompressedStatic } from './precompressed-static.js'
import { etagMatches, frontendPage } from './frontend-html.js'
import { linkPreview } from './link-preview.js'
import { roomCardPng } from './og-card.js'
import { getInstanceLanguage } from './admin/settings.js'
import express, { type NextFunction, type Request, type Response } from 'express'
import { sameOrigin, slideStaffCookie } from './admin/auth.js'
import { markDevice } from './bans.js'
import { aiEnabled, config } from './config.js'
import { db, getSession } from './db.js'
import { activeName, listEnvironments } from './environments.js'
import { SECURITY_HEADERS } from './headers.js'
import { jupyterReachable } from './kernel/jupyter.js'
import { isolationAvailable } from './kernel/pool.js'
import { tally } from './log.js'
import { adminAuthRoutes } from './routes/admin-auth.js'
import { adminCompetitionRoutes } from './routes/admin-competitions.js'
import { adminEnvironmentRoutes } from './routes/admin-environments.js'
import { adminImportRoutes } from './routes/admin-import.js'
import { adminInstanceRoutes } from './routes/admin-instance.js'
import { aiRoutes } from './routes/ai.js'
import { banRoutes } from './routes/bans.js'
import { competitionRoutes } from './routes/competitions.js'
import { dependencyRoutes } from './dependencies/routes.js'
import { councilRoutes } from './routes/council.js'
import { courseRoutes } from './routes/courses.js'
import { blobRoutes } from './routes/blobs.js'
import { plotlyRoutes } from './routes/plotly.js'
import { fileRoutes } from './routes/files.js'
import { historyRoutes } from './routes/history.js'
import { activityRoutes } from './routes/activity.js'
import { sessionRoutes } from './routes/sessions.js'
import { instanceSettingsRoutes } from './routes/instance-settings.js'
import { instanceResourcesRoutes } from './routes/instance-resources.js'
import { workspaceFs } from './workspace.js'
import { PUBLIC_PAGES_INDEXED } from '@shared/publish'
import { COLLOQ_VERSION } from './version.js'

const STARTED_AT = Date.now()

/* -------------------------------------------------------------- compression */

/**
 * Text-shaped responses only. Everything else this server sends is either
 * already compressed (png, jpeg, the odd zip a student uploads) or is a
 * download nobody is waiting on to paint, and re-compressing those spends the
 * seminar's CPU on bytes it will not save.
 */
const COMPRESSIBLE_TYPE =
  /^(?:text\/|application\/(?:json|javascript|ecmascript|xml|wasm|manifest\+json)|image\/svg\+xml)/i

/** Under a kilobyte, the encoding's own framing eats most of what it saves. */
const COMPRESS_MIN_BYTES = 1024

const GZIP_OPTIONS: zlib.ZlibOptions = { level: 6 }
const BROTLI_OPTIONS: zlib.BrotliOptions = {
  params: {
    // 11 is an offline setting. 5 costs about what gzip costs and still beats
    // it on ratio, which is the trade a live server wants.
    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  },
}

function worthCompressing(res: Response): boolean {
  if (res.getHeader('Content-Encoding')) return false
  // 204/304 have no body; 206 is a byte range of the *identity* representation
  // and compressing it would make the offsets a lie.
  if (res.statusCode === 204 || res.statusCode === 304 || res.statusCode === 206) return false
  const type = String(res.getHeader('Content-Type') ?? '')
  if (!COMPRESSIBLE_TYPE.test(type)) return false
  // An event stream is read as it arrives; a compressor would sit on each event
  // waiting for a block to fill.
  if (type.startsWith('text/event-stream')) return false
  if (String(res.getHeader('Cache-Control') ?? '').includes('no-transform')) return false
  // Workspace downloads: user data of any size, on nobody's critical path.
  if (String(res.getHeader('Content-Disposition') ?? '').startsWith('attachment')) return false
  return true
}

/**
 * Streaming gzip/brotli, in place of the `compression` package.
 *
 * Nothing is buffered once the decision is made: chunks go straight into zlib
 * and out to the socket as they are produced. The only bytes ever held are the
 * first kilobyte of a response whose length the framework did not declare,
 * which is exactly what is needed to know whether compressing it is worth it.
 */
function compression(req: Request, res: Response, next: NextFunction): void {
  // Before the early exits: whatever this response turns out to be, a shared
  // cache must key it on the header that decided its encoding.
  res.vary('Accept-Encoding')

  const encoding = preferredEncodings(req.headers['accept-encoding'])[0]
  // A HEAD response carries the identity headers and no body to encode.
  if (!encoding || req.method === 'HEAD') return next()

  type RawWrite = (chunk?: unknown, encoding?: unknown, cb?: unknown) => boolean
  type RawEnd = (chunk?: unknown, encoding?: unknown, cb?: unknown) => Response
  const rawWrite = res.write.bind(res) as unknown as RawWrite
  const rawEnd = res.end.bind(res) as unknown as RawEnd

  let mode: 'undecided' | 'plain' | 'zip' = 'undecided'
  let zip: zlib.Gzip | zlib.BrotliCompress | null = null
  let held: Buffer[] = []
  let heldBytes = 0
  let endCb: (() => void) | undefined
  let ended = false

  const charset = (enc: unknown): BufferEncoding =>
    typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8'
  const sizeOf = (chunk: unknown, enc: unknown): number =>
    typeof chunk === 'string'
      ? Buffer.byteLength(chunk, charset(enc))
      : (chunk as Uint8Array).byteLength
  const asBuffer = (chunk: unknown, enc: unknown): Buffer =>
    typeof chunk === 'string'
      ? Buffer.from(chunk, charset(enc))
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array)

  function begin(): void {
    res.removeHeader('Content-Length')
    res.setHeader('Content-Encoding', encoding as Encoding)
    zip =
      encoding === 'br' ? zlib.createBrotliCompress(BROTLI_OPTIONS) : zlib.createGzip(GZIP_OPTIONS)
    zip.on('data', (chunk: Buffer) => {
      if (rawWrite(chunk) === false) zip?.pause()
    })
    zip.on('end', () => rawEnd(undefined, undefined, endCb))
    // A half-written body must not look like a whole one to the browser.
    zip.on('error', () => res.destroy())
    res.on('drain', () => zip?.resume())
    res.on('close', () => zip?.destroy())
    mode = 'zip'
  }

  /** Decide once, on the first byte, while the headers can still be changed. */
  function decide(incoming: number, ending: boolean): void {
    if (mode !== 'undecided') return
    if (!worthCompressing(res)) {
      mode = 'plain'
      return
    }
    const declared = res.getHeader('Content-Length')
    if (declared !== undefined) {
      if (Number(declared) < COMPRESS_MIN_BYTES) mode = 'plain'
      else begin()
      return
    }
    // Length unknown (a piped stream): hold up to the threshold to find out.
    if (heldBytes + incoming >= COMPRESS_MIN_BYTES) begin()
    else if (ending) mode = 'plain'
  }

  function drainHeld(): void {
    if (held.length === 0) return
    const pending = held
    held = []
    heldBytes = 0
    for (const chunk of pending) {
      if (mode === 'zip') zip?.write(chunk)
      else rawWrite(chunk)
    }
  }

  res.write = ((chunk?: unknown, enc?: unknown, cb?: unknown): boolean => {
    if (typeof enc === 'function') {
      cb = enc
      enc = undefined
    }
    if (chunk === undefined || chunk === null) return rawWrite(chunk, enc, cb)

    decide(sizeOf(chunk, enc), false)
    // Uncompressed responses are handed on untouched — no copy, no re-encode.
    if (mode === 'plain') {
      drainHeld()
      return rawWrite(chunk, enc, cb)
    }

    const buf = asBuffer(chunk, enc)
    if (mode === 'undecided') {
      held.push(buf)
      heldBytes += buf.length
      ;(cb as (() => void) | undefined)?.()
      return true
    }
    drainHeld()

    const ok = zip!.write(buf, cb as (() => void) | undefined)
    // Backpressure travels through zlib, so the socket's own 'drain' may never
    // fire; without this a piped file would pause and never be resumed.
    if (!ok) zip!.once('drain', () => res.emit('drain'))
    return ok
  }) as Response['write']

  res.end = ((chunk?: unknown, enc?: unknown, cb?: unknown): Response => {
    if (typeof chunk === 'function') {
      cb = chunk
      chunk = undefined
      enc = undefined
    } else if (typeof enc === 'function') {
      cb = enc
      enc = undefined
    }
    // res.end() is a no-op the second time; ending zlib twice would throw.
    if (ended) return res
    ended = true
    endCb = cb as (() => void) | undefined

    const empty = chunk === undefined || chunk === null
    // A bodiless end (a 304, a bare res.end()) has nothing to compress.
    if (mode === 'undecided' && empty && heldBytes === 0) mode = 'plain'
    decide(empty ? 0 : sizeOf(chunk, enc), true)

    drainHeld()
    if (mode !== 'zip') return rawEnd(chunk, enc, endCb)
    // rawEnd runs from zlib's 'end', once the last compressed byte is out.
    zip!.end(empty ? undefined : asBuffer(chunk, enc))
    return res
  }) as Response['end']

  next()
}

/* ------------------------------------------------------------------ http */

/*
 * One application per process, assembled when the module loads.
 *
 * It cannot honestly be a factory: the routers below hold the instance's state
 * — the database, kernels, environments — and a second instance next to it
 * would not be "one more application" but a second owner of the same tables.
 * Whoever needs the real middleware order — tests, the test harness,
 * `http.createServer` — takes this one.
 */
export const app = express()
app.disable('x-powered-by')

app.use((_req, res, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  next()
})

app.use(compression)
app.use(express.json({ limit: '1mb' }))

/**
 * Whether the Python the room will use is ready — not the one next door.
 *
 * With isolation (KERNEL_ISOLATION=auto and a live docker) every room has its
 * own container from the `colloq-kernel:<environment>` image, and nobody
 * touches the shared compose kernel. Health asked exactly about that one: an
 * unbuilt image of the active environment gave a green answer over an instance
 * where not a single room would start, and a crashed compose kernel a red one
 * over an instance where everything works.
 *
 * The answer is cached for the same five seconds as the Jupyter probe: `docker
 * image inspect` is a process, and the probe comes here once a second.
 *
 * And a cache is not enough: it is written only when the check has RETURNED.
 * While docker is alive, that takes fractions of a second; when the daemon
 * hangs — eight seconds of timeout per environment, and all that time the cache
 * is empty while the probe knocks once a second. Every next request started
 * the same batch of `docker image inspect` again, and on the machine where a
 * class was going on, dozens of processes piled up — exactly when it was
 * already struggling. So there is also an in-flight check here: whoever comes
 * second waits for the other's answer instead of starting their own.
 */
let kernelProbe: { at: number; ok: boolean; reason: string | null } | null = null
let kernelProbing: Promise<{ ok: boolean; reason: string | null }> | null = null

async function kernelHealth(): Promise<{ ok: boolean; reason: string | null }> {
  const now = Date.now()
  if (kernelProbe && now - kernelProbe.at < 5000)
    return { ok: kernelProbe.ok, reason: kernelProbe.reason }
  // No `await` before this line: between starting the check and registering it
  // there must be no point where a second request sees "nobody is checking".
  if (kernelProbing) return kernelProbing
  const probe = probeKernel().finally(() => {
    kernelProbing = null
  })
  kernelProbing = probe
  return probe
}

/**
 * What separates the rooms' kernels from each other — for whoever opens the
 * door to the outside.
 *
 * A class may be published to the internet only when every room has its own
 * container (the author's decision): scripts/host.sh and the colloq supervisor
 * (cli/src/launch-share.ts) ask about it here rather than guessing from .env.
 * The answer is not a setting but a fact: the field is set only when the kernel
 * check passed, that is, requireKernelIsolation did not refuse and the docker
 * daemon or the broker answered (probeKernel). The test backend gives no
 * isolation at all — null.
 */
function roomIsolation(kernelOk: boolean): 'docker' | 'broker' | null {
  if (!kernelOk) return null
  try {
    const backend = kernelBackend()
    return backend === 'docker' || backend === 'broker' ? backend : null
  } catch {
    return null
  }
}

async function probeKernel(): Promise<{ ok: boolean; reason: string | null }> {
  // The shared compose kernel gets no cache here: `jupyterReachable` has its
  // own, for the same five seconds, and there is nowhere for a second copy to
  // come from.
  try {
    requireKernelIsolation()
    if (kernelBackend() === 'test') return jupyterReachable()
    if (kernelBackend() === 'broker') {
      loadRuntimeCatalog()
      runtimeDefaultEnvironment()
      const health=await kernelRuntimeClient().health()
      kernelProbe={at:Date.now(),...health}
      return health
    }
    if (!(await isolationAvailable())) throw new Error('Room isolation is unavailable. Kernel execution is disabled.')
  } catch (error) {
    const health={ok:false,reason:error instanceof Error?error.message:tr('common.runtimeUnavailable')}
    kernelProbe={at:Date.now(),...health}
    return health
  }

  const active = activeName()
  let ok = false
  let reason: string | null = null
  try {
    // builtAt, not state: "the list was edited after the build" is a reason to
    // rebuild, not a reason to refuse to start a class on the previous image.
    const environment = (await listEnvironments()).find((env) => env.name === active)
    ok = !!environment && environment.builtAt !== null
    if (!environment) reason = `There is no environment called "${active}"`
    else if (!ok)
      reason = `The "${active}" environment has never been built — build it in the panel`
  } catch (err) {
    reason =
      err instanceof Error ? `Docker did not answer: ${err.message}` : 'Docker did not answer'
  }
  kernelProbe = { at: Date.now(), ok, reason }
  return { ok, reason }
}

/*
 * "Healthy" means "a seminar can be run here".
 *
 * It used to mean "the process answers", and that was enough for host.sh and
 * `make status` to print "Colloq is available at the link" over an instance
 * where Docker had been off since yesterday: the room opens, the link works,
 * and the first Run answers KERNEL DEAD seventy seconds later. The database,
 * Python and file access are checked: without the last, neither a notebook can
 * be opened nor a kernel started.
 */
app.get('/api/livez', (_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({ok:true})})

app.get('/api/health', (_req, res) => {
  const began = process.hrtime.bigint()
  // "The process answered" says nothing about whether it answered *quickly*. A
  // trip through the event loop costs nothing and reports what a probe wants to
  // know: how long the next student's keystroke would have to queue.
  setImmediate(() => {
    void (async () => {
      const loopLagMs = Number(process.hrtime.bigint() - began) / 1e6
      let dbOk = true
      let reason: string | null = null
      try {
        db.prepare('SELECT 1').get()
      } catch (err) {
        dbOk = false
        reason =
          err instanceof Error
            ? `The database is unreadable: ${err.message}`
            : 'The database is unreadable'
      }
      const [kernel, capabilities] = await Promise.all([kernelHealth(), competitionCapabilities()])
      if (dbOk && !kernel.ok) reason = kernel.reason

      let workspaceOk = true
      try {
        workspaceFs.mkdirSync(config.workspaceDir, { recursive: true })
      } catch (err) {
        workspaceOk = false
        if (reason === null) reason = err instanceof Error ? err.message : 'The workspace is unavailable'
      }

      const ok = dbOk && kernel.ok && workspaceOk
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Server-Timing', `loop;dur=${loopLagMs.toFixed(3)}`)
      // 503, not 200 with a field: probes look at the code, and only the code
      // makes a script stop instead of printing the link.
      res.status(ok ? 200 : 503).json({
        ok,
        reason,
        kernel: kernel.ok,
        capabilities,
        // docker | broker | null — whether every room has its own container (roomIsolation).
        isolation: roomIsolation(kernel.ok),
        database: dbOk,
        workspace: workspaceOk,
        uptimeMs: Date.now() - STARTED_AT,
        loopLagMs: Number(loopLagMs.toFixed(3)),
        /*
         * The address the server is currently writing into links — out loud.
         *
         * `config.publicUrl` is a getter: it re-reads .env at most once every
         * two seconds, and before this line there was no way to learn whether
         * the new address had arrived. `scripts/host.sh` under WHO=service put
         * a `sleep 3` in this place — the only sleep in the script put there
         * not because something was being waited for, but because there was
         * nobody to ask.
         */
        publicUrl: config.publicUrl,
        localRunId: process.env.COLLOQ_LOCAL_SESSION === '1' ? process.env.COLLOQ_LOCAL_RUN_ID ?? null : null,
        /*
         * Which version is answering. Troubleshooting starts with the question
         * "which release do you have", and before this field there was nothing
         * to answer it with: neither the server nor the image knew the number.
         * Here, not in /api/livez: livez is a pulse for the k3s probe, and
         * nobody reads its body.
         */
        version: COLLOQ_VERSION,
      })
    })()
  })
})
/*
 * Nothing from a foreign page writes — anywhere, not only to the panel.
 *
 * The cookie is issued with sameSite: 'lax', and the browser will not attach it
 * to a cross-site POST — but that is the browser's rule, not the server's, and
 * it holds until the first machine with an old browser or an extension that
 * decides for it.
 *
 * The check sat under `/api/admin`, although the same `colloq_staff` also
 * authorizes the writes around it: creating a seminar, uploading and deleting
 * room files, interrupting and restarting the kernel, handing out the console.
 * There only SameSite held — exactly the browser rule this check was introduced
 * to not rely on. So it is on all of `/api`: remembering it on every new route
 * costs more than putting it once at the entrance.
 *
 * GET/HEAD/OPTIONS are left alone: there is nothing to read from a foreign
 * page anyway — the server sets no CORS headers, and the response will not get
 * there. A request without Origin is curl or the server itself (`make host`
 * calls its own API), and those must not be refused; only an Origin that was
 * sent is checked.
 */
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  sameOrigin(req, res, next)
})
/*
 * The staff cookie is extended by activity — here, not in `requireStaff`.
 *
 * The month counted from sign-in and no route moved it, so on the thirty-first
 * day a teacher in the middle of a class became a participant in their own
 * room (see `slideStaffCookie`). ANY request to the API extends it, not only a
 * panel one: half of the work bypasses the panel — the room, files, the kernel.
 *
 * After the origin check: extending on a request we have just decided not to
 * serve would mean keeping the signature alive through a foreign page.
 */
app.use('/api', (req, res, next) => {
  slideStaffCookie(req, res)
  next()
})
// The teaching side goes on before the session routes read from it: POST
// /api/sessions asks currentStaff() who is calling, and the admin routers are
// what put the staff table and the cookie in front of it.
app.use(adminAuthRoutes())
app.use(instanceSettingsRoutes())
app.use(instanceResourcesRoutes())
app.use(adminInstanceRoutes())
app.use(courseRoutes())
app.use(adminEnvironmentRoutes())
// The competitions panel — next to the other admin doors and under the same
// right; participants are answered by their own half below
// (routes/competitions.ts).
app.use(adminCompetitionRoutes())
app.use(adminImportRoutes())
app.use(sessionRoutes())
// The ban doors — right behind sign-in: they are about the same people and live
// under the same right (routes/bans.ts), and the check they set up is done by
// bans.ts at the entrance.
app.use(banRoutes())
app.use(historyRoutes())
app.use(activityRoutes())
app.use(fileRoutes())
// Output images live next to the room, not in its document (server/blobs.ts).
app.use(blobRoutes())
// The plotly chart frame: the only response with its own policy — and without
// credentials, because there is nothing in it to guard (routes/plotly.ts).
app.use(plotlyRoutes())
app.use(aiRoutes())
// The council goes after the oracle: its only REST door asks the same model and
// spends the same room question limit (routes/council.ts).
app.use(councilRoutes())
// Competitions are their own half of the product with their own credentials:
// `/api/k` asks for the participant cookie, not the teacher's
// (routes/competitions.ts).
app.use(competitionRoutes())
app.use(dependencyRoutes())

app.use('/api', (_req, res) => res.status(404).json({ error: tr('common.notFound') }))

/* ------------------------------------------------------------- indexing */

/*
 * What is closed to search engines — one decision for every channel.
 *
 * A room opens by a personal link and lives for hours, and the panel sign-in
 * page is a form with an email field on a young domain: to a search robot,
 * exactly what phishers trade in. Google once flagged all of colloq.ru as
 * dangerous, and students would have seen the red screen on every seminar
 * address.
 *
 * Published pages are not decided by this file: the decision is written down in
 * one copy in `shared/publish.ts` (`PUBLIC_PAGES_INDEXED`), and the same one
 * governs `<meta name="robots">` in the Pages export (publish/render.ts). While
 * the rule lived in comments on both sides, they managed to drift apart: the
 * static side set `noindex`, while here it was written that publications "are
 * indexed as before: that is what they are published for" — one and the same
 * page behaved differently depending on the address it was opened by. The
 * landing page is open and stays open.
 *
 * Outside the static block, although it used to live inside: indexing is an
 * instance policy, not a property of the built frontend. In direct mode and in
 * development STATIC_DIR is empty, and together with the static files both
 * robots.txt and the header disappeared.
 */
const NOINDEX_PATHS = PUBLIC_PAGES_INDEXED
  ? ['/s/', '/admin']
  : ['/s/', '/admin', '/p/', '/c/']
const NOINDEX = new RegExp(
  `^/(${NOINDEX_PATHS.map((p) => p.replace(/^\/|\/$/g, '')).join('|')})(/|$)`,
)

/*
 * Our own robots.txt — for when there is no relay in front of us.
 *
 * Behind the relay, the relay serves the same one itself, before the tunnel; in
 * direct mode (`make host-direct`) there is nobody to serve it but us.
 */
/*
 * Link unfurlers are not search engines, and they are allowed everything.
 *
 * Telegram (which also introduces itself as Twitterbot), WhatsApp, iMessage,
 * Slack and Discord read robots.txt and look at X-Robots-Tag before building a
 * card; a closed address they leave as a bare link — that is how it was with
 * rooms until 12 Sep 2026. They index nothing: they take the class name and the
 * picture from `<head>` (link-preview.ts) and leave. The same list is in the
 * relay's robots.txt (scripts/relay-setup.sh) — it answers before the tunnel.
 */
export const LINK_PREVIEW_AGENTS = [
  'TelegramBot',
  'Twitterbot',
  'facebookexternalhit',
  'Facebot',
  'WhatsApp',
  'Slackbot-LinkExpanding',
  'Discordbot',
  'LinkedInBot',
]
const LINK_PREVIEW_AGENT = new RegExp(LINK_PREVIEW_AGENTS.join('|'), 'i')

export function isLinkPreviewAgent(userAgent: string | undefined): boolean {
  return userAgent !== undefined && LINK_PREVIEW_AGENT.test(userAgent)
}

/*
 * The room card picture — see og-card.ts. An hour in cache: messengers come for
 * it, and they come by an address with a version (link-preview.ts), so renaming
 * the room changes the address rather than waiting for expiry.
 */
app.get('/og/rooms/:id.png', (req, res, next) => {
  const session = getSession(req.params.id)
  if (!session) {
    res.status(404).type('text/plain').send(tr('common.notFound'))
    return
  }
  const host = config.publicUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  roomCardPng({ name: session.name, createdAt: session.createdAt, host, language: getInstanceLanguage() })
    .then((png) => {
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.type('png').send(png)
    })
    .catch(next)
})

app.get('/robots.txt', (_req, res) => {
  res
    .type('text/plain')
    .send(
      `${LINK_PREVIEW_AGENTS.map((agent) => `User-agent: ${agent}`).join('\n')}\nAllow: /\n\n` +
        `User-agent: *\n${NOINDEX_PATHS.map((path) => `Disallow: ${path}`).join('\n')}\n`,
    )
})

/*
 * A header, not only `Disallow`: a search engine is still entitled to show an
 * address closed in robots.txt in its results via someone else's link —
 * `noindex` is already an answer, not a request not to visit. Link unfurlers do
 * not get the header — see LINK_PREVIEW_AGENTS.
 */
app.use((req, res, next) => {
  if (NOINDEX.test(req.path) && !isLinkPreviewAgent(req.headers['user-agent'])) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  }
  next()
})

if (config.staticDir) {
  const staticDir = path.resolve(config.staticDir)
  app.use(precompressedStatic(staticDir))
  const indexFile = path.join(staticDir, 'index.html')
  /*
   * One and the same page for the whole audience, built once.
   *
   * The bytes, the ETag and both encodings are held by frontend-html.ts — the
   * reasons are written there too. What stays here is what depends on the
   * request: the device mark, the choice of encoding and the "you already have
   * it" answer.
   *
   * Content-Encoding is set by hand, and that is not a trifle: the compressing
   * middleware above (worthCompressing) sees the header and leaves the response
   * alone — otherwise the ready bytes would go into brotli a second time.
   */
  const sendFrontend = (req: Request, res: Response, next: NextFunction): void => {
    markDevice(req, res)
    const language = getInstanceLanguage()
    // The tab title and the link card go by address: a room has its own name
    // (link-preview.ts), everything else gets the general Colloq card.
    void linkPreview(req.path, language, staticDir)
      .then((extras) => frontendPage(indexFile, language, extras))
      .then((page) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Content-Language', language)
      res.setHeader('ETag', page.etag)
      res.vary('Accept-Encoding')
      // A returning student opens the room a second time during a class: the
      // body is needed neither by them nor by the socket. The instance language
      // is part of the ETag, so changing the language in the panel invalidates
      // every one handed out.
      if (etagMatches(req.headers['if-none-match'], page.etag)) {
        res.status(304).end()
        return
      }
      const encoding = preferredEncodings(req.headers['accept-encoding'])
        .find((name) => page.encoded[name])
      const body = encoding ? page.encoded[encoding]! : page.body
      if (encoding) res.setHeader('Content-Encoding', encoding)
      res.type('html')
      res.setHeader('Content-Length', String(body.length))
      res.end(body)
    }).catch(next)
  }
  app.get('/index.html', sendFrontend)
  /*
   * Versioned is `assets/`, and only that.
   *
   * Vite stamps a hash into the name of everything it builds and puts it into
   * assets/; everything else in dist comes from web/public as is, under the
   * name a person chose. Next to the directory check there was a regexp "a
   * hyphen and eight characters" — and `hse-sans-400.woff2` matched it
   * ("-sans-400"), although there is no hash in the name. The institute's font
   * went out with `immutable` for a year: replacing a face or the font itself
   * under the same name and seeing it reach returning browsers was impossible —
   * until someone cleared the cache by hand. The directory answers the same
   * question and does not get it wrong.
   */

  // index: false so every navigation falls through to the SPA handler below and
  // gets an uncached index.html; the hashed assets around it stay cacheable.
  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders(res, filePath) {
        const name = path.basename(filePath)
        if (name === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache')
          return
        }
        const relative = path.relative(staticDir, filePath)
        const versioned = relative.startsWith(`assets${path.sep}`)
        // A returning student re-validated every file before this; now the only
        // request a warm cache makes is for index.html.
        res.setHeader(
          'Cache-Control',
          versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        )
      },
    }),
  )
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    /*
     * The device mark is set here — when the page itself is served.
     *
     * This is the only response that is sure to go to the browser rather than
     * to fetch: setting the cookie on an API request would mean not setting it
     * for those whose page was served by a different process. The mark
     * survives clearing storage and rejoining, but not incognito — and nothing
     * more is expected of it (server/src/bans.ts).
     */
    sendFrontend(req, res, next)
  })
}

/**
 * The client left without listening to the end.
 *
 * `res.sendFile` on an aborted request gives Error('Request aborted') with
 * `code: 'ECONNABORTED'` and no status (express, response.js: sendfile), and
 * body-parser on an aborted body gives an error with `type: 'request.aborted'`.
 * Both reached the "internal error" branch below and printed a four-line stack.
 * This is a student who closed the tab before the load finished: on a cohort
 * of five hundred there are hundreds of such lines, and a real breakage drowns
 * among them.
 */
function clientLeft(err: unknown, res: Response): boolean {
  const failed = err as { code?: unknown; type?: unknown } | null
  // These two codes are born exactly there and only there: `ECONNABORTED` in
  // express's own sendfile, `request.aborted` in body-parser. They cannot be
  // mistaken for anything.
  if (failed?.code === 'ECONNABORTED' || failed?.type === 'request.aborted') return true
  /*
   * ECONNRESET and EPIPE, on the other hand, mean nothing by themselves: an
   * OUTGOING connection that broke off — to the kernel, to the oracle — answers
   * with the same code, and silently swallowing one would hide a real server
   * breakage behind words about a student who left. So they also ask the
   * socket: if there is nowhere left to write, it really was the client who
   * left.
   */
  if (failed?.code === 'ECONNRESET' || failed?.code === 'EPIPE') return !res.writable
  return false
}

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err)
  /*
   * An aborted request is not written to the log at all — only to the
   * per-minute counter.
   *
   * Of the two allowed options ("one calm line" or "silently") the second was
   * chosen: the server did nothing here and can do nothing, and the number of
   * people who left mid-load is visible in the summary anyway as an `aborted N`
   * line — it is even more useful there, because next to it stands how many
   * people there were in that minute. There is nobody to answer either: the
   * socket is already gone, and `res.status(500)` went into the void.
   */
  if (clientLeft(err, res)) {
    tally('aborted')
    // Our side is closed anyway: on a live socket this is an empty response, on
    // a dead one nothing, and express does not clean up a request left hanging
    // without an answer by itself.
    res.end()
    return
  }
  // express.json rejects malformed bodies with an HTML error page by default,
  // which the browser's JSON-only client cannot read.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: tr('common.badJson') })
  }
  /*
   * A refusal to the client is a refusal to the client, not a server breakage.
   *
   * body-parser rejects a body that is too large with an error with
   * `status: 413` (`entity.too.large`), and an unknown encoding with 415, and
   * neither of them is a SyntaxError: both reached the branch below, that is, a
   * 500 "internal error" and a stack in the log. A teacher importing a notebook
   * with pictures saw "The server failed" instead of "the file is too large",
   * and the log a scare out of nothing. 4xx with a clear line is given back as
   * is; 5xx is left to the branch below.
   */
  const failed = err as { status?: unknown; statusCode?: unknown; type?: unknown } | null
  const status = failed?.status ?? failed?.statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Use a translated public message; exception details may contain host paths.
    return res
      .status(status)
      .json({ error: status === 413 ? tr('common.bodyTooLarge') : tr('common.badRequest') })
  }
  // With the stack and the path: without them a log line says "something broke"
  // and does not say where — and that is exactly what people go into the log
  // for.
  console.error(
    `[http] unhandled error on ${req.method} ${req.originalUrl}:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  )
  res.status(500).json({ error: tr('common.internalError') })
})
