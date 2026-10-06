/**
 * Competitions: types and rules shared by the server and the web app.
 *
 * A competition is a task with answers the participant does not see. They
 * send a NOTEBOOK, the server runs it from scratch in a disposable container
 * without network, takes the `submission.csv` it wrote and, in a second,
 * separate container, computes the teacher's metric on it. The metric is
 * called twice — on the public part of the rows and on the private one; the
 * public leaderboard is always visible, the private one is hidden until the
 * deadline so that nobody can fit to it.
 *
 * WHAT LIVES EXACTLY HERE, and not on the server. The rules on which both
 * sides must give one and the same answer: how many submissions are left
 * today (the participant sees the number in the upload area, the server
 * refuses by it), which submission counts, how the leaderboard is sorted and
 * how rows are split into the public and the private part. Once apart, these
 * copies do not crash — they quietly lie, and whoever notices is the one who
 * recomputed a place by hand.
 *
 * What is not here: a single access to the disk, the database or docker.
 * Everything below is pure functions and data, and so are the tests for them
 * (tests/competitions-rules).
 */
import { tr } from './i18n.js'
import { slugOk } from './publish.js'
import { dayStartIn } from './time-zone.js'

/* ---------------------------------------------------------- competition */

/**
 * Draft · live · finished.
 *
 * Three states, not a "published" flag: a draft has no address for
 * participants at all, a live one accepts submissions, and a finished one
 * turns its leaderboard into the final one, which no longer changes. The
 * `draft → live` transition is closed until the sample notebook has gone the
 * whole way to a number: a competition whose task even its author cannot
 * solve has nothing to open.
 */
export type CompetitionState = 'draft' | 'live' | 'finished'

/** Which way the metric points: MAPE down, ROC AUC up. */
export type MetricDirection = 'lower' | 'higher'

/** When the private leaderboard opens: by itself after the deadline, or by hand at the review. */
export type PrivateRelease = 'auto' | 'manual'

/**
 * What counts.
 *
 * `chosen` — the participant's choice (and silence counts as choosing "the
 * best on the public part"), `bestPublic` — the best on the public part,
 * `last` — the last one. The choice between "I trust the leaderboard" and "I
 * trust my own validation" is half the lesson, so by default the participant
 * chooses.
 */
export type ScoringRule = 'chosen' | 'bestPublic' | 'last'

/**
 * Who may see the leaderboard: anyone with the competition's link, or only
 * the people taking part in it (and staff).
 *
 * The rows are handles and email addresses, the rule the owner set so that a
 * teacher can find each person (see entrantHandle), and a university may not
 * be free to show a list of its students with their results to the internet.
 * `public` is the default and what every competition did before the setting
 * existed; `entrants` is for a course that has to keep the list inside the
 * class. Other people's addresses are shortened on the board either way
 * (maskEntrantName).
 */
export type BoardVisibility = 'public' | 'entrants'

export const BOARD_VISIBILITIES: readonly BoardVisibility[] = ['public', 'entrants']

/**
 * What a participant reads about a run that saw the hidden test (sealed
 * inputs, see FileVisibility).
 *
 * `brief` — the state, the failing cell and the exception's class, nothing the
 * notebook printed or raised: the participant's code had the hidden rows in
 * memory, and a traceback, an output or a metric message quoting the answer
 * is a way to carry them out. `full` — everything, as without a hidden test:
 * the teacher's call for a class where debugging matters more than the test.
 * Absent means `brief`, so a competition that gains a hidden test is blind
 * until someone decides otherwise.
 */
export type OutputPolicy = 'brief' | 'full'

export const OUTPUT_POLICIES: readonly OutputPolicy[] = ['brief', 'full']

/** The teacher's metric: the name in the column header, the direction and the `score` code itself. */
export interface CompetitionMetric {
  /** A short name — substituted into "FINAL {metric}". */
  name: string
  direction: MetricDirection
  /** Python: `def score(solution, submission) -> float`. Never sent to participants. */
  code: string
}

/** The limits of one run and a person's daily quota. */
export interface CompetitionLimits {
  /** The submission's overall time limit. Once it is up, the container is killed, no persuasion. */
  wallSeconds: number
  memoryMb: number
  cpus: number
  /** Submissions per day per participant; 0 — no limit. */
  perDay: number
}

export interface Competition {
  id: string
  /** The name in the address: `/k/<slug>`. */
  slug: string
  title: string
  /** One line — in the participant's list. */
  blurb: string
  /** Markdown: the task, the data, what to submit. */
  description: string
  state: CompetitionState
  metric: CompetitionMetric
  /** The share of rows scored right away, in percent. */
  publicPercent: number
  /**
   * The seed for splitting rows.
   *
   * Recorded in the competition row rather than taken from the clock: the
   * split must reproduce a month later on another machine — otherwise a
   * recomputation after a metric edit would change not only the numbers but
   * also which rows were public, and the whole past leaderboard would become
   * incomparable with the new one.
   */
  splitSeed: string
  limits: CompetitionLimits
  /** The image name: the same environment as a class kernel's. */
  environment: string
  startsAt: number | null
  deadlineAt: number | null
  privateRelease: PrivateRelease
  scoring: ScoringRule
  /** Who may see the leaderboard; absent means `public`, as before the setting existed. */
  boardVisibility?: BoardVisibility
  /**
   * «Поздние посылки»: after the deadline (or «Завершить сейчас») uploads are
   * still accepted, run and scored, and flagged late — never on a board, never
   * the counted one. Absent or false: intake closes at the deadline, as it
   * always did.
   */
  lateSubmissions?: boolean
  /** What a participant sees of a run on the hidden test; absent means `brief`. */
  outputPolicy?: OutputPolicy
  /** When the private leaderboard was opened (by itself or by hand); null — still closed. */
  privateOpenedAt: number | null
  /** The sample notebook's submission: it is also the "baseline" row on the leaderboard. */
  baselineSubmissionId: string | null
  /** Stable service identity, independent of the latest baseline notebook. */
  baselineEntrantId?: string | null
  /** Monotonic visible state and execution input revisions. */
  revision?: number
  inputRevision?: number
  /** Inputs visible to the notebook; metric-only checks cannot refresh this. */
  notebookInputRevision?: number
  createdBy: string | null
  /**
   * The course this competition belongs to; absent or null — none. Teachers
   * see a competition they created or one of a course they teach (the panel's
   * scope rule, server/src/competitions/scope.ts); nothing public reads it.
   */
  courseId?: string | null
  createdAt: number
  updatedAt: number
}

/**
 * A competition as a participant sees it.
 *
 * The metric code and the split seed do not get in here, and that is not a
 * matter of taste: from the seed and the share one can reconstruct exactly
 * which rows are public, and knowing that, an answer can be fitted to the
 * hidden part without solving the task.
 */
export type CompetitionPublic = Omit<Competition, 'metric' | 'splitSeed' | 'createdBy' | 'courseId'> & {
  metric: Omit<CompetitionMetric, 'code'>
}

export function publicCompetition(c: Competition): CompetitionPublic {
  // Who made it and which course holds it are the panel's business: the /k
  // pages stay exactly what they were before competitions had a course.
  const { metric, splitSeed: _seed, createdBy: _by, courseId: _course, ...rest } = c
  return { ...rest, metric: { name: metric.name, direction: metric.direction } }
}

/* ------------------------------------------------------------------ files */

/**
 * Open files a participant downloads and sees in the container as `data/`;
 * hidden ones never leave the competition's DATA_DIR and get only into the
 * metric container.
 *
 * `sealed` is the hidden TEST: a file the participant's notebook reads during
 * the check under its name in `data/` — in place of the open example of the
 * same name, if there is one — and that nobody downloads. It lives in its own
 * folder (storage.ts · sealedDir), and each run gets a fresh `data/` composed
 * from the open files with the sealed ones swapped in. A name may be open AND
 * sealed at once (the example and the test), which is why a file is keyed by
 * its visibility as well as its name.
 */
export type FileVisibility = 'open' | 'hidden' | 'sealed'

export interface CompetitionFile {
  competitionId: string
  name: string
  bytes: number
  /** Rows in the table — shown next to the name; null for non-CSV. */
  rows: number | null
  visibility: FileVisibility
  uploadedAt: number
}

/* ------------------------------------------------------------ participant */

/**
 * A competition participant is an INSTANCE-LEVEL entity, not a room one.
 *
 * A student's identity in a class lives in localStorage and is bound to the
 * session_id: come in from a phone and you are a different person. For a
 * competition that will not do, because submissions and a place must come
 * back on another device and a week later. Hence the "sign-in key" — exactly
 * the same mechanism as teachers' personal links (`staff.link_key`), and at
 * the same price: whoever knows the key is the participant. The teacher can
 * issue a new one; the old one stops working at once.
 */
export interface Entrant {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  /** The key was revoked (a new one issued) — the row lives on, the submissions stay. */
  disabled: boolean
}

/**
 * THE KEY IS NOT HERE, and that is not forgetfulness.
 *
 * `Entrant` travels to the browser — to its owner in `/api/k/me`, to the
 * teacher in the list of participants, to everyone as a leaderboard row.
 * While the key lay in a field of this record, a single overlooked
 * `res.json({ entrants })` handed the class each other's sign-ins, and one
 * could notice it only by reading the response. The secret is returned by
 * exactly two server doors — issuing and `entrantKeyOf` — and both are named
 * so that they stand out (server/src/competitions/key.ts · store.ts).
 */
export interface MintedEntrant {
  entrant: Entrant
  /** `K7Q-M2X-9FD`. Shown to its owner and nowhere else. */
  key: string
}

/**
 * The participant's cookie — their own, separate from the teachers'.
 *
 * Different cookies, not one role in one signature: a teacher who came to
 * `/k` to look through a student's eyes must stay a teacher in the
 * neighboring tab with the panel, and a participant must get nothing from the
 * fact that their browser once held `colloq_staff`.
 */
export const ENTRANT_COOKIE = 'colloq_k'

/** Where the "Sign-in link" leads: the page exchanges the key for the cookie. */
export const ENTRANT_SIGN_IN_PATH = '/k/t/'

/**
 * Why the `/api/k` door refused — as a word the screen branches on.
 *
 * `error` is read by a person, this one by code: after `key_disabled` the key
 * field offers to ask for a new one, after `key_unknown` to check the
 * letters; after `quota` the upload area goes dim until tomorrow, and after
 * `in_flight` until the current run ends. The refusal text cannot tell these
 * apart, and they do need telling apart.
 */
export type CompetitionRefusal =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'unavailable'
  /** The name is taken by a namesake in this competition. */
  | 'name_taken'
  | 'key_unknown'
  | 'key_disabled'
  /** The competition is still a draft or has not started yet. */
  | 'not_open'
  /** The deadline has passed or the teacher finished it early. */
  | 'closed'
  | 'not_joined'
  /** The previous submission is still in flight: one at a time. */
  | 'in_flight'
  | 'quota'
  /**
   * Too many FAILED submissions today (failedAttemptsCeiling). Not the daily
   * limit, and never called that: failures do not spend the limit, this is a
   * separate brake on endless free failures.
   */
  | 'attempts'
  | 'too_often'
  | 'too_big'
  /** The leaderboard is shown only to this competition's entrants and staff. */
  | 'board_closed'

export interface CompetitionErrorBody {
  error: string
  reason: CompetitionRefusal
}

/**
 * Whether submissions are being accepted right now.
 *
 * Four answers instead of one `boolean`: before the opening a person is told
 * "not open yet", after the deadline "submissions are closed", and those are
 * different screens. `late` is the fourth: intake is over, but the teacher
 * turned on «Поздние посылки», so an upload is still taken — as a late one,
 * outside the standings. A draft never gets here — it does not exist on `/k`.
 *
 * "Finish now" ends intake like a deadline does, so a finished competition
 * with late submissions on answers `late` too: the teacher closed the
 * standings, not the door.
 */
export function submissionsOpen(
  c: Pick<Competition, 'state' | 'startsAt' | 'deadlineAt' | 'lateSubmissions'>,
  now: number,
): 'open' | 'late' | 'not_open' | 'closed' {
  if (c.state === 'draft') return 'not_open'
  const over = c.lateSubmissions ? 'late' : 'closed'
  if (c.state === 'finished') return over
  if (c.startsAt !== null && now < c.startsAt) return 'not_open'
  if (c.deadlineAt !== null && now > c.deadlineAt) return over
  return 'open'
}

/** An upload door that takes a notebook right now, on time or late. */
export function acceptsUploads(accepting: ReturnType<typeof submissionsOpen>): boolean {
  return accepting === 'open' || accepting === 'late'
}

/**
 * Where a competition is in its life, as every list and header names it.
 *
 * The stored `state` moves only by a hand — «Открыть», «Завершить сейчас» —
 * and a deadline never touches it: past the deadline a competition is still
 * `live`, so that a deadline moved later reopens it with no second press.
 * Lists that sorted by `state` kept such a competition under «Идут сейчас»
 * with «приём закрыт» in its own row, and the teacher's console offered to
 * finish what had finished hours ago. The word a person reads is worked out
 * here, in the same order as `submissionsOpen`, so a page and a list never
 * disagree.
 *
 * Late intake is not a phase. An over competition with «Поздние посылки» on
 * is over — its standings are final — and carries the late mark beside the
 * word (`submissionsOpen` answers `late`).
 */
export type CompetitionPhase = 'draft' | 'soon' | 'open' | 'over'

export function competitionPhase(
  c: Pick<Competition, 'state' | 'startsAt' | 'deadlineAt'>,
  now: number,
): CompetitionPhase {
  if (c.state === 'draft') return 'draft'
  if (c.state === 'finished') return 'over'
  if (c.startsAt !== null && now < c.startsAt) return 'soon'
  if (c.deadlineAt !== null && now > c.deadlineAt) return 'over'
  return 'open'
}

/** The phase as a badge word: ИДЁТ, СКОРО, ЗАВЕРШЕНО, ЧЕРНОВИК. */
export function phaseWord(phase: CompetitionPhase): string {
  if (phase === 'soon') return tr('competitions.phase.soon')
  return competitionWord(phase === 'open' ? 'live' : phase === 'over' ? 'finished' : 'draft')
}

/**
 * A name brought to the form in which NAMESAKES are compared.
 *
 * "Namesakes on the leaderboard are not allowed" is a rule about the eye, not
 * about bytes: two rows "Анна Ким" and "анна  ким" read to a person as one
 * name, and people argue about whose place is higher. So case and extra
 * spaces do not count, and `ё` is folded into `е`: "Артём" and "Артем" in one
 * table are exactly the confusion the rule exists for.
 *
 * The normalization is here, but limiting the length is not: uniqueness is
 * checked by the database on this key, and the length is cut by
 * `LIMITS.entrantName` on input.
 */
export function entrantNameKey(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
}

/**
 * A Telegram username as Telegram itself spells it: 5 to 32 Latin letters,
 * digits and underscores, starting with a letter. The `@` is optional on
 * input: a username copied from a profile comes with it, one typed from
 * memory usually without.
 */
const TELEGRAM_USERNAME = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/

/**
 * A PLAUSIBLE email address, not an RFC 5322 parser: a dot-separated local
 * part, one `@`, a domain of dot-separated labels and a letter TLD of two or
 * more. Deliberately ASCII only. `аnna@mail.ru` with a Cyrillic «а» is a
 * different name key from `anna@mail.ru` yet the same row to the eye, which is
 * the one confusion the namesake rule exists to prevent (see entrantNameKey).
 * The classes are spelled out instead of an `i` flag so that no Unicode case
 * folding can let a look-alike letter in.
 */
const EMAIL = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/

/**
 * An entrant's name brought to its one stored form, or `null` if it is neither
 * a Telegram username nor an email address.
 *
 * WHY A HANDLE AND NOT "first and last name" — the owner's rule. A row on the
 * leaderboard has to point at one person the teacher can find and write to:
 * "Анна Ким" may be two people in a stream and a nickname is nobody, while a
 * username or an address is both. It is NOT verified: nothing checks that
 * the person owns the account or the mailbox, so it names someone reachable,
 * it does not prove who typed it.
 *
 * ONE STORED FORM, so that uniqueness holds: a username becomes `@` plus
 * lower case, an address lower case. `@Anya_Smirnova` and `anya_smirnova`
 * are then one string before `entrantNameKey` is even asked, and the
 * database refuses the second as a namesake. The case of an address's local
 * part is significant by the letter of the standard, and in practice ignored
 * by the mail services students use.
 *
 * The length is checked here and not only cut on write: the store clips a
 * name to `LIMITS.entrantName`, and a clipped address is no longer one — two
 * long ones sharing their first sixty characters would even become
 * namesakes. A username never gets near the limit.
 *
 * Only NEWLY TYPED names go through this. A person who joined before the rule
 * keeps their stored name (see nameForJoin), and the store does not check at
 * all: the service entrant of the baseline notebook is called by a localized
 * phrase.
 */
export function entrantHandle(input: string): string | null {
  const value = String(input ?? '').trim()
  const username = TELEGRAM_USERNAME.exec(value)
  if (username) return `@${username[1].toLowerCase()}`
  if (value.length > LIMITS.entrantName || !EMAIL.test(value)) return null
  return value.toLowerCase()
}

/**
 * The name a JOIN goes under, or `null` when the typed one will not do.
 *
 * `stored` is the signed-in entrant's current name, `null` for a newcomer.
 * One function for the server and the join form, so that the form never sends
 * a name the door turns away, nor refuses one it would take.
 *
 * Nobody is locked out by the rule. A person who joined under "Анна Ким"
 * before it and now presses JOIN in another competition keeps that name: an
 * empty field means "as I am", and so does the stored name sent back as is —
 * the form fills the field with it, and a tab opened before the rule sends it
 * anyway. The echo is recognised by the namesake key, not by bytes, because
 * "анна  ким" is the same name to the eye and to the database. Anything else
 * is a new name, and a new name has to be a handle.
 */
export function nameForJoin(typed: string, stored: string | null): string | null {
  const value = String(typed ?? '').trim()
  if (!value) return stored || null
  const handle = entrantHandle(value)
  if (handle) return handle
  if (stored && entrantNameKey(value) === entrantNameKey(stored)) return stored
  return null
}

/**
 * A name as OTHER people see it on a board: an email address keeps the first
 * three characters of its local part and its domain (`iva…@hse.ru`), a
 * Telegram username stays whole.
 *
 * Why the two differ. The owner's rule makes every name a handle a teacher
 * can reach the person by (entrantHandle), and for the teacher that is the
 * point. For the rest of the class, and for anyone with the link to a public
 * board, an address is a contact they were never given: a student list with
 * mailboxes is personal data at a university. A username is chosen to be
 * shown and is public by design. The domain stays because it says "hse.ru"
 * or "gmail.com" and nothing about the person; three letters stay so that a
 * student still finds a classmate they know. A local part of three
 * characters or fewer keeps one: three kept of `ann@…` would be all of it.
 *
 * Case is kept as it is written (a name from before the rule may carry
 * capitals), and characters are counted as code points, so a Cyrillic or an
 * emoji local part is never cut in half. Anything with a local part before
 * its last `@` is treated as an address even where the strict pattern would
 * not take it: a name from before the rule is not checked on the way to the
 * board, and a leak through a malformed address is still a leak. A name with
 * no `@` after its first character is not an address at all (a username, a
 * name from before the rule, the baseline's service name) and goes as it is.
 *
 * Only the display changes. Whoever may see full names — the person
 * themselves, staff — gets them from the same row (routes/competitions.ts ·
 * withNames); the database keeps one form.
 */
export function maskEntrantName(name: string): string {
  const value = String(name ?? '').trim()
  const at = value.lastIndexOf('@')
  if (at <= 0) return value
  const local = [...value.slice(0, at)]
  const kept = local.length <= 3 ? 1 : 3
  return `${local.slice(0, kept).join('')}…@${value.slice(at + 1)}`
}

/**
 * The key alphabet: without `O`, `0`, `I`, `1` and `L`.
 *
 * The key is dictated aloud and copied from a phone screen to a laptop. The
 * "zero — O" pair costs one trip to the teacher for a new key, and it is
 * cheaper not to issue it at all.
 */
export const ENTRANT_KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ENTRANT_KEY_GROUPS = 3
export const ENTRANT_KEY_GROUP_SIZE = 3

/**
 * Bring a key to canonical form or refuse.
 *
 * A person pastes it with spaces, in lower case and without dashes — all of
 * that is the same key. But a letter outside the alphabet is not a typo; it
 * is a different key, and guessing on the person's behalf is not allowed
 * here.
 */
export function normalizeEntrantKey(raw: string): string | null {
  const flat = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  const size = ENTRANT_KEY_GROUPS * ENTRANT_KEY_GROUP_SIZE
  if (flat.length !== size) return null
  for (const ch of flat) if (!ENTRANT_KEY_ALPHABET.includes(ch)) return null
  const groups: string[] = []
  for (let i = 0; i < size; i += ENTRANT_KEY_GROUP_SIZE) {
    groups.push(flat.slice(i, i + ENTRANT_KEY_GROUP_SIZE))
  }
  return groups.join('-')
}

export function entrantKeyOk(value: string): boolean {
  return normalizeEntrantKey(value) === value
}

/* ------------------------------------------------------------ submission */

/**
 * A submission's outcome — exactly the eight drawn in the mockup, and a
 * ninth.
 *
 * The ninth is `cancelled`: the "Cancel" button exists on a running and on a
 * queued submission, but the mockup has no badge for a withdrawn one. The
 * state must exist anyway, otherwise a withdrawn submission would hang
 * "IN QUEUE" forever.
 *
 * `rejected` ("ANSWER REJECTED") covers not only the metric's
 * `ParticipantVisibleError` but also "the notebook ran to the end and did not
 * write `submission.csv`" and "wrote it, but it cannot be read". The word for
 * the participant is one and the same, the reason differs, and it lies in
 * `participantError`: splitting badges by technical cause would mean
 * answering a person in the runner's vocabulary.
 */
export type SubmissionState =
  | 'queued'
  | 'running'
  | 'scored'
  | 'notebookFailed'
  | 'rejected'
  | 'timedOut'
  | 'outOfMemory'
  | 'metricFailed'
  | 'cancelled'

export const SUBMISSION_STATES: readonly SubmissionState[] = [
  'queued',
  'running',
  'scored',
  'notebookFailed',
  'rejected',
  'timedOut',
  'outOfMemory',
  'metricFailed',
  'cancelled',
]

/** The run's stages, in the order of the strip under a running submission (P2). */
export type SubmissionStage = 'accepted' | 'queue' | 'dependencies' | 'notebook' | 'check' | 'score'

export const SUBMISSION_STAGES: readonly SubmissionStage[] = [
  'accepted',
  'queue',
  'dependencies',
  'notebook',
  'check',
  'score',
]

/** Passed · going on now · not reached yet. */
export type StagePosition = 'done' | 'current' | 'ahead'

export interface Submission {
  /** Inputs used by the execution/score; null means legacy provenance is unknown. */
  inputRevision?: number | null
  notebookInputRevision?: number | null
  execution?: import('./dependencies.js').SubmissionEnvironment
  id: string
  competitionId: string
  entrantId: string
  /** The ordinal number WITHIN the competition: "#12" in the participant's list. */
  number: number
  fileName: string
  bytes: number
  acceptedAt: number
  state: SubmissionState
  /** How far it got: the stage at which the submission stands or stopped. */
  stage: SubmissionStage
  publicScore: number | null
  /** Not sent to the participant until the private leaderboard opens. */
  privateScore: number | null
  /** How long it ran, in milliseconds; null — still running or never started. */
  durationMs: number | null
  /** At which cell it ended and how many there were. */
  cellsDone: number
  cellsTotal: number
  /** What to show the participant: the ParticipantVisibleError text or the refusal's explanation. */
  participantError: string | null
  /** The traceback and everything else — for the teacher only. */
  teacherError: string | null
  /** Picked by its author to count. */
  chosen: boolean
  /**
   * The number of the submission that took this one's place in the queue
   * before it started; null — it was not replaced. A replaced submission is
   * `cancelled`: it never ran and does not count against the day.
   */
  replacedBy?: number | null
  /**
   * Accepted after intake ended, under «Поздние посылки». Decided in the
   * transaction that accepted it, by the moment its upload began (`sentAt`):
   * run and scored like any other, but never on a board, never the counted
   * one, never in a summary or the final results' wait. Absent on rows older
   * than the setting: those were all on time.
   *
   * One thing changes it afterwards, and only one way: the teacher moving the
   * deadline later clears it on what was sent before the new deadline
   * (store.ts · forgiveLateSubmissions). Nothing ever sets it after the fact.
   */
  late?: boolean
  /**
   * When its upload BEGAN — what the deadline is judged by. `acceptedAt` is
   * when the body finished arriving, up to the grace later, so lateness cannot
   * be read off it. Null on rows older than the column.
   */
  sentAt?: number | null
  /**
   * One of its notebook runs read the hidden test (sealed inputs). Sticky: an
   * answer, an executed notebook or a message produced on the hidden test
   * stays what it is after a rerun or a rescore, so the row stays blind for
   * the participant under the `brief` policy (isBlind).
   */
  sealedInputs?: boolean
  /**
   * What the participant reads in place of `participantError` when the row is
   * blind: our own words, the state and a cell number, nothing the notebook
   * or the metric quoted. Written next to the full text on every sealed run,
   * so switching the policy either way needs no rerun. The teacher's field;
   * the participant gets it only as `participantError` (entrantSubmission).
   */
  briefError?: string | null
  /**
   * The class of the exception a failed cell raised, when it is one of the
   * common ones (KeyError, ValueError, …); null otherwise. An allow-list, not
   * the traceback's own word: a notebook on the hidden test can name its own
   * exception class after the rows it read.
   */
  errorType?: string | null
}

/**
 * A submission as its author sees it.
 *
 * Two fields are not sent. `teacherError` is a traceback, and it is not for
 * the participant: "the error is in your code, not the participant's" (A3) is
 * read by whoever wrote the metric. And `privateScore` is computed from the
 * very first submission and sits in the same row as the public one — and if
 * it is handed out before the private leaderboard opens, the whole point of
 * splitting the test disappears: one could fit to the hidden part by
 * refreshing the page.
 *
 * A function, not a selection in SQL: the same rule applies to the submission
 * the upload returned, to the "My submissions" list and to a single row after
 * a recomputation — three places, any of which can be forgotten.
 */
export type EntrantSubmission = Omit<Submission, 'teacherError' | 'privateScore' | 'briefError'> & {
  privateScore: number | null
  /**
   * What the author's "download the notebook" link hands out, so that its
   * words can say it: the executed copy with the run's outputs, the notebook
   * as it was sent (the run reached no cell, or the run was blind), or nothing
   * (the files were swept). Absent where the answer did not look at the disk.
   */
  notebook?: 'executed' | 'sent' | null
  /**
   * The run saw the hidden test and the competition shows such runs briefly:
   * `participantError` is our own words only, there is no executed notebook,
   * and the page says why the details are missing.
   */
  blind?: boolean
}

/**
 * Whether a participant sees this submission briefly: it ran on the hidden
 * test, and the competition's policy is not `full`.
 *
 * Decided where the answer is assembled, not where the run ends: the full
 * texts are kept for the teacher either way, so the policy can be switched
 * without running anything again.
 */
export function isBlind(
  c: Pick<Competition, 'outputPolicy'>,
  s: Pick<Submission, 'sealedInputs'>,
): boolean {
  return !!s.sealedInputs && (c.outputPolicy ?? 'brief') !== 'full'
}

export function entrantSubmission(s: Submission, privateOpen: boolean, blind = false): EntrantSubmission {
  const { teacherError: _trace, briefError, ...rest } = s
  const out: EntrantSubmission = { ...rest, privateScore: privateOpen ? s.privateScore : null }
  if (!blind) return out
  // The brief words replace the full ones, never sit beside them. The run
  // time goes out in whole seconds: milliseconds are a side channel into the
  // hidden test (a loop that sleeps on a row's value), seconds are what a
  // person needs.
  const durationMs = s.durationMs === null ? null : Math.round(s.durationMs / 1000) * 1000
  return { ...out, durationMs, participantError: briefError ?? null, blind: true }
}

/**
 * The executed copy of a submitted notebook: the participant's own cells with
 * the outputs of every cell the run reached — and nothing of the metric's.
 *
 * One name from the harness that writes it to the doors that hand it out
 * (harness.ts, docker-runner.ts, the broker's exporter, storage.ts). The
 * doors once asked for the name of the SENT notebook instead, found nothing
 * and handed out the sent one: every download came without a single output.
 */
export const EXECUTED_NOTEBOOK_FILE = 'executed.ipynb'

/**
 * Why the uploaded file is not a notebook.
 *
 * Checked HERE, before the queue, and not for taste: the notebook is read by
 * `nbformat` in a disposable container, and broken JSON there becomes
 * "notebook failed" — that is, a verdict on code the person did not write,
 * and a slot of everyone's queue spent on it. The check is cheap and answers
 * in words about the file.
 *
 * Exactly as strict as a real notebook from someone else's Jupyter will
 * survive: an object, a list of cells, each cell with its own `cell_type`.
 * Where the cells are depends on the format, and that is all the version is
 * looked at for: `nbformat.read` upgrades an old notebook itself
 * (notebookCellList).
 *
 * A byte order mark is not this function's business: the door cuts it off
 * the bytes before they are checked AND stored (server/src/competitions/
 * intake.ts · intakeNotebook), so what passes here is what nbformat reads.
 *
 * A notebook without a single cell is refused here too, although it is a
 * valid notebook. It cannot write `submission.csv`, so the queue could only
 * give it a slot, a container and, seconds later, "the notebook left no
 * file" — a sentence that sends the person looking for a bug in code they
 * never sent. Such a file is almost always a notebook saved before the work
 * was, and that is what the refusal says.
 */
export function whyNotebookRefused(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return tr('competitions.refusal.notJson')
  }
  const cells = notebookCellList(parsed)
  if (!cells) return tr('competitions.refusal.notNotebook')
  if (cells.length === 0) return tr('competitions.refusal.noCells')
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object' || typeof (cell as { cell_type?: unknown }).cell_type !== 'string') {
      return tr('competitions.refusal.brokenCell')
    }
  }
  return null
}

/**
 * The cells `nbformat.read(…, as_version=4)` will hand to the kernel, or null
 * when the JSON has no place for cells at all.
 *
 * nbformat 4 keeps them in `cells`. nbformat 3 (IPython 1 and 2, and the
 * converters that still write it) keeps them in `worksheets[].cells`, and so
 * does nbformat 2 before it. The harness's read upgrades both to 4 by
 * flattening the worksheets in order (nbformat/v4/convert.py · upgrade), so
 * they are counted that way here: refusing them said "the file has no cells"
 * about a notebook the harness runs without complaint. A worksheet without a
 * `cells` list of its own does not survive that upgrade, and is not a place
 * for cells here either.
 *
 * Without an `nbformat` number the file goes the version 4 way, as it always
 * did at this door.
 */
export function notebookCellList(parsed: unknown): unknown[] | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const notebook = parsed as { nbformat?: unknown; cells?: unknown; worksheets?: unknown }
  if (notebook.nbformat === 2 || notebook.nbformat === 3) {
    if (!Array.isArray(notebook.worksheets)) return null
    const cells: unknown[] = []
    for (const sheet of notebook.worksheets) {
      const own = (sheet as { cells?: unknown } | null)?.cells
      if (!Array.isArray(own)) return null
      for (const cell of own) cells.push(cell)
    }
    return cells
  }
  return Array.isArray(notebook.cells) ? notebook.cells : null
}

/**
 * A run is ONE trip into a container, and a submission has several of them.
 *
 * A row per stage, not per submission, for the sake of the one thing the
 * mockup promises: "after a metric edit everything is recomputed without
 * running the notebooks again". A recomputation creates a new run of kind
 * `metric` next to the earlier `notebook` one, and the notebook is not run a
 * second time. "Run again" from the row menu lands here too.
 */
export type RunKind = 'notebook' | 'metric'

/**
 * The runner's words — exactly those the harness writes in `run.json` and
 * `score.json` (see the prototype: harness/run_notebook.py,
 * harness/score_metric.py). Here they are neither translated nor
 * embellished: turning them into a state is the job of one function below,
 * and everything else looks at the state.
 */
export type RunVerdict =
  | 'ok'
  | 'cell_error'
  | 'cell_timeout'
  | 'kernel_died'
  | 'exit'
  | 'target_too_large'
  | 'target_unreadable'
  | 'harness_error'
  | 'dependency_error'
  | 'no-submission'
  | 'out-of-memory'
  | 'timeout'
  | 'participant_error'
  | 'metric_error'
  | 'unknown'

export interface SubmissionRun {
  attemptId?: string | null
  inputRevision?: number | null
  id: string
  submissionId: string
  /** The run's ordinal number within the submission. */
  seq: number
  kind: RunKind
  startedAt: number
  finishedAt: number | null
  verdict: RunVerdict | null
  /** The container's name — it is killed by this name and looked up by it in the docker log. */
  container: string | null
  exitCode: number | null
  oom: boolean
  cellsDone: number
  cellsTotal: number
  publicScore: number | null
  privateScore: number | null
  participantError: string | null
  teacherError: string | null
}

/**
 * What the runner's word turns into.
 *
 * The order of parsing is the same as in the prototype (`drive.py` ·
 * verdict_of), and it is also the only copy of the rule: a kill for memory
 * and for time outranks everything the harness managed to write, and "no
 * file" comes before its `status`, otherwise a submission that came back
 * empty-handed would count as a success.
 */
export function stateOfVerdict(kind: RunKind, verdict: RunVerdict): SubmissionState {
  if (verdict === 'out-of-memory') return 'outOfMemory'
  if (verdict === 'timeout' || verdict === 'cell_timeout') return 'timedOut'
  if (kind === 'metric') {
    if (verdict === 'ok') return 'scored'
    // ParticipantVisibleError is the only metric error the participant reads
    // verbatim; any other means the teacher's code crashed.
    return verdict === 'participant_error' ? 'rejected' : 'metricFailed'
  }
  switch (verdict) {
    case 'ok':
      return 'running'
    case 'no-submission':
    case 'target_too_large':
    case 'target_unreadable':
    case 'dependency_error':
      // The notebook ran but there is no answer or it is unreadable — that is a
      // refusal to the participant, not a notebook failure: no failing cell is
      // involved.
      return 'rejected'
    case 'cell_error':
    case 'kernel_died':
    case 'exit':
      return 'notebookFailed'
    default:
      // harness_error and unknown: the harness is to blame, not the
      // participant, and it is for the teacher to sort out. Showing a person
      // "notebook error" is not allowed.
      return 'metricFailed'
  }
}

/** Whether the submission has reached the end of the road — in any sense, including a bad one. */
export function isTerminal(state: SubmissionState): boolean {
  return state !== 'queued' && state !== 'running'
}

/* ---------------------------------------------------- words for states */

/** The badge's tone — per the mockup's "Status badges" table. */
export type BadgeTone = 'accent' | 'positive' | 'danger' | 'warning' | 'neutral'

/**
 * The form: filled with a pale background, filled with a saturated color, or
 * outlined. "METRIC FAILED" and "RUNNING" are the only saturated ones.
 */
export type BadgeForm = 'filled' | 'strong' | 'outline'

export interface SubmissionBadge {
  word: string
  tone: BadgeTone
  form: BadgeForm
}

/**
 * A submission's badge AS THE PARTICIPANT SEES IT.
 *
 * `null` means no badge at all, and that is not an omission: a crashed metric
 * code is at fault before the participant, not the other way round, and their
 * row carries a phrase (`METRIC_FAILED_NOTE`), not a label.
 */
export function entrantBadge(state: SubmissionState): SubmissionBadge | null {
  switch (state) {
    case 'running':
      return { word: tr('competitions.entrant.running'), tone: 'accent', form: 'strong' }
    case 'queued':
      return { word: tr('competitions.entrant.queued'), tone: 'accent', form: 'outline' }
    case 'scored':
      return { word: tr('competitions.entrant.scored'), tone: 'positive', form: 'filled' }
    case 'notebookFailed':
      return { word: tr('competitions.entrant.notebookFailed'), tone: 'danger', form: 'filled' }
    case 'rejected':
      return { word: tr('competitions.entrant.rejected'), tone: 'warning', form: 'filled' }
    case 'timedOut':
      return { word: tr('competitions.entrant.timedOut'), tone: 'danger', form: 'filled' }
    case 'outOfMemory':
      // The participant's mockup has no such badge — only the teacher's case is
      // drawn. Staying silent is not an option: a submission killed for memory
      // must name itself, otherwise it looks lost. The word is borrowed from
      // the teacher's set.
      return { word: tr('competitions.entrant.outOfMemory'), tone: 'danger', form: 'filled' }
    case 'cancelled':
      return { word: tr('competitions.entrant.cancelled'), tone: 'neutral', form: 'filled' }
    case 'metricFailed':
      return null
  }
}

/**
 * A submission's badge AS THE TEACHER SEES IT.
 *
 * `null` for a running and a queued one: they are not in the A3 table, they
 * live in the queue block above ("RUNNING NOW" and "WAITING · N"), and
 * naming them with a badge a second time would show the same thing twice in
 * different words.
 */
export function teacherBadge(state: SubmissionState): SubmissionBadge | null {
  switch (state) {
    case 'scored':
      return { word: tr('competitions.teacher.scored'), tone: 'positive', form: 'filled' }
    case 'notebookFailed':
      return { word: tr('competitions.teacher.notebookFailed'), tone: 'danger', form: 'filled' }
    case 'rejected':
      return { word: tr('competitions.teacher.rejected'), tone: 'warning', form: 'filled' }
    case 'timedOut':
      return { word: tr('competitions.teacher.timedOut'), tone: 'danger', form: 'filled' }
    case 'outOfMemory':
      return { word: tr('competitions.teacher.outOfMemory'), tone: 'danger', form: 'filled' }
    case 'metricFailed':
      // The only saturated red badge in the product: it is seen only by the
      // person who can fix it.
      return { word: tr('competitions.teacher.metricFailed'), tone: 'danger', form: 'strong' }
    case 'cancelled':
      return { word: tr('competitions.teacher.cancelled'), tone: 'neutral', form: 'filled' }
    case 'queued':
    case 'running':
      return null
  }
}

/** A phrase instead of a badge — what the participant reads on a submission whose metric crashed. */
export function metricFailedNote(): string {
  return tr('competitions.metricFailedNote')
}

/** The competition's state as a word: "DRAFT", "LIVE", "FINISHED". */
export function competitionWord(state: CompetitionState): string {
  return tr(`competitions.state.${state}`)
}

/** The label of a run stage. */
export function stageWord(stage: SubmissionStage): string {
  if (stage === 'dependencies') return tr('dependencies.installing')
  return tr(`competitions.stage.${stage}`)
}

/** The metric's direction in words (A1, A2, P2, P3). */
export function directionWord(direction: MetricDirection): string {
  return tr(`competitions.direction.${direction}`)
}

/** The metric's direction as a sign: `MAPE ↓`, `ROC AUC ↑` (P1, P4). Not a translation, an arrow. */
export const DIRECTION_ARROW: Record<MetricDirection, string> = { lower: '↓', higher: '↑' }

/**
 * Where a submission stands on the stage strip.
 *
 * One that reached the end is all green: "SCORING" on a finished submission
 * is passed, not in progress. A failed one paints everything up to the stage
 * where it died as passed, and leaves that stage itself current — that is
 * where to look for the reason.
 */
export function stagePosition(
  state: SubmissionState,
  at: SubmissionStage,
  stage: SubmissionStage,
): StagePosition {
  const here = SUBMISSION_STAGES.indexOf(at)
  const asked = SUBMISSION_STAGES.indexOf(stage)
  if (asked < here) return 'done'
  if (asked > here) return 'ahead'
  return state === 'scored' ? 'done' : 'current'
}

/* ---------------------------------------------------------------- address */

/**
 * Why this name will not do as an address — as a word, not "false".
 *
 * A refusal "the address does not fit" sends the teacher trying letters one
 * by one; a `reserved` refusal they read once and never come back here.
 */
export type SlugRefusal = 'empty' | 'chars' | 'reserved'

/**
 * Names taken by things other than competitions.
 *
 * `t` is the sign-in by key (`/k/t/<key>`), and a competition at that address
 * would take away from every participant the way to come back. The check is
 * here, not in the router: by the time the route gets involved, the address
 * has already been handed out to the class.
 */
export const RESERVED_SLUGS: readonly string[] = ['t', 'new']

/**
 * Bring a name to an address or refuse.
 *
 * The letter rule is one for the whole product (`shared/publish.ts` ·
 * slugOk): only lowercase letters, digits and a dash, because an address is
 * dictated aloud and written on the blackboard. There is deliberately no copy
 * of the regex here — once apart, they would give a course and a competition
 * different ideas of what an address is.
 */
export function parseSlug(raw: string): string | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!slugOk(value) || RESERVED_SLUGS.includes(value)) return null
  return value
}

export function slugRefusal(raw: string): SlugRefusal | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return 'empty'
  if (RESERVED_SLUGS.includes(value)) return 'reserved'
  return slugOk(value) ? null : 'chars'
}

/** The address of the competition's page for participants. */
export function competitionPath(slug: string): string {
  return `/k/${slug}`
}

/* -------------------------------------------------- daily submission quota */

/** Everything needed to decide whether a submission counts against the day. */
export interface QuotaEntry {
  acceptedAt: number
  state: SubmissionState
}

/**
 * Whether a submission counts against the daily quota.
 *
 * ONLY A SCORE SPENDS ONE. The limit exists so that nobody fits the public
 * board by sending forty variants a day, and only a number on that board
 * carries what the limit protects. A failed notebook (any cell, the time or
 * memory limit), a rejected answer, a crashed check (the teacher's metric, or
 * our own breakage: a runner that threw, a run cut off by restarts) and a
 * cancelled or replaced submission give nothing to fit by, so they are free.
 * Until 4 Oct 2026 every failure past the first cell counted, and two crashes
 * on a classroom morning used up a day of a limit of two — including crashes
 * of the teacher's own metric.
 *
 * A queued one and a running one do hold a place: otherwise one person would
 * queue a hundred notebooks, and the daily quota would start working
 * retroactively. A failure gives the place back.
 *
 * Endless free failures have their own brake (failedAttemptsCeiling).
 */
export function countsTowardDailyQuota(entry: Pick<QuotaEntry, 'state'>): boolean {
  return entry.state === 'scored' || !isTerminal(entry.state)
}

/**
 * Whether a finished submission is a FAILED attempt for the day's ceiling.
 *
 * The outcomes the participant's notebook decides: a failed cell, the time or
 * memory limit, an answer that is missing or refused. Not `metricFailed`: that
 * is the teacher's metric or our own machinery, never the participant's
 * doing. Not `cancelled`: withdrawing, replacing a waiting one or the
 * teacher's "drop" is a person's act, not an outcome of the notebook.
 */
export function countsTowardFailedAttempts(entry: Pick<QuotaEntry, 'state'>): boolean {
  return entry.state === 'notebookFailed' || entry.state === 'timedOut'
    || entry.state === 'outOfMemory' || entry.state === 'rejected'
}

/**
 * How many failed submissions a person may have in one day; null — no ceiling.
 *
 * Once failures stopped spending the limit, nothing but "one at a time" was
 * left between a person and a whole day of crashing runs, each holding a slot
 * of the instance's queue; and with a hidden test, every failure tells a
 * little about it (its cell, its time). Generous on purpose: three times the
 * limit and never fewer than ten, so a student debugging honestly does not
 * meet it. None when the limit itself is off (0): the teacher said "no
 * limit", and a ceiling they never set would be one.
 */
export function failedAttemptsCeiling(perDay: number): number | null {
  if (!Number.isFinite(perDay) || perDay <= 0) return null
  return Math.max(10, 3 * Math.floor(perDay))
}

/**
 * The start of the day for the moment `at`, in the zone named `timeZone`.
 *
 * A zone NAME (`Europe/Moscow`), not a number and not the browser's clock: a
 * competition's day is the day of the classroom where it is held (the mockup
 * writes "23:59 MSK"), half the class has its clock set any old way, and a
 * fixed offset is an hour off for half the year wherever clocks move. The
 * server decides which zone is the instance's (server/src/time-zone.ts) and
 * says it to the page along with the numbers.
 */
export function dayStart(at: number, timeZone: string): number {
  return dayStartIn(at, timeZone)
}

/**
 * The first moment from which a submission accepted at `acceptedAt` counts
 * toward TODAY, as of `now`.
 *
 * Normally the start of today in the instance's zone. `zoneSince` is the
 * moment the instance began counting days in its zone at all: until then the
 * limit reset at UTC midnight. A submission accepted before that moment is
 * held to BOTH days, the later start winning, so that switching the rule in
 * the middle of a competition takes nothing from anyone. In Moscow the new day
 * begins three hours before the old one did, and without this a student who
 * sent five notebooks between midnight and three at night (yesterday by the
 * old rule) would find the day already spent the moment the server was
 * updated. With it, the update itself changes nobody's count, and every later
 * midnight in the zone is a full reset. After the first day nothing accepted
 * before `zoneSince` is inside either window, and the rule is the plain one.
 */
export function quotaDayStart(acceptedAt: number, now: number, timeZone: string, zoneSince: number | null = null): number {
  const today = dayStart(now, timeZone)
  if (zoneSince === null || acceptedAt >= zoneSince) return today
  return Math.max(today, dayStart(now, 'UTC'))
}

/**
 * How many submissions a person has left today; `null` — there is no limit.
 *
 * Never negative: the teacher can lower the quota in the middle of the day,
 * and "−2 left" on a participant's screen is not a number but an accusation.
 * The day is `timeZone`'s, with submissions from before `zoneSince` held to
 * the old UTC day as well (quotaDayStart).
 */
export function submissionsLeftToday(
  perDay: number,
  entries: readonly QuotaEntry[],
  now: number,
  timeZone: string,
  zoneSince: number | null = null,
): number | null {
  if (!Number.isFinite(perDay) || perDay <= 0) return null
  let used = 0
  for (const entry of entries) {
    if (inQuotaDay(entry, now, timeZone, zoneSince) && countsTowardDailyQuota(entry)) used += 1
  }
  return Math.max(0, Math.floor(perDay) - used)
}

/** Whether a submission belongs to today's count, by the day `quotaDayStart` draws. */
function inQuotaDay(entry: Pick<QuotaEntry, 'acceptedAt'>, now: number, timeZone: string, zoneSince: number | null): boolean {
  return entry.acceptedAt <= now && entry.acceptedAt >= quotaDayStart(entry.acceptedAt, now, timeZone, zoneSince)
}

/** How many of today's submissions failed (countsTowardFailedAttempts), by the quota's own day. */
export function failedAttemptsToday(
  entries: readonly QuotaEntry[],
  now: number,
  timeZone: string,
  zoneSince: number | null = null,
): number {
  return entries.filter((entry) => inQuotaDay(entry, now, timeZone, zoneSince) && countsTowardFailedAttempts(entry)).length
}

/**
 * How many more failed submissions today before the ceiling refuses; null —
 * there is no ceiling (failedAttemptsCeiling). Never negative, for the same
 * reason as the limit: the teacher may lower it in the middle of the day.
 */
export function attemptsLeftToday(
  perDay: number,
  entries: readonly QuotaEntry[],
  now: number,
  timeZone: string,
  zoneSince: number | null = null,
): number | null {
  const ceiling = failedAttemptsCeiling(perDay)
  if (ceiling === null) return null
  return Math.max(0, ceiling - failedAttemptsToday(entries, now, timeZone, zoneSince))
}

/* ----------------------------------------------- what counts, and places */

/** A submission as the counting and leaderboard rules see it. */
export interface BoardEntry {
  id: string
  number: number
  acceptedAt: number
  state: SubmissionState
  publicScore: number | null
  privateScore: number | null
  chosen: boolean
  /** A late submission (Submission.late): never counted, whatever the rule. */
  late?: boolean
}

/** Whether a submission is fit for the leaderboard: it reached a number, and the number is real. */
export function hasScore(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Which is better: `-1` if `a` ranks above `b`.
 *
 * A tie is broken by time — "on equal results the submission sent earlier
 * ranks higher" (footnote on P3), and the place follows the order (see
 * `placesByScore`). The rule is not cosmetic: without it the order would
 * depend on how the database returned the rows, and a participant's place
 * would change between two page refreshes.
 */
export function compareScores(
  a: { score: number; at: number },
  b: { score: number; at: number },
  direction: MetricDirection,
): number {
  if (a.score !== b.score) {
    return direction === 'lower' ? a.score - b.score : b.score - a.score
  }
  return a.at - b.at
}

/**
 * Which of a participant's submissions counts.
 *
 * `chosen` with the caveat from the mockup: "If they pick none, the best on
 * the public part is taken". The caveat lives here, not in the markup,
 * because the server builds the final leaderboard with this same function.
 *
 * `last` is the last one that REACHED A NUMBER, not the last one sent: a
 * failed notebook has nothing to put on the leaderboard, and "last" in that
 * case would mean a participant dropping out of the table over one unlucky
 * submission before bedtime.
 */
export function countedSubmission(
  rule: ScoringRule,
  entries: readonly BoardEntry[],
  direction: MetricDirection,
): BoardEntry | null {
  // A late one is outside the standings under every rule: the final board is
  // the board as intake left it, and a fix sent after the deadline is not in it.
  const scored = entries.filter((e) => e.state === 'scored' && hasScore(e.publicScore) && !e.late)
  if (scored.length === 0) return null
  if (rule === 'chosen') {
    const picked = scored.find((e) => e.chosen)
    if (picked) return picked
  }
  if (rule === 'last') {
    return scored.reduce((best, e) =>
      e.acceptedAt > best.acceptedAt || (e.acceptedAt === best.acceptedAt && e.number > best.number)
        ? e
        : best,
    )
  }
  return scored.reduce((best, e) =>
    compareScores(
      { score: e.publicScore as number, at: e.acceptedAt },
      { score: best.publicScore as number, at: best.acceptedAt },
      direction,
    ) < 0
      ? e
      : best,
  )
}

/** A leaderboard row before places are assigned. */
export interface BoardRow {
  entrantId: string
  submissionId: string
  score: number
  at: number
}

export type RankedRow = BoardRow & { place: number }

/**
 * A row with its place put in — replacing whatever `place` it came with: a
 * store row counted the baseline, and `T & { place }` would keep claiming
 * that old `number` for a row that now says null.
 */
export type Placed<T, P = number> = Omit<T, 'place'> & { place: P }

/**
 * Places over rows already in board order: every row its own place, 1, 2, 3,
 * 4, 5, and between equal scores the earlier submission is higher — the way
 * Kaggle ranks.
 *
 * For a day (29–30 Sep 2026) equal scores shared the smallest place, as the
 * seminar's rules text describes the teacher's own prize script. On the board
 * that read as six people in seventh place, which is not a ranking at all:
 * the teacher asked for distinct places, and the prize script keeps its own
 * rule. Equal means exactly equal numbers; the order between them is the
 * board's, earlier submission first.
 *
 * Every place a person is shown comes from here (directly or through
 * `placesAmongPeople`): the header, the list, the teacher's screen and the
 * shift arrows must all read the same number off the same row.
 */
export function placesByScore<T extends { score: number }>(rows: readonly T[]): Placed<T>[] {
  return rows.map((row, index) => ({ ...row, place: index + 1 }))
}

/**
 * Places among PEOPLE on a board that has the baseline's row in it.
 *
 * People get the places `placesByScore` gives them among themselves: the
 * baseline is not an entrant and takes no place from anyone. Its own row
 * gets the place it WOULD take among them — one after everyone above it in
 * the board's order.
 *
 * A baseline with nobody above it gets no place at all (null, a dash on
 * screen): a "1" in its row next to the first person's "1" reads as a race
 * for first place, and the news in that spot is that no submission is
 * better than the baseline yet.
 */
export function placesAmongPeople<T extends { score: number }>(
  rows: readonly T[],
  isBaseline: (row: T) => boolean,
): Placed<T, number | null>[] {
  const people = placesByScore(rows.filter((row) => !isBaseline(row)))
  let seen = 0
  return rows.map((row) => {
    if (!isBaseline(row)) return people[seen++]
    return { ...row, place: seen === 0 ? null : seen + 1 }
  })
}

/**
 * Assign places: the board's order, then places by that order.
 *
 * "YOUR PLACE 2 of 28" reads against the length of the table.
 */
export function rankBoard(rows: readonly BoardRow[], direction: MetricDirection): RankedRow[] {
  return placesByScore([...rows].sort((a, b) => compareScores(a, b, direction)))
}

/**
 * The leaderboard of one part of the test: one counted submission per person.
 *
 * Computed from the PUBLIC numbers even for the final table, and that is not
 * a typo: the counting rule picks a submission by what the participant saw,
 * and the private number is merely substituted into the chosen one.
 * Otherwise the final result would be computed on a submission the person
 * did not choose and could not see.
 */
export function boardOf(
  people: readonly { entrantId: string; entries: readonly BoardEntry[] }[],
  rule: ScoringRule,
  direction: MetricDirection,
  part: 'public' | 'private',
): RankedRow[] {
  const rows: BoardRow[] = []
  for (const person of people) {
    const counted = countedSubmission(rule, person.entries, direction)
    if (!counted) continue
    const score = part === 'public' ? counted.publicScore : counted.privateScore
    if (!hasScore(score)) continue
    rows.push({
      entrantId: person.entrantId,
      submissionId: counted.id,
      score,
      at: counted.acceptedAt,
    })
  }
  return rankBoard(rows, direction)
}

/** A person's place in the finished table, or null — they are not in it. */
export function placeOf(rows: readonly RankedRow[], entrantId: string): number | null {
  return rows.find((row) => row.entrantId === entrantId)?.place ?? null
}

/**
 * How far a person moved between the public and the final leaderboard.
 *
 * Positive — moved up (`▲`), negative — moved down (`▼`), zero — stayed
 * (`—`). `null` if they are missing from one of the tables: "moved up 7
 * places" out of nowhere is not a fact but an invention.
 *
 * Both places are the numbers the two tables print (`placesByScore`, among
 * people): the arrow is the difference of the two numbers the person reads.
 */
export function placeShift(publicPlace: number | null, privatePlace: number | null): number | null {
  if (publicPlace === null || privatePlace === null) return null
  return publicPlace - privatePlace
}

type ReleaseFields = Pick<Competition, 'state' | 'privateRelease' | 'deadlineAt' | 'privateOpenedAt'>

/** Intake is over: the deadline passed, or the teacher pressed "Finish now". */
function intakeOver(c: Pick<Competition, 'state' | 'deadlineAt'>, now: number): boolean {
  return c.state === 'finished' || (c.deadlineAt !== null && now >= c.deadlineAt)
}

/**
 * Whether the automatic release is waiting for results right now.
 *
 * Intake is over, the board opens by itself, and nobody has opened it by
 * hand: only then is the number of unfinished submissions worth counting at
 * all (competitions/results.ts on the server).
 */
export function privateBoardAwaits(c: ReleaseFields, now: number): boolean {
  return c.privateOpenedAt === null && c.privateRelease === 'auto' && intakeOver(c, now)
}

/**
 * Whether the private leaderboard is open.
 *
 * `auto` opens it once intake is over AND every submission accepted before
 * that has a result: a board opened with thirty notebooks still in the queue
 * keeps changing under the eyes of people who already read it as final.
 * `manual` opens only by the teacher's hand, and no deadline will do it for
 * them: the whole value of the review is that they name the places
 * themselves.
 *
 * `pending` is how many of those results are still being counted. The server
 * knows it; a caller that passes nothing gets the plain rule "open at the
 * deadline".
 */
export function privateBoardOpen(c: ReleaseFields, now: number, pending = 0): boolean {
  if (c.privateOpenedAt !== null) return true
  return privateBoardAwaits(c, now) && pending <= 0
}

/* --------------------------------------------- splitting the answer rows */

export type RowPart = 'public' | 'private'

/**
 * How many rows to score right away.
 *
 * Both parts must be non-empty: a metric on zero rows either crashes or
 * returns NaN, and a competition with an empty private part is a competition
 * without a result. Hence a clamp, not bare rounding.
 */
export function publicRowCount(total: number, publicPercent: number): number {
  if (total <= 0) return 0
  if (total === 1) return 1
  const wanted = Math.round((total * publicPercent) / 100)
  return Math.min(total - 1, Math.max(1, wanted))
}

/**
 * FNV-1a, 32 bits.
 *
 * The hash here is not about strength but about repeatability: the same seed
 * and the same row key must give the same number today, in a month and on
 * another machine. `Math.random` and the order of rows in the file are no
 * good for this — on a recomputation after a metric edit, a different half
 * of the test would become public.
 */
function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Split the answer rows into a public and a private part.
 *
 * Not "each row with probability p" but a RANK by hash: the share must give
 * exactly the number of rows written in the mockup ("119 rows count right
 * away, 278 after the deadline"), while a separate coin toss per row gives
 * 119 ± a dozen and a different number for every new set.
 *
 * The answer is aligned with the input: `parts[i]` is about `ids[i]`.
 * Reordering rows in the answers file changes nothing — a row remembers its
 * part by key, not by position.
 */
export function splitRows(
  ids: readonly string[],
  publicPercent: number,
  seed: string,
): RowPart[] {
  const take = publicRowCount(ids.length, publicPercent)
  const order = ids.map((id, index) => ({ index, id, hash: hash32(`${seed}\u0000${id}`) }))
  // The second key is the id itself: equal hashes for different rows happen,
  // and without it the order would depend on how Array.sort handled the tie.
  order.sort((a, b) => (a.hash !== b.hash ? a.hash - b.hash : a.id < b.id ? -1 : 1))
  const parts: RowPart[] = new Array(ids.length).fill('private')
  for (let i = 0; i < take; i++) parts[order[i].index] = 'public'
  return parts
}

/**
 * The split the teacher recorded in the `Usage` column of the answers file.
 *
 * It takes precedence over the seed: having marked the rows by hand, a
 * teacher usually splits them not at random but by meaning — by time, by
 * warehouse, by patient — and replacing such a split with a coin toss would
 * spoil the task. `null` means the column will not do (foreign words, or one
 * part is empty), and then the seed splits.
 */
export function splitByUsage(usage: readonly string[]): RowPart[] | null {
  const parts: RowPart[] = []
  let publicRows = 0
  for (const raw of usage) {
    const value = String(raw ?? '').trim().toLowerCase()
    if (value === 'public') {
      parts.push('public')
      publicRows += 1
      continue
    }
    if (value === 'private') {
      parts.push('private')
      continue
    }
    return null
  }
  if (publicRows === 0 || publicRows === parts.length) return null
  return parts
}

/**
 * How to actually split the rows: by the column if it is there and usable,
 * otherwise by the seed. One door for both paths — so that "where did this
 * competition get such a split" has a single answer.
 */
export function planSplit(
  rows: { ids: readonly string[]; usage?: readonly string[] | null },
  publicPercent: number,
  seed: string,
): { parts: RowPart[]; by: 'usage' | 'seed' } {
  if (rows.usage && rows.usage.length === rows.ids.length) {
    const byUsage = splitByUsage(rows.usage)
    if (byUsage) return { parts: byUsage, by: 'usage' }
  }
  return { parts: splitRows(rows.ids, publicPercent, seed), by: 'seed' }
}

/* ------------------------------------------------------------------ limits */

/**
 * Lengths and bounds — in one place, as in `shared/admin.ts`.
 *
 * The numbers guard both the form in the panel and the server: a field
 * refused only on the client is a field without a limit.
 */
export const LIMITS = {
  title: 120,
  slug: 64,
  blurb: 240,
  /** The task's Markdown. Twenty kilobytes is about ten screens of text. */
  description: 20_000,
  metricName: 24,
  metricCode: 40_000,
  entrantName: 60,
  fileName: 120,
  /** Text the participant reads. Anything longer is already a traceback, and that is not for them. */
  participantError: 2_000,
  teacherError: 20_000,
  publicPercent: { min: 1, max: 99, default: 30 },
  wallSeconds: { min: 30, max: 4 * 60 * 60, default: 600 },
  memoryMb: { min: 512, max: 64 * 1024, default: 4096 },
  cpus: { min: 1, max: 32, default: 2 },
  /** Submissions per day per participant; 0 — no limit. */
  perDay: { min: 0, max: 100, default: 5 },
  /** "up to 200 MB per competition" — the caption under the list of open files (A2). */
  dataBytes: 200 * 1024 * 1024,
  files: 40,
  /**
   * The ceiling for a SUBMITTED notebook.
   *
   * Its own, not `config.maxUploadBytes`: `nbformat.read` parses the whole
   * file in the container's memory, and a notebook with fifty megabytes of
   * base64 pictures kills the submission for memory before the first cell —
   * with the reason "out of memory", which the participant will read as a
   * verdict on their code.
   */
  notebookBytes: 20 * 1024 * 1024,
  /** The ceiling for the answer the harness takes from the container (prototype: max_target). */
  submissionBytes: 64 * 1024 * 1024,
  /**
   * The hidden test: as much as the open data may weigh, in its own budget.
   * A copy of it lands in every run's folder where hard links are not
   * available (storage.ts · composeRunInputs), and the queue reserves disk
   * for that copy.
   */
  sealedBytes: 200 * 1024 * 1024,
  sealedFiles: 10,
} as const
