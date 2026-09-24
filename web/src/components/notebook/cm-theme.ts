import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * CodeMirror dressing for notebook cells.
 *
 * index.css owns the structural surface — gutters, selection, cursors, remote
 * carets — because those rules have to reach y-codemirror's markup too. This
 * file owns what a theme must: token colour, the popup surfaces, and the
 * handful of metrics that live inside the editor's own style module.
 *
 * Every hue below is drawn from the HSE departmental palette, so the editor
 * belongs to the same system as the rest of the product. One colour is banned
 * outright: the accent cyan is the live-execution signal everywhere else, and a
 * cell that is merely selected must never be mistaken for a cell that is
 * running. So nothing here reads --accent, nor --ring, --select or --primary,
 * each of which resolves to it in one theme or the other.
 */

const SYN = [
  'text',
  'keyword',
  'fn',
  'type',
  'string',
  'number',
  'comment',
  'meta',
  'literal',
  'punct',
] as const

type Syn = (typeof SYN)[number]

const syn = (name: Syn) => `var(--syn-${name})`

const pair = (light: string, dark: string) => `light-dark(${light}, ${dark})`

/**
 * A hue at low alpha, mixed from the token rather than from a hex.
 *
 * The palette used to be two records in this file, which is why this used to
 * take a literal. It is in index.css now — with everything else the product
 * paints with — so the only way to reach a syntax hue from here is the variable,
 * and color-mix is what puts alpha on one.
 */
const wash = (name: Syn, alpha: number) =>
  `color-mix(in srgb, ${syn(name)} ${Math.round(alpha * 100)}%, transparent)`

/*
 * The palette lists booleans twice — beside numbers, and beside None and self.
 * True/False keep company with None here: the grammar tags them as keyword-like
 * literals, and a `True` that matches `None` reads better than one that matches
 * `3.14`. Numbers keep the Social Sciences orange to themselves.
 */
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: syn('comment'), fontStyle: 'italic' },

  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier],
    color: syn('keyword'),
    fontWeight: 'bold',
  },
  { tag: [t.null, t.self, t.atom, t.bool], color: syn('literal') },

  { tag: [t.string, t.special(t.string), t.docString, t.character, t.regexp], color: syn('string') },
  { tag: [t.number, t.integer, t.float, t.unit], color: syn('number') },

  // The palette sheet draws `def conv2d` with the name in the bold cut and every
  // other function reference in the plain one: what a cell *defines* is
  // structure, what it calls is just more code.
  { tag: t.function(t.definition(t.variableName)), color: syn('fn'), fontWeight: 'bold' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
    color: syn('fn'),
  },
  { tag: [t.variableName, t.definition(t.variableName), t.propertyName, t.labelName], color: syn('text') },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: syn('type') },

  // `@` and the escapes inside a string are both "this is not ordinary text".
  { tag: [t.meta, t.annotation, t.escape], color: syn('meta') },

  {
    tag: [t.operator, t.derefOperator, t.punctuation, t.separator, t.bracket, t.paren, t.squareBracket, t.brace],
    color: syn('punct'),
  },
  // Subtag of meta, but markdown's `#`/`-`/`>` markers are punctuation to the eye.
  { tag: t.processingInstruction, color: syn('punct') },

  { tag: t.invalid, color: 'rgb(var(--danger))' },

  // Markdown source, kept close to how the rendered note will look.
  { tag: t.heading, color: syn('text'), fontWeight: '600' },
  { tag: t.strong, color: syn('text'), fontWeight: '600' },
  { tag: t.emphasis, color: syn('text'), fontStyle: 'italic' },
  { tag: t.link, color: syn('keyword'), textDecoration: 'underline' },
  { tag: t.url, color: syn('punct') },
  { tag: t.monospace, color: syn('string') },
  { tag: t.strikethrough, color: syn('comment'), textDecoration: 'line-through' },
  { tag: [t.list, t.quote, t.contentSeparator], color: syn('comment') },
])

/*
 * Theme switching. index.css resolves three states — bare :root is light, the
 * prefers-color-scheme block is dark, and [data-theme] overrides either — and
 * EditorView.theme cannot express the middle one, because style-mod expands `&`
 * textually and so cannot nest an ancestor selector inside an @media block.
 *
 * What it CAN do is ride on the property index.css already flips in all three
 * states: color-scheme. So the tokens below are light-dark() pairs, and the
 * document's colour scheme picks the side. The two [data-theme] blocks then
 * repeat the same records verbatim — redundant where light-dark() is supported,
 * and the reason an explicit theme choice still paints correctly where it isn't.
 *
 * One static extension, no Compartment, nothing for the app to reconfigure.
 */
const theme = EditorView.theme({
  '&': {
    color: syn('text'),
    backgroundColor: 'transparent',
  },

  /*
   * No `{ dark: true }`: that facet is static, so it would be a lie in half of
   * the sessions. Every light/dark-scoped rule the base theme would then win —
   * caret, placeholder, special chars, gutters, tooltips, search matches — is
   * restated below at equal specificity, and this module mounts after it.
   */
  '.cm-content': {
    caretColor: 'rgb(var(--ink))',
  },
  '.cm-scroller': {
    lineHeight: '1.65',
  },
  '.cm-line': {
    padding: '0 8px 0 4px',
  },
  // A dozen cells each highlighting their own "active" line is noise; only the
  // cell being typed in earns it.
  '&:not(.cm-focused) .cm-activeLine': {
    backgroundColor: 'transparent !important',
  },
  /*
   * muted, not faint. Beside a label a placeholder is a hint; in an EMPTY cell
   * it is the only thing on the line, which makes it the content — and content
   * clears AA. It measured 3.47:1 before this.
   */
  '.cm-placeholder': {
    color: 'rgb(var(--muted))',
  },
  '.cm-specialChar': {
    color: 'rgb(var(--danger))',
  },

  '.cm-gutters': {
    color: 'rgb(var(--faint))',
    userSelect: 'none',
  },

  // Ink-on-ground washes rather than a hue: they are legible over either ground
  // without a second palette, and they cannot drift toward the running cyan.
  //
  // Only while this editor has focus, and that is not a detail. Every cell of a
  // notebook is its own EditorView with its own selection, and a selection does
  // not go away when the cursor leaves — so an unscoped rule lit the brackets in
  // every cell the teacher had ever touched, and by the middle of a seminar the
  // whole document was speckled with grey. The bracket wash answers "where is my
  // cursor", which is a question exactly one cell can answer at a time.
  //
  // @codemirror/language scopes its own default the same way; the bare selector
  // was here to outrank it and outranked the focus condition instead. It is not
  // needed: EditorView.theme is ordered after EditorView.baseTheme, so the same
  // selector wins on precedence alone.
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgb(var(--ink) / 0.16)',
    borderRadius: '2px',
    outline: 'none',
    color: 'inherit',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'rgb(var(--danger) / 0.22)',
    borderRadius: '2px',
    color: 'inherit',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgb(var(--warning) / 0.28)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgb(var(--warning) / 0.55)',
    color: 'rgb(var(--ink))',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgb(var(--ink) / 0.1)',
  },
  '.cm-snippetField': {
    backgroundColor: 'rgb(var(--ink) / 0.12)',
  },
  '.cm-panels': {
    backgroundColor: 'rgb(var(--surface))',
    color: 'rgb(var(--ink))',
    border: 'none',
  },

  '.cm-tooltip': {
    backgroundColor: 'rgb(var(--raised))',
    border: '1px solid rgb(var(--line))',
    borderRadius: '10px',
    color: 'rgb(var(--ink))',
    overflow: 'hidden',
    boxShadow: '0 12px 32px -12px rgb(var(--shadow-color) / var(--shadow-pop))',
  },
  '.cm-tooltip-section:not(:first-child)': {
    borderTop: '1px solid rgb(var(--line))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'inherit',
    fontSize: '13px',
    maxHeight: '15em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '3px 10px',
    color: 'rgb(var(--muted))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: pair(wash('keyword', 0.14), wash('keyword', 0.2)),
    color: 'rgb(var(--ink))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete-disabled > ul > li[aria-selected]': {
    backgroundColor: 'rgb(var(--ink) / 0.1)',
    color: 'rgb(var(--muted))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section': {
    borderBottom: '1px solid rgb(var(--line))',
    color: 'rgb(var(--faint))',
  },
  '.cm-completionIcon': {
    opacity: '0.55',
    paddingRight: '10px',
  },
  '.cm-completionMatchedText': {
    color: syn('keyword'),
    fontWeight: '600',
    textDecoration: 'none',
  },
  '.cm-completionDetail': {
    color: 'rgb(var(--faint))',
    fontStyle: 'normal',
  },
  '.cm-tooltip.cm-completionInfo': {
    padding: '6px 10px',
    color: 'rgb(var(--muted))',
  },

  /*
   * Help: the signature IN FULL and the documentation under it, in a scrolling
   * window.
   *
   * There are several rules because there are several nodes. For hover help,
   * `hoverTooltip` creates ITS OWN host node (`.cm-tooltip.cm-tooltip-hover`)
   * and puts into it whatever the source returned: positioning, border and
   * layer live on the host, sizes and font on our content. Help pinned with
   * Shift+Tab has no host at all — `cm-tooltip` is put on OUR node — so its
   * layer is set on a separate line. Written as one combined selector, it
   * matched nothing: the tooltip slid out across the full width of the window,
   * with no padding and no wrapping. Checked on a live kernel, not by eye.
   *
   * The layer is BELOW the cell toolbar, and this is not a matter of taste. All
   * CodeMirror tooltips have z-index 500 (from its base theme), the row of
   * buttons above a cell has 10 (CellView.svelte). Help that slides out below
   * the last line lands exactly on the next cell's toolbar and would cover
   * "run" and "stop" — the very buttons the person is reaching for at that
   * moment. A tooltip is a tooltip; a button that cannot be seen is a breakage.
   *
   * The completion list does not get this layer: it hangs under the caret,
   * people aim at it with the mouse, and it cannot slide under another cell's
   * button.
   */
  '.cm-tooltip.cm-tooltip-hover': {
    zIndex: '5',
    maxWidth: 'min(640px, 92vw)',
  },
  '.cm-tooltip.cm-signature': {
    zIndex: '5',
  },
  '.cm-signature': {
    /*
     * The width is set, not derived from the text. The signature and the
     * documentation have different natural widths — the first long and narrow,
     * the second in paragraphs — and a window adjusting to its content would
     * jump from name to name. 640 is the width at which a docstring line reads
     * without the eyes running back and forth; 92vw is the same on a phone,
     * where there simply is no width.
     */
    width: 'min(640px, 92vw)',
    maxWidth: '100%',
    boxSizing: 'border-box',
    /* Anchor for the "more below" shadow along the window's bottom edge. */
    position: 'relative',
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    lineHeight: '1.5',
    color: 'rgb(var(--ink))',
  },
  /*
   * ONE scroll for the signature and the documentation together — the argument
   * is written next to the markup (CodeEditor.svelte · signatureDom). 45vh so
   * that the help does not cover the cell it was asked about; 420 so that on a
   * big monitor it does not turn into half the screen.
   *
   * `overscroll-behavior: contain` is about a wheel scrolled all the way to the
   * end: without it the scrolling would continue ON THE NOTEBOOK, and the help
   * would slide away from under the pointer together with the cell.
   */
  '.cm-signature-body': {
    maxHeight: 'min(45vh, 420px)',
    overflow: 'auto',
    overscrollBehavior: 'contain',
    padding: '7px 11px',
    /* Help text gets selected and copied: it is an answer, not decoration. */
    userSelect: 'text',
  },
  /* pandas help can be wider than the monitor — wrap it, do not stretch. */
  '.cm-signature-sig': {
    margin: '0',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  /*
   * A long signature — as a flow, not as a column.
   *
   * IPython prints one parameter per line: for `sns.lmplot` that is forty-three
   * lines, that is, the whole window, and the documentation ends up three
   * screens of scrolling away. Here the text flows like an ordinary paragraph
   * and breaks only at a space BETWEEN parameters — a parameter itself is
   * unbreakable (`.cm-signature-param`), because people look for a name in a
   * signature, and a name torn in half cannot be found.
   *
   * A hanging indent, so that wrapped lines do not start where the callee's
   * name does: two characters to the right, and the eye sees where
   * `sns.lmplot(` ended and the parameters began. `text-indent` is negative by
   * exactly the same amount, so the first line stays in place.
   *
   * `overflowWrap` goes back to normal: on `.cm-signature-sig` it is `anywhere`
   * for the sake of the monolithic pandas line, while here breaking words is
   * unnecessary and harmful.
   */
  '.cm-signature-flow': {
    whiteSpace: 'normal',
    overflowWrap: 'normal',
    wordBreak: 'normal',
    paddingLeft: '2ch',
    textIndent: '-2ch',
  },
  '.cm-signature-param': {
    whiteSpace: 'nowrap',
  },
  /*
   * Default and annotation — muted.
   *
   * People read the name: in `x_estimator=None` the eye looks for
   * `x_estimator`, while `=None` has to be visible but not read. In a single
   * colour all of this turns into a solid sheet in which the names have to be
   * hunted for.
   */
  '.cm-signature-default': {
    color: 'rgb(var(--muted))',
  },
  /*
   * The module card: the name with its version large, the kind muted, the
   * description as a line.
   *
   * Monospaced — like everything else in the window: `matplotlib.pyplot` is a
   * name from code, and setting it in a proportional font would mean pretending
   * that it is prose. The description and the link are in the same font, but
   * quieter: they are read once.
   */
  '.cm-signature-title': {
    fontSize: '13px',
    lineHeight: '1.45',
    color: 'rgb(var(--ink))',
  },
  '.cm-signature-title b': {
    fontWeight: '700',
  },
  '.cm-signature-kind': {
    fontWeight: '400',
    color: 'rgb(var(--faint))',
  },
  '.cm-signature-summary': {
    marginTop: '5px',
    fontSize: '12px',
    lineHeight: '1.5',
    color: 'rgb(var(--muted))',
  },
  '.cm-signature-docs': {
    marginTop: '4px',
    fontSize: '12px',
    color: 'rgb(var(--faint))',
    overflowWrap: 'anywhere',
  },
  /*
   * The link is underlined and in the keyword colour — the same one this theme
   * draws a markdown link in: within one window a link has one look.
   */
  '.cm-signature-docs a': {
    color: syn('keyword'),
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  '.cm-signature-note': {
    marginTop: '5px',
    fontSize: '11px',
    letterSpacing: '0.02em',
    color: 'rgb(var(--faint))',
  },
  /*
   * The documentation is in the same monospace, and that is not laziness.
   * Docstrings contain examples like `>>> df.head()` together with their
   * output: pandas tables are aligned with spaces, and a proportional font
   * would turn them into mush.
   */
  '.cm-signature-doc': {
    margin: '7px 0 0',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '1.55',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: 'rgb(var(--muted))',
  },
  /*
   * "There is more": a shadow along the bottom edge until scrolled to the end.
   *
   * Needed because on macOS the scrollbar is invisible until it is touched:
   * without this shadow the window looks finished exactly where the text is cut
   * off, and half of the help does not exist for anyone who did not think to
   * scroll. Transparent to the mouse — people aim at the text under it, not at
   * the shadow.
   */
  '.cm-signature-more': {
    position: 'absolute',
    left: '1px',
    right: '1px',
    bottom: '0',
    height: '20px',
    borderRadius: '0 0 10px 10px',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity var(--speed-quick) ease',
    background: 'linear-gradient(to bottom, rgb(var(--raised) / 0), rgb(var(--raised)))',
  },
  '.cm-signature-cut .cm-signature-more': {
    opacity: '1',
  },
  /*
   * The reason there is no help — in one line and without a window.
   *
   * The width here is its own: "The kernel is starting" takes a third of a
   * line, and stretching the six-hundred-pixel window for it would be
   * whispering into a megaphone.
   */
  /*
   * Three dots on a temporary reason: "waiting for an answer, it will come".
   *
   * They breathe through opacity, and that is not decoration but a promise. A
   * stopped indicator is a lie about the system (the product's policy on
   * spinners, index.css), and this product's `prefers-reduced-motion` rule
   * removes MOVEMENT and explicitly keeps colour and opacity: nothing moves
   * here, it only dims and lights up again. The phase shift is there so that it
   * reads as counting, not as blinking.
   */
  '.cm-signature-wait': {
    display: 'inline-flex',
    gap: '3px',
    marginLeft: '6px',
    verticalAlign: 'baseline',
  },
  '.cm-signature-wait i': {
    width: '3px',
    height: '3px',
    borderRadius: '50%',
    backgroundColor: 'rgb(var(--faint))',
    animation: 'colloq-signature-wait 1200ms ease-in-out infinite',
  },
  '.cm-signature-wait i:nth-child(2)': { animationDelay: '160ms' },
  '.cm-signature-wait i:nth-child(3)': { animationDelay: '320ms' },
  '@keyframes colloq-signature-wait': {
    '0%, 100%': { opacity: '0.25' },
    '50%': { opacity: '1' },
  },
  /*
   * A line about a value: `apartments · DataFrame · 1 460 × 81`.
   *
   * The same pill as the reason line, and that is a decision: about a variable
   * people ask "what is it and how big", not "tell me everything" — a window
   * with scrolling and documentation here would be the very "ton of text" the
   * owner complained about. The name is muted, the type stands out, the rest is
   * quieter: the eye goes along the line from left to right and stops at the
   * type.
   */
  '.cm-signature-brief': {
    width: 'auto',
    maxWidth: 'min(520px, 90vw)',
    padding: '5px 10px',
    fontSize: '12px',
    lineHeight: '1.45',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'rgb(var(--ink))',
  },
  '.cm-signature-brief b': {
    fontWeight: '700',
  },
  '.cm-signature-name': {
    color: 'rgb(var(--faint))',
  },
  '.cm-signature-facts': {
    color: 'rgb(var(--muted))',
  },
  '.cm-signature-miss': {
    width: 'auto',
    maxWidth: 'min(420px, 88vw)',
    padding: '5px 10px',
    fontSize: '12px',
    color: 'rgb(var(--muted))',
    /* Text and dots on one line: the dots are part of the phrase, not an icon
       on the side. */
    display: 'flex',
    alignItems: 'center',
  },

  /*
   * The name that is about to be followed to its definition: ⌘/Ctrl is held,
   * the pointer is on it.
   *
   * An underline, not a colour. Colour is already taken here — it says WHAT
   * kind of word this is (`syn-fn`, `syn-type`, `syn-text`), and recolouring
   * the name under the pointer would mean lying about its role for half a
   * second. An underline takes nothing and reads unambiguously: a link in the
   * browser itself is opened with the same gesture and looks the same. The
   * underline's colour is the keyword colour, the same one this theme draws
   * markdown links in.
   *
   * `cursor: pointer` is the second half of the same promise: under the pointer
   * is not text to be selected but a place one is taken to.
   */
  '.cm-goto': {
    textDecoration: 'underline',
    textDecorationColor: syn('keyword'),
    textDecorationThickness: '1px',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },

  /*
   * The line that a jump has led to.
   *
   * The colour is the same as for a search match (`.cm-searchMatch` above), and
   * that is no coincidence: the person asked "where is this defined" and is
   * looking at the answer, that is, at what was found. There is no reason to
   * introduce a second paint for the same thought, and the only forbidden one
   * here is the run cyan: a highlighted line must not read as one that is
   * running.
   *
   * It fades by itself. It holds for two seconds and goes transparent — exactly
   * the time that `LANDING_MS` measures out in CodeEditor.svelte, where the
   * decoration is later removed entirely; the numbers must match, otherwise the
   * highlight either blinks twice or is cut off halfway.
   *
   * There is deliberately no `prefers-reduced-motion` block here. The product's
   * rule (index.css) removes MOVEMENT and explicitly keeps colour and opacity:
   * they do not shift anything. And this highlight is built so that removing
   * the animation means removing the highlight itself — the rule has no
   * background, it is all in the keyframes — that is, taking away from the
   * person the only answer to the question "where have I been taken".
   */
  '.cm-landed': {
    borderRadius: '2px',
    animation: 'colloq-landed 2000ms ease-out 1',
  },
  '@keyframes colloq-landed': {
    '0%': { backgroundColor: 'rgb(var(--warning) / 0.28)' },
    '55%': { backgroundColor: 'rgb(var(--warning) / 0.28)' },
    '100%': { backgroundColor: 'transparent' },
  },
})

export const colloqTheme: Extension = [theme, syntaxHighlighting(highlight)]

/*
 * Exported so code that is NOT in an editor can be painted by the same rules —
 * an oracle answer, a proposed rewrite, a version diff. They run it through
 * highlightTree and mount `highlight.module` themselves; see lib/syntax.
 */
export { highlight }
