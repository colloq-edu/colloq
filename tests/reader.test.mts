/**
 * Подписи публичных страниц.
 *
 * Числительное здесь — не украшение: страница курса и шапка семинара это первое,
 * что видит класс по ссылке, которую ему дали, и «6 шага» в ней читается как
 * недоделанная страница. Считалось тернарником «=== 1 ? то : это» в четырёх
 * местах, и каждое врало по-своему.
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
  // Ровно то, на чём ломались обе прежние формулы: 11 давало «шага», а
  // «n < 5 ? шага : шагов» — «11 шагов» верно, но «21 шагов» уже нет.
  for (const n of [11, 12, 13, 14]) assert.equal(step(n), `${n} шагов`)
})

test('past twenty the rule starts over', () => {
  assert.equal(step(21), '21 шаг')
  assert.equal(step(22), '22 шага')
  assert.equal(step(25), '25 шагов')
  assert.equal(step(101), '101 шаг')
  assert.equal(step(111), '111 шагов')
})
