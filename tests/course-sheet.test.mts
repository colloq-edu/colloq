/**
 * `make course`: the group's own class day comes in with the topic.
 *
 * Each group meets on its own weekday, so the timetable keeps a «дата» column
 * per group. The import used to read the topic and the week text only, and
 * every course started without days: the course page could not say which
 * class is next, and every room seated into a plan row had to be dated by
 * hand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { academicYearOf, classDayIn, parseCsv, planFromSheet } from '../scripts/course-sheet.mts'

/** The timetable as the CSV export writes it: merged group headers sit in their first column. */
const SHEET = [
  ['№', 'Неделя', 'ML · сильная', '', '', '', 'ML · базовая', '', ''],
  ['', '', 'дата', 'тема', 'преподаватель', 'ассистенты', 'дата', 'тема', 'преподаватель'],
  ['1', '31 авг — 6 сен', '06.09', 'Введение (31 авг — 6 сен)', 'Ада', '', '02.09', 'Основы', 'Ада'],
  ['2', '7–13 сен', '13.09', 'Дообучение и файн-тюнинг', 'Ада', '', '09.09', '—', 'Ада'],
  ['3', '', '', '—', '', '', '', '', ''],
  ['4', '28 дек — 3 янв', '', 'Каникулы', '', '', '', '', ''],
  ['5', '4–10 янв', '10.01', 'Деревья', 'Ада', '', '06.01', 'Леса', 'Ада'],
  ['6', '', '20.06', 'Итоговая защита', 'Ада', '', '', '', ''],
]

test('the topic, the week text and the group’s own day, with the year from the academic year', () => {
  const plan = planFromSheet(SHEET, 'ML · сильная', 2026)
  assert.ok(plan.ok)
  assert.equal(plan.dated, true)
  assert.deepEqual(plan.rows, [
    // The repeated week in parentheses is dropped from the topic.
    { name: 'Введение', when: '31 авг — 6 сен', day: '2026-09-06' },
    { name: 'Дообучение и файн-тюнинг', when: '7–13 сен', day: '2026-09-13' },
    // A row without a day keeps its week text and stays undated.
    { name: 'Каникулы', when: '28 дек — 3 янв', day: null },
    // January and June belong to the second year of 2026/27.
    { name: 'Деревья', when: '4–10 янв', day: '2027-01-10' },
    { name: 'Итоговая защита', when: '', day: '2027-06-20' },
  ])
})

test('another group reads its own date column, not the neighbour’s', () => {
  const plan = planFromSheet(SHEET, 'ML · базовая', 2026)
  assert.ok(plan.ok)
  assert.deepEqual(
    plan.rows.map((row) => [row.name, row.day]),
    [
      ['Основы', '2026-09-02'],
      ['Леса', '2027-01-06'],
    ],
  )
})

test('a timetable without date labels is read as before: the topic under the header, no day', () => {
  const old = [
    ['№', 'Неделя', 'ML · сильная', '', ''],
    ['', '', 'тема', 'преподаватель', 'ассистенты'],
    ['1', '1–7 сен', 'Регрессия', 'Ада', ''],
  ]
  const plan = planFromSheet(old, 'ML · сильная', 2026)
  assert.ok(plan.ok)
  assert.equal(plan.dated, false)
  assert.deepEqual(plan.rows, [{ name: 'Регрессия', when: '1–7 сен', day: null }])
})

test('a missing group names the ones there are', () => {
  const plan = planFromSheet(SHEET, 'ML · продвинутая', 2026)
  assert.equal(plan.ok, false)
  assert.match(plan.ok ? '' : plan.error, /ML · сильная · ML · базовая/)
})

test('the academic year turns in August, and a written year or weekday is respected', () => {
  assert.equal(academicYearOf('2026-10-02'), 2026)
  assert.equal(academicYearOf('2027-03-01'), 2026)
  assert.equal(academicYearOf('2026-08-01'), 2026)
  assert.equal(classDayIn('06.09.2025', 2026), '2025-09-06')
  assert.equal(classDayIn('вс, 06.09', 2026), '2026-09-06')
  // 6 September 2026 is a Sunday: a cell that says Monday is a typo, not a day.
  assert.equal(classDayIn('пн, 06.09', 2026), null)
  assert.equal(classDayIn('', 2026), null)
  assert.equal(classDayIn('по договорённости', 2026), null)
})

test('the CSV reader keeps commas and line breaks inside quotes', () => {
  assert.deepEqual(parseCsv('a,"b, c","d\n""e"""\r\nf,,'), [
    ['a', 'b, c', 'd\n"e"'],
    ['f', '', ''],
  ])
})
