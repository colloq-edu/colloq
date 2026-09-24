/**
 * The council console — markup promises the types cannot show.
 *
 * Why the window was introduced: the notebook is mirrored to the projector,
 * and the private console under the cell showed the audience names, drafts,
 * errors and marks. There is NO console in the notebook any more AT ALL —
 * neither as a fallback nor with the window closed — and the first checks
 * here are about that: under the cell the teacher has one line of numbers and
 * a "Console ↗" button, the lock menu has three positions and nothing else,
 * and a cell that was made a council cell opens the window with the same
 * press.
 *
 * Next comes what breaks silently in a messenger: a row whose height changes
 * with its state (neighbours stop reading as columns), an empty slot that
 * collapses instead of holding its place, an action bar whose buttons move
 * under the finger, and a second fill in a window where a fill means "the
 * audience will see this".
 *
 * The markup is read from the components, as in panels-craft.test.mts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const PULT = 'web/src/components/council/pult'
const ROW = code(read(`${PULT}/PultRow.svelte`))
const REPLY = code(read(`${PULT}/PultReply.svelte`))
const LIST = code(read(`${PULT}/PultList.svelte`))
const WORK = code(read(`${PULT}/PultWork.svelte`))
const ACTIONS = code(read(`${PULT}/PultActions.svelte`))
const WINDOW = code(read(`${PULT}/PultWindow.svelte`))
const QUEUE = code(read(`${PULT}/PultQueueStrip.svelte`))
const STATUS = code(read(`${PULT}/PultStatusLine.svelte`))
const HEADER = code(read(`${PULT}/PultHeader.svelte`))
const RULES = code(read(`${PULT}/PultRules.svelte`))
const CELL = code(read('web/src/components/notebook/CellView.svelte'))

/* ---------------------------------- the leak to the projector is closed */

test('under the cell the teacher gets a line of numbers and a button, and nothing else', () => {
  const at = CELL.indexOf('data-council-host')
  assert.ok(at > 0, 'there is no council block under the cell at all')
  const block = CELL.slice(CELL.lastIndexOf('{#if leads', at), CELL.indexOf('{#if leads && showsOnScreen', at))
  // Exactly the numbers the audience already sees on the projector.
  assert.match(block, /countLine\(/, 'submitted N of M')
  assert.match(block, /room\.ui\.1056/, '"N still writing"')
  assert.match(block, /data-council-pult-button/, 'there is no door into the console')
  assert.match(block, /room\.ui\.1400/, '"Console"')
  assert.match(block, /room\.ui\.1401/, '"Console is open" — while the window is alive')
  assert.doesNotMatch(block, /attempt\.name|\.name\}/, 'not a single name')
})

test('not a single private console is left in the notebook — not even as a fallback', () => {
  for (const dead of ['CouncilStack', 'CouncilSummary', 'CouncilStrip', 'CouncilOracle', 'CouncilReplyDraft']) {
    assert.ok(
      !fs.existsSync(path.resolve(import.meta.dirname, '..', `web/src/components/council/${dead}.svelte`)),
      `${dead} is back: a second place with names is exactly the leak`,
    )
    assert.doesNotMatch(CELL, new RegExp(dead), `${dead} is mounted under the cell again`)
  }
  // Nor any wiring to it: show, run, mark, reply — all of that is the
  // console.
  assert.doesNotMatch(CELL, /session\.council\.(show|mark|reply)\(/, 'the cell runs the council again')
  assert.doesNotMatch(CELL, /council\.view/, 'the "stack/summary" switch outlived the stack')
})

test('"open" is decided by the heartbeat, not by a reference to the window', () => {
  // A notebook reload loses the reference to the window — while the window
  // itself stays alive.
  assert.match(CELL, /watchPult\(session\.session\.id/)
  assert.match(CELL, /beatsAlive\(pultBeat, pultNow\)/)
  assert.match(CELL, /pultBeat\?\.cellId === id/, 'another cell\'s heartbeat does not touch this one')
  assert.match(CELL, /setInterval\(\(\) => \(pultNow = Date\.now\(\)\), 1000\)/, 'its own fading')
})

test('the "on screen" badge under the cell stays: it is not private', () => {
  assert.match(CELL, /<CouncilOnScreen/)
})

test('the lock menu has three positions and nothing else', () => {
  const menu = CELL.slice(CELL.indexOf('data-lock-menu'), CELL.indexOf('{:else}', CELL.indexOf('data-lock-menu')))
  assert.match(menu, /\{#each LOCKS as item/, 'the positions are drawn by iteration')
  assert.doesNotMatch(menu, /room\.ui\.335|<select/, 'the "students run" control is back in the menu')
  assert.doesNotMatch(menu, /room\.ui\.1258|checkbox/, 'the names control is back in the menu')
  assert.doesNotMatch(menu, /room\.ui\.1366|openCouncilPult/, '"Open console" is hidden in the menu again')
  // Three positions — the same three the server knows.
  assert.match(CELL, /\{ state: 'closed'/)
  assert.match(CELL, /\{ state: 'open'/)
  assert.match(CELL, /\{ state: 'council'/)
})

test('only the button under the cell opens the window — neither the lock nor a frame from the network', () => {
  /*
   * Switching a cell to council and opening the console are two different
   * decisions, and the second one is the teacher's: a lock that opens the
   * window by itself takes the choice away from them mid-sentence. And
   * technically there is no other way: `window.open` lives only inside a
   * user gesture, and opening the window later, on a frame from the server,
   * would not work at all — silently.
   */
  const press = CELL.slice(CELL.indexOf('function pressLock('), CELL.indexOf('function startHold('))
  assert.doesNotMatch(press, /reachPult\(|openPult\(/, 'a click on the lock opens the window')
  const setLock = CELL.slice(CELL.indexOf('function setLock('), CELL.indexOf('// The menu closes from outside'))
  assert.doesNotMatch(setLock, /reachPult\(|openPult\(/, '"Council" in the menu opens the window')
  const effects = [...CELL.matchAll(/\$effect\(\(\) => \{[\s\S]*?\n  \}\)/g)].map((m) => m[0])
  for (const effect of effects) {
    assert.doesNotMatch(effect, /reachPult\(|openPult\(/, 'the window opens by itself, outside a gesture')
  }
  // The only call is the handler of the button under the cell.
  assert.equal(CELL.match(/onclick=\{reachPult\}/g)?.length, 1)
})

test('the browser blocked the window — the button says so in words', () => {
  assert.match(CELL, /pultBlocked = opened === null/)
  assert.match(CELL, /room\.ui\.1402/, 'the reason for the refusal is not named')
  assert.match(CELL, /blockedTimer = window\.setTimeout/, 'the line about a single press does not fade')
})

/* -------------------------------------------------------- list row · 12 states */





test('a saved draft is not passed off as current typing', () => {
  assert.match(ROW, /attemptReview\(attempt\)/, 'the review and the draft are determined separately from the run')
  assert.doesNotMatch(ROW, /room\.ui\.1312/, '"now" must not be shown just because a draft exists')
  assert.match(ROW, /pultClock\(attempt\.submittedAt \?\? attempt\.updatedAt\)/)
  // "Writing · 14 lines" is about what has been typed, not about fingers on
  // the keys right now; how long a person has been silent is counted from
  // the edit time.
  assert.match(ROW, /draftLine\(attempt, now\)/)
})

test('presence is a dot on the avatar, not an "offline" label in every row', () => {
  /*
   * Ten identical labels in a list of twenty are noise through which one
   * looks for what differs. The dot takes a corner of a picture that is drawn
   * anyway, and tells THREE states apart, not two: unknown (no connection,
   * the roster has not arrived) means no dot at all.
   */
  assert.doesNotMatch(ROW, /room\.pult\.offline/, '"offline" came back as a word in the list row')
  assert.match(ROW, /class="pult-face pult-avatar" data-presence=\{presence\}/)
  assert.match(ROW, /<span class="pult-face-dot">/)
  const css = read(`${PULT}/pult.css`)
  assert.match(css, /\.pult-face\[data-presence="unknown"\] \.pult-face-dot \{ display: none/)
  assert.match(css, /\.pult-face\[data-presence="offline"\][\s\S]{0,120}border-color: rgb\(var\(--faint\)\)/)
  // And in the work header it is the same dot on the same avatar, with one
  // rule.
  assert.match(WORK, /class="pult-face work-avatar" data-presence=\{presence\}/)
})

test('submitted work differs from a draft in word and shape, not only in colour', () => {
  /*
   * A complaint from the class on 19 Sep 2026: "submitted work should be
   * marked better in the console, otherwise you can't see a damn thing".
   * Submitted and not yet graded is a badge filled with the accent, a draft is
   * an outlined and muted row. Such things are not told apart by colour
   * alone: the row is read out of the corner of the eye, in the middle of a
   * sentence to the class.
   */
  const pult = code(read('web/src/lib/council-pult.ts'))
  assert.match(pult, /room\.pult\.v3\.review\.waiting'\), tone: 'accent', shape: 'fill'/)
  assert.match(pult, /room\.pult\.v2\.review\.draft'\), tone: 'neutral', shape: 'outline'/)
  assert.match(ROW, /data-shape=\{review\.shape\}/, 'the badge shape does not reach the markup')
  assert.match(ROW, /data-draft=\{draft\?'yes':'no'\}/, 'the draft is not marked on the row')
  assert.match(ROW, /\[data-draft='yes'\][\s\S]{0,120}opacity:\.65/, 'the draft is not muted')
  const css = read(`${PULT}/pult.css`)
  assert.match(css, /\.pult-badge\[data-shape="fill"\][\s\S]{0,140}background: rgb\(var\(--accent\)\)/)
  assert.match(css, /\.pult-badge\[data-shape="outline"\][\s\S]{0,160}background: transparent/)
})

test('the run time is shown in the list row and in the opened work', () => {
  // "Show the run time in the council console" is a verbatim request from the
  // class. List row: "Run completed · 1.2 s · 17:24". The work: with seconds,
  // because there can be three runs in a minute.
  assert.match(ROW, /attemptRunLine\(attempt, now\)/, 'the run line is not built by the shared function')
  assert.match(WORK, /pultClock\(run\.startedAt, true\)/, 'the work shows no seconds for the moment of the run')
  assert.match(QUEUE, /room\.pult\.v3\.queueRunning/, 'the queue does not say when the running one was started')
  assert.match(QUEUE, /room\.pult\.v3\.queueSince/, 'the queue does not say since when they have been waiting')
})

test('a run request replaces the time with a button — without opening the work', () => {
  assert.match(ROW, /\{#if onlet\}/, 'a button instead of the time')
  assert.match(ROW, /onclick=\{onlet\}/, 'the request is available right from the list')
  assert.match(ROW, /room\.ui\.1296/, '"Let through"')
  assert.match(
    LIST,
    /row\.attempt\.runRequest\?\.status === 'pending' && !decisionsOff/,
    'the button is there exactly on the waiting one and exactly when deciding is allowed',
  )
})


test('the selected, the hovered and the focused row are distinguishable', () => {
  assert.match(ROW, /class:selected class:focused/)
  // The ring goes INSIDE and over the stripe: the row does not get wider, the
  // neighbours do not shift.
  assert.match(ROW, /outline-offset:-2px/)
  // And only from the keyboard: a mouse click draws no ring.
  assert.match(WINDOW, /keyboard = true/)
  assert.match(WINDOW, /keyboard = false/)
  assert.match(WINDOW, /keyboard=\{keyboard && focus !== 'reply'\}/)
})


test('the "new" filter does not melt under the cursor', () => {
  // The dot goes out on opening; if the chip read the live set, the list
  // would strike the row out exactly when someone started reading it, and
  // would empty itself.
  assert.match(WINDOW, /let newPool = \$state\.raw<ReadonlySet<string>>/)
  assert.match(WINDOW, /unread: filter === 'new' \? newPool : unread/)
})

test('names off — "Variant N" in muted and a grey disc, search does not work', () => {
  assert.match(ROW, /names \? attempt\.name : tr\('room\.ui\.1255'/)
  assert.match(ROW, /\{#if names\}<Avatar[\s\S]*?\{:else\}<span class="pult-anonymous"/)
  assert.match(WINDOW, /search: names \? search : ''/, 'there is nothing to search — search is switched off at the source')
})

/* ------------------------------------------------- action bar · four states */





test('the mark is accessibly labelled and removed by a second press', () => {
  assert.match(ACTIONS, /aria-pressed=\{correct === false\}/)
  assert.match(WINDOW, /current\.correct === correct \? null : correct/, 'the second press removes it')
  assert.match(ACTIONS, /aria-pressed=\{correct === true\}/)
})

test('a draft is not shown to the class, neither by button nor by key', () => {
  assert.match(ACTIONS, /disabled=\{disabled \|\| \(!onScreen && writing\)\}/)
  assert.match(WINDOW, /if \(!attempt \|\| attempt\.submittedAt === null\) return/)
})

/* ------------------------------------------------ the window as a whole */


test('the console has neither the notebook nor the panels — only itself', () => {
  const screen = code(read('web/src/screens/SessionScreen.svelte'))
  assert.match(screen, /\{:else if councilPult && councilCell\}/)
  const branch = screen.slice(screen.indexOf('{:else if councilPult'), screen.indexOf('{:else if pult}'))
  assert.match(branch, /<Pult\b[\s\S]*?cellId=\{councilCell\}/)
  // The cell is switched INSIDE the window, by address: one console per room.
  assert.match(branch, /onpick=\{\(next\) => onnavigate\?\.\(pultPath\(/)
  assert.doesNotMatch(branch, /<Notebook|<FilesPanel|<OraclePanel/)
})

test('to a non-teacher the console answers with a refusal, not an empty list', () => {
  assert.match(WINDOW, /\{#if !host\}/)
  assert.match(WINDOW, /room\.ui\.1357/)
  assert.match(WINDOW, /room\.ui\.1358/)
})

test('the queue is shown for viewing: there is nothing to reorder it with, and the hand is not invited to', () => {
  // The protocol has no "reorder" or "remove from queue" frame — drawing a
  // button with nothing to press means promising what does not exist.
  assert.match(QUEUE, /room\.pult\.v2\.queue\.queuedTitle/, 'the "Queued" section is there')
  assert.doesNotMatch(QUEUE, /draggable|room\.ui\.1348/, 'neither dragging nor "Remove"')
})

test('the limit is visible where it fires: as a bar under the running run', () => {
  /*
   * The only question about someone else's run in front of the class is
   * whether to wait or to interrupt, and it is answered by the bar, not by a
   * number in the settings. The bar also catches the case when waiting is
   * pointless: time is up, but the run goes on — the stop did not take.
   */
  assert.match(QUEUE, /limitMs !== null/, 'without a limit there is no bar')
  assert.match(QUEUE, /class="limit-fill" class:over=\{overLimit\}/)
  assert.match(QUEUE, /Math\.min\(100, \(elapsed \/ limitMs\) \* 100\)/, 'the fill spills out of the bar')
  assert.match(QUEUE, /room\.pult\.v2\.queue\.limitStuck[\s\S]{0,120}room\.pult\.v2\.queue\.limitStops/)
  assert.match(QUEUE, /\.limit-fill\.over \{ background: rgb\(var\(--danger\)\)/)
})

test('those stopped by the limit are a separate section, labelled by the same rule as their neighbours', () => {
  // They are neither in the queue nor among the waiting, and the question
  // "why does half the class have no output" is asked exactly here. The name
  // goes through who(): with names off the queue shows "Anonymous work", and
  // this section must show the same.
  assert.match(QUEUE, /timedOutAttempts\(attempts\)/)
  assert.match(QUEUE, /\{#if stopped\.length > 0\}/, 'an empty section is not drawn')
  assert.match(QUEUE, /class="stopped-limit">\{pultDuration\(timedOutLimit\(attempt\)!\)\}/)
  assert.match(QUEUE, /class="stopped-row" onclick=\{\(\) => onopen\(attempt\.participantId\)\}/)
  const rows = QUEUE.slice(QUEUE.indexOf('stopped-section'))
  assert.doesNotMatch(rows, /<(strong|span|code)[^>]*>\{attempt\.name\}/, 'a name that bypasses the "names on the projector" rule')
  assert.match(rows, /who\(attempt\)/)
  assert.match(QUEUE, /\.stopped-limit \{[^}]*color: rgb\(var\(--danger\)\)/)
})

test('a run stopped by the limit is not labelled with the generic "run error", neither in the row nor in the work', () => {
  assert.match(ROW, /execution\.icon \?\?/, 'the state sign is replaced by the generic one for its tone')
  assert.match(WORK, /stoppedAt !== null/)
  assert.match(WORK, /room\.pult\.v2\.rules\.workTimedOut/)
  // And next to it, the current limit with the same value button as in the
  // header.
  assert.match(WORK, /class="pult-value" onclick=\{\(event\) => onrules\('runLimit', event\.currentTarget\)\}/)
  assert.match(WORK, /room\.pult\.v2\.rules\.limitLink/)
})

test('all four cell rules live on one sheet, and none of them in the queue or the status line', () => {
  /*
   * A setting in the footer of a tab is a setting people go looking for.
   * "Who runs" stood as the queue's footer, "names on the projector" as a
   * switch at the bottom of the window, and both are changed in the same
   * second and for the same reason: what the class may do right now. Now
   * they are side by side, and every rule is labelled.
   */
  for (const key of ['whoTeacher', 'whoEveryone', 'whoRequest', 'limitTitle', 'pauseTitle', 'screenTitle']) {
    assert.match(RULES, new RegExp(`room\\.pult\\.v2\\.rules\\.${key}`), `the rule "${key}" is not on the sheet`)
  }
  assert.doesNotMatch(QUEUE, /policy|studentRun:/, 'the run control is back in the queue')
  assert.doesNotMatch(STATUS, /role="switch"|namesOnProjector/, 'the names control is back in the status line')
  // One place of sending for all four: the frame is the same as the cell
  // lock's.
  assert.match(WINDOW, /session\.council\.lock\(cellId, 'council', patch\)/)
  assert.match(WINDOW, /function setRule\(patch: Partial<CouncilSettings>\): void/)
})

test('rules apply on press, not with a "Save" button', () => {
  // "Done" closes the sheet and sends nothing: between "set 1 min" and "1 min
  // in effect" there must be no step at which what is written is untrue.
  assert.match(RULES, /onclick=\{segment\.pick\}/)
  assert.doesNotMatch(RULES, /room\.ui\.\d+.*[Сс]охранить|onsave/)
  assert.match(RULES, /data-pult-rules-done onclick=\{onclose\}/)
})

test('the rules read as a sentence in the header, and each value is a door into the sheet', () => {
  assert.match(HEADER, /rulesSentence|rules: RulePart\[\]/, 'the sentence is not built in the component')
  assert.match(HEADER, /class="pult-value"[\s\S]{0,400}?onrules\(part\.rule, event\.currentTarget\)/)
  assert.match(HEADER, /aria-expanded=\{openRule === part\.rule\}/, 'it is not visible what the sheet is open for')
  assert.doesNotMatch(HEADER, /room\.pult\.v2\.private/, 'the "personal console" line is back in the rules\' place')
  // Below 1200 px only the name is left of the sentence — and it is the door
  // too. The threshold moved from 860 together with the task title: in one
  // line with the heading, the title and "cell 2 of 4 · N more awaiting
  // review" the sentence stops fitting long before the window becomes a
  // phone. It must not be cut in the middle — half a rule, by which decisions
  // are made, is worse than its name.
  assert.match(HEADER, /@media\(max-width:1200px\)[\s\S]*?\.pult-rules-line \{ display:none/)
  assert.match(HEADER, /\.pult-rules-line \{[^}]*flex-shrink:0/, 'the sentence shrinks again and breaks in the middle')
})

test('the window header is one line, not three', () => {
  /*
   * The budget for permanent chrome in a 900×650 window: header ≤ 56 px. It
   * was ~90 for the header alone (title 26/32, caption, rules on a separate
   * line), and together with the tabs and the "on screen" bar — 290 px out of
   * 650.
   */
  assert.match(HEADER, /\.pult-header \{[^}]*display:flex[^}]*align-items:center/)
  const height = HEADER.match(/\.pult-header \{[^}]*min-height:(\d+)px/)?.[1]
  assert.ok(height && Number(height) <= 56, `the header promises ${height ?? '?'} px`)
  // The title is the window's caption, not a headline: 26/32 took the height
  // of two lines.
  const title = HEADER.match(/h1 \{[^}]*font-size:(\d+)px/)?.[1]
  assert.ok(title && Number(title) <= 20, `the title is ${title ?? '?'} px`)
  const tab = WINDOW.match(/\.pult-view-tab \{[^}]*min-height:(\d+)px/)?.[1]
  assert.ok(tab && Number(tab) <= 48, `the tabs promise ${tab ?? '?'} px`)
  const status = code(read(`${PULT}/PultStatusLine.svelte`))
  const line = status.match(/\.pult-status \{[^}]*min-height:(\d+)px/)?.[1]
  assert.ok(line && Number(line) <= 32, `the status line promises ${line ?? '?'} px`)
  // The "on screen" bar is one line, without wrapping.
  const screen = code(read(`${PULT}/PultOnScreen.svelte`))
  assert.match(screen, /\.projection-banner \{[^}]*flex-wrap: nowrap/)
  const banner = screen.match(/\.projection-banner \{[^}]*min-height: (\d+)px/)?.[1]
  assert.ok(banner && Number(banner) <= 40, `the bar promises ${banner ?? '?'} px`)
  // And when it is visible, the status line does not repeat the same name.
  assert.match(WINDOW, /banner=\{shown !== null\}/)
  assert.match(status, /\{#if !banner\}/)
})

test('the sheet takes over the keyboard entirely: the list is not walked behind it', () => {
  assert.match(WINDOW, /if \(rulesOpen\) \{[\s\S]{0,200}?event\.key === 'Escape'[\s\S]{0,120}?closeRules\(\)[\s\S]{0,40}?\}\s*\n\s*return/)
  assert.match(RULES, /event\.key !== 'Tab'/, 'Tab escapes past the sheet')
  assert.match(RULES, /aria-modal="true"/)
})

test('output that did not travel with the stack is requested by the console for the opened work', () => {
  assert.match(WINDOW, /attempt\?\.run\?\.outputsOmitted/)
  assert.match(WINDOW, /wantOutputs\(cellId, attempt\.participantId\)/)
})

test('long code is shown as its beginning plus a button, not as a scrolling box', () => {
  /*
   * The code slab had its own 240 px scroll INSIDE the panel's scroll: the
   * wheel over the code moved the code, a bit lower it moved the panel, and
   * hitting the right one was guesswork. Now it is the first forty lines and
   * a "show all code" button; the output comes right under the code in the
   * same feed, and it has no vertical scroll of its own — only a horizontal
   * one, for wide tables.
   */
  assert.match(WORK, /const CODE_LINES = 40/)
  assert.match(WORK, /slice\(0, CODE_LINES\)/)
  assert.match(WORK, /room\.pult\.v3\.codeAll/, 'it is not said how many lines are behind the button')
  assert.doesNotMatch(WORK, /\.work-code-scroll \{[^}]*max-height/, 'the scrolling box is back')
  assert.match(WORK, /\.work-code-scroll \{ overflow-x: auto; \}/)
  assert.doesNotMatch(WORK, /\.work-output \{[^}]*max-height/, 'the output has its own vertical scroll again')
  assert.match(WORK, /\.work-output \{ overflow-x: auto; \}/)
})

test('the work panel does not scroll as a whole: three zones and a dock pinned to the bottom', () => {
  /*
   * The owner's main complaint on 19 Sep 2026: "like, you have to scroll
   * somewhere for something, there is no fixed area for communication". In a
   * short window the whole right panel became one long page
   * (`@media(max-height:700px)` in the window and `min-height:650px` on the
   * work), and the letters, the reply field and the four actions lay below
   * the fold.
   */
  assert.doesNotMatch(WINDOW, /max-height:700px[\s\S]{0,80}overflow-y:auto/, 'the panel scrolls as a whole again')
  assert.doesNotMatch(WORK, /\.work \{[^}]*min-height: 650px/, 'the work is taller than the window again')
  assert.match(WORK, /\.work-content \{[^}]*flex: 1; min-height: 0; overflow-y: auto/, 'it is not the middle that scrolls')
  assert.match(WORK, /\.work-dock \{[^}]*flex-shrink: 0/, 'the dock is not pinned to the bottom')
  // Zone order: header, scroll, dock. The letters moved to the dock and are
  // not in the feed.
  const order = ['work-header', 'data-pult-work-scroll', 'data-pult-dock']
  let at = -1
  for (const mark of order) {
    const next = WORK.indexOf(mark)
    assert.ok(next > at, `${mark} is not in its place`)
    at = next
  }
  assert.ok(WORK.indexOf('<PultLetters') > WORK.indexOf('data-pult-dock'), 'the letters stayed in the scroll')
  assert.ok(WORK.indexOf('<PultReply') > WORK.indexOf('data-pult-dock'))
  assert.ok(WORK.indexOf('<PultActions') > WORK.indexOf('data-pult-dock'))
  // The letters feed has a scroll of its own, sits at the last letter, and is
  // empty without letters.
  const letters = code(read(`${PULT}/PultLetters.svelte`))
  assert.match(letters, /\{#if letters\.length > 0\}/, 'an empty feed takes up space')
  assert.match(letters, /box\.scrollTop = box\.scrollHeight/, 'the feed does not open at the last letter')
  assert.match(letters, /max-height: min\(30dvh, \d+px\); overflow-y: auto/)
})

test('removing from the class is not the biggest button in the work header', () => {
  // The most destructive action in the window stood as a red frame next to
  // the name and was more noticeable than anything else. Now it is the "⋯"
  // menu; the confirmation is as before.
  assert.match(WORK, /aria-haspopup="menu"/)
  assert.match(WORK, /role="menu"/)
  assert.match(WORK, /data-pult-remove/, 'there is no "remove" button in the console')
  assert.doesNotMatch(WORK, /pult-button--danger[^>]*data-pult-remove/, 'the red button is back in the header')
})

test('the output is labelled with who ran it and coloured by the outcome', () => {
  assert.match(WORK, /data-tone=\{execution\?\.tone\}/)
  assert.match(WORK, /run\.by === 'host' \? tr\('room\.ui\.61'\) : tr\('room\.pult\.v2\.ranByAuthor'\)/)
  // "run by you" is the author's line; in the console it is the teacher who
  // looks, and "you" would name the teacher as the one who ran it.
  assert.doesNotMatch(WORK, /room\.ui\.1061/)
  assert.match(WORK, /execution\.label/, 'an explicit run label')
})

/* ------------------- what moved from the notebook together with the console */

test('a letter is written to the author of the work, and it has no other recipient any more', () => {
  /*
   * Next to the field stood an "All N" button: the same letter went to the
   * whole group of identical answers, and a draft from the oracle came with
   * it. On 20 Sep 2026 grouping was removed from the console entirely, and
   * the group letter went with it — no replacement was invented.
   */
  assert.match(WINDOW, /\{ participantId: current\.participantId \}/)
  assert.doesNotMatch(WINDOW, /groupKey/, 'the letter\'s address still knows about groups')
  assert.doesNotMatch(WINDOW, /toGroup/)
  assert.doesNotMatch(REPLY, /toGroup|groupSize|hasDraft/, 'the group switch stayed in the field')
  assert.doesNotMatch(REPLY, /room\.ui\.1333/, '"All N" stayed as a button')
  // The line under the field says that the field holds the oracle's draft,
  // not one's own: it is sent in the teacher's name, and the finger must go
  // through the field.
  assert.match(WINDOW, /fromOracle: true|replyFromOracle/)
  assert.match(REPLY, /\{#if fromOracle\}/)
  assert.match(REPLY, /tr\('room\.ui\.30'\)/, 'it is not said whose text this is')
})

test('there is no grouping in the console anywhere: not in the list, not in the work, not in the field', () => {
  // "I'd get rid of this grouping by solution type, to hell with it" — 20 Sep
  // 2026. It was removed entirely, not hidden behind a setting, and this is
  // checked in all four places where it was visible.
  const pult = code(read('web/src/lib/council-pult.ts'))
  assert.doesNotMatch(pult, /neighbourInGroup/, 'arrows by group remain')
  assert.doesNotMatch(pult, /kind: 'collapsed'|kind: 'header'/, 'group rows remain in the build')
  assert.doesNotMatch(pult, /'groups'/, 'the "groups" filter chip remains')
  assert.doesNotMatch(LIST, /row\.groupKey|row\.faces|ontoggle/, 'the list still collapses')
  assert.doesNotMatch(read('web/src/components/council/pult/PultRow.svelte'), /same|inGroup/)
  assert.doesNotMatch(WORK, /groupIndex|room\.ui\.1323|workSame/)
  // Variant numbers with names off stay: this is a person's label, not a
  // group marker, and it must match what the audience sees.
  assert.match(pult, /export function variantNumbers/)
})

// Recipient changes, retained drafts and actual sends are verified in the browser audit.

test('removing from the class is possible from the work — the "⋯" menu and the shared ban menu', () => {
  assert.match(WORK, /data-pult-remove/, 'there is no "remove" button in the console')
  assert.match(WORK, /data-pult-remove[^>]*>[\s\S]*?tr\('room\.ui\.78'\)[\s\S]*?<\/button>/)
  assert.match(WINDOW, /import \{ askToBan, banTargetOf \} from '@\/lib\/bans'/)
  assert.match(WINDOW, /askToBan\(banTargetOf\(attempt, event\)\)/)
})

/**
 * The dangerous action moved from the queue row into the "⋯" menu — and this
 * is the owner's decision.
 *
 * "I see only the first few lines and can remove them from the class right
 * away, which is not quite fair to the participants" (20 Sep 2026). Before,
 * someone else's queue entry had exactly one button, and that one was
 * "Remove from class": taking someone off the class was EASIER than reading
 * the code. Now the whole row opens the work, and removing the person lies
 * under "⋯" next to its proportionate neighbour — "take the run out of the
 * queue".
 */
test('the queue row has no "remove" button: it is under "⋯" next to "take the run out of the queue"', () => {
  assert.match(QUEUE, /onremove: \(attempt: CouncilAttempt, event: MouseEvent\) => void/)
  assert.match(QUEUE, /ondrop: \(attempt: CouncilAttempt\) => void/)
  assert.equal(
    QUEUE.match(/data-pult-remove/g)?.length,
    undefined,
    'the dangerous button stands in the queue row again',
  )
  // The menu is the room-wide shared one, not a copy of its own: the
  // keyboard, the window edges and the bottom sheet under a finger are
  // already solved there once.
  assert.match(QUEUE, /import ContextMenu, \{ type ContextMenuItem \} from '@\/components\/ui\/ContextMenu\.svelte'/)
  assert.match(QUEUE, /label: tr\('room\.pult\.v3\.queue\.drop'\)/)
  assert.match(QUEUE, /label: tr\('room\.ui\.78'\),\s*icon: 'trash',\s*danger: true/)
  // The "⋯" button is on every kind of entry where "remove" used to be: on a
  // request and on a queued one. The running one has none: its row is a card
  // with "Interrupt", and a person is not removed from it.
  assert.equal(QUEUE.match(/data-pult-more/g)?.length, 2)
  assert.match(WINDOW, /onremove=\{remove\}/)
  assert.match(WINDOW, /ondrop=\{dropRun\}/)
})

/**
 * The queue row is a button that opens the work. That is what was asked for:
 * "in the queue tab I can't look at each specific run just by clicking on
 * it".
 */
test('an entry in the queue can be clicked to go to the work', () => {
  assert.match(QUEUE, /data-pult-queued-open/)
  assert.match(QUEUE, /onclick=\{\(\) => onopen\(attempt\.participantId\)\}/)
  assert.match(QUEUE, /aria-label=\{tr\('room\.pult\.v3\.queue\.openRow', \{ name: who\(attempt\) \}\)\}/)
  // And how many people are waiting — as a number: "queued 4" without motion
  // does not answer whether it is moving at all.
  assert.match(QUEUE, /room\.pult\.v3\.queue\.waitingFor/)
  // Taking a run out is something both the room state and the server can do.
  assert.match(read('web/src/lib/council.svelte.ts'), /dropRun\(cellId: string, participantId: string\)/)
  assert.match(read('server/src/control.ts'), /case 'council:run:drop': \{/)
})

/**
 * The queue belongs to the NOTEBOOK, not to the cell: the console must see
 * someone else's work that holds it, and be able to interrupt it.
 */
test('the console counts the notebook\'s queue and interrupts whatever holds it', () => {
  assert.match(QUEUE, /kernelIsBusy|queuedInBook/)
  assert.match(QUEUE, /room\.pult\.v3\.queue\.countsBook/)
  assert.match(QUEUE, /room\.pult\.v3\.queue\.busyCell/)
  assert.match(QUEUE, /room\.pult\.v3\.queue\.busyOther/)
  // The "Interrupt" button is outside the "own attempt" branch: it is needed
  // exactly when SOMEONE ELSE's work holds the queue.
  assert.match(QUEUE, /\{#if busy\}/)
  assert.match(QUEUE, /data-pult-restart/)
  assert.match(QUEUE, /room\.pult\.v3\.queue\.stuck/)
  const pult = code(read('web/src/lib/council-pult.ts'))
  assert.match(pult, /export function queuedInBook/)
  assert.match(pult, /export function kernelIsBusy/)
  assert.match(read('shared/protocol.ts'), /export interface CouncilKernel/)
})


/* --------------- promises that outlived the console in the notebook */

test('output on request: the frame is declared, the console asks, the stack remembers, the server answers', () => {
  assert.match(WINDOW, /attempt\?\.run\?\.outputsOmitted/, 'the only reason is a trimmed attempt')
  assert.match(WINDOW, /wantOutputs\(cellId, attempt\.participantId\)/)
  const protocol = read('shared/protocol.ts')
  assert.match(protocol, /t: 'council:attempt'; cellId: string; participantId: string/)
  assert.match(protocol, /outputsOmitted\?: boolean/)
  const state = read('web/src/lib/council.svelte.ts')
  // The key includes `startedAt`: an attempt gets run again, and the output
  // of the NEW run may again not fit the frame budget.
  assert.match(state, /wantOutputs\(cellId: string, participantId: string\)/)
  assert.match(state, /\$\{cellId\}:\$\{participantId\}:\$\{run\.startedAt\}/)
  assert.match(read('server/src/control.ts'), /case 'council:attempt': \{/, 'the server parses it')
})

test('the student sends a run request from the sheet, and it is decided in the console', () => {
  assert.match(CELL, /session\.council\.requestRun\(id\)/)
  assert.match(CELL, /session\.council\.cancelRunRequest\(id, request\.id\)/)
  // For the student, run and request are one button: they know nothing about
  // the request mechanics and should not.
  assert.match(CELL, /tr\('room\.ui\.73'\)/)
  assert.match(CELL, /tr\('room\.ui\.1260'\)/)
  assert.match(WINDOW, /session\.council\.approveRunRequest\(cellId, attempt\.participantId, request\.id\)/)
  assert.match(WINDOW, /session\.council\.declineRunRequest\(cellId, attempt\.participantId, request\.id\)/)
})

/* -------------------------------------------------------------- phone */

test('on a phone the console is two screens, not two columns', () => {
  /*
   * "The console on a phone is total crap, awkward, scrolling through the
   * list of all students is impossible" — 19 Sep 2026. Two columns in 390 px:
   * under the header, tabs, bar, counters, search and chips the list had half
   * a line left. Now the list is full-screen, a tap opens the work
   * full-screen, the system "back" returns to the list — and does not close
   * the console.
   */
  assert.match(WINDOW, /matchMedia\('\(max-width: 650px\)'\)/, 'the narrow-window threshold is not read from matchMedia')
  assert.match(WINDOW, /let phonePane = \$state<'list' \| 'work'>\('list'\)/)
  assert.match(WINDOW, /history\.pushState\(\{ \.\.\.\(history\.state \?\? \{\}\), pultPane: 'work' \}, '', location\.href\)/)
  assert.match(WINDOW, /addEventListener\('popstate'/, 'the "back" gesture is not listened to')
  assert.match(WINDOW, /history\.back\(\)/, '"‹ Work" goes around the history')
  // The screens are switched by markup, not by a rebuild: the console's
  // address is the cell.
  assert.match(WINDOW, /data-pult-pane=\{pane\}/)
  assert.match(WINDOW, /\[data-pult-pane='work'\] \.pult-sidebar \{ display:none; \}/)
  assert.match(WINDOW, /\[data-pult-pane='list'\] \.pult-work-pane \{ display:none; \}/)
  // The work bar: back, name, place in the feed, arrows to neighbouring work.
  assert.match(WINDOW, /room\.pult\.v3\.backToList/)
  assert.match(WINDOW, /room\.pult\.v3\.prevWork/)
  assert.match(WINDOW, /room\.pult\.v3\.nextWork/)
  assert.match(WINDOW, /\.pult-root \{ height:100dvh; \}/, 'the browser address bar will cut off the dock')
  // The list is scrolled with a finger, not a wheel.
  assert.match(LIST, /overscroll-behavior: contain; -webkit-overflow-scrolling: touch/)
  // The key hint takes no space on a phone: there are no keys there.
  const status = code(read(`${PULT}/PultStatusLine.svelte`))
  assert.match(status, /@media\(max-width:650px\) \{ \.pult-status \{ display:none; \} \}/)
})

test('the four actions on a phone are of equal width and a finger high', () => {
  assert.match(ACTIONS, /min-height: 44px/, 'the tap target is lower than a finger')
  assert.match(ACTIONS, /\.act-short \{ display: none; \}/, 'there are no short labels at all')
  for (const key of ['shortShow', 'shortClear', 'shortRun', 'shortCorrect', 'shortRevise']) {
    assert.match(ACTIONS, new RegExp(`room\\.pult\\.v3\\.${key}`), `short label "${key}" is missing`)
  }
})

/* -------------------------------------------------------------- theme */

test('the console wears the room\'s theme — light or dark, not the night one', () => {
  /*
   * The lecture console borrows the dark theme because of the physics of the
   * hall; this one is kept next to the notebook, as a second window on the
   * same monitor, and a dark slab beside a light room reads as a second
   * program. The window has no theme of its own: the colours are named by
   * meaning, and both sets answer to them.
   */
  const files = fs.readdirSync(path.resolve(import.meta.dirname, '..', PULT))
  assert.ok(files.length > 10, 'the console components were not found')
  for (const file of files) {
    const source = code(read(`${PULT}/${file}`))
    assert.doesNotMatch(source, /night-/, `${file}: a night token`)
    assert.doesNotMatch(source, /borrowTheme/, `${file}: the theme is borrowed by force`)
    assert.doesNotMatch(source, /\bdark:/, `${file}: a theme class is hard-wired in the markup`)
    assert.doesNotMatch(source, /classList\.toggle\('dark'/, `${file}: the window paints itself`)
  }
  assert.match(WINDOW, /bg-canvas text-ink/, 'the background and the text are not theme tokens')
})

test('the theme was switched in the notebook — the console beside it repainted instead of waiting for a reload', () => {
  // The choice is stored per browser, not per tab: the second window listens
  // to the same key. `storage` arrives only in OTHER documents — the writer
  // has already been repainted.
  const theme = code(read('web/src/lib/theme.svelte.ts'))
  assert.match(theme, /window\.addEventListener\('storage', onStorage\)/)
  assert.match(theme, /event\.key !== STORAGE_KEY/)
  assert.match(theme, /if \(!borrowed\) apply\(next\)/, 'a borrowed screen obeys someone else\'s choice')
})

test('the cells menu: one notebook — the name in the header, several — in every row', () => {
  const cells = code(read('web/src/components/council/pult/PultCells.svelte'))
  // Two ninth cells from different notebooks cannot be told apart by number
  // — so the notebook name must stand in the row as soon as there is more
  // than one notebook.
  assert.match(cells, /const manyBooks = \$derived\(books\.length > 1\)/)
  assert.match(cells, /\{#if manyBooks && cell\.book\}/)
  assert.match(cells, /class="pult-cells-book"/)
  // And while there is one notebook, the name stands once in the header and
  // does not add noise to the rows.
  assert.match(cells, /const book = \$derived\(books\.length === 1 \? books\[0\] : ''\)/)
})
