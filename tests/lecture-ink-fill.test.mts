/**
 * A snapped frame is tinted inside, as GoodNotes tints its shapes: the
 * outline as before, and under it the frame's own colour laid lightly, so a
 * formula boxed by it reads as crisply as outside.
 *
 * What is checked here:
 *
 *   — the stroke's `fill` goes console → server → hall, and into every
 *     snapshot a late tab is handed (the welcome batch, a page asked for),
 *     and the tab keeps it as it lays pieces and pages;
 *   — the server takes exactly `true` and nothing else, the way it takes a
 *     real group id or nothing, and only on a stroke's first piece;
 *   — the renderers tint exactly the frames, pen and highlighter at their
 *     own alphas, the tint laid before the outline; freehand ink, a line and
 *     a dot never get one, and neither does the thumbnail of a freehand
 *     stroke;
 *   — in the ink layer only the snap sets it, and every canvas passes it on.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { inkOf, startLecture, stopLecture, undoInk } from '../server/src/lecture.js'
import type { InkStroke } from '../shared/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
import {
  fillInside,
  FRAME_FILL_MARKER,
  FRAME_FILL_PEN,
  frameFillAlpha,
  framePoints,
  mergeInkPiece,
  paintRuns,
  paintStroke,
  replaceInkPage,
  type PaintedStroke,
  type StrokeSink,
} from '../web/src/components/lecture/ink.js'
import { inkPaths } from '../web/src/components/lecture/film.js'

/* ------------------------------------------------------------ the wire */

function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) heard.push(JSON.parse(String(frame)))
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {},
  }
  return { ws: fake as unknown as WebSocket, heard }
}

let rooms = 0
function room() {
  const id = `ink-fill-${++rooms}`
  createSession(id, 'Рамка', null)
  const who: TokenPayload = { sessionId: id, participantId: 'p_host', role: 'host' }
  const pen = socket()
  const hall = socket()
  handleControlSocket(pen.ws, id, who)
  handleControlSocket(hall.ws, id, { sessionId: id, participantId: 'p_student', role: 'guest' })
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  pen.heard.length = 0
  hall.heard.length = 0
  return { id, who, pen, hall }
}

function done(id: string): void {
  stopLecture(id)
  closeControlRoom(id)
}

const FRAME = framePoints({ x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.5 })
const SCRIBBLE = [0.1, 0.1, 0.15, 0.12, 0.2, 0.1, 0.25, 0.13]

function ink(id: string, rest: Partial<ControlClientMessage & { t: 'ink' }> & Record<string, unknown>): ControlClientMessage {
  return { t: 'ink', id, page: 1, color: '#101a33', width: 0.004, points: SCRIBBLE, from: 0, ...rest } as ControlClientMessage
}

test('a frame’s fill goes console → server → hall and into every snapshot; freehand ink carries none', async () => {
  const { id, who, pen, hall } = room()
  dispatch(pen.ws, id, who, ink('free'))
  dispatch(pen.ws, id, who, ink('box', { points: FRAME, fill: true }))
  dispatch(pen.ws, id, who, ink('mark', { color: '#ffd60a8c', width: 0.022, points: FRAME, fill: true }))
  await sleep(120)

  // The room's memory.
  const kept = new Map(inkOf(id).map((stroke) => [stroke.id, stroke]))
  assert.equal(kept.get('box')?.fill, true)
  assert.equal(kept.get('mark')?.fill, true)
  assert.ok(!('fill' in kept.get('free')!), 'a freehand stroke was given a fill')

  // The hall, as its tab lays the pieces.
  let hallInk: InkStroke[] = []
  for (const frame of hall.heard) {
    if (frame.t !== 'ink:add') continue
    hallInk = mergeInkPiece(hallInk, frame.stroke, frame.from) ?? hallInk
  }
  const seen = new Map(hallInk.map((stroke) => [stroke.id, stroke]))
  assert.equal(seen.get('box')?.fill, true, 'the hall lost the frame’s fill')
  assert.equal(seen.get('mark')?.fill, true)
  assert.equal(seen.get('free')?.fill, undefined)

  // A late tab: its welcome batch, and the page asked for again.
  const late = socket()
  handleControlSocket(late.ws, id, { sessionId: id, participantId: 'p_late', role: 'guest' })
  const welcome = late.heard.find((frame) => frame.t === 'ink')
  assert.ok(welcome && welcome.t === 'ink')
  assert.deepEqual(
    welcome.strokes.map((stroke) => [stroke.id, stroke.fill]),
    [['free', undefined], ['box', true], ['mark', true]],
  )
  dispatch(late.ws, id, { sessionId: id, participantId: 'p_late', role: 'guest' }, { t: 'ink:page', page: 1 })
  const asked = late.heard.findLast((frame) => frame.t === 'ink:page')
  assert.ok(asked && asked.t === 'ink:page')
  const page = replaceInkPage([], 1, asked.strokes)
  assert.deepEqual(
    page.map((stroke) => [stroke.id, stroke.fill]),
    [['free', undefined], ['box', true], ['mark', true]],
  )
  // And the frame paints tinted on the late tab, the scribble does not.
  const sink = canvas()
  paintRuns(sink, page, 1000, 1000, 1)
  assert.deepEqual(sink.tints(), [
    ['#101a33', FRAME_FILL_PEN],
    ['#ffd60a8c', FRAME_FILL_MARKER],
  ])

  // Undo takes the frame back as any stroke.
  assert.deepEqual(undoInk(id, 1), { dropped: ['mark'] })
  done(id)
})

test('the server takes a fill of exactly `true`, on a stroke’s first piece, as it takes a group', async () => {
  const { id, who, pen } = room()
  const odd: unknown[] = ['true', 1, {}, [], false, null]
  odd.forEach((fill, at) => dispatch(pen.ws, id, who, ink(`odd${at}`, { points: FRAME, fill, group: 42 })))
  // A later piece cannot tint a line already drawn.
  dispatch(pen.ws, id, who, ink('line', { points: [0.1, 0.1, 0.2, 0.2] }))
  dispatch(pen.ws, id, who, ink('line', { points: [0.3, 0.3, 0.4, 0.4], from: 4, fill: true }))
  await sleep(120)
  const strokes = inkOf(id)
  assert.equal(strokes.length, odd.length + 1, 'a malformed fill refused the whole stroke')
  for (const stroke of strokes) {
    assert.ok(!('fill' in stroke), `${stroke.id} kept a fill: ${JSON.stringify(stroke.fill)}`)
    assert.ok(!('group' in stroke), `${stroke.id} kept a group of 42`)
  }
  assert.deepEqual(strokes.at(-1)?.points, [0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4])
  done(id)
})

/* ------------------------------------------------------- the renderers */

/** A canvas that records what each `fill()` and `stroke()` was laid with. */
function canvas() {
  const fills: { style: unknown; alpha: number; path: number[][]; closed: boolean }[] = []
  const strokes: { style: unknown; alpha: number }[] = []
  let path: number[][] = []
  let closed = false
  const sink: StrokeSink & { fills: typeof fills; strokes: typeof strokes; tints(): [unknown, number][] } = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    fills,
    strokes,
    beginPath() {
      path = []
      closed = false
    },
    closePath() {
      closed = true
    },
    moveTo(x, y) {
      path.push([x, y])
    },
    lineTo(x, y) {
      path.push([x, y])
    },
    quadraticCurveTo(_cx, _cy, x, y) {
      path.push([x, y])
    },
    arc(x, y) {
      path.push([x, y])
    },
    fill() {
      fills.push({ style: sink.fillStyle, alpha: sink.globalAlpha, path, closed })
    },
    stroke() {
      strokes.push({ style: sink.strokeStyle, alpha: sink.globalAlpha })
    },
    /** The tints laid: fills below full alpha, a dot's own fill aside. */
    tints() {
      return fills.filter((fill) => fill.alpha < 1).map((fill) => [fill.style, fill.alpha])
    },
  }
  return sink
}

test('the alphas: a pen frame at FRAME_FILL_PEN, a highlighter at a share of its own, both light', () => {
  assert.equal(frameFillAlpha('#101a33'), FRAME_FILL_PEN)
  assert.equal(frameFillAlpha('#ffd60a8c'), FRAME_FILL_MARKER)
  // Light enough that a formula under it stays readable, on a light slide and a dark one.
  assert.ok(FRAME_FILL_PEN >= 0.1 && FRAME_FILL_PEN <= 0.18)
  const marker = (0x8c / 255) * FRAME_FILL_MARKER
  assert.ok(marker < 0x8c / 255 / 2, 'the highlighter frame’s inside is as dense as its band')
  assert.ok(marker >= 0.1 && marker <= 0.25)
})

test('a frame is tinted once, under its outline, up to the line’s inner edge, and the canvas alpha comes back', () => {
  const sink = canvas()
  paintStroke(sink, FRAME, '#d4162f', 0.004, 1000, 500, 1, true)
  assert.equal(sink.fills.length, 1)
  const [tint] = sink.fills
  assert.equal(tint.style, '#d4162f')
  assert.equal(tint.alpha, FRAME_FILL_PEN)
  assert.ok(tint.closed, 'the tint’s path is left open')
  // The frame spans 200..600 × 150..250; its 4 px line covers 2 px on each side of that.
  assert.deepEqual(tint.path, [[202, 152], [598, 152], [598, 248], [202, 248]])
  // The outline after it, at full alpha.
  assert.equal(sink.strokes.length, 1)
  assert.equal(sink.strokes[0].alpha, 1)
  assert.equal(sink.globalAlpha, 1)
  // Under an alpha the caller set, the tint is a share of it, and it is given back.
  const faded = canvas()
  faded.globalAlpha = 0.5
  fillInside(faded, FRAME, '#d4162f', 1000, 500, 4)
  assert.equal(faded.fills[0].alpha, 0.5 * FRAME_FILL_PEN)
  assert.equal(faded.globalAlpha, 0.5)
})

test('a highlighter frame’s tint stays off its band, so the band is one even density', () => {
  /*
   * The band is 22 px wide round the 200..600 × 300..500 box. A tint along
   * the line's middle covered the band's inner half: that half came out
   * denser than the outer, two lines instead of one.
   */
  const sink = canvas()
  paintStroke(sink, FRAME, '#ffd60a8c', 0.022, 1000, 1000, 1, true)
  const [tint] = sink.fills
  assert.equal(tint.alpha, FRAME_FILL_MARKER)
  for (const [x, y] of tint.path) {
    assert.ok(x >= 211 - 1e-9 && x <= 589 + 1e-9, `the tint reaches x=${x}, into the band`)
    assert.ok(y >= 311 - 1e-9 && y <= 489 + 1e-9, `the tint reaches y=${y}, into the band`)
  }
  assert.deepEqual(tint.path, [[211, 311], [589, 311], [589, 489], [211, 489]])
  // A box no wider than its own band has no inside left to tint.
  const tiny = canvas()
  paintStroke(tiny, framePoints({ x0: 0.5, y0: 0.5, x1: 0.51, y1: 0.6 }), '#ffd60a8c', 0.022, 1000, 1000, 1, true)
  assert.equal(tiny.tints().length, 0)
  assert.equal(tiny.strokes.length, 1)
})

test('the renderers tint exactly the frames: never freehand ink, a line or a dot', () => {
  const strokes: PaintedStroke[] = [
    { id: 'free', color: '#101a33', width: 0.004, points: SCRIBBLE },
    { id: 'line', color: '#101a33', width: 0.004, points: [0.1, 0.1, 0.9, 0.1] },
    { id: 'dot', color: '#101a33', width: 0.004, points: [0.5, 0.5, 0.5, 0.5] },
    { id: 'box', color: '#2563eb', width: 0.004, points: FRAME, fill: true },
    // A long highlight in two pieces, drawn as one path, no tint.
    { id: 'h1', color: '#4ade808c', width: 0.022, points: SCRIBBLE },
    { id: 'h2', group: 'h1', color: '#4ade808c', width: 0.022, points: [0.25, 0.13, 0.3, 0.1] },
    { id: 'hbox', color: '#ffd60a8c', width: 0.022, points: FRAME, fill: true },
  ]
  const sink = canvas()
  paintRuns(sink, strokes, 1000, 1000, 1)
  assert.deepEqual(sink.tints(), [
    ['#2563eb', FRAME_FILL_PEN],
    ['#ffd60a8c', FRAME_FILL_MARKER],
  ])
  // free, line, box, the highlight run, hbox: one outline each; the dot is its own fill.
  assert.equal(sink.strokes.length, 5)
  assert.equal(sink.fills.length, 3)

  // The same strokes without the field: outlines only, as an old tab draws them.
  const old = canvas()
  paintRuns(old, strokes.map(({ fill: _, ...rest }) => rest), 1000, 1000, 1)
  assert.deepEqual(old.tints(), [])
})

test('the thumbnails tint exactly the frames too, at the same alphas', () => {
  const strokes = [
    { id: 'free', page: -1, color: '#101a33', width: 0.004, points: SCRIBBLE },
    { id: 'box', page: -1, color: '#101a33', width: 0.004, points: FRAME, fill: true as const },
    { id: 'hbox', page: -1, color: '#ffd60a8c', width: 0.022, points: FRAME, fill: true as const },
  ]
  const paths = inkPaths(strokes, 96, 54)
  // Highlighters first, under the pens, as the sheet lays them.
  assert.deepEqual(
    paths.map((line) => [line.color, line.fill]),
    [
      ['#ffd60a8c', FRAME_FILL_MARKER],
      ['#101a33', undefined],
      ['#101a33', FRAME_FILL_PEN],
    ],
  )
  const card = code('web/src/components/lecture/SheetCard.svelte')
  assert.match(card, /fill=\{line\.fill === undefined \? 'none' : line\.color\}/)
  assert.match(card, /fill-opacity=\{line\.fill\}/)
})

/* ------------------------------------------------------- the ink layer */

/** The source without comments: an explanation is not a promise. */
function code(rel: string): string {
  return fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

const INK = code('web/src/components/lecture/InkLayer.svelte')

function body(name: string): string {
  const from = INK.indexOf(`function ${name}(`)
  assert.notEqual(from, -1, `${name} is gone from the ink layer`)
  const rest = INK.slice(from + 1)
  const to = rest.search(/\n {2}function /)
  return to === -1 ? rest : rest.slice(0, to)
}

test('in the ink layer only the snap of a frame sets the fill, and every canvas passes it on', () => {
  // Set in one place, and there only for a frame: a straight line has no inside.
  assert.equal(INK.match(/fill: true as const/g)?.length, 2)
  assert.match(body('straightenNow'), /\.\.\.\(frame \? \{ fill: true as const \} : \{\}\)/)
  assert.match(body('sendPoints'), /\.\.\.\(stroke\.fill \? \{ fill: true as const \} : \{\}\)/)
  assert.doesNotMatch(body('newStroke'), /fill/, 'a freehand stroke is opened with a fill')
  // The dry and the wet canvases hand the field to the painter; the marker canvas reads it off the stroke.
  assert.equal(body('paintDry').match(/drawStroke\([^)]*stroke\.fill === true\)/g)?.length, 2)
  assert.match(body('paintWetAll'), /drawStroke\([^)]*stroke\.fill === true\)/)
  assert.match(body('markersHere'), /const \{ id, group, color, width, fill \} = stroke/)
  assert.match(body('drawStroke'), /paintStroke\(paint, points, tint, thick, px, py, near, fill\)/)
  // A tint is laid whole: a frame that grew is repainted, never grown in place.
  assert.match(body('paintDry'), /stroke\.fill \? drawn\.get\(stroke\.id\) : undefined/)
  assert.match(body('growWet'), /stroke\.straight \|\| stroke\.fill\) \{/)
})
