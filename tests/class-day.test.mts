/**
 * Class days: calendar dates that no zone can move.
 *
 * A course row says "Sunday, 6 September". Stored as a moment it would show
 * up as Saturday on a phone set to UTC−5, and the week texts written by 0.12
 * («вс, 6 сен») have to become days without inventing one a range does not
 * name (shared/class-day.ts).
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays,
  dayOf,
  daysBetween,
  formatDay,
  isClassDay,
  parseWhen,
  weekdayOf,
} from '../shared/class-day.js'
import { instanceToday } from '../server/src/time-zone.js'

test('a week text naming one day becomes that day, in the year nearest the course', () => {
  assert.equal(parseWhen('вс, 6 сен', '2026-09-01'), '2026-09-06')
  // January after a September start is next January.
  assert.equal(parseWhen('вс, 10 янв', '2026-09-01'), '2027-01-10')
  // The weekday settles a year the window holds twice: 7 March 2026 is a Saturday.
  assert.equal(parseWhen('вс, 7 мар', '2026-09-01'), '2027-03-07')
  assert.equal(parseWhen('Sun, Sep 6', '2026-09-01'), '2026-09-06')
  assert.equal(parseWhen('6 сентября', '2026-09-01'), '2026-09-06')
  assert.equal(parseWhen('2026-09-06', '2026-09-01'), '2026-09-06')
})

test('a day without a weekday is taken as written', () => {
  assert.equal(parseWhen('06.09', '2026-09-01'), '2026-09-06')
  assert.equal(parseWhen('6 сен', '2026-09-01'), '2026-09-06')
  assert.equal(parseWhen('06.09.2026', '2026-09-01'), '2026-09-06')
  assert.equal(parseWhen('6 Sep', '2026-09-01'), '2026-09-06')
})

test('a weekday that disagrees leaves the row undated', () => {
  // 6 September 2026 is a Sunday, not a Monday.
  assert.equal(parseWhen('пн, 6 сен', '2026-09-01'), null)
  assert.equal(parseWhen('Mon, 06.09.2026', '2026-09-01'), null)
})

test('week ranges and anything that is not one day are left alone', () => {
  assert.equal(parseWhen('31 авг — 6 сен', '2026-09-01'), null)
  assert.equal(parseWhen('1–28 фев', '2026-09-01'), null)
  assert.equal(parseWhen('14–20 сен', '2026-09-01'), null)
  assert.equal(parseWhen('после каникул', '2026-09-01'), null)
  assert.equal(parseWhen('31 фев', '2026-09-01'), null)
  assert.equal(parseWhen('', '2026-09-01'), null)
})

test('only real calendar dates are class days', () => {
  assert.ok(isClassDay('2026-10-04'))
  assert.ok(isClassDay('2028-02-29'))
  assert.ok(!isClassDay('2026-02-30'))
  assert.ok(!isClassDay('2026-13-01'))
  assert.ok(!isClassDay('4.10.2026'))
  assert.ok(!isClassDay(1_791_000_000_000))
})

test('day arithmetic crosses months and years', () => {
  assert.equal(addDays('2026-12-27', 14), '2027-01-10')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(daysBetween('2026-10-02', '2026-10-04'), 2)
  assert.equal(daysBetween('2026-10-04', '2026-10-02'), -2)
  assert.equal(weekdayOf('2026-10-04'), 0)
  assert.equal(weekdayOf('2026-10-02'), 5)
})

test('formatDay never shifts the day, whatever zone the process runs in', () => {
  const was = process.env.TZ
  try {
    for (const zone of ['Etc/GMT+12', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = zone
      assert.equal(formatDay('2026-10-04', 'ru'), 'вс, 4 окт')
      assert.equal(formatDay('2026-09-06', 'ru'), 'вс, 6 сен')
      assert.equal(formatDay('2027-05-02', 'ru'), 'вс, 2 мая')
      assert.equal(formatDay('2026-10-04', 'en'), 'Sun, Oct 4')
      assert.equal(formatDay('2027-01-10', 'ru', { year: true }), 'вс, 10 янв 2027')
      assert.equal(formatDay('2026-10-04', 'ru', { weekday: false }), '4 окт')
    }
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
})

test('the day of a moment is the day in the named zone', () => {
  const at = Date.UTC(2026, 9, 1, 21, 30)
  assert.equal(dayOf(at, 'UTC'), '2026-10-01')
  assert.equal(dayOf(at, 'Europe/Moscow'), '2026-10-02')
  assert.equal(dayOf(at, 'America/New_York'), '2026-10-01')
})

test('today on the instance is the instance zone’s day, not the process’s', () => {
  const was = process.env.TZ
  try {
    process.env.TZ = 'Europe/Moscow'
    // 21:30 UTC is already half past midnight in Moscow.
    assert.equal(instanceToday(Date.UTC(2026, 9, 1, 21, 30)), '2026-10-02')
    process.env.TZ = 'UTC'
    assert.equal(instanceToday(Date.UTC(2026, 9, 1, 21, 30)), '2026-10-01')
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
})
