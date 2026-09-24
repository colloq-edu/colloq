/**
 * "The room is gone" — and how it differs from "the server can't be heard".
 *
 * On this difference the client does something irreversible: it wipes this
 * room's y-indexeddb database together with everything the person typed
 * offline, drops the identity and writes "This seminar has been deleted".
 * While the sign was a bare 404 code, any layer in front of the backend — a
 * relay with no frpc connected, static hosting that serves index.html for
 * everything, a wrong upstream — turned a connection glitch into wiping the
 * cache for the whole class at once.
 *
 * It is checked here, not in the browser, precisely because it fails
 * silently: from the screen's point of view both branches look like "the
 * server answered 404".
 */
import { test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
import assert from 'node:assert/strict'
import { SESSION_MISSING, saysSessionMissing } from '../shared/protocol.js'
import { ApiError, statusMessage } from '../web/src/lib/api.js'

test('the server said it in words — the room really is gone', () => {
  assert.equal(saysSessionMissing(new ApiError(SESSION_MISSING, 404)), true)
})

test('a foreign 404 without a body is a lost connection, not a verdict on the room', () => {
  /*
   * This is how api.ts builds it when there is no body or it is not JSON: the
   * relay serves its own page, HTTP/2 carries no status line, and what reaches
   * the screen is "Not found (404)".
   */
  try {
    for (const [locale, expected] of [
      ['ru', 'Не найдено (404)'],
      ['en', 'Not found (404)'],
    ] as const) {
      setLocaleResolver(() => locale)
      const proxied = new ApiError(
        statusMessage({ status: 404, statusText: 'Not Found' } as Response),
        404,
      )
      assert.equal(proxied.message, expected)
      assert.equal(saysSessionMissing(proxied), false)
    }
  } finally {
    setLocaleResolver(() => 'ru')
  }
})

test('foreign words with our code do not count either', () => {
  for (const words of ['Not Found', 'session gone', 'not found', '', 'SESSION NOT FOUND']) {
    assert.equal(saysSessionMissing(new ApiError(words, 404)), false, words)
  }
})

test('our words with a foreign code count even less', () => {
  for (const status of [0, 400, 403, 410, 500, 502, 503]) {
    assert.equal(saysSessionMissing(new ApiError(SESSION_MISSING, status)), false, String(status))
  }
})

test('the network dropped — ApiError with code 0, and the room is intact', () => {
  const offline = new ApiError(
    'Could not reach the server — check the connection and try again.',
    0,
  )
  assert.equal(saysSessionMissing(offline), false)
})

test('anything else does not break the check', () => {
  for (const value of [null, undefined, 'session not found', 404, {}, new Error('boom'), []]) {
    assert.equal(saysSessionMissing(value), false, String(value))
  }
})

test('the refusal string is one for the server and the client', () => {
  // Exactly the one the routes put in the body: if they diverged, the client
  // would stop recognizing a deleted room and would spin "Reconnecting"
  // forever.
  assert.equal(SESSION_MISSING, 'session not found')
})
