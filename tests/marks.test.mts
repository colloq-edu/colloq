/**
 * The animal a student is given.
 *
 * It is their cursor and their face in the room for the next ninety minutes,
 * nobody chooses it before they arrive, and two people holding the same one
 * makes the notebook harder to read. The rules are small and every one of them
 * fails quietly: a returning student silently becoming a different animal, a
 * full room handing out duplicates while free marks are left on the shelf, or
 * — worst — a full room refusing to hand out anything at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARKS, freeMark, markName } from '../web/src/lib/marks.js'

const all = MARKS.map((m) => m.mark)
const takenBy = (marks: string[]): Map<string, string> =>
  new Map(marks.map((m, i) => [m, `p_${i}`]))

test('there are enough marks for a seminar group', () => {
  assert.ok(MARKS.length >= 30, `only ${MARKS.length} marks for a class of thirty`)
  assert.equal(new Set(all).size, MARKS.length, 'the same mark is listed twice')
  assert.equal(new Set(MARKS.map((m) => m.name)).size, MARKS.length, 'two marks share a name')
})

test('an empty room hands out something from the list', () => {
  const mark = freeMark(new Map())
  assert.ok(all.includes(mark), `${mark} is not one of the marks`)
})

test('a mark somebody holds is not handed out again', () => {
  // Everyone but one, so there is exactly one right answer.
  const free = all[17]
  const taken = takenBy(all.filter((m) => m !== free))
  for (let i = 0; i < 20; i++) assert.equal(freeMark(taken), free)
})

test('a student who comes back is the same animal', () => {
  const mine = all[3]
  const taken = takenBy([all[0], all[1]])
  for (let i = 0; i < 20; i++) assert.equal(freeMark(taken, mine), mine)
})

test('but not if somebody else took it while they were away', () => {
  const mine = all[3]
  const taken = takenBy([mine, all[0]])
  const given = freeMark(taken, mine)
  assert.notEqual(given, mine)
  assert.ok(all.includes(given))
})

test('a mark this browser remembers but the room has never heard of is ignored', () => {
  // An older version's emoji, or a hand-edited localStorage.
  const given = freeMark(new Map(), '🦄')
  assert.ok(all.includes(given), 'an unknown mark was handed straight back')
})

test('a full room shares a mark rather than closing the door', () => {
  const taken = takenBy(all)
  const given = freeMark(taken)
  assert.ok(all.includes(given), 'a full room handed out nothing at all')
})

test('a full room still gives a returning student a mark', () => {
  const taken = takenBy(all)
  const given = freeMark(taken, all[5])
  assert.ok(all.includes(given))
})

test('the card can name every mark, and has a word for none', () => {
  for (const { mark } of MARKS) {
    const name = markName(mark)
    assert.notEqual(name, 'mark', `${mark} has no name to put on the card`)
    // "The T. rex is yours" reads fine, so no rule about case here — only that
    // it is a single short word-or-two that can follow "The".
    assert.ok(name.length > 1 && name.length < 20, `"${name}" is not a word for a card`)
    assert.ok(!/[\n<>]/.test(name), `"${name}" is not plain text`)
  }
  assert.equal(markName(null), 'mark')
  assert.equal(markName('🦄'), 'mark')
})
