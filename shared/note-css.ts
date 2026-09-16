/**
 * Что оформление из текстовой ячейки имеет право сделать с чужим экраном.
 *
 * Атрибут `style` в заметке был запрещён целиком, и запрет был заслуженный:
 * `<div style="position:fixed;inset:0;background:#000;z-index:9999">` из одной
 * ячейки — чёрный экран у всех тридцати человек и у ноутбука в проекторе,
 * причём поверх интерфейса, так что удалить ячейку мышью уже нельзя, а
 * перезагрузка возвращает ту же ячейку.
 *
 * Но цена запрета — вся привычная разметка учебной тетради. `<div
 * style="background:#eef;padding:8px;border-left:3px solid #66f">` — это врезка
 * «Замечание», которую пишут в каждом втором ноутбуке; без атрибута она
 * доезжает голым `<div>`, то есть неотличимо от обычного абзаца. Снаружи это
 * читается не как «оформление запрещено», а как «HTML не работает», потому что
 * структура-то прошла, а видимой разницы нет.
 *
 * Поэтому запрещён не атрибут, а СВОЙСТВА: значение разбирается, знакомое
 * оформление проходит, рычаги на чужой экран — нет. Граница проведена по
 * одному признаку: свойство остаётся, если всё, что оно может испортить, —
 * прямоугольник самой заметки; и уходит, если оно умеет рисовать, двигать или
 * ловить мышь ЗА его пределами.
 *
 * Отсюда и неочевидные отказы:
 *
 * - `box-shadow` и `text-shadow` — не украшение, а `0 0 0 100vmax #000`: тень
 *   рисуется ВНЕ элемента и закрашивает экран целиком. Ровно та дыра, от
 *   которой закрывались запретом `position`, только с другой стороны, и
 *   единственные два свойства, которые умеют это без него.
 * - `url(...)` — адрес, который запросит браузер каждого в комнате: тот же
 *   довод, что и у `@import` в теневом корне вывода (ScopedOutput.svelte).
 * - `calc()` и `var()` — способ пронести число мимо потолка ниже и значение
 *   мимо разбора. Заметке они не нужны ни разу.
 *
 * Санитайзер тегов живёт отдельно (web/src/lib/sanitize.ts): `<style>`,
 * `<form>`, `<audio>`, `<video>` по-прежнему выброшены целиком, и по прежней
 * причине — таблица стилей внутри страницы действует на ВСЮ страницу, а
 * свойства этот файл считает по одному элементу.
 *
 * Один файл на оба отрисовщика заметки — комнату (web/src/lib/render.svelte.ts)
 * и статическую публикацию (server/src/publish/render.ts). Вторая копия
 * политики безопасности — это способ открыть дыру, а не закрыть.
 */

/**
 * Свойства, которые заметка может назвать. Всё, чего здесь нет, снимается.
 *
 * Список, а не чёрный список: свойств в CSS несколько сотен, каждый год
 * прибавляются новые, и `anchor-name` с `view-transition-name` — это ровно те
 * два, о которых чёрный список узнал бы из отчёта об уже испорченном занятии.
 */
export const NOTE_CSS_PROPS: ReadonlySet<string> = new Set(
  `color background background-color background-image background-position
   background-size background-repeat background-clip background-origin
   font font-family font-size font-style font-weight font-variant font-stretch
   line-height letter-spacing word-spacing tab-size
   text-align text-align-last text-indent text-transform
   text-decoration text-decoration-color text-decoration-line
   text-decoration-style text-decoration-thickness text-underline-offset
   text-overflow white-space word-break overflow-wrap word-wrap hyphens
   direction vertical-align
   display width min-width max-width height min-height max-height
   margin margin-top margin-right margin-bottom margin-left margin-inline
   margin-block padding padding-top padding-right padding-bottom padding-left
   padding-inline padding-block box-sizing
   border border-top border-right border-bottom border-left
   border-width border-style border-color
   border-top-width border-right-width border-bottom-width border-left-width
   border-top-style border-right-style border-bottom-style border-left-style
   border-top-color border-right-color border-bottom-color border-left-color
   border-radius border-top-left-radius border-top-right-radius
   border-bottom-left-radius border-bottom-right-radius
   overflow overflow-x overflow-y float clear opacity visibility
   aspect-ratio object-fit object-position
   flex flex-direction flex-wrap flex-flow flex-grow flex-shrink flex-basis
   justify-content justify-items justify-self align-items align-content
   align-self place-items place-content place-self order gap row-gap column-gap
   grid grid-template grid-template-columns grid-template-rows
   grid-template-areas grid-column grid-row grid-auto-flow grid-auto-columns
   grid-auto-rows
   columns column-count column-width column-gap column-rule column-span
   border-collapse border-spacing table-layout caption-side empty-cells
   list-style list-style-type list-style-position`
    .trim()
    .split(/\s+/),
)

/**
 * Функции, которые разрешены в значении. Скобка с любым другим именем —
 * причина выбросить объявление целиком.
 *
 * Цвет и градиент считаются сами по себе и никуда не ходят. `url()`,
 * `image-set()`, `attr()`, `element()` ходят; `calc()`, `min()`, `max()`,
 * `clamp()`, `var()`, `env()` — считают, а значит проносят число мимо потолка
 * длин.
 */
const CSS_FUNCS: ReadonlySet<string> = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
])

/**
 * Потолок длины — в пикселях, куда приводится любая единица.
 *
 * Без него белый список свойств половину работы не делает: `border: 9999px
 * solid #000` и `margin-left: -9999px` уводят содержимое за пределы заметки
 * теми самыми свойствами, которые оформлению нужны. 1600 — заметно больше
 * самой широкой колонки тетради и заведомо меньше экрана.
 *
 * Отрицательные отбивки нужны редко и по мелочи (сдвинуть рамку на пару
 * пикселей), поэтому вниз потолок куда ближе: -240 хватает на приём, но не на
 * вынос блока из ячейки.
 */
const MAX_PX = 1600
const MIN_PX = -240

/** Потолок процентов: `line-height: 150%` — да, `width: 900%` — нет. */
const MAX_PCT = 400

/** Отдельно кегль: 96px — это уже «одна буква на пол-экрана». */
const MAX_FONT_PX = 96

/** Сколько пикселей в единице. `%` считается отдельно — он не длина. */
const UNIT_PX: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: 16,
  rem: 16,
  ex: 8,
  ch: 8,
  // Единицы экрана считаются по большому экрану — то есть по худшему случаю:
  // `width: 100vw` на проекторе должно упереться в потолок, а не пролезть под
  // ним потому, что мерили ноутбуком.
  vw: 20,
  vh: 12,
  vmin: 12,
  vmax: 20,
  vi: 20,
  vb: 12,
  svw: 20,
  svh: 12,
  lvw: 20,
  lvh: 12,
  dvw: 20,
  dvh: 12,
}

const NUMBER = /(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)/gi

/** Влезает ли каждое число значения в потолок. */
function withinBounds(value: string, limit: number): boolean {
  NUMBER.lastIndex = 0
  let found: RegExpExecArray | null
  while ((found = NUMBER.exec(value)) !== null) {
    const n = Number(found[1])
    if (!Number.isFinite(n)) return false
    const unit = found[2].toLowerCase()
    if (unit === '%') {
      if (Math.abs(n) > MAX_PCT) return false
      continue
    }
    const factor = UNIT_PX[unit]
    // Без единицы — не длина: `line-height: 1.5`, `opacity: .4`, `flex: 1 1 0`,
    // а также каналы цвета внутри `rgb(...)`. Мерить их пикселями бессмысленно.
    if (factor === undefined) continue
    const px = n * factor
    if (px > limit || px < MIN_PX) return false
  }
  return true
}

/** Имя функции перед скобкой: `linear-gradient(` -> `linear-gradient`. */
const CALL = /(^|[\s,(:/])(-?[a-z][a-z0-9-]*)\s*\(/gi

/** Знает ли значение только разрешённые функции. */
function callsAllowed(value: string): boolean {
  CALL.lastIndex = 0
  let found: RegExpExecArray | null
  while ((found = CALL.exec(value)) !== null) {
    if (!CSS_FUNCS.has(found[2].toLowerCase())) return false
  }
  // Скобка, перед которой нет имени, — способ спрятать вызов от разбора выше.
  return !/(^|[\s,:/])\(/.test(value)
}

/**
 * Объявления значения атрибута `style`, разрезанные по `;`.
 *
 * Разрез руками, а не `split(';')`: точка с запятой бывает внутри скобок
 * (`color-mix(in srgb, …)` её не содержит, а вот чужая функция — вполне) и
 * внутри кавычек, и `split` резал бы объявление пополам, превращая хвост
 * функции в отдельное «свойство». Оно бы всё равно не нашлось в белом списке,
 * но разбирать надо то, что прочтёт браузер, а не то, что удобно резать.
 */
function declarations(value: string): string[] {
  const out: string[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      out.push(value.slice(start, i))
      start = i + 1
    }
  }
  out.push(value.slice(start))
  return out
}

/**
 * Длина значения, за которой разбирать уже незачем.
 *
 * Атрибут на десять килобайт — это не оформление, а попытка занять разбором
 * каждую вкладку в комнате: заметка перерисовывается на каждое нажатие соседа.
 */
const MAX_STYLE = 2000

/**
 * Значение атрибута `style` из заметки — тем, что можно показать.
 *
 * Пустая строка означает «атрибут снять целиком»: `style=""` в разметке ничем
 * не лучше отсутствия атрибута, а лишний пустой атрибут в сравнении разметки
 * читается как изменение.
 *
 * Отбрасывается ОБЪЯВЛЕНИЕ, а не весь атрибут: в
 * `style="background:#eef;position:fixed"` первое — обычная врезка, и терять её
 * из-за второго значило бы наказывать за соседство. Автор увидит, что одно из
 * двух не подействовало, и это честный ответ.
 */
export function safeStyle(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_STYLE) return ''
  /*
   * Обратный слеш — это escape в CSS: `\70 osition` браузер читает как
   * `position`. Разбирать такое значит писать второй разборщик CSS; значение с
   * ним не проходит целиком, и ни одной настоящей заметки это не стоит — в
   * оформлении escape встречается только в `content`, которого здесь нет.
   *
   * Управляющие символы и `<` ловятся тем же доводом: они бывают только у
   * того, кто пробует разбор на прочность.
   */
  // eslint-disable-next-line no-control-regex -- управляющие символы и есть предмет
  if (/[\\<>{}@]|[ -]/.test(value)) return ''

  const kept: string[] = []
  for (const decl of declarations(value)) {
    const colon = decl.indexOf(':')
    if (colon === -1) continue
    const prop = decl.slice(0, colon).trim().toLowerCase()
    if (!NOTE_CSS_PROPS.has(prop)) continue
    /*
     * `!important` снимается, а не запрещает объявление.
     *
     * Автору он не даёт ничего — инлайновый стиль и так сильнее правил
     * `.prose-note`, — а нам стоил бы возможности защититься от заметки
     * собственным правилом. Заметка, скопированная из чужого ноутбука, несёт
     * его сплошь и рядом, и падать на ней было бы враньём про «HTML не
     * работает».
     */
    const body = decl
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim()
    if (!body) continue
    if (!callsAllowed(body)) continue
    if (!withinBounds(body, prop === 'font-size' || prop === 'font' ? MAX_FONT_PX : MAX_PX)) continue
    kept.push(`${prop}: ${body}`)
  }
  return kept.join('; ')
}
