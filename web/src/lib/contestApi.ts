/**
 * The client of the contest doors, `/api/k/contests/…` — everything the
 * contest pages (`/a/<slug>`) and the contests on the `/k` list ask.
 *
 * A sibling of `lib/entrantApi.ts`, not a part of it, along the border the two
 * shared files draw (shared/contests-entrant.ts): the same entrant cookie and
 * the same person, but other answers and, above all, other refusals. Here a
 * refusal's `reason` is a `ContestRefusal`, and the screen branches on it — a
 * `not_joined` brings the join step back, an `attempts` refreshes the counter
 * under the send button, a `board_closed` explains the closed board instead of
 * printing an error. One parser for both kinds of words would let a contest's
 * `in_flight` arrive typed as a competition's word that means something else.
 *
 * Who the person is — `/api/k/me`, signing in with a key, signing out — stays
 * on `entrantApi`: there is one identity for competitions and contests, and
 * one client for it.
 */
import { tr } from '@shared/i18n'
import type { EntrantMe } from '@shared/competitions-entrant'
import type {
  AskBody,
  ContestQuestion,
  ContestRefusal,
  EntrantContestList,
  EntrantContestSubmissions,
  EntrantContestView,
  EntrantQuestions,
  EntrantStandings,
  EntrantSubmissionDetail,
  SubmitAccepted,
  SubmitBody,
} from '@shared/contests-entrant'

const BASE = '/api/k/contests'

export class ContestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `network` — there was no answer at all; the server names the rest. */
    readonly reason: ContestRefusal | 'network',
  ) {
    super(message)
  }
}

function reasonForStatus(status: number): ContestRefusal {
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
      // The entrant's cookie is HttpOnly and scoped to /api/k: without this the
      // browser leaves it at home and every door answers "sign in".
      credentials: 'include',
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch (cause: unknown) {
    // "Failed to fetch" names neither a dropped Wi-Fi nor a restarting server.
    if (cause instanceof TypeError) throw new ContestApiError(tr('common.networkError'), 0, 'network')
    throw cause
  }
  if (!res.ok) {
    let message = tr('common.requestFailed', { status: res.status })
    let reason = reasonForStatus(res.status)
    try {
      const body = (await res.json()) as { error?: string; reason?: ContestRefusal }
      if (body?.error) message = body.error
      if (body?.reason) reason = body.reason
    } catch {
      /* not JSON (a proxy's page): the phrase by status stays */
    }
    throw new ContestApiError(message, res.status, reason)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return (await res.json()) as T
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
const at = (slug: string): string => `/${encodeURIComponent(slug)}`

export const contestApi = {
  /** The contests section of the `/k` list. */
  list: () => request<EntrantContestList>(''),

  /** One contest's page: problems (none before the start), languages, the person's standing, the server's clock. */
  contest: (slug: string) => request<EntrantContestView>(at(slug)),

  /** The competitions' join rules and answer: the person, and the key for a newcomer. */
  join: (slug: string, name: string) => request<EntrantMe>(`${at(slug)}/join`, post({ name })),

  /* ---------------------------------------------------------- submissions */

  submissions: (slug: string) => request<EntrantContestSubmissions>(`${at(slug)}/submissions`),

  /** One own submission opened: the code, the compiler's words, what may be said of its tests. */
  submission: (slug: string, id: string) =>
    request<EntrantSubmissionDetail>(`${at(slug)}/submissions/${encodeURIComponent(id)}`),

  submit: (slug: string, body: SubmitBody) => request<SubmitAccepted>(`${at(slug)}/submissions`, post(body)),

  /* ------------------------------------------------------------ the board */

  /**
   * `class` is the projector's read: the board as the class may see it, even
   * from a teacher's signed-in browser — nobody's own row unfrozen on a screen
   * the whole room looks at.
   */
  standings: (slug: string, audience: 'me' | 'class' = 'me') =>
    request<EntrantStandings>(`${at(slug)}/standings${audience === 'class' ? '?audience=class' : ''}`),

  /* ------------------------------------------------------------ questions */

  questions: (slug: string) => request<EntrantQuestions>(`${at(slug)}/questions`),
  ask: (slug: string, body: AskBody) => request<ContestQuestion>(`${at(slug)}/questions`, post(body)),
  /** The tab is open: the answers and announcements on it are read. */
  seen: (slug: string) => request<unknown>(`${at(slug)}/questions/seen`, { method: 'POST' }),

  /* ------------------------------------------------------------ addresses */

  /** The live stream's address (`EventSource`); the screen opens it. */
  streamUrl: (slug: string) => `${BASE}${at(slug)}/stream`,
}
