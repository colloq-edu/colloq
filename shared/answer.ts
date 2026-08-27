/**
 * Taking an answer apart into the pieces the panel draws separately.
 *
 * The oracle answers in markdown, and one part of that markdown is not prose:
 * a fenced block is code, and code in a seminar is something people copy, run,
 * and put into a cell. Rendering it as another paragraph — which is what
 * markdown-to-HTML does — throws away the only thing about it that matters.
 *
 * So the answer is split before it is rendered. Prose goes to the markdown
 * renderer as it always did; each block comes back as itself, with its language
 * and with the fact of whether its closing fence has arrived yet.
 *
 * That last flag is the streaming case and it is not an edge case: for most of
 * the seconds a block is on screen it is half-written, and half a block must
 * not be offered for copying into a cell.
 */

export type AnswerPart =
  | { kind: 'prose'; text: string }
  | {
      kind: 'code'
      /** The fence's info string, lowercased. Empty when the fence carried none. */
      lang: string
      code: string
      /** False while the closing fence has not arrived — the model is still typing. */
      closed: boolean
    }

/** A fence line: ``` optionally followed by a language, and nothing else. */
const FENCE = /^\s*```(.*)$/

/**
 * Split an answer into prose and code, in order.
 *
 * Line-based rather than one regular expression over the whole text, because
 * the streaming case has no closing fence to match against and a regex that
 * cannot see the end of a block cannot report one. Whitespace-only prose is
 * dropped: it exists only as the blank line markdown needs between a paragraph
 * and a fence, and drawing it would put a gap in the answer that nobody wrote.
 */
export function splitAnswer(answer: string): AnswerPart[] {
  const parts: AnswerPart[] = []
  let prose: string[] = []
  let code: string[] | null = null
  let lang = ''

  const flushProse = () => {
    const text = prose.join('\n')
    if (text.trim()) parts.push({ kind: 'prose', text })
    prose = []
  }

  for (const line of answer.split('\n')) {
    const fence = FENCE.exec(line)
    if (code === null) {
      if (fence) {
        flushProse()
        code = []
        lang = fence[1].trim().toLowerCase()
      } else {
        prose.push(line)
      }
      continue
    }
    // Inside a block, only a bare fence closes it — a line reading ```python
    // inside python is not a thing, and treating it as a close would split one
    // block into two halves that each look complete.
    if (fence && !fence[1].trim()) {
      parts.push({ kind: 'code', lang, code: code.join('\n'), closed: true })
      code = null
      continue
    }
    code.push(line)
  }

  if (code !== null) {
    parts.push({ kind: 'code', lang, code: code.join('\n'), closed: false })
  } else {
    flushProse()
  }

  // An empty block is what a model writes when it opens a fence and closes it
  // with nothing between; there is nothing to draw and nothing to copy.
  return parts.filter((part) => part.kind === 'prose' || part.code.trim() !== '')
}

/**
 * Which fences may be taken as a cell's new source, by what kind of cell it is.
 *
 * Both sets include the untagged fence, and that is not laziness: a model asked
 * for "the complete new source" writes ``` far more often than it writes
 * ```python, and refusing an untagged block would throw away most of the
 * proposals a room ever sees. The tags either side of it are there so a
 * correctly-labelled block is never mistaken for the wrong kind — a ```python
 * block in an answer about a text cell is an example, not the cell.
 */
const FENCES: Record<CellKind, ReadonlySet<string>> = {
  code: new Set(['', 'python', 'py', 'python3']),
  markdown: new Set(['', 'markdown', 'md', 'text']),
}

/** What sort of cell a patch is for. Mirrors CellType in shared/notebook. */
export type CellKind = 'code' | 'markdown'

/**
 * The last fenced block in an answer, which is the proposed cell.
 *
 * The last rather than the first: a model that shows the broken line before the
 * corrected one puts the answer second, and the prompt asks for exactly one
 * block precisely so this is unambiguous when it obeys.
 *
 * `kind` decides which fences count. Without it this function knew only about
 * Python, so asking the oracle to rewrite a TEXT cell produced an answer with
 * nothing the interface could apply: the request went out, the reply landed in
 * the thread, and no proposal ever appeared under the cell. From the room's
 * side that read as the feature being for code cells only.
 *
 * Returns null when there is no block at all, which is a real outcome — "your
 * cell is already right" is a legitimate reply to a request to change it, and
 * inventing a patch out of prose would be the model saying nothing and the
 * interface offering to apply it. Also null for a block whose closing fence
 * never arrived, because that is a stopped generation and applying half of one
 * would break the cell it claims to fix.
 */
export function lastCodeBlock(answer: string, kind: CellKind = 'code'): string | null {
  const allowed = FENCES[kind]
  let found: string | null = null
  for (const part of splitAnswer(answer)) {
    if (part.kind !== 'code' || !part.closed || !allowed.has(part.lang)) continue
    found = part.code
  }
  if (found === null) return null
  // Trailing whitespace only: leading whitespace can be meaningful indentation
  // in a block that starts inside a function body.
  const code = found.replace(/\s+$/, '')
  return code.length > 0 ? code : null
}
