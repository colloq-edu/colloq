/**
 * Five hundred tabs coming back after a drop — the most expensive thing the
 * client does.
 *
 * It is not the tab that drops the connection but the wire: a server restart,
 * Wi-Fi going down in the lecture hall, the relay. From there everything
 * depends on two lines. A backoff without jitter — and five hundred tabs count
 * down the same interval from the same event: the server comes up, gets five
 * hundred handshakes in one millisecond, some of them do not make it, those
 * back off and again arrive together. A second request for the file tree on
 * entry — and on top of five hundred handshakes come five hundred folder walks
 * over HTTP for the same list that the control socket sends by itself.
 *
 * What can be checked without a browser is checked: the backoff ladder itself
 * — through the function, and the promise "we ask for the tree once" — by the
 * source, because it lives in a runes class.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLAB_BACKOFF_MIN_MS,
  COLLAB_BACKOFF_SPREAD_MS,
  collabBackoff,
  reconnectDelay,
  RECONNECT_MAX_MS,
} from '../web/src/lib/controls.js'

/* --------------------------------------------------------------- backoff */

test('the backoff doubles and runs into the old cap', () => {
  // The upper bound did not grow: jitter takes away from the backoff, it does
  // not add to it.
  assert.equal(reconnectDelay(0, 1), 500)
  assert.equal(reconnectDelay(1, 1), 1000)
  assert.equal(reconnectDelay(5, 1), RECONNECT_MAX_MS)
  assert.equal(reconnectDelay(50, 1), RECONNECT_MAX_MS, 'the ladder ends, the waiting does not')
})

test('two tabs do not come back in the same millisecond', () => {
  // Exactly what the jitter is for: the same attempt number — a different
  // time.
  assert.notEqual(reconnectDelay(3, 0.1), reconnectDelay(3, 0.9))
  // Half of the backoff is random, and both halves are bounded: nobody waits
  // longer than the cap or less than half of their step.
  for (const retries of [0, 1, 2, 3, 4, 5, 9]) {
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = reconnectDelay(retries, random)
      const step = Math.min(500 * 2 ** Math.min(retries, 5), RECONNECT_MAX_MS)
      assert.ok(delay >= step / 2, `${retries}/${random}: too early`)
      assert.ok(delay <= step, `${retries}/${random}: longer than its step`)
      assert.ok(delay <= RECONNECT_MAX_MS)
    }
  }
})

/* -------------------------------------------- one question about the tree */

/** Code without explanations: a comment is not a promise but a story about the past. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const SESSION = code(
  fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'web/src/lib/session.svelte.ts'),
    'utf8',
  ),
)

test('the room has no backoff ladder of its own left', () => {
  assert.match(SESSION, /const delay = reconnectDelay\(this\.#retries\)/)
  assert.doesNotMatch(SESSION, /Math\.min\(500 \* 2 \*\*/, 'a second copy of the ladder would drift')
})

test('the tab asks for the file tree once — and not over HTTP', () => {
  /*
   * The list arrives in the control socket's welcome batch (control.ts), and
   * from the room cache at that. An HTTP request for the same tree in the
   * constructor doubled the folder walk for every tab — with five hundred that
   * is seconds of blocking the event loop exactly when everyone is waiting to
   * come back.
   */
  assert.doesNotMatch(SESSION, /refreshFiles/)
  assert.doesNotMatch(SESSION, /api\.listFiles/)
  // But the `files` frame over the socket is still parsed — otherwise the
  // panel would be left without a tree at all.
  assert.match(SESSION, /message\.t === 'files'/)
  assert.match(SESSION, /this\.filesArrived = true/)
})

/* -------------------------------------- backoff of the shared document */

test('for the shared document, every tab has its own backoff cap', () => {
  /*
   * The y-websocket ladder is `min(2^n · 100 ms, maxBackoffTime)`, and the
   * default cap is THE SAME for everyone (2500 ms). That is, from the sixth
   * attempt on, five hundred tabs knock exactly every two and a half seconds,
   * all together, from the same event. The provider cannot do jitter in the
   * ladder itself, but it reads the cap anew on every attempt — a random cap
   * is what pulls the pack apart.
   */
  assert.equal(collabBackoff(0), COLLAB_BACKOFF_MIN_MS)
  assert.equal(collabBackoff(1), COLLAB_BACKOFF_MIN_MS + COLLAB_BACKOFF_SPREAD_MS)
  assert.notEqual(collabBackoff(0.1), collabBackoff(0.9))
  // Waiting longer is the price, and it is bounded on both sides: no earlier
  // than the old two and a half seconds and no longer than ten.
  for (const random of [0, 0.2, 0.5, 0.8, 1]) {
    const wait = collabBackoff(random)
    assert.ok(wait >= 2500, `${random}: they come back earlier than before`)
    assert.ok(wait <= COLLAB_BACKOFF_MIN_MS + COLLAB_BACKOFF_SPREAD_MS, `${random}: they wait too long`)
  }
  // Wider than the window in which the server accepts a pack of handshakes:
  // otherwise the jitter pulls nothing apart.
  assert.ok(COLLAB_BACKOFF_SPREAD_MS >= 5000)
})

test('the shared document provider is created with this cap, not its own', () => {
  assert.match(SESSION, /maxBackoffTime: collabBackoff\(\)/)
  // And no second copy of the ladder is set up: there is one rule and it lives
  // in controls.ts.
  assert.doesNotMatch(SESSION, /maxBackoffTime: \d/, 'the cap is nailed to a number — it is shared again')
})
