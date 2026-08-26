/**
 * What a person is told when a file will not go in.
 *
 * The upload route used to answer "unusable file name" — three words that name
 * neither the file nor what was wrong with it, delivered to a student in the
 * middle of a class with the seminar waiting. `safeName` answers yes or no,
 * which is all the server needs; this is the sentence the person needs.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeName, whyRefused } from '../server/src/workspace.js'

/** Every refusal has to be a sentence somebody can act on. */
function actionable(message: string): void {
  assert.ok(message.length > 20, `too terse: ${message}`)
  assert.match(message, /[.!]$/, `not a sentence: ${message}`)
}

test('a dotfile is told why, and what to do', () => {
  const said = whyRefused('.gitignore')
  actionable(said)
  assert.match(said, /\.gitignore/, 'the file is not named')
  assert.match(said, /dot/i)
  assert.match(said, /rename/i, 'no way forward is offered')
})

test('a name too long says how long it was and how long is allowed', () => {
  const said = whyRefused('n'.repeat(214) + '.txt')
  actionable(said)
  assert.match(said, /218 characters/, 'the actual length is not given')
  assert.match(said, /200/, 'the limit is not given')
})

test('a folder path says to send the file instead', () => {
  const said = whyRefused('reports\\january\\data.csv')
  actionable(said)
  assert.match(said, /folder/i)
})

test('a control character in a name is named as the problem', () => {
  const said = whyRefused('bell\u0007.txt')
  actionable(said)
  assert.match(said, /characters/i)
})

test('an upload with no name at all still gets a sentence', () => {
  for (const name of ['', '.', '..']) {
    const said = whyRefused(name)
    actionable(said)
    assert.match(said, /name/i)
  }
})

test('the sentence never runs away with a hostile name', () => {
  const said = whyRefused('.' + 'x'.repeat(5000))
  assert.ok(said.length < 200, `a 5000-character name produced a ${said.length}-character message`)
})

test('every name safeName refuses has a reason to give', () => {
  const refused = ['', '.', '..', '.env', 'a\u0007b.csv', 'x'.repeat(220)]
  for (const name of refused) {
    assert.equal(safeName(name), null, `${JSON.stringify(name)} was allowed after all`)
    actionable(whyRefused(name))
  }
})

test('a name that is fine is never explained away', () => {
  // whyRefused is only ever called after safeName says no; called on a good
  // name it must still be a sentence rather than a crash or an empty string.
  for (const name of ['data.csv', 'семинар 7 — заметки.md', 'archive.tar.gz']) {
    assert.ok(safeName(name), `${name} should be allowed`)
    actionable(whyRefused(name))
  }
})
