/**
 * Интерактивный график plotly: один mime, одна рамка, один способ её описать.
 *
 * Ядро присылает фигуру отдельным типом — `application/vnd.plotly.v1+json`, —
 * а не картинкой и не разметкой. Пока продукт про него не знал, ячейка с
 * `px.histogram(...)` не выводила НИЧЕГО, и это не преувеличение: в наборе от
 * ipykernel с нынешним plotly (7.x, рендерер `plotly_mimetype`) лежит ровно
 * один ключ — сама фигура. Ни `text/plain`, ни картинки. Выбор представления
 * (`web/src/components/notebook/output-mimes.ts · pickMime`) не находил
 * ничего знакомого и возвращал `null`, а `null` рисуется пустым местом.
 *
 * Со старым рендерером (`plotly_mimetype+notebook`, умолчание plotly 5.x)
 * пусто было по другой причине: там к фигуре приезжал `text/html` со скриптом
 * — и скрипт вырезал санитайзер, оставив пустой `<div>`.
 *
 * ОТРИСОВКА ИДЁТ В ПЕСОЧНИЦЕ, и это не осторожность вообще, а свойство
 * предмета. Фигуру собирает библиотека, работающая в коде любого, кому в
 * комнате разрешён запуск (SECURITY.md: вывод ячейки — недоверенные данные), а
 * plotly.js — чужая поверхность на пять мегабайт, которая разбирает
 * псевдо-HTML в подписях, ходит по ссылкам и грузит картинки по адресам. Между
 * ней и страницей занятия стоит `<iframe>` с непрозрачным origin: ни кук, ни
 * `localStorage`, ни DOM родителя, ни сети (см. `server/src/plotly-frame.ts`).
 *
 * Здесь лежит то, что обязаны знать ОБЕ стороны: имя типа, адреса рамки и
 * бандла, приведение фигуры к тому, что уезжает внутрь, и форма сообщений.
 * Разойтись им негде — разбор кадра ломается молча.
 */

/** Тип, которым ядро называет фигуру. Пишется в документ строкой JSON. */
export const PLOTLY_MIME = 'application/vnd.plotly.v1+json'

/**
 * Бандл plotly.js — с нашего origin, по постоянному адресу.
 *
 * Файл кладёт в `web/public/plotly/` скрипт `plotly:dist` (web/package.json) —
 * тем же приёмом, что и воркер pdf.js. Постоянный адрес нужен ДВУМ сторонам
 * сразу: на него ссылается разметка рамки и он же стоит в её `script-src`, а
 * собирает заголовок сервер, который о сборке фронтенда не знает ничего.
 *
 * Никаких CDN. Cloudflare и половина остальных из России недоступны
 * (memory: cloudflare-blocked-from-russia), а аудитория без интернета — обычное
 * дело: `cdn.plot.ly` в такой комнате означает пустое место вместо графика.
 */
export const PLOTLY_BUNDLE_PATH = '/plotly/plotly.min.js'

/**
 * Адрес страницы-рамки.
 *
 * Маршрут сервера, а не файл в `public/`, потому что у рамки СВОЙ заголовок
 * `Content-Security-Policy` с директивой `sandbox` — а её, в отличие от
 * остальных, из `<meta>` не задать (спецификация её оттуда игнорирует). Под
 * `/api/`, чтобы в разработке запрос уходил на сервер через тот же прокси
 * Vite, что и весь остальной API, и адрес был один и тот же в обоих режимах.
 */
export const PLOTLY_FRAME_PATH = '/api/plotly/frame'

/**
 * Откуда рамке разрешено взять скрипт — параметром запроса.
 *
 * В песочнице origin документа непрозрачный, и `'self'` в такой политике
 * опираться не на что: адрес в `script-src` обязан быть явным. Сервер его не
 * знает — за ним может стоять ретранслятор, Vite на 5173 или голый localhost,
 * — а страница знает про себя всё, поэтому origin приезжает от неё.
 *
 * Подделать этим нечего: `<script src>` внутри рамки — постоянный адрес выше,
 * то есть НАШ origin. Чужое значение только запретит бандл (рамка честно
 * скажет, что не загрузилась), но не подменит его.
 */
export const PLOTLY_ORIGIN_PARAM = 'o'

/** `http(s)://хост[:порт]` и ничего больше — то, что попадёт в заголовок. */
export const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9._-]{1,255}(?::\d{1,5})?$/

/**
 * Высота графика, у которого её не просили.
 *
 * Plotly по умолчанию рисует 450 пикселей (`layout.height`), и рамке надо то
 * же самое число ДО того, как бандл приедет: место под график резервируется
 * заранее, иначе тетрадь прыгает при каждой загрузке.
 */
export const PLOTLY_DEFAULT_HEIGHT = 450

/** Ниже этого график перестаёт быть графиком, выше — занимает экран целиком. */
export const PLOTLY_MIN_HEIGHT = 180
export const PLOTLY_MAX_HEIGHT = 2400

/**
 * Фигура в том виде, в каком она уезжает в рамку.
 *
 * Три поля, и только они: `config` внутри фигуры — это чужие настройки нашей
 * панели инструментов (вплоть до `plotlyServerURL` и кнопки «отправить в Chart
 * Studio»), а всё прочее в объекте фигуры нас не касается вовсе.
 */
export interface PlotlyFigure {
  data: unknown[]
  layout: Record<string, unknown>
  frames?: unknown[]
}

/**
 * Привести то, что прислало ядро, к фигуре — или отказать.
 *
 * Белый список, а не вычитание: поле, которое plotly заведёт завтра, не должно
 * уехать в рамку само собой. `null` — это не фигура, и показывать её нечем.
 */
export function normalizeFigure(value: unknown): PlotlyFigure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.data)) return null
  const layout =
    raw.layout && typeof raw.layout === 'object' && !Array.isArray(raw.layout)
      ? (raw.layout as Record<string, unknown>)
      : {}
  const figure: PlotlyFigure = { data: raw.data, layout }
  if (Array.isArray(raw.frames)) figure.frames = raw.frames
  return figure
}

/** Высота из фигуры — с потолком и полом, потому что число приходит извне. */
export function figureHeight(figure: PlotlyFigure): number {
  const asked = figure.layout.height
  if (typeof asked !== 'number' || !Number.isFinite(asked)) return PLOTLY_DEFAULT_HEIGHT
  return Math.min(PLOTLY_MAX_HEIGHT, Math.max(PLOTLY_MIN_HEIGHT, Math.round(asked)))
}

/* --------------------------------------------------------- пересказ фигуры */

/**
 * Сколько чисел в одном поле трассы.
 *
 * plotly.py с шестой версии кодирует numpy-массивы двоичными: вместо списка в
 * JSON лежит `{"dtype":"f8","bdata":"<base64>"}`. Сто тысяч точек так весят
 * вдвое меньше — и длину у них уже не спросишь через `.length`.
 */
const ITEM_BYTES: Record<string, number> = {
  i1: 1, u1: 1, i2: 2, u2: 2, f2: 2, i4: 4, u4: 4, f4: 4, i8: 8, u8: 8, f8: 8,
}

function fieldLength(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== 'object') return 0
  const packed = value as { dtype?: unknown; bdata?: unknown }
  if (typeof packed.bdata !== 'string' || typeof packed.dtype !== 'string') return 0
  const size = ITEM_BYTES[packed.dtype]
  if (!size) return 0
  // base64: четыре знака на три байта, хвостовые «=» не считаются.
  const padding = packed.bdata.endsWith('==') ? 2 : packed.bdata.endsWith('=') ? 1 : 0
  return Math.round(((packed.bdata.length * 3) / 4 - padding) / size)
}

/** Чем фигура является — без её содержимого. */
export interface FigureShape {
  /** Тип первой трассы: histogram, box, scatter, … */
  kind: string
  traces: number
  points: number
}

/**
 * Пересказ фигуры одной строкой — для оракула и для журнала.
 *
 * Модели незачем мегабайт координат (она их всё равно не прочитает, а бюджет
 * контекста они съедят целиком), но «здесь был график» знать надо: ячейка с
 * одним `px.scatter(...)` иначе выглядит как ячейка, которая ничего не
 * вывела. Ровно тот же довод, по которому в контекст едет
 * `[image/png, ~120 KB image]` вместо пикселей.
 */
export function figureShape(figure: PlotlyFigure): FigureShape {
  let points = 0
  let kind = 'scatter'
  figure.data.forEach((one, index) => {
    if (!one || typeof one !== 'object') return
    const trace = one as Record<string, unknown>
    if (index === 0 && typeof trace.type === 'string') kind = trace.type
    // Длина трассы — это длина её самого длинного поля: у гистограммы есть
    // только `x`, у карты высот — `z`, у scatter — и `x`, и `y` одной длины.
    let longest = 0
    for (const key of ['x', 'y', 'z', 'values', 'labels', 'lat', 'lon']) {
      longest = Math.max(longest, fieldLength(trace[key]))
    }
    points += longest
  })
  return { kind, traces: figure.data.length, points }
}

/* ------------------------------------------------- протокол «страница ↔ рамка» */

/**
 * Метка протокола.
 *
 * Origin песочницы — строка `"null"`, и сверять его бессмысленно: такой же у
 * любой другой песочницы на странице. Сверяется ИСТОЧНИК (`event.source ===
 * iframe.contentWindow` у страницы, `=== window.parent` у рамки), а метка
 * отсеивает чужие сообщения от библиотек, расширений и devtools, которые
 * ходят через тот же `window.postMessage`.
 */
export const PLOTLY_MSG = 'colloq.plotly.v1'

/** Рамка готова принять фигуру: бандл загружен, DOM на месте. */
export interface PlotlyReady {
  colloq: typeof PLOTLY_MSG
  kind: 'ready'
}

/** Фигура — единственное, что едет внутрь. */
export interface PlotlyDraw {
  colloq: typeof PLOTLY_MSG
  kind: 'draw'
  figure: PlotlyFigure
}

/** Сколько места график занял на самом деле. */
export interface PlotlyHeight {
  colloq: typeof PLOTLY_MSG
  kind: 'height'
  height: number
}

/** Не нарисовалось — и почему. Пустое место здесь хуже любой строки. */
export interface PlotlyFailed {
  colloq: typeof PLOTLY_MSG
  kind: 'failed'
  reason: string
}

export type PlotlyToFrame = PlotlyDraw
export type PlotlyFromFrame = PlotlyReady | PlotlyHeight | PlotlyFailed

/** Похоже ли это вообще на наше сообщение. Форму проверяют обе стороны. */
export function isPlotlyMessage(value: unknown): value is { colloq: string; kind: string } {
  if (!value || typeof value !== 'object') return false
  const msg = value as { colloq?: unknown; kind?: unknown }
  return msg.colloq === PLOTLY_MSG && typeof msg.kind === 'string'
}
