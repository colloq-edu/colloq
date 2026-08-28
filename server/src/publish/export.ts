/**
 * Выгрузка публикаций в статический сайт.
 *
 * Каталог на курс и каталог на шаг, в каждом обычный `index.html`. Ни API, ни
 * маршрутизации, ни скриптов: страница, которую студент открывает в среду
 * вечером, не должна зависеть от того, включён ли ноутбук преподавателя.
 *
 * Пишется только в свои подкаталоги — `c/` и `p/`. Всё остальное в целевом
 * репозитории (лендинг, CNAME, workflow) не трогается: это чужие файлы, и
 * выгрузка, которая их подчищает, однажды подчистит нужное.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BLOB_PREFIX, type PublicCourseView } from "@shared/publish";
import { blobHref, renderCourse, renderStep } from "./render.js";
import {
  getPublication,
  listCourses,
  publicationOf,
  readBlob,
  readStep,
  stepHeadings,
} from "./store.js";
import { db, getSession } from "../db.js";
import { notebookOf } from "./notebook.js";

export interface ExportReport {
  courses: { handle: string; name: string; rows: number }[];
  seminars: { handle: string; title: string; steps: number; blobs: number }[];
  root: string;
}

/** Адрес, по которому это будет лежать: имя, если его дали, иначе id. */
const handleOf = (thing: { id: string; slug: string | null }): string =>
  thing.slug ?? thing.id;

function write(file: string, body: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/**
 * Выгрузить всё опубликованное.
 *
 * `base` — адрес сайта, он нужен для ссылок между курсом и семинаром: на Pages
 * они лежат в одном домене, но на разной глубине, и относительные пути между
 * ними читаются хуже, чем один явный корень.
 */
export function exportSite(root: string, base: string): ExportReport {
  const report: ExportReport = { courses: [], seminars: [], root };

  /*
   * Свои подкаталоги стираются целиком перед записью: снятая публикация должна
   * исчезнуть со страницы, а не остаться лежать файлом, на который никто не
   * ссылается, но который открывается по прямой ссылке.
   */
  for (const dir of ["c", "p"]) {
    rmSync(path.join(root, dir), { recursive: true, force: true });
  }

  const courses = listCourses();
  for (const course of courses) {
    const items = course.items.map((item) => {
      if (item.kind !== "seminar") return item;
      const session = getSession(item.sessionId);
      const pub = publicationOf(item.sessionId);
      return {
        kind: "seminar" as const,
        sessionId: "",
        name: session?.name ?? item.name,
        publication:
          pub && pub.state === "published"
            ? {
                id: pub.id,
                slug: pub.slug,
                publishedAt: pub.publishedAt,
                steps: stepHeadings(pub.id).length,
              }
            : null,
      };
    });
    const view: PublicCourseView = {
      id: course.id,
      slug: course.slug,
      name: course.name,
      blurb: course.blurb,
      items,
    };
    const handle = handleOf(course);
    write(path.join(root, "c", handle, "index.html"), renderCourse(view, base));
    report.courses.push({ handle, name: course.name, rows: items.length });
  }

  /** Курс, в котором состоит семинар, — для пути наверх со страницы шага. */
  const courseOf = (
    sessionId: string | null,
  ): { name: string; handle: string } | null => {
    if (!sessionId) return null;
    const found = courses.find((c) =>
      c.items.some((i) => i.kind === "seminar" && i.sessionId === sessionId),
    );
    return found ? { name: found.name, handle: handleOf(found) } : null;
  };

  const published = new Set<string>();
  for (const course of courses) {
    for (const item of course.items) {
      if (item.kind !== "seminar") continue;
      const pub = publicationOf(item.sessionId);
      if (pub && pub.state === "published") published.add(pub.id);
    }
  }
  /*
   * Семинары вне курсов выгружаются тоже: публикация — самостоятельный
   * предмет, и ссылку на неё могли дать до того, как завели курс.
   */
  const loose = db
    .prepare("SELECT id FROM publications WHERE state = 'published'")
    .all() as { id: string }[];
  for (const row of loose) published.add(row.id);

  for (const id of published) {
    const pub = getPublication(id);
    if (!pub || pub.state !== "published") continue;
    const handle = handleOf(pub);
    const dir = path.join(root, "p", handle);
    const headings = stepHeadings(pub.id);
    if (headings.length === 0) continue;

    headings.forEach((heading, index) => {
      const step = readStep(pub.id, heading.seq);
      if (!step) return;
      const html = renderStep({
        title: pub.title,
        publishedAt: pub.publishedAt,
        course: courseOf(pub.sessionId),
        steps: headings,
        step,
        // Первый шаг — корень публикации, остальные лежат на шаг глубже.
        depth: index === 0 ? 1 : 2,
        base,
      });
      write(
        index === 0
          ? path.join(dir, "index.html")
          : path.join(dir, String(heading.seq), "index.html"),
        html,
      );
    });

    // Картинки — один раз на публикацию, по хэшу: он же и есть их версия.
    let blobs = 0;
    for (const heading of headings) {
      const step = readStep(pub.id, heading.seq);
      for (const cell of step?.cells ?? []) {
        for (const output of cell.outputs) {
          if (output.kind !== "data") continue;
          for (const [mime, value] of Object.entries(output.data)) {
            if (!value.startsWith(BLOB_PREFIX)) continue;
            const blob = readBlob(pub.id, value.slice(BLOB_PREFIX.length));
            if (!blob) continue;
            write(path.join(dir, blobHref(value, mime)), blob.body);
            blobs += 1;
          }
        }
      }
    }

    write(path.join(dir, "notebook.ipynb"), notebookOf(pub.id));
    report.seminars.push({
      handle,
      title: pub.title,
      steps: headings.length,
      blobs,
    });
  }

  return report;
}
