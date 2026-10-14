/**
 * Line numbers in the room's code: how they are drawn.
 *
 * The rule itself (shared/rules.ts · lineNumbers) and its way to the room are
 * checked in `rules-line-numbers`. This file is about the drawing, and about
 * four promises that break without a sound:
 *
 *   1. The teacher turns the numbers on in the middle of a class, and the
 *      editor of whoever is typing at that second survives it: one
 *      compartment changes, the editor is not rebuilt. Rebuilding is what
 *      once took the focus away mid-sentence and sent the next letters to
 *      the notebook's command mode (see `readOnly` in CodeEditor.svelte).
 *   2. Before CodeMirror arrives, and every time a parked cell comes back on
 *      screen, the shim stands in for it, and with numbers on it draws the
 *      same column by the same width rule: otherwise the code would step
 *      sideways at every swap. Measured in Chromium against the real editor,
 *      at 1100 and 390 px, in both themes and with the lock gutter: the
 *      numbers, the code and every line land within 0.02 px of each other.
 *   3. Only code is numbered: a note is prose.
 *   4. The file editor keeps its own column untouched: the cells' dressing
 *      lives in a theme of its own that only a numbered cell carries.
 *
 * The same technique as in `caret-label` and `cell-indent`: the components
 * are read, not rendered, and comments are cut off first — an explanation is
 * not a promise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const EDITOR = code(read('web/src/components/notebook/CodeEditor.svelte'))
const THEME = code(read('web/src/components/notebook/cm-theme.ts'))
const CELL = code(read('web/src/components/notebook/CellView.svelte'))
const BLOCK = code(read('web/src/components/ui/Code.svelte'))
const SHOWN = code(read('web/src/components/council/CouncilOnScreen.svelte'))
const WORK = code(read('web/src/components/council/pult/PultWork.svelte'))
const PULT = code(read('web/src/components/council/pult/PultWindow.svelte'))
const CSS = code(read('web/src/index.css'))

/** The body between the first brace of `start` and the brace that closes it. */
function body(source: string, start: string): string {
  const at = source.indexOf(start)
  assert.ok(at >= 0, `${start} is not there`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
  }
  throw new Error(`${start} never closes`)
}

/** A theme record's declarations, in CSS spelling: `minWidth: 'x'` → min-width: x. */
function themeDeclarations(record: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [, name, quoted, templated] of record.matchAll(/(\w+):\s*(?:'([^']*)'|`([^`]*)`)/g)) {
    out.set(name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`), quoted ?? templated)
  }
  return out
}

/** A stylesheet rule's declarations. */
function cssDeclarations(rule: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [, name, value] of rule.matchAll(/([\w-]+):\s*([^;]+);/g)) out.set(name, value.trim())
  return out
}

/** The editor's own build effect: from where it takes the host to its cleanup. */
const BUILD = body(EDITOR, '$effect(() => {\n    const parent = host')
/** The cells' gutter dressing in cm-theme.ts. */
const NUMBERS_THEME = body(THEME, 'export const cellNumbers: Extension = EditorView.theme({')
const STYLE = EDITOR.slice(EDITOR.indexOf('<style>'))
/** The editor's markup: its host, the shim inside it, up to the styles. */
const MARKUP = EDITOR.slice(EDITOR.indexOf('bind:this={host}'), EDITOR.indexOf('<style>'))

/* -------------------------------------------- the switch, in place */

test('the gutter arrives with the lazily loaded CodeMirror, narrowed like everything else', () => {
  const view = EDITOR.slice(EDITOR.indexOf("import('@codemirror/view')"), EDITOR.indexOf("import('y-codemirror.next')"))
  // Named in the parameter AND in what comes back: only that shape lets Rollup
  // drop the rest of the package (see importCodeMirror).
  for (const name of ['lineNumbers', 'highlightActiveLineGutter']) {
    assert.equal((view.match(new RegExp(`\\b${name},`, 'g')) ?? []).length, 2, `${name} is not narrowed`)
  }
  assert.match(EDITOR, /import\('\.\/cm-theme'\)\.then\(\(\{ cellNumbers, colloqTheme \}\) => \(\{ cellNumbers, colloqTheme \}\)\)/)
})

test('the numbers live in a compartment of their own, built with the value of the moment', () => {
  assert.match(
    EDITOR,
    /function numberExtensions\(cm: CodeMirror, on: boolean\) \{\s*return on \? \[cm\.view\.lineNumbers\(\), cm\.view\.highlightActiveLineGutter\(\), cm\.theme\.cellNumbers\] : \[\]\s*\}/,
  )
  assert.match(EDITOR, /numbers\.of\(numberExtensions\(cm, numbersOn\)\)/)
  // The compartment stands above the shared theme: listed earlier, it wins.
  assert.ok(
    EDITOR.indexOf('numbers.of(numberExtensions(') < EDITOR.indexOf('cm.theme.colloqTheme,'),
    'the cells’ dressing is listed after the shared theme and loses to it',
  )
  assert.match(BUILD, /const numbers = new cm\.state\.Compartment\(\)/)
})

test('a change of the rule does not rebuild the editor: the build reads it untracked', () => {
  // Read exactly once in the build, and only inside `untrack`: a tracked read
  // would tear the editor down for everyone the moment the teacher flips it.
  assert.match(BUILD, /const numbersOn = untrack\(\(\) => numbered\)/)
  assert.equal((BUILD.match(/\bnumbered\b/g) ?? []).length, 1, 'the build reads the rule outside untrack')
  assert.doesNotMatch(BUILD, /\blineNumbers\b/, 'the build reads the raw prop')
  // The live editor gets the switch, and loses it with the editor.
  assert.match(BUILD, /numbersNow = numbersOn/)
  assert.match(BUILD, /setNumbers = \(on\) => built\.dispatch\(\{ effects: numbers\.reconfigure\(numberExtensions\(cm, on\)\) \}\)/)
  assert.match(BUILD, /return \(\) => \{[\s\S]*setNumbers = null/)
})

test('the switch reconfigures the live editor, and only on a real change', () => {
  assert.match(EDITOR, /let setNumbers = \$state\.raw<\(\(on: boolean\) => void\) \| null>\(null\)/)
  assert.match(
    EDITOR,
    /\$effect\(\(\) => \{\s*const apply = setNumbers\s*const on = numbered\s*if \(!apply \|\| on === numbersNow\) return\s*numbersNow = on\s*apply\(on\)\s*\}\)/,
  )
})

/* ----------------------------------------------------- code only */

test('a note never gets numbers, whatever the caller passes', () => {
  assert.match(EDITOR, /lineNumbers = false,\n\s*\}: Props = \$props\(\)/)
  assert.match(EDITOR, /const numbered = \$derived\(lineNumbers && language === 'python'\)/)
  // Everything downstream reads the derived value, never the raw prop: past
  // its declaration, its default and the derived value, the only
  // `lineNumbers` left in the component is CodeMirror's own function.
  const start = EDITOR.indexOf('<script lang="ts">')
  const script = EDITOR.slice(start, EDITOR.indexOf('</script>', start))
  const uses = [...script.matchAll(/(?<![.\w])lineNumbers\b/g)].map((found) => script.slice(found.index, found.index + 45))
  const allowed = [/^lineNumbers\?: boolean/, /^lineNumbers = false,/, /^lineNumbers && language === 'python'\)/]
  assert.deepEqual(
    uses.filter((use) => !allowed.some((rule) => rule.test(use))),
    [],
    'the raw prop is read past the derived value',
  )
  assert.equal(uses.length, 3)
  assert.match(MARKUP, /class="cm-shim cm-editor cm-content"/)
  assert.doesNotMatch(MARKUP, /\blineNumbers\b/, 'the markup reads the raw prop')
})

/* --------------------------------------------- the shim draws the same column */

test('the shim draws the column exactly when the editor will', () => {
  assert.match(MARKUP, /class:cm-shim-numbered=\{numbered\}/)
  assert.match(
    MARKUP,
    /\{#each shimLines as line, index\}\s*\{#if numbered\}\s*<span class="cm-shim-number" aria-hidden="true">\{index \+ 1\}<\/span>\s*\{\/if\}\s*<span class="cm-shim-line"/,
    'the shim numbers its lines differently, or out of line with them',
  )
  assert.match(body(STYLE, '.cm-shim-numbered {'), /grid-template-columns: auto minmax\(0, 1fr\);/)
})

test('one width rule on both sides of the swap: the same floor, padding and size', () => {
  const theirs = themeDeclarations(body(NUMBERS_THEME, "'.cm-lineNumbers .cm-gutterElement': {"))
  const ours = cssDeclarations(body(STYLE, '.cm-shim-number {'))
  assert.equal(theirs.get('min-width'), 'calc(2ch + 8px)', 'the floor is no longer two digits')
  for (const [name, value] of theirs) assert.equal(ours.get(name), value, `${name}: the shim says ${ours.get(name)}, CodeMirror ${value}`)
  // What CodeMirror's base theme gives its numbers, the shim has to say itself.
  assert.equal(ours.get('text-align'), 'right')
  assert.equal(ours.get('white-space'), 'nowrap')
  assert.equal(ours.get('box-sizing'), 'border-box')
  // 8 px after the digits and the line's own 4 px: the design's 12 before the code.
  assert.match(THEME, /'\.cm-line': \{\s*padding: '0 8px 0 4px',/)
  assert.match(body(STYLE, '.cm-shim-line {'), /padding: 0 8px 0 4px;/)
})

test('numbers and code share one line box, on both sides of the swap', () => {
  assert.match(THEME, /const LINE_HEIGHT = 1\.65\b/)
  assert.match(THEME, /'\.cm-scroller': \{\s*lineHeight: String\(LINE_HEIGHT\),/)
  // Fixed at the code's size and inherited as a length by the smaller numbers.
  assert.match(NUMBERS_THEME, /'\.cm-gutters': \{\s*lineHeight: `\$\{LINE_HEIGHT\}em`,/)
  assert.match(body(STYLE, '.cm-shim {'), /line-height: 1\.65em;/)
})

/* ------------------------------------------------------------ the look */

test('the numbers are faint, and the caret line’s darker, only in the cell being typed in', () => {
  // Faint comes from the shared gutter rule; the shim says the same.
  assert.match(THEME, /'\.cm-gutters': \{\s*color: 'rgb\(var\(--faint\)\)',/)
  assert.match(body(STYLE, '.cm-shim-number {'), /color: rgb\(var\(--faint\)\);/)
  const active = themeDeclarations(body(NUMBERS_THEME, "'&.cm-focused .cm-activeLineGutter': {"))
  assert.equal(active.get('color'), 'rgb(var(--muted))')
  assert.equal(active.get('font-weight'), '600')
  // Under the line's own wash, so the band runs from the plate's edge.
  assert.equal(active.get('background-color'), 'var(--edit-line) !important')
  assert.match(CSS, /\.cm-activeLine \{\s*background: var\(--edit-line\) !important;/)
  // And no column ground or divider for anyone: index.css keeps that.
  assert.match(CSS, /\.cm-gutters \{\s*background: transparent !important;\s*border: none !important;/)
})

test('the file editor never meets the cells’ dressing', () => {
  // The shared theme is what the file editor builds on, and it has no number
  // rules of its own: a gutter rule there would win over the file's.
  assert.match(THEME, /export const colloqTheme: Extension = \[theme, syntaxHighlighting\(highlight\)\]/)
  const shared = body(THEME, 'const theme = EditorView.theme({')
  assert.doesNotMatch(shared, /cm-lineNumbers|cm-activeLineGutter|cm-gutterElement/)
  for (const file of ['web/src/components/editor/editor-theme.ts', 'web/src/components/editor/FileEditor.svelte']) {
    assert.doesNotMatch(code(read(file)), /cellNumbers/, `${file} picked up the cells’ numbers`)
  }
})

/* ------------------------------------------------------- the cell passes it */

test('the cell numbers its code by the rules of its own notebook', () => {
  assert.match(CELL, /const numbered = \$derived\(isCode && may\.rules\.lineNumbers === 'on'\)/)
  // `may` is the notebook's reading of the rules (rulesForBook), so a
  // personal notebook shows the numbers exactly when the room does.
  assert.match(CELL, /permitsIn\(session\.session\.rules, session\.me\.role, session\.finished, \{\s*root: bookRoot,/)
})

test('every editor the cell draws for code gets the numbers', () => {
  const editors = [...CELL.matchAll(/<CodeEditor\b[\s\S]*?\/>/g)].map(([tag]) => tag)
  assert.equal(editors.length, 3, 'the shared editor, the council sheet and its draft')
  for (const tag of editors) assert.match(tag, /lineNumbers=\{numbered\}/, `an editor without the numbers:\n${tag.slice(0, 200)}`)
})

test('the attempt on screen is numbered like the cell under it, for the class and the teacher', () => {
  const banners = [...CELL.matchAll(/<CouncilOnScreen\b[\s\S]*?\/>/g)].map(([tag]) => tag)
  assert.equal(banners.length, 2)
  for (const tag of banners) assert.match(tag, /lineNumbers=\{numbered\}/)
  assert.match(SHOWN, /lineNumbers = false,\n\s*\}: Props = \$props\(\)/)
  assert.match(SHOWN, /<Code code=\{shown\.text\} \{lineNumbers\} \/>/)
})

test('the council console reads the attempt by the room’s numbers', () => {
  assert.match(WORK, /lineNumbers = false,\n\s*\}: Props = \$props\(\)/)
  // The column is sized by the whole attempt, not by the forty lines shown
  // before "show all": unfolding a hundred-line attempt does not move its code.
  assert.match(WORK, /<Code code=\{shownCode\} class="pult-solution-code" \{lineNumbers\} lineCount=\{lines\} \/>/)
  assert.match(WORK, /const lines = \$derived\(attempt \? attempt\.text\.split\('\\n'\)\.length : 0\)/)
  assert.match(PULT, /lineNumbers=\{session\.session\.rules\.lineNumbers === 'on'\}/)
})

/* ----------------------------------------------------- the static block */

test('a code block draws numbers only when asked', () => {
  assert.match(BLOCK, /lineNumbers = false, lineCount = 0 \}: Props = \$props\(\)/)
  // The column, its width and the numbers themselves all hang on the prop.
  assert.match(BLOCK, /style:--code-digits=\{lineNumbers \? digits : null\}/)
  assert.match(
    BLOCK,
    /\{#if lineNumbers\}<span class="code-number" aria-hidden="true" data-line=\{index \+ 1\}><\/span\s*>\{\/if\}<CodeLine tokens=\{line\} \/>/,
  )
  assert.equal((BLOCK.match(/code-number"/g) ?? []).length, 1, 'a number is drawn outside the condition')
  // The editor's width rule: two digits at least, otherwise the last number's,
  // and the last of the whole text when the block shows only its beginning.
  assert.match(BLOCK, /const digits = \$derived\(Math\.max\(2, String\(Math\.max\(lines\.length, lineCount\)\)\.length\)\)/)
  // Digits are generated text, so code copied from the block comes without them.
  assert.match(body(BLOCK, '.code-number::before {'), /content: attr\(data-line\);/)
  const column = cssDeclarations(body(BLOCK, '.code-number {'))
  assert.equal(column.get('width'), 'calc(var(--code-digits) * 1ch + 12px)')
  assert.equal(column.get('padding-right'), '12px')
  assert.equal(column.get('font-size'), '12px')
  assert.equal(column.get('color'), 'rgb(var(--faint))')
})

test('pages that carry no room rules draw code without numbers', () => {
  for (const file of [
    'web/src/components/reader/PublicNotebook.svelte',
    'web/src/components/panels/AnswerBody.svelte',
    'web/src/components/panels/ChatTurn.svelte',
  ]) {
    const source = code(read(file))
    for (const [tag] of source.matchAll(/<Code\b[^>]*\/>/g)) {
      assert.doesNotMatch(tag, /lineNumbers/, `${file}: ${tag}`)
    }
  }
})
