/**
 * Laying highlighted code out in lines.
 *
 * The parsing happens in the browser — it needs CodeMirror's grammar and the
 * editor's own style table, both of which arrive in a lazy chunk (see
 * syntax.svelte.ts). What is here is everything that does not: turning a flat
 * list of styled ranges into rows, and dealing those rows out along a diff.
 *
 * That is the half where the bugs are. A styled range can cross a newline — a
 * docstring, a call broken over three lines — and the gaps between ranges are
 * ordinary code that has to be emitted too or the text comes out with holes in
 * it. Keeping it out of the browser-only module is what makes it testable.
 */
import type { DiffLine } from '@shared/diff'

/** One run of characters that share a style. `cls` is empty for plain text. */
export interface Token {
  text: string
  cls: string
}

/** A styled span of the source, as the highlighter reports it. */
export interface Range {
  from: number
  to: number
  cls: string
}

export interface Syntax {
  /**
   * Highlight a whole program, returning one token list per line.
   *
   * Per line, not one flat list, because that is what both callers want: a code
   * block stacks them, and a diff puts each on a row with a gutter and a tint.
   *
   * The whole text is parsed at once even when only some lines are wanted:
   * Python is not a line-at-a-time language, and a triple-quoted string handed
   * to a parser one line at a time is three lines of syntax errors.
   */
  lines: (code: string) => Token[][]
}

/** A line of unhighlighted code, shaped like a highlighted one. */
export function plain(text: string): Token[] {
  return text ? [{ text, cls: '' }] : []
}

/**
 * Cut `code` into lines and fill them with the styled ranges.
 *
 * Ranges are expected in order and may leave gaps; the gaps are code too, and
 * are emitted unstyled. Anything past the last range is emitted the same way.
 */
export function spread(code: string, ranges: readonly Range[]): Token[][] {
  const source = code.split('\n')
  const out: Token[][] = source.map(() => [])
  // Where each line begins in the flat text, so an offset can be turned into a
  // line and a column without searching for the newline before it.
  const starts: number[] = []
  let at = 0
  for (const line of source) {
    starts.push(at)
    at += line.length + 1
  }

  const put = (from: number, to: number, cls: string) => {
    if (to <= from) return
    let line = lineAt(starts, from)
    while (line < source.length) {
      const lineStart = starts[line]
      const lineEnd = lineStart + source[line].length
      const sliceFrom = Math.max(from, lineStart)
      const sliceTo = Math.min(to, lineEnd)
      if (sliceTo > sliceFrom) {
        out[line].push({ text: source[line].slice(sliceFrom - lineStart, sliceTo - lineStart), cls })
      }
      if (to <= lineEnd) break
      line++
    }
  }

  let cursor = 0
  for (const range of ranges) {
    put(cursor, range.from, '')
    put(range.from, range.to, range.cls)
    cursor = Math.max(cursor, range.to)
  }
  put(cursor, code.length, '')
  return out
}

/** Which line an offset falls on. Binary search: a long cell is a thousand lines. */
export function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * Highlight the two sides of a diff and lay the result out along its rows.
 *
 * Each side is parsed whole and then dealt out line by line, rather than each
 * row being parsed on its own. A diff row is a line taken out of its program: a
 * lone `    return 1` parses as an indentation error, and one line of a
 * docstring parses as an unterminated string. Highlighting rows separately made
 * exactly the lines a reader cares about — the changed ones — the lines that
 * came out wrong.
 *
 * `removed` rows come from the old text and `added` from the new; `same` may be
 * taken from either and consumes a line of both.
 */
export function diffTokens(
  lines: readonly DiffLine[],
  before: string,
  after: string,
  ready: Syntax | null,
): Token[][] {
  if (!ready) return lines.map((line) => plain(line.text))
  const old = ready.lines(before)
  const now = ready.lines(after)
  let bi = 0
  let ai = 0
  return lines.map((line) => {
    if (line.kind === 'removed') return old[bi++] ?? plain(line.text)
    if (line.kind === 'added') return now[ai++] ?? plain(line.text)
    bi++
    return now[ai++] ?? plain(line.text)
  })
}
