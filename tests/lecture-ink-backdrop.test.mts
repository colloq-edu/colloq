/**
 * The highlighter on a dark slide, and on a mixed one: the sheet decides
 * from its own picture whether the page under the ink is light, dark or
 * both, and the ink's marker canvas multiplies with a light one, screens a
 * dark one and lies plainly over a mixed one
 * (web/src/components/lecture/page-region.ts · `InkBackdrop`, and the style
 * of LecturePage.svelte):
 *
 *  • the decision: the picture's pixels, translucent ones laid over the
 *    sheet's own ground, counted into the very light (where screen loses a
 *    highlight) and the very dark (where multiply does); a blend that would
 *    lose it on a tenth of the picture is out, both out is mixed, and a page
 *    neither blend loses goes by its mean against `DARK_BELOW`; a blank
 *    sheet is its paper;
 *  • the cases it is for, on probes made the way the browser makes them: a
 *    white slide with text stays light and a navy one dark, a white plot on
 *    a navy slide and an X-ray on a white one are mixed, and a zoom into the
 *    X-ray is dark;
 *  • why: with the five real highlighters, multiply on a dark slide changes
 *    nothing anybody could see and screen draws a plain band, while on a
 *    light one multiply keeps black text black under the highlight; the
 *    bins sit where each blend loses them, and plain blending shows them on
 *    every ground;
 *  • the page reads its canvas into a tiny one once per picture that lands,
 *    and carries the answer on its root, where rules that out-rank the ink
 *    layer's own `multiply` (both compiled here) switch the blend.
 *
 * Pure arithmetic is called; the components are held by their source and by
 * the CSS the Svelte compiler makes of them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compile } from 'svelte/compiler'
import {
  backdropOf,
  backdropOfColor,
  DARK_BELOW,
  LOST_SHARE,
  luminance,
  PAPER_GROUND,
  SLIDE_GROUND,
  tonesOf,
  VERY_DARK,
  VERY_LIGHT,
  type InkBackdrop,
} from '../web/src/components/lecture/page-region.js'
import { DARK_PAPER, MARKERS } from '../web/src/components/lecture/pult.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** The source without comments: an explanation is not a promise. */
function code(rel: string): string {
  return read(rel)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const close = (a: number, b: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`)

type Rgb = [number, number, number]

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb
}

const WHITE: Rgb = [255, 255, 255]
/** The slide text the pens are measured against. */
const TEXT: Rgb = [16, 26, 51]
const NAVY = rgb(DARK_PAPER)

/** A picture of `count` pixels, `share` of them `ink` and the rest `ground`, as getImageData hands it out. */
function picture(ground: Rgb, ink: Rgb, share: number, count = 576): Uint8ClampedArray {
  const out = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i += 1) {
    const [r, g, b] = i < Math.round(count * share) ? ink : ground
    out.set([r, g, b, 255], i * 4)
  }
  return out
}

/* ---------------------------------------------------------- deciding */

test("relative luminance is WCAG's, and a picture is counted over its ground", () => {
  close(luminance(255, 255, 255), 1)
  close(luminance(0, 0, 0), 0)
  // Mid-grey is a fifth of white's light, not a half.
  close(luminance(128, 128, 128), 0.2158605, 1e-6)
  // White slide, a twentieth of it black text: light.
  const slide = tonesOf(picture(WHITE, TEXT, 0.05))
  assert.ok(slide.mean > 0.9, `${slide.mean}`)
  close(slide.light, 0.95, 2e-3)
  close(slide.dark, 0.05, 2e-3)
  assert.equal(backdropOf(slide), 'light')
  // A dark theme with a twentieth of it white text: dark.
  const night = tonesOf(picture(NAVY, WHITE, 0.05))
  assert.ok(night.mean < 0.15, `${night.mean}`)
  assert.equal(backdropOf(night), 'dark')
  // A canvas with nothing on it is its ground: a slide's white, a sheet's paper.
  const clear = new Uint8ClampedArray(64 * 4)
  assert.deepEqual(tonesOf(clear), { mean: 1, light: 1, dark: 0 })
  close(tonesOf(clear, PAPER_GROUND).mean, luminance(...rgb(PAPER_GROUND)))
  assert.deepEqual(tonesOf(new Uint8ClampedArray(0), DARK_PAPER), {
    mean: luminance(...NAVY),
    light: 0,
    dark: 1,
  })
  // Half-transparent black over white is the grey the browser shows.
  close(tonesOf(Uint8ClampedArray.from([0, 0, 0, 128])).mean, luminance(127, 127, 127), 2e-3)
  // The bins' edges belong to them, and what lies between them to neither.
  const greyOf = (l: number) => {
    let lo = 0
    let hi = 255
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2
      if (luminance(mid, mid, mid) < l) lo = mid
      else hi = mid
    }
    return tonesOf([hi, hi, hi, 255])
  }
  assert.equal(greyOf(VERY_LIGHT).light, 1)
  assert.equal(greyOf(VERY_LIGHT - 1e-4).light, 0)
  assert.equal(greyOf(VERY_DARK - 1e-4).dark, 1)
  assert.equal(greyOf(VERY_DARK + 1e-4).dark, 0)
  const between = greyOf((VERY_LIGHT + VERY_DARK) / 2)
  assert.equal(between.light + between.dark, 0)
})

test('a blend that would lose the highlight on a tenth of the page is out; both out is mixed', () => {
  const page = (mean: number, light: number, dark: number): InkBackdrop =>
    backdropOf({ mean, light, dark })
  assert.equal(LOST_SHARE, 0.1)
  // Neither out: the mean, as for one colour.
  assert.equal(page(DARK_BELOW - 1e-9, 0, 0), 'dark')
  assert.equal(page(DARK_BELOW, 0, 0), 'light')
  assert.equal(page(0.9, 0.95, LOST_SHARE - 1e-9), 'light')
  assert.equal(page(0.05, LOST_SHARE - 1e-9, 0.9), 'dark')
  // Both out: mixed, whatever the mean.
  assert.equal(page(0.2, LOST_SHARE, 0.8), 'mixed')
  assert.equal(page(0.7, 0.7, LOST_SHARE), 'mixed')
  // One out: the other blend, whatever the mean. A grey slide with a dark
  // photograph averages light, and multiply would lose the photograph.
  assert.equal(page(0.42, 0, 0.2), 'dark')
  assert.equal(page(0.3, 0.15, 0), 'light')
  assert.ok(
    DARK_BELOW > 0.25 && DARK_BELOW < 0.45,
    'the line left the range where both blends show a highlight',
  )
})

test('a page of one colour is light or dark, never mixed', () => {
  // A blank sheet is its paper, which is light; the dark paper of the light pens is dark.
  assert.equal(backdropOfColor(PAPER_GROUND), 'light')
  assert.equal(backdropOfColor(SLIDE_GROUND), 'light')
  assert.equal(backdropOfColor(DARK_PAPER), 'dark')
  assert.equal(backdropOfColor('#000'), 'dark')
  assert.equal(backdropOfColor('#fff'), 'light')
  // What cannot be read is light: the highlighter as it always was.
  assert.equal(backdropOfColor('transparent'), 'light')
  // Every grey goes by its luminance against the old line, as it did before
  // there were three answers.
  for (let v = 0; v <= 255; v += 1) {
    const hex = `#${v.toString(16).padStart(2, '0').repeat(3)}`
    assert.equal(backdropOfColor(hex), luminance(v, v, v) < DARK_BELOW ? 'dark' : 'light', hex)
  }
})

/* ------------------------------------------------------ the cases */

/** The probe LecturePage shrinks its canvas into. */
const PROBE_W = 32
const PROBE_H = 18
/** Samples per probe cell along each side, averaged into the cell. */
const FINE = 8

type Paint = Rgb | ((u: number, v: number) => Rgb)

interface Shape {
  /** Left, top, width and height, in page fractions. */
  x: number
  y: number
  w: number
  h: number
  color: Paint
  /**
   * How much of the area the colour covers: 1 for a solid shape, a little
   * for a line of text, which the probe sees as its average.
   */
  cover?: number
}

/**
 * A page as the probe sees it, `shapes` painted over `ground` in order: each
 * cell the average of what lies in it, the way the browser shrinks a canvas
 * with smoothing at its best, so a shape that covers a cell partly gives it
 * a colour in between. `view` is the region on the sheet (a zoom): the probe
 * reads what is painted, so it sees only that.
 */
function probe(ground: Rgb, shapes: Shape[], view = { x: 0, y: 0, z: 1 }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(PROBE_W * PROBE_H * 4)
  for (let cy = 0; cy < PROBE_H; cy += 1) {
    for (let cx = 0; cx < PROBE_W; cx += 1) {
      const sum = [0, 0, 0]
      for (let sy = 0; sy < FINE; sy += 1) {
        for (let sx = 0; sx < FINE; sx += 1) {
          const px = view.x + (cx + (sx + 0.5) / FINE) / PROBE_W / view.z
          const py = view.y + (cy + (sy + 0.5) / FINE) / PROBE_H / view.z
          let color: Rgb = ground
          for (const shape of shapes) {
            const u = (px - shape.x) / shape.w
            const v = (py - shape.y) / shape.h
            if (u < 0 || u >= 1 || v < 0 || v >= 1) continue
            const ink = typeof shape.color === 'function' ? shape.color(u, v) : shape.color
            const cover = shape.cover ?? 1
            color = color.map((c, i) => c * (1 - cover) + ink[i] * cover) as Rgb
          }
          for (let i = 0; i < 3; i += 1) sum[i] += color[i]
        }
      }
      const n = FINE * FINE
      out.set([sum[0] / n, sum[1] / n, sum[2] / n, 255], (cy * PROBE_W + cx) * 4)
    }
  }
  return out
}

/** A slide's words: a bold title and lines of body text, as the probe averages them. */
function words(ink: Rgb, top = 0.07): Shape[] {
  const out: Shape[] = [{ x: 0.06, y: top, w: 0.6, h: 0.08, color: ink, cover: 0.3 }]
  for (let line = 0; line < 7; line += 1) {
    const w = 0.55 + ((line * 37) % 30) / 100
    out.push({ x: 0.07, y: top + 0.17 + line * 0.093, w, h: 0.045, color: ink, cover: 0.14 })
  }
  return out
}

/**
 * A matplotlib figure on white over a share of the slide, its corner at
 * (x, y): axes, tick labels and a curve take some of the white away.
 */
function plot(share: number, x: number, y: number): Shape[] {
  const w = Math.sqrt(share * (16 / 9) * 1.4) / (16 / 9)
  const h = share / w
  const at = (fx: number, fy: number, fw: number, fh: number, color: Rgb, cover = 1): Shape => ({
    x: x + fx * w,
    y: y + fy * h,
    w: fw * w,
    h: fh * h,
    color,
    cover,
  })
  return [
    at(0, 0, 1, 1, WHITE),
    // The axes, a hair each.
    at(0.12, 0.08, 0.01, 0.78, [0, 0, 0], 0.4),
    at(0.12, 0.85, 0.83, 0.012, [0, 0, 0], 0.5),
    // Tick labels under the x axis and left of the y axis.
    at(0.12, 0.88, 0.83, 0.07, [0, 0, 0], 0.15),
    at(0.02, 0.08, 0.08, 0.76, [0, 0, 0], 0.12),
    // A curve across the plot, two cells high, and a title over it.
    at(0.15, 0.3, 0.78, 0.25, [31, 119, 180], 0.12),
    at(0.3, 0.01, 0.4, 0.05, [0, 0, 0], 0.2),
  ]
}

/** An X-ray: a black field, the body in dark greys, ribs and spine lighter. */
function xray(u: number, v: number): Rgb {
  const du = u - 0.5
  const dv = v - 0.5
  const body = (du * du) / 0.16 + (dv * dv) / 0.22
  if (body >= 1) return [12, 12, 12]
  let g = 55 + 30 * (1 - body)
  if (Math.abs(Math.sin(dv * 28)) > 0.8 && Math.abs(du) > 0.06) g += 70
  if (Math.abs(du) < 0.04) g += 90
  return [g, g, g]
}

/** A photograph in middle tones, neither very light nor very dark anywhere. */
function midtones(u: number, v: number): Rgb {
  const g = 120 + 25 * Math.sin(u * 23) * Math.cos(v * 17)
  return [g, g * 0.96, g * 0.92]
}

function decide(rgba: Uint8ClampedArray, ground = SLIDE_GROUND): InkBackdrop {
  return backdropOf(tonesOf(rgba, ground))
}

test('a white slide with text stays light, and a navy one with white text stays dark', () => {
  assert.equal(decide(probe(WHITE, words(TEXT))), 'light')
  assert.equal(decide(probe(NAVY, words(WHITE))), 'dark')
  // A big black heading a third of the slide high is still a light slide.
  assert.equal(decide(probe(WHITE, [{ x: 0.05, y: 0.3, w: 0.9, h: 1 / 3, color: TEXT, cover: 0.45 }])), 'light')
  /*
   * A browser that SAMPLED the canvas instead of averaging it would hand
   * back cells of pure ink where the text is: a dense slide's ink is some
   * eight per cent of it, and still not a share either blend is out for.
   */
  assert.equal(decide(picture(WHITE, TEXT, 0.08)), 'light')
  assert.equal(decide(picture(NAVY, WHITE, 0.08)), 'dark')
})

test('a white plot over 15 to 30 % of a navy slide makes it mixed, wherever it stands', () => {
  for (const share of [0.15, 0.2, 0.25, 0.3]) {
    for (const [x, y] of [
      [0.5, 0.4],
      [0.523, 0.417],
      [0.04, 0.05],
      [0.311, 0.29],
    ]) {
      const page = probe(NAVY, [...words(WHITE), ...plot(share, x, y)])
      const tones = tonesOf(page)
      // The mean alone calls the slide dark, and screen wiped the highlight off the plot.
      assert.ok(tones.mean < DARK_BELOW, `the mean no longer calls a slide with a ${share} plot dark: ${tones.mean}`)
      assert.equal(backdropOf(tones), 'mixed', `plot ${share} at ${x},${y}: ${JSON.stringify(tones)}`)
    }
  }
  // A logo is not a plot: the slide stays dark, and screen keeps white text white.
  assert.equal(decide(probe(NAVY, [...words(WHITE), { x: 0.83, y: 0.04, w: 0.13, h: 0.18, color: WHITE }])), 'dark')
})

test('a dark photograph over a third of a white slide or more makes it mixed; a zoom into it is dark', () => {
  for (const share of [1 / 3, 0.4, 0.5, 2 / 3]) {
    const page = probe(WHITE, [...words(TEXT), { x: 1 - share, y: 0, w: share, h: 1, color: xray }])
    assert.equal(decide(page), 'mixed', `an X-ray over ${share.toFixed(2)} of the slide`)
  }
  // Where the photograph stands makes no difference.
  assert.equal(decide(probe(WHITE, [{ x: 0.13, y: 0.2, w: 0.45, h: 0.75, color: xray }])), 'mixed')
  /*
   * The probe reads what is painted, so a zoom decides for itself: the
   * region inside the X-ray is dark, and one on its edge is half of each.
   */
  const slide: Shape[] = [...words(TEXT), { x: 0.5, y: 0, w: 0.5, h: 1, color: xray }]
  assert.equal(decide(probe(WHITE, slide, { x: 0.6, y: 0.25, z: 3 })), 'dark')
  assert.equal(decide(probe(WHITE, slide, { x: 0.375, y: 0.25, z: 4 })), 'mixed')
  assert.equal(decide(probe(WHITE, slide, { x: 0.05, y: 0.2, z: 3 })), 'light')
})

test('what either blend still shows is no reason to give up multiply or screen', () => {
  // A photograph in middle tones over 40 % of a white slide: multiply still
  // shows a highlight on it, and keeps the slide's text black.
  assert.equal(decide(probe(WHITE, [...words(TEXT), { x: 0.6, y: 0, w: 0.4, h: 1, color: midtones }])), 'light')
  // A thin dark title band, one probe row of the page: light.
  assert.equal(decide(probe(WHITE, [{ x: 0, y: 0, w: 1, h: 0.05, color: NAVY }, ...words(TEXT, 0.09)])), 'light')
  // A grey slide with a dark photograph over a fifth: the mean is light, but
  // multiply would lose the photograph and screen loses nothing.
  const grey: Rgb = [188, 188, 188]
  const page = probe(grey, [{ x: 0.55, y: 0.1, w: 0.4, h: 0.5, color: [14, 14, 14] }])
  assert.ok(tonesOf(page).mean >= DARK_BELOW)
  assert.equal(decide(page), 'dark')
})

/* --------------------------------------------------------------- why */

/** A highlighter over `under` through the CSS blend, alpha from its own colour; channels 0..255. */
function blend(mode: 'multiply' | 'screen' | 'normal', under: Rgb, marker: string): Rgb {
  const cs = rgb(marker).map((c) => c / 255)
  const alpha = parseInt(marker.slice(7, 9), 16) / 255
  return under.map((c, i) => {
    const cb = c / 255
    const mixed = mode === 'multiply' ? cb * cs[i] : mode === 'screen' ? cb + cs[i] - cb * cs[i] : cs[i]
    return Math.round(((1 - alpha) * cb + alpha * mixed) * 255)
  }) as Rgb
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(...a), luminance(...b)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * CIELAB ΔE (1976) between two sRGB colours, seen with `flare` of white's
 * light added to both: the 5 % WCAG's contrast assumes is a projector in a
 * lit room, where blacks are lifted and a dark highlight fades first.
 */
function deltaE(a: Rgb, b: Rgb, flare = 0.05): number {
  const lab = (c: Rgb): Rgb => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255
      const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      return (linear + flare) / (1 + flare)
    })
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047)
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * bl)
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883)
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
  }
  const [p, q] = [lab(a), lab(b)]
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

test('on a dark slide every highlighter vanishes under multiply and shows under screen', () => {
  assert.equal(MARKERS.length, 5)
  for (const { color } of MARKERS) {
    assert.match(color, /^#[0-9a-f]{8}$/i, 'a highlighter without its alpha in the colour')
    const multiplied = contrast(NAVY, blend('multiply', NAVY, color))
    const screened = contrast(NAVY, blend('screen', NAVY, color))
    assert.ok(multiplied < 1.2, `${color} multiplied on a dark slide: ${multiplied.toFixed(2)}`)
    assert.ok(screened > 2.5, `${color} screened on a dark slide: ${screened.toFixed(2)}`)
    // And the slide's white text stays white under it.
    assert.deepEqual(blend('screen', WHITE, color), WHITE)
  }
})

test('on a light slide multiply keeps the text black in the highlight, where screen would grey it', () => {
  // The text against the band it sits in: the highlighted white around it.
  for (const { color } of MARKERS) {
    const multiplied = contrast(blend('multiply', TEXT, color), blend('multiply', WHITE, color))
    const screened = contrast(blend('screen', TEXT, color), blend('screen', WHITE, color))
    assert.ok(multiplied > 10, `${color} multiplied greyed the text: ${multiplied.toFixed(1)}`)
    assert.ok(screened < 6, `${color} screened kept the text: ${screened.toFixed(1)}`)
  }
})

test('the bins sit where each blend loses the highlighters, and plain blending loses them nowhere', () => {
  const average = (mode: 'multiply' | 'screen', g: number) =>
    MARKERS.reduce((sum, { color }) => sum + deltaE([g, g, g], blend(mode, [g, g, g], color)), 0) /
    MARKERS.length
  for (let g = 0; g <= 255; g += 1) {
    const l = luminance(g, g, g)
    const screened = average('screen', g)
    const multiplied = average('multiply', g)
    // Very light: screen leaves them under ΔE 10 on average, too faint to point anything out.
    if (l >= VERY_LIGHT) assert.ok(screened < 10, `grey ${g}: screen still shows ΔE ${screened.toFixed(1)}`)
    // Very dark: multiply does.
    if (l <= VERY_DARK) assert.ok(multiplied < 10, `grey ${g}: multiply still shows ΔE ${multiplied.toFixed(1)}`)
    // In between both show them: the bins are no wider than they must be.
    if (l > VERY_DARK && l < VERY_LIGHT) {
      assert.ok(screened > 9.5, `grey ${g} (${l.toFixed(3)}): screen loses it already, ΔE ${screened.toFixed(1)}`)
      assert.ok(multiplied > 9.5, `grey ${g} (${l.toFixed(3)}): multiply loses it already, ΔE ${multiplied.toFixed(1)}`)
    }
    // Plain blending, a mixed page's, shows every one of them on every grey.
    for (const { color } of MARKERS) {
      const plain = deltaE([g, g, g], blend('normal', [g, g, g], color))
      assert.ok(plain > 24, `grey ${g}: ${color} laid plainly shows only ΔE ${plain.toFixed(1)}`)
    }
  }
})

test('on a mixed page either blend wipes the highlight off one ground; plain blending shows it on both', () => {
  for (const { color } of MARKERS) {
    // Screen over the white plot, multiply over the black of an X-ray: gone.
    assert.ok(deltaE(WHITE, blend('screen', WHITE, color)) < 1, `${color} screened on white`)
    assert.ok(deltaE([12, 12, 12], blend('multiply', [12, 12, 12], color)) < 2, `${color} multiplied on black`)
    for (const ground of [WHITE, NAVY, [12, 12, 12] as Rgb]) {
      const plain = deltaE(ground, blend('normal', ground, color))
      assert.ok(plain > 24, `${color} laid plainly on ${ground}: ΔE ${plain.toFixed(1)}`)
    }
    // The price: the text under the band keeps about 3:1, not multiply's black.
    const greyed = contrast(blend('normal', TEXT, color), blend('normal', WHITE, color))
    assert.ok(greyed > 3 && greyed < 4, `${color}: text under a plain band at ${greyed.toFixed(1)}:1`)
  }
})

/* ------------------------------------------------------- the page */

test('the page reads its own picture once per landing and carries the answer on its root', () => {
  const sheet = code('web/src/components/lecture/LecturePage.svelte')
  // Every change of the canvas goes through `show`, and so does the answer.
  const show = sheet.slice(sheet.indexOf('function show('), sheet.indexOf('function groundOf('))
  assert.match(show, /untrack\(\(\) => \(backdrop = backdropNow\(at\)\)\)/)
  // A tiny canvas, the visible one shrunk into it, counted over the sheet's ground.
  const probe = sheet.slice(sheet.indexOf('function backdropNow('), sheet.indexOf('function wipe('))
  assert.match(
    probe,
    /look\.drawImage\(node, 0, 0, node\.width, node\.height, 0, 0, PROBE_W, PROBE_H\)/,
  )
  assert.match(probe, /look\.imageSmoothingEnabled = true\s*look\.imageSmoothingQuality = 'high'/)
  assert.match(
    probe,
    /backdropOf\(tonesOf\(look\.getImageData\(0, 0, PROBE_W, PROBE_H\)\.data, ground\)\)/,
  )
  assert.doesNotMatch(sheet, /meanLuminance/)
  assert.match(probe, /catch \{\s*return backdropOfColor\(ground\)/)
  assert.match(sheet, /const PROBE_W = 32\s*const PROBE_H = 18/)
  // Thumbnails carry no ink, and a blank sheet is its paper: no read-back for either.
  assert.match(probe, /if \(!over \|\| !node \|\| at === null \|\| at < 0 /)
  // The root carries it, around the ink laid over the sheet.
  assert.match(
    sheet,
    /<div\s+bind:this=\{box\}\s+class="[^"]*"\s+data-ink-backdrop=\{backdrop\}\s*>/,
  )
  // And the probe goes back with the buffer.
  const destroy = sheet.slice(sheet.indexOf('onDestroy('))
  assert.match(destroy, /probe\.width = 1\s*probe\.height = 1\s*probe = null/)
})

/** The compiled rules that set `mix-blend-mode`, as `[selector, mode]`. */
function blends(rel: string): [string, string][] {
  const out = compile(read(rel), { filename: rel, css: 'external' })
  const css = out.css?.code ?? ''
  return [...css.matchAll(/([^{}]+)\{\s*mix-blend-mode:\s*([\w-]+);\s*\}/g)].map((m) => [
    m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(),
    m[2],
  ])
}

/** Specificity as [ids, classes + attributes + pseudo-classes, types], for the selectors Svelte writes. */
function specificity(selector: string): [number, number, number] {
  const plain = selector.replace(/:where\([^)]*\)/g, '')
  const ids = (plain.match(/#[\w-]+/g) ?? []).length
  const classes =
    (plain.match(/\.[\w-]+/g) ?? []).length +
    (plain.match(/\[[^\]]+\]/g) ?? []).length +
    (plain.match(/(^|[^:]):(?!:)[\w-]+/g) ?? []).length
  const types = plain
    .replace(/\[[^\]]+\]/g, '')
    .split(/[\s>+~]+/)
    .filter((part) => /^[a-z]/i.test(part)).length
  return [ids, classes, types]
}

function outranks(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

test("a dark page screens the ink's marker canvas and a mixed one lays it plainly, out-ranking the ink layer's own multiply", () => {
  const ink = blends('web/src/components/lecture/InkLayer.svelte').filter(
    ([, mode]) => mode === 'multiply',
  )
  assert.equal(ink.length, 1, 'the ink layer no longer multiplies its marker canvas in one rule')
  const [inkRule] = ink[0]
  assert.match(inkRule, /\.ink-mark/)
  const page = blends('web/src/components/lecture/LecturePage.svelte')
  assert.equal(page.length, 2, 'the page switches the blend in one rule per backdrop')
  const modes = Object.fromEntries(
    page.map(([rule, mode]) => [/\[data-ink-backdrop='(\w+)'\]/.exec(rule)?.[1] ?? rule, mode]),
  )
  assert.deepEqual(modes, { dark: 'screen', mixed: 'normal' })
  for (const [pageRule] of page) {
    // Scoped to the page's root and its attribute, reaching the ink's canvas inside.
    assert.match(pageRule, /^\[data-ink-backdrop='(dark|mixed)'\]\.svelte-[\w-]+ canvas\.ink-mark$/)
    assert.ok(
      outranks(specificity(pageRule), specificity(inkRule)),
      `"${pageRule}" ${specificity(pageRule)} does not out-rank "${inkRule}" ${specificity(inkRule)}`,
    )
  }
  // A light page keeps the ink layer's multiply: no rule of the page names it.
  assert.ok(page.every(([rule]) => !rule.includes("'light'")))
})
