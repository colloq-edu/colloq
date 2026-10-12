/**
 * The console's own turns and the echoes of them (ConsoleView · the
 * convergence effect and `goTo`; walk.ts · `askTurn`, `hearTurn`).
 *
 * The console moves its sheet the moment a key is pressed and tells the
 * server; the server's `lecture` frames then come back one per request that
 * moved it, in order. A frame for a page the console asked for is its own
 * echo; a frame for any other page is someone else's move, and the console
 * follows it at once. The list of asked turns is what tells the two apart.
 *
 * It used to be an unordered set, cleared whenever the server arrived at the
 * console's page. "Next, Next, Back" (7, 8, 7) faster than a round trip then
 * emptied it on the first echo of 7, the echo of 8 behind it read as
 * someone else's move, and the console jumped to 8 and back after the hand
 * had stopped: the sheet menu closed, the zoom was reset, a stroke begun in
 * between was cut. The list is in order now: an echo settles every request
 * up to the first one for its page, and nothing else empties it but a move
 * no request names, a give-up, or age.
 *
 * The decisions are walked here with the real helpers, the way the effect
 * takes them; the effect itself is pinned by its source at the end, as in
 * lecture-console-sheets: it lives in the component, and a quiet edit would
 * bring the replay back.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ASKED_FOR_MS, askTurn, hearTurn, type AskedTurn } from '../web/src/components/lecture/walk.js'

/* ------------------------------------------------------------ the list */

test('an echo settles the requests up to the first one for its page, and counts as ours', () => {
  let asked: AskedTurn[] = []
  asked = askTurn(asked, 7, 0)
  asked = askTurn(asked, 8, 10)
  asked = askTurn(asked, 7, 20)
  const first = hearTurn(asked, 7, 100)
  assert.equal(first.ours, true)
  assert.deepEqual(
    first.left.map((turn) => turn.page),
    [8, 7],
  )
  const second = hearTurn(first.left, 8, 120)
  assert.equal(second.ours, true)
  const third = hearTurn(second.left, 7, 140)
  assert.equal(third.ours, true)
  assert.deepEqual(third.left, [])
})

test('a move no request names is someone else’s, and nothing is waited for after it', () => {
  const asked = askTurn(askTurn([], 7, 0), 8, 10)
  const move = hearTurn(asked, 12, 50)
  assert.equal(move.ours, false)
  assert.deepEqual(move.left, [])
})

test('a repeat is the request it repeats: one echo settles both', () => {
  let asked = askTurn([], 6, 0)
  // The convergence resends the page every 600 ms while the hall lags.
  asked = askTurn(asked, 6, 600)
  asked = askTurn(asked, 6, 1200)
  assert.deepEqual(asked, [{ page: 6, at: 1200 }])
  // Of the three, only the first to reach the server moved it: one echo.
  assert.deepEqual(hearTurn(asked, 6, 1250).left, [])
  // A repeat of something else than the last request is a request of its own.
  assert.deepEqual(
    askTurn(askTurn([], 6, 0), 7, 10).map((turn) => turn.page),
    [6, 7],
  )
})

test('a request nobody answered is forgotten past the console’s repeats', () => {
  // Five repeats 600 ms apart, then the console gives up: the horizon is past that.
  assert.ok(ASKED_FOR_MS > 6 * 600, `${ASKED_FOR_MS} ms is not past the repeats`)
  assert.ok(ASKED_FOR_MS <= 5000, `${ASKED_FOR_MS} ms keeps a lost request too long`)
  const lost = askTurn([], 6, 0)
  assert.equal(hearTurn(lost, 6, ASKED_FOR_MS).ours, true)
  assert.equal(hearTurn(lost, 6, ASKED_FOR_MS + 1).ours, false)
})

/* ------------------------------------------------ the console, walked */

/**
 * The convergence effect and `goTo`, reduced to their decisions, over a
 * server that takes the requests in order and stays silent when already on
 * the page (lecture.ts · `turnTo`). The branches are the effect's: the
 * server on our page settles; a move that is not our echo is followed; our
 * echo of an earlier press is waited past (the 600 ms repeat sends `wanted`
 * again, and is remembered like a press).
 */
function hall(start: number) {
  const state = {
    wanted: start,
    seen: start as number | null,
    at: start,
    server: start,
    asked: [] as AskedTurn[],
    online: true,
    now: 0,
    wire: [] as number[],
    followed: [] as number[],
  }
  const effect = (): void => {
    const changed = state.seen !== null && state.seen !== state.at
    state.seen = state.at
    let ours = false
    if (changed) {
      const echo = hearTurn(state.asked, state.at, state.now)
      state.asked = echo.left
      ours = echo.ours
    }
    if (state.at === state.wanted) return
    if (changed && !ours) {
      state.followed.push(state.at)
      state.wanted = state.at
    }
  }
  return {
    state,
    press(target: number): void {
      if (target === state.wanted) return
      state.wanted = target
      if (state.online) {
        state.asked = askTurn(state.asked, target, state.now)
        state.wire.push(target)
      }
      effect()
    },
    repeat(): void {
      if (!state.online || state.at === state.wanted) return
      state.asked = askTurn(state.asked, state.wanted, state.now)
      state.wire.push(state.wanted)
    },
    /** The server reads the next request and, if it moved, echoes it. */
    serve(): void {
      const page = state.wire.shift()
      if (page === undefined || page === state.server) return
      state.server = page
      state.at = page
      effect()
    },
    serveAll(): void {
      while (state.wire.length > 0) this.serve()
    },
    /** Someone else (the laptop bar, a clicker) turns the hall. */
    elsewhere(page: number): void {
      state.server = page
      state.at = page
      effect()
    },
    tick(ms: number): void {
      state.now += ms
    },
  }
}

test('Next, Next, Back faster than a round trip: no echo reads as someone else’s move', () => {
  const pult = hall(6)
  pult.press(7)
  pult.press(8)
  pult.press(7)
  pult.tick(150)
  pult.serveAll()
  assert.deepEqual(pult.state.followed, [], 'the console replayed the walk after the hand stopped')
  assert.equal(pult.state.wanted, 7)
  assert.equal(pult.state.server, 7)
  assert.deepEqual(pult.state.asked, [])
})

test('5 → 6 → 5 → 6 faster than a round trip: the console stays where the hand left it', () => {
  const pult = hall(5)
  pult.press(6)
  pult.press(5)
  pult.press(6)
  pult.tick(150)
  pult.serveAll()
  assert.deepEqual(pult.state.followed, [])
  assert.equal(pult.state.wanted, 6)
  assert.equal(pult.state.server, 6)
})

test('Back, Back, Next, Next back to the hall’s page: the four echoes are all ours', () => {
  const pult = hall(10)
  pult.press(9)
  pult.press(8)
  pult.press(9)
  pult.press(10)
  pult.tick(150)
  pult.serveAll()
  assert.deepEqual(pult.state.followed, [])
  assert.equal(pult.state.wanted, 10)
})

test('a page pressed offline goes out with the repeat, and its echo is ours even after the next press', () => {
  const pult = hall(5)
  pult.state.online = false
  pult.press(6)
  pult.state.online = true
  pult.tick(600)
  pult.repeat()
  // The hand presses on before the repeat's echo is back.
  pult.press(7)
  pult.tick(150)
  pult.serveAll()
  assert.deepEqual(pult.state.followed, [], 'the echo of the repeated page took the console back')
  assert.equal(pult.state.wanted, 7)
})

test('a request lost with the connection does not pass a later clicker turn off as ours', () => {
  const pult = hall(5)
  pult.press(6)
  // The socket dies before the server reads it; Back is pressed offline.
  pult.state.wire.length = 0
  pult.state.online = false
  pult.press(5)
  pult.state.online = true
  pult.tick(ASKED_FOR_MS + 500)
  // The laptop's clicker turns the hall to that very page.
  pult.elsewhere(6)
  assert.deepEqual(pult.state.followed, [6], 'the console took the clicker for its own echo and will pull the hall back')
  assert.equal(pult.state.wanted, 6)
})

test('someone else’s move is followed at once, and the server’s own (a new sheet) is too', () => {
  const pult = hall(14)
  pult.elsewhere(15)
  assert.deepEqual(pult.state.followed, [15])
  // "＋ Лист": the server names the sheet and turns the hall to it.
  pult.elsewhere(-3)
  assert.deepEqual(pult.state.followed, [15, -3])
})

/* ------------------------------------------------------ the effect */

function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  // Without comments: an explanation is not a promise.
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const PULT = code('web/src/components/lecture/ConsoleView.svelte')
const converge = PULT.slice(PULT.indexOf('const { moved, ours } = untrack(() => {'))
const effect = converge.slice(0, converge.indexOf('function goTo('))

test('only an echo takes requests off the list, never the hand coming back to the hall’s page', () => {
  assert.ok(effect.length > 0, 'the convergence effect is gone')
  // The server's page changed: the echo is heard against the list, in order.
  const heard = effect.slice(0, effect.indexOf('if (at === null) {'))
  assert.match(heard, /if \(!changed \|\| at === null\) return \{ moved: changed, ours: false \}/)
  assert.match(heard, /const echo = hearTurn\(asked, at, performance\.now\(\)\)\s+asked = echo\.left/)
  // Standing where the hall is settles nothing by itself.
  const settled = effect.slice(effect.indexOf('if (at === mine) {'))
  const branch = settled.slice(0, settled.indexOf('return'))
  assert.doesNotMatch(branch, /asked = \[\]|asked\.length = 0|\.clear\(\)/)
  // Someone else's move is what the list does not name.
  assert.match(effect, /if \(moved && !ours\) \{/)
  assert.doesNotMatch(PULT, /askedPages/)
})

test('a turn is remembered as asked only when its request goes out, the repeat included', () => {
  const go = PULT.slice(PULT.indexOf('function goTo(next: number): void {'))
  const body = go.slice(0, go.indexOf('\n  }\n'))
  const sent = body.indexOf('if (leading && !offline) {')
  const asked = body.indexOf('asked = askTurn(asked, target, performance.now())')
  const send = body.indexOf("session.send({ t: 'lecture:page', page: target })")
  assert.ok(sent > 0 && asked > sent && send > asked, 'askTurn must sit with the send, inside its guard')
  assert.equal(body.split('askTurn(').length - 1, 1)
  // The 600 ms repeat sends `wanted` again, and remembers it like a press.
  const again = effect.slice(effect.indexOf('const again = window.setInterval('))
  const remember = again.indexOf('asked = askTurn(asked, mine, performance.now())')
  const resend = again.indexOf("session.send({ t: 'lecture:page', page: mine })")
  assert.ok(remember > 0 && resend > remember, 'the repeat goes out unremembered')
})
