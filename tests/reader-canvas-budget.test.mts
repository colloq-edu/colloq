/**
 * The canvas budget of the PDF reader.
 *
 * A page's buffer grows quadratically with the scale, and the scale here is the
 * column width: at 300% an A4 page in a 1400 px column asks for 8400×11900 ≈
 * 100 Mpx, four hundred megabytes, and the observer keeps three or four of
 * those drawn. The canvas budget on an iPad is one PER PROCESS, and when it
 * overflows WebKit hands canvases back transparent — arbitrary ones, not
 * necessarily the ones that overflowed it: the page of a running lecture in
 * the next tab may go blank.
 *
 * This breaks silently and not on a developer's machine, so the limit is
 * checked with numbers rather than by eye.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CANVAS_PX,
  MAX_CANVAS_SIDE,
  fits,
} from '../web/src/components/reader/budget.js'

/** A4 in points, which is what pdf.js reports for an ordinary page. */
const A4 = { w: 595, h: 842 }

/** Buffer area at the chosen multiplier. */
const area = (w: number, h: number, ratio: number): number => w * ratio * (h * ratio)

test('ordinary reading pays for the full screen density', () => {
  // 100%, a laptop column: the ceiling is far away, and there is no reason to blur the page.
  const css = 900 / A4.w
  assert.equal(fits(A4.w * css, A4.h * css, 2), 2)
})

test('at 300% the multiplier drops rather than going over the budget', () => {
  // Exactly the page on which pages went blank: a 1400 column, scale 3 — that
  // is, a page 4200 CSS pixels wide.
  const width = 1400 * 3
  const css = width / A4.w
  const w = A4.w * css
  const h = A4.h * css

  assert.ok(
    area(w, h, 2) > 4 * MAX_CANVAS_PX,
    'the check lost its point: without the limit this page would fit the budget anyway',
  )

  const ratio = fits(w, h, 2)
  assert.ok(ratio < 2, 'the screen density was left untouched: the buffer is a hundred megapixels again')
  assert.ok(area(w, h, ratio) <= MAX_CANVAS_PX + 1, 'the buffer is still over the area ceiling')
  assert.ok(w * ratio <= MAX_CANVAS_SIDE && h * ratio <= MAX_CANVAS_SIDE, 'a side is over the ceiling')
})

test('a long narrow page is limited by its side, not by its area', () => {
  // A poster or a sheet of output: the area is still fine, the buffer height is not.
  const w = 300
  const h = 6000
  assert.ok(area(w, h, 2) < MAX_CANVAS_PX, 'the area of this page is under the ceiling anyway')
  const ratio = fits(w, h, 2)
  assert.ok(h * ratio <= MAX_CANVAS_SIDE, 'the buffer height is over the side limit')
})

test('the multiplier is never greater than the requested density', () => {
  // Sharpness beyond the screen density is invisible, and the memory costs just as much.
  assert.equal(fits(100, 100, 1), 1)
  assert.equal(fits(10, 10, 1), 1)
  assert.equal(fits(300, 400, 1.5), 1.5)
})

test('degenerate sizes give neither zero nor infinity', () => {
  // `clientWidth` can be zero: a page that has not been laid out yet. A zero
  // multiplier would mean a 0×0 canvas followed by "Cannot use the same canvas".
  for (const ratio of [fits(0, 0, 2), fits(-5, 10, 2), fits(1, 1, 2)]) {
    assert.ok(Number.isFinite(ratio) && ratio > 0, `multiplier ${ratio} is no good for a canvas`)
  }
})
