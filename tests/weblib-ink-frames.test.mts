/**
 * Parsing per-page ink frames in the tab — the second half of core-9.
 *
 * The welcome batch carried ALL of a lecture's ink in one frame: twenty
 * minutes of writing is about a megabyte per socket, and after a Wi-Fi glitch
 * the whole hall comes back at once, and the megabyte is multiplied by five
 * hundred. The server cannot trim the batch on its own — as long as the tab
 * takes an `ink` frame for the lecture's complete writing, a trimmed batch
 * blanks the presenter's written-on sheets. So the measure is different: the
 * current page, an INVENTORY of the rest (`ink:pages`) and a page on request
 * (`ink:page`).
 *
 * The inventory, the request and the replacement are held by lecture/ink.ts,
 * and they are checked in lecture-ink-page. Here is what stands at the wire's
 * entrance: parsing the three frames in `session.svelte.ts` and two places
 * where the inventory must be cleared, otherwise until the end of class the
 * console counts the sheets of the previous lecture and draws empty
 * thumbnails of erased ones.
 *
 * The parsing lives in a runes class and cannot be called without a browser:
 * the promises are read off the source — exactly as in
 * weblib-reconnect-storm — and the inventory arithmetic is checked live with
 * the same functions the parsing calls.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InkStroke } from '../shared/lecture.js'
import { boardsInked } from '../web/src/components/lecture/pult.js'
import {
  askInkPage,
  forgetInkPages,
  inkedPages,
  noteInkedPages,
} from '../web/src/components/lecture/ink.js'

/* ---------------------------------------------------------- from the source */

/** The source without comments: an explanation is not a promise. */
function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const SESSION = code('web/src/lib/session.svelte.ts')

/** One parsing branch: from `message.t === '…'` to the next one. */
function branch(t: string): string {
  const from = SESSION.indexOf(`message.t === '${t}'`)
  assert.notEqual(from, -1, `the tab does not parse the ${t} frame at all`)
  const rest = SESSION.slice(from)
  const to = rest.indexOf('} else if (message.t', 1)
  return to === -1 ? rest : rest.slice(0, to)
}

test('a page frame replaces THAT page, not the whole writing of the lecture', () => {
  assert.match(
    branch('ink:page'),
    /this\.ink = replaceInkPage\(this\.ink, message\.page, message\.strokes\)/,
    'the page landed over everything: neighbouring pages would vanish on the very first request',
  )
  // And the redraw is ordered by the same counter: the canvas draws by it, not
  // by the array.
  assert.match(branch('ink:page'), /this\.inkRevision \+= 1/)
})

test('the inventory arrives together with the edit counter', () => {
  const pages = branch('ink:pages')
  assert.match(pages, /noteInkedPages\(this, message\.pages\)/)
  // Without the counter the inventory would arrive silently: both the count
  // of clean sheets and the thumbnail strip are recomputed by it, and it is
  // exactly the inventory that changes them.
  assert.match(pages, /this\.inkRevision \+= 1/)
})

test('an `ink` frame does not count as an inventory — the server decides how many pages it has', () => {
  // The opposite is exactly the mistake the inventory was introduced for: a
  // welcome batch with one page would declare the rest clean, and the console
  // would blank the presenter's written-on sheets in the middle of class.
  assert.doesNotMatch(branch('ink'), /noteInkedPages/)
})

test('the end of a lecture and a new lecture clear the inventory', () => {
  const lecture = branch('lecture')
  assert.match(lecture, /noteInkedPages\(this, \[\]\)/, 'the inventory outlived the lecture')
  // The sign of a new one is the start time: re-entering the same one comes
  // with the same time.
  assert.match(lecture, /message\.state\.startedAt !== before\?\.startedAt/)
})

test('"erase" crosses the page out of the inventory as well', () => {
  assert.match(branch('ink:clear'), /noteInkedPages\(this, \[\]\)/, 'everything was erased — the inventory stayed')
  assert.match(branch('ink:clear'), /this\.#forgetInkedPage\(page\)/)
  // And the eraser that removed the last stroke from a page — but only if we
  // had its ink: a page we do not have in hand is still unknown after this
  // frame.
  const drop = branch('ink:drop')
  assert.match(drop, /const had = this\.ink\.some\(\(stroke\) => stroke\.page === message\.page\)/)
  assert.match(drop, /this\.#forgetInkedPage\(message\.page\)/)
})

test('a page request does not go into the offline queue', () => {
  // The queue holds sixteen presses and throws out the old ones: an ink
  // request that pushed out someone else's cell run is a bad trade. It will be
  // asked again when the connection is back: the batch will bring a fresh
  // inventory.
  const offline = /DISCARDED_OFFLINE = new Set<[^>]+>\(\[([^\]]*)\]/.exec(SESSION)
  assert.ok(offline, 'the list of what is discarded offline can no longer be read from here')
  assert.match(offline[1], /'ink:page'/)
})

/* -------------------------------------------------------------------- live */

function stroke(page: number, id: string): InkStroke {
  return { id, page, color: '#101a33', width: 0.004, points: [0, 0, 0.1, 0.1] }
}

/** A tab to the extent the ink knows it: it holds, it sends, it is connected. */
function tab(ink: InkStroke[]) {
  const state = { ink, connected: true, send() {} }
  forgetInkPages()
  return { session: state as unknown as Parameters<typeof askInkPage>[0], state }
}

test('an erased page leaves the strip — as it did before per-page delivery', () => {
  // The same rule as in session.svelte.ts · #forgetInkedPage: the server's
  // inventory and the pages in hand are added up, and the page is crossed out
  // of the sum.
  const { session, state } = tab([stroke(-1, 'a'), stroke(-2, 'b')])
  noteInkedPages(session, [-2, -1, 3])
  assert.equal(boardsInked(inkedPages(session)), 2)

  // The presenter erased the second sheet entirely: an `ink:clear` frame with
  // its page.
  state.ink = state.ink.filter((known) => known.page !== -2)
  noteInkedPages(session, [...inkedPages(session)].filter((known) => known !== -2))

  assert.deepEqual(
    [...inkedPages(session)].sort((a, b) => a - b),
    [-1, 3],
    'the page stayed in the inventory: the strip would draw an empty thumbnail, and the console would keep an extra sheet',
  )
  assert.equal(boardsInked(inkedPages(session)), 1)
})

test('a new lecture does not inherit the sheets of the previous one', () => {
  const { session, state } = tab([stroke(-2, 'a')])
  noteInkedPages(session, [-2, -1])
  assert.equal(boardsInked(inkedPages(session)), 2)

  // The lecture was ended and another begun: the server forgot the ink, the
  // tab forgot the inventory.
  state.ink = []
  noteInkedPages(session, [])
  assert.equal(
    boardsInked(inkedPages(session)),
    0,
    'two sheets of the previous lecture would stand empty in the strip of the new one',
  )
})
