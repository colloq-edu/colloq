/**
 * The sheets on the lecture console: how the lecture is laid out in the strip
 * under the slide, the portrait ribbon and the "Pages" grid, the words they
 * use for a sheet, and the sheet menu (web/src/components/lecture/film.ts).
 *
 * The sheets used to be a pile after the deck, numbered by the console and
 * counted back from the ink; a reload lost the empty ones and "next" walked
 * them in order of creation. The server keeps them in deck order now, and
 * everything here is about showing that one order the same way in three
 * places, and saying where a sheet stands.
 *
 * Pure arithmetic and words, as in lecture-pult; the console's wiring of it
 * is pinned at the end, where a quiet edit would break it in class.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import { lectureSequence, type InkStroke } from '../shared/lecture.js'
import {
  ARMREST,
  SHEET_PAD,
  TIERS_H,
  afterWords,
  deckTitle,
  dropQuestion,
  filmItems,
  fitBox,
  gridColumns,
  gridScroll,
  gridWindow,
  inkPaths,
  itemMark,
  itemName,
  menuPlace,
  nextMark,
  paperSample,
  placeWords,
  ribbonStart,
  stripLayout,
  stripScroll,
  stripWindow,
  strokesOn,
  twoTiers,
} from '../web/src/components/lecture/film.js'
import { turnTarget, walkLength, walkStep } from '../web/src/components/lecture/walk.js'

afterEach(() => setLocaleResolver(() => 'ru'))

/** Slide 14 with two sheets after it, of a deck of 50. */
const SHEETS = [
  { page: -1, after: 14 },
  { page: -2, after: 14 },
]
const DECK = lectureSequence(50, SHEETS)

/* ------------------------------------------------------------ items */

test('the strip lists the lecture in walking order, with the slot right after the page on screen', () => {
  const items = filmItems(DECK, 14, -1, true)
  const around = items.slice(12, 18).map((item) => `${item.kind}:${item.page}:${item.n}`)
  assert.deepEqual(around, ['slide:13:13', 'slide:14:14', 'add:14:0', 'sheet:-1:1', 'sheet:-2:2', 'slide:15:15'])
  assert.deepEqual(
    items.filter((item) => item.current).map((item) => item.page),
    [14],
  )
  // "Next" is the item the arrow goes to, here the first sheet, not slide 15.
  assert.deepEqual(
    items.filter((item) => item.next).map((item) => item.page),
    [-1],
  )
  // 50 slides, two sheets and the slot.
  assert.equal(items.length, 53)
})

test('on a sheet the slot follows the sheet, and the sheets are numbered by place, not by page', () => {
  // Page −7 after deletions is still the second sheet of the lecture.
  const deck = lectureSequence(3, [
    { page: -5, after: 1 },
    { page: -7, after: 1 },
  ])
  const items = filmItems(deck, -5, -7, true)
  assert.deepEqual(
    items.map((item) => `${item.kind}:${item.page}:${item.n}`),
    ['slide:1:1', 'sheet:-5:1', 'add:-5:0', 'sheet:-7:2', 'slide:2:2', 'slide:3:3'],
  )
})

test('no slot for hands that cannot add a sheet, and none where the page is not in the lecture', () => {
  assert.equal(
    filmItems(DECK, 14, -1, false).some((item) => item.kind === 'add'),
    false,
  )
  // A sheet deleted a moment ago: current nowhere, so no "right after" to show.
  const gone = filmItems(DECK, -9, 15, true)
  assert.equal(gone.some((item) => item.current || item.kind === 'add'), false)
})

/* ------------------------------------------------------------ words */

test('a sheet is "Л1" under its thumbnail and "Лист 1" by name; a slide is its number', () => {
  assert.equal(itemMark({ kind: 'sheet', n: 1 }), 'Л1')
  assert.equal(itemMark({ kind: 'slide', n: 14 }), '14')
  assert.equal(itemName({ kind: 'sheet', n: 2 }), 'Лист 2')
  assert.equal(itemName({ kind: 'slide', n: 14 }), 'Слайд 14')
  // The slot has its own name, apart from the rail key's "Новый лист".
  assert.equal(itemName({ kind: 'add', n: 0 }), 'Новый лист сюда')
  assert.equal(nextMark({ kind: 'slide', n: 15 }), '15 · дальше')
  assert.equal(nextMark({ kind: 'sheet', n: 1 }), 'Л1 · дальше')
  setLocaleResolver(() => 'en')
  assert.equal(itemMark({ kind: 'sheet', n: 1 }), 'S1')
  assert.equal(itemName({ kind: 'sheet', n: 2 }), 'Sheet 2')
  assert.equal(itemName({ kind: 'add', n: 0 }), 'New sheet here')
  assert.equal(nextMark({ kind: 'slide', n: 15 }), '15 · next')
})

test('where a sheet stands: after its slide, or before the first one', () => {
  assert.equal(afterWords(14), 'после слайда 14')
  assert.equal(afterWords(0), 'перед первым слайдом')
  assert.equal(placeWords({ n: 2, total: 3 }, 14), 'лист 2 из 3 · после слайда 14')
  assert.equal(placeWords({ n: 1, total: 1 }, null), 'лист 1 из 1')
  setLocaleResolver(() => 'en')
  assert.equal(placeWords({ n: 2, total: 3 }, 14), 'sheet 2 of 3 · after slide 14')
  assert.equal(afterWords(0), 'before the first slide')
})

test('the lecture\'s size in one line, the sheets named only when there are some', () => {
  assert.equal(deckTitle('Лента', 50, 3), 'Лента · 50 слайдов · 3 листа')
  assert.equal(deckTitle('Лента', 50, 0), 'Лента · 50 слайдов')
  assert.equal(deckTitle('Страницы', 21, 1), 'Страницы · 21 слайд · 1 лист')
  assert.equal(deckTitle('Страницы', 2, 5), 'Страницы · 2 слайда · 5 листов')
  setLocaleResolver(() => 'en')
  assert.equal(deckTitle('Strip', 50, 3), 'Strip · 50 slides · 3 sheets')
  assert.equal(deckTitle('Strip', 1, 1), 'Strip · 1 slide · 1 sheet')
})

test('the delete question names the sheet and its strokes; an empty sheet is asked about as empty', () => {
  assert.equal(dropQuestion(2, 14), 'Удалить лист 2 и его 14 штрихов?')
  assert.equal(dropQuestion(2, 1), 'Удалить лист 2 и его 1 штрих?')
  assert.equal(dropQuestion(2, 3), 'Удалить лист 2 и его 3 штриха?')
  assert.equal(dropQuestion(2, 21), 'Удалить лист 2 и его 21 штрих?')
  assert.equal(dropQuestion(2, 0), 'Удалить пустой лист 2?')
  setLocaleResolver(() => 'en')
  assert.equal(dropQuestion(2, 1), 'Delete sheet 2 and its 1 stroke?')
  assert.equal(dropQuestion(2, 14), 'Delete sheet 2 and its 14 strokes?')
  assert.equal(dropQuestion(3, 0), 'Delete empty sheet 3?')
})

/* ----------------------------------------------------------- strokes */

test('strokes are counted as Undo takes them back: the pieces of one motion are one', () => {
  const ink = [
    { id: 'a', page: -1 },
    { id: 'b', page: -1, group: 'a' },
    { id: 'c', page: -1, group: 'a' },
    { id: 'd', page: -1 },
    { id: 'e', page: -2 },
    { id: 'f', page: 3 },
  ]
  assert.equal(strokesOn(ink, -1), 2)
  assert.equal(strokesOn(ink, -2), 1)
  assert.equal(strokesOn(ink, -3), 0)
})

test("a sheet's thumbnail lays the highlighter under the pen, scaled to the picture", () => {
  const strokes: InkStroke[] = [
    { id: 'pen', page: -1, color: '#101a33', width: 0.005, points: [0, 0, 0.5, 0.5] },
    { id: 'mark', page: -1, color: '#ffd60a8c', width: 0.022, points: [0.1, 0.1, 0.9, 0.1] },
    { id: 'dot', page: -1, color: '#d4162f', width: 0.0025, points: [0.5, 0.25] },
  ]
  const paths = inkPaths(strokes, 96, 54)
  assert.deepEqual(
    paths.map((line) => line.color),
    ['#ffd60a8c', '#101a33', '#d4162f'],
  )
  assert.equal(paths[1].d, 'M0.0 0.0L48.0 27.0')
  // A single point is still a mark: a zero-length segment with round caps.
  assert.equal(paths[2].d, 'M48.0 13.5L48.0 13.5')
  // The thinnest pen keeps a hair of half a pixel on a 96 px picture.
  assert.equal(paths[2].width, 0.5)
  assert.ok(Math.abs(paths[0].width - 0.022 * 96) < 1e-9)
})

/* ------------------------------------------------------------ strip */

const strip = (items: ReturnType<typeof filmItems>) =>
  stripLayout(
    items.map((item) => item.kind),
    96,
    64,
    10,
    4,
  )

test('the strip keeps the current thumbnail fourth, with the slot and "next" after it (board 01)', () => {
  const items = filmItems(lectureSequence(50, []), 14, 15, true)
  const layout = strip(items)
  const here = items.findIndex((item) => item.current)
  assert.equal(here, 13)
  const scroll = stripScroll(layout, here, 704, 3, 4)
  // 11, 12, 13 before it, then 14, the slot, 15 and 16: as drawn.
  const { from, to } = stripWindow(layout, scroll, 704, 0)
  assert.deepEqual(
    items.slice(from, to).map((item) => (item.kind === 'add' ? '+' : String(item.page))),
    ['11', '12', '13', '14', '+', '15', '16'],
  )
  // The slot is 64 px, the rest 96, 10 apart, with 4 px at the ends.
  assert.equal(layout.lefts[14] - layout.lefts[13], 106)
  assert.equal(layout.lefts[15] - layout.lefts[14], 74)
  assert.equal(layout.length, 4 + 50 * 96 + 64 + 50 * 10 + 4)
})

test('a narrow strip gives up the thumbnails before the current one, never the next one', () => {
  const items = filmItems(lectureSequence(50, []), 14, 15, true)
  const layout = strip(items)
  const scroll = stripScroll(layout, 13, 290, 3, 4)
  const { from, to } = stripWindow(layout, scroll, 290, 0)
  const seen = items.slice(from, to).map((item) => (item.kind === 'add' ? '+' : String(item.page)))
  assert.deepEqual(seen.slice(0, 3), ['14', '+', '15'])
})

test('the strip does not scroll past its ends', () => {
  const items = filmItems(lectureSequence(50, []), 2, 3, true)
  const layout = strip(items)
  assert.equal(stripScroll(layout, 1, 704, 3, 4), 0)
  const last = filmItems(lectureSequence(50, []), 50, null, true)
  const end = strip(last)
  assert.equal(stripScroll(end, last.findIndex((item) => item.current), 704, 3, 4), end.length - 704)
  // Nothing to scroll in a strip shorter than its view.
  const short = filmItems(lectureSequence(3, []), 2, 3, true)
  assert.equal(stripScroll(strip(short), 1, 704, 3, 4), 0)
})

test('pictures are drawn only around the view, the spare included on both sides', () => {
  const items = filmItems(lectureSequence(50, []), 14, 15, true)
  const layout = strip(items)
  const scroll = stripScroll(layout, 13, 704, 3, 4)
  const { from, to } = stripWindow(layout, scroll, 704, 4)
  assert.equal(from, 10 - 4)
  assert.equal(to, 17 + 4)
  assert.deepEqual(stripWindow(layout, 0, 704, 4), { from: 0, to: 11 })
  assert.deepEqual(stripWindow(stripLayout([], 96, 64, 10, 4), 0, 704, 4), { from: 0, to: 0 })
})

/* ----------------------------------------------------------- ribbon */

test('the ribbon shows a slide with one chip before it and a sheet with two (boards 08 and 08a)', () => {
  // Board 08, on slide 14 with Л1 after it: 13, 14, +, Л1, 15, 16.
  const onSlide = filmItems(lectureSequence(50, [{ page: -1, after: 14 }]), 14, -1, true)
  const fromSlide = ribbonStart(
    onSlide.findIndex((item) => item.current),
    onSlide.length,
    6,
    1,
  )
  assert.deepEqual(
    onSlide.slice(fromSlide, fromSlide + 6).map((item) => (item.kind === 'add' ? '+' : itemMark(item))),
    ['13', '14', '+', 'Л1', '15', '16'],
  )
  // Board 08a, on Л1: 13, 14, Л1, +, 15, 16.
  const onSheet = filmItems(lectureSequence(50, [{ page: -1, after: 14 }]), -1, 15, true)
  const fromSheet = ribbonStart(
    onSheet.findIndex((item) => item.current),
    onSheet.length,
    6,
    2,
  )
  assert.deepEqual(
    onSheet.slice(fromSheet, fromSheet + 6).map((item) => (item.kind === 'add' ? '+' : itemMark(item))),
    ['13', '14', 'Л1', '+', '15', '16'],
  )
})

test('the ribbon starts at the first chip and leaves no empty slots at the end', () => {
  assert.equal(ribbonStart(0, 50, 6, 2), 0)
  assert.equal(ribbonStart(1, 50, 6, 2), 0)
  assert.equal(ribbonStart(49, 51, 6, 1), 45)
  assert.equal(ribbonStart(3, 5, 6, 1), 0)
  assert.equal(ribbonStart(-1, 50, 6, 1), 0)
})

/* ------------------------------------------------------------- grid */

test('"Pages" holds six tiles a row at 1180, four in portrait, and opens with the current row second', () => {
  assert.equal(gridColumns(1180 - 80, 160, 28), 6)
  assert.equal(gridColumns(834 - 80, 160, 28), 4)
  assert.equal(gridColumns(100, 160, 28), 1)
  const row = 90 + 6 + 14 + 22
  // The current item is the 16th: row 2 (from 0), so the view starts at row 1.
  assert.equal(gridScroll(15, 6, row), row)
  assert.equal(gridScroll(3, 6, row), 0)
  assert.equal(gridScroll(-1, 6, row), 0)
})

test('"Pages" draws pictures for the rows in view and a row more on each side', () => {
  const row = 132
  assert.deepEqual(gridWindow(0, 420, row, 6, 53, 1), { from: 0, to: 30 })
  assert.deepEqual(gridWindow(row * 3, 420, row, 6, 53, 1), { from: 12, to: 48 })
  assert.deepEqual(gridWindow(row * 6, 420, row, 6, 53, 1), { from: 30, to: 53 })
})

/* ----------------------------------------------------------- menu */

const FRAME = { left: 0, top: 0, width: 1180, height: 820 }

test('the sheet menu hangs above its tile, the notch on the "⋯", inside the screen', () => {
  // Board 07: the Л2 thumbnail of the strip, its badge in the top right corner.
  const tile = { left: 393, top: 722, right: 489, bottom: 776 }
  const place = menuPlace(tile, tile.right - 14, FRAME, { w: 320, h: 223 })
  assert.equal(place.below, false)
  assert.equal(place.bottom, 820 - 722 + 14)
  assert.equal(place.top, null)
  assert.equal(place.left + place.notch, tile.right - 14)
  // At the screen's left edge the card stays 16 px inside, and the notch still points at the tile.
  const edge = menuPlace({ left: 4, top: 722, right: 100, bottom: 776 }, 86, FRAME, { w: 320, h: 223 })
  assert.equal(edge.left, 16)
  assert.equal(edge.notch, 70)
  // At the right edge the notch keeps off the card's corner.
  const right = menuPlace({ left: 1100, top: 722, right: 1176, bottom: 776 }, 1175, FRAME, { w: 320, h: 223 })
  assert.equal(right.left, 1180 - 320 - 16)
  assert.equal(right.notch, 320 - 16)
})

test('a tile in the top rows of "Pages" gets its menu below it', () => {
  const tile = { left: 600, top: 120, right: 760, bottom: 210 }
  const place = menuPlace(tile, 746, FRAME, { w: 320, h: 223 })
  assert.equal(place.below, true)
  assert.equal(place.top, 210 + 14)
  assert.equal(place.bottom, null)
})

/* ------------------------------------------------------ two tiers */

test('two tiers only while the slide keeps its full size above them (board 06)', () => {
  const wide = 9 / 16
  // 1180 × 820, notes open: a 704 × 396 page, the two tiers and an armrest of 176.
  assert.equal(twoTiers(728, 820, wide), true)
  // The same with the notes folded: a 1084 × 610 page leaves no room. One row.
  assert.equal(twoTiers(1108, 820, wide), false)
  // An 11" iPad in Safari with the tab bar: 706 px tall. One row.
  assert.equal(twoTiers(728, 706, wide), false)
  // 1366 × 1024, notes open.
  assert.equal(twoTiers(857, 1024, wide), true)
  // A 4:3 deck is taller for the same width.
  assert.equal(twoTiers(728, 820, 3 / 4), false)
  // Before the first fit nothing is known: one row, today's layout.
  assert.equal(twoTiers(728, 820, 0), false)
  assert.equal(twoTiers(0, 820, wide), false)
  // The bound itself: the page, its margin, the armrest and the tiers.
  const page = (728 - SHEET_PAD * 2) * wide
  assert.equal(twoTiers(728, Math.ceil(page + SHEET_PAD + ARMREST + TIERS_H), wide), true)
  assert.equal(twoTiers(728, Math.floor(page + SHEET_PAD + ARMREST + TIERS_H) - 1, wide), false)
})

test('a picture is fitted into its tile by its proportions and centred', () => {
  assert.deepEqual(fitBox(96, 54, 9 / 16), { x: 0, y: 0, w: 96, h: 54 })
  assert.deepEqual(fitBox(96, 54, 3 / 4), { x: 12, y: 0, w: 72, h: 54 })
  assert.deepEqual(fitBox(160, 90, 1), { x: 35, y: 0, w: 90, h: 90 })
  assert.deepEqual(fitBox(96, 54, 0), { x: 0, y: 0, w: 96, h: 54 })
})

/* ---------------------------------------------------------- paper */

test('the paper samples: squares, lines with the margin, dots, and nothing on plain paper', () => {
  assert.deepEqual(paperSample('plain', 76, 43, 6), { lines: '', dots: [] })
  const grid = paperSample('grid', 76, 43, 6)
  // Hairlines on half pixels, both ways.
  assert.match(grid.lines, /^M6\.5 0V43M12\.5 0V43/)
  assert.match(grid.lines, /M0 6\.5H76/)
  assert.equal(grid.dots.length, 0)
  const lines = paperSample('lines', 76, 43, 6)
  // A head above the first rule, then a rule every step, and the margin.
  assert.match(lines.lines, /^M0 12\.5H76M0 18\.5H76/)
  assert.match(lines.lines, /M6\.5 0V43$/)
  const dots = paperSample('dots', 76, 43, 6)
  assert.equal(dots.lines, '')
  assert.equal(dots.dots.length, 12 * 6)
  assert.deepEqual(dots.dots[0], { x: 6, y: 6 })
})

/* ------------------------------------------- the console's wiring */

function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  // Markup without comments: an explanation is not a promise.
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const PULT = code('web/src/components/lecture/ConsoleView.svelte')

test('the console walks the one order the laptop bar and the hall walk', () => {
  const step = PULT.slice(PULT.indexOf('function step(dir: -1 | 1): void {'))
  assert.match(step.slice(0, 200), /walkStep\(sequence, deckLength, wanted, dir, lastSlide\)/)
  // The keys go dark exactly where that order ends.
  assert.match(PULT, /disabled=\{backTo === null\}/)
  assert.match(PULT, /disabled=\{nextTo === null\}/)
  // No sheet number is ever made up on the console again.
  assert.doesNotMatch(PULT, /goTo\(-/)
  assert.doesNotMatch(PULT, /forwardReturns|newBoard|backToSlides/)
})

test('"＋ Лист" asks the server for a sheet after the page on screen, and says no at fifty', () => {
  const add = PULT.slice(PULT.indexOf('function newSheet(): void {'))
  const body = add.slice(0, add.indexOf('\n  }\n'))
  assert.match(body, /sheetCount >= MAX_SHEETS/)
  assert.match(body, /say\(sheetsFullSays\(\), 'refusal'\)/)
  assert.match(body, /session\.addSheet\(wanted\)/)
  // The answer is waited for: a double tap must not put the second sheet before the first.
  assert.match(body, /now < addingUntil/)
})

test('while "＋ Лист" is on its way the pen is held, so the first stroke cannot land on the slide being left', () => {
  /*
   * The console stays on the slide until the server names the sheet and
   * turns the hall to it, one round trip later. The thumb taps the rail and
   * the Pencil comes down at once: those first letters went onto the SLIDE,
   * were cut when the sheet arrived, and stayed there out of reach of Undo.
   */
  const add = PULT.slice(PULT.indexOf('function newSheet(): void {'))
  const body = add.slice(0, add.indexOf('\n  }\n'))
  const sent = body.indexOf('session.addSheet(wanted)')
  const held = body.indexOf('adding = true')
  assert.ok(sent > 0 && held > sent, 'the pen is not held once the add goes out')
  // Given back by the answer (a list one sheet longer), or when the wait runs out.
  assert.match(body, /addingTimer = window\.setTimeout\(addAnswered, ADD_WAIT_MS\)/)
  const answered = PULT.slice(PULT.indexOf('function addAnswered(): void {'))
  assert.match(answered.slice(0, answered.indexOf('\n  }\n')), /adding = false/)
  assert.match(PULT, /void sheetCount\s+untrack\(addAnswered\)/)
  // `adding` is a rune, folded into what lets the ink layer draw.
  assert.match(PULT, /let adding = \$state\(false\)/)
  assert.match(PULT, /const steady = \$derived\(sheetReady && !adding\)/)
  assert.match(PULT, /live=\{liveTool !== 'off' && \(steady \|\| liveTool === 'laser'\)\}/)
  // The key says it is busy meanwhile instead of swallowing a second tap in silence.
  const key = PULT.slice(PULT.indexOf('{#snippet sheetKey(size: string)}'))
  assert.match(key.slice(0, key.indexOf('{/snippet}')), /aria-busy=\{adding\}/)
})

test('leaving a sheet with the console’s own deck unopened goes to the slide the walk names', () => {
  /*
   * The console reloaded mid-class (or its copy of the deck failed to open):
   * `pages` is 0 and the hall is on a sheet. The walk is bounded by what the
   * console has seen (`walkLength`); the turn must land inside it, never on
   * page 0, which the server ignores, nor on the sheet numbered one higher,
   * which it turns the projector to.
   */
  const sheets = [
    { page: -1, after: 3 },
    { page: -2, after: 9 },
    { page: -3, after: 14 },
  ]
  for (const [onScreen, next, back] of [
    [-3, 15, 14],
    [-2, 10, 9],
  ] as const) {
    const length = walkLength(0, sheets, onScreen, 1)
    assert.equal(length, 15)
    const sequence = lectureSequence(length, sheets)
    const forward = walkStep(sequence, length, onScreen, 1, 1)
    const backward = walkStep(sequence, length, onScreen, -1, 1)
    assert.equal(forward, next)
    assert.equal(backward, back)
    assert.equal(turnTarget(forward ?? 0, length), next)
    assert.equal(turnTarget(backward ?? 0, length), back)
  }
  // One sheet after slide 14: Next and Back used to send page 0.
  const one = [{ page: -1, after: 14 }]
  const length = walkLength(0, one, -1, 1)
  const sequence = lectureSequence(length, one)
  assert.equal(turnTarget(walkStep(sequence, length, -1, 1, 1) ?? 0, length), 15)
  assert.equal(turnTarget(walkStep(sequence, length, -1, -1, 1) ?? 0, length), 14)
  // A sheet goes as it is; a slide stays inside the deck and above 0.
  assert.equal(turnTarget(-7, 15), -7)
  assert.equal(turnTarget(0, 15), 1)
  assert.equal(turnTarget(40, 15), 15)
  assert.equal(turnTarget(3, 0), 1)
  // And the console bounds its turns by that same length, not by the hall's page plus one.
  const go = PULT.slice(PULT.indexOf('function goTo(next: number): void {'))
  const body = go.slice(0, go.indexOf('\n  }\n'))
  assert.match(body, /const target = turnTarget\(next, deckLength\)/)
  assert.doesNotMatch(body, /lecture\?\.page \?\? 1\) \+ 1/)
})

test("the console follows the server's own turns at once, and does not wait for a deleted sheet", () => {
  const converge = PULT.slice(PULT.indexOf('const { moved, ours } = untrack(() => {'))
  const body = converge.slice(0, converge.indexOf('function goTo('))
  const follow = body.indexOf('if (moved && !ours) {')
  const gone = body.indexOf('listed.some((sheet) => sheet.page === mine)')
  const wait = body.indexOf('window.setTimeout(() => (behind = true), 600)')
  assert.ok(follow > 0 && gone > follow && wait > gone, 'the order of the exits changed')
  // A repeat of our own turn waits while "＋ Лист" is on its way: arriving
  // after the add, it would turn the hall back off the new sheet.
  const again = body.slice(body.indexOf('const again = window.setInterval('))
  const repeat = again.indexOf("session.send({ t: 'lecture:page', page: mine })")
  const held = again.indexOf('if (performance.now() < addingUntil) return')
  assert.ok(held > 0 && held < repeat, 'the turn is repeated over a "＋ Лист" in flight')
})

test('the sheet menu changes only the sheet on screen, and deleting asks first', () => {
  assert.match(PULT, /session\.dropSheet\(wanted\)/)
  assert.match(PULT, /session\.setSheetPaper\(wanted, next\)/)
  const menu = code('web/src/components/lecture/SheetMenu.svelte')
  // "Delete sheet" only opens the question; the question deletes.
  assert.match(menu, /onclick=\{\(\) => \(asking = true\)\}/)
  assert.match(menu, /data-pult-drop[\s\S]{0,40}onclick=\{ondrop\}/)
  // Offline both are dark rather than queued.
  assert.equal((menu.match(/disabled=\{offline\}/g) ?? []).length, 3)
})

test('the strip carries "next", and the hold ring is the console sheet\'s alone', () => {
  const strip = PULT.slice(PULT.indexOf('{#snippet readingStrip()}'))
  const body = strip.slice(0, strip.indexOf('{/snippet}'))
  assert.match(body, /data-pult-next=\{item\.next \? '' : undefined\}/)
  assert.match(body, /data-pult-film/)
  // The straight-line ring is drawn for the hand that holds the pen, on its own sheet only.
  assert.equal((PULT.match(/holdRing/g) ?? []).length, 1)
})
