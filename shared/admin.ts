/**
 * The admin surface: the teaching side of Colloq.
 *
 * Students never touch anything in this file. They open a seminar link, type a
 * name and are in — that stays true. This is the other half: who may create a
 * seminar, which model answers questions, and who holds the key that pays for
 * it.
 *
 * AUTHENTICATION, and why it looks like this
 * ------------------------------------------
 * There is no password, no email delivery and no SSO, because a self-hosted
 * seminar tool cannot assume an SMTP relay or a university IdP — and a product
 * whose entire premise is "a link is enough" has no business growing a login
 * form for the ten people on the other side of it.
 *
 * Two credentials, both links, both revocable:
 *
 *   1. THE SETUP TOKEN. Written to <DATA_DIR>/setup-token (0600) on first boot
 *      and printed once to the server log, exactly like Jupyter's. Whoever can
 *      read the server's disk owns the instance — that is already true of any
 *      self-hosted service, so it is stated rather than pretended away. It does
 *      not expire: it is also the recovery path when the owner loses their link.
 *
 *   2. A PERSONAL SIGN-IN LINK per teacher. Bookmarkable, rotatable, and it
 *      dies with the account. The owner copies one and sends it however they
 *      already talk to that colleague.
 *
 * Both exchange themselves for an HttpOnly cookie; the link itself is never
 * what authorises a request.
 */

/* ------------------------------------------------------------------ people */

/**
 * `owner` may add and remove teachers and rotate their links; `teacher` may run
 * seminars and read settings. Exactly one owner is guaranteed to exist at all
 * times — the last one cannot be demoted or removed, because an instance with
 * nobody who can grant access is an instance that has to be recovered from the
 * setup token.
 */
import type { RoomRules } from './rules.js'

export type AdminRole = 'owner' | 'teacher'

export interface Teacher {
  id: string
  /** Identity, not a delivery channel: nothing is ever sent here. */
  email: string
  name: string
  role: AdminRole
  createdAt: number
  /** null until they have signed in once. */
  lastSeenAt: number | null
  /** True once a sign-in link exists. The link itself is never in a list response. */
  hasLink: boolean
}

/** Returned only at the moment a link is minted or rotated, and never again. */
export interface TeacherWithLink {
  teacher: Teacher
  /** Absolute URL, ready to paste into a chat. */
  signInUrl: string
}

export interface AdminMe {
  teacher: Teacher
  /** How many owners exist, so the UI can refuse to strand the instance. */
  ownerCount: number
}

/* ------------------------------------------------------------ instance state */

/**
 * What an unauthenticated caller may know. Deliberately thin: it says whether
 * the instance has an owner yet, and nothing about who they are.
 */
export interface InstanceState {
  /** False on a fresh install: the setup token is the only way in. */
  claimed: boolean
  /** Prefill for the claim form, from ADMIN_EMAIL. Empty when unset. */
  suggestedEmail: string
  /** Whether POST /api/sessions accepts a caller who is not staff. No page uses it. */
  openSeminarCreation: boolean
}

export interface ClaimRequest {
  /** The token from <DATA_DIR>/setup-token, or the first-boot log line. */
  token: string
  name: string
  email: string
}

export interface SignInWithTokenRequest {
  token: string
}

/* --------------------------------------------------------------- seminars */

export type SeminarStatus = 'draft' | 'live' | 'ended'

export interface AdminSeminar {
  id: string
  name: string
  createdAt: number
  status: SeminarStatus
  /** People currently connected, not people who ever joined. */
  liveCount: number
  /** Everyone who has ever joined, which is what "24 people" means on a card. */
  totalParticipants: number
  cellCount: number
  fileCount: number
  /** Absolute seminar URL, so the list can offer copy without a second call. */
  url: string
  /** Who created it; null for seminars made before there was an admin panel. */
  createdBy: string | null
  /**
   * The environment this room's kernel is actually on, or null when it has not
   * started one yet. Not the configured environment: a seminar that was live
   * through a switch keeps the image it came up on until its kernel restarts.
   */
  environment: string | null
  archivedAt: number | null
  /**
   * Что комната разрешает. Нужно списку, чтобы можно было менять правила
   * существующего семинара, а не только задать их при создании.
   */
  rules: RoomRules
  /** Публичная страница этого семинара, если она есть. */
  publication: { id: string; state: 'published' | 'withdrawn'; steps: number } | null
  /** Курсы, в которых он состоит. Обычно один, но запрета на два нет. */
  courses: { id: string; name: string }[]
}

export interface CreateSeminarRequest {
  name: string
  /**
   * Which environment this room's Python should be. Omitted or null means
   * whatever the instance runs, which is what every seminar got before this
   * existed. Chosen once and then fixed: a room whose packages change under it
   * mid-class is worse than one that never had the newest ones.
   */
  environment?: string | null
  /**
   * How the room will run: who may do what, and what its oracle does.
   *
   * Optional, and absent means the open room the product has always been —
   * `OPEN_ROOM` in shared/rules.ts. Only the fields the server can actually
   * keep have any effect; the rest are stored so that the day they become
   * enforceable, the seminars created today already say what they wanted.
   */
  rules?: Partial<RoomRules>
}

export interface UpdateSeminarRequest {
  name?: string
  archived?: boolean
  /**
   * Правила комнаты. Накладываются на текущие, а не заменяют их.
   *
   * Раньше правила задавались один раз, при создании, и преподаватель, решивший
   * закрыть прошлонедельную комнату, не мог ничего — приходилось заводить
   * вторую.
   */
  rules?: Partial<RoomRules>
}

/* -------------------------------------------------------------- oracle */

/**
 * Presets only change which base URL and model are suggested — every one of
 * them speaks the same OpenAI HTTP shape, which is the whole reason the
 * oracle is portable.
 */
export type AiProviderId = 'openai' | 'ollama' | 'vllm' | 'openrouter' | 'custom'

/** What a seminar's oracle is allowed to do. A seminar may lower this, never raise it. */
export type OracleMode = 'off' | 'hints' | 'full'

export interface OracleSettings {
  provider: AiProviderId
  baseUrl: string
  model: string
  /** Masked for display, e.g. 'sk-…8fA2'. The key itself never leaves the server. */
  apiKeyMasked: string | null
  defaultMode: OracleMode
  /** Appended to the system prompt. This is where a teacher fences off a library. */
  houseRules: string
  /** Per student, per seminar, per hour. 0 disables the oracle outright. */
  questionsPerHour: number
  /** Ceiling on the notebook text sent as context. */
  contextChars: number
  /** Whether the environment supplied a key, in which case the UI must not
   *  claim the instance is unconfigured while OPENAI_API_KEY is doing the job. */
  keyFromEnvironment: boolean
}

export interface UpdateOracleRequest {
  provider?: AiProviderId
  baseUrl?: string
  model?: string
  /** Send the new secret to replace it, '' to clear it, omit to leave it alone. */
  apiKey?: string
  defaultMode?: OracleMode
  houseRules?: string
  questionsPerHour?: number
  contextChars?: number
}

export interface OracleTestResult {
  ok: boolean
  /** Round trip in ms when ok. */
  ms: number | null
  /** A sentence a teacher standing in front of a class can act on. */
  message: string
  /** What the endpoint said its model was, when it says so. */
  model: string | null
}

/**
 * Counted on our own server rather than read from the provider, so it reflects
 * what the room did. Cost is deliberately absent: it would mean shipping a
 * price table per provider that goes stale silently, and a wrong number about
 * money is worse than no number.
 */
export interface OracleUsage {
  since: number
  questions: number
  /** Reported by the provider when it reports usage at all; null otherwise. */
  tokens: number | null
  byAction: Record<string, number>
  seminarsWithQuestions: number
}

/* ------------------------------------------------------------------ limits */

export const LIMITS = {
  teacherName: 60,
  email: 160,
  seminarName: 80,
  houseRules: 1000,
  baseUrl: 300,
  model: 120,
  /** Per student, per seminar, per hour. */
  questionsPerHour: { min: 0, max: 500, default: 20 },
  contextChars: { min: 2_000, max: 100_000, default: 20_000 },
} as const

export const PROVIDER_PRESETS: Record<AiProviderId, { label: string; baseUrl: string; model: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { label: 'Ollama', baseUrl: 'http://host.docker.internal:11434/v1', model: 'llama3.1' },
  vllm: { label: 'vLLM', baseUrl: 'http://host.docker.internal:8000/v1', model: '' },
  /*
   * OpenRouter namespaces its models by vendor: `gpt-4o-mini` is not a model
   * there, `openai/gpt-4o-mini` is. Leaving this empty meant switching from
   * OpenAI kept `gpt-4o-mini` in the field — a name that looks right, is
   * plausible, and fails at the provider with a message about an unknown model.
   */
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
  },
  custom: { label: 'Custom', baseUrl: '', model: '' },
}

/* --------------------------------------------------------------- transport */

/**
 * The cookie is HttpOnly and SameSite=Lax and is the ONLY thing that authorises
 * an admin request: a sign-in link is spent once and exchanged for it.
 */
export const STAFF_COOKIE = 'colloq_staff'

/** Where a personal sign-in link points. The page exchanges :key for the cookie. */
export const SIGN_IN_PATH = '/admin/k/'

/**
 * Every /api/admin route answers one of these on failure, so the client has a
 * single branch for "you are not signed in" and can send the user to /admin.
 */
/**
 * Why a request was refused, in a word the client can branch on.
 *
 * `error` is what a person reads; this is what the code reacts to. The first
 * four are about who is asking. The rest are about environments, where the
 * panel does react differently: a build already running is a reason to watch
 * the log rather than show a failure, and a missing Docker socket is a reason
 * to explain the `make` command instead of retrying.
 */
export type AdminErrorReason =
  | 'unauthenticated'
  | 'forbidden'
  | 'unclaimed'
  | 'invalid'
  | 'not_found'
  | 'too_long'
  /** The environment is the one the room is running, or is `base`. */
  | 'in_use'
  | 'protected'
  /** This install cannot reach Docker, so it cannot build or switch. */
  | 'no_docker'
  | 'building'
  | 'failed'
  /**
   * Запрос не доехал: сервера нет, сети нет, туннель закрыт.
   *
   * Не от сервера — его сочиняет клиент, когда fetch отверг обещание. Отдельно
   * от 'invalid', потому что «попробуйте ещё раз» здесь осмысленно, а там нет.
   */
  | 'network'

export interface AdminErrorBody {
  error: string
  reason: AdminErrorReason
}

/* --------------------------------------------------------- environments */

/**
 * What a seminar's Python is made of.
 *
 * An environment is a list of packages that gets baked into a container image
 * on top of the base every kernel has. The panel calls them environments; on
 * disk each one is `kernel/environments/<name>.txt`, and in Docker each is the
 * image tag `colloq-kernel:<name>`.
 */
export type EnvironmentState =
  /** Built and ready — a seminar switched to it starts in seconds. */
  | 'ready'
  /** Written down but never built, or edited since the last build. */
  | 'unbuilt'
  | 'building'
  | 'failed'

export interface AdminEnvironment {
  /** Also the filename and the image tag, so it is restricted to [a-z0-9-]. */
  name: string
  state: EnvironmentState
  /** Packages asked for, one per line, comments and pip flags dropped. */
  packages: string[]
  /** Size of the built image in bytes; null when there is nothing built. */
  imageBytes: number | null
  /** When the image was built; null when there is nothing built. */
  builtAt: number | null
  /** True for the one every seminar on this instance is running right now. */
  active: boolean
  /** Last build's error, kept so a failure is readable after the log scrolls. */
  error: string | null
}

export interface EnvironmentsState {
  environments: AdminEnvironment[]
  /**
   * Whether this install can build and switch environments at all.
   *
   * The server does it by talking to Docker. An app running on the host has a
   * socket; one in a container only does if the operator mounted it. Without
   * it the panel still lists and edits environments, and says plainly that
   * switching is a `make env-use` away.
   */
  canBuild: boolean
  /** Why not, when `canBuild` is false — shown instead of dead buttons. */
  cannotBuildReason: string | null
}

export interface SaveEnvironmentRequest {
  name: string
  /** The file's whole text, comments and all: this is an editor, not a form. */
  source: string
}

/** Same alphabet as a filename and a Docker tag, and short enough to read. */
export const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/

/* ------------------------------------------------------ импорт с GitHub */

/**
 * Что получится из ссылки на GitHub, посчитанное без создания комнаты.
 *
 * Показывается до импорта нарочно: преподаватель, вставивший ссылку на папку,
 * хочет увидеть «сто десять ячеек и train.csv» ДО того, как появится семинар,
 * а не после.
 */
export interface ImportPreview {
  /** Имя, выведенное из имени файла или папки; его можно переписать. */
  name: string
  notebook: string
  cells: number
  files: { name: string; size: number }[]
  /** owner/repo/path — чтобы было видно, откуда это взялось. */
  source: string
}

export interface ImportResult {
  id: string
  name: string
  url: string
  cells: number
  files: string[]
  /** Файлы, которые не удалось забрать: имя не годится или скачивание упало. */
  skipped: string[]
  createdBy: string | null
}
