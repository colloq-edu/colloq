/**
 * Hover help: parsing the kernel's answer and what it turns into in the window.
 *
 * This broke at a live class on 19 Sep 2026 and broke silently: the tooltip
 * showed the first SIX lines of the answer, and for `df.head(n=5)` that was
 * enough, but for `sns.lmplot(...)` it was not. A person hovered to see the
 * plot's parameters and saw four out of forty-two: exactly the ones they had
 * already typed.
 *
 * Hence what is checked here. Not "is it pretty", but three things, each of
 * which breaks without a word:
 *   · parsing IPython's markup on real kernel answers (the samples below were
 *     taken from `colloq-kernel:base`, not made up);
 *   · memory: a second hover does not go to the kernel, but it does not
 *     remember yesterday's refusals either;
 *   · the window's own promises — one scroll, the full signature, a layer
 *     below the toolbar — which live in the markup and the theme and are
 *     checked by reading, as in panels-craft.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  forgetHelp,
  helpIsEmpty,
  helpKey,
  parseSignatureHelp,
  rememberHelp,
  rememberedHelp,
  safeLink,
  splitPackage,
  splitSignature,
  HELP_TTL_MS,
  SIGNATURE_ONE_LINE,
} from '../web/src/lib/signature-help.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/* -------------------------------------------------- real kernel answers */

/** A seaborn function: a signature of forty-odd lines — the very case. */
const LMPLOT = [
  'Signature:',
  'sns.lmplot(',
  '    data,',
  '    *,',
  '    x=None,',
  '    y=None,',
  '    hue=None,',
  '    height=5,',
  '    aspect=1,',
  "    markers='o',",
  '    facet_kws=None,',
  ')',
  'Docstring:',
  'Plot data and regression model fits across a FacetGrid.',
  '',
  'This function combines :func:`regplot` and :class:`FacetGrid`. It is',
  'intended as a convenient interface to fit regression models across',
  'conditional subsets of a dataset.',
  '',
  'Parameters',
  '----------',
  'data : DataFrame',
  '    Tidy ("long-form") dataframe where each column is a variable.',
  'File:      /usr/local/lib/python3.11/site-packages/seaborn/regression.py',
  'Type:      function',
].join('\n')

/** A DataFrame method: a one-line signature, documentation with examples. */
const HEAD = [
  "Signature: df.head(n: 'int' = 5) -> 'Self'",
  'Docstring:',
  'Return the first `n` rows.',
  '',
  'Examples',
  '--------',
  '>>> df.head()',
  '      animal',
  '0  alligator',
  '1        bee',
  'File:      /usr/local/lib/python3.11/site-packages/pandas/core/generic.py',
  'Type:      method',
].join('\n')

/** A class: no signature, but the signature of its `__init__` — and two docstrings. */
const DATAFRAME = [
  'Init signature:',
  'pd.DataFrame(',
  '    data=None,',
  "    index: 'Axes | None' = None,",
  ") -> 'None'",
  'Docstring:     ',
  'Two-dimensional, size-mutable, potentially heterogeneous tabular data.',
  'Init docstring:',
  'Construct a DataFrame from the given data.',
  'File:      /usr/local/lib/python3.11/site-packages/pandas/core/frame.py',
  'Type:      type',
].join('\n')

/** A module: neither a signature nor documentation — only what it is. */
const MODULE = [
  'Type:        module',
  "String form: <module 'seaborn' from '/usr/local/lib/python3.11/site-packages/seaborn/__init__.py'>",
  'File:        /usr/local/lib/python3.11/site-packages/seaborn/__init__.py',
  'Docstring:   <no docstring>',
].join('\n')

/** A value that is not called: here what matters most is what it looks like. */
const NUMBER = [
  'Type:        int',
  'String form: 42',
  'Docstring:  ',
  'int([x]) -> integer',
  '',
  'Convert a number or string to an integer.',
].join('\n')

/* ---------------------------------------------------------------- parsing */

test('a long signature arrives WHOLE, not as its first six lines', () => {
  const help = parseSignatureHelp(LMPLOT)
  assert.match(help.signature, /^sns\.lmplot\(/)
  // Exactly the parameter the old tooltip never lived to reach.
  assert.match(help.signature, /facet_kws=None,/)
  assert.match(help.signature, /\)$/)
  assert.equal(help.signature.split('\n').length, 11)
  assert.equal(help.type, 'function')
  assert.match(help.doc, /^Plot data and regression model fits/)
  // A path inside the container means nothing to a person in the room — it
  // is noise.
  assert.doesNotMatch(help.doc, /site-packages/)
  assert.doesNotMatch(help.signature, /site-packages/)
  assert.equal(help.raw, '')
})

test('a method: a one-line signature, and examples in the documentation keep their alignment', () => {
  const help = parseSignatureHelp(HEAD)
  assert.equal(help.signature, "df.head(n: 'int' = 5) -> 'Self'")
  assert.equal(help.type, 'method')
  // A pandas table is aligned with spaces: an eaten indent would turn it into
  // mush.
  assert.match(help.doc, /\n0 {2}alligator\n/)
  assert.doesNotMatch(help.doc, /generic\.py/)
})

test('a class shows the __init__ signature and both of its docstrings', () => {
  const help = parseSignatureHelp(DATAFRAME)
  assert.match(help.signature, /^pd\.DataFrame\(/)
  assert.match(help.signature, /-> 'None'$/)
  assert.match(help.doc, /Two-dimensional, size-mutable/)
  assert.match(help.doc, /Construct a DataFrame from the given data\./)
  assert.equal(help.type, 'type')
})

test('a module: "no docstring" is NOT documentation, and neither is the address in memory', () => {
  const help = parseSignatureHelp(MODULE)
  assert.equal(help.signature, '')
  assert.equal(help.doc, '')
  assert.equal(help.type, 'module')
  /*
   * `String form: <module 'seaborn' from '/usr/local/...'>` is an address
   * inside the container that tells a person in the room nothing; until 21 Sep
   * 2026 it was the entire answer about seaborn. Now a module is answered by
   * its PACKAGE (see below, the section on modules), and the string form is
   * not shown for modules.
   */
  assert.equal(help.form, '')
  /*
   * There is still something to show — the kind — and such an answer gets the
   * old window: a small "module" label and the documentation, if there is
   * any. The package card is drawn only where the package note made it
   * through.
   */
  assert.equal(helpIsEmpty(help), false)
  assert.match(EDITOR, /help\.module !== '' \|\| help\.pkg !== ''/)
})

test('a value shows what it looks like — a function never does', () => {
  const value = parseSignatureHelp(NUMBER)
  assert.equal(value.form, '42')
  assert.equal(value.type, 'int')
  assert.match(value.doc, /^int\(\[x\]\) -> integer/)
  // For a callable, `String form` is `<function lmplot at 0x7f…>`: an address
  // in someone else's process, that is, a line of noise across the window.
  const callable = parseSignatureHelp(
    ['Signature: f(x)', 'String form: <function f at 0x7f2c1a>', 'Type: function'].join('\n'),
  )
  assert.equal(callable.form, '')
})

test('garbage and a foreign kernel are shown as is, not lost', () => {
  const help = parseSignatureHelp('## help for `qplot`\nno idea what this is')
  assert.equal(help.signature, '')
  assert.equal(help.doc, '')
  assert.match(help.raw, /^## help for/)
  assert.equal(helpIsEmpty(help), false)
  // Emptiness stays emptiness: there is no reason to open a window for it.
  assert.equal(helpIsEmpty(parseSignatureHelp('')), true)
  assert.equal(helpIsEmpty(parseSignatureHelp('   \n  ')), true)
})

test('a header INSIDE the documentation does not cut it', () => {
  /*
   * The second `File:` is a line of an example, not a section of the answer.
   * While the last occurrence won, the documentation broke off in the middle
   * of the example, and half of the help simply vanished.
   */
  const help = parseSignatureHelp(
    [
      'Signature: open(name)',
      'Docstring:',
      'Open a file.',
      'File:      example',
      'and the sentence that goes after it',
      'File:      /usr/lib/python3.11/io.py',
      'Type:      function',
    ].join('\n'),
  )
  assert.match(help.doc, /Open a file\./)
  assert.match(help.doc, /File: {6}example/)
  assert.match(help.doc, /and the sentence that goes after it/)
  assert.equal(help.type, 'function')
  // And the real tail — the stuck-together notes at the very end — remained a
  // section.
  assert.doesNotMatch(help.doc, /usr\/lib/)
})

/* ------------------------------------------------------------- module */

/**
 * "module · <module pandas>" — what the teacher saw on 21 Sep 2026.
 *
 * pandas builds its module docstring by assigning `__doc__` at runtime,
 * seaborn has none at all — and about both IPython says `Type: module`, the
 * object's address in memory and `<no docstring>`. numpy has a docstring, and
 * its answer came out meaningful: a difference a person cannot explain.
 *
 * Now a module is asked about not as an object but as a PACKAGE: the name it
 * is installed under, the version, the summary and a link to the
 * documentation — all of this lies next to it on disk
 * (server/src/kernel/inspect-static.ts · `_package`) and is read without a
 * single import.
 */
const SEABORN = [
  'Module: seaborn',
  'Type: module',
  'Package: seaborn 0.13.2',
  'Summary: Statistical data visualization',
  'Docs: http://seaborn.pydata.org',
  'Docstring:   <no docstring>',
].join('\n')

const PYPLOT = [
  'Module: matplotlib.pyplot',
  'Type: module',
  'Package: matplotlib 3.11.1',
  'Summary: Python plotting package',
  'Docs: https://matplotlib.org',
  'Docstring:',
  '`matplotlib.pyplot` is a state-based interface to matplotlib.',
].join('\n')

test('a module yields its package, summary and link — and neither an address nor a path', () => {
  const help = parseSignatureHelp(SEABORN)
  assert.equal(help.module, 'seaborn')
  assert.equal(help.pkg, 'seaborn 0.13.2')
  assert.equal(help.summary, 'Statistical data visualization')
  assert.equal(help.docs, 'http://seaborn.pydata.org')
  assert.equal(help.type, 'module')
  // `<no docstring>` is not documentation but an admission that there is
  // none.
  assert.equal(help.doc, '')
  // A module's object address in memory is never shown.
  assert.equal(help.form, '')
  assert.equal(helpIsEmpty(help), false)
})

test('a submodule is named in full, and the package is the one that gets installed', () => {
  const help = parseSignatureHelp(PYPLOT)
  assert.equal(help.module, 'matplotlib.pyplot')
  assert.deepEqual(splitPackage(help.pkg), { name: 'matplotlib', version: '3.11.1' })
  assert.match(help.doc, /state-based interface/)
})

test('a module without metadata stays itself: name and documentation', () => {
  // The standard library and a file from the class folder: they have no
  // distribution.
  const help = parseSignatureHelp('Module: os\nType: module\nDocstring:\nOS routines.')
  assert.equal(help.module, 'os')
  assert.equal(help.pkg, '')
  assert.equal(help.summary, '')
  assert.equal(help.docs, '')
  assert.equal(help.doc, 'OS routines.')
  assert.equal(helpIsEmpty(help), false)
})

test('a package name loses no words, and only something that looks like a version is cut off', () => {
  assert.deepEqual(splitPackage('pandas 3.0.5'), { name: 'pandas', version: '3.0.5' })
  assert.deepEqual(splitPackage('scikit-learn 1.9.0'), { name: 'scikit-learn', version: '1.9.0' })
  // No version, and no extra cutting: a package can have a two-word name.
  assert.deepEqual(splitPackage('ruamel.yaml.clib'), { name: 'ruamel.yaml.clib', version: '' })
  assert.deepEqual(splitPackage('My Package'), { name: 'My Package', version: '' })
})

test('only http(s) is clickable: the link comes from third-party metadata', () => {
  assert.equal(safeLink('https://pandas.pydata.org/docs/'), 'https://pandas.pydata.org/docs/')
  assert.equal(safeLink('  http://seaborn.pydata.org '), 'http://seaborn.pydata.org')
  /*
   * `javascript:` in a line a person reads as "Documentation" means running
   * someone else's code on a click in the help. A package's metadata is
   * written by whoever built the package, and it cannot be trusted one bit.
   */
  assert.equal(safeLink('javascript:alert(1)'), null)
  assert.equal(safeLink('JavaScript:alert(1)'), null)
  assert.equal(safeLink('data:text/html,<script>'), null)
  assert.equal(safeLink('ftp://example.org'), null)
  assert.equal(safeLink('example.org'), null)
  assert.equal(safeLink(''), null)
})

test('the window draws the module card with nodes, and the link only once checked', () => {
  assert.match(EDITOR, /function moduleHead\(/)
  assert.match(EDITOR, /const safe = safeLink\(help\.docs\)/)
  // href is assigned AFTER the check, and only from it.
  assert.match(EDITOR, /link\.href = safe/)
  assert.match(EDITOR, /link\.rel = 'noopener noreferrer'/)
  assert.match(EDITOR, /link\.target = '_blank'/)
  assert.doesNotMatch(EDITOR, /innerHTML/)
})

/* -------------------------------------------------- signature in parts */

/**
 * The signature layout is about WHAT people look for in it.
 *
 * They look for a parameter name: "does lmplot have aspect and how is it
 * spelled". IPython prints a long signature as a column, one parameter per
 * line, and for `sns.lmplot` that is forty-three lines — the whole help
 * window, after which the documentation lies three screens of scrolling away.
 * As a flow, the same forty-two parameters take seven lines.
 *
 * The parsing breaks silently and is therefore checked here case by case: a
 * comma inside a default would cut a parameter in half and show the person a
 * parameter that does not exist.
 */
test('a multi-line IPython signature is assembled into a flow of parameters', () => {
  const parts = splitSignature(parseSignatureHelp(LMPLOT).signature)
  assert.ok(parts)
  assert.equal(parts.head, 'sns.lmplot(')
  assert.deepEqual(
    parts.params.map((param) => param.name),
    ['data', '*', 'x', 'y', 'hue', 'height', 'aspect', 'markers', 'facet_kws'],
  )
  assert.equal(parts.tail, ')')
  // The line a person selects and copies is an ordinary Python line.
  assert.equal(
    parts.flat,
    "sns.lmplot(data, *, x=None, y=None, hue=None, height=5, aspect=1, markers='o', facet_kws=None)",
  )
  // Seven or eight lines instead of forty-three: that is what was intended.
  assert.ok(parts.flat.length / 78 < 2, 'the flow does not fit into a couple of window lines')
})

test('a comma inside a default does not cut the parameter', () => {
  const parts = splitSignature('f(a=dict(b=1, c=(2, 3)), sep=", ", names=Dict[str, int])')
  assert.ok(parts)
  assert.deepEqual(
    parts.params.map((param) => param.name + param.rest),
    ['a=dict(b=1, c=(2, 3))', 'sep=", "', 'names=Dict[str, int]'],
  )
})

test('the star, the slash, *args and **kwargs are whole parameters', () => {
  const parts = splitSignature('f(a, /, b, *, c, *args, **kwargs)')
  assert.ok(parts)
  assert.deepEqual(
    parts.params.map((param) => param.name),
    ['a', '/', 'b', '*', 'c', '*args', '**kwargs'],
  )
  // There is nothing to split in them: none of them has a suffix.
  assert.deepEqual(
    parts.params.map((param) => param.rest),
    ['', '', '', '', '', '', ''],
  )
})

test('the name is separated from the annotation and default at the first colon or equals sign', () => {
  const parts = splitSignature("df.head(n: 'int' = 5, key=lambda x: x, flag=False) -> 'Self'")
  assert.ok(parts)
  assert.deepEqual(parts.params, [
    { name: 'n', rest: ": 'int' = 5" },
    // The lambda's colon comes AFTER `=`, and the first of the two wins.
    { name: 'key', rest: '=lambda x: x' },
    { name: 'flag', rest: '=False' },
  ])
  assert.equal(parts.tail, ") -> 'Self'")
  assert.equal(parts.flat, "df.head(n: 'int' = 5, key=lambda x: x, flag=False) -> 'Self'")
})

test('a parenthesis inside a string does not count as a parenthesis', () => {
  const parts = splitSignature(`f(sep=")", quote='"', esc="\\"")`)
  assert.ok(parts)
  assert.deepEqual(
    parts.params.map((param) => param.name),
    ['sep', 'quote', 'esc'],
  )
})

test('a signature without parameters and without parentheses', () => {
  const empty = splitSignature('f()')
  assert.ok(empty)
  assert.deepEqual(empty.params, [])
  assert.equal(empty.flat, 'f()')
  // Not a signature at all: it must be shown verbatim, not rearranged.
  assert.equal(splitSignature('numpy.ndarray'), null)
  assert.equal(splitSignature('f(a, b'), null, 'unbalanced parentheses were parsed')
  assert.equal(splitSignature('(a, b)'), null, 'parentheses without a callable passed for a signature')
})

test('a short signature stays on one line', () => {
  const short = splitSignature(parseSignatureHelp(HEAD).signature)
  assert.ok(short)
  assert.ok(short.flat.length <= SIGNATURE_ONE_LINE, `${short.flat.length} characters`)
  // And a long one does not: the layout is chosen by exactly this number.
  const long = splitSignature(parseSignatureHelp(LMPLOT).signature)
  assert.ok((long?.flat.length ?? 0) > SIGNATURE_ONE_LINE)
})

test('the window draws the flow with spans and does not touch innerHTML', () => {
  assert.match(EDITOR, /function signatureFlow\(/)
  assert.match(EDITOR, /cm-signature-sig cm-signature-flow/)
  assert.match(EDITOR, /className = 'cm-signature-param'/)
  assert.match(EDITOR, /rest\.className = 'cm-signature-default'/)
  // The text comes from the kernel: it is assembled from nodes, not markup.
  assert.doesNotMatch(EDITOR, /innerHTML/)
  assert.match(EDITOR, /document\.createTextNode\(' '\)/, 'no space separator — a copy would run together')
  // Wrapping only between parameters, a hanging indent on wrapped lines.
  assert.match(THEME, /'\.cm-signature-param': \{\s*whiteSpace: 'nowrap'/)
  assert.match(THEME, /'\.cm-signature-flow': \{[\s\S]*?whiteSpace: 'normal'/)
  assert.match(THEME, /paddingLeft: '2ch'/)
  assert.match(THEME, /textIndent: '-2ch'/)
  assert.match(THEME, /'\.cm-signature-default': \{\s*color: 'rgb\(var\(--muted\)\)'/)
})

/* ----------------------------------------------------------------- memory */

test('a second hover over the same name is served from memory, not from the kernel', () => {
  forgetHelp()
  const key = helpKey('c_1', 'sns.lmplot')
  assert.equal(rememberedHelp(key), null)
  rememberHelp(key, LMPLOT)
  assert.equal(rememberedHelp(key), LMPLOT)
  // A name is remembered WITHIN a cell: `df` in the next cell is a different
  // object.
  assert.equal(rememberedHelp(helpKey('c_2', 'sns.lmplot')), null)
})

test('the memory lives a minute and dies when a cell runs', () => {
  forgetHelp()
  const key = helpKey('c_1', 'df')
  const now = 1_000_000
  rememberHelp(key, HEAD, now)
  assert.equal(rememberedHelp(key, now + HELP_TTL_MS - 1), HEAD)
  // A minute has passed — anything could have been redefined in the kernel in
  // that time.
  assert.equal(rememberedHelp(key, now + HELP_TTL_MS + 1), null)

  rememberHelp(key, HEAD, now)
  forgetHelp()
  assert.equal(rememberedHelp(key, now), null, 'running a cell did not erase the memory')
})

/* ---------------------------------------------- the window and its layer */

const EDITOR = read('web/src/components/notebook/CodeEditor.svelte')
const CELL = read('web/src/components/notebook/CellView.svelte')
const THEME = read('web/src/components/notebook/cm-theme.ts')
const SESSION = read('web/src/lib/session.svelte.ts')

test('the editor no longer cuts the kernel answer by lines', () => {
  assert.doesNotMatch(EDITOR, /SIGNATURE_LINES/, 'the six-line cap is back')
  assert.doesNotMatch(EDITOR, /function signatureHead/, 'the header truncation is back')
  assert.match(EDITOR, /parseSignatureHelp\(/, 'the help parsing got lost')
})

test('the help window has one scroll, and it does not drag the notebook along', () => {
  assert.match(THEME, /'\.cm-signature-body': \{[\s\S]*?overflow: 'auto'/)
  assert.match(THEME, /'\.cm-signature-body': \{[\s\S]*?overscrollBehavior: 'contain'/)
  assert.match(THEME, /maxHeight: 'min\(45vh, 420px\)'/)
  // There must be no second scroll: a separate one for the signature would
  // make the documentation unreachable — see the argument at signatureDom.
  assert.equal((THEME.match(/overflow: 'auto'/g) ?? []).length, 1)
  assert.match(THEME, /width: 'min\(640px, 92vw\)'/)
})

test('the help is still below the line and beneath the cell toolbar', () => {
  assert.match(EDITOR, /above: false/)
  assert.match(THEME, /'\.cm-tooltip\.cm-tooltip-hover': \{\s*zIndex: '5'/)
  // The one pinned with Shift+Tab has no host — `cm-tooltip` hangs on our
  // node, and it needs its own layer.
  assert.match(THEME, /'\.cm-tooltip\.cm-signature': \{\s*zIndex: '5'/)
})

test('Shift+Tab opens the help only where there is no indent to remove', () => {
  assert.match(EDITOR, /key: 'Shift-Tab'/)
  // A selection and readOnly pass the keypress on — to the indent.
  assert.match(EDITOR, /if \(!range\.empty\) return false/)
  // The target is found through the syntax tree, not by neighbouring
  // characters: the rule and its table of cases are in lib/hover-target.ts
  // (tests/hover-target.test.mts).
  assert.match(EDITOR, /const spot = caretSpot\(cm, view, range\.head\)/)
  assert.match(EDITOR, /if \(!spot\) return false/)
  // Removing the indent stayed in place and stayed lower in precedence.
  assert.match(EDITOR, /indentLess: cm\.commands\.indentLess/)
  assert.ok(
    EDITOR.indexOf("key: 'Shift-Tab'") < EDITOR.indexOf('tabKey({'),
    'the help ended up below the indent and will never fire',
  )
})

test('hover asks the syntax tree, not the neighbouring characters', () => {
  /*
   * "Whenever I hover over code or while I write code, something pops up" —
   * a complaint of 21 Sep 2026. A regex over the line took ANY word under the
   * pointer: a column name in quotes, `x=` in an argument list, a word in a
   * comment. And each such hover cost a frame on the socket.
   */
  assert.match(EDITOR, /const spot = hoverSpot\(cm, view, pos\)/)
  assert.match(EDITOR, /if \(!spot\) return null/)
  assert.match(EDITOR, /cm\.language\.syntaxTree\(view\.state\)/)
  assert.doesNotMatch(EDITOR, /function nameAround\(/, 'the regex over the line is back')
  /*
   * A refusal costs nothing: `return null` stands between checking the target
   * and asking the kernel, that is, not a single frame goes out at a forbidden
   * spot.
   */
  assert.match(EDITOR, /const spot = hoverSpot\(cm, view, pos\)\s*\n\s*if \(!spot\) return null/)
  // And the fork by target kind comes right after the check: at a forbidden
  // spot not a single frame goes out — neither for help nor for the value
  // line.
  assert.match(EDITOR, /if \(!spot\) return null[\s\S]{0,600}spot\.kind === 'value'/)
  // Aliases are read from the notebook and remembered until the text is
  // edited.
  assert.match(EDITOR, /function aliasesNow\(\)/)
  assert.match(EDITOR, /if \(aliasMemo\?\.stamp === stamp\) return aliasMemo\.names/)
  assert.match(CELL, /sources=\{codeSources\}/)
  assert.match(CELL, /function codeSources\(\)/)
})

test('one help on the screen, not two', () => {
  /*
   * Having pressed Shift+Tab, people do not take their hand off the mouse: the
   * pointer stays on the same name, and a third of a second later a second
   * window slid out under the pinned one — with the same text. Observed on the
   * test bench. This is closed from two sides: hover stays silent while a
   * pinned one is up, and pinning removes what has already slid out.
   */
  assert.match(EDITOR, /if \(view\.state\.field\(pinnedField, false\)\) return null/)
  assert.match(EDITOR, /effects: \[cm\.view\.closeHoverTooltips, pinned\.of\(signatureTooltip\(/)
  // And the pinned one must be declared before the hover — otherwise there is
  // no one to ask about it.
  assert.ok(EDITOR.indexOf('const pinnedField') < EDITOR.indexOf('const signatureHover'))
})

test('Escape closes both kinds of help — even when focus has left the cell', () => {
  // One door for both kinds: the hover one and the one pinned with Shift+Tab.
  assert.match(EDITOR, /effects: \[cm\.view\.closeHoverTooltips, pinned\.of\(null\)\]/)
  assert.match(EDITOR, /closeSignature\(view\)/)
  /*
   * Selecting a line inside the window with the mouse moves focus out of the
   * cell — and Escape stops reaching the editor's keymap. Measured on the test
   * bench: the window stayed up until the pointer was moved away. A listener
   * on the document closes this gap and only it: while focus is in the
   * editor, the editor itself sorts out the order.
   */
  assert.match(EDITOR, /document\.addEventListener\('keydown', onKey, true\)/)
  assert.match(EDITOR, /if \(event\.key !== 'Escape' \|\| view\.hasFocus\) return/)
  assert.match(EDITOR, /destroy: \(\) => document\.removeEventListener\('keydown', onKey, true\)/)
})

/* -------------------------------------------------------- the value line */

test('for a variable — a line, not a window: name, type, size', () => {
  /*
   * "At least the variable's data type, a quick type and the shape" — the
   * owner's request of 21 Sep 2026, and its second half matters just as much:
   * "it also added a whole wagon of more detailed text, that's not much fun".
   * So a value gets its own badge, not the help window: no documentation, no
   * signature.
   */
  assert.match(EDITOR, /function briefDom\(/)
  assert.match(EDITOR, /dom\.className = 'cm-signature cm-signature-brief'/)
  assert.match(EDITOR, /spot\.kind === 'value'\s*\n\s*\? await askBrief\(/)
  // No reasons, no retries: no answer — no line.
  assert.match(EDITOR, /if \(!answer\?\.found \|\| !answer\.brief\) return null/)
  assert.doesNotMatch(EDITOR, /signatureMiss\(answer\.reason\)[\s\S]{0,80}askBrief/)
  // A badge of the same layer and size as the reason line, not a 640×420
  // window.
  assert.match(THEME, /'\.cm-signature-brief': \{[\s\S]*?width: 'auto'/)
  assert.match(THEME, /'\.cm-signature-brief': \{[\s\S]*?whiteSpace: 'nowrap'/)
  assert.doesNotMatch(THEME, /'\.cm-signature-brief': \{[\s\S]*?overflow: 'auto'/)
})

test('numbers in the value line read the way people write them', () => {
  // 1460 → "1 460" in Russian and "1,460" in English: digit groups are set by
  // the room's language, not by the server, which does not have that
  // language.
  assert.match(EDITOR, /function withGroups\(/)
  assert.match(EDITOR, /text\.replace\(\/\\d\{4,\}\/g, \(digits\) => formatNumber\(Number\(digits\)\)\)/)
  // And a long value is cut: the line must not compete with the code.
  assert.match(EDITOR, /joined\.length > 60 \? `\$\{joined\.slice\(0, 59\)\}…` : joined/)
})

test('the memory of values dies together with the help memory', () => {
  const SOURCE = read('web/src/lib/signature-help.ts')
  assert.match(SOURCE, /export function rememberedBrief\(/)
  assert.match(SOURCE, /export function rememberBrief\(/)
  /*
   * `df` after running a cell is a different `df`, and its "1 460 × 81" may no
   * longer be the same number. The reset is shared with the help: one place
   * for both memories.
   */
  assert.match(SOURCE, /briefs\.clear\(\)/)
})

/* ---------------------------------------------- the tooltip waits by itself */

/**
 * "It is unclear why I have to move the cursor away and hover again for the
 * signature to appear" — a complaint from the class of 20 Sep 2026.
 *
 * The reason was that only a hover asks for the tooltip: the person read the
 * answer "the kernel is starting", two seconds later the kernel came up, and
 * the window went on showing yesterday's news. Now the window asks again by
 * itself while it is open, and replaces the reason with the help in place.
 */
test('on a temporary reason the tooltip asks again, on a final one it does not', () => {
  // Three temporary reasons and their tick; `unknown` and `no-kernel` are not
  // on the list — there will be no answer for them however often you ask.
  assert.match(EDITOR, /\['starting', 1000\]/)
  assert.match(EDITOR, /\['thinking', 1000\]/)
  assert.match(EDITOR, /\['busy', 2000\]/)
  assert.doesNotMatch(EDITOR, /\['unknown', \d/)
  assert.doesNotMatch(EDITOR, /\['no-kernel', \d/)
  // The waiting cap: a minute and a half for a kernel start-up, twenty seconds
  // for the rest.
  assert.match(EDITOR, /WAIT_CEILING_MS: Record<string, number> = \{ starting: 90_000 \}/)
  assert.match(EDITOR, /WAIT_CEILING_DEFAULT_MS = 20_000/)
})

test('asking again stops when the window is gone or the text has changed', () => {
  // Three signs, and all three mean "the window is no longer about this
  // spot".
  assert.match(EDITOR, /if \(!dom\.isConnected \|\| view\.state\.doc !== doc \|\| Date\.now\(\) > until\) return/)
  // And the same check AFTER the trip to the kernel: it could have been closed
  // while we were away.
  assert.match(EDITOR, /if \(!dom\.isConnected \|\| view\.state\.doc !== doc\) return/)
})

test('the answer replaces the reason in the same node, and the window is re-measured', () => {
  /*
   * The node belongs to CodeMirror (`create: () => ({ dom })`): swapping it
   * out would leave the tooltip without content. The class and children
   * change — and a one-line window turns into a six-hundred-pixel one, and
   * without a re-measure it would stay at its old size.
   */
  assert.match(EDITOR, /dom\.className = built\.className/)
  assert.match(EDITOR, /dom\.replaceChildren\(\.\.\.built\.childNodes\)/)
  assert.match(EDITOR, /view\.requestMeasure\(\)/)
})

test('a temporary reason has a waiting sign, a final one does not', () => {
  assert.match(EDITOR, /if \(WAITING\.has\(reason\)\)/)
  assert.match(EDITOR, /wait\.className = 'cm-signature-wait'/)
  // The dots breathe through opacity: nothing moves, and the product's
  // prefers-reduced-motion rule (index.css) does not ask to touch this.
  assert.match(THEME, /'\.cm-signature-wait i': \{[\s\S]*?animation: 'colloq-signature-wait/)
  assert.match(THEME, /'@keyframes colloq-signature-wait': \{\s*'0%, 100%': \{ opacity: '0\.25' \}/)
  assert.doesNotMatch(THEME, /colloq-signature-wait[\s\S]{0,200}translate/)
})

test('the help gets its own deadline, longer than the server cap on parsing', () => {
  /*
   * Static parsing inside the kernel is 2.5 s plus the trip; the old three
   * seconds on the client meant it hung up before the answer came, and the
   * first hover over pandas showed nothing at all.
   */
  assert.match(SESSION, /const INSPECT_TIMEOUT_MS = 4000/)
  assert.match(SESSION, /kind === 'inspect' \? INSPECT_TIMEOUT_MS : ASK_TIMEOUT_MS/)
})

test('running a cell erases the help memory — in one place for all buttons', () => {
  assert.match(SESSION, /message\.t === 'run' \|\| message\.t === 'restart'/)
  assert.match(SESSION, /forgetHelp\(\)/)
})
