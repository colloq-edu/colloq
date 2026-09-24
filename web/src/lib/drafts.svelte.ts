/**
 * What a person has already typed but not yet sent.
 *
 * Panels mount and unmount along with their buttons: close the terminal — and
 * half of a typed command is gone together with the up-arrow history; collapse
 * the oracle to look at the cell you are asking about — and the question is
 * wiped. All of this is a component's local state, and it lives exactly as
 * long as the component.
 *
 * Drafts move here — into a module that lives with the tab, not with the
 * panel. They do not belong in the document: this is not shared work but one
 * person's unfinished line, and nobody asks for it to be restored after a
 * reload.
 */

/** The terminal command plus the personal up-arrow history. */
export const terminalDraft = $state({
  command: '',
  /** Only one's own commands: a shared history across the room would be unreadable. */
  history: [] as string[],
  /** −1 — the live line; otherwise the position in the history. */
  at: -1,
  /** The line set aside when paging through the history began. */
  stashed: '',
})

/** The question to the oracle. */
export const oracleDraft = $state({ question: '' })
