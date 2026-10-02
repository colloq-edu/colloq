/**
 * A course from a schedule in Google Sheets.
 *
 * The semester schedule is put together in a spreadsheet, not in Colloq, and
 * nobody is going to carry it over by hand, thirty rows at a time. The script
 * reads the published CSV and creates a course in which every week is a
 * "planned" row: the topic, the group's own class day and the week in the
 * schedule's own words. Rooms appear one by one, as the classes happen, and
 * a room seated into a plan row keeps its topic and day.
 *
 *   npx tsx scripts/course-from-sheet.mts \
 *     --sheet <id> --gid <gid> --column "ML · сильная" --name "ML · сильная"
 *
 * The column is found by the header in the first row: the spreadsheet has four
 * of them, one per group, and giving a number would mean breaking on an
 * inserted column. How the group's «дата» and «тема» are found under it is in
 * scripts/course-sheet.mts.
 *
 * A «06.09» in the date column has no year: it gets the academic year the
 * script runs in (September to August), or `--year 2026` for the 2026/27
 * schedule when importing it ahead of time or after the fact.
 */
import { parseArgs } from 'node:util'
import { academicYearOf, parseCsv, planFromSheet } from './course-sheet.mts'

const { values } = parseArgs({
  options: {
    sheet: { type: 'string' },
    gid: { type: 'string', default: '0' },
    column: { type: 'string' },
    name: { type: 'string' },
    blurb: { type: 'string' },
    /** The autumn year of the academic year the dates belong to. */
    year: { type: 'string' },
    /** Where to write. By default, the database nearby, the same as for `make run`. */
    data: { type: 'string' },
    /** Show what would come out, and write nothing. */
    dry: { type: 'boolean', default: false },
  },
})

if (!values.sheet || !values.column) {
  console.error('need --sheet <id> and --column "<group header>"')
  process.exit(1)
}
if (values.year !== undefined && !/^\d{4}$/.test(values.year)) {
  console.error(`--year is the autumn year of the academic year, like 2026; got "${values.year}"`)
  process.exit(1)
}
if (values.data) process.env.DATA_DIR = values.data
process.env.WORKSPACE_DIR ??= 'workspace'
process.env.SESSION_SECRET ??= 'course-import'

const url = `https://docs.google.com/spreadsheets/d/${values.sheet}/export?format=csv&gid=${values.gid}`
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok) {
  console.error(`cannot read the spreadsheet: HTTP ${res.status}. Is it open to anyone with the link?`)
  process.exit(1)
}

const today = new Date().toISOString().slice(0, 10)
const startYear = values.year ? Number(values.year) : academicYearOf(today)
const plan = planFromSheet(parseCsv(await res.text()), values.column, startYear)
if (!plan.ok) {
  console.error(plan.error)
  process.exit(1)
}

const dated = plan.rows.filter((row) => row.day !== null).length
console.log(
  `${values.column}: ${plan.rows.length} weeks, ${dated} with a class day ` +
    `(academic year ${startYear}/${String(startYear + 1).slice(2)})`,
)
if (!plan.dated) {
  // Said out loud: without days the course page cannot say which class is next.
  console.log('  no «дата» column under this group: rows keep their week text only')
}
for (const [i, row] of plan.rows.entries()) {
  console.log(
    `  ${String(i + 1).padStart(2, '0')}  ${(row.day ?? '—').padEnd(10)}  ${row.when.padEnd(16)}  ${row.name}`,
  )
}

if (values.dry) {
  console.log('\n--dry: nothing written')
  process.exit(0)
}

const { createCourse, newRowId, setCourseItems } = await import('../server/src/publish/store.js')
const course = createCourse(values.name ?? values.column, values.blurb ?? null, null)
const ids: string[] = []
const saved = setCourseItems(
  course.id,
  course.rev,
  plan.rows.map((row) => {
    const id = newRowId(ids)
    ids.push(id)
    /*
     * The topic goes in twice on purpose: `name` is the plan row's own, and
     * `title` is what students see, which a room seated into the row keeps
     * instead of its own working name.
     */
    return {
      kind: 'planned' as const,
      id,
      name: row.name,
      title: row.name,
      when: row.when,
      day: row.day,
    }
  }),
)
if (!saved) {
  console.error('the course was created, but its items could not be saved')
  process.exit(1)
}
console.log(`\ncourse ready: /c/${course.id}`)
