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

export interface InstanceSettings {
  language: import('./i18n-types.js').Locale
}

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
  /**
   * How many bytes a file upload accepts — the server's `MAX_UPLOAD_MB`.
   *
   * The number is here because the seminar creation form prints it ("Up to
   * 50 MB each") and uses it to refuse a file BEFORE the room is created.
   * Before this field the panel kept its own copy of the default, and an
   * operator who raised the limit to 200 or lowered it to 20 read someone
   * else's number on the screen and learned the truth from an upload that
   * never arrived.
   *
   * Optional: an older build does not send it, and then the screen says
   * nothing about the limit rather than making one up.
   */
  maxUploadBytes?: number
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

/**
 * What state a seminar is in — in one word, for a list row.
 *
 * Three of them are about what happens by itself: `live` — someone is in the
 * room right now, `draft` — the link has not been given to anyone yet (nobody
 * has come in), `idle` — people came in, but it is empty now. The fourth is
 * the teacher's decision: `finished` means the class is over and the room is
 * now only for reading.
 *
 * The decision beats the count: a finished class has the status `finished`
 * even if half the class is sitting there rereading the solutions. Otherwise
 * the result was nonsense — an empty room and a finished class were shown
 * with one and the same word, and the bell changed nothing in the list.
 */
export type SeminarStatus = 'draft' | 'live' | 'idle' | 'finished'

export interface AdminSeminar {
  id: string
  name: string
  createdAt: number
  status: SeminarStatus
  /** People currently connected, not people who ever joined. */
  liveCount: number
  /**
   * When the oldest of the sockets now in the room opened — that is, since
   * when the class that is going on right now has been going. `null` if
   * nobody is in the room.
   *
   * A clock separate from `createdAt`, precisely because they are different
   * clocks: a room is created a week before the class and reused for the
   * second one, and a "Running now · started 6 days ago" banner reads as the
   * length of the class. Optional: an older build does not send the field,
   * and the panel then calls the clocks it does have by their real names.
   */
  liveSince?: number | null
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
   * What the room allows. The list needs it so that the rules of an existing
   * seminar can be changed, not only set at creation.
   */
  rules: RoomRules
  /**
   * This seminar's public page, if it has one.
   *
   * `slug` is the chosen name in the address; `null` means the address stays
   * the id. The list prints and copies `/p/<slug ?? id>`: the chosen name is
   * the very address given to the class, and the id next to it would read as
   * a second, foreign one.
   */
  publication: {
    id: string
    slug: string | null
    state: 'published' | 'withdrawn'
    steps: number
  } | null
  /** The courses it belongs to. Usually one, but nothing forbids two. */
  courses: { id: string; name: string }[]
  /**
   * When the teacher finished the class — or null while it is going on.
   *
   * The time that the `status: 'finished'` next to it does not carry: the
   * word says the class is over, the hour says when exactly, and the hour is
   * what someone who comes back to the room a day later needs.
   */
  finishedAt: number | null
  /**
   * How much memory this room's kernel was given, in megabytes — or null if
   * nothing was set for it and it lives by its environment's default.
   *
   * Its own number, not the effective one: in the settings a person must be
   * able to tell "I set four gigabytes" from "that is what the environment
   * gives". The panel knows the default separately — from
   * /api/instance/resources; it is one for all rooms and changes without
   * them. Optional: an older server build does not send the field, and then
   * the "Resources" section simply says nothing.
   */
  memoryMb?: number | null
  /** How many cores were set for this room, or null — the instance default. */
  cpus?: number | null
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
   * What kind of class this is: a lab where everyone works, or a lecture where
   * the notebook belongs entirely to the teacher.
   *
   * The mode is a PRESET of rules, not a separate state of the room:
   * 'lecture' writes `LECTURE_ROOM`, 'lab' writes `OPEN_ROOM`, and from then on
   * the room lives by the rules alone. Otherwise the product would have two
   * sources of truth about what is allowed in the room, and they would drift
   * apart at the first switch in the settings: the rule says one thing, the
   * mode another, and the server asks only one of them.
   *
   * No field means 'lab', that is, exactly today's behavior: a seminar created
   * by a script or by an older build opens the way it always did.
   */
  mode?: 'lab' | 'lecture' | 'council'
  /**
   * How the room will run: who may do what, and what its oracle does.
   *
   * Optional, and absent means the open room the product has always been —
   * `OPEN_ROOM` in shared/rules.ts. Only the fields the server can actually
   * keep have any effect; the rest are stored so that the day they become
   * enforceable, the seminars created today already say what they wanted.
   *
   * Arriving together with `mode`, it is laid ON TOP of that mode's preset: the
   * person chose a mode and tweaked one line in it, and the tweak beats the
   * choice.
   */
  rules?: Partial<RoomRules>
  /**
   * How much memory to give this room's kernel, in megabytes.
   *
   * Omitted or null means the environment's default (`KERNEL_MEM` and the
   * pool). It is set here, and not in a separate trip to the settings in the
   * morning: a computer-vision class is set up the day before, and "six
   * gigabytes" is as much a decision about the room as the choice of
   * environment next to it.
   */
  memoryMb?: number | null
  /** How many cores to give the room; omitted or null — the instance default. */
  cpus?: number | null
}

export interface UpdateSeminarRequest {
  name?: string
  archived?: boolean
  /**
   * Finish the class or reopen it — from the panel.
   *
   * The same door as the button in the room: a teacher who closed the tab and
   * remembered about it on the subway should not have to go back into the
   * room for one press.
   */
  finished?: boolean
  /**
   * The room's rules. Laid over the current ones, not replacing them.
   *
   * Rules used to be set once, at creation, and a teacher who decided to close
   * last week's room could do nothing — they had to create a second one.
   */
  rules?: Partial<RoomRules>
  /**
   * The room's new memory limit in megabytes; null returns it to the
   * environment's default.
   *
   * It applies to a LIVE room immediately, without restarting the kernel
   * (`docker update`): a teacher whose kernel was just killed for memory adds
   * gigabytes and runs the same cell again, losing neither the seminar's
   * variables nor the open terminal.
   */
  memoryMb?: number | null
  /**
   * How many cores to give the room; null returns it to the instance default.
   *
   * It applies to a live container immediately (`docker update --cpus`), but
   * the numpy and torch threads inside an already running kernel stay as they
   * were: their number is computed once, when the interpreter starts. The
   * form says so.
   */
  cpus?: number | null
}

/* --------------------------------------------------------- resources */

/** A GPU of the machine: its name and all its VRAM. Rooms share it; cgroup does not cap it. */
export interface GpuCard {
  index: number
  name: string
  memoryMb: number
}

/** A room in the "who holds the machine's memory" list. */
export interface RoomResource {
  id: string
  name: string
  /** The effective limit: the room's own number, otherwise its environment's default. */
  memoryMb: number
  /** How many cores the room has: its own number, otherwise the instance default. */
  cpus: number
  environment: string | null
  alive: boolean
  /**
   * The class's second container — the one where students' personal
   * notebooks run.
   *
   * No field means there is none right now: no personal notebooks were
   * opened, they are not allowed, or this is not the docker backend. A
   * separate field rather than an addition to `memoryMb`: the containers have
   * separate limits (that is the whole point of the second one), and adding
   * them into one number would show the teacher "8 GB" where none of their
   * Pythons will get that much. The machine holds both of them, though, and
   * the panel counts what is taken by the sum.
   */
  own?: { memoryMb: number; cpus: number }
}

/**
 * What the machine under the instance has at its disposal.
 *
 * Exactly one screen needs it — the class form — and exactly so that the
 * "how much memory" field is not guesswork: on 13 Sep 2026 a seminar's kernel
 * was killed for memory sixteen times in a row, and the numbers that would
 * have let anyone foresee it were known only to whoever had ssh.
 */
export interface InstanceResources {
  memory: {
    totalMb: number
    /**
     * How much more can be handed out to rooms; `null` means "we do not know".
     *
     * We do not know wherever a number would be made up: macOS has no
     * MemAvailable, and `os.freemem()` there counts as free only memory that
     * nothing uses, so on a Mac with 36 GB it reported "0.5 free". Scaring
     * people with such a number is worse than keeping quiet, so the form then
     * does not talk about free memory at all.
     */
    availableMb: number | null
    /**
     * Whose numbers these are: the server machine's or the docker daemon's.
     *
     * Under colima and Docker Desktop, containers live in a virtual machine
     * with its own memory, and it is that machine, not the Mac, that sets the
     * room's ceiling. The form must call things by their real names:
     * "11.7 GB in Docker" instead of "36 on the machine".
     */
    source: 'host' | 'docker'
  }
  cpus: number
  gpus: GpuCard[]
  kernel: {
    defaultMemoryMb: number
    gpuDefaultMemoryMb: number
    /** A room's default cores — `KERNEL_CPUS`, one number per instance. */
    defaultCpus: number
    /** What a room on this environment gets if nothing was set for it. */
    perEnvironment: Record<string, { memoryMb: number; gpu: boolean }>
  }
  rooms: RoomResource[]
  /**
   * The bounds within which the server will accept a number: megabytes for
   * the field, cores for their own. The server computes them, not the form: a
   * second copy of the rule in the browser would drift from the server's at
   * its first change.
   */
  limits: { min: number; max: number; cpus: { min: number; max: number } }
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

/**
 * How much the model should think aloud before answering.
 *
 * Three positions, and the middle one means "change nothing". `normal` sends
 * NOT A SINGLE new field to the provider: an instance that has no use for
 * this knob must behave exactly as it did before the knob existed, and "we
 * always send reasoning: medium" is a quiet change of behavior for everyone,
 * including gateways that answer an unfamiliar field with a 400 in the middle
 * of a class.
 *
 * `instant` is not only a parameter: it also stands as a line in the system
 * frame ("answer right away, briefly, without reasoning aloud"). Half of the
 * models have no reasoning knob at all, and a request in words works on all
 * of them.
 */
export type ReasoningEffort = 'instant' | 'normal' | 'deep'

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['instant', 'normal', 'deep']

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
}

/**
 * The order of the positions — it decides who may change the setting.
 *
 * Anyone may lower it (that is cheaper and faster), only the teacher may
 * raise it: "detailed" for the whole class is paid for by the key's owner.
 */
export function effortRank(effort: ReasoningEffort): number {
  return effort === 'instant' ? 0 : effort === 'normal' ? 1 : 2
}

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
  /**
   * How many seconds between two questions from one person. 0 — off.
   *
   * Not the same as the hourly ceiling, and it lives next to it precisely for
   * that reason: twenty questions can be shouted out in twenty seconds, and
   * the ceiling would punish not the spam but the next real question — an
   * hour later. The gap stands where the spam is, and costs seconds.
   */
  slowModeSeconds: number
  /** Ceiling on the notebook text sent as context. */
  contextChars: number
  /** Tool actions per Do request; 0 means unlimited. */
  agentSteps: number
  /**
   * Whether students' REAL NAMES go to the model.
   *
   * On by default, and that is the owner's conscious choice: an oracle that
   * sees the class as labels S1…SN answers "S7 and S12 are stuck" — the
   * teacher reads that as a cipher, and when asked "write whom to go over
   * to", the model makes names up. With names it refers to people just as a
   * colleague would.
   *
   * Turned off, it restores the old behavior: labels go into the frame, and
   * the "label → person" mapping stays on the server. This is one instance
   * setting, not a room rule: it is about what goes to SOMEONE ELSE'S
   * provider, and it is decided by whoever owns the key, not whoever owns the
   * class.
   */
  sendNames: boolean
  /** The default reasoning level; a request may lower it, only the teacher may raise it. */
  reasoningEffort: ReasoningEffort
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
  slowModeSeconds?: number
  contextChars?: number
  agentSteps?: number
  sendNames?: boolean
  reasoningEffort?: ReasoningEffort
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
  /**
   * The gap between one person's questions, in seconds.
   *
   * Zero by default: slow mode is an answer to a particular class, not a
   * general rule, and turning it on silently for everyone would slow down the
   * rooms where nobody spammed. A five-minute ceiling is no longer "not so
   * fast" but "no oracle today"; the setting does not let anyone go past that
   * by mistake.
   */
  slowModeSeconds: { min: 0, max: 300, default: 0 },
  contextChars: { min: 2_000, max: 100_000, default: 20_000 },
  /**
   * How many actions the oracle takes in one turn in "do" mode.
   *
   * Zero still means "no limit" — that is the operator's choice, and it must
   * not be taken away. But it is no longer the default: a turn without a
   * ceiling that runs into a model which describes a call in prose instead of
   * making it keeps going to the provider until somebody presses "Stop" — and
   * the key's owner pays for it. Twenty-four is "look, read, create a
   * notebook, sketch a dozen cells, run a couple" with room to spare: real
   * work fits into it, an endless loop does not.
   */
  agentSteps: { min: 0, max: 10_000, default: 24 },
} as const

export const PROVIDER_PRESETS: Record<
  AiProviderId,
  { label: string; baseUrl: string; model: string }
> = {
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

/**
 * Providers whose runtime knows nothing about keys at all.
 *
 * Ollama and vLLM bring up an OpenAI-compatible endpoint of their own and do
 * not look at the authorization header: asking the teacher for a key to their
 * own machine means asking for a secret that does not exist.
 */
export const KEYLESS_PROVIDERS: readonly AiProviderId[] = ['ollama', 'vllm']

export function isKeylessProvider(provider: AiProviderId): boolean {
  return KEYLESS_PROVIDERS.includes(provider)
}

/**
 * Whether this instance has someone to ask: a key OR a local runtime with an
 * address.
 *
 * The only copy of the rule. There used to be two, and they drifted apart:
 * the server lets a question through by `providerReady()` (ai/provider.ts —
 * "a key, or a runtime that has no notion of a key"), while the panel
 * computed the room's ceiling from the key alone and, on a configured Ollama,
 * disabled "Hints only" and "Full answers" with the caption "the instance has
 * no key". The oracle answered all the while — the screen took away from the
 * teacher a setting that worked.
 *
 * `hasKey` is a separate field because the key itself does not travel to the
 * client: the server knows the string, the panel only the mask and "the key
 * came from the environment".
 */
export function providerConfigured(cfg: {
  provider: AiProviderId
  baseUrl: string
  hasKey: boolean
}): boolean {
  if (cfg.hasKey) return true
  // The server strips the trailing slash when reading settings
  // (resolveAiConfig), so '/' is not an address; the same here, otherwise the
  // two sides drift apart.
  return isKeylessProvider(cfg.provider) && cfg.baseUrl.trim().replace(/\/+$/, '').length > 0
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
  /** Creating under a name that is already taken: editing is a different request. */
  | 'exists'
  /**
   * This install cannot do that here: no Docker, no build context, or — for the
   * default — no .env, which stays on the host. The message says which.
   */
  | 'no_docker'
  | 'managed_environment'
  | 'building'
  | 'failed'
  /**
   * Not a refusal but "too early": a competition without answers, without
   * data or with an unchecked baseline solution cannot be opened. Separate
   * from 'invalid', because it is fixed not in this request but on the form,
   * and for this reason the panel highlights the relevant section.
   */
  | 'not_ready'
  /**
   * The request did not get through: no server, no network, the tunnel is
   * closed.
   *
   * Not from the server — the client composes it when fetch rejected its
   * promise. Separate from 'invalid', because "try again" makes sense here and
   * not there.
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
  /** Operator-published immutable image catalog, not an editable local build. */
  managed?: boolean
  image?: string
  revision?: string
  /** Also the filename and the image tag, so it is restricted to [a-z0-9-]. */
  name: string
  state: EnvironmentState
  /** Packages asked for, one per line, comments and pip flags dropped. */
  packages: string[]
  /** Size of the built image in bytes; null when there is nothing built. */
  imageBytes: number | null
  /** When the image was built; null when there is nothing built. */
  builtAt: number | null
  /**
   * True for the one a seminar created from here on will run.
   *
   * Not "what the whole instance runs on": an already created seminar keeps
   * its environment and survives a switch — otherwise changing the active
   * environment would recreate the kernel under a running class (see
   * AdminSeminar.environment).
   */
  active: boolean
  /** Last build's error, kept so a failure is readable after the log scrolls. */
  error: string | null
  /**
   * Which environment this image is built on top of — the line
   * `# colloq: from <name>` in the file's header; null means on top of the
   * ordinary base, like most.
   *
   * Shown because it explains two things at once: why torch is not in the
   * list although the room has it, and why "Needs rebuild" can appear on a
   * file nobody touched — the parent was rebuilt later.
   */
  parent: string | null
  /**
   * The environment asks for a GPU — with a `# colloq: gpu` line in its own
   * file's header or in the header of the one it is built on top of: the flag
   * is inherited together with the CUDA wheels.
   *
   * A property of the environment, not of the room: the torch wheels in it
   * are built for CUDA, and on a CPU such a room will not run at all. That is
   * why it is given a slice for the whole life of the container, while a room
   * on an ordinary environment never takes one.
   */
  gpu: boolean
  /**
   * Which Python the environment asks for — `'3.12'`: by its own
   * `# colloq: python` directive, and for a chain by the directive of its
   * ROOT, because the version comes from the base image and a layer on top
   * does not change it.
   *
   * An empty string means "unknown": that is what a published catalog that
   * did not name the version answers. Showing the default instead would mean
   * making it up.
   */
  python: string
  /**
   * Which Python is actually in the built image — `'3.12.7'`, from the
   * image's own PYTHON_VERSION variable; null if there is no image or it says
   * nothing.
   *
   * Separate from `python`, because they diverge in exactly the case this is
   * shown for: the file was edited after the build. To pip the directive is a
   * comment, `listChanged` does not see it, and without this pair
   * "Python 3.12" in the panel would stand over an image with 3.11.
   */
  pythonBuilt: string | null
}

/**
 * What this install can do with environments — as two questions, not one.
 *
 * A single reason for everything used to disable both buttons at once: under
 * `make up` the server sits in a container with no repository next to it,
 * and the panel refused both the build and changing the default — that is,
 * an environment could be built on a rented machine only over ssh. But a
 * build needs the docker client and the kernel directory (the client reads
 * the context), while the default needs .env, which stays on the host.
 * Different conditions, different buttons, different explanations.
 */
export interface EnvironmentAbilities {
  /** Build an environment's image from here. */
  canBuild: boolean
  /** Why not, when `canBuild` is false — shown instead of dead buttons. */
  cannotBuildReason: string | null
  /** Write `KERNEL_ENV` — that is, decide what new seminars will run on. */
  canSetDefault: boolean
  /** Why not: usually "this is done on the host", not "everything is broken". */
  cannotSetDefaultReason: string | null
}

export interface EnvironmentsState extends EnvironmentAbilities {
  managed?: boolean
  /** False when capacity has not been queried from the Kubernetes scheduler. */
  gpuCapacityKnown?: boolean
  environments: AdminEnvironment[]
  /** Legacy wire field, always false: shared production execution is disabled. */
  shared: boolean
  /**
   * GPU slices: how many are listed in KERNEL_GPUS and how many are free now.
   *
   * A slice is free when it is on no room's container — the server counts
   * this, because only it knows. `total: 0` is an ordinary install without
   * cards, not a breakage: the panel says so in words and does not alarm
   * anyone.
   */
  gpus: { total: number; free: number }
}

export interface SaveEnvironmentRequest {
  name: string
  /** The file's whole text, comments and all: this is an editor, not a form. */
  source: string
}

/** Same alphabet as a filename and a Docker tag, and short enough to read. */
export const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/

/**
 * Which environment this one is built on top of — the `# colloq: from <name>`
 * directive in the header, in the same form as `# colloq: gpu`.
 *
 * An environment has one layer, and any edit of the list installs all of it
 * over again. For an environment with torch that is three gigabytes of wheels
 * and nine minutes for an added timm. The directive moves the heavy part into
 * a shared layer: the parent is built once, and the children in seconds.
 *
 * The name is checked by the same expression as everywhere: it becomes both a
 * path to a file and an image tag. Not a name means not a directive; a
 * nonexistent environment can be named as a parent, though, and then the
 * build fails, naming it out loud.
 *
 * Here, not only on the server: the environment creation form decides by this
 * same line whether the Python version is inherited, and a second parse of
 * the same directive would drift from the first at the very first edit.
 */
export function declaresParent(source: string): string | null {
  for (const line of source.split('\n')) {
    const found = /^#\s*colloq:\s*from\s+(\S+)\s*$/i.exec(line.trim())
    if (found) return found[1] ?? null
  }
  return null
}

/* ------------------------------------------------------ Python version */

/**
 * The versions the form offers. Exactly those for which an official
 * `python:<version>-slim-bookworm` exists — the chain's root is built from it.
 *
 * The list is short on purpose: this is not "any version anyone writes" but
 * those on which the kernel (jupyter, numpy, pandas, matplotlib,
 * scikit-learn) really installs from wheels, without building from source in
 * the middle of a class.
 */
export const PYTHON_VERSIONS = ['3.10', '3.11', '3.12', '3.13'] as const

/**
 * What an environment that said nothing about Python is built on.
 *
 * Must match `ARG PARENT=python:…-slim-bookworm` in kernel/Dockerfile: that is
 * where this value takes effect when we do not pass PARENT. The match is
 * guarded by a test (environment-python.test.mts), not by an agreement.
 */
export const DEFAULT_PYTHON = '3.11'

/**
 * The `# colloq: python 3.12` line in the header — the same family as
 * `# colloq: gpu` and `# colloq: from <name>`: to pip it is a comment, to us a
 * property of the environment.
 *
 * Free text does not count as a version: it goes into the base image name
 * (`python:3.12-slim-bookworm`), and "3.12 or newer" does not exist there.
 * 3.9…3.13 is what is accepted at all; the form offers PYTHON_VERSIONS.
 */
const PYTHON_DIRECTIVE = /^#\s*colloq:\s*python\s+(\S+)\s*$/i
const PYTHON_LINE = /^#\s*colloq:\s*python\b/i
const PYTHON_VERSION = /^3\.(?:9|1[0-3])$/

/**
 * Which Python version this file asks for — or null if it asks for none.
 *
 * It is looked for among all comments, not only up to the first line with a
 * package: a directive added at the end of the file must work. The line is
 * compared whole — "# colloq: python do not touch" is not a directive, and
 * neither is "# colloq: python 2.7": there is no such slim image, and
 * silently building something else instead is worse than not seeing the
 * directive at all.
 */
export function declaresPython(source: string): string | null {
  for (const line of source.split('\n')) {
    const found = PYTHON_DIRECTIVE.exec(line.trim())
    const version = found?.[1]
    if (version !== undefined && PYTHON_VERSION.test(version)) return version
  }
  return null
}

/**
 * A line that LOOKS like a version directive but is not a version.
 *
 * Needed exactly so that the editor says so out loud:
 * `# colloq: python 3.8` is silently read as "nothing was said", and the
 * environment is built on the default — one can find that out from the build
 * log, but not from the screen.
 */
export function unreadablePython(source: string): string | null {
  for (const line of source.split('\n')) {
    const text = line.trim()
    if (!PYTHON_LINE.test(text) || declaresPython(text) !== null) continue
    return text
  }
  return null
}

/**
 * The same file, but asking for exactly this version.
 *
 * The default is not written as a directive: a file without the line and a
 * file with a line about 3.11 mean the same thing, and the second one also
 * lies if the default in the Dockerfile is raised one day. The old directive
 * is removed in any case — with two lines about the version in one header,
 * the first one would be read while a person edited the second.
 */
export function withPython(source: string, version: string): string {
  const kept = source.split('\n').filter((line) => !PYTHON_LINE.test(line.trim()))
  if (version === DEFAULT_PYTHON) return kept.join('\n')
  return [`# colloq: python ${version}`, ...kept].join('\n')
}

/** The base image of the chain's root. The name is assembled in one place — here. */
export function pythonImage(version: string): string {
  return `python:${version}-slim-bookworm`
}

/* --------------------------------------------------- import from GitHub */

/**
 * What a GitHub link will produce, computed without creating a room.
 *
 * Shown before the import on purpose: a teacher who pasted a link to a folder
 * wants to see "a hundred and ten cells and train.csv" BEFORE the seminar
 * appears, not after.
 */
export interface ImportPreview {
  /** A name derived from the file or folder name; it can be rewritten. */
  name: string
  notebook: string
  notebooks: { name: string; cells: number }[]
  cells: number
  files: { name: string; size: number }[]
  /**
   * Files that did not fit under the room's ceiling — by name.
   *
   * The total size is capped the same way as for an upload through the panel
   * (`server/src/routes/admin-import.ts` · withinRoomBudget), and the rest is
   * cut off before the room is even created. This has to be said here:
   * learning after the import that half the dataset did not arrive is too
   * late.
   */
  skipped: string[]
  /** owner/repo/path — so that it is visible where this came from. */
  source: string
}

export interface ImportResult {
  id: string
  name: string
  url: string
  cells: number
  files: string[]
  /** Files that could not be fetched: the name will not do or the download failed. */
  skipped: string[]
  createdBy: string | null
}
