/**
 * What styling from a text cell is allowed to do to other people's screens.
 *
 * The `style` attribute in a note used to be banned outright, and the ban was
 * deserved: `<div style="position:fixed;inset:0;background:#000;z-index:9999">`
 * from a single cell is a black screen for all thirty people and for the
 * laptop on the projector, on top of the interface at that, so the cell can
 * no longer be deleted with the mouse, and a reload brings back the same cell.
 *
 * But the price of the ban is all the familiar markup of a teaching notebook.
 * `<div style="background:#eef;padding:8px;border-left:3px solid #66f">` is
 * the "Note" callout found in every other notebook; without the attribute it
 * arrives as a bare `<div>`, that is, indistinguishable from an ordinary
 * paragraph. From the outside this reads not as "styling is forbidden" but as
 * "HTML does not work", because the structure did get through, yet there is
 * no visible difference.
 *
 * So what is forbidden is not the attribute but PROPERTIES: the value is
 * parsed, familiar styling gets through, levers on other people's screens do
 * not. The border is drawn by a single criterion: a property stays if all it
 * can spoil is the note's own rectangle, and goes if it can draw, move or
 * catch the mouse OUTSIDE it.
 *
 * Hence the non-obvious refusals:
 *
 * - `box-shadow` and `text-shadow` are not decoration but
 *   `0 0 0 100vmax #000`: a shadow is drawn OUTSIDE the element and paints
 *   over the whole screen. Exactly the hole the `position` ban was meant to
 *   close, only from the other side, and the only two properties that can do
 *   it without `position`.
 * - `url(...)` is an address that the browser of everyone in the room will
 *   request: the same argument as for `@import` in the output's shadow root
 *   (ScopedOutput.svelte).
 * - `calc()` and `var()` are a way to smuggle a number past the ceiling below
 *   and a value past the parsing. A note never needs them.
 *
 * The tag sanitizer lives separately (web/src/lib/sanitize.ts): `<style>`,
 * `<form>`, `<audio>`, `<video>` are still dropped whole, and for the same
 * reason as before — a style sheet inside the page acts on the WHOLE page,
 * while this file judges properties one element at a time.
 *
 * One file for both renderers of a note — the room
 * (web/src/lib/render.svelte.ts) and the static publication
 * (server/src/publish/render.ts). A second copy of a security policy is a way
 * to open a hole, not to close one.
 */

/**
 * Properties a note may name. Anything not listed here is removed.
 *
 * An allowlist, not a blocklist: CSS has several hundred properties, new ones
 * are added every year, and `anchor-name` and `view-transition-name` are
 * exactly the two a blocklist would have learned about from a report on an
 * already ruined class.
 */
export const NOTE_CSS_PROPS: ReadonlySet<string> = new Set(
  `color background background-color background-image background-position
   background-size background-repeat background-clip background-origin
   font font-family font-size font-style font-weight font-variant font-stretch
   line-height letter-spacing word-spacing tab-size
   text-align text-align-last text-indent text-transform
   text-decoration text-decoration-color text-decoration-line
   text-decoration-style text-decoration-thickness text-underline-offset
   text-overflow white-space word-break overflow-wrap word-wrap hyphens
   direction vertical-align
   display width min-width max-width height min-height max-height
   margin margin-top margin-right margin-bottom margin-left margin-inline
   margin-block padding padding-top padding-right padding-bottom padding-left
   padding-inline padding-block box-sizing
   border border-top border-right border-bottom border-left
   border-width border-style border-color
   border-top-width border-right-width border-bottom-width border-left-width
   border-top-style border-right-style border-bottom-style border-left-style
   border-top-color border-right-color border-bottom-color border-left-color
   border-radius border-top-left-radius border-top-right-radius
   border-bottom-left-radius border-bottom-right-radius
   overflow overflow-x overflow-y float clear opacity visibility
   aspect-ratio object-fit object-position
   flex flex-direction flex-wrap flex-flow flex-grow flex-shrink flex-basis
   justify-content justify-items justify-self align-items align-content
   align-self place-items place-content place-self order gap row-gap column-gap
   grid grid-template grid-template-columns grid-template-rows
   grid-template-areas grid-column grid-row grid-auto-flow grid-auto-columns
   grid-auto-rows
   columns column-count column-width column-gap column-rule column-span
   border-collapse border-spacing table-layout caption-side empty-cells
   list-style list-style-type list-style-position`
    .trim()
    .split(/\s+/),
)

/**
 * Functions allowed in a value. A parenthesis with any other name is a reason
 * to drop the whole declaration.
 *
 * A color and a gradient are computed on their own and go nowhere. `url()`,
 * `image-set()`, `attr()`, `element()` go places; `calc()`, `min()`, `max()`,
 * `clamp()`, `var()`, `env()` compute, which means they smuggle a number past
 * the length ceiling.
 */
const CSS_FUNCS: ReadonlySet<string> = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
])

/**
 * The length ceiling — in pixels, to which any unit is converted.
 *
 * Without it the property allowlist does only half the job:
 * `border: 9999px solid #000` and `margin-left: -9999px` take content outside
 * the note with the very properties styling needs. 1600 is noticeably more
 * than the widest column of a notebook and certainly less than a screen.
 *
 * Negative spacing is needed rarely and in small amounts (nudging a frame by
 * a couple of pixels), so the ceiling downwards is much closer: -240 is
 * enough for that trick, but not for carrying a block out of the cell.
 */
const MAX_PX = 1600
const MIN_PX = -240

/** The percentage ceiling: `line-height: 150%` — yes, `width: 900%` — no. */
const MAX_PCT = 400

/** Font size on its own: 96px is already "one letter per half a screen". */
const MAX_FONT_PX = 96

/** How many pixels are in a unit. `%` is counted separately — it is not a length. */
const UNIT_PX: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: 16,
  rem: 16,
  ex: 8,
  ch: 8,
  // Viewport units are counted against a large screen — that is, the worst
  // case: `width: 100vw` on a projector must hit the ceiling, not slip under
  // it because it was measured on a laptop.
  vw: 20,
  vh: 12,
  vmin: 12,
  vmax: 20,
  vi: 20,
  vb: 12,
  svw: 20,
  svh: 12,
  lvw: 20,
  lvh: 12,
  dvw: 20,
  dvh: 12,
}

const NUMBER = /(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)/gi

/** Whether every number in the value fits under the ceiling. */
function withinBounds(value: string, limit: number): boolean {
  NUMBER.lastIndex = 0
  let found: RegExpExecArray | null
  while ((found = NUMBER.exec(value)) !== null) {
    const n = Number(found[1])
    if (!Number.isFinite(n)) return false
    const unit = found[2].toLowerCase()
    if (unit === '%') {
      if (Math.abs(n) > MAX_PCT) return false
      continue
    }
    const factor = UNIT_PX[unit]
    // No unit means not a length: `line-height: 1.5`, `opacity: .4`, `flex: 1 1 0`,
    // and also color channels inside `rgb(...)`. Measuring them in pixels is pointless.
    if (factor === undefined) continue
    const px = n * factor
    if (px > limit || px < MIN_PX) return false
  }
  return true
}

/** The function name before a parenthesis: `linear-gradient(` -> `linear-gradient`. */
const CALL = /(^|[\s,(:/])(-?[a-z][a-z0-9-]*)\s*\(/gi

/** Whether the value calls only allowed functions. */
function callsAllowed(value: string): boolean {
  CALL.lastIndex = 0
  let found: RegExpExecArray | null
  while ((found = CALL.exec(value)) !== null) {
    if (!CSS_FUNCS.has(found[2].toLowerCase())) return false
  }
  // A parenthesis with no name before it is a way to hide a call from the parsing above.
  return !/(^|[\s,:/])\(/.test(value)
}

/**
 * The declarations of a `style` attribute value, cut at `;`.
 *
 * Cut by hand rather than with `split(';')`: a semicolon can occur inside
 * parentheses (`color-mix(in srgb, …)` has none, but a foreign function well
 * might) and inside quotes, and `split` would cut a declaration in half,
 * turning the tail of a function into a separate "property". It would not be
 * found in the allowlist anyway, but what has to be parsed is what the
 * browser will read, not what is convenient to cut.
 */
function declarations(value: string): string[] {
  const out: string[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      out.push(value.slice(start, i))
      start = i + 1
    }
  }
  out.push(value.slice(start))
  return out
}

/**
 * The value length beyond which there is no point in parsing.
 *
 * A ten-kilobyte attribute is not styling but an attempt to keep every tab in
 * the room busy parsing: a note is re-rendered on every keystroke of a
 * neighbor.
 */
const MAX_STYLE = 2000

/**
 * The value of a note's `style` attribute — reduced to what may be shown.
 *
 * An empty string means "remove the attribute entirely": `style=""` in the
 * markup is no better than no attribute, and an extra empty attribute reads as
 * a change when markup is compared.
 *
 * What gets dropped is the DECLARATION, not the whole attribute: in
 * `style="background:#eef;position:fixed"` the first is an ordinary callout,
 * and losing it because of the second would mean punishing it for its
 * neighbor. The author will see that one of the two did not take effect, and
 * that is an honest answer.
 */
export function safeStyle(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_STYLE) return ''
  /*
   * A backslash is an escape in CSS: the browser reads `\70 osition` as
   * `position`. Parsing that would mean writing a second CSS parser; a value
   * containing one is rejected whole, and that costs no real note anything —
   * in styling, escapes only occur in `content`, which is not here.
   *
   * Control characters and `<` are caught by the same argument: they only
   * turn up from someone testing how sturdy the parser is.
   */
  // eslint-disable-next-line no-control-regex -- control characters are the very subject here
  if (/[\\<>{}@]|[ -]/.test(value)) return ''

  const kept: string[] = []
  for (const decl of declarations(value)) {
    const colon = decl.indexOf(':')
    if (colon === -1) continue
    const prop = decl.slice(0, colon).trim().toLowerCase()
    if (!NOTE_CSS_PROPS.has(prop)) continue
    /*
     * `!important` is removed rather than disqualifying the declaration.
     *
     * It gives the author nothing — an inline style already beats the
     * `.prose-note` rules — while it would cost us the ability to defend
     * against a note with a rule of our own. A note copied from someone else's
     * notebook carries it all over the place, and failing on it would be a
     * lie of the "HTML does not work" kind.
     */
    const body = decl
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim()
    if (!body) continue
    if (!callsAllowed(body)) continue
    if (!withinBounds(body, prop === 'font-size' || prop === 'font' ? MAX_FONT_PX : MAX_PX)) continue
    kept.push(`${prop}: ${body}`)
  }
  return kept.join('; ')
}
