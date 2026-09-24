/**
 * The rules control in the room names the reason in Russian — and names only
 * ONE.
 *
 * The refusal wording is checked by the neighbouring
 * `weblib-rule-refusal.test.mts` (which also explains why the reason is named
 * in its own words rather than as a retelling of `ApiError`). This file checks
 * what that one could not until the change landed: the call site.
 * `session.showError(err.message)` comes back in a single line, and it can be
 * seen only at a live class and only on a refusal — the markup is silent, the
 * types are silent, the screen looks whole.
 *
 * The second check is about a second copy. The rule is small, and keeping one
 * next to the screen is tempting right up to the first edit: there will be two
 * sets of messages, and they will drift apart silently (cross-cutting cause 6
 * of the audit). The screen has to take `ruleRefusal` from `lib/`, where
 * `api.ts`, which produces these refusals, also lives.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '..')
const SESSION = 'web/src/screens/SessionScreen.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('a refusal from the rules control reaches the room through ruleRefusal', () => {
  const session = code(read(SESSION))
  const from = session.indexOf('async function setRule(')
  assert.ok(from > 0, 'the rules control is in place')
  const body = session.slice(from, session.indexOf('\n  }\n', from))

  assert.match(body, /showError\(/, 'the refusal is still shown to the person, not swallowed')
  assert.match(body, /showError\(ruleRefusal\(/, 'the reason is named by lib/rule-refusal.ts')
  assert.doesNotMatch(body, /err\.message/, 'the English ApiError phrase in a Russian room')
  assert.match(session, /import \{ ruleRefusal \} from '@\/lib\/rule-refusal'/)
})

test('there is no second copy of the rule next to the screens', () => {
  const dir = path.join(ROOT, 'web/src/screens')
  for (const name of fs.readdirSync(dir)) {
    const source = code(read(`web/src/screens/${name}`))
    assert.doesNotMatch(
      source,
      /(export )?function ruleRefusal\b/,
      `${name}: its own set of refusal words next to the shared one`,
    )
  }
})
