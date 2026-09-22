/**
 * Клиент дверей `/api/k` — всё, что спрашивают страницы соревнований.
 *
 * Свой, а не `lib/api.ts` и не `lib/adminApi.ts`, ровно по той же границе, по
 * которой разведены двери на сервере: у комнаты запрос подписан токеном
 * участника занятия, у панели — печеньем преподавателя, а здесь — печеньем
 * участника соревнования, и ни одно из трёх не должно случайно оказаться на
 * чужой двери. Общего у них только разбор отказа, и он в каждом свой потому,
 * что тела отказов разные: здесь это `{error, reason}` с `CompetitionRefusal`,
 * и `reason` — то, на что ветвится экран (поле ключа после `key_disabled`
 * предлагает спросить новый, зона загрузки после `quota` гаснет до завтра).
 */
import { tr } from '@shared/i18n'
import type { CompetitionRefusal } from '@shared/competitions'
import type {
  EntrantCompetitionList,
  EntrantCompetitionView,
  EntrantLeaderboard,
  EntrantMe,
  EntrantSubmissions,
  SubmissionAccepted,
} from '@shared/competitions-entrant'

import type { DependencyOverview, DependencyBundle } from '@shared/dependencies'

const BASE = '/api/k'

export class EntrantApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `network` — сети не было вовсе; остальное называет сервер. */
    readonly reason: CompetitionRefusal | 'network',
  ) {
    super(message)
  }
}

function reasonForStatus(status: number): CompetitionRefusal {
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  return 'invalid'
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      // Печенье участника — HttpOnly, и браузер не прикладывает его сам даже
      // на свой же адрес: без этой строки каждая дверь отвечала бы «войдите».
      credentials: 'include',
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...init?.headers,
      },
    })
  } catch (cause: unknown) {
    // «Failed to fetch» — фраза из отладчика, одинаковая для упавшего сервера,
    // оборванного вайфая и закрытого туннеля. Ни одного из них она не называет.
    if (cause instanceof TypeError) {
      throw new EntrantApiError(tr('common.networkError'), 0, 'network')
    }
    throw cause
  }
  if (!res.ok) {
    let message = tr('common.requestFailed', { status: res.status })
    let reason = reasonForStatus(res.status)
    try {
      const body = (await res.json()) as { error?: string; reason?: CompetitionRefusal }
      if (body?.error) message = body.error
      if (body?.reason) reason = body.reason
    } catch {
      /* тело отказа не json — остаётся фраза по коду */
    }
    throw new EntrantApiError(message, res.status, reason)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return (await res.json()) as T
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const entrantApi = {
  /* ------------------------------------------------------------ личность */

  me: () => request<EntrantMe>('/me'),
  signIn: (key: string) => request<EntrantMe>('/sign-in', json({ key })),
  signOut: () => request<{ ok: boolean }>('/sign-out', { method: 'POST' }),

  /* -------------------------------------------------------- соревнования */

  list: () => request<EntrantCompetitionList>('/competitions'),
  competition: (slug: string) =>
    request<EntrantCompetitionView>(`/competitions/${encodeURIComponent(slug)}`),
  join: (slug: string, name: string) =>
    request<EntrantMe>(`/competitions/${encodeURIComponent(slug)}/join`, json({ name })),
  leaderboard: (slug: string) =>
    request<EntrantLeaderboard>(`/competitions/${encodeURIComponent(slug)}/leaderboard`),

  /* -------------------------------------------------------------- посылки */

  submissions: (slug: string) =>
    request<EntrantSubmissions>(`/competitions/${encodeURIComponent(slug)}/submissions`),

  /**
   * Отправка тетради — многочастным телом, без нашего `content-type`.
   *
   * Границу многочастного тела знает только браузер, и подписанное нами
   * `application/json` превратило бы загрузку в запрос, который сервер
   * разобрать не может (та же причина, что у `sendForm` в adminApi).
   */
  send: (slug: string, file: File, bundleId?: string | null) => {
    const form = new FormData()
    form.append('file', file, file.name)
    if (bundleId) form.append('bundleId', bundleId)
    return request<SubmissionAccepted>(`/competitions/${encodeURIComponent(slug)}/submissions`, {
      method: 'POST',
      body: form,
    })
  },

  choose: (slug: string, id: string) =>
    request<EntrantSubmissions>(
      `/competitions/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(id)}/choose`,
      { method: 'POST' },
    ),

  cancel: (slug: string, id: string) =>
    request<EntrantSubmissions>(
      `/competitions/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
    ),

  dependencies: (slug: string) => request<DependencyOverview>(`/competitions/${encodeURIComponent(slug)}/dependencies`),
  dependencyDraft: (slug: string, requirementsText: string, selectedBundleId?: string | null) =>
    request<DependencyOverview>(`/competitions/${encodeURIComponent(slug)}/dependencies/draft`, {
      method: 'PUT', body: JSON.stringify({ requirementsText, selectedBundleId }),
    }),
  prepareDependencies: (slug: string, requirementsText: string) =>
    request<{ bundle: DependencyBundle }>(`/competitions/${encodeURIComponent(slug)}/dependencies/prepare`, json({ requirementsText })),
  dependencyBundle: (slug: string, id: string) =>
    request<DependencyBundle>(`/competitions/${encodeURIComponent(slug)}/dependencies/${encodeURIComponent(id)}`),
  cancelDependencies: (slug: string, id: string) =>
    request<DependencyBundle>(`/competitions/${encodeURIComponent(slug)}/dependencies/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  dependencyStreamUrl: (slug: string, id: string) => `${BASE}/competitions/${encodeURIComponent(slug)}/dependencies/${encodeURIComponent(id)}/stream`,
  dependencyLockUrl: (slug: string, id: string) => `${BASE}/competitions/${encodeURIComponent(slug)}/dependencies/${encodeURIComponent(id)}/lock`,

  /* ---------------------------------------------------------------- адреса */

  /** Адрес живого потока (`EventSource`), а не сам поток: его открывает экран. */
  streamUrl: (slug: string) => `${BASE}/competitions/${encodeURIComponent(slug)}/stream`,

  /** Файл открытых данных — ссылкой, чтобы скачивал браузер, а не мы. */
  fileUrl: (slug: string, name: string) =>
    `${BASE}/competitions/${encodeURIComponent(slug)}/files/${encodeURIComponent(name)}`,

  /** Своя тетрадь: исполненная, а до конца прогона — присланная. */
  notebookUrl: (slug: string, id: string) =>
    `${BASE}/competitions/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(id)}/notebook`,
}
