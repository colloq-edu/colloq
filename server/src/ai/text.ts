import { tr } from '@shared/i18n'
/**
 * Words and clipping — shared by everything the oracle writes and reads.
 *
 * Nothing is decided here: these are four small things that lay around two or
 * three times over in `index.ts`, `agent.ts`, `council.ts`, `context.ts` and
 * `routes/ai.ts` and had already drifted apart in the details. The Russian
 * plural was written in four different ways (one of them handled 11–14
 * separately), `clip` in one place counted the marker within the budget and in
 * another on top of it, and the clipped piece came out longer than the
 * declared ceiling. There is one rule, so there should be one copy too: the
 * next edit lands in every place at once, not in one of three.
 *
 * Lives in server/src/ai/, not in shared: prompt clipping is needed exactly
 * here, and dragging it into the browser would be worse than leaving it next
 * to what calls it. The declension rule itself comes from shared: both the tab
 * and the static pages read it, and it must not have a second copy.
 */
import { plural } from '@shared/plural'
import type { ReasoningEffort } from '@shared/admin'

/**
 * "одну секунду, две секунды, пять секунд" (one second, two seconds, five
 * seconds): one rule for every counting word.
 *
 * Re-exported so that the oracle's counting words sit next to the rest of its
 * words and are called from one place.
 */
export { plural }

/**
 * A line for the system frame matching the chosen reasoning level.
 *
 * "Instant" is not only a provider parameter: half of the models have no
 * reasoning knob at all, and some (DeepSeek R1 and its kin) have one that
 * cannot be switched off — they will think in any case. Asking in words works
 * on all of them and gives what this knob was asked for: a short answer without
 * three paragraphs of "let's work through this".
 *
 * "Normal" adds NOTHING — neither a field nor a line: the frame stays exactly
 * what it was. "Thorough" stays silent too: asking a model in words to think is
 * pointless, the parameter does that, and a "think longer" line would only eat
 * space.
 */
export function effortNote(effort: ReasoningEffort | undefined): string {
  return effort === 'instant' ? tr('server.ai.instantNote') : ''
}

/** "22 seconds": the number and the word that goes with it. */
export function seconds(n: number): string {
  return tr('server.seconds', { count: n })
}

/**
 * "3 человека" (3 people): for "человек" the genitive plural equals the
 * nominative, and that is not a typo.
 */
export function people(n: number): string {
  return tr('server.people', { count: n })
}

/** "1 группа", "3 группы", "5 групп" (group forms) — without the number: it is put alongside. */
export function groupsWord(n: number): string {
  return tr('server.groupsWord', { count: n })
}

/** "1 ячейка", "3 ячейки", "5 ячеек" (cell forms): a count that does not jar the eye. */
export function cellsWord(n: number): string {
  return tr('server.cellsWord', { count: n })
}

/** 01, 02, 03 — the same number that is drawn next to the cell in the left margin. */
export function pad(no: number): string {
  return String(no).padStart(2, '0')
}

/** The default marker is in English: the header of the model's frame names the same one. */
const TRUNCATED = (dropped: number) => `\n… truncated ${dropped} chars …\n`

/**
 * Keep the opening and the ending, say what went missing in between.
 *
 * The marker counts against the limit rather than being added on top of it: a
 * budget that the sentence explaining the budget pushes you over is not a
 * budget, and a teacher who sets contextChars to fit a small model's window
 * means the number they typed. Two passes because the marker's own length
 * depends on the figure it carries.
 *
 * The figure stays what was actually dropped: it is derived from the lengths
 * actually kept rather than from the limit.
 *
 * `mark` — because the question frame is written in English and the council
 * summary frame in Russian, and the model reads what surrounds it. The clipping
 * rule is still one: the summary used to cut 70/30 and put the marker ON TOP of
 * the budget, that is, it handed over more than it was allotted.
 */
export function clip(
  text: string,
  limit: number,
  mark: (dropped: number) => string = TRUNCATED,
): string {
  if (text.length <= limit) return text

  let room = Math.max(0, limit - mark(text.length).length)
  let head = Math.ceil(room * 0.65)
  let dropped = text.length - room
  room = Math.max(0, limit - mark(dropped).length)
  head = Math.ceil(room * 0.65)
  const tail = room - head
  dropped = text.length - head - tail

  const out = `${text.slice(0, head).trimEnd()}${mark(dropped)}${text.slice(text.length - tail).trimStart()}`
  // trimEnd/trimStart only ever shorten it; the guard is for a limit so small
  // that the marker alone does not fit.
  return out.length <= limit ? out : out.slice(0, limit)
}

/** One line in full, or its beginning with an ellipsis. Leaves line breaks alone. */
export function clipLine(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/** Multi-line into one line: a traceback in a group chip only reads this way. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * An error in words. `fallback` is for what is not an Error at all: in the
 * oracle feed such a thing is shown as is, while in an agent turn a Russian
 * phrase stands in its place, because the room reads it.
 */
export function describe(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message.trim()
  return fallback ?? String(err)
}
