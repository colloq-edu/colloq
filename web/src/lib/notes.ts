/**
 * Which terminal lines count as news the room has not read.
 *
 * The kernel writes its out-of-band news into the shared transcript — why a Run
 * All stopped, who restarted the kernel and that every variable went with it,
 * that the kernel did not come back. The transcript lives in a drawer that
 * starts closed, so a room that pressed Run All and watched it stop at cell 5
 * had the reason on file and nothing on screen saying so.
 *
 * The rule is three conditions and each one was learned the hard way, so it
 * lives here rather than inside the observer where it cannot be tested.
 */

/** A terminal line, as much of one as this decision needs. */
export interface NoteLine {
  kind?: unknown
}

export interface NoteContext {
  /** Somebody is looking at the transcript right now. */
  open: boolean
  /**
   * The server has handed over what it already had.
   *
   * Before this, every line the room has ever seen replays through the same
   * observer. Counting those told a student arriving on Tuesday that there were
   * nine things to read, all of them from last week's seminar.
   */
  synced: boolean
}

export function countsAsUnread(line: NoteLine, context: NoteContext): boolean {
  if (context.open || !context.synced) return false
  // Only the kernel's own notes. A classmate's `pip install` is news to nobody:
  // the person who typed it is watching it, and its output follows it down the
  // transcript. The mark is worth something only while it stays rare.
  return line.kind === 'system'
}
