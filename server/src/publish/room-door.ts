/**
 * The way from a class page (or its course row) back into the room.
 *
 * Two objects since pages exist. The publication is frozen and forwardable:
 * whoever has the link reads it, and it never names its room. The room is
 * where the class worked, and it keeps what a page does not carry: the edit
 * history, the marks, the oracle thread with every asker's name. Its eight
 * characters are also the whole right to write in it. So the page JSON never
 * holds the room id (tests/no-room-id.test.mts), and the way in is asked for
 * by a separate POST that proves who is asking.
 *
 * The proof is what a browser that was in the room already has: its
 * participant tokens (web/src/lib/identity.ts · storedTokens). The reader
 * cannot know which of them belongs to this page's room (that would need the
 * id), so it sends all of them, newest first and capped, and the server picks
 * the one that verifies for THIS room. Staff are recognised by their cookie,
 * the same way the room itself recognises them.
 */
import type { Request } from 'express'
import {
  DEFAULT_ROOM_ACCESS,
  MAX_DOOR_TOKEN_BYTES,
  MAX_DOOR_TOKENS,
  type RoomAccess,
  type RoomDoor,
} from '@shared/publish'
import { canSeeRoom } from '../admin/access.js'
import { currentStaff } from '../admin/auth.js'
import { verifyToken } from '../auth.js'
import { banFor } from '../bans.js'
import { finishedAt, getParticipant, getSession } from '../db.js'
import { isArchived } from '../routes/admin-instance.js'

/**
 * The tokens of a door request, or `null` when the body is not one.
 *
 * Refused rather than trimmed: a reader never sends more than the cap, so a
 * longer list is somebody else's script, and verifying a megabyte of HMACs
 * per request is exactly the work a public door must not take on.
 */
export function readDoorTokens(body: unknown): string[] | null {
  const raw = (body ?? {}) as { tokens?: unknown }
  if (raw.tokens === undefined) return []
  if (!Array.isArray(raw.tokens) || raw.tokens.length > MAX_DOOR_TOKENS) return null
  const tokens: string[] = []
  for (const token of raw.tokens) {
    if (typeof token !== 'string' || Buffer.byteLength(token) > MAX_DOOR_TOKEN_BYTES) return null
    tokens.push(token)
  }
  return tokens
}

/**
 * Whether one of the tokens is a participant of this room who may still come
 * in: signed by this instance, not expired, minted for this very room, a row
 * the room knows, and no ban in force on them or on this browser's device
 * mark (bans.ts · banFor, the same check every door of the room asks).
 */
export function memberOf(
  sessionId: string,
  tokens: readonly string[],
  cookie: string | undefined,
): boolean {
  for (const token of tokens) {
    const payload = verifyToken(token)
    if (!payload || payload.sessionId !== sessionId) continue
    if (!getParticipant(sessionId, payload.participantId)) continue
    if (banFor(sessionId, payload.participantId, cookie)) continue
    return true
  }
  return false
}

/**
 * The answer for one room.
 *
 * `sessionId` is `null` when there is nothing to lead to as far as the
 * caller decided (a withdrawn page, a row whose room was deleted); a room id
 * that no longer exists reads the same. Then the answer is 'none' for
 * everybody, staff included: a teacher reaches a deleted room from nowhere,
 * and a withdrawn page draws no rail at all.
 *
 * `saved` is the page's saved choice. `undefined` (a page with no saved pick,
 * a pick from before the door, a course row that has no page yet) reads as
 * DEFAULT_ROOM_ACCESS, 'anyone': with no student accounts, a token is only a
 * browser, and the class's own students on another device are who the page
 * and the «Сегодня» block are for (shared/publish.ts · DEFAULT_ROOM_ACCESS).
 *
 * Otherwise `room` is given to the room's staff always, to everyone under
 * 'anyone', and to a proven member under 'members'. Its `live` is the class
 * still on: the room exists, the class was not ended and the seminar not
 * archived.
 *
 * "The room's staff" is the staff who teach it (admin/access.ts ·
 * canSeeRoom), not the whole staff list: 'none' promises «никто, кроме
 * преподавателей», and since teachers are scoped to their courses a teacher
 * of another course is, at this door, one more reader with a link.
 */
export function roomDoor(
  req: Request,
  sessionId: string | null,
  saved: RoomAccess | undefined,
  tokens: readonly string[],
): RoomDoor {
  const access = saved ?? DEFAULT_ROOM_ACCESS
  const signedIn = currentStaff(req)
  if (!sessionId || !getSession(sessionId)) {
    return { access: 'none', member: false, staff: signedIn !== null, room: null }
  }
  const staff = canSeeRoom(signedIn, sessionId)
  const member = memberOf(sessionId, tokens, req.headers.cookie)
  const allowed = staff || access === 'anyone' || (access === 'members' && member)
  if (!allowed) return { access, member, staff, room: null }
  const live = finishedAt(sessionId) === null && !isArchived(sessionId)
  return { access, member, staff, room: { path: `/s/${sessionId}`, live } }
}
