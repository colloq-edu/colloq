/**
 * The rules console in the room itself refuses in the room's language.
 *
 * The mirror of admin-17: there the rules window in the panel showed
 * "Правило не сохранилось — The server did not respond", here — the same half
 * of the phrase in a language that the room has nowhere else. The refusal
 * arrives over the network and only on a refusal, so markup does not catch
 * this at all: the only way is to call the reason as a function and check it
 * by its words (as in tests/admin-rules-language.test.mts).
 *
 * The inputs here are real `ApiError`s, not made-up objects: the room throws
 * exactly them (lib/api.ts), and what must be checked is the form that
 * reaches the console, together with its English `message`, which must not
 * get out.
 *
 * The call site is guarded by the neighbouring
 * `tests/screens-rule-refusal.test.mts`: the rules console in the room calls
 * this function instead of showing `err.message` (SessionScreen.svelte ·
 * `setRule`). Here are the words themselves: the split is the same as in the
 * panel, where the window's language and the reason's language are kept in
 * two files.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../web/src/lib/api.js'
import { ruleRefusal } from '../web/src/lib/rule-refusal.js'
import { SESSION_MISSING } from '../shared/protocol.js'

/** Latin letters in a visible line are the trace of an English tail that leaked into the room. */
const PANEL_LANGUAGE = /[A-Za-z]/
const ROOM_LANGUAGE = /[А-Яа-яЁё]/

/**
 * Everything this door can refuse with at all — and next to it what others
 * refuse with on its behalf: a proxy, the relay, a failed fetch.
 */
const REFUSALS: ApiError[] = [
  // A rejected fetch: lib/api.ts sets a zero code and its own English phrase.
  new ApiError('Could not reach the server — check the connection and try again.', 0),
  // The room key has expired or is not recognized.
  new ApiError('join the session first', 401),
  // Not the teacher (routes/sessions.ts answers in Russian, but that cannot be
  // relied on: the server's phrase is not an interface contract).
  new ApiError('Правила этого семинара задаёт преподаватель.', 403),
  // A banned participant is turned away by banDoor — with the expiry in the
  // body.
  new ApiError('the teacher closed your access', 403, null, Date.now() + 3600_000),
  // The seminar was deleted, and the server said so in our words.
  new ApiError(SESSION_MISSING, 404),
  // The same code from a proxy in front of the server — no body, foreign
  // words.
  new ApiError('Not found (404)', 404),
  // A body of the wrong shape: a mistake of the screen, not of the person.
  new ApiError('rules must be an object', 400),
  new ApiError('The server failed (500)', 500),
  new ApiError('Too many requests (429)', 429, 30),
]

test('the refusal reason on the rules console is in Russian for any refusal', () => {
  const lines = [
    ...REFUSALS.map((refusal) => ruleRefusal(refusal)),
    // And what is not an ApiError at all: `catch` catches anything.
    ...[null, undefined, 'boom', 7, new Error('Failed to fetch')].map((cause) =>
      ruleRefusal(cause),
    ),
  ]
  for (const line of lines) {
    assert.match(line, ROOM_LANGUAGE, `"${line}" is not in the room language`)
    assert.doesNotMatch(line, PANEL_LANGUAGE, `"${line}" has an English tail in a Russian room`)
    // The phrase is whole: a half one ("Правило не сохранилось — ") has
    // nothing to read.
    assert.match(line, /^Не удалось сохранить правило[:.] .+[.]$/u, `"${line}" is a fragment of a phrase`)
  }
})

test('the server phrase is not retold — neither ours nor a foreign one', () => {
  for (const refusal of REFUSALS) {
    const line = ruleRefusal(refusal)
    assert.notEqual(line, refusal.message, `${refusal.status}: the message from ApiError got out`)
    // And not as a piece either: "Could not reach the server" inside a Russian
    // phrase is the same bilingualism, only less noticeable.
    const head = refusal.message.split(' ').slice(0, 3).join(' ')
    if (PANEL_LANGUAGE.test(head)) assert.ok(!line.includes(head), `${refusal.status}: ${line}`)
  }
})

test('a dropped connection, a rejected entry, a ban and "not the teacher" are each named in their own words', () => {
  const offline = ruleRefusal(new ApiError('Could not reach the server', 0))
  const stranger = ruleRefusal(new ApiError('join the session first', 401))
  const banned = ruleRefusal(new ApiError('closed', 403, null, Date.now() + 1000))
  const notHost = ruleRefusal(new ApiError('nope', 403))
  const unknown = ruleRefusal(null)

  assert.match(offline, /связи/)
  assert.match(stranger, /войдите/)
  assert.match(banned, /удалили/)
  assert.match(notHost, /преподаватель/)
  assert.match(unknown, /Попробуйте ещё раз/)
  assert.equal(new Set([offline, stranger, banned, notHost, unknown]).size, 5)
})

/*
 * "The seminar is gone" is a fact, and it is said only on our words.
 *
 * A bare 404 is returned by the relay with no frpc connected and by static
 * hosting that answers index.html to everything; on this phrase a teacher in
 * the middle of class would go and create a second seminar instead of waiting
 * for the connection.
 */
test('a 404 in foreign words does not bury the seminar', () => {
  const ours = ruleRefusal(new ApiError(SESSION_MISSING, 404))
  const proxied = ruleRefusal(new ApiError('Not found (404)', 404))

  assert.match(ours, /занятие не найдено/)
  assert.doesNotMatch(proxied, /занятие не найдено/)
  assert.match(proxied, /Попробуйте ещё раз/)
})

/**
 * A ban is read by its expiry, not by its code: a 403 without an expiry is
 * "not the teacher".
 *
 * The same sign, in the same way, is read by the entry (JoinScreen.svelte) and
 * lib/identity.ts · `verdictOnFailure`; if they diverged, a banned participant
 * would be told they are not the teacher, and the teacher that they were
 * removed from the class.
 */
test('the ban expiry tells someone removed from someone who simply is not teaching', () => {
  const withUntil = ruleRefusal(new ApiError('x', 403, null, Date.now() + 60_000))
  const noUntil = ruleRefusal(new ApiError('x', 403))
  const brokenUntil = ruleRefusal(new ApiError('x', 403, null, Number.NaN))

  assert.match(withUntil, /удалили/)
  assert.doesNotMatch(noUntil, /удалили/)
  // A non-number in the field means "no expiry was given", not a ban: better
  // to talk about rights than to announce to a person a nonexistent removal
  // from the class.
  assert.equal(brokenUntil, noUntil)
})
