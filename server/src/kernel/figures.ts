import { tr } from '@shared/i18n'
import { PLOTLY_MIME } from '@shared/plotly'

/**
 * Что делать с фигурой plotly по дороге из ядра в документ.
 *
 * Общее место для двух приёмников вывода — ячейки комнаты (`outputs.ts`) и
 * попытки консилиума (`council.ts`): решения здесь одни и те же, а потолки
 * разные, поэтому потолок приходит параметром.
 *
 * Чистый модуль без Yjs и без диска — ради теста.
 */

/**
 * Сколько знаков JSON позволено одной фигуре.
 *
 * Двенадцать мегабайт — это примерно полмиллиона точек scatter в двоичной
 * упаковке plotly.py (`{"dtype":"f8","bdata":…}`), то есть заведомо больше
 * всего, что имеет смысл показывать человеку на проекторе. Дальше цена платится
 * не рисованием, а тем, что фигура едет каждому в комнате и ложится в каждый
 * кадр истории — и платится она молча, потому что plotly.js честно пытается
 * нарисовать и миллион.
 *
 * Потолок стоит РЯДОМ с бюджетом ячейки, а не вместо него: вынесенная фигура
 * считается тому бюджету восьмой частью, как и картинка, так что две такие
 * фигуры в одной ячейке всё равно упрутся в общий предел.
 */
export const MAX_FIGURE_CHARS = 12 * 1024 * 1024

/**
 * Разметка, которой plotly бутстрапит себя в классический notebook.
 *
 * Рендерер `notebook` (умолчание plotly 5.x в ipykernel) перед первым графиком
 * присылает `display_data` из одного ключа `text/html` — и в нём ВЕСЬ бандл
 * plotly.js, пять мегабайт скрипта. Мы скрипты не исполняем: санитайзер их
 * вырезает, на экране остаётся пустое место, а пять мегабайт тем временем
 * ложатся в общий документ, уезжают каждому в комнате и съедают весь бюджет
 * вывода ячейки — той самой, ради графика которой всё и затевалось.
 *
 * Узнаётся по подписи самого plotly в начале блока. Ошибиться тут почти нечем:
 * `window.PlotlyConfig` пишет только он и только в этом блоке.
 */
function isPlotlyBootstrap(html: string): boolean {
  return html.length > 64 * 1024 && html.slice(0, 4096).includes('window.PlotlyConfig')
}

/**
 * Набор без мёртвой разметки plotly.
 *
 * Два случая, и оба — сотни килобайт (а то и мегабайты) скрипта, которого
 * продукт не исполнит никогда:
 *
 *  1. рядом с фигурой приехал `text/html` — это рендерер `plotly_mimetype+
 *     notebook`; фигуру нарисует рамка, а разметка тут лишняя целиком;
 *  2. бутстрап рендерера `notebook` — см. `isPlotlyBootstrap`.
 *
 * Возвращается новый объект: набор приходит из разбора кадра ядра, и трогать
 * его на месте значило бы чинить чужую запись задним числом.
 */
export function withoutDeadPlotlyHtml(bundle: Record<string, string>): Record<string, string> {
  const html = bundle['text/html']
  if (html === undefined) return bundle
  const dead = bundle[PLOTLY_MIME] !== undefined || isPlotlyBootstrap(html)
  if (!dead) return bundle
  const out: Record<string, string> = {}
  for (const [mime, value] of Object.entries(bundle)) if (mime !== 'text/html') out[mime] = value
  return out
}

/** Сколько знаков в фигуре этого набора. `0` — фигуры в нём нет. */
export function figureChars(bundle: Record<string, string>): number {
  return bundle[PLOTLY_MIME]?.length ?? 0
}

/**
 * Честная строка вместо графика, который не увезти.
 *
 * Именно строка, а не молчание и не обрезанный JSON: обрезанная фигура — это
 * битый кадр, по которому plotly.js покажет пустоту, а молчание читается как
 * «ячейка ничего не вывела». Совет в ней — настоящий выход, а не отговорка:
 * `fig.write_html` кладёт график в файл рядом с тетрадью, и его можно открыть.
 */
export function figureTooBigNotice(chars: number): string {
  const mb = Math.max(1, Math.round(chars / (1024 * 1024)))
  return tr('server.output.plotlyTooBig', { p0: mb })
}

/** Набор без фигуры — когда она не влезла и на её месте будет строка. */
export function withoutFigure(bundle: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [mime, value] of Object.entries(bundle)) if (mime !== PLOTLY_MIME) out[mime] = value
  return out
}
