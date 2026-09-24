/**
 * The council sheet through a student's eyes: one cell, five states, one key
 * for submitting.
 *
 * Every check here is about a promise the markup did not keep.
 *
 * The first is "one cell". Above one's own sheet stood the shared text,
 * read-only ("Shared cell · visible to the whole group"), and under the sheet
 * the output of the SHARED cell: a person writing their own answer had two
 * code blocks and two outputs on screen, and which of them was theirs had to
 * be decided by the caption.
 *
 * The second is the mark. `CouncilMine.correct` reached the author from the
 * council's first day and was drawn nowhere: the teacher set a tick, it
 * arrived and died inside the object. "Correct" and "there is an error" are
 * what an attempt gets submitted for.
 *
 * The third is the keys. ⇧↵ on the sheet SUBMITTED: students had no run back
 * then, and fingers used to "run and move on" had to land somewhere. Running
 * appeared (the `studentRun` control), and ⇧↵ stayed a submit — that is,
 * every second run went to the teacher for good. Now exactly one combination
 * submits, and it is deliberately awkward.
 *
 * The fourth is the stub. Once the teacher's scaffold was erased there was
 * nowhere to get it back from: it had to be dictated out loud.
 *
 * The markup is read from the component, as in `panels-craft.test.mts` and
 * `council-stack-craft.test.mts`: tests about a Svelte template here read
 * the template rather than render it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../shared/i18n.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const CELL = code(read('web/src/components/notebook/CellView.svelte'))
const EDITOR = code(read('web/src/components/notebook/CodeEditor.svelte'))

/** One's own sheet — from `{#if ownSheet && sheet}` to the editor's shared branch. */
const SHEET = CELL.slice(CELL.indexOf('{#if ownSheet && sheet}'), CELL.indexOf('{:else if showEditor}'))

/* --------------------------------------------------------------- one cell */

test('there is no second cell above the sheet: the shared text is not drawn for the student', () => {
  assert.notEqual(SHEET, '', 'the sheet exists at all')
  assert.doesNotMatch(SHEET, /<Code\b/, 'the shared code above the sheet remained')
  assert.doesNotMatch(CELL, /import Code from/, 'the component is imported for nothing')
  // The keys "Shared cell" and "visible to the whole group" lived only in
  // this block: they must not just fall out of use — they are gone from the
  // catalogue.
  const catalog = read('shared/locales/room.ts')
  assert.doesNotMatch(catalog, /"room\.ui\.347"/)
  assert.doesNotMatch(catalog, /"room\.ui\.348"/)
})

test('the shared cell\'s output is not drawn for a student in a council', () => {
  assert.match(
    CELL,
    /\{#if isCode && !ownSheet && \(outputs\.current\.length > 0 \|\| outputFloor > 0\)\}/,
    'the shared output remained under one\'s own sheet',
  )
  // While one's own is drawn, and exactly once: from `attemptRun`, not from
  // `mine.run` directly, otherwise output wiped by a restore would come back
  // by itself.
  assert.equal(SHEET.match(/<CellOutputs\b/g)?.length, 1, 'the attempt output is drawn more than once')
  assert.match(SHEET, /outputs=\{attemptRun\.outputs\}/)
})

/* ------------------------------------------------------------------- keys */

test('⇧↵ on the sheet runs, only ⌘⇧↵ submits', () => {
  // The editor got a separate combination — and only it calls onsubmit.
  assert.match(EDITOR, /\{ key: 'Mod-Shift-Enter', preventDefault: true, run: \(\) => fire\(handlers\.onsubmit\) \}/)
  assert.match(EDITOR, /\{ key: 'Shift-Enter', preventDefault: true, run: \(\) => fire\(handlers\.onrunstep\) \}/)
  assert.match(EDITOR, /\{ key: 'Mod-Enter', preventDefault: true, run: \(\) => fire\(handlers\.onrun\) \}/)
  // On the sheet ⇧↵ and ⌘↵ lead to one run function, and submitting to its
  // own.
  assert.match(SHEET, /onrunstep=\{sheetRunKey\}/)
  assert.match(SHEET, /onrun=\{sheetRunKey\}/)
  assert.match(SHEET, /onsubmit=\{submitFromKey\}/)
  // Not a single run key is wired to submitting — the very trouble
  // everything started with.
  assert.doesNotMatch(SHEET, /onrunstep=\{[^}]*submitAttempt/)
  assert.doesNotMatch(SHEET, /onrun=\{[^}]*submitAttempt/)
  // Alt+Enter on the sheet does nothing: no handler is passed at all, and
  // `preventDefault` in the binding keeps it from inserting a line break.
  assert.doesNotMatch(SHEET, /onrunandadd=/)
  // Submitting from the keyboard is visible: the button blinks, because
  // "submitted" arrives as the server's echo and not instantly.
  const submit = CELL.slice(CELL.indexOf('function submitFromKey'), CELL.indexOf('function submitFromKey') + 500)
  assert.match(submit, /submitFlash = true/)
})

test('run and request are one button and one wait', () => {
  const footer = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))
  // One button with one word for both controls — and the same function as
  // the key.
  assert.match(footer, /onclick=\{sheetRunKey\}/, 'the button and the key diverged')
  assert.equal(footer.match(/tr\('room\.ui\.73'\)/g)?.length, 1, 'there is more than one run button in the footer')
  // The student is no longer told about the "request": not by a button, not
  // by a clock, not by the word "sending".
  for (const key of ['363', '362', '1237']) {
    assert.doesNotMatch(footer, new RegExp(`room\\.ui\\.${key}`), `room.ui.${key} remained in the footer`)
    assert.doesNotMatch(read('shared/locales/room.ts'), new RegExp(`"room\\.ui\\.${key}"`), `key ${key} remained in the catalogue`)
  }
  // The wait is one for both controls, and the number in it is optional.
  assert.match(footer, /\{#if runWaiting\}/)
  assert.match(footer, /mine\?\.queue != null\s*\?\s*tr\('room\.ui\.1236', \{ p0: mine\.queue \}\)\s*:\s*tr\('room\.ui\.1260'\)/)
  assert.equal(translate('ru', 'room.ui.1260'), 'В очереди')
  // Cancelling is drawn only where it has something to take off: the
  // protocol has no "remove from the kernel queue" frame,
  // `council:run:cancel` takes off a request.
  assert.match(CELL, /const mayCancelRun = \$derived\(requestPending && mayRequestRun\)/)
  assert.match(footer, /\{#if mayCancelRun\}/)
  assert.match(read('shared/protocol.ts'), /t: 'council:run:cancel'; cellId: string; requestId: string/)
  // The refusal speaks in words and does not mention the request; a diverged
  // text stays silent.
  assert.match(translate('ru', 'room.ui.364'), /^Преподаватель не запустил/)
  assert.doesNotMatch(footer, /room\.ui\.365/, 'the diverged text is talked about again')
})

test('a draft has no chip, and the hint under the buttons is only about submitting', () => {
  const footer = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))
  assert.match(footer, /\{#if sheetState !== 'draft'\}/, 'the chip is drawn for a draft too')
  const catalog = read('shared/locales/room.ts')
  assert.doesNotMatch(catalog, /"room\.ui\.1223"/, '"Draft · saving" remained in the catalogue')
  assert.doesNotMatch(catalog, /"room\.ui\.1253"/, 'the short "Draft" remained in the catalogue')
  assert.equal(translate('ru', 'room.ui.357'), '⌘⇧↵ — сдать')
  // The class count stays meanwhile — it is in the caption under the chip,
  // not in the footer.
  const head = SHEET.slice(SHEET.indexOf("tr('room.ui.34')"), SHEET.indexOf('<CodeEditor'))
  assert.match(head, /countLine\(count\)/)
  assert.match(head, /tr\('room\.ui\.1222'\)/)
})

test('with the control off ⇧↵ does not submit but says so in words and fades', () => {
  const key = CELL.slice(CELL.indexOf('function sheetRunKey'), CELL.indexOf('$effect(() => () => window.clearTimeout(runHintTimer))'))
  assert.match(key, /requestAttemptRun\(\)/, 'on request — it asks')
  assert.match(key, /runAttempt\(\)/, 'with the control on — it runs')
  assert.doesNotMatch(key, /submitAttempt/, 'the run key submits')
  assert.match(key, /runHint = true/, 'it is silent where it does nothing')
  assert.match(CELL, /const RUN_HINT_MS = 2000/)
  assert.match(SHEET, /\{#if runHint\}/)
  assert.match(SHEET, /tr\('room\.ui\.1231'\)/)
  assert.match(translate('ru', 'room.ui.1231'), /запускает преподаватель/)
  // The hint stands by the footer, not in a toast: a toast drifts into the
  // corner of the screen.
  assert.doesNotMatch(CELL.slice(CELL.indexOf('function sheetRunKey'), CELL.indexOf('function sheetRunKey') + 600), /showError/)
})

/* ------------------------------------------------------------------ mark */

test('"correct" and "there is an error" reach the author — by colour, word and button', () => {
  const at = CELL.indexOf('const sheetState = $derived(')
  const state = CELL.slice(at, CELL.indexOf('const reviewedAt', at))
  assert.match(state, /mine\?\.correct === true/)
  assert.match(state, /mine\?\.correct === false/)
  // Three state tables — the chip, the stripe and the words — must know the
  // same five names: if they diverged, a state without a colour (or without
  // a word) would look like "nothing happened".
  for (const table of ['SHEET_CHIP', 'SHEET_RULE']) {
    const block = CELL.slice(CELL.indexOf(`const ${table} = {`), CELL.indexOf('} as const', CELL.indexOf(`const ${table} = {`)))
    for (const name of ['edited', 'correct', 'wrong', 'submitted', 'draft']) {
      assert.match(block, new RegExp(`\\b${name}:`), `${table} does not know ${name}`)
    }
  }
  // A draft stands in both tables as an empty string: it has neither a
  // stripe colour nor a chip of its own, and both tables must SAY so rather
  // than stay silent — otherwise `SHEET_CHIP[sheetState]` will one day
  // return undefined into a class.
  for (const table of ['SHEET_CHIP', 'SHEET_RULE']) {
    const block = CELL.slice(CELL.indexOf(`const ${table} = {`), CELL.indexOf('} as const', CELL.indexOf(`const ${table} = {`)))
    assert.match(block, /draft: '',/, `${table} gives the draft its own styling`)
  }
  assert.match(CELL, /correct: 'border-positive'/)
  assert.match(CELL, /wrong: 'border-danger'/)
  assert.match(SHEET, /tr\('room\.ui\.1225'\)/)
  assert.match(SHEET, /tr\('room\.ui\.1226'\)/)
  assert.match(translate('ru', 'room.ui.1225'), /Верно/)
  assert.match(translate('ru', 'room.ui.1226'), /Есть ошибка/)
  // After "there is an error" the secondary button is named by what it does
  // — it leads to the way out instead of repeating the trouble.
  assert.match(SHEET, /sheetState === 'wrong'\s*\?\s*tr\('room\.ui\.1248'\)/)
  assert.match(translate('ru', 'room.ui.1248'), /Исправить/)
})

test('editing after a mark was cancelled keeps it as a memory, not as a state', () => {
  const at = CELL.indexOf('const sheetState = $derived(')
  const state = CELL.slice(at, CELL.indexOf('const reviewedAt', at))
  assert.match(state, /submittedAt === null && mine\?\.correct != null/, 'a removed mark does not return to typing')
  assert.match(CELL, /edited: ''/, 'the edit stripe takes the colour of a mark that is no longer there')
  assert.match(SHEET, /tr\('room\.ui\.1247'\)/)
  assert.match(translate('ru', 'room.ui.1247'), /было:/)
})

test('a submitted attempt has no run buttons, and its text is not dimmed', () => {
  const footer = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))
  assert.match(footer, /\{#if submittedAt === null\}[\s\S]*?tr\('room\.ui\.73'\)/, 'the run is not hidden under the submission')
  assert.doesNotMatch(SHEET, /opacity-60/, 'the submitted code faded')
})

/* ---------------------------------------------------------------- footer */

test('the footer holds as one strip: the count in the caption, the actions in one group', () => {
  // The class count is information about the room, and it stands in the
  // header next to the caption, not in the footer: there it fought the
  // buttons for space, and on a narrow column they were the ones pushed down.
  const head = SHEET.slice(SHEET.indexOf("tr('room.ui.34')"), SHEET.indexOf('<CodeEditor'))
  assert.match(head, /countLine\(count\)/, 'the count did not move to the header')
  const footer = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))
  assert.doesNotMatch(footer, /countLine\(count\)/, 'a copy of the count remained in the footer')
  // The chip and the buttons are in one flex that wraps as a whole and to
  // the right.
  assert.match(SHEET, /<span class="ml-auto flex flex-wrap items-center justify-end/)
  // And the chip shrinks before anything wraps.
  assert.match(SHEET, /tr\(tightFooter \? 'room\.ui\.1252' : 'room\.ui\.1224'/)
  assert.match(CELL, /const tightFooter = \$derived\(footerWidth > 0 && footerWidth < 460\)/)
  assert.match(CELL, /bind:clientWidth=\{footerWidth\}/)
  assert.match(translate('ru', 'room.ui.1252'), /^Сдано \{p0\}$/)
})

test('someone else\'s caret in the shared cell is not attributed to one\'s own sheet', () => {
  const at = CELL.indexOf('const editingHere = $derived.by(')
  const block = CELL.slice(at, at + 400)
  assert.match(block, /if \(ownSheet\) return null/, 'the presence line hangs under someone else\'s sheet')
})

/* ---------------------------------- the kernel and the oracle in the sheet */

test('one\'s own sheet asks the kernel — and names itself so that the permission is found', () => {
  // Without the cell name the server cannot tell a council sheet from a
  // plain cell (control.ts · mayComplete) and in a lecture room refuses
  // silently: names came from the words of the cell itself, but the columns
  // of the real `df` did not.
  assert.match(SHEET, /complete=\{\(code, cursor\) => session\.complete\(code, cursor, id\)\}/)
  assert.match(SHEET, /inspect=\{\(code, cursor\) => session\.inspect\(code, cursor, id\)\}/)
  // And a plain cell names itself the same way: the rule for it has not
  // changed, but both ask in the same way.
  assert.equal(CELL.match(/session\.complete\(code, cursor, id\)/g)?.length, 2)
  assert.match(
    read('web/src/lib/session.svelte.ts'),
    /complete\(code: string, cursor: number, cellId\?: string\)/,
  )
  assert.match(read('shared/protocol.ts'), /t: 'complete'; id: number; code: string; cursor: number; cellId\?: string/)
})

test('the oracle hint — on a failed run, with a quiet button and by its own path', () => {
  assert.match(CELL, /const mayHint = \$derived\(/)
  assert.match(CELL, /mine\?\.run\?\.state === 'error'/, 'the hint is not given on a failed run')
  assert.match(SHEET, /onclick=\{\(\) => session\.council\.askHint\(id\)\}/)
  assert.match(SHEET, /tr\('room\.ui\.1262'\)/)
  assert.match(SHEET, /tr\('room\.ui\.1263'\)/)
  assert.equal(translate('ru', 'room.ui.1262'), 'Подсказка оракула')
  assert.equal(translate('ru', 'room.ui.1263'), 'Оракул думает…')
  // While it thinks, the button is dark: a second press is a second question
  // from the limit.
  assert.match(SHEET, /disabled=\{hint\?\.asking \|\| !mayHint\}/)
  // The refusal is visible in place, not only as a toast in the corner.
  assert.match(SHEET, /\{#if hint\?\.error\}/)
  // Its own path, not the shared feed: `/ai/ask` writes into the thread the
  // class reads.
  const client = read('web/src/lib/council.svelte.ts')
  assert.match(client, /this\.#send\(\{ t: 'council:hint', cellId \}\)/)
  // Not a single REST call in the sheet: the room's shared thread
  // (`/ai/ask`) is read by the whole class, while council texts are seen by
  // two.
  assert.doesNotMatch(SHEET, /\bapi\./, 'the sheet goes to the model through the shared feed')
  // An oracle letter is distinguishable from a teacher letter — both for the
  // author and in the stack.
  assert.match(SHEET, /letter\.to === 'oracle' \? tr\('room\.ui\.1261'\) : tr\('room\.ui\.1251'\)/)
  assert.match(read('web/src/components/council/pult/PultLetters.svelte'), /letter\.to === 'oracle'/)
})

test('"rewrite the cell" is closed where the cell is not edited, and copying is closed nowhere', () => {
  // The action asks the cell, not only the room rule: in a lecture and in
  // the shared cell of a council a participant has nowhere to apply a
  // suggestion with an "Apply" button, and they would already have spent a
  // question from the room's limit.
  assert.match(CELL, /const mayPatchHere = \$derived\(mayEdit && \(leads \|\| !inCouncil\)\)/)
  assert.match(CELL, /const mayRewrite = \$derived\(may\.ask && rewriteReady && mayPatchHere\)/)
  // The button is in place but dark — with the reason in a tooltip. It must
  // not disappear: the toolbar is the same for all cells, and a missing
  // button reads as a breakage.
  assert.doesNotMatch(CELL, /\{#if mayPatchHere\}\s*<button/, 'the oracle button was hidden instead of being dimmed')
  assert.match(CELL, /aria-label=\{tr\('room\.ui\.344'\)\}[\s\S]{0,80}?disabled=\{!mayRewrite\}/)
  // And "Accept" under the cell itself — by the same rule: it edits the
  // shared notebook.
  assert.match(CELL, /if \(!mayPatchHere\) \{\s*session\.showError\(patchWhy/)
  assert.equal(CELL.match(/disabled=\{!mayPatchHere\}/g)?.length, 2, 'the two "accept" buttons in the cell are not closed the same way')

  // "Apply" in the feed is the same rule, and it is about the cell too: the
  // suggestion may have arrived before the lock clicked.
  const turn = code(read('web/src/components/panels/ChatTurn.svelte'))
  assert.match(turn, /const mayApply = \$derived\(/)
  assert.match(turn, /cellLockHere !== 'council' \|\| session\.me\.role === 'host'/)
  assert.equal(turn.match(/disabled=\{!mayApply\}/g)?.length, 2, 'the two "apply" buttons are not closed the same way')
  assert.doesNotMatch(turn, /disabled=\{!may\.edit\}/, 'the room rule check remained instead of the cell one')

  // While copying is always there: the answer has no suggestion code at all
  // (`omit`), and where applying is not allowed there was nothing to take
  // away from the panel.
  assert.match(turn, /onclick=\{\(\) => void copyPatch\(\)\}/)
  assert.doesNotMatch(
    turn.slice(turn.indexOf('void copyPatch()') - 400, turn.indexOf('void copyPatch()')),
    /disabled=/,
    'the copy was closed together with the edit',
  )
  assert.equal(translate('ru', 'room.ui.1267'), 'Скопировать')

  // And in the cell toolbar: the copy slot copies the cell text to the
  // clipboard — for everyone, and it does not go dark. There is no more
  // copying of the cell into the notebook behind this icon: on 19 Sep 2026
  // students took it for "copy" and multiplied cells in the shared notebook.
  assert.match(CELL, /data-cell-copy\s+onclick=\{\(\) => void copySource\(\)\}/)
  assert.doesNotMatch(CELL, /duplicateCell/, 'copying the cell into the notebook is back in the toolbar')
  assert.doesNotMatch(
    CELL.slice(CELL.indexOf('void copySource()') - 300, CELL.indexOf('void copySource()')),
    /disabled=/,
    'copying to the clipboard was dimmed together with copying into the notebook',
  )
  assert.doesNotMatch(CELL, /disabled=\{!may\.add\}/, 'the copy slot still goes dark by the structure rule')
  assert.equal(translate('ru', 'room.ui.1900'), 'Скопировать текст ячейки')
})

/* ------------------------------------------------------------------ stub */

test('the teacher\'s stub can be brought back — with a confirmation in place', () => {
  assert.match(CELL, /function stubText\(\): string \{\s*return mine\?\.seed \?\? liveText\.current/)
  assert.match(CELL, /const mayRestore = \$derived\(mayAttempt && submittedAt === null && sheetText !== stubText\(\)\)/)
  assert.match(SHEET, /onclick=\{\(\) => \(restoreAsking = true\)\}/)
  assert.match(SHEET, /\{#if restoreAsking\}/)
  assert.match(SHEET, /onclick=\{restoreStub\}/)
  assert.match(SHEET, /tr\('room\.ui\.1233'\)/)
  assert.match(SHEET, /tr\('room\.ui\.1234'\)/)
  assert.match(SHEET, /tr\('room\.ui\.1235'\)/)
  assert.match(translate('ru', 'room.ui.1233'), /Вернуть исходную ячейку\?/)
  // No browser dialog here: the answer is visible in the very sheet that will
  // be replaced.
  const restore = CELL.slice(CELL.indexOf('function restoreStub'), CELL.indexOf('function resubmitAttempt'))
  assert.doesNotMatch(restore, /window\.confirm/)
  // The restore goes to the server and lands in undo: the origin is the
  // ordinary one, not SEED — otherwise the teacher would be left with erased
  // text.
  assert.match(restore, /current\.doc\.transact\(\(\) => replaceText\(current\.text, stubText\(\)\)\)/)
  assert.doesNotMatch(restore, /, SEED\)/)
  // And it takes away the output of the attempt whose text was replaced.
  assert.match(restore, /clearedRunAt = untrack\(\(\) => mine\?\.run\?\.startedAt \?\? null\)/)
})
