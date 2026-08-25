/**
 * Identity without accounts.
 *
 * A participant is remembered in localStorage, keyed by session, so a refresh
 * (or a laptop lid closing mid-seminar) drops the student straight back in
 * rather than back at the name prompt.
 */
import type { Participant, SessionInfo } from '@shared/protocol'

const KEY = 'colloq.identity.v1'
const HOST_KEY = 'colloq.host.v1'
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

export function forgetIdentity(sessionId: string): void {
  const map = readMap()
  delete map[sessionId]
  writeMap(map)
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

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- host */

type HostMap = Record<string, { token: string; session: SessionInfo }>

function readHosts(): HostMap {
  try {
    const raw = localStorage.getItem(HOST_KEY)
    return raw ? (JSON.parse(raw) as HostMap) : {}
  } catch {
    return {}
  }
}

export function saveHostToken(session: SessionInfo, token: string): void {
  const map = readHosts()
  map[session.id] = { token, session }
  try {
    localStorage.setItem(HOST_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export function loadHostToken(sessionId: string): string | null {
  return readHosts()[sessionId]?.token ?? null
}

/** Sessions this browser created, newest first — the teacher's landing page. */
export function listHostedSessions(): SessionInfo[] {
  return Object.values(readHosts())
    .map((entry) => entry.session)
    .sort((a, b) => b.createdAt - a.createdAt)
}
