/**
 * Lecture pages, projection and page turning: the promises the pult audit
 * of October 2026 found broken.
 *
 *  • pdf.js page resources are given back: every page the sheet, "next" or
 *    the strip touched used to stay decoded for the whole lecture, and an
 *    image-heavy deck pushed an iPad tab over Safari's memory ceiling;
 *  • switching the lecture document is not "the lecture is over": the
 *    console toasted "Lecture ended" and the projection fell to its waiting
 *    screen while the lecture simply went on with another deck;
 *  • a presentation clicker's keys mean what they mean in a slideshow;
 *  • the rail swipe runs along the rail, the ink follows the picture on the
 *    sheet, blanking reaches the students' screens, and the projection shows
 *    the hall no words.
 *
 * The server half runs on a real room with a fake socket; the browser half
 * is held by the source, the way lecture-ink-page does it, and by the stands
 * (scripts/pencil-check.mts, scripts/ui-check.mts).
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { clearInk, startLecture, stopLecture } from '../server/src/lecture.js'
import { makeFile } from '../server/src/workspace.js'
import { OPEN_ROOM } from '../shared/rules.js'
import type { ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
import { acquirePage, IDLE_PAGES, pagesHeld, releasePage } from '../web/src/lib/pdf-pages.js'
import { BLANK_KEYS, ESCAPE_AGAIN_MS, isClickerReload } from '../web/src/components/lecture/remote.js'

/* ------------------------------------------------------------ page cache */

interface FakePage {
  index: number
  cleaned: number
  cleanup(): boolean
}

/** A document whose pages count their cleanups; `missing` pages refuse once. */
function fakeDoc(missing: Set<number> = new Set()) {
  const made = new Map<number, FakePage>()
  let asked = 0
  const doc = {
    async getPage(index: number) {
      asked += 1
      if (missing.has(index)) {
        missing.delete(index)
        throw new Error('the chunk has not arrived')
      }
      let page = made.get(index)
      if (!page) {
        const fresh: FakePage = {
          index,
          cleaned: 0,
          cleanup() {
            fresh.cleaned += 1
            return true
          },
        }
        page = fresh
        made.set(index, page)
      }
      return page
    },
  }
  return { doc: doc as never, made, asked: () => asked }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

test('a page given back stays decoded among the last few, and the one pushed out is cleaned up', async () => {
  const { doc, made } = fakeDoc()
  for (let index = 1; index <= IDLE_PAGES + 2; index += 1) {
    assert.ok(await acquirePage(doc, index))
    releasePage(doc, index)
  }
  await settle()
  // The two oldest left the line and gave their images back; the rest wait.
  assert.equal(made.get(1)?.cleaned, 1, 'the oldest idle page kept its decoded images')
  assert.equal(made.get(2)?.cleaned, 1)
  for (let index = 3; index <= IDLE_PAGES + 2; index += 1) {
    assert.equal(made.get(index)?.cleaned, 0, `page ${index} was cleaned while still in the line`)
  }
  assert.equal(pagesHeld(doc).idle.length, IDLE_PAGES)
})

test('a page somebody holds is never cleaned up, however many others pass by', async () => {
  const { doc, made } = fakeDoc()
  // The main sheet holds page 1 (a render in flight).
  assert.ok(await acquirePage(doc, 1))
  for (let index = 2; index <= IDLE_PAGES * 3; index += 1) {
    assert.ok(await acquirePage(doc, index))
    releasePage(doc, index)
  }
  await settle()
  assert.equal(made.get(1)?.cleaned, 0, 'a held page was cleaned up under its render')
  assert.deepEqual(pagesHeld(doc).held, [1])
  releasePage(doc, 1)
  assert.deepEqual(pagesHeld(doc).held, [])
})

test('two holders of one page share it: the sheet and "next" do not refetch each other', async () => {
  const { doc, asked } = fakeDoc()
  const a = await acquirePage(doc, 5)
  const b = await acquirePage(doc, 5)
  assert.equal(a, b)
  assert.equal(asked(), 1, 'the second holder asked pdf.js again')
  releasePage(doc, 5)
  assert.deepEqual(pagesHeld(doc).held, [5], 'one release freed a page the other still renders')
  releasePage(doc, 5)
  assert.deepEqual(pagesHeld(doc).idle, [5])
  // Taken again from the line: no new fetch, and it leaves the line.
  await acquirePage(doc, 5)
  assert.equal(asked(), 1)
  assert.deepEqual(pagesHeld(doc).idle, [])
  releasePage(doc, 5)
})

test('a page that did not come is not remembered: the next attempt asks again', async () => {
  const { doc, asked } = fakeDoc(new Set([9]))
  assert.equal(await acquirePage(doc, 9), null)
  assert.deepEqual(pagesHeld(doc).held, [], 'a failed page stayed held')
  assert.ok(await acquirePage(doc, 9), 'the retry got the cached refusal')
  assert.equal(asked(), 2)
  releasePage(doc, 9)
  // An extra release is harmless rather than negative.
  releasePage(doc, 9)
  assert.deepEqual(pagesHeld(doc).held, [])
})

test('every page holder in the lecture goes through the cache and gives back what it takes', () => {
  const sheet = code('web/src/components/lecture/LecturePage.svelte')
  const pult = code('web/src/components/lecture/ConsoleView.svelte')
  for (const [name, source] of [
    ['LecturePage', sheet],
    ['ConsoleView', pult],
  ] as const) {
    assert.doesNotMatch(source, /\.getPage\(/, `${name} fetches pages around the cache again`)
    assert.match(source, /acquirePage\(/, `${name} no longer takes pages from the cache`)
    assert.match(source, /releasePage\(/, `${name} never gives its pages back`)
  }
  // A thumbnail scrolled away cancels its render instead of letting it run into a 1×1 canvas.
  assert.match(pult, /task\?\.cancel\(\)/)
})

/* ------------------------------------------------- the document switch */

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
}

function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
    },
  }
  return { ws: fake as unknown as WebSocket, heard }
}

let rooms = 0
function room(): string {
  const id = `pages-${++rooms}`
  createSession(id, 'Лекция', null)
  setRules(id, { ...OPEN_ROOM })
  return id
}

const host = (sessionId: string, participantId: string): TokenPayload => ({
  sessionId,
  participantId,
  role: 'host',
})

function lectureFrames(sock: Fake): (string | null)[] {
  const out: (string | null)[] = []
  for (const m of sock.heard) if (m.t === 'lecture') out.push(m.state ? m.state.file : null)
  return out
}

test('switching the document mid-lecture is one new lecture, not "the lecture is over" first', () => {
  const id = room()
  makeFile(id, 'первая.pdf', '%PDF-1.4')
  makeFile(id, 'вторая.pdf', '%PDF-1.4')
  const hall = socket()
  handleControlSocket(hall.ws, id, host(id, 'p_2'))
  dispatch(hall.ws, id, host(id, 'p_1'), { t: 'lecture:start', file: 'первая.pdf' })
  hall.heard.length = 0

  dispatch(hall.ws, id, host(id, 'p_1'), { t: 'lecture:start', file: 'вторая.pdf' })
  assert.deepEqual(
    lectureFrames(hall),
    ['вторая.pdf'],
    'the room heard the lecture end before the new one began',
  )
  // The old lecture's ink and inventory are still cleared for everyone.
  assert.ok(hall.heard.some((m) => m.t === 'ink' && m.strokes.length === 0))
  assert.ok(hall.heard.some((m) => m.t === 'ink:pages' && m.pages.length === 0))

  // Ending is still ending: the room hears `null`.
  hall.heard.length = 0
  dispatch(hall.ws, id, host(id, 'p_1'), { t: 'lecture:stop' })
  assert.deepEqual(lectureFrames(hall), [null])

  clearInk(id)
  stopLecture(id)
  closeControlRoom(id)
})

test('closing the document on the shared screen still ends the lecture out loud', () => {
  const id = room()
  makeFile(id, 'первая.pdf', '%PDF-1.4')
  makeFile(id, 'конспект.md', '# hi')
  startLecture(id, { file: 'первая.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  const hall = socket()
  handleControlSocket(hall.ws, id, host(id, 'p_2'))
  hall.heard.length = 0
  dispatch(hall.ws, id, host(id, 'p_1'), { t: 'board:close' })
  assert.deepEqual(lectureFrames(hall), [null], 'removing the board no longer ends the lecture')
  closeControlRoom(id)
})

/* ------------------------------------------------------------- clicker */

test('a clicker\'s keys: F5 is caught, the black-screen keys blank, Escape takes two presses', () => {
  assert.equal(isClickerReload({ key: 'F5' }), true)
  assert.equal(isClickerReload({ key: 'r' }), false)
  for (const code of ['KeyB', 'KeyW', 'Period', 'Comma']) {
    assert.ok(BLANK_KEYS.has(code), `${code} no longer blanks the screen`)
  }
  assert.ok(ESCAPE_AGAIN_MS >= 800 && ESCAPE_AGAIN_MS <= 3000)

  const screen = code('web/src/screens/SessionScreen.svelte')
  // One Escape no longer closes the projection.
  assert.doesNotMatch(screen, /if \(event\.key === 'Escape'\) fromProjection\(\)/)
  assert.match(screen, /if \(escapeOnce\) \{/)
  assert.match(screen, /isClickerReload\(event\)/)
  assert.match(screen, /'beforeunload'/)
  for (const name of ['LectureView', 'ConsoleView']) {
    const source = code(`web/src/components/lecture/${name}.svelte`)
    assert.match(source, /BLANK_KEYS\.has\(event\.code\)/, `${name} blanks only on B again`)
  }
})

/* ------------------------------------------------------ the browser half */

function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  // Markup without comments: an explanation is not a promise.
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('the rail swipe runs along the rail: vertical on the side, horizontal at the bottom', () => {
  const pult = code('web/src/components/lecture/ConsoleView.svelte')
  const side = pult.slice(pult.indexOf('{#snippet sideRail()}'))
  const bottom = pult.slice(pult.indexOf('{#snippet bottomRail()}'))
  assert.match(side.slice(0, 400), /use:swipe=\{\(\) => 'y'\}/, 'the side rail swipes across its 72 px again')
  assert.match(bottom.slice(0, 400), /use:swipe=\{\(\) => 'x'\}/, 'the bottom rail swipes across its 64 px again')
  const min = Number(/const SWIPE_MIN = (\d+)/.exec(pult)?.[1])
  assert.ok(min > 0 && min < 64, `a ${min} px threshold does not fit inside a 64 px rail`)
  // A finished swipe does not eat the next tap: a moved finger lifts without a
  // click, and the flag must not wait for a Pencil tap on "Next" to clear.
  const down = pult.slice(pult.indexOf('const down = (event: PointerEvent)'))
  assert.match(down.slice(0, 200), /if \(start === null\) moved = false/)
  assert.match(pult, /performance\.now\(\) - liftedAt > 500/)
})

test('"next" has a place in every view, and nothing lies on the sheet', () => {
  const pult = code('web/src/components/lecture/ConsoleView.svelte')
  // Landscape: the reading strip under the slide holds the next thumbnail,
  // and the notes column says it in words; portrait: the dock's footer; the
  // prompter: its bottom bar.
  const strip = pult.slice(pult.indexOf('{#snippet readingStrip()}'))
  assert.match(strip.slice(0, strip.indexOf('{/snippet}')), /data-pult-next/)
  assert.match(pult, /\{@render nextFooter\('column'\)\}/)
  assert.match(pult, /\{@render nextFooter\('dock'\)\}/)
  const tele = pult.slice(pult.indexOf('{#snippet teleBody()}'))
  assert.match(tele.slice(0, tele.indexOf('{/snippet}')), /data-pult-next/)
  // The strip's height is a constant of the window, not "what the slide left":
  // that would feed back into the slide's own fit.
  assert.match(pult, /const stripH = \$derived\(box\.h >= 1000 \? \d+ : box\.h >= 800 \? \d+ : \d+\)/)
  // The notes are a column beside the paper, never a sheet over it.
  assert.doesNotMatch(pult, /notesSheetH|\{#snippet notesSheet\(\)\}|\{#snippet peek\(\)\}/)
  // Nor is "Fullscreen" on the sheet any more: it sat on the peek and in the armrest.
  const sheet = pult.slice(pult.indexOf('{#snippet sheet()}'))
  assert.doesNotMatch(sheet.slice(0, sheet.indexOf('{/snippet}')), /toggleFullscreen/)
})

test('the rail always fits: the turn keys sit in a footer that does not shrink', () => {
  const pult = code('web/src/components/lecture/ConsoleView.svelte')
  const side = pult.slice(pult.indexOf('{#snippet sideRail()}'))
  const body = side.slice(0, side.indexOf('{/snippet}'))
  // A clipping middle and a footer that keeps "Back" and "Next".
  assert.match(body, /<div class="flex min-h-0 flex-1 flex-col overflow-hidden">/)
  const footer = body.slice(body.indexOf('<div class="flex shrink-0 flex-col">'))
  assert.match(footer, /\{@render turnKeys\(/)
  // The rail measures itself along its length and gives way in steps.
  assert.match(pult, /const along = portrait \? box\.w : box\.h/)
  assert.match(pult, /return along >= 690 \? 'compact' : 'tight'/)
  // "More" is reachable without opening the notes.
  assert.match(body, /\{@render moreKey\(/)
  // The fader's targets are a finger tall, whatever the bars are.
  assert.match(pult, /kind === 'rail' \? 'h-11 w-\[22px\]' : kind === 'flat' \? 'h-11 w-\[17px\]'/)
})

test('the ink follows the picture on the sheet, not the page number', () => {
  const sheet = code('web/src/components/lecture/LecturePage.svelte')
  assert.match(sheet, /onshown\?: \(page: number \| null\) => void/)
  // Reported only after the picture is on the visible canvas.
  const paint = sheet.indexOf('paint.drawImage(buffer, 0, 0)')
  assert.ok(paint > 0)
  assert.match(sheet, /if \(done && !dropped\) show\(index\)/)
  for (const name of ['LectureView', 'ConsoleView']) {
    const source = code(`web/src/components/lecture/${name}.svelte`)
    assert.match(source, /page=\{shown \?\? (page|wanted)\}/, `${name} paints the ink by the number again`)
    assert.match(source, /\{onshown\}/)
  }
})

test('blanking darkens the students\' screens, and the projection shows the hall no words', () => {
  const view = code('web/src/components/lecture/LectureView.svelte')
  assert.match(view, /const hidden = \$derived\(lecture\.blank && role === 'audience' && !host\)/)
  // The projection's blank screen: the word is for screen readers only.
  const projection = view.slice(view.indexOf("{#if role === 'projection'}"))
  const blank = projection.slice(0, projection.indexOf('{:else if failure}'))
  assert.match(blank, /class="sr-only">\{tr\('room\.ui\.276'\)\}/)
  // The setup hint fades out and never stands on a blank screen.
  assert.match(projection, /!full && fullscreenPossible\(\) && !lecture\.blank/)
  assert.match(projection, /hintUp/)
})
