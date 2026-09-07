/**
 * Identity without accounts.
 *
 * A participant is remembered in localStorage, keyed by session, so a refresh
 * (or a laptop lid closing mid-seminar) drops the student straight back in
 * rather than back at the name prompt.
 */
import {
  saysSessionMissing,
  type Participant,
  type SessionInfo,
  type SessionMe,
} from '@shared/protocol'

const KEY = 'colloq.identity.v1'
const PROFILE_KEY = 'colloq.profile.v1'

export interface StoredIdentity {
  sessionId: string
  participantId: string
  token: string
  name: string
  avatar: string | null
  color: string
  role: Participant['role']
}

type IdentityMap = Record<string, StoredIdentity>

function readMap(): IdentityMap {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as IdentityMap) : {}
  } catch {
    return {}
  }
}

function writeMap(map: IdentityMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* private browsing; the student just re-enters their name */
  }
}

export function loadIdentity(sessionId: string): StoredIdentity | null {
  return readMap()[sessionId] ?? null
}

export function saveIdentity(identity: StoredIdentity): void {
  const map = readMap()
  map[identity.sessionId] = identity
  writeMap(map)
  saveProfile({ name: identity.name, avatar: identity.avatar })
}

/**
 * Забыть, кем этот браузер был в этой комнате.
 *
 * Нужно ровно тогда, когда сохранённая личность перестала работать: ключ живёт
 * тридцать дней, а после смены SESSION_SECRET перестаёт проверяться сразу, и
 * оба сокета отвергаются на рукопожатии. Пока запись лежит здесь, App входит
 * по ней мимо формы имени — то есть перезагрузка, которую комната сама и
 * советует, возвращает человека в то же самое «Reconnecting» навсегда.
 *
 * Профиль (имя и метка) остаётся: назваться придётся заново, но не набирать.
 */
export function forgetIdentity(sessionId: string): void {
  const map = readMap()
  if (!(sessionId in map)) return
  delete map[sessionId]
  writeMap(map)
}

/* ------------------------------------------- почему нас не пускают в комнату */

/**
 * Четыре разных ответа на «почему сокет не открывается», и путать их дорого.
 *
 *   • `gone`    — комнаты больше нет. Местную копию тетради можно стирать.
 *   • `banned`  — вход закрыл преподаватель. Комната на месте, человека ждут
 *                 завтра, и личность его трогать НЕЛЬЗЯ.
 *   • `expired` — ключ этого браузера комната не признаёт. Назваться заново.
 *   • `unknown` — мы не знаем. Значит — вести себя как при обрыве связи.
 *
 * Последний и есть вся суть: пока `unknown` не существовал, любой невнятный
 * отказ считался протухшим ключом, и забаненный после перезагрузки читал «место
 * истекло», терял свою личность в комнате и на следующий день входил новым
 * участником — с отвязанными попытками консилиума и авторством в ленте оракула.
 */
export type EntryVerdict =
  | { why: 'gone' }
  | { why: 'banned'; until: number }
  | { why: 'expired' }
  | { why: 'unknown' }

/**
 * Комната ответила про наш ключ — что это значит.
 *
 * Ключ годен, а нас не пускают, — это `unknown`, а не «всё в порядке»: сокет
 * мог упереться в потолок соединений или в гонку при перезапуске сервера, и
 * лечится это следующей попыткой, а не формой имени.
 *
 * Момент конца бана едет вместе с вердиктом: экран «вас удалили с занятия»
 * показывает не «сейчас нельзя», а «откроется тогда-то», и второго запроса за
 * этим числом делать неоткуда.
 */
export function verdictOf(me: SessionMe): EntryVerdict {
  if (me.ban) return { why: 'banned', until: me.ban.until }
  return me.tokenValid ? { why: 'unknown' } : { why: 'expired' }
}

/**
 * Комната не ответила — что это значит.
 *
 * `gone` — только когда сервер сказал это НАШИМИ словами (`saysSessionMissing`).
 * Голый 404 приезжает и от ретранслятора без подключённого frpc, и от статики,
 * отдающей index.html на всё подряд, и от сборки сервера, у которой этой двери
 * ещё нет; по нему когда-то стирался офлайн-набор у всего класса.
 *
 * 403 со сроком — это бан, и читается он здесь тоже. Дверь `/me` заведена ровно
 * затем, чтобы отвечать забаненному, и вешать на неё общий `banDoor` нельзя, —
 * но если её однажды туда всё-таки повесят, ответ придёт отказом со сроком в
 * теле, и человек всё равно прочитает про бан, а не про истёкшее место.
 */
export function verdictOnFailure(error: unknown): EntryVerdict {
  if (saysSessionMissing(error)) return { why: 'gone' }
  const { status, until } = (error ?? {}) as { status?: unknown; until?: unknown }
  if (status === 403 && typeof until === 'number' && Number.isFinite(until)) {
    return { why: 'banned', until }
  }
  return { why: 'unknown' }
}

/** Last used name/avatar, so joining a second seminar is one click. */
export interface Profile {
  name: string
  avatar: string | null
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (raw) return JSON.parse(raw) as Profile
  } catch {
    /* ignore */
  }
  return { name: '', avatar: null }
}

function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- host */

/*
 * The host token has no client side any more.
 *
 * It was minted by POST /api/sessions and kept here so the browser that created
 * a seminar could prove ownership after a refresh — machinery for a home screen
 * that no longer exists. Seminars are made in the panel now and staff are
 * recognised by their cookie, so nothing ever wrote to this store and every
 * read came back empty. The server still accepts a host token on join, which is
 * how a seminar created straight against the API can hand ownership to someone.
 */

/* ---------------------------------------------------------------- staff */

/**
 * A hint that this browser has signed in to the teaching side.
 *
 * It authorises nothing — the staff cookie is HttpOnly and the server is the
 * only thing that can read it. This exists so the join screen can tell, without
 * a request, whether it is worth ASKING who the visitor is. Students never have
 * it, so they never pay for the question, and the answer is still the server's.
 */
const STAFF_KEY = 'colloq.staff.v1'

export function markStaff(): void {
  try {
    localStorage.setItem(STAFF_KEY, '1')
  } catch {
    /* private browsing: the teacher just fills the form, as before */
  }
}

export function clearStaffMark(): void {
  try {
    localStorage.removeItem(STAFF_KEY)
  } catch {
    /* ignore */
  }
}

export function mightBeStaff(): boolean {
  try {
    return localStorage.getItem(STAFF_KEY) === '1'
  } catch {
    return false
  }
}
