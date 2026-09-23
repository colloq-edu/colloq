import { tr } from '@shared/i18n'
/**
 * Staff credentials: the setup token, and the cookie both sign-in paths spend
 * themselves for.
 *
 * See shared/admin.ts for why there is no password here. This module is the
 * server half of that decision.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import { config, ensureDataDir } from '../config.js'
import { countStaff, getTeacher, linkKeyOf } from './store.js'
import { STAFF_COOKIE, type AdminErrorBody, type Teacher } from '@shared/admin'

const SETUP_TOKEN_FILE = path.join(config.dataDir, 'setup-token')
/**
 * Месяц — но месяц БЕЗ РАБОТЫ, а не месяц от входа: см. `slideStaffCookie`.
 *
 * Столько живёт подпись, скопированная из браузера куда-нибудь ещё; активная
 * вкладка продлевает себя сама.
 */
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Раз в сутки — шаг продления: чаще незачем, реже уже не спасает семестр. */
const COOKIE_SLIDE_AFTER_MS = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------ setup token */

function loadSetupToken(): string {
  try {
    const existing = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* first boot, or someone deleted it to force a new one */
  }
  const token = crypto.randomBytes(24).toString('base64url')
  ensureDataDir()
  // 0600 up front rather than a chmod afterwards: there must be no instant at
  // which the file that owns this instance is world-readable.
  fs.writeFileSync(SETUP_TOKEN_FILE, token + '\n', { mode: 0o600 })
  return token
}

let setupToken = loadSetupToken()

export function readSetupToken(): string {
  return setupToken
}

/**
 * Выписать новый токен установки и выбросить старый.
 *
 * Токен подписывает вошедшего как самого старого владельца и печатается
 * `make host` при каждом запуске — то есть живёт в истории терминала, в
 * скриншотах проектора и в чатах, куда его пересылали. Отозвать его было
 * нечем: файл можно было удалить руками, но об этом не сказано нигде, а
 * инструкция «rotate it when someone leaves» относилась к ссылкам
 * преподавателей и про этот токен молчала.
 *
 * Записывается через временный файл и rename: иначе между открытием и записью
 * есть мгновение, когда токена нет ни старого, ни нового, и запуск в этот
 * момент завёл бы третий.
 */
export function rotateSetupToken(): string {
  const token = crypto.randomBytes(24).toString('base64url')
  const tmp = `${SETUP_TOKEN_FILE}.new`
  ensureDataDir()
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 })
  fs.renameSync(tmp, SETUP_TOKEN_FILE)
  setupToken = token
  return token
}

export const setupTokenPath = SETUP_TOKEN_FILE

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  // Lengths leak through timingSafeEqual's own throw, so they are checked first
  // and deliberately: the length of a random token is not the secret.
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

export function verifySetupToken(token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false
  return constantTimeEqual(token.trim(), setupToken)
}

/** True once anyone has claimed the instance; the claim route is closed after that. */
export function isClaimed(): boolean {
  return countStaff() > 0
}

/* ----------------------------------------------------------------- cookie */

interface StaffCookieBody {
  tid: string
  iat: number
}

/**
 * The signing message is `<body>.<link_key>`, keyed by the instance secret.
 *
 * Putting the person's own link key inside the message is what lets this
 * instance revoke a session without a session table: rotating a link or
 * deleting the row changes (or removes) the second half of the message, so
 * every cookie ever minted for that person stops verifying on the next request.
 * A shared-secret-only signature would have needed a revocation list to do the
 * same thing, and a revocation list is a table nobody remembers to prune.
 */
function sign(body: string, linkKey: string): string {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${body}.${linkKey}`)
    .digest('base64url')
}

/** Six lines instead of cookie-parser; this is the only cookie the server reads. */
function readCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    /*
     * Кривая печенька — это не печенька, а не повод бросить исключение.
     *
     * `decodeURIComponent('%')` бросает URIError, и здесь это стоило процесса:
     * ту же функцию зовёт разбор роли на рукопожатии сокета, где никакого
     * try/catch над колбэком нет, — так что `Cookie: colloq_staff=%` от любого
     * участника доходил до uncaughtException и клал весь инстанс со всеми
     * комнатами. Значение всё равно обязано быть подписью, которая не сойдётся.
     */
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

/**
 * Secure would make the cookie undeliverable on a self-hosted http instance.
 *
 * По схеме ЭТОГО запроса, а не по PUBLIC_URL. Считалось по PUBLIC_URL, и пока
 * `make host` держит туннель, вход с айпада по адресу вида http://192.168.1.5
 * выдавал печенье с Secure: браузер его молча не сохранял, панель мелькала и
 * тут же отвечала 401 — экран входа без единого слова о причине. Тот же
 * неверный признак попадал и в clearCookie, то есть в обратном случае выход из
 * панели её не удалял. PUBLIC_URL остаётся тем, чем и был, — адресом для ссылок.
 *
 * `res.req`, а не отдельный параметр: печенье выдают шесть маршрутов и три
 * стенда, а express кладёт запрос на ответ сам. Подделка без него (тесты,
 * скрипты) читается как http — там его и нет.
 *
 * Вынесено наружу ради печенья участника соревнований (competitions/identity.ts):
 * правило одно, и вторая его копия разошлась бы с этой молча — ровно так, как
 * когда-то разошлись выдача и удаление.
 */
export function secureCookie(res: Response): boolean {
  const req = res.req as Request | undefined
  if (!req) return false
  if (req.secure) return true
  // За ретранслятором сервер видит http всегда — https знает только caddy, и
  // говорит об этом единственным способом, который у него есть.
  const forwarded = req.get?.('x-forwarded-proto') ?? ''
  return forwarded.split(',')[0].trim().toLowerCase() === 'https'
}

export function issueStaffCookie(res: Response, teacher: Teacher): void {
  const body = Buffer.from(JSON.stringify({ tid: teacher.id, iat: Date.now() } satisfies StaffCookieBody)).toString(
    'base64url',
  )
  const value = `${body}.${sign(body, linkKeyOf(teacher.id) ?? '')}`
  res.cookie(STAFF_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
    secure: secureCookie(res),
  })
}

export function clearStaffCookie(res: Response): void {
  // The attributes must match the ones it was set with or the browser keeps it.
  res.clearCookie(STAFF_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: secureCookie(res),
  })
}

export function currentStaff(req: Request): Teacher | null {
  return staffFromCookieHeader(req.headers.cookie)
}

/**
 * The same check against a raw Cookie header. The WebSocket upgrade never sees
 * an express Request, and interrupt/restart have to be answerable there.
 */
export function staffFromCookieHeader(header: string | undefined): Teacher | null {
  return readStaffCookie(header)?.teacher ?? null
}

/** То же самое, но с датой выпуска: её читает продление. */
function readStaffCookie(header: string | undefined): { teacher: Teacher; iat: number } | null {
  const raw = readCookieHeader(header, STAFF_COOKIE)
  if (!raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const body = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)

  let parsed: StaffCookieBody
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StaffCookieBody
  } catch {
    return null
  }
  if (typeof parsed?.tid !== 'string' || typeof parsed?.iat !== 'number') return null
  // Max-Age is the browser's promise, not a guarantee; the server ages the
  // cookie out itself so a copied value cannot outlive its month.
  if (Date.now() - parsed.iat > COOKIE_MAX_AGE_MS) return null

  const teacher = getTeacher(parsed.tid)
  if (!teacher) return null
  if (!constantTimeEqual(sig, sign(body, linkKeyOf(teacher.id) ?? ''))) return null
  return { teacher, iat: parsed.iat }
}

/**
 * Печенье продлевается работой — иначе месяц отсчитывался от ВХОДА.
 *
 * `iat` ставился один раз и не двигался, а переиздания не было ни в одном
 * маршруте. Для вошедшего первого сентября это значит первое октября: середина
 * семестра, пара идёт, и на первом же переподключении сокета `roleFor` не
 * находит подписи — преподаватель становится участником собственной комнаты.
 * Замки, перезапуск ядра, пульт исчезают без единого слова, панель отвечает
 * 401, а семинары, заведённые из панели, хост-токена никому не выдавали:
 * запасного пути нет, нужна личная ссылка, которая у половины «где-то в чате».
 *
 * Продление — не удлинение: месяц остаётся месяцем, но месяцем без работы.
 * Скопированное куда-то значение стареет ровно так же, потому что стареет оно
 * там, где им не пользуются.
 *
 * Ставится один раз на весь `/api` (см. app.ts), а не в `requireStaff`:
 * половина работы преподавателя идёт мимо панели — комната, файлы, ядро.
 */
export function slideStaffCookie(req: Request, res: Response): void {
  const seen = readStaffCookie(req.headers.cookie)
  if (!seen) return
  if (Date.now() - seen.iat < COOKIE_SLIDE_AFTER_MS) return
  issueStaffCookie(res, seen.teacher)
}

/* ------------------------------------------------------------- middleware */

function deny(res: Response, status: number, reason: AdminErrorBody['reason'], error: string): void {
  const body: AdminErrorBody = { error, reason }
  res.status(status).json(body)
}

/**
 * Своё происхождение, а не чужое.
 *
 * Печенье выдаётся с `sameSite: 'lax'`, и этого уже почти хватает: браузер не
 * приложит его к межсайтовому POST. «Почти» — потому что это правило браузера,
 * а не сервера, и держится оно ровно до первой машины со старым браузером или
 * расширением, которое решает за него.
 *
 * Заголовок Origin в межсайтовом запросе обязателен, в своём — совпадает с
 * хостом. Запрос без него — это curl или сам сервер, и отказывать им нельзя:
 * `make host` ходит в собственный API. Проверяется поэтому только присланный.
 *
 * Ставится на всё, что пишет, включая выход: выкинутый из панели посреди
 * семинара преподаватель — это не «всего лишь logout», а комната без хозяина.
 * «Всё» здесь буквально — весь `/api`, а не одна панель (см. app.ts): тем же
 * печеньем авторизуются загрузка файлов в комнату, перезапуск ядра и выдача
 * пульта, и до этой строки их прикрывал только SameSite.
 */
export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin')
  if (!origin) return next()
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return deny(res, 403, 'forbidden', tr("server.requestBlockedThisPageUsesADifferent.dd9b4b"))
  }
  // req.host отбрасывает порт, а он здесь значимый: 5173 и 8080 — разные сайты.
  const reqHost = req.get('host') ?? ''
  if (host !== reqHost && !(thisMachine(reqHost) && (thisMachine(host) || host === tunnelHost()))) {
    return deny(res, 403, 'forbidden', tr("server.requestBlockedThisPageUsesADifferent.dd9b4b"))
  }
  next()
}

/**
 * Публичный адрес локального занятия, если туннель его сейчас держит.
 *
 * Туннель `colloq start --share` приходит к серверу с Host 127.0.0.1:<порт>
 * (scripts/host.sh · --http-host-header), а страница шлёт Origin своего
 * адреса *.trycloudflare.com. Без этой строки каждый POST с публичного адреса
 * получал «другой адрес сервера» — и ссылка входа с токеном не входила.
 * Чужой сайт этим не пройдёт: Origin должен совпасть с тем адресом, который
 * сервер сам раздаёт как свой (config.publicUrl — аренда туннеля).
 */
function tunnelHost(): string | null {
  try {
    const url = new URL(config.publicUrl)
    return thisMachine(url.host) ? null : url.host
  } catch {
    return null
  }
}

/**
 * Два адреса на этой же машине — это `npm run dev`, а не чужой сайт.
 *
 * Страницу в разработке отдаёт Vite со своего порта, а его прокси переписывает
 * Host на адрес сервера (changeOrigin) — сравнивать после этого нечего, и
 * панель отвечала 403 на КАЖДУЮ запись, включая сам вход: в dev-сборке в неё
 * нельзя было попасть вовсе, хотя README обещает работу через прокси.
 *
 * Уступка тут ровно нулевая: для браузера localhost:5173 и localhost:3000 —
 * один сайт (SameSite смотрит на имя, а не на порт), так что печенье с `lax`
 * и без этой строки поехало бы с таким запросом. Настоящий инстанс живёт на
 * имени или на адресе в сети, и для него правило прежнее.
 */
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i

function thisMachine(hostPort: string): boolean {
  return LOOPBACK.test(hostPort.replace(/:\d+$/, ''))
}

export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const teacher = currentStaff(req)
  if (!teacher) return deny(res, 401, 'unauthenticated', tr("server.signInToUseTheAdminPanel.301d28"))
  next()
}

/**
 * Owner-only, with the refusal saying what was refused. The message reaches a
 * teacher who just pressed a button, so "only an owner can change the staff
 * list" on a route that deletes a seminar would be a sentence about the wrong
 * thing — and being told the wrong reason is worse than being told none.
 */
export function ownerOnly(action: string) {
  return function requireOwnerFor(req: Request, res: Response, next: NextFunction): void {
    const teacher = currentStaff(req)
    if (!teacher) return deny(res, 401, 'unauthenticated', tr("server.signInToUseTheAdminPanel.301d28"))
    if (teacher.role !== 'owner') return deny(res, 403, 'forbidden', tr('server.ownerOnly', { action: tr(action) }))
    next()
  }
}

/** The staff list is what an owner owns, so it is the default subject. */
export const requireOwner = ownerOnly('server.ownerAction.0')
