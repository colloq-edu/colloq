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
import { tr, translate } from '@shared/i18n'
import type { Locale } from '@shared/i18n'
import { plural } from '@shared/plural'

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

/* --------------------------------------------- competitions and courses */

/*
 * The same card for a competition, a course and the competitions list: the
 * room's layout (logo, a caption in capitals, the big name, a line in mono, a
 * sentence, the host; a white panel on the right with a button), so a link to
 * any of them reads as the same product in a chat. What changes is the panel:
 * a competition shows its metric and its numbers, a course its classes.
 */

export interface CompetitionCard {
  title: string
  blurb: string
  /** live, finished, or not started yet; a draft never gets a card. */
  phase: 'live' | 'finished' | 'upcoming'
  startsAt: number | null
  deadlineAt: number | null
  metricName: string
  metricDirection: 'higher' | 'lower'
  entrants: number
  perDay: number
  host: string
  language: Locale
  timeZone: string
}

export interface CourseCard {
  name: string
  blurb: string | null
  /** The first few classes, as named on the course page. */
  lessons: string[]
  total: number
  host: string
  language: Locale
}

export interface CompetitionsCard {
  host: string
  language: Locale
}

/** The card's own language, not the process's: the card says what the instance says. */
function sayIn(language: Locale) {
  return (key: string, params?: Record<string, string | number>) => translate(language, key, params)
}

/*
 * The name's size, and no larger than keeps its longest word on one line:
 * HSE Sans Black runs about 0.62 em a letter, and `break-word` would cut a
 * word wider than the 600 px column in the middle ("Соревнован-ия").
 */
function fittedSize(title: string): number {
  const longest = Math.max(1, ...title.split(/\s+/).map((word) => [...word].length))
  return Math.min(nameSize(title), Math.floor(600 / (0.62 * longest)))
}

function dateTime(at: number, language: Locale, timeZone: string): string {
  const locale = language === 'en' ? 'en-GB' : 'ru-RU'
  const day = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', timeZone }).format(at)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(at)
  return `${day} · ${time}`
}

/** A sentence for the card: one line of spaces, cut where three lines end. */
function cardSentence(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join('').trimEnd()}…`
}

function leftColumn(eyebrow: string, name: string, line: string | null, sentence: string | null, host: string): Node {
  const title = cardName(name)
  const size = fittedSize(title)
  return h(
    'div',
    { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', flexGrow: 1, flexShrink: 1, minWidth: 0, height: '100%' },
    [
      logo(),
      h('div', { display: 'flex', flexDirection: 'column', gap: 22, width: 600 }, [
        mono(eyebrow.toUpperCase(), 18, ACCENT, 3.6),
        text(title, {
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
        ...(line ? [mono(line, 22, NIGHT_MUTED, 1.3)] : []),
        ...(sentence
          ? [text(sentence, { fontFamily: 'HSE Sans', fontWeight: 400, fontSize: 22, lineHeight: 1.36, color: CAPTION, width: 560, paddingTop: 10, lineClamp: 3 })]
          : []),
      ]),
      mono(host, 20, NIGHT_MUTED, 1.6),
    ],
  )
}

function button(label: string): Node {
  return h('div', { display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, height: 64, backgroundColor: BRAND }, [
    text(label.toUpperCase(), { fontFamily: 'HSE Sans', fontWeight: 700, fontSize: 18, lineHeight: 1.33, letterSpacing: 2.9, color: '#FFFFFF' }),
    arrow(),
  ])
}

function panel(rows: Node[], action: string): Node {
  return h(
    'div',
    { display: 'flex', flexDirection: 'column', width: 400, flexShrink: 0, backgroundColor: '#FFFFFF', alignSelf: 'center', padding: '32px 28px', gap: 26 },
    [...rows, button(action)],
  )
}

/** A label in capitals and the value under it, the way the room's panel labels its field. */
function fact(label: string, value: string, size = 30): Node {
  return h('div', { display: 'flex', flexDirection: 'column', gap: 6 }, [
    mono(label.toUpperCase(), 14, ACCENT_TEXT, 2.8),
    text(value, { fontFamily: 'HSE Sans', fontWeight: 700, fontSize: size, lineHeight: 1.15, color: BRAND, lineClamp: 2 }),
  ])
}

function frame(left: Node, right: Node): Node {
  return h(
    'div',
    { display: 'flex', flexDirection: 'row', width: CARD_WIDTH, height: CARD_HEIGHT, backgroundColor: BRAND, padding: '64px 72px', gap: 56, alignItems: 'stretch', fontFamily: 'HSE Sans' },
    [left, right],
  )
}

function competitionPhaseLine(card: CompetitionCard): string {
  const say = sayIn(card.language)
  const when = (at: number) => dateTime(at, card.language, card.timeZone)
  if (card.phase === 'finished') return say('server.ogCard.finished').toUpperCase()
  if (card.phase === 'upcoming' && card.startsAt !== null) return say('server.ogCard.startsAt', { p0: when(card.startsAt) }).toUpperCase()
  if (card.deadlineAt !== null) return say('server.ogCard.until', { p0: when(card.deadlineAt) }).toUpperCase()
  return say('server.ogCard.open').toUpperCase()
}

function competitionCard(card: CompetitionCard): Node {
  const say = sayIn(card.language)
  const metric = `${cardSentence(card.metricName || say('server.ogCard.metricUnnamed'), 28)} ${card.metricDirection === 'higher' ? '↑' : '↓'}`
  return frame(
    leftColumn(say('server.ogCard.competition'), card.title, competitionPhaseLine(card), card.blurb ? cardSentence(card.blurb, 150) : null, card.host),
    panel(
      [
        fact(say('server.ogCard.metric'), metric, [...metric].length > 20 ? 24 : 30),
        h('div', { display: 'flex', flexDirection: 'row', gap: 28 }, [
          fact(say('server.ogCard.entrants'), String(card.entrants)),
          fact(say('server.ogCard.perDay'), String(card.perDay)),
        ]),
      ],
      card.phase === 'finished' ? say('server.ogCard.seeResults') : say('server.ogCard.takePart'),
    ),
  )
}

function lessonsLabel(total: number, language: Locale): string {
  const say = sayIn(language)
  if (language === 'en') return say(total === 1 ? 'server.ogCard.lessonsOne' : 'server.ogCard.lessonsMany', { p0: total })
  return say(plural(total, 'server.ogCard.lessonsOne', 'server.ogCard.lessonsFew', 'server.ogCard.lessonsMany'), { p0: total })
}

function courseCard(card: CourseCard): Node {
  const say = sayIn(card.language)
  const shown = card.lessons.slice(0, 4)
  const rows: Node[] = [mono(say('server.ogCard.lessons').toUpperCase(), 14, ACCENT_TEXT, 2.8)]
  if (shown.length === 0) {
    rows.push(text(say('server.ogCard.lessonsSoon'), { fontFamily: 'HSE Sans', fontWeight: 400, fontSize: 22, lineHeight: 1.3, color: FAINT }))
  }
  shown.forEach((name, index) => {
    rows.push(h('div', { display: 'flex', flexDirection: 'row', alignItems: 'baseline', gap: 14 }, [
      mono(String(index + 1).padStart(2, '0'), 18, ACCENT_TEXT, 1),
      text(cardSentence(name, 34), { fontFamily: 'HSE Sans', fontWeight: 700, fontSize: 22, lineHeight: 1.25, color: BRAND, lineClamp: 1 }),
    ]))
  })
  if (card.total > shown.length && shown.length > 0) {
    rows.push(text(say('server.ogCard.lessonsMore', { p0: card.total - shown.length }), { fontFamily: 'HSE Sans', fontWeight: 400, fontSize: 20, lineHeight: 1.3, color: FAINT }))
  }
  return frame(
    leftColumn(say('server.ogCard.course'), card.name, card.total > 0 ? lessonsLabel(card.total, card.language).toUpperCase() : null, card.blurb ? cardSentence(card.blurb, 150) : null, card.host),
    panel([h('div', { display: 'flex', flexDirection: 'column', gap: 14 }, rows)], say('server.ogCard.openCourse')),
  )
}

function competitionsCard(card: CompetitionsCard): Node {
  const say = sayIn(card.language)
  return frame(
    leftColumn(say('server.ogCard.competitionsEyebrow'), say('server.ogCard.competitionsTitle'), null, say('server.ogCard.competitionsSentence'), card.host),
    panel(
      [
        fact(say('server.ogCard.solution'), say('server.ogCard.solutionValue'), 24),
        fact(say('server.ogCard.check'), say('server.ogCard.checkValue'), 24),
        fact(say('server.ogCard.board'), say('server.ogCard.boardValue'), 24),
      ],
      say('server.ogCard.seeCompetitions'),
    ),
  )
}

async function renderNode(node: Node): Promise<Buffer> {
  const faces = await loadFonts()
  const svg = await satori(node as never, { width: CARD_WIDTH, height: CARD_HEIGHT, fonts: faces })
  renders += 1
  return new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } }).render().asPng()
}

/** One cache for every card but the room's, keyed by everything a drawing depends on. */
function cachedPng(key: string, draw: () => Promise<Buffer>): Promise<Buffer> {
  const known = cache.get(key)
  if (known) return known
  const png = draw()
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

export function competitionCardKey(card: CompetitionCard): string {
  return `competition ${JSON.stringify(card)}`
}

export function competitionCardPng(card: CompetitionCard): Promise<Buffer> {
  return cachedPng(competitionCardKey(card), () => renderNode(competitionCard(card)))
}

export function courseCardKey(card: CourseCard): string {
  return `course ${JSON.stringify(card)}`
}

export function courseCardPng(card: CourseCard): Promise<Buffer> {
  return cachedPng(courseCardKey(card), () => renderNode(courseCard(card)))
}

export function competitionsCardPng(card: CompetitionsCard): Promise<Buffer> {
  return cachedPng(`competitions ${JSON.stringify(card)}`, () => renderNode(competitionsCard(card)))
}
