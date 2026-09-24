import type { AdminDependencyOverview, DependencyBundle } from '@shared/dependencies'
import {tr} from '@shared/i18n'
/**
 * The /api/admin client.
 *
 * Every call sends `credentials: 'include'`. The staff cookie is HttpOnly, so
 * the browser is the only thing that can attach it — and fetch leaves it off by
 * default even same-origin, which would make every admin request a silent 401.
 */
import type { RoomRules } from '@shared/rules'
import type {
  AdminErrorBody,
  AdminMe,
  AdminRole,
  AdminSeminar,
  OracleSettings,
  OracleTestResult,
  OracleUsage,
  ClaimRequest,
  CreateSeminarRequest,
  EnvironmentsState,
  ImportPreview,
  ImportResult,
  InstanceResources,
  InstanceState,
  InstanceSettings,
  SaveEnvironmentRequest,
  SignInWithTokenRequest,
  Teacher,
  TeacherWithLink,
  UpdateOracleRequest,
  UpdateSeminarRequest,
} from '@shared/admin'
import type {
  AddressHolder,
  Course,
  CourseItem,
  PublishCandidate,
  SkippedStep,
} from '@shared/publish'
import type {
  CompetitionInput,
  CompetitionLive,
  CompetitionLeaderboard,
  CompetitionView,
  CompetitionsList,
  EntrantRow,
  EntrantsList,
  QueueSnapshot,
  SubmissionDetail,
  SubmissionFeed,
} from '@shared/competitions-api'

export type AdminErrorReason = AdminErrorBody['reason']

/**
 * `reason` is the branch callers actually want: 'unauthenticated' means send
 * them to /admin, everything else is a message to show where they stand.
 */
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: AdminErrorReason,
    /**
     * The whole refusal body — not everything in a refusal fits in one phrase.
     *
     * A 409 on an address change names the holder of the name (`holder`), and
     * without it the panel can only repeat "already taken": it has nothing to
     * name the course holding it with, let alone to release the former name.
     */
    readonly body: unknown = null,
  ) {
    super(message)
  }
}

/**
 * The address holder from a 409 refusal — or null if the refusal is about
 * something else.
 *
 * Parsed here, not in the component: this value came over the network and
 * cannot be taken at its word. As long as the server does not name the holder
 * (or names it unclearly), the panel behaves exactly as before — it shows the
 * refusal's phrase and offers nothing to release.
 */
export function addressHolderOf(error: unknown): AddressHolder | null {
  if (!(error instanceof AdminApiError) || error.status !== 409) return null
  const holder = (error.body as { holder?: unknown } | null)?.holder
  if (!holder || typeof holder !== 'object') return null
  const it = holder as Partial<AddressHolder>
  if (it.kind !== 'course' && it.kind !== 'publication') return null
  if (typeof it.id !== 'string' || !it.id) return null
  return {
    kind: it.kind,
    id: it.id,
    name: typeof it.name === 'string' ? it.name : '',
    former: it.former === true,
  }
}

/**
 * The two request DTOs the staff list needs that the shared contract does not
 * name. Nobody is created as an owner: promotion is a second, deliberate act,
 * which is also why the patch carries nothing but the role.
 */
export interface CreateTeacherRequest {
  name: string
  email: string
}

/** The role, personal details or both — the server accepts any combination. */
export interface UpdateTeacherRequest {
  role?: AdminRole
  name?: string
  email?: string
}

/**
 * A public page in its own right, not as a field of a seminar.
 *
 * `orphaned` — a page whose room was deleted: every other publication route
 * is keyed by the room id, so there was nothing to take it down with, even
 * though the server serves it and `make site` deploys it.
 */
export interface AdminPublication {
  id: string
  slug: string | null
  sessionId: string | null
  title: string
  state: 'published' | 'withdrawn'
  publishedAt: number
  publishedBy: string | null
  revision: number
  orphanedAt: number | null
  steps: number
  orphaned: boolean
}

const BASE = '/api/admin'

/** A body that is not an AdminErrorBody still has a status worth trusting. */
function reasonForStatus(status: number): AdminErrorReason {
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'forbidden'
  return 'invalid'
}

/**
 * `base` is not decoration: the description of the MACHINE does not live
 * under /api/admin.
 *
 * Instance resources are about the hardware, not the panel, and they have a
 * door of their own (/api/instance/resources). Refusal parsing, the cookie and
 * the network must still be the same: a second copy of this code would drift
 * from the first on the very first change to 401 handling.
 */
async function request<T>(path: string, init?: RequestInit, base = BASE): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        /*
         * A multipart body never gets here: only the browser knows the
         * boundary, and an `application/json` label from us would turn a file
         * upload into a request the server cannot parse.
         */
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
      throw new AdminApiError(
        tr('common.networkError'),
        0,
        'network',
      )
    }
    throw cause
  }

  if (!res.ok) {
    // HTTP/2 dropped the status line: res.statusText is always empty there, and
    // the refusal reached the screen as an empty string, which `{#if error}`
    // does not draw.
    let message = tr('common.requestFailed',{status:res.status})
    let reason = reasonForStatus(res.status)
    let said: unknown = null
    try {
      const body = (await res.json()) as Partial<AdminErrorBody>
      said = body ?? null
      if (body?.error) message = body.error
      if (body?.reason) reason = body.reason
    } catch {
      /* non-JSON error body */
    }
    throw new AdminApiError(message, res.status, reason, said)
  }

  // Deletes and sign-out answer with no body; asking json() for one throws.
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return (await res.json()) as T
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

/**
 * File uploads — with the same refusal parsing as the other doors.
 *
 * A function of its own rather than `request` with a `FormData` body: that
 * one sets `content-type: application/json` on everything that has a body,
 * and the multipart boundary would be lost along with it — the server would
 * answer "a file upload was expected" to a real file upload. Here the header
 * is not set at all: the browser writes it, and only it knows the boundary.
 */
async function sendForm<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: 'POST', body: form })
}

export const adminApi = {
  getInstanceSettings: () => request<InstanceSettings>('/instance/settings'),
  updateInstanceSettings: (body: InstanceSettings) => request<InstanceSettings>('/instance/settings', {method:'PATCH',...json(body)}),
  /* ------------------------------------------------------------- session */

  /** Open to anyone: it is what tells the panel whether to show the claim form. */
  state: () => request<InstanceState>('/state'),

  me: () => request<AdminMe>('/me'),

  claim: (body: ClaimRequest) => request<AdminMe>('/claim', { method: 'POST', ...json(body) }),

  signInWithToken: (token: string) =>
    request<AdminMe>('/signin/token', {
      method: 'POST',
      ...json({ token } satisfies SignInWithTokenRequest),
    }),

  /**
   * The key travels in the body rather than the path: a URL ends up in access
   * logs and proxy traces, and this one is a credential until it is spent.
   */
  signInWithKey: (key: string) =>
    request<AdminMe>('/signin/key', { method: 'POST', ...json({ key }) }),

  signOut: () => request<void>('/signout', { method: 'POST' }),

  /* ---------------------------------------------------- import from GitHub */

  /** What the link would produce — before anything is created. */
  previewImport: (url: string) =>
    request<ImportPreview>('/import/preview', { method: 'POST', ...json({ url }) }),

  importSeminar: (body: {
    url: string
    name?: string
    environment?: string | null
    /*
     * The mode — the same rules preset as for an empty room (see
     * CreateSeminarRequest.mode). All three doors have it, because a lecture
     * is started from a ready notebook more often than from a blank page.
     */
    mode?: 'lab' | 'lecture' | 'council'
    rules?: Partial<RoomRules>
  }) => request<ImportResult>('/import', { method: 'POST', ...json(body) }),

  /* -------------------------------------------------------- environments */

  listEnvironments: () => request<EnvironmentsState>('/environments'),

  /** The file itself. The list carries parsed packages; the editor needs text. */
  readEnvironment: (name: string) =>
    request<{ name: string; source: string }>(`/environments/${encodeURIComponent(name)}`),

  /**
   * Write a package list; in create mode — only if the name does not exist yet.
   *
   * The PUT is the same for "created an environment" and "fixed the list", but
   * the intentions differ: the create form on a taken name overwrote someone
   * else's list entirely, and checking against the list on screen covers that
   * only as long as no second tab is open. `If-None-Match: *` means "only if
   * there is no such thing yet": the server answers 409 with reason 'exists'
   * and leaves the file alone.
   */
  saveEnvironment: (name: string, source: string, opts?: { creating?: boolean }) =>
    request<{ name: string; source: string }>(`/environments/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: opts?.creating ? { 'if-none-match': '*' } : {},
      ...json({ name, source } satisfies SaveEnvironmentRequest),
    }),

  deleteEnvironment: (name: string) =>
    request<void>(`/environments/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  buildEnvironment: (name: string) =>
    request<{ name: string }>(`/environments/${encodeURIComponent(name)}/build`, {
      method: 'POST',
    }),

  cancelEnvironmentBuild: (name: string) =>
    request<{ cancelled: boolean }>(`/environments/${encodeURIComponent(name)}/cancel`, {
      method: 'POST',
    }),

  useEnvironment: (name: string) =>
    request<{ active: string }>(`/environments/${encodeURIComponent(name)}/use`, {
      method: 'POST',
    }),

  /* ------------------------------------------------------ competitions */

  /** The A1 list plus the runner's state: the strip on top is about the same queue. */
  listCompetitions: () => request<CompetitionsList>('/competitions'),

  /** The instance queue on its own — there is one for all competitions. */
  competitionQueue: () => request<QueueSnapshot>('/competitions/queue'),

  /** "Pause the queue" / "Resume the queue". A run in progress is left alone. */
  pauseCompetitionQueue: (paused: boolean) =>
    request<QueueSnapshot>('/competitions/queue/pause', { method: 'POST', ...json({ paused }) }),

  /** "Kill" — interrupt the run in progress. A refusal means nothing was running. */
  killCompetitionRun: (submissionId: string) =>
    request<{ killed: boolean }>('/competitions/queue/kill', {
      method: 'POST',
      ...json({ submissionId }),
    }),

  competitionDependencies: (id: string) => request<AdminDependencyOverview>(`/competitions/${encodeURIComponent(id)}/dependencies`),
  updateDependencyPolicy: (id: string, policy: { enabled: boolean; maxDownloadBytes: number }) =>
    request<AdminDependencyOverview>(`/competitions/${encodeURIComponent(id)}/dependencies/policy`, { method: 'PATCH', ...json(policy) }),
  refreshDependencyBase: (id: string) =>
    request<AdminDependencyOverview>(`/competitions/${encodeURIComponent(id)}/dependencies/refresh-base`, { method: 'POST' }),
  cancelCompetitionDependencies: (id: string, bundleId: string) =>
    request<DependencyBundle>(`/competitions/${encodeURIComponent(id)}/dependencies/${encodeURIComponent(bundleId)}/cancel`, { method: 'POST' }),

  competition: (id: string) => request<CompetitionView>(`/competitions/${encodeURIComponent(id)}`),

  /** A new one is always a draft: a separate action, with a check, opens it. */
  createCompetition: (body: CompetitionInput) =>
    request<CompetitionView>('/competitions', { method: 'POST', ...json(body) }),

  /**
   * An edit changes only what was sent.
   *
   * The server touches the fields that arrived and leaves the rest alone, so a
   * form can send its own slice: the editor and the "Settings" tab show
   * different things.
   */
  updateCompetition: (id: string, body: CompetitionInput) =>
    request<CompetitionView>(`/competitions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...json(body),
    }),

  /** Together with the directory that holds the answers. Owner only. */
  deleteCompetition: (id: string) =>
    request<void>(`/competitions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** The metric code has its own door: the code editor never saw the rest of the form. */
  saveCompetitionMetric: (
    id: string,
    metric: { name?: string; direction?: 'lower' | 'higher'; code?: string },
  ) =>
    request<CompetitionView>(`/competitions/${encodeURIComponent(id)}/metric`, {
      method: 'PUT',
      ...json(metric),
    }),

  /** Public data files: what an entrant will see in `data/`. */
  uploadCompetitionData: (id: string, files: readonly File[]) => {
    const form = new FormData()
    for (const file of files) form.append('file', file, file.name)
    return sendForm<CompetitionView>(`/competitions/${encodeURIComponent(id)}/files`, form)
  },

  deleteCompetitionFile: (id: string, name: string) =>
    request<CompetitionView>(
      `/competitions/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  /**
   * The answers — through a door of their own, not a parameter of the one
   * above.
   *
   * A mixed-up directory here means "handed the answers to the class", and
   * such a mistake must look like a different method name, not a different
   * field value.
   */
  uploadCompetitionSolution: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return sendForm<CompetitionView>(`/competitions/${encodeURIComponent(id)}/solution`, form)
  },

  deleteCompetitionSolution: (id: string, name: string) =>
    request<CompetitionView>(
      `/competitions/${encodeURIComponent(id)}/solution/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  uploadCompetitionBaseline: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return sendForm<CompetitionView>(`/competitions/${encodeURIComponent(id)}/baseline`, form)
  },

  /** Check the whole sample notebook: it goes into the shared queue as a submission. */
  checkCompetitionBaseline: (id: string) =>
    request<{ submissionId: string }>(`/competitions/${encodeURIComponent(id)}/baseline/check`, {
      method: 'POST',
    }),

  /** "Check against the baseline" — the metric only, the notebook is not re-run. */
  checkCompetitionMetric: (id: string) =>
    request<{ submissionId: string }>(`/competitions/${encodeURIComponent(id)}/metric/check`, {
      method: 'POST',
    }),

  /** A refusal arrives with reason 'not_ready' and a phrase about the missing section. */
  openCompetition: (id: string) =>
    request<CompetitionView>(`/competitions/${encodeURIComponent(id)}/open`, { method: 'POST' }),

  /** "Finish now". Owner only: submissions close for the whole class. */
  finishCompetition: (id: string) =>
    request<CompetitionView>(`/competitions/${encodeURIComponent(id)}/finish`, { method: 'POST' }),

  /** "I will open it by hand — at the review". */
  openPrivateBoard: (id: string) =>
    request<CompetitionView>(`/competitions/${encodeURIComponent(id)}/private-board`, {
      method: 'POST',
    }),

  /** One snapshot of the A3 live state — for a screen without the stream. */
  competitionLeaderboard: (id: string) =>
    request<CompetitionLeaderboard>(`/competitions/${encodeURIComponent(id)}/leaderboard`),

  competitionLive: (id: string) =>
    request<CompetitionLive>(`/competitions/${encodeURIComponent(id)}/live`),

  /**
   * The address of the live stream (`EventSource`), not the stream itself.
   *
   * The screen holds the subscription: it lives as long as the screen does,
   * and whoever opened it must close it. Here is only the knowledge of where
   * it lives.
   */
  competitionStreamUrl: (id: string) => `${BASE}/competitions/${encodeURIComponent(id)}/stream`,

  competitionSubmissions: (
    id: string,
    opts: { state?: string; entrant?: string; q?: string; limit?: number; offset?: number } = {},
  ) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(opts)) {
      if (value !== undefined && value !== '') query.set(key, String(value))
    }
    const tail = query.toString()
    return request<SubmissionFeed>(
      `/competitions/${encodeURIComponent(id)}/submissions${tail ? `?${tail}` : ''}`,
    )
  },

  /** "All output": the runs, the metric trace and what is left on disk. */
  competitionSubmission: (id: string, submissionId: string) =>
    request<SubmissionDetail>(
      `/competitions/${encodeURIComponent(id)}/submissions/${encodeURIComponent(submissionId)}`,
    ),

  /** "Open the executed notebook" — the link it is served from. */
  submissionFileUrl: (id: string, submissionId: string, name: string) =>
    `${BASE}/competitions/${encodeURIComponent(id)}/submissions/${encodeURIComponent(
      submissionId,
    )}/file/${encodeURIComponent(name)}`,

  /** "Run again": the same notebook, a new container, from scratch. */
  rerunSubmission: (id: string, submissionId: string) =>
    request<{ submissionId: string }>(
      `/competitions/${encodeURIComponent(id)}/submissions/${encodeURIComponent(
        submissionId,
      )}/rerun`,
      { method: 'POST' },
    ),

  /** Rescore a single submission — the notebook is not run. */
  rescoreSubmission: (id: string, submissionId: string) =>
    request<{ submissionId: string }>(
      `/competitions/${encodeURIComponent(id)}/submissions/${encodeURIComponent(
        submissionId,
      )}/rescore`,
      { method: 'POST' },
    ),

  /** "Do not count it". Owner only: it is someone else's result. */
  dropSubmission: (id: string, submissionId: string) =>
    request<{ submission: unknown }>(
      `/competitions/${encodeURIComponent(id)}/submissions/${encodeURIComponent(
        submissionId,
      )}/drop`,
      { method: 'POST' },
    ),

  /** "Fix the metric and rescore everyone" — after the code is edited. */
  rescoreCompetition: (id: string) =>
    request<{ queued: number }>(`/competitions/${encodeURIComponent(id)}/rescore`, {
      method: 'POST',
    }),

  /** The competition's entrants: rank, submissions and sign-in key. */
  competitionEntrants: (id: string) =>
    request<EntrantsList>(`/competitions/${encodeURIComponent(id)}/entrants`),

  /** Every entrant on the instance — their identity is shared, not per room. */
  listEntrants: () => request<EntrantsList>('/competitions/entrants'),

  createEntrant: (name: string) =>
    request<{ entrant: EntrantRow; key: string }>('/competitions/entrants', {
      method: 'POST',
      ...json({ name }),
    }),

  updateEntrant: (id: string, body: { name?: string; disabled?: boolean }) =>
    request<{ entrant: EntrantRow }>(`/competitions/entrants/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...json(body),
    }),

  /** A new key. The old one stops working the same second — owner only. */
  rotateEntrantKey: (id: string) =>
    request<{ entrant: EntrantRow; key: string }>(
      `/competitions/entrants/${encodeURIComponent(id)}/rotate`,
      { method: 'POST' },
    ),

  /* ------------------------------------------------------------ seminars */

  /* --------------------------------------------------------- resources */

  /**
   * What the machine has: memory, cores, GPUs and kernel defaults per
   * environment.
   *
   * Read by the class form, so that the "how much memory" field is not a
   * guess. A door of its own, bypassing /api/admin: this describes the
   * machine, not the panel.
   */
  resources: () => request<InstanceResources>('/resources', undefined, '/api/instance'),

  listSeminars: () => request<AdminSeminar[]>('/seminars'),

  createSeminar: (body: CreateSeminarRequest) =>
    request<AdminSeminar>('/seminars', { method: 'POST', ...json(body) }),

  updateSeminar: (id: string, body: UpdateSeminarRequest) =>
    request<AdminSeminar>(`/seminars/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...json(body),
    }),

  /* ---------------------------------------------------------- courses */

  listCourses: () => request<{ courses: Course[] }>('/courses').then((r) => r.courses),

  course: (id: string) =>
    request<{ course: Course }>(`/courses/${encodeURIComponent(id)}`).then((r) => r.course),

  createCourse: (body: { name: string; blurb?: string }) =>
    request<{ course: Course }>('/courses', { method: 'POST', ...json(body) }).then(
      (r) => r.course,
    ),

  updateCourse: (id: string, body: { name?: string; blurb?: string | null }) =>
    request<{ course: Course }>(`/courses/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...json(body),
    }).then((r) => r.course),

  /**
   * Contents and order — as a whole, with a version comparison.
   *
   * A 409 carries the course as it is now: this is not an error but a race,
   * and the screen must show the truth rather than argue with it.
   */
  setCourseItems: (id: string, rev: number, items: CourseItem[]) =>
    request<{ course: Course }>(`/courses/${encodeURIComponent(id)}/items`, {
      method: 'PUT',
      ...json({ rev, items }),
    }).then((r) => r.course),

  /**
   * The name in the address — for a course or a publication.
   *
   * A separate call, not a field in PATCH: a taken name is a refusal that has
   * to be put into words, not a loss among other fields that saved fine.
   */
  setSlug: (kind: 'course' | 'publication', id: string, slug: string | null) =>
    request<{ slug: string | null }>(`/slug/${kind}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      ...json({ slug }),
    }),

  /**
   * Release one's own former name in the address.
   *
   * A former name is held forever, and for a reason: a link with it was
   * written down in the group chat. But the course "ml-2025", renamed to
   * "ml-2025-fall", held "ml-2025" against next year's course too — forever,
   * and nothing could free it except deleting the owning course. `id` here is
   * the holder's, not that of whoever needs the name: only the name's owner
   * releases it, and only a former one.
   *
   * The cost is irreversible and said out loud on screen: the old link will
   * become a 404.
   */
  releaseFormerSlug: (kind: AddressHolder['kind'], id: string, slug: string) =>
    request<void>(
      `/slug/${kind}/${encodeURIComponent(id)}/former/${encodeURIComponent(slug)}`,
      { method: 'DELETE' },
    ),

  deleteCourse: (id: string) =>
    request<void>(`/courses/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ------------------------------------------------------ publication */

  /**
   * `slug` is declared here on purpose: the server sent it from the start, but
   * the type dropped it — and the publish screen, unaware of the current
   * address, proposed a new one from the title and broke the one already
   * dictated to the class.
   */
  publishInfo: (id: string) =>
    request<{
      title: string
      candidates: PublishCandidate[]
      publication: {
        id: string
        slug: string | null
        steps: { seq: number; label: string; at: number }[]
        /**
         * This page's former names in the address (`Course.former` in shared).
         *
         * The server carries them along with the publication itself
         * (routes/courses.ts · `formerSlugs`), but the type dropped them — and
         * the publish screen kept its own declaration of the field so that it
         * had something to release a former name with. Optional: an older
         * server does not send it at all.
         */
        former?: string[]
      } | null
    }>(`/seminars/${encodeURIComponent(id)}/publish`),

  /**
   * `skipped` — the moments that did not become steps, and why.
   *
   * Silence here cost a page: the teacher marked seven moments, got six steps
   * and did not know which one went missing. The server names them one by one
   * (shared/publish.ts · SkippedStep), and the screen must show them —
   * otherwise the field will once again drift off into nowhere.
   */
  publish: (id: string, steps: { seq: number; label: string; at: number }[], finalLabel?: string) =>
    request<{
      publication: { id: string; slug: string | null; steps: { seq: number; label: string }[] }
      skipped: SkippedStep[]
    }>(`/seminars/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      ...json({ steps, finalLabel }),
    }),

  withdraw: (id: string) =>
    request<void>(`/seminars/${encodeURIComponent(id)}/publish`, { method: 'DELETE' }),

  republish: (id: string) =>
    request<void>(`/seminars/${encodeURIComponent(id)}/publish/restore`, { method: 'POST' }),

  /**
   * The room — and, if so decided, its public page.
   *
   * The server's default is to keep the page: a link handed out to the class
   * cannot be recalled. But it declares the choice ("the page's fate is asked
   * separately"), and only the panel can ask the question — otherwise an
   * orphaned page could no longer be taken down by anything.
   */
  deleteSeminar: (id: string, dropReading = false) =>
    request<void>(`/seminars/${encodeURIComponent(id)}${dropReading ? '?reading=drop' : ''}`, {
      method: 'DELETE',
    }),

  /* ------------------------------------------- pages without a room */

  /**
   * Publications keyed by their own address.
   *
   * Everything else here asks for a publication by seminar, and an orphaned
   * one has no seminar any more: `withdraw`/`republish` answer it with 404,
   * and the only way to take it down was editing SQLite.
   */
  listPublications: () =>
    request<{ publications: AdminPublication[] }>('/publications').then((r) => r.publications),

  withdrawPublication: (id: string) =>
    request<void>(`/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  restorePublication: (id: string) =>
    request<void>(`/publications/${encodeURIComponent(id)}/restore`, { method: 'POST' }),

  /** For good: the page's rows are erased, the tombstone in the course loses its link. */
  erasePublication: (id: string) =>
    request<void>(`/publications/${encodeURIComponent(id)}/forever`, { method: 'DELETE' }),

  /* ----------------------------------------------------------- oracle */

  oracle: () => request<OracleSettings>('/oracle'),

  /**
   * A whole-settings write: omitting `apiKey` leaves the stored secret alone,
   * which is the only way a form that never receives the key can save the rest.
   */
  updateOracle: (body: UpdateOracleRequest) =>
    request<OracleSettings>('/oracle', { method: 'PUT', ...json(body) }),

  /** Talks to the configured provider from the server, so it proves the real path. */
  testOracle: () => request<OracleTestResult>('/oracle/test', { method: 'POST' }),

  /** `since` is a timestamp in ms; the server clamps it and picks a term by default. */
  oracleUsage: (since?: number) =>
    request<OracleUsage>(since ? `/oracle/usage?since=${since}` : '/oracle/usage'),

  /* ------------------------------------------------------------ teachers */

  listTeachers: () => request<Teacher[]>('/teachers'),

  /** Answers with the link, which is the only moment it is ever readable. */
  createTeacher: (body: CreateTeacherRequest) =>
    request<TeacherWithLink>('/teachers', { method: 'POST', ...json(body) }),

  /**
   * The third door: a notebook from disk.
   *
   * A JSON body, not multipart: an .ipynb is JSON already, and reading it in
   * the browser is cheaper than bringing up multipart parsing for one field.
   *
   * Only the cells travel — `cell_type` and `source` — not the whole file. The
   * body limit is shared, 1 MB, and a saved notebook with a couple of plots
   * broke through it: its outputs are megabytes of base64, which the server
   * throws away anyway.
   */
  importNotebook: (body: {
    cells: unknown[]
    filename: string
    name?: string
    environment?: string | null
    mode?: 'lab' | 'lecture' | 'council'
    rules?: unknown
  }) => request<ImportResult>('/import/notebook', { method: 'POST', ...json(body) }),

  /**
   * Material into the room, on the teacher's behalf.
   *
   * Goes around `${BASE}`: this is a seminar route, not a panel one, and it
   * accepts the teacher's cookie on a par with a participant's token.
   * `credentials: 'include'` here is the whole of the authorization.
   */
  uploadMaterial: async (sessionId: string, file: File): Promise<void> => {
    const form = new FormData()
    form.append('file', file, file.name)
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    if (!res.ok) {
      let message = res.statusText || `The upload failed (${res.status})`
      try {
        const body = (await res.json()) as { error?: string }
        if (body?.error) message = body.error
      } catch {
        /* non-JSON error body */
      }
      throw new AdminApiError(message, res.status, reasonForStatus(res.status))
    }
  },

  updateTeacher: (id: string, body: UpdateTeacherRequest) =>
    request<Teacher>(`/teachers/${encodeURIComponent(id)}`, { method: 'PATCH', ...json(body) }),

  deleteTeacher: (id: string) =>
    request<void>(`/teachers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Mints a fresh link and kills the old one in the same call. */
  rotateTeacherLink: (id: string) =>
    request<TeacherWithLink>(`/teachers/${encodeURIComponent(id)}/rotate`, { method: 'POST' }),

  /**
   * The existing link, for re-sending it to someone who mislaid theirs. Owner
   * only. It goes to the clipboard, never onto the screen — the row keeps
   * showing the masked shape.
   */
  teacherLink: (id: string) => request<TeacherWithLink>(`/teachers/${encodeURIComponent(id)}/link`),

  /**
   * Revoke the setup token and get a new one.
   *
   * The token signs whoever enters in as the oldest owner and is printed by
   * `make host` on every start: it is in terminal history, in photos of the
   * projector and in the chats it was forwarded to. There was no way to
   * revoke it.
   */
  rotateSetupToken: () => request<{ token: string }>('/setup-token/rotate', { method: 'POST' }),
}
