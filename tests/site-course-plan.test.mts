/**
 * The schedule on the published course page.
 *
 * `colloq.ru/c/<course>` is the only address a class is given for the whole
 * year: it is dictated aloud, saved, and opened to see what is coming this
 * week. The page numbers its rows consecutively, and that numbering reads as a
 * schedule — so the weeks must be consecutive too. While in the "ML · strong"
 * plan "25–31 Jan" was followed by "1–7 Mar", February simply vanished: row 22
 * was in place, but the week after it was not, and the page could not be
 * checked against the timetable.
 *
 * The exported file is checked, not the database: that is what reaches the
 * student, and between the plan in the panel and the page on Pages stands
 * `make site`, which carries this hole over word for word. An unfilled week is
 * named with a row ("buffer", "holidays"), not skipped.
 *
 * The chain breaks by itself as soon as a held seminar appears in a row
 * instead of a topic: its caption has the publication date, not a week, and
 * how many weeks it took cannot be seen from the page. Then counting starts
 * again from the next named week: the test must stay silent where it does not
 * know, not make things up.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const DAY = 24 * 60 * 60 * 1000

interface Row {
  n: string
  name: string
  when: string
}

/** The plan rows from the course page: number, topic, caption on the right. */
function rowsOf(html: string): Row[] {
  const out: Row[] = []
  const row = /<span class="n">([^<]*)<\/span><span class="t">([^<]*)<\/span><span class="s">([^<]*)<\/span>/g
  for (const found of html.matchAll(row)) {
    out.push({ n: found[1], name: found[2], when: found[3] })
  }
  return out
}

/**
 * A week in the schedule's words, as a pair "first day, last day".
 *
 * There is no year in the schedule and there will not be: that is how it is
 * written ("7–13 Sep"). Nor is a year needed here — all that matters is that
 * the days are consecutive — so it is counted from a nominal one and moved
 * forward as soon as the month goes backwards.
 */
function week(label: string, year: { at: number; month: number }): [number, number] | null {
  const text = label.replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim()
  const full = /^(\d{1,2}) ([а-я]{3})[а-я]* ?- ?(\d{1,2}) ([а-я]{3})[а-я]*$/.exec(text)
  const short = /^(\d{1,2}) ?- ?(\d{1,2}) ([а-я]{3})[а-я]*$/.exec(text)
  const parts = full
    ? [full[1], full[2], full[3], full[4]]
    : short
      ? [short[1], short[3], short[2], short[3]]
      : null
  if (!parts) return null
  const day = (d: string, m: string): number | null => {
    const month = MONTHS.indexOf(m)
    if (month === -1) return null
    if (month < year.month) year.at += 1
    year.month = month
    return Date.UTC(year.at, month, Number(d))
  }
  const from = day(parts[0], parts[1])
  const to = from === null ? null : day(parts[2], parts[3])
  return from === null || to === null ? null : [from, to]
}

/** February ends on the 28th or the 29th — the schedule does not name the year. */
const nextDay = (end: number, start: number): boolean => {
  if (start === end + DAY) return true
  const last = new Date(end)
  const first = new Date(start)
  return (
    last.getUTCMonth() === 1 &&
    last.getUTCDate() >= 28 &&
    first.getUTCMonth() === 2 &&
    first.getUTCDate() === 1
  )
}

const pages = readdirSync(resolve(ROOT, 'site/c'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `site/c/${entry.name}/index.html`)

test('the published course pages have something to read', () => {
  // Otherwise everything below is green simply because there is nothing to
  // check.
  assert.ok(pages.length > 0, 'site/c has no course pages at all')
})

for (const page of pages) {
  const course = page.split('/')[2]
  const html = readFileSync(resolve(ROOT, page), 'utf8')
  const rows = rowsOf(html)

  test(`course "${course}": the plan's weeks are consecutive`, () => {
    assert.ok(rows.length > 0, 'the course page has no rows at all')
    const year = { at: 2025, month: -1 }
    let prev: { row: Row; to: number } | null = null
    for (const row of rows) {
      const span = week(row.when, year)
      if (!span) {
        // A held seminar or a deleted room: there is no week in the caption.
        prev = null
        continue
      }
      if (prev !== null) {
        assert.ok(
          nextDay(prev.to, span[0]),
          `between "${prev.row.n} · ${prev.row.when}" and "${row.n} · ${row.when}" ` +
            'there is a hole in the schedule: the page numbers rows consecutively but skips weeks',
        )
      }
      prev = { row, to: span[1] }
    }
  })

  test(`course "${course}": no draft marks in the topics`, () => {
    for (const row of rows) {
      assert.ok(
        !/\?{2,}|TODO|XXX/i.test(row.name),
        `row ${row.n}: "${row.name}" — a draft mark went out to the class`,
      )
    }
  })
}
