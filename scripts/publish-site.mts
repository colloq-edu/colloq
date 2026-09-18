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
 * Видимость репозитория тут ни при чём: Pages отдаёт публичный сайт и из
 * приватного, и из открытого.
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

/*
 * Сайт лежит в этом же репозитории, в `site/`.
 *
 * Был отдельный, с оговоркой «Pages не умеет приватные репозитории» — неправда:
 * Pages отдаёт публичный сайт из репозитория любой видимости. Отдельный стоил
 * второго клона рядом, без которого выкладка просто не собиралась.
 */
const site = path.resolve(values.site ?? process.env.SITE_DIR ?? "site");
const base = (
  values.base ??
  process.env.SITE_BASE ??
  "https://colloq.ru"
).replace(/\/+$/, "");
if (values.data) process.env.DATA_DIR = values.data;
process.env.WORKSPACE_DIR ??= "workspace";
process.env.SESSION_SECRET ??= "site-export";
process.env.KERNEL_ISOLATION ??= "off";

if (!existsSync(site)) {
  console.error(
    `${site} — такого каталога нет. Укажите его: make site SITE=site`,
  );
  process.exit(1);
}

/** Репозиторий, в котором лежит сайт: обычно этот же. */
const repo = path.resolve(site, "..");

const git = (...args: string[]): { code: number; out: string } => {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return {
    code: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
  };
};

/** Путь внутри репозитория — им оперирует git, а не абсолютным. */
const inRepo = (dir: string): string =>
  path.relative(repo, path.join(site, dir));

// This CLI does not load the web app's settings bootstrap. Select the locale
// only after --data and the environment are resolved, using the same persisted
// setting (and UI_LANGUAGE fallback) as the running instance. Render helpers
// remain independent of the database and can still be used with an explicit locale.
const { getInstanceLanguage } = await import("../server/src/admin/settings.js");
const { setLocaleResolver } = await import("../shared/i18n.js");
setLocaleResolver(getInstanceLanguage);

const { exportSite } = await import("../server/src/publish/export.js");
const report = exportSite(site, base);

/*
 * «Публиковать нечего» — не повод выйти отсюда: если сняли последнюю
 * публикацию, выгрузка только что стёрла её каталог, и это удаление надо
 * довезти до Pages. Выход здесь оставлял снятую страницу открытой по прямой
 * ссылке; дальше всё равно решает `git status`.
 */
if (
  report.courses.length === 0 &&
  report.seminars.length === 0 &&
  report.withdrawn.length === 0
) {
  console.log("публиковать нечего: ни курсов, ни опубликованных семинаров");
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
/*
 * Снятая страница остаётся адресом с надгробием, а не исчезает: ссылка,
 * розданная классу, обязана сказать «её сняли», а не ответить 404 GitHub.
 */
for (const stone of report.withdrawn) {
  console.log(`снята   ${base}/p/${stone.handle}/  ${stone.title}`);
}

const status = git("status", "--porcelain", "--", inRepo("c"), inRepo("p"));
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
 * В индекс идут только те каталоги, о которых git вообще знает: `git add -- p`
 * падает целиком, если ни одного семинара ещё не публиковали, — а курс на сайте
 * уже лежит и должен доехать.
 *
 * «Знает» — это в рабочем дереве ИЛИ в индексе. Каталог, стёртый выгрузкой
 * (сняли последнюю публикацию), из дерева пропал, но в индексе остался: без
 * второй половины условия его удаление не стейджилось, в коммит не попадало — и
 * снятая страница продолжала открываться на Pages по прямой ссылке.
 */
const dirs = ["c", "p"]
  .filter(
    (dir) =>
      existsSync(path.join(site, dir)) ||
      git("ls-files", "--", inRepo(dir)).out.length > 0,
  )
  .map(inRepo);

/*
 * Ветка — только main: Pages слушает push именно в неё (.github/workflows/pages.yml).
 * С фиче-ветки скрипт бодро печатал «выложено», push проходил, а на сайте не
 * менялось ничего — и узнать об этом было неоткуда, кроме как открыть colloq.ru.
 */
const branch = git("rev-parse", "--abbrev-ref", "HEAD").out;
if (branch !== "main") {
  console.error(
    `сейчас ветка ${branch || "неизвестна"}, а Pages выкладывает только main:\n` +
      "перейдите на main (git switch main) и повторите — иначе «выложено» будет неправдой.",
  );
  process.exit(1);
}

/*
 * Коммит по этим же путям (`-- c p`), а не всем индексом.
 *
 * `git commit -m …` без путей забирает и то, что автор застейджил до этого:
 * чужая незакоммиченная правка уезжала в коммит «публикации: …» и дальше в
 * main — вместе с сайтом и без всякого об этом слова.
 */
for (const step of [
  ["add", "--", ...dirs],
  [
    "commit",
    "-m",
    `публикации: ${report.courses.length} курсов, ${report.seminars.length} семинаров`,
    "--",
    ...dirs,
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
