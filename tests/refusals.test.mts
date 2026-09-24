/**
 * What a person is told when a file is not accepted.
 *
 * The upload once answered "unusable file name" — three words that name
 * neither the file nor what is wrong with it, in the middle of a class with a
 * seminar waiting. The check has moved since: one for the browser and the
 * server, in `shared/paths.ts` — but the promise stayed the same.
 * `safeSegment` answers "yes" or "no", and that is enough for the server; this
 * checks the phrase, which has to be enough for a person.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SEGMENT, safeSegment, whySegmentRefused } from '../shared/paths.js'

/** Every refusal must leave the person something they can do. */
function actionable(message: string): void {
  assert.ok(message.length > 20, `too short: ${message}`)
  assert.match(message, /[.!]$/, `not a sentence: ${message}`)
}

test('a hidden file is told what makes it hidden', () => {
  const said = whySegmentRefused('.gitignore')
  actionable(said)
  assert.match(said, /\.gitignore/, 'the file is not named')
  assert.match(said, /точки/i)
  assert.match(said, /не поддерживаются в панели/i, 'it does not say what will come of it')
})

test('a name that is too long names both its length and the limit', () => {
  const said = whySegmentRefused('n'.repeat(214) + '.txt')
  actionable(said)
  assert.match(said, /218/, 'the actual length is not named')
  assert.match(said, new RegExp(String(MAX_SEGMENT)), 'the limit is not named')
})

test('a path with a folder points to the button that creates folders', () => {
  const said = whySegmentRefused('reports\\january\\data.csv')
  actionable(said)
  assert.match(said, /косая черта/i)
  assert.match(said, /кнопк/i, 'no way forward is shown')
})

test('a control character is named as the problem', () => {
  const said = whySegmentRefused('bell\u0007.txt')
  actionable(said)
  assert.match(said, /символы/i)
})

test('a space at the edge shows in the refusal, since it does not show in the name', () => {
  const said = whySegmentRefused('model.py ')
  actionable(said)
  assert.match(said, /model\.py/, 'the file is not named')
  assert.match(said, /пробел/i)
})

test('no name at all still gets a sentence', () => {
  for (const name of ['', '.', '..']) {
    actionable(whySegmentRefused(name))
  }
})

test('the phrase does not run away after a hostile name', () => {
  const said = whySegmentRefused('.' + 'x'.repeat(5000))
  assert.ok(said.length < 200, `a 5000-character name gave a message of ${said.length}`)
})

test('every name safeSegment rejects has something to say about it', () => {
  const refused = ['', '.', '..', '.env', 'a\u0007b.csv', 'x'.repeat(220), 'model.py ', 'src/m.py']
  for (const name of refused) {
    assert.equal(safeSegment(name), false, `${JSON.stringify(name)} got through after all`)
    actionable(whySegmentRefused(name))
  }
})

test('a good name is not explained after the fact', () => {
  // whySegmentRefused is called only after safeSegment refuses; on a good name
  // it still has to return a sentence, not an empty string or a crash.
  for (const name of ['data.csv', 'семинар 7 — заметки.md', 'archive.tar.gz']) {
    assert.ok(safeSegment(name), `${name} should be allowed`)
    actionable(whySegmentRefused(name))
  }
})
