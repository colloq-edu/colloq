/**
 * What a room reads when a cell fails.
 *
 * Jupyter's payload carries the error name and value twice over: once as the
 * banner that opens the traceback, once as the line that closes it, and we draw
 * a styled headline from the same two fields. Left alone the room reads the
 * same sentence three times at the moment it most wants one — but trimming too
 * eagerly throws away the line that actually says where it broke.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withoutEcho } from '../web/src/lib/traceback.js'

const ESC = '\u001b'

/** Copied off the wire, dashes and all — not written from memory. */
const REAL = [
  `${ESC}[31m---------------------------------------------------------------------------${ESC}[39m`,
  `${ESC}[0;31mRuntimeError${ESC}[0m                              Traceback (most recent call last)`,
  `Cell ${ESC}[0;32mIn[3], line 1${ESC}[0m`,
  `${ESC}[0;32m----> 1${ESC}[0m model${ESC}[38;5;241m.${ESC}[39mcuda()`,
  '',
  `${ESC}[0;31mRuntimeError${ESC}[0m: CUDA out of memory`,
]

test('the banner and the closing echo both go, the frames stay', () => {
  const out = withoutEcho(REAL, 'RuntimeError', 'CUDA out of memory')
  assert.ok(!/Traceback \(most recent call last\)/.test(out), 'the banner survived')
  assert.equal(out.split('\n').filter((l) => /RuntimeError/.test(l)).length, 0, 'the echo survived')
  // The two lines that say WHERE are the whole point of keeping any of it.
  assert.match(out, /In\[3\], line 1/)
  assert.match(out, /model/)
})

test('a traceback that is only the echo comes back empty rather than repeated', () => {
  const out = withoutEcho(
    [`${ESC}[0;31mValueError${ESC}[0m: bad input`],
    'ValueError',
    'bad input',
  )
  assert.equal(out, '')
})

test('a line that merely resembles the echo is kept', () => {
  const out = withoutEcho(
    ['  File "train.py", line 9', 'ValueError: bad input, but from somewhere else'],
    'ValueError',
    'bad input',
  )
  // Not an exact match, so it stays — it is a different sentence.
  assert.match(out, /somewhere else/)
  assert.match(out, /train\.py/)
})

test('a traceback with no banner and no echo is untouched', () => {
  const lines = ['  File "a.py", line 1', '    x = 1/0', 'ZeroDivisionError happened somewhere']
  assert.equal(withoutEcho(lines, 'KeyError', 'k'), lines.join('\n'))
})

test('an error with no value matches on the name alone', () => {
  const out = withoutEcho(
    ['KeyboardInterrupt                         Traceback (most recent call last)', 'Cell In[1]', 'KeyboardInterrupt'],
    'KeyboardInterrupt',
    '',
  )
  assert.equal(out, 'Cell In[1]')
})

test('blank lines around the echo do not keep it alive', () => {
  const out = withoutEcho(['Cell In[2]', '', '', 'KeyError: x', '', ''], 'KeyError', 'x')
  assert.equal(out, 'Cell In[2]')
})

test('an empty traceback is empty, not a crash', () => {
  assert.equal(withoutEcho([], 'RuntimeError', 'boom'), '')
  assert.equal(withoutEcho([''], 'RuntimeError', 'boom'), '')
})

test('a banner for a different error is not mistaken for this one', () => {
  // Chained exceptions: the outer traceback opens with the inner error's banner.
  const lines = ['ValueError                                Traceback (most recent call last)', 'Cell In[1]']
  assert.equal(withoutEcho(lines, 'RuntimeError', 'outer'), lines.join('\n'))
})

test('the rule of dashes above the banner goes with it', () => {
  const out = withoutEcho(REAL, 'RuntimeError', 'CUDA out of memory')
  assert.ok(!/^-{3,}/m.test(out), `a bare rule survived:\n${out}`)
})

test('a rule with no banner under it is left alone', () => {
  // Somebody printing a divider of their own, then failing.
  const lines = ['------------------------', '  File "train.py", line 9', 'ValueError: bad']
  const out = withoutEcho(lines, 'KeyError', 'k')
  assert.match(out, /^-{3,}/)
})

test('an interrupt closes with a colon and no value, and that goes too', () => {
  // What a room actually sees when the teacher presses Interrupt.
  const out = withoutEcho(
    [
      `${ESC}[31m---------------------------------------------------------------------------${ESC}[39m`,
      `${ESC}[31mKeyboardInterrupt${ESC}[39m                         Traceback (most recent call last)`,
      `${ESC}[36mCell${ESC}[39m ${ESC}[32mIn[1], line 3${ESC}[39m`,
      `${ESC}[32m----> 3${ESC}[39m     time.sleep(1)`,
      '',
      'KeyboardInterrupt: ',
    ],
    'KeyboardInterrupt',
    '',
  )
  assert.equal(out.split('\n').filter((l) => /KeyboardInterrupt/.test(l)).length, 0, `read twice:\n${out}`)
  assert.match(out, /In\[1\], line 3/)
})
