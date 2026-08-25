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
  /** Whether students may still create seminars from the home screen. */
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
  archivedAt: number | null
}

export interface CreateSeminarRequest {
  name: string
}

export interface UpdateSeminarRequest {
  name?: string
  archived?: boolean
}

/* -------------------------------------------------------------- assistant */

/**
 * Presets only change which base URL and model are suggested — every one of
 * them speaks the same OpenAI HTTP shape, which is the whole reason the
 * assistant is portable.
 */
export type AiProviderId = 'openai' | 'ollama' | 'vllm' | 'openrouter' | 'custom'

/** What a seminar's assistant is allowed to do. A seminar may lower this, never raise it. */
export type AssistantMode = 'off' | 'hints' | 'full'

export interface AssistantSettings {
  provider: AiProviderId
  baseUrl: string
  model: string
  /** Masked for display, e.g. 'sk-…8fA2'. The key itself never leaves the server. */
  apiKeyMasked: string | null
  defaultMode: AssistantMode
  /** Appended to the system prompt. This is where a teacher fences off a library. */
  houseRules: string
  /** Per student, per seminar, per hour. 0 disables the assistant outright. */
  questionsPerHour: number
  /** Ceiling on the notebook text sent as context. */
  contextChars: number
  /** Whether the environment supplied a key, in which case the UI must not
   *  claim the instance is unconfigured while OPENAI_API_KEY is doing the job. */
  keyFromEnvironment: boolean
}

export interface UpdateAssistantRequest {
  provider?: AiProviderId
  baseUrl?: string
  model?: string
  /** Send the new secret to replace it, '' to clear it, omit to leave it alone. */
  apiKey?: string
  defaultMode?: AssistantMode
  houseRules?: string
  questionsPerHour?: number
  contextChars?: number
}

export interface AssistantTestResult {
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
export interface AssistantUsage {
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
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
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
export interface AdminErrorBody {
  error: string
  /** 'unauthenticated' | 'forbidden' | 'unclaimed' | 'invalid' */
  reason: 'unauthenticated' | 'forbidden' | 'unclaimed' | 'invalid'
}
