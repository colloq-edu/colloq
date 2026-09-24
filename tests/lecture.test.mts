/**
 * The lecture's memory: the page, the ink and the ceilings.
 *
 * Everything checked here breaks silently and in the middle of class. A
 * stroke whose continuation the server lost is a line cut off in the middle
 * of a formula for twenty people at once; a ceiling that did not kick in is a
 * latecomer's browser spending a minute parsing the welcome batch; a host
 * determined wrongly is someone else's tablet flipping through your lecture.
 *
 * No network: this is pure process memory, and it has to be checked where it
 * lives, not through a socket.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addInk,
  clearInk,
  eraseInk,
  forgetLecture,
  handOver,
  inkOf,
  isPresenter,
  lectureOf,
  moveLecture,
  setBlank,
  startLecture,
  stopLecture,
  turnTo,
  undoInk,
} from '../server/src/lecture.js'

let n = 0
/** A room of its own for each test: the module is shared process memory. */
function room(): string {
  const id = `lec${++n}`
  startLecture(id, { file: 'slides.pdf', by: 'teacher', byName: 'Ада', color: '#d4162f' })
  return id
}

test('a lecture starts on the first page and not blanked', () => {
  const id = room()
  const state = lectureOf(id)
  assert.equal(state?.page, 1)
  assert.equal(state?.blank, false)
  assert.equal(state?.file, 'slides.pdf')
})

test('the host is whoever started it, and only them', () => {
  const id = room()
  assert.equal(isPresenter(id, 'teacher'), true)
  assert.equal(isPresenter(id, 'student'), false)
  // A room without a lecture gives the console to nobody: otherwise a
  // `lecture:page` from a tab that did not learn the lecture ended would bring
  // it back to life for everyone.
  assert.equal(isPresenter('нет такой комнаты', 'teacher'), false)
})

test('a lecture on a different document starts clean', () => {
  // A different document is a different lecture, and ink from the previous one
  // on its pages would mean markup drawn over someone else's text.
  const id = room()
  addInk(id, { id: 's1', page: 1, color: '#000', width: 0.004, points: [0.1, 0.1] })
  startLecture(id, { file: 'other.pdf', by: 'second', byName: 'Борис', color: '#0f2d69' })
  assert.equal(isPresenter(id, 'teacher'), false)
  assert.equal(isPresenter(id, 'second'), true)
  assert.deepEqual(inkOf(id), [])
})

test('handing over the console changes hands and does not touch the lecture itself', () => {
  /*
   * A second teacher has no other way to say "I will take over": the "take
   * the console" button sends the same `lecture:start` for the same file. If
   * it went into `startLecture`, a press in the fortieth minute would send the
   * page back to the first one, erase all the markup and reset the clock — in
   * front of everyone, on the projector.
   */
  const id = room()
  turnTo(id, 14)
  setBlank(id, true)
  addInk(id, { id: 's1', page: 14, color: '#000', width: 0.004, points: [0.1, 0.1] })
  const began = lectureOf(id)?.startedAt

  const taken = handOver(id, 'slides.pdf', 'second', 'Борис', '#0f2d69')
  assert.equal(taken?.by, 'second')
  assert.equal(taken?.byName, 'Борис')
  assert.equal(taken?.color, '#0f2d69')

  assert.equal(taken?.page, 14, 'the page went back to the start')
  assert.equal(taken?.blank, true, 'the pause lifted by itself')
  assert.equal(taken?.startedAt, began, 'the lecture clock started over')
  assert.equal(inkOf(id).length, 1, 'the markup was erased')
  assert.equal(isPresenter(id, 'second'), true)
  assert.equal(isPresenter(id, 'teacher'), false)
})

test('there is nothing to hand over if the file is different or there is no lecture at all', () => {
  // On a different document this is no longer a handover but a new lecture,
  // and it has to start clean — here we stay quiet about it and leave the
  // decision to the caller.
  const id = room()
  assert.equal(handOver(id, 'other.pdf', 'second', 'Борис', '#0f2d69'), null)
  assert.equal(lectureOf(id)?.by, 'teacher')
  assert.equal(handOver('нет такой комнаты', 'slides.pdf', 'second', 'Борис', '#0f2d69'), null)
})

test('the page does not go below the first and is not broadcast when unchanged', () => {
  const id = room()
  assert.equal(turnTo(id, 4)?.page, 4)
  // Zero is not a page but junk from a tab: there is nothing to broadcast for
  // it.
  assert.equal(turnTo(id, 0), null)
  assert.equal(lectureOf(id)?.page, 4, 'page zero reached the hall')
  assert.equal(turnTo(id, 4), null, 'the same page — nothing to broadcast')
  assert.equal(turnTo(id, 2.7)?.page, 2, 'a fractional page is rounded down')
})

test('a blank sheet is just a page, only with a minus', () => {
  /*
   * The slide ran out, but the derivation of the formula did not: the teacher
   * opens a white field right in the middle of the lecture. As a separate
   * state field this would be a second source of truth about what is on the
   * screen now, and it would drift apart from the page number on the very
   * first page turn. So a blank sheet is a page with a negative number, and
   * everything else about it already works.
   */
  const id = room()
  assert.equal(turnTo(id, -1)?.page, -1)
  addInk(id, { id: 'b1', page: -1, color: '#111', width: 0.004, points: [0.1, 0.1, 0.2, 0.2] })
  assert.deepEqual(inkOf(id).map((stroke) => stroke.page), [-1])

  // And going back to the slide does nothing to it: the sheet's ink stays on
  // it.
  assert.equal(turnTo(id, 3)?.page, 3)
  assert.equal(inkOf(id).length, 1)

  // A stuck button does not create sheets without end.
  assert.equal(turnTo(id, -5000)?.page, -50)
})

test('the pause toggles once', () => {
  const id = room()
  assert.equal(setBlank(id, true)?.blank, true)
  assert.equal(setBlank(id, true), null)
  assert.equal(setBlank(id, false)?.blank, false)
})

test('a stroke is extended by name, and only the new points are broadcast', () => {
  const id = room()
  const first = addInk(id, { id: 's1', page: 2, color: '#111', width: 0.004, points: [0, 0, 0.1, 0.1] })
  assert.deepEqual(first?.stroke?.points, [0, 0, 0.1, 0.1])

  const more = addInk(id, { id: 's1', page: 2, color: '#111', width: 0.004, points: [0.2, 0.2] })
  assert.deepEqual(more?.stroke?.points, [0.2, 0.2], 'only the continuation goes into the broadcast')
  assert.equal(more?.stroke?.id, 's1')

  // While memory holds the whole stroke: a latecomer gets it in one piece.
  assert.deepEqual(inkOf(id)[0].points, [0, 0, 0.1, 0.1, 0.2, 0.2])
  assert.equal(inkOf(id).length, 1)
})

test('a point without a pair and non-numbers do not get through', () => {
  const id = room()
  assert.equal(addInk(id, { id: 's1', page: 1, color: '#111', width: 0.004, points: [0.5] }), null)
  assert.equal(
    addInk(id, { id: 's2', page: 1, color: '#111', width: 0.004, points: [Number.NaN, Infinity] }),
    null,
  )
  assert.deepEqual(inkOf(id), [])
})

test('ink is not written at all into a room without a lecture', () => {
  assert.equal(
    addInk('пусто', { id: 's1', page: 1, color: '#111', width: 0.004, points: [0, 0] }),
    null,
  )
  assert.deepEqual(inkOf('пусто'), [])
})

test('ceilings: points per frame, points per stroke, strokes per page, pages', () => {
  const id = room()

  // A frame is trimmed, not dropped: a piece of a line is better than no line.
  const flood = Array.from({ length: 2_000 }, () => 0.5)
  assert.equal(
    addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: flood })?.stroke?.points
      .length,
    512,
  )

  // Stroke: one from a finger left resting on the screen stops growing.
  for (let i = 0; i < 20; i += 1) {
    addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: flood })
  }
  assert.ok(inkOf(id)[0].points.length <= 4_000 + 512)
  /*
   * And this is a refusal BY NAME, not silence: `null` here would mean
   * "nothing to add", and the console would resend the whole stroke eight
   * times before silently removing it from the sheet. Three ceilings — three
   * different words for the person.
   */
  assert.deepEqual(
    addInk(id, { id: 'big', page: 1, color: '#111', width: 0.004, points: [0.1, 0.1] }),
    { full: 'stroke-full' },
    'an overflowing stroke cannot be extended, and that must be said',
  )

  // Strokes per page.
  for (let i = 0; i < 700; i += 1) {
    addInk(id, { id: `s${i}`, page: 3, color: '#111', width: 0.004, points: [0, 0] })
  }
  assert.equal(inkOf(id).filter((stroke) => stroke.page === 3).length, 600)

  // Written-on pages: the welcome batch must stay finite.
  for (let page = 10; page < 400; page += 1) {
    addInk(id, { id: `p${page}`, page, color: '#111', width: 0.004, points: [0, 0] })
  }
  const pages = new Set(inkOf(id).map((stroke) => stroke.page))
  assert.equal(pages.size, 200)
})

test('undo removes the last stroke, and only on its own page', () => {
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'b', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'c', page: 2, color: '#111', width: 0.004, points: [0, 0] })

  assert.equal(undoInk(id, 1), 'b')
  assert.equal(undoInk(id, 1), 'a')
  assert.equal(undoInk(id, 1), null, 'there is nothing to undo on an empty page')
  assert.equal(inkOf(id).length, 1)
})

test('the eraser removes the named stroke, not the last one', () => {
  /*
   * Undo removes the LAST one, the eraser the one it touched. The difference
   * shows exactly when it matters: you run the eraser over the first of three
   * lines and would get the third one erased instead.
   */
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'b', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'c', page: 1, color: '#111', width: 0.004, points: [0, 0] })

  assert.equal(eraseInk(id, 1, 'a'), true)
  assert.deepEqual(inkOf(id).map((stroke) => stroke.id), ['b', 'c'])
})

test('the eraser answers whether there was a stroke there', () => {
  /*
   * The eraser passes over one stroke a dozen times per hand movement, and
   * without this answer every hit would broadcast "erase a stroke that does
   * not exist" — twenty browsers would redraw the page for nothing.
   */
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })

  assert.equal(eraseInk(id, 1, 'a'), true)
  assert.equal(eraseInk(id, 1, 'a'), false, 'a second pass over the same stroke')
  assert.equal(eraseInk(id, 1, 'нет такого'), false)
  // The page is named in the message, and another page must not do: otherwise
  // the eraser on the eighth slide would erase markup from the seventh.
  addInk(id, { id: 'b', page: 2, color: '#111', width: 0.004, points: [0, 0] })
  assert.equal(eraseInk(id, 1, 'b'), false)
  assert.equal(eraseInk(id, 9, 'b'), false, 'a page with no ink at all')
  assert.equal(inkOf(id).length, 1)
  assert.equal(eraseInk('нет такой комнаты', 1, 'a'), false)
})

test('a page or the whole lecture is erased', () => {
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  addInk(id, { id: 'b', page: 2, color: '#111', width: 0.004, points: [0, 0] })

  clearInk(id, 1)
  assert.deepEqual(inkOf(id).map((stroke) => stroke.page), [2])
  clearInk(id)
  assert.deepEqual(inkOf(id), [])
})

test('renaming a file takes the lecture along and leaves another one alone', () => {
  const id = room()
  assert.equal(moveLecture(id, 'other.pdf', 'renamed.pdf'), null)
  assert.equal(moveLecture(id, 'slides.pdf', 'lecture-01.pdf')?.file, 'lecture-01.pdf')
  assert.equal(lectureOf(id)?.file, 'lecture-01.pdf')
})

test('the end of the lecture takes the ink away too', () => {
  const id = room()
  addInk(id, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  stopLecture(id)
  assert.equal(lectureOf(id), null)
  assert.deepEqual(inkOf(id), [])

  const again = room()
  addInk(again, { id: 'a', page: 1, color: '#111', width: 0.004, points: [0, 0] })
  forgetLecture(again)
  assert.equal(lectureOf(again), null)
})
