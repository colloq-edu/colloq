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
 * Forget who this browser was in this room.
 *
 * Needed exactly when the saved identity has stopped working: the key lives
 * thirty days, but after SESSION_SECRET changes it stops verifying at once, and
 * both sockets are rejected at the handshake. While the entry lies here, App
 * enters with it, bypassing the name form — that is, the reload the room
 * itself recommends returns the person to the same "Reconnecting" forever.
 *
 * The profile (name and mark) stays: one will have to introduce oneself again,
 * but not retype it.
 */
export function forgetIdentity(sessionId: string): void {
  const map = readMap()
  if (!(sessionId in map)) return
  delete map[sessionId]
  writeMap(map)
}

/* ------------------------------------------ why we are not let into the room */

/**
 * Four different answers to "why does the socket not open", and mixing them
 * up is costly.
 *
 *   • `gone`    — the room no longer exists. The local copy of the notebook
 *                 can be erased.
 *   • `banned`  — the teacher closed the entrance. The room is in place, the
 *                 person is expected tomorrow, and their identity must NOT be
 *                 touched.
 *   • `expired` — the room does not recognise this browser's key. Introduce
 *                 yourself again.
 *   • `unknown` — we do not know. So behave as on a dropped connection.
 *
 * The last one is the whole point: while `unknown` did not exist, any vague
 * refusal counted as a stale key, and a banned person after a reload read "the
 * seat has expired", lost their identity in the room and the next day entered
 * as a new participant — with detached council attempts and authorship in the
 * oracle feed.
 */
export type EntryVerdict =
  | { why: 'gone' }
  | { why: 'banned'; until: number }
  | { why: 'expired' }
  | { why: 'unknown' }

/**
 * The room answered about our key — what that means.
 *
 * The key is valid, yet we are not let in — that is `unknown`, not "all is
 * well": the socket may have hit the connection ceiling or a race during a
 * server restart, and that is cured by the next attempt, not by the name form.
 *
 * The moment the ban ends travels with the verdict: the "you were removed from
 * the class" screen shows not "not allowed now" but "opens at such-and-such
 * time", and there is nowhere to make a second request for that number.
 */
export function verdictOf(me: SessionMe): EntryVerdict {
  if (me.ban) return { why: 'banned', until: me.ban.until }
  return me.tokenValid ? { why: 'unknown' } : { why: 'expired' }
}

/**
 * The room did not answer — what that means.
 *
 * `gone` — only when the server said it in OUR words (`saysSessionMissing`). A
 * bare 404 comes from a relay without a connected frpc, from static hosting
 * that serves index.html for everything, and from a server build that does not
 * have this door yet; it once erased the whole class's offline typing.
 *
 * A 403 with a deadline is a ban, and it is read here too. The `/me` door
 * exists precisely to answer a banned person, and the shared `banDoor` must
 * not be hung on it — but if one day it is hung there after all, the answer
 * will come as a refusal with a deadline in the body, and the person will
 * still read about the ban rather than about an expired seat.
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
