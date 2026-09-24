/**
 * Line diff, longest-common-subsequence.
 *
 * One implementation for both ends. The history panel draws it from what the
 * server computed; the oracle's proposed edit is drawn in the browser before
 * anything is written. If those two disagreed about what changed, the same
 * change would look like two different changes depending on where you read it.
 *
 * The alternative, a character diff, reads worse for code: a changed argument
 * shows as a scatter of insertions inside a line instead of as the line that
 * changed.
 *
 * Cells are short — tens of lines — and on them a quadratic table costs
 * nothing. But a cell can also receive a fifteen-thousand-line log, and the
 * comparison runs synchronously in the history request handler: measured on
 * this code, ten thousand lines against ten thousand give seconds of blocking
 * and hundreds of megabytes of heap, that is, the whole instance stands still
 * while somebody scrolls the timeline. Hence two safeguards here. The common
 * head and tail are cut off up front, so an edit of one line in a long log
 * stays a comparison of one line. And what remains has an area cap: above it
 * the difference is shown as a replacement of the whole chunk — coarser, but
 * in a single pass.
 */

export type DiffKind = 'same' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffKind
  text: string
}

/**
 * The table area above which no line-by-line comparison is computed.
 *
 * Four million cells is tens of milliseconds and sixteen megabytes
 * (Int32Array rather than an array of numbers, precisely for the sake of the
 * second number). A request handler can afford that much; anything larger is
 * no longer a comparison of a cell but a comparison of two logs, and nobody
 * reads that line by line.
 */
const MAX_TABLE = 4_000_000

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split('\n')
  const b = after.length === 0 ? [] : after.split('\n')

  // The common head and common tail match line for line — they need no table.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const out: DiffLine[] = []
  for (let i = 0; i < head; i++) out.push({ kind: 'same', text: a[i] })
  for (const line of middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail))) {
    out.push(line)
  }
  for (let i = a.length - tail; i < a.length; i++) out.push({ kind: 'same', text: a[i] })
  return out
}

/** The part that actually differs, by longest common subsequence. */
function middle(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = []
  if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) > MAX_TABLE) {
    for (const text of a) out.push({ kind: 'removed', text })
    for (const text of b) out.push({ kind: 'added', text })
    return out
  }

  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i] })
      i++
    } else {
      out.push({ kind: 'added', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] })
  while (j < b.length) out.push({ kind: 'added', text: b[j++] })
  return out
}

/** How much a proposal actually changes, for a one-line summary beside it. */
export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'added') added++
    else if (line.kind === 'removed') removed++
  }
  return { added, removed }
}
