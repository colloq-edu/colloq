import {tr} from '@shared/i18n'
import { kernelBackend, requireKernelIsolation, kernelRuntimeClient, loadRuntimeCatalog, runtimeDefaultEnvironment } from './kernel/runtime-client.js'
/**
 * Приложение целиком: middleware, маршруты, статика — и ничего про процесс.
 *
 * Жило в index.ts вперемешку с сокетами и сигналами, и это стоило покрытия:
 * импортировать index.ts значит поднять сервер на порту, поэтому тесты
 * собирали свой express и КОПИРОВАЛИ в него порядок middleware — «тот же
 * порядок, что в index.ts», говорил комментарий над копией. Копия порядка не
 * ловит расхождения с оригиналом; она их повторяет. Здесь порядок один, его
 * монтируют и продукт, и тест.
 *
 * Сокеты, `listen`, сигналы и уборка остаются в index.ts: у процесса своя
 * жизнь, и она не должна начинаться от одного `import`.
 */
import path from 'node:path'
import zlib from 'node:zlib'
import express, { type NextFunction, type Request, type Response } from 'express'
import { sameOrigin, slideStaffCookie } from './admin/auth.js'
import { markDevice } from './bans.js'
import { aiEnabled, config } from './config.js'
import { db } from './db.js'
import { activeName, listEnvironments } from './environments.js'
import { SECURITY_HEADERS } from './headers.js'
import { jupyterReachable } from './kernel/jupyter.js'
import { isolationAvailable } from './kernel/pool.js'
import { tally } from './log.js'
import { adminAuthRoutes } from './routes/admin-auth.js'
import { adminEnvironmentRoutes } from './routes/admin-environments.js'
import { adminImportRoutes } from './routes/admin-import.js'
import { adminInstanceRoutes } from './routes/admin-instance.js'
import { aiRoutes } from './routes/ai.js'
import { banRoutes } from './routes/bans.js'
import { councilRoutes } from './routes/council.js'
import { courseRoutes } from './routes/courses.js'
import { fileRoutes } from './routes/files.js'
import { historyRoutes } from './routes/history.js'
import { sessionRoutes } from './routes/sessions.js'
import { instanceSettingsRoutes } from './routes/instance-settings.js'
import { PUBLIC_PAGES_INDEXED } from '@shared/publish'

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

/*
 * Одно приложение на процесс, собранное при загрузке модуля.
 *
 * Фабрикой оно быть не может по-честному: маршрутизаторы ниже держат состояние
 * инстанса — базу, ядра, окружения, — и второй экземпляр рядом был бы не
 * «ещё одним приложением», а вторым владельцем тех же таблиц. Кому нужен
 * настоящий порядок middleware — тесты, стенд, `http.createServer` — берут
 * этот.
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
 * Готов ли Python, которым будет пользоваться комната, — а не тот, что рядом.
 *
 * При изоляции (KERNEL_ISOLATION=auto и живой docker) у каждой комнаты свой
 * контейнер из образа `colloq-kernel:<окружение>`, и общего ядра compose не
 * трогает никто. Здоровье спрашивало именно его: несобранный образ активного
 * окружения давал зелёный ответ над инстансом, где не поднимется ни одна
 * комната, а упавшее ядро compose — красный над инстансом, где всё работает.
 *
 * Ответ кэшируется на те же пять секунд, что и проба Jupyter: `docker image
 * inspect` — это процесс, а зонд ходит сюда раз в секунду.
 *
 * И кэша мало: он пишется, только когда проверка ВЕРНУЛАСЬ. Пока docker жив,
 * это доли секунды; когда демон завис — восемь секунд таймаута на каждое
 * окружение, и всё это время кэш пуст, а зонд стучит раз в секунду. Каждый
 * следующий запрос запускал ту же пачку `docker image inspect` заново, и на
 * машине, где идёт пара, накапливались десятки процессов — ровно тогда, когда
 * ей и без того плохо. Поэтому здесь ещё и проверка в полёте: пришедший вторым
 * ждёт чужой ответ, а не заводит свой.
 */
let kernelProbe: { at: number; ok: boolean; reason: string | null } | null = null
let kernelProbing: Promise<{ ok: boolean; reason: string | null }> | null = null

async function kernelHealth(): Promise<{ ok: boolean; reason: string | null }> {
  const now = Date.now()
  if (kernelProbe && now - kernelProbe.at < 5000)
    return { ok: kernelProbe.ok, reason: kernelProbe.reason }
  // Не `await` до этой строки: между стартом проверки и её регистрацией не
  // должно быть ни одной точки, где второй запрос увидит «никто не проверяет».
  if (kernelProbing) return kernelProbing
  const probe = probeKernel().finally(() => {
    kernelProbing = null
  })
  kernelProbing = probe
  return probe
}

async function probeKernel(): Promise<{ ok: boolean; reason: string | null }> {
  // Общее ядро compose кэша не заводит: у `jupyterReachable` он свой, на те же
  // пять секунд, и второй копии здесь взяться неоткуда.
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
    // builtAt, а не state: «правили список после сборки» — это повод пересобрать,
    // а не причина отказаться начинать пару на прежнем образе.
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
 * «Здоров» значит «здесь можно вести семинар».
 *
 * Раньше значило «процесс отвечает», и этого хватало, чтобы host.sh и
 * `make status` напечатали «Colloq доступен по ссылке» над инстансом, где
 * Docker выключен со вчера: комната открывается, ссылка работает, а первый Run
 * через семьдесят секунд отвечает KERNEL DEAD. Проверяются обе вещи, без
 * которых семинара не будет: своя база и Python комнаты.
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
      const kernel = await kernelHealth()
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
        /*
         * Адрес, который сервер сейчас пишет в ссылки, — вслух.
         *
         * `config.publicUrl` — геттер: он перечитывает .env не чаще раза в две
         * секунды, и до этой строки узнать, доехал ли новый адрес, было нечем.
         * `scripts/host.sh` под WHO=service ставил на это место `sleep 3` —
         * единственный сон в скрипте, поставленный не потому, что чего-то
         * ждут, а потому, что спросить было некого.
         */
        publicUrl: config.publicUrl,
      })
    })()
  })
})
/*
 * Ничего с чужой страницы не пишет — нигде, а не только в панель.
 *
 * Печенье выдаётся с sameSite: 'lax', и браузер не приложит его к межсайтовому
 * POST — но это правило браузера, а не сервера, и держится оно до первой машины
 * со старым браузером или расширением, которое решает за него.
 *
 * Проверка стояла под `/api/admin`, хотя тем же `colloq_staff` авторизуются
 * записи и вокруг: создание семинара, загрузка и удаление файлов комнаты,
 * прерывание и перезапуск ядра, выдача пульта. Там держал один SameSite —
 * ровно то правило браузера, ради недоверия к которому проверка и заведена.
 * Поэтому она на всём `/api`: помнить о ней на каждом новом маршруте дороже,
 * чем поставить один раз на входе.
 *
 * GET/HEAD/OPTIONS не трогаем: читать с чужой страницы всё равно нечего —
 * CORS-заголовков сервер не ставит, и ответ туда не попадёт. Запрос без Origin
 * — это curl или сам сервер (`make host` ходит в собственный API), и им
 * отказывать нельзя; проверяется только присланный.
 */
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  sameOrigin(req, res, next)
})
/*
 * Печенье штата продлевается работой — здесь, а не в `requireStaff`.
 *
 * Месяц отсчитывался от входа и не двигался ни одним маршрутом, так что на
 * тридцать первый день преподаватель посреди пары становился участником своей
 * комнаты (см. `slideStaffCookie`). Продлевает ЛЮБОЙ запрос к API, а не только
 * панельный: половина работы идёт мимо панели — комната, файлы, ядро.
 *
 * После проверки происхождения: продлевать по запросу, который мы только что
 * решили не выполнять, — значит держать подпись живой чужой страницей.
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
app.use(adminInstanceRoutes())
app.use(courseRoutes())
app.use(adminEnvironmentRoutes())
app.use(adminImportRoutes())
app.use(sessionRoutes())
// Двери бана — сразу за входом: они про тех же людей и живут по тому же праву
// (routes/bans.ts), а проверку, которую они заводят, делает bans.ts на входе.
app.use(banRoutes())
app.use(historyRoutes())
app.use(fileRoutes())
app.use(aiRoutes())
// Консилиум — за оракулом: его единственная REST-дверь спрашивает ту же модель
// и тратит тот же лимит вопросов комнаты (routes/council.ts).
app.use(councilRoutes())

app.use('/api', (_req, res) => res.status(404).json({ error: tr('common.notFound') }))

/* ------------------------------------------------------------- индексация */

/*
 * Что закрыто от поисковика — одним решением на все носители.
 *
 * Комната открывается по персональной ссылке и живёт часы, а страница входа в
 * панель — это форма с почтой на молодом домене: для робота поисковика ровно
 * то, чем торгуют фишеры. Google однажды пометил colloq.ru целиком как
 * опасный, и красный экран увидели бы студенты на каждом семинарском адресе.
 *
 * Про опубликованные страницы решает не этот файл: решение записано одной
 * копией в `shared/publish.ts` (`PUBLIC_PAGES_INDEXED`), и тем же оно правит
 * `<meta name="robots">` у выгрузки на Pages (publish/render.ts). Пока правило
 * жило в комментариях по обе стороны, они успели разойтись: статика ставила
 * `noindex`, а здесь было написано, что публикации «индексируются как раньше:
 * их для того и публикуют», — одна и та же страница вела себя по-разному в
 * зависимости от того, каким адресом её открыли. Лендинг открыт и остаётся
 * открыт.
 *
 * Снаружи блока статики, хотя раньше жило внутри: индексация — это политика
 * инстанса, а не свойство собранного фронтенда. В прямом режиме и в разработке
 * STATIC_DIR пуст, и вместе со статикой пропадали и robots.txt, и заголовок.
 */
const NOINDEX_PATHS = PUBLIC_PAGES_INDEXED
  ? ['/s/', '/admin']
  : ['/s/', '/admin', '/p/', '/c/']
const NOINDEX = new RegExp(
  `^/(${NOINDEX_PATHS.map((p) => p.replace(/^\/|\/$/g, '')).join('|')})(/|$)`,
)

/*
 * Свой robots.txt — на случай, когда ретранслятора перед нами нет.
 *
 * За ретранслятором такой же отдаёт он сам, до туннеля; в прямом режиме
 * (`make host-direct`) его некому отдать, кроме нас.
 */
app.get('/robots.txt', (_req, res) => {
  res
    .type('text/plain')
    .send(`User-agent: *\n${NOINDEX_PATHS.map((path) => `Disallow: ${path}`).join('\n')}\n`)
})

/*
 * Заголовок, а не только `Disallow`: закрытый в robots.txt адрес поисковик всё
 * равно вправе показать в выдаче по чужой ссылке — `noindex` это уже ответ, а
 * не просьба не заходить.
 */
app.use((req, res, next) => {
  if (NOINDEX.test(req.path)) res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  next()
})

if (config.staticDir) {
  const staticDir = path.resolve(config.staticDir)
  /*
   * Версионное — это `assets/`, и только оно.
   *
   * Vite штампует хэш в имя всего, что собирает, и складывает это в assets/;
   * всё остальное в dist приезжает из web/public как есть, под именем, которое
   * выбрал человек. Рядом с проверкой каталога стоял регэксп «дефис и восемь
   * знаков» — и `hse-sans-400.woff2` попадал под него («-sans-400»), хотя
   * никакого хэша в имени нет. Шрифт института уходил с `immutable` на год:
   * заменить начертание или сам шрифт под тем же именем и дождаться этого у
   * вернувшихся браузеров было нельзя — до очистки кэша руками. Каталог
   * отвечает на тот же вопрос и не ошибается.
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
     * Метка устройства ставится здесь — на отдаче самой страницы.
     *
     * Это единственный ответ, который наверняка едет в браузер, а не в fetch:
     * ставить куку на API-запрос значило бы не поставить её тем, кому страницу
     * отдал не этот процесс. Метка переживает чистку хранилища и перезаход, но
     * не инкогнито — и большего от неё не ждут (server/src/bans.ts).
     */
    markDevice(req, res)
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

/**
 * Клиент ушёл, не дослушав.
 *
 * `res.sendFile` на оборванном запросе отдаёт Error('Request aborted') с
 * `code: 'ECONNABORTED'` и без статуса (express, response.js: sendfile), а
 * body-parser на оборванном теле — ошибку с `type: 'request.aborted'`. Обе
 * доезжали до ветки «internal error» ниже и печатали стек на четыре строки.
 * Это студент, закрывший вкладку до конца загрузки: на потоке в пятьсот
 * человек таких строк сотни, и настоящая поломка тонет между ними.
 */
function clientLeft(err: unknown, res: Response): boolean {
  const failed = err as { code?: unknown; type?: unknown } | null
  // Эти два кода рождаются ровно там и только там: `ECONNABORTED` — в sendfile
  // самого express, `request.aborted` — в body-parser. Спутать их не с чем.
  if (failed?.code === 'ECONNABORTED' || failed?.type === 'request.aborted') return true
  /*
   * А вот ECONNRESET и EPIPE сами по себе ничего не значат: тем же кодом
   * отвечает оборвавшееся ИСХОДЯЩЕЕ соединение — к ядру, к оракулу, — и
   * молчаливо проглотить такую значило бы спрятать настоящую поломку сервера
   * за словами про ушедшего студента. Поэтому у них спрашивают ещё и сокет:
   * если писать уже некуда, ушёл действительно клиент.
   */
  if (failed?.code === 'ECONNRESET' || failed?.code === 'EPIPE') return !res.writable
  return false
}

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err)
  /*
   * Оборванный запрос не пишется в журнал вовсе — только в счётчик минуты.
   *
   * Из двух разрешённых вариантов («одна спокойная строка» или «молча») выбран
   * второй: сервер тут ничего не делал и делать не может, а число ушедших
   * посреди загрузки всё равно видно в сводке строкой `aborted N` — там оно
   * даже полезнее, потому что рядом стоит, сколько в эту минуту было людей.
   * Отвечать тоже некому: сокета уже нет, и `res.status(500)` уходил в пустоту.
   */
  if (clientLeft(err, res)) {
    tally('aborted')
    // Своя сторона всё равно закрывается: на живом сокете это пустой ответ, на
    // мёртвом — ничего, а висящий без ответа запрос express не разбирает сам.
    res.end()
    return
  }
  // express.json rejects malformed bodies with an HTML error page by default,
  // which the browser's JSON-only client cannot read.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: tr('common.badJson') })
  }
  /*
   * Отказ клиенту — это отказ клиенту, а не поломка сервера.
   *
   * body-parser отвергает слишком большое тело ошибкой с `status: 413`
   * (`entity.too.large`), а неизвестную кодировку — с 415, и ни та ни другая не
   * SyntaxError: обе доезжали до ветки ниже, то есть до 500 «internal error» и
   * стека в журнале. Преподаватель, импортирующий тетрадь с картинками, видел
   * «The server failed» вместо «слишком большой файл», а журнал — испуг на
   * ровном месте. 4xx с внятной строкой отдаём как есть; 5xx оставляем ниже.
   */
  const failed = err as { status?: unknown; statusCode?: unknown; type?: unknown } | null
  const status = failed?.status ?? failed?.statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Use a translated public message; exception details may contain host paths.
    return res
      .status(status)
      .json({ error: status === 413 ? tr('common.bodyTooLarge') : tr('common.badRequest') })
  }
  // Со стеком и с путём: без них строка в журнале говорит «что-то сломалось»
  // и не говорит где — а именно за этим в журнал и лезут.
  console.error(
    `[http] unhandled error on ${req.method} ${req.originalUrl}:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  )
  res.status(500).json({ error: tr('common.internalError') })
})
