/**
 * Reading the room's history from the browser.
 *
 * The list is small and is fetched whole — a ninety-minute seminar produces a
 * few dozen rows, and paging something that fits on one screen costs a round
 * trip to save nothing. What is *not* fetched eagerly is any version's content:
 * that arrives when somebody clicks a row, and stays in a map afterwards, so
 * walking back up the timeline over versions already opened costs nothing.
 */
import type { CellDiff, HistoricCell, Version } from '@shared/history'
import { ApiError, statusMessage } from './api'

export interface VersionDetail {
  version: Version
  cells: HistoricCell[]
  diffs: CellDiff[]
}

async function get<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch (cause: unknown) {
    // То же, что и в api.ts: «Failed to fetch» — фраза из отладчика, а по
    // HTTP/2 у отказа ещё и пустая строка состояния. Панель истории рисует
    // ошибку через `{#if}`, и пустая строка не рисуется вовсе.
    if (cause instanceof TypeError) {
      throw new ApiError('Could not reach the server — check the connection and try again.', 0)
    }
    throw cause
  }
  if (!res.ok) {
    let message = statusMessage(res)
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status)
  }
  return (await res.json()) as T
}

export function listVersions(sessionId: string, token: string): Promise<{ versions: Version[] }> {
  return get(`/api/sessions/${sessionId}/history`, token)
}

export function readVersion(
  sessionId: string,
  seq: number,
  token: string,
): Promise<VersionDetail> {
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
 * Two letters from two words, one from a single word. A name nobody typed —
 * the server's own writes — has none, and the row shows a dot instead, which
 * is honest: nobody did it.
 */
export function initialsOf(name: string | null): string {
  if (!name) return ''
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** The word for a version that has no author: the room did it, not a person. */
export const NOBODY = 'the room'
