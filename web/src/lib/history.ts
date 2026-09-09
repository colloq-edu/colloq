
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
 * То же, что `api.request`, только с ключом участника в заголовке.
 *
 * Здесь когда-то стоял свой `fetch` с собственным разбором отказа — второй
 * экземпляр той же работы, отличавшийся ровно этим заголовком, который
 * `request` и так принимает через `init.headers`. Копия успела отстать: поля
 * `retryAfter` и `until`, по которым отличают ожидание и бан от поломки, до неё
 * не доехали.
 */
function get<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  })
}

/**
 * Лента комнаты — и признак того, что её начало не сохранилось.
 *
 * Форма ответа взята из `shared/history.ts` (`VersionList`), а не описана
 * здесь заново: сервер уже везёт `trimmed` (routes/history.ts ·
 * `historyTrimmed`), и третья копия той же формы разошлась бы с ним ровно так
 * же, как разошлась вторая — поле молча терялось по дороге к панели.
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
 * Те же две буквы, что на аватаре и в списке людей, — `initials` из lib/utils
 * и ничего своего. Здесь были свои правила: первая и ВТОРАЯ буквы против первой
 * и ПОСЛЕДНЕЙ, так что «Иван Петрович Сидоров» получал в ленте версий «ИП», а
 * на своём же аватаре рядом — «ИС». Один человек, один экран, две монограммы.
 *
 * Отличается только пустое имя: у ленты это не человек, а сама комната — её
 * собственные записи, — и вместо вопросительного знака строка рисует точку.
 * Честнее: не «кто-то неизвестный», а «никто».
 */
export function initialsOf(name: string | null): string {
  if (!name?.trim()) return ''
  return initials(name)
}

/** The word for a version that has no author: the room did it, not a person. */
export const NOBODY = "the room"
