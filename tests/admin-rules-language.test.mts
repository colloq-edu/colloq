/**
 * The seminar rules window and the room follow one chosen language.
 *
 * The rule captions live in the ROOM's language: the same list is drawn by
 * the console inside it (web/src/lib/rule-rows.ts,
 * tests/weblib-rule-rows.test.mts), and the frame around them cannot be in
 * another one. But the refusal reason in the footer was brought by the
 * panel's shared `explain()`, which is English, and at a live class this
 * gave "Правило не сохранилось — The server did not respond" (the Russian
 * half says "the rule was not saved"): half of the phrase in a language
 * found nowhere else in the window (admin-17).
 *
 * This breaks silently and in one line: `ruleRefusal(...)` gets changed back
 * to `explain(cause)`, and no markup test will notice, because the text
 * arrives over the network and only in a refusal. The neighbouring
 * `admin-address.test.mts` guards the language of the window markup itself
 * ("Russian, and it says why"); this one guards the language of what appears
 * in the window from the server. Hence two checks: the words are Russian for
 * any reason, and the window itself calls exactly them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
afterEach(() => setLocaleResolver(() => 'ru'))
import assert from 'node:assert/strict'
import type { AdminErrorReason } from '../shared/admin.js'
import { ruleRefusal } from '../web/src/admin/panel.js'

/** Latin letters in a visible line are a trace of the English panel leaking into the window. */
const PANEL_LANGUAGE = /[A-Za-z]/
const ROOM_LANGUAGE = /[А-Яа-яЁё]/

/**
 * All the reasons the server can name at all: as a list, not a sample.
 *
 * A new reason in `AdminErrorReason` without a line here simply falls into
 * the default, which is the intended behaviour, but it must be checked that
 * it stays Russian then instead of bringing an English tail.
 */
const REASONS: AdminErrorReason[] = [
  'unauthenticated',
  'forbidden',
  'unclaimed',
  'invalid',
  'not_found',
  'too_long',
  'in_use',
  'protected',
  'exists',
  'no_docker',
  'building',
  'failed',
  'network',
]

test('the refusal reason in the rules window is in the chosen language for any refusal', () => {
 for (const locale of ['ru', 'en'] as const) {
  setLocaleResolver(() => locale)
  const lines = [
    ruleRefusal(null),
    ...REASONS.map((reason) =>
      ruleRefusal({ reason, status: 400, body: { error: 'nope', reason } }),
    ),
    // And the same set without a parsed body: that is how a refusal comes through a proxy.
    ...REASONS.map((reason) => ruleRefusal({ reason, status: 502 })),
  ]
  for (const line of lines) {
    assert.match(line, locale === 'ru' ? ROOM_LANGUAGE : PANEL_LANGUAGE, `"${line}" is not in the language of the window`)
    assert.doesNotMatch(line, locale === 'ru' ? PANEL_LANGUAGE : ROOM_LANGUAGE, `"${line}" mixes languages`)
    // The phrase is whole: half a phrase ("the rule was not saved — ") says nothing.
    assert.match(line, locale === 'ru' ? /^Не удалось сохранить правило[:.] .+[.]$/u : /^Could not save the rule[:.] .+[.]$/u, `"${line}" is a fragment of a phrase`)
  }
 }
})

test('network, a rejected sign-in and permissions are each named on their own, not with one word', () => {
  const network = ruleRefusal({ reason: 'network', status: 0, body: null })
  const dead = ruleRefusal({ reason: 'unauthenticated', status: 401, body: { error: 'x' } })
  const forbidden = ruleRefusal({ reason: 'forbidden', status: 403, body: { error: 'x' } })
  const unknown = ruleRefusal(null)

  assert.match(network, /сервер не ответил/)
  assert.match(dead, /вход/)
  assert.match(forbidden, /прав/)
  assert.equal(new Set([network, dead, forbidden, unknown]).size, 4)
})

/*
 * "The seminar no longer exists" is a fact, and it is said only from the
 * route's answer.
 *
 * A 404 with the same number is also returned by a proxy in front of the
 * server and by a tunnel that forgot about /api; after this phrase a teacher
 * would go and create a second seminar instead of fixing the address.
 */
test('a 404 without a body does not bury the seminar', () => {
  const ours = ruleRefusal({
    reason: 'invalid',
    status: 404,
    body: { error: 'that seminar no longer exists', reason: 'invalid' },
  })
  const stranger = ruleRefusal({ reason: 'invalid', status: 404, body: null })

  assert.match(ours, /занятие не найдено/)
  assert.doesNotMatch(stranger, /занятие не найдено/)
  assert.match(stranger, /Попробуйте ещё раз/)
})

/* ------------------------------------------------------------- window */

const SEMINARS = 'web/src/admin/screens/Seminars.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('the rules window takes the reason from its own code, not from the English explain()', () => {
  const seminars = code(read(SEMINARS))
  const assignments = seminars.match(/rulesErrorText = [^\n]+/g) ?? []

  assert.ok(assignments.length > 0, 'the rules window footer no longer shows anything')
  for (const line of assignments) {
    assert.doesNotMatch(line, /explain\(/, `${line.trim()}: an English reason in the Russian window`)
  }
  assert.match(seminars, /rulesErrorText = \(\) => \(ruleRefusal\(/, 'the reason is taken from panel.ts')
  // A rejected cookie still leads to the sign-in screen: translating the
  // reason was not supposed to cancel the screen change (admin-1).
  assert.match(seminars, /noteDeadCookie\(cause\)[\s\S]{0,200}rulesErrorText = \(\) => \(ruleRefusal\(/)
})
