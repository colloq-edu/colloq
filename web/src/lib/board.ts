/**
 * What the file list proves about the shared screen, and what it does not.
 *
 * The room watches one document together — the board, which is also the
 * lecture — and it can only be switched off for everyone at once. So the
 * decision "the document is gone" costs more than usual: it throws the hall out
 * of the lecture into an empty centre, unties "Following Anna" and leaves a
 * latecomer without the thing being talked about.
 *
 * It may be made from the file list only when the list is COMPLETE. The folder
 * walk on the server hits a ceiling (server/src/workspace.ts · MAX_ENTRIES),
 * and a truncated list means "I did not list everything", not "this file does
 * not exist". The difference cost a lecture: a student unpacks a dataset of
 * three thousand images, `slides/lecture.pdf` does not fit into the walk — and
 * the board goes dark for everyone, although it is still there on the server.
 * For a latecomer this happens a millisecond after entering: the welcome batch
 * sends `board`, and right after it `files`.
 *
 * The server has already fixed the same mistake on its side —
 * `forgetMissingBoard` in control.ts asks about the path itself (`statPath`)
 * instead of looking for it in the tree — and announces a real disappearance
 * in a separate `board` frame. What stays here is a safety net for when the
 * file was removed bypassing that path.
 */
import type { FileEntry } from '@shared/protocol'

/**
 * Whether the document has vanished from the shared screen — by this file
 * list.
 *
 * @param board  the path the room is watching now, or `null`.
 * @param files  the file list from a `files` frame (or a `/files` response).
 * @param truncated  the list is not shown in full: the walk hit the ceiling.
 */
export function boardGone(
  board: string | null,
  files: readonly FileEntry[],
  truncated: boolean,
): boolean {
  if (!board) return false
  // "Did not list everything" is no evidence. Stay quiet and wait for a `board` frame.
  if (truncated) return false
  return !files.some((file) => !file.dir && file.path === board)
}
