import crypto from 'node:crypto'
import { config } from './config.js'
import { staffAuthorizationVersion } from './admin/store.js'
import type { ParticipantRole } from '@shared/protocol'

export interface TokenPayload {
  sessionId: string
  participantId: string
  role: ParticipantRole
  /**
   * When this token was minted, in milliseconds.
   *
   * There is no account system to revoke against, so a token that never
   * expires is a capability handed out for good: a student who joined in
   * September can still open the room's files in May, and a token that leaked
   * into a chat log leaked forever. An age limit is the only revocation a
   * stateless credential can have. Absent on tokens minted before this
   * existed — those are read as ageless rather than refused, because a room
   * mid-seminar must not log everybody out on deploy.
   */
  iat?: number
  /**
   * Чьей кукой этот токен получил права ведущего — при передаче пульта.
   *
   * «Ведущий по куке» намеренно никогда не пишется в строку участника: куку
   * можно отобрать, и в этом весь смысл роли (см. db.ts, столбец token_host).
   * Планшет куки не имеет, поэтому право переезжает сюда — но не насовсем:
   * `roleFor` спрашивает, состоит ли ещё этот преподаватель в штате, и с
   * удалением из списка пульт перестаёт быть пультом. Подпись покрывает поле,
   * так что вписать себе чужой id нельзя.
   */
  staff?: string
  /** Durable generation of the staff credential that granted this token. */
  staffVersion?: number
}

/**
 * How long a participant token is good for.
 *
 * A seminar is ninety minutes and a student may come back to the notebook that
 * evening; a term later they are not in that room any more. Thirty days is far
 * past any honest use and far short of forever.
 */
export const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Tokens are HMAC-signed rather than stored: there is no account system to
 * revoke against, and a seminar link is itself the capability. Signing only
 * stops a participant from claiming to be the host.
 */
export function signToken(payload: TokenPayload): string {
  const stamped: TokenPayload = {
    ...payload,
    iat: payload.iat ?? Date.now(),
    ...(payload.staff ? { staffVersion: payload.staffVersion ?? staffAuthorizationVersion(payload.staff) ?? 0 } : {}),
  }
  const body = Buffer.from(JSON.stringify(stamped)).toString('base64url')
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken(token: string | undefined | null): TokenPayload | null {
  if (!token || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof parsed?.sessionId !== 'string' || typeof parsed?.participantId !== 'string') return null
    const payload = parsed as TokenPayload
    // A signature proves who minted it, not that it is still good.
    if (typeof payload.iat === 'number' && Date.now() - payload.iat > TOKEN_MAX_AGE_MS) return null
    return payload
  } catch {
    return null
  }
}

/**
 * A credential for one file, good for minutes.
 *
 * A download is an `<a href download>` and an anchor cannot carry a header, so
 * something has to ride in the query string. It used to be the session token —
 * the same string that opens the control socket — so a teacher who copied a
 * link to `dataset.csv` into the group chat handed every student Restart,
 * Clear and Restore under their own name, for as long as the token lived.
 *
 * This one names the single file it is for and dies in five minutes: long
 * enough for the browser to follow the link, short enough that a link pasted
 * into a chat is already useless by the time anyone reads it.
 */
const DOWNLOAD_TTL_MS = 5 * 60 * 1000

export function signDownloadToken(sessionId: string, name: string): string {
  const until = Date.now() + DOWNLOAD_TTL_MS
  const body = `${sessionId}\u0000${name}\u0000${until}`
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')
  return `${until}.${sig}`
}

export function verifyDownloadToken(
  sessionId: string,
  name: string,
  token: string | undefined | null,
): boolean {
  if (!token || !token.includes('.')) return false
  const [untilRaw, sig] = token.split('.')
  const until = Number(untilRaw)
  if (!sig || !Number.isFinite(until) || Date.now() > until) return false
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${sessionId}\u0000${name}\u0000${until}`)
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Ключ, которым преподаватель отдаёт СВОЙ пульт своему же планшету.
 *
 * Задача звучит просто: вести пару с айпада, не входя на нём заново и не
 * перенося вручную ни имени, ни прав. Но токен участника в адресе — это ровно
 * то, от чего ушёл `signDownloadToken`: строка, которой открывается
 * управляющий сокет, в ссылке, которую копируют в чат.
 *
 * Поэтому в ссылке едет не токен, а ключ на обмен: он живёт десять минут,
 * годится один раз и ни для чего, кроме обмена, — по нему нельзя ни открыть
 * сокет, ни скачать файл. Планшет меняет его на обычный токен участника и
 * дальше живёт как всякий вошедший.
 *
 * Десять минут — это «дошёл до кафедры и открыл»; ссылка, забытая в чате,
 * протухает раньше, чем её прочитают.
 */
export const HANDOFF_TTL_MS = 10 * 60 * 1000

/** Кто получит пульт и чьей кукой это право держится (null — своим токеном). */
export interface HandoffHolder {
  participantId: string
  staff: string | null
}

export function signHandoffToken(
  sessionId: string,
  participantId: string,
  staff: string | null = null,
): string {
  const until = Date.now() + HANDOFF_TTL_MS
  const who = staff ? `${participantId}\u0000${staff}\u0000${staffAuthorizationVersion(staff) ?? 0}` : participantId
  const body = `handoff:${sessionId}\u0000${who}\u0000${until}`
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')
  return `${Buffer.from(who).toString('base64url')}.${until.toString(36)}.${sig}`
}

/** Кому этот ключ принадлежит — или null, если он чужой, кривой или протух. */
export function verifyHandoffToken(
  sessionId: string,
  token: string | undefined | null,
): HandoffHolder | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [who, untilRaw, sig] = parts
  const until = Number.parseInt(untilRaw, 36)
  if (!Number.isFinite(until) || Date.now() > until) return null
  let decoded: string
  try {
    decoded = Buffer.from(who, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const [participantId, staff, version] = decoded.split('\u0000')
  if (!participantId) return null
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`handoff:${sessionId}\u0000${decoded}\u0000${until}`)
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  if (staff && staffAuthorizationVersion(staff) !== (version === undefined ? 1 : Number(version))) return null
  return { participantId, staff: staff || null }
}

/**
 * Потраченные ключи — ровно до их же срока.
 *
 * «Годится один раз» было написано в трёх местах и не было правдой нигде:
 * ключ проверялся подписью и сроком, а помечать его потраченным было нечем —
 * ссылка, уехавшая не в то окно AirDrop, десять минут пускала в комнату
 * преподавателем сколько угодно устройств. Множество в памяти, а не таблица:
 * жить ему столько же, сколько ключу, а десять минут после падения процесса
 * стоят меньше, чем таблица, которую никто не чистит.
 */
const spentHandoffs = new Map<string, number>()

/**
 * Проверить ключ и тут же его погасить. Второй обмен того же ключа — null,
 * как и чужого: планшет меняет ключ ровно однажды, а копия ссылки из чата
 * приезжает к уже потраченному.
 */
export function spendHandoffToken(
  sessionId: string,
  token: string | undefined | null,
): HandoffHolder | null {
  const holder = verifyHandoffToken(sessionId, token)
  if (!holder) return null
  const now = Date.now()
  // Уборка здесь же: ключей мало, а Map иначе растёт весь семестр.
  for (const [key, until] of spentHandoffs) if (until <= now) spentHandoffs.delete(key)
  const key = `${sessionId}\u0000${token as string}`
  if (spentHandoffs.has(key)) return null
  spentHandoffs.set(key, now + HANDOFF_TTL_MS)
  return holder
}

/** Host credential handed out at session creation; proves ownership after a refresh. */
/**
 * Ключ ведущего к комнате — со сроком, как и у участника.
 *
 * Раньше подписывалось голое `host:<sessionId>`: такой ключ не старел никогда.
 * Отозвать его можно было только сбросом SESSION_SECRET, то есть выкинув из
 * всех комнат сразу всех. А живёт он там же, где живут ссылки, — в истории
 * терминала, в чате, в закладке.
 *
 * Отметка времени в самом ключе, а не рядом: подпись покрывает и её, так что
 * переписать срок нельзя, не зная секрета. Тот же тридцатидневный предел, что
 * у токена участника, и по той же причине — семестр длиннее, но семинар нет.
 */
export function signHostToken(sessionId: string): string {
  const issued = Date.now().toString(36)
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`host:${sessionId}:${issued}`)
    .digest('base64url')
  return `${sessionId}.${issued}.${sig}`
}

export function verifyHostToken(sessionId: string, token: string | undefined | null): boolean {
  if (typeof token !== 'string' || !token) return false
  const parts = token.split('.')
  /*
   * Двухчастные ключи — выданные до того, как у них появился срок.
   *
   * Принимать их значило бы оставить дыру открытой ради удобства, а отвергать
   * молча — выкинуть из своих комнат тех, кто держит вкладку со вчера. Второе
   * честнее: ключ выдаётся заново при следующем заходе через панель, а комната
   * от этого не пропадает — теряется только значок ведущего.
   */
  if (parts.length !== 3) return false
  const [claimed, issued, sig] = parts
  if (claimed !== sessionId) return false

  const at = Number.parseInt(issued, 36)
  if (!Number.isFinite(at) || Date.now() - at > TOKEN_MAX_AGE_MS) return false

  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`host:${sessionId}:${issued}`)
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function newSessionId(): string {
  // Short and unambiguous: no 0/O/1/l, so a link read aloud still works.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(8)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

export function newParticipantId(): string {
  return 'p_' + crypto.randomBytes(9).toString('base64url')
}
