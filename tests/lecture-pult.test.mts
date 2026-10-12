/**
 * The lecture console rules: palette, clock, ink ceilings.
 *
 * Everything checked here breaks SILENTLY and in the middle of class, and
 * almost all of it was once written twice. The stopwatch and the palette
 * existed as two copies in two files, and the copies had drifted apart: the
 * console explained with measured numbers why there is no blue pen in the
 * set — and kept blue as the default. Only the server knew the ceilings, and
 * a refusal on the 601st stroke looked like a lost frame on the tablet: the
 * line was drawn, lived for four seconds on resends and vanished, while the
 * hall never had it at all. (The count of blank sheets lived here too, read
 * off the ink; the server keeps the sheets in a list now, and the console's
 * layout of them is checked by lecture-console-sheets.test.mts.)
 *
 * There is no server here on purpose: this is pure browser arithmetic. That
 * the server refuses at exactly the same numbers is checked by
 * lecture.test.mts — where its memory lives.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INK_WIDTH_MAX,
  INK_WIDTH_MIN,
  MAX_INKED_PAGES,
  MAX_NOTE_CHARS,
  MAX_POINTS_PER_MESSAGE,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_PAGE,
  ZOOM_MAX,
  ZOOM_MIN_SHOWN,
  inkFullSays,
  readZoom,
} from '../shared/lecture.js'
import {
  DARK_PAPER,
  INKS,
  inkRefusal,
  MARKER_WIDTHS,
  MARKERS,
  oneDecimal,
  paperFor,
  PEN_WIDTHS,
  stopwatch,
  zoomTimes,
} from '../web/src/components/lecture/pult.js'

/* ------------------------------------------------------------- palette */

test('the palette has eight pens in the order of the digit keys, black first, no navy', () => {
  // Digit keys 1–8 on the console pick INKS[0..7]: the order is the keys'.
  assert.deepEqual(
    INKS.map((choice) => choice.color),
    ['#101a33', '#d4162f', '#2563eb', '#0c7a64', '#ea580c', '#7c3aed', '#facc15', '#ffffff'],
  )
  // The default of the console and the laptop bar is INKS[0], and it must be
  // black: that is what people write with when they have chosen nothing.
  assert.equal(INKS[0].name, 'Перо, чёрное')
  /*
   * Navy #0f2d69 stays out, and the argument was measured: on a projector
   * with an in-room contrast of ~300:1 it and black both fall into the bottom
   * 8 % of the scale and cannot be told apart from the eighth row, and on the
   * console's night body its disc gives 1.5:1. The blue that is in is the
   * bright #2563eb, as far from black as red is.
   */
  assert.ok(
    !INKS.some((choice) => choice.color.toLowerCase() === '#0f2d69'),
    'the navy pen is back in the set',
  )
  // The brown orange sat on red's lightness: in the hall the two were one colour.
  assert.ok(!INKS.some((choice) => choice.color.toLowerCase() === '#9b5a08'), 'the brown orange is back')
})

test('the light pens are shown on dark paper, the rest on white', () => {
  assert.deepEqual(
    INKS.filter((choice) => choice.light).map((choice) => choice.color),
    ['#facc15', '#ffffff'],
  )
  // A white stroke on a white chip shows nothing: the chip, the "Pen" key and
  // the width strip all ask the same function.
  assert.equal(paperFor('#ffffff'), DARK_PAPER)
  assert.equal(paperFor('#FACC15'), DARK_PAPER)
  assert.equal(paperFor('#101a33'), '#ffffff')
  assert.equal(paperFor('#d4162f'), '#ffffff')
})

test('the pen names are a contract with the interface check', () => {
  // ui-check and pencil-check look for exactly these strings by aria-label.
  assert.deepEqual(
    INKS.map((choice) => choice.name),
    [
      'Перо, чёрное',
      'Перо, красное',
      'Перо, синее',
      'Перо, зелёное',
      'Перо, оранжевое',
      'Перо, фиолетовое',
      'Перо, жёлтое',
      'Перо, белое',
    ],
  )
  // The laptop bar builds the title itself: "Перо, красный" (Pen, red).
  assert.equal(INKS[1].short, 'красный')
  assert.deepEqual(
    INKS.map((choice) => choice.short),
    ['чёрный', 'красный', 'синий', 'зелёный', 'оранжевый', 'фиолетовый', 'жёлтый', 'белый'],
  )
})

test('the pen widths climb by about √2, and the middle names stay', () => {
  const widths = PEN_WIDTHS.map((choice) => choice.width)
  assert.deepEqual(widths, [0.0025, 0.0035, 0.005, 0.008, 0.012])
  for (const width of widths) assert.ok(width >= INK_WIDTH_MIN && width <= INK_WIDTH_MAX)
  // The interface check presses these by name.
  for (const named of ['Тонкое', 'Среднее', 'Толстое']) {
    assert.ok(PEN_WIDTHS.some((choice) => choice.name === named), `the width "${named}" is gone`)
  }
})

test('the highlighters carry their transparency inside the colour', () => {
  /*
   * The ink layer draws a stroke as ONE translucent path only when its colour
   * is 8-digit hex (InkLayer · `seeThrough`), and lays it under the pen ink:
   * an opaque colour here would blot at every joint and cover the writing.
   */
  assert.equal(MARKERS.length, 5)
  for (const choice of MARKERS) {
    assert.match(choice.color, /^#[\da-f]{6}8c$/i, `${choice.color} is not 55 % translucent in its own digits`)
  }
  assert.deepEqual(
    MARKERS.map((choice) => choice.color),
    ['#ffd60a8c', '#4ade808c', '#38bdf88c', '#f472b68c', '#fb923c8c'],
  )
  assert.deepEqual(
    MARKERS.map((choice) => choice.name),
    ['Маркер, жёлтый', 'Маркер, зелёный', 'Маркер, голубой', 'Маркер, розовый', 'Маркер, оранжевый'],
  )
})

test('the highlighter has three widths, the middle one the old default', () => {
  assert.deepEqual(
    MARKER_WIDTHS.map((choice) => choice.width),
    [0.014, 0.022, 0.032],
  )
  // The server clamps widths into this range: a wider one would come back narrower than drawn.
  for (const choice of MARKER_WIDTHS) assert.ok(choice.width >= INK_WIDTH_MIN && choice.width <= INK_WIDTH_MAX)
  assert.deepEqual(
    MARKER_WIDTHS.map((choice) => choice.name),
    ['узкий', 'обычный', 'широкий'],
  )
})

/* ----------------------------------------------------------------- zoom */

test('the zoom is written as a magnification, in the language\'s own decimal sign', () => {
  assert.equal(zoomTimes(2.5, 'ru'), '×2,5')
  assert.equal(zoomTimes(2.5, 'en'), '×2.5')
  // A whole number keeps no ",0", and one decimal is all there is.
  assert.equal(zoomTimes(2, 'ru'), '×2')
  assert.equal(zoomTimes(1.98, 'ru'), '×2')
  assert.equal(zoomTimes(2.46, 'en'), '×2.5')
  assert.equal(zoomTimes(4, 'en'), '×4')
  assert.equal(oneDecimal(1.5, 'ru'), '1,5')
  assert.equal(oneDecimal(1.5, 'en'), '1.5')
})

test('a zoom never reads ×1: anything closer than the whole slide is at least ×1,1', () => {
  /*
   * The armrest's "Hall sees ×…" and the zoomed magnifier key are where the
   * presenter checks what the projector shows, and "×1" there means the whole
   * slide. Rounded to the nearest tenth, every zoom the wire keeps below ×1.05
   * read "×1" while the hall had the slide's edges and footer cut off.
   */
  for (const z of [ZOOM_MIN_SHOWN, 1.03, 1.045, 1.049, 1.05, 1.0001]) {
    assert.equal(zoomTimes(z, 'ru'), '×1,1', `×${z} is labelled ${zoomTimes(z, 'ru')}`)
    assert.equal(zoomTimes(z, 'en'), '×1.1')
  }
  // The two ways there: a pinch let go short of the whole slide, and a
  // magnifier frame drawn around 97 % of the page.
  assert.equal(zoomTimes(readZoom({ x: 0.04, y: 0.04, z: 1.045 })!.z, 'ru'), '×1,1')
  assert.equal(zoomTimes(readZoom({ x: 0.015, y: 0.015, z: 1 / 0.97 })!.z, 'ru'), '×1,1')
  // Every zoom the wire can carry, in its own steps of 0.001, reads closer than the whole slide.
  for (let step = 0; ZOOM_MIN_SHOWN + step / 1000 <= ZOOM_MAX; step += 1) {
    const read = readZoom({ x: 0, y: 0, z: ZOOM_MIN_SHOWN + step / 1000 })
    assert.ok(read, `×${ZOOM_MIN_SHOWN + step / 1000} did not read as a zoom`)
    assert.notEqual(zoomTimes(read.z, 'ru'), '×1', `×${read.z} is labelled as the whole slide`)
  }
  // The whole slide is still "×1", and past the floor the tenth is the nearest one.
  assert.equal(zoomTimes(1, 'ru'), '×1')
  assert.equal(zoomTimes(1.12, 'ru'), '×1,1')
  assert.equal(zoomTimes(1.16, 'en'), '×1.2')
  // The floor is the zoom's, not the number's: `oneDecimal` writes seconds too.
  assert.equal(oneDecimal(1.02, 'ru'), '1')
})

/* ---------------------------------------------------------------- clock */

test('the stopwatch drops seconds after an hour and keeps them before', () => {
  assert.equal(stopwatch(0), '00:00')
  assert.equal(stopwatch(9_000), '00:09')
  assert.equal(stopwatch(75_000), '01:15')
  assert.equal(stopwatch(59 * 60_000 + 59_000), '59:59')
  // After an hour the question is "how much is left", not "how much has passed".
  assert.equal(stopwatch(3_600_000), '1:00')
  assert.equal(stopwatch(3_600_000 + 2 * 60_000 + 15_000), '1:02')
  assert.equal(stopwatch(10 * 3_600_000), '10:00')
})

/* -------------------------------------------------------------- ceilings */

const strokes = (page: number, count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ id: `s${page}_${from + i}`, page }))

test('on a page that is not full a stroke opens', () => {
  assert.equal(inkRefusal(strokes(1, 10), [], 1), null)
  // Other pages have nothing to do with this one.
  assert.equal(inkRefusal(strokes(2, MAX_STROKES_PER_PAGE), [], 1), null)
})

test('on a full page a stroke does not open, and the refusal speaks in words', () => {
  const why = inkRefusal(strokes(1, MAX_STROKES_PER_PAGE), [], 1)
  assert.equal(why, 'page-full')
  // The words come from shared: the console has no copy of the phrase of its
  // own, and lecture-one-voice holds that there is one for both ends.
  assert.ok(inkFullSays('page-full').length > 0)
  assert.notEqual(inkFullSays('page-full'), inkFullSays('too-many-pages'))
})

test('your own unconfirmed strokes are counted once, not twice', () => {
  const known = strokes(1, MAX_STROKES_PER_PAGE - 1)
  /*
   * A wet stroke whose echo has already come back lies both in the room's ink
   * and on the wet layer. Counted twice, it would close the page one stroke
   * early — that is, refuse where the server accepts.
   */
  const echoed = [{ id: known[0].id, page: 1 }]
  assert.equal(inkRefusal(known, echoed, 1), null)
  // And an echo that has not come back is a real stroke, and it tops up the
  // ceiling.
  assert.equal(inkRefusal(known, [{ id: 'свежий', page: 1 }], 1), 'page-full')
})

/* -------------------------------------------------- page ceiling */

test('written-on pages ran out: a new one is not created, an old one still takes ink', () => {
  const many = Array.from({ length: MAX_INKED_PAGES }, (_, i) => ({ id: `p${i}`, page: i + 1 }))
  assert.equal(inkRefusal(many, [], MAX_INKED_PAGES + 1), 'too-many-pages')
  // A page that is already written on has nothing to do with the page ceiling.
  assert.equal(inkRefusal(many, [], 1), null)
})

/*
 * THE CEILINGS ARE THE SAME AT BOTH ENDS, and two tests hold them, not one.
 *
 * Here the declared numbers are checked, in lecture.test.mts that the server
 * refuses exactly at them. The copies cannot drift apart silently: if the
 * server's one moves, that test fails; if the declared one moves, this one
 * does. And the price of drifting is exactly the one the numbers moved into
 * shared for: a line the host drew, saw on their sheet for four seconds and
 * never saw in the hall.
 */
test('the declared ceilings are the same ones at which the server refuses', () => {
  assert.equal(MAX_STROKES_PER_PAGE, 600)
  assert.equal(MAX_POINTS_PER_STROKE, 4_000)
  assert.equal(MAX_POINTS_PER_MESSAGE, 512)
  assert.equal(MAX_INKED_PAGES, 200)
  assert.equal(MAX_NOTE_CHARS, 3000)
})
