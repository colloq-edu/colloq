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
 * Age counted the time offline too: a turn whose echo died with the socket
 * read, after an outage past four seconds, as someone else's move, and the
 * pages pressed offline were dropped. The first frame after the socket
 * reopens (the welcome) now settles everything asked before the drop, by
 * what was asked, not by when (`hearWelcome`).
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
import { ASKED_FOR_MS, askTurn, hearTurn, hearWelcome, type AskedTurn } from '../web/src/components/lecture/walk.js'

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

/*
 * The review's recheck of B11: the age rule counted the time offline. A turn
 * that reached the server just before the Wi-Fi went had its echo die with
 * the socket; back more than four seconds later, the welcome showed that very
 * page, the request had aged out, and the console took its own turn for
 * someone else's move: it followed it and dropped the pages pressed offline.
 */
test('the welcome after a drop settles what was asked before it, whatever its age', () => {
  const asked = askTurn([], 11, 0)
  const reopened = 5000
  const welcome = hearWelcome(asked, 11, reopened)
  assert.equal(welcome.ours, true, 'the console’s own last turn read as someone else’s move')
  assert.deepEqual(welcome.left, [], 'a request from before the drop is waited for after it')
  // By age alone it was foreign.
  assert.equal(hearTurn(asked, 11, reopened + 50).ours, false)
  // A page no request names is someone else's, and nothing from before the drop is waited for any more.
  assert.deepEqual(hearWelcome(askTurn(askTurn([], 11, 0), 12, 10), 15, reopened), { ours: false, left: [] })
  // Turns asked on the new socket, before the welcome, are still on their way, unless the welcome shows their page.
  let mixed = askTurn([], 11, 0)
  mixed = askTurn(mixed, 12, reopened + 10)
  mixed = askTurn(mixed, 13, reopened + 20)
  assert.deepEqual(hearWelcome(mixed, 12, reopened), { ours: true, left: [{ page: 13, at: reopened + 20 }] })
  // No lecture in the welcome: nothing is waited for.
  assert.deepEqual(hearWelcome(mixed, null, reopened), { ours: false, left: [] })
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
    /** When the control socket reopened, until the welcome is heard. */
    reopened: null as number | null,
  }
  const effect = (): void => {
    const changed = state.seen !== null && state.seen !== state.at
    state.seen = state.at
    let ours = false
    if (state.reopened !== null) {
      const welcome = hearWelcome(state.asked, state.at, state.reopened)
      state.reopened = null
      state.asked = welcome.left
      ours = welcome.ours
    } else if (changed) {
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
    /** The server reads the next request and moves, but its echo dies with the console's socket. */
    serveUnheard(): void {
      const page = state.wire.shift()
      if (page !== undefined) state.server = page
    },
    /** The control socket dies: requests not yet read are lost, presses stay on the console. */
    drop(): void {
      state.online = false
      state.wire.length = 0
    },
    /** It reopens now, and the welcome brings the server's page, changed or not. */
    reopen(): void {
      state.online = true
      state.reopened = state.now
      state.at = state.server
      effect()
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

test('a turn whose echo died with the socket is ours after a long outage, and the offline presses go out', () => {
  const pult = hall(10)
  pult.press(11)
  // The server turns to 11; the Wi-Fi drops before the echo comes back.
  pult.serveUnheard()
  pult.drop()
  // Offline, Next twice.
  pult.press(12)
  pult.press(13)
  pult.tick(5000)
  pult.reopen()
  assert.deepEqual(pult.state.followed, [], 'the console took its own turn for someone else’s and dropped 12 and 13')
  assert.equal(pult.state.wanted, 13)
  assert.deepEqual(pult.state.asked, [], 'a request from before the drop is waited for after it')
  // The repeat delivers what was pressed offline, and its echo is ours.
  pult.tick(600)
  pult.repeat()
  pult.serveAll()
  assert.deepEqual(pult.state.followed, [])
  assert.equal(pult.state.server, 13)
})

test('Back pressed offline goes out after the drop; a clicker’s turn meanwhile is still followed', () => {
  const back = hall(10)
  back.press(11)
  back.serveUnheard()
  back.drop()
  back.press(10)
  back.tick(5000)
  back.reopen()
  assert.deepEqual(back.state.followed, [])
  back.tick(600)
  back.repeat()
  back.serveAll()
  assert.equal(back.state.server, 10, 'the hall stayed on the page the console left offline')
  // While the console was away, the laptop's clicker turned the hall: that is someone else's move.
  const clicker = hall(10)
  clicker.press(11)
  clicker.serveUnheard()
  clicker.drop()
  clicker.press(12)
  clicker.state.server = 14
  clicker.tick(5000)
  clicker.reopen()
  assert.deepEqual(clicker.state.followed, [14])
  assert.equal(clicker.state.wanted, 14)
  // A request lost with the socket is settled by the welcome too: a clicker's turn to its page
  // a moment after the reconnect is someone else's, not an echo the console would pull back from.
  const lost = hall(5)
  lost.press(6)
  lost.drop()
  lost.press(5)
  lost.tick(1000)
  lost.reopen()
  lost.tick(500)
  lost.elsewhere(6)
  assert.deepEqual(lost.state.followed, [6])
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

test('the first frame after the control socket reopens settles the turns asked before the drop', () => {
  // When the socket reopens, and the frame in hand then: the next one is the welcome.
  assert.match(PULT, /if \(up && !turnSocketWas\) reopened = \{ at: performance\.now\(\), stale: lecture \}/)
  assert.match(PULT, /const frame = lecture\s+const at = frame\?\.page \?\? null/)
  // Heard before the echo rule, and in place of it: the age of a request from before the drop means nothing.
  const heard = effect.slice(0, effect.indexOf('if (at === null) {'))
  const welcome = heard.indexOf('if (reopened !== null && frame !== reopened.stale) {')
  assert.ok(welcome !== -1 && welcome < heard.indexOf('const echo = hearTurn('), 'the welcome is heard by age again')
  assert.match(
    heard,
    /const welcome = hearWelcome\(asked, at, reopened\.at\)\s+reopened = null\s+asked = welcome\.left\s+return \{ moved: changed, ours: welcome\.ours \}/,
  )
  // Declared before the convergence, so that the reopening is known when the welcome comes.
  assert.ok(PULT.indexOf('let reopened:') < PULT.indexOf('const { moved, ours } = untrack(() => {'))
})
