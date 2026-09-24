/**
 * What the editor accepts when the sheet has a character ceiling.
 *
 * The ceiling is set on a student's own council attempt: the server does not
 * accept a snapshot over `MAX_ATTEMPT_CHARS`, which means the sheet silently
 * stops going out — the student has the long text on screen, the teacher has
 * the previous, short one in the stack.
 *
 * The rule is deliberately asymmetric. The ceiling does not forbid TYPING by
 * hand: someone who has written the attempt up to 9 012 characters sees the
 * counter "9 012 of 8 000" and decides for themselves what to cut — whereas an
 * editor that refuses to accept a letter reads as broken. PASTING is another
 * matter: it is one move of twelve thousand characters, after which the sheet
 * stops going out, and it has to be refused at that very moment and in words.
 *
 * Foreign frames (the way y-codemirror applies Y.Text edits — our SEED
 * included) never count as a paste: refusing them would pull the editor apart
 * from the document, and that is worse than any ceiling.
 */
export interface ChangeCheck {
  /** How many characters there will be if the edit is accepted. */
  chars: number
  /** The sheet's ceiling — or null if there is none here. */
  ceiling: number | null
  /** The edit is a paste or drag-and-drop, not typing or a foreign frame. */
  pasted: boolean
}

export function changeFits({ chars, ceiling, pasted }: ChangeCheck): boolean {
  if (ceiling === null || chars <= ceiling) return true
  return !pasted
}
