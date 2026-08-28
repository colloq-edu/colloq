/**
 * Опубликованный семинар как набор обычных файлов.
 *
 * Страница, ради которой всё это делалось, должна работать в среду вечером,
 * когда ноутбук преподавателя закрыт. Пока её отдаёт тот же процесс, который
 * ведёт занятия, «всегда доступно» означает «пока он включён» — то есть не
 * означает ничего.
 *
 * Поэтому публикация выгружается в статику: каталог на курс, каталог на шаг,
 * в каждом обычный `index.html` со всем содержимым внутри. Ни запросов к API,
 * ни маршрутизации на стороне клиента, ни JavaScript вообще — такой файл
 * откроется и через десять лет, и из архива, и с флешки.
 *
 * Цена честная и её надо назвать: это ВТОРОЙ отрисовщик тетради, рядом со
 * Svelte-компонентами комнаты. Разойтись они могут, и однажды разойдутся.
 * Держать один было бы можно только серверным рендерингом Svelte, а это
 * сборочная машинерия ради страницы, которая после выгрузки не меняется
 * никогда. Для замороженного предмета отдельный простой отрисовщик — верный
 * размен; за ним следит `tests/render.test.mts`.
 */
import {
  BLOB_PREFIX,
  type PublicCell,
  type PublicCourseView,
} from "@shared/publish";
import type { CellOutput } from "@shared/notebook";

/** Экранирование текста, попадающего в HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Разметка ячейки-заметки.
 *
 * Нарочно крошечное подмножество markdown: заголовки, курсив, жирный, код,
 * ссылки, абзацы. Тащить сюда полноценный markdown с санитайзером — это тот
 * же вес, что и в приложении, ради страницы без единого скрипта. Всё, что
 * подмножество не знает, остаётся текстом: непонятый синтаксис виден, но
 * безвреден.
 */
function markdown(source: string): string {
  const inline = (text: string): string =>
    esc(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" rel="noreferrer">$1</a>',
      );

  const out: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const line of source.split("\n")) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1, 5);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet) {
      list.push(bullet[1]);
    } else if (line.trim() === "") {
      flush();
    } else {
      flush();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flush();
  return out.join("\n");
}

/** Адрес крупного куска вывода внутри выгруженного каталога. */
function blobHref(value: string, mime: string): string {
  const hash = value.slice(BLOB_PREFIX.length);
  const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `blob/${hash}.${ext}`;
}

function outputHtml(output: CellOutput, depth: number): string {
  /*
   * Картинки лежат в корне публикации, рядом с первым шагом. Первый шаг — сам
   * этот корень (глубина 1), остальные на уровень глубже, так что подниматься
   * надо на `depth - 1`, а не на `depth`: лишний `../` уводил бы к соседней
   * публикации, и картинка не находилась бы именно на той странице, которую
   * открывают первой.
   */
  const up = "../".repeat(depth - 1);
  if (output.kind === "stream") {
    return `<pre class="out ${output.name === "stderr" ? "err" : ""}">${esc(output.text)}</pre>`;
  }
  if (output.kind === "error") {
    return `<pre class="out err">${esc([output.ename + ": " + output.evalue, "", ...output.traceback].join("\n"))}</pre>`;
  }
  const image = Object.entries(output.data).find(([mime]) =>
    mime.startsWith("image/"),
  );
  if (image) {
    const [mime, value] = image;
    const src = value.startsWith(BLOB_PREFIX)
      ? up + blobHref(value, mime)
      : `data:${mime};base64,${value.replace(/\s/g, "")}`;
    return `<p class="img"><img src="${esc(src)}" alt="вывод ячейки"></p>`;
  }
  const text = output.data["text/plain"];
  return text ? `<pre class="out">${esc(text)}</pre>` : "";
}

function cellHtml(cell: PublicCell, depth: number): string {
  if (cell.type === "markdown")
    return `<div class="note">${markdown(cell.source)}</div>`;
  const outputs = cell.outputs.map((o) => outputHtml(o, depth)).join("\n");
  /*
   * `Out [—]` — вывод есть, а выполнения за ним уже нет: перезапускали ядро
   * или возвращали версию. Промолчать честнее, чем подставить номер.
   */
  const stamp =
    cell.execCount === null
      ? cell.outputs.length > 0
        ? '<span class="warn">Out [—]</span>'
        : '<span class="quiet">не запускалась</span>'
      : `Out [${cell.execCount}]${cell.ranMs !== null ? ` · ${(cell.ranMs / 1000).toFixed(1)}s` : ""}`;
  return [
    '<div class="cell">',
    `<pre class="code">${esc(cell.source)}</pre>`,
    outputs ? `<div class="outs">${outputs}</div>` : "",
    `<div class="foot">${stamp}</div>`,
    "</div>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Оформление.
 *
 * Одним куском внутри файла: страница обязана открываться сама по себе, а
 * отдельный .css — это второй запрос, который однажды не доедет, и текст
 * поедет. Цвета и шрифты — те же, что в комнате.
 */
const STYLE = `
:root{--ink:#101A33;--muted:#5D6B8A;--faint:#9BA6BE;--line:#DCE3EF;--surface:#F3F6FB;--accent:#0B7FAB;--warn:#8E6B00;--err:#8E2334;--bg:#fff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
.wrap{max-width:820px;margin:0 auto;padding:56px 20px 80px}
h1{font-size:38px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px}
.blurb{font-size:16px;color:var(--muted);margin:0 0 14px;max-width:36em}
.addr{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin:0 0 40px}
.rows{border-top:1px solid var(--line);margin:0;padding:0;list-style:none}
.row{display:flex;align-items:baseline;gap:20px;border-bottom:1px solid var(--line);padding:18px 0}
.row .n{width:34px;flex:0 0 auto;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint)}
.row .t{flex:1 1 auto;font-size:17px;font-weight:600;min-width:0}
.row .s{flex:0 0 auto;color:var(--muted);font-size:14px;white-space:nowrap}
.row.off .t{font-weight:400;color:var(--muted)}
.row a{text-decoration:none;color:inherit;display:flex;align-items:baseline;gap:20px;width:100%}
.row a:hover .t{color:var(--accent)}
.foot-note{color:var(--muted);font-size:14px;margin-top:34px}
header.top{border-bottom:1px solid var(--line);padding:36px 20px 22px}
header.top .in{max-width:1180px;margin:0 auto}
header.top h1{font-size:32px;margin:0 0 8px}
.meta{color:var(--muted);font-size:14px;margin:0}
.body{max-width:1180px;margin:0 auto;padding:0 20px;display:flex;gap:36px;align-items:flex-start}
.rail{width:250px;flex:0 0 auto;padding:26px 0;border-right:1px solid var(--line);position:sticky;top:0}
.rail h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.rail a{display:block;text-decoration:none;color:var(--muted);border-left:3px solid transparent;padding:7px 12px 7px 11px;margin-right:18px}
.rail a.on{border-left-color:var(--accent);background:var(--surface);color:var(--ink);font-weight:600}
.rail .w{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);display:block;margin-top:2px;font-weight:400}
.main{flex:1 1 auto;min-width:0;padding:26px 0 70px;max-width:820px}
.intro{background:var(--surface);border-left:3px solid var(--accent);padding:13px 16px;margin:0 0 30px}
.intro p{margin:0 0 5px;color:var(--muted);font-size:14px}
.intro p:last-child{margin:0}
.note{margin:0 0 22px}
.note h2{font-size:22px;margin:0 0 8px}.note h3{font-size:18px;margin:0 0 6px}
.note p{margin:0 0 8px}
.cell{border:1px solid var(--line);margin:0 0 22px}
.code{margin:0;padding:13px 15px;background:#FBFCFE;overflow-x:auto;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.outs{border-top:1px solid var(--line);padding:11px 15px}
.out{margin:0;overflow-x:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.out.err{color:var(--err)}
.img{margin:0}.img img{max-width:100%;height:auto;display:block}
.foot{border-top:1px solid var(--line);background:#FBFCFE;padding:6px 15px;text-align:right;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.foot .warn{color:var(--warn)}.foot .quiet{color:var(--faint)}
.take{border-top:1px solid var(--line);margin-top:34px;padding-top:18px;font-size:14px}
@media(max-width:860px){.body{display:block}.rail{width:auto;border-right:0;border-bottom:1px solid var(--line);position:static;padding:20px 0}.rail a{margin-right:0}}
@media(prefers-color-scheme:dark){:root{--ink:#E8EDF7;--muted:#9AA7C0;--faint:#6B7897;--line:#26304A;--surface:#161E33;--accent:#4FC3F0;--warn:#E0B44A;--err:#F0868E;--bg:#0D1526}.code,.foot{background:#111A2E}}
`;

/** Голова документа. `noindex` — страницу дают классу, а не поисковику. */
function head(title: string, depth: number): string {
  return [
    '<!doctype html><html lang="ru"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
  ].join("");
}

const FOOT = "</body></html>";

export interface RenderedStep {
  seq: number;
  label: string;
  at: number;
  cells: PublicCell[];
}

const when = (at: number): string =>
  new Date(at).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
const clock = (at: number): string =>
  new Date(at).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });

/** Страница курса. */
export function renderCourse(course: PublicCourseView, base: string): string {
  const rows = course.items
    .map((item, index) => {
      const n = String(index + 1).padStart(2, "0");
      if (item.kind === "gone") {
        return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">семинар удалён</span></li>`;
      }
      if (item.kind === "planned") {
        return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">${esc(item.when)}</span></li>`;
      }
      if (!item.publication) {
        return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">ещё не опубликован</span></li>`;
      }
      const href = `${base}/p/${item.publication.slug ?? item.publication.id}/`;
      const steps =
        item.publication.steps === 1
          ? "одна страница"
          : `${item.publication.steps} ${item.publication.steps < 5 ? "шага" : "шагов"}`;
      return [
        '<li class="row">',
        `<a href="${esc(href)}">`,
        `<span class="n">${n}</span>`,
        `<span class="t">${esc(item.name)}</span>`,
        `<span class="s">${esc(when(item.publication.publishedAt))} · ${steps}</span>`,
        "</a></li>",
      ].join("");
    })
    .join("\n");

  return [
    head(course.name, 1),
    '<div class="wrap">',
    `<h1>${esc(course.name)}</h1>`,
    course.blurb ? `<p class="blurb">${esc(course.blurb)}</p>` : "",
    `<p class="addr">${esc(base.replace(/^https?:\/\//, ""))}/c/${esc(course.slug ?? course.id)}</p>`,
    `<ul class="rows">${rows}</ul>`,
    '<p class="foot-note">Каждый семинар курса появляется здесь — по мере того, как их проводят. Сохраните эту страницу.</p>',
    "</div>",
    FOOT,
  ].join("\n");
}

export interface SeminarPage {
  title: string;
  publishedAt: number;
  course: { name: string; handle: string } | null;
  steps: { seq: number; label: string; at: number; cellCount: number }[];
  step: RenderedStep;
  /** Глубина относительно корня публикации: 1 у первого шага, 2 у остальных. */
  depth: number;
  base: string;
}

/** Страница одного шага. */
export function renderStep(page: SeminarPage): string {
  const many = page.steps.length > 1;
  const up = page.depth === 1 ? "" : "../";
  const rail = many
    ? [
        '<nav class="rail"><h2>Шаги семинара</h2>',
        ...page.steps.map((s, i) => {
          const on = s.seq === page.step.seq;
          // `./`, а не пустая строка: пустой href — это «текущий URL целиком»,
          // включая querystring, и в архиве такая ссылка ведёт себя странно.
          const href = i === 0 ? `${up || "./"}` : `${up}${s.seq}/`;
          return `<a class="${on ? "on" : ""}" href="${esc(href)}">${esc(s.label)}<span class="w">${clock(s.at)} · ${s.cellCount}</span></a>`;
        }),
        "</nav>",
      ].join("\n")
    : "";

  return [
    head(page.title, page.depth),
    '<header class="top"><div class="in">',
    `<h1>${esc(page.title)}</h1>`,
    '<p class="meta">',
    page.course
      ? `<a href="${esc(page.base)}/c/${esc(page.course.handle)}/">${esc(page.course.name)}</a> · `
      : "",
    `опубликован ${esc(when(page.publishedAt))}`,
    many ? ` · ${page.steps.length} шага` : "",
    "</p></div></header>",
    '<div class="body">',
    rail,
    '<main class="main">',
    '<div class="intro">',
    "<p>Здесь то, что писали и запускали на этом занятии. Того, что говорили, здесь нет.</p>",
    many
      ? "<p>Моменты, которые отметил преподаватель. Выводы — те, что тетрадь держала в этот момент: у ячейки, код которой поменяли после запуска, остаётся прежний результат.</p>"
      : "",
    "<p>Ничьих имён на этой странице нет.</p>",
    "</div>",
    page.step.cells.map((cell) => cellHtml(cell, page.depth)).join("\n"),
    `<p class="take"><a href="${up}notebook.ipynb" download>Скачать тетрадь (.ipynb)</a></p>`,
    "</main></div>",
    FOOT,
  ]
    .filter(Boolean)
    .join("\n");
}

export { blobHref };
