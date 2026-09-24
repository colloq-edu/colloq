/**
 * The room's tree, assembled from changes rather than sent whole.
 *
 * The file list used to be broadcast in full on every edit of the folder, and
 * everything edits it: the editor's autosave, `df.to_csv` in a cell,
 * `pip install` in the terminal. One new file cost a room of five hundred
 * people 3.0 MB (measured) — while one line out of two thousand changed.
 *
 * Exactly one rule lives here — how a change lands on the list; the server
 * computes it (server/src/workspace.ts · treeDelta). The tree order is
 * uniquely defined by its contents (depth-first walk, folders before files, by
 * name), so the surviving entries stand relative to each other as they stood
 * — and the order here is not recomputed but restored by inserting in place.
 *
 * Not a single rune: this is a pure function over a list, and it is checked
 * without a browser (tests/files-delta.test.mts).
 */
import type { FileEntry, FilesDelta } from '@shared/protocol'

/**
 * The list after a change.
 *
 * Three steps in this order and only this one: remove what left, replace what
 * changed, insert the new ones by ascending `at`. The indexes of new entries
 * are places in the FINISHED list, so inserting them before the removals
 * would mean counting places in a different list.
 *
 * A new array, not an in-place edit: the panel's runes read the list, and
 * changing it under them is a way of redrawing nothing.
 */
export function applyFilesDelta(files: readonly FileEntry[], delta: FilesDelta): FileEntry[] {
  const gone = new Set(delta.removed)
  const fresh = new Map<string, FileEntry>()
  for (const entry of delta.changed) fresh.set(entry.path, entry)
  const next: FileEntry[] = []
  for (const entry of files) {
    if (gone.has(entry.path)) continue
    next.push(fresh.get(entry.path) ?? entry)
  }
  // By ascending `at`: the server sends them in this order, but the frame comes
  // from the network, not from the next line, and there is no reason to take
  // its word for it here.
  const added = [...delta.added].sort((a, b) => a.at - b.at)
  for (const { at, entry } of added) {
    // A place past the end goes to the end: a delta that has drifted from the
    // list must not crash the panel. A gap in the numbers is caught earlier
    // (session.svelte.ts); this is the last line of defence.
    next.splice(Math.max(0, Math.min(at, next.length)), 0, entry)
  }
  return next
}
