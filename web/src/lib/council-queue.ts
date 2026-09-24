/**
 * "You are 37th" — as a number, not as a whole sheet.
 *
 * The queue position moves for everyone waiting at every end of any kernel
 * job, and the server used to carry the whole sheet for it (`council:mine`):
 * with five hundred attempts, one finished run meant five hundred sheets, each
 * with the attempt's text, the task and the teacher's letters, for the sake of
 * one number. Now the number itself arrives (`council:queue`), and everything
 * that has to be done with it is here.
 *
 * Not a single rune: a pure edit of the sheets snapshot, checked without a
 * browser (tests/council-queue-bulk.test.mts).
 */
import type { CouncilMine } from '@shared/protocol'

/**
 * This cell's sheet — with a new queue position.
 *
 * `at === null` — the person is no longer in the queue: their attempt has
 * reached the kernel, and "computing now" is told by `run.state`, not by a
 * place in the queue.
 *
 * Only what actually changed is edited: the sheets snapshot is replaced whole
 * and wakes a redraw of every council card — on one's own cell that is the
 * editor under the author's hands. If it matches, the same object is
 * returned.
 *
 * No sheet for the cell — nowhere to put the number: the sheet will arrive in
 * its own frame and bring the number with it.
 */
export function withQueuePosition(
  mine: Record<string, CouncilMine>,
  cellId: string,
  at: number | null,
): Record<string, CouncilMine> {
  const sheet = mine[cellId]
  if (!sheet || sheet.queue === at) return mine
  return { ...mine, [cellId]: { ...sheet, queue: at } }
}
