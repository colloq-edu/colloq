/**
 * Keys that change the notebook's MAKE-UP — and why they do it reluctantly.
 *
 * Backspace on an emptied cell deletes it for the whole room, with no history
 * and no confirmation. That is sensible exactly once — as the last stroke of a
 * deliberate erase — and not sensible at all as a side effect of holding the
 * key down.
 */

export interface BackspaceInput {
  /** The cell's document is empty BEFORE this keypress. */
  empty: boolean
  /** This is auto-repeat of a held key, not a separate keypress. */
  repeat: boolean
}

/**
 * Whether this Backspace deletes the cell.
 *
 * On auto-repeat it does not, and that "no" is load-bearing. The binding used
 * to fire on every keydown: the moment the document went empty, the next repeat
 * (~30 ms later) took the cell out of the shared notebook, focus moved
 * synchronously to the previous one — CodeMirror restores its last cursor — and
 * the remaining repeats erased ITS tail and, once it was empty, deleted it as
 * well. Someone holding Backspace to erase `print(x)` lost one or two other
 * people's cells along with their output and could not tell what had happened;
 * Ctrl+Z exists only in command mode, and only for that same person.
 */
export function backspaceRemovesCell(input: BackspaceInput): boolean {
  return input.empty && !input.repeat
}

/**
 * And the second half: empty text is not yet an empty cell.
 *
 * The output stays underneath: a plot, a table, a traceback — the very reason
 * the cell is kept. Deleting takes it away from the whole room with nothing to
 * bring it back, and the gesture that led here is erasing the last letter, not
 * a decision. Such a cell can still be removed with the trash can in the
 * toolbar or by pressing `d` twice — and both places say so.
 */
export function emptyCellIsRemovable(outputs: number): boolean {
  return outputs === 0
}
