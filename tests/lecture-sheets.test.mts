/**
 * Blank sheets as a list the server keeps.
 *
 * A sheet used to be a negative number the console made up and counted back
 * from the ink: "sheet N has strokes, so sheets 1 … N were started". It could
 * not be deleted (a later sheet's ink brought its number back), it could only
 * stand after the whole deck, an empty one was known only to the tab that
 * started it, and the 51st silently became the 50th. The owner's complaint:
 * "you can add sheets, but it is unclear how it happens, how many there are
 * and how to walk them".
 *
 * Now the server keeps the list in deck order and hands out the numbers
 * (shared/lecture.ts · `LectureSheet`). What is checked here breaks silently
 * and in front of the hall:
 *
 *   — a sheet lands right after the page it was added on, not after the deck;
 *   — a number is never handed out twice, so a late frame for a deleted sheet
 *     cannot write onto a new one or bring the old one back;
 *   — deleting the sheet the hall is looking at moves the hall one step back,
 *     by the same "back" the console walks, read off the list rather than
 *     walked slide by slide;
 *   — a slide number no deck has is not a place for a sheet, and no walk is
 *     longer than `MAX_SLIDES`: one absurd anchor used to freeze every screen
 *     without the deck and take the whole server down on its deletion;
 *   — a deleted sheet leaves memory, the inventory and the undo history;
 *   — the 51st sheet is refused in words;
 *   — an old console that still makes up numbers keeps working.
 *
 * No network: the memory directly, then the wire through fake sockets and the
 * real dispatcher.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import {
  addInk,
  addSheet,
  dropSheet,
  eraseInk,
  handOver,
  inkOf,
  inkedPagesOf,
  lectureOf,
  setBlank,
  setSheetPaper,
  setZoom,
  startLecture,
  stopLecture,
  turnTo,
  undoInk,
} from '../server/src/lecture.js'
import {
  MAX_SHEETS,
  MAX_SLIDES,
  lectureSequence,
  sheetNumber,
  sheetsFullSays,
  stepIn,
  stepOff,
  type LectureSheet,
} from '../shared/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
import { walkLength } from '../web/src/components/lecture/walk.js'

let n = 0
/** A lecture of its own for each test: the module is shared process memory. */
function lecture(): string {
  const id = `sheets-${++n}`
  startLecture(id, { file: 'slides.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  return id
}

function dab(page: number, id: string) {
  return { id, page, color: '#101a33', width: 0.004, points: [0.1, 0.1, 0.2, 0.2] }
}

const sheets = (id: string): LectureSheet[] => lectureOf(id)?.sheets ?? []
const numbers = (id: string): number[] => sheets(id).map((sheet) => sheet.page)
/** The lecture as it is walked, for a deck of `pages` slides. */
const walk = (id: string, pages: number): number[] => lectureSequence(pages, lectureOf(id)?.sheets)

/**
 * Where the hall went off a deleted sheet before the step was read off the
 * list: one step back along the walk built up to the furthest anchor, else one
 * forward, else slide 1. The yardstick `stepOff` must match.
 */
function walkedOff(list: readonly LectureSheet[], page: number): number {
  const span = Math.max(1, ...list.map((sheet) => sheet.after))
  const sequence = lectureSequence(span, list)
  return stepIn(sequence, page, -1) ?? stepIn(sequence, page, 1) ?? 1
}

/** A repeatable source of chance (mulberry32), so a failure can be replayed. */
function chance(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------------------------------------ the list */

test('a new sheet stands right after the slide it was added on, ahead of the sheets already there', () => {
  const id = lecture()
  turnTo(id, 3)
  const first = addSheet(id, 3)
  assert.equal(first?.page, -1)
  assert.equal(first?.state?.page, -1, 'the projection did not move to the new sheet')
  assert.deepEqual(walk(id, 5), [1, 2, 3, -1, 4, 5])

  // Back on slide 3, another sheet: it must be the very next page after the
  // slide, so it goes in front of the one already there.
  turnTo(id, 3)
  assert.equal(addSheet(id, 3)?.page, -2)
  assert.deepEqual(walk(id, 5), [1, 2, 3, -2, -1, 4, 5])
  stopLecture(id)
})

test('a sheet added on a sheet goes right behind it, under the same slide', () => {
  const id = lecture()
  addSheet(id, 3)
  addSheet(id, -1)
  assert.deepEqual(walk(id, 4), [1, 2, 3, -1, -2, 4])
  // Back to the first sheet and one more: between the two, not at the end.
  turnTo(id, -1)
  addSheet(id, -1)
  assert.deepEqual(walk(id, 4), [1, 2, 3, -1, -3, -2, 4])
  assert.ok(sheets(id).every((sheet) => sheet.after === 3), 'a sheet added on a sheet lost its slide')
  stopLecture(id)
})

test('the list itself stays in deck order, whichever slides the sheets were added on', () => {
  const id = lecture()
  addSheet(id, 5)
  addSheet(id, 2)
  addSheet(id, 0)
  // Zero is the slot in front of the first slide.
  assert.deepEqual(walk(id, 6), [-3, 1, 2, -2, 3, 4, 5, -1, 6])
  assert.deepEqual(
    sheets(id).map((sheet) => sheet.after),
    [0, 2, 5],
    'the list is not in the order the lecture is walked in',
  )
  stopLecture(id)
})

test('an add that names no place goes after the page being shown', () => {
  /*
   * The console's key means "after what I am showing". A garbage `after`, or
   * a sheet deleted on another device a moment ago, must not throw the new
   * sheet in front of the deck or refuse the press.
   */
  const id = lecture()
  turnTo(id, 4)
  assert.equal(addSheet(id, Number.NaN)?.state?.sheets?.[0]?.after, 4)
  assert.equal(addSheet(id, -99)?.page, -2)
  assert.deepEqual(walk(id, 5), [1, 2, 3, 4, -1, -2, 5], 'an unknown sheet was taken as a place')
  turnTo(id, 2)
  addSheet(id, Number.POSITIVE_INFINITY)
  assert.deepEqual(walk(id, 5), [1, 2, -3, 3, 4, -1, -2, 5])
  stopLecture(id)
})

test('a slide no deck has is not a place either: the sheet goes after the page being shown', () => {
  /*
   * The shipped console sends the page it shows, but any tab of the presenter
   * can send a number. A sheet stored "after slide 1 000 000 000" froze every
   * screen that had not opened the deck yet, and deleting it walked the server
   * through a billion slides until the process died with every room on it.
   */
  const id = lecture()
  for (const far of [MAX_SLIDES + 1, 1e9, Number.MAX_SAFE_INTEGER]) {
    turnTo(id, 4)
    const added = addSheet(id, far)
    const placed = added?.state?.sheets?.find((sheet) => sheet.page === added.page)
    assert.equal(placed?.after, 4, `a sheet stood after slide ${far}`)
  }
  // The ceiling itself is still a slide.
  turnTo(id, 4)
  const edge = addSheet(id, MAX_SLIDES)
  assert.equal(edge?.state?.sheets?.find((sheet) => sheet.page === edge.page)?.after, MAX_SLIDES)
  assert.ok(sheets(id).every((sheet) => sheet.after <= MAX_SLIDES))
  stopLecture(id)
})

test('a number is never handed out twice, not even after a deletion', () => {
  const id = lecture()
  addSheet(id, 1)
  addSheet(id, -1)
  assert.deepEqual(numbers(id), [-1, -2])
  assert.ok(dropSheet(id, -2))
  assert.equal(addSheet(id, 1)?.page, -3, 'a deleted number was handed out again')
  assert.ok(dropSheet(id, -1))
  assert.equal(addSheet(id, 1)?.page, -4)
  // A number an old console took is skipped as well.
  turnTo(id, 1)
  assert.equal(turnTo(id, -6)?.page, -6)
  assert.equal(addSheet(id, 1)?.page, -5)
  assert.equal(addSheet(id, 1)?.page, -7, 'the number the old console took was handed out again')
  stopLecture(id)
})

test('the 51st sheet is refused, and nothing moves', () => {
  const id = lecture()
  for (let i = 0; i < MAX_SHEETS; i += 1) assert.ok(addSheet(id, 1)?.page)
  turnTo(id, 1)
  assert.deepEqual(addSheet(id, 1), { full: true })
  assert.equal(sheets(id).length, MAX_SHEETS)
  assert.equal(lectureOf(id)?.page, 1, 'a refused sheet turned the projection anyway')

  // A deleted one makes room again, under a new number.
  assert.ok(dropSheet(id, -10))
  assert.equal(addSheet(id, 1)?.page, -(MAX_SHEETS + 1))
  stopLecture(id)
})

test('paper: set, kept as no field when plain, and only on a sheet of this lecture', () => {
  const id = lecture()
  addSheet(id, 1, 'dots')
  assert.equal(sheets(id)[0].paper, 'dots')
  assert.equal(setSheetPaper(id, -1, 'grid')?.sheets?.[0]?.paper, 'grid')
  assert.equal(setSheetPaper(id, -1, 'grid'), null, 'the same paper again was a change')
  assert.ok(setSheetPaper(id, -1, 'plain'))
  assert.deepEqual(sheets(id)[0], { page: -1, after: 1 }, 'plain paper left a field behind')
  assert.equal(setSheetPaper(id, -2, 'lines'), null, 'paper for a sheet that does not exist')
  assert.equal(setSheetPaper(id, 3, 'lines'), null, 'a slide got paper')
  // A paper from the wire is read, not trusted: an unknown name is plain.
  addSheet(id, 1, 'wallpaper' as never)
  assert.equal(sheets(id).find((sheet) => sheet.page === -2)?.paper, undefined)
  stopLecture(id)
})

test('the states already handed out do not change under a sheet operation', () => {
  // A frame may still be on its way with the old state: the list is replaced, never edited in place.
  const id = lecture()
  addSheet(id, 1)
  const before = lectureOf(id)!
  addSheet(id, -1)
  setSheetPaper(id, -1, 'grid')
  dropSheet(id, -2)
  assert.deepEqual(before.sheets, [{ page: -1, after: 1 }])
  stopLecture(id)
})

/* -------------------------------------------------------- deleting */

test('deleting the sheet the hall is on moves it one step back along the lecture', () => {
  const id = lecture()
  turnTo(id, 3)
  addSheet(id, 3)
  addSheet(id, -1)
  addSheet(id, -2)
  assert.deepEqual(walk(id, 4), [1, 2, 3, -1, -2, -3, 4])

  // From the last sheet of slide 3: to the sheet before it.
  assert.equal(dropSheet(id, -3)?.state.page, -2)
  // From the middle one: to the first.
  assert.equal(dropSheet(id, -2)?.state.page, -1)
  // From the first sheet of a slide: to the slide.
  const last = dropSheet(id, -1)
  assert.equal(last?.moved, true)
  assert.equal(last?.state.page, 3)
  assert.deepEqual(walk(id, 4), [1, 2, 3, 4])
  stopLecture(id)
})

test('in front of the first slide there is nothing before: the hall moves forward', () => {
  const id = lecture()
  addSheet(id, 0)
  addSheet(id, -1)
  assert.deepEqual(walk(id, 2), [-1, -2, 1, 2])
  turnTo(id, -1)
  // The first sheet of the deck: the next item is the other sheet.
  assert.equal(dropSheet(id, -1)?.state.page, -2)
  // The only one left: the next item is slide 1.
  assert.equal(dropSheet(id, -2)?.state.page, 1)
  stopLecture(id)
})

test('deleting a sheet the hall is not on leaves the hall and its zoom alone', () => {
  const id = lecture()
  addSheet(id, 2)
  turnTo(id, 5)
  setZoom(id, 5, { x: 0.25, y: 0.25, z: 2 })
  const dropped = dropSheet(id, -1)
  assert.equal(dropped?.moved, false)
  assert.equal(dropped?.state.page, 5)
  assert.deepEqual(dropped?.state.zoom, { x: 0.25, y: 0.25, z: 2 })
  assert.equal(dropSheet(id, -1), null, 'a sheet was deleted twice')
  assert.equal(dropSheet(id, 5), null, 'a slide was deleted as a sheet')
  stopLecture(id)
})

test('the step off a deleted sheet is the walk\'s, on two thousand lectures the server built', () => {
  /*
   * The step is read straight off the list now (`stepOff`), where the server
   * used to build the walk up to the furthest anchor and take one step along
   * it. Only the cost may differ: random lectures, made by the server's own
   * adds, turns and deletions, must land the hall on the deletion of the sheet
   * on screen exactly where that walk did, and leave it alone on any other.
   */
  const random = chance(20261012)
  const pick = (n: number): number => Math.floor(random() * n)
  let stepped = 0
  for (let round = 0; round < 2000; round += 1) {
    const id = lecture()
    for (let move = 0; move < 24; move += 1) {
      const list = sheets(id)
      const roll = random()
      if (list.length === 0 || roll < 0.45) {
        // After a slide (0 is the slot in front of the first one) or after a sheet.
        addSheet(id, list.length > 0 && random() < 0.4 ? list[pick(list.length)].page : pick(7))
      } else if (roll < 0.7) {
        turnTo(id, random() < 0.5 ? list[pick(list.length)].page : 1 + pick(6))
      } else {
        const before = lectureOf(id)!
        const page = before.page < 0 && random() < 0.7 ? before.page : list[pick(list.length)].page
        const expected = before.page === page ? walkedOff(list, page) : before.page
        const dropped = dropSheet(id, page)
        assert.equal(dropped?.state.page, expected, `deleting ${page} on ${before.page} from ${JSON.stringify(list)}`)
        if (dropped?.moved) stepped += 1
      }
    }
    stopLecture(id)
  }
  assert.ok(stepped > 1000, `only ${stepped} deletions of the sheet on screen were checked`)
})

test('the step off a sheet is the walk\'s for any list, and costs the list, not the slide number', () => {
  const list: LectureSheet[] = [
    { page: -4, after: 0 },
    { page: -6, after: 0 },
    { page: -1, after: 2 },
    { page: -3, after: 2 },
    { page: -2, after: 9 },
  ]
  assert.equal(stepOff(list, -3), -1, 'the second sheet of a slide did not step back to the first')
  assert.equal(stepOff(list, -1), 2, 'the first sheet of a slide did not step back to the slide')
  assert.equal(stepOff(list, -2), 9)
  assert.equal(stepOff(list, -6), -4)
  assert.equal(stepOff(list, -4), -6, 'the first sheet in front of slide 1 did not step forward')
  assert.equal(stepOff([{ page: -6, after: 0 }], -6), 1)
  assert.equal(stepOff(list, -9), null, 'a sheet the list does not have')
  assert.equal(stepOff(list, 2), null, 'a slide is not a sheet')
  // The sheets of one slide keep the order of the list, even out of deck order.
  assert.equal(stepOff([{ page: -1, after: 3 }, { page: -2, after: 5 }, { page: -3, after: 3 }], -3), -1)

  // Random lists, sorted or not, with fractions and junk below zero: the same answers as the walk.
  const random = chance(7)
  for (let round = 0; round < 2000; round += 1) {
    const made: LectureSheet[] = []
    const count = 1 + Math.floor(random() * 8)
    for (let k = 1; k <= count; k += 1) {
      const after = random() < 0.15 ? -1 - random() * 3 : random() < 0.2 ? random() * 6 : Math.floor(random() * 6)
      made.push({ page: -k, after })
    }
    for (const sheet of made) {
      assert.equal(stepOff(made, sheet.page), walkedOff(made, sheet.page), `off ${sheet.page} in ${JSON.stringify(made)}`)
    }
  }

  // The walk to this one would never have come back. The step off it does at once,
  // and lands on a slide the server takes.
  assert.equal(stepOff([{ page: -1, after: Number.MAX_SAFE_INTEGER }], -1), MAX_SLIDES)
})

test('deleting a sheet at the last slide there can be is one step, like any other', () => {
  const id = lecture()
  turnTo(id, MAX_SLIDES)
  addSheet(id, MAX_SLIDES)
  addSheet(id, -1)
  assert.equal(dropSheet(id, -2)?.state.page, -1)
  assert.equal(dropSheet(id, -1)?.state.page, MAX_SLIDES)
  stopLecture(id)
})

test('moving off a deleted sheet comes up whole: the zoom was for that sheet', () => {
  const id = lecture()
  addSheet(id, 2)
  setZoom(id, -1, { x: 0.5, y: 0.5, z: 2 })
  assert.equal(dropSheet(id, -1)?.state.zoom, null)
  stopLecture(id)
})

test('a deleted sheet leaves memory, the inventory and the undo history, and stays deleted', () => {
  const id = lecture()
  addSheet(id, 1)
  addInk(id, dab(-1, 'a'))
  addInk(id, dab(-1, 'b'))
  eraseInk(id, -1, 'a')
  addInk(id, dab(1, 'on the slide'))
  assert.deepEqual(inkedPagesOf(id), [-1, 1])

  dropSheet(id, -1)
  assert.deepEqual(inkOf(id).map((stroke) => stroke.id), ['on the slide'])
  assert.deepEqual(inkedPagesOf(id), [1], 'the deleted sheet stayed in the inventory')
  assert.equal(undoInk(id, -1), null, 'Undo brought back ink of a deleted sheet')

  // A frame late for it is refused: it must not bring the sheet back.
  assert.equal(addInk(id, dab(-1, 'late')), null)
  assert.deepEqual(inkedPagesOf(id), [1])
  // Nor may an old console turn to it.
  assert.equal(turnTo(id, -1), null)
  assert.deepEqual(numbers(id), [])
  stopLecture(id)
})

test('ink is taken only on a sheet the list has', () => {
  const id = lecture()
  assert.equal(addInk(id, dab(-3, 'nobody made this sheet')), null)
  assert.deepEqual(inkOf(id), [])
  addSheet(id, 1)
  assert.equal(addInk(id, dab(-1, 'a'))?.stroke?.page, -1)
  stopLecture(id)
})

/* ---------------------------------------------- an old console */

test('an old console turning to a number it made up adds that sheet after the page shown', () => {
  /*
   * A deploy swaps the server under a console that is already open, and its
   * «Лист» key still sends `lecture:page` with −(n+1). It must keep working
   * until the tab is reloaded.
   */
  const id = lecture()
  turnTo(id, 5)
  const state = turnTo(id, -1)
  assert.equal(state?.page, -1)
  assert.deepEqual(state?.sheets, [{ page: -1, after: 5 }])
  assert.deepEqual(turnTo(id, -2)?.sheets?.map((sheet) => sheet.after), [5, 5])
  assert.deepEqual(walk(id, 6), [1, 2, 3, 4, 5, -1, -2, 6])
  // Turning to a sheet that exists is an ordinary turn.
  assert.equal(turnTo(id, -1)?.page, -1)
  assert.equal(sheets(id).length, 2)
  // Garbage is not a sheet.
  assert.equal(turnTo(id, Number.NEGATIVE_INFINITY), null)
  assert.equal(turnTo(id, -1e300), null)
  stopLecture(id)
})

test('an old console cannot anchor a sheet at a slide no deck has: the turn there is refused first', () => {
  // Its sheet stands after the page shown, so a far turn and then −1 would have stored the far anchor.
  const id = lecture()
  turnTo(id, 2)
  assert.equal(turnTo(id, 1e9), null)
  assert.deepEqual(turnTo(id, -1)?.sheets, [{ page: -1, after: 2 }])
  stopLecture(id)
})

test('the sheets survive a take-over and a blank screen', () => {
  const id = lecture()
  addSheet(id, 1, 'grid')
  setBlank(id, true)
  const taken = handOver(id, 'slides.pdf', 'p_boris', 'Борис', '#0c7a64')
  assert.deepEqual(taken?.sheets, [{ page: -1, after: 1, paper: 'grid' }])
  assert.equal(taken?.page, -1)
  stopLecture(id)
})

/* ------------------------------------------------- one sequence */

test('the sequence: sheets stand at their slides, past the end at the last one', () => {
  const list: LectureSheet[] = [
    { page: -4, after: 0 },
    { page: -1, after: 2 },
    { page: -3, after: 2 },
    { page: -2, after: 9 },
  ]
  assert.deepEqual(lectureSequence(3, list), [-4, 1, 2, -1, -3, 3, -2])
  // The deck is not loaded yet: only what stands in front of it is known.
  assert.deepEqual(lectureSequence(0, list), [-4, -1, -3, -2])
  assert.deepEqual(lectureSequence(2, undefined), [1, 2])
})

test('one "next" and one "back" for the console, the laptop bar and the server', () => {
  const sequence = lectureSequence(3, [
    { page: -1, after: 2 },
    { page: -2, after: 2 },
  ])
  assert.deepEqual(sequence, [1, 2, -1, -2, 3])
  assert.equal(stepIn(sequence, 2, 1), -1)
  assert.equal(stepIn(sequence, -2, 1), 3, 'the last sheet of a slide does not lead to the next slide')
  assert.equal(stepIn(sequence, -1, -1), 2)
  assert.equal(stepIn(sequence, 1, -1), null)
  assert.equal(stepIn(sequence, 3, 1), null)
  // A slide past what is known (the deck is still loading) steps by its number.
  assert.equal(stepIn(sequence, 7, 1), 8)
  assert.equal(stepIn(sequence, 7, -1), 6)
  // A sheet that is not in the list (deleted a moment ago) has nowhere to step from.
  assert.equal(stepIn(sequence, -9, 1), null)
})

test('no walk is longer than MAX_SLIDES, whatever the list or the length says', () => {
  /*
   * A screen that has not opened the deck walks up to one past the furthest
   * slide a sheet follows (walk.ts · `walkLength`). A sheet "after slide
   * 10 000 000" cost such a screen a quarter of a second and ten million
   * items on every change of the lecture, and one after slide 1 000 000 000
   * froze it for good.
   */
  // A length a hundred times the ceiling first: without the bound this fails at once instead of hanging below.
  assert.equal(lectureSequence(MAX_SLIDES * 100, undefined).length, MAX_SLIDES)
  const far: LectureSheet[] = [{ page: -1, after: 1e9 }]
  const sequence = lectureSequence(walkLength(0, far, 1, 1), far)
  assert.equal(sequence.length, MAX_SLIDES + 1)
  assert.deepEqual(sequence.slice(-2), [MAX_SLIDES, -1], 'the far sheet does not stand at the end of the walk')
  assert.equal(lectureSequence(Number.POSITIVE_INFINITY, undefined).length, MAX_SLIDES)
  // A step by the slide's own number stops at the ceiling too: the server refuses a turn past it.
  assert.equal(stepIn([], MAX_SLIDES - 1, 1), MAX_SLIDES)
  assert.equal(stepIn([], MAX_SLIDES, 1), null)
  assert.equal(stepIn([], MAX_SLIDES, -1), MAX_SLIDES - 1)
})

test('"Sheet N" is the place among the sheets in deck order, not the number', () => {
  const sequence = lectureSequence(3, [
    { page: -5, after: 1 },
    { page: -2, after: 3 },
    { page: -9, after: 3 },
  ])
  assert.equal(sheetNumber(sequence, -5), 1)
  assert.equal(sheetNumber(sequence, -2), 2)
  assert.equal(sheetNumber(sequence, -9), 3)
  assert.equal(sheetNumber(sequence, 2), 0, 'a slide got a sheet number')
  assert.equal(sheetNumber(sequence, -7), 0, 'an unknown sheet got a number')
})

/* ---------------------------------------------------------- the wire */

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
}

function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  return { ws: fake as unknown as WebSocket, heard }
}

let wires = 0

/** A room with the presenter's console and one seat in the hall, the lecture on slide 1. */
function wired(): { id: string; who: TokenPayload; pen: Fake; hall: Fake } {
  const id = `sheets-wire-${++wires}`
  createSession(id, 'Листы', null)
  const who: TokenPayload = { sessionId: id, participantId: 'p_host', role: 'host' }
  const pen = socket()
  const hall = socket()
  handleControlSocket(pen.ws, id, who)
  handleControlSocket(hall.ws, id, { sessionId: id, participantId: 'p_student', role: 'participant' })
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  pen.heard.length = 0
  hall.heard.length = 0
  return { id, who, pen, hall }
}

function done(id: string): void {
  stopLecture(id)
  closeControlRoom(id)
}

const kinds = (heard: ControlServerMessage[]) => heard.map((frame) => frame.t)

test('an added sheet reaches the hall as the new state, followed by its clean page', () => {
  const { id, who, pen, hall } = wired()
  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'add', after: 1, paper: 'lines' })
  assert.deepEqual(kinds(hall.heard), ['lecture', 'ink:page'])
  const [state, page] = hall.heard
  assert.ok(state.t === 'lecture' && state.state)
  assert.equal(state.state.page, -1)
  assert.deepEqual(state.state.sheets, [{ page: -1, after: 1, paper: 'lines' }])
  assert.deepEqual(page, { t: 'ink:page', page: -1, strokes: [] })
  done(id)
})

test('the 51st sheet is refused in words, to the one who pressed only', () => {
  const { id, who, pen, hall } = wired()
  for (let i = 0; i < MAX_SHEETS; i += 1) addSheet(id, 1)
  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'add', after: 1 })
  assert.deepEqual(pen.heard, [{ t: 'error', message: sheetsFullSays() }], 'the refusal was silent')
  assert.deepEqual(hall.heard, [], 'the hall heard about a sheet that was not made')
  // And the words name the ceiling the server enforces, not a number typed into them.
  assert.match(sheetsFullSays(), new RegExp(`\\b${MAX_SHEETS}\\b`))
  assert.doesNotMatch(sheetsFullSays(), /\{p0\}/)
  done(id)
})

test('a deleted sheet: the state, the ink of the page the hall moved to, the clear, the inventory', () => {
  const { id, who, pen, hall } = wired()
  turnTo(id, 2)
  addInk(id, dab(2, 'on slide 2'))
  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'add', after: 2 })
  dispatch(pen.ws, id, who, { t: 'ink', ...dab(-1, 'on the sheet') })
  hall.heard.length = 0

  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'drop', page: -1 })
  assert.deepEqual(kinds(hall.heard), ['lecture', 'ink:page', 'ink:clear', 'ink:pages'])
  const [state, page, clear, pages] = hall.heard
  assert.ok(state.t === 'lecture' && state.state)
  assert.equal(state.state.page, 2, 'the hall stayed on a deleted sheet')
  assert.deepEqual(state.state.sheets, [])
  assert.ok(page.t === 'ink:page')
  assert.deepEqual([page.page, page.strokes.map((stroke) => stroke.id)], [2, ['on slide 2']])
  assert.deepEqual(clear, { t: 'ink:clear', page: -1 })
  assert.deepEqual(pages, { t: 'ink:pages', pages: [2] })
  done(id)
})

test('a late stroke for a deleted sheet reaches nobody and brings nothing back', () => {
  const { id, who, pen, hall } = wired()
  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'add', after: 1 })
  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'drop', page: -1 })
  hall.heard.length = 0
  dispatch(pen.ws, id, who, { t: 'ink', ...dab(-1, 'late') })
  dispatch(pen.ws, id, who, { t: 'lecture:page', page: -1 })
  assert.deepEqual(hall.heard, [], 'the deleted sheet came back')
  assert.deepEqual(inkedPagesOf(id), [])
  assert.deepEqual(lectureOf(id)?.sheets, [])
  done(id)
})

test('over the wire a slide no deck has changes nothing: no turn, and the sheet goes after the page shown', () => {
  const { id, who, pen, hall } = wired()
  dispatch(pen.ws, id, who, { t: 'lecture:page', page: 3 })
  hall.heard.length = 0
  dispatch(pen.ws, id, who, { t: 'lecture:page', page: 1e9 })
  assert.deepEqual(kinds(hall.heard), [], 'the hall heard about a slide no deck has')

  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'add', after: 1e9 })
  const [added] = hall.heard
  assert.ok(added?.t === 'lecture' && added.state)
  assert.deepEqual(added.state.sheets, [{ page: -1, after: 3 }])

  // And deleting it is one step back to slide 3, at once.
  hall.heard.length = 0
  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'drop', page: -1 })
  const [back] = hall.heard
  assert.ok(back?.t === 'lecture' && back.state)
  assert.equal(back.state.page, 3)
  done(id)
})

test('paper reaches the hall only when it changes', () => {
  const { id, who, pen, hall } = wired()
  addSheet(id, 1)
  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'paper', page: -1, paper: 'grid' })
  dispatch(pen.ws, id, who, { t: 'lecture:sheet', op: 'paper', page: -1, paper: 'grid' })
  assert.deepEqual(kinds(hall.heard), ['lecture'])
  const [state] = hall.heard
  assert.ok(state.t === 'lecture')
  assert.equal(state.state?.sheets?.[0]?.paper, 'grid')
  done(id)
})

test('an old console\'s sheet over the wire: the state with the sheet in it, then its page', () => {
  const { id, who, pen, hall } = wired()
  dispatch(pen.ws, id, who, { t: 'lecture:page', page: -1 })
  assert.deepEqual(kinds(hall.heard), ['lecture', 'ink:page'])
  const [state] = hall.heard
  assert.ok(state.t === 'lecture')
  assert.deepEqual(state.state?.sheets, [{ page: -1, after: 1 }])
  done(id)
})

test('sheets are the presenter\'s: anyone else is refused, silently', () => {
  const { id, pen, hall } = wired()
  const student: TokenPayload = { sessionId: id, participantId: 'p_student', role: 'participant' }
  const tries: ControlClientMessage[] = [
    { t: 'lecture:sheet', op: 'add', after: 1 },
    { t: 'lecture:sheet', op: 'drop', page: -1 },
    { t: 'lecture:sheet', op: 'paper', page: -1, paper: 'grid' },
  ]
  addSheet(id, 1)
  turnTo(id, 1)
  hall.heard.length = 0
  for (const message of tries) dispatch(hall.ws, id, student, message)
  assert.deepEqual(hall.heard, [])
  assert.deepEqual(pen.heard.filter((frame) => frame.t === 'lecture'), [])
  assert.deepEqual(lectureOf(id)?.sheets, [{ page: -1, after: 1 }])
  done(id)
})

test('a latecomer gets the sheets with the lecture, in the welcome batch', () => {
  const { id } = wired()
  addSheet(id, 1, 'dots')
  const late = socket()
  handleControlSocket(late.ws, id, { sessionId: id, participantId: 'p_late', role: 'participant' })
  const state = late.heard.find((frame) => frame.t === 'lecture')
  assert.ok(state && state.t === 'lecture')
  assert.deepEqual(state.state?.sheets, [{ page: -1, after: 1, paper: 'dots' }])
  done(id)
})
