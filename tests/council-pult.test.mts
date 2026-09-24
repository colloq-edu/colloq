/**
 * The council console's messenger — the arithmetic of the list.
 *
 * The console lives in a separate window and shows a feed of submissions:
 * people on the left, the work on the right. What is checked here is exactly
 * what makes such a list lie silently.
 *
 *   order   — by submission time, the freshest on top, and NOT by group size
 *             (that is how the stack under the cell went while it existed):
 *             two different questions, and once they were already a single
 *             function;
 *   groups  — there are NONE: the list does not collapse identical answers
 *             and does not hide people under someone else's tail (removed on
 *             20 Sep 2026);
 *   cursor  — j and k jump over section headers: a row that is not on the
 *             screen must not end up under the "show to the class" Enter;
 *   hold    — a new submission does not move the row under the cursor; the
 *             "N more submitted" bar appears only when the list is scrolled
 *             or the cursor is not at the top;
 *   keys    — in the reply field the keys are ITS own, in search the arrows
 *             keep walking the list, Enter on a button presses the button.
 *
 * And the window: the notebook learns "is the console open" from the
 * heartbeat, not from a reference to the window — a notebook reload loses
 * the reference, while the window stays alive. The same heartbeat decides
 * what to do with the "Console ↗" button: open, raise, or switch the room's
 * only window to this cell. And the window's place: full-screen geometry is
 * a trace of a tab, not of the console, and must not be applied.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilAttempt, CouncilBoard } from '../shared/protocol.js'
import {
  attemptRunLine,
  tabFilters,
  bySubmissionDesc,
  classBar,
  heldArrivals,
  holdsArrivals,
  kernelView,
  listRows,
  matchesFilter,
  moveCursor,
  pultCells,
  pultClock,
  pultKeyAction,
  pultRanFor,
  requestReason,
  rowMeaning,
  selectable,
  unreadIds,
  variantNumbers,
} from '../web/src/lib/council-pult.js'
import {
  PULT_HEIGHT,
  PULT_MIN_HEIGHT,
  PULT_MIN_WIDTH,
  PULT_STALE_MS,
  PULT_WIDTH,
  beatsAlive,
  fillsScreen,
  fitPlace,
  pultPath,
  pultReach,
  pultWindowName,
  savesPlace,
  windowFeatures,
} from '../web/src/lib/council-pult-window.js'

const T = 1_700_000_000_000

function attempt(over: Partial<CouncilAttempt> & { participantId: string }): CouncilAttempt {
  const text = over.text ?? 'print(1)'
  return {
    participantId: over.participantId,
    name: over.name ?? over.participantId,
    color: '#4C7FE0',
    avatar: null,
    text,
    submittedAt: over.submittedAt === undefined ? T : over.submittedAt,
    updatedAt: over.updatedAt ?? T,
    status: over.status ?? 'unrun',
    run: over.run ?? null,
    reply: null,
    replies: over.replies,
    correct: over.correct ?? null,
    shown: over.shown ?? false,
    groupKey: over.groupKey ?? text.replace(/\s+/g, ''),
    runRequest: over.runRequest ?? null,
  }
}

const NONE = new Set<string>()

function rows(attempts: CouncilAttempt[], over: Partial<Parameters<typeof listRows>[0]> = {}) {
  return listRows({
    attempts,
    // "All" is the old single list with two sections: these checks are about
    // it.
    tab: 'all',
    filter: 'all',
    search: '',
    unread: NONE,
    held: NONE,
    now: T,
    ...over,
  })
}

/* ---------------------------------------------------------------- order */

test('the feed goes by submission time, the freshest on top, the writing at the end', () => {
  const list = [
    attempt({ participantId: 'a', submittedAt: T + 1000, text: 'a' }),
    attempt({ participantId: 'b', submittedAt: T + 3000, text: 'b' }),
    attempt({ participantId: 'draft', submittedAt: null, text: 'c' }),
    attempt({ participantId: 'c', submittedAt: T + 2000, text: 'd' }),
  ]
  assert.deepEqual(
    [...list].sort(bySubmissionDesc).map((one) => one.participantId),
    ['b', 'c', 'a', 'draft'],
  )
  // And the same order in the built rows — the build does not re-sort its
  // own.
  assert.deepEqual(selectable(rows(list)), ['b', 'c', 'a', 'draft'])
})

/* --------------------------------------------------------------- groups */

test('identical answers are NOT collapsed: one submission, one row', () => {
  /*
   * Grouping stood here from the very beginning: of three identical answers
   * the feed showed one, the rest went under a "N more with the same answer"
   * tail. On 20 Sep 2026 the owner asked to remove it entirely, and the main
   * consequence is checked here: a person from a big group is visible in the
   * list, can be selected with the cursor, and Enter shows exactly them to
   * the class.
   */
  const same = (id: string, at: number) => attempt({ participantId: id, submittedAt: at, text: 'x = 1' })
  const three = [same('a', T + 1), same('b', T + 2), same('c', T + 3)]
  const built = rows(three)
  assert.deepEqual(
    built.map((row) => row.kind),
    ['section', 'attempt', 'attempt', 'attempt'],
    'neither a collapsed tail nor a group header',
  )
  assert.deepEqual(selectable(built), ['c', 'b', 'a'], 'all three are under the cursor')
  // And eighty-seven identical ones are eighty-seven rows too: the console
  // list answers "who submitted", not "what answers there are".
  const many = Array.from({ length: 87 }, (_, at) => same(`p${at}`, T + at))
  assert.equal(selectable(rows(many)).length, 87)
})

/* ------------------------------------------------------------ sections */

test('the feed is split into "Submitted" and "Writing", and the headers count people, not rows', () => {
  /*
   * "Submitted work should be marked better in the console, otherwise you
   * can't see a damn thing" — 19 Sep 2026. The order already put the
   * submitted first, but there was no boundary in the list between them and
   * those still writing: one row of people with no distinctions.
   */
  const list = [
    ...['a', 'b', 'c'].map((id, at) => attempt({ participantId: id, submittedAt: T + at, text: 'x = 1' })),
    attempt({ participantId: 'alone', submittedAt: T + 9, text: 'y = 2' }),
    attempt({ participantId: 'draft1', submittedAt: null, text: 'p' }),
    attempt({ participantId: 'draft2', submittedAt: null, text: 'q' }),
  ]
  const built = rows(list)
  const sections = built.filter((row) => row.kind === 'section')
  assert.deepEqual(sections.map((row) => row.kind === 'section' && row.section), ['submitted', 'writing'])
  assert.equal(sections[0].kind === 'section' && sections[0].count, 4)
  assert.equal(sections[1].kind === 'section' && sections[1].count, 2)
  // The header stands BEFORE its half.
  const at = built.findIndex((row) => row.kind === 'section' && row.section === 'writing')
  assert.equal(built[at + 1].kind === 'attempt' && built[at + 1].id, 'draft1')
  // And it is not given to the cursor: j and k jump over them, Enter on them
  // means nothing.
  assert.deepEqual(selectable(built), ['alone', 'c', 'b', 'a', 'draft1', 'draft2'])
  assert.equal(moveCursor(built, 'alone', 1), 'c')
  assert.equal(moveCursor(built, 'a', 1), 'draft1', 'the cursor got stuck on a section header')
})

test('an empty half gets no header, and filters and search know nothing about sections', () => {
  const drafts = rows([attempt({ participantId: 'd', submittedAt: null })])
  assert.deepEqual(
    drafts.map((row) => row.kind),
    ['section', 'attempt'],
    'drafts alone must have one header',
  )
  assert.equal(drafts[0].kind === 'section' && drafts[0].section, 'writing')
  const mixed = [
    attempt({ participantId: 'ok', submittedAt: T, text: 'a' }),
    attempt({ participantId: 'draft', submittedAt: null, text: 'b' }),
  ]
  // Under a filter the "Submitted · 5" header would speak of a number that is
  // not in the list: the filter has already cut the feed by another
  // criterion. The tabs have none for the same reason: there the feed has
  // only one half anyway.
  assert.ok(!rows(mixed, { tab: 'writing' }).some((row) => row.kind === 'section'))
  assert.ok(!rows(mixed, { tab: 'submitted' }).some((row) => row.kind === 'section'))
  assert.ok(!rows(mixed, { filter: 'new', unread: new Set(['ok']) }).some((row) => row.kind === 'section'))
  assert.ok(!rows(mixed, { search: 'ok' }).some((row) => row.kind === 'section'))
  assert.ok(rows(mixed).some((row) => row.kind === 'section'))
})

/* -------------------------------------------------------------- filters */

test('chips select what they promise, and each tab has its own set', () => {
  const failed = attempt({ participantId: 'f', status: 'failed', run: { state: 'error', outputs: [], execCount: 1, ranMs: 10, startedAt: T, by: 'host' } })
  const wrong = attempt({ participantId: 'w', status: 'wrong', correct: false })
  const ran = attempt({
    participantId: 'r',
    status: 'ran',
    run: { state: 'ok', outputs: [], execCount: 1, ranMs: 10, startedAt: T, by: 'host' },
  })
  const draft = attempt({ participantId: 'd', submittedAt: null })
  const unread = new Set(['f'])

  assert.equal(matchesFilter(failed, 'error', unread), true)
  assert.equal(matchesFilter(wrong, 'error', unread), true, '"wrong" counts as an error too')
  assert.equal(matchesFilter(ran, 'error', unread), false)
  assert.equal(matchesFilter(ran, 'unrun', unread), false, 'it was run — so it does not belong here')
  assert.equal(matchesFilter(failed, 'unrun', unread), false)
  assert.equal(matchesFilter(failed, 'new', unread), true)
  assert.equal(matchesFilter(ran, 'new', unread), false)
  // "Ungraded" is about the teacher's hand: submitted, but no mark. A draft
  // never gets in here under any conditions: it is not graded.
  assert.equal(matchesFilter(ran, 'ungraded', unread), true)
  assert.equal(matchesFilter(wrong, 'ungraded', unread), false, 'there is a mark — so it is graded')
  assert.equal(matchesFilter(draft, 'ungraded', unread), false)
  // The "groups" chip is gone — there is nothing invisible to filter by;
  // "drafts" became a tab, not a chip among the filters inside one stack.
  assert.equal(tabFilters('submitted').includes('groups' as never), false)
  assert.equal(tabFilters('submitted').includes('writing' as never), false)
  assert.deepEqual(tabFilters('submitted'), ['all', 'ungraded', 'new', 'error'])
  assert.deepEqual(tabFilters('writing'), ['all', 'silent', 'failed', 'asking'])
  assert.deepEqual(tabFilters('all'), ['all', 'new'])
})

test('search goes by name and ignores case', () => {
  const list = [
    attempt({ participantId: 'a', name: 'Аня Соколова', text: 'a' }),
    attempt({ participantId: 'b', name: 'Марат Идрисов', text: 'b' }),
  ]
  assert.deepEqual(selectable(rows(list, { search: 'сокол' })), ['a'])
  assert.deepEqual(selectable(rows(list, { search: 'МАРАТ' })), ['b'])
  assert.deepEqual(selectable(rows(list, { search: '   ' })), ['a', 'b'], 'whitespace is not a search')
})

/* ------------------------------------------------------------- unread */

test('the unread dot is only for those who submitted after the window opened, and not for opened ones', () => {
  const list = [
    attempt({ participantId: 'old', submittedAt: T - 1000 }),
    attempt({ participantId: 'new', submittedAt: T + 1000 }),
    attempt({ participantId: 'read', submittedAt: T + 2000 }),
    attempt({ participantId: 'draft', submittedAt: null }),
  ]
  const unread = unreadIds(list, T, new Set(['read']))
  assert.deepEqual([...unread], ['new'])
})

/* ---------------------------------------------------------- cursor */

test('j and k walk over people and jump over section headers', () => {
  const list = [
    attempt({ participantId: 'top', submittedAt: T + 10, text: 'top' }),
    attempt({ participantId: 'mid', submittedAt: T, text: 'x = 1' }),
    attempt({ participantId: 'bottom', submittedAt: T - 10, text: 'bottom' }),
  ]
  const built = rows(list)
  assert.deepEqual(selectable(built), ['top', 'mid', 'bottom'])
  assert.equal(moveCursor(built, 'top', 1), 'mid')
  assert.equal(moveCursor(built, 'mid', 1), 'bottom')
  // At the edges the cursor stays put instead of wrapping: the list is not a
  // carousel.
  assert.equal(moveCursor(built, 'bottom', 1), 'bottom')
  assert.equal(moveCursor(built, 'top', -1), 'top')
  // No cursor — the first press must select something.
  assert.equal(moveCursor(built, null, 1), 'top')
  assert.equal(moveCursor(built, null, -1), 'bottom')
  // A cursor on a row that is no longer in the filter goes to the first one.
  assert.equal(moveCursor(built, 'gone', 1), 'top')
  assert.equal(moveCursor([], 'top', 1), null)
})

/* ---------------------------------------------------- held submissions */

test('new submissions are held back only when there is something to shift', () => {
  assert.equal(holdsArrivals(false, true), false, 'top of the list, cursor on the first — let them in')
  assert.equal(holdsArrivals(true, true), true, 'the list is scrolled')
  assert.equal(holdsArrivals(false, false), true, 'the cursor is not on the first')
})

test('what is held back touches neither the rows in the list nor the row under the cursor', () => {
  const list = [
    attempt({ participantId: 'standing', submittedAt: T + 5000, text: 'a' }),
    attempt({ participantId: 'cursor', submittedAt: T + 6000, text: 'b' }),
    attempt({ participantId: 'fresh', submittedAt: T + 7000, text: 'c' }),
    attempt({ participantId: 'old', submittedAt: T - 5000, text: 'd' }),
  ]
  const held = heldArrivals(list, T, new Set(['standing']), 'cursor')
  assert.deepEqual([...held], ['fresh'])
  // And what is held back is not in the feed — it is the number on the bar.
  assert.deepEqual(selectable(rows(list, { held })), ['cursor', 'standing', 'old'])
})

/* ----------------------------------------------------------------- keys */

test('in the reply field the keys are its own, and ⌘↵ sends', () => {
  assert.equal(pultKeyAction({ key: 'j' }, 'reply'), null)
  assert.equal(pultKeyAction({ key: 'Enter' }, 'reply'), null, 'a bare Enter is a line break')
  assert.equal(pultKeyAction({ key: 'Enter', meta: true }, 'reply'), 'send')
  assert.equal(pultKeyAction({ key: 'Escape' }, 'reply'), 'escape')
  assert.equal(pultKeyAction({ key: '1' }, 'reply'), null, 'a digit in a letter stays a digit')
})

test('in search the arrows keep walking the list, and letters get typed', () => {
  assert.equal(pultKeyAction({ key: 'ArrowDown' }, 'search'), 'next')
  assert.equal(pultKeyAction({ key: 'ArrowUp' }, 'search'), 'prev')
  assert.equal(pultKeyAction({ key: 'j' }, 'search'), null)
  assert.equal(pultKeyAction({ key: 'r' }, 'search'), null)
  assert.equal(pultKeyAction({ key: 'Enter' }, 'search'), 'show')
  assert.equal(pultKeyAction({ key: 'Escape' }, 'search'), 'escape')
})

test('console letters work in the list, and Enter on a button presses the button', () => {
  assert.equal(pultKeyAction({ key: 'j' }, 'list'), 'next')
  assert.equal(pultKeyAction({ key: 'k' }, 'list'), 'prev')
  // Space used to expand a group; there is no grouping — and the key does
  // nothing.
  assert.equal(pultKeyAction({ key: ' ' }, 'list'), null)
  assert.equal(pultKeyAction({ key: 'Enter' }, 'list'), 'show')
  assert.equal(pultKeyAction({ key: 'Enter' }, 'actions'), null, 'otherwise one press does two things')
  assert.equal(pultKeyAction({ key: 'R' }, 'list'), 'run')
  assert.equal(pultKeyAction({ key: '1' }, 'list'), 'correct')
  assert.equal(pultKeyAction({ key: '2' }, 'list'), 'wrong')
  assert.equal(pultKeyAction({ key: '3' }, 'list'), 'clearShown')
  // ← and → walked the neighbours inside a group — there is nowhere to walk.
  assert.equal(pultKeyAction({ key: 'ArrowRight' }, 'list'), null)
  assert.equal(pultKeyAction({ key: 'ArrowLeft' }, 'list'), null)
  assert.equal(pultKeyAction({ key: '?' }, 'list'), 'help')
  assert.equal(pultKeyAction({ key: 'f', meta: true }, 'list'), 'search')
  // The Russian layout — the same keys: the console is kept in a classroom
  // where nobody switches the layout for the sake of two letters.
  assert.equal(pultKeyAction({ key: 'о' }, 'list'), 'next')
  assert.equal(pultKeyAction({ key: 'л' }, 'list'), 'prev')
  assert.equal(pultKeyAction({ key: 'а', meta: true }, 'list'), 'search')
  // System shortcuts do not belong to the console: ⌘W closes the window.
  assert.equal(pultKeyAction({ key: 'w', meta: true }, 'list'), null)
})

/* ---------------------------------------------------------------- words */

test('the meaning stripe says what is required, not what happened', () => {
  const plain = attempt({ participantId: 'a' })
  const asking = attempt({
    participantId: 'b',
    runRequest: { id: 'r1', requestedAt: T, status: 'pending' },
  })
  assert.equal(rowMeaning(plain, null, null), 'none')
  assert.equal(rowMeaning(plain, 'a', null), 'cursor')
  assert.equal(rowMeaning(plain, 'a', 'a'), 'screen', 'the audience matters more than the cursor')
  assert.equal(rowMeaning(asking, 'b', 'b'), 'asking', 'a request matters most of all')
})

test('native button activation and modified arrows are not council shortcuts', () => {
  assert.equal(pultKeyAction({ key: ' ' }, 'actions'), null)
  assert.equal(pultKeyAction({ key: 'ArrowLeft', alt: true }, 'list'), null)
  assert.equal(pultKeyAction({ key: 'ArrowDown', ctrl: true }, 'list'), null)
  assert.equal(pultKeyAction({ key: 'r', composing: true }, 'list'), null)
})

test('the reason for a request is derived from the previous run and not invented', () => {
  const clean = attempt({ participantId: 'a' })
  assert.equal(requestReason(clean), null)
  const failed = attempt({
    participantId: 'b',
    run: {
      state: 'error',
      outputs: [{ kind: 'error', ename: 'TypeError', evalue: 'bad', traceback: [] }],
      execCount: 1,
      ranMs: null,
      startedAt: T,
      by: 'author',
    },
  })
  assert.equal(requestReason(failed), 'TypeError в прошлый раз')
  // It failed without an exception name — we stay silent: a reason on which
  // a decision is made must not be made up.
  const nameless = attempt({
    participantId: 'c',
    run: { state: 'error', outputs: [], execCount: 1, ranMs: null, startedAt: T, by: 'author' },
  })
  assert.equal(requestReason(nameless), null)
})

test('the variant number follows submission time and matches the label shown to the audience', () => {
  const list = [
    attempt({ participantId: 'late', submittedAt: T + 200 }),
    attempt({ participantId: 'early', submittedAt: T + 100 }),
    attempt({ participantId: 'draft', submittedAt: null }),
  ]
  const numbers = variantNumbers(list)
  assert.equal(numbers.get('early'), 1)
  assert.equal(numbers.get('late'), 2)
  assert.equal(numbers.get('draft'), 3, 'those writing come at the tail of the numbering, without gaps')
})

/* ------------------------------------------------------------ run time */

test('the run line says what happened, how long it ran and when', () => {
  /*
   * A verbatim request from the class on 19 Sep 2026: "show the run time in
   * the council console". Without the hour, "Run completed" does not tell an
   * attempt run five minutes ago from one run just now, and different things
   * are decided on them.
   */
  const at = new Date(2026, 8, 19, 17, 24, 5).getTime()
  const run = (over: Record<string, unknown>) => ({ state: 'ok', outputs: [], execCount: 1, ranMs: 1200, startedAt: at, by: 'host', ...over })
  const line = (over: Record<string, unknown>, now = at + 3400) =>
    attemptRunLine({ run: run(over) as never, runRequest: null }, now).label

  assert.equal(line({}), 'Запуск выполнен · 1,2 с · 17:24')
  assert.equal(line({ state: 'error', ranMs: 400 }), 'Ошибка запуска · 0,4 с · 17:24')
  assert.equal(line({ state: 'running', ranMs: null }), 'Считает 3 с', 'a live counter — in whole seconds')
  assert.equal(line({ state: 'queued', ranMs: null }), 'В очереди с 17:24')
  assert.equal(line({ state: 'error', timedOut: 30, ranMs: null }), 'Остановлен пределом 30 с · 17:24')
  // One interrupted by hand has no duration — and does not get a made-up one.
  assert.equal(line({ ranMs: null }), 'Запуск выполнен · 17:24')
  // Not run and asking to run — there is no hour there at all, the word is
  // the same as before.
  assert.equal(attemptRunLine({ run: null }, at).label, 'Не запускали')
  assert.equal(
    attemptRunLine({ run: null, runRequest: { status: 'pending' } }, at).label,
    'Просит запуск',
  )
  // The tone comes from attemptExecution: two places naming the outcome
  // would diverge on the very first new state.
  assert.equal(attemptRunLine({ run: run({ state: 'error' }) as never }, at).tone, 'danger')
  assert.equal(attemptRunLine({ run: run({}) as never }, at).tone, 'positive')
})

test('the run hour has seconds where runs are compared by them', () => {
  const at = new Date(2026, 8, 19, 7, 4, 9).getTime()
  assert.equal(pultClock(at), '07:04')
  assert.equal(pultClock(at, true), '07:04:09')
  // Short runs get a tenth: `spell()` would round the whole class down to
  // "0 s".
  assert.equal(pultRanFor(1200), '1,2 с')
  assert.equal(pultRanFor(400), '0,4 с')
  assert.equal(pultRanFor(9900), '9,9 с')
  // Nobody compares beyond a tenth — there the general rules words apply.
  assert.equal(pultRanFor(12_000), '12 с')
  assert.equal(pultRanFor(95_000), '1 мин 35 с')
})

/* ---------------------------------------------------------- kernel and bar */

test('the queue bar reads the stack: who is running, who is queued, who is asking', () => {
  const run = (state: 'running' | 'queued', at: number) => ({
    state,
    outputs: [],
    execCount: null,
    ranMs: null,
    startedAt: at,
    by: 'host' as const,
  })
  const list = [
    attempt({ participantId: 'now', run: run('running', T) }),
    attempt({ participantId: 'q2', run: run('queued', T + 20) }),
    attempt({ participantId: 'q1', run: run('queued', T + 10) }),
    attempt({ participantId: 'ask', runRequest: { id: 'r', requestedAt: T, status: 'pending' } }),
    attempt({ participantId: 'no', runRequest: { id: 'r2', requestedAt: T, status: 'declined' } }),
  ]
  const view = kernelView(list)
  assert.equal(view.running?.participantId, 'now')
  assert.deepEqual(view.queued.map((one) => one.participantId), ['q1', 'q2'], 'by the time they were queued')
  assert.deepEqual(view.pending.map((one) => one.participantId), ['ask'], 'a declined one is not waiting')
})

test('the "whole class in one line" bar counts by status, and the writing separately', () => {
  const bar = classBar([
    attempt({ participantId: 'a', status: 'correct' }),
    attempt({ participantId: 'b', status: 'correct' }),
    attempt({ participantId: 'c', status: 'wrong' }),
    attempt({ participantId: 'd', status: 'failed' }),
    attempt({ participantId: 'e', submittedAt: null, status: 'correct' }),
  ])
  assert.equal(bar.correct, 2)
  assert.equal(bar.wrong, 1)
  assert.equal(bar.failed, 1)
  assert.equal(bar.writing, 1, 'a draft counts as writing whatever its status says')
})

/* ---------------------------------------------------------------- window */

test('"console open" lives by the heartbeat, not by a reference to the window', () => {
  const beat = { sessionId: 'kf3n8q2p', cellId: 'c1', at: T }
  assert.equal(beatsAlive(beat, T + 100), true)
  assert.equal(beatsAlive(beat, T + PULT_STALE_MS), false, 'silence for longer than three seconds — closed')
  assert.equal(beatsAlive({ ...beat, closed: true }, T), false, 'a farewell does not wait for fading')
  assert.equal(beatsAlive(null, T), false)
})

test('the window opens by the room\'s name, as a popup and at the given size', () => {
  assert.equal(pultWindowName('kf3n8q2p'), 'colloq-council-pult-kf3n8q2p')
  assert.equal(pultPath('kf3n8q2p', 'cell-04'), '/s/kf3n8q2p/council/cell-04')
  const fresh = windowFeatures(null)
  // popup=yes is required: without it Chrome opens a TAB and silently
  // forgets the size, and a console in a tab is the same notebook a second
  // time.
  assert.match(fresh, /popup=yes/)
  assert.match(fresh, /width=1120/)
  assert.match(fresh, /height=820/)
  assert.doesNotMatch(fresh, /left=/, 'we do not know the place yet — the string has no coordinates')
  const remembered = windowFeatures({ left: 120, top: 40, width: 1000, height: 800 })
  assert.match(remembered, /left=120/)
  assert.match(remembered, /top=40/)
  assert.match(remembered, /width=1000/)
})

test('the "Console" button: open, raise or switch — by the last heartbeat', () => {
  const here = { sessionId: 'kf3n8q2p', cellId: 'c1', at: T }
  // No heartbeat at all — there is no window, we open one.
  assert.equal(pultReach(null, 'c1', T), 'open')
  // A heartbeat, but long ago: the window was closed, and the last message
  // remained.
  assert.equal(pultReach(here, 'c1', T + PULT_STALE_MS), 'open')
  assert.equal(pultReach({ ...here, closed: true }, 'c1', T), 'open', 'it said goodbye — so it is closed')
  // Alive and on this cell — raise it without reloading: otherwise the
  // filter, the cursor and what has been read would be wiped, that is, the
  // whole way of looking.
  assert.equal(pultReach(here, 'c1', T + 100), 'focus')
  // Alive, but on another cell — switch it here: a second window of the same
  // room would be a second place with names, the very thing the window was
  // introduced to prevent.
  assert.equal(pultReach(here, 'c2', T + 100), 'navigate')
})


/* ---------------------------------------------------------- window place */

const SCREEN = { width: 1512, height: 944 }

test('a full-screen place is a trace of a tab, and it is not applied', () => {
  /*
   * A complaint on 20 Sep 2026: "the console opens as a tab, not a window".
   * Half of it was poisoned memory. A console opened once by its direct
   * address (the link was pasted into the address bar) measured the WHOLE
   * browser as itself and wrote someone else's window geometry into
   * localStorage. The next `window.open` asked for a screen-sized popup from
   * point 0,0 — indistinguishable from a tab — and every opening confirmed
   * the memory for the next one.
   */
  const poison = { left: 0, top: 0, width: SCREEN.width, height: SCREEN.height }
  assert.equal(fillsScreen(poison, SCREEN), true)
  assert.equal(fitPlace(poison, SCREEN), null, 'such a place is forgotten entirely')
  // And it cannot be written either — neither from a tab nor from its own
  // window.
  assert.equal(savesPlace(poison, SCREEN, true), false)
  assert.equal(savesPlace({ left: 40, top: 40, width: 1000, height: 800 }, SCREEN, false), false,
    'not our window — not its place')
  assert.equal(savesPlace({ left: 40, top: 40, width: 1000, height: 800 }, SCREEN, true), true)
})

test('a remembered place is clamped from both sides, and a monitor on the left stays', () => {
  // Not "full screen" (smaller in height), so the place is alive, but its
  // width gets trimmed: the browser would not give a popup wider than the
  // monitor anyway.
  const big = fitPlace({ left: 10, top: 20, width: 9000, height: 700 }, SCREEN)
  assert.ok(big)
  assert.ok(big.width <= SCREEN.width && big.height <= SCREEN.height, 'we do not ask for more than the screen')
  const small = fitPlace({ left: 10, top: 20, width: 200, height: 120 }, SCREEN)
  assert.equal(small?.width, PULT_MIN_WIDTH, 'a 200 px slit is not a console')
  assert.equal(small?.height, PULT_MIN_HEIGHT)
  // A negative coordinate is a second monitor on the left, not garbage:
  // `screen` knows nothing about it, and clamping it would mean dragging the
  // window back.
  assert.equal(fitPlace({ left: -1800, top: 40, width: 1000, height: 800 }, SCREEN)?.left, -1800)
  // The screen is unknown (a test, an old browser) — only the lower bounds
  // remain.
  assert.equal(fitPlace({ left: 0, top: 0, width: 4000, height: 3000 }, null)?.width, 4000)
})

test('the size is always in the features: without it Chrome does not respect popup=yes', () => {
  for (const place of [null, { left: 10, top: 10, width: 900, height: 700 }]) {
    const features = windowFeatures(place)
    assert.match(features, /popup=yes/)
    assert.match(features, /width=\d+/)
    assert.match(features, /height=\d+/)
  }
  assert.match(windowFeatures(null), new RegExp(`width=${PULT_WIDTH}`))
  assert.match(windowFeatures(null), new RegExp(`height=${PULT_HEIGHT}`))
})

/* ------------------------------------------------------------ cell list */

function board(over: Partial<CouncilBoard> = {}): CouncilBoard {
  return {
    lock: 'council',
    settings: { studentRun: 'free', runLimitSec: 30, rerunPauseSec: 0, namesOnProjector: true },
    counts: { attempts: 3, submitted: 2, writing: 1, groups: 1 },
    attempts: [],
    groups: [],
    oracle: null,
    ...over,
  } as CouncilBoard
}

test('the cell list: ordered by notebook and number, with numbers and notes', () => {
  const running = attempt({
    participantId: 'r',
    run: { state: 'running', outputs: [], execCount: 1, ranMs: null, startedAt: T, by: 'host' },
  })
  const list = pultCells([
    { cellId: 'c2', index: 7, book: 'lab.ipynb', lock: 'council', counts: board().counts,
      room: { submitted: 12, total: 25 }, attempts: [running], onScreen: false },
    { cellId: 'c1', index: 3, book: 'lab.ipynb', lock: 'council', counts: board().counts,
      room: { submitted: 4, total: 25 }, attempts: [], onScreen: true },
    { cellId: 'c3', index: 1, book: 'hw.ipynb', lock: 'open', counts: board().counts,
      room: null, attempts: [], onScreen: false },
  ])
  assert.deepEqual(list.map((cell) => cell.cellId), ['c3', 'c1', 'c2'], 'notebook, then number')
  // Cells from different notebooks — the notebook name is printed: numbers
  // are unique only within a notebook, and two "cells 03" could not be told
  // apart otherwise.
  assert.equal(list[0].book, 'hw.ipynb')
  assert.equal(list[1].submitted, 4)
  assert.equal(list[1].total, 25)
  assert.equal(list[1].onScreen, true)
  assert.equal(list[2].running, true, 'someone is running right now')
  // The council was removed, attempts remain: the cell does not go away, it
  // gets "review".
  assert.equal(list[0].review, true)
  assert.equal(list[1].review, false)
  // The room count has not arrived — the stack count is taken, not zero.
  assert.equal(list[0].submitted, 2)
  assert.equal(list[0].total, 3)
})

test('the notebook name always travels — the menu hides it, not the list build', () => {
  /*
   * 20 Sep 2026, a request from the class: "add the notebook name to this
   * list — there may well be two ninth cells from different files here". A
   * number is unique only within a notebook, so the name must reach the menu
   * in EVERY row; whether to show it in the rows or once in the header is
   * the menu's decision (PultCells.svelte · manyBooks), and it is checked
   * separately.
   */
  const one = pultCells([
    { cellId: 'a', index: 2, book: 'lab.ipynb', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
    { cellId: 'b', index: 5, book: 'lab.ipynb', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
  ])
  assert.deepEqual(one.map((cell) => cell.book), ['lab.ipynb', 'lab.ipynb'])
  // A cell removed from the document goes to the tail instead of standing
  // first.
  const gone = pultCells([
    { cellId: 'a', index: null, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
    { cellId: 'b', index: 5, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
  ])
  assert.deepEqual(gone.map((cell) => cell.cellId), ['b', 'a'])
})
