/**
 * What the course page says about time, decided without a browser.
 *
 * Every rule here was a sentence in the page's design: «Следующее» is the
 * nearest class after the server's today, «Прошлое» the latest before it,
 * «Первое занятие» before the course starts, «Последнее» after it ends; the
 * «сегодня» line sits between the past and the future; months head the list
 * and name the year only when it changes; «по воскресеньям» needs three days
 * and four fifths of them. A page that broke one of them would still render,
 * which is why they are pinned here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import type { PublicClass } from '../shared/publish.js'
import {
  courseMonths,
  courseNow,
  coursePlan,
  courseTally,
  courseWeekday,
  courseYears,
  longDay,
  monthName,
  rowLine,
  rowNote,
  upcomingLabel,
  pastLabel,
  FOLD_MIN,
} from '../web/src/lib/course-now.js'

setLocaleResolver(() => 'ru')

let seq = 0
function row(day: string | null, extra: Partial<PublicClass> = {}): PublicClass {
  seq++
  return {
    key: `r${seq}`,
    n: null,
    title: `Тема ${seq}`,
    about: null,
    day,
    when: null,
    state: 'plan',
    page: null,
    ...extra,
  }
}

/** Numbers the non-pause rows the way the server does (course-view.ts · courseRows). */
function course(rows: PublicClass[]): PublicClass[] {
  let n = 0
  return rows.map((r) => (r.state === 'pause' ? { ...r, n: null } : { ...r, n: ++n }))
}

const page = (materials: { kind: 'notebook' | 'pdf' | 'data'; name: string }[] = []) => ({
  address: 'ml-01',
  materials: materials.map((m, i) => ({ key: `k${i}`, kind: m.kind, name: m.name, bytes: 1000 })),
  zipBytes: 2000,
  updatedAt: 0,
})

const SUNDAYS = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-10-04', '2026-10-11']

function plan(): PublicClass[] {
  return course(
    SUNDAYS.map((day, i) =>
      i < 3 ? row(day, { state: 'page', page: page([{ kind: 'notebook', name: 'Лекция' }]) }) : row(day),
    ),
  )
}

/* ------------------------------------------------------------- now blocks */

test('between classes: the next is the nearest after today, the past the latest before it', () => {
  const classes = plan()
  const now = courseNow(classes, '2026-10-02')
  assert.ok(now)
  assert.equal(now.upcoming?.kind, 'next')
  assert.equal(now.upcoming?.row.day, '2026-10-04')
  assert.equal(now.upcoming?.inDays, 2)
  assert.equal(now.past?.kind, 'past')
  assert.equal(now.past?.row.day, '2026-09-20')
  assert.equal(now.over, false)
  assert.equal(upcomingLabel(now.upcoming!), 'Следующее · вс, 4 окт · через 2 дня')
  assert.equal(pastLabel(now.past!), 'Прошлое занятие · вс, 20 сен')
})

test('on the class day the class is «сегодня», and tomorrow reads as a word', () => {
  const classes = plan()
  const today = courseNow(classes, '2026-10-04')
  assert.equal(today?.upcoming?.kind, 'today')
  assert.equal(today?.upcoming?.inDays, 0)
  assert.equal(upcomingLabel(today!.upcoming!), 'Сегодня · вс, 4 окт')
  const eve = courseNow(classes, '2026-10-03')
  assert.equal(upcomingLabel(eve!.upcoming!), 'Следующее · вс, 4 окт · завтра')
})

test('before the first class it is «Первое занятие», after the last «Последнее», and the course is over', () => {
  const classes = plan()
  const before = courseNow(classes, '2026-09-02')
  assert.equal(before?.upcoming?.kind, 'first')
  assert.equal(before?.past, null)
  assert.equal(upcomingLabel(before!.upcoming!), 'Первое занятие · вс, 6 сен · через 4 дня')

  const after = courseNow(classes, '2026-12-01')
  assert.equal(after?.upcoming, null)
  assert.equal(after?.past?.kind, 'last')
  assert.equal(after?.past?.row.day, '2026-10-11')
  assert.equal(after?.over, true)
  assert.match(pastLabel(after!.past!), /^Последнее занятие · /)
})

test('a past class without a page offers the latest one that has a page', () => {
  const classes = course([
    row('2026-09-06', { state: 'page', page: page([{ kind: 'notebook', name: 'Лекция' }]) }),
    row('2026-09-13', { state: 'page', page: page([{ kind: 'notebook', name: 'Лекция' }]) }),
    row('2026-09-20', { state: 'room' }),
    row('2026-10-04'),
  ])
  const now = courseNow(classes, '2026-10-02')
  assert.equal(now?.past?.row.day, '2026-09-20')
  assert.equal(now?.past?.latest?.day, '2026-09-13')
})

test('an undated course has no «сейчас» at all', () => {
  const classes = course([row(null, { when: '1–7 сен' }), row(null, { when: '8–14 сен' })])
  assert.equal(courseNow(classes, '2026-10-02'), null)
  assert.equal(courseYears(classes), null)
  assert.equal(courseWeekday(classes), null)
  const list = coursePlan(classes, '2026-10-02')
  assert.ok(list.entries.every((entry) => entry.kind === 'row'), 'an undated course grew month labels')
  const note = rowNote(classes[0], '2026-10-02', { next: false, withDate: true })
  assert.equal(rowLine(note), '1–7 сен', 'the legacy week text is not printed verbatim')
  // The wide layout prints the week in its day column: line 2 does not repeat it.
  assert.equal(rowLine(rowNote(classes[0], '2026-10-02', { next: false, withDate: false })), '')
  // And an undated row with a page says what is on it, as a dated row does.
  const published = row(null, { when: '14–20 сен', state: 'page', page: page([{ kind: 'notebook', name: 'Семинар' }]) })
  assert.equal(rowLine(rowNote(published, '2026-10-02', { next: false, withDate: true })), '14–20 сен · семинар')
  assert.equal(rowLine(rowNote(published, '2026-10-02', { next: false, withDate: false })), 'семинар')
})

/* ---------------------------------------------------------------- the list */

test('pause rows get no number and never start a month', () => {
  const classes = course([
    row('2026-12-20'),
    row('2026-12-27'),
    row(null, { state: 'pause', title: 'Каникулы', when: '28 дек — 9 янв' }),
    row('2027-01-10'),
  ])
  assert.deepEqual(
    classes.map((c) => c.n),
    [1, 2, null, 3],
  )
  const tally = courseTally(classes, '2026-10-02')
  assert.equal(tally.classes, 3, 'a pause was counted as a class')
  const labels = coursePlan(classes, '2026-10-02').entries.filter((e) => e.kind === 'month')
  assert.equal(labels.length, 2)
})

test('month labels head the list and name the year only when it changes', () => {
  const classes = course(['2026-09-06', '2026-09-13', '2026-10-04', '2027-01-10', '2027-02-07'].map((d) => row(d)))
  const months = coursePlan(classes, '2026-09-01').entries.flatMap((e) =>
    e.kind === 'month' ? [monthName(e.month, e.year)] : [],
  )
  assert.deepEqual(months, ['сентябрь', 'октябрь', 'январь 2027', 'февраль'])
})

test('the «сегодня» line sits between the last past class and the first future one', () => {
  const classes = plan()
  const entries = coursePlan(classes, '2026-10-02').entries
  const at = entries.findIndex((e) => e.kind === 'now')
  assert.ok(at > 0, 'there is no «сегодня» line')
  const before = entries.slice(0, at).filter((e) => e.kind === 'row')
  assert.equal(before.at(-1)?.kind === 'row' && before.at(-1)?.row.day, '2026-09-20')
  // Before the October label, not inside October.
  assert.equal(entries[at + 1].kind, 'month')

  // On the class day the row carries the accent instead of a line.
  const onDay = coursePlan(classes, '2026-10-04').entries
  assert.equal(onDay.some((e) => e.kind === 'now'), false)
  assert.ok(onDay.some((e) => e.kind === 'row' && e.today && e.row.day === '2026-10-04'))
  // Before the first class nothing is behind: no line either.
  assert.equal(coursePlan(classes, '2026-09-01').entries.some((e) => e.kind === 'now'), false)
})

test('a long plan folds from the first class more than three months ahead', () => {
  const days: string[] = []
  for (let i = 0; i < 30; i++) {
    const at = new Date(Date.UTC(2026, 8, 6 + i * 7))
    days.push(at.toISOString().slice(0, 10))
  }
  const classes = course(days.map((d) => row(d)))
  const list = coursePlan(classes, '2026-10-02')
  assert.ok(list.folded, 'thirty weeks of plan did not fold')
  assert.ok(list.folded.classes > FOLD_MIN)
  const first = list.entries[list.folded.from]
  // The fold starts at the month label of the first far class, not mid-month.
  assert.equal(first.kind, 'month')
  const short = coursePlan(course(days.slice(0, 12).map((d) => row(d))), '2026-10-02')
  assert.equal(short.folded, null, 'a dozen rows folded away')
})

test('a course shared months before it starts still lists its first classes', () => {
  /*
   * Next year's link goes out in June: every class is more than three months
   * away, and a horizon counted from today folded from row 01, so «ЗАНЯТИЯ»
   * showed only «показать весь план». The horizon starts at the next class.
   */
  const days: string[] = []
  for (let i = 0; i < 33; i++) days.push(new Date(Date.UTC(2026, 8, 6 + i * 7)).toISOString().slice(0, 10))
  const classes = course(days.map((d) => row(d)))
  const list = coursePlan(classes, '2026-06-10')
  assert.ok(list.folded, 'thirty-three weeks of plan did not fold')
  const shown = list.entries.slice(0, list.folded.from).filter((e) => e.kind === 'row')
  assert.ok(shown.length >= 8, `only ${shown.length} rows before the fold`)
  assert.equal(shown[0].kind === 'row' && shown[0].row.day, '2026-09-06', 'the first class was folded away')
})

/* -------------------------------------------------------------- the header */

test('«по воскресеньям» needs three dated classes and four fifths on one weekday', () => {
  assert.equal(courseWeekday(course(SUNDAYS.slice(0, 2).map((d) => row(d)))), null, 'two days are not a rule')
  assert.equal(courseWeekday(course(SUNDAYS.map((d) => row(d)))), 0)
  // Four Sundays and a Saturday: 80%, still a Sunday course.
  assert.equal(courseWeekday(course([...SUNDAYS.slice(0, 4), '2026-10-10'].map((d) => row(d)))), 0)
  // Three Sundays and two Saturdays: 60%, no rule.
  assert.equal(courseWeekday(course([...SUNDAYS.slice(0, 3), '2026-10-10', '2026-10-17'].map((d) => row(d)))), null)
})

test('the academic year and the month span come from the class days', () => {
  const classes = course(['2026-09-06', '2027-05-02'].map((d) => row(d)))
  assert.equal(courseYears(classes), '2026/27')
  assert.equal(courseYears(course([row('2026-09-06'), row('2026-12-20')])), '2026')
  assert.deepEqual(courseMonths(classes), { first: '2026-09-06', last: '2027-05-02' })
  assert.equal(courseMonths(course([row('2026-09-06'), row('2026-09-20')])), null)
})

test('the tally counts pages and what is still ahead', () => {
  const classes = plan()
  assert.deepEqual(courseTally(classes, '2026-10-02'), { classes: 5, pages: 3, ahead: 2 })
  // Today's class without a page is still ahead.
  assert.equal(courseTally(classes, '2026-10-04').ahead, 2)
})

/* ---------------------------------------------------------------- the rows */

test('row line 2 says what a student needs, by state', () => {
  const today = '2026-10-02'
  const withPage = row('2026-09-20', {
    state: 'page',
    page: page([
      { kind: 'notebook', name: 'Семинар' },
      { kind: 'notebook', name: 'Лекция' },
      { kind: 'pdf', name: 'Слайды лекции' },
      { kind: 'data', name: 'data/train.csv' },
    ]),
  })
  const line = (r: PublicClass, next = false, t = today) => rowLine(rowNote(r, t, { next, withDate: true }))
  assert.equal(line(withPage), 'вс, 20 сен · лекция · семинар · слайды · данные')
  assert.equal(
    line(row('2026-10-11', { state: 'page', page: page([{ kind: 'notebook', name: 'Семинар' }]) })),
    'вс, 11 окт · материалы до занятия: семинар',
  )
  assert.equal(line(row('2026-10-11')), 'вс, 11 окт')
  assert.equal(line(row('2026-10-02', { state: 'room' })), 'сегодня · материалы после занятия')
  assert.equal(line(row('2026-09-13', { state: 'room' })), 'вс, 13 сен · материалов пока нет')
  assert.equal(line(row('2026-09-13', { state: 'closed' })), 'вс, 13 сен · материалов нет')
  assert.equal(line(row('2026-10-04'), true), 'вс, 4 окт · следующее · через 2 дня')
  // The wide layout prints the day in a column of its own.
  assert.equal(rowLine(rowNote(withPage, today, { next: false, withDate: false })), 'лекция · семинар · слайды · данные')
})

test('days are formatted from the date itself, never shifted by a zone', () => {
  assert.equal(longDay('2026-09-13'), 'воскресенье, 13 сентября 2026')
  assert.equal(longDay('2026-09-13', 'short'), 'вс, 13 сентября 2026')
  assert.equal(longDay('2026-10-04', null), '4 октября 2026')
  assert.equal(longDay('2026-09-13', 'long', 'en'), 'Sunday, September 13, 2026')
})
