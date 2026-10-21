/**
 * Fields in one row stand on one line, whatever their captions.
 *
 * 21 Oct 2026, the owner: on Resources the class memory and the cores stood
 * level, "but below them live kernels at most and stop after did not,
 * because the first phrase takes two lines", and the submissions' rate
 * during classes the same. A row of the panel's settings is a wrapping flex
 * (or a grid) of fields, each a caption over its box, and a caption that
 * wrapped pushed its own box a line below its neighbours'. The boxes beside
 * the fields — a note, the per-notebook estimate — were lowered 26 px by
 * hand, which held only while every caption beside them was one line.
 *
 * The rule, for each line of a row: every child is lowered by what its
 * caption lacks of the tallest caption in that line. The boxes then start on
 * one top, each caption sits right over its own box (as a table's headers
 * stand on their column, admin-table), and a child with no caption — a note,
 * an estimate, a box that carries its words beside it — starts on that top
 * too. A child alone in its line keeps its place: on a phone, where a row
 * becomes a column, nothing moves. Hints and errors under a box are below
 * the line and never move it.
 *
 * Measured, not written in CSS: subgrid shares a caption's height only
 * across a grid's fixed columns (the class form's where-it-runs block does
 * it that way, Resources.svelte · .pl-fields), and these rows wrap by their
 * fields' own widths, so which fields share a line is known only after
 * layout.
 *
 * A caption is a child's first element when it is in the panel's label
 * voice (.admin-label, index.css), or holds it beside a "was …" mark, and
 * the rest of the child stands below it: the GPU share's own word beside its
 * gauge is in that voice too, and it is no caption over a box. The action
 * owns the top margin of the row's children: give them none of their own.
 *
 * Framed fields (`use:levelFields={{ framed: true }}`) hold their caption
 * inside a frame of their own, the competition's limit tiles: the frames
 * already share a line and a height, so lowering a frame would push it out
 * of both. What stands under each caption, inside its frame, is lowered
 * instead, and owns its top margin the same way; the captions stay at the
 * frames' top, where a tile's caption stands.
 */

/** One child of a row, as measured with nothing lowered. */
export interface RowChild {
  /** Its top, px, in any frame shared by the row's children. */
  top: number
  /** How far below that top its box starts, px: its caption and the gap under it; 0 — no caption. */
  caption: number
}

/** Children whose tops differ by less than this share a line: layout rounds, it does not drift. */
const SAME_LINE_PX = 1

/** How far to lower each child, px: what its caption lacks of the tallest one in its line. */
export function lowering(children: readonly RowChild[]): number[] {
  const lines: Array<{ top: number; tallest: number }> = []
  const lineOf = children.map((child) => {
    let line = lines.find((one) => Math.abs(one.top - child.top) < SAME_LINE_PX)
    if (!line) {
      line = { top: child.top, tallest: 0 }
      lines.push(line)
    }
    line.tallest = Math.max(line.tallest, child.caption)
    return line
  })
  return children.map((child, i) => lineOf[i].tallest - child.caption)
}

/** How a row's fields are drawn, when not each a caption over its box. */
export interface FieldRowOptions {
  /** Each field is a frame holding its caption: what stands under the caption is lowered, not the frame. */
  framed?: boolean
}

/** A child's caption and the first shown element under it. */
interface Captioned {
  caption: HTMLElement
  under: HTMLElement
}

/** The child's caption, when its first element is in the caption voice and something is drawn after it. */
function captionedOf(child: HTMLElement): Captioned | null {
  const caption = child.firstElementChild
  if (!(caption instanceof HTMLElement)) return null
  if (!caption.matches('.admin-label') && !caption.querySelector(':scope > .admin-label')) return null
  let under = caption.nextElementSibling
  while (under && under.getClientRects().length === 0) under = under.nextElementSibling
  return under instanceof HTMLElement ? { caption, under } : null
}

/** How far below the child's top what stands under its caption starts, px; 0 — no caption over it. */
function captionHeight(child: HTMLElement, captioned: Captioned | null): number {
  if (!captioned) return 0
  const below = captioned.under.getBoundingClientRect().top
  // Beside the caption, not under it: a word in the caption voice on its own readout's line.
  if (below < captioned.caption.getBoundingClientRect().bottom) return 0
  return below - child.getBoundingClientRect().top
}

/**
 * `use:levelFields` on a row: its children stand level, now and whenever
 * the row reflows.
 *
 * A change inside the row (a "was …" mark beside a caption, the language, a
 * field shown or hidden) is levelled before the next paint: a mutation
 * observer runs as a microtask after the change, so a box never shows a
 * frame off its line while someone types beside it. A new width waits for
 * the next frame: levelling inside the resize observer's own callback would
 * resize the row it watches, which the browser reports as a loop.
 */
export function levelFields(row: HTMLElement, options: FieldRowOptions = {}): { destroy(): void } {
  let frame = 0
  /** The row left the page: a font still on its way schedules nothing. */
  let gone = false
  /** What the last pass lowered: each pass starts from the row as drawn, with nothing lowered. */
  let lowered: HTMLElement[] = []

  const level = (): void => {
    cancelAnimationFrame(frame)
    frame = 0
    for (const one of lowered) one.style.removeProperty('margin-top')
    lowered = []
    // Hidden children (display: none) have no line to stand on.
    const children = [...row.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.getClientRects().length > 0,
    )
    const captions = children.map(captionedOf)
    /*
     * Layout pixels, whatever an ancestor's transform is doing: the panel's
     * dialogs enter from 97 % of their size, and measured on that frame a
     * 20 px lowering came out 19.4 — and stayed, since a transform resizes
     * nothing to level again on.
     */
    const drawn = row.getBoundingClientRect().width
    const scale = drawn > 0 && row.offsetWidth > 0 ? drawn / row.offsetWidth : 1
    const heights = children.map((child, i) => captionHeight(child, captions[i]) / scale)
    const lower = lowering(children.map((child, i) => ({ top: child.getBoundingClientRect().top / scale, caption: heights[i] })))
    children.forEach((child, i) => {
      // In layout units (1/64 px): measured through a transform 2 365 px down
      // the page, 20 px reads 20.000000000000092.
      const px = Math.round(lower[i] * 64) / 64
      if (px <= 0) return
      // In a frame, what stands under the caption; a frame with no caption over its contents keeps them where they are.
      const moved = options.framed ? (heights[i] > 0 ? captions[i]?.under : null) : child
      if (!moved) return
      moved.style.setProperty('margin-top', `${px}px`)
      lowered.push(moved)
    })
  }

  const later = (): void => {
    if (!gone && !frame) frame = requestAnimationFrame(level)
  }

  level()
  const resized = new ResizeObserver(later)
  resized.observe(row)
  // Attributes are left out: the margins written above are attributes, and
  // watching them would level the row once more for every child it lowered.
  const changed = new MutationObserver(level)
  changed.observe(row, { childList: true, subtree: true, characterData: true })
  // A web font arriving rewraps captions without a mutation.
  void document.fonts?.ready.then(later)

  return {
    destroy() {
      gone = true
      cancelAnimationFrame(frame)
      resized.disconnect()
      changed.disconnect()
    },
  }
}
