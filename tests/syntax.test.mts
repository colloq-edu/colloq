/**
 * Laying highlighted code out in lines.
 *
 * The parse itself belongs to CodeMirror and is not this project's to test. The
 * two things that are: turning a flat list of styled ranges into rows, which
 * has to survive a token that crosses a newline and a gap between two tokens;
 * and dealing those rows out along a diff, where a wrong step by one puts the
 * colours of one line onto another.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { diffTokens, lineAt, plain, spread, type Syntax } from '../web/src/lib/syntax.js'
import { diffLines } from '../shared/diff.js'

const flat = (lines: ReturnType<typeof spread>) => lines.map((line) => line.map((t) => t.text).join(''))

test('the text survives being cut into lines', () => {
  const code = 'x = 1\ny = 2'
  assert.deepEqual(flat(spread(code, [{ from: 0, to: 1, cls: 'v' }])), ['x = 1', 'y = 2'])
})

test('the gaps between styled ranges are emitted as plain code', () => {
  // Everything the highlighter says nothing about is still code, and a layout
  // that only kept what was styled came out with holes in it.
  const lines = spread('a + b', [
    { from: 0, to: 1, cls: 'v' },
    { from: 4, to: 5, cls: 'v' },
  ])
  assert.deepEqual(lines[0], [
    { text: 'a', cls: 'v' },
    { text: ' + ', cls: '' },
    { text: 'b', cls: 'v' },
  ])
})

test('a token that crosses a newline is split across its rows', () => {
  // A docstring is one range and three lines. Each part belongs to its own row,
  // and all three keep the class.
  const code = 's = """one\ntwo\nthree"""'
  const lines = spread(code, [{ from: 4, to: code.length, cls: 'str' }])
  assert.deepEqual(flat(lines), ['s = """one', 'two', 'three"""'])
  assert.deepEqual(
    lines.map((line) => line[line.length - 1].cls),
    ['str', 'str', 'str'],
  )
})

test('an empty line is an empty row, not a missing one', () => {
  // A blank line between two functions is part of how the code reads; a layout
  // that dropped it renumbered every line after it.
  assert.deepEqual(flat(spread('a\n\nb', [])), ['a', '', 'b'])
})

test('trailing text past the last styled range is kept', () => {
  assert.deepEqual(flat(spread('x = 1  # note', [{ from: 0, to: 1, cls: 'v' }])), ['x = 1  # note'])
})

test('an offset finds its line', () => {
  const starts = [0, 6, 12]
  assert.equal(lineAt(starts, 0), 0)
  assert.equal(lineAt(starts, 5), 0)
  assert.equal(lineAt(starts, 6), 1)
  assert.equal(lineAt(starts, 99), 2)
})

/** A highlighter that tags every line with where it came from. */
const fake = (side: string): Syntax => ({
  lines: (code) => code.split('\n').map((text) => [{ text, cls: side }]),
})

test('a diff takes removed lines from the old text and added ones from the new', () => {
  const before = 'a\nb'
  const after = 'a\nc'
  const lines = diffLines(before, after)
  const both: Syntax = {
    lines: (code) => (code === before ? fake('old').lines(code) : fake('new').lines(code)),
  }
  const tokens = diffTokens(lines, before, after, both)

  assert.equal(lines.length, tokens.length)
  for (let i = 0; i < lines.length; i++) {
    const from = tokens[i][0]?.cls
    if (lines[i].kind === 'removed') assert.equal(from, 'old', `row ${i} should come from the old text`)
    if (lines[i].kind === 'added') assert.equal(from, 'new', `row ${i} should come from the new text`)
    // Whichever side a row came from, it must be the row it claims to be.
    assert.equal(tokens[i].map((t) => t.text).join(''), lines[i].text)
  }
})

test('a same line consumes a line of both sides, so nothing slips by one', () => {
  /*
   * The step that is easy to get wrong: an unchanged row advances both cursors.
   * Advancing only one puts the colours of the line above onto every row after
   * the first change.
   */
  const before = 'x = 1\ny = 2\nz = 3'
  const after = 'x = 1\ny = 9\nz = 3'
  const lines = diffLines(before, after)
  const tokens = diffTokens(lines, before, after, fake('any'))
  assert.deepEqual(
    tokens.map((line) => line.map((t) => t.text).join('')),
    lines.map((line) => line.text),
  )
})

test('with no highlighter loaded a diff is still the right text', () => {
  const lines = diffLines('a', 'b')
  assert.deepEqual(
    diffTokens(lines, 'a', 'b', null).map((line) => line.map((t) => t.text).join('')),
    lines.map((line) => line.text),
  )
})

test('an empty line has no tokens rather than one empty one', () => {
  assert.deepEqual(plain(''), [])
})
