/**
 * The publication's notebook as an .ipynb file.
 *
 * The only way to take the code away whole: the room has no export at all,
 * and selecting across several cells with the mouse is impossible, since each
 * is a separate CodeMirror editor.
 *
 * The named step is served, and without a number the last one, that is, the
 * notebook as of publication. Outputs are not put into the file: a notebook
 * without them opens anywhere and weighs kilobytes, with them it is megabytes
 * of base64 in a file the student takes home to run again, and the first
 * thing they do is press "Run" anyway.
 */
import { writeIpynb } from '@shared/ipynb'
import type { PublicCell } from '@shared/publish'
import { readStep, stepHeadings } from './store.js'

/**
 * A notebook from cells already read, as an .ipynb file.
 *
 * The file itself is written by the shared `writeIpynb` (shared/ipynb.ts), the
 * same one the room uses to project its notebooks to disk. A second copy of
 * the same format used to remain here, and it had already diverged from the
 * first: only it had a cell `id`, while both declared schema 4.5. They would
 * have kept diverging, silently, because the error in such a file would be
 * seen not by whoever wrote it but by the student who opened it at home.
 */
export function notebookFrom(cells: PublicCell[]): string {
  return writeIpynb(cells.map((cell) => ({ id: cell.id, type: cell.type, source: cell.source })))
}

export function notebookOf(pub: string): string {
  return notebookOfStep(pub, null)
}

/**
 * The notebook of the named step, or of the last one if no step was named.
 *
 * There was one link on the page for all steps, while the reader on it is on
 * their own step: someone comparing "before" and "after" on step 2 of 5 took
 * away the state of step 5. Now the page sends its number in `?step=`
 * (ReaderScreen.svelte, the "Download notebook" link). An unknown number
 * answers with the last step rather than with nothing: a download is not the
 * place to explain addresses to a person, and `notebookOf` never asked about
 * that either.
 */
export function notebookOfStep(pub: string, seq: number | null): string {
  const headings = stepHeadings(pub)
  const wanted = seq !== null && headings.some((h) => h.seq === seq) ? seq : headings.at(-1)?.seq
  const step = wanted === undefined ? null : readStep(pub, wanted)
  return notebookFrom(step?.cells ?? [])
}
