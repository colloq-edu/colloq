
/**
 * Reading the room's history from the browser.
 *
 * The list is small and is fetched whole — a ninety-minute seminar produces a
 * few dozen rows, and paging something that fits on one screen costs a round
 * trip to save nothing. What is *not* fetched eagerly is any version's content:
 * that arrives when somebody clicks a row, and stays in a map afterwards, so
 * walking back up the timeline over versions already opened costs nothing.
 */
import type { CellDiff, HistoricCell, Version, VersionList } from '@shared/history'
import { request } from './api'
import { initials } from './utils'

export interface VersionDetail {
  version: Version
  cells: HistoricCell[]
  diffs: CellDiff[]
}

/**
 * The same as `api.request`, only with the participant's key in a header.
 *
 * There used to be a `fetch` of its own here with its own refusal parsing — a
 * second copy of the same work, differing by exactly this header, which
 * `request` accepts through `init.headers` anyway. The copy managed to fall
 * behind: the `retryAfter` and `until` fields, by which a wait and a ban are
 * told from a breakage, never made it into it.
 */
function get<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  })
}

/**
 * The room's timeline — and the sign that its beginning was not kept.
 *
 * The response shape is taken from `shared/history.ts` (`VersionList`) rather
 * than described here anew: the server already carries `trimmed`
 * (routes/history.ts · `historyTrimmed`), and a third copy of the same shape
 * would drift from it exactly as the second did — the field was silently lost
 * on the way to the panel.
 */
export function listVersions(sessionId: string, token: string): Promise<VersionList> {
  return get(`/api/sessions/${sessionId}/history`, token)
}

export function readVersion(sessionId: string, seq: number, token: string): Promise<VersionDetail> {
  return get(`/api/sessions/${sessionId}/history/${seq}`, token)
}

export function restoreVersion(
  sessionId: string,
  seq: number,
  token: string,
  cellId?: string,
): Promise<{ restored: number }> {
  return get(`/api/sessions/${sessionId}/history/${seq}/restore`, token, {
    method: 'POST',
    body: JSON.stringify(cellId ? { cellId } : {}),
  })
}

export function setCheckpoint(
  sessionId: string,
  label: string,
  token: string,
): Promise<{ seq: number }> {
  return get(`/api/sessions/${sessionId}/history/checkpoint`, token, {
    method: 'POST',
    body: JSON.stringify({ label }),
  })
}

/** "18:24" — the same blackboard stamp the poster uses, not a localised date. */
export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The initials on the row's circle.
 *
 * The same two letters as on the avatar and in the people list — `initials`
 * from lib/utils and nothing of its own. There used to be rules of its own
 * here: the first and SECOND letters versus the first and LAST, so "Ivan
 * Petrovich Sidorov" got "IP" in the version feed, and "IS" on his own avatar
 * right next to it. One person, one screen, two monograms.
 *
 * Only an empty name differs: in the feed that is not a person but the room
 * itself — its own entries — and instead of a question mark the row draws a
 * dot. More honest: not "someone unknown" but "nobody".
 */
export function initialsOf(name: string | null): string {
  if (!name?.trim()) return ''
  return initials(name)
}

/** The word for a version that has no author: the room did it, not a person. */
export const NOBODY = "the room"
