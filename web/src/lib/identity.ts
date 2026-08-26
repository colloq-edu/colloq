/**
 * Identity without accounts.
 *
 * A participant is remembered in localStorage, keyed by session, so a refresh
 * (or a laptop lid closing mid-seminar) drops the student straight back in
 * rather than back at the name prompt.
 */
import type { Participant, SessionInfo } from '@shared/protocol'

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
