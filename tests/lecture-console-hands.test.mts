/**
 * The console's hands on the zoom, the palm guard and the palettes: what a
 * review of the lecture console v4 found the console doing in class, and
 * what it does now.
 *
 *  • A page turn during a pinch zoomed the NEXT slide to the old one's spot,
 *    on the console and in the hall: the ink layer ends the pinch as final
 *    when its input goes away, and the console labelled that view with the
 *    page it had already turned to (`onzoom`, `steady`).
 *  • After a reconnect the console compared its view with the echo heard
 *    before the drop, not with the welcome's word, and settled a debt it
 *    still owed; and "0" or "Whole slide" could not take back a hall zoom the
 *    console did not hold itself (`zoomStale`, `aimZoom`, `keyZoom`). The key
 *    then took the round trip of its own frame for such a divergence, and
 *    read the old zoom after "Whole slide" (`zoomAwaited`).
 *  • A deck switched on page 1 kept the old deck's zoom on the console.
 *  • A pinch started the 600 ms palm window, and the thumb's next tap on the
 *    rail was swallowed; so did the first finger of a pinch, forgotten as the
 *    second one landed (`onbusy`'s kind, ink.ts · `BusyKind`).
 *  • The prompter showed the whole slide as "the slide on the projector"
 *    while the hall was magnified, with no way back to the whole slide but a
 *    keyboard.
 *  • In portrait a tap on a palette's lower edge went through to the ribbon
 *    chip hidden under it (film.ts · `uncovered`, `paletteGuard`).
 *
 * The geometry is pure and walked here; the console's wiring lives in the
 * component and is pinned by its source, as in lecture-console-sheets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uncovered } from '../web/src/components/lecture/film.js'

function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  // Without comments: an explanation is not a promise.
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const PULT = code('web/src/components/lecture/ConsoleView.svelte')
const INK = code('web/src/components/lecture/InkLayer.svelte')

/** A function's body, from its signature to its closing brace at the script's indentation. */
function body(source: string, signature: string): string {
  const from = source.indexOf(signature)
  assert.ok(from >= 0, `${signature} is gone`)
  const rest = source.slice(from)
  return rest.slice(0, rest.indexOf('\n  }\n'))
}

/** A snippet's markup, from its head to its `{/snippet}`. */
function snippet(head: string): string {
  const from = PULT.indexOf(head)
  assert.ok(from >= 0, `${head} is gone`)
  const rest = PULT.slice(from)
  return rest.slice(0, rest.indexOf('{/snippet}'))
}

/* ------------------------------------------------------ a turn mid-pinch */

test('a zoom report about a page being left is dropped: a turn mid-pinch leaves the next slide whole', () => {
  const onzoom = body(PULT, 'function onzoom(next: LectureZoom | null, final: boolean): void {')
  const drop = onzoom.indexOf('if (!steady) {')
  const page = onzoom.indexOf('const page = wanted')
  const target = onzoom.indexOf('zoomTarget = { page, zoom: next }')
  const send = onzoom.indexOf('sendZoom(page, next, final)')
  assert.ok(drop > 0, 'the console takes every report as the page it turned to')
  assert.ok(page > drop && target > drop && send > drop, 'a report is labelled and sent before the check')
  // A pinch that was moving stops being one, or the next frame of the magnifier would jump.
  const dropped = onzoom.slice(drop, onzoom.indexOf('}', drop))
  assert.match(dropped, /if \(final\) pinching = false/)
  // "Steady": the picture under the fingers is the page the console is on, and no "＋ Лист" is moving it.
  assert.match(PULT, /const steady = \$derived\(sheetReady && !adding\)/)
  assert.match(PULT, /const sheetReady = \$derived\(shown === wanted\)/)
})

/* ------------------------------------------------- the zoom owed after a drop */

test('after a reconnect the owed zoom is settled against the welcome, not the echo from before the drop', () => {
  // The frame in hand when the control socket opens is the stale one.
  assert.match(PULT, /if \(up && !controlWas\) \{\s+zoomStale = lecture/)
  const watch = PULT.indexOf('if (up && !controlWas) {')
  const settle = PULT.indexOf('frame === zoomStale')
  assert.ok(watch > 0 && settle > watch, 'the debt is settled before the stale frame is known')
  assert.match(PULT, /const frame = lecture\s+if \(!zoomOwed \|\| !leading \|\| offline \|\| lecture\?\.page !== wanted \|\| frame === zoomStale\) return/)
  // What that rests on: the store says the socket is open before it reads the
  // welcome, and the welcome always carries the lecture.
  const store = code('web/src/lib/session.svelte.ts')
  const open = store.slice(store.indexOf('socket.onopen = () => {'))
  assert.match(open.slice(0, 200), /this\.controlConnected = true/)
  assert.match(store, /this\.lecture = message\.state/)
  const server = code('server/src/control.ts')
  assert.match(server, /const lecture = lectureOf\(sessionId\)\s+send\(ws, \{ t: 'lecture', state: lecture \}\)/)
})

test('"0" and "Whole slide" take back a hall zoom the console does not hold', () => {
  const aim = body(PULT, 'function aimZoom(next: LectureZoom | null): void {')
  assert.match(aim, /if \(sameZoom\(next, zoomShownTarget\) && sameZoom\(next, hallZoom\)\) return/)
  // The key reads the hall's zoom while the console's own view is whole (not offline: the word is stale then;
  // nor while the hall has yet to hear what the console last said of this page, see below).
  assert.match(
    PULT,
    /const keyZoom = \$derived\(\s+zoomShownTarget \?\? \(leading && !offline && zoomAwaited\?\.page !== wanted \? hallZoom : null\),\s+\)/,
  )
  assert.match(PULT, /const zoomed = \$derived\(keyZoom !== null\)/)
  const key = snippet('{#snippet zoomKey(size: string, column: boolean)}')
  assert.match(key, /\{#if zoomed\}/)
  assert.match(key, /zoomTimes\(keyZoom\?\.z \?\? 1\)/)
  // "0" goes through `aimZoom` from anywhere, the prompter included.
  const keys = body(PULT, 'function onkeydown(event: KeyboardEvent): void {')
  const zero = keys.slice(keys.indexOf("event.code === 'Digit0'"))
  assert.match(zero.slice(0, zero.indexOf('} else if')), /^[^]*?event\.preventDefault\(\)\s+aimZoom\(null\)/)
})

/*
 * The review's recheck of B5: the key fell back to the hall's word whenever
 * the console's own view was whole, and for the round trip after "Whole
 * slide" (or a pinch back to it) that word was the old zoom. The key kept
 * offering "×2 / Whole slide" for the press just made, and a tap in that
 * moment meant to arm the magnifier took the hall to the whole slide instead.
 */
test('the key does not take the round trip of the console’s own frame for a divergence', () => {
  const send = body(PULT, 'function sendZoom(page: number, zoom: LectureZoom | null, final: boolean): void {')
  // Awaited from the moment a frame really goes out, the throttled ones included; not offline.
  assert.match(send, /if \(session\.zoomTo\(due\.page, due\.zoom, false\)\) zoomAwaited = due/)
  assert.match(send, /if \(session\.zoomTo\(page, zoom, final\)\) zoomAwaited = \{ page, zoom \}/)
  assert.equal(send.split('session.zoomTo(').length - 1, 2, 'a frame goes out unawaited')
  // Until the hall's word for that page agrees with it, the echo or a word it already had.
  assert.match(
    PULT,
    /const heard = session\.zoomNow\s+const said = zoomAwaited\s+if \(said === null \|\| heard === null \|\| heard\.page !== said\.page \|\| !sameZoom\(heard\.zoom, said\.zoom\)\) return\s+untrack\(\(\) => \(zoomAwaited = null\)\)/,
  )
  // And wherever the hall's word starts afresh: a turn, another deck, a take-over, a reconnect.
  const turn = PULT.slice(PULT.indexOf('const at = wanted\n    untrack(() => {\n      if (zoomTarget !== null'))
  assert.match(turn.slice(0, turn.indexOf('})')), /zoomAwaited = null/)
  const deck = PULT.slice(PULT.indexOf('if (deck === zoomDeck) return'))
  assert.match(deck.slice(0, deck.indexOf('})')), /zoomAwaited = null/)
  const adopt = PULT.slice(PULT.indexOf('if (now && !ledBefore) {'))
  assert.match(adopt.slice(0, adopt.indexOf('\n      }')), /zoomAwaited = null/)
  assert.match(PULT, /if \(up && !controlWas\) \{\s+zoomStale = lecture\n[^}]*zoomAwaited = null\s+\}/)
  assert.match(PULT, /let zoomAwaited = \$state\.raw<\{ page: number; zoom: LectureZoom \| null \} \| null>\(null\)/)
})

/* -------------------------------------------------- another deck, page 1 */

test('another document or another lecture starts at the whole page, before the take-over adopts the hall', () => {
  const deck = PULT.indexOf("const deck = `${file ?? ''}\\n${lecture?.startedAt ?? ''}`")
  assert.ok(deck > 0, 'the zoom target outlives the deck it was made on')
  const reset = PULT.slice(deck, PULT.indexOf('})', deck))
  assert.match(reset, /zoomTarget = null/)
  assert.match(reset, /pinching = false/)
  assert.match(reset, /zoomDue = null/)
  // Declared before the take-over's adoption: on opening the console mid-lecture both run, in this order.
  const adopt = PULT.indexOf('if (now && !ledBefore) {')
  assert.ok(adopt > deck, 'the deck reset runs after the take-over adopted the hall\'s view')
})

/* ------------------------------------------------- the "More" row when dark */

test('the "More" magnifier row is never dark while it is the way back to the whole slide', () => {
  const pane = snippet('{#snippet panes()}')
  const at = pane.indexOf('{#if (leading || preparing) && (tele ? zoomed : !zoomOnRail)}')
  assert.ok(at >= 0, 'the row is not offered in the prompter while zoomed')
  const row = pane.slice(at)
  const button = row.slice(0, row.indexOf('</button>'))
  assert.match(button, /disabled=\{failure && !zoomed\}/)
  assert.match(button, /zoomTimes\(keyZoom\?\.z \?\? 1\)/)
})

/* --------------------------------------------------- the palm after a pinch */

/*
 * The review's recheck of B13: the console marked a spell a pinch when a zoom
 * report came inside it. On a console without a pen, or with the pointer led
 * by a finger, the first finger of a pinch holds a stroke, an erase or the
 * beam of its own, and the layer forgets it as the second finger lands: that
 * ended a spell with no report in it, and the window ran from the second
 * finger's landing. A quick pinch back to the whole slide, and the thumb's tap
 * on "Whole slide" or "Next" 150 ms later was swallowed (replayed on the real
 * layer with the console's own bookkeeping).
 */
test('only a spell of work that stood starts the palm window; a pinch and its forgotten first finger do not', () => {
  const busy = body(PULT, 'function onbusy(next: boolean, kind?: BusyKind): void {')
  assert.match(busy, /if \(kind !== 'gesture'\) lastBusyAt = performance\.now\(\)/)
  assert.match(busy, /if \(next\) \{[^]*?palette = null\s+return/)
  assert.doesNotMatch(PULT, /pinchSpell/, 'the console reads the kind of a spell from the order of the layer’s calls again')
  assert.match(PULT, /\{onbusy\}/)
  // The layer tells how a spell ended.
  assert.match(INK, /onbusy\?: \(busy: boolean, kind\?: BusyKind\) => void/)
  const sync = body(INK, "function syncBusy(ended: BusyKind = 'ink'): void {")
  assert.match(sync, /if \(next\) onbusy\?\.\(true\)\s+else onbusy\?\.\(false, ended\)/)
  assert.match(sync, /pinch\?\.committed === true/)
  // As a gesture: wherever a finger's work is made never to have happened, and where a pinch ends.
  for (const [signature, ends] of [
    ['function forgetUnsent(): void {', "syncBusy('gesture')"],
    ['function takeBack(): void {', "syncBusy('gesture')"],
    ['function dropBeam(): void {', "syncBusy('gesture')"],
    ['function forgetErase(): void {', "stopErase('gesture')"],
    ['function commitPinch(held: Pinch): void {', "syncBusy('gesture')"],
    ['function palmPinch(held: Pinch): void {', "syncBusy('gesture')"],
    ['function endPinch(): void {', "syncBusy('gesture')"],
  ]) {
    assert.ok(body(INK, signature).includes(ends), `${signature} ends its spell as work that stood`)
  }
  assert.match(body(INK, "function stopErase(ended: BusyKind = 'ink'): void {"), /syncBusy\(ended\)/)
  assert.match(body(INK, "function cancelFrame(ended: BusyKind = 'ink'): void {"), /syncBusy\(ended\)/)
  // A second finger cancelling a finger's frame, and a page turn ending a pinch, are gestures too.
  assert.match(INK, /if \(framing\?\.byFinger && event\.pointerType === 'touch'\) \{\s+cancelFrame\('gesture'\)/)
  assert.match(INK, /if \(held\.committed\) onzoom\?\.\(null, true\)\s+syncBusy\('gesture'\)/)
  // What stood ends as ink, by default: a stroke closed, a sweep or a beam let go, a frame drawn.
  assert.match(body(INK, 'function closeStroke(): void {'), /syncBusy\(\)/)
  assert.match(body(INK, 'function beamOff(end?: { x: number; y: number; t: number }): void {'), /syncBusy\(\)/)
  assert.match(body(INK, 'function frameEnd(event: PointerEvent, cancelled: boolean): void {'), /syncBusy\(\)/)
})

/* ------------------------------------------------------------- prompter */

test('the prompter shows the hall’s zoom, says it, and keeps a way back to the whole slide', () => {
  const thumb = snippet('{#snippet teleThumb(w: number, h: number)}')
  assert.match(thumb, /<LecturePage \{doc\} page=\{wanted\} bare zoom=\{hallZoom\} zoomHow="glide" \/>/)
  const line = snippet('{#snippet teleHallZoom()}')
  assert.match(line, /\{#if hallZoom !== null\}/)
  assert.match(line, /tr\('room\.pult4\.hallSees', \{ n: zoomTimes\(hallZoom\.z\) \}\)/)
  // Under the picture in both layouts of the prompter.
  const tele = snippet('{#snippet teleBody()}')
  assert.equal(tele.split('{@render teleHallZoom()}').length - 1, 2)
  // Its "More" row only ever takes the zoom away: there is no sheet to frame on.
  const press = body(PULT, 'function pressZoom(): void {')
  assert.match(press, /if \(zoomed \|\| tele\) \{\s+aimZoom\(null\)/)
})

/* ------------------------------------------------------------- palettes */

/** A 304 px pen palette, 314 px tall, opened over the portrait dock at 834×1194 (rail at 1130). */
const CARD = { left: 120, top: 804, right: 424, bottom: 1118 }

test('a palette card off the sheet takes the touch over its whole body and the gap down to the rail', () => {
  // A 16:9 deck: the sheet box ends at 576, the card lies wholly over the dock.
  assert.deepEqual(uncovered(CARD, { left: 0, top: 0, right: 834, bottom: 576 }, 12), [
    { left: 0, top: 0, right: 304, bottom: 326 },
  ])
  // An A4 deck: the sheet box reaches 902, over the card's top; that part stays the sheet's.
  assert.deepEqual(uncovered(CARD, { left: 0, top: 0, right: 834, bottom: 902 }, 12), [
    { left: 0, top: 98, right: 304, bottom: 326 },
  ])
  // Nothing measured: the whole card.
  assert.deepEqual(uncovered(CARD, null), [{ left: 0, top: 0, right: 304, bottom: 314 }])
})

test('a palette card on the sheet lets the pen through, and only its overhang is guarded', () => {
  // Landscape 1180×820: the pen palette beside the rail, over the sheet box.
  const card = { left: 84, top: 116, right: 388, bottom: 430 }
  assert.deepEqual(uncovered(card, { left: 72, top: 0, right: 800, bottom: 660 }), [])
  // A short window: the card overhangs the reading strip under the sheet box.
  assert.deepEqual(uncovered(card, { left: 72, top: 0, right: 800, bottom: 400 }), [
    { left: 0, top: 284, right: 304, bottom: 314 },
  ])
  // A narrow sheet box with the notes column beside it: the card's right part is over the notes.
  assert.deepEqual(uncovered(card, { left: 72, top: 0, right: 360, bottom: 660 }), [
    { left: 276, top: 0, right: 304, bottom: 314 },
  ])
  // Left-handed: the rail on the right, the notes column on the left.
  assert.deepEqual(uncovered({ left: 500, top: 100, right: 804, bottom: 400 }, { left: 520, top: 0, right: 1100, bottom: 700 }), [
    { left: 0, top: 0, right: 20, bottom: 300 },
  ])
})

test('the console lays the guard under the palette’s chips, where the card is not over the sheet', () => {
  assert.match(
    PULT,
    /const paletteGuard = \$derived\(\s+palettePlace === null\s+\? \[\]\s+: uncovered\(palettePlace\.card, anchor\?\.sheet \?\? null, portrait \? PALETTE_GAP : 0\),\s+\)/,
  )
  // The sheet is measured with the key, the rail and the frame.
  assert.match(PULT, /const sheet = frame\?\.querySelector\('\.pult-sheet'\) \?\? null/)
  // One set of numbers places the card and its guard.
  assert.match(PULT, /const paletteStyle = \$derived\(palettePlace\?\.style \?\? ''\)/)
  const from = PULT.indexOf('data-pult-palette\n')
  assert.ok(from >= 0, 'the palette wrapper is gone')
  const wrap = PULT.slice(from)
  const palette = wrap.slice(0, wrap.indexOf('{/if}'))
  assert.match(palette, /<ToolPalette/)
  const laid = palette.indexOf('{#each paletteGuard as part')
  assert.ok(laid >= 0, 'the guard is not laid')
  const guard = palette.slice(laid)
  // Under the chips (they stay pressable), taking the touch itself, and silent.
  assert.match(guard, /class="pointer-events-auto absolute"/)
  assert.match(guard, /style=\{`z-index:-1;/)
  assert.match(guard, /aria-hidden="true"/)
  assert.doesNotMatch(guard, /onclick|onpointerdown/)
  // The card itself stays transparent where it is over the sheet.
  assert.match(PULT, /class="pointer-events-none absolute z-20"\s+style=\{paletteStyle\}\s+data-pult-palette/)
  // The guard is the card's own: the outside-tap closer leaves the palette open.
  assert.match(PULT, /!target\?\.closest\('\[data-pult-palette\], \[data-pult-tool\]'\)/)
})
