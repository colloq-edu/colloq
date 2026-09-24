/**
 * The lecture console rules: palette, clock, sheet count, ink ceilings.
 *
 * Everything checked here breaks SILENTLY and in the middle of class, and
 * almost all of it was once written twice. The stopwatch and the palette
 * existed as two copies in two files, and the copies had drifted apart: the
 * console explained with measured numbers why there is no blue pen in the
 * set — and kept blue as the default. Only the server knew the ceilings, and
 * a refusal on the 601st stroke looked like a lost frame on the tablet: the
 * line was drawn, lived for four seconds on resends and vanished, while the
 * hall never had it at all. The count of blank sheets lived in the tab's
 * memory, and reloading the console dropped written-on sheets from the page
 * strip.
 *
 * There is no server here on purpose: this is pure browser arithmetic. That
 * the server refuses at exactly the same numbers is checked by
 * lecture.test.mts — where its memory lives.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INKED_PAGES,
  MAX_NOTE_CHARS,
  MAX_POINTS_PER_MESSAGE,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_PAGE,
  inkFullSays,
} from '../shared/lecture.js'
import {
  boardsInked,
  INKS,
  inkRefusal,
  stopwatch,
} from '../web/src/components/lecture/pult.js'

/* ------------------------------------------------------------- palette */

test('the palette has four pens, black first, no blue', () => {
  assert.equal(INKS.length, 4)
  // The default of the console and the laptop bar is INKS[0], and it must be
  // black: that is what people write with when they have chosen nothing.
  assert.equal(INKS[0].name, 'Перо, чёрное')
  /*
   * Blue #0f2d69 was removed, and the argument was measured: on a projector
   * with an in-room contrast of ~300:1 it and black both fall into the bottom
   * 8 % of the scale and cannot be told apart from the eighth row, and on the
   * console's night body its disc gives 1.5:1.
   */
  assert.ok(
    !INKS.some((choice) => choice.color.toLowerCase() === '#0f2d69'),
    'the blue pen is back in the set',
  )
})

test('the pen names are a contract with the interface check', () => {
  // ui-check and pencil-check look for exactly these strings by aria-label.
  const names = INKS.map((choice) => choice.name)
  for (const named of ['Перо, чёрное', 'Перо, красное', 'Перо, зелёное']) {
    assert.ok(names.includes(named), `the name "${named}" is gone from the palette`)
  }
  // The laptop bar builds the title itself: "Перо, красный" (Pen, red).
  assert.equal(INKS[1].short, 'красный')
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

/* --------------------------------------------------------------- sheets */

test("created sheets are recognised by their ink, not by the tab's memory", () => {
  // Counted by the NUMBERS of written-on pages: the tab may not hold the ink
  // of a given page at all, yet all the sheets must stand in the strip (see
  // the `ink:pages` inventory and `inkedPages` in ink.ts).
  assert.equal(boardsInked([]), 0)
  // Slides are not sheets: positive pages do not count at all.
  assert.equal(boardsInked([7]), 0)
  // Sheet number N proves that all the ones before it were created too.
  assert.equal(boardsInked([-3, 4]), 3)
  assert.equal(boardsInked(new Set([-1, -2, -1])), 2)
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
