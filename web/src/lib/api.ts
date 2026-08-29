import type {
  AiAskRequest,
  AiAskResponse,
  CreateSessionResponse,
  FileEntry,
  JoinRequest,
  JoinResponse,
  Participant,
  SessionInfo,
} from '@shared/protocol'
import type { RoomRules } from '@shared/rules'
import type { PublicCourseView, PublicSeminar, PublicStep } from '@shared/publish'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * Что сказать, когда сервер не сказал ничего.
 *
 * HTTP/2 отменил строку состояния — `res.statusText` там пустая всегда, а не
 * иногда. Ошибка, у которой нет тела с полем error, доезжала до экрана пустой
 * строкой, а `{#if error}` пустую строку не показывает: отказ выглядел как
 * будто ничего не произошло. Код есть всегда, и назвать его — уже лучше, чем
 * промолчать.
 */
export function statusMessage(res: Response): string {
  if (res.statusText) return res.statusText
  if (res.status === 401) return 'Not signed in (401)'
  if (res.status === 403) return 'Not allowed (403)'
  if (res.status === 404) return 'Not found (404)'
  if (res.status === 413) return 'Too large (413)'
  if (res.status === 429) return 'Too many requests (429)'
  if (res.status >= 500) return `The server failed (${res.status})`
  return `The request failed (${res.status})`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...init?.headers,
      },
    })
  } catch (cause: unknown) {
    /*
     * fetch отвергает обещание TypeError'ом со словами «Failed to fetch» —
     * фразой из отладчика, а не для человека, и одинаковой для упавшего
     * сервера, оборванного вайфая и закрытого туннеля. Ни одного из этих
     * случаев она не называет; сказать, что связь пропала, честнее.
     */
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

export const api = {
  createSession: (name: string) =>
    request<CreateSessionResponse>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  getSession: (id: string) => request<SessionInfo>(`/api/sessions/${id}`),

  join: (id: string, body: JoinRequest) =>
    request<JoinResponse>(`/api/sessions/${id}/join`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Everyone who has ever joined, newest activity first. */
  listParticipants: (id: string) =>
    request<{ participants: Participant[]; online: string[] }>(`/api/sessions/${id}/participants`),

  /**
   * Правила комнаты — из самой комнаты.
   *
   * Накладывается на текущее на сервере: экран, трогающий одну строку, не
   * должен уметь молча вернуть остальные к умолчаниям.
   */
  /* --------------------------------------------------- публичное чтение */

  /**
   * Курс и опубликованный семинар — без токена и без входа.
   *
   * Отдельные адреса, а не `/api/sessions/...`: у публикации свой
   * идентификатор именно затем, чтобы ссылка «на почитать» не открывала живую
   * комнату.
   */
  course: (id: string) => request<{ course: PublicCourseView }>(`/api/c/${id}`),

  publication: (id: string) => request<{ seminar: PublicSeminar }>(`/api/p/${id}`),

  step: (id: string, seq: number | null) =>
    request<{ step: PublicStep }>(`/api/p/${id}/step/${seq === null ? 'first' : seq}`),

  setRoomRules: (id: string, token: string, rules: Partial<RoomRules>) =>
    request<{ rules: RoomRules }>(`/api/sessions/${id}/rules`, {
      method: 'PATCH',
      body: JSON.stringify({ rules }),
      headers: { authorization: `Bearer ${token}` },
    }),

  listFiles: (id: string, token: string) =>
    request<{ files: FileEntry[] }>(`/api/sessions/${id}/files`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  uploadFiles: async (id: string, files: File[], token: string) => {
    const form = new FormData()
    for (const file of files) form.append('file', file, file.name)
    return request<{ files: FileEntry[] }>(`/api/sessions/${id}/files`, {
      method: 'POST',
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })
  },

  deleteFile: (id: string, path: string, token: string) =>
    request<{ files: FileEntry[] }>(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),

  /*
   * The token rides in the query string because this URL ends up in an
   * <a href download>, and an anchor cannot send a header. It is the same
   * seminar-scoped credential the rest of the panel already uses.
   */
  /**
   * A download link, good for this one file for five minutes.
   *
   * Two steps rather than one because an `<a href download>` cannot carry a
   * header: the session token goes up in a header to fetch a ticket, and only
   * the ticket rides in the URL. The link used to carry the session token
   * itself, which meant "copy link address" into a group chat handed every
   * reader the control socket under the teacher's name.
   */
  fileTicket: (id: string, path: string, token: string) =>
    request<{ token: string }>(`/api/sessions/${id}/file/ticket?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  /*
   * Путь — в строке запроса, а не в адресе, и так везде в продукте: косая черта
   * внутри имени живёт в адресе только как `%2F`, а его по дороге разворачивает
   * то один прокси, то другой.
   */
  fileUrl: (id: string, path: string, ticket: string) =>
    `/api/sessions/${id}/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(ticket)}`,

  /**
   * Тот же файл, но без билета в строке запроса — для читалки.
   *
   * Билет нужен якорю: `<a download>` не умеет отправить заголовок. Читалка
   * ходит сама и отправляет токен заголовком, поэтому адрес чистый — а pdf.js
   * по нему запрашивает документ кусками и показывает первую страницу, не
   * дожидаясь последней.
   */
  fileRaw: (id: string, path: string) =>
    `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`,

  /** `mode` is what the server actually enforces; `enabled` is `mode !== 'off'`. */
  aiStatus: () =>
    request<{ enabled: boolean; model: string; mode: 'full' | 'hints' | 'off' }>('/api/ai/status'),

  /**
   * Fire-and-forget. The server appends the question to the shared document and
   * streams the answer into it, so there is nothing to read from this response:
   * the asker's browser watches the CRDT like everyone else's does.
   */
  aiAsk: (id: string, token: string, body: AiAskRequest) =>
    request<AiAskResponse>(`/api/sessions/${id}/ai/ask`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Open to anyone present: a runaway answer is on every screen in the room. */
  aiCancel: (id: string, token: string, entryId: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/ai/cancel`, {
      method: 'POST',
      body: JSON.stringify({ entryId }),
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Host only — the transcript belongs to the room. Rejected with 403 otherwise. */
  aiClearThread: (id: string, token: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/ai/thread`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),
}
