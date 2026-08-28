/**
 * Выложить опубликованные семинары на сайт.
 *
 * Страница нужна студенту в среду вечером, когда ноутбук преподавателя закрыт.
 * Пока её отдаёт тот же процесс, что ведёт занятия, «всегда доступно» значит
 * «пока он включён», то есть не значит ничего. Поэтому: статика в репозиторий
 * сайта и `git push` — дальше страницу держит GitHub Pages.
 *
 *   make site                 — собрать и запушить
 *   make site DRY=1           — собрать и показать, что получилось
 *
 * Репозиторий может быть приватным: Pages отдаёт из него публичный сайт, а
 * исходник остаётся закрытым.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    site: { type: "string" },
    base: { type: "string" },
    data: { type: "string" },
    dry: { type: "boolean", default: false },
  },
});

const site = path.resolve(
  values.site ?? process.env.SITE_DIR ?? "../colloq-site",
);
const base = (
  values.base ??
  process.env.SITE_BASE ??
  "https://colloq.ru"
).replace(/\/+$/, "");
if (values.data) process.env.DATA_DIR = values.data;
process.env.WORKSPACE_DIR ??= "workspace";
process.env.SESSION_SECRET ??= "site-export";
process.env.KERNEL_ISOLATION ??= "off";

if (!existsSync(path.join(site, ".git"))) {
  console.error(
    `${site} — не репозиторий. Укажите его: make site SITE=../colloq-site`,
  );
  process.exit(1);
}

const git = (...args: string[]): { code: number; out: string } => {
  const res = spawnSync("git", ["-C", site, ...args], { encoding: "utf8" });
  return {
    code: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
  };
};

const { exportSite } = await import("../server/src/publish/export.js");
const report = exportSite(site, base);

if (report.courses.length === 0 && report.seminars.length === 0) {
  console.log("публиковать нечего: ни курсов, ни опубликованных семинаров");
  process.exit(0);
}

for (const course of report.courses) {
  console.log(
    `курс    ${base}/c/${course.handle}/  ${course.name} · ${course.rows} строк`,
  );
}
for (const seminar of report.seminars) {
  const blobs = seminar.blobs > 0 ? ` · ${seminar.blobs} картинок` : "";
  console.log(
    `семинар ${base}/p/${seminar.handle}/  ${seminar.title} · ${seminar.steps} шагов${blobs}`,
  );
}

const status = git("status", "--porcelain", "--", "c", "p");
if (status.out.length === 0) {
  console.log("\nна сайте всё то же самое — пушить нечего");
  process.exit(0);
}
console.log(`\nизменилось файлов: ${status.out.split("\n").length}`);

if (values.dry) {
  console.log("--dry: собрано на месте, ничего не отправлено");
  process.exit(0);
}

/*
 * В индекс идут только свои каталоги. В репозитории сайта лежит лендинг, CNAME
 * и workflow — чужие файлы, которые эта команда трогать не должна: `git add -A`
 * однажды унёс бы туда чью-то незакоммиченную правку.
 */
/*
 * В индекс идут только те каталоги, которые есть: `git add -- p` падает
 * целиком, если ни одного семинара ещё не публиковали, — а курс на сайте уже
 * лежит и должен доехать.
 */
const dirs = ["c", "p"].filter((dir) => existsSync(path.join(site, dir)));

for (const step of [
  ["add", "--", ...dirs],
  [
    "commit",
    "-m",
    `публикации: ${report.courses.length} курсов, ${report.seminars.length} семинаров`,
  ],
  ["push"],
]) {
  const res = git(...step);
  if (res.code !== 0) {
    console.error(`git ${step[0]} не прошёл:\n${res.out}`);
    process.exit(1);
  }
}
console.log("выложено");
