import { tr } from '@shared/i18n'
/**
 * Бан: кнопка «закрыть доступ» и всё, на что она опирается.
 *
 * Аккаунтов в продукте нет, поэтому опереться можно на две метки, и обе
 * дырявые: идентификатор участника лежит у человека в localStorage, метка
 * устройства — в куке. Инкогнито даёт чистый браузер, и герметичности здесь
 * никто не обещает. Обещается другое, ровно то, что нужно на паре: ленивый
 * возврат — та же вкладка, тот же браузер, обновлённая страница — не проходит,
 * а тот, кто вернулся всерьёз, приходит новым человеком, и это видно
 * преподавателю в списке.
 *
 * Адрес запроса пишется в бан только как подсказка «кажется, вернулся» и в
 * проверке не участвует НИКОГДА: за одним NAT сидит вся аудитория.
 *
 * Схема таблицы — в db.ts, рядом с остальными таблицами комнаты; здесь запросы
 * к ней, кука устройства и правило про просроченные строки.
 */
import crypto from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { Request, Response } from 'express'
import { staffFromCookieHeader } from './admin/auth.js'
import { db, deviceOfParticipant, getParticipant } from './db.js'
import type { Ban } from '@shared/protocol'

/**
 * Сутки.
 *
 * Столько, чтобы хватило на остаток пары и на вечер после неё, и при этом
 * бан не доживал до следующего занятия: снимать его руками преподаватель не
 * обязан, а прийти на следующей неделе в комнату, из которой тебя закрыли
 * месяц назад, человек должен.
 */
export const BAN_MS = 24 * 60 * 60 * 1000

/* --------------------------------------------------------- кука устройства */

export const DEVICE_COOKIE = 'colloq_device'
/** Метке незачем жить меньше: она переживает и семестр, и чистку хранилища. */
const DEVICE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000
/** 24 байта — ровно 32 символа base64url. Длина у метки одна и та же всегда. */
const DEVICE_SHAPE = /^[A-Za-z0-9_-]{32}$/

/** Шесть строк вместо cookie-parser; печенек у этого сервера две. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    /*
     * Без decodeURIComponent, в отличие от разбора преподавательской печеньки:
     * в значении 32 символа алфавита base64url, экранировать там нечего, а
     * `decodeURIComponent('%')` бросает URIError — и эту цену уже платили
     * (admin/auth.ts · readCookieHeader), потому что ту же функцию зовут на
     * рукопожатии сокета, где перехвата над колбэком нет.
     */
    return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * Метка браузера из запроса, или null.
 *
 * Испорченная или чужая кука — это отсутствие метки, а не метка: иначе в базу
 * и в проверку уехала бы строка любой длины, которую прислал кто угодно.
 * Отсутствие метки — обычное дело: человек здесь впервые, или страницу отдал
 * не этот сервер (в разработке её отдаёт Vite). Ничего подозрительного в этом
 * нет, и обращаться с таким гостем надо как с новым.
 */
export function deviceOf(cookieHeader: string | undefined): string | null {
  const raw = readCookie(cookieHeader, DEVICE_COOKIE)
  return raw && DEVICE_SHAPE.test(raw) ? raw : null
}

/**
 * Secure — по схеме ЭТОГО запроса, а не по PUBLIC_URL.
 *
 * То же правило и по той же причине, что у преподавательской печеньки
 * (admin/auth.ts · secureCookie): пока `make host` держит адрес наружу, вход с
 * айпада по http://192.168.1.5 получал бы куку с Secure, браузер молча не
 * сохранял бы её — и метка устройства не заводилась бы вовсе, тихо и навсегда.
 * За ретранслятором сервер видит http всегда, и про https говорит caddy
 * единственным способом, который у него есть.
 */
function secureCookie(req: Request): boolean {
  if (req.secure) return true
  const forwarded = req.get?.('x-forwarded-proto') ?? ''
  return forwarded.split(',')[0].trim().toLowerCase() === 'https'
}

/**
 * Пометить браузер, если он ещё не помечен, и вернуть метку.
 *
 * Зовётся на отдаче страницы приложения — там, где ответ идёт в браузер, а не
 * в fetch: кука, поставленная на API-запрос, доедет не до всех (страницу в
 * разработке отдаёт Vite со своего адреса).
 */
export function markDevice(req: Request, res: Response): string {
  const known = deviceOf(req.headers.cookie)
  if (known) return known
  const device = crypto.randomBytes(24).toString('base64url')
  res.cookie(DEVICE_COOKIE, device, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_MAX_AGE_MS,
    secure: secureCookie(req),
  })
  return device
}

/* ------------------------------------------------------------------ адрес */

/** Петля — это прокси на этой же машине, а не студент. */
const LOOPBACK = /^(?:::1|(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

/**
 * Адрес, с которого пришёл запрос, — исключительно ради подсказки в списке
 * банов.
 *
 * За ретранслятором сервер видит петлю: caddy на VPS отдаёт запрос в frps, тот
 * — клиенту на этой машине, и до Colloq он доходит с 127.0.0.1. Настоящий
 * адрес приезжает заголовком `X-Forwarded-For`, который caddy проставляет сам
 * (scripts/relay-setup.sh, scripts/host.sh).
 *
 * Верить заголовку всегда нельзя: его пишет кто угодно. На инстансе, стоящем
 * без прокси, одна строка в запросе подменила бы подсказку на чужой адрес — и
 * преподаватель прочитал бы «кажется, вернулся» про человека, который сидел
 * тихо. Поэтому заголовок принимается ровно тогда, когда сосед по сокету —
 * петля, то есть прокси на этой же машине; во всех остальных случаях адрес
 * берётся с самого соединения.
 */
export function addressOf(req: {
  headers: IncomingHttpHeaders
  socket?: { remoteAddress?: string | undefined }
}): string | null {
  const peer = req.socket?.remoteAddress ?? null
  if (peer && LOOPBACK.test(peer)) {
    /*
     * Cloudflare, если он перед нами, кладёт настоящий адрес в свой заголовок и
     * дописывает СЕБЯ в конец x-forwarded-for. Без этой строки за прокси все
     * посетители выглядят одним адресом — Cloudflare, — и подсказка «кажется,
     * вернулся» начинает указывать на всех сразу, то есть врать.
     */
    const single = (value: string | string[] | undefined): string | undefined =>
      (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim()
    const real = single(req.headers['cf-connecting-ip']) ?? single(req.headers['x-forwarded-for'])
    // 64 символа — с запасом на IPv6 с зоной; подсказка не повод хранить абзац.
    if (real) return real.slice(0, 64)
  }
  return peer
}

/* ----------------------------------------------------------------- запросы */

interface BanRow {
  id: string
  session_id: string
  participant_id: string | null
  device: string | null
  ip: string | null
  name: string
  until: number
  by_teacher: string | null
  created_at: number
}

const insertBan = db.prepare(`
  INSERT INTO bans (id, session_id, participant_id, device, ip, name, until, by_teacher, created_at)
  VALUES (@id, @session_id, @participant_id, @device, @ip, @name, @until, @by_teacher, @created_at)
`)
const dropExpired = db.prepare('DELETE FROM bans WHERE session_id = ? AND until <= ?')
const selectActive = db.prepare(
  'SELECT * FROM bans WHERE session_id = ? AND until > ? ORDER BY created_at DESC',
)
/*
 * Совпадение — по идентификатору ИЛИ по метке устройства, и ни в каком случае
 * по адресу. NULL в SQL не равен ничему, включая NULL: строка без метки не
 * ловит гостя без метки, и наоборот.
 */
const selectMatch = db.prepare(`
  SELECT id, name, until FROM bans
  WHERE session_id = ? AND until > ? AND (participant_id = ? OR device = ?)
  ORDER BY until DESC LIMIT 1
`)
const dropBan = db.prepare('DELETE FROM bans WHERE session_id = ? AND id = ?')
const dropBansOf = db.prepare('DELETE FROM bans WHERE session_id = ?')
const selectLatest = db.prepare(
  'SELECT MAX(until) AS until FROM bans WHERE session_id = ? AND until > ?',
)

/**
 * Просроченные строки убирает тот, кто следующим пришёл читать.
 *
 * Таймера нет намеренно. Сутки бана переживают и ночь простоя, и перезапуск
 * сервера, так что чистить всё равно пришлось бы при старте — то есть таймер
 * был бы вторыми часами поверх единственных настоящих, поля `until`. По нему
 * же бан и перестаёт действовать: ни секунды сверх срока строка не работает,
 * даже если её никто не убрал. А убирается она здесь, чтобы список у
 * преподавателя не копил вчерашнее.
 *
 * Зовут его только те, кто и правда читает базу: первое чтение комнаты
 * (`untilOf`) и список у преподавателя (`listBans`). Комната, про которую уже
 * известно, что ловить в ней некого, сюда не доходит вовсе — см. `untilOf`. У
 * строки, чей срок вышел без единого нового чтения, это отбирает только уборку:
 * действовать она перестала в свой `until`, а уберёт её список у преподавателя
 * или первое чтение после перезапуска.
 */
function sweep(sessionId: string): void {
  dropExpired.run(sessionId, Date.now())
}

/**
 * До какого момента в комнате есть хоть один действующий бан. `0` — ни одного.
 *
 * Кэш на комнату, как `rulesCache` в db.ts, и заведён он ради шторма: `banFor`
 * спрашивают на входе и на рукопожатии КАЖДОГО из трёх сокетов, а после
 * перезапуска сервера пятьсот вкладок возвращаются за одну-две секунды — это
 * тысяча DELETE плюс тысяча SELECT в ту самую секунду, когда все ждут возврата
 * комнаты. Каждое обращение по индексу и стоит микросекунды, но платятся они
 * там, где цикл событий занят целиком, и ни за что: в подавляющем большинстве
 * комнат банов нет вообще.
 *
 * Число, а не флаг: время само по себе баны только СНИМАЕТ, и по сроку запись
 * протухает без чьей-либо помощи — ровно тем же полем `until`, которым живёт
 * сам бан. Появиться же бан может лишь через `banParticipant` в этом процессе,
 * и там кэш и забывается; `liftBan` и `discardBans` — то же самое. Строку в
 * таблице мимо этих функций (руками в sqlite3) кэш не увидит: у продукта одна
 * дверь на запись, и она здесь.
 *
 * Цена по памяти — число на комнату, которую хоть раз спросили.
 */
const liveBans = new Map<string, number>()

function untilOf(sessionId: string): number {
  const known = liveBans.get(sessionId)
  if (known !== undefined) return known
  // Первое чтение комнаты — оно же и уборка: обещание «убирается первым же
  // чтением» держится на нём.
  sweep(sessionId)
  const row = selectLatest.get(sessionId, Date.now()) as { until: number | null } | undefined
  const until = row?.until ?? 0
  liveBans.set(sessionId, until)
  return until
}

/** Бан, действующий прямо сейчас: только то, что нужно сказать человеку. */
export interface BanInForce {
  id: string
  name: string
  until: number
}

/**
 * Действует ли бан на того, кто сейчас стучится, — и какой.
 *
 * Одна дверь на все входы: `/join` и рукопожатие каждого из трёх сокетов.
 * Порознь они бы разошлись, и разошлись бы молча — забаненный остался бы с
 * открытой тетрадью в комнате, куда его больше не пускают.
 *
 * Штат проходит любой бан. Это не вежливость к начальству: промах — забанить
 * себя со второй вкладки — не должен запирать преподавателя снаружи его
 * собственной комнаты посреди пары.
 */
export function banFor(
  sessionId: string,
  participantId: string | null,
  cookieHeader: string | undefined,
): BanInForce | null {
  if (staffFromCookieHeader(cookieHeader)) return null
  const device = deviceOf(cookieHeader)
  // Предъявить нечего — значит, и ловить нечего: это чистый браузер, и он
  // проходит. Дыра названа вслух в шапке файла.
  if (!participantId && !device) return null
  // Комната, в которой некого ловить, до базы не доходит: на шторме
  // переподключений это тысяча обращений, которых просто нет.
  if (untilOf(sessionId) <= Date.now()) return null
  sweep(sessionId)
  const row = selectMatch.get(sessionId, Date.now(), participantId, device) as
    | BanInForce
    | undefined
  return row ?? null
}

/**
 * Что сказать забаненному.
 *
 * Спокойно и по делу: кто закрыл доступ и кому — чтобы человек понял, что это
 * решение преподавателя, а не поломка комнаты. Времени в строке нет намеренно:
 * сервер в контейнере живёт по UTC, и собранное им «до 15:40» в аудитории
 * UTC+3 указывало бы не на тот час. Момент едет числом в `until`, а часы
 * рисует тот, кто смотрит, — тем же правилом живёт лента версий (db.ts ·
 * target_seq).
 */
export function banRefusal(ban: BanInForce): { error: string; until: number } {
  return {
    error: tr("server.theTeacherHasBlockedYourAccessTo.5eba21", { p0: ban.name }),
    until: ban.until,
  }
}

function toBan(row: BanRow, viewerDevice: string | null): Ban {
  return {
    id: row.id,
    name: row.name,
    until: row.until,
    createdAt: row.created_at,
    byTeacher: row.by_teacher,
    // Метка сравнивается только с непустой: два браузера без метки — это не
    // «одно и то же устройство», а два неизвестных.
    mine: row.device !== null && row.device === viewerDevice,
  }
}

/**
 * Действующие баны комнаты.
 *
 * `viewerDevice` — метка того, кто смотрит, и нужна она ровно для поля `mine`.
 */
export function listBans(sessionId: string, viewerDevice: string | null): Ban[] {
  sweep(sessionId)
  const rows = selectActive.all(sessionId, Date.now()) as BanRow[]
  // Список уже прочитал ровно то, что кэшу и нужно знать: до какого момента в
  // комнате есть кого ловить. Отдельного запроса за этим не надо.
  liveBans.set(
    sessionId,
    rows.reduce((latest, row) => Math.max(latest, row.until), 0),
  )
  return rows.map((row) => toBan(row, viewerDevice))
}

/**
 * Завести бан на сутки.
 *
 * `null` — банить некого: такого человека в комнате нет либо он в ней ведущий.
 * Второе — тот самый «штат не банится»: инвариант живёт здесь, рядом с самой
 * проверкой, а не в маршруте, где о нём однажды забудут.
 *
 * В строку едут обе метки — идентификатор и браузер, с которого человек
 * заходил последним, — плюс адрес как подсказка. Метку берём из строки
 * участника: в запросе её взять неоткуда, запрос присылает преподаватель, и
 * кука в нём его собственная.
 */
export function banParticipant(input: {
  sessionId: string
  participantId: string
  /** Только подсказка «кажется, вернулся». В проверке не участвует. */
  ip: string | null
  /** Кто забанил — имя для списка, а не идентификатор. */
  byTeacher: string | null
  /** Метка того, кто банит: нужна ответу, чтобы показать `mine`. */
  viewerDevice?: string | null
  /** Момент конца; по умолчанию — сутки от сейчас. */
  until?: number
}): Ban | null {
  const person = getParticipant(input.sessionId, input.participantId)
  if (!person || person.role === 'host') return null
  const now = Date.now()
  const row: BanRow = {
    id: 'b_' + crypto.randomBytes(9).toString('base64url'),
    session_id: input.sessionId,
    participant_id: person.id,
    device: deviceOfParticipant(input.sessionId, person.id),
    ip: input.ip,
    name: person.name,
    until: input.until ?? now + BAN_MS,
    by_teacher: input.byTeacher,
    created_at: now,
  }
  insertBan.run(row)
  // В комнате появился кого ловить — а кэш об этом знать неоткуда.
  liveBans.delete(input.sessionId)
  return toBan(row, input.viewerDevice ?? null)
}

/** Снять бан. `false` — такого бана в этой комнате нет (или он уже истёк). */
export function liftBan(sessionId: string, banId: string): boolean {
  liveBans.delete(sessionId)
  return dropBan.run(sessionId, banId).changes > 0
}

/**
 * Семинар удалили — баны уходят с ним.
 *
 * Не только ради чистоты: в строке лежит адрес, с которого человек приходил, и
 * пережить комнату он не должен.
 */
export function discardBans(sessionId: string): void {
  liveBans.delete(sessionId)
  dropBansOf.run(sessionId)
}

/* -------------------------------------------------------------- выселение */

/**
 * Кому сказать, что человека выселили прямо сейчас.
 *
 * Бан закрывает три двери: тетрадь, пульт и файл. Первые две закрывает
 * `evictBanned` (control.ts) — сокеты обеих он держит сам. Третью — файловый
 * сокет редактора — держит collab/files.ts, и позвать его оттуда напрямую было
 * бы можно: control.ts этот модуль и так импортирует, а обратно files.ts на
 * control.ts не смотрит — цикла нет. Но тогда список проводов жил бы в модуле
 * нажатий, и каждый следующий провод пришлось бы вспоминать именно там.
 * Поэтому событие объявляется здесь, в модуле бана, — там, где живёт само
 * понятие «этому человеку сюда больше нельзя», — а тот, кто держит провод,
 * подписывается на него у себя.
 *
 * Проверка на рукопожатии закрывает дверь тому, кто стучится; это — тому, кто
 * уже сидит внутри с открытым файлом.
 */
type EvictionListener = (sessionId: string, participantId: string) => void

const evictors = new Set<EvictionListener>()

export function onEviction(listener: EvictionListener): void {
  evictors.add(listener)
}

/**
 * Человека выселили — закройте его провода.
 *
 * Каждый слушатель под своим перехватом: закрытая наполовину дверь лучше, чем
 * маршрут бана, упавший на середине, — строка в базе уже стоит, и человек
 * забанен независимо от того, чей сокет не закрылся.
 */
export function evicted(sessionId: string, participantId: string): void {
  for (const listener of evictors) {
    try {
      listener(sessionId, participantId)
    } catch (err) {
      console.error(
        `[bans ${sessionId}] выселение не доехало до одного из проводов:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}
