/**
 * "Next" on the room's screens means what the arrow beside it does
 * (web/src/components/lecture/room-next.ts).
 *
 * The bar's ›, Space and the clicker walk the lecture with its sheets in
 * place (walk.ts · `walkStep`), the console's footer names that walk's next
 * item, and the room kept saying "page + 1": on slide 14 with a sheet after
 * it the presenter's column showed slide 15, the notes header said "NEXT 15",
 * a teacher watching read "next 15 · Title", while the arrow put the blank
 * sheet on the projector; on the sheet the room said nothing, while the arrow
 * went on to 15.
 *
 *  • the item is the walk's own: for any list of sheets, wherever the room
 *    names something, the arrow goes exactly there;
 *  • a sheet is named by its place, "Л1" and "лист 1 из 3", in both
 *    languages; a slide by its number and title;
 *  • a deck this screen has not opened names no slide it cannot vouch for;
 *  • the four places that say it (the column's thumbnail, the notes header,
 *    the student presenter's and the watching teacher's captions) read it,
 *    and nothing counts page + 1 any more.
 *
 * Pure logic is called; the component is held by its source, the way
 * lecture-hall-zoom does it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import { lectureSequence, type LectureSheet } from '../shared/lecture.js'
import { nextMarkOf, nextWordsOf, roomNext } from '../web/src/components/lecture/room-next.js'
import { walkLength, walkStep } from '../web/src/components/lecture/walk.js'

afterEach(() => setLocaleResolver(() => 'ru'))

function code(rel: string): string {
  // Markup without comments: an explanation is not a promise.
  return fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The finding's lecture: 50 slides, two sheets after 14, one after the last slide. */
const SHEETS: LectureSheet[] = [
  { page: -1, after: 14 },
  { page: -2, after: 14 },
  { page: -3, after: 50 },
]
const PAGES = 50
const SEQUENCE = lectureSequence(PAGES, SHEETS)

/** What the room names from `from`, built exactly as the bar builds its walk. */
function nextFrom(from: number, pages = PAGES, sheets = SHEETS, lastSlide = from > 0 ? from : 14) {
  const length = walkLength(pages, sheets, from, lastSlide)
  return roomNext(lectureSequence(length, sheets), length, pages, from, lastSlide)
}

/* -------------------------------------------------------------- the walk */

test('on a slide with a sheet after it, "next" is the sheet, not the following slide', () => {
  assert.deepEqual(nextFrom(14), { page: -1, sheet: { n: 1, total: 3 } })
  // The arrow beside it goes to the same page.
  assert.equal(walkStep(SEQUENCE, PAGES, 14, 1, 14), -1)
})

test('on a sheet, "next" is what follows it: the next sheet, then the next slide', () => {
  assert.deepEqual(nextFrom(-1, PAGES, SHEETS, 14), { page: -2, sheet: { n: 2, total: 3 } })
  assert.deepEqual(nextFrom(-2, PAGES, SHEETS, 14), { page: 15, sheet: null })
})

test('the last slide with a sheet after it has a "next"; the sheet at the very end has none', () => {
  assert.deepEqual(nextFrom(50), { page: -3, sheet: { n: 3, total: 3 } })
  assert.equal(nextFrom(-3, PAGES, SHEETS, 50), null)
  // Without the sheet the last slide ends the lecture.
  assert.equal(nextFrom(50, PAGES, []), null)
})

test('a slide with nothing after it but the next slide names that slide', () => {
  assert.deepEqual(nextFrom(13), { page: 14, sheet: null })
  assert.deepEqual(nextFrom(1, PAGES, []), { page: 2, sheet: null })
})

test('a sheet the list does not know (deleted a moment ago) names the slide the arrow goes back to', () => {
  assert.deepEqual(nextFrom(-9, PAGES, SHEETS, 14), { page: 14, sheet: null })
})

test('a deck this screen has not opened names no slide, only the sheets the list vouches for', () => {
  // The walk lets the arrow go one past the furthest slide seen; the slide may not exist.
  assert.equal(nextFrom(14, 0, []), null)
  assert.equal(nextFrom(13, 0, SHEETS), null)
  // A sheet is known from the list, deck or no deck.
  assert.deepEqual(nextFrom(14, 0, SHEETS), { page: -1, sheet: { n: 1, total: 3 } })
})

test('wherever the room names something, the arrow goes exactly there, whatever the sheets', () => {
  // Sheets built with the server's insertion rule: before the sheets of the
  // same slide, or right after a sheet. Seeded, so a failure repeats.
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let round = 0; round < 300; round += 1) {
    const pages = 1 + Math.floor(random() * 12)
    const sheets: LectureSheet[] = []
    const count = Math.floor(random() * 6)
    for (let k = 1; k <= count; k += 1) sheets.push({ page: -k, after: Math.floor(random() * (pages + 1)) })
    sheets.sort((a, b) => a.after - b.after)
    const sequence = lectureSequence(pages, sheets)
    for (const from of sequence) {
      const last = from > 0 ? from : 1
      const said = roomNext(sequence, pages, pages, from, last)
      const goes = walkStep(sequence, pages, from, 1, last)
      assert.equal(said?.page ?? null, goes, `pages ${pages}, sheets ${JSON.stringify(sheets)}, from ${from}`)
      if (said?.sheet) {
        // "Sheet n of total" counts the lecture's sheets in walking order.
        const order = sequence.filter((page) => page < 0)
        assert.equal(order.indexOf(said.page) + 1, said.sheet.n)
        assert.equal(said.sheet.total, order.length)
      }
    }
  }
})

/* ------------------------------------------------------------ the words */

test('a sheet is named by its place, a slide by its number and its title, in both languages', () => {
  const sheet = nextFrom(14)!
  const slide = nextFrom(-2, PAGES, SHEETS, 14)!
  assert.equal(nextMarkOf(sheet), 'Л1')
  assert.equal(nextWordsOf(sheet, 'ignored: a sheet has no title'), 'лист 1 из 3')
  assert.equal(nextMarkOf(slide), '15')
  assert.equal(nextWordsOf(slide, 'Скорость обучения'), 'Скорость обучения')
  assert.equal(nextWordsOf(slide, ''), '', 'a title not read yet says nothing rather than something')
  setLocaleResolver(() => 'en')
  assert.equal(nextMarkOf(sheet), 'S1')
  assert.equal(nextWordsOf(sheet, ''), 'sheet 1 of 3')
})

/* --------------------------------------------------------- the room's wiring */

test('every "next" in the room reads the walk, and nothing counts page + 1 any more', () => {
  const view = code('web/src/components/lecture/LectureView.svelte')
  assert.match(view, /const nextUp = \$derived\(roomNext\(sequence, deckLength, pages, page, lastSlide\)\)/)
  assert.doesNotMatch(view, /nextSlide\b/, 'the old page + 1 is still read somewhere')
  assert.doesNotMatch(view, /page=\{page \+ 1\}/, 'the column draws page + 1 again')
  assert.doesNotMatch(view, /slideTitle\(source, at \+ 1\)/, 'the title is read for page + 1 again')
  // The title is read for the slide the walk names, by its number.
  assert.match(view, /const nextSlideNo = \$derived\(nextUp !== null && nextUp\.sheet === null \? nextUp\.page : 0\)/)
  assert.match(view, /const at = nextSlideNo[\s\S]{0,200}slideTitle\(source, at\)/)

  // The column: the walk's page, a sheet with its paper and its words.
  const column = view.slice(view.indexOf('{#if column && nextUp !== null}'))
  assert.notEqual(column.length, view.length, 'the column no longer asks the walk')
  assert.match(column.slice(0, 1200), /<LecturePage \{doc\} page=\{nextUp\.page\} paper=\{nextPaper\}/)
  assert.match(column.slice(0, 1200), /\{#if nextUp\.sheet\}[\s\S]*\{nextMark\(\)\}[\s\S]*\{nextWords\(\)\}/)
  assert.match(view, /sheet\.page === nextUp\.page\)\?\.paper/, 'a sheet that is next is drawn on plain paper')

  // The notes header under the slide and the captions say the same mark and words.
  assert.match(view, /next=\{stacked && nextUp !== null \? \{ mark: nextMark\(\), title: nextWords\(\) \} : null\}/)
  assert.match(view, /tr\('room\.takeover\.next', \{ n: nextMark\(\) \}\)/)
  // A student who presents gets the column or the caption by the same "next".
  assert.match(view, /const column = \$derived\(pult && sideRoom && \(host \|\| nextUp !== null\)\)/)
  assert.match(view, /const caption = \$derived\(cohost \|\| \(pult && !host && !sideRoom && nextUp !== null\)\)/)

  const pad = code('web/src/components/lecture/NotesPad.svelte')
  assert.match(pad, /next\?: \{ mark: string; title: string \} \| null/)
  assert.match(pad, /\{next\.mark\}/)
})
