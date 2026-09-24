import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { colloqTheme } from '@/components/notebook/cm-theme'

/**
 * The file editor's styling: the same as the cell's, plus what the cell does
 * not have.
 *
 * Token colours, tooltips, search and brackets — all shared, and that is not
 * a saving but a requirement: a `def` in a file must be the same `def` as in
 * the cell below it, otherwise the screen falls apart into two products.
 *
 * Exactly three things here are its own, and all three are about the file
 * taking up the whole column: the line-number gutter, the search bar, which
 * a cell never has, and room at the edges, without which the last line
 * sticks to the bottom edge and a neighbour's name badge gets clipped at the
 * top one.
 */
const surface = EditorView.theme({
  '&': {
    height: '100%',
  },
  '.cm-scroller': {
    // The same font as in the cells: it is set in index.css for .cm-editor
    // and reaches here by itself. Only what concerns the column goes here.
    paddingBottom: '40vh',
    // Space above the first line keeps the 18px collaborator label inside
    // the scrolling file editor; notebook cells allow it to overflow instead.
    paddingTop: '20px',
  },
  /*
   * The line-number gutter is set off by a line, not by air.
   *
   * A cell has no numbers at all: its code is a screen long, and a line
   * number has nothing to help with. In a three-hundred-line file the number
   * is how people point each other to a spot out loud in the middle of a
   * seminar, and it must be readable without pretending to be code.
   */
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '1px solid rgb(var(--line-soft))',
    color: 'rgb(var(--faint))',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 10px 0 16px',
    minWidth: '44px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'rgb(var(--muted))',
    fontWeight: '600',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 4px',
    color: 'rgb(var(--faint))',
  },
  // The line under the cursor is highlighted only in the editor where the
  // cursor actually is. The same argument as in the cells — but here there is
  // one editor, and the rule guards against a single case: a file open next
  // to typing in the terminal.
  '&:not(.cm-focused) .cm-activeLine': {
    backgroundColor: 'transparent !important',
  },
  '&.cm-focused .cm-activeLine': {
    backgroundColor: 'rgb(var(--surface) / 0.7)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid rgb(var(--line))',
  },
  '.cm-panel.cm-search': {
    padding: '6px 12px',
    fontFamily: 'inherit',
    fontSize: '14px',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontFamily: 'inherit',
    fontSize: '14px',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    boxSizing: 'border-box',
    minHeight: '30px',
  },
  '.cm-panel.cm-search input': {
    backgroundColor: 'rgb(var(--canvas))',
    border: '1px solid rgb(var(--line))',
    color: 'rgb(var(--ink))',
    padding: '5px 7px',
  },
  '.cm-panel.cm-search button': {
    backgroundColor: 'rgb(var(--canvas))',
    backgroundImage: 'none',
    border: '1px solid rgb(var(--line))',
    color: 'rgb(var(--muted))',
    padding: '5px 9px',
  },
})

export const fileTheme: Extension = [colloqTheme, surface]
