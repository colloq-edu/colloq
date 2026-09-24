/**
 * Captions of the public pages.
 *
 * The numeral here is not decoration: the course page and the seminar header
 * are the first thing a class sees at the link it was given, and "6 шага" there
 * reads as an unfinished page. It used to be a ternary "=== 1 ? this : that"
 * in four places, and each one lied in its own way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plural } from '../web/src/lib/plural.js'

const step = (n: number): string => `${n} ${plural(n, 'шаг', 'шага', 'шагов')}`

test('one, a few, and many', () => {
  assert.equal(step(1), '1 шаг')
  assert.equal(step(2), '2 шага')
  assert.equal(step(4), '4 шага')
  assert.equal(step(5), '5 шагов')
  assert.equal(step(0), '0 шагов')
})

test('the teens are all many', () => {
  // Exactly where both earlier formulas broke: 11 gave "шага", and with
  // "n < 5 ? шага : шагов", "11 шагов" is right but "21 шагов" is not.
  for (const n of [11, 12, 13, 14]) assert.equal(step(n), `${n} шагов`)
})

test('past twenty the rule starts over', () => {
  assert.equal(step(21), '21 шаг')
  assert.equal(step(22), '22 шага')
  assert.equal(step(25), '25 шагов')
  assert.equal(step(101), '101 шаг')
  assert.equal(step(111), '111 шагов')
})
