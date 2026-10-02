/**
 * Reading a semester schedule out of its spreadsheet: the pure half of
 * `make course` (scripts/course-from-sheet.mts), kept apart so it can be
 * tested without a network or a database.
 *
 * The layout is the timetable's own. The first row names the groups, one
 * header per group; the second row labels each group's columns («дата»,
 * «тема», «преподаватель», «ассистенты»); the first column numbers the weeks
 * and the second gives their dates. Groups meet on different days, so each
 * keeps its own «дата» column: that is the day a class page is placed by.
 */
import { parseWhen } from '../shared/class-day.js'

/** CSV parsing, with quotes and line breaks inside fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * The autumn year of the academic year a day falls in: from August on it is
 * that year, before August the previous one. A schedule written in October
 * 2026 is the 2026/27 year, and its «10.01» is January 2027.
 */
export function academicYearOf(day: string): number {
  const year = Number(day.slice(0, 4))
  return Number(day.slice(5, 7)) >= 8 ? year : year - 1
}

/**
 * The calendar day a schedule cell names, inside the academic year that
 * starts in the autumn of `startYear`, or `null`.
 *
 * The cell says «06.09» with no year. `parseWhen` picks the year nearest to
 * an anchor, so it is asked twice, from the middle of the autumn and from the
 * middle of the spring, and the answer that lands in August–July of this
 * academic year wins: «20.06» is June of the second year, never the June
 * before the course began. A year written in the cell is taken as written.
 */
export function classDayIn(text: string, startYear: number): string | null {
  const autumn = parseWhen(text, `${startYear}-11-01`)
  const spring = parseWhen(text, `${startYear + 1}-04-01`)
  // Only a year written in the cell survives an anchor twenty years away.
  if (autumn !== null && parseWhen(text, `${startYear + 20}-01-01`) === autumn) return autumn
  const first = `${startYear}-08-01`
  const last = `${startYear + 1}-07-31`
  for (const day of [autumn, spring]) if (day && day >= first && day <= last) return day
  return null
}

export interface SheetRow {
  /** The topic, as the timetable words it. */
  name: string
  /** The week in the timetable's words, from its second column; may be empty. */
  when: string
  /** The group's own class day, 'YYYY-MM-DD', when its «дата» cell parses. */
  day: string | null
}

export type SheetPlan =
  | { ok: true; rows: SheetRow[]; dated: boolean }
  | { ok: false; error: string }

const DATE_LABELS = new Set(['дата', 'date'])
const TOPIC_LABELS = new Set(['тема', 'topic'])
/** The second column of the timetable: the week's dates. */
const WEEKS = 1

/**
 * The group's rows: topic, week and day.
 *
 * The group's columns run from its header to the next group's header (the
 * header is a merged cell, and a CSV export writes it into the first column
 * of the merge). Inside that span the second row says which column is the
 * date and which the topic. A sheet without the labels is read the way it
 * always was: the topic right under the header, and no day.
 */
export function planFromSheet(rows: string[][], column: string, startYear: number): SheetPlan {
  if (rows.length < 3) return { ok: false, error: 'the spreadsheet has neither a header nor rows' }
  const header = rows[0]
  const at = header.findIndex((cell) => cell.trim() === column.trim())
  if (at === -1) {
    const there = header.filter((cell) => cell.trim()).join(' · ')
    return { ok: false, error: `the spreadsheet has no column "${column}". There are: ${there}` }
  }
  let end = header.findIndex((cell, i) => i > at && cell.trim() !== '')
  if (end === -1) end = Math.max(header.length, rows[1].length)
  const label = (i: number) => (rows[1][i] ?? '').trim().toLowerCase()
  const span = Array.from({ length: end - at }, (_, i) => at + i)

  let dateAt = span.find((i) => DATE_LABELS.has(label(i))) ?? -1
  // A date column left of an unmerged header still belongs to this group.
  if (dateAt === -1 && at > 0 && !header[at - 1].trim() && DATE_LABELS.has(label(at - 1))) {
    dateAt = at - 1
  }
  const topicAt =
    span.find((i) => TOPIC_LABELS.has(label(i))) ??
    span.find((i) => i !== dateAt) ??
    at

  const planned: SheetRow[] = []
  for (const row of rows.slice(2)) {
    const topic = (row[topicAt] ?? '').trim()
    // "—" in this spreadsheet means "the topic for this week is not worded
    // yet": a row about nothing is worse than a missing row.
    if (!topic || topic === '—') continue
    /*
     * A date in parentheses is the same week, once more. In the schedule it is
     * there so that nobody has to scroll left; on the course page the day
     * already stands next to it, and the repetition reads as two dates.
     */
    const name = topic.replace(/\s*\([^()]*\)\s*$/, '').trim()
    // A cell holding only a date in parentheses also means "no topic yet": the
    // panel could not save a plan row without a topic.
    if (!name) continue
    const when = (row[WEEKS] ?? '').trim()
    const day = dateAt === -1 ? null : classDayIn(row[dateAt] ?? '', startYear)
    if (!when && !day) continue
    planned.push({ name, when, day })
  }
  if (planned.length === 0) return { ok: false, error: 'not a single topic was found in this column' }
  return { ok: true, rows: planned, dated: dateAt !== -1 }
}
