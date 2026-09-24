import {tr} from '@shared/i18n'
import type {
  AiAskRequest,
  AiAskResponse,
  Ban,
  CouncilOracle,
  CreateSessionResponse,
  FileEntry,
  HandoffResponse,
  JoinRequest,
  JoinResponse,
  Participant,
  SessionInfo,
  SessionMe,
} from '@shared/protocol'
import type { ReasoningEffort } from '@shared/admin'
import type { RoomRules } from '@shared/rules'
import type { PublicCourseView, PublicSeminar, PublicStep } from '@shared/publish'
import type { PersonMark } from './bans'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * How many seconds to wait, if the server named a deadline.
     *
     * Only where the refusal is a wait, not a breakage: the oracle's slow mode
     * sends it in the body, and by it the screen decides to show a calm line
     * with a countdown instead of a red error. A wait cannot be told from a
     * failure by the text of a 429, and guessing from it would mean keeping a
     * second rulebook next to the server's.
     */
    readonly retryAfter: number | null = null,
    /**
     * Until what moment the person will be kept out, if the refusal is a ban.
     *
     * Next to `retryAfter` and for the same reason: a 403 can be "a room rule"
     * or "you were removed from the class", and telling them apart by the text
     * would mean keeping a second rulebook next to the server's. A moment, not
     * a remainder: whoever is looking draws the clock (see `untilWords` in
     * lib/bans.ts).
     */
    readonly until: number | null = null,
  ) {
    super(message)
  }
}

/**
 * What to say when the server said nothing.
 *
 * HTTP/2 dropped the status line — `res.statusText` is always empty there, not
 * just sometimes. An error without a body carrying an error field reached the
 * screen as an empty string, and `{#if error}` does not show an empty string:
 * the refusal looked as if nothing had happened. The code is always there, and
 * naming it is already better than silence.
 */
export function statusMessage(res: Response): string {
  if (res.status === 401) return tr('common.http401')
  if (res.status === 403) return tr('common.http403')
  if (res.status === 404) return tr('common.http404')
  if (res.status === 413) return tr('common.http413')
  if (res.status === 429) return tr('common.http429')
  if (res.status >= 500) return tr('common.serverFailed',{status:res.status})
  return tr('common.requestFailed',{status:res.status})
}

/**
 * One request to our API: the same headers, the same refusal parsing, the same
 * words.
 *
 * Exported for the version feed (lib/history.ts): it had its own almost
 * identical `get`, differing only by the Authorization header — which can be
 * passed here through `init.headers` anyway. Two copies of error parsing drift
 * apart on the very first edit: `retryAfter` and `until` in the refusal body
 * appeared here and never made it into the copy.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
     * fetch rejects the promise with a TypeError saying "Failed to fetch" — a
     * phrase for the debugger, not for a person, and the same for a crashed
     * server, a dropped Wi-Fi and a closed tunnel. It names none of these
     * cases; saying that the connection was lost is more honest.
     */
    if (cause instanceof TypeError) {
      throw new ApiError(tr('common.networkError'), 0)
    }
    throw cause
  }
  if (!res.ok) {
    let message = statusMessage(res)
    let retryAfter: number | null = null
    let until: number | null = null
    try {
      const body = (await res.json()) as { error?: string; retryAfter?: number; until?: number }
      if (body?.error) message = body.error
      if (typeof body?.retryAfter === 'number' && Number.isFinite(body.retryAfter)) {
        retryAfter = body.retryAfter
      }
      if (typeof body?.until === 'number' && Number.isFinite(body.until)) until = body.until
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, retryAfter, until)
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

  /**
   * "Am I even let in?" — the question from a tab whose handshake was refused.
   *
   * The only request in the product that is asked with a key and expects an
   * answer about the key itself. The socket refuses BEFORE the upgrade and
   * without words, and without this door the client told two cases out of
   * three apart by guesswork: someone banned read "the seat has expired" after
   * a reload and lost their identity in the room. What exactly the server
   * answers is at `SessionMe` in shared/protocol.ts.
   */
  me: (id: string, token: string) =>
    request<SessionMe>(`/api/sessions/${id}/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  join: (id: string, body: JoinRequest) =>
    request<JoinResponse>(`/api/sessions/${id}/join`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * The key with which the teacher hands their console over to a tablet.
   *
   * A key, not a token: see `signHandoffToken` on the server. It lives for ten
   * minutes and is good for exactly one exchange below.
   */
  handoff: (id: string, token: string) =>
    request<HandoffResponse>(`/api/sessions/${id}/handoff`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    }),

  /** The tablet trades the link's key for a normal sign-in — as the same person. */
  claimHandoff: (id: string, key: string) =>
    request<JoinResponse>(`/api/sessions/${id}/handoff/claim`, {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),

  /** Everyone who has ever joined, newest activity first. */
  listParticipants: (id: string) =>
    request<{ participants: Participant[]; online: string[] }>(`/api/sessions/${id}/participants`),

  /* --------------------------------------------------------------- bans */

  /**
   * Remove a person from the class for a day.
   *
   * The server names the day, not this line: the term is one for the whole
   * product, and a second place where it is written would drift from the first
   * on the very first edit. Only the "who" leaves from here.
   */
  ban: (id: string, token: string, participantId: string) =>
    request<{ ban: Ban }>(`/api/sessions/${id}/bans`, {
      method: 'POST',
      body: JSON.stringify({ participantId }),
      headers: { authorization: `Bearer ${token}` },
    }),

  /**
   * The active bans — and marks about those who are in the room right now.
   *
   * One request, because it is the same conversation and the same right: the
   * device mark, the address and "first time here" are what a tab does not and
   * must not know about its neighbour, and without them the teacher cannot tell
   * a returning person from a namesake. `marks` is optional: a server that does
   * not know about marks yet leaves the list of people as it was.
   */
  bans: (id: string, token: string) =>
    request<{ bans: Ban[]; marks?: Record<string, PersonMark> }>(`/api/sessions/${id}/bans`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Lift a ban. Oracle questions do not come back with it — history brings them back. */
  liftBan: (id: string, token: string, banId: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/bans/${banId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),

  /**
   * The room's rules — from inside the room.
   *
   * Merged over the current ones on the server: a screen that touches one row
   * must not be able to silently reset the others to their defaults.
   */
  setRoomRules: (id: string, token: string, rules: Partial<RoomRules>) =>
    request<{ rules: RoomRules }>(`/api/sessions/${id}/rules`, {
      method: 'PATCH',
      body: JSON.stringify({ rules }),
      headers: { authorization: `Bearer ${token}` },
    }),

  /* -------------------------------------------------------- public read */

  /**
   * A course and a published seminar — without a token and without signing in.
   *
   * Separate addresses, not `/api/sessions/...`: a publication has its own id
   * precisely so that a "for reading" link does not open the live room.
   */
  course: (id: string) => request<{ course: PublicCourseView }>(`/api/c/${id}`),

  publication: (id: string) => request<{ seminar: PublicSeminar }>(`/api/p/${id}`),

  step: (id: string, seq: number | null) =>
    request<{ step: PublicStep }>(`/api/p/${id}/step/${seq === null ? 'first' : seq}`),

  // `truncated` — the tree is not shown in full: the walk hit the ceiling. The
  // same flag rides in the `files` socket message, and the room keeps one flag.
  listFiles: (id: string, token: string) =>
    request<{ files: FileEntry[]; truncated?: boolean }>(`/api/sessions/${id}/files`, {
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
   * The path goes in the query string, not in the URL path, and so it is
   * everywhere in the product: a slash inside a name can live in the path only
   * as `%2F`, and one proxy or another decodes that along the way.
   */
  fileUrl: (id: string, path: string, ticket: string) =>
    `/api/sessions/${id}/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(ticket)}`,

  /**
   * A key for this room's output images — one for all of them.
   *
   * The same as for a file, and for the same reason: the address goes into the
   * `src` of an `<img>`, and a header cannot be put there. One difference — the
   * key is not per item but per room: one cell's output is a dozen images, and
   * asking for a key for each would mean a dozen requests for every plot. It
   * opens exactly what the person already sees in the notebook.
   */
  blobTicket: (id: string, token: string) =>
    request<{ token: string }>(`/api/sessions/${id}/blobs/ticket`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  /** The address of an output image. The name is a content hash, so it caches forever. */
  blobUrl: (id: string, sha: string, ticket: string) =>
    `/api/sessions/${id}/blobs/${encodeURIComponent(sha)}?token=${encodeURIComponent(ticket)}`,

  /**
   * The same file, but without a ticket in the query string — for the reader.
   *
   * The ticket is for the anchor: `<a download>` cannot send a header. The
   * reader fetches on its own and sends the token in a header, so the address
   * is clean — and pdf.js requests the document by it in ranges and shows the
   * first page without waiting for the last.
   */
  fileRaw: (id: string, path: string) =>
    `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`,

  /**
   * `mode` is what the server actually enforces; `enabled` is `mode !== 'off'`.
   *
   * The two ceilings are the instance's, before the room's rules: the rules
   * console shows them next to its own fields, otherwise "as on the instance"
   * names no number.
   */
  aiStatus: () =>
    request<{
      enabled: boolean
      model: string
      mode: 'full' | 'hints' | 'off'
      questionsPerHour: number
      slowModeSeconds: number
      agentSteps?: number
      /** Default reasoning effort; optional — the server may be older than the panel. */
      reasoningEffort?: ReasoningEffort
    }>('/api/ai/status'),

  /**
   * Fire-and-forget. The server appends the question to the shared document and
   * streams the answer into it. The response entryId links the optimistic row
   * to that entry; the browser reads the answer from the CRDT like everyone else.
   */
  aiAsk: (id: string, token: string, body: AiAskRequest) =>
    request<AiAskResponse>(`/api/sessions/${id}/ai/ask`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}` },
    }),

  /**
   * The author stops their own entry, the teacher stops anyone's.
   *
   * Not "anyone": cutting off someone else's agent turn means abandoning a file
   * edit halfway. The server refuses in words (routes/ai.ts), the button dims
   * in advance (ChatTurn.svelte) — one rule, two places.
   */
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

  /* ------------------------------------------------------------- council */

  /**
   * Ask the oracle about the solutions in a council cell — one question from the
   * room's limit, teacher only.
   *
   * The answer here is the "reading" state; the finished summary arrives over
   * the control socket (`council:oracle`), like everything else about the
   * stack. Over HTTP rather than as a socket message, because a refusal has a
   * cost and a deadline: a 429 with words and `retryAfter`, which the socket
   * cannot say the same way (see `ApiError`).
   */
  councilAsk: (
    id: string,
    token: string,
    cellId: string,
    question?: string,
    effort?: ReasoningEffort,
  ) =>
    request<CouncilOracle>(`/api/sessions/${id}/council/${encodeURIComponent(cellId)}/oracle`, {
      method: 'POST',
      /*
       * A question about the class in one's own words; without it the server
       * substitutes its own template (routes/council.ts). There is never an
       * empty string here: the console does not send a question that is not
       * there.
       *
       * `effort` is not sent at all when "as on the instance" is chosen: then
       * not a single new field goes to the provider.
       */
      body: JSON.stringify({ ...(question ? { question } : {}), ...(effort ? { effort } : {}) }),
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Stop: cut off the oracle's reading of the solutions. The question is not refunded. */
  councilStopOracle: (id: string, token: string, cellId: string) =>
    request<CouncilOracle>(`/api/sessions/${id}/council/${encodeURIComponent(cellId)}/oracle`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),
}
