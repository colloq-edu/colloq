/**
 * Indentation in Colloq's editors: how much of it and what Tab does.
 *
 * Shared by the two editors — the notebook cell and the file — because code
 * travels between them by copying, and drifted indentation is visible only to
 * the kernel: half a function on four spaces, half on two, and an
 * IndentationError at a place the eye cannot tell apart. One of the two had
 * already diverged: Tab was bound in the file and not in the cell.
 *
 * The pure part is here, the key binding in the components: both load
 * CodeMirror lazily, and a static import from here would drag it into the
 * shared bundle (see importCodeMirror in CodeEditor.svelte).
 */
import type { Command, KeyBinding } from '@codemirror/view'
import type { EditorSelection as Selection } from '@codemirror/state'

/**
 * An indent is four spaces.
 *
 * Not two (the CodeMirror default) and not tabs: the notebook holds Python,
 * and there mixed indentation is a TabError, fixed by someone other than the
 * one who mixed it.
 */
export const INDENT = '    '

/** The indent width in columns. */
export const INDENT_WIDTH = INDENT.length

/**
 * Which column the cursor is in, if this text precedes it on the line.
 *
 * A tab counts not as one character but up to the next stop: the editors put
 * no tabs of their own, but nothing stops someone pasting foreign text into a
 * cell.
 */
export function columnOf(before: string, tabSize: number): number {
  let column = 0
  for (const ch of before) {
    column = ch === '\t' ? column + tabSize - (column % tabSize) : column + 1
  }
  return column
}

/**
 * What Tab inserts when pressed without a selection.
 *
 * NOT "four spaces always" and not a shift of the whole line: the indent is
 * padded up to the next stop, as in any editor with soft tabs. A cursor in the
 * middle of `return  1` gets as many spaces as it takes to land on a stop, not
 * as many as would push the whole line along with what is already written.
 *
 * Shifting LINES stays with the selection (indentMore) and with Shift-Tab
 * (indentLess) — these are different gestures and must not be confused: the
 * first is for typing, the second for restructuring what is already written.
 */
export function tabInsert(before: string, tabSize: number): string {
  const column = columnOf(before, tabSize)
  return ' '.repeat(INDENT_WIDTH - (column % INDENT_WIDTH))
}

/**
 * Tab and Shift-Tab for CodeMirror — the same in a cell and in a file.
 *
 * CodeMirror's parts come in as parameters, not as an import: see the file
 * header.
 */
export function tabKey(cm: {
  EditorSelection: typeof Selection
  indentMore: Command
  indentLess: Command
}): KeyBinding {
  return {
    key: 'Tab',
    run: (view) => {
      const { state } = view
      /* Tab does not edit a locked cell (a lecture, someone else's attempt, a
         finished class) — and does not hold on to it: the press goes to the
         browser, and focus moves on, as it should from non-editable text. */
      if (state.readOnly) return false
      // A selection is about whole lines, even if it lies within one.
      if (state.selection.ranges.some((range) => !range.empty)) return cm.indentMore(view)
      view.dispatch(
        state.changeByRange((range) => {
          const line = state.doc.lineAt(range.from)
          const insert = tabInsert(line.text.slice(0, range.from - line.from), state.tabSize)
          return {
            changes: { from: range.from, insert },
            range: cm.EditorSelection.cursor(range.from + insert.length),
          }
        }),
        { userEvent: 'input.indent', scrollIntoView: true },
      )
      return true
    },
    shift: cm.indentLess,
  }
}
