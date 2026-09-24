/**
 * A command palette row and the rule by which rows are found.
 *
 * Kept apart from the component because the part that breaks silently is
 * precisely the filtering: a person types "03 imp", expects the third cell with
 * the imports — and gets nothing if the words are searched as one substring; or
 * gets it eighth if "Run all" does not end up above "Stop execution" for the
 * query "run". Neither shows up in any type.
 */

export interface PaletteItem {
  /** Unique key of the row. */
  id: string
  /** Section: "Cells", "Files", "Room". Drawn as the group heading. */
  group: string
  /** What the person reads. */
  label: string
  /** Right column: cell number, key shortcut, state. */
  hint?: string
  /** Words the row can be found by, besides `label`. */
  keywords?: string
  run: () => void
}

/**
 * Filtering is by words, not by a single substring.
 *
 * A person types what they remember, and they remember it in fragments: "03
 * imp", "file mod", "oracle". Every word has to be found somewhere in the row —
 * in the label, the hint, the keywords or the section name — and word order
 * does not matter.
 *
 * Order of the result: first those whose label STARTS with the first word, then
 * those where it is inside the label, then the rest (found by the hint or the
 * section). Within a rank, the original order: it carries meaning (cells follow
 * the notebook, actions follow importance), and there is nothing to re-sort it
 * by.
 */
export function matchItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  const scored: { item: PaletteItem; rank: number; at: number }[] = []
  items.forEach((item, at) => {
    const hay =
      `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''} ${item.group}`.toLowerCase()
    if (!words.every((word) => hay.includes(word))) return
    const head = item.label.toLowerCase()
    scored.push({ item, at, rank: head.startsWith(words[0]) ? 0 : head.includes(words[0]) ? 1 : 2 })
  })
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at)
  return scored.map((entry) => entry.item)
}

/**
 * A section heading — only where the section changes.
 *
 * After filtering, the groups get mixed up, and printing "Cells" above every
 * row would mean drawing a list with twice as many headings as rows.
 */
export function groupHeads(items: readonly PaletteItem[]): (string | null)[] {
  let last: string | null = null
  return items.map((item) => {
    const head = item.group === last ? null : item.group
    last = item.group
    return head
  })
}
