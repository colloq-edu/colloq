/**
 * A course from a schedule in Google Sheets.
 *
 * The semester schedule is put together in a spreadsheet, not in Colloq, and
 * nobody is going to carry it over by hand, thirty rows at a time. The script
 * reads the published CSV and creates a course in which every week is a
 * "planned" row: the topic and the week in the schedule's own words. Rooms
 * appear one by one, as the classes happen, and a plan row is replaced by a
 * seminar.
 *
 *   npx tsx scripts/course-from-sheet.mts \
 *     --sheet <id> --gid <gid> --column "ML · сильная" --name "ML · сильная"
 *
 * The column is found by the header in the first row: the spreadsheet has four
 * of them, one per group, and giving a number would mean breaking on an
 * inserted column.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    sheet: { type: "string" },
    gid: { type: "string", default: "0" },
    column: { type: "string" },
    name: { type: "string" },
    blurb: { type: "string" },
    /** Where to write. By default, the database nearby, the same as for `make run`. */
    data: { type: "string" },
    /** Show what would come out, and write nothing. */
    dry: { type: "boolean", default: false },
  },
});

if (!values.sheet || !values.column) {
  console.error('need --sheet <id> and --column "<group header>"');
  process.exit(1);
}
if (values.data) process.env.DATA_DIR = values.data;
process.env.WORKSPACE_DIR ??= "workspace";
process.env.SESSION_SECRET ??= "course-import";

/** CSV parsing, with quotes and line breaks inside fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const url = `https://docs.google.com/spreadsheets/d/${values.sheet}/export?format=csv&gid=${values.gid}`;
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(
    `cannot read the spreadsheet: HTTP ${res.status}. Is it open to anyone with the link?`,
  );
  process.exit(1);
}
const rows = parseCsv(await res.text());
if (rows.length < 3) {
  console.error("the spreadsheet has neither a header nor rows");
  process.exit(1);
}

/*
 * The group column is found by its header. The header stands above the triple
 * "topic · teacher · assistants", so the topic lies exactly in its column.
 */
const header = rows[0];
const topicAt = header.findIndex(
  (cell) => cell.trim() === values.column!.trim(),
);
if (topicAt === -1) {
  console.error(
    `the spreadsheet has no column "${values.column}". There are: ${header.filter(Boolean).join(" · ")}`,
  );
  process.exit(1);
}

/** The first column is the week number, the second its dates; that is how the schedule is laid out. */
const WEEKS = 1;
const planned: { name: string; when: string }[] = [];
for (const row of rows.slice(2)) {
  const topic = (row[topicAt] ?? "").trim();
  const when = (row[WEEKS] ?? "").trim();
  // "—" in this spreadsheet means "the topic for this week is not worded yet":
  // a row about nothing is worse than a missing row.
  if (!topic || topic === "—" || !when) continue;
  /*
   * A date in parentheses is the same week, once more. In the schedule it is
   * there so that nobody has to scroll left; on the course page the week
   * already stands next to it, and the repetition reads as two different
   * dates.
   */
  const name = topic.replace(/\s*\([^()]*\)\s*$/, "").trim();
  // A cell holding only a date in parentheses also means "no topic yet". The
  // script would write a row without a topic past the server, and the panel
  // could then not save this course at all: PUT /items refuses a plan row
  // without a topic.
  if (!name) continue;
  planned.push({ name, when });
}

if (planned.length === 0) {
  console.error("not a single topic was found in this column");
  process.exit(1);
}

console.log(`${values.column}: ${planned.length} weeks`);
for (const [i, item] of planned.entries()) {
  console.log(
    `  ${String(i + 1).padStart(2, "0")}  ${item.when.padEnd(16)}  ${item.name}`,
  );
}

if (values.dry) {
  console.log("\n--dry: nothing written");
  process.exit(0);
}

const { createCourse, setCourseItems } = await import(
  "../server/src/publish/store.js"
);
const course = createCourse(
  values.name ?? values.column,
  values.blurb ?? null,
  null,
);
const saved = setCourseItems(
  course.id,
  course.rev,
  planned.map((item) => ({
    kind: "planned" as const,
    name: item.name,
    when: item.when,
  })),
);
if (!saved) {
  console.error("the course was created, but its items could not be saved");
  process.exit(1);
}
console.log(`\ncourse ready: /c/${course.id}`);
