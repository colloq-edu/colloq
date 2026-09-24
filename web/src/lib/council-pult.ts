/**
 * The council console's messenger — all of its arithmetic, with no Svelte and no
 * socket.
 *
 * The console lives in a separate window (components/council/pult) and shows
 * the list of people on the left and the open work on the right. Here lies
 * what decides WHAT stands in the list and in which order: building the rows,
 * filters, unread, held-back submissions, cursor moves and the list of cells
 * the window switches between.
 *
 * THERE IS NO GROUPING HERE ANY MORE. Identical answers used to collapse into
 * one row with a tail "N more with the same answer", the work showed "group 2
 * of 6", and a letter went "to all N". On 20 Sep 2026 the owner asked to
 * remove this entirely, and it was removed entirely: the console list is a
 * feed of submissions, and a person in it is found by name, not by whom they
 * resemble. What answers there are is a question for the stack and the oracle.
 *
 * A separate module for the same reasons as council-board.ts: the stack and
 * the group strip there are computed outside a component, and these rules are
 * also checked without a browser (tests/council-pult.test.mts). Whatever is
 * assembled in markup comes out differently on every `{#if}` branch, and a
 * list in which the cursor goes somewhere other than where the eyes look means
 * pressing Enter on the wrong person in front of the whole hall.
 *
 * THE ORDER HERE DIFFERS FROM THE STACK'S. `stackOrder` (council-board.ts) puts
 * the representatives of large groups first: the card is paged "by solution".
 * The messenger is a feed of submissions, ordered by submission time, newest
 * on top: a person who pressed "Submit" a minute ago must be visible without
 * scrolling. Two different orders are not carelessness: they are two
 * different questions ("what answers are there" versus "who just submitted").
 *
 * Since 20 Sep 2026 the list has THREE TABS: "Submitted · Writing · All"
 * (Paper 05d, artboards 11 and 12). Those who submitted and those still
 * writing have different questions, different filter chips and a different
 * order: a feed of submissions for the first and an alarm list for the second
 * ("silent, failed, run requested, the rest" — `byAlarm`). A third order in
 * one file looks wasteful right up to the minute when there are thirty people
 * in the class and half of them are still writing: "who is stuck" is not "who
 * edited last".
 */
import { formatNumber, tr } from '@shared/i18n'
import {
  COUNCIL_RERUN_PAUSES,
  COUNCIL_RUN_LIMITS,
  COUNCIL_SILENCE_MS,
  type CellLock,
  type CouncilSettings,
} from '@shared/notebook'
import type {
  CouncilAttempt,
  CouncilBoard,
  CouncilKernel,
  CouncilStatus,
} from '@shared/protocol'

export type PultPresence = 'online' | 'offline' | 'unknown'

/** Saved work is independent of the live room roster. Lost connection makes it unknown. */
export function pultPresence(connected: boolean, people: ReadonlyMap<string, unknown>, id: string): PultPresence {
  if (!connected) return 'unknown'
  return people.has(id) ? 'online' : 'offline'
}

export type PultTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'accent'
export interface PultBadge {
  label: string
  tone: PultTone
  /**
   * A sign before the word, when the tone does not tell the whole state. See
   * attemptExecution.
   */
  icon?: string
  /**
   * The badge shape — a second sign on top of colour.
   *
   * A fill means "an action is expected from you": submitted and not graded.
   * An outline means "a state that will pass by itself": the person is still
   * writing. The tone differs between them too, but such things are not told
   * apart by colour alone: on a projector, on someone else's monitor and for
   * someone who cannot tell colours apart, what remains is the shape and the
   * word.
   */
  shape?: 'fill' | 'outline'
}
export type PultView = 'work' | 'queue' | 'oracle'

/**
 * Evaluation and execution are separate facts: running code successfully is not a grade.
 *
 * Submitted and NOT graded — a badge filled with the accent: on 19 Sep 2026
 * the teacher was running a class and could not see in the list whom they had
 * already looked at and whom not ("better mark submitted works in the
 * console, otherwise you can't see a damn thing"). A pale "Not reviewed" in
 * the common grey row looked no different from a draft or a graded one.
 */
export function attemptReview(attempt: Pick<CouncilAttempt, 'submittedAt' | 'correct'>): PultBadge {
  if (attempt.submittedAt === null) return { label: tr('room.pult.v2.review.draft'), tone: 'neutral', shape: 'outline' }
  if (attempt.correct === true) return { label: tr('room.pult.v2.review.correct'), tone: 'positive' }
  if (attempt.correct === false) return { label: tr('room.pult.v2.review.wrong'), tone: 'warning' }
  return { label: tr('room.pult.v3.review.waiting'), tone: 'accent', shape: 'fill' }
}

export function attemptExecution(attempt: {
  run: Pick<NonNullable<CouncilAttempt['run']>, 'state' | 'timedOut'> | null
  runRequest?: Pick<NonNullable<CouncilAttempt['runRequest']>, 'status'> | null
}): PultBadge {
  /*
   * A run stopped by the limit is not an "execution error".
   *
   * Its `state` is the same `error`, and under the common word it would stand
   * in one row with TypeError, so the person would go and read the output
   * looking for a typo. But there is nothing to fix here: the code may well be
   * right, it simply ran out of seconds, and the decision is the teacher's — to
   * raise the limit or interrupt a neighbour. So a stopped run has a word of
   * its own and its own clock sign.
   */
  const limit = timedOutLimit(attempt)
  if (limit !== null) {
    return { label: tr('room.pult.v2.execution.timedOut', { duration: pultDuration(limit) }), tone: 'danger', icon: '◷' }
  }
  switch (attempt.run?.state) {
    case 'running': return { label: tr('room.pult.v2.execution.running'), tone: 'accent' }
    case 'queued': return { label: tr('room.pult.v2.execution.queued'), tone: 'accent' }
    case 'error': return { label: tr('room.pult.v2.execution.error'), tone: 'danger' }
  }
  if (attempt.runRequest?.status === 'pending') return { label: tr('room.pult.v2.execution.request'), tone: 'warning' }
  if (attempt.run?.state === 'ok') return { label: tr('room.pult.v2.execution.ok'), tone: 'positive' }
  return { label: tr('room.pult.v2.execution.none'), tone: 'neutral' }
}

/* ------------------------------------------------------------ run time */

/**
 * Hour and minute — and seconds where things are matched by them.
 *
 * Our own, not `clock()` from lib/history: for two lines that module drags in
 * `./api` with the network and tokens, and this file is also read by tests
 * without a browser. The formatting rule is the same, to the character.
 *
 * Seconds are needed in the open work and in the queue: "started at 17:24:05"
 * is how the teacher matches their own run against someone else's when there
 * are three in a minute, and "17:24" for all three answers no question.
 */
export function pultClock(at: number, seconds = false): string {
  const date = new Date(at)
  const two = (value: number): string => String(value).padStart(2, '0')
  const hhmm = `${two(date.getHours())}:${two(date.getMinutes())}`
  return seconds ? `${hhmm}:${two(date.getSeconds())}` : hhmm
}

/**
 * How long a finished run computed.
 *
 * Under ten seconds — with tenths: almost all council runs are short, and
 * `spell()` rounds them to "0 s" and "1 s", that is, to the same number for
 * the whole class. Beyond that nobody compares tenths, and the shared
 * `pultDuration` takes over — the same one the rules' limits are named with.
 */
export function pultRanFor(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 10_000) {
    return tr('room.pult.v2.rules.sec', {
      count: formatNumber(safe / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    })
  }
  return pultDuration(safe / 1000)
}

/**
 * The whole run line: what happened, how long it computed and WHEN.
 *
 * The run's hour is a direct request from the 19 Sep 2026 class: "show the run
 * time in the council console". Without it "Execution completed" does not
 * tell an attempt run five minutes ago from one run just now, and different
 * things are decided by them: the first is ready to show the class, the
 * second has not yet finished computing past its neighbours.
 *
 * The word and the tone come from `attemptExecution` — the one place where a
 * state becomes a word — and the duration and time are added to them. Never
 * run at all, or asking for a run — there is no time there, and the line
 * stays as before: there must be no invented hour.
 */
export function attemptRunLine(
  attempt: {
    run: Pick<NonNullable<CouncilAttempt['run']>, 'state' | 'timedOut' | 'startedAt' | 'ranMs'> | null
    runRequest?: Pick<NonNullable<CouncilAttempt['runRequest']>, 'status'> | null
  },
  now: number,
): PultBadge {
  const base = attemptExecution(attempt)
  const run = attempt.run
  if (!run) return base
  const time = pultClock(run.startedAt)
  const limit = timedOutLimit(attempt)
  if (limit !== null) {
    return { ...base, label: tr('room.pult.v3.runStopped', { limit: pultDuration(limit), time }) }
  }
  switch (run.state) {
    case 'running':
      // A live counter — in whole seconds: tenths on a number that changes
      // every second read as flicker, not as a measurement.
      return { ...base, label: tr('room.pult.v3.runRunning', { duration: pultDuration(Math.max(now - run.startedAt, 0) / 1000) }) }
    case 'queued':
      return { ...base, label: tr('room.pult.v3.runQueued', { time }) }
    case 'error':
      return {
        ...base,
        label: run.ranMs === null
          ? tr('room.pult.v3.runFailedAt', { time })
          : tr('room.pult.v3.runFailed', { duration: pultRanFor(run.ranMs), time }),
      }
    case 'ok':
      return {
        ...base,
        label: run.ranMs === null
          ? tr('room.pult.v3.runDoneAt', { time })
          : tr('room.pult.v3.runDone', { duration: pultRanFor(run.ranMs), time }),
      }
  }
  return base
}

export function pultShortcutAllowed(action: PultAction, view: PultView, navigation: boolean, overlay = false): boolean {
  if (overlay || action === null) return false
  // The rules are a rule of the CELL, not of the open work: people reach for
  // them from the queue and from the oracle as often as from the list, and
  // "go back to the works first" would answer nothing. The neighbouring cell —
  // by the same argument: there is one console per room, and it gets switched
  // while standing in the queue too.
  if (
    action === 'help' ||
    action === 'escape' ||
    action === 'search' ||
    action === 'rules' ||
    action === 'nextCell' ||
    action === 'prevCell'
  ) {
    return true
  }
  return view === 'work' && !navigation
}

/**
 * From how many identical answers a group count says anything at all.
 *
 * The console list no longer uses it: grouping was removed from the console
 * entirely (20 Sep 2026). The threshold remains the ONE place where this
 * number is named — it is read by the stack and by the oracle, for which "two
 * people wrote the same thing" is no reason to form a group. Rewriting it
 * differently in two places is cheapest exactly when one of them looks like
 * nobody's leftover.
 */
export const GROUP_MIN = 3

/* ----------------------------------------------------------- list tabs */

/**
 * Two piles — two tabs, and a third for those used to the old way.
 *
 * Before 20 Sep 2026 this was one list with two sections and five filter chips
 * above it. With thirty students "Writing" slid off the edge, and nobody ever
 * got down there; the chips wrapped onto a second line at the column's width,
 * taking one more work away from the list. Above all, the halves have
 * DIFFERENT questions: of the submitted ones you ask "what have I not graded
 * yet", of the writing ones "who is stuck", and one row of chips cannot
 * answer two questions.
 *
 * "All" stayed as the third, unchanged: it is the former single list with two
 * sections — for searching by name and for those who read the class as a
 * whole.
 */
export type PultTab = 'submitted' | 'writing' | 'all'
export const PULT_TABS: readonly PultTab[] = ['submitted', 'writing', 'all']

/**
 * Filter chips. Each tab has its own set — see `tabFilters`.
 *
 * `unrun` ("not run") is no longer in the sets: a fifth chip did not fit into
 * the "Submitted" tab on one line in a narrow column (280 px at a window width
 * of 860), and wrapping the row onto a second line costs one work in the list.
 * The value itself remains: tests filter by it, and so can a sixth chip if
 * one is ever needed.
 */
export type PultFilter =
  | 'all'
  | 'new'
  | 'ungraded'
  | 'error'
  | 'unrun'
  | 'silent'
  | 'failed'
  | 'asking'

const TAB_FILTERS: Record<PultTab, readonly PultFilter[]> = {
  submitted: ['all', 'ungraded', 'new', 'error'],
  writing: ['all', 'silent', 'failed', 'asking'],
  all: ['all', 'new'],
}

export function tabFilters(tab: PultTab): readonly PultFilter[] {
  return TAB_FILTERS[tab]
}

/** A filter that survived a tab switch: a chip from another tab silently becomes "All". */
export function filterInTab(tab: PultTab, filter: PultFilter): PultFilter {
  return TAB_FILTERS[tab].includes(filter) ? filter : 'all'
}

/** The word in the chip. The one place where a filter becomes a word. */
export function filterLabel(filter: PultFilter): string {
  switch (filter) {
    case 'new':
      return tr('room.pult.v3.tabs.new')
    case 'error':
      return tr('room.pult.v3.tabs.error')
    case 'unrun':
      return tr('room.pult.v3.tabs.unrun')
    case 'ungraded':
      return tr('room.pult.v3.tabs.ungraded')
    case 'silent':
      return tr('room.pult.v3.tabs.silent')
    case 'failed':
      return tr('room.pult.v3.tabs.failed')
    case 'asking':
      return tr('room.pult.v3.tabs.asking')
    default:
      return tr('room.pult.v3.tabs.all')
  }
}

/** The word on the tab. */
export function tabLabel(tab: PultTab): string {
  switch (tab) {
    case 'submitted':
      return tr('room.pult.v3.tabs.submitted')
    case 'writing':
      return tr('room.pult.v3.tabs.writing')
    default:
      return tr('room.pult.v3.tabs.all')
  }
}

/** The chip colour: only what calls for you is worth colouring. */
export function filterTone(filter: PultFilter): PultTone | null {
  switch (filter) {
    case 'error':
    case 'failed':
      return 'danger'
    case 'silent':
      return 'warning'
    default:
      return null
  }
}

/**
 * A list row. Two kinds, and only the first can be selected by the cursor: a
 * section header is not a person but a place in the feed, and Enter on it
 * would mean "show the class" someone-knows-whose work.
 *
 * There used to be four kinds: the group header and the collapsed tail "N
 * more with the same answer" belonged here too. There is no grouping in the
 * console any more — all of it left on 20 Sep 2026 on a single word from the
 * owner, and left entirely rather than hiding behind a setting: the console
 * list is a FEED OF SUBMISSIONS, and a person who submitted a minute ago must
 * stand in it on their own, not under someone else's tail.
 */
export type PultRow =
  | {
      kind: 'attempt'
      /** The key for `{#each}` and for the cursor — it is also the participantId. */
      id: string
      attempt: CouncilAttempt
      unread: boolean
      /** The variant number when names are off; starting from one. */
      variant: number
    }
  /**
   * The header of a half of the feed: "Submitted · N" and "Writing · N".
   *
   * The feed order already puts the submitted first (bySubmissionDesc), but
   * the border between "already submitted" and "still writing" was not marked
   * by anything, and in a window showing two and a half rows it did not exist
   * at all: the list looked like one undifferentiated row of people. The
   * cursor never lands on this row.
   */
  | { kind: 'section'; id: string; section: 'submitted' | 'writing'; count: number }

export interface PultListInput {
  attempts: readonly CouncilAttempt[]
  /** Which of the three piles is open. */
  tab: PultTab
  filter: PultFilter
  /** Search by name; with names off the caller passes an empty string. */
  search: string
  /** Who submitted after the list was last looked at. */
  unread: ReadonlySet<string>
  /** Held-back submissions: they are in the stack but not yet let into the list. */
  held: ReadonlySet<string>
  /** The window's clock: a draft's silence is counted by it. */
  now: number
}

/**
 * Submitted means there is a submission time; everything else is a saved
 * draft, regardless of presence.
 */
const isSubmitted = (attempt: CouncilAttempt): boolean => attempt.submittedAt !== null

/** Whom the tab lets in. The filter is a second sieve on top of this. */
export function inTab(attempt: CouncilAttempt, tab: PultTab): boolean {
  if (tab === 'all') return true
  return tab === 'submitted' ? isSubmitted(attempt) : !isSubmitted(attempt)
}

/* --------------------------------------------------------------- alarm */

/**
 * What is happening with a DRAFT — exactly one word per person.
 *
 * The "Writing" tab answers one question: who is stuck. Its answer comes in
 * four kinds, and every attempt gets exactly one — otherwise the chips
 * "Silent 3 · Failed 2 · Run requested 2" would count one person twice, and
 * the sum would not match the length of the list.
 *
 * The order of CHECKING (here) and the order of ALARM (`ALARM_RANK`) are
 * different things, and they diverge on purpose. A run request is checked
 * first: a person who pressed "please run" a minute ago is not "silent" — they
 * are waiting for us, and that is exactly what explains the silence of their
 * sheet. But silence stands higher in the list: a request is visible from the
 * queue and from the strip, while nobody will speak up about the one who is
 * stuck.
 */
export type DraftAlarm = 'silent' | 'failed' | 'asking' | 'writing'

export function draftAlarm(attempt: CouncilAttempt, now: number): DraftAlarm {
  if (attempt.runRequest?.status === 'pending') return 'asking'
  if (attempt.run?.state === 'error' || timedOutLimit(attempt) !== null) return 'failed'
  return now - attempt.updatedAt > COUNCIL_SILENCE_MS ? 'silent' : 'writing'
}

/** The order of alarms in the list: silent, failed, run requested, the rest. */
const ALARM_RANK: Record<DraftAlarm, number> = { silent: 0, failed: 1, asking: 2, writing: 3 }

/**
 * The status line of someone writing: one line, instead of the grading badge
 * and the run line.
 *
 * A draft has no grade, and a "Draft" badge on every row is ten identical
 * words in a row. Here, in its place, is what is really known about this
 * person: how long they have been silent, how their run ended, how long they
 * have waited for a decision — and how many lines they have written, because
 * "writing · 2 lines" and "writing · 40 lines" ask for different things.
 */
export function draftLine(attempt: CouncilAttempt, now: number): PultBadge {
  const alarm = draftAlarm(attempt, now)
  const lines = attempt.text === '' ? 0 : attempt.text.split('\n').length
  switch (alarm) {
    case 'silent':
      return {
        label: tr('room.pult.v3.draft.silent', {
          duration: pultIdle((now - attempt.updatedAt) / 1000),
          count: lines,
        }),
        tone: 'warning',
      }
    case 'failed': {
      const limit = timedOutLimit(attempt)
      if (limit !== null) {
        return {
          label: tr('room.pult.v2.execution.timedOut', { duration: pultDuration(limit) }),
          tone: 'danger',
        }
      }
      const error = attempt.run?.outputs.find((output) => output.kind === 'error')
      const name = error && error.kind === 'error' ? error.ename : ''
      return {
        label: name
          ? tr('room.pult.v3.draft.failedNamed', { error: name })
          : tr('room.pult.v3.draft.failed'),
        tone: 'danger',
      }
    }
    case 'asking':
      /*
       * A line of its own, not the queue card's header ("Run requested ·
       * waiting 40 s"): in a list row the neighbouring states are set in lower
       * case ("silent 7 min", "writing · 14 lines"), and one capital in the
       * middle of the column reads as a heading, which this line is not.
       */
      return {
        label: tr('room.pult.v3.draft.asking', {
          duration: pultDuration(Math.max(now - (attempt.runRequest?.requestedAt ?? now), 0) / 1000),
        }),
        tone: 'neutral',
      }
    default:
      return { label: tr('room.pult.v3.draft.writing', { count: lines }), tone: 'neutral' }
  }
}

/**
 * The order in the "Writing" tab — BY ALARM, not by time.
 *
 * Silent, failed, run requested, the rest. Within the three alarm groups,
 * whoever has waited longer is higher: "silent 12 min" matters more than
 * "silent 6 min", and a request made a minute ago matters more than one made
 * just now. The calm ones go by edit time, newest on top: the question there
 * is different — "who is working right now".
 */
export function byAlarm(now: number) {
  const since = (attempt: CouncilAttempt, alarm: DraftAlarm): number => {
    if (alarm === 'asking') return attempt.runRequest?.requestedAt ?? attempt.updatedAt
    if (alarm === 'failed') return attempt.run?.startedAt ?? attempt.updatedAt
    return attempt.updatedAt
  }
  return (a: CouncilAttempt, b: CouncilAttempt): number => {
    const left = draftAlarm(a, now)
    const right = draftAlarm(b, now)
    const rank = ALARM_RANK[left] - ALARM_RANK[right]
    if (rank !== 0) return rank
    // The calm ones newest first; the alarming ones by whoever has waited longest.
    const order = left === 'writing' ? since(b, right) - since(a, left) : since(a, left) - since(b, right)
    return order || a.participantId.localeCompare(b.participantId)
  }
}

/**
 * Variant numbers — by submission time, starting from one, for the whole cell.
 *
 * By the same rule the server uses when showing (protocol.ts ·
 * CouncilShown.variant): with names off the number is the person's only
 * label, and in the console it must match what the hall sees. Those still
 * writing get numbers at the tail, by id: they have no number yet, and a gap
 * in the numbering would read as a lost person.
 */
export function variantNumbers(attempts: readonly CouncilAttempt[]): Map<string, number> {
  const order = [...attempts].sort((a, b) => {
    const left = a.submittedAt
    const right = b.submittedAt
    if (left !== null && right !== null) return left - right || a.participantId.localeCompare(b.participantId)
    if (left !== null) return -1
    if (right !== null) return 1
    return a.participantId.localeCompare(b.participantId)
  })
  return new Map(order.map((attempt, index) => [attempt.participantId, index + 1]))
}

/** Newest on top: a feed of submissions, not a stack of solutions; drafts last, by id. */
export function bySubmissionDesc(a: CouncilAttempt, b: CouncilAttempt): number {
  const left = a.submittedAt
  const right = b.submittedAt
  if (left !== null && right !== null) return right - left || a.participantId.localeCompare(b.participantId)
  if (left !== null) return -1
  if (right !== null) return 1
  return a.participantId.localeCompare(b.participantId)
}

/** Whether an attempt passes a filter chip. Search is separate: it goes by name. */
export function matchesFilter(
  attempt: CouncilAttempt,
  filter: PultFilter,
  unread: ReadonlySet<string>,
  now: number = Date.now(),
): boolean {
  switch (filter) {
    case 'new':
      return unread.has(attempt.participantId)
    case 'ungraded':
      // "Ungraded" is about the teacher's hand, not about the run: submitted,
      // but no mark. Drafts do not get here — they are not graded at all.
      return isSubmitted(attempt) && attempt.correct === null
    case 'error':
      // A run stopped by the limit counts as "with an error" just like a crashed
      // one: the chip picks works whose run did not succeed, not exception names.
      return attempt.run?.state === 'error' || timedOutLimit(attempt) !== null || attempt.correct === false
    case 'unrun':
      return attempt.run === null
    case 'silent':
      return !isSubmitted(attempt) && draftAlarm(attempt, now) === 'silent'
    case 'failed':
      return !isSubmitted(attempt) && draftAlarm(attempt, now) === 'failed'
    case 'asking':
      return !isSubmitted(attempt) && draftAlarm(attempt, now) === 'asking'
    default:
      return true
  }
}

/** The numbers in a tab's chips — by the same sieve the chip filters with. */
export function filterCounts(
  attempts: readonly CouncilAttempt[],
  tab: PultTab,
  unread: ReadonlySet<string>,
  now: number,
): Record<PultFilter, number> {
  const counts = {
    all: 0,
    new: 0,
    ungraded: 0,
    error: 0,
    unrun: 0,
    silent: 0,
    failed: 0,
    asking: 0,
  } as Record<PultFilter, number>
  for (const attempt of attempts) {
    if (!inTab(attempt, tab)) continue
    for (const filter of TAB_FILTERS[tab]) {
      if (matchesFilter(attempt, filter, unread, now)) counts[filter] += 1
    }
  }
  return counts
}

/** The numbers on the tabs themselves: "Submitted 13 · Writing 11 · All 24". */
export function tabCounts(attempts: readonly CouncilAttempt[]): Record<PultTab, number> {
  const submitted = attempts.filter(isSubmitted).length
  return { submitted, writing: attempts.length - submitted, all: attempts.length }
}

/**
 * The list rows — what the left column draws.
 *
 * One row per person, newest on top. No collapsing, no group headers: the
 * console list is a feed of submissions, and the only question it answers is
 * "who just submitted". Grouping of identical answers lived here until 20 Sep
 * 2026 and was removed at the owner's direct request: it hid people under
 * someone else's tail ("N more with the same answer"), while finding a
 * specific person in the list is exactly why people look at it. What answers
 * there are is a question for the stack and the oracle, and it is asked
 * elsewhere.
 */
export function listRows(input: PultListInput): PultRow[] {
  const { attempts, tab, filter, search, unread, held, now } = input
  const variants = variantNumbers(attempts)
  const needle = search.trim().toLocaleLowerCase()

  const visible = attempts.filter(
    (attempt) =>
      inTab(attempt, tab) &&
      !held.has(attempt.participantId) &&
      matchesFilter(attempt, filter, unread, now) &&
      (needle === '' || attempt.name.toLocaleLowerCase().includes(needle)),
  )
  /*
   * Two orders for three tabs, and that is not carelessness.
   *
   * "Submitted" and "All" are a feed of submissions: newest on top, a person
   * who pressed "Submit" a minute ago is visible without scrolling. "Writing"
   * is not a feed but an alarm list: the question there is "who is stuck", and
   * edit time is the last thing known about a person that answers it.
   */
  const ordered = [...visible].sort(tab === 'writing' ? byAlarm(now) : bySubmissionDesc)

  const rows: PultRow[] = ordered.map((attempt) => ({
    kind: 'attempt',
    id: attempt.participantId,
    attempt,
    unread: unread.has(attempt.participantId),
    variant: variants.get(attempt.participantId) ?? 0,
  }))
  // Sections only in "All": in the other tabs there is only one half of the
  // feed anyway, and a "Submitted · 13" header over thirteen submitters would
  // be a caption to itself.
  return withSections(rows, ordered, tab === 'all' && filter === 'all' && needle === '')
}

/**
 * Two sections — only in the full list and only without a search.
 *
 * Under the "With an error" filter a "Submitted · 5" header would speak of a
 * number that is not in the list: the filter has already cut the feed by
 * another feature, and a second cut on top of the first reads as a counting
 * error. Search is the same: it holds the found ones, not "everyone who
 * submitted".
 *
 * The count is by people, not by rows: they have nowhere to diverge now, but
 * counting over `ordered` is cheaper and more honest than over the assembled
 * rows, among which the headers themselves stand.
 */
function withSections(rows: PultRow[], ordered: readonly CouncilAttempt[], on: boolean): PultRow[] {
  if (!on) return rows
  const submitted = ordered.filter(isSubmitted).length
  const writing = ordered.length - submitted
  const out: PultRow[] = []
  let openedSubmitted = false
  let openedWriting = false
  for (const row of rows) {
    const draft = row.kind === 'attempt' && row.attempt.submittedAt === null
    if (!draft && !openedSubmitted && submitted > 0) {
      out.push({ kind: 'section', id: 'section:submitted', section: 'submitted', count: submitted })
      openedSubmitted = true
    }
    if (draft && !openedWriting && writing > 0) {
      out.push({ kind: 'section', id: 'section:writing', section: 'writing', count: writing })
      openedWriting = true
    }
    out.push(row)
  }
  return out
}

/** People only: the cursor never lands on a section header. */
export function selectable(rows: readonly PultRow[]): string[] {
  return rows.filter((row) => row.kind === 'attempt').map((row) => row.id)
}

/* ------------------------------------------------------- council cells */

/**
 * A cell in the picker list — everything its menu row says about it.
 *
 * The console is ONE window per room, and a cell is chosen inside it rather
 * than opened in a second window: "it would be great to have one shared
 * console where you can move between cells". The cell number in the header
 * became the door into this list, and the list must answer the only question
 * it is opened for: where to switch right now.
 */
export interface PultCellRow {
  cellId: string
  /** The cell's number in its notebook, from one; `null` — not in the document. */
  index: number | null
  /**
   * The task name — the cell's first line or the heading above it.
   *
   * Empty — there is no name, and the row makes do with the number. The whole
   * rule lives in `cellHeadline` / `markdownHeadline`: "cell 60" and "cell 65"
   * are indistinguishable in the menu, and people choose between them by the
   * task, not by the number.
   */
  title: string
  /** The notebook name; empty while all cells are from one — a caption decides nothing. */
  book: string
  submitted: number
  total: number
  /** Submitted and not graded — the only thing that asks for the teacher's hand. */
  waiting: number
  /** How many people are asking for a run to be allowed. */
  asking: number
  /** How many attempts of this cell stand in the kernel queue. */
  queued: number
  /** Someone's attempt of this cell is computing in the kernel right now. */
  running: boolean
  /** Someone's work for this cell is on the projector. */
  onScreen: boolean
  /**
   * The council is closed, but attempts remain.
   *
   * Such cells DO NOT LEAVE the list: submitted work is looked at until the
   * end of the class, and a cell taken off the council while a console is
   * open on it must stay in place — throwing a person out of what they are
   * looking at is worse than admitting in words that there is nothing left to
   * change here.
   */
  review: boolean
}

export interface PultCellFacts {
  cellId: string
  index: number | null
  /** The task name — see `cellHeadline`; empty if there is nothing to derive it from. */
  title?: string
  book: string
  lock: CellLock
  /** The stack's numbers — a fallback count while the room's has not arrived. */
  counts: CouncilBoard['counts']
  /**
   * "N of M submitted" across the whole room — the same numbers as under the
   * cell in the notebook.
   */
  room: { submitted: number; total: number } | null
  attempts: readonly CouncilAttempt[]
  onScreen: boolean
}

/**
 * The list of cells for the menu: order, numbers and marks.
 *
 * The order is by notebook and number, not by the arrival of frames: the menu
 * is opened to find a known cell, and "the one whose stack arrived first" is
 * not the order it is looked for in.
 *
 * The notebook name ALWAYS arrives, and it is the menu that hides it: a number
 * is unique only within a notebook, and "cell 09" in the seminar and in the
 * lecture are two different cells with one caption (a request from the
 * 20 Sep 2026 class). When there is one notebook, the menu names it once in
 * the header; when there are several — in every row, because otherwise the
 * header would promise the name of whichever came first for the whole list.
 */
export function pultCells(facts: readonly PultCellFacts[]): PultCellRow[] {
  return [...facts]
    .sort(
      (a, b) =>
        a.book.localeCompare(b.book) ||
        // A cell that is not in the document goes to the tail: it has no place in
        // the notebook, and slotting it in at zero would mean putting it first.
        (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) ||
        a.cellId.localeCompare(b.cellId),
    )
    .map((fact) => ({
      cellId: fact.cellId,
      index: fact.index,
      title: fact.title ?? '',
      book: fact.book,
      submitted: fact.room?.submitted ?? fact.counts.submitted,
      total: fact.room?.total ?? fact.counts.attempts,
      /*
       * The count comes from the stack, which the teacher already has for
       * EVERY cell (control.ts · councilWelcome). We do not touch the server
       * for these numbers: it carries "N of M submitted" to the whole room,
       * while "awaiting review" and "run requested" are the console's private
       * knowledge, and counting it privately is better than setting up a frame
       * for it.
       */
      waiting: fact.attempts.filter((one) => one.submittedAt !== null && one.correct === null).length,
      asking: fact.attempts.filter((one) => one.runRequest?.status === 'pending').length,
      queued: fact.attempts.filter((one) => one.run?.state === 'queued').length,
      running: fact.attempts.some((attempt) => attempt.run?.state === 'running'),
      onScreen: fact.onScreen,
      review: fact.lock !== 'council',
    }))
}

/**
 * The neighbouring cell in the same order as they stand in the menu.
 *
 * The `[` and `]` keys must move by exactly that order: the list is opened to
 * find a known cell, and "next" is the next menu row, not the next frame to
 * arrive. At the edges — `null`: wrapping around would take the console from
 * the first cell to the last with one press, without showing what happened.
 */
export function neighbourCell(
  cells: readonly PultCellRow[],
  current: string,
  delta: 1 | -1,
): string | null {
  const at = cells.findIndex((cell) => cell.cellId === current)
  if (at < 0) return null
  const next = at + delta
  return next >= 0 && next < cells.length ? cells[next].cellId : null
}

/**
 * How many OTHER cells are awaiting review — the caption next to the picker
 * button.
 *
 * Closed ones are not counted, and that is not a simplification: such a
 * cell's menu row says "council closed · review only" and shows no numbers
 * at all. Calling someone there with a caption that no row in the menu itself
 * matches means sending the person to look for something they will not see
 * there.
 */
export function othersWaiting(cells: readonly PultCellRow[], current: string): number {
  return cells.filter((cell) => cell.cellId !== current && !cell.review && cell.waiting > 0).length
}

/**
 * The attention line under a cell's name: what in it needs a hand right now.
 *
 * Not "how much is there in total" but "what to go there for". A closed
 * council says so in one piece and instead of everything else: there is
 * nothing to change there, and "9 awaiting review" in a closed cell would
 * call people to where nothing can be changed. A cell where everything has
 * been dealt with gets its own line — an empty space would read as "the line
 * did not finish loading".
 */
export interface CellNote {
  text: string
  tone: PultTone | 'faint'
  /** A badge, not a word: "on screen" is the state of the hall, not a count. */
  chip?: boolean
}

export function cellNotes(cell: PultCellRow): CellNote[] {
  if (cell.review) return [{ text: tr('room.pult.v3.cells.closed'), tone: 'faint' }]
  const notes: CellNote[] = []
  if (cell.waiting > 0) {
    notes.push({ text: tr('room.pult.v3.cells.waiting', { count: cell.waiting }), tone: 'accent' })
  }
  if (cell.asking > 0) {
    notes.push({ text: tr('room.pult.v3.cells.asking', { count: cell.asking }), tone: 'warning' })
  }
  if (cell.running) {
    notes.push({
      text: cell.queued > 0
        ? `${tr('room.pult.v3.cells.running')} · ${tr('room.pult.v3.cells.queued', { count: cell.queued })}`
        : tr('room.pult.v3.cells.running'),
      tone: 'neutral',
    })
  } else if (cell.queued > 0) {
    notes.push({ text: tr('room.pult.v3.cells.queued', { count: cell.queued }), tone: 'neutral' })
  }
  if (cell.onScreen) notes.push({ text: tr('room.pult.v3.cells.onScreen'), tone: 'positive', chip: true })
  if (notes.length === 0) notes.push({ text: tr('room.pult.v3.cells.clear'), tone: 'neutral' })
  return notes
}

/* -------------------------------------------------------- task name */

/**
 * Decoration that means nothing in a heading: frames, underlines, hashes.
 *
 * Stripped from BOTH ends and only as whole runs: "# ══ Importance ══" is
 * "Importance", while "x ** 2" and "a - b" stay themselves, because nothing
 * inside the line is touched.
 */
const DECOR = /^[\s#=\-—–*_~·•≡═─━☰]+|[\s#=\-—–*_~·•≡═─━☰]+$/g

/**
 * A service prefix like "STUDENT CELL ·".
 *
 * Only in CAPITALS and only of two words or more: "S5E12 · minimum" is a
 * name, not a prefix, and a single capitalised word before the dot must not
 * be stripped. The remainder must be non-empty: "CONTROL TEST ·" with nothing
 * after it is the name itself.
 */
const PREFIX = /^[\p{Lu}\p{Nd}\s]*\p{Lu}[\p{Lu}\p{Nd}]*\s+[\p{Lu}\p{Nd}][\p{Lu}\p{Nd}\s]*[·:—-]\s+(?=\S)/u

/**
 * The task name from a cell's text — the first line, if it is a comment.
 *
 * A comment above the code is how a task is labelled in a notebook, and it is
 * also the only thing the console itself knows about the cell. The line is
 * cleaned: hashes, a frame of `═` and a service prefix are stripped, and an
 * entirely decorative line ("# ═════") is skipped — the name usually stands
 * right after it.
 *
 * A first non-empty line of CODE means the cell has no name: the markdown cell
 * above then serves as the caption, and the caller looks for it
 * (`markdownHeadline`). A heading must not be invented from code:
 * "imp = clf.feature_importances_" in the menu is worse than an honest
 * "cell 03".
 */
export function cellHeadline(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    // Reached the code — there is no heading in the cell.
    if (!line.startsWith('#')) return ''
    const clean = line.replace(DECOR, '').replace(PREFIX, '').trim()
    if (clean !== '') return clean
  }
  return ''
}

/**
 * The HEADING of a markdown cell — and only that, not its first line.
 *
 * The difference is not academic. A real seminar cell looks like this: a
 * three-line paragraph about missing values in the features, and under it
 * "### Task 1" — and the task is named by the latter. Taking the first
 * non-empty line, the menu put into its button "Missing values remain only in
 * the numeric features (`GarageYrBlt`, `MasVnrArea`). They can be filled in
 * by analysing…" — a paragraph instead of a name.
 *
 * The LAST heading of the cell is taken: it is closest to the code below and
 * it is the one that introduces the task. No heading at all — no name: a
 * paragraph playing a name is worse than an honest "cell 60".
 *
 * The number of hashes means nothing: "## Importance" and "# Importance" are
 * one name, and the level is about the document's outline, not about the
 * text.
 */
export function markdownHeadline(text: string): string {
  let found = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('#')) continue
    const clean = line.replace(DECOR, '').replace(PREFIX, '').trim()
    if (clean !== '') found = clean
  }
  return found
}

/**
 * What is written in the menu row and on the header button.
 *
 * The name, if there is one; otherwise the former "cell NN"; and if the cell
 * is no longer in the document — a generic word. The name is not truncated
 * here: cutting by character count means cutting differently in "Feature
 * importance" and in "WWWWWWWWWWWWWWWW", and it is the browser that measures
 * width (`text-overflow: ellipsis`).
 */
export function cellTaskTitle(input: { title: string; index: number | null }): string {
  const title = input.title.trim()
  if (title !== '') return title
  return input.index != null
    ? tr('room.ui.1272', { p0: String(input.index).padStart(2, '0') })
    : tr('room.ui.34')
}

/**
 * Where the cursor goes on the j / k key.
 *
 * No cursor — down leads to the first row, up to the last: the first press
 * must select something, otherwise the key reads as broken. A cursor on a row
 * that is no longer in the filtered set (the filter changed) — also to the
 * first.
 */
export function moveCursor(rows: readonly PultRow[], cursor: string | null, delta: 1 | -1): string | null {
  const ids = selectable(rows)
  if (ids.length === 0) return null
  const at = cursor === null ? -1 : ids.indexOf(cursor)
  if (at < 0) return delta === 1 ? ids[0] : ids[ids.length - 1]
  const next = at + delta
  if (next < 0 || next >= ids.length) return ids[at]
  return ids[next]
}

/* -------------------------------------------------------------- unread */

/**
 * Who submitted after the list was looked at — the blue dot on the left.
 *
 * `seen` — those whose row has already been opened: the dot goes out on
 * opening and does not come back. `since` — the moment the console was
 * opened: everything submitted earlier does not count as unread, otherwise
 * the first opening would paint the whole class with dots.
 */
export function unreadIds(
  attempts: readonly CouncilAttempt[],
  since: number,
  seen: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) continue
    if (attempt.submittedAt <= since) continue
    if (seen.has(attempt.participantId)) continue
    out.add(attempt.participantId)
  }
  return out
}

/* ---------------------------------------------- held-back submissions */

/**
 * Whether to hold new submissions behind the "↑ N more submitted — show" bar.
 *
 * The list is scrolled or the cursor is not on the first row — so the person
 * is reading something specific, and a row appearing at the top would pull
 * everything under the cursor down. We are on the first row at the very top —
 * let them in at once: there a new submission is exactly what people are
 * watching for.
 */
export function holdsArrivals(scrolled: boolean, cursorAtTop: boolean): boolean {
  return scrolled || !cursorAtTop
}

/**
 * What to hold back: whatever was submitted after `frozenAt`, except what
 * already stands in the list and the row under the cursor. The cursor never
 * moves — even if the person under it submitted again.
 */
export function heldArrivals(
  attempts: readonly CouncilAttempt[],
  frozenAt: number,
  standing: ReadonlySet<string>,
  cursor: string | null,
): Set<string> {
  const out = new Set<string>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null || attempt.submittedAt <= frozenAt) continue
    if (standing.has(attempt.participantId)) continue
    if (attempt.participantId === cursor) continue
    out.add(attempt.participantId)
  }
  return out
}

/* --------------------------------------------------------------- keys */

/** Where the focus is — that decides whose key it is. */
export type PultFocus = 'list' | 'search' | 'reply' | 'actions'

export type PultAction =
  | 'next'
  | 'prev'
  | 'nextCell'
  | 'prevCell'
  | 'search'
  | 'show'
  | 'run'
  | 'correct'
  | 'wrong'
  | 'clearShown'
  | 'send'
  | 'escape'
  | 'help'
  | 'rules'
  | null

export interface PultKey {
  key: string
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  composing?: boolean
}

/**
 * What a key does in the console.
 *
 * Three rules, and all three are about input fields. In the reply field the
 * keys belong to it: ⌘↵ sends, Esc closes, everything else is typing. In the
 * search, the arrows KEEP moving through the filtered list (otherwise after
 * ⌘F the hands have to go back to the mouse), and letters are typing.
 * Everywhere else — the console's letters.
 *
 * Enter shows to the class, and only from where you can see who is being
 * shown; on a button (`actions`) it presses the button rather than doing a
 * second thing first.
 */
export function pultKeyAction(event: PultKey, focus: PultFocus): PultAction {
  if (event.alt || event.composing) return null
  const mod = Boolean(event.meta || event.ctrl)
  if (mod && (event.key === 'f' || event.key === 'F' || event.key === 'а' || event.key === 'А')) return 'search'
  if (focus === 'reply') {
    if (mod && event.key === 'Enter') return 'send'
    if (event.key === 'Escape') return 'escape'
    return null
  }
  if (mod) return null
  if (focus === 'actions' && (event.key === ' ' || event.key === 'Enter')) return null
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'prev'
  if (event.key === 'Escape') return 'escape'
  /*
   * Brackets are the neighbouring cell, and they work even from the search.
   *
   * People type a person's name into the search field, not square brackets;
   * but leaving it for the neighbouring cell without dropping focus is common.
   * The layout is shared here: on the Russian layout the same keys produce
   * "х" and "ъ".
   */
  if (event.key === '[' || event.key === 'х' || event.key === 'Х') return 'prevCell'
  if (event.key === ']' || event.key === 'ъ' || event.key === 'Ъ') return 'nextCell'
  if (focus === 'search') return event.key === 'Enter' ? 'show' : null
  if (mod) return null
  switch (event.key) {
    case 'j':
    case 'о':
      return 'next'
    case 'k':
    case 'л':
      return 'prev'
    case 'Enter':
      return focus === 'actions' ? null : 'show'
    case 'r':
    case 'R':
    case 'к':
    case 'К':
      return 'run'
    case '1':
      return 'correct'
    case '2':
      return 'wrong'
    case '3':
      return 'clearShown'
    // "п" is rules; the Latin g sits on the same key, like "о" and j for the cursor.
    case 'g':
    case 'G':
    case 'п':
    case 'П':
      return 'rules'
    // Slash is search, as in any list with a magnifier. ⌘F stays: it is more
    // familiar to those coming from the browser, and "/" to those coming from
    // mail and messengers.
    case '/':
      return 'search'
    case '?':
      return 'help'
    default:
      return null
  }
}

/* --------------------------------------------------------------- words */

/** The colour of the row's left bar: what is required of you, not what happened. */
export type RowMeaning = 'none' | 'cursor' | 'screen' | 'asking'

export function rowMeaning(
  attempt: CouncilAttempt,
  cursor: string | null,
  shown: string | null,
): RowMeaning {
  if (attempt.runRequest?.status === 'pending') return 'asking'
  if (shown === attempt.participantId) return 'screen'
  if (cursor === attempt.participantId) return 'cursor'
  return 'none'
}

/**
 * The reason next to a run request — the two words that get it approved.
 *
 * Derived ONLY from what is really known: the previous run of this same
 * attempt failed — so "TypeError last time". The server carries no history of
 * requests (`CouncilRunRequest` is the single current one), so "third attempt
 * in a minute" is not made up here: an invented reason is worse than an empty
 * space, because a decision is made by it.
 */
export function requestReason(attempt: CouncilAttempt): string | null {
  const run = attempt.run
  if (!run || run.state !== 'error') return null
  const error = run.outputs.find((output) => output.kind === 'error')
  const name = error && error.kind === 'error' ? error.ename : ''
  return name ? tr('room.ui.1302', { p0: name }) : null
}

/** Who is in the kernel for this cell right now and who is waiting — from the same stack. */
export interface KernelView {
  /** The attempt of THIS cell that the kernel is computing now. */
  running: CouncilAttempt | null
  queued: CouncilAttempt[]
  pending: CouncilAttempt[]
  /**
   * The NOTEBOOK's kernel: what it is busy with and how much is waiting in
   * total.
   *
   * From a separate frame (`council:kernel`), not from the stack, and it does
   * not duplicate `running`. The notebook has one queue, and it can be held by
   * an ordinary cell or by an attempt of a NEIGHBOURING council cell — neither
   * is in this cell's stack. Before this field existed, the console said "No
   * code is running in this cell" and "queued: 12" at the same time, and hid
   * the "Interrupt" button: it lived inside the `running` branch.
   *
   * `null` — no frame has arrived yet (an old server, the console has just
   * opened). Then everything reads as before, from the stack alone.
   */
  book: CouncilKernel | null
}

export function kernelView(
  attempts: readonly CouncilAttempt[],
  book: CouncilKernel | null = null,
): KernelView {
  const running = attempts.find((attempt) => attempt.run?.state === 'running') ?? null
  const queued = attempts
    .filter((attempt) => attempt.run?.state === 'queued')
    .sort((a, b) => (a.run?.startedAt ?? 0) - (b.run?.startedAt ?? 0))
  const pending = attempts
    .filter((attempt) => attempt.runRequest?.status === 'pending')
    .sort(
      (a, b) =>
        (a.runRequest?.requestedAt ?? 0) - (b.runRequest?.requestedAt ?? 0) ||
        a.participantId.localeCompare(b.participantId),
    )
  return { running, queued, pending, book }
}

/**
 * How many jobs are waiting their turn — across the whole notebook, not this
 * cell.
 *
 * The number from the kernel frame counts everything: ordinary cells, this
 * cell's attempts and the neighbours' attempts. Before it existed, the console
 * called the length of its own list "queued" — and a teacher reading "3" there
 * expected to wait a minute instead of ten. No frame yet (an old server) — the
 * former number stays: lying about the notebook is worse than honestly
 * speaking about the cell.
 */
export function queuedInBook(kernel: KernelView): number {
  return kernel.book?.queued ?? kernel.queued.length
}

/**
 * Whether there is anything to interrupt: the notebook's kernel is busy — with
 * this cell's attempt or with someone else's job.
 *
 * The "Interrupt" button is drawn by this answer, not by `running`. It used to
 * live inside its own attempt's card, that is, it vanished exactly when the
 * queue was held by someone else's job — the one minute when it is needed.
 */
export function kernelIsBusy(kernel: KernelView): boolean {
  return kernel.running !== null || kernel.book?.busy != null
}

/* -------------------------------------------------------------- rules */

/**
 * The cell's four rules — and one order for every place that talks about them.
 *
 * The order is neither by importance nor alphabetical but follows the course
 * of a class: first who runs at all, then how long one run lasts, then when a
 * rerun is allowed, and finally what of this the hall will see. The sentence
 * in the header, the sheet's rows and the highlight of "the rule the sheet was
 * opened for" read it from here: if they diverged, they would start showing
 * different things for one press.
 */
export type PultRule = 'studentRun' | 'runLimit' | 'rerunPause' | 'names'
export const PULT_RULES: readonly PultRule[] = ['studentRun', 'runLimit', 'rerunPause', 'names']

/**
 * A rules duration in words: "30 s", "1 min", "1 min 30 s".
 *
 * Not `spell()` from utils: that one speaks of what HAPPENED ("ran 4 s") and
 * rounds to the second, while here the number is a chosen setting, and 90 was
 * chosen as "1 min 30 s", not as "2 min". One function for the sentence, the
 * sheet, the run bar and the line "Stopped: longer than 30 s" — otherwise the
 * limit would read one way in one place and another way in another, and the
 * argument would be about which of the two numbers is the real one.
 *
 * There is deliberately no plural in the keys: the abbreviations "с" and
 * "мин" (s/min) do not inflect in either of the two languages.
 */
export function pultDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return tr('room.pult.v2.rules.sec', { count: whole })
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return rest === 0
    ? tr('room.pult.v2.rules.min', { count: minutes })
    : tr('room.pult.v2.rules.minSec', { count: minutes, sec: rest })
}

/**
 * A piece of the rules sentence: a connective, the value-button and the same
 * value in a narrow window.
 */
export interface RulePart {
  rule: PultRule
  /** The connective before the value; hidden in a narrow window. */
  lead: string
  /** The value — that is what gets pressed: it opens the sheet on its own rule. */
  value: string
  /**
   * What the value becomes when the connectives are hidden.
   *
   * Matches `value` everywhere except the pause: "after 30 s" without its
   * connective reads as a second run limit, so in a narrow window "rerun"
   * moves INSIDE the value — "rerun after 30 s".
   */
  short: string
  /** The only yellow value in the sentence — an uncapped run. */
  warn: boolean
}

/**
 * The rules on one line — as a sentence, not a list of knobs.
 *
 * If students cannot run at all, the piece about reruns DISAPPEARS rather
 * than greying out: a pause between runs means nothing for someone who does
 * not run, and a grey "rerun right away" in the sentence is an extra word
 * read every time. Uncapped is the only yellow one: the queue gets stuck dead
 * on it, and that must be known without opening the sheet.
 */
export function rulesSentence(settings: CouncilSettings): RulePart[] {
  const parts: RulePart[] = []
  const run = settings.studentRun
  const runValue = tr(
    run === false
      ? 'room.pult.v2.rules.runTeacher'
      : run === true
        ? 'room.pult.v2.rules.runEveryone'
        : 'room.pult.v2.rules.runRequest',
  )
  parts.push({
    rule: 'studentRun',
    lead: tr(run === false ? 'room.pult.v2.rules.runLeadTeacher' : 'room.pult.v2.rules.runLead'),
    value: runValue,
    short: runValue,
    warn: false,
  })

  const limit = settings.runLimitSec
  const limitValue =
    limit === null
      ? tr('room.pult.v2.rules.limitNone')
      : tr('room.pult.v2.rules.limitValue', { duration: pultDuration(limit) })
  parts.push({
    rule: 'runLimit',
    lead: tr('room.pult.v2.rules.limitLead'),
    value: limitValue,
    short: limitValue,
    warn: limit === null,
  })

  if (run !== false) {
    const pause = settings.rerunPauseSec
    const duration = pultDuration(pause)
    parts.push({
      rule: 'rerunPause',
      lead: tr('room.pult.v2.rules.pauseLead'),
      value: pause > 0 ? tr('room.pult.v2.rules.pauseValue', { duration }) : tr('room.pult.v2.rules.pauseNow'),
      short: pause > 0 ? tr('room.pult.v2.rules.pauseShort', { duration }) : tr('room.pult.v2.rules.pauseShortNow'),
      warn: false,
    })
  }

  const names = tr(
    settings.namesOnProjector ? 'room.pult.v2.rules.screenNames' : 'room.pult.v2.rules.screenAnon',
  )
  parts.push({ rule: 'names', lead: tr('room.pult.v2.rules.screenLead'), value: names, short: names, warn: false })
  return parts
}

/**
 * What to show in the row of buttons: the presets, and a foreign value too.
 *
 * The server accepts any integer within bounds (notebook.ts ·
 * COUNCIL_RUN_LIMIT_MAX), and the value may have come from another build, from
 * history or from a future list of presets. A row in which no button is
 * pressed reads as "the setting is broken"; so a foreign number gets a button
 * of its own — in its place by size, while "uncapped" stays last.
 */
export function limitOptions(current: number | null): (number | null)[] {
  if (COUNCIL_RUN_LIMITS.includes(current)) return [...COUNCIL_RUN_LIMITS]
  const numbers = COUNCIL_RUN_LIMITS.filter((one): one is number => one !== null)
  // "Uncapped" stays last: it is not the largest number but its absence.
  return [...[...numbers, current as number].sort((a, b) => a - b), null]
}

export function pauseOptions(current: number): number[] {
  if (COUNCIL_RERUN_PAUSES.includes(current)) return [...COUNCIL_RERUN_PAUSES]
  return [...COUNCIL_RERUN_PAUSES, current].sort((a, b) => a - b)
}

/** How long this cell's runs really take: the median, the longest and over how many. */
export interface RunStats { median: number; max: number; count: number }

/**
 * The numbers under the limit picker — so it is set by the class, not by fear.
 *
 * Counted over FINISHED runs: a running one has no duration yet, and a run
 * stopped by the limit has a fake one — what was measured there is the limit
 * itself, and the median would creep up from exactly the rule that is chosen
 * by it (set 5 s — "typically 5 s" — set 15 s). Runs interrupted by hand give
 * `ranMs: null` and do not get here either.
 */
export function runStats(attempts: readonly CouncilAttempt[]): RunStats | null {
  const spans = attempts
    .map((attempt) => attempt.run)
    .filter((run): run is NonNullable<CouncilAttempt['run']> =>
      run !== null && run !== undefined && run.ranMs !== null && timedOutLimit({ run }) === null)
    .map((run) => run.ranMs as number)
    .sort((a, b) => a - b)
  if (spans.length === 0) return null
  const middle = Math.floor(spans.length / 2)
  return {
    median: spans.length % 2 === 1 ? spans[middle] : Math.round((spans[middle - 1] + spans[middle]) / 2),
    max: spans[spans.length - 1],
    count: spans.length,
  }
}

/**
 * "How long ago" — and without "1646 min 28 s".
 *
 * `pultDuration` measures a SETTING: the rules' limits live within an hour,
 * and "1 min 30 s" there is exactly what was chosen. Here age is measured: a
 * draft left yesterday is honestly older than a day, and the minutes in it
 * mean nothing. So there is one unit, always the largest: "7 min", "3 h",
 * "2 d".
 *
 * Less than a minute never happens: everything measured by this function has
 * already passed its threshold (five minutes of silence, a minute since the
 * last edit), and "0 min" would be a number that does not exist.
 */
export function pultIdle(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 3600) return tr('room.pult.v2.rules.min', { count: Math.max(1, Math.floor(whole / 60)) })
  if (whole < 86_400) return tr('room.pult.v3.idle.hours', { count: Math.floor(whole / 3600) })
  return tr('room.pult.v3.idle.days', { count: Math.floor(whole / 86_400) })
}

/** The limit that stopped this run — or `null` if nothing stopped it. */
export function timedOutLimit(attempt: {
  run: Pick<NonNullable<CouncilAttempt['run']>, 'timedOut'> | null
}): number | null {
  const limit = attempt.run?.timedOut
  return typeof limit === 'number' ? limit : null
}

/**
 * "Stopped by themselves" — newest on top, by run start.
 *
 * By start, not by submission: the section is about what happened to the
 * QUEUE a minute ago, and a work submitted in the morning and run just now
 * comes first.
 */
export function timedOutAttempts(attempts: readonly CouncilAttempt[]): CouncilAttempt[] {
  return attempts
    .filter((attempt) => timedOutLimit(attempt) !== null)
    .sort(
      (a, b) =>
        (b.run?.startedAt ?? 0) - (a.run?.startedAt ?? 0) || a.participantId.localeCompare(b.participantId),
    )
}

/** The shares of the "whole class on one line" bar — by status, without rounding. */
export function classBar(
  attempts: readonly CouncilAttempt[],
): Record<CouncilStatus | 'writing', number> {
  const bar: Record<CouncilStatus | 'writing', number> = {
    correct: 0,
    wrong: 0,
    failed: 0,
    ran: 0,
    unrun: 0,
    writing: 0,
  }
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) bar.writing += 1
    else bar[attempt.status] += 1
  }
  return bar
}
