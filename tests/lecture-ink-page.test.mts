/**
 * Per-page lecture ink: the inventory, the request and replacing one page.
 *
 * Ink used to travel in one measure — ALL pages in one frame in the welcome
 * batch. A lecture with twenty minutes of writing is about a megabyte per
 * socket, while at that moment people look at one page; after a Wi-Fi drop
 * the whole hall comes back at once, and the megabyte is multiplied by five
 * hundred (audit · core-9). The server cannot trim the batch on its own: the
 * console counts from the ink how many blank sheets were created and draws
 * their markup in the thumbnail strip — by trimming, it would switch off
 * sheets on the host's screen mid-class. So the measure is different now: the
 * current page, an INVENTORY of the rest (`ink:pages`) and a page on request
 * (`ink:page`).
 *
 * What is checked here is the tab: that it counts sheets by the inventory,
 * not by what it holds; that it asks for what is missing exactly once and
 * stays quiet when there is nothing to ask or no one to ask. That the server
 * can assemble these frames is its half of the change, and there is nothing
 * to check it with here: while it sends everything, the tab must behave
 * exactly as before, and the first test below is about that.
 *
 * There is no browser here: this is arithmetic and agreements, as in
 * lecture-pult.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inkPagesOf, type InkStroke } from '../shared/lecture.js'
import { boardsInked } from '../web/src/components/lecture/pult.js'
import {
  askInkPage,
  forgetInkPages,
  inkedPages,
  noteInkedPages,
  replaceInkPage,
} from '../web/src/components/lecture/ink.js'

/* ------------------------------------------------------------- fake tab */

type Session = Parameters<typeof askInkPage>[0]

function stroke(page: number, id: string): InkStroke {
  return { id, page, color: '#101a33', width: 0.004, points: [0, 0, 0.1, 0.1] }
}

/** A tab exactly as far as the ink knows it: it holds, it sends, it is connected. */
function tab(ink: InkStroke[], connected = true) {
  const asked: number[] = []
  const state = {
    ink,
    connected,
    send(message: { t: string; page?: number }) {
      if (message.t === 'ink:page' && typeof message.page === 'number') asked.push(message.page)
    },
  }
  forgetInkPages()
  return { session: state as unknown as Session, asked, state }
}

/* ------------------------------------------------------------------- inventory */

test('the inventory is the pages with at least one stroke, ascending and without repeats', () => {
  assert.deepEqual(inkPagesOf([]), [])
  assert.deepEqual(
    inkPagesOf([stroke(3, 'a'), stroke(-1, 'b'), stroke(3, 'c'), stroke(1, 'd')]),
    [-1, 1, 3],
  )
})

test('without an inventory exactly what is at hand is written on — and there is nothing to ask', () => {
  // A server that still sends all of the lecture's writing in one frame: the
  // tab holds all the pages, and not a single extra frame goes onto the wire.
  const { session, asked } = tab([stroke(-2, 'a'), stroke(5, 'b')])
  assert.deepEqual([...inkedPages(session)].sort((a, b) => a - b), [-2, 5])
  askInkPage(session, -1)
  askInkPage(session, 5)
  assert.deepEqual(asked, [], 'the tab asked for ink it already has in full')
})

test('the inventory and the ink at hand add up: neither of the two sources is complete', () => {
  // The inventory is a snapshot as of the welcome batch; a stroke on a new
  // page arrives as an echo and is not listed in the inventory.
  const { session } = tab([stroke(4, 'live')])
  noteInkedPages(session, [-2, 1])
  assert.deepEqual([...inkedPages(session)].sort((a, b) => a - b), [-2, 1, 4])
})

test('sheets in the strip are counted by the inventory, not by what the tab holds', () => {
  // Exactly the loss for which the sheet count moved from the tab's memory
  // into the ink: the console was reloaded mid-class, the ink at hand is one
  // current page, and three sheets were created.
  const { session } = tab([stroke(7, 'now')])
  noteInkedPages(session, [-3, -1, 7])
  assert.equal(boardsInked(inkedPages(session)), 3)
})

/* ------------------------------------------------------------------ request */

test('a page from the inventory that is not at hand is requested exactly once', () => {
  const { session, asked } = tab([stroke(1, 'now')])
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  askInkPage(session, -2)
  assert.deepEqual(asked, [-2], 'the request repeated: a pen on the neighbouring page wakes this twenty times a second')
})

test('an empty answer means "the page is blank", and it is not asked about a second time', () => {
  const { session, asked, state } = tab([stroke(1, 'now')])
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  // The server answered "nothing on this page": no ink was added, but the
  // question is not asked again either — otherwise the tab would keep asking
  // until the end of the lecture.
  state.ink = replaceInkPage(state.ink, -2, [])
  askInkPage(session, -2)
  assert.deepEqual(asked, [-2])
})

test('offline we do not ask: the control queue holds sixteen messages', () => {
  const { session, asked } = tab([stroke(1, 'now')], false)
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  assert.deepEqual(asked, [], "a request for ink would push someone else's stroke out of the queue")
})

test('a new inventory forgets the requests already made: after a reconnect they are made again', () => {
  const { session, asked } = tab([stroke(1, 'now')])
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  // The connection dropped and came back: the welcome batch brought a fresh
  // inventory, and the answers to the earlier requests will never arrive.
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  assert.deepEqual(asked, [-2, -2])
})

/* ------------------------------------------------------------------ replacement */

test('a page frame replaces the page whole and leaves the others alone', () => {
  const before = [stroke(1, 'a'), stroke(-2, 'b'), stroke(-2, 'c')]
  const after = replaceInkPage(before, -2, [stroke(-2, 'd')])
  assert.deepEqual(
    after.map((known) => known.id).sort(),
    ['a', 'd'],
    'merging by name would leave erased strokes on the page',
  )
  // An empty list wipes the page clean; the neighbouring ones stay in place.
  assert.deepEqual(replaceInkPage(after, -2, []).map((known) => known.id), ['a'])
  // Another page is not touched at all.
  assert.deepEqual(replaceInkPage(before, 9, []).length, before.length)
})

/* ------------------------------------------------- who actually asks */

function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  // Markup without comments: an explanation is not a promise.
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('the ink for the shown page is requested by the ink layer — one for all three screens', () => {
  // The projection, the hall and the sheet under the pen are built from one
  // InkLayer: what is requested there reaches all three, while what is
  // requested on the console reaches only the console.
  const layer = code('web/src/components/lecture/InkLayer.svelte')
  assert.match(layer, /askInkPage\(session, now\)/, 'the ink layer stopped requesting its page')
  // And not immediately: the server sends the page the hall was moved to on
  // its own, and five hundred requests in the same second are exactly the
  // broadcast round the welcome batch was trimmed to avoid.
  assert.match(layer, /setTimeout\(\(\) => untrack\(\(\) => askInkPage/)
})

test('the console counts sheets by the inventory and requests their markup when it opens the strip', () => {
  const pult = code('web/src/components/lecture/ConsoleView.svelte')
  assert.match(
    pult,
    /boardsInked\(inkedPages\(session\)\)/,
    'the sheet count went back to the ink at hand — after a reload there will be none',
  )
  assert.doesNotMatch(pult, /boardsInked\(session\.ink\)/)
  assert.match(pult, /askInkPage\(session, -index\)/, 'the thumbnail strip stopped requesting the sheet markup')
})

test('the request, the answer and the inventory are in the shared vocabulary — the other half is written against them', () => {
  const protocol = code('shared/protocol.ts')
  // Client → server: a request for one page.
  assert.match(protocol, /\{ t: 'ink:page'; page: number \}/)
  // Server → client: the answer and the inventory.
  assert.match(protocol, /\{ t: 'ink:page'; page: number; strokes: InkStroke\[\] \}/)
  assert.match(protocol, /\{ t: 'ink:pages'; pages: number\[\] \}/)
})
