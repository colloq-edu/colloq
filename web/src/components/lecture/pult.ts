import { getLocale, tr, type Locale } from '@shared/i18n'
/**
 * Rules the three lecture screens must agree on in advance.
 *
 * The projection, the console and the presenter's column are built from the
 * same components for exactly one reason: once they drift apart, they show
 * the presenter one thing and the audience another, and nobody can notice it
 * anywhere but in the lecture hall. Everything here has already drifted apart
 * at least once, and it lives here so that it cannot again:
 *
 *  • the PALETTE was written twice, and the copies disagreed: the console
 *    explained with measured numbers why there was no blue pen in the set and
 *    still kept blue as the default, while the bar on the laptop had it as
 *    the second of four circles;
 *  • the STOPWATCH was copied word for word into the console and into the
 *    notes header, with the remark "same as in the instrument", that is, with
 *    a promise nothing kept;
 *  • only the server knew the INK CEILINGS, and a refusal at the 601st stroke
 *    looked on the tablet like a lost frame.
 *
 * The count of blank sheets used to live here too, read off the ink. The
 * server keeps the sheets now, in a list every screen gets with the lecture
 * (shared/lecture.ts · `LectureSheet`), and the console lays them out from
 * that list (film.ts).
 *
 * There is not a single rune and not a single network call here: this is
 * arithmetic and agreements that can be checked without a browser.
 */
import { MAX_INKED_PAGES, MAX_STROKES_PER_PAGE, type InkFull } from '@shared/lecture'

/* ------------------------------------------------------------- palette */

/**
 * EIGHT PEN COLOURS, in the order of the digit keys 1–8 on the console.
 *
 * There used to be four, and blue was kept out on a measured argument that
 * still holds for the blue it was about: on a projector with ~300:1 in-room
 * contrast, navy #0f2d69 and black #101a33 both fall into the bottom 8 % of
 * the scale and cannot be told apart from the eighth row, and on the
 * console's night body a navy disc gives 1.5:1. The blue that is back is a
 * different one: #2563eb sits at L*≈45 against black's ≈10, as far from
 * black as red is, so it reads as a colour of its own in the hall. Navy stays
 * out (tests/lecture-pult.test.mts forbids it by its code).
 *
 * Orange is a brighter #ea580c now: the old brown #9b5a08 sat next to red at
 * the same lightness, and in the hall the two were one colour. Purple is for
 * a second thread of argument once red and blue are taken.
 *
 * YELLOW AND WHITE ARE FOR DARK SLIDES (`light`): on a white slide they are
 * invisible, on a photograph or a dark theme they are the only pens that
 * read. Wherever the console shows them (the chip on the "Pen" key, the
 * palette's chip, the width strip) they lie on DARK paper (`DARK_PAPER`): a
 * white stroke on white paper is a chip that shows nothing.
 *
 * THE NAMES ARE A CONTRACT WITH THE INTERFACE CHECK, do not change them. There
 * are two kinds, and that is not carelessness: `name` is the control's full
 * name ("Pen, black"), `short` is the adjective the laptop bar puts into its
 * own title.
 */
export interface Ink {
  color: string
  /** The control's full name, as the console rail and the UI check call it. */
  name: string
  /** The adjective for the laptop bar: it builds "Pen, red" by itself. */
  short: string
  /** A pigment for dark slides: shown on `DARK_PAPER`, never on white. */
  light?: boolean
}

export const INKS: readonly Ink[] = [
  { color: '#101a33', get name() { return tr('room.ui.320') }, get short() { return tr('room.ui.321') } },
  { color: '#d4162f', get name() { return tr('room.ui.322') }, get short() { return tr('room.ui.323') } },
  { color: '#2563eb', get name() { return tr('room.pult4.penBlue') }, get short() { return tr('room.pult4.penBlueShort') } },
  { color: '#0c7a64', get name() { return tr('room.ui.324') }, get short() { return tr('room.ui.325') } },
  { color: '#ea580c', get name() { return tr('room.ui.326') }, get short() { return tr('room.ui.327') } },
  { color: '#7c3aed', get name() { return tr('room.pult4.penPurple') }, get short() { return tr('room.pult4.penPurpleShort') } },
  {
    color: '#facc15',
    light: true,
    get name() { return tr('room.pult4.penYellow') },
    get short() { return tr('room.pult4.penYellowShort') },
  },
  {
    color: '#ffffff',
    light: true,
    get name() { return tr('room.pult4.penWhite') },
    get short() { return tr('room.pult4.penWhiteShort') },
  },
]

/**
 * The paper light pens are shown on: the night of a dark slide, a step above
 * the console's own body so that the chip still reads as paper.
 */
export const DARK_PAPER = '#1b2540'

/** The paper a pen's sample lies on: dark for the light pens, white for the rest. */
export function paperFor(color: string): string {
  const pen = INKS.find((choice) => choice.color.toLowerCase() === color.toLowerCase())
  return pen?.light ? DARK_PAPER : '#ffffff'
}

/** A width the palette offers, as a fraction of the page width, and its name. */
export interface Width {
  width: number
  name: string
}

/**
 * Five pen thicknesses as fractions of the page width.
 *
 * There used to be three, and between "Fine" and "Medium" fitted all the
 * small formula work, while between "Medium" and "Thick" fitted every
 * heading: a step of one and a half times is too coarse to hit what you
 * need. The five steps go up by about √2 each: that is the step at which
 * neighbours are still distinguishable by eye, but one no longer has to
 * choose between "thin" and "too thick". The middle one is the default.
 *
 * The middle names are a contract with the interface check.
 */
export const PEN_WIDTHS: readonly Width[] = [
  { width: 0.0025, get name() { return tr('room.ui.236') } },
  { width: 0.0035, get name() { return tr('room.ui.237') } },
  { width: 0.005, get name() { return tr('room.ui.238') } },
  { width: 0.008, get name() { return tr('room.ui.239') } },
  { width: 0.012, get name() { return tr('room.ui.240') } },
]

/**
 * FIVE HIGHLIGHTERS, and the transparency travels IN the colour (the last two
 * hex digits, 0x8c = 55 %).
 *
 * That is not a style but the ink layer's contract: a stroke whose colour
 * carries its own alpha is drawn as ONE path (InkLayer · `seeThrough`), so the
 * alpha does not double where the stroke crosses itself or where its pieces
 * join, and it is laid on the highlighter's own canvas UNDER the pen ink,
 * multiplied with the slide (screened on a dark one, plainly blended on a
 * mixed one: LecturePage · `data-ink-backdrop`). A highlighter written as an
 * opaque colour plus a separate opacity would blot at every joint and cover
 * the writing.
 *
 * 55 %, not the old 50 %: under `multiply` a highlighter darkens nothing that
 * is already dark, so it can afford to be a little denser and still leave the
 * text crisp, and at 50 % the green and the blue were barely there on a
 * projector in a lit room.
 */
export interface Marker {
  color: string
  /** The control's full name: "Highlighter, yellow". */
  name: string
}

export const MARKERS: readonly Marker[] = [
  { color: '#ffd60a8c', get name() { return tr('room.pult4.markerYellow') } },
  { color: '#4ade808c', get name() { return tr('room.pult4.markerGreen') } },
  { color: '#38bdf88c', get name() { return tr('room.pult4.markerBlue') } },
  { color: '#f472b68c', get name() { return tr('room.pult4.markerPink') } },
  { color: '#fb923c8c', get name() { return tr('room.pult4.markerOrange') } },
]

/**
 * Three highlighter widths, the middle one the default: one line of slide
 * text, a line and a half, two lines. A highlighter marks a line of text, so
 * its widths follow the text's measure, not the pen's ladder.
 */
export const MARKER_WIDTHS: readonly Width[] = [
  { width: 0.014, get name() { return tr('room.pult4.markerNarrow') } },
  { width: 0.022, get name() { return tr('room.pult4.markerRegular') } },
  { width: 0.032, get name() { return tr('room.pult4.markerWide') } },
]

/* --------------------------------------------------------------- zoom */

/**
 * A number with at most one decimal, in the language's own decimal sign:
 * "2,5" in Russian and "2.5" in English, and a whole number without its
 * ",0" ("2", not "2,0").
 */
export function oneDecimal(n: number, locale: Locale = getLocale()): string {
  const near = Math.round(n * 10) / 10
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(near)
}

/**
 * How close the hall sees the slide, as the console writes it: "×2,5" in
 * Russian, "×2.5" in English. The number is the magnification itself, not a
 * percentage: "×2" is what a person says about a magnifier.
 *
 * A zoom never reads "×1": that is the whole slide, and these words are where
 * the presenter checks what the hall has. Rounded to the nearest tenth, a
 * pinch let go at ×1.03, or a magnifier frame around 97 % of the page, read
 * "Hall sees ×1" while the projector cut off the slide's edges and footer.
 * So anything closer than the whole page reads at least "×1,1". The floor is
 * here and not in `oneDecimal`, which writes seconds as well, and 1.02 s is
 * "1 s".
 */
export function zoomTimes(z: number, locale: Locale = getLocale()): string {
  return `×${oneDecimal(z > 1 ? Math.max(z, 1.1) : z, locale)}`
}

/* -------------------------------------------------------------- clock */

/**
 * The lecture stopwatch, AND AFTER AN HOUR IT DROPS THE SECONDS: "1:02", not
 * "1:02:15". After an hour the seconds mean nothing: the question at that
 * point is "how much is left", not "how much has passed".
 */
export function stopwatch(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const mm = String(Math.floor(total / 60) % 60).padStart(2, '0')
  if (hours > 0) return `${hours}:${mm}`
  return `${mm}:${String(total % 60).padStart(2, '0')}`
}

/* ---------------------------------------------------------- ceilings */

/** What ink is measured by from outside: page and id; nothing else is needed. */
export interface InkMark {
  id: string
  page: number
}

/**
 * Why the next stroke will not start. `null` means it will.
 *
 * This is a NARROWING of `InkFull` from shared, not a pair of strings of our
 * own next to it. The third ceiling there ("the stroke ran out of points") is
 * not counted by the console: it is about a stroke already under way, and the
 * server names it. `Extract` on purpose, not retyped literals: a refusal
 * renamed in shared must break the build here rather than drift apart
 * silently.
 */
export type InkRefusal = Extract<InkFull, 'page-full' | 'too-many-pages'>

/**
 * Whether there is still room for a stroke on this page.
 *
 * At the 601st stroke (and at the 201st inked page) the server simply returns
 * `null` and sends nothing. The ink layer could not tell that from a lost
 * frame: it resent the stroke WHOLE eight times and removed it from the sheet
 * four seconds later, without a line of explanation, while the audience never
 * had the line at all. Counting the same thing here is cheaper than guessing:
 * we hold all of the room's ink anyway.
 *
 * `mine` is our own strokes the server has not confirmed yet: without them
 * the last few strokes on a full page would be miscounted twice over, in the
 * wrong direction.
 */
export function inkRefusal(
  known: readonly InkMark[],
  mine: readonly InkMark[],
  page: number,
): InkRefusal | null {
  const seen = new Set<string>()
  const pages = new Set<number>()
  let onPage = 0
  // Two passes rather than one over a concatenated array: a lecture's ink can
  // run to nearly a hundred thousand strokes, and the extra copy would be made
  // on EVERY touch of the pen.
  for (const list of [known, mine]) {
    for (const stroke of list) {
      if (seen.has(stroke.id)) continue
      seen.add(stroke.id)
      pages.add(stroke.page)
      if (stroke.page === page) onPage += 1
    }
  }
  if (onPage >= MAX_STROKES_PER_PAGE) return 'page-full'
  if (!pages.has(page) && pages.size >= MAX_INKED_PAGES) return 'too-many-pages'
  return null
}

/*
 * THE REFUSAL WORDS ARE NOT HERE — they are in `@shared/lecture` ·
 * `inkFullSays`, and the ink layer calls them from there.
 *
 * A pair of strings of our own used to stand here and matched the server's
 * word for word, until the first edit of the wording. And wording gets edited
 * precisely because a phrase is poor, and a person edits whichever copy they
 * found: after that the same refusal speaks in two voices on the console,
 * depending on who noticed it first — the console itself before the stroke,
 * or the server after a reconnect.
 */
