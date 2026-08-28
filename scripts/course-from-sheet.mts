/**
 * Курс из расписания в Google Sheets.
 *
 * Расписание семестра составляют в таблице, а не в Colloq, и переносить его
 * руками по тридцать строк никто не станет. Скрипт читает опубликованный CSV и
 * заводит курс, у которого каждая неделя — строка «по плану»: тема и неделя
 * словами расписания. Комнаты появляются по одной, по мере занятий, и строка
 * плана заменяется семинаром.
 *
 *   npx tsx scripts/course-from-sheet.mts \
 *     --sheet <id> --gid <gid> --column "ML · сильная" --name "ML · сильная"
 *
 * Колонка ищется по заголовку первой строки: в таблице их четыре, по группе на
 * каждую, и указывать номер значило бы ломаться от вставленного столбца.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    sheet: { type: "string" },
    gid: { type: "string", default: "0" },
    column: { type: "string" },
    name: { type: "string" },
    blurb: { type: "string" },
    /** Куда писать. По умолчанию — база рядом, та же, что у `make run`. */
    data: { type: "string" },
    /** Показать, что получится, и ничего не записать. */
    dry: { type: "boolean", default: false },
  },
});

if (!values.sheet || !values.column) {
  console.error('нужны --sheet <id> и --column "<заголовок группы>"');
  process.exit(1);
}
if (values.data) process.env.DATA_DIR = values.data;
process.env.WORKSPACE_DIR ??= "workspace";
process.env.SESSION_SECRET ??= "course-import";

/** Разбор CSV с кавычками и переводами строк внутри полей. */
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
    `таблица не читается: HTTP ${res.status}. Она открыта по ссылке?`,
  );
  process.exit(1);
}
const rows = parseCsv(await res.text());
if (rows.length < 3) {
  console.error("в таблице нет ни заголовка, ни строк");
  process.exit(1);
}

/*
 * Колонка группы — по заголовку. Он стоит над тройкой «тема · преподаватель ·
 * ассистенты», так что тема лежит ровно в нём.
 */
const header = rows[0];
const topicAt = header.findIndex(
  (cell) => cell.trim() === values.column!.trim(),
);
if (topicAt === -1) {
  console.error(
    `колонки «${values.column}» в таблице нет. Есть: ${header.filter(Boolean).join(" · ")}`,
  );
  process.exit(1);
}

/** Первый столбец — номер недели, второй — её даты; так составлено расписание. */
const WEEKS = 1;
const planned: { name: string; when: string }[] = [];
for (const row of rows.slice(2)) {
  const topic = (row[topicAt] ?? "").trim();
  const when = (row[WEEKS] ?? "").trim();
  // «—» в этой таблице значит «тема на эту неделю пока не сформулирована»:
  // строка про пустоту хуже отсутствующей строки.
  if (!topic || topic === "—" || !when) continue;
  /*
   * Дата в скобках — это та же неделя, ещё раз. В расписании она нужна, чтобы
   * не листать влево; на странице курса рядом уже стоит неделя, и повтор
   * читается как две разные даты.
   */
  planned.push({ name: topic.replace(/\s*\([^()]*\)\s*$/, "").trim(), when });
}

if (planned.length === 0) {
  console.error("в этой колонке не нашлось ни одной темы");
  process.exit(1);
}

console.log(`${values.column}: ${planned.length} недель`);
for (const [i, item] of planned.entries()) {
  console.log(
    `  ${String(i + 1).padStart(2, "0")}  ${item.when.padEnd(16)}  ${item.name}`,
  );
}

if (values.dry) {
  console.log("\n--dry: ничего не записано");
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
  console.error("курс создан, но состав записать не удалось");
  process.exit(1);
}
console.log(`\nкурс готов: /c/${course.id}`);
