/**
 * Two duration formats, and there will not be a third.
 *
 * A live figure holds its column and updates five times a second: a tenth of
 * a second and a leading zero. A finished one is read once, in a sentence:
 * no tenths and no leading zeros. The difference is deliberate, and without
 * a test it will disappear at the very first attempt to "bring it to one
 * form".
 */
import './_env.mts'
import { test, beforeEach, afterEach } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
beforeEach(() => setLocaleResolver(() => 'en'))
afterEach(() => setLocaleResolver(() => 'ru'))
import assert from 'node:assert/strict'
import { elapsed, NOTICED_MS, spell } from '../web/src/lib/utils.js'

test('a live duration grows by units', () => {
  const at = (ms: number) => elapsed(0, ms)
  assert.equal(at(0), '0.0s')
  assert.equal(at(12_340), '12.3s')
  assert.equal(at(59_900), '59.9s')
  assert.equal(at(60_000), '1m 00s')
  assert.equal(at(64_000), '1m 04s')
  assert.equal(at(3_599_000), '59m 59s')
  // The hour unit: without it a cell training a model printed "143m 07s".
  assert.equal(at(3_600_000), '1h 00m')
  assert.equal(at(8_580_000), '2h 23m')
})

test('a browser clock that lags behind gives zero, not a negative number', () => {
  // startedAt is server time; for someone whose clock lags, it is in the
  // future.
  assert.equal(elapsed(1_000_000, 999_000), '0.0s')
  assert.doesNotMatch(elapsed(1_000_000, 999_000), /-|NaN/)
})

test('a finished duration — no tenths and no leading zeros', () => {
  assert.equal(spell(null), '')
  assert.equal(spell(4_400), '4s')
  // Not "1m 04s": that is exactly the difference from the live figure.
  assert.equal(spell(64_000), '1m 4s')
  assert.equal(spell(80_000), '1m 20s')
  assert.equal(spell(3_600_000), '1h 0m')
  assert.equal(spell(8_580_000), '2h 23m')
})

test('the noticeability threshold is two seconds', () => {
  // A cell that ran for three hundred milliseconds must not acquire a
  // figure: by the end of a class there are forty such, and all of them
  // report that the computer is fast.
  assert.equal(NOTICED_MS, 2_000)
})
