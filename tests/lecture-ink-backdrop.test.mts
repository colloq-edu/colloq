/**
 * The highlighter on a dark slide: the sheet decides from its own picture
 * whether the page under the ink is light or dark, and on a dark one the
 * ink's marker canvas screens instead of multiplying
 * (web/src/components/lecture/page-region.ts · `InkBackdrop`, and the style
 * of LecturePage.svelte):
 *
 *  • the decision: the mean relative luminance of the picture, translucent
 *    pixels laid over the sheet's own ground, against `DARK_BELOW`; a blank
 *    sheet is its paper;
 *  • why: with the five real highlighters, multiply on a dark slide changes
 *    nothing anybody could see and screen draws a plain band, while on a
 *    light one multiply keeps black text black under the highlight;
 *  • the page reads its canvas into a tiny one once per picture that lands,
 *    and carries the answer on its root, where a rule that out-ranks the ink
 *    layer's own `multiply` (both compiled here) switches the blend.
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
  luminance,
  meanLuminance,
  PAPER_GROUND,
  SLIDE_GROUND,
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

test("relative luminance is WCAG's, and a picture is averaged over its ground", () => {
  close(luminance(255, 255, 255), 1)
  close(luminance(0, 0, 0), 0)
  // Mid-grey is a fifth of white's light, not a half.
  close(luminance(128, 128, 128), 0.2158605, 1e-6)
  // White slide, a tenth of it black text: light.
  const slide = meanLuminance(picture([255, 255, 255], [16, 26, 51], 0.1))
  assert.ok(slide > 0.85, `${slide}`)
  assert.equal(backdropOf(slide), 'light')
  // A dark theme with a tenth of it white text: dark.
  const night = meanLuminance(picture(rgb(DARK_PAPER), [255, 255, 255], 0.1))
  assert.ok(night < 0.15, `${night}`)
  assert.equal(backdropOf(night), 'dark')
  // A canvas with nothing on it is its ground: a slide's white, a sheet's paper.
  const clear = new Uint8ClampedArray(64 * 4)
  close(meanLuminance(clear), 1)
  close(meanLuminance(clear, PAPER_GROUND), luminance(...rgb(PAPER_GROUND)))
  close(meanLuminance(new Uint8ClampedArray(0), DARK_PAPER), luminance(...rgb(DARK_PAPER)))
  // Half-transparent black over white is the grey the browser shows.
  close(meanLuminance(Uint8ClampedArray.from([0, 0, 0, 128])), luminance(127, 127, 127), 2e-3)
})

test('the line between light and dark, and a page of one colour', () => {
  assert.equal(backdropOf(DARK_BELOW - 1e-9), 'dark')
  assert.equal(backdropOf(DARK_BELOW), 'light')
  assert.ok(
    DARK_BELOW > 0.25 && DARK_BELOW < 0.45,
    'the line left the range where both blends show a highlight',
  )
  // A blank sheet is its paper, which is light; the dark paper of the light pens is dark.
  assert.equal(backdropOfColor(PAPER_GROUND), 'light')
  assert.equal(backdropOfColor(SLIDE_GROUND), 'light')
  assert.equal(backdropOfColor(DARK_PAPER), 'dark')
  assert.equal(backdropOfColor('#000'), 'dark')
  assert.equal(backdropOfColor('#fff'), 'light')
  // What cannot be read is light: the highlighter as it always was.
  assert.equal(backdropOfColor('transparent'), 'light')
})

/* --------------------------------------------------------------- why */

/** A highlighter over `under` through the CSS blend, alpha from its own colour; channels 0..1. */
function blend(mode: 'multiply' | 'screen', under: Rgb, marker: string): Rgb {
  const cs = rgb(marker).map((c) => c / 255)
  const alpha = parseInt(marker.slice(7, 9), 16) / 255
  return under.map((c, i) => {
    const cb = c / 255
    const mixed = mode === 'multiply' ? cb * cs[i] : cb + cs[i] - cb * cs[i]
    return Math.round(((1 - alpha) * cb + alpha * mixed) * 255)
  }) as Rgb
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(...a), luminance(...b)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

test('on a dark slide every highlighter vanishes under multiply and shows under screen', () => {
  assert.equal(MARKERS.length, 5)
  const navy = rgb(DARK_PAPER)
  for (const { color } of MARKERS) {
    assert.match(color, /^#[0-9a-f]{8}$/i, 'a highlighter without its alpha in the colour')
    const multiplied = contrast(navy, blend('multiply', navy, color))
    const screened = contrast(navy, blend('screen', navy, color))
    assert.ok(multiplied < 1.2, `${color} multiplied on a dark slide: ${multiplied.toFixed(2)}`)
    assert.ok(screened > 2.5, `${color} screened on a dark slide: ${screened.toFixed(2)}`)
    // And the slide's white text stays white under it.
    assert.deepEqual(blend('screen', [255, 255, 255], color), [255, 255, 255])
  }
})

test('on a light slide multiply keeps the text black in the highlight, where screen would grey it', () => {
  // The text against the band it sits in: the highlighted white around it.
  const text: Rgb = [16, 26, 51]
  const white: Rgb = [255, 255, 255]
  for (const { color } of MARKERS) {
    const multiplied = contrast(blend('multiply', text, color), blend('multiply', white, color))
    const screened = contrast(blend('screen', text, color), blend('screen', white, color))
    assert.ok(multiplied > 10, `${color} multiplied greyed the text: ${multiplied.toFixed(1)}`)
    assert.ok(screened < 6, `${color} screened kept the text: ${screened.toFixed(1)}`)
  }
})

/* ------------------------------------------------------- the page */

test('the page reads its own picture once per landing and carries the answer on its root', () => {
  const sheet = code('web/src/components/lecture/LecturePage.svelte')
  // Every change of the canvas goes through `show`, and so does the answer.
  const show = sheet.slice(sheet.indexOf('function show('), sheet.indexOf('function groundOf('))
  assert.match(show, /untrack\(\(\) => \(backdrop = backdropNow\(at\)\)\)/)
  // A tiny canvas, the visible one shrunk into it, averaged over the sheet's ground.
  const probe = sheet.slice(sheet.indexOf('function backdropNow('), sheet.indexOf('function wipe('))
  assert.match(
    probe,
    /look\.drawImage\(node, 0, 0, node\.width, node\.height, 0, 0, PROBE_W, PROBE_H\)/,
  )
  assert.match(
    probe,
    /backdropOf\(meanLuminance\(look\.getImageData\(0, 0, PROBE_W, PROBE_H\)\.data, ground\)\)/,
  )
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

test("a dark page screens the ink's marker canvas, out-ranking the ink layer's own multiply", () => {
  const ink = blends('web/src/components/lecture/InkLayer.svelte').filter(
    ([, mode]) => mode === 'multiply',
  )
  assert.equal(ink.length, 1, 'the ink layer no longer multiplies its marker canvas in one rule')
  const [inkRule] = ink[0]
  assert.match(inkRule, /\.ink-mark/)
  const page = blends('web/src/components/lecture/LecturePage.svelte')
  assert.equal(page.length, 1, 'the page switches the blend in one rule')
  const [pageRule, mode] = page[0]
  assert.equal(mode, 'screen')
  // Scoped to the page's root and its attribute, reaching the ink's canvas inside.
  assert.match(pageRule, /^\[data-ink-backdrop='dark'\]\.svelte-[\w-]+ canvas\.ink-mark$/)
  assert.ok(
    outranks(specificity(pageRule), specificity(inkRule)),
    `"${pageRule}" ${specificity(pageRule)} does not out-rank "${inkRule}" ${specificity(inkRule)}`,
  )
})
