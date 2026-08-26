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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    let message = res.statusText
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
    request<{ participants: Participant[]; online: string[] }>(
      `/api/sessions/${id}/participants`,
    ),

  listFiles: (id: string) => request<{ files: FileEntry[] }>(`/api/sessions/${id}/files`),

  uploadFiles: async (id: string, files: File[], token: string) => {
    const form = new FormData()
    for (const file of files) form.append('file', file, file.name)
    return request<{ files: FileEntry[] }>(`/api/sessions/${id}/files`, {
      method: 'POST',
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })
  },

  deleteFile: (id: string, name: string, token: string) =>
    request<{ files: FileEntry[] }>(`/api/sessions/${id}/files/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),

  fileUrl: (id: string, name: string) =>
    `/api/sessions/${id}/files/${encodeURIComponent(name)}`,

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
