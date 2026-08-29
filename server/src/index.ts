/**
 * Process entry point: one HTTP server, two WebSocket paths, one static bundle.
 *
 * Colloq is deliberately a single process behind a single origin. A seminar is
 * hosted by whoever runs `docker compose up` twenty minutes before class, so
 * everything a student touches — the page, the REST API, the CRDT socket and
 * the run-control socket — must arrive on the one URL that was written on the
 * whiteboard, with no reverse-proxy rules to get wrong.
 *
 * That single origin is also the whole delivery story: there is no CDN in front
 * of it and no proxy to add compression or cache headers, so this file has to
 * do both itself.
 */
// Первым: он правит console, а импорты поднимаются наверх — всё, что модули
// печатают при загрузке, должно застать уже исправленную.
import './log.js'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import express, { type NextFunction, type Request, type Response } from 'express'
import { WebSocketServer } from 'ws'
import type { Duplex } from 'node:stream'
import { isClaimed, readSetupToken, sameOrigin, setupTokenPath } from './admin/auth.js'
import { verifyToken, type TokenPayload } from './auth.js'
import { aiEnabled, config } from './config.js'
import { SECURITY_HEADERS } from './headers.js'
import { handleCollabSocket, shutdownCollab } from './collab/index.js'
import { handleFileSocket } from './collab/files.js'
import { normalizePath } from '@shared/paths'

import { handleControlSocket } from './control.js'
import { closeDatabase, db, getSession, touchLastSeen } from './db.js'
import { shutdownKernels } from './kernel/index.js'
import { jupyterReachable } from './kernel/jupyter.js'
import { adminAuthRoutes } from './routes/admin-auth.js'
import { adminEnvironmentRoutes } from './routes/admin-environments.js'
import { adminImportRoutes } from './routes/admin-import.js'
import { adminInstanceRoutes } from './routes/admin-instance.js'
import { courseRoutes } from './routes/courses.js'
import { aiRoutes } from './routes/ai.js'
import { fileRoutes } from './routes/files.js'
import { roleFor, sessionRoutes } from './routes/sessions.js'
import { historyRoutes } from './routes/history.js'

/** A whole notebook's state travels in one sync frame; images make it big. */
const MAX_WS_PAYLOAD = 16 * 1024 * 1024
const SHUTDOWN_GRACE_MS = 8000
const UPGRADE_PATH = /^\/(collab|control)\/([A-Za-z0-9_-]{1,64})\/?$/
/*
 * У файла в адресе два отрезка: комната и сам файл, путь в base64url.
 *
 * Путь ушёл из строки запроса в адрес не ради красоты: y-websocket заводит
 * BroadcastChannel по адресу без параметров, и два разных файла одной комнаты,
 * открытые в двух вкладках браузера, оказывались в одном канале — правки одного
 * приезжали в документ другого. Имя комнаты обязано быть разным.
 */
const FILE_PATH = /^\/file\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,2048})\/?$/
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

type Encoding = 'br' | 'gzip'

function negotiate(header: string | undefined): Encoding | null {
  if (!header) return null
  const offered = new Map<string, number>()
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().split(';')
    let q = 1
    for (const param of params) {
      const match = /^\s*q=([\d.]+)/i.exec(param)
      if (match) q = Number(match[1])
    }
    offered.set(token.trim().toLowerCase(), Number.isFinite(q) ? q : 0)
  }
  // A named encoding wins over '*', so `*, gzip;q=0` is still a refusal of gzip.
  const wildcard = offered.get('*') ?? 0
  const br = offered.get('br') ?? wildcard
  const gzip = offered.get('gzip') ?? wildcard
  if (br > 0 && br >= gzip) return 'br'
  return gzip > 0 ? 'gzip' : null
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

  const encoding = negotiate(req.headers['accept-encoding'])
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

const app = express()
app.disable('x-powered-by')

app.use((_req, res, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  next()
})

app.use(compression)
app.use(express.json({ limit: '1mb' }))

/*
 * «Здоров» значит «здесь можно вести семинар».
 *
 * Раньше значило «процесс отвечает», и этого хватало, чтобы host.sh и
 * `make status` напечатали «Colloq доступен по ссылке» над инстансом, где
 * Docker выключен со вчера: комната открывается, ссылка работает, а первый Run
 * через семьдесят секунд отвечает KERNEL DEAD. Проверяются обе вещи, без
 * которых семинара не будет: своя база и Jupyter.
 */
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
        reason = err instanceof Error ? `The database is unreadable: ${err.message}` : 'The database is unreadable'
      }
      const kernel = await jupyterReachable()
      if (dbOk && !kernel.ok) reason = kernel.reason

      const ok = dbOk && kernel.ok
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Server-Timing', `loop;dur=${loopLagMs.toFixed(3)}`)
      // 503, а не 200 с полем: зонды смотрят на код, и только код заставляет
      // скрипт остановиться вместо того, чтобы напечатать ссылку.
      res.status(ok ? 200 : 503).json({
        ok,
        reason,
        kernel: kernel.ok,
        database: dbOk,
        uptimeMs: Date.now() - STARTED_AT,
        loopLagMs: Number(loopLagMs.toFixed(3)),
      })
    })()
  })
})
/*
 * Ничего с чужой страницы не пишет в панель.
 *
 * Печенье выдаётся с sameSite: 'lax', и браузер не приложит его к межсайтовому
 * POST — но это правило браузера, а не сервера. Одна проверка на весь /api/admin
 * дешевле, чем помнить про неё на каждом новом маршруте; GET не трогаем, читать
 * с чужой страницы всё равно нечего — ответ туда не попадёт.
 */
app.use('/api/admin', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  sameOrigin(req, res, next)
})
// The teaching side goes on before the session routes read from it: POST
// /api/sessions asks currentStaff() who is calling, and the admin routers are
// what put the staff table and the cookie in front of it.
app.use(adminAuthRoutes())
app.use(adminInstanceRoutes())
app.use(courseRoutes())
app.use(adminEnvironmentRoutes())
app.use(adminImportRoutes())
app.use(sessionRoutes())
app.use(historyRoutes())
app.use(fileRoutes())
app.use(aiRoutes())

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }))

if (config.staticDir) {
  const staticDir = path.resolve(config.staticDir)
  /** Vite stamps a content hash into every emitted name, so the name is the version. */
  const HASHED = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/

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
        const versioned = relative.startsWith(`assets${path.sep}`) || HASHED.test(name)
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
    // no-cache, not no-store: the browser still holds the file and an ETag, so
    // an unchanged deploy costs one 304 and a changed one is picked up at once.
    res.sendFile(
      path.join(staticDir, 'index.html'),
      { headers: { 'Cache-Control': 'no-cache' } },
      (err) => {
        if (err) next(err)
      },
    )
  })
}

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err)
  // express.json rejects malformed bodies with an HTML error page by default,
  // which the browser's JSON-only client cannot read.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'malformed JSON body' })
  }
  // Со стеком и с путём: без них строка в журнале говорит «что-то сломалось»
  // и не говорит где — а именно за этим в журнал и лезут.
  console.error(
    `[http] unhandled error on ${req.method} ${req.originalUrl}:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  )
  res.status(500).json({ error: 'internal error' })
})

const server = http.createServer(app)

/* ------------------------------------------------------------ websockets */

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_PAYLOAD,
  perMessageDeflate: {
    // Yjs deltas are a few dozen binary bytes; deflating those costs more CPU
    // and more latency than the bytes are worth. The frames that matter are the
    // initial sync steps, which are tens of kilobytes and compress well.
    threshold: 8 * 1024,
    zlibDeflateOptions: { level: 4, memLevel: 8 },
    zlibInflateOptions: { chunkSize: 16 * 1024 },
    // No context takeover: a seminar holds thirty sockets open at once, and a
    // retained zlib window per socket is memory spent on frames that mostly
    // never get compressed anyway.
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 13,
    concurrencyLimit: 10,
  },
})

function reject(socket: Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  socket.destroy()
}

/**
 * Роль этого соединения — решается сейчас, а не читается из токена.
 *
 * Роль, зашитая в токен при входе, — это роль, которую нельзя отобрать:
 * преподаватель, убранный из списка, сохранял Restart во всех комнатах,
 * которые когда-либо открывал. Сокет перепроверяется на каждом переподключении,
 * так что выход из панели снимает права за секунды. Считает `roleFor` —
 * та же самая, что и на HTTP-стороне, чтобы двум входам было негде разойтись.
 */
function effectiveRole(req: { headers: { cookie?: string } }, payload: TokenPayload): TokenPayload['role'] {
  return roleFor(req.headers.cookie, payload)
}

/** Имя комнаты файла обратно в путь. Кривая строка — это просто не путь. */
function decodeRoom(room: string): string {
  try {
    return Buffer.from(room, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

server.on('upgrade', (req, socket, head) => {
  // Until handleUpgrade adopts it this socket has no error handler, and a client
  // that vanishes mid-handshake would otherwise throw out of the event loop.
  socket.on('error', () => socket.destroy())

  let url: URL
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    return reject(socket)
  }

  const asFile = FILE_PATH.exec(url.pathname)
  const match = asFile ?? UPGRADE_PATH.exec(url.pathname)
  if (!match) return reject(socket)
  const channel = asFile ? 'file' : match[1]
  const sessionId = asFile ? asFile[1] : match[2]

  // The token is the whole authorization story: it names the session it was
  // minted for, so a valid token for seminar A cannot open seminar B.
  const payload: TokenPayload | null = verifyToken(url.searchParams.get('token'))
  if (!payload || payload.sessionId !== sessionId) return reject(socket)
  // A token outlives the room it names. Without this check a browser left open
  // on a deleted seminar reconnects, gets a freshly seeded document and writes
  // a snapshot row for a seminar the owner already destroyed.
  if (!getSession(sessionId)) return reject(socket)

  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      touchLastSeen(payload.participantId)
    } catch {
      /* presence bookkeeping must never cost someone their connection */
    }
    if (channel === 'collab')
      handleCollabSocket(ws, sessionId, effectiveRole(req, payload), payload.participantId)
    else if (channel === 'file') {
      /*
       * Путь приезжает вторым отрезком адреса, в base64url. Проверяет его тот
       * же `normalizePath`, что и всё остальное в продукте, — и до него сюда не
       * доходит ничего, кроме уже проверенного токена этой самой комнаты.
       */
      const wanted = normalizePath(decodeRoom(asFile?.[2] ?? ''))
      if (!wanted) {
        try {
          ws.close(4404, 'нет такого файла')
        } catch {
          /* уже закрыт */
        }
        return
      }
      handleFileSocket(ws, sessionId, wanted, effectiveRole(req, payload), payload.participantId)
    } else {
      /*
       * A participant token carries the role it was minted with. A teacher who
       * joined before signing in — or who created the seminar in the admin
       * panel, which never handed out a host token at all — holds a
       * 'participant' token for a room that is theirs, and interrupt and
       * restart were dead for the whole seminar as a result. Staff on this
       * instance are exactly who those controls are for; the cookie is a
       * stronger credential than the token and it is re-checked here on every
       * reconnect rather than baked into anything.
       */
      handleControlSocket(ws, sessionId, { ...payload, role: effectiveRole(req, payload) })
    }
  })
})

/* --------------------------------------------------------------- lifecycle */

server.listen(config.port, () => {
  const ai = aiEnabled() ? `on (${config.ai.model})` : 'off'
  console.log(
    `colloq ready — open ${config.publicUrl} · ai ${ai} · jupyter ${config.jupyter.url}`,
  )
  announceSetupToken()
})

/**
 * The entire onboarding story, printed by the only thing that can see it.
 *
 * An unclaimed instance has exactly one way in, and the panel deliberately
 * never shows the token back — so if this line is not readable and actionable
 * on its own, nobody gets in without reading documentation. It prints on every
 * boot while the instance is unclaimed, not only the boot that minted the file:
 * the operator who scrolled past it yesterday needs it again today, and it
 * stops the moment someone claims the instance.
 */
function announceSetupToken(): void {
  if (isClaimed()) return
  console.log(
    [
      '',
      '  ┌ nobody owns this Colloq yet',
      `  │ open  ${config.publicUrl}/admin/t/${readSetupToken()}`,
      '  │ then type your name and email — that makes you the owner, and everyone',
      '  │ else teaching here gets a personal sign-in link from you.',
      '  │',
      // The link carries the token, so it is not a URL to paste into a chat.
      // Saying so next to it is cheaper than explaining it afterwards.
      '  │ That link IS the key to this instance. Do not share it, and do not',
      '  │ leave it on screen while the room is watching.',
      `  └ the token alone is in ${setupTokenPath} (0600). Keep it: it is also the`,
      '    way back in if an owner ever loses their link.',
      '',
    ].join('\n'),
  )
}

let stopping = false

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`\ncolloq shutting down (${signal})`)

  const force = setTimeout(() => {
    console.warn('colloq: shutdown timed out, exiting anyway')
    process.exit(1)
  }, SHUTDOWN_GRACE_MS)

  server.close()
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutting down')
    } catch {
      client.terminate()
    }
  }

  // Snapshots first: an unsaved notebook is the only thing here that cannot be
  // rebuilt. Kernels are disposable, and shutting them down may involve HTTP.
  try {
    shutdownCollab()
  } catch (err) {
    console.error('colloq: could not flush notebooks:', err instanceof Error ? err.message : err)
  }
  try {
    await shutdownKernels()
  } catch (err) {
    console.error('colloq: could not stop kernels:', err instanceof Error ? err.message : err)
  }
  /*
   * Последним: база закрывается по-настоящему.
   *
   * Раньше процесс просто уходил через process.exit, и журнал WAL оставался
   * лежать рядом: `colloq.db` остановленного инстанса был вчерашним, а весь
   * день — в файле, который никто не копирует. db.close() сводит журнал и
   * закрывает файл, то есть делает ровно то, чего ждут от «остановлено».
   */
  try {
    closeDatabase()
  } catch (err) {
    console.error('colloq: could not close the database:', err instanceof Error ? err.message : err)
  }

  clearTimeout(force)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// A stray rejection from a kernel or model call must not end the class.
process.on('unhandledRejection', (err: unknown) => {
  console.error('colloq: unhandled rejection:', err instanceof Error ? (err.stack ?? err.message) : err)
})

/*
 * Необработанное исключение — не то же, что отвергнутое обещание.
 *
 * Обещание можно проглотить: где-то не дождались ответа, семинар от этого не
 * ломается. Исключение, дошедшее сюда, оставляет процесс в состоянии, о
 * котором никто ничего не знает, — а по умолчанию node в этом случае просто
 * умирает молча, без единой строки о причине. Пишем причину и уходим с
 * ненулевым кодом: перезапуск честнее, чем сервер, про который неизвестно,
 * работает ли он.
 */
process.on('uncaughtException', (err: unknown) => {
  console.error('colloq: uncaught exception:', err instanceof Error ? (err.stack ?? err.message) : err)
  try {
    shutdownCollab()
  } catch {
    // Снимки — последнее, что можно попробовать спасти, и не повод не выйти.
  }
  process.exit(1)
})
