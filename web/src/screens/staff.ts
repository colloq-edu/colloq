/**
 * "Is this staff?" — one question, one answer, one place.
 *
 * Two screens ask: App, when the browser already holds a participant
 * identity (the teacher joined by the link like everyone else and then
 * signed in to the panel), and JoinScreen, when there is no identity at all.
 * Each used to have its own code with different rules for clearing the
 * marker: one cleared it on ANY failure, including a dropped Wi-Fi, the other
 * only on an explicit refusal. The marker lives in localStorage and costs one
 * request, so one cleared by mistake means a teacher whom nobody offers to
 * sign in as themselves from the next visit on.
 *
 * There is one rule here, and it comes from the common rulebook: tell "no"
 * from "don't know". Only a server refusal (401/403 or an answer without a
 * name) clears the marker; silence, a 500 and a failed fetch leave it alone —
 * we will ask again on the next visit.
 *
 * It lives next to the two screens that ask, not in lib/: it is their shared
 * half, and it has no other readers.
 */
import { api } from '../lib/api'
import {
  clearStaffMark,
  mightBeStaff,
  saveIdentity,
  type StoredIdentity,
} from '../lib/identity'

/** The answer to "is this browser signed in on the teaching side". */
export type StaffAnswer =
  /** Yes, and here is the name it is signed in under there. */
  | { kind: 'staff'; name: string }
  /** No — the server refused explicitly. The marker can be cleared. */
  | { kind: 'no' }
  /** Don't know: the server cannot be heard, or it answered something else. */
  | { kind: 'unknown' }

/**
 * What an `/api/admin/me` answer means.
 *
 * Separate from the request, because it is exactly this table that breaks
 * silently: code 0 (the fetch did not get through) and a 503 during a server
 * restart were read as "this browser is not staff" and wiped the marker.
 */
export function readStaffAnswer(status: number, name: string | null): StaffAnswer {
  if (status === 200) return name ? { kind: 'staff', name } : { kind: 'no' }
  // No cookie, it went stale, or the role was revoked — that is an answer, not silence.
  if (status === 401 || status === 403) return { kind: 'no' }
  return { kind: 'unknown' }
}

/**
 * The name this browser is signed in under on the teaching side.
 *
 * `null` means "cannot sign in as yourself": either this is not staff, or
 * asking failed. Only this function knows the difference, and it also
 * decides the marker's fate.
 */
export async function staffName(): Promise<string | null> {
  if (!mightBeStaff()) return null
  let answer: StaffAnswer
  try {
    const res = await fetch('/api/admin/me', { credentials: 'same-origin' })
    const body = res.ok ? ((await res.json()) as { teacher?: { name?: string } }) : null
    answer = readStaffAnswer(res.status, body?.teacher?.name?.trim() || null)
  } catch {
    // No network. The marker is intact: the next visit will ask again.
    answer = { kind: 'unknown' }
  }
  if (answer.kind === 'no') clearStaffMark()
  return answer.kind === 'staff' ? answer.name : null
}

/**
 * Catch up with a role that changed after it was remembered here.
 *
 * Through an ordinary join with the saved identity: the server assigns the
 * role by its own cookie, not by this string. Returns the new identity
 * (already saved) or `null` if the server said "participant" — then the
 * marker is cleared too.
 *
 * Throws if the server cannot be heard: whoever is here keeps working as
 * whoever they were, and the next visit will ask again.
 */
export async function upgradeIfStaff(
  sessionId: string,
  me: StoredIdentity,
): Promise<StoredIdentity | null> {
  const res = await api.join(sessionId, {
    name: me.name,
    avatar: me.avatar,
    participantId: me.participantId,
    token: me.token,
  })
  if (res.participant.role !== 'host') {
    // The sign-in is gone, or there never was one. Stop asking.
    clearStaffMark()
    return null
  }
  const next: StoredIdentity = {
    sessionId,
    participantId: res.participant.id,
    token: res.token,
    name: res.participant.name,
    avatar: res.participant.avatar,
    color: res.participant.color,
    role: res.participant.role,
  }
  saveIdentity(next)
  return next
}
