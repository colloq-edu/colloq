/**
 * Курсы и публикации в базе.
 *
 * Держится отдельно от `db.ts` не по вкусу, а потому что `sessions` уже правят
 * два файла — `db.ts` добавляет столбцы окружения и правил, `admin-instance.ts`
 * автора и архивацию. Третий владелец — это то, как схема расползается. Здесь
 * свои таблицы и никто больше в них не пишет.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db.js";
import {
  MAX_COURSE_BLURB,
  MAX_COURSE_NAME,
  MAX_STEP_LABEL,
  type Course,
  type CourseItem,
  type PublicCell,
  type PublicationState,
  type StepHeading,
} from "@shared/publish";

/* ------------------------------------------------------------------- имена */

/**
 * Восемь символов из алфавита, который читают вслух.
 *
 * Тот же приём, что у семинара, и намеренно ДРУГОЙ идентификатор: знание
 * восьми символов комнаты — это всё право писать в неё, так что публичный
 * адрес обязан быть своим. Иначе ссылка, которую дали классу «на почитать»,
 * открывала бы им же живую комнату с правом печатать.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/* ------------------------------------------------------------------ курсы */

interface CourseRow {
  id: string;
  name: string;
  blurb: string | null;
  created_at: number;
  created_by: string | null;
  items: string;
  rev: number;
}

function toCourse(row: CourseRow): Course {
  let items: CourseItem[] = [];
  try {
    const parsed: unknown = JSON.parse(row.items);
    if (Array.isArray(parsed)) items = parsed as CourseItem[];
  } catch {
    // Испорченная строка — курс без семинаров, а не курс, который не читается.
  }
  return {
    id: row.id,
    name: row.name,
    blurb: row.blurb,
    createdAt: row.created_at,
    createdBy: row.created_by,
    items,
    rev: row.rev,
  };
}

const insertCourse = db.prepare(`
  INSERT INTO courses (id, name, blurb, created_at, created_by, items, rev)
  VALUES (?, ?, ?, ?, ?, '[]', 0)
`);
const selectCourse = db.prepare("SELECT * FROM courses WHERE id = ?");
const selectCourses = db.prepare(
  "SELECT * FROM courses ORDER BY created_at DESC",
);
const updateCourseMeta = db.prepare(
  "UPDATE courses SET name = ?, blurb = ? WHERE id = ?",
);
const updateCourseItems = db.prepare(
  "UPDATE courses SET items = ?, rev = rev + 1 WHERE id = ? AND rev = ?",
);
const deleteCourseRow = db.prepare("DELETE FROM courses WHERE id = ?");

export function createCourse(
  name: string,
  blurb: string | null,
  by: string | null,
): Course {
  const id = newId();
  insertCourse.run(
    id,
    clip(name, MAX_COURSE_NAME),
    clip(blurb, MAX_COURSE_BLURB) || null,
    Date.now(),
    by,
  );
  return getCourse(id)!;
}

export function getCourse(id: string): Course | null {
  const row = selectCourse.get(id) as CourseRow | undefined;
  return row ? toCourse(row) : null;
}

export function listCourses(): Course[] {
  return (selectCourses.all() as CourseRow[]).map(toCourse);
}

export function renameCourse(
  id: string,
  name: string,
  blurb: string | null,
): Course | null {
  const current = getCourse(id);
  if (!current) return null;
  updateCourseMeta.run(
    clip(name, MAX_COURSE_NAME) || current.name,
    blurb === null ? null : clip(blurb, MAX_COURSE_BLURB) || null,
    id,
  );
  return getCourse(id);
}

/**
 * Переписать состав и порядок курса, если его не меняли под нами.
 *
 * Сравнение-и-обмен, а не последняя-запись-побеждает: права преподавателя на
 * инстансе общие, экран семинаров перечитывается сам, и двое, переставляющие
 * один курс в одну минуту, иначе молча теряют порядок друг друга. Несовпадение
 * возвращает `null`, и экран показывает список таким, какой он сейчас.
 */
export function setCourseItems(
  id: string,
  rev: number,
  items: CourseItem[],
): Course | null {
  const res = updateCourseItems.run(JSON.stringify(items), id, rev);
  return res.changes === 1 ? getCourse(id) : null;
}

export function deleteCourse(id: string): void {
  deleteCourseRow.run(id);
}

/**
 * Убрать семинар из всех курсов, оставив надгробие.
 *
 * Строка остаётся с именем и датой: курс, из которого молча пропала четвёртая
 * неделя, сломан для того, кто на ней сидел, а нумерация остальных уезжает и
 * перестаёт совпадать с расписанием.
 */
export function entombSeminar(sessionId: string, name: string): void {
  for (const course of listCourses()) {
    let touched = false;
    const items = course.items.map((item) => {
      if (item.kind !== "seminar" || item.sessionId !== sessionId) return item;
      touched = true;
      return { kind: "gone" as const, name, at: Date.now() };
    });
    if (touched) setCourseItems(course.id, course.rev, items);
  }
}

/* ------------------------------------------------------------- публикации */

interface PublicationRow {
  id: string;
  session_id: string | null;
  title: string;
  state: string;
  published_at: number;
  published_by: string | null;
  revision: number;
  orphaned_at: number | null;
}

export interface Publication {
  id: string;
  sessionId: string | null;
  title: string;
  state: PublicationState;
  publishedAt: number;
  publishedBy: string | null;
  revision: number;
  orphanedAt: number | null;
}

function toPublication(row: PublicationRow): Publication {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    state: row.state === "withdrawn" ? "withdrawn" : "published",
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    revision: row.revision,
    orphanedAt: row.orphaned_at,
  };
}

const selectPub = db.prepare("SELECT * FROM publications WHERE id = ?");
const selectPubForSession = db.prepare(
  "SELECT * FROM publications WHERE session_id = ?",
);
const insertPub = db.prepare(`
  INSERT INTO publications (id, session_id, title, state, published_at, published_by, revision)
  VALUES (@id, @session_id, @title, 'published', @published_at, @published_by, 1)
`);
const bumpPub = db.prepare(`
  UPDATE publications
  SET title = ?, state = 'published', published_at = ?, published_by = ?, revision = revision + 1
  WHERE id = ?
`);
const setPubState = db.prepare(
  "UPDATE publications SET state = ? WHERE id = ?",
);
const orphanPub = db.prepare(
  "UPDATE publications SET session_id = NULL, orphaned_at = ? WHERE session_id = ?",
);
const deletePubRow = db.prepare("DELETE FROM publications WHERE id = ?");

const clearSteps = db.prepare("DELETE FROM publication_steps WHERE pub = ?");
const insertStep = db.prepare(`
  INSERT INTO publication_steps (pub, seq, ord, label, at, page)
  VALUES (@pub, @seq, @ord, @label, @at, @page)
`);
const selectHeadings = db.prepare(`
  SELECT seq, label, at, page FROM publication_steps WHERE pub = ? ORDER BY ord
`);
const selectStep = db.prepare(
  "SELECT seq, label, at, page FROM publication_steps WHERE pub = ? AND seq = ?",
);
const selectFirstStep = db.prepare(
  "SELECT seq, label, at, page FROM publication_steps WHERE pub = ? ORDER BY ord LIMIT 1",
);

const clearBlobs = db.prepare("DELETE FROM publication_blobs WHERE pub = ?");
const insertBlob = db.prepare(
  "INSERT OR IGNORE INTO publication_blobs (pub, hash, mime, body) VALUES (?, ?, ?, ?)",
);
const selectBlob = db.prepare(
  "SELECT mime, body FROM publication_blobs WHERE pub = ? AND hash = ?",
);

export function getPublication(id: string): Publication | null {
  const row = selectPub.get(id) as PublicationRow | undefined;
  return row ? toPublication(row) : null;
}

export function publicationOf(sessionId: string): Publication | null {
  const row = selectPubForSession.get(sessionId) as PublicationRow | undefined;
  return row ? toPublication(row) : null;
}

export interface BuiltStep {
  seq: number;
  label: string;
  at: number;
  cells: PublicCell[];
}

/**
 * Записать публикацию целиком: шаги и крупные куски выводов.
 *
 * Одной транзакцией, и старые шаги стираются: публикация — это снимок, а не
 * накопление. Адрес при этом сохраняется — студент, у которого ссылка с
 * прошлой недели, попадает туда же.
 */
export function writePublication(input: {
  sessionId: string;
  title: string;
  by: string | null;
  steps: BuiltStep[];
  blobs: { hash: string; mime: string; body: Buffer }[];
}): Publication {
  const existing = publicationOf(input.sessionId);
  const id = existing?.id ?? newId();
  const now = Date.now();

  db.transaction(() => {
    if (existing) bumpPub.run(input.title, now, input.by, id);
    else
      insertPub.run({
        id,
        session_id: input.sessionId,
        title: input.title,
        published_at: now,
        published_by: input.by,
      });
    clearSteps.run(id);
    clearBlobs.run(id);
    input.steps.forEach((step, index) => {
      insertStep.run({
        pub: id,
        seq: step.seq,
        ord: index,
        label: clip(step.label, MAX_STEP_LABEL),
        at: step.at,
        page: JSON.stringify(step.cells),
      });
    });
    for (const blob of input.blobs)
      insertBlob.run(id, blob.hash, blob.mime, blob.body);
  })();

  return getPublication(id)!;
}

export function setPublicationState(id: string, state: PublicationState): void {
  setPubState.run(state, id);
}

/** Семинар удалили, а чтение решили оставить. */
export function orphanPublication(sessionId: string): void {
  orphanPub.run(Date.now(), sessionId);
}

/** Семинар удалили вместе с чтением. */
export function deletePublication(id: string): void {
  db.transaction(() => {
    clearSteps.run(id);
    clearBlobs.run(id);
    deletePubRow.run(id);
  })();
}

interface StepRow {
  seq: number;
  label: string;
  at: number;
  page: string;
}

function parsePage(row: StepRow): PublicCell[] {
  try {
    const parsed: unknown = JSON.parse(row.page);
    return Array.isArray(parsed) ? (parsed as PublicCell[]) : [];
  } catch {
    return [];
  }
}

export function stepHeadings(pub: string): StepHeading[] {
  return (selectHeadings.all(pub) as StepRow[]).map((row) => ({
    seq: row.seq,
    label: row.label,
    at: row.at,
    cellCount: parsePage(row).length,
  }));
}

export function readStep(pub: string, seq: number | null): BuiltStep | null {
  const row = (
    seq === null ? selectFirstStep.get(pub) : selectStep.get(pub, seq)
  ) as StepRow | undefined;
  if (!row) return null;
  return { seq: row.seq, label: row.label, at: row.at, cells: parsePage(row) };
}

export function readBlob(
  pub: string,
  hash: string,
): { mime: string; body: Buffer } | null {
  const row = selectBlob.get(pub, hash) as
    | { mime: string; body: Buffer }
    | undefined;
  return row ? { mime: row.mime, body: row.body } : null;
}

/** Отпечаток содержимого — для ETag страницы. */
export function pageTag(cells: PublicCell[]): string {
  return createHash("sha256")
    .update(JSON.stringify(cells))
    .digest("hex")
    .slice(0, 16);
}
