/**
 * An oracle answer — text in which people are named.
 *
 * How exactly they are named is up to the instance. By default the model gets
 * REAL NAMES, and it writes "Anna Belova's run is failing"; with the "Student
 * names in model requests" setting turned off it sees the labels S1…SN and
 * writes "S7". Here there is no difference between these cases at all: the
 * server sent a `people` dictionary — the label that stood IN THE FRAME →
 * participantId — and exactly its keys must be highlighted, whatever they are.
 * The console draws a chip in their place that opens the work.
 *
 * A separate file with not a single import, because this breaks silently. A
 * naive `text.replaceAll('S7', …)` would eat the `S7` inside `CSS7`, and turn
 * the `S7` inside `S70` into a different person: a class of seventy is common,
 * and the teacher would open the wrong work without noticing. With names it is
 * the same and worse: "Anna" inside "Anna Belova" would highlight half of
 * someone else's name and lead to a namesake.
 *
 * Hence two rules, and both are mandatory.
 *
 * LONG BEFORE SHORT. "Anna Belova" is checked before "Anna", otherwise in a
 * class with two Annas the chip lands on the first word of someone else's
 * name. The label "S10" goes before "S1" for the same reason.
 *
 * WORD BOUNDARIES ARE COUNTED BY LETTERS OF ANY ALPHABET. `\b` in JS knows only
 * Latin: for "Аня" it sees a boundary where there is none, and vice versa. So
 * boundaries are checked by hand — the character on the left and on the right
 * must not be a letter, a digit or an underscore.
 *
 * And a third one, about what is not here: a label that is not in this
 * answer's dictionary stays plain text. The numbering and the roster live for
 * exactly one question, and a label from the answer before last must not
 * pretend to be today's.
 */

/** A piece of the answer: either text as it is, or a person who can be opened. */
export type AnswerPiece =
  | { kind: 'text'; text: string }
  | { kind: 'person'; label: string; participantId: string }

/** A letter, a digit or an underscore — any alphabet, not only Latin. */
const WORD = /[\p{L}\p{N}_]/u

function wordAt(text: string, at: number): boolean {
  return at >= 0 && at < text.length && WORD.test(text[at])
}

/**
 * Split an answer into text and people. Empty text — an empty list; text
 * without known labels — one whole piece (the replacement must not cut a
 * paragraph into parts where there is nothing to draw anyway).
 */
export function splitAnswer(text: string, people: Record<string, string>): AnswerPiece[] {
  if (!text) return []
  // Long before short — the only order in which "Anna Belova" does not turn
  // into "Anna" plus a tail.
  const labels = Object.keys(people)
    .filter((label) => label.length > 0)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
  if (labels.length === 0) return [{ kind: 'text', text }]

  const pieces: AnswerPiece[] = []
  let at = 0
  let scan = 0
  while (scan < text.length) {
    // A label starts only where the previous word has ended: there is nothing
    // to look for inside `CSS7` or `Марианна`.
    if (wordAt(text, scan - 1)) {
      scan += 1
      continue
    }
    const found = labels.find(
      (label) => text.startsWith(label, scan) && !wordAt(text, scan + label.length),
    )
    if (found === undefined) {
      scan += 1
      continue
    }
    if (scan > at) pieces.push({ kind: 'text', text: text.slice(at, scan) })
    pieces.push({ kind: 'person', label: found, participantId: people[found] })
    scan += found.length
    at = scan
  }
  if (at < text.length) pieces.push({ kind: 'text', text: text.slice(at) })
  return pieces
}
