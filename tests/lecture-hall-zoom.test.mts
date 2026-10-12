/**
 * The hall's half of the lecture console v4: the zoomed page, the paper of a
 * blank sheet, the laptop bar's walk through the sheets, and "Read on my
 * own" that stays read on one's own.
 *
 *  • a zoomed region is rendered into a canvas the size of the frame, never
 *    a bigger one (the iPad's canvas budget turns overflowing canvases
 *    transparent), and the region pdf.js draws is exactly the one the ink
 *    and every other screen show: checked against pdf.js's own viewport;
 *    a tablet's scale is capped lower than a computer's, an Android tablet
 *    that calls itself Linux included;
 *  • a fresh render goes up in the middle of a motion only when it covers
 *    the view (zooming out), and waits for the view otherwise;
 *  • the sheet's zoom (sheet-zoom.ts): the ink repaints only when the new
 *    picture lands, a page turn holds the old picture still, a lone target
 *    from the wire eases while a pinch's stream is chased, a motion ends
 *    exactly on its target, and a render keeps going in a window that gets
 *    no frames;
 *  • a blank sheet's rules zoom with the page, and only what is visible is
 *    drawn;
 *  • the laptop bar walks slides and sheets in the console's order, and
 *    names a sheet by its place: "sheet 2 of 3";
 *  • a student who stepped out to read alone is not pulled back by the
 *    presenter's next page turn.
 *
 * Pure arithmetic is called; the components are held by their source, the
 * way lecture-pages does it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../shared/i18n.js'
import { roomMessages } from '../shared/locales/room.js'
import { lectureSequence, type LectureSheet, type LectureZoom } from '../shared/lecture.js'
import {
  coversRegion,
  PAPER_MARGIN,
  PAPER_RULES,
  PAPER_SQUARES,
  paperMarks,
  REGION_BUDGET,
  regionBudget,
  regionViewport,
} from '../web/src/components/lecture/page-region.js'
import { EARLY_MS, SheetZoom, STREAM_MS } from '../web/src/components/lecture/sheet-zoom.js'
import { sheetPlace, walkLength, walkStep } from '../web/src/components/lecture/walk.js'
import { EASE_MS, sameRegion, SETTLE_MS, ZoomMotion } from '../web/src/components/lecture/zoom.js'
import { deviceKindOf } from '../web/src/lib/device.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

function code(rel: string): string {
  // Markup without comments: an explanation is not a promise.
  return read(rel)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

const close = (a: number, b: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`)

/* ------------------------------------------------------- the region */

/**
 * pdf.js's own PageViewport, taken from the build the app ships: the region
 * is checked against the transform that will actually draw it, not against
 * a copy of its arithmetic. The class needs nothing from its module but two
 * helpers its constructor never calls.
 */
type Viewport = { transform: number[]; width: number; height: number }
type ViewportClass = new (init: {
  viewBox: number[]
  userUnit: number
  scale: number
  rotation: number
  offsetX?: number
  offsetY?: number
}) => Viewport

function pdfViewport(): ViewportClass {
  const source = read('node_modules/pdfjs-dist/build/pdf.mjs')
  const start = source.indexOf('class PageViewport {')
  const end = source.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start, 'pdf.js has no PageViewport class where this test looks for it')
  return runInNewContext(`${source.slice(start, end + 2)}; PageViewport`, {
    shadow: (_owner: unknown, _key: string, value: unknown) => value,
    Util: {},
  }) as ViewportClass
}

function onCanvas(viewport: Viewport, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = viewport.transform
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

test('the whole page renders exactly as the sheet always rendered it', () => {
  const base = { width: 960, height: 540 }
  const ratio = 2
  const w = 1084
  const region = regionViewport(base, w, null, ratio)
  close(region.scale, (w / base.width) * ratio)
  assert.equal(region.offsetX, -0)
  assert.equal(region.offsetY, -0)
  // The old code sized the canvas from the viewport: round(base · scale).
  assert.equal(region.width, Math.round(base.width * (w / base.width) * ratio))
  assert.equal(region.height, Math.round(base.height * (w / base.width) * ratio))
})

test('within the budget a zoomed region is drawn into a canvas the size of the frame, whatever the zoom', () => {
  // A US Letter page on a 900-px frame at ratio 2 is 4.2 megapixels whole:
  // within the computer's budget at ×4, so drawn as sharp as the frame is.
  const base = { width: 612, height: 792 }
  const whole = regionViewport(base, 900, null, 2, REGION_BUDGET.desktop)
  for (const z of [1.5, 2, 3.25, 3.9]) {
    const region = regionViewport(base, 900, { x: 0.1, y: 0.2, z }, 2, REGION_BUDGET.desktop)
    assert.equal(region.width, whole.width, `×${z} grew the canvas across`)
    assert.equal(region.height, whole.height, `×${z} grew the canvas down`)
    close(region.scale, whole.scale * z)
  }
})

test('past the budget a region is drawn at the scale the budget allows, smaller, never coarser than the whole page', () => {
  /*
   * pdf.js paints an image mask into a scratch canvas the size of the whole
   * mask at the render's scale (page-region.ts · `REGION_BUDGET`): the iPad
   * console's landscape sheet, 1084 CSS px at ratio 2, spans 42 megapixels
   * at ×4, past what iPadOS 17 gives a canvas, and the slide's text
   * vanished. The whole page at the region's scale stays within the budget.
   */
  const slide = { width: 960, height: 540 }
  const w = 1084
  const fitted = (w / slide.width) * 2
  const frame = regionViewport(slide, w, null, 2, REGION_BUDGET.touch)
  for (const z of [1.5, 2, 2.5, 3, 4]) {
    const region = regionViewport(slide, w, { x: 0.3, y: 0.4, z }, 2, REGION_BUDGET.touch)
    const spans = slide.width * region.scale * slide.height * region.scale
    assert.ok(spans <= REGION_BUDGET.touch * (1 + 1e-9), `×${z} spans ${(spans / 1e6).toFixed(1)} MP`)
    assert.ok(region.scale <= fitted * z * (1 + 1e-12), `×${z} is drawn finer than asked`)
    // The region still fills the canvas, now smaller, in the frame's shape:
    // the canvas's CSS size stretches it over the frame.
    assert.ok(region.width <= frame.width && region.height <= frame.height)
    close(region.width / region.height, frame.width / frame.height, 2e-3)
    close(region.width, (slide.width * region.scale) / z, 0.5)
    close(region.offsetX, -0.3 * slide.width * region.scale)
    close(region.offsetY, -0.4 * slide.height * region.scale)
  }
  // Sharp as the frame up to where the budget ends, a little after ×2.4 here.
  assert.equal(regionViewport(slide, w, { x: 0, y: 0, z: 2 }, 2, REGION_BUDGET.touch).width, frame.width)
  assert.ok(regionViewport(slide, w, { x: 0, y: 0, z: 2.5 }, 2, REGION_BUDGET.touch).width < frame.width)

  // The whole page is the sheet's own render, whatever the budget: a frame
  // larger than the budget renders as it always did, and its zooms no coarser.
  const huge = regionViewport(slide, 4000, null, 2, REGION_BUDGET.touch)
  close(huge.scale, (4000 / slide.width) * 2)
  assert.equal(huge.width, Math.round(slide.width * huge.scale))
  const closer = regionViewport(slide, 4000, { x: 0.5, y: 0.5, z: 2 }, 2, REGION_BUDGET.touch)
  close(closer.scale, huge.scale)
  close(closer.width, huge.width / 2, 0.5)
})

test('a phone or a tablet gets the small budget; a computer, the projector most often, the large one', () => {
  for (const touchPoints of [0, 5]) {
    for (const kind of ['ipad', 'iphone', 'android', 'android-tablet', 'other'] as const) {
      assert.equal(regionBudget(kind, touchPoints), REGION_BUDGET.touch, `${kind}, ${touchPoints} touch points`)
    }
    // A touch screen does not make a Mac, a Windows tablet-laptop or a Chromebook a phone.
    for (const kind of ['mac', 'windows', 'chromebook'] as const) {
      assert.equal(regionBudget(kind, touchPoints), REGION_BUDGET.desktop, `${kind}, ${touchPoints} touch points`)
    }
  }
  assert.equal(regionBudget('linux', 0), REGION_BUDGET.desktop)
  // Under iPadOS 17's 4096² per canvas.
  assert.ok(REGION_BUDGET.touch < 4096 * 4096)
  // A 1080p projector's sheet stays as sharp as the frame all the way to ×4.
  const projector = regionViewport({ width: 960, height: 540 }, 1888, { x: 0.375, y: 0.375, z: 4 }, 1, REGION_BUDGET.desktop)
  close(projector.scale, (1888 / 960) * 4)
})

test('an Android tablet in Chrome\'s desktop mode calls itself Linux, and still gets a tablet\'s budget', () => {
  /*
   * Chrome on a large Android tablet asks for the desktop site by default:
   * no "Android" in its name, only "X11; Linux x86_64". Taken for a computer,
   * it got the 64-megapixel budget, and a page-wide image mask at ×4 could
   * ask its tablet memory for a 256 MB scratch canvas again. Its touch
   * screen gives it away, as it gives away an iPad dressed as a Mac.
   */
  const desktopSite =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
  assert.equal(deviceKindOf(desktopSite, 10), 'linux')
  assert.equal(regionBudget(deviceKindOf(desktopSite, 10), 10), REGION_BUDGET.touch)
  assert.equal(regionBudget('linux', 2), REGION_BUDGET.touch)
  // A Linux desktop without a touch screen is a computer, a projector's most often.
  assert.equal(regionBudget(deviceKindOf(desktopSite, 0), 0), REGION_BUDGET.desktop)
  // One touch point is not enough to go by: the same line deviceKindOf draws for the iPad.
  assert.equal(regionBudget('linux', 1), REGION_BUDGET.desktop)
  // The iPad dressed as a Mac was a tablet already, by its kind.
  const iPadAsMac =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  assert.equal(regionBudget(deviceKindOf(iPadAsMac, 5), 5), REGION_BUDGET.touch)
  // On the tablet the region at ×4 is capped like an iPad's: the whole page within 16 MP.
  const capped = regionViewport({ width: 960, height: 540 }, 1280, { x: 0.3, y: 0.3, z: 4 }, 2, regionBudget('linux', 10))
  const spans = (capped.width * 4) * (capped.height * 4)
  assert.ok(spans <= REGION_BUDGET.touch * 1.001, `the whole page spans ${(spans / 1e6).toFixed(1)} MP`)
})

test('pdf.js draws exactly the region: its corners land on the canvas corners, every rotation, every budget', () => {
  const PageViewport = pdfViewport()
  const viewBox = [0, 0, 595.28, 841.89]
  const zoom: LectureZoom = { x: 0.3125, y: 0.1, z: 2.5 }
  const w = 1180
  const ratio = 2
  // At ×2.5 this A4 page spans 25 megapixels on its side and 49 upright: the
  // small budget lowers the scale, the large one does not, and both draw
  // exactly the region.
  for (const budget of [REGION_BUDGET.desktop, REGION_BUDGET.touch]) {
    for (const rotation of [0, 90, 180, 270]) {
      const base = new PageViewport({ viewBox, userUnit: 1, scale: 1, rotation })
      const whole = new PageViewport({ viewBox, userUnit: 1, scale: (w / base.width) * ratio, rotation })
      const region = regionViewport(base, w, zoom, ratio, budget)
      // How much smaller than the frame the region is drawn: 1 within the budget.
      const shrink = region.scale / (((w / base.width) * ratio) * zoom.z)
      if (budget === REGION_BUDGET.desktop) assert.equal(shrink, 1)
      else assert.ok(shrink < 0.9, `the small budget left ×${zoom.z} at ${shrink} of the frame`)
      const zoomed = new PageViewport({
        viewBox,
        userUnit: 1,
        scale: region.scale,
        rotation,
        offsetX: region.offsetX,
        offsetY: region.offsetY,
      })
      // Any point of the page: its place as a fraction of the displayed page
      // (what ink and the zoom are measured in), then where the zoomed render
      // puts it, which must be that fraction seen through the zoom.
      for (const [px, py] of [
        [0, 0],
        [595.28, 841.89],
        [100, 700],
        [480.5, 33.25],
      ]) {
        const flat = onCanvas(whole, px, py)
        const fx = flat.x / whole.width
        const fy = flat.y / whole.height
        const seen = onCanvas(zoomed, px, py)
        close(seen.x, (fx - zoom.x) * zoom.z * whole.width * shrink, 1e-6)
        close(seen.y, (fy - zoom.y) * zoom.z * whole.height * shrink, 1e-6)
      }
      // The visible region's corners are the canvas's corners.
      const corner = (fx: number, fy: number) => ({
        x: (fx - zoom.x) * zoom.z * whole.width * shrink,
        y: (fy - zoom.y) * zoom.z * whole.height * shrink,
      })
      close(corner(zoom.x, zoom.y).x, 0)
      close(corner(zoom.x + 1 / zoom.z, zoom.y + 1 / zoom.z).x, region.width, 0.5)
      close(corner(zoom.x + 1 / zoom.z, zoom.y + 1 / zoom.z).y, region.height, 0.5)
    }
  }
})

/* ----------------------------------------------------- the swap rule */

test('zooming out, the target picture covers every view on the way; zooming in, it covers none until arrival', () => {
  const near: LectureZoom = { x: 0.6, y: 0.1, z: 4 }
  const far: LectureZoom = { x: 0.5, y: 0, z: 2 }
  assert.ok(coversRegion(far, near), 'the wider region does not contain the closer one')

  // Out: from `near` to `far` (and to the whole page): the target covers each frame.
  for (const target of [far, null]) {
    const motion = new ZoomMotion(near)
    motion.aim(target, 0, 'ease')
    for (let now = 0; now <= 400; now += 16) {
      motion.step(now)
      assert.ok(coversRegion(target, motion.shown), `at ${now} ms the view left the target's picture`)
    }
  }

  // In: the old picture covers each frame, the target only once the view is
  // there (to within what nobody can see).
  const motion = new ZoomMotion(far)
  motion.aim(near, 0, 'glide')
  for (let now = 16; now <= 1000; now += 16) {
    motion.step(now)
    assert.ok(coversRegion(far, motion.shown), `at ${now} ms the view left the old picture`)
    const z = motion.shown?.z ?? 1
    if (coversRegion(near, motion.shown)) {
      // Short of the view by a thousandth would be a white sliver down each
      // side of the projector for the last frames of the motion.
      assert.ok(z > near.z * 0.999, `at ${now} ms a zoom-in picture went up at ×${z.toFixed(4)} of ×${near.z}`)
    }
  }
  assert.equal(motion.moving, false, 'the glide never arrived')
  assert.ok(coversRegion(near, motion.shown))
})

/* ------------------------------------------------- the sheet's zoom */

/** Run a sheet's motion to `until`, the way LecturePage's frames do. */
function play(sheet: SheetZoom, from: number, until: number, every = 16): number {
  let now = from
  while (now < until) {
    now += every
    if (!sheet.step(now)) break
  }
  return now
}

test('a sheet opens at its zoom at once, picture and ink alike', () => {
  const zoom: LectureZoom = { x: 0.2, y: 0.3, z: 2 }
  const sheet = new SheetZoom(4, zoom)
  assert.deepEqual(sheet.paintAt, zoom)
  assert.deepEqual(sheet.view, { painted: zoom, shown: zoom, css: '' })
  // Nothing on the canvas yet: the ink is drawn at the zoom the picture will come at.
  sheet.holds(4, zoom)
  assert.equal(sheet.view.css, '')
})

test('the ink repaints when the picture lands, not when it is asked for', () => {
  const near: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
  const sheet = new SheetZoom(3, null)
  sheet.holds(3, null)
  assert.equal(sheet.aim(3, near, 'ease', 0), true)
  const end = play(sheet, 0, 1000)
  // The view rested: the region is to be drawn sharp, and until it is, the
  // old picture (and the ink) are only moved there.
  assert.ok(sameRegion(sheet.paintAt, near))
  assert.equal(sheet.view.painted, null, 'the ink was told of a picture that is not on the canvas')
  assert.ok(sameRegion(sheet.view.shown, near))
  assert.notEqual(sheet.view.css, '')
  assert.ok(end >= EASE_MS + SETTLE_MS, 'the sharp redraw came before the view had rested')
  sheet.holds(3, sheet.paintAt)
  assert.ok(sameRegion(sheet.view.painted, near))
  assert.equal(sheet.view.css, '')
})

test('a jump is shown in the very frame it is made', () => {
  const sheet = new SheetZoom(1, null)
  sheet.holds(1, null)
  sheet.aim(1, { x: 0.5, y: 0.5, z: 2 }, 'jump', 0)
  assert.notEqual(sheet.view.css, '', 'the pinch waits for the next frame to move the picture')
  // And the picture is drawn sharp only once the fingers have rested.
  assert.equal(sheet.paintAt, null)
  sheet.step(SETTLE_MS - 1)
  assert.equal(sheet.paintAt, null)
  sheet.step(SETTLE_MS + 1)
  assert.ok(sameRegion(sheet.paintAt, { x: 0.5, y: 0.5, z: 2 }))
})

test('the hall eases a lone change and chases the stream of a pinch', () => {
  const target: LectureZoom = { x: 0.3, y: 0.2, z: 3 }
  // Alone: the console's quarter-second ease, arriving on time.
  const lone = new SheetZoom(2, null)
  lone.holds(2, null)
  lone.aim(2, target, 'glide', 1000)
  lone.step(1000 + EASE_MS)
  assert.ok(sameRegion(lone.motion.shown, target), 'a lone change did not arrive with the ease')
  // A stream: targets 40 ms apart are chased, a little behind each.
  const pinch = new SheetZoom(2, null)
  pinch.holds(2, null)
  let now = 1000
  for (let k = 1; k <= 6; k += 1) {
    pinch.aim(2, { x: 0.05 * k, y: 0.05 * k, z: 1 + k * 0.25 }, 'glide', now)
    now = play(pinch, now, now + 40)
  }
  assert.ok(pinch.motion.moving, 'a pinch in motion arrived at once, stepping through its frames')
  assert.ok(STREAM_MS > 40 * 2, 'the pointer tick, stretched by a lost frame, still counts as a stream')
})

test('a deliberate zoom is drawn ahead: out at once, in when the view arrives', () => {
  const near: LectureZoom = { x: 0.6, y: 0.1, z: 4 }
  // Out, to the whole page.
  const out = new SheetZoom(5, near)
  out.holds(5, near)
  out.aim(5, null, 'ease', 0)
  out.step(EARLY_MS)
  out.drawAhead()
  assert.equal(out.paintAt, null, 'the whole page was not drawn ahead')
  assert.ok(out.fits(out.paintAt), 'a zoom-out picture waited for the end of the motion')
  // In.
  const into = new SheetZoom(5, null)
  into.holds(5, null)
  into.aim(5, near, 'ease', 0)
  into.step(EARLY_MS)
  into.drawAhead()
  assert.ok(sameRegion(into.paintAt, near))
  assert.ok(!into.fits(into.paintAt), 'a zoom-in picture would go up into a white field')
  into.step(EASE_MS)
  assert.ok(into.fits(into.paintAt), 'the drawn-ahead picture never fits the view it was drawn for')
  // A view that has rested draws nothing ahead.
  const still = new SheetZoom(5, near)
  still.drawAhead()
  assert.ok(sameRegion(still.paintAt, near))
})

test('a page turn holds the old picture still until the new one lands, at the new page\'s zoom', () => {
  const zoomed: LectureZoom = { x: 0.25, y: 0.5, z: 2 }
  const sheet = new SheetZoom(7, zoomed)
  sheet.holds(7, zoomed)
  // Mid-motion toward somewhere else, then the presenter turns the page.
  sheet.aim(7, { x: 0, y: 0, z: 3 }, 'ease', 0)
  sheet.step(100)
  const before = sheet.view
  assert.equal(sheet.aim(8, null, 'glide', 120), false, 'a page turn is not a motion')
  assert.equal(sheet.paintAt, null, 'the new page is not drawn at its own zoom')
  assert.equal(sheet.view, before, 'the old slide was dragged to the new page\'s zoom')
  play(sheet, 120, 600)
  assert.equal(sheet.view, before, 'the old slide moved while the new one rendered')
  sheet.holds(8, null)
  assert.deepEqual(sheet.view, { painted: null, shown: null, css: '' })
  // A wiped canvas (the document went away) takes the ink to where the picture will come.
  sheet.holds(null, null)
  assert.equal(sheet.view.painted, null)
})

test('a turn away and back before either page rendered holds this page\'s old zoomed picture still', () => {
  /*
   * The projector on slide 7 at ×3; Next, and Back before slide 8 has
   * rendered. The server resets the zoom on both turns, and the canvas
   * still holds 7 at ×3: moved by CSS to the whole slide, it was the
   * formula as a small patch in a white field, the ink only inside it, for
   * the length of slide 7's render.
   */
  const near: LectureZoom = { x: 0.3, y: 0.4, z: 3 }
  const sheet = new SheetZoom(7, near)
  sheet.holds(7, near)
  const before = sheet.view
  sheet.aim(8, null, 'glide', 1000)
  sheet.aim(7, null, 'glide', 1100)
  assert.equal(sheet.paintAt, null, 'slide 7 is not drawn again at its new zoom')
  assert.equal(sheet.view, before, 'the old zoomed picture was shrunk onto the whole slide')
  assert.equal(sheet.view.css, '')
  play(sheet, 1100, 1600)
  assert.equal(sheet.view, before)
  // The fresh picture lands: the whole slide, picture and ink alike.
  sheet.holds(7, null)
  assert.deepEqual(sheet.view, { painted: null, shown: null, css: '' })

  // Back to a page the canvas holds at the very zoom it opens at: nothing to wait for.
  const same = new SheetZoom(7, null)
  same.holds(7, null)
  same.aim(8, null, 'glide', 0)
  same.aim(7, null, 'glide', 50)
  assert.deepEqual(same.view, { painted: null, shown: null, css: '' })
  // And a move made while the old picture is held moves nothing until the new one lands.
  const moving = new SheetZoom(7, near)
  moving.holds(7, near)
  moving.aim(8, null, 'glide', 0)
  moving.aim(7, null, 'glide', 50)
  const held = moving.view
  moving.aim(7, { x: 0.1, y: 0.1, z: 2 }, 'ease', 100)
  play(moving, 100, 1000)
  assert.equal(moving.view, held)
  moving.holds(7, moving.paintAt)
  assert.ok(sameRegion(moving.view.painted, { x: 0.1, y: 0.1, z: 2 }))
  assert.equal(moving.view.css, '')

  // A render that failed reports the old picture again (LecturePage keeps
  // it): the hold ends, and the view moves that picture with the zoom
  // instead of standing still for good.
  const failed = new SheetZoom(7, near)
  failed.holds(7, near)
  failed.aim(8, null, 'glide', 0)
  failed.aim(7, null, 'glide', 50)
  failed.holds(7, near)
  assert.ok(sameRegion(failed.view.painted, near))
  assert.equal(failed.view.shown, null)
  assert.notEqual(failed.view.css, '')
})

/**
 * The page's side of a sheet's zoom, the way LecturePage runs it: the
 * frames, the draw-ahead timer, and a render of `renderMs` that goes up once
 * it fits the view (`fits`) and reports itself (`holds`). Returns the time
 * it stopped at. `renderMs` is unused by a render already under way when
 * the drive begins: that one was dropped, as the page's effect drops it.
 */
function drive(
  sheet: SheetZoom,
  page: number,
  from: number,
  until: number,
  renderMs: number,
  drawAheadAt: number | null,
): number {
  // A render is started by a region asked for while driving; the one the
  // canvas already holds is not drawn again.
  let asked = sheet.paintAt
  let ready = Number.POSITIVE_INFINITY
  let now = from
  while (now < until) {
    now += 16
    if (drawAheadAt !== null && now >= drawAheadAt) {
      sheet.drawAhead()
      drawAheadAt = null
    }
    sheet.step(now)
    // A new region asked for: the render starts over.
    if (sheet.paintAt !== asked) {
      asked = sheet.paintAt
      ready = now + renderMs
    }
    if (now >= ready && sheet.fits(asked)) {
      sheet.holds(page, asked)
      ready = Number.POSITIVE_INFINITY
    }
  }
  return now
}

test('a region drawn ahead is what the motion counts as painted: a pinch straight back still gets its sharp picture', () => {
  /*
   * The magnifier frames a formula: an ease, drawn ahead at EARLY_MS, and
   * the region goes up when the view arrives. Then, before the settle, two
   * fingers pinch all the way back out to the whole slide without a pause.
   * The motion still counted the whole slide as painted, so the view
   * resting there was "nothing to redraw", and the console stayed on the
   * framed region alone, shrunk into a white sheet, for good.
   */
  const near: LectureZoom = { x: 0.3, y: 0.4, z: 3 }
  for (const renderMs of [40, 120]) {
    const sheet = new SheetZoom(1, null)
    sheet.holds(1, null)
    assert.equal(sheet.aim(1, near, 'ease', 0), true)
    // Up to the arrival, and the drawn-ahead region lands.
    let now = drive(sheet, 1, 0, EASE_MS + 16, renderMs, EARLY_MS)
    assert.ok(sameRegion(sheet.view.painted, near), `the drawn-ahead region (${renderMs} ms) never went up`)
    // The pinch, before the settle: frames straight back to the whole slide.
    assert.ok(now < EASE_MS + SETTLE_MS)
    for (const z of [2.4, 1.8, 1.3, 1.01]) {
      sheet.aim(1, z > 1.02 ? { x: 0.5 - 0.5 / z, y: 0.5 - 0.5 / z, z } : null, 'jump', now)
      now = drive(sheet, 1, now, now + 16, renderMs, null)
    }
    assert.equal(sheet.motion.shown, null)
    drive(sheet, 1, now, now + 1000, renderMs, null)
    assert.equal(sheet.paintAt, null, 'the whole slide is never drawn again')
    assert.deepEqual(sheet.view, { painted: null, shown: null, css: '' })
  }

  // The pinch comes before the drawn-ahead region has landed: it is not
  // left waiting for a view that went elsewhere.
  const sheet = new SheetZoom(1, null)
  sheet.holds(1, null)
  sheet.aim(1, near, 'ease', 0)
  let now = drive(sheet, 1, 0, EARLY_MS + 32, 1000, EARLY_MS)
  assert.ok(sameRegion(sheet.paintAt, near))
  sheet.aim(1, null, 'jump', now)
  now = drive(sheet, 1, now, now + 2000, 100, null)
  assert.equal(sheet.paintAt, null)
  assert.deepEqual(sheet.view, { painted: null, shown: null, css: '' })
})

test('a zoomed render that fails is tried once more coarser, and a failure keeps this page\'s own picture', () => {
  const sheet = code('web/src/components/lecture/LecturePage.svelte')
  // Once more at half the scale, unless it was cancelled or was the whole page.
  assert.match(sheet, /if \(dropped \|\| at === null\) throw error\s*done = await paintSheet\(sheet, node, w, at, \(\) => dropped, true\)/)
  assert.match(sheet, /if \(coarse\) \{[^}]*regionViewport\(base, w, at, ratio, area \/ 4\)/)
  // Wiped only when the canvas holds another page: this page's picture
  // stays, and is reported again, so that the view goes on moving it.
  assert.match(
    sheet,
    /if \(!dropped\) \{\s*if \(shownNow !== index\) \{\s*wipe\(node\)\s*canvasZoom = at\s*\}\s*show\(index\)/,
  )
})

test('a motion ends exactly on its target: no sub-pixel transform is left on the sharp picture', () => {
  // A pan at ×2: the ease is taken as arrived a hair short of the target,
  // and the hair used to stay on the canvas as translate(-0.003%, 0.003%).
  const from: LectureZoom = { x: 0.5, y: 0, z: 2 }
  const to: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
  for (const frame of [16, 16.7, 7]) {
    const sheet = new SheetZoom(1, from)
    sheet.holds(1, from)
    sheet.aim(1, to, 'ease', 0)
    play(sheet, 0, 2000, frame)
    assert.equal(sheet.motion.shown, sheet.motion.target, `frames of ${frame} ms stopped short of the target`)
    sheet.holds(1, sheet.paintAt)
    assert.ok(sameRegion(sheet.view.painted, to))
    assert.equal(sheet.view.css, '', `a resting view left "${sheet.view.css}" on the bitmaps`)
  }
})

test('the same region again is no target at all', () => {
  const zoom: LectureZoom = { x: 0.1, y: 0.1, z: 2 }
  const sheet = new SheetZoom(1, zoom)
  sheet.holds(1, zoom)
  const view = sheet.view
  assert.equal(sheet.aim(1, { ...zoom }, 'glide', 0), false)
  assert.equal(sheet.aim(1, { x: 0.10004, y: 0.1, z: 2 }, 'ease', 10), false)
  assert.equal(sheet.view, view)
})

test('the whole page covers anything, and nothing covers more than itself', () => {
  assert.ok(coversRegion(null, { x: 0.75, y: 0.75, z: 4 }))
  assert.ok(coversRegion(null, null))
  assert.ok(!coversRegion({ x: 0, y: 0, z: 2 }, null))
  assert.ok(!coversRegion({ x: 0, y: 0, z: 2 }, { x: 0.5, y: 0, z: 2 }), 'a pan is covered by neither end')
})

/* ----------------------------------------------------------- paper */

test('plain paper draws nothing: the projection stays a clear field', () => {
  const marks = paperMarks('plain', 3200, 1800, null)
  assert.deepEqual(marks.lines, [])
  assert.deepEqual(marks.dots, [])
  // And so does a paper this build does not know (a newer server's).
  const unknown = paperMarks('felt' as never, 3200, 1800, null)
  assert.equal(unknown.lines.length + unknown.dots.length, 0)
})

function verticals(lines: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i += 4) if (lines[i] === lines[i + 2]) out.push(lines[i])
  return out
}

function horizontals(lines: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i += 4) if (lines[i + 1] === lines[i + 3]) out.push(lines[i + 1])
  return out
}

function steps(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.slice(1).map((v, i) => v - sorted[i])
}

test('grid paper: square cells, a thirty-second of the width, crisp on the pixel', () => {
  const W = 3200
  const H = 1800
  const marks = paperMarks('grid', W, H, null)
  const xs = verticals(marks.lines)
  const ys = horizontals(marks.lines)
  assert.equal(xs.length, PAPER_SQUARES - 1, 'no rule on the page edges, one between every two squares')
  assert.equal(ys.length, 17, 'a 16:9 page is 18 squares tall')
  for (const step of [...steps(xs), ...steps(ys)]) close(step, W / PAPER_SQUARES, 1)
  // A one-pixel rule sits on a pixel, not between two.
  assert.equal(marks.width, 1)
  for (const x of xs) close(x % 1, 0.5)
  // Square on a page of another shape too.
  const a4 = paperMarks('grid', 2100, 2970, null)
  for (const step of [...steps(verticals(a4.lines)), ...steps(horizontals(a4.lines))]) close(step, 2100 / PAPER_SQUARES, 1)
})

test('the paper zooms with the page: twice as close, twice as far apart, only a little heavier', () => {
  const W = 3200
  const H = 1800
  const zoom: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
  const marks = paperMarks('grid', W, H, zoom)
  // By the root of the zoom: a grid scaled like the ink shouts over the writing.
  close(marks.width, Math.SQRT2)
  close(paperMarks('grid', W, H, { x: 0, y: 0, z: 4 }).width, 2)
  const xs = verticals(marks.lines)
  for (const step of steps(xs)) close(step, (2 * W) / PAPER_SQUARES, 1)
  // Only what the region shows: half the page across, so about half the rules.
  assert.ok(xs.length <= PAPER_SQUARES / 2 + 1, `${xs.length} rules for half a page`)
  for (let i = 0; i < marks.lines.length; i += 4) {
    for (const [v, size] of [
      [marks.lines[i], W],
      [marks.lines[i + 1], H],
      [marks.lines[i + 2], W],
      [marks.lines[i + 3], H],
    ] as const) {
      assert.ok(v >= -marks.width && v <= size + marks.width, `a rule at ${v} lies outside the canvas`)
    }
  }
  // At the closest zoom a corner of the page is still a handful of rules.
  const closest = paperMarks('dots', W, H, { x: 0.75, y: 0.75, z: 4 })
  assert.ok(closest.dots.length / 2 <= 9 * 6, `${closest.dots.length / 2} dots in a sixteenth of the page`)
})

test('lined paper: a rule per line of handwriting and a margin; dots stand on the grid', () => {
  const W = 2400
  const H = 1800
  const lined = paperMarks('lines', W, H, null)
  assert.equal(horizontals(lined.lines).length, PAPER_RULES - 1)
  const margin = verticals(lined.lines)
  assert.equal(margin.length, 1, 'lined paper has one margin')
  close(margin[0], W * PAPER_MARGIN, 1)
  const dots = paperMarks('dots', W, H, null)
  // 4:3: 32 × 24 squares, so 31 × 23 inner crossings.
  assert.equal(dots.dots.length / 2, 31 * 23)
  assert.ok(dots.radius > dots.width, 'a dot thinner than a rule disappears')
})

test('the projector gets the rules a little stronger, never darker than a quiet blue-grey', () => {
  const screen = paperMarks('grid', 1920, 1080, null)
  const beam = paperMarks('grid', 1920, 1080, null, true)
  assert.ok(beam.width > screen.width)
  assert.notEqual(beam.color, screen.color)
  for (const color of [screen.color, beam.color]) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    // Light, and blue-leaning: a rule must never read as ink.
    assert.ok(Math.min(r, g, b) >= 0xa0, `${color} is too dark for paper`)
    assert.ok(b >= r && b >= g, `${color} is not blue-grey`)
  }
})

/* ----------------------------------------------- the laptop bar walk */

const SHEETS: LectureSheet[] = [
  { page: -1, after: 2 },
  { page: -2, after: 2 },
  { page: -3, after: 0 },
  { page: -4, after: 5, paper: 'grid' },
]

test('the bar walks slides with their sheets in place, the console\'s order', () => {
  const length = walkLength(5, SHEETS, 2, 2)
  assert.equal(length, 5)
  const sequence = lectureSequence(length, SHEETS)
  assert.deepEqual(sequence, [-3, 1, 2, -1, -2, 3, 4, 5, -4])
  const step = (from: number, dir: 1 | -1) => walkStep(sequence, length, from, dir, 2)
  // Forward from a sheet goes on to the next sheet, then to the next slide:
  // not back to the slides from any sheet, as the bar used to.
  assert.equal(step(2, 1), -1)
  assert.equal(step(-1, 1), -2)
  assert.equal(step(-2, 1), 3)
  assert.equal(step(-2, -1), -1)
  assert.equal(step(-1, -1), 2)
  // A sheet before the first slide has a "back" from slide 1, and nothing before it.
  assert.equal(step(1, -1), -3)
  assert.equal(step(-3, -1), null)
  // The sheet after the last slide is the very end.
  assert.equal(step(5, 1), -4)
  assert.equal(step(-4, 1), null)
})

test('a sheet the list does not know goes back to the slide the hall last saw', () => {
  const sequence = lectureSequence(5, SHEETS)
  // Deleted a moment ago, or an older server that keeps no list.
  assert.equal(walkStep(sequence, 5, -9, 1, 4), 4)
  assert.equal(walkStep(sequence, 5, -9, -1, 4), 4)
  assert.equal(walkStep(lectureSequence(5, undefined), 5, -1, 1, 3), 3)
})

test('an unopened deck is walked one slide past what anybody here has seen', () => {
  // On slide 3, the deck unknown: one past it, or past a slide a sheet stands after.
  assert.equal(walkLength(0, [], 3, 3), 4)
  assert.equal(walkLength(0, SHEETS, 3, 3), 6)
  assert.equal(walkLength(0, [], -2, 7), 8)
  const length = walkLength(0, [], 3, 3)
  const sequence = lectureSequence(length, [])
  assert.equal(walkStep(sequence, length, 3, 1, 3), 4)
  assert.equal(walkStep(sequence, length, 4, 1, 3), null, 'a held arrow ran past a deck nobody has seen')
  // A page past the end of the deck (it was replaced by a shorter one) only goes back, to the last slide.
  assert.equal(walkStep(lectureSequence(5, []), 5, 9, 1, 5), null)
  assert.equal(walkStep(lectureSequence(5, []), 5, 9, -1, 5), 5)
})

test('a sheet is named by its place: "sheet 2 of 4", in both languages', () => {
  const sequence = lectureSequence(5, SHEETS)
  assert.deepEqual(sheetPlace(sequence, -3), { n: 1, total: 4 })
  assert.deepEqual(sheetPlace(sequence, -1), { n: 2, total: 4 })
  assert.deepEqual(sheetPlace(sequence, -4), { n: 4, total: 4 })
  assert.equal(sheetPlace(sequence, 2), null)
  assert.equal(sheetPlace(sequence, -9), null)
  assert.equal(translate('ru', 'room.lecture4.sheetOf', { n: 2, total: 4 }), 'лист 2 из 4')
  assert.equal(translate('en', 'room.lecture4.sheetOf', { n: 2, total: 4 }), 'sheet 2 of 4')
  for (const [key, pair] of Object.entries(roomMessages)) {
    if (!key.startsWith('room.lecture4.')) continue
    assert.doesNotMatch(String(pair.en), /[А-Яа-яЁё]/, `${key} has Russian in English`)
  }
})

test('the laptop bar steps through the walk and greys its arrows where the walk ends', () => {
  const view = code('web/src/components/lecture/LectureView.svelte')
  const turn = view.slice(view.indexOf('function turn('), view.indexOf('function go('))
  assert.match(turn, /walkStep\(sequence, deckLength, wanted \?\? page, step, lastSlide\)/)
  // The old arithmetic that sent "forward" from any sheet back to the slides.
  assert.doesNotMatch(view, /from \+ 1 : lastSlide/)
  assert.match(view, /const sequence = \$derived\(lectureSequence\(deckLength, lecture\.sheets\)\)/)
  assert.match(view, /disabled=\{backTo === null\}/)
  assert.match(view, /disabled=\{nextTo === null\}/)
  // The room's screens say which sheet; the projection says nothing at all.
  assert.ok((view.match(/sheetWords\(tr\(/g) ?? []).length >= 4, 'a sheet is a bare "blank sheet" again somewhere')
  const projection = view.slice(view.indexOf("{#if role === 'projection'}"), view.indexOf('<section'))
  assert.doesNotMatch(projection, /sheetWords|lecture4/, 'the projection shows the hall words')
})

/* --------------------------------------------------- the zoomed sheet */

test('every hall screen shows the session\'s zoom and the sheet\'s paper, and hands the view to the ink', () => {
  const view = code('web/src/components/lecture/LectureView.svelte')
  assert.match(
    view,
    /const zoom = \$derived\(session\.zoomNow !== null && session\.zoomNow\.page === page \? session\.zoomNow\.zoom : null\)/,
  )
  const pages = view.match(/<LecturePage \{doc\} \{page\} \{onshown\}[^>]*>/g) ?? []
  assert.equal(pages.length, 2, 'the projection and the room each lost their sheet')
  for (const tag of pages) {
    assert.match(tag, /\{zoom\} zoomHow="glide" \{paper\}/, `${tag} does not follow the hall's zoom`)
  }
  assert.match(pages[0], /\bprojector\b/, 'the projection draws the paper as faint as a laptop')
  assert.equal((view.match(/\{#snippet over\(size, view\)\}/g) ?? []).length, 2)
  assert.equal((view.match(/zoom=\{view\}/g) ?? []).length, 2, 'the ink does not move with the page')
})

test('the page frame clips the moving picture without cutting the ink off the page', () => {
  const sheet = code('web/src/components/lecture/LecturePage.svelte')
  // The region render: offsets into a frame-sized canvas (or smaller, past
  // the device's budget), through the old swap.
  assert.match(sheet, /regionViewport\(base, w, at, ratio, budget\)/)
  // The budget asks the touch screen as well as the name (an Android tablet in
  // Chrome's desktop mode calls itself Linux).
  assert.match(sheet, /const budget = regionBudget\(deviceKind\(\), touchPoints\(\)\)/)
  assert.match(sheet, /import \{ deviceKind, touchPoints \} from '@\/lib\/device'/)
  assert.match(sheet, /offsetX: region\.offsetX,\s*offsetY: region\.offsetY/)
  assert.match(sheet, /paint\.drawImage\(buffer, 0, 0\)\s*\n\s*\/\/[^\n]*\n\s*canvasZoom = at/)
  // The picture moves by the view, from its top-left corner, inside a frame
  // that clips by overflow alone.
  const frame = /<div class="([^"]*)">\s*<canvas\s+bind:this=\{canvas\}\s+class="([^"]*)"\s+style:transform=\{view\.css \|\| null\}/.exec(sheet)
  assert.ok(frame, 'the canvas is no longer moved by the view inside its own frame')
  assert.match(frame[1], /\boverflow-hidden\b/)
  assert.match(frame[2], /\borigin-top-left\b/)
  /*
   * Nothing between the page and the ink may make a stacking context: the
   * ink's highlighter multiplies with the page only inside one. The frame
   * and the sheet carry no transform, filter, isolation or z-index (the
   * sheet's opacity belongs to the console's "next" thumbnail, which has no
   * ink).
   */
  const sheetDiv = /<div\s+class="relative \{bare \? '' : 'shadow-pop'\} \{dim \? 'opacity-70' : ''\}"/.exec(sheet)
  assert.ok(sheetDiv, 'the sheet gained classes this test does not know')
  for (const classes of [frame[1]]) {
    assert.doesNotMatch(classes, /\b(z-|isolate|transform|translate|scale|opacity|blur|filter|will-change)/)
  }
  // The ink is laid over the sheet, not inside the clip: the console's input
  // layer and feathering reach past the page.
  assert.match(sheet, /<\/div>\s*\{@render over\?\.\(fit, view\)\}\s*<\/div>/)
  // The motion is driven by frames and by a timer (a covered projector
  // window gets no frames), by the decisions the tests above hold.
  assert.match(sheet, /requestAnimationFrame\(tick\)/)
  assert.match(sheet, /setTimeout\(tick, LATE_MS\)/)
  assert.match(sheet, /zoomer\.aim\(at, target, how, performance\.now\(\)\)/)
  assert.match(sheet, /zoomer\.holds\(at, canvasZoom\)/)
  // A picture drawn ahead goes up only once it fits the view.
  assert.match(sheet, /if \(!zoomer\.fits\(at\)\) await until\(\(\) => dropped\(\) \|\| zoomer\.fits\(at\)\)/)
})

test('a render keeps going in a window that gets no frames', () => {
  /*
   * pdf.js hands `onContinue` its own `_scheduleNext`, which waits for yet
   * another animation frame unless told not to: the sheet's timeout used to
   * pass the baton to a runner who waited for the frame anyway, and a
   * projector window without frames rendered neither a page turn nor a zoom
   * (measured in Chrome with frames stopped). The flag is internal to the
   * pinned pdf.js: if it moves, this says so before the projector does.
   */
  const sheet = code('web/src/components/lecture/LecturePage.svelte')
  assert.match(sheet, /internal\._useRequestAnimationFrame = false/)
  assert.match(sheet, /task\.onContinue = \(next: \(\) => void\) => \{/)
  const pdf = read('node_modules/pdfjs-dist/build/pdf.mjs')
  assert.match(pdf, /this\._scheduleNextBound = this\._scheduleNext\.bind\(this\)/)
  assert.match(pdf, /_scheduleNext\(\) \{\s*if \(this\._useRequestAnimationFrame\) \{/)
  assert.match(pdf, /this\.task\.onContinue\(this\._scheduleNextBound\)/)
  assert.match(pdf, /class RenderTask \{\s*_internalRenderTask = null;/)
})

/* ---------------------------------------------------- read on my own */

test('"Read on my own" is reset by a new lecture, not by every frame of this one', () => {
  const screen = code('web/src/screens/SessionScreen.svelte')
  // Every lecture frame is a new object: an effect that reads a field of it
  // re-runs on every page turn, and pulled the student back each time.
  assert.doesNotMatch(screen, /void lecture\?\.file/)
  assert.match(
    screen,
    /const lectureKey = \$derived\(lecture === null \? null : `\$\{lecture\.startedAt\}:\$\{lecture\.file\}`\)/,
  )
  assert.match(screen, /\$effect\(\(\) => \{\s*void lectureKey\s*untrack\(\(\) => \(soloRead = false\)\)\s*\}\)/)
})
