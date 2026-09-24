/**
 * Put the published seminars on the site.
 *
 * A student needs the page on Wednesday evening, when the teacher's laptop is
 * closed. As long as it is served by the same process that runs the classes,
 * "always available" means "while it is switched on", that is, nothing at all.
 * Hence: static files into the site repository and `git push`; from there on
 * GitHub Pages keeps the page up.
 *
 *   make site                 — build and push
 *   make site DRY=1           — build and show what came out
 *
 * The repository's visibility has nothing to do with it: Pages serves a public
 * site from a private repository and from a public one alike.
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
 * The site lives in this same repository, in `site/`.
 *
 * There used to be a separate one, with the caveat "Pages cannot do private
 * repositories", which is not true: Pages serves a public site from a
 * repository of any visibility. The separate one cost a second clone next to
 * this one, without which publishing simply did not build.
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
    `${site} — no such directory. Name it: make site SITE=site`,
  );
  process.exit(1);
}

/** The repository that holds the site: usually this same one. */
const repo = path.resolve(site, "..");

const git = (...args: string[]): { code: number; out: string } => {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return {
    code: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
  };
};

/** A path inside the repository: git works with that, not with an absolute one. */
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
 * "Nothing to publish" is no reason to exit here: if the last publication was
 * withdrawn, the export has just erased its directory, and that deletion has
 * to be carried to Pages. Exiting here left the withdrawn page open by direct
 * link; `git status` decides further down anyway.
 */
if (
  report.courses.length === 0 &&
  report.seminars.length === 0 &&
  report.withdrawn.length === 0
) {
  console.log("nothing to publish: no courses and no published seminars");
}

for (const course of report.courses) {
  console.log(
    `course    ${base}/c/${course.handle}/  ${course.name} · ${course.rows} rows`,
  );
}
for (const seminar of report.seminars) {
  const blobs = seminar.blobs > 0 ? ` · ${seminar.blobs} images` : "";
  console.log(
    `seminar   ${base}/p/${seminar.handle}/  ${seminar.title} · ${seminar.steps} steps${blobs}`,
  );
}
/*
 * A withdrawn page stays as an address with a tombstone instead of vanishing:
 * a link handed out to the class must say "it was withdrawn", not answer with
 * GitHub's 404.
 */
for (const stone of report.withdrawn) {
  console.log(`withdrawn ${base}/p/${stone.handle}/  ${stone.title}`);
}

const status = git("status", "--porcelain", "--", inRepo("c"), inRepo("p"));
if (status.out.length === 0) {
  console.log("\nthe site is exactly the same — nothing to push");
  process.exit(0);
}
console.log(`\nfiles changed: ${status.out.split("\n").length}`);

if (values.dry) {
  console.log("--dry: built in place, nothing sent");
  process.exit(0);
}

/*
 * Only our own directories go into the index. The site repository holds the
 * landing page, CNAME and the workflow: other files that this command must not
 * touch; `git add -A` would one day have carried someone's uncommitted edit in
 * there.
 */
/*
 * Only the directories git knows about at all go into the index: `git add -- p`
 * fails entirely if no seminar has been published yet, while a course is
 * already on the site and has to get through.
 *
 * "Knows" means in the working tree OR in the index. A directory erased by the
 * export (the last publication was withdrawn) has vanished from the tree but
 * stayed in the index: without the second half of the condition its deletion
 * was not staged and did not make it into the commit, and the withdrawn page
 * kept opening on Pages by direct link.
 */
const dirs = ["c", "p"]
  .filter(
    (dir) =>
      existsSync(path.join(site, dir)) ||
      git("ls-files", "--", inRepo(dir)).out.length > 0,
  )
  .map(inRepo);

/*
 * The branch must be main: Pages listens for pushes to exactly that one
 * (.github/workflows/pages.yml). From a feature branch the script cheerfully
 * printed "published", the push went through, and nothing changed on the
 * site, with no way to find out except by opening colloq.ru.
 */
const branch = git("rev-parse", "--abbrev-ref", "HEAD").out;
if (branch !== "main") {
  console.error(
    `the current branch is ${branch || "unknown"}, and Pages publishes only main:\n` +
      "switch to main (git switch main) and try again, otherwise \"published\" would not be true.",
  );
  process.exit(1);
}

/*
 * The commit is by these same paths (`-- c p`), not by the whole index.
 *
 * `git commit -m …` without paths also takes whatever the author staged
 * before: someone else's uncommitted edit went into the "publications: …"
 * commit and on into main, along with the site and without a word about it.
 */
for (const step of [
  ["add", "--", ...dirs],
  [
    "commit",
    "-m",
    `publications: ${report.courses.length} courses, ${report.seminars.length} seminars`,
    "--",
    ...dirs,
  ],
  ["push"],
]) {
  const res = git(...step);
  if (res.code !== 0) {
    console.error(`git ${step[0]} failed:\n${res.out}`);
    process.exit(1);
  }
}
console.log("published");
