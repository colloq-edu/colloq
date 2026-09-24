/**
 * The client of the `/api/k` doors — everything the competition pages ask.
 *
 * Its own, not `lib/api.ts` and not `lib/adminApi.ts`, along exactly the same
 * border along which the doors are separated on the server: a room request is
 * signed with a class participant's token, a panel one with the teacher's
 * cookie, and here with a competition entrant's cookie, and none of the three
 * must accidentally end up at someone else's door. All they share is refusal
 * parsing, and each has its own because the refusal bodies differ: here it is
 * `{error, reason}` with `CompetitionRefusal`, and `reason` is what the screen
 * branches on (after `key_disabled` the key field offers to ask for a new one,
 * after `quota` the upload zone goes dark until tomorrow).
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
    /** `network` — there was no network at all; the server names the rest. */
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
      // The entrant's cookie is HttpOnly, and the browser does not attach it by
      // itself even to its own origin: without this line every door would answer
      // "sign in".
      credentials: 'include',
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...init?.headers,
      },
    })
  } catch (cause: unknown) {
    // "Failed to fetch" is a debugger phrase, the same for a crashed server, a
    // dropped Wi-Fi and a closed tunnel. It names none of them.
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
      /* the refusal body is not JSON — the phrase by status code stays */
    }
    throw new EntrantApiError(message, res.status, reason)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return (await res.json()) as T
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const entrantApi = {
  /* ------------------------------------------------------------ identity */

  me: () => request<EntrantMe>('/me'),
  signIn: (key: string) => request<EntrantMe>('/sign-in', json({ key })),
  signOut: () => request<{ ok: boolean }>('/sign-out', { method: 'POST' }),

  /* -------------------------------------------------------- competitions */

  list: () => request<EntrantCompetitionList>('/competitions'),
  competition: (slug: string) =>
    request<EntrantCompetitionView>(`/competitions/${encodeURIComponent(slug)}`),
  join: (slug: string, name: string) =>
    request<EntrantMe>(`/competitions/${encodeURIComponent(slug)}/join`, json({ name })),
  leaderboard: (slug: string) =>
    request<EntrantLeaderboard>(`/competitions/${encodeURIComponent(slug)}/leaderboard`),

  /* ---------------------------------------------------------- submissions */

  submissions: (slug: string) =>
    request<EntrantSubmissions>(`/competitions/${encodeURIComponent(slug)}/submissions`),

  /**
   * Sending a notebook — as a multipart body, without our `content-type`.
   *
   * Only the browser knows the multipart boundary, and an `application/json`
   * label from us would turn the upload into a request the server cannot
   * parse (the same reason as for `sendForm` in adminApi).
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

  /* ------------------------------------------------------------- addresses */

  /** The live stream's address (`EventSource`), not the stream: the screen opens it. */
  streamUrl: (slug: string) => `${BASE}/competitions/${encodeURIComponent(slug)}/stream`,

  /** A public data file — as a link, so that the browser downloads it, not us. */
  fileUrl: (slug: string, name: string) =>
    `${BASE}/competitions/${encodeURIComponent(slug)}/files/${encodeURIComponent(name)}`,

  /** One's own notebook: the executed one, and until the run finishes — the one sent. */
  notebookUrl: (slug: string, id: string) =>
    `${BASE}/competitions/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(id)}/notebook`,
}
