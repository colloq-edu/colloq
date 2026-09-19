/**
 * Карточка ссылки для лендинга — три картинки 1200×630 из одного макета.
 *
 * Под ссылкой на сайт мессенджер показывает картинку, и до сих пор она была
 * ровно одна: site/img/og.png, нарисованная руками, по-русски и с подписью
 * colloq.ru. Английской страницы в превью не существовало вовсе, а на зеркале
 * colloq.cc человеку обещали адрес, которого на картинке нет.
 *
 * Рисуют satori (дерево → SVG со своей раскладкой строк) и resvg (SVG → PNG) —
 * тот же стек, что у карточки комнаты в server/src/og-card.ts, и те же шрифты
 * из server/assets/fonts. Браузера здесь нет и не нужно: у разворачивателей
 * ссылок нет JS, и картинка обязана быть готовым файлом.
 *
 *   node --import tsx scripts/site-og.mts            (make site-og)
 *   node --import tsx scripts/site-og.mts --out /tmp (куда угодно — так тест
 *                                                     сверяет побайтно)
 *
 * Почему координаты проставлены руками, а не собраны потоком. Прежний og.png
 * — растр, нарисованный руками, и он уже разошёлся по чатам и по кэшам
 * разворачивателей. Повторять надо ровно его: снятые с него позиции ниже
 * (в комментариях — что именно меряли) держат новую картинку в тех же
 * пикселях, и подмена файла не выглядит сменой дизайна.
 *
 * Цвета взяты токенами сайта (site/styles.css). В старом og.png они записаны
 * в координатах Display P3 — его сняли в браузере с таким профилем, и внутрь
 * PNG уехал iCCP. Поэтому байты старого файла не совпадают с токенами
 * (#172C65 против #0F2D69), а на экране это один и тот же цвет. resvg пишет
 * sRGB без профиля, и токены здесь настоящие.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FONTS_DIR = path.join(ROOT, 'server/assets/fonts')

export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

/* Палитра — токены из site/styles.css. */
const BRAND = '#0F2D69'
const BRAND_2 = '#374B9B'
const ACCENT = '#0FA0D7'
const ACCENT_TEXT = '#0A6E96'
const INK = '#101A33'
const MUTED = '#5D6B8A'
const FAINT = '#9BA6BE'
const CAPTION = '#C9D3EA'
const WHITE = '#FFFFFF'
/* Линейки в карточке: --line #DCE3EF вполсилы по белому, как в старом файле. */
const RULE = '#EDF1F7'

/*
 * Раскладка задана координатами, а не потоком: каждая группа стоит абсолютно,
 * и число рядом — то, что снято со старого og.png. `top` — верх строчной
 * коробки, поэтому он всегда чуть выше чернил: satori кладёт базовую линию
 * внутри коробки по метрикам шрифта, и подгонять надо было именно коробку.
 */
const LEFT = 72 // левое поле: с него начинаются и знак, и все строки
const LOGO_TOP = 64 // чернила знака ложатся на 66, как в старом файле
const KICKER_TOP = 153 // прописные надстрочника начинаются на 158
const HEADLINE_TOP = 197 // верх «О» первой строки — 210
/*
 * Интерлиньяж и трекинг заголовка — долями кегля, чтобы английская картинка с
 * её меньшим кеглем держала тот же ритм. Числа сняты со старого og.png:
 * базовые линии двух строк там расходятся на 92 px при кегле 95, а строка
 * «на всё занятие.» занимает 586 px — без отрицательного трекинга satori
 * рисует её на 39 px шире.
 */
const HEADLINE_LEADING = 92 / 95
const HEADLINE_TRACKING = -3.5 / 95
const HEADLINE_SIZE = 95 // кегль, под который снималось всё остальное

/**
 * Верх коробки заголовка для данного кегля.
 *
 * Английский заголовок мельче русского, и если прибить оба к одному `top`,
 * он повиснет высоко: снизу до подзаголовка остаётся дыра в полсотни
 * пикселей. Поэтому привязка не по верху, а по СЕРЕДИНЕ видимого блока —
 * она остаётся там же, где на старом og.png. Коэффициент 0.982 — расстояние
 * от верха коробки до этой середины в долях кегля (пол-интерлиньяжа плюс
 * половина прописной), выведенное из метрик HSE Sans.
 */
function headlineTop(size: number): number {
  return HEADLINE_TOP + 0.982 * (HEADLINE_SIZE - size)
}
const LEAD_TOP = 404 // верх «О» первой строки — 413
const DOMAIN_TOP = 540 // базовая линия подписи — 561
const CARD_LEFT = 728
const CARD_TOP = 124
const CARD_WIDTH = 400
const CARD_HEAD = 61 // высота шапки карточки до линейки
const CARD_ROW = 105 // высота одной строки режима
const RULE_HEIGHT = 2

interface FontFace {
  name: string
  data: Buffer
  weight: 400 | 700 | 900
  style: 'normal'
}

function loadFonts(): FontFace[] {
  const read = (file: string, name: string, weight: FontFace['weight']): FontFace => ({
    name,
    data: fs.readFileSync(path.join(FONTS_DIR, file)),
    weight,
    style: 'normal',
  })
  return [
    read('HSESans-Black.otf', 'HSE Sans', 900),
    read('HSESans-Bold.otf', 'HSE Sans', 700),
    read('HSESans-Regular.otf', 'HSE Sans', 400),
    /* Моноширинный один, и вес у него 400: satori выбирает начертание по
       семейству и весу, а не по имени файла. */
    read('JetBrainsMono-Medium.ttf', 'JetBrains Mono', 400),
  ]
}

/** Один режим занятия в правой карточке. */
interface Mode {
  /** «01», «02», «03» — порядковый номер моноширинным. */
  number: string
  title: string
  note: string
}

/** Всё, что меняется от картинки к картинке. Раскладка — общая. */
export interface OgCopy {
  /** Надстрочник над заголовком; печатается прописными. */
  kicker: string
  /** Заголовок в две строки — переносы здесь явные, а не по ширине. */
  headline: [string, string]
  /** Кегль заголовка: английская строка длиннее русской и в тот же размер не влезает. */
  headlineSize: number
  /** Подзаголовок, две строки. */
  lead: [string, string]
  /** Шапка карточки, печатается прописными. */
  cardHead: string
  modes: [Mode, Mode, Mode]
  /** Подпись в левом нижнем углу: адрес, по которому эту картинку показывают. */
  domain: string
}

/*
 * Русский текст — слово в слово тот, что стоял на старом og.png; английский —
 * из героя site/en/index.html, слово в слово: превью обещает страницу, и
 * обещание должно совпасть с тем, что человек увидит, открыв ссылку.
 *
 * Подзаголовок на обеих картинках короче, чем в герое страницы: «слайды с
 * рукописными заметками и задания с отдельным ответом для каждого» в две
 * строки этого кегля не встаёт. Режется так же, как резали в старом файле.
 */
const RU: OgCopy = {
  kicker: 'Для лекций и практических занятий',
  headline: ['Одна ссылка', 'на всё занятие.'],
  headlineSize: HEADLINE_SIZE,
  lead: ['Общий Python-ноутбук, слайды и задания.', 'Студенту нужны только браузер и имя.'],
  cardHead: 'В одной комнате',
  modes: [
    { number: '01', title: 'Семинар', note: 'Пишем и запускаем код вместе' },
    { number: '02', title: 'Лекция', note: 'Объясняем на слайдах и от руки' },
    { number: '03', title: 'Консилиум', note: 'Каждый решает, обсуждаем вместе' },
  ],
  domain: 'colloq.ru',
}

const EN: OgCopy = {
  kicker: 'For lectures and hands-on classes',
  headline: ['One link', 'for the whole class.'],
  /* Русские 95 дают «for the whole class.» шириной 745 px — строка въезжает
     в белую карточку. 76 — тот же запас справа, что у русской картинки. */
  headlineSize: 76,
  lead: ['A shared Python notebook, slides and tasks.', 'A student needs a browser and a name.'],
  cardHead: 'In one room',
  modes: [
    { number: '01', title: 'Class', note: 'Write and run code together' },
    { number: '02', title: 'Lecture', note: 'Explain on slides and by hand' },
    { number: '03', title: 'Council', note: 'Everyone answers, the class discusses' },
  ],
  domain: 'colloq.ru',
}

/** Что рисуем и куда кладём. Порядок важен только для журнала. */
export const OG_IMAGES: Array<{ file: string; copy: OgCopy }> = [
  { file: 'og.png', copy: RU },
  { file: 'og-en.png', copy: EN },
  /* Зеркало: тот же английский текст, но подпись зовёт зеркало. Человеку,
     которому дали colloq.cc, картинка обязана называть colloq.cc — он читает
     её глазами и переписывает в адресную строку. */
  { file: 'og-cc.png', copy: { ...EN, domain: 'colloq.cc' } },
]

type Node = { type: string; props: Record<string, unknown> }

const h = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
  type,
  props: { style, children },
})
const text = (value: string, style: Record<string, unknown>): Node => h('span', style, value)
const sans = (value: string, style: Record<string, unknown>): Node =>
  text(value, { fontFamily: 'HSE Sans', ...style })
const mono = (value: string, size: number, color: string, tracking: number, extra = {}): Node =>
  text(value, {
    fontFamily: 'JetBrains Mono',
    fontWeight: 400,
    fontSize: size,
    lineHeight: 1,
    letterSpacing: tracking,
    color,
    ...extra,
  })

/** Знак: та же сетка 3×3, что в site/favicon.svg и в карточке комнаты. */
function logo(): Node {
  const cells: Node[] = []
  const colours = [WHITE, BRAND_2]
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      cells.push({
        type: 'rect',
        props: {
          x: 2 + column * 7,
          y: 2 + row * 7,
          width: 6,
          height: 6,
          rx: 1.6,
          fill: colours[(row + column) % 2],
        },
      })
    }
  }
  return h(
    'div',
    {
      position: 'absolute',
      left: LEFT,
      top: LOGO_TOP,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
    },
    [
      { type: 'svg', props: { width: 28, height: 28, viewBox: '0 0 24 24', children: cells } },
      sans('COLLOQ', {
        fontWeight: 900,
        fontSize: 22,
        lineHeight: 1.27,
        letterSpacing: 4.8,
        color: WHITE,
      }),
    ],
  )
}

/**
 * Стрелка «наружу» из строки режима.
 *
 * Рисуется путём, а не знаком ↗: U+2197 нет ни в HSE Sans, ни в JetBrains
 * Mono, и satori поставил бы вместо неё пустой квадрат. Проверять это на
 * готовой картинке дорого — там он выглядит как элемент дизайна.
 */
function arrow(): Node {
  return {
    type: 'svg',
    props: {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      style: { marginLeft: 'auto', marginRight: 3, marginTop: 2 },
      children: {
        type: 'path',
        props: {
          d: 'M4 20L19 5M7 5h12v12',
          stroke: BRAND,
          strokeWidth: 3.4,
          strokeLinecap: 'square',
          strokeLinejoin: 'miter',
        },
      },
    },
  }
}

/** Горизонтальная линейка между строками карточки. */
function rule(): Node {
  return h('div', { display: 'flex', height: RULE_HEIGHT, width: '100%', backgroundColor: RULE })
}

function modeRow(mode: Mode, noteSize: number): Node {
  return h(
    'div',
    {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'flex-start',
      height: CARD_ROW,
      padding: '24px 28px 0',
    },
    [
      /* Колонка номера — фиксированная: иначе «01» и «03» встают по-разному, и
         заголовки трёх строк разъезжаются по левому краю. */
      mono(mode.number, 15, ACCENT_TEXT, 0, { width: 46, lineHeight: 1.4 }),
      h('div', { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }, [
        sans(mode.title, {
          fontWeight: 700,
          fontSize: 28,
          lineHeight: 30 / 28,
          letterSpacing: -1.3,
          color: INK,
        }),
        sans(mode.note, {
          fontWeight: 400,
          fontSize: noteSize,
          lineHeight: 22 / noteSize,
          color: MUTED,
          marginTop: 5,
        }),
      ]),
      arrow(),
    ],
  )
}

function card(copy: OgCopy): Node {
  /*
   * Английские пояснения длиннее русских, а колонка та же: «Everyone answers,
   * the class discusses» в кегле 16 занимает 272 px при ширине колонки 279 —
   * запас есть, но небольшой, и лишний кегль вернул бы перенос, а с ним и
   * разъехавшиеся высоты трёх строк.
   */
  const noteSize = 16
  return h(
    'div',
    {
      position: 'absolute',
      left: CARD_LEFT,
      top: CARD_TOP,
      width: CARD_WIDTH,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: WHITE,
    },
    [
      h(
        'div',
        {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: CARD_HEAD,
          padding: '0 28px',
        },
        [
          mono(copy.cardHead.toUpperCase(), 15, ACCENT_TEXT, 2.4),
          mono('[ 3 ]', 15, ACCENT_TEXT, 1.2),
        ],
      ),
      rule(),
      modeRow(copy.modes[0], noteSize),
      rule(),
      modeRow(copy.modes[1], noteSize),
      rule(),
      modeRow(copy.modes[2], noteSize),
    ],
  )
}

function page(copy: OgCopy): Node {
  return h(
    'div',
    {
      position: 'relative',
      display: 'flex',
      width: OG_WIDTH,
      height: OG_HEIGHT,
      backgroundColor: BRAND,
      fontFamily: 'HSE Sans',
    },
    [
      logo(),
      h('div', { position: 'absolute', left: LEFT, top: KICKER_TOP, display: 'flex' }, [
        mono(copy.kicker.toUpperCase(), 18, ACCENT, 4.1, { lineHeight: 1.3 }),
      ]),
      h(
        'div',
        {
          position: 'absolute',
          left: LEFT,
          top: headlineTop(copy.headlineSize),
          display: 'flex',
          flexDirection: 'column',
        },
        copy.headline.map((line) =>
          sans(line, {
            fontWeight: 900,
            fontSize: copy.headlineSize,
            lineHeight: HEADLINE_LEADING,
            letterSpacing: HEADLINE_TRACKING * copy.headlineSize,
            color: WHITE,
          }),
        ),
      ),
      h(
        'div',
        {
          position: 'absolute',
          left: LEFT,
          top: LEAD_TOP,
          display: 'flex',
          flexDirection: 'column',
        },
        copy.lead.map((line) =>
          sans(line, { fontWeight: 400, fontSize: 28, lineHeight: 38 / 28, color: CAPTION }),
        ),
      ),
      h('div', { position: 'absolute', left: LEFT, top: DOMAIN_TOP, display: 'flex' }, [
        mono(copy.domain, 20, FAINT, 1.6, { lineHeight: 1.3 }),
      ]),
      card(copy),
    ],
  )
}

/** Нарисовать одну картинку. Чистая функция от текста — тем и проверяется. */
export async function renderOg(copy: OgCopy): Promise<Buffer> {
  const svg = await satori(page(copy) as never, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: loadFonts(),
  })
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng())
}

/** Нарисовать все три и разложить по каталогу. Возвращает имена и размеры. */
export async function writeOgImages(dir: string): Promise<Array<{ file: string; bytes: number }>> {
  fs.mkdirSync(dir, { recursive: true })
  const out: Array<{ file: string; bytes: number }> = []
  for (const { file, copy } of OG_IMAGES) {
    const png = await renderOg(copy)
    fs.writeFileSync(path.join(dir, file), png)
    out.push({ file, bytes: png.length })
  }
  return out
}

/* Запуск из консоли: `--out <каталог>` для проверки, без него — в site/img. */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const at = process.argv.indexOf('--out')
  const dir = at === -1 ? path.join(ROOT, 'site/img') : path.resolve(process.argv[at + 1]!)
  for (const { file, bytes } of await writeOgImages(dir)) {
    console.log(path.join(dir, file), bytes, 'B')
  }
}
