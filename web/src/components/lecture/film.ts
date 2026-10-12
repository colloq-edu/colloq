/**
 * THE LECTURE AS THE CONSOLE LAYS IT OUT: the strip of thumbnails under the
 * slide, the ribbon of chips over the portrait rail, the "Pages" grid, the
 * sheet menu that hangs from them, and the words all of them use for a sheet;
 * and, since the palettes open over that ribbon in portrait, where a palette
 * must hold a touch itself (`uncovered`).
 *
 * WHY THIS EXISTS. Sheets used to be a pile after the deck, reachable through
 * a notch at the end of the page strip and counted from the ink. Nobody could
 * tell how many there were, where a sheet stood, or how to walk them. Now the
 * server keeps them in deck order (shared/lecture.ts · `lectureSequence`), and
 * the console shows that one order everywhere: the strip, the ribbon and the
 * grid list the same items, with a sheet where it was made, the slot for a
 * new one right after the page on screen, and "next" on the item the arrow
 * really goes to (walk.ts · `walkStep`).
 *
 * Pure arithmetic and words, no runes and no DOM:
 * tests/lecture-console-sheets.test.mts walks it.
 */
import { tr } from '@shared/i18n'
import type { InkStroke, SheetPaper } from '@shared/lecture'
import { PAPER_MARGIN } from './page-region'

/* ------------------------------------------------------------ items */

/** What stands at a place along the strip. */
export type FilmKind = 'slide' | 'sheet' | 'add'

/** One place along the strip, the ribbon or the grid. */
export interface FilmItem {
  kind: FilmKind
  /** The page (negative for a sheet); for the slot, the page it stands right after. */
  page: number
  /** The slide's number, or the sheet's place among the sheets counting from one; 0 for the slot. */
  n: number
  /** The page on the console's sheet now. */
  current: boolean
  /** The page "Next" goes to from here. */
  next: boolean
}

/**
 * The lecture's pages in walking order, with the slot for a new sheet right
 * after the page on screen.
 *
 * The slot stands exactly where "＋ Лист" puts the sheet (the server inserts
 * it right after the page the console names), so the strip shows the place
 * before the press. A page the sequence does not have (a sheet deleted a
 * moment ago, a slide past a deck that has not opened) is current nowhere and
 * gets no slot: there is no "right after" to show.
 */
export function filmItems(
  sequence: readonly number[],
  current: number,
  next: number | null,
  slot: boolean,
): FilmItem[] {
  const out: FilmItem[] = []
  let sheets = 0
  for (const page of sequence) {
    const sheet = page < 0
    if (sheet) sheets += 1
    const here = page === current
    out.push({
      kind: sheet ? 'sheet' : 'slide',
      page,
      n: sheet ? sheets : page,
      current: here,
      next: !here && page === next,
    })
    if (here && slot) out.push({ kind: 'add', page, n: 0, current: false, next: false })
  }
  return out
}

/* ------------------------------------------------------------ words */

/** What a thumbnail is called under it, and a chip on it: "14" for a slide, "Л1" for a sheet. */
export function itemMark(item: Pick<FilmItem, 'kind' | 'n'>): string {
  return item.kind === 'sheet' ? tr('room.ui.158', { p0: item.n }) : String(item.n)
}

/**
 * An item's name for a screen reader, and the handle the stands press it by:
 * "Слайд 14", "Лист 1". The slot has a name of its own (`room.pult4.newSheetHere`),
 * distinct from the rail key's "Новый лист": the stands press by the first
 * control with a name, and in portrait the ribbon comes before the rail.
 */
export function itemName(item: Pick<FilmItem, 'kind' | 'n'>): string {
  if (item.kind === 'add') return tr('room.pult4.newSheetHere')
  return item.kind === 'sheet'
    ? tr('room.prompter.sheetNo', { n: item.n })
    : tr('room.prompter.slideNo', { n: item.n })
}

/** The caption of the item "Next" goes to: "15 · дальше", "Л1 · дальше". */
export function nextMark(item: Pick<FilmItem, 'kind' | 'n'>): string {
  return tr('room.pult4.nextMark', { n: itemMark(item) })
}

/**
 * Where a sheet stands: "после слайда 14", or "перед первым слайдом" for one
 * started before the deck's first slide (`after` 0).
 */
export function afterWords(after: number): string {
  return after >= 1 ? tr('room.pult4.afterSlide', { n: after }) : tr('room.pult4.beforeFirst')
}

/**
 * A sheet in full, under its big "Л2": "лист 2 из 3 · после слайда 14". The
 * count is the sheets of the lecture, the place is in deck order: the same
 * words the laptop bar and the hall's screens use (`room.lecture4.sheetOf`).
 */
export function placeWords(place: { n: number; total: number }, after: number | null): string {
  const of = tr('room.lecture4.sheetOf', { n: place.n, total: place.total })
  return after === null ? of : `${of} · ${afterWords(after)}`
}

/**
 * A heading with the lecture's size: "Лента · 50 слайдов · 3 листа",
 * "Страницы · 50 слайдов". Sheets are named only when there are some: "0
 * листов" under every deck would be a count of nothing.
 */
export function deckTitle(head: string, slides: number, sheets: number): string {
  const parts = [head]
  if (slides > 0) parts.push(tr('room.notesEditor.slides', { count: slides }))
  if (sheets > 0) parts.push(tr('room.pult4.sheetsCount', { count: sheets }))
  return parts.join(' · ')
}

/**
 * The question before a sheet goes: it names the sheet and what goes with it.
 * An empty sheet goes without regret ("Удалить пустой лист 2?"); "and its 14
 * strokes" makes one look twice before the derivation of the half hour is
 * gone for the whole hall.
 */
export function dropQuestion(n: number, strokes: number): string {
  return strokes > 0
    ? tr('room.pult4.dropAsk', { n, count: strokes })
    : tr('room.pult4.dropEmpty', { n })
}

/* ----------------------------------------------------------- strokes */

/**
 * How many strokes are on a page, as a person counts them: pieces of one
 * long motion of the pen (a stroke carried on past its point ceiling under a
 * new id, `group`) are one stroke, as Undo takes them back in one press.
 */
export function strokesOn(
  ink: readonly Pick<InkStroke, 'id' | 'page' | 'group'>[],
  page: number,
): number {
  const seen = new Set<string>()
  for (const stroke of ink) if (stroke.page === page) seen.add(stroke.group ?? stroke.id)
  return seen.size
}

/** A stroke of a sheet's thumbnail, ready for an SVG `<path>`. */
export interface InkPath {
  d: string
  color: string
  width: number
}

/**
 * A sheet's ink for a picture `w × h` px: one polyline per piece, the
 * highlighters first, under the pens, as the sheet itself lays them (the
 * highlighter has its own canvas under the ink, InkLayer · `ink-mark`). A
 * thumbnail is where one finds "the sheet where I derived the limit", so its
 * ink is the point of it; at 96 px a polyline is as good as the curves the
 * sheet draws, and a hair of 0.5 px keeps the thinnest pen visible.
 */
export function inkPaths(strokes: readonly InkStroke[], w: number, h: number): InkPath[] {
  const marks: InkPath[] = []
  const pens: InkPath[] = []
  for (const stroke of strokes) {
    const points = stroke.points
    if (points.length < 2) continue
    let d = ''
    for (let at = 0; at + 1 < points.length; at += 2) {
      d += `${at === 0 ? 'M' : 'L'}${(points[at] * w).toFixed(1)} ${(points[at + 1] * h).toFixed(1)}`
    }
    // A single point is a dot: a zero-length segment with round caps draws it.
    if (points.length < 4) d += `L${(points[0] * w).toFixed(1)} ${(points[1] * h).toFixed(1)}`
    const line = { d, color: stroke.color, width: Math.max(0.5, stroke.width * w) }
    // A colour that carries its own alpha (#rrggbbaa) is a highlighter.
    if (/^#[\da-f]{8}$/i.test(stroke.color)) marks.push(line)
    else pens.push(line)
  }
  return [...marks, ...pens]
}

/* ------------------------------------------------------------ strip */

/** Where each item of a strip stands, in px from the start of its scroll. */
export interface StripLayout {
  lefts: number[]
  widths: number[]
  /** The strip's whole length, its padding at both ends included. */
  length: number
}

/**
 * Lay items out along a strip: `tile` px each, `slot` px for the slot of a
 * new sheet, `gap` between them, `pad` at both ends.
 */
export function stripLayout(
  kinds: readonly FilmKind[],
  tile: number,
  slot: number,
  gap: number,
  pad: number,
): StripLayout {
  const lefts: number[] = []
  const widths: number[] = []
  let at = pad
  for (const kind of kinds) {
    const width = kind === 'add' ? slot : tile
    lefts.push(at)
    widths.push(width)
    at += width + gap
  }
  return { lefts, widths, length: kinds.length > 0 ? at - gap + pad : pad * 2 }
}

/**
 * The items to draw pictures for: those in view at `scroll`, and `spare` more
 * on each side, so a flick does not uncover blanks. `to` is exclusive.
 *
 * Only these get a canvas. iPad gives a page ONE canvas budget per process,
 * and past it WebKit starts handing out transparent canvases, not
 * necessarily the ones that overflowed it: the lecture sheet may be the one
 * that goes blank. A deck of sixty slides drawn whole into the strip is
 * exactly that overflow.
 */
export function stripWindow(
  layout: StripLayout,
  scroll: number,
  view: number,
  spare: number,
): { from: number; to: number } {
  const count = layout.lefts.length
  if (count === 0) return { from: 0, to: 0 }
  let first = 0
  while (first < count - 1 && layout.lefts[first] + layout.widths[first] <= scroll) first += 1
  let last = first
  while (last < count - 1 && layout.lefts[last + 1] < scroll + view) last += 1
  return { from: Math.max(0, first - spare), to: Math.min(count, last + 1 + spare) }
}

/**
 * Where to scroll a strip so the item at `index` is in view with what comes
 * right after it (the slot and the next item: what the hand reaches for) and
 * with up to `before` items ahead of it, as many as fit.
 *
 * The board puts the current thumbnail fourth (three before), so the eye
 * sees where it came from and where it goes; a strip too narrow for that
 * gives up the items before first, never the next one.
 */
export function stripScroll(layout: StripLayout, index: number, view: number, before: number, pad: number): number {
  const count = layout.lefts.length
  if (index < 0 || index >= count || view <= 0) return 0
  const most = Math.max(0, layout.length - view)
  const tail = Math.min(count - 1, index + 2)
  const end = layout.lefts[tail] + layout.widths[tail] + pad
  let start = index
  while (start > 0 && index - start < before && end - (layout.lefts[start - 1] - pad) <= view) start -= 1
  return Math.max(0, Math.min(most, layout.lefts[start] - pad))
}

/* ----------------------------------------------------------- ribbon */

/**
 * The first chip a portrait ribbon of `slots` chips starts at: the current
 * one with `before` chips ahead of it (the board shows one before a slide,
 * and two before a sheet, so a sheet is seen with the slide it belongs to),
 * and no empty slots at the end.
 */
export function ribbonStart(index: number, count: number, slots: number, before: number): number {
  if (index < 0 || count <= slots) return 0
  return Math.max(0, Math.min(index - before, count - slots))
}

/* ------------------------------------------------------------- grid */

/** How many tiles of `tile` px with `gap` between them a row of `width` px holds. */
export function gridColumns(width: number, tile: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (tile + gap)))
}

/**
 * The grid items to draw pictures for: the rows in view and `spare` rows more
 * on each side (`row` is one row's step, the gap below it included). `to` is
 * exclusive. The same canvas budget as the strip's (`stripWindow`).
 */
export function gridWindow(
  scroll: number,
  view: number,
  row: number,
  columns: number,
  count: number,
  spare: number,
): { from: number; to: number } {
  if (row <= 0 || columns <= 0) return { from: 0, to: count }
  const first = Math.max(0, Math.floor(scroll / row) - spare)
  const past = Math.ceil((scroll + view) / row) + spare
  return { from: Math.min(count, first * columns), to: Math.min(count, past * columns) }
}

/**
 * Where the grid opens: the current item's row second from the top, so the
 * row before it (where one came from) is in view too.
 */
export function gridScroll(index: number, columns: number, row: number): number {
  if (index < 0 || columns <= 0) return 0
  return Math.max(0, (Math.floor(index / columns) - 1) * row)
}

/* -------------------------------------------------------- the menu */

/** A rectangle on the screen, as `getBoundingClientRect` gives it. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Where the sheet menu stands in the console's frame, and where its notch points. */
export interface MenuPlace {
  left: number
  /** From the frame's top when the menu opens below the tile; `null` otherwise. */
  top: number | null
  /** From the frame's bottom when the menu opens above the tile; `null` otherwise. */
  bottom: number | null
  /** The notch's centre, in px from the menu's left edge. */
  notch: number
  /** The menu hangs under the tile, its notch pointing up. */
  below: boolean
}

/**
 * Hang the sheet menu from a tile: above it, the notch pointing down at
 * `aim` (the tile's "⋯" badge, or a chip's middle), kept `edge` px inside the
 * frame (16, as board 08a draws it over the portrait ribbon). Below the tile
 * only when above has no room for it (a tile in the top rows of "Pages").
 */
export function menuPlace(
  tile: Box,
  aim: number,
  frame: { left: number; top: number; width: number; height: number },
  size: { w: number; h: number },
  gap = 14,
  edge = 16,
): MenuPlace {
  const left = Math.max(edge, Math.min(aim - frame.left - size.w / 2, frame.width - size.w - edge))
  const notch = Math.max(16, Math.min(size.w - 16, aim - frame.left - left))
  const above = tile.top - frame.top - gap - edge
  const under = frame.top + frame.height - tile.bottom - gap - edge
  const below = above < size.h && under >= size.h
  return below
    ? { left, top: tile.bottom - frame.top + gap, bottom: null, notch, below }
    : { left, top: null, bottom: frame.top + frame.height - tile.top + gap, notch, below }
}

/* ---------------------------------------------------- the palettes */

/**
 * The parts of a tool palette's card that do NOT lie over the sheet, with
 * `below` px under the card added (the gap down to the portrait rail), in
 * the card's own coordinates: where the console lays a guard under the card
 * that takes a touch itself (ConsoleView · `paletteGuard`).
 *
 * The card's body lets a touch through, so that a pen landing in its
 * padding goes on to the sheet. That holds only over the sheet. In portrait
 * the card opens above the bottom rail, over the docked notes and the
 * ribbon, and a tap on its empty lower edge went through to a chip hidden
 * under it: a sheet was added, or the hall turned two slides on, by a
 * control nobody saw. Up to four bands: above the sheet, below it, and to
 * either side; none when the card lies wholly on the sheet.
 */
export function uncovered(card: Box, sheet: Box | null, below = 0): Box[] {
  const area = { left: card.left, top: card.top, right: card.right, bottom: card.bottom + Math.max(0, below) }
  const local = (box: Box): Box => ({
    left: Math.round(box.left - card.left),
    top: Math.round(box.top - card.top),
    right: Math.round(box.right - card.left),
    bottom: Math.round(box.bottom - card.top),
  })
  const some = (box: Box): boolean => box.right - box.left >= 1 && box.bottom - box.top >= 1
  if (area.right <= area.left || area.bottom <= area.top) return []
  const over = sheet && {
    left: Math.max(area.left, sheet.left),
    top: Math.max(area.top, sheet.top),
    right: Math.min(area.right, sheet.right),
    bottom: Math.min(area.bottom, sheet.bottom),
  }
  if (!over || !some(over)) return [local(area)]
  const bands: Box[] = [
    { left: area.left, top: area.top, right: area.right, bottom: over.top },
    { left: area.left, top: over.bottom, right: area.right, bottom: area.bottom },
    { left: area.left, top: over.top, right: over.left, bottom: over.bottom },
    { left: over.right, top: over.top, right: area.right, bottom: over.bottom },
  ]
  return bands.filter(some).map(local)
}

/* ------------------------------------------------------- two tiers */

/** The sheet box's margin around the page (`.pult-sheet`'s `p-3`). */
export const SHEET_PAD = 12
/**
 * THE ARMREST: 96 px under the page that belong to the sheet box, for the
 * heel of the writing hand. In portrait the notes used to begin 53 px below
 * the paper's bottom edge, and the heel of a palm writing on the bottom third
 * of a slide landed in them; the input layer covers the armrest together with
 * the paper (ConsoleView · `inkReach`), and a palm on it is nothing. In
 * landscape it is the least the two tiers must leave under the page.
 */
export const ARMREST = 96
/** The two-tier strip under the slide: the readings, a 28 px gap, the strip, and 24 px under it. */
export const TIERS_H = 232

/**
 * Whether the readings and the strip may stand in two tiers under the slide
 * (board 06) rather than in one row.
 *
 * Only when the page keeps the size it has today: fitted to the sheet box's
 * width, it must still fit above the two tiers with an armrest of 96 px under
 * it. The strip never takes height from the slide: the slide is what the
 * console is for, and a strip that shrank it to show thumbnails would have it
 * backwards. `aspect` is the page's height over its width; `sheetW` the sheet
 * box's width and `columnH` the height of the column it shares with the
 * strip.
 */
export function twoTiers(sheetW: number, columnH: number, aspect: number): boolean {
  if (sheetW <= 0 || columnH <= 0 || !(aspect > 0)) return false
  const page = (sheetW - SHEET_PAD * 2) * aspect
  return page + SHEET_PAD + ARMREST + TIERS_H <= columnH
}

/**
 * A sample of a paper, `w × h` px: the menu's four choices and the hint on a
 * sheet's chip in the ribbon. Not the sheet's own rules at scale (those are
 * a 32nd of the page, three pixels apart on a 96 px thumbnail and a grey
 * smudge on a 58 px chip, page-region.ts · `paperMarks`), but the same
 * pattern at a step the eye can tell apart: squares, lines with the margin,
 * dots. Lines sit on half pixels, so a hairline is one pixel, not two grey
 * ones.
 */
export function paperSample(
  paper: SheetPaper,
  w: number,
  h: number,
  step: number,
): { lines: string; dots: { x: number; y: number }[] } {
  const lines: string[] = []
  const dots: { x: number; y: number }[] = []
  if (paper === 'plain' || step <= 0) return { lines: '', dots }
  const across = (from: number, to: number) => {
    const out: number[] = []
    for (let at = from; at < to; at += step) out.push(Math.round(at) + 0.5)
    return out
  }
  if (paper === 'grid') {
    for (const x of across(step, w)) lines.push(`M${x} 0V${h}`)
    for (const y of across(step, h)) lines.push(`M0 ${y}H${w}`)
  } else if (paper === 'lines') {
    // Ruled paper leaves a head above its first line, as a notebook does.
    for (const y of across(step * 2, h - step / 2)) lines.push(`M0 ${y}H${w}`)
    lines.push(`M${Math.round(w * PAPER_MARGIN) + 0.5} 0V${h}`)
  } else {
    for (let y = step; y < h - step / 4; y += step) {
      for (let x = step; x < w - step / 4; x += step) dots.push({ x, y })
    }
  }
  return { lines: lines.join(''), dots }
}

/**
 * A picture of a page of proportions `aspect` (height over width), fitted
 * into a `w × h` box by "contain" and centred, as the thumbnails are.
 */
export function fitBox(w: number, h: number, aspect: number): { x: number; y: number; w: number; h: number } {
  if (!(aspect > 0)) return { x: 0, y: 0, w, h }
  const byWidth = w * aspect
  if (byWidth <= h) return { x: 0, y: Math.round((h - byWidth) / 2), w, h: Math.round(byWidth) }
  const byHeight = h / aspect
  return { x: Math.round((w - byHeight) / 2), y: 0, w: Math.round(byHeight), h }
}
