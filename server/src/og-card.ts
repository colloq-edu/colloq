/**
 * The room card for messengers: a 1200×630 picture with the class name.
 *
 * A messenger shows a picture under the link, and one picture for everyone
 * lied: the screenshot of the join screen carried the name of a test room, not
 * the one the link invites to. Now the picture is drawn for each room from the
 * Paper mock-up ("Превью · комната"): on the left "You are joining", the class
 * name, the date and the address; on the right a white panel with the name
 * field and the join button.
 *
 * satori draws it (an HTML-like tree → SVG, with its own line layout) and
 * resvg (SVG → PNG). There is no browser on the server, and none is needed:
 * the fonts sit next to it in server/assets/fonts, the same ones the site
 * uses. The finished bytes are cached per room: the name rarely changes, while
 * messengers come for the same picture once per chat the link was dropped in.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { tr } from '@shared/i18n'
import type { Locale } from '@shared/i18n'

export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts')

/* The palette: tokens from Paper (01 · Основа). */
const BRAND = '#0F2D69'
const BRAND_2 = '#374B9B'
const ACCENT = '#0FA0D7'
const ACCENT_TEXT = '#0A6E96'
const FAINT = '#7C8699'
const NIGHT_MUTED = '#9BA6BE'
const CAPTION = '#C9D3EA'

interface FontFace {
  name: string
  data: Buffer
  weight: 400 | 500 | 700 | 900
  style: 'normal'
}

let fonts: Promise<FontFace[]> | null = null

function loadFonts(): Promise<FontFace[]> {
  if (fonts) return fonts
  const read = async (file: string, name: string, weight: FontFace['weight']): Promise<FontFace> => ({
    name,
    data: await readFile(path.join(FONTS_DIR, file)),
    weight,
    style: 'normal',
  })
  fonts = Promise.all([
    read('HSESans-Black.otf', 'HSE Sans', 900),
    read('HSESans-Bold.otf', 'HSE Sans', 700),
    read('HSESans-Regular.otf', 'HSE Sans', 400),
    read('JetBrainsMono-Medium.ttf', 'JetBrains Mono', 500),
  ])
  fonts.catch(() => {
    fonts = null
  })
  return fonts
}

export interface RoomCard {
  name: string
  /** When the room was created; on the card as "12.09 · 14:54". */
  createdAt: number
  /** What goes in the corner: the instance's host name, without the scheme. */
  host: string
  language: Locale
}

/** Past this the name fits the card at no font size, so it is cut with an ellipsis. */
const NAME_LIMIT = 90

export function cardName(name: string): string {
  const chars = [...name.trim()]
  return chars.length <= NAME_LIMIT ? chars.join('') : `${chars.slice(0, NAME_LIMIT - 1).join('').trimEnd()}…`
}

/*
 * The name's font size goes by its length. satori wraps lines itself, but three
 * lines of a hundred pixels do not fit the card; beyond that the size shrinks.
 */
function nameSize(name: string): number {
  const length = [...name].length
  if (length <= 12) return 104
  if (length <= 18) return 92
  if (length <= 26) return 76
  if (length <= 40) return 60
  return 48
}

function whenLabel(createdAt: number, language: Locale): string {
  const locale = language === 'en' ? 'en-GB' : 'ru-RU'
  const day = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(createdAt)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(
    createdAt,
  )
  return `${day} · ${time}`
}

type Node = { type: string; props: Record<string, unknown> }
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({
  type,
  props: { style, children, ...extra },
})
const text = (value: string, style: Record<string, unknown>): Node => h('span', style, value)
const mono = (value: string, size: number, color: string, tracking: number): Node =>
  text(value, { fontFamily: 'JetBrains Mono', fontWeight: 500, fontSize: size, lineHeight: 1.3, letterSpacing: tracking, color })

function logo(): Node {
  const cells: Node[] = []
  const colours = ['#FFFFFF', BRAND_2]
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      cells.push({
        type: 'rect',
        props: { x: 2 + column * 7, y: 2 + row * 7, width: 6, height: 6, rx: 1.6, fill: colours[(row + column) % 2] },
      })
    }
  }
  return h('div', { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }, [
    { type: 'svg', props: { width: 28, height: 28, viewBox: '0 0 24 24', children: cells } },
    text('COLLOQ', { fontFamily: 'HSE Sans', fontWeight: 900, fontSize: 22, lineHeight: 1.27, letterSpacing: 4.8, color: '#FFFFFF' }),
  ])
}

function arrow(): Node {
  return {
    type: 'svg',
    props: {
      width: 22,
      height: 22,
      viewBox: '0 0 24 24',
      fill: 'none',
      children: {
        type: 'path',
        props: { d: 'M5 12h14M13 6l6 6-6 6', stroke: '#FFFFFF', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      },
    },
  }
}

function card(room: RoomCard): Node {
  const name = cardName(room.name)
  const size = nameSize(name)
  const left = h(
    'div',
    { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', flexGrow: 1, flexShrink: 1, minWidth: 0, height: '100%' },
    [
      logo(),
      h('div', { display: 'flex', flexDirection: 'column', gap: 22, width: 600 }, [
        mono(tr('room.ui.840').toUpperCase(), 18, ACCENT, 3.6),
        text(name, {
          fontFamily: 'HSE Sans',
          fontWeight: 900,
          fontSize: size,
          lineHeight: 0.96,
          letterSpacing: -0.04 * size,
          color: '#FFFFFF',
          width: 600,
          wordBreak: 'break-word',
          lineClamp: 4,
        }),
        mono(whenLabel(room.createdAt, room.language), 22, NIGHT_MUTED, 1.3),
        text(tr('room.ui.856'), { fontFamily: 'HSE Sans', fontWeight: 400, fontSize: 22, lineHeight: 1.36, color: CAPTION, width: 560, paddingTop: 10 }),
      ]),
      mono(room.host, 20, NIGHT_MUTED, 1.6),
    ],
  )
  const panel = h(
    'div',
    { display: 'flex', flexDirection: 'column', width: 400, flexShrink: 0, backgroundColor: '#FFFFFF', alignSelf: 'center', padding: '32px 28px', gap: 28 },
    [
      h('div', { display: 'flex', flexDirection: 'column', gap: 12 }, [
        mono(tr('room.ui.848').toUpperCase(), 14, ACCENT_TEXT, 2.8),
        h('div', { display: 'flex', flexDirection: 'row', alignItems: 'center', height: 60, padding: '0 20px', border: `2px solid ${ACCENT}` }, [
          text(tr('room.ui.849'), { fontFamily: 'HSE Sans', fontWeight: 400, fontSize: 22, lineHeight: 1.27, color: FAINT }),
        ]),
      ]),
      h('div', { display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, height: 64, backgroundColor: BRAND }, [
        text(tr('room.ui.862').toUpperCase(), { fontFamily: 'HSE Sans', fontWeight: 700, fontSize: 18, lineHeight: 1.33, letterSpacing: 2.9, color: '#FFFFFF' }),
        arrow(),
      ]),
    ],
  )
  return h(
    'div',
    { display: 'flex', flexDirection: 'row', width: CARD_WIDTH, height: CARD_HEIGHT, backgroundColor: BRAND, padding: '64px 72px', gap: 56, alignItems: 'stretch', fontFamily: 'HSE Sans' },
    [left, panel],
  )
}

let renders = 0
/** How many times the picture was actually drawn: the test catches the cache with it. */
export function roomCardRenders(): number {
  return renders
}

/** Draw the card, without the cache; the cache belongs to `roomCardPng`. */
export async function renderRoomCard(room: RoomCard): Promise<Buffer> {
  const faces = await loadFonts()
  const svg = await satori(card(room) as never, { width: CARD_WIDTH, height: CARD_HEIGHT, fonts: faces })
  renders += 1
  return new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } }).render().asPng()
}

/*
 * The cache of finished bytes is keyed by everything the drawing depends on.
 * The ceiling is low: the picture is needed when the link is dropped into a
 * chat, that is, for the rooms of the coming days, not the whole semester.
 */
const MAX_CACHED = 64
const cache = new Map<string, Promise<Buffer>>()

export function roomCardKey(room: RoomCard): string {
  return `${room.language} ${room.host} ${room.createdAt} ${room.name}`
}

export function roomCardPng(room: RoomCard): Promise<Buffer> {
  const key = roomCardKey(room)
  const known = cache.get(key)
  if (known) return known
  const png = renderRoomCard(room)
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, png)
  png.catch(() => {
    if (cache.get(key) === png) cache.delete(key)
  })
  return png
}
