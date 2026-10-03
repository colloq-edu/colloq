/**
 * Which document the speaker-notes editor is open on, if any.
 *
 * Module state, not a prop chain: the editor is opened from three places
 * that know nothing of each other (the PDF reader's bar, the lecture bar, the
 * audience strip of a teacher who is not leading), and it is drawn once, over
 * the whole room, by the room screen. A prop threaded through all of them
 * would be three more places to forget it.
 */

interface Open {
  file: string
  /** The page to open on: where the person was looking when they asked. */
  page: number
}

let open = $state<Open | null>(null)

/** Open the editor on a document, at a page. */
export function openNotesEditor(file: string, page: number): void {
  open = { file, page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1 }
}

export function closeNotesEditor(): void {
  open = null
}

/** What is open right now. Reading it inside markup or `$derived` re-renders on change. */
export function notesEditor(): Open | null {
  return open
}
