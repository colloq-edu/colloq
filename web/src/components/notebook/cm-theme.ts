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
    fontSize: '12.5px',
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
})

export const colloqTheme: Extension = [theme, syntaxHighlighting(highlight)]

/*
 * Exported so code that is NOT in an editor can be painted by the same rules —
 * an oracle answer, a proposed rewrite, a version diff. They run it through
 * highlightTree and mount `highlight.module` themselves; see lib/syntax.
 */
export { highlight }
