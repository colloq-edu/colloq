/**
 * Trimming a traceback down to the part that is not already on screen.
 *
 * A Jupyter traceback opens with "Ename    Traceback (most recent call last)"
 * and closes with "Ename: evalue" — and both are already drawn, styled, as the
 * headline above it. Printed as they arrive, the room reads the same sentence
 * three times at the moment it most wants one.
 *
 * Only an exact echo is dropped. A traceback that says anything else keeps
 * every line: guessing at what is redundant is how the useful line goes.
 *
 * Kept out of the component so it can be tested — what it removes is the
 * difference between reading one error and reading it three times.
 */
import { stripAnsi } from './ansi'

const BANNER = /Traceback \(most recent call last\)/
/** Jupyter opens a traceback with a rule of dashes, above the banner. */
const RULE = /^[-\u2500\u2014]{3,}$/

export function withoutEcho(lines: string[], ename: string, evalue: string): string {
  const bare = (line: string) => stripAnsi(line).trim()
  const kept = [...lines]

  /*
   * The opening is two lines, not one: a rule, then "Ename  Traceback (most
   * recent call last)". Written against a hand-made sample this looked like one
   * line, so a real traceback kept both and the room read the error name three
   * times over — headline, banner, closing echo — with a row of dashes between
   * the first two. Only drop the rule when the banner really is under it.
   */
  if (kept.length > 1 && RULE.test(bare(kept[0])) && BANNER.test(bare(kept[1]))) kept.shift()
  const first = kept.length > 0 ? bare(kept[0]) : ''
  if (first.startsWith(ename) && BANNER.test(first)) kept.shift()

  const dropTrailingBlanks = () => {
    while (kept.length > 0 && bare(kept[kept.length - 1]) === '') kept.pop()
  }
  dropTrailingBlanks()
  // `KeyboardInterrupt: ` — an error with no value still closes with the colon.
  const echoes = evalue ? [`${ename}: ${evalue}`] : [ename, `${ename}:`]
  if (kept.length > 0 && echoes.includes(bare(kept[kept.length - 1]))) kept.pop()
  dropTrailingBlanks()

  return kept.join('\n')
}
