/**
 * Console v3: three places the owner approved from the mock-ups on 20 Sep
 * 2026.
 *
 * Paper 05d, artboards "11 · v3 · Работы" and "12 · v3 · детали". Three
 * things change, and each of them breaks silently:
 *
 *  1. THE WORK HEADER. Four disparate pieces stood in a row — a filled
 *     "SUBMITTED 15:19" badge, bare "offline" text, a review badge and
 *     "2 / 13", with "submitted" sounding twice. There should be three roles:
 *     who · what is up with the work · where I am in the stack, and the state
 *     has exactly FOUR values.
 *  2. CELL CHOICE. "Cell 60" and "cell 65" are indistinguishable in the
 *     menu; the task title is derived from the cell's text by a rule that is
 *     checked here, not by eye on a test stand.
 *  3. LIST TABS. Those who submitted and those who are writing have
 *     different questions, different filters and a different ORDER: the
 *     first get a feed of submissions, the second a list of alarms.
 *
 * And a fourth one, which came the same day: on reload the console flashed
 * "the cell is not in council" between the splash and itself, because
 * `board === null` meant "waiting" and "none" at once.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilAttempt, CouncilBoard } from '../shared/protocol.js'
import { COUNCIL_SILENCE_MS } from '../shared/notebook.js'
import {
  attemptReview,
  byAlarm,
  cellHeadline,
  cellNotes,
  cellTaskTitle,
  draftAlarm,
  draftLine,
  filterCounts,
  filterInTab,
  listRows,
  markdownHeadline,
  neighbourCell,
  othersWaiting,
  pultCells,
  pultKeyAction,
  pultShortcutAllowed,
  selectable,
  tabCounts,
  tabFilters,
} from '../web/src/lib/council-pult.js'
import { boardPhase, WELCOME_WAIT_MS } from '../web/src/lib/council.svelte.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}
/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}
const PULT = 'web/src/components/council/pult'
const WORK = code(read(`${PULT}/PultWork.svelte`))
const WINDOW = code(read(`${PULT}/PultWindow.svelte`))
const FILTERS = code(read(`${PULT}/PultFilters.svelte`))
const CELLS = code(read(`${PULT}/PultCells.svelte`))
const KEYS = code(read(`${PULT}/PultKeys.svelte`))

const T = 1_700_000_000_000
const NONE = new Set<string>()

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

/* -------------------------------------------------- 1 · work header */

test('the work state is one badge with exactly four values', () => {
  /*
   * There were two badges for one thought: "SUBMITTED 15:19" in the accent
   * and, next to it, the review "Submitted · awaiting review". The word
   * "submitted" stood twice, and telling submitted work from a draft still
   * came down to whether the second badge was there.
   */
  const waiting = attemptReview({ submittedAt: T, correct: null })
  const right = attemptReview({ submittedAt: T, correct: true })
  const revise = attemptReview({ submittedAt: T, correct: false })
  const draft = attemptReview({ submittedAt: null, correct: null })
  const all = [waiting, right, revise, draft]
  assert.equal(new Set(all.map((one) => one.label)).size, 4, 'four states — four different words')
  // Exactly one is filled — the one that needs the teacher's hand. A fill in
  // this window means "something is expected of you", and there cannot be
  // two such.
  assert.deepEqual(all.map((one) => one.shape ?? null), ['fill', null, null, 'outline'])
  assert.deepEqual(all.map((one) => one.tone), ['accent', 'positive', 'warning', 'neutral'])
  // "Submitted" left the word: the submission time is now in the quiet line
  // under the name.
  assert.doesNotMatch(waiting.label, /сдано/i)

  // And in the header there is only one: the former `.work-state` +
  // `.work-review` merged.
  assert.match(WORK, /class="pult-badge work-state" data-tone=\{review\?\.tone\} data-shape=\{review\?\.shape\}/)
  assert.doesNotMatch(WORK, /data-pult-review/, 'the second badge in the header is back')
  assert.doesNotMatch(WORK, /room\.pult\.v3\.workSubmitted/, '"SUBMITTED 15:19" is back as a separate badge')
  assert.match(WORK, /<span class="pult-badge-dot"/, 'there is no dot at the left of the badge')
})

test('the quiet line under the name: a time without grammatical gender and presence without a made-up hour', () => {
  /*
   * The product nowhere derives a verb's gender from a name, and it does not
   * here either: the neuter "сдано в 15:19" is right for everyone. The client
   * HAS NO hour of going offline: presence arrives as a live Yjs set
   * (session.peersById), `participants.last_seen` lives in the server's
   * database, `presence.left` is an activity log entry. Hence "offline", not
   * "offline since 15:24".
   */
  assert.match(WORK, /room\.pult\.v3\.head\.submitted/)
  assert.match(WORK, /presence !== 'unknown'/, 'unknown presence must stay silent')
  const ru = read('shared/locales/room.ts')
  assert.match(ru, /"room\.pult\.v3\.head\.submitted": \{"ru": "сдано в \{time\}"/)
  assert.doesNotMatch(ru, /"ru": "не в сети с \{/, 'the client is not sent the time of leaving — there is nothing to make it up from')
  for (const word of ['сдал(а)', 'сдала', 'правила ']) {
    assert.ok(!ru.includes(`"ru": "${word}`), `gender derived from a name: ${word}`)
  }
})

test('the pager walks the visible list and goes dark at the edges', () => {
  // The buttons must do exactly what j / k do: the same `step`, the same
  // `moveCursor` over the same rows. Otherwise "1 of 13" counts one thing and
  // the arrow leads to another.
  assert.match(WINDOW, /function step\(delta: 1 \| -1\): void \{\s*const next = moveCursor\(rows, cursor, delta\)/)
  assert.match(WINDOW, /onstep=\{step\}/)
  assert.match(WORK, /disabled=\{index <= 1\} onclick=\{\(\) => onstep\(-1\)\}/)
  assert.match(WORK, /disabled=\{index >= total\} onclick=\{\(\) => onstep\(1\)\}/)
  // There is no pager on a phone: there one walks the feed with the arrows of
  // the work screen's bar, and returns to the list with a gesture.
  assert.match(WORK, /\{#if !phone\}\s*<div class="work-pager"/)
})

test('the pager counter counts within the current tab and filter', () => {
  const list = [
    attempt({ participantId: 'a', submittedAt: T + 3 }),
    attempt({ participantId: 'b', submittedAt: T + 2, correct: true }),
    attempt({ participantId: 'c', submittedAt: T + 1, correct: false }),
    attempt({ participantId: 'd1', submittedAt: null, updatedAt: T }),
    attempt({ participantId: 'd2', submittedAt: null, updatedAt: T }),
  ]
  const shown = (tab: 'submitted' | 'writing' | 'all', filter: 'all' | 'ungraded' = 'all'): string[] =>
    selectable(listRows({ attempts: list, tab, filter, search: '', unread: NONE, held: NONE, now: T }))
  assert.equal(shown('all').length, 5)
  assert.equal(shown('submitted').length, 3)
  assert.equal(shown('writing').length, 2)
  // The filter cuts further: "1 of 1", not "1 of 5".
  assert.deepEqual(shown('submitted', 'ungraded'), ['a'])
  // It is from exactly this list that the console takes the header numbers.
  assert.match(WINDOW, /const ids = \$derived\(selectable\(rows\)\)/)
  assert.match(WINDOW, /const place = \$derived\(cursor === null \? 0 : ids\.indexOf\(cursor\) \+ 1\)/)
  assert.match(WINDOW, /index=\{place\}\s*total=\{ids\.length\}/)
})

/* -------------------------------------------------- 2 · cell choice */

test('the task title: a decorated comment, code with a heading above, and empty', () => {
  // A comment: the hashes and the frame are stripped, the service prefix too.
  assert.equal(cellHeadline('# Важность признаков\nimp = clf.feature_importances_'), 'Важность признаков')
  assert.equal(cellHeadline('# ═══════════════\n# Важность признаков\n# ═══════════════\ncode()'), 'Важность признаков')
  assert.equal(cellHeadline('#### ---- Важность признаков ----'), 'Важность признаков')
  assert.equal(cellHeadline('# ЯЧЕЙКА СТУДЕНТА · Важность признаков'), 'Важность признаков')
  // One all-caps word before the dot is the TITLE, not a prefix:
  // "S5E12 · минимум" in the menu must stay as it is.
  assert.equal(cellHeadline('# S5E12 · минимум'), 'S5E12 · минимум')
  // The first non-empty line is code — the cell has no title, and making one
  // up from code is not allowed: "imp = clf.feature_importances_" is worse
  // than an honest "cell 03".
  assert.equal(cellHeadline('\n\nimp = clf.feature_importances_\n# поздний комментарий'), '')
  assert.equal(cellHeadline(''), '')
  // Then the label is the HEADING of the markdown cell above this one — and
  // only that.
  assert.equal(markdownHeadline('## Важность признаков\n\nПосчитайте…'), 'Важность признаков')
  // A live seminar cell: a paragraph, and under it the task heading. The
  // title is the second one, and the last heading is taken: it is the closest
  // to the code below it.
  assert.equal(
    markdownHeadline('Остались пропуски только в числовых признаках (`GarageYrBlt`).\n\n### Задача 1\n\nИсследуйте…'),
    'Задача 1',
  )
  // No heading, no title: a paragraph as a title is worse than an honest
  // "cell NN".
  assert.equal(markdownHeadline('\nПросто абзац без заголовка'), '')
  assert.equal(markdownHeadline('   '), '')
  // And the fallback word is the former "cell NN", and without a number a
  // generic name.
  assert.equal(cellTaskTitle({ title: 'Важность признаков', index: 3 }), 'Важность признаков')
  assert.equal(cellTaskTitle({ title: '  ', index: 3 }), 'ячейка 03')
  assert.equal(cellTaskTitle({ title: '', index: null }), 'Консилиум')
  // The console assembles this in one place — the same one where the number
  // and the notebook are.
  assert.match(WINDOW, /title: cellHeadline\(text\) \|\| above/)
  assert.match(WINDOW, /const heading = markdownHeadline\(text\)/)
  assert.match(CELLS, /cellTaskTitle\(cell\)/)
})

function board(over: Partial<CouncilBoard> = {}): CouncilBoard {
  return {
    cellId: 'c',
    lock: 'council',
    settings: { studentRun: 'free', runLimitSec: 30, rerunPauseSec: 0, namesOnProjector: true },
    counts: { attempts: 3, submitted: 2, writing: 1, groups: 1 },
    attempts: [],
    groups: [],
    oracle: null,
    ...over,
  } as CouncilBoard
}

test('the menu row counts what people go into the cell for — from the boards, without the server', () => {
  const running = attempt({
    participantId: 'r',
    run: { state: 'running', outputs: [], execCount: 1, ranMs: null, startedAt: T, by: 'host' },
  })
  const queued = attempt({
    participantId: 'q',
    run: { state: 'queued', outputs: [], execCount: 1, ranMs: null, startedAt: T, by: 'host' },
  })
  const asking = attempt({
    participantId: 'a',
    submittedAt: null,
    runRequest: { id: '1', status: 'pending', requestedAt: T },
  })
  const graded = attempt({ participantId: 'g', correct: true })
  const cells = pultCells([
    { cellId: 'busy', index: 5, title: 'S5E12 · минимум', book: '', lock: 'council', counts: board().counts,
      room: { submitted: 6, total: 19 }, attempts: [running, queued, asking, graded], onScreen: true },
    { cellId: 'calm', index: 2, title: 'Rohlik · минимум', book: '', lock: 'council', counts: board().counts,
      room: { submitted: 22, total: 24 }, attempts: [graded], onScreen: false },
    { cellId: 'shut', index: 1, title: 'Разминка', book: '', lock: 'open', counts: board().counts,
      room: { submitted: 24, total: 24 }, attempts: [attempt({ participantId: 'x' })], onScreen: false },
  ])
  const busy = cells.find((cell) => cell.cellId === 'busy')!
  assert.equal(busy.waiting, 2, 'submitted without a mark: running and queued')
  assert.equal(busy.asking, 1)
  assert.equal(busy.queued, 1)
  assert.equal(busy.running, true)
  assert.deepEqual(
    cellNotes(busy).map((note) => note.text),
    ['2 ждут оценки', '1 просит запуск', 'идёт запуск · 1 в очереди', 'на экране'],
  )
  assert.equal(cellNotes(busy)[0].tone, 'accent', 'awaiting review is the only thing that needs a hand')
  assert.equal(cellNotes(busy).at(-1)?.chip, true, '"on screen" is a badge, not a count')
  // A cell that has been dealt with says so in words: an empty line would
  // read as "did not finish loading".
  assert.deepEqual(cellNotes(cells.find((cell) => cell.cellId === 'calm')!).map((one) => one.text), ['все сданные оценены'])
  // A closed council — in one piece and instead of everything else.
  assert.deepEqual(
    cellNotes(cells.find((cell) => cell.cellId === 'shut')!).map((one) => one.text),
    ['консилиум закрыт · только просмотр'],
  )
  // And how many OTHER cells await review — a caption next to the button;
  // zero is not written at all. A closed one does not count: its menu row
  // shows no numbers, and calling people there with a caption that matches
  // nothing in the menu is not allowed.
  assert.equal(othersWaiting(cells, 'calm'), 1)
  assert.equal(othersWaiting(cells, 'busy'), 0)
  assert.equal(othersWaiting(cells, 'shut'), 1)
})

test('the [ and ] keys follow the same order as the menu and do not wrap around', () => {
  const cells = pultCells([
    { cellId: 'b', index: 5, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
    { cellId: 'a', index: 2, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
    { cellId: 'c', index: 9, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
  ])
  assert.deepEqual(cells.map((one) => one.cellId), ['a', 'b', 'c'])
  assert.equal(neighbourCell(cells, 'a', 1), 'b')
  assert.equal(neighbourCell(cells, 'b', -1), 'a')
  assert.equal(neighbourCell(cells, 'c', 1), null, 'at the edge the circle does not close')
  assert.equal(neighbourCell(cells, 'a', -1), null)
  assert.equal(neighbourCell(cells, 'ghost', 1), null)

  assert.equal(pultKeyAction({ key: '[' }, 'list'), 'prevCell')
  assert.equal(pultKeyAction({ key: ']' }, 'list'), 'nextCell')
  // The Russian layout — the same keys.
  assert.equal(pultKeyAction({ key: 'х' }, 'list'), 'prevCell')
  assert.equal(pultKeyAction({ key: 'ъ' }, 'list'), 'nextCell')
  // In the reply field text is typed, and a bracket there is a bracket.
  assert.equal(pultKeyAction({ key: '[' }, 'reply'), null)
  // The cell is a rule of the window, not of the opened work: people switch
  // from the queue and from the oracle just as often.
  assert.equal(pultShortcutAllowed('nextCell', 'queue', false), true)
  assert.equal(pultShortcutAllowed('prevCell', 'oracle', false), true)
  assert.equal(pultShortcutAllowed('nextCell', 'work', false, true), false, 'behind an open menu there are no keys')
  // Switching goes by address, the same as a choice from the menu.
  assert.match(WINDOW, /const next = neighbourCell\(cells, cellId, action === 'nextCell' \? 1 : -1\)\s*\n\s*if \(next !== null\) onpick\(next\)/)
  // And the keyboard help mentions them.
  assert.match(KEYS, /keys: \['\[', '\]'\]/)
  assert.match(KEYS, /room\.pult\.v3\.keys\.cells/)
})

test('the slash opens search, and the magnifier does the same', () => {
  assert.equal(pultKeyAction({ key: '/' }, 'list'), 'search')
  assert.equal(pultKeyAction({ key: '/' }, 'reply'), null, 'in a letter the slash is a character')
  assert.match(FILTERS, /data-pult-search-open/)
  assert.match(FILTERS, /room\.pult\.v3\.openSearch/)
})

/* ------------------------------------------------------ 3 · list tabs */

test('the "Writing" tab is ordered by alarm: silent, failed, asking to run, the rest', () => {
  const silent = attempt({ participantId: 'silent', submittedAt: null, updatedAt: T - COUNCIL_SILENCE_MS - 60_000 })
  const older = attempt({ participantId: 'older', submittedAt: null, updatedAt: T - COUNCIL_SILENCE_MS - 600_000 })
  const failed = attempt({
    participantId: 'failed',
    submittedAt: null,
    updatedAt: T - 10_000,
    run: { state: 'error', outputs: [], execCount: 1, ranMs: 30, startedAt: T - 20_000, by: 'author' },
  })
  const asking = attempt({
    participantId: 'asking',
    submittedAt: null,
    updatedAt: T - 5_000,
    runRequest: { id: '1', status: 'pending', requestedAt: T - 40_000 },
  })
  const typing = attempt({ participantId: 'typing', submittedAt: null, updatedAt: T - 1_000 })
  const list = [typing, asking, failed, silent, older]

  assert.equal(draftAlarm(silent, T), 'silent')
  assert.equal(draftAlarm(failed, T), 'failed')
  assert.equal(draftAlarm(asking, T), 'asking')
  assert.equal(draftAlarm(typing, T), 'writing')
  // One who asked for a run is NOT "silent": their sheet stands still because
  // they are waiting for us.
  const quietAsker = attempt({
    participantId: 'q',
    submittedAt: null,
    updatedAt: T - COUNCIL_SILENCE_MS - 60_000,
    runRequest: { id: '2', status: 'pending', requestedAt: T - 30_000 },
  })
  assert.equal(draftAlarm(quietAsker, T), 'asking')

  assert.deepEqual(
    [...list].sort(byAlarm(T)).map((one) => one.participantId),
    ['older', 'silent', 'failed', 'asking', 'typing'],
    'within an alarm, the one who has waited longer comes first',
  )
  // And this is the order of this tab specifically: "Submitted" stays a feed
  // of submissions.
  const sorted = (tab: 'writing' | 'all'): string[] =>
    selectable(listRows({ attempts: list, tab, filter: 'all', search: '', unread: NONE, held: NONE, now: T }))
  assert.deepEqual(sorted('writing'), ['older', 'silent', 'failed', 'asking', 'typing'])
  // In the combined list the order is as before — the submissions feed: the
  // unsubmitted at the tail and by id, because they have no submission time
  // and there is nothing to sort them by.
  assert.deepEqual(sorted('all'), ['asking', 'failed', 'older', 'silent', 'typing'])
})

test('a writing student\'s row says one of four things and does not repeat the word "Draft"', () => {
  const silent = attempt({ participantId: 's', submittedAt: null, updatedAt: T - 7 * 60_000, text: 'a\nb' })
  const line = draftLine(silent, T)
  assert.match(line.label, /молчит 7 мин · 2 строки/)
  assert.equal(line.tone, 'warning')
  // The age is named in one unit, the largest: "1646 min 28 s" is what stood
  // in the list before the fix, and it cannot be read.
  assert.match(draftLine(attempt({ participantId: 'n', submittedAt: null, updatedAt: T - 3 * 3600_000 }), T).label, /молчит 3 ч/)
  assert.match(draftLine(attempt({ participantId: 'd', submittedAt: null, updatedAt: T - 50 * 3600_000 }), T).label, /молчит 2 дн/)
  const failed = draftLine(
    attempt({
      participantId: 'f',
      submittedAt: null,
      run: { state: 'error', outputs: [{ kind: 'error', ename: 'KeyError', evalue: 'x', traceback: [] }], execCount: 1, ranMs: 1, startedAt: T, by: 'author' },
    }),
    T,
  )
  assert.match(failed.label, /KeyError/)
  assert.equal(failed.tone, 'danger')
  const asking = draftLine(
    attempt({ participantId: 'a', submittedAt: null, runRequest: { id: '1', status: 'pending', requestedAt: T - 40_000 } }),
    T,
  )
  assert.match(asking.label, /^просит запуск · ждёт 40 с$/, 'the list row starts in lowercase, like its neighbours')
  assert.match(draftLine(attempt({ participantId: 'w', submittedAt: null, text: 'a\nb\nc' }), T).label, /пишет · 3 строки/)
})

test('the silence threshold is one number for the oracle and the console', () => {
  // Once they diverged, two copies would give a person who is stuck in the
  // summary but writing in the list — and the argument would be about which
  // number is the real one.
  assert.equal(COUNCIL_SILENCE_MS, 5 * 60_000)
  const server = read('server/src/ai/council.ts')
  assert.match(server, /const SILENCE_MS = COUNCIL_SILENCE_MS/)
  assert.doesNotMatch(server, /const SILENCE_MS = \d/, 'a second copy of the threshold is back on the server')
})

test('tab and chip counters count exactly what will land in them', () => {
  const unread = new Set(['fresh'])
  const list = [
    attempt({ participantId: 'fresh', submittedAt: T + 5 }),
    attempt({ participantId: 'graded', submittedAt: T + 4, correct: true }),
    attempt({ participantId: 'wrong', submittedAt: T + 3, correct: false }),
    attempt({ participantId: 'silent', submittedAt: null, updatedAt: T - COUNCIL_SILENCE_MS - 1000 }),
    attempt({ participantId: 'typing', submittedAt: null, updatedAt: T }),
  ]
  assert.deepEqual(tabCounts(list), { submitted: 3, writing: 2, all: 5 })
  const submitted = filterCounts(list, 'submitted', unread, T)
  assert.equal(submitted.all, 3)
  assert.equal(submitted.ungraded, 1, 'two are graded, one is waiting')
  assert.equal(submitted.new, 1)
  assert.equal(submitted.error, 1, '"wrong" counts as an error too')
  const writing = filterCounts(list, 'writing', unread, T)
  assert.equal(writing.all, 2)
  assert.equal(writing.silent, 1)
  assert.equal(writing.failed, 0)
  assert.equal(writing.asking, 0)
  // A chip's number and the length of the list under it are the same thing.
  for (const [tab, chips] of [['submitted', submitted], ['writing', writing]] as const) {
    for (const filter of tabFilters(tab)) {
      const rows = selectable(listRows({ attempts: list, tab, filter, search: '', unread, held: NONE, now: T }))
      assert.equal(rows.length, chips[filter], `${tab}/${filter}: the chip promises something other than what is in the list`)
    }
  }
})

test('a chip from another tab silently becomes "All" when the tab changes', () => {
  assert.equal(filterInTab('writing', 'ungraded'), 'all')
  assert.equal(filterInTab('submitted', 'silent'), 'all')
  assert.equal(filterInTab('submitted', 'error'), 'error')
  // The filter is remembered per tab, and the tab survives a remount of the
  // window.
  assert.match(WINDOW, /let filters = \$state<Record<PultTab, PultFilter>>/)
  assert.match(WINDOW, /let lastTab: 'submitted' \| 'writing' \| 'all' = 'submitted'/)
  assert.match(WINDOW, /let listTab = \$state<PultTab>\(lastTab\)/)
})

test('the chip row is one line at any width, and it holds four chips', () => {
  /*
   * Wrapping the row onto a second line costs the list one work, and in a
   * 900×650 window only three are visible. Hence `nowrap` without
   * reservations, and the extra chip ("not run") was removed from the set:
   * it did not fit in a 280 px column.
   */
  const css = read(`${PULT}/PultFilters.svelte`)
  assert.match(css, /\.pult-chips \{[^}]*flex-wrap:nowrap/)
  assert.doesNotMatch(css, /\.pult-chips \{[^}]*flex-wrap:wrap/)
  for (const tab of ['submitted', 'writing', 'all'] as const) {
    assert.ok(tabFilters(tab).length <= 4, `${tab}: there are more than four chips`)
    assert.equal(tabFilters(tab).includes('unrun'), false, 'the "not run" chip is back in the set')
  }
})

/* ------------------------------------ 4 · "waiting" versus "not here" */

test('the console tells "the stack is still on its way" from "there is no council here"', () => {
  const ready = board()
  const settled = { settled: true, connected: true, council: false }
  assert.equal(boardPhase({ board: ready, ...settled }), 'ready')
  // The council was removed and no attempts are left — there is nothing to
  // show, and that is "none".
  assert.equal(
    boardPhase({ board: board({ lock: 'open', counts: { attempts: 0, submitted: 0, writing: 0, groups: 0 } }), ...settled }),
    'missing',
  )
  // The council was removed, but attempts remain: they are looked at until
  // the end of the class.
  assert.equal(boardPhase({ board: board({ lock: 'open' }), ...settled }), 'ready')
  // The batch is still on its way — silence is not an answer.
  assert.equal(boardPhase({ board: null, settled: false, connected: true, council: false }), 'waiting')
  assert.equal(boardPhase({ board: null, ...settled }), 'missing')
  // The document already knows about the council, the socket is still
  // silent: the CRDT and the socket are different channels, and "none" would
  // be untrue here.
  assert.equal(boardPhase({ board: null, settled: true, connected: true, council: true }), 'waiting')
  // …but not forever: without a connection it has nowhere to arrive from.
  assert.equal(boardPhase({ board: null, settled: true, connected: false, council: true }), 'missing')
})

test('the empty state no longer rests on a single board === null', () => {
  assert.match(WINDOW, /\{:else if board === null \|\| phase !== 'ready'\}/)
  assert.match(WINDOW, /\{#if phase === 'waiting'\}[\s\S]{0,200}<Splash size="pane"/, 'loading is the same splash as the room\'s')
  assert.doesNotMatch(WINDOW, /board === null \|\| \(board\.lock !== 'council'/, 'the old fork is back')
  // A watchdog: the sign never came — we stop waiting and show what there is.
  assert.ok(WELCOME_WAIT_MS >= 5_000 && WELCOME_WAIT_MS <= 8_000)
  assert.match(WINDOW, /setTimeout\(\(\) => \(waited = true\), WELCOME_WAIT_MS\)/)
  assert.match(WINDOW, /settled: session\.council\.welcomed \|\| waited/)
  // And the app splash holds while the console does not know what to draw.
  const screen = code(read('web/src/screens/SessionScreen.svelte'))
  assert.match(screen, /if \(councilPult && !councilKnown\) return\s*\n\s*firstScreenReady\(\)/)
  assert.match(screen, /session\.council\.welcomed/)
  // The sign is raised by a server frame and does NOT go out on a
  // disconnect: otherwise the flash would come back in the middle of a class,
  // in a console that lost the network for a second.
  const client = read('web/src/lib/council.svelte.ts')
  assert.match(client, /if \(message\.t === 'council:ready'\) \{\s*\n\s*this\.welcomed = true/)
  assert.doesNotMatch(client, /this\.welcomed = false/)
  assert.match(read('server/src/control.ts'), /send\(ws, \{ t: 'council:ready' \}\)/)
})
