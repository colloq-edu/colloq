/**
 * The link card for the landing page — three 1200×630 images from one layout.
 *
 * Under a link to the site a messenger shows an image, and until now there
 * was exactly one: site/img/og.png, drawn by hand, in Russian and captioned
 * colloq.ru. The English page had no preview at all, and on the colloq.cc
 * mirror a person was promised an address that is not on the image.
 *
 * The drawing is done by satori (tree → SVG with its own line layout) and
 * resvg (SVG → PNG) — the same stack as the room card in server/src/og-card.ts,
 * and the same fonts from server/assets/fonts. There is no browser here and
 * none is needed: link unfurlers have no JS, and the image has to be a ready
 * file.
 *
 *   node --import tsx scripts/site-og.mts            (make site-og)
 *   node --import tsx scripts/site-og.mts --out /tmp (anywhere — that is how
 *                                                     the test compares bytes)
 *
 * Why the coordinates are set by hand rather than laid out by flow. The old
 * og.png is a raster drawn by hand, and it has already spread through chats
 * and the unfurlers' caches. It has to be repeated exactly: the positions
 * taken from it below (the comments say what exactly was measured) keep the
 * new image in the same pixels, and replacing the file does not look like a
 * change of design.
 *
 * The colours are the site's tokens (site/styles.css). In the old og.png they
 * are written in Display P3 coordinates — it was captured in a browser with
 * that profile, and an iCCP chunk went into the PNG. So the bytes of the old
 * file do not match the tokens (#172C65 versus #0F2D69), while on screen it is
 * the same colour. resvg writes sRGB without a profile, and the tokens here
 * are the real ones.
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

/* The palette — tokens from site/styles.css. */
const BRAND = '#0F2D69'
const BRAND_2 = '#374B9B'
const ACCENT = '#0FA0D7'
const ACCENT_TEXT = '#0A6E96'
const INK = '#101A33'
const MUTED = '#5D6B8A'
const FAINT = '#9BA6BE'
const CAPTION = '#C9D3EA'
const WHITE = '#FFFFFF'
/* Rules in the card: --line #DCE3EF at half strength on white, as in the old file. */
const RULE = '#EDF1F7'

/*
 * The layout is given by coordinates, not by flow: every group is absolutely
 * positioned, and the number next to it is what was measured on the old
 * og.png. `top` is the top of the line box, so it is always slightly above
 * the ink: satori puts the baseline inside the box by the font's metrics, and
 * it was the box that had to be fitted.
 */
const LEFT = 72 // left margin: both the mark and every line start at it
const LOGO_TOP = 64 // the mark's ink lands at 66, as in the old file
const KICKER_TOP = 153 // the kicker's capitals start at 158
const HEADLINE_TOP = 197 // top of the first line's "O" is at 210
/*
 * The headline's leading and tracking are fractions of the size, so that the
 * English image with its smaller size keeps the same rhythm. The numbers are
 * taken from the old og.png: the baselines of its two lines are 92 px apart
 * at size 95, and the line "на всё занятие." takes 586 px — without negative
 * tracking satori draws it 39 px wider.
 */
const HEADLINE_LEADING = 92 / 95
const HEADLINE_TRACKING = -3.5 / 95
const HEADLINE_SIZE = 95 // the size everything else was measured at

/**
 * The top of the headline box for a given size.
 *
 * The English headline is smaller than the Russian one, and if both are
 * pinned to the same `top`, it hangs high: a hole of fifty-odd pixels is left
 * below it, down to the lead. So the anchor is not the top but the MIDDLE of
 * the visible block — it stays where it was on the old og.png. The factor
 * 0.982 is the distance from the top of the box to that middle in fractions
 * of the size (half the leading plus half a capital), derived from the
 * metrics of HSE Sans.
 */
function headlineTop(size: number): number {
  return HEADLINE_TOP + 0.982 * (HEADLINE_SIZE - size)
}
const LEAD_TOP = 404 // top of the first line's "O" is at 413
const DOMAIN_TOP = 540 // the caption's baseline is at 561
const CARD_LEFT = 728
const CARD_TOP = 124
const CARD_WIDTH = 400
const CARD_HEAD = 61 // height of the card's header down to the rule
const CARD_ROW = 105 // height of one mode row
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
    /* There is one monospace, and its weight is 400: satori picks the face by
       family and weight, not by file name. */
    read('JetBrainsMono-Medium.ttf', 'JetBrains Mono', 400),
  ]
}

/** One class mode in the right-hand card. */
interface Mode {
  /** "01", "02", "03" — the ordinal number, in monospace. */
  number: string
  title: string
  note: string
}

/** Everything that changes from image to image. The layout is shared. */
export interface OgCopy {
  /** The kicker above the headline; printed in capitals. */
  kicker: string
  /** The headline in two lines — the breaks here are explicit, not by width. */
  headline: [string, string]
  /** The headline size: the English line is longer than the Russian one and does not fit at the same size. */
  headlineSize: number
  /** The lead, two lines. */
  lead: [string, string]
  /** The card's header, printed in capitals. */
  cardHead: string
  modes: [Mode, Mode, Mode]
  /** The caption in the bottom left corner: the address this image is shown for. */
  domain: string
}

/*
 * The Russian text is word for word what stood on the old og.png; the English
 * is from the hero of site/en/index.html, word for word: the preview promises
 * a page, and the promise must match what a person sees on opening the link.
 *
 * On both images the lead is shorter than in the page's hero: "слайды с
 * рукописными заметками и задания с отдельным ответом для каждого" ("slides
 * with handwritten notes and tasks with a separate answer for each") does not
 * fit into two lines at this size. It is cut the same way as in the old file.
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
  /* The Russian 95 makes "for the whole class." 745 px wide — the line runs
     into the white card. 76 leaves the same margin on the right as the Russian image. */
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

/** What we draw and where it goes. The order matters only for the log. */
export const OG_IMAGES: Array<{ file: string; copy: OgCopy }> = [
  { file: 'og.png', copy: RU },
  { file: 'og-en.png', copy: EN },
  /* The mirror: the same English text, but the caption names the mirror. A
     person who was given colloq.cc must see colloq.cc on the image — they read
     it with their eyes and type it into the address bar. */
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

/** The mark: the same 3×3 grid as in site/favicon.svg and in the room card. */
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
 * The "outward" arrow of a mode row.
 *
 * Drawn as a path, not as the ↗ character: U+2197 is in neither HSE Sans nor
 * JetBrains Mono, and satori would put an empty box in its place. Checking
 * that on the finished image is costly — there it looks like a design element.
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

/** A horizontal rule between the card's rows. */
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
      /* The number column is fixed: otherwise "01" and "03" sit differently,
         and the titles of the three rows drift apart along the left edge. */
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
   * The English notes are longer than the Russian ones, and the column is the
   * same: "Everyone answers, the class discusses" at size 16 takes 272 px in a
   * column 279 wide — there is a margin, but a small one, and one more point
   * of size would bring back the wrap, and with it the uneven heights of the
   * three rows.
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

/** Draw one image. A pure function of the text — that is how it is tested. */
export async function renderOg(copy: OgCopy): Promise<Buffer> {
  const svg = await satori(page(copy) as never, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: loadFonts(),
  })
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng())
}

/** Draw all three and lay them out in a directory. Returns names and sizes. */
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

/* Run from the console: `--out <dir>` for checking, without it into site/img. */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const at = process.argv.indexOf('--out')
  const dir = at === -1 ? path.join(ROOT, 'site/img') : path.resolve(process.argv[at + 1]!)
  for (const { file, bytes } of await writeOgImages(dir)) {
    console.log(path.join(dir, file), bytes, 'B')
  }
}
