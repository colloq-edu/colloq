/**
 * The room's marks — the list and the assignment rule — moved to
 * shared/marks.ts.
 *
 * Not out of a taste for shared folders: the server became the judge of
 * uniqueness (it swaps a taken mark for a free one on entry,
 * routes/sessions.ts · `/join`), and it has nothing to choose from except this
 * very list. While the list lived only here, a second copy could come from
 * nowhere but being written on the server, and then two forty-line emoji
 * tables would drift apart silently: the server would hand out an animal the
 * browser does not draw at all (see `isMark`).
 *
 * The names stay the same, so that the sign-in screen, the person's picture
 * and the mark picker keep asking their neighbour for them, not the shared
 * folder.
 */
import { tr } from '@shared/i18n'
import { MARKS as sourceMarks, markName as sourceMarkName } from '@shared/marks'
export { freeMark, isMark, type Mark, type MarkSet } from '@shared/marks'
/** Labels are getters so an open picker follows the instance language. */
export const MARKS = sourceMarks.map(entry => ({
  mark: entry.mark,
  get name() { return tr('room.mark.' + entry.name) },
  get alt() { return [entry.name, entry.alt, entry.name === 'sauropod' || entry.name === 'T. rex' ? 'динозавр' : ''].filter(Boolean).join(' ') },
}))
export function markName(mark: string | null): string { return tr('room.mark.' + sourceMarkName(mark)) }
