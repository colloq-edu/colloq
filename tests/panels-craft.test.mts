/**
 * Small things in the panels that can only be seen by eye — and so they break
 * quietly.
 *
 * Everything here is about markup and styles that have neither a pure function
 * nor a socket: the size of a finger target, the drawer typeface, the response
 * to a press, a second click on a file name. Nobody is going to check this in a
 * browser on every change, and it reverts with one line — which is exactly how
 * each of these findings turned up. It is read straight from the components: a
 * test with its own copy of the rule passes forever while the file drifts away.
 *
 * The same technique as in `terminal-palette.test.mts`, and for the same reason.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roomMessages } from '../shared/locales/room.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and styles without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const TERMINAL = 'web/src/components/panels/TerminalDrawer.svelte'
const HISTORY = 'web/src/components/panels/HistoryTab.svelte'
const FILES = 'web/src/components/panels/FilesPanel.svelte'
const AI = 'web/src/components/panels/AiPanel.svelte'
const BAN = 'web/src/components/panels/BanMenu.svelte'
const RULES = 'web/src/components/RoomRulesRows.svelte'
const ANSWER = 'web/src/components/panels/AnswerBody.svelte'
const TURN = 'web/src/components/panels/ChatTurn.svelte'
const CODE = 'web/src/components/ui/Code.svelte'
const CSS = 'web/src/index.css'
const RENDER = 'web/src/lib/render.svelte.ts'

/* ------------------------------------------------------------- typefaces */

test('the drawer is set in the product typefaces, not in ones it does not have', () => {
  const term = read(TERMINAL)
  // Nobody loads Inter: the @font-face rules in index.html are declared for
  // 'HSE Sans' and for the code font, and none for Inter. The drawer tabs fell
  // back to the system font next to the same label in the panel.
  assert.match(term, /--tm-sans:\s*'HSE Sans'/, "--tm-sans starts with 'HSE Sans'")

  const hist = code(read(HISTORY))
  /*
   * The history monospace font is shared with the transcript above it, otherwise
   * the times drift into the system SF Mono next to JetBrains Mono. The variable
   * name does not matter here and is not checked: it used to be the drawer's own
   * --tm-mono, next it will be the product's --font-mono (web/src/index.css),
   * where fallback families with metric overrides are added to the real font.
   * One thing matters — that there is one variable for both surfaces.
   */
  const mono = /font-family:\s*var\((--tm-mono|--font-mono)\)/.exec(hist)
  assert.ok(mono, 'the history monospace font is not declared through a variable')
  assert.match(
    code(term),
    new RegExp(`var\\(${mono![1]}\\)`),
    'the history monospace font is shared with the drawer',
  )
})

/* ------------------------------------------------------- font-size floor */

test('everything pressable in the drawer is set no smaller than 11px', () => {
  const term = code(read(TERMINAL))
  const hist = code(read(HISTORY))
  // 10px is for what is read once and never pressed (tailwind.config.js). The
  // tabs, the actions and the two history buttons are the drawer's most pressed controls.
  for (const [name, source, cls] of [
    ['tab', term, '.term-tab'],
    ['action', term, '.term-act'],
    ['"start a shell"', term, '.term-revive'],
    ['history buttons', hist, '.hist-go,\n  .hist-mini'],
  ] as const) {
    const block = source.slice(source.indexOf(cls))
    const size = /font-size:\s*([\d.]+)px/.exec(block)
    assert.ok(size, `${name}: font size not found`)
    assert.ok(Number(size[1]) >= 11, `${name} is set at ${size[1]}px, below the floor for pressable things`)
  }
})

/* ------------------------------------------------------------ targets */

test('the drawer grip and its actions are no thinner than a finger', () => {
  const term = code(read(TERMINAL))
  const grip = /\.term-grip\s*{[^}]*height:\s*(\d+)px/.exec(term)
  assert.ok(grip, 'the grip has a height')
  assert.ok(Number(grip[1]) >= 12, `the grip is ${grip[1]}px: it is dragged with a mouse and a pen`)

  const act = /\.term-act\s*{[^}]*min-height:\s*(\d+)px/.exec(term)
  assert.ok(act, '"Clear" and the cross got a minimum height')
  assert.ok(Number(act[1]) >= 24, 'the 24px floor is the same one the notebook cites')
})

test('"as on the instance" is a button, not a line of text as tall as its letters', () => {
  const rules = code(read(RULES))
  const clear = rules.slice(rules.indexOf('.rule-clear'))
  assert.ok(Number(clear.match(/min-height:\s*(\d+)px/)?.[1]) >= 24, 'the link-button has a target of at least 24px')
})

/* --------------------------------------------------------------- motion */

test('the room rules take speed and curve from the scale, not from literals', () => {
  const rules = code(read(RULES))
  assert.doesNotMatch(rules, /100ms ease-out/, 'no literal "100ms ease-out" is left')
  assert.match(rules, /var\(--speed-quick\)/, 'colour follows --speed-quick')
  assert.match(rules, /var\(--speed-press\) var\(--ease-out\)/, 'shape follows --speed-press')
})

test('the history does not break the press under reduced motion', () => {
  const hist = code(read(HISTORY))
  // The old block took transform out of the transition list and left
  // scale(0.97) itself: a snap there and back without a transition — a jerk instead of motion.
  assert.doesNotMatch(hist, /prefers-reduced-motion/, 'the history has no block of its own')
})

/* ---------------------------------------------- the oracle feed and width */

/**
 * One rule: the oracle feed does not scroll sideways.
 *
 * The oracle answers with code inside a sentence, and `data['GarageYrBlt'] =
 * data['GarageYrBlt'].fillna(data['GarageYrBlt'].median())` is one word to the
 * line breaker. With `overflow-wrap: normal` it stuck out 78 px past the column
 * edge, and the feed's scroll box offered to scroll those 78 px: the panel
 * swayed left and right at every touch of the trackpad. Exactly two things
 * scroll horizontally, and both within themselves — a code block and a wide table.
 */
test('prose wraps a long word instead of stretching the column', () => {
  const css = code(read(CSS))
  const prose = css.slice(css.indexOf('.prose-note {'), css.indexOf('.prose-answer {'))
  assert.match(prose, /overflow-wrap:\s*anywhere/, '.prose-note wraps "anywhere"')

  // `anywhere`, not `break-word`: only it takes part in the min-content width,
  // so the line stretches neither the column nor a flex ancestor.
  const inline = css.slice(css.indexOf('.prose-note code {'))
  assert.match(
    inline.slice(0, inline.indexOf('}')),
    /box-decoration-break:\s*clone/,
    'the inline code background does not fall apart at a wrap',
  )

  // The person's question is in the same place: a path or address line without a single space.
  assert.match(code(read(TURN)), /\[overflow-wrap:anywhere\]/, 'the question wraps "anywhere"')
})

test('only a code block and a table scroll sideways, each within itself', () => {
  const css = code(read(CSS))
  for (const rule of ['.prose-note pre {', '.prose-note .table-scroll {']) {
    const block = css.slice(css.indexOf(rule)).slice(0, 200)
    assert.match(block, /overflow-x-auto/, `${rule} scrolls by itself`)
    assert.match(block, /max-w-full/, `${rule} is no wider than the column`)
    // Otherwise a gesture that reached the end of the line carries on into the feed and the page.
    assert.match(block, /overscroll-x-contain/, `${rule} does not rock the feed`)
  }
  // markdown gives a table no wrapper: the renderer adds it, after the sanitizer.
  assert.match(code(read(RENDER)), /className = 'table-scroll'/, 'the table travels in a wrapper')

  const block = code(read(CODE))
  assert.match(
    block,
    /max-w-full overflow-x-auto overscroll-x-contain whitespace-pre/,
    'a code block in an answer scrolls by itself and is no wider than the turn',
  )
})

test('the oracle feed has no horizontal scrolling', () => {
  const ai = code(read(AI))
  // `overflow-y: auto` on its own means `overflow-x: auto` — so the spec says,
  // and that is exactly how the feed got sideways scrolling from any word sticking
  // out past the edge. A safety net on top of the cure, not instead of it.
  assert.match(
    ai,
    /bind:this=\{scroller\}[\s\S]{0,120}overflow-y-auto overflow-x-hidden/,
    'the feed scroll box is closed horizontally',
  )
  // And the same for the two boxes with their own vertical scrolling inside a turn.
  const turn = code(read(TURN))
  assert.doesNotMatch(
    turn,
    /overflow-y-auto(?! overflow-x-hidden)/,
    'every scrollable box in a turn has its horizontal closed',
  )

  // The answer wrapper is a flex column: without min-width: 0 its minimum equals
  // the content width, and one wide block would stretch the whole turn along with the feed.
  assert.match(code(read(ANSWER)), /cn\('flex min-w-0 flex-col gap-2\.5'/, 'the answer does not bulge')
})

/* ------------------------------------------------------------- gestures */

test('a second click on a file name does not open or download a second time', () => {
  const files = code(read(FILES))
  // The name carries both `pick` and rename on double click: two presses gave
  // two tickets and two a.click() calls — a gigabyte dataset in two copies.
  assert.match(files, /function pick\(entry: FileEntry, detail = 1\)/)
  assert.match(files, /if \(detail > 1\) return/)
  assert.match(files, /onclick=\{\(event\) => pick\(entry, event\.detail\)\}/)
})

test('while a ban goes to the server, the dialog closes neither on Escape nor on the backdrop', () => {
  const ban = code(read(BAN))
  // "Cancel" was disabled, yet Escape took the dialog away: the person saw that
  // they had changed their mind, and a moment later the participant was removed anyway.
  assert.match(ban, /function close\(\): void \{\s*if \(busy\) return/)
  // A successful ban closes the dialog bypassing the gesture exit: busy is cleared later.
  assert.match(ban, /dismiss\(\)/)
})

test('a retried question carries all the cells it asked about', () => {
  const ai = code(read(AI))
  const retry = ai.slice(ai.indexOf('function retry('), ai.indexOf('async function stop('))
  assert.match(retry, /cellIds: \[\.\.\.entry\.cellIds\]/, 'otherwise a retry loses all but the first')
})

test('a server refusal returns the question text to the field, not only in slow mode', () => {
  const ai = code(read(AI))
  const ask = ai.slice(ai.indexOf('async function ask('), ai.indexOf('let doing ='))
  const back = ask.indexOf('composing.question = body.message')
  const slow = ask.indexOf('err.retryAfter !== null')
  assert.ok(back > 0, 'the text is returned to the field')
  assert.ok(back < slow, 'and it comes BEFORE the reason is parsed: the reason does not affect it')
})

test('a failed fetch of the oracle status does not pass for a decision of the admin', () => {
  const ai = code(read(AI))
  const fetchBlock = ai.slice(ai.indexOf('api\n      .aiStatus()'), ai.indexOf('// The notebook asks'))
  assert.doesNotMatch(fetchBlock, /mode: 'off'/, "only the server says 'off'")
  assert.match(fetchBlock, /status = null/, 'on an error: "we do not know yet"')
  assert.match(fetchBlock, /statusFailed = true/)
})

test('the files target lives while its folder is open: collapse it and the target returns to the parent', () => {
  const files = code(read(FILES))
  const toggle = files.slice(files.indexOf('function toggle(path: string)'), files.indexOf('function pick('))
  // An open folder is the target, a closed one is not; closing a folder above the
  // target moves the target up to its parent. Otherwise there was no way to clear
  // "Files — into folder …" except by opening a file next to it.
  assert.match(toggle, /next\.add\(path\)\s*target = path/, 'expanding makes the folder the target')
  assert.match(
    toggle,
    /target\.startsWith\(`\$\{path\}\/`\)\) target = parentOf\(path\)/,
    'collapsing moves the target up to the parent',
  )
  const pick = files.slice(files.indexOf('function pick(entry: FileEntry'), files.indexOf('function startDraft('))
  assert.doesNotMatch(pick, /if \(entry\.dir\) \{\s*target = entry\.path/, 'only toggle sets a folder as the target')
  // The caption at the bottom names the place in both states, not the room rule:
  // "available to the whole group" next to "into folder data" read as a second mode.
  const catalog = roomMessages as Record<string, { ru: string; en: string }>
  for (const key of ['room.ui.607', 'room.ui.608']) {
    assert.ok(catalog[key].ru.startsWith('Файлы — '), key)
    assert.ok(catalog[key].en.startsWith('Files — '), key)
  }
  assert.match(files, /title=\{may\.files \? tr\('room\.extra\.461'\) : undefined\}/, 'the rule goes into a tooltip')
})
